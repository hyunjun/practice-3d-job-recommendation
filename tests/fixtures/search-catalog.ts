import { createSampleCatalog } from '../../shared/sample'
import { isUnmappedJob } from '../../shared/job-location'
import { DEFAULT_FILTERS, SAMPLE_PROFILE } from '../../shared/types'
import type { Catalog, Company, Filters, Job, Profile } from '../../shared/types'

const sample = createSampleCatalog()
export const SEARCH_TIME = '2026-09-19T08:00:00.000Z'
export const SEARCH_COMPANIES: Company[] = ['a', 'b'].map((letter, index) => ({
  ...sample.companies[index], id: `search-fixture-${letter}`, name: `Fixture ${letter.toUpperCase()}`,
  initials: `F${letter.toUpperCase()}`, industry: 'Search verification',
  careerUrl: `https://example.com/careers/${letter}`, provider: 'greenhouse', board: `search-fixture-${letter}`,
}))
export const SEARCH_PROFILE: Profile = {
  ...SAMPLE_PROFILE, kind: 'personal', name: 'Search fixture', skills: ['TypeScript'], years: 5,
  desiredRole: 'backend', residence: 'GB',
}
export const SEARCH_FILTERS: Filters = {
  ...DEFAULT_FILTERS, role: 'backend', visa: 'yes', salaryMin: 150000,
  workMode: 'all', employment: 'fulltime', includeUnknownSalary: false, remoteEligibleOnly: true,
}

export function searchJob(id: string, overrides: Partial<Job> = {}): Job {
  return {
    ...sample.jobs[0], id: `greenhouse-search-fixture-a-${id}`, companyId: SEARCH_COMPANIES[0].id,
    title: `Backend Engineer ${id}`, role: 'backend', cityIds: ['london'], locationLabel: 'London',
    source: 'greenhouse', fetchedAt: SEARCH_TIME, stale: false, url: `https://example.com/jobs/${id}`,
    workMode: 'onsite', employment: 'fulltime', visa: 'yes', skills: ['TypeScript'], minExperience: 3,
    salary: { min: 100000, max: 180000, currency: 'USD' },
    compensationVersion: 1, compensationRanges: undefined, compensationNote: undefined, compensationEvidence: undefined,
    qualifications: undefined, eligibility: { version: 1, rules: [] }, evidence: undefined,
    remoteWorldwide: false, remoteCountries: [], remoteRegions: undefined, remoteScopeUnknown: false,
    description: 'Synthetic job for search recovery verification.', requirements: ['TypeScript'],
    ...overrides,
  }
}

export function searchCatalog(jobs: Job[]): Catalog {
  return {
    source: 'public', fetchedAt: SEARCH_TIME, stale: false, cities: sample.cities,
    companies: SEARCH_COMPANIES, jobs, unmappedCount: jobs.filter(isUnmappedJob).length,
    boards: SEARCH_COMPANIES.map(company => ({
      companyId: company.id, provider: 'greenhouse', board: company.board!, status: 'ok', dataStatus: 'fresh',
      fetchedAt: SEARCH_TIME, total: jobs.filter(job => job.companyId === company.id).length,
      included: jobs.filter(job => job.companyId === company.id).length,
    })),
  }
}
