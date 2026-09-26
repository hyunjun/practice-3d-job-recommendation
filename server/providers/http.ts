import type { Job } from '../../shared/types'
import { isUnmappedJob } from '../../shared/job-location'
import { BoardFetchError, BoardInventoryError, parseRetryAfter } from '../catalog-service'
import type { BoardResult } from '../catalog-service'

export const BOARD_TIMEOUT = 25000
export const MAX_POSTINGS = 20000

export class BoardResponseError extends BoardFetchError {
  constructor(readonly status: number, retryAfter?: number) { super(`HTTP ${status}`, retryAfter) }
}

export async function readBoardInventory<T>(read: () => Promise<T>): Promise<T> {
  try { return await read() }
  // Do not annotate a shared queue's error in place: it can also reject
  // another company's detail request, which is a different observation.
  catch (cause) { throw cause instanceof BoardInventoryError ? cause : new BoardInventoryError(cause) }
}

export async function fetchBoardJson(url: string, signal: AbortSignal): Promise<unknown> {
  const response = await fetch(url, {
    signal, headers: { Accept: 'application/json', 'User-Agent': 'OrbitCareerAtlas/1.0 (local career explorer)' },
  })
  if (!response.ok) throw new BoardResponseError(response.status, parseRetryAfter(response.headers.get('Retry-After'), Date.now()))
  try { return await response.json() }
  catch { throw new BoardFetchError('게시판 응답 형식을 확인하지 못했어요.') }
}

export function assertUniquePostingIds(postings: readonly { id: string | number }[]): void {
  const ids = new Set<string | number>()
  for (const { id } of postings) {
    if (ids.has(id)) throw new BoardFetchError('게시판의 공고 목록이 중복되어 전체 조회를 확인하지 못했어요.')
    ids.add(id)
  }
}

export function includedJobs(normalized: (Job | null)[], total: number, publishedIds?: string[]): BoardResult {
  const jobs = normalized.filter((job): job is Job => job !== null)
  const unmappedCount = jobs.filter(isUnmappedJob).length
  return { jobs, total, unmappedCount, ...(publishedIds ? { publishedIds } : {}) }
}
