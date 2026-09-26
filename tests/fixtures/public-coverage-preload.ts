import { appendFileSync, readFileSync } from 'node:fs'
import { Server } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { setTimeout as delay } from 'node:timers/promises'
import { asCoverageReply } from './public-coverage-transport'

// Loaded only by an owned fixture child. The real default loader, collectors,
// cache, HTTP API and browser run unchanged. There is no live-network fallback.
const responsesFile = process.env.ORBIT_PUBLIC_COVERAGE_RESPONSES
const requestLog = process.env.ORBIT_PUBLIC_COVERAGE_REQUEST_LOG
const clockFile = process.env.ORBIT_PUBLIC_COVERAGE_CLOCK
if (!responsesFile || !requestLog) throw new Error('Public coverage needs isolated response and log files')
const realNow = Date.now.bind(Date)
if (clockFile) Date.now = () => realNow() + Number(readFileSync(clockFile, 'utf8'))
let sequence = 0
const record = (value: object) => appendFileSync(requestLog, `${JSON.stringify(value)}\n`)

// Passive wire logging leaves the real HTTP cache usable. Browser route()
// interception must stay off in tests that claim to verify browser 304 reuse.
const emit = Server.prototype.emit
Server.prototype.emit = function (event: string | symbol, ...args: unknown[]) {
  if (event === 'request') {
    const [request, response] = args as [IncomingMessage, ServerResponse]
    // Express temporarily strips the mounted /api prefix while sending. Keep
    // the externally requested path, before the application handles this event.
    const requestedPath = request.url
    if (requestedPath?.startsWith('/api/')) response.once('finish', () => record({
      event: 'http-response', path: requestedPath, method: request.method, status: response.statusCode,
      ifNoneMatch: request.headers['if-none-match'] ?? null,
      etag: response.getHeader('etag') ?? null, cacheControl: response.getHeader('cache-control') ?? null,
    }))
  }
  return Reflect.apply(emit, this, [event, ...args])
}

globalThis.fetch = async (input, init) => {
  const url = input instanceof Request ? input.url : String(input)
  const method = init?.method ?? (input instanceof Request ? input.method : 'GET')
  const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined)
  const body = init?.body == null ? input instanceof Request && input.body ? '[Request body]' : null : String(init.body)
  const id = ++sequence
  const responses = JSON.parse(readFileSync(responsesFile, 'utf8')) as Record<string, unknown>
  const matched = Object.hasOwn(responses, url)
  record({
    event: 'request', sequence: id, at: new Date(Date.now()).toISOString(),
    url, method, body, synthetic: matched, networkSent: false,
  })
  try {
    if (method !== 'GET' || body !== null) throw new Error(`Unexpected fixture method/body: ${method}`)
    if (!matched) throw new Error(`Unexpected upstream fixture URL: ${url}`)
    signal?.throwIfAborted()
    const response = asCoverageReply(responses[url])
    if (response.delayMs) await delay(response.delayMs, undefined, { signal: signal ?? undefined })
    if (response.failure) throw new Error(response.failure)
    const json = JSON.stringify(response.body)
    const status = response.status ?? 200
    const result = new Response(json, { status, headers: { 'Content-Type': 'application/json', ...response.headers } })
    record({ event: 'response', sequence: id, status, bytes: Buffer.byteLength(json), at: new Date(Date.now()).toISOString() })
    return result
  } catch (error) {
    record({ event: 'failure', sequence: id, error: String(error), at: new Date(Date.now()).toISOString() })
    throw error
  }
}
