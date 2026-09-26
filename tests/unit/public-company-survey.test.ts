import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createFileBoardCache } from '../../server/board-cache'
import { loadBoardConfiguration } from '../../server/board-config'
import { createCatalogService } from '../../server/catalog-service'
import { createFileObservationCache, createObservationStore, observationCacheFile } from '../../server/catalog-observations'
import { createFilePresenceCache, presenceCacheFile } from '../../server/posting-presence'
import { fetchGreenhouseBoard, fetchGreenhousePresence } from '../../server/providers/greenhouse'
import { fetchAshbyBoard, fetchAshbyPresence } from '../../server/providers/ashby'
import { fetchLeverBoard, fetchLeverPresence } from '../../server/providers/lever'
import { createSmartRecruitersFetcher } from '../../server/providers/smartrecruiters'
import { expansionLegacy36Cache, expansionResponses } from '../fixtures/public-company-expansion'
import {
  SURVEY_DETAIL_URLS, SURVEY_FULL_URLS, SURVEY_JOBS, SURVEY_NOW, SURVEY_OLD_SCOPE_KEY,
  SURVEY_REGISTRATIONS, SURVEY_SERVICE_CHANGED_BODY, SURVEY_SERVICE_CHANGED_TITLE,
  surveyOldHistory, surveyResponses,
} from '../fixtures/public-company-survey'
import { asCoverageReply } from '../fixtures/public-coverage-transport'

const directories: string[] = []
let now: number
beforeEach(() => {
  now = Date.parse(SURVEY_NOW)
  vi.spyOn(Date, 'now').mockImplementation(() => now)
  vi.stubEnv('ORBIT_BOARDS_FILE', undefined)
})
afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

async function fixture(options: { old36?: boolean; history?: boolean; failures?: boolean } = {}) {
  const cwd = await mkdtemp(path.join(tmpdir(), 'orbit-survey61-'))
  directories.push(cwd)
  const config = await loadBoardConfiguration({ cwd })
  await mkdir(path.dirname(config.cacheFile), { recursive: true })
  const old = expansionLegacy36Cache('2026-09-26T09:59:55.000Z')
  if (options.old36) await writeFile(config.cacheFile, JSON.stringify(old))
  if (options.history) {
    const file = observationCacheFile(config.cacheFile)
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, JSON.stringify(surveyOldHistory()))
  }
  let responses = surveyResponses({ failures: options.failures })
  const requests: { url: string; method: string; body: unknown }[] = []
  const unexpected: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input)
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET')
    requests.push({ url, method, body: init?.body ?? null })
    if (method !== 'GET' || init?.body || !Object.hasOwn(responses, url)) {
      unexpected.push(url)
      throw new Error(`Blocked unexpected fictional request: ${method} ${url}`)
    }
    const reply = asCoverageReply(responses[url])
    if (reply.failure) throw new Error(reply.failure)
    return Response.json(reply.body, { status: reply.status ?? 200, headers: reply.headers })
  }))
  function service() {
    // Queue timing has its own suite. These tests exercise real parsing, cache
    // identity and observations with no wall-clock delay under a controlled date.
    const smart = createSmartRecruitersFetcher({ concurrency: 4, interval: 0, timeout: 30_000 })
    const full = { greenhouse: fetchGreenhouseBoard, ashby: fetchAshbyBoard, lever: fetchLeverBoard, smartrecruiters: smart }
    const presence = { greenhouse: fetchGreenhousePresence, ashby: fetchAshbyPresence, lever: fetchLeverPresence, smartrecruiters: smart.fetchPresence }
    return createCatalogService({
      companies: config.companies,
      cache: createFileBoardCache(config.cacheFile, config.legacyCacheFiles, config.companies),
      fetchBoard: (company, at) => full[company.provider ?? 'greenhouse'](company, at),
      presence: {
        cache: createFilePresenceCache(presenceCacheFile(config.cacheFile)),
        fetchBoard: company => presence[company.provider ?? 'greenhouse'](company),
      },
      observations: createObservationStore({
        companies: config.companies, cache: createFileObservationCache(observationCacheFile(config.cacheFile)), now: () => now,
      }),
      now: () => now, random: () => 0,
    })
  }
  return {
    config, old, requests, unexpected, service,
    respond: (options: Parameters<typeof surveyResponses>[0] = {}) => { responses = surveyResponses(options) },
  }
}
const positiveFields = (job: { id: string; companyId: string; source: string; title: string; role: string; cityIds: readonly string[]; url: string }) => ({
  id: job.id, companyId: job.companyId, source: job.source, title: job.title, role: job.role, cityIds: job.cityIds, url: job.url,
})

describe('independent47-company public survey', () => {
  it('collects every approved source into literal positive jobs while preserving pool, unlisted and nontechnical boundaries', async () => {
    const state = await fixture()
    const service = state.service()
    const catalog = await service.get()
    expect(catalog.companies).toHaveLength(83)
    expect(catalog.companies.slice(36).map(({ id, name, careerUrl, provider, board }) =>
      ({ id, name, careerUrl, provider, board }))).toEqual(SURVEY_REGISTRATIONS)
    expect(catalog.jobs).toHaveLength(65)
    expect(catalog.jobs.filter(job => SURVEY_REGISTRATIONS.some(company => company.id === job.companyId)
      && job.id !== 'greenhouse-xai-61901').map(positiveFields)).toEqual(SURVEY_JOBS.map(positiveFields))
    expect(catalog.boards).toHaveLength(83)
    expect(catalog.boards.every(board => board.status === 'ok' && board.dataStatus === 'fresh')).toBe(true)
    expect(catalog.jobs.filter(job => job.postingPurpose).map(job => job.id)).toEqual([
      'greenhouse-moloco-44102', 'greenhouse-xai-61901',
    ])
    expect(catalog.boards.filter(board => ['cursor', 'servicenow', 'xai'].includes(board.companyId)).map(board =>
      [board.companyId, board.total, board.included])).toEqual([['cursor', 1, 1], ['servicenow', 2, 1], ['xai', 3, 2]])
    for (const excluded of ['greenhouse-xai-61902', 'ashby-cursor-synthetic-61903', 'smartrecruiters-servicenow-synthetic-61904'])
      expect(catalog.jobs.map(job => job.id)).not.toContain(excluded)
    const index = await service.getPostingStatus()
    expect(index.boards.find(board => board.companyId === 'xai')!.listing!.publishedIds).toEqual([
      'greenhouse-xai-61046', 'greenhouse-xai-61901', 'greenhouse-xai-61902',
    ])
    expect(index.boards.find(board => board.companyId === 'cursor')!.listing!.publishedIds).toEqual(['ashby-cursor-synthetic-61012'])
    expect(index.boards.find(board => board.companyId === 'servicenow')!.listing!.publishedIds).toEqual([
      'smartrecruiters-servicenow-synthetic-61038', 'smartrecruiters-servicenow-synthetic-61904',
    ])
    expect(state.requests).toHaveLength(85)
    expect(state.requests.map(request => request.url).sort()).toEqual([
      ...Object.keys(expansionResponses()), ...Object.values(SURVEY_FULL_URLS), ...SURVEY_DETAIL_URLS,
    ].sort())
    expect(state.requests.every(request => request.method === 'GET' && request.body === null)).toBe(true)
    expect(state.unexpected).toEqual([])
    expect((await service.getObservations()).days[0].complete).toMatchObject({
      comparable: true, stats: { published: 69, technical: 65, openings: 63, talentPools: 2 },
    })
  })

  it('fetches only47 missing boards plus two details from an old36 cache and preserves its original facts through reload', async () => {
    const state = await fixture({ old36: true })
    expect(state.old.boards).toHaveLength(36)
    const before = await state.service().get()
    expect(before.jobs).toHaveLength(50)
    expect(before.jobs.slice(0, 2).map(job => [job.id, job.fetchedAt])).toEqual([
      ['greenhouse-stripe-44001', '2026-09-26T09:59:55.000Z'],
      ['ashby-notion-synthetic-57102', '2026-09-26T09:59:55.000Z'],
    ])
    expect(state.requests).toHaveLength(49)
    expect(state.requests.map(request => request.url).sort()).toEqual([...Object.values(SURVEY_FULL_URLS), ...SURVEY_DETAIL_URLS].sort())
    const bytes = await readFile(state.config.cacheFile, 'utf8')
    const cache = JSON.parse(bytes)
    expect(cache.boards).toHaveLength(83)
    for (const original of state.old.boards) {
      const kept = cache.boards.find((board: { companyId: string }) => board.companyId === original.companyId)
      expect(kept).toMatchObject(original)
      if (original.snapshot.jobs.length === 0) expect(kept).toEqual(original)
    }
    now += 1000
    const restarted = state.service()
    expect((await restarted.get()).jobs).toEqual(before.jobs)
    expect(await readFile(state.config.cacheFile, 'utf8')).toBe(bytes)
    expect(state.requests).toHaveLength(49)
    expect(state.unexpected).toEqual([])
    expect((await restarted.getObservations()).days[0].complete).toMatchObject({
      comparable: false, stats: { published: 52, technical: 50, openings: 49, talentPools: 1 },
    })
  })

  it('performs83 lightweight lists without details or renewed body evidence, then retrieves changed source content explicitly', async () => {
    const state = await fixture()
    const service = state.service()
    await service.get()
    const fullBytes = await readFile(state.config.cacheFile, 'utf8')
    now += 61_000
    const listed = await service.getPostingStatus(true)
    expect(state.requests).toHaveLength(168)
    expect(state.requests.slice(85)).toHaveLength(83)
    expect(state.requests.slice(85).some(request => SURVEY_DETAIL_URLS.includes(request.url as typeof SURVEY_DETAIL_URLS[number]))).toBe(false)
    expect(listed.boards.find(board => board.companyId === 'servicenow')!.listing!.content!.checkedAt).toBe(SURVEY_NOW)
    expect(await readFile(state.config.cacheFile, 'utf8')).toBe(fullBytes)
    now += 31 * 60_000
    const expiredBody = await service.getPostingStatus(true)
    expect(expiredBody.boards.find(board => board.companyId === 'servicenow')!.listing).toMatchObject({
      publishedIds: ['smartrecruiters-servicenow-synthetic-61038', 'smartrecruiters-servicenow-synthetic-61904'],
      jobs: [], content: { checkedAt: SURVEY_NOW, validUntil: '2026-09-26T10:30:00.000Z' },
    })
    expect(await readFile(state.config.cacheFile, 'utf8')).toBe(fullBytes)
    expect(state.requests).toHaveLength(251)
    state.respond({ changedServiceNow: true })
    const changed = await service.getPostingStatus(true, true)
    expect(state.requests).toHaveLength(336)
    expect(changed.boards.find(board => board.companyId === 'servicenow')!.listing!.jobs.map(job => [job.id, job.title, job.url])).toEqual([
      ['smartrecruiters-servicenow-synthetic-61038', SURVEY_SERVICE_CHANGED_TITLE, 'https://example.com/synthetic/stage61/servicenow-61038'],
    ])
    expect((await service.get()).jobs.find(job => job.id === 'smartrecruiters-servicenow-synthetic-61038')!.description)
      .toBe(SURVEY_SERVICE_CHANGED_BODY)
    expect(state.requests).toHaveLength(336)
    expect(state.unexpected).toEqual([])
  })

  it('retains four explicit provider failures across restart and recovers only those sources after their cooldowns', async () => {
    const state = await fixture({ failures: true })
    const firstService = state.service()
    const first = await firstService.get()
    expect(first.jobs).toHaveLength(60)
    expect(first.boards.filter(board => board.status === 'error').map(board => [board.companyId, board.dataStatus, board.lastSuccessAt])).toEqual([
      ['clickhouse', 'unavailable', null], ['palantir', 'unavailable', null],
      ['servicenow', 'unavailable', null], ['xai', 'unavailable', null],
    ])
    expect(first.boards.find(board => board.companyId === 'palantir')!.retryAt).toBe('2026-09-26T10:02:00.000Z')
    const failed = JSON.parse(await readFile(state.config.cacheFile, 'utf8'))
    expect(failed.boards.filter((board: { error?: string }) => board.error).map((board: { companyId: string; snapshot?: unknown; errorPhase: string }) =>
      [board.companyId, board.snapshot ?? null, board.errorPhase])).toEqual([
      ['clickhouse', null, 'inventory'], ['palantir', null, 'inventory'],
      ['servicenow', null, 'content'], ['xai', null, 'inventory'],
    ])
    expect((await firstService.getObservations()).days[0].complete).toBeUndefined()
    expect(state.requests).toHaveLength(85)
    const restarted = state.service()
    expect((await restarted.get()).boards).toEqual(first.boards)
    expect(state.requests).toHaveLength(85)
    state.respond()
    now += 121_000
    const recovered = await restarted.get()
    expect(recovered.jobs).toHaveLength(65)
    expect(recovered.boards.every(board => board.status === 'ok' && board.dataStatus === 'fresh')).toBe(true)
    expect(state.requests.slice(85).map(request => request.url).sort()).toEqual([
      SURVEY_FULL_URLS.clickhouse, SURVEY_FULL_URLS.palantir, SURVEY_FULL_URLS.servicenow, SURVEY_FULL_URLS.xai, SURVEY_DETAIL_URLS[1],
    ].sort())
    expect(state.requests).toHaveLength(90)
    expect((await restarted.getObservations()).days[0].complete?.stats).toMatchObject({ published: 69, technical: 65, openings: 63, talentPools: 2 })
    expect(state.unexpected).toEqual([])
  })

  it('excludes a complete old36 cohort and compares only the expanded83-company days', async () => {
    const state = await fixture({ history: true })
    const service = state.service()
    const old = await service.getObservations()
    expect(old.days).toEqual([])
    expect(old.otherSeries).toEqual([{
      scopeKey: SURVEY_OLD_SCOPE_KEY,
      method: 'observations-1.occupation-4.roles-1.qualifications-1.remote-2.employment-1.purpose-1',
      firstDay: '2026-09-25', lastDay: '2026-09-25', companyCount: 36,
    }])
    expect(state.requests).toEqual([])
    await service.get()
    const first = await service.getObservations()
    expect(first.days.map(day => [day.day, day.complete!.stats.openings])).toEqual([['2026-09-26', 63]])
    expect(first.otherSeries).toEqual(old.otherSeries)
    now += 86_400_000
    expect(await service.getObservations()).toEqual(first)
    expect(state.requests).toHaveLength(85)
    state.respond({ nextDay: true })
    await service.get(true)
    const next = await service.getObservations()
    expect(next.days.map(day => [day.day, day.complete!.comparable, day.complete!.stats.published,
      day.complete!.stats.technical, day.complete!.stats.openings, day.complete!.stats.talentPools])).toEqual([
      ['2026-09-26', true, 69, 65, 63, 2],
      ['2026-09-27', true, 70, 66, 64, 2],
    ])
    expect(next.otherSeries).toEqual(old.otherSeries)
    const persisted = JSON.parse(await readFile(observationCacheFile(state.config.cacheFile), 'utf8'))
    expect(persisted.series.find((series: { scope: { key: string } }) => series.scope.key === SURVEY_OLD_SCOPE_KEY))
      .toEqual(surveyOldHistory().series[0])
    expect(state.requests).toHaveLength(170)
    expect(state.unexpected).toEqual([])
  })
})
