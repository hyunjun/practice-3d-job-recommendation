import type { Catalog, Job } from './types'

/** Counts settled company requests, including failures; this is not a time estimate. */
export interface CatalogProgress {
  id: string
  revision: number
  total: number
  completed: number
  done: boolean
}

export interface CatalogCollectionSnapshot {
  catalog: Catalog
  progress: CatalogProgress
}

/** Replace whole company results only after that company's full feed is validated. */
export interface CatalogCollectionUpdate {
  progress: CatalogProgress
  companyIds: string[]
  jobs: Job[]
  catalog: Omit<Catalog, 'companies' | 'cities' | 'jobs'>
}

export function applyCatalogUpdate(previous: Catalog, update: CatalogCollectionUpdate): Catalog {
  const replaced = new Set(update.companyIds)
  const boards = new Map(update.catalog.boards.map(board => [board.companyId, board]))
  const grouped = new Map<string, Job[]>()
  const jobs = [...previous.jobs.filter(job => !replaced.has(job.companyId)), ...update.jobs]
    .filter(job => boards.get(job.companyId)?.dataStatus !== 'unavailable')
    .map(job => {
      const stale = boards.get(job.companyId)?.dataStatus === 'stale'
      return Boolean(job.stale) === stale ? job : { ...job, stale }
    })
  for (const job of jobs) {
    const group = grouped.get(job.companyId) ?? []
    group.push(job)
    grouped.set(job.companyId, group)
  }
  return { ...previous, ...update.catalog, jobs: previous.companies.flatMap(company => grouped.get(company.id) ?? []) }
}
