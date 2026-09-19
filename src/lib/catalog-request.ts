import { applyCatalogUpdate } from '../../shared/catalog-progress'
import type { CatalogCollectionSnapshot, CatalogCollectionUpdate, CatalogProgress } from '../../shared/catalog-progress'
import type { Catalog } from '../../shared/types'

export class CatalogRequestError extends Error {
  constructor(message: string, readonly code?: string, readonly retryAt?: string) { super(message) }
}

const malformed = () => new CatalogRequestError('공고 데이터 형식을 확인하지 못했어요. 다시 조회해 주세요.')
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const date = (value: unknown) => typeof value === 'string' && Number.isFinite(Date.parse(value))

function readCatalog(value: unknown, partial = false): Catalog {
  if (!record(value) || value.source !== 'public' || !['jobs', 'companies', 'cities', 'boards'].every(key => Array.isArray(value[key]))
    || !(date(value.fetchedAt) || partial && value.fetchedAt === '' && (value.jobs as unknown[]).length === 0)) throw malformed()
  return value as unknown as Catalog
}

function readProgress(value: unknown, catalog: Catalog): CatalogProgress {
  if (!record(value) || typeof value.id !== 'string' || !/^[a-f0-9-]{36}$/i.test(value.id)
    || !Number.isSafeInteger(value.revision) || (value.revision as number) < 0
    || !Number.isSafeInteger(value.total) || (value.total as number) < 1 || (value.total as number) > catalog.companies.length
    || !Number.isSafeInteger(value.completed) || (value.completed as number) < 0 || (value.completed as number) > (value.total as number)
    || typeof value.done !== 'boolean' || value.done && value.completed !== value.total
    || catalog.boards.filter(board => board.status === 'pending').length !== (value.total as number) - (value.completed as number)) throw malformed()
  return value as unknown as CatalogProgress
}

function readSnapshot(value: unknown): CatalogCollectionSnapshot {
  if (!record(value)) throw malformed()
  const catalog = readCatalog(value.catalog, true)
  const progress = readProgress(value.progress, catalog)
  if (progress.done) throw malformed()
  return { catalog, progress }
}

function readUpdate(value: unknown, previous: CatalogCollectionSnapshot): CatalogCollectionUpdate {
  if (!record(value) || !record(value.catalog) || !Array.isArray(value.jobs) || !Array.isArray(value.companyIds)) throw malformed()
  const catalog = readCatalog({ ...value.catalog, jobs: value.jobs, companies: previous.catalog.companies, cities: previous.catalog.cities }, true)
  const progress = readProgress(value.progress, catalog)
  const companies = new Map(previous.catalog.companies.map(company => [company.id, company]))
  const replaced = new Set(value.companyIds)
  const previousBoards = new Map(previous.catalog.boards.map(board => [board.companyId, board]))
  if (progress.id !== previous.progress.id || progress.total !== previous.progress.total || progress.completed < previous.progress.completed
    || progress.revision < previous.progress.revision || progress.revision === previous.progress.revision && !progress.done
    || replaced.size !== value.companyIds.length || value.companyIds.some(id => typeof id !== 'string' || !companies.has(id))
    || catalog.boards.length !== previous.catalog.boards.length || new Set(catalog.boards.map(board => board.companyId)).size !== catalog.boards.length
    || catalog.boards.some(board => {
      const prior = previousBoards.get(board.companyId)
      return !prior || board.board !== prior.board || board.provider !== prior.provider
        || prior.status === 'pending' && board.status !== 'pending' && !replaced.has(board.companyId)
    })
    || catalog.jobs.some(job => !record(job) || typeof job.id !== 'string' || !replaced.has(job.companyId)
      || job.source !== (companies.get(job.companyId)?.provider ?? 'greenhouse')
      || !job.id.startsWith(`${job.source}-${job.companyId}-`) || !date(job.fetchedAt))
    || new Set(catalog.jobs.map(job => job.id)).size !== catalog.jobs.length) throw malformed()
  const { companies: _companies, cities: _cities, jobs, ...metadata } = catalog
  return { progress, companyIds: value.companyIds as string[], jobs, catalog: metadata }
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

/** Poll only an explicitly requested, shared collection. No profile or job IDs leave the browser. */
export async function requestPublicCatalog({
  refresh, signal, onUpdate,
}: { refresh: boolean; signal: AbortSignal; onUpdate: (catalog: Catalog, progress: CatalogProgress | null) => void }): Promise<void> {
  let response: Response
  try {
    response = await fetch(`/api/catalog?source=public${refresh ? '&refresh=1' : ''}`, {
      headers: { Prefer: 'respond-async' }, signal: AbortSignal.any([signal, AbortSignal.timeout(150_000)]),
    })
  } catch (error) {
    if (signal.aborted) throw error
    throw new CatalogRequestError('공개 공고에 연결하지 못했어요. 연결 상태를 확인한 뒤 다시 조회해 주세요.')
  }
  const result = await readResponse(response)
  signal.throwIfAborted()
  if (response.status !== 202) {
    onUpdate(readCatalog(result), null)
    return
  }
  let state = readSnapshot(result)
  onUpdate(state.catalog, state.progress)
  let delay = retryDelay(response)
  // Bound a stalled connection. Provider work may be shared with other tabs;
  // leaving this view cancels only this browser's requests, not their collection.
  const monitoring = AbortSignal.any([signal, AbortSignal.timeout(10 * 60_000)])
  try {
    while (!state.progress.done) {
      await waitForProgress(delay, monitoring)
      // Build a fixed same-origin URL; never follow an arbitrary monitor URL
      // supplied in a payload or send filters, saved IDs, resumes or notes.
      const next = await fetch(`/api/catalog/progress?id=${encodeURIComponent(state.progress.id)}&after=${state.progress.revision}`, {
        cache: 'no-store', signal: AbortSignal.any([monitoring, AbortSignal.timeout(30_000)]),
      })
      monitoring.throwIfAborted()
      delay = retryDelay(next)
      if (next.status === 204) continue
      const update = readUpdate(await readResponse(next), state)
      monitoring.throwIfAborted()
      state = { catalog: applyCatalogUpdate(state.catalog, update), progress: update.progress }
      onUpdate(state.catalog, state.progress)
    }
  } catch (error) {
    if (signal.aborted || error instanceof CatalogRequestError) throw error
    throw new CatalogRequestError('수집 진행 연결이 끊겼어요. 도착한 공고는 유지됩니다. 다시 조회해 이어서 확인해 주세요.')
  }
}
