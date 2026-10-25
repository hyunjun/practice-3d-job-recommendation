import { AsyncLocalStorage } from 'node:async_hooks'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BoardFetchError } from '../../server/catalog-service'
import { createDaangnRequestFactory } from '../../server/providers/daangn-http'
import type { DaangnSession } from '../../server/providers/daangn-http'
import { DAANGN_LIST_URL, DAANGN_MARKET_URL, DAANGN_NOW, DAANGN_ROBOTS_URL } from '../fixtures/daangn-contract'
import { DAANGN_ROBOTS } from '../fixtures/daangn-wire'

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
const html = (body = '<!doctype html><html>fictional</html>', headers: Record<string, string> = {}) =>
  new Response(body, { headers: { 'Content-Type': 'text/html; charset=utf-8', ...headers } })
const robots = (text = DAANGN_ROBOTS, status = 200) =>
  new Response(text, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8' } })
const redirect = (to: string) => new Response(null, { status: 302, headers: { Location: to } })

function transport(reply: (url: string, signal: AbortSignal) => Response | Promise<Response>) {
  vi.useFakeTimers()
  vi.setSystemTime(new Date(DAANGN_NOW))
  const calls: { url: string; at: number; signal: AbortSignal }[] = []
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    expect(init?.method).toBe('GET')
    expect(init?.body).toBeUndefined()
    expect(init?.redirect).toBe('manual')
    expect(new Headers(init?.headers).get('User-Agent')).toBe('OrbitCareerAtlas/1.0')
    expect(new Headers(init?.headers).get('Accept')).toBe(url === DAANGN_ROBOTS_URL ? 'text/plain' : 'text/html')
    const signal = init!.signal!
    calls.push({ url, at: Date.now(), signal })
    return reply(url, signal)
  })
  // Both the factory injection and the global fallback are closed. No unmatched
  // request can reach a real source even if the implementation stops injecting.
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unexpected global network fallback') }))
  return { calls, fetch, factory: createDaangnRequestFactory({ fetch }) }
}
function sessionRequest(factory: ReturnType<typeof createDaangnRequestFactory>, url = DAANGN_LIST_URL) {
  const parent = new AbortController()
  const session = factory.createSession(parent.signal)
  return { session, parent, result: session.request(url, parent.signal).finally(() => session.close()) }
}
async function outcome<T>(promise: Promise<T>) {
  const pending = promise.then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error }))
  await vi.runAllTimersAsync()
  return pending
}

describe('Daangn transport access and redirect boundaries', () => {
  it('serializes simultaneous employer sessions and applies Crawl-delay to every host request', async () => {
    const h = transport(url => url === DAANGN_ROBOTS_URL ? robots('User-agent: *\nAllow: /jobs/\nCrawl-delay: 6\n') : html())
    const a = sessionRequest(h.factory), b = sessionRequest(h.factory)
    expect((await outcome(Promise.all([a.result, b.result]))).ok).toBe(true)
    expect(h.calls.map(call => call.url)).toEqual([DAANGN_ROBOTS_URL, DAANGN_ROBOTS_URL, DAANGN_LIST_URL, DAANGN_LIST_URL])
    expect(h.calls.map(call => call.at - Date.parse(DAANGN_NOW))).toEqual([0, 6000, 12000, 18000])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('ASTRA-IMPL-02 publishes a slow first robots response’s 60-second interval before another session starts', async () => {
    let firstRobots = true
    const policy = 'User-agent: *\nAllow: /jobs/\nCrawl-delay: 60\n'
    const h = transport(url => {
      if (url !== DAANGN_ROBOTS_URL) return html('fictional page')
      if (!firstRobots) return robots(policy)
      firstRobots = false
      return new Promise<Response>(resolve => { setTimeout(() => resolve(robots(policy)), 4000) })
    })
    const a = sessionRequest(h.factory), b = sessionRequest(h.factory)
    const completed = Promise.allSettled([a.result, b.result])
    try {
      await vi.advanceTimersByTimeAsync(4000)
      expect(h.calls.map(call => call.at - Date.parse(DAANGN_NOW))).toEqual([0])
      await vi.advanceTimersByTimeAsync(55_999)
      expect(h.calls.map(call => call.at - Date.parse(DAANGN_NOW))).toEqual([0])
      await vi.advanceTimersByTimeAsync(1)
      expect(h.calls.map(call => call.at - Date.parse(DAANGN_NOW))).toEqual([0, 60_000])
      const result = await outcome(completed)
      expect(result.ok).toBe(true)
      if (result.ok) expect(result.value.map(item => item.status)).toEqual(['fulfilled', 'fulfilled'])
      expect(h.calls.map(call => call.at - Date.parse(DAANGN_NOW))).toEqual([0, 60_000, 120_000, 180_000])
    } finally {
      a.parent.abort()
      b.parent.abort()
      let cleanupSettled = false
      const cleanup = Promise.allSettled([completed, a.session.close(), b.session.close()])
        .then(() => { cleanupSettled = true })
      await vi.advanceTimersByTimeAsync(30_000)
      expect(cleanupSettled).toBe(true)
      if (cleanupSettled) await cleanup
      expect(vi.getTimerCount()).toBe(0)
    }
  })

  it.each([
    '{"error":"unavailable"}',
    '\uFEFF# synthetic reverse-proxy error\n{"error":"unavailable"}\n',
    '# synthetic upstream error\n<html><body>Error: unavailable</body></html>',
    '\uFEFF# synthetic upstream error\nError message: unavailable',
  ])('ASTRA-IMPL-03 rejects a text/plain error body before visiting any job page', async text => {
    const h = transport(() => robots(text))
    expect((await outcome(sessionRequest(h.factory).result)).ok).toBe(false)
    expect(h.calls.map(call => call.url)).toEqual([DAANGN_ROBOTS_URL])
  })

  it.each(['', '\uFEFF# public comment-only robots\n', 'Sitemap: https://example.invalid/map.xml\n'])(
    'valid empty/comment/extension-only text/plain robots can authorize the page',
    async text => {
      const h = transport(url => url === DAANGN_ROBOTS_URL ? robots(text) : html('fictional page'))
      expect(await outcome(sessionRequest(h.factory).result)).toEqual({ ok: true, value: 'fictional page' })
      expect(h.calls.map(call => call.url)).toEqual([DAANGN_ROBOTS_URL, DAANGN_LIST_URL])
    },
  )

  it.each([
    'https://example.invalid/jobs/', 'http://careers.daangn.com/jobs/',
    'https://careers.daangn.com/preview/830001/', 'https://careers.daangn.com/jobs/completed',
    'https://careers.daangn.com/jobs/?page=2', 'https://careers.daangn.com/jobs/role/830001/#apply',
    'https://user:pass@careers.daangn.com/jobs/', 'https://careers.daangn.com/jobs/role/830001/apply/',
  ])('rejects an out-of-scope URL before robots or any page fetch: %s', async url => {
    const h = transport(() => { throw new Error('Must reject before transport') })
    const result = await outcome(sessionRequest(h.factory, url).result)
    expect(result.ok).toBe(false)
    expect(h.calls).toEqual([])
  })

  it.each([404, 410, 429, 500])('a robots HTTP %i cannot become an empty successful board', async status => {
    const h = transport(() => robots('Synthetic unavailable robots', status))
    expect((await outcome(sessionRequest(h.factory).result)).ok).toBe(false)
    expect(h.calls.map(call => call.url)).toEqual([DAANGN_ROBOTS_URL])
  })

  it('blocks a disallowed list without fetching it', async () => {
    const h = transport(() => robots('User-agent: *\nDisallow: /jobs/\n'))
    expect((await outcome(sessionRequest(h.factory).result)).ok).toBe(false)
    expect(h.calls.map(call => call.url)).toEqual([DAANGN_ROBOTS_URL])
  })

  it.each([
    ['external', 'https://example.invalid/jobs/', DAANGN_ROBOTS],
    ['preview', '/preview/830001/', DAANGN_ROBOTS],
    ['robots-disallowed target', '/jobs/role/830001/', 'User-agent: *\nAllow: /jobs/$\nDisallow: /jobs/role/\n'],
    ['self loop', '/jobs/', DAANGN_ROBOTS],
  ])('rejects a %s redirect before sending the target request', async (_label, target, policy) => {
    const h = transport(url => url === DAANGN_ROBOTS_URL ? robots(policy) : redirect(target))
    expect((await outcome(sessionRequest(h.factory).result)).ok).toBe(false)
    expect(h.calls.map(call => call.url)).toEqual([DAANGN_ROBOTS_URL, DAANGN_LIST_URL])
  })

  it('allows three same-origin redirects and counts/paces each hop', async () => {
    const route: Record<string, string> = {
      [DAANGN_LIST_URL]: '/jobs/role/830001/',
      [DAANGN_MARKET_URL]: '/jobs/role/830002/',
      'https://careers.daangn.com/jobs/role/830002/': '/jobs/role/830003/',
    }
    const h = transport(url => url === DAANGN_ROBOTS_URL ? robots() : route[url] ? redirect(route[url]) : html('fictional final body'))
    const call = sessionRequest(h.factory)
    expect(await outcome(call.result)).toEqual({ ok: true, value: 'fictional final body' })
    expect(call.session.requestCount()).toBe(5) // robots + initial page + three hops
    expect(h.calls.map(call => call.at - Date.parse(DAANGN_NOW))).toEqual([0, 3000, 6000, 9000, 12000])
  })

  it('rejects a fourth redirect without visiting its target', async () => {
    const h = transport(url => url === DAANGN_ROBOTS_URL ? robots() :
      redirect(url === DAANGN_LIST_URL ? '/jobs/role/830001/' : `/jobs/role/${Number(new URL(url).pathname.split('/')[3]) + 1}/`))
    const call = sessionRequest(h.factory)
    expect((await outcome(call.result)).ok).toBe(false)
    expect(call.session.requestCount()).toBe(5)
    expect(h.calls.map(call => call.url)).not.toContain('https://careers.daangn.com/jobs/role/830004/')
  })
})

describe('Daangn decoded body and owned request limits', () => {
  it.each([
    ['HTML at boundary', 'page', 4 * 1024 * 1024, true],
    ['HTML over boundary', 'page', 4 * 1024 * 1024 + 1, false],
    ['robots at boundary', 'robots', 512 * 1024, true],
    ['robots over boundary', 'robots', 512 * 1024 + 1, false],
  ] as const)('%s', async (_name, kind, size, accepted) => {
    const prefix = 'User-agent: *\nAllow: /jobs/\n#'
    const h = transport(url => url === DAANGN_ROBOTS_URL
      ? robots(kind === 'robots' ? prefix + 'x'.repeat(size - prefix.length) : DAANGN_ROBOTS)
      : html(kind === 'page' ? 'x'.repeat(size) : 'fictional'))
    expect((await outcome(sessionRequest(h.factory).result)).ok).toBe(accepted)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('cancels an oversized decoded stream even if Content-Length understates it', async () => {
    const cancel = vi.fn()
    const h = transport(url => url === DAANGN_ROBOTS_URL ? robots() : new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(4 * 1024 * 1024 + 1)) },
      cancel,
    }), { headers: { 'Content-Type': 'text/html', 'Content-Length': '1', 'Content-Encoding': 'gzip' } }))
    expect((await outcome(sessionRequest(h.factory).result)).ok).toBe(false)
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('rejects invalid UTF-8 rather than silently substituting body facts', async () => {
    const h = transport(url => url === DAANGN_ROBOTS_URL ? robots() : new Response(new Uint8Array([0xc3, 0x28]), {
      headers: { 'Content-Type': 'text/html' },
    }))
    expect((await outcome(sessionRequest(h.factory).result)).ok).toBe(false)
  })

  it.each(['application/json', 'text/plain'])('rejects a non-HTML page Content-Type %s', async type => {
    const h = transport(url => url === DAANGN_ROBOTS_URL ? robots() : new Response('fictional', {
      headers: { 'Content-Type': type },
    }))
    expect((await outcome(sessionRequest(h.factory).result)).ok).toBe(false)
  })

  it('times out and cancels a response body that never reaches EOF', async () => {
    const cancel = vi.fn()
    const h = transport(url => url === DAANGN_ROBOTS_URL ? robots() : new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode('<html>incomplete')) },
      cancel,
    }), { headers: { 'Content-Type': 'text/html' } }))
    expect((await outcome(sessionRequest(h.factory).result)).ok).toBe(false)
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(Date.now() - Date.parse(DAANGN_NOW)).toBe(28_000) // 3 seconds before the page, then its 25-second limit.
    expect(vi.getTimerCount()).toBe(0)
  })

  it('aborts a stalled fetch at 25 seconds and settles its session', async () => {
    let aborted = false
    const h = transport((_url, signal) => new Promise<Response>((_resolve, reject) => {
      signal.addEventListener('abort', () => { aborted = true; reject(signal.reason) }, { once: true })
    }))
    const result = await outcome(sessionRequest(h.factory).result)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBeInstanceOf(BoardFetchError)
    expect(aborted).toBe(true)
    expect(Date.now() - Date.parse(DAANGN_NOW)).toBe(25_000)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('propagates a 429 Retry-After across both employers without retrying the failed request', async () => {
    const h = transport(url => url === DAANGN_ROBOTS_URL ? robots() : new Response('rate limit', {
      status: 429, headers: { 'Retry-After': '120' },
    }))
    const a = sessionRequest(h.factory), b = sessionRequest(h.factory)
    const result = await outcome(Promise.allSettled([a.result, b.result]))
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.map(item => item.status)).toEqual(['rejected', 'rejected'])
      for (const item of result.value) if (item.status === 'rejected')
        expect(item.reason.retryAfter).toBe(Date.parse('2026-10-25T06:02:06.000Z'))
    }
    expect(h.calls.map(call => call.url)).toEqual([DAANGN_ROBOTS_URL, DAANGN_ROBOTS_URL, DAANGN_LIST_URL])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('closing one session aborts its active/queued work and leaves no pending owned timers', async () => {
    const h = transport((url, signal) => url === DAANGN_ROBOTS_URL ? robots() : new Promise<Response>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    }))
    const parent = new AbortController()
    const session = h.factory.createSession(parent.signal)
    const pending = Promise.allSettled([
      session.request(DAANGN_LIST_URL, parent.signal), session.request(DAANGN_MARKET_URL, parent.signal),
    ])
    await vi.advanceTimersByTimeAsync(3000)
    await session.close()
    expect((await pending).map(item => item.status)).toEqual(['rejected', 'rejected'])
    expect(h.calls.map(call => call.url)).toEqual([DAANGN_ROBOTS_URL, DAANGN_LIST_URL])
    expect(h.calls[1].signal.aborted).toBe(true)
    await expect(session.request(DAANGN_LIST_URL, parent.signal)).rejects.toBeInstanceOf(BoardFetchError)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('an already-aborted parent prevents all traffic', async () => {
    const h = transport(() => { throw new Error('Aborted work reached transport') })
    const parent = new AbortController()
    parent.abort(new Error('Synthetic parent cancellation'))
    const session = h.factory.createSession(parent.signal)
    expect((await outcome(session.request(DAANGN_LIST_URL, parent.signal).finally(() => session.close()))).ok).toBe(false)
    expect(h.calls).toEqual([])
  })

  it('bounds an oversized session by fifteen minutes and never exceeds 310 total requests', async () => {
    const h = transport(url => url === DAANGN_ROBOTS_URL ? robots() : html())
    const parent = new AbortController()
    const session: DaangnSession = h.factory.createSession(parent.signal)
    const work = (async () => {
      try {
        for (let index = 0; index < 310; index++) await session.request(DAANGN_LIST_URL, parent.signal)
      } finally { await session.close() }
    })()
    expect((await outcome(work)).ok).toBe(false)
    expect(Date.now() - Date.parse(DAANGN_NOW)).toBe(900_000)
    // With mandatory 3-second pacing, the deadline is reached before 310 starts.
    expect(h.calls.length).toBeLessThanOrEqual(300)
    expect(session.requestCount()).toBe(h.calls.length)
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('MAIN-DGN-CLOSE-1: delayed stream cancellation remains owned', () => {
  it.each(['redirect', 'http-error', 'content-type', 'content-length', 'decoded-overflow', 'parent-abort'] as const)(
    '%s cannot release the host queue or complete close before stream.cancel settles',
    async refusal => {
      let releaseCancellation!: () => void
      const cancellation = new Promise<void>(resolve => { releaseCancellation = resolve })
      const events: string[] = []
      let firstPage = true
      const h = transport(url => {
        if (url === DAANGN_ROBOTS_URL) return robots()
        if (!firstPage) { events.push('next-page:start'); return html('fictional second session') }
        firstPage = false
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(refusal === 'decoded-overflow'
              ? new Uint8Array(4 * 1024 * 1024 + 1)
              : new TextEncoder().encode('<html>fictional incomplete body'))
            // No EOF: cancel is the only way this owned body is released.
          },
          async cancel() {
            events.push('cancel:start')
            await cancellation
            events.push('cancel:end')
          },
        })
        return new Response(stream, {
          status: refusal === 'redirect' ? 302 : refusal === 'http-error' ? 503 : 200,
          headers: {
            'Content-Type': refusal === 'content-type' ? 'application/json' : 'text/html',
            ...(refusal === 'redirect' ? { Location: '/jobs/role/830001/' } : {}),
            ...(refusal === 'content-length' ? { 'Content-Length': String(4 * 1024 * 1024 + 1) } : {}),
          },
        })
      })
      const parentA = new AbortController(), parentB = new AbortController()
      const a = h.factory.createSession(parentA.signal), b = h.factory.createSession(parentB.signal)
      let requestASettled = false, closeASettled = false, requestBSettled = false
      let errorA: unknown
      const requestA = a.request(DAANGN_LIST_URL, parentA.signal).then(
        () => { requestASettled = true; events.push('a:request-settled') },
        error => { errorA = error; requestASettled = true; events.push('a:request-settled') },
      )
      const owned: Promise<unknown>[] = [requestA]
      try {
        await vi.advanceTimersByTimeAsync(3000) // robots completed; first response body is now owned.
        if (refusal === 'parent-abort') parentA.abort(new Error('Fictional caller cancellation'))
        await vi.advanceTimersByTimeAsync(0)
        expect(events).toContain('cancel:start')
        owned.push(b.request(DAANGN_LIST_URL, parentB.signal).then(
          () => { requestBSettled = true; events.push('b:request-settled') },
          () => { requestBSettled = true; events.push('b:request-rejected') },
        ))
        owned.push(a.close().then(
          () => { closeASettled = true; events.push('a:close-settled') },
          () => { closeASettled = true; events.push('a:close-rejected') },
        ))
        // Cross three normal pacing intervals while cancel is still pending.
        // A start-rate-only implementation fails here; the stream remains active.
        await vi.advanceTimersByTimeAsync(9000)
        expect(events).not.toContain('cancel:end')
        expect(requestASettled).toBe(false)
        expect(closeASettled).toBe(false)
        expect(requestBSettled).toBe(false)
        expect(h.calls.map(call => call.url)).toEqual([DAANGN_ROBOTS_URL, DAANGN_LIST_URL])

        releaseCancellation()
        await vi.advanceTimersByTimeAsync(6000)
        expect(requestASettled).toBe(true)
        expect(closeASettled).toBe(true)
        expect(requestBSettled).toBe(true)
        expect(events).toContain('b:request-settled')
        expect(events).toContain('a:close-settled')
        expect(events.indexOf('cancel:end')).toBeLessThan(events.indexOf('a:close-settled'))
        expect(events.indexOf('cancel:end')).toBeLessThan(events.indexOf('next-page:start'))
        if (refusal === 'http-error') expect(errorA).toMatchObject({ message: 'HTTP 503' })
      } finally {
        // A failed witness must never strand its own gate or fake-clock tasks.
        // Join only after a bounded advance and an explicit settled assertion.
        releaseCancellation()
        parentA.abort()
        parentB.abort()
        let cleanupSettled = false
        const cleanup = Promise.allSettled([...owned, a.close(), b.close()])
          .then(() => { cleanupSettled = true })
        await vi.advanceTimersByTimeAsync(30_000)
        expect(cleanupSettled).toBe(true)
        if (cleanupSettled) await cleanup
        expect(vi.getTimerCount()).toBe(0)
      }
    },
  )

  it.each([503, 429])('ASTRA-IMPL-01 joins rejected cancellation and retains HTTP %i, Retry-After and both causes', async status => {
    let rejectCancellation!: (error: Error) => void
    const cancellation = new Promise<void>((_resolve, reject) => { rejectCancellation = reject })
    void cancellation.catch(() => undefined) // Also observed if setup fails before cancel is reached.
    const events: string[] = []
    const h = transport(url => url === DAANGN_ROBOTS_URL ? robots() : new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode('Fictional HTTP 503 body')) },
      async cancel() {
        events.push('cancel:start')
        try { await cancellation } finally { events.push('cancel:settled') }
      },
    }), { status, headers: { 'Content-Type': 'text/html', 'Retry-After': '120' } }))
    const parent = new AbortController()
    const session = h.factory.createSession(parent.signal)
    const errors: unknown[] = []
    let requestSettled = false, closeSettled = false
    const request = session.request(DAANGN_LIST_URL, parent.signal).then(
      () => { requestSettled = true; events.push('request:success') },
      error => { requestSettled = true; errors.push(error); events.push('request:failed') },
    )
    const owned: Promise<unknown>[] = [request]
    try {
      await vi.advanceTimersByTimeAsync(3000)
      expect(events).toContain('cancel:start')
      owned.push(session.close().then(
        () => { closeSettled = true },
        error => { closeSettled = true; errors.push(error) },
      ))
      await vi.advanceTimersByTimeAsync(9000)
      expect(requestSettled).toBe(false)
      expect(closeSettled).toBe(false)
      rejectCancellation(new Error('Fictional stream cancel failed'))
      await vi.advanceTimersByTimeAsync(0)
      expect(requestSettled).toBe(true)
      expect(closeSettled).toBe(true)
      expect(events).toContain('request:failed')
      expect(events).not.toContain('request:success')
      expect(events.indexOf('cancel:settled')).toBeLessThan(events.indexOf('request:failed'))
      // The public rejection(s) must expose both failures. Do not require a
      // particular wrapper class; cause/AggregateError are legitimate contracts.
      const messages: string[] = []
      const statuses: unknown[] = []
      const seen = new Set<unknown>()
      const inspect = (value: unknown) => {
        if (seen.has(value)) return
        seen.add(value)
        if (value instanceof Error) {
          messages.push(value.message)
          if ('status' in value) statuses.push(value.status)
          inspect(value.cause)
          if (value instanceof AggregateError) for (const nested of value.errors) inspect(nested)
        }
      }
      errors.forEach(inspect)
      expect(messages).toContain(`HTTP ${status}`)
      expect(statuses).toContain(status)
      expect(messages).toContain('Fictional stream cancel failed')
      expect(errors[0]).toMatchObject({ retryAfter: Date.parse('2026-10-25T06:02:03.000Z') })
    } finally {
      rejectCancellation(new Error('Fictional stream cancel failed'))
      parent.abort()
      let cleanupSettled = false
      const cleanup = Promise.allSettled([...owned, session.close()]).then(() => { cleanupSettled = true })
      await vi.advanceTimersByTimeAsync(30_000)
      expect(cleanupSettled).toBe(true)
      if (cleanupSettled) await cleanup
      expect(vi.getTimerCount()).toBe(0)
    }
  })
})

describe('REMEDY queued caller context, pacing and abort ownership', () => {
  it('REMEDY-REPRO binds every two-company robots/list/detail call to its enqueue context', async () => {
    const context = new AsyncLocalStorage<{ companyId: string; pass: string }>()
    const observed: { companyId?: string; pass?: string; url: string; at: number }[] = []
    const h = transport(url => {
      observed.push({ ...context.getStore(), url, at: Date.now() - Date.parse(DAANGN_NOW) })
      return url === DAANGN_ROBOTS_URL ? robots() : html('fictional complete body')
    })
    const parents = [new AbortController(), new AbortController()]
    const sessions = parents.map(parent => h.factory.createSession(parent.signal))
    const owned = [
      context.run({ companyId: 'daangn', pass: 'inventory' }, async () => {
        await sessions[0].request(DAANGN_LIST_URL, parents[0].signal)
        return context.run({ companyId: 'daangn', pass: 'content' }, () =>
          sessions[0].request(DAANGN_MARKET_URL, parents[0].signal))
      }),
      context.run({ companyId: 'daangn-pay', pass: 'inventory' }, async () => {
        await sessions[1].request(DAANGN_LIST_URL, parents[1].signal)
        return context.run({ companyId: 'daangn-pay', pass: 'content' }, () =>
          sessions[1].request('https://careers.daangn.com/jobs/role/830101/', parents[1].signal))
      }),
    ]
    let completedSettled = false
    const completed = Promise.allSettled(owned).then(value => { completedSettled = true; return value })
    try {
      await vi.advanceTimersByTimeAsync(15_000)
      expect(completedSettled).toBe(true)
      expect((await completed).map(item => item.status)).toEqual(['fulfilled', 'fulfilled'])
      expect(observed).toEqual([
        { companyId: 'daangn', pass: 'inventory', url: DAANGN_ROBOTS_URL, at: 0 },
        { companyId: 'daangn-pay', pass: 'inventory', url: DAANGN_ROBOTS_URL, at: 3000 },
        { companyId: 'daangn', pass: 'inventory', url: DAANGN_LIST_URL, at: 6000 },
        { companyId: 'daangn-pay', pass: 'inventory', url: DAANGN_LIST_URL, at: 9000 },
        { companyId: 'daangn', pass: 'content', url: DAANGN_MARKET_URL, at: 12000 },
        { companyId: 'daangn-pay', pass: 'content',
          url: 'https://careers.daangn.com/jobs/role/830101/', at: 15000 },
      ])
      expect(sessions.map(session => session.requestCount())).toEqual([3, 3])
      expect(h.calls.every(call => !call.signal.aborted)).toBe(true)
    } finally {
      parents.forEach(parent => parent.abort())
      let joined = false
      const cleanup = Promise.allSettled([...owned, ...sessions.map(session => session.close())])
        .then(() => { joined = true })
      await vi.advanceTimersByTimeAsync(30_000)
      expect(joined).toBe(true)
      if (joined) await cleanup
      expect(vi.getTimerCount()).toBe(0)
    }
  })

  it('a queued caller abort sends no request and does not overwrite the surviving caller context', async () => {
    const context = new AsyncLocalStorage<string>()
    const observed: { context?: string; url: string; at: number }[] = []
    const h = transport(url => {
      observed.push({ context: context.getStore(), url, at: Date.now() - Date.parse(DAANGN_NOW) })
      return url === DAANGN_ROBOTS_URL ? robots() : html('fictional A')
    })
    const a = new AbortController(), b = new AbortController()
    const sa = h.factory.createSession(a.signal), sb = h.factory.createSession(b.signal)
    const reason = new Error('Fictional queued B cancellation')
    const pa = context.run('daangn', () => sa.request(DAANGN_LIST_URL, a.signal))
    const pb = context.run('daangn-pay', () => sb.request(DAANGN_LIST_URL, b.signal))
    let completedSettled = false
    const completed = Promise.allSettled([pa, pb]).then(value => { completedSettled = true; return value })
    try {
      context.run('daangn-pay', () => b.abort(reason))
      await vi.advanceTimersByTimeAsync(3000)
      expect(completedSettled).toBe(true)
      const results = await completed
      expect(results[0].status).toBe('fulfilled')
      expect(results[1].status).toBe('rejected')
      expect(observed).toEqual([
        { context: 'daangn', url: DAANGN_ROBOTS_URL, at: 0 },
        { context: 'daangn', url: DAANGN_LIST_URL, at: 3000 },
      ])
      expect(sb.requestCount()).toBe(0)
      expect(b.signal.reason).toBe(reason)
    } finally {
      a.abort(); b.abort()
      let joined = false
      const cleanup = Promise.allSettled([completed, sa.close(), sb.close()]).then(() => { joined = true })
      await vi.advanceTimersByTimeAsync(30_000)
      expect(joined).toBe(true)
      if (joined) await cleanup
      expect(vi.getTimerCount()).toBe(0)
    }
  })

  it('active caller cancellation keeps its original signal and lets the other context finish', async () => {
    const context = new AsyncLocalStorage<string>()
    const observed: { context?: string; url: string; at: number }[] = []
    let activeSignal: AbortSignal | undefined
    let activeReason: unknown
    const h = transport((url, signal) => {
      observed.push({ context: context.getStore(), url, at: Date.now() - Date.parse(DAANGN_NOW) })
      if (url === DAANGN_ROBOTS_URL) return robots()
      if (!activeSignal) {
        activeSignal = signal
        return new Promise<Response>((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            activeReason = signal.reason
            reject(signal.reason)
          }, { once: true })
        })
      }
      return html('fictional B remains available')
    })
    const a = new AbortController(), b = new AbortController()
    const sa = h.factory.createSession(a.signal), sb = h.factory.createSession(b.signal)
    const pa = context.run('daangn', () => sa.request(DAANGN_LIST_URL, a.signal))
    const pb = context.run('daangn-pay', () => sb.request(DAANGN_LIST_URL, b.signal))
    let completedSettled = false
    const completed = Promise.allSettled([pa, pb]).then(value => { completedSettled = true; return value })
    const reason = new Error('Fictional active A cancellation')
    try {
      await vi.advanceTimersByTimeAsync(6000)
      expect(activeSignal).toBe(h.calls[2].signal)
      a.abort(reason)
      await vi.advanceTimersByTimeAsync(3000)
      expect(completedSettled).toBe(true)
      expect((await completed).map(item => item.status)).toEqual(['rejected', 'fulfilled'])
      expect(activeSignal!.aborted).toBe(true)
      expect(activeReason).toBe(reason)
      expect(observed).toEqual([
        { context: 'daangn', url: DAANGN_ROBOTS_URL, at: 0 },
        { context: 'daangn-pay', url: DAANGN_ROBOTS_URL, at: 3000 },
        { context: 'daangn', url: DAANGN_LIST_URL, at: 6000 },
        { context: 'daangn-pay', url: DAANGN_LIST_URL, at: 9000 },
      ])
      expect(h.calls[3].signal.aborted).toBe(false)
    } finally {
      a.abort(); b.abort()
      let joined = false
      const cleanup = Promise.allSettled([completed, sa.close(), sb.close()]).then(() => { joined = true })
      await vi.advanceTimersByTimeAsync(30_000)
      expect(joined).toBe(true)
      if (joined) await cleanup
      expect(vi.getTimerCount()).toBe(0)
    }
  })
})
