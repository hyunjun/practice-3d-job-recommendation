import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { PrivateFile, PublicationHead, PublicationManifest } from '../../../shared/publication'

/**
 * A synthetic publication origin for the publish CLI under test. It speaks the
 * stage82 private protocol shape well enough for the real client, and it can
 * misbehave on command: lose a commit response, hold a response open, answer
 * metrics with a storage error, or redirect. It never validates manifests the
 * way the Worker does; those contracts are proven against the real store in
 * tests/cloudflare/worker-contract.spec.ts.
 *
 * Waiters own their timers and are rejected on close; close() stops accepting,
 * ends held responses, closes every socket and completes within a bound (ACT82-6).
 */
export type CommitBehaviour = 'ok' | 'drop-after-commit' | 'drop-without-commit' | 'hold'
export interface PublicationServerOptions {
  token: string
  initial?: { head: PublicationHead; manifest: PublicationManifest; files?: Record<PrivateFile, Uint8Array> } | null
  commit?: CommitBehaviour
  /** What `/head` reports once a commit has been installed (or dropped). */
  headAfterCommit?: 'committed' | 'none'
  metrics?: 'ok' | 'storage-error'
  /** Answer every request with a 302 to this origin instead of serving it. */
  redirectTo?: string
  /** Never answer `/head`; used to cancel the CLI mid-request. */
  holdHead?: boolean
  /** Send this checkpoint file's headers and first byte, then withhold the rest until `releaseCheckpoint()` (ACLI82-R2 held-body witness). */
  holdCheckpoint?: PrivateFile
}
export interface RecordedRequest {
  method: string
  path: string
  /** The raw query string including `?`, or '' (generation selectors are part of the protocol). */
  query: string
  authorized: boolean
  bodyBytes: number
  /** Parsed JSON for commit/rollback, and the begin manifest's identity fields; never the token or chunk bytes. */
  body?: unknown
}
export interface PublicationServer {
  origin: string
  requests: RecordedRequest[]
  current: () => { head: PublicationHead; manifest: PublicationManifest } | null
  waitFor: (predicate: (request: RecordedRequest) => boolean, timeoutMs?: number) => Promise<RecordedRequest>
  releaseHeld: () => void
  /** Complete the withheld checkpoint body; returns how many held bodies were released. */
  releaseCheckpoint: () => number
  close: () => Promise<void>
}

const METRICS_INSTANCE = '55555555-5555-4555-8555-555555555555'
const PRIVATE_ROOT = '/__orbit/publish'
const CLOSE_TIMEOUT_MS = 5_000
const json = (response: ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}) => {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers })
  response.end(JSON.stringify(value))
}
async function readBody(request: IncomingMessage, limit = 2 * 1024 * 1024): Promise<Buffer> {
  const parts: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    size += (chunk as Buffer).length
    if (size > limit) throw new Error('Fixture request body exceeds its limit')
    parts.push(chunk as Buffer)
  }
  return Buffer.concat(parts)
}

interface Waiter {
  predicate: (request: RecordedRequest) => boolean
  resolve: (request: RecordedRequest) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export async function startPublicationServer(options: PublicationServerOptions): Promise<PublicationServer> {
  const requests: RecordedRequest[] = []
  const waiters: Waiter[] = []
  const held = new Set<ServerResponse>()
  const heldCheckpoints: { response: ServerResponse; rest: Buffer }[] = []
  const chunks = new Map<string, Buffer>()
  let staging: PublicationManifest | null = null
  let current = options.initial ?? null
  let committedAfterStart = false
  let closed = false
  const settleWaiter = (waiter: Waiter, outcome: { request: RecordedRequest } | { error: Error }) => {
    clearTimeout(waiter.timer)
    const index = waiters.indexOf(waiter)
    if (index >= 0) waiters.splice(index, 1)
    if ('request' in outcome) waiter.resolve(outcome.request)
    else waiter.reject(outcome.error)
  }
  const record = (entry: RecordedRequest) => {
    requests.push(entry)
    for (const waiter of [...waiters]) if (waiter.predicate(entry)) settleWaiter(waiter, { request: entry })
  }
  const install = (manifest: PublicationManifest): PublicationHead => {
    const head = { revision: (manifest.parent?.revision ?? 0) + 1, generation: manifest.generation, publishedAt: new Date().toISOString() }
    current = { head, manifest }
    staging = null
    committedAfterStart = true
    return head
  }
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://fixture.local')
    const path = url.pathname
    const authorized = request.headers.authorization === `Bearer ${options.token}`
    const entry: RecordedRequest = { method: request.method ?? 'GET', path, query: url.search, authorized, bodyBytes: 0 }
    try {
      if (options.redirectTo) {
        await readBody(request)
        record(entry)
        response.writeHead(302, { Location: `${options.redirectTo}${path}${url.search}` })
        response.end()
        return
      }
      if (!path.startsWith(PRIVATE_ROOT)) {
        record(entry)
        return json(response, 404, { error: '존재하지 않는 API입니다.' })
      }
      if (!authorized) {
        record(entry)
        return json(response, 401, { error: '발행 인증이 필요합니다.', code: 'PUBLISH_UNAUTHORIZED' }, { 'WWW-Authenticate': 'Bearer' })
      }
      const route = path.slice(PRIVATE_ROOT.length)
      if (request.method === 'GET' && route === '/head') {
        record(entry)
        if (options.holdHead) { held.add(response); return }
        const visible = committedAfterStart && options.headAfterCommit === 'none' ? null : current
        return json(response, 200, visible ? { head: visible.head, manifest: visible.manifest } : { head: null, manifest: null })
      }
      if (request.method === 'GET' && route === '/metrics') {
        record(entry)
        if (options.metrics === 'storage-error') {
          return json(response, 500, { error: '저장된 공고 자료를 읽지 못했어요. 잠시 후 다시 확인해 주세요.', code: 'PUBLISH_STORAGE_ERROR' })
        }
        return json(response, 200, {
          instance: METRICS_INSTANCE, rowsRead: 0, rowsWritten: 0, databaseBytes: 0,
          payloadBytes: [...chunks.values()].reduce((sum, chunk) => sum + chunk.length, 0),
          chunks: chunks.size, generations: current ? 1 : 0, activeBodies: 0, peakBodies: 0, activeGenerations: 0,
          explicitChunkCacheEntries: 1, peakExplicitChunkBuffers: 0, staging: staging?.generation ?? null,
        })
      }
      const checkpoint = /^\/checkpoint\/(boards|presence|observations)$/.exec(route)
      if (request.method === 'GET' && checkpoint) {
        record(entry)
        const name = checkpoint[1] as PrivateFile
        const files = options.initial?.files
        if (!current || !files || url.searchParams.get('generation') !== current.head.generation) {
          return json(response, 409, { error: '발행 기준 버전이 변경됐습니다.', code: 'PUBLISH_CONFLICT' })
        }
        const bytes = Buffer.from(files[name])
        response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': String(bytes.length), 'X-Orbit-Generation': current.head.generation })
        if (options.holdCheckpoint === name && bytes.length > 1) {
          // Headers and one byte are on the wire; the client is now inside its body read until the test releases the rest.
          response.write(bytes.subarray(0, 1))
          heldCheckpoints.push({ response, rest: bytes.subarray(1) })
          return
        }
        response.end(bytes)
        return
      }
      if (request.method === 'POST' && route === '/begin') {
        const body = await readBody(request)
        entry.bodyBytes = body.length
        const manifest = JSON.parse(body.toString('utf8')) as PublicationManifest
        entry.body = { generation: manifest.generation, parent: manifest.parent, collectorCommit: manifest.capture.collectorCommit, companies: manifest.capture.companies.length, chunks: manifest.chunks.length }
        record(entry)
        if (current?.manifest.generation === manifest.generation) return json(response, 200, { committed: true, head: current.head })
        staging = manifest
        return json(response, 200, { committed: false, generation: manifest.generation })
      }
      const chunk = /^\/chunks\/([a-f0-9-]+)\/(\d+)$/.exec(route)
      if (request.method === 'PUT' && chunk) {
        const body = await readBody(request)
        entry.bodyBytes = body.length
        record(entry)
        chunks.set(`${chunk[1]}:${chunk[2]}`, body)
        return json(response, 200, { generation: chunk[1], index: Number(chunk[2]), hash: createHash('sha256').update(body).digest('hex'), bytes: body.length })
      }
      if (request.method === 'POST' && route === '/commit') {
        const body = JSON.parse((await readBody(request)).toString('utf8')) as { generation: string }
        entry.body = body
        record(entry)
        const behaviour = options.commit ?? 'ok'
        if (behaviour === 'hold') { held.add(response); return }
        if (current?.manifest.generation === body.generation && behaviour === 'ok') return json(response, 200, { head: current.head })
        if (staging && staging.generation === body.generation && behaviour !== 'drop-without-commit') {
          const head = install(staging)
          if (behaviour === 'ok') return json(response, 200, { head })
        }
        if (behaviour === 'drop-after-commit' || behaviour === 'drop-without-commit') { response.destroy(); return }
        return json(response, 409, { error: '발행 기준 버전이 변경됐습니다.', code: 'PUBLISH_CONFLICT' })
      }
      if (request.method === 'POST' && route === '/rollback') {
        const body = JSON.parse((await readBody(request)).toString('utf8')) as { generation: string; parent: { revision: number; generation: string } }
        entry.body = body
        record(entry)
        if (!current || body.parent?.generation !== current.head.generation || body.parent.revision !== current.head.revision) {
          return json(response, 409, { error: '발행 기준 버전이 변경됐습니다.', code: 'PUBLISH_CONFLICT' })
        }
        const head = install({ ...current.manifest, generation: body.generation, parent: { revision: body.parent.revision, generation: body.parent.generation }, rollbackOf: current.manifest.generation })
        return json(response, 200, { head })
      }
      record(entry)
      return json(response, 404, { error: '존재하지 않는 발행 경로입니다.', code: 'PUBLISH_NOT_FOUND' })
    } catch {
      record(entry)
      return json(response, 400, { error: '발행 자료의 형식이 올바르지 않습니다.', code: 'PUBLISH_BAD_REQUEST' })
    }
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const port = (server.address() as AddressInfo).port
  if (port === 8787 || port === 8790) {
    await new Promise<void>(resolve => server.close(() => resolve()))
    throw new Error('The fixture must not use a reserved local port')
  }
  const releaseHeld = () => {
    for (const response of held) response.destroy()
    held.clear()
    // A checkpoint body still withheld at close is dropped, never silently completed.
    for (const { response } of heldCheckpoints.splice(0)) response.destroy()
  }
  const releaseCheckpoint = () => {
    const releasing = heldCheckpoints.splice(0)
    for (const { response, rest } of releasing) response.end(rest)
    return releasing.length
  }
  return {
    origin: `http://127.0.0.1:${port}`,
    requests,
    current: () => current,
    waitFor: (predicate, timeoutMs = 60_000) => new Promise((resolve, reject) => {
      if (closed) return reject(new Error('The fixture origin is closed'))
      const existing = requests.find(predicate)
      if (existing) return resolve(existing)
      const waiter: Waiter = {
        predicate, resolve, reject,
        timer: setTimeout(() => settleWaiter(waiter, { error: new Error('The fixture did not receive the expected request in time') }), timeoutMs),
      }
      waiters.push(waiter)
    }),
    releaseHeld,
    releaseCheckpoint,
    close: () => new Promise<void>((resolve, reject) => {
      closed = true
      for (const waiter of [...waiters]) settleWaiter(waiter, { error: new Error('The fixture origin closed before the expected request') })
      releaseHeld()
      server.closeAllConnections()
      const timer = setTimeout(() => {
        server.closeAllConnections()
        reject(new Error('The fixture origin did not close within the bound'))
      }, CLOSE_TIMEOUT_MS)
      server.close(error => {
        clearTimeout(timer)
        if (error) reject(error)
        else resolve()
      })
    }),
  }
}
