import { expect, test as base } from '@playwright/test'
import { watchApiRequests } from './api-requests'

/** Source UI fixtures run against an owned app and never visit provider hosts. */
export const sourceUiTest = base.extend<{ sourcePrivacy: void }>({
  sourcePrivacy: [async ({ page, baseURL }, use) => {
    if (!baseURL) throw new Error('Source UI verification requires an isolated app URL')
    const origin = new URL(baseURL)
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname) || origin.port === '8787')
      throw new Error('Source UI verification requires an owned loopback port outside8787')
    const external: string[] = [], errors: string[] = []
    const traffic = watchApiRequests(page)
    page.on('pageerror', error => errors.push(error.message))
    await page.route('**/*', route => {
      if (new URL(route.request().url()).origin === origin.origin) return route.fallback()
      external.push(route.request().url())
      return route.abort('blockedbyclient')
    })
    await use()
    expect(external).toEqual([])
    expect(errors).toEqual([])
    for (const request of traffic.requests) {
      const url = new URL(request.url)
      expect(url.origin).toBe(origin.origin)
      expect(['/api/catalog', '/api/catalog/progress', '/api/posting-status', '/api/observations']).toContain(url.pathname)
      expect(request.method).toBe('GET')
      expect(request.body).toBeNull()
    }
  }, { auto: true }],
})
