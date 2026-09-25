import { afterEach, describe, expect, it, vi } from 'vitest'
import { BoardFetchError, CatalogUnavailableError, createCatalogService } from '../../server/catalog-service'
import { parseCachedBoards } from '../../server/board-cache'
import type { CachedBoard } from '../../server/board-cache'
import { fetchGreenhouseBoard } from '../../server/providers/greenhouse'
import { fetchAshbyBoard } from '../../server/providers/ashby'
import { fetchLeverBoard } from '../../server/providers/lever'
import { observeSavedPosting } from '../../shared/posting-status'
import type { Company, SavedJob } from '../../shared/types'
import {
  BULK_COMPANIES, BULK_TIME, BULK_CHANGE_TIME, BULK_RECOVERY_TIME, BULK_EMPTY_TIME,
  BULK_NOTE, BULK_URLS, bulkGreenhouse, bulkGreenhouseSales, bulkAshby, bulkAshbySales, bulkResponses,
} from '../fixtures/bulk-inventory'
import type { BulkProvider, BulkPhase } from '../fixtures/bulk-inventory'

const duplicateMessage = '게시판의 공고 목록이 중복되어 전체 조회를 확인하지 못했어요.'
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

function respond(payload: unknown) {
  const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json(payload))
  vi.stubGlobal('fetch', fetcher)
  return fetcher
}
async function rejectsDuplicate(provider: BulkProvider, payload: unknown) {
  const fetcher = respond(payload)
  const pending = provider === 'greenhouse'
    ? fetchGreenhouseBoard(BULK_COMPANIES.greenhouse, BULK_TIME)
    : fetchAshbyBoard(BULK_COMPANIES.ashby, BULK_TIME)
  await expect(pending).rejects.toBeInstanceOf(BoardFetchError)
  await expect(pending).rejects.toThrow(duplicateMessage)
  expect(fetcher).toHaveBeenCalledTimes(1)
  expect(fetcher.mock.calls[0][0]).toBe(BULK_URLS[provider])
  expect(fetcher.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal)
  expect(fetcher.mock.calls[0][1]?.headers).toMatchObject({ Accept: 'application/json' })
}

describe('Greenhouse raw posting IDs before occupation or prospect filtering', () => {
  const cases = [
    { name: 'identical technical rows', jobs: () => [bulkGreenhouse(1), bulkGreenhouse(1)] },
    { name: 'one posting ID with different internal job, title, URL and location', jobs: () => [
      bulkGreenhouse(1), bulkGreenhouse(1, { internal_job_id: 999, title: 'Frontend Engineer changed', absolute_url: 'https://example.com/changed', location: { name: 'Berlin, Germany' } }),
    ] },
    { name: 'only excluded sales rows', jobs: () => [bulkGreenhouseSales(1), bulkGreenhouseSales(1)] },
    { name: 'a technical row followed by an excluded row', jobs: () => [bulkGreenhouse(1), bulkGreenhouseSales(1)] },
    { name: 'an excluded row followed by a technical row', jobs: () => [bulkGreenhouseSales(1), bulkGreenhouse(1)] },
    { name: 'a new posting between two repeated IDs', jobs: () => [bulkGreenhouse(1), bulkGreenhouse(2), bulkGreenhouse(1)] },
    { name: 'prospect posts sharing one posting ID', jobs: () => [bulkGreenhouse(1, { internal_job_id: null }), bulkGreenhouse(1, { internal_job_id: null })] },
  ]
  for (const withMeta of [false, true]) for (const item of cases) {
    it(`rejects ${item.name} ${withMeta ? 'despite meta.total matching raw rows' : 'without meta.total'}`, async () => {
      const jobs = item.jobs()
      await rejectsDuplicate('greenhouse', { jobs, ...(withMeta ? { meta: { total: jobs.length } } : {}) })
    })
  }

  it('accepts distinct posting IDs with the same internal_job_id, title, location and URL', async () => {
    const shared = { internal_job_id: 9001, title: 'Backend Engineer shared role', absolute_url: 'https://example.com/same-job', location: { name: 'London, United Kingdom' } }
    respond({ jobs: [bulkGreenhouse(31, shared), bulkGreenhouse(32, shared)], meta: { total: 2 } })
    const result = await fetchGreenhouseBoard(BULK_COMPANIES.greenhouse, BULK_TIME)
    expect(result.total).toBe(2)
    expect(result.publishedIds).toEqual(['greenhouse-bulk-cedar-31', 'greenhouse-bulk-cedar-32'])
    expect(result.jobs.map(job => ({ id: job.id, title: job.title, url: job.url, cityIds: job.cityIds, salary: job.salary }))).toEqual([
      { id: 'greenhouse-bulk-cedar-31', title: 'Backend Engineer shared role', url: 'https://example.com/same-job', cityIds: ['london'], salary: { currency: 'USD', min: 120000, max: 160000 } },
      { id: 'greenhouse-bulk-cedar-32', title: 'Backend Engineer shared role', url: 'https://example.com/same-job', cityIds: ['london'], salary: { currency: 'USD', min: 120000, max: 160000 } },
    ])
  })

  it('still rejects a wrong raw total before inspecting duplicate IDs', async () => {
    respond({ jobs: [bulkGreenhouse(1), bulkGreenhouse(1)], meta: { total: 1 } })
    await expect(fetchGreenhouseBoard(BULK_COMPANIES.greenhouse, BULK_TIME)).rejects.toThrow('게시판의 전체 공고를 확인하지 못했어요.')
  })

  it('still validates every required row before inspecting duplicate IDs', async () => {
    respond({ jobs: [bulkGreenhouse(1), bulkGreenhouse(1), { ...bulkGreenhouse(2), absolute_url: 'http://example.com/invalid' }] })
    await expect(fetchGreenhouseBoard(BULK_COMPANIES.greenhouse, BULK_TIME)).rejects.toThrow('공고의 필수 정보가 누락된 게시판 응답')
  })

  it('applies the20000 raw-row bound even when every row would be excluded', async () => {
    respond({ jobs: Array.from({ length: 20001 }, (_, index) => bulkGreenhouseSales(index + 1)), meta: { total: 20001 } })
    await expect(fetchGreenhouseBoard(BULK_COMPANIES.greenhouse, BULK_TIME)).rejects.toThrow('예상하지 못한 게시판 응답')
  })

  it('accepts a truly empty feed with meta.total zero', async () => {
    respond({ jobs: [], meta: { total: 0 } })
    expect(await fetchGreenhouseBoard(BULK_COMPANIES.greenhouse, BULK_TIME)).toEqual({ jobs: [], total: 0, unmappedCount: 0, publishedIds: [] })
  })
})

describe('Ashby local inventory integrity before public visibility filtering', () => {
  const cases = [
    { name: 'identical listed rows', jobs: () => [bulkAshby('same'), bulkAshby('same')] },
    { name: 'changed titles and job URLs for one listed ID', jobs: () => [bulkAshby('same'), bulkAshby('same', { title: 'Frontend Engineer changed', jobUrl: 'https://example.com/changed' })] },
    { name: 'listed then unlisted contradictory rows', jobs: () => [bulkAshby('same'), bulkAshby('same', { isListed: false })] },
    { name: 'unlisted then listed contradictory rows', jobs: () => [bulkAshby('same', { isListed: false }), bulkAshby('same')] },
    { name: 'only identical direct-link-only rows', jobs: () => [bulkAshby('same', { isListed: false }), bulkAshby('same', { isListed: false })] },
    { name: 'a new unlisted ID between repeated unlisted IDs', jobs: () => [bulkAshby('same', { isListed: false }), bulkAshby('new', { isListed: false }), bulkAshby('same', { isListed: false })] },
    { name: 'only excluded listed sales rows', jobs: () => [bulkAshbySales('same'), bulkAshbySales('same')] },
    { name: 'a technical row followed by an excluded row', jobs: () => [bulkAshby('same'), bulkAshbySales('same')] },
    { name: 'an excluded row followed by a technical row', jobs: () => [bulkAshbySales('same'), bulkAshby('same')] },
    { name: 'one ID repeated for different locations', jobs: () => [bulkAshby('same'), bulkAshby('same', { location: 'Berlin, Germany', address: { addressLocality: 'Berlin', addressCountry: 'DE' } })] },
  ]
  for (const item of cases) it(`rejects ${item.name}`, async () => {
    await rejectsDuplicate('ashby', { apiVersion: '1', jobs: item.jobs() })
  })

  it('preserves exact distinct strings despite equal titles, URLs and location', async () => {
    const shared = { title: 'Backend Engineer shared role', jobUrl: 'https://example.com/same-job' }
    respond({ apiVersion: '1', jobs: ['Case', 'case', 'case ', 'constructor'].map(id => bulkAshby(id, shared)) })
    const result = await fetchAshbyBoard(BULK_COMPANIES.ashby, BULK_TIME)
    expect(result.total).toBe(4)
    expect(result.jobs.map(job => job.id)).toEqual([
      'ashby-bulk-maple-Case', 'ashby-bulk-maple-case', 'ashby-bulk-maple-case ', 'ashby-bulk-maple-constructor',
    ])
    expect(result.publishedIds).toEqual([
      'ashby-bulk-maple-Case', 'ashby-bulk-maple-case', 'ashby-bulk-maple-case ', 'ashby-bulk-maple-constructor',
    ])
    expect(result.jobs.map(job => job.url)).toEqual(Array(4).fill('https://example.com/same-job'))
  })

  it('keeps multiple secondary locations within one posting ID without inventing duplicate jobs', async () => {
    respond({ apiVersion: '1', jobs: [bulkAshby('multi', { secondaryLocations: [
      { location: 'Berlin', address: { addressLocality: 'Berlin', addressCountry: 'DEU' } },
      { location: 'London', address: { addressLocality: 'London', addressCountry: 'GBR' } },
    ] })] })
    const result = await fetchAshbyBoard(BULK_COMPANIES.ashby, BULK_TIME)
    expect(result).toMatchObject({ total: 1, unmappedCount: 0, publishedIds: ['ashby-bulk-maple-multi'] })
    expect(result.jobs).toHaveLength(1)
    expect(result.jobs[0]).toMatchObject({ id: 'ashby-bulk-maple-multi', cityIds: ['london', 'berlin'] })
  })

  it('excludes a unique unlisted row normally while retaining listed nontechnical publication IDs', async () => {
    respond({ apiVersion: '1', jobs: [bulkAshby('technical'), bulkAshbySales('sales'), bulkAshby('direct-only', { isListed: false })] })
    const result = await fetchAshbyBoard(BULK_COMPANIES.ashby, BULK_TIME)
    expect(result.total).toBe(2)
    expect(result.jobs.map(job => job.id)).toEqual(['ashby-bulk-maple-technical'])
    expect(result.publishedIds).toEqual(['ashby-bulk-maple-technical', 'ashby-bulk-maple-sales'])
  })

  it('treats unique unlisted rows as a successful empty public inventory', async () => {
    respond({ apiVersion: '1', jobs: [bulkAshby('direct-one', { isListed: false }), bulkAshby('direct-two', { isListed: false })] })
    expect(await fetchAshbyBoard(BULK_COMPANIES.ashby, BULK_TIME)).toEqual({ jobs: [], total: 0, unmappedCount: 0, publishedIds: [] })
  })

  it('validates the whole schema before inspecting otherwise valid duplicate IDs', async () => {
    respond({ apiVersion: '1', jobs: [bulkAshby('same'), bulkAshby('same'), { ...bulkAshby('bad'), isListed: 'false' }] })
    await expect(fetchAshbyBoard(BULK_COMPANIES.ashby, BULK_TIME)).rejects.toThrow('Ashby 게시판의 공고 형식을 확인하지 못했어요.')
  })

  it('applies the raw-row maximum before excluding20001 unique unlisted rows', async () => {
    respond({ apiVersion: '1', jobs: Array.from({ length: 20001 }, (_, index) => bulkAshby(`hidden-${index}`, { isListed: false })) })
    await expect(fetchAshbyBoard(BULK_COMPANIES.ashby, BULK_TIME)).rejects.toThrow('Ashby 게시판의 공고 형식을 확인하지 못했어요.')
  })

  it('accepts exactly20000 unique unlisted rows as an empty public inventory', async () => {
    respond({ apiVersion: '1', jobs: Array.from({ length: 20000 }, (_, index) => bulkAshby(`hidden-${index}`, { isListed: false })) })
    expect(await fetchAshbyBoard(BULK_COMPANIES.ashby, BULK_TIME)).toEqual({ jobs: [], total: 0, unmappedCount: 0, publishedIds: [] })
  })

  it('accepts a truly empty jobs array', async () => {
    respond({ apiVersion: '1', jobs: [] })
    expect(await fetchAshbyBoard(BULK_COMPANIES.ashby, BULK_TIME)).toEqual({ jobs: [], total: 0, unmappedCount: 0, publishedIds: [] })
  })
})

const providers = [
  {
    provider: 'greenhouse' as const, ids: ['greenhouse-bulk-cedar-7101', 'greenhouse-bulk-cedar-7102', 'greenhouse-bulk-cedar-7103'],
    technical: ['greenhouse-bulk-cedar-7101', 'greenhouse-bulk-cedar-7102'], newId: 'greenhouse-bulk-cedar-7104',
  },
  {
    provider: 'ashby' as const, ids: ['ashby-bulk-maple-tracked', 'ashby-bulk-maple-retained', 'ashby-bulk-maple-sales'],
    technical: ['ashby-bulk-maple-tracked', 'ashby-bulk-maple-retained'], newId: 'ashby-bulk-maple-new-public',
  },
]
function pipeline(provider: BulkProvider, withControl = true) {
  let now = Date.parse(BULK_TIME)
  let stored: CachedBoard[] = []
  let responses = bulkResponses(provider, 'healthy')
  const fetcher = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (!Object.hasOwn(responses, url)) throw new Error(`Unexpected fixture URL ${url}`)
    return Response.json(responses[url])
  })
  vi.stubGlobal('fetch', fetcher)
  const cache = {
    load: async () => parseCachedBoards({ version: 5, boards: structuredClone(stored) }),
    save: async (next: CachedBoard[]) => { stored = structuredClone(next) },
  }
  const fetchBoard = (company: Company, at: string) => company.provider === 'greenhouse' ? fetchGreenhouseBoard(company, at)
    : company.provider === 'ashby' ? fetchAshbyBoard(company, at) : fetchLeverBoard(company, at)
  return {
    create: () => createCatalogService({
      companies: [BULK_COMPANIES[provider], ...(withControl ? [BULK_COMPANIES.control] : [])],
      cache, fetchBoard, now: () => now, random: () => 0,
    }),
    fetcher, cache: () => stored, at: (time: string) => { now = Date.parse(time) }, now: () => now,
    phase: (phase: BulkPhase) => { responses = bulkResponses(provider, phase) },
    replace: (next: Record<string, unknown>) => { responses = next },
  }
}
for (const item of providers) describe(`${item.provider} through the real catalog and cache parser`, () => {
  const company = BULK_COMPANIES[item.provider]
  const save = (job: SavedJob['job']): SavedJob => ({
    job: structuredClone(job), company, note: BULK_NOTE, status: 'applied', savedAt: '2026-09-26T09:00:30.000Z',
  })

  it('retains the exact prior snapshot and unknown saved status through failure/restart, then unique and empty recovery', async () => {
    const fixture = pipeline(item.provider)
    const service = fixture.create()
    const first = await service.get()
    expect(first.jobs.map(job => job.id)).toEqual([...item.technical, 'lever-bulk-birch-control-one'])
    const saved = save(first.jobs[0])
    const originalSaved = structuredClone(saved)
    const original = structuredClone(fixture.cache()[0])
    expect(original.snapshot).toMatchObject({ fetchedAt: BULK_TIME, total: 3, publishedIds: item.ids })
    fixture.phase('duplicate')
    fixture.at(BULK_CHANGE_TIME)
    const failed = await service.get(true)
    expect(failed.jobs.map(job => job.id)).toEqual([...item.technical, 'lever-bulk-birch-control-one', 'lever-bulk-birch-control-two'])
    expect(failed.boards).toMatchObject([
      { status: 'error', dataStatus: 'stale', lastSuccessAt: BULK_TIME, total: 3, included: 2 },
      { status: 'ok', dataStatus: 'fresh', lastSuccessAt: BULK_CHANGE_TIME, total: 2, included: 2 },
    ])
    expect(fixture.cache()[0].snapshot).toEqual(original.snapshot)
    expect(fixture.cache()[0]).toMatchObject({
      checkedAt: BULK_CHANGE_TIME, failures: 1, retryAt: '2026-09-26T09:03:00.000Z', error: duplicateMessage,
    })
    const status = await service.getPostingStatus(true)
    expect(status.boards[0]).toMatchObject({
      status: 'error', lastSuccessAt: BULK_TIME,
      listing: { publishedIds: item.ids, validUntil: '2026-09-26T09:30:00.000Z' },
    })
    expect(observeSavedPosting(saved, status, undefined, fixture.now())).toMatchObject({
      state: 'unknown', checkedAt: BULK_TIME,
      message: '회사 게시판 조회에 실패했어요. 이전 목록으로 게시 종료를 판단하지 않습니다.',
    })
    expect(fixture.fetcher).toHaveBeenCalledTimes(4)
    const restarted = fixture.create()
    expect((await restarted.get()).jobs).toEqual(failed.jobs)
    expect((await restarted.getPostingStatus(true)).boards).toEqual(status.boards)
    expect(fixture.fetcher).toHaveBeenCalledTimes(4)
    fixture.phase('recovered')
    fixture.at(BULK_RECOVERY_TIME)
    const recovered = await restarted.get(true)
    expect(recovered.jobs.map(job => job.id)).toEqual([...item.technical, item.newId, 'lever-bulk-birch-control-one', 'lever-bulk-birch-control-two'])
    expect(recovered.boards[0]).toMatchObject({ status: 'ok', dataStatus: 'fresh', total: 4, included: 3, lastSuccessAt: BULK_RECOVERY_TIME })
    expect(fixture.cache()[0].snapshot?.publishedIds).toEqual([...item.ids, item.newId])
    expect(observeSavedPosting(saved, await restarted.getPostingStatus(), undefined, fixture.now()).state).toBe('listed')
    fixture.phase('empty')
    fixture.at(BULK_EMPTY_TIME)
    const empty = await restarted.get(true)
    expect(empty.jobs.map(job => job.id)).toEqual(['lever-bulk-birch-control-one', 'lever-bulk-birch-control-two'])
    expect(fixture.cache()[0].snapshot).toEqual({ fetchedAt: BULK_EMPTY_TIME, jobs: [], total: 0, unmappedCount: 0, publishedIds: [] })
    expect(observeSavedPosting(saved, await restarted.getPostingStatus(), undefined, fixture.now()).state).toBe('missing')
    expect(fixture.fetcher).toHaveBeenCalledTimes(8)
    expect(saved).toEqual(originalSaved)
  })

  it('does not create an authoritative empty snapshot or listing for a cold invalid inventory', async () => {
    const fixture = pipeline(item.provider, false)
    fixture.phase('cold-duplicate')
    const service = fixture.create()
    await expect(service.get()).rejects.toBeInstanceOf(CatalogUnavailableError)
    expect(fixture.cache()).toHaveLength(1)
    expect(fixture.cache()[0]).toMatchObject({
      failures: 1, checkedAt: BULK_TIME, retryAt: '2026-09-26T09:01:00.000Z', error: duplicateMessage,
    })
    expect(fixture.cache()[0]).not.toHaveProperty('snapshot')
    const status = await service.getPostingStatus(true)
    expect(status.boards[0]).toMatchObject({ status: 'error', lastSuccessAt: null })
    expect(status.boards[0]).not.toHaveProperty('listing')
    expect(fixture.fetcher).toHaveBeenCalledTimes(1)
  })

  it('keeps unique listed IDs authoritative when all developer content changes to excluded occupations', async () => {
    const fixture = pipeline(item.provider, false)
    const service = fixture.create()
    const saved = save((await service.get()).jobs[0])
    fixture.replace(item.provider === 'greenhouse' ? {
      [BULK_URLS.greenhouse]: { jobs: [bulkGreenhouseSales(7101), bulkGreenhouseSales(7102), bulkGreenhouseSales(7103)], meta: { total: 3 } },
    } : {
      [BULK_URLS.ashby]: { apiVersion: '1', jobs: [bulkAshbySales('tracked'), bulkAshbySales('retained'), bulkAshbySales('sales'), bulkAshby('direct-only', { isListed: false })] },
    })
    fixture.at(BULK_CHANGE_TIME)
    const result = await service.get(true)
    expect(result.jobs).toEqual([])
    expect(result.boards[0]).toMatchObject({ status: 'ok', total: 3, included: 0 })
    const index = await service.getPostingStatus()
    expect(index.boards[0].listing).toMatchObject({ publishedIds: item.ids, jobs: [] })
    expect(observeSavedPosting(saved, index, undefined, fixture.now())).toMatchObject({
      state: 'listed', message: '게시판에는 있지만 현재 탐색 범위 밖의 공고라 내용은 원문에서 확인해야 합니다.',
    })
  })
})
