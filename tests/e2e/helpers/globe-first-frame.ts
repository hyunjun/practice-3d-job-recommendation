import { expect } from '@playwright/test'
import type { Page, TestInfo } from '@playwright/test'
import { DEFAULT_FILTERS } from '../../../shared/types'
import { publicProtocolCatalog } from '../../fixtures/public-protocol'
import { resourceCheckedTest } from './public-app'

type Resource = 'catalog' | 'day' | 'night'
type Input = { type: string; target: string; at: number }

declare global {
  interface Window {
    __orbitFirstFrameInputs: Input[]
  }
}

function gate() {
  let release!: () => void
  const promise = new Promise<void>(resolve => { release = resolve })
  return { promise, release }
}

export const firstFrameTest = resourceCheckedTest.extend<{
  firstFrame: {
    hold: (...resources: Resource[]) => void
    release: (...resources: Resource[]) => void
    emptyCatalog: () => void
    failTextures: () => void
    completed: Set<string>
    failed: Map<string, string>
    responses: Map<string, number>
  }
}>({
  firstFrame: async ({ page, context, baseURL }, use, info) => {
    const origin = new URL(baseURL!).origin
    const gates = { catalog: gate(), day: gate(), night: gate() }
    const held = new Set<Resource>()
    const completed = new Set<string>()
    const failed = new Map<string, string>(), responses = new Map<string, number>()
    const unexpected: string[] = [], errors: string[] = []
    const requests: { path: string; method: string; body: string | null }[] = []
    const fetchedAt = new Date().toISOString()
    let catalog = publicProtocolCatalog({ fetchedAt })
    let failTextures = false
    page.on('pageerror', error => errors.push(error.message))
    page.on('requestfinished', request => { completed.add(new URL(request.url()).pathname) })
    page.on('requestfailed', request => { failed.set(new URL(request.url()).pathname, request.failure()!.errorText) })
    page.on('response', response => { responses.set(new URL(response.url()).pathname, response.status()) })
    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url())
      if (url.origin !== origin) {
        unexpected.push(`External ${request.method()} ${url.href}`)
        return route.abort('blockedbyclient')
      }
      if (url.pathname.startsWith('/api/')) {
        const entry = { path: url.pathname + url.search, method: request.method(), body: request.postData() }
        requests.push(entry)
        if (entry.path !== '/api/catalog?source=public' || entry.method !== 'GET' || entry.body !== null) {
          unexpected.push(`Unexpected API ${JSON.stringify(entry)}`)
          return route.abort('blockedbyclient')
        }
        if (held.has('catalog')) await gates.catalog.promise
        return route.fulfill({ json: catalog })
      }
      const texture = url.pathname === '/earth/day.jpg' ? 'day'
        : url.pathname === '/earth/night.jpg' ? 'night' : null
      if (texture && held.has(texture)) await gates[texture].promise
      if (failTextures && texture === 'night') return route.abort('failed')
      if (failTextures && texture === 'day')
        return route.fulfill({ status: 503, contentType: 'image/jpeg', body: 'Intentional synthetic texture outage' })
      // All assets still come from the owned default synthetic fixture server.
      return route.continue()
    })
    await context.routeWebSocket('**/*', route => {
      const url = new URL(route.url())
      if (`${url.protocol === 'wss:' ? 'https:' : 'http:'}//${url.host}` === origin) route.connectToServer()
      else { unexpected.push(`External WebSocket ${url.href}`); route.close() }
    })
    await page.addInitScript(() => {
      window.__orbitFirstFrameInputs = []
      for (const type of ['pointerdown', 'pointermove', 'wheel', 'keydown', 'click']) {
        document.addEventListener(type, event => {
          const target = event.target
          if (event.isTrusted && target instanceof Element
            && target.closest('.earth-canvas, .flat-map, .map-control-stack, .region-tabs')) {
            window.__orbitFirstFrameInputs.push({
              type, target: target.closest('button')?.getAttribute('aria-label') ?? target.className.toString(),
              at: performance.now(),
            })
          }
        }, { capture: true, passive: true })
      }
    })
    try {
      await use({
        hold: (...resources) => resources.forEach(resource => held.add(resource)),
        release: (...resources) => resources.forEach(resource => {
          held.delete(resource)
          gates[resource].release()
        }),
        emptyCatalog: () => { catalog = publicProtocolCatalog({ fetchedAt, jobs: [] }) },
        failTextures: () => { failTextures = true },
        completed, failed, responses,
      })
    } finally {
      Object.values(gates).forEach(resource => resource.release())
      await context.unrouteAll({ behavior: 'wait' })
      await info.attach('first-frame-network', {
        body: Buffer.from(JSON.stringify({
          requests, completed: [...completed], failed: [...failed], responses: [...responses], unexpected, errors,
        }, null, 2)),
        contentType: 'application/json',
      })
      expect(unexpected).toEqual([])
      expect(errors).toEqual([])
    }
  },
})

export async function restoreLondon(page: Page) {
  await page.addInitScript(filters => {
    if (!localStorage.getItem('orbit.v1.profile')) localStorage.setItem('orbit.v1.profile', JSON.stringify({
      kind: 'personal', name: 'First frame QA', headline: 'Synthetic engineering profile',
      years: 5, skills: ['TypeScript', 'Python', 'PostgreSQL', 'AWS'],
      desiredRole: 'all', residence: 'GB', linkedinUrl: '',
    }))
    if (!localStorage.getItem('orbit.v1.exploration')) localStorage.setItem('orbit.v1.exploration', JSON.stringify({
      source: 'public', mapMode: 'globe', panelTab: 'cities', selectedId: 'london',
      filters: { ...filters, region: 'europe' },
    }))
  }, DEFAULT_FILTERS)
}

export async function expectNoGlobeInput(page: Page) {
  expect(await page.evaluate(() => window.__orbitFirstFrameInputs),
    'No hover, drag, zoom, reset, keyboard or region input may trigger the first globe draw').toEqual([])
}

/**
 * Read the composited screen without changing the app canvas, its WebGL context,
 * CSS, RAF, or animations. A post-composite readPixels()/toDataURL() can be blank
 * even when a preserveDrawingBuffer=false canvas is visibly painted.
 *
 * The night earth and untextured teal sphere occupy a broad cool-colored area.
 * Green labels, the green/gray backdrop, and the CSS loading planet do not.
 * These are explicit visual acceptance bounds, not the shader/projection code.
 * A negative control in the spec leaves labels/readiness intact and hides ONLY
 * the canvas, proving that they cannot satisfy this oracle.
 */
export async function sampleGlobeScreen(page: Page, hideCanvas = false) {
  const canvas = page.locator('.earth-canvas > canvas')
  await expect(canvas).toHaveCount(1)
  const state = await canvas.evaluate((element: HTMLCanvasElement) => {
    const box = element.getBoundingClientRect(), style = getComputedStyle(element)
    const left = Math.max(0, box.left), top = Math.max(0, box.top)
    const right = Math.min(innerWidth, box.right), bottom = Math.min(innerHeight, box.bottom)
    return {
      width: element.width, height: element.height,
      box: { x: box.x, y: box.y, width: box.width, height: box.height },
      clip: {
        x: Math.ceil(left + scrollX), y: Math.ceil(top + scrollY),
        width: Math.floor(right - left), height: Math.floor(bottom - top),
      },
      opacity: Number(style.opacity), display: style.display, visibility: style.visibility,
      inputs: [...window.__orbitFirstFrameInputs],
    }
  })
  expect(state.clip.width, 'The map must occupy visible screen space').toBeGreaterThan(100)
  expect(state.clip.height, 'The map must occupy visible screen space').toBeGreaterThan(100)
  const png = await page.screenshot({
    clip: state.clip, scale: 'css', animations: 'allow', caret: 'initial',
    ...(hideCanvas ? { style: '.earth-canvas > canvas { visibility: hidden !important; }' } : {}),
  })
  // Decode this screenshot into a separate offscreen 2D surface. Never read or
  // redraw the app's WebGL framebuffer as part of the visibility assertion.
  const pixels = await page.evaluate(async encoded => {
    const bytes = Uint8Array.from(atob(encoded), character => character.charCodeAt(0))
    const image = await createImageBitmap(new Blob([bytes], { type: 'image/png' }))
    const surface = new OffscreenCanvas(image.width, image.height)
    const context = surface.getContext('2d')!
    context.drawImage(image, 0, 0)
    const { data, width, height } = context.getImageData(0, 0, image.width, image.height)
    image.close()
    const rows = new Uint32Array(height), columns = new Uint32Array(width)
    let surfacePixels = 0, texturedPixels = 0
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 4
      const red = data[offset], green = data[offset + 1], blue = data[offset + 2]
      if (blue >= red + 8 && blue >= green + 2) {
        surfacePixels++
        rows[y]++
        columns[x]++
      }
      if (blue >= red + 15 && blue >= green + 8) texturedPixels++
    }
    return {
      width, height, surfacePixels, texturedPixels,
      surfaceRatio: surfacePixels / (width * height),
      texturedRatio: texturedPixels / (width * height),
      broadRows: rows.filter(count => count >= width * 0.2).length / height,
      broadColumns: columns.filter(count => count >= height * 0.2).length / width,
    }
  }, png.toString('base64'))
  return { state, pixels, png }
}

export async function expectGlobeScreen(
  page: Page, info: TestInfo, label: string, options: { textured?: boolean } = {},
) {
  let last: Awaited<ReturnType<typeof sampleGlobeScreen>> | undefined
  const history: unknown[] = []
  try {
    await expect.poll(async () => {
      last = await sampleGlobeScreen(page)
      history.push({ state: last.state, pixels: last.pixels })
      const { pixels, state } = last
      return {
        displayed: state.opacity >= 0.95 && state.display !== 'none' && state.visibility === 'visible',
        surface: pixels.surfaceRatio > 0.08,
        broad: pixels.broadRows > 0.25 && pixels.broadColumns > 0.25,
        textured: !options.textured || pixels.texturedRatio > 0.04,
      }
    }, {
      timeout: 4000, intervals: [100, 250, 500],
      message: `${label}: visible WebGL sphere pixels must cover >8% of the screen crop and span both axes without map input`,
    }).toEqual({ displayed: true, surface: true, broad: true, textured: true })
  } finally {
    await info.attach(`${label}-pixels`, {
      body: Buffer.from(JSON.stringify({ label, textured: options.textured ?? false, history }, null, 2)),
      contentType: 'application/json',
    })
    if (last) await info.attach(`${label}-screen`, { body: last.png, contentType: 'image/png' })
  }
  return last!
}

/** Wait in real browser time; this does not invalidate the map or emulate input. */
export async function globeIdle(page: Page) {
  await page.evaluate(() => new Promise<void>(resolve => setTimeout(resolve, 1200)))
}
