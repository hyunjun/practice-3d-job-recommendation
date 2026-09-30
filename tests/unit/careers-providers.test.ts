import { afterEach, describe, expect, it, vi } from 'vitest'
import { BoardFetchError, BoardInventoryError } from '../../server/catalog-service'
import { CAREERS_POLICY, createCareersFetcher } from '../../server/providers/careers'
import { BOOKING_LIST_URLS, CAREERS_NOW, STARBUCKS_LIST_URLS, ZALANDO_LIST_URLS, careersCompany } from '../fixtures/careers-contract'
import { mockCareersFetch } from '../fixtures/careers-fetch-mock'
import {
  CAREERS_BODY, CAREERS_FRONTEND_BODY, CAREERS_WIRE_JOBS, STARBUCKS_DETAIL_URLS, ZALANDO_DETAIL_URLS,
  bookingResponses, starbucksDetail, starbucksDetailHtml, starbucksResponses, starbucksSummary, zalandoResponses,
} from '../fixtures/careers-wire'
import type { BookingScenario, StarbucksScenario, ZalandoScenario } from '../fixtures/careers-wire'
import { coverageReply } from '../fixtures/public-coverage-transport'

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
const zeroDelay = () => createCareersFetcher({ concurrency: 1, interval: 0, bookingInterval: 0, timeout: 30_000 })
const sources = [
  { id: 'booking' as const, responses: bookingResponses, total: 101, list: BOOKING_LIST_URLS, details: [], jobs: CAREERS_WIRE_JOBS.slice(0, 2),
    excludedId: 'careers-booking-640002', updatedAt: '2026-10-01T12:00:00.000Z' },
  { id: 'starbucks' as const, responses: starbucksResponses, total: 11, list: STARBUCKS_LIST_URLS, details: STARBUCKS_DETAIL_URLS, jobs: CAREERS_WIRE_JOBS.slice(2, 4),
    excludedId: 'careers-starbucks-640002', updatedAt: null },
  { id: 'zalando' as const, responses: zalandoResponses, total: 16, list: ZALANDO_LIST_URLS, details: ZALANDO_DETAIL_URLS, jobs: CAREERS_WIRE_JOBS.slice(4, 6),
    excludedId: 'careers-zalando-640002', updatedAt: '2026-10-01T12:00:00.000Z' },
]

describe('three allowlisted careers sources through the real collectors', () => {
  it.each(sources)('$id keeps exact pagination, canonical URLs, source identity and the full non-computing inventory', async source => {
    const responses = source.responses()
    const before = JSON.stringify(responses)
    const transport = mockCareersFetch(responses)
    const result = await zeroDelay().fetchBoard(careersCompany(source.id), CAREERS_NOW)
    expect(transport.urls()).toEqual([...source.list, ...source.details])
    expect(transport.requests.every(request => request.method === 'GET')).toBe(true)
    expect(result.total).toBe(source.total)
    expect(result.publishedIds).toHaveLength(source.total)
    expect(new Set(result.publishedIds).size).toBe(source.total)
    expect(result.publishedIds).toContain(source.excludedId)
    expect(result.jobs.map(job => ({
      id: job.id, companyId: job.companyId, source: job.source, title: job.title, role: job.role,
      url: job.url, cityIds: job.cityIds, locationLabel: job.locationLabel,
    }))).toEqual(source.jobs)
    expect(result.unmappedCount).toBe(0)
    expect(result.jobs.map(job => job.description)).toEqual([CAREERS_BODY, CAREERS_FRONTEND_BODY])
    for (const job of result.jobs) {
      expect(job.fetchedAt).toBe('2026-10-02T10:00:00.000Z')
      expect(job.updatedAt).toBe(source.updatedAt)
      expect(job.employment).toBe('fulltime')
      expect(job.occupation).toMatchObject({ version: 7, category: 'engineering' })
    }
    expect(JSON.stringify(responses)).toBe(before)
  })

  it.each(sources)('$id presence reads only its complete public scope, with no body candidate filtering', async source => {
    const transport = mockCareersFetch(source.responses())
    const result = await zeroDelay().fetchPresence(careersCompany(source.id))
    expect(transport.urls()).toEqual(source.list)
    expect(result).not.toHaveProperty('jobs')
    expect(result.total).toBe(source.total)
    expect(result.publishedIds).toHaveLength(source.total)
    expect(new Set(result.publishedIds).size).toBe(source.total)
    expect(result.publishedIds).toContain(source.excludedId)
    expect(result.publishedIds).toContain(source.jobs[1].id)
  })

  it('namespaces the identical native ID separately for all three companies', async () => {
    mockCareersFetch({ ...bookingResponses(), ...starbucksResponses(), ...zalandoResponses() })
    const fetcher = zeroDelay()
    const booking = await fetcher.fetchBoard(careersCompany('booking'), CAREERS_NOW)
    const zalando = await fetcher.fetchBoard(careersCompany('zalando'), CAREERS_NOW)
    const starbucks = await fetcher.fetchBoard(careersCompany('starbucks'), CAREERS_NOW)
    expect([booking.jobs[0].id, zalando.jobs[0].id, starbucks.jobs[0].id]).toEqual([
      'careers-booking-640001', 'careers-zalando-640001', 'careers-starbucks-640001',
    ])
  })

  it('rejects a non-builtin route before requesting any host', async () => {
    const transport = mockCareersFetch({})
    const company = { ...careersCompany('booking'), board: 'https://example.com/jobs' }
    await expect(zeroDelay().fetchBoard(company, CAREERS_NOW)).rejects.toBeInstanceOf(BoardFetchError)
    await expect(zeroDelay().fetchPresence(company)).rejects.toBeInstanceOf(BoardFetchError)
    expect(transport.urls()).toEqual([])
  })
})

const bookingInventory: BookingScenario[] = ['short-first', 'empty-final', 'changed-total', 'count-is-page-size', 'duplicate', 'mismatched-slug', 'wrong-client', 'internal', 'wrong-employer', 'final-503']
const starbucksInventory: StarbucksScenario[] = ['short-first', 'empty-final', 'changed-total', 'duplicate', 'missing-filter', 'wrong-filter', 'extra-filter', 'wrong-list-url', 'final-503']
const zalandoInventory: ZalandoScenario[] = ['short-first', 'empty-final', 'changed-total', 'duplicate', 'missing-next', 'foreign-next', 'wrong-offset', 'wrong-limit', 'extra-final-next', 'ambiguous-list', 'final-503']
const inventoryFailures = [
  ...bookingInventory.map(scenario => ({ id: 'booking' as const, scenario, responses: () => bookingResponses(scenario) })),
  ...starbucksInventory.map(scenario => ({ id: 'starbucks' as const, scenario, responses: () => starbucksResponses(scenario) })),
  ...zalandoInventory.map(scenario => ({ id: 'zalando' as const, scenario, responses: () => zalandoResponses(scenario) })),
]

describe('incomplete or mismatched public pages cannot become a successful shortened inventory', () => {
  it.each(inventoryFailures)('$id / $scenario rejects both body and presence as an inventory failure', async fixture => {
    const transport = mockCareersFetch(fixture.responses())
    await expect(zeroDelay().fetchBoard(careersCompany(fixture.id), CAREERS_NOW)).rejects.toBeInstanceOf(BoardInventoryError)
    await expect(zeroDelay().fetchPresence(careersCompany(fixture.id))).rejects.toBeInstanceOf(BoardInventoryError)
    expect(transport.urls().some(url => /\/careers\/job\/|\/en\/jobs\/\d|position_details/.test(url))).toBe(false)
  })

  it('preserves Booking Retry-After so a partial final page cannot erase the previous listing', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse(CAREERS_NOW))
    mockCareersFetch(bookingResponses('final-429'))
    await expect(zeroDelay().fetchPresence(careersCompany('booking'))).rejects.toMatchObject({
      retryAfter: Date.parse('2026-10-02T10:02:00.000Z'),
    })
  })
})

const contentFailures = [
  ...(['missing-body', 'invalid-date'] satisfies BookingScenario[]).map(scenario => ({ id: 'booking' as const, scenario, responses: () => bookingResponses(scenario), total: 101 })),
  ...(['wrong-detail-id', 'wrong-detail-title', 'wrong-detail-url', 'wrong-employer', 'wrong-employer-domain', 'ambiguous-detail', 'missing-jsonld', 'invalid-jsonld', 'missing-body', 'detail-503'] satisfies StarbucksScenario[])
    .map(scenario => ({ id: 'starbucks' as const, scenario, responses: () => starbucksResponses(scenario), total: 11 })),
  ...(['wrong-detail-id', 'wrong-detail-title', 'wrong-detail-company', 'missing-detail-company', 'wrong-detail-date', 'missing-body', 'missing-text-reference', 'ambiguous-detail', 'detail-503'] satisfies ZalandoScenario[])
    .map(scenario => ({ id: 'zalando' as const, scenario, responses: () => zalandoResponses(scenario), total: 16 })),
]

describe('full-detail failures remain separate from complete list identity', () => {
  it.each(contentFailures)('$id / $scenario fails content while presence remains complete', async fixture => {
    mockCareersFetch(fixture.responses())
    const failure = await zeroDelay().fetchBoard(careersCompany(fixture.id), CAREERS_NOW).then(() => null, error => error)
    expect(failure).toBeInstanceOf(BoardFetchError)
    expect(failure).not.toBeInstanceOf(BoardInventoryError)
    const listing = await zeroDelay().fetchPresence(careersCompany(fixture.id))
    expect(listing.total).toBe(fixture.total)
    expect(listing.publishedIds).toHaveLength(fixture.total)
  })

  it('accepts an omitted Zalando list entity but still requires the detailed employer identity', async () => {
    mockCareersFetch(zalandoResponses('missing-positive-entity'))
    const result = await zeroDelay().fetchBoard(careersCompany('zalando'), CAREERS_NOW)
    expect(result.jobs.map(job => job.id)).toEqual(['careers-zalando-640001', 'careers-zalando-640016'])
  })
})

describe('Starbucks uses the primary public JSON-LD page and explicit Technology list scope', () => {
  function singlePosting(extra: Record<string, unknown> = {}, summaryExtra: Record<string, unknown> = {}) {
    return {
      [STARBUCKS_LIST_URLS[0]]: { data: {
        count: 1, appliedFilters: { jobCategory: ['technology'] },
        positions: [{ ...starbucksSummary(640001, 'Backend Engineer — Synthetic Maple Orders64'), ...summaryExtra }],
      } },
      [STARBUCKS_DETAIL_URLS[0]]: coverageReply(starbucksDetailHtml(starbucksDetail(640001, 'Backend Engineer — Synthetic Maple Orders64', extra)), { format: 'text' }),
    }
  }

  it('separates eleven Technology-scope IDs, three body candidates and two computing jobs', async () => {
    const transport = mockCareersFetch(starbucksResponses())
    const result = await zeroDelay().fetchBoard(careersCompany('starbucks'), CAREERS_NOW)
    expect(result.total).toBe(11)
    expect(result.jobs).toHaveLength(2)
    expect(transport.urls().filter(url => url.includes('/careers/job/'))).toEqual(STARBUCKS_DETAIL_URLS)
    expect(transport.urls().some(url => url.includes('position_details'))).toBe(false)
    expect(result.jobs.map(job => job.updatedAt)).toEqual([null, null])
  })

  it('preserves a public Nashville address with an object country and expired SEO dates', async () => {
    mockCareersFetch(singlePosting({ jobLocation: { address: {
      addressLocality: 'Nashville', addressRegion: 'TN,US', addressCountry: { name: 'US' },
    } } }))
    const result = await zeroDelay().fetchBoard(careersCompany('starbucks'), CAREERS_NOW)
    expect(result).toMatchObject({ total: 1, unmappedCount: 1, publishedIds: ['careers-starbucks-640001'] })
    expect(result.jobs[0]).toMatchObject({
      locationLabel: 'Nashville, TN,US, US', cityIds: [], updatedAt: null, employment: 'fulltime',
      occupation: { departments: ['Technology'] },
    })
  })

  it('reads optional list metadata and TELECOMMUTE without inventing an onsite city', async () => {
    mockCareersFetch(singlePosting({ jobLocationType: 'TELECOMMUTE', employmentType: ['FULL_TIME'] },
      { department: 'Digital Ordering', workLocationOption: 'Remote' }))
    const result = await zeroDelay().fetchBoard(careersCompany('starbucks'), CAREERS_NOW)
    expect(result.jobs[0]).toMatchObject({
      workMode: 'remote', employment: 'fulltime', cityIds: [], remoteCountries: ['US'],
      occupation: { departments: ['Technology', 'Digital Ordering'] },
    })
  })

  it('retains missing optional location as unknown, with a complete published identity', async () => {
    mockCareersFetch(singlePosting({ jobLocation: undefined }))
    const result = await zeroDelay().fetchBoard(careersCompany('starbucks'), CAREERS_NOW)
    expect(result).toMatchObject({ total: 1, unmappedCount: 1, publishedIds: ['careers-starbucks-640001'] })
    expect(result.jobs[0]).toMatchObject({ cityIds: [], workMode: 'unknown', updatedAt: null })
  })

  it('parses JSON data without executing unrelated page scripts', async () => {
    vi.stubGlobal('__stage64ScriptExecuted', false)
    const responses = singlePosting()
    const detail = responses[STARBUCKS_DETAIL_URLS[0]]
    detail.body = `<script>globalThis.__stage64ScriptExecuted = true</script>${detail.body}`
    mockCareersFetch(responses)
    expect((await zeroDelay().fetchBoard(careersCompany('starbucks'), CAREERS_NOW)).jobs).toHaveLength(1)
    expect(Reflect.get(globalThis, '__stage64ScriptExecuted')).toBe(false)
  })
})

describe('costly careers requests have explicit scheduling and a shared response-mode queue', () => {
  it('keeps the literal production policy and 5-second Booking crawl spacing', async () => {
    expect(CAREERS_POLICY).toEqual({ concurrency: 2, interval: 1000, bookingInterval: 5000, starbucksInterval: 10_000, timeout: 900_000 })
    vi.useFakeTimers()
    vi.setSystemTime(CAREERS_NOW)
    const transport = mockCareersFetch(bookingResponses())
    const result = createCareersFetcher().fetchPresence(careersCompany('booking'))
    await vi.advanceTimersByTimeAsync(4999)
    expect(transport.urls()).toEqual([BOOKING_LIST_URLS[0]])
    await vi.advanceTimersByTimeAsync(1)
    expect((await result).total).toBe(101)
    expect(transport.requests.map(request => request.at)).toEqual([
      Date.parse('2026-10-02T10:00:00.000Z'), Date.parse('2026-10-02T10:00:05.000Z'),
    ])
  })

  it('shares 10-second pacing across Starbucks JSON listing and primary HTML detail reads', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(CAREERS_NOW)
    const transport = mockCareersFetch(starbucksResponses())
    const result = createCareersFetcher().fetchBoard(careersCompany('starbucks'), CAREERS_NOW)
    await vi.advanceTimersByTimeAsync(39_999)
    expect(transport.urls()).toEqual([...STARBUCKS_LIST_URLS, STARBUCKS_DETAIL_URLS[0], STARBUCKS_DETAIL_URLS[1]])
    await vi.advanceTimersByTimeAsync(1)
    expect((await result).jobs).toHaveLength(2)
    expect(transport.requests.map(request => request.at)).toEqual([
      Date.parse('2026-10-02T10:00:00.000Z'), Date.parse('2026-10-02T10:00:10.000Z'),
      Date.parse('2026-10-02T10:00:20.000Z'), Date.parse('2026-10-02T10:00:30.000Z'),
      Date.parse('2026-10-02T10:00:40.000Z'),
    ])
  })

  it('aborts an inventory still waiting for a page at the whole-collection timeout', async () => {
    vi.useFakeTimers()
    const transport = mockCareersFetch(starbucksResponses())
    const result = createCareersFetcher({ concurrency: 1, interval: 1000, bookingInterval: 0, timeout: 500 })
      .fetchPresence(careersCompany('starbucks')).then(value => ({ value }), error => ({ error }))
    await vi.advanceTimersByTimeAsync(500)
    expect(await result).toMatchObject({ error: expect.any(BoardInventoryError) })
    expect(transport.urls()).toEqual([STARBUCKS_LIST_URLS[0]])
    await vi.advanceTimersByTimeAsync(1000)
    expect(transport.urls()).toEqual([STARBUCKS_LIST_URLS[0]])
  })
})
