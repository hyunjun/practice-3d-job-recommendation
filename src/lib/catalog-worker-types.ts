import type { CatalogProgress } from '../../shared/catalog-progress'
import type { SearchScope } from '../../shared/job-search'
import type { RecoveryAnalysis } from '../../shared/search-recovery'
import type { Catalog, CityResult, Filters, Job, MatchedJob, Profile } from '../../shared/types'
import type { GlobeCity } from './globe-cities'

/** Private Worker transport version, independent of the HTTP and saved-data formats. */
export const CATALOG_PROJECTION_PROTOCOL = 1

export interface CatalogViewInput {
  profile: Profile
  filters: Filters
  scope: SearchScope
  recover: boolean
  collecting: boolean
  now: number
}

export interface CatalogReceipt {
  revision: number
  deadlines: number[]
}

export type CatalogWorkerCommand =
  | { kind: 'decode'; stream: number; initial: boolean; status: number; body: ArrayBuffer }
  | { kind: 'project'; protocol: typeof CATALOG_PROJECTION_PROTOCOL; revision: number; input: CatalogViewInput }
  | { kind: 'preview'; revision: number; profile: Profile; filters: Filters; now: number }
  | { kind: 'acknowledge'; revision: number }

export interface MatchFacts extends Omit<MatchedJob, 'job' | 'company'> {
  id: string
}

/** Full bodies, removals and stale-only changes have disjoint IDs. */
export interface CatalogProjectionPatch {
  protocol: typeof CATALOG_PROJECTION_PROTOCOL
  revision: number
  catalog: Omit<Catalog, 'jobs'>
  jobIds: string[]
  jobs: Job[]
  removed: string[]
  staleUpdates: { id: string; stale: boolean | null }[]
  facts: MatchFacts[]
  matchIds: string[]
  cities: { id: string; matchIds: string[]; companyCount: number; averageScore: number }[]
  remoteIds: string[]
  unmappedIds: string[]
  companyCount: number
  recovery: RecoveryAnalysis | null
  globeCities: GlobeCity[]
  expired: boolean
  deadlines: number[]
}

export interface CatalogProjection {
  revision: number
  catalog: Catalog
  matches: MatchedJob[]
  cities: CityResult[]
  remote: MatchedJob[]
  unmapped: MatchedJob[]
  companyCount: number
  recovery: RecoveryAnalysis | null
  globeCities: GlobeCity[]
  expired: boolean
  deadlines: number[]
}

export type CatalogWorkerResult =
  | { kind: 'decoded'; value: CatalogReceipt; progress: CatalogProgress | null }
  | { kind: 'projected'; value: CatalogProjectionPatch }
  | { kind: 'previewed'; count: number }
  | { kind: 'acknowledged' }

export interface CatalogWorkerRequest {
  id: number
  command: CatalogWorkerCommand
}

export type CatalogWorkerResponse =
  | { id: number; result: CatalogWorkerResult }
  | { id: number; error: { message: string; code?: string; retryAt?: string } }
