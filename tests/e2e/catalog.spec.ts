import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { normalizeJob } from '../../server/normalize'
import { CITIES } from '../../shared/cities'
import { PUBLIC_COMPANIES } from '../../shared/companies'
import type { Catalog } from '../../shared/types'

const previous = '2026-09-19T06:00:00.000Z'
const current = '2026-09-19T07:00:00.000Z'
const companies = PUBLIC_COMPANIES.slice(0, 3)
const jobs = companies.slice(0, 2).map((company, index) => normalizeJob({
  id: 700 + index, title: `Backend Engineer — ${company.name} feed fixture`,
  absolute_url: `https://example.com/jobs/feed-${index}`, location: { name: 'London, UK' },
  content: '<p>3 years of software engineering experience. Python and AWS.</p><p>We provide visa sponsorship.</p>',
  metadata: [{ name: 'Location Type', value: 'Hybrid' }, { name: 'Time Type', value: 'Full time' }],
}, company.id, index === 0 ? previous : current)!)

function catalog(degraded: boolean): Catalog {
  return {
    source: 'greenhouse', fetchedAt: current, checkedAt: current, stale: degraded,
    cities: CITIES, companies, unmappedCount: 0,
    jobs: jobs.map((job, index) => ({ ...job, stale: degraded && index === 0, fetchedAt: degraded && index === 0 ? previous : current })),
    boards: companies.map((company, index) => ({
      companyId: company.id, board: company.board!, total: index === 2 ? 0 : 1, included: index === 2 ? 0 : 1,
      status: degraded && index !== 1 ? 'error' : 'ok',
      dataStatus: !degraded || index === 1 ? 'fresh' : index === 0 ? 'stale' : 'unavailable',
      checkedAt: current, lastSuccessAt: degraded ? index === 0 ? previous : index === 2 ? null : current : current,
      ...(degraded && index !== 1 ? { message: 'HTTP 503', retryAt: '2026-09-19T07:02:00.000Z' } : {}),
    })),
  }
}

async function restorePublic(page: Page) {
  await page.addInitScript(() => localStorage.setItem('orbit.v1.exploration', JSON.stringify({
    source: 'greenhouse', selectedId: 'london', mapMode: 'flat',
  })))
  await page.goto('/')
}

test('partial feed failures preserve dated jobs across exploration, comparison and saving, then recover visibly', async ({ page }) => {
  let degraded = true
  await page.route('**/api/catalog?source=greenhouse*', route => route.fulfill({ json: catalog(degraded) }))
  await restorePublic(page)
  await expect(page.locator('.company-card')).toHaveCount(2)
  await expect(page.locator('.stale-job-badge')).toHaveCount(1)
  await expect(page.locator('.catalog-notice')).toContainText('이전 조회 공고 1개')
  await expect(page.locator('.catalog-notice')).toContainText('1개 회사는 확인 가능한 공고가 없어요')
  await page.getByRole('button', { name: '조회 상태', exact: true }).click()
  await expect(page.locator('.collection-health dd')).toHaveText(['1개 공고', '1개 공고', '1개'])
  const stripe = page.locator('.board-row').filter({ hasText: 'Stripe' })
  await expect(stripe).toContainText('이전 1개 유지')
  await expect(stripe.locator('time').first()).toHaveAttribute('datetime', previous)
  await expect(stripe).toContainText('HTTP 503')
  await expect(page.locator('.board-row').filter({ hasText: 'Vercel' })).toContainText('확인 기록 없음')
  expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([])
  await page.getByRole('button', { name: '닫기', exact: true }).click()

  await page.locator('.mini-job-title').filter({ hasText: 'Stripe' }).click()
  await expect(page.locator('.job-freshness-notice')).toContainText('이전 조회 결과를 보고 있어요')
  await expect(page.locator('.job-freshness-notice time')).toHaveAttribute('datetime', previous)
  await page.getByRole('button', { name: '기회 저장', exact: true }).click()
  await page.getByRole('button', { name: '닫기', exact: true }).click()
  await page.getByRole('button', { name: '비교', exact: true }).click()
  await page.getByRole('navigation', { name: '주요 메뉴' }).getByRole('button', { name: /도시 비교/ }).click()
  await expect(page.getByRole('row').filter({ hasText: '공고 조회 상태' })).toContainText('1개 이전 조회 공고 포함')
  await expect(page.locator('.catalog-notice')).toBeVisible()
  await page.getByRole('navigation', { name: '주요 메뉴' }).getByRole('button', { name: /저장한 기회/ }).click()
  await page.reload()
  await expect(page.locator('.saved-card .stale-job-badge')).toHaveText('이전 조회 공고')
  await page.locator('.saved-title').click()
  await expect(page.locator('.job-freshness-notice time')).toHaveAttribute('datetime', previous)
  await page.getByRole('button', { name: '닫기', exact: true }).click()

  degraded = false
  await page.getByRole('button', { name: '공개 채용', exact: true }).click()
  await page.getByRole('button', { name: '새로고침', exact: true }).click()
  await expect(page.locator('.collection-health dd')).toHaveText(['2개 공고', '0개 공고', '0개'])
  await page.getByRole('button', { name: '닫기', exact: true }).click()
  await page.getByRole('navigation', { name: '주요 메뉴' }).getByRole('button', { name: '기회 탐색', exact: true }).click()
  await expect(page.locator('.company-card')).toHaveCount(2)
  await expect(page.locator('.catalog-notice, .company-card .stale-job-badge')).toHaveCount(0)
  await page.locator('.mini-job-title').filter({ hasText: 'Stripe' }).click()
  await expect(page.locator('.job-freshness-notice')).toHaveCount(0)
})

test('retry deadlines disable repeated requests, expire without a reload and still allow sample exploration', async ({ page }) => {
  const start = Date.parse(current)
  await page.clock.install({ time: new Date(start) })
  let available = false
  let requests = 0
  await page.route('**/api/catalog?source=greenhouse*', route => {
    requests++
    return available
      ? route.fulfill({ json: { ...catalog(false), refreshAfter: new Date(start + 181000).toISOString() } })
      : route.fulfill({ status: 503, json: { error: '잠시 후 다시 조회해 주세요.', code: 'CATALOG_UNAVAILABLE', retryAt: new Date(start + 120000).toISOString() } })
  })
  await restorePublic(page)
  const retry = page.getByRole('button', { name: '다시 조회', exact: true })
  await expect(retry).toBeDisabled()
  const initialRequests = requests
  await page.getByRole('button', { name: '데이터 모드 선택', exact: true }).click()
  await expect(page.getByRole('button', { name: /공개 채용공고/ })).toBeDisabled()
  await expect(page.getByRole('button', { name: /샘플로 탐색/ })).toBeEnabled()
  await expect(page.getByRole('button', { name: '공개 공고 다시 조회', exact: true })).toBeDisabled()
  await page.getByRole('button', { name: '닫기', exact: true }).click()
  await page.clock.fastForward(60000)
  await expect(retry).toBeDisabled()
  expect(requests).toBe(initialRequests)
  await page.clock.fastForward(61000)
  await expect(retry).toBeEnabled()
  available = true
  await retry.click()
  await expect(page.locator('.company-card')).toHaveCount(2)
  expect(requests).toBe(initialRequests + 1)
  await page.getByRole('button', { name: '공개 채용', exact: true }).click()
  await expect(page.getByRole('button', { name: '새로고침', exact: true })).toBeDisabled()
  await page.getByRole('button', { name: /샘플로 탐색/ }).click()
  await page.getByRole('button', { name: '닫기', exact: true }).click()
  await expect(page.getByRole('button', { name: '샘플 탐색', exact: true })).toBeVisible()
  expect(requests).toBe(initialRequests + 1)
})

test('an expired server snapshot removes previously displayed jobs instead of retaining them after a failed refresh', async ({ page }) => {
  let expired = false
  await page.route('**/api/catalog?source=greenhouse*', route => expired
    ? route.fulfill({ status: 503, json: { code: 'CATALOG_EXPIRED', error: '마지막 정상 조회가 24시간을 지나 이전 공고를 표시하지 않습니다.' } })
    : route.fulfill({ json: catalog(false) }))
  await restorePublic(page)
  await expect(page.locator('.company-card')).toHaveCount(2)
  expired = true
  await page.getByRole('button', { name: '공개 채용', exact: true }).click()
  await page.getByRole('button', { name: '새로고침', exact: true }).click()
  await expect(page.locator('.coverage-stats strong').last()).toHaveText('—')
  await page.getByRole('button', { name: '닫기', exact: true }).click()
  await expect(page.locator('.catalog-placeholder')).toContainText('24시간')
  await expect(page.locator('.company-card, .city-row')).toHaveCount(0)
  await expect(page.locator('.map-stats strong')).toContainText(['—', '—'])
  await page.getByRole('navigation', { name: '주요 메뉴' }).getByRole('button', { name: /도시 비교/ }).click()
  await expect(page.locator('.catalog-placeholder')).toBeVisible()
  await expect(page.locator('.comparison-table')).toHaveCount(0)
})

test.describe('mobile feed status', () => {
  test.use({ viewport: { width: 320, height: 780 }, isMobile: true, hasTouch: true })
  test('company history and retained-job details remain readable at 320px', async ({ page }) => {
    await page.route('**/api/catalog?source=greenhouse*', route => route.fulfill({ json: catalog(true) }))
    await restorePublic(page)
    await page.getByRole('button', { name: '공개 채용', exact: true }).click()
    const stripe = page.locator('.board-row').filter({ hasText: 'Stripe' })
    await stripe.scrollIntoViewIfNeeded()
    await expect(stripe).toBeVisible()
    await expect(stripe.locator('time').first()).toHaveAttribute('datetime', previous)
    expect(await page.locator('.dialog').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
    expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([])
    await page.getByRole('button', { name: '닫기', exact: true }).click()
    await page.locator('.mini-job-title').filter({ hasText: 'Stripe' }).click()
    await expect(page.locator('.job-freshness-notice')).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  })
})
