import { expect, test } from '@playwright/test'
import type { Locator, Page } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { DEFAULT_FILTERS } from '../../shared/types'
import { searchCatalog, searchJob, SEARCH_PROFILE, SEARCH_TIME } from '../fixtures/search-catalog'
import { expectInitialCatalogRequest, watchApiRequests } from './helpers/api-requests'

const catalog = searchCatalog([
  searchJob('london', { title: 'Backend Engineer — London' }),
  searchJob('new-york', { title: 'Backend Engineer — New York', cityIds: ['new-york'], locationLabel: 'New York, United States' }),
  searchJob('seattle', { title: 'Backend Engineer — Seattle', cityIds: ['seattle'], locationLabel: 'Seattle, United States' }),
])

async function setup(page: Page, mapMode: 'flat' | 'globe', longName = false) {
  const profileName = longName ? 'A deliberately long profile name that must wrap without covering the region or map controls' : SEARCH_PROFILE.name
  await page.clock.setFixedTime(new Date(SEARCH_TIME))
  await page.route('**/api/catalog?source=public*', route => route.fulfill({ json: catalog }))
  await page.addInitScript(({ profile, filters, mapMode }) => {
    localStorage.setItem('orbit.v1.profile', JSON.stringify(profile))
    localStorage.setItem('orbit.v1.exploration', JSON.stringify({
      source: 'public', mapMode, selectedId: null, panelTab: 'cities', filters,
    }))
  }, {
    profile: { ...SEARCH_PROFILE, name: profileName },
    filters: DEFAULT_FILTERS, mapMode,
  })
  await page.goto('/')
  await expect(page.locator('.profile-cta')).toContainText(profileName)
  await expect(page.locator('.city-row')).toHaveCount(3)
  await expect(page.locator('.flat-marker, .globe-pin').first()).toBeVisible()
  if (mapMode === 'globe') await expect(page.locator('.earth-canvas')).toHaveClass(/is-ready/)
  await page.evaluate(() => document.fonts.ready)
}

async function expectMapSpace(page: Page) {
  // Compare rendered areas, including after ResizeObserver and fullscreen updates.
  await expect.poll(() => page.evaluate(() => {
    const map = document.querySelector('.flat-map, .earth-canvas')!.getBoundingClientRect()
    const regions = document.querySelector('.region-tabs')!.getBoundingClientRect()
    const controls = document.querySelector('.map-control-stack')!.getBoundingClientRect()
    const modes = document.querySelector('.map-bottom-bar')!.getBoundingClientRect()
    return map.width > 0 && map.height > 0 && regions.bottom <= map.top
      && map.bottom <= controls.top && map.bottom <= modes.top
  })).toBe(true)
}

async function expectReachable(target: Locator) {
  await target.scrollIntoViewIfNeeded()
  // Return through the real tab order so a preceding touch does not leave
  // this keyboard reachability check in pointer-focus modality.
  await target.press('Shift+Tab')
  await target.page().keyboard.press('Tab')
  await expect(target).toBeFocused()
  await expect.poll(() => target.evaluate(element => element.matches(':focus-visible'))).toBe(true)
  await expect.poll(() => target.evaluate(element => {
    const box = (element.querySelector('.flat-marker-hit') || element).getBoundingClientRect()
    return [0.15, 0.5, 0.85].every(x => [0.15, 0.5, 0.85].every(y => {
      const hit = document.elementFromPoint(box.left + box.width * x, box.top + box.height * y)
      return hit !== null && element.contains(hit)
    }))
  }), { message: 'The focused control must receive pointer input across its visible area' }).toBe(true)
}

async function expectTouchControls(page: Page) {
  const controls = page.locator('.region-tabs button, .map-control-stack button:visible, .map-view-switch button')
  for (const target of await controls.all()) {
    const box = (await target.boundingBox())!
    expect(box.width).toBeGreaterThanOrEqual(44)
    expect(box.height).toBeGreaterThanOrEqual(44)
    await expectReachable(target)
  }
}

for (const [width, height] of [[320, 568], [390, 844], [667, 375], [768, 1024]]) {
  for (const mapMode of ['flat', 'globe'] as const) test.describe(`${mapMode} map layout at ${width}×${height}`, () => {
    test.use({ viewport: { width, height }, isMobile: width < 680, hasTouch: true })

    test('regions and controls leave the cities reachable by touch and keyboard before and after filtering', async ({ page }, info) => {
      const errors: string[] = []
      page.on('pageerror', error => errors.push(error.message))
      const traffic = watchApiRequests(page)
      await setup(page, mapMode, width === 320)
      const initial = await expectInitialCatalogRequest(page, traffic)
      await expectMapSpace(page)
      await expectTouchControls(page)
      const region = page.getByRole('region', { name: /^[23]D 기회 지도/ })
      await region.focus()
      await page.keyboard.press('Tab')
      await expect(page.locator('.flat-marker, .globe-pin').first()).toBeFocused()
      for (const marker of await page.locator('.flat-marker, .globe-pin').all()) await expectReachable(marker)
      const europe = page.locator('.region-tabs').getByRole('button', { name: '유럽', exact: true })
      await europe.tap()
      await expect(europe).toHaveAttribute('aria-pressed', 'true')
      await expect(page.locator('.city-row')).toHaveCount(1)
      await expectMapSpace(page)
      await expectReachable(page.getByRole('button', { name: '런던, 추천 회사 1곳, 회사 보기', exact: true }))
      await page.locator('.region-tabs').getByRole('button', { name: '전 세계', exact: true }).tap()
      await page.getByLabel('도시, 회사 또는 포지션 검색').fill('Seattle')
      await expect(page.locator('.city-row')).toHaveCount(1)
      await expect(page.locator('.active-filter-summary')).toContainText('1개 공고')
      // Reset the camera as a user would after changing the region.
      await page.getByRole('button', { name: '지구 처음 위치로', exact: true }).tap()
      await expectMapSpace(page)
      const seattle = page.getByRole('button', { name: '시애틀, 추천 회사 1곳, 회사 보기', exact: true })
      await expectReachable(seattle)
      await page.screenshot({ path: info.outputPath('reachable-city.png') })
      await seattle.tap()
      await expect(page.locator('.city-hero-caption h2')).toContainText('시애틀')
      await page.getByRole('button', { name: mapMode === 'flat' ? '3D 지구' : '2D 지도', exact: true }).tap()
      await expect(page.locator(mapMode === 'flat' ? '.earth-canvas' : '.flat-map')).toBeVisible()
      if (mapMode === 'flat') await expect(page.locator('.earth-canvas')).toHaveClass(/is-ready/)
      await expectMapSpace(page)
      await expectReachable(page.getByRole('button', { name: '시애틀, 추천 회사 1곳, 회사 보기', exact: true }))
      expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze()).violations).toEqual([])
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      expect(traffic.requests).toHaveLength(initial.attempts)
      expect(errors).toEqual([])
    })
  })
}

for (const mapMode of ['flat', 'globe'] as const) test(`${mapMode} map retains usable controls across desktop, tablet, fullscreen and phone layouts`, async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  const traffic = watchApiRequests(page)
  await setup(page, mapMode)
  const initial = await expectInitialCatalogRequest(page, traffic)
  const desktop = await page.locator('.map-stage').boundingBox()
  expect(await page.locator('.map-viewport').boundingBox()).toEqual(desktop)
  await page.setViewportSize({ width: 768, height: 1024 })
  await expectMapSpace(page)
  const fullscreen = page.getByRole('button', { name: '지도 전체 화면', exact: true })
  await fullscreen.click()
  await expect.poll(() => page.evaluate(() => document.fullscreenElement?.classList.contains('map-stage'))).toBe(true)
  await expect(page.locator('.map-title')).toBeHidden()
  await expectMapSpace(page)
  await expectTouchControls(page)
  await page.setViewportSize({ width: 390, height: 844 })
  await expectMapSpace(page)
  await expectReachable(fullscreen)
  await fullscreen.press('Enter')
  await expect.poll(() => page.evaluate(() => document.fullscreenElement === null)).toBe(true)
  await expect(page.locator('.map-title')).toBeVisible()
  await expectMapSpace(page)
  await page.setViewportSize({ width: 1440, height: 960 })
  await expect.poll(async () => {
    const stage = await page.locator('.map-stage').boundingBox()
    const viewport = await page.locator('.map-viewport').boundingBox()
    return JSON.stringify(stage) === JSON.stringify(viewport)
  }).toBe(true)
  expect(traffic.requests).toHaveLength(initial.attempts)
  expect(errors).toEqual([])
})
