import type { CatalogCollectionSnapshot, CatalogCollectionUpdate } from '../../shared/catalog-progress'
import type { Catalog } from '../../shared/types'
import { SEARCH_COMPANIES, SEARCH_TIME, searchCatalog, searchJob } from './search-catalog'

export const COLLECTION_ID = '00000000-0000-4000-8000-000000000016'
export function progressSnapshot(completed = 0): CatalogCollectionSnapshot {
  const jobs = SEARCH_COMPANIES.slice(0, completed).map((company, index) => searchJob(`progress-${index}`, {
    id: `greenhouse-${company.id}-progress-${index}`, companyId: company.id,
    title: `Backend Engineer — ${index ? 'LaterArrival' : 'EarlyArrival'}`, qualifications: { version: 1, skills: [], experience: [] },
  }))
  const catalog: Catalog = {
    ...searchCatalog(jobs), fetchedAt: completed ? SEARCH_TIME : '',
    boards: SEARCH_COMPANIES.map((company, index) => ({
      companyId: company.id, provider: 'greenhouse', board: company.board!,
      status: index < completed ? 'ok' : 'pending',
      dataStatus: index < completed ? 'fresh' : 'unavailable',
      total: index < completed ? 1 : 0, included: index < completed ? 1 : 0,
      lastSuccessAt: index < completed ? SEARCH_TIME : null,
      ...(index < completed ? { checkedAt: SEARCH_TIME } : {}),
    })),
  }
  return { catalog, progress: { id: COLLECTION_ID, revision: completed === 2 ? 3 : completed, total: 2, completed, done: completed === 2 } }
}

export function progressUpdate(completed: number, after = completed - 1): CatalogCollectionUpdate {
  const { catalog: full, progress } = progressSnapshot(completed)
  const companyIds = SEARCH_COMPANIES.slice(after, completed).map(company => company.id)
  const { companies: _companies, cities: _cities, jobs, ...catalog } = full
  return { progress, catalog, companyIds, jobs: jobs.filter(job => companyIds.includes(job.companyId)) }
}
