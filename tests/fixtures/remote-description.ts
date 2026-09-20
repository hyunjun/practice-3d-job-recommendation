import { CITIES } from '../../shared/cities'
import { DEFAULT_FILTERS } from '../../shared/types'
import type { Catalog, Company, Filters, Job, Profile, SavedJob } from '../../shared/types'
import { SEARCH_PROFILE } from './search-catalog'

// Every description and identity here is synthetic. No employer text is copied.
export const REMOTE_DESCRIPTION_TIME = '2026-09-19T08:00:00.000Z'
export const REMOTE_DESCRIPTION_UPDATED_AT = '2026-09-18T09:00:00.000Z'
export const REMOTE_DESCRIPTION_SAVED_AT = '2026-09-19T08:10:00.000Z'
export const REMOTE_DESCRIPTION_NOW = '2026-09-19T08:12:00.000Z'
export const REMOTE_DESCRIPTION_NOTE = '가상 지원 메모\n주별 거주 제한을 따로 확인 🌏'
export const REMOTE_DESCRIPTION_INTRO = 'Build and maintain reliable backend services.'

export const REMOTE_UK_PARAGRAPH = 'This role is available to applicants residing in the United Kingdom only. Applicants based in the United States and Canada should apply to the separate vacancy linked from our careers page.'
export const REMOTE_US_PARAGRAPH = 'This position is United States - Remote Eligible. Residents of Nevada and Vermont cannot be employed for this role. Occasional in-person planning days may be required.'
export const REMOTE_MIXED_PARAGRAPH = 'This role can be performed remotely from the United States or Europe.'
export const REMOTE_CONFLICT_PARAGRAPH = 'Candidates for this role must reside in the United Kingdom.'
export const REMOTE_NOISE_PARAGRAPH = 'Our company serves customers in Canada and the United Kingdom. United States employees receive a retirement benefit. Offices in Ireland and Germany host company events.'

export const REMOTE_DESCRIPTION_COMPANIES: Company[] = [
  { id: 'remote-description-a', name: 'Cedar Systems', initials: 'CS', color: '#a79aff',
    industry: 'Synthetic backend tools', provider: 'greenhouse', board: 'remote-description-a',
    careerUrl: 'https://example.com/careers/remote-description-a' },
  { id: 'remote-description-b', name: 'Maple Software', initials: 'MS', color: '#ff9c78',
    industry: 'Synthetic developer tools', provider: 'greenhouse', board: 'remote-description-b',
    careerUrl: 'https://example.com/careers/remote-description-b' },
]

export const REMOTE_DESCRIPTION_PROFILE: Profile = {
  ...SEARCH_PROFILE, name: 'Synthetic remote description profile', kind: 'personal',
  desiredRole: 'all', residence: 'GB',
}
export const REMOTE_DESCRIPTION_FILTERS: Filters = {
  ...DEFAULT_FILTERS, role: 'all', workMode: 'remote',
}

export function remoteDescriptionText(paragraph: string): string {
  return `${REMOTE_DESCRIPTION_INTRO}\n\n${paragraph}`
}

/** A literal prior-version record, never a new normalizer result with fields removed. */
export function legacyRemoteDescriptionJob(id = '4101', overrides: Partial<Job> = {}): Job {
  const companyId = overrides.companyId ?? 'remote-description-a'
  const source = overrides.source ?? 'greenhouse'
  return {
    id: `${source}-${companyId}-${id}`, companyId, title: 'Backend Engineer Cedar',
    role: 'backend', cityIds: [], locationLabel: 'Remote', workMode: 'remote',
    employment: 'unknown', visa: 'unknown', skills: [], minExperience: null, salary: null,
    remoteCountries: [], remoteWorldwide: false, remoteScopeUnknown: true, remoteScopeVersion: 1,
    description: remoteDescriptionText(REMOTE_UK_PARAGRAPH), requirements: [],
    url: `https://example.com/jobs/remote-description/${id}`, source,
    updatedAt: REMOTE_DESCRIPTION_UPDATED_AT, fetchedAt: REMOTE_DESCRIPTION_TIME, stale: false,
    ...overrides,
  }
}

export function remoteDescriptionJobs(): Job[] {
  return [
    legacyRemoteDescriptionJob(),
    legacyRemoteDescriptionJob('4102', {
      companyId: 'remote-description-b', title: 'Backend Engineer Maple',
      description: remoteDescriptionText(REMOTE_US_PARAGRAPH),
    }),
    legacyRemoteDescriptionJob('4103', {
      title: 'Backend Engineer Birch', description: remoteDescriptionText(REMOTE_MIXED_PARAGRAPH),
    }),
    legacyRemoteDescriptionJob('4104', {
      companyId: 'remote-description-b', title: 'Backend Engineer Rowan',
      locationLabel: 'United States · Remote', remoteCountries: ['US'], remoteScopeUnknown: false,
      description: remoteDescriptionText(REMOTE_CONFLICT_PARAGRAPH),
    }),
  ]
}

/** Only remote fixtures belong here; the zero unmapped count is deliberate. */
export function remoteDescriptionCatalog(jobs = remoteDescriptionJobs()): Catalog {
  return {
    source: 'public', fetchedAt: REMOTE_DESCRIPTION_TIME, stale: false,
    cities: CITIES, companies: REMOTE_DESCRIPTION_COMPANIES, jobs, unmappedCount: 0,
    boards: REMOTE_DESCRIPTION_COMPANIES.map(company => ({
      companyId: company.id, provider: 'greenhouse', board: company.board!,
      status: 'ok', dataStatus: 'fresh', fetchedAt: REMOTE_DESCRIPTION_TIME,
      total: jobs.filter(job => job.companyId === company.id).length,
      included: jobs.filter(job => job.companyId === company.id).length,
    })),
  }
}

export function legacyRemoteDescriptionSaved(): SavedJob {
  return {
    job: legacyRemoteDescriptionJob(), company: REMOTE_DESCRIPTION_COMPANIES[0],
    savedAt: REMOTE_DESCRIPTION_SAVED_AT, status: 'applied', note: REMOTE_DESCRIPTION_NOTE,
  }
}

/** Neutral source text, followed by a whole paragraph outside the retained body. */
export function longRemoteDescription(paragraph = REMOTE_US_PARAGRAPH): string {
  return `${'We build reliable backend tools and document service operations.\n\n'.repeat(440)}${paragraph}`
}
