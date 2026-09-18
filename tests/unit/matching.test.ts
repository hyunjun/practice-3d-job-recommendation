import { describe, expect, it } from 'vitest'
import { CITIES } from '../../shared/cities'
import { COMPANIES } from '../../shared/companies'
import { filterJobs, groupCities, groupCompanies, isRemoteEligible, matchJob, medianSalary, safeExternalUrl, toUsd } from '../../shared/matching'
import { createSampleCatalog } from '../../shared/sample'
import { DEFAULT_FILTERS, SAMPLE_PROFILE } from '../../shared/types'
import type { Catalog, Job } from '../../shared/types'

const demo = createSampleCatalog()
const job = (overrides: Partial<Job>): Job => ({ ...demo.jobs[0], id: 'test-job', skills: ['Python', 'AWS'], minExperience: 3, visa: 'unknown', ...overrides })
const catalog = (jobs: Job[]): Catalog => ({ ...demo, jobs, companies: COMPANIES, cities: CITIES })

describe('company counts and actual workplaces', () => {
  it('deduplicates a company within a city and globally, while including each hiring city', () => {
    const data = catalog([
      job({ id: 'one', companyId: 'stripe', cityIds: ['london', 'berlin'] }),
      job({ id: 'two', companyId: 'stripe', cityIds: ['london'] }),
      job({ id: 'three', companyId: 'figma', cityIds: ['london'] }),
    ])
    const matches = filterJobs(data, SAMPLE_PROFILE, DEFAULT_FILTERS)
    const cities = groupCities(data, matches, DEFAULT_FILTERS)
    expect(cities.find(result => result.city.id === 'london')?.companyCount).toBe(2)
    expect(cities.find(result => result.city.id === 'berlin')?.companyCount).toBe(1)
    expect(groupCompanies(matches)).toHaveLength(2)
  })

  it('never places remote jobs on a company headquarters, even if city data exists', () => {
    const data = catalog([job({ workMode: 'remote', cityIds: ['san-francisco'], remoteWorldwide: true })])
    const matches = filterJobs(data, SAMPLE_PROFILE, DEFAULT_FILTERS)
    expect(matches).toHaveLength(1)
    expect(groupCities(data, matches, DEFAULT_FILTERS)).toEqual([])
  })

  it('keeps collection coverage separate from zero-match cities', () => {
    const data = catalog([job({ cityIds: ['london'] })])
    const matches = filterJobs(data, SAMPLE_PROFILE, { ...DEFAULT_FILTERS, query: 'no-such-company' })
    expect(groupCities(data, matches, DEFAULT_FILTERS)).toEqual([])
    expect(data.cities.length).toBe(22)
  })

  it('counts a duplicated city ID only once per vacancy', () => {
    const data = catalog([job({ cityIds: ['london', 'london'] })])
    expect(groupCities(data, filterJobs(data, SAMPLE_PROFILE, DEFAULT_FILTERS), DEFAULT_FILTERS)[0].matches).toHaveLength(1)
  })
})

describe('hard conditions and unknown information', () => {
  const visas = catalog([job({ id: 'yes', visa: 'yes' }), job({ id: 'no', visa: 'no' }), job({ id: 'unknown', visa: 'unknown' })])
  it('excludes both denied and unknown visa sponsorship when required', () => {
    expect(filterJobs(visas, SAMPLE_PROFILE, { ...DEFAULT_FILTERS, visa: 'yes' }).map(item => item.job.id)).toEqual(['yes'])
    expect(filterJobs(visas, SAMPLE_PROFILE, { ...DEFAULT_FILTERS, visa: 'possible' }).map(item => item.job.id).sort()).toEqual(['unknown', 'yes'])
  })

  it('checks remote eligibility by country rather than headquarters or continent', () => {
    const data = catalog([
      job({ id: 'world', workMode: 'remote', cityIds: [], remoteWorldwide: true }),
      job({ id: 'us', workMode: 'remote', cityIds: [], remoteCountries: ['US'], remoteWorldwide: false }),
      job({ id: 'unknown', workMode: 'remote', cityIds: [], remoteCountries: [], remoteWorldwide: false, remoteScopeUnknown: true }),
    ])
    expect(filterJobs(data, SAMPLE_PROFILE, DEFAULT_FILTERS).map(item => item.job.id)).toEqual(['world'])
    expect(filterJobs(data, { ...SAMPLE_PROFILE, residence: 'US' }, DEFAULT_FILTERS)).toHaveLength(2)
    expect(filterJobs(data, SAMPLE_PROFILE, { ...DEFAULT_FILTERS, remoteEligibleOnly: false })).toHaveLength(3)
    expect(isRemoteEligible(data.jobs[1], 'KR')).toBe(false)
  })

  it('uses the published salary ceiling and explicit opt-in for undisclosed compensation', () => {
    const data = catalog([
      job({ id: 'eur', salary: { min: 90000, max: 120000, currency: 'EUR' } }),
      job({ id: 'low', salary: { min: 70000, max: 90000, currency: 'USD' } }),
      job({ id: 'unknown', salary: null }),
    ])
    const filters = { ...DEFAULT_FILTERS, salaryMin: 130000, includeUnknownSalary: false }
    expect(filterJobs(data, SAMPLE_PROFILE, filters).map(item => item.job.id)).toEqual(['eur'])
    expect(filterJobs(data, SAMPLE_PROFILE, { ...filters, includeUnknownSalary: true })).toHaveLength(2)
    expect(filterJobs(data, SAMPLE_PROFILE, { ...DEFAULT_FILTERS, includeUnknownSalary: false })).toHaveLength(2)
    expect(toUsd({ min: 100000, max: 120000, currency: 'EUR' }).max).toBeCloseTo(132000)
  })

  it('lets the user override a preferred role with all roles in the visible filter', () => {
    const data = catalog([job({ role: 'backend' }), job({ id: 'frontend', role: 'frontend' })])
    expect(filterJobs(data, { ...SAMPLE_PROFILE, desiredRole: 'backend' }, DEFAULT_FILTERS)).toHaveLength(2)
    expect(filterJobs(data, SAMPLE_PROFILE, { ...DEFAULT_FILTERS, role: 'frontend' })).toHaveLength(1)
  })

  it('searches translated city names as well as company and position names', () => {
    const data = catalog([job({ cityIds: ['london'], companyId: 'stripe' })])
    expect(filterJobs(data, SAMPLE_PROFILE, { ...DEFAULT_FILTERS, query: '런던 Stripe' })).toHaveLength(1)
    expect(filterJobs(data, SAMPLE_PROFILE, { ...DEFAULT_FILTERS, query: '서울 Stripe' })).toHaveLength(0)
  })

  it('retains uncertainty and experience gaps in recommendation explanations', () => {
    const result = matchJob(job({ minExperience: 8, salary: null, visa: 'unknown', skills: ['Python', 'Rust'] }), SAMPLE_PROFILE)
    expect(result.matchedSkills).toEqual(['Python'])
    expect(result.missingSkills).toEqual(['Rust'])
    expect(result.reasons.some(reason => reason.includes('경력 5년'))).toBe(false)
    expect(result.cautions.some(reason => reason.includes('3년 많아요'))).toBe(true)
    expect(result.cautions.some(reason => reason.includes('비자'))).toBe(true)
    expect(result.cautions.some(reason => reason.includes('보상'))).toBe(true)
  })

  it('does not turn missing compensation into a zero salary in city comparisons', () => {
    const data = catalog([job({ salary: null })])
    expect(medianSalary(filterJobs(data, SAMPLE_PROFILE, DEFAULT_FILTERS))).toBeNull()
  })
})

describe('sample integrity and outbound links', () => {
  it('labels every sample job and links to a real company careers page', () => {
    expect(new Set(demo.jobs.map(item => item.id)).size).toBe(demo.jobs.length)
    for (const item of demo.jobs) {
      expect(item.source).toBe('sample')
      expect(item.url).toBe(COMPANIES.find(company => company.id === item.companyId)?.careerUrl)
      for (const id of item.cityIds) expect(CITIES.some(city => city.id === id)).toBe(true)
    }
  })

  it('only allows credential-free HTTPS navigation', () => {
    expect(safeExternalUrl('https://example.com/jobs/123')).toBe('https://example.com/jobs/123')
    expect(safeExternalUrl('javascript:alert(1)')).toBeUndefined()
    expect(safeExternalUrl('data:text/html,test')).toBeUndefined()
    expect(safeExternalUrl('https://user:password@example.com')).toBeUndefined()
    expect(safeExternalUrl('not-a-url')).toBeUndefined()
  })
})
