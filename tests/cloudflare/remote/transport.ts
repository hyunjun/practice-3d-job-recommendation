import { ApiBudgetLedger, classifyRequest, LedgerError } from './ledger'
import type { LedgerAttempt, RemoteConfig } from './ledger'

/**
 * Node API client for the deployed read-only check. Every call is classified
 * (exact origin, GET/HEAD, public API path), counted in the ledger before it is
 * sent, performed with manual redirects (a 3xx is returned, never followed), and
 * recorded with its status or error. No credential or private path can be used.
 *
 * Body representation (ART82-2/MREMOTE82-2): `body` holds the bytes the Fetch
 * API delivers, which are already content-decoded by the client; the retained
 * `content-encoding` header is informational only and consumers must not decode
 * again. 304 is a conditional result, not a redirect. Request and response
 * times are recorded as the actual UTC reference for freshness (ART82-4). A
 * request failure whose ledger write also fails is reported with both errors.
 */
export interface RemoteResponse {
  status: number
  headers: Record<string, string>
  /** Fetch-decoded bytes (empty for HEAD, 304 and redirects). */
  body: Buffer
  bodyRepresentation: 'fetch-decoded'
  redirected: boolean
  attempt: LedgerAttempt
  requestedAt: string
  respondedAt: string
  elapsedMs: number
}

export function createRemoteApi(ledger: ApiBudgetLedger, config: RemoteConfig, fetcher: typeof fetch = fetch) {
  const request = async (method: 'GET' | 'HEAD', pathWithQuery: string, headers: Record<string, string> = {}): Promise<RemoteResponse> => {
    const url = new URL(pathWithQuery, config.origin)
    const decision = classifyRequest(url.href, method, config)
    if (!decision.allow) throw new LedgerError('PATH', `Refused ${method} ${pathWithQuery}: ${decision.reason}`)
    const attempt = await ledger.reserve({ method, path: url.pathname + url.search })
    const requestedAt = new Date().toISOString()
    const started = performance.now()
    try {
      const response = await fetcher(url, {
        method, redirect: 'manual', headers: { 'Accept-Encoding': 'gzip', ...headers }, signal: AbortSignal.timeout(60_000),
      })
      const respondedAt = new Date().toISOString()
      const redirected = response.status >= 300 && response.status < 400 && response.status !== 304
      let body = Buffer.alloc(0)
      if (redirected || method === 'HEAD' || response.status === 304) await response.body?.cancel().catch(() => {})
      else body = Buffer.from(await response.arrayBuffer())
      await ledger.record(attempt.sequence, { status: response.status })
      return {
        status: response.status, headers: Object.fromEntries(response.headers), body, bodyRepresentation: 'fetch-decoded', redirected, attempt,
        requestedAt, respondedAt, elapsedMs: Math.round(performance.now() - started),
      }
    } catch (error) {
      try {
        await ledger.record(attempt.sequence, { error: String(error) })
      } catch (recordError) {
        throw new AggregateError([error, recordError], `${method} ${pathWithQuery} failed and its outcome could not be recorded in the ledger`)
      }
      throw error
    }
  }
  return {
    get: (pathWithQuery: string, headers?: Record<string, string>) => request('GET', pathWithQuery, headers),
    head: (pathWithQuery: string, headers?: Record<string, string>) => request('HEAD', pathWithQuery, headers),
  }
}
