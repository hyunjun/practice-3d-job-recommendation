import { expect, test } from '@playwright/test'
import type { Locator, Page } from '@playwright/test'
import { DEFAULT_FILTERS } from '../../shared/types'
import type { Filters, SavedJob } from '../../shared/types'
import { SEARCH_COMPANIES, SEARCH_PROFILE, SEARCH_TIME, searchCatalog, searchJob } from '../fixtures/search-catalog'
import { expectInitialCatalogRequest, watchApiRequests } from './helpers/api-requests'
import { readSavedJson } from './helpers/saved-store'

const london = searchJob('edit-london', {
  title: 'Atlas London Backend Engineer', minExperience: 7,
  salary: { min: 100000, max: 180000, currency: 'USD' },
})
const berlinRust = searchJob('edit-berlin-rust', {
  title: 'Atlas Berlin Frontend Engineer', companyId: SEARCH_COMPANIES[1].id, role: 'frontend',
  cityIds: ['berlin'], locationLabel: 'Berlin', workMode: 'hybrid', skills: ['Rust'], minExperience: 7,
  salary: { min: 160000, max: 200000, currency: 'USD' },
})
const berlinJunior = searchJob('edit-berlin-junior', {
  title: 'Atlas Junior Frontend Engineer', role: 'frontend', cityIds: ['berlin'], locationLabel: 'Berlin',
  minExperience: 2, salary: { min: 100000, max: 140000, currency: 'USD' },
})
const remote = searchJob('edit-remote', {
  title: 'Atlas Remote Backend Engineer', companyId: SEARCH_COMPANIES[1].id,
  cityIds: [], locationLabel: 'Remote, UK', workMode: 'remote', remoteCountries: ['GB'],
  salary: { min: 160000, max: 200000, currency: 'USD' },
})
const ottawa = searchJob('edit-ottawa', {
  title: 'Atlas Ottawa Backend Engineer', cityIds: [], locationLabel: 'Ottawa, Canada',
  salary: { min: 100000, max: 150000, currency: 'USD' },
})
const generic = searchJob('edit-generic', {
  title: 'Atlas Remote Software Engineer', role: 'unknown',
  cityIds: [], locationLabel: 'Remote, UK', workMode: 'remote', remoteCountries: ['GB'],
  salary: { min: 180000, max: 220000, currency: 'USD' },
})
const catalog = searchCatalog([london, berlinRust, berlinJunior, remote, ottawa, generic])
const cityFilters: Filters = {
  ...DEFAULT_FILTERS, query: 'Atlas', region: 'europe', role: 'all', visa: 'supported',
  employment: 'fulltime', salaryMin: 150000, includeUnknownSalary: false,
}
const savedRecords: SavedJob[] = [
  { job: london, company: SEARCH_COMPANIES[0], savedAt: SEARCH_TIME, status: 'applied', note: 'PRIVATE_EDIT_40_NOTE' },
  { job: berlinJunior, company: SEARCH_COMPANIES[0], savedAt: SEARCH_TIME, status: 'saved', note: 'Review later' },
]
const stored = (page: Page) => page.evaluate(() => JSON.parse(localStorage.getItem('orbit.v1.exploration') || '{}'))
const storedProfile = (page: Page) => page.evaluate(() => JSON.parse(localStorage.getItem('orbit.v1.profile') || '{}'))
const profileButton = (page: Page) => page.getByRole('button', { name: '내 프로필 편집', exact: true })
const nav = (page: Page) => page.getByRole('navigation', { name: '주요 메뉴' })
const resultsTab = (page: Page, name: string) => page.locator('.results-tabs').getByRole('button', { name: new RegExp(`^${name}`) })
const close = (page: Page) => page.getByRole('button', { name: '닫기', exact: true }).click()

async function restore(page: Page, options: {
  filters: Filters
  tab?: 'cities' | 'remote' | 'unmapped'
  view?: 'explore' | 'saved' | 'compare'
  sampleProfile?: boolean
  saved?: SavedJob[]
}) {
  const errors: string[] = []
  const unexpectedApi: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  const traffic = watchApiRequests(page)
  await page.clock.setFixedTime(new Date(SEARCH_TIME))
  await page.route('**/api/**', route => {
    const request = route.request()
    const url = new URL(request.url())
    if (request.method() === 'GET' && url.pathname === '/api/catalog' && url.search === '?source=public') {
      return route.fulfill({ json: catalog })
    }
    unexpectedApi.push(`${request.method()} ${url.pathname}${url.search}`)
    return route.abort('blockedbyclient')
  })
  await page.addInitScript(({ profile, exploration, saved }) => {
    if (sessionStorage.getItem('profile-edit-context-seeded')) return
    if (profile) localStorage.setItem('orbit.v1.profile', JSON.stringify(profile))
    localStorage.setItem('orbit.v1.exploration', JSON.stringify(exploration))
    localStorage.setItem('orbit.v1.compare', JSON.stringify(['london', 'berlin']))
    if (saved.length) localStorage.setItem('orbit.v1.saved', JSON.stringify(saved))
    sessionStorage.setItem('profile-edit-context-seeded', 'true')
  }, {
    profile: options.sampleProfile ? null : SEARCH_PROFILE,
    exploration: {
      source: 'public', filters: options.filters, selectedId: 'london', panelTab: options.tab ?? 'cities',
      mapMode: 'flat', light: true, citySort: 'salary',
    },
    saved: options.saved ?? [],
  })
  await page.goto(options.view && options.view !== 'explore' ? `/#${options.view}` : '/')
  const initial = await expectInitialCatalogRequest(page, traffic)
  return async () => {
    expect(traffic.requests).toHaveLength(initial.attempts)
    for (const request of traffic.requests) {
      expect(request.url).toBe(new URL('/api/catalog?source=public', page.url()).href)
      expect(request.method).toBe('GET')
      expect(request.body).toBeNull()
    }
    expect(unexpectedApi).toEqual([])
    expect(errors).toEqual([])
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  }
}

async function applyEdit(page: Page, invokingControl: Locator = profileButton(page)) {
  await expect(page.getByRole('button', { name: '내 기회 지도 만들기', exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: '변경 사항 적용', exact: true }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(invokingControl).toBeFocused()
}

async function replaceTypeScriptWithRust(page: Page) {
  await page.getByRole('button', { name: 'TypeScript 삭제', exact: true }).click()
  await page.getByLabel(/^보유 기술/).fill('Rust')
  await page.getByRole('button', { name: '기술 추가', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Rust 삭제', exact: true })).toBeVisible()
}

async function setSalary(page: Page, value: 150000 | 180000) {
  const salary = page.getByLabel('희망 연봉')
  await salary.press('End')
  for (let step = 0; step < (250000 - value) / 10000; step++) await salary.press('ArrowLeft')
  await expect(salary).toHaveValue(String(value))
}

async function expectCityContext(page: Page, filters: Filters) {
  await expect(nav(page).getByRole('button', { name: '기회 탐색', exact: true })).toHaveAttribute('aria-current', 'page')
  await expect(page.getByRole('button', { name: '2D 지도', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('.region-tabs').getByRole('button', { name: '유럽', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByLabel('도시, 회사 또는 포지션 검색')).toHaveValue('Atlas')
  await expect(page.getByLabel('직무 필터', { exact: true })).toHaveValue(filters.role)
  await expect(page.getByLabel('근무 형태 필터', { exact: true })).toHaveValue(filters.workMode)
  await expect(page.getByLabel('비자 지원 필터', { exact: true })).toHaveValue(filters.visa)
  await expect(page.locator('.city-hero-caption h2')).toContainText('런던')
  await expect(resultsTab(page, '도시 탐색')).toHaveAttribute('aria-pressed', 'true')
  await expect.poll(() => stored(page)).toMatchObject({
    filters, selectedId: 'london', panelTab: 'cities', mapMode: 'flat', light: true, citySort: 'salary',
  })
}

for (const width of [1440, 320]) test.describe(`personal profile edit context at ${width}px`, () => {
  test.use({ viewport: { width, height: 960 } })

  test('cancel keeps the profile, while a skill edit can empty the selected city without resetting the all-role filter or map context', async ({ page }, info) => {
    const verify = await restore(page, { filters: cityFilters })
    await expect(page.locator('.mini-job-title')).toHaveText(['Atlas London Backend Engineer'])
    await expect(page.locator('.city-detail-count strong')).toHaveText(['1', '1'])
    const originalProfile = await storedProfile(page)

    await profileButton(page).click()
    await page.getByLabel('이름 또는 별명', { exact: true }).fill('Discarded name')
    await page.getByLabel('개발 경력', { exact: true }).fill('9')
    await replaceTypeScriptWithRust(page)
    await page.getByLabel('희망 직무', { exact: true }).selectOption('frontend')
    await page.getByLabel('선호 근무 형태', { exact: true }).selectOption('remote')
    await page.getByRole('checkbox', { name: /이 브라우저에 프로필 기억하기/ }).uncheck()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(profileButton(page)).toBeFocused()
    await expect(page.locator('.mini-job-title')).toHaveText(['Atlas London Backend Engineer'])
    expect(await storedProfile(page)).toEqual(originalProfile)
    await expectCityContext(page, cityFilters)

    const mapProfile = page.locator('.profile-cta')
    await mapProfile.click()
    await expect(page.getByLabel('이름 또는 별명', { exact: true })).toHaveValue('Search fixture')
    await expect(page.getByLabel('개발 경력', { exact: true })).toHaveValue('5')
    await expect(page.getByLabel('희망 직무', { exact: true })).toHaveValue('backend')
    await expect(page.getByLabel('선호 근무 형태', { exact: true })).toHaveValue('all')
    await expect(page.getByRole('checkbox', { name: /이 브라우저에 프로필 기억하기/ })).toBeChecked()
    await page.getByLabel('이름 또는 별명', { exact: true }).fill('Atlas explorer')
    await page.getByLabel('개발 경력', { exact: true }).fill('9')
    await replaceTypeScriptWithRust(page)
    expect(await page.getByRole('dialog').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
    if (width === 320) {
      await page.getByRole('button', { name: '변경 사항 적용', exact: true }).scrollIntoViewIfNeeded()
      await page.screenshot({ path: info.outputPath('profile-edit-dialog-320.png') })
    }
    await applyEdit(page, mapProfile)
    await expect(mapProfile).toHaveText('Atlas explorer · 프로필 수정')
    await expect(page.locator('.toast')).toContainText('Atlas explorer님의 프로필을 업데이트했어요.')
    await expectCityContext(page, cityFilters)
    await expect(page.locator('.city-detail-count strong')).toHaveText(['0', '0'])
    await expect(page.locator('.company-card')).toHaveCount(0)
    await expect(page.locator('.active-filter-summary')).toContainText('1개 공고가 현재 조건에 맞아요')
    await expect(page.locator('.search-recovery h3')).toHaveText('이 도시에서 맞는 공고를 찾지 못했어요')
    await expect(page.locator('.recovery-option')).toHaveCount(0)
    await expect(page.locator('.recovery-alternatives button strong')).toHaveText(['다른 도시 보기'])
    await expect(page.locator('.recovery-alternatives button small')).toHaveText(['회사 1곳 · 공고 1개 · 1개 도시'])
    expect(await storedProfile(page)).toMatchObject({ name: 'Atlas explorer', years: 9, skills: ['Rust'], desiredRole: 'backend', residence: 'GB' })
    expect(await page.locator('.results-panel').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
    if (width === 320) {
      await page.locator('.city-detail-summary').scrollIntoViewIfNeeded()
      await page.screenshot({ path: info.outputPath('profile-edit-selected-scope-320.png') })
    }

    // A changed desired role deliberately replaces the otherwise independent all-role filter.
    await profileButton(page).click()
    await page.getByLabel('희망 직무', { exact: true }).selectOption('frontend')
    await applyEdit(page)
    await expectCityContext(page, { ...cityFilters, role: 'frontend' })
    await expect(page.locator('.city-detail-count strong')).toHaveText(['0', '0'])
    await expect(page.locator('.search-recovery h3')).toHaveText('이 도시에서 맞는 공고를 찾지 못했어요')
    await page.getByRole('button', { name: /^모든 필터/ }).click()
    await expect(page.getByLabel('고용 형태', { exact: true })).toHaveValue('fulltime')
    await expect(page.getByLabel('희망 연봉')).toHaveValue('150000')
    await expect(page.getByRole('checkbox', { name: '연봉 미공개·별도 보상 공고도 포함' })).not.toBeChecked()
    await expect(page.getByRole('checkbox', { name: '거주 국가가 포함된 원격근무만' })).toBeChecked()
    await close(page)
    await page.getByRole('button', { name: '모든 도시', exact: true }).click()
    await expect(page.getByRole('combobox', { name: '도시 정렬', exact: true })).toHaveValue('salary')
    await expect(page.locator('.city-row h3')).toHaveText(['베를린'])
    await verify()
  })

  test('unmapped and empty city scopes survive unchanged work preferences; explicit remote, all and onsite changes use the filter navigation rules', async ({ page }) => {
    const filters: Filters = {
      ...DEFAULT_FILTERS, query: 'Atlas', role: 'backend', employment: 'fulltime', includeUnknownSalary: false,
    }
    const verify = await restore(page, { filters, tab: 'unmapped' })
    await expect(page.locator('.mini-job-title')).toHaveText(['Atlas Ottawa Backend Engineer'])
    await profileButton(page).click()
    await page.getByLabel('이름 또는 별명', { exact: true }).fill('Unmapped explorer')
    await applyEdit(page)
    await expect(resultsTab(page, '기타 근무지')).toHaveAttribute('aria-pressed', 'true')
    await expect(page.locator('.mini-job-title')).toHaveText(['Atlas Ottawa Backend Engineer'])
    await expect(page.locator('.list-toolbar')).toContainText('1개 회사 · 1개 공고')

    await profileButton(page).click()
    await page.getByLabel('선호 근무 형태', { exact: true }).selectOption('remote')
    await applyEdit(page)
    await expect(resultsTab(page, '원격 기회')).toHaveAttribute('aria-pressed', 'true')
    await expect(page.locator('.mini-job-title')).toHaveText(['Atlas Remote Backend Engineer'])
    await expect(page.getByLabel('근무 형태 필터', { exact: true })).toHaveValue('remote')
    await expect.poll(async () => (await stored(page)).selectedId).toBe('london')

    await profileButton(page).click()
    await page.getByLabel('선호 근무 형태', { exact: true }).selectOption('all')
    await applyEdit(page)
    await expect(resultsTab(page, '원격 기회')).toHaveAttribute('aria-pressed', 'true')
    await expect(page.locator('.mini-job-title')).toHaveText(['Atlas Remote Backend Engineer'])
    await expect(page.getByLabel('근무 형태 필터', { exact: true })).toHaveValue('all')

    // Selecting a tab is independent of the work-mode filter. An unchanged remote
    // preference must not pull a deliberately selected, empty city back to remote.
    await page.getByLabel('근무 형태 필터', { exact: true }).selectOption('remote')
    await resultsTab(page, '도시 탐색').click()
    await expect(page.locator('.city-hero-caption h2')).toContainText('런던')
    await expect(page.locator('.city-detail-count strong')).toHaveText(['0', '0'])
    await profileButton(page).click()
    await page.getByLabel('개발 경력', { exact: true }).fill('9')
    await applyEdit(page)
    await expect(resultsTab(page, '도시 탐색')).toHaveAttribute('aria-pressed', 'true')
    await expect(page.locator('.city-hero-caption h2')).toContainText('런던')
    await expect(page.locator('.city-detail-count strong')).toHaveText(['0', '0'])
    await expect(page.locator('.search-recovery h3')).toHaveText('이 도시에서 맞는 공고를 찾지 못했어요')
    await expect(page.locator('.recovery-option button')).toHaveText('회사 1곳 · 공고 1개 보기')

    await resultsTab(page, '원격 기회').click()
    await profileButton(page).click()
    await page.getByLabel('선호 근무 형태', { exact: true }).selectOption('onsite')
    await page.getByLabel('비자 지원', { exact: true }).selectOption('yes')
    await setSalary(page, 180000)
    await applyEdit(page)
    await expect(resultsTab(page, '도시 탐색')).toHaveAttribute('aria-pressed', 'true')
    await expect(page.locator('.city-hero-caption h2')).toContainText('런던')
    await expect(page.locator('.city-detail-count strong')).toHaveText(['1', '1'])
    await expect(page.locator('.mini-job-title')).toHaveText(['Atlas London Backend Engineer'])
    await expect(page.getByLabel('도시, 회사 또는 포지션 검색')).toHaveValue('Atlas')
    await expect(page.getByLabel('직무 필터', { exact: true })).toHaveValue('backend')
    await expect(page.getByLabel('근무 형태 필터', { exact: true })).toHaveValue('onsite')
    await expect(page.getByLabel('비자 지원 필터', { exact: true })).toHaveValue('yes')
    await expect.poll(() => stored(page)).toMatchObject({
      selectedId: 'london', panelTab: 'cities', mapMode: 'flat', citySort: 'salary',
      filters: { ...filters, workMode: 'onsite', visa: 'yes', salaryMin: 180000 },
    })
    await verify()
  })

  test('editing from a filtered saved collection keeps the page, notes and status, and preserves the unknown-role filter when preferences change', async ({ page }) => {
    const filters: Filters = {
      ...DEFAULT_FILTERS, query: 'Atlas', role: 'unknown', employment: 'fulltime', includeUnknownSalary: false,
    }
    const verify = await restore(page, { filters, tab: 'unmapped', view: 'saved', saved: savedRecords })
    await expect(page.locator('.saved-card')).toHaveCount(2)
    await page.getByLabel('저장한 기회 검색', { exact: true }).fill('PRIVATE_EDIT_40_NOTE')
    await page.locator('.collection-tabs').getByRole('button', { name: /^지원 완료/ }).click()
    await expect(page.locator('.saved-title')).toHaveText(['Atlas London Backend Engineer'])
    const savedBefore = await readSavedJson(page)

    await profileButton(page).click()
    await expect(page.getByLabel('희망 직무', { exact: true })).toHaveValue('backend')
    await page.getByLabel('이름 또는 별명', { exact: true }).fill('Saved explorer')
    await page.getByLabel('개발 경력', { exact: true }).fill('9')
    await page.getByLabel('선호 근무 형태', { exact: true }).selectOption('remote')
    await page.getByLabel('비자 지원', { exact: true }).selectOption('yes')
    await setSalary(page, 180000)
    await applyEdit(page)
    await expect(nav(page).getByRole('button', { name: /^저장한 기회/ })).toHaveAttribute('aria-current', 'page')
    expect(new URL(page.url()).hash).toBe('#saved')
    await expect(page.getByLabel('저장한 기회 검색', { exact: true })).toHaveValue('PRIVATE_EDIT_40_NOTE')
    await expect(page.locator('.collection-tabs').getByRole('button', { name: /^지원 완료/ })).toHaveClass('active')
    await expect(page.locator('.saved-title')).toHaveText(['Atlas London Backend Engineer'])
    await expect(page.locator('.saved-note-preview')).toHaveText(['PRIVATE_EDIT_40_NOTE'])
    await expect(page.locator('.saved-status')).toHaveText(['지원 완료'])
    await page.getByRole('button', { name: 'Atlas London Backend Engineer', exact: true }).click()
    await expect(page.getByRole('dialog')).toContainText('입력 경력 9년 · 공고에서 확인한 연수 하한 7년')
    await expect(page.getByLabel('이 기회에 대한 나의 메모')).toHaveValue('PRIVATE_EDIT_40_NOTE')
    await expect(page.getByRole('button', { name: '지원 완료로 표시됨', exact: true })).toBeVisible()
    await close(page)
    expect(await readSavedJson(page)).toBe(savedBefore)

    await nav(page).getByRole('button', { name: '기회 탐색', exact: true }).click()
    await expect(resultsTab(page, '원격 기회')).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByLabel('직무 필터', { exact: true })).toHaveValue('unknown')
    await expect(page.getByLabel('도시, 회사 또는 포지션 검색')).toHaveValue('Atlas')
    await expect(page.getByLabel('근무 형태 필터', { exact: true })).toHaveValue('remote')
    await expect(page.getByLabel('비자 지원 필터', { exact: true })).toHaveValue('yes')
    await expect(page.locator('.mini-job-title')).toHaveText(['Atlas Remote Software Engineer'])
    await expect(page.locator('.mini-job-role')).toHaveText(['세부 직무 미확인'])
    await expect.poll(() => stored(page)).toMatchObject({
      selectedId: 'london', panelTab: 'remote', mapMode: 'flat', citySort: 'salary',
      filters: { ...filters, workMode: 'remote', visa: 'yes', salaryMin: 180000 },
    })
    expect(await storedProfile(page)).toMatchObject({ name: 'Saved explorer', years: 9, desiredRole: 'backend', skills: ['TypeScript'] })
    await verify()
  })

  test('comparison stays open and refreshes literal company, job and skill cells while an independent frontend filter survives', async ({ page }) => {
    const filters: Filters = { ...cityFilters, role: 'frontend', visa: 'all', salaryMin: 0 }
    const verify = await restore(page, { filters, tab: 'remote', view: 'compare' })
    const metric = (label: string) => page.getByRole('row').filter({ has: page.getByRole('rowheader', { name: new RegExp(`^${label}`) }) }).getByRole('cell')
    await expect(page.locator('.comparison-city h2')).toHaveText(['런던', '베를린'])
    await expect(metric('추천 회사')).toHaveText(['0곳', '2곳', '—'])
    await expect(metric('관련 채용공고')).toHaveText(['0개', '2개', '—'])
    await expect(metric('나와 연결되는 기술').nth(1).locator('.skill-tag')).toHaveText(['TypeScript'])

    await profileButton(page).click()
    await page.getByLabel('이름 또는 별명', { exact: true }).fill('Compare explorer')
    await page.getByLabel('개발 경력', { exact: true }).fill('9')
    await replaceTypeScriptWithRust(page)
    await page.getByLabel('선호 근무 형태', { exact: true }).selectOption('hybrid')
    await page.getByLabel('비자 지원', { exact: true }).selectOption('yes')
    await setSalary(page, 150000)
    await applyEdit(page)
    await expect(nav(page).getByRole('button', { name: /^도시 비교/ })).toHaveAttribute('aria-current', 'page')
    expect(new URL(page.url()).hash).toBe('#compare')
    await expect(page.locator('.comparison-city h2')).toHaveText(['런던', '베를린'])
    await expect(metric('추천 회사')).toHaveText(['0곳', '1곳', '—'])
    await expect(metric('관련 채용공고')).toHaveText(['0개', '1개', '—'])
    await expect(metric('나와 연결되는 기술').nth(1).locator('.skill-tag')).toHaveText(['Rust'])
    await expect(metric('만나볼 회사').nth(1).locator('.compare-companies')).toHaveText('FBFixture B')
    await nav(page).getByRole('button', { name: '기회 탐색', exact: true }).click()
    await expectCityContext(page, { ...filters, workMode: 'hybrid', visa: 'yes', salaryMin: 150000 })
    await expect(page.locator('.city-detail-count strong')).toHaveText(['0', '0'])
    await expect(page.locator('.active-filter-summary')).toContainText('1개 공고가 현재 조건에 맞아요')
    await expect(page.locator('.search-recovery h3')).toHaveText('이 도시에서 맞는 공고를 찾지 못했어요')
    expect(await storedProfile(page)).toMatchObject({ name: 'Compare explorer', years: 9, skills: ['Rust'], desiredRole: 'backend' })
    await verify()
  })

  for (const mode of ['remote', 'onsite'] as const) test(`first personal-profile creation from comparison still opens explore, clears the city and applies ${mode} preferences`, async ({ page }) => {
    const filters: Filters = { ...cityFilters, role: 'frontend', salaryMin: 0 }
    const verify = await restore(page, { filters, tab: 'unmapped', view: 'compare', sampleProfile: true })
    await expect(page.locator('.comparison-city h2')).toHaveText(['런던', '베를린'])
    await profileButton(page).click()
    await page.getByRole('button', { name: '텍스트', exact: true }).click()
    await page.getByLabel('경력 요약', { exact: true }).fill(
      'New Explorer\nBackend Engineer\n5 years of software engineering experience using TypeScript.\nPRIVATE_NEW_PROFILE_40',
    )
    await page.getByRole('button', { name: '경력에서 가능성 찾기', exact: true }).click()
    await page.getByLabel('이름 또는 별명', { exact: true }).fill('New explorer')
    await page.getByLabel('희망 직무', { exact: true }).selectOption('backend')
    await page.getByLabel('선호 근무 형태', { exact: true }).selectOption(mode)
    await page.getByLabel('원격근무 시 거주 국가·지역', { exact: true }).selectOption('GB')
    await expect(page.getByRole('button', { name: '변경 사항 적용', exact: true })).toHaveCount(0)
    await page.getByRole('button', { name: '내 기회 지도 만들기', exact: true }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(profileButton(page)).toBeFocused()
    await expect(nav(page).getByRole('button', { name: '기회 탐색', exact: true })).toHaveAttribute('aria-current', 'page')
    expect(new URL(page.url()).hash).toBe('')
    await expect(page.locator('.sample-profile-card')).toHaveCount(0)
    await expect(page.locator('.profile-cta')).toHaveText('New explorer · 프로필 수정')
    await expect(page.getByLabel('직무 필터', { exact: true })).toHaveValue('backend')
    await expect(page.getByLabel('근무 형태 필터', { exact: true })).toHaveValue(mode)
    await expect(page.getByLabel('도시, 회사 또는 포지션 검색')).toHaveValue('Atlas')
    await expect(page.getByRole('button', { name: '2D 지도', exact: true })).toHaveAttribute('aria-pressed', 'true')
    await expect(page.locator('.region-tabs').getByRole('button', { name: '유럽', exact: true })).toHaveAttribute('aria-pressed', 'true')
    await expect(page.locator('.city-detail-hero')).toHaveCount(0)
    if (mode === 'remote') {
      await expect(resultsTab(page, '원격 기회')).toHaveAttribute('aria-pressed', 'true')
      await expect(page.locator('.mini-job-title')).toHaveText(['Atlas Remote Backend Engineer'])
    } else {
      await expect(resultsTab(page, '도시 탐색')).toHaveAttribute('aria-pressed', 'true')
      await expect(page.locator('.city-row h3')).toHaveText(['런던'])
      await expect(page.getByRole('combobox', { name: '도시 정렬', exact: true })).toHaveValue('salary')
    }
    await expect.poll(() => stored(page)).toMatchObject({
      selectedId: null, panelTab: mode === 'remote' ? 'remote' : 'cities', mapMode: 'flat', citySort: 'salary',
      filters: { ...filters, role: 'backend', workMode: mode },
    })
    expect(await storedProfile(page)).toMatchObject({ kind: 'personal', name: 'New explorer', desiredRole: 'backend', residence: 'GB' })
    expect(await page.evaluate(() => Object.values(localStorage).join(' '))).not.toContain('PRIVATE_NEW_PROFILE_40')
    await verify()
  })
})
