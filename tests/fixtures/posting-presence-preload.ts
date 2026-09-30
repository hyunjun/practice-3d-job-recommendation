import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { Server } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import nodePath from 'node:path'
import { performance } from 'node:perf_hooks'
import { setTimeout as delay } from 'node:timers/promises'
import type { PresenceResponses } from './posting-presence'

// This preload belongs exclusively to an owned fixture child. The app's real
// HTTP router, collectors, queues, validation and persistence remain intact.
const responsesFile = process.env.ORBIT_POSTING_PRESENCE_RESPONSES
const requestLog = process.env.ORBIT_POSTING_PRESENCE_REQUEST_LOG
const clockFile = process.env.ORBIT_POSTING_PRESENCE_CLOCK
// Stage75: an optional directory of release markers for deterministic upstream gates.
const gatesDirectory = process.env.ORBIT_POSTING_PRESENCE_GATES
if (!responsesFile || !requestLog || !clockFile) throw new Error('The presence fixture requires private response, log and clock files')
const realNow = Date.now.bind(Date)
Date.now = () => realNow() + Number(readFileSync(clockFile, 'utf8'))
let sequence = 0
const record = (value: object) => appendFileSync(requestLog, `${JSON.stringify(value)}\n`)
/** Guard only: a gate nobody releases fails the fixture request instead of hanging the child forever. */
const GATE_GUARD_MS = 120_000

// Observe the actual wire status. Chrome exposes a revalidated 304 as a cached
// 200 to page fetch, and an extra CDP session need not receive ExtraInfo events.
// This passive observer neither routes requests nor alters response/cache bytes.
const emit = Server.prototype.emit
Server.prototype.emit = function (event: string | symbol, ...args: unknown[]) {
  if (event === 'request') {
    const [request, response] = args as [IncomingMessage, ServerResponse]
    // Capture the wire path before dispatch: the app's Express `/api` mount rewrites
    // request.url to a router-relative path while handling. The finish record must
    // name the same original path that the guard matched.
    const path = request.url
    // Stage75 adds catalog and progress paths so ordering evidence covers the waiting response.
    if (path?.startsWith('/api/posting-status') || path?.startsWith('/api/catalog')) response.once('finish', () => record({
      event: 'http-response', at: new Date(Date.now()).toISOString(), path, method: request.method, status: response.statusCode,
      ifNoneMatch: request.headers['if-none-match'] ?? null, prefer: request.headers.prefer ?? null,
      etag: response.getHeader('etag') ?? null, cacheControl: response.getHeader('cache-control') ?? null,
      preferenceApplied: response.getHeader('preference-applied') ?? null,
    }))
  }
  return Reflect.apply(emit, this, [event, ...args])
}

async function waitForGate(gate: string, id: number, signal: AbortSignal | undefined) {
  if (!gatesDirectory) throw new Error(`Fixture gate ${gate} requested without a gates directory`)
  const marker = nodePath.join(gatesDirectory, `${gate}.release`)
  record({ event: 'gate-wait', sequence: id, gate, at: new Date(Date.now()).toISOString() })
  const deadline = performance.now() + GATE_GUARD_MS
  while (!existsSync(marker)) {
    signal?.throwIfAborted()
    if (performance.now() > deadline) throw new Error(`Fictional gate ${gate} was not released within the guard period`)
    await delay(20, undefined, { signal: signal ?? undefined })
  }
  record({ event: 'gate-released', sequence: id, gate, at: new Date(Date.now()).toISOString() })
}

globalThis.fetch = async (input, init) => {
  const url = input instanceof Request ? input.url : String(input)
  const method = init?.method ?? (input instanceof Request ? input.method : 'GET')
  const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined)
  const id = ++sequence
  const responses = JSON.parse(readFileSync(responsesFile, 'utf8')) as PresenceResponses
  const response = Object.hasOwn(responses, url) ? responses[url] : undefined
  const path = new URL(url).pathname
  record({
    event: 'request', sequence: id, at: new Date(Date.now()).toISOString(), url, method,
    body: init?.body === undefined || init.body === null ? null : String(init.body),
    kind: new URL(url).hostname === 'api.smartrecruiters.com' && !path.endsWith('/postings') ? 'detail' : 'list',
    synthetic: response !== undefined, networkSent: false,
  })
  try {
    if (method !== 'GET' || init?.body) throw new Error(`Unexpected fixture method/body: ${method}`)
    if (!response) throw new Error(`Unexpected upstream fixture URL: ${url}`)
    signal?.throwIfAborted()
    if (response.gate) await waitForGate(response.gate, id, signal ?? undefined)
    if (response.delayMs) await delay(response.delayMs, undefined, { signal: signal ?? undefined })
    if (response.failure) throw new Error(response.failure)
    const body = JSON.stringify(response.body ?? null)
    const status = response.status ?? 200
    record({ event: 'response', sequence: id, status, bytes: Buffer.byteLength(body), at: new Date(Date.now()).toISOString() })
    return new Response(body, { status, headers: { 'Content-Type': 'application/json', ...response.headers } })
  } catch (error) {
    record({ event: 'failure', sequence: id, error: String(error), at: new Date(Date.now()).toISOString() })
    throw error
  }
}
