/** Public-only behavior with intercepted synthetic inputs; no live provider requests. */
import { expect } from '@playwright/test'
import type { Page, TestInfo } from '@playwright/test'
import { resourceCheckedTest as test } from './helpers/public-app'
import {
  IMPORT_NOTE, LEGACY_EXPLORATION, PUBLIC_NOTE, PUBLIC_SAVED, publicCatalog,
} from '../fixtures/public-only-contract'
import { LEGACY_SAVED, mixedImport } from '../fixtures/legacy-saved-contract'
import {
  committed, deferredReply, expectTraffic, forced, freshPage, guardInitialPaint, installHarness,
  noResults, noSampleChoice, ordinary, releasePaint, seed, expectSavedOnlyTraffic, rawSavedDatabase,
} from './helpers/public-only'
import { downloadText, expectExcludedImport, expectNoRetiredPaint, guardRetiredCards, openSavedFiles } from './helpers/saved-retirement'

// Preserve the original intercepted-context contract when using the root config.
test.use({ serviceWorkers: 'block' })

const search = (page: Page) => page.getByRole('textbox', { name: '도시, 회사 또는 포지션 검색', exact: true })
const dataButton = (page: Page) => page.getByRole('button', { name: '데이터와 추천 방식', exact: true })

async function inspectData(page: Page, jobs?: string, capture?: TestInfo) {
  const opener = dataButton(page)
  await opener.click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  await noSampleChoice(page)
  if (jobs !== undefined)
    await expect(dialog.locator('.coverage-stats > div').filter({ hasText: '조회된 개발 공고' }).locator('strong')).toHaveText(jobs)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true)
  if (capture) {
    await page.evaluate(async () => { await document.fonts.ready })
    const screenshot = capture.outputPath('public-only-data-desktop.png')
    await page.screenshot({ path: screenshot })
    await capture.attach('public-only-data-desktop', { path: screenshot, contentType: 'image/png' })
  }
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await expect(opener).toBeFocused()
}

async function conditionsSurvive(page: Page, query = 'Backend Engineer') {
  await expect(search(page)).toHaveValue(query)
  await expect(page.getByLabel('직무 필터', { exact: true })).toHaveValue('backend')
  await expect(page.getByLabel('근무 형태 필터', { exact: true })).toHaveValue('onsite')
  await expect(page.getByRole('button', { name: '유럽', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByRole('button', { name: '2D 지도', exact: true })).toHaveAttribute('aria-pressed', 'true')
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('orbit.v1.exploration')!))).toEqual({
    source: 'public',
    filters: { query, region: 'europe', role: 'backend', workMode: 'onsite', visa: 'all',
      employment: 'fulltime', postingType: 'opening', salaryMin: 0, includeUnknownSalary: true, remoteEligibleOnly: true },
    selectedId: 'london', panelTab: 'cities', mapMode: 'flat', light: true, citySort: 'salary',
  })
}

async function unchangedPublicSave(page: Page) {
  const records = await committed(page)
  expect(records.find(item => item.job.id === 'greenhouse-fixture65-rail-api')).toMatchObject({
    job: { id: 'greenhouse-fixture65-rail-api', source: 'greenhouse', title: 'Backend Engineer — Fable Rail API',
      url: 'https://example.test/jobs/greenhouse-fixture65-rail-api', fetchedAt: '2026-09-26T23:55:00.000Z' },
    company: { id: 'fixture65-rail', name: 'Fable Rail' },
    savedAt: '2026-09-26T23:56:00.000Z', status: 'applied', note: 'PRIVATE_65_PUBLIC_NOTE\n다음 주 지원 · =1+2 🌱',
  })
}

for (const width of [1440, 320]) {
  test(`first visit requests only public data, paints no demo results, and has no sample selector at ${width}px`, async ({ page, baseURL }, testInfo) => {
    await page.setViewportSize({ width, height: 900 })
    const held = deferredReply()
    const h = await installHarness(page, baseURL!, held.promise)
    await guardInitialPaint(page)
    // No exploration/profile seed: this really exercises the first visit.
    await page.goto(h.origin)
    await expect.poll(() => h.catalog().length).toBeGreaterThan(0)
    await expect(page.locator('.catalog-placeholder')).toHaveAttribute('aria-busy', 'true')
    await noResults(page)
    await noSampleChoice(page)
    await inspectData(page)
    await releasePaint(page)
    held.resolve({ json: publicCatalog() })
    await expect(page.locator('.city-row')).toHaveCount(3)
    await expect(page.locator('.map-stats strong')).toHaveText(['2곳', '3곳'])
    await inspectData(page, '4', width === 1440 ? testInfo : undefined)
    await noSampleChoice(page)
    await expectTraffic(h, [{ path: ordinary, status: 200 }])
  })
}

for (const source of ['sample', 'greenhouse']) {
  test(`legacy ${source} selection becomes public without losing filters, comparison, or a real new-page revisit`, async ({ page, context, baseURL }) => {
    const held = deferredReply()
    const h = await installHarness(page, baseURL!, held.promise)
    await seed(page, h.origin, { exploration: { ...LEGACY_EXPLORATION, source }, compare: ['london', 'berlin'] })
    await guardInitialPaint(page)
    await page.goto(h.origin)
    await expect.poll(() => h.catalog().length).toBeGreaterThan(0)
    await noResults(page)
    await conditionsSurvive(page)
    await releasePaint(page)
    held.resolve({ json: publicCatalog() })
    await expect(page.locator('.mini-job-title')).toHaveText(['Backend Engineer — Fable Rail API'])
    await conditionsSurvive(page)
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('orbit.v1.compare')!))).toEqual(['london', 'berlin'])
    await page.getByRole('navigation', { name: '주요 메뉴' }).getByRole('button', { name: /도시 비교/ }).click()
    await expect(page.locator('.comparison-city-name h2')).toHaveText(['런던', '베를린'])
    await noSampleChoice(page)
    const revisit = await freshPage(context, h.origin)
    try {
      await expect(revisit.locator('.mini-job-title')).toHaveText(['Backend Engineer — Fable Rail API'])
      await conditionsSurvive(revisit)
      await inspectData(revisit, '4')
      await expectTraffic(h, [{ path: ordinary, status: 200 }, { path: ordinary, status: 200 }], 2)
    } finally { await revisit.close() }
  })
}

for (const failure of ['http', 'network'] as const) {
  test(`a first ${failure} failure offers a public retry with no fictional fallback`, async ({ page, baseURL }) => {
    const h = await installHarness(page, baseURL!, failure === 'http'
      ? { status: 503, json: { error: 'Synthetic unavailable feed' } }
      : { abort: 'internetdisconnected' })
    await guardInitialPaint(page)
    await page.goto(h.origin)
    await expect(page.getByRole('heading', { name: '공개 공고에 연결하지 못했어요', exact: true })).toBeVisible()
    await noResults(page)
    await inspectData(page)
    await noSampleChoice(page)
    h.setReply({ json: publicCatalog() })
    await releasePaint(page)
    await page.getByRole('button', { name: '다시 조회', exact: true }).click()
    await expect(page.locator('.city-row')).toHaveCount(3)
    await expectTraffic(h, [
      failure === 'http' ? { path: ordinary, status: 503 } : { path: ordinary, status: null, error: 'net::ERR_INTERNET_DISCONNECTED' },
      { path: forced, status: 200 },
    ])
  })
}

test('SRC65-01: startup public guidance opens the data dialog during loading and initial failure, then retries with filters intact', async ({ page, baseURL }) => {
  const held = deferredReply()
  const h = await installHarness(page, baseURL!, held.promise)
  await seed(page, h.origin, { exploration: LEGACY_EXPLORATION })
  await page.goto(h.origin)
  const placeholder = page.locator('.catalog-placeholder')
  const guidance = placeholder.getByRole('button', { name: '공개 공고 안내', exact: true })
  const inspectGuidance = async (loading: boolean) => {
    await expect(guidance).toBeVisible()
    await expect(page.getByRole('button', { name: '데이터 모드 선택', exact: true })).toHaveCount(0)
    await guidance.click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()
    await expect(dialog).toContainText('공개 채용공고')
    await expect(dialog.locator('.data-source-options')).toHaveCount(0)
    await noSampleChoice(page)
    await expect(dialog.getByRole('button', { name: '새로고침', exact: true })).toHaveCount(0)
    if (loading) {
      await expect(dialog.getByRole('button', { name: '공개 공고 다시 조회', exact: true })).toHaveCount(0)
      await expect(dialog.getByRole('alert')).toHaveCount(0)
    }
    else {
      await expect(dialog.getByRole('alert')).toContainText('SRC65-01 synthetic initial failure')
      await expect(dialog.getByRole('button', { name: '공개 공고 다시 조회', exact: true })).toBeEnabled()
    }
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await expect(guidance).toBeFocused()
    await conditionsSurvive(page)
    await noResults(page)
  }
  await expect(placeholder).toHaveAttribute('aria-busy', 'true')
  await inspectGuidance(true)
  held.resolve({ status: 503, json: { error: 'SRC65-01 synthetic initial failure' } })
  await expect(placeholder).toHaveAttribute('aria-busy', 'false')
  await expect(page.getByRole('heading', { name: '공개 공고에 연결하지 못했어요', exact: true })).toBeVisible()
  await inspectGuidance(false)
  h.setReply({ json: publicCatalog() })
  await placeholder.getByRole('button', { name: '다시 조회', exact: true }).click()
  await expect(page.locator('.mini-job-title')).toHaveText(['Backend Engineer — Fable Rail API'])
  await expect(placeholder).toHaveCount(0)
  await conditionsSurvive(page)
  await noSampleChoice(page)
  await expectTraffic(h, [{ path: ordinary, status: 503 }, { path: forced, status: 200 }])
})

test('a successful empty public feed remains empty instead of reviving a demo or calling it a connection error', async ({ page, baseURL }) => {
  const h = await installHarness(page, baseURL!, { json: publicCatalog('empty') })
  await page.goto(h.origin)
  await expect(page.locator('.data-status-button')).toHaveText('공개 채용')
  await expect(page.locator('.map-stats strong')).toHaveText(['0곳', '0곳'])
  await noResults(page)
  await expect(page.getByRole('heading', { name: '공개 공고에 연결하지 못했어요', exact: true })).toHaveCount(0)
  await inspectData(page, '0')
  await expectTraffic(h, [{ path: ordinary, status: 200 }])
})

test('search and filter boundaries, retained public results after failure, refresh replacement, and saved snapshots survive together', async ({ page, baseURL }) => {
  const h = await installHarness(page, baseURL!, { json: publicCatalog() })
  await seed(page, h.origin, { exploration: LEGACY_EXPLORATION, saved: [PUBLIC_SAVED] })
  await page.goto(h.origin)
  await expect(page.locator('.mini-job-title')).toHaveText(['Backend Engineer — Fable Rail API'])
  await unchangedPublicSave(page)
  await search(page).fill('No matching fixture 65')
  await expect(page.locator('.mini-job-title, .company-card')).toHaveCount(0)
  await search(page).fill('Fable Rail')
  await expect(page.locator('.mini-job-title')).toHaveText(['Backend Engineer — Fable Rail API'])
  // The frontend negative control is in London too, but the backend filter excludes it.
  await expect(page.locator('.active-filter-summary')).toContainText('2개 공고가 현재 조건에 맞아요')
  await conditionsSurvive(page, 'Fable Rail')
  await expectTraffic(h, [{ path: ordinary, status: 200 }])

  h.setReply({ status: 503, json: { error: 'Synthetic refresh failed; retain prior public data' } })
  await dataButton(page).click()
  await page.getByRole('dialog').getByRole('button', { name: '새로고침', exact: true }).click()
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText('Synthetic refresh failed')
  await page.keyboard.press('Escape')
  await expect(page.locator('.mini-job-title')).toHaveText(['Backend Engineer — Fable Rail API'])
  await conditionsSurvive(page, 'Fable Rail')
  await unchangedPublicSave(page)

  const held = deferredReply()
  h.setReply(held.promise)
  await page.locator('.catalog-notice').getByRole('button', { name: '다시 조회', exact: true }).click()
  await expect(page.locator('.data-status-button')).toHaveText('공개 공고 조회 중')
  await expect(page.locator('.mini-job-title')).toHaveText(['Backend Engineer — Fable Rail API'])
  await conditionsSurvive(page, 'Fable Rail')
  held.resolve({ json: publicCatalog('refreshed') })
  await expect(page.locator('.mini-job-title')).toHaveText(['Backend Engineer — Fable Rail Freight'])
  await conditionsSurvive(page, 'Fable Rail')
  await unchangedPublicSave(page)
  await page.reload()
  await expect(page.locator('.mini-job-title')).toHaveText(['Backend Engineer — Fable Rail Freight'])
  await conditionsSurvive(page, 'Fable Rail')
  await unchangedPublicSave(page)
  await noSampleChoice(page)
  await expectTraffic(h, [
    { path: ordinary, status: 200 }, { path: forced, status: 503 },
    { path: forced, status: 200 }, { path: ordinary, status: 200 },
  ], 2)
})

for (const store of ['localStorage', 'indexedDB-v1'] as const) {
  test(`mixed ${store} saved data keeps the public application and excludes a fictional active opportunity`, async ({ page, baseURL }) => {
    const h = await installHarness(page, baseURL!, { json: publicCatalog() })
    await seed(page, h.origin, { exploration: LEGACY_EXPLORATION, saved: [LEGACY_SAVED, PUBLIC_SAVED], store })
    await guardRetiredCards(page)
    await page.goto(`${h.origin}/#saved`)
    await committed(page)
    await expect(page.locator('.saved-title')).toHaveText(['Backend Engineer — Fable Rail API'])
    await unchangedPublicSave(page)
    await page.locator('.saved-title').click()
    await expect(page.getByLabel('이 기회에 대한 나의 메모')).toHaveValue(PUBLIC_NOTE)
    await page.keyboard.press('Escape')
    await expectNoRetiredPaint(page)
    await page.reload()
    await committed(page)
    await expect(page.locator('.saved-title')).toHaveText(['Backend Engineer — Fable Rail API'])
    await unchangedPublicSave(page)
    await noSampleChoice(page)
    await expectNoRetiredPaint(page)
    await openSavedFiles(page)
    const recovery = JSON.parse(await downloadText(page, page.locator('.saved-recovery-source').getByRole('button', { name: '이 원본 내려받기', exact: true })))
    expect(recovery).toMatchObject({ format: 'orbit-saved-recovery', version: 1 })
    expect(recovery.sources).toEqual(store === 'localStorage'
      ? [{ kind: 'legacy', count: 1, original: JSON.stringify([LEGACY_SAVED, PUBLIC_SAVED]) }]
      : [{ kind: 'retired-samples', count: 1, original: [{ id: 'sample-fixture65-obsolete', order: 2, record: LEGACY_SAVED }] }])
    expectSavedOnlyTraffic(h)
  })
}

for (const format of ['backup', 'legacy', 'recovery'] as const) {
  test(`a mixed ${format} import restores the public neighbour without recreating the fictional opportunity`, async ({ page, baseURL }) => {
    const h = await installHarness(page, baseURL!, { json: publicCatalog() })
    await seed(page, h.origin, { exploration: LEGACY_EXPLORATION, saved: [PUBLIC_SAVED] })
    await page.goto(`${h.origin}/#saved`)
    await committed(page)
    await page.getByRole('button', { name: '기록 백업·복원', exact: true }).click()
    await page.getByLabel('백업 또는 복구 파일', { exact: true }).setInputFiles({
      name: `synthetic-stage65-${format}.json`, mimeType: 'application/json', buffer: Buffer.from(mixedImport(format)),
    })
    const incoming = page.locator('.saved-import-row').filter({ hasText: 'Backend Engineer — Loom Textiles Platform' })
    await expect(incoming.getByRole('checkbox')).toBeChecked()
    await expectExcludedImport(page, 1)
    await expect(page.locator('.saved-import-summary')).toContainText('읽을 수 없는 항목 1개')
    // Preview must not mutate existing records.
    await expect(page.getByRole('button', { name: '선택한 1개 가져오기', exact: true })).toBeEnabled()
    await unchangedPublicSave(page)
    expect((await committed(page)).map(item => item.job.id)).toEqual(['greenhouse-fixture65-rail-api'])
    await page.getByRole('button', { name: '선택한 1개 가져오기', exact: true }).click()
    await expect(page.locator('.saved-file-message')).toContainText('선택한 1개 기록을 저장했어요.')
    await page.keyboard.press('Escape')
    await expect(page.locator('.saved-title')).toHaveText([
      'Backend Engineer — Loom Textiles Platform', 'Backend Engineer — Fable Rail API',
    ])
    await unchangedPublicSave(page)
    expect((await committed(page)).find(item => item.job.id === 'ashby-fixture65-textile-platform')).toMatchObject({
      job: { source: 'ashby', title: 'Backend Engineer — Loom Textiles Platform', fetchedAt: '2026-09-26T23:55:00.000Z' },
      savedAt: '2026-09-26T23:57:00.000Z', status: 'saved', note: IMPORT_NOTE,
    })
    await page.reload()
    await committed(page)
    await expect(page.locator('.saved-title')).toHaveText([
      'Backend Engineer — Loom Textiles Platform', 'Backend Engineer — Fable Rail API',
    ])
    await unchangedPublicSave(page)
    await noSampleChoice(page)
    const raw = await rawSavedDatabase(page)
    expect(raw.meta.retiredSamples ?? []).toEqual([])
    expect(raw.meta.recovery).toBeUndefined()
    await openSavedFiles(page)
    await expect(page.locator('.saved-recovery-source')).toHaveCount(0)
    expectSavedOnlyTraffic(h)
  })
}
