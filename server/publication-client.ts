import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import {
  GENERATION_PATTERN, parsePublicationManifest, PRIVATE_FILES, PRIVATE_FILE_LIMITS, PublicationHeadSchema, PUBLICATION_LIMITS,
} from '../shared/publication'
import type { PrivateFile, PublicationHead, PublicationManifest } from '../shared/publication'
import type { BuiltPublication } from './publication-build'
import { publicationConfigurationId, publicationHash } from './publication-collector'

const metricCount = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const MetricsSchema = z.object({
  instance: z.string().regex(GENERATION_PATTERN),
  rowsRead: metricCount, rowsWritten: metricCount, databaseBytes: metricCount, payloadBytes: metricCount,
  chunks: metricCount, generations: metricCount, activeBodies: metricCount, peakBodies: metricCount,
  activeGenerations: metricCount, explicitChunkCacheEntries: metricCount, peakExplicitChunkBuffers: metricCount,
  staging: z.string().regex(GENERATION_PATTERN).nullable(),
})
export type PublicationMetrics = z.infer<typeof MetricsSchema>

export class PublicationClientError extends Error {
  constructor(readonly code: string, readonly status?: number) { super(`Publication request failed (${code})`) }
}
export function publicationOrigin(value: string): string {
  const url = new URL(value)
  const production = url.origin === 'https://job.hyunjun.workers.dev'
  const local = url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    && url.port !== '8787'
  if ((!production && !local) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Use the configured Workers origin or a local verification origin')
  }
  return url.origin
}

async function responseBytes(response: Response, limit: number): Promise<Uint8Array> {
  if (!response.body) throw new PublicationClientError('EMPTY_RESPONSE')
  const reader = response.body.getReader()
  const parts: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      size += value.length
      if (size > limit) {
        await reader.cancel()
        throw new PublicationClientError('RESPONSE_TOO_LARGE')
      }
      parts.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const data = new Uint8Array(size)
  let offset = 0
  for (const part of parts) { data.set(part, offset); offset += part.length }
  return data
}
function parseJson(bytes: Uint8Array): unknown {
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown }
  catch { throw new PublicationClientError('INVALID_RESPONSE') }
}

export function createPublicationClient({
  url, token, fetcher = fetch, signal, wait = (milliseconds: number) => delay(milliseconds, undefined, { signal }),
}: {
  url: string; token: string; fetcher?: typeof fetch; signal?: AbortSignal; wait?: (milliseconds: number) => Promise<unknown>
}) {
  const origin = publicationOrigin(url)
  if (token.length < 43 || token.length > 256 || /[\r\n]/.test(token)) throw new Error('A dedicated publication token is required')
  const request = async (path: string, method = 'GET', body?: string | Uint8Array): Promise<Response> => {
    for (let attempt = 0; attempt < 3; attempt++) {
      signal?.throwIfAborted()
      let response: Response
      try {
        const timeout = AbortSignal.timeout(90_000)
        response = await fetcher(`${origin}/__orbit/publish${path}`, {
          method, redirect: 'manual', signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
          headers: {
            Authorization: `Bearer ${token}`, 'Accept-Encoding': 'gzip',
            ...(body === undefined ? {} : { 'Content-Type': typeof body === 'string' ? 'application/json' : 'application/octet-stream' }),
          },
          ...(body === undefined ? {} : { body: typeof body === 'string' ? body : Buffer.from(body) }),
        })
      } catch {
        if (signal?.aborted) throw new PublicationClientError('CANCELLED')
        if (attempt === 2) throw new PublicationClientError('NETWORK')
        await wait(1000 * (attempt + 1))
        continue
      }
      if (response.ok) return response
      if ([429, 502, 503, 504].includes(response.status) && attempt < 2) {
        const supplied = Number(response.headers.get('Retry-After'))
        const after = Number.isFinite(supplied) && supplied > 0 ? Math.min(supplied, 120) * 1000 : 1000 * (attempt + 1)
        await response.body?.cancel()
        await wait(after)
        continue
      }
      let code = `HTTP_${response.status}`
      try {
        const body = parseJson(await responseBytes(response, 4096))
        if (body && typeof body === 'object' && 'code' in body
          && typeof body.code === 'string' && /^[A-Z0-9_]{1,64}$/.test(body.code)) code = body.code
      } catch { /* Never echo remote bodies, redirects or request credentials. */ }
      throw new PublicationClientError(code, response.status)
    }
    throw new PublicationClientError('NETWORK')
  }
  const json = async (path: string, method = 'GET', body?: unknown) =>
    parseJson(await responseBytes(await request(path, method, body === undefined ? undefined : JSON.stringify(body)), PUBLICATION_LIMITS.manifest + 4096))
  const head = async (): Promise<{ head: PublicationHead | null; manifest: PublicationManifest | null }> => {
    const result = await json('/head')
    if (!result || typeof result !== 'object' || !('head' in result) || !('manifest' in result)) throw new PublicationClientError('INVALID_HEAD')
    if (result.head === null && result.manifest === null) return { head: null, manifest: null }
    const current = PublicationHeadSchema.parse(result.head)
    const manifest = parsePublicationManifest(result.manifest)
    if (manifest.generation !== current.generation || (manifest.parent?.revision ?? 0) + 1 !== current.revision
      || publicationConfigurationId(manifest.capture.companies) !== manifest.capture.configId
      || publicationConfigurationId(manifest.checkpoint.capture.companies) !== manifest.checkpoint.capture.configId) {
      throw new PublicationClientError('INVALID_HEAD')
    }
    return { head: current, manifest }
  }
  const committedHead = (value: unknown, generation: string, revision: number) => {
    if (!value || typeof value !== 'object' || !('head' in value)) throw new PublicationClientError('INVALID_COMMIT')
    const result = PublicationHeadSchema.parse(value.head)
    if (result.generation !== generation || result.revision !== revision) throw new PublicationClientError('INVALID_COMMIT')
    return result
  }
  const confirm = async (
    error: unknown, generation: string, parent: PublicationManifest['parent'],
    matches: (manifest: PublicationManifest) => boolean,
  ): Promise<PublicationHead> => {
    if (signal?.aborted) throw new PublicationClientError('CANCELLED')
    if (error instanceof PublicationClientError && error.status !== undefined
      && error.status < 500 && error.status !== 429) throw error
    // The commit may have completed before a connection/body/JSON failure.
    // One bounded head query can prove it; unrelated or unreadable state cannot.
    try {
      const actual = await head()
      if (actual.head?.generation === generation && actual.manifest
        && actual.head.revision === (parent?.revision ?? 0) + 1
        && actual.manifest.parent?.revision === parent?.revision
        && actual.manifest.parent?.generation === parent?.generation
        && matches(actual.manifest)) return actual.head
    } catch { /* Keep the outcome explicitly unconfirmed; never reset/recollect. */ }
    throw new PublicationClientError(signal?.aborted ? 'CANCELLED' : 'COMMIT_UNCONFIRMED')
  }
  return {
    head,
    async checkpoint(current: PublicationHead, manifest: PublicationManifest): Promise<Record<PrivateFile, Uint8Array>> {
      const files = {} as Record<PrivateFile, Uint8Array>
      for (const name of PRIVATE_FILES) {
        const response = await request(`/checkpoint/${name}?generation=${encodeURIComponent(current.generation)}`)
        if (response.headers.get('X-Orbit-Generation') !== current.generation) {
          await response.body?.cancel()
          throw new PublicationClientError('CHECKPOINT_GENERATION')
        }
        const bytes = await responseBytes(response, PRIVATE_FILE_LIMITS[name])
        const expected = manifest.fragments[manifest.checkpoint.files[name]]
        if (bytes.byteLength !== expected.decodedBytes || publicationHash(bytes) !== expected.decodedHash) {
          throw new PublicationClientError('CHECKPOINT_CHECKSUM')
        }
        files[name] = bytes
      }
      const after = await head()
      if (after.head?.generation !== current.generation || after.head.revision !== current.revision) {
        throw new PublicationClientError('CHECKPOINT_CHANGED')
      }
      return files
    },
    async publish(publication: BuiltPublication): Promise<PublicationHead> {
      const generation = publication.manifest.generation
      const revision = (publication.manifest.parent?.revision ?? 0) + 1
      const expected = publicationHash(JSON.stringify(publication.manifest))
      try {
        const started = await json('/begin', 'POST', publication.manifest)
        if (started && typeof started === 'object' && 'committed' in started && started.committed === true) {
          return committedHead(started, generation, revision)
        }
        if (!started || typeof started !== 'object' || !('generation' in started) || started.generation !== generation) {
          throw new PublicationClientError('INVALID_BEGIN')
        }
        for (const [index, bytes] of publication.chunks.entries()) {
          const response = await request(`/chunks/${generation}/${index}`, 'PUT', bytes)
          const result = parseJson(await responseBytes(response, 4096))
          const expected = publication.manifest.chunks[index]
          if (!result || typeof result !== 'object' || !('hash' in result) || result.hash !== expected.hash
            || !('bytes' in result) || result.bytes !== expected.bytes || !('index' in result) || result.index !== index
            || !('generation' in result) || result.generation !== generation) throw new PublicationClientError('INVALID_CHUNK_ACK')
        }
        return committedHead(await json('/commit', 'POST', { generation }), generation, revision)
      } catch (error) {
        return confirm(error, generation, publication.manifest.parent,
          actual => publicationHash(JSON.stringify(actual)) === expected)
      }
    },
    async rollback(current: PublicationHead, generation: string): Promise<PublicationHead> {
      const parent = { revision: current.revision, generation: current.generation }
      try {
        return committedHead(await json('/rollback', 'POST', { generation, parent }), generation, current.revision + 1)
      } catch (error) {
        return confirm(error, generation, parent, manifest => Boolean(manifest.rollbackOf))
      }
    },
    async metrics(): Promise<PublicationMetrics> {
      const parsed = MetricsSchema.safeParse(await json('/metrics'))
      if (!parsed.success) throw new PublicationClientError('INVALID_METRICS')
      return parsed.data
    },
  }
}
