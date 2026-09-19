import { describe, expect, it } from 'vitest'
import { countSearchJobs, createSearchIndex, selectSearchJobs } from '../../shared/job-search'
import { filterJobs } from '../../shared/matching'
import { analyzeSearchRecovery, describeRecoveryChanges, undoRecoveryChanges } from '../../shared/search-recovery'
import { DEFAULT_FILTERS } from '../../shared/types'
import { SEARCH_COMPANIES, SEARCH_FILTERS, SEARCH_PROFILE, searchCatalog, searchJob } from '../fixtures/search-catalog'

describe('search recovery uses actual results in the visible scope', () => {
  it('does not propose changes when that scope already contains results', () => {
    const index = createSearchIndex(searchCatalog([searchJob('existing')]), SEARCH_PROFILE)
    expect(analyzeSearchRecovery(index, SEARCH_FILTERS, { kind: 'cities' })).toBeNull()
    expect(analyzeSearchRecovery(index, SEARCH_FILTERS, { kind: 'city', cityId: 'london' })).toBeNull()
  })

  it('clears only an unsuccessful query and deduplicates companies and mapped cities', () => {
    const catalog = searchCatalog([
      searchJob('one', { cityIds: ['london', 'berlin', 'london'] }),
      searchJob('two'),
      searchJob('three', { companyId: SEARCH_COMPANIES[1].id, cityIds: ['berlin'] }),
      searchJob('remote', { workMode: 'remote', cityIds: [], remoteWorldwide: true }),
    ])
    const index = createSearchIndex(catalog, SEARCH_PROFILE)
    const filters = { ...SEARCH_FILTERS, query: 'does-not-exist' }
    const suggestion = analyzeSearchRecovery(index, filters, { kind: 'cities' })!.suggestions[0]
    expect(suggestion.changes).toEqual({ query: '' })
    expect(suggestion.count).toEqual({ companies: 2, jobs: 3, cities: 2 })
    expect({ ...filters, ...suggestion.changes }).toEqual(SEARCH_FILTERS)
    expect(countSearchJobs(selectSearchJobs(index, { ...filters, ...suggestion.changes }), { kind: 'city', cityId: 'london' }, 'all')).toEqual({ companies: 1, jobs: 2, cities: 1 })
  })

  it('finds a necessary three-condition change and discloses every changed field', () => {
    const catalog = searchCatalog([searchJob('limited', { visa: 'conditional', salary: { min: 100000, max: 120000, currency: 'USD' } })])
    const index = createSearchIndex(catalog, SEARCH_PROFILE)
    const filters = { ...SEARCH_FILTERS, query: 'not-in-this-posting' }
    const before = JSON.stringify({ catalog, profile: SEARCH_PROFILE, filters })
    const result = analyzeSearchRecovery(index, filters, { kind: 'city', cityId: 'london' })!
    expect(result.suggestions).toHaveLength(1)
    const suggestion = result.suggestions[0]
    expect(suggestion.changes).toEqual({ query: '', salaryMin: 0, visa: 'supported' })
    expect(suggestion.count).toEqual({ companies: 1, jobs: 1, cities: 1 })
    expect(describeRecoveryChanges(filters, suggestion.changes).map(change => change.key)).toEqual(['query', 'salaryMin', 'visa'])
    for (const key of ['query', 'salaryMin', 'visa'] as const) {
      const incomplete = { ...suggestion.changes }
      delete incomplete[key]
      expect(filterJobs(catalog, SEARCH_PROFILE, { ...filters, ...incomplete })).toEqual([])
    }
    expect(JSON.stringify({ catalog, profile: SEARCH_PROFILE, filters })).toBe(before)
  })

  it('prefers the smallest visa expansion and suppresses unnecessary larger changes', () => {
    const jobs = [
      searchJob('conditional', { visa: 'conditional' }),
      searchJob('unknown', { visa: 'unknown' }),
      searchJob('no', { visa: 'no' }),
      searchJob('low-conditional', { visa: 'conditional', salary: { min: 80000, max: 100000, currency: 'USD' } }),
    ]
    const analysis = analyzeSearchRecovery(createSearchIndex(searchCatalog(jobs), SEARCH_PROFILE), SEARCH_FILTERS, { kind: 'cities' })!
    expect(analysis.suggestions).toHaveLength(1)
    expect(analysis.suggestions[0].changes).toEqual({ visa: 'supported' })
    expect(analysis.suggestions[0].count.jobs).toBe(1)
  })

  it.each([
    ['unknown', 'possible', '미확인 공고도 포함'],
    ['no', 'all', '지원 없음까지 포함'],
  ] as const)('does not label a %s visa as confirmed support', (visa, expected, description) => {
    const analysis = analyzeSearchRecovery(createSearchIndex(searchCatalog([searchJob(visa, { visa })]), SEARCH_PROFILE), SEARCH_FILTERS, { kind: 'cities' })!
    expect(analysis.suggestions[0].changes).toEqual({ visa: expected })
    expect(describeRecoveryChanges(SEARCH_FILTERS, analysis.suggestions[0].changes)[0].after).toBe(description)
  })

  it('offers the other tab without changing filters when all matching jobs are remote', () => {
    const index = createSearchIndex(searchCatalog([searchJob('remote', { workMode: 'remote', cityIds: [], remoteWorldwide: true })]), SEARCH_PROFILE)
    const analysis = analyzeSearchRecovery(index, SEARCH_FILTERS, { kind: 'cities' })!
    expect(analysis.available).toBe(0)
    expect(analysis.suggestions).toEqual([])
    expect(analysis.alternatives).toEqual([{ scope: { kind: 'remote' }, count: { companies: 1, jobs: 1, cities: 0 } }])
  })

  it('counts a selected city separately from other locations on the same posting', () => {
    const index = createSearchIndex(searchCatalog([searchJob('two-cities', { cityIds: ['london', 'san-francisco'] })]), SEARCH_PROFILE)
    const filters = { ...SEARCH_FILTERS, region: 'americas' as const }
    const analysis = analyzeSearchRecovery(index, filters, { kind: 'city', cityId: 'london' })!
    expect(analysis.suggestions[0].changes).toEqual({ region: 'all' })
    expect(analysis.suggestions[0].count).toEqual({ companies: 1, jobs: 1, cities: 1 })
    expect(analysis.alternatives).toEqual([{ scope: { kind: 'cities' }, count: { companies: 1, jobs: 1, cities: 1 } }])
  })

  it('never widens a region into countries or treats a residence change as a suggested fix', () => {
    const index = createSearchIndex(searchCatalog([
      searchJob('us-only', { workMode: 'remote', cityIds: [], remoteCountries: ['US'] }),
      searchJob('region-only', { workMode: 'remote', cityIds: [], remoteRegions: ['europe'], remoteScopeUnknown: true }),
    ]), SEARCH_PROFILE)
    const analysis = analyzeSearchRecovery(index, SEARCH_FILTERS, { kind: 'remote' })!
    expect(analysis.suggestions[0].changes).toEqual({ remoteEligibleOnly: false })
    expect(analysis.suggestions[0].count).toEqual({ companies: 1, jobs: 2, cities: 0 })
    expect(describeRecoveryChanges(SEARCH_FILTERS, analysis.suggestions[0].changes)[0].after).toBe('범위 밖·미확인도 포함')
    expect(SEARCH_PROFILE.residence).toBe('GB')
  })

  it('keeps unknown compensation distinct from lowering a known annual salary threshold', () => {
    const index = createSearchIndex(searchCatalog([
      searchJob('unknown-pay', { salary: null, compensationNote: 'Monthly amount: period needs confirmation' }),
      searchJob('known-pay', { salary: { min: 80000, max: 100000, currency: 'USD' } }),
    ]), SEARCH_PROFILE)
    const suggestions = analyzeSearchRecovery(index, SEARCH_FILTERS, { kind: 'cities' })!.suggestions
    expect(suggestions.map(suggestion => suggestion.changes)).toEqual([{ includeUnknownSalary: true }, { salaryMin: 0 }])
    expect(suggestions.map(suggestion => suggestion.count.jobs)).toEqual([1, 1])
  })

  it('explains a profile mismatch instead of claiming a filter change can recover those jobs', () => {
    const index = createSearchIndex(searchCatalog([searchJob('rust', { skills: ['Rust'] })]), SEARCH_PROFILE)
    const filters = { ...SEARCH_FILTERS, role: 'all' as const }
    const analysis = analyzeSearchRecovery(index, filters, { kind: 'cities' })!
    expect(analysis.profileExcluded).toBe(1)
    expect(analysis.suggestions).toEqual([])
    expect(analysis.available).toBe(1)
  })

  it('accounts for the profile gate becoming active when a role filter is removed', () => {
    const index = createSearchIndex(searchCatalog([searchJob('frontend-rust', { role: 'frontend', skills: ['Rust'] })]), SEARCH_PROFILE)
    expect(analyzeSearchRecovery(index, SEARCH_FILTERS, { kind: 'cities' })!.suggestions).toEqual([])
    const sameRole = createSearchIndex(searchCatalog([searchJob('backend-rust', { skills: ['Rust'], salary: null })]), SEARCH_PROFILE)
    expect(analyzeSearchRecovery(sameRole, SEARCH_FILTERS, { kind: 'cities' })!.suggestions[0].changes).toEqual({ includeUnknownSalary: true })
  })

  it('does not invent jobs when the catalog, company or selected mapped city is missing', () => {
    const orphan = searchCatalog([searchJob('orphan', { companyId: 'absent' })])
    for (const catalog of [searchCatalog([]), orphan]) {
      const analysis = analyzeSearchRecovery(createSearchIndex(catalog, SEARCH_PROFILE), SEARCH_FILTERS, { kind: 'cities' })!
      expect(analysis).toEqual({ available: 0, profileExcluded: 0, suggestions: [], alternatives: [] })
    }
    const index = createSearchIndex(searchCatalog([searchJob('unmapped', { cityIds: ['unmapped-city'] })]), SEARCH_PROFILE)
    expect(analyzeSearchRecovery(index, DEFAULT_FILTERS, { kind: 'cities' })!.suggestions).toEqual([])
  })

  it('restores changed fields on undo while preserving subsequent edits', () => {
    const previous = { ...SEARCH_FILTERS, query: 'before' }
    const changes = { query: '', visa: 'supported' as const }
    expect(undoRecoveryChanges({ ...previous, ...changes }, previous, changes)).toEqual(previous)
    const edited = { ...previous, ...changes, query: 'new search', employment: 'contract' as const }
    expect(undoRecoveryChanges(edited, previous, changes)).toEqual({ ...previous, query: 'new search', employment: 'contract' })
  })
})
