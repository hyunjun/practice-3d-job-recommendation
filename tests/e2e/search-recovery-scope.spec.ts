import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { DEFAULT_FILTERS } from '../../shared/types'
import type { Catalog, Filters } from '../../shared/types'
import { SEARCH_COMPANIES, SEARCH_PROFILE, SEARCH_TIME, searchCatalog, searchJob } from '../fixtures/search-catalog'
import { expectInitialCatalogRequest, watchApiRequests } from './helpers/api-requests'

const filters: Filters = { ...DEFAULT_FILTERS, role: 'backend' }
const londonPlatform = searchJob('scope-london-platform', { title: 'Backend Engineer Platform' })
const londonStorage = searchJob('scope-london-storage', { title: 'Backend Engineer Storage' })
const berlinAtlas = searchJob('scope-berlin-atlas', {
  title: 'Backend Engineer Atlas Berlin', companyId: SEARCH_COMPANIES[1].id, cityIds: ['berlin'], locationLabel: 'Berlin',
})
const remoteAtlas = searchJob('scope-remote-atlas', {
  title: 'Backend Engineer Atlas Remote', companyId: SEARCH_COMPANIES[1].id,
  cityIds: [], workMode: 'remote', locationLabel: 'Remote, UK', remoteCountries: ['GB'],
})
const otherAtlas = searchJob('scope-other-atlas', {
  title: 'Backend Engineer Atlas Integrations', cityIds: [], locationLabel: 'Ottawa, Canada',
})
const catalog = searchCatalog([londonPlatform, londonStorage, berlinAtlas, remoteAtlas, otherAtlas])
const mappedCatalog = searchCatalog([
  londonPlatform, londonStorage, berlinAtlas, remoteAtlas,
  { ...otherAtlas, cityIds: ['london'], locationLabel: 'London' },
])

async function restore(page: Page, getCatalog: () => Catalog, panelTab: 'cities' | 'remote' | 'unmapped', selectedId: string | null = null) {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  const traffic = watchApiRequests(page)
  await page.clock.setFixedTime(new Date(SEARCH_TIME))
  await page.route('**/api/catalog?source=public*', route => route.fulfill({ json: getCatalog() }))
  await page.addInitScript(({ profile, exploration }) => {
    localStorage.setItem('orbit.v1.profile', JSON.stringify(profile))
    localStorage.setItem('orbit.v1.exploration', JSON.stringify(exploration))
  }, {
    profile: SEARCH_PROFILE,
    exploration: { source: 'public', mapMode: 'flat', panelTab, selectedId, filters },
  })
  await page.goto('/')
  const initial = await expectInitialCatalogRequest(page, traffic)
  return { search: page.getByLabel('도시, 회사 또는 포지션 검색'), traffic, initial, errors }
}

const stored = (page: Page) => page.evaluate(() => JSON.parse(localStorage.getItem('orbit.v1.exploration') || '{}'))
const storedProfile = (page: Page) => page.evaluate(() => JSON.parse(localStorage.getItem('orbit.v1.profile') || '{}'))

async function expectLocalRequests(page: Page, traffic: ReturnType<typeof watchApiRequests>, initialAttempts: number, errors: string[], refreshes = 0) {
  expect(traffic.requests).toHaveLength(initialAttempts + refreshes)
  const refreshed = traffic.requests.filter(request => new URL(request.url).searchParams.has('refresh'))
  expect(refreshed).toHaveLength(refreshes)
  await expect.poll(() => refreshed.map(request => request.state)).toEqual(Array.from({ length: refreshes }, () => 'finished'))
  for (const request of traffic.requests) {
    const url = new URL(request.url)
    expect(url.origin).toBe(new URL(page.url()).origin)
    expect(url.pathname).toBe('/api/catalog')
    expect([...url.searchParams]).toEqual(url.searchParams.has('refresh') ? [['source', 'public'], ['refresh', '1']] : [['source', 'public']])
    expect(request.method).toBe('GET')
    expect(request.body).toBeNull()
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  expect(errors).toEqual([])
}

async function refreshCatalog(page: Page) {
  await page.getByRole('button', { name: '공개 채용', exact: true }).click()
  await page.getByRole('button', { name: '새로고침', exact: true }).click()
  await page.getByRole('button', { name: '닫기', exact: true }).click()
}

for (const width of [1440, 320]) test.describe(`recovery follows the visible scope at ${width}px`, () => {
  test.use({ viewport: { width, height: 960 } })

  test('selected-city and all-city recovery use their own counts while other scopes still have results', async ({ page }) => {
    const { search, traffic, initial, errors } = await restore(page, () => catalog, 'cities', 'london')
    await expect(page.locator('.city-detail-count strong')).toHaveText(['1', '2'])
    await expect(page.locator('.search-recovery')).toHaveCount(0)

    await search.fill('Atlas')
    await expect(page.locator('.active-filter-summary')).toContainText('3개 공고가 현재 조건에 맞아요')
    await expect(page.locator('.city-detail-count strong')).toHaveText(['0', '0'])
    await expect(page.locator('.company-card')).toHaveCount(0)
    await expect(page.locator('.search-recovery h3')).toHaveText('이 도시에서 맞는 공고를 찾지 못했어요')
    await expect(page.locator('.recovery-option dt')).toHaveText(['검색어'])
    await expect(page.locator('.recovery-option button')).toHaveText('회사 1곳 · 공고 2개 보기')
    await expect(page.locator('.recovery-alternatives button strong')).toHaveText(['다른 도시 보기', '원격 기회 보기', '기타 근무지 보기'])
    await expect(page.locator('.recovery-alternatives button small')).toHaveText([
      '회사 1곳 · 공고 1개 · 1개 도시', '회사 1곳 · 공고 1개', '회사 1곳 · 공고 1개',
    ])

    await page.locator('.recovery-option button').click()
    await expect(search).toHaveValue('')
    await expect(page.locator('.city-detail-count strong')).toHaveText(['1', '2'])
    await expect(page.locator('.search-recovery')).toHaveCount(0)
    await expect.poll(async () => (await stored(page)).selectedId).toBe('london')
    await page.getByRole('button', { name: '실행 취소', exact: true }).click()
    await expect(search).toHaveValue('Atlas')
    await expect(page.locator('.city-detail-count strong')).toHaveText(['0', '0'])
    await expect(page.locator('.recovery-option button')).toHaveText('회사 1곳 · 공고 2개 보기')

    await page.locator('.recovery-alternatives').getByRole('button', { name: /^다른 도시 보기/ }).click()
    await expect(page.locator('.city-row h3')).toHaveText(['베를린'])
    await expect(page.locator('.search-recovery')).toHaveCount(0)
    await expect.poll(async () => (await stored(page)).selectedId).toBeNull()
    await expect(search).toHaveValue('Atlas')

    // The overview is now empty, but the remote result still makes the global count positive.
    await search.fill('Remote')
    await expect(page.locator('.active-filter-summary')).toContainText('1개 공고가 현재 조건에 맞아요')
    await expect(page.locator('.city-row')).toHaveCount(0)
    await expect(page.locator('.search-recovery h3')).toHaveText('조건에 맞는 도시가 아직 없어요')
    await expect(page.locator('.recovery-option dt')).toHaveText(['검색어'])
    await expect(page.locator('.recovery-option button')).toHaveText('회사 2곳 · 공고 3개 보기')
    await expect(page.locator('.recovery-alternatives button strong')).toHaveText(['원격 기회 보기'])
    await expect.poll(async () => (await stored(page)).filters).toEqual({ ...filters, query: 'Remote' })
    expect(await storedProfile(page)).toEqual(SEARCH_PROFILE)
    await expectLocalRequests(page, traffic, initial.attempts, errors)
  })

  test('a residence edit restores remote recovery even though mapped and unmapped jobs remain', async ({ page }) => {
    const { traffic, initial, errors } = await restore(page, () => catalog, 'remote')
    await expect(page.locator('.mini-job-title')).toHaveText([remoteAtlas.title])
    await expect(page.locator('.residence-button')).toHaveText('영국 거주 기준')
    await expect(page.locator('.search-recovery')).toHaveCount(0)

    await page.getByRole('button', { name: '내 프로필 편집', exact: true }).click()
    await page.getByLabel('원격근무 시 거주 국가·지역', { exact: true }).selectOption('US')
    await page.getByRole('button', { name: '내 기회 지도 만들기', exact: true }).click()
    await expect(page.locator('.city-row')).toHaveCount(2)
    await expect(page.locator('.active-filter-summary')).toContainText('4개 공고가 현재 조건에 맞아요')
    await expect(page.locator('.search-recovery')).toHaveCount(0)
    await page.locator('.results-tabs').getByRole('button', { name: /원격 기회/ }).click()
    await expect(page.locator('.company-card')).toHaveCount(0)
    await expect(page.locator('.residence-button')).toHaveText('미국 거주 기준')
    await expect(page.locator('.search-recovery h3')).toHaveText('지금 조건에 맞는 원격 기회가 없어요')
    await expect(page.locator('.recovery-option dt')).toHaveText(['원격근무 지역'])
    await expect(page.locator('.recovery-option dd strong')).toHaveText('범위 밖·미확인도 포함')
    await expect(page.locator('.recovery-option button')).toHaveText('회사 1곳 · 공고 1개 보기')
    await expect(page.locator('.recovery-warning')).toContainText('선택한 거주 국가에서 근무할 수 있다는 뜻은 아닙니다.')
    await expect(page.locator('.recovery-alternatives button strong')).toHaveText(['도시 탐색으로 이동', '기타 근무지 보기'])
    await expect(page.locator('.recovery-alternatives button small')).toHaveText(['회사 2곳 · 공고 3개 · 2개 도시', '회사 1곳 · 공고 1개'])
    const editedProfile = await storedProfile(page)
    expect(editedProfile).toMatchObject({ residence: 'US', skills: ['TypeScript'], years: 5, desiredRole: 'backend' })

    await page.locator('.recovery-option button').click()
    await expect(page.locator('.mini-job-title')).toHaveText([remoteAtlas.title])
    await expect(page.locator('.search-recovery')).toHaveCount(0)
    await expect(page.locator('.remote-range-note')).toContainText('거주 국가 밖·지역 미확인 공고도 표시 중')
    await expect(page.locator('.residence-button')).toHaveText('미국 · 프로필 거주 국가')
    await expect.poll(async () => (await stored(page)).filters).toEqual({ ...filters, remoteEligibleOnly: false })
    await page.getByRole('button', { name: '실행 취소', exact: true }).click()
    await expect(page.locator('.company-card')).toHaveCount(0)
    await expect(page.locator('.recovery-option dt')).toHaveText(['원격근무 지역'])
    await expect(page.locator('.recovery-option button')).toHaveText('회사 1곳 · 공고 1개 보기')
    await expect.poll(async () => (await stored(page)).filters).toEqual(filters)
    expect(await storedProfile(page)).toEqual(editedProfile)
    await expectLocalRequests(page, traffic, initial.attempts, errors)
  })

  test('same-ID location refreshes restore and remove unmapped guidance without hiding other available scopes', async ({ page }) => {
    let current = catalog
    const { traffic, initial, errors } = await restore(page, () => current, 'unmapped')
    await expect(page.locator('.mini-job-title')).toHaveText([otherAtlas.title])
    await expect(page.locator('.mini-job-location')).toHaveText('Ottawa, Canada')
    await expect(page.locator('.search-recovery')).toHaveCount(0)

    current = mappedCatalog
    await refreshCatalog(page)
    await expect(page.locator('.active-filter-summary')).toContainText('5개 공고가 현재 조건에 맞아요')
    await expect(page.locator('.list-toolbar')).toContainText('0개 회사 · 0개 공고')
    await expect(page.locator('.company-card')).toHaveCount(0)
    await expect(page.locator('.search-recovery h3')).toHaveText('다른 근무지에서도 맞는 공고를 찾지 못했어요')
    await expect(page.locator('.search-recovery')).toContainText('현재 불러온 자료에는 이 탐색 범위의 공고가 없어요')
    await expect(page.locator('.recovery-option')).toHaveCount(0)
    await expect(page.locator('.recovery-alternatives button strong')).toHaveText(['도시 탐색으로 이동', '원격 기회 보기'])
    await expect(page.locator('.recovery-alternatives button small')).toHaveText(['회사 2곳 · 공고 4개 · 2개 도시', '회사 1곳 · 공고 1개'])
    await expect.poll(async () => (await stored(page)).panelTab).toBe('unmapped')

    current = catalog
    await refreshCatalog(page)
    await expect(page.locator('.mini-job-title')).toHaveText([otherAtlas.title])
    await expect(page.locator('.mini-job-location')).toHaveText('Ottawa, Canada')
    await expect(page.locator('.list-toolbar')).toContainText('1개 회사 · 1개 공고')
    await expect(page.locator('.search-recovery')).toHaveCount(0)
    await expect.poll(async () => (await stored(page)).filters).toEqual(filters)
    expect(await storedProfile(page)).toEqual(SEARCH_PROFILE)
    await expectLocalRequests(page, traffic, initial.attempts, errors, 2)
  })
})
