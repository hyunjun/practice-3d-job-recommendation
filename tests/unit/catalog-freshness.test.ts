import { describe, expect, it } from 'vitest'
import { ageCatalog, catalogDeadlines, CATALOG_LIFETIME, jobFreshness, snapshotDeadlines } from '../../shared/catalog-freshness'
import { collectionHealth } from '../../shared/catalog-health'
import { createSampleCatalog } from '../../shared/sample'
import { searchCatalog, searchJob, SEARCH_COMPANIES, SEARCH_TIME } from '../fixtures/search-catalog'

const base = Date.parse(SEARCH_TIME)
const iso = (time: number) => new Date(time).toISOString()
const { freshFor, maxFallbackAge } = CATALOG_LIFETIME

describe('the age of displayed public snapshots', () => {
  it('marks exactly 30 minutes as old and excludes only after the original 24-hour limit', () => {
    const job = searchJob('boundary')
    expect(jobFreshness(job, base + freshFor - 1)).toBe('fresh')
    expect(jobFreshness(job, base + freshFor)).toBe('stale')
    expect(jobFreshness(job, base + maxFallbackAge)).toBe('stale')
    expect(jobFreshness(job, base + maxFallbackAge + 1)).toBe('expired')
    expect(catalogDeadlines(searchCatalog([job]))).toEqual([base + freshFor, base + maxFallbackAge + 1])
  })

  it('ages successful results without inventing a failed request or rewriting the source snapshot', () => {
    const source = searchCatalog([searchJob('aged')])
    const before = structuredClone(source)
    expect(ageCatalog(source, base + freshFor - 1).catalog).toBe(source)
    const { catalog, expired } = ageCatalog(source, base + freshFor)
    expect(expired).toBe(false)
    expect(catalog.jobs[0]).toMatchObject({ stale: true, fetchedAt: SEARCH_TIME })
    expect(catalog.boards.every(board => board.status === 'ok' && board.dataStatus === 'stale' && !board.message)).toBe(true)
    expect(collectionHealth(catalog)).toMatchObject({ recent: 0, retained: 1, failed: 0 })
    expect(catalog.fetchedAt).toBe(SEARCH_TIME)
    expect(source).toEqual(before)
  })

  it('expires each company independently and subtracts only expired unmapped records', () => {
    const newer = iso(base + 60 * 60_000)
    const source = searchCatalog([
      searchJob('old-location', { cityIds: [], locationLabel: 'Unknown original location' }),
      searchJob('new-location', { companyId: SEARCH_COMPANIES[1].id, cityIds: [], fetchedAt: newer }),
    ])
    source.fetchedAt = newer
    source.boards = source.boards.map((board, index) => ({ ...board, lastSuccessAt: index ? newer : SEARCH_TIME, checkedAt: newer }))
    const { catalog, expired } = ageCatalog(source, base + maxFallbackAge + 1)
    expect(expired).toBe(false)
    expect(catalog.jobs.map(job => job.id)).toEqual([source.jobs[1].id])
    expect(catalog.unmappedCount).toBe(1)
    expect(catalog.boards[0]).toMatchObject({ status: 'ok', dataStatus: 'unavailable', included: 0, total: 0, lastSuccessAt: SEARCH_TIME, checkedAt: newer })
    expect(catalog.boards[1]).toMatchObject({ status: 'ok', dataStatus: 'stale', included: 1 })
    expect(collectionHealth(catalog)).toEqual({ recent: 0, retained: 1, unavailable: 1, failed: 0 })
  })

  it('clears the completed-result marker when every snapshot expires but preserves board history', () => {
    const source = searchCatalog([searchJob('expires')])
    source.boards = source.boards.map(board => ({ ...board, lastSuccessAt: SEARCH_TIME, checkedAt: SEARCH_TIME }))
    const { catalog, expired } = ageCatalog(source, base + maxFallbackAge + 1)
    expect(expired).toBe(true)
    expect(catalog).toMatchObject({ source: 'public', jobs: [], fetchedAt: '', unmappedCount: 0 })
    expect(catalog.companies).toBe(source.companies)
    expect(catalog.boards.every(board => board.lastSuccessAt === SEARCH_TIME && board.checkedAt === SEARCH_TIME && board.status === 'ok')).toBe(true)
    expect(source.jobs).toHaveLength(1)
  })

  it('keeps a newer authoritative empty board usable while old jobs expire', () => {
    const newer = iso(base + maxFallbackAge - 1000)
    const source = searchCatalog([searchJob('old')])
    source.fetchedAt = newer
    source.boards = source.boards.map((board, index) => ({ ...board, lastSuccessAt: index ? newer : SEARCH_TIME }))
    const result = ageCatalog(source, base + maxFallbackAge + 1)
    expect(result.expired).toBe(false)
    expect(result.catalog.jobs).toEqual([])
    expect(result.catalog.fetchedAt).toBe(newer)
    expect(result.catalog.boards[1]).toMatchObject({ dataStatus: 'fresh', included: 0, total: 0 })
    const later = ageCatalog(source, Date.parse(newer) + maxFallbackAge + 1)
    expect(later.expired).toBe(true)
  })

  it('does not retain legacy count-only omissions when their company can no longer be identified', () => {
    const newer = iso(base + 60 * 60_000)
    const source = searchCatalog([searchJob('old'), searchJob('new', { companyId: SEARCH_COMPANIES[1].id, fetchedAt: newer })])
    source.fetchedAt = newer
    source.unmappedCount = 7
    source.boards = source.boards.map((board, index) => ({ ...board, lastSuccessAt: index ? newer : SEARCH_TIME }))
    expect(ageCatalog(source, base + maxFallbackAge + 1).catalog.unmappedCount).toBeNull()
    expect(ageCatalog(source, base + freshFor).catalog.unmappedCount).toBe(7)
  })

  it('preserves a real failure and retry deadline even if its snapshot is younger than 30 minutes', () => {
    const source = searchCatalog([searchJob('failed', { stale: true })])
    source.boards[0] = {
      ...source.boards[0], status: 'error', dataStatus: 'stale', lastSuccessAt: SEARCH_TIME,
      checkedAt: iso(base + 1000), retryAt: iso(base + 600_000), message: 'HTTP 429',
    }
    const before = structuredClone(source.boards[0])
    const result = ageCatalog(source, base + 2000)
    expect(result.catalog.boards[0]).toEqual(before)
    expect(result.catalog.jobs[0].stale).toBe(true)
    expect(collectionHealth(result.catalog)).toMatchObject({ failed: 1, retained: 1 })
  })

  it('uses legacy jobs own dates rather than making an old company new with the catalog timestamp', () => {
    const newer = iso(base + maxFallbackAge)
    const source = searchCatalog([searchJob('legacy')])
    source.fetchedAt = newer
    const result = ageCatalog(source, base + maxFallbackAge + 1)
    expect(result.catalog.jobs).toEqual([])
    expect(result.catalog.boards[0].dataStatus).toBe('unavailable')
    expect(result.catalog.boards[0].lastSuccessAt).toBe(SEARCH_TIME)
    expect(result.catalog.boards[1].dataStatus).toBe('fresh')
    expect(result.expired).toBe(false)
  })

  it('keeps samples and not-yet-loaded placeholders outside public expiry and rejects invalid record dates', () => {
    const sample = createSampleCatalog()
    expect(ageCatalog(sample, base + maxFallbackAge * 365).catalog).toBe(sample)
    expect(jobFreshness(sample.jobs[0], base + maxFallbackAge * 365)).toBe('fresh')
    expect(catalogDeadlines(sample)).toEqual([])
    const placeholder = { ...searchCatalog([]), fetchedAt: '', boards: [] }
    expect(ageCatalog(placeholder, base).catalog).toBe(placeholder)
    expect(ageCatalog(placeholder, base).expired).toBe(false)
    expect(snapshotDeadlines('not a date')).toEqual([])
    expect(jobFreshness(searchJob('invalid', { fetchedAt: 'not a date' }), base)).toBe('unknown')
  })
})
