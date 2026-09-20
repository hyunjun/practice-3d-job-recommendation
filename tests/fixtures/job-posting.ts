import { CITIES } from '../../shared/cities'
import type { Catalog, Company, Filters, Job, Profile, SavedJob } from '../../shared/types'

// All companies, posts and source paragraphs are invented. Provider responses
// remain raw: neither catalog results nor classifier outputs are prefilled.
export const JOB_POSTING_TIME = '2026-09-20T07:00:00.000Z'
export const JOB_POSTING_UPDATED_AT = '2026-09-19T07:00:00.000Z'
export const JOB_POSTING_SAVED_AT = '2026-09-20T07:05:00.000Z'
export const JOB_POSTING_NOW = '2026-09-20T07:12:00.000Z'
export const JOB_POSTING_NOTE = '가상 지원 기록: 현재 포지션인지 원문에서 확인\n메모와 지원 완료 상태 보존 🌱'

export const JOB_POSTING_REGISTRATIONS = [
  { id: 'posting-alder', name: 'Alder Workshop', provider: 'greenhouse', board: 'AlderPurpose43', careerUrl: 'https://example.com/careers/posting-alder', industry: 'Synthetic backend software' },
  { id: 'posting-birch', name: 'Birch Engine', provider: 'ashby', board: 'BirchPurpose43', careerUrl: 'https://example.com/careers/posting-birch', industry: 'Synthetic backend software' },
  { id: 'posting-cedar', name: 'Cedar Circuit', provider: 'lever', board: 'CedarPurpose43', boardRegion: 'eu', careerUrl: 'https://example.com/careers/posting-cedar', industry: 'Synthetic backend software' },
  { id: 'posting-dogwood', name: 'Dogwood Studio', provider: 'smartrecruiters', board: 'DogwoodPurpose43', careerUrl: 'https://example.com/careers/posting-dogwood', industry: 'Synthetic backend software' },
] as const

export const JOB_POSTING_PROSPECT_TITLE = 'Backend Engineer Alder'
export const JOB_POSTING_FUTURE_TITLE = 'Backend Engineer Birch — Future Opportunities'
export const JOB_POSTING_ORDINARY_TITLE = 'Backend Engineer Cedar'
export const JOB_POSTING_EOI_TITLE = 'Backend Engineer Dogwood — Expression of Interest'
export const JOB_POSTING_FUTURE_PARAGRAPH = 'This posting is a registration for future software engineering opportunities and collects candidate profiles; it is not for a currently open position.'
export const JOB_POSTING_KOREAN_PARAGRAPH = '본 공고는 현재 채용 중인 특정 포지션이 아닌, 향후 소프트웨어 엔지니어링 기회를 위한 인재 등록 공고입니다.'
export const JOB_POSTING_ACTIVE_PARAGRAPH = 'Our backend team is opportunistically hiring engineers now. This expression of interest is for a current role, not a talent pool.'
export const JOB_POSTING_ORDINARY_PARAGRAPH = 'We are hiring a backend engineer for this current position. Build and maintain reliable services in London.'
export const JOB_POSTING_QUALIFICATIONS = 'Qualifications: 3 years of software engineering experience with TypeScript.'

export function postingDescription(paragraph: string) {
  return `${paragraph}\n\n${JOB_POSTING_QUALIFICATIONS}`
}

export function postingGreenhouseRaw(overrides: Record<string, unknown> = {}) {
  return {
    id: 4301, internal_job_id: null, title: JOB_POSTING_PROSPECT_TITLE,
    absolute_url: 'https://example.com/jobs/posting-alder-4301',
    updated_at: JOB_POSTING_UPDATED_AT, location: { name: 'London, United Kingdom' },
    content: `<p>${JOB_POSTING_ORDINARY_PARAGRAPH}</p><p>${JOB_POSTING_QUALIFICATIONS}</p>`,
    departments: [{ name: 'Engineering' }],
    metadata: [{ name: 'Employment Type', value: 'Full-time' }, { name: 'Workplace Type', value: 'Onsite' }],
    ...overrides,
  }
}

export function postingAshbyRaw(overrides: Record<string, unknown> = {}) {
  return {
    id: '4302', title: JOB_POSTING_FUTURE_TITLE,
    jobUrl: 'https://example.com/jobs/posting-birch-4302',
    isListed: true, location: 'London', address: { addressLocality: 'London', addressCountry: 'GB' },
    workplaceType: 'OnSite', isRemote: false, employmentType: 'FullTime',
    department: 'Engineering', descriptionPlain: postingDescription(JOB_POSTING_FUTURE_PARAGRAPH),
    ...overrides,
  }
}

export function postingLeverRaw(overrides: Record<string, unknown> = {}) {
  return {
    id: '4303', text: JOB_POSTING_ORDINARY_TITLE,
    hostedUrl: 'https://example.com/jobs/posting-cedar-4303',
    categories: { location: 'London', commitment: 'Full-time', department: 'Engineering' },
    country: 'GB', workplaceType: 'on-site', descriptionPlain: postingDescription(JOB_POSTING_ORDINARY_PARAGRAPH),
    ...overrides,
  }
}

export function postingSmartRecruitersRaw(overrides: Record<string, unknown> = {}) {
  return {
    id: '4304', name: JOB_POSTING_EOI_TITLE,
    company: { identifier: 'DogwoodPurpose43' }, visibility: 'PUBLIC' as const, active: true,
    releasedDate: JOB_POSTING_UPDATED_AT, postingUrl: 'https://example.com/jobs/posting-dogwood-4304',
    location: { city: 'London', country: 'gb', fullLocation: 'London, United Kingdom', remote: false, hybrid: false },
    typeOfEmployment: { label: 'Full-time' }, function: { label: 'Engineering' },
    jobAd: { sections: {
      jobDescription: { title: 'Responsibilities', text: `<p>${JOB_POSTING_ACTIVE_PARAGRAPH}</p>` },
      qualifications: { title: 'Qualifications', text: `<p>${JOB_POSTING_QUALIFICATIONS}</p>` },
    } },
    ...overrides,
  }
}

/** Literal upstream URL map for an isolated real configured collector. */
export function postingUpstreamResponses(): Record<string, unknown> {
  const smart = postingSmartRecruitersRaw()
  return {
    'https://boards-api.greenhouse.io/v1/boards/AlderPurpose43/jobs?content=true&pay_transparency=true':
      { jobs: [postingGreenhouseRaw()], meta: { total: 1 } },
    'https://api.ashbyhq.com/posting-api/job-board/BirchPurpose43?includeCompensation=true':
      { apiVersion: '1', jobs: [postingAshbyRaw()] },
    'https://api.eu.lever.co/v0/postings/CedarPurpose43?mode=json&limit=50&skip=0':
      [postingLeverRaw()],
    'https://api.smartrecruiters.com/v1/companies/DogwoodPurpose43/postings?limit=100&offset=0&destination=PUBLIC':
      { offset: 0, limit: 100, totalFound: 1, content: [smart] },
    'https://api.smartrecruiters.com/v1/companies/DogwoodPurpose43/postings/4304': smart,
  }
}

export const JOB_POSTING_COMPANIES: Company[] = [
  { ...JOB_POSTING_REGISTRATIONS[0], initials: 'AW', color: '#a79aff' },
  { ...JOB_POSTING_REGISTRATIONS[1], initials: 'BE', color: '#ff9c78' },
  { ...JOB_POSTING_REGISTRATIONS[2], initials: 'CC', color: '#a79aff' },
  { ...JOB_POSTING_REGISTRATIONS[3], initials: 'DS', color: '#ff9c78' },
]
export const JOB_POSTING_PROFILE: Profile = {
  kind: 'personal', name: 'Synthetic purpose profile', headline: 'Backend Engineer',
  years: 5, skills: ['TypeScript'], desiredRole: 'backend', residence: 'GB', linkedinUrl: '',
}
export const JOB_POSTING_FILTERS: Filters = {
  query: '', region: 'all', role: 'backend', workMode: 'all', visa: 'all', employment: 'all',
  postingType: 'opening', salaryMin: 0, includeUnknownSalary: true, remoteEligibleOnly: true,
}

/** A literal pre-purpose snapshot; no new classifier result is stripped to make it. */
export function legacyPostingJob(nativeId = 'legacy-future', overrides: Partial<Job> = {}): Job {
  const companyId = overrides.companyId ?? 'posting-alder'
  const source = overrides.source ?? 'greenhouse'
  return {
    id: `${source}-${companyId}-${nativeId}`, companyId, title: 'Backend Engineer — Future Opportunities',
    role: 'backend', cityIds: ['london'], locationLabel: 'London, United Kingdom', workMode: 'onsite',
    employment: 'unknown', visa: 'unknown', minExperience: 3, skills: ['TypeScript'], salary: null,
    remoteCountries: [], remoteWorldwide: false, remoteScopeUnknown: false, remoteScopeVersion: 2,
    description: postingDescription(JOB_POSTING_FUTURE_PARAGRAPH), requirements: [],
    url: `https://example.com/jobs/posting/${nativeId}`, source,
    fetchedAt: JOB_POSTING_TIME, updatedAt: JOB_POSTING_UPDATED_AT, stale: false,
    ...overrides,
  }
}

export function legacyPostingSaved(job = legacyPostingJob()): SavedJob {
  const company = JOB_POSTING_COMPANIES.find(company => company.id === job.companyId)
  if (!company) throw new Error('A synthetic saved posting must have its own company')
  return {
    job, company, savedAt: JOB_POSTING_SAVED_AT, status: 'applied', note: JOB_POSTING_NOTE,
  }
}

/** Eight literal old records: four openings, four registrations, mixed companies/scopes. */
export function postingScopeJobs(): Job[] {
  const ordinary = postingDescription('We are hiring a backend engineer for this current position.')
  return [
    legacyPostingJob('open-london', { title: 'Backend Engineer Alder Opening', description: ordinary }),
    legacyPostingJob('pool-london', { title: 'Backend Engineer Alder Future Opportunities' }),
    legacyPostingJob('pool-remote', {
      title: 'Backend Engineer Alder Remote Future Opportunities', cityIds: [], locationLabel: 'United Kingdom · Remote',
      workMode: 'remote', remoteCountries: ['GB'], remoteScopeUnknown: false,
    }),
    legacyPostingJob('open-paris', {
      companyId: 'posting-birch', source: 'ashby', title: 'Backend Engineer Birch Opening',
      cityIds: ['paris'], locationLabel: 'Paris, France', description: ordinary,
    }),
    legacyPostingJob('pool-unmapped', {
      companyId: 'posting-birch', source: 'ashby', title: 'Backend Engineer Birch Future Opportunities',
      cityIds: [], locationLabel: 'North Wharf Research Station',
    }),
    legacyPostingJob('open-remote', {
      companyId: 'posting-cedar', source: 'lever', title: 'Backend Engineer Cedar Remote Opening',
      cityIds: [], locationLabel: 'United Kingdom · Remote', workMode: 'remote',
      remoteCountries: ['GB'], remoteScopeUnknown: false, description: ordinary,
    }),
    legacyPostingJob('open-unmapped', {
      companyId: 'posting-cedar', source: 'lever', title: 'Backend Engineer Cedar Station Opening',
      cityIds: [], locationLabel: 'North Wharf Research Station', description: ordinary,
    }),
    legacyPostingJob('pool-paris', {
      companyId: 'posting-dogwood', source: 'smartrecruiters', title: 'Backend Engineer Dogwood Future Opportunities',
      cityIds: ['paris'], locationLabel: 'Paris, France',
    }),
  ]
}

export function postingCatalog(jobs = postingScopeJobs()): Catalog {
  return {
    source: 'public', fetchedAt: JOB_POSTING_TIME, stale: false, cities: CITIES,
    companies: JOB_POSTING_COMPANIES, jobs,
    unmappedCount: jobs.filter(job => job.workMode !== 'remote' && job.cityIds.length === 0).length,
    boards: JOB_POSTING_COMPANIES.map(company => ({
      companyId: company.id, provider: company.provider!, board: company.board!,
      ...(company.boardRegion ? { boardRegion: company.boardRegion } : {}),
      status: 'ok', dataStatus: 'fresh', fetchedAt: JOB_POSTING_TIME,
      total: jobs.filter(job => job.companyId === company.id).length,
      included: jobs.filter(job => job.companyId === company.id).length,
    })),
  }
}
