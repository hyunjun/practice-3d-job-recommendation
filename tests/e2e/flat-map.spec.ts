import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { DEFAULT_FILTERS } from '../../shared/types'
import { searchCatalog, searchJob, SEARCH_COMPANIES, SEARCH_PROFILE, SEARCH_TIME } from '../fixtures/search-catalog'
import { expectInitialCatalogRequest, watchApiRequests } from './helpers/api-requests'

const nearby = searchCatalog([
  searchJob('seattle', { cityIds: ['seattle'], locationLabel: 'Seattle, Washington, United States' }),
  searchJob('vancouver-a', { cityIds: ['vancouver'], locationLabel: 'Vancouver, Canada' }),
  searchJob('vancouver-b', { companyId: SEARCH_COMPANIES[1].id, cityIds: ['vancouver'], locationLabel: 'Vancouver, Canada' }),
])
const single = searchCatalog([searchJob('london')])
const settle = (page: Page) => page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
const geometry = (page: Page) => page.locator('.flat-map svg path').evaluateAll(paths => paths.map(path => path.getAttribute('d')))

async function setup(page: Page, catalog = nearby) {
  await page.clock.setFixedTime(new Date(SEARCH_TIME))
  await page.route('**/api/catalog?source=public*', route => route.fulfill({ json: catalog }))
  await page.addInitScript(({ profile, filters }) => {
    localStorage.setItem('orbit.v1.profile', JSON.stringify(profile))
    localStorage.setItem('orbit.v1.exploration', JSON.stringify({
      source: 'public', mapMode: 'flat', selectedId: null, panelTab: 'cities', filters,
    }))
  }, { profile: SEARCH_PROFILE, filters: DEFAULT_FILTERS })
  await page.goto('/')
  await expect(page.locator('.flat-marker').first()).toBeVisible()
  await expect.poll(() => page.locator('.flat-map svg path').count()).toBeGreaterThan(100)
}

async function expectReadableTargets(page: Page) {
  // ResizeObserver and the subsequent SVG layout can span more than two frames.
  await expect.poll(() => page.locator('.flat-marker-hit').evaluateAll(targets => targets.length
    ? Math.max(...targets.flatMap(target => {
      const rect = target.getBoundingClientRect()
      return [Math.abs(rect.width - 44), Math.abs(rect.height - 44)]
    })) : Infinity,
  )).toBeLessThan(0.005)
  const controls = await page.locator('.flat-marker').evaluateAll(markers => markers.map(marker => {
    const target = marker.querySelector('.flat-marker-hit')!.getBoundingClientRect()
    const text = marker.querySelector('text')!
    const matrix = text.getScreenCTM()!
    return { width: target.width, height: target.height, font: parseFloat(getComputedStyle(text).fontSize) * Math.hypot(matrix.a, matrix.b) }
  }))
  expect(controls.length).toBeGreaterThan(0)
  for (const control of controls) {
    expect(control.width).toBeCloseTo(44, 2)
    expect(control.height).toBeCloseTo(44, 2)
    expect(control.font).toBeCloseTo(12, 2)
  }
}

async function screenView(page: Page) {
  await settle(page)
  return page.locator('.flat-map svg').evaluate(svg => {
    const matrix = svg.querySelector<SVGGElement>(':scope > g')!.getScreenCTM()!
    return { x: matrix.e, y: matrix.f }
  })
}

for (const [width, height] of [[320, 960], [1440, 960], [2560, 720]]) test.describe(`flat map at ${width}×${height}`, () => {
  test.use({ viewport: { width, height }, hasTouch: width < 680, isMobile: width < 680 })

  test('readable controls keep company counts and let nearby cities separate and open individually', async ({ page }, info) => {
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    const traffic = watchApiRequests(page)
    await setup(page)
    const initial = await expectInitialCatalogRequest(page, traffic)
    const paths = await geometry(page)
    await expect(page.locator('.flat-marker')).toHaveCount(1)
    await expect(page.locator('.flat-marker')).toHaveAttribute('aria-label', '밴쿠버 외 1개 도시, 추천 회사 2곳, 확대해서 도시별로 보기')
    await expectReadableTargets(page)
    await page.locator('.flat-map svg').focus()
    await page.locator('.flat-map svg').press('Home')
    for (let step = 0; step < 8; step++) {
      const marker = page.locator('.flat-marker').first()
      if (!(await marker.getAttribute('aria-label'))?.includes('확대해서')) break
      await marker.focus()
      await expect(marker).toBeFocused()
      await marker.press('Enter')
      await expectReadableTargets(page)
    }
    await expect(page.locator('.flat-marker')).toHaveCount(2)
    const vancouver = page.getByRole('button', { name: '밴쿠버, 추천 회사 2곳, 회사 보기', exact: true })
    await expect(page.getByRole('button', { name: '시애틀, 추천 회사 1곳, 회사 보기', exact: true })).toBeVisible()
    await expect(vancouver).toBeFocused()
    expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze()).violations).toEqual([])
    await page.screenshot({ path: info.outputPath('separated-cities.png') })
    if (width < 680) await vancouver.tap()
    else await vancouver.press(' ')
    await expect(page.locator('.city-hero-caption h2')).toContainText('밴쿠버')
    await expect(page.locator('.company-card h3')).toHaveText(['Fixture A', 'Fixture B'])
    expect(await geometry(page)).toEqual(paths)
    expect(traffic.requests).toHaveLength(initial.attempts)
    expect(errors).toEqual([])
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  })
})

test('resizing and fullscreen preserve target sizes, and pointer and keyboard movement use screen distances', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  const traffic = watchApiRequests(page)
  await setup(page, single)
  const initial = await expectInitialCatalogRequest(page, traffic)
  const paths = await geometry(page)
  const svg = page.locator('.flat-map svg')
  for (const [width, height] of [[320, 960], [2560, 720], [390, 844]]) {
    await page.setViewportSize({ width, height })
    await expectReadableTargets(page)
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }))
    await svg.focus()
    await svg.press('Home')
    const before = await screenView(page)
    const rect = (await svg.boundingBox())!
    const start = { x: rect.x + rect.width * 0.6, y: rect.y + rect.height * 0.68 }
    await page.mouse.move(start.x, start.y)
    await page.mouse.down()
    await page.mouse.move(start.x + 100, start.y + 60, { steps: 5 })
    await page.mouse.up()
    await expect.poll(async () => (await screenView(page)).x - before.x).toBeCloseTo(100, 1)
    await expect.poll(async () => (await screenView(page)).y - before.y).toBeCloseTo(60, 1)
    const after = await screenView(page)
    await svg.press('ArrowRight')
    await expect.poll(async () => (await screenView(page)).x - after.x).toBeCloseTo(-50, 1)
    const keyboard = await screenView(page)
    expect(keyboard.y).toBeCloseTo(after.y, 1)
    await page.mouse.move(start.x, start.y)
    await page.mouse.down({ button: 'right' })
    await page.mouse.move(start.x + 50, start.y)
    await page.mouse.up({ button: 'right' })
    expect(await screenView(page)).toEqual(keyboard)
    await page.keyboard.press('Escape')
    expect(await geometry(page)).toEqual(paths)
  }
  await page.setViewportSize({ width: 1440, height: 960 })
  await page.getByRole('button', { name: '지도 전체 화면', exact: true }).click()
  await expect.poll(() => page.evaluate(() => document.fullscreenElement?.classList.contains('map-stage'))).toBe(true)
  await expectReadableTargets(page)
  await page.getByRole('button', { name: '지도 전체 화면', exact: true }).click()
  await expect.poll(() => page.evaluate(() => document.fullscreenElement === null)).toBe(true)
  await expectReadableTargets(page)
  expect(await geometry(page)).toEqual(paths)
  expect(traffic.requests).toHaveLength(initial.attempts)
  expect(errors).toEqual([])
})
