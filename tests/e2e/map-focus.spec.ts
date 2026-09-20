import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { CITIES } from '../../shared/cities'
import { DEFAULT_FILTERS } from '../../shared/types'
import { searchCatalog, searchJob, SEARCH_PROFILE, SEARCH_TIME } from '../fixtures/search-catalog'
import { expectInitialCatalogRequest, watchApiRequests } from './helpers/api-requests'
import { expectFlatMapFocus, expectFlatMapTargets } from './helpers/flat-map'

const catalog = searchCatalog(CITIES.map(city => searchJob(city.id, {
  title: `Backend Engineer — ${city.en}`, cityIds: [city.id], locationLabel: city.en,
})))
const single = searchCatalog([searchJob('london')])
const settle = (page: Page) => page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
const view = (page: Page) => page.locator('.flat-map svg > g').getAttribute('transform')
const zoom = async (page: Page) => Number((await view(page))!.match(/scale\(([^)]+)\)/)![1])
const geometry = (page: Page) => page.locator('.flat-map svg path').evaluateAll(paths => paths.map(path => path.getAttribute('d')))

async function setup(page: Page, data = catalog) {
  await page.clock.setFixedTime(new Date(SEARCH_TIME))
  await page.route('**/api/catalog?source=public*', route => route.fulfill({ json: data }))
  await page.addInitScript(({ profile, filters }) => {
    localStorage.setItem('orbit.v1.profile', JSON.stringify(profile))
    localStorage.setItem('orbit.v1.exploration', JSON.stringify({ source: 'public', mapMode: 'flat', selectedId: null, panelTab: 'cities', filters }))
  }, { profile: SEARCH_PROFILE, filters: DEFAULT_FILTERS })
  await page.goto('/')
  await expect(page.locator('.city-row')).toHaveCount(data === single ? 1 : CITIES.length)
  await expect.poll(() => page.locator('.flat-map svg path').count()).toBeGreaterThan(100)
  await page.evaluate(() => document.fonts.ready)
}

for (const [width, height] of [[320, 568], [320, 844], [667, 375], [768, 1024], [1440, 960], [2560, 720]]) test.describe(`2D keyboard focus at ${width}×${height}`, () => {
  test.use({ viewport: { width, height } })

  test('Tab and Shift+Tab reveal every city group after zooming and panning without selecting or changing scale', async ({ page }, info) => {
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    const traffic = watchApiRequests(page)
    await setup(page)
    const initial = await expectInitialCatalogRequest(page, traffic)
    const paths = await geometry(page)
    const svg = page.locator('.flat-map svg')
    await svg.focus()
    for (let step = 0; step < 5; step++) await svg.press('+')
    for (let step = 0; step < 4; step++) await svg.press('ArrowRight')
    for (let step = 0; step < 3; step++) await svg.press('ArrowDown')
    await expect.poll(() => zoom(page)).toBe(7.59375)
    const labels = await page.locator('.flat-marker').evaluateAll(markers => markers.map(marker => marker.getAttribute('aria-label')!))
    expect(labels.length).toBeGreaterThan(5)
    const focused = page.locator('.flat-marker:focus')
    for (const label of labels) {
      await page.keyboard.press('Tab')
      await expect(focused).toHaveAttribute('aria-label', label)
      await expectFlatMapFocus(focused)
      expect(await zoom(page)).toBe(7.59375)
    }
    await page.screenshot({ path: info.outputPath('last-city-focused.png') })
    for (const label of labels.slice(0, -1).reverse()) {
      await page.keyboard.press('Shift+Tab')
      await expect(focused).toHaveAttribute('aria-label', label)
      await expectFlatMapFocus(focused)
    }
    await expect(page.locator('.city-detail-hero')).toHaveCount(0)
    await expect(page.locator('.city-row')).toHaveCount(CITIES.length)
    expect(await zoom(page)).toBe(7.59375)
    expect(await geometry(page)).toEqual(paths)
    // Focusing an already visible city leaves the map where the user put it.
    await page.getByLabel('도시, 회사 또는 포지션 검색').fill('London')
    await expect(page.locator('.city-row')).toHaveCount(1)
    await svg.focus()
    await svg.press('Home')
    await settle(page)
    const before = await view(page)
    await page.keyboard.press('Tab')
    await expectFlatMapFocus(focused)
    expect(await view(page)).toBe(before)
    await focused.press('Enter')
    await expect(page.locator('.city-hero-caption h2')).toContainText('런던')
    expect(traffic.requests).toHaveLength(initial.attempts)
    expect(errors).toEqual([])
  })
})

for (const touch of [false, true]) test.describe(`${touch ? 'touch' : 'mouse'} on a partly clipped 2D city`, () => {
  test.use({ viewport: touch ? { width: 320, height: 844 } : { width: 1440, height: 960 }, hasTouch: touch, isMobile: touch })

  test('pointer focus leaves the map still until the original city is activated', async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    const traffic = watchApiRequests(page)
    await setup(page, single)
    const initial = await expectInitialCatalogRequest(page, traffic)
    const svg = page.locator('.flat-map svg')
    await svg.focus()
    for (let step = 0; step < 5; step++) await svg.press('+')
    await expect.poll(() => zoom(page)).toBe(7.59375)
    const position = async () => (await expectFlatMapTargets(page))[0]
    let current = await position()
    const delta = current.frame.y - 8 - (current.target.y + current.target.height / 2)
    const steps = Math.trunc(delta / 50)
    for (let step = 0; step < Math.abs(steps); step++) await svg.press(steps > 0 ? 'ArrowUp' : 'ArrowDown')
    current = await position()
    const desired = { x: current.frame.x + current.frame.width / 2, y: current.frame.y - 8 }
    const start = { x: current.frame.x + current.frame.width * 0.25, y: current.frame.y + current.frame.height * 0.5 }
    await page.mouse.move(start.x, start.y)
    await page.mouse.down()
    await page.mouse.move(start.x + desired.x - current.target.x - current.target.width / 2, start.y + desired.y - current.target.y - current.target.height / 2, { steps: 3 })
    await page.mouse.up()
    await expect.poll(async () => { const value = await position(); return value.target.y + value.target.height / 2 - value.frame.y }).toBeCloseTo(-8, 1)
    current = await position()
    const point = { x: current.target.x + current.target.width / 2, y: current.frame.y + 6 }
    if (touch) await page.touchscreen.tap(point.x, point.y)
    else {
      await page.mouse.move(point.x, point.y)
      const before = await view(page)
      await page.mouse.down()
      await settle(page)
      expect(await view(page)).toBe(before)
      await page.mouse.up()
    }
    await expect(page.locator('.city-hero-caption h2')).toContainText('런던')
    await expect(page.locator('.company-card h3')).toHaveText(['Fixture A'])
    expect(traffic.requests).toHaveLength(initial.attempts)
    expect(errors).toEqual([])
  })
})

test('a focused city remains visible when the map changes between desktop and phone dimensions', async ({ page }) => {
  await setup(page)
  const svg = page.locator('.flat-map svg')
  await svg.focus()
  for (let step = 0; step < 5; step++) await svg.press('+')
  await page.keyboard.press('Tab')
  const focused = page.locator('.flat-marker:focus')
  await expectFlatMapFocus(focused)
  for (const [width, height] of [[320, 844], [768, 1024], [2560, 720]]) {
    await page.setViewportSize({ width, height })
    await expectFlatMapFocus(focused)
    expect(await zoom(page)).toBe(7.59375)
  }
  await expect(page.locator('.city-detail-hero')).toHaveCount(0)
})
