import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BoardStatus } from '../../shared/types'
import {
  PROVENANCE_ALDER, PROVENANCE_BIRCH, PROVENANCE_CEDAR_DAILY, PROVENANCE_FAILURES,
  cachedBody, cachedPresence, contentResult, stamp,
} from '../fixtures/board-status-provenance'
import { provenanceHarness } from './helpers/board-status-provenance'

// Stage74 contract: docs/design/board-status-provenance.md. Expected rows are
// literal. Times are the injected service clock; nothing is derived from the
// product's status resolver, gate arithmetic or scheduler.
const ALDER = 'provenance-alder'
const BIRCH = 'provenance-birch'
const alder = { companyId: ALDER, board: 'AlderProvenance74', provider: 'greenhouse' } as const
const birch = { companyId: BIRCH, board: 'BirchProvenance74', provider: 'smartrecruiters' } as const
const collected = (identity: typeof alder | typeof birch, time: string, count = 1): BoardStatus => ({
  ...identity, status: 'ok', dataStatus: 'fresh', total: count, included: count, checkedAt: time, lastSuccessAt: time, retryAt: null,
})
/** Birch's public list failed at 06:00:00 before any body was ever collected. */
const BIRCH_DEFERRED: BoardStatus = {
  ...birch, status: 'error', dataStatus: 'unavailable', total: 0, included: 0,
  checkedAt: '2026-10-01T06:00:00.000Z', lastSuccessAt: null,
  retryAt: '2026-10-01T06:01:00.000Z', message: 'Fictional public list 503',
}
const oneMillisecondBefore = (iso: string) => new Date(Date.parse(iso) - 1).toISOString()

afterEach(() => { vi.restoreAllMocks() })

/** Saved-page list check fails for Birch, then public exploration collects only Alder. */
async function deferredMix() {
  const h = provenanceHarness()
  h.failList(BIRCH, PROVENANCE_FAILURES.list)
  const service = h.start()
  await service.getPostingStatus(true)
  h.at(stamp('06:00:30.000'))
  const catalog = await service.get()
  return { h, service, catalog }
}

describe('a public-list failure that defers full-content collection', () => {
  it('lists the deferred company as its own error while the healthy company is pending, then settled', async () => {
    const h = provenanceHarness()
    h.failList(BIRCH, PROVENANCE_FAILURES.list)
    const service = h.start()
    await service.getPostingStatus(true)
    expect([...h.listCalls()].sort()).toEqual([ALDER, BIRCH])
    h.at(stamp('06:00:30.000'))
    const held = h.holdBody(ALDER)
    const started = await service.getProgressive()
    expect(started.progress).toMatchObject({ total: 1, completed: 0, done: false })
    expect(started.catalog.fetchedAt).toBe('')
    expect(started.catalog.jobs).toEqual([])
    expect(started.catalog.boards[0]).toMatchObject({
      ...alder, status: 'pending', dataStatus: 'unavailable', total: 0, included: 0, lastSuccessAt: null, retryAt: null,
    })
    expect(started.catalog.boards[1]).toEqual(BIRCH_DEFERRED)
    expect(service.readProgress(started.progress!.id, 0)).toBeNull()
    const settled = service.get()
    held.release()
    const catalog = await settled
    expect(catalog.boards).toEqual([collected(alder, '2026-10-01T06:00:30.000Z'), BIRCH_DEFERRED])
    expect(catalog).toMatchObject({
      fetchedAt: '2026-10-01T06:00:30.000Z', checkedAt: '2026-10-01T06:00:30.000Z',
      refreshAfter: '2026-10-01T06:01:00.000Z', stale: false, unmappedCount: 0,
    })
    expect(catalog.jobs.map(job => [job.id, job.stale])).toEqual([['greenhouse-provenance-alder-7401', false]])
    const update = service.readProgress(started.progress!.id, 0)!
    expect(update.companyIds).toEqual([ALDER])
    expect(update.progress).toMatchObject({ total: 1, completed: 1, done: true })
    expect(update.catalog.boards).toEqual(catalog.boards)
    expect(update.jobs.map(job => job.id)).toEqual(['greenhouse-provenance-alder-7401'])
    expect(h.bodyCalls()).toEqual([ALDER])
    // The saved-screen index and the catalog describe the same failure record.
    const index = await service.getPostingStatus()
    expect(index.boards[1]).toMatchObject({
      status: 'error', message: 'Fictional public list 503', checkedAt: '2026-10-01T06:00:00.000Z',
      retryAt: '2026-10-01T06:01:00.000Z', lastSuccessAt: null,
    })
    expect(index.boards[1].listing).toBeUndefined()
    expect(h.listCalls()).toHaveLength(2)
  })

  it('makes no request for the deferred company before its deadline and collects it exactly at the deadline on an idle service', async () => {
    const { h, service, catalog } = await deferredMix()
    h.at(stamp('06:00:59.999'))
    expect((await service.get(true)).boards).toEqual(catalog.boards)
    expect((await service.getProgressive(true)).progress).toBeNull()
    await service.getPostingStatus(true)
    await service.getPostingStatus(true, true)
    expect(h.bodyCalls()).toEqual([ALDER])
    expect(h.listCalls()).toHaveLength(2)
    h.at(stamp('06:01:00.000'))
    const recovered = await service.get(true)
    expect(h.bodyCalls()).toEqual([ALDER, BIRCH])
    expect(recovered.boards[1]).toEqual(collected(birch, '2026-10-01T06:01:00.000Z'))
    expect(recovered).toMatchObject({ fetchedAt: '2026-10-01T06:01:00.000Z', checkedAt: '2026-10-01T06:01:00.000Z', stale: false })
    expect(recovered.jobs.map(job => job.id)).toEqual(['greenhouse-provenance-alder-7401', 'smartrecruiters-provenance-birch-7401'])
    // The complete body inventory resolves the older list failure although the list provider still fails.
    const index = await service.getPostingStatus()
    expect(index.boards[1]).toMatchObject({
      status: 'ok', lastSuccessAt: '2026-10-01T06:01:00.000Z', retryAt: null,
      listing: { publishedIds: ['smartrecruiters-provenance-birch-7401'] },
    })
    expect(index.boards[1].message).toBeUndefined()
    expect(h.listCalls()).toHaveLength(2)
  })

  it('reproduces the deferred row from persisted records after a restart without provider requests or history writes', async () => {
    const { h, service, catalog } = await deferredMix()
    const history = await service.getObservations()
    const saves = h.observationCache.saves()
    h.at(stamp('06:00:45.000'))
    const restarted = h.start()
    const again = await restarted.get()
    expect(again.boards).toEqual(catalog.boards)
    expect(again).toMatchObject({ fetchedAt: catalog.fetchedAt, checkedAt: catalog.checkedAt, refreshAfter: catalog.refreshAfter, stale: false })
    expect((await restarted.getProgressive()).progress).toBeNull()
    expect((await restarted.getPostingStatus()).boards[1]).toMatchObject({
      status: 'error', message: 'Fictional public list 503', checkedAt: '2026-10-01T06:00:00.000Z', retryAt: '2026-10-01T06:01:00.000Z',
    })
    expect(h.bodyCalls()).toEqual([ALDER])
    expect(h.listCalls()).toHaveLength(2)
    expect(h.cache.save).toHaveBeenCalledTimes(1)
    expect(h.cache.value().map(entry => entry.companyId)).toEqual([ALDER])
    expect(await restarted.getObservations()).toEqual(history)
    expect(h.observationCache.saves()).toBe(saves)
  })

  it('records the deferred company as missing from content history and writes no body or history entry for its list failure', async () => {
    const { h, service } = await deferredMix()
    const history = await service.getObservations()
    expect(history.days).toHaveLength(1)
    expect(history.days[0].latest).toMatchObject({
      observedAt: '2026-10-01T06:00:30.000Z', origin: 'collection',
      boards: [
        { companyId: ALDER, status: 'complete', checkedAt: '2026-10-01T06:00:30.000Z', lastSuccessAt: '2026-10-01T06:00:30.000Z' },
        { companyId: BIRCH, status: 'missing', checkedAt: null, lastSuccessAt: null },
      ],
    })
    expect(history.days[0].complete).toBeUndefined()
    expect(h.observationCache.saves()).toBe(1)
    expect(h.cache.save).toHaveBeenCalledTimes(1)
    expect(h.cache.value().map(entry => entry.companyId)).toEqual([ALDER])
    expect(h.presenceCache.value().find(entry => entry.companyId === BIRCH)).toMatchObject({
      error: 'Fictional public list 503', checkedAt: '2026-10-01T06:00:00.000Z', retryAt: '2026-10-01T06:01:00.000Z', failures: 1,
    })
    expect(h.presenceCache.value().find(entry => entry.companyId === BIRCH)?.snapshot).toBeUndefined()
    // Forced reads before the 06:01:00 deadline are blocked cached reads: no provider
    // attempt happens, and neither the body cache nor the history changes.
    h.at(stamp('06:00:50.000'))
    await service.getPostingStatus(true)
    await service.get(true)
    expect(h.listCalls()).toHaveLength(2)
    expect(h.bodyCalls()).toEqual([ALDER])
    expect(h.cache.save).toHaveBeenCalledTimes(1)
    expect(h.observationCache.saves()).toBe(1)
  })
})

describe('no usable body behind deferred list failures', () => {
  it('returns the existing all-unavailable error with the shared deadline instead of an empty success', async () => {
    const h = provenanceHarness()
    h.failEveryList(PROVENANCE_FAILURES.list)
    const service = h.start()
    await service.getPostingStatus(true)
    h.at(stamp('06:00:30.000'))
    await expect(service.get()).rejects.toMatchObject({ code: 'CATALOG_UNAVAILABLE', retryAt: '2026-10-01T06:01:00.000Z' })
    await expect(service.getProgressive()).rejects.toMatchObject({ code: 'CATALOG_UNAVAILABLE', retryAt: '2026-10-01T06:01:00.000Z' })
    expect(h.bodyCalls()).toEqual([])
    h.at(stamp('06:01:00.000'))
    const catalog = await service.get()
    expect(h.bodyCalls()).toEqual([ALDER, BIRCH])
    expect(catalog.boards).toEqual([collected(alder, '2026-10-01T06:01:00.000Z'), collected(birch, '2026-10-01T06:01:00.000Z')])
  })

  it('applies the sixty-second floor to persisted list failures whose retry deadline is null', async () => {
    const h = provenanceHarness({
      presences: [
        cachedPresence(PROVENANCE_ALDER, stamp('06:00:00.000'), { failure: { message: PROVENANCE_FAILURES.persistedList, retryAt: null } }),
        cachedPresence(PROVENANCE_BIRCH, stamp('06:00:00.000'), { failure: { message: PROVENANCE_FAILURES.persistedList, retryAt: null } }),
      ],
      at: stamp('06:00:30.000'),
    })
    const service = h.start()
    await expect(service.get()).rejects.toMatchObject({ code: 'CATALOG_UNAVAILABLE', retryAt: '2026-10-01T06:01:00.000Z' })
    expect(h.bodyCalls()).toEqual([])
    const index = await service.getPostingStatus()
    expect(index.boards.map(board => [board.status, board.message, board.retryAt])).toEqual([
      ['error', 'Fictional persisted list failure', '2026-10-01T06:01:00.000Z'],
      ['error', 'Fictional persisted list failure', '2026-10-01T06:01:00.000Z'],
    ])
    expect(h.listCalls()).toEqual([])
    h.at(stamp('06:01:00.000'))
    expect((await service.get()).boards.map(board => board.status)).toEqual(['ok', 'ok'])
    expect(h.bodyCalls()).toEqual([ALDER, BIRCH])
  })

  it('keeps bodies older than a day expired rather than unavailable while list failures defer their refresh', async () => {
    const h = provenanceHarness({
      bodies: [cachedBody(PROVENANCE_ALDER, '2026-09-30T05:00:00.000Z'), cachedBody(PROVENANCE_BIRCH, '2026-09-30T05:00:00.000Z')],
    })
    h.failEveryList(PROVENANCE_FAILURES.list)
    const service = h.start()
    await service.getPostingStatus(true)
    expect([...h.listCalls()].sort()).toEqual([ALDER, BIRCH])
    h.at(stamp('06:00:30.000'))
    await expect(service.get()).rejects.toMatchObject({ code: 'CATALOG_EXPIRED', retryAt: '2026-10-01T06:01:00.000Z' })
    expect(h.bodyCalls()).toEqual([])
  })
})

describe('retained content under a later public-list failure', () => {
  async function collectedBoth() {
    const h = provenanceHarness()
    h.fetchBoard.mockImplementation(async (company, fetchedAt) => contentResult(company, fetchedAt, company.id === BIRCH ? ['74001', '74002'] : ['7401']))
    const service = h.start()
    const first = await service.get()
    expect(first.boards).toEqual([collected(alder, '2026-10-01T06:00:00.000Z'), collected(birch, '2026-10-01T06:00:00.000Z', 2)])
    return { h, service }
  }

  it('marks young retained content stale with the failure\'s own details, keeps job times, and refetches only at the shared deadline', async () => {
    const { h, service } = await collectedBoth()
    h.at(stamp('06:20:00.000'))
    h.failList(BIRCH, 'HTTP 429', stamp('06:30:00.000'))
    await service.getPostingStatus(true)
    h.at(stamp('06:20:01.000'))
    const catalog = await service.get()
    expect(catalog.boards[1]).toEqual({
      ...birch, status: 'error', dataStatus: 'stale', total: 2, included: 2,
      checkedAt: '2026-10-01T06:20:00.000Z', lastSuccessAt: '2026-10-01T06:00:00.000Z',
      retryAt: '2026-10-01T06:30:00.000Z', message: 'HTTP 429',
    })
    expect(catalog.boards[0]).toEqual(collected(alder, '2026-10-01T06:00:00.000Z'))
    expect(catalog.jobs.map(job => [job.id, job.fetchedAt, job.stale])).toEqual([
      ['greenhouse-provenance-alder-7401', '2026-10-01T06:00:00.000Z', false],
      ['smartrecruiters-provenance-birch-74001', '2026-10-01T06:00:00.000Z', true],
      ['smartrecruiters-provenance-birch-74002', '2026-10-01T06:00:00.000Z', true],
    ])
    expect(catalog).toMatchObject({ stale: true, fetchedAt: '2026-10-01T06:00:00.000Z', checkedAt: '2026-10-01T06:20:00.000Z' })
    const index = await service.getPostingStatus()
    expect(index.boards[1]).toMatchObject({
      status: 'error', message: 'HTTP 429', checkedAt: '2026-10-01T06:20:00.000Z', retryAt: '2026-10-01T06:30:00.000Z',
      lastSuccessAt: '2026-10-01T06:00:00.000Z',
    })
    expect(h.bodyCalls()).toEqual([ALDER, BIRCH])
    h.at(stamp('06:29:59.999'))
    expect((await service.get()).boards).toEqual(catalog.boards)
    expect(h.bodyCalls()).toEqual([ALDER, BIRCH])
    h.at(stamp('06:30:00.000'))
    const recovered = await service.get()
    expect(h.bodyCalls()).toEqual([ALDER, BIRCH, ALDER, BIRCH])
    expect(recovered.boards[1]).toEqual(collected(birch, '2026-10-01T06:30:00.000Z', 2))
    expect(recovered.stale).toBe(false)
    expect(recovered.jobs.every(job => job.stale === false && job.fetchedAt === '2026-10-01T06:30:00.000Z')).toBe(true)
  })

  it('returns to fresh after a real list success inside the body window without refetching bodies or renewing body times', async () => {
    const { h, service } = await collectedBoth()
    h.at(stamp('06:20:00.000'))
    h.failList(BIRCH, PROVENANCE_FAILURES.list)
    await service.getPostingStatus(true)
    h.at(stamp('06:20:01.000'))
    const degraded = await service.get()
    expect(degraded.boards[1]).toEqual({
      ...birch, status: 'error', dataStatus: 'stale', total: 2, included: 2,
      checkedAt: '2026-10-01T06:20:00.000Z', lastSuccessAt: '2026-10-01T06:00:00.000Z',
      retryAt: '2026-10-01T06:21:00.000Z', message: 'Fictional public list 503',
    })
    expect(degraded.stale).toBe(true)
    h.at(stamp('06:21:00.000'))
    h.fetchPresence.mockImplementation(async company => ({ total: company.id === BIRCH ? 2 : 1, publishedIds: company.id === BIRCH
      ? ['smartrecruiters-provenance-birch-74001', 'smartrecruiters-provenance-birch-74002'] : ['greenhouse-provenance-alder-7401'] }))
    await service.getPostingStatus(true)
    expect(h.listCalls().filter(id => id === BIRCH)).toHaveLength(2)
    h.at(stamp('06:21:01.000'))
    const restored = await service.get()
    expect(restored.boards[1]).toEqual(collected(birch, '2026-10-01T06:00:00.000Z', 2))
    expect(restored.jobs.map(job => [job.id, job.fetchedAt, job.stale])).toEqual([
      ['greenhouse-provenance-alder-7401', '2026-10-01T06:00:00.000Z', false],
      ['smartrecruiters-provenance-birch-74001', '2026-10-01T06:00:00.000Z', false],
      ['smartrecruiters-provenance-birch-74002', '2026-10-01T06:00:00.000Z', false],
    ])
    // The aggregate attempt includes the accepted list check; body success time does not move.
    expect(restored).toMatchObject({ stale: false, fetchedAt: '2026-10-01T06:00:00.000Z', checkedAt: '2026-10-01T06:21:00.000Z' })
    expect(h.bodyCalls()).toEqual([ALDER, BIRCH])
    const index = await service.getPostingStatus()
    expect(index.boards[1]).toMatchObject({
      status: 'ok', lastSuccessAt: '2026-10-01T06:21:00.000Z',
      listing: { content: { checkedAt: '2026-10-01T06:00:00.000Z', status: 'ok' } },
    })
  })

  it('treats an authoritative empty body as a success that a later list failure marks stale without reviving jobs', async () => {
    const h = provenanceHarness()
    h.fetchBoard.mockImplementation(async (company, fetchedAt) => company.id === BIRCH
      ? { jobs: [], total: 0, unmappedCount: 0, publishedIds: [] } : contentResult(company, fetchedAt))
    const service = h.start()
    const first = await service.get()
    expect(first.boards[1]).toEqual(collected(birch, '2026-10-01T06:00:00.000Z', 0))
    h.at(stamp('06:01:00.000'))
    h.failList(BIRCH, PROVENANCE_FAILURES.list)
    await service.getPostingStatus(true)
    h.at(stamp('06:01:01.000'))
    const degraded = await service.get()
    expect(degraded.boards[1]).toEqual({
      ...birch, status: 'error', dataStatus: 'stale', total: 0, included: 0,
      checkedAt: '2026-10-01T06:01:00.000Z', lastSuccessAt: '2026-10-01T06:00:00.000Z',
      retryAt: '2026-10-01T06:02:00.000Z', message: 'Fictional public list 503',
    })
    expect(degraded.jobs.map(job => job.companyId)).toEqual([ALDER])
    expect(degraded).toMatchObject({ stale: true, fetchedAt: '2026-10-01T06:00:00.000Z' })
    expect(h.bodyCalls()).toEqual([ALDER, BIRCH])
  })

  it('keeps a pending retry dated and unresolved with no retry deadline while its run is in flight', async () => {
    const { h, service } = await collectedBoth()
    // The full body-attempt ledger as [company, requested time]; it is never cleared or reset.
    const attempts = () => h.fetchBoard.mock.calls.map(([company, fetchedAt]) => [company.id, fetchedAt])
    expect(attempts()).toEqual([[ALDER, '2026-10-01T06:00:00.000Z'], [BIRCH, '2026-10-01T06:00:00.000Z']])
    h.at(stamp('06:20:00.000'))
    h.failList(BIRCH, PROVENANCE_FAILURES.list)
    await service.getPostingStatus(true)
    h.at(stamp('06:30:00.000'))
    // Both bodies are due. Hold both: an unheld company would be replaced before the snapshot composes.
    const held = h.holdBody(ALDER, BIRCH)
    const started = await service.getProgressive()
    // Cumulative: the 06:00 initial collection plus one held 06:30 retry attempt per company.
    expect(attempts()).toEqual([
      [ALDER, '2026-10-01T06:00:00.000Z'], [BIRCH, '2026-10-01T06:00:00.000Z'],
      [ALDER, '2026-10-01T06:30:00.000Z'], [BIRCH, '2026-10-01T06:30:00.000Z'],
    ])
    expect(started.progress).toMatchObject({ total: 2, completed: 0, done: false })
    expect(started.catalog.boards[0]).toMatchObject({ ...alder, status: 'pending', dataStatus: 'stale', total: 1, included: 1, lastSuccessAt: '2026-10-01T06:00:00.000Z', retryAt: null })
    expect(started.catalog.boards[1]).toMatchObject({ ...birch, status: 'pending', dataStatus: 'stale', total: 2, included: 2, lastSuccessAt: '2026-10-01T06:00:00.000Z', retryAt: null })
    expect(started.catalog.jobs.map(job => [job.id, job.fetchedAt, job.stale])).toEqual([
      ['greenhouse-provenance-alder-7401', '2026-10-01T06:00:00.000Z', true],
      ['smartrecruiters-provenance-birch-74001', '2026-10-01T06:00:00.000Z', true],
      ['smartrecruiters-provenance-birch-74002', '2026-10-01T06:00:00.000Z', true],
    ])
    expect(service.readProgress(started.progress!.id, 0)).toBeNull()
    const settled = service.get()
    held.release()
    const catalog = await settled
    expect(catalog.boards).toEqual([collected(alder, '2026-10-01T06:30:00.000Z'), collected(birch, '2026-10-01T06:30:00.000Z', 2)])
    expect(catalog.jobs.every(job => job.stale === false && job.fetchedAt === '2026-10-01T06:30:00.000Z')).toBe(true)
    // Releasing the held attempts settles them without any additional provider call.
    expect(attempts()).toEqual([
      [ALDER, '2026-10-01T06:00:00.000Z'], [BIRCH, '2026-10-01T06:00:00.000Z'],
      [ALDER, '2026-10-01T06:30:00.000Z'], [BIRCH, '2026-10-01T06:30:00.000Z'],
    ])
  })

  it('keeps the deferred company\'s body at exactly 24 hours and excludes it one millisecond later while its failure remains', async () => {
    const h = provenanceHarness({
      bodies: [cachedBody(PROVENANCE_ALDER, stamp('05:59:00.000')), cachedBody(PROVENANCE_BIRCH, '2026-09-30T06:00:00.000Z')],
      presences: [cachedPresence(PROVENANCE_BIRCH, stamp('05:59:30.000'), { failure: { message: 'HTTP 429', retryAt: stamp('06:29:30.000') } })],
      at: stamp('06:00:00.000'),
    })
    const service = h.start()
    const retained = await service.get()
    expect(retained.boards[1]).toEqual({
      ...birch, status: 'error', dataStatus: 'stale', total: 1, included: 1,
      checkedAt: '2026-10-01T05:59:30.000Z', lastSuccessAt: '2026-09-30T06:00:00.000Z',
      retryAt: '2026-10-01T06:29:30.000Z', message: 'HTTP 429',
    })
    expect(retained.jobs.map(job => [job.id, job.stale])).toEqual([['greenhouse-provenance-alder-7401', false], ['smartrecruiters-provenance-birch-7401', true]])
    expect(retained.stale).toBe(true)
    h.at(stamp('06:00:00.001'))
    const expired = await service.get()
    expect(expired.boards[1]).toEqual({
      ...birch, status: 'error', dataStatus: 'unavailable', total: 0, included: 0,
      checkedAt: '2026-10-01T05:59:30.000Z', lastSuccessAt: '2026-09-30T06:00:00.000Z',
      retryAt: '2026-10-01T06:29:30.000Z', message: 'HTTP 429',
    })
    expect(expired.jobs.map(job => job.id)).toEqual(['greenhouse-provenance-alder-7401'])
    expect(expired).toMatchObject({ stale: false, fetchedAt: '2026-10-01T05:59:00.000Z' })
    expect(h.bodyCalls()).toEqual([])
  })
})

describe('failure selection between public-list and body records', () => {
  it('shows a persisted list failure over a newer legacy body without a complete inventory, then clears it on a real body success', async () => {
    // Legacy bodies recorded no inventory, so Alder also carries its own earlier successful list record.
    const h = provenanceHarness({
      bodies: [
        cachedBody(PROVENANCE_ALDER, stamp('05:35:00.000'), { body: { fetchedAt: stamp('05:35:00.000'), inventory: false } }),
        cachedBody(PROVENANCE_BIRCH, stamp('05:30:00.000'), { body: { fetchedAt: stamp('05:30:00.000'), inventory: false } }),
      ],
      presences: [
        cachedPresence(PROVENANCE_ALDER, stamp('05:35:00.000'), { inventory: { fetchedAt: stamp('05:35:00.000') } }),
        cachedPresence(PROVENANCE_BIRCH, stamp('05:20:00.000'), { failure: { message: PROVENANCE_FAILURES.legacyList, retryAt: stamp('05:50:00.000') } }),
      ],
      at: stamp('05:40:00.000'),
    })
    const service = h.start()
    const catalog = await service.get()
    expect(catalog.boards[0]).toEqual(collected(alder, '2026-10-01T05:35:00.000Z'))
    expect(catalog.boards[1]).toEqual({
      ...birch, status: 'error', dataStatus: 'stale', total: 1, included: 1,
      checkedAt: '2026-10-01T05:20:00.000Z', lastSuccessAt: '2026-10-01T05:30:00.000Z',
      retryAt: '2026-10-01T05:50:00.000Z', message: 'Fictional legacy list failure',
    })
    expect(catalog.jobs.map(job => [job.id, job.stale])).toEqual([['greenhouse-provenance-alder-7401', false], ['smartrecruiters-provenance-birch-7401', true]])
    expect(catalog).toMatchObject({ stale: true, fetchedAt: '2026-10-01T05:35:00.000Z', checkedAt: '2026-10-01T05:35:00.000Z' })
    expect((await service.getPostingStatus()).boards[1]).toMatchObject({
      status: 'error', message: 'Fictional legacy list failure', checkedAt: '2026-10-01T05:20:00.000Z', retryAt: '2026-10-01T05:50:00.000Z', lastSuccessAt: null,
    })
    expect(h.bodyCalls()).toEqual([])
    h.at(stamp('06:00:00.000'))
    const recovered = await service.get()
    expect(h.bodyCalls()).toEqual([BIRCH])
    expect(recovered.boards[1]).toEqual(collected(birch, '2026-10-01T06:00:00.000Z'))
    expect((await service.getPostingStatus()).boards[1]).toMatchObject({
      status: 'ok', lastSuccessAt: '2026-10-01T06:00:00.000Z', listing: { publishedIds: ['smartrecruiters-provenance-birch-7401'] },
    })
    expect(h.listCalls()).toEqual([])
  })

  it('keeps an older body failure visible after a newer successful list check and moves only the aggregate attempt time', async () => {
    const h = provenanceHarness({
      bodies: [
        cachedBody(PROVENANCE_ALDER, stamp('05:50:00.000')),
        cachedBody(PROVENANCE_BIRCH, stamp('06:00:00.000'), {
          body: { fetchedAt: stamp('05:00:00.000') },
          failure: { message: PROVENANCE_FAILURES.detail, retryAt: stamp('06:30:00.000'), phase: 'content' },
        }),
      ],
      presences: [cachedPresence(PROVENANCE_BIRCH, stamp('06:05:00.000'), { inventory: { fetchedAt: stamp('06:05:00.000') } })],
      at: stamp('06:05:30.000'),
    })
    const service = h.start()
    const catalog = await service.get()
    expect(catalog.boards[1]).toEqual({
      ...birch, status: 'error', dataStatus: 'stale', total: 1, included: 1,
      checkedAt: '2026-10-01T06:00:00.000Z', lastSuccessAt: '2026-10-01T05:00:00.000Z',
      retryAt: '2026-10-01T06:30:00.000Z', message: 'Fictional posting detail 503',
    })
    expect(catalog).toMatchObject({ stale: true, fetchedAt: '2026-10-01T05:50:00.000Z', checkedAt: '2026-10-01T06:05:00.000Z' })
    expect(catalog.jobs.map(job => [job.id, job.fetchedAt, job.stale])).toEqual([
      ['greenhouse-provenance-alder-7401', '2026-10-01T05:50:00.000Z', false],
      ['smartrecruiters-provenance-birch-7401', '2026-10-01T05:00:00.000Z', true],
    ])
    expect((await service.getPostingStatus()).boards[1]).toMatchObject({
      status: 'ok', checkedAt: '2026-10-01T06:05:00.000Z', lastSuccessAt: '2026-10-01T06:05:00.000Z', retryAt: null,
      listing: { jobs: [], content: { checkedAt: '2026-10-01T05:00:00.000Z', status: 'error' } },
    })
    expect(h.bodyCalls()).toEqual([])
    expect(h.listCalls()).toEqual([])
  })

  it.each([
    {
      label: 'a newer body failure over an older list failure',
      body: { checkedAt: '06:02:00.000', retryAt: '06:30:00.000' }, list: { checkedAt: '06:00:00.000', retryAt: '06:01:00.000' },
      message: 'Fictional posting detail 503', checkedAt: '2026-10-01T06:02:00.000Z',
    },
    {
      label: 'a newer list failure over an older body failure that still owns the longer deadline',
      body: { checkedAt: '06:00:00.000', retryAt: '06:30:00.000' }, list: { checkedAt: '06:02:00.000', retryAt: '06:03:00.000' },
      message: 'Fictional public list 503', checkedAt: '2026-10-01T06:02:00.000Z',
    },
    {
      label: 'the body failure when two distinct failures share one timestamp',
      body: { checkedAt: '06:00:00.000', retryAt: '06:30:00.000' }, list: { checkedAt: '06:00:00.000', retryAt: '06:01:00.000' },
      message: 'Fictional posting detail 503', checkedAt: '2026-10-01T06:00:00.000Z',
    },
  ])('selects $label and reports the shared body retry gate', async ({ body, list, message, checkedAt }) => {
    const h = provenanceHarness({
      bodies: [
        cachedBody(PROVENANCE_ALDER, stamp('05:50:00.000')),
        cachedBody(PROVENANCE_BIRCH, stamp(body.checkedAt), {
          body: { fetchedAt: stamp('05:00:00.000') },
          failure: { message: PROVENANCE_FAILURES.detail, retryAt: stamp(body.retryAt), phase: 'content' },
        }),
      ],
      presences: [cachedPresence(PROVENANCE_BIRCH, stamp(list.checkedAt), { failure: { message: PROVENANCE_FAILURES.list, retryAt: stamp(list.retryAt) } })],
      at: stamp('06:05:30.000'),
    })
    const service = h.start()
    const catalog = await service.get()
    expect(catalog.boards[1]).toEqual({
      ...birch, status: 'error', dataStatus: 'stale', total: 1, included: 1,
      checkedAt, lastSuccessAt: '2026-10-01T05:00:00.000Z', retryAt: '2026-10-01T06:30:00.000Z', message,
    })
    expect((await service.getPostingStatus()).boards[1]).toMatchObject({
      status: 'error', message: 'Fictional public list 503', checkedAt: stamp(list.checkedAt), retryAt: '2026-10-01T06:30:00.000Z',
    })
    expect(h.bodyCalls()).toEqual([])
    expect(h.listCalls()).toEqual([])
  })
})

describe('the shared sixty-second failure floor between list and body operations', () => {
  const deadlines = [
    { label: 'a null deadline', retryAt: null, deadline: '2026-10-01T06:01:00.000Z' },
    { label: 'a ten-second deadline', retryAt: stamp('06:00:10.000'), deadline: '2026-10-01T06:01:00.000Z' },
    { label: 'a ten-minute Retry-After', retryAt: stamp('06:10:00.000'), deadline: '2026-10-01T06:10:00.000Z' },
  ]

  it.each(deadlines)('a persisted list failure with $label blocks body collection until the floor and reports that deadline', async ({ retryAt, deadline }) => {
    const h = provenanceHarness({
      bodies: [cachedBody(PROVENANCE_ALDER, stamp('06:00:30.000'))],
      presences: [cachedPresence(PROVENANCE_BIRCH, stamp('06:00:00.000'), { failure: { message: PROVENANCE_FAILURES.persistedList, retryAt } })],
      at: oneMillisecondBefore(deadline),
    })
    const service = h.start()
    const blocked = await service.get(true)
    expect(h.bodyCalls()).not.toContain(BIRCH)
    expect(blocked.boards[1]).toEqual({
      ...birch, status: 'error', dataStatus: 'unavailable', total: 0, included: 0,
      checkedAt: '2026-10-01T06:00:00.000Z', lastSuccessAt: null, retryAt: deadline, message: 'Fictional persisted list failure',
    })
    expect((await service.getPostingStatus()).boards[1]).toMatchObject({ status: 'error', retryAt: deadline })
    expect(h.listCalls()).not.toContain(BIRCH)
    h.at(deadline)
    const eligible = await service.get(true)
    expect(h.bodyCalls().filter(id => id === BIRCH)).toEqual([BIRCH])
    expect(eligible.boards[1]).toEqual(collected(birch, deadline))
  })

  it.each(deadlines)('a persisted body failure with $label blocks the public-list check until the floor and reports that deadline', async ({ retryAt, deadline }) => {
    const h = provenanceHarness({
      bodies: [
        cachedBody(PROVENANCE_ALDER, stamp('06:00:30.000')),
        cachedBody(PROVENANCE_BIRCH, stamp('06:00:00.000'), { body: null, failure: { message: PROVENANCE_FAILURES.persistedDetail, retryAt, phase: 'content' } }),
      ],
      at: oneMillisecondBefore(deadline),
    })
    const service = h.start()
    const blocked = await service.getPostingStatus(true)
    expect(h.listCalls()).not.toContain(BIRCH)
    expect(blocked.boards[1]).toMatchObject({
      status: 'error', message: 'Fictional persisted detail failure', checkedAt: '2026-10-01T06:00:00.000Z', retryAt: deadline, lastSuccessAt: null,
    })
    expect(blocked.boards[1].listing).toBeUndefined()
    expect((await service.get()).boards[1]).toEqual({
      ...birch, status: 'error', dataStatus: 'unavailable', total: 0, included: 0,
      checkedAt: '2026-10-01T06:00:00.000Z', lastSuccessAt: null, retryAt: deadline, message: 'Fictional persisted detail failure',
    })
    expect(h.bodyCalls()).not.toContain(BIRCH)
    h.at(deadline)
    const eligible = await service.getPostingStatus(true)
    expect(h.listCalls().filter(id => id === BIRCH)).toEqual([BIRCH])
    expect(eligible.boards[1]).toMatchObject({
      status: 'ok', checkedAt: deadline, lastSuccessAt: deadline, retryAt: null,
      listing: { publishedIds: ['smartrecruiters-provenance-birch-7401'], jobs: [] },
    })
    expect(h.bodyCalls()).not.toContain(BIRCH)
  })

  it.each([['ordinary', PROVENANCE_ALDER], ['daily', PROVENANCE_CEDAR_DAILY]] as const)('lets a %s body collection start right after a healthy list check without sharing that cooldown', async (_label, company) => {
    const h = provenanceHarness({ companies: [company] })
    const service = h.start()
    await service.getPostingStatus(true)
    expect(h.listCalls()).toEqual([company.id])
    h.at('2026-10-01T06:00:00.001Z')
    const catalog = await service.get()
    expect(h.bodyCalls()).toEqual([company.id])
    expect(catalog.boards[0]).toMatchObject({
      companyId: company.id, status: 'ok', dataStatus: 'fresh', total: 1, included: 1,
      checkedAt: '2026-10-01T06:00:00.001Z', lastSuccessAt: '2026-10-01T06:00:00.001Z', retryAt: null,
    })
    expect(catalog.jobs.map(job => job.id)).toEqual([`${company.provider}-${company.id}-7401`])
  })
})
