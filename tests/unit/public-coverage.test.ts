import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createFileBoardCache } from '../../server/board-cache'
import { loadBoardConfiguration } from '../../server/board-config'
import type { BoardConfiguration } from '../../server/board-config'
import { createCatalogService } from '../../server/catalog-service'
import type { BoardResult } from '../../server/catalog-service'
import { fetchGreenhouseBoard } from '../../server/providers/greenhouse'
import { fetchAshbyBoard } from '../../server/providers/ashby'
import { fetchLeverBoard } from '../../server/providers/lever'
import { fetchSmartRecruitersBoard } from '../../server/providers/smartrecruiters'
import { PUBLIC_COMPANIES } from '../../shared/companies'
import { jobPostingUrl } from '../../shared/job-links'
import { createJobRevision, observeSavedPosting, PostingStatusIndexSchema } from '../../shared/posting-status'
import { createSampleCatalog } from '../../shared/sample'
import { createSavedBackup, parseSavedImport } from '../../shared/saved-backup'
import { decodeSavedJobs } from '../../shared/saved-jobs'
import type { Company, Job, JobProvider, SavedJob } from '../../shared/types'
import { SavedPostingNotice } from '../../src/components/SavedPostingNotice'
import {
  ADDED_PUBLIC_REGISTRATIONS, COVERAGE_EXPANSION_URLS, COVERAGE_NEW_URLS, COVERAGE_NOTE, COVERAGE_SENDBIRD_JOB_URL,
  COVERAGE_SENDBIRD_SOURCE_URL, COVERAGE_TITLES, COVERAGE_UPDATED_AT, ORIGINAL_PUBLIC_REGISTRATIONS,
  EXPANDED_PUBLIC_REGISTRATIONS, coverageLegacyCache, publicCoverageResponses,
} from '../fixtures/public-coverage'
import { SURVEY_FULL_URLS, SURVEY_REGISTRATIONS, withSurveyEmptyBoards } from '../fixtures/public-company-survey'

const TIME = '2026-09-20T08:00:00.000Z'
const NOW = Date.parse(TIME)
const directories: string[] = []
const providers: Record<JobProvider, (company: Company, fetchedAt: string) => Promise<BoardResult>> = {
  greenhouse: fetchGreenhouseBoard, ashby: fetchAshbyBoard, lever: fetchLeverBoard,
  smartrecruiters: fetchSmartRecruitersBoard,
}
const expectedJobIds = [
  'greenhouse-stripe-44001', 'greenhouse-moloco-44101', 'greenhouse-moloco-44102',
  'greenhouse-sendbird-44201', 'greenhouse-sendbird-44202',
]
const expectedDefaultIds = [
  'stripe', 'figma', 'vercel', 'cloudflare', 'datadog', 'mongodb', 'airbnb', 'gitlab',
  'anthropic', 'intercom', 'asana', 'linear', 'deepl', 'n8n', 'supabase', 'mistral',
  'jane', 'spotify', 'contentsquare', 'canva', 'grab', 'wise', 'moloco', 'sendbird',
  'openai', 'notion', 'reddit', 'discord', 'coinbase', 'dropbox', 'duolingo', 'roblox',
  'spacex', 'pinterest', 'databricks', 'robinhood',
]
const currentDefaultIds = [...expectedDefaultIds, ...SURVEY_REGISTRATIONS.map(company => company.id)]
const sha = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')

async function directory() {
  const result = await mkdtemp(path.join(tmpdir(), 'orbit-public-coverage-'))
  directories.push(result)
  return result
}
function transport() {
  const responses = withSurveyEmptyBoards(publicCoverageResponses())
  const requests: { url: string; method: string }[] = []
  const unexpected: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input)
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET')
    requests.push({ url, method })
    if (method !== 'GET' || !Object.hasOwn(responses, url)) {
      unexpected.push(url)
      throw new Error(`Blocked unexpected synthetic upstream request: ${method} ${url}`)
    }
    return Response.json(responses[url])
  }))
  return { requests, responses, unexpected }
}
function service(config: BoardConfiguration, now: () => number = () => NOW) {
  return createCatalogService({
    companies: config.companies,
    cache: createFileBoardCache(config.cacheFile, config.legacyCacheFiles, config.companies),
    fetchBoard: (company, fetchedAt) => providers[company.provider ?? 'greenhouse'](company, fetchedAt),
    now, random: () => 0,
  })
}
function sourceJob(url = COVERAGE_SENDBIRD_SOURCE_URL): Job {
  return {
    ...coverageLegacyCache(TIME).boards[0].snapshot.jobs[0],
    id: 'greenhouse-sendbird-44201', companyId: 'sendbird', title: COVERAGE_TITLES.sendbird, url,
  }
}
function saved(job = sourceJob()): SavedJob {
  return {
    job, company: { ...ADDED_PUBLIC_REGISTRATIONS[1] }, savedAt: '2026-09-20T08:01:00.000Z',
    status: 'applied', note: COVERAGE_NOTE,
  }
}

beforeEach(() => { vi.stubEnv('ORBIT_BOARDS_FILE', undefined) })
afterEach(async () => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

describe('default public coverage and sample isolation', () => {
  it('preserves the frozen36 registrations and appends the47 approved identities', () => {
    expect(PUBLIC_COMPANIES).toHaveLength(83)
    expect(PUBLIC_COMPANIES.slice(0, 22)).toEqual(ORIGINAL_PUBLIC_REGISTRATIONS)
    expect(PUBLIC_COMPANIES.slice(22, 24)).toEqual(ADDED_PUBLIC_REGISTRATIONS)
    expect(PUBLIC_COMPANIES.slice(24, 36).map(({ id, name, careerUrl, provider, board }) =>
      ({ id, name, careerUrl, provider, board }))).toEqual(EXPANDED_PUBLIC_REGISTRATIONS)
    expect(PUBLIC_COMPANIES.slice(0, 36).map(company => company.id)).toEqual(expectedDefaultIds)
    expect(new Set(PUBLIC_COMPANIES.slice(0, 36).map(company => company.id)).size).toBe(36)
    expect(Object.fromEntries(['greenhouse', 'ashby', 'lever', 'smartrecruiters'].map(provider =>
      [provider, PUBLIC_COMPANIES.slice(0, 36).filter(company => company.provider === provider).length])))
      .toEqual({ greenhouse: 23, ashby: 8, lever: 2, smartrecruiters: 3 })
    expect(PUBLIC_COMPANIES.slice(36).map(({ id, name, careerUrl, provider, board }) =>
      ({ id, name, careerUrl, provider, board }))).toEqual(SURVEY_REGISTRATIONS)
    expect(PUBLIC_COMPANIES.map(company => company.id)).toEqual(currentDefaultIds)
    expect(new Set(PUBLIC_COMPANIES.map(company => company.id)).size).toBe(83)
    expect(Object.fromEntries(['greenhouse', 'ashby', 'lever', 'smartrecruiters'].map(provider =>
      [provider, PUBLIC_COMPANIES.filter(company => company.provider === provider).length])))
      .toEqual({ greenhouse: 50, ashby: 24, lever: 4, smartrecruiters: 5 })
  })

  it('keeps all sample records, not merely their32/179/22 counts, identical to the frozen43 API', () => {
    const sample = createSampleCatalog()
    expect(sample.source).toBe('sample')
    expect(sample.companies).toHaveLength(32)
    expect(sample.jobs).toHaveLength(179)
    expect(sample.cities).toHaveLength(22)
    // Literal SHA256 values captured from the old production API before editing.
    expect(sha(sample.companies)).toBe('4183aebca1efdbd2fe657cb6dee079912eed89ca0040b6abf52b87e440372bce')
    expect(sha(sample.jobs)).toBe('2bcf5df651ceb5a464c30f3dfa285257d77e75ea32443ef7c4738d4cbe4c9168')
    expect(sha(sample.cities)).toBe('f6ff919107cfd2d1b8469d06ba5780a91707567b160acd393fb14cf70f5891a5')
    expect(sample.companies.some(company => ['moloco', 'sendbird'].includes(company.id))).toBe(false)
    expect(sample.jobs.every(job => job.source === 'sample')).toBe(true)
    expect(sample.companies.find(company => company.id === 'notion')).toMatchObject({
      id: 'notion', name: 'Notion', board: 'notion', careerUrl: 'https://www.notion.com/careers',
    })
    expect(sample.companies.find(company => company.id === 'notion')).not.toHaveProperty('provider')
  })

  it('loads the83 defaults without an environment/local configuration or filesystem side effects', async () => {
    const cwd = await directory()
    const config = await loadBoardConfiguration({ cwd })
    expect(config.mode).toBe('default')
    expect(config.filePath).toBeUndefined()
    expect(config.companies.map(company => company.id)).toEqual(currentDefaultIds)
    expect(config.cacheFile).toBe(path.join(cwd, '.local/public-board-cache-v5.json'))
    expect(await readdir(cwd)).toEqual([])
  })

  it('collects all83 real default providers, retaining the original pool/publication IDs and deriving only status links', async () => {
    const network = transport()
    const config = await loadBoardConfiguration({ cwd: await directory() })
    const catalogService = service(config)
    const catalog = await catalogService.get()
    expect(catalog.companies.map(company => company.id)).toEqual(currentDefaultIds)
    expect(catalog.boards).toHaveLength(83)
    expect(catalog.boards.every(board => board.status === 'ok' && board.dataStatus === 'fresh')).toBe(true)
    expect(catalog.jobs.map(job => job.id)).toEqual(expectedJobIds)
    expect(catalog.jobs.map(job => job.cityIds)).toEqual([['seoul'], ['seoul'], ['seoul'], ['seoul'], ['seoul']])
    expect(catalog.jobs.filter(job => job.postingPurpose).map(job => job.id)).toEqual(['greenhouse-moloco-44102'])
    expect(catalog.jobs.find(job => job.id === 'greenhouse-moloco-44102')!.postingPurpose)
      .toMatchObject({ kind: 'talent-pool', basis: 'greenhouse-prospect' })
    expect(catalog.boards.filter(board => ['moloco', 'sendbird'].includes(board.companyId)))
      .toMatchObject([{ companyId: 'moloco', total: 3, included: 2 }, { companyId: 'sendbird', total: 3, included: 2 }])
    expect(catalog.jobs.find(job => job.id === 'greenhouse-sendbird-44201')!.url).toBe(COVERAGE_SENDBIRD_SOURCE_URL)

    const status = await catalogService.getPostingStatus()
    expect(PostingStatusIndexSchema.safeParse(status).success).toBe(true)
    expect(status.boards.find(board => board.companyId === 'moloco')!.listing!.publishedIds)
      .toEqual(['greenhouse-moloco-44101', 'greenhouse-moloco-44102', 'greenhouse-moloco-44103'])
    expect(status.boards.find(board => board.companyId === 'sendbird')!.listing!.publishedIds)
      .toEqual(['greenhouse-sendbird-44201', 'greenhouse-sendbird-44202', 'greenhouse-sendbird-44203'])
    expect(status.boards.find(board => board.companyId === 'sendbird')!.listing!.jobs.map(job => [job.id, job.url]))
      .toEqual([
        ['greenhouse-sendbird-44201', 'https://delight.ai/job/44201'],
        ['greenhouse-sendbird-44202', 'https://delight.ai/job/44202'],
      ])
    expect(network.requests).toHaveLength(83)
    expect(new Set(network.requests.map(request => request.url)).size).toBe(83)
    expect(network.requests.every(request => request.method === 'GET')).toBe(true)
    expect(network.unexpected).toEqual([])
    const stored = JSON.parse(await readFile(config.cacheFile, 'utf8'))
    expect(stored.boards).toHaveLength(83)
    expect(stored.boards.find((board: { companyId: string }) => board.companyId === 'sendbird').snapshot.jobs[0].url)
      .toBe('https://sendbird.com/careers?gh_jid=44201')
  })

  it('expands an old22-source cache by fetching only missing boards and preserves source facts through a second restart', async () => {
    const network = transport()
    const cwd = await directory()
    const oldTime = '2026-09-20T07:58:00.000Z'
    const original = coverageLegacyCache(oldTime)
    expect(original.boards).toHaveLength(22)
    await mkdir(path.join(cwd, '.local'))
    const file = path.join(cwd, '.local/public-board-cache-v5.json')
    await writeFile(file, JSON.stringify(original))
    const config = await loadBoardConfiguration({ cwd })
    const first = await service(config).get()
    expect(first.jobs.map(job => job.id)).toEqual(expectedJobIds)
    expect(network.requests.map(request => request.url).sort()).toEqual([...COVERAGE_NEW_URLS, ...COVERAGE_EXPANSION_URLS, ...Object.values(SURVEY_FULL_URLS)].sort())
    expect(network.unexpected).toEqual([])
    const expanded = JSON.parse(await readFile(file, 'utf8'))
    expect(expanded.boards.map((board: { companyId: string }) => board.companyId)).toEqual(currentDefaultIds)
    for (const originalBoard of original.boards) {
      const kept = expanded.boards.find((board: { companyId: string }) => board.companyId === originalBoard.companyId)
      // Canonical parsing may add interpretation fields, never alter source facts.
      expect(kept).toMatchObject(originalBoard)
      if (originalBoard.companyId !== 'stripe') expect(kept.snapshot).toEqual(originalBoard.snapshot)
    }
    expect(first.jobs[0]).toMatchObject({
      id: 'greenhouse-stripe-44001', fetchedAt: oldTime, updatedAt: COVERAGE_UPDATED_AT,
      source: 'greenhouse', url: 'https://example.com/synthetic/stripe-44001',
    })
    const serialized = await readFile(file, 'utf8')
    const restarted = await service(await loadBoardConfiguration({ cwd })).get()
    expect(restarted.jobs).toEqual(first.jobs)
    expect(await readFile(file, 'utf8')).toBe(serialized)
    expect(network.requests).toHaveLength(61)
    expect(await readdir(path.join(cwd, '.local'))).toEqual(['public-board-cache-v5.json'])
  })
})

describe('verified legacy Sendbird application links', () => {
  it.each([
    { companyId: 'sendbird', nativeId: '44201', expected: 'https://delight.ai/job/44201' },
    { companyId: 'private-greenhouse-tenant', nativeId: '1', expected: 'https://delight.ai/job/1' },
    { companyId: 'configured-alias', nativeId: '9007199254740993', expected: 'https://delight.ai/job/9007199254740993' },
  ])('resolves an exact legacy identity for $companyId without changing its raw record or making requests', ({ companyId, nativeId, expected }) => {
    const network = vi.fn(() => { throw new Error('A pure link must never fetch') })
    vi.stubGlobal('fetch', network)
    const job = Object.freeze({
      source: 'greenhouse' as const, companyId, id: `greenhouse-${companyId}-${nativeId}`,
      url: `https://sendbird.com/careers?gh_jid=${nativeId}`,
    })
    const before = JSON.stringify(job)
    expect(jobPostingUrl(job)).toBe(expected)
    expect(JSON.stringify(job)).toBe(before)
    expect(network).not.toHaveBeenCalled()
  })

  const unchanged: { name: string; change: Partial<Pick<Job, 'source' | 'id' | 'companyId' | 'url'>> }[] = [
    { name: 'Ashby source', change: { source: 'ashby' } },
    { name: 'Lever source', change: { source: 'lever' } },
    { name: 'SmartRecruiters source', change: { source: 'smartrecruiters' } },
    { name: 'sample source', change: { source: 'sample' } },
    { name: 'another company identity', change: { companyId: 'other' } },
    { name: 'another provider identity prefix', change: { id: 'ashby-sendbird-44201' } },
    { name: 'another posting identity', change: { id: 'greenhouse-sendbird-44202' } },
    { name: 'zero posting ID', change: { id: 'greenhouse-sendbird-0', url: 'https://sendbird.com/careers?gh_jid=0' } },
    { name: 'leading-zero posting ID', change: { id: 'greenhouse-sendbird-044201', url: 'https://sendbird.com/careers?gh_jid=044201' } },
    { name: 'signed posting ID', change: { id: 'greenhouse-sendbird--44201', url: 'https://sendbird.com/careers?gh_jid=-44201' } },
    { name: 'fractional posting ID', change: { id: 'greenhouse-sendbird-44201.0', url: 'https://sendbird.com/careers?gh_jid=44201.0' } },
    { name: 'nonnumeric posting ID', change: { id: 'greenhouse-sendbird-native', url: 'https://sendbird.com/careers?gh_jid=native' } },
    { name: 'HTTP', change: { url: 'http://sendbird.com/careers?gh_jid=44201' } },
    { name: 'lookalike domain', change: { url: 'https://sendbird.com.example.org/careers?gh_jid=44201' } },
    { name: 'www subdomain', change: { url: 'https://www.sendbird.com/careers?gh_jid=44201' } },
    { name: 'different port', change: { url: 'https://sendbird.com:444/careers?gh_jid=44201' } },
    { name: 'different path', change: { url: 'https://sendbird.com/jobs?gh_jid=44201' } },
    { name: 'trailing path slash', change: { url: 'https://sendbird.com/careers/?gh_jid=44201' } },
    { name: 'credentials', change: { url: 'https://reader:secret@sendbird.com/careers?gh_jid=44201' } },
    { name: 'username only', change: { url: 'https://reader@sendbird.com/careers?gh_jid=44201' } },
    { name: 'fragment', change: { url: 'https://sendbird.com/careers?gh_jid=44201#apply' } },
    { name: 'extra tracking parameter', change: { url: 'https://sendbird.com/careers?gh_jid=44201&utm_source=fixture' } },
    { name: 'duplicate identical parameter', change: { url: 'https://sendbird.com/careers?gh_jid=44201&gh_jid=44201' } },
    { name: 'different parameter name', change: { url: 'https://sendbird.com/careers?job_id=44201' } },
    { name: 'no posting parameter', change: { url: 'https://sendbird.com/careers' } },
    { name: 'query identity mismatch', change: { url: 'https://sendbird.com/careers?gh_jid=44202' } },
    { name: 'already canonical', change: { url: 'https://delight.ai/job/44201' } },
    { name: 'ordinary source link', change: { url: 'https://example.com/synthetic/ordinary?original=%2f#source' } },
    { name: 'malformed URL', change: { url: 'https://[not-a-valid-host/careers?gh_jid=44201' } },
    { name: 'relative URL', change: { url: '/careers?gh_jid=44201' } },
  ]
  it.each(unchanged)('leaves $name byte-for-byte unchanged', ({ change }) => {
    const job = Object.freeze({ source: 'greenhouse' as const, companyId: 'sendbird', id: 'greenhouse-sendbird-44201', url: COVERAGE_SENDBIRD_SOURCE_URL, ...change })
    expect(jobPostingUrl(job)).toBe(job.url)
  })

  it('treats only the verified alias as the same revision; real changes remain URL differences', async () => {
    const job = sourceJob()
    const input = JSON.stringify(job)
    const legacy = await createJobRevision(job)
    expect(await createJobRevision(sourceJob('https://delight.ai/job/44201'))).toEqual(legacy)
    for (const url of ['https://delight.ai/job/44202', 'https://example.com/synthetic/a-different-application']) {
      const different = await createJobRevision(sourceJob(url))
      expect((['title', 'location', 'conditions', 'compensation', 'qualifications', 'description', 'url'] as const)
        .filter(field => different[field] !== legacy[field])).toEqual(['url'])
    }
    expect(JSON.stringify(job)).toBe(input)
  })

  it('compares a real default collection against a legacy save without fabricating a change or replacing its raw link', async () => {
    const network = transport()
    let now = NOW
    const config = await loadBoardConfiguration({ cwd: await directory() })
    const catalogService = service(config, () => now)
    const initial = await catalogService.get()
    const record = saved(initial.jobs.find(job => job.id === 'greenhouse-sendbird-44201')!)
    const before = JSON.stringify(record)
    const revision = await createJobRevision(record.job)
    const listing = network.responses[COVERAGE_NEW_URLS[1]] as { jobs: { absolute_url: string }[] }
    listing.jobs[0].absolute_url = 'https://delight.ai/job/44201'
    now += 61_000
    const canonical = await catalogService.getPostingStatus(true)
    expect(observeSavedPosting(record, canonical, revision, now)).toMatchObject({
      state: 'listed', changedFields: [], currentUrl: 'https://delight.ai/job/44201',
    })
    listing.jobs[0].absolute_url = 'https://example.com/synthetic/sendbird-edited'
    now += 61_000
    const changed = await catalogService.getPostingStatus(true)
    expect(observeSavedPosting(record, changed, revision, now)).toMatchObject({
      state: 'listed', changedFields: ['url'], currentUrl: 'https://example.com/synthetic/sendbird-edited',
    })
    expect(JSON.stringify(record)).toBe(before)
    expect(record.job.url).toBe(COVERAGE_SENDBIRD_SOURCE_URL)
    expect(network.unexpected).toEqual([])
  })

  it.each([
    { name: 'unknown-state fallback', observation: { state: 'unknown' as const, message: 'Synthetic unavailable status' } },
    { name: 'legacy current URL', observation: { state: 'listed' as const, currentUrl: COVERAGE_SENDBIRD_SOURCE_URL, changedFields: [] } },
    { name: 'canonical current URL', observation: { state: 'listed' as const, currentUrl: COVERAGE_SENDBIRD_JOB_URL, changedFields: [] } },
  ])('renders a useful original action for $name without changing the source snapshot', ({ observation }) => {
    const job = sourceJob()
    const before = JSON.stringify(job)
    const html = renderToStaticMarkup(createElement(SavedPostingNotice, { job, observation }))
    expect(html).toContain('현재 원문 확인')
    expect(html).toContain('href="https://delight.ai/job/44201"')
    expect(html).not.toContain('href="https://sendbird.com/careers?gh_jid=44201"')
    expect(JSON.stringify(job)).toBe(before)
  })

  it('preserves source identity, raw URL, notes/status/dates through legacy migration and JSON backup restore', () => {
    const original = saved()
    const decoded = decodeSavedJobs(JSON.stringify([original]))
    expect(decoded.omitted).toBe(0)
    expect(decoded.records).toHaveLength(1)
    const backup = createSavedBackup(decoded.records, 0, new Date('2026-09-20T08:02:00.000Z'))
    const literal = JSON.parse(backup)
    expect(literal.records[0]).toMatchObject({
      job: {
        id: 'greenhouse-sendbird-44201', companyId: 'sendbird', source: 'greenhouse',
        url: 'https://sendbird.com/careers?gh_jid=44201', fetchedAt: TIME, updatedAt: COVERAGE_UPDATED_AT,
      },
      company: { id: 'sendbird', name: 'Delight.ai (Sendbird)', provider: 'greenhouse', board: 'sendbird' },
      savedAt: '2026-09-20T08:01:00.000Z', status: 'applied', note: COVERAGE_NOTE,
    })
    const restored = parseSavedImport(backup)
    expect(restored.invalid).toBe(0)
    expect(restored.duplicates).toBe(0)
    expect(restored.groups.map(group => group.id)).toEqual(['greenhouse-sendbird-44201'])
    expect(restored.groups[0].variants).toEqual(decoded.records)
    expect(original.job.url).toBe('https://sendbird.com/careers?gh_jid=44201')
  })
})
