import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { BoardFetchError, CatalogProgressGoneError, CatalogUnavailableError } from '../../server/catalog-service'
import type { CatalogCollectionUpdate } from '../../shared/catalog-progress'
import type { PostingStatusIndex } from '../../shared/posting-status'
import type { BoardStatus, Catalog } from '../../shared/types'
import { PROVENANCE_ALDER, PROVENANCE_BIRCH, PROVENANCE_CEDAR_DAILY, cachedBody, cachedPresence, contentResult, stamp } from '../fixtures/board-status-provenance'
import { QUEUED_FAILURE_MESSAGE } from '../fixtures/catalog-queued-progress'
import type { QueuedPhase, QueuedProgress } from '../fixtures/catalog-queued-progress'
import { provenanceHarness } from './helpers/board-status-provenance'
import type { ProvenanceHarness } from './helpers/board-status-provenance'

// Stage75 contract: docs/design/catalog-queued-progress.md (9b921a49…feff9).
// The real service over memory caches with held provider gates. Blocking is
// proven by settlement order against explicit marks, never by sleeping; the
// only timers are failure guards. Expected rows, times and messages are literal.
const ALDER = 'provenance-alder'
const BIRCH = 'provenance-birch'
const CEDAR = 'provenance-cedar'
const alder = { companyId: ALDER, board: 'AlderProvenance74', provider: 'greenhouse' } as const
const birch = { companyId: BIRCH, board: 'BirchProvenance74', provider: 'smartrecruiters' } as const
const cedar = { companyId: CEDAR, board: 'cedar-provenance', provider: 'himalayas' } as const
type Identity = typeof alder | typeof birch | typeof cedar
const T = stamp
const UUID = /^[a-f0-9-]{36}$/i
const WAITING = { phase: 'waiting-for-presence', total: null, completed: 0, done: false } as const
const ALDER_JOB = 'greenhouse-provenance-alder-7401'
const BIRCH_JOB = 'smartrecruiters-provenance-birch-7401'
const UNAVAILABLE_MESSAGE = '공개 채용 게시판에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요.'
const EXPIRED_MESSAGE = '게시판에 연결하지 못했어요. 마지막 정상 조회가 24시간을 지나 이전 공고를 표시하지 않습니다.'

/** A company with no body and no failure. `checkedAt` appears once its list check was accepted. */
const cold = (identity: Identity, checkedAt?: string): BoardStatus => ({
  ...identity, status: 'ok', dataStatus: 'unavailable', total: 0, included: 0, ...(checkedAt ? { checkedAt } : {}), lastSuccessAt: null, retryAt: null,
})
const pendingCold = (identity: Identity, checkedAt: string): BoardStatus => ({
  ...identity, status: 'pending', dataStatus: 'unavailable', total: 0, included: 0, checkedAt, lastSuccessAt: null, retryAt: null,
})
const collected = (identity: Identity, time: string, count = 1): BoardStatus => ({
  ...identity, status: 'ok', dataStatus: 'fresh', total: count, included: count, checkedAt: time, lastSuccessAt: time, retryAt: null,
})
/** A company holding a usable body from `time`, either current or dated, possibly scheduled. */
const bodied = (identity: Identity, time: string, dataStatus: 'fresh' | 'stale', status: 'ok' | 'pending' = 'ok', count = 1): BoardStatus => ({
  ...identity, status, dataStatus, total: count, included: count, checkedAt: time, lastSuccessAt: time, retryAt: null,
})
const deferred = (identity: Identity, message: string, checkedAt: string, retryAt: string): BoardStatus => ({
  ...identity, status: 'error', dataStatus: 'unavailable', total: 0, included: 0, checkedAt, lastSuccessAt: null, retryAt, message,
})
const jobRows = (catalog: Pick<Catalog, 'jobs'>) => catalog.jobs.map(job => [job.id, job.fetchedAt, job.stale])

type Service = ReturnType<ProvenanceHarness['start']>
type Progressive = (force?: boolean, queued?: boolean) => Promise<{ catalog: Catalog; progress: unknown }>
/** `getProgressive(force, queued)`: the second argument opts into the negotiated waiting representation. */
const progressive = (service: Service, options: { force?: boolean; queued?: boolean } = {}) =>
  (service.getProgressive as unknown as Progressive)(options.force ?? false, options.queued ?? false)

/** Failure guard only: a response that must not wait on provider work gets a clear message instead of a hang. */
async function settles<T>(promise: Promise<T>, label: string, milliseconds = 2000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} did not settle within ${milliseconds}ms while provider work was held`)), milliseconds)
  })
  try { return await Promise.race([promise, guard]) } finally { clearTimeout(timer) }
}

/** Settlement order against explicit marks. Any premature settlement is visible at the next await. */
function orderLedger() {
  const marks: string[] = []
  return {
    marks,
    mark(label: string) { marks.push(label) },
    watch<T>(label: string, promise: Promise<T>): Promise<T> {
      return promise.then(value => { marks.push(label); return value }, (error: unknown) => { marks.push(label); throw error })
    },
    indexOf: (label: string) => marks.indexOf(label),
  }
}

function expectProgress(progress: unknown, expected: { phase: QueuedPhase; total: number | null; completed: number; done: boolean }, after?: number) {
  expect(progress).toEqual({ id: expect.stringMatching(UUID), revision: expect.any(Number), ...expected })
  const { id, revision } = progress as QueuedProgress
  if (after !== undefined) expect(revision).toBeGreaterThan(after)
  return { id, revision }
}

/**
 * Poll the read-only progress until a state with the requested phase or completion exists.
 * An accepted list result and the handoff may be separate revisions, so a poll that
 * merely waits for "something new" could observe the intermediate metadata state.
 */
function nextUpdate(service: Service, id: string, after: number, options: { done?: boolean; phase?: QueuedPhase } = {}): Promise<CatalogCollectionUpdate> {
  return vi.waitFor(() => {
    const update = service.readProgress(id, after)
    expect(update).not.toBeNull()
    if (options.done) expect(update!.progress.done).toBe(true)
    if (options.phase) expect((update!.progress as unknown as QueuedProgress).phase).toBe(options.phase)
    return update!
  })
}

function thrown(action: () => unknown): Error {
  try { action() } catch (error) { return error instanceof Error ? error : new Error(String(error)) }
  throw new Error('Expected the action to throw')
}

/** The contract's fixed terminal failure: not gone, not a range error, not the unavailable catalog, and exactly this message. */
function expectTerminalFailure(error: Error) {
  expect(error).not.toBeInstanceOf(CatalogProgressGoneError)
  expect(error).not.toBeInstanceOf(RangeError)
  expect(error).not.toBeInstanceOf(CatalogUnavailableError)
  expect(error.message).toBe(QUEUED_FAILURE_MESSAGE)
}

const outcome = <T>(promise: Promise<T>) => promise.then(() => 'fulfilled' as const, (error: unknown) => error instanceof Error ? error : new Error(String(error)))

/** Strict: no unhandled rejection may escape. The listener is removed even when an assertion fails. */
function captureUnhandled() {
  const reasons: unknown[] = []
  const listener = (reason: unknown) => { reasons.push(reason) }
  process.on('unhandledRejection', listener)
  onTestFinished(() => { process.off('unhandledRejection', listener) })
  return {
    async settle() {
      for (let round = 0; round < 3; round++) await new Promise<void>(resolve => setImmediate(resolve))
      return reasons
    },
  }
}

/** Gates are released at test end even on failure, so a failed assertion cannot leave the service blocked. */
function kept<G extends { release: () => void }>(gate: G): G {
  onTestFinished(() => gate.release())
  return gate
}

function bodiesStartAfterLists(h: ProvenanceHarness) {
  const events = h.ledger()
  const lastListEnd = events.reduce((latest, event, index) => event.kind === 'list' && event.phase === 'end' ? index : latest, -1)
  const firstBodyStart = events.findIndex(event => event.kind === 'body' && event.phase === 'start')
  expect(lastListEnd).toBeGreaterThanOrEqual(0)
  expect(firstBodyStart).toBeGreaterThan(lastListEnd)
}

/**
 * Start a forced saved-page list check whose gates are already held, and wait until every held
 * list was requested. The pending promise is returned inside a container: an async function
 * returning it directly would adopt it, and awaiting the helper would then wait on the held gate.
 */
async function startHeldPresence(h: ProvenanceHarness, service: Service, expectedLists: string[]): Promise<{ presence: Promise<PostingStatusIndex> }> {
  const presence = service.getPostingStatus(true)
  await vi.waitFor(() => expect(h.listCalls()).toEqual(expectedLists))
  return { presence }
}

/** A jitter source that throws exactly once, the service's supported way to inject one worker fault. */
function faultyRandom(message: string) {
  let remaining = 1
  const calls = { faults: 0 }
  return {
    calls,
    random: () => {
      if (remaining-- > 0) { calls.faults++; throw new Error(message) }
      return 0
    },
  }
}

afterEach(() => { vi.restoreAllMocks() })

describe('waiting for an active public-list check', () => {
  it('answers a cold extended request before release, without body work, pending rows or persistence, while blocking clients wait', async () => {
    const h = provenanceHarness()
    const lists = kept(h.holdList(ALDER, BIRCH))
    const service = h.start()
    const { presence } = await startHeldPresence(h, service, [ALDER, BIRCH])
    h.at(T('06:00:30.000'))
    const order = orderLedger()
    const sync = order.watch('sync', service.get())
    const legacy = order.watch('legacy', progressive(service))

    const initial = await settles(progressive(service, { queued: true }), 'the extended initial response')
    const { id } = expectProgress(initial.progress, WAITING)
    expect((initial.progress as QueuedProgress).revision).toBe(0)
    expect(initial.catalog).toMatchObject({ source: 'public', fetchedAt: '', refreshAfter: T('06:00:30.000'), stale: false, unmappedCount: 0 })
    expect(initial.catalog).not.toHaveProperty('checkedAt')
    expect(initial.catalog.jobs).toEqual([])
    expect(initial.catalog.boards).toEqual([cold(alder), cold(birch)])
    // Monitoring is read-only: repeated polls neither advance the revision nor schedule work.
    for (let poll = 0; poll < 5; poll++) expect(service.readProgress(id, 0)).toBeNull()
    expect(() => service.readProgress(id, 1)).toThrow(RangeError)
    const joined = await settles(progressive(service, { queued: true }), 'a joining extended request')
    expect((joined.progress as QueuedProgress).id).toBe(id)
    expect(h.bodyCalls()).toEqual([])
    expect(h.cache.save).not.toHaveBeenCalled()
    expect(h.presenceCache.save).not.toHaveBeenCalled()
    expect(h.observationCache.saves()).toBe(0)
    expect(order.marks).toEqual([])

    const bodies = kept(h.holdBody(ALDER, BIRCH))
    order.mark('lists-released')
    lists.release()
    const [legacyResult, index] = await Promise.all([legacy, order.watch('presence', presence)])
    // Legacy async clients never see the waiting phase or an undecided total.
    expectProgress(legacyResult.progress, { phase: 'collecting', total: 2, completed: 0, done: false })
    expect((legacyResult.progress as QueuedProgress).id).toBe(id)
    expect(legacyResult.catalog.boards).toEqual([pendingCold(alder, T('06:00:00.000')), pendingCold(birch, T('06:00:00.000'))])
    expect(index.boards.map(board => [board.companyId, board.status, board.lastSuccessAt])).toEqual([[ALDER, 'ok', T('06:00:00.000')], [BIRCH, 'ok', T('06:00:00.000')]])
    expect(order.indexOf('legacy')).toBeGreaterThan(order.indexOf('lists-released'))
    expect(order.indexOf('presence')).toBeGreaterThan(order.indexOf('lists-released'))
    expect(order.marks).not.toContain('sync')
    // The list operation persisted once; the body operation has not persisted anything yet.
    expect(h.presenceCache.save).toHaveBeenCalledTimes(1)
    await vi.waitFor(() => expect(h.bodyCalls()).toEqual([ALDER, BIRCH]))
    order.mark('bodies-released')
    bodies.release()
    const catalog = await sync
    expect(order.marks.at(-1)).toBe('sync')
    expect(order.indexOf('presence')).toBeLessThan(order.indexOf('bodies-released'))
    expect(catalog.boards).toEqual([collected(alder, T('06:00:30.000')), collected(birch, T('06:00:30.000'))])
    expect(catalog).toMatchObject({ fetchedAt: T('06:00:30.000'), checkedAt: T('06:00:30.000'), refreshAfter: T('06:01:30.000'), stale: false })
    expect(jobRows(catalog)).toEqual([[ALDER_JOB, T('06:00:30.000'), false], [BIRCH_JOB, T('06:00:30.000'), false]])
    const final = service.readProgress(id, 0)!
    expectProgress(final.progress, { phase: 'collecting', total: 2, completed: 2, done: true }, 0)
    expect([...final.companyIds].sort()).toEqual([ALDER, BIRCH])
    expect(final.catalog.boards).toEqual(catalog.boards)
    // Two distinct persisting operations: the list check, then the body collection with its newly seeded inventory.
    expect(h.cache.save).toHaveBeenCalledTimes(1)
    expect(h.presenceCache.save).toHaveBeenCalledTimes(2)
    expect(h.presenceCache.value().map(entry => [entry.companyId, entry.snapshot?.fetchedAt])).toEqual([[ALDER, T('06:00:30.000')], [BIRCH, T('06:00:30.000')]])
    expect(h.observationCache.saves()).toBe(1)
    bodiesStartAfterLists(h)
  })

  it('publishes an accepted list failure as metadata only, freezes the reduced actual total at handoff and never requests the deferred body', async () => {
    const h = provenanceHarness()
    h.failList(BIRCH, 'HTTP 429', T('06:10:30.000'))
    const birchList = kept(h.holdList(BIRCH))
    const alderList = kept(h.holdList(ALDER))
    const service = h.start()
    const { presence } = await startHeldPresence(h, service, [ALDER, BIRCH])
    h.at(T('06:00:30.000'))
    const initial = await settles(progressive(service, { queued: true }), 'the extended initial response')
    const { id } = expectProgress(initial.progress, WAITING)
    expect(initial.catalog.boards).toEqual([cold(alder), cold(birch)])
    const order = orderLedger()
    const sync = order.watch('sync', service.get())
    const BIRCH_DEFERRED = deferred(birch, 'HTTP 429', T('06:00:00.000'), T('06:10:30.000'))

    // Birch's list fails while Alder's is still held: one metadata-only revision, no body counted.
    birchList.release()
    const metadata = await nextUpdate(service, id, 0)
    const afterMetadata = expectProgress(metadata.progress, WAITING, 0).revision
    expect(metadata.companyIds).toEqual([])
    expect(metadata.jobs).toEqual([])
    expect(metadata.catalog).toEqual({
      source: 'public', fetchedAt: '', checkedAt: T('06:00:00.000'), refreshAfter: T('06:00:30.000'), stale: false, unmappedCount: 0,
      boards: [cold(alder), BIRCH_DEFERRED],
    })
    expect(service.readProgress(id, afterMetadata)).toBeNull()
    expect(h.bodyCalls()).toEqual([])
    expect(order.marks).toEqual([])

    // Alder's list succeeds: handoff freezes exactly one actual body company.
    const alderBody = kept(h.holdBody(ALDER))
    alderList.release()
    const handoff = await nextUpdate(service, id, afterMetadata, { phase: 'collecting' })
    const afterHandoff = expectProgress(handoff.progress, { phase: 'collecting', total: 1, completed: 0, done: false }, afterMetadata).revision
    expect(handoff.companyIds).toEqual([])
    expect(handoff.jobs).toEqual([])
    expect(handoff.catalog).toEqual({
      source: 'public', fetchedAt: '', checkedAt: T('06:00:00.000'), refreshAfter: T('06:00:00.000'), stale: false, unmappedCount: 0,
      boards: [pendingCold(alder, T('06:00:00.000')), BIRCH_DEFERRED],
    })
    const index = await presence
    expect(index.boards.map(board => [board.companyId, board.status, board.retryAt])).toEqual([[ALDER, 'ok', null], [BIRCH, 'error', T('06:10:30.000')]])
    expect(h.bodyCalls()).toEqual([ALDER])
    // A forced join after handoff shares the frozen run and cannot expand it.
    const forced = await settles(progressive(service, { force: true, queued: true }), 'a forced join after handoff')
    expect((forced.progress as QueuedProgress).id).toBe(id)
    expectProgress(forced.progress, { phase: 'collecting', total: 1, completed: 0, done: false })
    expect(order.marks).toEqual([])

    order.mark('body-released')
    alderBody.release()
    const catalog = await sync
    expect(order.marks).toEqual(['body-released', 'sync'])
    const final = service.readProgress(id, afterHandoff)!
    expectProgress(final.progress, { phase: 'collecting', total: 1, completed: 1, done: true }, afterHandoff)
    expect(final.companyIds).toEqual([ALDER])
    expect(jobRows(final)).toEqual([[ALDER_JOB, T('06:00:30.000'), false]])
    expect(final.catalog).toEqual({
      source: 'public', fetchedAt: T('06:00:30.000'), checkedAt: T('06:00:30.000'), refreshAfter: T('06:01:30.000'), stale: false, unmappedCount: 0,
      boards: [collected(alder, T('06:00:30.000')), BIRCH_DEFERRED],
    })
    expect(catalog.boards).toEqual(final.catalog.boards)
    expect(h.bodyCalls()).toEqual([ALDER])
    expect(h.listCalls()).toEqual([ALDER, BIRCH])
    expect(h.cache.save).toHaveBeenCalledTimes(1)
    // List operation once, body operation once more; Birch's deferred record survives the second write.
    expect(h.presenceCache.save).toHaveBeenCalledTimes(2)
    expect(h.presenceCache.value().map(entry => [entry.companyId, entry.error ?? null])).toEqual([[ALDER, null], [BIRCH, 'HTTP 429']])
    bodiesStartAfterLists(h)
  })

  it('publishes fresh cached bodies while waiting, completes with zero body work and hands legacy clients the terminal catalog', async () => {
    const h = provenanceHarness({ bodies: [cachedBody(PROVENANCE_ALDER, T('06:00:00.000')), cachedBody(PROVENANCE_BIRCH, T('06:00:00.000'))], at: T('06:01:00.000') })
    const lists = kept(h.holdList(ALDER, BIRCH))
    const service = h.start()
    const { presence } = await startHeldPresence(h, service, [ALDER, BIRCH])
    expect(h.observationCache.saves()).toBe(1)
    const order = orderLedger()
    const sync = order.watch('sync', service.get())
    const legacy = order.watch('legacy', progressive(service))
    const FRESH = [bodied(alder, T('06:00:00.000'), 'fresh'), bodied(birch, T('06:00:00.000'), 'fresh')]

    const initial = await settles(progressive(service, { queued: true }), 'the extended initial response')
    const { id } = expectProgress(initial.progress, WAITING)
    expect(initial.catalog).toMatchObject({ fetchedAt: T('06:00:00.000'), checkedAt: T('06:00:00.000'), refreshAfter: T('06:01:00.000'), stale: false })
    expect(initial.catalog.boards).toEqual(FRESH)
    expect(jobRows(initial.catalog)).toEqual([[ALDER_JOB, T('06:00:00.000'), false], [BIRCH_JOB, T('06:00:00.000'), false]])
    expect(order.marks).toEqual([])

    order.mark('release')
    lists.release()
    const [catalog, legacyResult, index] = await Promise.all([sync, legacy, presence])
    expect(order.marks[0]).toBe('release')
    expect(legacyResult.progress).toBeNull()
    expect(legacyResult.catalog.boards).toEqual(FRESH)
    expect(legacyResult.catalog).toMatchObject({ fetchedAt: T('06:00:00.000'), checkedAt: T('06:01:00.000'), refreshAfter: T('06:01:00.000'), stale: false })
    expect(catalog).toEqual(legacyResult.catalog)
    const final = await nextUpdate(service, id, 0, { done: true })
    expectProgress(final.progress, { phase: 'collecting', total: 0, completed: 0, done: true }, 0)
    expect(final.companyIds).toEqual([])
    expect(final.jobs).toEqual([])
    expect(final.catalog).toEqual({
      source: 'public', fetchedAt: T('06:00:00.000'), checkedAt: T('06:01:00.000'), refreshAfter: T('06:01:00.000'), stale: false, unmappedCount: 0, boards: FRESH,
    })
    expect(index.boards.map(board => [board.companyId, board.status, board.lastSuccessAt])).toEqual([[ALDER, 'ok', T('06:01:00.000')], [BIRCH, 'ok', T('06:01:00.000')]])
    expect(h.bodyCalls()).toEqual([])
    expect(h.cache.save).not.toHaveBeenCalled()
    // Only the list operation persisted; zero body work adds no body-triggered presence write.
    expect(h.presenceCache.save).toHaveBeenCalledTimes(1)
    expect(h.observationCache.saves()).toBe(1)
  })

  it('completes authoritative empty bodies with zero work as a successful empty catalog, not an unavailable one', async () => {
    const empty = (company: typeof PROVENANCE_ALDER) => cachedBody(company, T('06:00:00.000'), { body: { fetchedAt: T('06:00:00.000'), nativeIds: [] } })
    const h = provenanceHarness({ bodies: [empty(PROVENANCE_ALDER), empty(PROVENANCE_BIRCH)], at: T('06:01:00.000') })
    const lists = kept(h.holdList(ALDER, BIRCH))
    const service = h.start()
    const { presence } = await startHeldPresence(h, service, [ALDER, BIRCH])
    const EMPTY = [bodied(alder, T('06:00:00.000'), 'fresh', 'ok', 0), bodied(birch, T('06:00:00.000'), 'fresh', 'ok', 0)]
    const sync = service.get()
    const initial = await settles(progressive(service, { queued: true }), 'the extended initial response')
    const { id } = expectProgress(initial.progress, WAITING)
    expect(initial.catalog.boards).toEqual(EMPTY)
    expect(initial.catalog.jobs).toEqual([])
    expect(initial.catalog.fetchedAt).toBe(T('06:00:00.000'))
    lists.release()
    await presence
    const final = await nextUpdate(service, id, 0, { done: true })
    expectProgress(final.progress, { phase: 'collecting', total: 0, completed: 0, done: true }, 0)
    expect(final.catalog).toMatchObject({ fetchedAt: T('06:00:00.000'), checkedAt: T('06:01:00.000'), stale: false, boards: EMPTY })
    const catalog = await sync
    expect(catalog.jobs).toEqual([])
    expect(catalog.boards).toEqual(EMPTY)
    expect(catalog).toMatchObject({ fetchedAt: T('06:00:00.000'), checkedAt: T('06:01:00.000'), stale: false, unmappedCount: 0 })
    expect(h.bodyCalls()).toEqual([])
    expect(h.cache.save).not.toHaveBeenCalled()
    expect(h.presenceCache.save).toHaveBeenCalledTimes(1)
  })

  it('merges a forced intent that arrives while waiting and collects both fresh bodies at handoff', async () => {
    const h = provenanceHarness({ bodies: [cachedBody(PROVENANCE_ALDER, T('06:00:00.000')), cachedBody(PROVENANCE_BIRCH, T('06:00:00.000'))], at: T('06:01:00.000') })
    const lists = kept(h.holdList(ALDER, BIRCH))
    const service = h.start()
    const { presence } = await startHeldPresence(h, service, [ALDER, BIRCH])
    const initial = await settles(progressive(service, { queued: true }), 'the extended initial response')
    const { id } = expectProgress(initial.progress, WAITING)
    const forced = await settles(progressive(service, { force: true, queued: true }), 'a forced join while waiting')
    expect((forced.progress as QueuedProgress).id).toBe(id)
    expectProgress(forced.progress, WAITING)
    const bodies = kept(h.holdBody(ALDER, BIRCH))
    lists.release()
    await presence
    const handoff = await nextUpdate(service, id, 0, { phase: 'collecting' })
    const afterHandoff = expectProgress(handoff.progress, { phase: 'collecting', total: 2, completed: 0, done: false }, 0).revision
    expect(handoff.companyIds).toEqual([])
    expect(handoff.jobs).toEqual([])
    expect(handoff.catalog).toEqual({
      source: 'public', fetchedAt: T('06:00:00.000'), checkedAt: T('06:01:00.000'), refreshAfter: T('06:01:00.000'), stale: false, unmappedCount: 0,
      boards: [bodied(alder, T('06:00:00.000'), 'fresh', 'pending'), bodied(birch, T('06:00:00.000'), 'fresh', 'pending')],
    })
    expect(h.bodyCalls()).toEqual([ALDER, BIRCH])
    bodies.release()
    const final = await nextUpdate(service, id, afterHandoff, { done: true })
    expectProgress(final.progress, { phase: 'collecting', total: 2, completed: 2, done: true }, afterHandoff)
    expect([...final.companyIds].sort()).toEqual([ALDER, BIRCH])
    expect(final.catalog).toMatchObject({ fetchedAt: T('06:01:00.000'), checkedAt: T('06:01:00.000'), refreshAfter: T('06:02:00.000'), stale: false })
    expect(final.catalog.boards).toEqual([collected(alder, T('06:01:00.000')), collected(birch, T('06:01:00.000'))])
    expect(jobRows(final)).toEqual([[ALDER_JOB, T('06:01:00.000'), false], [BIRCH_JOB, T('06:01:00.000'), false]])
    expect(h.cache.save).toHaveBeenCalledTimes(1)
    expect(h.presenceCache.save).toHaveBeenCalledTimes(2)
  })

  it('shows dated retained bodies while waiting and keeps their original times until each body is actually replaced', async () => {
    const h = provenanceHarness({ bodies: [cachedBody(PROVENANCE_ALDER, T('06:00:00.000')), cachedBody(PROVENANCE_BIRCH, T('06:00:00.000'))], at: T('06:31:00.000') })
    const lists = kept(h.holdList(ALDER, BIRCH))
    const service = h.start()
    const { presence } = await startHeldPresence(h, service, [ALDER, BIRCH])
    const initial = await settles(progressive(service, { queued: true }), 'the extended initial response')
    const { id } = expectProgress(initial.progress, WAITING)
    expect(initial.catalog).toMatchObject({ fetchedAt: T('06:00:00.000'), checkedAt: T('06:00:00.000'), refreshAfter: T('06:01:00.000'), stale: true })
    expect(initial.catalog.boards).toEqual([bodied(alder, T('06:00:00.000'), 'stale'), bodied(birch, T('06:00:00.000'), 'stale')])
    expect(jobRows(initial.catalog)).toEqual([[ALDER_JOB, T('06:00:00.000'), true], [BIRCH_JOB, T('06:00:00.000'), true]])
    const bodies = kept(h.holdBody(ALDER, BIRCH))
    lists.release()
    await presence
    const handoff = await nextUpdate(service, id, 0, { phase: 'collecting' })
    const afterHandoff = expectProgress(handoff.progress, { phase: 'collecting', total: 2, completed: 0, done: false }, 0).revision
    expect(handoff.jobs).toEqual([])
    expect(handoff.catalog).toMatchObject({ fetchedAt: T('06:00:00.000'), checkedAt: T('06:31:00.000'), stale: true })
    expect(handoff.catalog.boards).toEqual([bodied(alder, T('06:00:00.000'), 'stale', 'pending'), bodied(birch, T('06:00:00.000'), 'stale', 'pending')])
    expect(h.bodyCalls()).toEqual([ALDER, BIRCH])
    bodies.release()
    const final = await nextUpdate(service, id, afterHandoff, { done: true })
    expectProgress(final.progress, { phase: 'collecting', total: 2, completed: 2, done: true }, afterHandoff)
    expect(final.catalog).toMatchObject({ fetchedAt: T('06:31:00.000'), checkedAt: T('06:31:00.000'), refreshAfter: T('06:32:00.000'), stale: false })
    expect(final.catalog.boards).toEqual([collected(alder, T('06:31:00.000')), collected(birch, T('06:31:00.000'))])
    expect(jobRows(final)).toEqual([[ALDER_JOB, T('06:31:00.000'), false], [BIRCH_JOB, T('06:31:00.000'), false]])
  })
})

describe('eligibility is decided once at handoff', () => {
  it.each([
    { release: '06:00:59.999', total: 1, bodies: [ALDER], refreshAfter: '06:01:00.000' },
    { release: '06:01:00.000', total: 2, bodies: [ALDER, BIRCH], refreshAfter: '06:02:00.000' },
  ])('applies the shared sixty-second minimum with the handoff clock, releasing at $release', async ({ release, total, bodies, refreshAfter }) => {
    const h = provenanceHarness({
      presences: [cachedPresence(PROVENANCE_BIRCH, T('06:00:00.000'), { failure: { message: 'Fictional persisted list failure', retryAt: null } })],
      at: T('06:00:30.000'),
    })
    const lists = kept(h.holdList(ALDER))
    const service = h.start()
    const { presence } = await startHeldPresence(h, service, [ALDER])
    const initial = await settles(progressive(service, { queued: true }), 'the extended initial response')
    const { id } = expectProgress(initial.progress, WAITING)
    const persisted = deferred(birch, 'Fictional persisted list failure', T('06:00:00.000'), T('06:01:00.000'))
    expect(initial.catalog.boards).toEqual([cold(alder), persisted])
    h.at(T(release))
    lists.release()
    await presence
    const final = await nextUpdate(service, id, 0, { done: true })
    expectProgress(final.progress, { phase: 'collecting', total, completed: total, done: true }, 0)
    expect(h.bodyCalls()).toEqual(bodies)
    expect(final.catalog.refreshAfter).toBe(T(refreshAfter))
    expect(final.catalog.boards[0]).toEqual(collected(alder, T(release)))
    expect(final.catalog.boards[1]).toEqual(total === 2 ? collected(birch, T(release)) : persisted)
    const index = await service.getPostingStatus()
    expect(index.boards[1]).toMatchObject(total === 2
      ? { status: 'ok', retryAt: null, lastSuccessAt: T(release) }
      : { status: 'error', message: 'Fictional persisted list failure', retryAt: T('06:01:00.000'), lastSuccessAt: null })
  })

  it.each([
    { release: '06:29:59.999', total: 0, bodies: [] as string[] },
    { release: '06:30:00.000', total: 2, bodies: [ALDER, BIRCH] },
  ])('applies the normal thirty-minute freshness with the handoff clock, releasing at $release', async ({ release, total, bodies }) => {
    const h = provenanceHarness({ bodies: [cachedBody(PROVENANCE_ALDER, T('06:00:00.000')), cachedBody(PROVENANCE_BIRCH, T('06:00:00.000'))], at: T('06:29:30.000') })
    const lists = kept(h.holdList(ALDER, BIRCH))
    const service = h.start()
    const { presence } = await startHeldPresence(h, service, [ALDER, BIRCH])
    const initial = await settles(progressive(service, { queued: true }), 'the extended initial response')
    const { id } = expectProgress(initial.progress, WAITING)
    expect(initial.catalog.boards).toEqual([bodied(alder, T('06:00:00.000'), 'fresh'), bodied(birch, T('06:00:00.000'), 'fresh')])
    h.at(T(release))
    lists.release()
    await presence
    const final = await nextUpdate(service, id, 0, { done: true })
    expectProgress(final.progress, { phase: 'collecting', total, completed: total, done: true }, 0)
    expect(h.bodyCalls()).toEqual(bodies)
    expect(final.catalog.boards).toEqual(total
      ? [collected(alder, T(release)), collected(birch, T(release))]
      : [bodied(alder, T('06:00:00.000'), 'fresh'), bodied(birch, T('06:00:00.000'), 'fresh')])
    expect(final.catalog.fetchedAt).toBe(total ? T(release) : T('06:00:00.000'))
    expect(h.presenceCache.save).toHaveBeenCalledTimes(total ? 2 : 1)
  })

  it.each([
    { release: '2026-10-01T06:00:30.000Z', total: 1, bodies: [ALDER] },
    { release: '2026-10-02T06:00:00.000Z', total: 2, bodies: [ALDER, CEDAR] },
  ])('applies a daily source\'s own interval to a forced request at handoff, releasing at $release', async ({ release, total, bodies }) => {
    const h = provenanceHarness({
      companies: [PROVENANCE_ALDER, PROVENANCE_CEDAR_DAILY],
      bodies: [cachedBody(PROVENANCE_CEDAR_DAILY, T('06:00:00.000'))], at: T('06:00:30.000'),
    })
    const lists = kept(h.holdList(ALDER))
    const service = h.start()
    const { presence } = await startHeldPresence(h, service, [ALDER])
    const initial = await settles(progressive(service, { force: true, queued: true }), 'the forced extended initial response')
    const { id } = expectProgress(initial.progress, WAITING)
    expect(initial.catalog.boards).toEqual([cold(alder), bodied(cedar, T('06:00:00.000'), 'fresh')])
    h.at(release)
    lists.release()
    await presence
    const final = await nextUpdate(service, id, 0, { done: true })
    expectProgress(final.progress, { phase: 'collecting', total, completed: total, done: true }, 0)
    expect(h.bodyCalls()).toEqual(bodies)
    expect(final.catalog.boards[0]).toEqual(collected(alder, release))
    expect(final.catalog.boards[1]).toEqual(total === 2 ? collected(cedar, release) : bodied(cedar, T('06:00:00.000'), 'fresh'))
    expect(h.listCalls()).toEqual([ALDER])
  })
})

describe('one shared operation', () => {
  it('coalesces every catalog and body caller, keeps legacy clients on the collecting phase and starts bodies only after both list checks end', async () => {
    const h = provenanceHarness()
    const lists = kept(h.holdList(ALDER, BIRCH))
    const service = h.start()
    const { presence } = await startHeldPresence(h, service, [ALDER, BIRCH])
    h.at(T('06:00:30.000'))
    const extended = await Promise.all(Array.from({ length: 12 }, () => settles(progressive(service, { queued: true }), 'an extended request')))
    const forced = await settles(progressive(service, { force: true, queued: true }), 'a forced extended request')
    const ids = new Set([...extended, forced].map(result => (result.progress as QueuedProgress).id))
    expect(ids.size).toBe(1)
    for (const result of [...extended, forced]) expectProgress(result.progress, WAITING)
    const order = orderLedger()
    // Listed individually so Promise.all keeps the tuple types: two catalogs, then a posting index with listings.
    const firstSync = order.watch('sync-1', service.get())
    const secondSync = order.watch('sync-2', service.get())
    const content = order.watch('content', service.getPostingStatus(true, true))
    const legacy = order.watch('legacy', progressive(service))
    const bodies = kept(h.holdBody(ALDER, BIRCH))
    expect(h.bodyCalls()).toEqual([])
    expect(order.marks).toEqual([])

    order.mark('lists-released')
    lists.release()
    const [legacyResult] = await Promise.all([legacy, order.watch('presence', presence)])
    expectProgress(legacyResult.progress, { phase: 'collecting', total: 2, completed: 0, done: false })
    expect([...ids][0]).toBe((legacyResult.progress as QueuedProgress).id)
    expect(order.marks).not.toContain('sync-1')
    expect(order.marks).not.toContain('content')
    await vi.waitFor(() => expect(h.bodyCalls()).toEqual([ALDER, BIRCH]))
    order.mark('bodies-released')
    bodies.release()
    const [first, second, index] = await Promise.all([firstSync, secondSync, content])
    for (const label of ['sync-1', 'sync-2', 'content']) expect(order.indexOf(label)).toBeGreaterThan(order.indexOf('bodies-released'))
    expect(first).toEqual(second)
    expect(first.boards).toEqual([collected(alder, T('06:00:30.000')), collected(birch, T('06:00:30.000'))])
    expect(index.boards.map(board => [board.companyId, board.listing?.content?.status, board.listing?.content?.checkedAt]))
      .toEqual([[ALDER, 'ok', T('06:00:30.000')], [BIRCH, 'ok', T('06:00:30.000')]])
    expect(h.fetchBoard).toHaveBeenCalledTimes(2)
    expect(h.fetchPresence).toHaveBeenCalledTimes(2)
    expect(h.cache.save).toHaveBeenCalledTimes(1)
    expect(h.presenceCache.save).toHaveBeenCalledTimes(2)
    bodiesStartAfterLists(h)
  })

  it('lets a second presence caller finish with the active list run while bodies are queued, and never lets new list work overtake running bodies', async () => {
    const h = provenanceHarness()
    const lists = kept(h.holdList(ALDER, BIRCH))
    const service = h.start()
    const { presence } = await startHeldPresence(h, service, [ALDER, BIRCH])
    h.at(T('06:00:30.000'))
    const initial = await settles(progressive(service, { queued: true }), 'the extended initial response')
    expectProgress(initial.progress, WAITING)
    const bodies = kept(h.holdBody(ALDER, BIRCH))
    const order = orderLedger()
    const second = order.watch('presence-2', service.getPostingStatus(true))
    expect(h.listCalls()).toEqual([ALDER, BIRCH])
    order.mark('lists-released')
    lists.release()
    const [firstIndex, secondIndex] = await Promise.all([presence, second])
    expect(secondIndex).toEqual(firstIndex)
    expect(order.marks).toEqual(['lists-released', 'presence-2'])
    await vi.waitFor(() => expect(h.bodyCalls()).toEqual([ALDER, BIRCH]))

    // A due presence request during the body run waits for the bodies, then runs its own lists.
    h.at(T('06:01:30.000'))
    const third = order.watch('presence-3', service.getPostingStatus(true))
    for (let round = 0; round < 3; round++) await new Promise<void>(resolve => setImmediate(resolve))
    expect(h.listCalls()).toEqual([ALDER, BIRCH])
    expect(order.marks).toEqual(['lists-released', 'presence-2'])
    order.mark('bodies-released')
    bodies.release()
    const thirdIndex = await third
    expect(order.marks).toEqual(['lists-released', 'presence-2', 'bodies-released', 'presence-3'])
    expect(h.listCalls()).toEqual([ALDER, BIRCH, ALDER, BIRCH])
    expect(thirdIndex.boards.map(board => [board.companyId, board.status, board.lastSuccessAt])).toEqual([[ALDER, 'ok', T('06:01:30.000')], [BIRCH, 'ok', T('06:01:30.000')]])
    const events = h.ledger()
    const lastBodyEnd = events.reduce((latest, event, index) => event.kind === 'body' && event.phase === 'end' ? index : latest, -1)
    const thirdRunStart = events.findIndex((event, index) => event.kind === 'list' && event.phase === 'start' && index > lastBodyEnd)
    expect(lastBodyEnd).toBeGreaterThanOrEqual(0)
    expect(thirdRunStart).toBeGreaterThan(lastBodyEnd)
    expect(events.filter(event => event.kind === 'list' && event.phase === 'start')).toHaveLength(4)
  })

  it('drops a waiting operation on restart with the existing gone error and has persisted nothing for it', async () => {
    const h = provenanceHarness()
    const lists = kept(h.holdList(ALDER, BIRCH))
    const service = h.start()
    const { presence } = await startHeldPresence(h, service, [ALDER, BIRCH])
    h.at(T('06:00:30.000'))
    const initial = await settles(progressive(service, { queued: true }), 'the extended initial response')
    const { id } = expectProgress(initial.progress, WAITING)
    const restarted = h.start()
    expect(() => restarted.readProgress(id, 0)).toThrow(CatalogProgressGoneError)
    expect(h.cache.save).not.toHaveBeenCalled()
    expect(h.presenceCache.value()).toEqual([])
    lists.release()
    await presence
  })
})

describe('completion without usable bodies', () => {
  it.each([
    { label: 'no bodies', bodies: [] as ReturnType<typeof cachedBody>[], code: 'CATALOG_UNAVAILABLE', message: UNAVAILABLE_MESSAGE, fetchedAt: '', checkedAt: undefined },
    {
      label: 'expired bodies', code: 'CATALOG_EXPIRED', message: EXPIRED_MESSAGE, fetchedAt: '', checkedAt: '2026-09-30T05:59:00.000Z',
      bodies: [cachedBody(PROVENANCE_ALDER, '2026-09-30T05:59:00.000Z'), cachedBody(PROVENANCE_BIRCH, '2026-09-30T05:59:00.000Z')],
    },
  ])('answers the existing $code error when every company is deferred at handoff with $label', async ({ bodies, code, message, fetchedAt, checkedAt }) => {
    const h = provenanceHarness({ bodies, at: T('06:00:30.000') })
    h.fetchPresence.mockImplementation(async () => { throw new BoardFetchError('HTTP 429', Date.parse(T('06:10:30.000'))) })
    const lists = kept(h.holdList(ALDER, BIRCH))
    const service = h.start()
    const { presence } = await startHeldPresence(h, service, [ALDER, BIRCH])
    const initial = await settles(progressive(service, { queued: true }), 'the extended initial response')
    const { id } = expectProgress(initial.progress, WAITING)
    expect(initial.catalog.fetchedAt).toBe(fetchedAt)
    expect(initial.catalog.jobs).toEqual([])
    if (checkedAt) {
      expect(initial.catalog.checkedAt).toBe(checkedAt)
      expect(initial.catalog.boards).toEqual([
        { ...alder, status: 'ok', dataStatus: 'unavailable', total: 0, included: 0, checkedAt, lastSuccessAt: checkedAt, retryAt: null },
        { ...birch, status: 'ok', dataStatus: 'unavailable', total: 0, included: 0, checkedAt, lastSuccessAt: checkedAt, retryAt: null },
      ])
    } else {
      expect(initial.catalog.boards).toEqual([cold(alder), cold(birch)])
    }
    const sync = outcome(service.get())
    lists.release()
    const index = await presence
    expect(index.boards.map(board => [board.companyId, board.status, board.retryAt])).toEqual([[ALDER, 'error', T('06:10:30.000')], [BIRCH, 'error', T('06:10:30.000')]])
    const failure = await vi.waitFor(() => thrown(() => service.readProgress(id, 0)))
    expect(failure).toBeInstanceOf(CatalogUnavailableError)
    expect(failure).toMatchObject({ code, retryAt: T('06:10:30.000'), message })
    expect(await sync).toMatchObject({ code, retryAt: T('06:10:30.000'), message })
    expect(h.bodyCalls()).toEqual([])
    expect(h.cache.save).not.toHaveBeenCalled()
  })
})

describe('unexpected rejection', () => {
  const throwingReporters: [string, () => (error: unknown) => void | Promise<void>, number][] = [
    ['a synchronously throwing reporter', () => () => { throw new Error('Fictional error reporter rejection') }, 2],
    ['an asynchronously rejecting reporter', () => async () => { throw new Error('Fictional error reporter rejection') }, 2],
  ]

  it.each(throwingReporters)('turns a rejected list persistence before handoff into one repeated terminal failure with %s, then lets the next request start over', async (_label, reporter, reporterCalls) => {
    const unhandled = captureUnhandled()
    const onCacheError = vi.fn(reporter())
    const h = provenanceHarness({ onCacheError })
    const saveError = new Error('Fictional presence persistence failure')
    // The fault is scoped to the list operation's own write; the later body operation's write must succeed.
    h.presenceCache.save.mockImplementationOnce(async () => { throw saveError })
    const lists = kept(h.holdList(ALDER, BIRCH))
    const service = h.start()
    const presence = outcome(service.getPostingStatus(true))
    await vi.waitFor(() => expect(h.listCalls()).toEqual([ALDER, BIRCH]))
    h.at(T('06:00:30.000'))
    const initial = await settles(progressive(service, { queued: true }), 'the extended initial response')
    const { id } = expectProgress(initial.progress, WAITING)
    const sync = outcome(service.get())
    const legacy = outcome(progressive(service))

    lists.release()
    const presenceOutcome = await presence
    expect(presenceOutcome).toBeInstanceOf(Error)
    const failure = await vi.waitFor(() => thrown(() => service.readProgress(id, 0)))
    expectTerminalFailure(failure)
    // Every valid poll of the failed operation keeps failing the same way; none returns 204 or success.
    for (let poll = 0; poll < 5; poll++) expect(thrown(() => service.readProgress(id, 0)).message).toBe(QUEUED_FAILURE_MESSAGE)
    const syncOutcome = await sync
    const legacyOutcome = await legacy
    expect(syncOutcome).toBeInstanceOf(Error)
    expect(legacyOutcome).toBeInstanceOf(Error)
    expect((syncOutcome as Error).message).toBe(QUEUED_FAILURE_MESSAGE)
    expect((legacyOutcome as Error).message).toBe(QUEUED_FAILURE_MESSAGE)
    expect(h.bodyCalls()).toEqual([])
    expect(h.cache.save).not.toHaveBeenCalled()
    expect(h.presenceCache.save).toHaveBeenCalledTimes(1)
    expect(h.observationCache.saves()).toBe(0)
    // The write failure was reported once at the boundary; the completion observer reported the terminal cause once more.
    expect(await unhandled.settle()).toEqual([])
    expect(onCacheError).toHaveBeenCalledTimes(reporterCalls)
    expect(onCacheError.mock.calls[0][0]).toBe(saveError)
    expect((onCacheError.mock.calls[1][0] as Error).message).toBe('Fictional error reporter rejection')

    // The list state is released: an ordinary status read answers from memory without a new list run.
    const index = await settles(service.getPostingStatus(), 'a status read after the failure')
    expect(index.boards.map(board => [board.companyId, board.status])).toEqual([[ALDER, 'ok'], [BIRCH, 'ok']])
    expect(h.listCalls()).toEqual([ALDER, BIRCH])
    // The next extended request starts over from cold memory, replaces the failed id and persists normally.
    const bodies = kept(h.holdBody(ALDER, BIRCH))
    const next = await settles(progressive(service, { queued: true }), 'the next extended request')
    const replacement = expectProgress(next.progress, { phase: 'collecting', total: 2, completed: 0, done: false })
    expect(replacement.id).not.toBe(id)
    expect(next.catalog.boards).toEqual([pendingCold(alder, T('06:00:00.000')), pendingCold(birch, T('06:00:00.000'))])
    expect(() => service.readProgress(id, 0)).toThrow(CatalogProgressGoneError)
    bodies.release()
    const final = await nextUpdate(service, replacement.id, 0, { done: true })
    expectProgress(final.progress, { phase: 'collecting', total: 2, completed: 2, done: true }, 0)
    expect(h.bodyCalls()).toEqual([ALDER, BIRCH])
    expect(h.cache.save).toHaveBeenCalledTimes(1)
    expect(h.presenceCache.save).toHaveBeenCalledTimes(2)
    expect(h.presenceCache.value().map(entry => [entry.companyId, entry.snapshot?.fetchedAt])).toEqual([[ALDER, T('06:00:30.000')], [BIRCH, T('06:00:30.000')]])
    expect(onCacheError).toHaveBeenCalledTimes(reporterCalls)
    expect(await unhandled.settle()).toEqual([])
  })

  it.each([
    ['a synchronous reporter that returns', () => vi.fn()],
    ['an asynchronous reporter that resolves', () => vi.fn(async () => {})],
  ])('keeps best-effort behaviour for persistence errors with %s', async (_label, reporterFactory) => {
    const unhandled = captureUnhandled()
    const onCacheError = reporterFactory()
    const h = provenanceHarness({ onCacheError })
    const presenceSaveError = new Error('Fictional presence persistence failure')
    const bodySaveError = new Error('Fictional body persistence failure')
    h.presenceCache.save.mockImplementation(async () => { throw presenceSaveError })
    h.cache.save.mockImplementation(async () => { throw bodySaveError })
    const lists = kept(h.holdList(ALDER, BIRCH))
    const service = h.start()
    const { presence } = await startHeldPresence(h, service, [ALDER, BIRCH])
    h.at(T('06:00:30.000'))
    const initial = await settles(progressive(service, { queued: true }), 'the extended initial response')
    const { id } = expectProgress(initial.progress, WAITING)
    const bodies = kept(h.holdBody(ALDER, BIRCH))
    lists.release()
    const index = await presence
    expect(index.boards.map(board => board.status)).toEqual(['ok', 'ok'])
    expect(onCacheError).toHaveBeenCalledTimes(1)
    expect(onCacheError).toHaveBeenCalledWith(presenceSaveError)
    const handoff = await nextUpdate(service, id, 0, { phase: 'collecting' })
    const afterHandoff = expectProgress(handoff.progress, { phase: 'collecting', total: 2, completed: 0, done: false }, 0).revision
    bodies.release()
    const final = await nextUpdate(service, id, afterHandoff, { done: true })
    expectProgress(final.progress, { phase: 'collecting', total: 2, completed: 2, done: true }, afterHandoff)
    expect(final.catalog.boards).toEqual([collected(alder, T('06:00:30.000')), collected(birch, T('06:00:30.000'))])
    expect(h.bodyCalls()).toEqual([ALDER, BIRCH])
    // Both failed writes were reported and neither failed the operation: body write, then the body operation's presence write.
    expect(h.cache.save).toHaveBeenCalledTimes(1)
    expect(h.presenceCache.save).toHaveBeenCalledTimes(2)
    expect(onCacheError.mock.calls.map(call => call[0])).toEqual([presenceSaveError, bodySaveError, presenceSaveError])
    expect(await unhandled.settle()).toEqual([])
  })

  it('reports a cache-load failure through an asynchronous reporter and still serves the cold waiting flow', async () => {
    const unhandled = captureUnhandled()
    const onCacheError = vi.fn(async () => {})
    const h = provenanceHarness({ onCacheError })
    const loadError = new Error('Fictional body cache load failure')
    h.cache.load.mockRejectedValueOnce(loadError)
    const lists = kept(h.holdList(ALDER, BIRCH))
    const service = h.start()
    const { presence } = await startHeldPresence(h, service, [ALDER, BIRCH])
    h.at(T('06:00:30.000'))
    const initial = await settles(progressive(service, { queued: true }), 'the extended initial response')
    const { id } = expectProgress(initial.progress, WAITING)
    expect(initial.catalog.boards).toEqual([cold(alder), cold(birch)])
    expect(onCacheError).toHaveBeenCalledTimes(1)
    expect(onCacheError).toHaveBeenCalledWith(loadError)
    lists.release()
    await presence
    const final = await nextUpdate(service, id, 0, { done: true })
    expectProgress(final.progress, { phase: 'collecting', total: 2, completed: 2, done: true }, 0)
    expect(h.bodyCalls()).toEqual([ALDER, BIRCH])
    expect(onCacheError).toHaveBeenCalledTimes(1)
    expect(await unhandled.settle()).toEqual([])
  })

  it.each(throwingReporters)('reports a rejected body persistence after handoff as the same terminal failure with %s while accepted bodies stay in memory', async (_label, reporter) => {
    const unhandled = captureUnhandled()
    const onCacheError = vi.fn(reporter())
    const h = provenanceHarness({ onCacheError })
    const bodySaveError = new Error('Fictional body persistence failure')
    h.cache.save.mockImplementation(async () => { throw bodySaveError })
    const lists = kept(h.holdList(ALDER, BIRCH))
    const service = h.start()
    const { presence } = await startHeldPresence(h, service, [ALDER, BIRCH])
    h.at(T('06:00:30.000'))
    const initial = await settles(progressive(service, { queued: true }), 'the extended initial response')
    const { id } = expectProgress(initial.progress, WAITING)
    const sync = outcome(service.get())
    const alderBody = kept(h.holdBody(ALDER))
    const birchBody = kept(h.holdBody(BIRCH))
    lists.release()
    await presence
    const handoff = await nextUpdate(service, id, 0, { phase: 'collecting' })
    const afterHandoff = expectProgress(handoff.progress, { phase: 'collecting', total: 2, completed: 0, done: false }, 0).revision
    alderBody.release()
    const alderDelta = await nextUpdate(service, id, afterHandoff)
    const afterAlder = expectProgress(alderDelta.progress, { phase: 'collecting', total: 2, completed: 1, done: false }, afterHandoff).revision
    expect(alderDelta.companyIds).toEqual([ALDER])
    expect(jobRows(alderDelta)).toEqual([[ALDER_JOB, T('06:00:30.000'), false]])
    expect(alderDelta.catalog.boards).toEqual([collected(alder, T('06:00:30.000')), pendingCold(birch, T('06:00:00.000'))])

    birchBody.release()
    const failure = await vi.waitFor(() => thrown(() => service.readProgress(id, afterAlder)))
    expectTerminalFailure(failure)
    for (const after of [0, afterHandoff, afterAlder]) expect(thrown(() => service.readProgress(id, after)).message).toBe(QUEUED_FAILURE_MESSAGE)
    const syncOutcome = await sync
    expect(syncOutcome).toBeInstanceOf(Error)
    expect((syncOutcome as Error).message).toBe(QUEUED_FAILURE_MESSAGE)
    expect(h.bodyCalls()).toEqual([ALDER, BIRCH])
    expect(h.cache.save).toHaveBeenCalledTimes(1)
    expect(await unhandled.settle()).toEqual([])
    expect(onCacheError).toHaveBeenCalledTimes(2)
    expect(onCacheError.mock.calls[0][0]).toBe(bodySaveError)
    expect((onCacheError.mock.calls[1][0] as Error).message).toBe('Fictional error reporter rejection')

    // Accepted bodies and their real times remain in memory, so the next request needs no body work.
    const memory = await settles(progressive(service, { queued: true }), 'the next extended request')
    expect(memory.progress).toBeNull()
    expect(memory.catalog.boards).toEqual([collected(alder, T('06:00:30.000')), collected(birch, T('06:00:30.000'))])
    expect(memory.catalog).toMatchObject({ fetchedAt: T('06:00:30.000'), checkedAt: T('06:00:30.000'), refreshAfter: T('06:01:30.000'), stale: false })
    expect(jobRows(memory.catalog)).toEqual([[ALDER_JOB, T('06:00:30.000'), false], [BIRCH_JOB, T('06:00:30.000'), false]])
    expect(h.bodyCalls()).toEqual([ALDER, BIRCH])
    // Nothing replaced the failed operation yet, so its id still reports the failure.
    expect(thrown(() => service.readProgress(id, 0)).message).toBe(QUEUED_FAILURE_MESSAGE)

    // A forced request after the interval allocates a replacement only after all owned bodies ended; the old id is gone.
    // The body write still fails, so this replacement is explicitly expected to fail the same way.
    h.at(T('06:01:30.000'))
    const replacementBodies = kept(h.holdBody(ALDER, BIRCH))
    const replacement = await settles(progressive(service, { force: true, queued: true }), 'a forced replacement')
    const replaced = expectProgress(replacement.progress, { phase: 'collecting', total: 2, completed: 0, done: false })
    expect(replaced.id).not.toBe(id)
    expect(() => service.readProgress(id, 0)).toThrow(CatalogProgressGoneError)
    const events = h.ledger()
    const bodyStarts = events.map((event, index) => event.kind === 'body' && event.phase === 'start' ? index : -1).filter(index => index >= 0)
    const bodyEnds = events.map((event, index) => event.kind === 'body' && event.phase === 'end' ? index : -1).filter(index => index >= 0)
    expect(bodyStarts).toHaveLength(4)
    expect(bodyEnds.filter(index => index < bodyStarts[2])).toHaveLength(2)
    replacementBodies.release()
    const replacementFailure = await vi.waitFor(() => thrown(() => service.readProgress(replaced.id, 0)))
    expectTerminalFailure(replacementFailure)
    expect(h.cache.save).toHaveBeenCalledTimes(2)
    expect(onCacheError).toHaveBeenCalledTimes(4)
    expect(await unhandled.settle()).toEqual([])
  })
})

describe('a status check queued behind a body operation that fails unexpectedly', () => {
  it('waits without list work, observes the dependency failure, keeps accepted bodies and invents no list failure history', async () => {
    const unhandled = captureUnhandled()
    const onCacheError = vi.fn((_error: unknown) => { throw new Error('Fictional error reporter rejection') })
    const h = provenanceHarness({ onCacheError })
    const bodySaveError = new Error('Fictional body persistence failure')
    h.cache.save.mockImplementationOnce(async () => { throw bodySaveError })
    const lists = kept(h.holdList(ALDER, BIRCH))
    const service = h.start()
    const { presence } = await startHeldPresence(h, service, [ALDER, BIRCH])
    h.at(T('06:00:30.000'))
    const initial = await settles(progressive(service, { queued: true }), 'the extended initial response')
    const { id } = expectProgress(initial.progress, WAITING)
    const bodies = kept(h.holdBody(ALDER, BIRCH))
    lists.release()
    await presence
    const handoff = await nextUpdate(service, id, 0, { phase: 'collecting' })
    expectProgress(handoff.progress, { phase: 'collecting', total: 2, completed: 0, done: false }, 0)
    await vi.waitFor(() => expect(h.bodyCalls()).toEqual([ALDER, BIRCH]))

    // A due status check arrives while bodies are held: it queues behind them and starts no list work.
    h.at(T('06:01:30.000'))
    const order = orderLedger()
    const queuedStatus = order.watch('status', outcome(service.getPostingStatus(true)))
    for (let round = 0; round < 3; round++) await new Promise<void>(resolve => setImmediate(resolve))
    expect(h.listCalls()).toEqual([ALDER, BIRCH])
    expect(order.marks).toEqual([])

    order.mark('bodies-released')
    bodies.release()
    const statusOutcome = await queuedStatus
    expect(order.marks).toEqual(['bodies-released', 'status'])
    expect(statusOutcome).toBeInstanceOf(Error)
    expect(statusOutcome).not.toBeInstanceOf(CatalogUnavailableError)
    expect(h.listCalls()).toEqual([ALDER, BIRCH])
    expect(h.bodyCalls()).toEqual([ALDER, BIRCH])
    expectTerminalFailure(thrown(() => service.readProgress(id, 0)))
    expect(onCacheError).toHaveBeenCalledTimes(2)
    expect(onCacheError.mock.calls[0][0]).toBe(bodySaveError)

    // Accepted bodies remain in memory and no company list failure was recorded for work that never ran.
    const memory = await settles(progressive(service, { queued: true }), 'an ordinary request after the failure')
    expect(memory.progress).toBeNull()
    expect(memory.catalog.boards).toEqual([collected(alder, T('06:00:30.000')), collected(birch, T('06:00:30.000'))])
    const index = await settles(service.getPostingStatus(), 'a status read from memory')
    expect(index.boards.map(board => [board.companyId, board.status, board.lastSuccessAt, board.retryAt, board.message ?? null]))
      .toEqual([[ALDER, 'ok', T('06:00:30.000'), null, null], [BIRCH, 'ok', T('06:00:30.000'), null, null]])
    expect(h.listCalls()).toEqual([ALDER, BIRCH])
    // A later forced check follows the ordinary due policy and runs its own lists.
    const later = await settles(service.getPostingStatus(true), 'a later forced status check')
    expect(later.boards.map(board => [board.companyId, board.status, board.lastSuccessAt])).toEqual([[ALDER, 'ok', T('06:01:30.000')], [BIRCH, 'ok', T('06:01:30.000')]])
    expect(h.listCalls()).toEqual([ALDER, BIRCH, ALDER, BIRCH])
    expect(h.presenceCache.save).toHaveBeenCalledTimes(2)
    expect(await unhandled.settle()).toEqual([])
  })
})

describe('an exceptional worker drains its siblings before ownership is released', () => {
  it('holds a body operation open while a sibling body is still active after one worker rejected, then fails it and collects the rest later', async () => {
    const unhandled = captureUnhandled()
    const fault = faultyRandom('Fictional body scheduler fault')
    const onCacheError = vi.fn()
    const h = provenanceHarness({ onCacheError, random: fault.random })
    let birchFails = true
    h.fetchBoard.mockImplementation(async (company, fetchedAt) => {
      if (company.id === BIRCH && birchFails) throw new BoardFetchError('HTTP 503')
      return contentResult(company, fetchedAt)
    })
    const alderBody = kept(h.holdBody(ALDER))
    const lists = kept(h.holdList(ALDER, BIRCH))
    const service = h.start()
    const { presence } = await startHeldPresence(h, service, [ALDER, BIRCH])
    h.at(T('06:00:30.000'))
    const initial = await settles(progressive(service, { queued: true }), 'the extended initial response')
    const { id } = expectProgress(initial.progress, WAITING)
    const sync = outcome(service.get())
    lists.release()
    await presence
    const handoff = await nextUpdate(service, id, 0, { phase: 'collecting' })
    const afterHandoff = expectProgress(handoff.progress, { phase: 'collecting', total: 2, completed: 0, done: false }, 0).revision
    // Birch's provider failure reaches the failure bookkeeping, where the injected jitter fault rejects its worker.
    await vi.waitFor(() => expect(fault.calls.faults).toBe(1))
    expect(h.bodyCalls()).toEqual([ALDER, BIRCH])
    for (let round = 0; round < 3; round++) await new Promise<void>(resolve => setImmediate(resolve))
    // Alder is still held: the operation is neither finished nor failed, and no new operation may start.
    expect(service.readProgress(id, afterHandoff)).toBeNull()
    const joined = await settles(progressive(service, { force: true, queued: true }), 'a forced request during the drain')
    expect((joined.progress as QueuedProgress).id).toBe(id)
    expectProgress(joined.progress, { phase: 'collecting', total: 2, completed: 0, done: false })
    for (let round = 0; round < 3; round++) await new Promise<void>(resolve => setImmediate(resolve))
    expect(h.bodyCalls()).toEqual([ALDER, BIRCH])
    expect(onCacheError).not.toHaveBeenCalled()

    alderBody.release()
    const failure = await vi.waitFor(() => thrown(() => service.readProgress(id, afterHandoff)))
    expectTerminalFailure(failure)
    const syncOutcome = await sync
    expect(syncOutcome).toBeInstanceOf(Error)
    expect((syncOutcome as Error).message).toBe(QUEUED_FAILURE_MESSAGE)
    expect(onCacheError).toHaveBeenCalledTimes(1)
    expect((onCacheError.mock.calls[0][0] as Error).message).toBe('Fictional body scheduler fault')
    expect(h.cache.save).not.toHaveBeenCalled()
    expect(h.bodyCalls()).toEqual([ALDER, BIRCH])

    // Alder's accepted body stays in memory; only Birch is eligible again, and its body starts after Alder's ended.
    // The replacement body is held first: intermediate collecting states may be skipped, so the
    // pending representation is only asserted while its provider request is deterministically open.
    birchFails = false
    const replacementBody = kept(h.holdBody(BIRCH))
    const next = await settles(progressive(service, { queued: true }), 'the next extended request')
    const replacement = expectProgress(next.progress, { phase: 'collecting', total: 1, completed: 0, done: false })
    expect(replacement.id).not.toBe(id)
    expect(next.catalog.boards).toEqual([collected(alder, T('06:00:30.000')), pendingCold(birch, T('06:00:00.000'))])
    await vi.waitFor(() => expect(h.bodyCalls()).toEqual([ALDER, BIRCH, BIRCH]))
    expect(service.readProgress(replacement.id, 0)).toBeNull()
    replacementBody.release()
    const final = await nextUpdate(service, replacement.id, 0, { done: true })
    expectProgress(final.progress, { phase: 'collecting', total: 1, completed: 1, done: true }, 0)
    expect(final.catalog.boards).toEqual([collected(alder, T('06:00:30.000')), collected(birch, T('06:00:30.000'))])
    expect(h.bodyCalls()).toEqual([ALDER, BIRCH, BIRCH])
    const events = h.ledger()
    const alderEnd = events.findIndex(event => event.kind === 'body' && event.companyId === ALDER && event.phase === 'end')
    const secondBirchStart = events.map((event, index) => event.kind === 'body' && event.companyId === BIRCH && event.phase === 'start' ? index : -1).filter(index => index >= 0)[1]
    expect(alderEnd).toBeGreaterThanOrEqual(0)
    expect(secondBirchStart).toBeGreaterThan(alderEnd)
    expect(await unhandled.settle()).toEqual([])
  })

  it('holds a list operation open while a sibling list is still active after one worker rejected, fails the queued operation, and lets later list work start only after the drain', async () => {
    const unhandled = captureUnhandled()
    const fault = faultyRandom('Fictional list scheduler fault')
    const onCacheError = vi.fn()
    const h = provenanceHarness({ onCacheError, random: fault.random })
    h.failList(BIRCH, 'HTTP 503')
    const birchList = kept(h.holdList(BIRCH))
    const alderList = kept(h.holdList(ALDER))
    const service = h.start()
    const first = outcome(service.getPostingStatus(true))
    await vi.waitFor(() => expect(h.listCalls()).toEqual([ALDER, BIRCH]))
    h.at(T('06:00:30.000'))
    const initial = await settles(progressive(service, { queued: true }), 'the extended initial response')
    const { id } = expectProgress(initial.progress, WAITING)
    const sync = outcome(service.get())

    // Birch's list failure reaches the failure bookkeeping, where the injected jitter fault rejects its worker.
    birchList.release()
    await vi.waitFor(() => expect(fault.calls.faults).toBe(1))
    for (let round = 0; round < 3; round++) await new Promise<void>(resolve => setImmediate(resolve))
    // Alder's list is still held: nothing settled, the operation still waits, and joiners attach to the same work.
    expect(service.readProgress(id, 0)).toBeNull()
    const second = outcome(service.getPostingStatus(true))
    const joined = await settles(progressive(service, { queued: true }), 'a joining extended request')
    expect((joined.progress as QueuedProgress).id).toBe(id)
    expectProgress(joined.progress, WAITING)
    for (let round = 0; round < 3; round++) await new Promise<void>(resolve => setImmediate(resolve))
    expect(h.listCalls()).toEqual([ALDER, BIRCH])
    expect(h.bodyCalls()).toEqual([])
    expect(onCacheError).not.toHaveBeenCalled()

    alderList.release()
    expect(await first).toBeInstanceOf(Error)
    expect(await second).toBeInstanceOf(Error)
    const failure = await vi.waitFor(() => thrown(() => service.readProgress(id, 0)))
    expectTerminalFailure(failure)
    const syncOutcome = await sync
    expect(syncOutcome).toBeInstanceOf(Error)
    expect((syncOutcome as Error).message).toBe(QUEUED_FAILURE_MESSAGE)
    expect(onCacheError).toHaveBeenCalledTimes(1)
    expect((onCacheError.mock.calls[0][0] as Error).message).toBe('Fictional list scheduler fault')
    expect(h.bodyCalls()).toEqual([])
    expect(h.presenceCache.save).not.toHaveBeenCalled()

    // Later list work starts only after the drained run, on a fresh operation once both companies are due again.
    h.failList(BIRCH, 'HTTP 503')
    h.at(T('06:01:30.000'))
    const third = await settles(service.getPostingStatus(true), 'a later status check')
    expect(third.boards.map(board => [board.companyId, board.status])).toEqual([[ALDER, 'ok'], [BIRCH, 'error']])
    expect(h.listCalls()).toEqual([ALDER, BIRCH, ALDER, BIRCH])
    const events = h.ledger()
    const firstRunAlderEnd = events.findIndex(event => event.kind === 'list' && event.companyId === ALDER && event.phase === 'end')
    const thirdRunStart = events.findIndex((event, index) => event.kind === 'list' && event.phase === 'start' && index > firstRunAlderEnd)
    expect(firstRunAlderEnd).toBeGreaterThanOrEqual(0)
    expect(thirdRunStart).toBeGreaterThan(firstRunAlderEnd)
    expect(h.presenceCache.save).toHaveBeenCalledTimes(1)
    expect(await unhandled.settle()).toEqual([])
  })
})
