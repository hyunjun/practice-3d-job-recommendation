import { expect } from '@playwright/test'
import type { Page, Route } from '@playwright/test'
import {
  CATALOG_WORKER_FINAL_TIME, CATALOG_WORKER_NOTE, CATALOG_WORKER_PROFILE, CATALOG_WORKER_REVISED_TIME,
  CATALOG_WORKER_SECOND_TIME, CATALOG_WORKER_TIME, catalogWorkerCatalog, catalogWorkerEmpty,
  catalogWorkerRevised, catalogWorkerSaved, catalogWorkerUpdate,
} from '../fixtures/catalog-worker'
import { expectInitialCatalogRequest } from './helpers/api-requests'
import {
  catalogWorkerClose as close, catalogWorkerExploration as exploration, catalogWorkerQuery as query,
  catalogWorkerTest as test, expectCatalogWorkerCompanies as companies, expectCatalogWorkerMetadata as metadata,
} from './helpers/catalog-worker'
import { readSaved, readSavedJson, waitForSavedCommit } from './helpers/saved-store'
import { installCatalogWorkerControl } from './helpers/catalog-worker-control'
import { expectCancelledInitialCatalogRequest, installCatalogFetchObserver } from './helpers/catalog-fetch-observer'

const firstMonitor = '/api/catalog/progress?id=00000000-0000-4000-8000-000000000067&after=1'
const finalMonitor = '/api/catalog/progress?id=00000000-0000-4000-8000-000000000067&after=2'
const forced = '/api/catalog?source=public&refresh=1'
const ordinary = '/api/catalog?source=public'
const malformed = '공고 데이터 형식을 확인하지 못했어요. 다시 조회해 주세요.'
const progress = (page: Page) => page.locator('.catalog-collecting progress')
const nav = (page: Page) => page.getByRole('navigation', { name: '주요 메뉴' })

async function finalMetadata(page: Page) {
  await metadata(page, {
    jobs: '9', boardCounts: ['3개 반영', '3개 반영', '3개 반영'],
    times: [CATALOG_WORKER_TIME, CATALOG_WORKER_SECOND_TIME, CATALOG_WORKER_FINAL_TIME],
  })
}

async function finalLondon(page: Page) {
  await companies(page, [
    { company: 'Cedar QA Works', titles: ['Backend Engineer — Beacon London Final'] },
    { company: 'Birch QA Systems', titles: ['Backend Engineer — Beacon London'] },
  ])
  await expect(page.locator('.city-detail-count strong')).toHaveText(['2', '2'])
  await expect(page.locator('.active-filter-summary')).toContainText('2개 공고가 현재 조건에 맞아요')
}

async function salary(page: Page, value: 190000 | 200000 | 250000) {
  const slider = page.getByLabel('희망 연봉')
  await slider.press('End')
  for (let step = 0; step < (250000 - value) / 10000; step++) await slider.press('ArrowLeft')
  await expect(slider).toHaveValue(String(value))
}

async function visa(page: Page, value: 'possible' | 'yes', count: 1 | 2) {
  if (page.viewportSize()!.width >= 680) {
    await page.getByLabel('비자 지원 필터', { exact: true }).selectOption(value)
    return
  }
  // The narrow toolbar intentionally hides the visa quick filter. Use its
  // actual accessible dialog control; never force an action on a hidden field.
  await page.getByRole('button', { name: /^모든 필터/ }).click()
  await page.getByLabel('비자 지원', { exact: true }).selectOption(value)
  // PROD-MODAL-1 (production run 20261001T193712430872Z-f4b340c7): the final arrival may still
  // publish while this draft is open, and every publication re-counts the preview and disables
  // Apply while counting. Commit only after the displayed collection has finished and the current
  // global summary has settled on the authored literal count, with the selected draft and the
  // dialog-scoped Apply showing that exact count ready. One ordinary click; then the dialog must
  // be gone and the requested visa persisted before any background control is touched again.
  await expect(progress(page)).toHaveCount(0)
  await expect(page.locator('.active-filter-summary')).toHaveAttribute('aria-busy', 'false')
  await expect(page.locator('.active-filter-summary')).toContainText(`${count}개 공고가 현재 조건에 맞아요`)
  const dialog = page.locator('dialog.filters-dialog')
  await expect(dialog.getByLabel('비자 지원', { exact: true })).toHaveValue(value)
  const apply = dialog.locator('.dialog-footer .button.primary')
  await expect(apply).toHaveText(`${count}개 공고 보기`)
  await expect(apply).toHaveAttribute('aria-busy', 'false')
  await expect(apply).toBeEnabled()
  await apply.click()
  await expect(dialog).toHaveCount(0)
  await expect.poll(() => exploration(page)).toMatchObject({ filters: { visa: value } })
}

for (const width of [1440, 320]) test.describe(`catalog arrivals with changing controls at ${width}px`, () => {
  test.use({ viewport: { width, height: 960 } })

  test('the latest query and quick filters win across both arrivals and remain consistent with the final catalog', async ({ page, catalogWorker }) => {
    await catalogWorker.open({ filters: { query: 'Atlas' } })
    const initial = await expectInitialCatalogRequest(page, catalogWorker.traffic)
    await companies(page, [{ company: 'Aster QA Labs', titles: ['Backend Engineer — Atlas Alpha'] }])
    await expect(progress(page)).toHaveAttribute('value', '1')
    const first = await catalogWorker.takeProgress(1)

    await query(page).fill('PRIVATE_CATALOG_WORKER_QUERY')
    await page.getByLabel('직무 필터', { exact: true }).selectOption('frontend')
    await query(page).fill('Beacon')
    await page.getByLabel('직무 필터', { exact: true }).selectOption('backend')
    await page.getByLabel('근무 형태 필터', { exact: true }).selectOption('onsite')
    await first.fulfill({ json: catalogWorkerUpdate(2) })
    await query(page).fill('Atlas')
    await query(page).fill('Beacon London')
    await expect(progress(page)).toHaveAttribute('value', '2')
    await companies(page, [{ company: 'Birch QA Systems', titles: ['Backend Engineer — Beacon London'] }])

    const last = await catalogWorker.takeProgress(2)
    await query(page).fill('Atlas')
    await page.getByLabel('직무 필터', { exact: true }).selectOption('frontend')
    await last.fulfill({ json: catalogWorkerUpdate(3) })
    // Authored literals: Atlas + frontend + onsite leaves Birch 'Frontend Engineer — Atlas Canvas' (1);
    // Beacon London + backend + onsite leaves the Birch and Cedar London backend jobs (2).
    await visa(page, 'possible', 1)
    await page.getByLabel('직무 필터', { exact: true }).selectOption('backend')
    await query(page).fill('Beacon London')
    await visa(page, 'yes', 2)
    await finalLondon(page)
    await expect(progress(page)).toHaveCount(0)
    await expect(page.locator('.map-stats strong')).toHaveText(['2곳', '1곳'])
    await expect(query(page)).toHaveValue('Beacon London')
    await expect.poll(() => exploration(page)).toMatchObject({
      selectedId: 'london', mapMode: 'flat', panelTab: 'cities',
      filters: { query: 'Beacon London', role: 'backend', workMode: 'onsite', visa: 'yes' },
    })
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('orbit.v1.profile') ?? '{}'))).toEqual(CATALOG_WORKER_PROFILE)
    await finalMetadata(page)

    await page.getByRole('button', { name: 'Backend Engineer — Beacon London Final', exact: true }).click()
    await expect(page.getByRole('link', { name: '원문에서 지원하기', exact: true }))
      .toHaveAttribute('href', 'https://example.org/catalog-worker/cedar/london')
    await close(page)
    await page.clock.fastForward(120000)
    await finalLondon(page)
    await expect(query(page)).toHaveValue('Beacon London')
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await catalogWorker.expectPaths(initial.attempts, [firstMonitor, finalMonitor])
  })
})

test('an open detailed-filter draft recomputes literal preview counts on arrivals without applying an older draft', async ({ page, catalogWorker }) => {
  await catalogWorker.open({ filters: { query: 'Beacon', role: 'backend' } })
  const initial = await expectInitialCatalogRequest(page, catalogWorker.traffic)
  await expect(progress(page)).toHaveAttribute('value', '1')
  await expect(page.locator('.active-filter-summary')).toContainText('1개 공고가 현재 조건에 맞아요')
  await page.getByRole('button', { name: /^모든 필터/ }).click()
  await page.getByLabel('고용 형태', { exact: true }).selectOption('fulltime')
  await expect(page.getByRole('button', { name: '0개 공고 보기', exact: true })).toBeVisible()
  const first = await catalogWorker.takeProgress(1)
  await first.fulfill({ json: catalogWorkerUpdate(2) })
  await expect(page.getByRole('button', { name: '2개 공고 보기', exact: true })).toBeVisible()
  await salary(page, 200000)
  await page.getByRole('checkbox', { name: '연봉 미공개·별도 보상 공고도 포함' }).uncheck()
  await expect(page.getByRole('button', { name: '1개 공고 보기', exact: true })).toBeVisible()

  const last = await catalogWorker.takeProgress(2)
  await page.getByLabel('고용 형태', { exact: true }).selectOption('contract')
  await last.fulfill({ json: catalogWorkerUpdate(3) })
  await salary(page, 250000)
  await page.getByLabel('고용 형태', { exact: true }).selectOption('fulltime')
  await expect(page.getByRole('button', { name: '0개 공고 보기', exact: true })).toBeVisible()
  await salary(page, 190000)
  await expect(page.getByRole('button', { name: '3개 공고 보기', exact: true })).toBeVisible()
  await salary(page, 200000)
  await expect(page.getByRole('button', { name: '2개 공고 보기', exact: true })).toBeVisible()
  // The draft has not changed persisted exploration or the current global count.
  expect((await exploration(page)).filters).toMatchObject({ employment: 'all', salaryMin: 0, includeUnknownSalary: true })
  await expect(page.locator('.active-filter-summary')).toContainText('4개 공고가 현재 조건에 맞아요')
  await page.getByRole('button', { name: '2개 공고 보기', exact: true }).click()
  await finalLondon(page)
  await expect.poll(() => exploration(page)).toMatchObject({
    selectedId: 'london', filters: {
      query: 'Beacon', role: 'backend', employment: 'fulltime', salaryMin: 200000, includeUnknownSalary: false,
    },
  })

  await page.getByRole('button', { name: /^모든 필터/ }).click()
  await page.getByRole('button', { name: '조건 초기화', exact: true }).click()
  await expect(page.getByRole('button', { name: '6개 공고 보기', exact: true })).toBeVisible()
  await page.keyboard.press('Escape')
  await finalLondon(page)
  await page.getByRole('button', { name: /^모든 필터/ }).click()
  await expect(page.getByLabel('희망 연봉')).toHaveValue('200000')
  await expect(page.getByRole('button', { name: '2개 공고 보기', exact: true })).toBeVisible()
  await close(page)
  await finalMetadata(page)
  await catalogWorker.expectPaths(initial.attempts, [firstMonitor, finalMonitor])
})

test('city selection survives arrivals during a real globe drag and the released map shows the final city counts', async ({ page, catalogWorker }, info) => {
  await catalogWorker.open({ mapMode: 'globe', filters: { query: 'Beacon' } })
  const initial = await expectInitialCatalogRequest(page, catalogWorker.traffic)
  await page.getByRole('button', { name: '모든 도시', exact: true }).click()
  await page.getByRole('button', { name: '베를린, 추천 회사 1곳 보기', exact: true }).click()
  await expect(page.locator('.city-hero-caption h2')).toContainText('베를린')
  await companies(page, [{ company: 'Aster QA Labs', titles: ['Frontend Engineer — Beacon Berlin'] }])
  const first = await catalogWorker.takeProgress(1)
  const canvas = page.locator('.earth-canvas canvas')
  await expect(canvas).toBeVisible()
  const before = await canvas.screenshot()
  const start = await canvas.evaluate(element => {
    const box = element.getBoundingClientRect()
    for (const [x, y] of [[0.4, 0.65], [0.35, 0.55], [0.6, 0.65]]) {
      const point = { x: box.x + box.width * x, y: box.y + box.height * y }
      if (document.elementFromPoint(point.x, point.y) === element) return point
    }
    throw new Error('No unobstructed globe canvas drag point.')
  })
  await page.mouse.move(start.x, start.y)
  await page.mouse.down()
  try {
    await page.mouse.move(start.x + 42, start.y + 12, { steps: 4 })
    await page.clock.runFor(32)
    expect((await canvas.screenshot()).equals(before), 'A real pointer drag must change the rendered globe').toBe(false)
    await first.fulfill({ json: catalogWorkerUpdate(2) })
    await expect(progress(page)).toHaveAttribute('value', '2')
    await page.mouse.move(start.x + 55, start.y + 18, { steps: 3 })
    const last = await catalogWorker.takeProgress(2)
    await last.fulfill({ json: catalogWorkerUpdate(3) })
    await page.mouse.move(start.x + 65, start.y + 24, { steps: 3 })
  } finally { await page.mouse.up() }
  await expect(progress(page)).toHaveCount(0)
  await expect(page.locator('.city-hero-caption h2')).toContainText('베를린')
  await expect(page.locator('.city-detail-count strong')).toHaveText(['3', '3'])
  await companies(page, [
    { company: 'Birch QA Systems', titles: ['Backend Engineer — Beacon Berlin'] },
    { company: 'Aster QA Labs', titles: ['Frontend Engineer — Beacon Berlin'] },
    { company: 'Cedar QA Works', titles: ['Frontend Engineer — Beacon Berlin Final'] },
  ])
  await expect(page.locator('.active-filter-summary')).toContainText('6개 공고가 현재 조건에 맞아요')
  await expect(page.locator('.map-stats strong')).toHaveText(['3곳', '2곳'])
  await expect(page.getByRole('button', { name: '3D 지구', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await expect.poll(() => exploration(page)).toMatchObject({ selectedId: 'berlin', mapMode: 'globe', filters: { query: 'Beacon' } })
  await finalMetadata(page)
  await page.screenshot({ path: info.outputPath('catalog-arrivals-after-globe-drag.png') })
  await catalogWorker.expectPaths(initial.attempts, [firstMonitor, finalMonitor])
})

test('saved notes and applied status survive an arrival, cancelled late monitor, saved-only reload and revised same-ID catalog', async ({ page, catalogWorker }) => {
  await catalogWorker.open({ filters: { query: 'Atlas', role: 'backend' } })
  const initial = await expectInitialCatalogRequest(page, catalogWorker.traffic)
  await page.getByRole('button', { name: 'Backend Engineer — Atlas Alpha', exact: true }).click()
  await page.getByRole('button', { name: '기회 저장', exact: true }).click()
  await page.getByLabel('이 기회에 대한 나의 메모', { exact: true }).fill(CATALOG_WORKER_NOTE)
  await page.getByRole('button', { name: '지원 완료로 표시', exact: true }).click()
  await waitForSavedCommit(page)
  expect((await readSaved(page)).map(record => ({ id: record.job.id, note: record.note, status: record.status }))).toEqual([
    { id: 'greenhouse-catalog-worker-aster-atlas', note: 'PRIVATE_CATALOG_WORKER_NOTE — 지원 준비 🌱', status: 'applied' },
  ])
  const saved = await readSavedJson(page)
  const state = await exploration(page)
  const first = await catalogWorker.takeProgress(1)
  await first.fulfill({ json: catalogWorkerUpdate(2) })
  await expect(progress(page)).toHaveAttribute('value', '2')
  await expect(page.getByLabel('이 기회에 대한 나의 메모', { exact: true })).toHaveValue(CATALOG_WORKER_NOTE)
  await expect(page.getByRole('button', { name: '지원 완료로 표시됨', exact: true })).toBeVisible()
  await close(page)
  const late = await catalogWorker.takeProgress(2)
  await nav(page).getByRole('button', { name: /^저장한 기회/ }).click()
  await expect.poll(() => catalogWorker.traffic.requests.filter(request => request.error === 'net::ERR_ABORTED').length)
    .toBe(initial.cancelled + 1)
  await late.fulfill({ json: catalogWorkerUpdate(3) })
  await page.clock.fastForward(120000)
  await expect(page.locator('.saved-title')).toHaveText(['Backend Engineer — Atlas Alpha'])
  await expect(page.locator('.saved-note-preview')).toHaveText([CATALOG_WORKER_NOTE])
  await expect(page.locator('.saved-status')).toHaveText(['지원 완료'])
  await page.locator('.data-status-button').click()
  await expect(page.locator('.coverage-stats strong')).toHaveText(['2', '3', '6'])
  await close(page)
  expect(await readSavedJson(page)).toBe(saved)
  expect(await exploration(page)).toEqual(state)

  catalogWorker.respond(route => route.fulfill({ json: catalogWorkerRevised() }))
  await page.reload()
  await expect(page.locator('.saved-title')).toHaveText(['Backend Engineer — Atlas Alpha'])
  await waitForSavedCommit(page)
  await page.clock.fastForward(10000)
  await catalogWorker.expectPaths(initial.attempts, [firstMonitor, finalMonitor])
  await page.clock.setSystemTime(new Date(CATALOG_WORKER_REVISED_TIME))
  await nav(page).getByRole('button', { name: '기회 탐색', exact: true }).click()
  await companies(page, [{ company: 'Aster QA Labs', titles: ['Backend Engineer — Atlas Alpha Revised'] }])
  await expect(query(page)).toHaveValue('Atlas')
  expect(await exploration(page)).toEqual(state)
  await page.getByRole('button', { name: 'Backend Engineer — Atlas Alpha Revised', exact: true }).click()
  await expect(page.getByLabel('이 기회에 대한 나의 메모', { exact: true })).toHaveValue(CATALOG_WORKER_NOTE)
  await expect(page.getByRole('button', { name: '지원 완료로 표시됨', exact: true })).toBeVisible()
  await close(page)
  expect(await readSavedJson(page)).toBe(saved)
  await metadata(page, {
    jobs: '9', boardCounts: ['3개 반영', '3개 반영', '3개 반영'],
    times: [CATALOG_WORKER_REVISED_TIME, CATALOG_WORKER_REVISED_TIME, CATALOG_WORKER_REVISED_TIME],
  })
  await catalogWorker.expectPaths(initial.attempts, [firstMonitor, finalMonitor, ordinary])
})

test('invalid JSON is recoverable and a successful empty retry stays empty until a later explicit refresh', async ({ page, catalogWorker }) => {
  catalogWorker.respond(route => route.fulfill({ status: 200, contentType: 'application/json', body: '{"source":"public","jobs":[' }))
  await catalogWorker.open({ filters: { query: 'Beacon London', role: 'backend' } })
  const initial = await expectInitialCatalogRequest(page, catalogWorker.traffic)
  await expect(page.locator('.catalog-placeholder')).toContainText(malformed)
  await expect(page.locator('.company-card, .search-recovery, .city-row')).toHaveCount(0)
  await page.clock.fastForward(10000)
  await catalogWorker.expectPaths(initial.attempts, [])
  catalogWorker.respond(route => route.fulfill({ json: catalogWorkerEmpty() }))
  await page.getByRole('button', { name: '다시 조회', exact: true }).click()
  await expect(page.locator('.catalog-placeholder')).toHaveCount(0)
  await expect(page.locator('.search-recovery')).toContainText('현재 불러온 자료에는 이 탐색 범위의 공고가 없어요')
  await expect(page.locator('.recovery-option, .recovery-alternatives, .company-card')).toHaveCount(0)
  await expect(page.locator('.active-filter-summary')).toContainText('0개 공고가 현재 조건에 맞아요')
  await metadata(page, {
    jobs: '0', boardCounts: ['0개 반영', '0개 반영', '0개 반영'],
    times: [CATALOG_WORKER_TIME, CATALOG_WORKER_SECOND_TIME, CATALOG_WORKER_FINAL_TIME],
  })
  catalogWorker.respond(route => route.fulfill({ json: catalogWorkerCatalog() }))
  await page.locator('.data-status-button').click()
  await page.getByRole('button', { name: '새로고침', exact: true }).click()
  await expect(page.locator('.coverage-stats strong')).toHaveText(['2', '3', '9'])
  await close(page)
  await finalLondon(page)
  await expect(query(page)).toHaveValue('Beacon London')
  await finalMetadata(page)
  await catalogWorker.expectPaths(initial.attempts, [forced, forced])
})

for (const failure of ['malformed delta', 'connection error'] as const) {
  test(`${failure} keeps the accepted revision and retries only on request without losing the latest query`, async ({ page, catalogWorker }) => {
    await catalogWorker.open({ filters: { query: 'Atlas', role: 'backend' } })
    const initial = await expectInitialCatalogRequest(page, catalogWorker.traffic)
    await companies(page, [{ company: 'Aster QA Labs', titles: ['Backend Engineer — Atlas Alpha'] }])
    const first = await catalogWorker.takeProgress(1)
    if (failure === 'malformed delta') {
      const invalid = catalogWorkerUpdate(2)
      Object.assign(invalid.jobs[0], { skills: [{}] })
      await first.fulfill({ json: invalid })
    } else {
      await first.fulfill({
        status: 503, headers: { 'Retry-After': '2' },
        json: { error: 'Fictional worker catalog connection unavailable.', code: 'CATALOG_UNAVAILABLE', retryAt: '2026-09-24T08:00:05.000Z' },
      })
    }
    await expect(page.locator('.catalog-notice')).toContainText(failure === 'malformed delta'
      ? malformed : 'Fictional worker catalog connection unavailable.')
    await expect(progress(page)).toHaveCount(0)
    await companies(page, [{ company: 'Aster QA Labs', titles: ['Backend Engineer — Atlas Alpha'] }])
    await page.locator('.data-status-button').click()
    await expect(page.locator('.coverage-stats strong')).toHaveText(['2', '3', '3'])
    await expect(page.locator('.board-row').filter({ hasText: 'Birch QA Systems' })).toContainText('진행 상태 미확인')
    await close(page)
    await query(page).fill('Beacon London')
    await expect(page.locator('.company-card')).toHaveCount(0)
    await page.clock.fastForward(10000)
    await catalogWorker.expectPaths(initial.attempts, [firstMonitor])
    catalogWorker.respond(route => route.fulfill({ json: catalogWorkerCatalog() }))
    await page.getByRole('button', { name: '다시 조회', exact: true }).click()
    await finalLondon(page)
    await expect(page.locator('.catalog-notice')).toHaveCount(0)
    await finalMetadata(page)
    await expect.poll(() => exploration(page)).toMatchObject({
      selectedId: 'london', filters: { query: 'Beacon London', role: 'backend' },
    })
    await catalogWorker.expectPaths(initial.attempts, [firstMonitor, forced])
  })
}

test('the main clock expires final search results while an open saved record and its private context remain usable', async ({ page, catalogWorker }) => {
  catalogWorker.respond(route => route.fulfill({ json: catalogWorkerCatalog() }))
  await catalogWorker.open({ filters: { query: 'Beacon London', role: 'backend' } })
  const initial = await expectInitialCatalogRequest(page, catalogWorker.traffic)
  await finalLondon(page)
  await page.getByRole('button', { name: 'Backend Engineer — Beacon London Final', exact: true }).click()
  await page.getByRole('button', { name: '기회 저장', exact: true }).click()
  await page.getByLabel('이 기회에 대한 나의 메모', { exact: true }).fill(CATALOG_WORKER_NOTE)
  await page.getByRole('button', { name: '지원 완료로 표시', exact: true }).click()
  const saved = await readSavedJson(page)
  const state = await exploration(page)
  // Exactly 24h remains usable; 1ms later the final company's snapshot expires.
  // Updating Date without a lifecycle event avoids triggering a new collection.
  await page.clock.pauseAt(new Date('2026-09-25T08:00:02.000Z'))
  await expect(page.locator('.city-detail-count strong')).toHaveText(['1', '1'])
  await expect(page.locator('.mini-job-title')).toHaveText(['Backend Engineer — Beacon London Final'])
  await page.clock.runFor(1)
  await expect(page.locator('.job-freshness-notice')).toContainText('추천에서 제외된 조회 기록')
  await expect(page.getByLabel('이 기회에 대한 나의 메모', { exact: true })).toHaveValue(CATALOG_WORKER_NOTE)
  await expect(page.getByRole('button', { name: '지원 완료로 표시됨', exact: true })).toBeVisible()
  await close(page)
  await expect(page.getByRole('heading', { name: '공고를 다시 확인해 주세요', exact: true })).toBeVisible()
  await expect(page.locator('.company-card, .flat-marker, .recovery-option')).toHaveCount(0)
  await expect(page.locator('.map-stats strong')).toHaveText(['—곳', '—곳'])
  await expect(query(page)).toHaveValue('Beacon London')
  expect(await exploration(page)).toEqual(state)
  expect(await readSavedJson(page)).toBe(saved)
  await page.clock.resume()
  await nav(page).getByRole('button', { name: /^저장한 기회/ }).click()
  await expect(page.locator('.saved-title')).toHaveText(['Backend Engineer — Beacon London Final'])
  await expect(page.locator('.saved-status')).toHaveText(['지원 완료'])
  await expect(page.locator('.saved-note-preview')).toHaveText([CATALOG_WORKER_NOTE])
  await expect(page.locator('.saved-card .stale-job-badge')).toHaveText('확인 기간 지남')
  await catalogWorker.expectPaths(initial.attempts, [])
})

test('a cold saved-only visit supports note search and profile edits without starting catalog transport', async ({ page, catalogWorker }) => {
  await catalogWorker.open({
    view: 'saved', saved: catalogWorkerSaved(), selectedId: 'berlin',
    filters: { query: 'PRIVATE_CATALOG_WORKER_QUERY', role: 'frontend' },
  })
  await expect(page.locator('.saved-title')).toHaveText(['Backend Engineer — Atlas Alpha'])
  const saved = await readSavedJson(page)
  const state = await exploration(page)
  await page.getByRole('textbox', { name: '저장한 기회 검색', exact: true }).fill('지원 준비')
  await page.locator('.collection-tabs').getByRole('button', { name: /^지원 완료/ }).click()
  await page.getByRole('button', { name: '내 프로필 편집', exact: true }).click()
  await page.getByLabel('개발 경력', { exact: true }).fill('9')
  await page.getByRole('button', { name: '변경 사항 적용', exact: true }).click()
  await expect(page.getByRole('textbox', { name: '저장한 기회 검색', exact: true })).toHaveValue('지원 준비')
  await expect(page.locator('.saved-status')).toHaveText(['지원 완료'])
  await expect(page.locator('.saved-note-preview')).toHaveText([CATALOG_WORKER_NOTE])
  await expect(page.locator('.saved-title')).toHaveText(['Backend Engineer — Atlas Alpha'])
  await page.locator('.data-status-button').click()
  await expect(page.locator('.coverage-stats strong')).toHaveText(['35', '—', '—'])
  await close(page)
  await page.clock.fastForward(120000)
  expect(new URL(page.url()).hash).toBe('#saved')
  expect(await readSavedJson(page)).toBe(saved)
  expect(await exploration(page)).toEqual(state)
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('orbit.v1.profile') ?? '{}'))).toMatchObject({
    name: 'PRIVATE_CATALOG_WORKER_PROFILE', years: 9, skills: ['TypeScript'], residence: 'GB',
  })
  await catalogWorker.expectPaths(0, [])
})

test('a failed refresh restores recovery for a query entered while loading the retained complete catalog', async ({ page, catalogWorker }) => {
  catalogWorker.respond(route => route.fulfill({ json: catalogWorkerCatalog() }))
  await catalogWorker.open({ filters: { query: 'Atlas Alpha' } })
  const initial = await expectInitialCatalogRequest(page, catalogWorker.traffic)
  await companies(page, [{ company: 'Aster QA Labs', titles: ['Backend Engineer — Atlas Alpha'] }])
  const refreshing: Route[] = []
  catalogWorker.respond(route => { refreshing.push(route) })
  await page.locator('.data-status-button').click()
  await page.getByRole('button', { name: '새로고침', exact: true }).click()
  await expect.poll(() => refreshing.length).toBe(1)
  await close(page)
  await query(page).fill('PRIVATE_CATALOG_WORKER_QUERY')
  await expect(page.locator('.active-filter-summary')).toContainText('0개 공고가 현재 조건에 맞아요')
  await expect(page.locator('.search-recovery')).toHaveCount(0)
  await refreshing[0].fulfill({
    status: 503, json: { error: 'Fictional refresh failed; earlier catalog remains valid.', code: 'CATALOG_UNAVAILABLE' },
  })
  await expect(page.locator('.catalog-notice')).toContainText('Fictional refresh failed; earlier catalog remains valid.')
  await expect(page.locator('.search-recovery h3')).toHaveText('이 도시에서 맞는 공고를 찾지 못했어요')
  await expect(page.locator('.recovery-option dt')).toHaveText(['검색어'])
  await expect(page.locator('.recovery-option button')).toHaveText(['회사 3곳 · 공고 4개 보기'])
  await page.locator('.recovery-option button').click()
  await expect(query(page)).toHaveValue('')
  await expect(page.locator('.city-detail-count strong')).toHaveText(['3', '4'])
  await companies(page, [
    { company: 'Aster QA Labs', titles: ['Backend Engineer — Atlas Alpha'] },
    { company: 'Cedar QA Works', titles: ['Backend Engineer — Beacon London Final'] },
    { company: 'Birch QA Systems', titles: ['Backend Engineer — Beacon London', 'Frontend Engineer — Atlas Canvas'] },
  ])
  await expect(page.locator('.search-recovery')).toHaveCount(0)
  await catalogWorker.expectPaths(initial.attempts, [forced])
})

test.describe('dedicated worker delivery and recovery', () => {
  test('a delayed query and then a delayed profile result cannot replace newer intent', async ({ page, catalogWorker }) => {
    const worker = await installCatalogWorkerControl(page)
    catalogWorker.respond(route => route.fulfill({ json: catalogWorkerCatalog() }))
    await catalogWorker.open({ filters: { query: 'Atlas Alpha' } })
    const initial = await expectInitialCatalogRequest(page, catalogWorker.traffic)
    await companies(page, [{ company: 'Aster QA Labs', titles: ['Backend Engineer — Atlas Alpha'] }])
    await worker.hold('project')
    await query(page).fill('Atlas Canvas')
    await expect.poll(() => worker.held('project')).toMatchObject([{ filters: { query: 'Atlas Canvas' } }])
    await query(page).fill('Beacon London')
    await expect(page.locator('.active-filter-summary')).toHaveAttribute('aria-busy', 'true')
    await expect(page.locator('.active-filter-summary')).toContainText('조건에 맞는 공고를 찾고 있어요.')
    await worker.releaseOne('project')
    await expect.poll(() => worker.held('project')).toMatchObject([{ filters: { query: 'Beacon London' } }])
    await expect(page.getByRole('button', { name: 'Frontend Engineer — Atlas Canvas', exact: true })).toHaveCount(0)
    await expect(page.locator('.active-filter-summary')).toHaveAttribute('aria-busy', 'true')
    await worker.releaseAll('project')
    await finalLondon(page)
    await expect(page.locator('.active-filter-summary')).toHaveAttribute('aria-busy', 'false')

    await worker.hold('project')
    await page.getByRole('button', { name: '내 프로필 편집', exact: true }).click()
    await page.getByLabel('개발 경력', { exact: true }).fill('9')
    await page.getByRole('button', { name: '변경 사항 적용', exact: true }).click()
    await expect.poll(() => worker.held('project')).toMatchObject([{ years: 9 }])
    await page.getByRole('button', { name: '내 프로필 편집', exact: true }).click()
    await page.getByLabel('개발 경력', { exact: true }).fill('5')
    await page.getByRole('button', { name: '변경 사항 적용', exact: true }).click()
    await worker.releaseOne('project')
    await expect.poll(() => worker.held('project')).toMatchObject([{ years: 5 }])
    await expect(page.locator('.company-card h3')).toHaveText(['Cedar QA Works', 'Birch QA Systems'])
    await worker.releaseAll('project')
    await finalLondon(page)
    await expect(query(page)).toHaveValue('Beacon London')
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('orbit.v1.profile') ?? '{}'))).toMatchObject({
      name: 'PRIVATE_CATALOG_WORKER_PROFILE', years: 5, residence: 'GB',
    })
    await finalMetadata(page)
    await catalogWorker.expectPaths(initial.attempts, [])
  })

  // PROD-MODAL-1: the same held-preview body runs once at the default desktop viewport and once at
  // 320px, where the observed failure involved the mobile dialog while preview readiness changed.
  // The desktop execution and every original oracle are unchanged; the 320px execution is new.
  for (const width of [1440, 320]) test.describe(`pending preview at ${width}px`, () => {
    test.use({ viewport: { width, height: 960 } })

    test('pending preview hides its old count, and a reply from an older draft/catalog cannot enable Apply', async ({ page, catalogWorker }) => {
      const worker = await installCatalogWorkerControl(page)
      await catalogWorker.open({ filters: { query: 'Beacon', role: 'backend' } })
      const initial = await expectInitialCatalogRequest(page, catalogWorker.traffic)
      await expect(progress(page)).toHaveAttribute('value', '1')
      await page.getByRole('button', { name: /^모든 필터/ }).click()
      await expect(page.getByRole('button', { name: '1개 공고 보기', exact: true })).toBeEnabled()
      await worker.hold('preview')
      await page.getByLabel('고용 형태', { exact: true }).selectOption('fulltime')
      await expect.poll(() => worker.held('preview')).toMatchObject([{ revision: 1, filters: { employment: 'fulltime', salaryMin: 0 } }])
      const apply = page.locator('.filters-dialog .dialog-footer .button.primary')
      await expect(apply).toHaveText('공고 수 계산 중')
      await expect(apply).toHaveAttribute('aria-busy', 'true')
      await expect(apply).toBeDisabled()
      const first = await catalogWorker.takeProgress(1)
      await first.fulfill({ json: catalogWorkerUpdate(2) })
      await expect(progress(page)).toHaveAttribute('value', '2')
      await salary(page, 200000)
      await page.getByRole('checkbox', { name: '연봉 미공개·별도 보상 공고도 포함' }).uncheck()
      const last = await catalogWorker.takeProgress(2)
      await last.fulfill({ json: catalogWorkerUpdate(3) })
      await expect(progress(page)).toHaveCount(0)
      await expect(page.locator('.active-filter-summary')).toContainText('4개 공고가 현재 조건에 맞아요')
      await worker.releaseOne('preview')
      await expect.poll(() => worker.held('preview')).toMatchObject([{
        revision: 3, filters: { query: 'Beacon', employment: 'fulltime', salaryMin: 200000, includeUnknownSalary: false },
      }])
      await expect(apply).toHaveText('공고 수 계산 중')
      await expect(apply).toHaveAttribute('aria-busy', 'true')
      await expect(apply).toBeDisabled()
      await worker.releaseAll('preview')
      await expect(apply).toHaveText('2개 공고 보기')
      await expect(apply).toHaveAttribute('aria-busy', 'false')
      await expect(apply).toBeEnabled()
      await apply.click()
      // An ordinary Apply must actually close the dialog before the results are judged.
      await expect(page.locator('dialog.filters-dialog')).toHaveCount(0)
      await finalLondon(page)
      await finalMetadata(page)
      await catalogWorker.expectPaths(initial.attempts, [firstMonitor, finalMonitor])
    })
  })

  test('a worker crash aborts the active monitor, retains saved data, and explicit retry creates a worker with a fresh consistent view', async ({ page, catalogWorker }) => {
    const worker = await installCatalogWorkerControl(page)
    await catalogWorker.open({
      filters: { query: 'Atlas Alpha', role: 'backend' }, saved: catalogWorkerSaved(),
    })
    const initial = await expectInitialCatalogRequest(page, catalogWorker.traffic)
    await companies(page, [{ company: 'Aster QA Labs', titles: ['Backend Engineer — Atlas Alpha'] }])
    const saved = await readSavedJson(page)
    const late = await catalogWorker.takeProgress(1)
    const before = (await worker.workers()).length
    await worker.crash()
    await expect(page.locator('.catalog-notice')).toContainText('공고 처리 연결이 끊겼어요.')
    await expect(progress(page)).toHaveCount(0)
    await expect.poll(() => catalogWorker.traffic.requests.filter(request => request.error === 'net::ERR_ABORTED').length)
      .toBe(initial.cancelled + 1)
    await companies(page, [{ company: 'Aster QA Labs', titles: ['Backend Engineer — Atlas Alpha'] }])
    await expect(query(page)).toHaveValue('Atlas Alpha')
    await page.clock.fastForward(10000)
    await catalogWorker.expectPaths(initial.attempts, [firstMonitor])
    expect(await readSavedJson(page)).toBe(saved)
    catalogWorker.respond(route => route.fulfill({ json: catalogWorkerRevised() }))
    await page.getByRole('button', { name: '다시 조회', exact: true }).click()
    await companies(page, [{ company: 'Aster QA Labs', titles: ['Backend Engineer — Atlas Alpha Revised'] }])
    expect((await worker.workers()).length).toBe(before + 1)
    expect((await worker.workers()).filter(item => !item.terminated)).toHaveLength(1)
    await late.fulfill({ json: catalogWorkerUpdate(2) })
    await page.clock.fastForward(2000)
    await companies(page, [{ company: 'Aster QA Labs', titles: ['Backend Engineer — Atlas Alpha Revised'] }])
    await page.getByRole('button', { name: 'Backend Engineer — Atlas Alpha Revised', exact: true }).click()
    await expect(page.getByLabel('이 기회에 대한 나의 메모', { exact: true })).toHaveValue(CATALOG_WORKER_NOTE)
    await expect(page.getByRole('button', { name: '지원 완료로 표시됨', exact: true })).toBeVisible()
    await close(page)
    expect(await readSavedJson(page)).toBe(saved)
    await metadata(page, {
      jobs: '9', boardCounts: ['3개 반영', '3개 반영', '3개 반영'],
      times: [CATALOG_WORKER_REVISED_TIME, CATALOG_WORKER_REVISED_TIME, CATALOG_WORKER_REVISED_TIME],
    })
    await catalogWorker.expectPaths(initial.attempts, [firstMonitor, forced])
  })

  test('an open preview invalidates its old count when recovery starts a new worker whose local revision restarts', async ({ page, catalogWorker }) => {
    const worker = await installCatalogWorkerControl(page)
    catalogWorker.respond(route => route.fulfill({ json: catalogWorkerCatalog() }))
    await catalogWorker.open({ filters: { query: 'Beacon', role: 'backend' } })
    const initial = await expectInitialCatalogRequest(page, catalogWorker.traffic)
    await page.getByRole('button', { name: /^모든 필터/ }).click()
    await expect(page.getByRole('button', { name: '4개 공고 보기', exact: true })).toBeEnabled()
    const state = await exploration(page)
    const before = (await worker.workers()).length
    await worker.crash()
    await expect(page.locator('.catalog-notice')).toContainText('공고 처리 연결이 끊겼어요.')
    catalogWorker.respond(route => route.fulfill({ json: catalogWorkerEmpty() }))
    await page.clock.fastForward(61000)
    // Like the existing revalidation suite, this is an explicit synthetic
    // foreground-network signal, not a claim about OS/bfcache behavior.
    await page.evaluate(() => window.dispatchEvent(new Event('online')))
    await expect(page.locator('.active-filter-summary')).toContainText('0개 공고가 현재 조건에 맞아요')
    await expect(page.locator('.catalog-notice')).toHaveCount(0)
    expect((await worker.workers()).length).toBe(before + 1)
    await expect(page.getByRole('button', { name: '0개 공고 보기', exact: true })).toBeEnabled()
    await expect(page.getByRole('button', { name: '4개 공고 보기', exact: true })).toHaveCount(0)
    expect(await exploration(page)).toEqual(state)
    await close(page)
    await metadata(page, {
      jobs: '0', boardCounts: ['0개 반영', '0개 반영', '0개 반영'],
      times: [CATALOG_WORKER_TIME, CATALOG_WORKER_SECOND_TIME, CATALOG_WORKER_FINAL_TIME],
    })
    await catalogWorker.expectPaths(initial.attempts, [ordinary])
  })

  test('worker startup failure is explicit and retryable without invented results or synchronous collection fallback', async ({ page, catalogWorker }) => {
    const worker = await installCatalogWorkerControl(page, { unavailable: true })
    // Stage73: a Worker that cannot be constructed leaves the received response unusable, so
    // the app cancels it after headers. Prove that cancellation directly rather than expecting
    // the healthy finished-request lifecycle; every later visible, saved and retry check is unchanged.
    const fetches = await installCatalogFetchObserver(page)
    await catalogWorker.open({ filters: { query: 'Beacon London', role: 'backend' }, saved: catalogWorkerSaved() })
    const initial = await expectCancelledInitialCatalogRequest(page, catalogWorker.traffic, fetches)
    await expect(page.locator('.catalog-placeholder')).toContainText('공고 처리 연결이 끊겼어요.')
    await expect(page.locator('.company-card, .search-recovery, .city-row')).toHaveCount(0)
    await expect(page.getByRole('button', { name: '다시 조회', exact: true })).toBeEnabled()
    await expect(query(page)).toHaveValue('Beacon London')
    const saved = await readSavedJson(page)
    expect(await worker.workers()).toEqual([])
    await page.clock.fastForward(10000)
    await catalogWorker.expectPaths(initial.attempts, [])
    await worker.unavailable(false)
    catalogWorker.respond(route => route.fulfill({ json: catalogWorkerCatalog() }))
    await page.getByRole('button', { name: '다시 조회', exact: true }).click()
    await finalLondon(page)
    await expect(page.locator('.catalog-placeholder')).toHaveCount(0)
    expect((await worker.workers()).filter(item => !item.terminated)).toHaveLength(1)
    expect(await readSavedJson(page)).toBe(saved)
    await finalMetadata(page)
    await catalogWorker.expectPaths(initial.attempts, [forced])
  })
})
