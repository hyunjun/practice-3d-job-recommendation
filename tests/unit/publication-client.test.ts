import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildPublication } from '../../server/publication-build'
import type { BuiltPublication } from '../../server/publication-build'
import { createPublicationClient, PublicationClientError, publicationOrigin } from '../../server/publication-client'
import type { PublicationHead, PublicationManifest } from '../../shared/publication'
import {
  decodedFragment, FICTIONAL_COMMIT, GENERATION_ONE, GENERATION_THREE, GENERATION_TWO, publicationHarness, stamp82,
} from '../fixtures/publication'
import type { PublicationGeneration } from '../fixtures/publication'

/**
 * Stage82 common design v2 (lines 42-45, 90, 105): the Node publisher talks to
 * the exact authorized origin only, never follows redirects with its token,
 * retries idempotently, reconciles an ambiguous commit against the current head
 * without re-collecting or minting a new generation, and reports unknown
 * outcomes explicitly. Every remote behavior below is a synthetic fetcher.
 */
const TOKEN = 'fictional-publication-token-0123456789abcdef0123456789abcdef0123456789'
const LOCAL = 'http://127.0.0.1:8790'
const T = stamp82
const PUBLISHED_AT = T('06:00:05.000')

interface RecordedCall {
  url: string
  path: string
  method: string
  headers: Headers
  body: Buffer | null
  redirect: RequestInit['redirect']
  signal: AbortSignal | null
}
type Handler = (call: RecordedCall) => Response | Promise<Response>
const json = (value: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json', ...headers } })
const networkFailure: Handler = () => { throw new TypeError('fetch failed (fictional network)') }

/** A scripted remote: `handlers['POST /__orbit/publish/commit']` may be one handler or a consumed queue. */
function synthetic(handlers: Record<string, Handler | Handler[]>) {
  const calls: RecordedCall[] = []
  const waits: number[] = []
  const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    const raw = init?.body
    const call: RecordedCall = {
      url: url.href, path: url.pathname + url.search, method: init?.method ?? 'GET', headers: new Headers(init?.headers),
      body: raw === undefined || raw === null ? null : typeof raw === 'string' ? Buffer.from(raw) : Buffer.from(raw as Uint8Array),
      redirect: init?.redirect, signal: init?.signal ?? null,
    }
    calls.push(call)
    const handler = handlers[`${call.method} ${url.pathname}`]
    if (!handler) return json({ error: 'fictional unknown route', code: 'PUBLISH_NOT_FOUND' }, 404)
    const next = Array.isArray(handler) ? (handler.length > 1 ? handler.shift()! : handler[0]) : handler
    return next(call)
  })
  const wait = vi.fn(async (milliseconds: number) => { waits.push(milliseconds) })
  return { fetcher: fetcher as unknown as typeof fetch, calls, waits, wait }
}

// MWT82-1: keep the builder's UUID template type instead of a widened string default.
async function publication(generation: PublicationGeneration = GENERATION_ONE, parent: PublicationHead | null = null): Promise<BuiltPublication> {
  const h = publicationHarness()
  const { capture } = await h.run()
  return buildPublication(capture, FICTIONAL_COMMIT, parent, generation)
}
const headOf = (built: BuiltPublication, publishedAt = PUBLISHED_AT): PublicationHead => ({
  revision: (built.manifest.parent?.revision ?? 0) + 1, generation: built.manifest.generation, publishedAt,
})
const headResponse = (built: BuiltPublication | null) =>
  json(built ? { head: headOf(built), manifest: built.manifest } : { head: null, manifest: null })
const chunkAck = (built: BuiltPublication): Handler => call => {
  const index = Number(call.path.split('/').at(-1))
  const chunk = built.manifest.chunks[index]
  return json({ generation: built.manifest.generation, index, hash: chunk.hash, bytes: chunk.bytes })
}
async function failure(promise: Promise<unknown>): Promise<PublicationClientError> {
  try { await promise } catch (error) { return error as PublicationClientError }
  throw new Error('Expected the publication client to fail')
}

afterEach(() => { vi.restoreAllMocks() })

describe('origin and token admission', () => {
  it('accepts only the production Workers origin or a loopback verification origin without port 8787', () => {
    expect(publicationOrigin('https://job.hyunjun.workers.dev')).toBe('https://job.hyunjun.workers.dev')
    expect(publicationOrigin('https://job.hyunjun.workers.dev/')).toBe('https://job.hyunjun.workers.dev')
    expect(publicationOrigin('http://127.0.0.1:8790')).toBe('http://127.0.0.1:8790')
    expect(publicationOrigin('http://localhost:4173')).toBe('http://localhost:4173')
    expect(publicationOrigin('http://[::1]:5000')).toBe('http://[::1]:5000')
    for (const rejected of [
      'http://127.0.0.1:8787', 'http://localhost:8787', 'https://other.hyunjun.workers.dev', 'https://job.hyunjun.workers.dev.evil.test',
      'http://job.hyunjun.workers.dev', 'https://job.hyunjun.workers.dev/api', 'https://job.hyunjun.workers.dev/?x=1',
      'https://job.hyunjun.workers.dev/#top', 'https://user:secret@job.hyunjun.workers.dev', 'https://127.0.0.1:8790',
      'http://10.0.0.5:8790', 'ftp://127.0.0.1:8790',
    ]) expect(() => publicationOrigin(rejected), rejected).toThrow('Use the configured Workers origin or a local verification origin')
  })

  it('requires a dedicated token of 43 to 256 characters without line breaks before any request', () => {
    const { fetcher } = synthetic({})
    expect(() => createPublicationClient({ url: LOCAL, token: 'short-token', fetcher })).toThrow('A dedicated publication token is required')
    expect(() => createPublicationClient({ url: LOCAL, token: `${TOKEN}\nextra`, fetcher })).toThrow('A dedicated publication token is required')
    expect(() => createPublicationClient({ url: LOCAL, token: 'x'.repeat(257), fetcher })).toThrow('A dedicated publication token is required')
    expect(() => createPublicationClient({ url: 'http://127.0.0.1:8787', token: TOKEN, fetcher })).toThrow('Use the configured Workers origin or a local verification origin')
    expect(fetcher).not.toHaveBeenCalled()
  })
})

describe('request shape, redirects and retries', () => {
  it('sends the bearer token with manual redirects and treats a redirect as a terminal failure without following it', async () => {
    const remote = synthetic({ 'GET /__orbit/publish/head': () => new Response(null, { status: 302, headers: { Location: 'https://elsewhere.test/steal' } }) })
    const client = createPublicationClient({ url: LOCAL, token: TOKEN, fetcher: remote.fetcher, wait: remote.wait })
    const error = await failure(client.head())
    expect(error).toBeInstanceOf(PublicationClientError)
    expect(error.code).toBe('HTTP_302')
    expect(error.status).toBe(302)
    expect(error.message).toBe('Publication request failed (HTTP_302)')
    expect(remote.calls).toHaveLength(1)
    expect(remote.calls[0]).toMatchObject({ url: `${LOCAL}/__orbit/publish/head`, method: 'GET', redirect: 'manual' })
    expect(remote.calls[0].headers.get('Authorization')).toBe(`Bearer ${TOKEN}`)
    expect(remote.calls[0].headers.get('Accept-Encoding')).toBe('gzip')
    expect(remote.calls[0].headers.get('Content-Type')).toBeNull()
    expect(remote.calls[0].body).toBeNull()
    expect(remote.calls.every(call => !call.url.includes('elsewhere'))).toBe(true)
    expect(remote.waits).toEqual([])
  })

  it('retries 429/502/503/504 at most twice, honoring a capped Retry-After, and never retries other failures', async () => {
    const built = await publication()
    const recovering = synthetic({ 'GET /__orbit/publish/head': [
      () => json({ error: 'busy' }, 503, { 'Retry-After': '2' }),
      () => json({ error: 'busy' }, 429),
      () => headResponse(built),
    ] })
    const client = createPublicationClient({ url: LOCAL, token: TOKEN, fetcher: recovering.fetcher, wait: recovering.wait })
    expect((await client.head()).head).toEqual(headOf(built))
    expect(recovering.calls).toHaveLength(3)
    expect(recovering.waits).toEqual([2000, 2000])

    const capped = synthetic({ 'GET /__orbit/publish/head': [() => json({}, 502, { 'Retry-After': '500' }), () => headResponse(null)] })
    const cappedClient = createPublicationClient({ url: LOCAL, token: TOKEN, fetcher: capped.fetcher, wait: capped.wait })
    expect(await cappedClient.head()).toEqual({ head: null, manifest: null })
    expect(capped.waits).toEqual([120000])

    const exhausted = synthetic({ 'GET /__orbit/publish/head': () => json({ error: 'busy', code: 'CATALOG_BUSY' }, 503) })
    const exhaustedClient = createPublicationClient({ url: LOCAL, token: TOKEN, fetcher: exhausted.fetcher, wait: exhausted.wait })
    const exhaustedError = await failure(exhaustedClient.head())
    expect([exhaustedError.code, exhaustedError.status]).toEqual(['CATALOG_BUSY', 503])
    expect(exhausted.calls).toHaveLength(3)
    expect(exhausted.waits).toEqual([1000, 2000])

    const permanent = synthetic({ 'GET /__orbit/publish/head': () => json({ error: 'x', code: 'PUBLISH_STORAGE_ERROR' }, 500) })
    const permanentClient = createPublicationClient({ url: LOCAL, token: TOKEN, fetcher: permanent.fetcher, wait: permanent.wait })
    const permanentError = await failure(permanentClient.head())
    expect([permanentError.code, permanentError.status]).toEqual(['PUBLISH_STORAGE_ERROR', 500])
    expect(permanent.calls).toHaveLength(1)
    expect(permanent.waits).toEqual([])

    const unauthorized = synthetic({ 'GET /__orbit/publish/head': () => json({ error: '발행 인증이 필요합니다.', code: 'PUBLISH_UNAUTHORIZED' }, 401, { 'WWW-Authenticate': 'Bearer' }) })
    const unauthorizedError = await failure(createPublicationClient({ url: LOCAL, token: TOKEN, fetcher: unauthorized.fetcher, wait: unauthorized.wait }).head())
    expect([unauthorizedError.code, unauthorizedError.status]).toEqual(['PUBLISH_UNAUTHORIZED', 401])

    const unreadableCode = synthetic({ 'GET /__orbit/publish/head': () => json({ code: 'not a valid code' }, 404) })
    const unreadableError = await failure(createPublicationClient({ url: LOCAL, token: TOKEN, fetcher: unreadableCode.fetcher, wait: unreadableCode.wait }).head())
    expect(unreadableError.code).toBe('HTTP_404')
    const htmlBody = synthetic({ 'GET /__orbit/publish/head': () => new Response('<html>fictional gateway</html>', { status: 404 }) })
    expect((await failure(createPublicationClient({ url: LOCAL, token: TOKEN, fetcher: htmlBody.fetcher, wait: htmlBody.wait }).head())).code).toBe('HTTP_404')
  })

  it('retries connection failures twice and reports NETWORK, and reports CANCELLED when its signal aborts', async () => {
    const flaky = synthetic({ 'GET /__orbit/publish/head': [networkFailure, networkFailure, () => headResponse(null)] })
    expect(await createPublicationClient({ url: LOCAL, token: TOKEN, fetcher: flaky.fetcher, wait: flaky.wait }).head()).toEqual({ head: null, manifest: null })
    expect(flaky.waits).toEqual([1000, 2000])
    const dead = synthetic({ 'GET /__orbit/publish/head': networkFailure })
    const deadError = await failure(createPublicationClient({ url: LOCAL, token: TOKEN, fetcher: dead.fetcher, wait: dead.wait }).head())
    expect([deadError.code, deadError.status]).toEqual(['NETWORK', undefined])
    expect(dead.calls).toHaveLength(3)
    const controller = new AbortController()
    const aborting = synthetic({ 'GET /__orbit/publish/head': () => { controller.abort(); throw new DOMException('The operation was aborted.', 'AbortError') } })
    const abortError = await failure(createPublicationClient({ url: LOCAL, token: TOKEN, fetcher: aborting.fetcher, wait: aborting.wait, signal: controller.signal }).head())
    expect(abortError.code).toBe('CANCELLED')
    expect(aborting.calls).toHaveLength(1)
    expect(aborting.waits).toEqual([])
  })
})

describe('head validation', () => {
  it('accepts an empty head and a consistent head, and rejects every inconsistency as INVALID_HEAD', async () => {
    const built = await publication()
    const valid = synthetic({ 'GET /__orbit/publish/head': () => headResponse(built) })
    const result = await createPublicationClient({ url: LOCAL, token: TOKEN, fetcher: valid.fetcher }).head()
    expect(result.head).toEqual(headOf(built))
    expect(result.manifest).toEqual(built.manifest)
    const inconsistent: [string, unknown][] = [
      ['generation mismatch', { head: { ...headOf(built), generation: GENERATION_TWO }, manifest: built.manifest }],
      ['revision not parent+1', { head: { ...headOf(built), revision: 2 }, manifest: built.manifest }],
      ['missing manifest key', { head: headOf(built) }],
      ['public configuration ID not derived from its registry', { head: headOf(built), manifest: { ...built.manifest, capture: { ...built.manifest.capture, configId: 'a'.repeat(64) } } }],
      ['checkpoint configuration ID not derived from its registry', { head: headOf(built), manifest: { ...built.manifest, checkpoint: { ...built.manifest.checkpoint, capture: { ...built.manifest.checkpoint.capture, configId: 'b'.repeat(64) } } } }],
      ['array body', [headOf(built)]],
    ]
    for (const [label, body] of inconsistent) {
      const remote = synthetic({ 'GET /__orbit/publish/head': () => json(body) })
      const error = await failure(createPublicationClient({ url: LOCAL, token: TOKEN, fetcher: remote.fetcher }).head())
      expect(error.code, label).toBe('INVALID_HEAD')
    }
    // Schema and relationship failures are refused too; they surface as validation errors rather than a client code.
    for (const [label, body] of [
      ['half-null head', { head: null, manifest: built.manifest }],
      ['renamed board in registry', { head: headOf(built), manifest: { ...built.manifest, capture: { ...built.manifest.capture, companies: [built.manifest.capture.companies[0], { ...built.manifest.capture.companies[1], board: 'Renamed' }] } } }],
    ] as [string, unknown][]) {
      const remote = synthetic({ 'GET /__orbit/publish/head': () => json(body) })
      await expect(createPublicationClient({ url: LOCAL, token: TOKEN, fetcher: remote.fetcher }).head(), label).rejects.toThrow()
    }
    const invalidJson = synthetic({ 'GET /__orbit/publish/head': () => new Response('{"head":', { status: 200 }) })
    expect((await failure(createPublicationClient({ url: LOCAL, token: TOKEN, fetcher: invalidJson.fetcher }).head())).code).toBe('INVALID_RESPONSE')
    const oversized = synthetic({ 'GET /__orbit/publish/head': () => new Response(Buffer.alloc(512 * 1024 + 4096 + 1, 32), { status: 200 }) })
    expect((await failure(createPublicationClient({ url: LOCAL, token: TOKEN, fetcher: oversized.fetcher }).head())).code).toBe('RESPONSE_TOO_LARGE')
    const empty = synthetic({ 'GET /__orbit/publish/head': () => new Response(null, { status: 200 }) })
    expect((await failure(createPublicationClient({ url: LOCAL, token: TOKEN, fetcher: empty.fetcher }).head())).code).toBe('EMPTY_RESPONSE')
  })
})

describe('publishing a built generation', () => {
  it('begins, uploads every chunk with exact bytes, commits once and returns the acknowledged head', async () => {
    const built = await publication()
    const remote = synthetic({
      'POST /__orbit/publish/begin': () => json({ committed: false, generation: GENERATION_ONE }),
      [`PUT /__orbit/publish/chunks/${GENERATION_ONE}/0`]: chunkAck(built),
      'POST /__orbit/publish/commit': () => json({ head: headOf(built) }),
    })
    const client = createPublicationClient({ url: LOCAL, token: TOKEN, fetcher: remote.fetcher, wait: remote.wait })
    expect(await client.publish(built)).toEqual(headOf(built))
    expect(remote.calls.map(call => [call.method, call.path])).toEqual([
      ['POST', '/__orbit/publish/begin'], ['PUT', `/__orbit/publish/chunks/${GENERATION_ONE}/0`], ['POST', '/__orbit/publish/commit'],
    ])
    expect(remote.calls[0].headers.get('Content-Type')).toBe('application/json')
    expect(remote.calls[0].body?.toString('utf8')).toBe(built.manifestText)
    expect(remote.calls[1].headers.get('Content-Type')).toBe('application/octet-stream')
    expect(remote.calls[1].body?.equals(Buffer.from(built.chunks[0]))).toBe(true)
    expect(JSON.parse(remote.calls[2].body!.toString('utf8'))).toEqual({ generation: GENERATION_ONE })
    for (const call of remote.calls) expect(call.headers.get('Authorization')).toBe(`Bearer ${TOKEN}`)
    expect(remote.waits).toEqual([])
  })

  it('returns an already committed head from begin without uploading or committing again', async () => {
    const built = await publication()
    const remote = synthetic({ 'POST /__orbit/publish/begin': () => json({ committed: true, head: headOf(built) }) })
    const client = createPublicationClient({ url: LOCAL, token: TOKEN, fetcher: remote.fetcher })
    expect(await client.publish(built)).toEqual(headOf(built))
    expect(remote.calls.map(call => call.path)).toEqual(['/__orbit/publish/begin'])
    const wrongRevision = synthetic({ 'POST /__orbit/publish/begin': () => json({ committed: true, head: { ...headOf(built), revision: 7 } }), 'GET /__orbit/publish/head': () => headResponse(null) })
    expect((await failure(createPublicationClient({ url: LOCAL, token: TOKEN, fetcher: wrongRevision.fetcher }).publish(built))).code).toBe('COMMIT_UNCONFIRMED')
  })

  it('reconciles a lost commit response against the current head without re-collecting or minting a generation (WI82-1)', async () => {
    const built = await publication()
    const lostConnection = synthetic({
      'POST /__orbit/publish/begin': () => json({ committed: false, generation: GENERATION_ONE }),
      [`PUT /__orbit/publish/chunks/${GENERATION_ONE}/0`]: chunkAck(built),
      'POST /__orbit/publish/commit': networkFailure,
      'GET /__orbit/publish/head': () => headResponse(built),
    })
    const client = createPublicationClient({ url: LOCAL, token: TOKEN, fetcher: lostConnection.fetcher, wait: lostConnection.wait })
    expect(await client.publish(built)).toEqual(headOf(built))
    expect(lostConnection.calls.map(call => [call.method, call.path])).toEqual([
      ['POST', '/__orbit/publish/begin'], ['PUT', `/__orbit/publish/chunks/${GENERATION_ONE}/0`],
      ['POST', '/__orbit/publish/commit'], ['POST', '/__orbit/publish/commit'], ['POST', '/__orbit/publish/commit'],
      ['GET', '/__orbit/publish/head'],
    ])
    expect(lostConnection.waits).toEqual([1000, 2000])

    const truncatedBody = synthetic({
      'POST /__orbit/publish/begin': () => json({ committed: false, generation: GENERATION_ONE }),
      [`PUT /__orbit/publish/chunks/${GENERATION_ONE}/0`]: chunkAck(built),
      'POST /__orbit/publish/commit': () => new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"head":{"revision":1,'))
          controller.error(new Error('fictional interrupted body'))
        },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
      'GET /__orbit/publish/head': () => headResponse(built),
    })
    expect(await createPublicationClient({ url: LOCAL, token: TOKEN, fetcher: truncatedBody.fetcher, wait: truncatedBody.wait }).publish(built)).toEqual(headOf(built))
    expect(truncatedBody.calls.filter(call => call.path === '/__orbit/publish/commit')).toHaveLength(1)
    expect(truncatedBody.calls.filter(call => call.path === '/__orbit/publish/begin')).toHaveLength(1)
  })

  it('keeps an ambiguous commit explicitly unconfirmed when the head is unrelated, mismatched, unavailable or a different manifest', async () => {
    const built = await publication()
    const heads: [string, Handler][] = [
      ['empty head', () => headResponse(null)],
      ['other generation', () => json({ head: { revision: 1, generation: GENERATION_TWO, publishedAt: PUBLISHED_AT }, manifest: { ...built.manifest, generation: GENERATION_TWO } })],
      ['wrong revision', () => json({ head: { ...headOf(built), revision: 2 }, manifest: { ...built.manifest, parent: { revision: 1, generation: GENERATION_TWO } } })],
      ['unavailable head', () => json({ error: 'down' }, 503)],
      ['different manifest bytes', () => json({ head: headOf(built), manifest: { ...built.manifest, capture: { ...built.manifest.capture, capturedAt: T('06:00:01.000') } } })],
    ]
    for (const [label, head] of heads) {
      const remote = synthetic({
        'POST /__orbit/publish/begin': () => json({ committed: false, generation: GENERATION_ONE }),
        [`PUT /__orbit/publish/chunks/${GENERATION_ONE}/0`]: chunkAck(built),
        'POST /__orbit/publish/commit': networkFailure,
        'GET /__orbit/publish/head': head,
      })
      const error = await failure(createPublicationClient({ url: LOCAL, token: TOKEN, fetcher: remote.fetcher, wait: remote.wait }).publish(built))
      expect(error.code, label).toBe('COMMIT_UNCONFIRMED')
      expect(remote.calls.filter(call => call.path === '/__orbit/publish/begin'), label).toHaveLength(1)
      expect(remote.calls.some(call => call.path === '/__orbit/publish/head'), label).toBe(true)
    }
  })

  it('rethrows definite 4xx server answers without a head query and fails closed on bad acknowledgments', async () => {
    const built = await publication()
    const conflict = synthetic({ 'POST /__orbit/publish/begin': () => json({ error: '발행 기준 버전이 변경됐습니다.', code: 'PUBLISH_CONFLICT' }, 409) })
    const conflictError = await failure(createPublicationClient({ url: LOCAL, token: TOKEN, fetcher: conflict.fetcher }).publish(built))
    expect([conflictError.code, conflictError.status]).toEqual(['PUBLISH_CONFLICT', 409])
    expect(conflict.calls.map(call => call.path)).toEqual(['/__orbit/publish/begin'])
    const incomplete = synthetic({
      'POST /__orbit/publish/begin': () => json({ committed: false, generation: GENERATION_ONE }),
      [`PUT /__orbit/publish/chunks/${GENERATION_ONE}/0`]: chunkAck(built),
      'POST /__orbit/publish/commit': () => json({ error: '발행 청크 업로드가 완료되지 않았습니다.', code: 'PUBLISH_INCOMPLETE' }, 409),
    })
    const incompleteError = await failure(createPublicationClient({ url: LOCAL, token: TOKEN, fetcher: incomplete.fetcher }).publish(built))
    expect(incompleteError.code).toBe('PUBLISH_INCOMPLETE')
    expect(incomplete.calls.some(call => call.path === '/__orbit/publish/head')).toBe(false)
    const badAck = synthetic({
      'POST /__orbit/publish/begin': () => json({ committed: false, generation: GENERATION_ONE }),
      [`PUT /__orbit/publish/chunks/${GENERATION_ONE}/0`]: () => json({ generation: GENERATION_ONE, index: 0, hash: 'f'.repeat(64), bytes: 1 }),
      'GET /__orbit/publish/head': () => headResponse(null),
    })
    const badAckError = await failure(createPublicationClient({ url: LOCAL, token: TOKEN, fetcher: badAck.fetcher }).publish(built))
    expect(badAckError.code).toBe('COMMIT_UNCONFIRMED')
    expect(badAck.calls.some(call => call.path === '/__orbit/publish/commit')).toBe(false)
    const wrongBegin = synthetic({ 'POST /__orbit/publish/begin': () => json({ committed: false, generation: GENERATION_TWO }), 'GET /__orbit/publish/head': () => headResponse(null) })
    expect((await failure(createPublicationClient({ url: LOCAL, token: TOKEN, fetcher: wrongBegin.fetcher }).publish(built))).code).toBe('COMMIT_UNCONFIRMED')
    expect(wrongBegin.calls.filter(call => call.method === 'PUT')).toHaveLength(0)
  })

  it('stops at cancellation during uploads and reports CANCELLED without committing', async () => {
    const built = await publication()
    const controller = new AbortController()
    const remote = synthetic({
      'POST /__orbit/publish/begin': () => json({ committed: false, generation: GENERATION_ONE }),
      [`PUT /__orbit/publish/chunks/${GENERATION_ONE}/0`]: () => { controller.abort(); throw new DOMException('The operation was aborted.', 'AbortError') },
    })
    const error = await failure(createPublicationClient({ url: LOCAL, token: TOKEN, fetcher: remote.fetcher, signal: controller.signal }).publish(built))
    expect(error.code).toBe('CANCELLED')
    expect(remote.calls.map(call => call.path)).toEqual(['/__orbit/publish/begin', `/__orbit/publish/chunks/${GENERATION_ONE}/0`])
  })
})

describe('checkpoint download', () => {
  it('fetches the three private files for the exact generation, verifies bytes and hashes, and confirms the head did not move', async () => {
    const built = await publication()
    const files = {
      boards: decodedFragment(built, built.manifest.checkpoint.files.boards),
      presence: decodedFragment(built, built.manifest.checkpoint.files.presence),
      observations: decodedFragment(built, built.manifest.checkpoint.files.observations),
    }
    const serve = (name: keyof typeof files, generation = GENERATION_ONE): Handler => call => {
      expect(call.path).toBe(`/__orbit/publish/checkpoint/${name}?generation=${GENERATION_ONE}`)
      return new Response(new Uint8Array(files[name]), { status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8', 'X-Orbit-Generation': generation } })
    }
    const remote = synthetic({
      'GET /__orbit/publish/checkpoint/boards': serve('boards'),
      'GET /__orbit/publish/checkpoint/presence': serve('presence'),
      'GET /__orbit/publish/checkpoint/observations': serve('observations'),
      'GET /__orbit/publish/head': () => headResponse(built),
    })
    const client = createPublicationClient({ url: LOCAL, token: TOKEN, fetcher: remote.fetcher })
    const result = await client.checkpoint(headOf(built), built.manifest)
    expect(Buffer.from(result.boards).equals(files.boards)).toBe(true)
    expect(Buffer.from(result.presence).equals(files.presence)).toBe(true)
    expect(Buffer.from(result.observations).equals(files.observations)).toBe(true)
    expect(remote.calls.map(call => call.path)).toEqual([
      `/__orbit/publish/checkpoint/boards?generation=${GENERATION_ONE}`, `/__orbit/publish/checkpoint/presence?generation=${GENERATION_ONE}`,
      `/__orbit/publish/checkpoint/observations?generation=${GENERATION_ONE}`, '/__orbit/publish/head',
    ])

    const foreign = synthetic({ 'GET /__orbit/publish/checkpoint/boards': serve('boards', GENERATION_TWO) })
    expect((await failure(createPublicationClient({ url: LOCAL, token: TOKEN, fetcher: foreign.fetcher }).checkpoint(headOf(built), built.manifest))).code).toBe('CHECKPOINT_GENERATION')
    const corrupt = synthetic({ 'GET /__orbit/publish/checkpoint/boards': () => new Response(Buffer.concat([files.boards, Buffer.from(' ')]), { status: 200, headers: { 'X-Orbit-Generation': GENERATION_ONE } }) })
    expect((await failure(createPublicationClient({ url: LOCAL, token: TOKEN, fetcher: corrupt.fetcher }).checkpoint(headOf(built), built.manifest))).code).toBe('CHECKPOINT_CHECKSUM')
    const moved = synthetic({
      'GET /__orbit/publish/checkpoint/boards': serve('boards'), 'GET /__orbit/publish/checkpoint/presence': serve('presence'),
      'GET /__orbit/publish/checkpoint/observations': serve('observations'),
      'GET /__orbit/publish/head': () => json({ head: { revision: 2, generation: GENERATION_TWO, publishedAt: PUBLISHED_AT }, manifest: { ...built.manifest, generation: GENERATION_TWO, parent: { revision: 1, generation: GENERATION_ONE } } }),
    })
    expect((await failure(createPublicationClient({ url: LOCAL, token: TOKEN, fetcher: moved.fetcher }).checkpoint(headOf(built), built.manifest))).code).toBe('CHECKPOINT_CHANGED')
    const oversized = synthetic({
      'GET /__orbit/publish/checkpoint/boards': serve('boards'), 'GET /__orbit/publish/checkpoint/presence': serve('presence'),
      'GET /__orbit/publish/checkpoint/observations': () => new Response(Buffer.alloc(16 * 1024 * 1024 + 1, 32), { status: 200, headers: { 'X-Orbit-Generation': GENERATION_ONE } }),
    })
    expect((await failure(createPublicationClient({ url: LOCAL, token: TOKEN, fetcher: oversized.fetcher }).checkpoint(headOf(built), built.manifest))).code).toBe('RESPONSE_TOO_LARGE')
  })
})

describe('rollback and metrics', () => {
  it('posts a normalized parent with revision and generation only, and confirms a lost rollback answer through the head', async () => {
    const built = await publication()
    const current = headOf(built)
    const rolledBack: PublicationManifest = {
      ...built.manifest, generation: GENERATION_THREE, parent: { revision: 1, generation: GENERATION_ONE }, rollbackOf: GENERATION_ONE,
    }
    const rolledBackHead: PublicationHead = { revision: 2, generation: GENERATION_THREE, publishedAt: T('06:40:00.000') }
    const remote = synthetic({ 'POST /__orbit/publish/rollback': () => json({ head: rolledBackHead }) })
    const client = createPublicationClient({ url: LOCAL, token: TOKEN, fetcher: remote.fetcher })
    expect(await client.rollback(current, GENERATION_THREE)).toEqual(rolledBackHead)
    expect(JSON.parse(remote.calls[0].body!.toString('utf8'))).toEqual({ generation: GENERATION_THREE, parent: { revision: 1, generation: GENERATION_ONE } })
    const lost = synthetic({
      'POST /__orbit/publish/rollback': networkFailure,
      'GET /__orbit/publish/head': () => json({ head: rolledBackHead, manifest: rolledBack }),
    })
    expect(await createPublicationClient({ url: LOCAL, token: TOKEN, fetcher: lost.fetcher, wait: lost.wait }).rollback(current, GENERATION_THREE)).toEqual(rolledBackHead)
    const notRolledBack = synthetic({
      'POST /__orbit/publish/rollback': networkFailure,
      'GET /__orbit/publish/head': () => json({ head: rolledBackHead, manifest: { ...rolledBack, rollbackOf: undefined } }),
    })
    expect((await failure(createPublicationClient({ url: LOCAL, token: TOKEN, fetcher: notRolledBack.fetcher, wait: notRolledBack.wait }).rollback(current, GENERATION_THREE))).code).toBe('COMMIT_UNCONFIRMED')
    const conflict = synthetic({ 'POST /__orbit/publish/rollback': () => json({ error: 'x', code: 'PUBLISH_CONFLICT' }, 409) })
    expect((await failure(createPublicationClient({ url: LOCAL, token: TOKEN, fetcher: conflict.fetcher }).rollback(current, GENERATION_THREE))).code).toBe('PUBLISH_CONFLICT')
  })

  it('accepts only bounded integer telemetry and never exposes raw remote bodies in client errors', async () => {
    const metrics = {
      instance: GENERATION_TWO, rowsRead: 12, rowsWritten: 3, databaseBytes: 4096, payloadBytes: 1024, chunks: 1, generations: 1,
      activeBodies: 0, peakBodies: 2, activeGenerations: 0, explicitChunkCacheEntries: 1, peakExplicitChunkBuffers: 1, staging: null,
    }
    const valid = synthetic({ 'GET /__orbit/publish/metrics': () => json({ ...metrics, extraField: 'stripped' }) })
    expect(await createPublicationClient({ url: LOCAL, token: TOKEN, fetcher: valid.fetcher }).metrics()).toEqual(metrics)
    const invalid = synthetic({ 'GET /__orbit/publish/metrics': () => json({ ...metrics, rowsRead: -1 }) })
    const invalidError = await failure(createPublicationClient({ url: LOCAL, token: TOKEN, fetcher: invalid.fetcher }).metrics())
    expect(invalidError.code).toBe('INVALID_METRICS')
    const leaky = synthetic({ 'GET /__orbit/publish/metrics': () => json({ error: `secret body mentioning ${TOKEN}`, code: 'PUBLISH_STORAGE_ERROR' }, 500) })
    const leakyError = await failure(createPublicationClient({ url: LOCAL, token: TOKEN, fetcher: leaky.fetcher }).metrics())
    expect(leakyError.message).toBe('Publication request failed (PUBLISH_STORAGE_ERROR)')
    expect(JSON.stringify({ message: leakyError.message, code: leakyError.code, status: leakyError.status })).not.toContain(TOKEN)
    expect(JSON.stringify({ message: leakyError.message, code: leakyError.code, status: leakyError.status })).not.toContain('secret body')
  })
})
