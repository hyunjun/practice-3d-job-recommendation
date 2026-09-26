import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { Catalog, Company, Job, JobProvider } from '../../shared/types'
import { ageCatalog, catalogNeedsRevalidation, jobFreshness } from '../../shared/catalog-freshness'
import { PostingStatusIndexSchema } from '../../shared/posting-status'
import { createSampleCatalog } from '../../shared/sample'
import { createFileBoardCache } from '../../server/board-cache'
import type { CachedBoard } from '../../server/board-cache'
import { loadBoardConfiguration } from '../../server/board-config'
import { BoardFetchError, createCatalogService } from '../../server/catalog-service'
import { createFilePresenceCache, presenceCacheFile } from '../../server/posting-presence'
import { createFileObservationCache, createObservationStore, observationCacheFile } from '../../server/catalog-observations'
import { ADDED_PUBLIC_REGISTRATIONS, EXPANDED_PUBLIC_REGISTRATIONS, ORIGINAL_PUBLIC_REGISTRATIONS } from '../fixtures/public-coverage'
import { SURVEY_REGISTRATIONS } from '../fixtures/public-company-survey'
import {
  HIMALAYAS_BODY, HIMALAYAS_CHANGED_BODY, HIMALAYAS_CHANGED_TITLE, INTEGRATION_JOBS,
  INTEGRATION_NOW, INTEGRATION_REGISTRATIONS, MICROSOFT_PUBLISHED_IDS, WORKABLE_CAREER_URLS, integrationCompany,
} from '../fixtures/source-integration-contract'
import { integrationOld83Cache } from '../fixtures/source-integrations'

// Literal externally visible deadlines, never product constants.
const method = 'observations-1.occupation-5.roles-1.qualifications-1.remote-2.employment-1.purpose-1'
const directories: string[] = []
let now: number
beforeEach(() => {
  now = Date.parse(INTEGRATION_NOW)
  vi.spyOn(Date, 'now').mockImplementation(() => now)
  vi.stubEnv('ORBIT_BOARDS_FILE', undefined)
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('Lifecycle fixture must never perform external HTTP') }))
})
afterEach(async () => {
  expect(vi.mocked(fetch)).not.toHaveBeenCalled()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

async function directory() {
  const value = await mkdtemp(path.join(tmpdir(), 'orbit-source63-'))
  directories.push(value)
  return value
}

function lifecycleJob(companyId: string, fetchedAt = INTEGRATION_NOW, changed = false): Job & { source: JobProvider } {
  const literal = INTEGRATION_JOBS.find(job => job.companyId === companyId)!
  return {
    ...literal, cityIds: [...literal.cityIds],
    remoteCountries: 'remoteCountries' in literal ? [...literal.remoteCountries] : [],
    remoteWorldwide: 'remoteWorldwide' in literal ? literal.remoteWorldwide : false,
    remoteScopeUnknown: 'remoteScopeUnknown' in literal ? literal.remoteScopeUnknown : false,
    employment: 'fulltime', minExperience: 3, skills: ['TypeScript', 'PostgreSQL'],
    salary: null, visa: 'unknown', requirements: [], updatedAt: null, fetchedAt,
    description: changed ? HIMALAYAS_CHANGED_BODY : HIMALAYAS_BODY,
    ...(changed ? { title: HIMALAYAS_CHANGED_TITLE } : {}),
  }
}

const old83Companies: Company[] = [
  ...ORIGINAL_PUBLIC_REGISTRATIONS, ...ADDED_PUBLIC_REGISTRATIONS,
  ...EXPANDED_PUBLIC_REGISTRATIONS, ...SURVEY_REGISTRATIONS,
].map(company => ({
  initials: '63', color: '#83d1c7', industry: 'Synthetic legacy company',
  ...company,
}))

async function lifecycle(companies = [integrationCompany('microsoft'), integrationCompany('smartnews')]) {
  const cwd = await directory()
  const cacheFile = path.join(cwd, 'fixture-board-cache.json')
  const fullCalls: { companyId: string; at: string }[] = []
  const listCalls: { companyId: string; at: string }[] = []
  const failures = new Map<string, Error>()
  let changed = false
  const files = {
    full: cacheFile, presence: presenceCacheFile(cacheFile), observations: observationCacheFile(cacheFile),
  }
  function service() {
    return createCatalogService({
      companies,
      cache: createFileBoardCache(files.full, [], companies),
      fetchBoard: async (company, at) => {
        fullCalls.push({ companyId: company.id, at })
        const failure = failures.get(company.id)
        if (failure) throw failure
        const job = lifecycleJob(company.id, at, company.id === 'microsoft' && changed)
        return {
          jobs: [job], total: company.id === 'microsoft' ? 2 : 1,
          unmappedCount: company.id === 'smartnews' ? 1 : 0,
          publishedIds: company.id === 'microsoft' ? [...MICROSOFT_PUBLISHED_IDS] : [job.id],
        }
      },
      presence: {
        cache: createFilePresenceCache(files.presence),
        fetchBoard: async (company, at) => {
          listCalls.push({ companyId: company.id, at })
          const failure = failures.get(`presence:${company.id}`)
          if (failure) throw failure
          return company.id === 'microsoft'
            ? { total: 2, publishedIds: [...MICROSOFT_PUBLISHED_IDS] }
            : { total: 1, publishedIds: [lifecycleJob(company.id, at).id] }
        },
      },
      observations: createObservationStore({
        companies, cache: createFileObservationCache(files.observations), now: () => now, method,
      }),
      now: () => now, random: () => 0,
    })
  }
  return { cwd, files, companies, fullCalls, listCalls, failures, service, change: () => { changed = true } }
}

describe('daily source registration, cache and visible age', () => {
  it('adds exactly the approved ten defaults after the unchanged old36 and approved47, leaving samples32/179/22', async () => {
    const cwd = await directory()
    const configuration = await loadBoardConfiguration({ cwd })
    const identity = ({ id, name, board, provider }: Company) => ({ id, name, board, provider })
    expect(configuration.companies).toHaveLength(93)
    expect(configuration.companies.slice(0, 36).map(identity)).toEqual(old83Companies.slice(0, 36).map(identity))
    expect(configuration.companies.slice(36, 83).map(({ id, name, board, provider, careerUrl }) =>
      ({ id, name, board, provider, careerUrl }))).toEqual(SURVEY_REGISTRATIONS)
    expect(configuration.companies.slice(83).map(identity).sort((a, b) => a.id.localeCompare(b.id)))
      .toEqual([...INTEGRATION_REGISTRATIONS].sort((a, b) => a.id.localeCompare(b.id)))
    for (const [provider, count] of [
      ['greenhouse', 50], ['ashby', 24], ['lever', 4], ['smartrecruiters', 5], ['himalayas', 7], ['workable', 3],
    ] as const) expect(configuration.companies.filter(company => company.provider === provider)).toHaveLength(count)
    for (const excluded of ['nvidia', 'netflix', 'oracle', 'dell', 'workday', 'hubspot', 'amd', 'atlassian'])
      expect(configuration.companies.some(company => company.id === excluded)).toBe(false)
    for (const [id, url] of Object.entries(WORKABLE_CAREER_URLS))
      expect(configuration.companies.find(company => company.id === id)!.careerUrl).toBe(url)
    const sample = createSampleCatalog()
    expect([sample.companies.length, sample.jobs.length, sample.cities.length]).toEqual([32, 179, 22])
  })

  it('collects only the ten missing companies from an old83 cache and keeps old clocks and records on disk', async () => {
    const state = await lifecycle([...old83Companies, ...INTEGRATION_REGISTRATIONS.map(company => integrationCompany(company.id))])
    const old83 = integrationOld83Cache()
    expect(old83.boards).toHaveLength(83)
    await writeFile(state.files.full, JSON.stringify(old83))
    const current = state.service()
    const catalog = await current.get()
    expect(catalog.companies).toHaveLength(93)
    expect(catalog.jobs).toHaveLength(12)
    expect(state.fullCalls.map(call => call.companyId).sort()).toEqual([
      'adobe', 'broadcom', 'cisco', 'hugging-face', 'mercari', 'microsoft', 'qualcomm', 'redhat', 'salesforce', 'smartnews',
    ])
    const after = JSON.parse(await readFile(state.files.full, 'utf8'))
    expect(after.boards).toHaveLength(93)
    for (const previous of old83.boards) {
      const retained = after.boards.find((entry: { companyId: string }) => entry.companyId === previous.companyId)
      expect(retained).toMatchObject({
        checkedAt: '2026-10-01T23:39:55.000Z',
        snapshot: { fetchedAt: '2026-10-01T23:39:55.000Z', total: previous.snapshot.total },
      })
      expect(retained.snapshot.jobs.map((job: Job) => [job.id, job.url, job.fetchedAt]))
        .toEqual(previous.snapshot.jobs.map(job => [job.id, job.url, job.fetchedAt]))
      if (!previous.snapshot.jobs.length) expect(retained).toEqual(previous)
    }
    const bytes = await readFile(state.files.full, 'utf8')
    expect((await state.service().get()).jobs).toEqual(catalog.jobs)
    expect(await readFile(state.files.full, 'utf8')).toBe(bytes)
    expect(state.fullCalls).toHaveLength(10)
    expect(state.listCalls).toEqual([])
  })

  it('seeds presence, coalesces full requests, permits Workable after one minute and Himalayas only after24h', async () => {
    const state = await lifecycle()
    const service = state.service()
    await Promise.all([service.get(), service.get(), service.getPostingStatus(true, true)])
    expect(state.fullCalls.map(call => call.companyId)).toEqual(['microsoft', 'smartnews'])
    await service.getPostingStatus(true)
    expect(state.listCalls).toEqual([])
    now = Date.parse('2026-10-01T23:41:00.000Z')
    await service.get(true)
    expect(state.fullCalls.map(call => call.companyId)).toEqual(['microsoft', 'smartnews', 'smartnews'])
    now = Date.parse('2026-10-02T23:39:59.000Z')
    const before = await service.get()
    expect(before.jobs.find(job => job.companyId === 'microsoft')!.fetchedAt).toBe('2026-10-01T23:40:00.000Z')
    expect(before.boards.find(board => board.companyId === 'microsoft')!.dataStatus).toBe('fresh')
    expect(state.fullCalls.filter(call => call.companyId === 'microsoft')).toHaveLength(1)
    now = Date.parse('2026-10-02T23:40:00.000Z')
    const [, index] = await Promise.all([service.get(true), service.getPostingStatus(true, true)])
    expect(state.fullCalls.filter(call => call.companyId === 'microsoft')).toEqual([
      { companyId: 'microsoft', at: '2026-10-01T23:40:00.000Z' },
      { companyId: 'microsoft', at: '2026-10-02T23:40:00.000Z' },
    ])
    expect(index.boards.find(board => board.companyId === 'microsoft')!.listing).toMatchObject({
      validUntil: '2026-10-03T23:40:00.000Z',
      content: { checkedAt: '2026-10-02T23:40:00.000Z', validUntil: '2026-10-03T23:40:00.000Z' },
    })
    const calls = structuredClone(state.fullCalls)
    expect((await state.service().getPostingStatus(true, true)).boards).toEqual(index.boards)
    expect(state.fullCalls).toEqual(calls)
    expect(state.listCalls).toEqual([])
  })

  it('lets a newly checked list coexist with expired body evidence and then refreshes the due body without a list-clock bypass', async () => {
    const state = await lifecycle()
    const service = state.service()
    await service.get()
    const originalBytes = await readFile(state.files.full, 'utf8')
    state.change()
    now = Date.parse('2026-10-02T23:40:00.000Z')
    const listed = await service.getPostingStatus(true)
    expect(state.listCalls.map(call => call.companyId)).toEqual(['microsoft', 'smartnews'])
    expect(listed.boards.find(board => board.companyId === 'microsoft')!.listing).toMatchObject({
      validUntil: '2026-10-03T23:40:00.000Z', publishedIds: MICROSOFT_PUBLISHED_IDS, jobs: [],
      content: { checkedAt: '2026-10-01T23:40:00.000Z', validUntil: '2026-10-02T23:40:00.000Z' },
    })
    expect(await readFile(state.files.full, 'utf8')).toBe(originalBytes)
    now = Date.parse('2026-10-02T23:40:00.001Z')
    const [first, second] = await Promise.all([service.getPostingStatus(true, true), service.getPostingStatus(true, true)])
    expect(second).toEqual(first)
    expect(first.boards.find(board => board.companyId === 'microsoft')!.listing!.jobs[0]).toMatchObject({
      id: 'himalayas-microsoft-70eecd3ec601cdc5f4ecb1750bf585e529f95296f170a59abec71bc88be82cdf',
      title: 'Backend Engineer — Synthetic Cedar API63 Revised',
      url: 'https://himalayas.app/companies/microsoft/jobs/synthetic-cedar-api63',
    })
    expect(state.fullCalls).toHaveLength(4)
    expect(state.listCalls).toHaveLength(2)
    expect((await state.service().getPostingStatus(true)).boards).toEqual(first.boards)
    expect(state.fullCalls).toHaveLength(4)
    expect(state.listCalls).toHaveLength(2)
  })

  it('persists one-minute, exponential and Retry-After failures instead of applying a successful24h cooldown to errors', async () => {
    const state = await lifecycle()
    state.failures.set('microsoft', new BoardFetchError('Synthetic Himalayas failure63'))
    let service = state.service()
    const first = await service.get()
    expect(first.jobs.map(job => job.companyId)).toEqual(['smartnews'])
    expect(first.boards.find(board => board.companyId === 'microsoft')).toMatchObject({
      status: 'error', dataStatus: 'unavailable', lastSuccessAt: null, retryAt: '2026-10-01T23:41:00.000Z',
    })
    now = Date.parse('2026-10-01T23:40:59.999Z')
    await service.get(true)
    expect(state.fullCalls).toHaveLength(2)
    now = Date.parse('2026-10-01T23:41:00.000Z')
    expect((await service.get()).boards.find(board => board.companyId === 'microsoft')!.retryAt)
      .toBe('2026-10-01T23:43:00.000Z')
    service = state.service()
    now = Date.parse('2026-10-01T23:42:59.999Z')
    await service.get()
    expect(state.fullCalls).toHaveLength(3)
    state.failures.set('microsoft', new BoardFetchError('Synthetic Retry-After63', Date.parse('2026-10-01T23:50:00.000Z')))
    now = Date.parse('2026-10-01T23:43:00.000Z')
    expect((await service.get()).boards.find(board => board.companyId === 'microsoft')!.retryAt)
      .toBe('2026-10-01T23:50:00.000Z')
    const failedBytes = await readFile(state.files.full, 'utf8')
    now = Date.parse('2026-10-01T23:49:59.999Z')
    await state.service().get()
    expect(await readFile(state.files.full, 'utf8')).toBe(failedBytes)
    expect(state.fullCalls).toHaveLength(4)
    state.failures.delete('microsoft')
    now = Date.parse('2026-10-01T23:50:00.000Z')
    expect((await service.get()).jobs.map(job => job.companyId)).toEqual(['microsoft', 'smartnews'])
    expect(state.fullCalls).toHaveLength(5)
  })

  it('retains a failed snapshot exactly at24h but removes it at24h+1ms without extending fallback on restart', async () => {
    const state = await lifecycle()
    const service = state.service()
    await service.get()
    state.failures.set('microsoft', new BoardFetchError('Synthetic failed daily update63'))
    now = Date.parse('2026-10-02T23:40:00.000Z')
    const edge = await service.get()
    expect(edge.jobs.find(job => job.companyId === 'microsoft')).toMatchObject({
      fetchedAt: '2026-10-01T23:40:00.000Z', stale: true,
    })
    expect(edge.boards.find(board => board.companyId === 'microsoft')).toMatchObject({
      status: 'error', dataStatus: 'stale', total: 2, included: 1, lastSuccessAt: '2026-10-01T23:40:00.000Z',
    })
    now = Date.parse('2026-10-02T23:40:00.001Z')
    const expired = await state.service().get()
    expect(expired.jobs.map(job => job.companyId)).toEqual(['smartnews'])
    expect(expired.boards.find(board => board.companyId === 'microsoft')).toMatchObject({
      status: 'error', dataStatus: 'unavailable', lastSuccessAt: '2026-10-01T23:40:00.000Z',
    })
    const persisted = JSON.parse(await readFile(state.files.full, 'utf8'))
    expect(persisted.boards.find((board: { companyId: string }) => board.companyId === 'microsoft').snapshot.fetchedAt)
      .toBe('2026-10-01T23:40:00.000Z')
    expect(state.fullCalls).toHaveLength(4)
  })

  it('ages the browser/catalog view at literal23:59:59,24:00:00 and24:00:00.001 independently of collector constants', () => {
    const job = lifecycleJob('microsoft')
    const catalog: Catalog = {
      source: 'public', fetchedAt: INTEGRATION_NOW, stale: false, companies: [integrationCompany('microsoft')],
      cities: [], jobs: [job], unmappedCount: 0,
      boards: [{ companyId: 'microsoft', provider: 'himalayas', board: 'microsoft', status: 'ok',
        total: 2, included: 1, checkedAt: INTEGRATION_NOW, lastSuccessAt: INTEGRATION_NOW, dataStatus: 'fresh' }],
    }
    expect(jobFreshness(job, Date.parse('2026-10-02T23:39:59.000Z'))).toBe('fresh')
    expect(jobFreshness(job, Date.parse('2026-10-02T23:40:00.000Z'))).toBe('stale')
    expect(jobFreshness(job, Date.parse('2026-10-02T23:40:00.001Z'))).toBe('expired')
    expect(catalogNeedsRevalidation(catalog, Date.parse('2026-10-02T23:39:59.000Z'))).toBe(false)
    expect(catalogNeedsRevalidation(catalog, Date.parse('2026-10-02T23:40:00.000Z'))).toBe(true)
    // A generic catalog timer may wake at30m; only visible age and whether a
    // provider read is due are contractual. Preserve the exact24h boundaries.
    expect(ageCatalog(catalog, Date.parse('2026-10-02T00:10:00.000Z')).catalog).toEqual(catalog)
    expect(catalogNeedsRevalidation(catalog, Date.parse('2026-10-02T00:10:00.000Z'))).toBe(false)
    expect(ageCatalog(catalog, Date.parse('2026-10-02T23:40:00.000Z')).catalog.jobs).toHaveLength(1)
    expect(ageCatalog(catalog, Date.parse('2026-10-02T23:40:00.001Z')).catalog.jobs).toEqual([])
    expect(catalog.jobs[0].fetchedAt).toBe('2026-10-01T23:40:00.000Z')
    expect(jobFreshness(lifecycleJob('smartnews'), Date.parse('2026-10-02T00:09:59.999Z'))).toBe('fresh')
    expect(jobFreshness(lifecycleJob('smartnews'), Date.parse('2026-10-02T00:10:00.000Z'))).toBe('stale')
  })
})

describe('provider-aware posting bounds and unchanged observation comparison', () => {
  it.each([
    ['microsoft', '2026-10-02T23:40:00.000Z', '2026-10-02T23:40:00.001Z'],
    ['smartnews', '2026-10-02T00:10:00.000Z', '2026-10-02T00:10:00.001Z'],
  ])('validates listing and body deadlines separately for %s', (id, validUntil, invalidUntil) => {
    const company = integrationCompany(id)
    const input = {
      version: 2, checkedAt: INTEGRATION_NOW, refreshAfter: validUntil, contentRefreshAfter: validUntil,
      boards: [{
        companyId: company.id, provider: company.provider, board: company.board,
        checkedAt: INTEGRATION_NOW, lastSuccessAt: INTEGRATION_NOW, status: 'ok', retryAt: null,
        listing: { validUntil, publishedIds: [], jobs: [],
          content: { checkedAt: INTEGRATION_NOW, validUntil, status: 'ok', jobIds: [] } },
      }],
    }
    expect(PostingStatusIndexSchema.safeParse(input).success).toBe(true)
    const invalidList = structuredClone(input)
    invalidList.boards[0].listing.validUntil = invalidUntil
    expect(PostingStatusIndexSchema.safeParse(invalidList).success).toBe(false)
    const invalidBody = structuredClone(input)
    invalidBody.boards[0].listing.content.validUntil = invalidUntil
    expect(PostingStatusIndexSchema.safeParse(invalidBody).success).toBe(false)
  })

  it.each([
    ['2026-10-02T00:09:59.999Z', true],
    ['2026-10-02T00:10:00.000Z', false],
    ['2026-10-02T00:11:00.000Z', false],
  ] as const)('compares a daily-source cohort at %s only inside the original30m collection window', async (at, complete) => {
    const state = await lifecycle()
    now = Date.parse(at)
    const snapshot = (id: string, fetchedAt: string): CachedBoard => {
      const company = integrationCompany(id)
      const job = lifecycleJob(id, fetchedAt)
      return {
        companyId: id, board: company.board!, provider: company.provider!,
        checkedAt: fetchedAt, failures: 0, retryAt: null,
        snapshot: { fetchedAt, jobs: [job], total: 1, unmappedCount: id === 'smartnews' ? 1 : 0,
          publishedIds: [job.id], observationMethod: method },
      }
    }
    const store = createObservationStore({
      companies: state.companies, cache: createFileObservationCache(state.files.observations), now: () => now, method,
    })
    await store.record([snapshot('microsoft', INTEGRATION_NOW), snapshot('smartnews', at)], 'collection')
    const history = await store.read()
    expect(history.days).toHaveLength(1)
    expect(history.days[0].day).toBe('2026-10-02')
    expect(Boolean(history.days[0].complete)).toBe(complete)
    if (complete) expect(history.days[0].complete).toMatchObject({
      comparable: true, stats: { published: 2, technical: 2, openings: 2, talentPools: 0 },
    })
    else expect(history.days[0].latest.boards.find(board => board.companyId === 'microsoft')!.status).toBe('stale')
    expect(jobFreshness(lifecycleJob('microsoft'), now)).toBe('fresh')
  })

  it('retains an old83 observation as another cohort even when both cohorts have the same finance-v5 method', async () => {
    const cwd = await directory()
    const file = path.join(cwd, 'observations.json')
    const seed = integrationOld83Cache()
    const entries = seed.boards.map(board => ({
      ...board, snapshot: { ...board.snapshot, observationMethod: method },
    })) as CachedBoard[]
    const old = createObservationStore({
      companies: old83Companies, cache: createFileObservationCache(file), now: () => now, method,
    })
    await old.record(entries, 'collection')
    const before = await old.read()
    expect(before.scope.boards).toHaveLength(83)
    expect(before.days[0].complete).toMatchObject({
      comparable: true, stats: { published: 2, technical: 2, openings: 2, talentPools: 0 },
    })
    const bytes = await readFile(file, 'utf8')
    const current = createObservationStore({
      companies: [...old83Companies, ...INTEGRATION_REGISTRATIONS.map(company => integrationCompany(company.id))],
      cache: createFileObservationCache(file), now: () => now, method,
    })
    const history = await current.read()
    expect(history.scope.boards).toHaveLength(93)
    expect(history.days).toEqual([])
    expect(history.otherSeries).toEqual([{
      scopeKey: before.scope.key, method, companyCount: 83, firstDay: '2026-10-01', lastDay: '2026-10-01',
    }])
    expect(await readFile(file, 'utf8')).toBe(bytes)
  })
})
