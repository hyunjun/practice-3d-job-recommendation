import { expect, test } from '@playwright/test'
import type { Page, TestInfo } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { DEFAULT_FILTERS } from '../../shared/types'
import { progressSnapshot, progressUpdate } from '../fixtures/catalog-progress'
import { SEARCH_PROFILE, SEARCH_TIME } from '../fixtures/search-catalog'
import { expectInitialCatalogRequest, watchApiRequests } from './helpers/api-requests'
import { readSavedJson, waitForSavedCommit } from './helpers/saved-store'

const message = '공고 데이터 형식을 확인하지 못했어요. 다시 조회해 주세요.'
const valid = progressSnapshot(2).catalog
const invalid = { ...valid, cities: [null, ...valid.cities.slice(1)] }
const close = (page: Page) => page.getByRole('button', { name: '닫기', exact: true }).click()

async function restore(page: Page, mapMode: 'flat' | 'globe') {
  await page.clock.install({ time: new Date(SEARCH_TIME) })
  await page.addInitScript(({ profile, filters, mapMode }) => {
    if (sessionStorage.getItem('catalog-validation-seeded')) return
    localStorage.setItem('orbit.v1.profile', JSON.stringify(profile))
    localStorage.setItem('orbit.v1.exploration', JSON.stringify({
      source: 'public', selectedId: 'london', mapMode, filters,
    }))
    sessionStorage.setItem('catalog-validation-seeded', 'true')
  }, { profile: SEARCH_PROFILE, filters: { ...DEFAULT_FILTERS, query: 'EarlyArrival' }, mapMode })
  await page.goto('/')
  if (mapMode === 'globe') await expect(page.locator('.earth-canvas')).toHaveClass(/is-ready/)
}

async function saveFirstArrival(page: Page) {
  await page.locator('.mini-job-title').click()
  await page.getByRole('button', { name: '기회 저장', exact: true }).click()
  await page.getByLabel('이 기회에 대한 나의 메모').fill('응답 오류에도 보존할 개인 메모')
  await page.getByRole('button', { name: '지원 완료로 표시', exact: true }).click()
  await waitForSavedCommit(page)
  return readSavedJson(page)
}

async function exploration(page: Page) {
  return page.evaluate(() => ({
    profile: localStorage.getItem('orbit.v1.profile'), exploration: localStorage.getItem('orbit.v1.exploration'),
  }))
}

async function audit(page: Page, info: TestInfo, name = 'recoverable-error') {
  await expect(page.getByRole('navigation', { name: '주요 메뉴' })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze()).violations).toEqual([])
  await page.screenshot({ path: info.outputPath(`${name}.png`) })
}

function expectPrivateTraffic(page: Page, traffic: ReturnType<typeof watchApiRequests>) {
  for (const request of traffic.requests) {
    const url = new URL(request.url)
    expect(url.origin).toBe(new URL(page.url()).origin)
    expect(request.method).toBe('GET')
    expect(request.body).toBeNull()
    expect(['/api/catalog', '/api/catalog/progress']).toContain(url.pathname)
    expect([...url.searchParams.keys()].every(key => ['source', 'refresh', 'id', 'after'].includes(key))).toBe(true)
  }
}

for (const [width, mapMode] of [[1440, 'flat'], [320, 'flat'], [390, 'globe']] as const) test.describe(`catalog response validation at ${width}px, ${mapMode}`, () => {
  test.use({ viewport: { width, height: 960 }, isMobile: width < 680, hasTouch: width < 680 })

  test('a malformed refresh preserves the current results, profile, search and saved record until an explicit retry', async ({ page }, info) => {
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    const traffic = watchApiRequests(page)
    let broken = false
    await page.route('**/api/catalog?source=public*', route => route.fulfill({ json: broken ? invalid : valid }))
    await restore(page, mapMode)
    await expect(page.locator('.mini-job-title')).toHaveText(valid.jobs[0].title)
    const initial = await expectInitialCatalogRequest(page, traffic)
    const saved = await saveFirstArrival(page)
    await close(page)
    const state = await exploration(page)
    broken = true
    await page.getByRole('button', { name: '공개 채용', exact: true }).click()
    await page.getByRole('button', { name: '새로고침', exact: true }).click()
    await expect(page.locator('.data-dialog .form-error')).toHaveText(message)
    await expect(page.locator('.coverage-stats strong').last()).toHaveText('2')
    await close(page)
    await expect(page.locator('.catalog-notice')).toContainText(message)
    await expect(page.locator('.mini-job-title')).toHaveText(valid.jobs[0].title)
    expect(await exploration(page)).toEqual(state)
    expect(await readSavedJson(page)).toBe(saved)
    await page.clock.fastForward(120000)
    expect(traffic.requests).toHaveLength(initial.attempts + 1)
    await audit(page, info)

    broken = false
    await page.getByRole('button', { name: '다시 조회', exact: true }).click()
    await expect(page.locator('.catalog-notice')).toHaveCount(0)
    expect(traffic.requests).toHaveLength(initial.attempts + 2)
    await page.reload()
    await expect(page.locator('.mini-job-title')).toHaveText(valid.jobs[0].title)
    await page.locator('.mini-job-title').click()
    await expect(page.getByLabel('이 기회에 대한 나의 메모')).toHaveValue('응답 오류에도 보존할 개인 메모')
    await expect(page.getByRole('button', { name: '지원 완료로 표시됨', exact: true })).toBeVisible()
    expect(await readSavedJson(page)).toBe(saved)
    expect(await exploration(page)).toEqual(state)
    expectPrivateTraffic(page, traffic)
    expect(errors).toEqual([])
  })

  test('an invalid initial response stays recoverable, and a malformed later chunk cannot erase the first arrival', async ({ page }, info) => {
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    const traffic = watchApiRequests(page)
    let phase: 'invalid' | 'collecting' | 'recovered' = 'invalid'
    const update = progressUpdate(2)
    Object.assign(update.jobs[0], { skills: [{}] })
    await page.route('**/api/catalog?source=public*', route => phase === 'collecting'
      ? route.fulfill({ status: 202, json: progressSnapshot(1) })
      : route.fulfill({ json: phase === 'invalid' ? invalid : valid }))
    await page.route('**/api/catalog/progress?*', route => route.fulfill({ json: update }))
    await restore(page, mapMode)
    await expect(page.locator('.catalog-placeholder')).toContainText(message)
    await expect(page.locator('.company-card, .search-recovery')).toHaveCount(0)
    const initial = await expectInitialCatalogRequest(page, traffic)
    await page.clock.fastForward(10000)
    expect(traffic.requests).toHaveLength(initial.attempts)
    await audit(page, info, 'initial-error')
    phase = 'collecting'
    await page.getByRole('button', { name: '다시 조회', exact: true }).click()
    await expect(page.getByRole('progressbar')).toHaveAttribute('value', '1')
    await expect(page.locator('.mini-job-title')).toHaveText(valid.jobs[0].title)
    const saved = await saveFirstArrival(page)
    const state = await exploration(page)
    await page.clock.fastForward(1100)
    await expect(page.getByLabel('이 기회에 대한 나의 메모')).toHaveValue('응답 오류에도 보존할 개인 메모')
    await close(page)
    await expect(page.locator('.catalog-notice')).toContainText(message)
    await expect(page.getByRole('progressbar')).toHaveCount(0)
    await page.getByRole('button', { name: '공개 공고 연결 필요', exact: true }).click()
    await expect(page.locator('.coverage-stats strong').last()).toHaveText('1')
    await close(page)
    expect(await exploration(page)).toEqual(state)
    expect(await readSavedJson(page)).toBe(saved)
    await page.clock.fastForward(120000)
    expect(traffic.requests).toHaveLength(initial.attempts + 2)
    await audit(page, info)

    phase = 'recovered'
    await page.getByRole('button', { name: '다시 조회', exact: true }).click()
    await expect(page.locator('.catalog-notice')).toHaveCount(0)
    await page.getByRole('button', { name: '공개 채용', exact: true }).click()
    await expect(page.locator('.coverage-stats strong').last()).toHaveText('2')
    await close(page)
    expect(await exploration(page)).toEqual(state)
    expect(await readSavedJson(page)).toBe(saved)
    expect(traffic.requests).toHaveLength(initial.attempts + 3)
    expectPrivateTraffic(page, traffic)
    expect(errors).toEqual([])
  })
})
