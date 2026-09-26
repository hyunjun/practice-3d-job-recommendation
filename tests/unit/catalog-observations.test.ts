import { describe, expect, it, vi } from 'vitest'
import {
  buildObservationStats, OBSERVATION_METHOD, ObservationHistorySchema,
  ObservationStatsSchema, observationComparison,
} from '../../shared/catalog-observations'
import { createObservationStore } from '../../server/catalog-observations'
import type { ObservationCache } from '../../server/catalog-observations'
import type { CachedBoard } from '../../server/board-cache'
import type { Company } from '../../shared/types'
import {
  OBSERVATION_COMPANIES, OBSERVATION_DAY_ONE, OBSERVATION_DAY_TWO, OBSERVATION_EXPECTED,
  observationBoards, observationJob, observationJobs,
} from '../fixtures/catalog-observations'

const DAY = 86_400_000
const rows = (items: { key: string; count: number }[]) => Object.fromEntries(items.map(item => [item.key, item.count]))

function memory(initial: unknown = { version: 1, series: [] }) {
  let value = structuredClone(initial)
  return {
    load: vi.fn(async () => structuredClone(value)),
    save: vi.fn<ObservationCache['save']>(async next => { value = structuredClone(next) }),
    value: () => structuredClone(value),
  }
}

function setup(options: { companies?: Company[]; method?: string; at?: string; cache?: ReturnType<typeof memory> } = {}) {
  let time = Date.parse(options.at ?? OBSERVATION_DAY_ONE)
  const cache = options.cache ?? memory()
  const onError = vi.fn()
  const store = createObservationStore({
    companies: options.companies ?? OBSERVATION_COMPANIES, method: options.method,
    cache, now: () => time, onError,
  })
  return { store, cache, onError, at: (value: string) => { time = Date.parse(value) } }
}

function complete(at = OBSERVATION_DAY_ONE, nextDay = false, method = OBSERVATION_METHOD) {
  return observationBoards({ at, nextDay, method })
}

function empty(at: string): CachedBoard[] {
  return complete(at).map(board => ({
    ...board, snapshot: {
      fetchedAt: at, observationMethod: OBSERVATION_METHOD,
      jobs: [], total: 0, publishedIds: [], unmappedCount: 0,
    },
  }))
}

describe('independent ordinary-opening distribution expectations', () => {
  it('uses six ordinary IDs as the denominator, preserves overlapping facets and separates talent registration', () => {
    const stats = buildObservationStats(observationJobs(), OBSERVATION_COMPANIES, 8)
    expect(stats).toMatchObject({ published: 8, technical: 7, openings: 6, talentPools: 1, skillCount: 6 })
    expect(stats.companies).toEqual([
      { companyId: 'observation-orchard', name: 'Cobalt Orchard', count: 3 },
      { companyId: 'observation-relay', name: 'Juniper Relay', count: 3 },
    ])
    expect(rows(stats.regions)).toEqual(OBSERVATION_EXPECTED.regions)
    expect(rows(stats.roles)).toEqual(OBSERVATION_EXPECTED.roles)
    expect(rows(stats.workModes)).toEqual(OBSERVATION_EXPECTED.workModes)
    expect(Object.fromEntries(stats.skills.map(({ name, mentioned, ...kinds }) => [name, { mentions: mentioned, ...kinds }]))).toEqual(OBSERVATION_EXPECTED.skills)
    expect(stats.skills.map(skill => skill.name)).not.toContain('Rust')
    expect(ObservationStatsSchema.safeParse(stats).success).toBe(true)
  })

  it('deduplicates posting IDs and repeated locations without admitting jobs outside the fixed company scope', () => {
    const jobs = observationJobs()
    const stats = buildObservationStats([
      ...jobs, structuredClone(jobs[1]), observationJob('outside', { companyId: 'unconfigured-company', skills: ['OutsideOnly'] }),
    ], OBSERVATION_COMPANIES, 8)
    expect(stats).toMatchObject({ published: 8, technical: 7, openings: 6, talentPools: 1 })
    expect(rows(stats.regions)).toEqual(OBSERVATION_EXPECTED.regions)
    expect(rows(stats.roles)).toEqual(OBSERVATION_EXPECTED.roles)
    expect(stats.skills.find(skill => skill.name === 'TypeScript')?.mentioned).toBe(3)
    expect(stats.skills.map(skill => skill.name)).not.toContain('OutsideOnly')
  })

  it('keeps an ordinary sales posting out of technical and facet denominators even when supplied with raw candidates', () => {
    const sales = observationJob('6014', {
      companyId: 'observation-relay', source: 'lever', title: 'Account Executive — Relay Accounts',
      role: 'unknown', roleClassification: { version: 1, roles: [], evidence: [] },
      occupation: {
        version: 4, category: 'other', departments: ['Sales'],
        evidence: [{ source: 'title', text: 'Account Executive — Relay Accounts' }],
      },
      skills: ['SalesOnly'], qualifications: { version: 1, experience: [], skills: [] },
    })
    const stats = buildObservationStats([...observationJobs(), sales], OBSERVATION_COMPANIES, 8)
    expect(stats).toMatchObject({ published: 8, technical: 7, openings: 6, talentPools: 1 })
    expect(rows(stats.roles)).toEqual(OBSERVATION_EXPECTED.roles)
    expect(rows(stats.regions)).toEqual(OBSERVATION_EXPECTED.regions)
    expect(stats.skills.map(skill => skill.name)).not.toContain('SalesOnly')
  })

  it('does not turn remote eligibility countries or stale map coordinates into office regions', () => {
    const job = observationJob('remote', {
      workMode: 'remote', cityIds: ['london', 'seoul'],
      remoteCountries: ['US', 'CA'], remoteWorldwide: false,
    })
    const stats = buildObservationStats([job], [OBSERVATION_COMPANIES[0]], 1)
    expect(rows(stats.regions)).toEqual({ americas: 0, europe: 0, 'asia-pacific': 0, remote: 1, other: 0, unknown: 0 })
    expect(stats.openings).toBe(1)
  })

  it('keeps partly unknown and contradictory workplace evidence explicit', () => {
    const partlyUnknown = observationJob('partly-known', {
      cityIds: [], workplaceLocations: { version: 1, locations: [
        { label: 'London, United Kingdom', country: 'GB' }, { label: 'Unassigned Sixty Annex' },
      ] },
    })
    const conflict = observationJob('conflict', {
      cityIds: [], workplaceLocations: { version: 1, locations: [{ label: 'London, United Kingdom', country: 'KR' }] },
    })
    const stats = buildObservationStats([partlyUnknown, conflict], [OBSERVATION_COMPANIES[0]], 2)
    expect(stats.openings).toBe(2)
    expect(rows(stats.regions)).toEqual({ americas: 0, europe: 1, 'asia-pacific': 0, remote: 0, other: 0, unknown: 2 })
  })

  it('counts a required alternative as inclusion in one required item and deduplicates repeated mentions per posting', () => {
    const job = observationJob('alternatives')
    job.skills.push('Python', ' TypeScript ')
    job.qualifications!.skills.push(structuredClone(job.qualifications!.skills[0]))
    const stats = buildObservationStats([job], [OBSERVATION_COMPANIES[0]], 1)
    expect(stats.skills).toEqual([
      { name: 'AWS', mentioned: 1, required: 0, qualification: 0, preferred: 0 },
      { name: 'Go', mentioned: 1, required: 0, qualification: 0, preferred: 1 },
      { name: 'Python', mentioned: 1, required: 1, qualification: 0, preferred: 0 },
      { name: 'TypeScript', mentioned: 1, required: 1, qualification: 0, preferred: 0 },
    ])
  })

  it('retains only the top 100 of 124 literal skill names without inventing cross-company aliases', () => {
    const names = Array.from({ length: 123 }, (_, index) => `FixtureSkill${String(index).padStart(3, '0')}`)
    const jobs = [
      observationJob('many-a', { skills: ['Repeated', ...names.slice(0, 60)], qualifications: { version: 1, experience: [], skills: [] } }),
      observationJob('many-b', { skills: ['Repeated', ...names.slice(60)], qualifications: { version: 1, experience: [], skills: [] } }),
    ]
    const stats = buildObservationStats(jobs, [OBSERVATION_COMPANIES[0]], 2)
    expect(stats.skillCount).toBe(124)
    expect(stats.skills).toHaveLength(100)
    expect(stats.skills[0]).toEqual({ name: 'Repeated', mentioned: 2, required: 0, qualification: 0, preferred: 0 })
    expect(stats.skills.at(-1)?.name).toBe('FixtureSkill098')
    expect(stats.skills.map(skill => skill.name)).not.toContain('FixtureSkill122')
    const aliases = buildObservationStats([
      observationJob('alias-a', { skills: ['TS'], qualifications: undefined }),
      observationJob('alias-b', { skills: ['TypeScript'], qualifications: undefined }),
    ], [OBSERVATION_COMPANIES[0]], 2)
    expect(aliases.skills).toEqual([
      { name: 'TS', mentioned: 1, required: 0, qualification: 0, preferred: 0 },
      { name: 'TypeScript', mentioned: 1, required: 0, qualification: 0, preferred: 0 },
    ])
  })

  it('represents a complete empty cohort as a real zero with empty skills and zero facet counts', () => {
    const stats = buildObservationStats([], OBSERVATION_COMPANIES, 0)
    expect(stats).toMatchObject({ published: 0, technical: 0, openings: 0, talentPools: 0, skills: [], skillCount: 0 })
    expect(stats.companies.map(company => company.count)).toEqual([0, 0])
    expect(rows(stats.regions)).toEqual({ americas: 0, europe: 0, 'asia-pacific': 0, remote: 0, other: 0, unknown: 0 })
    expect(rows(stats.workModes)).toEqual({ onsite: 0, hybrid: 0, remote: 0, unknown: 0 })
    expect(stats.roles.every(role => role.count === 0)).toBe(true)
    expect(ObservationStatsSchema.safeParse(stats).success).toBe(true)
  })

  it('rejects impossible denominators, duplicate facets and qualification counts above mentions', () => {
    const stats = buildObservationStats(observationJobs(), OBSERVATION_COMPANIES, 8)
    for (const invalid of [
      { ...stats, published: 6 },
      { ...stats, technical: 6 },
      { ...stats, openings: 5 },
      { ...stats, companies: stats.companies.map(company => ({ ...company, count: 4 })) },
      { ...stats, regions: [stats.regions[0], ...stats.regions.slice(0, -1)] },
      { ...stats, skills: [{ name: 'Impossible', mentioned: 1, required: 2, qualification: 0, preferred: 0 }] },
      { ...stats, skills: [{ name: 'Impossible', mentioned: 7, required: 0, qualification: 0, preferred: 0 }] },
    ]) expect(ObservationStatsSchema.safeParse(invalid).success).toBe(false)
  })
})

describe('independent UTC daily history and completeness', () => {
  it('starts empty, does no writes on reads and does not invent a day from an empty cache', async () => {
    const { store, cache } = setup()
    expect(await store.read()).toMatchObject({ version: 1, storage: 'ok', days: [], otherSeries: [] })
    await store.record([], 'cache')
    await store.read()
    expect(cache.load).toHaveBeenCalledTimes(1)
    expect(cache.save).not.toHaveBeenCalled()
  })

  it('deduplicates same-day cache replay and retains the latest successful count in one UTC slot', async () => {
    const { store, cache, at } = setup()
    const boards = complete()
    await store.record(boards, 'collection')
    const first = await store.read()
    expect(first.days).toHaveLength(1)
    expect(first.days[0]).toMatchObject({
      day: '2026-09-24',
      complete: { observedAt: OBSERVATION_DAY_ONE, recordedAt: OBSERVATION_DAY_ONE, origin: 'collection', comparable: true, stats: { openings: 6 } },
    })
    at('2026-09-24T10:10:00.000Z')
    await store.record(boards, 'cache')
    expect(await store.read()).toEqual(first)
    expect(cache.save).toHaveBeenCalledTimes(1)
    at('2026-09-24T11:00:00.000Z')
    await store.record(complete('2026-09-24T11:00:00.000Z', true), 'collection')
    const latest = await store.read()
    expect(latest.days).toHaveLength(1)
    expect(latest.days[0].complete).toMatchObject({ observedAt: '2026-09-24T11:00:00.000Z', stats: { published: 9, openings: 7 } })
    expect(observationComparison(latest.days)).toBeNull()
  })

  it('compares two distinct complete UTC dates while preserving the missing middle date', async () => {
    const { store, at } = setup()
    await store.record(complete(), 'collection')
    at(OBSERVATION_DAY_TWO)
    await store.record(complete(OBSERVATION_DAY_TWO, true), 'collection')
    const history = await store.read()
    expect(history.days.map(day => day.day)).toEqual(['2026-09-24', '2026-09-26'])
    expect(observationComparison(history.days)).toEqual({
      previousDay: '2026-09-24', currentDay: '2026-09-26', previous: 6, current: 7, difference: 1,
    })
    expect(observationComparison(history.days, '2026-09-24')).toBeNull()
    expect(ObservationHistorySchema.safeParse(history).success).toBe(true)
  })

  it('splits observations exactly at UTC midnight, irrespective of the host timezone', async () => {
    const { store, at } = setup({ at: '2026-09-24T23:59:59.999Z' })
    await store.record(complete('2026-09-24T23:59:59.999Z'), 'collection')
    at('2026-09-25T00:00:00.000Z')
    await store.record(complete('2026-09-25T00:00:00.000Z', true), 'collection')
    expect((await store.read()).days.map(day => day.day)).toEqual(['2026-09-24', '2026-09-25'])
  })

  it('preserves the last complete daily point after a later board failure', async () => {
    const { store, at } = setup()
    await store.record(complete(), 'collection')
    const before = (await store.read()).days[0].complete
    at('2026-09-24T11:00:00.000Z')
    const failed = complete('2026-09-24T11:00:00.000Z', true)
    failed[1] = {
      ...failed[1], checkedAt: '2026-09-24T11:00:00.000Z', failures: 1,
      error: 'Fictional board unavailable', snapshot: complete()[1].snapshot,
    }
    await store.record(failed, 'collection')
    const history = await store.read()
    expect(history.days).toHaveLength(1)
    expect(history.days[0].complete).toEqual(before)
    expect(history.days[0].latest).toMatchObject({
      observedAt: '2026-09-24T11:00:00.000Z',
      boards: [
        { companyId: 'observation-orchard', status: 'complete', lastSuccessAt: '2026-09-24T11:00:00.000Z' },
        { companyId: 'observation-relay', status: 'error', lastSuccessAt: OBSERVATION_DAY_ONE },
      ],
    })
    expect(history.days[0].latest).not.toHaveProperty('stats')
    expect(observationComparison(history.days)).toBeNull()
  })

  it('keeps a failed later day missing a complete point, rather than reporting zero or partial growth', async () => {
    const { store, at } = setup()
    await store.record(complete(), 'collection')
    at(OBSERVATION_DAY_TWO)
    const failed = complete(OBSERVATION_DAY_TWO, true)
    failed[1] = { ...failed[1], snapshot: undefined, failures: 1, error: 'Fictional inventory failure' }
    await store.record(failed, 'collection')
    const history = await store.read()
    expect(history.days.map(day => day.day)).toEqual(['2026-09-24', '2026-09-26'])
    expect(history.days[1].complete).toBeUndefined()
    expect(history.days[1].latest).not.toHaveProperty('stats')
    expect(observationComparison(history.days)).toBeNull()
  })

  it.each([
    ['missing configured company', (boards: CachedBoard[]) => boards.slice(0, 1), 'missing'],
    ['missing body snapshot', (boards: CachedBoard[]) => [{ ...boards[0], snapshot: undefined }, boards[1]], 'incomplete'],
    ['missing complete published IDs', (boards: CachedBoard[]) => {
      delete boards[0].snapshot!.publishedIds
      return boards
    }, 'incomplete'],
    ['legacy count-only unmapped omission', (boards: CachedBoard[]) => {
      boards[1].snapshot!.jobs = boards[1].snapshot!.jobs.filter(job => job.id !== 'lever-observation-relay-6012')
      return boards
    }, 'incomplete'],
    ['legacy unknown omitted count', (boards: CachedBoard[]) => {
      boards[0].snapshot!.unmappedCount = null
      return boards
    }, 'incomplete'],
    ['duplicate published IDs', (boards: CachedBoard[]) => {
      boards[0].snapshot!.publishedIds![1] = boards[0].snapshot!.publishedIds![0]
      return boards
    }, 'incomplete'],
  ] as const)('%s never supplies complete cohort statistics', async (_name, change, status) => {
    const { store } = setup()
    await store.record(change(complete()), 'collection')
    const history = await store.read()
    expect(history.days).toHaveLength(1)
    expect(history.days[0].complete).toBeUndefined()
    expect(history.days[0].latest.boards.some(board => board.status === status)).toBe(true)
    expect(history.days[0].latest).not.toHaveProperty('stats')
  })

  it('checks staleness against the latest real board attempt, including the exact 30-minute boundary', async () => {
    const { store, at } = setup({ at: '2026-09-24T10:29:59.999Z' })
    const justFresh = complete('2026-09-24T10:29:59.999Z')
    justFresh[0] = complete()[0]
    await store.record(justFresh, 'collection')
    const before = (await store.read()).days[0].complete
    expect(before?.stats.openings).toBe(6)
    at('2026-09-24T10:30:00.000Z')
    const stale = complete('2026-09-24T10:30:00.000Z', true)
    stale[0] = complete()[0]
    await store.record(stale, 'collection')
    const day = (await store.read()).days[0]
    expect(day.latest.boards[0]).toMatchObject({ status: 'stale', checkedAt: OBSERVATION_DAY_ONE, lastSuccessAt: OBSERVATION_DAY_ONE })
    expect(day.complete).toEqual(before)
  })

  it('records a real zero only after every configured board returns a complete empty inventory', async () => {
    const { store, at } = setup()
    await store.record(complete(), 'collection')
    at(OBSERVATION_DAY_TWO)
    await store.record(empty(OBSERVATION_DAY_TWO), 'collection')
    const history = await store.read()
    expect(history.days[1].complete).toMatchObject({
      comparable: true, stats: { published: 0, technical: 0, openings: 0, talentPools: 0, skills: [] },
    })
    expect(observationComparison(history.days)).toEqual({
      previousDay: '2026-09-24', currentDay: '2026-09-26', previous: 6, current: 0, difference: -6,
    })
  })

  it('ignores older replayed attempts instead of moving a daily observation backwards', async () => {
    const { store } = setup({ at: '2026-09-24T11:00:00.000Z' })
    await store.record(complete('2026-09-24T11:00:00.000Z', true), 'collection')
    const before = await store.read()
    await store.record(complete(), 'cache')
    expect(await store.read()).toEqual(before)
  })

  it('does not rewrite the same failed cache replay over a preserved complete point or renew its recorded time', async () => {
    const { store, cache, at } = setup()
    await store.record(complete(), 'collection')
    at('2026-09-24T11:00:00.000Z')
    const failed = complete('2026-09-24T11:00:00.000Z')
    failed[1] = { ...failed[1], snapshot: complete()[1].snapshot, failures: 1, error: 'Fictional failure' }
    await store.record(failed, 'collection')
    const before = await store.read()
    expect(cache.save).toHaveBeenCalledTimes(2)
    at(OBSERVATION_DAY_TWO)
    await store.record(failed, 'cache')
    expect(await store.read()).toEqual(before)
    expect(cache.save).toHaveBeenCalledTimes(2)
  })

  it('rejects API history with fabricated observation clocks, missing complete clocks or mislabeled UTC days', async () => {
    const { store } = setup()
    await store.record(complete(), 'collection')
    const original = await store.read()
    const inventedTime = structuredClone(original)
    inventedTime.days[0].latest.observedAt = '2026-09-24T10:00:00.001Z'
    inventedTime.days[0].latest.recordedAt = '2026-09-24T10:01:00.000Z'
    const missingSourceClock = structuredClone(original)
    missingSourceClock.days[0].complete!.boards[0].lastSuccessAt = null
    const wrongDay = structuredClone(original)
    wrongDay.days[0].day = '2026-09-25'
    const wrongCompany = structuredClone(original)
    wrongCompany.days[0].complete!.boards[0].companyId = 'unconfigured-company'
    const duplicateDay = structuredClone(original)
    duplicateDay.days.push(structuredClone(duplicateDay.days[0]))
    for (const invalid of [inventedTime, missingSourceClock, wrongDay, wrongCompany, duplicateDay]) {
      expect(ObservationHistorySchema.safeParse(invalid).success).toBe(false)
    }
  })
})

describe('independent cache provenance, cohort and method comparison boundaries', () => {
  it.each([undefined, 'different-interpretation-method'])('seeds %s cache at original source clocks without making it comparable', async method => {
    const { store } = setup({ at: OBSERVATION_DAY_TWO })
    await store.record(observationBoards({ method }), 'cache')
    const history = await store.read()
    expect(history.days.map(day => day.day)).toEqual(['2026-09-24'])
    expect(history.days[0].complete).toMatchObject({
      origin: 'cache', comparable: false, observedAt: OBSERVATION_DAY_ONE, recordedAt: OBSERVATION_DAY_TWO,
      stats: { published: 8, technical: 7, openings: 6, talentPools: 1 },
    })
    await store.record(complete(OBSERVATION_DAY_TWO, true), 'collection')
    expect(observationComparison((await store.read()).days)).toBeNull()
  })

  it('keeps a matching cache marker comparable after restart without adding today or renewing source clocks', async () => {
    const cache = memory()
    const first = setup({ cache })
    await first.store.record(complete(), 'collection')
    const before = await first.store.read()
    const second = setup({ cache, at: OBSERVATION_DAY_TWO })
    await second.store.record(complete(), 'cache')
    expect(await second.store.read()).toEqual(before)
    expect(cache.save).toHaveBeenCalledTimes(1)
  })

  it('allows display-name changes and company ordering without restarting the same cohort', async () => {
    const cache = memory()
    await setup({ cache }).store.record(complete(), 'collection')
    const renamed = OBSERVATION_COMPANIES.map(company => ({ ...company, name: `${company.name} Renamed` })).reverse()
    const second = setup({ cache, companies: renamed, at: OBSERVATION_DAY_TWO })
    await second.store.record(complete(OBSERVATION_DAY_TWO, true), 'collection')
    const history = await second.store.read()
    expect(history.days.map(day => day.day)).toEqual(['2026-09-24', '2026-09-26'])
    expect(history.otherSeries).toEqual([])
    expect(observationComparison(history.days)?.difference).toBe(1)
  })

  it.each([
    ['company added', (companies: Company[]) => [...companies, {
      ...companies[0], id: 'observation-spruce', name: 'Spruce Fiction', board: 'SpruceObservations60',
    }]],
    ['company removed', (companies: Company[]) => companies.slice(0, 1)],
    ['provider changed', (companies: Company[]) => companies.map((company, index) => index ? company : { ...company, provider: 'ashby' as const })],
    ['board changed', (companies: Company[]) => companies.map((company, index) => index ? company : { ...company, board: 'CobaltNext60' })],
    ['Lever EU region changed', (companies: Company[]) => companies.map(company => ({ ...company, boardRegion: undefined }))],
  ] as const)('%s starts a separate series and never appears as growth', async (_name, change) => {
    const cache = memory()
    const first = setup({ cache })
    await first.store.record(complete(), 'collection')
    const original = await first.store.read()
    const companies = change(structuredClone(OBSERVATION_COMPANIES))
    const second = setup({ cache, companies, at: OBSERVATION_DAY_TWO })
    // Empty boards keep this an actual complete new cohort, not a missing-board shortcut.
    const boards: CachedBoard[] = companies.map(company => ({
      companyId: company.id, board: company.board!, provider: company.provider!,
      ...(company.boardRegion ? { boardRegion: company.boardRegion } : {}),
      checkedAt: OBSERVATION_DAY_TWO, failures: 0, retryAt: null,
      snapshot: { fetchedAt: OBSERVATION_DAY_TWO, jobs: [], total: 0, publishedIds: [], unmappedCount: 0, observationMethod: OBSERVATION_METHOD },
    }))
    await second.store.record(boards, 'collection')
    const history = await second.store.read()
    expect(history.scope.key).not.toBe(original.scope.key)
    expect(history.days.map(day => day.day)).toEqual(['2026-09-26'])
    expect(history.days[0].complete?.stats.openings).toBe(0)
    expect(observationComparison(history.days)).toBeNull()
    expect(history.otherSeries).toEqual([{
      scopeKey: original.scope.key, method: OBSERVATION_METHOD,
      firstDay: '2026-09-24', lastDay: '2026-09-24', companyCount: 2,
    }])
  })

  it('keeps a changed interpretation method separate and preserves the previous stored aggregate', async () => {
    const cache = memory()
    const first = setup({ cache })
    await first.store.record(complete(), 'collection')
    const original = await first.store.read()
    const method = 'observations-fictional-next-method'
    const second = setup({ cache, method, at: OBSERVATION_DAY_TWO })
    await second.store.record(complete(OBSERVATION_DAY_TWO, true, method), 'collection')
    const history = await second.store.read()
    expect(history.scope.key).toBe(original.scope.key)
    expect(history.method).toBe(method)
    expect(history.days.map(day => day.day)).toEqual(['2026-09-26'])
    expect(history.days[0].complete?.stats.openings).toBe(7)
    expect(observationComparison(history.days)).toBeNull()
    expect(history.otherSeries[0]).toMatchObject({ method: OBSERVATION_METHOD, firstDay: '2026-09-24', companyCount: 2 })
    const previous = setup({ cache, at: OBSERVATION_DAY_TWO })
    expect((await previous.store.read()).days[0].complete).toEqual(original.days[0].complete)
  })

  it('retains the current UTC day plus 89 earlier dates and never inserts missing dates', async () => {
    const { store, at } = setup({ at: OBSERVATION_DAY_TWO })
    const oldest = new Date(Date.parse(OBSERVATION_DAY_TWO) - 89 * DAY).toISOString()
    const expired = new Date(Date.parse(OBSERVATION_DAY_TWO) - 90 * DAY).toISOString()
    await store.record(complete(expired), 'cache')
    await store.record(complete(oldest), 'cache')
    await store.record(complete(OBSERVATION_DAY_TWO), 'collection')
    const history = await store.read()
    expect(history.days.map(day => day.day)).toEqual(['2026-06-29', '2026-09-26'])
    at('2026-09-27T00:00:00.000Z')
    expect((await store.read()).days.map(day => day.day)).toEqual(['2026-09-26'])
  })

  it('bounds retained series to four and reports the three excluded comparison scopes', async () => {
    const cache = memory()
    for (let index = 0; index < 5; index++) {
      const method = `fictional-method-${index}`
      const current = setup({ cache, method, at: OBSERVATION_DAY_TWO })
      await current.store.record(complete(OBSERVATION_DAY_TWO, false, method), 'collection')
    }
    const current = setup({ cache, method: 'fictional-method-4', at: OBSERVATION_DAY_TWO })
    const history = await current.store.read()
    expect(history.days).toHaveLength(1)
    expect(history.otherSeries).toHaveLength(3)
    expect(history.otherSeries.every(series => series.companyCount === 2 && series.firstDay === '2026-09-26')).toBe(true)
    expect((cache.value() as { series: unknown[] }).series).toHaveLength(4)
    expect(observationComparison(history.days)).toBeNull()
  })

  it.each(['scope', 'method'] as const)('reads all four prior series before a new current %s has any record, then keeps the new point plus three prior series', async change => {
    const cache = memory()
    const companiesAt = (index: number) => OBSERVATION_COMPANIES.map((company, position) => ({
      ...company, ...(change === 'scope' && position === 0 ? { board: `FictionalBoundary${index}` } : {}),
    }))
    const methodAt = (index: number) => change === 'method' ? `fictional-boundary-method-${index}` : OBSERVATION_METHOD
    for (let index = 0; index < 4; index++) {
      const companies = companiesAt(index)
      const method = methodAt(index)
      const previous = setup({ cache, companies, method })
      await previous.store.record(observationBoards({ companies, method }), 'collection')
    }
    const companies = companiesAt(4)
    const method = methodAt(4)
    const current = setup({ cache, companies, method, at: OBSERVATION_DAY_TWO })
    const before = await current.store.read()
    expect(before.storage).toBe('ok')
    expect(before.days).toEqual([])
    expect(before.otherSeries).toHaveLength(4)
    expect(before.otherSeries.map(series => series.companyCount)).toEqual([2, 2, 2, 2])
    expect(before.otherSeries.map(series => [series.firstDay, series.lastDay])).toEqual([
      ['2026-09-24', '2026-09-24'], ['2026-09-24', '2026-09-24'],
      ['2026-09-24', '2026-09-24'], ['2026-09-24', '2026-09-24'],
    ])
    expect(observationComparison(before.days)).toBeNull()
    expect(ObservationHistorySchema.safeParse(before).success).toBe(true)
    expect(cache.save).toHaveBeenCalledTimes(4)
    await current.store.record(observationBoards({ at: OBSERVATION_DAY_TWO, companies, method }), 'collection')
    const after = await current.store.read()
    expect(after.storage).toBe('ok')
    expect(after.days.map(day => day.day)).toEqual(['2026-09-26'])
    expect(after.days[0].complete?.stats.openings).toBe(6)
    expect(after.otherSeries).toHaveLength(3)
    expect((cache.value() as { series: unknown[] }).series).toHaveLength(4)
    expect(observationComparison(after.days)).toBeNull()
  })
})
