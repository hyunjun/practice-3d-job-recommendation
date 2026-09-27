import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PUBLIC_COMPANIES } from '../../shared/companies'
import { parseBoardConfiguration } from '../../server/board-config'
import { createCatalogService } from '../../server/catalog-service'
import type { CachedBoard } from '../../server/board-cache'
import { fetchAshbyBoard } from '../../server/providers/ashby'
import { fetchGreenhouseBoard } from '../../server/providers/greenhouse'
import { fetchLeverBoard } from '../../server/providers/lever'
import { fetchWorkableBoard } from '../../server/providers/workable'
import type { Company } from '../../shared/types'
import {
  isRegionalSourceRequest, REGIONAL_SOURCE_FULL_URLS, REGIONAL_SOURCE_IDS,
  REGIONAL_SOURCE_REGISTRATIONS, withRegionalSourceEmptyBoards,
} from '../fixtures/regional-sources'

vi.mock('../../server/providers/request-queue', async importOriginal => {
  const actual = await importOriginal<typeof import('../../server/providers/request-queue')>()
  return { ...actual, createBoardRequestQueue: (options: Parameters<typeof actual.createBoardRequestQueue>[0]) =>
    actual.createBoardRequestQueue({ ...options, interval: 0 }) }
})
const at = '2026-09-27T06:00:00.000Z'
// Keep the request queue on one clock for every scenario. Moving backwards
// after an earlier empty-board request would create a fictional queue delay.
beforeEach(() => { vi.spyOn(Date, 'now').mockReturnValue(Date.parse(at)) })
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

function fetchBoard(company: Company, time: string) {
  if (company.provider === 'ashby') return fetchAshbyBoard(company, time)
  if (company.provider === 'greenhouse') return fetchGreenhouseBoard(company, time)
  if (company.provider === 'lever') return fetchLeverBoard(company, time)
  if (company.provider === 'workable') return fetchWorkableBoard(company, time)
  throw new Error('Unexpected provider in the approved six-source fixture')
}

function transport(responses = withRegionalSourceEmptyBoards()) {
  const requests: { url: string; method: string; body: unknown }[] = []
  const unexpected: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input)
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET')
    const body = init?.body ?? null
    requests.push({ url, method, body })
    if (!isRegionalSourceRequest(url) || !Object.hasOwn(responses, url) || method !== 'GET' || body !== null) {
      unexpected.push(url)
      throw new Error(`Blocked unregistered synthetic regional request: ${url}`)
    }
    return Response.json(responses[url])
  }))
  return { requests, unexpected }
}

const body = '<p>Fictional stage70 vacancy. Build a backend service with TypeScript.</p>'
function fictionalResponses() {
  return withRegionalSourceEmptyBoards({
    'https://api.ashbyhq.com/posting-api/job-board/halter?includeCompensation=true': { apiVersion: '1', jobs: [{
      id: 'synthetic-halter70', title: 'Backend Engineer — Synthetic Fern Fence70', isListed: true,
      jobUrl: 'https://example.test/regional-sources/halter70', location: 'Auckland',
      address: { postalAddress: { addressLocality: 'Auckland', addressCountry: 'NZ' } },
      workplaceType: 'OnSite', descriptionHtml: body,
    }] },
    'https://api.ashbyhq.com/posting-api/job-board/partly.com?includeCompensation=true': { apiVersion: '1', jobs: [{
      id: 'synthetic-partly70', title: 'Backend Engineer — Synthetic Birch Repair70', isListed: true,
      jobUrl: 'https://example.test/regional-sources/partly70', location: 'Christchurch',
      address: { postalAddress: { addressLocality: 'Christchurch', addressCountry: 'NZL' } },
      workplaceType: 'OnSite', descriptionHtml: body,
    }] },
    'https://boards-api.greenhouse.io/v1/boards/pushpay/jobs?content=true&pay_transparency=true': { meta: { total: 1 }, jobs: [{
      id: 700301, title: 'Backend Engineer — Synthetic Maple Giving70',
      absolute_url: 'https://example.test/regional-sources/pushpay70',
      location: { name: 'Wellington, New Zealand' }, content: body, updated_at: '2026-09-26T12:00:00.000Z',
    }] },
    'https://api.lever.co/v0/postings/lalamove?mode=json&limit=50&skip=0': [{
      id: 'synthetic-lalamove70', text: 'Backend Engineer — Synthetic Cedar Delivery70',
      hostedUrl: 'https://example.test/regional-sources/lalamove70',
      categories: { location: 'Hong Kong', allLocations: ['Hong Kong', 'Taipei, Taiwan'], department: 'Engineering' },
      country: 'HK', workplaceType: 'onsite', description: body,
    }],
    'https://boards-api.greenhouse.io/v1/boards/datsolutions/jobs?content=true&pay_transparency=true': { meta: { total: 1 }, jobs: [{
      id: 700501, title: 'Backend Engineer — Synthetic Alder Freight70',
      absolute_url: 'https://example.test/regional-sources/dat70',
      location: { name: 'Portland, Oregon, United States' }, content: body, updated_at: '2026-09-26T12:00:00.000Z',
    }] },
    'https://apply.workable.com/api/v1/widget/accounts/pikpok?details=true': { name: 'PikPok', jobs: [{
      shortcode: 'SYN70PIKPOK', title: 'Backend Engineer — Synthetic Willow Game70',
      url: 'https://apply.workable.com/j/SYN70PIKPOK/', description: body, telecommuting: false,
      locations: [{ city: 'Wellington', country: 'New Zealand', countryCode: 'NZ', hidden: false }],
    }] },
  })
}

describe('six regional sources in the130-company registry', () => {
  it('preserves the historical124 and appends exactly the approved names, boards and official links', () => {
    expect(PUBLIC_COMPANIES).toHaveLength(130)
    expect(PUBLIC_COMPANIES.slice(124).map(({ id, name, provider, board, careerUrl, industry }) =>
      ({ id, name, provider, board, careerUrl, industry }))).toEqual(REGIONAL_SOURCE_REGISTRATIONS)
    expect(PUBLIC_COMPANIES[123].id).toBe('auto1')
    expect(new Set(PUBLIC_COMPANIES.map(company => company.id)).size).toBe(130)
    expect(Object.fromEntries(['greenhouse', 'ashby', 'lever', 'smartrecruiters', 'workable', 'himalayas', 'careers']
      .map(provider => [provider, PUBLIC_COMPANIES.filter(company => company.provider === provider).length])))
      .toEqual({ greenhouse: 67, ashby: 29, lever: 10, smartrecruiters: 10, workable: 4, himalayas: 7, careers: 3 })
    const configured = parseBoardConfiguration({ version: 1, mode: 'replace', companies: REGIONAL_SOURCE_IDS })
    expect(configured.companies.map(company => company.id))
      .toEqual(['halter', 'partly', 'pushpay', 'lalamove', 'dat', 'pikpok'])
  })

  it.each(REGIONAL_SOURCE_REGISTRATIONS)('keeps $name as a valid covered source even with zero fictional postings', async registration => {
    const network = transport()
    const company = PUBLIC_COMPANIES.find(company => company.id === registration.id)!
    const result = await fetchBoard(company, at)
    expect(result).toMatchObject({ jobs: [], publishedIds: [], total: 0, unmappedCount: 0 })
    expect(network.requests).toHaveLength(1)
    expect(network.requests[0]).toMatchObject({ method: 'GET', body: null })
    expect(network.unexpected).toEqual([])
  })

  it('uses exact public routes and posting locations through collection and cache restart', async () => {
    const responses = fictionalResponses()
    const before = JSON.stringify(responses)
    const network = transport(responses)
    let boards: CachedBoard[] = []
    const companies = PUBLIC_COMPANIES.filter(company => REGIONAL_SOURCE_IDS.includes(company.id))
    const service = () => createCatalogService({
      companies, now: () => Date.parse('2026-09-27T06:00:10.000Z'), random: () => 0, fetchBoard,
      cache: { load: async () => structuredClone(boards), save: async value => { boards = structuredClone(value) } },
    })
    const catalog = await service().get()
    expect(catalog.companies).toHaveLength(6)
    expect(catalog.boards.map(board => [board.companyId, board.status, board.total, board.included])).toEqual([
      ['halter', 'ok', 1, 1], ['partly', 'ok', 1, 1], ['pushpay', 'ok', 1, 1],
      ['lalamove', 'ok', 1, 1], ['dat', 'ok', 1, 1], ['pikpok', 'ok', 1, 1],
    ])
    expect(catalog.jobs.map(job => [job.id, [...job.cityIds].sort(), job.url])).toEqual([
      ['ashby-halter-synthetic-halter70', ['auckland'], 'https://example.test/regional-sources/halter70'],
      ['ashby-partly-synthetic-partly70', ['christchurch'], 'https://example.test/regional-sources/partly70'],
      ['greenhouse-pushpay-700301', ['wellington'], 'https://example.test/regional-sources/pushpay70'],
      ['lever-lalamove-synthetic-lalamove70', ['hong-kong', 'taipei'], 'https://example.test/regional-sources/lalamove70'],
      ['greenhouse-dat-700501', ['portland'], 'https://example.test/regional-sources/dat70'],
      ['workable-pikpok-SYN70PIKPOK', ['wellington'], 'https://apply.workable.com/j/SYN70PIKPOK/'],
    ])
    expect(catalog.jobs.every(job => job.fetchedAt === '2026-09-27T06:00:10.000Z' && job.cityCoverageVersion === 1)).toBe(true)
    expect(catalog.unmappedCount).toBe(0)
    expect(network.requests.map(request => request.url).sort()).toEqual([...REGIONAL_SOURCE_FULL_URLS].sort())
    expect(network.unexpected).toEqual([])
    const current = JSON.stringify(boards)
    expect((await service().get()).jobs).toEqual(catalog.jobs)
    expect(JSON.stringify(boards)).toBe(current)
    expect(network.requests).toHaveLength(6)
    expect(JSON.stringify(responses)).toBe(before)
  })
})
