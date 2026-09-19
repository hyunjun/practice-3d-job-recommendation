import { CITIES } from '../shared/cities'
import { createJobRevision } from '../shared/posting-status'
import type { PostingBoard, PostingStatusIndex } from '../shared/posting-status'
import { PUBLIC_PROVIDERS } from '../shared/types'
import type { BoardStatus, Catalog, Company, Job } from '../shared/types'
import { BoardSnapshotSchema } from './board-cache'
import type { BoardCache, BoardSnapshot, CachedBoard } from './board-cache'

export const CATALOG_POLICY = {
  freshFor: 30 * 60 * 1000,
  minRefreshInterval: 60 * 1000,
  maxFallbackAge: 24 * 60 * 60 * 1000,
  maxBackoff: 30 * 60 * 1000,
  concurrency: 4,
} as const

export class BoardFetchError extends Error {
  constructor(message: string, readonly retryAfter?: number) { super(message) }
}

export class CatalogUnavailableError extends Error {
  constructor(message: string, readonly retryAt: string, readonly code: 'CATALOG_UNAVAILABLE' | 'CATALOG_EXPIRED' = 'CATALOG_UNAVAILABLE') { super(message) }
}

export function parseRetryAfter(value: string | null, now: number): number | undefined {
  if (!value?.trim()) return undefined
  const trimmed = value.trim()
  const result = /^\d+$/.test(trimmed) ? now + Number(trimmed) * 1000 : Date.parse(trimmed)
  return Number.isFinite(result) && result > now && result <= 8640000000000000 ? result : undefined
}

export interface BoardResult {
  jobs: Job[]
  total: number
  unmappedCount: number
  /** Complete published feed, before developer-role filtering. Absent for legacy snapshots. */
  publishedIds?: string[]
}

interface Options {
  companies: Company[]
  cache: BoardCache
  fetchBoard: (company: Company, fetchedAt: string) => Promise<BoardResult>
  now?: () => number
  random?: () => number
  onCacheError?: (error: unknown) => void
}

export function createCatalogService({ companies, cache, fetchBoard, now = Date.now, random = Math.random, onCacheError = console.warn }: Options) {
  if (!companies.length || companies.some(company => !company.board || !PUBLIC_PROVIDERS.includes(company.provider ?? 'greenhouse')
    || (company.boardRegion && company.provider !== 'lever')) || new Set(companies.map(company => company.id)).size !== companies.length) {
    throw new Error('Each configured job board must have a unique company and board name')
  }
  const boards = new Map<string, CachedBoard>()
  let initialized: Promise<void> | null = null
  let pending: Promise<void> | null = null
  const revisions = new WeakMap<BoardSnapshot, Promise<NonNullable<PostingBoard['listing']>['jobs']>>()
  const iso = (time: number) => new Date(time).toISOString()
  const refreshAt = (entry: CachedBoard) => Math.max(
    Date.parse(entry.checkedAt) + CATALOG_POLICY.minRefreshInterval,
    entry.error && entry.retryAt ? Date.parse(entry.retryAt) : 0,
  )
  const belongsToBoard = (snapshot: BoardSnapshot, company: Company) => {
    const prefix = `${company.provider ?? 'greenhouse'}-${company.id}-`
    return snapshot.jobs.every(job =>
      job.companyId === company.id && job.source === (company.provider ?? 'greenhouse')
      && job.id.startsWith(prefix) && job.fetchedAt === snapshot.fetchedAt,
    ) && (snapshot.publishedIds?.every(id => id.startsWith(prefix)) ?? true)
  }

  async function initialize() {
    const loaded = await cache.load().catch(error => { onCacheError(error); return [] })
    for (const company of companies) {
      const entry = loaded.find(item => item.companyId === company.id && item.board === company.board
        && item.provider === (company.provider ?? 'greenhouse') && item.boardRegion === company.boardRegion)
      if (!entry || Date.parse(entry.checkedAt) > now() + 5 * 60 * 1000) continue
      if (entry.snapshot && (Date.parse(entry.snapshot.fetchedAt) > Date.parse(entry.checkedAt)
        || !belongsToBoard(entry.snapshot, company))) continue
      boards.set(company.id, entry)
    }
  }

  function compose(): Catalog {
    const current = now()
    const jobs: Job[] = []
    const statuses: BoardStatus[] = []
    const successfulDates: number[] = []
    let unmappedCount: number | null = 0
    for (const company of companies) {
      const entry = boards.get(company.id)!
      const snapshot = entry.snapshot
      const usable = snapshot && current - Date.parse(snapshot.fetchedAt) <= CATALOG_POLICY.maxFallbackAge
      const dataStatus = !usable ? 'unavailable' : entry.error || current - Date.parse(snapshot.fetchedAt) >= CATALOG_POLICY.freshFor ? 'stale' : 'fresh'
      if (usable) {
        successfulDates.push(Date.parse(snapshot.fetchedAt))
        jobs.push(...snapshot.jobs.map(job => ({ ...job, stale: dataStatus === 'stale' })))
        unmappedCount = unmappedCount === null || snapshot.unmappedCount === null ? null : unmappedCount + snapshot.unmappedCount
      }
      statuses.push({
        companyId: company.id, board: company.board!, provider: company.provider ?? 'greenhouse', status: entry.error ? 'error' : 'ok',
        dataStatus, total: usable ? snapshot.total : 0, included: usable ? snapshot.jobs.length : 0,
        checkedAt: entry.checkedAt, lastSuccessAt: snapshot?.fetchedAt ?? null,
        retryAt: entry.error ? iso(refreshAt(entry)) : null,
        ...(entry.error ? { message: entry.error } : {}),
      })
    }
    const refreshAfter = iso(Math.min(...[...boards.values()].map(refreshAt)))
    if (!successfulDates.length) {
      const expired = [...boards.values()].some(entry => entry.snapshot)
      throw new CatalogUnavailableError(expired
        ? '게시판에 연결하지 못했어요. 마지막 정상 조회가 24시간을 지나 이전 공고를 표시하지 않습니다.'
        : '공개 채용 게시판에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요.', refreshAfter, expired ? 'CATALOG_EXPIRED' : 'CATALOG_UNAVAILABLE')
    }
    return {
      source: 'public', fetchedAt: iso(Math.max(...successfulDates)),
      checkedAt: iso(Math.max(...[...boards.values()].map(entry => Date.parse(entry.checkedAt)))),
      refreshAfter, stale: statuses.some(board => board.dataStatus === 'stale'),
      companies, cities: CITIES, jobs, boards: statuses, unmappedCount,
    }
  }

  async function composePostingStatus(): Promise<PostingStatusIndex> {
    const current = now()
    const statuses = await Promise.all(companies.map(async (company): Promise<PostingBoard> => {
      const entry = boards.get(company.id)!
      const snapshot = entry.snapshot
      const usable = snapshot && current - Date.parse(snapshot.fetchedAt) <= CATALOG_POLICY.maxFallbackAge
      let listing: PostingBoard['listing']
      if (usable && snapshot.publishedIds !== undefined) {
        let summaries = revisions.get(snapshot)
        if (!summaries) {
          summaries = Promise.all(snapshot.jobs.map(async job => ({
            id: job.id, title: job.title, url: job.url, revision: await createJobRevision(job),
          })))
          revisions.set(snapshot, summaries)
          void summaries.catch(() => revisions.delete(snapshot))
        }
        listing = {
          validUntil: iso(Date.parse(snapshot.fetchedAt) + CATALOG_POLICY.freshFor),
          publishedIds: snapshot.publishedIds,
          jobs: await summaries,
        }
      }
      return {
        companyId: company.id, provider: company.provider ?? 'greenhouse',
        board: company.board!, ...(company.boardRegion ? { boardRegion: company.boardRegion } : {}),
        status: entry.error ? 'error' : 'ok', checkedAt: entry.checkedAt,
        lastSuccessAt: snapshot?.fetchedAt ?? null,
        retryAt: entry.error ? iso(refreshAt(entry)) : null,
        ...(entry.error ? { message: entry.error } : {}), ...(listing ? { listing } : {}),
      }
    }))
    return {
      version: 1,
      checkedAt: iso(Math.max(...statuses.map(board => Date.parse(board.checkedAt)))),
      refreshAfter: iso(Math.min(...[...boards.values()].map(refreshAt))),
      boards: statuses,
    }
  }

  async function collect(company: Company) {
    const previous = boards.get(company.id)
    const checkedAt = iso(now())
    try {
      const result = await fetchBoard(company, checkedAt)
      const parsed = BoardSnapshotSchema.safeParse({
        ...result, fetchedAt: checkedAt,
        jobs: [...new Map(result.jobs.map(job => [job.id, job])).values()],
      })
      if (!parsed.success) throw new BoardFetchError('공고 정보를 확인하지 못했어요.')
      const snapshot = parsed.data
      if (!belongsToBoard(snapshot, company)) {
        throw new Error('공고의 회사·출처 또는 조회 시각이 게시판과 일치하지 않아요.')
      }
      boards.set(company.id, {
        companyId: company.id, board: company.board!, provider: company.provider ?? 'greenhouse', boardRegion: company.boardRegion,
        checkedAt, failures: 0, retryAt: null, snapshot,
      })
    } catch (cause) {
      const failures = Math.min((previous?.failures ?? 0) + 1, 1000)
      const backoff = Math.min(CATALOG_POLICY.minRefreshInterval * 2 ** Math.min(failures - 1, 10), CATALOG_POLICY.maxBackoff)
      const delay = Math.min(CATALOG_POLICY.maxBackoff, backoff + Math.floor(backoff * 0.2 * random()))
      const retryAt = Math.max(now() + delay, cause instanceof BoardFetchError ? cause.retryAfter ?? 0 : 0)
      boards.set(company.id, {
        companyId: company.id, board: company.board!, provider: company.provider ?? 'greenhouse', boardRegion: company.boardRegion,
        checkedAt, failures, retryAt: iso(retryAt),
        error: (cause instanceof Error ? cause.message : '조회 실패').slice(0, 500) || '조회 실패',
        ...(previous?.snapshot ? { snapshot: previous.snapshot } : {}),
      })
    }
  }

  async function refresh(due: Company[]): Promise<void> {
    let cursor = 0
    await Promise.all(Array.from({ length: Math.min(CATALOG_POLICY.concurrency, due.length) }, async () => {
      while (cursor < due.length) await collect(due[cursor++])
    }))
    try { await cache.save([...boards.values()]) } catch (error) { onCacheError(error) }
  }

  async function ensureFresh(force: boolean): Promise<void> {
    await (initialized ??= initialize())
    if (pending) return pending
    const current = now()
    const due = companies.filter(company => {
      const entry = boards.get(company.id)
      if (!entry) return true
      if (entry.error) return current >= refreshAt(entry)
      return current - Date.parse(entry.checkedAt) >= (force ? CATALOG_POLICY.minRefreshInterval : CATALOG_POLICY.freshFor)
    })
    if (!due.length) return
    pending = refresh(due)
    try { await pending } finally { pending = null }
  }

  return {
    async get(force = false): Promise<Catalog> {
      await ensureFresh(force)
      return compose()
    },
    async getPostingStatus(force = false): Promise<PostingStatusIndex> {
      await ensureFresh(force)
      return composePostingStatus()
    },
  }
}
