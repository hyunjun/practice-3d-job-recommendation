import { afterEach, describe, expect, it, vi } from 'vitest'
import { PUBLIC_COMPANIES } from '../../shared/companies'
import { JobSchema } from '../../shared/schemas'
import { createSampleCatalog } from '../../shared/sample'
import { DEFAULT_FILTERS, SAMPLE_PROFILE } from '../../shared/types'
import { filterJobs, formatCompensation, formatJobSalary } from '../../shared/matching'
import { BoardFetchError, CATALOG_POLICY, createCatalogService } from '../../server/catalog-service'
import type { CachedBoard } from '../../server/board-cache'
import { normalizeCompensation } from '../../shared/compensation'
import { countryCode, postingCities, remoteScope } from '../../server/normalize'
import { AshbyJobSchema, fetchAshbyBoard, normalizeAshbyJob } from '../../server/providers/ashby'
import { fetchLeverBoard, normalizeLeverJob } from '../../server/providers/lever'
import { fetchGreenhouseBoard } from '../../server/providers/greenhouse'
import { ashbyPosting, leverPosting, POSTING_TIME } from '../fixtures/public-postings'

const ashby = PUBLIC_COMPANIES.find(company => company.id === 'supabase')!
const lever = PUBLIC_COMPANIES.find(company => company.id === 'spotify')!
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('provider-specific facts and common job identity', () => {
  it('uses structured Ashby conditions, keeps salary separate from equity and ignores the combined summary', () => {
    const job = normalizeAshbyJob(ashbyPosting(), ashby.id, POSTING_TIME)!
    expect(job).toMatchObject({
      source: 'ashby', id: `ashby-${ashby.id}-shared-fixture-id`, cityIds: ['london'],
      workMode: 'hybrid', employment: 'fulltime', salary: { min: 100000, max: 140000, currency: 'GBP' },
      evidence: { workMode: { source: 'board', text: 'workplaceType: Hybrid' }, employment: { text: 'employmentType: FullTime' } },
    })
    expect(job.compensationRanges).toHaveLength(1)
    expect(JobSchema.safeParse(job).success).toBe(true)
  })

  it('preserves native source identity and distinguishes permanent contracts from full-time hours', () => {
    const first = normalizeAshbyJob(ashbyPosting(), 'same-company', POSTING_TIME)!
    const second = normalizeLeverJob(leverPosting(), 'same-company', POSTING_TIME)!
    expect(first.id).not.toBe(second.id)
    expect(second).toMatchObject({
      source: 'lever', cityIds: ['london', 'berlin'], employment: 'permanent', workMode: 'hybrid',
      salary: { currency: 'EUR', min: 90000, max: 130000 },
      evidence: { employment: { source: 'board', text: 'commitment: Permanent' } },
    })
    expect(second.skills).toContain('Python')
    expect(JobSchema.safeParse(second).success).toBe(true)
  })

  it('never recommends unlisted or non-developer Ashby postings and respects compensation display flags', () => {
    expect(normalizeAshbyJob(ashbyPosting({ isListed: false }), ashby.id, POSTING_TIME)).toBeNull()
    expect(normalizeAshbyJob(ashbyPosting({ title: 'Account Executive' }), ashby.id, POSTING_TIME)).toBeNull()
    const job = normalizeAshbyJob(ashbyPosting({ shouldDisplayCompensationOnJobPostings: false }), ashby.id, POSTING_TIME)!
    expect(job.salary).toBeNull()
    expect(job.compensationRanges).toBeUndefined()
  })

  it('reads both documented and observed secondary addresses, deduplicates cities and rejects namesakes', () => {
    const raw = AshbyJobSchema.parse(ashbyPosting({
      secondaryLocations: [
        { location: 'Berlin Office', address: { addressLocality: 'Berlin', addressCountry: 'DEU' } },
        { location: 'Berlin', address: { postalAddress: { addressLocality: 'Berlin', addressCountry: 'Germany' } } },
        { location: 'London, Ontario', address: { postalAddress: { addressLocality: 'London', addressCountry: 'CAN' } } },
      ],
    }))
    expect(normalizeAshbyJob(raw, ashby.id, POSTING_TIME)!.cityIds).toEqual(['london', 'berlin'])
    expect(postingCities([{ label: 'London', address: { addressLocality: 'London', addressCountry: 'Uganda' } }])).toEqual([])
    expect(countryCode('North Korea')).toBe('KP')
  })

  it('uses isRemote as a fallback while retaining ambiguity when structured facts contradict the label', () => {
    const remote = normalizeAshbyJob(ashbyPosting({ workplaceType: null, isRemote: true, location: 'Remote, Global', address: null }), ashby.id, POSTING_TIME)!
    expect(remote).toMatchObject({ workMode: 'remote', remoteWorldwide: true, cityIds: [] })
    expect(remote.evidence?.workMode?.text).toBe('isRemote: true')
    const contradictory = normalizeAshbyJob(ashbyPosting({ workplaceType: null, isRemote: false, location: 'Remote, Global' }), ashby.id, POSTING_TIME)!
    expect(contradictory.workMode).toBe('unknown')
    expect(contradictory.remoteWorldwide).toBe(false)
  })

  it('separates regional discovery from country eligibility and does not turn office addresses into eligibility', () => {
    const job = normalizeAshbyJob(ashbyPosting({ location: 'Europe', workplaceType: 'Remote', isRemote: true }), ashby.id, POSTING_TIME)!
    expect(job).toMatchObject({ cityIds: [], remoteCountries: [], remoteScopeUnknown: true, remoteRegions: ['europe'] })
    const catalog = { ...createSampleCatalog(), jobs: [job], companies: [ashby] }
    expect(filterJobs(catalog, SAMPLE_PROFILE, { ...DEFAULT_FILTERS, region: 'europe' })).toHaveLength(0)
    expect(filterJobs(catalog, SAMPLE_PROFILE, { ...DEFAULT_FILTERS, region: 'europe', remoteEligibleOnly: false })).toHaveLength(1)
    expect(filterJobs(catalog, SAMPLE_PROFILE, { ...DEFAULT_FILTERS, region: 'americas', remoteEligibleOnly: false })).toHaveLength(0)
    const country = normalizeLeverJob(leverPosting({ country: 'CA', workplaceType: 'remote', categories: { location: 'Remote' } }), lever.id, POSTING_TIME)!
    expect(country.remoteCountries).toEqual(['CA'])
  })

  it('recognizes country codes and global labels without mistaking California, prose or exclusions for permission', () => {
    expect(remoteScope('Remote, CAN').remoteCountries).toEqual(['CA'])
    expect(remoteScope('Remote, San Francisco, CA').remoteCountries).toEqual(['US'])
    expect(remoteScope('Remote — can work anywhere').remoteCountries).toEqual([])
    expect(remoteScope('Remote, Global').remoteWorldwide).toBe(true)
    expect(remoteScope('Worldwide except US')).toMatchObject({ remoteWorldwide: false, remoteScopeUnknown: true, remoteCountries: [] })
  })
})

describe('conditional and non-annual compensation', () => {
  it('preserves different currencies and tiers without manufacturing one comparable annual range', () => {
    const salary = normalizeCompensation([
      { label: 'Europe', currency: 'EUR', min: 90000, max: 130000, interval: '1 YEAR' },
      { label: 'United Kingdom', currency: 'GBP', min: 110000, max: 150000, interval: '1 YEAR' },
    ])
    expect(salary.salary).toBeNull()
    expect(salary.compensationRanges).toHaveLength(2)
    expect(formatCompensation(salary.compensationRanges![1])).toBe('GBP 110,000–150,000 / 년')
    const job = { ...normalizeAshbyJob(ashbyPosting(), ashby.id, POSTING_TIME)!, ...salary }
    expect(formatJobSalary(job)).toBe('별도 보상 조건')
    const catalog = { ...createSampleCatalog(), jobs: [job], companies: [ashby] }
    expect(filterJobs(catalog, SAMPLE_PROFILE, DEFAULT_FILTERS)).toHaveLength(1)
    expect(filterJobs(catalog, SAMPLE_PROFILE, { ...DEFAULT_FILTERS, includeUnknownSalary: false })).toHaveLength(0)
  })

  it('compares identical annual tiers but keeps incomplete, hourly, monthly and unsupported currencies separate', () => {
    const range = { currency: 'USD', min: 120000, max: 180000, interval: 'per-year-salary' }
    expect(normalizeCompensation([{ ...range, label: 'A' }, { ...range, label: 'B' }]).salary).toEqual({ currency: 'USD', min: 120000, max: 180000 })
    for (const changed of [{ interval: '1 HOUR' }, { interval: '1 MONTH' }, { currency: 'PLN' }, { interval: 'unknown' }]) {
      const result = normalizeCompensation([{ ...range, ...changed }])
      expect(result.salary).toBeNull()
      expect(result.compensationRanges).toHaveLength(1)
    }
    expect(normalizeCompensation([range, { ...range, max: null }]).salary).toBeNull()
    expect(normalizeCompensation([{ ...range, min: 0, max: 0 }]).compensationRanges).toBeUndefined()
  })
})

describe('public feed collection', () => {
  it('excludes unlisted Ashby jobs, treats an empty published feed as authoritative and rejects incomplete responses', async () => {
    const fetcher = vi.fn()
    vi.stubGlobal('fetch', fetcher)
    fetcher.mockResolvedValueOnce(Response.json({ apiVersion: '1', jobs: [ashbyPosting(), ashbyPosting({ id: 'unlisted', isListed: false })] }))
    const result = await fetchAshbyBoard(ashby, POSTING_TIME)
    expect(result.total).toBe(1)
    expect(result.jobs).toHaveLength(1)
    expect(fetcher.mock.calls[0][0]).toContain('includeCompensation=true')
    fetcher.mockResolvedValueOnce(Response.json({ apiVersion: '1', jobs: [] }))
    expect(await fetchAshbyBoard(ashby, POSTING_TIME)).toEqual({ jobs: [], total: 0, unmappedCount: 0, publishedIds: [] })
    for (const payload of [{ apiVersion: '2', jobs: [] }, { apiVersion: '1', jobs: [{ id: 'missing-fields' }] }]) {
      fetcher.mockResolvedValueOnce(Response.json(payload))
      await expect(fetchAshbyBoard(ashby, POSTING_TIME)).rejects.toBeInstanceOf(BoardFetchError)
    }
  })

  it('reads all Lever pages through one deadline, deduplicates overlapping IDs and supports the EU endpoint', async () => {
    const fetcher = vi.fn()
    vi.stubGlobal('fetch', fetcher)
    const page = Array.from({ length: 50 }, (_, index) => leverPosting({ id: `page-${index}` }))
    fetcher.mockResolvedValueOnce(Response.json(page))
    fetcher.mockResolvedValueOnce(Response.json([page[49], leverPosting({ id: 'last-page' })]))
    const result = await fetchLeverBoard({ ...lever, boardRegion: 'eu' }, POSTING_TIME)
    expect(result.total).toBe(51)
    expect(result.jobs).toHaveLength(51)
    expect(result.publishedIds).toHaveLength(51)
    expect(result.publishedIds).toContain(`lever-${lever.id}-last-page`)
    expect(fetcher.mock.calls[0][0]).toBe('https://api.eu.lever.co/v0/postings/spotify?mode=json&limit=50&skip=0')
    expect(fetcher.mock.calls[1][0]).toContain('skip=50')
    expect(fetcher.mock.calls[0][1].signal).toBe(fetcher.mock.calls[1][1].signal)
  })

  it('preserves a complete snapshot when a later Lever page fails and honors the provider retry deadline', async () => {
    const oldJob = normalizeLeverJob(leverPosting({ id: 'previous' }), lever.id, POSTING_TIME)!
    let cached: CachedBoard[] = [{
      companyId: lever.id, board: lever.board!, provider: 'lever', checkedAt: POSTING_TIME, failures: 0, retryAt: null,
      snapshot: { fetchedAt: POSTING_TIME, jobs: [{ ...oldJob, source: 'lever' }], total: 1, unmappedCount: 0, publishedIds: [oldJob.id] },
    }]
    const now = Date.parse(POSTING_TIME) + CATALOG_POLICY.freshFor
    vi.spyOn(Date, 'now').mockReturnValue(now)
    const fetcher = vi.fn()
    vi.stubGlobal('fetch', fetcher)
    fetcher.mockResolvedValueOnce(Response.json(Array.from({ length: 50 }, (_, index) => leverPosting({ id: `partial-${index}` }))))
    fetcher.mockResolvedValueOnce(new Response('', { status: 429, headers: { 'Retry-After': '600' } }))
    const service = createCatalogService({
      companies: [lever], cache: { load: async () => cached, save: async boards => { cached = boards } },
      fetchBoard: fetchLeverBoard, now: () => now, random: () => 0,
    })
    const result = await service.get()
    expect(result.jobs).toHaveLength(1)
    expect(result.jobs[0]).toMatchObject({ id: oldJob.id, fetchedAt: POSTING_TIME, stale: true })
    expect(result.boards[0]).toMatchObject({ provider: 'lever', status: 'error', included: 1, retryAt: new Date(now + 600000).toISOString() })
    await service.get(true)
    expect((await service.getPostingStatus(true)).boards[0]).toMatchObject({
      status: 'error', lastSuccessAt: POSTING_TIME, listing: { publishedIds: [oldJob.id] },
    })
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(cached[0].snapshot?.jobs).toEqual([oldJob])
  })

  it('retains unmapped Ashby jobs and all published IDs while excluding non-developer and unlisted content', async () => {
    const fetcher = vi.fn(async () => Response.json({ apiVersion: '1', jobs: [
      ashbyPosting(), ashbyPosting(),
      ashbyPosting({ id: 'non-developer', title: 'Account Executive' }),
      ashbyPosting({ id: 'unmapped', location: 'Unknown Office', address: null, secondaryLocations: [], workplaceType: 'OnSite' }),
      ashbyPosting({ id: 'unlisted', isListed: false }),
    ] }))
    vi.stubGlobal('fetch', fetcher)
    const result = await fetchAshbyBoard(ashby, POSTING_TIME)
    expect(result.total).toBe(3)
    expect(result.jobs).toHaveLength(2)
    expect(result.jobs[1]).toMatchObject({ id: `ashby-${ashby.id}-unmapped`, cityIds: [], locationLabel: 'Unknown Office', workMode: 'onsite' })
    expect(result.unmappedCount).toBe(1)
    expect(result.publishedIds).toEqual([
      `ashby-${ashby.id}-shared-fixture-id`, `ashby-${ashby.id}-non-developer`, `ashby-${ashby.id}-unmapped`,
    ])
  })

  it('retains Greenhouse city, country and placeholder locations without substituting attached offices', async () => {
    const company = PUBLIC_COMPANIES.find(item => item.id === 'stripe')!
    const locations = ['Gurugram', 'Ireland', 'N/A', 'Cork, Ireland']
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({
      jobs: locations.map((location, index) => ({
        id: 8000 + index, title: `Backend Engineer — location fixture ${index}`,
        absolute_url: `https://example.com/jobs/location-${index}`, location: { name: location },
        content: '<p>Build software with TypeScript.</p>',
        offices: [{ name: 'Dublin', location: 'Dublin, Ireland' }],
      })),
      meta: { total: locations.length },
    })))
    const result = await fetchGreenhouseBoard(company, POSTING_TIME)
    expect(result.jobs.map(job => job.locationLabel)).toEqual(locations)
    expect(result.jobs.every(job => job.cityIds.length === 0 && job.workMode === 'unknown')).toBe(true)
    expect(result).toMatchObject({ total: 4, unmappedCount: 4 })
    expect(result.publishedIds).toEqual(result.jobs.map(job => job.id))
  })

  it('retains Lever country-only and unsupported cities separately from confirmed remote jobs', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json([
      leverPosting({ id: 'country-only', country: 'IE', categories: { location: 'Ireland' }, workplaceType: null }),
      leverPosting({ id: 'outside-map', country: 'RO', categories: { location: 'Bucharest' }, workplaceType: 'on-site' }),
      leverPosting({ id: 'remote', country: 'US', categories: { location: 'Remote' }, workplaceType: 'remote' }),
      leverPosting({ id: 'non-developer', text: 'Account Executive' }),
    ])))
    const result = await fetchLeverBoard(lever, POSTING_TIME)
    expect(result).toMatchObject({ total: 4, unmappedCount: 2 })
    expect(result.jobs).toHaveLength(3)
    expect(result.jobs.map(job => job.workMode)).toEqual(['unknown', 'onsite', 'remote'])
    expect(result.jobs.every(job => job.cityIds.length === 0)).toBe(true)
    expect(result.publishedIds).toHaveLength(4)
  })

  it('fails repeated or malformed pages instead of publishing a truncated Lever feed', async () => {
    const page = Array.from({ length: 50 }, (_, index) => leverPosting({ id: `repeated-${index}` }))
    const fetcher = vi.fn().mockResolvedValue(Response.json(page))
    vi.stubGlobal('fetch', fetcher)
    fetcher.mockImplementation(async () => Response.json(page))
    await expect(fetchLeverBoard(lever, POSTING_TIME)).rejects.toThrow('다음 공고 페이지')
    expect(fetcher).toHaveBeenCalledTimes(2)
    fetcher.mockResolvedValueOnce(Response.json({ jobs: [] }))
    await expect(fetchLeverBoard(lever, POSTING_TIME)).rejects.toBeInstanceOf(BoardFetchError)
  })
})
