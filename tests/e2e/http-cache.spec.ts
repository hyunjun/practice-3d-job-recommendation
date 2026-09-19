import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import express from 'express'
import { createApiRouter } from '../../server/http'
import { CatalogUnavailableError } from '../../server/catalog-service'
import type { Catalog } from '../../shared/types'
import type { PostingStatusIndex } from '../../shared/posting-status'
import { serveHttp } from '../fixtures/http-server'
import { SEARCH_COMPANIES, SEARCH_TIME, searchCatalog, searchJob } from '../fixtures/search-catalog'

// Browser routing disables the HTTP cache. Use a real loopback server and record
// its wire status; fetch exposes a revalidated 304 as a usable 200 response.
async function fixture() {
  let catalog: Catalog = searchCatalog([searchJob('http-cache', {
    description: '한국어 공고 원문과 software engineering requirements.\n'.repeat(100),
  })])
  let index: PostingStatusIndex = {
    version: 1, checkedAt: SEARCH_TIME, refreshAfter: '2026-09-19T08:01:00.000Z',
    boards: [{
      companyId: SEARCH_COMPANIES[0].id, provider: 'greenhouse', board: SEARCH_COMPANIES[0].board!,
      checkedAt: SEARCH_TIME, lastSuccessAt: SEARCH_TIME, retryAt: null, status: 'ok',
      listing: { validUntil: '2026-09-19T08:30:00.000Z', publishedIds: [catalog.jobs[0].id], jobs: [] },
    }],
  }
  let catalogError = false
  let postingError = false
  const calls = { catalog: [] as boolean[], posting: [] as boolean[] }
  const responses: { path: string; status: number; ifNoneMatch?: string; encoding?: string; cacheControl?: string }[] = []
  const app = express()
  app.use((request, response, next) => {
    if (request.path.startsWith('/api/')) response.on('finish', () => responses.push({
      path: request.originalUrl, status: response.statusCode, ifNoneMatch: request.headers['if-none-match'],
      encoding: response.getHeader('Content-Encoding') as string | undefined,
      cacheControl: response.getHeader('Cache-Control') as string | undefined,
    }))
    next()
  })
  app.get('/', (_request, response) => response.type('html').send('<!doctype html><html lang="ko"><title>HTTP cache verification</title><body>HTTP cache verification</body></html>'))
  app.use('/api', createApiRouter({
    getCatalog: async refresh => {
      calls.catalog.push(refresh)
      if (catalogError) throw new CatalogUnavailableError('공고 조회 실패', new Date(Date.now() + 60_000).toISOString(), 'CATALOG_EXPIRED')
      return catalog
    },
    getPostingStatus: async refresh => {
      calls.posting.push(refresh)
      if (postingError) throw new Error('게시판 조회 실패')
      return index
    },
  }))
  return {
    ...await serveHttp(app), calls, responses,
    get catalog() { return catalog },
    set catalog(value: Catalog) { catalog = value },
    get index() { return index },
    set index(value: PostingStatusIndex) { index = value },
    get catalogError() { return catalogError },
    set catalogError(value: boolean) { catalogError = value },
    get postingError() { return postingError },
    set postingError(value: boolean) { postingError = value },
  }
}

async function fetchJson(page: Page, path: string) {
  return page.evaluate(async path => {
    try {
      const response = await fetch(path)
      return { status: response.status, data: await response.json(), failed: false }
    } catch {
      return { status: 0, data: null, failed: true }
    }
  }, path)
}

test('the browser revalidates public data and receives changed, expired and empty results without reusing old jobs', async ({ page }) => {
  const server = await fixture()
  try {
    await page.goto(server.origin)
    const path = '/api/catalog?source=public'
    const first = await fetchJson(page, path)
    expect(first.status).toBe(200)
    expect(first.data).toEqual(server.catalog)
    expect(server.responses[0]).toMatchObject({ status: 200, encoding: 'br' })
    const second = await fetchJson(page, path)
    expect(second).toEqual(first)
    expect(server.responses[1]).toMatchObject({ status: 304, ifNoneMatch: expect.any(String) })
    expect(server.calls.catalog).toEqual([false, false])
    server.catalog = { ...server.catalog, jobs: [{ ...server.catalog.jobs[0], title: 'Updated Backend Engineer' }] }
    const changed = await fetchJson(page, path)
    expect(changed.data.jobs[0].title).toBe('Updated Backend Engineer')
    expect(server.responses.at(-1)!.status).toBe(200)
    server.catalogError = true
    const expired = await fetchJson(page, path)
    expect(expired.status).toBe(503)
    expect(expired.data.code).toBe('CATALOG_EXPIRED')
    expect(server.responses.at(-1)).toMatchObject({ status: 503, cacheControl: 'no-store' })
    server.catalogError = false
    server.catalog = { ...server.catalog, jobs: [], boards: server.catalog.boards.map(board => ({ ...board, total: 0, included: 0 })) }
    const empty = await fetchJson(page, path)
    expect(empty.status).toBe(200)
    expect(empty.data.jobs).toEqual([])
    expect(server.responses.at(-1)!.status).toBe(200)
    expect((await fetchJson(page, path)).data.jobs).toEqual([])
    expect(server.responses.at(-1)!.status).toBe(304)
    expect(server.responses.every(response => response.path === path)).toBe(true)
  } finally { await server.close() }
})

test('posting-status revalidation preserves the original validity window and still calls explicit refresh', async ({ page }) => {
  const server = await fixture()
  try {
    await page.goto(server.origin)
    const path = '/api/posting-status?refresh=1'
    const first = await fetchJson(page, path)
    const second = await fetchJson(page, path)
    expect(second).toEqual(first)
    expect(server.responses.map(response => response.status)).toEqual([200, 304])
    expect(server.calls.posting).toEqual([true, true])
    expect(second.data.boards[0].listing.validUntil).toBe('2026-09-19T08:30:00.000Z')
    expect(second.data.boards[0].lastSuccessAt).toBe(SEARCH_TIME)
    server.index = { ...server.index, boards: [{ ...server.index.boards[0], listing: { ...server.index.boards[0].listing!, publishedIds: [] } }] }
    const changed = await fetchJson(page, path)
    expect(changed.data.boards[0].listing.publishedIds).toEqual([])
    expect(server.responses.at(-1)!.status).toBe(200)
    server.postingError = true
    const unavailable = await fetchJson(page, path)
    expect(unavailable.status).toBe(503)
    expect(server.responses.at(-1)).toMatchObject({ status: 503, cacheControl: 'no-store' })
    expect(server.calls.posting).toEqual([true, true, true, true])
  } finally { await server.close() }
})

test('an offline browser cannot silently serve an unvalidated public response', async ({ page, context }) => {
  const server = await fixture()
  try {
    await page.goto(server.origin)
    const path = '/api/catalog?source=public'
    const first = await fetchJson(page, path)
    expect(first.status).toBe(200)
    await context.setOffline(true)
    expect(await fetchJson(page, path)).toEqual({ status: 0, data: null, failed: true })
    expect(server.calls.catalog).toHaveLength(1)
    await context.setOffline(false)
    const recovered = await fetchJson(page, path)
    expect(recovered).toEqual(first)
    expect(server.calls.catalog).toHaveLength(2)
    expect(server.responses.at(-1)!.status).toBe(304)
  } finally {
    await context.setOffline(false)
    await server.close()
  }
})
