import { describe, expect, it, vi } from 'vitest'
import { BoardFetchError, CATALOG_POLICY, CatalogProgressGoneError, createCatalogService } from '../../server/catalog-service'
import type { BoardResult } from '../../server/catalog-service'
import type { BoardCache, CachedBoard } from '../../server/board-cache'
import { applyCatalogUpdate } from '../../shared/catalog-progress'
import { ageCatalog } from '../../shared/catalog-freshness'
import { catalogNeedsAttention, collectionHealth } from '../../shared/catalog-health'
import type { Company } from '../../shared/types'
import { SEARCH_COMPANIES as companies, SEARCH_TIME, searchJob } from '../fixtures/search-catalog'

const base = Date.parse(SEARCH_TIME)
const iso = (time: number) => new Date(time).toISOString()
const job = (company: Company, time = base, id = 'new') => searchJob(id, {
  companyId: company.id, id: `greenhouse-${company.id}-${id}`, fetchedAt: iso(time),
})
const result = (company: Company, time = base): BoardResult => ({
  jobs: [job(company, time)], total: 1, unmappedCount: 0, publishedIds: [job(company, time).id],
})
const cached = (company: Company, time = base): CachedBoard => ({
  companyId: company.id, board: company.board!, provider: 'greenhouse', checkedAt: iso(time), failures: 0, retryAt: null,
  snapshot: { ...result(company, time), fetchedAt: iso(time) },
})
const memory = (initial: CachedBoard[] = []): BoardCache => ({
  load: vi.fn(async () => structuredClone(initial)), save: vi.fn(async () => {}),
})
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

describe('incremental company collection', () => {
  it('publishes the first validated company before the slowest finishes and coalesces classic and progressive readers', async () => {
    const gates = companies.map(() => deferred<BoardResult>())
    const fetchBoard = vi.fn((company: Company) => gates[companies.indexOf(company)].promise)
    const cache = memory()
    const service = createCatalogService({ companies, cache, fetchBoard, now: () => base })
    const initial = await service.getProgressive()
    expect(initial.catalog).toMatchObject({ fetchedAt: '', jobs: [], boards: [{ status: 'pending' }, { status: 'pending' }] })
    expect(initial.progress).toMatchObject({ completed: 0, total: 2, revision: 0, done: false })
    expect(catalogNeedsAttention(initial.catalog)).toBe(false)
    expect(collectionHealth(initial.catalog)).toMatchObject({ failed: 0, unavailable: 0, pending: 2 })
    expect((await service.getProgressive(true)).progress!.id).toBe(initial.progress!.id)
    let classicFinished = false
    const classic = service.get().then(value => { classicFinished = true; return value })
    expect(fetchBoard).toHaveBeenCalledTimes(2)

    // Finish B before A: final ordering must still match the configured catalog.
    gates[1].resolve(result(companies[1]))
    await vi.waitFor(() => expect(service.readProgress(initial.progress!.id, 0)?.progress.completed).toBe(1))
    const first = service.readProgress(initial.progress!.id, 0)!
    expect(first.companyIds).toEqual([companies[1].id])
    expect(first.jobs.map(job => job.companyId)).toEqual([companies[1].id])
    expect(first.progress.done).toBe(false)
    expect(classicFinished).toBe(false)
    expect(service.readProgress(first.progress.id, first.progress.revision)).toBeNull()
    expect(cache.save).not.toHaveBeenCalled()
    const partial = applyCatalogUpdate(initial.catalog, first)
    expect(partial.fetchedAt).toBe(SEARCH_TIME)

    gates[0].resolve(result(companies[0]))
    const complete = await classic
    const last = service.readProgress(first.progress.id, first.progress.revision)!
    expect(last.companyIds).toEqual([companies[0].id])
    expect(last.progress).toMatchObject({ completed: 2, done: true })
    expect(applyCatalogUpdate(partial, last)).toEqual(complete)
    expect(cache.save).toHaveBeenCalledOnce()
    expect(fetchBoard).toHaveBeenCalledTimes(2)
    expect((await service.getPostingStatus()).boards.every(board => board.listing?.publishedIds.length === 1)).toBe(true)
  })

  it('returns a fresh cache immediately without starting a collection or inventing progress', async () => {
    const fetchBoard = vi.fn()
    const service = createCatalogService({ companies, cache: memory(companies.map(company => cached(company))), fetchBoard, now: () => base + 1000 })
    const result = await service.getProgressive()
    expect(result.progress).toBeNull()
    expect(result.catalog.jobs).toHaveLength(2)
    expect(fetchBoard).not.toHaveBeenCalled()
    expect(() => service.readProgress('missing', 0)).toThrow(CatalogProgressGoneError)
  })

  it('shows dated cache during refresh, removes an authoritative empty company, and retains only a failed company', async () => {
    const now = base + CATALOG_POLICY.freshFor
    const gates = companies.map(() => deferred<BoardResult>())
    const service = createCatalogService({
      companies, cache: memory(companies.map(company => cached(company))),
      fetchBoard: company => gates[companies.indexOf(company)].promise, now: () => now, random: () => 0,
    })
    const initial = await service.getProgressive()
    expect(initial.catalog.jobs).toHaveLength(2)
    expect(initial.catalog.jobs.every(job => job.stale && job.fetchedAt === SEARCH_TIME)).toBe(true)
    const completed = service.get()
    gates[0].resolve({ jobs: [], total: 0, unmappedCount: 0, publishedIds: [] })
    await vi.waitFor(() => expect(service.readProgress(initial.progress!.id, 0)?.progress.completed).toBe(1))
    const first = service.readProgress(initial.progress!.id, 0)!
    const partial = applyCatalogUpdate(initial.catalog, first)
    expect(first.companyIds).toEqual([companies[0].id])
    expect(first.jobs).toEqual([])
    expect(partial.jobs.map(job => job.companyId)).toEqual([companies[1].id])
    gates[1].reject(new BoardFetchError('HTTP 503'))
    await completed
    const final = applyCatalogUpdate(partial, service.readProgress(first.progress.id, first.progress.revision)!)
    expect(final.jobs).toMatchObject([{ companyId: companies[1].id, fetchedAt: SEARCH_TIME, stale: true }])
    expect(final.boards).toMatchObject([{ status: 'ok', included: 0 }, { status: 'error', dataStatus: 'stale', retryAt: iso(now + 60000) }])
  })

  it('monitoring does not retry a fast failure, even when its retry deadline passes while another board is still collecting', async () => {
    let now = base
    const slow = deferred<BoardResult>()
    const fetchBoard = vi.fn(async (company: Company) => {
      if (company.id === companies[0].id) throw new BoardFetchError('HTTP 429', base + 60000)
      return slow.promise
    })
    const service = createCatalogService({ companies, cache: memory(), fetchBoard, now: () => now, random: () => 0 })
    const initial = await service.getProgressive()
    await vi.waitFor(() => expect(service.readProgress(initial.progress!.id, 0)?.progress.completed).toBe(1))
    const first = service.readProgress(initial.progress!.id, 0)!
    now += 120000
    for (let n = 0; n < 5; n++) expect(service.readProgress(first.progress.id, first.progress.revision)).toBeNull()
    expect((await service.getProgressive(true)).progress!.id).toBe(first.progress.id)
    expect(fetchBoard).toHaveBeenCalledTimes(2)
    slow.resolve(result(companies[1]))
    await vi.waitFor(() => expect(service.readProgress(first.progress.id, first.progress.revision)?.progress.done).toBe(true))
    for (let n = 0; n < 5; n++) service.readProgress(first.progress.id, first.progress.revision)
    expect(fetchBoard).toHaveBeenCalledTimes(2)
  })

  it.each([false, true])('does not turn an all-failed collection into a successful empty result (expired cache: %s)', async expired => {
    const gates = companies.map(() => deferred<BoardResult>())
    const now = base + CATALOG_POLICY.maxFallbackAge + 1
    const service = createCatalogService({
      companies, cache: memory(expired ? companies.map(company => cached(company)) : []),
      fetchBoard: company => gates[companies.indexOf(company)].promise, now: () => now, random: () => 0,
    })
    const initial = await service.getProgressive()
    expect(initial.catalog.jobs).toEqual([])
    expect(initial.catalog.fetchedAt).toBe('')
    gates.forEach(gate => gate.reject(new BoardFetchError('HTTP 503')))
    await vi.waitFor(() => expect(() => service.readProgress(initial.progress!.id, 0)).toThrow(expect.objectContaining({
      code: expired ? 'CATALOG_EXPIRED' : 'CATALOG_UNAVAILABLE', retryAt: iso(now + 60000),
    })))
  })

  it('expires retained snapshots while waiting without renewing their original date or persisting pending statuses', async () => {
    let now = base + CATALOG_POLICY.maxFallbackAge - 1000
    const gates = companies.map(() => deferred<BoardResult>())
    const cache = memory(companies.map(company => cached(company)))
    const service = createCatalogService({ companies, cache, fetchBoard: company => gates[companies.indexOf(company)].promise, now: () => now })
    const initial = await service.getProgressive()
    now += 1001
    const aged = ageCatalog(initial.catalog, now)
    expect(aged.catalog.jobs).toEqual([])
    expect(aged.catalog.boards[0]).toMatchObject({ status: 'pending', lastSuccessAt: SEARCH_TIME })
    expect(initial.catalog.jobs).toHaveLength(2)
    // The providers retain the start timestamp supplied when their work began.
    gates.forEach((gate, index) => gate.resolve(result(companies[index], now - 1001)))
    await vi.waitFor(() => expect(service.readProgress(initial.progress!.id, 0)?.progress.done).toBe(true))
    const written = vi.mocked(cache.save).mock.calls[0][0]
    expect(written.every(board => !('status' in board))).toBe(true)
    expect(written[0].snapshot?.fetchedAt).toBe(iso(now - 1001))
  })

  it('rejects a superseded collection and invalid revision instead of combining generations or starting new work', async () => {
    let now = base
    const fetchBoard = vi.fn(async (company: Company, fetchedAt: string) => result(company, Date.parse(fetchedAt)))
    const service = createCatalogService({ companies, cache: memory(), fetchBoard, now: () => now })
    const firstPromise = service.getProgressive()
    const first = await firstPromise
    await service.get()
    const id = first.progress!.id
    expect(() => service.readProgress(id, -1)).toThrow(RangeError)
    expect(() => service.readProgress(id, 100)).toThrow(RangeError)
    now += CATALOG_POLICY.minRefreshInterval
    await service.getProgressive(true)
    await service.get()
    expect(() => service.readProgress(id, 0)).toThrow(CatalogProgressGoneError)
    expect(fetchBoard).toHaveBeenCalledTimes(4)
  })
})
