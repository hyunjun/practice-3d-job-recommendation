import { execFile } from 'node:child_process'
import type { ExecFileOptionsWithStringEncoding } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { lstat, open, readFile, realpath } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import type { ClientRequest, IncomingMessage, RequestOptions } from 'node:http'
import type { Socket } from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { TestInfo } from '@playwright/test'

/**
 * Local runtime instrumentation for the capacity suite (ACR82-3/4/5/8, WIM82-1..4,
 * MCR82-R9..R11).
 *
 * Endpoints: the dev and inspector ports are canonical decimal integers in
 * [1024, 65535] on 127.0.0.1, distinct from each other, and never the foreign
 * port 8787 after normalization (so "08787" is refused too). Nothing is probed
 * before this validation.
 *
 * Ownership: the validation runner records every process this run launched in
 * ORBIT_PROCESS_REGISTRY (`verification/<run>/processes.ndjson`, the approved
 * runtime observation source). The owned runtime is derived from that record,
 * never from whatever listens on the requested ports: a listener PID must be
 * registered by this run, every registered workerd must be alive with the
 * registered parent, a birth time consistent with its spawn record and a workerd
 * command, and identities (pid, ppid, pgid, start time, command) are rechecked
 * before samples are used. The workerd that owns the public listeners is the
 * Wrangler proxy runtime; other owned workerd processes are the user runtime
 * candidates. They are reported by role and never conflated. Listener PIDs are
 * parsed from nonempty canonical positive lines only (a newline-terminated reply
 * never yields PID 0), and the ordinary "no listener" lsof result (exit 1, empty
 * stdout and stderr, not killed) is distinguished from a missing command,
 * timeout or failure, whose raw output is kept separately from the diagnostic.
 *
 * Inspector (pinned Wrangler 4.147.0): the configured inspector port serves
 * InspectorProxyWorker. Its `/json` and `/json/list` return exactly one target
 * (random UUID, type node, title "Cloudflare Worker", description workers,
 * `ws://<host>/ws`, no url, no Worker name) and `/json/version` reports
 * `wrangler/v4.147.0` with Protocol-Version 1.3. Attribution therefore never
 * matches a Worker name; it binds the owned launch/ports, the exact singleton
 * and version envelope, the exact `ws://127.0.0.1:<owned inspector port>/ws`
 * endpoint, a correlated `Runtime.getIsolateId` reply and the isolate nonce the
 * test entry serves over HTTP (read through `Runtime.evaluate`). The nonce is
 * checked only in explicitly advertised unique contexts after one disable/
 * enable handshake; the bound isolate id is rechecked at every heap sample
 * and profile boundary. Created/destroyed/cleared context events retain a
 * bounded history, and binding invalidation is sticky across awaited calls.
 * Profile effects have independent same-isolate cleanup even when a measured
 * context has been invalidated. A failed acquisition keeps
 * owning the socket it opened: it is terminated, its closure observed within a
 * bound, and the outcome travels with the primary error. Decoded frames must be
 * CDP objects; null, primitive or array frames are protocol failures that reject
 * pending calls, while unmatched proxy-internal response ids stay harmless. The
 * handshake needs a loopback Host and an allowed Origin, supplied through the
 * requested direct `ws` client (independent/author04-capacity-dependency-request.json).
 * Generic CDP remains the default. Remedy03 explicitly selects the pinned
 * native producer, an immutable per-run CPU owner claim, complete stop-effect
 * proof before replacement, and one owned I/O turn within each original GC
 * deadline. Its HTTP join and profiler finalizer settle independently before
 * the same transport's single-deadline close.
 *
 * Memory/CPU: raw `Runtime.getHeapUsage` fields are preserved; optional fields
 * are reported as present-with-value or absent, never substituted with 0, and
 * overlapping counters are not summed. `usedSize` is used V8 heap inside
 * `totalSize`; `backingStorageSize` is V8 external accounting, not all native
 * memory; `embedderHeapUsedSize` is CppHeap usage where a supported 0 is valid.
 * Process RSS of the owned workerd processes is phase-correlated context, not a
 * bound on provider-charged isolate memory; a sample whose ps command failed,
 * whose RSS field is not a number or whose process is missing or changed is
 * explicit invalid/unavailable evidence, never a zero, and an interval with any
 * such sample is unusable. CPU profiles are retained raw and validated for
 * positive duration, valid sample→node references and a positive total of time
 * deltas. Every subprocess, sample, open, call and close is bounded; at most one
 * sample is in flight (a sample that misses the stop bound is retained and no
 * second sample is started); unconfirmed closure is reported as such, never as
 * success.
 */
const EXEC_TIMEOUT_MS = 5_000
const FORBIDDEN_PORT = 8787
const WORKERD = /(^|\/)workerd(\s|$)|\/workerd\/bin\/workerd|workerd-darwin|workerd-linux/
export const PINNED_WRANGLER = { browser: 'wrangler/v4.147.0', protocolVersion: '1.3', targetType: 'node', targetTitle: 'Cloudflare Worker', targetDescription: 'workers', webSocketPath: '/ws' } as const

export interface CommandText { text: string; originalBytes: number; retainedBytes: number; truncated: boolean }
export interface CommandTime { epochMs: number | null; monotonicMs: number | null }
interface CommandMark { order: number; at: CommandTime }
interface CommandEvents<T> { count: number; first: T | null; last: T | null; omitted: number }
interface CommandError {
  text: CommandText | null
  code: number | CommandText | null
  signal: CommandText | null
  killed: boolean | null
}
interface CommandExit extends CommandMark { code: number | null; signal: CommandText | null }
interface CommandStream {
  present: boolean | null
  attached: { data: boolean; end: boolean; close: boolean; error: boolean }
  data: { count: number; decodedUtf8Bytes: number; bufferBytes: number; unknownChunks: number; first: CommandMark | null; last: CommandMark | null }
  end: CommandEvents<CommandMark>
  close: CommandEvents<CommandMark>
  error: CommandEvents<CommandMark & { error: CommandError | null }>
}
interface CommandChildFlags { killed: boolean | null; exitCode: number | null; signalCode: CommandText | null }
interface CommandCallback extends CommandMark {
  phase: CommandText | null
  error: CommandError | null
  /** Null callback error implies normalized success, not an independently observed OS exit. */
  code: number | CommandText | null
  childFlags: CommandChildFlags | null
  observedAtCallback: { exit: number; close: number; stdoutEnd: number; stdoutClose: number; stderrEnd: number; stderrClose: number; observerFailures: number }
  output: { stdoutDecodedUtf8Bytes: number | null; stderrDecodedUtf8Bytes: number | null; maxBufferFailureReported: boolean; completeness: 'not-reported-incomplete' | 'unknown-on-failure' }
}
export interface CommandObservation {
  version: 1
  sequence: number
  file: CommandText
  /** JSON-encoded exact argv; bounded metadata, never an environment dump. */
  argv: CommandText
  parent: { pid: number; ppid: number; actor: CommandText | null; registry: CommandText | null; run: CommandText | null }
  timeoutMs: number
  killSignal: 'SIGKILL'
  maxBuffer: number
  readonly startedAt: CommandTime
  readonly deadline: number | null
  dispatchPhase: CommandText | null
  callbackCount: number
  callback: CommandCallback | null
  laterCallback: CommandCallback | null
  settlements: number
  invocationFailure: CommandError | null
  child: {
    acquired: boolean
    pid: number | null
    flagsAtReturn: CommandChildFlags | null
    exit: CommandEvents<CommandExit>
    close: CommandEvents<CommandExit>
    error: CommandEvents<CommandMark & { error: CommandError | null }>
  }
  stdout: CommandStream
  stderr: CommandStream
  observerFailures: CommandEvents<{ source: CommandText; error: CommandText | null }>
  /** Timing/observer admissibility, not exit success or physical termination. Command errors still use diagnostic/code; later observer failures only invalidate. */
  readonly available: boolean
}
/**
 * Raw callback output exists once, in stdout/stderr. Lifecycle observers retain
 * counters and bounded metadata only. A diagnostic may accompany raw code0.
 */
export interface BoundedResult {
  code: number | null
  stdout: string
  stderr: string
  readonly diagnostic: string | null
  killed: boolean
  observation?: CommandObservation
}
export interface ExecFileFailure extends Omit<NodeJS.ErrnoException, 'code'> { code?: number | string; signal?: string | null; killed?: boolean }
interface CommandEmitter { on(event: string, listener: (...args: any[]) => void): unknown }
export interface ObservedCommandChild extends CommandEmitter {
  pid?: number
  killed?: boolean
  exitCode?: number | null
  signalCode?: string | null
  stdout?: CommandEmitter | null
  stderr?: CommandEmitter | null
  kill?: (signal: NodeJS.Signals) => boolean
}
/** Opt-in exact-handle ownership. Callback settlement is deliberately not closure. */
export interface CommandLease {
  readonly observation: CommandObservation
  readonly terminal: Promise<void>
  observedTerminal(): boolean
  cancel(): { requested: boolean; reason: string }
  onChange(listener: () => void): void
}
/** Instance-local witness seams; defaults still issue the single original execFile. */
export interface CommandWitness {
  invoke?: (file: string, args: string[], options: ExecFileOptionsWithStringEncoding, callback: (error: ExecFileFailure | null, stdout: string, stderr: string) => void) => ObservedCommandChild
  now?: () => number
  wallNow?: () => number
  phase?: () => string
  lifetime?: (lease: CommandLease) => void
}
const COMMAND_METADATA_BYTES = 4096
let commandSequence = 0
function commandText(text: string): CommandText {
  const originalBytes = Buffer.byteLength(text, 'utf8')
  if (originalBytes <= COMMAND_METADATA_BYTES) return { text, originalBytes, retainedBytes: originalBytes, truncated: false }
  let retained = ''
  let retainedBytes = 0
  for (const character of text) {
    const bytes = Buffer.byteLength(character, 'utf8')
    if (retainedBytes + bytes > COMMAND_METADATA_BYTES) break
    retained += character
    retainedBytes += bytes
  }
  return { text: retained, originalBytes, retainedBytes, truncated: true }
}
function recordCommandObserverFailure(failures: CommandObservation['observerFailures'], source: string, error: unknown): void {
  let text: CommandText | null = null
  try { text = commandText(String(error)) } catch { /* The original text is unknown when conversion fails. */ }
  const value = { source: commandText(source), error: text }
  failures.count = Math.min(Number.MAX_SAFE_INTEGER, failures.count + 1)
  failures.first ??= value
  failures.last = value
  failures.omitted = Math.max(0, failures.count - 2)
}
export function execBounded(file: string, args: string[], timeoutMs = EXEC_TIMEOUT_MS, witness: CommandWitness = {}): Promise<BoundedResult> {
  const now = witness.now ?? (() => performance.now())
  const wallNow = witness.wallNow ?? Date.now
  // Keep a fixed first/last pair. Any intermediate metadata omission is
  // explicit; error counts remain sticky even when no additional text is kept.
  const events = <T>(): CommandEvents<T> => ({ count: 0, first: null, last: null, omitted: 0 })
  const stream = (): CommandStream => ({
    present: null, attached: { data: false, end: false, close: false, error: false },
    data: { count: 0, decodedUtf8Bytes: 0, bufferBytes: 0, unknownChunks: 0, first: null, last: null },
    end: events(), close: events(), error: events(),
  })
  const failures = events<{ source: CommandText; error: CommandText | null }>()
  let lifetimeChanged = () => {}
  const retain = <T>(target: CommandEvents<T>, value: T) => {
    target.count = Math.min(Number.MAX_SAFE_INTEGER, target.count + 1)
    target.first ??= value
    target.last = value
    target.omitted = Math.max(0, target.count - 2)
    lifetimeChanged()
  }
  const observerFailure = (source: string, error: unknown) => {
    recordCommandObserverFailure(failures, source, error)
    lifetimeChanged()
  }
  const observe = <T>(source: string, read: () => T): T | null => {
    try { return read() } catch (error) { observerFailure(source, error); return null }
  }
  const time = (): CommandTime => ({
    // Monotonic time is captured first, including immediately on callback entry.
    monotonicMs: observe('monotonic clock', () => { const value = now(); if (!Number.isFinite(value)) throw new Error('Nonfinite command clock'); return value }),
    epochMs: observe('wall clock', () => { const value = wallNow(); if (!Number.isFinite(value)) throw new Error('Nonfinite wall clock'); return value }),
  })
  let order = 0
  const mark = (at = time()): CommandMark => ({ order: ++order, at })
  const phase = () => witness.phase ? observe('phase metadata', () => commandText(witness.phase!())) : null
  const errorFacts = (error: ExecFileFailure): CommandError => ({
    text: observe('error text', () => commandText(String(error))),
    code: observe('error code', () => typeof error.code === 'number' ? error.code : typeof error.code === 'string' ? commandText(error.code) : null),
    signal: observe('error signal', () => typeof error.signal === 'string' ? commandText(error.signal) : null),
    killed: observe('error killed flag', () => typeof error.killed === 'boolean' ? error.killed : null),
  })
  const flags = (child: ObservedCommandChild): CommandChildFlags => ({
    killed: observe('child killed flag', () => typeof child.killed === 'boolean' ? child.killed : null),
    exitCode: observe('child exitCode', () => typeof child.exitCode === 'number' ? child.exitCode : null),
    signalCode: observe('child signalCode', () => typeof child.signalCode === 'string' ? commandText(child.signalCode) : null),
  })
  const registry = process.env.ORBIT_PROCESS_REGISTRY
  const startedAt = Object.freeze(time())
  const deadline = startedAt.monotonicMs === null ? null : startedAt.monotonicMs + timeoutMs
  const observation: CommandObservation = {
    version: 1, sequence: ++commandSequence, file: commandText(file), argv: commandText(JSON.stringify(args)),
    parent: { pid: process.pid, ppid: process.ppid, actor: process.env.ORBIT_VERIFICATION_ACTOR ? commandText(process.env.ORBIT_VERIFICATION_ACTOR) : null, registry: registry ? commandText(registry) : null, run: registry ? commandText(path.basename(path.dirname(registry))) : null },
    timeoutMs, killSignal: 'SIGKILL', maxBuffer: 16 * 1024 * 1024, startedAt, get deadline() { return deadline }, dispatchPhase: phase(),
    callbackCount: 0, callback: null, laterCallback: null, settlements: 0, invocationFailure: null,
    child: { acquired: false, pid: null, flagsAtReturn: null, exit: events(), close: events(), error: events() },
    stdout: stream(), stderr: stream(), observerFailures: failures,
    get available() {
      const at = observation.callback?.at.monotonicMs
      return at !== null && at !== undefined && deadline !== null && Number.isFinite(deadline)
        && at >= startedAt.monotonicMs! && at <= deadline && failures.count === 0 && observation.invocationFailure === null
        && observation.child.error.count === 0 && observation.stdout.error.count === 0 && observation.stderr.error.count === 0
    },
  }
  const acquisitionDiagnostic = () => {
    const at = observation.callback?.at.monotonicMs
    if (at !== null && at !== undefined && deadline !== null && at > deadline) return commandText(`${observation.file.text} callback exceeded the original ${timeoutMs} ms acquisition deadline`).text
    if (failures.count) return `Command observation failed (${failures.count} recorded observer failures)`
    if (observation.child.error.count || observation.stdout.error.count || observation.stderr.error.count) return 'Command child/stdio error was observed'
    if (!observation.available) return 'Command acquisition has unavailable or invalid original timing'
    return null
  }
  return new Promise((resolve, reject) => {
    let child: ObservedCommandChild | null = null
    let settled = false
    if (witness.lifetime) {
      let terminalResolve!: () => void
      const terminal = new Promise<void>(done => { terminalResolve = done })
      let changed: (() => void) | undefined
      const observedTerminal = () => observation.child.acquired && observation.settlements === 1
        && observation.child.exit.count > 0 && observation.child.close.count > 0
        && (['stdout', 'stderr'] as const).every(name => observation[name].present === false
          || (observation[name].present === true && observation[name].end.count > 0 && observation[name].close.count > 0))
      lifetimeChanged = () => {
        if (observedTerminal() || observation.invocationFailure) terminalResolve()
        // The subscriber must not throw into a native EventEmitter callback.
        try { changed?.() } catch (error) { recordCommandObserverFailure(failures, 'lifetime subscriber', error) }
      }
      try {
        witness.lifetime({
          observation, terminal, observedTerminal,
          onChange(listener) {
            if (changed) throw new Error('A command lease accepts one lifetime subscriber')
            changed = listener
          },
          cancel() {
            if (!child) return { requested: false, reason: 'no returned command handle; ownership unknown' }
            if (observation.child.exit.count || observation.child.close.count || child.exitCode != null || child.signalCode != null) return { requested: false, reason: 'retained command already observed exited' }
            if (!child.kill) return { requested: false, reason: 'retained command has no cancellation method' }
            return { requested: child.kill('SIGKILL'), reason: 'SIGKILL requested through the retained live command handle; closure still requires events' }
          },
        })
      } catch (error) { observerFailure('lifetime registration', error); reject(error); return }
    }
    const callback = (error: ExecFileFailure | null, stdout: string, stderr: string) => {
      const enteredAt = time()
      const callbackMark = mark(enteredAt)
      const callbackPhase = phase()
      const failure = error ? errorFacts(error) : null
      const rawCode = failure?.code
      const facts: CommandCallback = {
        ...callbackMark, phase: callbackPhase, error: failure, code: error ? failure!.code : 0,
        childFlags: child ? flags(child) : null,
        observedAtCallback: { exit: observation.child.exit.count, close: observation.child.close.count, stdoutEnd: observation.stdout.end.count, stdoutClose: observation.stdout.close.count, stderrEnd: observation.stderr.end.count, stderrClose: observation.stderr.close.count, observerFailures: failures.count },
        output: { stdoutDecodedUtf8Bytes: observe('callback stdout count', () => Buffer.byteLength(stdout, 'utf8')), stderrDecodedUtf8Bytes: observe('callback stderr count', () => Buffer.byteLength(stderr, 'utf8')), maxBufferFailureReported: rawCode !== null && typeof rawCode === 'object' && rawCode.text === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', completeness: error ? 'unknown-on-failure' : 'not-reported-incomplete' },
      }
      observation.callbackCount = Math.min(Number.MAX_SAFE_INTEGER, observation.callbackCount + 1)
      if (settled) {
        observation.laterCallback = facts
        observerFailure('duplicate callback', new Error('The original command result already settled'))
        return
      }
      observation.callback = facts
      settled = true
      observation.settlements++
      const killed = failure?.killed === true
      const code = !error ? 0 : killed ? null : typeof failure?.code === 'number' ? failure.code : null
      // A killed flag does not establish timeout cause or physical exit.
      // Preserve the callback error; only callback timing establishes lateness.
      const primaryDiagnostic = !error || (!killed && typeof failure?.code === 'number' && failure.code !== 0)
        ? null : failure?.text?.text ?? 'Command callback error (text unavailable)'
      resolve({
        code, stdout, stderr, killed, observation,
        // Keep the first command failure; secondary observation failures remain
        // separate in the holder and cannot turn a result into usable evidence.
        get diagnostic() { return primaryDiagnostic ?? acquisitionDiagnostic() },
      })
      lifetimeChanged()
    }
    try {
      const invoke: NonNullable<CommandWitness['invoke']> = witness.invoke ?? execFile
      child = invoke(file, args, { encoding: 'utf8', timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 16 * 1024 * 1024, env: { ...process.env, TZ: 'UTC', LC_ALL: 'C' } }, callback)
    } catch (error) {
      observation.invocationFailure = errorFacts(error as ExecFileFailure)
      if (settled) observerFailure('producer threw after callback', error)
      else { settled = true; observation.settlements++; reject(error) }
      lifetimeChanged()
      return
    }
    observation.child.acquired = true
    observe('child PID', () => { if (Number.isSafeInteger(child!.pid) && child!.pid! > 0) observation.child.pid = child!.pid! })
    observation.child.flagsAtReturn = flags(child)
    const listen = (emitter: CommandEmitter, event: string, source: string, listener: (...values: any[]) => void) =>
      observe(`${source} listener`, () => { emitter.on(event, (...values) => { observe(source, () => listener(...values)) }); return true }) === true
    for (const name of ['exit', 'close'] as const) {
      listen(child, name, `child ${name}`, (code: number | null, signal: string | null) => retain(observation.child[name], { ...mark(), code: typeof code === 'number' ? code : null, signal: typeof signal === 'string' ? commandText(signal) : null }))
    }
    listen(child, 'error', 'child error', (error: ExecFileFailure) => retain(observation.child.error, { ...mark(), error: errorFacts(error) }))
    for (const name of ['stdout', 'stderr'] as const) {
      const state = observation[name]
      let handleRead = false
      const pipe = observe(`${name} handle`, () => { const value = child![name]; handleRead = true; return value })
      state.present = handleRead ? Boolean(pipe) : null
      if (!pipe) continue
      state.attached.data = listen(pipe, 'data', `${name} data`, (chunk: unknown) => {
        const at = mark()
        state.data.count++
        state.data.first ??= at
        state.data.last = at
        if (typeof chunk === 'string') state.data.decodedUtf8Bytes += Buffer.byteLength(chunk, 'utf8')
        else if (Buffer.isBuffer(chunk)) state.data.bufferBytes += chunk.byteLength
        else { state.data.unknownChunks++; throw new Error('Unrecognized observed command data chunk') }
        lifetimeChanged()
      })
      for (const event of ['end', 'close'] as const) state.attached[event] = listen(pipe, event, `${name} ${event}`, () => retain(state[event], mark()))
      state.attached.error = listen(pipe, 'error', `${name} error`, (error: ExecFileFailure) => retain(state.error, { ...mark(), error: errorFacts(error) }))
    }
    lifetimeChanged()
  })
}

/** Complete test-only walks; every fixed16 items yield a real turn, regardless of sampler state. */
export async function cooperativeForEach<T>(items: readonly T[], visit: (item: T, index: number) => void | Promise<void>): Promise<void> {
  for (let index = 0; index < items.length; index++) {
    if (index > 0 && index % 16 === 0) await new Promise<void>(resolve => setImmediate(resolve))
    await visit(items[index], index)
  }
}

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------
export interface OwnedEndpoints { host: '127.0.0.1'; devPort: number; inspectorPort: number; devOrigin: string; inspectorOrigin: string }
export function canonicalPort(value: string | number, label: string): number {
  const text = String(value).trim()
  if (!/^\d{1,5}$/.test(text)) throw new Error(`${label} must be a plain decimal port, got ${JSON.stringify(value)}`)
  const port = Number(text)
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error(`${label} must be an integer in [1024, 65535], got ${text}`)
  if (port === FORBIDDEN_PORT) throw new Error(`${label} ${JSON.stringify(value)} normalizes to the foreign port 8787 and is refused`)
  return port
}
/** Canonical, loopback-only, distinct dev and inspector endpoints; validated before any probe. */
export function validateOwnedEndpoints(baseUrl: string, inspectorPort: string | number): OwnedEndpoints {
  const url = new URL(baseUrl)
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.pathname !== '/' || url.search || url.hash || url.username || url.password) {
    throw new Error(`The capacity dev URL must be http://127.0.0.1:<port>/ exactly, got ${baseUrl}`)
  }
  const devPort = canonicalPort(url.port, 'dev port')
  const inspector = canonicalPort(inspectorPort, 'inspector port')
  if (inspector === devPort) throw new Error(`The inspector port must differ from the dev port (${devPort})`)
  return { host: '127.0.0.1', devPort, inspectorPort: inspector, devOrigin: `http://127.0.0.1:${devPort}`, inspectorOrigin: `http://127.0.0.1:${inspector}` }
}

// ---------------------------------------------------------------------------
// Owned runtime processes
// ---------------------------------------------------------------------------
export interface ProcessIdentity { pid: number; ppid: number; pgid: number; started: string; command: string }
export interface OwnedWorkerd extends ProcessIdentity { role: 'proxy-listener' | 'owned-runtime'; registeredAt: number; registeredBy: number }
export interface OwnedRuntime {
  endpoints: OwnedEndpoints
  registryPath: string
  registeredPids: number[]
  listeners: { port: number; pids: number[] }[]
  workerd: OwnedWorkerd[]
}
const verifiedRuntimes = new WeakSet<OwnedRuntime>()
interface RegistryRecord { event: string; pid: number; ppid: number; argv?: unknown[]; at: number }

/** Query only retained owned PIDs; callers must establish ownership before this read. */
export async function processTable(pids: number[] = [process.pid]): Promise<ProcessIdentity[]> {
  if (!pids.length || pids.some(pid => !Number.isSafeInteger(pid) || pid <= 0)) throw new Error('An owned process-table query needs positive safe PIDs')
  const result = await execBounded('ps', ['-o', 'pid=,ppid=,pgid=,lstart=,command=', '-p', [...new Set(pids)].join(',')])
  if (result.diagnostic !== null) throw new Error(`ps failed: ${result.diagnostic}`)
  if (result.code === 1 && !result.killed && !result.stdout.trim() && !result.stderr.trim()) return []
  if (result.code !== 0) throw new Error(`ps failed: exit ${result.code} ${result.stderr.trim()}`)
  const rows: ProcessIdentity[] = []
  for (const line of result.stdout.split('\n')) {
    const parts = line.trim().split(/\s+/)
    if (parts.length < 9) continue
    const [pid, ppid, pgid] = parts.slice(0, 3).map(Number)
    if (![pid, ppid, pgid].every(Number.isInteger)) continue
    rows.push({ pid, ppid, pgid, started: parts.slice(3, 8).join(' '), command: parts.slice(8).join(' ') })
  }
  return rows
}
/** `lsof -t` lines: nonempty canonical positive safe integers become PIDs (deduplicated); anything else is reported, never coerced (an empty final line is not PID 0). */
export function parsePidLines(stdout: string): { pids: number[]; invalid: string[] } {
  const pids: number[] = []
  const invalid: string[] = []
  for (const raw of stdout.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    const pid = Number(line)
    if (/^[1-9]\d*$/.test(line) && Number.isSafeInteger(pid)) {
      if (!pids.includes(pid)) pids.push(pid)
    } else {
      invalid.push(line)
    }
  }
  return { pids, invalid }
}
export type ListenerOutcome = { kind: 'listeners'; pids: number[] } | { kind: 'none' } | { kind: 'error'; reason: string }
/** Classify an lsof result: listeners (exit 0 with valid PID lines), the ordinary no-listener answer (exit 1, empty stdout and stderr, not killed, no diagnostic) or an error. */
export function classifyListenerResult(result: BoundedResult): ListenerOutcome {
  if (result.diagnostic !== null) return { kind: 'error', reason: result.diagnostic }
  if (result.code === 0) {
    const parsed = parsePidLines(result.stdout)
    if (parsed.invalid.length) return { kind: 'error', reason: `lsof printed non-PID lines: ${parsed.invalid.join(', ')}` }
    if (!parsed.pids.length) return { kind: 'error', reason: 'lsof exited 0 without any PID line' }
    return { kind: 'listeners', pids: parsed.pids }
  }
  if (result.code === 1 && !result.killed && !result.stdout.trim() && !result.stderr.trim()) return { kind: 'none' }
  return { kind: 'error', reason: `exit ${result.code}${result.stderr.trim() ? ` ${result.stderr.trim()}` : ''}${result.stdout.trim() ? ` (stdout ${JSON.stringify(result.stdout.trim().slice(0, 200))})` : ''}` }
}
/** PIDs listening on a TCP port (lsof, bounded); the ordinary empty answer is not an error, a failing or missing lsof is. */
export async function listeningPids(port: number): Promise<number[]> {
  const outcome = classifyListenerResult(await execBounded('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t']))
  if (outcome.kind === 'listeners') return outcome.pids
  if (outcome.kind === 'none') return []
  throw new Error(`lsof could not list port ${port}: ${outcome.reason}`)
}
async function readRegistry(registryPath: string): Promise<RegistryRecord[]> {
  const text = await readFile(registryPath, 'utf8')
  return text.split('\n').filter(Boolean).map((line, index) => {
    let value: unknown
    try { value = JSON.parse(line) } catch (error) { throw new Error(`registry line ${index + 1} is not JSON: ${String(error)}`) }
    const record = value as Partial<RegistryRecord>
    if (typeof record.event !== 'string' || !Number.isInteger(record.pid) || !Number.isInteger(record.ppid) || !Number.isFinite(record.at)) throw new Error(`registry line ${index + 1} is malformed`)
    return record as RegistryRecord
  })
}
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
/** `ps lstart` under TZ=UTC/LC_ALL=C: "Sat Oct  3 16:23:55 2026" → epoch milliseconds, or NaN. */
export function birthOf(identity: Pick<ProcessIdentity, 'started'>): number {
  const tokens = identity.started.trim().split(/\s+/)
  if (tokens.length !== 5) return Number.NaN
  const month = MONTHS.indexOf(tokens[1])
  const day = Number(tokens[2])
  const [hours, minutes, seconds] = tokens[3].split(':').map(Number)
  const year = Number(tokens[4])
  if (month < 0 || ![day, hours, minutes, seconds, year].every(Number.isInteger)) return Number.NaN
  return Date.UTC(year, month, day, hours, minutes, seconds)
}
/** Derive the owned runtime from this run's registry; never from arbitrary listeners. */
export async function bindOwnedRuntime(endpoints: OwnedEndpoints): Promise<OwnedRuntime> {
  const registryPath = process.env.ORBIT_PROCESS_REGISTRY
  if (!registryPath) throw new Error('ORBIT_PROCESS_REGISTRY is not set: the capacity check must run under the validation runner so the owned launch is recorded; listeners are never treated as owned without it')
  const records = await readRegistry(registryPath)
  const spawns = records.filter(record => record.event === 'spawn')
  const registered = new Set<number>([...spawns.map(record => record.pid), ...records.filter(record => record.event === 'observer-start').map(record => record.pid)])
  const listeners: OwnedRuntime['listeners'] = []
  for (const port of [endpoints.devPort, endpoints.inspectorPort]) {
    const pids = await listeningPids(port)
    if (!pids.length) throw new Error(`Nothing listens on the owned port ${port}`)
    listeners.push({ port, pids })
  }
  const listenerPids = new Set(listeners.flatMap(listener => listener.pids))
  const unowned = [...listenerPids].filter(pid => !registered.has(pid))
  if (unowned.length) throw new Error(`Listener PID(s) ${unowned.join(', ')} on the owned ports are not recorded in this run's registry ${registryPath}; refusing to treat them as owned`)
  const workerdSpawns = spawns.filter(record => Array.isArray(record.argv) && record.argv.some(item => typeof item === 'string' && WORKERD.test(item)))
  if (!workerdSpawns.length) throw new Error(`No workerd spawn is recorded in ${registryPath}`)
  const table = await processTable(workerdSpawns.map(record => record.pid))
  const byPid = new Map(table.map(row => [row.pid, row]))
  const workerd = workerdSpawns.map(record => {
    const live = byPid.get(record.pid)
    if (!live) throw new Error(`Registered workerd ${record.pid} is not alive`)
    if (!WORKERD.test(live.command)) throw new Error(`PID ${record.pid} was registered as workerd but now runs ${live.command}`)
    if (live.ppid !== record.ppid) throw new Error(`workerd ${record.pid} has parent ${live.ppid}, not its registered launcher ${record.ppid}`)
    const birth = birthOf(live)
    if (!Number.isFinite(birth) || Math.abs(birth - record.at) > 120_000) throw new Error(`workerd ${record.pid} started at ${live.started}, inconsistent with its registered spawn at ${new Date(record.at).toISOString()}`)
    return { ...live, role: listenerPids.has(record.pid) ? 'proxy-listener' as const : 'owned-runtime' as const, registeredAt: record.at, registeredBy: record.ppid }
  })
  if (!workerd.some(process => process.role === 'proxy-listener')) {
    throw new Error(`No registered workerd owns the listeners on ${endpoints.devPort}/${endpoints.inspectorPort} (listener PIDs ${[...listenerPids].join(', ')})`)
  }
  const runtime = { endpoints, registryPath, registeredPids: [...registered].sort((left, right) => left - right), listeners, workerd }
  verifiedRuntimes.add(runtime)
  return runtime
}
/** Identity problems of the owned processes against a process table (pid, ppid, pgid, start time and command must all be unchanged); pure. */
export function identityProblems(runtime: OwnedRuntime, rows: ProcessIdentity[]): string[] {
  const byPid = new Map(rows.map(row => [row.pid, row]))
  const problems: string[] = []
  for (const owned of runtime.workerd) {
    const live = byPid.get(owned.pid)
    if (!live) { problems.push(`${owned.role} workerd ${owned.pid} is gone`); continue }
    for (const field of ['ppid', 'pgid', 'started', 'command'] as const) {
      if (live[field] !== owned[field]) problems.push(`${owned.role} workerd ${owned.pid} changed ${field}: ${String(owned[field])} -> ${String(live[field])}`)
    }
  }
  return problems
}
/** Identity problems for the owned processes right now. */
export async function recheckRuntime(runtime: OwnedRuntime, table?: ProcessIdentity[]): Promise<string[]> {
  return identityProblems(runtime, table ?? await processTable(runtime.workerd.map(owned => owned.pid)))
}

export type SampleAvailability = 'valid' | 'missing-row' | 'invalid-rss'
/** One owned process in one sample: a number only when ps reported a valid row with a numeric RSS; otherwise null with the explicit reason. */
export interface ProcessSample { pid: number; role: OwnedWorkerd['role']; rssKiB: number | null; availability: SampleAvailability }
export interface MemorySample {
  at: string
  phase: string
  processes: ProcessSample[]
  identityProblems: string[]
  /** Non-null when ps itself did not produce a usable table (missing command, timeout, unexpected exit); the sample is unavailable evidence. */
  commandError: string | null
  /** Raw bounded command output of this run's owned PIDs only, for diagnosis. */
  raw: { code: number | null; stdout: string; stderr: string }
  /** The same bounded holder as the command result, including later observer facts. */
  commandObservation?: CommandObservation
  provenance?: {
    dispatch: { phase: string | null; at: CommandTime }
    callback: { phase: string | null; at: CommandTime } | null
    completion: { phase: string; at: CommandTime }
  }
}
export interface MemorySummary {
  unit: string
  scope: string
  owned: { pid: number; role: OwnedWorkerd['role']; command: string }[]
  samples: MemorySample[]
  sampleCount: number
  validSampleCount: number
  invalidSamples: { at: string; phase: string; problems: string[] }[]
  skippedTicks: number
  /** Peak over VALID samples only; null when a process has no valid sample (absence is never 0). */
  peakRssKiBByPid: Record<string, number | null>
  errors: string[]
  /** True only with no sampler errors, no invalid sample and at least one valid sample. */
  usable: boolean
}
/** Every reason a sample is not valid evidence: command failure, identity problems and non-valid process rows. */
export function sampleProblems(sample: MemorySample): string[] {
  const problems: string[] = []
  if (sample.commandError !== null) problems.push(`command: ${sample.commandError}`)
  else if (sample.commandObservation && !sample.commandObservation.available) problems.push('command: retained command acquisition is unavailable')
  problems.push(...sample.identityProblems)
  for (const process of sample.processes) if (process.availability !== 'valid') problems.push(`${process.role} ${process.pid}: ${process.availability}`)
  return problems
}
/**
 * Pure summary of recorded samples, shared by the sampler and the literal
 * validation witness. Peaks are taken only over samples that are valid as a
 * whole (no command error, no identity problem, every row valid); a process
 * without such a sample keeps a null peak. No absence ever becomes a number.
 */
export function summarizeSamples(owned: MemorySummary['owned'], samples: MemorySample[], skippedTicks: number, errors: string[]): MemorySummary {
  const peaks: Record<string, number | null> = Object.fromEntries(owned.map(process => [String(process.pid), null]))
  const invalidSamples: MemorySummary['invalidSamples'] = []
  for (const sample of samples) {
    const problems = sampleProblems(sample)
    if (problems.length) {
      invalidSamples.push({ at: sample.at, phase: sample.phase, problems })
      continue
    }
    for (const process of sample.processes) {
      if (process.availability !== 'valid' || process.rssKiB === null) continue
      const current = peaks[String(process.pid)]
      peaks[String(process.pid)] = current === null || current === undefined ? process.rssKiB : Math.max(current, process.rssKiB)
    }
  }
  const validSampleCount = samples.length - invalidSamples.length
  return {
    unit: 'KiB resident set size (ps rss) per owned workerd process, phase-labelled',
    scope: 'host-level process memory of this run\'s registered workerd processes (proxy listener and owned runtime reported separately); includes runtime overhead and every isolate in that process; context only, not a bound on provider-charged isolate memory',
    owned, samples: [...samples], sampleCount: samples.length, validSampleCount, invalidSamples, skippedTicks, peakRssKiBByPid: peaks, errors: [...errors],
    usable: !errors.length && !invalidSamples.length && validSampleCount > 0,
  }
}
/** The usable-sample check every realistic measurement applies: a command error, invalid RSS, lost or changed identity or the absence of any valid sample invalidates the interval. */
export function requireUsableMemory(summary: MemorySummary): void {
  // Later bounded observer facts may arrive after the command callback or a
  // caller's earlier summary. Re-evaluate retained samples; a prior failure is
  // sticky, and an old successful summary cannot hide a new observed failure.
  const current = summarizeSamples(summary.owned, summary.samples, summary.skippedTicks, summary.errors)
  if (summary.usable && current.usable) return
  const problems = [...summary.errors, ...summary.invalidSamples.map(entry => `${entry.phase} @ ${entry.at}: ${entry.problems.join(', ')}`)]
  for (const entry of current.invalidSamples) {
    const message = `${entry.phase} @ ${entry.at}: ${entry.problems.join(', ')}`
    if (!problems.includes(message)) problems.push(message)
  }
  if (!summary.validSampleCount) problems.push('no valid owned-process sample was taken')
  throw new Error(`owned-process memory evidence is not usable: ${problems.join('; ')}`)
}
/**
 * Convert one raw bounded `ps -p` result into a sample (MCR82-R14): the seam the
 * literal witnesses exercise. The ordinary no-match answer is exit 1 with EMPTY
 * stdout and stderr, not killed and without a diagnostic; every owned process is
 * then a missing row (lost identity), not a failed command. Any other nonzero
 * result, including exit 1 that still printed rows, is a failed command whose raw
 * output is preserved and whose sample is unavailable. A row's RSS counts only as
 * a canonical decimal that is a finite, nonnegative safe integer.
 */
export function sampleFromResult(runtime: OwnedRuntime, result: BoundedResult, at: string, phase: string): MemorySample {
  const owned = runtime.workerd
  // Retain the one original bounded callback output, not a second data/chunk
  // history or an unexplained slice of a failed command.
  const raw = { code: result.code, stdout: result.stdout, stderr: result.stderr }
  const commandObservation = result.observation
  const unavailable = (commandError: string): MemorySample => ({
    at, phase, processes: owned.map(process => ({ pid: process.pid, role: process.role, rssKiB: null, availability: 'missing-row' })), identityProblems: [], commandError, raw, commandObservation,
  })
  if (result.diagnostic !== null) return unavailable(result.diagnostic)
  if (result.killed) return unavailable(`ps -p was killed (exit ${result.code})`)
  const normalNoMatch = result.code === 1 && !result.stdout.trim() && !result.stderr.trim()
  if (result.code !== 0 && !normalNoMatch) {
    return unavailable(`ps -p exited ${result.code}${result.stderr.trim() ? ` with stderr ${JSON.stringify(result.stderr.trim().slice(0, 200))}` : ''}${result.stdout.trim() ? ' with rows on stdout' : ''}`)
  }
  const rows: (ProcessIdentity & { rssKiB: number | null })[] = []
  for (const line of result.stdout.split('\n')) {
    const parts = line.trim().split(/\s+/)
    if (parts.length < 10) continue
    const [pid, ppid, pgid] = parts.slice(0, 3).map(Number)
    if (![pid, ppid, pgid].every(Number.isInteger)) continue
    const rss = /^\d+$/.test(parts[8]) ? Number(parts[8]) : Number.NaN
    rows.push({ pid, ppid, pgid, started: parts.slice(3, 8).join(' '), rssKiB: Number.isSafeInteger(rss) && rss >= 0 ? rss : null, command: parts.slice(9).join(' ') })
  }
  return {
    at, phase, identityProblems: identityProblems(runtime, rows), raw, commandObservation,
    get commandError() { return result.diagnostic },
    processes: owned.map(process => {
      const row = rows.find(candidate => candidate.pid === process.pid)
      if (!row) return { pid: process.pid, role: process.role, rssKiB: null, availability: 'missing-row' }
      if (row.rssKiB === null) return { pid: process.pid, role: process.role, rssKiB: null, availability: 'invalid-rss' }
      return { pid: process.pid, role: process.role, rssKiB: row.rssKiB, availability: 'valid' }
    }),
  }
}
export interface MemorySamplerLifetime {
  beforeSample(): void
  /** Runs after callback/completion capture; may await owned terminal observations. */
  retainSample(sample: MemorySample): Promise<MemorySample>
}
export class MemorySampler {
  readonly samples: MemorySample[] = []
  readonly errors: string[] = []
  phase = 'start'
  private skippedTicks = 0
  private timer: ReturnType<typeof setInterval> | undefined
  private inFlight: Promise<void> | null = null
  private stopped = false
  private cancelled = false
  constructor(readonly runtime: OwnedRuntime, private readonly commandWitness: CommandWitness = {}, private readonly lifetime?: MemorySamplerLifetime) {}

  /** One bounded sample: identity and RSS of every owned workerd in a single ps call, converted through sampleFromResult. */
  async sampleOnce(): Promise<MemorySample> {
    if (this.lifetime) {
      if (this.cancelled) throw new Error('The owned sampler was cancelled; no replacement sample is permitted')
      this.lifetime.beforeSample()
    }
    const result = await execBounded('ps', ['-o', 'pid=,ppid=,pgid=,lstart=,rss=,command=', '-p', this.runtime.workerd.map(process => process.pid).join(',')], EXEC_TIMEOUT_MS, { ...this.commandWitness, phase: () => this.phase })
    const completion = { phase: this.phase, at: { epochMs: null, monotonicMs: null } as CommandTime }
    for (const [field, clock] of [['monotonicMs', this.commandWitness.now ?? (() => performance.now())], ['epochMs', this.commandWitness.wallNow ?? Date.now]] as const) {
      try {
        const value = clock()
        if (!Number.isFinite(value) || (field === 'epochMs' && !Number.isFinite(new Date(value).getTime()))) throw new Error('Invalid sample completion clock')
        completion.at[field] = value
      } catch (error) { recordCommandObserverFailure(result.observation!.observerFailures, `sample completion ${field}`, error) }
    }
    const sample = sampleFromResult(this.runtime, result, completion.at.epochMs === null ? '(completion time unavailable)' : new Date(completion.at.epochMs).toISOString(), completion.phase)
    sample.provenance = {
      dispatch: { phase: result.observation!.dispatchPhase?.text ?? null, at: result.observation!.startedAt },
      callback: result.observation!.callback ? { phase: result.observation!.callback.phase?.text ?? null, at: result.observation!.callback.at } : null,
      completion,
    }
    const retained = this.lifetime ? await this.lifetime.retainSample(sample) : sample
    this.samples.push(retained)
    return retained
  }
  start(intervalMs = 250): void {
    if (this.timer || this.stopped) throw new Error('The memory sampler can be started once')
    this.timer = setInterval(() => {
      if (this.inFlight) { this.skippedTicks++; return }
      this.inFlight = this.sampleOnce().then(() => undefined, error => { this.errors.push(String(error)) }).finally(() => { this.inFlight = null })
    }, intervalMs)
  }
  private async joinWithin(work: Promise<void>, ms: number): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const expired = new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), ms) })
    try {
      return await Promise.race([work.then(() => true as const), expired])
    } finally {
      clearTimeout(timer)
    }
  }
  /**
   * Stop sampling and join the in-flight sample within a bound. A sample that
   * settles in time is followed by one final sample; a sample that misses the
   * bound is retained and reported, and no second sample is started while it is
   * active (`pendingSample()` lets a caller join it later). Idempotent.
   */
  async stop(joinMs = EXEC_TIMEOUT_MS + 1_000): Promise<MemorySummary> {
    if (!this.stopped) {
      this.stopped = true
      if (this.timer) clearInterval(this.timer)
      this.timer = undefined
      if (this.inFlight && !(await this.joinWithin(this.inFlight, joinMs))) {
        this.errors.push(`the in-flight sample did not settle within ${joinMs} ms; no final sample was started while it remains active`)
      } else if (!this.cancelled) {
        try { await this.sampleOnce() } catch (error) { this.errors.push(String(error)) }
      }
    }
    return this.summary()
  }
  /** The sample still active after a stop that missed its bound, or null once nothing is in flight. */
  pendingSample(): Promise<void> | null { return this.inFlight }
  /** Failed process-owner path only: no new final acquisition and no default change. */
  cancelSampling(): void {
    if (!this.lifetime) throw new Error('Cancellation requires the opt-in sampler lifetime owner')
    this.cancelled = true
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }
  summary(): MemorySummary {
    return summarizeSamples(this.runtime.workerd.map(process => ({ pid: process.pid, role: process.role, command: process.command })), this.samples, this.skippedTicks, this.errors)
  }
}

// ---------------------------------------------------------------------------
// Inspector (CDP over the pinned Wrangler public proxy)
// ---------------------------------------------------------------------------
export interface InspectorTarget { id: string; type: string; title: string; description: string; webSocketDebuggerUrl: string; [field: string]: unknown }
export interface InspectorVersion { Browser: string; 'Protocol-Version': string; [field: string]: unknown }
export type OptionalField = { present: true; value: number } | { present: false }
export interface HeapSample {
  at: string
  phase: string
  isolateId: string
  usedSize: number
  totalSize: number
  embedderHeapUsedSize: OptionalField
  backingStorageSize: OptionalField
  /** Every field exactly as the runtime returned it. */
  raw: Record<string, unknown>
}
export interface CpuProfileSummary { busyMicros: number; idleMicros: number; sampleCount: number; nodeCount: number; durationMicros: number; totalDeltaMicros: number; samplingIntervalMicros: number }
export interface RawCpuProfile { nodes: { id: number; callFrame: { functionName: string; url?: string; lineNumber?: number } }[]; samples: number[]; timeDeltas: number[]; startTime: number; endTime: number }
export interface CloseOutcome {
  confirmed: boolean; code: number | null; reason: string
  native?: { disposition: 'graceful' | 'forced' | 'unconfirmed'; beganAt: number; deadline: number; graceMs: number; closeAt: number | null; terminateAt: number | null }
  errors?: string[]
}
/** Candidate05 client work/evidence caps; neither product limits nor measured native margins. */
export const CONTEXT_LIMITS = { live: 16, history: 128, descriptorBytes: 4096 } as const
export interface ContextDescriptor { id: number; uniqueId: string; name: string; origin: string; auxData?: Record<string, unknown> }
type ContextPhase = 'socket-owned' | 'initial-isolate' | 'disable' | 'enable' | 'discover' | 'final-isolate' | 'bound' | 'runtime-restore' | 'profile-cleanup' | 'closed'
export interface ContextEvent {
  kind: 'created' | 'destroyed' | 'cleared'
  phase: ContextPhase
  revision: number
  descriptor?: ContextDescriptor | null
  descriptorBytes?: number
  unknownFields?: number
  executionContextId?: number
  executionContextUniqueId?: string
  clearCount?: number
  unavailable?: string
}
export interface InspectorAcquisition {
  phase: string
  phases: string[]
  httpDiscovery: { url: string; status: number | null; headers: Record<string, string> | null; text: string | null; textUtf8Bytes: number | null; failure: string | null }[]
  json: unknown
  jsonList: unknown
  version: unknown
  expectedEndpoint: string
  expectedNonce: string
  socketAcquired: boolean
  initialIsolateId: string | null
  finalIsolateId: string | null
  disableMayHaveBeenSent: boolean
  disableAcknowledged: boolean
  enableAcknowledged: boolean
  discoveryRevision: number | null
  nonceResults: { context: ContextDescriptor; raw: unknown; matches: boolean }[]
  binding: ContextDescriptor | null
  budgets: { discoveryOrOpenMs: number; rpcMs: 30000; maximumAcquisitionRpcs: 20; runtimeRestoreMs: number; socketTerminationMs: number; timedIoOnly: true }
}
export interface InspectorAcquisitionCleanup {
  runtime: {
    attempted: boolean; enabledConfirmed: boolean; result: unknown; failure: string | null
    limitation: string
  }
  socket: { acquired: false } | ({ acquired: true } & CloseOutcome)
  pendingCallsAfterCleanup: number
  failures: string[]
}
export interface ProfileCleanup {
  budgetMsPerRpc: 3000
  configuredRpcBudgetMs: 12000
  confirmed: boolean
  stopped: boolean
  disabled: boolean
  initialIsolateId: string | null
  finalIsolateId: string | null
  actions: { method: string; status: 'acknowledged' | 'failed' | 'skipped'; result?: unknown; reason?: string }[]
  failures: string[]
  native?: Record<string, unknown>
}
/** Primary failure, obtained discovery evidence, restoration and closure are distinct even before socket acquisition. */
export class InspectorAcquisitionError extends Error {
  constructor(readonly primary: unknown, readonly closure: CloseOutcome, readonly acquisition: InspectorAcquisition, readonly cleanup: InspectorAcquisitionCleanup, readonly instrumentation: unknown) {
    super(`${String(primary)} [acquisition socket ${!acquisition.socketAcquired ? 'not acquired' : closure.confirmed ? `closed (${closure.code ?? 'no code'} ${closure.reason})`.trimEnd() : `closure unconfirmed: ${closure.reason}`}]${cleanup.failures.length ? ` [cleanup: ${cleanup.failures.join('; ')}]` : ''}`)
    this.name = 'InspectorAcquisitionError'
  }
}
export interface RpcTrace { id?: number; method?: string; sentAt?: number; deadline?: number; acknowledgedAt?: number; failedAt?: number; failure?: string }
interface Pending {
  method: string; params: Readonly<Record<string, unknown>>; deadline: number; trace: RpcTrace
  resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout>
}
export interface WsSocket {
  readyState: number
  send(data: string, callback?: (error?: Error) => void): void
  close(code?: number, reason?: string): void
  terminate(): void
  on(event: 'open', listener: () => void): unknown
  on(event: 'message', listener: (data: Buffer | string | ArrayBuffer | Buffer[]) => void): unknown
  on(event: 'error', listener: (error: Error) => void): unknown
  on(event: 'close', listener: (code: number, reason: Buffer | string) => void): unknown
  on(event: 'unexpected-response', listener: (request: unknown, response: { statusCode?: number; statusMessage?: string }) => void): unknown
}
interface WsModule { WebSocket: new (address: string, options?: { headers?: Record<string, string>; handshakeTimeout?: number; perMessageDeflate?: boolean }) => WsSocket; WebSocketServer: new (options: Record<string, unknown>) => unknown }
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
const optionalField = (value: unknown): OptionalField => finite(value) ? { present: true, value } : { present: false }
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const positiveId = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0

/** Remedy03 is opt-in. A reflected command never selects a producer contract. */
export const NATIVE_CONTRACT = {
  name: 'workerd-1.20261001.1', workerd: '1.20261001.1', wrangler: '4.147.0', protocol: '1.3',
  sourceRevision: '402f058c655b01fa58ba1ed711061cf3bc7d896b', v8: '15.5.35.7',
  frameBytes: 4096, frameRecords: 64, totalFrameBytes: 65536, identityBytes: 4096,
  gcMs: 30000, httpJoinMs: 3000,
} as const
type NativePermission = 'encoding-cpu' | 'heap-only'
export interface NativeMode { readonly contract: typeof NATIVE_CONTRACT.name; readonly permission: NativePermission }
interface NativeVersions { workerd: string; platform: string; wrangler: string; protocol: string }
export interface NativeWitnessOptions {
  directory: string
  permission: NativePermission
  versions?: NativeVersions
  now?: () => number
  socketFactory?: (address: string) => WsSocket
  httpFactory?: (url: URL, options: RequestOptions, response: (message: IncomingMessage) => void) => ClientRequest
}
interface NativeConfiguration {
  kind: 'owned-native' | 'synthetic-witness'
  permission: NativePermission
  runtime?: OwnedRuntime
  witness?: NativeWitnessOptions
  used: boolean
}
const nativeModes = new WeakMap<NativeMode, NativeConfiguration>()
function nativeMode(configuration: NativeConfiguration): NativeMode {
  const mode = Object.freeze({ contract: NATIVE_CONTRACT.name, permission: configuration.permission })
  nativeModes.set(mode, configuration)
  return mode
}
export function nativeCapacityMode(runtime: OwnedRuntime, permission: NativePermission): NativeMode {
  if (!verifiedRuntimes.has(runtime)) throw new Error('Native mode requires this process’s validated owned runtime')
  if (permission !== 'encoding-cpu' && permission !== 'heap-only') throw new Error('Unknown native permission')
  return nativeMode({ kind: 'owned-native', permission, runtime, used: false })
}
/** Synthetic ownership is always labelled; genuine cases never use this factory. */
export function nativeWitnessMode(options: NativeWitnessOptions): NativeMode {
  if (options.permission !== 'encoding-cpu' && options.permission !== 'heap-only') throw new Error('Unknown native permission')
  return nativeMode({ kind: 'synthetic-witness', permission: options.permission, witness: { ...options, versions: options.versions && { ...options.versions } }, used: false })
}
const sha256 = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex')
const int32 = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= -2147483648 && value <= 2147483647
const positiveInt32 = (value: unknown): value is number => int32(value) && value > 0
const own = (object: object, key: string) => Object.prototype.hasOwnProperty.call(object, key)
const exactKeys = (object: Record<string, unknown>, keys: string[]) => Object.keys(object).length === keys.length && keys.every(key => own(object, key))
function frozenJson<T>(value: T): T {
  const copy = JSON.parse(JSON.stringify(value)) as T
  const freeze = (item: unknown): void => {
    if (item && typeof item === 'object') { for (const child of Object.values(item)) freeze(child); Object.freeze(item) }
  }
  freeze(copy)
  return copy
}
function remaining(deadline: number, now: () => number, label: string): number {
  const ms = deadline - now()
  if (!finite(ms) || ms <= 0) throw new Error(`${label}: original deadline expired`)
  return ms
}
async function beforeDeadline<T>(work: Promise<T>, deadline: number, now: () => number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const result = await Promise.race([work, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label}: original deadline expired`)), remaining(deadline, now, label))
    })])
    remaining(deadline, now, label)
    return result
  } finally { clearTimeout(timer) }
}
function checkNativeVersions(versions: NativeVersions): void {
  if (versions.workerd !== NATIVE_CONTRACT.workerd || versions.platform !== NATIVE_CONTRACT.workerd ||
      versions.wrangler !== NATIVE_CONTRACT.wrangler || versions.protocol !== NATIVE_CONTRACT.protocol) {
    throw new Error(`Native producer provenance mismatch: ${JSON.stringify(versions)}`)
  }
}
interface NativePreparation {
  directory: string
  provenance: Record<string, unknown>
}
interface NativeStopEffect {
  client: string; target: string; isolate: string; enableEpoch: number; startEpoch: number; profileIndex: number
}
async function prepareNative(configuration: NativeConfiguration, endpoints: OwnedEndpoints): Promise<NativePreparation> {
  if (configuration.kind === 'synthetic-witness') {
    const witness = configuration.witness!
    const versions = witness.versions ?? { workerd: '1.20261001.1', platform: '1.20261001.1', wrangler: '4.147.0', protocol: '1.3' }
    checkNativeVersions(versions)
    const directory = await realpath(witness.directory)
    if (directory !== path.resolve(witness.directory) || !(await lstat(directory)).isDirectory()) throw new Error('Witness claim directory must be an owned real directory')
    return { directory, provenance: frozenJson({ kind: 'synthetic-witness', versions, qualification: 'Owned scripted producer; no native binary attribution' }) }
  }
  const runtime = configuration.runtime!
  if (!verifiedRuntimes.has(runtime) || JSON.stringify(runtime.endpoints) !== JSON.stringify(endpoints)) throw new Error('Native endpoints differ from the validated owned runtime')
  const problems = await recheckRuntime(runtime)
  if (problems.length) throw new Error(`Native ownership changed: ${problems.join('; ')}`)
  const project = fileURLToPath(new URL('../../../', import.meta.url))
  const verification = await realpath(path.resolve(project, '../verification'))
  const registry = path.resolve(runtime.registryPath)
  const directory = path.dirname(registry)
  if (path.basename(registry) !== 'processes.ndjson' || path.dirname(directory) !== verification ||
      !/^worker-capacity-[a-z0-9]+$/.test(path.basename(directory)) || await realpath(registry) !== registry ||
      (await lstat(registry)).isSymbolicLink() || await realpath(directory) !== directory) {
    throw new Error('Native claim must be in the verified capacity run’s verification directory')
  }
  const request = JSON.parse(await readFile(path.join(directory, 'request.json'), 'utf8')) as Record<string, unknown>
  if (request.check !== 'worker-capacity' || typeof request.actor !== 'string' || !request.actor ||
      !/^[a-f0-9]{64}$/.test(String(request.sourceDigest)) || !/^[a-f0-9]{64}$/.test(String(request.planSha256))) {
    throw new Error('Native run request has no source/plan/actor binding')
  }
  const platformName = `@cloudflare/workerd-${process.platform}-${process.arch === 'x64' ? '64' : process.arch}`
  const names = ['workerd', platformName, 'wrangler']
  const lockBytes = await readFile(path.join(project, 'package-lock.json'))
  const lock = JSON.parse(lockBytes.toString('utf8')) as { packages?: Record<string, { version?: string; integrity?: string }> }
  const packages = await Promise.all(names.map(async name => {
    const packagePath = path.join(project, 'node_modules', name, 'package.json')
    const bytes = await readFile(packagePath)
    const installed = JSON.parse(bytes.toString('utf8')) as { name?: string; version?: string }
    const pinned = lock.packages?.[`node_modules/${name}`]
    if (installed.name !== name || !pinned?.integrity || installed.version !== pinned.version) throw new Error(`Installed/locked native provenance mismatch: ${name}`)
    return { name, version: installed.version!, path: packagePath, sha256: sha256(bytes), integrity: pinned.integrity }
  }))
  checkNativeVersions({ workerd: packages[0].version, platform: packages[1].version, wrangler: packages[2].version, protocol: '1.3' })
  const binary = await realpath(path.join(project, 'node_modules', platformName, 'bin/workerd'))
  if (!runtime.workerd.some(item => item.role === 'owned-runtime') ||
      runtime.workerd.some(item => !item.command.startsWith(`${binary} `))) throw new Error('Owned runtime executable does not match the pinned native platform package')
  return {
    directory,
    provenance: frozenJson({
      kind: 'owned-native', run: path.basename(directory), registryPath: registry, request,
      workerd: runtime.workerd, endpoints, packages, packageLock: { sha256: sha256(lockBytes) },
      publicSource: { revision: NATIVE_CONTRACT.sourceRevision, v8: NATIVE_CONTRACT.v8 },
      qualification: 'Pinned source/package and fresh owned-run provenance, not native binary attestation or proof of arbitrary external inspector inactivity',
    }),
  }
}

/** Full producer schema, independent of the stronger measured-CPU criteria. */
function nativeStopProfile(value: unknown): RawCpuProfile {
  const fail = (detail: string): never => { throw new Error(`Native stop effect profile: ${detail}`) }
  if (!record(value) || !exactKeys(value, ['nodes', 'startTime', 'endTime', 'samples', 'timeDeltas'])) return fail('missing/extra required profile fields')
  if (!Array.isArray(value.nodes) || !value.nodes.length || !Array.isArray(value.samples) || !Array.isArray(value.timeDeltas)) return fail('missing node/sample/delta arrays')
  if (!finite(value.startTime) || !finite(value.endTime) || value.startTime < 0 || value.endTime < value.startTime) return fail('invalid timestamps')
  const nodes = new Map<number, number[]>()
  for (const node of value.nodes) {
    if (!record(node) || !positiveInt32(node.id) || nodes.has(node.id) || !record(node.callFrame)) return fail('invalid/duplicate node')
    if (Object.keys(node).some(key => !['id', 'callFrame', 'hitCount', 'children', 'positionTicks', 'deoptReason'].includes(key))) return fail('unknown node field')
    const frame = node.callFrame
    if (!exactKeys(frame, ['functionName', 'scriptId', 'url', 'lineNumber', 'columnNumber']) ||
        !['functionName', 'scriptId', 'url'].every(key => typeof frame[key] === 'string') ||
        !int32(frame.lineNumber) || !int32(frame.columnNumber)) return fail('invalid callFrame')
    if (own(node, 'hitCount') && (!int32(node.hitCount) || node.hitCount < 0)) return fail('invalid hitCount')
    if (own(node, 'deoptReason') && typeof node.deoptReason !== 'string') return fail('invalid deoptReason')
    if (own(node, 'positionTicks') && (!Array.isArray(node.positionTicks) || node.positionTicks.some(tick =>
      !record(tick) || !exactKeys(tick, ['line', 'ticks']) || !int32(tick.line) || !int32(tick.ticks) || tick.ticks < 0))) return fail('invalid positionTicks')
    const children = own(node, 'children') ? node.children : []
    if (!Array.isArray(children) || !children.every(positiveInt32) || new Set(children).size !== children.length) return fail('invalid children')
    nodes.set(node.id, children)
  }
  const root = (value.nodes[0] as { id: number }).id
  const parents = new Map<number, number>()
  for (const [id, children] of nodes) for (const child of children) {
    if (!nodes.has(child) || child === id || parents.has(child)) return fail('unknown child or inconsistent parents')
    parents.set(child, id)
  }
  if (parents.has(root) || [...nodes.keys()].some(id => id !== root && !parents.has(id))) return fail('not a root-first connected tree')
  const visited = new Set<number>()
  const stack = [root]
  while (stack.length) {
    const id = stack.pop()!
    if (visited.has(id)) return fail('cycle')
    visited.add(id)
    for (const child of nodes.get(id)!) stack.push(child)
  }
  if (visited.size !== nodes.size) return fail('disconnected cycle')
  if (value.samples.length !== value.timeDeltas.length || !value.samples.every(sample => positiveInt32(sample) && nodes.has(sample)) ||
      !value.timeDeltas.every(delta => int32(delta) && delta >= 0)) return fail('invalid samples/deltas/references')
  return value as unknown as RawCpuProfile
}

export interface NativeFrameRecord {
  bytes: number; sha256: string; rawBase64: string; rawUtf8: string | null; retainedBytes: number
  truncated: boolean; arrivedAt: number; id: number | null; method: string | null; phase: string; disposition: string
  shape: Record<string, string> | null
}
/** This is the same bounded recorder used at the native socket message seam. */
export class NativeFrameEvidence {
  readonly records: NativeFrameRecord[] = []
  retainedBytes = 0
  overflow: { bytes: number; sha256: string; reason: string } | null = null
  discardedAfterOverflow = 0
  capture(bytes: Buffer, meta: Pick<NativeFrameRecord, 'arrivedAt' | 'id' | 'method' | 'phase' | 'disposition'>): boolean {
    if (this.overflow) { this.discardedAfterOverflow++; return false }
    const available = Math.max(0, NATIVE_CONTRACT.totalFrameBytes - this.retainedBytes)
    const keep = Math.min(bytes.length, NATIVE_CONTRACT.frameBytes, available)
    const truncated = keep !== bytes.length
    const reason = this.records.length >= NATIVE_CONTRACT.frameRecords ? 'frame record cap' : truncated ? 'frame/aggregate raw-byte cap' : null
    const retained = bytes.subarray(0, keep)
    let rawUtf8: string | null = null
    try { new TextDecoder('utf-8', { fatal: true }).decode(retained); rawUtf8 = retained.toString('utf8') } catch { /* original bytes remain in base64 */ }
    let shape: Record<string, string> | null = null
    if (!truncated && rawUtf8 !== null) {
      try {
        const object: unknown = JSON.parse(rawUtf8)
        if (record(object)) shape = Object.fromEntries(Object.entries(object).map(([key, value]) => [key, value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value]))
      } catch { /* exact rejected bytes, not a manufactured object */ }
    }
    if (this.records.length < NATIVE_CONTRACT.frameRecords) {
      this.records.push({ ...meta, bytes: bytes.length, sha256: sha256(bytes), rawBase64: retained.toString('base64'), rawUtf8, retainedBytes: keep, truncated, shape })
      this.retainedBytes += keep
    }
    if (reason) this.overflow = { bytes: bytes.length, sha256: sha256(bytes), reason }
    return !reason
  }
}

export async function closeNativeTransport(socket: WsSocket, totalBudgetMs = 5000, now = () => performance.now(), alreadyClosed?: { code: number; reason: string; at: number }): Promise<CloseOutcome> {
  if (!finite(totalBudgetMs) || totalBudgetMs <= 0 || totalBudgetMs > 5000) throw new Error('Native close requires a positive finite budget no larger than5000ms')
  const beganAt = now()
  const deadline = beganAt + totalBudgetMs
  const graceMs = Math.min(1000, Math.floor(totalBudgetMs / 5))
  const errors: string[] = []
  const native: NonNullable<CloseOutcome['native']> = { disposition: 'unconfirmed', beganAt, deadline, graceMs, closeAt: null, terminateAt: null }
  if (alreadyClosed) return { confirmed: true, code: alreadyClosed.code, reason: alreadyClosed.reason, errors, native: { ...native, disposition: 'graceful', closeAt: alreadyClosed.at } }
  return new Promise(resolve => {
    let done = false
    let grace: ReturnType<typeof setTimeout> | undefined
    let expiry: ReturnType<typeof setTimeout> | undefined
    const finish = (confirmed: boolean, code: number | null, reason: string) => {
      if (done) return
      done = true; clearTimeout(grace); clearTimeout(expiry)
      resolve({ confirmed, code, reason, errors, native: { ...native } })
    }
    const terminate = () => {
      if (done || native.terminateAt !== null) return
      native.terminateAt = now()
      try { socket.terminate() } catch (error) { errors.push(`terminate: ${String(error)}`) }
    }
    socket.on('close', (code, reason) => {
      const at = now()
      if (done) return
      native.closeAt = at
      if (at >= deadline) { terminate(); finish(false, null, 'close event was not before the original native deadline'); return }
      native.disposition = native.terminateAt === null ? 'graceful' : 'forced'
      finish(true, code, String(reason))
    })
    socket.on('error', error => { if (!done) errors.push(`socket: ${String(error)}`) })
    expiry = setTimeout(() => {
      terminate()
      finish(false, null, `no observed close before the original ${totalBudgetMs}ms deadline`)
    }, totalBudgetMs)
    grace = setTimeout(terminate, graceMs)
    try { socket.close(1000, 'capacity measurement complete') } catch (error) {
      errors.push(`close: ${String(error)}`)
      terminate()
    }
  })
}

export interface IdentityHttpEvidence {
  origin: string; path: '/__test/identity'; deadline: number; startedAt: number
  status: number | null; headers: Record<string, unknown> | null
  expectedNonce: string; observedNonce: unknown; bodyBytes: number; bodyBase64: string; bodySha256: string
  bodyCap: 4096; overflow: boolean; responseEndedAt: number | null; requestClosedAt: number | null; socketClosedAt: number | null
  requestAcquired: boolean; socketAcquired: boolean; cancelAt: number | null; completedAt: number | null
  errors: { source: string; error: string; intentionalCancellation: boolean }[]
}
export interface IdentityHttpClosure {
  confirmed: boolean; requestClosed: boolean; socket: 'closed' | 'not-acquired' | 'unconfirmed'
  joinBudgetMs: 3000; beganAt: number; deadline: number; joinedAt: number; failures: string[]
}
export interface OwnedIdentityGet {
  evidence: IdentityHttpEvidence
  result: Promise<Record<string, unknown>>
  cancel(reason: unknown): Promise<IdentityHttpClosure>
  cleanup(): Promise<IdentityHttpClosure>
}
/** A single owned, non-redirecting control GET; never a rawRequest inactivity race. */
export function ownedIdentityGet(origin: string, nonce: string, deadline: number, options: {
  now?: () => number
  factory?: NativeWitnessOptions['httpFactory']
} = {}): OwnedIdentityGet {
  const now = options.now ?? (() => performance.now())
  const parsed = new URL(origin)
  if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1' || parsed.pathname !== '/' || parsed.search || parsed.hash || parsed.username || parsed.password) throw new Error('Identity GET requires the validated owned loopback origin')
  canonicalPort(parsed.port, 'identity GET port')
  remaining(deadline, now, 'identity GET before acquisition')
  let request: ClientRequest | undefined
  let socket: Socket | undefined
  let acquisitionFinished = false
  let settled = false
  let ended = false
  let requestClosed = false
  let socketClosed = false
  let cancellation: Error | null = null
  let cancellationActionsComplete = true
  let joining: Promise<IdentityHttpClosure> | null = null
  let joinWindow: { beganAt: number; deadline: number } | null = null
  let joinChanged: (() => void) | undefined
  let expiry: ReturnType<typeof setTimeout> | undefined
  const chunks: Buffer[] = []
  const bodyHash = createHash('sha256')
  let body: Record<string, unknown> | null = null
  const evidence: IdentityHttpEvidence = {
    origin, path: '/__test/identity', deadline, startedAt: now(), status: null, headers: null,
    expectedNonce: nonce, observedNonce: null, bodyBytes: 0, bodyBase64: '', bodySha256: sha256(Buffer.alloc(0)), bodyCap: 4096, overflow: false,
    responseEndedAt: null, requestClosedAt: null, socketClosedAt: null, requestAcquired: false, socketAcquired: false,
    cancelAt: null, completedAt: null, errors: [],
  }
  let resolveResult!: (value: Record<string, unknown>) => void
  let rejectResult!: (error: unknown) => void
  const result = new Promise<Record<string, unknown>>((resolve, reject) => { resolveResult = resolve; rejectResult = reject })
  // Install the rejection observer before any HTTP event or cancellation.
  void result.catch(() => {})
  const closure = (): IdentityHttpClosure => ({
    confirmed: acquisitionFinished && cancellationActionsComplete &&
      (!evidence.requestAcquired || (requestClosed && evidence.requestClosedAt! <= joinWindow!.deadline)) &&
      (!evidence.socketAcquired || (socketClosed && evidence.socketClosedAt! <= joinWindow!.deadline)),
    requestClosed: !evidence.requestAcquired || requestClosed,
    socket: evidence.socketAcquired ? socketClosed ? 'closed' : 'unconfirmed' : 'not-acquired',
    joinBudgetMs: 3000, beganAt: joinWindow!.beganAt, deadline: joinWindow!.deadline, joinedAt: now(),
    failures: evidence.errors.filter(error => !error.intentionalCancellation).map(error => `${error.source}: ${error.error}`),
  })
  const cleanup = (): Promise<IdentityHttpClosure> => joining ??= new Promise(resolve => {
    const beganAt = now()
    joinWindow = { beganAt, deadline: beganAt + 3000 }
    let done = false
    const timer = setTimeout(() => finish(true), NATIVE_CONTRACT.httpJoinMs)
    const finish = (expired: boolean) => {
      if (done) return
      const outcome = closure()
      if (!expired && !outcome.confirmed && now() < joinWindow!.deadline) return
      done = true; clearTimeout(timer)
      if (!outcome.confirmed) outcome.failures.push('Owned identity request/socket close unconfirmed after3000ms')
      resolve(outcome)
    }
    joinChanged = () => finish(false)
    finish(false)
  })
  const cancel = (reason: unknown): Promise<IdentityHttpClosure> => {
    if (!cancellation) {
      cancellation = new Error(`Owned identity GET cancelled: ${String(reason)}`)
      evidence.cancelAt = now()
      cancellationActionsComplete = false
      if (!settled) { settled = true; rejectResult(reason) }
      clearTimeout(expiry)
      const join = cleanup()
      try { request?.destroy(cancellation) } catch (error) { evidence.errors.push({ source: 'request-destroy', error: String(error), intentionalCancellation: false }) }
      try { if (socket && !socketClosed) socket.destroy(cancellation) } catch (error) { evidence.errors.push({ source: 'socket-destroy', error: String(error), intentionalCancellation: false }) }
      cancellationActionsComplete = true
      joinChanged?.()
      return join
    }
    return cleanup()
  }
  const failure = (source: string, error: unknown) => {
    const intentionalCancellation = error === cancellation
    evidence.errors.push({ source, error: String(error), intentionalCancellation })
    if (!intentionalCancellation) {
      if (!settled) { settled = true; rejectResult(error) }
      void cancel(error)
    }
    joinChanged?.()
  }
  const complete = () => {
    if (settled || !ended || !requestClosed || !socketClosed || !body) return
    if (now() > deadline) { failure('deadline', new Error('Identity GET end/closure exceeded the original GC deadline')); return }
    settled = true; evidence.completedAt = now(); clearTimeout(expiry); resolveResult(body)
  }
  expiry = setTimeout(() => failure('deadline', new Error('Identity GET original GC deadline expired')), remaining(deadline, now, 'identity GET'))
  try {
    const factory = options.factory ?? httpRequest
    request = factory(new URL('/__test/identity', origin), { method: 'GET', agent: false, headers: { 'Accept-Encoding': 'identity' } }, message => {
      evidence.status = message.statusCode ?? null; evidence.headers = { ...message.headers }
      message.on('error', error => failure('response', error))
      message.on('aborted', () => failure('response-aborted', new Error('Identity response aborted')))
      message.on('close', () => { if (!ended && !cancellation) failure('response-close', new Error('Identity response closed before end')) })
      message.on('data', (chunk: Buffer) => {
        const bytes = Buffer.from(chunk)
        bodyHash.update(bytes); evidence.bodyBytes += bytes.length
        const retained = chunks.reduce((sum, item) => sum + item.length, 0)
        if (retained < 4096) chunks.push(bytes.subarray(0, 4096 - retained))
        evidence.bodyBase64 = Buffer.concat(chunks).toString('base64'); evidence.bodySha256 = bodyHash.copy().digest('hex')
        if (evidence.bodyBytes > 4096) { evidence.overflow = true; failure('body-cap', new Error('Identity response exceeds4096 bytes')) }
      })
      message.on('end', () => {
        ended = true; evidence.responseEndedAt = now()
        if (cancellation) return
        try {
          if (message.statusCode !== 200 || (message.headers['content-encoding'] !== undefined && message.headers['content-encoding'] !== 'identity')) throw new Error('Identity GET requires200 and an unencoded body')
          const decoded: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)))
          if (!record(decoded)) throw new Error('Identity body is not an object')
          evidence.observedNonce = decoded.isolateNonce
          if (decoded.harness !== 'orbit-worker-contract' || decoded.storeName !== 'catalog-v1' ||
              decoded.entry !== 'tests/cloudflare/runtime/entry.ts' || decoded.isolateNonce !== nonce) throw new Error('Identity GET harness/nonce mismatch')
          body = decoded; complete()
        } catch (error) { failure('identity', error) }
      })
      if (cancellation) {
        try { message.destroy() } catch (error) { failure('response-destroy', error) }
      }
    })
    evidence.requestAcquired = true
    request.on('error', error => failure('request', error))
    request.on('close', () => { requestClosed = true; evidence.requestClosedAt = now(); complete(); joinChanged?.() })
    request.on('socket', assigned => {
      socket = assigned; evidence.socketAcquired = true
      assigned.on('error', error => failure('socket', error))
      assigned.on('close', () => { socketClosed = true; evidence.socketClosedAt = now(); complete(); joinChanged?.() })
      if (cancellation) {
        try { assigned.destroy(cancellation) } catch (error) { failure('socket-destroy', error) }
      }
    })
    if (cancellation) request.destroy(cancellation)
    else request.end()
  } catch (error) { failure('acquisition', error) } finally {
    acquisitionFinished = true
    joinChanged?.()
  }
  return { evidence, result, cancel, cleanup: () => settled ? cleanup() : cancel(new Error('Identity GET finalized before completion')) }
}
/** The requested direct `ws` client, loaded by name so type checking does not depend on its integration; a missing module names the request. */
export async function loadWs(): Promise<WsModule> {
  const moduleName = 'ws'
  try {
    const loaded = await import(moduleName) as Record<string, unknown> & { default?: unknown }
    const WebSocketClass = (loaded.WebSocket ?? loaded.default) as WsModule['WebSocket'] | undefined
    const WebSocketServerClass = loaded.WebSocketServer as WsModule['WebSocketServer'] | undefined
    if (typeof WebSocketClass !== 'function' || typeof WebSocketServerClass !== 'function') throw new Error('ws does not export WebSocket/WebSocketServer')
    return { WebSocket: WebSocketClass, WebSocketServer: WebSocketServerClass }
  } catch (error) {
    throw new Error(`The direct test dependency ws@8.21.0 is not available (independent/author04-capacity-dependency-request.json): ${String(error)}`)
  }
}
async function fetchJson(url: string, timeoutMs: number | (() => AbortSignal), discoveries: InspectorAcquisition['httpDiscovery']): Promise<unknown> {
  const evidence: InspectorAcquisition['httpDiscovery'][number] = { url, status: null, headers: null, text: null, textUtf8Bytes: null, failure: null }
  discoveries.push(evidence)
  try {
    const response = await fetch(url, { redirect: 'manual', signal: typeof timeoutMs === 'number' ? AbortSignal.timeout(timeoutMs) : timeoutMs() })
    evidence.status = response.status
    evidence.headers = Object.fromEntries(response.headers)
    evidence.text = await response.text()
    // fetch may decode an encoding; these are retained UTF-8 text bytes, never
    // mislabeled as the wire size. Even a status/JSON refusal keeps what arrived.
    evidence.textUtf8Bytes = Buffer.byteLength(evidence.text, 'utf8')
    if (response.status !== 200) throw new Error(`${url} answered ${response.status}`)
    return JSON.parse(evidence.text) as unknown
  } catch (error) {
    evidence.failure = String(error)
    throw error
  }
}
/** Only native first discovery adapts its already-charged deadline to the integer-only host API. */
export function fetchNativeFirstDiscoveryJson(
  url: string, originalDeadline: number, discoveries: InspectorAcquisition['httpDiscovery'], now = () => performance.now(),
): Promise<unknown> {
  return fetchJson(url, () => {
    const ms = remaining(originalDeadline, now, 'native first discovery')
    const wholeMs = Math.floor(ms)
    if (wholeMs < 1) throw new Error(`native first discovery: insufficient whole-millisecond budget (${ms} ms remaining)`)
    return AbortSignal.timeout(wholeMs)
  }, discoveries)
}
function expectSingleton(value: unknown, label: string): InspectorTarget {
  if (!Array.isArray(value) || value.length !== 1) throw new Error(`${label} must list exactly one target, got ${Array.isArray(value) ? value.length : typeof value}`)
  const target = value[0] as Partial<InspectorTarget>
  if (typeof target?.id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(target.id)) throw new Error(`${label}: target id is not a UUID`)
  if (target.type !== PINNED_WRANGLER.targetType || target.title !== PINNED_WRANGLER.targetTitle || target.description !== PINNED_WRANGLER.targetDescription) {
    throw new Error(`${label}: target shape ${JSON.stringify({ type: target.type, title: target.title, description: target.description })} is not the pinned Wrangler proxy singleton`)
  }
  if (typeof target.webSocketDebuggerUrl !== 'string') throw new Error(`${label}: target has no webSocketDebuggerUrl`)
  return target as InspectorTarget
}

export class Inspector {
  private readonly pending = new Map<number, Pending>()
  private nextId = 1
  private opened = false
  private closedEvent: { code: number; reason: string; at: number } | null = null
  private readonly contexts = new Map<number, ContextDescriptor>()
  private revision = 0
  private phase: ContextPhase = 'socket-owned'
  private contextFailure: string | null = null
  private bindingFailure: string | null = null
  private ownershipFailure: string | null = null
  private closing: Promise<CloseOutcome> | null = null
  private profileCleanup: Promise<ProfileCleanup> | null = null
  private nativePreparation?: NativePreparation
  private readonly nativeFrames = new NativeFrameEvidence()
  private readonly nativeProfiles: { id: number; arrivedAt: number; bytes: number; sha256: string; rawUtf8: string; profile: RawCpuProfile }[] = []
  private nativePermit: string | null = null
  private nativeProfileBusy: 'start' | 'stop' | 'cleanup' | null = null
  private readonly nativeOwner = {
    client: randomUUID(), claim: null as null | { path: string; sha256: string; content: unknown; inode: number },
    claimFailure: null as string | null, enableEpoch: 0, startEpoch: 0, startedInEpoch: false, mayBeActive: false,
    stopFailure: null as string | null,
    stopEffect: null as NativeStopEffect | null, stopEffects: [] as NativeStopEffect[],
    resetMayHaveBeenSent: false, resetEnableEpoch: null as number | null, resetAcknowledged: false,
  }
  private nativeGcBusy = false
  private nativeGcFailed = false
  private readonly gcCycles: {
    sequence: number; beganAt: number; deadline: number; enable: RpcTrace; gc: RpcTrace; barrier: RpcTrace; finalIdentity: RpcTrace
    http: IdentityHttpEvidence | null; completedAt: number | null; failure: string | null; possibleQueuedEffect: boolean
    cleanup: IdentityHttpClosure | null; secondaryFailures: string[]; lateReplies: { at: number; sha256: string; bytes: number }[]
  }[] = []
  private readonly gcHttp = new Map<number, OwnedIdentityGet>()
  private gcHttpCleanup: Promise<{ outcomes: IdentityHttpClosure[]; failures: string[] }> | null = null
  private cancelNativeGc: ((error: Error) => void) | null = null
  private readonly resultFrames = new WeakMap<object, { bytes: Buffer; arrivedAt: number; id: number; method: string }>()
  readonly profileState = {
    enableMayHaveBeenSent: false, enableAcknowledged: false, startMayHaveBeenSent: false, startAcknowledged: false,
    stopAcknowledged: false, stopIsolateId: null as string | null, disableAcknowledged: false,
    operations: [] as { method: string; acknowledged: boolean; failure: string | null; result?: unknown; trace?: RpcTrace }[],
  }
  readonly events = {
    contextClears: 0, contextsCreated: 0, contextsDestroyed: 0, otherEvents: 0,
    lifecycleCount: 0, history: [] as ContextEvent[], maxLiveContexts: 0, maxDescriptorBytes: 0,
    overflows: [] as { kind: keyof typeof CONTEXT_LIMITS; limit: number; observed: number }[],
    protocolErrors: [] as string[], closes: [] as { code: number; reason: string }[],
  }
  private constructor(readonly endpoints: OwnedEndpoints, readonly target: InspectorTarget, readonly version: InspectorVersion, private readonly socket: WsSocket, readonly isolateNonce: string, readonly acquisition: InspectorAcquisition, private readonly native?: NativeConfiguration) {
    socket.on('message', data => this.receive(typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer)))
    socket.on('close', (code, reason) => {
      this.closedEvent = { code, reason: String(reason), at: this.now() }
      this.events.closes.push({ code, reason: String(reason) })
      this.ownershipFailure ??= `Inspector socket closed (${code} ${String(reason)})`
      this.invalidateBinding(this.ownershipFailure)
      this.failPending(new Error(`Inspector socket closed (${code} ${String(reason)})`))
    })
    socket.on('error', error => {
      this.ownershipFailure ??= `Inspector socket error: ${error.message}`
      this.invalidateBinding(this.ownershipFailure)
      this.failPending(new Error(this.ownershipFailure))
    })
  }

  /**
   * C4: exactly one disabled-to-enabled inventory, at most 16 explicit nonce
   * evaluations, then a second correlated isolate identity. No default-context
   * guess, polling, reconnect or rebinding. Four discovery/open budgets plus at
   * most twenty 30s RPC budgets are timed I/O allowances, not a wall-clock SLA.
   */
  static async connect(endpoints: OwnedEndpoints, expected: { isolateNonce: string; native?: NativeMode }, timeoutMs = 10_000): Promise<Inspector> {
    let native: NativeConfiguration | undefined
    if (expected.native) {
      native = nativeModes.get(expected.native)
      if (!native || native.used) throw new Error('Native mode is an immutable, single-client capability; copied/reused modes are refused')
      native.used = true
    }
    const expectedUrl = `ws://${endpoints.host}:${endpoints.inspectorPort}${PINNED_WRANGLER.webSocketPath}`
    const acquisition: InspectorAcquisition = {
      phase: '/json', phases: ['/json'], httpDiscovery: [], json: null, jsonList: null, version: null, expectedEndpoint: expectedUrl, expectedNonce: expected.isolateNonce,
      socketAcquired: false, initialIsolateId: null, finalIsolateId: null, disableMayHaveBeenSent: false, disableAcknowledged: false, enableAcknowledged: false,
      discoveryRevision: null, nonceResults: [], binding: null,
      budgets: { discoveryOrOpenMs: timeoutMs, rpcMs: 30000, maximumAcquisitionRpcs: 20, runtimeRestoreMs: Math.min(timeoutMs, 3_000), socketTerminationMs: Math.min(timeoutMs, 3_000), timedIoOnly: true },
    }
    let inspector: Inspector | undefined
    try {
      // Native file/process provenance shares the existing first discovery budget.
      const firstDeadline = performance.now() + timeoutMs
      const preparation = native ? await beforeDeadline(prepareNative(native, endpoints), firstDeadline, () => performance.now(), 'native preparation') : undefined
      acquisition.json = await (native
        ? fetchNativeFirstDiscoveryJson(`${endpoints.inspectorOrigin}/json`, firstDeadline, acquisition.httpDiscovery)
        : fetchJson(`${endpoints.inspectorOrigin}/json`, timeoutMs, acquisition.httpDiscovery))
      const listing = expectSingleton(acquisition.json, '/json')
      acquisition.phase = '/json/list'; acquisition.phases.push(acquisition.phase)
      acquisition.jsonList = await fetchJson(`${endpoints.inspectorOrigin}/json/list`, timeoutMs, acquisition.httpDiscovery)
      const list = expectSingleton(acquisition.jsonList, '/json/list')
      if (list.id !== listing.id || list.webSocketDebuggerUrl !== listing.webSocketDebuggerUrl) throw new Error('/json and /json/list describe different targets')
      if (listing.webSocketDebuggerUrl !== expectedUrl) throw new Error(`The target endpoint ${listing.webSocketDebuggerUrl} is not the owned ${expectedUrl}`)
      acquisition.phase = '/json/version'; acquisition.phases.push(acquisition.phase)
      acquisition.version = await fetchJson(`${endpoints.inspectorOrigin}/json/version`, timeoutMs, acquisition.httpDiscovery)
      const version = acquisition.version as Partial<InspectorVersion> | null
      if (version?.Browser !== PINNED_WRANGLER.browser || version?.['Protocol-Version'] !== PINNED_WRANGLER.protocolVersion) {
        throw new Error(`/json/version ${JSON.stringify(version)} is not the pinned ${PINNED_WRANGLER.browser} / ${PINNED_WRANGLER.protocolVersion}`)
      }
      const ws = await loadWs()
      const socket = native?.witness?.socketFactory
        ? native.witness.socketFactory(listing.webSocketDebuggerUrl)
        : new ws.WebSocket(listing.webSocketDebuggerUrl, { headers: { Origin: endpoints.inspectorOrigin }, handshakeTimeout: timeoutMs, perMessageDeflate: false })
      acquisition.socketAcquired = true
      inspector = new Inspector(endpoints, listing, version as InspectorVersion, socket, expected.isolateNonce, acquisition, native)
      inspector.nativePreparation = preparation
      inspector.setPhase('socket-owned')
      await inspector.open(timeoutMs)
      inspector.setPhase('initial-isolate')
      acquisition.initialIsolateId = await inspector.isolateId()
      inspector.requireAcquisition()
      inspector.setPhase('disable')
      acquisition.disableMayHaveBeenSent = true
      await inspector.call('Runtime.disable')
      acquisition.disableAcknowledged = true
      inspector.requireAcquisition()
      // Clear only the working inventory, after disable acknowledgement. The
      // lifecycle history, revision and clear counts deliberately survive.
      inspector.contexts.clear()
      inspector.setPhase('enable')
      await inspector.call('Runtime.enable', {}, 30_000, () => {
        acquisition.enableAcknowledged = true
        acquisition.discoveryRevision = inspector!.revision
        inspector!.setPhase('discover')
      })
      inspector.requireAcquisition()
      const advertised = [...inspector.contexts.values()]
      if (!advertised.length) throw new Error('Runtime.enable advertised no live execution context for nonce discovery')
      const matches: ContextDescriptor[] = []
      for (const context of advertised) {
        inspector.requireAcquisition()
        const raw = await inspector.call('Runtime.evaluate', { expression: 'globalThis.__orbitIsolateNonce', returnByValue: true, uniqueContextId: context.uniqueId })
        const evaluated = { context, raw, matches: false }
        acquisition.nonceResults.push(evaluated)
        inspector.requireAcquisition()
        const nonce = inspector.nonceValue(raw)
        const matchesNonce = nonce === expected.isolateNonce
        evaluated.matches = matchesNonce
        if (matchesNonce) matches.push(context)
      }
      if (matches.length !== 1) throw new Error(`Nonce discovery needs exactly one live match to the owned HTTP nonce; found ${matches.length} in ${advertised.length} contexts`)
      inspector.setPhase('final-isolate')
      acquisition.finalIsolateId = await inspector.isolateId()
      inspector.requireAcquisition()
      if (acquisition.finalIsolateId !== acquisition.initialIsolateId) throw new Error(`The inspected isolate changed during acquisition: ${acquisition.initialIsolateId} -> ${acquisition.finalIsolateId}`)
      inspector.boundIsolateId = acquisition.initialIsolateId
      acquisition.binding = matches[0]
      inspector.setPhase('bound')
      return inspector
    } catch (error) {
      const cleanup: InspectorAcquisitionCleanup = {
        runtime: {
          attempted: false, enabledConfirmed: acquisition.enableAcknowledged, result: null, failure: null,
          limitation: 'A restorative enable confirms only the Runtime domain; it cannot restore bindings, compiled scripts, formatter/debugger state or the observation gap removed by disable.',
        },
        socket: { acquired: false }, pendingCallsAfterCleanup: 0, failures: [],
      }
      let closure: CloseOutcome = { confirmed: false, code: null, reason: 'no socket acquired' }
      if (inspector) {
        // One <=3s restoration and an independent <=3s terminate/close join.
        // A failed restoration never replaces the primary acquisition error.
        if (acquisition.disableMayHaveBeenSent && !acquisition.enableAcknowledged) {
          inspector.setPhase('runtime-restore')
          // An open retained socket alone does not retain target attribution:
          // detach/ownership loss or a protocol failure forbids another RPC.
          if (inspector.channelUsable()) {
            cleanup.runtime.attempted = true
            try {
              cleanup.runtime.result = await inspector.call('Runtime.enable', {}, Math.min(timeoutMs, 3_000))
              if (!inspector.channelUsable()) throw new Error(inspector.ownershipFailure ?? inspector.events.protocolErrors[0] ?? 'the already-owned channel became unusable during restorative enable')
              cleanup.runtime.enabledConfirmed = true
            } catch (restoreError) {
              cleanup.runtime.failure = `Runtime-state-unconfirmed: ${String(restoreError)}`
            }
          } else {
            cleanup.runtime.failure = `Runtime-state-unconfirmed: the already-owned channel cannot confirm a restorative enable (${inspector.ownershipFailure ?? inspector.events.protocolErrors[0] ?? 'channel unavailable'})`
          }
          if (cleanup.runtime.failure) cleanup.failures.push(cleanup.runtime.failure)
        }
        try {
          closure = await inspector.terminateAndConfirm(Math.min(timeoutMs, 3_000))
          if (!closure.confirmed) cleanup.failures.push(`socket closure unconfirmed: ${closure.reason}`)
        } catch (closeError) {
          closure = { confirmed: false, code: null, reason: String(closeError) }
          cleanup.failures.push(`socket cleanup: ${String(closeError)}`)
        } finally {
          inspector.failPending(new Error('Inspector acquisition failed'))
          cleanup.pendingCallsAfterCleanup = inspector.pending.size
        }
        cleanup.socket = { acquired: true, ...closure }
      }
      throw new InspectorAcquisitionError(error, closure, acquisition, cleanup, inspector?.evidence() ?? null)
    }
  }
  boundIsolateId = ''
  private now(): number { return this.native?.witness?.now?.() ?? performance.now() }
  private setPhase(phase: ContextPhase): void {
    this.phase = phase
    this.acquisition.phase = phase
    this.acquisition.phases.push(phase)
  }
  /** Snapshot obtained evidence, not a placeholder or an approval of the interval. */
  evidence() {
    return structuredClone({
      acquisition: this.acquisition, target: this.target, version: this.version, isolateId: this.boundIsolateId || null,
      binding: this.acquisition.binding, bindingFailure: this.bindingFailure, ownershipFailure: this.ownershipFailure,
      contextFailure: this.contextFailure, revision: this.revision, liveContexts: [...this.contexts.values()],
      contextLimits: CONTEXT_LIMITS, events: this.events, profileState: this.profileState, pendingCalls: this.pending.size,
      ...(this.native ? { native: {
        contract: NATIVE_CONTRACT, kind: this.native.kind, permission: this.native.permission,
        provenance: this.nativePreparation?.provenance ?? null, owner: this.nativeOwner,
        frames: this.nativeFrames, completeProfiles: this.nativeProfiles, gcCycles: this.gcCycles,
        qualification: 'Heap-only/no-action cleanup does not confirm a predecessor’s global custom-profiler state',
      } } : {}),
    })
  }
  private channelUsable(): boolean { return this.opened && this.socket.readyState === 1 && !this.closedEvent && !this.ownershipFailure && !this.events.protocolErrors.length }
  private invalidateBinding(reason: string): void {
    this.bindingFailure ??= reason
    this.cancelNativeGc?.(new Error(reason))
  }
  private requireAcquisition(): void {
    if (this.contextFailure) throw new Error(this.contextFailure)
    if (!this.channelUsable()) throw new Error(this.ownershipFailure ?? this.events.protocolErrors[0] ?? 'Inspector channel is not usable during acquisition')
    if (this.acquisition.discoveryRevision !== null && this.revision !== this.acquisition.discoveryRevision) throw new Error('Execution context inventory changed during nonce discovery')
  }
  private requireBinding(operation: string): void {
    if (!this.acquisition.binding || !this.boundIsolateId) throw new Error(`No explicit execution context is bound: ${operation}`)
    if (this.bindingFailure || this.contextFailure || !this.channelUsable()) throw new Error(`Inspector binding invalid: ${this.bindingFailure ?? this.contextFailure ?? this.ownershipFailure ?? 'channel unavailable'} (${operation})`)
  }
  private open(timeoutMs: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Inspector socket open timed out after ${timeoutMs} ms`)), timeoutMs)
      this.socket.on('open', () => { clearTimeout(timer); this.opened = true; resolve() })
      this.socket.on('error', error => { clearTimeout(timer); reject(new Error(`Inspector socket failed before open: ${error.message}`)) })
      this.socket.on('close', (code, reason) => { clearTimeout(timer); if (!this.opened) reject(new Error(`Inspector socket closed before open (${code} ${String(reason)})`)) })
      this.socket.on('unexpected-response', (_request, response) => { clearTimeout(timer); reject(new Error(`Inspector handshake rejected: ${response.statusCode ?? '?'} ${response.statusMessage ?? ''}`.trim())) })
    })
  }
  /** Terminate the owned socket and observe its close event within a bound; an already closed socket is confirmed immediately. */
  private terminateAndConfirm(timeoutMs: number): Promise<CloseOutcome> {
    if (this.closedEvent) return Promise.resolve({ confirmed: true, code: this.closedEvent.code, reason: this.closedEvent.reason })
    return new Promise<CloseOutcome>(resolve => {
      const timer = setTimeout(() => resolve({ confirmed: false, code: null, reason: `no close event within ${timeoutMs} ms after terminate` }), timeoutMs)
      this.socket.on('close', (code, reason) => { clearTimeout(timer); resolve({ confirmed: true, code, reason: String(reason) }) })
      try {
        this.socket.terminate()
      } catch (error) {
        clearTimeout(timer)
        resolve({ confirmed: false, code: null, reason: `terminate threw: ${String(error)}` })
      }
    })
  }
  private protocolFailure(failure: string): void {
    // Once native diagnostics overflow, even repeated malformed traffic cannot
    // create an unbounded metadata/error tail.
    if (!this.native || !this.nativeFrames.overflow || !this.events.protocolErrors.length) this.events.protocolErrors.push(failure)
    this.invalidateBinding(failure)
    this.failPending(new Error(failure))
  }
  private failContext(failure: string): void {
    this.contextFailure ??= failure
    this.invalidateBinding(failure)
    // Keep correlated effect acknowledgements observable. The post-await
    // acquisition/binding guard rejects the result; the original RPC still has
    // its 30s bound. Discarding its pending entry here would hide a successful
    // Runtime.enable or Profiler.start and distort subsequent cleanup.
  }
  private overflow(kind: keyof typeof CONTEXT_LIMITS, observed: number): void {
    const prior = this.events.overflows.find(item => item.kind === kind)
    if (prior) prior.observed = Math.max(prior.observed, observed)
    else this.events.overflows.push({ kind, limit: CONTEXT_LIMITS[kind], observed })
    this.failContext(`Execution context ${kind} cap exceeded: ${observed} > ${CONTEXT_LIMITS[kind]}`)
  }
  private retainContextEvent(entry: ContextEvent): void {
    this.events.lifecycleCount++
    if (this.events.lifecycleCount > CONTEXT_LIMITS.history) this.overflow('history', this.events.lifecycleCount)
    else this.events.history.push(entry)
  }
  private contextEvent(method: string, params: unknown): void {
    this.revision++
    const entry: ContextEvent = { kind: method === 'Runtime.executionContextCreated' ? 'created' : method === 'Runtime.executionContextDestroyed' ? 'destroyed' : 'cleared', phase: this.phase, revision: this.revision }
    const bound = this.acquisition.binding
    if (entry.kind === 'created') {
      this.events.contextsCreated++
      const context = record(params) ? params.context : undefined
      if (!record(context) || !positiveId(context.id) || typeof context.uniqueId !== 'string' || !context.uniqueId
        || typeof context.name !== 'string' || typeof context.origin !== 'string'
        || ('auxData' in context && !record(context.auxData))) {
        entry.descriptor = null
        entry.unavailable = 'Malformed executionContextCreated descriptor: positive id, uniqueId, name, origin and optional object auxData required'
        this.failContext(entry.unavailable)
      } else {
        // Fixed-order projection of the pinned schema. Unknown fields are
        // counted, never used as identity. No truncation or coercion.
        const descriptor: ContextDescriptor = { id: context.id, uniqueId: context.uniqueId, name: context.name, origin: context.origin }
        if ('auxData' in context) descriptor.auxData = context.auxData as Record<string, unknown>
        const bytes = Buffer.byteLength(JSON.stringify(descriptor), 'utf8')
        entry.descriptorBytes = bytes
        entry.unknownFields = Object.keys(context).filter(key => !['id', 'uniqueId', 'name', 'origin', 'auxData'].includes(key)).length
        this.events.maxDescriptorBytes = Math.max(this.events.maxDescriptorBytes, bytes)
        if (bytes > CONTEXT_LIMITS.descriptorBytes) {
          entry.descriptor = null
          entry.unavailable = 'Full descriptor unavailable: descriptor byte cap exceeded'
          this.overflow('descriptorBytes', bytes)
        } else {
          entry.descriptor = descriptor
          const previous = this.contexts.get(descriptor.id)
          const sameUnique = [...this.contexts.values()].find(item => item.uniqueId === descriptor.uniqueId && item.id !== descriptor.id)
          if (sameUnique) this.failContext('Execution context uniqueId was advertised under two numeric identities')
          if (bound && (bound.id === descriptor.id || bound.uniqueId === descriptor.uniqueId)
            && (bound.id !== descriptor.id || bound.uniqueId !== descriptor.uniqueId)) this.invalidateBinding('Bound execution context was replaced')
          const count = this.contexts.size + (previous ? 0 : 1)
          this.events.maxLiveContexts = Math.max(this.events.maxLiveContexts, count)
          if (count > CONTEXT_LIMITS.live) this.overflow('live', count)
          else if (!this.contextFailure) this.contexts.set(descriptor.id, descriptor)
        }
      }
    } else if (entry.kind === 'destroyed') {
      this.events.contextsDestroyed++
      if (!record(params) || !positiveId(params.executionContextId) || typeof params.executionContextUniqueId !== 'string' || !params.executionContextUniqueId) {
        entry.unavailable = 'Malformed executionContextDestroyed identity'
        this.failContext(entry.unavailable)
      } else {
        entry.executionContextId = params.executionContextId
        entry.executionContextUniqueId = params.executionContextUniqueId
        const previous = this.contexts.get(params.executionContextId)
        if (previous && previous.uniqueId !== params.executionContextUniqueId) this.failContext('Destroyed execution context has a conflicting uniqueId')
        if (bound && (bound.id === params.executionContextId || bound.uniqueId === params.executionContextUniqueId)) this.invalidateBinding('Bound execution context was destroyed')
        this.contexts.delete(params.executionContextId)
      }
    } else {
      this.events.contextClears++
      entry.clearCount = this.events.contextClears
      if (params !== undefined && !record(params)) {
        entry.unavailable = 'Malformed executionContextsCleared params'
        this.failContext(entry.unavailable)
      }
      this.contexts.clear()
      if (bound) this.invalidateBinding('Bound execution contexts were cleared')
    }
    this.retainContextEvent(entry)
    if (!bound && this.acquisition.discoveryRevision !== null && (this.phase === 'discover' || this.phase === 'final-isolate')) {
      this.failContext('Execution context inventory changed during nonce discovery')
    }
  }
  private receive(bytes: Buffer): void {
    const arrivedAt = this.now()
    const capture = (disposition: string, id: number | null = null, method: string | null = null) => {
      if (!this.native) return true
      const kept = this.nativeFrames.capture(bytes, { arrivedAt, id, method, phase: this.phase, disposition })
      if (!kept) this.protocolFailure(`Native frame evidence overflow: ${this.nativeFrames.overflow?.reason}`)
      return kept
    }
    let text: string
    let decoded: unknown
    try {
      text = this.native ? new TextDecoder('utf-8', { fatal: true }).decode(bytes) : bytes.toString('utf8')
      decoded = JSON.parse(text)
    } catch (error) {
      capture('rejected-json-or-utf8')
      return this.protocolFailure(`Inspector message is not JSON: ${String(error)}`)
    }
    // Valid JSON is not enough: a CDP message is a plain object. null, primitives and arrays are protocol failures handled here, never callback exceptions.
    if (decoded === null || typeof decoded !== 'object' || Array.isArray(decoded)) {
      capture('rejected-non-object')
      return this.protocolFailure(`Inspector message is not a CDP object: ${text.slice(0, 120)}`)
    }
    const message = decoded as { id?: unknown; method?: unknown; params?: unknown; result?: unknown; error?: unknown }
    if (message.id === undefined) {
      if (typeof message.method !== 'string') { capture('rejected-event'); return this.protocolFailure('Inspector event has no string method') }
      if (['Runtime.executionContextCreated', 'Runtime.executionContextDestroyed', 'Runtime.executionContextsCleared'].includes(message.method)) {
        const previous = this.contextFailure
        this.contextEvent(message.method, message.params)
        if (this.contextFailure !== previous) capture('rejected-context-event')
      } else {
        this.events.otherEvents++
        if (message.method === 'Inspector.detached' || message.method === 'Target.detachedFromTarget' || message.method === 'Target.targetDestroyed') {
          this.ownershipFailure ??= `Inspector target ownership changed: ${message.method}`
          this.invalidateBinding(this.ownershipFailure)
          this.failPending(new Error(this.ownershipFailure))
        }
      }
      return
    }
    if (!Number.isSafeInteger(message.id) || (this.native && !positiveInt32(message.id))) {
      capture('rejected-id')
      return this.protocolFailure(`Inspector message has a non-numeric, unsafe or out-of-contract id: ${text.slice(0, 120)}`)
    }
    const waiting = this.pending.get(message.id as number)
    // An id this client never issued is a legitimate proxy-internal response; it is ignored.
    if (!waiting) {
      const expired = this.gcCycles.find(cycle => cycle.gc.id === message.id && (cycle.failure !== null || cycle.gc.failedAt !== undefined))
      if (expired) {
        if (capture('late-original-gc-reply', message.id as number, 'HeapProfiler.collectGarbage')) expired.lateReplies.push({ at: arrivedAt, bytes: bytes.length, sha256: sha256(bytes) })
      }
      const expiredProfile = this.profileState.operations.find(operation => operation.trace?.id === message.id && operation.trace?.failedAt !== undefined)
      if (expiredProfile) capture('late-native-profile-reply', message.id as number, expiredProfile.method)
      return
    }
    const rejectFrame = (failure: string) => { capture('rejected-envelope', message.id as number, waiting.method); this.protocolFailure(failure) }
    if (this.native && arrivedAt > waiting.deadline) {
      capture('late-owned-reply', message.id as number, waiting.method)
      this.cancelPending(message.id as number, new Error(`${waiting.method}: reply after original deadline`))
      return
    }
    if (message.error !== undefined && message.error !== null) {
      if (!record(message.error) || typeof message.error.message !== 'string' || typeof message.error.code !== 'number' || message.result !== undefined ||
          (this.native && (own(message, 'result') || own(message, 'params') || !int32(message.error.code) || (own(message, 'method') && message.method !== waiting.method)))) {
        return rejectFrame(`Malformed CDP error for ${waiting.method}`)
      }
      if (this.native && !capture('command-error', message.id as number, waiting.method)) return
    } else if (this.native && ['Profiler.enable', 'Profiler.setSamplingInterval', 'Profiler.start'].includes(waiting.method)) {
      const returnedParams = message.params
      if (!exactKeys(decoded as Record<string, unknown>, ['id', 'method', 'params']) || message.method !== waiting.method || !record(returnedParams) ||
          !exactKeys(returnedParams, Object.keys(waiting.params)) || Object.keys(waiting.params).some(key => returnedParams[key] !== waiting.params[key]) ||
          (waiting.method === 'Profiler.setSamplingInterval' && !positiveInt32(returnedParams.interval))) {
        return rejectFrame(`Invalid native command return for ${waiting.method}`)
      }
      if (!capture('native-command-return', message.id as number, waiting.method)) return
    } else if (this.native && waiting.method === 'Profiler.stop') {
      if (!exactKeys(decoded as Record<string, unknown>, ['id', 'method', 'result']) || message.method !== 'Profiler.stop' ||
          !record(message.result) || !exactKeys(message.result, ['profile'])) return rejectFrame('Native Profiler.stop requires its producer profile result')
      try {
        const profile = nativeStopProfile(message.result.profile)
        // Complete, validated stop data is separate from small-frame diagnostics.
        this.nativeProfiles.push({ id: message.id as number, arrivedAt, bytes: bytes.length, sha256: sha256(bytes), rawUtf8: bytes.toString('utf8'), profile })
      } catch (error) { return rejectFrame(String(error)) }
    } else if (!record(message.result)) {
      return rejectFrame(`Malformed CDP result for ${waiting.method}`)
    } else if (this.native && own(message, 'error')) {
      return rejectFrame(`Native CDP result/error contradiction for ${waiting.method}`)
    } else if (this.native && waiting.method === 'HeapProfiler.collectGarbage' &&
        (own(message, 'params') || (own(message, 'method') && message.method !== waiting.method))) {
      return rejectFrame('Native GC requires a correlated strict object success')
    }
    if (this.native && waiting.method === 'HeapProfiler.collectGarbage' && record(message.result) &&
        !capture('native-gc-success', message.id as number, waiting.method)) return
    this.pending.delete(message.id as number)
    clearTimeout(waiting.timer)
    if (message.error !== undefined && message.error !== null) {
      const detail = message.error as { message: string; code: number }
      const error = new Error(`${waiting.method}: ${detail.message} (${detail.code})`)
      waiting.trace.failedAt = arrivedAt; waiting.trace.failure = String(error)
      waiting.reject(error)
    } else {
      waiting.trace.acknowledgedAt = arrivedAt
      if (this.native && record(message.result)) this.resultFrames.set(message.result, { bytes, arrivedAt, id: message.id as number, method: waiting.method })
      waiting.resolve(this.native && ['Profiler.enable', 'Profiler.setSamplingInterval', 'Profiler.start'].includes(waiting.method) ? message.params : message.result)
    }
  }
  private failPending(error: Error): void {
    for (const [id, waiting] of this.pending) {
      this.pending.delete(id)
      clearTimeout(waiting.timer)
      waiting.trace.failedAt = this.now(); waiting.trace.failure = String(error)
      waiting.reject(error)
    }
  }
  private cancelPending(id: number | undefined, error: Error): void {
    if (id === undefined) return
    const pending = this.pending.get(id)
    if (!pending) return
    this.pending.delete(id); clearTimeout(pending.timer)
    pending.trace.failedAt = this.now(); pending.trace.failure = String(error)
    pending.reject(error)
  }
  call<T = unknown>(method: string, params: Record<string, unknown> = {}, timeoutMs = 30_000, acknowledged?: (value: T) => void, trace: RpcTrace = {}): Promise<T> {
    if (this.closedEvent) return Promise.reject(new Error(`Inspector is closed (${this.closedEvent.code}): ${method}`))
    if (this.native && (method.startsWith('Profiler.') || method === 'HeapProfiler.collectGarbage')) {
      if (this.nativePermit !== method) return Promise.reject(new Error(`Native ${method} requires its owned coordinated operation`))
      this.nativePermit = null
    }
    if (this.native && (!positiveInt32(this.nextId) || !finite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 30000)) return Promise.reject(new Error('Native RPC id/budget is outside the approved bounds'))
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      const sentParams = this.native ? frozenJson(params) : params
      const sentAt = this.now()
      const deadline = trace.deadline ?? sentAt + timeoutMs
      Object.assign(trace, { id, method, sentAt, deadline })
      const timer = setTimeout(() => this.cancelPending(id, new Error(`Inspector call timed out: ${method}`)), this.native ? Math.min(timeoutMs, remaining(deadline, () => this.now(), method)) : timeoutMs)
      this.pending.set(id, { method, params: sentParams, deadline, trace, resolve: value => {
        try { acknowledged?.(value as T); resolve(value as T) } catch (error) { reject(error) }
      }, reject, timer })
      try {
        this.socket.send(JSON.stringify({ id, method, params: sentParams }), error => {
          if (error) this.cancelPending(id, new Error(`Inspector send failed for ${method}: ${error.message}`))
        })
      } catch (error) {
        this.cancelPending(id, new Error(`Inspector send threw for ${method}: ${String(error)}`))
      }
    })
  }
  async isolateId(timeoutMs = 30_000): Promise<string> {
    return this.tracedIsolate(timeoutMs)
  }
  private async tracedIsolate(timeoutMs: number, trace: RpcTrace = {}): Promise<string> {
    const result = await this.call<{ id?: unknown }>('Runtime.getIsolateId', {}, timeoutMs, undefined, trace)
    if (typeof result?.id !== 'string' || !result.id) {
      this.retainRejectedResult(result, 'rejected-typed-isolate')
      throw new Error(`Runtime.getIsolateId returned ${JSON.stringify(result)}`)
    }
    if (this.boundIsolateId && result.id !== this.boundIsolateId) {
      this.retainRejectedResult(result, 'changed-original-isolate')
      this.ownershipFailure ??= `The inspected isolate changed from ${this.boundIsolateId} to ${result.id}`
      this.invalidateBinding(this.ownershipFailure)
    }
    return result.id
  }
  private retainRejectedResult(result: unknown, disposition: string): void {
    if (!this.native || !record(result)) return
    const raw = this.resultFrames.get(result)
    if (raw && !this.nativeFrames.capture(raw.bytes, { ...raw, phase: this.phase, disposition })) this.protocolFailure(`Native frame evidence overflow: ${this.nativeFrames.overflow?.reason}`)
  }
  private nonceValue(result: unknown): unknown {
    try { return this.parseNonceValue(result) } catch (error) { this.retainRejectedResult(result, 'rejected-typed-nonce'); throw error }
  }
  private parseNonceValue(result: unknown): unknown {
    if (!record(result) || 'exceptionDetails' in result) throw new Error(`Runtime.evaluate failed or returned malformed result: ${JSON.stringify(result)}`)
    const remote = result.result
    if (!record(remote)) throw new Error(`Runtime.evaluate returned no RemoteObject: ${JSON.stringify(result)}`)
    for (const key of ['description', 'objectId', 'subtype', 'unserializableValue']) {
      if (key in remote && typeof remote[key] !== 'string') throw new Error(`Runtime.evaluate returned a malformed RemoteObject ${key}: ${JSON.stringify(result)}`)
    }
    const { type, value } = remote
    const hasValue = 'value' in remote
    const valid = type === 'undefined' ? !hasValue && !('objectId' in remote) && !('unserializableValue' in remote)
      : type === 'string' ? typeof value === 'string'
      : type === 'boolean' ? typeof value === 'boolean'
      : type === 'number' ? finite(value) || (!hasValue && ['NaN', 'Infinity', '-Infinity', '-0'].includes(String(remote.unserializableValue)))
      : type === 'bigint' ? !hasValue && typeof remote.unserializableValue === 'string' && /^-?\d+n$/.test(remote.unserializableValue)
      : type === 'object' ? hasValue && (value === null || typeof value === 'object')
      : (type === 'function' || type === 'symbol') && !hasValue && typeof remote.description === 'string'
    if (!valid) throw new Error(`Runtime.evaluate returned a malformed nonce RemoteObject: ${JSON.stringify(result)}`)
    return value
  }
  /** Check before AND after each awaited operation; an acknowledgement does not validate its measurement. */
  private async boundCall<T = unknown>(method: string, params: Record<string, unknown> = {}, acknowledged?: (value: T) => void): Promise<T> {
    this.requireBinding(method)
    let result: T
    try {
      result = await this.call<T>(method, params, 30_000, acknowledged)
    } catch (error) {
      if (this.bindingFailure) throw new AggregateError([error, new Error(this.bindingFailure)], `${method} failed with an invalidated binding: ${this.bindingFailure}; ${String(error)}`)
      throw error
    }
    this.requireBinding(method)
    return result
  }
  private async boundIsolate(operation: string, timeoutMs = 30000, trace: RpcTrace = {}): Promise<string> {
    this.requireBinding(operation)
    const isolate = await this.tracedIsolate(timeoutMs, trace)
    this.requireBinding(operation)
    return isolate
  }
  async evaluateNonce(): Promise<string> {
    const result = await this.boundCall('Runtime.evaluate', { expression: 'globalThis.__orbitIsolateNonce', returnByValue: true, uniqueContextId: this.acquisition.binding!.uniqueId })
    const nonce = this.nonceValue(result)
    if (nonce !== this.isolateNonce) {
      this.invalidateBinding('The bound execution context no longer reports the owned HTTP nonce')
      this.requireBinding('Runtime.evaluate')
    }
    return nonce as string
  }
  /** Raw heap usage plus the isolate id at this instant; optional fields stay absent when the runtime omits them. */
  async heapUsage(phase: string): Promise<HeapSample> {
    const isolateId = await this.boundIsolate(phase)
    const raw = await this.boundCall<Record<string, unknown>>('Runtime.getHeapUsage')
    if (!finite(raw.usedSize) || !finite(raw.totalSize) || raw.usedSize <= 0 || raw.totalSize < raw.usedSize) {
      this.retainRejectedResult(raw, 'rejected-typed-heap')
      throw new Error(`Runtime.getHeapUsage returned no usable heap figures: ${JSON.stringify(raw)}`)
    }
    for (const field of ['embedderHeapUsedSize', 'backingStorageSize']) {
      if (field in raw && !finite(raw[field])) {
        this.retainRejectedResult(raw, 'rejected-typed-heap')
        throw new Error(`Runtime.getHeapUsage field ${field} is present but not finite: ${JSON.stringify(raw[field])}`)
      }
    }
    return { at: new Date().toISOString(), phase, isolateId, usedSize: raw.usedSize, totalSize: raw.totalSize, embedderHeapUsedSize: optionalField(raw.embedderHeapUsedSize), backingStorageSize: optionalField(raw.backingStorageSize), raw }
  }
  async collectGarbage(): Promise<void> {
    if (this.native) return this.collectNativeGarbage()
    await this.boundCall('HeapProfiler.enable')
    await this.boundCall('HeapProfiler.collectGarbage')
  }
  private async collectNativeGarbage(): Promise<void> {
    this.requireBinding('native GC')
    if (this.nativeGcBusy || this.nativeGcFailed || this.gcHttpCleanup || this.closing) throw new Error('Native GC overlaps, follows a failed cycle, or has been finalized; no retry/wake permitted')
    this.nativeGcBusy = true
    const cycle: (typeof this.gcCycles)[number] = {
      sequence: this.gcCycles.length + 1, beganAt: this.now(), deadline: 0, enable: {}, gc: {}, barrier: {}, finalIdentity: {},
      http: null, completedAt: null, failure: null, possibleQueuedEffect: false, cleanup: null, secondaryFailures: [], lateReplies: [],
    }
    this.gcCycles.push(cycle)
    let rejectFailure!: (error: unknown) => void
    let firstFailure: unknown
    let httpFailureJoin: Promise<IdentityHttpClosure> | null = null
    const failed = new Promise<never>((_, reject) => { rejectFailure = reject })
    void failed.catch(() => {})
    const fail = (error: unknown) => {
      const first = cycle.failure === null
      if (first) {
        firstFailure = error; cycle.failure = String(error); this.nativeGcFailed = true
        // A rejected/timed-out RPC does not cancel V8's already queued GC task.
        for (const trace of [cycle.enable, cycle.gc, cycle.barrier, cycle.finalIdentity]) this.cancelPending(trace.id, new Error(`GC cycle cancelled after: ${String(error)}`))
      } else if (String(error) !== cycle.failure && !cycle.secondaryFailures.includes(String(error))) cycle.secondaryFailures.push(String(error))
      const http = this.gcHttp.get(cycle.sequence)
      if (http && !httpFailureJoin) {
        httpFailureJoin = http.cancel(firstFailure)
        void httpFailureJoin.then(outcome => { cycle.cleanup = outcome }, cleanupError => { cycle.secondaryFailures.push(`HTTP cancellation join: ${String(cleanupError)}`) })
      }
      if (first) rejectFailure(error)
    }
    this.cancelNativeGc = fail
    try {
      await this.call('HeapProfiler.enable', {}, 30000, undefined, cycle.enable)
      this.requireBinding('native GC enable acknowledgement')
      this.nativePermit = 'HeapProfiler.collectGarbage'
      const gc = this.call<Record<string, unknown>>('HeapProfiler.collectGarbage', {}, 30000, undefined, cycle.gc)
      // Observe settlement immediately, before issuing the ordering barrier.
      void gc.then(() => {
        try { this.requireBinding('native GC acknowledgement') } catch (error) { fail(error) }
      }, fail)
      cycle.possibleQueuedEffect = cycle.gc.sentAt !== undefined
      if (cycle.gc.sentAt === undefined || cycle.gc.deadline === undefined) throw new Error('Native GC was not issued on the owned socket')
      cycle.deadline = cycle.gc.deadline
      const left = (label: string) => remaining(cycle.deadline, () => this.now(), label)
      // Let an already settled failure prevent every later step, including GET.
      await Promise.resolve()
      if (cycle.failure !== null) throw new Error(cycle.failure)
      cycle.barrier.deadline = cycle.deadline
      await Promise.race([this.boundIsolate('native GC ordered barrier', left('GC barrier'), cycle.barrier), failed])
      this.requireBinding('native GC before owned GET')
      if (cycle.failure !== null) throw new Error(cycle.failure)
      left('GC owned GET')
      const http = ownedIdentityGet(this.endpoints.devOrigin, this.isolateNonce, cycle.deadline, { now: () => this.now(), factory: this.native?.witness?.httpFactory })
      this.gcHttp.set(cycle.sequence, http); cycle.http = http.evidence
      void http.result.catch(fail)
      if (cycle.failure !== null) { fail(firstFailure); throw firstFailure }
      await Promise.race([Promise.all([gc, http.result]), failed])
      this.requireBinding('native GC final qualification')
      cycle.finalIdentity.deadline = cycle.deadline
      await Promise.race([this.boundIsolate('native GC final identity', left('GC final identity'), cycle.finalIdentity), failed])
      left('GC complete')
      cycle.completedAt = this.now()
      cycle.possibleQueuedEffect = false
    } catch (error) {
      fail(error)
      throw error
    } finally {
      this.nativePermit = null; this.nativeGcBusy = false; this.cancelNativeGc = null
    }
  }
  /** The failure join starts at cancellation, not when the finalizer reaches it. */
  cleanupGcHttp(): Promise<{ outcomes: IdentityHttpClosure[]; failures: string[] }> {
    return this.gcHttpCleanup ??= (async () => {
      this.cancelNativeGc?.(new Error('Native GC finalized before completion'))
      const entries = [...this.gcHttp.entries()]
      const settled = await Promise.allSettled(entries.map(([, http]) => http.cleanup()))
      const outcomes: IdentityHttpClosure[] = []
      const failures: string[] = []
      for (const [index, result] of settled.entries()) {
        if (result.status === 'rejected') { failures.push(`GC HTTP ${entries[index][0]} join: ${String(result.reason)}`); continue }
        outcomes.push(result.value)
        this.gcCycles[entries[index][0] - 1].cleanup = result.value
        failures.push(...result.value.failures)
        if (!result.value.confirmed) failures.push(`GC HTTP ${entries[index][0]} closure unconfirmed`)
      }
      return { outcomes, failures }
    })()
  }
  private async nativeClaim(deadline: number, create: boolean): Promise<void> {
    if (this.native?.permission !== 'encoding-cpu') throw new Error('Heap-only native client has no CPU profiler permission')
    if (this.nativeOwner.claimFailure) throw new Error(this.nativeOwner.claimFailure)
    remaining(deadline, () => this.now(), 'native claim')
    const work = async () => {
      if (!this.nativeOwner.claim) {
        if (!create || !this.nativePreparation) throw new Error('Native profiler has no owned run claim')
        const claimPath = path.join(this.nativePreparation.directory, 'native-profiler-owner-claim.json')
        const content = frozenJson({
          version: 1, contract: NATIVE_CONTRACT.name, run: path.basename(this.nativePreparation.directory),
          claimant: { client: this.nativeOwner.client, pid: process.pid, permission: 'encoding-cpu', case: 'capacity-realistic encoding/CPU' },
          target: this.target.id, isolate: this.boundIsolateId, context: this.acquisition.binding, nonce: this.isolateNonce,
          provenance: this.nativePreparation.provenance, createdAt: new Date().toISOString(),
          policy: 'Exclusive immutable nontransferable run claim; never unlink/recover/overwrite for another attempt',
        })
        const bytes = Buffer.from(`${JSON.stringify(content, null, 2)}\n`)
        // Existing/partial/unreadable claims all fail. A partial write is kept.
        const handle = await open(claimPath, 'wx', 0o600)
        try {
          await handle.writeFile(bytes); await handle.sync()
          const stat = await handle.stat()
          this.nativeOwner.claim = { path: claimPath, sha256: sha256(bytes), content, inode: stat.ino }
        } finally { await handle.close() }
      }
      const claim = this.nativeOwner.claim
      if (!claim) throw new Error('Native profiler claim creation did not complete')
      const stat = await lstat(claim.path)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.ino !== claim.inode || (stat.mode & 0o777) !== 0o600 ||
          await realpath(claim.path) !== claim.path || sha256(await readFile(claim.path)) !== claim.sha256) {
        throw new Error('Native profiler claim changed or became unavailable; replacement refused')
      }
    }
    try { await beforeDeadline(work(), deadline, () => this.now(), 'native claim') } catch (error) {
      this.nativeOwner.claimFailure = `Native profiler claim refused: ${String(error)}`
      throw new Error(this.nativeOwner.claimFailure)
    }
  }
  private nativeInactive(): boolean {
    if (!this.nativeOwner.claim || this.nativeOwner.claimFailure || this.nativeOwner.stopFailure || !this.channelUsable() || !this.boundIsolateId) return false
    if (!this.nativeOwner.startedInEpoch) return !this.nativeOwner.mayBeActive
    const effect = this.nativeOwner.stopEffect
    return !this.nativeOwner.mayBeActive && !!effect && effect.client === this.nativeOwner.client && effect.target === this.target.id &&
      effect.isolate === this.boundIsolateId && effect.enableEpoch === this.nativeOwner.enableEpoch && effect.startEpoch === this.nativeOwner.startEpoch
  }
  private async nativeProfileRpc<T = unknown>(method: string, params: Record<string, unknown>, budgetMs: number, acknowledged: (result: T, trace: RpcTrace) => void): Promise<T> {
    const deadline = this.now() + budgetMs
    await this.nativeClaim(deadline, false)
    if (!this.channelUsable() || !this.boundIsolateId) throw new Error('Native profiler retained ownership is unavailable')
    if (method === 'Profiler.enable' && !this.nativeInactive()) throw new Error('Native replacement forbidden: current epoch is active or unconfirmed')
    if (method === 'Profiler.setSamplingInterval' && !positiveInt32(params.interval)) throw new Error('Native sampling interval must be a positive Int32')
    if (method === 'Profiler.enable') {
      // The common predicate above qualified the preceding allocation. Only
      // now can a possible replacement begin a fresh, unstarted owner epoch.
      this.nativeOwner.enableEpoch++
      this.nativeOwner.startedInEpoch = false; this.nativeOwner.stopEffect = null
      this.profileState.enableMayHaveBeenSent = true; this.profileState.enableAcknowledged = false
      if (this.nativeProfileBusy === 'cleanup') {
        this.nativeOwner.resetMayHaveBeenSent = true; this.nativeOwner.resetEnableEpoch = this.nativeOwner.enableEpoch
      }
    }
    const trace: RpcTrace = { deadline }
    const operation: (typeof this.profileState.operations)[number] = { method, acknowledged: false, failure: null, trace }
    this.profileState.operations.push(operation)
    this.nativePermit = method
    try {
      const result = await this.call<T>(method, params, remaining(deadline, () => this.now(), method), value => {
        operation.result = value
        if (method === 'Profiler.enable') this.profileState.enableAcknowledged = true
        acknowledged(value, trace)
        operation.acknowledged = true
      }, trace)
      if (!this.channelUsable()) throw new Error('Native profiler ownership changed during its command')
      return result
    } catch (error) {
      operation.failure = String(error)
      if (method === 'Profiler.stop') this.nativeOwner.stopFailure ??= String(error)
      throw error
    } finally { this.nativePermit = null }
  }
  private retainNativeStop(isolate: string, trace: RpcTrace): void {
    const index = this.nativeProfiles.findIndex(profile => profile.id === trace.id)
    if (index < 0 || isolate !== this.boundIsolateId || !this.channelUsable()) throw new Error('Native stop has no complete attributable producer effect')
    this.nativeOwner.stopEffect = {
      client: this.nativeOwner.client, target: this.target.id, isolate,
      enableEpoch: this.nativeOwner.enableEpoch, startEpoch: this.nativeOwner.startEpoch, profileIndex: index,
    }
    this.nativeOwner.stopEffects.push(this.nativeOwner.stopEffect)
    this.nativeOwner.mayBeActive = false
    this.profileState.stopAcknowledged = true; this.profileState.stopIsolateId = isolate
  }
  private async startNativeProfile(interval: number): Promise<void> {
    this.requireBinding('native profile start')
    if (!positiveInt32(interval)) throw new Error('Native sampling interval must be a positive Int32')
    if (this.nativeProfileBusy || this.profileCleanup) throw new Error('Native profile start/stop/cleanup overlap or finalized owner')
    if (this.native?.permission !== 'encoding-cpu') throw new Error('Heap-only native client has no CPU profiler permission')
    this.nativeProfileBusy = 'start'
    try {
      const initialDeadline = this.now() + 30000
      await this.nativeClaim(initialDeadline, true)
      await this.boundIsolate('native profile start', remaining(initialDeadline, () => this.now(), 'native profile start'))
      if (!this.nativeInactive()) throw new Error('Native replacement forbidden: current epoch is active or unconfirmed')
      this.nativeOwner.resetAcknowledged = false
      await this.nativeProfileRpc('Profiler.enable', {}, 30000, () => { this.profileState.enableAcknowledged = true })
      this.requireBinding('native sampling interval')
      if (!this.profileState.enableAcknowledged) throw new Error('Native sampling interval has no acknowledged enable')
      await this.nativeProfileRpc('Profiler.setSamplingInterval', { interval }, 30000, () => {})
      this.requireBinding('native Profiler.start')
      this.nativeOwner.startEpoch++; this.nativeOwner.startedInEpoch = true; this.nativeOwner.mayBeActive = true; this.nativeOwner.stopEffect = null
      this.profileState.startMayHaveBeenSent = true; this.profileState.startAcknowledged = false
      this.profileState.stopAcknowledged = false; this.profileState.stopIsolateId = null
      await this.nativeProfileRpc('Profiler.start', {}, 30000, () => { this.profileState.startAcknowledged = true })
      this.requireBinding('native profile start acknowledgement')
    } finally { this.nativeProfileBusy = null }
  }
  private async stopNativeProfile(interval: number): Promise<{ summary: CpuProfileSummary; raw: RawCpuProfile }> {
    this.requireBinding('native profile stop')
    if (this.native?.permission !== 'encoding-cpu') throw new Error('Heap-only native client has no CPU profiler permission')
    if (this.nativeProfileBusy || this.profileCleanup) throw new Error('Native profile start/stop/cleanup overlap or finalized owner')
    this.nativeProfileBusy = 'stop'
    try {
      const isolate = await this.boundIsolate('native stop before')
      const result = await this.nativeProfileRpc<{ profile: RawCpuProfile }>('Profiler.stop', {}, 30000, (_value, trace) => this.retainNativeStop(isolate, trace))
      await this.boundIsolate('native stop after')
      return this.measuredProfile(result.profile, interval)
    } finally { this.nativeProfileBusy = null }
  }
  private async profileCall<T = unknown>(method: string, params: Record<string, unknown>, acknowledged: (value: T) => void): Promise<T> {
    this.requireBinding(method)
    const operation: (typeof this.profileState.operations)[number] = { method, acknowledged: false, failure: null }
    this.profileState.operations.push(operation)
    try {
      return await this.boundCall<T>(method, params, result => {
        operation.acknowledged = true
        operation.result = result
        acknowledged(result)
      })
    } catch (error) {
      operation.failure = String(error)
      throw error
    }
  }
  async startProfile(samplingIntervalMicros = 500): Promise<void> {
    if (this.native) return this.startNativeProfile(samplingIntervalMicros)
    this.requireBinding('profile start')
    if (this.profileCleanup) throw new Error('A finalized profiler cannot be restarted')
    if (this.profileState.startMayHaveBeenSent && !this.profileState.stopAcknowledged) throw new Error('The preceding profile has no stop acknowledgement')
    await this.boundIsolate('profile start')
    this.profileState.enableMayHaveBeenSent = true
    await this.profileCall('Profiler.enable', {}, () => { this.profileState.enableAcknowledged = true })
    await this.profileCall('Profiler.setSamplingInterval', { interval: samplingIntervalMicros }, () => {})
    this.requireBinding('Profiler.start')
    this.profileState.startMayHaveBeenSent = true
    this.profileState.startAcknowledged = false
    this.profileState.stopAcknowledged = false
    this.profileState.stopIsolateId = null
    await this.profileCall('Profiler.start', {}, () => { this.profileState.startAcknowledged = true })
  }
  /** The raw profile is retained; it must have positive duration, valid sample→node references and a positive total of time deltas. */
  async stopProfile(samplingIntervalMicros = 500): Promise<{ summary: CpuProfileSummary; raw: RawCpuProfile }> {
    if (this.native) return this.stopNativeProfile(samplingIntervalMicros)
    const isolate = await this.boundIsolate('profile stop before')
    const result = await this.profileCall<{ profile?: Partial<RawCpuProfile> }>('Profiler.stop', {}, () => {
      this.profileState.stopAcknowledged = true
      // Effect acknowledgement survives same-isolate context invalidation. A
      // later ownership change still prevents cleanup from claiming attribution.
      this.profileState.stopIsolateId = this.ownershipFailure ? null : isolate
    })
    await this.boundIsolate('profile stop after')
    const profile = result?.profile
    return this.measuredProfile(profile, samplingIntervalMicros)
  }
  private measuredProfile(profile: Partial<RawCpuProfile> | undefined, samplingIntervalMicros: number): { summary: CpuProfileSummary; raw: RawCpuProfile } {
    if (!profile || !Array.isArray(profile.nodes) || !profile.nodes.length) throw new Error('Profiler.stop returned no profile nodes')
    if (!Array.isArray(profile.samples) || !profile.samples.length) throw new Error('Profiler.stop returned no samples')
    if (!Array.isArray(profile.timeDeltas) || profile.timeDeltas.length !== profile.samples.length) throw new Error('Profiler.stop returned mismatched time deltas')
    if (!profile.timeDeltas.every(delta => finite(delta) && delta >= 0)) throw new Error('Profiler.stop returned non-finite or negative time deltas')
    if (!finite(profile.startTime) || !finite(profile.endTime) || profile.endTime <= profile.startTime) throw new Error('Profiler.stop returned no positive duration')
    const nodeIds = new Set(profile.nodes.map(node => node.id))
    if (!profile.samples.every(sample => nodeIds.has(sample))) throw new Error('Profiler.stop samples reference unknown nodes')
    const totalDeltaMicros = profile.timeDeltas.reduce((sum, delta) => sum + delta, 0)
    if (totalDeltaMicros <= 0) throw new Error('Profiler.stop returned samples whose time deltas total zero')
    const idle = new Set(profile.nodes.filter(node => node.callFrame.functionName === '(idle)').map(node => node.id))
    let busyMicros = 0
    let idleMicros = 0
    profile.samples.forEach((node, index) => {
      if (idle.has(node)) idleMicros += profile.timeDeltas![index]
      else busyMicros += profile.timeDeltas![index]
    })
    const raw = profile as RawCpuProfile
    return { summary: { busyMicros, idleMicros, sampleCount: raw.samples.length, nodeCount: raw.nodes.length, durationMicros: raw.endTime - raw.startTime, totalDeltaMicros, samplingIntervalMicros }, raw }
  }
  /**
   * Cleanup bypasses measurement-validity guards, never ownership guards.
   * Generic ASC03-R1 uses disable; explicit native mode uses a safe inactive
   * replacement. Each keeps four <=3000ms RPC slots and independent close.
   */
  cleanupProfile(): Promise<ProfileCleanup> {
    return this.profileCleanup ??= (this.native ? this.cleanupNativeProfile() : this.cleanupOwnedProfile())
  }
  private async cleanupNativeProfile(): Promise<ProfileCleanup> {
    const outcome: ProfileCleanup = { budgetMsPerRpc: 3000, configuredRpcBudgetMs: 12000, confirmed: false, stopped: false, disabled: false, initialIsolateId: null, finalIsolateId: null, actions: [], failures: [] }
    const details = {
      mode: 'native-reset-quiescence', permission: this.native!.permission, resetMayHaveBeenSent: false, resetAcknowledged: false,
      quiescent: false, freshAllocationRemains: false as boolean | null, globalPredecessorStateConfirmed: false,
      priorStopFailure: this.nativeOwner.stopFailure,
      noProfilerCommandsIssued: !this.profileState.enableMayHaveBeenSent && !this.profileState.startMayHaveBeenSent,
    }
    outcome.native = details
    if (this.nativeProfileBusy) { outcome.failures.push('Native cleanup overlaps an in-flight start/stop; no replacement permitted'); return outcome }
    if (details.noProfilerCommandsIssued) { outcome.confirmed = true; outcome.actions.push({ method: 'native-profiler', status: 'skipped', reason: 'This client issued no profiler command; no predecessor-state claim' }); return outcome }
    this.nativeProfileBusy = 'cleanup'; this.setPhase('profile-cleanup')
    const attributable = () => this.channelUsable() && !!this.boundIsolateId && outcome.initialIsolateId === this.boundIsolateId
    const skip = (method: string, reason: string) => outcome.actions.push({ method, status: 'skipped', reason })
    const action = async (method: string, operation: () => Promise<unknown>): Promise<boolean> => {
      try { const result = await operation(); outcome.actions.push({ method, status: 'acknowledged', result }); return true } catch (error) {
        const reason = String(error); outcome.actions.push({ method, status: 'failed', reason }); outcome.failures.push(`${method}: ${reason}`); return false
      }
    }
    try {
      if (this.channelUsable()) {
        await action('Runtime.getIsolateId', async () => {
          const deadline = this.now() + 3000
          await this.nativeClaim(deadline, false)
          return outcome.initialIsolateId = await this.isolateId(remaining(deadline, () => this.now(), 'native cleanup identity'))
        })
      } else skip('Runtime.getIsolateId', 'Retained channel/target unavailable')
      if (attributable() && this.nativeOwner.mayBeActive) {
        await action('Profiler.stop', () => this.nativeProfileRpc('Profiler.stop', {}, 3000, (_result, trace) => this.retainNativeStop(this.boundIsolateId, trace)))
      } else skip('Profiler.stop', 'No attributable active epoch requiring a stop')
      if (attributable() && this.nativeInactive()) {
        details.resetMayHaveBeenSent = true; details.freshAllocationRemains = null
        await action('Profiler.enable', () => this.nativeProfileRpc('Profiler.enable', {}, 3000, () => {
          this.nativeOwner.resetAcknowledged = true; details.resetAcknowledged = true; details.freshAllocationRemains = true
        }))
      } else skip('Profiler.enable', 'Native reset forbidden by stop evidence, claim, or original ownership')
      if (attributable()) await action('Runtime.getIsolateId', async () => outcome.finalIsolateId = await this.isolateId(3000))
      else skip('Runtime.getIsolateId', 'Original ownership cannot be qualified')
      const identity = attributable() && outcome.finalIsolateId === this.boundIsolateId
      outcome.stopped = identity && this.nativeInactive()
      details.quiescent = outcome.stopped && details.resetAcknowledged
      outcome.confirmed = details.quiescent && !outcome.failures.length
      if (!outcome.confirmed) outcome.failures.push('Original native profiler quiescence unconfirmed; generic disable is not native disposal')
      return outcome
    } finally { this.nativeProfileBusy = null }
  }
  private async cleanupOwnedProfile(): Promise<ProfileCleanup> {
    const outcome: ProfileCleanup = {
      budgetMsPerRpc: 3000, configuredRpcBudgetMs: 12000, confirmed: false, stopped: false, disabled: false,
      initialIsolateId: null, finalIsolateId: null, actions: [], failures: [],
    }
    const state = this.profileState
    if (!state.enableMayHaveBeenSent && !state.startMayHaveBeenSent) {
      outcome.confirmed = true
      outcome.actions.push({ method: 'Profiler.stop/disable', status: 'skipped', reason: 'No profiler command may have been sent by this inspector' })
      return outcome
    }
    this.setPhase('profile-cleanup')
    const owned = () => this.channelUsable() && !!this.boundIsolateId
    const skip = (method: string, reason: string) => outcome.actions.push({ method, status: 'skipped', reason })
    const rpc = async (method: string): Promise<{ acknowledged: true; result: unknown } | { acknowledged: false }> => {
      try {
        const result = method === 'Runtime.getIsolateId' ? await this.isolateId(3_000) : await this.call(method, {}, 3_000)
        outcome.actions.push({ method, status: 'acknowledged', result })
        return { acknowledged: true, result }
      } catch (error) {
        const reason = String(error)
        outcome.actions.push({ method, status: 'failed', reason })
        outcome.failures.push(`${method}: ${reason}`)
        return { acknowledged: false }
      }
    }
    if (owned()) {
      const initial = await rpc('Runtime.getIsolateId')
      if (initial.acknowledged) outcome.initialIsolateId = initial.result as string
    } else skip('Runtime.getIsolateId', 'The retained socket/target ownership is unavailable')
    const attributable = () => owned() && outcome.initialIsolateId === this.boundIsolateId
    if (attributable()) {
      if (state.startMayHaveBeenSent && !(state.stopAcknowledged && state.stopIsolateId === this.boundIsolateId)) {
        const stopped = await rpc('Profiler.stop')
        if (stopped.acknowledged) {
          state.stopAcknowledged = true
          state.stopIsolateId = this.ownershipFailure ? null : this.boundIsolateId
        }
      } else skip('Profiler.stop', state.startMayHaveBeenSent ? 'A correlated owned stop acknowledgement is already retained' : 'No profile start may have been sent')
      // A stop error alone MUST NOT skip disable. Known channel/target loss does.
      if (state.enableMayHaveBeenSent && !state.disableAcknowledged && attributable()) {
        const disabled = await rpc('Profiler.disable')
        if (disabled.acknowledged) state.disableAcknowledged = true
      } else skip('Profiler.disable', state.disableAcknowledged ? 'Already acknowledged' : 'No possibly enabled profiler or ownership is now unavailable')
      if (attributable()) {
        const final = await rpc('Runtime.getIsolateId')
        if (final.acknowledged) outcome.finalIsolateId = final.result as string
      } else skip('Runtime.getIsolateId', 'Final ownership cannot be queried on the retained channel')
    } else {
      skip('Profiler.stop', 'Original profile state unconfirmed; commands to a replacement are forbidden')
      skip('Profiler.disable', 'Original profile state unconfirmed; commands to a replacement are forbidden')
      skip('Runtime.getIsolateId', 'Initial ownership was not confirmed; no second identity attempt')
    }
    const identityConfirmed = attributable() && outcome.finalIsolateId === this.boundIsolateId
    outcome.stopped = identityConfirmed && (!state.startMayHaveBeenSent || (state.stopAcknowledged && state.stopIsolateId === this.boundIsolateId))
    outcome.disabled = identityConfirmed && (!state.enableMayHaveBeenSent || state.disableAcknowledged)
    outcome.confirmed = outcome.stopped && outcome.disabled
    if (!outcome.confirmed) outcome.failures.push('Original profiler state unconfirmed after owned cleanup')
    return outcome
  }
  /** Bounded close: pending calls rejected, close frame sent, closure confirmed only by the close event; otherwise terminated and reported unconfirmed. */
  close(timeoutMs = 5_000): Promise<CloseOutcome> {
    if (this.native && (!finite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 5000)) return Promise.reject(new Error('Native close requires a positive finite budget no larger than5000ms'))
    return this.closing ??= this.closeOnce(timeoutMs)
  }
  private async closeOnce(timeoutMs: number): Promise<CloseOutcome> {
    this.setPhase('closed')
    this.failPending(new Error('Inspector closed by the test'))
    if (this.native) return closeNativeTransport(this.socket, timeoutMs, () => this.now(), this.closedEvent ?? undefined)
    if (this.closedEvent) return { confirmed: true, code: this.closedEvent.code, reason: this.closedEvent.reason }
    const outcome = await new Promise<CloseOutcome>(resolve => {
      const terminate = () => { try { this.socket.terminate(); return 'socket terminated' } catch (error) { return `terminate threw: ${String(error)}` } }
      const timer = setTimeout(() => { const termination = terminate(); resolve({ confirmed: false, code: null, reason: `no close event within ${timeoutMs} ms; ${termination}` }) }, timeoutMs)
      this.socket.on('close', (code, reason) => { clearTimeout(timer); resolve({ confirmed: true, code, reason: String(reason) }) })
      try { this.socket.close(1000, 'capacity measurement complete') } catch (error) { clearTimeout(timer); const termination = terminate(); resolve({ confirmed: false, code: null, reason: `close threw: ${String(error)}; ${termination}` }) }
    })
    return outcome
  }
}

// ---------------------------------------------------------------------------
// Evidence that survives failure (ACR82-8)
// ---------------------------------------------------------------------------
export interface CleanupStep { label: string; run: () => Promise<unknown> }
/**
 * Unconditional finalization: every cleanup step is attempted independently and
 * its result or failure recorded in the evidence, the evidence is attached even
 * when earlier steps failed, and the primary failure is rethrown together with
 * any secondary failures. A successful case still fails when cleanup or the
 * evidence write failed.
 */
export async function finalizeCase(info: TestInfo, name: string, evidence: Record<string, unknown>, primary: { error: unknown } | null, steps: CleanupStep[]): Promise<void> {
  const failures: string[] = []
  const outcomes: Record<string, unknown> = {}
  for (const step of steps) {
    try {
      outcomes[step.label] = await step.run()
    } catch (error) {
      outcomes[step.label] = { failed: String(error) }
      failures.push(`${step.label}: ${String(error)}`)
    }
  }
  evidence.cleanup = outcomes
  evidence.cleanupFailures = failures
  evidence.primaryFailure = primary ? String(primary.error) : null
  try {
    await info.attach(name, { body: Buffer.from(JSON.stringify(evidence, null, 2)), contentType: 'application/json' })
  } catch (error) {
    failures.push(`attach ${name}: ${String(error)}`)
  }
  if (primary) {
    if (failures.length) throw new AggregateError([primary.error, ...failures.map(message => new Error(message))], `${name}: the case failed and cleanup/evidence also failed`)
    throw primary.error
  }
  if (failures.length) throw new Error(`${name}: cleanup/evidence failures: ${failures.join('; ')}`)
}
