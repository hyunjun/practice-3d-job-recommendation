import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { DEFAULT_FILTERS } from '../../shared/types'
import type { Catalog } from '../../shared/types'
import { SEARCH_COMPANIES, SEARCH_PROFILE, SEARCH_TIME, searchCatalog, searchJob } from '../fixtures/search-catalog'
import { expectInitialCatalogRequest, watchApiRequests } from './helpers/api-requests'

const platform = searchJob('platform', { title: 'Backend Engineer Platform', employment: 'contract', salary: null })
const storage = searchJob('storage', { title: 'Backend Engineer Storage', minExperience: 12 })
const payments = searchJob('payments', { title: 'Backend Engineer Payments', companyId: SEARCH_COMPANIES[1].id })
const ledger = searchJob('ledger', { title: 'Backend Engineer Ledger', companyId: SEARCH_COMPANIES[1].id, minExperience: 7 })
const discoveryCatalog: Catalog = {
  ...searchCatalog([ledger, storage, platform, payments]),
  companies: SEARCH_COMPANIES.map((company, index) => ({ ...company, name: index === 0 ? 'Juniper Labs' : 'Meridian Systems' })),
}
const allDiscovered = [
  { company: 'Juniper Labs', titles: [platform.title, storage.title] },
  { company: 'Meridian Systems', titles: [payments.title, ledger.title] },
]

// Distinct provider IDs can have canonically equivalent Unicode spellings.
// Equal qualifications and equivalent IDs make source order decisive within each company.
const atlas = searchJob('atlas', { id: `greenhouse-${SEARCH_COMPANIES[0].id}-résumé`, title: 'Backend Engineer Atlas' })
const cedar = searchJob('cedar', { id: `greenhouse-${SEARCH_COMPANIES[1].id}-résumé`, title: 'Backend Engineer Cedar', companyId: SEARCH_COMPANIES[1].id })
const beacon = searchJob('beacon', { id: `greenhouse-${SEARCH_COMPANIES[0].id}-re\u0301sume\u0301`, title: 'Backend Engineer Beacon' })
const delta = searchJob('delta', { id: `greenhouse-${SEARCH_COMPANIES[1].id}-re\u0301sume\u0301`, title: 'Backend Engineer Delta', companyId: SEARCH_COMPANIES[1].id })
const tiedCatalog: Catalog = {
  ...searchCatalog([atlas, cedar, beacon, delta]),
  companies: SEARCH_COMPANIES.map((company, index) => ({ ...company, name: index === 0 ? 'Café' : 'Cafe\u0301' })),
}
const allTied = [
  { company: 'Café', titles: [atlas.title, beacon.title] },
  { company: 'Cafe\u0301', titles: [cedar.title, delta.title] },
]

const us = searchJob('us-atlas', {
  title: 'Backend Engineer US Atlas', workMode: 'remote', cityIds: [], locationLabel: 'Remote, US', remoteCountries: ['US'],
})
const worldwide = searchJob('global-cedar', {
  title: 'Backend Engineer Global Cedar', companyId: SEARCH_COMPANIES[1].id,
  workMode: 'remote', cityIds: [], locationLabel: 'Remote, Global', remoteWorldwide: true,
})
const uk = searchJob('uk-birch', {
  title: 'Backend Engineer UK Birch', minExperience: 7,
  workMode: 'remote', cityIds: [], locationLabel: 'Remote, UK', remoteCountries: ['GB'],
})
const unknown = searchJob('unconfirmed-delta', {
  title: 'Backend Engineer Unconfirmed Delta', companyId: SEARCH_COMPANIES[1].id, minExperience: 12,
  workMode: 'remote', cityIds: [], locationLabel: 'Remote', remoteScopeUnknown: true,
})
const london = searchJob('london-oak', { title: 'Backend Engineer London Oak' })
const remoteCatalog = searchCatalog([us, worldwide, uk, unknown, london])
const allRemote = [
  { company: 'Fixture A', titles: [us.title, uk.title] },
  { company: 'Fixture B', titles: [worldwide.title, unknown.title] },
]
const eligibleRemote = [
  { company: 'Fixture B', titles: [worldwide.title] },
  { company: 'Fixture A', titles: [uk.title] },
]

async function restore(page: Page, catalog: Catalog, query: string, panelTab: 'cities' | 'remote' = 'cities') {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  const traffic = watchApiRequests(page)
  await page.clock.setFixedTime(new Date(SEARCH_TIME))
  await page.route('**/api/catalog?source=public*', route => route.fulfill({ json: catalog }))
  await page.addInitScript(({ profile, exploration }) => {
    if (!localStorage.getItem('orbit.v1.profile')) localStorage.setItem('orbit.v1.profile', JSON.stringify(profile))
    if (!localStorage.getItem('orbit.v1.exploration')) localStorage.setItem('orbit.v1.exploration', JSON.stringify(exploration))
  }, {
    profile: SEARCH_PROFILE,
    exploration: {
      source: 'public', mapMode: 'flat', selectedId: panelTab === 'cities' ? 'london' : null,
      panelTab, filters: { ...DEFAULT_FILTERS, query },
    },
  })
  await page.goto('/')
  const initial = await expectInitialCatalogRequest(page, traffic)
  return { search: page.getByLabel('도시, 회사 또는 포지션 검색'), traffic, initial, errors }
}

async function expectCompanies(page: Page, expected: { company: string; titles: string[] }[]) {
  await expect(page.locator('.company-card h3')).toHaveText(expected.map(group => group.company))
  for (const [index, group] of expected.entries()) {
    const card = page.locator('.company-card').nth(index)
    await expect(card.locator('.mini-job-title').first()).toHaveText(group.titles[0])
    if (group.titles.length > 1) {
      const toggle = card.locator('.more-jobs').first()
      await expect(toggle).toHaveAttribute('aria-expanded', /^(true|false)$/)
      if (await toggle.getAttribute('aria-expanded') === 'false') await toggle.click()
    }
    await expect(card.locator('.mini-job-title')).toHaveText(group.titles)
  }
}

async function expectLocalSearch(page: Page, traffic: ReturnType<typeof watchApiRequests>, attempts: number, errors: string[]) {
  expect(traffic.requests).toHaveLength(attempts)
  for (const request of traffic.requests) {
    expect(request.url).toBe(new URL('/api/catalog?source=public', page.url()).href)
    expect(request.method).toBe('GET')
    expect(request.body).toBeNull()
  }
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('orbit.v1.profile') || '{}'))).toEqual(SEARCH_PROFILE)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  expect(errors).toEqual([])
}

for (const width of [1440, 320]) test.describe(`search ordering after selective discovery at ${width}px`, () => {
  test.use({ viewport: { width, height: 960 } })

  test('an initially empty search discovers stronger jobs later and excludes hidden leaders from company order', async ({ page }, info) => {
    const { search, traffic, initial, errors } = await restore(page, discoveryCatalog, 'private-missing-position')
    await expect(page.locator('.active-filter-summary')).toContainText('0개 공고가 현재 조건에 맞아요')
    await expect(page.locator('.company-card')).toHaveCount(0)
    await expect(page.locator('.city-detail-count strong')).toHaveText(['0', '0'])

    await search.fill('Storage')
    await expectCompanies(page, [{ company: 'Juniper Labs', titles: [storage.title] }])
    await search.fill('Ledger')
    await expectCompanies(page, [{ company: 'Meridian Systems', titles: [ledger.title] }])
    await search.fill('engineer')
    await expectCompanies(page, allDiscovered)
    await expect(page.locator('.city-detail-count strong')).toHaveText(['2', '4'])
    await page.getByRole('button', { name: platform.title, exact: true }).click()
    await expect(page.getByRole('dialog')).toContainText('계약직')
    await expect(page.getByRole('dialog')).toContainText('연봉 미공개')
    await expect(page.getByRole('dialog')).toContainText('입력 경력 5년 · 공고에서 확인한 연수 하한 3년')
    await page.getByRole('button', { name: '닫기', exact: true }).click()

    await page.getByRole('button', { name: /^모든 필터/ }).click()
    await page.getByLabel('고용 형태', { exact: true }).selectOption('fulltime')
    await page.getByRole('button', { name: '3개 공고 보기', exact: true }).click()
    await expectCompanies(page, [
      { company: 'Meridian Systems', titles: [payments.title, ledger.title] },
      { company: 'Juniper Labs', titles: [storage.title] },
    ])
    await expect(page.locator('.city-detail-count strong')).toHaveText(['2', '3'])
    await expect(page.getByRole('button', { name: platform.title, exact: true })).toHaveCount(0)
    await page.getByRole('button', { name: storage.title, exact: true }).click()
    await expect(page.getByRole('dialog')).toContainText('요구 경력 12년 · 현재 입력한 경력보다 7년 많아요')
    await page.getByRole('button', { name: '닫기', exact: true }).click()

    await page.getByRole('button', { name: /^모든 필터/ }).click()
    await page.getByRole('button', { name: '조건 초기화', exact: true }).click()
    await page.getByRole('button', { name: '4개 공고 보기', exact: true }).click()
    await expectCompanies(page, allDiscovered)
    await search.fill('private-missing-position')
    await expect(page.locator('.company-card')).toHaveCount(0)
    await page.getByRole('button', { name: '검색어 지우기', exact: true }).click()
    await expectCompanies(page, allDiscovered)
    await page.screenshot({ path: info.outputPath('discovered-company-order.png') })
    await expectLocalSearch(page, traffic, initial.attempts, errors)
  })

  test('locale-equivalent companies and job IDs keep their source order after late discovery and a cold revisit', async ({ page }, info) => {
    const { search, traffic, initial, errors } = await restore(page, tiedCatalog, 'Delta')
    await expectCompanies(page, [{ company: 'Cafe\u0301', titles: [delta.title] }])
    await search.fill('Beacon')
    await expectCompanies(page, [{ company: 'Café', titles: [beacon.title] }])
    await search.fill('engineer')
    await expectCompanies(page, allTied)
    await expect(page.locator('.city-detail-count strong')).toHaveText(['2', '4'])
    await page.getByRole('button', { name: atlas.title, exact: true }).click()
    await expect(page.getByRole('link', { name: '원문에서 지원하기', exact: true })).toHaveAttribute('href', 'https://example.com/jobs/atlas')
    await page.getByRole('button', { name: '닫기', exact: true }).click()
    await page.getByRole('button', { name: delta.title, exact: true }).click()
    await expect(page.getByRole('link', { name: '원문에서 지원하기', exact: true })).toHaveAttribute('href', 'https://example.com/jobs/delta')
    await page.getByRole('button', { name: '닫기', exact: true }).click()

    await search.fill('Atlas')
    await expectCompanies(page, [{ company: 'Café', titles: [atlas.title] }])
    await search.fill('private-missing-position')
    await expect(page.locator('.company-card')).toHaveCount(0)
    await search.fill('engineer')
    await expectCompanies(page, allTied)
    await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('orbit.v1.exploration') || '{}').filters?.query)).toBe('engineer')
    const revisitTraffic = watchApiRequests(page)
    await page.reload()
    const revisit = await expectInitialCatalogRequest(page, revisitTraffic)
    await expect(search).toHaveValue('engineer')
    await expectCompanies(page, allTied)
    await expect(page.locator('.city-detail-count strong')).toHaveText(['2', '4'])
    await page.screenshot({ path: info.outputPath('stable-ties-after-revisit.png') })
    await expectLocalSearch(page, traffic, initial.attempts + revisit.attempts, errors)
  })

  test('widening remote geography discovers a new leader without retaining it when eligibility is restored', async ({ page }, info) => {
    const { search, traffic, initial, errors } = await restore(page, remoteCatalog, 'US Atlas', 'remote')
    await expect(page.locator('.active-filter-summary')).toContainText('0개 공고가 현재 조건에 맞아요')
    await expect(page.locator('.company-card')).toHaveCount(0)
    await page.getByRole('button', { name: /^모든 필터/ }).click()
    await page.getByRole('checkbox', { name: '거주 국가가 포함된 원격근무만' }).uncheck()
    await page.getByRole('button', { name: '1개 공고 보기', exact: true }).click()
    await expectCompanies(page, [{ company: 'Fixture A', titles: [us.title] }])
    await page.getByRole('button', { name: '검색어 지우기', exact: true }).click()
    await expectCompanies(page, allRemote)
    await expect(page.locator('.list-toolbar')).toContainText('2개 회사 · 4개 공고')
    await expect(page.locator('.remote-range-note')).toContainText('거주 국가 밖·지역 미확인 공고도 표시 중')
    await expect(page.locator('.residence-button')).toHaveText('영국 · 프로필 거주 국가')
    await expect(page.getByRole('button', { name: london.title, exact: true })).toHaveCount(0)
    await page.getByRole('button', { name: us.title, exact: true }).click()
    await expect(page.locator('.remote-scope p')).toHaveText('미국')
    await expect(page.getByRole('dialog')).toContainText('현재 선택한 거주 국가는 명시된 원격근무 지역에 포함되지 않아요')
    await page.getByRole('button', { name: '닫기', exact: true }).click()

    await page.getByRole('button', { name: /^모든 필터/ }).click()
    await page.getByRole('checkbox', { name: '거주 국가가 포함된 원격근무만' }).check()
    await page.getByRole('button', { name: '3개 공고 보기', exact: true }).click()
    await expectCompanies(page, eligibleRemote)
    await expect(page.locator('.list-toolbar')).toContainText('2개 회사 · 2개 공고')
    await expect(page.locator('.remote-range-note')).toHaveCount(0)
    await expect(page.locator('.residence-button')).toHaveText('영국 거주 기준')
    await page.locator('.results-tabs').getByRole('button', { name: /도시 탐색/ }).click()
    await page.getByRole('button', { name: '런던, 추천 회사 1곳 보기', exact: true }).click()
    await expectCompanies(page, [{ company: 'Fixture A', titles: [london.title] }])
    await page.locator('.results-tabs').getByRole('button', { name: /원격 기회/ }).click()
    await expectCompanies(page, eligibleRemote)

    await page.getByRole('button', { name: /^모든 필터/ }).click()
    await page.getByRole('checkbox', { name: '거주 국가가 포함된 원격근무만' }).uncheck()
    await page.getByRole('button', { name: '5개 공고 보기', exact: true }).click()
    await expectCompanies(page, allRemote)
    await search.fill('private-missing-position')
    await expect(page.locator('.company-card')).toHaveCount(0)
    await page.getByRole('button', { name: '검색어 지우기', exact: true }).click()
    await expectCompanies(page, allRemote)
    await page.screenshot({ path: info.outputPath('remote-order-after-eligibility-changes.png') })
    await expectLocalSearch(page, traffic, initial.attempts, errors)
  })
})
