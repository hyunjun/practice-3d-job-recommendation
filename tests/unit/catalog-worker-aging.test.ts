import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CatalogWorkerModel } from '../../src/lib/catalog-worker-model'
import { CATALOG_PROJECTION_PROTOCOL } from '../../src/lib/catalog-worker-types'
import type { CatalogProjectionPatch, CatalogViewInput } from '../../src/lib/catalog-worker-types'
import { CATALOG_WORKER_FILTERS, CATALOG_WORKER_PROFILE, catalogWorkerCatalog } from '../fixtures/catalog-worker'

// Stage79 design docs/design/catalog-worker-aging.md (SHA-256 2fc0192c…): a job whose body
// fields are unchanged must not cross the Worker boundary again when only its own freshness
// state changes (WAGE2), nor when another company's deadline passes later (WAGE1).
//
// Permanent regression checks. They use the pre-stage request shape and the existing `jobs`
// field only, so they also serve as the baseline reproduction before any product change:
// on the unchanged baseline the two body assertions are expected to fail with the fixture
// IDs shown in their diffs, while the initial/fresh sanity checks pass. After the fix only
// the request envelope may change; the body expectations and fixture semantics stay.
//
// Observation method: the genuine CatalogWorkerModel reply, structuredClone'd in-process the
// way a Worker reply is cloned. This is a unit observation, not a browser Worker-thread,
// clone-byte or timing measurement. Expected IDs/times/counts are authored fixture facts.

const noNetwork = vi.fn(async () => { throw new Error('Worker unit verification must not contact a server.') })
beforeEach(() => { noNetwork.mockClear(); vi.stubGlobal('fetch', noNetwork) })
afterEach(() => { expect(noNetwork).not.toHaveBeenCalled(); vi.unstubAllGlobals() })

// Fixture snapshot times are 08:00:00 (Aster), 08:00:01 (Birch), 08:00:02 (Cedar); ordinary
// sources turn stale exactly 30 minutes later, so each company has its own boundary.
const INITIAL = '2026-09-24T08:00:03.000Z'
const STILL_FRESH = '2026-09-24T08:29:59.999Z'
const ASTER_STALE = '2026-09-24T08:30:00.000Z'
const BIRCH_STALE = '2026-09-24T08:30:01.000Z'

/** Fixture job IDs in catalog order (tests/fixtures/catalog-worker.ts arrivals). */
const FIXTURE_JOB_IDS = [
  'greenhouse-catalog-worker-aster-atlas', 'greenhouse-catalog-worker-aster-berlin', 'greenhouse-catalog-worker-aster-remote-uk',
  'greenhouse-catalog-worker-birch-london', 'greenhouse-catalog-worker-birch-berlin', 'greenhouse-catalog-worker-birch-canvas',
  'greenhouse-catalog-worker-cedar-london', 'greenhouse-catalog-worker-cedar-berlin', 'greenhouse-catalog-worker-cedar-remote-us',
]
const ASTER_JOB_IDS = FIXTURE_JOB_IDS.slice(0, 3)

const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).buffer
/** Default input semantics of tests/unit/catalog-worker.test.ts with an explicit main-thread time. */
const input = (time: string): CatalogViewInput => ({
  profile: CATALOG_WORKER_PROFILE, filters: CATALOG_WORKER_FILTERS,
  scope: { kind: 'cities' }, recover: true, collecting: false, now: Date.parse(time),
})

async function decodedModel(): Promise<CatalogWorkerModel> {
  const model = new CatalogWorkerModel()
  const result = await model.handle({ kind: 'decode', stream: 1, initial: true, status: 200, body: bytes(catalogWorkerCatalog()) })
  if (result.kind !== 'decoded') throw new Error('Expected a decoded catalog receipt.')
  return model
}

/**
 * Project revision 1 at the given time and observe a structured clone of the genuine reply.
 * Protocol envelope only: the historical baseline runs (20261001T132620019962Z-ec749fc5 and
 * 20261001T135004409556Z-5efa1959) used the pre-stage request shape without `protocol`; the
 * required field was added afterwards. Body assertions and fixture semantics are unchanged.
 */
async function projectAt(model: CatalogWorkerModel, time: string): Promise<CatalogProjectionPatch> {
  const result = await model.handle({ kind: 'project', protocol: CATALOG_PROJECTION_PROTOCOL, revision: 1, input: input(time) })
  if (result.kind !== 'projected') throw new Error('Expected a catalog projection.')
  return structuredClone(result.value)
}

/** IDs of the full job bodies in a patch. Distinct from `jobIds`, the complete live membership. */
const bodyIds = (patch: CatalogProjectionPatch) => patch.jobs.map(job => job.id)

describe('catalog worker aging: full job bodies at staggered stale boundaries', () => {
  it("a company's first fresh-to-stale boundary sends zero full job bodies (WAGE2)", async () => {
    const model = await decodedModel()
    const initial = await projectAt(model, INITIAL)
    expect(bodyIds(initial)).toEqual(FIXTURE_JOB_IDS)
    expect(initial.jobIds).toEqual(FIXTURE_JOB_IDS)
    expect(initial.removed).toEqual([])
    expect(initial.catalog.stale).toBe(false)
    expect(initial.catalog.boards.map(board => board.dataStatus)).toEqual(['fresh', 'fresh', 'fresh'])

    const stillFresh = await projectAt(model, STILL_FRESH)
    expect(bodyIds(stillFresh)).toEqual([])
    expect(stillFresh.removed).toEqual([])

    const asterStale = await projectAt(model, ASTER_STALE)
    // The visible truth of this boundary is unchanged by the transport contract.
    expect(asterStale.catalog.boards.map(board => board.dataStatus)).toEqual(['stale', 'fresh', 'fresh'])
    expect(asterStale.catalog.stale).toBe(true)
    expect(asterStale.jobIds).toEqual(FIXTURE_JOB_IDS)
    expect(asterStale.removed).toEqual([])
    expect(asterStale.expired).toBe(false)
    // Aster's three bodies were delivered at INITIAL; only their stale state changed here.
    expect(bodyIds(asterStale), `Full bodies at Aster's first stale boundary. Observed ${
      JSON.stringify({ asterBoundaryBodyIds: bodyIds(asterStale) })}`).toEqual([])
  })

  it("another company's later stale boundary resends no already-stale body and zero full bodies overall (WAGE1)", async () => {
    const model = await decodedModel()
    const initial = await projectAt(model, INITIAL)
    expect(bodyIds(initial)).toEqual(FIXTURE_JOB_IDS)

    // Pass Aster's own boundary without asserting its transfer; the first test owns that check.
    // Its observation is kept only as diagnostic context for the Birch boundary below.
    const asterStale = await projectAt(model, ASTER_STALE)
    expect(asterStale.catalog.boards.map(board => board.dataStatus)).toEqual(['stale', 'fresh', 'fresh'])

    const birchStale = await projectAt(model, BIRCH_STALE)
    expect(birchStale.catalog.boards.map(board => board.dataStatus)).toEqual(['stale', 'stale', 'fresh'])
    // Aster remains a live, already-stale member; only its redundant body must be absent.
    expect(birchStale.jobIds).toEqual(FIXTURE_JOB_IDS)
    expect(birchStale.removed).toEqual([])
    expect(birchStale.expired).toBe(false)
    const observed = { asterBoundaryBodyIds: bodyIds(asterStale), birchBoundaryBodyIds: bodyIds(birchStale) }
    expect.soft(bodyIds(birchStale).filter(id => ASTER_JOB_IDS.includes(id)),
      `Already-stale Aster bodies must not cross again at Birch's boundary (WAGE1). Observed ${JSON.stringify(observed)}`).toEqual([])
    expect(bodyIds(birchStale),
      `Zero full bodies at a flag-only boundary (final contract). Observed ${JSON.stringify(observed)}`).toEqual([])
  })
})
