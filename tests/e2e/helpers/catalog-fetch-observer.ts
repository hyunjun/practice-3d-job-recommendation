import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { readServerMode } from './api-requests'
import type { watchApiRequests } from './api-requests'

/**
 * Stage73 startup-constructor oracle (collaboration/startup-oracle-correction.md).
 *
 * When the catalog Worker cannot be constructed, the app aborts the response it has
 * just received because nothing can decode it. This helper proves that cancellation
 * directly from the page's own fetch call: the supplied signal aborted after the
 * response resolved, with the body never read, for the app's own AbortError and not
 * the native timeout. The healthy helper `expectInitialCatalogRequest` stays untouched.
 *
 * Observation only: the original receiver and arguments are forwarded unchanged, the
 * same Response object is returned, no body is consumed, no header or body content
 * is recorded, and thrown failures propagate. Wrapping fetch is still an instrumentation
 * layer; it is not claimed to have zero scheduling effect.
 */
export interface FetchObservation {
  sequence: number
  url: string
  path: string
  method: string
  bodyPresent: boolean
  signalSupplied: boolean
  startedAt: number
  resolvedAt: number | null
  status: number | null
  rejectedAt: number | null
  rejectionName: string | null
  aborted: boolean
  abortedAt: number | null
  abortedAfterResolution: boolean | null
  abortReason: string | null
  bodyUsedAtAbort: boolean | null
}
export interface FetchObservationSnapshot extends FetchObservation { bodyUsedNow: boolean | null }
interface CatalogFetchObserverControl { snapshot: () => FetchObservationSnapshot[] }
declare global { interface Window { __catalogFetchQA?: CatalogFetchObserverControl } }

export interface CatalogFetchObserver { snapshot: () => Promise<FetchObservationSnapshot[]> }

const INITIAL_PATH = '/api/catalog?source=public'
const MONITOR_PREFIX = '/api/catalog/progress'

export async function installCatalogFetchObserver(page: Page): Promise<CatalogFetchObserver> {
  await page.addInitScript(() => {
    const nativeFetch = window.fetch
    const entries: FetchObservation[] = []
    const responses = new Map<number, Response>()
    window.__catalogFetchQA = {
      snapshot: () => entries.map(entry => ({ ...entry, bodyUsedNow: responses.get(entry.sequence)?.bodyUsed ?? null })),
    }
    window.fetch = (function (this: unknown, ...args: Parameters<typeof fetch>) {
      const [input, init] = args
      const href = typeof input === 'string' ? new URL(input, location.href).href : input instanceof URL ? input.href : input.url
      const location_ = new URL(href)
      if (!location_.pathname.startsWith('/api/catalog')) return Reflect.apply(nativeFetch, this, args) as Promise<Response>
      const sequence = entries.length + 1
      const entry: FetchObservation = {
        sequence, url: href, path: location_.pathname + location_.search,
        method: (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase(),
        bodyPresent: (init?.body !== undefined && init?.body !== null) || (input instanceof Request && input.body !== null),
        signalSupplied: init?.signal instanceof AbortSignal,
        startedAt: performance.now(), resolvedAt: null, status: null, rejectedAt: null, rejectionName: null,
        aborted: false, abortedAt: null, abortedAfterResolution: null, abortReason: null, bodyUsedAtAbort: null,
      }
      entries.push(entry)
      const signal = init?.signal
      if (signal instanceof AbortSignal) {
        const record = () => {
          entry.aborted = true
          entry.abortedAt = performance.now()
          entry.abortedAfterResolution = entry.resolvedAt !== null
          const reason: unknown = signal.reason
          const name = typeof reason === 'object' && reason !== null && 'name' in reason ? (reason as { name?: unknown }).name : undefined
          entry.abortReason = typeof name === 'string' ? name : reason === undefined ? 'undefined' : typeof reason
          entry.bodyUsedAtAbort = responses.get(sequence)?.bodyUsed ?? null
        }
        if (signal.aborted) record()
        else signal.addEventListener('abort', record, { once: true })
      }
      const pending = Reflect.apply(nativeFetch, this, args) as Promise<Response>
      // Observe settlement without replacing the promise or the Response the app receives.
      pending.then(response => {
        entry.resolvedAt = performance.now()
        entry.status = response.status
        responses.set(sequence, response)
      }, (error: unknown) => {
        entry.rejectedAt = performance.now()
        entry.rejectionName = error instanceof Error ? error.name : typeof error
      })
      return pending
    }) as typeof fetch
  })
  return { snapshot: () => page.evaluate(() => window.__catalogFetchQA!.snapshot()) }
}

/**
 * Constructor-unavailable startup: exactly one response-bearing initial request with status
 * 202 whose own fetch signal aborted after resolution while the body stayed unused. The
 * browser may report that request either as finished with no error or as failed with exactly
 * net::ERR_ABORTED; both orderings require the same positive cancellation evidence. A
 * development StrictMode replay may precede it only as an unresolved, aborted attempt.
 * Returns the same shape as expectInitialCatalogRequest for the later path sequence checks.
 */
export async function expectCancelledInitialCatalogRequest(
  page: Page, traffic: ReturnType<typeof watchApiRequests>, observer: CatalogFetchObserver,
) {
  const mode = await readServerMode(page.request, new URL('/api/health', page.url()).href)
  const catalogUrl = new URL(INITIAL_PATH, page.url()).href
  const initialObservations = async () => (await observer.snapshot()).filter(entry => entry.path === INITIAL_PATH)
  try {
    await expect.poll(async () => {
      const requests = traffic.catalog()
      const observed = await initialObservations()
      return {
        pending: requests.filter(request => request.state === 'pending').length,
        settledResponses: requests.filter(request => request.status !== null && request.state !== 'pending').length,
        resolved: observed.filter(entry => entry.resolvedAt !== null).length,
        abortedAfterResolution: observed.filter(entry => entry.abortedAfterResolution === true).length,
      }
    }).toEqual({ pending: 0, settledResponses: 1, resolved: 1, abortedAfterResolution: 1 })

    const requests = traffic.catalog()
    const observed = await initialObservations()
    expect(requests.length).toBeGreaterThanOrEqual(1)
    expect(requests.length).toBeLessThanOrEqual(mode === 'development' ? 2 : 1)
    // One page-level request per observed fetch call, in the same order, so one attempt can
    // never lend its cancellation evidence to another.
    expect(observed).toHaveLength(requests.length)
    const last = requests.length - 1
    for (const [index, request] of requests.entries()) {
      const entry = observed[index]
      expect(request.url).toBe(catalogUrl)
      expect(request.method).toBe('GET')
      expect(request.body).toBeNull()
      expect(entry.url).toBe(catalogUrl)
      expect(entry.method).toBe('GET')
      expect(entry.bodyPresent).toBe(false)
      expect(entry.signalSupplied).toBe(true)
      if (index === last) {
        // The response-bearing attempt: received, then cancelled by the app itself, never read.
        expect(request.status).toBe(202)
        expect(['finished', 'failed']).toContain(request.state)
        if (request.state === 'finished') expect(request.error).toBeNull()
        else expect(request.error).toBe('net::ERR_ABORTED')
        expect(entry.status).toBe(202)
        expect(entry.resolvedAt).not.toBeNull()
        expect(entry.rejectedAt).toBeNull()
        expect(entry.aborted).toBe(true)
        expect(entry.abortedAfterResolution).toBe(true)
        // The hook aborts its own controller; the 150 s native fetch timeout would be a TimeoutError.
        expect(entry.abortReason).toBe('AbortError')
        expect(entry.bodyUsedAtAbort).toBe(false)
        expect(entry.bodyUsedNow).toBe(false)
      } else {
        // Only the development StrictMode replay: cancelled before any response.
        expect(mode).toBe('development')
        expect(request).toMatchObject({ state: 'failed', status: null, error: 'net::ERR_ABORTED' })
        expect(entry.resolvedAt).toBeNull()
        expect(entry.status).toBeNull()
        expect(entry.aborted).toBe(true)
        expect(entry.abortedAfterResolution).toBe(false)
        expect(entry.rejectionName).toBe('AbortError')
      }
    }
    // No monitor polling and no further catalog fetch before the explicit retry.
    expect(traffic.requests.filter(request => new URL(request.url).pathname.startsWith(MONITOR_PREFIX))).toEqual([])
    expect((await observer.snapshot()).filter(entry => entry.path.startsWith(MONITOR_PREFIX))).toEqual([])
    return { mode, attempts: requests.length, cancelled: requests.filter(request => request.state === 'failed').length }
  } finally {
    const observations = await observer.snapshot().catch(() => 'Page unavailable before fetch evidence collection.')
    await test.info().attach('catalog-fetch-observation', {
      body: Buffer.from(JSON.stringify({
        synthetic: true, mode,
        boundary: 'native page fetch observed; receiver/arguments forwarded, same Response returned, no body consumed, no header or body content recorded',
        observations,
      }, null, 2)),
      contentType: 'application/json',
    })
  }
}
