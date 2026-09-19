import { BoardFetchError } from '../catalog-service'
import { BOARD_TIMEOUT, BoardResponseError, fetchBoardJson } from './http'

interface Request {
  url: string
  signal: AbortSignal
  resolve: (value: unknown) => void
  reject: (reason: unknown) => void
  cancel: () => void
}

/** One queue per provider, shared by every company and by list/detail requests. */
export function createBoardRequestQueue({ concurrency, interval }: { concurrency: number; interval: number }) {
  const waiting: Request[] = []
  let active = 0
  let nextStart = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let cooldown: BoardFetchError | undefined

  function rejectWaiting(cause: unknown) {
    for (const request of waiting.splice(0)) {
      request.signal.removeEventListener('abort', request.cancel)
      request.reject(cause)
    }
  }

  function pump() {
    clearTimeout(timer)
    timer = undefined
    if (!waiting.length) return
    if (cooldown?.retryAfter && cooldown.retryAfter > Date.now()) {
      rejectWaiting(cooldown)
      return
    }
    while (waiting.length && active < concurrency) {
      const delay = nextStart - Date.now()
      if (delay > 0) {
        timer = setTimeout(pump, delay)
        return
      }
      const request = waiting.shift()!
      request.signal.removeEventListener('abort', request.cancel)
      if (request.signal.aborted) {
        request.reject(request.signal.reason)
        continue
      }
      active++
      nextStart = Date.now() + interval
      const signal = AbortSignal.any([request.signal, AbortSignal.timeout(BOARD_TIMEOUT)])
      void fetchBoardJson(request.url, signal).then(request.resolve, cause => {
        if (cause instanceof BoardResponseError && (cause.status === 429 || cause.retryAfter)) {
          const retryAfter = Math.max(cause.retryAfter ?? Date.now() + 60_000, cooldown?.retryAfter ?? 0)
          cooldown = new BoardFetchError(cause.message, retryAfter)
          rejectWaiting(cooldown)
          request.reject(cooldown)
        } else request.reject(cause)
      }).finally(() => { active--; pump() })
    }
  }

  return (url: string, signal: AbortSignal): Promise<unknown> => new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return }
    const request: Request = {
      url, signal, resolve, reject,
      cancel: () => {
        const index = waiting.indexOf(request)
        if (index !== -1) waiting.splice(index, 1)
        signal.removeEventListener('abort', request.cancel)
        reject(signal.reason)
        pump()
      },
    }
    waiting.push(request)
    signal.addEventListener('abort', request.cancel, { once: true })
    pump()
  })
}
