import { afterEach, describe, expect, it, vi } from 'vitest'
import { PUBLIC_COMPANIES } from '../../shared/companies'
import { isCareerBoard } from '../../shared/career-sources'
import type { Company } from '../../shared/types'
import { BoardFetchError } from '../../server/catalog-service'
import type { BoardResult, CatalogPublicationCapture } from '../../server/catalog-service'
import { collectPublication, publicationConfigurationId } from '../../server/publication-collector'
import type { CollectorCheckpoint } from '../../server/publication-collector'
import type { PresenceResult } from '../../server/posting-presence'
import legacy from '../fixtures/daangn-legacy-registry.json'
import {
  DAANGN_COMPANIES, DAANGN_MARKET_URL, DAANGN_NEXT_DAY, DAANGN_NOW,
  DAANGN_PAY_TITLE, DAANGN_PAY_URL, daangnCachedJob,
} from '../fixtures/daangn-contract'
import { checkpointFrom } from '../fixtures/publication'

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })
const isNew = (id: string) => id === 'daangn' || id === 'daangn-pay'
const identities = (companies: Company[]) => companies.map(({ id, provider, board, boardRegion }) =>
  ({ id, provider: provider ?? 'greenhouse', board, ...(boardRegion ? { boardRegion } : {}) }))

function lifecycle(companies = DAANGN_COMPANIES) {
  let time = Date.parse(DAANGN_NOW)
  let empty = false, failed = false
  const network = vi.fn(() => { throw new Error('No transport is allowed in a checkpoint lifecycle fixture') })
  vi.stubGlobal('fetch', network)
  const body = vi.fn(async (company: Company, fetchedAt: string): Promise<BoardResult> => {
    if (failed && isNew(company.id)) throw new BoardFetchError('Synthetic incomplete Daangn detail')
    const nativeId = company.id === 'daangn-pay' ? '830101' : '830001'
    const id = `${company.provider ?? 'greenhouse'}-${company.id}-${nativeId}`
    const job = {
      ...daangnCachedJob(fetchedAt), id, companyId: company.id, source: company.provider ?? 'greenhouse' as const,
      ...(company.id === 'daangn-pay' ? { title: DAANGN_PAY_TITLE, url: DAANGN_PAY_URL } : {}),
      ...(!isNew(company.id) ? { url: `https://example.test/fictional-legacy/${company.id}/830001` } : {}),
    }
    return empty && isNew(company.id) ? { jobs: [], total: 0, unmappedCount: 0, publishedIds: [] }
      : { jobs: [job], total: 1, unmappedCount: 1, publishedIds: [id] }
  })
  const presence = vi.fn(async (company: Company, _at: string): Promise<PresenceResult> => {
    if (failed && isNew(company.id)) throw new BoardFetchError('Synthetic incomplete Daangn inventory')
    const id = `${company.provider ?? 'greenhouse'}-${company.id}-${company.id === 'daangn-pay' ? '830101' : '830001'}`
    return { total: empty && isNew(company.id) ? 0 : 1, publishedIds: empty && isNew(company.id) ? [] : [id] }
  })
  return {
    body, presence, network,
    at: (at: string) => { time = Date.parse(at) },
    fail: () => { failed = true },
    completeEmpty: () => { failed = false; empty = true },
    run: (checkpoint?: CollectorCheckpoint, nextCompanies = companies) => collectPublication({
      companies: nextCompanies, checkpoint, now: () => time, random: () => 0,
      fetchBoard: body, fetchPresence: presence,
    }),
  }
}

describe('132 registered boards with the previous 130 preserved', () => {
  it('adds exactly two distinct career boards and preserves every old provider, board, and company ID', () => {
    expect(legacy.boards).toHaveLength(130)
    expect(PUBLIC_COMPANIES).toHaveLength(132)
    expect(identities(PUBLIC_COMPANIES.filter(company => !isNew(company.id)))).toEqual(legacy.boards)
    expect(identities(PUBLIC_COMPANIES.filter(company => isNew(company.id)))).toEqual([
      { id: 'daangn', provider: 'careers', board: 'daangn' },
      { id: 'daangn-pay', provider: 'careers', board: 'daangn-pay' },
    ])
    expect(new Set(PUBLIC_COMPANIES.map(company => company.id)).size).toBe(132)
    expect(isCareerBoard('daangn')).toBe(true)
    expect(isCareerBoard('daangn-pay')).toBe(true)
    expect(isCareerBoard('https://careers.daangn.com/jobs/')).toBe(false)
  })

  it('expands a checkpoint without renewing old jobs, clocks, or the old observation series', async () => {
    const old = PUBLIC_COMPANIES.filter(company => !isNew(company.id))
    const h = lifecycle(old)
    const first = (await h.run()).capture
    const checkpoint = checkpointFrom(first)
    const immutableInput = JSON.stringify(checkpoint)
    h.at('2026-10-25T06:10:00.000Z')
    const expanded = (await h.run(checkpoint, PUBLIC_COMPANIES)).capture
    expect(h.body.mock.calls.slice(130).map(([company]) => company.id).sort()).toEqual(['daangn', 'daangn-pay'])
    expect(h.presence.mock.calls.slice(130).map(([company]) => company.id).sort()).toEqual(['daangn', 'daangn-pay'])
    expect(expanded.catalog.companies).toHaveLength(132)
    expect(expanded.catalog.boards).toHaveLength(132)
    expect(expanded.catalog.jobs).toHaveLength(132)
    expect(expanded.catalog.jobs.filter(job => !isNew(job.companyId))).toEqual(first.catalog.jobs)
    expect(expanded.boards.filter(board => !isNew(board.companyId))).toEqual(first.boards)
    expect(expanded.presences.filter(board => !isNew(board.companyId))).toEqual(first.presences)
    expect(expanded.clocks.filter(board => !isNew(board.companyId))).toEqual(first.clocks)
    expect(expanded.observationCheckpoint.series.find(series => series.scope.key === first.history.scope.key))
      .toEqual(first.observationCheckpoint.series[0])
    expect(expanded.history.scope.boards).toHaveLength(132)
    expect(expanded.history.scope.key).not.toBe(first.history.scope.key)
    expect(publicationConfigurationId(PUBLIC_COMPANIES)).not.toBe(publicationConfigurationId(old))
    expect(JSON.stringify(checkpoint)).toBe(immutableInput)
    h.at('2026-10-25T06:20:00.000Z')
    const repeat = (await h.run(checkpointFrom(expanded), PUBLIC_COMPANIES)).capture
    expect(h.body).toHaveBeenCalledTimes(132)
    expect(h.presence).toHaveBeenCalledTimes(132)
    expect(repeat.catalog.jobs).toEqual(expanded.catalog.jobs)
    expect(repeat.postingStatus).toEqual(expanded.postingStatus)
    expect(repeat.observationCheckpoint).toEqual(expanded.observationCheckpoint)
    expect(h.network).not.toHaveBeenCalled()
  })
})

describe('daily source continuity', () => {
  it('retains stable IDs and original URLs through restart, then refreshes at exactly 24 hours', async () => {
    const h = lifecycle()
    const first = (await h.run()).capture
    expect(first.catalog.jobs.map(job => [job.id, job.url, job.updatedAt])).toEqual([
      ['careers-daangn-830001', DAANGN_MARKET_URL, null],
      ['careers-daangn-pay-830101', DAANGN_PAY_URL, null],
    ])
    h.at('2026-10-26T05:59:59.999Z')
    const early = (await h.run(checkpointFrom(first))).capture
    expect(h.body).toHaveBeenCalledTimes(2)
    expect(h.presence).toHaveBeenCalledTimes(2)
    expect(early.boards).toEqual(first.boards)
    h.at(DAANGN_NEXT_DAY)
    const next = (await h.run(checkpointFrom(early))).capture
    expect(h.body).toHaveBeenCalledTimes(4)
    expect(h.presence).toHaveBeenCalledTimes(4)
    expect(next.catalog.jobs.map(job => job.id)).toEqual(['careers-daangn-830001', 'careers-daangn-pay-830101'])
    expect(next.catalog.jobs.map(job => job.fetchedAt)).toEqual([DAANGN_NEXT_DAY, DAANGN_NEXT_DAY])
    expect(next.postingStatus.boards.map(board => board.listing!.jobs.map(job => job.revision)))
      .toEqual(first.postingStatus.boards.map(board => board.listing!.jobs.map(job => job.revision)))
    expect(h.network).not.toHaveBeenCalled()
  })

  it('does not interpret a failed list/body as closures, then accepts a later complete explicit zero', async () => {
    const h = lifecycle()
    const first = (await h.run()).capture
    h.at(DAANGN_NEXT_DAY)
    h.fail()
    const failed = (await h.run(checkpointFrom(first))).capture
    expect(failed.boards.map(board => board.snapshot)).toEqual(first.boards.map(board => board.snapshot))
    expect(failed.presences.map(board => board.snapshot)).toEqual(first.presences.map(board => board.snapshot))
    expect(failed.catalog.boards.map(board => board.status)).toEqual(['error', 'error'])
    expect(failed.catalog.boards.map(board => board.lastSuccessAt)).toEqual([DAANGN_NOW, DAANGN_NOW])
    expect(failed.presences.flatMap(board => board.unpublishedIds ?? [])).toEqual([])
    h.at('2026-10-26T06:01:00.000Z')
    h.completeEmpty()
    const empty: CatalogPublicationCapture = (await h.run(checkpointFrom(failed))).capture
    expect(empty.catalog.jobs).toEqual([])
    expect(empty.catalog.boards.map(board => [board.status, board.total, board.included])).toEqual([
      ['ok', 0, 0], ['ok', 0, 0],
    ])
    expect(empty.presences.map(board => board.snapshot?.publishedIds)).toEqual([[], []])
    expect(empty.boards.map(board => board.snapshot?.jobs)).toEqual([[], []])
    expect(h.network).not.toHaveBeenCalled()
  })
})
