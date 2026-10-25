import { AsyncResource } from 'node:async_hooks'
import { BoardFetchError, parseRetryAfter } from '../catalog-service'
import type { CareerRequest } from './careers-common'
import { DAANGN_ORIGIN } from './daangn'
import { BOARD_TIMEOUT, BoardResponseError } from './http'
import { parseRobotsPolicy, robotsAllows } from './robots'
import type { RobotsPolicy } from './robots'

const MIN_INTERVAL = 3000
const MAX_REQUESTS = 310
const MAX_REDIRECTS = 3
const MAX_HTML_BYTES = 4 * 1024 * 1024
const MAX_ROBOTS_BYTES = 512 * 1024
const REDIRECTS = new Set([301, 302, 303, 307, 308])

interface ResponseContent { body?: string; location?: string; policy?: RobotsPolicy }
interface Waiting {
  signal: AbortSignal
  interval: number
  run: () => Promise<ResponseContent>
  resolve: (value: ResponseContent) => void
  reject: (cause: unknown) => void
  cancel: () => void
}
export interface DaangnSession {
  request: CareerRequest
  close: () => Promise<void>
  requestCount: () => number
}

function allowedUrl(value: string, kind: 'robots' | 'page', base = DAANGN_ORIGIN): URL {
  let url: URL
  try { url = new URL(value, base) } catch { throw new BoardFetchError('당근 공개 페이지의 주소가 올바르지 않아요.') }
  const allowedPath = kind === 'robots' ? url.pathname === '/robots.txt'
    : url.pathname === '/jobs/' || /^\/jobs\/role\/[1-9]\d{0,29}\/$/.test(url.pathname)
  if (url.origin !== DAANGN_ORIGIN || !allowedPath || url.username || url.password || url.search || url.hash) {
    throw new BoardFetchError('당근 수집 범위 밖의 주소로 이동할 수 없어요.')
  }
  return url
}

function cancellationFailure(cause: unknown, primary?: unknown): BoardFetchError {
  const error = primary instanceof BoardResponseError
    ? new BoardResponseError(primary.status, primary.retryAfter)
    : primary instanceof BoardFetchError
      ? new BoardFetchError(primary.message, primary.retryAfter)
      : new BoardFetchError('당근 공개 응답의 취소를 정상적으로 마치지 못했어요.')
  error.cause = primary === undefined ? cause : new AggregateError([primary, cause], 'Response and cancellation failed')
  return error
}

async function discard(body: ReadableStream<Uint8Array> | null, primary?: BoardFetchError): Promise<void> {
  try { await body?.cancel() }
  catch (cause) { throw cancellationFailure(cause, primary) }
}

async function readText(response: Response, signal: AbortSignal, maximum: number): Promise<string> {
  if (Number(response.headers.get('content-length')) > maximum) {
    const error = new BoardFetchError('당근 공개 응답이 수집 크기 한도를 넘었어요.')
    await discard(response.body, error)
    throw error
  }
  if (!response.body) throw new BoardFetchError('당근 공개 응답의 본문이 없어요.')
  const reader = response.body.getReader()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  const chunks: string[] = []
  let bytes = 0
  let complete = false
  let primary: unknown
  let cancellation: Promise<void> | undefined
  const cancel = (): Promise<void> => {
    // Abort and finally share the same operation, including a rejected cancel.
    cancellation ??= (async () => { await reader.cancel(signal.reason) })()
    return cancellation
  }
  const onAbort = () => { void cancel().catch(() => undefined) }
  signal.addEventListener('abort', onAbort, { once: true })
  try {
    while (true) {
      signal.throwIfAborted()
      const part = await reader.read()
      signal.throwIfAborted()
      if (part.done) { complete = true; break }
      bytes += part.value.byteLength
      if (bytes > maximum) throw new BoardFetchError('당근 공개 응답이 수집 크기 한도를 넘었어요.')
      chunks.push(decoder.decode(part.value, { stream: true }))
    }
    chunks.push(decoder.decode())
    return chunks.join('')
  } catch (cause) {
    primary = cause
    throw cause
  } finally {
    signal.removeEventListener('abort', onAbort)
    try {
      if (!complete) await cancel()
      else if (cancellation) await cancellation
    } catch (cause) { throw cancellationFailure(cause, primary) }
    finally { reader.releaseLock() }
  }
}

/**
 * One host queue shared by both employers and every request class.
 * Robots and source pages are never cached across company invocations.
 */
export function createDaangnRequestFactory(options: { fetch?: typeof fetch } = {}) {
  const fetchResponse: typeof fetch = (...args) => (options.fetch ?? globalThis.fetch)(...args)
  const waiting: Waiting[] = []
  let active = false
  let lastStart: number | undefined
  let nextStart = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let cooldown: BoardFetchError | undefined

  function rejectWaiting(cause: unknown) {
    for (const item of waiting.splice(0)) {
      item.signal.removeEventListener('abort', item.cancel)
      item.reject(cause)
    }
  }

  function pump() {
    clearTimeout(timer)
    timer = undefined
    if (active || !waiting.length) return
    if (cooldown?.retryAfter && cooldown.retryAfter > Date.now()) {
      rejectWaiting(cooldown)
      return
    }
    const item = waiting[0]
    const due = Math.max(nextStart, lastStart === undefined ? 0 : lastStart + item.interval)
    if (due > Date.now()) {
      timer = setTimeout(pump, due - Date.now())
      return
    }
    waiting.shift()
    item.signal.removeEventListener('abort', item.cancel)
    if (item.signal.aborted) { item.reject(item.signal.reason); pump(); return }
    active = true
    lastStart = Date.now()
    nextStart = lastStart + item.interval
    void item.run().then(item.resolve, cause => {
      if (cause instanceof BoardResponseError && (cause.status === 429 || cause.retryAfter)) {
        const retryAfter = Math.max(cause.retryAfter ?? Date.now() + 60_000, cooldown?.retryAfter ?? 0)
        cooldown = new BoardFetchError(cause.message, retryAfter)
        cooldown.cause = cause
        rejectWaiting(cooldown)
        item.reject(cooldown)
      } else item.reject(cause)
    }).finally(() => { active = false; pump() })
  }

  function enqueue(signal: AbortSignal, interval: number, run: () => Promise<ResponseContent>): Promise<ResponseContent> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) { reject(signal.reason); return }
      // The previous caller's completion/timer can pump this item; retain its owner.
      const item: Waiting = {
        signal, interval, run: AsyncResource.bind(run, 'DaangnRequest'), resolve, reject,
        cancel() {
          const index = waiting.indexOf(item)
          if (index !== -1) waiting.splice(index, 1)
          signal.removeEventListener('abort', item.cancel)
          reject(signal.reason)
          pump()
        },
      }
      waiting.push(item)
      signal.addEventListener('abort', item.cancel, { once: true })
      pump()
    })
  }

  function createSession(parentSignal: AbortSignal): DaangnSession {
    const owner = new AbortController()
    const signal = AbortSignal.any([parentSignal, owner.signal])
    const deadline = setTimeout(() => owner.abort(new BoardFetchError('당근 공개 공고의 수집 시간이 초과됐어요.')), 900_000)
    const pending = new Set<Promise<unknown>>()
    let requests = 0
    let closed = false
    let policy: Promise<RobotsPolicy> | undefined

    async function once(url: URL, kind: 'robots' | 'page', interval: number): Promise<ResponseContent> {
      return enqueue(signal, interval, async () => {
        signal.throwIfAborted()
        if (requests >= MAX_REQUESTS) throw new BoardFetchError('당근 공개 공고의 전체 요청 한도를 넘었어요.')
        requests++
        const timeout = new AbortController()
        const timeoutId = setTimeout(() => timeout.abort(new BoardFetchError('당근 공개 응답의 조회 시간이 초과됐어요.')), BOARD_TIMEOUT)
        const requestSignal = AbortSignal.any([signal, timeout.signal])
        try {
          const response = await fetchResponse(url.href, {
            method: 'GET', redirect: 'manual', signal: requestSignal,
            headers: { Accept: kind === 'robots' ? 'text/plain' : 'text/html', 'User-Agent': 'OrbitCareerAtlas/1.0' },
          })
          if (response.redirected || response.url && response.url !== url.href) {
            const error = new BoardFetchError('당근 공개 요청이 확인되지 않은 주소로 이동했어요.')
            await discard(response.body, error)
            throw error
          }
          if (REDIRECTS.has(response.status)) {
            await discard(response.body)
            const location = response.headers.get('location')
            if (!location) throw new BoardFetchError('당근 공개 페이지의 이동 주소가 없어요.')
            return { location }
          }
          if (response.status !== 200) {
            const error = new BoardResponseError(response.status, parseRetryAfter(response.headers.get('retry-after'), Date.now()))
            await discard(response.body, error)
            throw error
          }
          const type = response.headers.get('content-type')?.toLowerCase() ?? ''
          if (kind === 'robots' ? !type.startsWith('text/plain') : !type.startsWith('text/html')) {
            const error = new BoardFetchError('당근 공개 응답의 종류를 확인하지 못했어요.')
            await discard(response.body, error)
            throw error
          }
          const body = await readText(response, requestSignal, kind === 'robots' ? MAX_ROBOTS_BYTES : MAX_HTML_BYTES)
          if (kind === 'robots') {
            const parsed = parseRobotsPolicy(body)
            // Publish pacing while this host slot is still held, even when the
            // body took longer than the previous interval to arrive.
            if (lastStart !== undefined) nextStart = Math.max(nextStart, lastStart + parsed.crawlDelayMs)
            return { body, policy: parsed }
          }
          return { body }
        } catch (cause) {
          if (cause instanceof BoardFetchError) throw cause
          const reason = requestSignal.aborted ? requestSignal.reason : undefined
          const error = reason instanceof BoardFetchError
            ? new BoardFetchError(reason.message, reason.retryAfter)
            : new BoardFetchError(requestSignal.aborted ? '당근 공개 조회가 취소됐어요.' : '당근 공개 응답을 끝까지 읽지 못했어요.')
          error.cause = cause
          throw error
        } finally {
          clearTimeout(timeoutId)
        }
      })
    }

    async function robots(): Promise<RobotsPolicy> {
      let url = allowedUrl(`${DAANGN_ORIGIN}/robots.txt`, 'robots')
      const seen = new Set<string>()
      for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
        if (seen.has(url.href)) throw new BoardFetchError('robots.txt의 이동 경로가 반복돼요.')
        seen.add(url.href)
        const response = await once(url, 'robots', MIN_INTERVAL)
        if (response.location !== undefined) {
          url = allowedUrl(response.location, 'robots', url.href)
          continue
        }
        if (!response.policy) throw new BoardFetchError('robots.txt의 접근 규칙을 확인하지 못했어요.')
        return response.policy
      }
      throw new BoardFetchError('robots.txt의 이동 횟수가 한도를 넘었어요.')
    }

    async function page(value: string): Promise<string> {
      if (closed) throw new BoardFetchError('이미 종료된 당근 수집 요청이에요.')
      signal.throwIfAborted()
      let url = allowedUrl(value, 'page')
      policy ??= robots()
      const access = await policy
      const interval = Math.max(MIN_INTERVAL, access.crawlDelayMs)
      const seen = new Set<string>()
      for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
        signal.throwIfAborted()
        if (seen.has(url.href)) throw new BoardFetchError('당근 공개 페이지의 이동 경로가 반복돼요.')
        seen.add(url.href)
        if (!robotsAllows(access, url.pathname)) throw new BoardFetchError('robots.txt에서 당근 공개 페이지의 수집을 허용하지 않아요.')
        const response = await once(url, 'page', interval)
        if (response.location !== undefined) {
          url = allowedUrl(response.location, 'page', url.href)
          continue
        }
        return response.body ?? ''
      }
      throw new BoardFetchError('당근 공개 페이지의 이동 횟수가 한도를 넘었어요.')
    }

    const request: CareerRequest = (url, requestSignal) => {
      if (requestSignal !== parentSignal && requestSignal !== signal) {
        return Promise.reject(new BoardFetchError('당근 수집 호출의 취소 범위가 일치하지 않아요.'))
      }
      const task = page(url)
      pending.add(task)
      void task.then(() => pending.delete(task), () => pending.delete(task))
      return task
    }
    return {
      request,
      requestCount: () => requests,
      async close() {
        closed = true
        clearTimeout(deadline)
        owner.abort(new BoardFetchError('당근 공개 수집 호출을 종료했어요.'))
        await Promise.allSettled([...pending])
      },
    }
  }

  return { createSession }
}
