import { describe, expect, it } from 'vitest'
import { isUnmappedJob, unmappedCoverage } from '../../shared/job-location'
import { countSearchJobs, createSearchIndex, selectSearchJobs } from '../../shared/job-search'
import { filterJobs, groupCities, groupCompanies } from '../../shared/matching'
import { analyzeSearchRecovery } from '../../shared/search-recovery'
import { SEARCH_COMPANIES, SEARCH_FILTERS, SEARCH_PROFILE, searchCatalog, searchJob } from '../fixtures/search-catalog'

describe('unmapped job discovery', () => {
  it('keeps map, remote and other locations disjoint while counting a company only once overall', () => {
    const catalog = searchCatalog([
      searchJob('city'),
      searchJob('remote', { workMode: 'remote', cityIds: [], remoteWorldwide: true }),
      searchJob('gurugram', { cityIds: [], locationLabel: 'Gurugram' }),
      searchJob('country', { cityIds: [], locationLabel: 'Ireland', workMode: 'unknown' }),
      searchJob('placeholder', { companyId: SEARCH_COMPANIES[1].id, cityIds: [], locationLabel: 'N/A', workMode: 'hybrid' }),
    ])
    const index = createSearchIndex(catalog, SEARCH_PROFILE)
    const entries = selectSearchJobs(index, SEARCH_FILTERS)
    expect(entries).toHaveLength(5)
    expect(countSearchJobs(entries, { kind: 'cities' }, 'all')).toEqual({ jobs: 1, companies: 1, cities: 1 })
    expect(countSearchJobs(entries, { kind: 'remote' }, 'all')).toEqual({ jobs: 1, companies: 1, cities: 0 })
    expect(countSearchJobs(entries, { kind: 'unmapped' }, 'all')).toEqual({ jobs: 3, companies: 2, cities: 0 })
    const matches = filterJobs(catalog, SEARCH_PROFILE, SEARCH_FILTERS)
    expect(groupCompanies(matches)).toHaveLength(2)
    expect(groupCities(catalog, matches, SEARCH_FILTERS)[0].matches.map(match => match.job.id)).toEqual([catalog.jobs[0].id])
    expect(catalog.jobs.filter(isUnmappedJob).map(job => job.locationLabel)).toEqual(['Gurugram', 'Ireland', 'N/A'])
  })

  it('searches the original location without guessing a mapped city, region or remote eligibility', () => {
    const jobs = [
      searchJob('gurugram', { cityIds: [], locationLabel: 'Gurugram', workMode: 'unknown' }),
      searchJob('namesake', { cityIds: [], locationLabel: 'London, Ontario', workMode: 'hybrid' }),
      searchJob('country', { cityIds: [], locationLabel: 'Ireland' }),
    ]
    const catalog = searchCatalog(jobs)
    const index = createSearchIndex(catalog, SEARCH_PROFILE)
    expect(filterJobs(catalog, SEARCH_PROFILE, { ...SEARCH_FILTERS, query: 'gurugram' }).map(match => match.job.id)).toEqual([jobs[0].id])
    for (const region of ['europe', 'americas', 'asia-pacific'] as const) {
      expect(selectSearchJobs(index, { ...SEARCH_FILTERS, region })).toEqual([])
      expect(countSearchJobs(index.entries, { kind: 'unmapped' }, region).jobs).toBe(0)
    }
    expect(selectSearchJobs(index, { ...SEARCH_FILTERS, workMode: 'remote', remoteEligibleOnly: false })).toEqual([])
    expect(selectSearchJobs(index, { ...SEARCH_FILTERS, workMode: 'unknown' }).map(entry => entry.job.id)).toEqual([jobs[0].id])
  })

  it('offers matching unmapped jobs from an empty map without changing the search conditions', () => {
    const catalog = searchCatalog([searchJob('gurugram', { cityIds: [], locationLabel: 'Gurugram' })])
    const filters = { ...SEARCH_FILTERS, query: 'Gurugram' }
    const index = createSearchIndex(catalog, SEARCH_PROFILE)
    const analysis = analyzeSearchRecovery(index, filters, { kind: 'cities' })!
    expect(analysis.suggestions).toEqual([])
    expect(analysis.alternatives).toEqual([{ scope: { kind: 'unmapped' }, count: { jobs: 1, companies: 1, cities: 0 } }])
    expect(analyzeSearchRecovery(index, filters, { kind: 'unmapped' })).toBeNull()
    expect(filters).toEqual({ ...SEARCH_FILTERS, query: 'Gurugram' })
  })

  it('previews the necessary region change in other locations while preserving every other condition', () => {
    const catalog = searchCatalog([
      searchJob('first', { cityIds: [], locationLabel: 'Gurugram' }),
      searchJob('second', { cityIds: [], locationLabel: 'Gurugram' }),
      searchJob('unrelated', { cityIds: [], locationLabel: 'Montréal' }),
    ])
    const filters = { ...SEARCH_FILTERS, region: 'europe' as const, query: 'Gurugram' }
    const index = createSearchIndex(catalog, SEARCH_PROFILE)
    const analysis = analyzeSearchRecovery(index, filters, { kind: 'unmapped' })!
    expect(analysis.available).toBe(3)
    expect(analysis.alternatives).toEqual([])
    expect(analysis.suggestions).toHaveLength(1)
    expect(analysis.suggestions[0]).toMatchObject({ changes: { region: 'all' }, count: { companies: 1, jobs: 2, cities: 0 } })
    const restored = { ...filters, ...analysis.suggestions[0].changes }
    expect(filterJobs(catalog, SEARCH_PROFILE, restored)).toHaveLength(2)
    expect(restored).toEqual({ ...SEARCH_FILTERS, query: 'Gurugram' })
  })

  it('continues to enforce visa, salary and profile conditions for unmapped postings', () => {
    const catalog = searchCatalog([searchJob('restricted', {
      cityIds: [], locationLabel: 'United Kingdom', visa: 'no', salary: null, skills: ['Rust'],
    })])
    const index = createSearchIndex(catalog, SEARCH_PROFILE)
    expect(selectSearchJobs(index, SEARCH_FILTERS)).toEqual([])
    const analysis = analyzeSearchRecovery(index, SEARCH_FILTERS, { kind: 'unmapped' })!
    expect(analysis.suggestions[0]).toMatchObject({
      changes: { visa: 'all', includeUnknownSalary: true }, count: { jobs: 1, companies: 1, cities: 0 },
    })
    const allRoles = { ...SEARCH_FILTERS, role: 'all' as const, visa: 'all' as const, includeUnknownSalary: true }
    expect(selectSearchJobs(index, allRoles)).toEqual([])
    expect(analyzeSearchRecovery(index, allRoles, { kind: 'unmapped' })).toMatchObject({ profileExcluded: 1, suggestions: [] })
  })

  it('does not turn counts from older snapshots into browsable records', () => {
    const legacy = { ...searchCatalog([searchJob('mapped')]), unmappedCount: 3 }
    expect(unmappedCoverage(legacy)).toEqual({ available: 0, unavailable: 3 })
    expect(unmappedCoverage({ ...legacy, unmappedCount: null })).toEqual({ available: 0, unavailable: null })
    const refreshed = searchCatalog([searchJob('mapped'), searchJob('outside', { cityIds: [] })])
    expect(unmappedCoverage(refreshed)).toEqual({ available: 1, unavailable: 0 })
  })
})
