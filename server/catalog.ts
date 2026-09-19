import path from 'node:path'
import { PUBLIC_COMPANIES } from '../shared/companies'
import type { Company, JobProvider } from '../shared/types'
import { createFileBoardCache } from './board-cache'
import { createCatalogService } from './catalog-service'
import type { BoardResult } from './catalog-service'
import { fetchAshbyBoard } from './providers/ashby'
import { fetchGreenhouseBoard } from './providers/greenhouse'
import { fetchLeverBoard } from './providers/lever'

export { fetchGreenhouseBoard } from './providers/greenhouse'

const providers: Record<JobProvider, (company: Company, fetchedAt: string) => Promise<BoardResult>> = {
  greenhouse: fetchGreenhouseBoard, ashby: fetchAshbyBoard, lever: fetchLeverBoard,
}

const service = createCatalogService({
  companies: PUBLIC_COMPANIES,
  cache: createFileBoardCache(path.resolve('.local/public-board-cache-v5.json'), [
    path.resolve('.local/greenhouse-cache-v4.json'), path.resolve('.local/greenhouse-cache-v3.json'),
  ], PUBLIC_COMPANIES),
  fetchBoard: (company, fetchedAt) => providers[company.provider ?? 'greenhouse'](company, fetchedAt),
  onCacheError: error => console.warn('Public job cache could not be saved:', error instanceof Error ? error.message : error),
})

export const getPublicCatalog = (refresh = false) => service.get(refresh)
export const getPublicPostingStatus = (refresh = false) => service.getPostingStatus(refresh)
