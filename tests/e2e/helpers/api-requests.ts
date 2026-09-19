import { expect } from '@playwright/test'
import type { APIRequestContext, Page, Request } from '@playwright/test'

interface ApiRequest {
  url: string
  method: string
  body: string | null
  state: 'pending' | 'finished' | 'failed'
  status: number | null
  error: string | null
}

/** Keep canceled attempts too, so privacy and unexpected-request checks cover all traffic. */
export function watchApiRequests(page: Page) {
  const requests: ApiRequest[] = []
  const records = new Map<Request, ApiRequest>()
  page.on('request', request => {
    if (!new URL(request.url()).pathname.startsWith('/api/')) return
    const record: ApiRequest = {
      url: request.url(), method: request.method(), body: request.postData(),
      state: 'pending', status: null, error: null,
    }
    records.set(request, record)
    requests.push(record)
  })
  page.on('response', response => {
    const record = records.get(response.request())
    if (record) record.status = response.status()
  })
  page.on('requestfinished', request => {
    const record = records.get(request)
    if (record) record.state = 'finished'
  })
  page.on('requestfailed', request => {
    const record = records.get(request)
    if (record) { record.state = 'failed'; record.error = request.failure()?.errorText ?? null }
  })
  return { requests, catalog: () => requests.filter(request => new URL(request.url).pathname === '/api/catalog') }
}

export async function readServerMode(request: APIRequestContext, url: string) {
  // APIRequestContext traffic is separate from the page's application requests.
  const response = await request.get(url)
  try {
    expect(response.status()).toBe(200)
    const { mode } = await response.json()
    expect(['development', 'production']).toContain(mode)
    return mode as 'development' | 'production'
  } finally {
    await response.dispose()
  }
}

export async function expectInitialCatalogRequest(page: Page, traffic: ReturnType<typeof watchApiRequests>) {
  const mode = await readServerMode(page.request, new URL('/api/health', page.url()).href)
  await expect.poll(() => ({
    finished: traffic.catalog().filter(request => request.state === 'finished').length,
    pending: traffic.catalog().filter(request => request.state === 'pending').length,
  })).toEqual({ finished: 1, pending: 0 })
  const requests = traffic.catalog()
  const finished = requests.filter(request => request.state === 'finished')
  const failed = requests.filter(request => request.state === 'failed')
  for (const request of requests) {
    expect(request.url).toBe(new URL('/api/catalog?source=public', page.url()).href)
    expect(request.method).toBe('GET')
    expect(request.body).toBeNull()
  }
  expect([200, 202]).toContain(finished[0].status)
  expect(finished[0].error).toBeNull()
  // StrictMode replays Effects in development. Only its canceled first attempt
  // is allowed; an extra completed request or any other failure still fails.
  expect(failed.length).toBeLessThanOrEqual(mode === 'development' ? 1 : 0)
  for (const request of failed) expect(request.error).toBe('net::ERR_ABORTED')
  expect(requests.map(request => request.state)).toEqual(failed.length ? ['failed', 'finished'] : ['finished'])
  return { mode, attempts: requests.length, cancelled: failed.length }
}
