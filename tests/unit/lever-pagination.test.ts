import { afterEach, describe, expect, it, vi } from 'vitest'
import { BoardFetchError, CatalogUnavailableError, createCatalogService } from '../../server/catalog-service'
import { parseCachedBoards } from '../../server/board-cache'
import type { CachedBoard } from '../../server/board-cache'
import { fetchLeverBoard } from '../../server/providers/lever'
import { observeSavedPosting } from '../../shared/posting-status'
import type { SavedJob } from '../../shared/types'
import {
  PAGINATION_COMPANIES, PAGINATION_TIME, PAGINATION_CHANGE_TIME, PAGINATION_RECOVERY_TIME,
  PAGINATION_NOTE, PAGINATION_URLS, paginationPosting, paginationAdministrative,
  paginationHealthyPage, paginationOverlapPages, paginationResponses,
} from '../fixtures/lever-pagination'

const company = PAGINATION_COMPANIES[0]
const duplicateMessage = '게시판의 공고 목록이 중복되어 전체 조회를 확인하지 못했어요.'
const initialIds = [
  'lever-pagination-alder-tracked',
  ...Array.from({ length: 48 }, (_, index) => `lever-pagination-alder-administrative-${index + 1}`),
  'lever-pagination-alder-boundary',
]
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

function feed(pages: unknown[]) {
  const fetcher = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const offset = Number(new URL(String(input)).searchParams.get('skip'))
    const page = pages[offset / 50]
    if (page === undefined) throw new Error(`Unexpected fixture offset ${offset}`)
    return Response.json(page)
  })
  vi.stubGlobal('fetch', fetcher)
  return fetcher
}

describe('exact Lever publication identity before any inclusion filtering', () => {
  const cases = [
    { name: 'identical rows inside a short first page', pages: () => [[paginationPosting('same'), paginationPosting('same')]], requests: 1 },
    { name: 'separated duplicate rows with a new ID between them', pages: () => [[paginationPosting('same'), paginationPosting('new'), paginationPosting('same')]], requests: 1 },
    { name: 'changed titles and bodies for one first-page ID', pages: () => [[paginationPosting('same'), paginationPosting('same', { text: 'Frontend Engineer changed', descriptionPlain: 'Build interfaces with React.' })]], requests: 1 },
    { name: 'only nontechnical duplicate rows plus a new nontechnical ID', pages: () => [[paginationAdministrative('sales'), paginationAdministrative('sales'), paginationAdministrative('new-sales')]], requests: 1 },
    { name: 'a technical row followed by a nontechnical duplicate', pages: () => [[paginationPosting('same'), paginationAdministrative('same')]], requests: 1 },
    { name: 'a nontechnical row followed by a technical duplicate', pages: () => [[paginationAdministrative('same'), paginationPosting('same')]], requests: 1 },
    { name: 'one ID with two different public URLs', pages: () => [[paginationPosting('same'), paginationPosting('same', { hostedUrl: 'https://example.com/different-public-link' })]], requests: 1 },
    {
      name: 'a duplicate inside a full page without requesting the next page',
      pages: () => [[paginationPosting('same'), ...Array.from({ length: 48 }, (_, index) => paginationPosting(`unique-${index}`)), paginationPosting('same')], []],
      requests: 1,
    },
    {
      name: 'the former overlapping happy path with an identical boundary plus a new ID',
      pages: () => [paginationHealthyPage(), [paginationPosting('boundary', { text: 'Boundary Backend Engineer 50' }), paginationPosting('last-page')]],
      requests: 2,
    },
    { name: 'a changed boundary plus a new ID on the later short page', pages: paginationOverlapPages, requests: 2 },
    {
      name: 'a later full page that overlaps but also introduces49 IDs',
      pages: () => [paginationHealthyPage(), [paginationPosting('boundary'), ...Array.from({ length: 49 }, (_, index) => paginationPosting(`new-${index}`))], []],
      requests: 2,
    },
    {
      name: 'a repeated excluded ID across pages even though technical IDs remain unique',
      pages: () => [paginationHealthyPage(), [paginationAdministrative('administrative-1'), paginationPosting('new-engineer')]],
      requests: 2,
    },
    { name: 'an entirely repeated page', pages: () => [paginationHealthyPage(), paginationHealthyPage()], requests: 2 },
  ]
  for (const item of cases) it(`rejects ${item.name}`, async () => {
    const fetcher = feed(item.pages())
    const pending = fetchLeverBoard(company, PAGINATION_TIME)
    await expect(pending).rejects.toBeInstanceOf(BoardFetchError)
    await expect(pending).rejects.toThrow(duplicateMessage)
    expect(fetcher).toHaveBeenCalledTimes(item.requests)
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual(
      item.requests === 1 ? [PAGINATION_URLS.first] : [PAGINATION_URLS.first, PAGINATION_URLS.next],
    )
  })
})

describe('valid inventories and existing transport bounds', () => {
  for (const region of ['global', 'eu'] as const) it(`accepts unique ${region} pages with the original offsets and one deadline`, async () => {
    const fetcher = feed([paginationHealthyPage(), [paginationPosting('new-public')]])
    const result = await fetchLeverBoard({ ...company, ...(region === 'eu' ? { boardRegion: 'eu' as const } : {}) }, PAGINATION_TIME)
    expect(result.total).toBe(51)
    expect(result.jobs.map(job => job.id)).toEqual([
      'lever-pagination-alder-tracked', 'lever-pagination-alder-boundary', 'lever-pagination-alder-new-public',
    ])
    expect(result.publishedIds).toEqual([...initialIds, 'lever-pagination-alder-new-public'])
    expect(result.unmappedCount).toBe(0)
    const host = region === 'eu' ? 'api.eu.lever.co' : 'api.lever.co'
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([
      `https://${host}/v0/postings/AlderPagination50?mode=json&limit=50&skip=0`,
      `https://${host}/v0/postings/AlderPagination50?mode=json&limit=50&skip=50`,
    ])
    expect(fetcher.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal)
    expect(fetcher.mock.calls[0][1]?.signal).toBe(fetcher.mock.calls[1][1]?.signal)
  })

  it('requires the ordinary empty terminator after exactly50 unique rows', async () => {
    const fetcher = feed([paginationHealthyPage(), []])
    const result = await fetchLeverBoard(company, PAGINATION_TIME)
    expect(result).toMatchObject({ total: 50, unmappedCount: 0, publishedIds: initialIds })
    expect(result.jobs.map(job => job.id)).toEqual(['lever-pagination-alder-tracked', 'lever-pagination-alder-boundary'])
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('treats a successful empty first page as an authoritative empty inventory', async () => {
    const fetcher = feed([[]])
    expect(await fetchLeverBoard(company, PAGINATION_TIME)).toEqual({ jobs: [], total: 0, unmappedCount: 0, publishedIds: [] })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('does not merge distinct case-sensitive IDs or distinct IDs sharing title and URL', async () => {
    feed([[
      paginationPosting('Case', { text: 'Backend Engineer same', hostedUrl: 'https://example.com/same-link' }),
      paginationPosting('case', { text: 'Backend Engineer same', hostedUrl: 'https://example.com/same-link' }),
    ]])
    const result = await fetchLeverBoard(company, PAGINATION_TIME)
    expect(result.total).toBe(2)
    expect(result.jobs).toHaveLength(2)
    expect(result.publishedIds).toEqual(['lever-pagination-alder-Case', 'lever-pagination-alder-case'])
  })

  it('keeps unique excluded publication IDs while only technical jobs enter discovery', async () => {
    feed([[paginationAdministrative('sales-one'), paginationPosting('technical'), paginationAdministrative('sales-two')]])
    const result = await fetchLeverBoard(company, PAGINATION_TIME)
    expect(result.total).toBe(3)
    expect(result.jobs.map(job => job.id)).toEqual(['lever-pagination-alder-technical'])
    expect(result.publishedIds).toEqual([
      'lever-pagination-alder-sales-one', 'lever-pagination-alder-technical', 'lever-pagination-alder-sales-two',
    ])
  })

  it('does not silently publish20001 unique IDs when the maximum is exceeded', async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const skip = Number(new URL(String(input)).searchParams.get('skip'))
      return Response.json(Array.from({ length: skip < 20000 ? 50 : 1 }, (_, index) => paginationAdministrative(`bounded-${skip + index}`)))
    })
    vi.stubGlobal('fetch', fetcher)
    await expect(fetchLeverBoard(company, PAGINATION_TIME)).rejects.toThrow('한 번에 확인할 수 있는 게시판 크기를 초과했어요.')
    expect(fetcher).toHaveBeenCalledTimes(401)
    expect(String(fetcher.mock.calls[400][0])).toBe('https://api.lever.co/v0/postings/AlderPagination50?mode=json&limit=50&skip=20000')
    expect(new Set(fetcher.mock.calls.map(([, init]) => init?.signal)).size).toBe(1)
  })

  it('rejects a malformed later response instead of accepting the complete-looking first page', async () => {
    const fetcher = feed([paginationHealthyPage(), { jobs: [] }])
    await expect(fetchLeverBoard(company, PAGINATION_TIME)).rejects.toBeInstanceOf(BoardFetchError)
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('preserves a later-page429 Retry-After without automatic requests', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse(PAGINATION_TIME))
    const fetcher = vi.fn()
      .mockResolvedValueOnce(Response.json(paginationHealthyPage()))
      .mockResolvedValueOnce(new Response('', { status: 429, headers: { 'Retry-After': '300' } }))
    vi.stubGlobal('fetch', fetcher)
    const pending = fetchLeverBoard(company, PAGINATION_TIME)
    await expect(pending).rejects.toBeInstanceOf(BoardFetchError)
    await expect(pending).rejects.toMatchObject({ retryAfter: Date.parse('2026-09-20T12:05:00.000Z'), message: 'HTTP 429' })
    expect(fetcher).toHaveBeenCalledTimes(2)
  })
})

describe('actual provider errors through catalog snapshots and saved-status indexes', () => {
  function pipeline(companies = PAGINATION_COMPANIES) {
    let now = Date.parse(PAGINATION_TIME)
    let stored: CachedBoard[] = []
    let responses = paginationResponses('healthy')
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (!Object.hasOwn(responses, url)) throw new Error(`Unexpected fixture URL ${url}`)
      return Response.json(responses[url])
    })
    vi.stubGlobal('fetch', fetcher)
    const cache = { load: async () => parseCachedBoards({ version: 5, boards: structuredClone(stored) }), save: async (next: CachedBoard[]) => { stored = structuredClone(next) } }
    const create = () => createCatalogService({ companies, cache, fetchBoard: fetchLeverBoard, now: () => now, random: () => 0 })
    return {
      create, fetcher, cache: () => stored,
      at: (time: string) => { now = Date.parse(time) },
      phase: (phase: Parameters<typeof paginationResponses>[0]) => { responses = paginationResponses(phase) },
      now: () => now,
    }
  }
  const save = (job: SavedJob['job']): SavedJob => ({
    job: structuredClone(job), company, note: PAGINATION_NOTE, status: 'applied', savedAt: '2026-09-20T12:00:30.000Z',
  })

  it('retains the exact old snapshot and unknown saved status across overlap, cache reload and unique recovery while the other board succeeds', async () => {
    const fixture = pipeline()
    const service = fixture.create()
    const first = await service.get()
    expect(first.jobs.map(job => job.id)).toEqual([
      'lever-pagination-alder-tracked', 'lever-pagination-alder-boundary', 'lever-pagination-birch-birch-one',
    ])
    const saved = save(first.jobs[0])
    const originalSaved = structuredClone(saved)
    const original = structuredClone(fixture.cache().find(board => board.companyId === 'pagination-alder')!)
    expect(original.snapshot).toMatchObject({ fetchedAt: PAGINATION_TIME, total: 50, publishedIds: initialIds })
    fixture.phase('overlap')
    fixture.at(PAGINATION_CHANGE_TIME)
    const failed = await service.get(true)
    expect(failed.jobs.map(job => job.id)).toEqual([
      'lever-pagination-alder-tracked', 'lever-pagination-alder-boundary',
      'lever-pagination-birch-birch-one', 'lever-pagination-birch-birch-two',
    ])
    expect(failed.boards).toMatchObject([
      { status: 'error', dataStatus: 'stale', lastSuccessAt: PAGINATION_TIME, total: 50, included: 2 },
      { status: 'ok', dataStatus: 'fresh', lastSuccessAt: PAGINATION_CHANGE_TIME, total: 2, included: 2 },
    ])
    const retained = fixture.cache().find(board => board.companyId === 'pagination-alder')!
    expect(retained.snapshot).toEqual(original.snapshot)
    expect(retained).toMatchObject({
      checkedAt: PAGINATION_CHANGE_TIME, failures: 1, retryAt: '2026-09-20T12:03:00.000Z', error: duplicateMessage,
    })
    const status = await service.getPostingStatus(true)
    expect(status.boards[0]).toMatchObject({
      status: 'error', lastSuccessAt: PAGINATION_TIME,
      listing: { publishedIds: initialIds, validUntil: '2026-09-20T12:30:00.000Z' },
    })
    expect(observeSavedPosting(saved, status, undefined, fixture.now())).toMatchObject({
      state: 'unknown', checkedAt: PAGINATION_TIME,
      message: '회사 게시판 조회에 실패했어요. 이전 목록으로 게시 종료를 판단하지 않습니다.',
    })
    expect(fixture.fetcher).toHaveBeenCalledTimes(6)
    const restarted = fixture.create()
    expect((await restarted.get()).jobs).toEqual(failed.jobs)
    expect((await restarted.getPostingStatus(true)).boards).toEqual(status.boards)
    expect(fixture.fetcher).toHaveBeenCalledTimes(6)
    fixture.phase('recovered')
    fixture.at(PAGINATION_RECOVERY_TIME)
    const recovered = await restarted.get(true)
    expect(recovered.jobs.map(job => job.id)).toEqual([
      'lever-pagination-alder-tracked', 'lever-pagination-alder-boundary', 'lever-pagination-alder-new-public',
      'lever-pagination-birch-birch-one', 'lever-pagination-birch-birch-two',
    ])
    expect(recovered.boards[0]).toMatchObject({ status: 'ok', dataStatus: 'fresh', total: 51, included: 3, lastSuccessAt: PAGINATION_RECOVERY_TIME })
    expect(fixture.cache()[0].snapshot?.publishedIds).toEqual([...initialIds, 'lever-pagination-alder-new-public'])
    expect(observeSavedPosting(saved, await restarted.getPostingStatus(), undefined, fixture.now()).state).toBe('listed')
    expect(fixture.fetcher).toHaveBeenCalledTimes(9)
    expect(saved).toEqual(originalSaved)
  })

  it('records no authoritative snapshot or listing when a first nontechnical page has duplicates', async () => {
    const fixture = pipeline([company])
    fixture.phase('within-page')
    const service = fixture.create()
    await expect(service.get()).rejects.toBeInstanceOf(CatalogUnavailableError)
    expect(fixture.cache()).toHaveLength(1)
    expect(fixture.cache()[0]).toMatchObject({ failures: 1, checkedAt: PAGINATION_TIME, retryAt: '2026-09-20T12:01:00.000Z', error: duplicateMessage })
    expect(fixture.cache()[0]).not.toHaveProperty('snapshot')
    const status = await service.getPostingStatus(true)
    expect(status.boards[0]).toMatchObject({ status: 'error', lastSuccessAt: null })
    expect(status.boards[0]).not.toHaveProperty('listing')
    expect(fixture.fetcher).toHaveBeenCalledTimes(1)
  })

  it('accepts a genuinely empty recovery and only then reports the saved job missing', async () => {
    const fixture = pipeline([company])
    const service = fixture.create()
    const saved = save((await service.get()).jobs[0])
    const original = structuredClone(saved)
    fixture.phase('empty')
    fixture.at(PAGINATION_CHANGE_TIME)
    const empty = await service.get(true)
    expect(empty.jobs).toEqual([])
    expect(empty.boards[0]).toMatchObject({ status: 'ok', dataStatus: 'fresh', total: 0, included: 0, lastSuccessAt: PAGINATION_CHANGE_TIME })
    expect(fixture.cache()[0].snapshot).toEqual({ fetchedAt: PAGINATION_CHANGE_TIME, jobs: [], total: 0, unmappedCount: 0, publishedIds: [] })
    const status = await service.getPostingStatus()
    expect(status.boards[0].listing).toMatchObject({ publishedIds: [], jobs: [] })
    expect(observeSavedPosting(saved, status, undefined, fixture.now()).state).toBe('missing')
    expect(saved).toEqual(original)
  })

  it('keeps a unique published ID listed when its new body leaves the technical discovery scope', async () => {
    const fixture = pipeline([company])
    const service = fixture.create()
    const saved = save((await service.get()).jobs[0])
    fixture.phase('out-of-scope')
    fixture.at(PAGINATION_CHANGE_TIME)
    const result = await service.get(true)
    expect(result.jobs).toEqual([])
    expect(result.boards[0]).toMatchObject({ status: 'ok', total: 50, included: 0 })
    const status = await service.getPostingStatus()
    expect(status.boards[0].listing).toMatchObject({ publishedIds: initialIds, jobs: [] })
    expect(observeSavedPosting(saved, status, undefined, fixture.now())).toMatchObject({
      state: 'listed', message: '게시판에는 있지만 현재 탐색 범위 밖의 공고라 내용은 원문에서 확인해야 합니다.',
    })
  })
})
