import { expect, test } from '@playwright/test'
import type { Page, TestInfo } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { Catalog } from '../../shared/types'
import type { PostingStatusIndex } from '../../shared/posting-status'
import type { CachedBoard } from '../../server/board-cache'
import {
  BOUNDS_CHANGE_TIME, BOUNDS_EXPLORATION, BOUNDS_IDS, BOUNDS_NEW_TITLE, BOUNDS_NOTE, BOUNDS_PROFILE, BOUNDS_RECOVERY_TIME,
  BOUNDS_RETAINED_TITLE, BOUNDS_TIME, BOUNDS_TRACKED_TITLE, BOUNDS_URLS, JSON_CAP_BYTES, JSON_OVER_CAP_BYTES, JSON_SIZE_MESSAGE,
  UNKNOWN_SAVED_MESSAGE, boundsResponses,
} from '../fixtures/response-bounds'
import type { BoundsPhase } from '../fixtures/response-bounds'
import { DEFAULT_CHUNK_BYTES } from '../fixtures/response-bounds-stream'
import { createResponseBoundsServer } from '../fixtures/response-bounds-server'
import { expectInitialCatalogRequest, readServerMode, watchApiRequests } from './helpers/api-requests'
import { readSaved, waitForSavedCommit } from './helpers/saved-store'

// The real app process reads a schema-valid Greenhouse feed well over the JSON
// cap through its shared HTTP reader and must stop near the cap. Everything the
// user can see or has saved must survive that failure, and a normal feed must
// recover it. The exact cap-plus-one boundary is pinned in the unit reader tests.
type Server = Awaited<ReturnType<typeof createResponseBoundsServer>>
const subject = {
  companyId: 'bounds-cedar', companyName: 'Cedar Bounds', board: 'CedarBounds72',
  trackedId: BOUNDS_IDS.greenhouse.technical[0], trackedUrl: BOUNDS_IDS.greenhouse.trackedUrl,
  technicalIds: BOUNDS_IDS.greenhouse.technical, publishedIds: BOUNDS_IDS.greenhouse.published, newId: BOUNDS_IDS.greenhouse.newId,
}
const dataButton = (page: Page) => page.getByRole('button', { name: '데이터와 추천 방식', exact: true })
const navigation = (page: Page) => page.getByRole('navigation', { name: '주요 메뉴' })
const query = (page: Page) => page.getByRole('textbox', { name: '도시, 회사 또는 포지션 검색', exact: true })
const row = (page: Page, company: string) => page.getByRole('dialog').locator('.board-row').filter({
  has: page.getByText(company, { exact: true }),
})
const firstTime = (page: Page, company: string) => row(page, company).locator('.board-copy > p').first().locator('time')
const metric = (page: Page, label: string) => page.getByRole('row').filter({
  has: page.getByRole('rowheader').filter({ hasText: new RegExp(`^${label}`) }),
}).getByRole('cell')

async function setup(page: Page, server: Server) {
  const traffic = watchApiRequests(page)
  const failures = { pageErrors: [] as string[], failedResources: [] as string[], unexpectedRequests: [] as string[] }
  page.on('pageerror', error => failures.pageErrors.push(error.message))
  page.on('response', response => {
    if (!new URL(response.url()).pathname.startsWith('/api/') && response.status() >= 400)
      failures.failedResources.push(`${response.status()} ${response.url()}`)
  })
  page.on('requestfailed', request => {
    if (!new URL(request.url()).pathname.startsWith('/api/') && request.failure()?.errorText !== 'net::ERR_ABORTED')
      failures.failedResources.push(`${request.failure()?.errorText} ${request.url()}`)
  })
  await page.route('**/*', route => {
    const url = new URL(route.request().url())
    if (url.origin !== server.origin) {
      failures.unexpectedRequests.push(url.href)
      return route.abort('blockedbyclient')
    }
    if (url.pathname === '/__bounds72-seed') return route.fulfill({
      contentType: 'text/html', body: '<!doctype html><title>Once-only fictional setup</title>',
    })
    return route.fallback()
  })
  await page.clock.setFixedTime(new Date(BOUNDS_TIME))
  await page.goto(`${server.origin}/__bounds72-seed`)
  await page.evaluate(seed => {
    localStorage.setItem('orbit.v1.profile', JSON.stringify(seed.profile))
    localStorage.setItem('orbit.v1.exploration', JSON.stringify(seed.exploration))
    localStorage.setItem('orbit.v1.compare', JSON.stringify(['london', 'berlin']))
  }, { profile: BOUNDS_PROFILE, exploration: BOUNDS_EXPLORATION })
  // Real reloads below read app-owned storage; no reload init script reseeds it.
  await page.goto(server.origin)
  return { traffic, failures, expectedAborts: 0 }
}
async function contextState(page: Page) {
  return page.evaluate(() => ({
    profile: JSON.parse(localStorage.getItem('orbit.v1.profile') ?? 'null'),
    exploration: JSON.parse(localStorage.getItem('orbit.v1.exploration') ?? '{}'),
    compare: JSON.parse(localStorage.getItem('orbit.v1.compare') ?? '[]'),
  }))
}
async function initial(page: Page, state: Awaited<ReturnType<typeof setup>>) {
  state.expectedAborts += (await expectInitialCatalogRequest(page, state.traffic)).cancelled
}
async function actual<T>(page: Page, server: Server, url: string, status = 200): Promise<T> {
  const response = await page.request.get(`${server.origin}${url}`)
  try {
    expect(response.status()).toBe(status)
    return await response.json() as T
  } finally { await response.dispose() }
}
async function cache(server: Server) {
  const files = await server.cacheFiles()
  expect(files).toHaveLength(1)
  return JSON.parse(await readFile(path.join(server.cwd, '.local', files[0]), 'utf8')) as { version: 5; boards: CachedBoard[] }
}
async function closeData(page: Page) {
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(dataButton(page)).toBeFocused()
}
async function change(page: Page, server: Server, phase: BoundsPhase, time: string) {
  await server.respond(boundsResponses('greenhouse', phase))
  await server.clock(time)
  await page.clock.setFixedTime(new Date(time))
}
async function refresh(page: Page, coverage: string[], unavailable = false) {
  await dataButton(page).click()
  const button = page.getByRole('dialog').getByRole('button', {
    name: unavailable ? '공개 공고 다시 조회' : '새로고침', exact: true,
  })
  await expect(button).toBeEnabled()
  await button.click()
  await expect(page.getByRole('dialog').locator('.coverage-stats strong')).toHaveText(coverage)
  await expect(page.locator('.data-loading')).toHaveCount(0)
}
async function saveTracked(page: Page) {
  await expect(page.locator('.city-detail-count strong')).toHaveText(['1', '2'])
  await page.getByRole('button', { name: '전체 2개 공고 보기', exact: true }).click()
  await page.getByRole('button', { name: BOUNDS_TRACKED_TITLE, exact: true }).click()
  await page.getByRole('button', { name: '기회 저장', exact: true }).click()
  await page.getByLabel('이 기회에 대한 나의 메모', { exact: true }).fill(BOUNDS_NOTE)
  await page.getByRole('button', { name: '지원 완료로 표시', exact: true }).click()
  await waitForSavedCommit(page)
  await page.keyboard.press('Escape')
  const records = await readSaved(page)
  expect(records).toHaveLength(1)
  expect(records[0]).toMatchObject({
    note: BOUNDS_NOTE, status: 'applied',
    company: { id: subject.companyId, name: subject.companyName, provider: 'greenhouse', board: subject.board },
    job: { id: subject.trackedId, title: BOUNDS_TRACKED_TITLE, fetchedAt: BOUNDS_TIME, url: subject.trackedUrl, source: 'greenhouse' },
  })
  return records
}
async function savedView(page: Page) {
  await navigation(page).getByRole('button', { name: /^저장한 기회/ }).click()
  await expect(page.locator('.saved-card')).toHaveCount(1)
  await expect(page.locator('.saved-card .saved-status')).toHaveText('지원 완료')
  await expect(page.locator('.saved-card')).toContainText(BOUNDS_NOTE)
}
async function checkSaved(page: Page, again = false) {
  const button = page.getByRole('button', { name: again ? '새로 확인' : '게시 상태 확인', exact: true })
  await expect(button).toBeEnabled()
  await button.click()
  await expect(page.getByRole('button', { name: '게시 상태 확인 중', exact: true })).toHaveCount(0)
}
async function audit(page: Page, info: TestInfo, screenshot?: string) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  for (const dialog of await page.getByRole('dialog').all())
    expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
  expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze()).violations).toEqual([])
  if (screenshot) await page.screenshot({ path: info.outputPath(screenshot) })
}
async function openHistory(page: Page) {
  const details = page.getByRole('dialog').locator('.board-details')
  if (await details.getAttribute('open') === null) await details.locator(':scope > summary').click()
  await expect(details).toHaveAttribute('open')
}
async function evidence(page: Page, info: TestInfo, server: Server, state: Awaited<ReturnType<typeof setup>>, expectedTarget: string[], expectedControl: string[], extra: unknown) {
  const upstream = await server.requests()
  expect(upstream.filter(request => request.url === BOUNDS_URLS.greenhouse).map(request => request.url)).toEqual(expectedTarget)
  expect(upstream.filter(request => request.url === BOUNDS_URLS.control).map(request => request.url)).toEqual(expectedControl)
  expect(upstream).toHaveLength(expectedTarget.length + expectedControl.length)
  expect(upstream.every(request => request.synthetic && request.networkSent === false && request.method === 'GET')).toBe(true)
  // The real process cancelled the still-open over-cap stream near the cap instead of reading it through.
  const streams = await server.streams()
  expect(streams).toHaveLength(1)
  expect(streams[0]).toMatchObject({ url: BOUNDS_URLS.greenhouse, declaredBytes: JSON_OVER_CAP_BYTES, cancelled: true })
  expect(streams[0].pulledBytes).toBeGreaterThan(JSON_CAP_BYTES)
  expect(streams[0].pulledBytes).toBeLessThanOrEqual(JSON_CAP_BYTES + 2 * DEFAULT_CHUNK_BYTES)
  expect(state.failures).toEqual({ pageErrors: [], failedResources: [], unexpectedRequests: [] })
  expect(state.traffic.requests.length).toBeGreaterThan(0)
  expect(state.traffic.requests.filter(request => request.state === 'pending')).toEqual([])
  const failed = state.traffic.requests.filter(request => request.state === 'failed')
  expect(failed).toHaveLength(state.expectedAborts)
  expect(failed.every(request => request.error === 'net::ERR_ABORTED')).toBe(true)
  for (const request of state.traffic.requests) {
    const url = new URL(request.url)
    expect(url.origin).toBe(server.origin)
    expect(request.method).toBe('GET')
    expect(request.body).toBeNull()
    if (url.pathname === '/api/catalog/progress') {
      expect([...url.searchParams.keys()]).toEqual(['id', 'after'])
      expect(url.searchParams.get('id')).toMatch(/^[a-f0-9-]{36}$/)
      expect(url.searchParams.get('after')).toMatch(/^\d+$/)
    } else expect([
      '/api/catalog?source=public', '/api/catalog?source=public&refresh=1', '/api/posting-status?refresh=1',
    ]).toContain(url.pathname + url.search)
  }
  for (const marker of ['PRIVATE_BOUNDS_72', BOUNDS_NOTE, 'private-bounds72', subject.trackedId])
    expect(JSON.stringify(state.traffic.requests)).not.toContain(marker)
  expect(await readFile(server.defaultCache, 'utf8')).toBe(server.defaultBytes)
  await writeFile(info.outputPath('response-bounds-observation.json'), JSON.stringify({
    clock: 'Fixture child Date.now and browser Date are explicit inputs; native timers, provider, shared HTTP reader, cache, API and actual browser remain real.',
    seededOnce: true, noReloadInitScript: true, upstream, streams, browserRequests: state.traffic.requests,
    failures: state.failures, context: await contextState(page), saved: await readSaved(page), extra,
  }, null, 2))
}

for (const width of [1440, 320]) test.describe(`over-cap board feed at ${width}px`, () => {
  test.use({ viewport: { width, height: 960 }, isMobile: width === 320, hasTouch: width === 320 })

  test('a feed well over the JSON cap keeps the previous snapshot, search state and saved application through restart while the control board updates, then a normal feed recovers', async ({ page, request, baseURL }, info) => {
    test.setTimeout(120_000)
    const mode = await readServerMode(request, `${baseURL}/api/health`)
    const server = await createResponseBoundsServer(info.outputPath('bounds-server'), mode, 'greenhouse')
    try {
      await server.start()
      await server.verifyProductionBytes()
      const state = await setup(page, server)
      await initial(page, state)
      const records = await saveTracked(page)
      const beforeContext = await contextState(page)
      expect(beforeContext.profile.linkedinUrl).toBe('https://example.com/private-bounds72')
      expect(beforeContext.exploration).toEqual(BOUNDS_EXPLORATION)
      expect(beforeContext.compare).toEqual(['london', 'berlin'])
      const beforeCache = await cache(server)
      const original = beforeCache.boards.find(board => board.companyId === subject.companyId)!
      expect(original.snapshot).toMatchObject({ fetchedAt: BOUNDS_TIME, total: 3, publishedIds: subject.publishedIds })

      await change(page, server, 'oversize', BOUNDS_CHANGE_TIME)
      await refresh(page, ['35', '2', '4'])
      await expect(row(page, subject.companyName)).toContainText('Greenhouse')
      await expect(row(page, subject.companyName)).toContainText('이전 2개 유지')
      await expect(row(page, subject.companyName)).toContainText(JSON_SIZE_MESSAGE)
      await expect(firstTime(page, subject.companyName)).toHaveAttribute('datetime', BOUNDS_TIME)
      await expect(row(page, 'Birch Bounds')).toContainText('2개 반영')
      await expect(firstTime(page, 'Birch Bounds')).toHaveAttribute('datetime', BOUNDS_CHANGE_TIME)
      await row(page, subject.companyName).scrollIntoViewIfNeeded()
      await audit(page, info, width === 320 ? 'bounds-retained-board-320.png' : undefined)
      await closeData(page)
      await expect(query(page)).toHaveValue('Engineer')
      await expect(page.locator('.city-detail-hero')).toContainText('런던')
      await expect(page.locator('.city-detail-count strong')).toHaveText(['1', '2'])
      const current = await actual<Catalog>(page, server, '/api/catalog?source=public')
      expect(current.jobs.map(job => job.id)).toEqual([...subject.technicalIds, BOUNDS_IDS.control.one, BOUNDS_IDS.control.two])
      expect(current.boards[0]).toMatchObject({
        companyId: subject.companyId, status: 'error', dataStatus: 'stale', message: JSON_SIZE_MESSAGE,
        lastSuccessAt: BOUNDS_TIME, checkedAt: BOUNDS_CHANGE_TIME, total: 3, included: 2,
      })
      const failedCache = await cache(server)
      const retained = failedCache.boards.find(board => board.companyId === subject.companyId)!
      expect(retained.snapshot).toEqual(original.snapshot)
      expect(retained).toMatchObject({ checkedAt: BOUNDS_CHANGE_TIME, failures: 1, error: JSON_SIZE_MESSAGE, errorPhase: 'inventory' })
      expect(Date.parse(retained.retryAt!)).toBeGreaterThanOrEqual(Date.parse('2026-09-30T09:03:00.000Z'))
      expect(Date.parse(retained.retryAt!)).toBeLessThanOrEqual(Date.parse('2026-09-30T09:03:12.000Z'))
      await navigation(page).getByRole('button', { name: /^도시 비교/ }).click()
      await expect(page.locator('.comparison-city h2')).toHaveText(['런던', '베를린'])
      await expect(metric(page, '관련 채용공고')).toHaveText(['2개', '2개', '—'])
      await savedView(page)
      await checkSaved(page)
      await expect(page.locator('.posting-summary strong')).toHaveText(['0', '0', '0', '1'])
      await expect(page.locator('.saved-card .posting-notice.unknown')).toContainText('현재 상태 확인 필요')
      await expect(page.locator('.saved-card .posting-notice.unknown')).toContainText(UNKNOWN_SAVED_MESSAGE)
      await expect(page.locator('.posting-notice.missing')).toHaveCount(0)
      const status = await actual<PostingStatusIndex>(page, server, '/api/posting-status')
      expect(status.version).toBe(2)
      expect(status.boards[0]).toMatchObject({
        status: 'error', lastSuccessAt: BOUNDS_TIME,
        listing: { publishedIds: subject.publishedIds, jobs: [], content: { checkedAt: BOUNDS_TIME, status: 'error', jobIds: subject.technicalIds } },
      })
      expect(await cache(server)).toEqual(failedCache)
      expect(await readSaved(page)).toEqual(records)
      expect(await contextState(page)).toEqual(beforeContext)
      await page.locator('.saved-card .posting-notice').scrollIntoViewIfNeeded()
      await audit(page, info, width === 320 ? 'bounds-unknown-saved-320.png' : undefined)

      const offset = state.traffic.catalog().length
      await page.goto('about:blank')
      await server.stop()
      await server.start()
      await server.verifyProductionBytes()
      await page.goto(`${server.origin}/#saved`)
      await expect(page.locator('.saved-card')).toHaveCount(1)
      expect(await readSaved(page)).toEqual(records)
      expect(await contextState(page)).toEqual(beforeContext)
      expect(await cache(server)).toEqual(failedCache)
      expect(state.traffic.catalog().slice(offset)).toEqual([])
      await checkSaved(page)
      await expect(page.locator('.saved-card .posting-notice.unknown')).toHaveCount(1)
      expect(await server.requests()).toHaveLength(4)

      await change(page, server, 'recovered', BOUNDS_RECOVERY_TIME)
      // Saved-only restart has not loaded a browser catalog. The explicit
      // initial public action still performs the same full recollection.
      await refresh(page, ['35', '2', '5'], true)
      await openHistory(page)
      await expect(firstTime(page, subject.companyName)).toHaveAttribute('datetime', BOUNDS_RECOVERY_TIME)
      await expect(row(page, subject.companyName)).toContainText('3개 반영')
      await expect(row(page, subject.companyName)).toContainText('Greenhouse')
      await closeData(page)
      expect(new URL(page.url()).hash).toBe('#saved')
      await checkSaved(page, true)
      await expect(page.locator('.posting-summary strong')).toHaveText(['1', '0', '0', '0'])
      await expect(page.locator('.saved-card .posting-notice.listed')).toHaveCount(1)
      await expect(page.locator('.posting-notice.missing, .posting-notice.unknown')).toHaveCount(0)
      expect(await readSaved(page)).toEqual(records)
      expect(await contextState(page)).toEqual(beforeContext)
      const recovered = await cache(server)
      expect(recovered.boards[0]).toMatchObject({ companyId: subject.companyId, failures: 0, retryAt: null })
      expect(recovered.boards[0].snapshot).toMatchObject({
        fetchedAt: BOUNDS_RECOVERY_TIME, total: 4, publishedIds: [...subject.publishedIds, subject.newId],
      })
      expect(recovered.boards[0]).not.toHaveProperty('error')
      await navigation(page).getByRole('button', { name: '기회 탐색', exact: true }).click()
      await expect(page.locator('.city-detail-hero')).toContainText('런던')
      await expect(page.locator('.city-detail-count strong')).toHaveText(['1', '3'])
      await page.getByRole('button', { name: '전체 3개 공고 보기', exact: true }).click()
      expect((await page.locator('.mini-job-title').allTextContents()).sort()).toEqual([
        BOUNDS_NEW_TITLE, BOUNDS_RETAINED_TITLE, BOUNDS_TRACKED_TITLE,
      ])
      const recoveredCatalog = await actual<Catalog>(page, server, '/api/catalog?source=public')
      expect(recoveredCatalog.jobs.map(job => job.id)).toEqual([...subject.technicalIds, subject.newId, BOUNDS_IDS.control.one, BOUNDS_IDS.control.two])
      expect(recoveredCatalog.boards[0]).toMatchObject({ status: 'ok', dataStatus: 'fresh', total: 4, included: 3, lastSuccessAt: BOUNDS_RECOVERY_TIME })
      await audit(page, info)
      await evidence(page, info, server, state,
        [BOUNDS_URLS.greenhouse, BOUNDS_URLS.greenhouse, BOUNDS_URLS.greenhouse],
        [BOUNDS_URLS.control, BOUNDS_URLS.control, BOUNDS_URLS.control],
        { beforeCache, failedCache, recovered, current, status, recoveredCatalog })
    } finally { await page.close(); await server.stop() }
  })
})
