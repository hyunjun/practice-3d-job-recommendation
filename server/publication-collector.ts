import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { PUBLIC_COMPANIES } from '../shared/companies'
import { PRIVATE_FILES, PRIVATE_FILE_LIMITS } from '../shared/publication'
import type { PrivateFile, PublicationContext } from '../shared/publication'
import type { Company, JobProvider } from '../shared/types'
import { belongsToBoard, CachedBoardSchema } from './board-cache'
import type { CachedBoard } from './board-cache'
import { fetchPublicBoard, fetchPublicPresence } from './catalog'
import { createObservationStore, HistoryFileSchema, observationScopeKey } from './catalog-observations'
import type { ObservationCheckpoint } from './catalog-observations'
import { createCatalogService } from './catalog-service'
import type { BoardResult, CatalogPublicationCapture } from './catalog-service'
import { CachedPresenceSchema } from './posting-presence'
import type { CachedPresence, PresenceResult } from './posting-presence'

export interface CollectorCheckpoint {
  boards: CachedBoard[]
  presence: CachedPresence[]
  observations: ObservationCheckpoint
}
export const publicationHash = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex')

export function publicationConfigurationId(companies: Company[]): string {
  if (!companies.length || companies.some(company => !company.board)
    || new Set(companies.map(company => company.id)).size !== companies.length) {
    throw new Error('Invalid publication company registry')
  }
  const identities = companies.map(company => [
    company.id, company.provider ?? 'greenhouse', company.board, company.boardRegion ?? '',
  ]).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right), 'en'))
  return publicationHash(JSON.stringify({ checkpointVersion: 1, boards: identities }))
}

/** A corrupt current checkpoint must never become an empty, apparently new run. */
export function restorePublicationCheckpoint(
  context: PublicationContext, files: Record<PrivateFile, Uint8Array>, now = Date.now(),
): CollectorCheckpoint {
  if (publicationConfigurationId(context.companies) !== context.configId) {
    throw new Error('Checkpoint registry does not match its configuration ID')
  }
  const values = Object.fromEntries(PRIVATE_FILES.map(name => {
    if (files[name].byteLength > PRIVATE_FILE_LIMITS[name]) throw new Error(`Checkpoint ${name} exceeds its size limit`)
    return [name, JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(files[name])) as unknown]
  }))
  const boards = z.object({ version: z.literal(5), boards: z.array(CachedBoardSchema).max(1000) }).strict().parse(values.boards).boards
  const presence = z.object({ version: z.literal(1), boards: z.array(CachedPresenceSchema).max(1000) }).strict().parse(values.presence).boards
  const observations = HistoryFileSchema.parse(values.observations)
  const companies = new Map(context.companies.map(company => [company.id, company]))
  for (const entries of [boards, presence]) {
    if (new Set(entries.map(entry => entry.companyId)).size !== entries.length) throw new Error('Duplicate checkpoint board')
    for (const entry of entries) {
      const company = companies.get(entry.companyId)
      if (!company || entry.board !== company.board || entry.provider !== (company.provider ?? 'greenhouse')
        || entry.boardRegion !== company.boardRegion || Date.parse(entry.checkedAt) > now + 5 * 60 * 1000
        || entry.snapshot && Date.parse(entry.snapshot.fetchedAt) > Date.parse(entry.checkedAt)) {
        throw new Error('Invalid checkpoint board identity or time')
      }
    }
  }
  if (boards.some(entry => entry.snapshot && (!belongsToBoard(entry.snapshot, companies.get(entry.companyId)!)
    || new Set(entry.snapshot.jobs.map(job => job.id)).size !== entry.snapshot.jobs.length))) {
    throw new Error('Invalid checkpoint job identity')
  }
  if (observations.series.some(series => observationScopeKey(series.scope.boards) !== series.scope.key
    || series.days.some(day => [day.latest, ...(day.complete ? [day.complete] : [])].some(attempt =>
      Date.parse(attempt.observedAt) > now || Date.parse(attempt.recordedAt) > now)))) {
    throw new Error('Invalid checkpoint observation scope or time')
  }
  return { boards, presence, observations }
}

export interface CollectionMetric {
  pass: 'inventory' | 'content'
  provider: JobProvider
  boards: number
  requests: number
  failedRequests: number
}
export interface PublicationCollection {
  capture: CatalogPublicationCapture
  metrics: CollectionMetric[]
}

/** Dedicated Node collector. Its HTTP getters are disabled by the service. */
export async function collectPublication({
  companies = PUBLIC_COMPANIES, checkpoint, now = Date.now, random = Math.random,
  fetchBoard = fetchPublicBoard, fetchPresence = fetchPublicPresence, measureHttp = false,
}: {
  companies?: Company[]
  checkpoint?: CollectorCheckpoint
  now?: () => number
  random?: () => number
  fetchBoard?: (company: Company, fetchedAt: string) => Promise<BoardResult>
  fetchPresence?: (company: Company, fetchedAt: string) => Promise<PresenceResult>
  /** Enable only in the exclusive CLI process, never a shared HTTP server. */
  measureHttp?: boolean
} = {}): Promise<PublicationCollection> {
  publicationConfigurationId(companies)
  const failures: unknown[] = []
  let boards = structuredClone(checkpoint?.boards ?? [])
  let presence = structuredClone(checkpoint?.presence ?? [])
  let observations: ObservationCheckpoint = structuredClone(checkpoint?.observations ?? { version: 1, series: [] })
  const metrics = new Map<string, CollectionMetric>()
  const context = new AsyncLocalStorage<CollectionMetric>()
  const collect = <T>(pass: CollectionMetric['pass'], company: Company, operation: () => Promise<T>) => {
    const provider = company.provider ?? 'greenhouse'
    const key = `${pass}:${provider}`
    const metric = metrics.get(key) ?? { pass, provider, boards: 0, requests: 0, failedRequests: 0 }
    metrics.set(key, metric)
    metric.boards++
    return context.run(metric, operation)
  }
  const originalFetch = globalThis.fetch
  if (measureHttp) {
    globalThis.fetch = async (...args) => {
      const metric = context.getStore()
      if (metric) metric.requests++
      try {
        const response = await originalFetch(...args)
        if (metric && !response.ok) metric.failedRequests++
        return response
      } catch (error) {
        if (metric) metric.failedRequests++
        throw error
      }
    }
  }
  try {
    const service = createCatalogService({
      companies, now, random, publicationMode: true,
      cache: { load: async () => boards, save: async value => { boards = structuredClone(value) } },
      fetchBoard: (company, fetchedAt) => collect('content', company, () => fetchBoard(company, fetchedAt)),
      presence: {
        cache: { load: async () => presence, save: async value => { presence = structuredClone(value) } },
        fetchBoard: (company, fetchedAt) => collect('inventory', company, () => fetchPresence(company, fetchedAt)),
      },
      observations: createObservationStore({
        companies, now, onError: error => { failures.push(error) },
        cache: {
          load: async () => observations,
          save: async value => { observations = structuredClone(value) },
        },
      }),
      onCacheError: error => { failures.push(error) },
    })
    const capture = await service.collectPublication()
    if (failures.length) throw new AggregateError(failures, 'Publication checkpoint could not be captured')
    return { capture, metrics: [...metrics.values()] }
  } finally {
    if (measureHttp) globalThis.fetch = originalFetch
    context.disable()
  }
}
