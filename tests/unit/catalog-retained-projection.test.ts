import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRetainedProjection, projectionBoundary } from '../../src/lib/catalog-retained-projection'
import { CatalogWorkerClient } from '../../src/lib/catalog-worker-client'
import { CatalogWorkerModel } from '../../src/lib/catalog-worker-model'
import type {
  CatalogProjection, CatalogViewInput, CatalogWorkerRequest, CatalogWorkerResponse,
} from '../../src/lib/catalog-worker-types'
import { createSearchIndex, failedSearchFilters, inSearchScope } from '../../shared/job-search'
import { matchJob } from '../../shared/matching'
import type { Filters, Job, MatchedJob } from '../../shared/types'
import { CATALOG_WORKER_FILTERS, CATALOG_WORKER_PROFILE, catalogWorkerCatalog } from '../fixtures/catalog-worker'
import {
  RETENTION_ASTER_TIME, RETENTION_AT, RETENTION_BIRCH_TIME, RETENTION_CEDAR_TIME, RETENTION_DAILY_AT, RETENTION_DEADLINES,
  retentionAnchor, retentionDailyAnchor, retentionEmptyAnchor, retentionExpiredAnchor, retentionZeroMatchAnchor,
} from '../fixtures/catalog-retention'

const at = (time: string) => Date.parse(time)
const ids = (matches: readonly MatchedJob[]) => matches.map(match => match.job.id)
const A1 = 'greenhouse-retention-aster-a1', A2 = 'greenhouse-retention-aster-a2', A3 = 'greenhouse-retention-aster-a3'
const B1 = 'greenhouse-retention-birch-b1', B2 = 'greenhouse-retention-birch-b2', B3 = 'greenhouse-retention-birch-b3'
const C1 = 'greenhouse-retention-cedar-c1', C2 = 'greenhouse-retention-cedar-c2', C3 = 'greenhouse-retention-cedar-c3'
const D1 = 'himalayas-retention-daily-d1'
const cityView = (projection: CatalogProjection) => projection.cities.map(result =>
  [result.city.id, result.companyCount, result.averageScore, ids(result.matches)])
const globeView = (projection: CatalogProjection) => projection.globeCities.map(marker =>
  [marker.city.id, [...marker.companyIds].sort(), marker.companyCount])

// Contract 설계 1 §논의 후 반영한 세부 조건: the anchor is immutable, one derived view is
// cached per passed boundary, only job references change, facts are reused, and
// aggregates are exact over survivors. Expected values below are authored literals.
describe('retained projection: literal guards on an authored anchor', () => {
  it('returns the anchor itself before any deadline and reuses one derived object per passed boundary', () => {
    const anchor = retentionAnchor()
    const retain = createRetainedProjection(anchor)
    expect(projectionBoundary(anchor.deadlines, at('2026-10-01T08:29:59.999Z'))).toBe(0)
    expect(projectionBoundary(anchor.deadlines, at('2026-10-01T08:30:00.500Z'))).toBe(at(RETENTION_AT.asterStale))
    expect(projectionBoundary(anchor.deadlines, at('2026-10-03T00:00:00.000Z'))).toBe(at(RETENTION_AT.cedarExpired))
    expect(retain(at('2026-10-01T08:05:00.000Z'))).toBe(anchor)
    expect(retain(at('2026-10-01T08:29:59.999Z'))).toBe(anchor)
    const asterStale = retain(at(RETENTION_AT.asterStale))
    expect(asterStale).not.toBe(anchor)
    expect(retain(at('2026-10-01T08:30:00.999Z'))).toBe(asterStale)
    expect(retain(at('2026-10-01T08:30:00.999Z'))).toBe(asterStale)
    const birchStale = retain(at(RETENTION_AT.birchStale))
    expect(birchStale).not.toBe(asterStale)
    expect(retain(at('2026-10-01T08:30:01.500Z'))).toBe(birchStale)
  })

  it('nulls a stale recovery analysis while sharing every other field with the anchor', () => {
    const anchor = retentionAnchor({ recovery: { available: 3, profileExcluded: 1, suggestions: [], alternatives: [] } })
    const retain = createRetainedProjection(anchor)
    const view = retain(at('2026-10-01T08:05:00.000Z'))
    expect(view).not.toBe(anchor)
    expect(view.recovery).toBeNull()
    expect(view.matches).toBe(anchor.matches)
    expect(view.cities).toBe(anchor.cities)
    expect(view.globeCities).toBe(anchor.globeCities)
    expect(view.catalog).toBe(anchor.catalog)
    expect(view.deadlines).toBe(anchor.deadlines)
    expect(view.expired).toBe(false)
    expect(anchor.recovery).toEqual({ available: 3, profileExcluded: 1, suggestions: [], alternatives: [] })
    expect(retain(at('2026-10-01T08:20:00.000Z'))).toBe(view)
    expect(retain(at(RETENTION_AT.asterExpired)).recovery).toBeNull()
  })

  it('marks only Aster stale at its 30-minute boundary and reuses untouched match objects and their facts', () => {
    const anchor = retentionAnchor()
    const view = createRetainedProjection(anchor)(at(RETENTION_AT.asterStale))
    expect(ids(view.matches)).toEqual([A1, B2, A3, B1, A2, C1, C2, B3])
    expect(view.matches.map(match => match.job.stale)).toEqual([true, false, true, false, true, false, false, false])
    const [a1, b2, a3] = view.matches
    expect(a1).not.toBe(anchor.matches[0])
    expect(a1.job).not.toBe(anchor.matches[0].job)
    expect(a1.job.id).toBe(A1)
    expect(a1.job.stale).toBe(true)
    expect(a1.score).toBe(90)
    expect(a1.reasons).toBe(anchor.matches[0].reasons)
    expect(a1.matchedSkills).toBe(anchor.matches[0].matchedSkills)
    expect(a1.company).toBe(anchor.matches[0].company)
    expect(b2).toBe(anchor.matches[1])
    expect(view.remote).toHaveLength(1)
    expect(view.remote[0]).toBe(a3)
    expect(view.remote[0]).not.toBe(anchor.remote[0])
    expect(view.unmapped[0]).toBe(anchor.unmapped[0])
    expect(cityView(view)).toEqual([
      ['london', 3, 77.5, [A1, B1, C1, C2]],
      ['berlin', 3, 75, [B2, A2, C2]],
    ])
    expect(view.cities[0].matches[0]).toBe(a1)
    expect(view.cities[0].matches[1]).toBe(anchor.cities[0].matches[1])
    expect(view.companyCount).toBe(3)
    expect(globeView(view)).toEqual([
      ['london', ['retention-aster', 'retention-birch', 'retention-cedar'], 3],
      ['berlin', ['retention-aster', 'retention-birch', 'retention-cedar'], 3],
    ])
    expect(view.catalog.stale).toBe(true)
    expect(view.catalog.boards.map(board => board.dataStatus)).toEqual(['stale', 'fresh', 'fresh'])
    expect(view.catalog.jobs.map(job => [job.id, job.stale])).toEqual([
      [A1, true], [A2, true], [A3, true], [B1, false], [B2, false], [B3, false], [C1, false], [C2, false],
    ])
    expect(view.catalog.jobs[3]).toBe(anchor.catalog.jobs[3])
    expect(view.catalog.fetchedAt).toBe(RETENTION_CEDAR_TIME)
    expect(view.expired).toBe(false)
    expect(anchor.matches[0].job.stale).toBe(false)
  })

  it('keeps every job usable at exactly 24 hours and drops Aster one millisecond later with exact survivors', () => {
    const anchor = retentionAnchor()
    const retain = createRetainedProjection(anchor)
    const exact = retain(at(RETENTION_AT.asterExactly24h))
    expect(ids(exact.matches)).toEqual([A1, B2, A3, B1, A2, C1, C2, B3])
    expect(exact.matches.every(match => match.job.stale === true)).toBe(true)
    expect(cityView(exact)).toEqual([
      ['london', 3, 77.5, [A1, B1, C1, C2]],
      ['berlin', 3, 75, [B2, A2, C2]],
    ])
    expect(exact.expired).toBe(false)
    expect(exact.catalog.boards.map(board => board.dataStatus)).toEqual(['stale', 'stale', 'stale'])

    const view = retain(at(RETENTION_AT.asterExpired))
    expect(ids(view.matches)).toEqual([B2, B1, C1, C2, B3])
    // Berlin now ranks first: 77.5 against London's 220 / 3.
    expect(view.cities.map(result => [result.city.id, result.companyCount, ids(result.matches)])).toEqual([
      ['berlin', 2, [B2, C2]],
      ['london', 2, [B1, C1, C2]],
    ])
    expect(view.cities[0].averageScore).toBe(77.5)
    expect(view.cities[1].averageScore).toBeCloseTo(73.3333, 4)
    expect(view.remote).toEqual([])
    expect(ids(view.unmapped)).toEqual([B3])
    expect(view.companyCount).toBe(2)
    expect(globeView(view)).toEqual([
      ['berlin', ['retention-birch', 'retention-cedar'], 2],
      ['london', ['retention-birch', 'retention-cedar'], 2],
    ])
    expect(view.catalog.jobs.map(job => [job.id, job.stale])).toEqual([
      [B1, true], [B2, true], [B3, true], [C1, true], [C2, true],
    ])
    expect(view.catalog.boards.map(board => [board.companyId, board.dataStatus, board.total, board.included, board.lastSuccessAt])).toEqual([
      ['retention-aster', 'unavailable', 0, 0, RETENTION_ASTER_TIME],
      ['retention-birch', 'stale', 3, 3, RETENTION_BIRCH_TIME],
      ['retention-cedar', 'stale', 2, 2, RETENTION_CEDAR_TIME],
    ])
    expect(view.catalog.fetchedAt).toBe(RETENTION_CEDAR_TIME)
    expect(view.catalog.stale).toBe(true)
    expect(view.expired).toBe(false)
    expect(view.recovery).toBeNull()
  })

  it('breaks a full tie by English city name after Birch expires and never adds the out-of-region Tokyo group', () => {
    const anchor = retentionAnchor()
    const retain = createRetainedProjection(anchor)
    const view = retain(at(RETENTION_AT.birchExpired))
    expect(ids(view.matches)).toEqual([C1, C2])
    expect(cityView(view)).toEqual([
      ['berlin', 1, 70, [C2]],
      ['london', 1, 70, [C1, C2]],
    ])
    expect(view.remote).toEqual([])
    expect(view.unmapped).toEqual([])
    expect(view.companyCount).toBe(1)
    expect(globeView(view)).toEqual([['berlin', ['retention-cedar'], 1], ['london', ['retention-cedar'], 1]])
    for (const time of [RETENTION_AT.asterStale, RETENTION_AT.asterExpired, RETENTION_AT.birchExpired]) {
      expect(retain(at(time)).cities.map(result => result.city.id)).not.toContain('tokyo')
    }
    expect(view.catalog.cities.map(city => city.id)).toEqual(['london', 'berlin', 'tokyo'])
    expect(view.catalog.boards.map(board => board.dataStatus)).toEqual(['unavailable', 'unavailable', 'stale'])
  })

  it('expires the whole view at the Cedar cutoff and derives the earlier partial state again after a wall-clock rollback', () => {
    const anchor = retentionAnchor()
    const retain = createRetainedProjection(anchor)
    const gone = retain(at(RETENTION_AT.cedarExpired))
    expect(gone).toMatchObject({
      matches: [], cities: [], remote: [], unmapped: [], globeCities: [], companyCount: 0, expired: true, recovery: null,
    })
    expect(gone.catalog.fetchedAt).toBe('')
    expect(gone.catalog.jobs).toEqual([])
    expect(gone.catalog.boards.map(board => [board.dataStatus, board.included, board.lastSuccessAt])).toEqual([
      ['unavailable', 0, RETENTION_ASTER_TIME], ['unavailable', 0, RETENTION_BIRCH_TIME], ['unavailable', 0, RETENTION_CEDAR_TIME],
    ])
    // Rollback re-evaluates the same fixed anchor; it recreates only data that anchor holds.
    const back = retain(at('2026-10-02T08:00:00.500Z'))
    expect(back).not.toBe(gone)
    expect(back.expired).toBe(false)
    expect(ids(back.matches)).toEqual([B2, B1, C1, C2, B3])
    expect(back.catalog.fetchedAt).toBe(RETENTION_CEDAR_TIME)
    expect(retain(at('2026-10-01T08:10:00.000Z'))).toBe(anchor)
  })

  it('never mutates the anchor, its catalog, matches, groups or deadlines across every boundary', () => {
    const anchor = retentionAnchor({ recovery: { available: 8, profileExcluded: 0, suggestions: [], alternatives: [] } })
    const before = structuredClone(anchor)
    const retain = createRetainedProjection(anchor)
    for (const time of [
      '2026-10-01T08:05:00.000Z', ...Object.values(RETENTION_AT), '2026-10-02T08:00:00.500Z', '2026-10-01T08:05:00.000Z',
    ]) retain(at(time))
    expect(anchor).toEqual(before)
    expect(anchor.matches[0].job.stale).toBe(false)
    expect(anchor.cities[0].matches).toHaveLength(4)
    expect(anchor.deadlines).toEqual(RETENTION_DEADLINES)
    expect(anchor.recovery).toEqual({ available: 8, profileExcluded: 0, suggestions: [], alternatives: [] })
  })

  it('drops a job with an unreadable timestamp at any time and leaves the readable ones and their groups intact', () => {
    const anchor = retentionAnchor({ invalidTimestampJob: true })
    expect(anchor.catalog.jobs).toHaveLength(9)
    const view = createRetainedProjection(anchor)(at('2026-10-01T08:05:00.000Z'))
    expect(view).not.toBe(anchor)
    expect(ids(view.matches)).toEqual([A1, B2, A3, B1, A2, C1, C2, B3])
    expect(view.matches[0]).toBe(anchor.matches[0])
    expect(cityView(view)).toEqual([
      ['london', 3, 77.5, [A1, B1, C1, C2]],
      ['berlin', 3, 75, [B2, A2, C2]],
    ])
    expect(view.catalog.jobs.map(job => job.id)).not.toContain('greenhouse-retention-cedar-x1')
    expect(view.catalog.jobs).toHaveLength(8)
    expect(view.catalog.fetchedAt).toBe(RETENTION_CEDAR_TIME)
    expect(view.expired).toBe(false)
  })

  it('expires a job before its company\'s younger board snapshot and keeps that company\'s younger jobs', () => {
    const anchor = retentionAnchor({ olderCedarJob: true })
    const retain = createRetainedProjection(anchor)
    expect(ids(anchor.matches)).toEqual([A1, B2, A3, B1, A2, C1, C2, C3, B3])
    const exact = retain(at('2026-10-02T07:00:00.000Z'))
    expect(ids(exact.matches)).toEqual([A1, B2, A3, B1, A2, C1, C2, C3, B3])
    expect(exact.expired).toBe(false)
    const view = retain(at(RETENTION_AT.olderCedarExpired))
    expect(ids(view.matches)).toEqual([A1, B2, A3, B1, A2, C1, C2, B3])
    expect(cityView(view)).toEqual([
      ['london', 3, 77.5, [A1, B1, C1, C2]],
      ['berlin', 3, 75, [B2, A2, C2]],
    ])
    expect(view.catalog.boards.map(board => [board.companyId, board.dataStatus])).toEqual([
      ['retention-aster', 'stale'], ['retention-birch', 'stale'], ['retention-cedar', 'stale'],
    ])
    expect(view.catalog.jobs.map(job => job.id)).not.toContain(C3)
    expect(view.catalog.jobs).toHaveLength(8)
    expect(view.catalog.fetchedAt).toBe(RETENTION_CEDAR_TIME)
    expect(view.expired).toBe(false)
  })

  it.each(['legacy-missing', 'unparseable'] as const)('ages a Birch board with a %s snapshot time from its own jobs rather than treating it as unknown', birchBoardTime => {
    const anchor = retentionAnchor({ birchBoardTime })
    const retain = createRetainedProjection(anchor)
    const early = retain(at('2026-10-01T08:05:00.000Z'))
    expect(ids(early.matches)).toEqual([A1, B2, A3, B1, A2, C1, C2, B3])
    expect(early.catalog.boards[1].dataStatus).toBe('fresh')
    const asterGone = retain(at(RETENTION_AT.asterExpired))
    expect(ids(asterGone.matches)).toEqual([B2, B1, C1, C2, B3])
    expect(asterGone.catalog.boards.map(board => board.dataStatus)).toEqual(['unavailable', 'stale', 'stale'])
    const birchGone = retain(at(RETENTION_AT.birchExpired))
    expect(ids(birchGone.matches)).toEqual([C1, C2])
    expect(birchGone.catalog.boards.map(board => board.dataStatus)).toEqual(['unavailable', 'unavailable', 'stale'])
    expect(birchGone.expired).toBe(false)
  })

  it('applies the daily-source 24-hour freshness to a Himalayas job while the ordinary job turns stale at 30 minutes', () => {
    const anchor = retentionDailyAnchor()
    const retain = createRetainedProjection(anchor)
    const stale = retain(at(RETENTION_DAILY_AT.asterStale))
    expect(stale.matches.map(match => [match.job.id, match.job.stale])).toEqual([[A1, true], [D1, false]])
    expect(stale.matches[1]).toBe(anchor.matches[1])
    expect(stale.catalog.boards.map(board => [board.companyId, board.dataStatus])).toEqual([
      ['retention-aster', 'stale'], ['retention-daily', 'fresh'],
    ])
    expect(cityView(stale)).toEqual([['london', 2, 70, [A1, D1]]])
    expect(stale.catalog.stale).toBe(true)
    const exact = retain(at(RETENTION_DAILY_AT.dailyExactly24h))
    expect(exact.matches.map(match => [match.job.id, match.job.stale])).toEqual([[A1, true], [D1, true]])
    expect(exact.catalog.boards.map(board => board.dataStatus)).toEqual(['stale', 'stale'])
    expect(exact.expired).toBe(false)
    const gone = retain(at(RETENTION_DAILY_AT.bothExpired))
    expect(gone.matches).toEqual([])
    expect(gone.cities).toEqual([])
    expect(gone.expired).toBe(true)
    expect(gone.catalog.fetchedAt).toBe('')
  })

  it('keeps a nonempty catalog with zero matching jobs as a current empty result, not an expired catalog', () => {
    const anchor = retentionZeroMatchAnchor()
    const retain = createRetainedProjection(anchor)
    const early = retain(at('2026-10-01T08:05:00.000Z'))
    expect(early.recovery).toBeNull()
    expect(early.matches).toEqual([])
    expect(early.cities).toEqual([])
    expect(early.expired).toBe(false)
    expect(early.catalog.jobs).toHaveLength(8)
    expect(early.catalog.fetchedAt).toBe(RETENTION_CEDAR_TIME)
    const asterGone = retain(at(RETENTION_AT.asterExpired))
    expect(asterGone).toMatchObject({ matches: [], cities: [], remote: [], unmapped: [], globeCities: [], companyCount: 0, expired: false })
    expect(asterGone.catalog.jobs.map(job => job.id)).toEqual([B1, B2, B3, C1, C2])
    expect(asterGone.catalog.boards.map(board => board.dataStatus)).toEqual(['unavailable', 'stale', 'stale'])
    const gone = retain(at(RETENTION_AT.cedarExpired))
    expect(gone.expired).toBe(true)
    expect(gone.catalog.fetchedAt).toBe('')
  })

  it('keeps an already expired anchor expired, and treats an empty successful read as current until its own boards expire', () => {
    const expired = retentionExpiredAnchor()
    const keep = createRetainedProjection(expired)
    expect(keep(at('2026-10-05T00:00:00.000Z'))).toBe(expired)
    expect(keep(at('2026-10-01T00:00:00.000Z'))).toBe(expired)
    expect(expired.expired).toBe(true)
    expect(expired.catalog.fetchedAt).toBe('')

    const empty = retentionEmptyAnchor()
    const retain = createRetainedProjection(empty)
    const fresh = retain(at('2026-10-01T08:10:00.000Z'))
    expect(fresh.recovery).toBeNull()
    expect(fresh.expired).toBe(false)
    expect(fresh.matches).toEqual([])
    expect(fresh.catalog.fetchedAt).toBe(RETENTION_CEDAR_TIME)
    const stale = retain(at(RETENTION_AT.cedarStale))
    expect(stale.expired).toBe(false)
    expect(stale.catalog.stale).toBe(true)
    expect(stale.catalog.boards.map(board => board.dataStatus)).toEqual(['stale', 'stale', 'stale'])
    const gone = retain(at(RETENTION_AT.cedarExpired))
    expect(gone.expired).toBe(true)
    expect(gone.catalog.fetchedAt).toBe('')
  })
})

// The double runs the real model in-process, like tests/unit/catalog-worker.test.ts.
// It fabricates no worker result; it only carries messages and structured clones.
class WorkerDouble extends EventTarget {
  static instances: WorkerDouble[] = []
  readonly model = new CatalogWorkerModel()
  private queue = Promise.resolve()
  constructor(readonly url: URL, readonly options: WorkerOptions) { super(); WorkerDouble.instances.push(this) }
  postMessage(message: CatalogWorkerRequest, transfer: Transferable[] = []) {
    const copied = structuredClone(message, { transfer })
    this.queue = this.queue.then(async () => {
      let response: CatalogWorkerResponse
      try { response = { id: copied.id, result: await this.model.handle(copied.command) } }
      catch (error) {
        const cause = error as Error & { code?: string; retryAt?: string }
        response = { id: copied.id, error: { message: cause.message, code: cause.code, retryAt: cause.retryAt } }
      }
      this.dispatchEvent(new MessageEvent('message', { data: structuredClone(response) }))
    })
  }
  terminate() { /* The double has no thread to stop. */ }
}

const WORKER_BOUNDARIES = [
  '2026-09-24T08:29:59.999Z', '2026-09-24T08:30:00.000Z', '2026-09-24T08:30:01.000Z', '2026-09-24T08:30:02.000Z',
  '2026-09-25T08:00:00.000Z', '2026-09-25T08:00:00.001Z', '2026-09-25T08:00:01.001Z', '2026-09-25T08:00:02.001Z',
]

const input = (now: number, changes: Partial<CatalogViewInput> = {}): CatalogViewInput => ({
  profile: CATALOG_WORKER_PROFILE, filters: CATALOG_WORKER_FILTERS, scope: { kind: 'cities' },
  recover: true, collecting: false, now, ...changes,
})

/** Only user-relevant, serializable facets; object identity differs between clients by design. */
function comparable(projection: CatalogProjection) {
  return {
    matches: projection.matches.map(match => ({
      id: match.job.id, stale: match.job.stale ?? false, company: match.company.id, score: match.score,
      reasons: match.reasons, cautions: match.cautions, matchedSkills: match.matchedSkills,
      missingSkills: match.missingSkills, skillSummary: match.skillSummary,
    })),
    cities: projection.cities.map(result => ({
      id: result.city.id, companyCount: result.companyCount, averageScore: result.averageScore, matches: ids(result.matches),
    })),
    remote: ids(projection.remote), unmapped: ids(projection.unmapped),
    globe: projection.globeCities.map(marker => ({ id: marker.city.id, companies: [...marker.companyIds].sort(), count: marker.companyCount })),
    companyCount: projection.companyCount, expired: projection.expired, recovery: projection.recovery,
    catalog: {
      fetchedAt: projection.catalog.fetchedAt, stale: projection.catalog.stale, unmappedCount: projection.catalog.unmappedCount,
      jobs: projection.catalog.jobs.map(job => ({ id: job.id, stale: job.stale ?? false })),
      boards: projection.catalog.boards.map(board => ({
        companyId: board.companyId, status: board.status, dataStatus: board.dataStatus,
        total: board.total, included: board.included, lastSuccessAt: board.lastSuccessAt,
      })),
    },
  }
}

// Contract §논의 후 반영한 세부 조건 second paragraph and §독립 검증 필수 기대값: these
// differential checks guard the per-job premise. They supplement the literal
// expectations above and never replace them.
describe('retained projection: differential and invariance guards against the healthy worker', () => {
  const noNetwork = vi.fn(async () => { throw new Error('Retention unit verification must not contact a server.') })
  beforeEach(() => {
    noNetwork.mockClear()
    WorkerDouble.instances = []
    vi.stubGlobal('fetch', noNetwork)
    vi.stubGlobal('Worker', WorkerDouble)
  })
  afterEach(() => { expect(noNetwork).not.toHaveBeenCalled(); vi.unstubAllGlobals() })

  it('matches a healthy worker projection at each stale and expiry boundary of the worker fixture', async () => {
    const anchorClient = new CatalogWorkerClient(vi.fn())
    const healthy = new CatalogWorkerClient(vi.fn())
    try {
      const receipt = await anchorClient.read(Response.json(catalogWorkerCatalog()), true, 1, new AbortController().signal)
      const anchor = await anchorClient.project(receipt.value.revision, input(at('2026-09-24T08:00:03.000Z')))
      expect(anchor.matches).toHaveLength(8)
      const current = await healthy.read(Response.json(catalogWorkerCatalog()), true, 1, new AbortController().signal)
      const retain = createRetainedProjection(anchor)
      for (const time of WORKER_BOUNDARIES) {
        const expected = await healthy.project(current.value.revision, input(at(time)))
        expect(comparable(retain(at(time))), time).toEqual(comparable(expected))
      }
      // Literal anchors keep the comparison from being vacuous.
      expect([...ids(retain(at('2026-09-25T08:00:00.001Z')).matches)].sort()).toEqual([
        'greenhouse-catalog-worker-birch-berlin', 'greenhouse-catalog-worker-birch-canvas', 'greenhouse-catalog-worker-birch-london',
        'greenhouse-catalog-worker-cedar-berlin', 'greenhouse-catalog-worker-cedar-london',
      ])
      expect(retain(at('2026-09-25T08:00:00.001Z')).cities.map(result => [result.city.id, result.companyCount, ids(result.matches).length]))
        .toEqual([['london', 2, 3], ['berlin', 2, 2]])
      expect(retain(at('2026-09-25T08:00:01.001Z')).companyCount).toBe(1)
      expect(retain(at('2026-09-25T08:00:02.001Z')).expired).toBe(true)
      expect(WorkerDouble.instances).toHaveLength(2)
    } finally {
      anchorClient.dispose()
      healthy.dispose()
    }
  })

  it('selects and scores one job identically alone, inside the full catalog, and with its stale flag set', () => {
    const catalog = catalogWorkerCatalog()
    const full = createSearchIndex(catalog, CATALOG_WORKER_PROFILE)
    const variants: Filters[] = [
      CATALOG_WORKER_FILTERS,
      { ...CATALOG_WORKER_FILTERS, role: 'backend' },
      { ...CATALOG_WORKER_FILTERS, query: 'Beacon London' },
      { ...CATALOG_WORKER_FILTERS, region: 'europe', workMode: 'onsite', employment: 'fulltime' },
      { ...CATALOG_WORKER_FILTERS, salaryMin: 200000, includeUnknownSalary: false, remoteEligibleOnly: false },
    ]
    expect(catalog.jobs).toHaveLength(9)
    for (const job of catalog.jobs) {
      const stale: Job = { ...job, stale: true }
      const alone = createSearchIndex({ ...catalog, jobs: [job] }, CATALOG_WORKER_PROFILE).entries[0]
      const staleAlone = createSearchIndex({ ...catalog, jobs: [stale] }, CATALOG_WORKER_PROFILE).entries[0]
      const inFull = full.entries.find(entry => entry.job.id === job.id)
      expect(alone, job.id).toBeDefined()
      expect(inFull, job.id).toBeDefined()
      for (const filters of variants) {
        expect(failedSearchFilters(alone, filters), `${job.id} alone`).toEqual(failedSearchFilters(inFull!, filters))
        expect(failedSearchFilters(staleAlone, filters), `${job.id} stale`).toEqual(failedSearchFilters(inFull!, filters))
      }
      for (const scope of [{ kind: 'cities' }, { kind: 'remote' }, { kind: 'unmapped' }] as const) {
        expect(inSearchScope(alone, scope, 'all'), `${job.id} ${scope.kind}`).toBe(inSearchScope(inFull!, scope, 'all'))
        expect(inSearchScope(alone, scope, 'europe'), `${job.id} ${scope.kind} europe`).toBe(inSearchScope(inFull!, scope, 'europe'))
      }
      expect(matchJob(stale, CATALOG_WORKER_PROFILE), job.id).toEqual(matchJob(job, CATALOG_WORKER_PROFILE))
      expect(matchJob(job, { ...CATALOG_WORKER_PROFILE, years: 9 }).score, job.id)
        .toBe(matchJob({ ...stale, fetchedAt: '2020-01-01T00:00:00.000Z' }, { ...CATALOG_WORKER_PROFILE, years: 9 }).score)
    }
  })
})
