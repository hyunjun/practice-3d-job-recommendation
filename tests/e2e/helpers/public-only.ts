import { expect } from '@playwright/test'
import type { BrowserContext, Page, Request, Route } from '@playwright/test'
import type { SavedJob } from '../../../shared/types'
import { NOW, PROFILE } from '../../fixtures/public-only-contract'
import { readServerMode } from './api-requests'

export type Reply = { status?: number; json: unknown } | { abort: 'internetdisconnected' }
type Traffic = { path: string; method: string; body: string | null; state: string; status: number | null; error: string | null }
export const ordinary = '/api/catalog?source=public'
export const forced = '/api/catalog?source=public&refresh=1'

export function deferredReply() {
  let resolve!: (reply: Reply) => void
  const promise = new Promise<Reply>(done => { resolve = done })
  return { promise, resolve }
}

/**
 * Uses a fresh Playwright context and an already-owned loopback app.
 * This harness never starts a server. All API requests are intercepted;
 * an unexpected API or external resource is blocked and fails the assertion.
 * Route interception DISABLES browser HTTP cache: this is not HTTP-cache proof.
 */
export async function installHarness(page: Page, baseURL: string, initial: Reply | Promise<Reply>) {
  const origin = new URL(baseURL).origin
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(origin).hostname) || new URL(origin).port === '8787')
    throw new Error('Use an explicitly owned loopback verification app, never port 8787.')
  const context = page.context()
  const traffic: Traffic[] = [], unexpected: string[] = [], errors: string[] = []
  const records = new Map<Request, Traffic>()
  let reply = initial
  // Resolve only when checking completed exploration traffic. A direct saved
  // flow never probes health. Runner APIRequestContext traffic is separate from
  // the observed browser application requests, including canceled attempts.
  let mode: ReturnType<typeof readServerMode> | undefined
  const serverMode = () => mode ??= readServerMode(context.request, new URL('/api/health', origin).href)
  const attach = (target: Page) => target.on('pageerror', error => errors.push(error.message))
  context.pages().forEach(attach)
  context.on('page', attach)
  context.on('request', request => {
    const url = new URL(request.url())
    if (!url.pathname.startsWith('/api/')) return
    const item: Traffic = { path: url.pathname + url.search, method: request.method(), body: request.postData(), state: 'pending', status: null, error: null }
    records.set(request, item)
    traffic.push(item)
  })
  context.on('response', response => { const item = records.get(response.request()); if (item) item.status = response.status() })
  context.on('requestfinished', request => { const item = records.get(request); if (item) item.state = 'finished' })
  context.on('requestfailed', request => {
    const item = records.get(request)
    if (item) { item.state = 'failed'; item.error = request.failure()?.errorText ?? null }
  })
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url())
    if (url.origin !== origin) {
      unexpected.push(request.url())
      return route.abort('blockedbyclient')
    }
    if (url.pathname === '/__stage65_seed')
      return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Synthetic storage seed</title>' })
    if (!url.pathname.startsWith('/api/')) return route.continue()
    if (request.method() !== 'GET' || ![ordinary, forced].includes(url.pathname + url.search)) {
      unexpected.push(`${request.method()} ${url.pathname}${url.search}`)
      return route.abort('blockedbyclient')
    }
    const selected = await reply
    // A development StrictMode replay can cancel the first held request.
    if (records.get(request)?.error === 'net::ERR_ABORTED') return
    await deliver(route, selected)
  })
  await page.clock.setFixedTime(new Date(NOW))
  return {
    origin, traffic, unexpected, errors, serverMode,
    setReply(next: Reply | Promise<Reply>) { reply = next },
    catalog: () => traffic.filter(item => item.path.startsWith('/api/catalog?')),
  }
}
async function deliver(route: Route, reply: Reply) {
  if ('abort' in reply) await route.abort(reply.abort)
  else await route.fulfill({ status: reply.status ?? 200, json: reply.json })
}
export type Harness = Awaited<ReturnType<typeof installHarness>>

/** One explicit seed navigation; reload/new-page tests do not silently reseed. */
export async function seed(page: Page, origin: string, options: {
  exploration?: unknown; saved?: unknown[]; compare?: string[]; store?: 'localStorage' | 'indexedDB-v1'
  entries?: unknown[]; meta?: Record<string, unknown>
} = {}) {
  await page.goto(`${origin}/__stage65_seed`)
  await page.evaluate(async ({ profile, options }) => {
    localStorage.setItem('orbit.v1.profile', JSON.stringify(profile))
    if (options.exploration) localStorage.setItem('orbit.v1.exploration', JSON.stringify(options.exploration))
    if (options.compare) localStorage.setItem('orbit.v1.compare', JSON.stringify(options.compare))
    if (!options.saved && !options.entries) return
    if (options.store !== 'indexedDB-v1') {
      localStorage.setItem('orbit.v1.saved', JSON.stringify(options.saved))
      return
    }
    // Literal PRE-Stage65 schema, with its existing migration marker. This
    // catches upgrades that only handle a never-migrated localStorage array.
    await new Promise<void>((resolve, reject) => {
      const opening = indexedDB.open('orbit-saved-opportunities', 1)
      opening.onupgradeneeded = () => {
        opening.result.createObjectStore('records', { keyPath: 'id' })
        opening.result.createObjectStore('meta', { keyPath: 'key' })
      }
      opening.onerror = () => reject(opening.error)
      opening.onsuccess = () => {
        const db = opening.result, tx = db.transaction(['records', 'meta'], 'readwrite')
        const entries = options.entries ?? options.saved!.map((value, index) => {
          const record = value as { job: { id: string } }
          return { id: record.job.id, order: options.saved!.length - index, record }
        })
        entries.forEach(entry => { tx.objectStore('records').put(entry) })
        tx.objectStore('meta').put(options.meta ?? { key: 'state', nextOrder: entries.length + 1, legacyDigest: null })
        tx.oncomplete = () => { db.close(); resolve() }
        tx.onabort = () => { db.close(); reject(tx.error) }
      }
    })
  }, { profile: PROFILE, options })
}

export async function committed(page: Page): Promise<SavedJob[]> {
  await expect(page.locator('.main-nav button').filter({ hasText: '저장한 기회' })).toHaveAttribute('aria-busy', 'false')
  return page.evaluate(() => new Promise<SavedJob[]>((resolve, reject) => {
    const opening = indexedDB.open('orbit-saved-opportunities')
    opening.onupgradeneeded = () => { opening.transaction?.abort(); reject(new Error('App has not initialized saved storage')) }
    opening.onerror = () => reject(opening.error)
    opening.onsuccess = () => {
      const db = opening.result, tx = db.transaction('records', 'readonly')
      const read = tx.objectStore('records').getAll()
      tx.oncomplete = () => { db.close(); resolve(read.result.sort((a, b) => b.order - a.order).map(entry => entry.record)) }
      tx.onabort = () => { db.close(); reject(tx.error) }
    }
  }))
}

export async function rawSavedDatabase(page: Page): Promise<{ entries: unknown[]; meta: Record<string, unknown> }> {
  return page.evaluate(() => new Promise((resolve, reject) => {
    const opening = indexedDB.open('orbit-saved-opportunities')
    opening.onupgradeneeded = () => { opening.transaction?.abort(); reject(new Error('Missing synthetic saved database')) }
    opening.onerror = () => reject(opening.error)
    opening.onsuccess = () => {
      const db = opening.result, tx = db.transaction(['records', 'meta'], 'readonly')
      const entries = tx.objectStore('records').getAll(), meta = tx.objectStore('meta').get('state')
      tx.oncomplete = () => { db.close(); resolve({ entries: entries.result, meta: meta.result }) }
      tx.onabort = () => { db.close(); reject(tx.error) }
    }
  }))
}

/** Unlike the initial-request oracle, saved-only means zero attempted requests,
 * including cancellations. Do not mask a forbidden lazy-page fetch as StrictMode. */
export function expectSavedOnlyTraffic(h: Harness) {
  expect(h.traffic).toEqual([])
  expect(h.unexpected).toEqual([])
  expect(h.errors).toEqual([])
}

export async function noSampleChoice(page: Page) {
  await expect(page.getByRole('button', { name: /^(샘플 탐색|샘플로 탐색)/ })).toHaveCount(0)
  await expect(page.getByText('가상의 공고 · 실제 회사 채용 페이지', { exact: true })).toHaveCount(0)
  await expect(page.locator('.app-footer')).not.toContainText('DEMO WORKSPACE')
  // A sample PROFILE is a separate product contract, not a fictional posting.
}
export async function noResults(page: Page) {
  await expect(page.locator('.city-row, .company-card, .mini-job-title, .flat-marker, .globe-pin, .comparison-city')).toHaveCount(0)
}

/** Record observable DOM insertions while a first public response is withheld. */
export async function guardInitialPaint(page: Page) {
  await page.addInitScript(() => {
    Reflect.set(window, '__stage65Paint', { released: false, violations: [] as string[] })
    new MutationObserver(() => {
      const state = Reflect.get(window, '__stage65Paint')
      if (state.released || state.violations.length >= 4) return
      const result = document.querySelector('.city-row, .company-card, .mini-job-title, .comparison-city')
      if (result) state.violations.push(result.textContent?.slice(0, 160) ?? 'result inserted')
    }).observe(document, { childList: true, subtree: true })
  })
}
export async function releasePaint(page: Page) {
  expect(await page.evaluate(() => Reflect.get(window, '__stage65Paint').violations)).toEqual([])
  await page.evaluate(() => { Reflect.get(window, '__stage65Paint').released = true })
}

export async function expectTraffic(h: Harness, expected: { path: string; status: number | null; error?: string }[], boots = 1) {
  await expect.poll(() => h.traffic.filter(item => item.state === 'pending').length).toBe(0)
  expect(h.unexpected).toEqual([])
  expect(h.errors).toEqual([])
  for (const item of h.traffic) {
    expect(item.method).toBe('GET')
    expect(item.body).toBeNull()
    expect([ordinary, forced]).toContain(item.path)
  }
  const cancellations = h.traffic.filter(item => item.error === 'net::ERR_ABORTED')
  const mode = await h.serverMode()
  expect(['development', 'production']).toContain(mode)
  expect(cancellations.length).toBeLessThanOrEqual(mode === 'development' ? boots : 0)
  for (const item of cancellations) expect(item.path).toBe(ordinary)
  expect(h.traffic.filter(item => item.error !== 'net::ERR_ABORTED').map(item => ({
    path: item.path, status: item.status, ...(item.error ? { error: item.error } : {}),
  }))).toEqual(expected)
}

export async function freshPage(context: BrowserContext, origin: string) {
  const page = await context.newPage()
  await page.clock.setFixedTime(new Date(NOW))
  await page.goto(origin)
  return page
}
