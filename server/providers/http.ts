import type { Job } from '../../shared/types'
import { isUnmappedJob } from '../../shared/job-location'
import { BoardFetchError, BoardInventoryError, parseRetryAfter } from '../catalog-service'
import type { BoardResult } from '../catalog-service'

export const BOARD_TIMEOUT = 25000
export const MAX_POSTINGS = 20000
export const MAX_BOARD_JSON_BYTES = 64 * 1024 * 1024
export const MAX_BOARD_TEXT_BYTES = 8 * 1024 * 1024

export class BoardResponseError extends BoardFetchError {
  constructor(readonly status: number, retryAfter?: number) { super(`HTTP ${status}`, retryAfter) }
}

export async function readBoardInventory<T>(read: () => Promise<T>): Promise<T> {
  try { return await read() }
  // Do not annotate a shared queue's error in place: it can also reject
  // another company's detail request, which is a different observation.
  catch (cause) { throw cause instanceof BoardInventoryError ? cause : new BoardInventoryError(cause) }
}

function discardBody(body: { cancel: () => Promise<unknown> } | null) {
  if (!body) return
  // Cleanup must not hide an HTTP/size error or wait for an unresponsive source.
  try { void body.cancel().catch(() => undefined) } catch { /* Preserve the primary error. */ }
}

function jsonReadFailure(signal: AbortSignal, cause: unknown): BoardFetchError {
  let error: BoardFetchError
  if (signal.aborted) {
    const reason: unknown = signal.reason
    if (reason instanceof BoardFetchError) {
      // A shared collection may abort sibling requests with its first failure.
      // Copy the useful message/deadline without copying its inventory phase.
      error = new BoardFetchError(reason.message.slice(0, 500) || '게시판 조회가 취소되었어요.', reason.retryAfter)
    } else {
      const timeout = reason instanceof Error && reason.name === 'TimeoutError'
      error = new BoardFetchError(timeout ? '게시판 조회 시간이 초과되었어요.' : '게시판 조회가 취소되었어요.')
    }
  } else error = new BoardFetchError('게시판 응답을 끝까지 읽지 못했어요.')
  error.cause = cause
  return error
}

async function readBody(response: Response, options: {
  maxBytes: number
  sizeMessage: string
  fatal: boolean
  readFailure?: (cause: unknown) => unknown
}): Promise<string> {
  if (!response.body) return ''
  let reader: ReadableStreamDefaultReader<Uint8Array>
  try { reader = response.body.getReader() } catch (cause) {
    discardBody(response.body)
    throw options.readFailure ? options.readFailure(cause) : cause
  }
  const decoder = new TextDecoder('utf-8', { fatal: options.fatal })
  const segments: string[] = []
  let segment = ''
  let bytes = 0
  let complete = false
  try {
    while (true) {
      let part: ReadableStreamReadResult<Uint8Array>
      try { part = await reader.read() } catch (cause) {
        throw options.readFailure ? options.readFailure(cause) : cause
      }
      if (part.done) { complete = true; break }
      bytes += part.value.byteLength
      // Fetch exposes decompressed bytes. Check before retaining or decoding
      // the excess chunk; never parse a truncated prefix as a complete feed.
      if (bytes > options.maxBytes) throw new BoardFetchError(options.sizeMessage)
      segment += decoder.decode(part.value, { stream: true })
      // Coalesce small chunks without retaining their byte buffers or making
      // a second full-body Buffer. UTF-8 characters may span transport chunks.
      if (segment.length >= 64 * 1024) { segments.push(segment); segment = '' }
    }
    segments.push(segment + decoder.decode())
    return segments.join('')
  } finally {
    if (!complete) discardBody(reader)
    reader.releaseLock()
  }
}

export async function fetchBoardJson(url: string, signal: AbortSignal): Promise<unknown> {
  const response = await fetch(url, {
    signal, headers: { Accept: 'application/json', 'User-Agent': 'OrbitCareerAtlas/1.0 (local career explorer)' },
  })
  if (!response.ok) {
    const error = new BoardResponseError(response.status, parseRetryAfter(response.headers.get('Retry-After'), Date.now()))
    discardBody(response.body)
    throw error
  }
  const text = await readBody(response, {
    maxBytes: MAX_BOARD_JSON_BYTES, sizeMessage: '게시판 응답이 수집 크기 제한을 넘었어요.',
    fatal: false, readFailure: cause => jsonReadFailure(signal, cause),
  })
  try { return JSON.parse(text) }
  catch { throw new BoardFetchError('게시판 응답 형식을 확인하지 못했어요.') }
}

/** Public HTML only; never execute scripts or download page dependencies. */
export async function fetchBoardText(url: string, signal: AbortSignal): Promise<string> {
  const response = await fetch(url, {
    signal, headers: { Accept: 'text/html', 'User-Agent': 'OrbitCareerAtlas/1.0 (local career explorer)' },
  })
  if (!response.ok) {
    const error = new BoardResponseError(response.status, parseRetryAfter(response.headers.get('Retry-After'), Date.now()))
    discardBody(response.body)
    throw error
  }
  if (response.url && new URL(response.url).origin !== new URL(url).origin) {
    discardBody(response.body)
    throw new BoardFetchError('공식 채용 페이지가 다른 사이트로 이동했어요.')
  }
  if (Number(response.headers.get('content-length')) > MAX_BOARD_TEXT_BYTES) {
    discardBody(response.body)
    throw new BoardFetchError('공식 채용 페이지가 수집 크기 제한을 넘었어요.')
  }
  if (!response.body) throw new BoardFetchError('공식 채용 페이지의 본문이 없어요.')
  return readBody(response, {
    maxBytes: MAX_BOARD_TEXT_BYTES, sizeMessage: '공식 채용 페이지가 수집 크기 제한을 넘었어요.', fatal: true,
  })
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
