import type { Catalog, Job } from '../../shared/types'
import type { CatalogCollectionSnapshot, CatalogCollectionUpdate } from '../../shared/catalog-progress'
import { SEARCH_COMPANIES, SEARCH_PROFILE, searchCatalog, searchJob } from './search-catalog'

export const REVALIDATION_TIME = '2026-09-20T08:00:00.000Z'
export const REVALIDATION_COMPANIES = SEARCH_COMPANIES
export const REVALIDATION_PROFILE = {
  ...SEARCH_PROFILE, name: 'PRIVATE_REVALIDATION_48', linkedinUrl: 'https://www.linkedin.com/in/private-revalidation48',
}
export const REVALIDATION_EXPLORATION = {
  source: 'public', selectedId: 'london', panelTab: 'cities', mapMode: 'flat', citySort: 'salary', light: false,
  filters: {
    query: 'Backend', region: 'europe', role: 'backend', workMode: 'onsite', visa: 'yes',
    employment: 'fulltime', postingType: 'opening', salaryMin: 100000,
    includeUnknownSalary: false, remoteEligibleOnly: true,
  },
}
export const REVALIDATION_COLLECTION_ID = '00000000-0000-4000-8000-000000000048'

export function revalidationJob(label: string, overrides: Partial<Job> = {}): Job {
  return searchJob(label, {
    fetchedAt: REVALIDATION_TIME, title: `Backend Engineer ${label}`, ...overrides,
  })
}

/** Fictional wire data only; expected request counts, titles and eligibility stay literal in tests. */
export function revalidationCatalog(jobs: Job[] = [revalidationJob('Initial48')], time = REVALIDATION_TIME): Catalog {
  const catalog = searchCatalog(jobs)
  return {
    ...catalog, fetchedAt: time, checkedAt: time,
    boards: catalog.boards.map(board => ({
      ...board, fetchedAt: time, lastSuccessAt: time, checkedAt: time,
    })),
  }
}

export function revalidationPartial(time: string): CatalogCollectionSnapshot {
  const catalog = revalidationCatalog([revalidationJob('Early48', { fetchedAt: time })], time)
  catalog.boards[1] = {
    companyId: 'search-fixture-b', provider: 'greenhouse', board: 'search-fixture-b',
    status: 'pending', dataStatus: 'unavailable', lastSuccessAt: null, total: 0, included: 0,
  }
  return { catalog, progress: { id: REVALIDATION_COLLECTION_ID, revision: 1, total: 2, completed: 1, done: false } }
}

export function revalidationDelta(time: string): CatalogCollectionUpdate {
  const full = revalidationCatalog([
    revalidationJob('Early48', { fetchedAt: time }),
    revalidationJob('Later48', { companyId: 'search-fixture-b', fetchedAt: time }),
  ], time)
  const { companies: _companies, cities: _cities, jobs, ...catalog } = full
  return {
    progress: { id: REVALIDATION_COLLECTION_ID, revision: 2, total: 2, completed: 2, done: true },
    companyIds: ['search-fixture-b'], jobs: [jobs[1]], catalog,
  }
}
