import { afterEach, describe, expect, it, vi } from 'vitest'
import { createCareersFetcher } from '../../server/providers/careers'
import { collectPublication } from '../../server/publication-collector'
import { checkpointFrom } from '../fixtures/publication'
import { mockCareersFetch } from '../fixtures/careers-fetch-mock'
import { coverageReply } from '../fixtures/public-coverage-transport'
import {
  DAANGN_COMPANIES, DAANGN_LIST_URL, DAANGN_MARKET_URL, DAANGN_NEXT_DAY, DAANGN_NOW, DAANGN_PAY_URL,
  DAANGN_ROBOTS_URL, DAANGN_SALES_URL,
} from '../fixtures/daangn-contract'
import { DAANGN_CARDS, daangnDetail, daangnList, daangnPosting, daangnResponses } from '../fixtures/daangn-wire'

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
function clock() { vi.useFakeTimers(); vi.setSystemTime(new Date(DAANGN_NOW)) }
async function drain<T>(promise: Promise<T>): Promise<T> {
  // Observe rejection before advancing the clock; a deliberately failing job
  // must not surface as an unhandled promise while its sibling settles.
  const settled = promise.then(value => ({ value }), error => ({ error }))
  await vi.runAllTimersAsync()
  const outcome = await settled
  if ('error' in outcome) throw outcome.error
  return outcome.value
}

describe('two distinct official Daangn boards on one paced host', () => {
  it('publishes per-company inventory IDs including nontechnical cards, with only technical bodies included', async () => {
    clock()
    const http = mockCareersFetch(daangnResponses())
    const fetcher = createCareersFetcher() // The real default host pacing is not overridden.
    const [market, pay] = await drain(Promise.all(DAANGN_COMPANIES.map(company =>
      fetcher.fetchBoard(company, DAANGN_NOW))))
    expect(market).toMatchObject({
      total: 2, publishedIds: ['careers-daangn-830001', 'careers-daangn-830002'], unmappedCount: 1,
    })
    expect(pay).toMatchObject({ total: 1, publishedIds: ['careers-daangn-pay-830101'], unmappedCount: 1 })
    expect(market.jobs.map(job => [job.id, job.companyId, job.url, job.cityIds, job.updatedAt])).toEqual([
      ['careers-daangn-830001', 'daangn', DAANGN_MARKET_URL, [], null],
    ])
    expect(pay.jobs.map(job => [job.id, job.companyId, job.url, job.cityIds, job.updatedAt])).toEqual([
      ['careers-daangn-pay-830101', 'daangn-pay', DAANGN_PAY_URL, [], null],
    ])
    expect(http.urls().filter(url => url === DAANGN_ROBOTS_URL)).toHaveLength(2)
    expect(http.urls().filter(url => url === DAANGN_LIST_URL)).toHaveLength(2)
    expect(http.urls()).not.toContain(DAANGN_SALES_URL)
    for (let index = 1; index < http.requests.length; index++)
      expect(http.requests[index].at - http.requests[index - 1].at).toBeGreaterThanOrEqual(3000)

    const presence = await drain(Promise.all(DAANGN_COMPANIES.map(company => fetcher.fetchPresence(company))))
    expect(presence).toEqual([
      { total: 2, publishedIds: ['careers-daangn-830001', 'careers-daangn-830002'] },
      { total: 1, publishedIds: ['careers-daangn-pay-830101'] },
    ])
    // No robots/list cache can leak from the content pass into a later inventory pass.
    expect(http.urls().filter(url => url === DAANGN_ROBOTS_URL)).toHaveLength(4)
    expect(http.urls().filter(url => url === DAANGN_LIST_URL)).toHaveLength(4)
    expect(http.urls().filter(url => url === DAANGN_MARKET_URL)).toHaveLength(1)
    expect(http.urls().filter(url => url === DAANGN_PAY_URL)).toHaveLength(1)
  })

  it.each(['content', 'presence'] as const)('rejects a malformed other-employer card before selecting %s', async pass => {
    clock()
    const http = mockCareersFetch({
      ...daangnResponses(),
      [DAANGN_LIST_URL]: coverageReply(daangnList([
        DAANGN_CARDS[0], { ...DAANGN_CARDS[2], corporate: 'unregistered-employer' },
      ]), { format: 'text' }),
    })
    const fetcher = createCareersFetcher()
    const outcome = (pass === 'content' ? fetcher.fetchBoard(DAANGN_COMPANIES[0], DAANGN_NOW)
      : fetcher.fetchPresence(DAANGN_COMPANIES[0])).then(() => 'unexpected-success', () => 'rejected')
    expect(await drain(outcome)).toBe('rejected')
    expect(http.urls()).toEqual([DAANGN_ROBOTS_URL, DAANGN_LIST_URL])
  })

  it('fails the whole company if a later technical detail fails after an earlier valid body', async () => {
    clock()
    const http = mockCareersFetch({
      ...daangnResponses(),
      [DAANGN_LIST_URL]: coverageReply(daangnList([
        DAANGN_CARDS[0], { ...DAANGN_CARDS[0], id: '830003', title: 'Backend Engineer — Fictional Missing Body83' },
      ]), { format: 'text' }),
      'https://careers.daangn.com/jobs/role/830003/': coverageReply('Synthetic unavailable detail', { format: 'text', status: 503 }),
    })
    const result = createCareersFetcher().fetchBoard(DAANGN_COMPANIES[0], DAANGN_NOW)
      .then(() => 'unexpected-partial-success', () => 'rejected')
    expect(await drain(result)).toBe('rejected')
    expect(http.urls()).toContain(DAANGN_MARKET_URL)
    expect(http.urls()).toContain('https://careers.daangn.com/jobs/role/830003/')
  })

  it('uses fresh list contents on the next invocation rather than a prior successful list', async () => {
    clock()
    const responses = daangnResponses()
    const http = mockCareersFetch(responses)
    const fetcher = createCareersFetcher()
    expect(await drain(fetcher.fetchPresence(DAANGN_COMPANIES[0]))).toEqual({
      total: 2, publishedIds: ['careers-daangn-830001', 'careers-daangn-830002'],
    })
    responses[DAANGN_LIST_URL] = coverageReply(daangnList([]), { format: 'text' })
    expect(await drain(fetcher.fetchPresence(DAANGN_COMPANIES[0]))).toEqual({ total: 0, publishedIds: [] })
    expect(http.urls()).toEqual([DAANGN_ROBOTS_URL, DAANGN_LIST_URL, DAANGN_ROBOTS_URL, DAANGN_LIST_URL])
  })

  it('accepts a still-listed opening older than fourteen days without treating datePosted as updatedAt', async () => {
    clock()
    mockCareersFetch({
      ...daangnResponses(),
      [DAANGN_MARKET_URL]: coverageReply(daangnDetail(daangnPosting({ datePosted: '2025-01-01' })), { format: 'text' }),
    })
    const result = await drain(createCareersFetcher().fetchBoard(DAANGN_COMPANIES[0], DAANGN_NOW))
    expect(result.jobs.map(job => [job.id, job.updatedAt])).toEqual([['careers-daangn-830001', null]])
  })

  it.each([
    '{"error":"unavailable"}',
    '\uFEFF# fictional proxy response\n{"error":"unavailable"}',
  ])('ASTRA-IMPL-03 preserves prior board/listing snapshots when HTTP200 text/plain robots is an error document', async malformed => {
    clock()
    const responses = daangnResponses()
    const http = mockCareersFetch(responses)
    const fetcher = createCareersFetcher()
    // Fix collection timestamps independently of the clock that drives host pacing.
    const collect = (at: string, checkpoint?: ReturnType<typeof checkpointFrom>) =>
      collectPublication({
        companies: DAANGN_COMPANIES, checkpoint, now: () => Date.parse(at), random: () => 0,
        fetchBoard: fetcher.fetchBoard, fetchPresence: fetcher.fetchPresence,
      })
    const first = (await drain(collect(DAANGN_NOW))).capture
    expect(first.catalog.jobs.map(job => job.id)).toEqual([
      'careers-daangn-830001', 'careers-daangn-pay-830101',
    ])
    const checkpoint = checkpointFrom(first)
    const preservedInput = JSON.stringify(checkpoint)
    const requestsBefore = http.requests.length
    responses[DAANGN_ROBOTS_URL] = coverageReply(malformed, {
      format: 'text', status: 200, headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    })
    vi.setSystemTime(new Date(DAANGN_NEXT_DAY))
    const failed = (await drain(collect(DAANGN_NEXT_DAY, checkpoint))).capture
    expect(failed.catalog.boards.map(board => board.status)).toEqual(['error', 'error'])
    expect(failed.catalog.boards.map(board => board.lastSuccessAt)).toEqual([DAANGN_NOW, DAANGN_NOW])
    expect(failed.boards.map(board => board.snapshot)).toEqual(first.boards.map(board => board.snapshot))
    expect(failed.presences.map(board => board.snapshot)).toEqual(first.presences.map(board => board.snapshot))
    expect(failed.presences.flatMap(board => board.unpublishedIds ?? [])).toEqual([])
    expect(JSON.stringify(checkpoint)).toBe(preservedInput)
    const attempted = http.urls().slice(requestsBefore)
    expect(attempted.length).toBeGreaterThan(0)
    expect(attempted.every(url => url === DAANGN_ROBOTS_URL)).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })
})
