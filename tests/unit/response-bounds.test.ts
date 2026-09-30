import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseCachedBoards } from '../../server/board-cache'
import type { CachedBoard } from '../../server/board-cache'
import { BoardFetchError, BoardInventoryError, CatalogUnavailableError, createCatalogService } from '../../server/catalog-service'
import { fetchAshbyBoard } from '../../server/providers/ashby'
import { createCareersFetcher } from '../../server/providers/careers'
import { fetchGreenhouseBoard } from '../../server/providers/greenhouse'
import { fetchLeverBoard } from '../../server/providers/lever'
import { createSmartRecruitersFetcher } from '../../server/providers/smartrecruiters'
import type { CachedPresence } from '../../server/posting-presence'
import { observeSavedPosting } from '../../shared/posting-status'
import type { Company, SavedJob } from '../../shared/types'
import { CAREERS_NOW, ZALANDO_LIST_URLS, careersCompany } from '../fixtures/careers-contract'
import { ZALANDO_DETAIL_URLS, zalandoResponses } from '../fixtures/careers-wire'
import { asCoverageReply } from '../fixtures/public-coverage-transport'
import { smartRecruitersPosting } from '../fixtures/public-postings'
import {
  BOUNDS_CHANGE_TIME, BOUNDS_COMPANIES, BOUNDS_IDS, BOUNDS_NOTE, BOUNDS_RECOVERY_TIME, BOUNDS_TIME, BOUNDS_URLS,
  HTML_CAP_BYTES, HTML_OVER_CAP_BYTES, HTML_SIZE_MESSAGE, JSON_CAP_BYTES, JSON_OVER_CAP_BYTES, JSON_SIZE_MESSAGE, UNKNOWN_SAVED_MESSAGE,
  boundsResponses, controlPosting, paddedHtml, paddedJsonArray, paddedJsonObject,
} from '../fixtures/response-bounds'
import type { BoundsPhase, BoundsProvider } from '../fixtures/response-bounds'
import { DEFAULT_CHUNK_BYTES, directiveResponse, isStreamDirective } from '../fixtures/response-bounds-stream'

// Real providers and the real catalog service; only the wire is synthetic.
// Over-cap bodies are schema-valid feeds well past the cap, so a missing byte
// cap would make these collections succeed, and the source still holds unread
// chunks when the reader observes the excess, which makes cancellation visible.
const HEAVY = 120_000
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

interface StreamObservation { url: string; cancelled: boolean; pulledBytes: number }
/** The reader stopped near the cap: it cancelled the open source and pulled at most one look-ahead chunk past it. */
function expectEarlyStop(stream: StreamObservation, cap: number) {
  expect(stream.cancelled).toBe(true)
  expect(stream.pulledBytes).toBeGreaterThan(cap)
  expect(stream.pulledBytes).toBeLessThanOrEqual(cap + 2 * DEFAULT_CHUNK_BYTES)
}
function transport(initial: Record<string, unknown>) {
  let responses = initial
  const requests: string[] = []
  const streams: StreamObservation[] = []
  const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input)
    requests.push(url)
    if (!Object.hasOwn(responses, url)) throw new Error(`Unexpected fixture URL ${url}`)
    const value = responses[url]
    if (isStreamDirective(value)) {
      const observation: StreamObservation = { url, cancelled: false, pulledBytes: 0 }
      streams.push(observation)
      return directiveResponse(value, {
        onStart: controller => {
          const signal = init?.signal
          if (signal) signal.addEventListener('abort', () => controller.error(signal.reason), { once: true })
        },
        onPull: bytes => { observation.pulledBytes = bytes },
        onCancel: () => { observation.cancelled = true },
      })
    }
    const reply = asCoverageReply(value)
    if (reply.failure) throw new Error(reply.failure)
    if (reply.format === 'text') {
      return new Response(reply.body as string, { status: reply.status ?? 200, headers: { 'Content-Type': 'text/html; charset=utf-8', ...reply.headers } })
    }
    return Response.json(reply.body, { status: reply.status ?? 200, headers: reply.headers })
  })
  vi.stubGlobal('fetch', fetcher)
  return {
    fetcher, requests, streams,
    replace: (next: Record<string, unknown>) => { responses = next },
  }
}
const failureOf = (promise: Promise<unknown>) => promise.then(() => null, (cause: unknown) => cause)
function memoryCache() {
  let stored: CachedBoard[] = []
  return {
    cache: {
      load: async () => parseCachedBoards({ version: 5, boards: structuredClone(stored) }),
      save: async (next: CachedBoard[]) => { stored = structuredClone(next) },
    },
    stored: () => stored,
  }
}
function memoryPresence() {
  let stored: CachedPresence[] = []
  return {
    cache: {
      load: async () => structuredClone(stored),
      save: async (next: CachedPresence[]) => { stored = structuredClone(next) },
    },
    stored: () => stored,
  }
}

const subjects = [
  { provider: 'greenhouse' as const, ...BOUNDS_IDS.greenhouse },
  { provider: 'ashby' as const, ...BOUNDS_IDS.ashby },
]
function pipeline(provider: BoundsProvider, withControl = true) {
  let now = Date.parse(BOUNDS_TIME)
  const { cache, stored } = memoryCache()
  const wire = transport(boundsResponses(provider, 'healthy'))
  const fetchBoard = (company: Company, at: string) => company.provider === 'greenhouse' ? fetchGreenhouseBoard(company, at)
    : company.provider === 'ashby' ? fetchAshbyBoard(company, at) : fetchLeverBoard(company, at)
  return {
    create: () => createCatalogService({
      companies: [BOUNDS_COMPANIES[provider], ...(withControl ? [BOUNDS_COMPANIES.control] : [])],
      cache, fetchBoard, now: () => now, random: () => 0,
    }),
    wire, cache: stored, at: (time: string) => { now = Date.parse(time) }, now: () => now,
    phase: (phase: BoundsPhase) => wire.replace(boundsResponses(provider, phase)),
  }
}

for (const subject of subjects) describe(`${subject.provider} over-cap full feeds through the real catalog and cache parser`, () => {
  const company = BOUNDS_COMPANIES[subject.provider]
  const save = (job: SavedJob['job']): SavedJob => ({
    job: structuredClone(job), company, note: BOUNDS_NOTE, status: 'applied', savedAt: '2026-09-30T09:00:30.000Z',
  })

  it('keeps the exact prior snapshot, clocks, listing and unknown saved status through an over-cap refresh and restart, then recovers with an exact-cap feed', async () => {
    const fixture = pipeline(subject.provider)
    const service = fixture.create()
    const first = await service.get()
    expect(first.jobs.map(job => job.id)).toEqual([...subject.technical, BOUNDS_IDS.control.one])
    const saved = save(first.jobs[0])
    const originalSaved = structuredClone(saved)
    const original = structuredClone(fixture.cache()[0])
    expect(original.snapshot).toMatchObject({ fetchedAt: BOUNDS_TIME, total: 3, publishedIds: subject.published })

    fixture.phase('oversize')
    fixture.at(BOUNDS_CHANGE_TIME)
    const failed = await service.get(true)
    expect(failed.jobs.map(job => job.id)).toEqual([...subject.technical, BOUNDS_IDS.control.one, BOUNDS_IDS.control.two])
    expect(failed.boards).toMatchObject([
      {
        status: 'error', dataStatus: 'stale', lastSuccessAt: BOUNDS_TIME, checkedAt: BOUNDS_CHANGE_TIME,
        total: 3, included: 2, message: JSON_SIZE_MESSAGE, retryAt: '2026-09-30T09:03:00.000Z',
      },
      { status: 'ok', dataStatus: 'fresh', lastSuccessAt: BOUNDS_CHANGE_TIME, total: 2, included: 2 },
    ])
    expect(fixture.cache()[0].snapshot).toEqual(original.snapshot)
    expect(fixture.cache()[0]).toMatchObject({
      checkedAt: BOUNDS_CHANGE_TIME, failures: 1, retryAt: '2026-09-30T09:03:00.000Z', error: JSON_SIZE_MESSAGE, errorPhase: 'inventory',
    })
    expect(fixture.wire.streams).toHaveLength(1)
    expect(fixture.wire.streams[0].url).toBe(BOUNDS_URLS[subject.provider])
    expectEarlyStop(fixture.wire.streams[0], JSON_CAP_BYTES)
    const status = await service.getPostingStatus(true)
    expect(status.boards[0]).toMatchObject({
      status: 'error', lastSuccessAt: BOUNDS_TIME,
      listing: { publishedIds: subject.published, validUntil: '2026-09-30T09:30:00.000Z' },
    })
    expect(observeSavedPosting(saved, status, undefined, fixture.now())).toMatchObject({
      state: 'unknown', checkedAt: BOUNDS_TIME, message: UNKNOWN_SAVED_MESSAGE,
    })
    expect(fixture.wire.fetcher).toHaveBeenCalledTimes(4)

    const restarted = fixture.create()
    expect((await restarted.get()).jobs).toEqual(failed.jobs)
    expect((await restarted.getPostingStatus(true)).boards).toEqual(status.boards)
    expect(fixture.wire.fetcher).toHaveBeenCalledTimes(4)

    fixture.phase('recovered-exact')
    fixture.at(BOUNDS_RECOVERY_TIME)
    const recovered = await restarted.get(true)
    expect(recovered.jobs.map(job => job.id)).toEqual([...subject.technical, subject.newId, BOUNDS_IDS.control.one, BOUNDS_IDS.control.two])
    expect(recovered.boards[0]).toMatchObject({ status: 'ok', dataStatus: 'fresh', total: 4, included: 3, lastSuccessAt: BOUNDS_RECOVERY_TIME })
    expect(fixture.cache()[0]).toMatchObject({ failures: 0, retryAt: null })
    expect(fixture.cache()[0].snapshot?.publishedIds).toEqual([...subject.published, subject.newId])
    expect(fixture.wire.streams).toHaveLength(2)
    expect(fixture.wire.streams[1]).toMatchObject({ cancelled: false, pulledBytes: JSON_CAP_BYTES })
    expect(observeSavedPosting(saved, await restarted.getPostingStatus(), undefined, fixture.now()).state).toBe('listed')
    expect(saved).toEqual(originalSaved)
    expect(fixture.wire.fetcher).toHaveBeenCalledTimes(6)
  }, HEAVY)

  it('records no snapshot or listing when the first collection is over the cap', async () => {
    const fixture = pipeline(subject.provider, false)
    fixture.phase('oversize')
    const service = fixture.create()
    await expect(service.get()).rejects.toBeInstanceOf(CatalogUnavailableError)
    expect(fixture.cache()).toHaveLength(1)
    expect(fixture.cache()[0]).toMatchObject({
      failures: 1, checkedAt: BOUNDS_TIME, retryAt: '2026-09-30T09:01:00.000Z', error: JSON_SIZE_MESSAGE, errorPhase: 'inventory',
    })
    expect(fixture.cache()[0]).not.toHaveProperty('snapshot')
    const status = await service.getPostingStatus(true)
    expect(status.boards[0]).toMatchObject({ status: 'error', lastSuccessAt: null })
    expect(status.boards[0]).not.toHaveProperty('listing')
    expect(fixture.wire.fetcher).toHaveBeenCalledTimes(1)
    expectEarlyStop(fixture.wire.streams[0], JSON_CAP_BYTES)
  }, HEAVY)
})

describe('Lever pages over the cap', () => {
  const company = BOUNDS_COMPANIES.control
  const pageUrl = (skip: number) => `https://api.eu.lever.co/v0/postings/BirchBounds72?mode=json&limit=50&skip=${skip}`
  const fullPage = () => Array.from({ length: 50 }, (_, index) => controlPosting(`page-${index}`, `Berlin Backend Engineer Page ${index} 72`))
  const overPage = () => paddedJsonArray([controlPosting('tail', 'Berlin Backend Engineer Tail 72')], JSON_OVER_CAP_BYTES)

  it('fails the whole board when a later page is over the cap, with one deadline and no partial inventory', async () => {
    const wire = transport({ [pageUrl(0)]: fullPage(), [pageUrl(50)]: overPage() })
    const failure = await failureOf(fetchLeverBoard(company, BOUNDS_TIME))
    expect(failure).toBeInstanceOf(BoardInventoryError)
    expect((failure as Error).message).toBe(JSON_SIZE_MESSAGE)
    expect(wire.requests).toEqual([pageUrl(0), pageUrl(50)])
    expect(wire.fetcher.mock.calls[0][1]?.signal).toBe(wire.fetcher.mock.calls[1][1]?.signal)
    expect(wire.streams).toHaveLength(1)
    expect(wire.streams[0].url).toBe(pageUrl(50))
    expectEarlyStop(wire.streams[0], JSON_CAP_BYTES)
  }, HEAVY)

  it('keeps the previous complete snapshot when a refresh\'s second page is over the cap', async () => {
    let now = Date.parse(BOUNDS_TIME)
    const { cache, stored } = memoryCache()
    const wire = transport({ [pageUrl(0)]: [controlPosting('control-one', 'Berlin Backend Engineer One 72')] })
    const service = createCatalogService({ companies: [company], cache, fetchBoard: fetchLeverBoard, now: () => now, random: () => 0 })
    expect((await service.get()).jobs.map(job => job.id)).toEqual([BOUNDS_IDS.control.one])
    const original = structuredClone(stored()[0])
    wire.replace({ [pageUrl(0)]: fullPage(), [pageUrl(50)]: overPage() })
    now = Date.parse(BOUNDS_CHANGE_TIME)
    const failed = await service.get(true)
    expect(failed.jobs.map(job => job.id)).toEqual([BOUNDS_IDS.control.one])
    expect(failed.boards[0]).toMatchObject({
      status: 'error', dataStatus: 'stale', lastSuccessAt: BOUNDS_TIME, total: 1, included: 1,
      message: JSON_SIZE_MESSAGE, retryAt: '2026-09-30T09:03:00.000Z',
    })
    expect(stored()[0].snapshot).toEqual(original.snapshot)
    expect(stored()[0]).toMatchObject({ failures: 1, errorPhase: 'inventory', checkedAt: BOUNDS_CHANGE_TIME, error: JSON_SIZE_MESSAGE })
    expect(wire.requests).toEqual([pageUrl(0), pageUrl(0), pageUrl(50)])
  }, HEAVY)
})

describe('SmartRecruiters detail bodies on a shared queue', () => {
  const alpha: Company = {
    id: 'bounds-alpha', name: 'Alpha Bounds', initials: 'AB', color: '#90deb8', industry: 'Synthetic response bounds',
    careerUrl: 'https://example.com/bounds/alpha', provider: 'smartrecruiters', board: 'AlphaBounds72',
  }
  const beta: Company = { ...alpha, id: 'bounds-beta', name: 'Beta Bounds', careerUrl: 'https://example.com/bounds/beta', board: 'BetaBounds72' }
  const listUrl = (board: string) => `https://api.smartrecruiters.com/v1/companies/${board}/postings?limit=100&offset=0&destination=PUBLIC`
  const detailUrl = (board: string, id: string) => `https://api.smartrecruiters.com/v1/companies/${board}/postings/${id}`
  const posting = (board: string, id: string, name: string) => smartRecruitersPosting({
    id, name, company: { identifier: board }, postingUrl: `https://example.com/bounds/smartrecruiters/${board}/${id}`,
  })
  const pageOf = (content: unknown[]) => ({ offset: 0, limit: 100, totalFound: content.length, content })
  function responses(oversizeDetail: boolean): Record<string, unknown> {
    const a1 = posting('AlphaBounds72', 'a1', 'Backend Engineer — Alpha One 72')
    const a2 = posting('AlphaBounds72', 'a2', 'Backend Engineer — Alpha Two 72')
    const b1 = posting('BetaBounds72', 'b1', 'Backend Engineer — Beta One 72')
    return {
      [listUrl('AlphaBounds72')]: pageOf([a1, a2]),
      [detailUrl('AlphaBounds72', 'a1')]: a1,
      [detailUrl('AlphaBounds72', 'a2')]: oversizeDetail ? paddedJsonObject(a2, JSON_OVER_CAP_BYTES) : a2,
      [listUrl('BetaBounds72')]: pageOf([b1]),
      [detailUrl('BetaBounds72', 'b1')]: b1,
    }
  }
  const alphaIds = ['smartrecruiters-bounds-alpha-a1', 'smartrecruiters-bounds-alpha-a2']
  const betaId = 'smartrecruiters-bounds-beta-b1'
  const isListRequest = (url: string) => url.includes('destination=PUBLIC')

  it('fails only the affected company\'s content: the v2 listing, publication IDs and original body time survive, the sibling on the same queue completes, and restart preserves it', async () => {
    const wire = transport(responses(false))
    const fetcher = createSmartRecruitersFetcher({ concurrency: 2, interval: 0, timeout: 120_000 })
    let now = Date.parse(BOUNDS_TIME)
    const { cache, stored } = memoryCache()
    const presence = memoryPresence()
    const create = () => createCatalogService({
      companies: [alpha, beta], cache, fetchBoard: fetcher,
      presence: { cache: presence.cache, fetchBoard: fetcher.fetchPresence },
      now: () => now, random: () => 0,
    })
    const service = create()
    const first = await service.get()
    expect(first.jobs.map(job => job.id)).toEqual([...alphaIds, betaId])
    const saved: SavedJob = { job: structuredClone(first.jobs[0]), company: alpha, note: BOUNDS_NOTE, status: 'applied', savedAt: '2026-09-30T09:00:30.000Z' }
    const original = structuredClone(stored()[0])
    expect(presence.stored()).toHaveLength(2)
    expect(presence.stored()[0]).toMatchObject({
      companyId: 'bounds-alpha', board: 'AlphaBounds72', provider: 'smartrecruiters', checkedAt: BOUNDS_TIME, failures: 0, retryAt: null,
      snapshot: { fetchedAt: BOUNDS_TIME, total: 2, publishedIds: alphaIds },
    })
    expect(wire.requests).toHaveLength(5)

    wire.replace(responses(true))
    now = Date.parse(BOUNDS_CHANGE_TIME)
    const failed = await service.get(true)
    expect(failed.jobs.map(job => job.id)).toEqual([...alphaIds, betaId])
    expect(failed.boards).toMatchObject([
      { status: 'error', dataStatus: 'stale', lastSuccessAt: BOUNDS_TIME, checkedAt: BOUNDS_CHANGE_TIME, total: 2, included: 2, message: JSON_SIZE_MESSAGE, retryAt: '2026-09-30T09:03:00.000Z' },
      { status: 'ok', dataStatus: 'fresh', lastSuccessAt: BOUNDS_CHANGE_TIME, total: 1, included: 1 },
    ])
    expect(stored()[0].snapshot).toEqual(original.snapshot)
    expect(stored()[0]).toMatchObject({ failures: 1, errorPhase: 'content', checkedAt: BOUNDS_CHANGE_TIME, retryAt: '2026-09-30T09:03:00.000Z', error: JSON_SIZE_MESSAGE })
    expect(stored()[1]).toMatchObject({ failures: 0, retryAt: null })
    expect(wire.streams).toHaveLength(1)
    expect(wire.streams[0].url).toBe(detailUrl('AlphaBounds72', 'a2'))
    expectEarlyStop(wire.streams[0], JSON_CAP_BYTES)
    expect(wire.requests).toHaveLength(10)

    // A content failure leaves the retained presence entry untouched; the sibling's is renewed.
    expect(presence.stored()).toHaveLength(2)
    expect(presence.stored()[0]).toMatchObject({
      companyId: 'bounds-alpha', board: 'AlphaBounds72', provider: 'smartrecruiters', checkedAt: BOUNDS_TIME, failures: 0, retryAt: null,
      snapshot: { fetchedAt: BOUNDS_TIME, total: 2, publishedIds: alphaIds },
    })
    expect(presence.stored()[0]).not.toHaveProperty('error')
    expect(presence.stored()[1]).toMatchObject({
      companyId: 'bounds-beta', checkedAt: BOUNDS_CHANGE_TIME, failures: 0, retryAt: null,
      snapshot: { fetchedAt: BOUNDS_CHANGE_TIME, total: 1, publishedIds: [betaId] },
    })

    const status = await service.getPostingStatus(true)
    expect(status.version).toBe(2)
    expect(status).toMatchObject({ checkedAt: BOUNDS_CHANGE_TIME, refreshAfter: '2026-09-30T09:03:00.000Z', contentRefreshAfter: '2026-09-30T09:03:00.000Z' })
    expect(status.boards[0]).toMatchObject({
      companyId: 'bounds-alpha', status: 'ok', checkedAt: BOUNDS_TIME, lastSuccessAt: BOUNDS_TIME, retryAt: null,
      listing: {
        validUntil: '2026-09-30T09:30:00.000Z', publishedIds: alphaIds, jobs: [],
        content: { checkedAt: BOUNDS_TIME, validUntil: '2026-09-30T09:30:00.000Z', status: 'error', jobIds: alphaIds },
      },
    })
    expect(status.boards[0]).not.toHaveProperty('message')
    expect(status.boards[1]).toMatchObject({
      companyId: 'bounds-beta', status: 'ok', checkedAt: BOUNDS_CHANGE_TIME, lastSuccessAt: BOUNDS_CHANGE_TIME, retryAt: null,
      listing: {
        validUntil: '2026-09-30T09:32:00.000Z', publishedIds: [betaId],
        content: { checkedAt: BOUNDS_CHANGE_TIME, validUntil: '2026-09-30T09:32:00.000Z', status: 'ok', jobIds: [betaId] },
      },
    })
    expect(status.boards[1].listing?.jobs).toHaveLength(1)
    expect(status.boards[1].listing?.jobs[0]).toMatchObject({ id: betaId, title: 'Backend Engineer — Beta One 72' })
    expect(observeSavedPosting(saved, status, undefined, now)).toEqual({
      state: 'listed', checkedAt: BOUNDS_TIME, contentCheckedAt: BOUNDS_TIME, contentState: 'unavailable',
      message: '게시 여부는 확인했어요. 비교할 수 있는 최신 본문이 없어 내용의 차이는 미확인입니다. 공고 내용 확인이나 원문을 이용해 주세요.',
    })
    // Neither status read fetches a new listing while the content retry is pending.
    expect(await service.getPostingStatus(true, true)).toEqual(status)
    expect(wire.requests).toHaveLength(10)
    expect(wire.requests.filter(isListRequest)).toHaveLength(4)

    const restarted = create()
    expect((await restarted.get()).jobs).toEqual(failed.jobs)
    expect((await restarted.getPostingStatus(true)).boards).toEqual(status.boards)
    expect(wire.requests).toHaveLength(10)
    expect(wire.streams).toHaveLength(1)
  }, HEAVY)
})

describe('official-site HTML bounds through the careers collector', () => {
  const zeroDelay = () => createCareersFetcher({ concurrency: 1, interval: 0, bookingInterval: 0, timeout: 30_000 })
  const company = careersCompany('zalando')
  const htmlOf = (responses: Record<string, unknown>, url: string) => asCoverageReply(responses[url]).body as string

  it('reads a list page of exactly the HTML cap, and rejects an oversized list as an inventory failure without requesting details', async () => {
    const base = zalandoResponses()
    const exact = transport({ ...base, [ZALANDO_LIST_URLS[0]]: paddedHtml(htmlOf(base, ZALANDO_LIST_URLS[0]), HTML_CAP_BYTES) })
    const result = await zeroDelay().fetchBoard(company, CAREERS_NOW)
    expect(result.total).toBe(16)
    expect(result.jobs.map(job => job.id)).toEqual(['careers-zalando-640001', 'careers-zalando-640016'])
    expect(exact.streams).toEqual([{ url: ZALANDO_LIST_URLS[0], cancelled: false, pulledBytes: HTML_CAP_BYTES }])

    const over = transport({ ...base, [ZALANDO_LIST_URLS[0]]: paddedHtml(htmlOf(base, ZALANDO_LIST_URLS[0]), HTML_OVER_CAP_BYTES) })
    const failure = await failureOf(zeroDelay().fetchBoard(company, CAREERS_NOW))
    expect(failure).toBeInstanceOf(BoardInventoryError)
    expect((failure as Error).message).toBe(HTML_SIZE_MESSAGE)
    await expect(zeroDelay().fetchPresence(company)).rejects.toBeInstanceOf(BoardInventoryError)
    expect(over.requests.some(url => /\/en\/jobs\/\d/.test(url))).toBe(false)
    expect(over.streams).toHaveLength(2)
    for (const stream of over.streams) {
      expect(stream.url).toBe(ZALANDO_LIST_URLS[0])
      expectEarlyStop(stream, HTML_CAP_BYTES)
    }
  }, 60_000)

  it('fails content but not presence when a detail page is over the HTML cap', async () => {
    const base = zalandoResponses()
    const wire = transport({ ...base, [ZALANDO_DETAIL_URLS[0]]: paddedHtml(htmlOf(base, ZALANDO_DETAIL_URLS[0]), HTML_OVER_CAP_BYTES) })
    const failure = await failureOf(zeroDelay().fetchBoard(company, CAREERS_NOW))
    expect(failure).toBeInstanceOf(BoardFetchError)
    expect(failure).not.toBeInstanceOf(BoardInventoryError)
    expect((failure as Error).message).toBe(HTML_SIZE_MESSAGE)
    const listing = await zeroDelay().fetchPresence(company)
    expect(listing.total).toBe(16)
    expect(listing.publishedIds).toHaveLength(16)
    expect(wire.streams).toHaveLength(1)
    expect(wire.streams[0].url).toBe(ZALANDO_DETAIL_URLS[0])
    expectEarlyStop(wire.streams[0], HTML_CAP_BYTES)
  }, 60_000)
})
