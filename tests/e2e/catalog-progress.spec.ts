import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { DEFAULT_FILTERS } from '../../shared/types'
import { COLLECTION_ID, progressSnapshot, progressUpdate } from '../fixtures/catalog-progress'
import { SEARCH_TIME } from '../fixtures/search-catalog'

test.beforeEach(async ({ page }) => { await page.clock.install({ time: new Date(SEARCH_TIME) }) })

async function restore(page: Page) {
  await page.addInitScript(filters => {
    if (!localStorage.getItem('orbit.v1.exploration')) localStorage.setItem('orbit.v1.exploration', JSON.stringify({
      source: 'public', selectedId: 'london', mapMode: 'flat', filters,
    }))
  }, DEFAULT_FILTERS)
  await page.goto('/')
}

test('first arrivals can be searched and saved while remaining companies load, with no filter or note loss', async ({ page }) => {
  let completed = 0
  const requests: { path: string; method: string; body: string | null }[] = []
  page.on('request', request => {
    if (request.url().includes('/api/')) requests.push({ path: new URL(request.url()).pathname + new URL(request.url()).search, method: request.method(), body: request.postData() })
  })
  await page.route('**/api/catalog?source=public*', route => route.fulfill({
    status: 202, headers: { 'Retry-After': '1' }, json: progressSnapshot(),
  }))
  await page.route('**/api/catalog/progress?*', route => {
    const after = Number(new URL(route.request().url()).searchParams.get('after'))
    return completed <= after ? route.fulfill({ status: 204 })
      : route.fulfill({ json: progressUpdate(completed, after) })
  })
  await restore(page)
  const progress = page.getByRole('progressbar', { name: '공개 게시판 조회 진행' })
  await expect(progress).toHaveAttribute('value', '0')
  await expect(page.locator('.search-recovery, .company-card')).toHaveCount(0)
  completed = 1
  await page.clock.fastForward(1100)
  await expect(progress).toHaveAttribute('value', '1')
  await expect(page.locator('.company-card')).toHaveCount(1)
  await expect(page.locator('.company-card')).toContainText('Fixture A')
  await page.getByLabel('도시, 회사 또는 포지션 검색').fill('EarlyArrival')
  await page.locator('.mini-job-title').click()
  await page.getByRole('button', { name: '기회 저장', exact: true }).click()
  await page.getByLabel('이 기회에 대한 나의 메모').fill('수집 중에도 기록 유지')
  await page.getByRole('button', { name: '지원 완료로 표시', exact: true }).click()
  const saved = await page.evaluate(() => localStorage.getItem('orbit.v1.saved'))
  completed = 2
  await page.clock.fastForward(1100)
  await expect(page.getByLabel('이 기회에 대한 나의 메모')).toHaveValue('수집 중에도 기록 유지')
  await page.getByRole('button', { name: '닫기', exact: true }).click()
  await expect(progress).toHaveCount(0)
  await expect(page.getByRole('button', { name: '공개 채용', exact: true })).toBeVisible()
  await expect(page.getByLabel('도시, 회사 또는 포지션 검색')).toHaveValue('EarlyArrival')
  await expect(page.locator('.company-card')).toHaveCount(1)
  expect(await page.evaluate(() => localStorage.getItem('orbit.v1.saved'))).toBe(saved)
  await page.getByRole('button', { name: '검색어 지우기', exact: true }).click()
  await expect(page.locator('.company-card')).toHaveCount(2)
  const count = requests.length
  await page.clock.fastForward(120000)
  expect(requests).toHaveLength(count)
  expect(requests.every(request => request.method === 'GET' && request.body === null)).toBe(true)
  expect(requests.every(request => request.path === '/api/catalog?source=public'
    || request.path.startsWith(`/api/catalog/progress?id=${COLLECTION_ID}&after=`))).toBe(true)
})

test('switching to sample cancels an in-flight monitor and an old response cannot replace the sample', async ({ page }) => {
  let finish!: () => void
  let monitors = 0
  await page.route('**/api/catalog?source=public*', route => route.fulfill({ status: 202, json: progressSnapshot(1) }))
  await page.route('**/api/catalog/progress?*', async route => {
    monitors++
    await new Promise<void>(resolve => { finish = resolve })
    await route.fulfill({ json: progressUpdate(2) })
  })
  await restore(page)
  await expect(page.locator('.company-card')).toHaveCount(1)
  await page.clock.fastForward(1100)
  await expect.poll(() => monitors).toBe(1)
  await page.getByRole('button', { name: '공개 공고 조회 중', exact: true }).click()
  await page.getByRole('button', { name: /샘플로 탐색/ }).click()
  await expect(page.locator('.coverage-stats strong')).toHaveText(['22', '32', '179'])
  finish()
  await page.clock.fastForward(120000)
  await expect(page.locator('.coverage-stats strong')).toHaveText(['22', '32', '179'])
  expect(monitors).toBe(1)
  await page.getByRole('button', { name: '닫기', exact: true }).click()
  await expect(page.getByRole('button', { name: '샘플 탐색', exact: true })).toBeVisible()
  await expect(page.locator('.collection-progress')).toHaveCount(0)
  expect(JSON.parse(await page.evaluate(() => localStorage.getItem('orbit.v1.exploration')) || '{}').source).toBe('sample')
})

test('all-failed first collection shows a retryable connection error instead of empty successful recommendations', async ({ page }) => {
  let monitors = 0
  await page.route('**/api/catalog?source=public*', route => route.fulfill({ status: 202, json: progressSnapshot() }))
  await page.route('**/api/catalog/progress?*', route => {
    monitors++
    return route.fulfill({ status: 503, json: {
      error: '공개 게시판에 연결하지 못했어요.', code: 'CATALOG_UNAVAILABLE', retryAt: '2026-09-19T08:02:00.000Z',
    } })
  })
  await restore(page)
  await expect(page.getByRole('progressbar')).toBeVisible()
  await page.clock.fastForward(1100)
  await expect(page.locator('.catalog-placeholder')).toContainText('공개 게시판에 연결하지 못했어요')
  await expect(page.getByRole('button', { name: /다시 조회/ })).toBeDisabled()
  await expect(page.locator('.search-recovery, .company-card, .city-row')).toHaveCount(0)
  await page.clock.fastForward(120000)
  expect(monitors).toBe(1)
  await expect(page.getByRole('button', { name: '다시 조회', exact: true })).toBeEnabled()
})

test.describe('incremental collection at 320px', () => {
  test.use({ viewport: { width: 320, height: 780 }, isMobile: true, hasTouch: true })
  test('distinguishes pending from failed companies, retains first results on disconnect and reconnects on request', async ({ page }) => {
    let starts = 0
    let fail = false
    let complete = false
    let monitors = 0
    await page.route('**/api/catalog?source=public*', route => {
      starts++
      return route.fulfill({ status: 202, json: progressSnapshot(1) })
    })
    await page.route('**/api/catalog/progress?*', route => {
      monitors++
      return fail ? route.abort('failed') : complete ? route.fulfill({ json: progressUpdate(2) }) : route.fulfill({ status: 204 })
    })
    await restore(page)
    await expect(page.locator('.company-card')).toHaveCount(1)
    await page.getByRole('button', { name: '공개 공고 조회 중', exact: true }).click()
    await expect(page.getByRole('dialog').getByRole('progressbar')).toHaveAttribute('aria-valuetext', '2개 회사 중 1개 조회 종료')
    const pending = page.locator('.board-row').filter({ hasText: 'Fixture B' })
    await expect(pending).toContainText('조회 중')
    await expect(pending).not.toContainText('데이터 미확인')
    await expect(page.locator('.collection-health dd')).toHaveText(['1개 공고', '0개 공고', '0개'])
    expect(await page.locator('.dialog').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
    expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([])
    await page.getByRole('button', { name: '닫기', exact: true }).click()
    fail = true
    await page.clock.fastForward(1100)
    await expect(page.locator('.catalog-notice')).toContainText('수집 진행 연결이 끊겼어요')
    await expect(page.locator('.company-card')).toHaveCount(1)
    const stoppedAt = monitors
    await page.clock.fastForward(10000)
    expect(monitors).toBe(stoppedAt)
    expect(starts).toBe(1)
    fail = false
    complete = true
    await page.getByRole('button', { name: '다시 조회', exact: true }).click()
    await expect(page.getByRole('progressbar')).toBeVisible()
    await page.clock.fastForward(1100)
    await expect(page.locator('.company-card')).toHaveCount(2)
    await expect(page.getByRole('progressbar')).toHaveCount(0)
    expect(starts).toBe(2)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  })
})
