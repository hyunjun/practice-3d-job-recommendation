import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createFileBoardCache } from '../../server/board-cache'
import type { CachedBoard } from '../../server/board-cache'
import { BoardConfigurationError, loadBoardConfiguration, parseBoardConfiguration } from '../../server/board-config'
import type { BoardConfiguration } from '../../server/board-config'
import { BoardFetchError, createCatalogService } from '../../server/catalog-service'
import type { BoardResult } from '../../server/catalog-service'
import { fetchGreenhouseBoard } from '../../server/providers/greenhouse'
import { fetchAshbyBoard } from '../../server/providers/ashby'
import { fetchLeverBoard } from '../../server/providers/lever'
import { fetchSmartRecruitersBoard } from '../../server/providers/smartrecruiters'
import { fetchWorkableBoard } from '../../server/providers/workable'
import { fetchHimalayasBoard } from '../../server/providers/himalayas'
import type { Company, Job, JobProvider } from '../../shared/types'
import { BOARD_CONFIG_REGISTRATIONS, boardFixtureResponse, boardRegistration } from '../fixtures/board-config'
import { EXPANDED_PUBLIC_REGISTRATIONS } from '../fixtures/public-coverage'
import { SURVEY_REGISTRATIONS } from '../fixtures/public-company-survey'
import { INTEGRATION_DEFAULT_IDS } from '../fixtures/source-integration-contract'

const repository = fileURLToPath(new URL('../../', import.meta.url))
const historical36Ids = [
  'stripe', 'figma', 'vercel', 'cloudflare', 'datadog', 'mongodb', 'airbnb', 'gitlab',
  'anthropic', 'intercom', 'asana', 'linear', 'deepl', 'n8n', 'supabase', 'mistral',
  'jane', 'spotify', 'contentsquare', 'canva', 'grab', 'wise', 'moloco', 'sendbird',
  'openai', 'notion', 'reddit', 'discord', 'coinbase', 'dropbox', 'duolingo', 'roblox',
  'spacex', 'pinterest', 'databricks', 'robinhood',
]
const defaultIds = [...historical36Ids, ...SURVEY_REGISTRATIONS.map(company => company.id), ...INTEGRATION_DEFAULT_IDS]
const BASE = Date.parse('2026-09-20T06:00:00.000Z')
const initialTime = '2026-09-20T06:00:00.000Z'
const directories: string[] = []
const children = new Set<ChildProcess>()
const replacement = (companies: unknown[] = [boardRegistration()]) => ({ version: 1, mode: 'replace', companies })
const ids = (companies: Company[]) => companies.map(company => company.id)
const providers: Record<JobProvider, (company: Company, fetchedAt: string) => Promise<BoardResult>> = {
  greenhouse: fetchGreenhouseBoard, ashby: fetchAshbyBoard, lever: fetchLeverBoard,
  smartrecruiters: fetchSmartRecruitersBoard,
  workable: fetchWorkableBoard, himalayas: fetchHimalayasBoard,
}

async function directory() {
  const result = await mkdtemp(path.join(tmpdir(), 'orbit-board-config-'))
  directories.push(result)
  return result
}
async function settings(cwd: string, input: unknown, name = '.local/job-boards.json') {
  const file = path.join(cwd, name)
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, JSON.stringify(input))
  return file
}
function cache(config: BoardConfiguration) {
  return createFileBoardCache(config.cacheFile, config.legacyCacheFiles, config.companies)
}
function service(config: BoardConfiguration, options: {
  now?: () => number
  fetchBoard?: (company: Company, fetchedAt: string) => Promise<BoardResult>
} = {}) {
  return createCatalogService({
    companies: config.companies, cache: cache(config), now: () => BASE, random: () => 0,
    fetchBoard: (company, fetchedAt) => providers[company.provider ?? 'greenhouse'](company, fetchedAt),
    ...options,
  })
}
function transport() {
  const requests: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : String(input)
    requests.push(url)
    return Response.json(boardFixtureResponse(url))
  }))
  return requests
}
function retained(company: Company, fetchedAt = initialTime): CachedBoard {
  const provider = company.provider ?? 'greenhouse'
  const job: Job & { source: JobProvider } = {
    id: `${provider}-${company.id}-retained`, companyId: company.id, source: provider,
    title: 'Backend Engineer Retained', role: 'backend', cityIds: ['london'], locationLabel: 'London',
    workMode: 'onsite', employment: 'fulltime', minExperience: null, skills: [], salary: null, visa: 'unknown',
    remoteCountries: [], remoteWorldwide: false, remoteScopeUnknown: false,
    description: 'Responsibilities\nBuild backend software in London.', requirements: [],
    url: 'https://example.com/jobs/retained', updatedAt: '2026-09-19T06:00:00.000Z', fetchedAt,
  }
  return {
    companyId: company.id, provider, board: company.board!, boardRegion: company.boardRegion,
    checkedAt: fetchedAt, failures: 0, retryAt: null,
    snapshot: { fetchedAt, jobs: [job], total: 1, unmappedCount: 0, publishedIds: [job.id] },
  }
}

beforeEach(() => { vi.stubEnv('ORBIT_BOARDS_FILE', undefined) })
afterEach(async () => {
  await Promise.all([...children].map(async child => {
    if (child.exitCode !== null || child.signalCode !== null) return
    const closed = new Promise<void>(resolve => child.once('close', () => resolve()))
    child.kill('SIGTERM')
    await closed
  }))
  children.clear()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  await Promise.all(directories.splice(0).map(cwd => rm(cwd, { recursive: true, force: true })))
})

describe('board configuration resolution', () => {
  it('keeps the historical36 and47 identities before the ten source integrations and leaves the filesystem untouched', async () => {
    const cwd = await directory()
    const resolved = await loadBoardConfiguration({ cwd })
    expect(resolved.mode).toBe('default')
    expect(resolved.filePath).toBeUndefined()
    expect(ids(resolved.companies)).toEqual(defaultIds)
    expect(ids(resolved.companies.slice(0, 36))).toEqual(historical36Ids)
    expect(resolved.companies.slice(0, 83)).toHaveLength(83)
    expect(resolved.companies).toHaveLength(93)
    expect(resolved.cacheFile).toBe(path.join(cwd, '.local/public-board-cache-v5.json'))
    expect(resolved.legacyCacheFiles).toEqual([
      path.join(cwd, '.local/greenhouse-cache-v4.json'), path.join(cwd, '.local/greenhouse-cache-v3.json'),
    ])
    expect(await readdir(cwd)).toEqual([])
  })

  it('defaults to extend, overrides a stable curated ID in place and appends a custom company', () => {
    const parsed = parseBoardConfiguration({ version: 1, companies: [
      boardRegistration({ id: 'gitlab', name: 'GitLab', provider: 'lever', board: 'GitLab-New', boardRegion: 'eu' }),
      boardRegistration(),
    ] })
    expect(parsed.mode).toBe('extend')
    expect(ids(parsed.companies)).toEqual([...defaultIds, 'aurora-config'])
    expect(parsed.companies[7]).toMatchObject({
      id: 'gitlab', name: 'GitLab', initials: 'G', color: '#fbb384', provider: 'lever', board: 'GitLab-New', boardRegion: 'eu',
    })
    expect(parseBoardConfiguration({ version: 1, companies: [] }).companies[7]).toMatchObject({
      id: 'gitlab', provider: 'greenhouse', board: 'gitlab', careerUrl: 'https://about.gitlab.com/jobs/',
    })
  })

  it('uses replace order, curated display metadata, all four providers and stable custom display values', () => {
    const parsed = parseBoardConfiguration(replacement(['gitlab', ...BOARD_CONFIG_REGISTRATIONS, 'linear']))
    expect(ids(parsed.companies)).toEqual(['gitlab', 'aurora-config', 'birch-config', 'cedar-config', 'dune-config', 'linear'])
    expect(parsed.companies[0]).toEqual({
      id: 'gitlab', name: 'GitLab', initials: 'G', color: '#fbb384', industry: '개발자 도구 · DevSecOps',
      careerUrl: 'https://about.gitlab.com/jobs/', provider: 'greenhouse', board: 'gitlab',
    })
    expect(parsed.companies.slice(1, 5).map(company => company.provider)).toEqual(['greenhouse', 'ashby', 'lever', 'smartrecruiters'])
    expect(parsed.companies.slice(1, 5).map(company => company.initials)).toEqual(['AW', 'BS', 'CS', 'DS'])
    expect(parsed.companies[3].boardRegion).toBe('eu')
    expect(parsed.companies[5].board).toBe('Linear')
    for (const company of parsed.companies.slice(1, 5)) {
      expect(['#a79aff', '#ff9c78', '#84dba6', '#91bafd', '#f7d878', '#83d1c7']).toContain(company.color)
    }
    const renamed = parseBoardConfiguration(replacement([boardRegistration({ name: 'Aurora Renamed' })]))
    expect(renamed.companies[0]).toMatchObject({ id: 'aurora-config', initials: 'AR', color: parsed.companies[1].color })
    parsed.companies[0].name = 'Local mutation'
    expect(parseBoardConfiguration(replacement(['gitlab'])).companies[0].name).toBe('GitLab')
  })

  it('resolves all twelve added curated references without requiring custom metadata or changing later defaults', () => {
    const parsed = parseBoardConfiguration(replacement([
      'openai', 'notion', 'reddit', 'discord', 'coinbase', 'dropbox', 'duolingo', 'roblox',
      'spacex', 'pinterest', 'databricks', 'robinhood',
    ]))
    expect(parsed.companies).toHaveLength(12)
    expect(parsed.companies.map(({ id, name, careerUrl, provider, board }) =>
      ({ id, name, careerUrl, provider, board }))).toEqual(EXPANDED_PUBLIC_REGISTRATIONS)
    parsed.companies[1].name = 'Synthetic local rename'
    expect(parseBoardConfiguration(replacement(['notion'])).companies[0]).toMatchObject({
      id: 'notion', name: 'Notion', provider: 'ashby', board: 'notion',
      careerUrl: 'https://www.notion.com/careers',
    })
  })

  it.each([
    { provider: 'ashby', board: 'openai', message: /"openai".*"aurora-config"/ },
    { provider: 'greenhouse', board: 'reddit', message: /"reddit".*"aurora-config"/ },
  ] as const)('rejects a custom duplicate of the newly registered $provider/$board in extend mode', ({ provider, board, message }) => {
    expect(() => parseBoardConfiguration({
      version: 1, companies: [boardRegistration({ provider, board })],
    })).toThrow(message)
  })

  it('resolves all47 newly approved curated references without custom metadata and rejects duplicate exact boards', () => {
    const parsed = parseBoardConfiguration(replacement(SURVEY_REGISTRATIONS.map(company => company.id)))
    expect(parsed.companies).toHaveLength(47)
    expect(parsed.companies.map(({ id, name, careerUrl, provider, board }) =>
      ({ id, name, careerUrl, provider, board }))).toEqual(SURVEY_REGISTRATIONS)
    expect(parsed.companies.find(company => company.id === 'xai')).toMatchObject({
      id: 'xai', name: 'xAI (SpaceXAI)', provider: 'greenhouse', board: 'xai', careerUrl: 'https://x.ai/careers',
    })
    for (const [provider, board, company] of [
      ['greenhouse', 'realtimeboardglobal', 'miro'],
      ['ashby', 'ClickHouse', 'clickhouse'],
      ['lever', 'palantir', 'palantir'],
      ['smartrecruiters', 'ServiceNow', 'servicenow'],
    ] as const) {
      expect(() => parseBoardConfiguration({ version: 1, companies: [boardRegistration({ provider, board })] }))
        .toThrow(`"${company}"와 "aurora-config"`)
    }
  })

  it('trims boards without changing case, Unicode or spaces; provider and Lever region distinguish sources', () => {
    const parsed = parseBoardConfiguration(replacement([
      boardRegistration({ board: '  팀 Alpha.v2  ' }),
      boardRegistration({ id: 'same-lever', provider: 'lever', board: '팀 Alpha.v2' }),
      boardRegistration({ id: 'same-lever-eu', provider: 'lever', board: '팀 Alpha.v2', boardRegion: 'eu' }),
      boardRegistration({ id: 'case-differs', board: '팀 alpha.v2' }),
    ]))
    expect(parsed.companies.map(company => [company.id, company.provider, company.board, company.boardRegion ?? null])).toEqual([
      ['aurora-config', 'greenhouse', '팀 Alpha.v2', null],
      ['same-lever', 'lever', '팀 Alpha.v2', null],
      ['same-lever-eu', 'lever', '팀 Alpha.v2', 'eu'],
      ['case-differs', 'greenhouse', '팀 alpha.v2', null],
    ])
  })

  it('accepts field and company-count upper bounds, including exactly 1000 resolved extended companies', () => {
    const company = boardRegistration({
      id: `a${'0'.repeat(99)}`, name: 'N'.repeat(200), industry: 'I'.repeat(200),
      board: 'B'.repeat(200), careerUrl: `https://example.com/${'p'.repeat(1980)}`,
    })
    expect(parseBoardConfiguration(replacement([company])).companies[0]).toMatchObject(company)
    const many = Array.from({ length: 1000 }, (_, index) => boardRegistration({ id: `fixture-${index}`, board: `Board-${index}` }))
    const replaced = parseBoardConfiguration(replacement(many))
    expect(replaced.companies).toHaveLength(1000)
    expect(replaced.companies[999].id).toBe('fixture-999')
    expect(parseBoardConfiguration({ version: 1, companies: many.slice(0, 1000 - defaultIds.length) }).companies).toHaveLength(1000)
    expect(() => parseBoardConfiguration({ version: 1, companies: many.slice(0, 1001 - defaultIds.length) })).toThrow(/1000/)
    expect(() => parseBoardConfiguration(replacement([...many, boardRegistration()]))).toThrow(/1000/)
  })

  it.each([
    { label: 'repeated curated IDs', companies: ['gitlab', 'gitlab'] },
    { label: 'repeated custom IDs', companies: [boardRegistration(), boardRegistration({ board: 'Elsewhere' })] },
    { label: 'reference plus override of the same ID', companies: ['gitlab', boardRegistration({ id: 'gitlab' })] },
    { label: 'two IDs for one provider board', companies: [boardRegistration(), boardRegistration({ id: 'another-id' })] },
  ])('rejects $label rather than silently dropping coverage', ({ companies }) => {
    expect(() => parseBoardConfiguration(replacement(companies))).toThrow(BoardConfigurationError)
    expect(() => parseBoardConfiguration(replacement(companies))).toThrow(/companies/)
  })

  it('rejects duplicate board identity against defaults in extend mode', () => {
    expect(() => parseBoardConfiguration({ version: 1, companies: [boardRegistration({ board: 'stripe' })] }))
      .toThrow(/"stripe".*"aurora-config"/)
  })

  it.each([
    { label: 'missing version', value: { companies: ['gitlab'] }, field: 'version' },
    { label: 'future version', value: { version: 2, companies: ['gitlab'] }, field: 'version' },
    { label: 'unsupported mode', value: { version: 1, mode: 'merge', companies: [] }, field: 'mode' },
    { label: 'missing companies', value: { version: 1 }, field: 'companies' },
    { label: 'non-array companies', value: { version: 1, companies: 'gitlab' }, field: 'companies' },
    { label: 'empty replacement', value: replacement([]), field: 'companies' },
    { label: 'unknown reference', value: replacement(['not-curated']), field: 'companies[0]' },
    { label: 'null entry', value: replacement([null]), field: 'companies[0]' },
    { label: 'top-level unknown field', value: { ...replacement(), endpoint: 'PRIVATE-DO-NOT-ECHO' }, field: 'endpoint' },
    { label: 'registration unknown field', value: replacement([{ ...boardRegistration(), token: 'PRIVATE-DO-NOT-ECHO' }]), field: 'token' },
  ])('rejects $label with useful field feedback and no original payload', ({ value, field }) => {
    try { parseBoardConfiguration(value); expect.fail('Invalid configuration was accepted') }
    catch (error) {
      expect(error).toBeInstanceOf(BoardConfigurationError)
      expect((error as Error).message).toContain(field)
      expect((error as Error).message).not.toContain('PRIVATE-DO-NOT-ECHO')
    }
  })

  it.each([
    ['id', 'Uppercase'], ['id', '-prefix'], ['id', 'under_score'], ['id', '가나다'], ['id', 'a'.repeat(101)],
    ['name', ' '], ['name', 'N'.repeat(201)], ['name', 'First\nSecond'], ['industry', 'I'.repeat(201)], ['industry', 'A\u2028B'],
    ['provider', 'custom'], ['boardRegion', 'us'],
    ['board', ''], ['board', 'B'.repeat(201)], ['board', '.'], ['board', '..'],
    ['board', 'one/two'], ['board', 'one\\two'], ['board', 'one?token=PRIVATE-DO-NOT-ECHO'], ['board', 'one#two'],
    ['board', 'one\ttwo'], ['board', 'one\u0000two'], ['board', 'one\u2029two'],
    ['careerUrl', 'http://example.com/careers'], ['careerUrl', 'https://user:PRIVATE-DO-NOT-ECHO@example.com'],
    ['careerUrl', 'javascript:alert(1)'], ['careerUrl', 'https://example.com/\nother'],
    ['careerUrl', `https://example.com/${'p'.repeat(1981)}`],
  ])('rejects invalid %s (case %#) without exposing its value', (field, value) => {
    try { parseBoardConfiguration(replacement([{ ...boardRegistration(), [field]: value }])); expect.fail('Invalid field was accepted') }
    catch (error) {
      expect(error).toBeInstanceOf(BoardConfigurationError)
      expect((error as Error).message).toContain(`companies[0].${field}`)
      expect((error as Error).message).not.toContain('PRIVATE-DO-NOT-ECHO')
    }
  })

  it.each(['greenhouse', 'ashby', 'smartrecruiters'])('does not accept a Lever region on %s', provider => {
    expect(() => parseBoardConfiguration(replacement([{ ...boardRegistration(), provider, boardRegion: 'eu' }]))).toThrow(/companies\[0\]\.boardRegion/)
  })
})

describe('configuration files and cache namespaces', () => {
  it('reads automatic UTF-8 BOM settings and lets an explicit relative path override them', async () => {
    const cwd = await directory()
    const automatic = await settings(cwd, replacement(['gitlab']))
    await writeFile(automatic, `\uFEFF${JSON.stringify(replacement(['gitlab']))}`)
    expect(ids((await loadBoardConfiguration({ cwd })).companies)).toEqual(['gitlab'])
    const explicit = await settings(cwd, replacement(['linear']), 'separate.json')
    vi.stubEnv('ORBIT_BOARDS_FILE', 'separate.json')
    const resolved = await loadBoardConfiguration({ cwd })
    expect(ids(resolved.companies)).toEqual(['linear'])
    expect(resolved.filePath).toBe(await realpath(explicit))
    expect(ids((await loadBoardConfiguration({ cwd, file: automatic })).companies)).toEqual(['gitlab'])
    expect((await readdir(path.join(cwd, '.local'))).sort()).toEqual(['job-boards.json'])
  })

  it('uses the canonical file path, not content or an alias, while isolating distinct settings files', async () => {
    const cwd = await directory()
    const original = await settings(cwd, replacement(['gitlab']), 'my-boards.json')
    const alias = path.join(cwd, 'alias.json')
    await symlink(original, alias)
    const first = await loadBoardConfiguration({ cwd, file: original })
    const aliased = await loadBoardConfiguration({ cwd, file: alias })
    expect(aliased.filePath).toBe(first.filePath)
    expect(aliased.cacheFile).toBe(first.cacheFile)
    await settings(cwd, replacement(['linear']), 'my-boards.json')
    expect((await loadBoardConfiguration({ cwd, file: original })).cacheFile).toBe(first.cacheFile)
    const other = await settings(cwd, replacement(['linear']), 'other-boards.json')
    expect((await loadBoardConfiguration({ cwd, file: other })).cacheFile).not.toBe(first.cacheFile)
    expect(path.dirname(first.cacheFile)).toBe(path.join(cwd, '.local'))
    expect(first.cacheFile).not.toBe(path.join(cwd, '.local/public-board-cache-v5.json'))
    expect(first.legacyCacheFiles).toEqual([
      path.join(cwd, '.local/public-board-cache-v5.json'),
      path.join(cwd, '.local/greenhouse-cache-v4.json'), path.join(cwd, '.local/greenhouse-cache-v3.json'),
    ])
  })

  it('never falls back from an explicit missing or blank path, directory or dangling automatic symlink', async () => {
    const cwd = await directory()
    await settings(cwd, replacement(['gitlab']))
    await expect(loadBoardConfiguration({ cwd, file: 'missing.json' })).rejects.toThrow(/missing\.json.*찾을 수/)
    await expect(loadBoardConfiguration({ cwd, file: '' })).rejects.toThrow(/ORBIT_BOARDS_FILE/)
    await expect(loadBoardConfiguration({ cwd, file: '  ' })).rejects.toThrow(/ORBIT_BOARDS_FILE/)
    await expect(loadBoardConfiguration({ cwd, file: '.local' })).rejects.toThrow(/일반 JSON 파일/)
    await rm(path.join(cwd, '.local/job-boards.json'))
    await symlink(path.join(cwd, 'missing-target.json'), path.join(cwd, '.local/job-boards.json'))
    await expect(loadBoardConfiguration({ cwd })).rejects.toThrow(BoardConfigurationError)
  })

  it.each([
    { label: 'empty', bytes: Buffer.from('') },
    { label: 'invalid JSON', bytes: Buffer.from('{ PRIVATE-DO-NOT-ECHO') },
    { label: 'invalid UTF-8', bytes: Buffer.from([0x7b, 0xff, 0x7d]) },
  ])('rejects $label contents without printing the original data', async ({ bytes }) => {
    const cwd = await directory()
    const file = path.join(cwd, 'invalid.json')
    await writeFile(file, bytes)
    await expect(loadBoardConfiguration({ cwd, file })).rejects.toThrow(/UTF-8/)
    await expect(loadBoardConfiguration({ cwd, file })).rejects.not.toThrow(/PRIVATE-DO-NOT-ECHO/)
  })

  it('enforces a byte limit including valid JSON padded to exactly 1 MiB', async () => {
    const cwd = await directory()
    const file = path.join(cwd, 'bounded.json')
    const body = JSON.stringify(replacement([boardRegistration({ name: '가상 회사' })]))
    const exact = Buffer.concat([Buffer.from(body), Buffer.alloc(1024 * 1024 - Buffer.byteLength(body), 0x20)])
    await writeFile(file, exact)
    expect(ids((await loadBoardConfiguration({ cwd, file })).companies)).toEqual(['aurora-config'])
    await writeFile(file, Buffer.concat([exact, Buffer.from(' ')]))
    await expect(loadBoardConfiguration({ cwd, file })).rejects.toThrow(/1 MiB/)
  })
})

describe('configured catalog and persisted source identity', () => {
  it('runs all four real provider normalizers for the resolved settings list and warm-loads without network', async () => {
    const cwd = await directory()
    await settings(cwd, replacement([...BOARD_CONFIG_REGISTRATIONS]))
    const config = await loadBoardConfiguration({ cwd })
    const requests = transport()
    const collected = await service(config).get()
    expect(ids(collected.companies)).toEqual(['aurora-config', 'birch-config', 'cedar-config', 'dune-config'])
    expect(collected.jobs.map(job => [job.id, job.title, job.cityIds, job.source])).toEqual([
      ['greenhouse-aurora-config-4201', 'Backend Engineer Aurora', ['london'], 'greenhouse'],
      ['ashby-birch-config-birch-4202', 'Backend Engineer Birch', ['london'], 'ashby'],
      ['lever-cedar-config-cedar-4203', 'Backend Engineer Cedar', ['london'], 'lever'],
      ['smartrecruiters-dune-config-dune-4204', 'Backend Engineer Dune', ['london'], 'smartrecruiters'],
    ])
    expect(collected.boards.map(board => [board.status, board.included, board.total])).toEqual([
      ['ok', 1, 1], ['ok', 1, 1], ['ok', 1, 1], ['ok', 1, 1],
    ])
    expect(collected.unmappedCount).toBe(0)
    expect(requests).toHaveLength(5)
    expect(requests).toContain('https://boards-api.greenhouse.io/v1/boards/Aurora%20Private42/jobs?content=true&pay_transparency=true')
    expect(requests).toContain('https://api.eu.lever.co/v0/postings/Cedar-Private42?mode=json&limit=50&skip=0')
    const second = await service(await loadBoardConfiguration({ cwd }), { now: () => BASE + 1000 }).get()
    expect(second.jobs.map(job => [job.id, job.fetchedAt, job.stale])).toEqual([
      ['greenhouse-aurora-config-4201', initialTime, false],
      ['ashby-birch-config-birch-4202', initialTime, false],
      ['lever-cedar-config-cedar-4203', initialTime, false],
      ['smartrecruiters-dune-config-dune-4204', initialTime, false],
    ])
    expect(requests).toHaveLength(5)
  })

  it.each([5, 4, 3])('migrates matching default v%i data into a separate configured cache without overwriting defaults', async version => {
    const cwd = await directory()
    const defaults = await loadBoardConfiguration({ cwd })
    const sourceFile = version === 5 ? defaults.cacheFile : defaults.legacyCacheFiles[version === 4 ? 0 : 1]
    const stripe = retained(defaults.companies[0])
    const figma = retained(defaults.companies[1])
    const input = version === 3 ? {
      source: 'greenhouse', fetchedAt: initialTime,
      jobs: [stripe.snapshot!.jobs[0], figma.snapshot!.jobs[0]],
      boards: [
        { companyId: 'stripe', board: 'stripe', status: 'ok', total: 1 },
        { companyId: 'figma', board: 'figma', status: 'ok', total: 1 },
      ],
    } : { version, boards: [stripe, figma] }
    await mkdir(path.dirname(sourceFile), { recursive: true })
    await writeFile(sourceFile, JSON.stringify(input))
    const originalBytes = await readFile(sourceFile)
    await settings(cwd, replacement(['stripe']))
    const config = await loadBoardConfiguration({ cwd })
    const fetchBoard = vi.fn(async () => { throw new Error('No request should be needed for migrated fresh data') })
    const catalog = await service(config, { fetchBoard }).get()
    expect(ids(catalog.companies)).toEqual(['stripe'])
    expect(catalog.jobs.map(job => [job.id, job.fetchedAt])).toEqual([['greenhouse-stripe-retained', initialTime]])
    expect(fetchBoard).not.toHaveBeenCalled()
    // A refresh persists to the configured destination, never to the migration source.
    await service(config, {
      now: () => BASE + 60_000,
      fetchBoard: async () => ({ jobs: [], total: 0, unmappedCount: 0, publishedIds: [] }),
    }).get(true)
    expect((JSON.parse(await readFile(config.cacheFile, 'utf8')) as { boards: CachedBoard[] }).boards.map(board => board.companyId)).toEqual(['stripe'])
    expect(await readFile(sourceFile)).toEqual(originalBytes)
  })

  it.each([
    { label: 'malformed JSON', content: '{broken' },
    { label: 'invalid newer structure', content: '{"version":5,"boards":"broken"}' },
  ])('does not resurrect a default snapshot after $label in the configured cache', async ({ content }) => {
    const cwd = await directory()
    const defaults = await loadBoardConfiguration({ cwd })
    await cache(defaults).save([retained(defaults.companies[0])])
    const defaultBytes = await readFile(defaults.cacheFile)
    await settings(cwd, replacement(['stripe']))
    const config = await loadBoardConfiguration({ cwd })
    await writeFile(config.cacheFile, content)
    const fetchBoard = vi.fn(async () => { throw new BoardFetchError('Synthetic outage') })
    await expect(service(config, { fetchBoard }).get()).rejects.toMatchObject({ code: 'CATALOG_UNAVAILABLE' })
    expect(fetchBoard).toHaveBeenCalledOnce()
    expect(await readFile(defaults.cacheFile)).toEqual(defaultBytes)
  })

  it('keeps matching snapshots and source times when the same file changes order, metadata and board identity', async () => {
    const cwd = await directory()
    await settings(cwd, replacement([BOARD_CONFIG_REGISTRATIONS[0], BOARD_CONFIG_REGISTRATIONS[2]]))
    const first = await loadBoardConfiguration({ cwd })
    const requests = transport()
    await service(first).get()
    expect(requests).toHaveLength(2)
    await settings(cwd, replacement([
      { ...BOARD_CONFIG_REGISTRATIONS[2], name: 'Cedar Renamed' },
      boardRegistration({ board: 'Aurora.Next42' }),
    ]))
    const next = await loadBoardConfiguration({ cwd })
    expect(next.cacheFile).toBe(first.cacheFile)
    const catalog = await service(next, { now: () => BASE + 1000 }).get()
    expect(catalog.companies.map(company => [company.id, company.name])).toEqual([
      ['cedar-config', 'Cedar Renamed'], ['aurora-config', 'Aurora Workshop'],
    ])
    expect(catalog.jobs.map(job => [job.id, job.title, job.url, job.fetchedAt])).toEqual([
      ['lever-cedar-config-cedar-4203', 'Backend Engineer Cedar', 'https://example.com/jobs/cedar', initialTime],
      ['greenhouse-aurora-config-4201', 'Backend Engineer Aurora Next', 'https://example.com/jobs/aurora-next', '2026-09-20T06:00:01.000Z'],
    ])
    expect(requests).toHaveLength(3)
    expect(requests[2]).toBe('https://boards-api.greenhouse.io/v1/boards/Aurora.Next42/jobs?content=true&pay_transparency=true')
    await settings(cwd, replacement([BOARD_CONFIG_REGISTRATIONS[2]]))
    const removed = await service(await loadBoardConfiguration({ cwd }), { now: () => BASE + 2000 }).get()
    expect(ids(removed.companies)).toEqual(['cedar-config'])
    expect(removed.jobs.map(job => job.id)).toEqual(['lever-cedar-config-cedar-4203'])
    expect(requests).toHaveLength(3)
  })

  it.each([
    { label: 'company ID', next: { id: 'different-company' } },
    { label: 'provider', next: { provider: 'ashby' as const, boardRegion: undefined } },
    { label: 'exact board case', next: { board: 'cedar-private42' } },
    { label: 'Lever EU host', next: { boardRegion: undefined } },
  ])('does not serve a fresh old snapshot after changing $label, even during an outage', async ({ next }) => {
    const cwd = await directory()
    await settings(cwd, replacement([BOARD_CONFIG_REGISTRATIONS[2]]))
    const original = await loadBoardConfiguration({ cwd })
    await cache(original).save([retained(original.companies[0])])
    await settings(cwd, replacement([{ ...BOARD_CONFIG_REGISTRATIONS[2], ...next }]))
    const changed = await loadBoardConfiguration({ cwd })
    const fetchBoard = vi.fn(async () => { throw new BoardFetchError('Synthetic changed-source outage') })
    await expect(service(changed, { fetchBoard }).get()).rejects.toMatchObject({ code: 'CATALOG_UNAVAILABLE' })
    expect(fetchBoard).toHaveBeenCalledOnce()
    expect((await cache(changed).load())[0].snapshot).toBeUndefined()
  })

  it('does not reuse a different configured file even when its contents are identical', async () => {
    const cwd = await directory()
    const firstFile = await settings(cwd, replacement(), 'first.json')
    const secondFile = await settings(cwd, replacement(), 'second.json')
    const requests = transport()
    const first = await loadBoardConfiguration({ cwd, file: firstFile })
    const second = await loadBoardConfiguration({ cwd, file: secondFile })
    await service(first).get()
    const originalBytes = await readFile(first.cacheFile)
    const other = await service(second, { now: () => BASE + 1000 }).get()
    expect(requests).toHaveLength(2)
    expect(other.jobs[0].fetchedAt).toBe('2026-09-20T06:00:01.000Z')
    expect(await readFile(first.cacheFile)).toEqual(originalBytes)
  })

  it('retains source age and retry cooldown across configured restarts, then excludes an expired snapshot', async () => {
    const cwd = await directory()
    await settings(cwd, replacement())
    const config = await loadBoardConfiguration({ cwd })
    await cache(config).save([retained(config.companies[0])])
    let now = BASE + 30 * 60_000
    const fetchBoard = vi.fn(async () => { throw new BoardFetchError('Synthetic outage', now + 5 * 60_000) })
    const first = await service(config, { now: () => now, fetchBoard }).get()
    expect(first.jobs.map(job => [job.id, job.fetchedAt, job.stale])).toEqual([['greenhouse-aurora-config-retained', initialTime, true]])
    expect(first.boards[0]).toMatchObject({
      lastSuccessAt: initialTime, checkedAt: '2026-09-20T06:30:00.000Z', retryAt: '2026-09-20T06:35:00.000Z',
    })
    now += 60_000
    const restarted = await service(await loadBoardConfiguration({ cwd }), { now: () => now, fetchBoard }).get(true)
    expect(restarted.jobs[0].fetchedAt).toBe(initialTime)
    expect(fetchBoard).toHaveBeenCalledOnce()
    now = BASE + 24 * 60 * 60_000 + 1
    await expect(service(config, { now: () => now, fetchBoard }).get()).rejects.toMatchObject({ code: 'CATALOG_EXPIRED' })
    expect((await cache(config).load())[0].snapshot!.fetchedAt).toBe(initialTime)
  })

  it('rejects future source times in a configured cache instead of presenting fresh-looking data', async () => {
    const cwd = await directory()
    await settings(cwd, replacement())
    const config = await loadBoardConfiguration({ cwd })
    await cache(config).save([retained(config.companies[0], '2026-09-20T06:06:00.000Z')])
    const fetchBoard = vi.fn(async () => { throw new BoardFetchError('Synthetic outage') })
    await expect(service(config, { fetchBoard }).get()).rejects.toMatchObject({ code: 'CATALOG_UNAVAILABLE' })
    expect(fetchBoard).toHaveBeenCalledOnce()
  })
})

async function runCommand(cwd: string, script: string, args: string[] = [], file?: string) {
  const log = path.join(cwd, 'upstream.jsonl')
  await writeFile(log, '')
  const env: NodeJS.ProcessEnv = { ...process.env, ORBIT_BOARD_TEST_REQUEST_LOG: log }
  delete env.ORBIT_BOARDS_FILE
  if (file !== undefined) env.ORBIT_BOARDS_FILE = file
  env.PORT = '0'
  env.HOST = '127.0.0.1'
  const child = spawn(process.execPath, [
    '--import', pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href,
    '--import', pathToFileURL(path.join(repository, 'tests/fixtures/board-config-preload.ts')).href,
    path.join(repository, script), ...args,
  ], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
  children.add(child)
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', data => {
    stdout += data
    // An invalid server becoming ready is a failure, not a reason to leave a
    // listener behind until the test deadline.
    if (script === 'server/index.ts' && stdout.includes('ORBIT ·')) child.kill('SIGTERM')
  })
  child.stderr.on('data', data => { stderr += data })
  const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code, signal) => { children.delete(child); resolve({ code, signal }) })
  })
  return { ...result, stdout, stderr, requests: await readFile(log, 'utf8') }
}
const runCli = (cwd: string, args: string[] = [], file?: string) => runCommand(cwd, 'scripts/check-boards.ts', args, file)

describe('offline board-check CLI', () => {
  it('prints default coverage and explicitly distinguishes validation from live availability', async () => {
    const result = await runCli(await directory())
    expect(result.code).toBe(0)
    expect(result.signal).toBeNull()
    expect(result.stdout).toContain('기본 공개 게시판 목록을 사용합니다.')
    expect(result.stdout).toContain('설정 확인 완료: 공개 게시판 93개')
    expect(result.stdout).toContain('stripe · Stripe · Greenhouse · stripe')
    expect(result.stdout).toContain('wise · Wise · SmartRecruiters · Wise')
    expect(result.stdout).toContain('openai · OpenAI · Ashby · openai')
    expect(result.stdout).toContain('notion · Notion · Ashby · notion')
    expect(result.stdout).toContain('robinhood · Robinhood · Greenhouse · robinhood')
    expect(result.stdout).toContain('miro · Miro · Greenhouse · realtimeboardglobal')
    expect(result.stdout).toContain('clickhouse · ClickHouse · Ashby · ClickHouse')
    expect(result.stdout).toContain('palantir · Palantir · Lever · palantir')
    expect(result.stdout).toContain('servicenow · ServiceNow · SmartRecruiters · ServiceNow')
    expect(result.stdout).toContain('xai · xAI (SpaceXAI) · Greenhouse · xai')
    expect(result.stdout).toContain('hugging-face · Hugging Face · Workable · huggingface')
    expect(result.stdout).toContain('redhat · Red Hat · Himalayas · red-hat')
    expect(result.stdout).toContain('네트워크 요청 없이 설정 형식을 확인했습니다.')
    expect(result.stdout).toContain('실제 게시판 연결은 앱의 공개 공고 조회에서 확인해 주세요.')
    expect(result.stderr).toBe('')
    expect(result.requests).toBe('')
  })

  it('honors a positional file before the environment and prints exact replacement sources', async () => {
    const cwd = await directory()
    await settings(cwd, replacement(['gitlab']), 'environment.json')
    await settings(cwd, replacement([...BOARD_CONFIG_REGISTRATIONS]), 'selected.json')
    const result = await runCli(cwd, ['selected.json'], 'environment.json')
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('selected.json')
    expect(result.stdout).toContain('적용 방법: 설정에 적은 회사만')
    expect(result.stdout).toContain('설정 확인 완료: 공개 게시판 4개')
    expect(result.stdout).toContain('aurora-config · Aurora Workshop · Greenhouse · Aurora Private42')
    expect(result.stdout).toContain('cedar-config · Cedar Systems · Lever · Cedar-Private42 (EU)')
    expect(result.stdout).not.toContain('gitlab ·')
    expect(result.requests).toBe('')
  })

  it('fails actionable validation without fetching providers or echoing private values', async () => {
    const cwd = await directory()
    await settings(cwd, replacement([{ ...boardRegistration(), token: 'PRIVATE-DO-NOT-ECHO' }]))
    const result = await runCli(cwd)
    expect(result.code).toBe(1)
    expect(result.signal).toBeNull()
    expect(result.stderr).toContain('공개 게시판 설정 오류:')
    expect(result.stderr).toContain('companies[0]')
    expect(result.stderr).toContain('token')
    expect(result.stderr).not.toContain('PRIVATE-DO-NOT-ECHO')
    expect(result.stdout).not.toContain('설정 확인 완료')
    expect(result.requests).toBe('')
  })
})

describe('real server startup validation', () => {
  it.each(['invalid', 'missing'])('exits before listening or collecting when the selected file is %s', async kind => {
    const cwd = await directory()
    if (kind === 'invalid') await settings(cwd, replacement([{ ...boardRegistration(), token: 'PRIVATE-DO-NOT-ECHO' }]), 'selected.json')
    const result = await runCommand(cwd, 'server/index.ts', ['--production'], 'selected.json')
    expect(result.code).toBe(1)
    expect(result.signal).toBeNull()
    expect(result.stderr).toContain('ORBIT 공개 게시판 설정을 확인해 주세요:')
    expect(result.stderr).toContain('selected.json')
    expect(result.stderr).not.toContain('PRIVATE-DO-NOT-ECHO')
    expect(result.stdout).not.toContain('ORBIT ·')
    expect(result.requests).toBe('')
    expect((await readdir(cwd)).some(file => file.includes('cache'))).toBe(false)
  })
})
