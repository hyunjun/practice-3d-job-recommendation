import { applyCatalogUpdate } from '../../shared/catalog-progress'
import type { CatalogCollectionSnapshot, CatalogProgress } from '../../shared/catalog-progress'
import type { Catalog } from '../../shared/types'
import { CatalogUpdateDataSchema, hasConsistentCatalog, isPublicCatalog } from './catalog-validation'

export class CatalogRequestError extends Error {
  constructor(message: string, readonly code?: string, readonly retryAt?: string) { super(message) }
}

const malformed = () => new CatalogRequestError('공고 데이터 형식을 확인하지 못했어요. 다시 조회해 주세요.')
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const date = (value: unknown) => typeof value === 'string' && Number.isFinite(Date.parse(value))

function readCatalog(value: unknown, partial = false): Catalog {
  if (!isPublicCatalog(value, partial)) throw malformed()
  return value
}

function readProgress(value: unknown, catalog: Catalog): CatalogProgress {
  if (!record(value) || typeof value.id !== 'string' || !/^[a-f0-9-]{36}$/i.test(value.id)
    || !Number.isSafeInteger(value.revision) || (value.revision as number) < 0
    || value.phase !== undefined && value.phase !== 'waiting-for-presence' && value.phase !== 'collecting'
    || typeof value.done !== 'boolean') throw malformed()
  const pending = catalog.boards.filter(board => board.status === 'pending').length
  if (value.phase === 'waiting-for-presence') {
    if (value.total !== null || value.completed !== 0 || value.done || pending !== 0) throw malformed()
  } else if (!Number.isSafeInteger(value.total) || (value.total as number) < 0 || (value.total as number) > catalog.companies.length
    || value.total === 0 && (value.phase !== 'collecting' || !value.done)
    || !Number.isSafeInteger(value.completed) || (value.completed as number) < 0 || (value.completed as number) > (value.total as number)
    || value.done && value.completed !== value.total
    || pending !== (value.total as number) - (value.completed as number)) throw malformed()
  return value as unknown as CatalogProgress
}

function readSnapshot(value: unknown): CatalogCollectionSnapshot {
  if (!record(value)) throw malformed()
  const catalog = readCatalog(value.catalog, true)
  const progress = readProgress(value.progress, catalog)
  if (progress.done) throw malformed()
  return { catalog, progress }
}

function readUpdate(value: unknown, previous: CatalogCollectionSnapshot): CatalogCollectionSnapshot {
  if (!record(value)) throw malformed()
  const progressValue = value.progress
  if (!CatalogUpdateDataSchema.validate(value)) throw malformed()
  const catalog = { ...value.catalog, jobs: value.jobs, companies: previous.catalog.companies, cities: previous.catalog.cities }
  const progress = readProgress(progressValue, catalog)
  const companies = new Map(previous.catalog.companies.map(company => [company.id, company]))
  const replaced = new Set(value.companyIds)
  const previousBoards = new Map(previous.catalog.boards.map(board => [board.companyId, board]))
  const boards = new Map(catalog.boards.map(board => [board.companyId, board]))
  const wasWaiting = previous.progress.phase === 'waiting-for-presence'
  const waiting = progress.phase === 'waiting-for-presence'
  if (progress.id !== previous.progress.id || !wasWaiting && (waiting || progress.total !== previous.progress.total)
    || progress.completed < previous.progress.completed
    || progress.revision < previous.progress.revision
    || progress.revision === previous.progress.revision && (!progress.done || !previous.progress.done)
    || replaced.size !== value.companyIds.length || value.companyIds.some(id => typeof id !== 'string' || !companies.has(id))
    || waiting && (replaced.size !== 0 || catalog.jobs.length !== 0)
    || wasWaiting && !waiting && replaced.size !== progress.completed
    || catalog.boards.length !== previous.catalog.boards.length || boards.size !== catalog.boards.length
    || catalog.boards.some(board => {
      const prior = previousBoards.get(board.companyId)
      return !prior || board.board !== prior.board || (board.provider ?? 'greenhouse') !== (prior.provider ?? 'greenhouse')
        || prior.status === 'pending' && board.status !== 'pending' && !replaced.has(board.companyId)
        || !wasWaiting && prior.status !== 'pending' && board.status === 'pending'
        || replaced.has(board.companyId) && board.status === 'pending'
        || wasWaiting && !replaced.has(board.companyId) && board.lastSuccessAt !== prior.lastSuccessAt
    })
    || catalog.jobs.some(job => !replaced.has(job.companyId)
      || job.source !== (companies.get(job.companyId)?.provider ?? 'greenhouse')
      || !job.id.startsWith(`${job.source}-${job.companyId}-`)
      || boards.get(job.companyId)?.dataStatus === 'unavailable')
    || new Set(catalog.jobs.map(job => job.id)).size !== catalog.jobs.length) throw malformed()
  // A delta cannot replace the validated company/city registry from the snapshot.
  const { companies: _companies, cities: _cities, jobs, ...metadata } = catalog
  const merged = applyCatalogUpdate(previous.catalog, { catalog: metadata, companyIds: value.companyIds, jobs, progress })
  if (!hasConsistentCatalog(merged, !progress.done)) throw malformed()
  return { catalog: merged, progress }
}

async function readResponse(response: Response): Promise<unknown> {
  const result: unknown = await response.json().catch(() => { throw malformed() })
  if (!response.ok) {
    throw new CatalogRequestError(record(result) && typeof result.error === 'string' ? result.error : '공개 공고를 불러오지 못했어요.',
      record(result) && typeof result.code === 'string' ? result.code : undefined,
      record(result) && date(result.retryAt) ? result.retryAt as string : undefined)
  }
  return result
}

function waitForProgress(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted()
    const finish = () => { signal.removeEventListener('abort', abort); resolve() }
    const timer = setTimeout(finish, Math.min(milliseconds, 2 ** 31 - 1))
    const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(signal.reason) }
    signal.addEventListener('abort', abort, { once: true })
  })
}

function retryDelay(response: Response): number {
  const value = response.headers.get('Retry-After')
  const requested = value && /^\d+$/.test(value) ? Number(value) * 1000 : value ? Date.parse(value) - Date.now() : 0
  return Math.max(1000, Number.isFinite(requested) ? requested : 0)
}

export interface CatalogRead<T> {
  value: T
  progress: CatalogProgress | null
}

/** One decoder owns the validated snapshot for one collection, including its deltas. */
export function createCatalogReader(): (response: Response, initial: boolean) => Promise<CatalogRead<Catalog>> {
  let state: CatalogCollectionSnapshot | undefined
  return async (response, initial) => {
    const result = await readResponse(response)
    if (initial) {
      if (response.status !== 202) {
        state = undefined
        return { value: readCatalog(result), progress: null }
      }
      state = readSnapshot(result)
    } else {
      if (!state) throw malformed()
      state = readUpdate(result, state)
    }
    return { value: state.catalog, progress: state.progress }
  }
}

/** Transport stays on the page; decoding and computation can run in a dedicated worker. */
export async function requestCatalogStream<T>({
  refresh, signal, read, onUpdate,
}: {
  refresh: boolean
  signal: AbortSignal
  read: (response: Response, initial: boolean) => Promise<CatalogRead<T>>
  onUpdate: (value: T, progress: CatalogProgress | null) => void | Promise<void>
}): Promise<void> {
  let response: Response
  try {
    response = await fetch(`/api/catalog?source=public${refresh ? '&refresh=1' : ''}`, {
      headers: { Prefer: 'respond-async, orbit-progress=queued' }, signal: AbortSignal.any([signal, AbortSignal.timeout(150_000)]),
    })
  } catch (error) {
    if (signal.aborted) throw error
    throw new CatalogRequestError('공개 공고에 연결하지 못했어요. 연결 상태를 확인한 뒤 다시 조회해 주세요.')
  }
  let state = await read(response, true)
  signal.throwIfAborted()
  if (response.status !== 202) {
    await onUpdate(state.value, null)
    return
  }
  if (!state.progress) throw malformed()
  await onUpdate(state.value, state.progress)
  let delay = retryDelay(response)
  // Bound a stalled connection. Provider work may be shared with other tabs;
  // leaving this view cancels only this browser's requests, not their collection.
  const monitoring = AbortSignal.any([signal, AbortSignal.timeout(10 * 60_000)])
  try {
    while (state.progress && !state.progress.done) {
      await waitForProgress(delay, monitoring)
      // Build a fixed same-origin URL; never follow an arbitrary monitor URL
      // supplied in a payload or send filters, saved IDs, resumes or notes.
      const next = await fetch(`/api/catalog/progress?id=${encodeURIComponent(state.progress.id)}&after=${state.progress.revision}`, {
        cache: 'no-store', signal: AbortSignal.any([monitoring, AbortSignal.timeout(30_000)]),
      })
      monitoring.throwIfAborted()
      delay = retryDelay(next)
      if (next.status === 204) continue
      const updated = await read(next, false)
      monitoring.throwIfAborted()
      state = updated
      await onUpdate(state.value, state.progress)
    }
  } catch (error) {
    if (signal.aborted || error instanceof CatalogRequestError) throw error
    throw new CatalogRequestError('수집 진행 연결이 끊겼어요. 도착한 공고는 유지됩니다. 다시 조회해 이어서 확인해 주세요.')
  }
}

/** The same protocol is also usable without a browser worker, e.g. in HTTP contract tests. */
export function requestPublicCatalog({
  refresh, signal, onUpdate,
}: { refresh: boolean; signal: AbortSignal; onUpdate: (catalog: Catalog, progress: CatalogProgress | null) => void }): Promise<void> {
  return requestCatalogStream({ refresh, signal, read: createCatalogReader(), onUpdate })
}
