import { expect } from '@playwright/test'
import type { Page, TestInfo } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ObservationHistory } from '../../shared/catalog-observations'
import type { PostingStatusIndex } from '../../shared/posting-status'
import { DEFAULT_FILTERS } from '../../shared/types'
import type { Catalog, SavedJob } from '../../shared/types'
import {
  PROVENANCE_BASE, PROVENANCE_NOTE, PROVENANCE_REGISTRATIONS, PROVENANCE_TITLES, PROVENANCE_URLS, provenanceResponses, provenanceSaved,
} from '../fixtures/board-status-provenance'
import type { PresenceResponses } from '../fixtures/posting-presence'
import { createPostingPresenceServer } from '../fixtures/posting-presence-server'
import { readServerMode, watchApiRequests } from './helpers/api-requests'
import { resourceCheckedTest as test } from './helpers/public-app'
import { readSaved, waitForSavedCommit } from './helpers/saved-store'

/**
 * The real product server with two fictional companies and synthetic upstream
 * responses. Expected rows are literal; request counts come from the fixture's
 * upstream log. Artifacts stay under the stage74 independent directory.
 */
type Server = Awaited<ReturnType<typeof createPostingPresenceServer>>
const repository = fileURLToPath(new URL('../../', import.meta.url))
const PROVENANCE_PRIVATE_ROOT = path.join(repository, '.local/research/74/independent')
const runId = `${new Date().toISOString().replaceAll(/[:.]/g, '-')}-${process.pid}`
const ALDER = 'provenance-alder'
const BIRCH = 'provenance-birch'
const birchIdentity = { companyId: BIRCH, board: 'BirchProvenance74', provider: 'smartrecruiters' } as const

const navigation = (page: Page) => page.getByRole('navigation', { name: '주요 메뉴' })
const search = (page: Page) => page.getByRole('textbox', { name: '도시, 회사 또는 포지션 검색', exact: true })
const row = (page: Page, company: string) => page.getByRole('dialog').locator('.board-row').filter({ hasText: company })
const lastSuccess = (page: Page, company: string) => row(page, company).locator('p').filter({ hasText: '마지막 정상 확인' }).locator('time')

async function fixture(page: Page, info: TestInfo, baseURL: string | undefined, responses: PresenceResponses) {
  const mode = await readServerMode(page.request, `${baseURL}/api/health`)
  const directory = path.join(PROVENANCE_PRIVATE_ROOT, 'runs', runId, `${mode}-${info.titlePath.join('-').replaceAll(/[^a-zA-Z0-9-]/g, '-').slice(-160)}`)
  return createPostingPresenceServer(directory, mode, {
    root: PROVENANCE_PRIVATE_ROOT, clock: PROVENANCE_BASE, companies: [...PROVENANCE_REGISTRATIONS], responses,
  })
}
async function seed(page: Page, origin: string, options: { saved: SavedJob[]; query: string; view: 'saved' | 'explore' }) {
  await page.clock.install({ time: new Date(PROVENANCE_BASE) })
  await page.addInitScript(({ origin, saved, filters, query }) => {
    if (location.origin !== origin || sessionStorage.getItem('provenance-seeded')) return
    localStorage.setItem('orbit.v1.saved', JSON.stringify(saved))
    localStorage.setItem('orbit.v1.exploration', JSON.stringify({
      source: 'public', selectedId: 'london', mapMode: 'flat', panelTab: 'cities', filters: { ...filters, query },
    }))
    sessionStorage.setItem('provenance-seeded', 'true')
  }, { origin, saved: options.saved, filters: DEFAULT_FILTERS, query: options.query })
  await page.goto(options.view === 'saved' ? `${origin}/#saved` : origin)
}
async function check(page: Page, name = '게시 상태 확인'): Promise<PostingStatusIndex> {
  const response = page.waitForResponse(response => {
    const url = new URL(response.url())
    return url.pathname === '/api/posting-status' && !url.searchParams.has('content')
  })
  await page.getByRole('button', { name, exact: true }).click()
  const result = await response
  expect(result.status()).toBe(200)
  const data = await result.json() as PostingStatusIndex
  await expect(page.getByRole('button', { name: '새로 확인', exact: true })).toBeVisible()
  return data
}
async function json<T>(page: Page, origin: string, route: string): Promise<T> {
  const response = await page.request.get(`${origin}${route}`)
  try {
    expect(response.status(), `${route} must answer through the real successful route`).toBe(200)
    return await response.json() as T
  } finally { await response.dispose() }
}
const catalogOf = (page: Page, origin: string) => json<Catalog>(page, origin, '/api/catalog?source=public')
const indexOf = (page: Page, origin: string) => json<PostingStatusIndex>(page, origin, '/api/posting-status')
const historyOf = (page: Page, origin: string) => json<ObservationHistory>(page, origin, '/api/observations')
const urls = async (server: Server) => (await server.requests()).map(request => request.url)
const count = (list: string[], url: string) => list.filter(item => item === url).length
/**
 * The 600-second Retry-After is parsed when the upstream 429 arrives. The fixture
 * logs that request, its 429 response and the finished posting-status response on
 * the same shifted clock the product uses, so the deadline must sit inside that
 * observed window instead of an arbitrary tolerance.
 */
async function expectTenMinuteWait(server: Server, board: { checkedAt: string; retryAt: string | null }, listUrl: string) {
  const events = await server.events()
  const request = events.filter(event => event.event === 'request' && event.url === listUrl).at(-1)
  expect(request).toBeDefined()
  const response = events.find(event => event.event === 'response' && event.sequence === request!.sequence)
  expect(response).toMatchObject({ status: 429 })
  const answered = events.filter(event => event.event === 'http-response'
    && String(event.path).startsWith('/api/posting-status') && event.status === 200).at(-1)
  expect(answered).toBeDefined()
  const requestedAt = Date.parse(String(request!.at))
  const respondedAt = Date.parse(String(response!.at))
  const answeredAt = Date.parse(String(answered!.at))
  expect(Date.parse(board.checkedAt)).toBeLessThanOrEqual(requestedAt)
  expect(requestedAt).toBeLessThanOrEqual(respondedAt)
  expect(Date.parse(board.retryAt!)).toBeGreaterThanOrEqual(respondedAt + 600_000)
  expect(Date.parse(board.retryAt!)).toBeLessThanOrEqual(answeredAt + 600_000)
}
function ordinaryCatalog(page: Page) {
  return page.waitForResponse(response => {
    const url = new URL(response.url())
    return url.pathname === '/api/catalog' && !url.searchParams.has('refresh')
  })
}
async function advance(page: Page, server: Server, milliseconds: number) {
  await server.advance(milliseconds)
  await page.clock.fastForward(milliseconds)
}
function forcedRefresh(page: Page) {
  return page.waitForResponse(response => {
    const url = new URL(response.url())
    return url.pathname === '/api/catalog' && url.searchParams.get('refresh') === '1'
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
function assertPrivateTraffic(traffic: ReturnType<typeof watchApiRequests>) {
  for (const request of traffic.requests) {
    expect(request.method).toBe('GET')
    expect(request.body).toBeNull()
    expect(request.url).not.toContain(encodeURIComponent(PROVENANCE_NOTE))
  }
  expect(JSON.stringify(traffic.requests)).not.toContain(PROVENANCE_NOTE)
}

for (const width of [1440, 320]) test.describe(`deferred public-list failure on the real server at ${width}px`, () => {
  test.use({ viewport: { width, height: 960 }, isMobile: width === 320, hasTouch: width === 320 })

  test('a saved-page list failure defers one company; the catalog reports it truthfully through refresh, restart and recovery', async ({ page, baseURL }, info) => {
    test.setTimeout(150_000)
    const server = await fixture(page, info, baseURL, provenanceResponses({ birch: 'rate-limited' }))
    const traffic = watchApiRequests(page)
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    try {
      await server.start()
      await server.verifyProductionBytes()
      await seed(page, server.origin, { saved: provenanceSaved('alder'), query: 'Alder', view: 'saved' })
      await expect(page.locator('.saved-card')).toHaveCount(1)
      await waitForSavedCommit(page)
      const savedBefore = await readSaved(page)
      expect(await server.requests()).toEqual([])

      // The public-list check fails for Birch only, with a ten-minute Retry-After.
      const index = await check(page)
      const birchIndex = index.boards.find(board => board.companyId === BIRCH)!
      expect(index.boards.find(board => board.companyId === ALDER)).toMatchObject({ status: 'ok', listing: { publishedIds: ['greenhouse-provenance-alder-7401'] } })
      expect(birchIndex).toMatchObject({ status: 'error', message: 'HTTP 429', lastSuccessAt: null })
      expect(birchIndex.listing).toBeUndefined()
      await expectTenMinuteWait(server, birchIndex, PROVENANCE_URLS.birchList)
      expect([...await urls(server)].sort()).toEqual([PROVENANCE_URLS.alderPresence, PROVENANCE_URLS.birchList].sort())
      await expect(page.locator('.posting-notice.listed')).toHaveCount(1)

      // Exploration collects Alder only. Birch is a settled error, never pending, and never requested.
      await navigation(page).getByRole('button', { name: '기회 탐색', exact: true }).click()
      await expect(page.locator('.mini-job-title')).toHaveText([PROVENANCE_TITLES.alder], { timeout: 30_000 })
      await expect(page.getByRole('button', { name: '공개 채용', exact: true })).toBeVisible()
      expect(await urls(server)).toHaveLength(3)
      expect(count(await urls(server), PROVENANCE_URLS.alderContent)).toBe(1)
      const catalog = await catalogOf(page, server.origin)
      const [alderRow, birchRow] = catalog.boards
      expect(alderRow).toMatchObject({ companyId: ALDER, status: 'ok', dataStatus: 'fresh', total: 1, included: 1, retryAt: null })
      expect(alderRow.lastSuccessAt).toBe(alderRow.checkedAt)
      expect(birchRow).toEqual({
        ...birchIdentity, status: 'error', dataStatus: 'unavailable', total: 0, included: 0,
        checkedAt: birchIndex.checkedAt, lastSuccessAt: null, retryAt: birchIndex.retryAt, message: 'HTTP 429',
      })
      expect(catalog).toMatchObject({ fetchedAt: alderRow.lastSuccessAt, checkedAt: alderRow.checkedAt, stale: false })
      expect(Date.parse(catalog.checkedAt!)).toBeGreaterThanOrEqual(Date.parse(birchRow.checkedAt!))
      expect(catalog.jobs.map(job => [job.companyId, job.stale])).toEqual([[ALDER, false]])
      await expect(page.locator('.catalog-notice')).toContainText('일부 게시판의 최신 공고를 확인하지 못했어요.')
      await expect(page.locator('.catalog-notice')).toContainText('이전 조회 공고 0개를 포함합니다. 1개 회사는 확인 가능한 공고가 없어요.')
      await expect(page.locator('.panel-data-footer')).toContainText('일부 게시판 · 조회 상태 확인')
      await expect(search(page)).toHaveValue('Alder')

      // Company history rows show the failure's own attempt and retry times and no borrowed success.
      await page.getByRole('button', { name: '공개 채용', exact: true }).click()
      const dialog = page.getByRole('dialog')
      await expect(row(page, 'Birch Signal')).toContainText('데이터 미확인')
      await expect(lastSuccess(page, 'Birch Signal')).toHaveText('확인 기록 없음')
      expect(await lastSuccess(page, 'Birch Signal').getAttribute('datetime')).toBeNull()
      await expect(row(page, 'Birch Signal').locator('.board-error-detail')).toContainText('재조회 실패 · HTTP 429')
      await expect(row(page, 'Birch Signal').locator('.board-error-detail time')).toHaveAttribute('datetime', birchRow.retryAt!)
      await expect(row(page, 'Alder Forge')).toContainText('1개 반영')
      await expect(lastSuccess(page, 'Alder Forge')).toHaveAttribute('datetime', alderRow.lastSuccessAt!)
      await expect(dialog.locator('.collection-health dd')).toHaveText(['1개 공고', '0개 공고', '1개'])
      await expect(dialog.locator('.board-section .field-description')).toContainText('최근 게시판 조회 시도')
      await audit(page, server, `deferred-${width}`)

      // Content history never gained a Birch attempt from the list failure.
      const history = await historyOf(page, server.origin)
      expect(history.days).toHaveLength(1)
      expect(history.days[0].latest.boards).toEqual([
        { companyId: ALDER, status: 'complete', checkedAt: alderRow.checkedAt, lastSuccessAt: alderRow.lastSuccessAt },
        { companyId: BIRCH, status: 'missing', checkedAt: null, lastSuccessAt: null },
      ])
      expect(history.days[0].complete).toBeUndefined()

      // A manual refresh after Alder's own interval announces the accurate count and still skips Birch.
      await advance(page, server, 61_000)
      const refresh = dialog.locator('.board-heading').getByRole('button', { name: /^새로고침/ })
      await expect(refresh).toBeEnabled()
      const refreshed = forcedRefresh(page)
      await refresh.click()
      expect([200, 202]).toContain((await refreshed).status())
      await expect(page.locator('.toast')).toContainText('1개 게시판 연결 확인이 필요해요. 이전 조회 공고 0개를 유지했어요.')
      await expect.poll(async () => count(await urls(server), PROVENANCE_URLS.alderContent)).toBe(2)
      expect(count(await urls(server), PROVENANCE_URLS.birchList)).toBe(1)
      await expect(row(page, 'Birch Signal').locator('.board-error-detail')).toContainText('HTTP 429')
      await page.keyboard.press('Escape')
      await expect(page.getByRole('dialog')).toHaveCount(0)
      await expect(page.locator('.mini-job-title')).toHaveText([PROVENANCE_TITLES.alder])
      await expect(search(page)).toHaveValue('Alder')
      const beforeRestart = await catalogOf(page, server.origin)
      expect(beforeRestart.boards[1]).toEqual(birchRow)
      expect(Date.parse(beforeRestart.boards[0].lastSuccessAt!)).toBeGreaterThan(Date.parse(alderRow.lastSuccessAt!))

      // Restart: the deferred row comes back from the persisted list record without any provider request.
      await page.goto('about:blank')
      await server.stop()
      await server.start()
      await server.verifyProductionBytes()
      await page.goto(server.origin)
      await expect(page.locator('.mini-job-title')).toHaveText([PROVENANCE_TITLES.alder], { timeout: 30_000 })
      await expect(page.getByRole('button', { name: '공개 채용', exact: true })).toBeVisible()
      const restarted = await catalogOf(page, server.origin)
      expect(restarted.boards).toEqual(beforeRestart.boards)
      expect(restarted).toMatchObject({ fetchedAt: beforeRestart.fetchedAt, checkedAt: beforeRestart.checkedAt, stale: false })
      expect(await urls(server)).toHaveLength(4)
      expect(await readSaved(page)).toEqual(savedBefore)
      await expect(search(page)).toHaveValue('Alder')
      await expect(page.locator('.catalog-notice')).toContainText('1개 회사는 확인 가능한 공고가 없어요.')

      // At the shared deadline an authoritative empty list recovers Birch; the toast reports the fetched count.
      await server.respond(provenanceResponses({ birch: 'empty' }))
      await advance(page, server, 600_000)
      await page.getByRole('button', { name: '공개 채용', exact: true }).click()
      const recover = page.getByRole('dialog').locator('.board-heading').getByRole('button', { name: /^새로고침/ })
      await expect(recover).toBeEnabled()
      const recovering = forcedRefresh(page)
      await recover.click()
      expect([200, 202]).toContain((await recovering).status())
      await expect(page.locator('.toast')).toContainText('1개 개발·연구 공고를 가져왔어요.')
      await expect(row(page, 'Birch Signal')).toContainText('0개 반영')
      await expect(row(page, 'Birch Signal').locator('.board-error-detail')).toHaveCount(0)
      const recovered = await catalogOf(page, server.origin)
      expect(recovered.boards[1]).toMatchObject({ ...birchIdentity, status: 'ok', dataStatus: 'fresh', total: 0, included: 0, retryAt: null })
      expect(recovered.boards[1].message).toBeUndefined()
      expect(recovered.boards[1].lastSuccessAt).toBe(recovered.boards[1].checkedAt)
      expect(Date.parse(recovered.boards[1].checkedAt!)).toBeGreaterThanOrEqual(Date.parse(birchRow.retryAt!))
      await expect(lastSuccess(page, 'Birch Signal')).toHaveAttribute('datetime', recovered.boards[1].lastSuccessAt!)
      await expect(page.getByRole('dialog').locator('.collection-health dd')).toHaveText(['1개 공고', '0개 공고', '0개'])
      const finalIndex = await indexOf(page, server.origin)
      expect(finalIndex.boards.find(board => board.companyId === BIRCH)).toMatchObject({ status: 'ok', retryAt: null, listing: { publishedIds: [] } })
      expect(count(await urls(server), PROVENANCE_URLS.birchList)).toBe(2)
      expect(count(await urls(server), PROVENANCE_URLS.birchDetail)).toBe(0)
      expect(await urls(server)).toHaveLength(6)
      await page.keyboard.press('Escape')
      await expect(page.locator('.catalog-notice')).toHaveCount(0)
      expect(await readSaved(page)).toEqual(savedBefore)
      await expect(search(page)).toHaveValue('Alder')
      expect(JSON.parse(await page.evaluate(() => localStorage.getItem('orbit.v1.exploration') ?? '{}'))).toMatchObject({
        source: 'public', selectedId: 'london', filters: { query: 'Alder' },
      })
      const upstream = await server.requests()
      expect(upstream.every(request => request.synthetic && !request.networkSent && request.method === 'GET' && request.body === null)).toBe(true)
      assertPrivateTraffic(traffic)
      expect(errors).toEqual([])
      await writeFile(path.join(server.directory, 'deferred-list-failure.json'), JSON.stringify({
        index, catalog, history, beforeRestart, restarted, recovered, finalIndex, upstream, browser: traffic.requests, saved: savedBefore,
      }, null, 2))
    } finally {
      await page.close()
      await server.stop()
    }
  })

  test('a later list failure keeps young bodies as dated retained content and a real list success restores them without a body request', async ({ page, baseURL }, info) => {
    test.setTimeout(150_000)
    const server = await fixture(page, info, baseURL, provenanceResponses())
    const traffic = watchApiRequests(page)
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    try {
      await server.start()
      await server.verifyProductionBytes()
      await seed(page, server.origin, { saved: provenanceSaved('birch'), query: 'Birch', view: 'explore' })
      await expect(page.locator('.mini-job-title')).toHaveText([PROVENANCE_TITLES.birch], { timeout: 30_000 })
      await waitForSavedCommit(page)
      const savedBefore = await readSaved(page)
      expect([...await urls(server)].sort()).toEqual([PROVENANCE_URLS.alderContent, PROVENANCE_URLS.birchDetail, PROVENANCE_URLS.birchList].sort())
      const initial = await catalogOf(page, server.origin)
      expect(initial.boards.map(board => [board.companyId, board.status, board.dataStatus, board.included])).toEqual([
        [ALDER, 'ok', 'fresh', 1], [BIRCH, 'ok', 'fresh', 1],
      ])
      const bodyTime = initial.boards[1].lastSuccessAt!
      expect(initial.boards[1].checkedAt).toBe(bodyTime)
      await expect(page.locator('.catalog-notice')).toHaveCount(0)
      await expect(page.locator('.stale-job-badge')).toHaveCount(0)

      // Sixty-one seconds later the saved page's list check fails for Birch with a ten-minute Retry-After.
      await advance(page, server, 61_000)
      await server.respond(provenanceResponses({ birch: 'rate-limited' }))
      await navigation(page).getByRole('button', { name: /^저장한 기회/ }).click()
      await expect(page.locator('.saved-card')).toHaveCount(1)
      const failed = await check(page)
      const birchFailed = failed.boards.find(board => board.companyId === BIRCH)!
      expect(birchFailed).toMatchObject({ status: 'error', message: 'HTTP 429', lastSuccessAt: bodyTime })
      await expectTenMinuteWait(server, birchFailed, PROVENANCE_URLS.birchList)
      expect(await urls(server)).toHaveLength(5)
      await expect(page.locator('.posting-notice.unknown')).toHaveCount(1)

      // Returning to a still-fresh exploration view requests no catalog, so the new
      // list failure is not visible yet: status propagates only with a catalog response.
      const catalogRequests = traffic.catalog().length
      await navigation(page).getByRole('button', { name: '기회 탐색', exact: true }).click()
      await expect(page.locator('.mini-job-title')).toHaveText([PROVENANCE_TITLES.birch])
      await expect(page.getByRole('button', { name: '공개 채용', exact: true })).toBeVisible()
      expect(traffic.catalog()).toHaveLength(catalogRequests)
      await expect(page.locator('.stale-job-badge')).toHaveCount(0)
      // Reloading the page makes the app request an ordinary catalog. Nothing is due,
      // so the server answers from memory with no provider request and the same body times.
      const reloaded = ordinaryCatalog(page)
      await page.reload()
      expect((await reloaded).status()).toBe(200)
      await expect(page.locator('.mini-job-title')).toHaveText([PROVENANCE_TITLES.birch], { timeout: 30_000 })
      await expect(page.getByRole('button', { name: '공개 채용', exact: true })).toBeVisible()
      await waitForSavedCommit(page)
      await expect(page.locator('.stale-job-badge')).toHaveCount(1)
      await expect(page.locator('.catalog-notice')).toContainText('일부 게시판의 최신 공고를 확인하지 못했어요.')
      await expect(page.locator('.catalog-notice')).toContainText('이전 조회 공고 1개를 포함합니다.')
      const degraded = await catalogOf(page, server.origin)
      expect(degraded.boards[1]).toEqual({
        ...birchIdentity, status: 'error', dataStatus: 'stale', total: 1, included: 1,
        checkedAt: birchFailed.checkedAt, lastSuccessAt: bodyTime, retryAt: birchFailed.retryAt, message: 'HTTP 429',
      })
      expect(degraded.boards[0]).toEqual(initial.boards[0])
      expect(degraded.jobs.map(job => [job.id, job.fetchedAt, job.stale])).toEqual([
        [initial.jobs[0].id, initial.jobs[0].fetchedAt, false],
        ['smartrecruiters-provenance-birch-74001', bodyTime, true],
      ])
      expect(degraded).toMatchObject({ stale: true, fetchedAt: initial.fetchedAt, checkedAt: failed.checkedAt })
      expect(await urls(server)).toHaveLength(5)
      await page.locator('.mini-job-title').click()
      await expect(page.locator('.job-freshness-notice')).toContainText('이전 조회 결과를 보고 있어요')
      await expect(page.locator('.job-freshness-notice time')).toHaveAttribute('datetime', bodyTime)
      await page.getByRole('button', { name: '닫기', exact: true }).click()
      await page.getByRole('button', { name: '공개 채용', exact: true }).click()
      const dialog = page.getByRole('dialog')
      await expect(row(page, 'Birch Signal')).toContainText('이전 1개 유지')
      await expect(lastSuccess(page, 'Birch Signal')).toHaveAttribute('datetime', bodyTime)
      await expect(row(page, 'Birch Signal').locator('.board-error-detail')).toContainText('재조회 실패 · HTTP 429')
      await expect(row(page, 'Birch Signal').locator('.board-error-detail time')).toHaveAttribute('datetime', birchFailed.retryAt!)
      await expect(row(page, 'Alder Forge')).toContainText('1개 반영')
      await expect(dialog.locator('.collection-health dd')).toHaveText(['1개 공고', '1개 공고', '0개'])
      await audit(page, server, `retained-${width}`)

      // A manual refresh re-collects Alder, keeps Birch deferred, and announces the retained count.
      const refresh = dialog.locator('.board-heading').getByRole('button', { name: /^새로고침/ })
      await expect(refresh).toBeEnabled()
      const refreshed = forcedRefresh(page)
      await refresh.click()
      expect([200, 202]).toContain((await refreshed).status())
      await expect(page.locator('.toast')).toContainText('1개 게시판 연결 확인이 필요해요. 이전 조회 공고 1개를 유지했어요.')
      await expect.poll(async () => count(await urls(server), PROVENANCE_URLS.alderContent)).toBe(2)
      expect(count(await urls(server), PROVENANCE_URLS.birchList)).toBe(2)
      expect(count(await urls(server), PROVENANCE_URLS.birchDetail)).toBe(1)
      await expect(row(page, 'Birch Signal')).toContainText('이전 1개 유지')
      await page.keyboard.press('Escape')
      await expect(page.getByRole('dialog')).toHaveCount(0)

      // At the deadline a real list success restores fresh display; the body is neither refetched nor re-dated.
      await advance(page, server, 600_000)
      await server.respond(provenanceResponses())
      await navigation(page).getByRole('button', { name: /^저장한 기회/ }).click()
      await expect(page.locator('.saved-card')).toHaveCount(1)
      // The earlier page reload reset the in-memory status controller, so this is the
      // reloaded app's first check and its button reads 게시 상태 확인 again.
      const recoveredIndex = await check(page)
      const birchRecovered = recoveredIndex.boards.find(board => board.companyId === BIRCH)!
      expect(birchRecovered).toMatchObject({
        status: 'ok', retryAt: null,
        listing: { publishedIds: ['smartrecruiters-provenance-birch-74001'], content: { checkedAt: bodyTime, status: 'ok' } },
      })
      expect(birchRecovered.message).toBeUndefined()
      expect(Date.parse(birchRecovered.lastSuccessAt!)).toBeGreaterThanOrEqual(Date.parse(birchFailed.retryAt!))
      expect(count(await urls(server), PROVENANCE_URLS.birchList)).toBe(3)
      expect(count(await urls(server), PROVENANCE_URLS.birchDetail)).toBe(1)
      // Open exploration through a fresh page load and await the app's own ordinary
      // catalog response before reading the restored view.
      const restoring = ordinaryCatalog(page)
      await page.goto(server.origin)
      expect((await restoring).status()).toBe(200)
      await expect(page.locator('.mini-job-title')).toHaveText([PROVENANCE_TITLES.birch], { timeout: 30_000 })
      await expect(page.getByRole('button', { name: '공개 채용', exact: true })).toBeVisible()
      await waitForSavedCommit(page)
      await expect(page.locator('.stale-job-badge')).toHaveCount(0)
      await expect(page.locator('.catalog-notice')).toHaveCount(0)
      const restored = await catalogOf(page, server.origin)
      expect(restored.boards[1]).toEqual({
        ...birchIdentity, status: 'ok', dataStatus: 'fresh', total: 1, included: 1, checkedAt: bodyTime, lastSuccessAt: bodyTime, retryAt: null,
      })
      expect(restored.jobs.find(job => job.companyId === BIRCH)).toMatchObject({ fetchedAt: bodyTime, stale: false })
      expect(restored).toMatchObject({ stale: false, fetchedAt: restored.boards[0].lastSuccessAt, checkedAt: recoveredIndex.checkedAt })
      expect(count(await urls(server), PROVENANCE_URLS.birchDetail)).toBe(1)
      expect(count(await urls(server), PROVENANCE_URLS.birchList)).toBe(3)
      await page.getByRole('button', { name: '공개 채용', exact: true }).click()
      await expect(row(page, 'Birch Signal')).toContainText('1개 반영')
      await expect(row(page, 'Birch Signal').locator('.board-error-detail')).toHaveCount(0)
      await expect(lastSuccess(page, 'Birch Signal')).toHaveAttribute('datetime', bodyTime)
      await expect(page.getByRole('dialog').locator('.collection-health dd')).toHaveText(['2개 공고', '0개 공고', '0개'])
      await page.keyboard.press('Escape')
      expect(await readSaved(page)).toEqual(savedBefore)
      await expect(search(page)).toHaveValue('Birch')
      const upstream = await server.requests()
      expect(upstream.every(request => request.synthetic && !request.networkSent && request.method === 'GET' && request.body === null)).toBe(true)
      assertPrivateTraffic(traffic)
      expect(errors).toEqual([])
      await writeFile(path.join(server.directory, 'retained-body-list-failure.json'), JSON.stringify({
        initial, failed, degraded, recoveredIndex, restored, upstream, browser: traffic.requests, saved: savedBefore,
      }, null, 2))
    } finally {
      await page.close()
      await server.stop()
    }
  })
})
