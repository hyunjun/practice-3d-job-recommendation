import { expect, test as base } from '@playwright/test'
import type { BrowserContext, Frame, Page, Request, Response } from '@playwright/test'
import { publicProtocolCatalog } from '../../fixtures/public-protocol'
import type { Catalog } from '../../../shared/types'

/** Asset failures are separate from each scenario's intentional API failures.
 * This fixture observes traffic without routing it, preserving real HTTP/304
 * coverage. Depend on page so the audit completes before its teardown. */
export const resourceCheckedTest = base.extend<{ nonApiResources: void }>({
  nonApiResources: [async ({ context, page }, use, testInfo) => {
    type Resource = { url: string; type: string; method: string; document: string; status?: number; error?: string }
    const failures: Resource[] = [], expectedCancellations: (Resource & { reason: string })[] = []
    const responses: Record<string, Record<string, number>> = {}
    const pages = new Map<Page, { id: number; navigation: number; listener: (frame: Frame) => void }>()
    const resources = new Map<Request, Resource>()
    const successfulAtlasReads = new Map<string, number>()
    const observePage = (target: Page) => {
      if (pages.has(target)) return
      const state = { id: pages.size + 1, navigation: 0, listener: (_frame: Frame) => {} }
      state.listener = frame => { if (frame === target.mainFrame()) state.navigation++ }
      pages.set(target, state)
      target.on('framenavigated', state.listener)
    }
    context.pages().forEach(observePage)
    context.on('page', observePage)
    const isApi = (request: Request) => new URL(request.url()).pathname.startsWith('/api/')
    const resource = (request: Request) => {
      let entry = resources.get(request)
      if (!entry) {
        let document = 'unattributed'
        // Worker/pre-frame navigation requests can have no Frame. They remain
        // audited, but cannot qualify for a same-navigation cancellation.
        try {
          const target = request.frame().page()
          observePage(target)
          const state = pages.get(target)!
          document = `${state.id}:${state.navigation}`
        } catch { /* No attribution means no cancellation exemption. */ }
        entry = {
          url: request.url(), type: request.resourceType(), method: request.method(),
          document,
        }
        resources.set(request, entry)
      }
      return entry
    }
    const started = (request: Request) => { if (!isApi(request)) resource(request) }
    const atlasKey = (entry: Resource) => `${entry.document}:${entry.url}`
    const response = (result: Response) => {
      const request = result.request()
      if (isApi(request)) return
      const type = request.resourceType(), status = result.status()
      const entry = resource(request)
      entry.status = status
      const counts = responses[type] ??= {}
      counts[String(status)] = (counts[String(status)] ?? 0) + 1
      if (status >= 400) failures.push({ ...entry })
    }
    const finished = (request: Request) => {
      if (isApi(request)) return
      const entry = resource(request)
      if (new URL(entry.url).pathname === '/earth/countries-110m.json'
        && entry.type === 'fetch' && [200, 304].includes(entry.status ?? 0)) {
        const key = atlasKey(entry)
        successfulAtlasReads.set(key, (successfulAtlasReads.get(key) ?? 0) + 1)
      }
    }
    const failed = (request: Request) => {
      if (isApi(request)) return
      failures.push({ ...resource(request), error: request.failure()?.errorText ?? 'Unknown resource failure' })
    }
    context.on('request', started)
    context.on('response', response)
    context.on('requestfinished', finished)
    context.on('requestfailed', failed)
    try {
      await use()
      for (const target of new Set([page, ...context.pages()])) {
        if (!target.isClosed()) await target.evaluate(async () => { await document.fonts.ready })
      }
    } finally {
      context.off('request', started)
      context.off('response', response)
      context.off('requestfinished', finished)
      context.off('requestfailed', failed)
      context.off('page', observePage)
      for (const [target, state] of pages) target.off('framenavigated', state.listener)
      // FlatMap/Globe abort their atlas fetch on effect cleanup. StrictMode
      // replays it in development. Require a distinct successful completion in
      // that same page navigation; never excuse an orphaned cancellation or a
      // 4xx/5xx resource merely because a later retry happened to work.
      for (let index = failures.length - 1; index >= 0; index--) {
        const entry = failures[index], key = atlasKey(entry)
        if (entry.error !== 'net::ERR_ABORTED' || entry.type !== 'fetch' || entry.method !== 'GET'
          || entry.document === 'unattributed'
          || new URL(entry.url).pathname !== '/earth/countries-110m.json'
          || (entry.status !== undefined && entry.status >= 400)
          || (successfulAtlasReads.get(key) ?? 0) < 1) continue
        successfulAtlasReads.set(key, successfulAtlasReads.get(key)! - 1)
        expectedCancellations.push({
          ...entry, reason: 'Map effect cleanup; a separate atlas read completed successfully in the same page navigation.',
        })
        failures.splice(index, 1)
      }
      await testInfo.attach('non-api-resource-audit', {
        body: Buffer.from(JSON.stringify({
          version: 1, apiPolicy: 'API failures/cancellations are checked separately by each scenario',
          responses, expectedCancellations, failures,
        }, null, 2)),
        contentType: 'application/json',
      })
    }
    expect(failures, 'Unexpected non-API resource failure; see non-api-resource-audit attachment').toEqual([])
  }, { auto: true }],
})

/** The app starts through its real public request; no local sample mode or product demo is seeded. */
export async function routePublicApp(context: BrowserContext, catalog: () => Catalog = publicProtocolCatalog) {
  const unexpected: string[] = []
  const requests: { path: string; method: string; body: string | null }[] = []
  context.on('request', request => {
    const url = new URL(request.url())
    if (url.pathname.startsWith('/api/')) requests.push({
      path: url.pathname + url.search, method: request.method(), body: request.postData(),
    })
  })
  await context.route('**/api/**', route => {
    unexpected.push(route.request().url())
    return route.abort('blockedbyclient')
  })
  await context.route('**/api/catalog?source=public*', route => {
    const url = new URL(route.request().url())
    expect(['/api/catalog?source=public', '/api/catalog?source=public&refresh=1']).toContain(url.pathname + url.search)
    expect(route.request().method()).toBe('GET')
    expect(route.request().postData()).toBeNull()
    return route.fulfill({ json: catalog() })
  })
  return { requests, unexpected }
}

export const publicAppTest = resourceCheckedTest.extend<{ syntheticPublicProtocol: void }>({
  syntheticPublicProtocol: [async ({ context }, use) => {
    const network = await routePublicApp(context)
    await use()
    expect(network.unexpected).toEqual([])
    for (const request of network.requests) {
      expect(['/api/catalog?source=public', '/api/catalog?source=public&refresh=1']).toContain(request.path)
      expect(request.method).toBe('GET')
      expect(request.body).toBeNull()
    }
  }, { auto: true }],
})

export async function expectPublicOnlyDialog(page: Page) {
  await expect(page.locator('.data-source-options')).toHaveCount(0)
  await expect(page.getByRole('button', { name: /샘플로 탐색|샘플 탐색/ })).toHaveCount(0)
  await expect(page.getByRole('dialog')).not.toContainText('가상의 공고 · 실제 회사 채용 페이지')
}

export async function readyPublic(page: Page) {
  await expect(page.getByRole('button', { name: '공개 채용', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: /샘플로 탐색|샘플 탐색/ })).toHaveCount(0)
}
