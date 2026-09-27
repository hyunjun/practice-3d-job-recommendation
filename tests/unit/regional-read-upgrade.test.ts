import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BoardSnapshotSchema, parseCachedBoards } from '../../server/board-cache'
import { createCatalogUpgrader, upgradeCatalog, upgradeJob, upgradeJobCollection } from '../../shared/job-upgrade'
import { SavedJobSchema } from '../../shared/saved-jobs'
import { createSavedBackup, parseSavedImport } from '../../shared/saved-backup'
import { JobSchema } from '../../shared/schemas'
import {
  REGIONAL_ALL_CITIES, REGIONAL_NEW_POSTINGS,
  regionalCatalog, regionalLegacyJob, regionalLegacyJobs, regionalResolutionJob, regionalSavedDubai,
} from '../fixtures/regional-coverage'

const noNetwork = vi.fn(async () => { throw new Error('A regional read upgrade must not recollect jobs.') })
beforeEach(() => { noNetwork.mockClear(); vi.stubGlobal('fetch', noNetwork) })
afterEach(() => { expect(noNetwork).not.toHaveBeenCalled(); vi.unstubAllGlobals() })

describe('new-city read migration from literal earlier snapshots', () => {
  it.each(REGIONAL_NEW_POSTINGS)('connects an earlier empty cityIds for $id without renewing any source fact', ({ id, title, label, expected }) => {
    const prior = regionalLegacyJob(id, { title, locationLabel: label })
    const before = structuredClone(prior)
    const current = upgradeJob(prior)
    expect(current.cityIds).toEqual(expected)
    expect(current.cityCoverageVersion).toBe(1)
    expect(current).toMatchObject({
      title, locationLabel: label, description: 'Fictional backend engineering vacancy.\nRequirements: experience with TypeScript.',
      fetchedAt: '2026-09-27T06:00:00.000Z', updatedAt: '2026-09-26T18:30:00.000Z',
      source: 'greenhouse', companyId: 'regional-cedar',
    })
    expect(current.id).toBe(`greenhouse-regional-cedar-${id}`)
    expect(current.url).toBe(`https://example.test/regional/${id}`)
    expect(prior).toEqual(before)
    expect(upgradeJob(current)).toBe(current)
  })

  it('adds only newly supported cities while retaining existing assignments and their input order', () => {
    const prior = regionalLegacyJob('multi', {
      cityIds: ['new-york', 'london'],
      locationLabel: 'New York, US · London, United Kingdom · Dubai, UAE · Taipei, Taiwan',
    })
    const current = upgradeJob(prior)
    expect([...current.cityIds].sort()).toEqual(['dubai', 'london', 'new-york', 'taipei'])
    expect(prior.cityIds).toEqual(['new-york', 'london'])
    expect(current.cityIds.filter(id => id === 'new-york' || id === 'london')).toEqual(['new-york', 'london'])
    expect(upgradeJob(regionalLegacyJob('old-label-only', { locationLabel: 'London, United Kingdom' })).cityIds).toEqual([])
    expect(upgradeJob(regionalLegacyJob('old-assignment', {
      cityIds: ['london'], locationLabel: 'Tokyo, Japan',
    })).cityIds).toEqual(['london'])
  })

  it.each(['Taiwan', 'New Zealand', 'UAE', 'United Arab Emirates'])('country-only %s stays without a map assignment', locationLabel => {
    const current = upgradeJob(regionalLegacyJob('country-only', { locationLabel }))
    expect(current.cityIds).toEqual([])
    expect(current.workMode).toBe('onsite')
    expect(current.remoteCountries).toEqual([])
    expect(current.locationLabel).toBe(locationLabel)
  })

  it.each(['NZ', 'Unknown Republic'])('a retained conflicting/unknown structured country %s blocks a new city', country => {
    const prior = regionalLegacyJob('structured', {
      locationLabel: 'Taipei, Taiwan',
      workplaceLocations: { version: 1, locations: [{ label: 'Taipei, Taiwan', country }] },
    })
    const current = upgradeJob(prior)
    expect(current.cityIds).toEqual([])
    expect(current.workplaceLocations).toEqual({ version: 1, locations: [{ label: 'Taipei, Taiwan', country }] })
  })

  it('does not lose a separate valid source when another city has unknown or contradictory country evidence', () => {
    const prior = regionalLegacyJob('independent-sources', {
      locationLabel: 'Taipei, Taiwan · Dubai, UAE · Wellington, New Zealand',
      workplaceLocations: { version: 1, locations: [
        { label: 'Taipei, Taiwan', country: 'NZ' },
        { label: 'Dubai, UAE', country: 'AE' },
        { label: 'Wellington, New Zealand', country: 'Unknown Republic' },
      ] },
    })
    expect(upgradeJob(prior).cityIds).toEqual(['dubai'])
  })

  it('does not borrow a display label or company context when retained posting sources contain only countries', () => {
    const prior = regionalLegacyJob('country-source', {
      locationLabel: 'Assigned Workshop',
      title: 'Backend Engineer — Taipei Customers',
      description: 'Our headquarters are in Dubai. Applicants may live in Wellington.',
      workplaceLocations: { version: 1, locations: [{ label: 'Assigned Workshop', country: 'TW' }] },
    })
    expect(upgradeJob(prior).cityIds).toEqual([])
  })

  it.each([
    ['Portland, ME, United States; Portland, OR, United States', ['portland']],
    ['Wellington, FL, United States; Wellington, New Zealand', ['wellington']],
    ['Portland, ME, United States', []],
    ['Wellington, Somerset, United Kingdom', []],
  ])('keeps the same namesake protections when reading %s', (locationLabel, expected) => {
    expect(upgradeJob(regionalLegacyJob('namesake', { locationLabel: locationLabel as string })).cityIds).toEqual(expected)
  })

  it.each(['conflict', 'relocation'] as const)('preserves an existing %s decision and its original evidence', status => {
    const prior = regionalResolutionJob(status)
    const before = structuredClone(prior)
    const current = upgradeJob(prior)
    expect(current.cityIds).toEqual(status === 'conflict' ? [] : ['sydney'])
    expect(current.locationResolution).toEqual(before.locationResolution)
    expect(current.workplaceLocations).toEqual({
      version: 1, locations: [{ label: 'London, United Kingdom · Dubai, United Arab Emirates' }],
    })
    expect(current.locationLabel).toBe(status === 'conflict' ? 'London, United Kingdom · Dubai, United Arab Emirates' : 'Sydney')
    expect(prior).toEqual(before)
  })

  it('is idempotent, preserves subtype fields and leaves historical sample records untouched', () => {
    const prior = { ...regionalLegacyJob(), fixtureMarker: 'retained-regional70' }
    const current = upgradeJob(prior)
    expect(current).toMatchObject({ cityIds: ['dubai'], cityCoverageVersion: 1, fixtureMarker: 'retained-regional70' })
    expect(upgradeJob(current)).toBe(current)
    const sample = { ...prior, source: 'sample' as const }
    expect(upgradeJob(sample)).toBe(sample)
    expect(sample.cityIds).toEqual([])
    expect(sample.cityCoverageVersion).toBeUndefined()
  })

  it('accepts absent and current coverage versions but rejects a fabricated unsupported version', () => {
    expect(JobSchema.safeParse(regionalLegacyJob()).success).toBe(true)
    expect(JobSchema.safeParse({ ...regionalLegacyJob(), cityCoverageVersion: 1 }).success).toBe(true)
    expect(JobSchema.safeParse({ ...regionalLegacyJob(), cityCoverageVersion: 99 }).success).toBe(false)
  })
})

describe('collection deltas, counts and cache provenance', () => {
  function previousJobs() {
    return [
      regionalLegacyJob('taipei', { locationLabel: 'Taipei, Taiwan' }),
      regionalLegacyJob('taiwan-country', { locationLabel: 'Taiwan' }),
    ]
  }

  it('reduces one newly mapped record while preserving three count-only omissions', () => {
    const prior = { jobs: previousJobs(), unmappedCount: 5, fetchedAt: '2026-09-27T06:00:00.000Z' }
    const current = upgradeJobCollection(prior)
    expect(current.jobs.map(job => ({ id: job.id, cities: job.cityIds }))).toEqual([
      { id: 'greenhouse-regional-cedar-taipei', cities: ['taipei'] },
      { id: 'greenhouse-regional-cedar-taiwan-country', cities: [] },
    ])
    expect(current.unmappedCount).toBe(4)
    expect(current.fetchedAt).toBe('2026-09-27T06:00:00.000Z')
    expect(upgradeJobCollection(current).unmappedCount).toBe(4)
    expect(upgradeJobCollection(prior).unmappedCount).toBe(4)
    expect(prior.unmappedCount).toBe(5)
    expect(prior.jobs.map(job => job.cityIds)).toEqual([[], []])
    expect(upgradeJobCollection({ ...prior, unmappedCount: null }).unmappedCount).toBeNull()
  })

  it('combines a new mapping with a newly discovered conflict without dropping omitted history', () => {
    const prior = {
      jobs: [...previousJobs(), regionalLegacyJob('new-conflict', {
        cityIds: ['london'], locationLabel: 'London', description: 'This role is based in Sydney.',
      })],
      unmappedCount: 5,
    }
    const current = upgradeJobCollection(prior)
    expect(current.jobs.map(job => job.cityIds)).toEqual([['taipei'], [], []])
    expect(current.jobs[2].locationResolution?.status).toBe('conflict')
    expect(current.unmappedCount).toBe(5)
    expect(upgradeJobCollection(current).unmappedCount).toBe(5)
  })

  it('uses the same literal new-city results for direct and memoized catalog reads', () => {
    const prior = regionalCatalog(regionalLegacyJobs(), 13)
    const read = createCatalogUpgrader()
    for (const current of [upgradeCatalog(prior), read(prior), read(prior)]) {
      expect(current.jobs.map(job => job.cityIds)).toEqual([
        ['taipei'], ['hsinchu'], ['hong-kong'], ['bangkok'], ['kuala-lumpur'], ['manila'],
        ['auckland'], ['wellington'], ['christchurch'], ['dubai'], ['atlanta'], ['los-angeles'], ['portland'],
      ])
      expect(current.unmappedCount).toBe(0)
      expect(current.jobs).toHaveLength(13)
      expect(current.fetchedAt).toBe('2026-09-27T06:00:00.000Z')
      expect(current.boards[0]).toMatchObject({ total: 13, included: 13, lastSuccessAt: '2026-09-27T06:00:00.000Z' })
    }
    const revised = regionalCatalog([regionalLegacyJob('dubai', { locationLabel: 'Taipei, Taiwan' })], 1)
    expect(read(revised).jobs[0]).toMatchObject({ id: 'greenhouse-regional-cedar-dubai', cityIds: ['taipei'] })
    expect(prior.unmappedCount).toBe(13)
  })

  it('validates earlier counts before migration and preserves full cache/listing clocks and IDs', () => {
    const snapshot = {
      fetchedAt: '2026-09-27T06:00:00.000Z', jobs: previousJobs(), total: 5, unmappedCount: 5,
      publishedIds: [
        'greenhouse-regional-cedar-taipei', 'greenhouse-regional-cedar-taiwan-country',
        'greenhouse-regional-cedar-omitted-1', 'greenhouse-regional-cedar-omitted-2', 'greenhouse-regional-cedar-omitted-3',
      ],
      unpublishedIds: ['greenhouse-regional-cedar-inactive'],
      verifiedActiveIds: ['greenhouse-regional-cedar-taipei'],
      observationMethod: 'observations-1.occupation-6.roles-1.qualifications-1.remote-2.employment-1.purpose-1',
    }
    const original = structuredClone(snapshot)
    const board = {
      companyId: 'regional-cedar', provider: 'greenhouse', board: 'RegionalCedar70',
      checkedAt: '2026-09-27T06:00:00.000Z', failures: 0, retryAt: null, snapshot,
    }
    const result = parseCachedBoards({ version: 5, boards: [board] })
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({
      checkedAt: '2026-09-27T06:00:00.000Z', failures: 0, retryAt: null,
      snapshot: { total: 5, unmappedCount: 4, fetchedAt: '2026-09-27T06:00:00.000Z' },
    })
    expect(result[0].snapshot?.jobs[0]).toMatchObject({
      id: 'greenhouse-regional-cedar-taipei', url: 'https://example.test/regional/taipei',
      locationLabel: 'Taipei, Taiwan', cityIds: ['taipei'], fetchedAt: '2026-09-27T06:00:00.000Z',
    })
    expect(result[0].snapshot?.publishedIds).toEqual([
      'greenhouse-regional-cedar-taipei', 'greenhouse-regional-cedar-taiwan-country',
      'greenhouse-regional-cedar-omitted-1', 'greenhouse-regional-cedar-omitted-2', 'greenhouse-regional-cedar-omitted-3',
    ])
    expect(result[0].snapshot?.unpublishedIds).toEqual(['greenhouse-regional-cedar-inactive'])
    expect(result[0].snapshot?.verifiedActiveIds).toEqual(['greenhouse-regional-cedar-taipei'])
    expect(result[0].snapshot?.observationMethod).toBe('observations-1.occupation-6.roles-1.qualifications-1.remote-2.employment-1.purpose-1')
    expect(parseCachedBoards({ version: 5, boards: result })[0].snapshot?.unmappedCount).toBe(4)
    expect(snapshot).toEqual(original)
    expect(BoardSnapshotSchema.safeParse({ ...snapshot, unmappedCount: 0 }).success).toBe(false)
    expect(BoardSnapshotSchema.safeParse({
      ...snapshot, publishedIds: ['greenhouse-regional-cedar-other'], total: 1, unmappedCount: 2,
    }).success).toBe(false)
  })

  it('does not reinterpret an existing assignment simply because the catalog adds more city metadata', () => {
    const prior = regionalCatalog([regionalLegacyJob('unchanged', {
      cityIds: ['london'], locationLabel: 'Unassigned Workshop',
    })], 0, REGIONAL_ALL_CITIES)
    expect(upgradeCatalog(prior).jobs[0].cityIds).toEqual(['london'])
  })
})

describe('saved read and backup preserve the private record', () => {
  it('upgrades an older saved Dubai record without changing notes, application status or source data', () => {
    const prior = regionalSavedDubai()
    const before = structuredClone(prior)
    const saved = SavedJobSchema.parse(prior)
    expect(saved).toMatchObject({
      savedAt: '2026-09-26T20:00:00.000Z', status: 'applied',
      note: 'PRIVATE_REGIONAL70 — 두바이 원문과 지원 메모 보존 🌿',
      job: {
        id: 'greenhouse-regional-cedar-dubai', cityIds: ['dubai'], cityCoverageVersion: 1,
        fetchedAt: '2026-09-27T06:00:00.000Z', updatedAt: '2026-09-26T18:30:00.000Z',
        title: 'Backend Engineer — Dubai Ledger', locationLabel: 'Dubai, United Arab Emirates',
        url: 'https://example.test/regional/dubai',
        description: 'Fictional backend engineering vacancy.\nRequirements: experience with TypeScript.',
      },
    })
    expect(SavedJobSchema.parse(saved)).toEqual(saved)
    const restored = parseSavedImport(createSavedBackup([prior], 0, new Date('2026-09-27T06:00:10.000Z')))
    expect(restored.exportedAt).toBe('2026-09-27T06:00:10.000Z')
    expect(restored.invalid).toBe(0)
    expect(restored.groups).toHaveLength(1)
    expect(restored.groups[0].variants).toMatchObject([{
      note: 'PRIVATE_REGIONAL70 — 두바이 원문과 지원 메모 보존 🌿', status: 'applied',
      job: { id: 'greenhouse-regional-cedar-dubai', cityIds: ['dubai'], fetchedAt: '2026-09-27T06:00:00.000Z' },
    }])
    expect(prior).toEqual(before)
  })
})
