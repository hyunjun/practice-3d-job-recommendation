import { afterEach, describe, expect, it, vi } from 'vitest'
import { BoardFetchError } from '../../server/catalog-service'
import { createSmartRecruitersFetcher } from '../../server/providers/smartrecruiters'
import { fetchGreenhousePresence } from '../../server/providers/greenhouse'
import { fetchAshbyPresence } from '../../server/providers/ashby'
import { fetchLeverPresence } from '../../server/providers/lever'
import type { Company } from '../../shared/types'
import { PRESENCE_COMPANY, PRESENCE_NOW, PRESENCE_PAGE_URLS, presenceResponses } from '../fixtures/posting-presence'
import type { PresenceResponses } from '../fixtures/posting-presence'

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
function transport(responses: PresenceResponses) {
  const requests: string[] = []
  const fetcher = vi.fn(async (input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : String(input)
    requests.push(url)
    const response = responses[url]
    if (!response) throw new Error(`Unexpected fictional fixture URL: ${url}`)
    if (response.failure) throw new Error(response.failure)
    return Response.json(response.body, { status: response.status ?? 200, headers: response.headers })
  })
  vi.stubGlobal('fetch', fetcher)
  return { requests, fetcher }
}
const smart = () => createSmartRecruitersFetcher({ concurrency: 4, interval: 0, timeout: 120_000 })

describe('independent SmartRecruiters presence transport', () => {
  it('reads all three list-only pages and the last out-of-scope ID without requiring or requesting any body', async () => {
    const upstream = transport(presenceResponses({ detailFailure: true }))
    const result = await smart().fetchPresence(PRESENCE_COMPANY)
    expect(upstream.requests).toEqual([
      'https://api.smartrecruiters.com/v1/companies/HarbourPresence59/postings?limit=100&offset=0&destination=PUBLIC',
      'https://api.smartrecruiters.com/v1/companies/HarbourPresence59/postings?limit=100&offset=100&destination=PUBLIC',
      'https://api.smartrecruiters.com/v1/companies/HarbourPresence59/postings?limit=100&offset=200&destination=PUBLIC',
    ])
    expect(result.total).toBe(201)
    expect(result.publishedIds).toHaveLength(201)
    expect(result.publishedIds[0]).toBe('smartrecruiters-presence-harbour-59001')
    expect(result.publishedIds[100]).toBe('smartrecruiters-presence-harbour-59101')
    expect(result.publishedIds[200]).toBe('smartrecruiters-presence-harbour-59201')
    expect(result).not.toHaveProperty('jobs')
  })

  it.each(['partial-final', 'duplicate-page', 'total-shift', 'foreign-company', 'internal-row', 'last-page-503', 'last-page-429'] as const)(
    'rejects %s without returning a partial or falsely empty inventory',
    async scenario => {
      const upstream = transport(presenceResponses({ scenario }))
      await expect(smart().fetchPresence(PRESENCE_COMPANY)).rejects.toBeInstanceOf(BoardFetchError)
      expect(upstream.requests.every(url => PRESENCE_PAGE_URLS.includes(url as typeof PRESENCE_PAGE_URLS[number]))).toBe(true)
      expect(upstream.requests).toHaveLength(scenario === 'duplicate-page' ? 2 : 3)
    },
  )

  it('shares a 429 cooldown between presence and full-body actions instead of creating a bypass queue', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(PRESENCE_NOW))
    const failing = presenceResponses({ scenario: 'last-page-429' })
    const upstream = transport(failing)
    const fetcher = smart()
    await expect(fetcher.fetchPresence(PRESENCE_COMPANY)).rejects.toMatchObject({ retryAfter: Date.parse('2026-09-26T03:10:00.000Z') })
    await expect(fetcher(PRESENCE_COMPANY, PRESENCE_NOW)).rejects.toBeInstanceOf(BoardFetchError)
    expect(upstream.requests).toHaveLength(3)
    vi.setSystemTime(new Date('2026-09-26T03:09:59.999Z'))
    await expect(fetcher(PRESENCE_COMPANY, '2026-09-26T03:09:59.999Z')).rejects.toBeInstanceOf(BoardFetchError)
    expect(upstream.requests).toHaveLength(3)
    Object.assign(failing, presenceResponses())
    vi.setSystemTime(new Date('2026-09-26T03:10:00.000Z'))
    const full = await fetcher(PRESENCE_COMPANY, '2026-09-26T03:10:00.000Z')
    expect(upstream.requests).toHaveLength(8)
    expect(full.jobs.map(job => job.title)).toEqual(['Backend Engineer — Harbour Relay', 'Frontend Engineer — Harbour Console'])
    expect(full.verifiedActiveIds).toEqual(['smartrecruiters-presence-harbour-59001', 'smartrecruiters-presence-harbour-59101'])
    expect(full.jobs[0].description).toBe('Responsibilities\nBuild a fictional relay with TypeScript.\n\nMinimum requirements\n3 years of software engineering experience.')
  })

  it.each(['inactive', 'internal'] as const)('keeps %s detail negatives separate from all later public summary IDs', async unpublishedDetail => {
    transport(presenceResponses({ unpublishedDetail }))
    const fetcher = smart()
    const full = await fetcher(PRESENCE_COMPANY, PRESENCE_NOW)
    expect(full.total).toBe(200)
    expect(full.unpublishedIds).toEqual(['smartrecruiters-presence-harbour-59001'])
    expect(full.verifiedActiveIds).toEqual(['smartrecruiters-presence-harbour-59101'])
    expect(full.publishedIds).not.toContain('smartrecruiters-presence-harbour-59001')
    expect(full.jobs.map(job => job.title)).toEqual(['Frontend Engineer — Harbour Console'])
    const presence = await fetcher.fetchPresence(PRESENCE_COMPANY)
    expect(presence.total).toBe(201)
    expect(presence.publishedIds).toContain('smartrecruiters-presence-harbour-59001')
  })
})

describe('independent lightweight adapters for the other public providers', () => {
  it('Greenhouse requests content=false, includes nontechnical IDs and ignores deliberately invalid body fields', async () => {
    const company: Company = { ...PRESENCE_COMPANY, id: 'presence-fern', provider: 'greenhouse', board: 'FernPresence59' }
    const url = 'https://boards-api.greenhouse.io/v1/boards/FernPresence59/jobs?content=false'
    const responses = { [url]: { body: { jobs: [
      { id: 1, title: 'Backend Engineer — Fern Fictional', absolute_url: 'https://example.com/fern/1', content: { mustNotParse: true } },
      { id: 2, title: 'Account Executive — Fern Fictional', absolute_url: 'https://example.com/fern/2' },
    ], meta: { total: 2 } } } }
    const upstream = transport(responses)
    expect(await fetchGreenhousePresence(company)).toEqual({
      total: 2, publishedIds: ['greenhouse-presence-fern-1', 'greenhouse-presence-fern-2'],
    })
    expect(upstream.requests).toEqual(['https://boards-api.greenhouse.io/v1/boards/FernPresence59/jobs?content=false'])
    responses[url].body.meta.total = 3
    await expect(fetchGreenhousePresence(company)).rejects.toBeInstanceOf(BoardFetchError)
  })

  it('Ashby omits compensation and ignores bodies while validating listed flags and all duplicate IDs', async () => {
    const company: Company = { ...PRESENCE_COMPANY, id: 'presence-birch', provider: 'ashby', board: 'BirchPresence59' }
    const url = 'https://api.ashbyhq.com/posting-api/job-board/BirchPresence59'
    const responses = { [url]: { body: { apiVersion: '1', jobs: [
      { id: 'one', title: 'Backend Engineer — Birch Fictional', jobUrl: 'https://example.com/birch/one', isListed: true, descriptionPlain: { mustNotParse: true } },
      { id: 'outside', title: 'Account Executive — Birch Fictional', jobUrl: 'https://example.com/birch/outside', isListed: true },
      { id: 'private', title: 'Backend Engineer — Birch Internal', jobUrl: 'https://example.com/birch/private', isListed: false },
    ] } } }
    const upstream = transport(responses)
    expect(await fetchAshbyPresence(company)).toEqual({
      total: 2, publishedIds: ['ashby-presence-birch-one', 'ashby-presence-birch-outside'],
    })
    expect(upstream.requests).toEqual(['https://api.ashbyhq.com/posting-api/job-board/BirchPresence59'])
    responses[url].body.jobs.push({ ...responses[url].body.jobs[0] })
    await expect(fetchAshbyPresence(company)).rejects.toBeInstanceOf(BoardFetchError)
  })

  it('Lever preserves the EU host, reads the final page and rejects a duplicate across pages without parsing body fields', async () => {
    const company: Company = { ...PRESENCE_COMPANY, id: 'presence-cedar', provider: 'lever', board: 'CedarPresence59', boardRegion: 'eu' }
    const first = 'https://api.eu.lever.co/v0/postings/CedarPresence59?mode=json&limit=50&skip=0'
    const final = 'https://api.eu.lever.co/v0/postings/CedarPresence59?mode=json&limit=50&skip=50'
    const rows = Array.from({ length: 51 }, (_, index) => ({
      id: `fictional-${index + 1}`, text: 'Account Executive — Cedar Fictional',
      hostedUrl: `https://example.com/cedar/${index + 1}`, descriptionPlain: { mustNotParse: true },
    }))
    const responses = { [first]: { body: rows.slice(0, 50) }, [final]: { body: rows.slice(50) } }
    const upstream = transport(responses)
    const result = await fetchLeverPresence(company)
    expect(result.total).toBe(51)
    expect(result.publishedIds[50]).toBe('lever-presence-cedar-fictional-51')
    expect(upstream.requests).toEqual([
      'https://api.eu.lever.co/v0/postings/CedarPresence59?mode=json&limit=50&skip=0',
      'https://api.eu.lever.co/v0/postings/CedarPresence59?mode=json&limit=50&skip=50',
    ])
    responses[final].body = [rows[0]]
    await expect(fetchLeverPresence(company)).rejects.toBeInstanceOf(BoardFetchError)
  })
})
