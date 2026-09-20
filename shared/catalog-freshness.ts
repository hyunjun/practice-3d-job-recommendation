import { isUnmappedJob } from './job-location'
import type { BoardStatus, Catalog, Job } from './types'

export const CATALOG_LIFETIME = {
  freshFor: 30 * 60 * 1000,
  maxFallbackAge: 24 * 60 * 60 * 1000,
} as const

export const PUBLIC_CATALOG_RECHECK_COOLDOWN = 60_000

export type SnapshotFreshness = 'fresh' | 'stale' | 'expired' | 'unknown'

export function snapshotFreshness(fetchedAt: string | null | undefined, now: number): SnapshotFreshness {
  const time = fetchedAt ? Date.parse(fetchedAt) : NaN
  if (!Number.isFinite(time)) return 'unknown'
  const age = now - time
  return age > CATALOG_LIFETIME.maxFallbackAge ? 'expired' : age >= CATALOG_LIFETIME.freshFor ? 'stale' : 'fresh'
}

export function jobFreshness(job: Job, now: number): SnapshotFreshness {
  if (job.source === 'sample') return 'fresh'
  const age = snapshotFreshness(job.fetchedAt, now)
  return age === 'fresh' && job.stale ? 'stale' : age
}

export function snapshotDeadlines(fetchedAt: string | null | undefined): number[] {
  const time = fetchedAt ? Date.parse(fetchedAt) : NaN
  // The collector permits an age of exactly 24h; exclusion starts 1ms later.
  return Number.isFinite(time) ? [time + CATALOG_LIFETIME.freshFor, time + CATALOG_LIFETIME.maxFallbackAge + 1] : []
}

export function catalogDeadlines(catalog: Catalog): number[] {
  if (catalog.source === 'sample' || !catalog.fetchedAt) return []
  return [...new Set([
    ...snapshotDeadlines(catalog.fetchedAt),
    ...catalog.boards.flatMap(board => snapshotDeadlines(board.lastSuccessAt)),
    ...catalog.jobs.flatMap(job => snapshotDeadlines(job.fetchedAt)),
  ])].sort((a, b) => a - b)
}

function legacyJobTimes(catalog: Catalog): Map<string, string> {
  const oldest = new Map<string, string>()
  if (!catalog.boards.some(board => board.lastSuccessAt !== null
    && (!board.lastSuccessAt || !Number.isFinite(Date.parse(board.lastSuccessAt))))) return oldest
  for (const job of catalog.jobs) {
    const time = Date.parse(job.fetchedAt)
    if (!Number.isFinite(time)) continue
    const previous = oldest.get(job.companyId)
    if (previous === undefined || time < Date.parse(previous)) oldest.set(job.companyId, job.fetchedAt)
  }
  return oldest
}

function boardSnapshotTime(board: BoardStatus, catalog: Catalog, jobTimes: ReadonlyMap<string, string>): string | undefined {
  if (board.lastSuccessAt === null) return undefined
  if (board.lastSuccessAt && Number.isFinite(Date.parse(board.lastSuccessAt))) return board.lastSuccessAt
  const oldest = jobTimes.get(board.companyId)
  if (oldest !== undefined) return oldest
  return board.status === 'ok' && board.dataStatus !== 'unavailable' ? catalog.fetchedAt : undefined
}

/** A visible return may check due public boards; the server still owns collection scheduling. */
export function catalogNeedsRevalidation(catalog: Catalog, now: number): boolean {
  if (catalog.source === 'sample') return false
  if (!catalog.fetchedAt) return true
  if (!catalog.boards.length) return catalog.stale || snapshotFreshness(catalog.fetchedAt, now) !== 'fresh'
  const jobTimes = legacyJobTimes(catalog)
  return catalog.boards.some(board => {
    if (board.status === 'pending') return true
    if (board.status === 'error') {
      const checkedAt = Date.parse(board.checkedAt ?? '')
      const retryAt = Date.parse(board.retryAt ?? '')
      return (!Number.isFinite(checkedAt) || now >= checkedAt + PUBLIC_CATALOG_RECHECK_COOLDOWN)
        && (!Number.isFinite(retryAt) || now >= retryAt)
    }
    return board.dataStatus === 'unavailable' || board.dataStatus === 'stale'
      || snapshotFreshness(boardSnapshotTime(board, catalog, jobTimes), now) !== 'fresh'
  })
}

/** Derive the current view without rewriting the received snapshot or saved records. */
export function ageCatalog(original: Catalog, now: number): { catalog: Catalog; expired: boolean } {
  if (original.source === 'sample' || !original.fetchedAt) return { catalog: original, expired: false }
  const jobTimes = legacyJobTimes(original)
  const unavailable = new Set<string>()
  const retained = new Set<string>()
  let usableBoards = 0
  let expiredBoards = 0
  const boards = original.boards.map(board => {
    const snapshotTime = boardSnapshotTime(board, original, jobTimes)
    const age = snapshotFreshness(snapshotTime, now)
    const history = board.lastSuccessAt === undefined && snapshotTime ? { lastSuccessAt: snapshotTime } : {}
    if (age === 'expired') expiredBoards++
    if (age === 'expired' || age === 'unknown' || board.dataStatus === 'unavailable') {
      unavailable.add(board.companyId)
      return board.dataStatus === 'unavailable' && !board.included && !board.total ? board
        : { ...board, ...history, dataStatus: 'unavailable' as const, included: 0, total: 0 }
    }
    usableBoards++
    if (age === 'stale' || board.status === 'error' || board.dataStatus === 'stale') {
      retained.add(board.companyId)
      return board.dataStatus === 'stale' ? board : { ...board, ...history, dataStatus: 'stale' as const }
    }
    return board
  })
  let removedUnmapped = 0
  const jobs = original.jobs.flatMap(job => {
    const age = jobFreshness(job, now)
    if (unavailable.has(job.companyId) || age === 'expired' || age === 'unknown') {
      if (isUnmappedJob(job)) removedUnmapped++
      return []
    }
    const stale = age === 'stale' || retained.has(job.companyId) || (job.stale ?? original.stale)
    return [stale && !job.stale ? { ...job, stale: true } : job]
  })
  const expired = !usableBoards && !jobs.length && (expiredBoards > 0 || snapshotFreshness(original.fetchedAt, now) === 'expired')
  const priorUnmapped = original.jobs.filter(isUnmappedJob).length
  const unmappedCount = expired ? 0 : original.unmappedCount === null
    || (expiredBoards > 0 && original.unmappedCount > priorUnmapped) ? null
      : Math.max(0, original.unmappedCount - removedUnmapped)
  const stale = jobs.some(job => job.stale) || boards.some(board => board.dataStatus === 'stale')
  const unchanged = !expired && stale === original.stale && unmappedCount === original.unmappedCount
    && jobs.length === original.jobs.length && jobs.every((job, index) => job === original.jobs[index])
    && boards.every((board, index) => board === original.boards[index])
  return { catalog: unchanged ? original : { ...original, jobs, boards, stale, unmappedCount, fetchedAt: expired ? '' : original.fetchedAt }, expired }
}
