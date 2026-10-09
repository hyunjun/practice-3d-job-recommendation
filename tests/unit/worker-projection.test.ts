import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildPublication } from '../../server/publication-build'
import type { BuiltPublication } from '../../server/publication-build'
import type { CatalogPublicationCapture } from '../../server/catalog-service'
import { isPublicCatalog } from '../../src/lib/catalog-validation'
import { CITIES } from '../../shared/cities'
import { ObservationHistorySchema, OBSERVATION_METHOD } from '../../shared/catalog-observations'
import { PostingStatusIndexSchema } from '../../shared/posting-status'
import { parsePublicationManifest, PUBLICATION_LIMITS } from '../../shared/publication'
import type { PublicationHead, PublicationManifest } from '../../shared/publication'
import {
  projectCatalog, projectObservations, projectPostingStatus, projectionValidatorInput, PublicationResponseError, usableBoardCount,
} from '../../worker/projection'
import { PROVENANCE_ALDER, PROVENANCE_BIRCH, PROVENANCE_CEDAR_DAILY } from '../fixtures/board-status-provenance'
import {
  checkpointFrom, FICTIONAL_COMMIT, GENERATION_ONE, GENERATION_TWO, materialize, PUBLICATION_FAILURES, publicationHarness,
  RUN_ONE, stamp82,
} from '../fixtures/publication'
import type { PublicationGeneration } from '../fixtures/publication'

/**
 * Stage82 common design v2 (lines 49-75): request-time projection of one stored
 * generation. Literal boundaries: ordinary sources stale at exactly 30 minutes,
 * usable at exactly 24 hours, excluded 1 ms later; listing and body clocks are
 * independent; null source clocks fall back to the request time; expiry errors
 * precede validators; UTC 90-day history cutoff. Expected values are written
 * from the design and the frozen policy constants, never from the projection.
 */
const ALDER = 'provenance-alder'
const BIRCH = 'provenance-birch'
const CEDAR = 'provenance-cedar'
const ALDER_JOB = 'greenhouse-provenance-alder-7401'
const BIRCH_JOB = 'smartrecruiters-provenance-birch-7401'
const T = stamp82
const at = (iso: string) => Date.parse(iso)
const HEAD: PublicationHead = { revision: 1, generation: GENERATION_ONE, publishedAt: T('06:00:05.000') }
const alder = { companyId: ALDER, board: 'AlderProvenance74', provider: 'greenhouse' } as const
const birch = { companyId: BIRCH, board: 'BirchProvenance74', provider: 'smartrecruiters' } as const

afterEach(() => { vi.restoreAllMocks() })

// MWT82-1: keep the builder's UUID template type instead of a widened string default.
const build = (capture: CatalogPublicationCapture, generation: PublicationGeneration = GENERATION_ONE) => buildPublication(capture, FICTIONAL_COMMIT, null, generation)
const catalogAt = (built: BuiltPublication, time: string, head = HEAD) =>
  JSON.parse(materialize(built, projectCatalog(built.manifest, head, at(time)))) as Record<string, any>
const postingAt = (built: BuiltPublication, time: string) =>
  JSON.parse(materialize(built, projectPostingStatus(built.manifest, at(time)))) as Record<string, any>
const observationsAt = (built: BuiltPublication, time: string) =>
  JSON.parse(materialize(built, projectObservations(built.manifest, at(time)))) as Record<string, any>
const expectResponseError = (operation: () => unknown, status: number, body: Record<string, unknown>) => {
  let caught: unknown
  try { operation() } catch (error) { caught = error }
  expect(caught).toBeInstanceOf(PublicationResponseError)
  expect((caught as PublicationResponseError).status).toBe(status)
  expect((caught as PublicationResponseError).body).toEqual(body)
}
const retagged = (built: BuiltPublication, mutate: (manifest: PublicationManifest) => void): PublicationManifest => {
  const manifest = JSON.parse(built.manifestText) as PublicationManifest
  mutate(manifest)
  return parsePublicationManifest(manifest)
}

async function completeRun() {
  const h = publicationHarness()
  const { capture } = await h.run()
  return { h, capture, built: build(capture) }
}

describe('catalog projection over time', () => {
  it('serves the captured fresh catalog with publication metadata and passes the browser validator', async () => {
    const { capture, built } = await completeRun()
    const catalog = catalogAt(built, RUN_ONE)
    expect(catalog).toEqual({
      source: 'public', fetchedAt: RUN_ONE, checkedAt: RUN_ONE, refreshAfter: T('06:01:00.000'), stale: false,
      companies: [PROVENANCE_ALDER, PROVENANCE_BIRCH], cities: CITIES, unmappedCount: 0,
      boards: [
        { ...alder, status: 'ok', checkedAt: RUN_ONE, lastSuccessAt: RUN_ONE, retryAt: null, dataStatus: 'fresh', total: 1, included: 1 },
        { ...birch, status: 'ok', checkedAt: RUN_ONE, lastSuccessAt: RUN_ONE, retryAt: null, dataStatus: 'fresh', total: 1, included: 1 },
      ],
      publication: { mode: 'scheduled', generation: GENERATION_ONE, publishedAt: T('06:00:05.000'), intervalMinutes: 30 },
      jobs: capture.catalog.jobs.map(job => ({ ...job, stale: false })),
    })
    expect(isPublicCatalog(catalog)).toBe(true)
    expect(usableBoardCount(built.manifest, at(RUN_ONE))).toBe(2)
    expect(projectCatalog(built.manifest, HEAD, at(RUN_ONE)).bytes).toBe(Buffer.byteLength(materialize(built, projectCatalog(built.manifest, HEAD, at(RUN_ONE)))))
  })

  it('turns ordinary boards stale at exactly thirty minutes while keeping the original clocks', async () => {
    const { built } = await completeRun()
    expect(catalogAt(built, T('06:29:59.999')).boards.map((board: { dataStatus: string }) => board.dataStatus)).toEqual(['fresh', 'fresh'])
    expect(catalogAt(built, T('06:29:59.999')).stale).toBe(false)
    const stale = catalogAt(built, T('06:30:00.000'))
    expect(stale).toMatchObject({ fetchedAt: RUN_ONE, checkedAt: RUN_ONE, refreshAfter: T('06:01:00.000'), stale: true })
    expect(stale.boards).toEqual([
      { ...alder, status: 'ok', checkedAt: RUN_ONE, lastSuccessAt: RUN_ONE, retryAt: null, dataStatus: 'stale', total: 1, included: 1 },
      { ...birch, status: 'ok', checkedAt: RUN_ONE, lastSuccessAt: RUN_ONE, retryAt: null, dataStatus: 'stale', total: 1, included: 1 },
    ])
    expect(stale.jobs.map((job: { id: string; stale: boolean; fetchedAt: string }) => [job.id, job.stale, job.fetchedAt]))
      .toEqual([[ALDER_JOB, true, RUN_ONE], [BIRCH_JOB, true, RUN_ONE]])
    expect(isPublicCatalog(stale)).toBe(true)
  })

  it('keeps a snapshot usable at exactly twenty-four hours and expires every board one millisecond later', async () => {
    const { built } = await completeRun()
    const boundary = catalogAt(built, '2026-10-04T06:00:00.000Z')
    expect(boundary.boards.map((board: { dataStatus: string; total: number }) => [board.dataStatus, board.total])).toEqual([['stale', 1], ['stale', 1]])
    expect(boundary.jobs).toHaveLength(2)
    expect(usableBoardCount(built.manifest, at('2026-10-04T06:00:00.000Z'))).toBe(2)
    expectResponseError(() => projectCatalog(built.manifest, HEAD, at('2026-10-04T06:00:00.001Z')), 503, {
      error: '게시판에 연결하지 못했어요. 마지막 정상 조회가 24시간을 지나 이전 공고를 표시하지 않습니다.',
      code: 'CATALOG_EXPIRED', retryAt: T('06:01:00.000'),
    })
    expect(usableBoardCount(built.manifest, at('2026-10-04T06:00:00.001Z'))).toBe(0)
  })

  it('ages a daily source on its own thirty-minute versus twenty-four-hour clock while both share the 24-hour cutoff', async () => {
    const h = publicationHarness({ companies: [PROVENANCE_ALDER, PROVENANCE_CEDAR_DAILY] })
    const first = await h.run()
    const built = build(first.capture)
    const status = (time: string) => catalogAt(built, time).boards.map((board: { companyId: string; dataStatus: string }) => [board.companyId, board.dataStatus])
    const halfHour = catalogAt(built, T('06:30:00.000'))
    expect(status(T('06:30:00.000'))).toEqual([[ALDER, 'stale'], [CEDAR, 'fresh']])
    expect(halfHour.stale).toBe(true)
    expect(halfHour.jobs.map((job: { companyId: string; stale: boolean }) => [job.companyId, job.stale])).toEqual([[ALDER, true], [CEDAR, false]])
    expect(status('2026-10-04T05:59:59.999Z')).toEqual([[ALDER, 'stale'], [CEDAR, 'fresh']])
    expect(status('2026-10-04T06:00:00.000Z')).toEqual([[ALDER, 'stale'], [CEDAR, 'stale']])
    expectResponseError(() => projectCatalog(built.manifest, HEAD, at('2026-10-04T06:00:00.001Z')), 503, {
      error: '게시판에 연결하지 못했어요. 마지막 정상 조회가 24시간을 지나 이전 공고를 표시하지 않습니다.',
      code: 'CATALOG_EXPIRED', retryAt: T('06:01:00.000'),
    })
    // After the ordinary board is collected again at 06:30, only the daily board's older snapshot expires a day later.
    h.at(T('06:30:00.000'))
    const mixed = build((await h.run(checkpointFrom(first.capture))).capture, GENERATION_TWO)
    const dayLater = catalogAt(mixed, '2026-10-04T06:00:00.001Z', { ...HEAD, generation: GENERATION_TWO })
    expect(dayLater.boards).toEqual([
      { ...alder, status: 'ok', checkedAt: T('06:30:00.000'), lastSuccessAt: T('06:30:00.000'), retryAt: null, dataStatus: 'stale', total: 1, included: 1 },
      { companyId: CEDAR, board: 'cedar-provenance', provider: 'himalayas', status: 'ok', checkedAt: RUN_ONE, lastSuccessAt: RUN_ONE, retryAt: null, dataStatus: 'unavailable', total: 0, included: 0 },
    ])
    expect(dayLater).toMatchObject({ fetchedAt: T('06:30:00.000'), refreshAfter: T('06:31:00.000'), stale: true, unmappedCount: 0 })
    expect(dayLater.jobs.map((job: { companyId: string; stale: boolean }) => [job.companyId, job.stale])).toEqual([[ALDER, true]])
    expect(isPublicCatalog(dayLater)).toBe(true)
    expect(usableBoardCount(mixed.manifest, at('2026-10-04T06:00:00.001Z'))).toBe(1)
  })

  it('never serves a board captured as failed or stale as fresh again', async () => {
    const h = publicationHarness()
    const first = await h.run()
    h.at(T('06:30:00.000'))
    h.failBody(BIRCH, PUBLICATION_FAILURES.body)
    const built = build((await h.run(checkpointFrom(first.capture))).capture)
    expect(built.manifest.catalog.boards[1]).toMatchObject({ eligible: true, initiallyStale: true, fetchedAt: RUN_ONE })
    // The pure projection is evaluated before the body aged out, so only the captured failure makes it stale.
    const early = catalogAt(built, T('06:29:59.999'))
    expect(early.boards[1]).toEqual({
      ...birch, status: 'error', checkedAt: T('06:30:00.000'), lastSuccessAt: RUN_ONE, retryAt: T('06:31:00.000'),
      message: 'Fictional publication body 503', dataStatus: 'stale', total: 1, included: 1,
    })
    expect(early.boards[0].dataStatus).toBe('fresh')
    expect(early.jobs.map((job: { id: string; stale: boolean }) => [job.id, job.stale])).toEqual([[ALDER_JOB, false], [BIRCH_JOB, true]])
    expect(early.stale).toBe(true)
  })

  it('propagates an unknown unmapped count as null instead of inventing a total', async () => {
    const h = publicationHarness()
    const first = await h.run()
    const checkpoint = checkpointFrom(first.capture)
    checkpoint.boards[0].snapshot!.unmappedCount = null
    const second = await h.run(checkpoint)
    expect(second.capture.catalog.unmappedCount).toBeNull()
    const built = build(second.capture)
    expect(built.manifest.catalog.boards.map(board => board.unmappedCount)).toEqual([null, 0])
    const catalog = catalogAt(built, RUN_ONE)
    expect(catalog.unmappedCount).toBeNull()
    expect(isPublicCatalog(catalog)).toBe(true)
    // Once the daily board with the unknown count expires, the recollected board's count is known again.
    const h2 = publicationHarness({ companies: [PROVENANCE_ALDER, PROVENANCE_CEDAR_DAILY] })
    const run1 = await h2.run()
    const unknownCheckpoint = checkpointFrom(run1.capture)
    unknownCheckpoint.boards[1].snapshot!.unmappedCount = null
    h2.at(T('06:30:00.000'))
    const built2 = build((await h2.run(unknownCheckpoint)).capture)
    expect(built2.manifest.catalog.boards.map(board => board.unmappedCount)).toEqual([0, null])
    expect(catalogAt(built2, T('06:30:00.000')).unmappedCount).toBeNull()
    expect(catalogAt(built2, '2026-10-04T06:00:00.001Z').unmappedCount).toBe(0)
  })

  it('uses the request time for missing source deadlines and never substitutes publication time', async () => {
    const { built } = await completeRun()
    const manifest = retagged(built, value => {
      for (const board of value.catalog.boards) board.contentDeadline = null
    })
    const catalog = JSON.parse(materialize(built, projectCatalog(manifest, HEAD, at(T('06:10:00.000')))))
    expect(catalog.refreshAfter).toBe(T('06:10:00.000'))
    expect(catalog.fetchedAt).toBe(RUN_ONE)
    expect(catalog.checkedAt).toBe(RUN_ONE)
    expect(catalog.publication.publishedAt).toBe(T('06:00:05.000'))
    const mixed = retagged(built, value => { value.catalog.boards[0].contentDeadline = null })
    expect(JSON.parse(materialize(built, projectCatalog(mixed, HEAD, at(T('06:00:30.000'))))).refreshAfter).toBe(T('06:00:30.000'))
    expect(JSON.parse(materialize(built, projectCatalog(mixed, HEAD, at(T('06:02:00.000'))))).refreshAfter).toBe(T('06:01:00.000'))
  })

  it('returns the honest unavailable or expired error before any validator is computed', async () => {
    const unavailable = publicationHarness()
    unavailable.failEveryList(PUBLICATION_FAILURES.list)
    const emptyBuilt = build((await unavailable.run()).capture)
    expectResponseError(() => projectCatalog(emptyBuilt.manifest, HEAD, at(RUN_ONE)), 503, {
      error: '공개 채용 게시판에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요.', code: 'CATALOG_UNAVAILABLE', retryAt: T('06:01:00.000'),
    })
    expect(usableBoardCount(emptyBuilt.manifest, at(RUN_ONE))).toBe(0)
    const expired = publicationHarness({ at: '2026-10-02T05:00:00.000Z' })
    const old = await expired.run()
    expired.at(RUN_ONE)
    expired.failEveryList(PUBLICATION_FAILURES.list)
    const expiredBuilt = build((await expired.run(checkpointFrom(old.capture))).capture)
    expectResponseError(() => projectCatalog(expiredBuilt.manifest, HEAD, at(RUN_ONE)), 503, {
      error: '게시판에 연결하지 못했어요. 마지막 정상 조회가 24시간을 지나 이전 공고를 표시하지 않습니다.', code: 'CATALOG_EXPIRED', retryAt: T('06:01:00.000'),
    })
  })

  it('emits valid JSON when an eligible board has no jobs and refuses a decoded size above the response cap', async () => {
    const h = publicationHarness()
    h.emptyBody(BIRCH)
    const built = build((await h.run()).capture)
    const catalog = catalogAt(built, RUN_ONE)
    expect(catalog.jobs.map((job: { id: string }) => job.id)).toEqual([ALDER_JOB])
    expect(catalog.boards[1]).toMatchObject({ dataStatus: 'fresh', total: 0, included: 0 })
    expect(isPublicCatalog(catalog)).toBe(true)
    const oversized = retagged(built, value => {
      value.fragments[value.catalog.boards[0].fresh!].decodedBytes = PUBLICATION_LIMITS.catalog
    })
    expect(() => projectCatalog(oversized, HEAD, at(RUN_ONE))).toThrow('Stored response exceeds its decoded size limit')
  })
})

describe('posting-status projection over time', () => {
  it('reproduces the captured version 2 index at capture time', async () => {
    const { capture, built } = await completeRun()
    const index = postingAt(built, RUN_ONE)
    expect(index).toEqual(capture.postingStatus)
    expect(PostingStatusIndexSchema.safeParse(index).success).toBe(true)
  })

  it('keeps the listing but empties summaries at exactly the body freshness boundary, retaining content metadata', async () => {
    const { capture, built } = await completeRun()
    const before = postingAt(built, T('06:29:59.999'))
    expect(before.boards[0].listing.jobs).toHaveLength(1)
    const boundary = postingAt(built, T('06:30:00.000'))
    expect(boundary).toMatchObject({ version: 2, checkedAt: RUN_ONE, refreshAfter: T('06:01:00.000'), contentRefreshAfter: T('06:01:00.000') })
    for (const [index, board] of (boundary.boards as Record<string, any>[]).entries()) {
      const original = capture.postingStatus.boards[index]
      expect(board).toEqual({
        companyId: original.companyId, provider: original.provider, board: original.board, status: 'ok',
        checkedAt: RUN_ONE, lastSuccessAt: RUN_ONE, retryAt: null,
        listing: {
          validUntil: T('06:30:00.000'), publishedIds: original.listing!.publishedIds, jobs: [],
          content: { checkedAt: RUN_ONE, validUntil: T('06:30:00.000'), status: 'ok', jobIds: original.listing!.content!.jobIds },
        },
      })
    }
    expect(PostingStatusIndexSchema.safeParse(boundary).success).toBe(true)
  })

  it('drops the listing after twenty-four hours but keeps the board record readable', async () => {
    const { built } = await completeRun()
    const kept = postingAt(built, '2026-10-04T06:00:00.000Z')
    expect(kept.boards[0].listing).toMatchObject({ jobs: [], publishedIds: [ALDER_JOB] })
    const gone = postingAt(built, '2026-10-04T06:00:00.001Z')
    expect(gone.boards).toEqual([
      { ...alder, status: 'ok', checkedAt: RUN_ONE, lastSuccessAt: RUN_ONE, retryAt: null },
      { ...birch, status: 'ok', checkedAt: RUN_ONE, lastSuccessAt: RUN_ONE, retryAt: null },
    ])
    expect(gone).toMatchObject({ version: 2, checkedAt: RUN_ONE, refreshAfter: T('06:01:00.000'), contentRefreshAfter: T('06:01:00.000') })
    expect(PostingStatusIndexSchema.safeParse(gone).success).toBe(true)
  })

  it('keeps listing and body clocks independent: a failed body hides summaries while a fresh list stays listed', async () => {
    const h = publicationHarness()
    const first = await h.run()
    h.at(T('06:30:00.000'))
    h.failBody(BIRCH, PUBLICATION_FAILURES.body)
    const built = build((await h.run(checkpointFrom(first.capture))).capture)
    expect(built.manifest.posting.boards[1]).toMatchObject({ listingAt: T('06:30:00.000'), bodyFreshUntil: null })
    const index = postingAt(built, T('06:30:00.000'))
    expect(index.boards[1]).toEqual({
      ...birch, status: 'ok', checkedAt: T('06:30:00.000'), lastSuccessAt: T('06:30:00.000'), retryAt: null,
      listing: {
        validUntil: T('07:00:00.000'), publishedIds: [BIRCH_JOB], jobs: [],
        content: { checkedAt: RUN_ONE, validUntil: T('06:30:00.000'), status: 'error', jobIds: [BIRCH_JOB] },
      },
    })
    expect(index.boards[0].listing.jobs).toHaveLength(1)
    // A list failure after success keeps the old listing until its own 24-hour clock expires.
    const listFailure = publicationHarness()
    const base = await listFailure.run()
    listFailure.at(T('06:30:00.000'))
    listFailure.failList(BIRCH, PUBLICATION_FAILURES.list)
    const deferred = build((await listFailure.run(checkpointFrom(base.capture))).capture)
    const deferredIndex = postingAt(deferred, T('06:30:00.000'))
    expect(deferredIndex.boards[1]).toMatchObject({
      status: 'error', message: 'Fictional publication list 503', lastSuccessAt: RUN_ONE, retryAt: T('06:31:00.000'),
      listing: { validUntil: T('06:30:00.000'), publishedIds: [BIRCH_JOB], jobs: [], content: { status: 'ok', checkedAt: RUN_ONE } },
    })
    expect(postingAt(deferred, '2026-10-04T06:00:00.001Z').boards[1].listing).toBeUndefined()
  })

  it('substitutes the request time only for missing posting clocks', async () => {
    const { built } = await completeRun()
    const manifest = retagged(built, value => {
      for (const board of value.posting.boards) {
        board.checkedAt = null
        board.inventoryDeadline = null
        board.contentDeadline = null
      }
    })
    const index = JSON.parse(materialize(built, projectPostingStatus(manifest, at(T('06:10:00.000')))))
    expect(index).toMatchObject({ checkedAt: T('06:10:00.000'), refreshAfter: T('06:10:00.000'), contentRefreshAfter: T('06:10:00.000') })
    expect(index.boards.map((board: { checkedAt: string; lastSuccessAt: string }) => [board.checkedAt, board.lastSuccessAt]))
      .toEqual([[T('06:10:00.000'), RUN_ONE], [T('06:10:00.000'), RUN_ONE]])
    expect(PostingStatusIndexSchema.safeParse(index).success).toBe(true)
  })

  it('publishes an all-unavailable capture as error rows without listings', async () => {
    const h = publicationHarness()
    h.failEveryList(PUBLICATION_FAILURES.list)
    const { capture } = await h.run()
    const built = build(capture)
    const index = postingAt(built, RUN_ONE)
    expect(index).toEqual(capture.postingStatus)
    expect(index.boards.every((board: { listing?: unknown }) => board.listing === undefined)).toBe(true)
  })
})

describe('observation projection over time', () => {
  it('reproduces the captured public history and applies the UTC ninety-day cutoff literally', async () => {
    const { capture, built } = await completeRun()
    expect(observationsAt(built, RUN_ONE)).toEqual(capture.history)
    const lastRetainedDay = observationsAt(built, '2026-12-31T06:00:00.000Z')
    expect(lastRetainedDay.days.map((day: { day: string }) => day.day)).toEqual(['2026-10-03'])
    const dropped = observationsAt(built, '2027-01-01T06:00:00.000Z')
    expect(dropped).toEqual({
      version: 1, retentionDays: 90, scope: capture.history.scope, method: OBSERVATION_METHOD, otherSeries: [], storage: 'ok', days: [],
    })
    expect(ObservationHistorySchema.safeParse(dropped).success).toBe(true)
  })

  it('summarizes other series from their actually retained dates and drops them when none remain', async () => {
    const h = publicationHarness()
    const first = await h.run()
    h.at(T('06:10:00.000'))
    const migrated = await h.run(checkpointFrom(first.capture), { companies: [PROVENANCE_ALDER, PROVENANCE_CEDAR_DAILY] })
    const built = buildPublication(migrated.capture, FICTIONAL_COMMIT, { revision: 1, generation: GENERATION_ONE, publishedAt: T('06:00:05.000') }, GENERATION_TWO)
    const history = observationsAt(built, T('06:10:00.000'))
    expect(history.otherSeries).toEqual([
      { scopeKey: first.capture.history.scope.key, method: OBSERVATION_METHOD, firstDay: '2026-10-03', lastDay: '2026-10-03', companyCount: 2 },
    ])
    expect(history.days.map((day: { day: string }) => day.day)).toEqual(['2026-10-03'])
    expect(history).toEqual(migrated.capture.history)
    expect(observationsAt(built, '2027-01-01T06:00:00.000Z')).toMatchObject({ days: [], otherSeries: [] })
  })
})

describe('validator derivation', () => {
  it('differs across generations, across stale and fresh representations, and is stable for the same request time', async () => {
    const { capture, built } = await completeRun()
    const second = build(capture, GENERATION_TWO)
    const fresh = projectCatalog(built.manifest, HEAD, at(RUN_ONE))
    const freshAgain = projectCatalog(built.manifest, HEAD, at(T('06:00:01.000')))
    const stale = projectCatalog(built.manifest, HEAD, at(T('06:30:00.000')))
    const other = projectCatalog(second.manifest, { ...HEAD, generation: GENERATION_TWO }, at(RUN_ONE))
    expect(projectionValidatorInput(built.manifest, fresh)).toBe(projectionValidatorInput(built.manifest, freshAgain))
    expect(projectionValidatorInput(built.manifest, fresh)).not.toBe(projectionValidatorInput(built.manifest, stale))
    expect(projectionValidatorInput(built.manifest, fresh)).not.toBe(projectionValidatorInput(second.manifest, other))
    expect(projectionValidatorInput(built.manifest, fresh)).toContain(GENERATION_ONE)
    expect(projectionValidatorInput(built.manifest, fresh)).not.toContain(ALDER_JOB)
    // Identical fragment bytes across generations are byte-stable, yet the validator still changes with the generation.
    expect(second.manifest.fragments[second.manifest.catalog.boards[0].fresh!].decodedHash)
      .toBe(built.manifest.fragments[built.manifest.catalog.boards[0].fresh!].decodedHash)
  })
})
