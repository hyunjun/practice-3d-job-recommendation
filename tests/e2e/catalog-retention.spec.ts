import { expect } from '@playwright/test'
import type { Page, Route } from '@playwright/test'
import type { Catalog } from '../../shared/types'
import {
  CATALOG_WORKER_NOTE, catalogWorkerCatalog, catalogWorkerRevised, catalogWorkerSaved, catalogWorkerUpdate,
} from '../fixtures/catalog-worker'
import { expectInitialCatalogRequest } from './helpers/api-requests'
import {
  catalogWorkerClose as close, catalogWorkerExploration as exploration, catalogWorkerQuery as query,
  catalogWorkerTest as test, expectCatalogWorkerCompanies as companies,
} from './helpers/catalog-worker'
import type { CatalogWorkerHarness } from './helpers/catalog-worker'
import { installCatalogWorkerControl } from './helpers/catalog-worker-control'
import {
  AGE_NOTICE, ASTER_EXACT_24H, ASTER_EXPIRES, CEDAR_EXPIRES, EXPIRED_TITLE, FAR_REFRESH_AFTER, RECOVERING_TITLE,
  UNAVAILABLE_TITLE, WORKER_FAILURE_MESSAGE,
  expectCompareUnavailable, expectRecommendationsUnavailable, expectRetainedNotice, retimed, withRefreshAfter,
} from './helpers/catalog-retention'
import { readSavedJson } from './helpers/saved-store'

// Stage73 contract c086205a…: retained recommendations after a fatal worker failure.
// Worker failures are raised as genuine browser Worker error events through the
// existing control helper; the server never sees personal content, and neither
// aging nor typing may start a collection request.
//
// Clock discipline: page.clock.pauseAt() stops the presentation debounce that every
// publication needs, so a test that expects a replacement to publish after a pause
// resumes real time first. Held network requests start only after long jumps.
const forced = '/api/catalog?source=public&refresh=1'
const ordinary = '/api/catalog?source=public'
const firstMonitor = '/api/catalog/progress?id=00000000-0000-4000-8000-000000000067&after=1'
const finalMonitor = '/api/catalog/progress?id=00000000-0000-4000-8000-000000000067&after=2'
const LOADING_TITLE = '공개 공고를 불러오고 있어요'
const nav = (page: Page) => page.getByRole('navigation', { name: '주요 메뉴' })
const retry = (page: Page) => page.getByRole('button', { name: '다시 조회', exact: true })
const summary = (page: Page) => page.locator('.active-filter-summary')
const stats = (page: Page) => page.locator('.map-stats strong')
const counts = (page: Page) => page.locator('.city-detail-count strong')
const badges = (page: Page) => page.locator('.company-card .stale-job-badge')
const applyButton = (page: Page) => page.locator('.filters-dialog .dialog-footer .button.primary')
const workerRequests = (page: Page) => page.evaluate(() => window.__catalogWorkerQA!.requests)
const compareRow = (page: Page, label: string) => page.getByRole('row')
  .filter({ has: page.locator('.comparison-row-label strong', { hasText: new RegExp(`^${label}$`) }) })
  .locator('.comparison-value')
const ASTER = { company: 'Aster QA Labs', titles: ['Backend Engineer — Atlas Alpha'] }
const CEDAR = { company: 'Cedar QA Works', titles: ['Backend Engineer — Beacon London Final'] }
const BIRCH = { company: 'Birch QA Systems', titles: ['Backend Engineer — Beacon London'] }
type WorkerControl = Awaited<ReturnType<typeof installCatalogWorkerControl>>
test.setTimeout(60000)

/**
 * Start a recovery whose first projection reply is held. Real time runs long
 * enough for the decode and the 120 ms presentation debounce, then the clock is
 * pinned at `pauseAtTime`, which the replacement's own deadline lies before.
 */
async function startHeldRecovery(page: Page, catalogWorker: CatalogWorkerHarness, worker: WorkerControl, catalog: Catalog, pauseAtTime: string) {
  await worker.hold('project')
  catalogWorker.respond(route => route.fulfill({ json: catalog }))
  await retry(page).click()
  await page.clock.resume()
  await expect.poll(() => worker.held('project')).toMatchObject([{ worker: 2, kind: 'project', revision: 1 }])
  await page.clock.pauseAt(new Date(pauseAtTime))
}

for (const width of [1440, 320]) test.describe(`retained recommendations after a worker failure at ${width}px`, () => {
  test.use({ viewport: { width, height: 960 } })

  test('displayed results survive the crash, expire company by company at exactly 24h and +1ms, and keep the saved record with its private context', async ({ page, catalogWorker }) => {
    const worker = await installCatalogWorkerControl(page)
    catalogWorker.respond(route => route.fulfill({ json: withRefreshAfter(catalogWorkerCatalog(), FAR_REFRESH_AFTER) }))
    await catalogWorker.open({ filters: { role: 'backend' }, saved: catalogWorkerSaved() })
    const initial = await expectInitialCatalogRequest(page, catalogWorker.traffic)
    await companies(page, [ASTER, CEDAR, BIRCH])
    await expect(counts(page)).toHaveText(['3', '3'])
    await expect(stats(page)).toHaveText(['3곳', '2곳'])
    await expect(summary(page)).toContainText('5개 공고가 현재 조건에 맞아요')
    const saved = await readSavedJson(page)
    const state = await exploration(page)

    await worker.crash()
    await expectRetainedNotice(page)
    // A local failure alone never waits for the anchor's far-future refreshAfter.
    await expect(retry(page)).toBeEnabled()
    await companies(page, [ASTER, CEDAR, BIRCH])
    await expect(summary(page)).toContainText('5개 공고가 현재 조건에 맞아요')
    await expect(summary(page)).toHaveAttribute('aria-busy', 'false')
    await expect(badges(page)).toHaveCount(0)

    await page.getByRole('button', { name: 'Backend Engineer — Atlas Alpha', exact: true }).click()
    await expect(page.getByLabel('이 기회에 대한 나의 메모', { exact: true })).toHaveValue(CATALOG_WORKER_NOTE)
    // Exactly 24 hours keeps Aster; one millisecond later removes it while the detail stays open.
    await page.clock.pauseAt(new Date(ASTER_EXACT_24H))
    await expect(page.locator('.job-freshness-notice')).toContainText('이전 조회 결과를 보고 있어요')
    await expect(page.locator('.company-card h3')).toHaveText(['Aster QA Labs', 'Cedar QA Works', 'Birch QA Systems'])
    await page.clock.runFor(1)
    await expect(page.locator('.job-freshness-notice')).toContainText('추천에서 제외된 조회 기록이에요')
    await expect(page.getByLabel('이 기회에 대한 나의 메모', { exact: true })).toHaveValue(CATALOG_WORKER_NOTE)
    await expect(page.getByRole('button', { name: '지원 완료로 표시됨', exact: true })).toBeVisible()
    await close(page)

    await companies(page, [CEDAR, BIRCH])
    await expect(counts(page)).toHaveText(['2', '2'])
    await expect(stats(page)).toHaveText(['2곳', '2곳'])
    await expect(summary(page)).toContainText('3개 공고가 현재 조건에 맞아요')
    await expect(summary(page)).toHaveAttribute('aria-busy', 'false')
    await expect(badges(page)).toHaveText(['이전 조회 공고', '이전 조회 공고'])
    await expectRetainedNotice(page)

    await page.clock.runFor(1000)
    await companies(page, [CEDAR])
    await expect(counts(page)).toHaveText(['1', '1'])
    await expect(stats(page)).toHaveText(['1곳', '1곳'])
    await expect(summary(page)).toContainText('1개 공고가 현재 조건에 맞아요')

    await page.clock.runFor(1000)
    await expect(page.getByRole('heading', { name: EXPIRED_TITLE, exact: true })).toBeVisible()
    await expect(page.locator('.catalog-placeholder')).toContainText('24시간을 지나')
    await expect(page.locator('.catalog-placeholder')).toContainText(WORKER_FAILURE_MESSAGE)
    await expect(page.locator('.company-card, .flat-marker, .recovery-option')).toHaveCount(0)
    await expect(stats(page)).toHaveText(['—곳', '—곳'])
    expect(await exploration(page)).toEqual(state)

    await nav(page).getByRole('button', { name: /^저장한 기회/ }).click()
    await expect(page.locator('.saved-title')).toHaveText(['Backend Engineer — Atlas Alpha'])
    await expect(page.locator('.saved-card .stale-job-badge')).toHaveText('확인 기간 지남')
    await expect(page.locator('.saved-status')).toHaveText(['지원 완료'])
    await expect(page.locator('.saved-note-preview')).toHaveText([CATALOG_WORKER_NOTE])
    expect(await readSavedJson(page)).toBe(saved)
    await nav(page).getByRole('button', { name: '기회 탐색', exact: true }).click()
    await expect(page.getByRole('heading', { name: EXPIRED_TITLE, exact: true })).toBeVisible()
    await catalogWorker.expectPaths(initial.attempts, [])

    // Publication needs the presentation debounce, so real time runs again from the expiry instant.
    await page.clock.resume()
    catalogWorker.respond(route => route.fulfill({ json: retimed(catalogWorkerCatalog(), CEDAR_EXPIRES) }))
    await retry(page).click()
    await companies(page, [ASTER, CEDAR, BIRCH])
    await expect(page.locator('.catalog-placeholder, .catalog-notice, .company-card .stale-job-badge')).toHaveCount(0)
    await expect(summary(page)).toContainText('5개 공고가 현재 조건에 맞아요')
    await expect(counts(page)).toHaveText(['3', '3'])
    expect(await readSavedJson(page)).toBe(saved)
    expect(await exploration(page)).toEqual(state)
    await catalogWorker.expectPaths(initial.attempts, [forced])
  })

  test('changed query, quick filter and profile withhold new-condition results with dashes, refuse preview, keep inputs and selection, and recovery applies the latest intent', async ({ page, catalogWorker }) => {
    const worker = await installCatalogWorkerControl(page)
    catalogWorker.respond(route => route.fulfill({ json: withRefreshAfter(catalogWorkerCatalog(), FAR_REFRESH_AFTER) }))
    await catalogWorker.open({ filters: { query: 'Atlas Alpha' } })
    const initial = await expectInitialCatalogRequest(page, catalogWorker.traffic)
    await companies(page, [ASTER])
    await worker.crash()
    await expectRetainedNotice(page)

    await query(page).fill('Beacon London')
    await expectRecommendationsUnavailable(page)
    await expect(summary(page)).toContainText(UNAVAILABLE_TITLE)
    await expect(query(page)).toHaveValue('Beacon London')
    await expect(retry(page)).toBeEnabled()
    await page.getByLabel('직무 필터', { exact: true }).selectOption('backend')
    await expectRecommendationsUnavailable(page)
    await page.getByRole('button', { name: /^모든 필터/ }).click()
    await expect(applyButton(page)).toHaveText('공고 수 확인 필요')
    await expect(applyButton(page)).toBeDisabled()
    await expect(page.locator('.filters-dialog .inline-note[role="alert"]')).toContainText('공고 연결을 다시 확인한 뒤 조건을 적용해 주세요.')
    await page.keyboard.press('Escape')

    await nav(page).getByRole('button', { name: /도시 비교/ }).click()
    await expectCompareUnavailable(page)
    await nav(page).getByRole('button', { name: '기회 탐색', exact: true }).click()
    await expectRecommendationsUnavailable(page)

    await page.getByRole('button', { name: '내 프로필 편집', exact: true }).click()
    await page.getByLabel('개발 경력', { exact: true }).fill('9')
    await page.getByRole('button', { name: '변경 사항 적용', exact: true }).click()
    await expectRecommendationsUnavailable(page)
    await expect(query(page)).toHaveValue('Beacon London')
    expect(await exploration(page)).toMatchObject({ selectedId: 'london', filters: { query: 'Beacon London', role: 'backend' } })
    await page.clock.fastForward(10000)
    await catalogWorker.expectPaths(initial.attempts, [])

    const held: Route[] = []
    catalogWorker.respond(route => { held.push(route) })
    await retry(page).click()
    await expect.poll(() => held.length).toBe(1)
    await expectRecommendationsUnavailable(page, RECOVERING_TITLE)
    await expect(page.locator('.data-status-button')).toContainText('공개 공고 조회 중')
    await held[0].fulfill({ json: catalogWorkerCatalog() })
    // Nine years of experience now ranks Birch's seven-year London posting first.
    await companies(page, [BIRCH, CEDAR])
    await expect(counts(page)).toHaveText(['2', '2'])
    await expect(summary(page)).toContainText('2개 공고가 현재 조건에 맞아요')
    await expect(page.locator('.catalog-notice')).toHaveCount(0)
    await expect(stats(page)).toHaveText(['2곳', '1곳'])
    await expect.poll(() => exploration(page)).toMatchObject({ selectedId: 'london', filters: { query: 'Beacon London', role: 'backend' } })
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('orbit.v1.profile') ?? '{}'))).toMatchObject({ years: 9 })
    await catalogWorker.expectPaths(initial.attempts, [forced])
  })
})

test('the anchor is the last displayed projection, not a hydrated reply that lost the latest-intent check', async ({ page, catalogWorker }) => {
  const worker = await installCatalogWorkerControl(page)
  catalogWorker.respond(route => route.fulfill({ json: withRefreshAfter(catalogWorkerCatalog(), FAR_REFRESH_AFTER) }))
  await catalogWorker.open({ filters: { query: 'Atlas Alpha' } })
  const initial = await expectInitialCatalogRequest(page, catalogWorker.traffic)
  await companies(page, [ASTER])
  await worker.hold('project')
  await query(page).fill('Atlas Canvas')
  await expect.poll(() => worker.held('project')).toMatchObject([{ filters: { query: 'Atlas Canvas' } }])
  await query(page).fill('Atlas Alpha')
  // The Canvas reply is delivered and hydrated, then dropped by the latest-intent check.
  await worker.releaseOne('project')
  await expect.poll(() => worker.held('project')).toMatchObject([{ filters: { query: 'Atlas Alpha' } }])
  await expect(page.getByRole('button', { name: 'Frontend Engineer — Atlas Canvas', exact: true })).toHaveCount(0)
  await worker.crash()
  await expectRetainedNotice(page)
  await companies(page, [ASTER])
  await expect(page.getByRole('button', { name: 'Frontend Engineer — Atlas Canvas', exact: true })).toHaveCount(0)
  await expect(summary(page)).toContainText('1개 공고가 현재 조건에 맞아요')
  await expect(summary(page)).toHaveAttribute('aria-busy', 'false')
  await expect(counts(page)).toHaveText(['1', '1'])

  await page.clock.pauseAt(new Date(ASTER_EXACT_24H))
  await companies(page, [ASTER])
  await page.clock.runFor(1)
  // Same intent, aged to nothing: a literal zero, not an expired catalog and not "unavailable".
  await expect(page.locator('.company-card')).toHaveCount(0)
  await expect(summary(page)).toContainText('0개 공고가 현재 조건에 맞아요')
  await expect(counts(page)).toHaveText(['0', '0'])
  await expect(stats(page)).toHaveText(['0곳', '0곳'])
  await expect(page.locator('.catalog-placeholder, .search-recovery')).toHaveCount(0)
  await expect(page.getByRole('heading', { name: UNAVAILABLE_TITLE, exact: true })).toHaveCount(0)
  await expect(query(page)).toHaveValue('Atlas Alpha')
  await catalogWorker.expectPaths(initial.attempts, [])
})

test('preview is refused throughout retention, never targets a recovering worker with the anchor revision, and a held recovery reply ends retention only when published', async ({ page, catalogWorker }) => {
  const worker = await installCatalogWorkerControl(page)
  await catalogWorker.open({ filters: { query: 'Beacon', role: 'backend' } })
  const initial = await expectInitialCatalogRequest(page, catalogWorker.traffic)
  await (await catalogWorker.takeProgress(1)).fulfill({ json: catalogWorkerUpdate(2) })
  await (await catalogWorker.takeProgress(2)).fulfill({ json: catalogWorkerUpdate(3) })
  await expect(page.locator('.catalog-collecting progress')).toHaveCount(0)
  await companies(page, [CEDAR, BIRCH])
  await page.getByRole('button', { name: /^모든 필터/ }).click()
  await expect(page.getByRole('button', { name: '4개 공고 보기', exact: true })).toBeEnabled()
  await page.keyboard.press('Escape')
  const before = await workerRequests(page)
  const previewsBefore = before.filter(request => request.kind === 'preview')
  expect(previewsBefore.length).toBeGreaterThan(0)
  expect(previewsBefore.every(request => request.worker === 1 && request.revision === 3)).toBe(true)

  await worker.crash()
  await expectRetainedNotice(page)
  await companies(page, [CEDAR, BIRCH])
  await page.getByRole('button', { name: /^모든 필터/ }).click()
  await expect(applyButton(page)).toHaveText('공고 수 확인 필요')
  await expect(applyButton(page)).toBeDisabled()
  await expect(page.locator('.filters-dialog .inline-note[role="alert"]')).toContainText('공고 연결을 다시 확인한 뒤 조건을 적용해 주세요.')
  await page.keyboard.press('Escape')

  await worker.hold('project')
  catalogWorker.respond(route => route.fulfill({ json: catalogWorkerCatalog() }))
  await retry(page).click()
  await expect.poll(() => worker.held('project')).toMatchObject([{ worker: 2, kind: 'project', revision: 1 }])
  await companies(page, [CEDAR, BIRCH])
  await expect(page.locator('.data-status-button')).toContainText('공개 공고 조회 중')
  await page.getByRole('button', { name: /^모든 필터/ }).click()
  await expect(applyButton(page)).toHaveText('공고 수 확인 필요')
  await expect(applyButton(page)).toBeDisabled()
  await page.keyboard.press('Escape')
  const during = await workerRequests(page)
  expect(during.filter(request => request.kind === 'preview')).toHaveLength(previewsBefore.length)
  expect(during.some(request => request.worker === 2 && request.revision === 3)).toBe(false)

  await worker.releaseAll('project')
  await expect(page.locator('.catalog-notice')).toHaveCount(0)
  await expect(page.locator('.data-status-button')).toContainText('공개 채용')
  await companies(page, [CEDAR, BIRCH])
  await page.getByRole('button', { name: /^모든 필터/ }).click()
  await expect(page.getByRole('button', { name: '4개 공고 보기', exact: true })).toBeEnabled()
  await page.keyboard.press('Escape')
  const after = await workerRequests(page)
  const recovered = after.filter(request => request.kind === 'preview' && request.worker === 2)
  expect(recovered.length).toBeGreaterThan(0)
  expect(recovered.every(request => request.revision === 1)).toBe(true)
  expect(after.some(request => request.worker === 2 && request.revision === 3)).toBe(false)
  const workers = await worker.workers()
  expect(workers).toHaveLength(2)
  expect(workers.filter(item => !item.terminated)).toHaveLength(1)
  await catalogWorker.expectPaths(initial.attempts, [firstMonitor, finalMonitor, forced])
})

test('a cancelled recovery from a second worker with a colliding revision cannot publish against the anchor; the aged anchor stays until an authorized replacement', async ({ page, catalogWorker }) => {
  const worker = await installCatalogWorkerControl(page)
  catalogWorker.respond(route => route.fulfill({ json: catalogWorkerCatalog() }))
  await catalogWorker.open({ filters: { query: 'Atlas Alpha' }, saved: catalogWorkerSaved() })
  const initial = await expectInitialCatalogRequest(page, catalogWorker.traffic)
  await companies(page, [ASTER])
  const saved = await readSavedJson(page)
  const state = await exploration(page)
  await worker.crash()
  await expectRetainedNotice(page)
  // Every 30-minute boundary passes with real time still flowing: the anchor is visibly aged.
  await page.clock.fastForward(31 * 60_000)
  await companies(page, [ASTER])
  await expect(badges(page)).toHaveText(['이전 조회 공고'])

  // Worker B decodes its own revision 1, which collides with worker A's displayed revision 1.
  await worker.hold('project')
  catalogWorker.respond(route => route.fulfill({ json: catalogWorkerRevised() }))
  await retry(page).click()
  await expect.poll(() => worker.held('project')).toMatchObject([{ worker: 2, kind: 'project', revision: 1 }])
  await companies(page, [ASTER])
  const workersAfterRetry = await worker.workers()
  expect(workersAfterRetry).toHaveLength(2)

  // Cancel the recovery while its projection is still held, then let the cancelled reply through.
  await nav(page).getByRole('button', { name: /^저장한 기회/ }).click()
  await expect(page.locator('.saved-title')).toHaveText(['Backend Engineer — Atlas Alpha'])
  await worker.releaseAll('project')
  await page.clock.fastForward(2000)
  await expect(page.locator('.saved-note-preview')).toHaveText([CATALOG_WORKER_NOTE])
  expect(await readSavedJson(page)).toBe(saved)

  const held: Route[] = []
  catalogWorker.respond(route => { held.push(route) })
  await nav(page).getByRole('button', { name: '기회 탐색', exact: true }).click()
  await expect.poll(() => held.length).toBe(1)
  // The old aged anchor is displayed; the cancelled revised replacement appears nowhere.
  await companies(page, [ASTER])
  await expect(badges(page)).toHaveText(['이전 조회 공고'])
  await expect(page.getByRole('button', { name: 'Backend Engineer — Atlas Alpha Revised', exact: true })).toHaveCount(0)
  await expect(page.locator('.data-status-button')).toContainText('공개 공고 조회 중')
  await expect(query(page)).toHaveValue('Atlas Alpha')
  expect(await exploration(page)).toEqual(state)
  expect((await worker.workers()).filter(item => !item.terminated)).toHaveLength(1)

  // The latest intent changes while the authorized replacement is still in flight.
  await query(page).fill('Beacon London')
  await expectRecommendationsUnavailable(page, RECOVERING_TITLE)
  await held[0].fulfill({ json: retimed(catalogWorkerCatalog(), '2026-09-24T08:31:00.000Z') })
  await companies(page, [CEDAR, BIRCH])
  await expect(badges(page)).toHaveCount(0)
  await expect(page.locator('.catalog-notice')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Backend Engineer — Atlas Alpha Revised', exact: true })).toHaveCount(0)
  await expect(counts(page)).toHaveText(['2', '2'])
  expect(await readSavedJson(page)).toBe(saved)
  await expect.poll(() => exploration(page)).toMatchObject({ selectedId: 'london', filters: { query: 'Beacon London' } })
  expect(await worker.workers()).toHaveLength(2)
  await catalogWorker.expectPaths(initial.attempts, [forced, ordinary])
})

test('a known HTTP retry deadline survives a later idle-worker crash, and only that deadline unlocks the manual retry', async ({ page, catalogWorker }) => {
  const worker = await installCatalogWorkerControl(page)
  catalogWorker.respond(route => route.fulfill({ json: catalogWorkerCatalog() }))
  await catalogWorker.open({ filters: { query: 'Beacon London', role: 'backend' } })
  const initial = await expectInitialCatalogRequest(page, catalogWorker.traffic)
  await companies(page, [CEDAR, BIRCH])
  catalogWorker.respond(route => route.fulfill({
    status: 503, headers: { 'Retry-After': '600' },
    json: { error: 'Fictional Stage73 refresh failed.', code: 'CATALOG_UNAVAILABLE', retryAt: '2026-09-24T08:10:00.000Z' },
  }))
  await page.locator('.data-status-button').click()
  await page.getByRole('button', { name: '새로고침', exact: true }).click()
  await expect(page.locator('.catalog-notice')).toContainText('Fictional Stage73 refresh failed.')
  await close(page)
  await expect(retry(page)).toBeDisabled()
  await expect(page.locator('.catalog-notice')).toContainText('10분 후')
  await companies(page, [CEDAR, BIRCH])

  await worker.crash()
  await expect(page.locator('.catalog-notice')).toContainText(WORKER_FAILURE_MESSAGE)
  await expect(retry(page)).toBeDisabled()
  await expect(page.locator('.catalog-notice')).toContainText('10분 후')
  await companies(page, [CEDAR, BIRCH])
  await page.clock.runFor(5 * 60_000)
  await expect(retry(page)).toBeDisabled()
  await expect(page.locator('.catalog-notice')).toContainText('5분 후')
  await page.clock.runFor(5 * 60_000)
  await expect(retry(page)).toBeEnabled()
  await companies(page, [CEDAR, BIRCH])
  await catalogWorker.expectPaths(initial.attempts, [forced])

  catalogWorker.respond(route => route.fulfill({ json: catalogWorkerCatalog() }))
  await retry(page).click()
  await companies(page, [CEDAR, BIRCH])
  await expect(page.locator('.catalog-notice')).toHaveCount(0)
  await catalogWorker.expectPaths(initial.attempts, [forced, forced])
})

test('a worker crash followed by an HTTP retry deadline locks the manual retry until that deadline while retention continues', async ({ page, catalogWorker }) => {
  const worker = await installCatalogWorkerControl(page)
  catalogWorker.respond(route => route.fulfill({ json: catalogWorkerCatalog() }))
  await catalogWorker.open({ filters: { query: 'Beacon London', role: 'backend' } })
  const initial = await expectInitialCatalogRequest(page, catalogWorker.traffic)
  await companies(page, [CEDAR, BIRCH])
  await worker.crash()
  await expectRetainedNotice(page)
  await expect(retry(page)).toBeEnabled()

  catalogWorker.respond(route => route.fulfill({
    status: 503, headers: { 'Retry-After': '600' },
    json: { error: 'Fictional Stage73 recovery failed.', code: 'CATALOG_UNAVAILABLE', retryAt: '2026-09-24T08:10:00.000Z' },
  }))
  await retry(page).click()
  await expect(page.locator('.catalog-notice')).toContainText('Fictional Stage73 recovery failed.')
  await expect(retry(page)).toBeDisabled()
  await expect(page.locator('.catalog-notice')).toContainText('10분 후')
  await companies(page, [CEDAR, BIRCH])
  await page.clock.runFor(5 * 60_000)
  await expect(retry(page)).toBeDisabled()
  await expect(page.locator('.catalog-notice')).toContainText('5분 후')
  await page.clock.runFor(5 * 60_000)
  await expect(retry(page)).toBeEnabled()
  await companies(page, [CEDAR, BIRCH])
  await catalogWorker.expectPaths(initial.attempts, [forced])

  catalogWorker.respond(route => route.fulfill({ json: catalogWorkerCatalog() }))
  await retry(page).click()
  await companies(page, [CEDAR, BIRCH])
  await expect(page.locator('.catalog-notice')).toHaveCount(0)
  expect((await worker.workers()).filter(item => !item.terminated)).toHaveLength(1)
  await catalogWorker.expectPaths(initial.attempts, [forced, forced])
})

test('constructor-failing, slow and failed retries keep the aged retention until a current replacement is published', async ({ page, catalogWorker }) => {
  const worker = await installCatalogWorkerControl(page)
  catalogWorker.respond(route => route.fulfill({ json: catalogWorkerCatalog() }))
  await catalogWorker.open({ filters: { role: 'backend' } })
  const initial = await expectInitialCatalogRequest(page, catalogWorker.traffic)
  await companies(page, [ASTER, CEDAR, BIRCH])
  await worker.crash()
  await expectRetainedNotice(page)

  // The replacement worker cannot even be constructed.
  await worker.unavailable(true)
  await retry(page).click()
  await expect(page.locator('.catalog-notice')).toContainText(WORKER_FAILURE_MESSAGE)
  await companies(page, [ASTER, CEDAR, BIRCH])
  expect(await worker.workers()).toHaveLength(1)
  await expect(retry(page)).toBeEnabled()
  await worker.unavailable(false)

  // Move next to Aster's cutoff first; only then start the held request.
  await page.clock.pauseAt(new Date('2026-09-25T07:59:59.500Z'))
  await companies(page, [ASTER, CEDAR, BIRCH])
  const held: Route[] = []
  catalogWorker.respond(route => { held.push(route) })
  await retry(page).click()
  await expect.poll(() => held.length).toBe(1)
  await expect(page.locator('.data-status-button')).toContainText('공개 공고 조회 중')
  // Aging applies while the slow reply is still pending.
  await page.clock.runFor(501)
  await companies(page, [CEDAR, BIRCH])
  await expect(counts(page)).toHaveText(['2', '2'])
  await held[0].fulfill({ status: 503, json: { error: 'Fictional Stage73 retry failed.', code: 'CATALOG_UNAVAILABLE' } })
  await expect(page.locator('.catalog-notice')).toContainText('Fictional Stage73 retry failed.')
  await companies(page, [CEDAR, BIRCH])
  await expect(badges(page)).toHaveText(['이전 조회 공고', '이전 조회 공고'])
  await expect(retry(page)).toBeEnabled()

  await page.clock.resume()
  catalogWorker.respond(route => route.fulfill({ json: retimed(catalogWorkerCatalog(), ASTER_EXPIRES) }))
  await retry(page).click()
  await companies(page, [ASTER, CEDAR, BIRCH])
  await expect(page.locator('.catalog-notice, .company-card .stale-job-badge')).toHaveCount(0)
  await expect(counts(page)).toHaveText(['3', '3'])
  const workers = await worker.workers()
  expect(workers).toHaveLength(2)
  expect(workers.filter(item => !item.terminated)).toHaveLength(1)
  await catalogWorker.expectPaths(initial.attempts, [forced, forced, forced])
})

for (const boundary of ['stale', 'expiry'] as const) {
  test(`a recovery reply that crossed its own ${boundary} deadline before publication is withheld; only the corrective projection publishes`, async ({ page, catalogWorker }) => {
    const worker = await installCatalogWorkerControl(page)
    catalogWorker.respond(route => route.fulfill({ json: catalogWorkerCatalog() }))
    await catalogWorker.open({ filters: { role: 'backend' } })
    const initial = await expectInitialCatalogRequest(page, catalogWorker.traffic)
    await companies(page, [ASTER, CEDAR, BIRCH])
    await worker.crash()
    await expectRetainedNotice(page)
    // Every deadline of the old anchor is exhausted before recovery starts.
    await page.clock.pauseAt(new Date('2026-09-25T08:04:00.000Z'))
    await expect(page.getByRole('heading', { name: EXPIRED_TITLE, exact: true })).toBeVisible()
    await expect(page.locator('.catalog-placeholder')).toContainText(WORKER_FAILURE_MESSAGE)
    await expect(page.locator('.company-card')).toHaveCount(0)

    // The replacement's own deadline falls ten seconds after this retry; the old anchor has none left.
    const source = boundary === 'stale' ? '2026-09-25T07:34:10.000Z' : '2026-09-24T08:04:10.000Z'
    const crossing = Date.parse(boundary === 'stale' ? '2026-09-25T08:04:10.000Z' : '2026-09-25T08:04:10.001Z')
    await startHeldRecovery(page, catalogWorker, worker, retimed(catalogWorkerCatalog(), source), '2026-09-25T08:04:10.500Z')
    const obsolete = (await workerRequests(page)).filter(request => request.worker === 2 && request.kind === 'project')
    expect(obsolete).toHaveLength(1)
    expect(obsolete[0].now!).toBeLessThan(crossing)
    await expect(page.getByRole('heading', { name: LOADING_TITLE, exact: true })).toBeVisible()
    await expect(page.locator('.company-card')).toHaveCount(0)

    // Release only the obsolete reply. Its corrective successor stays held, so a
    // wrong publication could not be papered over by a quick correction.
    await worker.releaseOne('project')
    await expect.poll(() => worker.held('project')).toMatchObject([{ worker: 2, kind: 'project', revision: 1 }])
    const corrective = (await worker.held('project'))[0]
    expect(corrective.now!).toBeGreaterThanOrEqual(crossing)
    await expect(page.locator('.company-card')).toHaveCount(0)
    await expect(page.getByRole('heading', { name: LOADING_TITLE, exact: true })).toBeVisible()
    await expect(page.locator('.data-status-button')).toContainText('공개 공고 조회 중')
    await expect(page.locator('.catalog-notice')).toHaveCount(0)

    await worker.releaseAll('project')
    if (boundary === 'stale') {
      await companies(page, [ASTER, CEDAR, BIRCH])
      await expect(badges(page)).toHaveText(['이전 조회 공고', '이전 조회 공고', '이전 조회 공고'])
      await expect(page.locator('.catalog-notice')).toContainText(AGE_NOTICE)
      await expect(page.locator('.catalog-placeholder')).toHaveCount(0)
      await expect(counts(page)).toHaveText(['3', '3'])
    } else {
      await expect(page.getByRole('heading', { name: EXPIRED_TITLE, exact: true })).toBeVisible()
      await expect(page.locator('.catalog-placeholder')).toContainText('24시간을 지나')
      await expect(page.locator('.catalog-placeholder')).not.toContainText(WORKER_FAILURE_MESSAGE)
      await expect(page.locator('.data-status-button')).toContainText('공개 공고 확인 필요')
      await expect(page.locator('.company-card')).toHaveCount(0)
      await expect(stats(page)).toHaveText(['—곳', '—곳'])
      await expect(retry(page)).toBeEnabled()
    }
    await expect(page.locator('.data-status-button')).not.toContainText('조회 중')
    await catalogWorker.expectPaths(initial.attempts, [forced])
  })
}

test('a foreground return after skipped timers re-evaluates the wall clock while gated revalidation issues no request', async ({ page, catalogWorker }) => {
  const worker = await installCatalogWorkerControl(page)
  catalogWorker.respond(route => route.fulfill({ json: withRefreshAfter(catalogWorkerCatalog(), FAR_REFRESH_AFTER) }))
  await catalogWorker.open({ filters: { role: 'backend' } })
  const initial = await expectInitialCatalogRequest(page, catalogWorker.traffic)
  await companies(page, [ASTER, CEDAR, BIRCH])
  await worker.crash()
  await expectRetainedNotice(page)
  // Move the wall clock without running any timer, like a throttled hidden tab.
  await page.clock.setSystemTime(new Date(ASTER_EXPIRES))
  await expect(page.locator('.company-card h3')).toHaveText(['Aster QA Labs', 'Cedar QA Works', 'Birch QA Systems'])
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
  await companies(page, [CEDAR, BIRCH])
  await expect(counts(page)).toHaveText(['2', '2'])
  await expect(badges(page)).toHaveText(['이전 조회 공고', '이전 조회 공고'])
  await page.evaluate(() => {
    window.dispatchEvent(new Event('online'))
    window.dispatchEvent(new Event('focus'))
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }))
  })
  await companies(page, [CEDAR, BIRCH])
  await page.clock.fastForward(5000)
  await catalogWorker.expectPaths(initial.attempts, [])
  await expect(retry(page)).toBeEnabled()
  catalogWorker.respond(route => route.fulfill({ json: retimed(catalogWorkerCatalog(), ASTER_EXPIRES) }))
  await retry(page).click()
  await companies(page, [ASTER, CEDAR, BIRCH])
  await expect(page.locator('.catalog-notice')).toHaveCount(0)
  await catalogWorker.expectPaths(initial.attempts, [forced])
})

test('an authoritative CATALOG_EXPIRED during recovery invalidates the anchor, and a clock rollback cannot restore it', async ({ page, catalogWorker }) => {
  const worker = await installCatalogWorkerControl(page)
  catalogWorker.respond(route => route.fulfill({ json: catalogWorkerCatalog() }))
  await catalogWorker.open({ filters: { role: 'backend' } })
  const initial = await expectInitialCatalogRequest(page, catalogWorker.traffic)
  await companies(page, [ASTER, CEDAR, BIRCH])
  await worker.crash()
  await expectRetainedNotice(page)
  catalogWorker.respond(route => route.fulfill({
    status: 503, headers: { 'Retry-After': '120' },
    json: { error: 'Fictional Stage73 catalog expired.', code: 'CATALOG_EXPIRED', retryAt: '2026-09-24T08:02:00.000Z' },
  }))
  await retry(page).click()
  await expect(page.getByRole('heading', { name: EXPIRED_TITLE, exact: true })).toBeVisible()
  await expect(page.locator('.catalog-placeholder')).toContainText('Fictional Stage73 catalog expired.')
  await expect(page.locator('.company-card, .flat-marker')).toHaveCount(0)
  await expect(stats(page)).toHaveText(['—곳', '—곳'])
  await expect(retry(page)).toBeDisabled()

  await page.clock.setSystemTime(new Date('2026-09-24T07:30:00.000Z'))
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
  await expect(page.getByRole('heading', { name: EXPIRED_TITLE, exact: true })).toBeVisible()
  await expect(page.locator('.company-card')).toHaveCount(0)
  await catalogWorker.expectPaths(initial.attempts, [forced])

  await page.clock.setSystemTime(new Date('2026-09-24T08:01:59.000Z'))
  await page.clock.fastForward(2000)
  await expect(retry(page)).toBeEnabled()
  await catalogWorker.expectPaths(initial.attempts, [forced])
  catalogWorker.respond(route => route.fulfill({ json: retimed(catalogWorkerCatalog(), '2026-09-24T08:02:01.000Z') }))
  await retry(page).click()
  await companies(page, [ASTER, CEDAR, BIRCH])
  await expect(page.locator('.catalog-placeholder, .catalog-notice')).toHaveCount(0)
  await catalogWorker.expectPaths(initial.attempts, [forced, forced])
})

test('same-intent partial expiry updates the comparison table literally and keeps the selected comparison cities', async ({ page, catalogWorker }) => {
  const worker = await installCatalogWorkerControl(page)
  catalogWorker.respond(route => route.fulfill({ json: withRefreshAfter(catalogWorkerCatalog(), FAR_REFRESH_AFTER) }))
  await catalogWorker.open({ filters: { role: 'backend' } })
  const initial = await expectInitialCatalogRequest(page, catalogWorker.traffic)
  await companies(page, [ASTER, CEDAR, BIRCH])
  await nav(page).getByRole('button', { name: /도시 비교/ }).click()
  await page.getByRole('button', { name: '회사 많은 3개 도시', exact: true }).click()
  await expect(page.locator('.comparison-city h2')).toHaveText(['런던', '베를린'])
  await expect(compareRow(page, '추천 회사')).toHaveText(['3곳', '1곳', '—'])
  await expect(compareRow(page, '관련 채용공고')).toHaveText(['3개', '1개', '—'])
  await expect(compareRow(page, '공고 조회 상태').nth(0)).toContainText('3개 최근 조회')
  await expect(compareRow(page, '공고 조회 상태').nth(0)).toContainText('0개 이전 조회 공고 포함')

  await worker.crash()
  await expect(page.locator('.catalog-notice')).toContainText(WORKER_FAILURE_MESSAGE)
  await expect(compareRow(page, '추천 회사')).toHaveText(['3곳', '1곳', '—'])
  await expect(page.locator('.comparison-city h2')).toHaveText(['런던', '베를린'])

  await page.clock.pauseAt(new Date(ASTER_EXPIRES))
  await expect(compareRow(page, '추천 회사')).toHaveText(['2곳', '1곳', '—'])
  await expect(compareRow(page, '관련 채용공고')).toHaveText(['2개', '1개', '—'])
  await expect(compareRow(page, '공고 조회 상태').nth(0)).toContainText('0개 최근 조회')
  await expect(compareRow(page, '공고 조회 상태').nth(0)).toContainText('2개 이전 조회 공고 포함')
  await expect(page.locator('.comparison-city h2')).toHaveText(['런던', '베를린'])

  await page.clock.runFor(1000)
  await expect(compareRow(page, '추천 회사')).toHaveText(['1곳', '0곳', '—'])
  await expect(compareRow(page, '관련 채용공고')).toHaveText(['1개', '0개', '—'])
  await expect(page.locator('.comparison-city h2')).toHaveText(['런던', '베를린'])
  await expect(page.getByRole('heading', { name: UNAVAILABLE_TITLE, exact: true })).toHaveCount(0)
  await expect(page.locator('.catalog-notice')).toContainText(WORKER_FAILURE_MESSAGE)
  await catalogWorker.expectPaths(initial.attempts, [])
})

test('a worker failure during an accepted partial collection clears progress and keeps pending boards as unconfirmed history, not invented results', async ({ page, catalogWorker }) => {
  const worker = await installCatalogWorkerControl(page)
  await catalogWorker.open({ filters: { query: 'Atlas Alpha', role: 'backend' }, saved: catalogWorkerSaved() })
  const initial = await expectInitialCatalogRequest(page, catalogWorker.traffic)
  await companies(page, [ASTER])
  await expect(page.locator('.catalog-collecting progress')).toHaveAttribute('value', '1')
  const saved = await readSavedJson(page)
  const late = await catalogWorker.takeProgress(1)

  await worker.crash()
  await expectRetainedNotice(page)
  await expect.poll(() => catalogWorker.traffic.requests.filter(request => request.error === 'net::ERR_ABORTED').length)
    .toBe(initial.cancelled + 1)
  await late.fulfill({ json: catalogWorkerUpdate(2) }).catch(error => {
    if (late.request().failure()?.errorText !== 'net::ERR_ABORTED') throw error
  })
  await companies(page, [ASTER])
  await expect(page.locator('.data-status-button')).toContainText('공개 공고 연결 필요')
  await page.locator('.data-status-button').click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.locator('.collection-progress, progress')).toHaveCount(0)
  await expect(dialog.locator('.coverage-stats strong')).toHaveText(['2', '3', '3'])
  const details = dialog.locator('.board-details')
  if (await details.getAttribute('open') === null) await details.locator('summary').click()
  await expect(dialog.locator('.board-row').filter({ hasText: 'Aster QA Labs' })).toContainText('3개 반영')
  for (const company of ['Birch QA Systems', 'Cedar QA Works']) {
    const row = dialog.locator('.board-row').filter({ hasText: company })
    await expect(row).toContainText('진행 상태 미확인')
    await expect(row).not.toContainText('반영')
    await expect(row).not.toContainText('재조회 실패')
  }
  await expect(dialog.locator('.board-error-detail')).toHaveCount(0)
  await close(page)
  expect(await readSavedJson(page)).toBe(saved)

  await page.clock.pauseAt(new Date(ASTER_EXPIRES))
  await expect(page.getByRole('heading', { name: EXPIRED_TITLE, exact: true })).toBeVisible()
  await expect(page.locator('.catalog-placeholder')).toContainText(WORKER_FAILURE_MESSAGE)
  await page.clock.resume()
  catalogWorker.respond(route => route.fulfill({ json: retimed(catalogWorkerCatalog(), ASTER_EXPIRES) }))
  await retry(page).click()
  await companies(page, [ASTER])
  await expect(page.locator('.catalog-placeholder, .catalog-notice')).toHaveCount(0)
  expect(await readSavedJson(page)).toBe(saved)
  await catalogWorker.expectPaths(initial.attempts, [firstMonitor, forced])
})
