import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { requestPublicCatalog } from '../../src/lib/catalog-request'
import { COLLECTION_ID, progressSnapshot, progressUpdate } from '../fixtures/catalog-progress'
import type { CatalogCollectionUpdate } from '../../shared/catalog-progress'
import type { Catalog } from '../../shared/types'
import { searchCatalog } from '../fixtures/search-catalog'

beforeEach(() => vi.useFakeTimers())
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })
const accepted = (retry = '1') => Response.json(progressSnapshot(), { status: 202, headers: { 'Retry-After': retry } })

function run(fetcher: ReturnType<typeof vi.fn>) {
  vi.stubGlobal('fetch', fetcher)
  const controller = new AbortController()
  const onUpdate = vi.fn()
  const task = requestPublicCatalog({ refresh: false, signal: controller.signal, onUpdate })
  return { controller, onUpdate, task }
}

describe('browser collection protocol', () => {
  it('renders each new snapshot, skips unchanged responses and stops polling after the last company', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(accepted())
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(Response.json(progressUpdate(1)))
      .mockResolvedValueOnce(Response.json(progressUpdate(2)))
    const { task, onUpdate } = run(fetcher)
    await vi.advanceTimersByTimeAsync(0)
    expect(onUpdate.mock.calls[0][0].jobs).toEqual([])
    await vi.advanceTimersByTimeAsync(1000)
    expect(onUpdate).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1000)
    expect(onUpdate.mock.calls[1][0].jobs.map((job: { companyId: string }) => job.companyId)).toEqual(['search-fixture-a'])
    await vi.advanceTimersByTimeAsync(1000)
    await task
    expect(onUpdate.mock.lastCall![0].jobs).toEqual(progressSnapshot(2).catalog.jobs)
    expect(onUpdate.mock.lastCall![1].done).toBe(true)
    await vi.advanceTimersByTimeAsync(120000)
    expect(fetcher).toHaveBeenCalledTimes(4)
    expect(fetcher.mock.calls[0]).toMatchObject(['/api/catalog?source=public', { headers: { Prefer: 'respond-async' } }])
    expect(fetcher.mock.calls.slice(1).map(call => call[0])).toEqual([
      `/api/catalog/progress?id=${COLLECTION_ID}&after=0`, `/api/catalog/progress?id=${COLLECTION_ID}&after=0`,
      `/api/catalog/progress?id=${COLLECTION_ID}&after=1`,
    ])
    expect(fetcher.mock.calls.slice(1).every(call => call[1].cache === 'no-store' && !call[1].body)).toBe(true)
  })

  it('keeps the existing immediate catalog response usable without a polling loop', async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json(progressSnapshot(2).catalog))
    const { task, onUpdate } = run(fetcher)
    await task
    expect(onUpdate).toHaveBeenCalledWith(progressSnapshot(2).catalog, null)
    await vi.advanceTimersByTimeAsync(120000)
    expect(fetcher).toHaveBeenCalledOnce()
  })

  const malformedCatalogs: [string, (catalog: Catalog) => unknown][] = [
    ['null city', catalog => ({ ...catalog, cities: [null, ...catalog.cities.slice(1)] })],
    ['invalid coordinates', catalog => ({ ...catalog, cities: [{ ...catalog.cities[0], lat: 91 }, ...catalog.cities.slice(1)] })],
    ['non-text company name', catalog => ({ ...catalog, companies: [{ ...catalog.companies[0], name: {} }, ...catalog.companies.slice(1)] })],
    ['missing job requirements', catalog => ({ ...catalog, jobs: [{ ...catalog.jobs[0], requirements: null }, ...catalog.jobs.slice(1)] })],
    ['invalid nested qualifications', catalog => ({ ...catalog, jobs: [{ ...catalog.jobs[0], qualifications: { version: 1, skills: null, experience: [] } }, ...catalog.jobs.slice(1)] })],
    ['invalid job timestamp', catalog => ({ ...catalog, jobs: [{ ...catalog.jobs[0], fetchedAt: 'not a date' }, ...catalog.jobs.slice(1)] })],
    ['invalid board timestamp', catalog => ({ ...catalog, boards: [{ ...catalog.boards[0], retryAt: {} }, ...catalog.boards.slice(1)] })],
    ['invalid board status', catalog => ({ ...catalog, boards: [{ ...catalog.boards[0], status: 'complete' }, ...catalog.boards.slice(1)] })],
    ['fractional count', catalog => ({ ...catalog, unmappedCount: 0.5 })],
    ['non-boolean stale flag', catalog => ({ ...catalog, stale: 'false' })],
    ['duplicate city', catalog => ({ ...catalog, cities: [...catalog.cities, catalog.cities[0]] })],
    ['duplicate company', catalog => ({ ...catalog, companies: [...catalog.companies, catalog.companies[0]] })],
    ['missing board', catalog => ({ ...catalog, boards: catalog.boards.slice(1) })],
    ['foreign job company', catalog => ({ ...catalog, jobs: [{ ...catalog.jobs[0], companyId: 'foreign' }, ...catalog.jobs.slice(1)] })],
    ['non-public job source', catalog => ({ ...catalog, jobs: [{ ...catalog.jobs[0], source: 'sample' }, ...catalog.jobs.slice(1)] })],
    ['foreign job city', catalog => ({ ...catalog, jobs: [{ ...catalog.jobs[0], cityIds: ['foreign'] }, ...catalog.jobs.slice(1)] })],
    ['mismatched job identity', catalog => ({ ...catalog, jobs: [{ ...catalog.jobs[0], id: 'foreign-id' }, ...catalog.jobs.slice(1)] })],
    ['mismatched board identity', catalog => ({ ...catalog, boards: [{ ...catalog.boards[0], board: 'foreign-board' }, ...catalog.boards.slice(1)] })],
    ['inconsistent included count', catalog => ({ ...catalog, boards: [{ ...catalog.boards[0], included: 0 }, ...catalog.boards.slice(1)] })],
    ['duplicate job', catalog => ({
      ...catalog, jobs: [...catalog.jobs, catalog.jobs[0]],
      boards: [{ ...catalog.boards[0], total: 2, included: 2 }, ...catalog.boards.slice(1)],
    })],
  ]
  describe.each([200, 202])('initial HTTP %s', status => {
    it.each(malformedCatalogs)('rejects a %s before any data reaches the view', async (_name, corrupt) => {
      const snapshot = progressSnapshot(status === 200 ? 2 : 1)
      const catalog = corrupt(snapshot.catalog)
      const body = status === 202 ? { ...snapshot, catalog } : catalog
      const fetcher = vi.fn().mockResolvedValueOnce(Response.json(body, { status }))
      const { task, onUpdate } = run(fetcher)
      await expect(task).rejects.toThrow('공고 데이터 형식')
      expect(onUpdate).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(120000)
      expect(fetcher).toHaveBeenCalledOnce()
    })
  })

  it.each([null, 10])('preserves legacy optional fields, omitted-job counts (%s) and additive data', async unmappedCount => {
    const catalog = progressSnapshot(2).catalog
    catalog.unmappedCount = unmappedCount
    catalog.boards[0].total += unmappedCount ?? 0
    for (const company of catalog.companies) delete company.provider
    for (const board of catalog.boards) {
      delete board.provider
      delete board.dataStatus
      delete board.lastSuccessAt
      delete board.checkedAt
    }
    for (const job of catalog.jobs) {
      delete job.qualifications
      delete job.eligibility
      delete job.compensationVersion
    }
    // Link safety belongs to the action itself; validation must not rewrite evidence.
    catalog.jobs[0].url = 'javascript:void(0)'
    Object.assign(catalog, { futureMetadata: { version: 2 } })
    Object.assign(catalog.jobs[0], { futureEvidence: { text: 'Preserve original wording' } })
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json(catalog))
    const { task, onUpdate } = run(fetcher)
    await task
    expect(JSON.stringify(onUpdate.mock.lastCall![0])).toBe(JSON.stringify(catalog))
  })

  it('accepts a successfully collected empty catalog with a real timestamp', async () => {
    const catalog = searchCatalog([])
    const { task, onUpdate } = run(vi.fn().mockResolvedValueOnce(Response.json(catalog)))
    await task
    expect(onUpdate).toHaveBeenCalledWith(catalog, null)
  })

  it('localizes an initial network failure and never starts monitoring it', async () => {
    const fetcher = vi.fn().mockRejectedValueOnce(new TypeError('Failed to fetch'))
    const { task, onUpdate } = run(fetcher)
    await expect(task).rejects.toThrow('공개 공고에 연결하지 못했어요')
    expect(onUpdate).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(120000)
    expect(fetcher).toHaveBeenCalledOnce()
  })

  it('honors Retry-After and aborts both a waiting timer and future requests when the source changes', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(accepted('2'))
      .mockResolvedValueOnce(new Response(null, { status: 204, headers: { 'Retry-After': '120' } }))
    const { task, controller, onUpdate } = run(fetcher)
    const stopped = expect(task).rejects.toMatchObject({ name: 'AbortError' })
    await vi.advanceTimersByTimeAsync(1999)
    expect(fetcher).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(1)
    expect(fetcher).toHaveBeenCalledTimes(2)
    controller.abort()
    await stopped
    await vi.advanceTimersByTimeAsync(300000)
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(onUpdate).toHaveBeenCalledOnce()
  })

  it('does not apply an old in-flight response after the source changes', async () => {
    let finish!: (response: Response) => void
    const fetcher = vi.fn().mockResolvedValueOnce(accepted()).mockReturnValueOnce(new Promise<Response>(resolve => { finish = resolve }))
    const { task, controller, onUpdate } = run(fetcher)
    const stopped = expect(task).rejects.toMatchObject({ name: 'AbortError' })
    await vi.advanceTimersByTimeAsync(1000)
    controller.abort()
    finish(Response.json(progressUpdate(1)))
    await stopped
    expect(onUpdate).toHaveBeenCalledOnce()
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  const invalid: [string, (update: CatalogCollectionUpdate) => void][] = [
    ['different collection', update => { update.progress.id = '00000000-0000-4000-8000-999999999999' }],
    ['non-advancing revision', update => { update.progress.revision = 0 }],
    ['duplicate company replacement', update => { update.companyIds.push(update.companyIds[0]) }],
    ['foreign company job', update => { update.jobs[0].companyId = 'foreign' }],
    ['foreign source', update => { update.jobs[0].source = 'ashby' }],
    ['changed board identity', update => { update.catalog.boards[0].board = 'foreign' }],
    ['false completion', update => { update.progress.done = true }],
    ['incomplete job body', update => { Object.assign(update.jobs[0], { description: null }) }],
    ['invalid nested evidence', update => { Object.assign(update.jobs[0], { evidence: { workMode: { source: 'board', text: [] } } }) }],
    ['invalid board metadata', update => { Object.assign(update.catalog.boards[0], { total: -1 }) }],
    ['unmapped city reference', update => { update.jobs[0].cityIds = ['foreign'] }],
    ['unavailable replacement with jobs', update => { update.catalog.boards[0].dataStatus = 'unavailable' }],
  ]
  it.each(invalid)('rejects %s atomically, preserving the last received catalog', async (_name, mutate) => {
    const update = progressUpdate(1)
    mutate(update)
    const fetcher = vi.fn().mockResolvedValueOnce(accepted()).mockResolvedValueOnce(Response.json(update))
    const { task, onUpdate } = run(fetcher)
    const rejected = expect(task).rejects.toThrow('공고 데이터 형식')
    await vi.advanceTimersByTimeAsync(1000)
    await rejected
    expect(onUpdate).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(10000)
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('rejects inconsistent full counts in a later delta without losing the first arrival or continuing to poll', async () => {
    const update = progressUpdate(2)
    // The first company's jobs are not in this delta, but remain in the merged catalog.
    update.catalog.boards[0].included = 0
    const fetcher = vi.fn().mockResolvedValueOnce(accepted())
      .mockResolvedValueOnce(Response.json(progressUpdate(1))).mockResolvedValueOnce(Response.json(update))
    const { task, onUpdate } = run(fetcher)
    const rejected = expect(task).rejects.toThrow('공고 데이터 형식')
    await vi.advanceTimersByTimeAsync(2000)
    await rejected
    expect(onUpdate).toHaveBeenCalledTimes(2)
    expect(onUpdate.mock.lastCall![0]).toEqual(progressSnapshot(1).catalog)
    await vi.advanceTimersByTimeAsync(120000)
    expect(fetcher).toHaveBeenCalledTimes(3)
  })

  it.each(['empty replacement', 'expired previous company'])('validates merged counts for an %s', async kind => {
    const update = progressUpdate(2)
    if (kind === 'empty replacement') {
      update.jobs = []
      Object.assign(update.catalog.boards[1], { total: 0, included: 0 })
    } else {
      Object.assign(update.catalog.boards[0], { total: 0, included: 0, dataStatus: 'unavailable' })
    }
    const initial = progressSnapshot(1)
    // Even if a server adds these fields, a delta cannot overwrite the registry.
    Object.assign(update.catalog, { companies: null, cities: [null], jobs: [null] })
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json(initial, { status: 202 }))
      .mockResolvedValueOnce(Response.json(update))
    const { task, onUpdate } = run(fetcher)
    await vi.advanceTimersByTimeAsync(1000)
    await task
    const result: Catalog = onUpdate.mock.lastCall![0]
    expect(result.jobs.map(job => job.companyId)).toEqual([kind === 'empty replacement' ? 'search-fixture-a' : 'search-fixture-b'])
    expect(result.companies).toEqual(initial.catalog.companies)
    expect(result.cities).toEqual(initial.catalog.cities)
  })

  it('keeps received jobs after a monitoring failure and carries server retry/expiry errors to the view', async () => {
    const retryAt = '2026-09-19T08:05:00.000Z'
    const fetcher = vi.fn().mockResolvedValueOnce(accepted())
      .mockResolvedValueOnce(Response.json(progressUpdate(1)))
      .mockResolvedValueOnce(Response.json({ error: '만료됨', code: 'CATALOG_EXPIRED', retryAt }, { status: 503 }))
    const { task, onUpdate } = run(fetcher)
    const rejected = expect(task).rejects.toMatchObject({ message: '만료됨', code: 'CATALOG_EXPIRED', retryAt })
    await vi.advanceTimersByTimeAsync(2000)
    await rejected
    expect(onUpdate).toHaveBeenCalledTimes(2)
    expect(onUpdate.mock.lastCall![0].jobs).toHaveLength(1)
  })

  it('reports a broken monitoring connection without clearing already received jobs or restarting upstream work', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(accepted())
      .mockResolvedValueOnce(Response.json(progressUpdate(1))).mockRejectedValueOnce(new TypeError('Failed to fetch'))
    const { task, onUpdate } = run(fetcher)
    const rejected = expect(task).rejects.toThrow('도착한 공고는 유지됩니다')
    await vi.advanceTimersByTimeAsync(2000)
    await rejected
    expect(onUpdate.mock.lastCall![0].jobs).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(120000)
    expect(fetcher).toHaveBeenCalledTimes(3)
  })
})
