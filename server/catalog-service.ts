import { CITIES } from '../shared/cities'
import { CATALOG_LIFETIME } from '../shared/catalog-freshness'
import type { CatalogCollectionUpdate, CatalogProgress } from '../shared/catalog-progress'
import { randomUUID } from 'node:crypto'
import { createJobRevision } from '../shared/posting-status'
import { jobPostingUrl } from '../shared/job-links'
import type { PostingBoard, PostingStatusIndex } from '../shared/posting-status'
import { PUBLIC_PROVIDERS } from '../shared/types'
import type { BoardStatus, Catalog, Company, Job } from '../shared/types'
import { belongsToBoard, BoardSnapshotSchema, filterBoardSnapshot } from './board-cache'
import type { BoardCache, BoardSnapshot, CachedBoard } from './board-cache'
import { parseCachedPresence, presenceBelongsToBoard, PresenceResultSchema } from './posting-presence'
import type { CachedPresence, PresenceCache, PresenceResult } from './posting-presence'
import type { ObservationStore } from './catalog-observations'

export const CATALOG_POLICY = {
  ...CATALOG_LIFETIME,
  minRefreshInterval: 60 * 1000,
  maxBackoff: 30 * 60 * 1000,
  concurrency: 4,
} as const

export class BoardFetchError extends Error {
  constructor(message: string, readonly retryAfter?: number) { super(message) }
}

/** Inventory failure is different from failure to retrieve a posting's body. */
export class BoardInventoryError extends BoardFetchError {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : '전체 공개 목록을 확인하지 못했어요.',
      cause instanceof BoardFetchError ? cause.retryAfter : undefined)
    this.cause = cause
  }
}

export class CatalogUnavailableError extends Error {
  constructor(message: string, readonly retryAt: string, readonly code: 'CATALOG_UNAVAILABLE' | 'CATALOG_EXPIRED' = 'CATALOG_UNAVAILABLE') { super(message) }
}

export class CatalogProgressGoneError extends Error {
  constructor() { super('수집 진행 정보를 다시 연결해야 해요. 다시 조회하면 현재 공고부터 이어서 확인합니다.') }
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
  /** Complete published feed, before occupation filtering. Absent for legacy snapshots. */
  publishedIds?: string[]
  unpublishedIds?: string[]
  verifiedActiveIds?: string[]
}

interface Options {
  companies: Company[]
  cache: BoardCache
  fetchBoard: (company: Company, fetchedAt: string) => Promise<BoardResult>
  /** Omit only for integrations that still provide the legacy full-content index. */
  presence?: {
    cache: PresenceCache
    fetchBoard: (company: Company, fetchedAt: string) => Promise<PresenceResult>
  }
  observations?: ObservationStore
  now?: () => number
  random?: () => number
  onCacheError?: (error: unknown) => void
}

export function createCatalogService({ companies, cache, fetchBoard, presence, observations, now = Date.now, random = Math.random, onCacheError = console.warn }: Options) {
  if (!companies.length || companies.some(company => !company.board || !PUBLIC_PROVIDERS.includes(company.provider ?? 'greenhouse')
    || (company.boardRegion && company.provider !== 'lever')) || new Set(companies.map(company => company.id)).size !== companies.length) {
    throw new Error('Each configured job board must have a unique company and board name')
  }
  const boards = new Map<string, CachedBoard>()
  const presences = new Map<string, CachedPresence>()
  let initialized: Promise<void> | null = null
  let pending: Promise<void> | null = null
  let presencePending: Promise<void> | null = null
  interface Collection {
    id: string
    revision: number
    total: number
    waiting: Set<string>
    settled: Map<string, number>
    done: boolean
  }
  // One shared collection and at most one revision number per company, not a
  // history of large catalog snapshots. Monitoring never schedules providers.
  let collection: Collection | null = null
  const progress = (run: Collection): CatalogProgress => ({
    id: run.id, revision: run.revision, total: run.total,
    completed: run.total - run.waiting.size, done: run.done,
  })
  const revisions = new WeakMap<BoardSnapshot, Promise<NonNullable<PostingBoard['listing']>['jobs']>>()
  const iso = (time: number) => new Date(time).toISOString()
  const refreshAt = (entry: Pick<CachedBoard, 'checkedAt' | 'error' | 'retryAt'>) => Math.max(
    Date.parse(entry.checkedAt) + CATALOG_POLICY.minRefreshInterval,
    entry.error && entry.retryAt ? Date.parse(entry.retryAt) : 0,
  )
  const identity = (company: Company) => ({
    companyId: company.id, board: company.board!, provider: company.provider ?? 'greenhouse',
    ...(company.boardRegion ? { boardRegion: company.boardRegion } : {}),
  })
  function nextRefresh(companyId: string, content: boolean): number {
    const own = (content ? boards : presences).get(companyId)
    const other = (content ? presences : boards).get(companyId)
    return Math.max(own ? refreshAt(own) : 0, other?.error && other.retryAt ? Date.parse(other.retryAt) : 0)
  }
  function refreshDeadline(companyId: string, content: boolean): number {
    // An eligible deadline may be in the past. Keep it stable for conditional
    // HTTP requests instead of changing the index every millisecond.
    return nextRefresh(companyId, content)
      || Date.parse(presences.get(companyId)?.checkedAt ?? boards.get(companyId)?.checkedAt ?? iso(now()))
  }
  function seedPresence(entry: CachedBoard) {
    if (!presence || !entry.snapshot?.publishedIds) return
    const snapshot = entry.snapshot
    const previous = presences.get(entry.companyId)
    if (previous && Date.parse(previous.checkedAt) > Date.parse(snapshot.fetchedAt)) return
    // A successful full scan can still skip non-technical details. Do not
    // interpret a skipped detail as an active posting.
    const active = new Set(snapshot.verifiedActiveIds ?? snapshot.jobs.map(job => job.id))
    const ids = new Set(snapshot.publishedIds)
    // A complete full inventory supersedes IDs absent from that inventory.
    // Retain conflicts still listed, keeping this bounded by one board feed.
    const unpublishedIds = [...new Set([
      ...(previous?.unpublishedIds?.filter(id => ids.has(id)) ?? []), ...(snapshot.unpublishedIds ?? []),
    ])]
      .filter(id => !active.has(id))
    const unconfirmedIds = unpublishedIds.filter(id => ids.has(id))
    presences.set(entry.companyId, {
      companyId: entry.companyId, board: entry.board, provider: entry.provider, boardRegion: entry.boardRegion,
      checkedAt: snapshot.fetchedAt, failures: 0, retryAt: null,
      ...(unpublishedIds.length ? { unpublishedIds } : {}),
      snapshot: {
        fetchedAt: snapshot.fetchedAt, total: snapshot.total, publishedIds: snapshot.publishedIds!,
        ...(unconfirmedIds.length ? { unconfirmedIds } : {}),
      },
    })
  }
  function recordInventoryFailure(company: Company, entry: CachedBoard) {
    if (!presence || !entry.error) return
    const previous = presences.get(company.id)
    if (previous && Date.parse(previous.checkedAt) > Date.parse(entry.checkedAt)) return
    presences.set(company.id, {
      ...identity(company), checkedAt: entry.checkedAt,
      failures: entry.failures, retryAt: entry.retryAt, error: entry.error,
      ...(previous?.unpublishedIds?.length ? { unpublishedIds: previous.unpublishedIds } : {}),
      ...(previous?.snapshot ? { snapshot: previous.snapshot } : {}),
    })
  }
  async function initialize() {
    const [loaded, presenceEntries] = await Promise.all([
      cache.load().catch(error => { onCacheError(error); return [] }),
      presence?.cache.load().catch(error => { onCacheError(error); return [] }) ?? [],
    ])
    const loadedPresence = parseCachedPresence({ version: 1, boards: presenceEntries })
    for (const company of companies) {
      const observation = loadedPresence.find(item => item.companyId === company.id && item.board === company.board
        && item.provider === (company.provider ?? 'greenhouse') && item.boardRegion === company.boardRegion)
      if (observation && Date.parse(observation.checkedAt) <= now() + 5 * 60 * 1000) presences.set(company.id, observation)
      const entry = loaded.find(item => item.companyId === company.id && item.board === company.board
        && item.provider === (company.provider ?? 'greenhouse') && item.boardRegion === company.boardRegion)
      if (!entry || Date.parse(entry.checkedAt) > now() + 5 * 60 * 1000) continue
      if (entry.snapshot && (Date.parse(entry.snapshot.fetchedAt) > Date.parse(entry.checkedAt)
        || !belongsToBoard(entry.snapshot, company))) continue
      boards.set(company.id, { ...entry, ...(entry.snapshot ? { snapshot: filterBoardSnapshot(entry.snapshot) } : {}) })
      seedPresence(entry)
      // Old full-cache failures do not identify the failing phase. Preserve
      // their uncertainty instead of manufacturing a successful list check.
      if (entry.error && entry.errorPhase !== 'content') recordInventoryFailure(company, entry)
    }
    await observations?.record(companies.flatMap(company => boards.get(company.id) ?? []), 'cache')
  }

  function compose(partial = false): Catalog {
    const current = now()
    const jobs: Job[] = []
    const statuses: BoardStatus[] = []
    const successfulDates: number[] = []
    let unmappedCount: number | null = 0
    for (const company of companies) {
      const entry = boards.get(company.id)
      const snapshot = entry?.snapshot
      const waiting = partial && collection?.waiting.has(company.id)
      const usable = snapshot && current - Date.parse(snapshot.fetchedAt) <= CATALOG_POLICY.maxFallbackAge
      const dataStatus = !usable ? 'unavailable' : entry?.error || current - Date.parse(snapshot.fetchedAt) >= CATALOG_POLICY.freshFor ? 'stale' : 'fresh'
      if (usable) {
        successfulDates.push(Date.parse(snapshot.fetchedAt))
        jobs.push(...snapshot.jobs.map(job => ({ ...job, stale: dataStatus === 'stale' })))
        unmappedCount = unmappedCount === null || snapshot.unmappedCount === null ? null : unmappedCount + snapshot.unmappedCount
      }
      statuses.push({
        companyId: company.id, board: company.board!, provider: company.provider ?? 'greenhouse', status: waiting ? 'pending' : entry?.error ? 'error' : 'ok',
        dataStatus, total: usable ? snapshot.total : 0, included: usable ? snapshot.jobs.length : 0,
        checkedAt: entry?.checkedAt, lastSuccessAt: snapshot?.fetchedAt ?? null,
        retryAt: !waiting && entry?.error ? iso(refreshAt(entry)) : null,
        ...(entry?.error ? { message: entry.error } : {}),
      })
    }
    const entries = [...boards.values()]
    const refreshAfter = iso(presence
      ? Math.min(...companies.map(company => refreshDeadline(company.id, true)))
      : entries.length ? Math.min(...entries.map(refreshAt)) : current + CATALOG_POLICY.minRefreshInterval)
    if (!successfulDates.length && !partial) {
      const expired = [...boards.values()].some(entry => entry.snapshot)
      throw new CatalogUnavailableError(expired
        ? '게시판에 연결하지 못했어요. 마지막 정상 조회가 24시간을 지나 이전 공고를 표시하지 않습니다.'
        : '공개 채용 게시판에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요.', refreshAfter, expired ? 'CATALOG_EXPIRED' : 'CATALOG_UNAVAILABLE')
    }
    return {
      source: 'public', fetchedAt: successfulDates.length ? iso(Math.max(...successfulDates)) : '',
      ...(entries.length ? { checkedAt: iso(Math.max(...entries.map(entry => Date.parse(entry.checkedAt)))) } : {}),
      refreshAfter, stale: statuses.some(board => board.dataStatus === 'stale'),
      companies, cities: CITIES, jobs, boards: statuses, unmappedCount,
    }
  }

  function summariesFor(snapshot: BoardSnapshot) {
    let summaries = revisions.get(snapshot)
    if (!summaries) {
      summaries = Promise.all(snapshot.jobs.map(async job => ({
        id: job.id, title: job.title, url: jobPostingUrl(job), revision: await createJobRevision(job),
      })))
      revisions.set(snapshot, summaries)
      void summaries.catch(() => revisions.delete(snapshot))
    }
    return summaries
  }

  async function composePostingStatus(): Promise<PostingStatusIndex> {
    const current = now()
    const statuses = await Promise.all(companies.map(async (company): Promise<PostingBoard> => {
      const entry = boards.get(company.id)!
      const snapshot = entry.snapshot
      const usable = snapshot && current - Date.parse(snapshot.fetchedAt) <= CATALOG_POLICY.maxFallbackAge
      let listing: PostingBoard['listing']
      if (usable && snapshot.publishedIds !== undefined) {
        listing = {
          validUntil: iso(Date.parse(snapshot.fetchedAt) + CATALOG_POLICY.freshFor),
          publishedIds: snapshot.publishedIds,
          jobs: await summariesFor(snapshot),
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

  async function composePresenceStatus(): Promise<PostingStatusIndex> {
    const current = now()
    const statuses = await Promise.all(companies.map(async (company): Promise<PostingBoard> => {
      const entry = presences.get(company.id)
      const snapshot = entry?.snapshot
      const full = boards.get(company.id)
      const body = full?.snapshot
      const usable = snapshot && current - Date.parse(snapshot.fetchedAt) <= CATALOG_POLICY.maxFallbackAge
      let listing: PostingBoard['listing']
      if (usable) {
        const bodyFresh = body && !full.error && current < Date.parse(body.fetchedAt) + CATALOG_POLICY.freshFor
        const ids = new Set(snapshot.publishedIds)
        const unconfirmed = new Set(snapshot.unconfirmedIds)
        listing = {
          validUntil: iso(Date.parse(snapshot.fetchedAt) + CATALOG_POLICY.freshFor),
          publishedIds: snapshot.publishedIds,
          ...(unconfirmed.size ? { unconfirmedIds: [...unconfirmed] } : {}),
          jobs: bodyFresh ? (await summariesFor(body)).filter(job => ids.has(job.id) && !unconfirmed.has(job.id)) : [],
          ...(body ? { content: {
            checkedAt: body.fetchedAt,
            validUntil: iso(Date.parse(body.fetchedAt) + CATALOG_POLICY.freshFor),
            status: full.error ? 'error' as const : 'ok' as const,
            jobIds: body.jobs.map(job => job.id),
          } } : {}),
        }
      }
      const error = entry?.error ?? (!entry ? full?.error ?? '전체 공개 목록을 아직 확인하지 못했어요.' : undefined)
      return {
        ...identity(company), status: error ? 'error' : 'ok',
        checkedAt: entry?.checkedAt ?? full?.checkedAt ?? iso(current),
        lastSuccessAt: snapshot?.fetchedAt ?? null,
        retryAt: error ? iso(nextRefresh(company.id, false)) : null,
        ...(error ? { message: error } : {}), ...(listing ? { listing } : {}),
      }
    }))
    return {
      version: 2,
      checkedAt: iso(Math.max(...statuses.map(board => Date.parse(board.checkedAt)))),
      refreshAfter: iso(Math.min(...companies.map(company => refreshDeadline(company.id, false)))),
      contentRefreshAfter: iso(Math.min(...companies.map(company => refreshDeadline(company.id, true)))),
      boards: statuses,
    }
  }

  function failure(cause: unknown, previousFailures: number) {
    const failures = Math.min(previousFailures + 1, 1000)
    const backoff = Math.min(CATALOG_POLICY.minRefreshInterval * 2 ** Math.min(failures - 1, 10), CATALOG_POLICY.maxBackoff)
    const delay = Math.min(CATALOG_POLICY.maxBackoff, backoff + Math.floor(backoff * 0.2 * random()))
    return {
      failures,
      retryAt: iso(Math.max(now() + delay, cause instanceof BoardFetchError ? cause.retryAfter ?? 0 : 0)),
      error: (cause instanceof Error ? cause.message : '조회 실패').slice(0, 500) || '조회 실패',
    }
  }

  async function collect(company: Company) {
    const previous = boards.get(company.id)
    const checkedAt = iso(now())
    try {
      const result = await fetchBoard(company, checkedAt)
      if (presence) {
        const inventory = PresenceResultSchema.safeParse(result)
        if (!inventory.success || !presenceBelongsToBoard(inventory.data, company)) {
          throw new BoardInventoryError(new BoardFetchError('게시판의 전체 공개 목록을 확인하지 못했어요.'))
        }
      }
      const parsed = BoardSnapshotSchema.safeParse({
        ...result, fetchedAt: checkedAt,
        jobs: [...new Map(result.jobs.map(job => [job.id, job])).values()],
        ...(observations ? { observationMethod: observations.method } : {}),
      })
      if (!parsed.success) throw new BoardFetchError('공고 정보를 확인하지 못했어요.')
      const snapshot = parsed.data
      if (!belongsToBoard(snapshot, company)) {
        throw new Error('공고의 회사·출처 또는 조회 시각이 게시판과 일치하지 않아요.')
      }
      boards.set(company.id, {
        companyId: company.id, board: company.board!, provider: company.provider ?? 'greenhouse', boardRegion: company.boardRegion,
        checkedAt, failures: 0, retryAt: null, snapshot: filterBoardSnapshot(snapshot),
      })
      seedPresence(boards.get(company.id)!)
    } catch (cause) {
      boards.set(company.id, {
        companyId: company.id, board: company.board!, provider: company.provider ?? 'greenhouse', boardRegion: company.boardRegion,
        checkedAt, ...failure(cause, Math.max(previous?.failures ?? 0, presences.get(company.id)?.failures ?? 0)),
        errorPhase: cause instanceof BoardInventoryError ? 'inventory' : 'content',
        ...(previous?.snapshot ? { snapshot: previous.snapshot } : {}),
      })
      if (cause instanceof BoardInventoryError) recordInventoryFailure(company, boards.get(company.id)!)
    }
  }

  async function collectPresence(company: Company) {
    const previous = presences.get(company.id)
    const checkedAt = iso(now())
    try {
      const parsed = PresenceResultSchema.safeParse(await presence!.fetchBoard(company, checkedAt))
      if (!parsed.success || !presenceBelongsToBoard(parsed.data, company)) {
        throw new BoardFetchError('게시판의 전체 공개 목록을 확인하지 못했어요.')
      }
      const published = new Set(parsed.data.publishedIds)
      const unconfirmedIds = previous?.unpublishedIds?.filter(id => published.has(id)) ?? []
      presences.set(company.id, {
        ...identity(company), checkedAt, failures: 0, retryAt: null,
        ...(previous?.unpublishedIds?.length ? { unpublishedIds: previous.unpublishedIds } : {}),
        snapshot: { ...parsed.data, fetchedAt: checkedAt, ...(unconfirmedIds.length ? { unconfirmedIds } : {}) },
      })
    } catch (cause) {
      presences.set(company.id, {
        ...identity(company), checkedAt,
        ...failure(cause, Math.max(previous?.failures ?? 0, boards.get(company.id)?.failures ?? 0)),
        ...(previous?.unpublishedIds?.length ? { unpublishedIds: previous.unpublishedIds } : {}),
        ...(previous?.snapshot ? { snapshot: previous.snapshot } : {}),
      })
    }
  }

  async function persistPresence() {
    if (!presence) return
    try { await presence.cache.save(companies.flatMap(company => presences.get(company.id) ?? [])) } catch (error) { onCacheError(error) }
  }

  async function refresh(due: Company[], run: Collection): Promise<void> {
    let cursor = 0
    await Promise.all(Array.from({ length: Math.min(CATALOG_POLICY.concurrency, due.length) }, async () => {
      while (cursor < due.length) {
        const company = due[cursor++]
        await collect(company)
        run.waiting.delete(company.id)
        run.settled.set(company.id, ++run.revision)
      }
    }))
    // Provider completion order must not reorder the persisted board inventory.
    try { await cache.save(companies.flatMap(company => boards.get(company.id) ?? [])) } catch (error) { onCacheError(error) }
    await persistPresence()
    await observations?.record(companies.flatMap(company => boards.get(company.id) ?? []), 'collection')
  }

  async function startCollection(force: boolean): Promise<void> {
    await (initialized ??= initialize())
    if (presencePending) await presencePending
    if (pending) return
    const current = now()
    const due = companies.filter(company => {
      const entry = boards.get(company.id)
      if (presence && current < nextRefresh(company.id, true)) return false
      if (!entry) return true
      if (entry.error) return current >= refreshAt(entry)
      return current - Date.parse(entry.checkedAt) >= (force ? CATALOG_POLICY.minRefreshInterval : CATALOG_POLICY.freshFor)
    })
    if (!due.length) return
    const run: Collection = {
      id: randomUUID(), revision: 0, total: due.length,
      waiting: new Set(due.map(company => company.id)), settled: new Map(), done: false,
    }
    collection = run
    pending = refresh(due, run).finally(() => {
      run.done = true
      run.revision++
      pending = null
    })
    // Provider failures are recorded per board. Do not leave a rejected
    // background promise unobserved if persistence/error reporting itself fails.
    void pending.catch(onCacheError)
  }

  async function ensurePresence(force: boolean): Promise<void> {
    await (initialized ??= initialize())
    if (pending) await pending
    if (presencePending) return presencePending
    const current = now()
    const due = companies.filter(company => {
      if (current < nextRefresh(company.id, false)) return false
      const entry = presences.get(company.id)
      return !entry || Boolean(entry.error)
        || current - Date.parse(entry.checkedAt) >= (force ? CATALOG_POLICY.minRefreshInterval : CATALOG_POLICY.freshFor)
    })
    if (!due.length) return
    presencePending = (async () => {
      let cursor = 0
      await Promise.all(Array.from({ length: Math.min(CATALOG_POLICY.concurrency, due.length) }, async () => {
        while (cursor < due.length) await collectPresence(due[cursor++])
      }))
      await persistPresence()
    })().finally(() => { presencePending = null })
    await presencePending
  }

  async function ensureFresh(force: boolean): Promise<void> {
    await startCollection(force)
    await pending
  }

  return {
    async getObservations() {
      await (initialized ??= initialize())
      if (!observations) throw new Error('관측 기록을 지원하지 않는 서버입니다.')
      return observations.read()
    },
    async get(force = false): Promise<Catalog> {
      await ensureFresh(force)
      return compose()
    },
    async getProgressive(force = false): Promise<{ catalog: Catalog; progress: CatalogProgress | null }> {
      await startCollection(force)
      const running = collection && !collection.done
      return { catalog: compose(Boolean(running)), progress: running ? progress(collection!) : null }
    },
    readProgress(id: string, after: number): CatalogCollectionUpdate | null {
      const run = collection
      if (!run || run.id !== id) throw new CatalogProgressGoneError()
      if (!Number.isSafeInteger(after) || after < 0 || after > run.revision) throw new RangeError('잘못된 수집 진행 번호입니다.')
      if (after === run.revision && !run.done) return null
      const companyIds = [...run.settled].filter(([, revision]) => revision > after).map(([companyId]) => companyId)
      const changed = new Set(companyIds)
      const { jobs, companies: _companies, cities: _cities, ...catalog } = compose(!run.done)
      return { progress: progress(run), companyIds, jobs: jobs.filter(job => changed.has(job.companyId)), catalog }
    },
    async getPostingStatus(force = false, content = false): Promise<PostingStatusIndex> {
      if (!presence) {
        await ensureFresh(force)
        return composePostingStatus()
      }
      if (content) await ensureFresh(force)
      else await ensurePresence(force)
      return composePresenceStatus()
    },
  }
}
