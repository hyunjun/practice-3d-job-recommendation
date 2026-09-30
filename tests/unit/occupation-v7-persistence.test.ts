import { describe, expect, it, vi } from 'vitest'
import { parseCachedBoards } from '../../server/board-cache'
import type { CachedBoard } from '../../server/board-cache'
import { createObservationStore } from '../../server/catalog-observations'
import type { ObservationCache } from '../../server/catalog-observations'
import { normalizeJob } from '../../server/normalize'
import { observationComparison } from '../../shared/catalog-observations'
import { isTechnicalJob, occupationFacts, upgradeJobOccupation } from '../../shared/job-occupation'
import { jobRoleLabel, jobRoles } from '../../shared/job-roles'
import { observeSavedPosting } from '../../shared/posting-status'
import type { PostingStatusIndex } from '../../shared/posting-status'
import { createSavedBackup, parseSavedImport } from '../../shared/saved-backup'
import { decodeSavedJobs } from '../../shared/saved-jobs'
import { JobSchema } from '../../shared/schemas'
import type { Company } from '../../shared/types'
import {
  LEGACY_V6_CASES, OTHER_LABEL, UNCONFIRMED_LABEL, V6_METHOD, V7_ASHBY_COMPANY, V7_BODIES, V7_COMPANY, V7_METHOD,
  V7_SAVED_AT, V7_TIME, V7_UPDATED_AT, currentV7Job, htmlBody, legacyV6Case, legacyV6Job, legacyV6Saved,
} from '../fixtures/occupation-v7'
import type { PublicJob } from '../fixtures/occupation-v7'

// Stage 71 contract docs/design/occupation-v7.md revision 4: persistence, migration,
// saved records and observation history. Historical v6 inputs are hand-coded; every
// expected v7 outcome, label, count and method string is a literal from the contract.

describe('literal v6 records migrate to v7 without rewriting the stored source', () => {
  it.each(LEGACY_V6_CASES)('$key ($provenance) becomes $category', fixture => {
    const original = legacyV6Job(fixture.key)
    const untouched = structuredClone(original)
    expect(JobSchema.safeParse(original).success).toBe(true)
    const current = upgradeJobOccupation(original)
    expect(current.occupation).toMatchObject({ version: 7, category: fixture.category, departments: fixture.departments })
    expect(isTechnicalJob(current)).toBe(fixture.explorable)
    expect(jobRoleLabel(current)).toBe(fixture.label)
    expect(jobRoles(current)).toEqual([])
    expect(current.description).toBe(fixture.description)
    expect({ ...current, occupation: original.occupation }).toEqual(original)
    expect(original).toEqual(untouched)
    expect(upgradeJobOccupation(current)).toBe(current)
    expect(JobSchema.safeParse(current).success).toBe(true)
  })

  it('keeps historical description evidence beyond the stored body available to the hand-authored mechanism control', () => {
    const current = upgradeJobOccupation(legacyV6Job('failure-analysis-preserved-duties'))
    expect(current.occupation).toMatchObject({ version: 7, category: 'other' })
    expect(current.occupation?.evidence).toContainEqual(expect.objectContaining({
      source: 'description', text: expect.stringContaining('Inspect failed boards, cross-section solder joints'),
    }))
    expect(current.description).toBe('')
  })

  it('agrees between fresh normalization and migration for equivalent available evidence, without reconstructing discarded text', () => {
    const physical = { title: 'Failure Analysis Engineer', departments: ['Hardware'], description: V7_BODIES.failedBoards }
    expect(occupationFacts(physical)).toMatchObject({ version: 7, category: 'other' })
    expect(normalizeJob({
      id: 640001, title: physical.title, absolute_url: 'https://example.org/quill-hardware/640001',
      location: { name: 'London, UK' }, departments: [{ name: 'Hardware' }], content: htmlBody(physical.description),
    }, V7_COMPANY.id, V7_TIME)).toBeNull()
    expect(upgradeJobOccupation(legacyV6Job('failure-analysis-empty', { description: V7_BODIES.failedBoards })).occupation)
      .toMatchObject({ version: 7, category: 'other' })
    expect(upgradeJobOccupation(legacyV6Job('failure-analysis-empty')).occupation).toMatchObject({ version: 7, category: 'unconfirmed' })
    expect(upgradeJobOccupation(legacyV6Job('failure-analysis-preserved-duties')).occupation).toMatchObject({ version: 7, category: 'other' })
  })

  it('accepts the migrated v7 assessment and rejects the adjacent unsupported versions', () => {
    const current = upgradeJobOccupation(legacyV6Job('supplier-quality'))
    expect(JobSchema.safeParse(current).success).toBe(true)
    for (const version of [0, 8]) {
      expect(JobSchema.safeParse({ ...current, occupation: { ...current.occupation, version } }).success, `v${version}`).toBe(false)
    }
  })
})

describe('cache envelope version 5 still reads v6 records', () => {
  it('drops newly excluded jobs, adjusts only retained unmapped exclusions and keeps IDs, totals, clocks and the old method', () => {
    const excludedUnmapped = legacyV6Job('supplier-quality', { cityIds: [], locationLabel: 'Fictional unlocated workshop' })
    const excluded = legacyV6Job('talent-specialist')
    const unconfirmed = legacyV6Job('failure-analysis-empty')
    const retained = legacyV6Job('firmware-retained')
    const publishedIds = [
      excludedUnmapped.id, excluded.id, unconfirmed.id, retained.id,
      'greenhouse-quill-hardware-omitted-1', 'greenhouse-quill-hardware-omitted-2',
    ]
    const entry = {
      companyId: 'quill-hardware', provider: 'greenhouse', board: 'quill-hardware',
      checkedAt: '2026-10-01T09:03:00.000Z', retryAt: '2026-10-01T09:08:00.000Z', failures: 2, error: 'Fictional HTTP 503',
      snapshot: {
        fetchedAt: V7_TIME, total: 6, unmappedCount: 2, observationMethod: V6_METHOD,
        jobs: [excludedUnmapped, excluded, unconfirmed, retained], publishedIds,
      },
    }
    const untouched = structuredClone(entry)
    const loaded = parseCachedBoards({ version: 5, boards: [entry] })
    expect(loaded).toHaveLength(1)
    expect(loaded[0]).toMatchObject({
      checkedAt: '2026-10-01T09:03:00.000Z', retryAt: '2026-10-01T09:08:00.000Z', failures: 2, error: 'Fictional HTTP 503',
      snapshot: { fetchedAt: '2026-10-01T09:00:00.000Z', total: 6, unmappedCount: 1, observationMethod: V6_METHOD, publishedIds },
    })
    expect(loaded[0].snapshot?.jobs.map(job => job.id)).toEqual(['greenhouse-quill-hardware-firmware-retained'])
    expect(loaded[0].snapshot?.jobs[0]).toMatchObject({
      title: 'Senior Firmware Engineer', description: V7_BODIES.firmwareDuties,
      fetchedAt: '2026-10-01T09:00:00.000Z', updatedAt: V7_UPDATED_AT, url: 'https://example.org/quill-hardware/firmware-retained',
      occupation: { version: 7, category: 'engineering', departments: ['Hardware', 'Hardware Platform'] },
    })
    expect(parseCachedBoards({ version: 5, boards: loaded })).toEqual(loaded)
    expect(entry).toEqual(untouched)
    expect(parseCachedBoards({ version: 5, boards: [{ ...entry, snapshot: { ...entry.snapshot, unmappedCount: null } }] })[0].snapshot?.unmappedCount).toBeNull()
  })
})

describe('saved v6 records keep the private record and show the literal v7 label', () => {
  const checkedAt = '2026-10-01T09:03:00.000Z'
  function index(publishedIds: string[]): PostingStatusIndex {
    return {
      version: 1, checkedAt, refreshAfter: '2026-10-01T09:04:00.000Z',
      boards: [{
        companyId: 'quill-hardware', provider: 'greenhouse', board: 'quill-hardware',
        status: 'ok', checkedAt, lastSuccessAt: checkedAt, retryAt: null,
        listing: { validUntil: '2026-10-01T09:33:00.000Z', publishedIds, jobs: [] },
      }],
    }
  }

  it.each([
    { key: 'supplier-quality', label: OTHER_LABEL },
    { key: 'failure-analysis-empty', label: UNCONFIRMED_LABEL },
  ])('$key stays saved with note, status, savedAt and source metadata and displays $label', ({ key, label }) => {
    const fixture = legacyV6Case(key)
    const note = `Fictional private note for ${key}; keep my original record.`
    const original = legacyV6Saved(key, note)
    const bytes = JSON.stringify(original)
    const decoded = decodeSavedJobs(JSON.stringify([original]))
    expect(decoded.omitted).toBe(0)
    expect(decoded.records).toHaveLength(1)
    const saved = decoded.records[0]
    expect(saved).toMatchObject({
      savedAt: V7_SAVED_AT, status: 'applied', note,
      company: { id: 'quill-hardware', name: 'Quill Hardware Studio', board: 'quill-hardware' },
      job: {
        id: `greenhouse-quill-hardware-${key}`, source: 'greenhouse', title: fixture.title, description: fixture.description,
        url: `https://example.org/quill-hardware/${key}`, fetchedAt: V7_TIME, updatedAt: V7_UPDATED_AT,
        occupation: { version: 7, category: fixture.category, departments: fixture.departments },
      },
    })
    expect(isTechnicalJob(saved.job)).toBe(false)
    expect(jobRoleLabel(saved.job)).toBe(label)
    expect(jobRoles(saved.job)).toEqual([])
    expect(parseSavedImport(createSavedBackup([saved])).groups[0].variants[0]).toEqual(saved)
    // Importing a backup that still carries the v6 assessment yields the same v7 record.
    const legacyBackup = JSON.stringify({ format: 'orbit-saved-backup', version: 1, exportedAt: checkedAt, includesUnsavedChanges: false, records: [original] })
    expect(parseSavedImport(legacyBackup).groups[0].variants[0]).toEqual(saved)
    expect(observeSavedPosting(saved, index([saved.job.id]), undefined, Date.parse('2026-10-01T09:03:10.000Z'))).toEqual({
      state: 'listed', checkedAt, message: '게시판에는 있지만 현재 탐색 범위 밖의 공고라 내용은 원문에서 확인해야 합니다.',
    })
    expect(observeSavedPosting(saved, index([]), undefined, Date.parse('2026-10-01T09:03:10.000Z')).state).toBe('missing')
    expect(JSON.stringify(original)).toBe(bytes)
    expect(original.job.occupation).toMatchObject({ version: 6, category: 'engineering' })
  })
})

describe('observation comparability follows method markers, cohort and completeness', () => {
  function memory() {
    let value: unknown = { version: 1, series: [] }
    return {
      load: vi.fn(async () => structuredClone(value)),
      save: vi.fn<ObservationCache['save']>(async next => { value = structuredClone(next) }),
      value: () => structuredClone(value) as { series: { method: string }[] },
    }
  }
  // Cache snapshots hold public-provider records only; the fixture builders guarantee that source.
  function board(company: Company, fetchedAt: string, jobs: PublicJob[], method?: string): CachedBoard {
    return {
      companyId: company.id, provider: company.provider!, board: company.board!,
      checkedAt: fetchedAt, failures: 0, retryAt: null,
      snapshot: {
        fetchedAt, jobs, total: jobs.length, publishedIds: jobs.map(job => job.id), unmappedCount: 0,
        ...(method ? { observationMethod: method } : {}),
      },
    }
  }
  const firmware = (company: Company, at: string) => currentV7Job('firmware', 'Senior Firmware Engineer', ['Hardware', 'Hardware Platform'], V7_BODIES.firmwareDuties, company, at)
  const productionTest = (company: Company, at: string) => currentV7Job('production-test', 'Senior Software Engineer - Production Test Systems', ['Hardware', 'Production'], V7_BODIES.productionTestSoftware, company, at)
  const ios = (company: Company, at: string) => currentV7Job('ios', 'Senior iOS Engineer', ['Hardware', 'Companion App'], V7_BODIES.softwareDuties, company, at)

  it('reclassifying six v6 rows as two v7 rows is not a decline and never renews the old marker', async () => {
    const input = board(V7_COMPANY, V7_TIME, [
      legacyV6Job('talent-specialist'), legacyV6Job('supplier-quality'), legacyV6Job('electronics'),
      legacyV6Job('failure-analysis-empty'), legacyV6Job('firmware-retained'), legacyV6Job('production-test-retained'),
    ], V6_METHOD)
    const loaded = parseCachedBoards({ version: 5, boards: [input] })
    expect(loaded[0].snapshot?.jobs.map(job => job.title)).toEqual(['Senior Firmware Engineer', 'Senior Software Engineer - Production Test Systems'])
    expect(loaded[0].snapshot).toMatchObject({ total: 6, unmappedCount: 0, observationMethod: V6_METHOD })
    const cache = memory()
    const clock = { value: Date.parse('2026-10-01T09:05:00.000Z') }
    const store = createObservationStore({ companies: [V7_COMPANY], cache, now: () => clock.value, onError: vi.fn() })
    expect(store.method).toBe(V7_METHOD)
    await store.record(loaded, 'cache')
    const history = await store.read()
    expect(history.method).toBe(V7_METHOD)
    expect(history.days).toHaveLength(1)
    expect(history.days[0]).toMatchObject({
      day: '2026-10-01',
      complete: {
        origin: 'cache', comparable: false, observedAt: '2026-10-01T09:00:00.000Z', recordedAt: '2026-10-01T09:05:00.000Z',
        stats: { published: 6, technical: 2, openings: 2, talentPools: 0 },
      },
    })
    expect(observationComparison(history.days)).toBeNull()
    clock.value = Date.parse('2026-10-02T09:00:00.000Z')
    const collected = '2026-10-02T09:00:00.000Z'
    await store.record([board(V7_COMPANY, collected, [firmware(V7_COMPANY, collected), productionTest(V7_COMPANY, collected)], V7_METHOD)], 'collection')
    const next = await store.read()
    expect(next.days.map(day => [day.day, day.complete?.comparable, day.complete?.stats.technical])).toEqual([
      ['2026-10-01', false, 2], ['2026-10-02', true, 2],
    ])
    expect(observationComparison(next.days)).toBeNull()
    expect(input.snapshot?.observationMethod).toBe(V6_METHOD)
    expect(input.snapshot?.jobs).toHaveLength(6)
  })

  it('keeps a matching-method complete cache comparable at its original date, adds no day on reread and shows a delta only from a second collection', async () => {
    const dayOne = '2026-10-03T09:00:00.000Z'
    const dayTwo = '2026-10-04T09:00:00.000Z'
    const entries = [board(V7_COMPANY, dayOne, [firmware(V7_COMPANY, dayOne), productionTest(V7_COMPANY, dayOne)], V7_METHOD)]
    const cache = memory()
    const clock = { value: Date.parse(dayOne) + 10_000 }
    const first = createObservationStore({ companies: [V7_COMPANY], cache, now: () => clock.value, onError: vi.fn() })
    await first.record(entries, 'collection')
    const before = await first.read()
    expect(before.days).toHaveLength(1)
    expect(before.days[0].complete).toMatchObject({ origin: 'collection', comparable: true, observedAt: dayOne, stats: { published: 2, technical: 2, openings: 2 } })
    clock.value = Date.parse(dayTwo)
    const restarted = createObservationStore({ companies: [V7_COMPANY], cache, now: () => clock.value, onError: vi.fn() })
    await restarted.record(entries, 'cache')
    expect(await restarted.read()).toEqual(before)
    expect(cache.save).toHaveBeenCalledTimes(1)
    await restarted.record([board(V7_COMPANY, dayTwo, [firmware(V7_COMPANY, dayTwo), productionTest(V7_COMPANY, dayTwo), ios(V7_COMPANY, dayTwo)], V7_METHOD)], 'collection')
    const history = await restarted.read()
    expect(history.days.map(day => [day.day, day.complete?.comparable])).toEqual([['2026-10-03', true], ['2026-10-04', true]])
    expect(observationComparison(history.days)).toEqual({ previousDay: '2026-10-03', currentDay: '2026-10-04', previous: 2, current: 3, difference: 1 })
    expect(cache.save).toHaveBeenCalledTimes(2)
  })

  it('accepts a complete current-method cache into an empty history as origin cache, comparable true, at its original observation date', async () => {
    const observed = '2026-10-10T09:00:00.000Z'
    const cache = memory()
    // The process reads the cache the next morning; the observation keeps the source date.
    const clock = { value: Date.parse('2026-10-11T07:30:00.000Z') }
    const store = createObservationStore({ companies: [V7_COMPANY], cache, now: () => clock.value, onError: vi.fn() })
    expect(store.method).toBe(V7_METHOD)
    const loaded = parseCachedBoards({ version: 5, boards: [
      board(V7_COMPANY, observed, [firmware(V7_COMPANY, observed), productionTest(V7_COMPANY, observed)], V7_METHOD),
    ] })
    expect(loaded[0].snapshot?.observationMethod).toBe(V7_METHOD)
    await store.record(loaded, 'cache')
    const history = await store.read()
    expect(history.method).toBe(V7_METHOD)
    expect(history.days.map(day => day.day)).toEqual(['2026-10-10'])
    expect(history.days[0].latest).toMatchObject({ origin: 'cache', observedAt: observed, recordedAt: '2026-10-11T07:30:00.000Z' })
    expect(history.days[0].complete).toMatchObject({
      origin: 'cache', comparable: true, observedAt: observed, recordedAt: '2026-10-11T07:30:00.000Z',
      boards: [{ companyId: 'quill-hardware', status: 'complete', checkedAt: observed, lastSuccessAt: observed }],
      stats: { published: 2, technical: 2, openings: 2, talentPools: 0 },
    })
    expect(history.otherSeries).toEqual([])
    expect(cache.save).toHaveBeenCalledTimes(1)
    expect(observationComparison(history.days)).toBeNull()
    // Rereading the same cache later adds no day and renews no clock or marker.
    clock.value = Date.parse('2026-10-11T08:00:00.000Z')
    await store.record(loaded, 'cache')
    expect(await store.read()).toEqual(history)
    expect(cache.save).toHaveBeenCalledTimes(1)
    expect(loaded[0].snapshot?.observationMethod).toBe(V7_METHOD)
    expect(loaded[0].snapshot?.fetchedAt).toBe(observed)
    // A later same-method collection compares against the cache-origin baseline.
    clock.value = Date.parse('2026-10-11T09:00:10.000Z')
    const collected = '2026-10-11T09:00:00.000Z'
    await store.record([board(V7_COMPANY, collected, [firmware(V7_COMPANY, collected), productionTest(V7_COMPANY, collected), ios(V7_COMPANY, collected)], V7_METHOD)], 'collection')
    const after = await store.read()
    expect(after.days.map(day => [day.day, day.complete?.origin, day.complete?.comparable])).toEqual([
      ['2026-10-10', 'cache', true], ['2026-10-11', 'collection', true],
    ])
    expect(observationComparison(after.days)).toEqual({ previousDay: '2026-10-10', currentDay: '2026-10-11', previous: 2, current: 3, difference: 1 })
  })

  it.each([
    { name: 'an old marker on one board', marker: V6_METHOD },
    { name: 'a missing marker on one board', marker: undefined },
  ])('yields comparable false for $name in the cohort even after its jobs read as v7', async ({ marker }) => {
    const at = '2026-10-05T09:00:00.000Z'
    const loaded = parseCachedBoards({ version: 5, boards: [
      board(V7_COMPANY, at, [firmware(V7_COMPANY, at)], V7_METHOD),
      board(V7_ASHBY_COMPANY, at, [legacyV6Job('firmware-retained', { fetchedAt: at }, V7_ASHBY_COMPANY)], marker),
    ] })
    expect(loaded).toHaveLength(2)
    expect(loaded[1].snapshot?.jobs[0].occupation).toMatchObject({ version: 7, category: 'engineering' })
    expect(loaded[1].snapshot?.observationMethod).toBe(marker)
    const cache = memory()
    const store = createObservationStore({ companies: [V7_COMPANY, V7_ASHBY_COMPANY], cache, now: () => Date.parse(at) + 10_000, onError: vi.fn() })
    await store.record(loaded, 'cache')
    const history = await store.read()
    expect(history.days).toHaveLength(1)
    expect(history.days[0].complete).toMatchObject({ comparable: false, stats: { published: 2, technical: 2, openings: 2 } })
    expect(observationComparison(history.days)).toBeNull()
  })

  it('keeps a failed or partial attempt out of complete observations and preserves the earlier complete day', async () => {
    const dayOne = '2026-10-06T09:00:00.000Z'
    const dayTwo = '2026-10-07T09:00:00.000Z'
    const cache = memory()
    const clock = { value: Date.parse(dayOne) + 10_000 }
    const store = createObservationStore({ companies: [V7_COMPANY, V7_ASHBY_COMPANY], cache, now: () => clock.value, onError: vi.fn() })
    const ashbyDayOne = board(V7_ASHBY_COMPANY, dayOne, [firmware(V7_ASHBY_COMPANY, dayOne)], V7_METHOD)
    await store.record([board(V7_COMPANY, dayOne, [firmware(V7_COMPANY, dayOne)], V7_METHOD), ashbyDayOne], 'collection')
    clock.value = Date.parse(dayTwo) + 10_000
    const failed: CachedBoard = {
      ...ashbyDayOne, checkedAt: dayTwo, failures: 1, retryAt: '2026-10-07T09:01:00.000Z',
      error: 'Fictional detail failure', errorPhase: 'content',
    }
    await store.record([board(V7_COMPANY, dayTwo, [firmware(V7_COMPANY, dayTwo)], V7_METHOD), failed], 'collection')
    const history = await store.read()
    expect(history.days.map(day => day.day)).toEqual(['2026-10-06', '2026-10-07'])
    expect(history.days[0].complete).toMatchObject({ comparable: true, stats: { published: 2, technical: 2 } })
    expect(history.days[1].latest.boards.map(item => [item.companyId, item.status])).toEqual([['quill-hardware', 'complete'], ['quill-ashby', 'error']])
    expect(history.days[1].complete).toBeUndefined()
    expect(observationComparison(history.days)).toBeNull()
  })

  it('retains a series recorded under the v6 method as history while the v7 store starts its own series', async () => {
    const at = '2026-10-08T09:00:00.000Z'
    const cache = memory()
    const clock = { value: Date.parse(at) + 10_000 }
    const older = createObservationStore({ companies: [V7_COMPANY], cache, method: V6_METHOD, now: () => clock.value, onError: vi.fn() })
    await older.record([board(V7_COMPANY, at, [firmware(V7_COMPANY, at)], V6_METHOD)], 'collection')
    expect((await older.read()).days).toHaveLength(1)
    const current = createObservationStore({ companies: [V7_COMPANY], cache, now: () => clock.value, onError: vi.fn() })
    const history = await current.read()
    expect(history).toMatchObject({ method: V7_METHOD, days: [], otherSeries: [{ method: V6_METHOD, firstDay: '2026-10-08', lastDay: '2026-10-08', companyCount: 1 }] })
    clock.value = Date.parse('2026-10-09T09:00:00.000Z') + 10_000
    await current.record([board(V7_COMPANY, '2026-10-09T09:00:00.000Z', [firmware(V7_COMPANY, '2026-10-09T09:00:00.000Z')], V7_METHOD)], 'collection')
    const after = await current.read()
    expect(after.days.map(day => [day.day, day.complete?.comparable])).toEqual([['2026-10-09', true]])
    expect(after.otherSeries).toEqual([{ scopeKey: expect.stringMatching(/^[a-f0-9]{64}$/), method: V6_METHOD, firstDay: '2026-10-08', lastDay: '2026-10-08', companyCount: 1 }])
    expect(cache.value().series.map(series => series.method).sort()).toEqual([V6_METHOD, V7_METHOD].sort())
  })
})
