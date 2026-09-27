import { expect } from '@playwright/test'
import {
  expectGlobeScreen, expectNoGlobeInput, firstFrameTest as test, globeIdle,
  restoreLondon, sampleGlobeScreen,
} from './helpers/globe-first-frame'

test.use({ viewport: { width: 1440, height: 960 }, serviceWorkers: 'block' })
test.setTimeout(45_000)

for (const reducedMotion of ['reduce', 'no-preference'] as const) test.describe(`fresh visit / motion ${reducedMotion}`, () => {
  test.use({ reducedMotion })

  test('the first globe is painted before any map input and stays painted after idle', async ({ page, firstFrame }, info) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' })
    await expect(page.getByRole('button', { name: '3D 지구', exact: true })).toHaveAttribute('aria-pressed', 'true')
    await expectGlobeScreen(page, info, 'fresh-first-screen')
    await expectNoGlobeInput(page)
    await expect(page.locator('.city-row')).toHaveCount(22)
    await expect.poll(() => ['/earth/day.jpg', '/earth/night.jpg'].every(path => firstFrame.completed.has(path))).toBe(true)
    await globeIdle(page)
    await expectGlobeScreen(page, info, 'fresh-textured-idle', { textured: true })
    await expectNoGlobeInput(page)

    const gl = await page.locator('.earth-canvas > canvas').evaluate((canvas: HTMLCanvasElement) => {
      const context = canvas.getContext('webgl2')!
      return { version: context.getParameter(context.VERSION) as string, attributes: context.getContextAttributes() }
    })
    expect(gl.version).toMatch(/WebGL 2/)
    await info.attach('webgl-context', { body: Buffer.from(JSON.stringify(gl)), contentType: 'application/json' })

    // Calibrate after the real assertions: readiness and markers remain present
    // but hiding the canvas must make the pixel oracle reject the screen.
    await expect(page.locator('.globe-pin').first()).toBeVisible()
    await expect(page.locator('.earth-canvas')).toHaveClass(/is-ready/)
    const hidden = await sampleGlobeScreen(page, true)
    await info.attach('canvas-hidden-negative-control', { body: hidden.png, contentType: 'image/png' })
    await info.attach('canvas-hidden-negative-control-pixels', {
      body: Buffer.from(JSON.stringify(hidden.pixels)), contentType: 'application/json',
    })
    expect(hidden.pixels.surfaceRatio).toBeLessThan(0.01)
    await expect(page.locator('.globe-pin').first()).toBeVisible()
    await expectGlobeScreen(page, info, 'negative-control-restored', { textured: true })
    await expectNoGlobeInput(page)
  })
})

test('a globe is visible with textures and jobs still pending, then repaints each independent arrival without input', async ({ page, firstFrame }, info) => {
  firstFrame.hold('catalog', 'day', 'night')
  await page.goto('/', { waitUntil: 'domcontentloaded' })
  await expect(page.locator('.earth-canvas > canvas')).toHaveCount(1)
  await expectGlobeScreen(page, info, 'textures-and-jobs-pending')
  await expectNoGlobeInput(page)
  expect(firstFrame.completed.has('/api/catalog')).toBe(false)
  expect(firstFrame.completed.has('/earth/day.jpg')).toBe(false)
  expect(firstFrame.completed.has('/earth/night.jpg')).toBe(false)
  await expect(page.locator('.city-row, .globe-pin')).toHaveCount(0)
  const canvas = await page.locator('.earth-canvas > canvas').elementHandle()

  firstFrame.release('day')
  await expect.poll(() => firstFrame.completed.has('/earth/day.jpg')).toBe(true)
  await globeIdle(page)
  await expectGlobeScreen(page, info, 'day-only-jobs-pending')
  expect(firstFrame.completed.has('/earth/night.jpg')).toBe(false)
  await expect(page.locator('.city-row, .globe-pin')).toHaveCount(0)
  await expectNoGlobeInput(page)

  firstFrame.release('catalog')
  await expect(page.locator('.city-row')).toHaveCount(22)
  await expect(page.locator('.map-stats strong')).toHaveText(['3곳', '22곳'])
  await expectGlobeScreen(page, info, 'jobs-arrived-night-pending')
  await expectNoGlobeInput(page)
  // Finish other asynchronous redraw sources before releasing the last image.
  await expect.poll(() => firstFrame.completed.has('/earth/countries-110m.json')).toBe(true)
  await page.evaluate(() => document.fonts.ready)
  await globeIdle(page)

  firstFrame.release('night')
  await expect.poll(() => firstFrame.completed.has('/earth/night.jpg')).toBe(true)
  await expectGlobeScreen(page, info, 'both-textures-no-input', { textured: true })
  await globeIdle(page)
  await expectGlobeScreen(page, info, 'both-textures-idle', { textured: true })
  expect(await canvas!.evaluate(element => element === document.querySelector('.earth-canvas > canvas'))).toBe(true)
  await expectNoGlobeInput(page)
})

test.describe('phone with no public jobs', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, reducedMotion: 'no-preference' })

  test('an empty catalog still shows the first sphere and a textured sphere after 2D/3D remount', async ({ page, firstFrame }, info) => {
    firstFrame.emptyCatalog()
    firstFrame.hold('day', 'night')
    await page.goto('/', { waitUntil: 'domcontentloaded' })
    await expect.poll(() => firstFrame.completed.has('/api/catalog')).toBe(true)
    await expect(page.locator('.city-row, .globe-pin')).toHaveCount(0)
    await expect(page.locator('.map-stats strong')).toHaveText(['0곳', '0곳'])
    await expectGlobeScreen(page, info, 'phone-empty-textures-pending')
    await expectNoGlobeInput(page)

    firstFrame.release('day', 'night')
    await expect.poll(() => ['/earth/day.jpg', '/earth/night.jpg'].every(path => firstFrame.completed.has(path))).toBe(true)
    await globeIdle(page)
    await expectGlobeScreen(page, info, 'phone-empty-textured', { textured: true })
    await expectNoGlobeInput(page)

    await page.getByRole('button', { name: '2D 지도', exact: true }).click()
    await expect(page.locator('.flat-map svg')).toBeVisible()
    await expect(page.locator('.earth-canvas > canvas')).toHaveCount(0)
    await page.getByRole('button', { name: '3D 지구', exact: true }).click()
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }))
    await expectGlobeScreen(page, info, 'phone-empty-3d-remount', { textured: true })
    await expect(page.locator('.city-row, .globe-pin')).toHaveCount(0)
    await expectNoGlobeInput(page)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  })
})

test('a saved European city renders on cold load, reload, view changes and responsive resizes without zoom', async ({ page, firstFrame }, info) => {
  await restoreLondon(page)
  await page.goto('/', { waitUntil: 'domcontentloaded' })
  await expectGlobeScreen(page, info, 'saved-city-cold')
  await expectNoGlobeInput(page)
  await expect(page.locator('.region-tabs').getByRole('button', { name: '유럽', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('.city-hero-caption h2')).toContainText('런던')
  await expect(page.locator('.city-coordinate')).toHaveText('51.51°N')
  await expect(page.locator('.company-card h3')).toHaveText(['Aster Transit', 'Cedar Loom'])
  await expect.poll(() => ['/earth/day.jpg', '/earth/night.jpg'].every(path => firstFrame.completed.has(path))).toBe(true)

  await page.reload({ waitUntil: 'domcontentloaded' })
  await expectGlobeScreen(page, info, 'saved-city-reload', { textured: true })
  await expectNoGlobeInput(page)
  await page.getByRole('button', { name: '2D 지도', exact: true }).click()
  await expect(page.locator('.flat-map svg')).toBeVisible()
  await expect(page.locator('.earth-canvas > canvas')).toHaveCount(0)
  await page.getByRole('button', { name: '3D 지구', exact: true }).click()
  await expectGlobeScreen(page, info, 'saved-city-3d-remount', { textured: true })
  await expectNoGlobeInput(page)
  const canvas = await page.locator('.earth-canvas > canvas').elementHandle()

  // ResizeObserver changes the drawing area. No map input repairs its pixels.
  // Returning the document to the top only exposes the phone's map viewport.
  for (const [width, height] of [[768, 1024], [390, 844], [1440, 960]]) {
    await page.setViewportSize({ width, height })
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }))
    await expectGlobeScreen(page, info, `saved-city-${width}x${height}`, { textured: true })
    expect(await canvas!.evaluate(element => element === document.querySelector('.earth-canvas > canvas'))).toBe(true)
    await expect(page.locator('.city-hero-caption h2')).toContainText('런던')
    await expect(page.locator('.city-coordinate')).toHaveText('51.51°N')
    await expect(page.locator('.company-card h3')).toHaveText(['Aster Transit', 'Cedar Loom'])
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  }
  await expectNoGlobeInput(page)
})

test.describe('initially unmeasurable map and unavailable textures', () => {
  test.use({
    // Array-valued Playwright options need an explicit fixture tuple.
    expectedImageFailures: [[
      { path: '/earth/day.jpg', status: 503, count: 1 },
      { path: '/earth/night.jpg', error: 'net::ERR_FAILED', count: 1 },
    ], { scope: 'test' }],
  })

  test('first layout paints a real sphere without zoom and image errors leave that sphere visible', async ({ page, firstFrame }, info) => {
    firstFrame.hold('day', 'night')
    firstFrame.failTextures()
    await page.addInitScript(() => {
      const style = document.createElement('style')
      style.id = 'first-frame-zero-layout'
      style.textContent = '.map-viewport { width: 0 !important; height: 0 !important; overflow: hidden !important; }'
      const install = () => {
        if (!document.documentElement) return
        document.documentElement.append(style)
        observer.disconnect()
      }
      const observer = new MutationObserver(install)
      observer.observe(document, { childList: true, subtree: true })
      install()
    })
    await page.goto('/', { waitUntil: 'domcontentloaded' })
    await expect(page.locator('.earth-canvas > canvas')).toHaveCount(1)
    await expect.poll(() => page.locator('.earth-canvas').evaluate(element => ({
      width: element.clientWidth, height: element.clientHeight,
    }))).toEqual({ width: 0, height: 0 })
    await globeIdle(page)
    await expect(page.locator('.earth-canvas')).not.toHaveClass(/is-ready/)
    await info.attach('zero-layout-before-first-render', { body: await page.screenshot(), contentType: 'image/png' })
    await expectNoGlobeInput(page)

    // Restore only CSS layout. No resize event, render call, zoom, or other map
    // input is synthesized; the browser's native ResizeObserver must recover.
    await page.locator('#first-frame-zero-layout').evaluate(style => style.remove())
    await expectGlobeScreen(page, info, 'first-nonzero-layout-textures-pending')
    await expect(page.locator('.earth-canvas')).toHaveClass(/is-ready/)
    await expectNoGlobeInput(page)
    const canvas = await page.locator('.earth-canvas > canvas').elementHandle()
    firstFrame.release('day', 'night')
    await expect.poll(() => firstFrame.responses.get('/earth/day.jpg')).toBe(503)
    await expect.poll(() => firstFrame.failed.get('/earth/night.jpg')).toBe('net::ERR_FAILED')
    await globeIdle(page)
    const fallback = await expectGlobeScreen(page, info, 'texture-outage-fallback-idle')
    expect(fallback.pixels.texturedRatio).toBeLessThan(0.01)
    expect(await canvas!.evaluate(element => element === document.querySelector('.earth-canvas > canvas'))).toBe(true)
    await expect(page.getByRole('button', { name: '3D 지구', exact: true })).toHaveAttribute('aria-pressed', 'true')
    await expect(page.locator('.flat-map')).toHaveCount(0)
    await expectNoGlobeInput(page)
  })
})
