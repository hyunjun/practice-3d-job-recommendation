import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CatalogWorkerModel } from '../../src/lib/catalog-worker-model'
import { CATALOG_PROJECTION_PROTOCOL } from '../../src/lib/catalog-worker-types'
import type { CatalogProjectionPatch, CatalogViewInput, CatalogWorkerCommand } from '../../src/lib/catalog-worker-types'
import type { Filters } from '../../shared/types'
import {
  CATALOG_WORKER_FILTERS, CATALOG_WORKER_PROFILE, CATALOG_WORKER_REVISED_TIME, CATALOG_WORKER_TIME,
  catalogWorkerCatalog, catalogWorkerEmpty, catalogWorkerRevised, catalogWorkerSnapshot, catalogWorkerUpdate,
} from '../fixtures/catalog-worker'
import {
  AGING_AT, AGING_DAILY_AT, AGING_DAILY_ID, AGING_DEADLINES, AGING_FRESH_NOW, AGING_JOB_IDS, AGING_MATCH_IDS,
  AGING_REVISED_TITLE, AGING_SURVIVOR_MATCHES_AFTER_ASTER, AGING_SURVIVOR_MATCHES_AFTER_BIRCH, ASTER_IDS, BIRCH_IDS, CEDAR_IDS,
  agingCatalogLevelStaleCatalog, agingCurrentCatalog, agingCurrentSnapshot, agingDailyCatalog, agingErrorBoardCatalog,
  agingLegacySnapshot, agingMetadataUpdate, agingReplacementUpdate, withoutStaleKeys,
} from '../fixtures/catalog-worker-aging'

// Stage79 contract docs/design/catalog-worker-aging.md (SHA-256 2fc0192c…), independent verification
// items 1-6 and the fixed-fixture LIMIT-MARKER observations of item 7 / lines 88-92.
//
// Observation method: the genuine CatalogWorkerModel reply, structured-cloned in-process the way a
// Worker reply is cloned. Not a browser Worker thread, clone-byte or timing measurement. Expected
// IDs, order, times, flags and counts are authored fixture literals; no product function computes
// an expected value. bodyIds are the IDs of full records in patch.jobs; jobIds is the complete live
// membership and legitimately keeps already-stale jobs.

const noNetwork = vi.fn(async () => { throw new Error('Worker unit verification must not contact a server.') })
beforeEach(() => { noNetwork.mockClear(); vi.stubGlobal('fetch', noNetwork) })
afterEach(() => { expect(noNetwork).not.toHaveBeenCalled(); vi.unstubAllGlobals() })

const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).buffer
const at = (time: string) => Date.parse(time)
const input = (time: string, changes: Partial<CatalogViewInput> = {}, filters: Partial<Filters> = {}): CatalogViewInput => ({
  profile: CATALOG_WORKER_PROFILE, filters: { ...CATALOG_WORKER_FILTERS, ...filters },
  scope: { kind: 'cities' }, recover: true, collecting: false, now: at(time), ...changes,
})

async function decode(model: CatalogWorkerModel, value: unknown, { initial = true, stream = 1, status = 200 } = {}) {
  const result = await model.handle({ kind: 'decode', stream, initial, status, body: bytes(value) })
  if (result.kind !== 'decoded') throw new Error('Expected a decoded catalog receipt.')
  return result
}

async function project(model: CatalogWorkerModel, revision: number, time: string, changes: Partial<CatalogViewInput> = {}, filters: Partial<Filters> = {}): Promise<CatalogProjectionPatch> {
  const result = await model.handle({ kind: 'project', protocol: CATALOG_PROJECTION_PROTOCOL, revision, input: input(time, changes, filters) })
  if (result.kind !== 'projected') throw new Error('Expected a catalog projection.')
  return structuredClone(result.value)
}

const bodyIds = (patch: CatalogProjectionPatch) => patch.jobs.map(job => job.id)
const boards = (patch: CatalogProjectionPatch) => patch.catalog.boards.map(board => board.dataStatus)
const flags = (ids: string[], stale: boolean | null) => ids.map(id => ({ id, stale }))
const sortedFactIds = (patch: CatalogProjectionPatch) => patch.facts.map(fact => fact.id).sort()
const sorted = (ids: string[]) => [...ids].sort()

const NOTHING = { jobs: [], removed: [], staleUpdates: [] }

describe('aging transport: sequential stale boundaries (contract items 1, 5)', () => {
  it('A then B then C stale boundaries send no body and exactly the affected flags in jobIds order', async () => {
    const model = new CatalogWorkerModel()
    await decode(model, catalogWorkerCatalog())
    const initial = await project(model, 1, AGING_FRESH_NOW)
    expect(initial.protocol).toBe(1)
    expect(bodyIds(initial)).toEqual(AGING_JOB_IDS)
    expect(initial.jobIds).toEqual(AGING_JOB_IDS)
    expect(initial.staleUpdates).toEqual([])
    expect(initial.removed).toEqual([])
    expect(initial.catalog.stale).toBe(false)
    expect(boards(initial)).toEqual(['fresh', 'fresh', 'fresh'])
    expect(initial.deadlines).toEqual(AGING_DEADLINES)

    const stillFresh = await project(model, 1, AGING_AT.stillFresh)
    expect(stillFresh).toMatchObject(NOTHING)

    const asterStale = await project(model, 1, AGING_AT.asterStale)
    expect(bodyIds(asterStale)).toEqual([])
    expect(asterStale.staleUpdates).toEqual(flags(ASTER_IDS, true))
    expect(asterStale.removed).toEqual([])
    expect(asterStale.jobIds).toEqual(AGING_JOB_IDS)
    expect(asterStale.catalog.stale).toBe(true)
    expect(boards(asterStale)).toEqual(['stale', 'fresh', 'fresh'])
    expect(asterStale.expired).toBe(false)
    expect(sorted(asterStale.matchIds)).toEqual(sorted(AGING_MATCH_IDS))

    const birchStale = await project(model, 1, AGING_AT.birchStale)
    expect(bodyIds(birchStale)).toEqual([])
    expect(birchStale.staleUpdates).toEqual(flags(BIRCH_IDS, true))
    // Aster stays a live member; only its redundant body and flag are absent.
    expect(birchStale.jobIds).toEqual(AGING_JOB_IDS)
    expect(boards(birchStale)).toEqual(['stale', 'stale', 'fresh'])

    const cedarStale = await project(model, 1, AGING_AT.cedarStale)
    expect(bodyIds(cedarStale)).toEqual([])
    expect(cedarStale.staleUpdates).toEqual(flags(CEDAR_IDS, true))
    expect(boards(cedarStale)).toEqual(['stale', 'stale', 'stale'])
    expect(cedarStale.catalog.unmappedCount).toBe(0)
  })

  it('identical repeats, time inside one boundary and query changes send no body, flag or removal', async () => {
    const model = new CatalogWorkerModel()
    await decode(model, catalogWorkerCatalog())
    await project(model, 1, AGING_FRESH_NOW)
    expect(await project(model, 1, AGING_FRESH_NOW)).toMatchObject({ ...NOTHING, facts: [] })
    expect(await project(model, 1, '2026-09-24T08:00:04.000Z')).toMatchObject({ ...NOTHING, facts: [] })
    const london = await project(model, 1, AGING_FRESH_NOW, {}, { query: 'Beacon London', role: 'backend' })
    expect(london).toMatchObject({ ...NOTHING, facts: [] })
    expect(london.matchIds).toEqual(['greenhouse-catalog-worker-cedar-london', 'greenhouse-catalog-worker-birch-london'])
    await project(model, 1, AGING_AT.asterStale)
    expect(await project(model, 1, AGING_AT.asterStale)).toMatchObject({ ...NOTHING, facts: [] })
    expect(await project(model, 1, '2026-09-24T08:30:00.700Z', {}, { query: 'Atlas Alpha' })).toMatchObject({ ...NOTHING, facts: [] })
  })
})

describe('aging transport: expiry and reverse time (contract item 2)', () => {
  it('keeps every job at exactly 24 hours and removes exactly one company per +1 ms boundary without bodies or flags', async () => {
    const model = new CatalogWorkerModel()
    await decode(model, catalogWorkerCatalog())
    await project(model, 1, AGING_FRESH_NOW)
    await project(model, 1, AGING_AT.cedarStale)

    const exact = await project(model, 1, AGING_AT.asterExactly24h)
    expect(exact).toMatchObject(NOTHING)
    expect(exact.jobIds).toEqual(AGING_JOB_IDS)
    expect(exact.expired).toBe(false)

    const asterGone = await project(model, 1, AGING_AT.asterExpired)
    expect(bodyIds(asterGone)).toEqual([])
    expect(asterGone.staleUpdates).toEqual([])
    expect(asterGone.removed).toEqual(ASTER_IDS)
    expect(asterGone.jobIds).toEqual([...BIRCH_IDS, ...CEDAR_IDS])
    expect(asterGone.catalog.boards.map(board => [board.dataStatus, board.total, board.included, board.lastSuccessAt])).toEqual([
      ['unavailable', 0, 0, '2026-09-24T08:00:00.000Z'],
      ['stale', 3, 3, '2026-09-24T08:00:01.000Z'],
      ['stale', 3, 3, '2026-09-24T08:00:02.000Z'],
    ])
    expect(asterGone.catalog.fetchedAt).toBe('2026-09-24T08:00:02.000Z')
    expect(asterGone.catalog.unmappedCount).toBe(0)
    expect(sorted(asterGone.matchIds)).toEqual(sorted(AGING_SURVIVOR_MATCHES_AFTER_ASTER))
    expect(asterGone.expired).toBe(false)

    const birchGone = await project(model, 1, AGING_AT.birchExpired)
    expect(birchGone).toMatchObject({ jobs: [], staleUpdates: [] })
    expect(birchGone.removed).toEqual(BIRCH_IDS)
    expect(birchGone.jobIds).toEqual(CEDAR_IDS)
    expect(sorted(birchGone.matchIds)).toEqual(sorted(AGING_SURVIVOR_MATCHES_AFTER_BIRCH))

    const cedarGone = await project(model, 1, AGING_AT.cedarExpired)
    expect(cedarGone).toMatchObject({ jobs: [], staleUpdates: [], jobIds: [], matchIds: [], cities: [], expired: true })
    expect(cedarGone.removed).toEqual(CEDAR_IDS)
    expect(cedarGone.catalog.fetchedAt).toBe('')
    expect(cedarGone.catalog.boards.map(board => [board.dataStatus, board.included, board.lastSuccessAt])).toEqual([
      ['unavailable', 0, '2026-09-24T08:00:00.000Z'], ['unavailable', 0, '2026-09-24T08:00:01.000Z'], ['unavailable', 0, '2026-09-24T08:00:02.000Z'],
    ])
    expect(cedarGone.recovery).toBeNull()
  })

  it('reverse time restores removed jobs with full bodies and later reverses flags with literal false values', async () => {
    const model = new CatalogWorkerModel()
    await decode(model, catalogWorkerCatalog())
    await project(model, 1, AGING_FRESH_NOW)
    await project(model, 1, AGING_AT.cedarExpired)

    const revived = await project(model, 1, '2026-09-24T08:30:01.500Z')
    expect(bodyIds(revived)).toEqual(AGING_JOB_IDS)
    expect(revived.jobs.map(job => job.stale)).toEqual([true, true, true, true, true, true, false, false, false])
    expect(revived.staleUpdates).toEqual([])
    expect(revived.removed).toEqual([])
    expect(boards(revived)).toEqual(['stale', 'stale', 'fresh'])
    expect(sorted(revived.matchIds)).toEqual(sorted(AGING_MATCH_IDS))
    // Facts for restored matches are needed receiver data again.
    expect(sortedFactIds(revived)).toEqual(sorted(AGING_MATCH_IDS))

    const fresh = await project(model, 1, AGING_FRESH_NOW)
    expect(bodyIds(fresh)).toEqual([])
    expect(fresh.staleUpdates).toEqual(flags([...ASTER_IDS, ...BIRCH_IDS], false))
    expect(fresh.removed).toEqual([])
    expect(boards(fresh)).toEqual(['fresh', 'fresh', 'fresh'])
    expect(fresh.catalog.stale).toBe(false)
  })

  it('reverse time on jobs without a stale key reverses with null deletions, never false', async () => {
    const model = new CatalogWorkerModel()
    const source = withoutStaleKeys(agingCurrentCatalog())
    expect(source.jobs.every(job => !Object.hasOwn(job, 'stale'))).toBe(true)
    await decode(model, source)
    const initial = await project(model, 1, AGING_FRESH_NOW)
    expect(initial.jobs.every(job => !Object.hasOwn(job, 'stale'))).toBe(true)

    const asterStale = await project(model, 1, AGING_AT.asterStale)
    expect(bodyIds(asterStale)).toEqual([])
    expect(asterStale.staleUpdates).toEqual(flags(ASTER_IDS, true))

    const back = await project(model, 1, AGING_FRESH_NOW)
    expect(bodyIds(back)).toEqual([])
    expect(back.staleUpdates).toEqual(flags(ASTER_IDS, null))
    expect(back.removed).toEqual([])
  })

  it('never mutates earlier returned projections or the original jobs', async () => {
    const model = new CatalogWorkerModel()
    await decode(model, catalogWorkerCatalog())
    const first = await model.handle({ kind: 'project', protocol: CATALOG_PROJECTION_PROTOCOL, revision: 1, input: input(AGING_FRESH_NOW) })
    if (first.kind !== 'projected') throw new Error('Expected a catalog projection.')
    const snapshot = structuredClone(first.value)
    await project(model, 1, AGING_AT.cedarStale)
    await project(model, 1, AGING_AT.asterExpired)
    await project(model, 1, AGING_FRESH_NOW)
    expect(first.value).toEqual(snapshot)
    expect(first.value.jobs.map(job => job.stale)).toEqual(Array(9).fill(false))
    expect(first.value.catalog.boards.map(board => board.dataStatus)).toEqual(['fresh', 'fresh', 'fresh'])
  })
})

describe('aging transport: progressive arrivals, replacements and revisions (contract items 4, 5)', () => {
  it('company deltas after an earlier stale boundary send only the newly arrived bodies', async () => {
    const model = new CatalogWorkerModel()
    await decode(model, catalogWorkerSnapshot(), { status: 202 })
    const first = await project(model, 1, AGING_FRESH_NOW, { collecting: true })
    expect(bodyIds(first)).toEqual(ASTER_IDS)
    await model.handle({ kind: 'acknowledge', revision: 1 })

    const asterStale = await project(model, 1, '2026-09-24T08:30:00.500Z', { collecting: true })
    expect(bodyIds(asterStale)).toEqual([])
    expect(asterStale.staleUpdates).toEqual(flags(ASTER_IDS, true))

    await decode(model, catalogWorkerUpdate(2), { initial: false })
    const second = await project(model, 2, '2026-09-24T08:30:00.500Z', { collecting: true })
    expect(bodyIds(second)).toEqual(BIRCH_IDS)
    expect(second.jobs.map(job => job.stale)).toEqual([false, false, false])
    expect(second.staleUpdates).toEqual([])
    expect(second.removed).toEqual([])
    expect(second.catalog.boards.map(board => board.included)).toEqual([3, 3, 0])
    await model.handle({ kind: 'acknowledge', revision: 2 })

    await decode(model, catalogWorkerUpdate(3), { initial: false })
    const third = await project(model, 3, '2026-09-24T08:30:00.500Z')
    expect(bodyIds(third)).toEqual(CEDAR_IDS)
    expect(third.staleUpdates).toEqual([])
    expect(third.catalog.boards.map(board => board.included)).toEqual([3, 3, 3])

    const later = await project(model, 3, '2026-09-24T08:30:02.500Z')
    expect(bodyIds(later)).toEqual([])
    expect(later.staleUpdates).toEqual(flags([...BIRCH_IDS, ...CEDAR_IDS], true))
    expect(later.jobIds).toEqual(AGING_JOB_IDS)
  })

  it('a same-ID replacement delivered while hidden sends that company and reveals the new title later', async () => {
    const model = new CatalogWorkerModel()
    await decode(model, agingCurrentSnapshot(), { status: 202 })
    const hidden = { query: 'Beacon London', role: 'backend' as const }
    const initial = await project(model, 1, AGING_FRESH_NOW, { collecting: true }, hidden)
    expect(bodyIds(initial)).toEqual(AGING_JOB_IDS)
    expect(initial.matchIds).toEqual(['greenhouse-catalog-worker-cedar-london', 'greenhouse-catalog-worker-birch-london'])
    expect(initial.catalog.boards.map(board => [board.status, board.dataStatus])).toEqual([
      ['ok', 'fresh'], ['ok', 'fresh'], ['ok', 'fresh'], ['pending', 'unavailable'],
    ])
    await model.handle({ kind: 'acknowledge', revision: 1 })
    await project(model, 1, AGING_AT.asterStale, { collecting: true }, hidden)

    await decode(model, agingReplacementUpdate(4), { initial: false })
    const replaced = await project(model, 2, AGING_AT.asterStale, { collecting: true }, hidden)
    expect(bodyIds(replaced)).toEqual(ASTER_IDS)
    expect(replaced.jobs.map(job => [job.title, job.stale])).toEqual([
      [AGING_REVISED_TITLE, true], ['Frontend Engineer — Beacon Berlin', true], ['Backend Engineer — Beacon Remote UK', true],
    ])
    expect(replaced.staleUpdates).toEqual([])
    expect(replaced.removed).toEqual([])
    expect(replaced.matchIds).toEqual(['greenhouse-catalog-worker-cedar-london', 'greenhouse-catalog-worker-birch-london'])

    const revealed = await project(model, 2, AGING_AT.asterStale, { collecting: true }, { query: 'Atlas Alpha Revised' })
    expect(bodyIds(revealed)).toEqual([])
    expect(revealed.staleUpdates).toEqual([])
    expect(revealed.matchIds).toEqual(['greenhouse-catalog-worker-aster-atlas'])
    expect(revealed.facts.map(fact => fact.id)).toEqual(['greenhouse-catalog-worker-aster-atlas'])
  })

  it('preview and acknowledge never consume delivery; three pins stay queryable until legitimately pruned', async () => {
    const model = new CatalogWorkerModel()
    await decode(model, catalogWorkerCatalog(), { stream: 1 })
    await project(model, 1, AGING_FRESH_NOW)
    await model.handle({ kind: 'acknowledge', revision: 1 })
    await decode(model, catalogWorkerRevised(), { stream: 2 })
    const revised = await project(model, 2, AGING_FRESH_NOW)
    expect(bodyIds(revised)).toEqual(AGING_JOB_IDS)
    expect(revised.jobs[0].title).toBe('Backend Engineer — Atlas Alpha Revised')
    await decode(model, catalogWorkerEmpty(), { stream: 3 })

    const preview = (revision: number, time: string, filters: Partial<Filters> = {}) => model.handle({
      kind: 'preview', revision, profile: CATALOG_WORKER_PROFILE,
      filters: { ...CATALOG_WORKER_FILTERS, query: 'Atlas Alpha', ...filters }, now: at(time),
    })
    expect(await preview(1, AGING_AT.asterExactly24h)).toEqual({ kind: 'previewed', count: 1 })
    expect(await preview(1, AGING_AT.asterExpired)).toEqual({ kind: 'previewed', count: 0 })
    expect(await preview(2, AGING_FRESH_NOW, { query: 'Atlas Alpha Revised' })).toEqual({ kind: 'previewed', count: 1 })
    expect(await preview(3, AGING_FRESH_NOW)).toEqual({ kind: 'previewed', count: 0 })

    // Preview at a crossed boundary did not deliver flags for revision 2.
    const revisedStale = await project(model, 2, '2026-09-24T08:35:00.000Z')
    expect(bodyIds(revisedStale)).toEqual([])
    expect(revisedStale.staleUpdates).toEqual(flags(AGING_JOB_IDS, true))

    const old = await project(model, 1, AGING_FRESH_NOW)
    expect(bodyIds(old)).toEqual(AGING_JOB_IDS)
    expect(old.jobs[0]).toMatchObject({ title: 'Backend Engineer — Atlas Alpha', fetchedAt: CATALOG_WORKER_TIME, stale: false })
    expect(old.catalog.fetchedAt).toBe('2026-09-24T08:00:02.000Z')
    await expect(project(model, 2, AGING_FRESH_NOW)).rejects.toMatchObject({ code: 'CATALOG_SUPERSEDED' })
    const empty = await project(model, 3, AGING_FRESH_NOW)
    expect(empty.jobIds).toEqual([])
    expect(empty.removed).toEqual(AGING_JOB_IDS)
    expect(empty.catalog.fetchedAt).toBe('2026-09-24T08:00:02.000Z')
  })

  it('an invalid protocol request in a populated three-pin session has no aging, search, delivery, pin or pruning side effects', async () => {
    const model = new CatalogWorkerModel()
    await decode(model, catalogWorkerCatalog(), { stream: 1 })
    await project(model, 1, AGING_FRESH_NOW)
    await model.handle({ kind: 'acknowledge', revision: 1 })
    await decode(model, catalogWorkerRevised(), { stream: 2 })
    await project(model, 2, AGING_FRESH_NOW)
    await decode(model, catalogWorkerEmpty(), { stream: 3 })

    const missing = { kind: 'project', revision: 2, input: input('2026-09-24T08:35:00.000Z') } as unknown as CatalogWorkerCommand
    await expect(model.handle(missing)).rejects.toMatchObject({ code: 'CATALOG_WORKER_FAILED' })
    const unsupported = { kind: 'project', protocol: 2, revision: 1, input: input(AGING_FRESH_NOW) } as unknown as CatalogWorkerCommand
    await expect(model.handle(unsupported)).rejects.toMatchObject({ code: 'CATALOG_WORKER_FAILED' })

    // The projected pin (2) still exists and nothing was delivered by the rejected requests.
    const unchanged = await project(model, 2, AGING_FRESH_NOW)
    expect(unchanged).toMatchObject({ ...NOTHING, facts: [] })
    const stale = await project(model, 2, '2026-09-24T08:35:00.000Z')
    expect(bodyIds(stale)).toEqual([])
    expect(stale.staleUpdates).toEqual(flags(AGING_JOB_IDS, true))
    expect(stale.catalog.boards.map(board => board.lastSuccessAt)).toEqual([CATALOG_WORKER_REVISED_TIME, CATALOG_WORKER_REVISED_TIME, CATALOG_WORKER_REVISED_TIME])
    // The acknowledged pin (1) and the latest decode (3) remain queryable too.
    const old = await project(model, 1, AGING_FRESH_NOW)
    expect(bodyIds(old)).toEqual(AGING_JOB_IDS)
    expect(old.jobs[0].title).toBe('Backend Engineer — Atlas Alpha')
    const latest = await project(model, 3, AGING_FRESH_NOW)
    expect(latest.jobIds).toEqual([])
    expect(latest.removed).toEqual(AGING_JOB_IDS)
  })

  it('a new model sends every body again and then only flags', async () => {
    const first = new CatalogWorkerModel()
    await decode(first, catalogWorkerCatalog())
    await project(first, 1, AGING_FRESH_NOW)
    await project(first, 1, AGING_AT.asterStale)
    const second = new CatalogWorkerModel()
    await decode(second, catalogWorkerCatalog())
    const initial = await project(second, 1, AGING_AT.asterStale)
    expect(bodyIds(initial)).toEqual(AGING_JOB_IDS)
    expect(initial.jobs.map(job => job.stale)).toEqual([true, true, true, false, false, false, false, false, false])
    expect(initial.staleUpdates).toEqual([])
    const next = await project(second, 1, AGING_AT.birchStale)
    expect(bodyIds(next)).toEqual([])
    expect(next.staleUpdates).toEqual(flags(BIRCH_IDS, true))
  })
})

describe('aging transport: metadata-only flag changes (contract items 1, 4 and the accepted migration clarification)', () => {
  const cedarBoards = (patch: CatalogProjectionPatch) => patch.catalog.boards.map(board => [board.companyId, board.status, board.dataStatus])

  it('CURRENT records: Cedar board flips send zero bodies and exactly the three Cedar flags; an unchanged replay sends nothing', async () => {
    const model = new CatalogWorkerModel()
    await decode(model, agingCurrentSnapshot(), { status: 202 })
    const initial = await project(model, 1, AGING_FRESH_NOW, { collecting: true })
    expect(bodyIds(initial)).toEqual(AGING_JOB_IDS)
    expect(initial.jobIds).toEqual(AGING_JOB_IDS)
    expect(cedarBoards(initial)).toEqual([
      ['catalog-worker-aster', 'ok', 'fresh'], ['catalog-worker-birch', 'ok', 'fresh'],
      ['catalog-worker-cedar', 'ok', 'fresh'], ['catalog-worker-dogwood', 'pending', 'unavailable'],
    ])
    await model.handle({ kind: 'acknowledge', revision: 1 })

    await decode(model, agingMetadataUpdate(4, 'stale'), { initial: false })
    const stale = await project(model, 2, AGING_FRESH_NOW, { collecting: true })
    expect(bodyIds(stale)).toEqual([])
    expect(stale.staleUpdates).toEqual(flags(CEDAR_IDS, true))
    expect(stale.removed).toEqual([])
    expect(stale.jobIds).toEqual(AGING_JOB_IDS)
    expect(stale.catalog.stale).toBe(true)
    expect(cedarBoards(stale)[2]).toEqual(['catalog-worker-cedar', 'ok', 'stale'])
    expect(cedarBoards(stale)[3]).toEqual(['catalog-worker-dogwood', 'pending', 'unavailable'])
    expect(sorted(stale.matchIds)).toEqual(sorted(AGING_MATCH_IDS))
    await model.handle({ kind: 'acknowledge', revision: 2 })

    await decode(model, agingMetadataUpdate(5, 'stale'), { initial: false })
    const replay = await project(model, 3, AGING_FRESH_NOW, { collecting: true })
    expect(replay).toMatchObject(NOTHING)
    expect(replay.catalog.stale).toBe(true)
    await model.handle({ kind: 'acknowledge', revision: 3 })

    await decode(model, agingMetadataUpdate(6, 'fresh'), { initial: false })
    const fresh = await project(model, 4, AGING_FRESH_NOW, { collecting: true })
    expect(bodyIds(fresh)).toEqual([])
    expect(fresh.staleUpdates).toEqual(flags(CEDAR_IDS, false))
    expect(fresh.removed).toEqual([])
    expect(fresh.catalog.stale).toBe(false)
    expect(cedarBoards(fresh)[2]).toEqual(['catalog-worker-cedar', 'ok', 'fresh'])
  })

  it('LIMIT-MARKER legacy re-migration: Cedar board flips on legacy records resend exactly the three Cedar bodies; an unchanged replay sends nothing', async () => {
    // Accepted limit (contract line 17/26/94 and the agreed migration clarification): a legacy raw
    // record lacking current migration results gets re-migrated when its raw wrapper changes, which
    // allocates new non-stale nested references, so the conservative classifier sends the full body.
    const model = new CatalogWorkerModel()
    await decode(model, agingLegacySnapshot(), { status: 202 })
    const initial = await project(model, 1, AGING_FRESH_NOW, { collecting: true })
    expect(bodyIds(initial)).toEqual(AGING_JOB_IDS)
    await model.handle({ kind: 'acknowledge', revision: 1 })

    await decode(model, agingMetadataUpdate(4, 'stale'), { initial: false })
    const stale = await project(model, 2, AGING_FRESH_NOW, { collecting: true })
    expect(bodyIds(stale)).toEqual(CEDAR_IDS)
    expect(stale.jobs.map(job => job.stale)).toEqual([true, true, true])
    expect(stale.staleUpdates).toEqual([])
    expect(stale.removed).toEqual([])
    expect(stale.jobIds).toEqual(AGING_JOB_IDS)
    await model.handle({ kind: 'acknowledge', revision: 2 })

    await decode(model, agingMetadataUpdate(5, 'stale'), { initial: false })
    expect(await project(model, 3, AGING_FRESH_NOW, { collecting: true })).toMatchObject(NOTHING)
    await model.handle({ kind: 'acknowledge', revision: 3 })

    await decode(model, agingMetadataUpdate(6, 'fresh'), { initial: false })
    const fresh = await project(model, 4, AGING_FRESH_NOW, { collecting: true })
    expect(bodyIds(fresh)).toEqual(CEDAR_IDS)
    expect(fresh.jobs.map(job => job.stale)).toEqual([false, false, false])
    expect(fresh.staleUpdates).toEqual([])
  })
})

describe('aging transport: freshness policies stay in force (contract item 6)', () => {
  it('a daily feed turns stale at 24 hours while the ordinary company turns stale at 30 minutes', async () => {
    const model = new CatalogWorkerModel()
    await decode(model, agingDailyCatalog())
    const initial = await project(model, 1, AGING_FRESH_NOW)
    expect(bodyIds(initial)).toEqual(['greenhouse-catalog-worker-aster-atlas', AGING_DAILY_ID])
    const asterStale = await project(model, 1, AGING_DAILY_AT.asterStale)
    expect(bodyIds(asterStale)).toEqual([])
    expect(asterStale.staleUpdates).toEqual([{ id: 'greenhouse-catalog-worker-aster-atlas', stale: true }])
    expect(boards(asterStale)).toEqual(['stale', 'fresh'])
    const daily = await project(model, 1, AGING_DAILY_AT.dailyExactly24h)
    expect(bodyIds(daily)).toEqual([])
    expect(daily.staleUpdates).toEqual([{ id: AGING_DAILY_ID, stale: true }])
    expect(daily.removed).toEqual([])
    expect(boards(daily)).toEqual(['stale', 'stale'])
    const gone = await project(model, 1, AGING_DAILY_AT.bothExpired)
    expect(gone.removed).toEqual(['greenhouse-catalog-worker-aster-atlas', AGING_DAILY_ID])
    expect(gone).toMatchObject({ jobs: [], staleUpdates: [], jobIds: [], expired: true })
  })

  it('a catalog-level stale flag marks every job once and later boundaries send nothing', async () => {
    const model = new CatalogWorkerModel()
    await decode(model, agingCatalogLevelStaleCatalog())
    const initial = await project(model, 1, AGING_FRESH_NOW)
    expect(bodyIds(initial)).toEqual(AGING_JOB_IDS)
    expect(initial.jobs.every(job => job.stale === true)).toBe(true)
    expect(initial.catalog.stale).toBe(true)
    expect(await project(model, 1, AGING_AT.asterStale)).toMatchObject(NOTHING)
    expect(await project(model, 1, AGING_AT.cedarStale)).toMatchObject(NOTHING)
    const gone = await project(model, 1, AGING_AT.asterExpired)
    expect(gone.removed).toEqual(ASTER_IDS)
    expect(gone).toMatchObject({ jobs: [], staleUpdates: [] })
  })

  it('a failed board with a retry deadline keeps its earlier jobs retained and its record untouched', async () => {
    const model = new CatalogWorkerModel()
    const source = agingErrorBoardCatalog()
    const errorBoard = structuredClone(source.boards[0])
    await decode(model, source)
    const initial = await project(model, 1, AGING_FRESH_NOW)
    expect(initial.jobs.map(job => job.stale)).toEqual([true, true, true, false, false, false, false, false, false])
    expect(initial.catalog.boards[0]).toEqual({ ...errorBoard, included: 3 })
    expect(initial.catalog.boards.map(board => board.status)).toEqual(['error', 'ok', 'ok'])
    const asterStale = await project(model, 1, AGING_AT.asterStale)
    expect(asterStale).toMatchObject(NOTHING)
    const birchStale = await project(model, 1, AGING_AT.birchStale)
    expect(bodyIds(birchStale)).toEqual([])
    expect(birchStale.staleUpdates).toEqual(flags(BIRCH_IDS, true))
  })
})

describe('LIMIT-MARKER retained F3 costs on the fixed fixture (contract lines 88-92)', () => {
  // These observations record the accepted remaining costs of the body/flag stage. They are not
  // F3 success criteria and are changed deliberately when a later stage reduces the cost.
  it('facts are re-sent for every current match at the first stale boundary and for survivors at the first partial expiry', async () => {
    const model = new CatalogWorkerModel()
    await decode(model, catalogWorkerCatalog())
    const initial = await project(model, 1, AGING_FRESH_NOW)
    expect(sortedFactIds(initial)).toEqual(sorted(AGING_MATCH_IDS))
    expect(sortedFactIds(await project(model, 1, AGING_AT.stillFresh))).toEqual([])
    expect(sortedFactIds(await project(model, 1, AGING_AT.asterStale))).toEqual(sorted(AGING_MATCH_IDS))
    expect(sortedFactIds(await project(model, 1, AGING_AT.birchStale))).toEqual(sorted(AGING_MATCH_IDS))
    expect(sortedFactIds(await project(model, 1, AGING_AT.cedarStale))).toEqual(sorted(AGING_MATCH_IDS))
    // Exact 24 h after Cedar's boundary is a same-boundary replay: no new facts.
    expect(sortedFactIds(await project(model, 1, AGING_AT.asterExactly24h))).toEqual([])
    expect(sortedFactIds(await project(model, 1, AGING_AT.asterExpired))).toEqual(sorted(AGING_SURVIVOR_MATCHES_AFTER_ASTER))
    expect(sortedFactIds(await project(model, 1, AGING_AT.birchExpired))).toEqual(sorted(AGING_SURVIVOR_MATCHES_AFTER_BIRCH))
    expect(sortedFactIds(await project(model, 1, AGING_AT.cedarExpired))).toEqual([])
  })

  it('every reply carries the six literal deadlines and an independent full re-parse conservatively sends all nine bodies', async () => {
    const model = new CatalogWorkerModel()
    await decode(model, catalogWorkerCatalog(), { stream: 1 })
    const initial = await project(model, 1, AGING_FRESH_NOW)
    expect(initial.deadlines).toEqual(AGING_DEADLINES)
    expect((await project(model, 1, AGING_AT.asterStale)).deadlines).toEqual(AGING_DEADLINES)
    await decode(model, catalogWorkerCatalog(), { stream: 2 })
    const reparsed = await project(model, 2, AGING_AT.asterStale)
    expect(bodyIds(reparsed)).toEqual(AGING_JOB_IDS)
    expect(reparsed.staleUpdates).toEqual([])
    expect(reparsed.deadlines).toEqual(AGING_DEADLINES)
  })
})
