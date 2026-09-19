import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { PUBLIC_COMPANIES } from '../../shared/companies'
import { createSampleCatalog } from '../../shared/sample'
import type { Company, Job } from '../../shared/types'
import { createFileBoardCache, parseCachedBoards } from '../../server/board-cache'
import type { BoardCache, CachedBoard } from '../../server/board-cache'
import { BoardFetchError, CATALOG_POLICY, CatalogUnavailableError, createCatalogService, parseRetryAfter } from '../../server/catalog-service'
import { fetchGreenhouseBoard } from '../../server/catalog'

const BASE = Date.parse('2026-09-19T06:00:00.000Z')
const companies = PUBLIC_COMPANIES.slice(0, 2)
const demoJob = createSampleCatalog().jobs[0]
const iso = (value: number) => new Date(value).toISOString()
const job = (company: Company, fetchedAt: string, suffix = 'one'): Job & { source: 'greenhouse' } => ({
  ...demoJob, id: `${company.id}-${suffix}`, companyId: company.id, source: 'greenhouse', fetchedAt,
})
const snapshot = (company: Company, time = BASE): CachedBoard => ({
  companyId: company.id, board: company.board!, checkedAt: iso(time), failures: 0, retryAt: null,
  snapshot: { fetchedAt: iso(time), jobs: [job(company, iso(time))], total: 2, unmappedCount: 1 },
})
function memoryCache(initial: CachedBoard[] = []) {
  let value = structuredClone(initial)
  const store: BoardCache = {
    load: vi.fn(async () => structuredClone(value)),
    save: vi.fn(async boards => { value = structuredClone(boards) }),
  }
  return store
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('per-board last successful results', () => {
  it('retains only the failed company snapshot and its original timestamp during a partial outage', async () => {
    const current = BASE + CATALOG_POLICY.freshFor
    const cache = memoryCache(companies.map(company => snapshot(company)))
    const service = createCatalogService({
      companies, cache, now: () => current, random: () => 0,
      fetchBoard: async (company, fetchedAt) => {
        if (company === companies[0]) throw new BoardFetchError('HTTP 503')
        return { jobs: [job(company, fetchedAt, 'new')], total: 1, unmappedCount: 0 }
      },
    })
    const result = await service.get()
    expect(result.jobs).toEqual([
      expect.objectContaining({ id: `${companies[0].id}-one`, fetchedAt: iso(BASE), stale: true }),
      expect.objectContaining({ id: `${companies[1].id}-new`, fetchedAt: iso(current), stale: false }),
    ])
    expect(result.boards[0]).toMatchObject({ status: 'error', dataStatus: 'stale', included: 1, lastSuccessAt: iso(BASE), checkedAt: iso(current) })
    expect(result.boards[1]).toMatchObject({ status: 'ok', dataStatus: 'fresh', included: 1 })
    expect(result.stale).toBe(true)
    expect(result.unmappedCount).toBe(1)
    expect((await cache.load())[0].snapshot?.jobs[0].fetchedAt).toBe(iso(BASE))
  })

  it('keeps all failed snapshots stale during cooldown and after restarting the collector', async () => {
    const current = BASE + CATALOG_POLICY.freshFor
    const cache = memoryCache(companies.map(company => snapshot(company)))
    const fetchBoard = vi.fn(async () => { throw new Error('Network unavailable') })
    const options = { companies, cache, fetchBoard, now: () => current, random: () => 0 }
    const service = createCatalogService(options)
    const first = await service.get()
    const repeated = await service.get(true)
    const restored = await createCatalogService(options).get(true)
    expect(first.jobs).toHaveLength(2)
    for (const result of [first, repeated, restored]) {
      expect(result.stale).toBe(true)
      expect(result.jobs.every(item => item.stale && item.fetchedAt === iso(BASE))).toBe(true)
      expect(result.fetchedAt).toBe(iso(BASE))
    }
    expect(fetchBoard).toHaveBeenCalledTimes(2)
  })

  it('treats a successful empty feed as authoritative and never revives the removed jobs on a later failure', async () => {
    let current = BASE + CATALOG_POLICY.freshFor
    let fail = false
    const cache = memoryCache([snapshot(companies[0])])
    const service = createCatalogService({
      companies: [companies[0]], cache, now: () => current, random: () => 0,
      fetchBoard: async () => {
        if (fail) throw new Error('Network unavailable')
        return { jobs: [], total: 0, unmappedCount: 0 }
      },
    })
    expect((await service.get()).jobs).toEqual([])
    expect((await cache.load())[0].snapshot?.jobs).toEqual([])
    fail = true
    current += CATALOG_POLICY.freshFor
    const result = await service.get()
    expect(result.jobs).toEqual([])
    expect(result.boards[0]).toMatchObject({ status: 'error', dataStatus: 'stale', included: 0, lastSuccessAt: iso(current - CATALOG_POLICY.freshFor) })
  })

  it('excludes failed snapshots older than 24 hours without extending their age', async () => {
    const current = BASE + CATALOG_POLICY.maxFallbackAge + 1
    const cache = memoryCache(companies.map(company => snapshot(company)))
    const service = createCatalogService({
      companies, cache, now: () => current, random: () => 0,
      fetchBoard: async (company, fetchedAt) => {
        if (company === companies[0]) throw new Error('Network unavailable')
        return { jobs: [job(company, fetchedAt)], total: 1, unmappedCount: 0 }
      },
    })
    const result = await service.get()
    expect(result.jobs.map(item => item.companyId)).toEqual([companies[1].id])
    expect(result.boards[0]).toMatchObject({ dataStatus: 'unavailable', included: 0, lastSuccessAt: iso(BASE) })
    const unavailable = createCatalogService({
      companies: [companies[0]], cache, now: () => current, random: () => 0,
      fetchBoard: async () => { throw new Error('Still unavailable') },
    })
    await expect(unavailable.get()).rejects.toMatchObject({ code: 'CATALOG_EXPIRED', message: expect.stringContaining('24시간') })
  })

  it('keeps an in-memory result usable if disk persistence fails', async () => {
    const onCacheError = vi.fn()
    const fetchBoard = vi.fn(async (company: Company, fetchedAt: string) => ({ jobs: [job(company, fetchedAt)], total: 1, unmappedCount: 0 }))
    const service = createCatalogService({
      companies: [companies[0]], now: () => BASE, fetchBoard, onCacheError,
      cache: { load: async () => [], save: async () => { throw new Error('Disk full') } },
    })
    expect((await service.get()).jobs).toHaveLength(1)
    expect((await service.get()).jobs).toHaveLength(1)
    expect(fetchBoard).toHaveBeenCalledTimes(1)
    expect(onCacheError).toHaveBeenCalledTimes(1)
  })
})

describe('request scheduling and retries', () => {
  it('backs off even with no usable cache and retains that limit after restart', async () => {
    const cache = memoryCache()
    const fetchBoard = vi.fn(async () => { throw new BoardFetchError('HTTP 503') })
    const options = { companies, cache, fetchBoard, now: () => BASE, random: () => 0 }
    const service = createCatalogService(options)
    await expect(service.get()).rejects.toBeInstanceOf(CatalogUnavailableError)
    await expect(service.get(true)).rejects.toMatchObject({ retryAt: iso(BASE + 60000), code: 'CATALOG_UNAVAILABLE' })
    await expect(createCatalogService(options).get(true)).rejects.toBeInstanceOf(CatalogUnavailableError)
    expect(fetchBoard).toHaveBeenCalledTimes(2)
  })

  it('uses the 30-minute fresh cache and retries only due failed boards on normal reads', async () => {
    let current = BASE
    const fetchBoard = vi.fn(async (company: Company, fetchedAt: string) => {
      if (company === companies[0]) throw new Error('Network unavailable')
      return { jobs: [job(company, fetchedAt)], total: 1, unmappedCount: 0 }
    })
    const service = createCatalogService({
      companies, cache: memoryCache(companies.map(company => snapshot(company))),
      fetchBoard, now: () => current, random: () => 0,
    })
    await service.get()
    current += CATALOG_POLICY.freshFor - 1
    await service.get()
    expect(fetchBoard).not.toHaveBeenCalled()
    current++
    await service.get()
    expect(fetchBoard).toHaveBeenCalledTimes(2)
    current += CATALOG_POLICY.minRefreshInterval
    await service.get()
    expect(fetchBoard.mock.calls.map(([company]) => company.id)).toEqual([companies[0].id, companies[1].id, companies[0].id])
    expect((await service.get()).boards[0].retryAt).toBe(iso(current + 120000))
  })

  it('honors Retry-After ahead of exponential backoff and caps jittered backoff at 30 minutes', async () => {
    let current = BASE
    let attempts = 0
    const fetchBoard = vi.fn(async () => {
      attempts++
      throw new BoardFetchError('HTTP 429', attempts === 1 ? BASE + 600000 : undefined)
    })
    const service = createCatalogService({
      companies: [companies[0]], cache: memoryCache([snapshot(companies[0], BASE - CATALOG_POLICY.freshFor)]),
      fetchBoard, now: () => current, random: () => 0.5,
    })
    expect((await service.get()).boards[0].retryAt).toBe(iso(BASE + 600000))
    current += 599999
    await service.get(true)
    expect(fetchBoard).toHaveBeenCalledTimes(1)
    current++
    let result = await service.get(true)
    expect(result.boards[0].retryAt).toBe(iso(current + 132000))
    for (let retry = 0; retry < 8; retry++) {
      current = Date.parse(result.boards[0].retryAt!)
      result = await service.get(true)
      expect(Date.parse(result.boards[0].retryAt!) - current).toBeLessThanOrEqual(CATALOG_POLICY.maxBackoff)
    }
  })

  it('deduplicates concurrent callers and fills freed request slots without waiting for a whole batch', async () => {
    const configured = PUBLIC_COMPANIES.slice(0, 6)
    const releases = new Map<string, () => void>()
    let active = 0
    let maximum = 0
    const fetchBoard = vi.fn(async (company: Company, fetchedAt: string) => {
      active++
      maximum = Math.max(maximum, active)
      await new Promise<void>(resolve => releases.set(company.id, resolve))
      active--
      return { jobs: [job(company, fetchedAt)], total: 1, unmappedCount: 0 }
    })
    const cache = memoryCache()
    const service = createCatalogService({ companies: configured, cache, fetchBoard, now: () => BASE })
    const requests = [service.get(), service.get(), service.get(true)]
    await vi.waitFor(() => expect(fetchBoard).toHaveBeenCalledTimes(4))
    releases.get(configured[3].id)!()
    await vi.waitFor(() => expect(fetchBoard).toHaveBeenCalledTimes(5))
    releases.get(configured[4].id)!()
    await vi.waitFor(() => expect(fetchBoard).toHaveBeenCalledTimes(6))
    releases.forEach(release => release())
    for (const result of await Promise.all(requests)) expect(result.jobs).toHaveLength(6)
    expect(maximum).toBe(4)
    expect(cache.load).toHaveBeenCalledTimes(1)
    expect(cache.save).toHaveBeenCalledTimes(1)
  })
})

describe('cache validation and migration', () => {
  it('discards only invalid cache records and never serves a foreign-company or future snapshot', async () => {
    expect(parseCachedBoards({ version: 4, boards: [snapshot(companies[0]), { invalid: true }] })).toHaveLength(1)
    const future = snapshot(companies[1], BASE + 24 * 60 * 60 * 1000)
    const foreign = snapshot(companies[0])
    foreign.snapshot!.jobs[0].companyId = 'not-this-company'
    const fetchBoard = vi.fn(async (company: Company, fetchedAt: string) => ({ jobs: [job(company, fetchedAt, 'verified')], total: 1, unmappedCount: 0 }))
    const result = await createCatalogService({ companies, cache: memoryCache([foreign, future]), fetchBoard, now: () => BASE }).get()
    expect(fetchBoard).toHaveBeenCalledTimes(2)
    expect(result.jobs.every(item => item.id.endsWith('-verified') && item.fetchedAt === iso(BASE))).toBe(true)
  })

  it('retains last successful results when normalized data fails validation', async () => {
    const result = await createCatalogService({
      companies: [companies[0]], cache: memoryCache([snapshot(companies[0])]),
      now: () => BASE + CATALOG_POLICY.freshFor, random: () => 0,
      fetchBoard: async (_company, fetchedAt) => ({ jobs: [job(companies[1], fetchedAt)], total: 1, unmappedCount: 0 }),
    }).get()
    expect(result.jobs[0]).toMatchObject({ companyId: companies[0].id, fetchedAt: iso(BASE), stale: true })
    expect(result.boards[0].status).toBe('error')
  })

  it('atomically persists records, migrates v3 without guessing per-board counts, and avoids reverting a corrupt newer cache', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'orbit-board-cache-test-'))
    const currentFile = path.join(directory, 'current.json')
    const legacyFile = path.join(directory, 'legacy.json')
    const cache = createFileBoardCache(currentFile, legacyFile, companies)
    try {
      const legacy = {
        source: 'greenhouse', fetchedAt: iso(BASE), jobs: [job(companies[0], iso(BASE))],
        boards: [{ companyId: companies[0].id, board: companies[0].board, status: 'ok', total: 2 }],
        unmappedCount: 1,
      }
      await writeFile(legacyFile, JSON.stringify(legacy))
      expect((await cache.load())[0].snapshot).toMatchObject({ unmappedCount: null, fetchedAt: iso(BASE) })
      await cache.save([snapshot(companies[0])])
      expect(JSON.parse(await readFile(currentFile, 'utf8')).version).toBe(4)
      expect((await cache.load())[0].snapshot?.unmappedCount).toBe(1)
      expect((await readdir(directory)).sort()).toEqual(['current.json', 'legacy.json'])
      await writeFile(currentFile, '{invalid-json')
      expect(await cache.load()).toEqual([])
    } finally { await rm(directory, { recursive: true, force: true }) }
  })
})

describe('Greenhouse transport', () => {
  it('reads both supported Retry-After formats and ignores invalid or expired values', () => {
    expect(parseRetryAfter('120', BASE)).toBe(BASE + 120000)
    expect(parseRetryAfter(new Date(BASE + 300000).toUTCString(), BASE)).toBe(BASE + 300000)
    for (const value of [null, '', 'nonsense', '-1', '0', new Date(BASE - 1000).toUTCString()]) expect(parseRetryAfter(value, BASE)).toBeUndefined()
  })

  it('carries provider retry limits through 429 errors and rejects malformed feeds instead of treating them as empty', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(BASE)
    const fetcher = vi.fn()
    vi.stubGlobal('fetch', fetcher)
    fetcher.mockResolvedValueOnce(new Response('', { status: 429, headers: { 'Retry-After': '120' } }))
    await expect(fetchGreenhouseBoard(companies[0], iso(BASE))).rejects.toMatchObject({ message: 'HTTP 429', retryAfter: BASE + 120000 })
    for (const payload of [{ unexpected: [] }, { jobs: [{ id: 1 }] }]) {
      fetcher.mockResolvedValueOnce(Response.json(payload))
      await expect(fetchGreenhouseBoard(companies[0], iso(BASE))).rejects.toBeInstanceOf(BoardFetchError)
    }
    fetcher.mockResolvedValueOnce(Response.json({ jobs: [] }))
    expect(await fetchGreenhouseBoard(companies[0], iso(BASE))).toEqual({ jobs: [], total: 0, unmappedCount: 0 })
  })
})
