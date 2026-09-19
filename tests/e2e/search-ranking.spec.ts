import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { DEFAULT_FILTERS } from '../../shared/types'
import { searchCatalog, searchJob, SEARCH_COMPANIES, SEARCH_PROFILE, SEARCH_TIME } from '../fixtures/search-catalog'
import { expectInitialCatalogRequest, watchApiRequests } from './helpers/api-requests'
import { readSavedJson, waitForSavedCommit } from './helpers/saved-store'

const senior = searchJob('senior', {
  title: 'Senior Backend Engineer', minExperience: 7,
  salary: { min: 180000, max: 220000, currency: 'USD' },
})
const mid = searchJob('mid', {
  companyId: SEARCH_COMPANIES[1].id, title: 'Mid Backend Engineer',
  salary: { min: 100000, max: 150000, currency: 'USD' },
})
const catalog = searchCatalog([senior, mid])
const revisedSenior = searchJob('senior', { title: 'Updated Senior Backend Engineer', minExperience: 12, salary: null })
const refreshed = {
  ...searchCatalog([revisedSenior, mid]),
  companies: SEARCH_COMPANIES.map(company => company.id === senior.companyId ? { ...company, name: 'Fixture A revised' } : company),
}
const close = (page: Page) => page.getByRole('button', { name: '닫기', exact: true }).click()

for (const width of [1440, 320]) test.describe(`search ranking at ${width}px`, () => {
  test.use({ viewport: { width, height: 960 } })

  test('reused results follow filter drafts, profile edits and refreshed job content while keeping saved records', async ({ page }, info) => {
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    const traffic = watchApiRequests(page)
    let useRefreshed = false
    await page.clock.setFixedTime(new Date(SEARCH_TIME))
    await page.route('**/api/catalog?source=public*', route => route.fulfill({ json: useRefreshed ? refreshed : catalog }))
    await page.addInitScript(({ profile, filters }) => {
      localStorage.setItem('orbit.v1.profile', JSON.stringify(profile))
      localStorage.setItem('orbit.v1.exploration', JSON.stringify({
        source: 'public', mapMode: 'flat', selectedId: 'london', panelTab: 'cities', filters,
      }))
    }, { profile: SEARCH_PROFILE, filters: { ...DEFAULT_FILTERS, query: 'engineer' } })
    await page.goto('/')
    await expect(page.locator('.mini-job-title')).toHaveText([mid.title, senior.title])
    const initial = await expectInitialCatalogRequest(page, traffic)
    const search = page.getByLabel('도시, 회사 또는 포지션 검색')
    await search.fill('senior')
    await expect(page.locator('.mini-job-title')).toHaveText([senior.title])
    await search.fill('engineer')
    await expect(page.locator('.mini-job-title')).toHaveText([mid.title, senior.title])

    await page.getByRole('button', { name: senior.title, exact: true }).click()
    await expect(page.getByRole('dialog')).toContainText('요구 경력 7년 · 현재 입력한 경력보다 2년 많아요')
    await page.getByRole('button', { name: '기회 저장', exact: true }).click()
    await page.getByLabel('이 기회에 대한 나의 메모').fill('PRIVATE_SEARCH_RANKING_NOTE')
    await page.getByRole('button', { name: '지원 완료로 표시', exact: true }).click()
    await waitForSavedCommit(page)
    const saved = await readSavedJson(page)
    await close(page)

    await page.getByRole('button', { name: /^모든 필터/ }).click()
    const salary = page.getByLabel('희망 연봉')
    await salary.press('End')
    await expect(page.getByRole('button', { name: '0개 공고 보기', exact: true })).toBeVisible()
    for (let step = 0; step < 6; step++) await salary.press('ArrowLeft')
    await expect(salary).toHaveValue('190000')
    await expect(page.getByRole('button', { name: '1개 공고 보기', exact: true })).toBeVisible()
    await close(page)
    await expect(page.locator('.mini-job-title')).toHaveText([mid.title, senior.title])
    await page.getByRole('button', { name: /^모든 필터/ }).click()
    await expect(salary).toHaveValue('0')
    await salary.press('End')
    for (let step = 0; step < 6; step++) await salary.press('ArrowLeft')
    expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze()).violations).toEqual([])
    await page.screenshot({ path: info.outputPath('filter-preview.png') })
    await page.getByRole('button', { name: '1개 공고 보기', exact: true }).click()
    await expect(page.locator('.mini-job-title')).toHaveText([senior.title])
    await expect(search).toHaveValue('engineer')
    await page.getByRole('button', { name: /^모든 필터/ }).click()
    await page.getByRole('button', { name: '조건 초기화', exact: true }).click()
    await page.getByRole('button', { name: '2개 공고 보기', exact: true }).click()
    await expect(page.locator('.mini-job-title')).toHaveText([mid.title, senior.title])
    await expect(search).toHaveValue('engineer')

    await page.getByRole('button', { name: '내 프로필 편집', exact: true }).click()
    await page.getByLabel('개발 경력', { exact: true }).fill('9')
    await page.getByRole('button', { name: '내 기회 지도 만들기', exact: true }).click()
    await page.getByRole('button', { name: '런던, 추천 회사 2곳 보기', exact: true }).click()
    await expect(page.locator('.mini-job-title')).toHaveText([senior.title, mid.title])
    await page.getByRole('button', { name: senior.title, exact: true }).click()
    await expect(page.getByRole('dialog')).toContainText('입력 경력 9년 · 공고에서 확인한 연수 하한 7년')
    await expect(page.getByRole('dialog')).not.toContainText('현재 입력한 경력보다')
    await close(page)
    expect(traffic.requests).toHaveLength(initial.attempts)

    useRefreshed = true
    await page.getByRole('button', { name: '공개 채용', exact: true }).click()
    await page.getByRole('button', { name: '새로고침', exact: true }).click()
    await expect(page.locator('.mini-job-title')).toHaveText([mid.title, revisedSenior.title])
    await close(page)
    await expect(page.locator('.company-card h3')).toHaveText(['Fixture B', 'Fixture A revised'])
    await page.getByRole('button', { name: revisedSenior.title, exact: true }).click()
    await expect(page.getByRole('dialog')).toContainText('요구 경력 12년 · 현재 입력한 경력보다 3년 많아요')
    await expect(page.getByLabel('이 기회에 대한 나의 메모')).toHaveValue('PRIVATE_SEARCH_RANKING_NOTE')
    await expect(page.getByRole('button', { name: '지원 완료로 표시됨', exact: true })).toBeVisible()
    await page.screenshot({ path: info.outputPath('updated-recommendation.png') })
    await close(page)
    await page.getByRole('button', { name: /^모든 필터/ }).click()
    await page.getByRole('checkbox', { name: '연봉 미공개·별도 보상 공고도 포함' }).uncheck()
    await page.getByRole('button', { name: '1개 공고 보기', exact: true }).click()
    await expect(page.locator('.mini-job-title')).toHaveText([mid.title])
    expect(await readSavedJson(page)).toBe(saved)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    expect(traffic.requests).toHaveLength(initial.attempts + 1)
    for (const request of traffic.requests) {
      const url = new URL(request.url)
      expect(url.origin).toBe(new URL(page.url()).origin)
      expect(url.pathname).toBe('/api/catalog')
      expect([...url.searchParams]).toEqual(request.url.includes('refresh=') ? [['source', 'public'], ['refresh', '1']] : [['source', 'public']])
      expect(request.method).toBe('GET')
      expect(request.body).toBeNull()
    }
    expect(errors).toEqual([])
  })
})
