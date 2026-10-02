import { CatalogRequestError } from './catalog-request'
import type { CatalogRead } from './catalog-request'
import type { Catalog, Filters, Job, MatchedJob, Profile } from '../../shared/types'
import { CATALOG_PROJECTION_PROTOCOL } from './catalog-worker-types'
import type {
  CatalogProjection, CatalogProjectionPatch, CatalogReceipt, CatalogViewInput, CatalogWorkerCommand,
  CatalogWorkerResponse, CatalogWorkerResult, MatchFacts,
} from './catalog-worker-types'

const failure = () => new CatalogRequestError('공고 처리 연결이 끊겼어요. 도착한 공고와 저장 기록은 유지됩니다. 다시 조회해 주세요.', 'CATALOG_WORKER_FAILED')
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

function stringIds(value: unknown): value is string[] {
  if (!Array.isArray(value)) return false
  for (const id of value) if (typeof id !== 'string') return false
  return true
}

function reuseMetadata<T extends { id: string }>(next: T[], previous: T[] = []): T[] {
  const known = new Map(previous.map(value => [value.id, value]))
  const values = next.map(value => {
    const before = known.get(value.id)
    return before && JSON.stringify(before) === JSON.stringify(value) ? before : value
  })
  return values.length === previous.length && values.every((value, index) => value === previous[index]) ? previous : values
}

/** Only small inputs and changed jobs cross this boundary. Network access stays in the page. */
export class CatalogWorkerClient {
  private worker: Worker
  private nextId = 0
  private pending = new Map<number, {
    resolve: (result: CatalogWorkerResult) => void
    reject: (error: Error) => void
    timeout: ReturnType<typeof setTimeout>
  }>()
  private jobs = new Map<string, Job>()
  private facts = new Map<string, MatchFacts>()
  private matches = new Map<string, MatchedJob>()
  private metadata?: Omit<Catalog, 'jobs'>
  failed = false

  constructor(private onFailure: (error: CatalogRequestError) => void) {
    try {
      this.worker = new Worker(new URL('../workers/catalog.worker.ts', import.meta.url), { type: 'module', name: 'orbit-catalog' })
    } catch {
      throw failure()
    }
    this.worker.addEventListener('message', (event: MessageEvent<CatalogWorkerResponse>) => {
      const reply = event.data
      const waiting = this.pending.get(reply.id)
      if (!waiting) return
      this.pending.delete(reply.id)
      clearTimeout(waiting.timeout)
      if ('error' in reply) waiting.reject(new CatalogRequestError(reply.error.message, reply.error.code, reply.error.retryAt))
      else waiting.resolve(reply.result)
    })
    this.worker.addEventListener('error', this.crash)
    this.worker.addEventListener('messageerror', this.crash)
  }

  private crash = (event: Event) => {
    event.preventDefault()
    this.fail()
  }

  private fail(error = failure()): CatalogRequestError {
    if (!this.failed) {
      this.stop(error)
      this.onFailure(error)
    }
    return error
  }

  private stop(error: Error) {
    if (this.failed) return
    this.failed = true
    this.worker.terminate()
    for (const waiting of this.pending.values()) {
      clearTimeout(waiting.timeout)
      waiting.reject(error)
    }
    this.pending.clear()
  }

  dispose() {
    this.stop(new DOMException('공고 처리를 종료했어요.', 'AbortError'))
  }

  private call(command: CatalogWorkerCommand, transfer: Transferable[] = []): Promise<CatalogWorkerResult> {
    if (this.failed) return Promise.reject(failure())
    const id = ++this.nextId
    return new Promise((resolve, reject) => {
      // A stalled worker must not leave the app permanently in a pending state.
      const timeout = setTimeout(() => this.crash(new Event('error', { cancelable: true })), 150_000)
      this.pending.set(id, { resolve, reject, timeout })
      try { this.worker.postMessage({ id, command }, transfer) }
      catch { this.fail() }
    })
  }

  async read(response: Response, initial: boolean, stream: number, signal: AbortSignal): Promise<CatalogRead<CatalogReceipt>> {
    signal.throwIfAborted()
    const body = await response.arrayBuffer()
    signal.throwIfAborted()
    const result = await this.call({ kind: 'decode', stream, initial, status: response.status, body }, [body])
    signal.throwIfAborted()
    if (this.failed) throw failure()
    if (result.kind !== 'decoded') throw failure()
    return { value: result.value, progress: result.progress }
  }

  async project(revision: number, input: CatalogViewInput): Promise<CatalogProjection> {
    let result: CatalogWorkerResult
    try {
      result = await this.call({ kind: 'project', protocol: CATALOG_PROJECTION_PROTOCOL, revision, input })
    } catch (error) {
      // A pruned revision is a normal query result; only a protocol/worker failure ends the connection.
      if (error instanceof CatalogRequestError && error.code === 'CATALOG_WORKER_FAILED') throw this.fail(error)
      throw error
    }
    // Another reply may have failed after this Promise resolved but before it resumed.
    if (this.failed) throw failure()
    try {
      if (!result || result.kind !== 'projected') throw failure()
      // Hydrate even a superseded query reply: subsequent patches build on this delivery.
      return this.hydrate(result.value)
    } catch {
      // The hook can ignore an obsolete intent's error. Failure must be terminal inside this client.
      throw this.fail()
    }
  }

  acknowledge(revision: number) {
    if (this.failed) return
    // This notification carries no UI result and must not leave a pending query/timer behind.
    try { this.worker.postMessage({ id: 0, command: { kind: 'acknowledge', revision } }) }
    catch { this.crash(new Event('messageerror', { cancelable: true })) }
  }

  async preview(revision: number, profile: Profile, filters: Filters, now: number): Promise<number> {
    const result = await this.call({ kind: 'preview', revision, profile, filters, now })
    if (this.failed) throw failure()
    if (result.kind !== 'previewed') throw failure()
    return result.count
  }

  private preflight(patch: CatalogProjectionPatch) {
    if (!record(patch) || patch.protocol !== CATALOG_PROJECTION_PROTOCOL
      || !record(patch.catalog)
      || !Array.isArray(patch.catalog.companies) || !Array.isArray(patch.catalog.cities)
      || !Array.isArray(patch.jobs) || !Array.isArray(patch.staleUpdates) || !Array.isArray(patch.facts)
      || !Array.isArray(patch.cities) || !Array.isArray(patch.globeCities) || !Array.isArray(patch.deadlines)
      || !stringIds(patch.jobIds) || !stringIds(patch.removed) || !stringIds(patch.matchIds)
      || !stringIds(patch.remoteIds) || !stringIds(patch.unmappedIds)) throw failure()

    const currentIds = new Set(patch.jobIds)
    if (currentIds.size !== patch.jobIds.length) throw failure()
    const fullIds = new Set<string>()
    for (const job of patch.jobs) {
      if (!record(job) || typeof job.id !== 'string' || fullIds.has(job.id) || !currentIds.has(job.id)) throw failure()
      fullIds.add(job.id)
    }
    const removedIds = new Set<string>()
    for (const id of patch.removed) {
      if (removedIds.has(id) || fullIds.has(id) || currentIds.has(id)) throw failure()
      removedIds.add(id)
    }
    const staleIds = new Set<string>()
    for (const update of patch.staleUpdates) {
      if (!record(update) || typeof update.id !== 'string' || !Object.hasOwn(update, 'stale')
        || update.stale !== null && typeof update.stale !== 'boolean'
        || staleIds.has(update.id) || fullIds.has(update.id) || removedIds.has(update.id)
        || !this.jobs.has(update.id) || !currentIds.has(update.id)) throw failure()
      staleIds.add(update.id)
    }
    for (const fact of patch.facts) {
      if (!record(fact) || typeof fact.id !== 'string') throw failure()
    }
    for (const city of patch.cities) {
      if (!record(city) || typeof city.id !== 'string' || !stringIds(city.matchIds)) throw failure()
    }
  }

  private hydrate(patch: CatalogProjectionPatch): CatalogProjection {
    // Validate transport indexes and stale deltas against the pre-patch cache before any writes.
    this.preflight(patch)
    for (const id of patch.removed) {
      this.jobs.delete(id)
      this.facts.delete(id)
      this.matches.delete(id)
    }
    for (const job of patch.jobs) this.jobs.set(job.id, job)
    for (const update of patch.staleUpdates) {
      const previous = this.jobs.get(update.id)!
      const own = Object.hasOwn(previous, 'stale')
      if (update.stale === null ? !own : own && previous.stale === update.stale) continue
      const current = { ...previous }
      if (update.stale === null) delete current.stale
      else current.stale = update.stale
      this.jobs.set(update.id, current)
    }
    for (const fact of patch.facts) this.facts.set(fact.id, fact)
    const changedFacts = new Set(patch.facts.map(fact => fact.id))
    const metadata = {
      ...patch.catalog,
      companies: reuseMetadata(patch.catalog.companies, this.metadata?.companies),
      cities: reuseMetadata(patch.catalog.cities, this.metadata?.cities),
    }
    this.metadata = metadata
    const companies = new Map(metadata.companies.map(company => [company.id, company]))
    const cities = new Map(metadata.cities.map(city => [city.id, city]))
    const job = (id: string) => {
      const value = this.jobs.get(id)
      if (!value) throw failure()
      return value
    }
    const match = (id: string): MatchedJob => {
      const item = job(id)
      const company = companies.get(item.companyId)
      const fact = this.facts.get(id)
      if (!company || !fact) throw failure()
      const previous = this.matches.get(id)
      if (previous?.job === item && previous.company === company && !changedFacts.has(id)) return previous
      const { id: _id, ...details } = fact
      const value = { job: item, company, ...details }
      this.matches.set(id, value)
      return value
    }
    // Populate once; city and remote lists reuse references from the same query result.
    const matches = patch.matchIds.map(match)
    const selected = new Map(matches.map(item => [item.job.id, item]))
    const matchList = (ids: string[]) => ids.map(id => {
      const value = selected.get(id)
      if (!value) throw failure()
      return value
    })
    return {
      revision: patch.revision, catalog: { ...metadata, jobs: patch.jobIds.map(job) }, matches,
      cities: patch.cities.map(result => {
        const city = cities.get(result.id)
        if (!city) throw failure()
        return { city, matches: matchList(result.matchIds), companyCount: result.companyCount, averageScore: result.averageScore }
      }),
      remote: matchList(patch.remoteIds), unmapped: matchList(patch.unmappedIds),
      globeCities: patch.globeCities, companyCount: patch.companyCount, recovery: patch.recovery,
      expired: patch.expired, deadlines: patch.deadlines,
    }
  }
}
