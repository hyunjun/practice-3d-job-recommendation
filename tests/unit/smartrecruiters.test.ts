import { afterEach, describe, expect, it, vi } from 'vitest'
import { needsOccupationDescription, upgradeJobOccupation } from '../../shared/job-occupation'
import { JobSchema } from '../../shared/schemas'
import { createSampleCatalog } from '../../shared/sample'
import type { Company, Job, SavedJob } from '../../shared/types'
import { decodeSavedJobs } from '../../shared/saved-jobs'
import { parseCachedBoards } from '../../server/board-cache'
import { BoardFetchError, CATALOG_POLICY, createCatalogService } from '../../server/catalog-service'
import { createSmartRecruitersFetcher, normalizeSmartRecruitersJob, SmartRecruitersJobSchema } from '../../server/providers/smartrecruiters'
import { POSTING_TIME, smartRecruitersPosting } from '../fixtures/public-postings'

const company: Company = {
  id: 'smart-fixture', name: 'Smart fixture', initials: 'S', color: '#90deb8', industry: 'Software',
  careerUrl: 'https://example.com/careers', provider: 'smartrecruiters', board: 'ExampleBoard',
}
const fetchBoard = () => createSmartRecruitersFetcher({ concurrency: 4, interval: 0, timeout: 120_000 })
const normalize = (overrides: Parameters<typeof smartRecruitersPosting>[0] = {}) => normalizeSmartRecruitersJob(smartRecruitersPosting(overrides), company.id, POSTING_TIME)
const pageOf = (content: unknown[], totalFound = content.length, offset = 0) => ({ offset, limit: 100, totalFound, content })
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('SmartRecruiters public facts', () => {
  it('keeps the posting identity, actual city, public employment label and section-specific requirements', () => {
    const raw = smartRecruitersPosting()
    raw.jobAd.sections.qualifications = { title: 'Minimum requirements', text: '<p>You must have 5 years of software engineering experience and Python skills.</p>' }
    const job = normalizeSmartRecruitersJob(raw, company.id, POSTING_TIME)!
    expect(job).toMatchObject({
      id: 'smartrecruiters-smart-fixture-shared-fixture-id', source: 'smartrecruiters', url: raw.postingUrl,
      cityIds: ['melbourne'], workMode: 'hybrid', employment: 'fulltime', updatedAt: POSTING_TIME, fetchedAt: POSTING_TIME,
      occupation: { category: 'engineering' },
      evidence: { workMode: { source: 'board', text: 'location.remote: false\nlocation.hybrid: true' }, employment: { text: 'employmentType: Full-time' } },
    })
    expect(job.qualifications?.experience).toContainEqual(expect.objectContaining({ kind: 'required', minYears: 5 }))
    expect(job.skills).toContain('Python')
    expect(JobSchema.safeParse(job).success).toBe(true)
  })

  it('distinguishes remote, hybrid, onsite and contradictory or missing location flags', () => {
    expect(normalize({ location: { city: 'Sydney', country: 'au', fullLocation: 'Sydney, Australia', remote: true, hybrid: false } })).toMatchObject({
      workMode: 'remote', cityIds: [], remoteCountries: ['AU'], remoteWorldwide: false, remoteScopeUnknown: false,
    })
    expect(normalize({ location: { remote: true, hybrid: true } })).toMatchObject({ workMode: 'unknown', remoteWorldwide: false })
    expect(normalize({ location: { remote: false, hybrid: false } })?.workMode).toBe('onsite')
    expect(normalize({ location: { remote: false } })?.workMode).toBe('unknown')
    expect(normalize({ location: { remote: false, fullLocation: 'Remote, Global' } })).toMatchObject({ workMode: 'unknown', remoteWorldwide: false })
    expect(normalize({ location: { remote: true } })).toMatchObject({ workMode: 'remote', remoteCountries: [], remoteScopeUnknown: true })
  })

  it('does not place unsupported cities, namesakes or country-only postings at a company office', () => {
    for (const location of [
      { city: 'London', region: 'ON', country: 'ca', fullLocation: 'London, Ontario, Canada' },
      { city: 'Vancouver', region: 'WA', country: 'us' },
      { city: 'Melbourne', country: 'xx' },
      { city: 'Petaling Jaya', country: 'my' },
      { country: 'au' },
    ]) expect(normalize({ location: { ...location, remote: false, hybrid: false } })?.cityIds).toEqual([])
    expect(normalize({ location: { city: 'Bangalore', country: 'in' } })?.cityIds).toEqual(['bengaluru'])
  })

  it('preserves a bare compensation range without declaring it base annual salary', () => {
    const job = normalize({ compensation: { min: 100000, max: 140000, currency: 'GBP', period: 'YEARLY' } })!
    expect(job.salary).toBeNull()
    expect(job.compensationRanges).toEqual([expect.objectContaining({ min: 100000, max: 140000, currency: 'GBP', period: 'year', basis: 'unknown' })])
    const monthly = normalize({ compensation: { min: 200000, max: 300000, currency: 'INR', period: 'MONTHLY' } })!
    expect(monthly.salary).toBeNull()
    expect(monthly.compensationRanges?.[0]).toMatchObject({ currency: 'INR', period: 'month', basis: 'unknown' })
    const missing = normalize({ compensation: { min: 100000, max: 140000, currency: null, period: null } })!
    expect(missing.compensationRanges?.[0]).toMatchObject({ currency: null, period: 'unknown' })
  })

  it('uses explicit body salary when the structured compensation is absent or entirely empty', () => {
    const raw = smartRecruitersPosting({ compensation: { min: null, max: null, currency: null, period: null } })
    raw.jobAd.sections.additionalInformation = { text: '<p>Base salary: AUD 140,000 - 190,000 per year.</p>' }
    const job = normalizeSmartRecruitersJob(raw, company.id, POSTING_TIME)!
    expect(job.salary).toEqual({ currency: 'AUD', min: 140000, max: 190000 })
  })

  it('fetches generic research duties and does not establish computing work from a company introduction', () => {
    for (const title of ['Research Scientist', 'Applied Scientist', 'Software Engineer', 'Senior DevOps Engineer', 'AI Researcher']) expect(needsOccupationDescription(title)).toBe(true)
    for (const title of ['Marketing Lead', 'Engineering Manager', 'Technical Support Engineer', 'UX Researcher', 'Staff User Researcher', 'Mechanical Engineer']) expect(needsOccupationDescription(title)).toBe(false)
    const raw = smartRecruitersPosting({
      name: 'Applied Scientist',
      jobAd: { sections: {
        companyDescription: { title: 'Responsibilities', text: '<p>Develop language models and software.</p>' },
        jobDescription: { text: '<p>Study laboratory samples.</p>' },
      } },
    })
    expect(normalizeSmartRecruitersJob(raw, company.id, POSTING_TIME)).toBeNull()
    raw.jobAd.sections.jobDescription = { text: '<p>Develop language models and evaluation datasets.</p>' }
    expect(normalizeSmartRecruitersJob(raw, company.id, POSTING_TIME)).toMatchObject({ role: 'ml', occupation: { category: 'research' } })
  })

  it('retains whitelisted job metadata, ignores numeric management levels and drops unused personal fields', () => {
    const raw = SmartRecruitersJobSchema.parse({
      ...smartRecruitersPosting({ name: 'Software Engineer', customField: [
        { fieldLabel: 'Job Family', valueLabel: 'Backend Engineering' },
        { fieldLabel: 'Management Level', valueLabel: '5' },
        { fieldLabel: 'Internal planning', valueLabel: 'do-not-copy' },
      ] }),
      creator: { name: 'do-not-copy', email: 'private@example.com' },
      applyUrl: 'https://example.com/apply?referrer=do-not-copy',
      typeOfEmployment: { id: 'permanent', label: 'Full-time' },
      experienceLevel: { id: 'mid_senior_level', label: 'Mid-Senior level' },
    })
    const job = normalizeSmartRecruitersJob(raw, company.id, POSTING_TIME)!
    expect(job).toMatchObject({ role: 'backend', employment: 'fulltime', occupation: { category: 'engineering', departments: ['Engineering', 'Backend Engineering'] } })
    expect(job.occupation?.management).toBeUndefined()
    expect(JSON.stringify(job)).not.toMatch(/do-not-copy|private@example.com/)
    expect(normalize({ customField: [{ fieldLabel: 'Management Level', valueLabel: 'People Manager' }] })).toBeNull()
    expect(normalize({ active: false })).toBeNull()
    expect(normalize({ visibility: 'INTERNAL' })).toBeNull()
    const sample = createSampleCatalog()
    expect(sample.companies).toHaveLength(32)
    expect(sample.jobs).toHaveLength(179)
  })

  it('upgrades old user-research classifications in cache and saved records without losing public IDs or private notes', () => {
    const current = normalize({ id: 'engineering' })!
    const legacy: Job = {
      ...current, id: `smartrecruiters-${company.id}-old-user-research`, title: 'Staff User Researcher',
      description: 'Responsibilities\nDevelop AI models to accelerate user research workflows.',
      occupation: {
        version: 1, category: 'research', departments: ['Product Research'],
        evidence: [{ source: 'description', text: 'Responsibilities\nDevelop AI models to accelerate user research workflows.' }],
      },
    }
    expect(JobSchema.safeParse(legacy).success).toBe(true)
    const cached = parseCachedBoards({ version: 5, boards: [{
      companyId: company.id, provider: company.provider, board: company.board, checkedAt: POSTING_TIME, retryAt: null, failures: 0,
      snapshot: { fetchedAt: POSTING_TIME, total: 2, unmappedCount: 0, jobs: [legacy, current], publishedIds: [legacy.id, current.id] },
    }] })[0]
    expect(cached.snapshot?.jobs.map(job => job.id)).toEqual([current.id])
    expect(cached.snapshot?.publishedIds).toEqual([legacy.id, current.id])
    expect(cached.snapshot?.fetchedAt).toBe(POSTING_TIME)
    const saved: SavedJob = { job: legacy, company, savedAt: POSTING_TIME, note: 'preserve this private note', status: 'applied' }
    expect(decodeSavedJobs(JSON.stringify([saved])).records).toMatchObject([{
      savedAt: POSTING_TIME, note: saved.note, status: 'applied',
      job: { id: legacy.id, fetchedAt: POSTING_TIME, occupation: { version: 2, category: 'other', departments: ['Product Research'] } },
    }])
    expect(legacy.occupation?.version).toBe(1)
    for (const title of ['User Researcher', 'Market Researcher', 'People Researchers']) expect(needsOccupationDescription(title)).toBe(false)
  })

  it('preserves old management metadata and evidence beyond a truncated description during the version upgrade', () => {
    const current = normalize()!
    const management = { value: 'management' as const, evidence: { source: 'board' as const, text: 'Management Level: People Manager' } }
    const manager: Job = {
      ...current, title: 'Lead Platform Engineer',
      occupation: { ...current.occupation!, version: 1, category: 'management', departments: ['Infrastructure'], management },
    }
    expect(upgradeJobOccupation(manager).occupation).toMatchObject({ version: 2, category: 'management', departments: ['Infrastructure'], management })
    const researcher: Job = {
      ...current, title: 'Applied Scientist', description: 'About Example\nWe make digital products.',
      occupation: {
        version: 1, category: 'research', departments: ['Science'],
        evidence: [{ source: 'description', text: 'Responsibilities\nDevelop language models.' }],
      },
    }
    const upgraded = upgradeJobOccupation(researcher)
    expect(upgraded.occupation).toMatchObject({ version: 2, category: 'research', departments: ['Science'] })
    expect(upgraded.occupation?.evidence).toContainEqual({ source: 'description', text: 'Responsibilities\nDevelop language models.' })
    expect(upgraded.description).toBe(researcher.description)
    expect(upgraded.fetchedAt).toBe(POSTING_TIME)
    expect(upgradeJobOccupation(upgraded)).toBe(upgraded)
  })
})

describe('complete public SmartRecruiters collection', () => {
  it('reads every page and published ID, fetching only possible technical bodies while retaining separate location ads', async () => {
    const postings = Array.from({ length: 102 }, (_, index) => smartRecruitersPosting({
      id: `posting-${index}`, name: index < 2 ? 'Backend Engineer' : index === 100 ? 'Applied Scientist' : 'Account Executive',
    }))
    const fetcher = vi.fn(async (input: string) => {
      const url = new URL(input)
      if (url.searchParams.has('offset')) {
        const offset = Number(url.searchParams.get('offset'))
        return Response.json(pageOf(postings.slice(offset, offset + 100).map(posting => ({ ...posting, ref: 'http://127.0.0.1/private', jobAd: undefined })), 102, offset))
      }
      return Response.json(postings.find(posting => input.endsWith(`/${posting.id}`)))
    })
    vi.stubGlobal('fetch', fetcher)
    const result = await fetchBoard()(company, POSTING_TIME)
    expect(result.total).toBe(102)
    expect(result.publishedIds).toEqual(postings.map(posting => `smartrecruiters-${company.id}-${posting.id}`))
    expect(result.jobs.map(job => job.title)).toEqual(['Backend Engineer', 'Backend Engineer', 'Applied Scientist'])
    expect(new Set(result.jobs.map(job => job.id)).size).toBe(3)
    expect(result.jobs[2].occupation?.category).toBe('research')
    const urls = fetcher.mock.calls.map(call => new URL(call[0]))
    expect(urls).toHaveLength(5)
    expect(urls.every(url => url.origin === 'https://api.smartrecruiters.com')).toBe(true)
    expect(urls.filter(url => url.search).map(url => [...url.searchParams])).toEqual([
      [['limit', '100'], ['offset', '0'], ['destination', 'PUBLIC']],
      [['limit', '100'], ['offset', '100'], ['destination', 'PUBLIC']],
    ])
  })

  it('treats a complete empty board as authoritative', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(pageOf([]))))
    expect(await fetchBoard()(company, POSTING_TIME)).toEqual({ total: 0, jobs: [], unmappedCount: 0, publishedIds: [] })
  })

  it.each([
    ['missing content', { offset: 0, limit: 100, totalFound: 1 }],
    ['wrong offset', pageOf([], 0, 100)],
    ['changed page size', { ...pageOf([]), limit: 50 }],
    ['truncated content', pageOf([smartRecruitersPosting()], 2)],
    ['duplicate IDs', pageOf([smartRecruitersPosting(), smartRecruitersPosting()])],
    ['wrong company', pageOf([smartRecruitersPosting({ company: { identifier: 'DifferentBoard' } })])],
    ['internal listing', pageOf([smartRecruitersPosting({ visibility: 'INTERNAL' })])],
    ['too many postings', pageOf([], 20001)],
  ])('rejects %s instead of publishing an incomplete board', async (_name, payload) => {
    const fetcher = vi.fn(async () => Response.json(payload))
    vi.stubGlobal('fetch', fetcher)
    await expect(fetchBoard()(company, POSTING_TIME)).rejects.toBeInstanceOf(BoardFetchError)
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('rejects a total change or overlapping ID on a later page before fetching any details', async () => {
    const first = Array.from({ length: 100 }, (_, index) => smartRecruitersPosting({ id: `posting-${index}` }))
    for (const last of [pageOf([], 100, 100), pageOf([first[0]], 101, 100)]) {
      const fetcher = vi.fn().mockResolvedValueOnce(Response.json(pageOf(first, 101))).mockResolvedValueOnce(Response.json(last))
      vi.stubGlobal('fetch', fetcher)
      await expect(fetchBoard()(company, POSTING_TIME)).rejects.toBeInstanceOf(BoardFetchError)
      expect(fetcher).toHaveBeenCalledTimes(2)
    }
  })

  it.each([
    { company: { identifier: 'OtherBoard' } },
    { id: 'other-id' }, { name: 'A renamed role' }, { releasedDate: '2026-09-19T07:00:00.000Z' },
    { uuid: 'different-uuid' }, { jobAdId: 'different-ad' }, { jobAd: undefined },
  ])('rejects a detail identity, version or visibility mismatch: %j', async override => {
    const raw = { ...smartRecruitersPosting(), uuid: 'listing-uuid', jobAdId: 'listing-ad' }
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json(pageOf([raw]))).mockResolvedValueOnce(Response.json({ ...raw, ...override }))
    vi.stubGlobal('fetch', fetcher)
    await expect(fetchBoard()(company, POSTING_TIME)).rejects.toBeInstanceOf(BoardFetchError)
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('removes explicitly inactive or internal details from verified public membership without losing the other jobs', async () => {
    const postings = [
      smartRecruitersPosting({ id: 'active' }), smartRecruitersPosting({ id: 'inactive' }),
      smartRecruitersPosting({ id: 'internal' }), smartRecruitersPosting({ id: 'non-technical', name: 'Account Executive' }),
    ]
    vi.stubGlobal('fetch', vi.fn(async (input: string) => {
      if (input.includes('?')) return Response.json(pageOf(postings))
      const raw = postings.find(posting => input.endsWith(`/${posting.id}`))!
      return Response.json({ ...raw, active: raw.id !== 'inactive', visibility: raw.id === 'internal' ? 'INTERNAL' : 'PUBLIC' })
    }))
    const result = await fetchBoard()(company, POSTING_TIME)
    expect(result).toMatchObject({ total: 2, jobs: [{ id: `smartrecruiters-${company.id}-active` }] })
    expect(result.jobs).toHaveLength(1)
    expect(result.publishedIds).toEqual([`smartrecruiters-${company.id}-active`, `smartrecruiters-${company.id}-non-technical`])
  })

  it('does not use an inactive response from a different company as evidence that a posting disappeared', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(Response.json(pageOf([smartRecruitersPosting()])))
      .mockResolvedValueOnce(Response.json(smartRecruitersPosting({ active: false, company: { identifier: 'DifferentBoard' } })))
    vi.stubGlobal('fetch', fetcher)
    await expect(fetchBoard()(company, POSTING_TIME)).rejects.toBeInstanceOf(BoardFetchError)
  })

  it('encodes native IDs and never follows an upstream ref or application link', async () => {
    const raw = smartRecruitersPosting({ id: 'id/with?reserved=characters' })
    const fetcher = vi.fn()
      .mockResolvedValueOnce(Response.json(pageOf([{ ...raw, ref: 'https://unrelated.example/private' }])))
      .mockResolvedValueOnce(Response.json(raw))
    vi.stubGlobal('fetch', fetcher)
    await fetchBoard()(company, POSTING_TIME)
    expect(fetcher.mock.calls[1][0]).toBe('https://api.smartrecruiters.com/v1/companies/ExampleBoard/postings/id%2Fwith%3Freserved%3Dcharacters')
    for (const [, options] of fetcher.mock.calls) {
      expect(options.method ?? 'GET').toBe('GET')
      expect(options.headers).not.toHaveProperty('Authorization')
    }
  })

  it('cancels active and queued details at the board deadline without publishing partial data', async () => {
    vi.useFakeTimers()
    const raw = [smartRecruitersPosting({ id: 'one' }), smartRecruitersPosting({ id: 'two' })]
    const fetcher = vi.fn()
      .mockResolvedValueOnce(Response.json(pageOf(raw)))
      .mockImplementation((_url, options: RequestInit) => new Promise((_resolve, reject) => {
        options.signal!.addEventListener('abort', () => reject(options.signal!.reason), { once: true })
      }))
    vi.stubGlobal('fetch', fetcher)
    const provider = createSmartRecruitersFetcher({ concurrency: 1, interval: 0, timeout: 1000 })
    const result = Promise.allSettled([provider(company, POSTING_TIME)])
    await vi.advanceTimersByTimeAsync(1000)
    expect(await result).toMatchObject([{ status: 'rejected', reason: { message: expect.stringContaining('시간이 초과') } }])
    await vi.advanceTimersByTimeAsync(5000)
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(fetcher.mock.calls.every(([, options]) => options.signal.aborted)).toBe(true)
  })

  it('keeps the last complete snapshot, original dates and public membership after a detail failure', async () => {
    const previous = normalize({ id: 'previous' })!
    let cached = parseCachedBoards({ version: 5, boards: [{
      companyId: company.id, provider: company.provider, board: company.board, checkedAt: POSTING_TIME, failures: 0, retryAt: null,
      snapshot: { fetchedAt: POSTING_TIME, jobs: [previous], total: 1, unmappedCount: 0, publishedIds: [previous.id] },
    }] })
    const now = Date.parse(POSTING_TIME) + CATALOG_POLICY.freshFor
    vi.spyOn(Date, 'now').mockReturnValue(now)
    const fetcher = vi.fn()
      .mockResolvedValueOnce(Response.json(pageOf([smartRecruitersPosting({ id: 'new-one' })])))
      .mockResolvedValueOnce(new Response('', { status: 429, headers: { 'Retry-After': '600' } }))
    vi.stubGlobal('fetch', fetcher)
    const service = createCatalogService({
      companies: [company], fetchBoard: fetchBoard(), now: () => now, random: () => 0,
      cache: { load: async () => cached, save: async boards => { cached = boards } },
    })
    const result = await service.get()
    expect(result.jobs).toEqual([{ ...previous, stale: true }])
    expect(result.boards[0]).toMatchObject({
      provider: 'smartrecruiters', status: 'error', lastSuccessAt: POSTING_TIME,
      retryAt: new Date(now + 600_000).toISOString(),
    })
    expect((await service.getPostingStatus(true)).boards[0]).toMatchObject({ status: 'error', listing: { publishedIds: [previous.id] } })
    await service.get(true)
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(cached[0].snapshot?.jobs).toEqual([previous])
  })
})
