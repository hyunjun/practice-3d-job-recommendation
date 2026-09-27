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

/** Public HTML only; never execute scripts or download page dependencies. */
export async function fetchBoardText(url: string, signal: AbortSignal): Promise<string> {
  const response = await fetch(url, {
    signal, headers: { Accept: 'text/html', 'User-Agent': 'OrbitCareerAtlas/1.0 (local career explorer)' },
  })
  if (!response.ok) throw new BoardResponseError(response.status, parseRetryAfter(response.headers.get('Retry-After'), Date.now()))
  if (response.url && new URL(response.url).origin !== new URL(url).origin) {
    throw new BoardFetchError('공식 채용 페이지가 다른 사이트로 이동했어요.')
  }
  const maxBytes = 8 * 1024 * 1024
  if (Number(response.headers.get('content-length')) > maxBytes) {
    await response.body?.cancel()
    throw new BoardFetchError('공식 채용 페이지가 수집 크기 제한을 넘었어요.')
  }
  const chunks: Uint8Array[] = []
  let bytes = 0
  if (!response.body) throw new BoardFetchError('공식 채용 페이지의 본문이 없어요.')
  const reader = response.body.getReader()
  try {
    while (true) {
      const part = await reader.read()
      if (part.done) break
      bytes += part.value.byteLength
      if (bytes > maxBytes) {
        await reader.cancel()
        throw new BoardFetchError('공식 채용 페이지가 수집 크기 제한을 넘었어요.')
      }
      chunks.push(part.value)
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))
  } finally { reader.releaseLock() }
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
