import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createCatalogReader, requestPublicCatalog } from '../../src/lib/catalog-request'
import { catalogNeedsAttention, collectionHealth } from '../../shared/catalog-health'
import type { CatalogProgress } from '../../shared/catalog-progress'
import type { Catalog } from '../../shared/types'
import { progressSnapshot, progressUpdate } from '../fixtures/catalog-progress'
import {
  QUEUED_ASTER, QUEUED_COMPANIES, QUEUED_FAILURE_BODY, QUEUED_FAILURE_MESSAGE, QUEUED_ID, QUEUED_PREFER, QUEUED_ROWS, QUEUED_TIMES,
  queuedAsterJob, queuedBothCollected, queuedCollected, queuedHandoff, queuedMetadata, queuedPartial, queuedWaiting, queuedZeroWork,
} from '../fixtures/catalog-queued-progress'
import type { QueuedSnapshot, QueuedUpdate } from '../fixtures/catalog-queued-progress'

// Stage75 contract: docs/design/catalog-queued-progress.md (9b921a49…feff9).
// Authored JSON reaches the real decoder; merged catalogs are compared with
// literal rows. Existing identity/registry checks must survive the new phases.
const MALFORMED = '공고 데이터 형식'
const GONE_MESSAGE = '수집 진행 정보를 다시 연결해야 해요. 다시 조회하면 현재 공고부터 이어서 확인합니다.'
const ASTER_JOB = 'greenhouse-fixture-aster-transit-ledger'
const CEDAR_JOB = 'greenhouse-fixture-cedar-loom-studio'
const jobRows = (catalog: Catalog) => catalog.jobs.map(job => [job.id, job.fetchedAt, job.stale])
const accepted = (body: unknown, status = 202) => Response.json(body, { status, headers: { 'Retry-After': '1' } })
/** The reader's progress type will carry the phase; fixtures are compared structurally. */
const progressOf = (value: CatalogProgress | null) => value as unknown

describe('queued progress decoding', () => {
  it('accepts the cold path from waiting through metadata, handoff and one collected body with literal merges', async () => {
    const read = createCatalogReader()
    const waiting = await read(accepted(queuedWaiting('cold')), true)
    expect(progressOf(waiting.progress)).toEqual(queuedWaiting('cold').progress)
    expect(waiting.value.boards).toEqual([QUEUED_ROWS.asterCold, QUEUED_ROWS.cedarCold])
    expect(waiting.value.jobs).toEqual([])
    expect(waiting.value).toMatchObject({ fetchedAt: '', stale: false })
    expect(collectionHealth(waiting.value)).toEqual({ recent: 0, retained: 0, unavailable: 2, failed: 0, pending: 0 })

    const metadata = await read(Response.json(queuedMetadata('cold')), false)
    expect(progressOf(metadata.progress)).toEqual(queuedMetadata('cold').progress)
    expect(metadata.value.boards).toEqual([QUEUED_ROWS.asterCold, QUEUED_ROWS.cedarDeferred])
    expect(metadata.value.jobs).toEqual([])
    expect(metadata.value.companies).toEqual(QUEUED_COMPANIES)
    expect(metadata.value.cities).toEqual(queuedWaiting('cold').catalog.cities)
    expect(metadata.value).toMatchObject({ fetchedAt: '', checkedAt: QUEUED_TIMES.attempt, stale: false })
    expect(collectionHealth(metadata.value)).toEqual({ recent: 0, retained: 0, unavailable: 2, failed: 1, pending: 0 })

    const handoff = await read(Response.json(queuedHandoff()), false)
    expect(progressOf(handoff.progress)).toEqual(queuedHandoff().progress)
    expect(handoff.value.boards).toEqual([QUEUED_ROWS.asterPending, QUEUED_ROWS.cedarDeferred])
    expect(handoff.value.jobs).toEqual([])
    expect(collectionHealth(handoff.value)).toEqual({ recent: 0, retained: 0, unavailable: 1, failed: 1, pending: 1 })

    const collected = await read(Response.json(queuedCollected()), false)
    expect(progressOf(collected.progress)).toEqual(queuedCollected().progress)
    expect(collected.value.boards).toEqual([QUEUED_ROWS.asterCollected, QUEUED_ROWS.cedarDeferred])
    expect(jobRows(collected.value)).toEqual([[ASTER_JOB, QUEUED_TIMES.current, false]])
    expect(collected.value).toMatchObject({ fetchedAt: QUEUED_TIMES.current, checkedAt: QUEUED_TIMES.current, stale: false })
    expect(collectionHealth(collected.value)).toEqual({ recent: 1, retained: 0, unavailable: 1, failed: 1, pending: 0 })
    expect(catalogNeedsAttention(collected.value)).toBe(true)
  })

  it('accepts the fresh path from waiting through metadata to zero-work completion, re-marking only the deferred company as retained', async () => {
    const read = createCatalogReader()
    const waiting = await read(accepted(queuedWaiting('fresh')), true)
    expect(waiting.value.boards).toEqual([QUEUED_ROWS.asterFresh, QUEUED_ROWS.cedarFresh])
    expect(jobRows(waiting.value)).toEqual([[ASTER_JOB, QUEUED_TIMES.freshBody, false], [CEDAR_JOB, QUEUED_TIMES.freshBody, false]])
    expect(collectionHealth(waiting.value)).toEqual({ recent: 2, retained: 0, unavailable: 0, failed: 0, pending: 0 })
    expect(catalogNeedsAttention(waiting.value)).toBe(false)

    const metadata = await read(Response.json(queuedMetadata('fresh')), false)
    expect(progressOf(metadata.progress)).toEqual(queuedMetadata('fresh').progress)
    expect(metadata.value.boards).toEqual([QUEUED_ROWS.asterFresh, QUEUED_ROWS.cedarDeferredRetained])
    expect(jobRows(metadata.value)).toEqual([[ASTER_JOB, QUEUED_TIMES.freshBody, false], [CEDAR_JOB, QUEUED_TIMES.freshBody, true]])
    expect(metadata.value).toMatchObject({ fetchedAt: QUEUED_TIMES.freshBody, checkedAt: QUEUED_TIMES.attempt, stale: true })
    expect(collectionHealth(metadata.value)).toEqual({ recent: 1, retained: 1, unavailable: 0, failed: 1, pending: 0 })

    const zero = await read(Response.json(queuedZeroWork()), false)
    expect(progressOf(zero.progress)).toEqual({ id: QUEUED_ID, revision: 2, phase: 'collecting', total: 0, completed: 0, done: true })
    expect(zero.value.boards).toEqual([QUEUED_ROWS.asterFresh, QUEUED_ROWS.cedarDeferredRetained])
    expect(jobRows(zero.value)).toEqual([[ASTER_JOB, QUEUED_TIMES.freshBody, false], [CEDAR_JOB, QUEUED_TIMES.freshBody, true]])
    expect(zero.value).toMatchObject({ fetchedAt: QUEUED_TIMES.freshBody, stale: true })
  })

  it.each([
    ['waiting directly to the collected result', queuedWaiting('cold'), [queuedCollected()], [QUEUED_ROWS.asterCollected, QUEUED_ROWS.cedarDeferred], [[ASTER_JOB, QUEUED_TIMES.current, false]]],
    ['waiting directly to zero-work completion', queuedWaiting('fresh'), [queuedZeroWork(1)], [QUEUED_ROWS.asterFresh, QUEUED_ROWS.cedarDeferredRetained], [[ASTER_JOB, QUEUED_TIMES.freshBody, false], [CEDAR_JOB, QUEUED_TIMES.freshBody, true]]],
    ['waiting to handoff and then the collected result', queuedWaiting('cold'), [queuedHandoff(1), queuedCollected(2)], [QUEUED_ROWS.asterCollected, QUEUED_ROWS.cedarDeferred], [[ASTER_JOB, QUEUED_TIMES.current, false]]],
  ] as [string, QueuedSnapshot, QueuedUpdate[], unknown[], unknown[]][])('accepts %s under one id', async (_label, snapshot, deltas, boards, jobs) => {
    const read = createCatalogReader()
    await read(accepted(snapshot), true)
    let last!: Awaited<ReturnType<typeof read>>
    for (const delta of deltas) last = await read(Response.json(delta), false)
    expect(last.progress!.done).toBe(true)
    expect((last.progress as unknown as { id: string }).id).toBe(QUEUED_ID)
    expect(last.value.boards).toEqual(boards)
    expect(jobRows(last.value)).toEqual(jobs)
  })

  it('still accepts phase-less progress from an older server as the collecting phase', async () => {
    const read = createCatalogReader()
    const initial = await read(accepted(progressSnapshot(1)), true)
    expect(progressOf(initial.progress)).toEqual(progressSnapshot(1).progress)
    expect(initial.progress).not.toHaveProperty('phase')
    const final = await read(Response.json(progressUpdate(2)), false)
    expect(progressOf(final.progress)).toEqual(progressUpdate(2).progress)
    expect(final.value.jobs).toEqual(progressSnapshot(2).catalog.jobs)
  })

  const invalidSnapshots: [string, (snapshot: QueuedSnapshot) => unknown][] = [
    ['an unknown phase', snapshot => ({ ...snapshot, progress: { ...snapshot.progress, phase: 'queued' } })],
    ['a numeric total while waiting', snapshot => ({ ...snapshot, progress: { ...snapshot.progress, total: 2 } })],
    ['a zero total while waiting', snapshot => ({ ...snapshot, progress: { ...snapshot.progress, total: 0 } })],
    ['a completed count while waiting', snapshot => ({ ...snapshot, progress: { ...snapshot.progress, completed: 1 } })],
    ['a finished waiting state', snapshot => ({ ...snapshot, progress: { ...snapshot.progress, done: true } })],
    ['a pending board while waiting', snapshot => ({ ...snapshot, catalog: { ...snapshot.catalog, boards: [QUEUED_ROWS.asterPending, snapshot.catalog.boards[1]] } })],
    ['an undecided total in the collecting phase', snapshot => ({ ...snapshot, progress: { ...snapshot.progress, phase: 'collecting' } })],
    ['a zero total that is not done', snapshot => ({ ...snapshot, progress: { ...snapshot.progress, phase: 'collecting', total: 0 } })],
    ['a missing phase with a null total', snapshot => { const { phase: _phase, ...rest } = snapshot.progress; return { ...snapshot, progress: rest } }],
  ]
  it.each(invalidSnapshots)('rejects %s in the initial response before any data reaches the view', async (_label, corrupt) => {
    const read = createCatalogReader()
    await expect(read(accepted(corrupt(queuedWaiting('cold'))), true)).rejects.toThrow(MALFORMED)
  })

  const invalidWaitingDeltas: [string, (delta: QueuedUpdate) => unknown][] = [
    ['a body replacement while waiting', delta => ({ ...delta, companyIds: [QUEUED_ASTER.id], jobs: [queuedAsterJob()], catalog: { ...delta.catalog, boards: [QUEUED_ROWS.asterCollected, delta.catalog.boards[1]] } })],
    ['jobs without a replaced company while waiting', delta => ({ ...delta, jobs: [queuedAsterJob()] })],
    ['a completed count while waiting', delta => ({ ...delta, progress: { ...delta.progress, completed: 1 } })],
    ['a numeric total while waiting', delta => ({ ...delta, progress: { ...delta.progress, total: 1 } })],
    ['a collecting phase with an undecided total', delta => ({ ...delta, progress: { ...delta.progress, phase: 'collecting' } })],
    ['a zero total that is not done', delta => ({ ...delta, progress: { ...delta.progress, phase: 'collecting', total: 0 } })],
    ['pending boards that exceed the frozen total', delta => ({ ...delta, progress: { ...delta.progress, phase: 'collecting', total: 1 }, catalog: { ...delta.catalog, boards: [QUEUED_ROWS.asterPending, { ...QUEUED_ROWS.cedarCold, status: 'pending' }] } })],
    ['a different collection', delta => ({ ...delta, progress: { ...delta.progress, id: '00000000-0000-4000-8000-999999999999' } })],
    ['a non-advancing revision', delta => ({ ...delta, progress: { ...delta.progress, revision: 0 } })],
    ['a false completion', delta => ({ ...delta, progress: { ...delta.progress, phase: 'collecting', total: 1, completed: 0, done: true }, catalog: { ...delta.catalog, boards: [QUEUED_ROWS.asterPending, delta.catalog.boards[1]] } })],
    ['a foreign company replacement', delta => ({ ...delta, progress: { ...delta.progress, phase: 'collecting', total: 1, completed: 1, done: true }, companyIds: ['foreign'], jobs: [], catalog: { ...delta.catalog, boards: [QUEUED_ROWS.asterCollected, delta.catalog.boards[1]] } })],
  ]
  it.each(invalidWaitingDeltas)('rejects %s atomically, preserving the waiting snapshot', async (_label, corrupt) => {
    const read = createCatalogReader()
    const waiting = await read(accepted(queuedWaiting('cold')), true)
    await expect(read(Response.json(corrupt(queuedMetadata('cold'))), false)).rejects.toThrow(MALFORMED)
    // The reader keeps the last valid state; a later valid delta still applies on top of it.
    const collected = await read(Response.json(queuedCollected()), false)
    expect(collected.value.companies).toEqual(waiting.value.companies)
    expect(collected.value.boards).toEqual([QUEUED_ROWS.asterCollected, QUEUED_ROWS.cedarDeferred])
  })

  it('rejects a return to waiting and a changed frozen total after handoff', async () => {
    const reverse = createCatalogReader()
    await reverse(accepted(queuedWaiting('cold')), true)
    await reverse(Response.json(queuedHandoff(1)), false)
    await expect(reverse(Response.json(queuedMetadata('cold', 2)), false)).rejects.toThrow(MALFORMED)

    const grown = createCatalogReader()
    await grown(accepted(queuedWaiting('cold')), true)
    await grown(Response.json(queuedHandoff(1)), false)
    const expanded: QueuedUpdate = {
      ...queuedHandoff(2), progress: { ...queuedHandoff(2).progress, total: 2 },
      catalog: { ...queuedHandoff(2).catalog, boards: [QUEUED_ROWS.asterPending, { ...QUEUED_ROWS.cedarCold, status: 'pending' }] },
    }
    await expect(grown(Response.json(expanded), false)).rejects.toThrow(MALFORMED)
    const shrunk: QueuedUpdate = { ...queuedCollected(2), progress: { ...queuedCollected(2).progress, total: 0, completed: 0 } }
    await expect(grown(Response.json(shrunk), false)).rejects.toThrow(MALFORMED)
  })

  it('accepts waiting directly to a partially collected run, then its completion, with pending boards counted truthfully', async () => {
    const read = createCatalogReader()
    await read(accepted(queuedWaiting('cold')), true)
    const partial = await read(Response.json(queuedPartial()), false)
    expect(progressOf(partial.progress)).toEqual({ id: QUEUED_ID, revision: 2, phase: 'collecting', total: 2, completed: 1, done: false })
    expect(partial.value.boards).toEqual([QUEUED_ROWS.asterCollected, QUEUED_ROWS.cedarPending])
    expect(jobRows(partial.value)).toEqual([[ASTER_JOB, QUEUED_TIMES.current, false]])
    expect(partial.value).toMatchObject({ fetchedAt: QUEUED_TIMES.current, checkedAt: QUEUED_TIMES.current, stale: false })
    expect(collectionHealth(partial.value)).toEqual({ recent: 1, retained: 0, unavailable: 0, failed: 0, pending: 1 })
    expect(catalogNeedsAttention(partial.value)).toBe(false)
    const complete = await read(Response.json(queuedBothCollected()), false)
    expect(progressOf(complete.progress)).toEqual({ id: QUEUED_ID, revision: 3, phase: 'collecting', total: 2, completed: 2, done: true })
    expect(complete.value.boards).toEqual([QUEUED_ROWS.asterCollected, QUEUED_ROWS.cedarCollected])
    expect(jobRows(complete.value)).toEqual([[ASTER_JOB, QUEUED_TIMES.current, false], [CEDAR_JOB, QUEUED_TIMES.current, false]])
    expect(collectionHealth(complete.value)).toEqual({ recent: 2, retained: 0, unavailable: 0, failed: 0, pending: 0 })
    expect(catalogNeedsAttention(complete.value)).toBe(false)
  })

  it('rejects a waiting metadata delta that rewrites an unreplaced company\'s body history, keeping the delivered history intact', async () => {
    const read = createCatalogReader()
    const waiting = await read(accepted(queuedWaiting('fresh')), true)
    const rewritten = queuedMetadata('fresh')
    rewritten.catalog.boards = [QUEUED_ROWS.asterFresh, { ...QUEUED_ROWS.cedarDeferredRetained, lastSuccessAt: QUEUED_TIMES.current, checkedAt: QUEUED_TIMES.current }]
    await expect(read(Response.json(rewritten), false)).rejects.toThrow(MALFORMED)
    // The rejected delta changed nothing; the next valid metadata delta still applies on the delivered history.
    const metadata = await read(Response.json(queuedMetadata('fresh')), false)
    expect(metadata.value.boards.map(board => [board.companyId, board.lastSuccessAt])).toEqual([[QUEUED_ASTER.id, QUEUED_TIMES.freshBody], ['fixture-cedar-loom', QUEUED_TIMES.freshBody]])
    expect(jobRows(metadata.value)).toEqual([[ASTER_JOB, QUEUED_TIMES.freshBody, false], [CEDAR_JOB, QUEUED_TIMES.freshBody, true]])
    expect(metadata.value.companies).toEqual(waiting.value.companies)
    // Zero-work completion keeps the delivered history as well; only a completed replacement may carry a new body time.
    const zero = await read(Response.json(queuedZeroWork()), false)
    expect(zero.value.boards[1].lastSuccessAt).toBe(QUEUED_TIMES.freshBody)
  })
})

describe('browser stream over the negotiated protocol', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

  function run(fetcher: ReturnType<typeof vi.fn>, refresh = false) {
    vi.stubGlobal('fetch', fetcher)
    const controller = new AbortController()
    const onUpdate = vi.fn()
    const task = requestPublicCatalog({ refresh, signal: controller.signal, onUpdate })
    return { controller, onUpdate, task }
  }

  it('sends the exact extended preference on ordinary and refresh requests', async () => {
    const ordinary = vi.fn().mockResolvedValueOnce(Response.json(progressSnapshot(2).catalog))
    const first = run(ordinary)
    await first.task
    expect(first.onUpdate).toHaveBeenCalledWith(progressSnapshot(2).catalog, null)
    expect(ordinary.mock.calls[0]).toMatchObject(['/api/catalog?source=public', { headers: { Prefer: QUEUED_PREFER } }])
    vi.unstubAllGlobals()
    const forced = vi.fn().mockResolvedValueOnce(Response.json(progressSnapshot(2).catalog))
    const second = run(forced, true)
    await second.task
    expect(forced.mock.calls[0]).toMatchObject(['/api/catalog?source=public&refresh=1', { headers: { Prefer: QUEUED_PREFER } }])
  })

  it('keeps polling through the waiting phase, applies metadata and handoff, and stops after the collected result', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(accepted(queuedWaiting('cold')))
      .mockResolvedValueOnce(new Response(null, { status: 204, headers: { 'Retry-After': '1' } }))
      .mockResolvedValueOnce(Response.json(queuedMetadata('cold')))
      .mockResolvedValueOnce(new Response(null, { status: 204, headers: { 'Retry-After': '1' } }))
      .mockResolvedValueOnce(Response.json(queuedHandoff()))
      .mockResolvedValueOnce(Response.json(queuedCollected()))
    const { task, onUpdate } = run(fetcher)
    await vi.advanceTimersByTimeAsync(0)
    expect(onUpdate).toHaveBeenCalledTimes(1)
    expect(onUpdate.mock.calls[0][1]).toEqual(queuedWaiting('cold').progress)
    expect(onUpdate.mock.calls[0][0].jobs).toEqual([])
    for (let step = 0; step < 5; step++) await vi.advanceTimersByTimeAsync(1000)
    await task
    expect(onUpdate).toHaveBeenCalledTimes(4)
    expect(onUpdate.mock.calls.map(call => call[1])).toEqual([
      queuedWaiting('cold').progress, queuedMetadata('cold').progress, queuedHandoff().progress, queuedCollected().progress,
    ])
    expect(onUpdate.mock.calls[1][0].boards).toEqual([QUEUED_ROWS.asterCold, QUEUED_ROWS.cedarDeferred])
    expect(onUpdate.mock.calls[2][0].boards).toEqual([QUEUED_ROWS.asterPending, QUEUED_ROWS.cedarDeferred])
    expect(onUpdate.mock.calls[3][0].jobs.map((job: { id: string }) => job.id)).toEqual([ASTER_JOB])
    expect(fetcher.mock.calls[0]).toMatchObject(['/api/catalog?source=public', { headers: { Prefer: QUEUED_PREFER } }])
    expect(fetcher.mock.calls.slice(1).map(call => call[0])).toEqual([
      `/api/catalog/progress?id=${QUEUED_ID}&after=0`, `/api/catalog/progress?id=${QUEUED_ID}&after=0`,
      `/api/catalog/progress?id=${QUEUED_ID}&after=1`, `/api/catalog/progress?id=${QUEUED_ID}&after=1`,
      `/api/catalog/progress?id=${QUEUED_ID}&after=2`,
    ])
    expect(fetcher.mock.calls.slice(1).every(call => call[1].cache === 'no-store' && !call[1].body)).toBe(true)
    await vi.advanceTimersByTimeAsync(120000)
    expect(fetcher).toHaveBeenCalledTimes(6)
  })

  it('ends monitoring on the fixed error-only 503 with that message, no retry deadline and no further requests', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(accepted(queuedWaiting('fresh')))
      .mockResolvedValueOnce(Response.json(QUEUED_FAILURE_BODY, { status: 503 }))
    const { task, onUpdate } = run(fetcher)
    const rejected = expect(task).rejects.toMatchObject({ message: QUEUED_FAILURE_MESSAGE, code: undefined, retryAt: undefined })
    await vi.advanceTimersByTimeAsync(1000)
    await rejected
    expect(onUpdate).toHaveBeenCalledTimes(1)
    expect(jobRows(onUpdate.mock.calls[0][0])).toEqual([[ASTER_JOB, QUEUED_TIMES.freshBody, false], [CEDAR_JOB, QUEUED_TIMES.freshBody, false]])
    await vi.advanceTimersByTimeAsync(120000)
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('reports a restarted server\'s 410 for a waiting operation and keeps the delivered snapshot', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(accepted(queuedWaiting('cold')))
      .mockResolvedValueOnce(Response.json({ code: 'CATALOG_PROGRESS_GONE', error: GONE_MESSAGE }, { status: 410 }))
    const { task, onUpdate } = run(fetcher)
    const rejected = expect(task).rejects.toMatchObject({ message: GONE_MESSAGE, code: 'CATALOG_PROGRESS_GONE' })
    await vi.advanceTimersByTimeAsync(1000)
    await rejected
    expect(onUpdate).toHaveBeenCalledTimes(1)
    expect(fetcher).toHaveBeenCalledTimes(2)
  })
})
