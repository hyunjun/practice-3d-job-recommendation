import { CITIES } from '../../shared/cities'
import type { Catalog, Company, Filters, Job, Profile, SavedJob } from '../../shared/types'

// Every employer, post and paragraph here is invented. Raw responses intentionally
// contain no languageRequirements: the real normalizers must interpret the body.
export const LANGUAGE_FETCHED_AT = '2026-09-20T09:00:00.000Z'
export const LANGUAGE_UPDATED_AT = '2026-09-19T08:30:00.000Z'
export const LANGUAGE_SAVED_AT = '2026-09-20T09:05:00.000Z'
export const LANGUAGE_NOW = '2026-09-20T09:12:00.000Z'
export const LANGUAGE_NOTE = '가상 지원 기록: 원문의 언어 수준을 직접 확인\n메모와 지원 완료 상태 보존 🌱'

export const LANGUAGE_REGISTRATIONS = [
  { id: 'language-aster', name: 'Aster Systems', provider: 'greenhouse', board: 'AsterLanguages45', careerUrl: 'https://example.com/careers/language-aster', industry: '가상 백엔드 도구' },
  { id: 'language-birch', name: 'Birch Studio', provider: 'ashby', board: 'BirchLanguages45', careerUrl: 'https://example.com/careers/language-birch', industry: '가상 백엔드 도구' },
  { id: 'language-cedar', name: 'Cedar Works', provider: 'lever', board: 'CedarLanguages45', boardRegion: 'eu', careerUrl: 'https://example.com/careers/language-cedar', industry: '가상 백엔드 도구' },
  { id: 'language-dogwood', name: 'Dogwood Forge', provider: 'smartrecruiters', board: 'DogwoodLanguages45', careerUrl: 'https://example.com/careers/language-dogwood', industry: '가상 백엔드 도구' },
] as const
export const LANGUAGE_COMPANIES: Company[] = [
  { ...LANGUAGE_REGISTRATIONS[0], initials: 'AS', color: '#a79aff' },
  { ...LANGUAGE_REGISTRATIONS[1], initials: 'BS', color: '#ff9c78' },
  { ...LANGUAGE_REGISTRATIONS[2], initials: 'CW', color: '#a79aff' },
  { ...LANGUAGE_REGISTRATIONS[3], initials: 'DF', color: '#ff9c78' },
]

export const LANGUAGE_TITLES = {
  mixed: 'Backend Engineer Aster — Bridge',
  context: 'Backend Engineer Aster — Text Tools',
  pool: 'Backend Engineer Aster — Future Opportunities',
  alternatives: 'Backend Engineer Birch — Connect',
  remote: 'Backend Engineer Cedar — Orbit',
  preferred: 'Backend Engineer Dogwood — Field',
} as const
export const LANGUAGE_MIXED = 'Conversational English is required; business-level English is preferred.'
export const LANGUAGE_ALTERNATIVE = 'Fluency in either English or Korean.'
export const LANGUAGE_JAPANESE = 'Japanese reading proficiency is preferred.'
export const LANGUAGE_REMOTE = 'Fluent written and spoken English is required.'
export const LANGUAGE_FRENCH = 'Professional French communication skills are preferred.'
export const LANGUAGE_POOL = 'Fluency in English and Korean is required.'
export const LANGUAGE_CONTEXT = 'Our product translates English, Korean and Japanese articles. Our working language is English. Our existing engineers are fluent in English.'
export const LANGUAGE_CHANGED = 'Conversational German is required; business-level German is preferred.'
export const LANGUAGE_SCOPED = 'Basic Qualifications (2 Titles)\nSenior Software Engineer\nFluency in German.\nSoftware Engineer II\nConversational German proficiency.'
export const LANGUAGE_TECHNICAL = 'Minimum requirements\n3 years of software engineering experience with TypeScript.'

export function languageDescription(condition: string) {
  return `Build and maintain reliable backend services.\n\n${LANGUAGE_TECHNICAL}\n\n${condition}`
}
export function languageHtml(text: string) {
  return text.split('\n\n').map(paragraph => `<p>${paragraph.split('\n').join('<br>')}</p>`).join('')
}

export function languageGreenhouseRaw(overrides: Record<string, unknown> = {}) {
  return {
    id: 4501, internal_job_id: 94501, title: LANGUAGE_TITLES.mixed,
    absolute_url: 'https://example.com/jobs/language-aster-4501',
    updated_at: LANGUAGE_UPDATED_AT, location: { name: 'Berlin, Germany' },
    content: languageHtml(languageDescription(LANGUAGE_MIXED)),
    departments: [{ name: 'Engineering' }],
    metadata: [{ name: 'Employment Type', value: 'Full-time' }, { name: 'Workplace Type', value: 'Onsite' }],
    ...overrides,
  }
}
export function languageAshbyRaw(overrides: Record<string, unknown> = {}) {
  return {
    id: '4504', title: LANGUAGE_TITLES.alternatives,
    jobUrl: 'https://example.com/jobs/language-birch-4504',
    isListed: true, location: 'Berlin, Germany', address: { addressLocality: 'Berlin', addressCountry: 'DE' },
    workplaceType: 'OnSite', isRemote: false, employmentType: 'FullTime', department: 'Engineering',
    descriptionPlain: languageDescription(`Qualifications\n${LANGUAGE_ALTERNATIVE}\n\nPreferred qualifications\n${LANGUAGE_JAPANESE}`),
    ...overrides,
  }
}
export function languageLeverRaw(overrides: Record<string, unknown> = {}) {
  return {
    id: '4505', text: LANGUAGE_TITLES.remote,
    hostedUrl: 'https://example.com/jobs/language-cedar-4505',
    categories: { location: 'Remote, Worldwide', commitment: 'Full-time', department: 'Engineering' },
    workplaceType: 'remote', descriptionPlain: languageDescription(LANGUAGE_REMOTE),
    ...overrides,
  }
}
export function languageSmartRecruitersRaw(overrides: Record<string, unknown> = {}) {
  return {
    id: '4506', name: LANGUAGE_TITLES.preferred,
    company: { identifier: 'DogwoodLanguages45' }, visibility: 'PUBLIC' as const, active: true,
    releasedDate: LANGUAGE_UPDATED_AT, postingUrl: 'https://example.com/jobs/language-dogwood-4506',
    location: { city: 'North Array Research Station', country: 'us', fullLocation: 'North Array Research Station', remote: false, hybrid: false },
    typeOfEmployment: { label: 'Full-time' }, function: { label: 'Engineering' },
    jobAd: { sections: {
      jobDescription: { title: 'Responsibilities', text: '<p>Build and maintain reliable backend services.</p>' },
      qualifications: { title: 'Minimum requirements', text: `<p>3 years of software engineering experience with TypeScript.</p><h3>Preferred qualifications</h3><p>${LANGUAGE_FRENCH}</p>` },
    } },
    ...overrides,
  }
}

/** Exact upstream URLs only; the test transport never forwards a real request. */
export function languageUpstreamResponses(mixed = LANGUAGE_MIXED): Record<string, unknown> {
  const smart = languageSmartRecruitersRaw()
  return {
    'https://boards-api.greenhouse.io/v1/boards/AsterLanguages45/jobs?content=true&pay_transparency=true': {
      jobs: [
        languageGreenhouseRaw({ content: languageHtml(languageDescription(mixed)) }),
        languageGreenhouseRaw({
          id: 4502, internal_job_id: 94502, title: LANGUAGE_TITLES.context,
          absolute_url: 'https://example.com/jobs/language-aster-4502',
          content: languageHtml(languageDescription(`About the company\n${LANGUAGE_CONTEXT}`)),
        }),
        languageGreenhouseRaw({
          id: 4503, internal_job_id: null, title: LANGUAGE_TITLES.pool,
          absolute_url: 'https://example.com/jobs/language-aster-4503',
          content: languageHtml(languageDescription(LANGUAGE_POOL)),
        }),
      ], meta: { total: 3 },
    },
    'https://api.ashbyhq.com/posting-api/job-board/BirchLanguages45?includeCompensation=true':
      { apiVersion: '1', jobs: [languageAshbyRaw()] },
    'https://api.eu.lever.co/v0/postings/CedarLanguages45?mode=json&limit=50&skip=0':
      [languageLeverRaw()],
    'https://api.smartrecruiters.com/v1/companies/DogwoodLanguages45/postings?limit=100&offset=0&destination=PUBLIC':
      { offset: 0, limit: 100, totalFound: 1, content: [smart] },
    'https://api.smartrecruiters.com/v1/companies/DogwoodLanguages45/postings/4506': smart,
  }
}

export const LANGUAGE_PROFILE: Profile = {
  kind: 'personal', name: '가상 지원자', headline: 'Backend Engineer', years: 5,
  skills: ['TypeScript'], desiredRole: 'backend', residence: 'KR', linkedinUrl: '',
}
export const LANGUAGE_FILTERS: Filters = {
  query: '', region: 'all', role: 'backend', workMode: 'all', visa: 'all', employment: 'all',
  postingType: 'opening', salaryMin: 0, includeUnknownSalary: true, remoteEligibleOnly: true,
}

/** An old literal record, not a current normalizer result with its new field removed. */
export function legacyLanguageJob(nativeId = '4501', overrides: Partial<Job> = {}): Job {
  const source = overrides.source ?? 'greenhouse'
  const companyId = overrides.companyId ?? 'language-aster'
  return {
    id: `${source}-${companyId}-${nativeId}`, companyId, source,
    title: LANGUAGE_TITLES.mixed, role: 'backend', cityIds: ['berlin'], locationLabel: 'Berlin, Germany',
    workMode: 'onsite', employment: 'fulltime', employmentVersion: 1,
    visa: 'unknown', minExperience: 3, skills: ['TypeScript'], salary: null, compensationVersion: 2,
    remoteCountries: [], remoteWorldwide: false, remoteScopeUnknown: false, remoteScopeVersion: 2,
    description: languageDescription(LANGUAGE_MIXED), requirements: [],
    url: `https://example.com/jobs/${companyId}-${nativeId}`,
    fetchedAt: LANGUAGE_FETCHED_AT, updatedAt: LANGUAGE_UPDATED_AT, stale: false,
    ...overrides,
  }
}
export function legacyLanguageSaved(job = legacyLanguageJob()): SavedJob {
  const company = LANGUAGE_COMPANIES.find(company => company.id === job.companyId)
  if (!company) throw new Error('A synthetic language record must have its own company')
  return { job, company, savedAt: LANGUAGE_SAVED_AT, status: 'applied', note: LANGUAGE_NOTE }
}

/** Literal44 collected snapshot, including its original non-language metadata.
 * This permits real current API revision comparison without manufacturing a
 * difference by omitting older source facts or changing its paragraph spacing. */
export function legacyCollectedLanguageSaved(): SavedJob {
  const technical = 'Minimum requirements\n3 years of software engineering experience with TypeScript.'
  return legacyLanguageSaved(legacyLanguageJob('4501', {
    description: `Build and maintain reliable backend services.\n${technical}\n${LANGUAGE_MIXED}`,
    roleClassification: { version: 1, roles: ['backend'], evidence: [{ role: 'backend', source: 'title', text: LANGUAGE_TITLES.mixed }] },
    occupation: { version: 3, category: 'engineering', departments: ['Engineering'], evidence: [{ source: 'title', text: LANGUAGE_TITLES.mixed }] },
    qualifications: {
      version: 1,
      skills: [{ kind: 'required', skills: ['TypeScript'], match: 'all', evidence: { source: 'description', text: technical } }],
      experience: [{ kind: 'required', minYears: 3, conditional: false, evidence: { source: 'description', text: technical } }],
    },
    eligibility: { version: 2, rules: [] },
    evidence: {
      workMode: { source: 'board', text: 'Workplace Type: Onsite' },
      employment: { source: 'board', text: 'Employment Type: Full-time' },
    },
  }))
}
export function legacyLanguageJobs(): Job[] {
  return [
    legacyLanguageJob(),
    legacyLanguageJob('4502', { title: LANGUAGE_TITLES.context, description: languageDescription(`About the company\n${LANGUAGE_CONTEXT}`) }),
    legacyLanguageJob('4503', {
      title: LANGUAGE_TITLES.pool, description: languageDescription(LANGUAGE_POOL),
      postingPurpose: { version: 1, kind: 'talent-pool', basis: 'greenhouse-prospect', evidence: [{ source: 'board', text: 'Greenhouse internal_job_id: null (prospect post)' }] },
    }),
    legacyLanguageJob('4504', {
      source: 'ashby', companyId: 'language-birch', title: LANGUAGE_TITLES.alternatives,
      description: languageDescription(`Qualifications\n${LANGUAGE_ALTERNATIVE}\n\nPreferred qualifications\n${LANGUAGE_JAPANESE}`),
    }),
    legacyLanguageJob('4505', {
      source: 'lever', companyId: 'language-cedar', title: LANGUAGE_TITLES.remote,
      cityIds: [], locationLabel: 'Remote, Worldwide', workMode: 'remote', remoteWorldwide: true,
      description: languageDescription(LANGUAGE_REMOTE),
    }),
    legacyLanguageJob('4506', {
      source: 'smartrecruiters', companyId: 'language-dogwood', title: LANGUAGE_TITLES.preferred,
      cityIds: [], locationLabel: 'North Array Research Station',
      description: languageDescription(`Preferred qualifications\n${LANGUAGE_FRENCH}`),
    }),
  ]
}
export function legacyLanguageCatalog(): Catalog {
  return {
    source: 'public', fetchedAt: LANGUAGE_FETCHED_AT, stale: false, companies: LANGUAGE_COMPANIES,
    cities: CITIES, jobs: legacyLanguageJobs(), unmappedCount: 1,
    boards: [
      { companyId: 'language-aster', provider: 'greenhouse', board: 'AsterLanguages45', status: 'ok', dataStatus: 'fresh', total: 3, included: 3 },
      { companyId: 'language-birch', provider: 'ashby', board: 'BirchLanguages45', status: 'ok', dataStatus: 'fresh', total: 1, included: 1 },
      { companyId: 'language-cedar', provider: 'lever', board: 'CedarLanguages45', status: 'ok', dataStatus: 'fresh', total: 1, included: 1 },
      { companyId: 'language-dogwood', provider: 'smartrecruiters', board: 'DogwoodLanguages45', status: 'ok', dataStatus: 'fresh', total: 1, included: 1 },
    ],
  }
}
