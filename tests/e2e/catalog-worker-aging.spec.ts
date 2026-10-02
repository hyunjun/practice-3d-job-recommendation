import { expect } from '@playwright/test'
import type { Locator, Page, TestInfo } from '@playwright/test'
import { CATALOG_WORKER_NOTE, catalogWorkerCatalog, catalogWorkerSaved, catalogWorkerUpdate } from '../fixtures/catalog-worker'
import {
  AGING_AT, AGING_JOB_IDS, ASTER_IDS, BIRCH_IDS, CEDAR_IDS, SIZABLE_BODY_CHARS, agingSizableCatalog,
} from '../fixtures/catalog-worker-aging'
import { expectInitialCatalogRequest, readServerMode } from './helpers/api-requests'
import {
  catalogWorkerClose as close, catalogWorkerExploration as exploration, catalogWorkerQuery as query,
  catalogWorkerTest as test, expectCatalogWorkerCompanies as companies,
} from './helpers/catalog-worker'
import {
  AGE_NOTICE, EXPIRED_TITLE, FAR_REFRESH_AFTER, UNAVAILABLE_TEXT, UNAVAILABLE_TITLE, WORKER_FAILURE_MESSAGE,
  expectRecommendationsUnavailable, withRefreshAfter,
} from './helpers/catalog-retention'
import { installCatalogWorkerTransport } from './helpers/catalog-worker-transport'
import type { ObservedReply } from './helpers/catalog-worker-transport'
import { readSavedJson } from './helpers/saved-store'

// Stage79 contract docs/design/catalog-worker-aging.md (SHA-256 2fc0192c…), independent verification
// items 9-10: the real browser Worker at 1440x960 and 320x960 for E1-E5. Visible expectations are
// authored fixture literals; transport expectations come from the test-only message observer
// (bodyIds = full records in patch.jobs, jobIds = complete live membership, staleUpdates, removed,
// factCount, bodyChars). Replies are summarised, never altered; held replies, synthetic corruptions
// and replays are explicitly labelled controls. Screenshots sample the asserted state at capture time:
// every claimed compact text node (company name, job title, badge, notice, heading, empty-state text)
// must be visible, fully inside the viewport and clear of fixed overlays, which is a geometry fact about
// that instant, not continuous-frame proof or a substitute for reading the images. Nothing here measures
// physical clone bytes or timing.
//
// Clock discipline (all3 correction direction): an asserted deadline is always crossed with runFor
// from a paused clock, so the Worker request carries exactly that literal instant. pauseAt and
// fastForward move due timers to the jump destination and are used only across intervals without an
// asserted boundary. A newly decoded revision publishes through the presentation queue's faked 120 ms
// idle timer, so the clock is advanced explicitly after each decode receipt is observed. Wall-clock
// skips (E3) happen on a paused clock.

const firstMonitor = '/api/catalog/progress?id=00000000-0000-4000-8000-000000000067&after=1'
const finalMonitor = '/api/catalog/progress?id=00000000-0000-4000-8000-000000000067&after=2'
const forced = '/api/catalog?source=public&refresh=1'
const ASTER = { company: 'Aster QA Labs', titles: ['Backend Engineer — Atlas Alpha'] }
const CEDAR = { company: 'Cedar QA Works', titles: ['Backend Engineer — Beacon London Final'] }
const BIRCH = { company: 'Birch QA Systems', titles: ['Backend Engineer — Beacon London'] }
const BADGE = '이전 조회 공고'
/**
 * E2 chronology only. The page clock is moved to this instant before navigation, so the open
 * collection starts 20 s before Aster's unchanged 08:30:00.000 deadline: the stream's real
 * ten-minute lifetime and each monitor's thirty-second lifetime stay valid while every boundary is
 * crossed on a frozen clock. Job, board and catalog freshness timestamps and AGING_AT are untouched.
 */
const E2_CLOCK_START = '2026-09-24T08:29:40.000Z'
/** Fresh arrival instants on the frozen clock; each lies before that company's own stale deadline. */
const E2_BIRCH_RESPONSE = '2026-09-24T08:30:00.500Z'
const E2_CEDAR_RESPONSE = '2026-09-24T08:30:01.500Z'
/** CatalogPresentationQueue idle eligibility after an enqueue (test-side literal, not a timing claim). */
const PRESENTATION_DELAY = 120
const retry = (page: Page) => page.getByRole('button', { name: '다시 조회', exact: true })
const summary = (page: Page) => page.locator('.active-filter-summary')
const stats = (page: Page) => page.locator('.map-stats strong')
const counts = (page: Page) => page.locator('.city-detail-count strong')
const badges = (page: Page) => page.locator('.company-card .stale-job-badge')
const cards = (page: Page) => page.locator('.company-card')
const progress = (page: Page) => page.locator('.catalog-collecting progress')
const nav = (page: Page) => page.getByRole('navigation', { name: '주요 메뉴' })
const flags = (ids: string[], stale: boolean | null) => ids.map(id => ({ id, stale }))
const compareRow = (page: Page, label: string) => page.getByRole('row')
  .filter({ has: page.locator('.comparison-row-label strong', { hasText: new RegExp(`^${label}$`) }) })
  .locator('.comparison-value')
type Transport = Awaited<ReturnType<typeof installCatalogWorkerTransport>>
test.setTimeout(90000)

async function serverMode(page: Page) {
  return readServerMode(page.request, new URL('/api/health', page.url()).href)
}

/** Fixed-position chrome that can cover scrolled content in the sampled image: mobile bottom bar, desktop summary, toasts. */
const FIXED_OVERLAYS = '.main-nav, .active-filter-summary, .toast'
type Company = { company: string; titles: string[] }
const SLUG = new Map<Company, string>([[ASTER, 'aster'], [CEDAR, 'cedar'], [BIRCH, 'birch']])

/**
 * Sample the asserted state. Every claimed locator is a compact text-bearing node (company name, job
 * title, stale badge, notice paragraph, heading or empty-state text). The scroll anchor is the first
 * claimed node's enclosing company card when it has one, otherwise that node itself, moved to the start
 * of its scroll container by ordinary scrolling (DEV-CAPTURE-1: anchoring the compact h3 itself left it
 * at the desktop results scrollport edge with a 0.9930555820465088 intersection in the first DEV run; the
 * existing card padding and 16 px scroll margin keep the claimed nodes inside, and the page's own scroll
 * padding keeps them clear of the mobile bottom bar); every claimed node must then be visible, fully
 * inside the viewport (ratio 1) and not intersecting any fixed overlay, so a clipped or covered badge or
 * name fails the capture instead of being claimed. Callers split required content into separate named
 * samples; nothing is hidden or rewritten. A passing check is a geometry fact about the sampled instant,
 * not a readability review.
 */
async function capture(page: Page, info: TestInfo, name: string, claimed: Locator[]) {
  await claimed[0].evaluate(element => (element.closest('.company-card') ?? element).scrollIntoView({ block: 'start', inline: 'nearest' }))
  for (const locator of claimed) {
    await expect(locator).toBeVisible()
    await expect(locator).toBeInViewport({ ratio: 1 })
  }
  const overlays = await page.evaluate(selector => [...document.querySelectorAll<HTMLElement>(selector)]
    .filter(element => getComputedStyle(element).position === 'fixed' && element.getClientRects().length > 0)
    .map(element => { const rect = element.getBoundingClientRect(); return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom } }), FIXED_OVERLAYS)
  for (const locator of claimed) {
    const box = (await locator.boundingBox())!
    for (const overlay of overlays) {
      const covered = box.x < overlay.right && overlay.left < box.x + box.width && box.y < overlay.bottom && overlay.top < box.y + box.height
      expect(covered, `${name}: a claimed node must not be covered by fixed UI`).toBe(false)
    }
  }
  const path = info.outputPath(`${name}.png`)
  await page.screenshot({ path })
  await info.attach(`${name}.png`, { path, contentType: 'image/png' })
}

/** The compact claimed nodes of one company card: its name, first job title and, when claimed, its stale badge. */
async function cardClaims(page: Page, index: number, company: Company, badge: boolean) {
  const card = cards(page).nth(index)
  await expect(card.locator('h3')).toHaveText(company.company)
  await expect(card.locator('.mini-job-title').first()).toHaveText(company.titles[0])
  if (badge) await expect(card.locator('.stale-job-badge').first()).toHaveText(BADGE)
  return [card.locator('h3'), card.locator('.mini-job-title').first(), ...(badge ? [card.locator('.stale-job-badge').first()] : [])]
}

/** One named sample per company card, so three cards never have to share one viewport. */
async function captureEachCard(page: Page, info: TestInfo, name: (phase: string) => string, phase: string, companies: Company[], badge: boolean) {
  for (const [index, company] of companies.entries()) {
    await capture(page, info, name(`${phase}-${SLUG.get(company)}`), await cardClaims(page, index, company, badge))
  }
}

/** One sample claiming several cards together (names, titles and badges), for groups expected to share a viewport. */
async function captureCards(page: Page, info: TestInfo, name: string, companies: Company[], badge: boolean) {
  const claimed: Locator[] = []
  for (const [index, company] of companies.entries()) claimed.push(...await cardClaims(page, index, company, badge))
  await capture(page, info, name, claimed)
}

async function expectHealth(page: Page, expected: [string, string, string]) {
  await page.locator('.data-status-button').click()
  await expect(page.getByRole('dialog').locator('.collection-health dd')).toHaveText(expected)
}

function expectFlagOnly(reply: ObservedReply, stale: { id: string; stale: boolean | null }[], removed: string[] = []) {
  expect(reply.protocol).toBe(1)
  expect(reply.bodyIds).toEqual([])
  expect(reply.bodyChars).toBe(0)
  expect(reply.staleUpdates).toEqual(stale)
  expect(reply.removed).toEqual(removed)
}

const isGenuineProjection = (reply: ObservedReply) => reply.requestKind === 'project' && reply.kind === 'projected' && reply.synthetic === null

/** The first genuine projected reply for a decoded revision (the arrival projection, before any same-revision replay). */
async function projectedRevision(transport: Transport, revision: number) {
  let found: ObservedReply | undefined
  await expect.poll(async () => {
    found = (await transport.replies()).find(reply => isGenuineProjection(reply) && reply.revision === revision)
    return found !== undefined
  }).toBe(true)
  return found!
}

/** The decode receipt for a revision; its continuations (presentation enqueue, next monitor wait) are armed before the next clock step. */
async function expectDecoded(transport: Transport, revision: number) {
  await expect.poll(async () => (await transport.replies()).some(reply => reply.kind === 'decoded' && reply.revision === revision)).toBe(true)
}

/** Wait until every project request of a Worker has its genuine reply and the view is not searching; return the ledger. */
async function settledProjections(page: Page, transport: Transport, worker = 1) {
  let ledger: { requests: number; replies: number; last: ObservedReply | undefined } = { requests: 0, replies: 0, last: undefined }
  await expect.poll(async () => {
    const requests = (await transport.requests()).filter(request => request.worker === worker && request.kind === 'project')
    const replies = (await transport.replies()).filter(reply => reply.worker === worker && isGenuineProjection(reply))
    ledger = { requests: requests.length, replies: replies.length, last: replies.at(-1) }
    return requests.length > 0 && requests.length === replies.length
  }).toBe(true)
  await expect(summary(page)).toHaveAttribute('aria-busy', 'false')
  return ledger
}

/**
 * Explicit frozen chronology. advanceTo()/advanceBy() use runFor, so every timer fires at its own
 * instant and an asserted boundary's Worker request carries exactly that literal time. jumpTo() uses
 * pauseAt only for a long interval without an asserted boundary (due timers would fire once at the
 * destination, and the app's faked 1 s countdown interval and animation frames must not be replayed
 * across hours). skipWallClockTo() changes only the wall clock while paused, like a throttled hidden tab.
 */
function frozenClock(page: Page, start: string) {
  let current = Date.parse(start)
  const forward = (time: string) => {
    const target = Date.parse(time)
    if (target < current) throw new Error(`Chronology moves backwards to ${time}`)
    return target
  }
  return {
    async pause() { await page.clock.pauseAt(new Date(current)) },
    async advanceTo(time: string) { const target = forward(time); await page.clock.runFor(target - current); current = target },
    async advanceBy(milliseconds: number) { await page.clock.runFor(milliseconds); current += milliseconds },
    async jumpTo(time: string) { const target = forward(time); await page.clock.pauseAt(new Date(target)); current = target },
    async skipWallClockTo(time: string) { await page.clock.setSystemTime(new Date(time)); current = Date.parse(time) },
  }
}

for (const width of [1440, 320]) test.describe(`real Worker aging transport at ${width}px`, () => {
  test.use({ viewport: { width, height: 960 } })

  test('sequential stale boundaries, exact 24 h, partial and total expiry move only flags and removals while the visible catalog ages exactly', async ({ page, catalogWorker }, info) => {
    const transport = await installCatalogWorkerTransport(page)
    catalogWorker.respond(route => route.fulfill({ json: withRefreshAfter(catalogWorkerCatalog(), FAR_REFRESH_AFTER) }))
    await catalogWorker.open({ filters: { role: 'backend' }, saved: catalogWorkerSaved() })
    const initial = await expectInitialCatalogRequest(page, catalogWorker.traffic)
    const mode = await serverMode(page)
    const name = (phase: string) => `catalog-worker-aging-${width}-${mode}-sequential-${phase}`
    await companies(page, [ASTER, CEDAR, BIRCH])
    await expect(counts(page)).toHaveText(['3', '3'])
    await expect(stats(page)).toHaveText(['3곳', '2곳'])
    await expect(summary(page)).toContainText('5개 공고가 현재 조건에 맞아요')
    await expect(badges(page)).toHaveCount(0)
    const saved = await readSavedJson(page)
    const state = await exploration(page)
    const first = (await transport.replies()).filter(isGenuineProjection)
    expect(first.length).toBeGreaterThan(0)
    expect(first[0]).toMatchObject({ protocol: 1, bodyIds: AGING_JOB_IDS, staleUpdates: [], removed: [] })
    expect((await transport.requests()).filter(request => request.kind === 'project').every(request => request.protocol === 1)).toBe(true)

    const clock = frozenClock(page, AGING_AT.stillFresh)
    await clock.pause()
    await expect(badges(page)).toHaveCount(0)
    await clock.advanceTo(AGING_AT.asterStale)
    await expect(badges(page)).toHaveText([BADGE])
    await expect(cards(page).first()).toContainText('Aster QA Labs')
    await expect(cards(page).first().locator('.stale-job-badge')).toHaveText(BADGE)
    await expect(page.locator('.catalog-notice')).toContainText(AGE_NOTICE)
    await expect(page.locator('.catalog-notice')).toContainText('이전 조회 공고 3개를 포함합니다.')
    const asterStale = await transport.projectReplyAt(AGING_AT.asterStale)
    expectFlagOnly(asterStale, flags(ASTER_IDS, true))
    expect(asterStale.jobIds).toEqual(AGING_JOB_IDS)
    await captureCards(page, info, name('first-stale'), [ASTER], true)
    await capture(page, info, name('first-stale-notice'), [page.locator('.catalog-notice p')])

    await clock.advanceTo(AGING_AT.birchStale)
    await expect(badges(page)).toHaveText([BADGE, BADGE])
    const birchStale = await transport.projectReplyAt(AGING_AT.birchStale)
    expectFlagOnly(birchStale, flags(BIRCH_IDS, true))
    // Aster stays a live member; only its redundant body and flag are absent from this reply.
    expect(birchStale.jobIds).toEqual(AGING_JOB_IDS)

    await clock.advanceTo(AGING_AT.cedarStale)
    await expect(badges(page)).toHaveText([BADGE, BADGE, BADGE])
    const cedarStale = await transport.projectReplyAt(AGING_AT.cedarStale)
    expectFlagOnly(cedarStale, flags(CEDAR_IDS, true))
    await expectHealth(page, ['0개 공고', '9개 공고', '0개'])
    await close(page)
    if (width === 1440) {
      await nav(page).getByRole('button', { name: /도시 비교/ }).click()
      await page.getByRole('button', { name: '회사 많은 3개 도시', exact: true }).click()
      await expect(page.locator('.comparison-city h2')).toHaveText(['런던', '베를린'])
      await expect(compareRow(page, '추천 회사')).toHaveText(['3곳', '1곳', '—'])
      await expect(compareRow(page, '공고 조회 상태').nth(0)).toContainText('0개 최근 조회')
      await expect(compareRow(page, '공고 조회 상태').nth(0)).toContainText('3개 이전 조회 공고 포함')
      await nav(page).getByRole('button', { name: '기회 탐색', exact: true }).click()
      await companies(page, [ASTER, CEDAR, BIRCH])
    }
    await captureEachCard(page, info, name, 'all-stale', [ASTER, CEDAR, BIRCH], true)

    await page.getByRole('button', { name: 'Backend Engineer — Atlas Alpha', exact: true }).click()
    await expect(page.locator('.job-freshness-notice')).toContainText('이전 조회 결과를 보고 있어요')
    await expect(page.getByLabel('이 기회에 대한 나의 메모', { exact: true })).toHaveValue(CATALOG_WORKER_NOTE)
    await expect(page.getByRole('button', { name: '지원 완료로 표시됨', exact: true })).toBeVisible()
    await close(page)

    // No deadline lies between Cedar's stale boundary and exactly 24 hours after Aster's snapshot.
    await clock.jumpTo(AGING_AT.asterExactly24h)
    await companies(page, [ASTER, CEDAR, BIRCH])
    await clock.advanceTo(AGING_AT.asterExpired)
    await companies(page, [CEDAR, BIRCH])
    await expect(counts(page)).toHaveText(['2', '2'])
    await expect(stats(page)).toHaveText(['2곳', '2곳'])
    await expect(summary(page)).toContainText('3개 공고가 현재 조건에 맞아요')
    await expect(badges(page)).toHaveText([BADGE, BADGE])
    const asterGone = await transport.projectReplyAt(AGING_AT.asterExpired)
    expectFlagOnly(asterGone, [], ASTER_IDS)
    expect(asterGone.jobIds).toEqual([...BIRCH_IDS, ...CEDAR_IDS])
    await expectHealth(page, ['0개 공고', '6개 공고', '1개'])
    await expect(page.getByRole('dialog').locator('.board-row').filter({ hasText: 'Aster QA Labs' })).toContainText('확인 기간 지남')
    await close(page)
    await captureCards(page, info, name('aster-expired'), [CEDAR, BIRCH], true)

    await clock.advanceTo(AGING_AT.birchExpired)
    await companies(page, [CEDAR])
    await expect(counts(page)).toHaveText(['1', '1'])
    expectFlagOnly(await transport.projectReplyAt(AGING_AT.birchExpired), [], BIRCH_IDS)

    await clock.advanceTo(AGING_AT.cedarExpired)
    const expired = page.getByRole('heading', { name: EXPIRED_TITLE, exact: true })
    await expect(expired).toBeVisible()
    await expect(page.locator('.catalog-placeholder')).toContainText('24시간을 지나')
    await expect(page.locator('.company-card, .flat-marker, .recovery-option')).toHaveCount(0)
    await expect(stats(page)).toHaveText(['—곳', '—곳'])
    const cedarGone = await transport.projectReplyAt(AGING_AT.cedarExpired)
    expectFlagOnly(cedarGone, [], CEDAR_IDS)
    expect(cedarGone.jobIds).toEqual([])
    await capture(page, info, name('expired'), [expired, page.locator('.catalog-placeholder .empty-state > p')])

    expect(await exploration(page)).toEqual(state)
    expect(await readSavedJson(page)).toBe(saved)
    const projected = (await transport.replies()).filter(isGenuineProjection)
    expect(projected.slice(1).every(reply => reply.bodyIds?.length === 0)).toBe(true)
    await catalogWorker.expectPaths(initial.attempts, [])
    await transport.attach(info, `${name('transport')}.json`, { width, mode, case: 'sequential' })
  })

  test('a corrupt superseded Canvas reply (synthetic) ends the client while Beacon is the newer intent; the anchor survives and explicit recovery shows Beacon results', async ({ page, catalogWorker }, info) => {
    const transport = await installCatalogWorkerTransport(page)
    catalogWorker.respond(route => route.fulfill({ json: withRefreshAfter(catalogWorkerCatalog(), FAR_REFRESH_AFTER) }))
    await catalogWorker.open({ filters: { query: 'Atlas Alpha' }, saved: catalogWorkerSaved() })
    const initial = await expectInitialCatalogRequest(page, catalogWorker.traffic)
    const mode = await serverMode(page)
    const name = (phase: string) => `catalog-worker-aging-${width}-${mode}-superseded-${phase}`
    await companies(page, [ASTER])
    const saved = await readSavedJson(page)
    const state = await exploration(page)

    await transport.hold('project')
    await query(page).fill('Atlas Canvas')
    await expect.poll(() => transport.held('project')).toMatchObject([{ worker: 1, kind: 'project', query: 'Atlas Canvas' }])
    const [canvas] = await transport.held('project')
    await query(page).fill('Beacon London')
    await expect(summary(page)).toHaveAttribute('aria-busy', 'true')
    // Exactly one Worker project is outstanding (Canvas); Beacon is a queued hook intent.
    const requestsBefore = (await transport.requests()).filter(request => request.kind === 'project')
    expect(requestsBefore.at(-1)).toMatchObject({ worker: 1, id: canvas!.id, query: 'Atlas Canvas' })
    expect(requestsBefore.filter(request => request.query === 'Beacon London')).toHaveLength(0)
    expect(await transport.held('project')).toHaveLength(1)

    // SYNTHETIC CORRUPTION of a structured clone of the genuine Canvas reply.
    await transport.releaseOne('project', 'unknown-stale-id')
    await expect(page.locator('.catalog-notice')).toContainText(WORKER_FAILURE_MESSAGE)
    await expectRecommendationsUnavailable(page)
    await expect(query(page)).toHaveValue('Beacon London')
    await expect(retry(page)).toBeEnabled()
    expect(await readSavedJson(page)).toBe(saved)
    expect(await exploration(page)).toMatchObject({ selectedId: state.selectedId, filters: { query: 'Beacon London' } })
    expect(await transport.workers()).toEqual([{ id: 1, terminated: true, messageListeners: 1 }])
    const requestsAfter = (await transport.requests()).filter(request => request.kind === 'project' && request.worker === 1)
    expect(requestsAfter).toHaveLength(requestsBefore.length)
    expect(requestsAfter.filter(request => request.query === 'Beacon London')).toHaveLength(0)
    await capture(page, info, name('unavailable'), [
      page.getByRole('heading', { name: UNAVAILABLE_TITLE, exact: true }), page.getByText(UNAVAILABLE_TEXT, { exact: true }),
    ])

    // Same-request delayed delivery of the retained genuine Canvas reply after the injected corruption.
    expect(await transport.replay(1, canvas!.id)).toBe(true)
    const replayed = (await transport.dispatches()).find(dispatch => dispatch.replay && dispatch.worker === 1 && dispatch.id === canvas!.id)
    expect(replayed).toMatchObject({ dispatched: true, synthetic: null })
    expect(replayed!.listeners).toBeGreaterThanOrEqual(1)
    await page.clock.fastForward(2000)
    await expectRecommendationsUnavailable(page)
    await expect(page.getByRole('button', { name: 'Frontend Engineer — Atlas Canvas', exact: true })).toHaveCount(0)

    // The last published anchor is intact: the same conditions show it again.
    await query(page).fill('Atlas Alpha')
    await companies(page, [ASTER])
    await expect(summary(page)).toContainText('1개 공고가 현재 조건에 맞아요')
    await captureCards(page, info, name('anchor'), [ASTER], false)
    await query(page).fill('Beacon London')
    await expectRecommendationsUnavailable(page)
    await catalogWorker.expectPaths(initial.attempts, [])

    // The deliberate hold has done its work and nothing is held any more; the replacement Worker's
    // genuine reply must flow, so the shared hold is ended before the explicit recovery is awaited.
    expect(await transport.endHold('project')).toBe(0)
    await retry(page).click()
    await companies(page, [CEDAR, BIRCH])
    await expect(counts(page)).toHaveText(['2', '2'])
    await expect(page.locator('.catalog-notice')).toHaveCount(0)
    const workers = await transport.workers()
    expect(workers).toHaveLength(2)
    expect(workers.filter(worker => !worker.terminated)).toEqual([{ id: 2, terminated: false, messageListeners: 1 }])
    expect(await readSavedJson(page)).toBe(saved)
    await captureCards(page, info, name('recovered'), [CEDAR, BIRCH], false)
    await catalogWorker.expectPaths(initial.attempts, [forced])
    await transport.attach(info, `${name('transport')}.json`, { width, mode, case: 'superseded-corrupt-canvas', canvasRequestId: canvas!.id })
  })

  test('progressive company arrivals after an earlier stale boundary carry only new bodies while flags follow each boundary', async ({ page, catalogWorker }, info) => {
    const transport = await installCatalogWorkerTransport(page)
    // Near-boundary clock control before navigation; the fixture, its deadlines and the harness defaults are unchanged.
    await page.clock.setSystemTime(new Date(E2_CLOCK_START))
    await catalogWorker.open({ filters: { role: 'backend' } })
    const initial = await expectInitialCatalogRequest(page, catalogWorker.traffic)
    const mode = await serverMode(page)
    const name = (phase: string) => `catalog-worker-aging-${width}-${mode}-progressive-${phase}`
    await companies(page, [ASTER])
    await expect(badges(page)).toHaveCount(0)
    await expect(progress(page)).toHaveAttribute('value', '1')
    const opening = (await transport.replies()).filter(isGenuineProjection)
    expect(opening[0]).toMatchObject({ protocol: 1, bodyIds: ASTER_IDS, staleUpdates: [], removed: [], jobIds: ASTER_IDS })

    // Freeze just before Aster's deadline, then cross it exactly; the collection stays open and well inside its lifetime.
    const clock = frozenClock(page, AGING_AT.stillFresh)
    await clock.pause()
    await expect(badges(page)).toHaveCount(0)
    await clock.advanceTo(AGING_AT.asterStale)
    await expect(badges(page)).toHaveText([BADGE])
    const asterStale = await transport.projectReplyAt(AGING_AT.asterStale)
    expectFlagOnly(asterStale, flags(ASTER_IDS, true))
    expect(asterStale.jobIds).toEqual(ASTER_IDS)

    // Birch arrives fresh. The first monitor must already be pending: no silent fast-forward is allowed here.
    await clock.advanceTo(E2_BIRCH_RESPONSE)
    const first = await catalogWorker.takeProgress(1, { fastForward: false })
    await first.fulfill({ json: catalogWorkerUpdate(2) })
    await expectDecoded(transport, 2)
    await clock.advanceBy(PRESENTATION_DELAY)
    await companies(page, [ASTER, BIRCH])
    await expect(progress(page)).toHaveAttribute('value', '2')
    await expect(badges(page)).toHaveText([BADGE])
    const second = await projectedRevision(transport, 2)
    expect(second).toMatchObject({ bodyIds: BIRCH_IDS, staleUpdates: [], removed: [], jobIds: [...ASTER_IDS, ...BIRCH_IDS] })
    expect(second.now).toBeGreaterThanOrEqual(Date.parse(E2_BIRCH_RESPONSE))
    expect(second.now).toBeLessThan(Date.parse(AGING_AT.birchStale))

    // Birch's own deadline, settled separately.
    await clock.advanceTo(AGING_AT.birchStale)
    await expect(badges(page)).toHaveText([BADGE, BADGE])
    const birchStale = await transport.projectReplyAt(AGING_AT.birchStale)
    expectFlagOnly(birchStale, flags(BIRCH_IDS, true))
    expect(birchStale.jobIds).toEqual([...ASTER_IDS, ...BIRCH_IDS])

    // Cedar arrives fresh once the second monitor (armed one second after Birch was read) is pending.
    await clock.advanceTo(E2_CEDAR_RESPONSE)
    const last = await catalogWorker.takeProgress(2, { fastForward: false })
    await last.fulfill({ json: catalogWorkerUpdate(3) })
    await expectDecoded(transport, 3)
    await clock.advanceBy(PRESENTATION_DELAY)
    await companies(page, [ASTER, CEDAR, BIRCH])
    await expect(progress(page)).toHaveCount(0)
    await expect(badges(page)).toHaveText([BADGE, BADGE])
    const third = await projectedRevision(transport, 3)
    expect(third).toMatchObject({ bodyIds: CEDAR_IDS, staleUpdates: [], removed: [], jobIds: AGING_JOB_IDS })
    expect(third.now).toBeGreaterThanOrEqual(Date.parse(E2_CEDAR_RESPONSE))
    expect(third.now).toBeLessThan(Date.parse(AGING_AT.cedarStale))

    await clock.advanceTo(AGING_AT.cedarStale)
    await expect(badges(page)).toHaveText([BADGE, BADGE, BADGE])
    const cedarStale = await transport.projectReplyAt(AGING_AT.cedarStale)
    expectFlagOnly(cedarStale, flags(CEDAR_IDS, true))
    expect(cedarStale.jobIds).toEqual(AGING_JOB_IDS)

    const replies = (await transport.replies()).filter(isGenuineProjection)
    // Every body crossed exactly once, in its own arrival; every flag followed its company's own boundary exactly once.
    expect(replies.filter(reply => reply.bodyIds!.some(id => ASTER_IDS.includes(id)))).toHaveLength(1)
    expect(replies.filter(reply => reply.bodyIds!.some(id => BIRCH_IDS.includes(id)))).toHaveLength(1)
    expect(replies.filter(reply => reply.bodyIds!.some(id => CEDAR_IDS.includes(id)))).toHaveLength(1)
    expect(replies.flatMap(reply => reply.staleUpdates!).filter(update => ASTER_IDS.includes(update.id))).toEqual(flags(ASTER_IDS, true))
    expect(replies.flatMap(reply => reply.staleUpdates!).filter(update => BIRCH_IDS.includes(update.id))).toEqual(flags(BIRCH_IDS, true))
    expect(replies.flatMap(reply => reply.staleUpdates!).filter(update => CEDAR_IDS.includes(update.id))).toEqual(flags(CEDAR_IDS, true))
    await captureEachCard(page, info, name, 'final', [ASTER, CEDAR, BIRCH], true)
    await catalogWorker.expectPaths(initial.attempts, [firstMonitor, finalMonitor])
    await transport.attach(info, `${name('transport')}.json`, { width, mode, case: 'progressive', clockStart: E2_CLOCK_START })
  })

  test('a visible return after skipped timers issues exactly one corrective projection with removals and flags only, and no request', async ({ page, catalogWorker }, info) => {
    const transport = await installCatalogWorkerTransport(page)
    catalogWorker.respond(route => route.fulfill({ json: withRefreshAfter(catalogWorkerCatalog(), FAR_REFRESH_AFTER) }))
    await catalogWorker.open({ filters: { role: 'backend' } })
    const initial = await expectInitialCatalogRequest(page, catalogWorker.traffic)
    const mode = await serverMode(page)
    const name = (phase: string) => `catalog-worker-aging-${width}-${mode}-return-${phase}`
    await companies(page, [ASTER, CEDAR, BIRCH])
    await expect(badges(page)).toHaveCount(0)

    // Freeze before any deadline and settle the observer baseline while nothing can project.
    const clock = frozenClock(page, AGING_AT.stillFresh)
    await clock.pause()
    const baseline = await settledProjections(page, transport)
    // Move the wall clock without running any timer, like a throttled hidden tab.
    await clock.skipWallClockTo(AGING_AT.asterExpired)
    await expect(cards(page).locator('h3')).toHaveText(['Aster QA Labs', 'Cedar QA Works', 'Birch QA Systems'])
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
    await companies(page, [CEDAR, BIRCH])
    await expect(counts(page)).toHaveText(['2', '2'])
    await expect(badges(page)).toHaveText([BADGE, BADGE])
    const corrective = await transport.projectReplyAt(AGING_AT.asterExpired)
    expectFlagOnly(corrective, flags([...BIRCH_IDS, ...CEDAR_IDS], true), ASTER_IDS)
    expect(corrective.jobIds).toEqual([...BIRCH_IDS, ...CEDAR_IDS])
    // Exactly one correlated genuine request/reply pair in the frozen foreground interval.
    const settled = await settledProjections(page, transport)
    expect(settled.requests - baseline.requests).toBe(1)
    expect(settled.replies - baseline.replies).toBe(1)
    expect(settled.last).toMatchObject({ worker: 1, id: corrective.id, now: Date.parse(AGING_AT.asterExpired) })
    await captureCards(page, info, name('survivors'), [CEDAR, BIRCH], true)

    // Birch and Cedar then expire legitimately while aging still issues no request.
    await clock.advanceBy(5000)
    const expired = page.getByRole('heading', { name: EXPIRED_TITLE, exact: true })
    await expect(expired).toBeVisible()
    await expect(page.locator('.catalog-placeholder')).toContainText('24시간을 지나')
    await expect(page.locator('.company-card, .flat-marker, .recovery-option')).toHaveCount(0)
    await expect(stats(page)).toHaveText(['—곳', '—곳'])
    await capture(page, info, name('expired'), [expired, page.locator('.catalog-placeholder .empty-state > p')])
    await catalogWorker.expectPaths(initial.attempts, [])
    await transport.attach(info, `${name('transport')}.json`, { width, mode, case: 'foreground-return', correctiveRequestId: corrective.id })
  })

  test('sizable fictional bodies cross the real Worker once; Aster, Birch and Cedar boundaries each move only flags', async ({ page, catalogWorker }, info) => {
    const transport = await installCatalogWorkerTransport(page)
    catalogWorker.respond(route => route.fulfill({ json: withRefreshAfter(agingSizableCatalog(), FAR_REFRESH_AFTER) }))
    await catalogWorker.open({ filters: { role: 'backend' } })
    const initial = await expectInitialCatalogRequest(page, catalogWorker.traffic)
    const mode = await serverMode(page)
    const name = (phase: string) => `catalog-worker-aging-${width}-${mode}-sizable-${phase}`
    await companies(page, [ASTER, CEDAR, BIRCH])
    const first = (await transport.replies()).find(isGenuineProjection)!
    expect(first.bodyIds).toEqual(AGING_JOB_IDS)
    expect(first.bodyChars).toBe(SIZABLE_BODY_CHARS)

    const clock = frozenClock(page, AGING_AT.stillFresh)
    await clock.pause()
    await expect(badges(page)).toHaveCount(0)
    for (const [time, ids, count] of [[AGING_AT.asterStale, ASTER_IDS, 1], [AGING_AT.birchStale, BIRCH_IDS, 2], [AGING_AT.cedarStale, CEDAR_IDS, 3]] as const) {
      await clock.advanceTo(time)
      await expect(badges(page)).toHaveText(Array<string>(count).fill(BADGE))
      const reply = await transport.projectReplyAt(time)
      expectFlagOnly(reply, flags([...ids], true))
      expect(reply.jobIds).toEqual(AGING_JOB_IDS)
    }
    const projected = (await transport.replies()).filter(isGenuineProjection)
    expect(projected.slice(1).every(reply => reply.bodyIds?.length === 0 && reply.bodyChars === 0)).toBe(true)
    expect(projected.reduce((sum, reply) => sum + (reply.bodyChars ?? 0), 0)).toBe(SIZABLE_BODY_CHARS)
    await catalogWorker.expectPaths(initial.attempts, [])
    await captureEachCard(page, info, name, 'all-stale', [ASTER, CEDAR, BIRCH], true)
    await transport.attach(info, `${name('transport')}.json`, { width, mode, case: 'sizable-bodies', expectedInitialBodyChars: SIZABLE_BODY_CHARS })
  })
})
