import childProcess from 'node:child_process'
import { appendFileSync, writeFileSync } from 'node:fs'
import fsPromises from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'

/**
 * `--import` preload for the publish CLI under test.
 *
 * Network: every fetch that is not addressed to the owned synthetic publication
 * origin is answered locally with a fictional 503; no request leaves the
 * process, so the real employer boards and Cloudflare are never contacted. Only
 * hostnames are counted (never paths, query strings, headers or bodies).
 *
 * Ordered same-process ledger (ACT82-8/MCT82-3, ACLI82-R2/MCLR82-2). One
 * sequence covers:
 * - `execFileSync` (the two Git checks) and `fs/promises.mkdtemp` (the
 *   publication temp directory), wrapped before the CLI module is evaluated with
 *   the built-in ESM bindings resynchronised, so the CLI's named imports observe
 *   the wrappers; Git argv is recorded verbatim (it never carries a credential),
 *   mkdtemp only by prefix;
 * - every forwarded checkpoint response: `checkpoint-start` when its headers
 *   arrive and `checkpoint-complete` when the upstream body reaches EOF (the
 *   identity TransformStream's flush), which precedes the consumer's final
 *   done read. Nothing is drained or cloned and no whole-body buffering is
 *   added, but ordinary stream queues remain; a failed body never completes and
 *   a later consumer cancellation can follow a recorded upstream EOF;
 * - each `/head` response (`head-response`, ordinal: response headers, not
 *   head parsing or revalidation) and the first intercepted provider attempt
 *   (`provider-attempt`, hostname only).
 * Events are appended as they happen to the live log named by
 * ORBIT_TEST_EVENT_LOG (one JSON object per line), so the harness can observe
 * the order while the CLI is still running; the exit record is the complete,
 * authoritative copy.
 *
 * At exit the preload writes one completion record naming its own pid; the
 * harness treats a missing or foreign record as unavailable evidence, never as
 * zero traffic or zero calls (ACT82-5).
 */
const allowed = process.env.ORBIT_TEST_ALLOWED_ORIGIN
const log = process.env.ORBIT_TEST_PROVIDER_LOG
const liveLog = process.env.ORBIT_TEST_EVENT_LOG
if (!allowed || !log || !liveLog) throw new Error('The publish CLI fixture requires an allowed origin, a provider log path and an event log path')
const allowedOrigin = new URL(allowed)
if (allowedOrigin.protocol !== 'http:' || allowedOrigin.hostname !== '127.0.0.1' || allowedOrigin.port === '' || allowedOrigin.port === '8787') {
  throw new Error('The publish CLI fixture only allows an owned loopback origin')
}
/** Variant payloads without the sequence number; `Omit` over the union would keep only the shared keys (ACLI82-R6). */
type PreloadPayload =
  | { kind: 'execFileSync'; file: string; args: string[] }
  | { kind: 'mkdtemp'; prefix: string }
  | { kind: 'checkpoint-start'; file: string; status: number }
  | { kind: 'checkpoint-complete'; file: string }
  | { kind: 'head-response'; status: number; ordinal: number }
  | { kind: 'provider-attempt'; host: string }
type PreloadEvent = PreloadPayload & { seq: number }
const events: PreloadEvent[] = []
const liveLogErrors: string[] = []
function record(event: PreloadPayload): void {
  const entry: PreloadEvent = { seq: events.length + 1, ...event }
  events.push(entry)
  try { appendFileSync(liveLog!, `${JSON.stringify(entry)}\n`) } catch (error) { liveLogErrors.push(String(error)) }
}
const CHECKPOINT_ROUTE = '/__orbit/publish/checkpoint/'
const realFetch = globalThis.fetch
const blocked = new Map<string, number>()
let forwarded = 0
let headResponses = 0
let providerAttemptRecorded = false

globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input))
  if (url.origin === allowedOrigin.origin) {
    forwarded++
    const response = await realFetch(input, init)
    if (url.pathname.startsWith(CHECKPOINT_ROUTE)) {
      const file = url.pathname.slice(CHECKPOINT_ROUTE.length)
      record({ kind: 'checkpoint-start', file, status: response.status })
      if (!response.body) return response
      const observed = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({ flush() { record({ kind: 'checkpoint-complete', file }) } }))
      return new Response(observed, { status: response.status, statusText: response.statusText, headers: response.headers })
    }
    if (url.pathname === '/__orbit/publish/head') record({ kind: 'head-response', status: response.status, ordinal: ++headResponses })
    return response
  }
  blocked.set(url.hostname, (blocked.get(url.hostname) ?? 0) + 1)
  if (!providerAttemptRecorded) {
    providerAttemptRecorded = true
    record({ kind: 'provider-attempt', host: url.hostname })
  }
  const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined)
  signal?.throwIfAborted()
  return new Response(JSON.stringify({ error: 'Fictional provider outage' }), {
    status: 503, headers: { 'Content-Type': 'application/json' },
  })
}

const realExecFileSync = childProcess.execFileSync
const wrappedExecFileSync = function (this: unknown, file: unknown, ...rest: unknown[]) {
  const args = Array.isArray(rest[0]) ? (rest[0] as unknown[]).map(String) : []
  record({ kind: 'execFileSync', file: String(file), args })
  return Reflect.apply(realExecFileSync as (...parameters: unknown[]) => unknown, this, [file, ...rest])
}
childProcess.execFileSync = wrappedExecFileSync as unknown as typeof childProcess.execFileSync
const realMkdtemp = fsPromises.mkdtemp
const wrappedMkdtemp = function (this: unknown, prefix: unknown, ...rest: unknown[]) {
  record({ kind: 'mkdtemp', prefix: String(prefix) })
  return Reflect.apply(realMkdtemp as (...parameters: unknown[]) => unknown, this, [prefix, ...rest])
}
fsPromises.mkdtemp = wrappedMkdtemp as unknown as typeof fsPromises.mkdtemp
// Named ESM imports of built-ins (`import { execFileSync } from 'node:child_process'`) see the wrappers after this call.
syncBuiltinESMExports()

process.on('exit', () => {
  writeFileSync(log, JSON.stringify({
    version: 3, pid: process.pid, forwarded,
    blocked: Object.fromEntries([...blocked].sort(([left], [right]) => left.localeCompare(right))),
    events, liveLogErrors, completedAt: new Date().toISOString(),
  }))
})
