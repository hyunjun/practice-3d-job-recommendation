import { expect, test } from '@playwright/test'
import type { Page, TestInfo } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { Catalog, SavedJob } from '../../shared/types'
import { DEFAULT_FILTERS } from '../../shared/types'
import {
  PRESENCE_CHANGED_BODY, PRESENCE_DETAIL_URLS, PRESENCE_FETCHED_AT, PRESENCE_LEGACY_CSV_HEADERS,
  PRESENCE_NOTE, PRESENCE_NOW, PRESENCE_ORIGINAL_BODY, PRESENCE_PAGE_URLS, PRESENCE_SAVED_AT,
  PRESENCE_TITLES, presencePagedSaved, presenceResponses, presenceSaved,
} from '../fixtures/posting-presence'
import type { PresenceScenario } from '../fixtures/posting-presence'
import { createPostingPresenceServer, PRESENCE_PRIVATE_ROOT } from '../fixtures/posting-presence-server'
import type { PresenceMode } from '../fixtures/posting-presence-server'
import { readServerMode, watchApiRequests } from './helpers/api-requests'
import { readSaved, waitForSavedCommit } from './helpers/saved-store'

type Server = Awaited<ReturnType<typeof createPostingPresenceServer>>
const savedSearch = (page: Page) => page.getByRole('textbox', { name: '저장한 기회 검색', exact: true })
const postingFilter = (page: Page) => page.getByRole('combobox', { name: '게시 상태', exact: true })
const card = (page: Page, title: string) => page.locator('.saved-card').filter({ has: page.getByRole('button', { name: title, exact: true }) })
const navigation = (page: Page) => page.getByRole('navigation', { name: '주요 메뉴' })
const explorationSearch = (page: Page) => page.getByRole('textbox', { name: '도시, 회사 또는 포지션 검색', exact: true })
const runId = `${new Date().toISOString().replaceAll(/[:.]/g, '-')}-${process.pid}`

async function fixture(page: Page, info: TestInfo, baseURL: string | undefined, scenario: PresenceScenario = 'complete') {
  const configured = process.env.ORBIT_POSTING_PRESENCE_MODE
  if (configured && configured !== 'development' && configured !== 'production') throw new Error('Unknown presence server mode')
  const mode: PresenceMode = configured === 'development' || configured === 'production'
    ? configured : await readServerMode(page.request, `${baseURL}/api/health`)
  const directory = path.join(PRESENCE_PRIVATE_ROOT, 'runs', runId, `${mode}-${info.titlePath.join('-').replaceAll(/[^a-zA-Z0-9-]/g, '-').slice(-180)}`)
  return createPostingPresenceServer(directory, mode, { responses: presenceResponses({ scenario }) })
}
async function seed(page: Page, origin: string, saved = presenceSaved(), source: 'sample' | 'public' = 'sample', visibleCount = saved.length) {
  await page.clock.install({ time: new Date(PRESENCE_NOW) })
  await page.addInitScript(({ origin, saved, filters, source }) => {
    if (location.origin !== origin || sessionStorage.getItem('presence-seeded')) return
    localStorage.setItem('orbit.v1.saved', JSON.stringify(saved))
    localStorage.setItem('orbit.v1.exploration', JSON.stringify({
      source, selectedId: 'london', mapMode: 'flat', panelTab: 'cities',
      filters: { ...filters, query: 'Harbour Relay', region: 'europe' },
    }))
    sessionStorage.setItem('presence-seeded', 'true')
  }, { origin, saved, filters: DEFAULT_FILTERS, source })
  await page.goto(`${origin}/#saved`)
  await expect(page.locator('.saved-card')).toHaveCount(visibleCount)
  await waitForSavedCommit(page)
}
async function check(page: Page, name = '게시 상태 확인') {
  const response = page.waitForResponse(response => {
    const url = new URL(response.url())
    return url.pathname === '/api/posting-status' && !url.searchParams.has('content')
  })
  await page.getByRole('button', { name, exact: true }).click()
  const result = await response
  expect(result.status()).toBe(200)
  const data = await result.json()
  await expect(page.getByRole('button', { name: '새로 확인', exact: true })).toBeVisible()
  return data
}
async function checkContent(page: Page) {
  const response = page.waitForResponse(response => {
    const url = new URL(response.url())
    return url.pathname === '/api/posting-status' && url.search === '?refresh=1&content=1'
  })
  await page.getByRole('button', { name: '공고 내용 확인', exact: true }).click()
  const result = await response
  expect(result.status()).toBe(200)
  const data = await result.json()
  await expect(page.getByRole('button', { name: '공고 내용 확인', exact: true })).toBeVisible()
  return data
}
async function exportRows(page: Page, server: Server, name: string) {
  const download = page.waitForEvent('download')
  await page.getByRole('button', { name: 'CSV 내보내기', exact: true }).click()
  const text = await readFile((await (await download).path())!, 'utf8')
  await writeFile(path.join(server.directory, name), text)
  const values = [...text.matchAll(/"((?:[^"]|"")*)"(?:,|\r\n|$)/g)].map(match => match[1].replaceAll('""', '"'))
  const end = text.indexOf('\r\n')
  const headerCount = [...text.slice(0, end).matchAll(/"((?:[^"]|"")*)"(?:,|$)/g)].length
  const headers = values.splice(0, headerCount)
  expect(headers).toEqual([...PRESENCE_LEGACY_CSV_HEADERS, '공고 내용 확인 시각'])
  expect(new Set(headers).size).toBe(headers.length)
  expect(values.length % headers.length).toBe(0)
  return Array.from({ length: values.length / headers.length }, (_, index) =>
    Object.fromEntries(headers.map((header, column) => [header, values[index * headers.length + column]])))
}
async function assertTraffic(server: Server, listingCalls: number, detailCalls: number) {
  const requests = await server.requests()
  expect(requests).toHaveLength(listingCalls + detailCalls)
  expect(requests.filter(request => request.kind === 'list')).toHaveLength(listingCalls)
  expect(requests.filter(request => request.kind === 'detail')).toHaveLength(detailCalls)
  expect(requests.every(request => request.synthetic && !request.networkSent && request.method === 'GET' && request.body === null)).toBe(true)
  return requests
}
async function advance(page: Page, server: Server, milliseconds: number) {
  await server.advance(milliseconds)
  await page.clock.fastForward(milliseconds)
}
async function publicCatalog(page: Page, server: Server): Promise<Catalog> {
  const response = await page.request.get(`${server.origin}/api/catalog?source=public`)
  try {
    expect(response.status()).toBe(200)
    return await response.json()
  } finally { await response.dispose() }
}
function preservedSaved(records: SavedJob[], note = PRESENCE_NOTE) {
  expect(records).toHaveLength(3)
  expect(records.find(record => record.job.id === 'smartrecruiters-presence-harbour-59001')).toMatchObject({
    job: {
      title: 'Backend Engineer — Harbour Relay',
      description: 'Responsibilities\nBuild a fictional relay with TypeScript.\n\nMinimum requirements\n3 years of software engineering experience.',
      url: 'https://example.com/jobs/presence-harbour-59001',
      fetchedAt: '2026-09-26T02:00:00.000Z', updatedAt: '2026-09-25T01:00:00.000Z',
    },
    savedAt: '2026-09-26T02:05:00.000Z', status: 'applied', note,
  })
  expect(records.find(record => record.job.id === 'smartrecruiters-presence-harbour-59201')).toMatchObject({
    job: { title: 'Account Executive — Harbour Final Page', description: 'Responsibilities\nSupport fictional account renewals.' },
    status: 'applied', note: '범위 밖 가상 메모', savedAt: '2026-09-26T02:05:00.000Z',
  })
}
async function audit(page: Page, server: Server, name: string) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  for (const dialog of await page.getByRole('dialog').all()) {
    expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
  }
  const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()
  await writeFile(path.join(server.directory, `${name}-axe.json`), JSON.stringify(result, null, 2))
  expect(result.violations).toEqual([])
  await page.screenshot({ path: path.join(server.directory, `${name}.png`), fullPage: true })
}

for (const width of [1440, 320]) test.describe(`presence-only saved flow at ${width}px`, () => {
  test.use({ viewport: { width, height: 960 }, isMobile: width === 320, hasTouch: width === 320 })
  test('a complete 201-ID board checks presence without detail requests while notes, filters, export and reload preserve saved content', async ({ page, baseURL }, info) => {
    test.setTimeout(60000)
    const server = await fixture(page, info, baseURL)
    const traffic = watchApiRequests(page)
    const errors: string[] = []
    const external: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    page.on('request', request => { if (new URL(request.url()).origin !== server.origin) external.push(request.url()) })
    try {
      await server.start()
      await server.verifyProductionBytes()
      await seed(page, server.origin)
      expect(await server.requests()).toEqual([])
      expect(traffic.requests).toEqual([])
      await page.getByRole('button', { name: PRESENCE_TITLES.saved, exact: true }).click()
      await page.getByLabel('이 기회에 대한 나의 메모', { exact: true }).fill(PRESENCE_NOTE)
      await page.getByRole('button', { name: '지원 완료로 표시', exact: true }).click()
      await page.keyboard.press('Escape')
      await expect(page.getByRole('dialog')).toHaveCount(0)
      const before = await readSaved(page)
      preservedSaved(before)
      expect(await server.requests()).toEqual([])
      expect(traffic.requests).toEqual([])
      const localBefore = await page.evaluate(() => ({
        profile: localStorage.getItem('orbit.v1.profile'),
        exploration: localStorage.getItem('orbit.v1.exploration'),
      }))

      const index = await check(page)
      const requests = await server.requests()
      await writeFile(path.join(server.directory, 'first-presence-check.json'), JSON.stringify({ index, requests, before }, null, 2))
      expect(index.version).toBe(2)
      expect(Number.isFinite(Date.parse(index.contentRefreshAfter))).toBe(true)
      expect(index.boards[0].listing.jobs).toEqual([])
      expect(index.boards[0].listing.content).toBeUndefined()
      expect(requests.filter(request => request.kind === 'list').map(request => request.url)).toEqual([
        'https://api.smartrecruiters.com/v1/companies/HarbourPresence59/postings?limit=100&offset=0&destination=PUBLIC',
        'https://api.smartrecruiters.com/v1/companies/HarbourPresence59/postings?limit=100&offset=100&destination=PUBLIC',
        'https://api.smartrecruiters.com/v1/companies/HarbourPresence59/postings?limit=100&offset=200&destination=PUBLIC',
      ])
      // Keep this failing baseline expectation. A presence check must never
      // spend the extra two detail requests used by the old full collector.
      expect.soft(requests.filter(request => request.kind === 'detail'), 'Presence checking must fetch zero detail bodies').toEqual([])
      expect(requests.every(request => request.synthetic && !request.networkSent && request.method === 'GET' && request.body === null)).toBe(true)
      expect(index.boards[0].listing.publishedIds).toHaveLength(201)
      expect(index.boards[0].listing.publishedIds).toContain('smartrecruiters-presence-harbour-59201')
      expect(index.boards[0].listing.publishedIds).not.toContain('smartrecruiters-presence-harbour-59999')
      await expect(page.locator('.posting-notice.listed')).toHaveCount(2)
      await expect(page.locator('.posting-notice.missing')).toHaveCount(1)
      await expect(page.locator('.posting-notice.unknown')).toHaveCount(0)
      await expect(page.locator('.posting-summary')).toContainText('내용 미확인 2')
      await expect(card(page, PRESENCE_TITLES.saved).locator('.posting-notice')).toContainText('비교할 수 있는 최신 본문이 없어')
      await expect(card(page, PRESENCE_TITLES.outside).locator('.posting-notice')).not.toContainText('탐색 범위 밖')
      await expect(card(page, PRESENCE_TITLES.missing).locator('.posting-notice')).toContainText('최근 공개 목록에서 찾지 못했어요. 채용 종료 여부는 원문에서 확인해 주세요.')
      await expect(page.getByRole('button', { name: '새로 확인', exact: true })).toBeDisabled()
      await expect(page.getByRole('button', { name: '공고 내용 확인', exact: true })).toBeEnabled()
      await audit(page, server, `presence-${width}`)

      await postingFilter(page).selectOption('listed')
      await expect(page.locator('.saved-card')).toHaveCount(2)
      await savedSearch(page).fill('Final Page')
      await expect(page.locator('.saved-title')).toHaveText(['Account Executive — Harbour Final Page'])
      await postingFilter(page).selectOption('missing')
      await expect(page.locator('.saved-card')).toHaveCount(0)
      await savedSearch(page).fill('Previously Saved')
      await expect(page.locator('.saved-title')).toHaveText(['Backend Engineer — Harbour Previously Saved'])
      await postingFilter(page).selectOption('all')
      await savedSearch(page).fill('가상 지원 메모')
      await expect(page.locator('.saved-title')).toHaveText(['Backend Engineer — Harbour Relay'])
      await page.locator('.saved-title').click()
      await page.locator('.original-description > summary').click()
      await expect(page.locator('.job-description > p')).toHaveText(PRESENCE_ORIGINAL_BODY)
      await expect(page.getByLabel('이 기회에 대한 나의 메모', { exact: true })).toHaveValue(PRESENCE_NOTE)
      await expect(page.getByRole('button', { name: '지원 완료로 표시됨', exact: true })).toBeVisible()
      await audit(page, server, `saved-original-${width}`)
      await page.keyboard.press('Escape')
      const rows = await exportRows(page, server, 'presence-export.csv')
      expect(rows).toHaveLength(3)
      expect(rows.find(row => row['포지션'] === 'Backend Engineer — Harbour Relay')).toMatchObject({
        '회사': 'Harbour Lantern', '상태': '지원 완료', '메모': PRESENCE_NOTE, '저장일': PRESENCE_SAVED_AT,
        '공개 게시 상태': '게시 확인', '저장 내용의 조회 시각': PRESENCE_FETCHED_AT, '공고 내용 확인 시각': '',
      })
      expect.soft(rows.find(row => row['포지션'] === 'Backend Engineer — Harbour Relay')?.['내용 비교'], 'Presence evidence alone cannot certify a content comparison').toBe('미확인')
      expect(rows.find(row => row['포지션'] === 'Backend Engineer — Harbour Previously Saved')?.['공개 게시 상태']).toBe('공개 목록에서 미확인')
      expect(await readSaved(page)).toEqual(before)
      expect(await page.evaluate(() => ({
        profile: localStorage.getItem('orbit.v1.profile'),
        exploration: localStorage.getItem('orbit.v1.exploration'),
      }))).toEqual(localBefore)
      await page.reload()
      await expect(page.locator('.saved-card')).toHaveCount(3)
      await expect(page.locator('.posting-notice.unchecked')).toHaveCount(3)
      expect(await readSaved(page)).toEqual(before)
      expect(await server.requests()).toEqual(requests)
      expect(traffic.requests).toHaveLength(1)
      expect(traffic.requests[0]).toMatchObject({
        url: `${server.origin}/api/posting-status?refresh=1`, method: 'GET', body: null, status: 200, state: 'finished',
      })
      expect(errors).toEqual([])
      expect(external).toEqual([])
    } finally {
      await writeFile(path.join(server.directory, 'browser-api.json'), JSON.stringify({ traffic: traffic.requests, errors, external }, null, 2))
      await page.close()
      await server.stop()
    }
  })

  test('content checks have their own cooldown and expire without renewing body comparisons during fresh presence checks', async ({ page, baseURL }, info) => {
    test.setTimeout(60000)
    const server = await fixture(page, info, baseURL)
    const traffic = watchApiRequests(page)
    try {
      await server.start()
      const records = presenceSaved()
      records[0].status = 'applied'
      records[0].note = PRESENCE_NOTE
      await seed(page, server.origin, records)
      const before = await readSaved(page)
      await expect(page.locator('.saved-card')).toHaveCount(3)
      await check(page)
      await assertTraffic(server, 3, 0)
      await postingFilter(page).selectOption('content-unknown')
      await expect(page.locator('.saved-title')).toHaveText([
        'Backend Engineer — Harbour Relay', 'Account Executive — Harbour Final Page',
      ])
      await expect(page.getByRole('button', { name: '새로 확인', exact: true })).toBeDisabled()
      await expect(page.getByRole('button', { name: '공고 내용 확인', exact: true })).toBeEnabled()
      const first = await checkContent(page)
      expect(first.version).toBe(2)
      expect(first.boards[0].listing.jobs).toHaveLength(2)
      expect(first.boards[0].listing.content.status).toBe('ok')
      expect(first.boards[0].listing.content.jobIds).toEqual([
        'smartrecruiters-presence-harbour-59001', 'smartrecruiters-presence-harbour-59101',
      ])
      const bodyTime = first.boards[0].listing.content.checkedAt
      expect(bodyTime).toBe(first.boards[0].lastSuccessAt)
      await expect(page.getByRole('button', { name: '공고 내용 확인', exact: true })).toBeDisabled()
      await expect(page.locator('.saved-title')).toHaveText(['Account Executive — Harbour Final Page'])
      await expect(page.locator('.posting-summary')).toContainText('내용 미확인 1')
      await assertTraffic(server, 6, 2)
      let rows = await exportRows(page, server, 'content-current.csv')
      expect(rows.find(row => row['포지션'] === PRESENCE_TITLES.saved)).toMatchObject({
        '내용 비교': '표시 내용 일치', '공고 내용 확인 시각': bodyTime, '게시 목록 확인 시각': bodyTime,
      })
      expect(rows.find(row => row['포지션'] === PRESENCE_TITLES.outside)).toMatchObject({
        '내용 비교': '미확인', '공고 내용 확인 시각': '',
      })
      await postingFilter(page).selectOption('all')
      const fullFile = (await server.cacheFiles()).find(file => !file.endsWith('.presence-v1.json'))
      expect(fullFile).toBeTruthy()
      const fullBytes = await readFile(path.join(server.cwd, '.local', fullFile!), 'utf8')
      await server.respond(presenceResponses({ changed: true }))
      await advance(page, server, 20 * 60_000)
      const laterPresence = await check(page, '새로 확인')
      await assertTraffic(server, 9, 2)
      expect(laterPresence.boards[0].listing.content.checkedAt).toBe(bodyTime)
      expect(laterPresence.boards[0].listing.content.validUntil).toBe(first.boards[0].listing.content.validUntil)
      expect(laterPresence.boards[0].lastSuccessAt > bodyTime).toBe(true)
      await expect(card(page, PRESENCE_TITLES.saved).locator('.posting-changes')).toHaveCount(0)
      await postingFilter(page).selectOption('content-unknown')
      await expect(page.locator('.saved-title')).toHaveText(['Account Executive — Harbour Final Page'])
      await advance(page, server, 11 * 60_000)
      await expect(page.locator('.saved-title')).toHaveText([
        'Backend Engineer — Harbour Relay', 'Account Executive — Harbour Final Page',
      ])
      // The 20-minute presence evidence still lives until minute 50. Only
      // content must expire here, with no request or saved-record mutation.
      await expect(card(page, PRESENCE_TITLES.saved).locator('.posting-notice')).toHaveClass(/listed/)
      await expect(card(page, PRESENCE_TITLES.saved).locator('.posting-notice')).toContainText('본문 확인 시각이 오래되어')
      await expect(card(page, PRESENCE_TITLES.saved).locator('.posting-changes')).toHaveCount(0)
      await assertTraffic(server, 9, 2)
      rows = await exportRows(page, server, 'content-expired-with-fresh-presence.csv')
      expect(rows.find(row => row['포지션'] === PRESENCE_TITLES.saved)).toMatchObject({
        '공개 게시 상태': '게시 확인', '내용 비교': '미확인', '공고 내용 확인 시각': bodyTime,
        '게시 목록 확인 시각': laterPresence.boards[0].lastSuccessAt,
      })
      expect(rows.find(row => row['포지션'] === PRESENCE_TITLES.outside)).toMatchObject({
        '공개 게시 상태': '게시 확인', '내용 비교': '미확인', '공고 내용 확인 시각': '',
      })
      const freshPresence = await check(page, '새로 확인')
      expect(freshPresence.boards[0].listing.jobs).toEqual([])
      expect(freshPresence.boards[0].listing.content.checkedAt).toBe(bodyTime)
      expect(freshPresence.boards[0].listing.content.jobIds).toEqual([
        'smartrecruiters-presence-harbour-59001', 'smartrecruiters-presence-harbour-59101',
      ])
      expect(await readFile(path.join(server.cwd, '.local', fullFile!), 'utf8')).toBe(fullBytes)
      await assertTraffic(server, 12, 2)
      await postingFilter(page).selectOption('changed')
      await expect(page.locator('.saved-card')).toHaveCount(0)
      const refreshed = await checkContent(page)
      await assertTraffic(server, 15, 4)
      expect(refreshed.boards[0].listing.content.checkedAt > bodyTime).toBe(true)
      await expect(page.locator('.saved-title')).toHaveText(['Backend Engineer — Harbour Relay'])
      await expect(page.locator('.posting-changes')).toHaveText('포지션 · 기술·경력·언어 · 본문 확인 필요')
      await expect(page.locator('.posting-current-title')).toHaveText('현재 포지션: Staff Backend Engineer — Harbour Relay')
      await postingFilter(page).selectOption('content-unknown')
      await expect(page.locator('.saved-title')).toHaveText(['Account Executive — Harbour Final Page'])
      await postingFilter(page).selectOption('changed')
      await savedSearch(page).fill('Staff')
      await expect(page.locator('.saved-card')).toHaveCount(0)
      await savedSearch(page).fill('가상 지원 메모')
      await expect(page.locator('.saved-card')).toHaveCount(1)
      await page.locator('.saved-title').click()
      await page.locator('.original-description > summary').click()
      await expect(page.locator('.job-description > p')).toHaveText(PRESENCE_ORIGINAL_BODY)
      await expect(page.getByLabel('이 기회에 대한 나의 메모', { exact: true })).toHaveValue(PRESENCE_NOTE)
      await expect(page.getByRole('button', { name: '지원 완료로 표시됨', exact: true })).toBeVisible()
      await audit(page, server, `content-difference-${width}`)
      await page.keyboard.press('Escape')
      rows = await exportRows(page, server, 'content-changed.csv')
      expect(rows.find(row => row['포지션'] === PRESENCE_TITLES.saved)).toMatchObject({
        '상태': '지원 완료', '메모': PRESENCE_NOTE, '내용 비교': '차이 있음',
        '저장 내용과 다른 항목': '포지션 · 기술·경력·언어 · 본문',
        '공고 내용 확인 시각': refreshed.boards[0].listing.content.checkedAt,
        '게시 목록 확인 시각': refreshed.boards[0].lastSuccessAt,
      })
      expect(await readSaved(page)).toEqual(before)
      preservedSaved(await readSaved(page))
      await writeFile(path.join(server.directory, 'independent-clocks.json'), JSON.stringify({
        first, laterPresence, freshPresence, refreshed, before, requests: await server.requests(), browser: traffic.requests,
      }, null, 2))
      await page.reload()
      await expect(page.locator('.posting-notice.unchecked')).toHaveCount(3)
      expect(await readSaved(page)).toEqual(before)
      await assertTraffic(server, 15, 4)
      expect(traffic.requests.map(request => new URL(request.url).search)).toEqual([
        '?refresh=1', '?refresh=1&content=1', '?refresh=1', '?refresh=1', '?refresh=1&content=1',
      ])
    } finally { await page.close(); await server.stop() }
  })

  for (const failure of ['inventory', 'detail'] as const) test(`a full ${failure} failure preserves original records and body time, with truthful presence across restart and recovery`, async ({ page, baseURL }, info) => {
    const server = await fixture(page, info, baseURL)
    try {
      await server.start()
      await server.verifyProductionBytes()
      const records = presenceSaved()
      records[0].status = 'applied'
      records[0].note = PRESENCE_NOTE
      await seed(page, server.origin, records)
      const before = await readSaved(page)
      const first = await checkContent(page)
      await assertTraffic(server, 3, 2)
      expect(first.boards[0].listing.publishedIds).toHaveLength(201)
      expect(first.boards[0].listing.publishedIds).toContain('smartrecruiters-presence-harbour-59201')
      const bodyTime = first.boards[0].listing.content.checkedAt
      const cacheFile = (await server.cacheFiles()).find(file => !file.endsWith('.presence-v1.json'))!
      const originalCache = JSON.parse(await readFile(path.join(server.cwd, '.local', cacheFile), 'utf8'))
      await advance(page, server, 61_000)
      const responses = presenceResponses({ changed: true, scenario: failure === 'inventory' ? 'partial-final' : 'complete' })
      if (failure === 'detail') responses[PRESENCE_DETAIL_URLS[1]] = {
        status: 503, body: { error: 'Fictional second posting body unavailable after a complete list' },
      }
      await server.respond(responses)
      const failed = await checkContent(page)
      expect(failed.boards[0].lastSuccessAt).toBe(first.boards[0].lastSuccessAt)
      expect(failed.boards[0].listing.publishedIds).toEqual(first.boards[0].listing.publishedIds)
      expect(failed.boards[0].listing.jobs).toEqual([])
      expect(failed.boards[0].listing.content).toEqual({
        checkedAt: bodyTime, validUntil: first.boards[0].listing.content.validUntil, status: 'error',
        jobIds: ['smartrecruiters-presence-harbour-59001', 'smartrecruiters-presence-harbour-59101'],
      })
      const failedCache = JSON.parse(await readFile(path.join(server.cwd, '.local', cacheFile), 'utf8'))
      expect(failedCache.boards[0].snapshot).toEqual(originalCache.boards[0].snapshot)
      expect(failedCache.boards[0].errorPhase).toBe(failure === 'inventory' ? 'inventory' : 'content')
      if (failure === 'inventory') {
        expect(failed.boards[0].status).toBe('error')
        await expect(page.locator('.posting-summary strong')).toHaveText(['0', '0', '0', '3'])
        await expect(page.locator('.posting-notice.unknown')).toHaveCount(3)
        await expect(page.locator('.posting-notice.listed, .posting-notice.missing')).toHaveCount(0)
        await expect(card(page, PRESENCE_TITLES.saved).locator('.posting-notice')).toContainText('회사 게시판 조회에 실패했어요. 이전 목록으로 게시 종료를 판단하지 않습니다.')
        await assertTraffic(server, 6, 2)
      } else {
        expect(failed.boards[0].status).toBe('ok')
        await expect(page.locator('.posting-summary strong')).toHaveText(['2', '0', '2', '1', '0'])
        await expect(page.locator('.posting-notice.listed')).toHaveCount(2)
        await expect(page.locator('.posting-notice.missing')).toHaveCount(1)
        await expect(page.locator('.posting-notice.unknown')).toHaveCount(0)
        await expect(card(page, PRESENCE_TITLES.saved).locator('.posting-notice')).toContainText('게시 여부는 확인했어요. 비교할 수 있는 최신 본문이 없어 내용의 차이는 미확인입니다. 공고 내용 확인이나 원문을 이용해 주세요.')
        await assertTraffic(server, 6, 4)
      }
      await expect(page.locator('.posting-changes, .posting-current-title')).toHaveCount(0)
      await expect(page.getByRole('button', { name: '새로 확인', exact: true })).toBeDisabled()
      await expect(page.getByRole('button', { name: '공고 내용 확인', exact: true })).toBeDisabled()
      const rows = await exportRows(page, server, `full-${failure}-failed.csv`)
      expect(rows.find(row => row['포지션'] === PRESENCE_TITLES.saved)).toMatchObject({
        '공개 게시 상태': failure === 'inventory' ? '현재 상태 확인 필요' : '게시 확인',
        '내용 비교': '미확인', '저장 내용과 다른 항목': '', '메모': PRESENCE_NOTE, '상태': '지원 완료',
        '저장 내용의 조회 시각': '2026-09-26T02:00:00.000Z',
      })
      if (failure === 'detail') expect(rows.find(row => row['포지션'] === PRESENCE_TITLES.saved)?.['공고 내용 확인 시각']).toBe(bodyTime)
      expect(rows.find(row => row['포지션'] === PRESENCE_TITLES.outside)?.['공고 내용 확인 시각']).toBe('')
      expect(await readSaved(page)).toEqual(before)
      await audit(page, server, `full-${failure}-failed-${width}`)
      await page.goto('about:blank')
      await server.stop()
      await server.start()
      await server.verifyProductionBytes()
      await page.goto(`${server.origin}/#saved`)
      await expect(page.locator('.posting-notice.unchecked')).toHaveCount(3)
      const restarted = await check(page)
      expect(restarted.boards[0]).toEqual(failed.boards[0])
      await assertTraffic(server, 6, failure === 'inventory' ? 2 : 4)
      await advance(page, server, 120_000)
      await server.respond(presenceResponses({ changed: true }))
      const recovered = await checkContent(page)
      expect(recovered.boards[0].status).toBe('ok')
      expect(recovered.boards[0].listing.content.status).toBe('ok')
      expect(recovered.boards[0].listing.content.checkedAt > bodyTime).toBe(true)
      await expect(page.locator('.posting-current-title')).toHaveText('현재 포지션: Staff Backend Engineer — Harbour Relay')
      await expect(page.locator('.posting-changes')).toHaveText('포지션 · 기술·경력·언어 · 본문 확인 필요')
      await assertTraffic(server, 9, failure === 'inventory' ? 4 : 6)
      expect(await readSaved(page)).toEqual(before)
      await writeFile(path.join(server.directory, 'full-failure-distinction.json'), JSON.stringify({
        failure, first, failed, restarted, recovered, before, failedCache, requests: await server.requests(),
      }, null, 2))
    } finally { await page.close(); await server.stop() }
  })

  test('explicit catalog refresh still collects changed bodies while a newly saved opportunity and search state survive', async ({ page, baseURL }, info) => {
    test.setTimeout(60000)
    const server = await fixture(page, info, baseURL)
    try {
      await server.start()
      const records = presenceSaved()
      records[0].note = PRESENCE_NOTE
      records[0].status = 'applied'
      await seed(page, server.origin, records)
      const oldSaved = await readSaved(page)
      await navigation(page).getByRole('button', { name: '기회 탐색', exact: true }).click()
      await page.getByRole('button', { name: '샘플 탐색', exact: true }).click()
      await page.getByRole('button', { name: /공개 채용공고/ }).click()
      await expect(page.getByRole('button', { name: '공개 채용', exact: true })).toBeVisible()
      if (await page.getByRole('dialog').count()) await page.getByRole('button', { name: '닫기', exact: true }).click()
      await expect(explorationSearch(page)).toHaveValue('Harbour Relay')
      await expect(page.locator('.mini-job-title')).toHaveText(['Backend Engineer — Harbour Relay'])
      await assertTraffic(server, 3, 2)
      const originalCatalog = await publicCatalog(page, server)
      expect(originalCatalog.jobs.map(job => job.title)).toEqual(['Backend Engineer — Harbour Relay', 'Frontend Engineer — Harbour Console'])
      expect(originalCatalog.jobs.find(job => job.id === 'smartrecruiters-presence-harbour-59001')?.description).toBe(PRESENCE_ORIGINAL_BODY)
      await explorationSearch(page).fill('Harbour Console')
      await expect(page.locator('.mini-job-title')).toHaveText(['Frontend Engineer — Harbour Console'])
      await page.locator('.mini-job-title').click()
      await page.getByRole('button', { name: '기회 저장', exact: true }).click()
      await page.getByLabel('이 기회에 대한 나의 메모', { exact: true }).fill('새 가상 지원 기록: Console 화면에서 저장')
      await page.getByRole('button', { name: '지원 완료로 표시', exact: true }).click()
      await page.keyboard.press('Escape')
      const before = await readSaved(page)
      expect(before).toHaveLength(4)
      expect(before.find(record => record.job.id === 'smartrecruiters-presence-harbour-59101')).toMatchObject({
        job: {
          title: 'Frontend Engineer — Harbour Console',
          description: 'Responsibilities\nBuild a fictional console with TypeScript and React.\n\nMinimum requirements\n3 years of software engineering experience.',
        }, status: 'applied', note: '새 가상 지원 기록: Console 화면에서 저장',
      })
      await server.respond(presenceResponses({ changed: true }))
      await advance(page, server, 61_000)
      await page.getByRole('button', { name: '공개 채용', exact: true }).click()
      const refresh = page.waitForResponse(response => new URL(response.url()).pathname === '/api/catalog' && new URL(response.url()).searchParams.get('refresh') === '1')
      await page.locator('.board-heading').getByRole('button', { name: /^새로고침/ }).click()
      expect([200, 202]).toContain((await refresh).status())
      await expect(page.getByRole('button', { name: '공개 채용', exact: true })).toBeVisible()
      await page.getByRole('button', { name: '닫기', exact: true }).click()
      await expect(explorationSearch(page)).toHaveValue('Harbour Console')
      await expect(page.locator('.mini-job-title')).toHaveText(['Frontend Engineer — Harbour Console'])
      await assertTraffic(server, 6, 4)
      const refreshedCatalog = await publicCatalog(page, server)
      expect(refreshedCatalog.jobs.find(job => job.id === 'smartrecruiters-presence-harbour-59001')).toMatchObject({
        title: 'Staff Backend Engineer — Harbour Relay', description: PRESENCE_CHANGED_BODY,
      })
      await explorationSearch(page).fill('Staff')
      await expect(page.locator('.mini-job-title')).toHaveText(['Staff Backend Engineer — Harbour Relay'])
      await navigation(page).getByRole('button', { name: /^저장한 기회/ }).click()
      await expect(page.locator('.saved-card')).toHaveCount(4)
      await check(page)
      await assertTraffic(server, 6, 4)
      await expect(card(page, PRESENCE_TITLES.saved).locator('.posting-changes')).toHaveText('포지션 · 기술·경력·언어 · 본문 확인 필요')
      await postingFilter(page).selectOption('changed')
      await expect(page.locator('.saved-title')).toHaveText(['Backend Engineer — Harbour Relay'])
      expect(await readSaved(page)).toEqual(before)
      expect((await readSaved(page)).filter(record => record.job.id !== 'smartrecruiters-presence-harbour-59101')).toEqual(oldSaved)
      const rows = await exportRows(page, server, 'catalog-refresh-preserves-saved.csv')
      expect(rows).toHaveLength(4)
      expect(rows.find(row => row['포지션'] === PRESENCE_TITLES.saved)?.['내용 비교']).toBe('차이 있음')
      expect(rows.find(row => row['포지션'] === PRESENCE_TITLES.second)).toMatchObject({
        '상태': '지원 완료', '메모': '새 가상 지원 기록: Console 화면에서 저장', '내용 비교': '표시 내용 일치',
      })
      await writeFile(path.join(server.directory, 'catalog-body-refresh.json'), JSON.stringify({
        originalCatalog, refreshedCatalog, before, requests: await server.requests(),
      }, null, 2))
      await page.reload()
      await expect(page.locator('.saved-card')).toHaveCount(4)
      expect(await readSaved(page)).toEqual(before)
      await assertTraffic(server, 6, 4)
    } finally { await page.close(); await server.stop() }
  })

  test('the thirteenth content-unknown result keeps its note, then full content shrinks the filter to twelve and clamps the page without truncating export', async ({ page, baseURL }, info) => {
    test.setTimeout(60000)
    const server = await fixture(page, info, baseURL)
    try {
      await server.start()
      await seed(page, server.origin, presencePagedSaved(), 'sample', 12)
      await expect(page.locator('.saved-results-summary')).toHaveText('13개 기회 중 1–12개 표시')
      await check(page)
      await assertTraffic(server, 3, 0)
      await postingFilter(page).selectOption('content-unknown')
      await expect(page.locator('.posting-summary')).toHaveText('게시 확인 13내용 차이 0내용 미확인 13목록에서 미확인 0확인 필요 0')
      await page.getByRole('navigation', { name: '저장한 기회 페이지 이동 (위)', exact: true })
        .getByRole('button', { name: '다음 저장 페이지', exact: true }).click()
      await expect(page.locator('.saved-title')).toHaveText(['Account Executive — Harbour Fictional 13'])
      await expect(page.locator('.saved-results-summary')).toHaveText('13개 기회 중 13–13개 표시')
      await page.locator('.saved-title').click()
      await page.getByLabel('이 기회에 대한 나의 메모', { exact: true }).fill('가상 마지막 페이지 메모 보존 13')
      await page.getByRole('button', { name: '지원 완료로 표시', exact: true }).click()
      await page.keyboard.press('Escape')
      await expect(page.locator('.saved-title')).toHaveText(['Account Executive — Harbour Fictional 13'])
      const before = await readSaved(page)
      expect(before).toHaveLength(13)
      const full = await checkContent(page)
      await assertTraffic(server, 6, 2)
      await expect(postingFilter(page)).toHaveValue('content-unknown')
      await expect(page.locator('.saved-results-summary')).toHaveText('12개 기회 중 1–12개 표시')
      await expect(page.locator('.saved-card')).toHaveCount(12)
      await expect(page.locator('.saved-title').first()).toHaveText('Account Executive — Harbour Fictional 2')
      await expect(page.locator('.saved-title').last()).toHaveText('Account Executive — Harbour Fictional 13')
      await expect(page.locator('.saved-pagination')).toHaveCount(0)
      await audit(page, server, `content-unknown-page-clamp-${width}`)
      const rows = await exportRows(page, server, 'filtered-content-unknown-all-pages.csv')
      expect(rows).toHaveLength(13)
      expect(rows.find(row => row['포지션'] === 'Backend Engineer — Harbour Relay')).toMatchObject({
        '공개 게시 상태': '게시 확인', '내용 비교': '표시 내용 일치',
        '공고 내용 확인 시각': full.boards[0].listing.content.checkedAt,
      })
      expect(rows.find(row => row['포지션'] === 'Account Executive — Harbour Fictional 13')).toMatchObject({
        '공개 게시 상태': '게시 확인', '내용 비교': '미확인', '공고 내용 확인 시각': '',
        '메모': '가상 마지막 페이지 메모 보존 13', '상태': '지원 완료', '저장일': '2026-09-26T02:05:00.000Z',
      })
      expect(rows.filter(row => row['포지션'] !== 'Backend Engineer — Harbour Relay').map(row => row['공고 내용 확인 시각'])).toEqual([
        '', '', '', '', '', '', '', '', '', '', '', '',
      ])
      expect(await readSaved(page)).toEqual(before)
      await page.reload()
      await expect(page.locator('.saved-card')).toHaveCount(12)
      await expect(page.locator('.saved-results-summary')).toHaveText('13개 기회 중 1–12개 표시')
      expect(await readSaved(page)).toEqual(before)
      await assertTraffic(server, 6, 2)
    } finally { await page.close(); await server.stop() }
  })
})

test('opening saved records with public exploration selected does not start catalog collection or post private edits', async ({ page, baseURL }, info) => {
  test.setTimeout(60000)
  const server = await fixture(page, info, baseURL)
  const traffic = watchApiRequests(page)
  try {
    await server.start()
    await seed(page, server.origin, presenceSaved(), 'public')
    await page.getByRole('button', { name: PRESENCE_TITLES.saved, exact: true }).click()
    await page.getByLabel('이 기회에 대한 나의 메모', { exact: true }).fill(PRESENCE_NOTE)
    await page.getByRole('button', { name: '지원 완료로 표시', exact: true }).click()
    await page.keyboard.press('Escape')
    preservedSaved(await readSaved(page))
    await writeFile(path.join(server.directory, 'public-source-saved-idle.json'), JSON.stringify({
      traffic: traffic.requests, upstream: await server.requests(), saved: await readSaved(page),
    }, null, 2))
    expect.soft(traffic.requests, 'Opening saved records and writing notes must not initiate public API collection').toEqual([])
    expect.soft(await server.requests(), 'A saved-only visit must not initiate external board traffic').toEqual([])
    await page.reload()
    await expect(page.locator('.saved-card')).toHaveCount(3)
    preservedSaved(await readSaved(page))
    expect.soft(traffic.requests, 'Reloading the saved route keeps collection explicit').toEqual([])
    await page.evaluate(() => {
      window.dispatchEvent(new Event('focus'))
      window.dispatchEvent(new Event('online'))
      window.dispatchEvent(new PageTransitionEvent('pageshow'))
      document.dispatchEvent(new Event('visibilitychange'))
    })
    expect(traffic.requests).toEqual([])
    expect(await server.requests()).toEqual([])
    await navigation(page).getByRole('button', { name: '기회 탐색', exact: true }).click()
    await expect(page.getByRole('button', { name: '공개 채용', exact: true })).toBeVisible()
    await expect(page.locator('.mini-job-title')).toHaveText(['Backend Engineer — Harbour Relay'])
    await expect(explorationSearch(page)).toHaveValue('Harbour Relay')
    await assertTraffic(server, 3, 2)
    expect(traffic.catalog()).toHaveLength(1)
    expect(traffic.catalog()[0]).toMatchObject({
      url: `${server.origin}/api/catalog?source=public`, method: 'GET', body: null, state: 'finished',
    })
    await navigation(page).getByRole('button', { name: /^저장한 기회/ }).click()
    await expect(page.locator('.saved-card')).toHaveCount(3)
    const beforeFocus = structuredClone(traffic.requests)
    await advance(page, server, 31 * 60_000)
    await page.evaluate(() => {
      window.dispatchEvent(new Event('focus'))
      window.dispatchEvent(new Event('online'))
      window.dispatchEvent(new PageTransitionEvent('pageshow'))
      document.dispatchEvent(new Event('visibilitychange'))
    })
    expect(traffic.requests).toEqual(beforeFocus)
    await assertTraffic(server, 3, 2)
    await navigation(page).getByRole('button', { name: '기회 탐색', exact: true }).click()
    await expect(page.getByRole('button', { name: '공개 채용', exact: true })).toBeVisible()
    await expect(page.locator('.mini-job-title')).toHaveText(['Backend Engineer — Harbour Relay'])
    await assertTraffic(server, 6, 4)
    expect(traffic.catalog()).toHaveLength(2)
    preservedSaved(await readSaved(page))
    await writeFile(path.join(server.directory, 'saved-focus-return-explore.json'), JSON.stringify({
      traffic: traffic.requests, upstream: await server.requests(), saved: await readSaved(page),
    }, null, 2))
  } finally { await page.close(); await server.stop() }
})

test('simultaneous saved clients share one complete inventory and a server restart reuses only the separate presence cache', async ({ page, browser, baseURL }, info) => {
  const server = await fixture(page, info, baseURL)
  const secondContext = await browser.newContext({ viewport: { width: 1440, height: 960 } })
  const second = await secondContext.newPage()
  try {
    await server.respond(presenceResponses({ firstPageDelayMs: 750 }))
    await server.start()
    await Promise.all([seed(page, server.origin), seed(second, server.origin)])
    const [left, right] = await Promise.all([check(page), check(second)])
    expect(left.boards).toEqual(right.boards)
    await expect(page.locator('.posting-notice.listed')).toHaveCount(2)
    await expect(second.locator('.posting-notice.listed')).toHaveCount(2)
    await assertTraffic(server, 3, 0)
    const files = await server.cacheFiles()
    expect(files).toHaveLength(1)
    expect(files[0]).toMatch(/\.presence-v1\.json$/)
    const cacheFile = path.join(server.cwd, '.local', files[0])
    const cache = await readFile(cacheFile, 'utf8')
    expect(JSON.parse(cache)).toMatchObject({ version: 1, boards: [{ snapshot: { total: 201 } }] })
    expect(JSON.parse(cache).boards[0].snapshot).not.toHaveProperty('jobs')
    await Promise.all([page.goto('about:blank'), second.goto('about:blank')])
    await server.stop()
    await server.start()
    await page.goto(`${server.origin}/#saved`)
    await expect(page.locator('.posting-notice.unchecked')).toHaveCount(3)
    const restored = await check(page)
    expect(restored.boards).toEqual(left.boards)
    expect(restored.boards[0].listing.content).toBeUndefined()
    expect(restored.boards[0].listing.jobs).toEqual([])
    await assertTraffic(server, 3, 0)
    expect(await readFile(cacheFile, 'utf8')).toBe(cache)
    await writeFile(path.join(server.directory, 'shared-clients-restart.json'), JSON.stringify({ left, right, restored, requests: await server.requests() }, null, 2))
  } finally { await page.close(); await secondContext.close(); await server.stop() }
})

test('a last-page 429 retains unknown evidence across actions and restart, then recovers to an explicitly empty complete list', async ({ page, baseURL }, info) => {
  test.setTimeout(60000)
  const server = await fixture(page, info, baseURL)
  try {
    await server.start()
    await seed(page, server.origin)
    const before = await readSaved(page)
    const first = await check(page)
    await server.respond(presenceResponses({ scenario: 'last-page-429' }))
    await advance(page, server, 61_000)
    const failed = await check(page, '새로 확인')
    expect(failed.boards[0]).toMatchObject({ status: 'error', lastSuccessAt: first.boards[0].lastSuccessAt })
    expect(failed.boards[0].listing.publishedIds).toEqual(first.boards[0].listing.publishedIds)
    expect(failed.boards[0].retryAt).toBe(failed.contentRefreshAfter)
    await expect(page.locator('.posting-notice.unknown')).toHaveCount(3)
    await expect(page.locator('.posting-notice.missing, .posting-notice.listed')).toHaveCount(0)
    await expect(page.getByRole('button', { name: '공고 내용 확인', exact: true })).toBeDisabled()
    await assertTraffic(server, 6, 0)
    const blocked = await page.request.get(`${server.origin}/api/posting-status?refresh=1&content=1`)
    try { expect(blocked.status()).toBe(200) } finally { await blocked.dispose() }
    await assertTraffic(server, 6, 0)
    await page.goto('about:blank')
    await server.stop()
    await server.start()
    await page.goto(`${server.origin}/#saved`)
    const restored = await check(page)
    expect(restored.boards).toEqual(failed.boards)
    await expect(page.locator('.posting-notice.unknown')).toHaveCount(3)
    await advance(page, server, 570_000)
    const early = await page.request.get(`${server.origin}/api/posting-status?refresh=1`)
    try { expect((await early.json()).boards[0].status).toBe('error') } finally { await early.dispose() }
    await assertTraffic(server, 6, 0)
    await server.respond(presenceResponses({ scenario: 'empty' }))
    await advance(page, server, 60_000)
    const recovered = await check(page, '새로 확인')
    expect(recovered.boards[0]).toMatchObject({ status: 'ok', listing: { publishedIds: [], jobs: [] } })
    await expect(page.locator('.posting-notice.missing')).toHaveCount(3)
    await expect(page.locator('.posting-notice.unknown, .posting-notice.listed')).toHaveCount(0)
    await assertTraffic(server, 7, 0)
    expect(await readSaved(page)).toEqual(before)
    const rows = await exportRows(page, server, 'empty-after-retry.csv')
    expect(rows.map(row => row['공개 게시 상태'])).toEqual(['공개 목록에서 미확인', '공개 목록에서 미확인', '공개 목록에서 미확인'])
    await writeFile(path.join(server.directory, 'rate-limit-restart.json'), JSON.stringify({ first, failed, restored, recovered, requests: await server.requests() }, null, 2))
  } finally { await page.close(); await server.stop() }
})

for (const unpublishedDetail of ['inactive', 'internal'] as const) {
  test(`${unpublishedDetail} full-detail evidence remains unknown when a later summary reappears, including after restart`, async ({ page, baseURL }, info) => {
    const server = await fixture(page, info, baseURL)
    try {
      await server.respond(presenceResponses({ unpublishedDetail }))
      await server.start()
      await seed(page, server.origin)
      const before = await readSaved(page)
      const full = await checkContent(page)
      expect(full.boards[0].listing.publishedIds).not.toContain('smartrecruiters-presence-harbour-59001')
      await assertTraffic(server, 3, 2)
      expect((await server.requests()).filter(request => request.kind === 'detail').map(request => request.url)).toEqual(PRESENCE_DETAIL_URLS)
      await advance(page, server, 61_000)
      const listedAgain = await check(page, '새로 확인')
      expect(listedAgain.boards[0].listing.publishedIds).toContain('smartrecruiters-presence-harbour-59001')
      expect(listedAgain.boards[0].listing.unconfirmedIds).toEqual(['smartrecruiters-presence-harbour-59001'])
      await expect(card(page, PRESENCE_TITLES.saved).locator('.posting-notice')).toHaveClass(/unknown/)
      await expect(card(page, PRESENCE_TITLES.saved).locator('.posting-notice')).toContainText('공개 목록과 마지막 본문의 게시 상태가 달라요.')
      await expect(page.locator('.posting-notice.listed')).toHaveCount(1)
      await expect(page.locator('.posting-notice.missing')).toHaveCount(1)
      await assertTraffic(server, 6, 2)
      await page.goto('about:blank')
      await server.stop()
      await server.start()
      await page.goto(`${server.origin}/#saved`)
      const restored = await check(page)
      expect(restored.boards[0].listing.unconfirmedIds).toEqual(['smartrecruiters-presence-harbour-59001'])
      await expect(card(page, PRESENCE_TITLES.saved).locator('.posting-notice')).toHaveClass(/unknown/)
      await assertTraffic(server, 6, 2)
      await server.respond(presenceResponses({ outsidePrimary: true }))
      await advance(page, server, 61_000)
      const outside = await checkContent(page)
      expect(outside.boards[0].listing.unconfirmedIds).toEqual(['smartrecruiters-presence-harbour-59001'])
      await expect(card(page, PRESENCE_TITLES.saved).locator('.posting-notice')).toHaveClass(/unknown/)
      await assertTraffic(server, 9, 3)
      expect((await server.requests()).slice(-4).map(request => request.url)).toEqual([
        ...PRESENCE_PAGE_URLS, 'https://api.smartrecruiters.com/v1/companies/HarbourPresence59/postings/59101',
      ])
      await page.goto('about:blank')
      await server.stop()
      await server.start()
      await page.goto(`${server.origin}/#saved`)
      const outsideRestart = await check(page)
      expect(outsideRestart.boards[0].listing.unconfirmedIds).toEqual(['smartrecruiters-presence-harbour-59001'])
      await expect(card(page, PRESENCE_TITLES.saved).locator('.posting-notice')).toHaveClass(/unknown/)
      await assertTraffic(server, 9, 3)
      await server.respond(presenceResponses())
      await advance(page, server, 61_000)
      const reactivated = await checkContent(page)
      expect(reactivated.boards[0].listing.unconfirmedIds).toBeUndefined()
      await expect(card(page, PRESENCE_TITLES.saved).locator('.posting-notice')).toHaveClass(/listed/)
      await expect(page.locator('.posting-notice.listed')).toHaveCount(2)
      await assertTraffic(server, 12, 5)
      expect(await readSaved(page)).toEqual(before)
      await writeFile(path.join(server.directory, 'negative-detail-restart.json'), JSON.stringify({ unpublishedDetail, full, listedAgain, restored, outside, outsideRestart, reactivated, requests: await server.requests() }, null, 2))
    } finally { await page.close(); await server.stop() }
  })
}

test('real browser HTTP revalidation and 304 responses never renew either evidence clock or silently revive expired saved status', async ({ page, baseURL }, info) => {
  const server = await fixture(page, info, baseURL)
  const responses = async () => (await server.events()).filter(event => event.event === 'http-response')
  try {
    await server.start()
    await seed(page, server.origin)
    const before = await readSaved(page)
    await check(page)
    const full = await checkContent(page)
    await assertTraffic(server, 6, 2)
    await page.reload()
    const warm = await check(page)
    expect(warm.boards).toEqual(full.boards)
    await page.reload()
    const revalidated = await check(page)
    expect(revalidated).toEqual(warm)
    await expect.poll(async () => (await responses()).filter(response => response.status === 304).length).toBe(1)
    await page.clock.fastForward(31 * 60_000)
    await expect(page.locator('.posting-notice.unknown')).toHaveCount(3)
    const expired = await check(page, '새로 확인')
    expect(expired).toEqual(warm)
    await expect(page.locator('.posting-notice.unknown')).toHaveCount(3)
    await expect(page.locator('.posting-notice.listed, .posting-notice.missing')).toHaveCount(0)
    await expect.poll(async () => (await responses()).filter(response => response.status === 304).length).toBe(2)
    await assertTraffic(server, 6, 2)
    expect(await readSaved(page)).toEqual(before)
    const wire = await responses()
    expect(wire.map(response => response.status)).toEqual([200, 200, 200, 304, 304])
    expect(wire[3].ifNoneMatch).toBe(wire[2].etag)
    expect(wire[4].ifNoneMatch).toBe(wire[2].etag)
    await writeFile(path.join(server.directory, 'http-304-evidence.json'), JSON.stringify({ full, warm, revalidated, expired, wire, requests: await server.requests() }, null, 2))
  } finally {
    await writeFile(path.join(server.directory, 'http-wire.json'), JSON.stringify(await responses(), null, 2))
    await page.close()
    await server.stop()
  }
})

test.describe('incomplete presence evidence', () => {
  for (const scenario of ['partial-final', 'duplicate-page', 'total-shift', 'foreign-company', 'internal-row', 'last-page-503', 'last-page-429', 'last-page-network'] as const) {
    test(`${scenario} leaves every saved posting unknown and never declares an ID missing`, async ({ page, baseURL }, info) => {
      const server = await fixture(page, info, baseURL, scenario)
      try {
        await server.start()
        await seed(page, server.origin)
        const before = await readSaved(page)
        const index = await check(page)
        await writeFile(path.join(server.directory, 'failed-presence-check.json'), JSON.stringify({ scenario, index, requests: await server.requests() }, null, 2))
        await expect(page.locator('.posting-notice.unknown')).toHaveCount(3)
        await expect(page.locator('.posting-notice.listed, .posting-notice.missing')).toHaveCount(0)
        await expect(page.locator('.posting-summary')).toHaveText('게시 확인 0내용 차이 0목록에서 미확인 0확인 필요 3')
        expect(await readSaved(page)).toEqual(before)
        expect((await server.requests()).filter(request => request.kind === 'detail')).toEqual([])
        const rows = await exportRows(page, server, 'unknown-export.csv')
        expect(rows.map(row => row['공개 게시 상태'])).toEqual(['현재 상태 확인 필요', '현재 상태 확인 필요', '현재 상태 확인 필요'])
        expect(rows.map(row => row['내용 비교'])).toEqual(['미확인', '미확인', '미확인'])
        expect(index.boards[0].status).toBe('error')
        expect(index.boards[0].lastSuccessAt).toBeNull()
        expect(index.boards[0].listing).toBeUndefined()
        const requests = await server.requests()
        await page.reload()
        await expect(page.locator('.posting-notice.unchecked')).toHaveCount(3)
        await check(page)
        await expect(page.locator('.posting-notice.unknown')).toHaveCount(3)
        expect(await server.requests()).toEqual(requests)
        if (scenario === 'last-page-429') {
          expect(Date.parse(index.boards[0].retryAt) - Date.parse(index.boards[0].checkedAt)).toBeGreaterThanOrEqual(600_000)
          expect(requests.filter(request => request.kind === 'list').map(request => request.url)).toEqual(PRESENCE_PAGE_URLS)
        }
      } finally { await page.close(); await server.stop() }
    })
  }
})
