import { request as httpRequest } from 'node:http'
import type { ClientRequest, IncomingHttpHeaders, IncomingMessage, OutgoingHttpHeaders, RequestOptions } from 'node:http'
import { createHash, randomBytes } from 'node:crypto'
import type { Socket } from 'node:net'
import { brotliDecompressSync, gunzipSync } from 'node:zlib'
import { createPublicationClient } from '../../../server/publication-client'
import type { PublicationMetrics } from '../../../server/publication-client'

/** Raw HTTP against the local workerd: Node's client never decodes or follows anything on its own. */
export interface RawResponse {
  status: number
  headers: IncomingHttpHeaders
  body: Buffer
}

/** v5 observations are opt-in, local to a case, and never select a global current request. */
export const HTTP_OBSERVATION_LIMITS = Object.freeze({
  operations: 1024, metricsAttempts: 3072, eventsPerOperation: 64, errorsPerOperation: 32,
  stringBytes: 4096, metricsResultBytes: 4096, wipeBytes: 65536, retainedBytes: 8388608,
  idLabelBytes: 128, wipes: 1,
} as const)
export interface HttpTime { epochMs: number; monotonicMs: number }
interface TruncatedHttpText { truncated: true; prefix: string; originalBytes: number; sha256: string }
type HttpText = string | TruncatedHttpText
const httpPrefix = (bytes: Buffer, limit: number): string => {
  let prefix = bytes.subarray(0, limit).toString('utf8')
  while (Buffer.byteLength(prefix) > limit) prefix = prefix.slice(0, -1)
  return prefix
}
export interface HttpObservationScope { context: HttpObservation; label: string; phase: string }
export interface ObservedHttpError {
  source: string; message: HttpText; code: HttpText | null; at: HttpTime
  intentional: boolean; afterResponseEnd: boolean; duringCleanup: boolean; afterClosure: boolean
}
export interface ObservedHttpClosure {
  confirmed: boolean
  requestAcquired: boolean
  requestClosed: boolean
  socket: 'closed' | 'not-acquired' | 'unconfirmed'
  responseEnded: boolean
  startedAt: HttpTime
  deadline: number
  settledAt: HttpTime
  joinBudgetMs: 3000
  failures: string[]
}
interface HttpEvent { sequence: number; name: HttpText; phase: HttpText; at: HttpTime }
export interface NodeHttpOperation {
  id: string; kind: string; label: HttpText; phase: HttpText; method: string; pathname: HttpText
  encoding?: HttpText; declaredLength?: number
  status: number | null
  acquisition: { request: boolean; socket: boolean; response: boolean }
  terminal: { kind: 'complete-body' | 'error'; at: HttpTime; source?: string; error?: HttpText } | null
  cancellationIntent: { reason: HttpText; at: HttpTime } | null
  events: HttpEvent[]
  errors: ObservedHttpError[]
  closure: ObservedHttpClosure | HeldRequestClosure | null
  observedCounts: { events: number; errors: number }
}
interface MetricsOperation {
  id: string; operation: number; kind: 'metrics'; label: HttpText; phase: HttpText; method: 'GET'; pathname: '/__orbit/publish/metrics'
  startedAt: HttpTime; attempts: number
  consumer: { at: HttpTime; outcome: 'validated-result' | 'error'; result?: unknown; error?: { source: 'consumer'; message: HttpText; code: HttpText | null } } | null
}
interface MetricsAttempt {
  operationId: string; attempt: number; startedAt: HttpTime; url: HttpText | null; delegated: boolean
  headers: { at: HttpTime; status: number } | null
  error: { source: 'fetch' | 'request-validation'; at: HttpTime; message: HttpText; code: HttpText | null } | null
}
interface WipeObservation {
  caseId: HttpText; label: HttpText; phase: HttpText; startedAt: HttpTime
  returnedAt?: HttpTime; witness?: unknown; error?: HttpText
}

/**
 * Only bounded metadata is copied. The existing body consumers retain ownership
 * of their bytes. Counts/first failure remain outside capped arrays, even when a
 * record cannot be retained. retainedBytes is a conservative cumulative JSON
 * charge (including updates), paid before insertion, not an application limit.
 */
export class HttpObservation {
  readonly evidence: {
    version: 1; caseId: HttpText; caseNonce: string; limits: typeof HTTP_OBSERVATION_LIMITS
    operations: NodeHttpOperation[]; metricsOperations: MetricsOperation[]; metricsAttempts: MetricsAttempt[]; wipes: WipeObservation[]
    overflow: { count: number; first: { scope: string; limit: number; at: HttpTime; originalBytes?: number; prefix?: string; sha256?: string } | null }
    observerFailures: { count: number; first: { source: string; message: string; at: HttpTime } | null }
    observedCounts: { operations: number; metricsOperations: number; metricsAttempts: number; events: number; errors: number; metricsAttemptErrors: number; metricsConsumerErrors: number; wipes: number }
    retainedBytes: number
  }
  constructor(caseId: string, readonly clock: () => HttpTime = () => ({ epochMs: Date.now(), monotonicMs: performance.now() }), nonce = randomBytes(6).toString('hex')) {
    if (!/^[0-9a-f]{12}$/.test(nonce)) throw new Error('HTTP observation nonce must be exactly 12 lowercase hexadecimal characters')
    this.evidence = {
      version: 1, caseId: '', caseNonce: nonce, limits: HTTP_OBSERVATION_LIMITS,
      operations: [], metricsOperations: [], metricsAttempts: [], wipes: [],
      overflow: { count: 0, first: null }, observerFailures: { count: 0, first: null },
      observedCounts: { operations: 0, metricsOperations: 0, metricsAttempts: 0, events: 0, errors: 0, metricsAttemptErrors: 0, metricsConsumerErrors: 0, wipes: 0 }, retainedBytes: 0,
    }
    this.evidence.caseId = this.text(caseId, 'caseId', 128)
    // Reserve bounded failure metadata/counter growth even when the arrays use
    // their last byte. Neither cap exhaustion nor a broken callback can hide it.
    this.evidence.retainedBytes = Buffer.byteLength(JSON.stringify(this.evidence)) + 16_384
  }
  scope(label: string, phase: string): HttpObservationScope { return { context: this, label, phase } }
  time(): HttpTime {
    let value: HttpTime = { epochMs: Date.now(), monotonicMs: performance.now() }
    this.observe('timestamp', () => {
      const observed = this.clock()
      if (!Number.isFinite(observed.epochMs) || !Number.isFinite(observed.monotonicMs)) throw new Error('Invalid observation timestamp')
      value = { epochMs: observed.epochMs, monotonicMs: observed.monotonicMs }
    })
    return value
  }
  /** A broken observer cannot throw through an EventEmitter or prevent another owner's cleanup. */
  observe(source: string, action: () => void): void {
    try { action() } catch (error) {
      this.evidence.observerFailures.count++
      if (!this.evidence.observerFailures.first) {
        let message = 'Unprintable observer failure'
        try { message = String(error) } catch { /* Preserve failure status even if the thrown value cannot be printed. */ }
        this.evidence.observerFailures.first = {
          source: httpPrefix(Buffer.from(source), 128),
          message: httpPrefix(Buffer.from(message), 4096),
          at: { epochMs: Date.now(), monotonicMs: performance.now() },
        }
      }
    }
  }
  excess(scope: string, limit: number, bytes?: Buffer): void {
    this.evidence.overflow.count++
    if (!this.evidence.overflow.first) this.evidence.overflow.first = {
      scope: httpPrefix(Buffer.from(scope), 128), limit, at: this.time(),
      ...(bytes ? { originalBytes: bytes.length, prefix: bytes.subarray(0, 256).toString('utf8'), sha256: createHash('sha256').update(bytes).digest('hex') } : {}),
    }
  }
  text(value: string, scope: string, limit: number = 4096): HttpText {
    const bytes = Buffer.from(value)
    if (bytes.length <= limit) return value
    this.excess(scope, limit, bytes)
    // Back off a possibly partial UTF-8 code point; the prefix itself stays within the byte cap.
    const prefix = httpPrefix(bytes, limit)
    return { truncated: true, prefix, originalBytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
  }
  json(value: unknown, scope: string, limit: number): unknown {
    const serialized = JSON.stringify(value, (_key, item: unknown) => typeof item === 'string' ? this.text(item, scope) : item)
    if (typeof serialized !== 'string') throw new Error('Observation is not JSON-serializable')
    const bytes = Buffer.from(serialized)
    if (bytes.length <= limit) return JSON.parse(serialized) as unknown
    this.excess(scope, limit, bytes)
    return { truncated: true, prefix: bytes.subarray(0, 256).toString('utf8'), originalBytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
  }
  retain(value: unknown, scope: string, insert: () => void): boolean {
    const serialized = JSON.stringify(value)
    if (typeof serialized !== 'string') throw new Error('Observation is not JSON-serializable')
    const bytes = Buffer.from(serialized)
    const charge = bytes.length + 1
    if (this.evidence.retainedBytes + charge > HTTP_OBSERVATION_LIMITS.retainedBytes) {
      this.excess(scope, HTTP_OBSERVATION_LIMITS.retainedBytes, bytes)
      return false
    }
    this.evidence.retainedBytes += charge
    insert()
    return true
  }
  node(scope: HttpObservationScope, kind: string, method: string, pathname: string, details: { encoding?: string; declaredLength?: number } = {}): HttpNodeRecorder {
    const number = ++this.evidence.observedCounts.operations
    const data: NodeHttpOperation = {
      id: `n${number}`, kind, label: this.text(scope.label, 'label', 128), phase: this.text(scope.phase, 'phase', 128),
      method, pathname: this.text(pathname, 'pathname'),
      ...(details.encoding === undefined ? {} : { encoding: this.text(details.encoding, 'encoding') }),
      ...(details.declaredLength === undefined ? {} : { declaredLength: details.declaredLength }),
      status: null, acquisition: { request: false, socket: false, response: false }, terminal: null, cancellationIntent: null,
      events: [], errors: [], closure: null, observedCounts: { events: 0, errors: 0 },
    }
    let retained = false
    this.observe('node-operation', () => {
      if (number > HTTP_OBSERVATION_LIMITS.operations) this.excess('operations', HTTP_OBSERVATION_LIMITS.operations)
      else retained = this.retain(data, 'operation', () => this.evidence.operations.push(data))
    })
    return new HttpNodeRecorder(this, data, retained)
  }
  beginWipe(scope: HttpObservationScope): WipeObservation | null {
    let record: WipeObservation | null = null
    this.observe('wipe-start', () => {
      if (++this.evidence.observedCounts.wipes > 1) { this.excess('wipes', 1); return }
      const value: WipeObservation = { caseId: this.evidence.caseId, label: this.text(scope.label, 'wipe-label', 128), phase: this.text(scope.phase, 'wipe-phase', 128), startedAt: this.time() }
      this.retain(value, 'wipe', () => { this.evidence.wipes.push(value); record = value })
    })
    return record
  }
  endWipe(record: WipeObservation | null, result: { witness: WipeWitness } | { error: unknown }): void {
    this.observe('wipe-settlement', () => {
      const value = { returnedAt: this.time(), ...('witness' in result
        ? { witness: this.json(result.witness, 'wipe-witness', 65536) }
        : { error: this.text(String(result.error), 'wipe-error') }) }
      if (record) this.retain(value, 'wipe-settlement', () => Object.assign(record, value))
    })
  }
  /** Per logical call: the original client's three attempts and body consumer remain in charge. */
  metrics(origin: string, label: string, phase: string, delegate: typeof fetch = fetch) {
    const configured = new URL(origin)
    if (configured.origin !== origin || configured.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(configured.hostname)
      || configured.port === '8787' || configured.username || configured.password || configured.pathname !== '/' || configured.search || configured.hash) {
      throw new Error('Observed metrics require the exact configured owned local origin')
    }
    const number = ++this.evidence.observedCounts.operations
    this.evidence.observedCounts.metricsOperations++
    const operation: MetricsOperation = {
      id: `m${number}`, operation: number, kind: 'metrics', label: this.text(label, 'metrics-label', 128), phase: this.text(phase, 'metrics-phase', 128),
      method: 'GET', pathname: '/__orbit/publish/metrics', startedAt: this.time(), attempts: 0, consumer: null,
    }
    this.observe('metrics-operation', () => {
      if (number > 1024) this.excess('operations', 1024)
      else this.retain(operation, 'metrics-operation', () => this.evidence.metricsOperations.push(operation))
    })
    const fetcher: typeof fetch = async (input, init) => {
      const attempt = ++operation.attempts
      const record: MetricsAttempt = { operationId: operation.id, attempt, startedAt: this.time(), url: null, delegated: false, headers: null, error: null }
      let delegated = false
      this.observe('metrics-attempt', () => {
        if (++this.evidence.observedCounts.metricsAttempts > 3072) this.excess('metrics-attempts', 3072)
        else this.retain(record, 'metrics-attempt', () => this.evidence.metricsAttempts.push(record))
      })
      try {
        // The seam receives the client's URL string, never a rewritten Request or RequestInit.
        if (typeof input !== 'string' || number > 1024 || attempt > 3) throw new Error('Invalid observed metrics attempt identity')
        const url = new URL(input)
        if (url.origin !== origin || url.pathname !== '/__orbit/publish/metrics' || url.username || url.password || url.hash
          || url.searchParams.has('__orbit_capacity_op')) throw new Error('Observed metrics URL is outside the owned untagged metrics route')
        if (init?.method !== 'GET' || init.body !== undefined) throw new Error('Observed metrics must remain a bodyless GET')
        // Keep the original query spelling as well as its values; URLSearchParams
        // serialization would otherwise normalize existing escapes/spaces.
        const tagged = `${url.href}${url.search ? '&' : url.href.endsWith('?') ? '' : '?'}__orbit_capacity_op=s82.${this.evidence.caseNonce}.m${number}.a${attempt}`
        this.observe('metrics-url', () => {
          const value = this.text(tagged, 'metrics-url')
          this.retain({ url: value }, 'metrics-url', () => { record.url = value })
        })
        delegated = true
        this.observe('metrics-delegate', () => { this.retain({ delegated: true }, 'metrics-delegate', () => { record.delegated = true }) })
        const response = await delegate(tagged, init)
        this.observe('metrics-headers', () => {
          const value = { at: this.time(), status: response.status }
          this.retain({ headers: value }, 'metrics-headers', () => { record.headers = value })
        })
        return response
      } catch (error) {
        this.observe('metrics-error', () => {
          this.evidence.observedCounts.errors++
          this.evidence.observedCounts.metricsAttemptErrors++
          const code = (error as NodeJS.ErrnoException | null)?.code
          const value = { source: delegated ? 'fetch' as const : 'request-validation' as const, at: this.time(), message: this.text(String(error), 'metrics-error'), code: typeof code === 'string' ? this.text(code, 'metrics-error-code') : null }
          this.retain({ error: value }, 'metrics-error', () => { record.error = value })
        })
        throw error
      }
    }
    const consume = async <T extends PublicationMetrics>(action: () => Promise<T>): Promise<T> => {
      try {
        const result = await action()
        this.observe('metrics-consumer', () => {
          const consumer = { at: this.time(), outcome: 'validated-result' as const, result: this.json(result, 'metrics-result', 4096) }
          this.retain({ consumer }, 'metrics-consumer', () => { operation.consumer = consumer })
        })
        return result
      } catch (error) {
        this.observe('metrics-consumer-error', () => {
          this.evidence.observedCounts.errors++
          this.evidence.observedCounts.metricsConsumerErrors++
          const code = (error as NodeJS.ErrnoException | null)?.code
          const consumer = {
            at: this.time(), outcome: 'error' as const,
            error: { source: 'consumer' as const, message: this.text(String(error), 'metrics-consumer-error'), code: typeof code === 'string' ? this.text(code, 'metrics-consumer-error-code') : null },
          }
          this.retain({ consumer }, 'metrics-consumer-error', () => { operation.consumer = consumer })
        })
        throw error
      }
    }
    return { fetcher, consume }
  }
  assertHealthy(): void {
    if (this.evidence.overflow.count || this.evidence.observerFailures.count) {
      throw new Error(`HTTP observation incomplete: ${this.evidence.overflow.count} overflows; ${this.evidence.observerFailures.count} observer failures`)
    }
    const unclosed = this.evidence.operations.filter(operation => !operation.closure?.confirmed)
    if (unclosed.length) throw new Error(`HTTP ownership closure incomplete: ${unclosed.map(operation => operation.id).join(', ')}`)
    const failed = this.evidence.operations.filter(operation => operation.closure?.failures.length)
    if (failed.length) throw new Error(`HTTP ownership cleanup failed: ${failed.map(operation => operation.id).join(', ')}`)
    if (this.evidence.metricsOperations.some(operation => !operation.consumer)
      || this.evidence.metricsAttempts.some(attempt => !attempt.headers && !attempt.error)) throw new Error('Metrics observation has an unsettled attempt/consumer')
    if (this.evidence.wipes.some(wipe => !wipe.witness && !wipe.error)) throw new Error('Wipe observation has no result or failure')
  }
}

/** Recording is separate from first logical terminal settlement and from physical ownership. */
class HttpNodeRecorder {
  constructor(readonly context: HttpObservation, readonly data: NodeHttpOperation, private readonly retained: boolean) {}
  put<K extends keyof NodeHttpOperation>(key: K, value: NodeHttpOperation[K]): void {
    this.context.observe(`node-${String(key)}`, () => {
      if (this.retained) this.context.retain({ [key]: value }, `node-${String(key)}`, () => { this.data[key] = value })
    })
  }
  event(name: string): void {
    this.context.observe('node-event', () => {
      const sequence = ++this.data.observedCounts.events
      this.context.evidence.observedCounts.events++
      // Use the same bounded retention path even when the parent record was refused.
      if (sequence > 64) {
        this.context.excess('events-per-operation', 64)
        return
      }
      const event = { sequence, name: this.context.text(name, 'event-name'), phase: this.data.phase, at: this.context.time() }
      if (this.retained) this.context.retain(event, 'node-event', () => this.data.events.push(event))
    })
  }
  error(source: string, error: unknown, intentional: boolean, afterResponseEnd: boolean, duringCleanup: boolean, afterClosure = false): void {
    this.context.observe('node-error', () => {
      const number = ++this.data.observedCounts.errors
      this.context.evidence.observedCounts.errors++
      if (number > 32) { this.context.excess('errors-per-operation', 32); return }
      const code = (error as NodeJS.ErrnoException | null)?.code
      const record: ObservedHttpError = {
        source, message: this.context.text(String(error), 'error'), code: typeof code === 'string' ? this.context.text(code, 'error-code') : null,
        at: this.context.time(), intentional, afterResponseEnd, duringCleanup, afterClosure,
      }
      if (this.retained) this.context.retain(record, 'node-error', () => this.data.errors.push(record))
    })
    this.event(`${source}-error`)
  }
  phase(phase: string): void { this.put('phase', this.context.text(phase, 'phase', 128)); this.event('phase-change') }
  terminal(kind: 'complete-body' | 'error', source?: string, error?: unknown): void {
    this.context.observe('node-terminal', () => {
      if (!this.data.terminal) this.put('terminal', {
        kind, at: this.context.time(), ...(source ? { source } : {}),
        ...(kind === 'error' ? { error: this.context.text(String(error), 'terminal-error') } : {}),
      })
    })
  }
}

/** Early latches on this exact Node request/socket; there is only one destruction/join budget. */
class ObservedNodeOwner {
  request: ClientRequest | undefined
  response: IncomingMessage | undefined
  private socket: Socket | undefined
  private requestClose: HttpTime | undefined
  private socketClose: HttpTime | undefined
  private responseEnded = false
  private joining: Promise<ObservedHttpClosure> | undefined
  private outcome: ObservedHttpClosure | undefined
  private destructionFailures = 0
  private check = () => {}
  constructor(readonly recorder: HttpNodeRecorder) {}
  private at(): HttpTime { return this.recorder.context.time() }
  private retainClosure(): void {
    if (this.outcome) this.recorder.put('closure', { ...this.outcome, failures: [...this.outcome.failures] })
  }
  private acquisition(): void {
    this.recorder.put('acquisition', { request: Boolean(this.request), socket: Boolean(this.socket), response: Boolean(this.response) })
  }
  ownRequest(request: ClientRequest): void {
    this.request = request
    this.acquisition()
    request.on('error', error => this.error('request', error))
    request.on('close', () => {
      this.requestClose ??= this.at()
      this.recorder.event('request-close')
      this.check()
    })
    request.on('socket', socket => this.ownSocket(socket))
    if (request.socket) this.ownSocket(request.socket)
    this.recorder.event('request-acquired')
  }
  private ownSocket(socket: Socket): void {
    if (this.socket === socket) return
    if (this.socket) {
      this.error('socket', new Error('Observed request acquired a replacement socket'))
      this.destructionFailures++
      if (this.outcome) {
        this.outcome.confirmed = false
        if (!this.outcome.failures.includes('The owned request reported a replacement socket')) this.outcome.failures.push('The owned request reported a replacement socket')
        this.retainClosure()
      }
      return
    }
    this.socket = socket
    this.acquisition()
    socket.on('error', error => this.error('socket', error))
    socket.on('close', () => {
      this.socketClose ??= this.at()
      this.recorder.event('socket-close')
      this.check()
    })
    this.recorder.event('socket-acquired')
    if (this.outcome) {
      this.outcome.confirmed = false
      this.outcome.failures.push('A socket was acquired after the original join had settled')
      this.retainClosure()
    }
  }
  ownResponse(response: IncomingMessage): void {
    this.response = response
    this.acquisition()
    this.recorder.put('status', response.statusCode ?? null)
    response.on('end', () => { this.responseEnded = true; this.recorder.event('response-end') })
    response.on('error', error => this.error('response', error))
    response.on('aborted', () => this.recorder.event('response-aborted'))
    response.on('close', () => this.recorder.event('response-close'))
    this.recorder.event('response-headers')
  }
  error(source: string, error: unknown): void {
    // A close receipt describes physical closure only. All original errors,
    // including late ones, stay unqualified for the required actual-artifact
    // review; phase/code/closure never turns them into intentional errors.
    this.recorder.error(source, error, false, this.responseEnded, Boolean(this.joining), Boolean(this.outcome))
  }
  close(reason: string, requestError?: Error): Promise<ObservedHttpClosure> {
    if (this.joining) return this.joining
    const startedAt = this.at()
    const deadline = startedAt.monotonicMs + 3000
    this.recorder.put('cancellationIntent', { reason: this.recorder.context.text(reason, 'cancellation-reason'), at: startedAt })
    this.recorder.event('destruction-requested')
    let complete!: (value: ObservedHttpClosure) => void
    this.joining = new Promise(resolve => { complete = resolve })
    const finish = (expired: boolean) => {
      if (this.outcome) return
      const requestClosed = Boolean(this.requestClose && this.requestClose.monotonicMs <= deadline)
      const socketClosed = Boolean(this.socketClose && this.socketClose.monotonicMs <= deadline)
      const confirmed = this.request
        ? requestClosed && (this.socket ? socketClosed : !this.responseEnded)
        : !this.socket && !this.response
      const settledAt = this.at()
      if (!expired && !confirmed && settledAt.monotonicMs <= deadline) return
      clearTimeout(timer)
      const failures: string[] = []
      if (!confirmed) failures.push('Owned HTTP request/socket closure unconfirmed within the original 3000 ms')
      if (this.responseEnded && !this.socket) failures.push('A complete response has no acquired actual socket evidence')
      if (this.destructionFailures) failures.push(`${this.destructionFailures} owned destruction/ownership failures`)
      this.outcome = {
        confirmed, requestAcquired: Boolean(this.request), requestClosed,
        socket: this.socket ? socketClosed ? 'closed' : 'unconfirmed' : 'not-acquired',
        responseEnded: this.responseEnded, startedAt, deadline, settledAt, joinBudgetMs: 3000, failures,
      }
      this.retainClosure()
      complete(this.outcome)
    }
    const timer = setTimeout(() => finish(true), 3000)
    this.check = () => finish(false)
    // Keep both attempts independent. A response destroy throw cannot skip the request.
    for (const destroy of [() => this.response?.destroy(), () => this.request?.destroy(requestError)]) {
      try { destroy() } catch (error) {
        this.destructionFailures++
        this.error('destroy', error)
        if (this.outcome && !this.outcome.failures.some(failure => failure.includes('destruction/ownership'))) {
          this.outcome.failures.push('Owned destruction/ownership failed after a synchronous close event')
          this.retainClosure()
        }
      }
    }
    this.check()
    return this.joining
  }
}

export function rawRequest(origin: string, path: string, options: {
  method?: string
  headers?: OutgoingHttpHeaders
  body?: Buffer | string
  timeoutMs?: number
  observation?: HttpObservationScope
  /** Controlled owned producer seam; absent in real callers. */
  transport?: HeldRequestTransport
} = {}): Promise<RawResponse> {
  if (options.observation) return observedRawRequest(origin, path, options as typeof options & { observation: HttpObservationScope })
  return new Promise((resolve, reject) => {
    const req = httpRequest(new URL(path, origin), {
      method: options.method ?? 'GET', headers: options.headers ?? {}, agent: false,
    }, response => {
      const chunks: Buffer[] = []
      response.on('data', chunk => chunks.push(chunk))
      response.on('error', reject)
      response.on('end', () => resolve({ status: response.statusCode!, headers: response.headers, body: Buffer.concat(chunks) }))
    })
    req.on('error', reject)
    req.setTimeout(options.timeoutMs ?? 30_000, () => req.destroy(new Error('Worker contract request timed out')))
    if (options.body !== undefined) req.write(options.body)
    req.end()
  })
}

async function observedRawRequest(origin: string, path: string, options: {
  method?: string; headers?: OutgoingHttpHeaders; body?: Buffer | string; timeoutMs?: number
  observation: HttpObservationScope; transport?: HeldRequestTransport
}): Promise<RawResponse> {
  const url = new URL(path, origin)
  const encoding = options.headers?.['Accept-Encoding'] ?? options.headers?.['accept-encoding']
  const recorder = options.observation.context.node(options.observation, 'raw', options.method ?? 'GET', url.pathname,
    typeof encoding === 'string' ? { encoding } : {})
  const owner = new ObservedNodeOwner(recorder)
  const pending = new Promise<RawResponse>((resolve, reject) => {
    try {
      const request = (options.transport ?? httpRequest)(url, { method: options.method ?? 'GET', headers: options.headers ?? {}, agent: false }, response => {
        owner.ownResponse(response)
        const chunks: Buffer[] = []
        response.on('error', reject)
        response.on('aborted', () => reject(new Error(`Response aborted before end: ${path}`)))
        response.on('close', () => {
          if (!response.complete) reject(new Error(`Response closed before end: ${path}`))
        })
        response.on('end', () => {
          recorder.terminal('complete-body')
          resolve({ status: response.statusCode!, headers: response.headers, body: Buffer.concat(chunks) })
        })
        response.on('data', chunk => chunks.push(chunk))
      })
      owner.ownRequest(request)
      request.on('error', reject)
      request.setTimeout(options.timeoutMs ?? 30_000, () => {
        const error = new Error('Worker contract request timed out')
        recorder.terminal('error', 'timeout', error)
        owner.error('timeout', error)
        void owner.close('timeout', error)
        reject(error)
      })
      if (options.body !== undefined) request.write(options.body)
      request.end()
    } catch (error) {
      owner.error('acquisition', error)
      reject(error)
    }
  })
  try {
    const response = await pending
    await owner.close('complete-body-finalization')
    return response
  } catch (error) {
    recorder.terminal('error', 'request', error)
    await owner.close('failed-request-finalization')
    throw error
  }
}

/** Decode a wire body according to its Content-Encoding header. */
export function decodedBody(response: RawResponse): Buffer {
  const encoding = response.headers['content-encoding']
  if (encoding === 'gzip') return gunzipSync(response.body)
  if (encoding === 'br') return brotliDecompressSync(response.body)
  if (encoding === undefined || encoding === 'identity') return response.body
  throw new Error(`Unexpected Content-Encoding ${String(encoding)}`)
}

export const jsonBody = (response: RawResponse): unknown => JSON.parse(decodedBody(response).toString('utf8'))

/**
 * A reader that takes the response headers plus the first data chunk and then
 * pauses the socket, so the Durable Object stream stays active until `finish()`
 * resumes reading or `destroy()` drops the socket. The handle exists before any
 * byte arrives (register it first, assert afterwards), keeps one stored terminal
 * state (end, error, abort, close-before-end, timeout, destroy) and `finish()`
 * always settles from that state even when the event already happened (AWT82-5/MWT82-5).
 */
export interface SlowStream {
  readonly path: string
  /** Resolves once status, headers and the first body chunk (or an empty end) arrived; rejects on request failure. */
  readonly ready: Promise<void>
  status: number | undefined
  headers: IncomingHttpHeaders
  firstChunkBytes: number
  state: 'opening' | 'paused' | 'finishing' | 'ended' | 'failed' | 'destroyed'
  finish: () => Promise<Buffer>
  destroy: () => void
  /** Present only for the explicitly observed capacity owners. */
  observation?: NodeHttpOperation
  phase?: (phase: string) => void
  cleanup?: () => Promise<ObservedHttpClosure>
}

type Terminal = { kind: 'ended' } | { kind: 'error'; error: Error }

export function openSlowStream(origin: string, path: string, headers: OutgoingHttpHeaders = {}, observation?: HttpObservationScope, transport: HeldRequestTransport = httpRequest): SlowStream {
  if (observation) return observedSlowStream(origin, path, headers, observation, transport)
  const chunks: Buffer[] = []
  let terminal: Terminal | null = null
  let message: IncomingMessage | undefined
  let finishing: { resolve: (body: Buffer) => void; reject: (error: Error) => void } | null = null
  let readySettled = false
  let resolveReady!: () => void
  let rejectReady!: (error: Error) => void
  const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject })
  // A late rejection with no listener must not become an unhandled rejection.
  ready.catch(() => {})
  const stream: SlowStream = { path, ready, status: undefined, headers: {}, firstChunkBytes: 0, state: 'opening', finish, destroy }
  const settle = (value: Terminal) => {
    if (terminal) return
    terminal = value
    if (stream.state !== 'destroyed') stream.state = value.kind === 'ended' ? 'ended' : 'failed'
    if (!readySettled) {
      readySettled = true
      if (value.kind === 'ended') resolveReady()
      else rejectReady(value.error)
    }
    if (finishing) {
      const waiting = finishing
      finishing = null
      if (value.kind === 'ended') waiting.resolve(Buffer.concat(chunks))
      else waiting.reject(value.error)
    }
  }
  const req = httpRequest(new URL(path, origin), { method: 'GET', headers, agent: false }, response => {
    message = response
    stream.status = response.statusCode
    stream.headers = response.headers
    response.on('data', chunk => {
      chunks.push(chunk)
      if (!readySettled) {
        stream.firstChunkBytes = chunk.length
        stream.state = 'paused'
        response.pause()
        readySettled = true
        resolveReady()
      }
    })
    response.on('end', () => settle({ kind: 'ended' }))
    response.on('aborted', () => settle({ kind: 'error', error: new Error(`Response aborted before end: ${path}`) }))
    response.on('error', error => settle({ kind: 'error', error }))
    response.on('close', () => settle({ kind: 'error', error: new Error(`Response closed before end: ${path}`) }))
  })
  req.on('error', error => settle({ kind: 'error', error }))
  req.setTimeout(60_000, () => {
    settle({ kind: 'error', error: new Error(`Slow stream timed out: ${path}`) })
    req.destroy()
  })
  req.end()

  function finish(): Promise<Buffer> {
    if (terminal) return terminal.kind === 'ended' ? Promise.resolve(Buffer.concat(chunks)) : Promise.reject(terminal.error)
    return new Promise<Buffer>((resolve, reject) => {
      finishing = { resolve, reject }
      stream.state = 'finishing'
      message?.resume()
    })
  }
  function destroy(): void {
    if (stream.state === 'destroyed') return
    stream.state = 'destroyed'
    message?.destroy()
    req.destroy()
    settle({ kind: 'error', error: new Error(`Stream destroyed by the test: ${path}`) })
  }
  return stream
}

function observedSlowStream(origin: string, path: string, headers: OutgoingHttpHeaders, scope: HttpObservationScope, transport: HeldRequestTransport): SlowStream {
  const url = new URL(path, origin)
  const encoding = headers['Accept-Encoding']
  const recorder = scope.context.node(scope, 'slow-stream', 'GET', url.pathname, typeof encoding === 'string' ? { encoding } : {})
  const owner = new ObservedNodeOwner(recorder)
  const chunks: Buffer[] = []
  let terminal: Terminal | null = null
  let finishing: { resolve: (body: Buffer) => void; reject: (error: Error) => void } | null = null
  let readySettled = false
  let resolveReady!: () => void
  let rejectReady!: (error: unknown) => void
  const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject })
  ready.catch(() => {})
  const intentionalDestroy = new Error(`Stream destroyed by the test: ${path}`)
  const stream: SlowStream = {
    path, ready, status: undefined, headers: {}, firstChunkBytes: 0, state: 'opening',
    observation: recorder.data, phase: phase => recorder.phase(phase),
    finish: () => {
      recorder.event('finish-requested')
      if (terminal) return terminal.kind === 'ended' ? Promise.resolve(Buffer.concat(chunks)) : Promise.reject(terminal.error)
      return new Promise<Buffer>((resolve, reject) => {
        finishing = { resolve, reject }
        stream.state = 'finishing'
        owner.response?.resume()
      })
    },
    destroy: () => { void close('test-destroy') },
    cleanup: () => close('finalizer'),
  }
  const settle = (value: Terminal, source: string) => {
    if (terminal) return
    terminal = value
    recorder.terminal(value.kind === 'ended' ? 'complete-body' : 'error', source, value.kind === 'error' ? value.error : undefined)
    if (stream.state !== 'destroyed') stream.state = value.kind === 'ended' ? 'ended' : 'failed'
    if (!readySettled) {
      readySettled = true
      if (value.kind === 'ended') resolveReady()
      else rejectReady(value.error)
    }
    if (finishing) {
      const waiting = finishing
      finishing = null
      if (value.kind === 'ended') waiting.resolve(Buffer.concat(chunks))
      else waiting.reject(value.error)
    }
  }
  function close(reason: string): Promise<ObservedHttpClosure> {
    // This intent and the original join begin at the existing cancel point, not
    // at a later awaited finalizer. Body completion remains the first terminal.
    stream.state = 'destroyed'
    const closing = owner.close(reason)
    if (!terminal) {
      recorder.error('test-destroy', intentionalDestroy, true, false, true)
      settle({ kind: 'error', error: intentionalDestroy }, 'test-destroy')
    }
    return closing
  }
  try {
    const request = transport(url, { method: 'GET', headers, agent: false }, response => {
      owner.ownResponse(response)
      stream.status = response.statusCode
      stream.headers = response.headers
      // Latches precede data consumption; events/errors are retained even if
      // settle() has already preserved a different first terminal.
      response.on('end', () => settle({ kind: 'ended' }, 'response-end'))
      response.on('aborted', () => settle({ kind: 'error', error: new Error(`Response aborted before end: ${path}`) }, 'response-aborted'))
      response.on('error', error => { settle({ kind: 'error', error }, 'response-error'); void owner.close('response-error') })
      response.on('close', () => {
        if (!terminal) settle({ kind: 'error', error: new Error(`Response closed before end: ${path}`) }, 'response-close')
      })
      response.on('data', chunk => {
        chunks.push(chunk)
        if (!readySettled) {
          stream.firstChunkBytes = chunk.length
          stream.state = 'paused'
          response.pause()
          readySettled = true
          recorder.event('first-chunk-paused')
          resolveReady()
        }
      })
    })
    owner.ownRequest(request)
    request.on('error', error => { settle({ kind: 'error', error }, 'request-error'); void owner.close('request-error') })
    request.setTimeout(60_000, () => {
      const error = new Error(`Slow stream timed out: ${path}`)
      owner.error('timeout', error)
      settle({ kind: 'error', error }, 'timeout')
      void owner.close('timeout')
    })
    request.end()
  } catch (error) {
    owner.error('acquisition', error)
    // The already-owned handle is still returned to its registry, with the
    // identical acquisition error delivered through ready()/finish().
    settle({ kind: 'error', error: error as Error }, 'acquisition')
    void owner.close('partial-acquisition')
  }
  return stream
}

export interface StreamClosureBatch {
  configuredAllowanceMs: 3000
  outcomes: { index: number; outcome?: ObservedHttpClosure; error?: string }[]
  failures: string[]
}

/** Owns every opened handle from creation, so a failed assertion still tears every socket down in `finally`. */
export class StreamRegistry {
  readonly streams: SlowStream[] = []
  private closing: Promise<StreamClosureBatch> | undefined
  constructor(readonly observation?: HttpObservation) {}
  open(origin: string, path: string, headers: OutgoingHttpHeaders = {}, label = `stream-${this.streams.length}`, phase = 'opening'): SlowStream {
    const stream = openSlowStream(origin, path, headers, this.observation?.scope(label, phase))
    this.streams.push(stream)
    return stream
  }
  destroyAll(): void {
    for (const stream of this.streams) stream.destroy()
  }
  phase(phase: string, streams: SlowStream[] = this.streams): void { for (const stream of streams) stream.phase?.(phase) }
  cleanupAll(): Promise<StreamClosureBatch> {
    if (this.closing) return this.closing
    // All callbacks are scheduled before awaiting any join. A synchronous
    // failure or one unconfirmed handle never prevents another owner's start.
    const attempts = this.streams.map(stream => Promise.resolve().then(() => {
      stream.phase?.('finalization')
      if (!stream.cleanup) { stream.destroy(); throw new Error('Stream has no observed physical close join') }
      return stream.cleanup()
    }))
    this.closing = Promise.allSettled(attempts).then((results): StreamClosureBatch => {
      const outcomes: StreamClosureBatch['outcomes'] = []
      const failures: string[] = []
      for (const [index, result] of results.entries()) {
        if (result.status === 'rejected') {
          outcomes.push({ index, error: String(result.reason) })
          failures.push(`stream-${index}: ${String(result.reason)}`)
        } else {
          outcomes.push({ index, outcome: result.value })
          if (!result.value.confirmed || result.value.failures.length) failures.push(`stream-${index}: ${result.value.failures.join('; ')}`)
        }
      }
      return { configuredAllowanceMs: 3000, outcomes, failures }
    })
    return this.closing
  }
}

export const CONTRACT_TOKEN = 'fictional-worker-contract-token-0123456789abcdef0123456789abcdef0123456789'
export const authorized = (extra: OutgoingHttpHeaders = {}): OutgoingHttpHeaders => ({ Authorization: `Bearer ${CONTRACT_TOKEN}`, ...extra })

export function contractClient(origin: string, signal?: AbortSignal, fetcher?: typeof fetch) {
  return createPublicationClient({ url: origin, token: CONTRACT_TOKEN, signal, ...(fetcher ? { fetcher } : {}) })
}

export function observedMetrics(origin: string, scope: HttpObservationScope): Promise<PublicationMetrics> {
  const operation = scope.context.metrics(origin, scope.label, scope.phase)
  return operation.consume(() => contractClient(origin, undefined, operation.fetcher).metrics())
}

/**
 * A request whose headers (including Content-Length) are sent immediately while
 * the body is withheld. `response` settles when the server answers; the caller
 * then decides whether to send the body or drop the connection. This is the
 * witness for "decided before the body was consumed" (MCAP82-5): the server
 * cannot have read bytes that were never written.
 */
export interface HeldRequest {
  readonly response: Promise<RawResponse>
  readonly observation: HeldRequestObservation
  /** Bytes of body written so far (always 0 until `sendBody`). */
  sentBodyBytes: number
  sendBody: (body: Buffer) => void
  /** Idempotent; the same 3000ms join budget is shared by the owner and all finalizers. */
  cleanup: () => Promise<HeldRequestClosure>
  destroy: () => void
}
export interface HeldRequestError {
  source: 'request' | 'response' | 'socket' | 'destroy'
  message: string
  code: string | null
  afterResponseEnd: boolean
  duringCleanup: boolean
  intentional: boolean
}
export interface HeldRequestObservation {
  requestAcquired: boolean
  socketAcquired: boolean
  requestClosed: boolean
  socketClosed: boolean
  /** Raw monotonic instants in this owner's clock domain; null until observed. */
  requestClosedAt: number | null
  socketClosedAt: number | null
  cleanupStartedAt: number | null
  cleanupDeadline: number | null
  responseEnded: boolean
  responseClosed: boolean
  cleanupRequested: boolean
  events: string[]
  errors: HeldRequestError[]
}
export interface HeldRequestClosure {
  confirmed: boolean
  requestClosed: boolean
  socket: 'closed' | 'not-acquired' | 'unconfirmed'
  responseEnded: boolean
  /** Raw monotonic instants, never rounded or renewed by another finalizer. */
  startedAt: number
  deadline: number
  settledAt: number
  requestClosedAt: number | null
  socketClosedAt: number | null
  joinBudgetMs: 3000
  elapsedMs: number
  errors: HeldRequestError[]
  failures: string[]
}
export class HeldRequestAcquisitionError extends Error {
  constructor(readonly primary: unknown, readonly observation: HeldRequestObservation, readonly cleanup: HeldRequestClosure | null) {
    super(`${String(primary)} [held request ${observation.requestAcquired ? cleanup?.confirmed ? 'cleanup closure confirmed' : 'cleanup closure unconfirmed' : 'not acquired'}]${cleanup?.failures.length ? ` [cleanup: ${cleanup.failures.join('; ')}]` : ''}`)
    this.name = 'HeldRequestAcquisitionError'
  }
}
/** Explicit controlled-transport seam for ASC03-R2 failure witnesses; real callers use Node's client. */
export type HeldRequestTransport = (url: URL, options: RequestOptions, response: (message: IncomingMessage) => void) => ClientRequest
export async function openHeldRequest(origin: string, path: string, options: { method: string; headers: OutgoingHttpHeaders; timeoutMs?: number; observation?: HttpObservationScope }, transport: HeldRequestTransport = httpRequest): Promise<HeldRequest> {
  let settle!: { resolve: (value: RawResponse) => void; reject: (error: Error) => void }
  const response = new Promise<RawResponse>((resolve, reject) => { settle = { resolve, reject } })
  response.catch(() => {})
  const observation: HeldRequestObservation = {
    requestAcquired: false, socketAcquired: false, requestClosed: false, socketClosed: false,
    requestClosedAt: null, socketClosedAt: null, cleanupStartedAt: null, cleanupDeadline: null,
    responseEnded: false, responseClosed: false, cleanupRequested: false, events: [], errors: [],
  }
  const now = () => options.observation ? options.observation.context.time().monotonicMs : performance.now()
  const diagnostic = options.observation
    ? options.observation.context.node(options.observation, 'held-upload', options.method, new URL(path, origin).pathname,
      { declaredLength: Number(options.headers['Content-Length']) })
    : undefined
  const event = (name: string) => {
    diagnostic?.event(name)
    if (!diagnostic) observation.events.push(name)
    else diagnostic.context.observe('held-event', () => {
      if (observation.events.length < 64) diagnostic.context.retain({ heldEvent: name }, 'held-event', () => observation.events.push(name))
    })
  }
  const acquired = () => diagnostic?.put('acquisition', { request: observation.requestAcquired, socket: observation.socketAcquired, response: Boolean(message) })
  let req: ClientRequest | undefined
  let socket: Socket | undefined
  let message: IncomingMessage | undefined
  let cleanupPromise: Promise<HeldRequestClosure> | undefined
  let cleanupOutcome: HeldRequestClosure | undefined
  let observeClosure = () => {}
  const retainClosure = () => {
    if (!cleanupOutcome) return
    // Later actual closes remain evidence, but cannot rehabilitate the original
    // verdict, move its deadline/settlement, or remove an earlier failure.
    cleanupOutcome.requestClosed = observation.requestClosed
    cleanupOutcome.requestClosedAt = observation.requestClosedAt
    cleanupOutcome.socketClosedAt = observation.socketClosedAt
    cleanupOutcome.socket = observation.socketAcquired ? observation.socketClosed ? 'closed' : 'unconfirmed' : 'not-acquired'
    diagnostic?.put('closure', { ...cleanupOutcome, errors: [...cleanupOutcome.errors], failures: [...cleanupOutcome.failures] })
  }
  // Only this exact helper-owned Error object is intentional. Neither a shared
  // error code nor a native warning string can make another error harmless.
  const intentionalDestroy = new Error(`Held request intentionally destroyed by the test: ${path}`)
  const errorObserved = (source: HeldRequestError['source'], error: Error) => {
    diagnostic?.error(source, error, error === intentionalDestroy, observation.responseEnded, observation.cleanupRequested, Boolean(cleanupOutcome))
    const retainLegacy = () => {
      const code = (error as NodeJS.ErrnoException).code
      const detail: HeldRequestError = {
        source, message: String(error), code: typeof code === 'string' ? code : null,
        afterResponseEnd: observation.responseEnded, duringCleanup: observation.cleanupRequested, intentional: error === intentionalDestroy,
      }
      if (!diagnostic) observation.errors.push(detail)
      else {
        const text = diagnostic.context.text(detail.message, 'held-error')
        const boundedCode = detail.code === null ? null : diagnostic.context.text(detail.code, 'held-error-code')
        detail.message = typeof text === 'string' ? text : text.prefix
        detail.code = typeof boundedCode === 'string' || boundedCode === null ? boundedCode : boundedCode.prefix
        if (observation.errors.length < 32) diagnostic.context.retain({ heldError: detail }, 'held-error', () => observation.errors.push(detail))
      }
      // The one cleanup promise/budget never restarts. A later error still
      // updates its retained outcome, even after request/socket closure.
      if (cleanupOutcome && (!diagnostic || cleanupOutcome.errors.length < 32)) {
        cleanupOutcome.errors.push(detail)
        if (!detail.intentional) cleanupOutcome.failures.push(`${source}: ${detail.message}`)
        retainClosure()
      }
      // diagnostic.error already recorded the corresponding event.
      if (!diagnostic) observation.events.push(`${source}-error`)
      else if (observation.events.length < 64) {
        diagnostic.context.retain({ heldEvent: `${source}-error` }, 'held-error-event', () => observation.events.push(`${source}-error`))
      }
    }
    if (diagnostic) diagnostic.context.observe('held-error', retainLegacy)
    else retainLegacy()
    if (!observation.responseEnded) { diagnostic?.terminal('error', source, error); settle.reject(error) }
  }
  const ownSocket = (acquired: Socket) => {
    if (socket === acquired) return
    if (socket) {
      errorObserved('socket', new Error('Held request acquired a replacement socket'))
      return
    }
    socket = acquired
    observation.socketAcquired = true
    diagnostic?.put('acquisition', { request: observation.requestAcquired, socket: true, response: Boolean(message) })
    event('socket-acquired')
    socket.on('error', error => errorObserved('socket', error))
    socket.on('close', () => {
      observation.socketClosedAt ??= now()
      observation.socketClosed = true
      event('socket-close')
      observeClosure()
    })
  }
  const cleanup = (): Promise<HeldRequestClosure> => {
    if (cleanupPromise) return cleanupPromise
    const started = now()
    const deadline = started + 3000
    observation.cleanupStartedAt = started
    observation.cleanupDeadline = deadline
    observation.cleanupRequested = true
    if (diagnostic) diagnostic.put('cancellationIntent', { reason: 'held-request-cleanup', at: diagnostic.context.time() })
    event('cleanup-requested')
    let complete!: (outcome: HeldRequestClosure) => void
    cleanupPromise = new Promise(resolve => { complete = resolve })
    let completed = false
    const finish = (expired: boolean) => {
      if (completed) { retainClosure(); return }
      const settledAt = now()
      const noSocket = observation.requestClosed && !observation.socketAcquired
      const requestClosedOnTime = observation.requestClosedAt !== null && observation.requestClosedAt <= deadline
      const socketClosedOnTime = observation.socketClosedAt !== null && observation.socketClosedAt <= deadline
      const confirmed = requestClosedOnTime && (socketClosedOnTime || (noSocket && !observation.responseEnded))
      // A close callback can precede an overdue timeout callback. Qualify the
      // actual events against D, not callback order or rounded elapsed time.
      if (!expired && !confirmed && settledAt <= deadline) return
      completed = true
      clearTimeout(timer)
      const failures = observation.errors.filter(error => !error.intentional).map(error => `${error.source}: ${error.message}`)
      if (!confirmed) failures.push('Held request/socket closure unconfirmed within 3000 ms')
      if (observation.responseEnded && !observation.socketAcquired) failures.push('A complete response has no acquired actual socket evidence')
      cleanupOutcome = {
        confirmed, requestClosed: observation.requestClosed,
        socket: observation.socketAcquired ? observation.socketClosed ? 'closed' : 'unconfirmed' : 'not-acquired',
        responseEnded: observation.responseEnded, startedAt: started, deadline, settledAt,
        requestClosedAt: observation.requestClosedAt, socketClosedAt: observation.socketClosedAt,
        joinBudgetMs: 3000, elapsedMs: settledAt - started,
        errors: [...observation.errors], failures,
      }
      retainClosure()
      complete(cleanupOutcome)
    }
    const timer = setTimeout(() => finish(true), 3_000)
    observeClosure = () => finish(false)
    // A destruction exception is retained, then the remaining terminal events
    // are still observed against the same timer. Destruction is never retried.
    try { req?.destroy(intentionalDestroy) } catch (error) { errorObserved('destroy', error instanceof Error ? error : new Error(String(error))) }
    observeClosure()
    return cleanupPromise
  }
  const held: HeldRequest = {
    response, observation, sentBodyBytes: 0, cleanup,
    sendBody: body => {
      if (!req || observation.cleanupRequested) throw new Error('Cannot send a body after held-request cleanup')
      held.sentBodyBytes += body.length
      req.end(body)
    },
    destroy: () => { void cleanup() },
  }
  try {
    req = transport(new URL(path, origin), { method: options.method, headers: options.headers, agent: false }, responseMessage => {
      message = responseMessage
      acquired()
      diagnostic?.put('status', responseMessage.statusCode ?? null)
      diagnostic?.event('response-headers')
      const chunks: Buffer[] = []
      responseMessage.on('error', error => errorObserved('response', error))
      responseMessage.on('aborted', () => errorObserved('response', new Error(`Held request response aborted: ${path}`)))
      responseMessage.on('close', () => {
        observation.responseClosed = true
        event('response-close')
        if (!observation.responseEnded) errorObserved('response', new Error(`Held request response closed before end: ${path}`))
      })
      responseMessage.on('end', () => {
        observation.responseEnded = true
        event('response-end')
        diagnostic?.terminal('complete-body')
        settle.resolve({ status: responseMessage.statusCode!, headers: responseMessage.headers, body: Buffer.concat(chunks) })
      })
      responseMessage.on('data', chunk => chunks.push(chunk))
    })
    observation.requestAcquired = true
    acquired()
    event('request-acquired')
    req.on('error', error => errorObserved('request', error))
    req.on('close', () => {
      observation.requestClosedAt ??= now()
      observation.requestClosed = true
      event('request-close')
      if (!observation.responseEnded) settle.reject(new Error(`Held request closed before response end: ${path}`))
      observeClosure()
    })
    req.on('socket', ownSocket)
    if (req.socket) ownSocket(req.socket)
    // Every latch is attached before fallible post-acquisition work.
    req.setTimeout(options.timeoutMs ?? 30_000, () => {
      errorObserved('request', new Error(`Held request timed out: ${path}`))
      void cleanup()
    })
    req.flushHeaders()
    return held
  } catch (error) {
    diagnostic?.error('acquisition', error, false, observation.responseEnded, observation.cleanupRequested)
    diagnostic?.terminal('error', 'acquisition', error)
    settle.reject(error instanceof Error ? error : new Error(String(error)))
    const outcome = observation.requestAcquired ? await cleanup() : null
    throw new HeldRequestAcquisitionError(error, observation, outcome)
  }
}

/** Test-only control routes provided by tests/cloudflare/runtime/entry.ts. */
const EMPTY_STORE = { generations: 0, chunks: 0, payloadBytes: 0, staging: null, activeBodies: 0, peakBodies: 0, activeGenerations: 0, head: null } as const
export interface WipeWitness {
  nonce: string
  abortObserved: boolean
  abortError: string | null
  before: { harnessInstance: string; productInstance: string | null; nativeAlarm: number | null; alarmInFlight: boolean }
  prepared: { harnessInstance: string; nativeAlarmAfterPrepare: number | null }
  after: { harnessInstance: string; productInstance: string | null; nativeAlarm: number | null; alarmInFlight: boolean }
  verified: Record<string, unknown>
}
/**
 * Two-phase verified reset (MWT82-6/AWH82-1): prepare (deleteAll + deleteAlarm
 * awaited), abort with retryAlarm:false, then the product's own metrics/head
 * must read empty from a demonstrably fresh instance. Any other failure, a
 * surviving alarm, an in-flight handler or an unchanged instance fails the case.
 */
export async function wipeStore(origin: string, observation?: HttpObservationScope): Promise<WipeWitness> {
  const wipe = observation?.context.beginWipe(observation) ?? null
  try {
    const response = await rawRequest(origin, '/__test/wipe', { timeoutMs: 120_000, observation })
    const body = jsonBody(response) as Partial<WipeWitness> & { wiped?: boolean; problems?: string[]; stage?: string }
    if (response.status !== 200 || body.wiped !== true || !body.verified) {
      throw new Error(`Store reset was not verified (${body.stage ?? 'unknown stage'}): ${response.status} ${JSON.stringify(body)}`)
    }
    for (const [name, expected] of Object.entries(EMPTY_STORE)) {
      if (body.verified[name] !== expected) throw new Error(`Store reset left ${name}=${JSON.stringify(body.verified[name])}`)
    }
    if (body.abortObserved !== true) throw new Error(`Store reset did not observe the deliberate abort: ${JSON.stringify(body)}`)
    const before = body.before
    const after = body.after
    if (!before || !after || typeof before.harnessInstance !== 'string' || typeof after.harnessInstance !== 'string' || before.harnessInstance === after.harnessInstance) {
      throw new Error(`Store reset did not produce a fresh instance: ${JSON.stringify({ before, after })}`)
    }
    if (after.nativeAlarm !== null || after.alarmInFlight) throw new Error(`Store reset left alarm state: ${JSON.stringify(after)}`)
    const witness = body as WipeWitness
    observation?.context.endWipe(wipe, { witness })
    return witness
  } catch (error) {
    observation?.context.endWipe(wipe, { error })
    throw error
  }
}

export type FaultTarget = 'sql.exec' | 'transactionSync' | 'setAlarm' | 'deleteAlarm' | 'deleteAll'
/** `trace` names a query substring whose real executions are counted in `traced` while the fault is armed (AWL82-2 after-write witness). */
export interface InjectedFault { id: number; target: FaultTarget; match: string | null; remaining: number; hits: number; message: string | null; delayMs: number; trace: string | null; traced: number }
export interface AlarmRecord { op: 'setAlarm' | 'deleteAlarm'; at: number | null; iso: string | null; virtual: boolean; clockNow: string; realAt: string; source: 'request' | 'dispatch' | 'native' }
export interface AlarmCallback { seq: number; source: 'native' | 'dispatch'; real_at: string; clock_at: string; harness_instance: string }
export interface StoreState {
  harnessInstance: string
  constructedAt: string
  clock: { mode: string; now: string; virtualAlarms: boolean }
  nativeAlarm: number | null
  alarmInFlight: boolean
  dispatching: boolean
  preparedNonce: string | null
  records: AlarmRecord[]
  faults: InjectedFault[]
  callbacks: AlarmCallback[]
}
export async function storeRoute<T>(origin: string, route: string, options: { method?: string; body?: unknown; timeoutMs?: number } = {}): Promise<T> {
  // C1: DELETE does not get automatic chunked framing from Node. Serialize once
  // and frame those exact UTF-8 bytes; undefined remains bodyless, null is JSON.
  const serialized = options.body === undefined ? undefined : JSON.stringify(options.body)
  const response = await rawRequest(origin, `/__test/store/${route}`, {
    method: options.method ?? 'GET',
    headers: serialized === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(serialized, 'utf8') },
    body: serialized,
    timeoutMs: options.timeoutMs ?? 120_000,
  })
  const body = jsonBody(response)
  if (response.status !== 200) throw new Error(`Store test route ${route} failed: ${response.status} ${JSON.stringify(body)}`)
  return body as T
}
export const storeState = (origin: string) => storeRoute<StoreState>(origin, 'state')
/** Run the inherited product `alarm()` body now, under the current (usually frozen) clock; returns the alarm calls it made. */
export const dispatchAlarm = (origin: string) => storeRoute<{ dispatched: true; error: string | null; recorded: AlarmRecord[]; clock: StoreState['clock'] }>(origin, 'alarm/dispatch', { method: 'POST', body: {} })
/** Move stored timestamps into the past by the given milliseconds through real SQL updates. */
export const ageTimestamps = (origin: string, input: { stagingCreatedMs?: number; stagingTouchedMs?: number; retiredMs?: number }) =>
  storeRoute<{ aged: Record<string, number> }>(origin, 'alarm/age', { method: 'POST', body: input })
export const injectFault = (origin: string, fault: { target: FaultTarget; match?: string; times?: number; message?: string | null; delayMs?: number; trace?: string }) =>
  storeRoute<{ fault: InjectedFault; faults: InjectedFault[] }>(origin, 'fault', { method: 'POST', body: fault })
export const clearFaults = (origin: string) => storeRoute<{ cleared: InjectedFault[] }>(origin, 'fault', { method: 'DELETE', body: {} })
export const addBallast = (origin: string, rows: number, bytesPerRow: number) =>
  storeRoute<{ inserted: number; bytesPerRow: number; totalRows: number; totalBallastBytes: number; databaseSize: number }>(origin, 'sql/ballast', { method: 'POST', body: { rows, bytesPerRow }, timeoutMs: 600_000 })
export const dropBallast = (origin: string) => storeRoute<{ dropped: true; databaseSize: number }>(origin, 'sql/ballast', { method: 'DELETE', body: {}, timeoutMs: 600_000 })
export const setPhantomPayload = (origin: string, owner: string, size: number) =>
  storeRoute<{ owner: string; size: number; payloadBytes: number; databaseSize: number }>(origin, 'sql/phantom-payload', { method: 'POST', body: { owner, size } })
export const removePhantomPayload = (origin: string, owner: string) =>
  storeRoute<{ removed: { chunks: number; generations: number }; nativeRowsWritten: { chunks: number; generations: number }; payloadBytes: number }>(origin, 'sql/phantom-payload', { method: 'DELETE', body: { owner } })
/** Freeze the Worker clock at an exact UTC millisecond; the reply must echo the same canonical instant. */
export async function freezeClock(origin: string, iso: string): Promise<string> {
  const response = await rawRequest(origin, `/__test/clock?at=${encodeURIComponent(iso)}`)
  const body = jsonBody(response) as { mode?: string; now?: string }
  if (response.status !== 200 || body.mode !== 'frozen' || body.now !== iso) {
    throw new Error(`Clock not frozen at ${iso}: ${response.status} ${JSON.stringify(body)}`)
  }
  return body.now
}
export async function setClockOffset(origin: string, offsetMs: number): Promise<string> {
  const response = await rawRequest(origin, `/__test/clock?offsetMs=${offsetMs}`)
  const body = jsonBody(response) as { mode?: string; now?: string }
  if (response.status !== 200 || body.mode !== 'offset') throw new Error(`Clock offset failed: ${response.status} ${JSON.stringify(body)}`)
  return body.now!
}
export async function realClock(origin: string): Promise<void> {
  const response = await rawRequest(origin, '/__test/clock?mode=real')
  if (response.status !== 200) throw new Error(`Clock reset failed: ${response.status}`)
}
