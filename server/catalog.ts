import type { Company, JobProvider } from '../shared/types'
import { createFileBoardCache } from './board-cache'
import { loadBoardConfiguration } from './board-config'
import { CatalogProgressGoneError, createCatalogService } from './catalog-service'
import type { BoardResult } from './catalog-service'
import { fetchAshbyBoard } from './providers/ashby'
import { fetchGreenhouseBoard } from './providers/greenhouse'
import { fetchLeverBoard } from './providers/lever'
import { fetchSmartRecruitersBoard } from './providers/smartrecruiters'

export { fetchGreenhouseBoard } from './providers/greenhouse'

const providers: Record<JobProvider, (company: Company, fetchedAt: string) => Promise<BoardResult>> = {
  greenhouse: fetchGreenhouseBoard, ashby: fetchAshbyBoard, lever: fetchLeverBoard,
  smartrecruiters: fetchSmartRecruitersBoard,
}

let service: ReturnType<typeof createCatalogService> | undefined
let initialization: Promise<void> | undefined

export function initializePublicCatalog(): Promise<void> {
  return initialization ??= loadBoardConfiguration().then(config => {
    service = createCatalogService({
      companies: config.companies,
      cache: createFileBoardCache(config.cacheFile, config.legacyCacheFiles, config.companies),
      fetchBoard: (company, fetchedAt) => providers[company.provider ?? 'greenhouse'](company, fetchedAt),
      onCacheError: error => console.warn('Public job cache could not be saved:', error instanceof Error ? error.message : error),
    })
  })
}

export const getPublicCatalog = async (refresh = false) => {
  await initializePublicCatalog()
  return service!.get(refresh)
}
export const getProgressivePublicCatalog = async (refresh = false) => {
  await initializePublicCatalog()
  return service!.getProgressive(refresh)
}
export const getPublicCatalogProgress = (id: string, after: number) => {
  if (!service) throw new CatalogProgressGoneError()
  return service.readProgress(id, after)
}
export const getPublicPostingStatus = async (refresh = false) => {
  await initializePublicCatalog()
  return service!.getPostingStatus(refresh)
}
