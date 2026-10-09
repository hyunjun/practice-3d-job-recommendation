import { expect, test } from '@playwright/test'
import { createHash } from 'node:crypto'
import { buildPublication } from '../../server/publication-build'
import type { BuiltPublication } from '../../server/publication-build'
import { BoardFetchError } from '../../server/catalog-service'
import type { CatalogPublicationCapture } from '../../server/catalog-service'
import { createPublicationClient } from '../../server/publication-client'
import { isPublicCatalog } from '../../src/lib/catalog-validation'
import { ObservationHistorySchema } from '../../shared/catalog-observations'
import { PostingStatusIndexSchema } from '../../shared/posting-status'
import type { PublicationHead, PublicationManifest } from '../../shared/publication'
import { projectCatalog, projectObservations, projectPostingStatus } from '../../worker/projection'
import {
  checkpointFrom, decodedFragment, FICTIONAL_COMMIT, GENERATION_FOUR, GENERATION_LETTERS, GENERATION_ONE, GENERATION_THREE,
  GENERATION_TWO, materialize, PUBLICATION_FAILURES, publicationHarness, RUN_ONE, stamp82,
} from '../fixtures/publication'
import type { PublicationGeneration } from '../fixtures/publication'
import {
  authorized, CONTRACT_TOKEN, contractClient, decodedBody, freezeClock, jsonBody, rawRequest, StreamRegistry, wipeStore,
} from './helpers/worker-http'
import type { RawResponse } from './helpers/worker-http'

/**
 * Stage82 common design v2: the real Worker entry and SQLite-backed CatalogStore
 * running in local workerd (tests/cloudflare/runtime/wrangler.test.jsonc). The
 * test process builds publications with the reviewed Node collector/builder and
 * drives the real publication client over HTTP. Expected bodies come from the
 * design text or from the pure projection assembled over the same bytes.
 *
 * The Worker clock is frozen at exact UTC milliseconds through the test-only
 * entry (`/__test/clock?at=`), so every clock-driven boundary below (30 min,
 * 24 h + 1 ms, 15 min idle, 2 h lifetime, 5 min retirement) is asserted at the
 * exact millisecond on both sides (MWT82-4/AWT82-3). Wall time still passes
 * between requests, but the product only reads Date.now().
 */
const T = stamp82
const ALDER_JOB = 'greenhouse-provenance-alder-7401'
const BIRCH_JOB = 'smartrecruiters-provenance-birch-7401'
const SECURITY = {
  'x-content-type-options': 'nosniff', 'referrer-policy': 'strict-origin-when-cross-origin',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()', 'x-frame-options': 'DENY',
} as const
const SUCCESS_CACHE = 'private, no-cache, must-revalidate'
const ETAG = /^W\/"[a-f0-9]{64}"$/
const UNAVAILABLE = { error: '공개 채용 게시판에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요.', code: 'CATALOG_UNAVAILABLE' }
const EXPIRED = { error: '게시판에 연결하지 못했어요. 마지막 정상 조회가 24시간을 지나 이전 공고를 표시하지 않습니다.', code: 'CATALOG_EXPIRED' }
const BUSY = { error: '공고 조회 요청이 많아요. 잠시 후 다시 확인해 주세요.', code: 'CATALOG_BUSY' }
const GONE = { error: '공고 자료가 갱신됐어요. 공고를 새로고침한 뒤 다시 확인해 주세요.', code: 'CATALOG_GENERATION_GONE' }
const CONFLICT = { error: '발행 기준 버전이 변경됐습니다.', code: 'PUBLISH_CONFLICT' }
const INCOMPLETE = { error: '발행 청크 업로드가 완료되지 않았습니다.', code: 'PUBLISH_INCOMPLETE' }
const BAD_PUBLICATION = { error: '발행 자료의 형식이 올바르지 않습니다.', code: 'PUBLISH_BAD_REQUEST' }
const API_NOT_FOUND = { error: '존재하지 않는 API입니다.' }
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const parent = (head: PublicationHead): PublicationHead => ({ revision: head.revision, generation: head.generation, publishedAt: head.publishedAt })
const compressedBytes = (...built: BuiltPublication[]) => built.reduce((sum, item) => sum + item.chunks.reduce((inner, chunk) => inner + chunk.byteLength, 0), 0)
const chunkCount = (...built: BuiltPublication[]) => built.reduce((sum, item) => sum + item.chunks.length, 0)
const plusMinutes = (iso: string, minutes: number) => new Date(Date.parse(iso) + minutes * 60_000).toISOString()

interface Captures {
  first: CatalogPublicationCapture
  second: CatalogPublicationCapture
  third: CatalogPublicationCapture
  /** 72 incompressible postings: at least two 1 MiB chunks. */
  bulk: CatalogPublicationCapture
  /** 320 incompressible postings: several megabytes so a paused reader keeps its stream open. */
  large: CatalogPublicationCapture
  /** Every list and body request failed: no board was ever fetched. */
  empty: CatalogPublicationCapture
}
let captures: Captures
test.beforeAll(async () => {
  const h = publicationHarness()
  const first = (await h.run()).capture
  h.at(T('06:30:00.000'))
  const second = (await h.run(checkpointFrom(first))).capture
  h.at(T('07:00:00.000'))
  const third = (await h.run(checkpointFrom(second))).capture
  const bulkHarness = publicationHarness()
  bulkHarness.bulkBody('provenance-alder', 72, 28000)
  const bulk = (await bulkHarness.run()).capture
  const largeHarness = publicationHarness()
  largeHarness.bulkBody('provenance-alder', 320, 28000)
  const large = (await largeHarness.run()).capture
  const emptyHarness = publicationHarness()
  emptyHarness.failEveryList(PUBLICATION_FAILURES.list)
  emptyHarness.fetchBoard.mockImplementation(async () => { throw new BoardFetchError(PUBLICATION_FAILURES.body) })
  const empty = (await emptyHarness.run()).capture
  captures = { first, second, third, bulk, large, empty }
})

// MWT82-1: generations keep the builder's UUID template type; URL paths below stay plain strings on purpose.
const build = (capture: CatalogPublicationCapture, generation: PublicationGeneration, head: PublicationHead | null = null) =>
  buildPublication(capture, FICTIONAL_COMMIT, head, generation)
const freezeAt = (origin: string, iso: string) => freezeClock(origin, iso)
function expectSecurity(response: RawResponse) {
  for (const [name, value] of Object.entries(SECURITY)) expect(response.headers[name], name).toBe(value)
  expect(response.headers.vary).toBe('Accept-Encoding')
  expect(response.headers['x-powered-by']).toBeUndefined()
}
function expectErrorEnvelope(response: RawResponse, status: number, body: Record<string, unknown>) {
  expect(response.status).toBe(status)
  expect(response.headers['cache-control']).toBe('no-store')
  expect(response.headers['content-type']).toBe('application/json; charset=utf-8')
  expectSecurity(response)
  expect(jsonBody(response)).toMatchObject(body)
  return jsonBody(response) as Record<string, unknown>
}
async function publish(origin: string, capture: CatalogPublicationCapture, generation: PublicationGeneration, head: PublicationHead | null = null) {
  const built = build(capture, generation, head)
  const published = await contractClient(origin).publish(built)
  return { built, head: published }
}
const catalogOf = (built: BuiltPublication, head: PublicationHead, at: string) =>
  JSON.parse(materialize(built, projectCatalog(built.manifest, head, Date.parse(at)))) as Record<string, any>
const postingOf = (built: BuiltPublication, at: string) =>
  JSON.parse(materialize(built, projectPostingStatus(built.manifest, Date.parse(at)))) as Record<string, any>
const observationsOf = (built: BuiltPublication, at: string) =>
  JSON.parse(materialize(built, projectObservations(built.manifest, Date.parse(at)))) as Record<string, any>
const beginRaw = (origin: string, text: string) => rawRequest(origin, '/__orbit/publish/begin', {
  method: 'POST', headers: authorized({ 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) }), body: text,
})
const commitRaw = (origin: string, body: unknown) => rawRequest(origin, '/__orbit/publish/commit', {
  method: 'POST', headers: authorized({ 'Content-Type': 'application/json' }), body: JSON.stringify(body),
})
const putChunkRaw = (origin: string, generation: string, index: number, bytes: Uint8Array) => rawRequest(origin, `/__orbit/publish/chunks/${generation}/${index}`, {
  method: 'PUT', headers: authorized({ 'Content-Type': 'application/octet-stream', 'Content-Length': bytes.byteLength }), body: Buffer.from(bytes),
})
const rollbackRaw = (origin: string, body: unknown) => rawRequest(origin, '/__orbit/publish/rollback', {
  method: 'POST', headers: authorized({ 'Content-Type': 'application/json' }), body: JSON.stringify(body),
})
const metricsOf = (origin: string) => contractClient(origin).metrics()
async function waitForIdleBodies(origin: string) {
  await expect.poll(async () => (await metricsOf(origin)).activeBodies, { timeout: 20_000 }).toBe(0)
}
const jobCount = (body: Buffer) => (JSON.parse(body.toString('utf8')) as { jobs: unknown[] }).jobs.length

test.beforeEach(async ({ baseURL }) => {
  await wipeStore(baseURL!)
  await freezeAt(baseURL!, T('06:05:00.000'))
})

test('an empty store answers the exact health shape, catalog/API errors and asset fallback', async ({ baseURL }) => {
  const origin = baseURL!
  const health = await rawRequest(origin, '/api/health')
  expect(health.status).toBe(200)
  expect(jsonBody(health)).toEqual({
    status: 'ok', app: 'orbit', mode: 'production', delivery: 'scheduled', generation: null, publishedAt: null,
    intervalMinutes: 30, boards: 0, usableBoards: 0, ready: false,
  })
  expect(health.headers['cache-control']).toBe('no-store')
  expect(health.headers['content-type']).toBe('application/json; charset=utf-8')
  expectSecurity(health)
  for (const path of ['/api/catalog', '/api/catalog?source=public', '/api/posting-status', '/api/observations']) {
    const body = expectErrorEnvelope(await rawRequest(origin, path), 503, UNAVAILABLE)
    expect(body.retryAt, path).toBe(T('06:06:00.000'))
  }
  for (const path of ['/api', '/api/', '/api/unknown', '/api/catalog/extra', '/api/health/x', '/api/Catalog']) {
    expectErrorEnvelope(await rawRequest(origin, path), 404, API_NOT_FOUND)
  }
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS']) {
    expectErrorEnvelope(await rawRequest(origin, '/api/catalog', { method }), 404, API_NOT_FOUND)
  }
  expectErrorEnvelope(await rawRequest(origin, '/api/catalog/progress'), 404, { error: '수집 진행 정보를 지원하지 않는 서버입니다.' })
  expectErrorEnvelope(await rawRequest(origin, '/api/catalog?source=other'), 400, { error: '지원하지 않는 데이터 소스입니다.' })
  expectErrorEnvelope(await rawRequest(origin, '/api/catalog?source=public&source=sample'), 400, { error: '지원하지 않는 데이터 소스입니다.' })
  expectErrorEnvelope(await rawRequest(origin, '/api/catalog?generation=not-a-uuid'), 400, { error: '잘못된 공고 자료 버전입니다.', code: 'CATALOG_BAD_GENERATION' })
  expectErrorEnvelope(await rawRequest(origin, `/api/catalog?generation=${GENERATION_ONE}&generation=${GENERATION_TWO}`), 400, { code: 'CATALOG_BAD_GENERATION' })
  expectErrorEnvelope(await rawRequest(origin, '/api/catalog?generation='), 400, { code: 'CATALOG_BAD_GENERATION' })
  expectErrorEnvelope(await rawRequest(origin, `/api/catalog?generation=${GENERATION_ONE}`), 410, GONE)
  expectErrorEnvelope(await rawRequest(origin, `/api/observations?generation=${GENERATION_ONE}`), 410, GONE)
  const headOnly = await rawRequest(origin, '/api/catalog', { method: 'HEAD' })
  expect(headOnly.status).toBe(503)
  expect(headOnly.headers['cache-control']).toBe('no-store')
  const shell = await rawRequest(origin, '/')
  expect(shell.status).toBe(200)
  expect(shell.headers['content-type']).toContain('text/html')
  expect(shell.body.toString('utf8')).toContain('data-fixture="orbit-worker-contract"')
  for (const [name, value] of Object.entries(SECURITY)) expect(shell.headers[name], name).toBe(value)
  const fallback = await rawRequest(origin, '/saved/anything/deeper')
  expect(fallback.status).toBe(200)
  expect(fallback.body.toString('utf8')).toContain('data-fixture="orbit-worker-contract"')
  const asset = await rawRequest(origin, '/assets/app-test.js')
  expect(asset.status).toBe(200)
  expect(asset.headers['cache-control']).toBe('public, max-age=31536000, immutable')
  expect(asset.body.toString('utf8')).toContain('orbit-worker-contract')
  // The platform consumes `_headers`; the rules file itself is never exposed.
  const headersFile = await rawRequest(origin, '/_headers')
  expect(headersFile.body.toString('utf8')).not.toContain('X-Frame-Options: DENY')
})

test('private routes authenticate before anything else and expose only the publication protocol', async ({ baseURL }) => {
  const origin = baseURL!
  const unauthorized = { error: '발행 인증이 필요합니다.', code: 'PUBLISH_UNAUTHORIZED' }
  const unreadBody = Buffer.alloc(16 * 1024, 123)
  const anonymousBegin = await rawRequest(origin, '/__orbit/publish/begin', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': unreadBody.length }, body: unreadBody,
  })
  expectErrorEnvelope(anonymousBegin, 401, unauthorized)
  expect(anonymousBegin.headers['www-authenticate']).toBe('Bearer')
  for (const [path, headers] of [
    ['/__orbit/publish', {}], ['/__orbit/publish/', {}], ['/__orbit/publish/head', {}],
    ['/__orbit/publish/head', { Authorization: `Bearer ${CONTRACT_TOKEN.slice(0, -1)}x` }],
    ['/__orbit/publish/head', { Authorization: `Bearer ${CONTRACT_TOKEN}x` }],
    ['/__orbit/publish/head', { Authorization: 'Bearer short' }],
    ['/__orbit/publish/head', { Authorization: `Basic ${Buffer.from(`user:${CONTRACT_TOKEN}`).toString('base64')}` }],
    ['/__orbit/publish/head', { Authorization: `bearer ${CONTRACT_TOKEN}` }],
    ['/__orbit/publish/metrics', {}], ['/__orbit/publish/checkpoint/boards', {}], ['/__orbit/publish/unknown', {}],
  ] as [string, Record<string, string>][]) {
    const response = await rawRequest(origin, path, { headers })
    expectErrorEnvelope(response, 401, unauthorized)
    expect(response.headers['www-authenticate'], path).toBe('Bearer')
  }
  expect(GENERATION_LETTERS.toUpperCase()).not.toBe(GENERATION_LETTERS)
  expectErrorEnvelope(await rawRequest(origin, '/__orbit/publish', { headers: authorized() }), 404, { error: '존재하지 않는 발행 경로입니다.', code: 'PUBLISH_NOT_FOUND' })
  expectErrorEnvelope(await rawRequest(origin, '/__orbit/publish/', { headers: authorized() }), 404, { code: 'PUBLISH_NOT_FOUND' })
  expectErrorEnvelope(await rawRequest(origin, '/__orbit/publish/head', { method: 'DELETE', headers: authorized() }), 404, { code: 'PUBLISH_NOT_FOUND' })
  expectErrorEnvelope(await rawRequest(origin, '/__orbit/publish/head', { method: 'POST', headers: authorized(), body: '{}' }), 404, { code: 'PUBLISH_NOT_FOUND' })
  expectErrorEnvelope(await rawRequest(origin, '/__orbit/publish/begin', { headers: authorized() }), 404, { code: 'PUBLISH_NOT_FOUND' })
  expectErrorEnvelope(await rawRequest(origin, '/__orbit/publish/checkpoint/other', { headers: authorized() }), 404, { code: 'PUBLISH_NOT_FOUND' })
  expectErrorEnvelope(await rawRequest(origin, '/__orbit/publish/chunks/not-a-uuid/0', { method: 'PUT', headers: authorized(), body: 'x' }), 404, { code: 'PUBLISH_NOT_FOUND' })
  expectErrorEnvelope(await rawRequest(origin, `/__orbit/publish/chunks/${GENERATION_LETTERS.toUpperCase()}/0`, { method: 'PUT', headers: authorized(), body: 'x' }), 404, { code: 'PUBLISH_NOT_FOUND' })
  expectErrorEnvelope(await rawRequest(origin, `/__orbit/publish/chunks/${GENERATION_ONE}/64`, { method: 'PUT', headers: authorized(), body: 'x' }), 404, { code: 'PUBLISH_NOT_FOUND' })
  expectErrorEnvelope(await rawRequest(origin, `/__orbit/publish/chunks/${GENERATION_ONE}/00`, { method: 'PUT', headers: authorized(), body: 'x' }), 404, { code: 'PUBLISH_NOT_FOUND' })
  expectErrorEnvelope(await rawRequest(origin, `/__orbit/publish/chunks/${GENERATION_ONE}/0`, { method: 'PUT', headers: authorized(), body: 'x' }), 409, CONFLICT)
  expectErrorEnvelope(await rawRequest(origin, '/__orbit/publish/checkpoint/boards', { headers: authorized() }), 409, CONFLICT)
  expectErrorEnvelope(await rawRequest(origin, '/__orbit/publish/commit', { method: 'POST', headers: authorized(), body: 'not json' }), 400, BAD_PUBLICATION)
  expectErrorEnvelope(await rawRequest(origin, '/__orbit/publish/commit', { method: 'POST', headers: authorized(), body: JSON.stringify({ generation: GENERATION_ONE }) }), 409, CONFLICT)
  expectErrorEnvelope(await rawRequest(origin, '/__orbit/publish/rollback', { method: 'POST', headers: authorized(), body: JSON.stringify({ generation: GENERATION_ONE, parent: { revision: 1, generation: GENERATION_TWO } }) }), 409, CONFLICT)
  const head = await rawRequest(origin, '/__orbit/publish/head', { headers: authorized() })
  expect(head.status).toBe(200)
  expect(jsonBody(head)).toEqual({ head: null, manifest: null })
  expect(head.headers['cache-control']).toBe('no-store')
  expectSecurity(head)
  const headOnly = await rawRequest(origin, '/__orbit/publish/head', { method: 'HEAD', headers: authorized() })
  expect(headOnly.status).toBe(200)
  const metrics = await metricsOf(origin)
  expect(metrics).toMatchObject({
    chunks: 0, generations: 0, staging: null, activeBodies: 0, peakBodies: 0, activeGenerations: 0,
    payloadBytes: 0, explicitChunkCacheEntries: 1,
  })
  expect(await contractClient(origin).head()).toEqual({ head: null, manifest: null })
})

test('a first publication is served with the exact catalog, posting-status and observation contracts, validators and encodings', async ({ baseURL }) => {
  const origin = baseURL!
  // A letter-bearing generation, so the uppercase public alias really exercises case folding (MWT82-2/AWT82-2).
  const { built, head } = await publish(origin, captures.first, GENERATION_LETTERS)
  expect(head).toEqual({ revision: 1, generation: GENERATION_LETTERS, publishedAt: T('06:05:00.000') })
  expect(jsonBody(await rawRequest(origin, '/api/health'))).toEqual({
    status: 'ok', app: 'orbit', mode: 'production', delivery: 'scheduled', generation: GENERATION_LETTERS, publishedAt: T('06:05:00.000'),
    intervalMinutes: 30, boards: 2, usableBoards: 2, ready: true,
  })
  const catalog = await rawRequest(origin, '/api/catalog?source=public')
  expect(catalog.status).toBe(200)
  expect(catalog.headers['content-type']).toBe('application/json; charset=utf-8')
  expect(catalog.headers['cache-control']).toBe(SUCCESS_CACHE)
  expect(catalog.headers['x-orbit-generation']).toBe(GENERATION_LETTERS)
  expect(catalog.headers.etag).toMatch(ETAG)
  expect(catalog.headers['content-encoding']).toBeUndefined()
  expectSecurity(catalog)
  const body = jsonBody(catalog) as Record<string, any>
  expect(body).toEqual(catalogOf(built, head, T('06:05:00.000')))
  expect(isPublicCatalog(body)).toBe(true)
  expect(body.publication).toEqual({ mode: 'scheduled', generation: GENERATION_LETTERS, publishedAt: T('06:05:00.000'), intervalMinutes: 30 })
  expect(body.jobs.map((job: { id: string; stale: boolean }) => [job.id, job.stale])).toEqual([[ALDER_JOB, false], [BIRCH_JOB, false]])
  expect([body.fetchedAt, body.refreshAfter, body.stale]).toEqual([RUN_ONE, T('06:01:00.000'), false])
  expect(body.boards.map((board: { dataStatus: string; lastSuccessAt: string }) => [board.dataStatus, board.lastSuccessAt])).toEqual([['fresh', RUN_ONE], ['fresh', RUN_ONE]])
  for (const alias of ['/api/catalog', '/api/catalog?source=sample', '/api/catalog?source=greenhouse', `/api/catalog?generation=${GENERATION_LETTERS}`, `/api/catalog?generation=${GENERATION_LETTERS.toUpperCase()}`]) {
    const same = await rawRequest(origin, alias)
    expect(same.status, alias).toBe(200)
    expect(same.headers.etag, alias).toBe(catalog.headers.etag)
    expect(same.headers['x-orbit-generation'], alias).toBe(GENERATION_LETTERS)
    expect(jsonBody(same), alias).toEqual(body)
  }
  const headResponse = await rawRequest(origin, '/api/catalog', { method: 'HEAD' })
  expect([headResponse.status, headResponse.headers.etag, headResponse.headers['cache-control'], headResponse.headers['x-orbit-generation']])
    .toEqual([200, catalog.headers.etag, SUCCESS_CACHE, GENERATION_LETTERS])
  const etag = catalog.headers.etag!
  for (const validator of [etag, '*', `"other", ${etag}`, etag.slice(2), `W/"x", ${etag}, "y"`, `,${etag},`, ` ${etag}\t`]) {
    const revalidated = await rawRequest(origin, '/api/catalog', { headers: { 'If-None-Match': validator } })
    expect(revalidated.status, validator).toBe(304)
    expect(revalidated.body.length, validator).toBe(0)
    expect([revalidated.headers.etag, revalidated.headers['cache-control'], revalidated.headers.vary, revalidated.headers['x-orbit-generation']])
      .toEqual([etag, SUCCESS_CACHE, 'Accept-Encoding', GENERATION_LETTERS])
    expect(revalidated.headers['content-encoding']).toBeUndefined()
  }
  for (const validator of ['"x,*,y"', '"unrelated"', `${etag}, *`, `${etag} "x"`, 'W/', etag.toLowerCase().replace('W/', 'w/')]) {
    const fresh = await rawRequest(origin, '/api/catalog', { headers: { 'If-None-Match': validator } })
    expect(fresh.status, validator).toBe(200)
    expect(jsonBody(fresh), validator).toEqual(body)
  }
  const identityBytes = catalog.body
  const gzipped = await rawRequest(origin, '/api/catalog', { headers: { 'Accept-Encoding': 'gzip' } })
  expect(gzipped.status).toBe(200)
  expect(gzipped.headers['content-encoding']).toBe('gzip')
  expect(gzipped.headers.etag).toBe(etag)
  expect(gzipped.headers.vary).toBe('Accept-Encoding')
  expect(decodedBody(gzipped).equals(identityBytes)).toBe(true)
  const brotli = await rawRequest(origin, '/api/catalog', { headers: { 'Accept-Encoding': 'identity;q=0, br, gzip;q=0.5' } })
  expect(brotli.headers['content-encoding']).toBe('br')
  expect(brotli.headers.etag).toBe(etag)
  expect(decodedBody(brotli).equals(identityBytes)).toBe(true)
  const tie = await rawRequest(origin, '/api/catalog', { headers: { 'Accept-Encoding': 'gzip, br' } })
  expect(tie.headers['content-encoding']).toBe('br')
  const unknownEncoding = await rawRequest(origin, '/api/catalog', { headers: { 'Accept-Encoding': 'deflate' } })
  expect(unknownEncoding.headers['content-encoding']).toBeUndefined()
  expect(unknownEncoding.body.equals(identityBytes)).toBe(true)
  const refused = await rawRequest(origin, '/api/catalog', { headers: { 'Accept-Encoding': 'identity;q=0, gzip;q=0, br;q=0' } })
  expectErrorEnvelope(refused, 406, { error: '지원하는 응답 인코딩을 선택해 주세요.' })
  const refusedStar = await rawRequest(origin, '/api/health', { headers: { 'Accept-Encoding': '*;q=0' } })
  expectErrorEnvelope(refusedStar, 406, { error: '지원하는 응답 인코딩을 선택해 주세요.' })
  // Error bodies are never withheld for a missing encoding; they are delivered as identity.
  const refusedError = await rawRequest(origin, '/api/unknown', { headers: { 'Accept-Encoding': '*;q=0' } })
  expectErrorEnvelope(refusedError, 404, API_NOT_FOUND)
  expect(refusedError.headers['content-encoding']).toBeUndefined()
  const posting = await rawRequest(origin, '/api/posting-status')
  expect(posting.status).toBe(200)
  expect(posting.headers['x-orbit-generation']).toBe(GENERATION_LETTERS)
  expect(posting.headers.etag).toMatch(ETAG)
  expect(posting.headers.etag).not.toBe(etag)
  expect(posting.headers['cache-control']).toBe(SUCCESS_CACHE)
  const index = jsonBody(posting) as Record<string, any>
  expect(index).toEqual(postingOf(built, T('06:05:00.000')))
  expect(index).toEqual(captures.first.postingStatus)
  expect(PostingStatusIndexSchema.safeParse(index).success).toBe(true)
  expect([index.version, index.checkedAt, index.refreshAfter, index.contentRefreshAfter]).toEqual([2, RUN_ONE, T('06:01:00.000'), T('06:01:00.000')])
  expect(index.boards[0].listing).toMatchObject({ publishedIds: [ALDER_JOB], content: { status: 'ok', jobIds: [ALDER_JOB] } })
  expect(index.boards[0].listing.jobs).toHaveLength(1)
  const postingAlias = await rawRequest(origin, '/api/posting-status?refresh=1&content=1')
  expect(postingAlias.status).toBe(200)
  expect(jsonBody(postingAlias)).toEqual(index)
  const observations = await rawRequest(origin, '/api/observations')
  expect(observations.status).toBe(200)
  expect(observations.headers['x-orbit-generation']).toBe(GENERATION_LETTERS)
  expect(observations.headers.etag).toMatch(ETAG)
  const history = jsonBody(observations) as Record<string, any>
  expect(history).toEqual(observationsOf(built, T('06:05:00.000')))
  expect(history).toEqual(captures.first.history)
  expect(ObservationHistorySchema.safeParse(history).success).toBe(true)
  expect([history.version, history.retentionDays, history.storage]).toEqual([1, 90, 'ok'])
  expectErrorEnvelope(await rawRequest(origin, `/api/catalog?generation=${GENERATION_TWO}`), 410, GONE)
  // Idempotent re-submission of the committed generation; a different body for the same generation is a conflict.
  const again = await beginRaw(origin, built.manifestText)
  expect(again.status).toBe(200)
  expect(jsonBody(again)).toEqual({ committed: true, head })
  expect(jsonBody(await commitRaw(origin, { generation: GENERATION_LETTERS }))).toEqual({ head })
  expectErrorEnvelope(await commitRaw(origin, { generation: GENERATION_LETTERS.toUpperCase() }), 400, BAD_PUBLICATION)
  expect(jsonBody(await putChunkRaw(origin, GENERATION_LETTERS, 0, built.chunks[0]))).toEqual({
    generation: GENERATION_LETTERS, index: 0, hash: built.manifest.chunks[0].hash, bytes: built.manifest.chunks[0].bytes,
  })
  const differentBytes = JSON.parse(built.manifestText) as PublicationManifest
  differentBytes.capture.collectorCommit = 'f'.repeat(40)
  differentBytes.checkpoint.capture.collectorCommit = 'f'.repeat(40)
  expectErrorEnvelope(await beginRaw(origin, JSON.stringify(differentBytes)), 409, CONFLICT)
  const stored = await contractClient(origin).head()
  expect(stored.head).toEqual(head)
  expect(stored.manifest).toEqual(built.manifest)
  expect(await metricsOf(origin)).toMatchObject({
    generations: 1, chunks: built.chunks.length, staging: null, activeBodies: 0, payloadBytes: compressedBytes(built),
  })
})

test('staleness and expiry follow the Worker clock at the exact millisecond, never the publication time', async ({ baseURL }) => {
  const origin = baseURL!
  const { built, head } = await publish(origin, captures.first, GENERATION_ONE)
  const freshEtag = (await rawRequest(origin, '/api/catalog')).headers.etag!
  await freezeAt(origin, T('06:29:59.999'))
  const lastFresh = jsonBody(await rawRequest(origin, '/api/catalog')) as Record<string, any>
  expect(lastFresh.stale).toBe(false)
  expect(lastFresh.boards.map((board: { dataStatus: string }) => board.dataStatus)).toEqual(['fresh', 'fresh'])
  await freezeAt(origin, T('06:30:00.000'))
  const stale = await rawRequest(origin, '/api/catalog')
  expect(stale.status).toBe(200)
  const staleBody = jsonBody(stale) as Record<string, any>
  expect(staleBody).toEqual(catalogOf(built, head, T('06:30:00.000')))
  expect(staleBody.stale).toBe(true)
  expect(staleBody.boards.map((board: { dataStatus: string }) => board.dataStatus)).toEqual(['stale', 'stale'])
  expect(staleBody.jobs.map((job: { id: string; stale: boolean; fetchedAt: string }) => [job.id, job.stale, job.fetchedAt]))
    .toEqual([[ALDER_JOB, true, RUN_ONE], [BIRCH_JOB, true, RUN_ONE]])
  expect([staleBody.fetchedAt, staleBody.refreshAfter]).toEqual([RUN_ONE, T('06:01:00.000')])
  expect(staleBody.publication.publishedAt).toBe(T('06:05:00.000'))
  expect(stale.headers.etag).toMatch(ETAG)
  expect(stale.headers.etag).not.toBe(freshEtag)
  expect((await rawRequest(origin, '/api/catalog', { headers: { 'If-None-Match': freshEtag } })).status).toBe(200)
  expect((await rawRequest(origin, '/api/catalog', { headers: { 'If-None-Match': stale.headers.etag! } })).status).toBe(304)
  const index = jsonBody(await rawRequest(origin, '/api/posting-status')) as Record<string, any>
  expect(index).toEqual(postingOf(built, T('06:30:00.000')))
  expect(index.boards[0].listing).toMatchObject({ jobs: [], publishedIds: [ALDER_JOB], content: { checkedAt: RUN_ONE, status: 'ok', jobIds: [ALDER_JOB] } })
  expect(index.boards[1].listing).toMatchObject({ jobs: [], publishedIds: [BIRCH_JOB], content: { checkedAt: RUN_ONE, status: 'ok', jobIds: [BIRCH_JOB] } })
  expect(jsonBody(await rawRequest(origin, '/api/health'))).toMatchObject({ usableBoards: 2, ready: true })

  await freezeAt(origin, '2026-10-04T06:00:00.000Z')
  const lastUsable = await rawRequest(origin, '/api/catalog')
  expect(lastUsable.status).toBe(200)
  expect(jsonBody(lastUsable)).toEqual(catalogOf(built, head, '2026-10-04T06:00:00.000Z'))
  expect(jsonBody(await rawRequest(origin, '/api/health'))).toMatchObject({ usableBoards: 2, ready: true })
  const lastListing = jsonBody(await rawRequest(origin, '/api/posting-status')) as Record<string, any>
  expect(lastListing.boards.every((board: { listing?: unknown }) => 'listing' in board)).toBe(true)
  await freezeAt(origin, '2026-10-04T06:00:00.001Z')
  const expired = expectErrorEnvelope(await rawRequest(origin, '/api/catalog'), 503, EXPIRED)
  expect(expired.retryAt).toBe(T('06:01:00.000'))
  expect((await rawRequest(origin, '/api/catalog', { headers: { 'If-None-Match': stale.headers.etag! } })).status).toBe(503)
  expect((await rawRequest(origin, '/api/catalog', { method: 'HEAD' })).status).toBe(503)
  expect(jsonBody(await rawRequest(origin, '/api/health'))).toEqual({
    status: 'ok', app: 'orbit', mode: 'production', delivery: 'scheduled', generation: GENERATION_ONE, publishedAt: T('06:05:00.000'),
    intervalMinutes: 30, boards: 2, usableBoards: 0, ready: false,
  })
  const listingGone = await rawRequest(origin, '/api/posting-status')
  expect(listingGone.status).toBe(200)
  const goneIndex = jsonBody(listingGone) as Record<string, any>
  expect(goneIndex).toEqual(postingOf(built, '2026-10-04T06:00:00.001Z'))
  expect(goneIndex.boards.map((board: { status: string }) => [board.status, 'listing' in board])).toEqual([['ok', false], ['ok', false]])
  expect((jsonBody(await rawRequest(origin, '/api/observations')) as Record<string, any>).days.map((day: { day: string }) => day.day)).toEqual(['2026-10-03'])
  // UTC 90-day window: the day 89 days later still shows the publication day; the next day drops it.
  await freezeAt(origin, '2026-12-31T23:59:59.999Z')
  expect((jsonBody(await rawRequest(origin, '/api/observations')) as Record<string, any>).days.map((day: { day: string }) => day.day)).toEqual(['2026-10-03'])
  await freezeAt(origin, '2027-01-01T00:00:00.000Z')
  const retired = jsonBody(await rawRequest(origin, '/api/observations')) as Record<string, any>
  expect(retired).toEqual(observationsOf(built, '2027-01-01T00:00:00.000Z'))
  expect(retired.days).toEqual([])
  expect(retired.storage).toBe('ok')
})

test('successive publications pin generations, serve the private checkpoint of the exact current head and retire old data exactly five minutes later', async ({ baseURL }) => {
  const origin = baseURL!
  const one = await publish(origin, captures.first, GENERATION_ONE)
  await freezeAt(origin, T('06:35:00.000'))
  const two = await publish(origin, captures.second, GENERATION_TWO, parent(one.head))
  await freezeAt(origin, T('07:05:00.000'))
  const three = await publish(origin, captures.third, GENERATION_THREE, parent(two.head))
  expect([one.head, two.head, three.head].map(head => [head.revision, head.publishedAt])).toEqual([[1, T('06:05:00.000')], [2, T('06:35:00.000')], [3, T('07:05:00.000')]])
  const current = await rawRequest(origin, '/api/catalog')
  expect(current.headers['x-orbit-generation']).toBe(GENERATION_THREE)
  const currentBody = jsonBody(current) as Record<string, any>
  expect(currentBody).toEqual(catalogOf(three.built, three.head, T('07:05:00.000')))
  expect(currentBody.publication).toEqual({ mode: 'scheduled', generation: GENERATION_THREE, publishedAt: T('07:05:00.000'), intervalMinutes: 30 })
  expect(currentBody.jobs.map((job: { fetchedAt: string }) => job.fetchedAt)).toEqual([T('07:00:00.000'), T('07:00:00.000')])
  for (const [generation, built, head, fetchedAt] of [
    [GENERATION_ONE, one.built, one.head, RUN_ONE], [GENERATION_TWO, two.built, two.head, T('06:30:00.000')],
  ] as [string, BuiltPublication, PublicationHead, string][]) {
    const pinned = await rawRequest(origin, `/api/catalog?generation=${generation}`)
    expect(pinned.status, generation).toBe(200)
    expect(pinned.headers['x-orbit-generation']).toBe(generation)
    const body = jsonBody(pinned) as Record<string, any>
    expect(body).toEqual(catalogOf(built, head, T('07:05:00.000')))
    expect(body.publication).toEqual({ mode: 'scheduled', generation, publishedAt: head.publishedAt, intervalMinutes: 30 })
    expect(body.jobs.map((job: { fetchedAt: string }) => job.fetchedAt)).toEqual([fetchedAt, fetchedAt])
    const pinnedHistory = await rawRequest(origin, `/api/observations?generation=${generation}`)
    expect(pinnedHistory.headers['x-orbit-generation']).toBe(generation)
    expect(jsonBody(pinnedHistory)).toEqual(observationsOf(built, T('07:05:00.000')))
    const pinnedIndex = await rawRequest(origin, `/api/posting-status?generation=${generation}`)
    expect(pinnedIndex.headers['x-orbit-generation']).toBe(generation)
    expect(jsonBody(pinnedIndex)).toEqual(postingOf(built, T('07:05:00.000')))
  }
  const stored = await contractClient(origin).head()
  expect(stored.head).toEqual(three.head)
  expect(stored.manifest).toEqual(three.built.manifest)
  const files = await contractClient(origin).checkpoint(three.head, three.built.manifest)
  for (const name of ['boards', 'presence', 'observations'] as const) {
    const fragmentName = three.built.manifest.checkpoint.files[name]
    const expected = decodedFragment(three.built, fragmentName)
    expect(Buffer.from(files[name]).equals(expected), name).toBe(true)
    const raw = await rawRequest(origin, `/__orbit/publish/checkpoint/${name}?generation=${GENERATION_THREE}`, { headers: authorized() })
    expect(raw.status).toBe(200)
    expect(raw.headers['x-orbit-generation']).toBe(GENERATION_THREE)
    expect(raw.headers['cache-control']).toBe('no-store')
    expect(raw.headers.etag).toBeUndefined()
    expectSecurity(raw)
    expect(sha256(raw.body)).toBe(three.built.manifest.fragments[fragmentName].decodedHash)
    const headOnly = await rawRequest(origin, `/__orbit/publish/checkpoint/${name}?generation=${GENERATION_THREE}`, { method: 'HEAD', headers: authorized() })
    expect(headOnly.status).toBe(200)
  }
  expectErrorEnvelope(await rawRequest(origin, `/__orbit/publish/checkpoint/boards?generation=${GENERATION_TWO}`, { headers: authorized() }), 409, CONFLICT)
  expectErrorEnvelope(await rawRequest(origin, `/__orbit/publish/checkpoint/boards?generation=${GENERATION_ONE}`, { headers: authorized() }), 409, CONFLICT)
  expectErrorEnvelope(await rawRequest(origin, '/__orbit/publish/checkpoint/boards', { headers: authorized() }), 409, CONFLICT)
  expectErrorEnvelope(await rawRequest(origin, '/__orbit/publish/checkpoint/boards?generation=bad', { headers: authorized() }), 400, { code: 'CATALOG_BAD_GENERATION' })
  expect(await metricsOf(origin)).toMatchObject({
    generations: 3, chunks: chunkCount(one.built, two.built, three.built), staging: null,
    payloadBytes: compressedBytes(one.built, two.built, three.built),
  })
  // Retirement: generation one was retired when three was installed (07:05:00.000); the sweep (run on begin)
  // removes it exactly five minutes later, never one millisecond earlier.
  await freezeAt(origin, T('07:09:59.999'))
  expect(jsonBody(await beginRaw(origin, three.built.manifestText))).toEqual({ committed: true, head: three.head })
  expect((await rawRequest(origin, `/api/catalog?generation=${GENERATION_ONE}`)).status).toBe(200)
  expect(await metricsOf(origin)).toMatchObject({ generations: 3 })
  await freezeAt(origin, T('07:10:00.000'))
  expect(jsonBody(await beginRaw(origin, three.built.manifestText))).toEqual({ committed: true, head: three.head })
  expectErrorEnvelope(await rawRequest(origin, `/api/catalog?generation=${GENERATION_ONE}`), 410, GONE)
  expectErrorEnvelope(await rawRequest(origin, `/api/posting-status?generation=${GENERATION_ONE}`), 410, GONE)
  expect((await rawRequest(origin, `/api/catalog?generation=${GENERATION_TWO}`)).status).toBe(200)
  expect((await rawRequest(origin, `/api/catalog?generation=${GENERATION_THREE}`)).status).toBe(200)
  expect(await metricsOf(origin)).toMatchObject({
    generations: 2, chunks: chunkCount(two.built, three.built), payloadBytes: compressedBytes(two.built, three.built),
  })
})

test('publication admission: parent CAS, one staging at a time, exact chunk checks, idempotent retries and exact idle expiry', async ({ baseURL }) => {
  const origin = baseURL!
  const one = await publish(origin, captures.first, GENERATION_ONE)
  // The second capture is dated 06:30; admission needs a request time within five minutes of it (AWT82-3).
  await freezeAt(origin, T('06:35:00.000'))
  const orphan = build(captures.second, GENERATION_LETTERS, null)
  expectErrorEnvelope(await beginRaw(origin, orphan.manifestText), 409, CONFLICT)
  const wrongRevision = build(captures.second, GENERATION_LETTERS, { ...one.head, revision: 5 })
  expectErrorEnvelope(await beginRaw(origin, wrongRevision.manifestText), 409, CONFLICT)
  const wrongGeneration = build(captures.second, GENERATION_LETTERS, { ...one.head, generation: GENERATION_FOUR })
  expectErrorEnvelope(await beginRaw(origin, wrongGeneration.manifestText), 409, CONFLICT)
  expect((await metricsOf(origin)).staging).toBeNull()
  const two = build(captures.second, GENERATION_LETTERS, parent(one.head))
  expect(jsonBody(await beginRaw(origin, two.manifestText))).toEqual({ committed: false, generation: GENERATION_LETTERS })
  expect((await metricsOf(origin)).staging).toBe(GENERATION_LETTERS)
  expect(jsonBody(await beginRaw(origin, two.manifestText))).toEqual({ committed: false, generation: GENERATION_LETTERS })
  const competing = build(captures.second, GENERATION_THREE, parent(one.head))
  expectErrorEnvelope(await beginRaw(origin, competing.manifestText), 409, CONFLICT)
  expectErrorEnvelope(await rollbackRaw(origin, { generation: GENERATION_FOUR, parent: { revision: 1, generation: GENERATION_ONE } }), 409, CONFLICT)
  const corrupted = Buffer.from(two.chunks[0])
  corrupted[corrupted.length - 1] ^= 0xff
  expectErrorEnvelope(await putChunkRaw(origin, GENERATION_LETTERS, 0, corrupted), 400, BAD_PUBLICATION)
  expectErrorEnvelope(await putChunkRaw(origin, GENERATION_LETTERS, 0, two.chunks[0].subarray(0, two.chunks[0].byteLength - 1)), 400, BAD_PUBLICATION)
  expectErrorEnvelope(await putChunkRaw(origin, GENERATION_LETTERS, two.chunks.length, two.chunks[0]), 409, CONFLICT)
  expectErrorEnvelope(await putChunkRaw(origin, GENERATION_THREE, 0, two.chunks[0]), 409, CONFLICT)
  expectErrorEnvelope(await commitRaw(origin, { generation: GENERATION_LETTERS }), 409, INCOMPLETE)
  expect((await metricsOf(origin)).chunks).toBe(one.built.chunks.length)
  const ack = { generation: GENERATION_LETTERS, index: 0, hash: two.manifest.chunks[0].hash, bytes: two.manifest.chunks[0].bytes }
  expect(jsonBody(await putChunkRaw(origin, GENERATION_LETTERS, 0, two.chunks[0]))).toEqual(ack)
  expect(jsonBody(await putChunkRaw(origin, GENERATION_LETTERS, 0, two.chunks[0]))).toEqual(ack)
  for (const [index, chunk] of two.chunks.slice(1).entries()) {
    expect((await putChunkRaw(origin, GENERATION_LETTERS, index + 1, chunk)).status).toBe(200)
  }
  expectErrorEnvelope(await commitRaw(origin, { generation: 'bad' }), 400, BAD_PUBLICATION)
  expectErrorEnvelope(await commitRaw(origin, { generation: GENERATION_LETTERS, extra: 1 }), 400, BAD_PUBLICATION)
  // The staged generation itself, uppercased: letter-bearing, fully uploaded, yet refused by the lowercase rule.
  expectErrorEnvelope(await commitRaw(origin, { generation: GENERATION_LETTERS.toUpperCase() }), 400, BAD_PUBLICATION)
  expectErrorEnvelope(await commitRaw(origin, [GENERATION_LETTERS]), 400, BAD_PUBLICATION)
  expectErrorEnvelope(await commitRaw(origin, { generation: GENERATION_THREE }), 409, CONFLICT)
  expect((await metricsOf(origin)).staging).toBe(GENERATION_LETTERS)
  const committed = await commitRaw(origin, { generation: GENERATION_LETTERS })
  expect(committed.status).toBe(200)
  const head2 = (jsonBody(committed) as { head: PublicationHead }).head
  expect(head2).toEqual({ revision: 2, generation: GENERATION_LETTERS, publishedAt: T('06:35:00.000') })
  expect(jsonBody(await commitRaw(origin, { generation: GENERATION_LETTERS }))).toEqual({ head: head2 })
  expect(jsonBody(await beginRaw(origin, two.manifestText))).toEqual({ committed: true, head: head2 })
  expect(await metricsOf(origin)).toMatchObject({ generations: 2, chunks: chunkCount(one.built, two), staging: null })
  expect((jsonBody(await rawRequest(origin, '/api/catalog')) as Record<string, any>).publication.generation).toBe(GENERATION_LETTERS)
  // A capture dated more than five minutes into the Worker's future cannot begin: exact boundary on both sides.
  const three = build(captures.third, GENERATION_THREE, parent(head2))
  await freezeAt(origin, T('06:54:59.999'))
  expectErrorEnvelope(await beginRaw(origin, three.manifestText), 400, BAD_PUBLICATION)
  expect((await metricsOf(origin)).staging).toBeNull()
  await freezeAt(origin, T('06:55:00.000'))
  expect(jsonBody(await beginRaw(origin, three.manifestText))).toEqual({ committed: false, generation: GENERATION_THREE })
  // Invalid begin bodies never alter staging, each refused by its own rule now that the capture time is admissible.
  expectErrorEnvelope(await beginRaw(origin, '{"version":1,'), 400, BAD_PUBLICATION)
  expectErrorEnvelope(await beginRaw(origin, '[]'), 400, BAD_PUBLICATION)
  const mismatchedCapture = JSON.parse(three.manifestText) as PublicationManifest
  mismatchedCapture.capture.collectorCommit = 'e'.repeat(40)
  expectErrorEnvelope(await beginRaw(origin, JSON.stringify(mismatchedCapture)), 400, BAD_PUBLICATION)
  const rollbackMarker = JSON.parse(three.manifestText) as PublicationManifest
  rollbackMarker.rollbackOf = GENERATION_ONE
  expectErrorEnvelope(await beginRaw(origin, JSON.stringify(rollbackMarker)), 400, BAD_PUBLICATION)
  const foreignOwner = JSON.parse(three.manifestText) as PublicationManifest
  foreignOwner.chunks[0].owner = GENERATION_TWO
  expectErrorEnvelope(await beginRaw(origin, JSON.stringify(foreignOwner)), 400, BAD_PUBLICATION)
  const wrongConfig = JSON.parse(three.manifestText) as PublicationManifest
  wrongConfig.capture.configId = 'c'.repeat(64)
  wrongConfig.checkpoint.capture.configId = 'c'.repeat(64)
  expectErrorEnvelope(await beginRaw(origin, JSON.stringify(wrongConfig)), 400, BAD_PUBLICATION)
  const upperGeneration = JSON.parse(three.manifestText) as PublicationManifest
  upperGeneration.generation = GENERATION_THREE.toUpperCase()
  expectErrorEnvelope(await beginRaw(origin, JSON.stringify(upperGeneration)), 400, BAD_PUBLICATION)
  const oversized = Buffer.alloc(600 * 1024, 32)
  expectErrorEnvelope(await rawRequest(origin, '/__orbit/publish/begin', {
    method: 'POST', headers: authorized({ 'Content-Type': 'application/json', 'Content-Length': oversized.length }), body: oversized,
  }), 413, { error: '발행 자료의 크기 한도를 초과했습니다.', code: 'PUBLISH_LIMIT' })
  expect((await metricsOf(origin)).staging).toBe(GENERATION_THREE)
  // Idle staging expires exactly fifteen minutes after its last touch (source: at - touched_at >= 15 min).
  await freezeAt(origin, T('07:09:59.999'))
  expect((await putChunkRaw(origin, GENERATION_THREE, 0, three.chunks[0])).status).toBe(200)
  await freezeAt(origin, T('07:24:59.998'))
  expect((await putChunkRaw(origin, GENERATION_THREE, 0, three.chunks[0])).status).toBe(200)
  expect((await metricsOf(origin)).staging).toBe(GENERATION_THREE)
  await freezeAt(origin, T('07:39:59.998'))
  expectErrorEnvelope(await putChunkRaw(origin, GENERATION_THREE, 0, three.chunks[0]), 409, CONFLICT)
  expectErrorEnvelope(await commitRaw(origin, { generation: GENERATION_THREE }), 409, CONFLICT)
  expect(await metricsOf(origin)).toMatchObject({ staging: null, chunks: chunkCount(one.built, two), generations: 2 })
  // The generation begins again and re-uploads its chunks.
  expect(jsonBody(await beginRaw(origin, three.manifestText))).toEqual({ committed: false, generation: GENERATION_THREE })
  for (const [index, chunk] of three.chunks.entries()) {
    expect(jsonBody(await putChunkRaw(origin, GENERATION_THREE, index, chunk))).toMatchObject({ generation: GENERATION_THREE, index })
  }
  const head3 = (jsonBody(await commitRaw(origin, { generation: GENERATION_THREE })) as { head: PublicationHead }).head
  expect(head3).toEqual({ revision: 3, generation: GENERATION_THREE, publishedAt: T('07:39:59.998') })
  expect((jsonBody(await rawRequest(origin, '/api/catalog')) as Record<string, any>).publication.generation).toBe(GENERATION_THREE)
  expect(await metricsOf(origin)).toMatchObject({ generations: 3, chunks: chunkCount(one.built, two, three), staging: null })
})

test('staging lifetime ends exactly two hours after begin even when uploads keep touching it', async ({ baseURL }) => {
  const origin = baseURL!
  const one = await publish(origin, captures.first, GENERATION_ONE)
  const two = build(captures.second, GENERATION_TWO, parent(one.head))
  const begun = T('06:40:00.000')
  await freezeAt(origin, begun)
  expect(jsonBody(await beginRaw(origin, two.manifestText))).toEqual({ committed: false, generation: GENERATION_TWO })
  for (let minutes = 14; minutes <= 112; minutes += 14) {
    await freezeAt(origin, plusMinutes(begun, minutes))
    const touched = await putChunkRaw(origin, GENERATION_TWO, 0, two.chunks[0])
    expect(touched.status, `${minutes} minutes after begin`).toBe(200)
  }
  await freezeAt(origin, T('08:39:59.999'))
  expect((await putChunkRaw(origin, GENERATION_TWO, 0, two.chunks[0])).status).toBe(200)
  expect((await metricsOf(origin)).staging).toBe(GENERATION_TWO)
  await freezeAt(origin, T('08:40:00.000'))
  expectErrorEnvelope(await putChunkRaw(origin, GENERATION_TWO, 0, two.chunks[0]), 409, CONFLICT)
  expectErrorEnvelope(await commitRaw(origin, { generation: GENERATION_TWO }), 409, CONFLICT)
  expect(await metricsOf(origin)).toMatchObject({ staging: null, generations: 1, chunks: one.built.chunks.length })
  expect((jsonBody(await rawRequest(origin, `/api/catalog?generation=${GENERATION_ONE}`)) as Record<string, any>).publication.generation).toBe(GENERATION_ONE)
  // The second capture (06:30) is now far older than the request time but a fresh begin is still admissible.
  expect(jsonBody(await beginRaw(origin, two.manifestText))).toEqual({ committed: false, generation: GENERATION_TWO })
})

test('a multi-chunk publication is committed only once every chunk is present and then streams byte-exact bodies', async ({ baseURL }) => {
  const origin = baseURL!
  const bulk = build(captures.bulk, GENERATION_FOUR)
  expect(bulk.chunks.length).toBeGreaterThanOrEqual(2)
  expect(jsonBody(await beginRaw(origin, bulk.manifestText))).toEqual({ committed: false, generation: GENERATION_FOUR })
  for (const [index, chunk] of bulk.chunks.slice(0, -1).entries()) {
    expect(jsonBody(await putChunkRaw(origin, GENERATION_FOUR, index, chunk))).toEqual({
      generation: GENERATION_FOUR, index, hash: bulk.manifest.chunks[index].hash, bytes: bulk.manifest.chunks[index].bytes,
    })
  }
  expectErrorEnvelope(await commitRaw(origin, { generation: GENERATION_FOUR }), 409, INCOMPLETE)
  expect(jsonBody(await rawRequest(origin, '/api/health'))).toMatchObject({ generation: null, ready: false })
  expectErrorEnvelope(await rawRequest(origin, `/api/catalog?generation=${GENERATION_FOUR}`), 410, GONE)
  const last = bulk.chunks.length - 1
  expect(jsonBody(await putChunkRaw(origin, GENERATION_FOUR, last, bulk.chunks[last]))).toMatchObject({ index: last })
  const head = (jsonBody(await commitRaw(origin, { generation: GENERATION_FOUR })) as { head: PublicationHead }).head
  expect(head).toEqual({ revision: 1, generation: GENERATION_FOUR, publishedAt: T('06:05:00.000') })
  expect(await metricsOf(origin)).toMatchObject({ generations: 1, chunks: bulk.chunks.length, payloadBytes: compressedBytes(bulk), staging: null })
  const identity = await rawRequest(origin, '/api/catalog', { timeoutMs: 120_000 })
  expect(identity.status).toBe(200)
  const expected = Buffer.from(materialize(bulk, projectCatalog(bulk.manifest, head, Date.parse(T('06:05:00.000')))))
  expect(identity.body.equals(expected)).toBe(true)
  const body = JSON.parse(identity.body.toString('utf8'))
  expect(body.jobs).toHaveLength(73)
  expect(isPublicCatalog(body)).toBe(true)
  const gzipped = await rawRequest(origin, '/api/catalog', { headers: { 'Accept-Encoding': 'gzip' }, timeoutMs: 120_000 })
  expect(gzipped.headers['content-encoding']).toBe('gzip')
  expect(decodedBody(gzipped).equals(expected)).toBe(true)
  expect(gzipped.body.length).toBeLessThan(expected.length)
  const brotli = await rawRequest(origin, '/api/catalog', { headers: { 'Accept-Encoding': 'br' }, timeoutMs: 120_000 })
  expect(brotli.headers['content-encoding']).toBe('br')
  expect(decodedBody(brotli).equals(expected)).toBe(true)
  const index = await rawRequest(origin, '/api/posting-status', { timeoutMs: 120_000 })
  expect(index.body.equals(Buffer.from(materialize(bulk, projectPostingStatus(bulk.manifest, Date.parse(T('06:05:00.000'))))))).toBe(true)
  await waitForIdleBodies(origin)
})

test('rollback republishes the previous public data with the newest private checkpoint and stays idempotent', async ({ baseURL }) => {
  const origin = baseURL!
  const one = await publish(origin, captures.first, GENERATION_ONE)
  await freezeAt(origin, T('06:35:00.000'))
  const two = await publish(origin, captures.second, GENERATION_TWO, parent(one.head))
  await freezeAt(origin, T('06:40:00.000'))
  const rolled = await contractClient(origin).rollback(two.head, GENERATION_THREE)
  expect(rolled).toEqual({ revision: 3, generation: GENERATION_THREE, publishedAt: T('06:40:00.000') })
  const catalog = await rawRequest(origin, '/api/catalog')
  expect(catalog.headers['x-orbit-generation']).toBe(GENERATION_THREE)
  const body = jsonBody(catalog) as Record<string, any>
  expect(body).toEqual(catalogOf(one.built, rolled, T('06:40:00.000')))
  expect(body.publication).toEqual({ mode: 'scheduled', generation: GENERATION_THREE, publishedAt: T('06:40:00.000'), intervalMinutes: 30 })
  expect(body.jobs.map((job: { fetchedAt: string }) => job.fetchedAt)).toEqual([RUN_ONE, RUN_ONE])
  expect(body.boards.map((board: { lastSuccessAt: string }) => board.lastSuccessAt)).toEqual([RUN_ONE, RUN_ONE])
  expect(jsonBody(await rawRequest(origin, '/api/posting-status'))).toEqual(postingOf(one.built, T('06:40:00.000')))
  expect(jsonBody(await rawRequest(origin, '/api/observations'))).toEqual(observationsOf(one.built, T('06:40:00.000')))
  expect(jsonBody(await rawRequest(origin, '/api/health'))).toMatchObject({ generation: GENERATION_THREE, publishedAt: T('06:40:00.000'), boards: 2, usableBoards: 2, ready: true })
  const stored = await contractClient(origin).head()
  expect(stored.head).toEqual(rolled)
  expect(stored.manifest).toMatchObject({
    generation: GENERATION_THREE, rollbackOf: GENERATION_ONE, parent: { revision: 2, generation: GENERATION_TWO },
    capture: one.built.manifest.capture, catalog: one.built.manifest.catalog, posting: one.built.manifest.posting, observations: one.built.manifest.observations,
  })
  expect(stored.manifest!.checkpoint).toEqual(two.built.manifest.checkpoint)
  for (const [name, fragment] of Object.entries(stored.manifest!.fragments)) {
    const source = fragment.visibility === 'public' ? one.built.manifest : two.built.manifest
    expect(fragment, name).toEqual(source.fragments[name])
  }
  const files = await contractClient(origin).checkpoint(rolled, stored.manifest!)
  for (const name of ['boards', 'presence', 'observations'] as const) {
    expect(Buffer.from(files[name]).equals(decodedFragment(two.built, two.built.manifest.checkpoint.files[name])), name).toBe(true)
  }
  // Retrying the accepted rollback, in either parent key order, returns the same head (WI82-3).
  expect(jsonBody(await rollbackRaw(origin, { generation: GENERATION_THREE, parent: { revision: 2, generation: GENERATION_TWO } }))).toEqual({ head: rolled })
  expect(jsonBody(await rollbackRaw(origin, { generation: GENERATION_THREE, parent: { generation: GENERATION_TWO, revision: 2 } }))).toEqual({ head: rolled })
  expectErrorEnvelope(await rollbackRaw(origin, { generation: GENERATION_THREE, parent: { revision: 1, generation: GENERATION_ONE } }), 409, CONFLICT)
  expectErrorEnvelope(await rollbackRaw(origin, { generation: GENERATION_THREE, parent: { revision: 2, generation: GENERATION_TWO, publishedAt: two.head.publishedAt } }), 400, BAD_PUBLICATION)
  expectErrorEnvelope(await rollbackRaw(origin, { generation: GENERATION_FOUR, parent: null }), 400, BAD_PUBLICATION)
  expectErrorEnvelope(await rollbackRaw(origin, { generation: GENERATION_FOUR, parent: { revision: 2, generation: GENERATION_TWO }, extra: true }), 400, BAD_PUBLICATION)
  expectErrorEnvelope(await rollbackRaw(origin, { generation: GENERATION_FOUR.toUpperCase(), parent: { revision: 3, generation: GENERATION_THREE } }), 400, BAD_PUBLICATION)
  expectErrorEnvelope(await rollbackRaw(origin, { generation: GENERATION_FOUR, parent: { revision: 2, generation: GENERATION_TWO } }), 409, CONFLICT)
  expectErrorEnvelope(await rollbackRaw(origin, { generation: GENERATION_TWO, parent: { revision: 3, generation: GENERATION_THREE } }), 409, CONFLICT)
  // A second rollback moves one step further back: public data of generation two, private checkpoint unchanged.
  const again = await contractClient(origin).rollback(rolled, GENERATION_FOUR)
  expect(again).toEqual({ revision: 4, generation: GENERATION_FOUR, publishedAt: T('06:40:00.000') })
  const second = jsonBody(await rawRequest(origin, '/api/catalog')) as Record<string, any>
  expect(second).toEqual(catalogOf(two.built, again, T('06:40:00.000')))
  expect(second.jobs.map((job: { fetchedAt: string }) => job.fetchedAt)).toEqual([T('06:30:00.000'), T('06:30:00.000')])
  const secondStored = await contractClient(origin).head()
  expect(secondStored.manifest).toMatchObject({ rollbackOf: GENERATION_TWO, parent: { revision: 3, generation: GENERATION_THREE } })
  expect(secondStored.manifest!.checkpoint).toEqual(two.built.manifest.checkpoint)
  expect(jsonBody(await rawRequest(origin, '/api/health'))).toMatchObject({ generation: GENERATION_FOUR, boards: 2, usableBoards: 2, ready: true })
  expect(await metricsOf(origin)).toMatchObject({ generations: 4, staging: null })
})

test('rollback is refused without a previous generation or while a publication is staged', async ({ baseURL }) => {
  const origin = baseURL!
  expectErrorEnvelope(await rollbackRaw(origin, { generation: GENERATION_TWO, parent: { revision: 1, generation: GENERATION_ONE } }), 409, CONFLICT)
  const one = await publish(origin, captures.first, GENERATION_ONE)
  expectErrorEnvelope(await rollbackRaw(origin, { generation: GENERATION_TWO, parent: { revision: 1, generation: GENERATION_ONE } }), 409, CONFLICT)
  await freezeAt(origin, T('06:35:00.000'))
  const two = await publish(origin, captures.second, GENERATION_TWO, parent(one.head))
  const three = build(captures.third, GENERATION_THREE, parent(two.head))
  await freezeAt(origin, T('07:05:00.000'))
  expect(jsonBody(await beginRaw(origin, three.manifestText))).toEqual({ committed: false, generation: GENERATION_THREE })
  expectErrorEnvelope(await rollbackRaw(origin, { generation: GENERATION_FOUR, parent: { revision: 2, generation: GENERATION_TWO } }), 409, CONFLICT)
  expect((jsonBody(await rawRequest(origin, '/api/catalog')) as Record<string, any>).publication.generation).toBe(GENERATION_TWO)
  expect(await metricsOf(origin)).toMatchObject({ generations: 2, staging: GENERATION_THREE })
})

test('an all-unavailable publication is served honestly as 503 while its metadata, index and history stay readable', async ({ baseURL }) => {
  const origin = baseURL!
  const { built, head } = await publish(origin, captures.empty, GENERATION_ONE)
  expect(jsonBody(await rawRequest(origin, '/api/health'))).toEqual({
    status: 'ok', app: 'orbit', mode: 'production', delivery: 'scheduled', generation: GENERATION_ONE, publishedAt: head.publishedAt,
    intervalMinutes: 30, boards: 2, usableBoards: 0, ready: false,
  })
  const unavailable = expectErrorEnvelope(await rawRequest(origin, '/api/catalog'), 503, UNAVAILABLE)
  expect(unavailable.retryAt).toBe(T('06:01:00.000'))
  expectErrorEnvelope(await rawRequest(origin, `/api/catalog?generation=${GENERATION_ONE}`), 503, UNAVAILABLE)
  const posting = await rawRequest(origin, '/api/posting-status')
  expect(posting.status).toBe(200)
  const index = jsonBody(posting) as Record<string, any>
  expect(index).toEqual(postingOf(built, T('06:05:00.000')))
  expect(index.boards.map((board: { status: string }) => [board.status, 'listing' in board])).toEqual([['error', false], ['error', false]])
  const history = jsonBody(await rawRequest(origin, '/api/observations')) as Record<string, any>
  expect(history).toEqual(observationsOf(built, T('06:05:00.000')))
  expect(history.storage).toBe('ok')
  expect(await metricsOf(origin)).toMatchObject({ generations: 1, chunks: built.chunks.length })
})

test('body admission: eight concurrent large streams, the ninth is busy, HEAD/304/health stay available, cancellation frees the slots', async ({ baseURL }) => {
  const origin = baseURL!
  const large = build(captures.large, GENERATION_FOUR)
  await contractClient(origin).publish(large)
  const streams = new StreamRegistry()
  try {
    // Every handle is owned by the registry before any assertion runs (AWT82-5).
    for (let index = 0; index < 8; index++) {
      const stream = streams.open(origin, '/api/catalog')
      await stream.ready
      expect(stream.status, `stream ${index}`).toBe(200)
      expect(stream.firstChunkBytes, `stream ${index}`).toBeGreaterThan(0)
      expect(stream.state).toBe('paused')
    }
    await expect.poll(async () => (await metricsOf(origin)).activeBodies, { timeout: 10_000 }).toBe(8)
    const busy = await rawRequest(origin, '/api/catalog')
    const busyBody = expectErrorEnvelope(busy, 503, BUSY)
    expect(busy.headers['retry-after']).toBe('60')
    expect(busyBody.retryAt).toBe(T('06:06:00.000'))
    expectErrorEnvelope(await rawRequest(origin, '/api/posting-status'), 503, BUSY)
    expectErrorEnvelope(await rawRequest(origin, `/api/observations?generation=${GENERATION_FOUR}`), 503, BUSY)
    expectErrorEnvelope(await rawRequest(origin, `/__orbit/publish/checkpoint/boards?generation=${GENERATION_FOUR}`, { headers: authorized() }), 503, BUSY)
    const headOnly = await rawRequest(origin, '/api/catalog', { method: 'HEAD' })
    expect(headOnly.status).toBe(200)
    expect(headOnly.headers.etag).toMatch(ETAG)
    expect((await rawRequest(origin, '/api/catalog', { headers: { 'If-None-Match': headOnly.headers.etag! } })).status).toBe(304)
    expect((await rawRequest(origin, '/api/health')).status).toBe(200)
    expect((await rawRequest(origin, '/__orbit/publish/head', { headers: authorized() })).status).toBe(200)
    expect(await metricsOf(origin)).toMatchObject({ activeBodies: 8, peakBodies: 8, activeGenerations: 8 })
    for (const stream of streams.streams.slice(0, 4)) stream.destroy()
    await expect.poll(async () => (await metricsOf(origin)).activeBodies, { timeout: 20_000 }).toBe(4)
    // SR01-11(f): each destroyed reader releases its generation pin together with its body slot; the four held readers keep theirs.
    expect((await metricsOf(origin)).activeGenerations, 'four destroyed readers must have released their pins').toBe(4)
    const admitted = streams.open(origin, '/api/catalog')
    await admitted.ready
    expect(admitted.status).toBe(200)
    const completed = await Promise.all(streams.streams.filter(stream => stream.state === 'paused').map(stream => stream.finish()))
    expect(completed.map(jobCount)).toEqual([321, 321, 321, 321, 321])
    await waitForIdleBodies(origin)
    const recovered = await rawRequest(origin, '/api/catalog', { timeoutMs: 120_000 })
    expect(recovered.status).toBe(200)
    expect(jobCount(recovered.body)).toBe(321)
    expect(await metricsOf(origin)).toMatchObject({ activeBodies: 0, peakBodies: 8, activeGenerations: 0 })
  } finally {
    streams.destroyAll()
  }
})

test('garbage collection keeps a retired generation while a slow reader still streams it', async ({ baseURL }) => {
  const origin = baseURL!
  const large = build(captures.large, GENERATION_FOUR)
  const largeHead = await contractClient(origin).publish(large)
  await freezeAt(origin, T('06:35:00.000'))
  const two = await publish(origin, captures.second, GENERATION_TWO, parent(largeHead))
  await freezeAt(origin, T('07:05:00.000'))
  const three = await publish(origin, captures.third, GENERATION_THREE, parent(two.head))
  const streams = new StreamRegistry()
  try {
    const slow = streams.open(origin, `/api/catalog?generation=${GENERATION_FOUR}`)
    await slow.ready
    expect(slow.status).toBe(200)
    expect(slow.headers['x-orbit-generation']).toBe(GENERATION_FOUR)
    // Exactly five minutes after retirement the sweep would delete the generation; the pinned reader prevents it.
    await freezeAt(origin, T('07:10:00.000'))
    expect(jsonBody(await beginRaw(origin, three.built.manifestText))).toEqual({ committed: true, head: three.head })
    expect(await metricsOf(origin)).toMatchObject({ generations: 3, activeBodies: 1, activeGenerations: 1 })
    const pinned = await rawRequest(origin, `/api/catalog?generation=${GENERATION_FOUR}`, { timeoutMs: 120_000 })
    expect(pinned.status).toBe(200)
    expect(pinned.headers['x-orbit-generation']).toBe(GENERATION_FOUR)
    expect(jobCount(pinned.body)).toBe(321)
    expect(await metricsOf(origin)).toMatchObject({ generations: 3, chunks: chunkCount(large, two.built, three.built) })
    const streamed = await slow.finish()
    expect(jobCount(streamed)).toBe(321)
    expect(slow.state).toBe('ended')
  } finally {
    streams.destroyAll()
  }
  await waitForIdleBodies(origin)
  expect(await metricsOf(origin)).toMatchObject({ activeGenerations: 0 })
  expect(jsonBody(await beginRaw(origin, three.built.manifestText))).toEqual({ committed: true, head: three.head })
  expectErrorEnvelope(await rawRequest(origin, `/api/catalog?generation=${GENERATION_FOUR}`), 410, GONE)
  expect((await rawRequest(origin, `/api/catalog?generation=${GENERATION_TWO}`)).status).toBe(200)
  expect(await metricsOf(origin)).toMatchObject({
    generations: 2, chunks: chunkCount(two.built, three.built), payloadBytes: compressedBytes(two.built, three.built), activeGenerations: 0,
  })
})

test('the real publication client honors a busy Retry-After from the running Worker and then succeeds', async ({ baseURL }) => {
  const origin = baseURL!
  const large = build(captures.large, GENERATION_FOUR)
  const head = await contractClient(origin).publish(large)
  const streams = new StreamRegistry()
  try {
    for (let index = 0; index < 8; index++) {
      const stream = streams.open(origin, '/api/catalog')
      await stream.ready
      expect(stream.status, `stream ${index}`).toBe(200)
    }
    await expect.poll(async () => (await metricsOf(origin)).activeBodies, { timeout: 10_000 }).toBe(8)
    // The client's checkpoint download is a large body stream: the first attempt sees the real CATALOG_BUSY 503
    // with Retry-After: 60. The injected wait records the honored delay and releases the streams instead of sleeping.
    const waits: number[] = []
    // The real client with an injected scheduler; the Worker still produces the real 503 and Retry-After.
    const client = createPublicationClient({
      url: origin, token: CONTRACT_TOKEN, wait: async milliseconds => {
        waits.push(milliseconds)
        streams.destroyAll()
        await expect.poll(async () => (await metricsOf(origin)).activeBodies, { timeout: 20_000 }).toBe(0)
        // SR01-11(f): every destroyed reader has released its pin before the real client retries.
        expect((await metricsOf(origin)).activeGenerations, 'eight destroyed readers must have released their pins').toBe(0)
      },
    })
    const files = await client.checkpoint(head, large.manifest)
    expect(waits).toEqual([60_000])
    for (const name of ['boards', 'presence', 'observations'] as const) {
      expect(Buffer.from(files[name]).equals(decodedFragment(large, large.manifest.checkpoint.files[name])), name).toBe(true)
    }
  } finally {
    streams.destroyAll()
  }
  await waitForIdleBodies(origin)
})
