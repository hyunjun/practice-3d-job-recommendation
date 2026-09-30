import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseCachedBoards } from '../../server/board-cache'
import { normalizeCareerPosting } from '../../server/providers/careers-common'
import { createCareersFetcher } from '../../server/providers/careers'
import { isTechnicalJob, needsOccupationDescription, occupationFacts, upgradeJobOccupation } from '../../shared/job-occupation'
import { createSearchIndex, selectSearchJobs } from '../../shared/job-search'
import { observeSavedPosting } from '../../shared/posting-status'
import { createSavedBackup, parseSavedImport } from '../../shared/saved-backup'
import { decodeSavedJobs } from '../../shared/saved-jobs'
import { JobSchema } from '../../shared/schemas'
import { DEFAULT_FILTERS } from '../../shared/types'
import { CAREERS_NOW, careersCompany } from '../fixtures/careers-contract'
import { mockCareersFetch } from '../fixtures/careers-fetch-mock'
import { flightObjectHtml, zalandoDetail, zalandoDetailHtml, zalandoSummary } from '../fixtures/careers-wire'
import { INDUSTRY_CASES, INDUSTRY_PUBLISHED_IDS, SOFTWARE_DESIGN_BODY, TEXTILE_DESIGN_BODY, industryV5Jobs, industryV5Saved } from '../fixtures/industry-occupation'
import { coverageReply } from '../fixtures/public-coverage-transport'
import { SEARCH_PROFILE, searchCatalog } from '../fixtures/search-catalog'

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('v7 position scope across retailers and manufacturers', () => {
  it.each(INDUSTRY_CASES)('$title / $category keeps the literal position boundary', fixture => {
    const assessment = occupationFacts(fixture)
    expect(assessment).toMatchObject({ version: 7, category: fixture.category })
    const job = normalizeCareerPosting({
      id: '642000', title: fixture.title, description: fixture.description, departments: fixture.departments,
      url: 'https://jobs.zalando.com/en/jobs/642000', locations: [{ label: 'Berlin, Germany' }],
    }, 'zalando', CAREERS_NOW)
    if (fixture.included) {
      expect(job).toMatchObject({ id: 'careers-zalando-642000', title: fixture.title, occupation: { version: 7, category: fixture.category } })
      expect(isTechnicalJob(job!)).toBe(true)
    } else expect(job).toBeNull()
  })

  it('keeps ambiguous Design Engineer eligible for a detail read without accepting missing duties', () => {
    expect(needsOccupationDescription('Design Engineer')).toBe(true)
    expect(occupationFacts({ title: 'Design Engineer', description: '' }).category).toBe('unconfirmed')
    expect(occupationFacts({ title: 'Design Engineer', description: TEXTILE_DESIGN_BODY }).category).toBe('other')
    expect(occupationFacts({ title: 'Design Engineer', description: SOFTWARE_DESIGN_BODY }).category).toBe('engineering')
  })

  it('reads all three generic Design Engineer details and retains only the software position', async () => {
    const listing = {
      data: ['642001', '642002', '642004'].map(id => zalandoSummary(id, 'Design Engineer', { job_categories: ['Product Development'] })),
      total: 3, next: null,
    }
    const transport = mockCareersFetch({
      'https://jobs.zalando.com/en/jobs?page=1': coverageReply(flightObjectHtml(listing), { format: 'text' }),
      'https://jobs.zalando.com/en/jobs/642001': coverageReply(zalandoDetailHtml(zalandoDetail('642001', 'Design Engineer', { Department: 'Product Development', Job_Category: 'Product Development' }), TEXTILE_DESIGN_BODY), { format: 'text' }),
      'https://jobs.zalando.com/en/jobs/642002': coverageReply(zalandoDetailHtml(zalandoDetail('642002', 'Design Engineer', { Department: 'Digital Products' }), SOFTWARE_DESIGN_BODY), { format: 'text' }),
      'https://jobs.zalando.com/en/jobs/642004': coverageReply(zalandoDetailHtml(zalandoDetail('642004', 'Design Engineer', { Department: 'Product Development', Job_Category: 'Product Development' }), 'Synthetic posting without job duties.'), { format: 'text' }),
    })
    const fetcher = createCareersFetcher({ concurrency: 1, interval: 0, bookingInterval: 0, timeout: 30_000 })
    const result = await fetcher.fetchBoard(careersCompany('zalando'), CAREERS_NOW)
    expect(transport.urls()).toEqual([
      'https://jobs.zalando.com/en/jobs?page=1', 'https://jobs.zalando.com/en/jobs/642001',
      'https://jobs.zalando.com/en/jobs/642002', 'https://jobs.zalando.com/en/jobs/642004',
    ])
    expect(result).toMatchObject({ total: 3, unmappedCount: 0, publishedIds: [
      'careers-zalando-642001', 'careers-zalando-642002', 'careers-zalando-642004',
    ] })
    expect(result.jobs.map(job => [job.id, job.title, job.occupation?.category])).toEqual([
      ['careers-zalando-642002', 'Design Engineer', 'engineering'],
    ])
    expect(result.jobs[0].description).toBe(SOFTWARE_DESIGN_BODY)
  })
})

describe('v5 source snapshots survive v7 reclassification', () => {
  it('updates search and cached inclusion while preserving source clocks, IDs, totals and input bytes', () => {
    const jobs = industryV5Jobs()
    const input = { version: 5, boards: [{
      companyId: 'zalando', provider: 'careers', board: 'zalando',
      checkedAt: '2026-10-02T10:01:00.000Z', retryAt: '2026-10-02T10:02:00.000Z',
      failures: 1, error: 'Synthetic HTTP 503',
      snapshot: { fetchedAt: CAREERS_NOW, total: 4, unmappedCount: 0, jobs, publishedIds: INDUSTRY_PUBLISHED_IDS },
    }] }
    const bytes = JSON.stringify(input)
    for (const job of jobs) expect(JobSchema.safeParse(job).success).toBe(true)
    const loaded = parseCachedBoards(input)
    expect(loaded).toHaveLength(1)
    expect(loaded[0]).toMatchObject({
      checkedAt: '2026-10-02T10:01:00.000Z', retryAt: '2026-10-02T10:02:00.000Z',
      failures: 1, error: 'Synthetic HTTP 503',
      snapshot: { fetchedAt: '2026-10-02T10:00:00.000Z', total: 4, unmappedCount: 0, publishedIds: INDUSTRY_PUBLISHED_IDS },
    })
    expect(loaded[0].snapshot?.jobs.map(job => job.id)).toEqual(['careers-zalando-642002'])
    expect(loaded[0].snapshot?.jobs[0]).toMatchObject({
      title: 'Design Engineer', description: SOFTWARE_DESIGN_BODY,
      fetchedAt: '2026-10-02T10:00:00.000Z', updatedAt: '2026-10-01T12:00:00.000Z',
      occupation: { version: 7, category: 'engineering' },
    })
    expect(parseCachedBoards({ version: 5, boards: loaded })).toEqual(loaded)
    const catalog = { ...searchCatalog(jobs), companies: [careersCompany('zalando')] }
    const index = createSearchIndex(catalog, { ...SEARCH_PROFILE, desiredRole: 'all', skills: [] })
    expect(selectSearchJobs(index, DEFAULT_FILTERS).map(entry => entry.job.id)).toEqual(['careers-zalando-642002'])
    expect(selectSearchJobs(index, { ...DEFAULT_FILTERS, query: 'Design Engineer' }).map(entry => entry.job.id)).toEqual(['careers-zalando-642002'])
    expect(selectSearchJobs(index, { ...DEFAULT_FILTERS, query: 'textile' })).toEqual([])
    expect(selectSearchJobs(index, { ...DEFAULT_FILTERS, query: 'Business Developer' })).toEqual([])
    expect(JSON.stringify(input)).toBe(bytes)
  })

  it('keeps a saved physical role and its original content through restart/export/import, still listed after reclassification', () => {
    const original = industryV5Saved()
    const bytes = JSON.stringify(original)
    const migrated = upgradeJobOccupation(original.job)
    expect(migrated.occupation).toMatchObject({ version: 7, category: 'other' })
    expect({ ...migrated, occupation: original.job.occupation }).toEqual(original.job)
    const decoded = decodeSavedJobs(JSON.stringify([original]))
    expect(decoded.omitted).toBe(0)
    expect(decoded.records).toHaveLength(1)
    const saved = decoded.records[0]
    expect(saved).toMatchObject({
      savedAt: '2026-10-02T10:05:00.000Z', status: 'applied',
      note: 'Synthetic textile application note64; keep my original source.',
      job: {
        id: 'careers-zalando-642001', source: 'careers', title: 'Design Engineer', description: TEXTILE_DESIGN_BODY,
        url: 'https://jobs.zalando.com/en/jobs/642001',
        fetchedAt: '2026-10-02T10:00:00.000Z', updatedAt: '2026-10-01T12:00:00.000Z',
        occupation: { version: 7, category: 'other' },
      },
    })
    expect(parseSavedImport(createSavedBackup([saved])).groups[0].variants[0]).toEqual(saved)
    const observation = observeSavedPosting(saved, {
      version: 1, checkedAt: '2026-10-02T10:10:00.000Z', refreshAfter: '2026-10-03T10:10:00.000Z',
      boards: [{
        companyId: 'zalando', provider: 'careers', board: 'zalando',
        status: 'ok', checkedAt: '2026-10-02T10:10:00.000Z', lastSuccessAt: '2026-10-02T10:10:00.000Z', retryAt: null,
        listing: { validUntil: '2026-10-03T10:10:00.000Z', publishedIds: INDUSTRY_PUBLISHED_IDS, jobs: [] },
      }],
    }, undefined, Date.parse('2026-10-02T10:11:00.000Z'))
    expect(observation).toEqual({
      state: 'listed', checkedAt: '2026-10-02T10:10:00.000Z',
      message: '게시판에는 있지만 현재 탐색 범위 밖의 공고라 내용은 원문에서 확인해야 합니다.',
    })
    expect(JSON.stringify(original)).toBe(bytes)
    expect(original.job.occupation?.version).toBe(5)
  })
})
