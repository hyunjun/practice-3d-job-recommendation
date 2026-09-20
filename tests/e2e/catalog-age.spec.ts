import { readSavedJson } from './helpers/saved-store'
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { readFile } from 'node:fs/promises'
import { CATALOG_LIFETIME } from '../../shared/catalog-freshness'
import { DEFAULT_FILTERS } from '../../shared/types'
import type { Catalog } from '../../shared/types'
import { searchCatalog, searchJob, SEARCH_COMPANIES, SEARCH_PROFILE, SEARCH_TIME } from '../fixtures/search-catalog'
import { expectInitialCatalogRequest, watchApiRequests } from './helpers/api-requests'

const base = Date.parse(SEARCH_TIME)
const iso = (value: number) => new Date(value).toISOString()
const { freshFor, maxFallbackAge } = CATALOG_LIFETIME

function snapshot(first = base, second = first, empty = false): Catalog {
  const catalog = searchCatalog(empty ? [] : [
    searchJob('first', { fetchedAt: iso(first) }),
    ...(second === first ? [] : [searchJob('second', { companyId: SEARCH_COMPANIES[1].id, fetchedAt: iso(second) })]),
  ])
  return {
    ...catalog, fetchedAt: iso(Math.max(first, second)), checkedAt: iso(Math.max(first, second)),
    boards: catalog.boards.map((board, index) => ({ ...board, lastSuccessAt: iso(index ? second : first), checkedAt: iso(index ? second : first) })),
  }
}

async function restore(page: Page, initial = snapshot(), now = base) {
  let catalog = initial
  const traffic = watchApiRequests(page)
  await page.clock.install({ time: new Date(now) })
  await page.route('**/api/catalog?source=public*', route => route.fulfill({ json: catalog }))
  await page.addInitScript(({ profile, filters }) => {
    localStorage.setItem('orbit.v1.profile', JSON.stringify(profile))
    if (!localStorage.getItem('orbit.v1.exploration')) localStorage.setItem('orbit.v1.exploration', JSON.stringify({
      source: 'public', selectedId: 'london', mapMode: 'flat', filters: { ...filters, query: 'Backend' },
    }))
  }, { profile: SEARCH_PROFILE, filters: DEFAULT_FILTERS })
  await page.goto('/')
  await expect(page.getByRole('button', { name: '공개 채용', exact: true })).toBeVisible()
  const initialRequest = await expectInitialCatalogRequest(page, traffic)
  return { requests: traffic.requests, initialRequests: initialRequest.attempts, replace(value: Catalog) { catalog = value } }
}

test('an open job ages and expires without changing saved notes, application status or search conditions, then refresh recovers', async ({ page }) => {
  const server = await restore(page)
  await expect(page.locator('.company-card')).toHaveCount(1)
  await page.locator('.mini-job-title').first().click()
  await expect(page.locator('.job-freshness-notice')).toHaveCount(0)
  await page.clock.fastForward(freshFor)
  await expect(page.locator('.job-freshness-notice')).toContainText('이전 조회 결과')
  await expect(page.locator('.job-freshness-notice')).not.toContainText('재조회가 실패')
  await page.getByRole('button', { name: '기회 저장', exact: true }).click()
  await page.getByLabel('이 기회에 대한 나의 메모').fill('Keep this private note after expiry')
  await page.getByRole('button', { name: '지원 완료로 표시', exact: true }).click()
  const saved = await readSavedJson(page)
  await page.clock.fastForward(maxFallbackAge - freshFor + 1)
  await expect(page.locator('.job-freshness-notice')).toContainText('추천에서 제외된 조회 기록')
  await expect(page.getByLabel('이 기회에 대한 나의 메모')).toHaveValue('Keep this private note after expiry')
  await expect(page.getByRole('button', { name: '지원 완료로 표시됨', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '닫기', exact: true }).click()
  await expect(page.getByRole('heading', { name: '공고를 다시 확인해 주세요' })).toBeVisible()
  await expect(page.locator('.company-card, .flat-marker')).toHaveCount(0)
  await expect(page.locator('.map-stats strong').first()).toContainText('—')
  await expect(page.getByLabel('도시, 회사 또는 포지션 검색')).toHaveValue('Backend')
  await expect(page.locator('.recovery-option')).toHaveCount(0)
  expect(server.requests).toHaveLength(server.initialRequests)
  await page.getByRole('navigation', { name: '주요 메뉴' }).getByRole('button', { name: /저장한 기회/ }).click()
  await expect(page.locator('.saved-card .stale-job-badge')).toHaveText('확인 기간 지남')
  expect(await readSavedJson(page)).toBe(saved)
  const downloading = page.waitForEvent('download')
  await page.getByRole('button', { name: 'CSV 내보내기', exact: true }).click()
  const csv = await readFile((await (await downloading).path())!, 'utf8')
  for (const value of ['저장 내용의 조회 시각', '내보낼 때의 조회 기록', '내보낸 시각', SEARCH_TIME, '확인 기간 지남', 'Keep this private note after expiry', '지원 완료']) expect(csv).toContain(value)
  await page.getByRole('navigation', { name: '주요 메뉴' }).getByRole('button', { name: '기회 탐색', exact: true }).click()
  server.replace(snapshot(await page.evaluate(() => Date.now())))
  await page.getByRole('button', { name: '다시 조회', exact: true }).click()
  await expect(page.locator('.company-card')).toHaveCount(1)
  await expect(page.locator('.catalog-placeholder, .company-card .stale-job-badge')).toHaveCount(0)
  expect(server.requests).toHaveLength(server.initialRequests + 1)
  expect(server.requests.every(request => /\/api\/catalog\?source=public(?:&refresh=1)?$/.test(request.url))).toBe(true)
  expect(await readSavedJson(page)).toBe(saved)
})

test('partial expiry updates company counts, city comparison and per-board history without fabricating a failed fetch', async ({ page }) => {
  const server = await restore(page, snapshot(base, base + 60 * 60_000), base + maxFallbackAge - 60_000)
  await expect(page.locator('.company-card')).toHaveCount(2)
  await page.getByRole('button', { name: '비교', exact: true }).click()
  await page.clock.fastForward(120_000)
  await expect(page.locator('.company-card')).toHaveCount(1)
  await expect(page.locator('.map-stats strong').first()).toHaveText('1곳')
  await page.getByRole('navigation', { name: '주요 메뉴' }).getByRole('button', { name: /도시 비교/ }).click()
  await expect(page.getByRole('row').filter({ hasText: '관련 채용공고' })).toContainText('1개')
  await expect(page.getByRole('row').filter({ hasText: '공고 조회 상태' })).toContainText('1개 이전 조회 공고 포함')
  await page.getByRole('button', { name: '공개 채용', exact: true }).click()
  await expect(page.locator('.collection-health dd')).toHaveText(['0개 공고', '1개 공고', '1개'])
  await expect(page.locator('.board-row').filter({ hasText: 'Fixture A' })).toContainText('확인 기간 지남')
  await expect(page.locator('.board-row').filter({ hasText: 'Fixture B' })).toContainText('이전 1개 유지')
  await expect(page.locator('.board-error-detail')).toHaveCount(0)
  expect(server.requests).toHaveLength(server.initialRequests)
})

for (const event of ['pageshow', 'focus', 'visibilitychange'] as const) {
  test(`a ${event} resume checks wall-clock age when timers did not run`, async ({ page }) => {
    const server = await restore(page)
    await expect(page.locator('.company-card')).toHaveCount(1)
    const returnedAt = base + maxFallbackAge + 1000
    const returned = snapshot(returnedAt)
    returned.jobs[0] = searchJob('Returned48', { fetchedAt: iso(returnedAt) })
    const held: import('@playwright/test').Route[] = []
    await page.route('**/api/catalog?source=public*', route => { held.push(route) })
    await page.clock.setSystemTime(new Date(returnedAt))
    // This is a synthetic lifecycle hint, not actual bfcache navigation.
    // Clock movement alone does not fetch; the visible return now revalidates.
    await page.evaluate(event => {
      if (event === 'visibilitychange') document.dispatchEvent(new Event(event))
      else if (event === 'pageshow') window.dispatchEvent(new PageTransitionEvent(event, { persisted: true }))
      else window.dispatchEvent(new Event(event))
    }, event)
    await expect.poll(() => held.length).toBe(1)
    await expect(page.locator('.company-card, .flat-marker')).toHaveCount(0)
    await expect(page.locator('.catalog-placeholder')).toHaveAttribute('aria-busy', 'true')
    expect(server.requests).toHaveLength(server.initialRequests + 1)
    expect(server.requests.at(-1)).toMatchObject({
      url: new URL('/api/catalog?source=public', page.url()).href, method: 'GET', body: null,
    })
    await held[0].fulfill({ json: returned })
    await expect(page.locator('.mini-job-title')).toHaveText(['Backend Engineer Returned48'])
    await expect(page.locator('.company-card')).toHaveCount(1)
    await expect(page.locator('.catalog-placeholder')).toHaveCount(0)
    expect(server.requests).toHaveLength(server.initialRequests + 1)
  })
}

test('an expired empty collection asks for a new check and remains accessible at 320px with sample mode available', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 780 })
  const server = await restore(page, snapshot(base, base, true))
  await expect(page.locator('.catalog-placeholder')).toHaveCount(0)
  await page.clock.fastForward(maxFallbackAge + 1)
  await expect(page.getByRole('heading', { name: '공고를 다시 확인해 주세요' })).toBeVisible()
  expect(await page.locator('body').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
  expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([])
  await page.getByRole('button', { name: '데이터 모드 선택', exact: true }).click()
  await expect(page.locator('.board-row')).toHaveCount(2)
  await expect(page.locator('.board-row .board-error')).toHaveText(['확인 기간 지남', '확인 기간 지남'])
  expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([])
  await page.getByRole('button', { name: /샘플로 탐색/ }).click()
  await page.getByRole('button', { name: '닫기', exact: true }).click()
  await expect(page.getByRole('button', { name: '샘플 탐색', exact: true })).toBeVisible()
  await expect(page.locator('.catalog-placeholder')).toHaveCount(0)
  expect(server.requests).toHaveLength(server.initialRequests)
})
