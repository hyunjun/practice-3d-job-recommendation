import type { CatalogCollectionSnapshot, CatalogCollectionUpdate } from '../../shared/catalog-progress'
import type { BoardStatus, Catalog, Company, Filters, Job, Profile, SavedJob } from '../../shared/types'

// Fictional public HTTP payloads. No collector, cache, matching, normalization,
// aggregation or product fixture helper computes the expected test results.
export const CATALOG_WORKER_TIME = '2026-09-24T08:00:00.000Z'
export const CATALOG_WORKER_SECOND_TIME = '2026-09-24T08:00:01.000Z'
export const CATALOG_WORKER_FINAL_TIME = '2026-09-24T08:00:02.000Z'
export const CATALOG_WORKER_REVISED_TIME = '2026-09-24T08:05:00.000Z'
export const CATALOG_WORKER_COLLECTION = '00000000-0000-4000-8000-000000000067'
export const CATALOG_WORKER_NOTE = 'PRIVATE_CATALOG_WORKER_NOTE — 지원 준비 🌱'

export const CATALOG_WORKER_PROFILE: Profile = {
  kind: 'personal', name: 'PRIVATE_CATALOG_WORKER_PROFILE',
  headline: 'PRIVATE_CATALOG_WORKER_RESUME',
  years: 5, skills: ['TypeScript'], desiredRole: 'backend', residence: 'GB',
  linkedinUrl: 'https://example.org/PRIVATE_CATALOG_WORKER_LINK',
}

export const CATALOG_WORKER_FILTERS: Filters = {
  query: '', region: 'all', role: 'all', workMode: 'all', visa: 'all',
  employment: 'all', postingType: 'opening', salaryMin: 0,
  includeUnknownSalary: true, remoteEligibleOnly: true,
}

const companies: Company[] = [
  {
    id: 'catalog-worker-aster', name: 'Aster QA Labs', initials: 'AQ', color: '#3974cc',
    industry: 'Fictional software laboratory', provider: 'greenhouse', board: 'catalog-worker-aster',
    careerUrl: 'https://example.org/catalog-worker/aster/careers',
  },
  {
    id: 'catalog-worker-birch', name: 'Birch QA Systems', initials: 'BQ', color: '#497b55',
    industry: 'Fictional software laboratory', provider: 'greenhouse', board: 'catalog-worker-birch',
    careerUrl: 'https://example.org/catalog-worker/birch/careers',
  },
  {
    id: 'catalog-worker-cedar', name: 'Cedar QA Works', initials: 'CQ', color: '#9467bd',
    industry: 'Fictional software laboratory', provider: 'greenhouse', board: 'catalog-worker-cedar',
    careerUrl: 'https://example.org/catalog-worker/cedar/careers',
  },
]

function job(company: 'aster' | 'birch' | 'cedar', suffix: string, title: string, changes: Partial<Job> = {}): Job {
  const companyId = `catalog-worker-${company}`
  return {
    id: `greenhouse-${companyId}-${suffix}`, companyId, title,
    role: 'backend', cityIds: ['london'], locationLabel: 'London, UK',
    source: 'greenhouse', updatedAt: null, fetchedAt: CATALOG_WORKER_TIME, stale: false,
    url: `https://example.org/catalog-worker/${company}/${suffix}`,
    workMode: 'onsite', employment: 'fulltime', employmentVersion: 1,
    visa: 'yes', skills: ['TypeScript'], minExperience: 3,
    salary: { min: 100000, max: 160000, currency: 'USD' }, compensationVersion: 2,
    qualifications: {
      version: 1,
      skills: [{
        kind: 'qualification', skills: ['TypeScript'], match: 'all',
        evidence: { source: 'description', text: 'Qualifications: experience with TypeScript.' },
      }],
      experience: [{
        kind: 'qualification', minYears: 3, conditional: false,
        evidence: { source: 'description', text: 'Qualifications: 3 years of software engineering experience.' },
      }],
    },
    eligibility: { version: 2, rules: [] },
    remoteWorldwide: false, remoteCountries: [], remoteScopeUnknown: false, remoteScopeVersion: 2,
    description: 'Fictional software engineering vacancy. Qualifications: 3 years of software engineering experience with TypeScript.',
    requirements: ['3 years of software engineering experience with TypeScript.'],
    ...changes,
  }
}

const arrivals: Job[][] = [
  [
    job('aster', 'atlas', 'Backend Engineer — Atlas Alpha'),
    job('aster', 'berlin', 'Frontend Engineer — Beacon Berlin', {
      role: 'frontend', cityIds: ['berlin'], locationLabel: 'Berlin, Germany',
      salary: { min: 110000, max: 170000, currency: 'USD' },
    }),
    job('aster', 'remote-uk', 'Backend Engineer — Beacon Remote UK', {
      workMode: 'remote', cityIds: [], locationLabel: 'Remote, UK', remoteCountries: ['GB'],
      employment: 'contract', salary: null,
    }),
  ],
  [
    job('birch', 'london', 'Backend Engineer — Beacon London', {
      fetchedAt: CATALOG_WORKER_SECOND_TIME, salary: { min: 180000, max: 220000, currency: 'USD' },
      minExperience: 7, qualifications: {
        version: 1,
        skills: [{
          kind: 'qualification', skills: ['TypeScript'], match: 'all',
          evidence: { source: 'description', text: 'Qualifications: experience with TypeScript.' },
        }],
        experience: [{
          kind: 'qualification', minYears: 7, conditional: false,
          evidence: { source: 'description', text: 'Qualifications: 7 years of software engineering experience.' },
        }],
      },
      description: 'Fictional software engineering vacancy. Qualifications: 7 years of software engineering experience with TypeScript.',
      requirements: ['7 years of software engineering experience with TypeScript.'],
    }),
    job('birch', 'berlin', 'Backend Engineer — Beacon Berlin', {
      fetchedAt: CATALOG_WORKER_SECOND_TIME, cityIds: ['berlin'], locationLabel: 'Berlin, Germany',
      salary: { min: 140000, max: 190000, currency: 'USD' },
    }),
    job('birch', 'canvas', 'Frontend Engineer — Atlas Canvas', {
      fetchedAt: CATALOG_WORKER_SECOND_TIME, role: 'frontend', employment: 'contract',
      salary: { min: 100000, max: 140000, currency: 'USD' },
    }),
  ],
  [
    job('cedar', 'london', 'Backend Engineer — Beacon London Final', {
      fetchedAt: CATALOG_WORKER_FINAL_TIME, salary: { min: 200000, max: 240000, currency: 'USD' },
    }),
    job('cedar', 'berlin', 'Frontend Engineer — Beacon Berlin Final', {
      fetchedAt: CATALOG_WORKER_FINAL_TIME, role: 'frontend',
      cityIds: ['berlin'], locationLabel: 'Berlin, Germany', salary: null,
    }),
    job('cedar', 'remote-us', 'Backend Engineer — Beacon Remote US', {
      fetchedAt: CATALOG_WORKER_FINAL_TIME, workMode: 'remote', cityIds: [],
      locationLabel: 'Remote, US', remoteCountries: ['US'],
      salary: { min: 200000, max: 240000, currency: 'USD' },
    }),
  ],
]

export function catalogWorkerCatalog(completed: 0 | 1 | 2 | 3 = 3): Catalog {
  const times = [CATALOG_WORKER_TIME, CATALOG_WORKER_SECOND_TIME, CATALOG_WORKER_FINAL_TIME]
  return {
    source: 'public', fetchedAt: completed ? times[completed - 1] : '', stale: false,
    ...(completed ? { checkedAt: times[completed - 1] } : {}),
    companies: structuredClone(companies),
    cities: [
      {
        id: 'london', name: '런던', en: 'London', country: '영국', countryCode: 'GB', region: 'europe',
        lat: 51.5074, lng: -0.1278, timezone: 'Europe/London', description: 'Fictional QA geography: London.',
      },
      {
        id: 'berlin', name: '베를린', en: 'Berlin', country: '독일', countryCode: 'DE', region: 'europe',
        lat: 52.52, lng: 13.405, timezone: 'Europe/Berlin', description: 'Fictional QA geography: Berlin.',
      },
    ],
    jobs: structuredClone(arrivals.slice(0, completed).flat()),
    boards: companies.map((company, index): BoardStatus => ({
      companyId: company.id, provider: 'greenhouse', board: company.board!,
      status: index < completed ? 'ok' : 'pending',
      dataStatus: index < completed ? 'fresh' : 'unavailable',
      total: index < completed ? 3 : 0, included: index < completed ? 3 : 0,
      lastSuccessAt: index < completed ? times[index] : null,
      ...(index < completed ? { checkedAt: times[index] } : {}),
    })),
    unmappedCount: 0,
  }
}

export function catalogWorkerSnapshot(completed: 0 | 1 | 2 = 1): CatalogCollectionSnapshot {
  return {
    catalog: catalogWorkerCatalog(completed),
    progress: { id: CATALOG_WORKER_COLLECTION, revision: completed, total: 3, completed, done: false },
  }
}

export function catalogWorkerUpdate(completed: 2 | 3): CatalogCollectionUpdate {
  const { companies: _companies, cities: _cities, jobs: _jobs, ...catalog } = catalogWorkerCatalog(completed)
  return {
    progress: { id: CATALOG_WORKER_COLLECTION, revision: completed, total: 3, completed, done: completed === 3 },
    catalog, companyIds: [completed === 2 ? 'catalog-worker-birch' : 'catalog-worker-cedar'],
    jobs: structuredClone(arrivals[completed - 1]),
  }
}

export function catalogWorkerEmpty(): Catalog {
  const catalog = catalogWorkerCatalog()
  return { ...catalog, jobs: [], boards: catalog.boards.map(board => ({ ...board, total: 0, included: 0 })) }
}

export function catalogWorkerRevised(): Catalog {
  const catalog = catalogWorkerCatalog()
  return {
    ...catalog, fetchedAt: CATALOG_WORKER_REVISED_TIME, checkedAt: CATALOG_WORKER_REVISED_TIME,
    jobs: catalog.jobs.map(item => ({
      ...item, fetchedAt: CATALOG_WORKER_REVISED_TIME,
      ...(item.id === 'greenhouse-catalog-worker-aster-atlas'
        ? { title: 'Backend Engineer — Atlas Alpha Revised', salary: { min: 150000, max: 200000, currency: 'USD' as const } } : {}),
    })),
    boards: catalog.boards.map(board => ({
      ...board, checkedAt: CATALOG_WORKER_REVISED_TIME, lastSuccessAt: CATALOG_WORKER_REVISED_TIME,
    })),
  }
}

export function catalogWorkerSaved(): SavedJob[] {
  return [{
    job: structuredClone(arrivals[0][0]), company: structuredClone(companies[0]),
    savedAt: CATALOG_WORKER_TIME, status: 'applied', note: CATALOG_WORKER_NOTE,
  }]
}
