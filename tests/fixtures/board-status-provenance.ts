import type { BoardResult } from '../../server/catalog-service'
import type { CachedBoard } from '../../server/board-cache'
import type { CachedPresence, PresenceResult } from '../../server/posting-presence'
import type { Company, Job, JobProvider, SavedJob } from '../../shared/types'
import type { PresenceResponses } from './posting-presence'
import { publicProtocolJob } from './public-protocol'

/**
 * Stage74 board-status provenance fixtures. Every employer, posting, paragraph,
 * timestamp and failure text is invented. Tests write their expected rows out
 * literally; nothing here calls the product's status resolver or scheduler.
 */
export const PROVENANCE_DAY = '2026-10-01'
export const PROVENANCE_BASE = `${PROVENANCE_DAY}T06:00:00.000Z`
/** `stamp('06:01:00.000')` → `2026-10-01T06:01:00.000Z`. */
export const stamp = (time: string) => `${PROVENANCE_DAY}T${time}Z`

export const PROVENANCE_ALDER: Company = {
  id: 'provenance-alder', name: 'Alder Forge', initials: 'AF', color: '#3974cc',
  industry: '가상 출처 검증', provider: 'greenhouse', board: 'AlderProvenance74',
  careerUrl: 'https://example.com/careers/provenance-alder',
}
export const PROVENANCE_BIRCH: Company = {
  id: 'provenance-birch', name: 'Birch Signal', initials: 'BS', color: '#487950',
  industry: '가상 출처 검증', provider: 'smartrecruiters', board: 'BirchProvenance74',
  careerUrl: 'https://example.com/careers/provenance-birch',
}
/** A daily-refresh source for the healthy-operation independence checks. */
export const PROVENANCE_CEDAR_DAILY: Company = {
  id: 'provenance-cedar', name: 'Cedar Daily', initials: 'CD', color: '#84dba6',
  industry: '가상 출처 검증', provider: 'himalayas', board: 'cedar-provenance',
  careerUrl: 'https://example.com/careers/provenance-cedar',
}
export const PROVENANCE_COMPANIES: Company[] = [PROVENANCE_ALDER, PROVENANCE_BIRCH]

export const PROVENANCE_FAILURES = {
  list: 'Fictional public list 503',
  detail: 'Fictional posting detail 503',
  persistedList: 'Fictional persisted list failure',
  persistedDetail: 'Fictional persisted detail failure',
  legacyList: 'Fictional legacy list failure',
} as const

type PublicJob = Job & { source: JobProvider }
export function provenanceJob(company: Company, nativeId: string, fetchedAt: string): PublicJob {
  const provider = company.provider ?? 'greenhouse'
  return publicProtocolJob(nativeId, {
    id: `${provider}-${company.id}-${nativeId}`, companyId: company.id, source: provider, fetchedAt,
    title: `Backend Engineer — ${company.name} ${nativeId}`,
  })
}

/** A complete full-content result whose inventory equals its retained jobs. */
export function contentResult(company: Company, fetchedAt: string, nativeIds = ['7401']): BoardResult {
  const jobs = nativeIds.map(id => provenanceJob(company, id, fetchedAt))
  return { jobs, total: jobs.length, unmappedCount: 0, publishedIds: jobs.map(job => job.id) }
}

export function presenceResult(company: Company, nativeIds = ['7401']): PresenceResult {
  const provider = company.provider ?? 'greenhouse'
  return { total: nativeIds.length, publishedIds: nativeIds.map(id => `${provider}-${company.id}-${id}`) }
}

/** A persisted full-content record. `body: null` stores a failure without any snapshot. */
export function cachedBody(company: Company, checkedAt: string, options: {
  body?: { fetchedAt: string; nativeIds?: string[]; inventory?: boolean } | null
  failure?: { message: string; retryAt: string | null; failures?: number; phase?: 'inventory' | 'content' }
} = {}): CachedBoard {
  const body = options.body === undefined ? { fetchedAt: checkedAt } : options.body
  const jobs = body ? (body.nativeIds ?? ['7401']).map(id => provenanceJob(company, id, body.fetchedAt)) : []
  return {
    companyId: company.id, board: company.board!, provider: company.provider ?? 'greenhouse', checkedAt,
    failures: options.failure ? options.failure.failures ?? 1 : 0,
    retryAt: options.failure ? options.failure.retryAt : null,
    ...(options.failure ? { error: options.failure.message, errorPhase: options.failure.phase ?? 'content' } : {}),
    ...(body ? {
      snapshot: {
        fetchedAt: body.fetchedAt, jobs, total: jobs.length, unmappedCount: 0,
        // Legacy bodies recorded no complete public inventory.
        ...(body.inventory === false ? {} : { publishedIds: jobs.map(job => job.id) }),
      },
    } : {}),
  }
}

/** A persisted public-list record. Failures may carry a null or short retry deadline. */
export function cachedPresence(company: Company, checkedAt: string, options: {
  inventory?: { fetchedAt: string; nativeIds?: string[] } | null
  failure?: { message: string; retryAt: string | null; failures?: number }
} = {}): CachedPresence {
  const inventory = options.inventory === undefined ? (options.failure ? null : { fetchedAt: checkedAt }) : options.inventory
  return {
    companyId: company.id, board: company.board!, provider: company.provider ?? 'greenhouse', checkedAt,
    failures: options.failure ? options.failure.failures ?? 1 : 0,
    retryAt: options.failure ? options.failure.retryAt : null,
    ...(options.failure ? { error: options.failure.message } : {}),
    ...(inventory ? { snapshot: { fetchedAt: inventory.fetchedAt, ...presenceResult(company, inventory.nativeIds) } } : {}),
  }
}

// Real-server registrations and raw provider payloads. The product collectors
// build the jobs; tests only assert the resulting rows and request URLs.
export const PROVENANCE_REGISTRATIONS = [
  {
    id: 'provenance-alder', name: 'Alder Forge', provider: 'greenhouse', board: 'AlderProvenance74',
    careerUrl: 'https://example.com/careers/provenance-alder', industry: '가상 출처 검증',
  },
  {
    id: 'provenance-birch', name: 'Birch Signal', provider: 'smartrecruiters', board: 'BirchProvenance74',
    careerUrl: 'https://example.com/careers/provenance-birch', industry: '가상 출처 검증',
  },
] as const

export const PROVENANCE_URLS = {
  alderContent: 'https://boards-api.greenhouse.io/v1/boards/AlderProvenance74/jobs?content=true&pay_transparency=true',
  alderPresence: 'https://boards-api.greenhouse.io/v1/boards/AlderProvenance74/jobs?content=false',
  birchList: 'https://api.smartrecruiters.com/v1/companies/BirchProvenance74/postings?limit=100&offset=0&destination=PUBLIC',
  birchDetail: 'https://api.smartrecruiters.com/v1/companies/BirchProvenance74/postings/74001',
} as const

export const PROVENANCE_TITLES = {
  alder: 'Backend Engineer — Alder Ledger',
  birch: 'Backend Engineer — Birch Relay',
} as const
export const PROVENANCE_RELEASED_AT = '2026-09-30T08:00:00.000Z'
export const PROVENANCE_SAVED_FETCHED_AT = `${PROVENANCE_DAY}T05:00:00.000Z`
export const PROVENANCE_SAVED_AT = `${PROVENANCE_DAY}T05:05:00.000Z`
export const PROVENANCE_NOTE = '가상 74단계 메모 — 원래 지원 기록 보존 🌱'

const rawAlder = {
  id: 7401, internal_job_id: 17401, title: PROVENANCE_TITLES.alder,
  absolute_url: 'https://example.com/jobs/provenance-alder-7401', updated_at: PROVENANCE_RELEASED_AT,
  location: { name: 'London, United Kingdom' },
  content: '<h2>Responsibilities</h2><p>Build fictional ledger services.</p><h2>Minimum requirements</h2><p>3 years of software engineering experience with TypeScript.</p>',
  departments: [{ name: 'Engineering' }],
  metadata: [{ name: 'Employment Type', value: 'Full-time' }, { name: 'Workplace Type', value: 'Onsite' }],
}
const rawBirchSummary = {
  id: '74001', name: PROVENANCE_TITLES.birch, company: { identifier: 'BirchProvenance74' }, visibility: 'PUBLIC',
  releasedDate: PROVENANCE_RELEASED_AT,
  location: { city: 'London', country: 'gb', fullLocation: 'London, United Kingdom', remote: false, hybrid: false },
  typeOfEmployment: { label: 'Full-time' },
}
const rawBirchDetail = {
  ...rawBirchSummary, active: true, postingUrl: 'https://example.com/jobs/provenance-birch-74001',
  jobAd: { sections: {
    jobDescription: { title: 'Responsibilities', text: '<p>Build a fictional signal relay with TypeScript.</p>' },
    qualifications: { title: 'Minimum requirements', text: '<p>3 years of software engineering experience.</p>' },
  } },
}

export type ProvenanceListState = 'listed' | 'empty' | 'rate-limited'
export function provenanceResponses(options: { alder?: 'listed' | 'rate-limited'; birch?: ProvenanceListState } = {}): PresenceResponses {
  const rateLimited = { status: 429, headers: { 'Retry-After': '600' }, body: { error: 'Fictional board rate limit' } }
  const birch = options.birch ?? 'listed'
  return {
    [PROVENANCE_URLS.alderContent]: options.alder === 'rate-limited' ? rateLimited : { body: { jobs: [rawAlder], meta: { total: 1 } } },
    [PROVENANCE_URLS.alderPresence]: options.alder === 'rate-limited' ? rateLimited : { body: {
      jobs: [{ id: rawAlder.id, title: rawAlder.title, absolute_url: rawAlder.absolute_url }], meta: { total: 1 },
    } },
    [PROVENANCE_URLS.birchList]: birch === 'rate-limited' ? rateLimited : { body: {
      offset: 0, limit: 100, totalFound: birch === 'empty' ? 0 : 1, content: birch === 'empty' ? [] : [rawBirchSummary],
    } },
    [PROVENANCE_URLS.birchDetail]: { body: rawBirchDetail },
  }
}

/** Old saved inputs written by hand; expected notices never use a normalizer. */
export function provenanceSaved(company: 'alder' | 'birch'): SavedJob[] {
  const alder = company === 'alder'
  return [{
    job: {
      id: alder ? 'greenhouse-provenance-alder-7401' : 'smartrecruiters-provenance-birch-74001',
      companyId: alder ? 'provenance-alder' : 'provenance-birch',
      title: alder ? PROVENANCE_TITLES.alder : PROVENANCE_TITLES.birch, role: 'backend',
      description: alder
        ? 'Responsibilities\nBuild fictional ledger services.\n\nMinimum requirements\n3 years of software engineering experience with TypeScript.'
        : 'Responsibilities\nBuild a fictional signal relay with TypeScript.\n\nMinimum requirements\n3 years of software engineering experience.',
      cityIds: ['london'], locationLabel: 'London, United Kingdom', workMode: 'onsite', employment: 'fulltime',
      minExperience: 3, skills: ['TypeScript'], salary: null, visa: 'unknown',
      remoteCountries: [], remoteWorldwide: false, remoteScopeUnknown: false,
      requirements: ['3 years of software engineering experience.'],
      url: alder ? 'https://example.com/jobs/provenance-alder-7401' : 'https://example.com/jobs/provenance-birch-74001',
      source: alder ? 'greenhouse' : 'smartrecruiters', updatedAt: PROVENANCE_RELEASED_AT, fetchedAt: PROVENANCE_SAVED_FETCHED_AT,
    },
    company: alder ? PROVENANCE_ALDER : PROVENANCE_BIRCH,
    savedAt: PROVENANCE_SAVED_AT, status: 'applied', note: PROVENANCE_NOTE,
  }]
}
