import { afterEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import { createApiRouter } from '../../server/http'
import { createCatalogReader } from '../../src/lib/catalog-request'
import { catalogNeedsAttention, collectionHealth } from '../../shared/catalog-health'
import type { CatalogCollectionUpdate } from '../../shared/catalog-progress'
import type { BoardStatus, Catalog } from '../../shared/types'
import { requestBytes, serveHttp } from '../fixtures/http-server'
import { PUBLIC_TEST_CITIES } from '../fixtures/public-geography'
import { PROVENANCE_ALDER, PROVENANCE_BIRCH, PROVENANCE_COMPANIES, PROVENANCE_FAILURES, cachedPresence, provenanceJob, stamp } from '../fixtures/board-status-provenance'
import { provenanceHarness } from './helpers/board-status-provenance'
import type { ProvenanceHarness } from './helpers/board-status-provenance'

// Real service behind the real router. Wire expectations are literal; the
// client decoder receives authored JSON, never the server's new resolver.
const ALDER = 'provenance-alder'
const BIRCH = 'provenance-birch'
const alder = { companyId: ALDER, board: 'AlderProvenance74', provider: 'greenhouse' } as const
const birch = { companyId: BIRCH, board: 'BirchProvenance74', provider: 'smartrecruiters' } as const
const BIRCH_DEFERRED: BoardStatus = {
  ...birch, status: 'error', dataStatus: 'unavailable', total: 0, included: 0,
  checkedAt: '2026-10-01T06:00:00.000Z', lastSuccessAt: null,
  retryAt: '2026-10-01T06:01:00.000Z', message: 'Fictional public list 503',
}
const ALDER_COLLECTED: BoardStatus = {
  ...alder, status: 'ok', dataStatus: 'fresh', total: 1, included: 1,
  checkedAt: '2026-10-01T06:00:30.000Z', lastSuccessAt: '2026-10-01T06:00:30.000Z', retryAt: null,
}
const servers: Awaited<ReturnType<typeof serveHttp>>[] = []
afterEach(async () => { await Promise.all(servers.splice(0).map(server => server.close())); vi.restoreAllMocks() })

async function serve(service: ReturnType<ProvenanceHarness['start']>) {
  const app = express()
  app.use('/api', createApiRouter({
    getCatalog: service.get, getPostingStatus: service.getPostingStatus,
    getProgressiveCatalog: service.getProgressive, getCatalogProgress: service.readProgress,
  }))
  const server = await serveHttp(app)
  servers.push(server)
  return server.origin
}
const json = (body: Buffer) => JSON.parse(body.toString()) as Catalog & { progress?: unknown; catalog?: Catalog; code?: string; retryAt?: string; error?: string }

describe('HTTP representations of a deferred public-list failure', () => {
  it('serves the deferred row in the blocking catalog, reuses it conditionally, and changes the ETag only when the company recovers', async () => {
    const h = provenanceHarness()
    h.failList(BIRCH, PROVENANCE_FAILURES.list)
    const service = h.start()
    await service.getPostingStatus(true)
    h.at(stamp('06:00:30.000'))
    const origin = await serve(service)
    const first = await requestBytes(origin, '/api/catalog?source=public')
    expect(first.status).toBe(200)
    expect(first.headers['cache-control']).toBe('private, no-cache, must-revalidate')
    expect(json(first.body).boards).toEqual([ALDER_COLLECTED, BIRCH_DEFERRED])
    expect(json(first.body)).toMatchObject({ fetchedAt: '2026-10-01T06:00:30.000Z', checkedAt: '2026-10-01T06:00:30.000Z', refreshAfter: '2026-10-01T06:01:00.000Z', stale: false })
    const unchanged = await requestBytes(origin, '/api/catalog?source=public', { 'If-None-Match': first.headers.etag })
    expect(unchanged.status).toBe(304)
    expect(unchanged.body.length).toBe(0)
    const forced = await requestBytes(origin, '/api/catalog?source=public&refresh=1', { 'If-None-Match': first.headers.etag })
    expect(forced.status).toBe(304)
    expect(h.bodyCalls()).toEqual([ALDER])
    const index = await requestBytes(origin, '/api/posting-status')
    expect(index.status).toBe(200)
    expect(json(index.body).boards[1]).toMatchObject({
      status: 'error', message: 'Fictional public list 503', checkedAt: '2026-10-01T06:00:00.000Z', retryAt: '2026-10-01T06:01:00.000Z', lastSuccessAt: null,
    })
    h.at(stamp('06:01:00.000'))
    const recovered = await requestBytes(origin, '/api/catalog?source=public&refresh=1', { 'If-None-Match': first.headers.etag })
    expect(recovered.status).toBe(200)
    expect(recovered.headers.etag).not.toBe(first.headers.etag)
    expect(json(recovered.body).boards[1]).toEqual({
      ...birch, status: 'ok', dataStatus: 'fresh', total: 1, included: 1,
      checkedAt: '2026-10-01T06:01:00.000Z', lastSuccessAt: '2026-10-01T06:01:00.000Z', retryAt: null,
    })
    expect(h.bodyCalls()).toEqual([ALDER, BIRCH])
  })

  it('carries the deferred row unchanged through the 202 snapshot, the progress delta and the settled catalog', async () => {
    const h = provenanceHarness()
    h.failList(BIRCH, PROVENANCE_FAILURES.list)
    const service = h.start()
    await service.getPostingStatus(true)
    h.at(stamp('06:00:30.000'))
    const held = h.holdBody(ALDER)
    const origin = await serve(service)
    const started = await requestBytes(origin, '/api/catalog?source=public', { Prefer: 'respond-async' })
    expect(started.status).toBe(202)
    expect(started.headers['preference-applied']).toBe('respond-async')
    expect(started.headers['cache-control']).toBe('no-store')
    const snapshot = json(started.body)
    expect(snapshot.progress).toMatchObject({ total: 1, completed: 0, done: false, revision: 0 })
    expect(snapshot.catalog!.fetchedAt).toBe('')
    expect(snapshot.catalog!.boards[0]).toMatchObject({ ...alder, status: 'pending', dataStatus: 'unavailable', total: 0, included: 0, lastSuccessAt: null, retryAt: null })
    expect(snapshot.catalog!.boards[1]).toEqual(BIRCH_DEFERRED)
    const monitor = started.headers.location!
    expect(monitor).toMatch(/^\/api\/catalog\/progress\?id=[a-f0-9-]{36}&after=0$/)
    const waiting = await requestBytes(origin, monitor)
    expect(waiting.status).toBe(204)
    held.release()
    let update: CatalogCollectionUpdate | undefined
    await vi.waitFor(async () => {
      const response = await requestBytes(origin, monitor)
      expect(response.status).toBe(200)
      update = JSON.parse(response.body.toString())
      expect(update!.progress.done).toBe(true)
    })
    expect(update!.companyIds).toEqual([ALDER])
    expect(update!.progress).toMatchObject({ total: 1, completed: 1, done: true })
    expect(update!.jobs.map(job => job.id)).toEqual(['greenhouse-provenance-alder-7401'])
    expect(update!.catalog.boards).toEqual([ALDER_COLLECTED, BIRCH_DEFERRED])
    const settled = await requestBytes(origin, '/api/catalog?source=public', { Prefer: 'respond-async' })
    expect(settled.status).toBe(200)
    expect(json(settled.body).boards).toEqual([ALDER_COLLECTED, BIRCH_DEFERRED])
    expect(h.bodyCalls()).toEqual([ALDER])
  })

  const outages: [string, (h: ProvenanceHarness) => Promise<void>][] = [
    ['runtime list failures', async h => {
      h.failEveryList(PROVENANCE_FAILURES.list)
      await h.start().getPostingStatus(true)
    }],
    ['persisted null deadlines', async h => {
      await h.presenceCache.save([
        cachedPresence(PROVENANCE_ALDER, stamp('06:00:00.000'), { failure: { message: PROVENANCE_FAILURES.persistedList, retryAt: null } }),
        cachedPresence(PROVENANCE_BIRCH, stamp('06:00:00.000'), { failure: { message: PROVENANCE_FAILURES.persistedList, retryAt: null } }),
      ])
    }],
  ]
  it.each(outages)('answers 503 with the shared deadline and Retry-After for %s and never a successful empty catalog', async (_label, prepare) => {
    const h = provenanceHarness()
    await prepare(h)
    h.at(stamp('06:00:30.000'))
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse(stamp('06:00:30.000')))
    const origin = await serve(h.start())
    for (const headers of [{}, { Prefer: 'respond-async' }]) {
      const response = await requestBytes(origin, '/api/catalog?source=public', headers)
      expect(response.status).toBe(503)
      expect(response.headers['cache-control']).toBe('no-store')
      expect(response.headers['retry-after']).toBe('30')
      expect(json(response.body)).toEqual({
        error: '공개 채용 게시판에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요.',
        retryAt: '2026-10-01T06:01:00.000Z', code: 'CATALOG_UNAVAILABLE',
      })
    }
    const index = await requestBytes(origin, '/api/posting-status')
    expect(index.status).toBe(200)
    expect(json(index.body).boards.map(board => [board.status, board.retryAt])).toEqual([
      ['error', '2026-10-01T06:01:00.000Z'], ['error', '2026-10-01T06:01:00.000Z'],
    ])
    expect(h.bodyCalls()).toEqual([])
  })
})

describe('client decoding of a deferred failure beside a pending company', () => {
  const COLLECTION_ID = '00000000-0000-4000-8000-000000000074'
  const ALDER_PENDING: BoardStatus = { ...alder, status: 'pending', dataStatus: 'unavailable', total: 0, included: 0, lastSuccessAt: null }
  const BIRCH_RETAINED: BoardStatus = {
    ...birch, status: 'error', dataStatus: 'stale', total: 1, included: 1,
    checkedAt: '2026-10-01T06:20:00.000Z', lastSuccessAt: '2026-10-01T06:00:00.000Z',
    retryAt: '2026-10-01T06:30:00.000Z', message: 'HTTP 429',
  }
  const retainedJob = { ...provenanceJob(PROVENANCE_BIRCH, '74001', '2026-10-01T06:00:00.000Z'), stale: true }
  const arrival = provenanceJob(PROVENANCE_ALDER, '7401', '2026-10-01T06:20:30.000Z')
  function snapshot(deferred: BoardStatus, jobs: Catalog['jobs']) {
    return {
      catalog: {
        source: 'public', fetchedAt: jobs.length ? '2026-10-01T06:00:00.000Z' : '', stale: jobs.length > 0,
        companies: PROVENANCE_COMPANIES, cities: PUBLIC_TEST_CITIES, jobs, unmappedCount: 0,
        checkedAt: deferred.checkedAt, boards: [ALDER_PENDING, deferred],
      } satisfies Catalog,
      progress: { id: COLLECTION_ID, revision: 0, total: 1, completed: 0, done: false },
    }
  }
  function delta(deferred: BoardStatus): CatalogCollectionUpdate {
    return {
      progress: { id: COLLECTION_ID, revision: 1, total: 1, completed: 1, done: true },
      companyIds: [ALDER], jobs: [arrival],
      catalog: {
        source: 'public', fetchedAt: '2026-10-01T06:20:30.000Z', stale: deferred.dataStatus === 'stale', unmappedCount: 0,
        checkedAt: '2026-10-01T06:20:30.000Z', refreshAfter: '2026-10-01T06:21:30.000Z',
        boards: [{ ...alder, status: 'ok', dataStatus: 'fresh', total: 1, included: 1, checkedAt: '2026-10-01T06:20:30.000Z', lastSuccessAt: '2026-10-01T06:20:30.000Z', retryAt: null }, deferred],
      },
    }
  }

  it('accepts a cold deferred error row that is neither pending nor counted, then keeps it after the healthy delta', async () => {
    const read = createCatalogReader()
    const initial = await read(Response.json(snapshot(BIRCH_DEFERRED, []), { status: 202 }), true)
    expect(initial.progress).toMatchObject({ total: 1, completed: 0, done: false })
    expect(initial.value.boards).toEqual([ALDER_PENDING, BIRCH_DEFERRED])
    expect(collectionHealth(initial.value)).toEqual({ recent: 0, retained: 0, unavailable: 1, failed: 1, pending: 1 })
    const merged = await read(Response.json(delta(BIRCH_DEFERRED)), false)
    expect(merged.progress).toMatchObject({ done: true, completed: 1 })
    expect(merged.value.boards[1]).toEqual(BIRCH_DEFERRED)
    expect(merged.value.boards[0]).toMatchObject({ ...alder, status: 'ok', dataStatus: 'fresh', included: 1 })
    expect(merged.value.jobs.map(job => [job.id, job.stale])).toEqual([['greenhouse-provenance-alder-7401', false]])
    expect(merged.value.companies).toEqual(PROVENANCE_COMPANIES)
    expect(collectionHealth(merged.value)).toEqual({ recent: 1, retained: 0, unavailable: 1, failed: 1, pending: 0 })
    expect(catalogNeedsAttention(merged.value)).toBe(true)
  })

  it('keeps a deferred company\'s retained stale jobs and their original time through the delta', async () => {
    const read = createCatalogReader()
    const initial = await read(Response.json(snapshot(BIRCH_RETAINED, [retainedJob]), { status: 202 }), true)
    expect(initial.value.jobs.map(job => [job.id, job.fetchedAt, job.stale])).toEqual([['smartrecruiters-provenance-birch-74001', '2026-10-01T06:00:00.000Z', true]])
    expect(collectionHealth(initial.value)).toEqual({ recent: 0, retained: 1, unavailable: 0, failed: 1, pending: 1 })
    const merged = await read(Response.json(delta(BIRCH_RETAINED)), false)
    expect(merged.value.boards[1]).toEqual(BIRCH_RETAINED)
    expect(merged.value.jobs.map(job => [job.id, job.fetchedAt, job.stale])).toEqual([
      ['greenhouse-provenance-alder-7401', '2026-10-01T06:20:30.000Z', false],
      ['smartrecruiters-provenance-birch-74001', '2026-10-01T06:00:00.000Z', true],
    ])
    expect(merged.value.stale).toBe(true)
    expect(collectionHealth(merged.value)).toEqual({ recent: 1, retained: 1, unavailable: 0, failed: 1, pending: 0 })
  })

  it('rejects a delta that turns the deferred error into a pending company it never scheduled', async () => {
    const read = createCatalogReader()
    await read(Response.json(snapshot(BIRCH_DEFERRED, []), { status: 202 }), true)
    const invalid = delta(BIRCH_DEFERRED)
    invalid.catalog.boards[1] = { ...birch, status: 'pending', dataStatus: 'unavailable', total: 0, included: 0, lastSuccessAt: null }
    await expect(read(Response.json(invalid), false)).rejects.toThrow('공고 데이터 형식')
  })
})
