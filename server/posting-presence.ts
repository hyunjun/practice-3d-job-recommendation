import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { JobProviderSchema } from '../shared/schemas'
import type { Company } from '../shared/types'

const Timestamp = z.iso.datetime({ offset: true })
const Ids = z.array(z.string().min(1).max(500)).max(20000)
export const PresenceResultSchema = z.object({
  total: z.number().int().nonnegative().max(20000),
  publishedIds: Ids,
}).refine(result => result.total === result.publishedIds.length
  && new Set(result.publishedIds).size === result.total, 'Incomplete published inventory')

export type PresenceResult = z.infer<typeof PresenceResultSchema>
export interface PresenceSnapshot extends PresenceResult {
  fetchedAt: string
  /** Listed again, but an earlier detail explicitly said inactive/private. */
  unconfirmedIds?: string[]
}
const CachedPresenceSchema = z.object({
  companyId: z.string().min(1).max(100),
  board: z.string().min(1).max(200),
  provider: JobProviderSchema,
  boardRegion: z.literal('eu').optional(),
  checkedAt: Timestamp,
  failures: z.number().int().min(0).max(1000),
  retryAt: Timestamp.nullable(),
  error: z.string().min(1).max(500).optional(),
  // Retain authoritative detail evidence until a successful content refresh.
  unpublishedIds: Ids.optional(),
  snapshot: PresenceResultSchema.safeExtend({
    fetchedAt: Timestamp,
    unconfirmedIds: Ids.optional(),
  }).optional(),
}).refine(entry => {
  const prefix = `${entry.provider}-${entry.companyId}-`
  const snapshot = entry.snapshot
  const ids = new Set(snapshot?.publishedIds)
  const unpublished = new Set(entry.unpublishedIds)
  return (!entry.boardRegion || entry.provider === 'lever')
    && (!snapshot || Date.parse(snapshot.fetchedAt) <= Date.parse(entry.checkedAt))
    && [...ids, ...unpublished].every(id => id.startsWith(prefix))
    && unpublished.size === (entry.unpublishedIds?.length ?? 0)
    && new Set(snapshot?.unconfirmedIds).size === (snapshot?.unconfirmedIds?.length ?? 0)
    && (snapshot?.unconfirmedIds?.every(id => ids.has(id) && unpublished.has(id)) ?? true)
}, 'Invalid presence scope or observation')

export type CachedPresence = z.infer<typeof CachedPresenceSchema>
export interface PresenceCache {
  load: () => Promise<CachedPresence[]>
  save: (boards: CachedPresence[]) => Promise<void>
}

export function presenceBelongsToBoard(result: PresenceResult, company: Pick<Company, 'id' | 'provider'>): boolean {
  const prefix = `${company.provider ?? 'greenhouse'}-${company.id}-`
  return result.publishedIds.every(id => id.startsWith(prefix))
}

export function parseCachedPresence(input: unknown): CachedPresence[] {
  const envelope = z.object({ version: z.literal(1), boards: z.array(z.unknown()).max(1000) }).safeParse(input)
  if (!envelope.success) return []
  return envelope.data.boards.flatMap(value => {
    const parsed = CachedPresenceSchema.safeParse(value)
    return parsed.success ? [parsed.data] : []
  })
}

/** Derived from the already board-scoped full-cache path. */
export function presenceCacheFile(catalogCacheFile: string): string {
  return `${catalogCacheFile.replace(/\.json$/i, '')}.presence-v1.json`
}

export function createFilePresenceCache(file: string): PresenceCache {
  return {
    async load() {
      try {
        if ((await stat(file)).size > 64 * 1024 * 1024) return []
        return parseCachedPresence(JSON.parse(await readFile(file, 'utf8')))
      } catch { return [] }
    },
    async save(boards) {
      await mkdir(path.dirname(file), { recursive: true })
      const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`
      try {
        await writeFile(temporary, JSON.stringify({ version: 1, boards }), 'utf8')
        await rename(temporary, file)
      } finally {
        await rm(temporary, { force: true })
      }
    },
  }
}
