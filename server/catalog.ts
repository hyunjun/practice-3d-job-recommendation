import type { Company, JobProvider } from '../shared/types'
import { createFileBoardCache } from './board-cache'
import { loadBoardConfiguration } from './board-config'
import { CatalogProgressGoneError, createCatalogService } from './catalog-service'
import type { BoardResult } from './catalog-service'
import { fetchAshbyBoard, fetchAshbyPresence } from './providers/ashby'
import { fetchGreenhouseBoard, fetchGreenhousePresence } from './providers/greenhouse'
import { fetchLeverBoard, fetchLeverPresence } from './providers/lever'
import { fetchSmartRecruitersBoard, fetchSmartRecruitersPresence } from './providers/smartrecruiters'
import { fetchWorkableBoard, fetchWorkablePresence } from './providers/workable'
import { fetchHimalayasBoard, fetchHimalayasPresence } from './providers/himalayas'
import { createFilePresenceCache, presenceCacheFile } from './posting-presence'
import type { PresenceResult } from './posting-presence'
import { createFileObservationCache, createObservationStore, observationCacheFile } from './catalog-observations'

export { fetchGreenhouseBoard } from './providers/greenhouse'

const providers: Record<JobProvider, (company: Company, fetchedAt: string) => Promise<BoardResult>> = {
  greenhouse: fetchGreenhouseBoard, ashby: fetchAshbyBoard, lever: fetchLeverBoard,
  smartrecruiters: fetchSmartRecruitersBoard,
  workable: fetchWorkableBoard, himalayas: fetchHimalayasBoard,
}
const presenceProviders: Record<JobProvider, (company: Company, fetchedAt: string) => Promise<PresenceResult>> = {
  greenhouse: fetchGreenhousePresence, ashby: fetchAshbyPresence, lever: fetchLeverPresence,
  smartrecruiters: fetchSmartRecruitersPresence,
  workable: fetchWorkablePresence, himalayas: fetchHimalayasPresence,
}

let service: ReturnType<typeof createCatalogService> | undefined
let initialization: Promise<void> | undefined

export function initializePublicCatalog(): Promise<void> {
  return initialization ??= loadBoardConfiguration().then(config => {
    service = createCatalogService({
      companies: config.companies,
      cache: createFileBoardCache(config.cacheFile, config.legacyCacheFiles, config.companies),
      fetchBoard: (company, fetchedAt) => providers[company.provider ?? 'greenhouse'](company, fetchedAt),
      presence: {
        cache: createFilePresenceCache(presenceCacheFile(config.cacheFile)),
        fetchBoard: (company, fetchedAt) => presenceProviders[company.provider ?? 'greenhouse'](company, fetchedAt),
      },
      observations: createObservationStore({
        companies: config.companies,
        cache: createFileObservationCache(observationCacheFile(config.cacheFile)),
      }),
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
export const getPublicPostingStatus = async (refresh = false, content = false) => {
  await initializePublicCatalog()
  return service!.getPostingStatus(refresh, content)
}
export const getPublicObservations = async () => {
  await initializePublicCatalog()
  return service!.getObservations()
}
