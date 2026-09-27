import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BoardConfigurationError, parseBoardConfiguration } from '../../server/board-config'
import { JobProviderSchema } from '../../shared/schemas'
import { JOB_SOURCE_LABELS, PUBLIC_PROVIDERS } from '../../shared/types'
import type { Catalog } from '../../shared/types'
import {
  ageCatalog, catalogNeedsRevalidation, jobFreshness, snapshotDeadlines,
  sourceFreshFor, sourceRefreshInterval,
} from '../../shared/catalog-freshness'
import { PostingStatusIndexSchema } from '../../shared/posting-status'
import { createSampleCatalog } from '../../shared/sample'
import {
  CAREERS_NOW, CAREERS_REGISTRATIONS, careersCachedJob, careersCompany,
} from '../fixtures/careers-contract'

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('Careers policy tests must not contact any provider') }))
})
afterEach(() => {
  expect(vi.mocked(fetch)).not.toHaveBeenCalled()
  vi.unstubAllGlobals()
})

describe('approved official-careers source and configuration policy', () => {
  it('adds the official-site label while preserving every existing public source and sample label', () => {
    expect([...PUBLIC_PROVIDERS].sort()).toEqual([
      'ashby', 'careers', 'greenhouse', 'himalayas', 'lever', 'smartrecruiters', 'workable',
    ])
    expect(JobProviderSchema.parse('careers')).toBe('careers')
    expect(JobProviderSchema.safeParse('sample').success).toBe(false)
    expect(JOB_SOURCE_LABELS).toEqual({
      sample: '샘플', greenhouse: 'Greenhouse', ashby: 'Ashby', lever: 'Lever',
      smartrecruiters: 'SmartRecruiters', workable: 'Workable', himalayas: 'Himalayas',
      careers: '공식 채용 사이트',
    })
  })

  it('accepts exactly the three approved builtin board identities as explicit registrations', () => {
    const result = parseBoardConfiguration({ version: 1, mode: 'replace', companies: CAREERS_REGISTRATIONS })
    expect(result.mode).toBe('replace')
    expect(result.companies.map(({ id, name, provider, board }) => ({ id, name, provider, board }))).toEqual([
      { id: 'booking', name: 'Booking.com / Booking Holdings', provider: 'careers', board: 'booking' },
      { id: 'zalando', name: 'Zalando', provider: 'careers', board: 'zalando' },
      { id: 'starbucks', name: 'Starbucks', provider: 'careers', board: 'starbucks-technology' },
    ])
  })

  it.each([
    'walmart', 'starbucks', 'booking-archive', 'starbucks-technology-extra',
    'Booking', 'ZALANDO', 'STARBUCKS-TECHNOLOGY', 'jobs.booking.com',
    'example.com', 'https://jobs.booking.com/api/jobs', '%62ooking', 'booking%2fjobs',
  ])('rejects an arbitrary or noncanonical careers board: %s', board => {
    const input = {
      version: 1, mode: 'replace', companies: [{ ...CAREERS_REGISTRATIONS[0], board }],
    }
    expect(() => parseBoardConfiguration(input)).toThrow(BoardConfigurationError)
    expect(() => parseBoardConfiguration(input)).toThrow('companies[0].board')
  })

  it.each(['host', 'endpoint', 'baseUrl'])('rejects a caller-supplied %s instead of treating it as a routing override', field => {
    const input = {
      version: 1, mode: 'replace',
      companies: [{ ...CAREERS_REGISTRATIONS[0], [field]: 'https://example.com/synthetic/stage64/route-override' }],
    }
    expect(() => parseBoardConfiguration(input)).toThrow(BoardConfigurationError)
    expect(() => parseBoardConfiguration(input)).toThrow(field)
  })

  it('rejects a Lever region and two company IDs pointing at the same careers board', () => {
    expect(() => parseBoardConfiguration({
      version: 1, mode: 'replace', companies: [{ ...CAREERS_REGISTRATIONS[0], boardRegion: 'eu' }],
    })).toThrow('companies[0].boardRegion')
    expect(() => parseBoardConfiguration({
      version: 1, mode: 'replace',
      companies: [CAREERS_REGISTRATIONS[0], { ...CAREERS_REGISTRATIONS[0], id: 'synthetic-booking-alias' }],
    })).toThrow(BoardConfigurationError)
  })

  it('retains the Stage64 sample contract until its separate removal stage', () => {
    const catalog = createSampleCatalog()
    expect(catalog.source).toBe('sample')
    expect(catalog.companies).toHaveLength(32)
    expect(catalog.jobs).toHaveLength(179)
    expect(catalog.cities).toHaveLength(22)
    expect(catalog.jobs.every(job => job.source === 'sample')).toBe(true)
  })
})

describe('literal daily freshness for official careers sites', () => {
  it.each([
    ['careers', 86_400_000, 86_400_000],
    ['himalayas', 86_400_000, 86_400_000],
    ['greenhouse', 1_800_000, 60_000],
    ['ashby', 1_800_000, 60_000],
    ['lever', 1_800_000, 60_000],
    ['smartrecruiters', 1_800_000, 60_000],
    ['workable', 1_800_000, 60_000],
  ] as const)('%s has its own explicit freshness and successful-refresh interval', (name, fresh, interval) => {
    const provider = JobProviderSchema.parse(name)
    expect(sourceFreshFor(provider)).toBe(fresh)
    expect(sourceRefreshInterval(provider)).toBe(interval)
  })

  it('keeps the visible snapshot fresh at 30m and just before 24h, stale at 24h, and expired 1ms later', () => {
    const job = careersCachedJob()
    const catalog: Catalog = {
      source: 'public', fetchedAt: CAREERS_NOW, stale: false, cities: [],
      companies: [careersCompany('booking')], jobs: [job], unmappedCount: 0,
      boards: [{
        companyId: 'booking', provider: JobProviderSchema.parse('careers'), board: 'booking',
        status: 'ok', dataStatus: 'fresh', total: 2, included: 1,
        checkedAt: CAREERS_NOW, lastSuccessAt: CAREERS_NOW,
      }],
    }
    const original = structuredClone(catalog)
    expect(jobFreshness(job, Date.parse('2026-10-02T10:30:00.000Z'))).toBe('fresh')
    expect(catalogNeedsRevalidation(catalog, Date.parse('2026-10-02T10:30:00.000Z'))).toBe(false)
    expect(jobFreshness(job, Date.parse('2026-10-03T09:59:59.999Z'))).toBe('fresh')
    expect(catalogNeedsRevalidation(catalog, Date.parse('2026-10-03T09:59:59.999Z'))).toBe(false)
    expect(ageCatalog(catalog, Date.parse('2026-10-03T09:59:59.999Z')).catalog).toEqual(original)
    expect(jobFreshness(job, Date.parse('2026-10-03T10:00:00.000Z'))).toBe('stale')
    expect(catalogNeedsRevalidation(catalog, Date.parse('2026-10-03T10:00:00.000Z'))).toBe(true)
    expect(ageCatalog(catalog, Date.parse('2026-10-03T10:00:00.000Z')).catalog.jobs).toMatchObject([
      { id: 'careers-booking-6400001', fetchedAt: '2026-10-02T10:00:00.000Z', stale: true },
    ])
    expect(jobFreshness(job, Date.parse('2026-10-03T10:00:00.001Z'))).toBe('expired')
    const expired = ageCatalog(catalog, Date.parse('2026-10-03T10:00:00.001Z'))
    expect(expired.catalog.jobs).toEqual([])
    expect(expired.catalog.boards).toMatchObject([
      { companyId: 'booking', dataStatus: 'unavailable', included: 0, total: 0, lastSuccessAt: '2026-10-02T10:00:00.000Z' },
    ])
    expect(catalog).toEqual(original)
    expect(snapshotDeadlines(CAREERS_NOW, JobProviderSchema.parse('careers'))).toEqual([
      Date.parse('2026-10-03T10:00:00.000Z'), Date.parse('2026-10-03T10:00:00.001Z'),
    ])
  })

  it('validates list and body evidence against separate literal 24h bounds', () => {
    const input = {
      version: 2, checkedAt: CAREERS_NOW,
      refreshAfter: '2026-10-03T10:00:00.000Z', contentRefreshAfter: '2026-10-03T10:00:00.000Z',
      boards: [{
        companyId: 'booking', provider: 'careers', board: 'booking',
        checkedAt: CAREERS_NOW, lastSuccessAt: CAREERS_NOW, status: 'ok', retryAt: null,
        listing: {
          validUntil: '2026-10-03T10:00:00.000Z', publishedIds: [], jobs: [],
          content: { checkedAt: CAREERS_NOW, validUntil: '2026-10-03T10:00:00.000Z', status: 'ok', jobIds: [] },
        },
      }],
    }
    expect(PostingStatusIndexSchema.safeParse(input).success).toBe(true)
    const lateList = structuredClone(input)
    lateList.boards[0].listing.validUntil = '2026-10-03T10:00:00.001Z'
    expect(PostingStatusIndexSchema.safeParse(lateList).success).toBe(false)
    const lateBody = structuredClone(input)
    lateBody.boards[0].listing.content.validUntil = '2026-10-03T10:00:00.001Z'
    expect(PostingStatusIndexSchema.safeParse(lateBody).success).toBe(false)
  })
})
