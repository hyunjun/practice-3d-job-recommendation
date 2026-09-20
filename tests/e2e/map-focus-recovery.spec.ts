import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import type { CatalogCollectionSnapshot, CatalogCollectionUpdate } from '../../shared/catalog-progress'
import { DEFAULT_FILTERS } from '../../shared/types'
import { COLLECTION_ID, progressSnapshot } from '../fixtures/catalog-progress'
import { searchCatalog, searchJob, SEARCH_PROFILE, SEARCH_TIME } from '../fixtures/search-catalog'
import { expectInitialCatalogRequest, watchApiRequests } from './helpers/api-requests'
import { expectFlatMapFocus, expectFlatMapTargets } from './helpers/flat-map'

const londonJob = searchJob('london')
// London ranks first for the TypeScript profile and represents the merged group.
const amsterdamJob = searchJob('amsterdam', {
  cityIds: ['amsterdam'], locationLabel: 'Amsterdam', minExperience: null,
})
const catalog = searchCatalog([londonJob, amsterdamJob])
const partial = progressSnapshot(1)
const collecting: CatalogCollectionSnapshot = {
  ...partial, catalog: { ...catalog, boards: [catalog.boards[0], partial.catalog.boards[1]] },
}
const city = (page: Page, name: string) => page.getByRole('button', { name: `${name}, 추천 회사 1곳, 회사 보기`, exact: true })
const group = (page: Page) => page.getByRole('button', { name: '런던 외 1개 도시, 추천 회사 1곳, 확대해서 도시별로 보기', exact: true })
const scale = async (page: Page) => Number((await page.locator('.flat-map svg > g').getAttribute('transform'))!.match(/scale\(([^)]+)\)/)![1])
const paths = (page: Page) => page.locator('.flat-map svg path').evaluateAll(elements => elements.map(element => element.getAttribute('d')))

test.use({ viewport: { width: 1440, height: 960 } })

async function setup(page: Page, pending = false) {
  await page.clock.setFixedTime(new Date(SEARCH_TIME))
  await page.route('**/api/catalog?source=public*', route => route.fulfill({
    status: pending ? 202 : 200, json: pending ? collecting : catalog,
  }))
  await page.addInitScript(({ profile, filters }) => {
    localStorage.setItem('orbit.v1.profile', JSON.stringify(profile))
    localStorage.setItem('orbit.v1.exploration', JSON.stringify({ source: 'public', mapMode: 'flat', selectedId: null, panelTab: 'cities', filters }))
  }, { profile: SEARCH_PROFILE, filters: DEFAULT_FILTERS })
  await page.goto('/')
  await expect(page.locator('.city-row')).toHaveCount(2)
  await expect.poll(() => page.locator('.flat-map svg path').count()).toBeGreaterThan(100)
  await page.evaluate(() => document.fonts.ready)
}

async function focusAmsterdam(page: Page) {
  const svg = page.locator('.flat-map svg')
  await svg.focus()
  for (let step = 0; step < 5; step++) await svg.press('+')
  await expect.poll(() => scale(page)).toBe(7.59375)
  await expectFlatMapTargets(page)
  await page.keyboard.press('Tab')
  await expect(city(page, '런던')).toBeFocused()
  await page.keyboard.press('Tab')
  await expectFlatMapFocus(city(page, '암스테르담'))
}

async function delayedUpdate(page: Page, keepLondon: boolean) {
  let release!: () => void
  const ready = new Promise<void>(resolve => { release = resolve })
  const { companies, cities: _cities, jobs, ...next } = searchCatalog(keepLondon ? [londonJob] : [])
  const update: CatalogCollectionUpdate = {
    progress: { id: COLLECTION_ID, revision: 3, total: 2, completed: 2, done: true },
    companyIds: companies.map(company => company.id), jobs, catalog: next,
  }
  await page.route('**/api/catalog/progress?*', async route => {
    await ready
    await route.fulfill({ json: update })
  })
  return release
}

function expectPublicTraffic(page: Page, traffic: ReturnType<typeof watchApiRequests>, initial: number, updates = 0) {
  expect(traffic.requests).toHaveLength(initial + updates)
  for (const request of traffic.requests) {
    expect(request.method).toBe('GET')
    expect(request.body).toBeNull()
    expect([
      new URL('/api/catalog?source=public', page.url()).href,
      new URL(`/api/catalog/progress?id=${COLLECTION_ID}&after=1`, page.url()).href,
    ]).toContain(request.url)
  }
}

for (const [width, height] of [[320, 844], [667, 375]]) test(`a city keeps keyboard focus through merging and splitting at ${width}×${height}`, async ({ page }, info) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  const traffic = watchApiRequests(page)
  await setup(page)
  const initial = await expectInitialCatalogRequest(page, traffic)
  await focusAmsterdam(page)
  const geometry = await paths(page)
  for (let repeat = 0; repeat < 2; repeat++) {
    await page.setViewportSize({ width, height })
    await expectFlatMapFocus(group(page))
    expect(await scale(page)).toBe(7.59375)
    await page.screenshot({ path: info.outputPath(`merged-${repeat}.png`) })
    await page.setViewportSize({ width: 1440, height: 960 })
    await expectFlatMapFocus(city(page, '암스테르담'))
    expect(await scale(page)).toBe(7.59375)
  }
  await expect(page.locator('.city-detail-hero')).toHaveCount(0)
  expect(await paths(page)).toEqual(geometry)
  expectPublicTraffic(page, traffic, initial.attempts)
  expect(errors).toEqual([])
})

test('activating a merged group returns focus to the original city, which opens only after a separate activation', async ({ page }) => {
  await setup(page)
  await focusAmsterdam(page)
  await page.setViewportSize({ width: 320, height: 844 })
  await expectFlatMapFocus(group(page))
  await group(page).press('Enter')
  await expect.poll(() => scale(page)).toBeGreaterThan(7.59375)
  await expectFlatMapFocus(city(page, '암스테르담'))
  await expect(page.locator('.city-detail-hero')).toHaveCount(0)
  await city(page, '암스테르담').press(' ')
  await expect(page.locator('.city-hero-caption h2')).toContainText('암스테르담')
  await expect(page.locator('.company-card h3')).toHaveText(['Fixture A'])
})

test('Tab can leave a restored group and resizing does not take focus back from the next control', async ({ page }) => {
  await setup(page)
  await focusAmsterdam(page)
  await page.setViewportSize({ width: 320, height: 844 })
  await expectFlatMapFocus(group(page))
  await page.keyboard.press('Tab')
  const control = page.getByRole('button', { name: '지구 처음 위치로', exact: true })
  await expect(control).toBeFocused()
  await page.setViewportSize({ width: 1440, height: 960 })
  await expect(control).toBeFocused()
  await page.keyboard.press('Shift+Tab')
  await expectFlatMapFocus(city(page, '암스테르담'))
  await expect(page.locator('.city-detail-hero')).toHaveCount(0)
})

for (const keepLondon of [true, false]) test(`a background update returns focus to the map when the current city disappears and ${keepLondon ? 'another city remains' : 'no cities remain'}`, async ({ page }) => {
  const traffic = watchApiRequests(page)
  const release = await delayedUpdate(page, keepLondon)
  await setup(page, true)
  const initial = await expectInitialCatalogRequest(page, traffic)
  await focusAmsterdam(page)
  release()
  await expect(page.locator('.city-row')).toHaveCount(keepLondon ? 1 : 0)
  await expect(page.locator('.collection-progress')).toHaveCount(0)
  const svg = page.locator('.flat-map svg')
  await expect(svg).toBeFocused()
  await expect(svg).toBeInViewport({ ratio: 1 })
  await expect(page.locator('.city-detail-hero')).toHaveCount(0)
  await svg.press('Home')
  await expect.poll(() => scale(page)).toBe(1)
  if (keepLondon) {
    await page.keyboard.press('Tab')
    await expectFlatMapFocus(city(page, '런던'))
  }
  expectPublicTraffic(page, traffic, initial.attempts, 1)
})

for (const destination of ['search', 'profile'] as const) test(`removing the old city does not take focus from the ${destination} after the user leaves the map`, async ({ page }) => {
  const traffic = watchApiRequests(page)
  const release = await delayedUpdate(page, true)
  await setup(page, true)
  const initial = await expectInitialCatalogRequest(page, traffic)
  await focusAmsterdam(page)
  if (destination === 'search') await page.getByLabel('도시, 회사 또는 포지션 검색').click()
  else {
    await page.locator('.profile-cta').click()
    await expect(page.getByRole('dialog')).toBeVisible()
  }
  const focused = await page.evaluateHandle(() => document.activeElement)
  release()
  await page.setViewportSize({ width: 320, height: 844 })
  await expect(page.locator('.city-row')).toHaveCount(1)
  await expect(page.locator('.collection-progress')).toHaveCount(0)
  expect(await focused.evaluate(element => element === document.activeElement)).toBe(true)
  if (destination === 'search') {
    await page.keyboard.type('London')
    await expect(page.getByLabel('도시, 회사 또는 포지션 검색')).toHaveValue('London')
  } else {
    expect(await page.getByRole('dialog').evaluate(dialog => dialog.contains(document.activeElement))).toBe(true)
    await page.keyboard.press('Escape')
    await expect(page.locator('.profile-cta')).toBeFocused()
  }
  await focused.dispose()
  await expect(page.locator('.city-detail-hero')).toHaveCount(0)
  expectPublicTraffic(page, traffic, initial.attempts, 1)
})
