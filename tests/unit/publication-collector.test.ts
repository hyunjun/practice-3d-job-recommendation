import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { collectPublication, publicationConfigurationId, publicationHash } from '../../server/publication-collector'
import type { CollectionMetric } from '../../server/publication-collector'
import { BoardFetchError, createCatalogService } from '../../server/catalog-service'
import type { BoardResult, CatalogPublicationCapture } from '../../server/catalog-service'
import type { CachedBoard } from '../../server/board-cache'
import { createObservationStore } from '../../server/catalog-observations'
import type { CachedPresence, PresenceResult } from '../../server/posting-presence'
import { OBSERVATION_METHOD } from '../../shared/catalog-observations'
import { REVISION_FIELDS } from '../../shared/posting-status'
import type { Company } from '../../shared/types'
import {
  contentResult, presenceResult, PROVENANCE_ALDER, PROVENANCE_BIRCH, PROVENANCE_CEDAR_DAILY, PROVENANCE_COMPANIES,
} from '../fixtures/board-status-provenance'
import { checkpointFrom, PUBLICATION_FAILURES, publicationHarness, RUN_ONE, stamp82 } from '../fixtures/publication'

/**
 * Stage82 common design v2 (docs/design/cloudflare-deployment.md, 8f9af5db…): a
 * dedicated Node collector runs one list pass then one body pass with force=false,
 * keeps every original clock, backoff and failure, and captures a settled state.
 * Expected rows are literal; nothing below derives an expectation from the
 * collector, the service's gate arithmetic or the scheduler under test.
 */
const ALDER = 'provenance-alder'
const BIRCH = 'provenance-birch'
const CEDAR = 'provenance-cedar'
const ALDER_JOB = 'greenhouse-provenance-alder-7401'
const BIRCH_JOB = 'smartrecruiters-provenance-birch-7401'
const T = stamp82
const HEX64 = /^[a-f0-9]{64}$/
const alder = { companyId: ALDER, board: 'AlderProvenance74', provider: 'greenhouse' } as const
const birch = { companyId: BIRCH, board: 'BirchProvenance74', provider: 'smartrecruiters' } as const
const sortedMetrics = (metrics: CollectionMetric[]) =>
  [...metrics].sort((left, right) => `${left.pass}:${left.provider}`.localeCompare(`${right.pass}:${right.provider}`))

afterEach(() => { vi.restoreAllMocks() })

/** The order in which the ledger saw list and body work: every list boundary must precede the first body start. */
function passOrder(events: { kind: 'list' | 'body' }[]) {
  const kinds = events.map(event => event.kind)
  return { lastList: kinds.lastIndexOf('list'), firstBody: kinds.indexOf('body') }
}

describe('a first scheduled run from an empty checkpoint', () => {
  it('runs one complete list pass before one body pass and captures every clock from the same run', async () => {
    const h = publicationHarness()
    const { capture, metrics } = await h.run()
    expect([...h.listCalls()].sort()).toEqual([ALDER, BIRCH])
    expect([...h.bodyCalls()].sort()).toEqual([ALDER, BIRCH])
    const order = passOrder(h.ledger())
    expect(order.firstBody).toBeGreaterThan(order.lastList)
    expect(h.ledger().filter(event => event.phase === 'end').map(event => event.outcome)).toEqual(['ok', 'ok', 'ok', 'ok'])
    expect(capture.capturedAt).toBe(RUN_ONE)
    expect(capture.catalog).toMatchObject({
      source: 'public', fetchedAt: T('06:00:00.000'), checkedAt: T('06:00:00.000'), refreshAfter: T('06:01:00.000'),
      stale: false, unmappedCount: 0, companies: PROVENANCE_COMPANIES,
      boards: [
        { ...alder, status: 'ok', dataStatus: 'fresh', total: 1, included: 1, checkedAt: T('06:00:00.000'), lastSuccessAt: T('06:00:00.000'), retryAt: null },
        { ...birch, status: 'ok', dataStatus: 'fresh', total: 1, included: 1, checkedAt: T('06:00:00.000'), lastSuccessAt: T('06:00:00.000'), retryAt: null },
      ],
    })
    expect(capture.catalog.boards.map(board => board.message)).toEqual([undefined, undefined])
    expect(capture.catalog.jobs.map(job => [job.id, job.stale, job.fetchedAt])).toEqual([
      [ALDER_JOB, false, T('06:00:00.000')], [BIRCH_JOB, false, T('06:00:00.000')],
    ])
    expect(capture.catalog.cities.length).toBeGreaterThan(0)
    expect(capture.postingStatus).toMatchObject({
      version: 2, checkedAt: T('06:00:00.000'), refreshAfter: T('06:01:00.000'), contentRefreshAfter: T('06:01:00.000'),
      boards: [
        {
          ...alder, status: 'ok', checkedAt: T('06:00:00.000'), lastSuccessAt: T('06:00:00.000'), retryAt: null,
          listing: {
            validUntil: T('06:30:00.000'), publishedIds: [ALDER_JOB],
            jobs: [{ id: ALDER_JOB, title: 'Backend Engineer — Alder Forge 7401', url: 'https://example.test/jobs/7401' }],
            content: { checkedAt: T('06:00:00.000'), validUntil: T('06:30:00.000'), status: 'ok', jobIds: [ALDER_JOB] },
          },
        },
        {
          ...birch, status: 'ok', checkedAt: T('06:00:00.000'), lastSuccessAt: T('06:00:00.000'), retryAt: null,
          listing: {
            validUntil: T('06:30:00.000'), publishedIds: [BIRCH_JOB],
            jobs: [{ id: BIRCH_JOB, title: 'Backend Engineer — Birch Signal 7401' }],
            content: { checkedAt: T('06:00:00.000'), validUntil: T('06:30:00.000'), status: 'ok', jobIds: [BIRCH_JOB] },
          },
        },
      ],
    })
    for (const board of capture.postingStatus.boards) {
      expect(board.message).toBeUndefined()
      expect(board.listing?.unconfirmedIds).toBeUndefined()
      const revision = board.listing!.jobs[0].revision
      expect(Object.keys(revision).sort()).toEqual([...REVISION_FIELDS].sort())
      for (const field of REVISION_FIELDS) expect(revision[field]).toMatch(HEX64)
    }
    expect(capture.boards).toMatchObject([
      { ...alder, checkedAt: T('06:00:00.000'), failures: 0, retryAt: null, snapshot: { fetchedAt: T('06:00:00.000'), total: 1, unmappedCount: 0, publishedIds: [ALDER_JOB], observationMethod: OBSERVATION_METHOD } },
      { ...birch, checkedAt: T('06:00:00.000'), failures: 0, retryAt: null, snapshot: { fetchedAt: T('06:00:00.000'), total: 1, unmappedCount: 0, publishedIds: [BIRCH_JOB], observationMethod: OBSERVATION_METHOD } },
    ])
    expect(capture.boards.map(board => [board.error, board.errorPhase, board.snapshot?.jobs.map(job => job.id)])).toEqual([
      [undefined, undefined, [ALDER_JOB]], [undefined, undefined, [BIRCH_JOB]],
    ])
    expect(capture.presences).toMatchObject([
      { ...alder, checkedAt: T('06:00:00.000'), failures: 0, retryAt: null, snapshot: { fetchedAt: T('06:00:00.000'), total: 1, publishedIds: [ALDER_JOB] } },
      { ...birch, checkedAt: T('06:00:00.000'), failures: 0, retryAt: null, snapshot: { fetchedAt: T('06:00:00.000'), total: 1, publishedIds: [BIRCH_JOB] } },
    ])
    expect(capture.presences.map(entry => [entry.error, entry.unpublishedIds, entry.snapshot?.unconfirmedIds])).toEqual([
      [undefined, undefined, undefined], [undefined, undefined, undefined],
    ])
    expect(capture.clocks).toEqual([
      { companyId: ALDER, inventoryDeadline: T('06:01:00.000'), contentDeadline: T('06:01:00.000'), postingCheckedAt: T('06:00:00.000') },
      { companyId: BIRCH, inventoryDeadline: T('06:01:00.000'), contentDeadline: T('06:01:00.000'), postingCheckedAt: T('06:00:00.000') },
    ])
    expect(sortedMetrics(metrics)).toEqual([
      { pass: 'content', provider: 'greenhouse', boards: 1, requests: 0, failedRequests: 0 },
      { pass: 'content', provider: 'smartrecruiters', boards: 1, requests: 0, failedRequests: 0 },
      { pass: 'inventory', provider: 'greenhouse', boards: 1, requests: 0, failedRequests: 0 },
      { pass: 'inventory', provider: 'smartrecruiters', boards: 1, requests: 0, failedRequests: 0 },
    ])
  })

  it('captures the settled observation day that the collection itself recorded, in both public and private form', async () => {
    const h = publicationHarness()
    const { capture } = await h.run()
    expect(capture.history).toMatchObject({
      version: 1, retentionDays: 90, storage: 'ok', method: OBSERVATION_METHOD, otherSeries: [],
      scope: { boards: [
        { companyId: ALDER, name: 'Alder Forge', provider: 'greenhouse', board: 'AlderProvenance74' },
        { companyId: BIRCH, name: 'Birch Signal', provider: 'smartrecruiters', board: 'BirchProvenance74' },
      ] },
    })
    expect(capture.history.scope.key).toMatch(HEX64)
    expect(capture.history.error).toBeUndefined()
    expect(capture.history.days).toHaveLength(1)
    expect(capture.history.days[0]).toMatchObject({
      day: '2026-10-03',
      latest: {
        observedAt: T('06:00:00.000'), recordedAt: T('06:00:00.000'), origin: 'collection',
        boards: [
          { companyId: ALDER, status: 'complete', checkedAt: T('06:00:00.000'), lastSuccessAt: T('06:00:00.000') },
          { companyId: BIRCH, status: 'complete', checkedAt: T('06:00:00.000'), lastSuccessAt: T('06:00:00.000') },
        ],
      },
      complete: {
        observedAt: T('06:00:00.000'), origin: 'collection', comparable: true,
        stats: {
          published: 2, technical: 2, openings: 2, talentPools: 0,
          companies: [{ companyId: ALDER, name: 'Alder Forge', count: 1 }, { companyId: BIRCH, name: 'Birch Signal', count: 1 }],
        },
      },
    })
    const stat = (items: { key: string; count: number }[], key: string) => items.find(item => item.key === key)?.count
    expect(stat(capture.history.days[0].complete!.stats.regions, 'europe')).toBe(2)
    expect(stat(capture.history.days[0].complete!.stats.roles, 'backend')).toBe(2)
    expect(stat(capture.history.days[0].complete!.stats.workModes, 'onsite')).toBe(2)
    expect(capture.observationCheckpoint).toMatchObject({ version: 1, series: [{ method: OBSERVATION_METHOD }] })
    expect(capture.observationCheckpoint.series).toHaveLength(1)
    expect(capture.observationCheckpoint.series[0].scope).toEqual(capture.history.scope)
    expect(capture.observationCheckpoint.series[0].days).toEqual(capture.history.days)
  })

  it('an empty public board is a complete result, not a failure', async () => {
    const h = publicationHarness()
    h.emptyBody(BIRCH)
    const { capture } = await h.run()
    expect(capture.catalog.boards[1]).toMatchObject({ ...birch, status: 'ok', dataStatus: 'fresh', total: 0, included: 0, lastSuccessAt: T('06:00:00.000'), retryAt: null })
    expect(capture.catalog.jobs.map(job => job.id)).toEqual([ALDER_JOB])
    expect(capture.postingStatus.boards[1]).toMatchObject({
      status: 'ok', lastSuccessAt: T('06:00:00.000'),
      listing: { validUntil: T('06:30:00.000'), publishedIds: [], jobs: [], content: { checkedAt: T('06:00:00.000'), status: 'ok', jobIds: [] } },
    })
    expect(capture.boards[1].snapshot).toMatchObject({ fetchedAt: T('06:00:00.000'), total: 0, jobs: [], publishedIds: [], unmappedCount: 0 })
    expect(capture.history.days[0].latest.boards.map(board => board.status)).toEqual(['complete', 'complete'])
    expect(capture.history.days[0].complete?.stats).toMatchObject({
      published: 1, technical: 1, openings: 1,
      companies: [{ companyId: ALDER, count: 1 }, { companyId: BIRCH, count: 0 }],
    })
  })
})

describe('two consecutive scheduled runs', () => {
  it('a run ten minutes later restores the checkpoint, makes no provider request and renews no source clock', async () => {
    const h = publicationHarness()
    const first = await h.run()
    h.at(T('06:10:00.000'))
    const second = await h.run(checkpointFrom(first.capture))
    expect(h.listCalls()).toHaveLength(2)
    expect(h.bodyCalls()).toHaveLength(2)
    expect(h.ledger()).toHaveLength(8)
    expect(second.metrics).toEqual([])
    expect(second.capture.capturedAt).toBe(T('06:10:00.000'))
    expect(second.capture.catalog).toMatchObject({
      fetchedAt: T('06:00:00.000'), checkedAt: T('06:00:00.000'), refreshAfter: T('06:01:00.000'), stale: false,
      boards: [
        { ...alder, status: 'ok', dataStatus: 'fresh', checkedAt: T('06:00:00.000'), lastSuccessAt: T('06:00:00.000'), retryAt: null },
        { ...birch, status: 'ok', dataStatus: 'fresh', checkedAt: T('06:00:00.000'), lastSuccessAt: T('06:00:00.000'), retryAt: null },
      ],
    })
    expect(second.capture.catalog.jobs).toEqual(first.capture.catalog.jobs)
    expect(second.capture.postingStatus).toEqual(first.capture.postingStatus)
    expect(second.capture.boards).toEqual(first.capture.boards)
    expect(second.capture.presences).toEqual(first.capture.presences)
    expect(second.capture.clocks).toEqual(first.capture.clocks)
    // Reopening the checkpoint neither creates nor renews an observation.
    expect(second.capture.observationCheckpoint).toEqual(first.capture.observationCheckpoint)
    expect(second.capture.history).toEqual(first.capture.history)
  })

  it('a run at the thirty-minute freshness boundary collects both passes again and advances every clock', async () => {
    const h = publicationHarness()
    const first = await h.run()
    h.at(T('06:29:59.999'))
    const early = await h.run(checkpointFrom(first.capture))
    expect(h.listCalls()).toHaveLength(2)
    expect(h.bodyCalls()).toHaveLength(2)
    expect(early.capture.catalog.boards.map(board => board.dataStatus)).toEqual(['fresh', 'fresh'])
    h.at(T('06:30:00.000'))
    const second = await h.run(checkpointFrom(early.capture))
    expect([...h.listCalls().slice(2)].sort()).toEqual([ALDER, BIRCH])
    expect([...h.bodyCalls().slice(2)].sort()).toEqual([ALDER, BIRCH])
    const order = passOrder(h.ledger().slice(8))
    expect(order.firstBody).toBeGreaterThan(order.lastList)
    expect(second.capture.catalog).toMatchObject({
      fetchedAt: T('06:30:00.000'), checkedAt: T('06:30:00.000'), refreshAfter: T('06:31:00.000'), stale: false,
      boards: [
        { ...alder, status: 'ok', dataStatus: 'fresh', checkedAt: T('06:30:00.000'), lastSuccessAt: T('06:30:00.000') },
        { ...birch, status: 'ok', dataStatus: 'fresh', checkedAt: T('06:30:00.000'), lastSuccessAt: T('06:30:00.000') },
      ],
    })
    expect(second.capture.postingStatus).toMatchObject({
      checkedAt: T('06:30:00.000'), refreshAfter: T('06:31:00.000'), contentRefreshAfter: T('06:31:00.000'),
      boards: [
        { lastSuccessAt: T('06:30:00.000'), listing: { validUntil: T('07:00:00.000'), content: { checkedAt: T('06:30:00.000'), validUntil: T('07:00:00.000'), status: 'ok' } } },
        { lastSuccessAt: T('06:30:00.000'), listing: { validUntil: T('07:00:00.000'), content: { checkedAt: T('06:30:00.000'), validUntil: T('07:00:00.000'), status: 'ok' } } },
      ],
    })
    expect(second.capture.clocks).toEqual([
      { companyId: ALDER, inventoryDeadline: T('06:31:00.000'), contentDeadline: T('06:31:00.000'), postingCheckedAt: T('06:30:00.000') },
      { companyId: BIRCH, inventoryDeadline: T('06:31:00.000'), contentDeadline: T('06:31:00.000'), postingCheckedAt: T('06:30:00.000') },
    ])
    expect(second.capture.history.days).toHaveLength(1)
    expect(second.capture.history.days[0]).toMatchObject({
      day: '2026-10-03',
      latest: { observedAt: T('06:30:00.000'), recordedAt: T('06:30:00.000'), origin: 'collection' },
      complete: { observedAt: T('06:30:00.000'), comparable: true, stats: { openings: 2 } },
    })
  })

  it('a daily source stays out of both passes until exactly twenty-four hours', async () => {
    const h = publicationHarness({ companies: [PROVENANCE_ALDER, PROVENANCE_CEDAR_DAILY] })
    const first = await h.run()
    expect([...h.listCalls()].sort()).toEqual([ALDER, CEDAR])
    expect([...h.bodyCalls()].sort()).toEqual([ALDER, CEDAR])
    h.at(T('06:30:00.000'))
    const second = await h.run(checkpointFrom(first.capture))
    expect(h.listCalls().slice(2)).toEqual([ALDER])
    expect(h.bodyCalls().slice(2)).toEqual([ALDER])
    expect(second.capture.catalog.boards).toMatchObject([
      { companyId: ALDER, dataStatus: 'fresh', lastSuccessAt: T('06:30:00.000') },
      { companyId: CEDAR, provider: 'himalayas', dataStatus: 'fresh', lastSuccessAt: T('06:00:00.000') },
    ])
    expect(second.capture.postingStatus.boards[1]).toMatchObject({
      lastSuccessAt: T('06:00:00.000'),
      listing: { validUntil: '2026-10-04T06:00:00.000Z', content: { checkedAt: T('06:00:00.000'), validUntil: '2026-10-04T06:00:00.000Z', status: 'ok' } },
    })
    expect(second.capture.clocks[1]).toEqual({
      companyId: CEDAR, inventoryDeadline: '2026-10-04T06:00:00.000Z', contentDeadline: '2026-10-04T06:00:00.000Z', postingCheckedAt: T('06:00:00.000'),
    })
    h.at('2026-10-04T05:59:59.999Z')
    const beforeDeadline = await h.run(checkpointFrom(second.capture))
    expect(h.listCalls().filter(id => id === CEDAR)).toHaveLength(1)
    expect(h.bodyCalls().filter(id => id === CEDAR)).toHaveLength(1)
    expect(beforeDeadline.capture.catalog.boards[1]).toMatchObject({ dataStatus: 'fresh', lastSuccessAt: T('06:00:00.000') })
    h.at('2026-10-04T06:00:00.000Z')
    const third = await h.run(checkpointFrom(beforeDeadline.capture))
    expect(h.listCalls().filter(id => id === CEDAR)).toHaveLength(2)
    expect(h.bodyCalls().filter(id => id === CEDAR)).toHaveLength(2)
    expect(third.capture.catalog.boards[1]).toMatchObject({ dataStatus: 'fresh', lastSuccessAt: '2026-10-04T06:00:00.000Z' })
  })
})

describe('failures and backoff across scheduled runs', () => {
  it('a first-run body failure keeps the list success, backs off one minute and is retried only at its deadline', async () => {
    const h = publicationHarness()
    h.failBody(BIRCH, PUBLICATION_FAILURES.body)
    const first = await h.run()
    expect(h.ledger().filter(event => event.phase === 'end' && event.outcome === 'error')).toEqual([
      { kind: 'body', companyId: BIRCH, phase: 'end', outcome: 'error', at: T('06:00:00.000') },
    ])
    expect(first.capture.boards[1]).toMatchObject({
      ...birch, checkedAt: T('06:00:00.000'), failures: 1, retryAt: T('06:01:00.000'),
      error: 'Fictional publication body 503', errorPhase: 'content',
    })
    expect(first.capture.boards[1].snapshot).toBeUndefined()
    expect(first.capture.presences[1]).toMatchObject({ ...birch, checkedAt: T('06:00:00.000'), failures: 0, retryAt: null, snapshot: { publishedIds: [BIRCH_JOB] } })
    expect(first.capture.catalog).toMatchObject({
      fetchedAt: T('06:00:00.000'), checkedAt: T('06:00:00.000'), refreshAfter: T('06:01:00.000'), stale: false,
      boards: [
        { ...alder, status: 'ok', dataStatus: 'fresh', total: 1, included: 1 },
        {
          ...birch, status: 'error', dataStatus: 'unavailable', total: 0, included: 0, checkedAt: T('06:00:00.000'),
          lastSuccessAt: null, retryAt: T('06:01:00.000'), message: 'Fictional publication body 503',
        },
      ],
    })
    expect(first.capture.catalog.jobs.map(job => job.id)).toEqual([ALDER_JOB])
    expect(first.capture.postingStatus.boards[1]).toMatchObject({
      ...birch, status: 'ok', checkedAt: T('06:00:00.000'), lastSuccessAt: T('06:00:00.000'), retryAt: null,
      listing: { validUntil: T('06:30:00.000'), publishedIds: [BIRCH_JOB], jobs: [] },
    })
    expect(first.capture.postingStatus.boards[1].listing?.content).toBeUndefined()
    expect(first.capture.clocks[1]).toEqual({ companyId: BIRCH, inventoryDeadline: T('06:01:00.000'), contentDeadline: T('06:01:00.000'), postingCheckedAt: T('06:00:00.000') })
    expect(first.capture.history.days[0].latest.boards[1]).toEqual({ companyId: BIRCH, status: 'error', checkedAt: T('06:00:00.000'), lastSuccessAt: null })
    expect(first.capture.history.days[0].complete).toBeUndefined()
    expect(sortedMetrics(first.metrics)).toEqual([
      { pass: 'content', provider: 'greenhouse', boards: 1, requests: 0, failedRequests: 0 },
      { pass: 'content', provider: 'smartrecruiters', boards: 1, requests: 0, failedRequests: 0 },
      { pass: 'inventory', provider: 'greenhouse', boards: 1, requests: 0, failedRequests: 0 },
      { pass: 'inventory', provider: 'smartrecruiters', boards: 1, requests: 0, failedRequests: 0 },
    ])

    // Thirty seconds later nothing is due: the failure and its deadline survive unchanged.
    h.at(T('06:00:30.000'))
    const waiting = await h.run(checkpointFrom(first.capture))
    expect(h.listCalls()).toHaveLength(2)
    expect(h.bodyCalls()).toHaveLength(2)
    expect(waiting.capture.boards[1]).toEqual(first.capture.boards[1])
    expect(waiting.capture.catalog.boards[1]).toEqual(first.capture.catalog.boards[1])
    expect(waiting.capture.observationCheckpoint).toEqual(first.capture.observationCheckpoint)

    // Exactly at the deadline only the failed body is retried; a second failure doubles the backoff.
    h.at(T('06:01:00.000'))
    const retried = await h.run(checkpointFrom(waiting.capture))
    expect(h.listCalls()).toHaveLength(2)
    expect(h.bodyCalls().slice(2)).toEqual([BIRCH])
    expect(retried.capture.boards[1]).toMatchObject({
      checkedAt: T('06:01:00.000'), failures: 2, retryAt: T('06:03:00.000'), error: 'Fictional publication body 503', errorPhase: 'content',
    })
    expect(retried.capture.catalog.boards[1]).toMatchObject({ status: 'error', dataStatus: 'unavailable', checkedAt: T('06:01:00.000'), retryAt: T('06:03:00.000'), lastSuccessAt: null })
    expect(retried.capture.catalog.boards[0]).toMatchObject({ status: 'ok', dataStatus: 'fresh', checkedAt: T('06:00:00.000'), lastSuccessAt: T('06:00:00.000') })
    expect(retried.capture.catalog.refreshAfter).toBe(T('06:01:00.000'))
    expect(retried.capture.history.days).toHaveLength(1)
    expect(retried.capture.history.days[0].latest).toMatchObject({
      observedAt: T('06:01:00.000'), origin: 'collection',
      boards: [{ companyId: ALDER, status: 'complete' }, { companyId: BIRCH, status: 'error', checkedAt: T('06:01:00.000'), lastSuccessAt: null }],
    })
    expect(retried.capture.history.days[0].complete).toBeUndefined()

    // Recovery at the doubled deadline collects the body, seeds the list time and completes the day.
    h.at(T('06:03:00.000'))
    h.fetchBoard.mockImplementation(async (company, fetchedAt) => contentResult(company, fetchedAt))
    const recovered = await h.run(checkpointFrom(retried.capture))
    expect(h.bodyCalls().slice(3)).toEqual([BIRCH])
    expect(h.listCalls()).toHaveLength(2)
    expect(recovered.capture.boards[1]).toMatchObject({ checkedAt: T('06:03:00.000'), failures: 0, retryAt: null, snapshot: { fetchedAt: T('06:03:00.000'), publishedIds: [BIRCH_JOB] } })
    expect(recovered.capture.boards[1].error).toBeUndefined()
    expect(recovered.capture.presences[1]).toMatchObject({ checkedAt: T('06:03:00.000'), failures: 0, snapshot: { fetchedAt: T('06:03:00.000') } })
    expect(recovered.capture.catalog.boards[1]).toMatchObject({ status: 'ok', dataStatus: 'fresh', checkedAt: T('06:03:00.000'), lastSuccessAt: T('06:03:00.000'), retryAt: null })
    expect(recovered.capture.catalog.jobs.map(job => [job.id, job.fetchedAt])).toEqual([[ALDER_JOB, T('06:00:00.000')], [BIRCH_JOB, T('06:03:00.000')]])
    expect(recovered.capture.history.days[0].complete).toMatchObject({ observedAt: T('06:03:00.000'), comparable: true, stats: { openings: 2 } })
  })

  it('a body failure after an earlier success keeps the old snapshot stale with its original success time and marks body content as failed', async () => {
    const h = publicationHarness()
    const first = await h.run()
    h.at(T('06:30:00.000'))
    h.failBody(BIRCH, PUBLICATION_FAILURES.body)
    const second = await h.run(checkpointFrom(first.capture))
    expect([...h.listCalls().slice(2)].sort()).toEqual([ALDER, BIRCH])
    expect([...h.bodyCalls().slice(2)].sort()).toEqual([ALDER, BIRCH])
    expect(second.capture.boards[1]).toMatchObject({
      checkedAt: T('06:30:00.000'), failures: 1, retryAt: T('06:31:00.000'), error: 'Fictional publication body 503', errorPhase: 'content',
      snapshot: { fetchedAt: T('06:00:00.000'), publishedIds: [BIRCH_JOB] },
    })
    expect(second.capture.presences[1]).toMatchObject({ checkedAt: T('06:30:00.000'), failures: 0, retryAt: null, snapshot: { fetchedAt: T('06:30:00.000'), publishedIds: [BIRCH_JOB] } })
    expect(second.capture.catalog).toMatchObject({
      fetchedAt: T('06:30:00.000'), checkedAt: T('06:30:00.000'), refreshAfter: T('06:31:00.000'), stale: true,
      boards: [
        { ...alder, status: 'ok', dataStatus: 'fresh', checkedAt: T('06:30:00.000'), lastSuccessAt: T('06:30:00.000') },
        {
          ...birch, status: 'error', dataStatus: 'stale', total: 1, included: 1, checkedAt: T('06:30:00.000'),
          lastSuccessAt: T('06:00:00.000'), retryAt: T('06:31:00.000'), message: 'Fictional publication body 503',
        },
      ],
    })
    expect(second.capture.catalog.jobs.map(job => [job.id, job.stale, job.fetchedAt])).toEqual([
      [ALDER_JOB, false, T('06:30:00.000')], [BIRCH_JOB, true, T('06:00:00.000')],
    ])
    expect(second.capture.postingStatus.boards[1]).toMatchObject({
      status: 'ok', checkedAt: T('06:30:00.000'), lastSuccessAt: T('06:30:00.000'), retryAt: null,
      listing: {
        validUntil: T('07:00:00.000'), publishedIds: [BIRCH_JOB], jobs: [],
        content: { checkedAt: T('06:00:00.000'), validUntil: T('06:30:00.000'), status: 'error', jobIds: [BIRCH_JOB] },
      },
    })
    expect(second.capture.postingStatus.boards[1].message).toBeUndefined()
    expect(second.capture.postingStatus).toMatchObject({ refreshAfter: T('06:31:00.000'), contentRefreshAfter: T('06:31:00.000') })
    expect(second.capture.clocks[1]).toEqual({ companyId: BIRCH, inventoryDeadline: T('06:31:00.000'), contentDeadline: T('06:31:00.000'), postingCheckedAt: T('06:30:00.000') })
    expect(second.capture.history.days[0].latest.boards[1]).toEqual({ companyId: BIRCH, status: 'error', checkedAt: T('06:30:00.000'), lastSuccessAt: T('06:00:00.000') })
    // The earlier complete point of the same day is kept rather than replaced by the failed attempt.
    expect(second.capture.history.days[0].complete).toEqual(first.capture.history.days[0].complete)
  })

  it('a list failure after an earlier success defers that body, ages out its summaries and keeps the body metadata', async () => {
    const h = publicationHarness()
    const first = await h.run()
    h.at(T('06:30:00.000'))
    h.failList(BIRCH, PUBLICATION_FAILURES.list)
    const second = await h.run(checkpointFrom(first.capture))
    expect([...h.listCalls().slice(2)].sort()).toEqual([ALDER, BIRCH])
    expect(h.bodyCalls().slice(2)).toEqual([ALDER])
    expect(second.capture.presences[1]).toMatchObject({
      checkedAt: T('06:30:00.000'), failures: 1, retryAt: T('06:31:00.000'), error: 'Fictional publication list 503',
      snapshot: { fetchedAt: T('06:00:00.000'), publishedIds: [BIRCH_JOB] },
    })
    expect(second.capture.boards[1]).toEqual(first.capture.boards[1])
    expect(second.capture.catalog).toMatchObject({
      fetchedAt: T('06:30:00.000'), checkedAt: T('06:30:00.000'), refreshAfter: T('06:31:00.000'), stale: true,
      boards: [
        { ...alder, status: 'ok', dataStatus: 'fresh', lastSuccessAt: T('06:30:00.000') },
        {
          ...birch, status: 'error', dataStatus: 'stale', total: 1, included: 1, checkedAt: T('06:30:00.000'),
          lastSuccessAt: T('06:00:00.000'), retryAt: T('06:31:00.000'), message: 'Fictional publication list 503',
        },
      ],
    })
    expect(second.capture.catalog.jobs.map(job => [job.id, job.stale])).toEqual([[ALDER_JOB, false], [BIRCH_JOB, true]])
    expect(second.capture.postingStatus.boards[1]).toMatchObject({
      status: 'error', message: 'Fictional publication list 503', checkedAt: T('06:30:00.000'),
      lastSuccessAt: T('06:00:00.000'), retryAt: T('06:31:00.000'),
      listing: {
        validUntil: T('06:30:00.000'), publishedIds: [BIRCH_JOB], jobs: [],
        content: { checkedAt: T('06:00:00.000'), validUntil: T('06:30:00.000'), status: 'ok', jobIds: [BIRCH_JOB] },
      },
    })
    expect(second.capture.postingStatus).toMatchObject({ checkedAt: T('06:30:00.000'), refreshAfter: T('06:31:00.000'), contentRefreshAfter: T('06:31:00.000') })
    expect(second.capture.clocks).toEqual([
      { companyId: ALDER, inventoryDeadline: T('06:31:00.000'), contentDeadline: T('06:31:00.000'), postingCheckedAt: T('06:30:00.000') },
      { companyId: BIRCH, inventoryDeadline: T('06:31:00.000'), contentDeadline: T('06:31:00.000'), postingCheckedAt: T('06:30:00.000') },
    ])
    // Body history is untouched by a list failure: the day keeps the earlier complete point, and the
    // untouched body is now exactly thirty minutes older than the attempt, so it is observed as stale.
    expect(second.capture.history.days[0].complete).toEqual(first.capture.history.days[0].complete)
    expect(second.capture.history.days[0].latest).toMatchObject({ observedAt: T('06:30:00.000'), origin: 'collection' })
    expect(second.capture.history.days[0].latest.boards).toEqual([
      { companyId: ALDER, status: 'complete', checkedAt: T('06:30:00.000'), lastSuccessAt: T('06:30:00.000') },
      { companyId: BIRCH, status: 'stale', checkedAt: T('06:00:00.000'), lastSuccessAt: T('06:00:00.000') },
    ])
  })

  it('when every first-run list check fails, no body is requested and the capture is an honest all-unavailable state', async () => {
    const h = publicationHarness()
    h.failEveryList(PUBLICATION_FAILURES.list)
    const { capture, metrics } = await h.run()
    expect([...h.listCalls()].sort()).toEqual([ALDER, BIRCH])
    expect(h.bodyCalls()).toEqual([])
    expect(capture.boards).toEqual([])
    expect(capture.presences).toMatchObject([
      { ...alder, checkedAt: T('06:00:00.000'), failures: 1, retryAt: T('06:01:00.000'), error: 'Fictional publication list 503' },
      { ...birch, checkedAt: T('06:00:00.000'), failures: 1, retryAt: T('06:01:00.000'), error: 'Fictional publication list 503' },
    ])
    expect(capture.catalog).toMatchObject({
      fetchedAt: '', checkedAt: T('06:00:00.000'), refreshAfter: T('06:01:00.000'), stale: false, jobs: [], unmappedCount: 0,
      boards: [
        { ...alder, status: 'error', dataStatus: 'unavailable', total: 0, included: 0, checkedAt: T('06:00:00.000'), lastSuccessAt: null, retryAt: T('06:01:00.000'), message: 'Fictional publication list 503' },
        { ...birch, status: 'error', dataStatus: 'unavailable', total: 0, included: 0, checkedAt: T('06:00:00.000'), lastSuccessAt: null, retryAt: T('06:01:00.000'), message: 'Fictional publication list 503' },
      ],
    })
    expect(capture.postingStatus).toMatchObject({
      version: 2, checkedAt: T('06:00:00.000'), refreshAfter: T('06:01:00.000'), contentRefreshAfter: T('06:01:00.000'),
      boards: [
        { ...alder, status: 'error', checkedAt: T('06:00:00.000'), lastSuccessAt: null, retryAt: T('06:01:00.000'), message: 'Fictional publication list 503' },
        { ...birch, status: 'error', checkedAt: T('06:00:00.000'), lastSuccessAt: null, retryAt: T('06:01:00.000'), message: 'Fictional publication list 503' },
      ],
    })
    expect(capture.postingStatus.boards.map(board => board.listing)).toEqual([undefined, undefined])
    expect(capture.clocks).toEqual([
      { companyId: ALDER, inventoryDeadline: T('06:01:00.000'), contentDeadline: T('06:01:00.000'), postingCheckedAt: T('06:00:00.000') },
      { companyId: BIRCH, inventoryDeadline: T('06:01:00.000'), contentDeadline: T('06:01:00.000'), postingCheckedAt: T('06:00:00.000') },
    ])
    expect(capture.history).toMatchObject({ storage: 'ok', days: [], otherSeries: [] })
    expect(capture.observationCheckpoint).toEqual({ version: 1, series: [] })
    expect(sortedMetrics(metrics)).toEqual([
      { pass: 'inventory', provider: 'greenhouse', boards: 1, requests: 0, failedRequests: 0 },
      { pass: 'inventory', provider: 'smartrecruiters', boards: 1, requests: 0, failedRequests: 0 },
    ])
  })

  it('a provider Retry-After later than the exponential backoff becomes the shared deadline', async () => {
    const h = publicationHarness()
    h.failList(BIRCH, 'HTTP 429', T('06:11:00.000'))
    const { capture } = await h.run()
    expect(capture.presences[1]).toMatchObject({ failures: 1, retryAt: T('06:11:00.000'), error: 'HTTP 429' })
    expect(capture.catalog.boards[1]).toMatchObject({ status: 'error', dataStatus: 'unavailable', retryAt: T('06:11:00.000') })
    expect(capture.postingStatus.boards[1]).toMatchObject({ status: 'error', retryAt: T('06:11:00.000') })
    expect(capture.clocks[1]).toEqual({ companyId: BIRCH, inventoryDeadline: T('06:11:00.000'), contentDeadline: T('06:11:00.000'), postingCheckedAt: T('06:00:00.000') })
    expect(capture.catalog.refreshAfter).toBe(T('06:01:00.000'))
    expect(h.bodyCalls()).toEqual([ALDER])
    h.at(T('06:10:59.999'))
    await h.run(checkpointFrom(capture))
    expect(h.listCalls().filter(id => id === BIRCH)).toHaveLength(1)
    expect(h.bodyCalls().filter(id => id === BIRCH)).toHaveLength(0)
  })
})

describe('registry changes between runs', () => {
  it('a normal registry change reuses only matching boards, collects new companies and keeps the old observation series', async () => {
    const h = publicationHarness()
    const first = await h.run()
    const oldScopeKey = first.capture.history.scope.key
    h.at(T('06:10:00.000'))
    const second = await h.run(checkpointFrom(first.capture), { companies: [PROVENANCE_ALDER, PROVENANCE_CEDAR_DAILY] })
    expect(h.listCalls().slice(2)).toEqual([CEDAR])
    expect(h.bodyCalls().slice(2)).toEqual([CEDAR])
    expect(second.capture.catalog.companies).toEqual([PROVENANCE_ALDER, PROVENANCE_CEDAR_DAILY])
    expect(second.capture.boards.map(board => [board.companyId, board.checkedAt])).toEqual([[ALDER, T('06:00:00.000')], [CEDAR, T('06:10:00.000')]])
    expect(second.capture.presences.map(entry => [entry.companyId, entry.checkedAt])).toEqual([[ALDER, T('06:00:00.000')], [CEDAR, T('06:10:00.000')]])
    expect(second.capture.boards[0]).toEqual(first.capture.boards[0])
    expect(second.capture.catalog.boards).toMatchObject([
      { companyId: ALDER, dataStatus: 'fresh', lastSuccessAt: T('06:00:00.000') },
      { companyId: CEDAR, dataStatus: 'fresh', lastSuccessAt: T('06:10:00.000') },
    ])
    expect(second.capture.history.scope.boards.map(board => board.companyId)).toEqual([ALDER, CEDAR])
    expect(second.capture.history.scope.key).not.toBe(oldScopeKey)
    expect(second.capture.history.days).toHaveLength(1)
    expect(second.capture.history.days[0]).toMatchObject({
      day: '2026-10-03',
      latest: { observedAt: T('06:10:00.000'), origin: 'collection', boards: [{ companyId: ALDER, status: 'complete' }, { companyId: CEDAR, status: 'complete' }] },
      complete: { observedAt: T('06:10:00.000'), comparable: true, stats: { openings: 2 } },
    })
    expect(second.capture.history.otherSeries).toEqual([
      { scopeKey: oldScopeKey, method: OBSERVATION_METHOD, firstDay: '2026-10-03', lastDay: '2026-10-03', companyCount: 2 },
    ])
    expect(second.capture.observationCheckpoint.series).toHaveLength(2)
    const retainedOld = second.capture.observationCheckpoint.series.find(series => series.scope.key === oldScopeKey)
    expect(retainedOld).toEqual(first.capture.observationCheckpoint.series[0])
    const current = second.capture.observationCheckpoint.series.find(series => series.scope.key === second.capture.history.scope.key)
    expect(current?.days).toEqual(second.capture.history.days)
  })

  it('the configuration ID depends on company, provider, board and region but not on registry order', async () => {
    const forward = publicationConfigurationId([PROVENANCE_ALDER, PROVENANCE_BIRCH])
    expect(forward).toMatch(HEX64)
    expect(publicationConfigurationId([PROVENANCE_BIRCH, PROVENANCE_ALDER])).toBe(forward)
    expect(publicationConfigurationId([{ ...PROVENANCE_ALDER, name: 'Renamed display name', color: '#000000' }, PROVENANCE_BIRCH])).toBe(forward)
    expect(publicationConfigurationId([{ ...PROVENANCE_ALDER, board: 'AlderRenamed' }, PROVENANCE_BIRCH])).not.toBe(forward)
    expect(publicationConfigurationId([{ ...PROVENANCE_ALDER, provider: 'lever' }, PROVENANCE_BIRCH])).not.toBe(forward)
    expect(publicationConfigurationId([{ ...PROVENANCE_ALDER, provider: 'lever', boardRegion: 'eu' }, PROVENANCE_BIRCH]))
      .not.toBe(publicationConfigurationId([{ ...PROVENANCE_ALDER, provider: 'lever' }, PROVENANCE_BIRCH]))
    expect(publicationConfigurationId([PROVENANCE_ALDER])).not.toBe(forward)
    for (const invalid of [
      [],
      [PROVENANCE_ALDER, PROVENANCE_ALDER],
      [PROVENANCE_ALDER, { ...PROVENANCE_BIRCH, board: undefined }],
    ]) expect(() => publicationConfigurationId(invalid as Company[])).toThrow('Invalid publication company registry')
    const fetchBoard = vi.fn()
    const fetchPresence = vi.fn()
    await expect(collectPublication({ companies: [PROVENANCE_ALDER, PROVENANCE_ALDER], fetchBoard, fetchPresence }))
      .rejects.toThrow('Invalid publication company registry')
    expect(fetchBoard).not.toHaveBeenCalled()
    expect(fetchPresence).not.toHaveBeenCalled()
  })

  it('exposes a plain SHA-256 helper whose output equals an independent digest', () => {
    expect(publicationHash('fictional publication bytes')).toBe(createHash('sha256').update('fictional publication bytes').digest('hex'))
    expect(publicationHash(new Uint8Array([1, 2, 3]))).toBe(createHash('sha256').update(new Uint8Array([1, 2, 3])).digest('hex'))
  })
})

describe('HTTP measurement inside the exclusive collector process', () => {
  it('attributes fetch calls and failed responses to the pass and provider that made them, then restores the global fetch', async () => {
    const original = globalThis.fetch
    const stub = vi.fn(async (input: string | URL | Request) =>
      new Response(null, { status: String(input).endsWith('/detail') ? 429 : 200 }))
    globalThis.fetch = stub as unknown as typeof fetch
    try {
      const h = publicationHarness()
      h.fetchPresence.mockImplementation(async company => {
        await fetch(`https://fixture.invalid/${company.id}/list`)
        return presenceResult(company)
      })
      h.fetchBoard.mockImplementation(async (company, fetchedAt) => {
        await fetch(`https://fixture.invalid/${company.id}/list`)
        await fetch(`https://fixture.invalid/${company.id}/detail`)
        return contentResult(company, fetchedAt)
      })
      const measured = await h.run(undefined, { measureHttp: true })
      expect(sortedMetrics(measured.metrics)).toEqual([
        { pass: 'content', provider: 'greenhouse', boards: 1, requests: 2, failedRequests: 1 },
        { pass: 'content', provider: 'smartrecruiters', boards: 1, requests: 2, failedRequests: 1 },
        { pass: 'inventory', provider: 'greenhouse', boards: 1, requests: 1, failedRequests: 0 },
        { pass: 'inventory', provider: 'smartrecruiters', boards: 1, requests: 1, failedRequests: 0 },
      ])
      expect(stub).toHaveBeenCalledTimes(6)
      expect(globalThis.fetch).toBe(stub)
      // Without measurement the same requests are not counted and the global is never replaced.
      const unmeasured = await h.run(undefined, { measureHttp: false })
      expect(unmeasured.metrics.every(metric => metric.requests === 0 && metric.failedRequests === 0)).toBe(true)
      expect(stub).toHaveBeenCalledTimes(12)
      expect(globalThis.fetch).toBe(stub)
    } finally {
      globalThis.fetch = original
    }
  })

  it('an exceptional operation fails the whole run and restores the global fetch', async () => {
    const original = globalThis.fetch
    const stub = vi.fn(async () => new Response(null, { status: 200 }))
    globalThis.fetch = stub as unknown as typeof fetch
    try {
      const h = publicationHarness()
      h.failBody(BIRCH, PUBLICATION_FAILURES.body)
      await expect(h.run(undefined, { measureHttp: true, random: () => { throw new Error(PUBLICATION_FAILURES.jitter) } }))
        .rejects.toThrow('공고 조회를 완료하지 못했어요. 다시 조회해 주세요.')
      expect(globalThis.fetch).toBe(stub)
    } finally {
      globalThis.fetch = original
    }
  })
})

/** The real service in publication mode over memory stores; failures are injected at the store boundary. */
function publicationService(options: {
  boardSave?: (boards: CachedBoard[]) => Promise<void>
  observationSave?: (value: unknown) => Promise<void>
  publicationMode?: boolean
  presence?: boolean
  observations?: 'store' | 'legacy' | 'none'
} = {}) {
  let time = Date.parse(RUN_ONE)
  let boards: CachedBoard[] = []
  let presences: CachedPresence[] = []
  let history: unknown = { version: 1, series: [] }
  const onCacheError = vi.fn()
  const onObservationError = vi.fn()
  const fetchBoard = vi.fn(async (company: Company, fetchedAt: string): Promise<BoardResult> => contentResult(company, fetchedAt))
  const fetchPresence = vi.fn(async (company: Company): Promise<PresenceResult> => presenceResult(company))
  const store = createObservationStore({
    companies: PROVENANCE_COMPANIES, now: () => time, onError: onObservationError,
    cache: {
      load: async () => structuredClone(history),
      save: options.observationSave ?? (async value => { history = structuredClone(value) }),
    },
  })
  const observations = options.observations === 'none' ? undefined
    : options.observations === 'legacy' ? { method: store.method, record: store.record, read: store.read }
    : store
  const service = createCatalogService({
    companies: PROVENANCE_COMPANIES,
    cache: { load: async () => structuredClone(boards), save: options.boardSave ?? (async value => { boards = structuredClone(value) }) },
    fetchBoard,
    ...(options.presence === false ? {} : {
      presence: { cache: { load: async () => structuredClone(presences), save: async value => { presences = structuredClone(value) } }, fetchBoard: fetchPresence },
    }),
    observations, now: () => time, random: () => 0, onCacheError,
    publicationMode: options.publicationMode ?? true,
  })
  return { service, fetchBoard, fetchPresence, onCacheError, onObservationError, at: (value: string) => { time = Date.parse(value) }, history: () => history }
}

describe('exclusive one-shot publication instance', () => {
  it('refuses every HTTP getter before and after its single capture', async () => {
    const { service, fetchBoard, fetchPresence } = publicationService()
    const refusal = 'A publication instance only supports collectPublication()'
    await expect(service.get()).rejects.toThrow(refusal)
    await expect(service.getProgressive()).rejects.toThrow(refusal)
    await expect(service.getPostingStatus(true)).rejects.toThrow(refusal)
    await expect(service.getPostingStatus(true, true)).rejects.toThrow(refusal)
    await expect(service.getObservations()).rejects.toThrow(refusal)
    expect(() => service.readProgress('00000000-0000-0000-0000-000000000000', 0)).toThrow(refusal)
    expect(fetchBoard).not.toHaveBeenCalled()
    expect(fetchPresence).not.toHaveBeenCalled()
    const capture = await service.collectPublication()
    expect(capture.catalog.jobs.map(job => job.id)).toEqual([ALDER_JOB, BIRCH_JOB])
    await expect(service.get()).rejects.toThrow(refusal)
    await expect(service.getPostingStatus()).rejects.toThrow(refusal)
    expect(fetchBoard).toHaveBeenCalledTimes(2)
    expect(fetchPresence).toHaveBeenCalledTimes(2)
  })

  it('allows exactly one capture per instance, including when a second request arrives while the first is still running', async () => {
    const { service, fetchBoard, fetchPresence } = publicationService()
    const refusal = 'Publication requires a fresh exclusive instance with presence and restorable observations'
    const first = service.collectPublication()
    await expect(service.collectPublication()).rejects.toThrow(refusal)
    const capture = await first
    expect(capture.capturedAt).toBe(RUN_ONE)
    await expect(service.collectPublication()).rejects.toThrow(refusal)
    expect(fetchBoard).toHaveBeenCalledTimes(2)
    expect(fetchPresence).toHaveBeenCalledTimes(2)
  })

  it('is unavailable on interactive instances and on instances without presence or restorable observations', async () => {
    const refusal = 'Publication requires a fresh exclusive instance with presence and restorable observations'
    for (const setup of [
      publicationService({ publicationMode: false }),
      publicationService({ presence: false }),
      publicationService({ observations: 'legacy' }),
      publicationService({ observations: 'none' }),
    ]) {
      await expect(setup.service.collectPublication()).rejects.toThrow(refusal)
      expect(setup.fetchBoard).not.toHaveBeenCalled()
      expect(setup.fetchPresence).not.toHaveBeenCalled()
    }
    const interactive = publicationService({ publicationMode: false })
    const catalog = await interactive.service.get()
    expect(catalog.jobs.map(job => job.id)).toEqual([ALDER_JOB, BIRCH_JOB])
  })

  it('waits for the observation record to persist before capturing, even when the store is slow', async () => {
    // NT82-2: the save boundary signals entry explicitly; the latch is always released.
    let release!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    let enter!: () => void
    const entered = new Promise<void>(resolve => { enter = resolve })
    let stored: unknown
    const setup = publicationService({ observationSave: async value => { enter(); await held; stored = structuredClone(value) } })
    const pending = setup.service.collectPublication()
    let settled = false
    void pending.then(() => { settled = true }, () => { settled = true })
    try {
      await entered
      await new Promise(resolve => setImmediate(resolve))
      expect(settled).toBe(false)
      expect(stored).toBeUndefined()
      expect(setup.fetchBoard).toHaveBeenCalledTimes(2)
    } finally {
      release()
    }
    const capture = await pending
    expect(capture.observationCheckpoint).toEqual(stored)
    expect(capture.observationCheckpoint.series[0].days[0].latest.origin).toBe('collection')
    expect(setup.onObservationError).not.toHaveBeenCalled()
  })

  it('fails the capture when the observation record cannot be saved', async () => {
    const setup = publicationService({ observationSave: async () => { throw new Error('Fictional history disk failure') } })
    await expect(setup.service.collectPublication()).rejects.toThrow('관측 기록을 저장하지 못했어요. 마지막으로 저장된 기록만 표시해요.')
    expect(setup.onObservationError).toHaveBeenCalledTimes(1)
    expect(setup.fetchBoard).toHaveBeenCalledTimes(2)
  })

  it('reports a board cache save failure through the error reporter the publisher turns into a failed run', async () => {
    const failure = new Error('Fictional board cache disk failure')
    const setup = publicationService({ boardSave: async () => { throw failure } })
    const capture = await setup.service.collectPublication()
    expect(setup.onCacheError).toHaveBeenCalledTimes(1)
    expect(setup.onCacheError).toHaveBeenCalledWith(failure)
    expect(capture.boards).toHaveLength(2)
  })

  it('fails the run when the publisher-supplied checkpoint history is corrupt instead of starting an empty history', async () => {
    const h = publicationHarness()
    const first = await h.run()
    const corrupt = checkpointFrom(first.capture)
    corrupt.observations.series[0].scope.key = 'f'.repeat(64)
    await expect(h.run(corrupt)).rejects.toThrow('관측 기록을 읽지 못했어요. 기존 파일을 보존하며 새로운 기록의 저장을 중단했어요.')
  })

  it('a provider error inside the body pass stays a per-board failure while a jitter fault fails the run', async () => {
    const h = publicationHarness()
    h.failBody(BIRCH, PUBLICATION_FAILURES.body)
    const ok = await h.run()
    expect(ok.capture.catalog.boards[1].status).toBe('error')
    const faulty = publicationHarness()
    faulty.fetchBoard.mockImplementation(async (company, fetchedAt) => {
      if (company.id === BIRCH) throw new BoardFetchError(PUBLICATION_FAILURES.body)
      return contentResult(company, fetchedAt)
    })
    await expect(faulty.run(undefined, { random: () => { throw new Error(PUBLICATION_FAILURES.jitter) } }))
      .rejects.toThrow('공고 조회를 완료하지 못했어요. 다시 조회해 주세요.')
  })
})

describe('capture shape required by the publisher', () => {
  it('exposes one captured instant and private arrays in registry order', async () => {
    const h = publicationHarness()
    const { capture } = await h.run()
    const expectedKeys: (keyof CatalogPublicationCapture)[] = [
      'capturedAt', 'catalog', 'postingStatus', 'boards', 'presences', 'history', 'observationCheckpoint', 'clocks',
    ]
    expect(Object.keys(capture).sort()).toEqual([...expectedKeys].sort())
    expect(capture.boards.map(board => board.companyId)).toEqual([ALDER, BIRCH])
    expect(capture.presences.map(entry => entry.companyId)).toEqual([ALDER, BIRCH])
    expect(capture.clocks.map(clock => clock.companyId)).toEqual([ALDER, BIRCH])
    expect(capture.catalog.boards.map(board => board.companyId)).toEqual([ALDER, BIRCH])
    expect(capture.postingStatus.boards.map(board => board.companyId)).toEqual([ALDER, BIRCH])
  })
})
