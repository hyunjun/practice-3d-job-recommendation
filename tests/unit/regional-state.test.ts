import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSearchIndex, countSearchJobs, selectSearchJobs } from '../../shared/job-search'
import { remoteScope } from '../../shared/job-remote'
import { upgradeJob } from '../../shared/job-upgrade'
import { JobSchema } from '../../shared/schemas'
import { SavedJobSchema } from '../../shared/saved-jobs'
import { CatalogWorkerModel } from '../../src/lib/catalog-worker-model'
import { isPublicCatalog } from '../../src/lib/catalog-validation'
import { loadExploration } from '../../src/lib/storage'
import type { CatalogViewInput } from '../../src/lib/catalog-worker-types'
import type { Filters } from '../../shared/types'
import {
  REGIONAL_COMPANY, REGIONAL_FILTERS, REGIONAL_PROFILE,
  regionalCatalog, regionalLegacyJob,
} from '../fixtures/regional-coverage'

let values: Map<string, string>
const noNetwork = vi.fn(async () => { throw new Error('Regional state tests must not contact a server.') })
beforeEach(() => {
  noNetwork.mockClear()
  vi.stubGlobal('fetch', noNetwork)
  values = new Map()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value) },
  })
})
afterEach(() => { expect(noNetwork).not.toHaveBeenCalled(); vi.unstubAllGlobals() })

describe('remote v3 interpretation without expanding country eligibility', () => {
  for (const version of [undefined, 1, 2] as const) {
    it.each([
      { label: 'Dubai · Remote', country: ['AE'] },
      { label: 'Auckland · Remote', country: ['NZ'] },
      { label: 'Taipei · Remote', country: ['TW'] },
      { label: '香港 · Remote', country: ['HK'] },
      { label: 'Portland, OR · Remote', country: ['US'] },
    ])(`re-reads v${version ?? 'absent'} city-only $label but keeps the map empty`, ({ label, country }) => {
      const prior = regionalLegacyJob('remote-city', {
        workMode: 'remote', cityIds: [], locationLabel: label,
        remoteScopeVersion: version, remoteCountries: [], remoteScopeUnknown: true,
      })
      const current = upgradeJob(prior)
      expect(current).toMatchObject({
        cityIds: [], workMode: 'remote', remoteCountries: country,
        remoteWorldwide: false, remoteScopeUnknown: false, remoteScopeVersion: 3,
        fetchedAt: '2026-09-27T06:00:00.000Z', url: 'https://example.test/regional/remote-city',
      })
      expect(prior.remoteCountries).toEqual([])
      expect(prior.remoteScopeVersion).toBe(version)
      expect(upgradeJob(current)).toBe(current)
    })
  }

  it('treats Middle East only as a region hint, with no implicit AE or16-country eligibility', () => {
    expect(remoteScope('Remote · Middle East')).toMatchObject({
      remoteRegions: ['middle-east'], remoteCountries: [], remoteWorldwide: false,
      remoteScopeUnknown: true, remoteScopeVersion: 3,
    })
    const job = regionalLegacyJob('regional-remote', {
      workMode: 'remote', locationLabel: 'Remote · Middle East', remoteScopeVersion: 2,
      remoteScopeUnknown: true,
    })
    const index = createSearchIndex(regionalCatalog([job], 0), REGIONAL_PROFILE)
    expect(selectSearchJobs(index, { ...REGIONAL_FILTERS, region: 'middle-east' }).map(entry => entry.job.id)).toEqual([])
    expect(selectSearchJobs(index, {
      ...REGIONAL_FILTERS, region: 'middle-east', remoteEligibleOnly: false,
    }).map(entry => entry.job.id)).toEqual(['greenhouse-regional-cedar-regional-remote'])
    expect(selectSearchJobs(index, {
      ...REGIONAL_FILTERS, region: 'asia-pacific', remoteEligibleOnly: false,
    }).map(entry => entry.job.id)).toEqual([])
    for (const label of ['Remote · EMEA', 'Remote · APAC']) {
      expect(remoteScope(label)).toMatchObject({ remoteCountries: [], remoteWorldwide: false, remoteScopeUnknown: true })
    }
  })

  it('keeps a contradictory current-role country statement unresolved when re-reading a newly known city', () => {
    const prior = regionalLegacyJob('restricted-remote', {
      workMode: 'remote', locationLabel: 'Dubai · Remote', remoteScopeVersion: 2,
      remoteScopeUnknown: true,
      description: 'This role is only open to candidates based in the United Kingdom.',
    })
    const current = upgradeJob(prior)
    expect(current).toMatchObject({
      cityIds: [], remoteCountries: [], remoteWorldwide: false, remoteScopeUnknown: true,
      remoteScopeVersion: 3, remoteScopeResolution: { status: 'unconfirmed' },
    })
    expect(current.remoteScopeResolution?.evidence).toEqual([{
      source: 'description', text: 'This role is only open to candidates based in the United Kingdom.',
    }])
  })

  it('retains1/2/3 schema compatibility and upgrades an older saved remote record to3', () => {
    for (const version of [1, 2, 3]) {
      expect(JobSchema.safeParse({
        ...regionalLegacyJob(), workMode: 'remote', remoteScopeVersion: version,
      }).success).toBe(true)
    }
    expect(JobSchema.safeParse({ ...regionalLegacyJob(), remoteScopeVersion: 4 }).success).toBe(false)
    expect(JobSchema.safeParse({
      ...regionalLegacyJob(), remoteRegions: ['americas', 'europe', 'asia-pacific', 'middle-east'],
    }).success).toBe(true)
    const saved = SavedJobSchema.parse({
      job: regionalLegacyJob('remote-saved', {
        locationLabel: 'Dubai · Remote', workMode: 'remote', remoteScopeVersion: 2,
      }),
      company: REGIONAL_COMPANY, savedAt: '2026-09-27T06:00:00.000Z',
      status: 'applied', note: 'PRIVATE_REMOTE70',
    })
    expect(saved).toMatchObject({
      status: 'applied', note: 'PRIVATE_REMOTE70', savedAt: '2026-09-27T06:00:00.000Z',
      job: { cityIds: [], remoteCountries: ['AE'], remoteScopeVersion: 3, fetchedAt: '2026-09-27T06:00:00.000Z' },
    })
  })
})

describe('Middle East city, country-only and remote search scopes', () => {
  function boundaryCatalog() {
    return regionalCatalog([
      regionalLegacyJob(),
      regionalLegacyJob('uae-country', { title: 'Backend Engineer — UAE Country', locationLabel: 'UAE' }),
      regionalLegacyJob('remote-uae', {
        title: 'Backend Engineer — UAE Remote', workMode: 'remote', locationLabel: 'Dubai · Remote',
        remoteScopeVersion: 2, remoteScopeUnknown: true,
      }),
      regionalLegacyJob('taiwan-country', { title: 'Backend Engineer — Taiwan Country', locationLabel: 'Taiwan' }),
      regionalLegacyJob('nz-country', { title: 'Backend Engineer — NZ Country', locationLabel: 'New Zealand' }),
      regionalLegacyJob('unknown-country', {
        title: 'Backend Engineer — Unconfirmed Source',
        workplaceLocations: { version: 1, locations: [{ label: 'Dubai, UAE', country: 'Unknown Republic' }] },
      }),
      regionalLegacyJob('conflicting-country', {
        title: 'Backend Engineer — Conflicting Source', locationLabel: 'Taipei, Taiwan',
        workplaceLocations: { version: 1, locations: [{ label: 'Taipei, Taiwan', country: 'NZ' }] },
      }),
    ], 6)
  }

  it('keeps the three Middle East views disjoint and unrelated countries in APAC', () => {
    const index = createSearchIndex(boundaryCatalog(), REGIONAL_PROFILE)
    const middleEast = selectSearchJobs(index, { ...REGIONAL_FILTERS, region: 'middle-east' })
    expect(middleEast.map(entry => entry.job.id)).toEqual([
      'greenhouse-regional-cedar-dubai', 'greenhouse-regional-cedar-uae-country', 'greenhouse-regional-cedar-remote-uae',
    ])
    expect(countSearchJobs(middleEast, { kind: 'cities' }, 'middle-east')).toEqual({ jobs: 1, companies: 1, cities: 1 })
    expect(countSearchJobs(middleEast, { kind: 'unmapped' }, 'middle-east')).toEqual({ jobs: 1, companies: 1, cities: 0 })
    expect(countSearchJobs(middleEast, { kind: 'remote' }, 'middle-east')).toEqual({ jobs: 1, companies: 1, cities: 0 })
    const apac = selectSearchJobs(index, { ...REGIONAL_FILTERS, region: 'asia-pacific' })
    expect(apac.map(entry => entry.job.id)).toEqual([
      'greenhouse-regional-cedar-taiwan-country', 'greenhouse-regional-cedar-nz-country',
    ])
    expect(countSearchJobs(apac, { kind: 'cities' }, 'asia-pacific')).toEqual({ jobs: 0, companies: 0, cities: 0 })
    expect(countSearchJobs(apac, { kind: 'unmapped' }, 'asia-pacific')).toEqual({ jobs: 2, companies: 1, cities: 0 })
    expect(selectSearchJobs(index, REGIONAL_FILTERS)).toHaveLength(7)
  })

  it.each(['두바이', 'Dubai', '아랍에미리트'])('searches %s while keeping explicit country/role/work-mode conditions', query => {
    const index = createSearchIndex(boundaryCatalog(), REGIONAL_PROFILE)
    const matched = selectSearchJobs(index, {
      ...REGIONAL_FILTERS, region: 'middle-east', query, workMode: 'onsite',
    })
    expect(matched.map(entry => entry.job.id)).toEqual(query === '아랍에미리트'
      ? ['greenhouse-regional-cedar-dubai', 'greenhouse-regional-cedar-uae-country']
      : ['greenhouse-regional-cedar-dubai'])
    expect(selectSearchJobs(index, { ...REGIONAL_FILTERS, region: 'middle-east', query, workMode: 'onsite', visa: 'yes' })).toEqual([])
  })
})

describe('Middle East exploration persistence', () => {
  it.each(['flat', 'globe'] as const)('restores Dubai, query and Middle East in the %s map', mapMode => {
    values.set('orbit.v1.exploration', JSON.stringify({
      source: 'public', filters: { ...REGIONAL_FILTERS, query: 'Ledger', region: 'middle-east' },
      selectedId: 'dubai', panelTab: 'cities', mapMode, light: true, citySort: 'companies',
    }))
    expect(loadExploration(REGIONAL_PROFILE)).toMatchObject({
      source: 'public', filters: { query: 'Ledger', region: 'middle-east', role: 'backend', remoteEligibleOnly: true },
      selectedId: 'dubai', panelTab: 'cities', mapMode, light: true, citySort: 'companies',
    })
  })

  it('drops only the mismatching selected city and independently recovers an invalid filter', () => {
    values.set('orbit.v1.exploration', JSON.stringify({
      source: 'public',
      filters: { ...REGIONAL_FILTERS, query: 'Ledger', region: 'asia-pacific', salaryMin: -1 },
      selectedId: 'dubai', panelTab: 'cities', mapMode: 'flat', light: true, citySort: 'salary',
    }))
    expect(loadExploration(REGIONAL_PROFILE)).toMatchObject({
      filters: { query: 'Ledger', region: 'asia-pacific', salaryMin: 0 },
      selectedId: null, mapMode: 'flat', light: true, citySort: 'salary',
    })
  })
})

describe('new regions through catalog validation and the real worker protocol', () => {
  const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).buffer
  const input = (filters: Partial<Filters> = {}): CatalogViewInput => ({
    profile: REGIONAL_PROFILE, filters: { ...REGIONAL_FILTERS, ...filters },
    scope: { kind: 'cities' }, recover: true, collecting: false, now: Date.parse('2026-09-27T06:05:10.000Z'),
  })
  async function project(model: CatalogWorkerModel, revision: number, filters: Partial<Filters>) {
    const result = await model.handle({ kind: 'project', revision, input: input(filters) })
    if (result.kind !== 'projected') throw new Error('Expected a projected worker response')
    return result.value
  }

  it('accepts the new region and changes same-ID location results without reusing obsolete city interpretation', async () => {
    const initial = regionalCatalog([regionalLegacyJob()], 1)
    expect(isPublicCatalog(initial)).toBe(true)
    const model = new CatalogWorkerModel()
    await model.handle({ kind: 'decode', stream: 1, initial: true, status: 200, body: bytes(initial) })
    const before = await project(model, 1, { region: 'middle-east', query: 'Ledger' })
    expect(before.matchIds).toEqual(['greenhouse-regional-cedar-dubai'])
    expect(before.cities.map(city => ({ id: city.id, matches: city.matchIds }))).toEqual([{
      id: 'dubai', matches: ['greenhouse-regional-cedar-dubai'],
    }])
    expect(before.catalog.unmappedCount).toBe(0)
    expect(before.catalog.fetchedAt).toBe('2026-09-27T06:00:00.000Z')
    await model.handle({ kind: 'acknowledge', revision: 1 })
    const revised = regionalCatalog([regionalLegacyJob('dubai', {
      locationLabel: 'Taipei, Taiwan', fetchedAt: '2026-09-27T06:05:00.000Z',
    })], 1)
    revised.fetchedAt = '2026-09-27T06:05:00.000Z'
    revised.checkedAt = '2026-09-27T06:05:00.000Z'
    revised.boards[0].checkedAt = '2026-09-27T06:05:00.000Z'
    revised.boards[0].lastSuccessAt = '2026-09-27T06:05:00.000Z'
    await model.handle({ kind: 'decode', stream: 2, initial: true, status: 200, body: bytes(revised) })
    const middleEast = await project(model, 2, { region: 'middle-east', query: 'Ledger' })
    expect(middleEast.matchIds).toEqual([])
    expect(middleEast.cities).toEqual([])
    const apac = await project(model, 2, { region: 'asia-pacific', query: 'Ledger' })
    expect(apac.matchIds).toEqual(['greenhouse-regional-cedar-dubai'])
    expect(apac.cities.map(city => ({ id: city.id, matches: city.matchIds }))).toEqual([{
      id: 'taipei', matches: ['greenhouse-regional-cedar-dubai'],
    }])
    expect(apac.catalog.fetchedAt).toBe('2026-09-27T06:05:00.000Z')
    const retained = await project(model, 1, { region: 'middle-east', query: 'Ledger' })
    expect(retained.matchIds).toEqual(['greenhouse-regional-cedar-dubai'])
    expect(retained.cities.map(city => city.id)).toEqual(['dubai'])
    expect(initial.jobs[0]).toMatchObject({ locationLabel: 'Dubai, United Arab Emirates', cityIds: [] })
  })

  it('rejects a fabricated region without erasing the previously accepted response', async () => {
    const valid = regionalCatalog([regionalLegacyJob()], 1)
    const model = new CatalogWorkerModel()
    await model.handle({ kind: 'decode', stream: 1, initial: true, status: 200, body: bytes(valid) })
    await project(model, 1, { region: 'middle-east' })
    await model.handle({ kind: 'acknowledge', revision: 1 })
    const invalid = { ...valid, cities: valid.cities.map(city => ({ ...city, region: 'invented-region' })) }
    expect(isPublicCatalog(invalid)).toBe(false)
    await expect(model.handle({
      kind: 'decode', stream: 2, initial: true, status: 200, body: bytes(invalid),
    })).rejects.toThrow('공고 데이터 형식을 확인하지 못했어요. 다시 조회해 주세요.')
    const retained = await project(model, 1, { region: 'middle-east' })
    expect(retained.matchIds).toEqual(['greenhouse-regional-cedar-dubai'])
    expect(retained.catalog.unmappedCount).toBe(0)
    expect(retained.cities.map(city => city.id)).toEqual(['dubai'])
  })
})
