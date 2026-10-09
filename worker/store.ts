import { DurableObject } from 'cloudflare:workers'
import {
  fragmentChunkIndexes, GENERATION_PATTERN, parsePublicationManifest,
  PUBLICATION_LIMITS, publicationChunkKey, PublicationParentSchema,
} from '../shared/publication'
import type {
  PrivateFile, PublicationChunk, PublicationFragment, PublicationHead, PublicationManifest,
} from '../shared/publication'
import {
  projectCatalog, projectObservations, projectPostingStatus, projectionValidatorInput,
  PublicationResponseError, usableBoardCount,
} from './projection'
import type { BodyPart } from './projection'
import { apiNotFound, atPath, jsonResponse, matchesValidator, privateNotFound, SECURITY_HEADERS, SUCCESS_CACHE } from './http'
import { inflatePublicationGzip } from './gzip'

export interface CatalogEnvironment {
  PUBLISH_TOKEN: string
}
type MetaRow = { revision: number; current_id: string | null; previous_id: string | null }
type GenerationRow = { id: string; revision: number; published_at: string; retired_at: number | null; manifest: string; hash: string }
type StagingRow = { id: string; created_at: number; touched_at: number; manifest: string; hash: string }
interface StoredGeneration { head: PublicationHead; manifest: PublicationManifest; hash: string }
const encoder = new TextEncoder()
const hex = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)].map(value => value.toString(16).padStart(2, '0')).join('')
const digest = async (value: Uint8Array | string) =>
  hex(await crypto.subtle.digest('SHA-256', typeof value === 'string' ? encoder.encode(value) : value))
const configurationDigest = (manifest: PublicationManifest) => digest(JSON.stringify({
  checkpointVersion: 1,
  boards: manifest.capture.companies.map(company => [
    company.id, company.provider ?? 'greenhouse', company.board, company.boardRegion ?? '',
  ]).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right), 'en')),
}))
const privateRoot = '/__orbit/publish'
const conflict = () => new PublicationResponseError(409, { error: '발행 기준 버전이 변경됐습니다.', code: 'PUBLISH_CONFLICT' })
const badPublication = () => new PublicationResponseError(400, { error: '발행 자료의 형식이 올바르지 않습니다.', code: 'PUBLISH_BAD_REQUEST' })
const sizeError = () => new PublicationResponseError(413, { error: '발행 자료의 크기 한도를 초과했습니다.', code: 'PUBLISH_LIMIT' })

async function readLimited(request: Request, limit: number): Promise<Uint8Array> {
  const length = request.headers.get('Content-Length')
  if (length && Number(length) > limit) throw sizeError()
  if (!request.body) return new Uint8Array()
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > limit) {
        await reader.cancel('Body exceeds limit')
        throw sizeError()
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const output = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.length }
  return output
}
async function readJson(request: Request, limit: number): Promise<unknown> {
  const bytes = await readLimited(request, limit)
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes)) as unknown }
  catch { throw badPublication() }
}
function requestedGeneration(url: URL): string | null {
  const values = url.searchParams.getAll('generation')
  if (!values.length) return null
  if (values.length !== 1 || !GENERATION_PATTERN.test(values[0])) {
    throw new PublicationResponseError(400, { error: '잘못된 공고 자료 버전입니다.', code: 'CATALOG_BAD_GENERATION' })
  }
  return values[0].toLowerCase()
}
function validToken(supplied: string | null, secret: string | undefined): boolean {
  if (!secret || secret.length < 43 || secret.length > 256 || !supplied || supplied.length > 300) return false
  const expected = `Bearer ${secret}`
  let difference = supplied.length ^ expected.length
  for (let index = 0; index < expected.length; index++) {
    difference |= (supplied.charCodeAt(index) || 0) ^ expected.charCodeAt(index)
  }
  return difference === 0
}
function commitRequest(value: unknown): { generation: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== 1 || !('generation' in value)
    || typeof value.generation !== 'string' || !GENERATION_PATTERN.test(value.generation)
    || value.generation !== value.generation.toLowerCase()) throw badPublication()
  return { generation: value.generation }
}

/** One SQLite-backed object owns public generations and their private state. */
export class CatalogStore extends DurableObject<CatalogEnvironment> {
  private readonly sql: SqlStorage
  private readonly readers = new Map<string, number>()
  private activeBodies = 0
  private peakBodies = 0
  private peakChunkBuffers = 0
  private rowsRead = 0
  private rowsWritten = 0
  private readonly instance = crypto.randomUUID()

  constructor(ctx: DurableObjectState, env: CatalogEnvironment) {
    super(ctx, env)
    this.sql = ctx.storage.sql
    this.query(`CREATE TABLE IF NOT EXISTS orbit_meta (
      singleton INTEGER PRIMARY KEY CHECK(singleton = 1), revision INTEGER NOT NULL,
      current_id TEXT, previous_id TEXT)`)
    this.query('INSERT OR IGNORE INTO orbit_meta VALUES (1, 0, NULL, NULL)')
    this.query(`CREATE TABLE IF NOT EXISTS orbit_generations (
      id TEXT PRIMARY KEY, revision INTEGER NOT NULL, published_at TEXT NOT NULL,
      retired_at INTEGER, manifest TEXT NOT NULL, hash TEXT NOT NULL)`)
    this.query(`CREATE TABLE IF NOT EXISTS orbit_chunks (
      owner TEXT NOT NULL, idx INTEGER NOT NULL, hash TEXT NOT NULL, size INTEGER NOT NULL,
      body BLOB NOT NULL, PRIMARY KEY(owner, idx)) WITHOUT ROWID`)
    this.query(`CREATE TABLE IF NOT EXISTS orbit_staging (
      singleton INTEGER PRIMARY KEY CHECK(singleton = 1), id TEXT NOT NULL,
      created_at INTEGER NOT NULL, touched_at INTEGER NOT NULL, manifest TEXT NOT NULL, hash TEXT NOT NULL)`)
  }

  private query<T extends Record<string, SqlStorageValue>>(query: string, ...bindings: SqlStorageValue[]): T[] {
    const cursor = this.sql.exec<T>(query, ...bindings)
    const rows = cursor.toArray()
    this.rowsRead += cursor.rowsRead
    this.rowsWritten += cursor.rowsWritten
    return rows
  }
  private meta(): MetaRow {
    return this.query<MetaRow>('SELECT revision, current_id, previous_id FROM orbit_meta WHERE singleton = 1')[0]
  }
  private generation(id: string): StoredGeneration | null {
    const row = this.query<GenerationRow>('SELECT * FROM orbit_generations WHERE id = ?', id)[0]
    if (!row) return null
    return {
      head: { revision: row.revision, generation: row.id, publishedAt: row.published_at },
      manifest: parsePublicationManifest(JSON.parse(row.manifest)), hash: row.hash,
    }
  }
  private current(): StoredGeneration | null {
    const id = this.meta().current_id
    if (!id) return null
    const value = this.generation(id)
    if (!value) throw new Error('Current generation is missing')
    return value
  }
  private staging(): StagingRow | null {
    return this.query<StagingRow>('SELECT id, created_at, touched_at, manifest, hash FROM orbit_staging WHERE singleton = 1')[0] ?? null
  }
  private parentMatches(manifest: PublicationManifest, meta: MetaRow): boolean {
    return manifest.parent === null ? meta.revision === 0 && meta.current_id === null
      : manifest.parent.revision === meta.revision && manifest.parent.generation === meta.current_id
  }
  private payloadBytes(): number {
    return this.query<{ bytes: number }>('SELECT COALESCE(SUM(size), 0) AS bytes FROM orbit_chunks')[0].bytes
  }
  private checkAdmission(bytes: number, metadataBytes: number) {
    if (this.payloadBytes() + bytes > PUBLICATION_LIMITS.storage
      || this.sql.databaseSize + bytes + metadataBytes > 900 * 1024 * 1024) throw sizeError()
  }

  private sweep(at: number) {
    this.ctx.storage.transactionSync(() => {
      const staging = this.staging()
      if (staging && (at - staging.touched_at >= PUBLICATION_LIMITS.stagingIdle
        || at - staging.created_at >= PUBLICATION_LIMITS.stagingLifetime)) {
        this.query('DELETE FROM orbit_staging WHERE singleton = 1')
      }
      const meta = this.meta()
      const retired = this.query<{ id: string }>(
        'SELECT id FROM orbit_generations WHERE retired_at IS NOT NULL AND retired_at <= ?',
        at - PUBLICATION_LIMITS.retiredLifetime,
      )
      for (const row of retired) {
        if (row.id !== meta.current_id && row.id !== meta.previous_id && !this.readers.get(row.id)) {
          this.query('DELETE FROM orbit_generations WHERE id = ?', row.id)
        }
      }
      const used = new Set<string>()
      // Consume each cursor synchronously; never retain a SQL cursor over await.
      const cursor = this.sql.exec<{ manifest: string }>(
        'SELECT manifest FROM orbit_generations UNION ALL SELECT manifest FROM orbit_staging',
      )
      for (const row of cursor) {
        const manifest = JSON.parse(row.manifest) as PublicationManifest
        for (const chunk of manifest.chunks) used.add(publicationChunkKey(chunk.owner, chunk.index))
      }
      this.rowsRead += cursor.rowsRead
      this.rowsWritten += cursor.rowsWritten
      const chunks = this.query<{ owner: string; idx: number }>('SELECT owner, idx FROM orbit_chunks')
      for (const chunk of chunks) {
        if (!used.has(publicationChunkKey(chunk.owner, chunk.idx))) {
          this.query('DELETE FROM orbit_chunks WHERE owner = ? AND idx = ?', chunk.owner, chunk.idx)
        }
      }
    })
  }
  private async setNextAlarm(at: number) {
    const candidates: number[] = []
    const staging = this.staging()
    if (staging) candidates.push(
      staging.touched_at + PUBLICATION_LIMITS.stagingIdle,
      staging.created_at + PUBLICATION_LIMITS.stagingLifetime,
    )
    const retired = this.query<{ at: number | null }>(
      'SELECT MIN(retired_at) AS at FROM orbit_generations WHERE retired_at IS NOT NULL',
    )[0].at
    if (retired !== null) candidates.push(Math.max(at + 60_000, retired + PUBLICATION_LIMITS.retiredLifetime))
    if (candidates.length) await this.ctx.storage.setAlarm(Math.min(...candidates))
    else await this.ctx.storage.deleteAlarm()
  }
  async alarm(): Promise<void> {
    const at = Date.now()
    this.sweep(at)
    await this.setNextAlarm(at)
  }

  private async begin(request: Request, at: number): Promise<Response> {
    const value = await readJson(request, PUBLICATION_LIMITS.manifest)
    let manifest: PublicationManifest
    try { manifest = parsePublicationManifest(value) } catch { throw badPublication() }
    if (manifest.rollbackOf || manifest.chunks.some(chunk => chunk.owner !== manifest.generation)
      || Object.values(manifest.fragments).some(fragment => fragment.owner !== manifest.generation)
      || JSON.stringify(manifest.capture) !== JSON.stringify(manifest.checkpoint.capture)
      || Date.parse(manifest.capture.capturedAt) > at + 5 * 60 * 1000
      || await configurationDigest(manifest) !== manifest.capture.configId) throw badPublication()
    const text = JSON.stringify(manifest)
    if (encoder.encode(text).length > PUBLICATION_LIMITS.manifest) throw sizeError()
    const hash = await digest(text)
    this.sweep(Date.now())
    const existing = this.generation(manifest.generation)
    if (existing) {
      if (existing.hash !== hash) throw conflict()
      return jsonResponse(request, { committed: true, head: existing.head })
    }
    this.ctx.storage.transactionSync(() => {
      if (!this.parentMatches(manifest, this.meta())) throw conflict()
      const pending = this.staging()
      if (pending) {
        if (pending.id !== manifest.generation || pending.hash !== hash) throw conflict()
        this.query('UPDATE orbit_staging SET touched_at = ? WHERE singleton = 1', Date.now())
        return
      }
      this.checkAdmission(manifest.chunks.reduce((sum, chunk) => sum + chunk.bytes, 0), encoder.encode(text).length)
      this.query('INSERT INTO orbit_staging VALUES (1, ?, ?, ?, ?, ?)', manifest.generation, Date.now(), Date.now(), text, hash)
    })
    await this.setNextAlarm(Date.now())
    return jsonResponse(request, { committed: false, generation: manifest.generation })
  }

  private async putChunk(request: Request, generation: string, index: number): Promise<Response> {
    this.sweep(Date.now())
    let staging = this.staging()
    const committed = !staging || staging.id !== generation ? this.generation(generation) : null
    const manifest = staging?.id === generation ? parsePublicationManifest(JSON.parse(staging.manifest)) : committed?.manifest
    const expected = manifest?.chunks.find(chunk => chunk.owner === generation && chunk.index === index)
    if (!expected) throw conflict()
    const bytes = await readLimited(request, PUBLICATION_LIMITS.chunk)
    if (bytes.byteLength !== expected.bytes || await digest(bytes) !== expected.hash) throw badPublication()
    this.ctx.storage.transactionSync(() => {
      const row = this.query<{ hash: string; size: number }>(
        'SELECT hash, size FROM orbit_chunks WHERE owner = ? AND idx = ?', generation, index,
      )[0]
      if (row) {
        if (row.hash !== expected.hash || row.size !== expected.bytes) throw conflict()
        const pending = this.staging()
        if (pending?.id === generation && (Date.now() - pending.created_at >= PUBLICATION_LIMITS.stagingLifetime
          || Date.now() - pending.touched_at >= PUBLICATION_LIMITS.stagingIdle)) throw conflict()
        // A completed upload is idempotent, but it cannot renew another stage.
        this.query('UPDATE orbit_staging SET touched_at = ? WHERE id = ?', Date.now(), generation)
        return
      }
      staging = this.staging()
      if (!staging || staging.id !== generation || !this.parentMatches(manifest!, this.meta())
        || Date.now() - staging.created_at >= PUBLICATION_LIMITS.stagingLifetime
        || Date.now() - staging.touched_at >= PUBLICATION_LIMITS.stagingIdle) throw conflict()
      this.checkAdmission(bytes.byteLength, 0)
      this.query('INSERT INTO orbit_chunks VALUES (?, ?, ?, ?, ?)', generation, index, expected.hash, expected.bytes, bytes.buffer as ArrayBuffer)
      this.query('UPDATE orbit_staging SET touched_at = ? WHERE singleton = 1', Date.now())
    })
    await this.setNextAlarm(Date.now())
    return jsonResponse(request, { generation, index, hash: expected.hash, bytes: expected.bytes })
  }

  private install(manifest: PublicationManifest, text: string, hash: string, at: number): PublicationHead {
    const meta = this.meta()
    if (!this.parentMatches(manifest, meta)) throw conflict()
    for (const chunk of manifest.chunks) {
      const stored = this.query<{ hash: string; size: number }>(
        'SELECT hash, size FROM orbit_chunks WHERE owner = ? AND idx = ?', chunk.owner, chunk.index,
      )[0]
      if (!stored || stored.hash !== chunk.hash || stored.size !== chunk.bytes) {
        throw new PublicationResponseError(409, { error: '발행 청크 업로드가 완료되지 않았습니다.', code: 'PUBLISH_INCOMPLETE' })
      }
    }
    const head = { revision: meta.revision + 1, generation: manifest.generation, publishedAt: new Date(at).toISOString() }
    this.query('INSERT INTO orbit_generations VALUES (?, ?, ?, NULL, ?, ?)', head.generation, head.revision, head.publishedAt, text, hash)
    if (meta.previous_id) this.query('UPDATE orbit_generations SET retired_at = ? WHERE id = ?', at, meta.previous_id)
    this.query('UPDATE orbit_meta SET revision = ?, previous_id = current_id, current_id = ? WHERE singleton = 1', head.revision, head.generation)
    return head
  }
  private async commit(request: Request): Promise<Response> {
    const { generation } = commitRequest(await readJson(request, 1024))
    this.sweep(Date.now())
    const existing = this.generation(generation)
    if (existing) return jsonResponse(request, { head: existing.head })
    const head = this.ctx.storage.transactionSync(() => {
      const staging = this.staging()
      if (!staging || staging.id !== generation) throw conflict()
      const manifest = parsePublicationManifest(JSON.parse(staging.manifest))
      const installed = this.install(manifest, staging.manifest, staging.hash, Date.now())
      this.query('DELETE FROM orbit_staging WHERE singleton = 1')
      return installed
    })
    await this.setNextAlarm(Date.now())
    return jsonResponse(request, { head })
  }

  private async rollback(request: Request): Promise<Response> {
    const input = await readJson(request, 2048)
    if (!input || typeof input !== 'object' || Array.isArray(input)
      || Object.keys(input).length !== 2 || !('generation' in input) || !('parent' in input)) throw badPublication()
    const { generation } = commitRequest({ generation: input.generation })
    const parent = PublicationParentSchema.safeParse(input.parent)
    if (!parent.success || !parent.data) throw badPublication()
    const expectedParent = parent.data
    const previousRequest = this.generation(generation)
    if (previousRequest) {
      if (!previousRequest.manifest.rollbackOf
        || previousRequest.manifest.parent?.revision !== expectedParent.revision
        || previousRequest.manifest.parent.generation !== expectedParent.generation) throw conflict()
      return jsonResponse(request, { head: previousRequest.head })
    }
    this.sweep(Date.now())
    const meta = this.meta()
    if (this.staging() || !meta.current_id || !meta.previous_id) throw conflict()
    const current = this.current()!
    const previous = this.generation(meta.previous_id)!
    const publicFragments = Object.entries(previous.manifest.fragments).filter(([, fragment]) => fragment.visibility === 'public')
    const privateFragments = Object.entries(current.manifest.fragments).filter(([, fragment]) => fragment.visibility === 'checkpoint')
    const fragments = Object.fromEntries([...publicFragments, ...privateFragments])
    const required = new Set(Object.values(fragments).flatMap(fragment =>
      fragmentChunkIndexes(fragment).map(index => publicationChunkKey(fragment.owner, index))))
    const allChunks = new Map([...previous.manifest.chunks, ...current.manifest.chunks]
      .map(chunk => [publicationChunkKey(chunk.owner, chunk.index), chunk]))
    let manifest: PublicationManifest
    try {
      manifest = parsePublicationManifest({
        ...previous.manifest, generation, parent: expectedParent,
        checkpoint: current.manifest.checkpoint, fragments,
        chunks: [...allChunks].filter(([key]) => required.has(key)).map(([, chunk]) => chunk),
        rollbackOf: previous.head.generation,
      })
    } catch { throw badPublication() }
    const text = JSON.stringify(manifest)
    if (encoder.encode(text).length > PUBLICATION_LIMITS.manifest) throw sizeError()
    const hash = await digest(text)
    const head = this.ctx.storage.transactionSync(() => {
      if (this.staging()) throw conflict()
      this.checkAdmission(0, encoder.encode(text).length)
      return this.install(manifest, text, hash, Date.now())
    })
    await this.setNextAlarm(Date.now())
    return jsonResponse(request, { head })
  }

  private pin(generation: string): () => void {
    this.readers.set(generation, (this.readers.get(generation) ?? 0) + 1)
    let done = false
    return () => {
      if (done) return
      done = true
      const count = (this.readers.get(generation) ?? 1) - 1
      if (count) this.readers.set(generation, count)
      else this.readers.delete(generation)
    }
  }

  private busy(request: Request, at: number) {
    return jsonResponse(request, {
      error: '공고 조회 요청이 많아요. 잠시 후 다시 확인해 주세요.', code: 'CATALOG_BUSY',
      retryAt: new Date(at + 60_000).toISOString(),
    }, 503, { 'Retry-After': '60' })
  }

  private async streamResponse(
    parts: BodyPart[], manifest: PublicationManifest, expectedBytes: number,
    headers: HeadersInit, release: () => void,
  ): Promise<Response> {
    let cached: { key: string; bytes: Uint8Array } | null = null
    let admitted = false
    let finished = false
    let failure: { reason: unknown } | undefined
    let bridge: FixedLengthStream | undefined
    let writer: WritableStreamDefaultWriter<ArrayBuffer | ArrayBufferView> | undefined
    let iterator: AsyncGenerator<Uint8Array> | undefined
    let iteratorDone = false
    let completion: Promise<void> | undefined
    let aborting: Promise<void> | undefined
    let cleaning: Promise<void> | undefined
    const fail = (reason: unknown) => { failure ??= { reason } }
    const checkLive = () => { if (failure) throw failure.reason }
    const finish = () => {
      if (finished) return
      finished = true
      cached = null
      if (admitted) this.activeBodies--
      try { release() } catch (error) { fail(error) }
    }
    const abort = () => aborting ??= (async () => {
      try {
        if (writer) await writer.abort(failure?.reason)
        else if (bridge) await bridge.writable.abort(failure?.reason)
      } catch (error) { fail(error) }
    })()
    const cleanup = () => cleaning ??= (async () => {
      try {
        if (failure) await abort()
        if (iterator && !iteratorDone) {
          // Only the producer (or setup before it starts) calls cleanup.
          // Its pending next() has settled before return() is requested.
          try { await iterator.return(undefined) }
          catch (error) { fail(error); await abort() }
          iteratorDone = true
        }
        try { writer?.releaseLock() }
        catch (error) { fail(error); await abort() }
      } finally {
        iterator = undefined
        writer = undefined
        bridge = undefined
        finish()
      }
    })()

    try {
      if (!Number.isSafeInteger(expectedBytes) || expectedBytes < 0 || expectedBytes > PUBLICATION_LIMITS.catalog) {
        throw new Error('Invalid response size')
      }
      // Claim the admission slot before the first suspension.
      this.activeBodies++
      admitted = true
      this.peakBodies = Math.max(this.peakBodies, this.activeBodies)
      const chunks = new Map(manifest.chunks.map(chunk => [publicationChunkKey(chunk.owner, chunk.index), chunk]))
      const loadChunk = async (expected: PublicationChunk): Promise<Uint8Array> => {
        checkLive()
        const key = publicationChunkKey(expected.owner, expected.index)
        if (cached?.key === key) return cached.bytes
        // One explicit cache entry; the decoder can still hold the previous slice.
        cached = null
        const row = this.query<{ hash: string; size: number; body: ArrayBuffer }>(
          'SELECT hash, size, body FROM orbit_chunks WHERE owner = ? AND idx = ?', expected.owner, expected.index,
        )[0]
        if (!row || row.hash !== expected.hash || row.size !== expected.bytes) throw new Error('Publication chunk is missing')
        const bytes = new Uint8Array(row.body)
        this.peakChunkBuffers = Math.max(this.peakChunkBuffers, 1)
        if (bytes.byteLength !== expected.bytes) throw new Error('Publication chunk checksum failed')
        const hash = await digest(bytes)
        checkLive()
        if (hash !== expected.hash) throw new Error('Publication chunk checksum failed')
        cached = { key, bytes }
        return bytes
      }
      const inflate = async function* (fragment: PublicationFragment): AsyncGenerator<Uint8Array> {
        checkLive()
        const compressedDigest = new crypto.DigestStream('SHA-256')
        const compressedWriter = compressedDigest.getWriter()
        void compressedDigest.digest.catch(() => {})
        let compressedClosed = false
        const source = async function* (): AsyncGenerator<Uint8Array> {
          let offset = fragment.offset
          const end = offset + fragment.compressedBytes
          try {
            while (offset < end) {
              checkLive()
              const index = Math.floor(offset / PUBLICATION_LIMITS.chunk)
              const expected = chunks.get(publicationChunkKey(fragment.owner, index))
              if (!expected) throw new Error('Missing fragment chunk reference')
              const bytes = await loadChunk(expected)
              checkLive()
              const start = offset - index * PUBLICATION_LIMITS.chunk
              const length = Math.min(64 * 1024, end - offset, bytes.length - start)
              if (length <= 0) throw new Error('Invalid fragment range')
              const slice = bytes.subarray(start, start + length)
              await compressedWriter.write(slice)
              checkLive()
              offset += length
              yield slice
            }
            await compressedWriter.close()
            compressedClosed = true
            checkLive()
            const hash = hex(await compressedDigest.digest)
            checkLive()
            if (hash !== fragment.compressedHash) throw new Error('Compressed fragment checksum failed')
          } finally {
            if (!compressedClosed) await compressedWriter.abort().catch(() => {})
          }
        }
        const decodedDigest = new crypto.DigestStream('SHA-256')
        void decodedDigest.digest.catch(() => {})
        const decodedWriter = decodedDigest.getWriter()
        let decoded = 0
        let decodedClosed = false
        try {
          for await (const value of inflatePublicationGzip(source(), fragment.decodedBytes)) {
            checkLive()
            decoded += value.byteLength
            await decodedWriter.write(value)
            checkLive()
            yield value
          }
          await decodedWriter.close()
          decodedClosed = true
          checkLive()
          const hash = hex(await decodedDigest.digest)
          checkLive()
          if (decoded !== fragment.decodedBytes || hash !== fragment.decodedHash) {
            throw new Error('Decoded fragment checksum failed')
          }
        } finally {
          if (!compressedClosed) await compressedWriter.abort().catch(() => {})
          if (!decodedClosed) await decodedWriter.abort().catch(() => {})
        }
      }
      const output = async function* (): AsyncGenerator<Uint8Array> {
        for (const part of parts) {
          checkLive()
          if ('text' in part) {
            let offset = 0
            while (offset < part.text.length) {
              checkLive()
              // UTF-8 needs at most three bytes per UTF-16 code unit.
              const block = new Uint8Array(Math.min(64 * 1024, (part.text.length - offset) * 3))
              const { read, written } = encoder.encodeInto(part.text.slice(offset), block)
              if (!read) throw new Error('Response encoder made no progress')
              offset += read
              yield block.subarray(0, written)
            }
          } else yield* inflate(manifest.fragments[part.fragment])
        }
      }
      const values = output()
      iterator = values
      if (expectedBytes === 0) {
        // A completed empty response cannot convey a later integrity failure.
        while (true) {
          const item = await values.next()
          checkLive()
          if (item.done) { iteratorDone = true; break }
          if (item.value.byteLength) throw new Error('Response exceeds its size')
        }
        await cleanup()
        checkLive()
        return new Response(new Uint8Array(0), { headers, encodeBody: 'manual' })
      }

      bridge = new FixedLengthStream(expectedBytes, { highWaterMark: 0 })
      writer = bridge.writable.getWriter()
      // Cancellation is observed here; only the producer finalizer releases the pin.
      void writer.closed.catch(fail)
      const sink = writer
      const response = new Response(bridge.readable, { headers, encodeBody: 'manual' })
      completion = (async () => {
        let produced = 0
        let finalByte: Uint8Array | undefined
        try {
          while (true) {
            checkLive()
            const item = await values.next()
            checkLive()
            if (item.done) { iteratorDone = true; break }
            const value = item.value
            if (!value.byteLength) continue
            if (value.byteLength > expectedBytes - produced) throw new Error('Response exceeds its size')
            produced += value.byteLength
            let length = value.byteLength
            if (produced === expectedBytes) {
              // Copy one byte; a subarray could retain an entire decoder block.
              finalByte = new Uint8Array([value[value.byteLength - 1]])
              length--
            }
            if (length) await sink.write(value.subarray(0, length))
          }
          if (produced !== expectedBytes || !finalByte) throw new Error('Incomplete response')
          // The iterator is done: all fragment and gzip integrity checks passed.
          checkLive()
          await sink.write(finalByte)
          await sink.close()
        } catch (error) { fail(error) }
        finally { await cleanup() }
        checkLive()
      })()
      void completion.catch(() => {})
      // Lifetime support, not a cancellation signal. Keep the native ctx receiver.
      this.ctx.waitUntil(completion)
      return response
    } catch (error) {
      fail(error)
      await abort()
      if (completion) await completion.catch(() => {})
      else await cleanup()
      // Setup/registration failure must join any started producer before returning.
      checkLive()
      throw error
    }
  }

  private async publicResponse(request: Request, url: URL, at: number): Promise<Response> {
    if (!['GET', 'HEAD'].includes(request.method)) return apiNotFound(request)
    if (url.pathname === '/api/health') {
      const current = this.current()
      const usableBoards = current ? usableBoardCount(current.manifest, at) : 0
      return jsonResponse(request, {
        status: 'ok', app: 'orbit', mode: 'production', delivery: 'scheduled',
        generation: current?.head.generation ?? null, publishedAt: current?.head.publishedAt ?? null,
        intervalMinutes: 30, boards: current?.manifest.capture.companies.length ?? 0, usableBoards,
        ready: usableBoards > 0,
      })
    }
    if (url.pathname === '/api/catalog/progress') {
      return jsonResponse(request, { error: '수집 진행 정보를 지원하지 않는 서버입니다.' }, 404)
    }
    if (!['/api/catalog', '/api/posting-status', '/api/observations'].includes(url.pathname)) return apiNotFound(request)
    if (url.pathname === '/api/catalog' && (url.searchParams.getAll('source').length > 1
      || !['public', 'sample', 'greenhouse'].includes(url.searchParams.get('source') ?? 'public'))) {
      return jsonResponse(request, { error: '지원하지 않는 데이터 소스입니다.' }, 400)
    }
    const selected = requestedGeneration(url)
    const stored = selected ? this.generation(selected) : this.current()
    if (!stored) {
      if (selected) return jsonResponse(request, {
        error: '공고 자료가 갱신됐어요. 공고를 새로고침한 뒤 다시 확인해 주세요.', code: 'CATALOG_GENERATION_GONE',
      }, 410)
      return jsonResponse(request, {
        error: '공개 채용 게시판에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요.',
        code: 'CATALOG_UNAVAILABLE', retryAt: new Date(at + 60_000).toISOString(),
      }, 503)
    }
    const release = this.pin(stored.head.generation)
    let transferred = false
    try {
      // Expiry/projection happens before conditional validation and body admission.
      const projection = url.pathname === '/api/catalog' ? projectCatalog(stored.manifest, stored.head, at)
        : url.pathname === '/api/posting-status' ? projectPostingStatus(stored.manifest, at)
          : projectObservations(stored.manifest, at)
      const etag = `W/"${await digest(projectionValidatorInput(stored.manifest, projection))}"`
      const headers = {
        ...SECURITY_HEADERS, 'Cache-Control': SUCCESS_CACHE, 'Content-Type': 'application/json; charset=utf-8',
        'Vary': 'Accept-Encoding', 'ETag': etag, 'X-Orbit-Generation': stored.head.generation,
      }
      if (matchesValidator(request.headers.get('If-None-Match'), etag)) return new Response(null, { status: 304, headers })
      if (request.method === 'HEAD') return new Response(null, { headers })
      if (this.activeBodies >= PUBLICATION_LIMITS.streams) return this.busy(request, at)
      transferred = true
      return await this.streamResponse(projection.parts, stored.manifest, projection.bytes, headers, release)
    } finally {
      if (!transferred) release()
    }
  }

  private async checkpoint(request: Request, name: PrivateFile, url: URL, at: number): Promise<Response> {
    const selected = requestedGeneration(url)
    const stored = this.current()
    if (!stored || selected !== stored.head.generation) throw conflict()
    const fragment = stored.manifest.checkpoint.files[name]
    const release = this.pin(stored.head.generation)
    let transferred = false
    try {
      const headers = {
        ...SECURITY_HEADERS, 'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store', 'Vary': 'Accept-Encoding', 'X-Orbit-Generation': stored.head.generation,
      }
      if (request.method === 'HEAD') return new Response(null, { headers })
      if (this.activeBodies >= PUBLICATION_LIMITS.streams) return this.busy(request, at)
      const parts: BodyPart[] = [{ fragment }]
      const expectedBytes = stored.manifest.fragments[fragment].decodedBytes
      transferred = true
      return await this.streamResponse(parts, stored.manifest, expectedBytes, headers, release)
    } finally {
      if (!transferred) release()
    }
  }

  private async privateResponse(request: Request, url: URL, at: number): Promise<Response> {
    // This must precede all method/path handling and every body read.
    if (!validToken(request.headers.get('Authorization'), this.env.PUBLISH_TOKEN)) {
      return jsonResponse(request, { error: '발행 인증이 필요합니다.', code: 'PUBLISH_UNAUTHORIZED' }, 401,
        { 'WWW-Authenticate': 'Bearer' })
    }
    const path = url.pathname.slice(privateRoot.length)
    if (['GET', 'HEAD'].includes(request.method)) {
      if (path === '/head') {
        const stored = this.current()
        return jsonResponse(request, { head: stored?.head ?? null, manifest: stored?.manifest ?? null })
      }
      if (path === '/metrics') {
        return jsonResponse(request, {
          instance: this.instance, rowsRead: this.rowsRead, rowsWritten: this.rowsWritten,
          databaseBytes: this.sql.databaseSize, payloadBytes: this.payloadBytes(),
          chunks: this.query<{ count: number }>('SELECT COUNT(*) AS count FROM orbit_chunks')[0].count,
          generations: this.query<{ count: number }>('SELECT COUNT(*) AS count FROM orbit_generations')[0].count,
          activeBodies: this.activeBodies, peakBodies: this.peakBodies,
          activeGenerations: [...this.readers.values()].reduce((sum, count) => sum + count, 0),
          explicitChunkCacheEntries: 1, peakExplicitChunkBuffers: this.peakChunkBuffers,
          staging: this.staging()?.id ?? null,
        })
      }
      const checkpoint = /^\/checkpoint\/(boards|presence|observations)$/.exec(path)
      if (checkpoint) return this.checkpoint(request, checkpoint[1] as PrivateFile, url, at)
    }
    if (request.method === 'POST') {
      if (path === '/begin') return this.begin(request, at)
      if (path === '/commit') return this.commit(request)
      if (path === '/rollback') return this.rollback(request)
    }
    if (request.method === 'PUT') {
      const chunk = /^\/chunks\/([a-f0-9-]+)\/(0|[1-9]\d*)$/.exec(path)
      if (chunk && GENERATION_PATTERN.test(chunk[1]) && Number(chunk[2]) <= 63) {
        return this.putChunk(request, chunk[1], Number(chunk[2]))
      }
    }
    return privateNotFound(request)
  }

  async fetch(request: Request): Promise<Response> {
    const at = Date.now()
    const url = new URL(request.url)
    const privateRequest = atPath(url.pathname, privateRoot)
    try {
      return await (privateRequest ? this.privateResponse(request, url, at) : this.publicResponse(request, url, at))
    } catch (error) {
      if (error instanceof PublicationResponseError) return jsonResponse(request, error.body, error.status)
      // Never log a manifest, request headers, token or collected job body.
      console.error(privateRequest ? 'Publication storage operation failed' : 'Catalog storage read failed')
      return jsonResponse(request, {
        error: '저장된 공고 자료를 읽지 못했어요. 잠시 후 다시 확인해 주세요.',
        code: privateRequest ? 'PUBLISH_STORAGE_ERROR' : 'CATALOG_STORAGE_ERROR',
      }, 503)
    }
  }
}
