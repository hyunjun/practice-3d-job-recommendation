import { createHash } from 'node:crypto'
import { gunzipSync, gzipSync } from 'node:zlib'
import { collectPublication } from '../../server/publication-collector'
import type { CollectorCheckpoint, PublicationCollection } from '../../server/publication-collector'
import type { BuiltPublication, buildPublication } from '../../server/publication-build'
import type { BoardResult, CatalogPublicationCapture } from '../../server/catalog-service'
import type { PresenceResult } from '../../server/posting-presence'
import { BoardFetchError } from '../../server/catalog-service'
import { PUBLICATION_LIMITS } from '../../shared/publication'
import type { PrivateFile, PublicationFragment, PublicationManifest } from '../../shared/publication'
import type { Company } from '../../shared/types'
import { contentResult, presenceResult, PROVENANCE_COMPANIES, provenanceJob } from './board-status-provenance'

/**
 * Stage82 publication fixtures. Every employer, posting, clock and failure text
 * is fictional. Expected values in the tests are written out literally; nothing
 * here calls the publisher's own hashing, projection or scheduling helpers to
 * derive an expectation. The only product call is the collector under test.
 */
export const PUBLICATION_DAY = '2026-10-03'
/** `stamp82('06:01:00.000')` → `2026-10-03T06:01:00.000Z`. */
export const stamp82 = (time: string) => `${PUBLICATION_DAY}T${time}Z`
export const RUN_ONE = stamp82('06:00:00.000')
/** A fictional 40-hex collector commit; it is not a repository reference. */
export const FICTIONAL_COMMIT = '0123456789abcdef0123456789abcdef01234567'
/** Lowercase UUID v4 shaped generations as the shared manifest schema requires. */
export const GENERATION_ONE = '11111111-1111-4111-8111-111111111111'
export const GENERATION_TWO = '22222222-2222-4222-9222-222222222222'
export const PUBLICATION_FAILURES = {
  list: 'Fictional publication list 503',
  body: 'Fictional publication body 503',
  jitter: 'Fictional jitter source fault',
} as const

/** One provider request boundary as the collector saw it, in call order across both passes. */
export interface ProviderEvent {
  kind: 'list' | 'body'
  companyId: string
  phase: 'start' | 'end'
  outcome?: 'ok' | 'error'
  at: string
}

/**
 * A runner-independent recording function: the fixture is shared by vitest unit
 * tests and the Playwright Worker contract suite, so it must not import vitest.
 */
export interface RecordingFunction<A extends unknown[], R> {
  (...args: A): R
  mock: { calls: A[] }
  mockImplementation(next: (...args: A) => R): void
}
export function recordingFunction<A extends unknown[], R>(initial: (...args: A) => R): RecordingFunction<A, R> {
  let current = initial
  const calls: A[] = []
  const recorder = ((...args: A): R => {
    calls.push(args)
    return current(...args)
  }) as RecordingFunction<A, R>
  recorder.mock = { calls }
  recorder.mockImplementation = next => { current = next }
  return recorder
}

export function publicationHarness(options: { companies?: Company[]; at?: string } = {}) {
  let time = Date.parse(options.at ?? RUN_ONE)
  const companies = options.companies ?? PROVENANCE_COMPANIES
  const ledger: ProviderEvent[] = []
  const fetchBoard = recordingFunction(async (company: Company, fetchedAt: string): Promise<BoardResult> => contentResult(company, fetchedAt))
  const fetchPresence = recordingFunction(async (company: Company, _fetchedAt: string): Promise<PresenceResult> => presenceResult(company))
  const now = () => time
  function recorded<R>(kind: ProviderEvent['kind'], target: (company: Company, fetchedAt: string) => Promise<R>) {
    return (company: Company, fetchedAt: string): Promise<R> => {
      ledger.push({ kind, companyId: company.id, phase: 'start', at: new Date(time).toISOString() })
      return target(company, fetchedAt).then(value => {
        ledger.push({ kind, companyId: company.id, phase: 'end', outcome: 'ok', at: new Date(time).toISOString() })
        return value
      }, (error: unknown) => {
        ledger.push({ kind, companyId: company.id, phase: 'end', outcome: 'error', at: new Date(time).toISOString() })
        throw error
      })
    }
  }
  return {
    companies, fetchBoard, fetchPresence, now,
    at: (value: string) => { time = Date.parse(value) },
    ledger: () => ledger.map(event => ({ ...event })),
    listCalls: () => fetchPresence.mock.calls.map(([company]) => company.id),
    bodyCalls: () => fetchBoard.mock.calls.map(([company]) => company.id),
    /** One scheduled run of the dedicated Node collector over the injected clock. */
    run(checkpoint?: CollectorCheckpoint, overrides: { companies?: Company[]; measureHttp?: boolean; random?: () => number } = {}): Promise<PublicationCollection> {
      return collectPublication({
        companies: overrides.companies ?? companies, checkpoint, now, random: overrides.random ?? (() => 0),
        fetchBoard: recorded('body', (company, fetchedAt) => fetchBoard(company, fetchedAt)),
        fetchPresence: recorded('list', (company, fetchedAt) => fetchPresence(company, fetchedAt)),
        ...(overrides.measureHttp === undefined ? {} : { measureHttp: overrides.measureHttp }),
      })
    },
    failList(companyId: string, message: string, retryAfter?: string) {
      fetchPresence.mockImplementation(async company => {
        if (company.id !== companyId) return presenceResult(company)
        throw retryAfter ? new BoardFetchError(message, Date.parse(retryAfter)) : new BoardFetchError(message)
      })
    },
    failEveryList(message: string) {
      fetchPresence.mockImplementation(async () => { throw new BoardFetchError(message) })
    },
    failBody(companyId: string, message: string, retryAfter?: string) {
      fetchBoard.mockImplementation(async (company, fetchedAt) => {
        if (company.id !== companyId) return contentResult(company, fetchedAt)
        throw retryAfter ? new BoardFetchError(message, Date.parse(retryAfter)) : new BoardFetchError(message)
      })
    },
    /** Replace one company's complete result with the given native IDs (an empty list is a valid board). */
    emptyBody(companyId: string) {
      fetchBoard.mockImplementation(async (company, fetchedAt) => contentResult(company, fetchedAt, company.id === companyId ? [] : ['7401']))
      fetchPresence.mockImplementation(async company => presenceResult(company, company.id === companyId ? [] : ['7401']))
    },
    /** Large, incompressible-looking bodies so packed fragments cross the 1 MiB chunk boundary. */
    bulkBody(companyId: string, count: number, descriptionLength: number) {
      fetchBoard.mockImplementation(async (company, fetchedAt) => {
        if (company.id !== companyId) return contentResult(company, fetchedAt)
        const jobs = Array.from({ length: count }, (_, index) => ({
          ...provenanceJob(company, `${7500 + index}`, fetchedAt),
          description: deterministicText(index + 1, descriptionLength),
        }))
        return { jobs, total: jobs.length, unmappedCount: 0, publishedIds: jobs.map(job => job.id) }
      })
      fetchPresence.mockImplementation(async company => presenceResult(company,
        company.id === companyId ? Array.from({ length: count }, (_, index) => `${7500 + index}`) : ['7401']))
    },
  }
}
export type PublicationHarness = ReturnType<typeof publicationHarness>

/** The private state a later scheduled run restores; the capture names these arrays differently. */
export function checkpointFrom(capture: CatalogPublicationCapture): CollectorCheckpoint {
  return structuredClone({ boards: capture.boards, presence: capture.presences, observations: capture.observationCheckpoint })
}

/** Independent digest; expectations never call the publisher's own hash helper. */
export const sha256 = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex')

export function packedBytes(built: BuiltPublication): Buffer {
  return Buffer.concat(built.chunks.map(chunk => Buffer.from(chunk)))
}

export function compressedFragment(built: BuiltPublication, name: string): Buffer {
  const fragment = built.manifest.fragments[name]
  if (!fragment) throw new Error(`Unknown fragment ${name}`)
  return packedBytes(built).subarray(fragment.offset, fragment.offset + fragment.compressedBytes)
}

export function decodedFragment(built: BuiltPublication, name: string): Buffer {
  return gunzipSync(compressedFragment(built, name))
}

export function decodedJson(built: BuiltPublication, name: string): unknown {
  const fragment = built.manifest.fragments[name]
  const text = decodedFragment(built, name).toString('utf8')
  return JSON.parse(fragment.kind === 'items' ? `[${text}]` : text)
}

/** Assemble a request-time projection exactly as the Worker would stream it: literal text plus inflated fragments. */
export function materialize(built: BuiltPublication, projection: { parts: ({ text: string } | { fragment: string })[] }): string {
  return projection.parts.map(part => 'text' in part ? part.text : decodedFragment(built, part.fragment).toString('utf8')).join('')
}

/** Lowercase UUID v4 shaped identifiers beyond the two fixtures, for multi-generation scenarios. */
export const GENERATION_THREE = '33333333-3333-4333-a333-333333333333'
export const GENERATION_FOUR = '44444444-4444-4444-b444-444444444444'
/**
 * A letter-bearing lowercase UUID v4 whose uppercase form differs (AWT82-2/MWT82-2):
 * the numeric fixtures above are unchanged by toUpperCase(), so case-folding
 * paths must use this one.
 */
export const GENERATION_LETTERS = 'abcdef12-abcd-4abc-8abc-abcdefabcdef'
/**
 * The builder's generation parameter type: Node's randomUUID() template-literal
 * UUID (ANT82-1/MWT82-1). Helpers that forward a generation must use it instead of
 * a widened string default; deliberately malformed negatives cast locally.
 */
export type PublicationGeneration = NonNullable<Parameters<typeof buildPublication>[3]>

export function privateFiles(built: BuiltPublication): Record<PrivateFile, Uint8Array> {
  const files = built.manifest.checkpoint.files
  return {
    boards: new Uint8Array(decodedFragment(built, files.boards)),
    presence: new Uint8Array(decodedFragment(built, files.presence)),
    observations: new Uint8Array(decodedFragment(built, files.observations)),
  }
}

/** Deterministic xorshift text over a 64-symbol alphabet: compressible only to about three quarters. */
export function deterministicText(seed: number, length: number): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  let state = (seed >>> 0) || 1
  const characters: string[] = []
  for (let index = 0; index < length; index++) {
    state ^= state << 13; state >>>= 0
    state ^= state >>> 17
    state ^= state << 5; state >>>= 0
    characters.push(alphabet[state & 63])
  }
  return characters.join('')
}

// ---------------------------------------------------------------------------
// Stream-remedy fixtures (NATIVE82-STREAM-REMEDY-01, SR01-11). Packed streams are
// rebuilt here from decoded fixture content, manifest declarations are altered
// here, and synthetic bytes are written out literally. Nothing below calls the
// publisher's builder, hashing, projection or streaming helpers.
// ---------------------------------------------------------------------------

/** SHA-256 of zero bytes, written out: the decoded digest every valid empty fragment declares. */
export const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'

/**
 * Rebuild the packed chunk stream with some fragments' decoded contents replaced.
 * An empty replacement is a valid zero-byte fragment (gzip of nothing is 20 bytes,
 * the schema minimum). Every offset, size, digest and chunk entry is recomputed by
 * this fixture; all other manifest declarations are kept as built.
 */
export function repackPublication(built: BuiltPublication, replacements: Record<string, Uint8Array>): BuiltPublication {
  const generation = built.manifest.generation
  if (built.manifest.chunks.some(chunk => chunk.owner !== generation)) throw new Error('Only a freshly built single-owner publication can be repacked')
  for (const name of Object.keys(replacements)) if (!built.manifest.fragments[name]) throw new Error(`Unknown fragment ${name}`)
  const ordered = Object.entries(built.manifest.fragments).sort((left, right) => left[1].offset - right[1].offset)
  const fragments: Record<string, PublicationFragment> = {}
  const buffers: Buffer[] = []
  let offset = 0
  for (const [name, fragment] of ordered) {
    const decoded = name in replacements ? Buffer.from(replacements[name]) : decodedFragment(built, name)
    const compressed = gzipSync(decoded)
    fragments[name] = {
      ...fragment, offset, compressedBytes: compressed.length, decodedBytes: decoded.length,
      compressedHash: sha256(compressed), decodedHash: sha256(decoded),
    }
    buffers.push(compressed)
    offset += compressed.length
  }
  const packed = Buffer.concat(buffers, offset)
  const chunkBytes = PUBLICATION_LIMITS.chunk
  const chunks = Array.from({ length: Math.ceil(packed.length / chunkBytes) }, (_, index) =>
    new Uint8Array(packed.subarray(index * chunkBytes, Math.min(packed.length, (index + 1) * chunkBytes))))
  const manifest: PublicationManifest = {
    ...built.manifest, fragments,
    chunks: chunks.map((bytes, index) => ({ owner: generation, index, bytes: bytes.length, hash: sha256(bytes) })),
  }
  return { manifest, manifestText: JSON.stringify(manifest), chunks }
}

/**
 * The same bytes with one fragment's manifest declaration altered: an integrity
 * fault that chunk uploads cannot detect and that the Worker can only reach after
 * the fragment's output has been produced.
 */
export function declareFragment(
  built: BuiltPublication, name: string,
  declaration: Partial<Pick<PublicationFragment, 'compressedHash' | 'decodedHash' | 'decodedBytes'>>,
): BuiltPublication {
  const fragment = built.manifest.fragments[name]
  if (!fragment) throw new Error(`Unknown fragment ${name}`)
  const manifest: PublicationManifest = {
    ...built.manifest, fragments: { ...built.manifest.fragments, [name]: { ...fragment, ...declaration } },
  }
  return { manifest, manifestText: JSON.stringify(manifest), chunks: built.chunks }
}

/** A seven-byte UTF-8 unit written as bytes: 가 (EA B0 80) followed by 🌱 (F0 9F 8C B1). */
export const MULTIBYTE_UNIT = [0xea, 0xb0, 0x80, 0xf0, 0x9f, 0x8c, 0xb1] as const
export const MULTIBYTE_UNIT_COUNT = 28_500
/**
 * 199 500 bytes of that unit. Every 64 KiB block boundary falls inside a character:
 * 65 536 ≡ 2, 131 072 ≡ 4 and 196 608 ≡ 6 (mod 7), so three boundaries split a
 * three-byte or four-byte sequence and 2 892 bytes trail the last full block.
 */
export const MULTIBYTE_FRAGMENT_BYTES = MULTIBYTE_UNIT.length * MULTIBYTE_UNIT_COUNT
export function multibyteFragment(): Buffer {
  const unit = Buffer.from([...MULTIBYTE_UNIT])
  return Buffer.concat(Array.from({ length: MULTIBYTE_UNIT_COUNT }, () => unit))
}

/** Deterministic Hangul syllables (three UTF-8 bytes each, U+AC00..U+D7A3); never U+FFFD, never a lone surrogate. */
function hangul(seed: number, length: number): string {
  let state = ((seed * 2654435761) >>> 0) || 1
  const characters: string[] = []
  for (let index = 0; index < length; index++) {
    state ^= state << 13; state >>>= 0
    state ^= state >>> 17
    state ^= state << 5; state >>>= 0
    characters.push(String.fromCharCode(0xac00 + state % 11172))
  }
  return characters.join('')
}
export const MULTIBYTE_COMPANY_COUNT = 80
/**
 * Eighty fictional employers whose names (130 syllables plus one astral emoji, a
 * UTF-16 surrogate pair) and industries (150 syllables) are multibyte text, so the
 * public metadata text that lists them exceeds one 64 KiB encoder block and its
 * block boundaries fall inside multibyte characters. Tests assert that the JSON of
 * this list alone exceeds 64 KiB and compare the served list to it literally.
 */
export function multibyteCompanies(): (Company & { board: string })[] {
  return Array.from({ length: MULTIBYTE_COMPANY_COUNT }, (_, index) => ({
    id: `multibyte-${index}`, name: `${hangul(index + 1, 130)} 🌱`, initials: '가상', color: '#2a7fff',
    industry: hangul(index + 1001, 150), provider: 'greenhouse' as const, board: `MultibyteProvenance${index}`,
    careerUrl: `https://example.com/careers/multibyte-${index}`,
  }))
}
