import { expect, test } from '@playwright/test'
import type { IncomingHttpHeaders } from 'node:http'
import { brotliDecompressSync, gunzipSync } from 'node:zlib'
import { buildPublication } from '../../server/publication-build'
import type { CatalogPublicationCapture } from '../../server/catalog-service'
import type { PublicationHead } from '../../shared/publication'
import type { Job } from '../../shared/types'
import { PROVENANCE_ALDER, PROVENANCE_BIRCH, PROVENANCE_COMPANIES, provenanceJob } from '../fixtures/board-status-provenance'
import {
  checkpointFrom, declareFragment, decodedFragment, deterministicText, EMPTY_SHA256, FICTIONAL_COMMIT, GENERATION_ONE, GENERATION_THREE,
  GENERATION_TWO, multibyteCompanies, multibyteFragment, MULTIBYTE_FRAGMENT_BYTES, MULTIBYTE_UNIT_COUNT, publicationHarness, repackPublication,
  sha256, stamp82,
} from '../fixtures/publication'
import type { PublicationGeneration } from '../fixtures/publication'
import {
  ageTimestamps, authorized, clearFaults, contractClient, decodedBody, dispatchAlarm, freezeClock, injectFault, jsonBody, rawRequest,
  storeState, StreamRegistry, wipeStore,
} from './helpers/worker-http'
import type { AlarmRecord, RawResponse, SlowStream } from './helpers/worker-http'

/**
 * Stage82 Durable Object lifecycle on the real local workerd/SQLite runtime
 * (AWH82-1/2, MWT82-6/7, MCAP82-6 alarm and storage-error obligations; AWL82-1/2/3):
 *
 * - The product's alarm requests are recorded by the instrumented storage of
 *   the test-only entry. With a frozen clock they stay virtual, so the inherited
 *   `alarm()` body is dispatched explicitly at exact millisecond boundaries:
 *   staging idle (15 min), staging lifetime (2 h), retirement (5 min) and the
 *   60 s retry floor while a reader pins a retired generation. The retirement
 *   deadline is first observed with no reader at all, then with a real, actively
 *   leased reader of the fictional bulk body (AWL82-3).
 * - A separate real-clock case witnesses an actual native alarm callback; its
 *   timing margins are finite observed intervals, not guarantees.
 * - The verified two-phase reset is exercised with a pending native alarm and an
 *   in-flight handler; a six-second follow-up is a bounded no-retry observation.
 * - Injected one-shot failures in named storage calls surface as the product's
 *   own 503 storage errors. Pre-write refusals are labelled as such; one witness
 *   fails the stage UPDATE after the real chunk INSERT inside the same SQLite
 *   transaction and proves the rollback (AWL82-2). No physical disk fault is
 *   claimed.
 * - Public catalog bodies are checked against expectations written from the
 *   fictional fixture input and the frozen request clock, never against the
 *   product's projection code; a held response is rendered at its request-start
 *   clock even when the logical clock advances before it is read (AWL82-1).
 * - Stream-remedy regressions (NATIVE82-STREAM-REMEDY-01, SR01-11 (a)-(f)): late
 *   decoded-digest failures of a checkpoint file and of the public catalog,
 *   zero-byte and one-byte checkpoint files, a 199 500-byte multibyte file and an
 *   80-employer multibyte metadata text, chunk-read failures under gzip/br, a
 *   synchronous ctx.waitUntil registration failure, and a destroyed reader of a
 *   pinned retired generation. Expected bytes and values come from the fixtures
 *   and literals; a transfer that completes and decodes cleanly to a truncated
 *   body is a failure even when its JSON is invalid.
 */
const T = stamp82
const MINUTE = 60_000
const IDLE_MS = 15 * MINUTE
const LIFETIME_MS = 120 * MINUTE
const RETIRED_MS = 5 * MINUTE
const RETRY_FLOOR_MS = 60_000
/** Design rule: a greenhouse/smartrecruiters read is fresh for 30 minutes, then stale until the 24 h fallback horizon (every lifecycle clock stays inside that horizon). */
const FRESH_FOR_MS = 30 * MINUTE
const T0 = Date.parse(T('06:35:00.000'))
const CAPTURE_ONE = T('06:00:00.000')
const CAPTURE_TWO = T('06:30:00.000')
const CAPTURE_THREE = T('07:00:00.000')
const iso = (ms: number) => new Date(ms).toISOString()
const STORAGE_ERROR_TEXT = '저장된 공고 자료를 읽지 못했어요. 잠시 후 다시 확인해 주세요.'
const CONFLICT = { error: '발행 기준 버전이 변경됐습니다.', code: 'PUBLISH_CONFLICT' }
const GONE = { error: '공고 자료가 갱신됐어요. 공고를 새로고침한 뒤 다시 확인해 주세요.', code: 'CATALOG_GENERATION_GONE' }
const BULK_COUNT = 72
const BULK_DESCRIPTION_CHARS = 28_000

interface Captures { first: CatalogPublicationCapture; second: CatalogPublicationCapture; third: CatalogPublicationCapture; bulk: CatalogPublicationCapture; multibyte: CatalogPublicationCapture }
let captures: Captures
test.beforeAll(async () => {
  const h = publicationHarness()
  const first = (await h.run()).capture
  h.at(CAPTURE_TWO)
  const second = (await h.run(checkpointFrom(first))).capture
  h.at(CAPTURE_THREE)
  const third = (await h.run(checkpointFrom(second))).capture
  // 72 incompressible Alder postings: at least two 1 MiB chunks, so a paused reader keeps a real body lease open.
  const bulkHarness = publicationHarness()
  bulkHarness.bulkBody(PROVENANCE_ALDER.id, BULK_COUNT, BULK_DESCRIPTION_CHARS)
  const bulk = (await bulkHarness.run()).capture
  // 80 fictional employers with multibyte names: the public metadata text alone exceeds one 64 KiB encoder block.
  const multibyteHarness = publicationHarness({ companies: multibyteCompanies() })
  const multibyte = (await multibyteHarness.run()).capture
  captures = { first, second, third, bulk, multibyte }
})

const build = (capture: CatalogPublicationCapture, generation: PublicationGeneration, head: PublicationHead | null = null) =>
  buildPublication(capture, FICTIONAL_COMMIT, head, generation)
const beginRaw = (origin: string, text: string) => rawRequest(origin, '/__orbit/publish/begin', {
  method: 'POST', headers: authorized({ 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) }), body: text,
})
const putChunkRaw = (origin: string, generation: string, index: number, bytes: Uint8Array) => rawRequest(origin, `/__orbit/publish/chunks/${generation}/${index}`, {
  method: 'PUT', headers: authorized({ 'Content-Type': 'application/octet-stream', 'Content-Length': bytes.byteLength }), body: Buffer.from(bytes),
})
const commitRaw = (origin: string, body: unknown) => rawRequest(origin, '/__orbit/publish/commit', {
  method: 'POST', headers: authorized({ 'Content-Type': 'application/json' }), body: JSON.stringify(body),
})
const metricsOf = (origin: string) => contractClient(origin).metrics()
const alarmCalls = (records: AlarmRecord[]) => records.map(record => [record.op, record.at, record.virtual, record.source] as const)
async function publish(origin: string, capture: CatalogPublicationCapture, generation: PublicationGeneration, head: PublicationHead | null = null) {
  const built = build(capture, generation, head)
  const published = await contractClient(origin).publish(built)
  return { built, head: published }
}
function expectBegun(response: RawResponse, generation: string) {
  expect(response.status).toBe(200)
  expect(jsonBody(response)).toEqual({ committed: false, generation })
}
function expectStorageError(response: RawResponse, code: 'PUBLISH_STORAGE_ERROR' | 'CATALOG_STORAGE_ERROR') {
  expect(response.status).toBe(503)
  expect(response.headers['cache-control']).toBe('no-store')
  expect(jsonBody(response)).toEqual({ error: STORAGE_ERROR_TEXT, code })
}

// ---------------------------------------------------------------------------
// Independent public-catalog expectations (AWL82-1): fixture input + request clock.
// ---------------------------------------------------------------------------
const JOB_FIELDS = ['id', 'companyId', 'source', 'title', 'description', 'url', 'cityIds', 'locationLabel', 'workMode', 'skills', 'salary', 'minExperience', 'requirements', 'visa', 'employment'] as const
const pick = (job: Job) => Object.fromEntries(JOB_FIELDS.map(field => [field, job[field]]))
/** The exact postings the collector was handed: one per employer, or the bulk Alder set. */
function defaultJobs(capturedAt: string): Job[] {
  return [provenanceJob(PROVENANCE_ALDER, '7401', capturedAt), provenanceJob(PROVENANCE_BIRCH, '7401', capturedAt)]
}
function bulkJobs(capturedAt: string): Job[] {
  return [
    ...Array.from({ length: BULK_COUNT }, (_, index) => ({ ...provenanceJob(PROVENANCE_ALDER, `${7500 + index}`, capturedAt), description: deterministicText(index + 1, BULK_DESCRIPTION_CHARS) })),
    provenanceJob(PROVENANCE_BIRCH, '7401', capturedAt),
  ]
}
interface CatalogExpectation { capturedAt: string; head: PublicationHead; requestClock: number; jobs: Job[] }
/**
 * Every clock-dependent field follows the request-start clock: data captured at
 * `capturedAt` is fresh while requestClock − capturedAt < 30 min and stale after.
 * Boards, metadata and postings are written from the fixture, not from product
 * code; `cities` is the product's city list and is only checked for shape.
 */
function expectIndependentCatalog(body: Buffer, expectation: CatalogExpectation, label: string) {
  const { capturedAt, head, requestClock, jobs } = expectation
  const stale = requestClock - Date.parse(capturedAt) >= FRESH_FOR_MS
  const dataStatus = stale ? 'stale' : 'fresh'
  const catalog = JSON.parse(body.toString('utf8')) as Record<string, any>
  expect(catalog.source, label).toBe('public')
  expect(catalog.fetchedAt, `${label}: fetchedAt`).toBe(capturedAt)
  expect(catalog.checkedAt, `${label}: checkedAt`).toBe(capturedAt)
  expect(catalog.stale, `${label}: stale at ${iso(requestClock)}`).toBe(stale)
  expect(catalog.unmappedCount, label).toBe(0)
  expect(Number.isFinite(Date.parse(catalog.refreshAfter)), `${label}: refreshAfter`).toBe(true)
  expect(Array.isArray(catalog.cities) && catalog.cities.length > 0, `${label}: cities`).toBe(true)
  expect(catalog.companies, `${label}: companies`).toEqual(PROVENANCE_COMPANIES)
  expect(catalog.publication, `${label}: publication`).toEqual({ mode: 'scheduled', generation: head.generation, publishedAt: head.publishedAt, intervalMinutes: 30 })
  const perCompany = (companyId: string) => jobs.filter(job => job.companyId === companyId).length
  expect(catalog.boards, `${label}: boards`).toEqual([PROVENANCE_ALDER, PROVENANCE_BIRCH].map(company => ({
    companyId: company.id, board: company.board, provider: company.provider, status: 'ok', dataStatus,
    total: perCompany(company.id), included: perCompany(company.id), checkedAt: capturedAt, lastSuccessAt: capturedAt, retryAt: null,
  })))
  const served = catalog.jobs as Job[]
  expect(served.map(job => job.id).sort(), `${label}: posting ids`).toEqual(jobs.map(job => job.id).sort())
  for (const expected of jobs) {
    const actual = served.find(job => job.id === expected.id)!
    expect(pick(actual), `${label}: ${expected.id}`).toEqual(pick(expected))
    expect(actual.fetchedAt, `${label}: ${expected.id} fetchedAt`).toBe(capturedAt)
    expect(actual.stale, `${label}: ${expected.id} stale`).toBe(stale)
  }
  return catalog
}
/** Primary failure plus independently attempted cleanup, both preserved. */
async function finish(primary: unknown, failed: boolean, cleanup: { label: string; run: () => Promise<unknown> }[]) {
  const problems: string[] = []
  for (const step of cleanup) {
    try { await step.run() } catch (error) { problems.push(`${step.label}: ${String(error)}`) }
  }
  if (failed && problems.length) throw new AggregateError([primary, ...problems.map(message => new Error(message))], 'The case failed and its cleanup also failed')
  if (failed) throw primary
  expect(problems).toEqual([])
}

// ---------------------------------------------------------------------------
// Stream-remedy regressions (NATIVE82-STREAM-REMEDY-01, SR01-11): transfer outcomes.
// ---------------------------------------------------------------------------
type TransferOutcome =
  | { completed: true; status: number | undefined; headers: IncomingHttpHeaders; body: Buffer }
  | { completed: false; status: number | undefined; error: string; terminal: 'transport' | 'harness' }
/**
 * The slow-stream helper's own terminals (helpers/worker-http.ts): its 60 s request timeout and a test-side
 * destroy. They prove nothing about the Worker. Every other rejection is a transport or body-read rejection
 * outside the helper's control; the client cannot tell more about its origin, nor whether the response headers
 * had already reached it when the connection failed.
 */
const HARNESS_TERMINALS = ['Slow stream timed out: ', 'Stream destroyed by the test: '] as const
const classifyTerminal = (error: unknown): 'transport' | 'harness' =>
  error instanceof Error && HARNESS_TERMINALS.some(prefix => error.message.startsWith(prefix)) ? 'harness' : 'transport'
/** Drive a slow stream to its terminal state; a rejection is an outcome to classify and assert on, not a thrown test error. */
const transferOutcome = (stream: SlowStream): Promise<TransferOutcome> => stream.ready.then(() => stream.finish()).then(
  body => ({ completed: true as const, status: stream.status, headers: stream.headers, body }),
  error => ({ completed: false as const, status: stream.status, error: String(error), terminal: classifyTerminal(error) }),
)
const describeOutcome = (outcome: TransferOutcome) => outcome.completed
  ? `completed ${outcome.status ?? 'without status'} with ${outcome.body.length} bytes`
  : `rejected (${outcome.terminal} terminal, observed status ${outcome.status ?? 'none'}): ${outcome.error}`
/**
 * A late integrity failure may surface as a transport or body-read rejection, with or without the headers having
 * been observed first, or at most as the product's own pre-response storage error. A completed 200 is the defect
 * this suite guards against; the helper's own timeout or a test-side destroy proves nothing about the product and
 * fails the case. The observed status is recorded, not asserted, for a rejected transfer.
 */
function expectNoCleanCompletion(outcome: TransferOutcome, code: 'PUBLISH_STORAGE_ERROR' | 'CATALOG_STORAGE_ERROR', label: string) {
  expect(outcome.completed && outcome.status === 200, `${label}: a complete 200 body must not be delivered: ${describeOutcome(outcome)}`).toBe(false)
  if (outcome.completed) {
    expectStorageError({ status: outcome.status ?? 0, headers: outcome.headers, body: outcome.body }, code)
  } else {
    expect(outcome.terminal, `${label}: the transfer must end through a transport rejection, not through the harness's own timeout or destroy: ${describeOutcome(outcome)}`).toBe('transport')
  }
  test.info().annotations.push({ type: 'integrity-failure-boundary', description: `${label}: ${describeOutcome(outcome)}` })
}

test('a verified reset yields a fresh instance each time and clears alarm records, faults and callbacks', async ({ baseURL }) => {
  const origin = baseURL!
  const first = await wipeStore(origin)
  await injectFault(origin, { target: 'sql.exec', match: 'never matched', message: 'leftover fault' })
  const second = await wipeStore(origin)
  expect(second.before.harnessInstance).toBe(first.after.harnessInstance)
  expect(second.after.harnessInstance).not.toBe(first.after.harnessInstance)
  expect(second.abortObserved).toBe(true)
  expect(second.after.nativeAlarm).toBeNull()
  const state = await storeState(origin)
  expect(state.harnessInstance).toBe(second.after.harnessInstance)
  expect(state).toMatchObject({ nativeAlarm: null, alarmInFlight: false, dispatching: false, preparedNonce: null, records: [], faults: [], callbacks: [] })
  expect(state.clock).toMatchObject({ mode: 'real', virtualAlarms: false })
})

test('the staging alarm is requested at exactly begin + 15 min; the inherited alarm body keeps the stage at 14:59.999 and sweeps it at 15:00.000', async ({ baseURL }) => {
  const origin = baseURL!
  await wipeStore(origin)
  await freezeClock(origin, iso(T0))
  const built = build(captures.first, GENERATION_ONE)
  expectBegun(await beginRaw(origin, built.manifestText), GENERATION_ONE)
  let state = await storeState(origin)
  expect(state.clock.virtualAlarms).toBe(true)
  expect(state.nativeAlarm).toBeNull()
  expect(alarmCalls(state.records)).toEqual([['setAlarm', T0 + IDLE_MS, true, 'request']])

  await freezeClock(origin, iso(T0 + IDLE_MS - 1))
  const kept = await dispatchAlarm(origin)
  expect(kept.error).toBeNull()
  expect(alarmCalls(kept.recorded)).toEqual([['setAlarm', T0 + IDLE_MS, true, 'dispatch']])
  expect((await metricsOf(origin)).staging).toBe(GENERATION_ONE)

  await freezeClock(origin, iso(T0 + IDLE_MS))
  const swept = await dispatchAlarm(origin)
  expect(swept.error).toBeNull()
  expect(alarmCalls(swept.recorded)).toEqual([['deleteAlarm', null, true, 'dispatch']])
  expect(await metricsOf(origin)).toMatchObject({ staging: null, chunks: 0, payloadBytes: 0, generations: 0 })
  const late = await putChunkRaw(origin, GENERATION_ONE, 0, built.chunks[0])
  expect(late.status).toBe(409)
  expect(jsonBody(late)).toEqual(CONFLICT)
  state = await storeState(origin)
  expect(state.callbacks.map(callback => [callback.source, callback.clock_at])).toEqual([['dispatch', iso(T0 + IDLE_MS - 1)], ['dispatch', iso(T0 + IDLE_MS)]])
  expect(state.nativeAlarm).toBeNull()
})

test('uploads renew the idle deadline but never the lifetime: the alarm body ends the stage at exactly begin + 2 h and sweeps its chunks', async ({ baseURL }) => {
  const origin = baseURL!
  await wipeStore(origin)
  await freezeClock(origin, iso(T0))
  const built = build(captures.first, GENERATION_ONE)
  expectBegun(await beginRaw(origin, built.manifestText), GENERATION_ONE)
  for (let minutes = 10; minutes <= 110; minutes += 10) {
    await freezeClock(origin, iso(T0 + minutes * MINUTE))
    const put = await putChunkRaw(origin, GENERATION_ONE, 0, built.chunks[0])
    expect(put.status, `upload at +${minutes} min`).toBe(200)
    const state = await storeState(origin)
    const expectedDeadline = Math.min(T0 + minutes * MINUTE + IDLE_MS, T0 + LIFETIME_MS)
    expect(alarmCalls(state.records).at(-1), `alarm after upload at +${minutes} min`).toEqual(['setAlarm', expectedDeadline, true, 'request'])
  }
  await freezeClock(origin, iso(T0 + LIFETIME_MS - 1))
  const kept = await dispatchAlarm(origin)
  expect(kept.error).toBeNull()
  expect(alarmCalls(kept.recorded)).toEqual([['setAlarm', T0 + LIFETIME_MS, true, 'dispatch']])
  expect(await metricsOf(origin)).toMatchObject({ staging: GENERATION_ONE, chunks: 1, payloadBytes: built.chunks[0].byteLength })

  await freezeClock(origin, iso(T0 + LIFETIME_MS))
  const ended = await dispatchAlarm(origin)
  expect(ended.error).toBeNull()
  expect(alarmCalls(ended.recorded)).toEqual([['deleteAlarm', null, true, 'dispatch']])
  expect(await metricsOf(origin)).toMatchObject({ staging: null, chunks: 0, payloadBytes: 0 })
  const late = await putChunkRaw(origin, GENERATION_ONE, 0, built.chunks[0])
  expect(late.status).toBe(409)
})

test('a held public response is rendered at its request-start clock even when the logical clock advances before the body is read', async ({ baseURL }) => {
  const origin = baseURL!
  await wipeStore(origin)
  const fresh = Date.parse(T('06:05:00.000'))
  await freezeClock(origin, iso(fresh))
  const first = await publish(origin, captures.bulk, GENERATION_ONE)
  const streams = new StreamRegistry()
  let primary: unknown
  let failed = false
  try {
    const held = streams.open(origin, '/api/catalog', { 'Accept-Encoding': 'identity' })
    await held.ready
    expect(held.status).toBe(200)
    expect(held.state).toBe('paused')
    expect((await metricsOf(origin)).activeBodies, 'the paused reader must still hold a body lease').toBe(1)
    // Advance past the 30-minute freshness boundary while the first response is still held.
    const later = Date.parse(T('06:35:00.000'))
    await freezeClock(origin, iso(later))
    const direct = await rawRequest(origin, '/api/catalog', { headers: { 'Accept-Encoding': 'identity' }, timeoutMs: 300_000 })
    expect(direct.status).toBe(200)
    expectIndependentCatalog(direct.body, { capturedAt: CAPTURE_ONE, head: first.head, requestClock: later, jobs: bulkJobs(CAPTURE_ONE) }, 'direct read at 06:35 (stale)')
    const heldBody = await held.finish()
    expectIndependentCatalog(heldBody, { capturedAt: CAPTURE_ONE, head: first.head, requestClock: fresh, jobs: bulkJobs(CAPTURE_ONE) }, 'held read started at 06:05 (fresh)')
  } catch (error) {
    primary = error
    failed = true
  }
  await finish(primary, failed, [
    { label: 'streams', run: async () => { streams.destroyAll() } },
    { label: 'leases released', run: () => expect.poll(async () => (await metricsOf(origin)).activeBodies, { timeout: 20_000 }).toBe(0) },
  ])
})

test('retirement: the alarm is requested at retiredAt + 5 min; an unpinned retired generation survives at 4:59.999; a real leased reader pins it at 5:00.000 with a 60 s retry; release collects it', async ({ baseURL }) => {
  const origin = baseURL!
  await wipeStore(origin)
  const T1 = T0
  const T2 = T0 + 30 * MINUTE
  const T3 = T0 + 60 * MINUTE
  await freezeClock(origin, iso(T1))
  const first = await publish(origin, captures.bulk, GENERATION_ONE)
  expect(alarmCalls((await storeState(origin)).records).at(-1)).toEqual(['deleteAlarm', null, true, 'request'])
  await freezeClock(origin, iso(T2))
  const second = await publish(origin, captures.second, GENERATION_TWO, first.head)
  expect(alarmCalls((await storeState(origin)).records).at(-1)).toEqual(['deleteAlarm', null, true, 'request'])
  await freezeClock(origin, iso(T3))
  await publish(origin, captures.third, GENERATION_THREE, second.head)
  expect(alarmCalls((await storeState(origin)).records).at(-1)).toEqual(['setAlarm', T3 + RETIRED_MS, true, 'request'])
  expect(await metricsOf(origin)).toMatchObject({ generations: 3, staging: null, activeBodies: 0, activeGenerations: 0 })

  // (a) No reader at all: survival one millisecond before the deadline proves the age predicate is not early (AWL82-3).
  await freezeClock(origin, iso(T3 + RETIRED_MS - 1))
  const early = await dispatchAlarm(origin)
  expect(early.error).toBeNull()
  expect(alarmCalls(early.recorded)).toEqual([['setAlarm', T3 + RETIRED_MS - 1 + RETRY_FLOOR_MS, true, 'dispatch']])
  expect(await metricsOf(origin)).toMatchObject({ generations: 3, activeGenerations: 0, activeBodies: 0 })
  const stillServed = await rawRequest(origin, `/api/catalog?generation=${GENERATION_ONE}`, { method: 'HEAD' })
  expect(stillServed.status).toBe(200)
  expect(stillServed.headers['x-orbit-generation']).toBe(GENERATION_ONE)

  // (b) Acquire a real reader of the bulk body and witness its active lease before advancing to the exact deadline.
  const streams = new StreamRegistry()
  let primary: unknown
  let failed = false
  try {
    const slow = streams.open(origin, `/api/catalog?generation=${GENERATION_ONE}`, { 'Accept-Encoding': 'identity' })
    await slow.ready
    expect(slow.status).toBe(200)
    expect(slow.headers['x-orbit-generation']).toBe(GENERATION_ONE)
    expect(slow.state, 'the client holds the response open').toBe('paused')
    expect(await metricsOf(origin), 'the producer must still be leased; a drained body fails this honestly').toMatchObject({ activeBodies: 1, activeGenerations: 1 })
    await freezeClock(origin, iso(T3 + RETIRED_MS))
    const pinned = await dispatchAlarm(origin)
    expect(pinned.error).toBeNull()
    expect(alarmCalls(pinned.recorded)).toEqual([['setAlarm', T3 + RETIRED_MS + RETRY_FLOOR_MS, true, 'dispatch']])
    expect(await metricsOf(origin)).toMatchObject({ generations: 3, activeGenerations: 1, activeBodies: 1 })
    const body = await slow.finish()
    expect(slow.state).toBe('ended')
    // The pinned body was rendered at its request-start clock (T3 + 4:59.999), not at the later deadline.
    expectIndependentCatalog(body, { capturedAt: CAPTURE_ONE, head: first.head, requestClock: T3 + RETIRED_MS - 1, jobs: bulkJobs(CAPTURE_ONE) }, 'pinned retired generation')
  } catch (error) {
    primary = error
    failed = true
  }
  await finish(primary, failed, [
    { label: 'streams', run: async () => { streams.destroyAll() } },
    { label: 'leases released', run: () => expect.poll(async () => (await metricsOf(origin)).activeGenerations, { timeout: 20_000 }).toBe(0) },
  ])
  // (c) Released: the next alarm body at the same deadline removes the generation and stops the alarm.
  const removed = await dispatchAlarm(origin)
  expect(removed.error).toBeNull()
  expect(alarmCalls(removed.recorded)).toEqual([['deleteAlarm', null, true, 'dispatch']])
  expect(await metricsOf(origin)).toMatchObject({ generations: 2, staging: null, activeGenerations: 0, activeBodies: 0 })
  const gone = await rawRequest(origin, `/api/catalog?generation=${GENERATION_ONE}`)
  expect(gone.status).toBe(410)
  expect(jsonBody(gone)).toEqual(GONE)
  expect((await storeState(origin)).nativeAlarm).toBeNull()
})

test('a native alarm callback runs the inherited body under the real clock and removes a stage whose lifetime ended', async ({ baseURL }) => {
  test.setTimeout(90_000)
  const origin = baseURL!
  await wipeStore(origin)
  expect((await storeState(origin)).clock).toMatchObject({ mode: 'real', virtualAlarms: false })
  const first = await publish(origin, captures.first, GENERATION_ONE)
  const second = build(captures.second, GENERATION_TWO, first.head)
  expectBegun(await beginRaw(origin, second.manifestText), GENERATION_TWO)
  const scheduled = await storeState(origin)
  const requested = scheduled.records.at(-1)!
  expect(requested).toMatchObject({ op: 'setAlarm', virtual: false, source: 'request' })
  expect(Math.abs(requested.at! - (Date.now() + IDLE_MS))).toBeLessThan(5_000)
  expect(scheduled.nativeAlarm).toBe(requested.at)

  // Age the stage so its lifetime ends about three seconds from now; the product recomputes through its own idempotent begin.
  const aged = await ageTimestamps(origin, { stagingCreatedMs: LIFETIME_MS - 3_000 })
  expect(aged.aged.stagingCreated).toBe(1)
  const rescheduledAt = Date.now()
  expectBegun(await beginRaw(origin, second.manifestText), GENERATION_TWO)
  const rescheduled = await storeState(origin)
  const deadline = rescheduled.records.at(-1)!
  expect(deadline).toMatchObject({ op: 'setAlarm', virtual: false, source: 'request' })
  // Finite setup window: the deadline must lie 0..3.5 s ahead of the rescheduling request; a miss is a timing prerequisite failure, not product expiry.
  expect(deadline.at! - rescheduledAt).toBeGreaterThan(0)
  expect(deadline.at! - rescheduledAt).toBeLessThanOrEqual(3_500)
  expect(rescheduled.nativeAlarm).toBe(deadline.at)

  await expect.poll(async () => (await storeState(origin)).callbacks.filter(callback => callback.source === 'native').length, { timeout: 25_000, intervals: [250] }).toBe(1)
  const after = await storeState(origin)
  const callback = after.callbacks.find(item => item.source === 'native')!
  expect(Date.parse(callback.real_at)).toBeGreaterThanOrEqual(deadline.at! - 10)
  expect(after.nativeAlarm).toBeNull()
  expect(after.alarmInFlight).toBe(false)
  expect(after.records.at(-1)).toMatchObject({ op: 'deleteAlarm', virtual: false, source: 'native' })
  const metrics = await metricsOf(origin)
  expect(metrics).toMatchObject({ staging: null, generations: 1, chunks: first.built.chunks.length })
})

test('a verified reset while a native alarm is pending and its handler is in flight leaves a fresh instance with no alarm and no retried callback within the observed window', async ({ baseURL }) => {
  test.setTimeout(90_000)
  const origin = baseURL!
  await wipeStore(origin)
  const first = await publish(origin, captures.first, GENERATION_ONE)
  const second = build(captures.second, GENERATION_TWO, first.head)
  expectBegun(await beginRaw(origin, second.manifestText), GENERATION_TWO)
  // The handler's final deleteAlarm is held for four seconds: the sweep has run, the handler is still in flight.
  await injectFault(origin, { target: 'deleteAlarm', delayMs: 4_000, message: null })
  await ageTimestamps(origin, { stagingCreatedMs: LIFETIME_MS - 2_000 })
  expectBegun(await beginRaw(origin, second.manifestText), GENERATION_TWO)
  const pending = await storeState(origin)
  expect(pending.nativeAlarm).not.toBeNull()
  // Finite setup window: the native callback must enter and hold within this bound; a miss is a timing prerequisite failure to diagnose.
  await expect.poll(async () => (await storeState(origin)).alarmInFlight, { timeout: 15_000, intervals: [100] }).toBe(true)
  const witness = await wipeStore(origin)
  expect(witness.before.alarmInFlight).toBe(true)
  expect(witness.abortObserved).toBe(true)
  expect(witness.after.nativeAlarm).toBeNull()
  // retryAlarm:false — a six-second observation window; a retried callback would appear as a native row on the fresh instance.
  await new Promise(resolve => setTimeout(resolve, 6_000))
  const settled = await storeState(origin)
  expect(settled.harnessInstance).toBe(witness.after.harnessInstance)
  expect(settled.callbacks).toEqual([])
  expect(settled.records.filter(record => record.source === 'native')).toEqual([])
  expect(settled).toMatchObject({ nativeAlarm: null, alarmInFlight: false, faults: [] })
  expect(await metricsOf(origin)).toMatchObject({ generations: 0, staging: null, chunks: 0 })
})

test('injected storage failures surface as the product\'s 503 storage errors: pre-write refusals, one real after-INSERT rollback, lost alarm maintenance, failed reads; every fault clears on retry', async ({ baseURL }) => {
  const origin = baseURL!
  await wipeStore(origin)
  await freezeClock(origin, iso(T0))
  const first = build(captures.first, GENERATION_ONE)
  const streams = new StreamRegistry()
  let primary: unknown
  let failed = false
  try {
    // 1. Pre-write: the begin request's first storage transaction (its sweep) is refused at entry, before any statement; nothing is staged, the fault is consumed, the retry succeeds.
    await injectFault(origin, { target: 'transactionSync', message: 'synthetic transaction failure' })
    expectStorageError(await beginRaw(origin, first.manifestText), 'PUBLISH_STORAGE_ERROR')
    expect(await metricsOf(origin)).toMatchObject({ staging: null, chunks: 0 })
    expect((await storeState(origin)).faults.map(fault => [fault.target, fault.hits, fault.remaining])).toEqual([['transactionSync', 1, 0]])
    expectBegun(await beginRaw(origin, first.manifestText), GENERATION_ONE)

    // 2. Pre-write: the chunk INSERT is refused by the facade before the real statement runs; no row, stage intact.
    await injectFault(origin, { target: 'sql.exec', match: 'INSERT INTO orbit_chunks', message: 'synthetic chunk write refusal' })
    expectStorageError(await putChunkRaw(origin, GENERATION_ONE, 0, first.chunks[0]), 'PUBLISH_STORAGE_ERROR')
    expect(await metricsOf(origin)).toMatchObject({ staging: GENERATION_ONE, chunks: 0, payloadBytes: 0 })

    // 3. After-write rollback (AWL82-2): the real chunk INSERT executes, then the stage UPDATE of the same SQLite transaction fails.
    await injectFault(origin, { target: 'sql.exec', match: 'UPDATE orbit_staging SET touched_at = ? WHERE singleton = 1', trace: 'INSERT INTO orbit_chunks', message: 'synthetic stage-touch failure after the chunk insert' })
    expectStorageError(await putChunkRaw(origin, GENERATION_ONE, 0, first.chunks[0]), 'PUBLISH_STORAGE_ERROR')
    const rollback = (await storeState(origin)).faults.at(-1)!
    expect(rollback).toMatchObject({ target: 'sql.exec', hits: 1, remaining: 0, traced: 1 })
    // The inserted row and the stage touch rolled back together: no chunk, no payload, the stage still present.
    expect(await metricsOf(origin)).toMatchObject({ staging: GENERATION_ONE, chunks: 0, payloadBytes: 0 })
    expect((await putChunkRaw(origin, GENERATION_ONE, 0, first.chunks[0])).status).toBe(200)
    expect(await metricsOf(origin)).toMatchObject({ staging: GENERATION_ONE, chunks: 1, payloadBytes: first.chunks[0].byteLength })
    for (const [index, chunk] of first.chunks.entries()) expect((await putChunkRaw(origin, GENERATION_ONE, index, chunk)).status, `chunk ${index}`).toBe(200)

    // 4. Alarm maintenance after the commit fails: the generation is installed, the reply is lost, head and an idempotent commit recover it.
    await injectFault(origin, { target: 'deleteAlarm', message: 'synthetic alarm maintenance failure' })
    expectStorageError(await commitRaw(origin, { generation: GENERATION_ONE }), 'PUBLISH_STORAGE_ERROR')
    const head = jsonBody(await rawRequest(origin, '/__orbit/publish/head', { headers: authorized() })) as { head: PublicationHead | null }
    expect(head.head).toMatchObject({ revision: 1, generation: GENERATION_ONE })
    const retried = await commitRaw(origin, { generation: GENERATION_ONE })
    expect(retried.status).toBe(200)
    expect(jsonBody(retried)).toEqual({ head: head.head })
    expect(await metricsOf(origin)).toMatchObject({ generations: 1, staging: null, chunks: first.chunks.length })

    // 5. A meta read fails on a public request: CATALOG_STORAGE_ERROR once, then the catalog written from the fixture at the frozen clock.
    await injectFault(origin, { target: 'sql.exec', match: 'SELECT revision, current_id, previous_id FROM orbit_meta', message: 'synthetic meta read failure' })
    expectStorageError(await rawRequest(origin, '/api/catalog'), 'CATALOG_STORAGE_ERROR')
    const served = await rawRequest(origin, '/api/catalog', { headers: { 'Accept-Encoding': 'identity' } })
    expect(served.status).toBe(200)
    expectIndependentCatalog(served.body, { capturedAt: CAPTURE_ONE, head: head.head!, requestClock: T0, jobs: defaultJobs(CAPTURE_ONE) }, 'served after the meta read failure')

    // 6. A chunk read fails while streaming: the body cannot complete as a 200, the lease is released, the next read is exact.
    await injectFault(origin, { target: 'sql.exec', match: 'SELECT hash, size, body FROM orbit_chunks', message: 'synthetic chunk read failure' })
    const stream = streams.open(origin, '/api/catalog')
    const outcome = await stream.ready.then(() => stream.finish()).then(body => ({ completed: true as const, status: stream.status, bytes: body.length }), error => ({ completed: false as const, status: stream.status, error: String(error) }))
    expect(outcome.completed && outcome.status === 200, `a complete 200 body must not be delivered: ${JSON.stringify(outcome)}`).toBe(false)
    await expect.poll(async () => (await metricsOf(origin)).activeBodies, { timeout: 20_000 }).toBe(0)
    expect((await metricsOf(origin)).activeGenerations).toBe(0)
    const recovered = await rawRequest(origin, '/api/catalog', { headers: { 'Accept-Encoding': 'identity' } })
    expect(recovered.status).toBe(200)
    expectIndependentCatalog(recovered.body, { capturedAt: CAPTURE_ONE, head: head.head!, requestClock: T0, jobs: defaultJobs(CAPTURE_ONE) }, 'recovered after the chunk read failure')
    const state = await storeState(origin)
    expect(state.faults).toHaveLength(6)
    expect(state.faults.every(fault => fault.remaining === 0 && fault.hits === 1)).toBe(true)
  } catch (error) {
    primary = error
    failed = true
  }
  await finish(primary, failed, [
    { label: 'streams', run: async () => { streams.destroyAll() } },
    { label: 'faults cleared', run: async () => { await clearFaults(origin) } },
  ])
})

// ---------------------------------------------------------------------------
// Stream-remedy regressions (NATIVE82-STREAM-REMEDY-01, SR01-11 (a)-(f)).
// ---------------------------------------------------------------------------

test('a decoded-digest failure that is only reachable after every decoded byte was produced never completes as a clean 200: an authenticated checkpoint without closing text, then the public catalog with closing text; slots and pins are released, the checkpoint client rejects, and a healthy publication recovers', async ({ baseURL }) => {
  const origin = baseURL!
  await wipeStore(origin)
  const fresh = Date.parse(T('06:05:00.000'))
  await freezeClock(origin, iso(fresh))
  // Provenance: the uploaded bytes are the untouched built publication; only two manifest declarations lie, and a chunk upload cannot detect a decoded-digest lie.
  const healthy = build(captures.first, GENERATION_ONE)
  expect(healthy.manifest.checkpoint.files.boards).toBe('private-boards')
  expect(healthy.manifest.catalog.boards[0]).toMatchObject({ base: { companyId: PROVENANCE_ALDER.id }, fresh: 'c-0-fresh' })
  const corrupt = declareFragment(declareFragment(healthy, 'private-boards', { decodedHash: 'f'.repeat(64) }), 'c-0-fresh', { decodedHash: 'e'.repeat(64) })
  expect(corrupt.chunks).toBe(healthy.chunks)
  const corruptHead = await contractClient(origin).publish(corrupt)
  expect(corruptHead).toEqual({ revision: 1, generation: GENERATION_ONE, publishedAt: T('06:05:00.000') })
  const stored = await contractClient(origin).head()
  expect(stored.manifest!.fragments['private-boards'].decodedHash).toBe('f'.repeat(64))
  expect(stored.manifest!.fragments['c-0-fresh'].decodedHash).toBe('e'.repeat(64))
  const boardsFile = decodedFragment(corrupt, 'private-boards')
  expect(boardsFile.length).toBeGreaterThan(0)
  const streams = new StreamRegistry()
  let primary: unknown
  let failed = false
  try {
    // 1. Checkpoint: one fragment and no closing text, so only the file's own bytes can be withheld until its digest is verified.
    const checkpoint = streams.open(origin, `/__orbit/publish/checkpoint/boards?generation=${GENERATION_ONE}`, authorized({ 'Accept-Encoding': 'identity' }))
    expectNoCleanCompletion(await transferOutcome(checkpoint), 'PUBLISH_STORAGE_ERROR', `checkpoint boards (${boardsFile.length} real bytes)`)
    await expect.poll(async () => (await metricsOf(origin)).activeBodies, { timeout: 20_000 }).toBe(0)
    expect((await metricsOf(origin)).activeGenerations).toBe(0)
    // The real checkpoint client never accepts the file either: the transfer fails or its own digest check does.
    await expect(contractClient(origin).checkpoint(corruptHead, stored.manifest!)).rejects.toThrow()
    await expect.poll(async () => (await metricsOf(origin)).activeBodies, { timeout: 20_000 }).toBe(0)
    expect((await metricsOf(origin)).activeGenerations).toBe(0)
    // 2. Public catalog: the corrupt items fragment is followed by ',' + a healthy fragment + ']}'; none of that may complete a clean 200.
    const catalog = streams.open(origin, '/api/catalog', { 'Accept-Encoding': 'identity' })
    expectNoCleanCompletion(await transferOutcome(catalog), 'CATALOG_STORAGE_ERROR', 'public catalog')
    await expect.poll(async () => (await metricsOf(origin)).activeBodies, { timeout: 20_000 }).toBe(0)
    expect((await metricsOf(origin)).activeGenerations).toBe(0)
    // Metadata routes stay available without any body.
    const headOnly = await rawRequest(origin, '/api/catalog', { method: 'HEAD' })
    expect([headOnly.status, headOnly.headers['x-orbit-generation'], headOnly.body.length]).toEqual([200, GENERATION_ONE, 0])
    // 3. Healthy recovery on the same instance: generation two serves exact bytes and exact checkpoint files.
    await freezeClock(origin, iso(T0))
    const second = await publish(origin, captures.second, GENERATION_TWO, corruptHead)
    const recovered = await rawRequest(origin, '/api/catalog', { headers: { 'Accept-Encoding': 'identity' } })
    expect(recovered.status).toBe(200)
    expectIndependentCatalog(recovered.body, { capturedAt: CAPTURE_TWO, head: second.head, requestClock: T0, jobs: defaultJobs(CAPTURE_TWO) }, 'recovered after the integrity failures')
    const files = await contractClient(origin).checkpoint(second.head, second.built.manifest)
    for (const name of ['boards', 'presence', 'observations'] as const) {
      expect(Buffer.from(files[name]).equals(decodedFragment(second.built, second.built.manifest.checkpoint.files[name])), name).toBe(true)
    }
    await expect.poll(async () => (await metricsOf(origin)).activeBodies, { timeout: 20_000 }).toBe(0)
    expect((await metricsOf(origin)).activeGenerations).toBe(0)
  } catch (error) {
    primary = error
    failed = true
  }
  await finish(primary, failed, [
    { label: 'streams', run: async () => { streams.destroyAll() } },
    { label: 'leases released', run: () => expect.poll(async () => (await metricsOf(origin)).activeBodies, { timeout: 20_000 }).toBe(0) },
  ])
})

test('a zero-byte checkpoint file is a valid empty 200 under identity, gzip and br, HEAD stays bodiless, the real client accepts it, and a corrupt zero-length declaration is refused with the storage 503 envelope before any 200', async ({ baseURL }) => {
  const origin = baseURL!
  await wipeStore(origin)
  const fresh = Date.parse(T('06:05:00.000'))
  await freezeClock(origin, iso(fresh))
  // Built here, not by the publisher: the presence file becomes the 20-byte gzip of nothing, declared as 0 decoded bytes with the digest of nothing.
  const empty = repackPublication(build(captures.first, GENERATION_ONE), { 'private-presence': new Uint8Array(0) })
  expect(empty.manifest.fragments['private-presence']).toMatchObject({ decodedBytes: 0, compressedBytes: 20, decodedHash: EMPTY_SHA256, kind: 'value', visibility: 'checkpoint' })
  expect(decodedFragment(empty, 'private-presence').length).toBe(0)
  const head = await contractClient(origin).publish(empty)
  expect(head).toEqual({ revision: 1, generation: GENERATION_ONE, publishedAt: T('06:05:00.000') })
  const path = `/__orbit/publish/checkpoint/presence?generation=${GENERATION_ONE}`
  for (const encoding of ['identity', 'gzip', 'br'] as const) {
    const response = await rawRequest(origin, path, { headers: authorized({ 'Accept-Encoding': encoding }) })
    expect(response.status, encoding).toBe(200)
    expect([response.headers['x-orbit-generation'], response.headers['cache-control'], response.headers['content-type']], encoding)
      .toEqual([GENERATION_ONE, 'no-store', 'application/json; charset=utf-8'])
    expect(response.headers['content-encoding'], encoding).toBe(encoding === 'identity' ? undefined : encoding)
    expect(decodedBody(response).length, `${encoding}: the representation must decode to zero bytes`).toBe(0)
    // The empty body was verified before its response existed: nothing is left to drain, so the counters are read immediately, not polled.
    expect(await metricsOf(origin), encoding).toMatchObject({ activeBodies: 0, activeGenerations: 0 })
  }
  const headOnly = await rawRequest(origin, path, { method: 'HEAD', headers: authorized() })
  expect([headOnly.status, headOnly.body.length]).toEqual([200, 0])
  const files = await contractClient(origin).checkpoint(head, empty.manifest)
  expect(files.presence.byteLength).toBe(0)
  expect(Buffer.from(files.boards).equals(decodedFragment(empty, 'private-boards'))).toBe(true)
  expect(Buffer.from(files.observations).equals(decodedFragment(empty, 'private-observations'))).toBe(true)
  const catalog = await rawRequest(origin, '/api/catalog', { headers: { 'Accept-Encoding': 'identity' } })
  expect(catalog.status).toBe(200)
  expectIndependentCatalog(catalog.body, { capturedAt: CAPTURE_ONE, head, requestClock: fresh, jobs: defaultJobs(CAPTURE_ONE) }, 'public catalog beside the empty checkpoint file')
  await expect.poll(async () => (await metricsOf(origin)).activeBodies, { timeout: 20_000 }).toBe(0)
  expect((await metricsOf(origin)).activeGenerations).toBe(0)
  // Corrupt zero: the same empty bytes declared with a wrong decoded digest. The only acceptable answer is the product's own
  // non-empty storage-error envelope (MC-1); an empty 200 would be an unverified success.
  await freezeClock(origin, iso(T0))
  const corrupt = declareFragment(repackPublication(build(captures.second, GENERATION_TWO, head), { 'private-presence': new Uint8Array(0) }), 'private-presence', { decodedHash: 'f'.repeat(64) })
  expect(corrupt.manifest.fragments['private-presence']).toMatchObject({ decodedBytes: 0, compressedBytes: 20, decodedHash: 'f'.repeat(64) })
  const corruptHead = await contractClient(origin).publish(corrupt)
  expect(corruptHead).toEqual({ revision: 2, generation: GENERATION_TWO, publishedAt: T('06:35:00.000') })
  const refused = await rawRequest(origin, `/__orbit/publish/checkpoint/presence?generation=${GENERATION_TWO}`, { headers: authorized() })
  expectStorageError(refused, 'PUBLISH_STORAGE_ERROR')
  expect(refused.headers['content-type']).toBe('application/json; charset=utf-8')
  expect(refused.body.length).toBeGreaterThan(0)
  expect(await metricsOf(origin)).toMatchObject({ activeBodies: 0, activeGenerations: 0 })
  // The healthy files of the same generation are unaffected.
  const boards = await rawRequest(origin, `/__orbit/publish/checkpoint/boards?generation=${GENERATION_TWO}`, { headers: authorized({ 'Accept-Encoding': 'identity' }) })
  expect(boards.status).toBe(200)
  expect(boards.body.equals(decodedFragment(corrupt, 'private-boards'))).toBe(true)
  await expect.poll(async () => (await metricsOf(origin)).activeBodies, { timeout: 20_000 }).toBe(0)
  expect((await metricsOf(origin)).activeGenerations).toBe(0)
})

test('one-byte and 199 500-byte multibyte checkpoint files arrive byte-exact under identity, gzip and br, and a public catalog whose metadata text exceeds one 64 KiB encoder block keeps eighty multibyte employer names intact', async ({ baseURL }) => {
  const origin = baseURL!
  await wipeStore(origin)
  const fresh = Date.parse(T('06:05:00.000'))
  await freezeClock(origin, iso(fresh))
  const ONE_BYTE = Buffer.from([0x37])
  const MULTIBYTE = multibyteFragment()
  expect([MULTIBYTE.length, MULTIBYTE_FRAGMENT_BYTES, MULTIBYTE_UNIT_COUNT]).toEqual([199_500, 199_500, 28_500])
  expect(new TextDecoder('utf-8', { fatal: true }).decode(MULTIBYTE)).toBe('가🌱'.repeat(28_500))
  // Each 64 KiB block boundary of the decoded file splits a character: 65 536 ≡ 2, 131 072 ≡ 4, 196 608 ≡ 6 (mod 7).
  expect([65_536 % 7, 131_072 % 7, 196_608 % 7]).toEqual([2, 4, 6])
  const exact = repackPublication(build(captures.first, GENERATION_ONE), { 'private-presence': ONE_BYTE, 'private-observations': MULTIBYTE })
  expect(exact.manifest.fragments['private-presence']).toMatchObject({ decodedBytes: 1, decodedHash: sha256(ONE_BYTE) })
  expect(exact.manifest.fragments['private-observations']).toMatchObject({ decodedBytes: 199_500, decodedHash: sha256(MULTIBYTE) })
  const head = await contractClient(origin).publish(exact)
  expect(head).toEqual({ revision: 1, generation: GENERATION_ONE, publishedAt: T('06:05:00.000') })
  for (const [name, expected] of [['presence', ONE_BYTE], ['observations', MULTIBYTE]] as const) {
    for (const encoding of ['identity', 'gzip', 'br'] as const) {
      const response = await rawRequest(origin, `/__orbit/publish/checkpoint/${name}?generation=${GENERATION_ONE}`, { headers: authorized({ 'Accept-Encoding': encoding }), timeoutMs: 120_000 })
      expect(response.status, `${name} ${encoding}`).toBe(200)
      expect(response.headers['content-encoding'], `${name} ${encoding}`).toBe(encoding === 'identity' ? undefined : encoding)
      const delivered = decodedBody(response)
      expect(delivered.length, `${name} ${encoding}: decoded length`).toBe(expected.length)
      expect(delivered.equals(expected), `${name} ${encoding}: exact bytes`).toBe(true)
    }
  }
  await expect.poll(async () => (await metricsOf(origin)).activeBodies, { timeout: 20_000 }).toBe(0)
  expect((await metricsOf(origin)).activeGenerations).toBe(0)
  const files = await contractClient(origin).checkpoint(head, exact.manifest)
  expect(Buffer.from(files.presence).equals(ONE_BYTE)).toBe(true)
  expect(Buffer.from(files.observations).equals(MULTIBYTE)).toBe(true)
  // Public metadata text across encoder blocks: the eighty-employer list alone is more than one 64 KiB block of mostly multibyte text.
  const companies = multibyteCompanies()
  expect(companies).toHaveLength(80)
  expect(Buffer.byteLength(JSON.stringify(companies))).toBeGreaterThan(64 * 1024)
  const wide = await publish(origin, captures.multibyte, GENERATION_TWO, head)
  const served = await rawRequest(origin, '/api/catalog', { headers: { 'Accept-Encoding': 'identity' }, timeoutMs: 120_000 })
  expect(served.status).toBe(200)
  expect(served.headers['x-orbit-generation']).toBe(GENERATION_TWO)
  // Strict decoding throws on any split sequence; the fixture contains no U+FFFD, so none may appear; the round trip proves the body is exactly its own UTF-8.
  const text = new TextDecoder('utf-8', { fatal: true }).decode(served.body)
  expect(text.includes(String.fromCharCode(0xfffd))).toBe(false)
  expect(Buffer.from(text, 'utf8').equals(served.body)).toBe(true)
  const catalog = JSON.parse(text) as Record<string, any>
  expect(catalog.companies).toEqual(companies)
  expect(catalog.boards.map((board: { companyId: string; status: string; dataStatus: string; total: number; included: number }) => [board.companyId, board.status, board.dataStatus, board.total, board.included]))
    .toEqual(companies.map(company => [company.id, 'ok', 'fresh', 1, 1]))
  const jobs = catalog.jobs as Job[]
  expect(jobs.map(job => job.id).sort()).toEqual(companies.map(company => `greenhouse-${company.id}-7401`).sort())
  for (const company of companies) {
    expect(jobs.find(job => job.companyId === company.id)?.title, company.id).toBe(`Backend Engineer — ${company.name} 7401`)
  }
  expect(catalog.publication).toEqual({ mode: 'scheduled', generation: GENERATION_TWO, publishedAt: T('06:05:00.000'), intervalMinutes: 30 })
  for (const encoding of ['gzip', 'br'] as const) {
    const encoded = await rawRequest(origin, '/api/catalog', { headers: { 'Accept-Encoding': encoding }, timeoutMs: 120_000 })
    expect(encoded.headers['content-encoding'], encoding).toBe(encoding)
    expect(decodedBody(encoded).equals(served.body), `${encoding}: decodes to the identity bytes`).toBe(true)
  }
  await expect.poll(async () => (await metricsOf(origin)).activeBodies, { timeout: 20_000 }).toBe(0)
  expect((await metricsOf(origin)).activeGenerations).toBe(0)
  expect(wide.head.generation).toBe(GENERATION_TWO)
})

test('a chunk read failure during a negotiated gzip or br transfer ends as a transport rejection or an undecodable body, never as a normally completed and cleanly decoded 200; the lease is released and the next encoded read is exact', async ({ baseURL }) => {
  const origin = baseURL!
  await wipeStore(origin)
  await freezeClock(origin, iso(T0))
  const first = await publish(origin, captures.first, GENERATION_ONE)
  const codecs: ['gzip' | 'br', (bytes: Buffer) => Buffer][] = [['gzip', bytes => gunzipSync(bytes)], ['br', bytes => brotliDecompressSync(bytes)]]
  const streams = new StreamRegistry()
  let primary: unknown
  let failed = false
  try {
    for (const [encoding, decode] of codecs) {
      await injectFault(origin, { target: 'sql.exec', match: 'SELECT hash, size, body FROM orbit_chunks', message: `synthetic chunk read failure under ${encoding}` })
      const stream = streams.open(origin, '/api/catalog', { 'Accept-Encoding': encoding })
      const outcome = await transferOutcome(stream)
      let boundary: string
      if (!outcome.completed) {
        // A non-helper transport or body-read rejection counts whether or not the headers were observed first; the helper's 60 s timeout or a destroy proves nothing (MC-3 transport branch).
        expect(outcome.terminal, `${encoding}: ${describeOutcome(outcome)}`).toBe('transport')
        boundary = `transport: ${describeOutcome(outcome)}`
      } else {
        // The fault strikes at the first chunk read, after the 200 headers; a completed transfer may only be an undecodable one (MC-3).
        expect(outcome.status, `${encoding}: the fault must strike after the 200 headers`).toBe(200)
        expect(outcome.headers['content-encoding'], encoding).toBe(encoding)
        let decodeFailure: string | null = null
        let decodedLength = -1
        try { decodedLength = decode(outcome.body).length } catch (error) { decodeFailure = String(error) }
        expect(decodeFailure, `${encoding}: ${outcome.body.length} wire bytes completed and decoded cleanly to ${decodedLength} bytes; a normally finished transfer of a truncated representation fails this regression even when its JSON is invalid`).not.toBeNull()
        boundary = `decoder: ${decodeFailure}`
      }
      test.info().annotations.push({ type: `late-fault-boundary-${encoding}`, description: boundary })
      await expect.poll(async () => (await metricsOf(origin)).activeBodies, { timeout: 20_000 }).toBe(0)
      expect((await metricsOf(origin)).activeGenerations).toBe(0)
      const recovered = await rawRequest(origin, '/api/catalog', { headers: { 'Accept-Encoding': encoding } })
      expect(recovered.status, encoding).toBe(200)
      expect(recovered.headers['content-encoding'], encoding).toBe(encoding)
      expectIndependentCatalog(decodedBody(recovered), { capturedAt: CAPTURE_ONE, head: first.head, requestClock: T0, jobs: defaultJobs(CAPTURE_ONE) }, `recovered under ${encoding}`)
    }
    expect((await storeState(origin)).faults.map(fault => [fault.target, fault.match, fault.hits, fault.remaining])).toEqual([
      ['sql.exec', 'SELECT hash, size, body FROM orbit_chunks', 1, 0],
      ['sql.exec', 'SELECT hash, size, body FROM orbit_chunks', 1, 0],
    ])
  } catch (error) {
    primary = error
    failed = true
  }
  await finish(primary, failed, [
    { label: 'streams', run: async () => { streams.destroyAll() } },
    { label: 'faults cleared', run: async () => { await clearFaults(origin) } },
  ])
})

test('a synchronous failure of the response owner\'s ctx.waitUntil registration answers the storage 503, leaves no body lease or generation pin, and the retry serves the exact catalog', async ({ baseURL }) => {
  const origin = baseURL!
  await wipeStore(origin)
  await freezeClock(origin, iso(T0))
  const first = await publish(origin, captures.first, GENERATION_ONE)
  let primary: unknown
  let failed = false
  try {
    // The restored test entry's one-shot 'waitUntil' fault throws from the product's own registration call; every other call reaches the native method with its native receiver.
    // Armed inside the try so this case's own finish clears the fault even if arming or its assertions fail.
    const armed = await rawRequest(origin, '/__test/store/fault', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ target: 'waitUntil', message: 'synthetic waitUntil registration failure' }) })
    expect(armed.status, 'the test entry must accept the registration fault').toBe(200)
    expect((jsonBody(armed) as { fault: { target: string; remaining: number } }).fault).toMatchObject({ target: 'waitUntil', remaining: 1 })
    expectStorageError(await rawRequest(origin, '/api/catalog', { headers: { 'Accept-Encoding': 'identity' } }), 'CATALOG_STORAGE_ERROR')
    // The owner joined its producer before rejecting: nothing is left to drain, so the counters are read immediately, not polled.
    expect(await metricsOf(origin)).toMatchObject({ activeBodies: 0, activeGenerations: 0 })
    expect((await storeState(origin)).faults.map(fault => [String(fault.target), fault.hits, fault.remaining])).toEqual([['waitUntil', 1, 0]])
    const recovered = await rawRequest(origin, '/api/catalog', { headers: { 'Accept-Encoding': 'identity' } })
    expect(recovered.status).toBe(200)
    expectIndependentCatalog(recovered.body, { capturedAt: CAPTURE_ONE, head: first.head, requestClock: T0, jobs: defaultJobs(CAPTURE_ONE) }, 'retry after the registration failure')
    await expect.poll(async () => (await metricsOf(origin)).activeBodies, { timeout: 20_000 }).toBe(0)
    expect((await metricsOf(origin)).activeGenerations).toBe(0)
  } catch (error) {
    primary = error
    failed = true
  }
  await finish(primary, failed, [{ label: 'faults cleared', run: async () => { await clearFaults(origin) } }])
})

test('a destroyed paused reader of a pinned retired generation releases its body lease and pin; the next alarm body then collects the generation', async ({ baseURL }) => {
  const origin = baseURL!
  await wipeStore(origin)
  const T1 = T0
  const T2 = T0 + 30 * MINUTE
  const T3 = T0 + 60 * MINUTE
  await freezeClock(origin, iso(T1))
  const first = await publish(origin, captures.bulk, GENERATION_ONE)
  await freezeClock(origin, iso(T2))
  const second = await publish(origin, captures.second, GENERATION_TWO, first.head)
  await freezeClock(origin, iso(T3))
  await publish(origin, captures.third, GENERATION_THREE, second.head)
  expect(await metricsOf(origin)).toMatchObject({ generations: 3, staging: null, activeBodies: 0, activeGenerations: 0 })
  const streams = new StreamRegistry()
  let primary: unknown
  let failed = false
  try {
    const held = streams.open(origin, `/api/catalog?generation=${GENERATION_ONE}`, { 'Accept-Encoding': 'identity' })
    await held.ready
    expect([held.status, held.headers['x-orbit-generation'], held.state]).toEqual([200, GENERATION_ONE, 'paused'])
    expect(held.firstChunkBytes).toBeGreaterThan(0)
    expect(await metricsOf(origin), 'the paused reader must hold a body lease and pin the retired generation').toMatchObject({ activeBodies: 1, activeGenerations: 1 })
    await freezeClock(origin, iso(T3 + RETIRED_MS))
    const pinned = await dispatchAlarm(origin)
    expect(pinned.error).toBeNull()
    expect(alarmCalls(pinned.recorded)).toEqual([['setAlarm', T3 + RETIRED_MS + RETRY_FLOOR_MS, true, 'dispatch']])
    expect(await metricsOf(origin)).toMatchObject({ generations: 3, activeGenerations: 1, activeBodies: 1 })
    // The client disappears without reading the rest: the lease and the pin must follow it.
    held.destroy()
    expect(held.state).toBe('destroyed')
    await expect.poll(async () => (await metricsOf(origin)).activeGenerations, { timeout: 20_000 }).toBe(0)
    expect(await metricsOf(origin)).toMatchObject({ generations: 3, activeBodies: 0, activeGenerations: 0 })
  } catch (error) {
    primary = error
    failed = true
  }
  await finish(primary, failed, [
    { label: 'streams', run: async () => { streams.destroyAll() } },
    { label: 'leases released', run: () => expect.poll(async () => (await metricsOf(origin)).activeBodies, { timeout: 20_000 }).toBe(0) },
  ])
  // Released: the next alarm body at the same deadline removes the generation and stops the alarm.
  const removed = await dispatchAlarm(origin)
  expect(removed.error).toBeNull()
  expect(alarmCalls(removed.recorded)).toEqual([['deleteAlarm', null, true, 'dispatch']])
  expect(await metricsOf(origin)).toMatchObject({ generations: 2, staging: null, activeGenerations: 0, activeBodies: 0 })
  const gone = await rawRequest(origin, `/api/catalog?generation=${GENERATION_ONE}`)
  expect(gone.status).toBe(410)
  expect(jsonBody(gone)).toEqual(GONE)
  expect((await storeState(origin)).nativeAlarm).toBeNull()
})
