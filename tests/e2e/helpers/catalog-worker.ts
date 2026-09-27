import { expect } from '@playwright/test'
import type { Page, Route, TestInfo } from '@playwright/test'
import type { Filters, SavedJob } from '../../../shared/types'
import {
  CATALOG_WORKER_COLLECTION, CATALOG_WORKER_FILTERS, CATALOG_WORKER_NOTE,
  CATALOG_WORKER_PROFILE, CATALOG_WORKER_TIME, catalogWorkerSnapshot,
} from '../../fixtures/catalog-worker'
import { watchApiRequests } from './api-requests'
import { resourceCheckedTest } from './public-app'

type Reply = (route: Route) => void | Promise<void>
interface OpenOptions {
  mapMode?: 'flat' | 'globe'
  selectedId?: 'london' | 'berlin' | null
  filters?: Partial<Filters>
  saved?: SavedJob[]
  view?: 'explore' | 'saved'
}

export interface CatalogWorkerHarness {
  traffic: ReturnType<typeof watchApiRequests>
  respond: (reply: Reply) => void
  open: (options?: OpenOptions) => Promise<void>
  takeProgress: (after: 1 | 2) => Promise<Route>
  expectPaths: (initialAttempts: number, following: string[]) => Promise<void>
}

export const catalogWorkerTest = resourceCheckedTest.extend<{ catalogWorker: CatalogWorkerHarness }>({
  catalogWorker: async ({ page, context, baseURL }, use, info) => {
    const origin = new URL(baseURL!).origin
    const traffic = watchApiRequests(page)
    const external: string[] = [], unexpected: string[] = [], errors: string[] = []
    const contextApi: { path: string; method: string; body: string | null }[] = []
    const monitors: Route[] = []
    let reply: Reply = route => route.fulfill({
      status: 202, headers: { 'Retry-After': '1' }, json: catalogWorkerSnapshot(),
    })
    page.on('pageerror', error => errors.push(error.message))
    context.on('request', request => {
      const url = new URL(request.url())
      if (url.pathname.startsWith('/api/')) contextApi.push({
        path: url.pathname + url.search, method: request.method(), body: request.postData(),
      })
    })
    // Worker-initiated requests are guarded at BrowserContext scope as well.
    // The underlying owned server is synthetic even if an interception regresses.
    await context.route('**/*', route => {
      const url = new URL(route.request().url())
      if (url.origin === origin) return route.fallback()
      external.push(url.href)
      return route.abort('blockedbyclient')
    })
    await context.route('**/api/**', route => {
      const request = route.request(), url = new URL(request.url())
      const path = url.pathname + url.search
      if (url.origin === origin && request.method() === 'GET' && request.postData() === null) {
        if (path === '/api/catalog?source=public' || path === '/api/catalog?source=public&refresh=1')
          return reply(route)
        if (path === `/api/catalog/progress?id=${CATALOG_WORKER_COLLECTION}&after=1`
          || path === `/api/catalog/progress?id=${CATALOG_WORKER_COLLECTION}&after=2`) {
          monitors.push(route)
          return
        }
      }
      unexpected.push(`${request.method()} ${url.href}`)
      return route.abort('blockedbyclient')
    })
    // Deliberately differs from the host wall clock. A worker must receive the
    // main-thread time explicitly; page.clock does not virtualize worker Date.
    await page.clock.install({ time: new Date(CATALOG_WORKER_TIME) })
    const harness: CatalogWorkerHarness = {
      traffic,
      respond(handler) { reply = handler },
      async open(options = {}) {
        await page.addInitScript(({ profile, exploration, saved }) => {
          if (sessionStorage.getItem('catalog-worker-seeded')) return
          localStorage.setItem('orbit.v1.profile', JSON.stringify(profile))
          localStorage.setItem('orbit.v1.exploration', JSON.stringify(exploration))
          if (saved.length) localStorage.setItem('orbit.v1.saved', JSON.stringify(saved))
          sessionStorage.setItem('catalog-worker-seeded', 'true')
        }, {
          profile: CATALOG_WORKER_PROFILE,
          exploration: {
            source: 'public', selectedId: options.selectedId === undefined ? 'london' : options.selectedId,
            mapMode: options.mapMode ?? 'flat', panelTab: 'cities', citySort: 'companies', light: false,
            filters: { ...CATALOG_WORKER_FILTERS, ...options.filters },
          },
          saved: options.saved ?? [],
        })
        await page.goto(options.view === 'saved' ? '/#saved' : '/')
        if (options.mapMode === 'globe') await expect(page.locator('.earth-canvas')).toHaveClass(/is-ready/)
      },
      async takeProgress(after) {
        if (!monitors.length) await page.clock.fastForward(1100)
        await expect.poll(() => monitors.length).toBe(1)
        const route = monitors.shift()!
        expect(route.request().url()).toBe(`${origin}/api/catalog/progress?id=${CATALOG_WORKER_COLLECTION}&after=${after}`)
        return route
      },
      async expectPaths(initialAttempts, following) {
        await expect.poll(() => traffic.requests.filter(request => request.state === 'pending')).toEqual([])
        expect(traffic.requests.map(request => {
          const url = new URL(request.url)
          return url.pathname + url.search
        })).toEqual([...Array<string>(initialAttempts).fill('/api/catalog?source=public'), ...following])
        expect(contextApi).toEqual(traffic.requests.map(request => ({
          path: new URL(request.url).pathname + new URL(request.url).search,
          method: request.method, body: request.body,
        })))
      },
    }
    try {
      await use(harness)
    } finally {
      await recordCatalogWorkerEvidence(page, info, { requests: traffic.requests, contextApi, external, unexpected, errors })
    }
    for (const request of contextApi) {
      expect(request.method).toBe('GET')
      expect(request.body).toBeNull()
    }
    for (const privateValue of [
      CATALOG_WORKER_PROFILE.name, CATALOG_WORKER_PROFILE.headline, CATALOG_WORKER_PROFILE.linkedinUrl,
      CATALOG_WORKER_NOTE, 'PRIVATE_CATALOG_WORKER_QUERY', 'greenhouse-catalog-worker-aster-atlas',
    ]) expect(JSON.stringify(contextApi)).not.toContain(privateValue)
    expect(external).toEqual([])
    expect(unexpected).toEqual([])
    expect(errors).toEqual([])
  },
})

async function recordCatalogWorkerEvidence(page: Page, info: TestInfo, network: object) {
  const visible = await page.evaluate(() => ({
    query: document.querySelector<HTMLInputElement>('.global-search input')?.value,
    summary: document.querySelector('.active-filter-summary')?.textContent,
    city: document.querySelector('.city-hero-caption h2')?.textContent,
    cityCounts: [...document.querySelectorAll('.city-detail-count strong')].map(element => element.textContent),
    titles: [...document.querySelectorAll('.mini-job-title, .saved-title')].map(element => element.textContent),
    progress: [...document.querySelectorAll('progress')].map(element => ({ value: element.value, max: element.max })),
    exploration: JSON.parse(localStorage.getItem('orbit.v1.exploration') ?? '{}'),
  })).catch(() => ({ unavailable: 'Page closed before evidence collection.' }))
  await info.attach('catalog-worker-observation', {
    body: Buffer.from(JSON.stringify({
      synthetic: true, boundary: 'real public HTTP transport and browser UI', network, visible,
    }, null, 2)),
    contentType: 'application/json',
  })
}

export const catalogWorkerQuery = (page: Page) => page.getByRole('textbox', { name: '도시, 회사 또는 포지션 검색', exact: true })
export const catalogWorkerClose = (page: Page) => page.getByRole('button', { name: '닫기', exact: true }).click()
export const catalogWorkerExploration = (page: Page) => page.evaluate(() => JSON.parse(localStorage.getItem('orbit.v1.exploration') ?? '{}'))

export async function expectCatalogWorkerCompanies(page: Page, expected: { company: string; titles: string[] }[]) {
  await expect(page.locator('.company-card h3')).toHaveText(expected.map(group => group.company))
  for (const [index, group] of expected.entries()) {
    const card = page.locator('.company-card').nth(index)
    if (group.titles.length > 1) {
      const more = card.locator('.more-jobs')
      await expect(more).toHaveAttribute('aria-expanded', /^(true|false)$/)
      if (await more.getAttribute('aria-expanded') === 'false') await more.click()
    }
    await expect(card.locator('.mini-job-title')).toHaveText(group.titles)
  }
}

export async function expectCatalogWorkerMetadata(page: Page, expected: {
  jobs: string
  boardCounts: [string, string, string]
  times: [string, string, string]
}) {
  await page.locator('.data-status-button').click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.locator('.coverage-stats strong')).toHaveText(['2', '3', expected.jobs])
  await expect(dialog.locator('.collection-health dd')).toHaveText([`${expected.jobs}개 공고`, '0개 공고', '0개'])
  const details = dialog.locator('.board-details')
  if (await details.getAttribute('open') === null) await details.locator('summary').click()
  await expect(dialog.locator('.board-name strong')).toHaveText(['Aster QA Labs', 'Birch QA Systems', 'Cedar QA Works'])
  await expect(dialog.locator('.board-name .board-ok')).toHaveText(expected.boardCounts)
  for (const [index, time] of expected.times.entries())
    await expect(dialog.locator('.board-row').nth(index).locator('time')).toHaveAttribute('datetime', time)
  await expect(dialog.locator('.data-loading, .collection-progress, .form-error')).toHaveCount(0)
  await expect(dialog).not.toContainText('Invalid Date')
  await catalogWorkerClose(page)
}
