import type { CatalogCollectionSnapshot, CatalogCollectionUpdate } from '../../shared/catalog-progress'
import type { Catalog, Company, Filters, Job, Profile } from '../../shared/types'
import { publicProtocolJob } from './public-protocol'
import { PUBLIC_TEST_CITIES } from './public-geography'

// Entirely authored public-protocol data. Expected UI values below are literal,
// not outputs from product matching, grouping, worker or presentation functions.
export const PRESENTATION_TIME = '2026-09-27T09:00:00.000Z'
export const PRESENTATION_COLLECTION = '00000000-0000-4000-8000-000000000068'
export const PRESENTATION_PROFILE: Profile = {
  kind: 'personal', name: 'PRIVATE_PRESENTATION_PROFILE', headline: 'Fictional queue review',
  years: 5, skills: ['TypeScript', 'Python', 'PostgreSQL', 'AWS'],
  desiredRole: 'all', residence: 'GB', linkedinUrl: '',
}
export const PRESENTATION_FILTERS: Filters = {
  query: '', region: 'all', role: 'all', workMode: 'all', visa: 'all',
  employment: 'all', postingType: 'opening', salaryMin: 0,
  includeUnknownSalary: true, remoteEligibleOnly: true,
}
const companies: Company[] = [
  { id: 'presentation-aster', name: 'Aster Presentation', initials: 'AP', color: '#3974cc', industry: 'Fictional queue QA', provider: 'greenhouse', board: 'presentation-aster', careerUrl: 'https://example.test/presentation/aster' },
  { id: 'presentation-birch', name: 'Birch Presentation', initials: 'BP', color: '#487950', industry: 'Fictional queue QA', provider: 'greenhouse', board: 'presentation-birch', careerUrl: 'https://example.test/presentation/birch' },
  { id: 'presentation-cedar', name: 'Cedar Presentation', initials: 'CP', color: '#8750ab', industry: 'Fictional queue QA', provider: 'greenhouse', board: 'presentation-cedar', careerUrl: 'https://example.test/presentation/cedar' },
  { id: 'presentation-delta', name: 'Delta Presentation', initials: 'DP', color: '#4c778f', industry: 'Fictional queue QA', provider: 'greenhouse', board: 'presentation-delta', careerUrl: 'https://example.test/presentation/delta' },
]

function vacancy(company: number, id: string, title: string, cityId: 'london' | 'amsterdam'): Job {
  return publicProtocolJob(id, {
    id: `greenhouse-${companies[company].id}-${id}`, companyId: companies[company].id,
    title, cityIds: [cityId], locationLabel: cityId === 'london' ? 'London, United Kingdom' : 'Amsterdam, Netherlands',
    fetchedAt: PRESENTATION_TIME, url: `https://example.test/presentation/${companies[company].id}/${id}`,
    description: 'Authored fictional software vacancy for presentation scheduling review.',
  })
}
const arrivals: Job[][] = [
  [
    vacancy(0, 'london-alpha', 'Backend Engineer — Aster London Alpha', 'london'),
    vacancy(0, 'london-beta', 'Backend Engineer — Aster London Beta', 'london'),
    vacancy(0, 'amsterdam', 'Backend Engineer — Aster Amsterdam', 'amsterdam'),
  ],
  [
    vacancy(1, 'london', 'Backend Engineer — Birch London', 'london'),
    vacancy(1, 'amsterdam', 'Backend Engineer — Birch Amsterdam', 'amsterdam'),
  ],
  [
    vacancy(2, 'london', 'Backend Engineer — Cedar London Latest', 'london'),
    vacancy(3, 'london', 'Backend Engineer — Delta London Latest', 'london'),
    vacancy(3, 'amsterdam', 'Backend Engineer — Delta Amsterdam Latest', 'amsterdam'),
  ],
]
export const PRESENTATION_EXPECTED = {
  jobs: [3, 5, 8],
  londonCompanies: [1, 2, 4],
  londonJobs: [2, 3, 5],
  amsterdamCompanies: [1, 2, 3],
  amsterdamJobs: [1, 2, 3],
  // Aster, Birch and Delta each have jobs in BOTH cities: the final union is
  // four companies, despite city counts summing to seven and eight total jobs.
  clusterCompanies: [1, 2, 4],
  completed: [1, 2, 4],
  londonNames: [
    ['Aster Presentation'],
    ['Aster Presentation', 'Birch Presentation'],
    ['Aster Presentation', 'Birch Presentation', 'Cedar Presentation', 'Delta Presentation'],
  ],
} as const

export function presentationCatalog(stage: 1 | 2 | 3 = 1, options: { expiringAster?: boolean; complete?: boolean } = {}): Catalog {
  const jobs = structuredClone(arrivals.slice(0, stage).flat())
  if (options.expiringAster) {
    // Fixed, explicit expiry at 09:02:00.001 on the test day, after the allowed
    // exactly-24-hour boundary and well after initial map
    // setup. Newer Birch/Cedar/Delta jobs retain the original current-day time.
    for (const job of jobs) if (job.companyId === 'presentation-aster')
      job.fetchedAt = '2026-09-26T09:02:00.000Z'
  }
  const boardTotals = stage === 1 ? [3, 0, 0, 0] : stage === 2 ? [3, 2, 0, 0] : [3, 2, 1, 2]
  return {
    source: 'public', fetchedAt: PRESENTATION_TIME, checkedAt: PRESENTATION_TIME,
    refreshAfter: '2026-09-27T08:59:59.000Z', stale: false, unmappedCount: 0,
    companies: structuredClone(companies),
    cities: structuredClone(PUBLIC_TEST_CITIES.filter(city => city.id === 'london' || city.id === 'amsterdam')),
    jobs,
    boards: companies.map((company, index) => ({
      companyId: company.id, provider: 'greenhouse', board: company.board!,
      // A completed HTTP 200 response may contain valid empty boards, but
      // never pending ones. Streaming snapshots retain their pending boards.
      status: boardTotals[index] || options.complete ? 'ok' : 'pending',
      dataStatus: boardTotals[index] || options.complete ? 'fresh' : 'unavailable',
      total: boardTotals[index], included: boardTotals[index],
      lastSuccessAt: boardTotals[index] || options.complete ? PRESENTATION_TIME : null,
      ...(boardTotals[index] || options.complete ? { checkedAt: PRESENTATION_TIME } : {}),
    })),
  }
}
export function presentationSnapshot(options: { expiringAster?: boolean } = {}): CatalogCollectionSnapshot {
  return {
    catalog: presentationCatalog(1, options),
    progress: { id: PRESENTATION_COLLECTION, revision: 1, total: 4, completed: 1, done: false },
  }
}
export function presentationUpdate(stage: 2 | 3, options: { expiringAster?: boolean } = {}): CatalogCollectionUpdate {
  const { companies: _companies, cities: _cities, jobs: _jobs, ...catalog } = presentationCatalog(stage, options)
  return {
    progress: { id: PRESENTATION_COLLECTION, revision: stage, total: 4, completed: stage === 2 ? 2 : 4, done: stage === 3 },
    companyIds: stage === 2 ? ['presentation-birch'] : ['presentation-cedar', 'presentation-delta'],
    jobs: structuredClone(arrivals[stage - 1]),
    catalog,
  }
}
