/**
 * Test-only Worker entry for the stage82 contract, lifecycle, capacity and UI
 * harnesses. It wraps the real product handler and Durable Object class
 * unchanged and adds `/__test/*` routes:
 *
 * - an identity marker and a deterministic clock (absolute frozen time or a
 *   real-time offset; the product only reads Date.now());
 * - an instrumented DurableObjectState handed to the product constructor. It
 *   records every setAlarm/deleteAlarm the product requests, keeps alarms
 *   virtual (recorded, not scheduled) whenever the clock is not real so a frozen
 *   clock can never drive a native alarm loop (MWT82-7/AWH82-2), lets a test
 *   dispatch the inherited `alarm()` body explicitly, and can inject one-shot
 *   failures or delays into named storage calls (sql.exec, transactionSync,
 *   setAlarm, deleteAlarm, deleteAll) and one synchronous one-shot failure into
 *   the state's own `waitUntil` registration (NATIVE82-STREAM-REMEDY-01,
 *   SR01-11(e)) so the product's error propagation is witnessed without any
 *   physical fault;
 * - a two-phase reset (nonce-guarded prepare: deleteAll + deleteAlarm awaited,
 *   then abort with retryAlarm:false) verified by the outer handler against the
 *   product's own metrics/head routes and a fresh instance identity
 *   (MWT82-6/AWH82-1);
 * - real-SQLite admission seams: zero-filled ballast rows that grow the actual
 *   database size, and a phantom referenced chunk row whose recorded size the
 *   product's own payload counter sums (MCAP82-6).
 *
 * Nothing here is part of the deployed Worker; only the test-only wrangler
 * configurations reference it. Faults never fire for the harness's own queries.
 */
import product, { CatalogStore as ProductCatalogStore } from '../../../worker/index'
import type { Environment } from '../../../worker/index'

export const HARNESS_IDENTITY = { harness: 'orbit-worker-contract', storeName: 'catalog-v1', entry: 'tests/cloudflare/runtime/entry.ts' } as const
/**
 * Measurement seam (ACR82-3/WIM82-4): one random nonce per isolate instance,
 * served by `/__test/identity` and readable through CDP `Runtime.evaluate` as
 * `globalThis.__orbitIsolateNonce`, so an inspector session can be positively
 * bound to the same isolate that answers the owned HTTP origin.
 */
let isolateNonce: string | undefined
function getIsolateNonce(): string {
  if (isolateNonce === undefined) {
    isolateNonce = crypto.randomUUID()
    ;(globalThis as { __orbitIsolateNonce?: string }).__orbitIsolateNonce = isolateNonce
  }
  return isolateNonce
}
const MAX_SKEW_MS = 400 * 86_400_000
const realNow = Date.now.bind(Date)
type Clock = { mode: 'real' } | { mode: 'offset'; offsetMs: number } | { mode: 'frozen'; at: number }
let clock: Clock = { mode: 'real' }
Date.now = () => clock.mode === 'frozen' ? clock.at : clock.mode === 'offset' ? realNow() + clock.offsetMs : realNow()

const describeClock = () => ({ ...clock, now: new Date(Date.now()).toISOString(), virtualAlarms: clock.mode !== 'real' })
/** `?at=<ISO>` freezes the clock, `?offsetMs=<n>` shifts real time, `?mode=real` restores it. */
function applyClock(url: URL): void {
  const at = url.searchParams.get('at')
  const offset = url.searchParams.get('offsetMs')
  if (url.searchParams.get('mode') === 'real') { clock = { mode: 'real' }; return }
  if (at !== null) {
    const value = Date.parse(at)
    if (!Number.isFinite(value) || Math.abs(value - realNow()) > MAX_SKEW_MS) throw new Error('Test clock time out of range')
    clock = { mode: 'frozen', at: value }
    return
  }
  if (offset !== null) {
    const value = Number(offset)
    if (!Number.isFinite(value) || Math.abs(value) > MAX_SKEW_MS) throw new Error('Test clock offset out of range')
    clock = { mode: 'offset', offsetMs: value }
  }
}
const clockQuery = () => clock.mode === 'frozen' ? `at=${encodeURIComponent(new Date(clock.at).toISOString())}`
  : clock.mode === 'offset' ? `offsetMs=${clock.offsetMs}` : 'mode=real'

// ---------------------------------------------------------------------------
// Instrumented storage: alarm recording, virtual alarms and one-shot faults.
// ---------------------------------------------------------------------------
export type FaultTarget = 'sql.exec' | 'transactionSync' | 'setAlarm' | 'deleteAlarm' | 'deleteAll' | 'waitUntil'
/**
 * A one-shot fault. `trace` (AWL82-2) names a query substring whose real
 * executions are counted in `traced` while the fault is still armed, so a test
 * can prove that a statement (for example the chunk INSERT) really ran before
 * the faulted statement failed inside the same transaction.
 */
export interface Fault { id: number; target: FaultTarget; match: string | null; remaining: number; hits: number; message: string | null; delayMs: number; trace: string | null; traced: number }
export interface AlarmRecord { op: 'setAlarm' | 'deleteAlarm'; at: number | null; iso: string | null; virtual: boolean; clockNow: string; realAt: string; source: 'request' | 'dispatch' | 'native' }
const HARNESS_QUERY = '/*harness*/'
const faults: Fault[] = []
let nextFaultId = 1
let alarmRecords: AlarmRecord[] = []
interface AlarmActivity { inFlight: number; dispatching: number; nativeInFlight: number }
let preparedNonce: string | null = null

function takeFault(target: FaultTarget, text?: string): Fault | null {
  if (text?.startsWith(HARNESS_QUERY)) return null
  const fault = faults.find(item => item.target === target && item.remaining > 0 && (item.match === null || (text ?? '').includes(item.match)))
  if (!fault) return null
  fault.remaining--
  fault.hits++
  return fault
}
function throwSyncFault(target: FaultTarget, text?: string): void {
  const fault = takeFault(target, text)
  if (fault?.message) throw new Error(fault.message)
}
/** Count real statements matching an armed fault's `trace` substring (harness queries excluded); the statement itself is not altered. */
function traceQuery(text: string): void {
  if (text.startsWith(HARNESS_QUERY)) return
  for (const fault of faults) if (fault.trace !== null && fault.remaining > 0 && text.includes(fault.trace)) fault.traced++
}
async function applyAsyncFault(target: FaultTarget): Promise<void> {
  const fault = takeFault(target)
  if (!fault) return
  if (fault.delayMs > 0) await scheduler.wait(fault.delayMs)
  if (fault.message) throw new Error(fault.message)
}
const alarmSource = (activity: AlarmActivity): AlarmRecord['source'] => activity.dispatching > 0 ? 'dispatch' : activity.nativeInFlight > 0 ? 'native' : 'request'
function recordAlarm(activity: AlarmActivity, op: AlarmRecord['op'], at: number | null, virtual: boolean): void {
  alarmRecords.push({ op, at, iso: at === null ? null : new Date(at).toISOString(), virtual, clockNow: new Date(Date.now()).toISOString(), realAt: new Date(realNow()).toISOString(), source: alarmSource(activity) })
}
const bound = <T extends object>(target: T, property: string | symbol) => {
  const value = Reflect.get(target, property, target) as unknown
  return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value
}
const nativeStorageByState = new WeakMap<DurableObjectState, DurableObjectStorage>()
const nativeWaitUntilByState = new WeakMap<DurableObjectState, DurableObjectState['waitUntil']>()
/** Keep the native state identity while intercepting storage on that instance. */
function instrumentedState(ctx: DurableObjectState, activity: AlarmActivity): DurableObjectState {
  const storage = nativeStorageByState.get(ctx) ?? ctx.storage
  nativeStorageByState.set(ctx, storage)
  const sql = storage.sql
  const sqlFacade = new Proxy(sql, {
    get(target, property) {
      if (property === 'exec') {
        return (query: string, ...bindings: unknown[]) => {
          traceQuery(query)
          throwSyncFault('sql.exec', query)
          return target.exec(query, ...bindings)
        }
      }
      return bound(target, property)
    },
  })
  const storageFacade = new Proxy(storage, {
    get(target, property) {
      if (property === 'sql') return sqlFacade
      if (property === 'setAlarm') {
        return async (at: number | Date, options?: DurableObjectSetAlarmOptions) => {
          const ms = typeof at === 'number' ? at : at.getTime()
          const virtual = clock.mode !== 'real'
          recordAlarm(activity, 'setAlarm', ms, virtual)
          await applyAsyncFault('setAlarm')
          if (!virtual) await target.setAlarm(at, options)
        }
      }
      if (property === 'deleteAlarm') {
        return async (options?: DurableObjectSetAlarmOptions) => {
          recordAlarm(activity, 'deleteAlarm', null, clock.mode !== 'real')
          await applyAsyncFault('deleteAlarm')
          await target.deleteAlarm(options)
        }
      }
      if (property === 'deleteAll') {
        return async (options?: DurableObjectPutOptions) => {
          await applyAsyncFault('deleteAll')
          await target.deleteAll(options)
        }
      }
      if (property === 'transactionSync') {
        return <T>(closure: () => T): T => {
          throwSyncFault('transactionSync')
          return target.transactionSync(closure)
        }
      }
      return bound(target, property)
    },
  })
  // One synchronous registration seam: while a 'waitUntil' fault is armed, the product's own
  // ctx.waitUntil call throws before anything is registered; every other call reaches the native
  // method with its native receiver. The harness itself never calls waitUntil.
  const waitUntil = nativeWaitUntilByState.get(ctx) ?? ctx.waitUntil.bind(ctx)
  nativeWaitUntilByState.set(ctx, waitUntil)
  Object.defineProperty(ctx, 'waitUntil', {
    value: (promise: Promise<unknown>) => { throwSyncFault('waitUntil'); waitUntil(promise) },
    configurable: true,
  })
  Object.defineProperty(ctx, 'storage', { value: storageFacade, configurable: true })
  return ctx
}

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/
const ZERO_HASH = '0'.repeat(64)
const MAX_BALLAST_PER_CALL = 256 * 1024 * 1024
const json = (value: unknown, status = 200) => Response.json(value, { status })
async function body(request: Request): Promise<Record<string, unknown>> {
  const text = await request.text()
  if (!text) return {}
  const value = JSON.parse(text) as unknown
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Test route body must be a JSON object')
  return value as Record<string, unknown>
}
const integer = (value: unknown, name: string, min: number, max: number): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${name} must be an integer in [${min}, ${max}]`)
  return value
}

/** Same class name as the product binding; only `/__test/*` requests are intercepted. */
export class CatalogStore extends ProductCatalogStore {
  readonly harnessInstance = crypto.randomUUID()
  readonly constructedAt = new Date(realNow()).toISOString()
  private readonly alarmActivity: AlarmActivity

  constructor(ctx: DurableObjectState, env: Environment) {
    // The storage facade and handler own this instance's activity, including after abort.
    const activity: AlarmActivity = { inFlight: 0, dispatching: 0, nativeInFlight: 0 }
    super(instrumentedState(ctx, activity), env)
    this.alarmActivity = activity
    this.ctx.storage.sql.exec(`${HARNESS_QUERY} CREATE TABLE IF NOT EXISTS orbit_test_alarm_log (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL, real_at TEXT NOT NULL, clock_at TEXT NOT NULL, harness_instance TEXT NOT NULL)`)
  }

  /** Native callbacks and explicit dispatches both run the inherited product body; the source is recorded durably. */
  override async alarm(): Promise<void> {
    const activity = this.alarmActivity
    const source = activity.dispatching > 0 ? 'dispatch' : 'native'
    if (source === 'native') activity.nativeInFlight++
    activity.inFlight++
    try {
      this.ctx.storage.sql.exec(`${HARNESS_QUERY} INSERT INTO orbit_test_alarm_log (source, real_at, clock_at, harness_instance) VALUES (?, ?, ?, ?)`,
        source, new Date(realNow()).toISOString(), new Date(Date.now()).toISOString(), this.harnessInstance)
      await super.alarm()
    } finally {
      activity.inFlight--
      if (source === 'native') activity.nativeInFlight--
    }
  }

  private harnessRows<T extends Record<string, SqlStorageValue>>(query: string, ...bindings: SqlStorageValue[]): { rows: T[]; rowsWritten: number } {
    const cursor = this.ctx.storage.sql.exec<T>(`${HARNESS_QUERY} ${query}`, ...bindings)
    const rows = cursor.toArray()
    return { rows, rowsWritten: cursor.rowsWritten }
  }

  private async state() {
    return {
      harnessInstance: this.harnessInstance, constructedAt: this.constructedAt, clock: describeClock(),
      nativeAlarm: await this.ctx.storage.getAlarm(), alarmInFlight: this.alarmActivity.inFlight > 0, dispatching: this.alarmActivity.dispatching > 0, preparedNonce,
      records: alarmRecords, faults,
      callbacks: this.harnessRows<{ seq: number; source: string; real_at: string; clock_at: string; harness_instance: string }>(
        'SELECT seq, source, real_at, clock_at, harness_instance FROM orbit_test_alarm_log ORDER BY seq').rows,
    }
  }

  private async testRoute(request: Request, route: string): Promise<Response> {
    if (route === 'state' && request.method === 'GET') return json(await this.state())
    if (route === 'reset/prepare' && request.method === 'POST') {
      const { nonce } = await body(request)
      if (typeof nonce !== 'string' || !UUID.test(nonce)) throw new Error('reset/prepare needs a UUID nonce')
      const before = { harnessInstance: this.harnessInstance, nativeAlarm: await this.ctx.storage.getAlarm(), alarmInFlight: this.alarmActivity.inFlight > 0, records: alarmRecords.length }
      faults.length = 0
      await this.ctx.storage.deleteAll()
      await this.ctx.storage.deleteAlarm()
      alarmRecords = []
      preparedNonce = nonce
      return json({ prepared: true, nonce, harnessInstance: this.harnessInstance, before, nativeAlarmAfterPrepare: await this.ctx.storage.getAlarm() })
    }
    if (route === 'reset/abort' && request.method === 'POST') {
      const { nonce } = await body(request)
      if (typeof nonce !== 'string' || nonce !== preparedNonce) return json({ aborted: false, reason: 'nonce does not match the prepared reset' }, 409)
      preparedNonce = null
      this.ctx.abort(`orbit-worker-contract reset ${nonce}`, { retryAlarm: false })
      return json({ aborted: false, reason: 'abort returned control to the handler' }, 500)
    }
    if (route === 'alarm/dispatch' && request.method === 'POST') {
      const start = alarmRecords.length
      this.alarmActivity.dispatching++
      try {
        await this.alarm()
        return json({ dispatched: true, error: null, recorded: alarmRecords.slice(start), clock: describeClock() })
      } catch (error) {
        return json({ dispatched: true, error: String(error), recorded: alarmRecords.slice(start), clock: describeClock() }, 500)
      } finally {
        this.alarmActivity.dispatching--
      }
    }
    if (route === 'alarm/age' && request.method === 'POST') {
      const input = await body(request)
      const result: Record<string, number> = {}
      if (input.stagingCreatedMs !== undefined) {
        result.stagingCreated = this.harnessRows('UPDATE orbit_staging SET created_at = created_at - ? WHERE singleton = 1', integer(input.stagingCreatedMs, 'stagingCreatedMs', 0, MAX_SKEW_MS)).rowsWritten
      }
      if (input.stagingTouchedMs !== undefined) {
        result.stagingTouched = this.harnessRows('UPDATE orbit_staging SET touched_at = touched_at - ? WHERE singleton = 1', integer(input.stagingTouchedMs, 'stagingTouchedMs', 0, MAX_SKEW_MS)).rowsWritten
      }
      if (input.retiredMs !== undefined) {
        result.retired = this.harnessRows('UPDATE orbit_generations SET retired_at = retired_at - ? WHERE retired_at IS NOT NULL', integer(input.retiredMs, 'retiredMs', 0, MAX_SKEW_MS)).rowsWritten
      }
      return json({ aged: result })
    }
    if (route === 'fault' && request.method === 'POST') {
      const input = await body(request)
      const target = input.target
      if (target !== 'sql.exec' && target !== 'transactionSync' && target !== 'setAlarm' && target !== 'deleteAlarm' && target !== 'deleteAll' && target !== 'waitUntil') throw new Error('Unknown fault target')
      const fault: Fault = {
        id: nextFaultId++, target, match: typeof input.match === 'string' ? input.match : null,
        remaining: integer(input.times ?? 1, 'times', 1, 1000), hits: 0,
        message: input.message === null ? null : typeof input.message === 'string' ? input.message : 'synthetic storage fault',
        delayMs: integer(input.delayMs ?? 0, 'delayMs', 0, 60_000),
        trace: typeof input.trace === 'string' && input.trace ? input.trace : null, traced: 0,
      }
      faults.push(fault)
      return json({ fault, faults })
    }
    if (route === 'fault' && request.method === 'DELETE') {
      const cleared = faults.splice(0, faults.length)
      return json({ cleared })
    }
    if (route === 'sql/ballast' && request.method === 'POST') {
      const input = await body(request)
      const rows = integer(input.rows, 'rows', 1, 4096)
      const bytesPerRow = integer(input.bytesPerRow, 'bytesPerRow', 1, 64 * 1024 * 1024)
      if (rows * bytesPerRow > MAX_BALLAST_PER_CALL) throw new Error('At most 256 MiB of ballast per call')
      this.harnessRows('CREATE TABLE IF NOT EXISTS orbit_test_ballast (id INTEGER PRIMARY KEY AUTOINCREMENT, body BLOB NOT NULL)')
      for (let index = 0; index < rows; index++) this.harnessRows('INSERT INTO orbit_test_ballast (body) VALUES (zeroblob(?))', bytesPerRow)
      const total = this.harnessRows<{ n: number; bytes: number }>('SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(body)), 0) AS bytes FROM orbit_test_ballast').rows[0]
      return json({ inserted: rows, bytesPerRow, totalRows: total.n, totalBallastBytes: total.bytes, databaseSize: this.ctx.storage.sql.databaseSize })
    }
    if (route === 'sql/ballast' && request.method === 'DELETE') {
      this.harnessRows('DROP TABLE IF EXISTS orbit_test_ballast')
      return json({ dropped: true, databaseSize: this.ctx.storage.sql.databaseSize })
    }
    if (route === 'sql/phantom-payload' && request.method === 'POST') {
      const input = await body(request)
      const owner = input.owner
      if (typeof owner !== 'string' || !UUID.test(owner)) throw new Error('phantom-payload needs a lowercase UUID owner')
      const size = integer(input.size, 'size', 0, 2 ** 40)
      const manifest = JSON.stringify({ harnessPhantom: true, chunks: [{ owner, index: 0 }] })
      this.harnessRows('INSERT OR REPLACE INTO orbit_generations VALUES (?, 0, ?, NULL, ?, ?)', owner, '1970-01-01T00:00:00.000Z', manifest, ZERO_HASH)
      this.harnessRows('INSERT OR REPLACE INTO orbit_chunks VALUES (?, 0, ?, ?, ?)', owner, ZERO_HASH, size, new Uint8Array(1).buffer)
      const payload = this.harnessRows<{ bytes: number }>('SELECT COALESCE(SUM(size), 0) AS bytes FROM orbit_chunks').rows[0]
      return json({ owner, size, payloadBytes: payload.bytes, databaseSize: this.ctx.storage.sql.databaseSize })
    }
    if (route === 'sql/phantom-payload' && request.method === 'DELETE') {
      const input = await body(request)
      const owner = input.owner
      if (typeof owner !== 'string' || !UUID.test(owner)) throw new Error('phantom-payload needs a lowercase UUID owner')
      const chunks = this.harnessRows('DELETE FROM orbit_chunks WHERE owner = ? AND hash = ? RETURNING owner, idx', owner, ZERO_HASH)
      const generations = this.harnessRows('DELETE FROM orbit_generations WHERE id = ? AND hash = ? RETURNING id', owner, ZERO_HASH)
      const payload = this.harnessRows<{ bytes: number }>('SELECT COALESCE(SUM(size), 0) AS bytes FROM orbit_chunks').rows[0]
      return json({
        removed: { chunks: chunks.rows.length, generations: generations.rows.length },
        nativeRowsWritten: { chunks: chunks.rowsWritten, generations: generations.rowsWritten },
        payloadBytes: payload.bytes,
      })
    }
    return json({ error: 'unknown store test route', route, method: request.method }, 404)
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname === '/__test/clock') {
      applyClock(url)
      return json(describeClock())
    }
    if (url.pathname.startsWith('/__test/store/')) {
      try {
        return await this.testRoute(request, url.pathname.slice('/__test/store/'.length))
      } catch (error) {
        return json({ error: String(error), route: url.pathname }, 500)
      }
    }
    return super.fetch(request)
  }
}

const EMPTY_STORE = { generations: 0, chunks: 0, payloadBytes: 0, staging: null, activeBodies: 0, peakBodies: 0, activeGenerations: 0 } as const
interface StoreState { harnessInstance: string; nativeAlarm: number | null; alarmInFlight: boolean; records: unknown[]; callbacks: unknown[] }

export default {
  async fetch(request: Request, env: Environment): Promise<Response> {
    const url = new URL(request.url)
    if (!url.pathname.startsWith('/__test/')) return product.fetch(request, env)
    let store = env.CATALOG_STORE.get(env.CATALOG_STORE.idFromName(HARNESS_IDENTITY.storeName))
    const storeFetch = (path: string, init?: RequestInit) => store.fetch(new Request(`https://store.local${path}`, init))
    const storeJson = async (path: string, init?: RequestInit) => {
      const reply = await storeFetch(path, init)
      return { status: reply.status, body: await reply.json() as Record<string, unknown> }
    }
    const postJson = (path: string, value: unknown) => storeJson(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) })
    if (url.pathname === '/__test/identity') return json({ ...HARNESS_IDENTITY, isolateNonce: getIsolateNonce(), clock: describeClock() })
    if (url.pathname === '/__test/clock') {
      applyClock(url)
      // Keep the object's module clock aligned even if it runs in another isolate.
      const inner = await storeFetch(`/__test/clock?${clockQuery()}`)
      if (!inner.ok) return json({ error: 'The store rejected the test clock', status: inner.status }, 500)
      return json(describeClock())
    }
    if (url.pathname.startsWith('/__test/store/')) {
      // Direct access to the store's test routes; a rejected stub call (for example the deliberate abort) is reported, never hidden.
      try {
        const reply = await storeFetch(url.pathname + url.search, { method: request.method, headers: request.headers, body: request.method === 'GET' || request.method === 'HEAD' ? undefined : await request.arrayBuffer() })
        return new Response(reply.body, { status: reply.status, headers: { 'Content-Type': 'application/json' } })
      } catch (error) {
        return json({ error: String(error), route: url.pathname, stubRejected: true }, 500)
      }
    }
    if (url.pathname === '/__test/wipe') {
      const nonce = crypto.randomUUID()
      const problems: string[] = []
      const authorization = { Authorization: `Bearer ${env.PUBLISH_TOKEN}` }
      let before: StoreState | null = null
      let productInstanceBefore: unknown = null
      try {
        const state = await storeJson('/__test/store/state')
        if (state.status === 200) before = state.body as unknown as StoreState
        else problems.push(`state before reset returned ${state.status}: ${JSON.stringify(state.body)}`)
        const metricsBefore = await storeJson('/__orbit/publish/metrics', { headers: authorization })
          .catch((error): { status: number; body: Record<string, unknown> } => ({ status: 0, body: { error: String(error) } }))
        productInstanceBefore = metricsBefore.status === 200 ? metricsBefore.body.instance ?? null : null
      } catch (error) {
        problems.push(`state before reset failed: ${String(error)}`)
      }
      if (problems.length) return json({ wiped: false, nonce, stage: 'before', problems }, 500)
      let prepared: Record<string, unknown>
      try {
        const reply = await postJson('/__test/store/reset/prepare', { nonce })
        if (reply.status !== 200 || reply.body.prepared !== true) return json({ wiped: false, nonce, stage: 'prepare', problems: [`prepare returned ${reply.status}: ${JSON.stringify(reply.body)}`] }, 500)
        prepared = reply.body
      } catch (error) {
        return json({ wiped: false, nonce, stage: 'prepare', problems: [`prepare failed: ${String(error)}`] }, 500)
      }
      // Only this call may reject: the deliberate abort tears the object down with retryAlarm:false.
      let abortObserved = false
      let abortError: string | null = null
      let abortReply: unknown = null
      try {
        const reply = await postJson('/__test/store/reset/abort', { nonce })
        abortReply = reply
      } catch (error) {
        abortObserved = true
        abortError = String(error)
      }
      clock = { mode: 'real' }
      try {
        // An aborted stub stays broken; verification needs a fresh stub for the same object.
        store = env.CATALOG_STORE.get(env.CATALOG_STORE.idFromName(HARNESS_IDENTITY.storeName))
        const clockReply = await storeFetch('/__test/clock?mode=real')
        if (!clockReply.ok) problems.push(`clock reset returned ${clockReply.status}`)
        const after = await storeJson('/__test/store/state')
        if (after.status !== 200) problems.push(`state after reset returned ${after.status}: ${JSON.stringify(after.body)}`)
        const afterState = after.body as unknown as StoreState
        if (!abortObserved) problems.push(`abort did not reject the stub call: ${JSON.stringify(abortReply)}`)
        if (!before || typeof afterState.harnessInstance !== 'string' || afterState.harnessInstance === before.harnessInstance || afterState.harnessInstance === prepared.harnessInstance) {
          problems.push(`no fresh instance after reset: before=${before?.harnessInstance ?? 'unknown'} prepared=${String(prepared.harnessInstance)} after=${afterState.harnessInstance}`)
        }
        if (afterState.nativeAlarm !== null) problems.push(`a native alarm survived the reset: ${String(afterState.nativeAlarm)}`)
        if (afterState.alarmInFlight) problems.push('an alarm handler is in flight after the reset')
        if (afterState.records.length) problems.push(`alarm records survived the reset: ${afterState.records.length}`)
        if (afterState.callbacks.length) problems.push(`alarm callbacks exist on the fresh instance: ${afterState.callbacks.length}`)
        const metrics = await storeJson('/__orbit/publish/metrics', { headers: authorization })
        if (metrics.status !== 200) problems.push(`metrics returned ${metrics.status}`)
        for (const [name, expected] of Object.entries(EMPTY_STORE)) {
          if (metrics.status === 200 && metrics.body[name] !== expected) problems.push(`${name}=${JSON.stringify(metrics.body[name])}`)
        }
        if (metrics.status === 200 && productInstanceBefore !== null && metrics.body.instance === productInstanceBefore) problems.push('the product instance id did not change')
        const head = await storeJson('/__orbit/publish/head', { headers: authorization })
        if (head.status !== 200) problems.push(`head returned ${head.status}`)
        else if (head.body.head !== null || head.body.manifest !== null) problems.push('head is not empty')
        if (problems.length) return json({ wiped: false, nonce, stage: 'verify', abortObserved, abortError, problems }, 500)
        return json({
          wiped: true, nonce, abortObserved, abortError,
          before: { harnessInstance: before!.harnessInstance, productInstance: productInstanceBefore, nativeAlarm: before!.nativeAlarm, alarmInFlight: before!.alarmInFlight },
          prepared: { harnessInstance: prepared.harnessInstance, nativeAlarmAfterPrepare: prepared.nativeAlarmAfterPrepare },
          after: { harnessInstance: afterState.harnessInstance, productInstance: metrics.body.instance ?? null, nativeAlarm: afterState.nativeAlarm, alarmInFlight: afterState.alarmInFlight },
          verified: { ...EMPTY_STORE, head: null },
        })
      } catch (error) {
        return json({ wiped: false, nonce, stage: 'verify', abortObserved, abortError, problems: [...problems, String(error)] }, 500)
      }
    }
    return json({ error: 'unknown test route' }, 404)
  },
} satisfies ExportedHandler<Environment>
