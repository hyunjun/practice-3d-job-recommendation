import type { Job } from '../../shared/types'
import { BoardFetchError, parseRetryAfter } from '../catalog-service'
import type { BoardResult } from '../catalog-service'

export const BOARD_TIMEOUT = 25000
export const MAX_POSTINGS = 20000

export async function fetchBoardJson(url: string, signal: AbortSignal): Promise<unknown> {
  const response = await fetch(url, {
    signal, headers: { Accept: 'application/json', 'User-Agent': 'OrbitCareerAtlas/1.0 (local career explorer)' },
  })
  if (!response.ok) throw new BoardFetchError(`HTTP ${response.status}`, parseRetryAfter(response.headers.get('Retry-After'), Date.now()))
  try { return await response.json() }
  catch { throw new BoardFetchError('게시판 응답 형식을 확인하지 못했어요.') }
}

export function includedJobs(normalized: (Job | null)[], total: number, publishedIds?: string[]): BoardResult {
  const jobs = normalized.filter((job): job is Job => job !== null)
  const unmappedCount = jobs.filter(job => job.workMode !== 'remote' && !job.cityIds.length).length
  return { jobs: jobs.filter(job => job.workMode === 'remote' || job.cityIds.length > 0), total, unmappedCount, ...(publishedIds ? { publishedIds } : {}) }
}
