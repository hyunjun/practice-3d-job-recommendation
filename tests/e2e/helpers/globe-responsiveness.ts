import { expect } from '@playwright/test'
import type { Page } from '@playwright/test'
import { DEFAULT_FILTERS } from '../../../shared/types'
import {
  GLOBE_COLLECTION_ID, GLOBE_PROFILE, GLOBE_TIME,
  globeCatalog, globeSnapshot, globeUpdate,
} from '../../fixtures/globe-responsiveness'

export interface GlobeTraffic {
  path: string
  method: string
  body: string | null
  prefer: string | undefined
}

/** Own-origin assets plus authored public protocol responses; no upstream access. */
export async function installGlobeStream(page: Page, origin: string) {
  const unexpected: string[] = []
  const requests: GlobeTraffic[] = []
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  let released = 0
  const release: (() => void)[] = []
  const gates = [1, 2].map(stage => new Promise<void>(resolve => { release[stage] = resolve }))
  // Serialize before any timed browser interval, identically for before/after.
  const initial = JSON.stringify(globeSnapshot())
  const updates = [JSON.stringify(globeUpdate(1)), JSON.stringify(globeUpdate(2))]
  const final = JSON.stringify(globeCatalog(2))
  await page.context().route('**/*', async route => {
    const request = route.request()
    const url = new URL(request.url())
    if (url.origin !== origin) {
      unexpected.push(`External ${request.method()} ${url.href}`)
      return route.abort('blockedbyclient')
    }
    if (!url.pathname.startsWith('/api/')) return route.continue()
    requests.push({
      path: url.pathname + url.search, method: request.method(), body: request.postData(),
      prefer: request.headers().prefer,
    })
    if (request.method() !== 'GET' || request.postData() !== null) {
      unexpected.push(`Unexpected write ${request.method()} ${url.href}`)
      return route.abort('blockedbyclient')
    }
    if (url.pathname + url.search === '/api/catalog?source=public') {
      return route.fulfill({
        status: released === 2 ? 200 : 202, contentType: 'application/json',
        headers: { 'Retry-After': '1' }, body: released === 2 ? final : initial,
      })
    }
    const stage = url.searchParams.get('after') === '1' ? 1 : url.searchParams.get('after') === '2' ? 2 : 0
    if (stage && url.pathname + url.search === `/api/catalog/progress?id=${GLOBE_COLLECTION_ID}&after=${stage}`) {
      await gates[stage - 1]
      return route.fulfill({ contentType: 'application/json', headers: { 'Retry-After': '1' }, body: updates[stage - 1] })
    }
    unexpected.push(`Unexpected API ${request.method()} ${url.href}`)
    return route.abort('blockedbyclient')
  })
  await page.context().routeWebSocket('**/*', route => {
    const url = new URL(route.url())
    if (`${url.protocol === 'wss:' ? 'https:' : 'http:'}//${url.host}` !== origin) {
      unexpected.push(`External WebSocket ${url.href}`)
      route.close()
    } else route.connectToServer()
  })
  return {
    requests, unexpected, errors,
    release(stage: 1 | 2) {
      if (stage !== released + 1) throw new Error(`Expected stream stage ${released + 1}, received ${stage}`)
      released = stage
      release[stage]()
    },
    dispose() { release[1](); release[2]() },
  }
}

export async function openGlobe(page: Page, options: { query?: string; selectedId?: string | null } = {}) {
  // Playwright's clock also replaces RAF. Freeze only Date so real WebGL frame
  // pacing, performance.now(), input timestamps, and polling timers stay native.
  await page.addInitScript({ content: `(() => {
    const NativeDate = Date;
    const fixed = ${Date.parse(GLOBE_TIME)};
    window.Date = new Proxy(NativeDate, {
      construct(target, args, newTarget) {
        return Reflect.construct(target, args.length ? args : [fixed], newTarget);
      },
      apply() { return new NativeDate(fixed).toString(); },
      get(target, key, receiver) {
        return key === 'now' ? () => fixed : Reflect.get(target, key, receiver);
      }
    });
  })();` })
  await page.addInitScript(({ profile, filters, selectedId }) => {
    if (!localStorage.getItem('orbit.v1.profile'))
      localStorage.setItem('orbit.v1.profile', JSON.stringify(profile))
    if (!localStorage.getItem('orbit.v1.exploration'))
      localStorage.setItem('orbit.v1.exploration', JSON.stringify({
        source: 'public', mapMode: 'globe', panelTab: 'cities', selectedId, filters,
      }))
  }, {
    profile: GLOBE_PROFILE, filters: { ...DEFAULT_FILTERS, query: options.query ?? '' },
    selectedId: options.selectedId ?? null,
  })
  await page.goto('/')
  await expect(page.getByRole('button', { name: '3D 지구', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('.earth-canvas')).toHaveClass(/is-ready/)
  await expect(page.locator('.earth-canvas > canvas')).toBeVisible()
  await expect(page.locator('.flat-map')).toHaveCount(0)
  await expect(page.locator('.globe-pin').first()).toBeVisible()
  await page.evaluate(async () => { await document.fonts.ready })
}

export const globeRegion = (page: Page) => page.getByRole('region', { name: /^3D 기회 지도\./ })
export const globeHeading = (page: Page) => page.locator('.city-hero-caption h2')
export const globeCity = (page: Page, name: string, count: number) =>
  page.getByRole('button', { name: `${name}, 추천 회사 ${count}곳, 회사 보기`, exact: true })

export async function globeFrames(page: Page, count = 2) {
  await page.evaluate(async frames => {
    for (let frame = 0; frame < frames; frame++)
      await new Promise<number>(resolve => requestAnimationFrame(resolve))
  }, count)
}

/** Inspect actual projected DOM geometry, without importing camera/projection code. */
export async function globePins(page: Page) {
  return page.locator('.globe-pin').evaluateAll(elements => elements.map(element => {
    const bounds = element.getBoundingClientRect()
    return {
      label: element.getAttribute('aria-label'), text: element.textContent,
      x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height,
      transform: (element as HTMLElement).style.transform,
    }
  }))
}

export function expectGlobeTraffic(state: Awaited<ReturnType<typeof installGlobeStream>>) {
  expect(state.unexpected).toEqual([])
  expect(state.errors).toEqual([])
  expect(state.requests.filter(request => request.path.startsWith('/api/catalog/progress?')).map(request => request.path))
    .toEqual([
      `/api/catalog/progress?id=${GLOBE_COLLECTION_ID}&after=1`,
      `/api/catalog/progress?id=${GLOBE_COLLECTION_ID}&after=2`,
    ])
  for (const request of state.requests) {
    expect(request.method).toBe('GET')
    expect(request.body).toBeNull()
    if (request.path === '/api/catalog?source=public') expect(request.prefer).toBe('respond-async')
  }
}
