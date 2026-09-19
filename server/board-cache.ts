import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { JobProviderSchema, JobSchema } from '../shared/schemas'
import { upgradeJobCompensation } from '../shared/job-compensation'
import { upgradeJobQualifications } from '../shared/job-qualifications'
import type { Company } from '../shared/types'

const Timestamp = z.iso.datetime({ offset: true })
export const BoardSnapshotSchema = z.object({
  fetchedAt: Timestamp,
  jobs: z.array(JobSchema.extend({ source: JobProviderSchema, fetchedAt: Timestamp }).transform(job => upgradeJobQualifications(upgradeJobCompensation(job)))).max(20000),
  total: z.number().int().nonnegative(),
  unmappedCount: z.number().int().nonnegative().nullable(),
  publishedIds: z.array(z.string().min(1).max(500)).max(20000).optional(),
}).refine(snapshot => snapshot.total >= snapshot.jobs.length + (snapshot.unmappedCount ?? 0))
  .refine(snapshot => {
    if (!snapshot.publishedIds) return true
    const ids = new Set(snapshot.publishedIds)
    return snapshot.publishedIds.length === snapshot.total && ids.size === snapshot.publishedIds.length
      && snapshot.jobs.every(job => ids.has(job.id))
  })

const CachedBoardSchema = z.object({
  companyId: z.string().min(1).max(100),
  board: z.string().min(1).max(200),
  provider: JobProviderSchema.default('greenhouse'),
  boardRegion: z.literal('eu').optional(),
  checkedAt: Timestamp,
  failures: z.number().int().min(0).max(1000),
  retryAt: Timestamp.nullable(),
  error: z.string().min(1).max(500).optional(),
  snapshot: BoardSnapshotSchema.optional(),
})

export type BoardSnapshot = z.infer<typeof BoardSnapshotSchema>
export type CachedBoard = z.infer<typeof CachedBoardSchema>
export interface BoardCache {
  load: () => Promise<CachedBoard[]>
  save: (boards: CachedBoard[]) => Promise<void>
}

const MAX_FILE_BYTES = 64 * 1024 * 1024

async function readJson(file: string): Promise<unknown> {
  if ((await stat(file)).size > MAX_FILE_BYTES) throw new Error('Board cache exceeds the size limit')
  return JSON.parse(await readFile(file, 'utf8'))
}

export function parseCachedBoards(input: unknown): CachedBoard[] {
  if (!input || typeof input !== 'object' || !('version' in input) || ![4, 5].includes(input.version as number)
    || !('boards' in input) || !Array.isArray(input.boards) || input.boards.length > 1000) return []
  return input.boards.flatMap(value => {
    const parsed = CachedBoardSchema.safeParse(value)
    return parsed.success && (input.version !== 4 || parsed.data.provider === 'greenhouse') ? [parsed.data] : []
  })
}

function migrateLegacy(input: unknown, companies: Company[]): CachedBoard[] {
  const legacy = z.object({
    source: z.literal('greenhouse'), fetchedAt: Timestamp,
    jobs: z.array(JobSchema.extend({ source: z.literal('greenhouse'), fetchedAt: Timestamp }).transform(job => upgradeJobQualifications(upgradeJobCompensation(job)))).max(20000),
    boards: z.array(z.object({
      companyId: z.string(), board: z.string(), status: z.enum(['ok', 'error']),
      total: z.number().int().nonnegative(), message: z.string().optional(),
    })).max(1000),
  }).safeParse(input)
  if (!legacy.success) return []
  return companies.flatMap(company => {
    if (company.provider && company.provider !== 'greenhouse') return []
    const board = legacy.data.boards.find(item => item.companyId === company.id && item.board === company.board)
    if (!board) return []
    const failed = board.status === 'error'
    return [{
      companyId: company.id, board: board.board, provider: 'greenhouse' as const, checkedAt: legacy.data.fetchedAt,
      failures: failed ? 1 : 0, retryAt: null,
      ...(failed ? { error: (board.message || '이전 조회에 실패했어요.').slice(0, 500) } : {
        snapshot: {
          fetchedAt: legacy.data.fetchedAt,
          jobs: legacy.data.jobs.filter(job => job.companyId === company.id),
          total: board.total,
          // v3 recorded only a global total; a per-company count cannot be recovered.
          unmappedCount: null,
        },
      }),
    }]
  })
}

export function createFileBoardCache(file: string, legacyFiles: string | string[] | undefined, companies: Company[]): BoardCache {
  return {
    async load() {
      try { return parseCachedBoards(await readJson(file)) }
      catch (error) {
        // Only migrate a missing cache. A corrupt newer cache must not resurrect older closed jobs.
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return []
        for (const legacyFile of typeof legacyFiles === 'string' ? [legacyFiles] : legacyFiles ?? []) {
          try {
            const input = await readJson(legacyFile)
            return input && typeof input === 'object' && 'version' in input
              ? parseCachedBoards(input) : migrateLegacy(input, companies)
          } catch (legacyError) {
            if ((legacyError as NodeJS.ErrnoException).code !== 'ENOENT') return []
          }
        }
        return []
      }
    },
    async save(boards) {
      await mkdir(path.dirname(file), { recursive: true })
      const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`
      try {
        await writeFile(temporary, JSON.stringify({ version: 5, boards }), 'utf8')
        await rename(temporary, file)
      } finally {
        await rm(temporary, { force: true })
      }
    },
  }
}
