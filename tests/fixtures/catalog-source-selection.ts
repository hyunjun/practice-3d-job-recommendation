import { DEFAULT_FILTERS } from '../../shared/types'
import { SEARCH_COMPANIES, SEARCH_PROFILE, searchJob } from './search-catalog'
import { revalidationCatalog } from './catalog-revalidation'
import type { CatalogCollectionSnapshot, CatalogCollectionUpdate } from '../../shared/catalog-progress'

export const SOURCE_TIME = '2026-09-20T08:00:00.000Z'
export const SOURCE_NOTE = 'PRIVATE_SOURCE_49_NOTE 기존 지원 기록 유지 🌱'
export const SOURCE_PROFILE = {
  ...SEARCH_PROFILE, name: 'PRIVATE_SOURCE_49', linkedinUrl: 'https://www.linkedin.com/in/private-source49',
}
export const SOURCE_EXPLORATION = {
  source: 'sample', selectedId: 'london', panelTab: 'cities', mapMode: 'flat', citySort: 'salary', light: false,
  filters: {
    ...DEFAULT_FILTERS, query: 'Engineer', region: 'europe', role: 'backend', workMode: 'onsite',
    visa: 'yes', employment: 'fulltime', salaryMin: 100000, includeUnknownSalary: false,
  },
}
export const SOURCE_SAVED = [{
  job: searchJob('Saved49', { fetchedAt: SOURCE_TIME }), company: SEARCH_COMPANIES[0],
  savedAt: '2026-09-19T08:00:00.000Z', status: 'applied', note: SOURCE_NOTE,
}]
export const SOURCE_COLLECTION_ID = '00000000-0000-4000-8000-000000000049'

/** Fictional HTTP input only; visible company/job counts and request oracles are literal in the E2E. */
export function sourceCatalog() {
  return revalidationCatalog([
    searchJob('First49', { fetchedAt: SOURCE_TIME }),
    searchJob('Second49', { fetchedAt: SOURCE_TIME }),
    searchJob('Berlin49', { companyId: 'search-fixture-b', cityIds: ['berlin'], locationLabel: 'Berlin', fetchedAt: SOURCE_TIME }),
  ], SOURCE_TIME)
}

export function sourcePartial(): CatalogCollectionSnapshot {
  const catalog = sourceCatalog()
  catalog.jobs = catalog.jobs.slice(0, 2)
  catalog.boards[1] = {
    companyId: 'search-fixture-b', board: 'search-fixture-b', provider: 'greenhouse',
    status: 'pending', dataStatus: 'unavailable', lastSuccessAt: null, total: 0, included: 0,
  }
  return { catalog, progress: { id: SOURCE_COLLECTION_ID, revision: 1, total: 2, completed: 1, done: false } }
}

export function sourceDelta(): CatalogCollectionUpdate {
  const { companies: _companies, cities: _cities, jobs, ...catalog } = sourceCatalog()
  return {
    progress: { id: SOURCE_COLLECTION_ID, revision: 2, total: 2, completed: 2, done: true },
    companyIds: ['search-fixture-b'], jobs: [jobs[2]], catalog,
  }
}
