import { afterEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import type { OutgoingHttpHeaders } from 'node:http'
import { createApiRouter } from '../../server/http'
import { BoardFetchError, CatalogUnavailableError } from '../../server/catalog-service'
import type { PostingStatusIndex } from '../../shared/posting-status'
import type { BoardStatus, Catalog } from '../../shared/types'
import { requestBytes, serveHttp } from '../fixtures/http-server'
import { PROVENANCE_ALDER, PROVENANCE_BIRCH, cachedBody, stamp } from '../fixtures/board-status-provenance'
import { COLLECTION_ID, progressSnapshot } from '../fixtures/catalog-progress'
import { QUEUED_FAILURE_BODY, QUEUED_ID, QUEUED_PREFER, queuedWaiting } from '../fixtures/catalog-queued-progress'
import { SEARCH_COMPANIES, SEARCH_TIME } from '../fixtures/search-catalog'
import { provenanceHarness } from './helpers/board-status-provenance'
import type { ProvenanceHarness } from './helpers/board-status-provenance'

// Stage75 contract: docs/design/catalog-queued-progress.md (9b921a49…feff9).
// Real service behind the real router with held provider gates. Wire
// expectations are literal bytes and headers; blocking is proven by
// settlement order, and the only timers are failure guards.
const ALDER = 'provenance-alder'
const BIRCH = 'provenance-birch'
const alder = { companyId: ALDER, board: 'AlderProvenance74', provider: 'greenhouse' } as const
const birch = { companyId: BIRCH, board: 'BirchProvenance74', provider: 'smartrecruiters' } as const
const T = stamp
const UUID = /^[a-f0-9-]{36}$/i
const PATH = '/api/catalog?source=public'
const ALDER_JOB = 'greenhouse-provenance-alder-7401'
const BIRCH_JOB = 'smartrecruiters-provenance-birch-7401'
const GONE_MESSAGE = '수집 진행 정보를 다시 연결해야 해요. 다시 조회하면 현재 공고부터 이어서 확인합니다.'
const UNAVAILABLE_MESSAGE = '공개 채용 게시판에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요.'
const POSTING_STATUS_MESSAGE = '게시 상태를 불러오지 못했어요. 잠시 후 다시 확인해 주세요.'
const WAITING = { phase: 'waiting-for-presence', total: null, completed: 0, done: false } as const

const cold = (identity: typeof alder | typeof birch, checkedAt?: string): BoardStatus => ({
  ...identity, status: 'ok', dataStatus: 'unavailable', total: 0, included: 0, ...(checkedAt ? { checkedAt } : {}), lastSuccessAt: null, retryAt: null,
})
const pendingCold = (identity: typeof alder | typeof birch, checkedAt: string): BoardStatus => ({
  ...identity, status: 'pending', dataStatus: 'unavailable', total: 0, included: 0, checkedAt, lastSuccessAt: null, retryAt: null,
})
const collected = (identity: typeof alder | typeof birch, time: string): BoardStatus => ({
  ...identity, status: 'ok', dataStatus: 'fresh', total: 1, included: 1, checkedAt: time, lastSuccessAt: time, retryAt: null,
})
const fresh = (identity: typeof alder | typeof birch, time: string): BoardStatus => collected(identity, time)
const BIRCH_DEFERRED: BoardStatus = {
  ...birch, status: 'error', dataStatus: 'unavailable', total: 0, included: 0,
  checkedAt: T('06:00:00.000'), lastSuccessAt: null, retryAt: T('06:10:30.000'), message: 'HTTP 429',
}

type Wire = Catalog & { progress?: Record<string, unknown>; catalog?: Catalog; companyIds?: string[]; code?: string; retryAt?: string; error?: string }
const json = (body: Buffer) => JSON.parse(body.toString()) as Wire
const servers: Awaited<ReturnType<typeof serveHttp>>[] = []
afterEach(async () => { await Promise.all(servers.splice(0).map(server => server.close())); vi.restoreAllMocks() })

/**
 * The real router over the real service. `onPostingStatus` is a read-only observation of the
 * router's delegated status call: it records that a socket request has entered the service,
 * then forwards the unchanged arguments. Without it the helper delegates directly as before.
 */
async function serve(service: ReturnType<ProvenanceHarness['start']>, options: { onPostingStatus?: (refresh: boolean, content?: boolean) => void } = {}) {
  const app = express()
  const observe = options.onPostingStatus
  app.use('/api', createApiRouter({
    getCatalog: service.get,
    getPostingStatus: observe
      ? (refresh: boolean, content?: boolean) => { observe(refresh, content); return service.getPostingStatus(refresh, content) }
      : service.getPostingStatus,
    getProgressiveCatalog: service.getProgressive as Parameters<typeof createApiRouter>[0]['getProgressiveCatalog'],
    getCatalogProgress: service.readProgress,
  }))
  const server = await serveHttp(app)
  servers.push(server)
  return server.origin
}

/** Failure guard only: a response that must not wait on provider work gets a clear message instead of a hang. */
async function settles<T>(promise: Promise<T>, label: string, milliseconds = 2000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} did not settle within ${milliseconds}ms while provider work was held`)), milliseconds)
  })
  try { return await Promise.race([promise, guard]) } finally { clearTimeout(timer) }
}

function orderLedger() {
  const marks: string[] = []
  return {
    marks,
    mark(label: string) { marks.push(label) },
    watch<T>(label: string, promise: Promise<T>): Promise<T> {
      return promise.then(value => { marks.push(label); return value }, (error: unknown) => { marks.push(label); throw error })
    },
    indexOf: (label: string) => marks.indexOf(label),
  }
}

/**
 * Poll until a response with the given status and, optionally, progress phase or completion
 * exists. Accepted list results and the handoff may be separate revisions, so a poll that
 * waits for "any 200" could observe the intermediate metadata state.
 */
function pollUntil(origin: string, path: string, status: number, expected: { phase?: string; done?: boolean } = {}) {
  return vi.waitFor(async () => {
    const response = await requestBytes(origin, path)
    expect(response.status).toBe(status)
    if (expected.phase) expect(json(response.body).progress?.phase).toBe(expected.phase)
    if (expected.done) expect(json(response.body).progress?.done).toBe(true)
    return response
  })
}

async function heldPresence(h: ProvenanceHarness, lists: string[]) {
  const service = h.start()
  const presence = service.getPostingStatus(true)
  await vi.waitFor(() => expect(h.listCalls()).toEqual(lists))
  return { service, presence }
}

describe('negotiated waiting over HTTP with the real service', () => {
  it('answers the waiting 202 before release, keeps polls read-only, and holds legacy async and synchronous clients until their own phases', async () => {
    const h = provenanceHarness()
    h.failList(BIRCH, 'HTTP 429', T('06:10:30.000'))
    const birchList = h.holdList(BIRCH)
    const alderList = h.holdList(ALDER)
    const { service, presence } = await heldPresence(h, [ALDER, BIRCH])
    h.at(T('06:00:30.000'))
    const origin = await serve(service)
    const order = orderLedger()
    const sync = order.watch('sync', requestBytes(origin, PATH))
    const legacy = order.watch('legacy', requestBytes(origin, PATH, { Prefer: 'respond-async' }))

    const started = await settles(requestBytes(origin, PATH, { Prefer: QUEUED_PREFER }), 'the negotiated initial response')
    expect(started.status).toBe(202)
    expect(started.headers['preference-applied']).toBe('respond-async, orbit-progress=queued')
    expect(started.headers['cache-control']).toBe('no-store')
    expect(started.headers['retry-after']).toBe('1')
    expect(started.headers.vary).toBe('Accept-Encoding, Prefer')
    const snapshot = json(started.body)
    expect(snapshot.progress).toEqual({ id: expect.stringMatching(UUID), revision: 0, ...WAITING })
    const id = snapshot.progress!.id as string
    expect(started.headers.location).toBe(`/api/catalog/progress?id=${id}&after=0`)
    expect(snapshot.catalog).toMatchObject({ source: 'public', fetchedAt: '', stale: false, unmappedCount: 0 })
    expect(snapshot.catalog!.jobs).toEqual([])
    expect(snapshot.catalog!.boards).toEqual([cold(alder), cold(birch)])
    const waiting = await requestBytes(origin, started.headers.location!)
    expect(waiting.status).toBe(204)
    expect(waiting.body.length).toBe(0)
    expect(waiting.headers['retry-after']).toBe('1')
    expect(waiting.headers['cache-control']).toBe('no-store')
    expect(h.bodyCalls()).toEqual([])
    expect(order.marks).toEqual([])

    // Birch's list fails while Alder's is held: a metadata-only 200 with the same id and undecided total.
    birchList.release()
    const metadata = await pollUntil(origin, `/api/catalog/progress?id=${id}&after=0`, 200)
    const metadataBody = json(metadata.body)
    expect(metadataBody.progress).toEqual({ id, revision: expect.any(Number), ...WAITING })
    expect(metadataBody.companyIds).toEqual([])
    expect(metadataBody.jobs).toEqual([])
    expect(metadataBody.catalog!.boards).toEqual([cold(alder), BIRCH_DEFERRED])
    expect(metadata.headers['retry-after']).toBe('1')
    const afterMetadata = metadataBody.progress!.revision as number
    expect(afterMetadata).toBeGreaterThan(0)
    expect(order.marks).toEqual([])

    // Alder's list succeeds: the legacy client is released at handoff with a positive fixed total.
    const alderBody = h.holdBody(ALDER)
    alderList.release()
    const legacyResponse = await legacy
    expect(order.marks).toEqual(['legacy'])
    expect(legacyResponse.status).toBe(202)
    expect(legacyResponse.headers['preference-applied']).toBe('respond-async')
    const legacyBody = json(legacyResponse.body)
    expect(legacyBody.progress).toEqual({ id, revision: expect.any(Number), phase: 'collecting', total: 1, completed: 0, done: false })
    expect(legacyResponse.headers.location).toBe(`/api/catalog/progress?id=${id}&after=${legacyBody.progress!.revision}`)
    expect(legacyBody.catalog!.boards).toEqual([pendingCold(alder, T('06:00:00.000')), BIRCH_DEFERRED])
    const handoff = json((await pollUntil(origin, `/api/catalog/progress?id=${id}&after=${afterMetadata}`, 200, { phase: 'collecting' })).body)
    expect(handoff.progress).toEqual({ id, revision: expect.any(Number), phase: 'collecting', total: 1, completed: 0, done: false })
    expect(handoff.companyIds).toEqual([])
    const afterHandoff = handoff.progress!.revision as number
    await presence
    expect(h.bodyCalls()).toEqual([ALDER])

    alderBody.release()
    const syncResponse = await sync
    expect(order.marks).toEqual(['legacy', 'sync'])
    expect(syncResponse.status).toBe(200)
    expect(syncResponse.headers['cache-control']).toBe('private, no-cache, must-revalidate')
    const catalog = json(syncResponse.body)
    expect(catalog.boards).toEqual([collected(alder, T('06:00:30.000')), BIRCH_DEFERRED])
    expect(catalog).toMatchObject({ fetchedAt: T('06:00:30.000'), checkedAt: T('06:00:30.000'), refreshAfter: T('06:01:30.000'), stale: false })
    expect(catalog.jobs.map(job => [job.id, job.stale])).toEqual([[ALDER_JOB, false]])
    const final = json((await pollUntil(origin, `/api/catalog/progress?id=${id}&after=${afterHandoff}`, 200, { done: true })).body)
    expect(final.progress).toEqual({ id, revision: expect.any(Number), phase: 'collecting', total: 1, completed: 1, done: true })
    expect(final.companyIds).toEqual([ALDER])
    expect(final.catalog!.boards).toEqual(catalog.boards)
    const conditional = await requestBytes(origin, PATH, { Prefer: QUEUED_PREFER, 'If-None-Match': syncResponse.headers.etag })
    expect(conditional.status).toBe(304)
    expect(h.bodyCalls()).toEqual([ALDER])
  })

  it('sends fresh cached bodies with the waiting state, completes with zero work, then serves ordinary 200/304 and never hides a newly accepted failure behind the old ETag', async () => {
    const h = provenanceHarness({ bodies: [cachedBody(PROVENANCE_ALDER, T('06:00:00.000')), cachedBody(PROVENANCE_BIRCH, T('06:00:00.000'))], at: T('06:01:00.000') })
    const lists = h.holdList(ALDER, BIRCH)
    const { service, presence } = await heldPresence(h, [ALDER, BIRCH])
    const origin = await serve(service)
    const order = orderLedger()
    const legacy = order.watch('legacy', requestBytes(origin, PATH, { Prefer: 'respond-async' }))
    const sync = order.watch('sync', requestBytes(origin, PATH))
    const FRESH = [fresh(alder, T('06:00:00.000')), fresh(birch, T('06:00:00.000'))]

    const started = await settles(requestBytes(origin, PATH, { Prefer: QUEUED_PREFER }), 'the negotiated initial response')
    expect(started.status).toBe(202)
    const snapshot = json(started.body)
    expect(snapshot.progress).toEqual({ id: expect.stringMatching(UUID), revision: 0, ...WAITING })
    const id = snapshot.progress!.id as string
    expect(snapshot.catalog).toMatchObject({ fetchedAt: T('06:00:00.000'), checkedAt: T('06:00:00.000'), stale: false })
    expect(snapshot.catalog!.boards).toEqual(FRESH)
    expect(snapshot.catalog!.jobs.map(job => [job.id, job.fetchedAt, job.stale])).toEqual([[ALDER_JOB, T('06:00:00.000'), false], [BIRCH_JOB, T('06:00:00.000'), false]])
    expect(order.marks).toEqual([])

    lists.release()
    await presence
    const [legacyResponse, syncResponse] = await Promise.all([legacy, sync])
    expect(legacyResponse.status).toBe(200)
    expect(legacyResponse.headers['preference-applied']).toBeUndefined()
    expect(legacyResponse.headers['cache-control']).toBe('private, no-cache, must-revalidate')
    expect(json(legacyResponse.body).boards).toEqual(FRESH)
    expect(json(legacyResponse.body)).toMatchObject({ fetchedAt: T('06:00:00.000'), checkedAt: T('06:01:00.000') })
    expect(syncResponse.status).toBe(200)
    expect(json(syncResponse.body)).toEqual(json(legacyResponse.body))
    const zero = await pollUntil(origin, `/api/catalog/progress?id=${id}&after=0`, 200, { done: true })
    const zeroBody = json(zero.body)
    expect(zeroBody.progress).toEqual({ id, revision: expect.any(Number), phase: 'collecting', total: 0, completed: 0, done: true })
    expect(zeroBody.companyIds).toEqual([])
    expect(zeroBody.jobs).toEqual([])
    expect(zeroBody.catalog!.boards).toEqual(FRESH)
    expect(zero.headers['retry-after']).toBeUndefined()

    // Idle now: the negotiated request gets the ordinary catalog with conditional validation.
    const idle = await requestBytes(origin, PATH, { Prefer: QUEUED_PREFER })
    expect(idle.status).toBe(200)
    expect(idle.headers['preference-applied']).toBeUndefined()
    expect(idle.headers['cache-control']).toBe('private, no-cache, must-revalidate')
    expect(idle.headers.vary).toBe('Accept-Encoding, Prefer')
    const unchanged = await requestBytes(origin, PATH, { Prefer: QUEUED_PREFER, 'If-None-Match': idle.headers.etag })
    expect(unchanged.status).toBe(304)

    // A later accepted list failure changes the representation and the ETag.
    h.at(T('06:02:00.000'))
    h.failList(BIRCH, 'HTTP 429', T('06:12:00.000'))
    await service.getPostingStatus(true)
    const changed = await requestBytes(origin, PATH, { Prefer: QUEUED_PREFER, 'If-None-Match': idle.headers.etag })
    expect(changed.status).toBe(200)
    expect(changed.headers.etag).not.toBe(idle.headers.etag)
    expect(json(changed.body).boards[1]).toEqual({
      ...birch, status: 'error', dataStatus: 'stale', total: 1, included: 1,
      checkedAt: T('06:02:00.000'), lastSuccessAt: T('06:00:00.000'), retryAt: T('06:12:00.000'), message: 'HTTP 429',
    })
    expect(json(changed.body).jobs.map(job => [job.id, job.fetchedAt, job.stale])).toEqual([[ALDER_JOB, T('06:00:00.000'), false], [BIRCH_JOB, T('06:00:00.000'), true]])
    expect(h.bodyCalls()).toEqual([])
  })

  it('answers the existing unavailable 503 with the shared deadline when every company is deferred at handoff', async () => {
    const h = provenanceHarness({ at: T('06:00:30.000') })
    h.fetchPresence.mockImplementation(async () => { throw new BoardFetchError('HTTP 429', Date.parse(T('06:10:30.000'))) })
    const lists = h.holdList(ALDER, BIRCH)
    const { service, presence } = await heldPresence(h, [ALDER, BIRCH])
    const origin = await serve(service)
    const sync = requestBytes(origin, PATH)
    const started = await settles(requestBytes(origin, PATH, { Prefer: QUEUED_PREFER }), 'the negotiated initial response')
    expect(started.status).toBe(202)
    const id = json(started.body).progress!.id as string
    // The synchronous 503 is produced as soon as the operation completes, so the wall clock
    // that Retry-After is derived from must be pinned before release. No vi.waitFor runs while pinned.
    const now = vi.spyOn(Date, 'now').mockReturnValue(Date.parse(T('06:00:30.000')))
    lists.release()
    await presence
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(() => service.readProgress(id, 0)).toThrow(CatalogUnavailableError)
    const failed = await requestBytes(origin, started.headers.location!)
    const syncResponse = await sync
    now.mockRestore()
    for (const response of [failed, syncResponse]) {
      expect(response.status).toBe(503)
      expect(response.headers['cache-control']).toBe('no-store')
      expect(response.headers['retry-after']).toBe('600')
      expect(json(response.body)).toEqual({ error: UNAVAILABLE_MESSAGE, retryAt: T('06:10:30.000'), code: 'CATALOG_UNAVAILABLE' })
    }
    expect(h.bodyCalls()).toEqual([])
  })

  it('answers 410 for a waiting operation after a restart and has persisted nothing for it', async () => {
    const h = provenanceHarness()
    const lists = h.holdList(ALDER, BIRCH)
    const { service, presence } = await heldPresence(h, [ALDER, BIRCH])
    h.at(T('06:00:30.000'))
    const origin = await serve(service)
    const started = await settles(requestBytes(origin, PATH, { Prefer: QUEUED_PREFER }), 'the negotiated initial response')
    expect(started.status).toBe(202)
    const restarted = await serve(h.start())
    const gone = await requestBytes(restarted, started.headers.location!)
    expect(gone.status).toBe(410)
    expect(json(gone.body)).toEqual({ code: 'CATALOG_PROGRESS_GONE', error: GONE_MESSAGE })
    expect(h.cache.save).not.toHaveBeenCalled()
    lists.release()
    await presence
  })

  it('answers the fixed error-only 503 for a rejected operation, its joined clients and every repeated poll, while posting-status keeps its own 503', async () => {
    const h = provenanceHarness({ onCacheError: () => { throw new Error('Fictional error reporter rejection') } })
    // The fault is scoped to the list operation's own write; the replacement body operation's write must succeed.
    h.presenceCache.save.mockImplementationOnce(async () => { throw new Error('Fictional presence persistence failure') })
    const lists = h.holdList(ALDER, BIRCH)
    const service = h.start()
    const origin = await serve(service)
    const posting = requestBytes(origin, '/api/posting-status?refresh=1')
    await vi.waitFor(() => expect(h.listCalls()).toEqual([ALDER, BIRCH]))
    h.at(T('06:00:30.000'))
    const sync = requestBytes(origin, PATH)
    const legacy = requestBytes(origin, PATH, { Prefer: 'respond-async' })
    const started = await settles(requestBytes(origin, PATH, { Prefer: QUEUED_PREFER }), 'the negotiated initial response')
    expect(started.status).toBe(202)
    expect(json(started.body).progress).toEqual({ id: expect.stringMatching(UUID), revision: 0, ...WAITING })
    const location = started.headers.location!

    lists.release()
    const postingResponse = await posting
    expect(postingResponse.status).toBe(503)
    expect(postingResponse.headers['retry-after']).toBe('60')
    expect(postingResponse.headers['cache-control']).toBe('no-store')
    expect(json(postingResponse.body)).toEqual({ error: POSTING_STATUS_MESSAGE, retryAt: expect.any(String) })
    expect(Number.isFinite(Date.parse(json(postingResponse.body).retryAt!))).toBe(true)
    const failed = await pollUntil(origin, location, 503)
    const [syncResponse, legacyResponse] = await Promise.all([sync, legacy])
    const repeats = [await requestBytes(origin, location), await requestBytes(origin, location), await requestBytes(origin, location)]
    for (const response of [failed, ...repeats, syncResponse, legacyResponse]) {
      expect(response.status).toBe(503)
      expect(response.headers['cache-control']).toBe('no-store')
      expect(response.headers['retry-after']).toBeUndefined()
      expect(response.body.toString()).toBe(JSON.stringify(QUEUED_FAILURE_BODY))
    }
    expect(h.bodyCalls()).toEqual([])
    expect(h.cache.save).not.toHaveBeenCalled()

    // The next negotiated request starts a replacement from cold memory; the failed id is then gone.
    const bodies = h.holdBody(ALDER, BIRCH)
    const next = await settles(requestBytes(origin, PATH, { Prefer: QUEUED_PREFER }), 'the next negotiated request')
    expect(next.status).toBe(202)
    const replacement = json(next.body).progress!
    expect(replacement).toEqual({ id: expect.stringMatching(UUID), revision: expect.any(Number), phase: 'collecting', total: 2, completed: 0, done: false })
    expect(replacement.id).not.toBe(new URL(location, origin).searchParams.get('id'))
    const gone = await requestBytes(origin, location)
    expect(gone.status).toBe(410)
    expect(json(gone.body)).toEqual({ code: 'CATALOG_PROGRESS_GONE', error: GONE_MESSAGE })
    bodies.release()
    const done = await vi.waitFor(async () => {
      const response = await requestBytes(origin, next.headers.location!)
      expect(response.status).toBe(200)
      expect(json(response.body).progress!.done).toBe(true)
      return json(response.body)
    })
    expect(done.progress).toEqual({ id: replacement.id, revision: expect.any(Number), phase: 'collecting', total: 2, completed: 2, done: true })
    expect(h.bodyCalls()).toEqual([ALDER, BIRCH])
    // The failed list write, then the replacement body operation's successful presence write.
    expect(h.presenceCache.save).toHaveBeenCalledTimes(2)
    expect(h.presenceCache.value().map(entry => entry.companyId)).toEqual([ALDER, BIRCH])
  })

  it.each([
    ['an empty quoted respond-async value', 'respond-async="", orbit-progress=queued'],
    ['an empty-valued first respond-async followed by a duplicate', 'respond-async="", respond-async=later, orbit-progress=queued'],
  ])('treats %s as the negotiated request and answers the waiting 202 before the held list check is released', async (_label, prefer) => {
    const h = provenanceHarness()
    const lists = h.holdList(ALDER, BIRCH)
    const { service, presence } = await heldPresence(h, [ALDER, BIRCH])
    h.at(T('06:00:30.000'))
    const origin = await serve(service)
    const order = orderLedger()
    // Empty or omitted extension values never opt in: these two stay legacy async and wait for handoff.
    const emptyQuoted = order.watch('empty-quoted', requestBytes(origin, PATH, { Prefer: 'respond-async, orbit-progress=""' }))
    const emptyBare = order.watch('empty-bare', requestBytes(origin, PATH, { Prefer: 'respond-async, orbit-progress=' }))
    const started = await settles(requestBytes(origin, PATH, { Prefer: prefer }), 'the negotiated initial response')
    expect(started.status).toBe(202)
    expect(started.headers['preference-applied']).toBe('respond-async, orbit-progress=queued')
    expect(json(started.body).progress).toEqual({ id: expect.stringMatching(UUID), revision: 0, ...WAITING })
    expect(order.marks).toEqual([])
    const bodies = h.holdBody(ALDER, BIRCH)
    order.mark('lists-released')
    lists.release()
    const [quoted, bare] = await Promise.all([emptyQuoted, emptyBare])
    await presence
    for (const response of [quoted, bare]) {
      expect(response.status).toBe(202)
      expect(response.headers['preference-applied']).toBe('respond-async')
      expect(json(response.body).progress).toEqual({ id: json(started.body).progress!.id, revision: expect.any(Number), phase: 'collecting', total: 2, completed: 0, done: false })
    }
    expect(order.indexOf('empty-quoted')).toBeGreaterThan(order.indexOf('lists-released'))
    expect(order.indexOf('empty-bare')).toBeGreaterThan(order.indexOf('lists-released'))
    bodies.release()
    await pollUntil(origin, started.headers.location!, 200, { done: true })
    expect(h.bodyCalls()).toEqual([ALDER, BIRCH])
  })

  it('answers a status check queued behind a body operation that fails unexpectedly with the existing posting-status 503, starting no list work and inventing no list failure', async () => {
    const h = provenanceHarness({ onCacheError: () => { throw new Error('Fictional error reporter rejection') } })
    h.cache.save.mockImplementationOnce(async () => { throw new Error('Fictional body persistence failure') })
    const lists = h.holdList(ALDER, BIRCH)
    const { service, presence } = await heldPresence(h, [ALDER, BIRCH])
    h.at(T('06:00:30.000'))
    const statusEntries: { refresh: boolean; content: boolean | undefined; listCalls: string[]; bodyCalls: string[] }[] = []
    const origin = await serve(service, {
      onPostingStatus: (refresh, content) => { statusEntries.push({ refresh, content, listCalls: h.listCalls(), bodyCalls: h.bodyCalls() }) },
    })
    const started = await settles(requestBytes(origin, PATH, { Prefer: QUEUED_PREFER }), 'the negotiated initial response')
    expect(started.status).toBe(202)
    const id = json(started.body).progress!.id as string
    const bodies = h.holdBody(ALDER, BIRCH)
    lists.release()
    await presence
    const handoff = await pollUntil(origin, `/api/catalog/progress?id=${id}&after=0`, 200, { phase: 'collecting' })
    expect(json(handoff.body).progress).toEqual({ id, revision: expect.any(Number), phase: 'collecting', total: 2, completed: 0, done: false })
    await vi.waitFor(() => expect(h.bodyCalls()).toEqual([ALDER, BIRCH]))

    // A due status check arrives while bodies are held. The router's delegated call is the barrier:
    // once it has entered the real service with both body gates still closed, the request can only
    // be waiting behind those bodies, and it has neither started list work nor answered.
    h.at(T('06:01:30.000'))
    const order = orderLedger()
    const queuedStatus = order.watch('status', requestBytes(origin, '/api/posting-status?refresh=1'))
    await vi.waitFor(() => expect(statusEntries).toHaveLength(1))
    expect(statusEntries).toEqual([{ refresh: true, content: undefined, listCalls: [ALDER, BIRCH], bodyCalls: [ALDER, BIRCH] }])
    expect(h.listCalls()).toEqual([ALDER, BIRCH])
    expect(order.marks).toEqual([])

    // The response clock is pinned before the release that fails the operation, so retryAt is literal.
    const now = vi.spyOn(Date, 'now').mockReturnValue(Date.parse(T('06:01:30.000')))
    order.mark('bodies-released')
    bodies.release()
    const failed = await queuedStatus
    now.mockRestore()
    expect(order.marks).toEqual(['bodies-released', 'status'])
    expect(failed.status).toBe(503)
    expect(failed.headers['cache-control']).toBe('no-store')
    expect(failed.headers['retry-after']).toBe('60')
    expect(json(failed.body)).toEqual({ error: POSTING_STATUS_MESSAGE, retryAt: T('06:02:30.000') })
    expect(h.listCalls()).toEqual([ALDER, BIRCH])
    expect(h.bodyCalls()).toEqual([ALDER, BIRCH])

    // The operation itself reports the fixed failure; accepted bodies remain for ordinary requests.
    const poll = await requestBytes(origin, `/api/catalog/progress?id=${id}&after=0`)
    expect(poll.status).toBe(503)
    expect(poll.body.toString()).toBe(JSON.stringify(QUEUED_FAILURE_BODY))
    const memory = await requestBytes(origin, PATH, { Prefer: QUEUED_PREFER })
    expect(memory.status).toBe(200)
    expect(json(memory.body).boards).toEqual([collected(alder, T('06:00:30.000')), collected(birch, T('06:00:30.000'))])
    // No company list failure was recorded for work that never ran.
    const status = await requestBytes(origin, '/api/posting-status')
    expect(status.status).toBe(200)
    expect(json(status.body).boards.map(board => [board.companyId, board.status, board.lastSuccessAt, board.retryAt, board.message ?? null]))
      .toEqual([[ALDER, 'ok', T('06:00:30.000'), null, null], [BIRCH, 'ok', T('06:00:30.000'), null, null]])
    expect(h.listCalls()).toEqual([ALDER, BIRCH])
    // A later forced check follows the ordinary due policy and runs its own lists.
    const later = await requestBytes(origin, '/api/posting-status?refresh=1')
    expect(later.status).toBe(200)
    expect(json(later.body).boards.map(board => [board.companyId, board.status, board.lastSuccessAt])).toEqual([[ALDER, 'ok', T('06:01:30.000')], [BIRCH, 'ok', T('06:01:30.000')]])
    expect(h.listCalls()).toEqual([ALDER, BIRCH, ALDER, BIRCH])
  })
})

describe('capability negotiation at the router', () => {
  const index: PostingStatusIndex = {
    version: 1, checkedAt: SEARCH_TIME, refreshAfter: '2026-09-19T08:01:00.000Z',
    boards: [{
      companyId: SEARCH_COMPANIES[0].id, provider: 'greenhouse', board: SEARCH_COMPANIES[0].board!,
      checkedAt: SEARCH_TIME, lastSuccessAt: SEARCH_TIME, retryAt: null, status: 'ok',
      listing: { validUntil: '2026-09-19T08:30:00.000Z', publishedIds: ['greenhouse-search-fixture-a-progress-0'], jobs: [] },
    }],
  }
  function sources() {
    const getProgressiveCatalog = vi.fn(async (_refresh: boolean, queued?: boolean) => queued ? queuedWaiting('cold') : progressSnapshot(1))
    const getCatalog = vi.fn(async () => progressSnapshot(2).catalog)
    return { getCatalog, getProgressiveCatalog, getPostingStatus: async () => index, getCatalogProgress: () => null }
  }
  async function start(mocked: ReturnType<typeof sources>) {
    const app = express()
    app.use('/api', createApiRouter(mocked as unknown as Parameters<typeof createApiRouter>[0]))
    const server = await serveHttp(app)
    servers.push(server)
    return server.origin
  }
  type Outcome = 'queued' | 'legacy' | 'sync'
  const cases: [string, OutgoingHttpHeaders, Outcome][] = [
    ['the documented extended header', { Prefer: 'respond-async, orbit-progress=queued' }, 'queued'],
    ['mixed-case preference names', { Prefer: 'Respond-Async, Orbit-Progress=queued' }, 'queued'],
    ['a quoted value with the same content', { Prefer: 'respond-async, orbit-progress="queued"' }, 'queued'],
    ['the extension before respond-async', { Prefer: 'orbit-progress=queued, respond-async' }, 'queued'],
    ['a duplicate name whose first value is queued', { Prefer: 'respond-async, orbit-progress=queued, orbit-progress=legacy' }, 'queued'],
    ['two header lines', { Prefer: ['respond-async', 'orbit-progress=queued'] }, 'queued'],
    ['a value that differs only in case', { Prefer: 'respond-async, orbit-progress=Queued' }, 'legacy'],
    ['a duplicate name whose first value is unknown', { Prefer: 'respond-async, orbit-progress=legacy, orbit-progress=queued' }, 'legacy'],
    ['the parameter form of respond-async', { Prefer: 'respond-async; orbit-progress=queued' }, 'legacy'],
    ['the extension name without a value', { Prefer: 'respond-async, orbit-progress' }, 'legacy'],
    ['plain respond-async', { Prefer: 'respond-async' }, 'legacy'],
    ['an empty quoted respond-async value with the extension', { Prefer: 'respond-async="", orbit-progress=queued' }, 'queued'],
    ['an empty-valued first respond-async followed by a duplicate', { Prefer: 'respond-async="", respond-async=later, orbit-progress=queued' }, 'queued'],
    ['an empty quoted extension value', { Prefer: 'respond-async, orbit-progress=""' }, 'legacy'],
    ['an empty unquoted extension value', { Prefer: 'respond-async, orbit-progress=' }, 'legacy'],
    ['an empty quoted respond-async alone', { Prefer: 'respond-async=""' }, 'legacy'],
    ['the extension without respond-async', { Prefer: 'orbit-progress=queued' }, 'sync'],
    ['a quoted string that contains both tokens', { Prefer: 'x="respond-async, orbit-progress=queued"' }, 'sync'],
    ['no Prefer header', {}, 'sync'],
  ]

  it.each(cases)('handles %s', async (_label, headers, expected) => {
    const mocked = sources()
    const origin = await start(mocked)
    const response = await requestBytes(origin, PATH, headers)
    expect(response.headers.vary).toBe('Accept-Encoding, Prefer')
    if (expected === 'sync') {
      expect(response.status).toBe(200)
      expect(response.headers['preference-applied']).toBeUndefined()
      expect(response.headers['cache-control']).toBe('private, no-cache, must-revalidate')
      expect(json(response.body)).toEqual(progressSnapshot(2).catalog)
      expect(mocked.getCatalog).toHaveBeenCalledTimes(1)
      expect(mocked.getProgressiveCatalog).not.toHaveBeenCalled()
      return
    }
    expect(response.status).toBe(202)
    expect(response.headers['cache-control']).toBe('no-store')
    expect(response.headers['retry-after']).toBe('1')
    expect(mocked.getCatalog).not.toHaveBeenCalled()
    expect(mocked.getProgressiveCatalog).toHaveBeenCalledTimes(1)
    const [refresh, queued] = mocked.getProgressiveCatalog.mock.calls[0]
    expect(refresh).toBe(false)
    if (expected === 'queued') {
      expect(queued).toBe(true)
      expect(response.headers['preference-applied']).toBe('respond-async, orbit-progress=queued')
      expect(response.headers.location).toBe(`/api/catalog/progress?id=${QUEUED_ID}&after=0`)
      expect(json(response.body)).toEqual(queuedWaiting('cold'))
    } else {
      expect(Boolean(queued)).toBe(false)
      expect(response.headers['preference-applied']).toBe('respond-async')
      expect(response.headers.location).toBe(`/api/catalog/progress?id=${COLLECTION_ID}&after=1`)
      expect(json(response.body)).toEqual(progressSnapshot(1))
    }
  })

  it('forwards the refresh intent together with the negotiated capability', async () => {
    const mocked = sources()
    const origin = await start(mocked)
    const response = await requestBytes(origin, `${PATH}&refresh=1`, { Prefer: QUEUED_PREFER })
    expect(response.status).toBe(202)
    expect(mocked.getProgressiveCatalog.mock.calls).toEqual([[true, true]])
  })
})
