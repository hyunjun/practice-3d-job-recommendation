import type { BrowserContext, Route } from '@playwright/test'
import { ApiBudgetLedger, classifyRequest, LedgerError } from './ledger'
import type { RemoteConfig } from './ledger'

/**
 * Browser transport guard for the deployed read-only journeys (ART82-1/6,
 * MREMOTE82-1/3). Every request the browser makes is classified before it
 * leaves: anything off-origin, non-GET/HEAD, private or test-routed is aborted
 * and recorded as a violation. Every admitted request is performed by the guard
 * itself through `route.fetch({ maxRedirects: 0, maxRetries: 0 })`, so no hop
 * can be followed outside this handler (Playwright does not route Chromium's own
 * redirect continuations). A redirect answer (3xx other than 304) is refused and
 * recorded instead of being handed to the browser, for counted API requests and
 * uncounted resources alike. Public API attempts are counted in the shared
 * ledger before the fetch; their outcomes are written through tracked promises.
 * WebSockets are refused and the context must be created with service workers
 * blocked, so no alternative transport can bypass the count.
 *
 * Ownership (ARR82-3/MRT82-3, ARR82-R3-4/MRR82-R8): every route handler is owned
 * from the moment the request enters the guard, including one still waiting in
 * `ledger.reserve` or `route.fetch` with no outcome write scheduled yet.
 * `drain()` stops admitting new browser activity (the route stays installed, so
 * a late request is aborted unsent and uncounted rather than escaping the guard),
 * then joins the admitted handlers and only afterwards the outcome writes they
 * scheduled, all within one bound. A bound that expires is recorded in
 * `settleErrors` and never erased; `drain()` is not cached, so a later call can
 * account for work that has since settled while the first timeout stays a
 * failure. A ledger refusal is recorded with its structured code as
 * `ledger:<code>:<message>` (ARR82-2/MRT82-2).
 */
export interface GuardedApiRequest { sequence: number; method: string; path: string; status: number | null; error: string | null; requestedAt: string; respondedAt: string | null }
export interface BrowserGuard {
  violations: { url: string; method: string; reason: string }[]
  apiRequests: GuardedApiRequest[]
  /** Uncounted same-origin resources whose fetch failed (recorded, not a scope violation). */
  resourceFailures: { url: string; error: string }[]
  /** Failures while completing a route (fulfil/abort) after the browser moved on, and handler failures outside the request path; evidence only. */
  routeErrors: string[]
  ledgerErrors: string[]
  /** Requests that reached the guard after `drain()` began: aborted unsent and never reserved (shutdown evidence, not a scope violation). */
  lateRequests: { url: string; method: string }[]
  /** Handlers or ledger writes still pending when a drain bound expired; every entry is a finalization failure that stays recorded. */
  settleErrors: string[]
  /** Owned work not yet settled: admitted route handlers and scheduled outcome writes. */
  pending: () => { handlers: number; writes: number }
  /**
   * Stop admitting new browser activity (idempotent), then join every handler
   * admitted since installation and afterwards every outcome write, within
   * `timeoutMs` (default 45 s, longer than Playwright's 30 s `route.fetch`
   * timeout so a hanging fetch records its own failure before the join gives up).
   * Each call performs its own bounded join: an expired bound is appended to
   * `settleErrors`, and a later call can still account for work that settled
   * afterwards. Only `pending()` reporting zero establishes closure.
   */
  drain: (options?: { timeoutMs?: number }) => Promise<void>
}
const DEFAULT_DRAIN_TIMEOUT_MS = 45_000

export async function installRemoteBrowserGuard(context: BrowserContext, ledger: ApiBudgetLedger, config: RemoteConfig): Promise<BrowserGuard> {
  const violations: BrowserGuard['violations'] = []
  const apiRequests: GuardedApiRequest[] = []
  const resourceFailures: BrowserGuard['resourceFailures'] = []
  const routeErrors: string[] = []
  const ledgerErrors: string[] = []
  const lateRequests: BrowserGuard['lateRequests'] = []
  const settleErrors: string[] = []
  const handlers = new Set<Promise<void>>()
  const writes = new Set<Promise<void>>()
  let stopped = false
  const track = (write: Promise<void>) => {
    const tracked: Promise<void> = write.catch(error => { ledgerErrors.push(String(error)) }).finally(() => { writes.delete(tracked) })
    writes.add(tracked)
  }
  const complete = async (action: () => Promise<void>, label?: string) => {
    try { await action() } catch (error) { routeErrors.push(label ? `${label}: ${String(error)}` : String(error)) }
  }
  const isRedirect = (status: number) => status >= 300 && status < 400 && status !== 304
  const ledgerReason = (error: unknown) => `ledger:${error instanceof LedgerError ? error.code : 'UNKNOWN'}:${error instanceof Error ? error.message : String(error)}`
  await context.routeWebSocket('**/*', route => {
    violations.push({ url: route.url(), method: 'WEBSOCKET', reason: 'websocket' })
    route.close()
  })
  const handle = async (route: Route): Promise<void> => {
    const request = route.request()
    const url = request.url()
    const method = request.method()
    if (stopped) {
      lateRequests.push({ url, method })
      return complete(() => route.abort('blockedbyclient'), 'late-abort')
    }
    const decision = classifyRequest(url, method, config)
    if (!decision.allow) {
      violations.push({ url, method, reason: decision.reason })
      return complete(() => route.abort('blockedbyclient'))
    }
    if (!decision.counted) {
      try {
        const response = await route.fetch({ maxRedirects: 0, maxRetries: 0 })
        if (isRedirect(response.status())) {
          violations.push({ url, method, reason: `redirect:${response.status()}:${response.headers().location ?? ''}` })
          return complete(() => route.abort('blockedbyclient'))
        }
        return complete(() => route.fulfill({ response }))
      } catch (error) {
        resourceFailures.push({ url, error: String(error) })
        return complete(() => route.abort('failed'))
      }
    }
    const target = new URL(url)
    let sequence: number
    try {
      sequence = (await ledger.reserve({ method, path: target.pathname + target.search })).sequence
    } catch (error) {
      violations.push({ url, method, reason: ledgerReason(error) })
      return complete(() => route.abort('blockedbyclient'))
    }
    const entry: GuardedApiRequest = { sequence, method, path: target.pathname + target.search, status: null, error: null, requestedAt: new Date().toISOString(), respondedAt: null }
    apiRequests.push(entry)
    try {
      const response = await route.fetch({ maxRedirects: 0, maxRetries: 0 })
      entry.status = response.status()
      entry.respondedAt = new Date().toISOString()
      track(ledger.record(sequence, { status: response.status() }))
      if (isRedirect(response.status())) {
        violations.push({ url, method, reason: `redirect:${response.status()}:${response.headers().location ?? ''}` })
        return complete(() => route.abort('blockedbyclient'))
      }
      return complete(() => route.fulfill({ response }))
    } catch (error) {
      entry.error = String(error)
      track(ledger.record(sequence, { error: entry.error }))
      return complete(() => route.abort('failed'))
    }
  }
  await context.route('**/*', (route: Route) => {
    // Owned from entry: the handler is joined by drain() whether it is reserving, fetching or completing.
    const handling: Promise<void> = handle(route).catch(error => { routeErrors.push(`handler: ${String(error)}`) }).finally(() => { handlers.delete(handling) })
    handlers.add(handling)
    return handling
  })
  const joinBounded = async (set: Set<Promise<void>>, label: string, deadline: number, timeoutMs: number): Promise<void> => {
    while (set.size) {
      const remaining = deadline - Date.now()
      if (remaining <= 0) {
        settleErrors.push(`${set.size} ${label} still pending after the ${timeoutMs}ms drain bound`)
        return
      }
      let timer: NodeJS.Timeout | undefined
      const expired = new Promise<'expired'>(resolve => { timer = setTimeout(() => resolve('expired'), remaining) })
      try {
        const outcome = await Promise.race([Promise.allSettled([...set]).then(() => 'settled' as const), expired])
        if (outcome === 'expired') {
          settleErrors.push(`${set.size} ${label} still pending after the ${timeoutMs}ms drain bound`)
          return
        }
      } finally {
        clearTimeout(timer)
      }
    }
  }
  return {
    violations, apiRequests, resourceFailures, routeErrors, ledgerErrors, lateRequests, settleErrors,
    pending: () => ({ handlers: handlers.size, writes: writes.size }),
    drain: async options => {
      // Not cached (ARR82-R3-4): every call joins what is pending now within its own bound; an earlier recorded timeout is never erased.
      stopped = true
      const timeoutMs = options?.timeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS
      const deadline = Date.now() + timeoutMs
      await joinBounded(handlers, 'route handler(s)', deadline, timeoutMs)
      await joinBounded(writes, 'ledger write(s)', deadline, timeoutMs)
    },
  }
}
