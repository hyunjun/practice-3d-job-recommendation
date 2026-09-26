import { expect, test } from '@playwright/test'
import type { Page, TestInfo } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { Catalog } from '../../shared/types'
import type { PostingStatusIndex } from '../../shared/posting-status'
import type { CachedBoard } from '../../server/board-cache'
import {
  BULK_TIME, BULK_CHANGE_TIME, BULK_RECOVERY_TIME, BULK_EMPTY_TIME,
  BULK_PROFILE, BULK_EXPLORATION, BULK_NOTE,
  BULK_TRACKED_TITLE, BULK_RETAINED_TITLE, BULK_NEW_TITLE, BULK_URLS,
  bulkResponses,
} from '../fixtures/bulk-inventory'
import type { BulkPhase, BulkProvider } from '../fixtures/bulk-inventory'
import { createBulkInventoryServer } from '../fixtures/bulk-inventory-server'
import { expectInitialCatalogRequest, readServerMode, watchApiRequests } from './helpers/api-requests'
import { readSaved, waitForSavedCommit } from './helpers/saved-store'

type Server = Awaited<ReturnType<typeof createBulkInventoryServer>>
const duplicateMessage = '게시판의 공고 목록이 중복되어 전체 조회를 확인하지 못했어요.'
const dataButton = (page: Page) => page.getByRole('button', { name: '데이터와 추천 방식', exact: true })
const navigation = (page: Page) => page.getByRole('navigation', { name: '주요 메뉴' })
const query = (page: Page) => page.getByRole('textbox', { name: '도시, 회사 또는 포지션 검색', exact: true })
const subjects = [
  {
    provider: 'greenhouse' as const, companyId: 'bulk-cedar', companyName: 'Cedar Bulk', board: 'CedarBulk51',
    trackedId: 'greenhouse-bulk-cedar-7101', trackedUrl: 'https://example.com/bulk/greenhouse/7101',
    technicalIds: ['greenhouse-bulk-cedar-7101', 'greenhouse-bulk-cedar-7102'],
    publishedIds: ['greenhouse-bulk-cedar-7101', 'greenhouse-bulk-cedar-7102', 'greenhouse-bulk-cedar-7103'],
    newId: 'greenhouse-bulk-cedar-7104',
  },
  {
    provider: 'ashby' as const, companyId: 'bulk-maple', companyName: 'Maple Bulk', board: 'MapleBulk51',
    trackedId: 'ashby-bulk-maple-tracked', trackedUrl: 'https://example.com/bulk/ashby/tracked',
    technicalIds: ['ashby-bulk-maple-tracked', 'ashby-bulk-maple-retained'],
    publishedIds: ['ashby-bulk-maple-tracked', 'ashby-bulk-maple-retained', 'ashby-bulk-maple-sales'],
    newId: 'ashby-bulk-maple-new-public',
  },
]
type Subject = typeof subjects[number]
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
    if (url.pathname === '/__bulk51-seed') return route.fulfill({
      contentType: 'text/html', body: '<!doctype html><title>Once-only fictional setup</title>',
    })
    return route.fallback()
  })
  await page.clock.setFixedTime(new Date(BULK_TIME))
  await page.goto(`${server.origin}/__bulk51-seed`)
  await page.evaluate(seed => {
    localStorage.setItem('orbit.v1.profile', JSON.stringify(seed.profile))
    localStorage.setItem('orbit.v1.exploration', JSON.stringify(seed.exploration))
    localStorage.setItem('orbit.v1.compare', JSON.stringify(['london', 'berlin']))
  }, { profile: BULK_PROFILE, exploration: BULK_EXPLORATION })
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
async function change(page: Page, server: Server, provider: BulkProvider, phase: BulkPhase, time: string) {
  await server.respond(bulkResponses(provider, phase))
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
async function saveTracked(page: Page, subject: Subject) {
  await expect(page.locator('.city-detail-count strong')).toHaveText(['1', '2'])
  await page.getByRole('button', { name: '전체 2개 공고 보기', exact: true }).click()
  await page.getByRole('button', { name: BULK_TRACKED_TITLE, exact: true }).click()
  await page.getByRole('button', { name: '기회 저장', exact: true }).click()
  await page.getByLabel('이 기회에 대한 나의 메모', { exact: true }).fill(BULK_NOTE)
  await page.getByRole('button', { name: '지원 완료로 표시', exact: true }).click()
  await waitForSavedCommit(page)
  await page.keyboard.press('Escape')
  const records = await readSaved(page)
  expect(records).toHaveLength(1)
  expect(records[0]).toMatchObject({
    note: BULK_NOTE, status: 'applied',
    company: { id: subject.companyId, name: subject.companyName, provider: subject.provider, board: subject.board },
    job: { id: subject.trackedId, title: BULK_TRACKED_TITLE, fetchedAt: BULK_TIME, url: subject.trackedUrl },
  })
  return records
}
async function savedView(page: Page) {
  await navigation(page).getByRole('button', { name: /^저장한 기회/ }).click()
  await expect(page.locator('.saved-card')).toHaveCount(1)
  await expect(page.locator('.saved-card .saved-status')).toHaveText('지원 완료')
  await expect(page.locator('.saved-card')).toContainText(BULK_NOTE)
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
async function evidence(page: Page, info: TestInfo, server: Server, state: Awaited<ReturnType<typeof setup>>, subject: Subject, expectedTarget: string[], expectedControl: string[], extra: unknown) {
  const upstream = await server.requests()
  expect(upstream.filter(request => request.url === BULK_URLS[subject.provider]).map(request => request.url)).toEqual(expectedTarget)
  expect(upstream.filter(request => request.url === BULK_URLS.control).map(request => request.url)).toEqual(expectedControl)
  expect(upstream).toHaveLength(expectedTarget.length + expectedControl.length)
  expect(upstream.every(request => request.synthetic && request.networkSent === false && request.method === 'GET')).toBe(true)
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
  for (const marker of ['PRIVATE_BULK_51', BULK_NOTE, 'private-bulk51', subject.trackedId])
    expect(JSON.stringify(state.traffic.requests)).not.toContain(marker)
  expect(await readFile(server.defaultCache, 'utf8')).toBe(server.defaultBytes)
  await writeFile(info.outputPath('bulk-inventory-observation.json'), JSON.stringify({
    clock: 'Fixture child Date.now and browser Date are explicit inputs; native timers, provider, cache, API and actual browser remain real.',
    provider: subject.provider, seededOnce: true, noReloadInitScript: true, upstream, browserRequests: state.traffic.requests,
    failures: state.failures, context: await contextState(page), saved: await readSaved(page), extra,
  }, null, 2))
}

async function openHistory(page: Page) {
  const details = page.getByRole('dialog').locator('.board-details')
  if (await details.getAttribute('open') === null) await details.locator(':scope > summary').click()
  await expect(details).toHaveAttribute('open')
}

for (const subject of subjects) for (const width of [1440, 320]) test.describe(`${subject.provider} bulk inventory integrity at ${width}px`, () => {
  test.use({ viewport: { width, height: 960 }, isMobile: width === 320, hasTouch: width === 320 })

  test('an inconsistent bulk feed retains the old snapshot and uncertain saved status through restart while another board updates, then unique and truly empty feeds recover', async ({ page, request, baseURL }, info) => {
    const mode = await readServerMode(request, `${baseURL}/api/health`)
    const server = await createBulkInventoryServer(info.outputPath('bulk-server'), mode, subject.provider)
    try {
      await server.start()
      await server.verifyProductionBytes()
      const state = await setup(page, server)
      await initial(page, state)
      const records = await saveTracked(page, subject)
      const beforeContext = await contextState(page)
      expect(beforeContext.profile.linkedinUrl).toBe('https://example.com/private-bulk51')
      expect(beforeContext.exploration).toEqual(BULK_EXPLORATION)
      expect(beforeContext.compare).toEqual(['london', 'berlin'])
      const beforeCache = await cache(server)
      const original = beforeCache.boards.find(board => board.companyId === subject.companyId)!
      expect(original.snapshot).toMatchObject({ fetchedAt: BULK_TIME, total: 3, publishedIds: subject.publishedIds })

      await change(page, server, subject.provider, 'duplicate', BULK_CHANGE_TIME)
      await refresh(page, ['22', '2', '4'])
      await expect(row(page, subject.companyName)).toContainText('이전 2개 유지')
      await expect(row(page, subject.companyName)).toContainText(duplicateMessage)
      await expect(firstTime(page, subject.companyName)).toHaveAttribute('datetime', BULK_TIME)
      await expect(row(page, 'Birch Control')).toContainText('2개 반영')
      await expect(firstTime(page, 'Birch Control')).toHaveAttribute('datetime', BULK_CHANGE_TIME)
      await row(page, subject.companyName).scrollIntoViewIfNeeded()
      await audit(page, info, width === 320 ? `bulk-${subject.provider}-retained-board-320.png` : undefined)
      await closeData(page)
      await expect(query(page)).toHaveValue('Engineer')
      await expect(page.locator('.city-detail-hero')).toContainText('런던')
      await expect(page.locator('.city-detail-count strong')).toHaveText(['1', '2'])
      const current = await actual<Catalog>(page, server, '/api/catalog?source=public')
      expect(current.jobs.map(job => job.id)).toEqual([
        ...subject.technicalIds, 'lever-bulk-birch-control-one', 'lever-bulk-birch-control-two',
      ])
      const failedCache = await cache(server)
      const retained = failedCache.boards.find(board => board.companyId === subject.companyId)!
      expect(retained.snapshot).toEqual(original.snapshot)
      expect(retained).toMatchObject({ checkedAt: BULK_CHANGE_TIME, failures: 1, error: duplicateMessage })
      expect(Date.parse(retained.retryAt!)).toBeGreaterThanOrEqual(Date.parse('2026-09-26T09:03:00.000Z'))
      expect(Date.parse(retained.retryAt!)).toBeLessThanOrEqual(Date.parse('2026-09-26T09:03:12.000Z'))
      await navigation(page).getByRole('button', { name: /^도시 비교/ }).click()
      await expect(page.locator('.comparison-city h2')).toHaveText(['런던', '베를린'])
      await expect(metric(page, '관련 채용공고')).toHaveText(['2개', '2개', '—'])
      await savedView(page)
      await checkSaved(page)
      await expect(page.locator('.posting-summary strong')).toHaveText(['0', '0', '0', '1'])
      await expect(page.locator('.saved-card .posting-notice.unknown')).toContainText('현재 상태 확인 필요')
      await expect(page.locator('.saved-card .posting-notice.unknown')).toContainText('회사 게시판 조회에 실패했어요. 이전 목록으로 게시 종료를 판단하지 않습니다.')
      await expect(page.locator('.posting-notice.missing')).toHaveCount(0)
      const status = await actual<PostingStatusIndex>(page, server, '/api/posting-status')
      expect(status.version).toBe(2)
      expect(status.boards[0]).toMatchObject({
        status: 'error', lastSuccessAt: BULK_TIME,
        listing: { publishedIds: subject.publishedIds, jobs: [], content: { checkedAt: BULK_TIME, status: 'error', jobIds: subject.technicalIds } },
      })
      expect(await cache(server)).toEqual(failedCache)
      expect(await readSaved(page)).toEqual(records)
      expect(await contextState(page)).toEqual(beforeContext)
      await page.locator('.saved-card .posting-notice').scrollIntoViewIfNeeded()
      await audit(page, info, width === 320 ? `bulk-${subject.provider}-unknown-saved-320.png` : undefined)

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

      await change(page, server, subject.provider, 'recovered', BULK_RECOVERY_TIME)
      // Saved-only restart has not loaded a browser catalog. The explicit
      // initial public action still performs the same full recollection.
      await refresh(page, ['22', '2', '5'], true)
      await openHistory(page)
      await expect(firstTime(page, subject.companyName)).toHaveAttribute('datetime', BULK_RECOVERY_TIME)
      await expect(row(page, subject.companyName)).toContainText('3개 반영')
      await closeData(page)
      expect(new URL(page.url()).hash).toBe('#saved')
      await checkSaved(page, true)
      await expect(page.locator('.posting-summary strong')).toHaveText(['1', '0', '0', '0'])
      await expect(page.locator('.saved-card .posting-notice.listed')).toHaveCount(1)
      await expect(page.locator('.posting-notice.missing, .posting-notice.unknown')).toHaveCount(0)
      expect(await readSaved(page)).toEqual(records)
      expect(await contextState(page)).toEqual(beforeContext)
      const recovered = await cache(server)
      expect(recovered.boards[0].snapshot).toMatchObject({
        fetchedAt: BULK_RECOVERY_TIME, total: 4, publishedIds: [...subject.publishedIds, subject.newId],
      })

      await change(page, server, subject.provider, 'empty', BULK_EMPTY_TIME)
      await refresh(page, ['22', '2', '2'])
      await openHistory(page)
      await expect(firstTime(page, subject.companyName)).toHaveAttribute('datetime', BULK_EMPTY_TIME)
      await expect(row(page, subject.companyName)).toContainText('0개 반영')
      await closeData(page)
      await checkSaved(page, true)
      await expect(page.locator('.posting-summary strong')).toHaveText(['0', '0', '1', '0'])
      await expect(page.locator('.saved-card .posting-notice.missing')).toContainText('최근 공개 목록에서 찾지 못했어요. 채용 종료 여부는 원문에서 확인해 주세요.')
      await expect(page.locator('.posting-notice.unknown')).toHaveCount(0)
      const empty = await cache(server)
      expect(empty.boards[0]).toMatchObject({ failures: 0, retryAt: null })
      expect(empty.boards[0].snapshot).toEqual({ fetchedAt: BULK_EMPTY_TIME, jobs: [], total: 0, unmappedCount: 0, publishedIds: [] })
      expect(await readSaved(page)).toEqual(records)
      expect(await contextState(page)).toEqual(beforeContext)
      await evidence(page, info, server, state, subject,
        [BULK_URLS[subject.provider], BULK_URLS[subject.provider], BULK_URLS[subject.provider], BULK_URLS[subject.provider]],
        [BULK_URLS.control, BULK_URLS.control, BULK_URLS.control, BULK_URLS.control],
        { beforeCache, failedCache, recovered, empty, current, status })
    } finally { await page.close(); await server.stop() }
  })

  test('a cold duplicated inventory excluded from discovery is unavailable, then an explicit unique retry restores real jobs without replacing personal context', async ({ page, request, baseURL }, info) => {
    const mode = await readServerMode(request, `${baseURL}/api/health`)
    const server = await createBulkInventoryServer(info.outputPath('bulk-server'), mode, subject.provider, false)
    try {
      await server.respond(bulkResponses(subject.provider, 'cold-duplicate'))
      await server.start()
      await server.verifyProductionBytes()
      const state = await setup(page, server)
      await expect(page.getByRole('button', { name: '공개 공고 연결 필요', exact: true })).toBeVisible()
      await expect(page.getByRole('heading', { name: '공개 공고에 연결하지 못했어요', exact: true })).toBeVisible()
      await expect(page.locator('.company-card, .city-row, .flat-marker')).toHaveCount(0)
      await expect.poll(() => state.traffic.catalog().filter(request => request.state === 'finished').length).toBe(1)
      const initialRequests = state.traffic.catalog()
      state.expectedAborts = initialRequests.filter(request => request.state === 'failed').length
      expect(state.expectedAborts).toBeLessThanOrEqual(mode === 'development' ? 1 : 0)
      expect(initialRequests.every(request => new URL(request.url).search === '?source=public')).toBe(true)
      expect(state.traffic.requests.some(request => request.status === 503)).toBe(true)
      const beforeContext = await contextState(page)
      expect(beforeContext.profile.linkedinUrl).toBe('https://example.com/private-bulk51')
      const unavailable = await actual<{ error: string; code: string }>(page, server, '/api/catalog?source=public', 503)
      expect(unavailable).toMatchObject({
        code: 'CATALOG_UNAVAILABLE', error: '공개 채용 게시판에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요.',
      })
      const failedCache = await cache(server)
      expect(failedCache.boards[0]).toMatchObject({ companyId: subject.companyId, failures: 1, error: duplicateMessage })
      expect(failedCache.boards[0]).not.toHaveProperty('snapshot')
      const status = await actual<PostingStatusIndex>(page, server, '/api/posting-status')
      expect(status.boards[0]).toMatchObject({ status: 'error', lastSuccessAt: null })
      expect(status.boards[0]).not.toHaveProperty('listing')
      await dataButton(page).press('Enter')
      await expect(page.getByRole('dialog').locator('.coverage-stats strong')).toHaveText(['22', '1', '—'])
      await expect(page.getByRole('dialog').getByRole('alert')).toContainText(unavailable.error)
      await expect(page.getByRole('dialog').getByRole('button', { name: /^공개 공고 다시 조회/ })).toBeDisabled()
      await audit(page, info, width === 320 ? `bulk-${subject.provider}-unavailable-320.png` : undefined)
      await closeData(page)

      await change(page, server, subject.provider, 'recovered', BULK_CHANGE_TIME)
      await refresh(page, ['22', '1', '3'], true)
      await openHistory(page)
      await expect(firstTime(page, subject.companyName)).toHaveAttribute('datetime', BULK_CHANGE_TIME)
      await closeData(page)
      await expect(page.locator('.city-detail-count strong')).toHaveText(['1', '3'])
      await expect(page.locator('.company-card h3')).toHaveText(subject.companyName)
      await page.getByRole('button', { name: '전체 3개 공고 보기', exact: true }).click()
      expect((await page.locator('.mini-job-title').allTextContents()).sort()).toEqual([
        BULK_NEW_TITLE, BULK_RETAINED_TITLE, BULK_TRACKED_TITLE,
      ])
      const recovered = await actual<Catalog>(page, server, '/api/catalog?source=public')
      expect(recovered.jobs.map(job => job.id)).toEqual([...subject.technicalIds, subject.newId])
      expect(recovered.boards[0]).toMatchObject({ status: 'ok', total: 4, included: 3, lastSuccessAt: BULK_CHANGE_TIME })
      expect(await contextState(page)).toEqual(beforeContext)
      expect(await readSaved(page)).toEqual([])
      await audit(page, info)
      await evidence(page, info, server, state, subject,
        [BULK_URLS[subject.provider], BULK_URLS[subject.provider]], [],
        { unavailable, failedCache, status, recovered })
    } finally { await page.close(); await server.stop() }
  })
})
