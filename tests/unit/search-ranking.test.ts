import { describe, expect, it } from 'vitest'
import { createSearchIndex } from '../../shared/job-search'
import { createSearchRanker, filterJobs } from '../../shared/matching'
import { DEFAULT_FILTERS } from '../../shared/types'
import type { Filters } from '../../shared/types'
import { searchCatalog, searchJob, SEARCH_COMPANIES, SEARCH_PROFILE } from '../fixtures/search-catalog'

const senior = searchJob('senior', { title: 'Senior Backend Engineer', minExperience: 7 })
const mid = searchJob('mid', { companyId: SEARCH_COMPANIES[1].id })
const frontend = searchJob('frontend', { title: 'Frontend Engineer', role: 'frontend', skills: ['Rust'] })
const remoteGb = searchJob('remote-gb', {
  workMode: 'remote', cityIds: [], locationLabel: 'Remote, UK', remoteCountries: ['GB'],
  salary: null, visa: 'unknown',
})
const remoteUs = searchJob('remote-us', {
  workMode: 'remote', cityIds: [], locationLabel: 'Remote, US', remoteCountries: ['US'], visa: 'no',
})
const catalog = searchCatalog([senior, mid, frontend, remoteGb, remoteUs])

describe('ranking across search and filter changes', () => {
  it('keeps the same complete recommendations when narrowing, widening and changing hard conditions', () => {
    const rank = createSearchRanker(createSearchIndex(catalog, SEARCH_PROFILE), SEARCH_PROFILE)
    const changes: Partial<Filters>[] = [
      { query: 'no-such-job' }, { query: 'senior' }, {}, { query: 'engineer' }, { query: 'no-such-job' },
      { role: 'frontend' }, { salaryMin: 190000 }, { includeUnknownSalary: false },
      { visa: 'yes' }, { visa: 'possible' }, { workMode: 'remote' },
      { workMode: 'remote', remoteEligibleOnly: false }, { region: 'asia-pacific' }, {},
    ]
    for (const change of changes) {
      const filters = { ...DEFAULT_FILTERS, ...change }
      expect(rank(filters)).toEqual(filterJobs(catalog, SEARCH_PROFILE, filters))
    }
    expect(rank(DEFAULT_FILTERS).map(match => match.job.id)).not.toContain(frontend.id)
    expect(rank({ ...DEFAULT_FILTERS, role: 'frontend' }).map(match => match.job.id)).toEqual([frontend.id])
  })

  it('reuses recommendations within a snapshot without sharing mutable result ordering', () => {
    const index = createSearchIndex(catalog, SEARCH_PROFILE)
    const originalOrder = [...index.entries]
    const rank = createSearchRanker(index, SEARCH_PROFILE)
    const first = rank({ ...DEFAULT_FILTERS, query: 'senior' })
    const expanded = rank(DEFAULT_FILTERS)
    expect(expanded.find(match => match.job.id === senior.id)).toBe(first[0])
    expect(expanded).not.toBe(first)
    expanded.reverse()
    const repeated = rank(DEFAULT_FILTERS)
    expect(repeated).not.toBe(expanded)
    expect(repeated).toEqual(filterJobs(catalog, SEARCH_PROFILE, DEFAULT_FILTERS))
    expect(repeated.find(match => match.job.id === senior.id)).toBe(first[0])
    expect(index.entries).toEqual(originalOrder)
  })

  it('keeps the original order of locale-equivalent ties when an earlier entry is discovered later', () => {
    const earlier = searchJob('earlier', { id: 'greenhouse-tie-é' })
    const later = searchJob('later', { id: 'greenhouse-tie-e\u0301', companyId: SEARCH_COMPANIES[1].id })
    const tied = {
      ...searchCatalog([earlier, later]),
      companies: SEARCH_COMPANIES.map((company, position) => ({ ...company, name: position === 0 ? 'Café' : 'Cafe\u0301' })),
    }
    expect(earlier.id.localeCompare(later.id)).toBe(0)
    expect(tied.companies[0].name.localeCompare(tied.companies[1].name)).toBe(0)
    const rank = createSearchRanker(createSearchIndex(tied, SEARCH_PROFILE), SEARCH_PROFILE)
    expect(rank({ ...DEFAULT_FILTERS, query: 'later' }).map(match => match.job.id)).toEqual([later.id])
    const all = rank(DEFAULT_FILTERS)
    expect(all[0].score).toBe(all[1].score)
    expect(all.map(match => match.job.id)).toEqual([earlier.id, later.id])
    for (const query of ['earlier', 'no-such-job', 'later', '']) {
      const filters = { ...DEFAULT_FILTERS, query }
      expect(rank(filters)).toEqual(filterJobs(tied, SEARCH_PROFILE, filters))
    }
  })

  it('recalculates scores, explanations and eligibility for a new profile snapshot', () => {
    const rank = createSearchRanker(createSearchIndex(catalog, SEARCH_PROFILE), SEARCH_PROFILE)
    const original = rank(DEFAULT_FILTERS)
    const profiles = [
      { ...SEARCH_PROFILE, years: 9 },
      { ...SEARCH_PROFILE, skills: ['Rust'], desiredRole: 'frontend' as const },
      { ...SEARCH_PROFILE, residence: 'US' },
    ]
    for (const profile of profiles) {
      const updatedRank = createSearchRanker(createSearchIndex(catalog, profile), profile)
      const updated = updatedRank(DEFAULT_FILTERS)
      expect(updated).toEqual(filterJobs(catalog, profile, DEFAULT_FILTERS))
      expect(updated).not.toEqual(original)
      for (const match of updated) {
        expect(match).not.toBe(original.find(previous => previous.job.id === match.job.id))
      }
    }
    expect(rank(DEFAULT_FILTERS)).toEqual(original)
  })

  it('uses new job and company data even when a refreshed catalog keeps the same IDs', () => {
    const rank = createSearchRanker(createSearchIndex(catalog, SEARCH_PROFILE), SEARCH_PROFILE)
    const original = rank(DEFAULT_FILTERS)
    const updatedJob = searchJob('senior', { title: 'Revised Backend Engineer', minExperience: 12, salary: null })
    const refreshed = {
      ...catalog,
      jobs: catalog.jobs.map(job => job.id === senior.id ? updatedJob : job),
      companies: catalog.companies.map(company => company.id === senior.companyId ? { ...company, name: 'Updated Company' } : company),
    }
    const updatedRank = createSearchRanker(createSearchIndex(refreshed, SEARCH_PROFILE), SEARCH_PROFILE)
    const updated = updatedRank(DEFAULT_FILTERS)
    expect(updated).toEqual(filterJobs(refreshed, SEARCH_PROFILE, DEFAULT_FILTERS))
    const previous = original.find(match => match.job.id === senior.id)!
    const current = updated.find(match => match.job.id === senior.id)!
    expect(current.job.title).toBe(updatedJob.title)
    expect(current.company.name).toBe('Updated Company')
    expect(current.score).toBeLessThan(previous.score)
    expect(current.cautions).not.toEqual(previous.cautions)
    expect(updatedRank({ ...DEFAULT_FILTERS, query: 'revised' })).toEqual([current])
    expect(updatedRank({ ...DEFAULT_FILTERS, includeUnknownSalary: false })).not.toContain(current)
    expect(rank(DEFAULT_FILTERS)).toEqual(original)
  })
})
