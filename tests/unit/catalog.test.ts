import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { PUBLIC_COMPANIES } from '../../shared/companies'
import { createSampleCatalog } from '../../shared/sample'
import { isUnmappedJob, unmappedCoverage } from '../../shared/job-location'
import type { Company, Job, JobProvider } from '../../shared/types'
import { OCCUPATION_VERSION } from '../../shared/types'
import { createFileBoardCache, parseCachedBoards } from '../../server/board-cache'
import type { BoardCache, CachedBoard } from '../../server/board-cache'
import { BoardFetchError, CATALOG_POLICY, CatalogUnavailableError, createCatalogService, parseRetryAfter } from '../../server/catalog-service'
import { fetchGreenhouseBoard } from '../../server/catalog'

const BASE = Date.parse('2026-09-19T06:00:00.000Z')
const companies = PUBLIC_COMPANIES.slice(0, 2)
const demoJob = createSampleCatalog().jobs[0]
const iso = (value: number) => new Date(value).toISOString()
const job = (company: Company, fetchedAt: string, suffix = 'one'): Job & { source: JobProvider } => ({
  ...demoJob, id: `${company.provider ?? 'greenhouse'}-${company.id}-${suffix}`, companyId: company.id, source: company.provider ?? 'greenhouse', fetchedAt, compensationVersion: 1,
  qualifications: { version: 1, skills: [], experience: [] },
})
const snapshot = (company: Company, time = BASE): CachedBoard => ({
  companyId: company.id, board: company.board!, provider: company.provider ?? 'greenhouse', boardRegion: company.boardRegion, checkedAt: iso(time), failures: 0, retryAt: null,
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
  it('serves an entirely unmapped feed, persists its content and includes it in posting comparisons', async () => {
    let current = BASE
    const directory = await mkdtemp(path.join(tmpdir(), 'orbit-unmapped-cache-test-'))
    const cache = createFileBoardCache(path.join(directory, 'v5.json'), undefined, [companies[0]])
    const fetchBoard = vi.fn(async (company: Company, fetchedAt: string) => ({
      jobs: [{ ...job(company, fetchedAt, 'outside'), cityIds: [], workMode: 'unknown' as const, locationLabel: 'Gurugram' }],
      total: 1, unmappedCount: 1, publishedIds: [`greenhouse-${company.id}-outside`],
    }))
    const options = { companies: [companies[0]], cache, now: () => current, random: () => 0, fetchBoard }
    try {
      const result = await createCatalogService(options).get()
      expect(result.boards[0]).toMatchObject({ status: 'ok', total: 1, included: 1 })
      expect(result.jobs).toHaveLength(1)
      expect(isUnmappedJob(result.jobs[0])).toBe(true)
      expect(unmappedCoverage(result)).toEqual({ available: 1, unavailable: 0 })
      expect((await cache.load())[0].snapshot).toMatchObject({ total: 1, unmappedCount: 1, jobs: [{ locationLabel: 'Gurugram' }] })
      const restarted = createCatalogService(options)
      const index = await restarted.getPostingStatus()
      expect(index.boards[0].listing?.jobs).toEqual([expect.objectContaining({ id: result.jobs[0].id, revision: expect.any(Object) })])
      expect(fetchBoard).toHaveBeenCalledOnce()
      current += CATALOG_POLICY.freshFor
      fetchBoard.mockRejectedValue(new BoardFetchError('HTTP 503'))
      expect((await restarted.get()).jobs[0]).toMatchObject({ fetchedAt: iso(BASE), stale: true, cityIds: [], locationLabel: 'Gurugram' })
      current = BASE + CATALOG_POLICY.maxFallbackAge + 1
      await expect(restarted.get()).rejects.toMatchObject({ code: 'CATALOG_EXPIRED' })
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('keeps old omitted counts honest until a scheduled or allowed refresh retrieves the contents', async () => {
    let current = BASE + 1000
    const cached = snapshot(companies[0])
    const fetchBoard = vi.fn(async (company: Company, fetchedAt: string) => ({
      jobs: [job(company, fetchedAt), { ...job(company, fetchedAt, 'outside'), cityIds: [], workMode: 'onsite' as const }],
      total: 2, unmappedCount: 1,
    }))
    const service = createCatalogService({ companies: [companies[0]], cache: memoryCache([cached]), now: () => current, fetchBoard })
    const old = await service.get()
    expect(unmappedCoverage(old)).toEqual({ available: 0, unavailable: 1 })
    expect(old.fetchedAt).toBe(iso(BASE))
    expect(fetchBoard).not.toHaveBeenCalled()
    current = BASE + CATALOG_POLICY.minRefreshInterval
    const refreshed = await service.get(true)
    expect(fetchBoard).toHaveBeenCalledOnce()
    expect(refreshed.jobs).toHaveLength(2)
    expect(unmappedCoverage(refreshed)).toEqual({ available: 1, unavailable: 0 })
  })

  it('rejects impossible unmapped totals while accepting both retained and legacy omitted records', () => {
    const previous = snapshot(companies[0])
    expect(parseCachedBoards({ version: 5, boards: [previous] })).toHaveLength(1)
    const unmapped = { ...previous.snapshot!.jobs[0], cityIds: [], workMode: 'onsite' as const }
    const entry = { ...previous, snapshot: { ...previous.snapshot!, jobs: [unmapped], total: 1 } }
    expect(parseCachedBoards({ version: 5, boards: [entry] })).toHaveLength(1)
    for (const unmappedCount of [0, 2]) {
      expect(parseCachedBoards({ version: 5, boards: [{ ...entry, snapshot: { ...entry.snapshot, unmappedCount } }] })).toEqual([])
    }
  })

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
      expect.objectContaining({ id: `greenhouse-${companies[0].id}-one`, fetchedAt: iso(BASE), stale: true }),
      expect.objectContaining({ id: `greenhouse-${companies[1].id}-new`, fetchedAt: iso(current), stale: false }),
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
  it('rechecks old qualification facts while retaining the original board snapshot and retry state', () => {
    const cached = snapshot(companies[0])
    const previous = cached.snapshot!.jobs[0]
    delete previous.qualifications
    previous.description = 'Minimum requirements\n3 years of software engineering experience with Python.\nPreferred qualifications\n5 years of software engineering experience with Rust.'
    previous.minExperience = 5
    previous.skills = ['Python', 'Rust', 'Figma']
    cached.failures = 2
    cached.retryAt = iso(BASE + 120000)
    const [migrated] = parseCachedBoards({ version: 5, boards: [cached] })
    expect(migrated).toMatchObject({ checkedAt: cached.checkedAt, failures: 2, retryAt: cached.retryAt })
    expect(migrated.snapshot!.jobs[0]).toMatchObject({ minExperience: 3, skills: ['Python', 'Rust'], fetchedAt: iso(BASE), id: previous.id })
    expect(migrated.snapshot!.fetchedAt).toBe(iso(BASE))
  })

  it('rechecks legacy pay without changing the age of a retained snapshot during an outage', async () => {
    const cached = snapshot(companies[0])
    const prior = cached.snapshot!.jobs[0]
    delete prior.compensationVersion
    prior.description = 'For Portugal based hires: Annual base salary EUR 54000–91000.\nFor United States based hires: Annual base salary USD 136000–187000.'
    prior.salary = { min: 54000, max: 91000, currency: 'EUR' }
    const migrated = parseCachedBoards({ version: 5, boards: [cached] })
    expect(migrated[0].snapshot!.jobs[0]).toMatchObject({ salary: null, compensationVersion: 1, fetchedAt: iso(BASE) })
    expect(migrated[0].snapshot!.jobs[0].compensationRanges).toHaveLength(2)
    const result = await createCatalogService({
      companies: [companies[0]], cache: memoryCache(migrated), now: () => BASE + CATALOG_POLICY.freshFor, random: () => 0,
      fetchBoard: async () => { throw new BoardFetchError('HTTP 503') },
    }).get()
    expect(result.jobs[0]).toMatchObject({ id: prior.id, salary: null, stale: true, fetchedAt: iso(BASE) })
    expect(result.boards[0]).toMatchObject({ status: 'error', lastSuccessAt: iso(BASE) })
  })

  it('keeps a fresh v4 Greenhouse snapshot when migrating to a provider-aware cache', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'orbit-v4-migration-test-'))
    const currentFile = path.join(directory, 'v5.json')
    const previousFile = path.join(directory, 'v4.json')
    try {
      const { provider: _provider, boardRegion: _region, ...previous } = snapshot(companies[0])
      await writeFile(previousFile, JSON.stringify({ version: 4, boards: [previous] }))
      const cache = createFileBoardCache(currentFile, [previousFile, path.join(directory, 'v3.json')], companies)
      const loaded = await cache.load()
      expect(loaded[0]).toMatchObject({ provider: 'greenhouse', snapshot: { jobs: [{ id: previous.snapshot!.jobs[0].id }], unmappedCount: 1 } })
      const fetchBoard = vi.fn(async () => ({ jobs: [], total: 0, unmappedCount: 0 }))
      const service = createCatalogService({ companies: [companies[0]], cache, fetchBoard, now: () => BASE + 1000 })
      const result = await service.get()
      expect(result).toMatchObject({ source: 'public', jobs: [{ source: 'greenhouse', fetchedAt: iso(BASE) }] })
      expect(fetchBoard).not.toHaveBeenCalled()
      await cache.save(loaded)
      expect(JSON.parse(await readFile(currentFile, 'utf8')).version).toBe(5)
      expect((await cache.load())[0].snapshot).toEqual({
        ...previous.snapshot,
        jobs: previous.snapshot!.jobs.map(job => ({
          ...job, visa: 'unknown', eligibility: { version: 1, rules: [] }, evidence: {},
          roleClassification: { version: 1, roles: ['backend'], evidence: [{ role: 'backend', source: 'title', text: job.title }] },
          occupation: { version: OCCUPATION_VERSION, category: 'engineering', departments: [], evidence: [{ source: 'title', text: job.title }] },
        })),
      })
      await rm(currentFile)
      await writeFile(previousFile, '{invalid-json')
      await writeFile(path.join(directory, 'v3.json'), JSON.stringify({
        source: 'greenhouse', fetchedAt: iso(BASE), jobs: previous.snapshot!.jobs,
        boards: [{ companyId: companies[0].id, board: companies[0].board, status: 'ok', total: 2 }],
      }))
      expect(await cache.load()).toEqual([])
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('does not reuse a snapshot after the provider, board name or Lever region changes', async () => {
    const original = companies[0]
    const lever = { ...original, provider: 'lever' as const }
    const cases: [Company, Company][] = [
      [original, { ...original, provider: 'ashby' }],
      [original, { ...original, board: 'new-board' }],
      [lever, { ...lever, boardRegion: 'eu' }],
    ]
    for (const [before, after] of cases) {
      const fetchBoard = vi.fn(async (company: Company, fetchedAt: string) => ({ jobs: [job(company, fetchedAt, 'new-source')], total: 1, unmappedCount: 0 }))
      const result = await createCatalogService({
        companies: [after], cache: memoryCache([snapshot(before)]), fetchBoard, now: () => BASE + 1000,
      }).get()
      expect(fetchBoard).toHaveBeenCalledOnce()
      expect(result.jobs).toEqual([expect.objectContaining({ id: `${after.provider}-${after.id}-new-source`, source: after.provider })])
      expect(result.boards[0].provider).toBe(after.provider)
    }
  })

  it('rejects mismatched source and native ID prefixes in both restored and newly collected jobs', async () => {
    const company = PUBLIC_COMPANIES.find(item => item.provider === 'ashby')!
    const invalidJobs = [
      { ...job(company, iso(BASE)), source: 'lever' as const },
      { ...job(company, iso(BASE)), id: `lever-${company.id}-one` },
    ]
    for (const invalid of invalidJobs) {
      const saved = snapshot(company)
      saved.snapshot!.jobs = [invalid]
      const fetchBoard = vi.fn(async (_company: Company, fetchedAt: string) => ({ jobs: [job(company, fetchedAt, 'verified')], total: 1, unmappedCount: 0 }))
      const restored = await createCatalogService({ companies: [company], cache: memoryCache([saved]), fetchBoard, now: () => BASE }).get()
      expect(restored.jobs[0].id).toBe(`ashby-${company.id}-verified`)
      expect(fetchBoard).toHaveBeenCalledOnce()
      const retained = await createCatalogService({
        companies: [company], cache: memoryCache([snapshot(company)]), now: () => BASE + CATALOG_POLICY.freshFor, random: () => 0,
        fetchBoard: async (_company, fetchedAt) => ({ jobs: [{ ...invalid, fetchedAt }], total: 1, unmappedCount: 0 }),
      }).get()
      expect(retained.jobs[0]).toMatchObject({ id: `ashby-${company.id}-one`, source: 'ashby', fetchedAt: iso(BASE), stale: true })
      expect(retained.boards[0].status).toBe('error')
    }
  })

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
      expect(JSON.parse(await readFile(currentFile, 'utf8')).version).toBe(5)
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
    expect(fetcher.mock.calls[0][0]).toContain('content=true&pay_transparency=true')
    for (const payload of [{ unexpected: [] }, { jobs: [{ id: 1 }] }]) {
      fetcher.mockResolvedValueOnce(Response.json(payload))
      await expect(fetchGreenhouseBoard(companies[0], iso(BASE))).rejects.toBeInstanceOf(BoardFetchError)
    }
    fetcher.mockResolvedValueOnce(Response.json({ jobs: [] }))
    expect(await fetchGreenhouseBoard(companies[0], iso(BASE))).toEqual({ jobs: [], total: 0, unmappedCount: 0, publishedIds: [] })
  })
})
