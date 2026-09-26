import { appendFileSync, readFileSync } from 'node:fs'
import { Server } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { setTimeout as delay } from 'node:timers/promises'
import type { PresenceResponses } from './posting-presence'

// This preload belongs exclusively to an owned fixture child. The app's real
// HTTP router, collectors, queues, validation and persistence remain intact.
const responsesFile = process.env.ORBIT_POSTING_PRESENCE_RESPONSES
const requestLog = process.env.ORBIT_POSTING_PRESENCE_REQUEST_LOG
const clockFile = process.env.ORBIT_POSTING_PRESENCE_CLOCK
if (!responsesFile || !requestLog || !clockFile) throw new Error('The presence fixture requires private response, log and clock files')
const realNow = Date.now.bind(Date)
Date.now = () => realNow() + Number(readFileSync(clockFile, 'utf8'))
let sequence = 0
const record = (value: object) => appendFileSync(requestLog, `${JSON.stringify(value)}\n`)

// Observe the actual wire status. Chrome exposes a revalidated 304 as a cached
// 200 to page fetch, and an extra CDP session need not receive ExtraInfo events.
// This passive observer neither routes requests nor alters response/cache bytes.
const emit = Server.prototype.emit
Server.prototype.emit = function (event: string | symbol, ...args: unknown[]) {
  if (event === 'request') {
    const [request, response] = args as [IncomingMessage, ServerResponse]
    if (request.url?.startsWith('/api/posting-status')) response.once('finish', () => record({
      event: 'http-response', path: request.url, method: request.method, status: response.statusCode,
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
