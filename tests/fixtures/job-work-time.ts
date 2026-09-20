import { CITIES } from '../../shared/cities'
import type { Catalog, Company, Filters, Job, Profile, SavedJob } from '../../shared/types'

// Invented employers and original paragraphs only. Provider responses contain
// no workTimeRequirements; the actual collector must interpret their full body.
export const WORK_TIME_FETCHED_AT = '2026-09-20T10:30:00.000Z'
export const WORK_TIME_UPDATED_AT = '2026-09-19T08:30:00.000Z'
export const WORK_TIME_SAVED_AT = '2026-09-20T10:35:00.000Z'
export const WORK_TIME_NOW = '2026-09-20T10:42:00.000Z'
export const WORK_TIME_NOTE = '가상 지원 기록: 협업시간과 서머타임을 직접 확인\n메모와 지원 완료 상태 보존 🌱'
export const WORK_TIME_REGISTRATIONS = [
  { id: 'time-dawn', name: 'Dawn Circuits', provider: 'greenhouse', board: 'DawnWorkTime46', careerUrl: 'https://example.com/careers/time-dawn', industry: '가상 백엔드 도구' },
  { id: 'time-juniper', name: 'Juniper Labs', provider: 'ashby', board: 'JuniperWorkTime46', careerUrl: 'https://example.com/careers/time-juniper', industry: '가상 백엔드 도구' },
  { id: 'time-maple', name: 'Maple Systems', provider: 'lever', board: 'MapleWorkTime46', boardRegion: 'eu', careerUrl: 'https://example.com/careers/time-maple', industry: '가상 백엔드 도구' },
  { id: 'time-willow', name: 'Willow Instruments', provider: 'smartrecruiters', board: 'WillowWorkTime46', careerUrl: 'https://example.com/careers/time-willow', industry: '가상 백엔드 도구' },
] as const
export const WORK_TIME_COMPANIES: Company[] = [
  { ...WORK_TIME_REGISTRATIONS[0], initials: 'DC', color: '#a79aff' },
  { ...WORK_TIME_REGISTRATIONS[1], initials: 'JL', color: '#ff9c78' },
  { ...WORK_TIME_REGISTRATIONS[2], initials: 'MS', color: '#a79aff' },
  { ...WORK_TIME_REGISTRATIONS[3], initials: 'WI', color: '#ff9c78' },
]
export const WORK_TIME_TITLES = {
  mixed: 'Backend Engineer Dawn — Bridge',
  context: 'Backend Engineer Dawn — Text Tools',
  pool: 'Backend Engineer Dawn — Future Opportunities',
  collaboration: 'Backend Engineer Juniper — Connect',
  remote: 'Backend Engineer Maple — Orbit',
  ambiguous: 'Backend Engineer Willow — Field',
} as const
export const WORK_TIME_CORE = 'Our core hours are 10:00–14:00 UTC.'
export const WORK_TIME_OVERLAP = 'You must have at least 3 hours of overlap with Pacific Time.'
export const WORK_TIME_MIXED = `Working hours\n${WORK_TIME_CORE}\n\nCollaboration\n${WORK_TIME_OVERLAP}`
export const WORK_TIME_COLLABORATION = 'This team works on Central European Time.'
export const WORK_TIME_PREFERENCE = 'Four hours of overlap with Central European Time is preferred.'
export const WORK_TIME_POOL = 'Candidates must be based in the Eastern or Central time zones.'
export const WORK_TIME_REMOTE = 'You must be based in the Eastern time zone or further east.'
export const WORK_TIME_REMOTE_CORE = 'Our core hours are 09:00–13:00 UTC+02:00.'
export const WORK_TIME_AMBIGUOUS = 'Core hours are 13:00–16:00 CST.'
export const WORK_TIME_WORKING = 'Our main working hours are 9 to 5 Pacific Time.'
export const WORK_TIME_CONTEXT = 'Our product displays UTC clocks. Our teammates span many time zones. We support flexible, asynchronous work.'
export const WORK_TIME_SCOPED = 'Basic Qualifications (2 Titles)\nSenior Software Engineer\nCore hours are 09:00–12:00 GMT.\nSoftware Engineer II\nCore hours are 14:00–17:00 GMT.'
export const WORK_TIME_LANGUAGE = 'Fluent English is required.'
export const WORK_TIME_BILINGUAL = 'Fluency in English or Korean is required.'
export const WORK_TIME_TECHNICAL = 'Minimum requirements\n3 years of software engineering experience with TypeScript.'

export function workTimeDescription(condition: string, language = WORK_TIME_LANGUAGE) {
  return `Build and maintain reliable backend services.\n\n${WORK_TIME_TECHNICAL}\n${language}\n\n${condition}`
}
export function workTimeHtml(text: string) {
  return text.split('\n\n').map(paragraph => `<p>${paragraph.split('\n').join('<br>')}</p>`).join('')
}
export function workTimeGreenhouseRaw(overrides: Record<string, unknown> = {}) {
  return {
    id: 4601, internal_job_id: 94601, title: WORK_TIME_TITLES.mixed,
    absolute_url: 'https://example.com/jobs/time-dawn-4601',
    updated_at: WORK_TIME_UPDATED_AT, location: { name: 'Berlin, Germany' },
    content: workTimeHtml(workTimeDescription(WORK_TIME_MIXED)),
    departments: [{ name: 'Engineering' }],
    metadata: [{ name: 'Employment Type', value: 'Full-time' }, { name: 'Workplace Type', value: 'Onsite' }],
    ...overrides,
  }
}
export function workTimeAshbyRaw(overrides: Record<string, unknown> = {}) {
  return {
    id: '4604', title: WORK_TIME_TITLES.collaboration,
    jobUrl: 'https://example.com/jobs/time-juniper-4604',
    isListed: true, location: 'Berlin, Germany', address: { addressLocality: 'Berlin', addressCountry: 'DE' },
    workplaceType: 'OnSite', isRemote: false, employmentType: 'FullTime', department: 'Engineering',
    descriptionPlain: workTimeDescription(`Collaboration\n${WORK_TIME_COLLABORATION}\n\nNice to have\n${WORK_TIME_PREFERENCE}`, WORK_TIME_BILINGUAL),
    ...overrides,
  }
}
export function workTimeLeverRaw(overrides: Record<string, unknown> = {}) {
  return {
    id: '4605', text: WORK_TIME_TITLES.remote,
    hostedUrl: 'https://example.com/jobs/time-maple-4605',
    categories: { location: 'Remote, Worldwide', commitment: 'Full-time', department: 'Engineering' },
    workplaceType: 'remote',
    descriptionPlain: workTimeDescription(`Location\n${WORK_TIME_REMOTE}\n\nWorking hours\n${WORK_TIME_REMOTE_CORE}`),
    ...overrides,
  }
}
export function workTimeSmartRecruitersRaw(overrides: Record<string, unknown> = {}) {
  return {
    id: '4606', name: WORK_TIME_TITLES.ambiguous,
    company: { identifier: 'WillowWorkTime46' }, visibility: 'PUBLIC' as const, active: true,
    releasedDate: WORK_TIME_UPDATED_AT, postingUrl: 'https://example.com/jobs/time-willow-4606',
    location: { city: 'North Array Research Station', country: 'us', fullLocation: 'North Array Research Station', remote: false, hybrid: false },
    typeOfEmployment: { label: 'Full-time' }, function: { label: 'Engineering' },
    jobAd: { sections: {
      jobDescription: { title: 'Responsibilities', text: `<p>Build and maintain reliable backend services.</p><h3>Working hours</h3><p>${WORK_TIME_AMBIGUOUS}</p><p>${WORK_TIME_WORKING}</p>` },
      qualifications: { title: 'Minimum requirements', text: `<p>3 years of software engineering experience with TypeScript.</p><p>${WORK_TIME_LANGUAGE}</p>` },
    } },
    ...overrides,
  }
}
export function workTimeUpstreamResponses(mixed = WORK_TIME_MIXED): Record<string, unknown> {
  const smart = workTimeSmartRecruitersRaw()
  return {
    'https://boards-api.greenhouse.io/v1/boards/DawnWorkTime46/jobs?content=true&pay_transparency=true': {
      jobs: [
        workTimeGreenhouseRaw({ content: workTimeHtml(workTimeDescription(mixed)) }),
        workTimeGreenhouseRaw({
          id: 4602, internal_job_id: 94602, title: WORK_TIME_TITLES.context,
          absolute_url: 'https://example.com/jobs/time-dawn-4602',
          content: workTimeHtml(workTimeDescription(`About the company\n${WORK_TIME_CONTEXT}`)),
        }),
        workTimeGreenhouseRaw({
          id: 4603, internal_job_id: null, title: WORK_TIME_TITLES.pool,
          absolute_url: 'https://example.com/jobs/time-dawn-4603',
          content: workTimeHtml(workTimeDescription(`Location\n${WORK_TIME_POOL}`)),
        }),
      ], meta: { total: 3 },
    },
    'https://api.ashbyhq.com/posting-api/job-board/JuniperWorkTime46?includeCompensation=true':
      { apiVersion: '1', jobs: [workTimeAshbyRaw()] },
    'https://api.eu.lever.co/v0/postings/MapleWorkTime46?mode=json&limit=50&skip=0':
      [workTimeLeverRaw()],
    'https://api.smartrecruiters.com/v1/companies/WillowWorkTime46/postings?limit=100&offset=0&destination=PUBLIC':
      { offset: 0, limit: 100, totalFound: 1, content: [smart] },
    'https://api.smartrecruiters.com/v1/companies/WillowWorkTime46/postings/4606': smart,
  }
}
export const WORK_TIME_PROFILE: Profile = {
  kind: 'personal', name: '가상 지원자', headline: 'Backend Engineer', years: 5,
  skills: ['TypeScript'], desiredRole: 'backend', residence: 'KR', linkedinUrl: '',
}
export const WORK_TIME_FILTERS: Filters = {
  query: '', region: 'all', role: 'backend', workMode: 'all', visa: 'all', employment: 'all',
  postingType: 'opening', salaryMin: 0, includeUnknownSalary: true, remoteEligibleOnly: true,
}

/** Literal older public record. No final work-time interpretation is prefilled. */
export function legacyWorkTimeJob(nativeId = '4601', overrides: Partial<Job> = {}): Job {
  const source = overrides.source ?? 'greenhouse'
  const companyId = overrides.companyId ?? 'time-dawn'
  return {
    id: `${source}-${companyId}-${nativeId}`, companyId, source,
    title: WORK_TIME_TITLES.mixed, role: 'backend', cityIds: ['berlin'], locationLabel: 'Berlin, Germany',
    workMode: 'onsite', employment: 'fulltime', employmentVersion: 1,
    visa: 'unknown', minExperience: 3, skills: ['TypeScript'], salary: null, compensationVersion: 2,
    remoteCountries: [], remoteWorldwide: false, remoteScopeUnknown: false, remoteScopeVersion: 2,
    description: workTimeDescription(WORK_TIME_MIXED), requirements: [],
    url: `https://example.com/jobs/${companyId}-${nativeId}`,
    fetchedAt: WORK_TIME_FETCHED_AT, updatedAt: WORK_TIME_UPDATED_AT, stale: false,
    ...overrides,
  }
}
export function legacyWorkTimeSaved(job = legacyWorkTimeJob()): SavedJob {
  const company = WORK_TIME_COMPANIES.find(company => company.id === job.companyId)
  if (!company) throw new Error('A synthetic work-time record must have its own company')
  return { job, company, savedAt: WORK_TIME_SAVED_AT, status: 'applied', note: WORK_TIME_NOTE }
}
/** Literal45 collected source, transcribed from the frozen-build observation.
 * Existing language/qualification evidence and paragraph spacing are retained
 * so comparing it with a current collection cannot invent a source change. */
export function legacyCollectedWorkTimeSaved(): SavedJob {
  return legacyWorkTimeSaved(legacyWorkTimeJob('4601', {
    description: `Build and maintain reliable backend services.\n${WORK_TIME_TECHNICAL}\n${WORK_TIME_LANGUAGE}\nWorking hours\n${WORK_TIME_CORE}\nCollaboration\n${WORK_TIME_OVERLAP}`,
    roleClassification: { version: 1, roles: ['backend'], evidence: [{ role: 'backend', source: 'title', text: WORK_TIME_TITLES.mixed }] },
    occupation: { version: 3, category: 'engineering', departments: ['Engineering'], evidence: [{ source: 'title', text: WORK_TIME_TITLES.mixed }] },
    qualifications: {
      version: 1,
      skills: [{ kind: 'required', skills: ['TypeScript'], match: 'all', evidence: { source: 'description', text: WORK_TIME_TECHNICAL } }],
      experience: [{ kind: 'required', minYears: 3, conditional: false, evidence: { source: 'description', text: WORK_TIME_TECHNICAL } }],
    },
    languageRequirements: { version: 1, rules: [
      { languages: ['en'], kind: 'required', match: 'all', evidence: { source: 'description', text: `Minimum requirements\n${WORK_TIME_LANGUAGE}` } },
    ] },
    eligibility: { version: 2, rules: [] },
    evidence: {
      workMode: { source: 'board', text: 'Workplace Type: Onsite' },
      employment: { source: 'board', text: 'Employment Type: Full-time' },
    },
  }))
}
export function legacyWorkTimeJobs(): Job[] {
  return [
    legacyWorkTimeJob(),
    legacyWorkTimeJob('4602', { title: WORK_TIME_TITLES.context, description: workTimeDescription(`About the company\n${WORK_TIME_CONTEXT}`) }),
    legacyWorkTimeJob('4603', {
      title: WORK_TIME_TITLES.pool, description: workTimeDescription(`Location\n${WORK_TIME_POOL}`),
      postingPurpose: { version: 1, kind: 'talent-pool', basis: 'greenhouse-prospect', evidence: [{ source: 'board', text: 'Greenhouse internal_job_id: null (prospect post)' }] },
    }),
    legacyWorkTimeJob('4604', {
      source: 'ashby', companyId: 'time-juniper', title: WORK_TIME_TITLES.collaboration,
      description: workTimeDescription(`Collaboration\n${WORK_TIME_COLLABORATION}\n\nNice to have\n${WORK_TIME_PREFERENCE}`, WORK_TIME_BILINGUAL),
    }),
    legacyWorkTimeJob('4605', {
      source: 'lever', companyId: 'time-maple', title: WORK_TIME_TITLES.remote,
      cityIds: [], locationLabel: 'Remote, Worldwide', workMode: 'remote', remoteWorldwide: true,
      description: workTimeDescription(`Location\n${WORK_TIME_REMOTE}\n\nWorking hours\n${WORK_TIME_REMOTE_CORE}`),
    }),
    legacyWorkTimeJob('4606', {
      source: 'smartrecruiters', companyId: 'time-willow', title: WORK_TIME_TITLES.ambiguous,
      cityIds: [], locationLabel: 'North Array Research Station',
      description: workTimeDescription(`Working hours\n${WORK_TIME_AMBIGUOUS}\n${WORK_TIME_WORKING}`),
    }),
  ]
}
export function legacyWorkTimeCatalog(): Catalog {
  return {
    source: 'public', fetchedAt: WORK_TIME_FETCHED_AT, stale: false,
    companies: WORK_TIME_COMPANIES, cities: CITIES, jobs: legacyWorkTimeJobs(), unmappedCount: 1,
    boards: [
      { companyId: 'time-dawn', provider: 'greenhouse', board: 'DawnWorkTime46', status: 'ok', dataStatus: 'fresh', total: 3, included: 3 },
      { companyId: 'time-juniper', provider: 'ashby', board: 'JuniperWorkTime46', status: 'ok', dataStatus: 'fresh', total: 1, included: 1 },
      { companyId: 'time-maple', provider: 'lever', board: 'MapleWorkTime46', status: 'ok', dataStatus: 'fresh', total: 1, included: 1 },
      { companyId: 'time-willow', provider: 'smartrecruiters', board: 'WillowWorkTime46', status: 'ok', dataStatus: 'fresh', total: 1, included: 1 },
    ],
  }
}
