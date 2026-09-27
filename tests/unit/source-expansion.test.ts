import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseCachedBoards } from '../../server/board-cache'
import type { CachedBoard } from '../../server/board-cache'
import { BoardInventoryError, createCatalogService } from '../../server/catalog-service'
import { fetchGreenhouseBoard } from '../../server/providers/greenhouse'
import { fetchAshbyBoard } from '../../server/providers/ashby'
import { fetchLeverBoard } from '../../server/providers/lever'
import { createSmartRecruitersFetcher } from '../../server/providers/smartrecruiters'
import { fetchWorkableBoard } from '../../server/providers/workable'
import { fetchHimalayasBoard } from '../../server/providers/himalayas'
import { createCareersFetcher } from '../../server/providers/careers'
import { PUBLIC_COMPANIES } from '../../shared/companies'
import { createSearchIndex, selectSearchJobs } from '../../shared/job-search'
import { DEFAULT_FILTERS } from '../../shared/types'
import { CAREERS_WIRE_JOBS } from '../fixtures/careers-wire'
import { mockCareersFetch } from '../fixtures/careers-fetch-mock'
import { SOURCE_EXPANSION_IDS, SOURCE_EXPANSION_PROVIDER_COUNTS, SOURCE_EXPANSION_REGISTRATIONS } from '../fixtures/source-expansion-contract'
import { SOURCE_EXPANSION_ATS_JOBS } from '../fixtures/source-expansion-postings'
import { SOURCE_EXPANSION_ALL_FULL_URLS, SOURCE_EXPANSION_EXCLUDED_IDS, SOURCE_EXPANSION_NOW, sourceExpansionOld93Cache, sourceExpansionResponses } from '../fixtures/source-expansion-wire'
import { SEARCH_PROFILE } from '../fixtures/search-catalog'
import { REGIONAL_SOURCE_FULL_URLS } from '../fixtures/regional-sources'

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('both approved expansion cohorts and preserved original93 contracts', () => {
  it('appends exactly31 literal registrations with22 regional and9 cross-industry employers', () => {
    expect(PUBLIC_COMPANIES).toHaveLength(130)
    expect(PUBLIC_COMPANIES.slice(93, 124).map(({ id, name, provider, board, careerUrl, industry }) =>
      ({ id, name, provider, board, careerUrl, industry }))).toEqual(
      SOURCE_EXPANSION_REGISTRATIONS.map(({ cohort: _cohort, region: _region, ...company }) => company),
    )
    expect(PUBLIC_COMPANIES.slice(93, 124).map(company => company.id)).toEqual(SOURCE_EXPANSION_IDS)
    expect(SOURCE_EXPANSION_REGISTRATIONS.filter(company => company.cohort === 'regional')).toHaveLength(22)
    expect(SOURCE_EXPANSION_REGISTRATIONS.filter(company => company.cohort === 'cross-industry')).toHaveLength(9)
    expect(Object.fromEntries(Object.keys(SOURCE_EXPANSION_PROVIDER_COUNTS).map(provider => [
      provider, PUBLIC_COMPANIES.slice(0, 124).filter(company => company.provider === provider).length,
    ]))).toEqual({ greenhouse: 65, ashby: 27, lever: 9, smartrecruiters: 10, workable: 3, himalayas: 7, careers: 3 })
    expect(PUBLIC_COMPANIES[123]).toMatchObject({ id: 'auto1', name: 'AUTO1 Group', provider: 'smartrecruiters', board: 'Auto1' })
    // Deferred sources must not be represented as covered by an unrelated board.
    for (const id of ['walmart', 'traderepublic', 'toyotaconnected', 'bosch']) expect(PUBLIC_COMPANIES.some(company => company.id === id)).toBe(false)
  })

  it('collects all31 through their exact routes, keeps every old source snapshot and exposes only34 new computing jobs', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse(SOURCE_EXPANSION_NOW))
    const raw = sourceExpansionOld93Cache()
    const before = JSON.stringify(raw)
    let boards: CachedBoard[] = parseCachedBoards(raw)
    const transport = mockCareersFetch(sourceExpansionResponses())
    const smart = createSmartRecruitersFetcher({ concurrency: 1, interval: 0, timeout: 30_000 })
    const careers = createCareersFetcher({ concurrency: 1, interval: 0, bookingInterval: 0, timeout: 30_000 })
    const fetchers = {
      greenhouse: fetchGreenhouseBoard, ashby: fetchAshbyBoard, lever: fetchLeverBoard,
      smartrecruiters: smart, workable: fetchWorkableBoard, himalayas: fetchHimalayasBoard, careers: careers.fetchBoard,
    }
    const cache = { load: async () => structuredClone(boards), save: async (value: CachedBoard[]) => { boards = structuredClone(value) } }
    const service = () => createCatalogService({
      companies: PUBLIC_COMPANIES, cache, now: () => Date.parse(SOURCE_EXPANSION_NOW), random: () => 0,
      fetchBoard: (company, at) => fetchers[company.provider ?? 'greenhouse'](company, at),
    })
    const current = service()
    const catalog = await current.get()
    expect(catalog.companies).toHaveLength(130)
    expect(catalog.boards).toHaveLength(130)
    expect(catalog.boards.every(board => board.status === 'ok' && board.dataStatus === 'fresh')).toBe(true)
    expect(catalog.jobs).toHaveLength(36)
    expect(catalog.boards.reduce((sum, board) => sum + board.total, 0)).toBe(164)
    const added = catalog.jobs.filter(job => (SOURCE_EXPANSION_IDS as readonly string[]).includes(job.companyId))
    expect(added).toHaveLength(34)
    const expected = [...SOURCE_EXPANSION_ATS_JOBS, ...CAREERS_WIRE_JOBS]
    for (const literal of expected) {
      const { country: _country, nativeId: _nativeId, ...facts } = { country: '', nativeId: '', ...literal }
      expect(added.find(job => job.id === literal.id)).toMatchObject(facts)
    }
    for (const id of SOURCE_EXPANSION_EXCLUDED_IDS) expect(catalog.jobs.some(job => job.id === id)).toBe(false)
    expect(transport.urls().sort()).toEqual([...SOURCE_EXPANSION_ALL_FULL_URLS, ...REGIONAL_SOURCE_FULL_URLS].sort())
    expect(transport.urls().some(url => url.includes('/companies/AUTO1/'))).toBe(false)
    expect(boards).toHaveLength(130)
    for (const previous of raw.boards) {
      const retained = boards.find(board => board.companyId === previous.companyId)!
      expect(retained).toMatchObject({ checkedAt: previous.checkedAt, retryAt: previous.retryAt, failures: previous.failures,
        snapshot: { fetchedAt: previous.snapshot.fetchedAt, total: previous.snapshot.total, publishedIds: previous.snapshot.publishedIds } })
      expect(retained.snapshot!.jobs.map(job => [job.id, job.title, job.url, job.description, job.fetchedAt, job.updatedAt]))
        .toEqual(previous.snapshot.jobs.map(job => [job.id, job.title, job.url, job.description, job.fetchedAt, job.updatedAt]))
    }
    const index = createSearchIndex(catalog, { ...SEARCH_PROFILE, desiredRole: 'all', skills: [] })
    for (const [query, region, ids] of [
      ['Booking.com', 'europe', ['careers-booking-640001']],
      ['Booking Holdings', 'americas', ['careers-booking-640101']],
      ['Zalando', 'europe', ['careers-zalando-640001', 'careers-zalando-640016']],
      ['Starbucks', 'americas', ['careers-starbucks-640001', 'careers-starbucks-640011']],
      ['IKEA', 'europe', ['smartrecruiters-ikea-synthetic-650016']],
      ['AUTO1', 'europe', ['smartrecruiters-auto1-synthetic-650028']],
    ] as const) {
      expect(selectSearchJobs(index, { ...DEFAULT_FILTERS, query, region }).map(entry => entry.job.id).sort()).toEqual([...ids].sort())
    }
    expect(selectSearchJobs(index, { ...DEFAULT_FILTERS, query: 'Starbucks', role: 'backend' }).map(entry => entry.job.id)).toEqual(['careers-starbucks-640001'])
    expect(selectSearchJobs(index, { ...DEFAULT_FILTERS, query: 'IKEA', role: 'unknown' }).map(entry => entry.job.id)).toEqual(['smartrecruiters-ikea-synthetic-650016'])
    for (const query of ['Business Developer', 'Interiors', 'CAD Engineer', 'Battery Test']) {
      expect(selectSearchJobs(index, { ...DEFAULT_FILTERS, query })).toEqual([])
    }
    const status = await current.getPostingStatus()
    expect(status.boards.find(board => board.companyId === 'ikea')?.listing?.publishedIds).toEqual([
      'smartrecruiters-ikea-synthetic-650016', 'smartrecruiters-ikea-synthetic-659016', 'smartrecruiters-ikea-synthetic-659116',
    ])
    const savedBytes = JSON.stringify(boards)
    expect((await service().get()).jobs).toEqual(catalog.jobs)
    expect(JSON.stringify(boards)).toBe(savedBytes)
    expect(transport.urls()).toHaveLength(51)
    expect(JSON.stringify(raw)).toBe(before)
  })

  it('accepts canonical Auto1 but continues rejecting a mismatched AUTO1 company identifier', async () => {
    const responses = sourceExpansionResponses()
    const wrongUrl = 'https://api.smartrecruiters.com/v1/companies/AUTO1/postings?limit=100&offset=0&destination=PUBLIC'
    mockCareersFetch({ [wrongUrl]: responses['https://api.smartrecruiters.com/v1/companies/Auto1/postings?limit=100&offset=0&destination=PUBLIC'] })
    const fetcher = createSmartRecruitersFetcher({ concurrency: 1, interval: 0, timeout: 30_000 })
    const company = { ...PUBLIC_COMPANIES.find(company => company.id === 'auto1')!, board: 'AUTO1' }
    await expect(fetcher(company, SOURCE_EXPANSION_NOW)).rejects.toBeInstanceOf(BoardInventoryError)
  })
})
