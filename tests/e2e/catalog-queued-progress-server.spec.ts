import { expect } from '@playwright/test'
import type { Page, TestInfo } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_FILTERS } from '../../shared/types'
import type { Catalog, SavedJob } from '../../shared/types'
import {
  PROVENANCE_BASE, PROVENANCE_NOTE, PROVENANCE_REGISTRATIONS, PROVENANCE_TITLES, PROVENANCE_URLS, provenanceResponses, provenanceSaved,
} from '../fixtures/board-status-provenance'
import { QUEUED_PREFER, QUEUED_WAITING_LABEL } from '../fixtures/catalog-queued-progress'
import type { PresenceResponses } from '../fixtures/posting-presence'
import { createPostingPresenceServer } from '../fixtures/posting-presence-server'
import { readServerMode, watchApiRequests } from './helpers/api-requests'
import { resourceCheckedTest as test } from './helpers/public-app'
import { readSaved, waitForSavedCommit } from './helpers/saved-store'

/**
 * Stage75 contract: docs/design/catalog-queued-progress.md (9b921a49…feff9).
 * The real product server with two fictional companies and synthetic upstream
 * responses held behind named gates. Ordering is proven by the upstream log at
 * the moment the browser receives each response, never by elapsed time.
 * Artifacts stay under the stage75 independent directory.
 */
type Server = Awaited<ReturnType<typeof createPostingPresenceServer>>
type Event = { event: string } & Record<string, unknown>
const repository = fileURLToPath(new URL('../../', import.meta.url))
const QUEUED_PRIVATE_ROOT = path.join(repository, '.local/research/75/independent')
const runId = `${new Date().toISOString().replaceAll(/[:.]/g, '-')}-${process.pid}`
const ALDER = 'provenance-alder'
const BIRCH = 'provenance-birch'
const UUID = /^[a-f0-9-]{36}$/i
const WAITING = { phase: 'waiting-for-presence', total: null, completed: 0, done: false }

const navigation = (page: Page) => page.getByRole('navigation', { name: '주요 메뉴' })
const search = (page: Page) => page.getByRole('textbox', { name: '도시, 회사 또는 포지션 검색', exact: true })
const status = (page: Page) => page.getByRole('status').filter({ hasText: QUEUED_WAITING_LABEL })
const progressbar = (page: Page) => page.getByRole('progressbar', { name: '공개 게시판 조회 진행' })
const row = (page: Page, company: string) => page.getByRole('dialog').locator('.board-row').filter({ hasText: company })

async function fixture(page: Page, info: TestInfo, baseURL: string | undefined, responses: PresenceResponses) {
  const mode = await readServerMode(page.request, `${baseURL}/api/health`)
  const directory = path.join(QUEUED_PRIVATE_ROOT, 'runs', runId, `${mode}-${info.titlePath.join('-').replaceAll(/[^a-zA-Z0-9-]/g, '-').slice(-160)}`)
  return createPostingPresenceServer(directory, mode, {
    root: QUEUED_PRIVATE_ROOT, clock: PROVENANCE_BASE, companies: [...PROVENANCE_REGISTRATIONS], responses,
  })
}
/** Hold the named upstream responses behind gates the test releases explicitly. */
function gated(responses: PresenceResponses, gates: Partial<Record<'alderPresence' | 'alderContent' | 'birchList', string>>): PresenceResponses {
  const copy = structuredClone(responses)
  if (gates.alderPresence) copy[PROVENANCE_URLS.alderPresence] = { ...copy[PROVENANCE_URLS.alderPresence], gate: gates.alderPresence }
  if (gates.alderContent) copy[PROVENANCE_URLS.alderContent] = { ...copy[PROVENANCE_URLS.alderContent], gate: gates.alderContent }
  if (gates.birchList) copy[PROVENANCE_URLS.birchList] = { ...copy[PROVENANCE_URLS.birchList], gate: gates.birchList }
  return copy
}
/** The recorded completion of the browser's waiting 202 on the same shifted clock as upstream events. */
function waitingResponseTime(events: Event[]) {
  const response = events.find(event => event.event === 'http-response' && event.path === '/api/catalog?source=public' && event.status === 202)
  expect(response).toBeDefined()
  expect(response!.preferenceApplied).toBe('respond-async, orbit-progress=queued')
  return Date.parse(String(response!.at))
}
async function seed(page: Page, origin: string, options: { saved: SavedJob[]; query: string; view: 'saved' | 'explore' }) {
  await page.clock.install({ time: new Date(PROVENANCE_BASE) })
  await page.addInitScript(({ origin, saved, filters, query }) => {
    if (location.origin !== origin || sessionStorage.getItem('queued-seeded')) return
    localStorage.setItem('orbit.v1.saved', JSON.stringify(saved))
    localStorage.setItem('orbit.v1.exploration', JSON.stringify({
      source: 'public', selectedId: 'london', mapMode: 'flat', panelTab: 'cities', filters: { ...filters, query },
    }))
    sessionStorage.setItem('queued-seeded', 'true')
  }, { origin, saved: options.saved, filters: DEFAULT_FILTERS, query: options.query })
  await page.goto(options.view === 'saved' ? `${origin}/#saved` : origin)
}
function ordinaryCatalog(page: Page) {
  return page.waitForResponse(response => {
    const url = new URL(response.url())
    return url.pathname === '/api/catalog' && !url.searchParams.has('refresh')
  }, { timeout: 20_000 })
}
async function json<T>(page: Page, origin: string, route: string): Promise<T> {
  const response = await page.request.get(`${origin}${route}`)
  try {
    expect(response.status(), `${route} must answer through the real successful route`).toBe(200)
    return await response.json() as T
  } finally { await response.dispose() }
}
const catalogOf = (page: Page, origin: string) => json<Catalog>(page, origin, '/api/catalog?source=public')
const urls = async (server: Server) => (await server.requests()).map(request => request.url)
const count = (list: string[], url: string) => list.filter(item => item === url).length
const gateWaits = (events: Event[], gate: string) => events.filter(event => event.event === 'gate-wait' && event.gate === gate)
function responseTime(events: Event[], url: string) {
  const request = events.find(event => event.event === 'request' && event.url === url)
  const response = request && events.find(event => event.event === 'response' && event.sequence === request.sequence)
  return response ? Date.parse(String(response.at)) : null
}
/** Ranking ties between the two fictional postings do not fix list order, so compare the set. */
async function expectTitles(page: Page, titles: string[]) {
  await expect(page.locator('.mini-job-title')).toHaveCount(titles.length, { timeout: 30_000 })
  expect((await page.locator('.mini-job-title').allTextContents()).sort()).toEqual([...titles].sort())
}
async function expectWaitingView(page: Page) {
  await expect(status(page)).toBeVisible()
  await expect(status(page)).toHaveAttribute('aria-live', 'polite')
  await expect(status(page)).not.toContainText('개 회사 중')
  await expect(page.locator('progress[value]')).toHaveCount(0)
  await expect(page.locator('.data-status-button')).toContainText('공개 공고 조회 중')
}
/**
 * The waiting 202 must arrive while the gated list response is still unsent and before any new
 * body request. `bodiesBefore` are the body requests an earlier exploration legitimately made.
 */
async function expectHeldUpstream(server: Server, gate: string, bodiesBefore = { alderContent: 0, birchDetail: 0 }) {
  const events = await server.events()
  expect(gateWaits(events, gate)).toHaveLength(1)
  expect(responseTime(events, PROVENANCE_URLS.alderPresence)).toBeNull()
  const requested = events.filter(event => event.event === 'request').map(event => String(event.url))
  expect(requested).toContain(PROVENANCE_URLS.alderPresence)
  expect(count(requested, PROVENANCE_URLS.alderContent)).toBe(bodiesBefore.alderContent)
  expect(count(requested, PROVENANCE_URLS.birchDetail)).toBe(bodiesBefore.birchDetail)
  return events
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
async function expectSyntheticUpstream(server: Server) {
  const upstream = await server.requests()
  expect(upstream.every(request => request.synthetic && !request.networkSent && request.method === 'GET' && request.body === null)).toBe(true)
  return upstream
}

for (const width of [1440, 320]) test.describe(`waiting for a held saved-page list check on the real server at ${width}px`, () => {
  test.use({ viewport: { width, height: 960 }, isMobile: width === 320, hasTouch: width === 320 })

  test('a cold exploration receives the waiting state before the list is released, then the real two-company run, with no body request before handoff', async ({ page, baseURL }, info) => {
    test.setTimeout(150_000)
    const server = await fixture(page, info, baseURL, gated(provenanceResponses(), { alderPresence: 'alder-presence', alderContent: 'alder-content' }))
    const traffic = watchApiRequests(page)
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    try {
      await server.start()
      await server.verifyProductionBytes()
      await seed(page, server.origin, { saved: provenanceSaved('alder'), query: 'Backend', view: 'saved' })
      await expect(page.locator('.saved-card')).toHaveCount(1)
      await waitForSavedCommit(page)
      const savedBefore = await readSaved(page)
      expect(await server.requests()).toEqual([])

      // The saved-page list check starts; Alder's list is held at the upstream gate.
      const posting = page.waitForResponse(response => new URL(response.url()).pathname === '/api/posting-status', { timeout: 60_000 })
      await page.getByRole('button', { name: '게시 상태 확인', exact: true }).click()
      await expect.poll(async () => gateWaits(await server.events(), 'alder-presence').length).toBe(1)

      // Exploration receives the waiting 202 while the gate is still closed.
      const arriving = ordinaryCatalog(page)
      await navigation(page).getByRole('button', { name: '기회 탐색', exact: true }).click()
      const initial = await arriving
      const atWaiting = await expectHeldUpstream(server, 'alder-presence')
      expect(initial.status()).toBe(202)
      expect(initial.request().headers().prefer).toBe(QUEUED_PREFER)
      expect(initial.headers()['preference-applied']).toBe('respond-async, orbit-progress=queued')
      expect(initial.headers()['cache-control']).toBe('no-store')
      const snapshot = await initial.json() as { progress: Record<string, unknown>; catalog: Catalog }
      expect(snapshot.progress).toEqual({ id: expect.stringMatching(UUID), revision: 0, ...WAITING })
      expect(snapshot.catalog.fetchedAt).toBe('')
      expect(snapshot.catalog.jobs).toEqual([])
      expect(snapshot.catalog.boards.map(board => [board.companyId, board.status, board.dataStatus, board.lastSuccessAt]))
        .toEqual([[ALDER, 'ok', 'unavailable', null], [BIRCH, 'ok', 'unavailable', null]])
      await expectWaitingView(page)
      await expect(page.locator('.company-card')).toHaveCount(0)
      await expect(page.locator('.panel-data-footer')).toContainText('공개 공고 연결 확인')
      await expect(search(page)).toHaveValue('Backend')
      await audit(page, server, `waiting-${width}`)

      // Release the list: the saved-page request completes on its own, then the real run starts with Alder's body held.
      await server.release('alder-presence')
      expect((await posting).status()).toBe(200)
      await expect(progressbar(page)).toHaveAttribute('aria-valuetext', '2개 회사 중 1개 조회 종료')
      await expect(progressbar(page)).toHaveAttribute('value', '1')
      await expect(page.locator('.collection-progress-remaining').filter({ hasText: '확인 중' })).toContainText('확인 중 · Alder Forge')
      await expect(page.locator('.panel-data-footer')).toContainText('회사별 수집 진행 확인')
      await expect(status(page)).toHaveCount(0)
      await expect(page.locator('.company-card h3')).toHaveText(['Birch Signal'])
      const atCollecting = await server.events()
      const listReleasedAt = responseTime(atCollecting, PROVENANCE_URLS.alderPresence)!
      expect(listReleasedAt).not.toBeNull()
      // The waiting 202 was completed on the wire before the held list response existed.
      expect(waitingResponseTime(atCollecting)).toBeLessThanOrEqual(listReleasedAt)
      expect(gateWaits(atCollecting, 'alder-content')).toHaveLength(1)
      const bodyRequests = atCollecting.filter(event => event.event === 'request'
        && (String(event.url) === PROVENANCE_URLS.alderContent || String(event.url) === PROVENANCE_URLS.birchDetail))
      expect(bodyRequests.length).toBeGreaterThanOrEqual(2)
      for (const request of bodyRequests) expect(Date.parse(String(request.at))).toBeGreaterThanOrEqual(listReleasedAt)
      await audit(page, server, `collecting-${width}`)

      // Release the body: completion with both companies and exact upstream counts.
      await server.release('alder-content')
      await expectTitles(page, [PROVENANCE_TITLES.alder, PROVENANCE_TITLES.birch])
      await expect(page.getByRole('progressbar')).toHaveCount(0)
      await expect(page.getByRole('button', { name: '공개 채용', exact: true })).toBeVisible()
      await expect(page.locator('.catalog-notice')).toHaveCount(0)
      const catalog = await catalogOf(page, server.origin)
      expect(catalog.boards.map(board => [board.companyId, board.status, board.dataStatus, board.included])).toEqual([[ALDER, 'ok', 'fresh', 1], [BIRCH, 'ok', 'fresh', 1]])
      const finalUrls = await urls(server)
      expect(count(finalUrls, PROVENANCE_URLS.alderPresence)).toBe(1)
      expect(count(finalUrls, PROVENANCE_URLS.alderContent)).toBe(1)
      expect(count(finalUrls, PROVENANCE_URLS.birchList)).toBe(2)
      expect(count(finalUrls, PROVENANCE_URLS.birchDetail)).toBe(1)
      expect(finalUrls).toHaveLength(5)
      expect(await readSaved(page)).toEqual(savedBefore)
      await expect(search(page)).toHaveValue('Backend')
      const upstream = await expectSyntheticUpstream(server)
      assertPrivateTraffic(traffic)
      expect(errors).toEqual([])
      await writeFile(path.join(server.directory, 'cold-waiting.json'), JSON.stringify({
        snapshot, atWaiting, atCollecting, catalog, upstream, browser: traffic.requests, saved: savedBefore,
      }, null, 2))
    } finally {
      await page.close()
      await server.stop()
    }
  })

  test('a list failure accepted during the wait is shown before handoff, and the run then counts only the eligible company', async ({ page, baseURL }, info) => {
    test.setTimeout(150_000)
    // Both lists are held so the waiting state is observed before either result; Birch's 429 is then released alone.
    const server = await fixture(page, info, baseURL, gated(provenanceResponses({ birch: 'rate-limited' }), {
      alderPresence: 'alder-presence', alderContent: 'alder-content', birchList: 'birch-list',
    }))
    const traffic = watchApiRequests(page)
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    try {
      await server.start()
      await server.verifyProductionBytes()
      await seed(page, server.origin, { saved: provenanceSaved('alder'), query: 'Backend', view: 'saved' })
      await expect(page.locator('.saved-card')).toHaveCount(1)
      await waitForSavedCommit(page)
      const savedBefore = await readSaved(page)
      const posting = page.waitForResponse(response => new URL(response.url()).pathname === '/api/posting-status', { timeout: 60_000 })
      await page.getByRole('button', { name: '게시 상태 확인', exact: true }).click()
      await expect.poll(async () => gateWaits(await server.events(), 'alder-presence').length).toBe(1)

      await expect.poll(async () => gateWaits(await server.events(), 'birch-list').length).toBe(1)
      const arriving = ordinaryCatalog(page)
      await navigation(page).getByRole('button', { name: '기회 탐색', exact: true }).click()
      const initial = await arriving
      const atWaiting = await expectHeldUpstream(server, 'alder-presence')
      expect(responseTime(atWaiting, PROVENANCE_URLS.birchList)).toBeNull()
      expect(initial.status()).toBe(202)
      const snapshot = await initial.json() as { progress: Record<string, unknown>; catalog: Catalog }
      expect(snapshot.progress).toEqual({ id: expect.stringMatching(UUID), revision: 0, ...WAITING })
      // Neither list has answered: both rows are cold and carry no failure.
      expect(snapshot.catalog.boards.map(board => [board.companyId, board.status, board.message ?? null])).toEqual([[ALDER, 'ok', null], [BIRCH, 'ok', null]])
      await expectWaitingView(page)
      await page.locator('.data-status-button').click()
      await expect(row(page, 'Birch Signal')).toContainText('데이터 미확인')
      await expect(page.getByRole('dialog').locator('.board-error-detail')).toHaveCount(0)
      await page.getByRole('button', { name: '닫기', exact: true }).click()

      // Birch's 429 is released while Alder stays held: a metadata-only revision reaches the still-waiting view.
      await server.release('birch-list')
      await page.locator('.data-status-button').click()
      await expect(row(page, 'Birch Signal').locator('.board-error-detail')).toContainText('재조회 실패 · HTTP 429')
      await expect(row(page, 'Birch Signal')).toContainText('데이터 미확인')
      await expect(row(page, 'Alder Forge').locator('.board-error-detail')).toHaveCount(0)
      await expect(page.getByRole('dialog').locator('.board-row').filter({ hasText: '조회 중' })).toHaveCount(0)
      await expect(page.getByRole('dialog').locator('progress[value]')).toHaveCount(0)
      await audit(page, server, `deferred-waiting-${width}`)
      await page.getByRole('button', { name: '닫기', exact: true }).click()
      await expectWaitingView(page)
      const afterBirch = await expectHeldUpstream(server, 'alder-presence')
      const birchAnsweredAt = responseTime(afterBirch, PROVENANCE_URLS.birchList)!
      expect(birchAnsweredAt).not.toBeNull()
      expect(waitingResponseTime(afterBirch)).toBeLessThanOrEqual(birchAnsweredAt)
      const metadataPolls = afterBirch.filter(event => event.event === 'http-response' && String(event.path).startsWith('/api/catalog/progress') && event.status === 200)
      expect(metadataPolls.length).toBeGreaterThanOrEqual(1)

      await server.release('alder-presence')
      expect((await posting).status()).toBe(200)
      await expect(progressbar(page)).toHaveAttribute('aria-valuetext', '1개 회사 중 0개 조회 종료')
      await expect(page.locator('.collection-progress-remaining').filter({ hasText: '확인 중' })).toContainText('확인 중 · Alder Forge')
      await expect(page.locator('.collection-progress-remaining').filter({ hasText: '확인 중' })).not.toContainText('Birch Signal')
      await expect(page.locator('.collection-progress-failed')).toHaveText('현재 조회 실패 상태인 회사는 1개입니다. 회사별 조회 기록에서 확인할 수 있습니다.')
      expect(gateWaits(await server.events(), 'alder-content')).toHaveLength(1)
      await server.release('alder-content')
      await expect(page.locator('.mini-job-title')).toHaveText([PROVENANCE_TITLES.alder], { timeout: 30_000 })
      await expect(page.getByRole('progressbar')).toHaveCount(0)
      await expect(page.locator('.catalog-notice')).toContainText('1개 회사는 확인 가능한 공고가 없어요.')
      const catalog = await catalogOf(page, server.origin)
      expect(catalog.boards.map(board => [board.companyId, board.status, board.dataStatus, board.included])).toEqual([[ALDER, 'ok', 'fresh', 1], [BIRCH, 'error', 'unavailable', 0]])
      expect(catalog.boards[1]).toMatchObject({ message: 'HTTP 429', lastSuccessAt: null })
      const finalUrls = await urls(server)
      expect(count(finalUrls, PROVENANCE_URLS.alderPresence)).toBe(1)
      expect(count(finalUrls, PROVENANCE_URLS.alderContent)).toBe(1)
      expect(count(finalUrls, PROVENANCE_URLS.birchList)).toBe(1)
      expect(count(finalUrls, PROVENANCE_URLS.birchDetail)).toBe(0)
      expect(await readSaved(page)).toEqual(savedBefore)
      await expect(search(page)).toHaveValue('Backend')
      await expectSyntheticUpstream(server)
      assertPrivateTraffic(traffic)
      expect(errors).toEqual([])
    } finally {
      await page.close()
      await server.stop()
    }
  })

  test('a fresh exploration keeps its cached bodies and original times through the wait and completes with zero body work', async ({ page, baseURL }, info) => {
    test.setTimeout(150_000)
    const server = await fixture(page, info, baseURL, provenanceResponses())
    const traffic = watchApiRequests(page)
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    try {
      await server.start()
      await server.verifyProductionBytes()
      await seed(page, server.origin, { saved: provenanceSaved('birch'), query: 'Backend', view: 'explore' })
      await expectTitles(page, [PROVENANCE_TITLES.alder, PROVENANCE_TITLES.birch])
      await waitForSavedCommit(page)
      const savedBefore = await readSaved(page)
      const first = await catalogOf(page, server.origin)
      const bodyTimes = first.boards.map(board => board.lastSuccessAt)
      expect([...await urls(server)].sort()).toEqual([PROVENANCE_URLS.alderContent, PROVENANCE_URLS.birchDetail, PROVENANCE_URLS.birchList].sort())

      // Sixty-one seconds later the saved page starts a list check whose Alder response is held.
      await server.advance(61_000)
      await page.clock.fastForward(61_000)
      await server.respond(gated(provenanceResponses(), { alderPresence: 'alder-presence' }))
      await navigation(page).getByRole('button', { name: /^저장한 기회/ }).click()
      await expect(page.locator('.saved-card')).toHaveCount(1)
      await page.getByRole('button', { name: '게시 상태 확인', exact: true }).click()
      await expect.poll(async () => gateWaits(await server.events(), 'alder-presence').length).toBe(1)

      // A fresh exploration load receives the waiting state with both cached bodies.
      const arriving = ordinaryCatalog(page)
      await page.goto(server.origin)
      const initial = await arriving
      await expectHeldUpstream(server, 'alder-presence', { alderContent: 1, birchDetail: 1 })
      expect(initial.status()).toBe(202)
      const snapshot = await initial.json() as { progress: Record<string, unknown>; catalog: Catalog }
      expect(snapshot.progress).toEqual({ id: expect.stringMatching(UUID), revision: 0, ...WAITING })
      expect(snapshot.catalog.boards.map(board => [board.companyId, board.status, board.dataStatus, board.lastSuccessAt]))
        .toEqual([[ALDER, 'ok', 'fresh', bodyTimes[0]], [BIRCH, 'ok', 'fresh', bodyTimes[1]]])
      expect(snapshot.catalog.jobs.map(job => job.fetchedAt)).toEqual(bodyTimes)
      await expectTitles(page, [PROVENANCE_TITLES.alder, PROVENANCE_TITLES.birch])
      await expectWaitingView(page)
      await expect(page.locator('.stale-job-badge')).toHaveCount(0)
      await expect(page.locator('.panel-data-footer')).toContainText('회사별 공개 채용공고')
      await audit(page, server, `fresh-waiting-${width}`)

      await server.release('alder-presence')
      await expect(status(page)).toHaveCount(0)
      await expect(page.getByRole('button', { name: '공개 채용', exact: true })).toBeVisible()
      await expect(page.locator('.catalog-notice')).toHaveCount(0)
      await expectTitles(page, [PROVENANCE_TITLES.alder, PROVENANCE_TITLES.birch])
      const settled = await catalogOf(page, server.origin)
      expect(settled.boards.map(board => board.lastSuccessAt)).toEqual(bodyTimes)
      expect(settled.jobs.map(job => job.fetchedAt)).toEqual(bodyTimes)
      const finalUrls = await urls(server)
      expect(count(finalUrls, PROVENANCE_URLS.alderContent)).toBe(1)
      expect(count(finalUrls, PROVENANCE_URLS.birchDetail)).toBe(1)
      expect(count(finalUrls, PROVENANCE_URLS.birchList)).toBe(2)
      expect(count(finalUrls, PROVENANCE_URLS.alderPresence)).toBe(1)
      await waitForSavedCommit(page)
      expect(await readSaved(page)).toEqual(savedBefore)
      await expect(search(page)).toHaveValue('Backend')
      await expectSyntheticUpstream(server)
      assertPrivateTraffic(traffic)
      expect(errors).toEqual([])
    } finally {
      await page.close()
      await server.stop()
    }
  })

  test('when every list check fails during the wait, the run ends with the existing unavailable error and no body request', async ({ page, baseURL }, info) => {
    test.setTimeout(150_000)
    const server = await fixture(page, info, baseURL, gated(provenanceResponses({ alder: 'rate-limited', birch: 'rate-limited' }), { alderPresence: 'alder-presence' }))
    const traffic = watchApiRequests(page)
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    try {
      await server.start()
      await server.verifyProductionBytes()
      await seed(page, server.origin, { saved: provenanceSaved('alder'), query: 'Backend', view: 'saved' })
      await expect(page.locator('.saved-card')).toHaveCount(1)
      await waitForSavedCommit(page)
      const savedBefore = await readSaved(page)
      const posting = page.waitForResponse(response => new URL(response.url()).pathname === '/api/posting-status', { timeout: 60_000 })
      await page.getByRole('button', { name: '게시 상태 확인', exact: true }).click()
      await expect.poll(async () => gateWaits(await server.events(), 'alder-presence').length).toBe(1)

      const arriving = ordinaryCatalog(page)
      await navigation(page).getByRole('button', { name: '기회 탐색', exact: true }).click()
      const initial = await arriving
      await expectHeldUpstream(server, 'alder-presence')
      expect(initial.status()).toBe(202)
      await expectWaitingView(page)
      // Birch's 429 was accepted while Alder's list is still held, so its failure row is already visible.
      await page.locator('.data-status-button').click()
      await expect(row(page, 'Birch Signal').locator('.board-error-detail')).toContainText('재조회 실패 · HTTP 429')
      await expect(row(page, 'Alder Forge').locator('.board-error-detail')).toHaveCount(0)
      await page.getByRole('button', { name: '닫기', exact: true }).click()
      await expectWaitingView(page)

      // Alder's 429 lands and the run ends with nothing usable. The client may receive the terminal
      // 503 instead of the last metadata revision, so only the earlier accepted failure is asserted per row.
      await server.release('alder-presence')
      expect((await posting).status()).toBe(200)
      await expect(page.locator('.catalog-placeholder')).toContainText('공개 채용 게시판에 연결하지 못했습니다')
      await expect(page.getByRole('button', { name: /다시 조회/ })).toBeDisabled()
      await expect(page.locator('.search-recovery, .company-card, .city-row')).toHaveCount(0)
      await expect(page.locator('.data-status-button')).toContainText('공개 공고 연결 필요')
      await page.locator('.data-status-button').click()
      await expect(row(page, 'Birch Signal').locator('.board-error-detail')).toContainText('재조회 실패 · HTTP 429')
      await expect(row(page, 'Alder Forge')).toContainText('데이터 미확인')
      await expect(page.getByRole('dialog').locator('progress[value]')).toHaveCount(0)
      await audit(page, server, `all-deferred-${width}`)
      await page.getByRole('button', { name: '닫기', exact: true }).click()
      const catalog = await page.request.get(`${server.origin}/api/catalog?source=public`)
      try {
        expect(catalog.status()).toBe(503)
        expect(await catalog.json()).toMatchObject({ code: 'CATALOG_UNAVAILABLE' })
      } finally { await catalog.dispose() }
      const finalUrls = await urls(server)
      expect(count(finalUrls, PROVENANCE_URLS.alderPresence)).toBe(1)
      expect(count(finalUrls, PROVENANCE_URLS.birchList)).toBe(1)
      expect(count(finalUrls, PROVENANCE_URLS.alderContent)).toBe(0)
      expect(count(finalUrls, PROVENANCE_URLS.birchDetail)).toBe(0)
      expect(await readSaved(page)).toEqual(savedBefore)
      await expect(search(page)).toHaveValue('Backend')
      await expectSyntheticUpstream(server)
      assertPrivateTraffic(traffic)
      expect(errors).toEqual([])
    } finally {
      await page.close()
      await server.stop()
    }
  })
})
