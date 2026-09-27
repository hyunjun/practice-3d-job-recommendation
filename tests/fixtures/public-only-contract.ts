/**
 * Stage65 test inputs only. No runtime demo imports, collected records, cache,
 * provider calls, or configured employer registry. Even "public" jobs below are
 * fictional protocol fixtures; "public" describes the API contract being tested.
 */
import type { Catalog, City, Company, Job, Profile, SavedJob } from '../../shared/types'

export const NOW = '2026-09-27T00:00:00.000Z'
export const PREVIOUS = '2026-09-26T23:55:00.000Z'
export const PUBLIC_NOTE = 'PRIVATE_65_PUBLIC_NOTE\n다음 주 지원 · =1+2 🌱'
export const IMPORT_NOTE = 'PRIVATE_65_IMPORTED_NOTE 원본 유지'

export const PROFILE: Profile = {
  kind: 'personal', name: 'PRIVATE_65_PROFILE', headline: 'Synthetic engineer',
  years: 5, skills: ['TypeScript'], desiredRole: 'all', residence: 'GB', linkedinUrl: '',
}

// Deliberately literal: changing product defaults must not silently change the oracle.
export const CONDITIONS = {
  query: 'Backend Engineer', region: 'europe', role: 'backend', workMode: 'onsite',
  visa: 'all', employment: 'fulltime', postingType: 'opening', salaryMin: 0,
  includeUnknownSalary: true, remoteEligibleOnly: true,
} as const
export const LEGACY_EXPLORATION = {
  source: 'sample', filters: CONDITIONS, selectedId: 'london', panelTab: 'cities',
  mapMode: 'flat', light: true, citySort: 'salary',
} as const

const CITIES: City[] = [
  { id: 'london', name: '런던', en: 'London', country: '영국', countryCode: 'GB',
    region: 'europe', lat: 51.5074, lng: -0.1278, timezone: 'Europe/London', description: 'Synthetic city input' },
  { id: 'berlin', name: '베를린', en: 'Berlin', country: '독일', countryCode: 'DE',
    region: 'europe', lat: 52.52, lng: 13.405, timezone: 'Europe/Berlin', description: 'Synthetic city input' },
  { id: 'seoul', name: '서울', en: 'Seoul', country: '대한민국', countryCode: 'KR',
    region: 'asia-pacific', lat: 37.5665, lng: 126.978, timezone: 'Asia/Seoul', description: 'Synthetic city input' },
]
export const RAIL: Company = {
  id: 'fixture65-rail', name: 'Fable Rail', initials: 'FR', color: '#3466cc',
  industry: 'Synthetic railway employer', careerUrl: 'https://example.test/fable-rail/careers',
  provider: 'greenhouse', board: 'fixture65-rail',
}
export const TEXTILE: Company = {
  id: 'fixture65-textile', name: 'Loom Textiles', initials: 'LT', color: '#386650',
  industry: 'Synthetic textile employer', careerUrl: 'https://example.test/loom-textiles/careers',
  provider: 'ashby', board: 'fixture65-textile',
}

function job(id: string, companyId: string, title: string, cityId: string, role: 'backend' | 'frontend', source: 'greenhouse' | 'ashby'): Job {
  return {
    id, companyId, title, role, cityIds: [cityId],
    locationLabel: cityId === 'london' ? 'London, United Kingdom' : cityId === 'berlin' ? 'Berlin, Germany' : 'Seoul, South Korea',
    workMode: 'onsite', employment: 'fulltime', employmentVersion: 1,
    minExperience: 3, skills: ['TypeScript'], salary: null, compensationVersion: 2, visa: 'unknown',
    qualifications: { version: 1, skills: [], experience: [] },
    eligibility: { version: 2, rules: [] },
    roleClassification: { version: 1, roles: [role], evidence: [{ role, source: 'title', text: title }] },
    occupation: { version: 5, category: 'engineering', departments: [], evidence: [{ source: 'title', text: title }] },
    remoteCountries: [], remoteWorldwide: false, remoteScopeUnknown: false,
    description: 'Synthetic regression input. No actual vacancy or application.',
    requirements: [], url: `https://example.test/jobs/${id}`, source,
    updatedAt: null, fetchedAt: PREVIOUS, stale: false,
  }
}
export const API_JOB = job('greenhouse-fixture65-rail-api', RAIL.id, 'Backend Engineer — Fable Rail API', 'london', 'backend', 'greenhouse')
export const BERLIN_JOB = job('greenhouse-fixture65-rail-telemetry', RAIL.id, 'Backend Engineer — Fable Rail Telemetry', 'berlin', 'backend', 'greenhouse')
export const SEOUL_JOB = job('ashby-fixture65-textile-platform', TEXTILE.id, 'Backend Engineer — Loom Textiles Platform', 'seoul', 'backend', 'ashby')
const FRONTEND_JOB = job('greenhouse-fixture65-rail-console', RAIL.id, 'Frontend Engineer — Fable Rail Console', 'london', 'frontend', 'greenhouse')

export function publicCatalog(revision: 'cached' | 'refreshed' | 'empty' = 'cached'): Catalog {
  const fetchedAt = revision === 'cached' ? PREVIOUS : NOW
  const jobs = revision === 'empty' ? [] : structuredClone([API_JOB, BERLIN_JOB, SEOUL_JOB, FRONTEND_JOB])
  if (revision === 'refreshed') {
    jobs[0].title = 'Backend Engineer — Fable Rail Freight'
    jobs[0].roleClassification!.evidence[0].text = jobs[0].title
    jobs[0].occupation!.evidence[0].text = jobs[0].title
    for (const item of jobs) item.fetchedAt = NOW
  }
  return {
    source: 'public', fetchedAt, checkedAt: fetchedAt, stale: false, unmappedCount: 0,
    cities: structuredClone(CITIES), companies: structuredClone([RAIL, TEXTILE]), jobs,
    boards: [
      { companyId: RAIL.id, provider: 'greenhouse', board: RAIL.board!, status: 'ok', dataStatus: 'fresh',
        lastSuccessAt: fetchedAt, checkedAt: fetchedAt, total: revision === 'empty' ? 0 : 3, included: revision === 'empty' ? 0 : 3 },
      { companyId: TEXTILE.id, provider: 'ashby', board: TEXTILE.board!, status: 'ok', dataStatus: 'fresh',
        lastSuccessAt: fetchedAt, checkedAt: fetchedAt, total: revision === 'empty' ? 0 : 1, included: revision === 'empty' ? 0 : 1 },
    ],
  }
}

export const PUBLIC_SAVED: SavedJob = {
  job: API_JOB, company: RAIL, savedAt: '2026-09-26T23:56:00.000Z', status: 'applied', note: PUBLIC_NOTE,
}
export const IMPORTED_SAVED: SavedJob = {
  job: SEOUL_JOB, company: TEXTILE, savedAt: '2026-09-26T23:57:00.000Z', status: 'saved', note: IMPORT_NOTE,
}
