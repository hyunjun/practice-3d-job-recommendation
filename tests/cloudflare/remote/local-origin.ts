import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { gzipSync } from 'node:zlib'

/**
 * An owned loopback HTTP origin for the local transport witnesses (ART82-1/2/7,
 * MREMOTE82-1/2): real gzip JSON, identity JSON, HEAD, conditional 304, manual
 * 302 redirects (same-origin API, same-origin static, off-origin), a connection
 * that drops before any response, a mutation endpoint that must never be
 * reached, and a tiny HTML page for the Chromium guard witness. A test may hold
 * one exact path so a real, already-counted request stays pending at the server
 * until released (the controlled delayed route for ARR82-3). Every request is
 * recorded with its method, path and headers. Nothing here contacts any network;
 * the port is ephemeral and never 8787/8790.
 */
export interface RecordedLocalRequest { method: string; path: string; headers: IncomingHttpHeaders }
export interface HeldRoute {
  /** Resolves with the first held request once it has reached the server, i.e. while the client's attempt is counted and in flight. */
  readonly arrived: Promise<RecordedLocalRequest>
  /** Requests currently held for this path. */
  readonly held: number
  /** Serve every held request now and stop holding the path. Idempotent. */
  release: () => void
}
export interface LocalOrigin {
  origin: string
  requests: RecordedLocalRequest[]
  /** Where off-origin redirects point; set by the test to a second owned origin. */
  setForeignOrigin: (origin: string) => void
  /** Hold responses for one exact path+query until released; the response, once released, is the ordinary one for that path. */
  hold: (pathWithQuery: string) => HeldRoute
  close: () => Promise<void>
}
export const LOCAL_HEALTH = { status: 'ok', app: 'orbit', mode: 'production', delivery: 'scheduled', intervalMinutes: 30, boards: 130, synthetic: true }
export const LOCAL_OBSERVATIONS = { storage: 'ok', synthetic: true, days: [] as unknown[] }
const CLOSE_TIMEOUT_MS = 5_000
const etagOf = (text: string) => `W/"${createHash('sha256').update(text).digest('hex')}"`
const PAGE = '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>guard witness</title></head><body><main id="out">guard witness</main></body></html>'

function sendJson(request: IncomingMessage, response: ServerResponse, value: unknown, extra: Record<string, string> = {}) {
  const text = JSON.stringify(value)
  const etag = etagOf(text)
  const headers: Record<string, string> = {
    'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-cache, must-revalidate', ETag: etag, Vary: 'Accept-Encoding',
    'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'strict-origin-when-cross-origin', 'Permissions-Policy': 'camera=(), microphone=(), geolocation=()', 'X-Frame-Options': 'DENY',
    ...extra,
  }
  if (request.headers['if-none-match'] === etag) {
    response.writeHead(304, headers)
    response.end()
    return
  }
  const gzip = /\bgzip\b/.test(String(request.headers['accept-encoding'] ?? ''))
  const body = gzip ? gzipSync(text) : Buffer.from(text)
  if (gzip) headers['Content-Encoding'] = 'gzip'
  headers['Content-Length'] = String(body.length)
  response.writeHead(200, headers)
  if (request.method === 'HEAD') response.end()
  else response.end(body)
}

interface HoldState { released: boolean; held: number; waiters: (() => void)[]; arrive: (request: RecordedLocalRequest) => void }

export async function startLocalOrigin(): Promise<LocalOrigin> {
  const requests: RecordedLocalRequest[] = []
  const holds = new Map<string, HoldState>()
  let foreignOrigin = 'http://127.0.0.1:1/'
  const serve = (request: IncomingMessage, response: ServerResponse, url: URL) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ mutated: true, method: request.method }))
      return
    }
    if (url.pathname === '/') {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
      response.end(request.method === 'HEAD' ? undefined : PAGE)
      return
    }
    if (url.pathname === '/api/health') return sendJson(request, response, LOCAL_HEALTH)
    if (url.pathname === '/api/observations') return sendJson(request, response, { ...LOCAL_OBSERVATIONS, generation: url.searchParams.get('generation') }, { 'X-Orbit-Generation': url.searchParams.get('generation') ?? '' })
    if (url.pathname === '/api/catalog') {
      // A same-origin API redirect: must be refused by both transports, never followed.
      response.writeHead(302, { Location: '/elsewhere', 'Cache-Control': 'no-store' })
      response.end()
      return
    }
    if (url.pathname === '/api/posting-status') {
      // Connection failure before any response bytes.
      request.socket.destroy()
      return
    }
    if (url.pathname === '/elsewhere') return sendJson(request, response, { elsewhere: true })
    if (url.pathname === '/assets/app.js') {
      response.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'public, max-age=31536000, immutable' })
      response.end(request.method === 'HEAD' ? undefined : 'document.getElementById("out").textContent = "asset loaded";')
      return
    }
    if (url.pathname === '/redirect-asset') {
      response.writeHead(302, { Location: '/assets/app.js' })
      response.end()
      return
    }
    if (url.pathname === '/redirect-off-origin') {
      response.writeHead(302, { Location: `${foreignOrigin}/api/health` })
      response.end()
      return
    }
    response.writeHead(404, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ error: 'not found' }))
  }
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://local.invalid')
    const path = url.pathname + url.search
    const record: RecordedLocalRequest = { method: request.method ?? 'GET', path, headers: request.headers }
    requests.push(record)
    const hold = holds.get(path)
    if (hold && !hold.released) {
      // The request is real and recorded; its response waits for release().
      hold.held++
      hold.arrive(record)
      hold.waiters.push(() => { hold.held--; serve(request, response, url) })
      return
    }
    serve(request, response, url)
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const port = (server.address() as AddressInfo).port
  if (port === 8787 || port === 8790) {
    await new Promise<void>(resolve => server.close(() => resolve()))
    throw new Error('The local origin must not use a reserved local port')
  }
  return {
    origin: `http://127.0.0.1:${port}`,
    requests,
    setForeignOrigin: origin => { foreignOrigin = origin },
    hold: pathWithQuery => {
      if (holds.has(pathWithQuery)) throw new Error(`The local origin already holds ${pathWithQuery}`)
      let arrive!: (request: RecordedLocalRequest) => void
      const arrived = new Promise<RecordedLocalRequest>(resolve => { arrive = resolve })
      const state: HoldState = { released: false, held: 0, waiters: [], arrive: request => arrive(request) }
      holds.set(pathWithQuery, state)
      return {
        arrived,
        get held() { return state.held },
        release: () => {
          if (state.released) return
          state.released = true
          holds.delete(pathWithQuery)
          for (const waiter of state.waiters.splice(0)) waiter()
        },
      }
    },
    close: () => new Promise<void>((resolve, reject) => {
      // Held responses are never written after close; their sockets are destroyed with every other connection.
      for (const state of holds.values()) { state.released = true; state.waiters.length = 0 }
      holds.clear()
      server.closeAllConnections()
      const timer = setTimeout(() => {
        server.closeAllConnections()
        reject(new Error('The local origin did not close within the bound'))
      }, CLOSE_TIMEOUT_MS)
      server.close(error => {
        clearTimeout(timer)
        if (error) reject(error)
        else resolve()
      })
    }),
  }
}
