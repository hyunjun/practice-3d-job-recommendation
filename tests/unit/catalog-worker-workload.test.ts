import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CatalogWorkerClient } from '../../src/lib/catalog-worker-client'
import type { CatalogProjectionPatch, CatalogViewInput } from '../../src/lib/catalog-worker-types'
import { isPublicCatalog } from '../../src/lib/catalog-validation'
import { CATALOG_WORKER_FILTERS, CATALOG_WORKER_PROFILE } from '../fixtures/catalog-worker'
import {
  WORKLOAD_BODIES, WORKLOAD_COMPANIES, WORKLOAD_DESCRIPTION_CHARS, WORKLOAD_EXACT_24H, WORKLOAD_FRESH_NOW,
  WORKLOAD_JOBS_PER_COMPANY, agingWorkloadCatalog, workloadCompanyIds, workloadExpiryAt, workloadStaleAt,
} from '../fixtures/catalog-worker-aging'
import { CatalogWorkerDouble, installCatalogWorkerDouble, projectedReplies } from './helpers/catalog-worker-double'

// Stage79 contract item 7: a synthetic staggered workload observed through the client and the
// in-process double. The description-length sums are a deterministic structural proxy for the
// bodies that crossed the boundary. They are NOT physical structured-clone bytes, heap, HTTP
// bandwidth or timing, and no duration is a pass criterion. isPublicCatalog is called only as a
// precondition on the fixture, never to compute an expected value.

const noNetwork = vi.fn(async () => { throw new Error('Worker unit verification must not contact a server.') })
beforeEach(() => { noNetwork.mockClear(); vi.stubGlobal('fetch', noNetwork); installCatalogWorkerDouble() })
afterEach(() => { expect(noNetwork).not.toHaveBeenCalled(); vi.unstubAllGlobals() })

const input = (now: number): CatalogViewInput => ({
  profile: CATALOG_WORKER_PROFILE, filters: CATALOG_WORKER_FILTERS, scope: { kind: 'cities' },
  recover: true, collecting: false, now,
})
const bodyIds = (patch: CatalogProjectionPatch) => patch.jobs.map(job => job.id)
const bodyChars = (patch: CatalogProjectionPatch) => patch.jobs.reduce((sum, job) => sum + job.description.length, 0)
const totals = (patches: CatalogProjectionPatch[]) => ({
  bodies: patches.reduce((sum, patch) => sum + patch.jobs.length, 0),
  chars: patches.reduce((sum, patch) => sum + bodyChars(patch), 0),
})
/**
 * Test-owned enumeration of the complete fixture order: company 01..30, job 01..20 within each
 * company. Initial, restored and reversed outputs are compared with this declared sequence rather
 * than with one another, so a mutually consistent wrong order is detected.
 */
const WORKLOAD_ORDER = Array.from({ length: WORKLOAD_COMPANIES }, (_, index) => workloadCompanyIds(index + 1)).flat()

describe('synthetic staggered workload: 30 companies x 20 jobs x 20,000-character fictional descriptions', () => {
  it('sends every body once in the fixture order across all forward boundaries, restores removed bodies once, then reverses flags without bodies', async () => {
    const catalog = agingWorkloadCatalog()
    expect(WORKLOAD_ORDER).toHaveLength(WORKLOAD_BODIES)
    expect(new Set(WORKLOAD_ORDER).size).toBe(WORKLOAD_BODIES)
    expect(catalog.jobs).toHaveLength(WORKLOAD_BODIES)
    expect(catalog.jobs.every(job => job.description.length === 20_000)).toBe(true)
    expect(isPublicCatalog(catalog)).toBe(true)

    const client = new CatalogWorkerClient(vi.fn())
    const double = CatalogWorkerDouble.instances.at(-1)!
    try {
      const receipt = await client.read(Response.json(catalog), true, 1, new AbortController().signal)
      expect(receipt.value.deadlines).toHaveLength(2 * WORKLOAD_COMPANIES)

      // Segment A: monotonic forward aging.
      await client.project(1, input(WORKLOAD_FRESH_NOW))
      const initial = projectedReplies(double).at(-1)!
      expect(bodyIds(initial)).toEqual(WORKLOAD_ORDER)
      expect(initial.jobIds).toEqual(WORKLOAD_ORDER)
      expect(bodyChars(initial)).toBe(WORKLOAD_DESCRIPTION_CHARS)
      expect(initial.staleUpdates).toEqual([])

      for (let company = 1; company <= WORKLOAD_COMPANIES; company++) {
        await client.project(1, input(workloadStaleAt(company)))
        const patch = projectedReplies(double).at(-1)!
        expect(bodyIds(patch), `stale boundary ${company}`).toEqual([])
        expect(patch.staleUpdates, `stale boundary ${company}`).toEqual(workloadCompanyIds(company).map(id => ({ id, stale: true })))
        expect(patch.removed).toEqual([])
        expect(patch.jobIds).toEqual(WORKLOAD_ORDER)
      }

      await client.project(1, input(WORKLOAD_EXACT_24H))
      const exact = projectedReplies(double).at(-1)!
      expect(bodyIds(exact)).toEqual([])
      expect(exact.staleUpdates).toEqual([])
      expect(exact.removed).toEqual([])
      expect(exact.jobIds).toEqual(WORKLOAD_ORDER)

      for (let company = 1; company <= WORKLOAD_COMPANIES; company++) {
        await client.project(1, input(workloadExpiryAt(company)))
        const patch = projectedReplies(double).at(-1)!
        expect(bodyIds(patch), `expiry boundary ${company}`).toEqual([])
        expect(patch.staleUpdates).toEqual([])
        expect(patch.removed, `expiry boundary ${company}`).toEqual(workloadCompanyIds(company))
        expect(patch.jobIds, `expiry boundary ${company}`).toEqual(WORKLOAD_ORDER.slice(company * WORKLOAD_JOBS_PER_COMPANY))
      }
      const last = projectedReplies(double).at(-1)!
      expect(last.expired).toBe(true)
      expect(last.jobIds).toEqual([])

      const forward = totals(projectedReplies(double))
      expect(forward).toEqual({ bodies: WORKLOAD_BODIES, chars: WORKLOAD_DESCRIPTION_CHARS })

      // Segment B: restoration after total expiry is reported separately and legitimately resends bodies.
      const forwardReplies = projectedReplies(double).length
      await client.project(1, input(WORKLOAD_EXACT_24H))
      const restored = projectedReplies(double).at(-1)!
      expect(bodyIds(restored)).toEqual(WORKLOAD_ORDER)
      expect(restored.jobIds).toEqual(WORKLOAD_ORDER)
      expect(restored.jobs.every(job => job.stale === true)).toBe(true)
      expect(bodyChars(restored)).toBe(WORKLOAD_DESCRIPTION_CHARS)
      expect(restored.staleUpdates).toEqual([])
      expect(restored.removed).toEqual([])

      // A reversal from alive-stale to fresh is flag-only, in the declared fixture order.
      await client.project(1, input(WORKLOAD_FRESH_NOW))
      const fresh = projectedReplies(double).at(-1)!
      expect(bodyIds(fresh)).toEqual([])
      expect(fresh.staleUpdates).toEqual(WORKLOAD_ORDER.map(id => ({ id, stale: false })))
      expect(fresh.jobIds).toEqual(WORKLOAD_ORDER)
      expect(fresh.removed).toEqual([])

      const restoration = totals(projectedReplies(double).slice(forwardReplies))
      expect(restoration).toEqual({ bodies: WORKLOAD_BODIES, chars: WORKLOAD_DESCRIPTION_CHARS })
    } finally { client.dispose() }
  }, 120_000)
})
