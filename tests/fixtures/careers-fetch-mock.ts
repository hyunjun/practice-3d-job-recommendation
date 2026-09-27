import { vi } from 'vitest'
import { asCoverageReply } from './public-coverage-transport'

/** Closed response map: an unmatched URL fails instead of reaching the network. */
export function mockCareersFetch(responses: Record<string, unknown>) {
  const requests: { url: string; method: string; at: number }[] = []
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input)
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET')
    requests.push({ url, method, at: Date.now() })
    if (method !== 'GET' || init?.body != null || !Object.hasOwn(responses, url)) {
      throw new Error(`Unexpected synthetic request: ${method} ${url}`)
    }
    init?.signal?.throwIfAborted()
    const reply = asCoverageReply(responses[url])
    if (reply.failure) throw new Error(reply.failure)
    if (reply.format === 'text' && typeof reply.body !== 'string') throw new Error('Text fixture requires a string')
    return new Response(reply.format === 'text' ? reply.body as string : JSON.stringify(reply.body), {
      status: reply.status ?? 200,
      headers: { 'Content-Type': reply.format === 'text' ? 'text/html; charset=utf-8' : 'application/json', ...reply.headers },
    })
  })
  vi.stubGlobal('fetch', fetch)
  return { fetch, requests, urls: () => requests.map(request => request.url) }
}
