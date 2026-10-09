import { expect, test as baseTest } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { buildPublication } from '../../server/publication-build'
import type { BuiltPublication } from '../../server/publication-build'
import { isPublicCatalog } from '../../src/lib/catalog-validation'
import { ObservationHistorySchema } from '../../shared/catalog-observations'
import { PostingStatusIndexSchema } from '../../shared/posting-status'
import type { PublicationHead } from '../../shared/publication'
import type { Job } from '../../shared/types'
import { FICTIONAL_COMMIT, GENERATION_ONE, GENERATION_THREE, GENERATION_TWO } from '../fixtures/publication'
import { ACCEPTANCE_PROFILE, acceptanceDays, CAPACITY_NOW, CAPACITY_TIME, collectCapacity, expectedServedJob, validateAcceptanceProfile } from './helpers/capacity-fixture'
import type { CapacityCollection } from './helpers/capacity-fixture'
import { bindOwnedRuntime, cooperativeForEach, finalizeCase, Inspector, InspectorAcquisitionError, nativeCapacityMode, recheckRuntime, requireUsableMemory, validateOwnedEndpoints } from './helpers/instrumentation'
import type { CleanupStep, HeapSample, OwnedRuntime } from './helpers/instrumentation'
import { SamplerProcess } from './helpers/memory-sampler-process'
import { authorized, contractClient, decodedBody, freezeClock, HeldRequestAcquisitionError, HttpObservation, jsonBody, observedMetrics, openHeldRequest, rawRequest, removePhantomPayload, setPhantomPayload, storeState, StreamRegistry, wipeStore } from './helpers/worker-http'
import type { HeldRequest } from './helpers/worker-http'

// A test-scoped owner exists before beforeEach and is finalized even when that
// hook fails. No mutable global request/case selector is used by HTTP callbacks.
const test = baseTest.extend<{ httpObservation: HttpObservation }>({
  httpObservation: [async ({}, use, info) => {
    const observation = new HttpObservation(info.testId)
    let primary: { error: unknown } | null = null
    try { await use(observation) } catch (error) { primary = { error } }
    await finalizeCase(info, 'capacity-http-observation', { httpObservation: observation.evidence }, primary, [
      { label: 'observation-completeness', run: async () => { observation.assertHealthy(); return observation.evidence.observedCounts } },
    ])
  }, { auto: true }],
})

/**
 * Stage82 common design v2 §검증 6 and §인증과 한도: the literal acceptance
 * workload (130 employers × 50 postings = 6,500 served postings with 3,500-
 * character descriptions and 90 daily observations, 2026-07-06 through
 * 2026-10-03) on the actual local workerd/SQLite runtime. The profile is
 * validated before collection and cannot be reduced by the environment
 * (ACR82-1). Expected content, status and source times come from the fictional
 * input and the frozen clocks, never from the Worker's projection code; response
 * limits are checked on complete decoded HTTP bodies (ACR82-2).
 *
 * Measurements are attributable: the inspector is bound to this run's owned
 * launch, the pinned Wrangler proxy envelope, the exact owned endpoint and the
 * isolate nonce the test entry serves (ACR82-3); heap fields are raw with
 * explicit absence, phase-correlated with live (not only post-GC) samples and
 * owned-process RSS (ACR82-4); every socket, subprocess and sampler is bounded
 * and owned (ACR82-5); and evidence, cleanup outcomes and failures survive an
 * early assertion failure (ACR82-8). Nothing here is a runtime pass: the
 * combined evidence is judged later by Main and Astra with independent results.
 */
const KiB = 1024
const MiB = 1024 * 1024
const LIMITS = {
  chunk: 1 * MiB, compressed: 64 * MiB, manifest: 512 * KiB, storage: 512 * MiB,
  catalog: 128 * MiB, posting: 64 * MiB, observations: 16 * MiB, streams: 8, chunks: 64,
  workerCpuPerRequestMicros: 10_000, durableObjectCpuMicros: 30_000_000, isolateMemoryBytes: 128 * MiB,
} as const
const SUPPLEMENTAL_GROWTH_BOUND = 64 * MiB
const T = (time: string) => `2026-10-03T${time}Z`
const ENDPOINTS = validateOwnedEndpoints(process.env.ORBIT_WORKER_TEST_BASE_URL ?? 'http://127.0.0.1:8790', process.env.ORBIT_WORKER_INSPECTOR_PORT ?? '9230')
let collection: CapacityCollection
let built: BuiltPublication
let expectedDays: string[]
test.beforeAll(async () => {
  // The acceptance profile is literal and validated before the expensive collection; the environment cannot reduce it.
  validateAcceptanceProfile({ ...ACCEPTANCE_PROFILE })
  expectedDays = acceptanceDays()
  expect(expectedDays).toHaveLength(90)
  expect(expectedDays[0]).toBe('2026-07-06')
  expect(expectedDays.at(-1)).toBe('2026-10-03')
  collection = await collectCapacity(ACCEPTANCE_PROFILE)
  expect(collection.totalJobs).toBe(6500)
  built = buildPublication(collection.capture, FICTIONAL_COMMIT, null, GENERATION_ONE)
})
const compressedBytes = (publication: BuiltPublication) => publication.chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)
const fragmentBytes = (publication: BuiltPublication, names: string[]) => names.reduce((sum, name) => sum + publication.manifest.fragments[name].decodedBytes, 0)
const metricsOf = (origin: string) => contractClient(origin).metrics()
const sameSet = (left: Iterable<string>, right: Iterable<string>) => {
  const a = [...left].sort()
  const b = [...right].sort()
  return a.length === b.length && a.every((value, index) => value === b[index])
}
const companyIds = () => collection.companies.map(company => company.id)
const fixtureIdsOf = (companyId: string) => [...collection.jobsById.values()].filter(job => job.companyId === companyId).map(job => job.id)
async function isolateNonce(origin: string): Promise<string> {
  const identity = jsonBody(await rawRequest(origin, '/__test/identity')) as { isolateNonce?: unknown }
  if (typeof identity.isolateNonce !== 'string' || !identity.isolateNonce) throw new Error('The test entry serves no isolate nonce')
  return identity.isolateNonce
}
/**
 * Independently authored request-time freshness (MCR82-R12/ACR82-R03-6). The
 * fixture capture is 06:00. The design rule is literal here: ordinary sources are
 * fresh for 30 minutes (until 06:30) and the two daily sources, himalayas and
 * careers, for 24 hours. A body rendered at 06:05 is all fresh; a body rendered
 * at 07:05 has every ordinary board stale (and the catalog flag stale) while the
 * daily boards remain fresh. Nothing below calls the product's freshness or
 * projection code; the provider comes from the fictional input.
 */
const DAILY_SOURCES = ['himalayas', 'careers']
interface FreshnessExpectation { requestClock: string; board: (provider: string) => 'fresh' | 'stale'; catalogStale: boolean }
const FRESH_AT_0605: FreshnessExpectation = { requestClock: CAPACITY_NOW, board: () => 'fresh', catalogStale: false }
const MIXED_AT_0705: FreshnessExpectation = { requestClock: T('07:05:00.000'), board: provider => DAILY_SOURCES.includes(provider) ? 'fresh' : 'stale', catalogStale: true }
const providerOf = (companyId: string) => collection.companies.find(company => company.id === companyId)?.provider ?? 'greenhouse'
/** Substantive, input-derived checks of a complete decoded catalog body at the caller's request-start clock. */
async function expectCatalogContent(body: Buffer, head: PublicationHead, label: string, freshness: FreshnessExpectation, expectedPublishedAt = CAPACITY_NOW) {
  const catalog = JSON.parse(body.toString('utf8')) as Record<string, any>
  expect(isPublicCatalog(catalog), `${label}: public catalog shape`).toBe(true)
  expect(sameSet(catalog.companies.map((company: { id: string }) => company.id), companyIds()), `${label}: companies`).toBe(true)
  expect(catalog.fetchedAt, `${label}: fetchedAt is the fixture capture time`).toBe(CAPACITY_TIME)
  expect(catalog.checkedAt, `${label}: checkedAt is the fixture capture time`).toBe(CAPACITY_TIME)
  expect(catalog.stale, `${label}: catalog stale flag at ${freshness.requestClock}`).toBe(freshness.catalogStale)
  expect(catalog.unmappedCount, `${label}: unmapped`).toBe(0)
  expect(catalog.publication).toEqual({ mode: 'scheduled', generation: head.generation, publishedAt: head.publishedAt, intervalMinutes: 30 })
  expect(head.publishedAt, `${label}: published under the frozen clock`).toBe(expectedPublishedAt)
  expect(catalog.boards.length, `${label}: boards`).toBe(130)
  expect(sameSet(catalog.boards.map((board: { companyId: string }) => board.companyId), companyIds()), `${label}: exact board identities`).toBe(true)
  await cooperativeForEach(catalog.boards as { companyId: string; status: string; dataStatus: string; total: number; included: number; lastSuccessAt: string | null; checkedAt?: string }[], board => {
    expect({ status: board.status, dataStatus: board.dataStatus, total: board.total, included: board.included, lastSuccessAt: board.lastSuccessAt, checkedAt: board.checkedAt }, `${label}: ${board.companyId} at ${freshness.requestClock}`)
      .toEqual({ status: 'ok', dataStatus: freshness.board(providerOf(board.companyId)), total: 50, included: 50, lastSuccessAt: CAPACITY_TIME, checkedAt: CAPACITY_TIME })
  })
  const jobs = catalog.jobs as Job[]
  expect(jobs.length, `${label}: served postings`).toBe(ACCEPTANCE_PROFILE.servedJobs)
  const seen = new Set<string>()
  await cooperativeForEach(jobs, served => {
    const fixture = collection.jobsById.get(served.id)
    expect(fixture, `${label}: unknown posting ${served.id}`).toBeDefined()
    expect(seen.has(served.id), `${label}: duplicate posting ${served.id}`).toBe(false)
    seen.add(served.id)
    expect(expectedServedJob(served), `${label}: content of ${served.id}`).toEqual(expectedServedJob(fixture!))
    expect(served.description.length, `${label}: description length of ${served.id}`).toBe(ACCEPTANCE_PROFILE.descriptionChars)
    expect(served.fetchedAt, `${label}: fetchedAt of ${served.id}`).toBe(CAPACITY_TIME)
    expect(served.stale, `${label}: stale of ${served.id} at ${freshness.requestClock}`).toBe(freshness.board(providerOf(served.companyId)) === 'stale')
  })
  return catalog
}
async function expectPostingContent(index: Record<string, any>, label: string) {
  expect(PostingStatusIndexSchema.safeParse(index).success, `${label}: schema`).toBe(true)
  expect(index.version).toBe(2)
  expect(index.checkedAt).toBe(CAPACITY_TIME)
  expect(index.boards).toHaveLength(130)
  expect(sameSet(index.boards.map((board: { companyId: string }) => board.companyId), companyIds()), `${label}: exact board identities`).toBe(true)
  await cooperativeForEach(index.boards as { companyId: string; status: string; checkedAt: string; lastSuccessAt: string | null; listing?: { publishedIds: string[]; jobs: { id: string; title: string; url: string }[]; validUntil: string } }[], async board => {
    expect({ status: board.status, checkedAt: board.checkedAt, lastSuccessAt: board.lastSuccessAt }, `${label}: ${board.companyId}`).toEqual({ status: 'ok', checkedAt: CAPACITY_TIME, lastSuccessAt: CAPACITY_TIME })
    expect(board.listing, `${label}: ${board.companyId} listing`).toBeDefined()
    expect(sameSet(board.listing!.publishedIds, fixtureIdsOf(board.companyId)), `${label}: ${board.companyId} publishedIds`).toBe(true)
    expect(board.listing!.jobs.length, `${label}: ${board.companyId} listed bodies`).toBe(50)
    expect(sameSet(board.listing!.jobs.map(job => job.id), fixtureIdsOf(board.companyId)), `${label}: exact listed identities`).toBe(true)
    await cooperativeForEach(board.listing!.jobs, listed => {
      const fixture = collection.jobsById.get(listed.id)
      expect(fixture, `${label}: known listed job ${listed.id}`).toBeDefined()
      expect(fixture!.companyId, `${label}: board membership of ${listed.id}`).toBe(board.companyId)
      expect({ title: listed.title, url: listed.url }, `${label}: ${listed.id}`).toEqual({ title: fixture!.title, url: fixture!.url })
    })
    expect(Number.isFinite(Date.parse(board.listing!.validUntil))).toBe(true)
  })
}
async function expectObservationContent(history: Record<string, any>, label: string) {
  expect(ObservationHistorySchema.safeParse(history).success, `${label}: schema`).toBe(true)
  expect(history.storage).toBe('ok')
  expect(sameSet(history.scope.boards.map((board: { companyId: string }) => board.companyId), companyIds()), `${label}: scope`).toBe(true)
  expect(history.days.map((day: { day: string }) => day.day).sort(), `${label}: the 90 literal days`).toEqual([...expectedDays].sort())
  await cooperativeForEach(history.days as { day: string; latest: { boards: { companyId: string; status: string }[]; observedAt: string }; complete?: { stats: { published: number } } }[], day => {
    expect(day.latest.boards.length, `${label}: ${day.day} boards`).toBe(130)
    expect(sameSet(day.latest.boards.map(board => board.companyId), companyIds()), `${label}: ${day.day} exact boards`).toBe(true)
    expect(day.latest.boards.every(board => board.status === 'complete'), `${label}: ${day.day} all complete`).toBe(true)
    expect(day.latest.observedAt, `${label}: ${day.day} observed at the daily run`).toBe(`${day.day}T06:00:00.000Z`)
    expect(day.complete?.stats.published, `${label}: ${day.day} published`).toBe(ACCEPTANCE_PROFILE.servedJobs)
  })
}
const heapView = (sample: HeapSample) => ({
  at: sample.at, phase: sample.phase, isolateId: sample.isolateId, usedSize: sample.usedSize, totalSize: sample.totalSize,
  embedderHeapUsedSize: sample.embedderHeapUsedSize, backingStorageSize: sample.backingStorageSize, raw: sample.raw,
})
/** Supplemental post-GC growth between two samples; each field is compared only with itself and only when present in both. */
function supplementalGrowth(from: HeapSample, to: HeapSample) {
  const backing = from.backingStorageSize.present && to.backingStorageSize.present ? to.backingStorageSize.value - from.backingStorageSize.value : null
  const embedder = from.embedderHeapUsedSize.present && to.embedderHeapUsedSize.present ? to.embedderHeapUsedSize.value - from.embedderHeapUsedSize.value : null
  return { usedSizeGrowth: to.usedSize - from.usedSize, totalSizeGrowth: to.totalSize - from.totalSize, backingStorageGrowth: backing, embedderHeapGrowth: embedder, bound: SUPPLEMENTAL_GROWTH_BOUND, note: 'supplemental post-GC comparison; not proof of the 128 MiB live peak criterion' }
}
const MEASUREMENT_LIMITS = {
  usedSize: 'used V8 heap bytes of the inspected isolate (inside totalSize)',
  totalSize: 'allocated V8 heap bytes of the inspected isolate',
  embedderHeapUsedSize: 'CppHeap bytes when reported; a reported 0 is valid and distinct from absence',
  backingStorageSize: 'V8 external backing-store accounting when reported; not all native memory',
  processRss: 'resident set size of this run\'s registered workerd processes by role; context, not a bound on provider-charged isolate memory',
  cpuProfile: 'local V8 sampling profile through the Wrangler proxy; not production CPU, which Main measures separately (10 ms Worker / 30 s DO criteria unchanged)',
}

/** Keep obtained acquisition data even if connect throws before returning a client. */
function retainAcquisitionFailure(evidence: Record<string, unknown>, error: unknown): void {
  if (error instanceof InspectorAcquisitionError) {
    evidence.inspectorAcquisitionFailure = { primary: String(error.primary), acquisition: error.acquisition, cleanup: error.cleanup, instrumentation: error.instrumentation }
  }
}
/** Start every owner before awaiting any of them, including a pre-measurement failure. */
function inspectorCleanup(
  inspector: Inspector | undefined, evidence: Record<string, unknown>, streams?: StreamRegistry,
  drains?: Promise<PromiseSettledResult<Buffer>>[],
): CleanupStep[] {
  const settle = () => Promise.allSettled([
    Promise.resolve().then(() => streams?.cleanupAll()),
    Promise.resolve().then(() => inspector?.cleanupProfile()),
    Promise.resolve().then(() => inspector?.cleanupGcHttp()),
    Promise.resolve().then(() => Promise.all(drains ?? [])),
  ] as const)
  let preclose: ReturnType<typeof settle> | undefined
  const prepare = () => preclose ??= settle()
  return [
    ...(streams ? [{ label: 'streams', run: async () => {
      const [result, profile, http, drain] = await prepare()
      evidence.inspectorPreclose = {
        configuredAllowanceMs: 12000, composition: 'max(12000,3000,3000)', withInspectorCloseMs: 17000,
        acquired: { inspector: Boolean(inspector), streams: streams.streams.length },
        streams: result.status, profile: profile.status, gcHttp: http.status, pendingDrains: drain.status,
      }
      // Retain every settled outcome before reporting any one of its failures.
      if (profile.status === 'fulfilled') evidence.profileCleanup = profile.value ?? 'not acquired'
      else evidence.profileCleanupFailure = String(profile.reason)
      if (http.status === 'fulfilled') evidence.gcHttpCleanup = http.value ?? 'not acquired'
      else evidence.gcHttpCleanupFailure = String(http.reason)
      if (drain.status === 'fulfilled') evidence.drainOutcomes = drain.value.map(outcome => outcome.status === 'fulfilled' ? { status: outcome.status, bytes: outcome.value.length } : { status: outcome.status, reason: String(outcome.reason) })
      else evidence.drainCleanupFailure = String(drain.reason)
      if (result.status === 'rejected') { evidence.streamCleanupFailure = String(result.reason); throw result.reason }
      evidence.streamCleanup = { opened: streams.streams.length, ...result.value }
      if (!result.value || result.value.failures.length || result.value.outcomes.some(item => !item.outcome?.confirmed)) {
        throw new Error(`Stream cleanup: ${result.value?.failures.join('; ') ?? 'missing owned result'}`)
      }
      return evidence.streamCleanup
    } }] : []),
    ...(drains ? [{ label: 'pending-drains', run: async () => {
      const [, , , result] = await prepare()
      if (result.status === 'rejected') throw result.reason
      evidence.drainOutcomes = result.value.map(outcome => outcome.status === 'fulfilled' ? { status: outcome.status, bytes: outcome.value.length } : { status: outcome.status, reason: String(outcome.reason) })
      const failed = result.value.filter((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected')
      if (failed.length) throw new AggregateError(failed.map(outcome => outcome.reason), 'Owned stream drains rejected')
      return evidence.drainOutcomes
    } }] : []),
    { label: 'inspector-profile', run: async () => {
      if (!inspector) return 'not acquired'
      const [, result, http] = await prepare()
      // Preserve both outcomes immediately even if either reporting step throws.
      evidence.inspectorPreclose ??= { configuredAllowanceMs: 12000, composition: 'max(12000,3000,3000)', withInspectorCloseMs: 17000, profile: result.status, gcHttp: http.status }
      if (http.status === 'fulfilled') evidence.gcHttpCleanup = http.value
      else evidence.gcHttpCleanupFailure = String(http.reason)
      if (result.status === 'rejected') { evidence.profileCleanupFailure = String(result.reason); throw result.reason }
      const outcome = result.value
      if (!outcome) throw new Error('Missing owned profiler cleanup result')
      evidence.profileCleanup = outcome
      evidence.inspectorAfterProfileCleanup = inspector.evidence()
      if (!outcome.confirmed || outcome.failures.length) throw new Error(`Profiler cleanup: ${outcome.failures.join('; ')}`)
      return outcome
    } },
    { label: 'inspector-gc-http', run: async () => {
      if (!inspector) return 'not acquired'
      const [, , result] = await prepare()
      if (result.status === 'rejected') throw result.reason
      const outcome = result.value
      if (!outcome) throw new Error('Missing owned GC HTTP cleanup result')
      evidence.gcHttpCleanup = outcome
      if (outcome.failures.length || outcome.outcomes.some(item => !item.confirmed)) throw new Error(`GC HTTP cleanup: ${outcome.failures.join('; ')}`)
      return outcome
    } },
    { label: 'inspector-close', run: async () => {
      if (!inspector) return 'not acquired'
      const outcome = await inspector.close()
      evidence.inspectorClosure = outcome
      evidence.inspectorFinal = inspector.evidence()
      if (!outcome.confirmed || outcome.errors?.length) throw new Error(`Inspector closure: ${outcome.reason}; ${(outcome.errors ?? []).join('; ')}`)
      return outcome
    } },
  ]
}

test.beforeEach(async ({ baseURL, httpObservation }) => {
  await wipeStore(baseURL!, httpObservation.scope('store-reset', 'beforeEach'))
  await freezeClock(baseURL!, CAPACITY_NOW)
})

test('the literal acceptance publication stays under every cap: manifest/chunk/compressed/storage by construction, private checkpoint files by complete decoded bytes', async ({ baseURL }, info) => {
  const origin = baseURL!
  const evidence: Record<string, unknown> = { profile: ACCEPTANCE_PROFILE, limits: LIMITS, measurementLimits: MEASUREMENT_LIMITS }
  const phantomOwner = '94d424f7-b676-47bb-8170-66f3783e5b14'
  let phantomAttempted = false
  let primary: { error: unknown } | null = null
  try {
    const manifestBytes = Buffer.byteLength(built.manifestText)
    evidence.publication = {
      companies: collection.companies.length, totalJobs: collection.totalJobs, observationDays: built.manifest.observations.days.length, dailyCollectionRunMs: collection.runMs,
      manifestBytes, chunks: built.chunks.length, compressedBytes: compressedBytes(built),
      storageDiagnostics: {
        note: 'storage-side totals of every retained fragment variant (fresh and stale, listing and old body); NOT a served response size',
        catalogFragmentBytes: fragmentBytes(built, built.manifest.catalog.boards.flatMap(board => [board.fresh, board.stale].filter((name): name is string => name !== null))),
        postingFragmentBytes: fragmentBytes(built, built.manifest.posting.boards.flatMap(board => [board.listing, board.oldBody].filter((name): name is string => name !== null))),
        observationFragmentBytes: fragmentBytes(built, built.manifest.observations.days.map(day => day.fragment)),
        threeResidentPublicationsBytes: compressedBytes(built) * 3,
      },
    }
    expect(collection.companies).toHaveLength(130)
    expect(built.manifest.capture.companies).toHaveLength(130)
    expect(built.manifest.observations.days.map(day => day.day)).toEqual(expectedDays)
    expect(built.manifest.catalog.boards).toHaveLength(130)
    expect(built.manifest.posting.boards).toHaveLength(130)
    expect(manifestBytes).toBeLessThanOrEqual(LIMITS.manifest)
    expect(compressedBytes(built)).toBeLessThanOrEqual(LIMITS.compressed)
    expect(built.chunks.length).toBeLessThanOrEqual(LIMITS.chunks)
    for (const chunk of built.chunks) expect(chunk.byteLength).toBeLessThanOrEqual(LIMITS.chunk)
    expect(compressedBytes(built) * 3).toBeLessThan(LIMITS.storage)
    const before = await metricsOf(origin)
    evidence.sqlBefore = before
    const started = performance.now()
    const head = await contractClient(origin).publish(built)
    const publishMs = Math.round(performance.now() - started)
    const after = await metricsOf(origin)
    evidence.sqlAfter = after
    // C3: a native-counter epoch reset or replacement cannot satisfy the
    // original 2*N+12/48-per-day criteria with a negative or artificially small delta.
    expect(before.instance).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/)
    expect(after.instance).toBe(before.instance)
    expect(after.rowsWritten).toBeGreaterThanOrEqual(before.rowsWritten)
    expect(after.rowsRead).toBeGreaterThanOrEqual(before.rowsRead)
    evidence.sql = {
      scope: 'native cursor billing recorded by product SQL instrumentation; direct harness SQL and logical deletion counts are separate',
      instance: before.instance,
      publishMs, rowsWrittenDelta: after.rowsWritten - before.rowsWritten, rowsReadDelta: after.rowsRead - before.rowsRead,
      payloadBytes: after.payloadBytes, databaseBytes: after.databaseBytes, chunks: after.chunks, generations: after.generations, metadataOverheadBytes: after.databaseBytes - after.payloadBytes,
    }
    expect(head.revision).toBe(1)
    expect(head.publishedAt).toBe(CAPACITY_NOW)
    expect(after.payloadBytes).toBe(compressedBytes(built))
    expect(after.chunks).toBe(built.chunks.length)
    // One publication writes staging, one row per chunk plus its touch, the generation and the meta row: bounded, far below the daily 100,000 write allowance even at 48 publications/day.
    expect(after.rowsWritten - before.rowsWritten).toBeLessThanOrEqual(2 * built.chunks.length + 12)
    expect((after.rowsWritten - before.rowsWritten) * 48).toBeLessThan(100_000)
    expect(after.databaseBytes).toBeLessThan(2 * after.payloadBytes + 16 * MiB)
    // The private checkpoint round-trips through the real client; its complete decoded files carry every fictional board and respect the private limits.
    const files = await contractClient(origin).checkpoint(head, built.manifest)
    evidence.checkpointBytes = { boards: files.boards.byteLength, presence: files.presence.byteLength, observations: files.observations.byteLength, limits: { boards: LIMITS.catalog, presence: LIMITS.posting, observations: LIMITS.observations } }
    expect(files.boards.byteLength).toBeLessThanOrEqual(LIMITS.catalog)
    expect(files.presence.byteLength).toBeLessThanOrEqual(LIMITS.posting)
    expect(files.observations.byteLength).toBeLessThanOrEqual(LIMITS.observations)
    const boards = JSON.parse(Buffer.from(files.boards).toString('utf8')) as { version: number; boards: { companyId: string; snapshot?: { fetchedAt: string; jobs: Job[] } }[] }
    expect(boards.version).toBe(5)
    expect(sameSet(boards.boards.map(board => board.companyId), companyIds())).toBe(true)
    for (const board of boards.boards) {
      expect(board.snapshot?.fetchedAt, board.companyId).toBe(CAPACITY_TIME)
      expect(board.snapshot?.jobs.length, board.companyId).toBe(50)
      expect(sameSet(board.snapshot!.jobs.map(job => job.id), fixtureIdsOf(board.companyId)), `${board.companyId}: exact checkpoint job identities`).toBe(true)
      for (const job of board.snapshot!.jobs) {
        expect(job.companyId, job.id).toBe(board.companyId)
        expect(expectedServedJob(job), job.id).toEqual(expectedServedJob(collection.jobsById.get(job.id)!))
      }
    }
    // Exact checkpoint round-trip compares with the collector input, then
    // literal identities/times independently rule out incomplete private files.
    const presence = JSON.parse(Buffer.from(files.presence).toString('utf8')) as { version: number; boards: { companyId: string; checkedAt: string; snapshot?: { fetchedAt: string; total: number; publishedIds: string[] } }[] }
    expect(presence).toEqual({ version: 1, boards: collection.capture.presences })
    expect(sameSet(presence.boards.map(board => board.companyId), companyIds())).toBe(true)
    for (const board of presence.boards) {
      expect(board.checkedAt, board.companyId).toBe(CAPACITY_TIME)
      expect(board.snapshot, board.companyId).toMatchObject({ fetchedAt: CAPACITY_TIME, total: 50 })
      expect(sameSet(board.snapshot!.publishedIds, fixtureIdsOf(board.companyId)), board.companyId).toBe(true)
    }
    const privateObservations = JSON.parse(Buffer.from(files.observations).toString('utf8')) as { version: number; series: { scope: { boards: { companyId: string }[] }; days: { day: string }[] }[] }
    expect(privateObservations).toEqual(collection.capture.observationCheckpoint)
    expect(privateObservations.version).toBe(1)
    expect(privateObservations.series).toHaveLength(1)
    expect(sameSet(privateObservations.series[0].scope.boards.map(board => board.companyId), companyIds())).toBe(true)
    expect(privateObservations.series[0].days.map(day => day.day).sort()).toEqual([...expectedDays].sort())
    // C1 logical cleanup, after the native publication billing interval above:
    // a real generation cannot satisfy ZERO_HASH, one owned phantom is removed
    // exactly once, and a second DELETE observes no remaining owned key rows.
    const protectedReal = await removePhantomPayload(origin, GENERATION_ONE)
    evidence.realOwnerDeletion = protectedReal
    expect(protectedReal.removed).toEqual({ chunks: 0, generations: 0 })
    expect(protectedReal.payloadBytes).toBe(compressedBytes(built))
    phantomAttempted = true
    evidence.phantomCreated = await setPhantomPayload(origin, phantomOwner, 17)
    expect(await metricsOf(origin)).toMatchObject({ chunks: built.chunks.length + 1, generations: 2, payloadBytes: compressedBytes(built) + 17 })
    const removed = await removePhantomPayload(origin, phantomOwner)
    evidence.phantomRemoved = removed
    expect(removed.removed).toEqual({ chunks: 1, generations: 1 })
    expect(removed.payloadBytes).toBe(compressedBytes(built))
    expect(Number.isSafeInteger(removed.nativeRowsWritten.chunks)).toBe(true)
    expect(Number.isSafeInteger(removed.nativeRowsWritten.generations)).toBe(true)
    expect(removed.nativeRowsWritten.chunks).toBeGreaterThan(0)
    expect(removed.nativeRowsWritten.generations).toBeGreaterThan(0)
    const repeated = await removePhantomPayload(origin, phantomOwner)
    evidence.phantomRepeatedDelete = repeated
    expect(repeated.removed).toEqual({ chunks: 0, generations: 0 })
    expect(repeated.payloadBytes).toBe(compressedBytes(built))
    const remaining = await metricsOf(origin)
    evidence.afterLogicalCleanup = remaining
    expect(remaining).toMatchObject({ chunks: built.chunks.length, generations: 1, payloadBytes: compressedBytes(built) })
    expect((await contractClient(origin).head()).head).toEqual(head)
  } catch (error) {
    primary = { error }
  }
  await finalizeCase(info, 'capacity-publication', evidence, primary, [
    { label: 'owned-phantom-cleanup', run: async () => {
      if (!phantomAttempted) return 'not attempted'
      const removed = await removePhantomPayload(origin, phantomOwner)
      const absent = await removePhantomPayload(origin, phantomOwner)
      evidence.finalPhantomCleanup = { removed, absent }
      expect(absent.removed).toEqual({ chunks: 0, generations: 0 })
      expect(absent.payloadBytes).toBe(compressedBytes(built))
      return { removed, absent }
    } },
  ])
})

test('the acceptance catalog streams byte-identical in every encoding with input-derived content, complete-body limits, attributable CPU profiles and live heap samples', async ({ baseURL, httpObservation }, info) => {
  const origin = baseURL!
  const evidence: Record<string, unknown> = { profile: ACCEPTANCE_PROFILE, limits: LIMITS, measurementLimits: MEASUREMENT_LIMITS, heap: [] as unknown[], profiles: {} as Record<string, unknown> }
  const heap = evidence.heap as ReturnType<typeof heapView>[]
  const profiles = evidence.profiles as Record<string, unknown>
  const streams = new StreamRegistry(httpObservation)
  let runtime: OwnedRuntime | undefined
  let inspector: Inspector | undefined
  let sampler: SamplerProcess | undefined
  let primary: { error: unknown } | null = null
  try {
    const head = await contractClient(origin).publish(built)
    runtime = await bindOwnedRuntime(ENDPOINTS)
    evidence.runtime = { registryPath: runtime.registryPath, listeners: runtime.listeners, workerd: runtime.workerd }
    const nonce = await isolateNonce(origin)
    evidence.inspectorAttempt = { endpoints: ENDPOINTS, isolateNonce: nonce }
    inspector = await Inspector.connect(ENDPOINTS, { isolateNonce: nonce, native: nativeCapacityMode(runtime, 'encoding-cpu') })
    evidence.inspector = inspector.evidence()
    sampler = new SamplerProcess(runtime, info.outputPath(`owned-memory-streaming-${randomUUID()}.json`))
    evidence.samplerOwner = sampler.evidence
    await sampler.start()
    await sampler.phase('idle')
    heap.push(heapView(await inspector.heapUsage('idle')))
    // Identity body: live sample while the first stream is being decoded, then the complete body.
    await sampler.phase('decode-in-progress')
    await inspector.startProfile()
    const startedIdentity = performance.now()
    const slow = streams.open(origin, '/api/catalog', { 'Accept-Encoding': 'identity' }, 'identity-catalog', 'decode-in-progress')
    await slow.ready
    expect(slow.status).toBe(200)
    heap.push(heapView(await inspector.heapUsage('decode-in-progress')))
    const identityBody = await slow.finish()
    const identityMs = Math.round(performance.now() - startedIdentity)
    const identityProfile = await inspector.stopProfile()
    profiles.identity = { summary: identityProfile.summary, raw: identityProfile.raw }
    expect(slow.headers['content-encoding']).toBeUndefined()
    expect(identityBody.length, 'complete decoded catalog body within the public catalog limit').toBeLessThanOrEqual(LIMITS.catalog)
    const catalog = await expectCatalogContent(identityBody, head, 'identity', FRESH_AT_0605)
    await sampler.phase('encodings')
    await inspector.startProfile()
    const startedGzip = performance.now()
    const gzipped = await rawRequest(origin, '/api/catalog', { headers: { 'Accept-Encoding': 'gzip' }, timeoutMs: 900_000 })
    const gzipMs = Math.round(performance.now() - startedGzip)
    const gzipProfile = await inspector.stopProfile()
    profiles.gzip = { summary: gzipProfile.summary, raw: gzipProfile.raw }
    expect(gzipped.status).toBe(200)
    expect(gzipped.headers['content-encoding']).toBe('gzip')
    expect(decodedBody(gzipped).equals(identityBody), 'gzip body equals identity body').toBe(true)
    const startedBrotli = performance.now()
    const brotli = await rawRequest(origin, '/api/catalog', { headers: { 'Accept-Encoding': 'br' }, timeoutMs: 900_000 })
    const brotliMs = Math.round(performance.now() - startedBrotli)
    expect(brotli.status).toBe(200)
    expect(brotli.headers['content-encoding']).toBe('br')
    expect(decodedBody(brotli).equals(identityBody), 'brotli body equals identity body').toBe(true)
    expect(gzipped.headers.etag).toBe(slow.headers.etag)
    expect(brotli.headers.etag).toBe(slow.headers.etag)
    const posting = await rawRequest(origin, '/api/posting-status', { headers: { 'Accept-Encoding': 'identity' }, timeoutMs: 900_000 })
    expect(posting.status).toBe(200)
    expect(posting.headers['content-encoding']).toBeUndefined()
    const postingBytes = decodedBody(posting)
    expect(postingBytes.length, 'complete decoded posting-status body within the public limit').toBeLessThanOrEqual(LIMITS.posting)
    await expectPostingContent(jsonBody(posting) as Record<string, any>, 'posting-status')
    const observations = await rawRequest(origin, '/api/observations', { headers: { 'Accept-Encoding': 'identity' }, timeoutMs: 900_000 })
    expect(observations.status).toBe(200)
    expect(observations.headers['content-encoding']).toBeUndefined()
    const observationBytes = decodedBody(observations)
    expect(observationBytes.length, 'complete decoded observations body within the public limit').toBeLessThanOrEqual(LIMITS.observations)
    await expectObservationContent(jsonBody(observations) as Record<string, any>, 'observations')
    await sampler.phase('after-gc')
    await inspector.collectGarbage()
    heap.push(heapView(await inspector.heapUsage('after-gc')))
    evidence.bodies = { catalogBytes: identityBody.length, gzipWireBytes: gzipped.body.length, brotliWireBytes: brotli.body.length, postingBytes: postingBytes.length, postingWireBytes: posting.body.length, observationsBytes: observationBytes.length, observationsWireBytes: observations.body.length, jobs: catalog.jobs.length }
    evidence.wallMs = { identity: identityMs, gzip: gzipMs, brotli: brotliMs }
    evidence.continuity = { contextClears: inspector.events.contextClears, closes: inspector.events.closes, protocolErrors: inspector.events.protocolErrors, runtimeProblems: await recheckRuntime(runtime) }
    expect(inspector.events.contextClears, 'no execution-context clear (reload) during the measured phases').toBe(0)
    expect(inspector.events.protocolErrors).toEqual([])
    expect((evidence.continuity as { runtimeProblems: string[] }).runtimeProblems).toEqual([])
    // Hard local bounds; the production per-request CPU is measured separately by Main.
    expect(identityProfile.summary.busyMicros).toBeGreaterThan(0)
    expect(identityProfile.summary.busyMicros).toBeLessThan(LIMITS.durableObjectCpuMicros)
    expect(gzipProfile.summary.busyMicros).toBeGreaterThan(0)
    expect(gzipProfile.summary.busyMicros).toBeLessThan(LIMITS.durableObjectCpuMicros)
    for (const sample of heap) expect(sample.usedSize, `${sample.phase} usedSize`).toBeLessThan(LIMITS.isolateMemoryBytes)
    expect(identityMs).toBeLessThan(600_000)
  } catch (error) {
    retainAcquisitionFailure(evidence, error)
    primary = { error }
  }
  await finalizeCase(info, 'capacity-streaming', evidence, primary, [
    ...inspectorCleanup(inspector, evidence, streams),
    { label: 'sampler-stop', run: async () => {
      if (!sampler) return 'not started'
      const outcome = await sampler.stop(Boolean(primary))
      evidence.ownedProcessMemory = outcome.summary ?? outcome.rawSummary
      await sampler.attach(info, 'capacity-streaming-owned-memory-terminal')
      sampler.assertComplete(outcome)
      const summary = outcome.summary!
      // The same usable-sample check as the eight-stream case (MCR82-R11): command errors, invalid RSS, lost identities or no valid sample invalidate the interval.
      requireUsableMemory(summary)
      return { samples: summary.sampleCount, validSamples: summary.validSampleCount, skippedTicks: summary.skippedTicks, peakRssKiBByPid: summary.peakRssKiBByPid }
    } },
    { label: 'runtime-recheck', run: async () => { if (!runtime) return 'not bound'; const problems = await recheckRuntime(runtime); if (problems.length) throw new Error(problems.join('; ')); return 'identities unchanged' } },
  ])
})

test('eight paused acceptance streams are served while the ninth is refused; live heap, owned-process RSS and lease counters are recorded through decode, hold, drain, cancel and release', async ({ baseURL, httpObservation }, info) => {
  const origin = baseURL!
  const evidence: Record<string, unknown> = { profile: ACCEPTANCE_PROFILE, limits: LIMITS, measurementLimits: MEASUREMENT_LIMITS, heap: [] as unknown[], lease: [] as unknown[] }
  const heap = evidence.heap as ReturnType<typeof heapView>[]
  const lease = evidence.lease as unknown[]
  const streams = new StreamRegistry(httpObservation)
  let phase = 'prepare'
  // Only this case's existing calls use the fetcher seam. Each call captures its
  // own operation/phase; retries remain owned by createPublicationClient.
  const metricsOf = (metricsOrigin: string) => observedMetrics(metricsOrigin, httpObservation.scope('lease-metrics', phase))
  // Observers are attached at finish() creation, before the awaited heap call.
  // Even an intervening measurement failure cannot orphan a rejected drain.
  const drains: Promise<PromiseSettledResult<Buffer>>[] = []
  let runtime: OwnedRuntime | undefined
  let inspector: Inspector | undefined
  let sampler: SamplerProcess | undefined
  let primary: { error: unknown } | null = null
  try {
    const head = await contractClient(origin).publish(built)
    const reference = await rawRequest(origin, '/api/catalog', { headers: { 'Accept-Encoding': 'identity' }, timeoutMs: 900_000, observation: httpObservation.scope('reference-catalog', 'prepare') })
    expect(reference.status).toBe(200)
    expect(reference.headers['content-encoding']).toBeUndefined()
    const expected = reference.body
    evidence.bodyBytes = expected.length
    evidence.generation = head.generation
    expect(expected.length, 'eight fully buffered bodies of this size would exceed the supplemental growth bound').toBeGreaterThanOrEqual(8 * MiB)
    runtime = await bindOwnedRuntime(ENDPOINTS)
    evidence.runtime = { registryPath: runtime.registryPath, listeners: runtime.listeners, workerd: runtime.workerd }
    const nonce = await isolateNonce(origin)
    evidence.inspectorAttempt = { endpoints: ENDPOINTS, isolateNonce: nonce }
    inspector = await Inspector.connect(ENDPOINTS, { isolateNonce: nonce, native: nativeCapacityMode(runtime, 'heap-only') })
    evidence.inspector = inspector.evidence()
    sampler = new SamplerProcess(runtime, info.outputPath(`owned-memory-streams-${randomUUID()}.json`))
    evidence.samplerOwner = sampler.evidence
    await sampler.start()
    await sampler.phase('idle')
    await inspector.collectGarbage()
    const idle = await inspector.heapUsage('idle-after-gc')
    heap.push(heapView(idle))
    await sampler.phase('decode-in-progress')
    phase = 'decode-in-progress'
    const first = streams.open(origin, '/api/catalog', { 'Accept-Encoding': 'identity' }, 'stream-0', phase)
    await first.ready
    expect(first.status).toBe(200)
    heap.push(heapView(await inspector.heapUsage('decode-in-progress')))
    lease.push({ phase: 'decode-in-progress', metrics: await metricsOf(origin) })
    await sampler.phase('eight-held')
    phase = 'eight-held'
    streams.phase(phase)
    for (let index = 1; index < 8; index++) {
      const stream = streams.open(origin, '/api/catalog', { 'Accept-Encoding': index % 2 ? 'gzip' : 'identity' }, `stream-${index}`, phase)
      await stream.ready
      expect(stream.status, `stream ${index}`).toBe(200)
    }
    await expect.poll(async () => (await metricsOf(origin)).activeBodies, { timeout: 30_000 }).toBe(8)
    heap.push(heapView(await inspector.heapUsage('eight-held-live')))
    const busy = await rawRequest(origin, '/api/catalog', { observation: httpObservation.scope('ninth-refused', phase) })
    expect(busy.status).toBe(503)
    expect(jsonBody(busy)).toMatchObject({ code: 'CATALOG_BUSY', retryAt: T('06:06:00.000') })
    expect(busy.headers['retry-after']).toBe('60')
    const headOnly = await rawRequest(origin, '/api/catalog', { method: 'HEAD', observation: httpObservation.scope('head-while-held', phase) })
    expect(headOnly.status).toBe(200)
    expect((await rawRequest(origin, '/api/catalog', { headers: { 'If-None-Match': headOnly.headers.etag! }, observation: httpObservation.scope('cached-while-held', phase) })).status).toBe(304)
    expect((await rawRequest(origin, '/api/health', { observation: httpObservation.scope('health-while-held', phase) })).status).toBe(200)
    const metricsHeld = await metricsOf(origin)
    lease.push({ phase: 'eight-held', metrics: metricsHeld })
    expect(metricsHeld).toMatchObject({ activeBodies: 8, peakBodies: 8, activeGenerations: 8, explicitChunkCacheEntries: 1 })
    expect(metricsHeld.peakExplicitChunkBuffers).toBeLessThanOrEqual(2)
    await inspector.collectGarbage()
    const heldAfterGc = await inspector.heapUsage('eight-held-after-gc')
    heap.push(heapView(heldAfterGc))
    // Drain four: live sample while their bodies are being read, then byte-exactness.
    await sampler.phase('drain')
    phase = 'drain'
    streams.phase(phase, streams.streams.slice(4))
    const finishing = streams.streams.slice(4).map(stream => {
      const pending = stream.finish()
      drains.push(pending.then(value => ({ status: 'fulfilled' as const, value }), reason => ({ status: 'rejected' as const, reason })))
      return pending
    })
    heap.push(heapView(await inspector.heapUsage('drain-in-progress')))
    const bodies = await Promise.all(finishing)
    for (const [index, body] of bodies.entries()) {
      const decoded = (index + 4) % 2 ? decodedBody({ status: 200, headers: { 'content-encoding': 'gzip' }, body }) : body
      expect(decoded.equals(expected), `stream ${index + 4}`).toBe(true)
    }
    phase = 'drained-four'
    await expect.poll(async () => (await metricsOf(origin)).activeBodies, { timeout: 60_000 }).toBe(4)
    const fourHeld = await metricsOf(origin)
    lease.push({ phase: 'drained-four', metrics: fourHeld })
    expect(fourHeld).toMatchObject({ instance: metricsHeld.instance, activeBodies: 4, activeGenerations: 4 })
    // Cancel the other four.
    await sampler.phase('cancel')
    phase = 'cancel'
    streams.phase(phase, streams.streams.slice(0, 4))
    for (const stream of streams.streams.slice(0, 4)) stream.destroy()
    heap.push(heapView(await inspector.heapUsage('cancel-in-progress')))
    await expect.poll(async () => (await metricsOf(origin)).activeBodies, { timeout: 60_000 }).toBe(0)
    await sampler.phase('released')
    phase = 'released'
    streams.phase(phase)
    heap.push(heapView(await inspector.heapUsage('released-live')))
    await inspector.collectGarbage()
    const released = await inspector.heapUsage('released-after-gc')
    heap.push(heapView(released))
    const metricsReleased = await metricsOf(origin)
    lease.push({ phase: 'released', metrics: metricsReleased })
    expect(metricsReleased).toMatchObject({ instance: metricsHeld.instance, activeBodies: 0, activeGenerations: 0 })
    evidence.supplementalGrowth = { idleToHeld: supplementalGrowth(idle, heldAfterGc), idleToReleased: supplementalGrowth(idle, released) }
    evidence.absentHeapFields = { embedderHeapUsedSize: heap.some(sample => !sample.embedderHeapUsedSize.present), backingStorageSize: heap.some(sample => !sample.backingStorageSize.present) }
    evidence.continuity = { contextClears: inspector.events.contextClears, closes: inspector.events.closes, protocolErrors: inspector.events.protocolErrors, runtimeProblems: await recheckRuntime(runtime) }
    evidence.bodyBytes = expected.length
    evidence.generation = head.generation
    expect(inspector.events.contextClears).toBe(0)
    expect(inspector.events.protocolErrors).toEqual([])
    expect((evidence.continuity as { runtimeProblems: string[] }).runtimeProblems).toEqual([])
    for (const sample of heap) expect(sample.usedSize, `${sample.phase} usedSize`).toBeLessThan(LIMITS.isolateMemoryBytes)
    // Supplemental bounded-decoder witness: eight held readers of a ≥ 8 MiB body must not grow the post-GC heap by 64 MiB; each field is compared only with itself.
    const growth = supplementalGrowth(idle, heldAfterGc)
    expect(growth.usedSizeGrowth).toBeLessThan(SUPPLEMENTAL_GROWTH_BOUND)
    if (growth.backingStorageGrowth !== null) expect(growth.backingStorageGrowth).toBeLessThan(SUPPLEMENTAL_GROWTH_BOUND)
    expect(released.usedSize).toBeLessThan(heldAfterGc.usedSize + 32 * MiB)
    const recovery = await rawRequest(origin, '/api/catalog', { headers: { 'Accept-Encoding': 'identity' }, timeoutMs: 900_000, observation: httpObservation.scope('recovery-catalog', 'released') })
    evidence.recovery = { status: recovery.status, wireBytes: recovery.body.length, encoding: recovery.headers['content-encoding'] ?? null }
    expect(recovery.status).toBe(200)
    expect(recovery.headers['content-encoding']).toBeUndefined()
    expect(decodedBody(recovery).equals(expected), 'a complete request succeeds after all eight leases are released').toBe(true)
  } catch (error) {
    retainAcquisitionFailure(evidence, error)
    primary = { error }
  }
  await finalizeCase(info, 'capacity-streams', evidence, primary, [
    ...inspectorCleanup(inspector, evidence, streams, drains),
    { label: 'sampler-stop', run: async () => {
      if (!sampler) return 'not started'
      const outcome = await sampler.stop(Boolean(primary))
      evidence.ownedProcessMemory = outcome.summary ?? outcome.rawSummary
      await sampler.attach(info, 'capacity-streams-owned-memory-terminal')
      sampler.assertComplete(outcome)
      const summary = outcome.summary!
      // Shared usable-sample check (MCR82-R11): command errors, invalid RSS, lost or changed identities or no valid sample invalidate the interval; absence is never a 0 peak.
      requireUsableMemory(summary)
      return { samples: summary.sampleCount, validSamples: summary.validSampleCount, skippedTicks: summary.skippedTicks, peakRssKiBByPid: summary.peakRssKiBByPid }
    } },
    { label: 'runtime-recheck', run: async () => { if (!runtime) return 'not bound'; const problems = await recheckRuntime(runtime); if (problems.length) throw new Error(problems.join('; ')); return 'identities unchanged' } },
  ])
})

test('a retired acceptance generation survives the sweep while pinned by a slow reader and is removed afterwards', async ({ baseURL, httpObservation }, info) => {
  const origin = baseURL!
  const evidence: Record<string, unknown> = { profile: ACCEPTANCE_PROFILE }
  const streams = new StreamRegistry(httpObservation)
  let primary: { error: unknown } | null = null
  try {
    const first = await contractClient(origin).publish(built)
    await freezeClock(origin, T('06:35:00.000'))
    const second = buildPublication(collection.capture, FICTIONAL_COMMIT, first, GENERATION_TWO)
    const secondHead = await contractClient(origin).publish(second)
    await freezeClock(origin, T('07:05:00.000'))
    const third = buildPublication(collection.capture, FICTIONAL_COMMIT, secondHead, GENERATION_THREE)
    const thirdHead = await contractClient(origin).publish(third)
    const slow = streams.open(origin, `/api/catalog?generation=${GENERATION_ONE}`, { 'Accept-Encoding': 'identity' }, 'retired-reader', 'pinned')
    await slow.ready
    expect(slow.status).toBe(200)
    await freezeClock(origin, T('07:10:00.000'))
    const sweep = await rawRequest(origin, '/__orbit/publish/begin', { method: 'POST', headers: authorized({ 'Content-Type': 'application/json' }), body: third.manifestText })
    expect(jsonBody(sweep)).toEqual({ committed: true, head: thirdHead })
    const pinned = await metricsOf(origin)
    evidence.pinned = pinned
    const pinState = await storeState(origin)
    evidence.pinStoreState = pinState
    expect(pinState.clock.now).toBe(T('07:10:00.000'))
    expect(pinState.clock.mode).toBe('frozen')
    expect(pinned).toMatchObject({ generations: 3, activeGenerations: 1 })
    const body = await slow.finish()
    // C3b: observe release immediately, before expensive complete-body checks.
    // Once replacement is observed, no later fresh zero can repair attribution.
    const releaseObservations: Awaited<ReturnType<typeof metricsOf>>[] = []
    evidence.sameOwnerRelease = { instance: pinned.instance, observations: releaseObservations, timeoutMs: 60_000 }
    let replacement: string | null = null
    await expect.poll(async () => {
      const current = await metricsOf(origin)
      releaseObservations.push(current)
      if (current.instance !== pinned.instance) replacement ??= current.instance
      return replacement ? { attribution: 'unavailable', replacement } : { instance: current.instance, activeBodies: current.activeBodies, activeGenerations: current.activeGenerations }
    }, { timeout: 60_000 }).toEqual({ instance: pinned.instance, activeBodies: 0, activeGenerations: 0 })
    // The reader opened and received its first chunk at 07:05, so this is a 07:05 body even though the clock moved to 07:10 afterwards (MCR82-R12).
    // At 07:05 every ordinary board is stale and himalayas/careers stay fresh; the fixture spans both classes, so the mixed oracle is a real witness.
    expect(collection.companies.some(company => DAILY_SOURCES.includes(company.provider ?? '')), 'the fixture has daily-source boards').toBe(true)
    expect(collection.companies.some(company => !DAILY_SOURCES.includes(company.provider ?? '')), 'the fixture has ordinary-source boards').toBe(true)
    const catalog = await expectCatalogContent(body, first, 'pinned retired generation at its 07:05 request-start clock', MIXED_AT_0705)
    expect(catalog.publication.generation).toBe(GENERATION_ONE)
    streams.destroyAll()
    // A later actor reconstruction is recorded, not forbidden. Persistence is
    // checked under the intended 07:10 store clock after attributable release.
    const afterBodyState = await storeState(origin)
    evidence.afterBodyStoreState = afterBodyState
    expect(afterBodyState.clock).toMatchObject({ mode: 'frozen', now: T('07:10:00.000'), virtualAlarms: true })
    const afterBodyMetrics = await metricsOf(origin)
    evidence.afterBodyMetrics = afterBodyMetrics
    evidence.reconstructedAfterRelease = afterBodyMetrics.instance !== pinned.instance || afterBodyState.harnessInstance !== pinState.harnessInstance
    const laterSweep = await rawRequest(origin, '/__orbit/publish/begin', { method: 'POST', headers: authorized({ 'Content-Type': 'application/json' }), body: third.manifestText })
    expect(laterSweep.status).toBe(200)
    expect(jsonBody(laterSweep)).toEqual({ committed: true, head: thirdHead })
    expect((await rawRequest(origin, `/api/catalog?generation=${GENERATION_ONE}`)).status).toBe(410)
    const after = await metricsOf(origin)
    evidence.after = after
    expect(after).toMatchObject({ generations: 2, chunks: second.chunks.length + third.chunks.length, payloadBytes: compressedBytes(second) + compressedBytes(third) })
    const survivors: unknown[] = []
    evidence.survivors = survivors
    for (const [head, publishedAt] of [[secondHead, T('06:35:00.000')], [thirdHead, T('07:05:00.000')]] as const) {
      const response = await rawRequest(origin, `/api/catalog?generation=${head.generation}`, { headers: { 'Accept-Encoding': 'identity' }, timeoutMs: 900_000 })
      const decoded = decodedBody(response)
      survivors.push({ generation: head.generation, status: response.status, decodedBytes: decoded.length })
      expect(response.status).toBe(200)
      expect(response.headers['content-encoding']).toBeUndefined()
      expect(decoded.length).toBeLessThanOrEqual(LIMITS.catalog)
      await expectCatalogContent(decoded, head, `retained ${head.generation} after GC`, { ...MIXED_AT_0705, requestClock: T('07:10:00.000') }, publishedAt)
    }
    expect((await rawRequest(origin, `/api/catalog?generation=${GENERATION_ONE}`)).status).toBe(410)
  } catch (error) {
    primary = { error }
  }
  await finalizeCase(info, 'capacity-gc', evidence, primary, [
    ...inspectorCleanup(undefined, evidence, streams),
  ])
})

test('authentication and staging conflicts are decided before any byte of a 1 MiB private body is sent', async ({ baseURL, httpObservation }, info) => {
  const origin = baseURL!
  const evidence: Record<string, unknown> = { declaredBodyBytes: LIMITS.chunk }
  const held: HeldRequest[] = []
  const closeHeld = async (request: HeldRequest, label: string) => {
    const closure = await request.cleanup()
    evidence[`${label}Cleanup`] = { closure, observation: request.observation, sentBodyBytes: request.sentBodyBytes }
    if (!closure.confirmed || closure.failures.length) throw new Error(`${label} cleanup: ${closure.failures.join('; ')}`)
    return closure
  }
  let primary: { error: unknown } | null = null
  try {
    const declared = LIMITS.chunk
    const started = performance.now()
    // Headers only: the body is withheld until the server has answered, so the decision cannot depend on consumed body bytes.
    const anonymous = await openHeldRequest(origin, `/__orbit/publish/chunks/${GENERATION_ONE}/0`, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': declared }, observation: httpObservation.scope('anonymous-put', 'withheld-headers') })
    held.push(anonymous)
    const anonymousReply = await anonymous.response
    evidence.anonymous = { status: anonymousReply.status, sentBodyBytes: anonymous.sentBodyBytes, ms: Math.round(performance.now() - started) }
    expect(anonymousReply.status).toBe(401)
    expect(anonymousReply.headers['www-authenticate']).toBe('Bearer')
    expect(anonymous.sentBodyBytes).toBe(0)
    expect(await closeHeld(anonymous, 'anonymous')).toMatchObject({ confirmed: true, responseEnded: true, requestClosed: true, socket: 'closed' })
    const unknown = await openHeldRequest(origin, `/__orbit/publish/chunks/${GENERATION_ONE}/0`, { method: 'PUT', headers: authorized({ 'Content-Type': 'application/octet-stream', 'Content-Length': declared }), observation: httpObservation.scope('unknown-stage-put', 'withheld-headers') })
    held.push(unknown)
    const unknownReply = await unknown.response
    evidence.unknownStage = { status: unknownReply.status, sentBodyBytes: unknown.sentBodyBytes }
    expect(unknownReply.status).toBe(409)
    expect(unknown.sentBodyBytes).toBe(0)
    expect(await closeHeld(unknown, 'unknownStage')).toMatchObject({ confirmed: true, responseEnded: true, requestClosed: true, socket: 'closed' })
    // Without a matching staging the conflict is decided before the body is read, even for an over-limit declared length.
    const oversized = await openHeldRequest(origin, `/__orbit/publish/chunks/${GENERATION_ONE}/0`, { method: 'PUT', headers: authorized({ 'Content-Type': 'application/octet-stream', 'Content-Length': declared + 1 }), observation: httpObservation.scope('oversized-put', 'withheld-headers') })
    held.push(oversized)
    const oversizedReply = await oversized.response
    evidence.oversized = { status: oversizedReply.status, sentBodyBytes: oversized.sentBodyBytes }
    expect(oversizedReply.status).toBe(409)
    expect(oversized.sentBodyBytes).toBe(0)
    expect(await closeHeld(oversized, 'oversized')).toMatchObject({ confirmed: true, responseEnded: true, requestClosed: true, socket: 'closed' })
    // A real authenticated GET, only after all original request/socket joins.
    // This cannot rehabilitate any prior response/assertion/cleanup failure.
    const recovery = await rawRequest(origin, '/__orbit/publish/head', { headers: authorized(), observation: httpObservation.scope('held-put-recovery', 'after-three-closes') })
    const decoded = decodedBody(recovery)
    evidence.recovery = { method: 'GET', status: recovery.status, headers: recovery.headers, decodedBytes: decoded.length, body: decoded.toString('utf8') }
    expect(recovery.status).toBe(200)
    expect(JSON.parse(decoded.toString('utf8'))).toEqual({ head: null, manifest: null })
  } catch (error) {
    if (error instanceof HeldRequestAcquisitionError) evidence.acquisitionFailure = { primary: String(error.primary), observation: error.observation, cleanup: error.cleanup }
    primary = { error }
  }
  await finalizeCase(info, 'capacity-auth', evidence, primary, held.map((request, index) => ({
    label: `held-request-${index}`, run: async () => closeHeld(request, `held-${index}`),
  })))
})
