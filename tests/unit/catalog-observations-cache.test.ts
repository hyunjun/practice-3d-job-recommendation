import { describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  createFileObservationCache, createObservationStore, observationCacheFile,
} from '../../server/catalog-observations'
import type { ObservationCache } from '../../server/catalog-observations'
import { BoardFetchError, createCatalogService } from '../../server/catalog-service'
import type { BoardResult } from '../../server/catalog-service'
import type { CachedBoard } from '../../server/board-cache'
import type { CachedPresence } from '../../server/posting-presence'
import { OBSERVATION_METHOD, observationComparison } from '../../shared/catalog-observations'
import type { Company } from '../../shared/types'
import {
  OBSERVATION_COMPANIES, OBSERVATION_DAY_ONE, OBSERVATION_DAY_TWO, observationBoards,
} from '../fixtures/catalog-observations'

const privateRoot = path.resolve('.local/research/60/independent/unit-cache')
function memory<T>(initial: T) {
  let value = structuredClone(initial)
  return {
    load: vi.fn(async () => structuredClone(value)),
    save: vi.fn(async (next: T) => { value = structuredClone(next) }),
    value: () => structuredClone(value),
  }
}
function observationMemory(initial: unknown = { version: 1, series: [] }) {
  const cache = memory(initial)
  return { ...cache, save: cache.save as ReturnType<typeof vi.fn<ObservationCache['save']>> }
}
async function directory() {
  await mkdir(privateRoot, { recursive: true })
  return mkdtemp(path.join(privateRoot, 'observation-'))
}
function serviceSetup(initial: CachedBoard[] = [], initialNow = OBSERVATION_DAY_ONE) {
  let time = Date.parse(initialNow)
  const cache = memory(initial)
  const historyCache = observationMemory()
  const presenceCache = memory<CachedPresence[]>([])
  const onError = vi.fn()
  const observations = createObservationStore({
    companies: OBSERVATION_COMPANIES, cache: historyCache, now: () => time, onError,
  })
  const fetchBoard = vi.fn(async (company: Company, fetchedAt: string): Promise<BoardResult> => {
    const snapshot = observationBoards({ at: fetchedAt }).find(board => board.companyId === company.id)!.snapshot!
    return {
      total: snapshot.total, jobs: snapshot.jobs, unmappedCount: snapshot.unmappedCount!,
      publishedIds: snapshot.publishedIds,
    }
  })
  const fetchPresence = vi.fn(async (company: Company) => {
    const snapshot = observationBoards().find(board => board.companyId === company.id)!.snapshot!
    return { total: snapshot.total, publishedIds: snapshot.publishedIds! }
  })
  const options = {
    companies: OBSERVATION_COMPANIES, cache, observations, fetchBoard,
    presence: { cache: presenceCache, fetchBoard: fetchPresence },
    now: () => time, random: () => 0, onCacheError: onError,
  }
  return {
    service: createCatalogService(options), options, cache, observations, historyCache,
    presenceCache, fetchBoard, fetchPresence, onError,
    at: (at: string) => { time = Date.parse(at) },
  }
}

describe('independent observation storage durability', () => {
  it('writes its own derived atomic file and leaves full cache bytes intact', async () => {
    const root = await directory()
    const full = path.join(root, 'configured-board-cache-v5-fictional.json')
    const fullBytes = '{"version":5,"boards":[],"fictionalSentinel":"full body cache must not change"}\n'
    await writeFile(full, fullBytes)
    const file = observationCacheFile(full)
    expect(file).toBe(path.join(root, 'observations-v1', 'configured-board-cache-v5-fictional.json'))
    const cache = createFileObservationCache(file)
    const store = createObservationStore({
      companies: OBSERVATION_COMPANIES, cache, now: () => Date.parse(OBSERVATION_DAY_ONE), onError: vi.fn(),
    })
    await store.record(observationBoards({ method: OBSERVATION_METHOD }), 'collection')
    expect((await store.read()).storage).toBe('ok')
    expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({
      version: 1, series: [{ days: [{ day: '2026-09-24', complete: { stats: { openings: 6 } } }] }],
    })
    expect(await readFile(full, 'utf8')).toBe(fullBytes)
    expect(await readdir(path.dirname(file))).toEqual(['configured-board-cache-v5-fictional.json'])
  })

  it.each([
    ['invalid JSON', '{"version":1,"series":['],
    ['unsupported schema', '{"version":99,"series":[]}'],
    ['invalid series', '{"version":1,"series":[{"scope":{},"method":"fictional","days":[]}]}'],
  ])('%s is reported unavailable and preserved instead of silently overwritten', async (_label, bytes) => {
    const root = await directory()
    const full = path.join(root, 'full.json')
    const fullBytes = '{"version":5,"boards":[],"fictionalSentinel":"untouched"}\n'
    await writeFile(full, fullBytes)
    const file = observationCacheFile(full)
    await mkdir(path.dirname(file))
    await writeFile(file, bytes)
    const onError = vi.fn()
    const store = createObservationStore({
      companies: OBSERVATION_COMPANIES, cache: createFileObservationCache(file),
      now: () => Date.parse(OBSERVATION_DAY_TWO), onError,
    })
    expect(await store.read()).toMatchObject({ storage: 'error', days: [] })
    await store.record(observationBoards({ at: OBSERVATION_DAY_TWO, method: OBSERVATION_METHOD }), 'collection')
    expect(await store.read()).toMatchObject({ storage: 'error', days: [] })
    expect(onError).toHaveBeenCalledTimes(1)
    expect(await readFile(file, 'utf8')).toBe(bytes)
    expect(await readFile(full, 'utf8')).toBe(fullBytes)
  })

  it('keeps the last durable daily history on real atomic-save failure and can save after storage is repaired', async () => {
    const root = await directory()
    const full = path.join(root, 'full.json')
    const fullBytes = '{"version":5,"boards":[]}\n'
    await writeFile(full, fullBytes)
    const file = observationCacheFile(full)
    let time = Date.parse(OBSERVATION_DAY_ONE)
    const store = createObservationStore({
      companies: OBSERVATION_COMPANIES, cache: createFileObservationCache(file), now: () => time, onError: vi.fn(),
    })
    await store.record(observationBoards({ method: OBSERVATION_METHOD }), 'collection')
    const before = await store.read()
    const bytes = await readFile(file, 'utf8')
    const durable = `${file}.durable`
    await rename(file, durable)
    await mkdir(file)
    time = Date.parse(OBSERVATION_DAY_TWO)
    await store.record(observationBoards({ at: OBSERVATION_DAY_TWO, nextDay: true, method: OBSERVATION_METHOD }), 'collection')
    const failed = await store.read()
    expect(failed.storage).toBe('error')
    expect(failed.days).toEqual(before.days)
    expect(failed.error).toContain('마지막')
    expect(await readFile(durable, 'utf8')).toBe(bytes)
    expect(await readFile(full, 'utf8')).toBe(fullBytes)
    expect((await readdir(path.dirname(file))).filter(name => name.endsWith('.tmp'))).toEqual([])
    await rm(file, { recursive: true })
    await rename(durable, file)
    await store.record(observationBoards({ at: OBSERVATION_DAY_TWO, nextDay: true, method: OBSERVATION_METHOD }), 'collection')
    const repaired = await store.read()
    expect(repaired.storage).toBe('ok')
    expect(repaired.days.map(day => day.day)).toEqual(['2026-09-24', '2026-09-26'])
    expect(observationComparison(repaired.days)?.difference).toBe(1)
  })

  it('rejects a file larger than 16 MiB before parsing and preserves the oversized evidence', async () => {
    const root = await directory()
    const file = path.join(root, 'oversized.json')
    await writeFile(file, Buffer.alloc(16 * 1024 * 1024 + 1, 32))
    await expect(createFileObservationCache(file).load()).rejects.toThrow('size limit')
    const store = createObservationStore({
      companies: OBSERVATION_COMPANIES, cache: createFileObservationCache(file),
      now: () => Date.parse(OBSERVATION_DAY_ONE), onError: vi.fn(),
    })
    await store.record(observationBoards({ method: OBSERVATION_METHOD }), 'collection')
    expect(await store.read()).toMatchObject({ storage: 'error', days: [] })
    expect((await readFile(file)).length).toBe(16 * 1024 * 1024 + 1)
  })

  it('serializes simultaneous records without losing the last complete daily observation', async () => {
    const cache = observationMemory()
    const store = createObservationStore({
      companies: OBSERVATION_COMPANIES, cache, now: () => Date.parse(OBSERVATION_DAY_TWO), onError: vi.fn(),
    })
    await Promise.all([
      store.record(observationBoards({ method: OBSERVATION_METHOD }), 'collection'),
      store.record(observationBoards({ at: OBSERVATION_DAY_TWO, nextDay: true, method: OBSERVATION_METHOD }), 'collection'),
      store.record(observationBoards({ method: OBSERVATION_METHOD }), 'cache'),
    ])
    const history = await store.read()
    expect(history.days.map(day => day.day)).toEqual(['2026-09-24', '2026-09-26'])
    expect(history.days.map(day => day.complete?.stats.openings)).toEqual([6, 7])
    expect(cache.save).toHaveBeenCalledTimes(2)
  })
})

describe('independent catalog service observation hooks', () => {
  it('serves concurrent cold history reads without starting either full-body or presence collection', async () => {
    const test = serviceSetup()
    const responses = await Promise.all(Array.from({ length: 8 }, () => test.service.getObservations()))
    for (const history of responses) expect(history).toMatchObject({ storage: 'ok', days: [] })
    expect(test.fetchBoard).not.toHaveBeenCalled()
    expect(test.fetchPresence).not.toHaveBeenCalled()
    expect(test.cache.save).not.toHaveBeenCalled()
    expect(test.historyCache.save).not.toHaveBeenCalled()
    expect(test.cache.load).toHaveBeenCalledTimes(1)
  })

  it('seeds legacy cached bodies at their original date without provider calls, full-cache writes or fabricated method markers', async () => {
    const original = observationBoards()
    const test = serviceSetup(original, OBSERVATION_DAY_TWO)
    const history = await test.service.getObservations()
    expect(history.days.map(day => day.day)).toEqual(['2026-09-24'])
    expect(history.days[0].complete).toMatchObject({
      origin: 'cache', observedAt: OBSERVATION_DAY_ONE, recordedAt: OBSERVATION_DAY_TWO,
      comparable: false, stats: { openings: 6 },
    })
    expect(test.fetchBoard).not.toHaveBeenCalled()
    expect(test.fetchPresence).not.toHaveBeenCalled()
    expect(test.cache.save).not.toHaveBeenCalled()
    expect(test.cache.value()).toEqual(original)
    expect(test.cache.value().every(board => board.snapshot?.observationMethod === undefined)).toBe(true)
  })

  it('marks new full snapshots comparable, while later presence checks leave history and full-cache clocks unchanged', async () => {
    const test = serviceSetup()
    const catalog = await test.service.get(true)
    expect(catalog.jobs).toHaveLength(7)
    const first = await test.service.getObservations()
    expect(first.days[0].complete).toMatchObject({
      origin: 'collection', observedAt: OBSERVATION_DAY_ONE, comparable: true, stats: { openings: 6 },
    })
    expect(test.fetchBoard).toHaveBeenCalledTimes(2)
    expect(test.fetchPresence).not.toHaveBeenCalled()
    expect(test.cache.value().map(board => board.snapshot?.observationMethod)).toEqual([OBSERVATION_METHOD, OBSERVATION_METHOD])
    const bytes = JSON.stringify(test.cache.value())
    test.at('2026-09-25T10:00:00.000Z')
    await test.service.getPostingStatus(true)
    expect(test.fetchPresence).toHaveBeenCalledTimes(2)
    expect(test.fetchBoard).toHaveBeenCalledTimes(2)
    expect(JSON.stringify(test.cache.value())).toBe(bytes)
    expect(test.cache.save).toHaveBeenCalledTimes(1)
    expect(await test.service.getObservations()).toEqual(first)
    const restarted = createCatalogService(test.options)
    expect(await restarted.getObservations()).toEqual(first)
    expect(test.fetchBoard).toHaveBeenCalledTimes(2)
    expect(test.fetchPresence).toHaveBeenCalledTimes(2)
    expect(JSON.stringify(test.cache.value())).toBe(bytes)
  })

  it('does not create a body-observation day from a successful presence check with no cached bodies', async () => {
    const test = serviceSetup()
    await test.service.getPostingStatus(true)
    expect(test.fetchPresence).toHaveBeenCalledTimes(2)
    expect(test.fetchBoard).not.toHaveBeenCalled()
    expect(await test.service.getObservations()).toMatchObject({ storage: 'ok', days: [] })
    expect(test.historyCache.save).not.toHaveBeenCalled()
    expect(test.cache.save).not.toHaveBeenCalled()
  })

  it('records only after all full collection workers settle, never a partial in-progress aggregate', async () => {
    const test = serviceSetup()
    let release!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    const implementation = test.fetchBoard.getMockImplementation()!
    test.fetchBoard.mockImplementation(async (company, at) => {
      if (company.id === 'observation-relay') await held
      return implementation(company, at)
    })
    try {
      const progress = await test.service.getProgressive(true)
      expect(progress.progress?.done).toBe(false)
      expect((await test.service.getObservations()).days).toEqual([])
      expect(test.historyCache.save).not.toHaveBeenCalled()
    } finally {
      release()
    }
    await test.service.get()
    expect(test.fetchBoard).toHaveBeenCalledTimes(2)
    expect((await test.service.getObservations()).days[0].complete?.stats.openings).toBe(6)
    expect(test.historyCache.save).toHaveBeenCalledTimes(1)
  })

  it('records a later failure without replacing the earlier same-day complete point', async () => {
    const test = serviceSetup()
    await test.service.get(true)
    const first = await test.service.getObservations()
    test.at('2026-09-24T11:00:00.000Z')
    const implementation = test.fetchBoard.getMockImplementation()!
    test.fetchBoard.mockImplementation(async (company, at) => {
      if (company.id === 'observation-relay') throw new BoardFetchError('Fictional full body failure')
      return implementation(company, at)
    })
    await test.service.get(true)
    const history = await test.service.getObservations()
    expect(history.days).toHaveLength(1)
    expect(history.days[0].complete).toEqual(first.days[0].complete)
    expect(history.days[0].latest.boards[1]).toMatchObject({
      status: 'error', checkedAt: '2026-09-24T11:00:00.000Z', lastSuccessAt: OBSERVATION_DAY_ONE,
    })
    expect(history.days[0].latest).not.toHaveProperty('stats')
    expect(test.fetchBoard).toHaveBeenCalledTimes(4)
    expect(test.fetchPresence).not.toHaveBeenCalled()
  })

  it('keeps successful provider content available even when saving observation history fails', async () => {
    const test = serviceSetup()
    test.historyCache.save.mockRejectedValue(new Error('Fictional history disk failure'))
    const catalog = await test.service.get(true)
    expect(catalog.jobs).toHaveLength(7)
    expect(catalog.boards.map(board => board.status)).toEqual(['ok', 'ok'])
    expect(test.cache.value()).toHaveLength(2)
    const history = await test.service.getObservations()
    expect(history).toMatchObject({ storage: 'error', days: [] })
    expect(history.error).toContain('마지막')
    expect(test.fetchBoard).toHaveBeenCalledTimes(2)
    expect(test.onError).toHaveBeenCalledTimes(1)
  })

  it('keeps optional legacy service constructors working without adding observation metadata', async () => {
    const test = serviceSetup()
    const service = createCatalogService({ ...test.options, observations: undefined })
    await service.get(true)
    expect(test.cache.value().every(board => board.snapshot?.observationMethod === undefined)).toBe(true)
    expect(test.historyCache.save).not.toHaveBeenCalled()
    expect(test.fetchBoard).toHaveBeenCalledTimes(2)
  })
})
