import { z } from 'zod'
import { MAP_REGIONS, PUBLIC_PROVIDERS } from './types'

export const PUBLICATION_LIMITS = {
  chunk: 1024 * 1024,
  compressed: 64 * 1024 * 1024,
  manifest: 512 * 1024,
  storage: 512 * 1024 * 1024,
  catalog: 128 * 1024 * 1024,
  posting: 64 * 1024 * 1024,
  observations: 16 * 1024 * 1024,
  streams: 8,
  stagingIdle: 15 * 60 * 1000,
  stagingLifetime: 2 * 60 * 60 * 1000,
  retiredLifetime: 5 * 60 * 1000,
} as const
export const GENERATION_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i
export const PRIVATE_FILES = ['boards', 'presence', 'observations'] as const
export type PrivateFile = typeof PRIVATE_FILES[number]
export const PRIVATE_FILE_LIMITS = {
  boards: PUBLICATION_LIMITS.catalog,
  presence: PUBLICATION_LIMITS.posting,
  observations: PUBLICATION_LIMITS.observations,
} as const

const uuid = z.string().regex(GENERATION_PATTERN).refine(value => value === value.toLowerCase())
const hash = z.string().regex(/^[a-f0-9]{64}$/)
const timestamp = z.iso.datetime({ offset: true })
const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
const identifier = z.string().min(1).max(100)
const provider = z.enum(PUBLIC_PROVIDERS)
const company = z.object({
  id: identifier, name: z.string().min(1).max(200), color: z.string().max(100),
  initials: z.string().max(100), industry: z.string().max(200), careerUrl: z.string().max(2000),
  board: z.string().min(1).max(200), provider: provider.optional(), boardRegion: z.literal('eu').optional(),
}).strict().refine(item => !item.boardRegion || item.provider === 'lever')
const city = z.object({
  id: identifier, name: z.string().max(200), en: z.string().max(200), country: z.string().max(200),
  countryCode: z.string().max(10), region: z.enum(MAP_REGIONS),
  lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180),
  timezone: z.string().max(100), description: z.string().max(2000), image: z.string().max(2000).optional(),
}).strict()
const context = z.object({
  capturedAt: timestamp, configId: hash, companies: z.array(company).min(1).max(1000),
  collectorCommit: z.string().regex(/^[a-f0-9]{40}$/),
}).strict().refine(value => new Set(value.companies.map(item => item.id)).size === value.companies.length)
export type PublicationContext = z.infer<typeof context>

const parent = z.object({ revision: count.min(1), generation: uuid }).strict()
export const PublicationHeadSchema = parent.extend({ publishedAt: timestamp }).strict()
export type PublicationHead = z.infer<typeof PublicationHeadSchema>
export const PublicationParentSchema = parent.nullable()

const fragmentName = z.string().regex(/^[a-z0-9-]{1,100}$/)
const fragment = z.object({
  owner: uuid, offset: count, compressedBytes: count.min(20).max(PUBLICATION_LIMITS.compressed),
  decodedBytes: count.max(PUBLICATION_LIMITS.catalog), compressedHash: hash, decodedHash: hash,
  kind: z.enum(['value', 'items']), visibility: z.enum(['public', 'checkpoint']),
}).strict()
export type PublicationFragment = z.infer<typeof fragment>
const chunk = z.object({
  owner: uuid, index: count.max(63), bytes: count.min(1).max(PUBLICATION_LIMITS.chunk), hash,
}).strict()
export type PublicationChunk = z.infer<typeof chunk>
const catalogBoard = z.object({
  base: z.object({
    companyId: identifier, board: z.string().min(1).max(200), provider,
    status: z.enum(['ok', 'error']), checkedAt: timestamp.optional(),
    lastSuccessAt: timestamp.nullable(), retryAt: timestamp.nullable(),
    message: z.string().min(1).max(500).optional(),
  }).strict(),
  eligible: z.boolean(), initiallyStale: z.boolean(), fetchedAt: timestamp.nullable(),
  freshUntil: timestamp.nullable(), total: count, included: count, unmappedCount: count.nullable(),
  fresh: fragmentName.nullable(), stale: fragmentName.nullable(), contentDeadline: timestamp.nullable(),
}).strict()
const postingBoard = z.object({
  base: z.object({
    companyId: identifier, board: z.string().min(1).max(200), provider, boardRegion: z.literal('eu').optional(),
    status: z.enum(['ok', 'error']), checkedAt: timestamp, lastSuccessAt: timestamp.nullable(),
    retryAt: timestamp.nullable(), message: z.string().min(1).max(500).optional(),
  }).strict(),
  checkedAt: timestamp.nullable(), listingAt: timestamp.nullable(),
  bodyFreshUntil: timestamp.nullable(), listing: fragmentName.nullable(), oldBody: fragmentName.nullable(),
  inventoryDeadline: timestamp.nullable(), contentDeadline: timestamp.nullable(),
}).strict()
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(value => Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value)
const scope = z.object({
  key: hash,
  boards: z.array(z.object({
    companyId: identifier, name: z.string().min(1).max(200), provider,
    board: z.string().min(1).max(200), boardRegion: z.literal('eu').optional(),
  }).strict()).min(1).max(1000),
}).strict()
const manifestSchema = z.object({
  version: z.literal(1), generation: uuid, parent: PublicationParentSchema,
  capture: context,
  chunks: z.array(chunk).min(1).max(128),
  fragments: z.record(fragmentName, fragment),
  catalog: z.object({
    cities: z.array(city).max(1000), checkedAt: timestamp.optional(),
    boards: z.array(catalogBoard).min(1).max(1000),
  }).strict(),
  posting: z.object({ boards: z.array(postingBoard).min(1).max(1000) }).strict(),
  observations: z.object({
    scope, method: z.string().min(1).max(200),
    days: z.array(z.object({ day, fragment: fragmentName }).strict()).max(90),
    otherSeries: z.array(z.object({
      scopeKey: hash, method: z.string().min(1).max(200), companyCount: count.min(1).max(1000),
      days: z.array(day).min(1).max(90),
    }).strict()).max(4),
  }).strict(),
  checkpoint: z.object({
    capture: context,
    files: z.object({ boards: fragmentName, presence: fragmentName, observations: fragmentName }).strict(),
  }).strict(),
  rollbackOf: uuid.optional(),
}).strict()
export type PublicationManifest = z.infer<typeof manifestSchema>

export const publicationChunkKey = (owner: string, index: number) => `${owner}:${index}`
export function fragmentChunkIndexes(value: PublicationFragment): number[] {
  const first = Math.floor(value.offset / PUBLICATION_LIMITS.chunk)
  const last = Math.floor((value.offset + value.compressedBytes - 1) / PUBLICATION_LIMITS.chunk)
  return Array.from({ length: last - first + 1 }, (_, index) => first + index)
}

/** Small metadata only. Large JSON values are validated by the Node publisher. */
export function parsePublicationManifest(input: unknown): PublicationManifest {
  const value = manifestSchema.parse(input)
  const fail = () => { throw new Error('Invalid publication manifest relationships') }
  const companies = value.capture.companies
  if (Object.keys(value.fragments).length > 4200
    || value.chunks.reduce((sum, item) => sum + item.bytes, 0) > PUBLICATION_LIMITS.compressed
    || new Set(value.chunks.map(item => publicationChunkKey(item.owner, item.index))).size !== value.chunks.length
    || new Set(value.chunks.map(item => item.owner)).size > 2
    || value.catalog.boards.length !== companies.length || value.posting.boards.length !== companies.length
    || new Set(value.catalog.cities.map(item => item.id)).size !== value.catalog.cities.length) fail()
  const chunks = new Map(value.chunks.map(item => [publicationChunkKey(item.owner, item.index), item]))
  const referenced = new Set<string>()
  const usedChunks = new Set<string>()
  const reference = (name: string | null, visibility: PublicationFragment['visibility'], kind: PublicationFragment['kind']) => {
    if (name === null) return
    const item = value.fragments[name]
    if (!item || item.visibility !== visibility || item.kind !== kind) fail()
    referenced.add(name)
  }
  for (const [index, owner] of companies.entries()) {
    const catalog = value.catalog.boards[index]
    const posting = value.posting.boards[index]
    for (const board of [catalog.base, posting.base]) {
      if (board.companyId !== owner.id || board.board !== owner.board
        || board.provider !== (owner.provider ?? 'greenhouse')) fail()
    }
    if (posting.base.boardRegion !== owner.boardRegion || catalog.included > catalog.total
      || catalog.eligible !== Boolean(catalog.fetchedAt && catalog.freshUntil && catalog.fresh && catalog.stale)
      || !catalog.eligible && (catalog.fresh !== null || catalog.stale !== null)
      || Boolean(posting.listing) !== Boolean(posting.oldBody)
      || posting.listing && !posting.listingAt) fail()
    reference(catalog.fresh, 'public', 'items')
    reference(catalog.stale, 'public', 'items')
    reference(posting.listing, 'public', 'value')
    reference(posting.oldBody, 'public', 'value')
  }
  for (const item of value.observations.days) reference(item.fragment, 'public', 'value')
  const orderedDays = (days: string[]) => days.every((item, index) => index === 0 || item > days[index - 1])
  if (!orderedDays(value.observations.days.map(item => item.day))
    || value.observations.otherSeries.some(item => !orderedDays(item.days))) fail()
  for (const name of PRIVATE_FILES) {
    const key = value.checkpoint.files[name]
    reference(key, 'checkpoint', 'value')
    if (value.fragments[key].decodedBytes > PRIVATE_FILE_LIMITS[name]) fail()
  }
  if (referenced.size !== Object.keys(value.fragments).length) fail()
  for (const item of Object.values(value.fragments)) {
    if (!Number.isSafeInteger(item.offset + item.compressedBytes)
      || item.offset + item.compressedBytes > PUBLICATION_LIMITS.compressed) fail()
    for (const index of fragmentChunkIndexes(item)) {
      const key = publicationChunkKey(item.owner, index)
      const stored = chunks.get(key)
      if (!stored || Math.min(item.offset + item.compressedBytes, (index + 1) * PUBLICATION_LIMITS.chunk)
        > index * PUBLICATION_LIMITS.chunk + stored.bytes) fail()
      usedChunks.add(key)
    }
  }
  if (usedChunks.size !== chunks.size) fail()
  return value
}
