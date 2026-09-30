import { expect } from '@playwright/test'
import type { Page, Route } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { DEFAULT_FILTERS } from '../../shared/types'
import {
  QUEUED_FAILURE_BODY, QUEUED_FAILURE_MESSAGE, QUEUED_FAILURE_TEXT, QUEUED_ID, QUEUED_NOTE, QUEUED_PREFER, QUEUED_TEXT, QUEUED_TIMES,
  QUEUED_WAITING_LABEL, queuedCollected, queuedHandoff, queuedMetadata, queuedRecoveredCatalog, queuedSaved, queuedWaiting, queuedZeroWork,
} from '../fixtures/catalog-queued-progress'
import type { QueuedCache, QueuedUpdate } from '../fixtures/catalog-queued-progress'
import { expectInitialCatalogRequest, watchApiRequests } from './helpers/api-requests'
import { resourceCheckedTest as test } from './helpers/public-app'
import { readSavedJson } from './helpers/saved-store'

// Stage75 contract: docs/design/catalog-queued-progress.md (9b921a49…feff9).
// Authored wire JSON reaches the real request pipeline, worker and views. These
// cases pin the browser contract for the waiting phase: an honest indeterminate
// wait, metadata-only updates, the handoff to real counts, zero-work completion,
// the fixed operation failure, and preserved saved records and query.
//
// Clock discipline: the page clock is paused before the application initializes.
// Monitor requests are never answered by the route; each one is taken and
// answered explicitly, and the client polls strictly one at a time, so the exact
// monitor history is fixed by the test and not by how long UI or accessibility
// work takes. Time advances only in two documented steps: the idle publication
// deadline after a genuine worker decode, and the Retry-After interval to open the
// next poll. axe-core yields through real setTimeout callbacks, so the clock runs
// during an audit and is paused again immediately afterwards.
declare global { interface Window { __queuedDecoded75?: number } }

type Stage = 'waiting' | 'recovered'
/** The documented idle publication deadline of the presentation queue. */
const PUBLICATION_DELAY = 120
/** Retry-After: 1 plus the same margin every existing progress test uses. */
const POLL_INTERVAL = 1100
const status = (page: Page) => page.getByRole('status').filter({ hasText: QUEUED_WAITING_LABEL })
const progressbar = (page: Page) => page.getByRole('progressbar', { name: '공개 게시판 조회 진행' })
const search = (page: Page) => page.getByRole('textbox', { name: '도시, 회사 또는 포지션 검색', exact: true })
const row = (page: Page, company: string) => page.getByRole('dialog').locator('.board-row').filter({ hasText: company })
const lastSuccess = (page: Page, company: string) => row(page, company).locator('p').filter({ hasText: '마지막 정상 확인' }).locator('time')
const close = (page: Page) => page.getByRole('button', { name: '닫기', exact: true }).click()
const monitor = (after: number) => `/api/catalog/progress?id=${QUEUED_ID}&after=${after}`
const monitorPath = (url: string) => new URL(url).pathname === '/api/catalog/progress'

async function restore(page: Page, options: { query?: string; saved?: boolean } = {}) {
  const now = Date.parse(QUEUED_TIMES.browserNow)
  await page.clock.install({ time: new Date(now - 1000) })
  await page.clock.pauseAt(new Date(now))
  await page.addInitScript(() => {
    // Observe genuine worker decode replies without replacing messages, results or callbacks.
    const NativeWorker = window.Worker
    window.__queuedDecoded75 = 0
    window.Worker = class extends NativeWorker {
      constructor(url: URL | string, options?: WorkerOptions) {
        super(url, options)
        if (options?.name !== 'orbit-catalog') return
        this.addEventListener('message', (event: MessageEvent<{ result?: { kind?: string } }>) => {
          if (event.data.result?.kind === 'decoded') window.__queuedDecoded75 = (window.__queuedDecoded75 ?? 0) + 1
        })
      }
    }
  })
  await page.addInitScript(({ filters, query, saved }) => {
    if (sessionStorage.getItem('queued-seeded')) return
    localStorage.setItem('orbit.v1.exploration', JSON.stringify({
      source: 'public', selectedId: 'london', mapMode: 'flat', panelTab: 'cities', filters: { ...filters, query },
    }))
    if (saved) localStorage.setItem('orbit.v1.saved', JSON.stringify(saved))
    sessionStorage.setItem('queued-seeded', 'true')
  }, { filters: DEFAULT_FILTERS, query: options.query ?? 'Backend', saved: options.saved === false ? null : queuedSaved() })
  await page.goto('/')
}

interface Routes {
  stage: Stage
  cache: QueuedCache
  /** Monitor requests in arrival order; the exact history oracle. */
  monitors: string[]
  /** Monitor requests received and not yet answered. The client never has more than one open. */
  pending: Route[]
  prefers: (string | undefined)[]
  refreshes: number
}

async function installRoutes(page: Page, cache: QueuedCache): Promise<Routes> {
  const state: Routes = { stage: 'waiting', cache, monitors: [], pending: [], prefers: [], refreshes: 0 }
  await page.route('**/api/catalog?source=public*', route => {
    state.prefers.push(route.request().headers().prefer)
    if (new URL(route.request().url()).searchParams.get('refresh') === '1') state.refreshes++
    if (state.stage === 'recovered') return route.fulfill({ json: queuedRecoveredCatalog() })
    return route.fulfill({ status: 202, headers: { 'Retry-After': '1', 'Preference-Applied': QUEUED_PREFER }, json: queuedWaiting(cache) })
  })
  await page.route('**/api/catalog/progress?*', route => {
    const url = new URL(route.request().url())
    state.monitors.push(url.pathname + url.search)
    state.pending.push(route)
  })
  return state
}

/**
 * Wait for the next genuine worker decode, which is network and worker work and never
 * advances time, then run exactly the documented idle publication deadline so the
 * decoded snapshot is published. The count is re-read in a separate round trip so the
 * client's own message-handler microtasks, including scheduling its next poll, have run.
 */
function decodes(page: Page) {
  let seen = 0
  return {
    async publish() {
      await expect.poll(() => page.evaluate(() => window.__queuedDecoded75 ?? 0)).toBeGreaterThan(seen)
      seen = await page.evaluate(() => window.__queuedDecoded75 ?? 0)
      await page.clock.runFor(PUBLICATION_DELAY)
    },
  }
}

/**
 * Open the next monitor request and return it unanswered. The previous monitor response must
 * have been fully received first; then one Retry-After interval fires the client's timer. A poll
 * that already arrived, for example while the clock ran during an audit, is taken as is. The
 * request's exact path is checked here, so every step of the history is verified twice.
 */
async function takePoll(page: Page, state: Routes, traffic: ReturnType<typeof watchApiRequests>, after: number): Promise<Route> {
  await expect.poll(() => traffic.requests.filter(request => monitorPath(request.url) && request.state === 'pending').length
    - state.pending.length).toBe(0)
  if (!state.pending.length) {
    await page.clock.runFor(POLL_INTERVAL)
    await expect.poll(() => state.pending.length).toBe(1)
  }
  const route = state.pending.shift()!
  const url = new URL(route.request().url())
  expect(url.pathname + url.search).toBe(monitor(after))
  return route
}

const unchanged = (route: Route) => route.fulfill({ status: 204, headers: { 'Retry-After': '1' } })
const deliver = (route: Route, update: QueuedUpdate) => route.fulfill({ json: update })

/** Ranking ties between identical fixture postings do not fix card order, so compare the set. */
async function expectCompanies(page: Page, names: string[]) {
  await expect(page.locator('.company-card h3')).toHaveCount(names.length)
  expect((await page.locator('.company-card h3').allTextContents()).sort()).toEqual([...names].sort())
}

async function expectWaiting(page: Page) {
  await expect(status(page)).toBeVisible()
  await expect(status(page)).toHaveAttribute('aria-live', 'polite')
  await expect(status(page)).not.toContainText('개 회사 중')
  await expect(page.locator('progress[value]')).toHaveCount(0)
  await expect(page.locator('.data-status-button')).toContainText('공개 공고 조회 중')
}

/** axe-core yields through setTimeout, so the clock runs for the audit and is paused again right after. */
async function audit(page: Page) {
  await page.clock.resume()
  try {
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    for (const dialog of await page.getByRole('dialog').all()) {
      expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
    }
    expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([])
  } finally {
    await page.clock.pauseAt(new Date(await page.evaluate(() => Date.now()) + 1000))
  }
}

function onlyCatalogTraffic(traffic: ReturnType<typeof watchApiRequests>, allowed: string[]) {
  for (const request of traffic.requests) {
    const url = new URL(request.url)
    expect(request.method).toBe('GET')
    expect(request.body).toBeNull()
    expect(allowed.some(prefix => (url.pathname + url.search).startsWith(prefix))).toBe(true)
  }
  expect(JSON.stringify(traffic.requests)).not.toContain(encodeURIComponent(QUEUED_NOTE))
}

for (const width of [1440, 320]) test.describe(`negotiated waiting progress at ${width}px`, () => {
  // UTC keeps the rendered ko-KR times equal to the fixture's ISO hours and minutes.
  test.use({ viewport: { width, height: 960 }, isMobile: width === 320, hasTouch: width === 320, timezoneId: 'UTC' })

  test('a cold wait shows no count or bar, carries a list failure as metadata, hands off to one real company and completes with truthful notices', async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    const traffic = watchApiRequests(page)
    const state = await installRoutes(page, 'cold')
    const worker = decodes(page)
    await restore(page)
    const initial = await expectInitialCatalogRequest(page, traffic)
    await worker.publish()
    const savedBefore = await readSavedJson(page)
    expect(state.prefers.length).toBeGreaterThanOrEqual(1)
    expect(state.prefers.every(prefer => prefer === QUEUED_PREFER)).toBe(true)

    // Waiting: honest label, no determinate bar, no company count, cold rows, nothing pending.
    await expectWaiting(page)
    await expect(page.locator('.company-card')).toHaveCount(0)
    await expect(page.locator('.panel-data-footer')).toContainText('공개 공고 연결 확인')
    await page.locator('.data-status-button').click()
    const dialog = page.getByRole('dialog')
    await expect(dialog.locator('progress[value]')).toHaveCount(0)
    await expect(dialog).not.toContainText('개 회사 중')
    await expect(row(page, 'Aster Transit')).toContainText('데이터 미확인')
    await expect(row(page, 'Cedar Loom')).toContainText('데이터 미확인')
    await expect(dialog.locator('.board-row').filter({ hasText: '조회 중' })).toHaveCount(0)
    await expect(dialog.locator('.board-error-detail')).toHaveCount(0)
    await audit(page)
    await close(page)
    // A poll with nothing new keeps waiting.
    await unchanged(await takePoll(page, state, traffic, 0))
    await expectWaiting(page)

    // Cedar's list failure is accepted: still waiting, and the failure is shown with its own times.
    await deliver(await takePoll(page, state, traffic, 0), queuedMetadata('cold'))
    await worker.publish()
    await expectWaiting(page)
    await page.locator('.data-status-button').click()
    const cedar = row(page, 'Cedar Loom')
    await expect(cedar).toContainText('데이터 미확인')
    await expect(cedar.locator('.board-error-detail')).toContainText(`재조회 실패 · ${QUEUED_FAILURE_TEXT}`)
    await expect(cedar.locator('.board-error-detail')).toContainText(`조회 시도 · ${QUEUED_TEXT.attempt}`)
    await expect(cedar.locator('.board-error-detail')).toContainText(`${QUEUED_TEXT.retry} 이후 재시도`)
    await expect(cedar.locator('.board-error-detail time')).toHaveAttribute('datetime', QUEUED_TIMES.retry)
    await expect(lastSuccess(page, 'Cedar Loom')).toHaveText('확인 기록 없음')
    await expect(row(page, 'Aster Transit').locator('.board-error-detail')).toHaveCount(0)
    await expect(dialog.locator('.board-row').filter({ hasText: '조회 중' })).toHaveCount(0)
    await expect(dialog.locator('progress[value]')).toHaveCount(0)
    await expect(dialog.locator('.board-section .field-description')).toContainText(`최근 게시판 조회 시도 · ${QUEUED_TEXT.attempt}`)
    await audit(page)
    await close(page)

    // Handoff: exactly one real company; the deferred failure is stated separately, never as a finished body.
    await deliver(await takePoll(page, state, traffic, 1), queuedHandoff())
    await worker.publish()
    await expect(progressbar(page)).toHaveAttribute('value', '0')
    await expect(progressbar(page)).toHaveAttribute('aria-valuetext', '1개 회사 중 0개 조회 종료')
    const remaining = page.locator('.collection-progress-remaining').filter({ hasText: '확인 중' })
    await expect(remaining).toContainText('확인 중 · Aster Transit')
    await expect(remaining).not.toContainText('Cedar Loom')
    await expect(page.locator('.collection-progress-failed')).toHaveText('현재 조회 실패 상태인 회사는 1개입니다. 회사별 조회 기록에서 확인할 수 있습니다.')
    await expect(page.locator('.panel-data-footer')).toContainText('회사별 수집 진행 확인')
    await expect(status(page)).toHaveCount(0)
    await page.locator('.data-status-button').click()
    await expect(row(page, 'Aster Transit')).toContainText('조회 중')
    await expect(row(page, 'Cedar Loom')).toContainText('데이터 미확인')
    await expect(page.getByRole('dialog').getByRole('progressbar')).toHaveAttribute('aria-valuetext', '1개 회사 중 0개 조회 종료')
    await audit(page)
    await close(page)

    // Collected: one card, the attention notice counts the deferred company separately.
    await deliver(await takePoll(page, state, traffic, 2), queuedCollected())
    await worker.publish()
    await expect(page.getByRole('progressbar')).toHaveCount(0)
    await expect(page.locator('.company-card')).toHaveCount(1)
    await expect(page.locator('.company-card')).toContainText('Aster Transit')
    await expect(page.locator('.catalog-notice')).toContainText('일부 게시판의 최신 공고를 확인하지 못했어요.')
    await expect(page.locator('.catalog-notice')).toContainText('이전 조회 공고 0개를 포함합니다. 1개 회사는 확인 가능한 공고가 없어요.')
    await expect(page.locator('.panel-data-footer')).toContainText('일부 게시판 · 조회 상태 확인')
    await expect(page.locator('.data-status-button')).toContainText('공개 채용')
    await expect(search(page)).toHaveValue('Backend')
    expect(await readSavedJson(page)).toBe(savedBefore)
    // Monitoring has ended: two minutes of clock open no further poll.
    await page.clock.fastForward(120000)
    expect(state.pending).toEqual([])
    expect(state.monitors).toEqual([monitor(0), monitor(0), monitor(1), monitor(2)])
    expect(traffic.catalog()).toHaveLength(initial.attempts)
    onlyCatalogTraffic(traffic, ['/api/catalog?source=public', `/api/catalog/progress?id=${QUEUED_ID}&after=`])
    expect(errors).toEqual([])
  })

  test('fresh cached bodies stay explorable while waiting; the deferred company becomes retained through metadata and the run ends with zero body work', async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    const traffic = watchApiRequests(page)
    const state = await installRoutes(page, 'fresh')
    const worker = decodes(page)
    await restore(page)
    const initial = await expectInitialCatalogRequest(page, traffic)
    await worker.publish()
    const savedBefore = await readSavedJson(page)

    await expectWaiting(page)
    await expectCompanies(page, ['Aster Transit', 'Cedar Loom'])
    await expect(page.locator('.stale-job-badge')).toHaveCount(0)
    await expect(page.locator('.panel-data-footer')).toContainText('회사별 공개 채용공고')
    await unchanged(await takePoll(page, state, traffic, 0))
    await expectWaiting(page)

    await deliver(await takePoll(page, state, traffic, 0), queuedMetadata('fresh'))
    await worker.publish()
    await expectWaiting(page)
    await expectCompanies(page, ['Aster Transit', 'Cedar Loom'])
    await expect(page.locator('.company-card .stale-job-badge')).toHaveText(['이전 조회 공고'])
    await page.locator('.data-status-button').click()
    await expect(row(page, 'Cedar Loom')).toContainText('이전 1개 유지')
    await expect(row(page, 'Cedar Loom').locator('.board-error-detail')).toContainText(`재조회 실패 · ${QUEUED_FAILURE_TEXT}`)
    await expect(lastSuccess(page, 'Cedar Loom')).toHaveAttribute('datetime', QUEUED_TIMES.freshBody)
    await expect(lastSuccess(page, 'Cedar Loom')).toHaveText(QUEUED_TEXT.freshBody)
    await expect(row(page, 'Aster Transit')).toContainText('1개 반영')
    await expect(page.getByRole('dialog').locator('.collection-health dd')).toHaveText(['1개 공고', '1개 공고', '0개'])
    await expect(page.getByRole('dialog').locator('progress[value]')).toHaveCount(0)
    await audit(page)
    await close(page)

    await deliver(await takePoll(page, state, traffic, 1), queuedZeroWork())
    await worker.publish()
    await expect(status(page)).toHaveCount(0)
    await expect(page.getByRole('progressbar')).toHaveCount(0)
    await expect(page.locator('.catalog-notice')).toContainText('일부 게시판의 최신 공고를 확인하지 못했어요.')
    await expect(page.locator('.catalog-notice')).toContainText('이전 조회 공고 1개를 포함합니다.')
    await expect(page.locator('.catalog-notice')).not.toContainText('확인 가능한 공고가 없어요')
    await expectCompanies(page, ['Aster Transit', 'Cedar Loom'])
    await expect(page.locator('.company-card .stale-job-badge')).toHaveText(['이전 조회 공고'])
    await expect(page.locator('.panel-data-footer')).toContainText('일부 게시판 · 조회 상태 확인')
    await expect(page.locator('.data-status-button')).toContainText('공개 채용')
    await expect(search(page)).toHaveValue('Backend')
    expect(await readSavedJson(page)).toBe(savedBefore)
    await page.clock.fastForward(120000)
    expect(state.pending).toEqual([])
    expect(state.monitors).toEqual([monitor(0), monitor(0), monitor(1)])
    expect(traffic.catalog()).toHaveLength(initial.attempts)
    onlyCatalogTraffic(traffic, ['/api/catalog?source=public', `/api/catalog/progress?id=${QUEUED_ID}&after=`])
    expect(errors).toEqual([])
  })

  test('condition-relaxation suggestions stay hidden while waiting and return after the zero-work completion', async ({ page }) => {
    const traffic = watchApiRequests(page)
    const state = await installRoutes(page, 'fresh')
    const worker = decodes(page)
    await restore(page, { query: 'Zeppelin', saved: false })
    await expectInitialCatalogRequest(page, traffic)
    await worker.publish()
    await expectWaiting(page)
    await expect(page.locator('.company-card')).toHaveCount(0)
    await expect(page.locator('.search-recovery')).toHaveCount(0)
    await deliver(await takePoll(page, state, traffic, 0), queuedZeroWork())
    await worker.publish()
    await expect(status(page)).toHaveCount(0)
    await expect(page.locator('.search-recovery')).toBeVisible()
    await expect(search(page)).toHaveValue('Zeppelin')
    await page.clock.fastForward(120000)
    expect(state.pending).toEqual([])
    expect(state.monitors).toEqual([monitor(0)])
    onlyCatalogTraffic(traffic, ['/api/catalog?source=public', `/api/catalog/progress?id=${QUEUED_ID}&after=`])
  })

  test('leaving for saved records cancels only this browser\'s monitor; returning rejoins the same waiting operation with notes, status and query intact', async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    const traffic = watchApiRequests(page)
    const state = await installRoutes(page, 'cold')
    const worker = decodes(page)
    await restore(page)
    const initial = await expectInitialCatalogRequest(page, traffic)
    await worker.publish()
    const savedBefore = await readSavedJson(page)
    await expectWaiting(page)
    // The first poll is opened and deliberately left unanswered.
    const held = await takePoll(page, state, traffic, 0)

    await page.getByRole('navigation', { name: '주요 메뉴' }).getByRole('button', { name: /저장한 기회/ }).click()
    await expect.poll(() => traffic.requests.filter(request => monitorPath(request.url)
      && request.state === 'failed' && request.error === 'net::ERR_ABORTED').length).toBe(1)
    // A late answer to the cancelled monitor cannot reach the view.
    await deliver(held, queuedMetadata('cold')).catch(error => {
      if (held.request().failure()?.errorText !== 'net::ERR_ABORTED') throw error
    })
    expect(new URL(page.url()).hash).toBe('#saved')
    await expect(page.locator('.saved-card')).toHaveCount(1)
    await expect(page.locator('.saved-note-preview')).toHaveText([QUEUED_NOTE])
    await expect(page.locator('.saved-status')).toHaveText(['지원 완료'])
    await page.clock.fastForward(120000)
    expect(traffic.catalog()).toHaveLength(initial.attempts)
    expect(state.pending).toEqual([])

    await page.getByRole('navigation', { name: '주요 메뉴' }).getByRole('button', { name: '기회 탐색', exact: true }).click()
    await expect.poll(() => traffic.catalog().filter(request => request.state === 'finished').length).toBe(2)
    await worker.publish()
    await expectWaiting(page)
    await expect(page.locator('.company-card')).toHaveCount(0)
    await deliver(await takePoll(page, state, traffic, 0), queuedCollected())
    await worker.publish()
    await expect(page.locator('.company-card')).toHaveCount(1)
    await expect(page.getByRole('progressbar')).toHaveCount(0)
    await expect(search(page)).toHaveValue('Backend')
    expect(await readSavedJson(page)).toBe(savedBefore)
    await page.clock.fastForward(120000)
    expect(state.pending).toEqual([])
    expect(state.monitors).toEqual([monitor(0), monitor(0)])
    onlyCatalogTraffic(traffic, ['/api/catalog?source=public', `/api/catalog/progress?id=${QUEUED_ID}&after=`])
    expect(errors).toEqual([])
  })

  test('the fixed operation failure ends monitoring with its message, keeps the delivered bodies and allows an immediate manual retry', async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    const traffic = watchApiRequests(page)
    const state = await installRoutes(page, 'fresh')
    const worker = decodes(page)
    await restore(page)
    const initial = await expectInitialCatalogRequest(page, traffic)
    await worker.publish()
    const savedBefore = await readSavedJson(page)
    await expectWaiting(page)
    await expectCompanies(page, ['Aster Transit', 'Cedar Loom'])

    // The failure reaches the view through the request error path, which publishes without a timer.
    await (await takePoll(page, state, traffic, 0)).fulfill({ status: 503, headers: { 'Cache-Control': 'no-store' }, json: QUEUED_FAILURE_BODY })
    await expect(page.locator('.catalog-notice')).toContainText(QUEUED_FAILURE_MESSAGE)
    await expect(status(page)).toHaveCount(0)
    await expect(page.getByRole('progressbar')).toHaveCount(0)
    await expectCompanies(page, ['Aster Transit', 'Cedar Loom'])
    await expect(page.locator('.data-status-button')).toContainText('공개 공고 연결 필요')
    const retry = page.getByRole('button', { name: '다시 조회', exact: true })
    await expect(retry).toBeEnabled()
    await audit(page)
    await page.clock.fastForward(120000)
    expect(state.pending).toEqual([])
    expect(state.monitors).toEqual([monitor(0)])
    expect(traffic.catalog()).toHaveLength(initial.attempts)

    state.stage = 'recovered'
    await retry.click()
    await worker.publish()
    await expect(page.locator('.catalog-notice')).toHaveCount(0)
    await expectCompanies(page, ['Aster Transit', 'Cedar Loom'])
    await expect(page.locator('.data-status-button')).toContainText('공개 채용')
    expect(state.refreshes).toBe(1)
    await expect(search(page)).toHaveValue('Backend')
    expect(await readSavedJson(page)).toBe(savedBefore)
    await page.clock.fastForward(120000)
    expect(state.pending).toEqual([])
    expect(state.monitors).toEqual([monitor(0)])
    onlyCatalogTraffic(traffic, ['/api/catalog?source=public', `/api/catalog/progress?id=${QUEUED_ID}&after=`])
    expect(errors).toEqual([])
  })
})
