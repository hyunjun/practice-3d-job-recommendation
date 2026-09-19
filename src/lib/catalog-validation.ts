import { z } from 'zod'
import { isUnmappedJob } from '../../shared/job-location'
import { JobProviderSchema, JobSchema } from '../../shared/schemas'
import type { Catalog } from '../../shared/types'

const identifier = z.string().min(1).max(100)
const timestamp = z.string().refine(value => Number.isFinite(Date.parse(value)))
const count = z.int().nonnegative()
const company = z.object({
  id: identifier, name: z.string(), color: z.string(), initials: z.string(),
  industry: z.string(), careerUrl: z.string(), board: z.string().min(1).optional(),
  provider: JobProviderSchema.optional(), boardRegion: z.literal('eu').optional(),
})
const city = z.object({
  id: identifier, name: z.string(), en: z.string(), country: z.string(), countryCode: z.string(),
  region: z.enum(['americas', 'europe', 'asia-pacific']),
  lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180),
  timezone: z.string(), description: z.string(), image: z.string().optional(),
})
const board = z.object({
  companyId: identifier, board: z.string().min(1), provider: JobProviderSchema.optional(),
  status: z.enum(['ok', 'error', 'pending']), total: count, included: count,
  message: z.string().optional(), dataStatus: z.enum(['fresh', 'stale', 'unavailable']).optional(),
  checkedAt: timestamp.optional(), lastSuccessAt: timestamp.nullable().optional(), retryAt: timestamp.nullable().optional(),
})
const metadata = z.object({
  source: z.literal('public'), fetchedAt: z.union([timestamp, z.literal('')]), stale: z.boolean(),
  boards: z.array(board), unmappedCount: count.nullable(), checkedAt: timestamp.optional(), refreshAfter: timestamp.optional(),
})
const jobs = z.array(JobSchema.extend({ source: JobProviderSchema, fetchedAt: timestamp }))
const catalogSchema = metadata.extend({ companies: z.array(company), cities: z.array(city), jobs })

export const CatalogUpdateDataSchema = z.object({ catalog: metadata, companyIds: z.array(identifier), jobs })

/** Call after structural validation; deltas must be merged before checking counts. */
export function hasConsistentCatalog(catalog: Catalog, partial = false): boolean {
  if (catalog.fetchedAt === '' && (!partial || catalog.jobs.length !== 0)) return false
  const companies = new Map(catalog.companies.map(item => [item.id, item]))
  const cities = new Set(catalog.cities.map(item => item.id))
  const boards = new Map(catalog.boards.map(item => [item.companyId, item]))
  if (companies.size !== catalog.companies.length || cities.size !== catalog.cities.length
    || boards.size !== catalog.boards.length || boards.size !== companies.size) return false
  for (const item of catalog.boards) {
    const owner = companies.get(item.companyId)
    if (!owner || owner.board !== undefined && item.board !== owner.board
      || (item.provider ?? 'greenhouse') !== (owner.provider ?? 'greenhouse')
      || !partial && item.status === 'pending' || item.included > item.total) return false
  }
  const ids = new Set<string>()
  const included = new Map<string, number>()
  let unmapped = 0
  for (const job of catalog.jobs) {
    const owner = companies.get(job.companyId)
    const prefix = `${job.source}-${job.companyId}-`
    if (!owner || job.source !== (owner.provider ?? 'greenhouse') || !job.id.startsWith(prefix) || job.id.length === prefix.length
      || ids.has(job.id) || job.cityIds.some(id => !cities.has(id)) || boards.get(job.companyId)?.dataStatus === 'unavailable') return false
    ids.add(job.id)
    included.set(job.companyId, (included.get(job.companyId) ?? 0) + 1)
    if (isUnmappedJob(job)) unmapped++
  }
  // Older snapshots may also count jobs they omitted, or have an unknown count.
  return (catalog.unmappedCount === null || catalog.unmappedCount >= unmapped)
    && catalog.boards.every(item => item.included === (included.get(item.companyId) ?? 0))
}

export function isPublicCatalog(value: unknown, partial = false): value is Catalog {
  // Validation only: no coercions, defaults or transforms. Keep the original data,
  // including additive fields and optional legacy versions, for the upgrade step.
  return catalogSchema.validate(value) && hasConsistentCatalog(value, partial)
}
