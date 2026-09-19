import path from 'node:path'
import { PUBLIC_COMPANIES } from '../shared/companies'
import type { Company } from '../shared/types'
import { createFileBoardCache } from './board-cache'
import { BoardFetchError, createCatalogService, parseRetryAfter } from './catalog-service'
import type { BoardResult } from './catalog-service'
import { normalizeJob } from './normalize'
import type { GreenhouseJob } from './normalize'

export async function fetchGreenhouseBoard(company: Company, fetchedAt: string): Promise<BoardResult> {
  const response = await fetch(`https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(company.board!)}/jobs?content=true`, {
    signal: AbortSignal.timeout(18000),
    headers: { Accept: 'application/json', 'User-Agent': 'OrbitCareerAtlas/1.0 (local career explorer)' },
  })
  if (!response.ok) throw new BoardFetchError(`HTTP ${response.status}`, parseRetryAfter(response.headers.get('Retry-After'), Date.now()))
  const payload = await response.json() as { jobs?: GreenhouseJob[] }
  if (!payload || !Array.isArray(payload.jobs)) throw new BoardFetchError('예상하지 못한 게시판 응답')
  if (payload.jobs.some(job => !job || typeof job.id !== 'number' || typeof job.title !== 'string' || typeof job.absolute_url !== 'string')) {
    throw new BoardFetchError('공고의 필수 정보가 누락된 게시판 응답')
  }
  const normalized = payload.jobs.map(job => normalizeJob(job, company.id, fetchedAt)).filter(job => job !== null)
  const unmappedCount = normalized.filter(job => job.workMode !== 'remote' && !job.cityIds.length).length
  return {
    jobs: normalized.filter(job => job.workMode === 'remote' || job.cityIds.length > 0),
    total: payload.jobs.length, unmappedCount,
  }
}

const service = createCatalogService({
  companies: PUBLIC_COMPANIES,
  cache: createFileBoardCache(path.resolve('.local/greenhouse-cache-v4.json'), path.resolve('.local/greenhouse-cache-v3.json'), PUBLIC_COMPANIES),
  fetchBoard: fetchGreenhouseBoard,
  onCacheError: error => console.warn('Public job cache could not be saved:', error instanceof Error ? error.message : error),
})

export const getPublicCatalog = (refresh = false) => service.get(refresh)
