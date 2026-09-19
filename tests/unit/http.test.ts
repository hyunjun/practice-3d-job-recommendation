import { afterEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import { brotliDecompressSync, gunzipSync } from 'node:zlib'
import { createApiRouter } from '../../server/http'
import { BoardFetchError, CATALOG_POLICY, CatalogUnavailableError, createCatalogService } from '../../server/catalog-service'
import type { PostingStatusIndex } from '../../shared/posting-status'
import { SEARCH_COMPANIES, SEARCH_TIME, searchCatalog, searchJob } from '../fixtures/search-catalog'
import { requestBytes, serveHttp } from '../fixtures/http-server'

const servers: Awaited<ReturnType<typeof serveHttp>>[] = []
afterEach(async () => { await Promise.all(servers.splice(0).map(server => server.close())); vi.restoreAllMocks() })
const catalog = searchCatalog([searchJob('http', {
  description: '공개 공고의 업무·자격 원문입니다. Develop software with Python and TypeScript.\n'.repeat(100),
})])
const index: PostingStatusIndex = {
  version: 1, checkedAt: SEARCH_TIME, refreshAfter: '2026-09-19T08:01:00.000Z',
  boards: [{
    companyId: SEARCH_COMPANIES[0].id, provider: 'greenhouse', board: SEARCH_COMPANIES[0].board!,
    checkedAt: SEARCH_TIME, lastSuccessAt: SEARCH_TIME, retryAt: null, status: 'ok',
    listing: { validUntil: '2026-09-19T08:30:00.000Z', publishedIds: Array.from({ length: 150 }, (_, n) => `greenhouse-search-fixture-a-${n}`), jobs: [] },
  }],
}

async function start(sources: Parameters<typeof createApiRouter>[0]) {
  const app = express()
  app.use('/api', createApiRouter(sources))
  const server = await serveHttp(app)
  servers.push(server)
  return server.origin
}

describe('public HTTP transfer and revalidation', () => {
  it.each(['identity', 'br', 'gzip'])('preserves every JSON field and original byte when serving %s', async encoding => {
    const origin = await start({ getCatalog: async () => catalog, getPostingStatus: async () => index })
    const result = await requestBytes(origin, '/api/catalog?source=public', { 'Accept-Encoding': encoding })
    const decoded = encoding === 'br' ? brotliDecompressSync(result.body) : encoding === 'gzip' ? gunzipSync(result.body) : result.body
    expect(result.status).toBe(200)
    expect(result.headers.vary).toBe('Accept-Encoding')
    expect(result.headers['cache-control']).toBe('private, no-cache, must-revalidate')
    expect(result.headers['content-encoding']).toBe(encoding === 'identity' ? undefined : encoding)
    expect(decoded).toEqual(Buffer.from(JSON.stringify(catalog)))
    if (encoding !== 'identity') {
      expect(result.body.length).toBeLessThan(decoded.length / 2)
      expect(result.headers['content-length']).toBeUndefined()
    }
  })

  it.each(['/catalog?source=public&refresh=1', '/posting-status?refresh=1'])('checks the source before returning an empty 304 for %s', async path => {
    const getCatalog = vi.fn(async () => catalog)
    const getPostingStatus = vi.fn(async () => index)
    const origin = await start({ getCatalog, getPostingStatus })
    const first = await requestBytes(origin, `/api${path}`, { 'Accept-Encoding': 'br' })
    const second = await requestBytes(origin, `/api${path}`, { 'Accept-Encoding': 'br', 'If-None-Match': first.headers.etag })
    expect(second.status).toBe(304)
    expect(second.body.length).toBe(0)
    expect(second.headers.etag).toBe(first.headers.etag)
    expect(second.headers.vary).toBe(first.headers.vary)
    expect(second.headers['cache-control']).toBe(first.headers['cache-control'])
    expect(second.headers['content-encoding']).toBeUndefined()
    const source = path.startsWith('/catalog') ? getCatalog : getPostingStatus
    expect(source).toHaveBeenCalledTimes(2)
    expect(source.mock.calls).toEqual([[true], [true]])
  })

  it('negotiates a supported encoding and keeps HEAD and no-encoding requests usable', async () => {
    const origin = await start({ getCatalog: async () => catalog, getPostingStatus: async () => index })
    const negotiated = await requestBytes(origin, '/api/catalog?source=public', { 'Accept-Encoding': 'gzip;q=1, br;q=0' })
    expect(negotiated.headers['content-encoding']).toBe('gzip')
    expect(JSON.parse(gunzipSync(negotiated.body).toString())).toEqual(catalog)
    const plain = await requestBytes(origin, '/api/catalog?source=public')
    expect(plain.headers['content-encoding']).toBeUndefined()
    expect(JSON.parse(plain.body.toString())).toEqual(catalog)
    const head = await requestBytes(origin, '/api/catalog?source=public', { 'Accept-Encoding': 'br' }, 'HEAD')
    expect(head.status).toBe(200)
    expect(head.body.length).toBe(0)
    expect(head.headers.etag).toBe(plain.headers.etag)
    expect(head.headers.vary).toBe('Accept-Encoding')
  })

  it('preserves sample mode, the legacy public alias and no-store on invalid or failed requests', async () => {
    const getCatalog = vi.fn(async () => catalog)
    const getPostingStatus = vi.fn(async () => index)
    const origin = await start({ getCatalog, getPostingStatus })
    const sample = await requestBytes(origin, '/api/catalog')
    expect(JSON.parse(sample.body.toString()).source).toBe('sample')
    expect(sample.headers['cache-control']).toBe('no-store')
    expect(getCatalog).not.toHaveBeenCalled()
    const alias = await requestBytes(origin, '/api/catalog?source=greenhouse')
    expect(JSON.parse(alias.body.toString())).toEqual(catalog)
    expect(getCatalog).toHaveBeenCalledWith(false)
    for (const [path, status] of [['/api/catalog?source=other', 400], ['/api/catalog?source=public&source=sample', 400], ['/api/unknown', 404]] as const) {
      const result = await requestBytes(origin, path, { 'Accept-Encoding': 'br' })
      expect(result.status).toBe(status)
      expect(result.headers['cache-control']).toBe('no-store')
      expect(result.headers['content-encoding']).toBeUndefined()
    }
    getPostingStatus.mockRejectedValueOnce(new Error('unavailable'))
    const failed = await requestBytes(origin, '/api/posting-status', { 'If-None-Match': '*' })
    expect(failed.status).toBe(503)
    expect(failed.headers['cache-control']).toBe('no-store')
    expect(failed.headers['retry-after']).toBe('60')
    expect(JSON.parse(failed.body.toString()).retryAt).toBeTruthy()
  })

  it('invalidates an old ETag after refresh, authoritative empty success, failure and original snapshot expiry', async () => {
    let now = Date.now()
    let state: 'jobs' | 'empty' | 'error' = 'jobs'
    const fetchBoard = vi.fn(async (_company: unknown, fetchedAt: string) => {
      if (state === 'error') throw new BoardFetchError('HTTP 503')
      const jobs = state === 'empty' ? [] : [searchJob('http-policy', { fetchedAt })]
      return { jobs, total: jobs.length, unmappedCount: 0, publishedIds: jobs.map(job => job.id) }
    })
    const service = createCatalogService({
      companies: [SEARCH_COMPANIES[0]], cache: { load: async () => [], save: async () => {} },
      fetchBoard, now: () => now, random: () => 0,
    })
    const origin = await start({ getCatalog: service.get, getPostingStatus: service.getPostingStatus })
    const path = '/api/catalog?source=public&refresh=1'
    const first = await requestBytes(origin, path)
    const unchanged = await requestBytes(origin, path, { 'If-None-Match': first.headers.etag })
    expect(unchanged.status).toBe(304)
    expect(fetchBoard).toHaveBeenCalledTimes(1)
    now += CATALOG_POLICY.minRefreshInterval
    const refreshed = await requestBytes(origin, path, { 'If-None-Match': first.headers.etag })
    expect(refreshed.status).toBe(200)
    expect(refreshed.headers.etag).not.toBe(first.headers.etag)
    expect(JSON.parse(refreshed.body.toString()).fetchedAt).toBe(new Date(now).toISOString())
    state = 'empty'
    now += CATALOG_POLICY.minRefreshInterval
    const emptyAt = now
    const empty = await requestBytes(origin, path, { 'If-None-Match': refreshed.headers.etag })
    expect(empty.status).toBe(200)
    expect(JSON.parse(empty.body.toString()).jobs).toEqual([])
    state = 'error'
    now += CATALOG_POLICY.minRefreshInterval
    const failed = await requestBytes(origin, path, { 'If-None-Match': empty.headers.etag })
    expect(failed.status).toBe(200)
    expect(JSON.parse(failed.body.toString())).toMatchObject({
      jobs: [], stale: true, fetchedAt: new Date(emptyAt).toISOString(),
      boards: [{ status: 'error', total: 0, included: 0, lastSuccessAt: new Date(emptyAt).toISOString() }],
    })
    now = emptyAt + CATALOG_POLICY.maxFallbackAge + 1
    const expired = await requestBytes(origin, path, { 'If-None-Match': failed.headers.etag })
    expect(expired.status).toBe(503)
    expect(expired.headers['cache-control']).toBe('no-store')
    expect(JSON.parse(expired.body.toString()).code).toBe('CATALOG_EXPIRED')
  })

  it('keeps posting validity dates unchanged on 304 and sends changed membership or board errors', async () => {
    let current = index
    const origin = await start({ getCatalog: async () => catalog, getPostingStatus: async () => current })
    const first = await requestBytes(origin, '/api/posting-status')
    expect(JSON.parse(first.body.toString()).boards[0].listing.validUntil).toBe(index.boards[0].listing!.validUntil)
    expect((await requestBytes(origin, '/api/posting-status', { 'If-None-Match': first.headers.etag })).status).toBe(304)
    current = { ...index, boards: [{ ...index.boards[0], listing: { ...index.boards[0].listing!, publishedIds: [] } }] }
    const removed = await requestBytes(origin, '/api/posting-status', { 'If-None-Match': first.headers.etag })
    expect(removed.status).toBe(200)
    expect(JSON.parse(removed.body.toString()).boards[0].listing.publishedIds).toEqual([])
    current = { ...current, boards: [{ ...current.boards[0], status: 'error', message: 'HTTP 503' }] }
    const failed = await requestBytes(origin, '/api/posting-status', { 'If-None-Match': removed.headers.etag })
    expect(failed.status).toBe(200)
    expect(JSON.parse(failed.body.toString()).boards[0].status).toBe('error')
  })

  it('never reuses a matching response when the catalog source itself is unavailable', async () => {
    const retryAt = new Date(Date.now() + 60_000).toISOString()
    const origin = await start({
      getCatalog: async () => { throw new CatalogUnavailableError('연결 실패', retryAt) },
      getPostingStatus: async () => index,
    })
    const result = await requestBytes(origin, '/api/catalog?source=public', { 'If-None-Match': '*' })
    expect(result.status).toBe(503)
    expect(result.headers['cache-control']).toBe('no-store')
    expect(Number(result.headers['retry-after'])).toBeGreaterThan(0)
    expect(JSON.parse(result.body.toString())).toMatchObject({ code: 'CATALOG_UNAVAILABLE', retryAt })
  })
})
