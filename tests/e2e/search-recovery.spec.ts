import { expect, test } from '@playwright/test'
import type { Page, Route } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import type { Catalog, Filters } from '../../shared/types'
import { SEARCH_COMPANIES, SEARCH_FILTERS, SEARCH_PROFILE, SEARCH_TIME, searchCatalog, searchJob } from '../fixtures/search-catalog'

test.beforeEach(async ({ page }) => { await page.clock.setFixedTime(new Date(SEARCH_TIME)) })

async function restore(page: Page, catalog: Catalog, filters = SEARCH_FILTERS, selectedId: string | null = null, response?: (route: Route) => Promise<unknown>) {
  await page.route('**/api/catalog?source=public*', route => response ? response(route) : route.fulfill({ json: catalog }))
  await page.addInitScript(({ filters, selectedId, profile }) => {
    if (!localStorage.getItem('orbit.v1.profile')) localStorage.setItem('orbit.v1.profile', JSON.stringify(profile))
    if (!localStorage.getItem('orbit.v1.exploration')) localStorage.setItem('orbit.v1.exploration', JSON.stringify({
      source: 'public', filters, selectedId, panelTab: 'cities', mapMode: 'flat',
    }))
  }, { filters, selectedId, profile: SEARCH_PROFILE })
  await page.goto('/')
}

const stored = (page: Page) => page.evaluate(() => JSON.parse(localStorage.getItem('orbit.v1.exploration') || '{}'))

test('a local preview changes only the query, supports keyboard and undo, and survives revisiting', async ({ page }) => {
  const catalog = searchCatalog([
    searchJob('one'), searchJob('two'),
    searchJob('three', { companyId: SEARCH_COMPANIES[1].id, cityIds: ['berlin'] }),
  ])
  const filters = { ...SEARCH_FILTERS, query: 'private-search-sentinel' }
  const requests: string[] = []
  page.on('request', request => { if (request.url().includes('/api/')) requests.push(request.url()) })
  await restore(page, catalog, filters)
  const previousProfile = await page.evaluate(() => localStorage.getItem('orbit.v1.profile'))
  await expect(page.locator('.recovery-option')).toHaveCount(1)
  await expect(page.locator('.recovery-option dt')).toHaveText('검색어')
  await expect(page.locator('.recovery-option button')).toHaveText('회사 2곳 · 공고 3개 보기')
  expect((await stored(page)).filters).toEqual(filters)
  await page.locator('.recovery-option button').focus()
  await page.locator('.recovery-option button').press('Enter')
  await expect(page.locator('.city-row')).toHaveCount(2)
  await expect(page.locator('.results-panel')).toBeFocused()
  await expect.poll(async () => (await stored(page)).filters).toEqual(SEARCH_FILTERS)
  await page.getByRole('button', { name: '실행 취소', exact: true }).click()
  await expect(page.locator('.recovery-option')).toHaveCount(1)
  await expect.poll(async () => (await stored(page)).filters).toEqual(filters)
  await page.locator('.recovery-option button').click()
  await expect(page.locator('.city-row')).toHaveCount(2)
  await page.reload()
  await expect(page.locator('.city-row')).toHaveCount(2)
  expect((await stored(page)).filters).toEqual(SEARCH_FILTERS)
  expect(await page.evaluate(() => localStorage.getItem('orbit.v1.profile'))).toBe(previousProfile)
  for (const request of requests) {
    const url = new URL(request)
    expect(url.pathname).toBe('/api/catalog')
    expect([...url.searchParams.keys()].every(key => key === 'source' || key === 'refresh')).toBe(true)
    expect(request).not.toContain('private-search-sentinel')
  }
})

test('combined changes disclose query, salary and conditional visa support before applying in the selected city', async ({ page }) => {
  const catalog = searchCatalog([searchJob('conditional', {
    visa: 'conditional', salary: { min: 100000, max: 120000, currency: 'USD' },
  })])
  const filters = { ...SEARCH_FILTERS, query: 'missing-query' }
  await restore(page, catalog, filters, 'london')
  await expect(page.locator('.recovery-option')).toHaveCount(1)
  await expect(page.locator('.recovery-option h5')).toHaveText('3가지 조건 변경')
  await expect(page.locator('.recovery-option dt')).toHaveText(['검색어', '희망 연봉 하한', '비자 지원'])
  await expect(page.locator('.recovery-warning')).toContainText('국가·직무·지원자별')
  expect((await stored(page)).filters).toEqual(filters)
  await page.locator('.recovery-option button').click()
  await expect(page.locator('.company-card')).toHaveCount(1)
  await expect(page.locator('.visa-tag')).toHaveText('비자 조건부 지원 명시')
  await expect.poll(async () => (await stored(page)).filters).toEqual({ ...SEARCH_FILTERS, query: '', salaryMin: 0, visa: 'supported' })
  expect((await stored(page)).selectedId).toBe('london')
  await page.getByLabel('비자 지원 필터').selectOption('possible')
  await page.getByRole('button', { name: '실행 취소', exact: true }).click()
  await expect.poll(async () => (await stored(page)).filters).toEqual({ ...filters, visa: 'possible' })
})

test('other cities and remote opportunities are offered without resetting the chosen requirements', async ({ page }) => {
  const catalog = searchCatalog([
    searchJob('berlin', { cityIds: ['berlin'], locationLabel: 'Berlin' }),
    searchJob('remote', { workMode: 'remote', cityIds: [], locationLabel: 'Remote, Global', remoteWorldwide: true }),
  ])
  await restore(page, catalog, SEARCH_FILTERS, 'london')
  await expect(page.locator('.recovery-option')).toHaveCount(0)
  await expect(page.locator('.recovery-alternatives button')).toHaveCount(2)
  await page.getByRole('button', { name: /원격 기회 보기/ }).click()
  await expect(page.locator('.company-card')).toHaveCount(1)
  await expect(page.locator('.mini-job-title')).toContainText('remote')
  await expect(page.locator('.results-panel')).toBeFocused()
  const exploration = await stored(page)
  expect(exploration).toMatchObject({ filters: SEARCH_FILTERS, selectedId: null, panelTab: 'remote' })
  expect(JSON.parse(await page.evaluate(() => localStorage.getItem('orbit.v1.profile')) || '{}').residence).toBe('GB')
})

test('a successful empty source explains the collection scope and never invents a recovery count', async ({ page }) => {
  await restore(page, searchCatalog([]))
  await expect(page.locator('.search-recovery')).toContainText('현재 불러온 자료에는 이 탐색 범위의 공고가 없어요')
  await expect(page.locator('.recovery-option')).toHaveCount(0)
  await expect(page.locator('.recovery-alternatives')).toHaveCount(0)
  await expect(page.getByRole('button', { name: '수집 범위 확인' })).toBeVisible()
})

test('expanding remote geography keeps the residence and clearly labels the broader results after revisiting', async ({ page }) => {
  const catalog = searchCatalog([
    searchJob('us', { workMode: 'remote', cityIds: [], remoteCountries: ['US'], locationLabel: 'Remote, US' }),
    searchJob('unknown-country', { workMode: 'remote', cityIds: [], remoteScopeUnknown: true, locationLabel: 'Remote' }),
  ])
  await restore(page, catalog)
  await page.locator('.results-tabs').getByRole('button', { name: /원격 기회/ }).click()
  await expect(page.locator('.recovery-option dt')).toHaveText('원격근무 지역')
  await expect(page.locator('.recovery-warning')).toContainText('다른 국가만 허용하거나 지역이 미확인인 공고')
  await page.locator('.recovery-option button').click()
  await expect(page.locator('.remote-range-note')).toContainText('거주 국가 밖·지역 미확인 공고도 표시 중')
  await expect(page.locator('.all-filters-button .filter-count')).toHaveText('5')
  await expect.poll(async () => (await stored(page)).filters).toEqual({ ...SEARCH_FILTERS, remoteEligibleOnly: false })
  await page.reload()
  await expect(page.locator('.remote-range-note')).toBeVisible()
  await expect(page.locator('.residence-button')).toHaveText('영국 · 프로필 거주 국가')
  expect(JSON.parse(await page.evaluate(() => localStorage.getItem('orbit.v1.profile')) || '{}').residence).toBe('GB')
})

test('loading and failed catalog requests do not appear as empty results with filter recommendations', async ({ page }) => {
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  await restore(page, searchCatalog([]), SEARCH_FILTERS, null, async route => { await gate; await route.abort('failed') })
  await expect(page.getByRole('button', { name: '공개 공고 조회 중' })).toBeVisible()
  await expect(page.locator('.search-recovery')).toHaveCount(0)
  release()
  await expect(page.getByRole('button', { name: '공개 공고 연결 필요' })).toBeVisible()
  await expect(page.locator('.search-recovery')).toHaveCount(0)
  await expect(page.locator('.recovery-option')).toHaveCount(0)
})

test.describe('narrow-screen recovery', () => {
  test.use({ viewport: { width: 320, height: 780 }, isMobile: true, hasTouch: true })
  test('long searches and multiple required changes remain readable and accessible before selection', async ({ page }) => {
    const catalog = searchCatalog([searchJob('mobile', {
      visa: 'unknown', salary: null,
    })])
    const filters: Filters = { ...SEARCH_FILTERS, query: 'LongPrivateSearch'.repeat(20) }
    await restore(page, catalog, filters, 'london')
    await page.locator('.search-recovery').scrollIntoViewIfNeeded()
    await expect(page.locator('.recovery-option h5')).toHaveText('3가지 조건 변경')
    await expect(page.locator('.recovery-warning')).toHaveCount(2)
    await expect(page.locator('.recovery-option dd').last()).toContainText('미확인 공고도 포함')
    expect((await stored(page)).filters).toEqual(filters)
    expect(await page.locator('body').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
    expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([])
  })
})
