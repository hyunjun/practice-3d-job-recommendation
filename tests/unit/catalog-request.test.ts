import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { requestPublicCatalog } from '../../src/lib/catalog-request'
import { COLLECTION_ID, progressSnapshot, progressUpdate } from '../fixtures/catalog-progress'
import type { CatalogCollectionUpdate } from '../../shared/catalog-progress'

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
