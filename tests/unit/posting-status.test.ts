import { afterEach, describe, expect, it, vi } from 'vitest'
import { PUBLIC_COMPANIES } from '../../shared/companies'
import { createJobRevision, observeSavedPosting, PostingStatusIndexSchema, REVISION_FIELDS } from '../../shared/posting-status'
import type { PostingStatusIndex } from '../../shared/posting-status'
import type { Job, SavedJob } from '../../shared/types'
import { BoardSnapshotSchema } from '../../server/board-cache'
import type { CachedBoard } from '../../server/board-cache'
import { BoardFetchError, CATALOG_POLICY, createCatalogService } from '../../server/catalog-service'
import { normalizeJob } from '../../server/normalize'
import { fetchGreenhouseBoard } from '../../server/providers/greenhouse'

const BASE = Date.parse('2026-09-19T08:00:00.000Z')
const iso = (value: number) => new Date(value).toISOString()
const company = PUBLIC_COMPANIES.find(item => item.id === 'stripe')!
const job = normalizeJob({
  id: 7701, title: 'Backend Engineer', location: { name: 'London, UK' },
  absolute_url: 'https://example.com/jobs/7701',
  content: '<h2>Minimum requirements</h2><p>3 years of engineering experience.</p><p>Experience with Python and AWS.</p>',
}, company.id, iso(BASE))!
const saved: SavedJob = { job, company, savedAt: iso(BASE + 1_000), status: 'applied', note: 'My private application note' }

async function indexFor(current: Job = job): Promise<PostingStatusIndex> {
  return {
    version: 1, checkedAt: iso(BASE), refreshAfter: iso(BASE + 60_000),
    boards: [{
      companyId: company.id, board: company.board!, provider: 'greenhouse', status: 'ok',
      checkedAt: iso(BASE), lastSuccessAt: iso(BASE), retryAt: null,
      listing: {
        validUntil: iso(BASE + CATALOG_POLICY.freshFor), publishedIds: [job.id],
        jobs: [{ id: job.id, title: current.title, url: current.url, revision: await createJobRevision(current) }],
      },
    }],
  }
}

function cacheWith(snapshot?: CachedBoard['snapshot']) {
  let value: CachedBoard[] = snapshot ? [{
    companyId: company.id, board: company.board!, provider: 'greenhouse',
    checkedAt: snapshot.fetchedAt, failures: 0, retryAt: null, snapshot,
  }] : []
  return {
    load: vi.fn(async () => structuredClone(value)),
    save: vi.fn(async (boards: CachedBoard[]) => { value = structuredClone(boards) }),
  }
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('saved posting evidence', () => {
  it('compares displayed content without treating collection times, ordering or save metadata as edits', async () => {
    const revision = await createJobRevision(job)
    const changedCollection = { ...job, fetchedAt: iso(BASE + 60_000), stale: true, skills: [...job.skills].reverse(), description: `\n${job.description.replaceAll('\n', '  ')}\n` }
    expect(await createJobRevision(changedCollection)).toEqual(revision)
    const index = await indexFor(changedCollection)
    expect(observeSavedPosting(saved, index, revision, BASE)).toMatchObject({ state: 'listed', changedFields: [] })
    const edited = await createJobRevision({ ...job, title: 'Staff Backend Engineer', salary: { min: 100000, max: 150000, currency: 'GBP' }, visa: 'yes' })
    expect(REVISION_FIELDS.filter(field => edited[field] !== revision[field])).toEqual(['title', 'conditions', 'compensation'])
    expect(saved.note).toBe('My private application note')
  })

  it('reports a listed job outside map coverage without implying that its saved content is current', async () => {
    const index = await indexFor()
    index.boards[0].listing!.jobs = []
    expect(observeSavedPosting(saved, index, await createJobRevision(job), BASE)).toMatchObject({ state: 'listed', message: expect.stringContaining('탐색 범위 밖') })
    expect(observeSavedPosting(saved, index, undefined, BASE).changedFields).toBeUndefined()
  })

  it('produces the same comparison in browsers and servers with different locale collations', async () => {
    const revision = await createJobRevision(job)
    vi.spyOn(String.prototype, 'localeCompare').mockReturnValue(-1)
    expect(await createJobRevision(job)).toEqual(revision)
  })

  it('uses only a recent complete listing for an absence and preserves unknown state for errors and legacy caches', async () => {
    const index = await indexFor()
    index.boards[0].listing = { ...index.boards[0].listing!, publishedIds: [], jobs: [] }
    const observation = observeSavedPosting(saved, index, undefined, BASE)
    expect(observation).toMatchObject({ state: 'missing', message: expect.stringContaining('원문에서 확인') })
    expect(observeSavedPosting(saved, index, undefined, BASE + CATALOG_POLICY.freshFor).state).toBe('unknown')
    index.boards[0].status = 'error'
    expect(observeSavedPosting(saved, index, undefined, BASE).state).toBe('unknown')
    index.boards[0].status = 'ok'
    delete index.boards[0].listing
    expect(observeSavedPosting(saved, index, undefined, BASE).state).toBe('unknown')
  })

  it('does not use another board, provider, region or an older collection to infer absence', async () => {
    for (const mismatch of [
      { ...company, board: 'previous-board' }, { ...company, boardRegion: 'eu' as const }, { ...company, board: undefined },
    ]) {
      const index = await indexFor()
      index.boards[0].listing!.publishedIds = []
      index.boards[0].listing!.jobs = []
      expect(observeSavedPosting({ ...saved, company: mismatch }, index, undefined, BASE).state).toBe('unknown')
    }
    const index = await indexFor()
    expect(observeSavedPosting({ ...saved, job: { ...job, source: 'ashby' } }, index, undefined, BASE).state).toBe('unknown')
    expect(observeSavedPosting({ ...saved, job: { ...job, fetchedAt: iso(BASE + 1) } }, index, undefined, BASE).state).toBe('unknown')
    expect(observeSavedPosting(saved, index, undefined, BASE - 600_000).state).toBe('unknown')
  })

  it('keeps checks explicit and treats a failed request and unavailable hashing separately', async () => {
    expect(observeSavedPosting(saved, null, undefined, BASE).state).toBe('unchecked')
    expect(observeSavedPosting({ ...saved, job: { ...job, source: 'sample' } }, null, undefined, BASE, 'offline').state).toBe('sample')
    const index = await indexFor()
    expect(observeSavedPosting(saved, index, undefined, BASE, 'offline').state).toBe('unknown')
    expect(observeSavedPosting(saved, index, undefined, BASE)).toMatchObject({ state: 'listed', message: expect.stringContaining('내용 비교') })
  })

  it('rejects duplicate, foreign, incomplete or inconsistent index evidence', async () => {
    const original = await indexFor()
    expect(PostingStatusIndexSchema.safeParse(original).success).toBe(true)
    const invalid = [
      (index: PostingStatusIndex) => { index.boards.push(structuredClone(index.boards[0])) },
      (index: PostingStatusIndex) => { index.boards[0].listing!.publishedIds.push(job.id) },
      (index: PostingStatusIndex) => { index.boards[0].listing!.publishedIds = ['greenhouse-foreign-7701'] },
      (index: PostingStatusIndex) => { index.boards[0].listing!.publishedIds = [] },
      (index: PostingStatusIndex) => { index.boards[0].listing!.validUntil = iso(BASE + 31 * 60_000) },
      (index: PostingStatusIndex) => { index.boards[0].lastSuccessAt = iso(BASE + 1_000) },
      (index: PostingStatusIndex) => { index.boards[0].boardRegion = 'eu' },
    ]
    for (const mutate of invalid) {
      const index = structuredClone(original)
      mutate(index)
      expect(PostingStatusIndexSchema.safeParse(index).success).toBe(false)
    }
  })
})

describe('complete listing collection and reuse', () => {
  it('collects unique Greenhouse published IDs, retains unmapped developers and rejects repeated IDs', async () => {
    const posting = { id: 1, title: 'Backend Engineer', absolute_url: 'https://example.com/1', location: { name: 'London, UK' }, content: '' }
    const fetcher = vi.fn(async () => Response.json({ jobs: [
      posting, posting, { ...posting, id: 2, title: 'Account Executive' },
      { ...posting, id: 3, location: { name: 'Unknown Office' } },
    ], meta: { total: 4 } }))
    vi.stubGlobal('fetch', fetcher)
    const repeated = fetchGreenhouseBoard(company, iso(BASE))
    await expect(repeated).rejects.toBeInstanceOf(BoardFetchError)
    await expect(repeated).rejects.toThrow('게시판의 공고 목록이 중복되어 전체 조회를 확인하지 못했어요.')
    fetcher.mockImplementationOnce(async () => Response.json({ jobs: [
      posting, { ...posting, id: 2, title: 'Account Executive' },
      { ...posting, id: 3, location: { name: 'Unknown Office' } },
    ], meta: { total: 3 } }))
    const result = await fetchGreenhouseBoard(company, iso(BASE))
    expect(result.jobs.map(job => job.id)).toEqual([1, 3].map(id => `greenhouse-${company.id}-${id}`))
    expect(result.jobs[1]).toMatchObject({ cityIds: [], locationLabel: 'Unknown Office', workMode: 'unknown' })
    expect(result).toMatchObject({ total: 3, unmappedCount: 1, publishedIds: [1, 2, 3].map(id => `greenhouse-${company.id}-${id}`) })
    fetcher.mockImplementationOnce(async () => Response.json({ jobs: [posting], meta: { total: 2 } }))
    await expect(fetchGreenhouseBoard(company, iso(BASE))).rejects.toBeInstanceOf(BoardFetchError)
  })

  it('coalesces catalog and status checks, preserves the same timestamp and enforces refresh cooldown', async () => {
    let current = BASE
    let release!: () => void
    let entered!: () => void
    const started = new Promise<void>(resolve => { entered = resolve })
    const gate = new Promise<void>(resolve => { release = resolve })
    const fetchBoard = vi.fn(async (_company, fetchedAt: string) => {
      entered(); await gate
      return { jobs: [{ ...job, fetchedAt }], total: 2, unmappedCount: 0, publishedIds: [job.id, `greenhouse-${company.id}-outside-map`] }
    })
    const cache = cacheWith()
    const service = createCatalogService({ companies: [company], cache, fetchBoard, now: () => current })
    const results = Promise.all([service.get(), service.getPostingStatus(true)])
    await started
    release()
    const [catalog, index] = await results
    expect(fetchBoard).toHaveBeenCalledOnce()
    expect(cache.save).toHaveBeenCalledOnce()
    expect(index.boards[0].listing?.publishedIds).toHaveLength(2)
    expect(index.boards[0].listing?.jobs).toHaveLength(catalog.jobs.length)
    expect(index.boards[0].lastSuccessAt).toBe(catalog.jobs[0].fetchedAt)
    expect(PostingStatusIndexSchema.safeParse(index).success).toBe(true)
    await service.getPostingStatus(true)
    expect(fetchBoard).toHaveBeenCalledOnce()
    current += CATALOG_POLICY.minRefreshInterval
    await service.getPostingStatus(true)
    expect(fetchBoard).toHaveBeenCalledTimes(2)
  })

  it('keeps complete empty listings authoritative without reviving old jobs after an outage or restart', async () => {
    let current = BASE + CATALOG_POLICY.freshFor
    let fail = false
    const cache = cacheWith({ fetchedAt: iso(BASE), jobs: [{ ...job, source: 'greenhouse' }], total: 1, unmappedCount: 0, publishedIds: [job.id] })
    const fetchBoard = vi.fn(async () => {
      if (fail) throw new BoardFetchError('HTTP 429', current + 600_000)
      return { jobs: [], total: 0, unmappedCount: 0, publishedIds: [] }
    })
    const options = { companies: [company], cache, fetchBoard, now: () => current, random: () => 0 }
    const service = createCatalogService(options)
    expect(observeSavedPosting(saved, await service.getPostingStatus(), undefined, current).state).toBe('missing')
    fail = true
    current += CATALOG_POLICY.freshFor
    const failed = await service.getPostingStatus()
    expect(failed.boards[0].listing?.publishedIds).toEqual([])
    expect(observeSavedPosting(saved, failed, undefined, current).state).toBe('unknown')
    const restored = await createCatalogService(options).getPostingStatus(true)
    expect(restored.boards[0]).toMatchObject({ status: 'error', retryAt: iso(current + 600_000), listing: { publishedIds: [] } })
    expect(fetchBoard).toHaveBeenCalledTimes(2)
    current += CATALOG_POLICY.maxFallbackAge
    expect((await service.getPostingStatus()).boards[0].listing).toBeUndefined()
  })

  it('returns per-board unknown evidence even if the catalog has never succeeded', async () => {
    const fetchBoard = vi.fn(async () => { throw new Error('offline') })
    const service = createCatalogService({ companies: [company], cache: cacheWith(), fetchBoard, now: () => BASE, random: () => 0 })
    const index = await service.getPostingStatus()
    expect(index.boards[0]).toMatchObject({ status: 'error', lastSuccessAt: null })
    expect(index.boards[0].listing).toBeUndefined()
    await expect(service.get()).rejects.toMatchObject({ code: 'CATALOG_UNAVAILABLE' })
    expect(fetchBoard).toHaveBeenCalledOnce()
  })

  it('does not infer an empty public list from a legacy filtered cache', async () => {
    const fetchBoard = vi.fn()
    const cache = cacheWith({ fetchedAt: iso(BASE), jobs: [{ ...job, source: 'greenhouse' }], total: 1, unmappedCount: 0 })
    const service = createCatalogService({ companies: [company], cache, fetchBoard, now: () => BASE })
    const index = await service.getPostingStatus()
    expect(index.boards[0].listing).toBeUndefined()
    expect(observeSavedPosting(saved, index, undefined, BASE).state).toBe('unknown')
    expect(fetchBoard).not.toHaveBeenCalled()
  })

  it('rejects incomplete and foreign published IDs without replacing a previous complete snapshot', async () => {
    const snapshot = { fetchedAt: iso(BASE), jobs: [{ ...job, source: 'greenhouse' as const }], total: 1, unmappedCount: 0, publishedIds: [job.id] }
    for (const invalid of [
      { ...snapshot, publishedIds: [] }, { ...snapshot, publishedIds: [job.id, job.id], total: 2 },
      { ...snapshot, publishedIds: ['foreign'], total: 1 },
    ]) expect(BoardSnapshotSchema.safeParse(invalid).success).toBe(false)
    const cache = cacheWith(snapshot)
    const index = await createCatalogService({
      companies: [company], cache, now: () => BASE + CATALOG_POLICY.freshFor, random: () => 0,
      fetchBoard: async () => ({ jobs: [], total: 1, unmappedCount: 0, publishedIds: ['greenhouse-foreign-77'] }),
    }).getPostingStatus()
    expect(index.boards[0]).toMatchObject({ status: 'error', lastSuccessAt: iso(BASE), listing: { publishedIds: [job.id] } })
  })
})
