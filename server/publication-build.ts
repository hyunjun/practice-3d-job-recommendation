import { randomUUID } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { sourceFreshFor } from '../shared/catalog-freshness'
import { ObservationHistorySchema } from '../shared/catalog-observations'
import { PostingStatusIndexSchema } from '../shared/posting-status'
import {
  parsePublicationManifest, PRIVATE_FILES, PRIVATE_FILE_LIMITS, PUBLICATION_LIMITS,
} from '../shared/publication'
import type { PublicationFragment, PublicationHead, PublicationManifest } from '../shared/publication'
import { isPublicCatalog } from '../src/lib/catalog-validation'
import type { CatalogPublicationCapture } from './catalog-service'
import {
  publicationConfigurationId, publicationHash, restorePublicationCheckpoint,
} from './publication-collector'

export interface BuiltPublication {
  manifest: PublicationManifest
  manifestText: string
  chunks: Uint8Array[]
}

export function buildPublication(
  capture: CatalogPublicationCapture,
  collectorCommit: string,
  parent: PublicationHead | null,
  generation = randomUUID(),
): BuiltPublication {
  if (!isPublicCatalog(capture.catalog, true) || capture.catalog.boards.some(board => board.status === 'pending')) {
    throw new Error('A settled, valid public catalog is required')
  }
  PostingStatusIndexSchema.parse(capture.postingStatus)
  ObservationHistorySchema.parse(capture.history)
  if (capture.postingStatus.version !== 2 || capture.history.storage !== 'ok') {
    throw new Error('Complete posting metadata and restorable observations are required')
  }
  const context = {
    capturedAt: capture.capturedAt, collectorCommit,
    companies: capture.catalog.companies.map(company => ({ ...company, board: company.board! })),
    configId: publicationConfigurationId(capture.catalog.companies),
  }
  const files = {
    boards: Buffer.from(JSON.stringify({ version: 5, boards: capture.boards })),
    presence: Buffer.from(JSON.stringify({ version: 1, boards: capture.presences })),
    observations: Buffer.from(JSON.stringify(capture.observationCheckpoint)),
  }
  // Strict validation before any network write, including original scope IDs.
  restorePublicationCheckpoint(context, files, Date.parse(capture.capturedAt))
  const buffers: Buffer[] = []
  const fragments: Record<string, PublicationFragment> = {}
  let offset = 0
  const add = (name: string, text: string | Buffer, kind: PublicationFragment['kind'], visibility: PublicationFragment['visibility']) => {
    const decoded = typeof text === 'string' ? Buffer.from(text) : text
    const compressed = gzipSync(decoded)
    fragments[name] = {
      owner: generation, offset, compressedBytes: compressed.length, decodedBytes: decoded.length,
      compressedHash: publicationHash(compressed), decodedHash: publicationHash(decoded), kind, visibility,
    }
    buffers.push(compressed)
    offset += compressed.length
    if (offset > PUBLICATION_LIMITS.compressed) throw new Error('Compressed publication exceeds the size limit')
    return name
  }
  const clocks = new Map(capture.clocks.map(item => [item.companyId, item]))
  const snapshots = new Map(capture.boards.map(item => [item.companyId, item.snapshot]))
  const catalog: PublicationManifest['catalog'] = {
    cities: capture.catalog.cities,
    ...(capture.catalog.checkedAt ? { checkedAt: capture.catalog.checkedAt } : {}),
    boards: capture.catalog.boards.map((board, index) => {
      const company = context.companies[index]
      const snapshot = snapshots.get(board.companyId)
      const eligible = board.dataStatus === 'fresh' || board.dataStatus === 'stale'
      const jobs = capture.catalog.jobs.filter(job => job.companyId === board.companyId)
      const { dataStatus: _dataStatus, total, included, ...base } = board
      return {
        base: {
          ...base, provider: company.provider ?? 'greenhouse', status: board.status === 'error' ? 'error' : 'ok',
          lastSuccessAt: board.lastSuccessAt ?? null, retryAt: board.retryAt ?? null,
        },
        eligible, initiallyStale: board.dataStatus === 'stale',
        fetchedAt: snapshot?.fetchedAt ?? null,
        freshUntil: snapshot ? new Date(Date.parse(snapshot.fetchedAt) + sourceFreshFor(company.provider)).toISOString() : null,
        total, included, unmappedCount: snapshot?.unmappedCount ?? (snapshot ? null : 0),
        fresh: eligible ? add(`c-${index}-fresh`, JSON.stringify(jobs.map(job => ({ ...job, stale: false }))).slice(1, -1), 'items', 'public') : null,
        stale: eligible ? add(`c-${index}-stale`, JSON.stringify(jobs.map(job => ({ ...job, stale: true }))).slice(1, -1), 'items', 'public') : null,
        contentDeadline: clocks.get(board.companyId)?.contentDeadline ?? null,
      }
    }),
  }
  const posting: PublicationManifest['posting'] = {
    boards: capture.postingStatus.boards.map((board, index) => {
      const { listing, ...base } = board
      const clock = clocks.get(board.companyId)
      if (!clock) throw new Error('Missing original posting clocks')
      return {
        base, checkedAt: clock.postingCheckedAt,
        listingAt: board.lastSuccessAt,
        bodyFreshUntil: listing?.content?.status === 'ok' ? listing.content.validUntil : null,
        listing: listing ? add(`p-${index}-full`, JSON.stringify(listing), 'value', 'public') : null,
        oldBody: listing ? add(`p-${index}-old`, JSON.stringify({ ...listing, jobs: [] }), 'value', 'public') : null,
        inventoryDeadline: clock.inventoryDeadline, contentDeadline: clock.contentDeadline,
      }
    }),
  }
  const observations: PublicationManifest['observations'] = {
    scope: capture.history.scope, method: capture.history.method,
    days: capture.history.days.map((day, index) => ({
      day: day.day, fragment: add(`h-${index}`, JSON.stringify(day), 'value', 'public'),
    })),
    otherSeries: capture.history.otherSeries.map(series => {
      const original = capture.observationCheckpoint.series.find(item =>
        item.scope.key === series.scopeKey && item.method === series.method)
      if (!original) throw new Error('Missing full observation scope')
      return {
        scopeKey: series.scopeKey, method: series.method, companyCount: series.companyCount,
        days: original.days.map(day => day.day).filter(day => day >= series.firstDay && day <= series.lastDay).sort(),
      }
    }),
  }
  for (const name of PRIVATE_FILES) {
    if (files[name].length > PRIVATE_FILE_LIMITS[name]) throw new Error(`Checkpoint ${name} exceeds the size limit`)
    add(`private-${name}`, files[name], 'value', 'checkpoint')
  }
  const packed = Buffer.concat(buffers, offset)
  const chunks = Array.from({ length: Math.ceil(packed.length / PUBLICATION_LIMITS.chunk) }, (_, index) =>
    packed.subarray(index * PUBLICATION_LIMITS.chunk, Math.min(packed.length, (index + 1) * PUBLICATION_LIMITS.chunk)))
  const manifest = parsePublicationManifest({
    version: 1, generation, parent: parent ? { revision: parent.revision, generation: parent.generation } : null,
    capture: context, catalog, posting, observations, fragments,
    chunks: chunks.map((bytes, index) => ({ owner: generation, index, bytes: bytes.length, hash: publicationHash(bytes) })),
    checkpoint: {
      capture: context, files: { boards: 'private-boards', presence: 'private-presence', observations: 'private-observations' },
    },
  })
  const manifestText = JSON.stringify(manifest)
  const metadataBytes = Buffer.byteLength(manifestText)
  if (metadataBytes > PUBLICATION_LIMITS.manifest) throw new Error('Publication manifest exceeds the size limit')
  const bytes = (name: string | null) => name ? manifest.fragments[name].decodedBytes : 0
  // A conservative bound includes every possible metadata representation and
  // framing; request-time selection can only remove values or choose a variant.
  const overhead = 2 * metadataBytes + 4096
  if (overhead + catalog.boards.reduce((sum, board) => sum + Math.max(bytes(board.fresh), bytes(board.stale)), 0) > PUBLICATION_LIMITS.catalog
    || overhead + posting.boards.reduce((sum, board) => sum + Math.max(bytes(board.listing), bytes(board.oldBody)), 0) > PUBLICATION_LIMITS.posting
    || overhead + observations.days.reduce((sum, day) => sum + bytes(day.fragment), 0) > PUBLICATION_LIMITS.observations) {
    throw new Error('Decoded publication exceeds a public response size limit')
  }
  return { manifest, manifestText, chunks }
}
