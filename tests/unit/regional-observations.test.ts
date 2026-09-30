import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildObservationStats, OBSERVATION_METHOD, ObservationHistorySchema,
  ObservationSeriesSchema, ObservationStatsSchema, observationComparison,
} from '../../shared/catalog-observations'
import { createObservationStore } from '../../server/catalog-observations'
import type { ObservationCache } from '../../server/catalog-observations'
import { parseCachedBoards } from '../../server/board-cache'
import { REGIONAL_COMPANY } from '../fixtures/regional-coverage'
import {
  REGIONAL_CURRENT_METHOD, REGIONAL_CURRENT_STATS, REGIONAL_LEGACY_METHOD, REGIONAL_LEGACY_STATS,
  regionalObservationBoard, regionalObservationHistory, regionalObservationJobs, regionalObservationSeries,
} from '../fixtures/regional-observations'

const noNetwork = vi.fn(async () => { throw new Error('Observation migration uses only fictional in-memory sources.') })
beforeEach(() => { noNetwork.mockClear(); vi.stubGlobal('fetch', noNetwork) })
afterEach(() => { expect(noNetwork).not.toHaveBeenCalled(); vi.unstubAllGlobals() })

function memory(initial: unknown) {
  let value = structuredClone(initial)
  return {
    load: vi.fn(async () => structuredClone(value)),
    save: vi.fn<ObservationCache['save']>(async next => { value = structuredClone(next) }),
    value: () => structuredClone(value),
  }
}

describe('Middle East distribution and explicit old/new method shapes', () => {
  it('counts each posting once per region, keeps remote separate and does not move NZ/TW out of APAC', () => {
    expect(OBSERVATION_METHOD).toBe('observations-2.cities-1.occupation-7.roles-1.qualifications-1.remote-3.employment-1.purpose-1')
    const jobs = regionalObservationJobs()
    const stats = buildObservationStats(jobs, [REGIONAL_COMPANY], 7)
    expect(stats).toEqual(REGIONAL_CURRENT_STATS)
    expect(stats.regions).toEqual([
      { key: 'americas', count: 0 }, { key: 'europe', count: 0 },
      { key: 'asia-pacific', count: 3 }, { key: 'middle-east', count: 2 },
      { key: 'remote', count: 1 }, { key: 'other', count: 1 }, { key: 'unknown', count: 1 },
    ])
    const repeated = buildObservationStats([...jobs, structuredClone(jobs[0])], [REGIONAL_COMPANY], 7)
    expect(repeated).toEqual(REGIONAL_CURRENT_STATS)
  })

  it('reads the six original legacy buckets unchanged and validates all seven current buckets', () => {
    expect(ObservationStatsSchema.parse(REGIONAL_LEGACY_STATS)).toEqual(REGIONAL_LEGACY_STATS)
    expect(ObservationStatsSchema.parse(REGIONAL_CURRENT_STATS)).toEqual(REGIONAL_CURRENT_STATS)
    const old = regionalObservationHistory(true)
    const before = JSON.stringify(old)
    const parsed = ObservationHistorySchema.parse(old)
    expect(parsed.days[0].complete?.stats.regions).toEqual([
      { key: 'americas', count: 0 }, { key: 'europe', count: 0 }, { key: 'asia-pacific', count: 3 },
      { key: 'remote', count: 0 }, { key: 'other', count: 0 }, { key: 'unknown', count: 0 },
    ])
    expect(parsed).toEqual(old)
    expect(JSON.stringify(old)).toBe(before)
    expect(ObservationHistorySchema.safeParse(regionalObservationHistory()).success).toBe(true)
  })

  it('requires seven buckets for the current method and rejects another missing or duplicated legacy key', () => {
    const currentWithoutMiddleEast = regionalObservationSeries()
    currentWithoutMiddleEast.days[0].complete!.stats.regions = [
      { key: 'americas', count: 0 }, { key: 'europe', count: 0 }, { key: 'asia-pacific', count: 3 },
      { key: 'remote', count: 1 }, { key: 'other', count: 1 }, { key: 'unknown', count: 1 },
    ]
    expect(ObservationSeriesSchema.safeParse(currentWithoutMiddleEast).success).toBe(false)
    const missingOther = regionalObservationSeries()
    missingOther.days[0].complete!.stats.regions = [
      { key: 'americas', count: 0 }, { key: 'europe', count: 0 },
      { key: 'asia-pacific', count: 3 }, { key: 'middle-east', count: 2 },
      { key: 'remote', count: 1 }, { key: 'unknown', count: 1 },
    ]
    expect(ObservationSeriesSchema.safeParse(missingOther).success).toBe(false)
    const duplicateLegacy = regionalObservationSeries(true)
    duplicateLegacy.days[0].complete!.stats.regions[0] = { key: 'europe', count: 0 }
    expect(ObservationSeriesSchema.safeParse(duplicateLegacy).success).toBe(false)
  })

  it('retains the old aggregate through a new-method write and restart without treating the method change as growth', async () => {
    const legacy = regionalObservationSeries(true)
    const cache = memory({ version: 1, series: [legacy] })
    const onError = vi.fn()
    const store = createObservationStore({
      companies: [REGIONAL_COMPANY], cache, now: () => Date.parse('2026-09-27T06:00:10.000Z'), onError,
    })
    const first = await store.read()
    expect(first).toMatchObject({
      storage: 'ok', method: REGIONAL_CURRENT_METHOD, days: [],
      otherSeries: [{
        method: REGIONAL_LEGACY_METHOD, firstDay: '2026-09-26', lastDay: '2026-09-26', companyCount: 1,
      }],
    })
    expect(cache.save).not.toHaveBeenCalled()
    await store.record([regionalObservationBoard()], 'collection')
    const current = await store.read()
    expect(current.days.map(day => day.day)).toEqual(['2026-09-27'])
    expect(current.days[0].complete?.stats).toEqual(REGIONAL_CURRENT_STATS)
    expect(current.days[0].complete?.comparable).toBe(true)
    expect(observationComparison(current.days)).toBeNull()
    expect(cache.save).toHaveBeenCalledTimes(1)
    const persisted = cache.value() as { series: unknown[] }
    expect(persisted.series).toHaveLength(2)
    expect(persisted.series).toContainEqual(legacy)
    const older = createObservationStore({
      companies: [REGIONAL_COMPANY], cache, method: REGIONAL_LEGACY_METHOD,
      now: () => Date.parse('2026-09-27T06:00:10.000Z'), onError,
    })
    const restored = await older.read()
    expect(restored.storage).toBe('ok')
    expect(restored.days).toEqual(legacy.days)
    expect(restored.days[0].complete?.stats.regions).toHaveLength(6)
    expect(cache.save).toHaveBeenCalledTimes(1)
    expect(onError).not.toHaveBeenCalled()
  })

  it('does not renew an older cache interpretation marker just because its jobs can now be mapped', async () => {
    const input = regionalObservationBoard(REGIONAL_LEGACY_METHOD)
    input.snapshot!.jobs[0].cityIds = []
    delete input.snapshot!.jobs[0].cityCoverageVersion
    input.snapshot!.unmappedCount = 3
    const current = parseCachedBoards({ version: 5, boards: [input] })
    expect(current[0].snapshot?.jobs[0].cityIds).toEqual(['dubai'])
    expect(current[0].snapshot?.unmappedCount).toBe(2)
    expect(current[0].snapshot?.observationMethod).toBe(REGIONAL_LEGACY_METHOD)
    const cache = memory({ version: 1, series: [] })
    const onError = vi.fn()
    const store = createObservationStore({
      companies: [REGIONAL_COMPANY], cache, now: () => Date.parse('2026-09-27T06:00:10.000Z'), onError,
    })
    await store.record(current, 'cache')
    const history = await store.read()
    expect(history.days[0].complete).toMatchObject({
      observedAt: '2026-09-27T06:00:00.000Z', recordedAt: '2026-09-27T06:00:10.000Z',
      origin: 'cache', comparable: false,
    })
    expect(history.days[0].complete?.stats).toEqual(REGIONAL_CURRENT_STATS)
    expect(observationComparison(history.days)).toBeNull()
    expect(input.snapshot?.observationMethod).toBe(REGIONAL_LEGACY_METHOD)
    expect(input.snapshot?.jobs[0].cityIds).toEqual([])
    expect(onError).not.toHaveBeenCalled()
  })
})
