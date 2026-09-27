import { CatalogRequestError } from './catalog-request'
import type { CatalogRead } from './catalog-request'
import type { Catalog, Filters, Job, MatchedJob, Profile } from '../../shared/types'
import type {
  CatalogProjection, CatalogProjectionPatch, CatalogReceipt, CatalogViewInput, CatalogWorkerCommand,
  CatalogWorkerResponse, CatalogWorkerResult, MatchFacts,
} from './catalog-worker-types'

const failure = () => new CatalogRequestError('공고 처리 연결이 끊겼어요. 도착한 공고와 저장 기록은 유지됩니다. 다시 조회해 주세요.', 'CATALOG_WORKER_FAILED')

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
    if (this.failed) return
    const error = failure()
    this.stop(error)
    this.onFailure(error)
  }

  private stop(error: Error) {
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
      catch {
        clearTimeout(timeout)
        this.pending.delete(id)
        reject(failure())
        this.crash(new Event('messageerror', { cancelable: true }))
      }
    })
  }

  async read(response: Response, initial: boolean, stream: number, signal: AbortSignal): Promise<CatalogRead<CatalogReceipt>> {
    signal.throwIfAborted()
    const body = await response.arrayBuffer()
    signal.throwIfAborted()
    const result = await this.call({ kind: 'decode', stream, initial, status: response.status, body }, [body])
    signal.throwIfAborted()
    if (result.kind !== 'decoded') throw failure()
    return { value: result.value, progress: result.progress }
  }

  async project(revision: number, input: CatalogViewInput): Promise<CatalogProjection> {
    const result = await this.call({ kind: 'project', revision, input })
    if (result.kind !== 'projected') throw failure()
    // Hydrate even a superseded query reply: subsequent patches build on this delivery.
    return this.hydrate(result.value)
  }

  acknowledge(revision: number) {
    if (this.failed) return
    // This notification carries no UI result and must not leave a pending query/timer behind.
    try { this.worker.postMessage({ id: 0, command: { kind: 'acknowledge', revision } }) }
    catch { this.crash(new Event('messageerror', { cancelable: true })) }
  }

  async preview(revision: number, profile: Profile, filters: Filters, now: number): Promise<number> {
    const result = await this.call({ kind: 'preview', revision, profile, filters, now })
    if (result.kind !== 'previewed') throw failure()
    return result.count
  }

  private hydrate(patch: CatalogProjectionPatch): CatalogProjection {
    for (const id of patch.removed) {
      this.jobs.delete(id)
      this.facts.delete(id)
      this.matches.delete(id)
    }
    for (const job of patch.jobs) this.jobs.set(job.id, job)
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
