import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { countSearchJobs, createSearchIndex, inSearchScope, selectSearchJobs } from '../../shared/job-search'
import { upgradeCatalog } from '../../shared/job-upgrade'
import { analyzeSearchRecovery } from '../../shared/search-recovery'
import { CatalogWorkerModel } from '../../src/lib/catalog-worker-model'
import type { CatalogViewInput } from '../../src/lib/catalog-worker-types'
import type { Filters } from '../../shared/types'
import {
  REGIONAL_ALL_CITIES, REGIONAL_FILTERS, REGIONAL_PROFILE,
  regionalCatalog, regionalLegacyJob, regionalPartialCatalog,
} from '../fixtures/regional-coverage'

const noNetwork = vi.fn(async () => { throw new Error('Partial workplace verification uses fictional in-memory records.') })
beforeEach(() => { noNetwork.mockClear(); vi.stubGlobal('fetch', noNetwork) })
afterEach(() => { expect(noNetwork).not.toHaveBeenCalled(); vi.unstubAllGlobals() })
const filters: Filters = { ...REGIONAL_FILTERS, remoteEligibleOnly: false }
const balticId = 'greenhouse-regional-cedar-partial-baltic'
const countryId = 'greenhouse-regional-cedar-partial-country'
const relayId = 'greenhouse-regional-cedar-partial-relay'
const remoteId = 'greenhouse-regional-cedar-partial-remote'

describe('confirmed regional workplaces survive a new city elsewhere', () => {
  it.each([
    { region: 'all', cities: [balticId, relayId], other: [countryId], remote: [remoteId],
      cityCount: { jobs: 2, companies: 1, cities: 3 }, otherCount: { jobs: 1, companies: 1, cities: 0 } },
    { region: 'asia-pacific', cities: [balticId, relayId], other: [], remote: [],
      cityCount: { jobs: 2, companies: 1, cities: 2 }, otherCount: { jobs: 0, companies: 0, cities: 0 } },
    { region: 'europe', cities: [relayId], other: [balticId, countryId], remote: [remoteId],
      cityCount: { jobs: 1, companies: 1, cities: 1 }, otherCount: { jobs: 2, companies: 1, cities: 0 } },
    { region: 'middle-east', cities: [], other: [], remote: [],
      cityCount: { jobs: 0, companies: 0, cities: 0 }, otherCount: { jobs: 0, companies: 0, cities: 0 } },
  ] as const)('keeps explicit city/other/remote lists disjoint in $region', row => {
    const current = upgradeCatalog(regionalPartialCatalog())
    expect(current.unmappedCount).toBe(1)
    expect(current.jobs[0].cityIds).toEqual(['kuala-lumpur'])
    expect(current.jobs[1].cityIds).toEqual(['berlin', 'taipei'])
    const index = createSearchIndex(current, REGIONAL_PROFILE)
    const matched = selectSearchJobs(index, { ...filters, region: row.region })
    expect(matched.filter(entry => inSearchScope(entry, { kind: 'cities' }, row.region)).map(entry => entry.job.id).sort()).toEqual(row.cities)
    expect(matched.filter(entry => inSearchScope(entry, { kind: 'unmapped' }, row.region)).map(entry => entry.job.id).sort()).toEqual(row.other)
    expect(matched.filter(entry => inSearchScope(entry, { kind: 'remote' }, row.region)).map(entry => entry.job.id).sort()).toEqual(row.remote)
    expect(countSearchJobs(matched, { kind: 'cities' }, row.region)).toEqual(row.cityCount)
    expect(countSearchJobs(matched, { kind: 'unmapped' }, row.region)).toEqual(row.otherCount)
    expect(current.unmappedCount).toBe(1)
  })

  it.each(['Unknown Republic', 'MY'])('does not add a region from a separate unknown/conflicting country %s', country => {
    const job = regionalLegacyJob('partial-unconfirmed', {
      cityIds: ['berlin'], locationLabel: 'Berlin, Germany · Taipei, Taiwan',
      workplaceLocations: { version: 1, locations: [
        { label: 'Berlin', country: 'DE' }, { label: 'Taipei, Taiwan', country },
      ] },
    })
    const index = createSearchIndex(regionalCatalog([job], 0, REGIONAL_ALL_CITIES), REGIONAL_PROFILE)
    expect(selectSearchJobs(index, { ...filters, region: 'asia-pacific' })).toEqual([])
    const europe = selectSearchJobs(index, { ...filters, region: 'europe' })
    expect(europe.map(entry => entry.job.id)).toEqual(['greenhouse-regional-cedar-partial-unconfirmed'])
    expect(countSearchJobs(europe, { kind: 'cities' }, 'europe')).toEqual({ jobs: 1, companies: 1, cities: 1 })
    expect(countSearchJobs(europe, { kind: 'unmapped' }, 'europe')).toEqual({ jobs: 0, companies: 0, cities: 0 })
  })

  it('offers the actual European other-location result and a query-only recovery without changing global counts', () => {
    const prior = regionalCatalog([regionalPartialCatalog().jobs[0]], 1, REGIONAL_ALL_CITIES)
    const index = createSearchIndex(prior, REGIONAL_PROFILE)
    const europe: Filters = { ...filters, region: 'europe' }
    expect(analyzeSearchRecovery(index, europe, { kind: 'cities' })).toEqual({
      available: 1, profileExcluded: 0,
      suggestions: [{ id: '[["region","all"]]', changes: { region: 'all' }, count: { jobs: 1, companies: 1, cities: 1 } }],
      alternatives: [{ scope: { kind: 'unmapped' }, count: { jobs: 1, companies: 1, cities: 0 } }],
    })
    expect(analyzeSearchRecovery(index, europe, { kind: 'unmapped' })).toBeNull()
    expect(analyzeSearchRecovery(index, { ...europe, query: 'PRIVATE_REGIONAL70_MISSING' }, { kind: 'unmapped' })).toEqual({
      available: 1, profileExcluded: 0,
      suggestions: [{ id: '[["query",""]]', changes: { query: '' }, count: { jobs: 1, companies: 1, cities: 0 } }],
      alternatives: [],
    })
    expect(analyzeSearchRecovery(index, filters, { kind: 'unmapped' })).toEqual({
      available: 0, profileExcluded: 0, suggestions: [],
      alternatives: [{ scope: { kind: 'cities' }, count: { jobs: 1, companies: 1, cities: 1 } }],
    })
    expect(prior.unmappedCount).toBe(1)
    expect(upgradeCatalog(prior).unmappedCount).toBe(0)
    expect(prior.jobs[0].cityIds).toEqual([])
  })
})

describe('partial workplaces through the real catalog worker', () => {
  const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).buffer
  async function project(model: CatalogWorkerModel, revision: number, region: Filters['region'], extra: Partial<CatalogViewInput> = {}) {
    const result = await model.handle({
      kind: 'project', revision, input: {
        profile: REGIONAL_PROFILE, filters: { ...filters, region },
        scope: { kind: 'unmapped' }, recover: true, collecting: false,
        now: Date.parse('2026-09-27T06:05:10.000Z'), ...extra,
      },
    })
    if (result.kind !== 'projected') throw new Error('Expected the actual worker projection')
    return result.value
  }

  it('keeps region-specific other lists and global counts consistent across a same-ID workplace update', async () => {
    const initial = regionalPartialCatalog()
    const model = new CatalogWorkerModel()
    await model.handle({ kind: 'decode', stream: 1, initial: true, status: 200, body: bytes(initial) })
    const world = await project(model, 1, 'all')
    expect(world.unmappedIds).toEqual([countryId])
    expect(world.catalog.unmappedCount).toBe(1)
    expect(world.cities.map(city => city.id).sort()).toEqual(['berlin', 'kuala-lumpur', 'taipei'])
    const europe = await project(model, 1, 'europe')
    expect([...europe.unmappedIds].sort()).toEqual([balticId, countryId])
    expect(europe.remoteIds).toEqual([remoteId])
    expect(europe.cities.map(city => city.id)).toEqual(['berlin'])
    expect(europe.recovery).toBeNull()
    expect(europe.catalog.unmappedCount).toBe(1)
    const apac = await project(model, 1, 'asia-pacific')
    expect(apac.unmappedIds).toEqual([])
    expect(apac.remoteIds).toEqual([])
    expect(apac.recovery?.alternatives).toEqual([{ scope: { kind: 'cities' }, count: { jobs: 2, companies: 1, cities: 2 } }])
    expect(apac.cities.map(city => city.id).sort()).toEqual(['kuala-lumpur', 'taipei'])
    await model.handle({ kind: 'acknowledge', revision: 1 })

    const changed = regionalPartialCatalog()
    changed.jobs[0].locationLabel = 'Dubai, United Arab Emirates · Petaling Jaya, Malaysia'
    changed.jobs[0].workplaceLocations = { version: 1, locations: [
      { label: 'Dubai', country: 'AE' }, { label: 'Petaling Jaya', country: 'MY' },
    ] }
    changed.fetchedAt = changed.checkedAt = '2026-09-27T06:05:00.000Z'
    changed.boards[0].checkedAt = changed.boards[0].lastSuccessAt = '2026-09-27T06:05:00.000Z'
    for (const job of changed.jobs) job.fetchedAt = '2026-09-27T06:05:00.000Z'
    await model.handle({ kind: 'decode', stream: 2, initial: true, status: 200, body: bytes(changed) })
    const after = await project(model, 2, 'europe')
    expect(after.unmappedIds).toEqual([countryId])
    expect([...after.matchIds].sort()).toEqual([countryId, relayId, remoteId])
    expect(after.catalog.unmappedCount).toBe(1)
    const middleEast = await project(model, 2, 'middle-east', { scope: { kind: 'cities' } })
    expect(middleEast.matchIds).toEqual([balticId])
    expect(middleEast.cities.map(city => city.id)).toEqual(['dubai'])
    expect(middleEast.unmappedIds).toEqual([])
    expect(middleEast.catalog.unmappedCount).toBe(1)
    const retained = await project(model, 1, 'europe')
    expect([...retained.unmappedIds].sort()).toEqual([balticId, countryId])
    expect(retained.catalog.fetchedAt).toBe('2026-09-27T06:00:00.000Z')
    expect(initial.jobs[0].locationLabel).toBe('Tallinn, Estonia · Petaling Jaya, Malaysia')
  })

  it('returns a real query-only recovery count for a regional partial workplace', async () => {
    const initial = regionalCatalog([regionalPartialCatalog().jobs[0]], 1, REGIONAL_ALL_CITIES)
    const model = new CatalogWorkerModel()
    await model.handle({ kind: 'decode', stream: 1, initial: true, status: 200, body: bytes(initial) })
    const missing = await project(model, 1, 'europe', {
      filters: { ...filters, region: 'europe', query: 'PRIVATE_REGIONAL70_MISSING' },
    })
    expect(missing.unmappedIds).toEqual([])
    expect(missing.recovery?.suggestions).toEqual([
      { id: '[["query",""]]', changes: { query: '' }, count: { jobs: 1, companies: 1, cities: 0 } },
    ])
    const recovered = await project(model, 1, 'europe')
    expect(recovered.unmappedIds).toEqual([balticId])
    expect(recovered.cities).toEqual([])
    expect(recovered.recovery).toBeNull()
    expect(recovered.catalog.unmappedCount).toBe(0)
  })
})
