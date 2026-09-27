import { expect } from '@playwright/test'
import type { Locator, Page, TestInfo } from '@playwright/test'
import type { Catalog, Filters, SavedJob } from '../../../shared/types'
import type { ObservationHistory } from '../../../shared/catalog-observations'
import {
  REGIONAL_FILTERS, REGIONAL_NOTE, REGIONAL_NOW, REGIONAL_PROFILE, regionalThirtyFiveCatalog,
} from '../../fixtures/regional-coverage'
import { expectInitialCatalogRequest, watchApiRequests } from './api-requests'
import { resourceCheckedTest } from './public-app'
import { waitForSavedCommit } from './saved-store'

interface OpenOptions {
  catalog?: Catalog
  filters?: Partial<Filters>
  selectedId?: string | null
  panelTab?: 'cities' | 'unmapped' | 'remote'
  mapMode?: 'flat' | 'globe'
  saved?: SavedJob[]
}
interface RegionalHarness {
  traffic: ReturnType<typeof watchApiRequests>
  open: (options?: OpenOptions) => Promise<{ attempts: number }>
  respond: (catalog: Catalog) => void
  history: (history: ObservationHistory) => void
  expectPaths: (initialAttempts: number, following?: string[]) => Promise<void>
}

/** Synthetic HTTP inputs; the browser uses its native catalog Worker and UI.
 * No expected result is calculated with a product matching/upgrading function. */
export const regionalTest = resourceCheckedTest.extend<{ regional: RegionalHarness }>({
  regional: async ({ page, context, baseURL }, use, info) => {
    const origin = new URL(baseURL!).origin
    let catalog = regionalThirtyFiveCatalog()
    let history: ObservationHistory | undefined
    const traffic = watchApiRequests(page)
    const external: string[] = [], unexpected: string[] = [], errors: string[] = []
    const api: { path: string; method: string; body: string | null }[] = []
    page.on('pageerror', error => errors.push(error.message))
    context.on('request', request => {
      const url = new URL(request.url())
      if (url.pathname.startsWith('/api/')) api.push({
        path: url.pathname + url.search, method: request.method(), body: request.postData(),
      })
    })
    await context.route('**/*', route => {
      if (new URL(route.request().url()).origin === origin) return route.fallback()
      external.push(route.request().url())
      return route.abort('blockedbyclient')
    })
    await context.route('**/api/**', route => {
      const request = route.request(), url = new URL(request.url())
      const path = url.pathname + url.search
      if (request.method() === 'GET' && request.postData() === null) {
        if (path === '/api/catalog?source=public' || path === '/api/catalog?source=public&refresh=1')
          return route.fulfill({ json: catalog })
        if (path === '/api/observations' && history) return route.fulfill({ json: history })
      }
      unexpected.push(`${request.method()} ${url.href}`)
      return route.abort('blockedbyclient')
    })
    await page.clock.setFixedTime(new Date(REGIONAL_NOW))
    try {
      await use({
        traffic,
        respond(value) { catalog = value },
        history(value) { history = value },
        async open(options = {}) {
          if (options.catalog) catalog = options.catalog
          await page.addInitScript(({ origin, profile, exploration, saved }) => {
            if (location.origin !== origin || sessionStorage.getItem('regional70-seeded')) return
            localStorage.setItem('orbit.v1.profile', JSON.stringify(profile))
            localStorage.setItem('orbit.v1.exploration', JSON.stringify(exploration))
            localStorage.setItem('orbit.v1.saved', JSON.stringify(saved))
            sessionStorage.setItem('regional70-seeded', 'true')
          }, {
            origin, profile: REGIONAL_PROFILE, saved: options.saved ?? [],
            exploration: {
              source: 'public', selectedId: options.selectedId ?? null,
              panelTab: options.panelTab ?? 'cities', mapMode: options.mapMode ?? 'flat',
              citySort: 'companies', light: false,
              filters: { ...REGIONAL_FILTERS, ...options.filters },
            },
          })
          await page.goto('/')
          const initial = await expectInitialCatalogRequest(page, traffic)
          await expect.poll(() => page.workers().filter(worker => /catalog\.worker/.test(worker.url())).length).toBe(1)
          await waitForSavedCommit(page)
          return initial
        },
        async expectPaths(initialAttempts, following = []) {
          await expect.poll(() => traffic.requests.filter(request => request.state === 'pending')).toEqual([])
          expect(traffic.requests.map(request => {
            const url = new URL(request.url)
            return url.pathname + url.search
          })).toEqual([...Array<string>(initialAttempts).fill('/api/catalog?source=public'), ...following])
        },
      })
    } finally {
      const visible = await page.evaluate(() => ({
        exploration: JSON.parse(localStorage.getItem('orbit.v1.exploration') ?? '{}'),
        counts: [...document.querySelectorAll('.map-stats strong')].map(element => element.textContent),
        titles: [...document.querySelectorAll('.mini-job-title, .saved-title')].map(element => element.textContent),
      })).catch(() => ({ pageClosed: true }))
      await info.attach('regional70-observation', {
        body: Buffer.from(JSON.stringify({
          synthetic: true, api, traffic: traffic.requests, external, unexpected, errors, visible,
          workers: page.workers().map(worker => worker.url()),
        }, null, 2)),
        contentType: 'application/json',
      })
    }
    expect(external).toEqual([])
    expect(unexpected).toEqual([])
    expect(errors).toEqual([])
    for (const request of api) {
      expect(request.method).toBe('GET')
      expect(request.body).toBeNull()
    }
    for (const privateValue of [REGIONAL_NOTE, REGIONAL_PROFILE.name, 'PRIVATE_REGIONAL70_MISSING', 'greenhouse-regional-cedar-partial-baltic'])
      expect(JSON.stringify(api)).not.toContain(privateValue)
  },
})

export const regionalSearch = (page: Page) => page.getByRole('textbox', { name: '도시, 회사 또는 포지션 검색', exact: true })
export const regionalRegion = (page: Page, name: string) => page.locator('.region-tabs').getByRole('button', { name, exact: true })
export const regionalTab = (page: Page, name: string) => page.locator('.results-tabs').getByRole('button', { name: new RegExp(`^${name}`) })
export const regionalClose = (page: Page) => page.getByRole('button', { name: '닫기', exact: true }).click()
export const regionalExploration = (page: Page) => page.evaluate(() => JSON.parse(localStorage.getItem('orbit.v1.exploration') ?? '{}'))

export async function regionalTitles(page: Page, expected: string[]) {
  const more = page.getByRole('button', { name: /^전체 \d+개 공고 보기$/ })
  await expect(page.locator('.panel-container')).toHaveAttribute('aria-busy', 'false')
  // Worker results can mount the collapsed card after the input event. Expand
  // the actual arriving results, rather than inspect the toggle just once.
  await expect.poll(async () => {
    while (await more.count()) await more.first().click()
    return (await page.locator('.mini-job-title').allTextContents()).sort()
  }).toEqual(expected)
  await expect(page.locator('.mini-job-title')).toHaveCount(expected.length)
}

/** Observe composited earth pixels, including when a centered cluster keeps
 * the same label and screen position during a further zoom. */
export async function regionalZoomCluster(page: Page, cluster: Locator, info: TestInfo, step: number) {
  const canvas = page.locator('.earth-canvas > canvas')
  const capture = async () => ({
    png: await canvas.screenshot({ animations: 'allow', scale: 'css' }),
    pins: await page.locator('.globe-pin').evaluateAll(elements => elements.map(element => ({
      label: element.getAttribute('aria-label'), transform: (element as HTMLElement).style.transform,
    }))),
  })
  // Establish hover before taking the baseline so pin highlighting cannot
  // serve as evidence of the subsequent zoom.
  await cluster.hover()
  const before = await capture()
  let after: Awaited<ReturnType<typeof capture>> | undefined
  const observations: number[] = []
  await info.attach(`nz-zoom-${step}-before`, { body: before.png, contentType: 'image/png' })
  await cluster.click()
  try {
    await expect.poll(async () => {
      after = await capture()
      const changed = await page.evaluate(async ([first, second]) => {
        const decode = async (encoded: string) => {
          const bytes = Uint8Array.from(atob(encoded), character => character.charCodeAt(0))
          const image = await createImageBitmap(new Blob([bytes], { type: 'image/png' }))
          const surface = new OffscreenCanvas(image.width, image.height)
          const context = surface.getContext('2d')!
          context.drawImage(image, 0, 0)
          image.close()
          return context.getImageData(0, 0, surface.width, surface.height)
        }
        const [a, b] = await Promise.all([decode(first), decode(second)])
        if (a.width !== b.width || a.height !== b.height) throw new Error('Zoom must preserve the map viewport')
        let changed = 0
        for (let i = 0; i < a.data.length; i += 4) {
          // Cool earth pixels exclude the green labels, hover outline and
          // backdrop. Compare a separate screenshot surface, never WebGL state.
          const earthBefore = a.data[i + 2] >= a.data[i] + 8 && a.data[i + 2] >= a.data[i + 1] + 2
          const earthAfter = b.data[i + 2] >= b.data[i] + 8 && b.data[i + 2] >= b.data[i + 1] + 2
          if (earthBefore && earthAfter && Math.max(
            Math.abs(a.data[i] - b.data[i]), Math.abs(a.data[i + 1] - b.data[i + 1]),
            Math.abs(a.data[i + 2] - b.data[i + 2]),
          ) >= 12) changed++
        }
        return changed
      }, [before.png.toString('base64'), after.png.toString('base64')])
      observations.push(changed)
      return changed
    }, { message: 'Each cluster click must visibly change more than 200 earth pixels before the next click' }).toBeGreaterThan(200)
  } finally {
    await info.attach(`nz-zoom-${step}-observed`, {
      body: Buffer.from(JSON.stringify({ before: before.pins, after: after?.pins, changedEarthPixels: observations }, null, 2)),
      contentType: 'application/json',
    })
    if (after) await info.attach(`nz-zoom-${step}-after`, { body: after.png, contentType: 'image/png' })
  }
}
