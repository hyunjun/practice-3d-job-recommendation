import { afterEach, describe, expect, it, vi } from 'vitest'
import { BoardFetchError } from '../../server/catalog-service'
import { BoardResponseError } from '../../server/providers/http'
import { createBoardRequestQueue } from '../../server/providers/request-queue'
import { JSON_OVER_CAP_BYTES, JSON_SIZE_MESSAGE, paddedJsonObject } from '../fixtures/response-bounds'
import { directiveResponse, pendingStream } from '../fixtures/response-bounds-stream'

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

describe('shared provider request limits', () => {
  it('spaces requests across companies and respects the concurrent cap even when responses are slow', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const starts: number[] = []
    let active = 0
    let peak = 0
    vi.stubGlobal('fetch', vi.fn(async () => {
      starts.push(Date.now())
      peak = Math.max(peak, ++active)
      await new Promise(resolve => setTimeout(resolve, 900))
      active--
      return Response.json({ ok: true })
    }))
    const request = createBoardRequestQueue({ concurrency: 4, interval: 200 })
    const results = Promise.all(Array.from({ length: 9 }, (_, index) => request(`https://example.com/company-${index % 3}/${index}`, new AbortController().signal)))
    await vi.advanceTimersByTimeAsync(4000)
    expect(await results).toHaveLength(9)
    expect(peak).toBe(4)
    expect(starts.slice(1).every((start, index) => start - starts[index] >= 200)).toBe(true)
    expect(active).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('removes cancelled queued work without delaying or cancelling another company', async () => {
    vi.useFakeTimers()
    const fetcher = vi.fn(async (_input: string) => {
      await new Promise(resolve => setTimeout(resolve, 1000))
      return Response.json({})
    })
    vi.stubGlobal('fetch', fetcher)
    const request = createBoardRequestQueue({ concurrency: 1, interval: 200 })
    const cancelled = new AbortController()
    const results = Promise.allSettled([
      request('https://example.com/first', new AbortController().signal),
      request('https://example.com/cancelled', cancelled.signal),
      request('https://example.com/next-company', new AbortController().signal),
    ])
    cancelled.abort(new Error('collection stopped'))
    await vi.advanceTimersByTimeAsync(3000)
    expect((await results).map(result => result.status)).toEqual(['fulfilled', 'rejected', 'fulfilled'])
    expect(fetcher.mock.calls.map(call => String(call[0]))).toEqual(['https://example.com/first', 'https://example.com/next-company'])
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each([['5', 5000], [null, 60_000]] as const)('stops queued requests on 429 and honors Retry-After %s across new requests', async (header, pause) => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const fetcher = vi.fn().mockResolvedValueOnce(new Response('', { status: 429, headers: header ? { 'Retry-After': header } : {} }))
      .mockImplementation(async () => Response.json({ ok: true }))
    vi.stubGlobal('fetch', fetcher)
    const request = createBoardRequestQueue({ concurrency: 4, interval: 200 })
    const results = await Promise.allSettled(Array.from({ length: 8 }, (_, index) => request(`https://example.com/company-${index}`, new AbortController().signal)))
    expect(fetcher).toHaveBeenCalledTimes(1)
    for (const result of results) expect(result).toMatchObject({ status: 'rejected', reason: { retryAfter: pause } })
    await vi.advanceTimersByTimeAsync(pause - 1)
    await expect(request('https://example.com/too-soon', new AbortController().signal)).rejects.toMatchObject({ retryAfter: pause })
    expect(fetcher).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    await expect(request('https://example.com/after-cooldown', new AbortController().signal)).resolves.toEqual({ ok: true })
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not shorten a shared retry deadline when another active response arrives', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(new Response('', { status: 429, headers: { 'Retry-After': '600' } }))
      .mockResolvedValueOnce(new Response('', { status: 503, headers: { 'Retry-After': '1' } })))
    const request = createBoardRequestQueue({ concurrency: 2, interval: 0 })
    const results = await Promise.allSettled([
      request('https://example.com/company-a', new AbortController().signal),
      request('https://example.com/company-b', new AbortController().signal),
      request('https://example.com/company-c', new AbortController().signal),
    ])
    for (const result of results) expect(result).toMatchObject({ status: 'rejected', reason: { retryAfter: 600_000 } })
    await expect(request('https://example.com/company-d', new AbortController().signal)).rejects.toMatchObject({ retryAfter: 600_000 })
  })

  it('rejects an over-cap body for one company without inventing a cooldown and keeps the next companies on schedule', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const starts: number[] = []
    let cancelled = false
    const fetcher = vi.fn(async (input: string) => {
      starts.push(Date.now())
      if (input.endsWith('/oversize')) {
        // Well past the cap: the source is still open when the excess is observed, so cancel is invoked.
        return directiveResponse(paddedJsonObject({ ok: false }, JSON_OVER_CAP_BYTES), { onCancel: () => { cancelled = true } })
      }
      return Response.json({ ok: true })
    })
    vi.stubGlobal('fetch', fetcher)
    const request = createBoardRequestQueue({ concurrency: 1, interval: 200 })
    const results = Promise.allSettled([
      request('https://example.com/company-a/oversize', new AbortController().signal),
      request('https://example.com/company-b/list', new AbortController().signal),
      request('https://example.com/company-c/list', new AbortController().signal),
    ])
    await vi.advanceTimersByTimeAsync(2000)
    const settled = await results
    expect(settled.map(result => result.status)).toEqual(['rejected', 'fulfilled', 'fulfilled'])
    const reason = (settled[0] as PromiseRejectedResult).reason as Error
    expect(reason).toBeInstanceOf(BoardFetchError)
    expect(reason).not.toBeInstanceOf(BoardResponseError)
    expect(reason.message).toBe(JSON_SIZE_MESSAGE)
    expect((reason as BoardFetchError).retryAfter).toBeUndefined()
    expect(cancelled).toBe(true)
    expect(starts).toEqual([0, 200, 400])
    expect(fetcher).toHaveBeenCalledTimes(3)
    expect(vi.getTimerCount()).toBe(0)
  }, 60_000)

  it('discards the body of a 429 while applying the shared Retry-After cooldown unchanged', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    let cancelled = false
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(pendingStream([new TextEncoder().encode('{"error":"limited"')], { onCancel: () => { cancelled = true } }), {
        status: 429, headers: { 'Retry-After': '5', 'Content-Type': 'application/json' },
      }))
      .mockImplementation(async () => Response.json({ ok: true }))
    vi.stubGlobal('fetch', fetcher)
    const request = createBoardRequestQueue({ concurrency: 2, interval: 0 })
    await expect(request('https://example.com/company-a', new AbortController().signal)).rejects.toMatchObject({ retryAfter: 5000 })
    expect(cancelled).toBe(true)
    await expect(request('https://example.com/company-b', new AbortController().signal)).rejects.toMatchObject({ retryAfter: 5000 })
    expect(fetcher).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(5000)
    await expect(request('https://example.com/company-c', new AbortController().signal)).resolves.toEqual({ ok: true })
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(0)
  })
})
