import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseCachedBoards } from '../../server/board-cache'
import { normalizeJob } from '../../server/normalize'
import { normalizeAshbyJob } from '../../server/providers/ashby'
import { fetchGreenhouseBoard } from '../../server/providers/greenhouse'
import { normalizeLeverJob } from '../../server/providers/lever'
import { normalizeSmartRecruitersJob } from '../../server/providers/smartrecruiters'
import { classifyPostingPurpose, upgradeJobPostingPurpose } from '../../shared/job-posting'
import { countSearchJobs, createSearchIndex, selectSearchJobs } from '../../shared/job-search'
import { upgradeCatalog, upgradeJob } from '../../shared/job-upgrade'
import { countFilters, createSearchRanker } from '../../shared/matching'
import { createJobRevision, observeSavedPosting, PostingStatusIndexSchema } from '../../shared/posting-status'
import { createSavedBackup, parseSavedImport } from '../../shared/saved-backup'
import { decodeSavedJobs, SavedJobSchema } from '../../shared/saved-jobs'
import { JobSchema } from '../../shared/schemas'
import { analyzeSearchRecovery, undoRecoveryChanges } from '../../shared/search-recovery'
import { DEFAULT_FILTERS } from '../../shared/types'
import type { Filters, Job, JobPostingPurpose, JobProvider } from '../../shared/types'
import { CatalogUpdateDataSchema, isPublicCatalog } from '../../src/lib/catalog-validation'
import { loadExploration, persistExploration, STORAGE_KEYS } from '../../src/lib/storage'
import {
  JOB_POSTING_ACTIVE_PARAGRAPH, JOB_POSTING_COMPANIES, JOB_POSTING_FUTURE_PARAGRAPH,
  JOB_POSTING_FILTERS, JOB_POSTING_FUTURE_TITLE, JOB_POSTING_KOREAN_PARAGRAPH,
  JOB_POSTING_NOTE, JOB_POSTING_NOW, JOB_POSTING_ORDINARY_PARAGRAPH, JOB_POSTING_PROFILE,
  JOB_POSTING_SAVED_AT, JOB_POSTING_TIME, JOB_POSTING_UPDATED_AT, legacyPostingJob,
  legacyPostingSaved, postingAshbyRaw, postingCatalog, postingDescription,
  postingGreenhouseRaw, postingLeverRaw, postingScopeJobs, postingSmartRecruitersRaw,
} from '../fixtures/job-posting'

afterEach(() => vi.unstubAllGlobals())

const providers: { provider: JobProvider; companyId: string; expectedId: string }[] = [
  { provider: 'greenhouse', companyId: 'posting-alder', expectedId: 'greenhouse-posting-alder-4301' },
  { provider: 'ashby', companyId: 'posting-birch', expectedId: 'ashby-posting-birch-4302' },
  { provider: 'lever', companyId: 'posting-cedar', expectedId: 'lever-posting-cedar-4303' },
  { provider: 'smartrecruiters', companyId: 'posting-dogwood', expectedId: 'smartrecruiters-posting-dogwood-4304' },
]

/** Each real normalizer is a subject; countries, identities and purposes are literal oracles. */
function normalized(provider: JobProvider, description: string, title = JOB_POSTING_FUTURE_TITLE, extra: Record<string, unknown> = {}): Job {
  const companyId = providers.find(item => item.provider === provider)!.companyId
  let job: Job | null
  if (provider === 'greenhouse') job = normalizeJob(postingGreenhouseRaw({
    internal_job_id: 7301, title, content: description, ...extra,
  }), companyId, JOB_POSTING_TIME)
  else if (provider === 'ashby') job = normalizeAshbyJob(postingAshbyRaw({
    title, descriptionPlain: description, ...extra,
  }), companyId, JOB_POSTING_TIME)
  else if (provider === 'lever') job = normalizeLeverJob(postingLeverRaw({
    text: title, descriptionPlain: description, ...extra,
  }), companyId, JOB_POSTING_TIME)
  else job = normalizeSmartRecruitersJob(postingSmartRecruitersRaw({
    name: title, jobAd: { sections: { jobDescription: { text: description } } }, ...extra,
  }), companyId, JOB_POSTING_TIME)
  expect(job, `${provider} must retain the synthetic technical post`).not.toBeNull()
  return job!
}

function descriptionPurpose(text = JOB_POSTING_FUTURE_PARAGRAPH): JobPostingPurpose {
  return { version: 1, kind: 'talent-pool', basis: 'description', evidence: [{ source: 'description', text }] }
}

const positives = [
  { name: 'current-post future registration with an interest title', title: JOB_POSTING_FUTURE_TITLE, text: JOB_POSTING_FUTURE_PARAGRAPH },
  { name: 'explicit future registration even with an ordinary engineer title', title: 'Backend Engineer', text: JOB_POSTING_FUTURE_PARAGRAPH },
  { name: 'current post collects future profiles', title: 'Backend Engineer', text: 'This posting collects candidate profiles for future opportunities.' },
  { name: 'explicit current-post talent-pool definition', title: 'Backend Engineer', text: 'This posting is a talent pool registration for future engineering roles.' },
  { name: 'no current vacancy in an interest-registration application', title: 'Backend Engineer — Expression of Interest', text: 'This application does not advertise a current vacancy.' },
  { name: 'Korean current-post future registration without a current position', title: 'Backend Engineer', text: JOB_POSTING_KOREAN_PARAGRAPH },
  { name: 'Korean current-post profile collection', title: 'Backend Engineer', text: '이 공고는 향후 기회가 생기면 연락드리기 위해 지원자의 프로필을 모으는 인재풀 등록입니다.' },
  {
    name: 'Korean no-opening and future-contact context across two source sentences',
    title: 'Backend Engineer — Expression of Interest',
    text: '현재 채용 중인 포지션이 없어도 본 공고를 통해 이력서를 제출해 주세요. 향후 적합한 기회가 생길 때 연락드립니다.',
    fragments: ['본 공고', '이력서', '향후'],
  },
]

describe('positive current-post purpose and bounded counterexamples', () => {
  it.each(positives)('$name', ({ title, text, ...detail }) => {
    const purpose = classifyPostingPurpose({ title, description: text })
    expect(purpose).toMatchObject({ version: 1, kind: 'talent-pool', basis: 'description' })
    expect(purpose!.evidence.length).toBeGreaterThan(0)
    expect(purpose!.evidence.length).toBeLessThanOrEqual(4)
    for (const evidence of purpose!.evidence) {
      expect(evidence.source).toBe('description')
      expect(text).toContain(evidence.text)
    }
    if ('fragments' in detail && detail.fragments) {
      for (const fragment of detail.fragments) expect(purpose!.evidence.map(item => item.text).join('\n')).toContain(fragment)
    } else expect(purpose!.evidence).toContainEqual({ source: 'description', text })
  })

  it.each([
    ['title-only talent pool', 'Backend Engineer — Talent Pool', JOB_POSTING_ORDINARY_PARAGRAPH],
    ['ambiguous EOI title and potential match', 'Backend Engineer — Expression of Interest', 'We welcome expressions of interest from engineers who could be a potential match for our backend team.'],
    ['title-only future opportunities', JOB_POSTING_FUTURE_TITLE, 'Build backend services and grow your career with our engineering team.'],
    ['opportunistic hiring EOI', 'Backend Engineer — Expression of Interest', JOB_POSTING_ACTIVE_PARAGRAPH],
    ['future career development', 'Backend Engineer', 'This role offers future career opportunities and mentoring from experienced engineers.'],
    ['company pool language', 'Backend Engineer', 'Our company maintains a talent pool and accepts candidate profiles for future opportunities.'],
    ['separate footer invitation', 'Backend Engineer', `${JOB_POSTING_ORDINARY_PARAGRAPH}\n\nNot the right role? Join our talent community to hear about future openings.`],
    ['negated collection', 'Backend Engineer', 'This posting does not collect candidate profiles for future opportunities.'],
    ['negated pool', 'Backend Engineer', 'This posting is not a talent pool registration. We are actively hiring for this role.'],
    ['double-quoted example', 'Backend Engineer', '"This posting collects candidate profiles for future opportunities."'],
    ['smart-quoted example', 'Backend Engineer', '“This posting collects candidate profiles for future opportunities.”'],
    ['an embedded training quote', 'Backend Engineer', 'A training exercise quotes the sentence "This posting collects candidate profiles for future opportunities." Our current vacancy is for a backend engineer.'],
    ['example heading', 'Backend Engineer', 'Examples:\n\nThis posting collects candidate profiles for future opportunities.\n\nWe are currently hiring for this role.'],
    ['link to a different registration', 'Backend Engineer', 'This posting also links to a form that collects profiles for future opportunities.'],
    ['conditional separate form in a current posting', 'Backend Engineer', 'This posting describes a current vacancy; if no vacancy suits you, submit your profile for future opportunities using a separate form.'],
    ['conditional unrelated registration', 'Backend Engineer', 'If a future role interests you, submit your profile using the talent community link; this position is actively hiring.'],
    ['contradictory current-role statements', 'Backend Engineer', 'This posting is a talent pool registration for future roles.\n\nWe are actively hiring for this current position.'],
    ['Korean contradictory current-role statements', 'Backend Engineer', '본 공고는 향후 기회를 위한 인재풀 등록입니다.\n\n현재 이 포지션의 백엔드 엔지니어를 채용 중입니다.'],
    ['Korean negated registration', 'Backend Engineer', '본 공고는 인재풀 등록이 아니며 현재 백엔드 엔지니어를 채용하는 공고입니다.'],
    ['Korean quoted example', 'Backend Engineer', '예시: 본 공고는 향후 기회를 위한 인재풀 등록입니다.'],
    ['EEO and benefits', 'Backend Engineer', 'We welcome future talent from all backgrounds. All candidates receive equal consideration, and employees can register for future retirement benefits.'],
  ])('%s is not positive evidence', (_name, title, description) => {
    expect(classifyPostingPurpose({ title, description })).toBeUndefined()
  })
})

describe('purpose through the complete provider normalization entry points', () => {
  it.each(providers)('$provider retains the future registration and its actual source quote', ({ provider, companyId, expectedId }) => {
    const job = normalized(provider, postingDescription(JOB_POSTING_FUTURE_PARAGRAPH))
    expect(job).toMatchObject({
      id: expectedId, companyId, source: provider, title: JOB_POSTING_FUTURE_TITLE,
      cityIds: ['london'], fetchedAt: JOB_POSTING_TIME,
      postingPurpose: descriptionPurpose(),
    })
    expect(job.updatedAt).toBe(provider === 'greenhouse' || provider === 'smartrecruiters' ? JOB_POSTING_UPDATED_AT : null)
    expect(JobSchema.safeParse(job).success).toBe(true)
  })

  it.each(providers)('$provider reads positive purpose beyond the 26k retained description', ({ provider }) => {
    const body = 'Operational notes describe reliable backend tooling.\n\n'.repeat(550) + JOB_POSTING_FUTURE_PARAGRAPH
    expect(body.indexOf(JOB_POSTING_FUTURE_PARAGRAPH)).toBeGreaterThan(26000)
    const job = normalized(provider, body)
    expect(job.description).not.toContain(JOB_POSTING_FUTURE_PARAGRAPH)
    expect(job.postingPurpose).toEqual(descriptionPurpose())
    expect(job.fetchedAt).toBe(JOB_POSTING_TIME)
    expect(JobSchema.safeParse(job).success).toBe(true)
  })

  it.each([
    { name: 'exact null', fields: { internal_job_id: null }, pool: true },
    { name: 'missing field', fields: {}, pool: false },
    { name: 'undefined is omitted by JSON', fields: { internal_job_id: undefined }, pool: false },
    { name: 'zero', fields: { internal_job_id: 0 }, pool: false },
    { name: 'false', fields: { internal_job_id: false }, pool: false },
    { name: 'string null', fields: { internal_job_id: 'null' }, pool: false },
    { name: 'empty string', fields: { internal_job_id: '' }, pool: false },
    { name: 'string identifier', fields: { internal_job_id: '7301' }, pool: false },
    { name: 'numeric identifier', fields: { internal_job_id: 7301 }, pool: false },
  ])('Greenhouse $name preserves publication and uses only the authoritative signal', async ({ fields, pool }) => {
    const { internal_job_id: _removed, ...withoutSignal } = postingGreenhouseRaw()
    const raw = { ...withoutSignal, ...fields }
    const input = { jobs: [raw], meta: { total: 1 } }
    const copy = structuredClone(input)
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(input)))
    const board = await fetchGreenhouseBoard(JOB_POSTING_COMPANIES[0], JOB_POSTING_TIME)
    expect(board.total).toBe(1)
    expect(board.jobs).toHaveLength(1)
    expect(board.publishedIds).toEqual(['greenhouse-posting-alder-4301'])
    const job = board.jobs[0]
    expect(job.title).toBe('Backend Engineer Alder')
    if (pool) {
      expect(job.postingPurpose).toMatchObject({
        version: 1, kind: 'talent-pool', basis: 'greenhouse-prospect', evidence: [{ source: 'board' }],
      })
      expect(job.postingPurpose!.evidence[0].text).toContain('internal_job_id')
      expect(job.postingPurpose!.evidence[0].text).toContain('null')
    } else expect(job).not.toHaveProperty('postingPurpose')
    expect(input).toEqual(copy)
  })

  it.each(['ashby', 'lever', 'smartrecruiters'] as const)('%s never borrows Greenhouse metadata', provider => {
    const job = normalized(provider, JOB_POSTING_ACTIVE_PARAGRAPH, 'Backend Engineer — Expression of Interest', { internal_job_id: null })
    expect(job).not.toHaveProperty('postingPurpose')
    expect(JobSchema.safeParse(job).success).toBe(true)
  })
})

describe('purpose upgrade trusts valid evidence and preserves old unknown information', () => {
  it.each([
    ['empty', []],
    ['blank', [{ source: 'description', text: '   ' }]],
    ['wrong source', [{ source: 'title', text: JOB_POSTING_FUTURE_PARAGRAPH }]],
  ] as const)('invalid stored %s evidence is rederived from a positive retained body', (_name, evidence) => {
    const job = { ...legacyPostingJob(), postingPurpose: { ...descriptionPurpose(), evidence } } as unknown as Job
    const input = structuredClone(job)
    expect(upgradeJobPostingPurpose(job).postingPurpose).toEqual(descriptionPurpose())
    expect(job).toEqual(input)
  })

  it.each([
    ['empty', []],
    ['blank', [{ source: 'description', text: '   ' }]],
    ['wrong source', [{ source: 'title', text: JOB_POSTING_FUTURE_PARAGRAPH }]],
  ] as const)('invalid stored %s evidence cannot hide an ordinary retained body', (_name, evidence) => {
    const job = {
      ...legacyPostingJob('ordinary', { title: 'Backend Engineer', description: JOB_POSTING_ORDINARY_PARAGRAPH }),
      postingPurpose: { ...descriptionPurpose(), evidence },
    } as unknown as Job
    expect(upgradeJobPostingPurpose(job)).not.toHaveProperty('postingPurpose')
  })

  it('retains a valid structured-only purpose without manufacturing a body quote', () => {
    const purpose: JobPostingPurpose = {
      version: 1, kind: 'talent-pool', basis: 'greenhouse-prospect',
      evidence: [{ source: 'board', text: 'Greenhouse prospect metadata: internal_job_id is null.' }],
    }
    const job = legacyPostingJob('prospect', { title: 'Backend Engineer', description: JOB_POSTING_ORDINARY_PARAGRAPH, postingPurpose: purpose })
    expect(JobSchema.safeParse(job).success).toBe(true)
    expect(upgradeJobPostingPurpose(job)).toEqual(job)
  })

  it('cannot reconstruct missing prospect metadata from an ordinary old snapshot', () => {
    const job = legacyPostingJob('prospect-without-field', { title: 'Backend Engineer', description: JOB_POSTING_ORDINARY_PARAGRAPH })
    expect(upgradeJobPostingPurpose(job)).not.toHaveProperty('postingPurpose')
    expect(upgradeJobPostingPurpose(job)).toEqual(job)
  })

  it('leaves sample records unchanged even when their example text describes a pool', () => {
    const job = legacyPostingJob('sample', { source: 'sample' })
    expect(upgradeJobPostingPurpose(job)).toEqual(job)
    expect(upgradeJobPostingPurpose(job)).not.toHaveProperty('postingPurpose')
  })
})

describe('schema, migration and source identity', () => {
  it('rejects malformed purpose evidence without discarding the ordinary snapshot format', () => {
    const old = legacyPostingJob()
    expect(JobSchema.safeParse(old).success).toBe(true)
    expect(JobSchema.safeParse({ ...old, postingPurpose: descriptionPurpose() }).success).toBe(true)
    const invalid = [
      { ...descriptionPurpose(), version: 2 },
      { ...descriptionPurpose(), kind: 'opening' },
      { ...descriptionPurpose(), basis: 'title' },
      { ...descriptionPurpose(), evidence: [] },
      { ...descriptionPurpose(), evidence: [{ source: 'description', text: ' ' }] },
      { ...descriptionPurpose(), evidence: [{ source: 'description', text: 'x'.repeat(3001) }] },
      { ...descriptionPurpose(), evidence: Array.from({ length: 5 }, () => ({ source: 'description', text: 'An explicit registration.' })) },
      { ...descriptionPurpose(), evidence: [{ source: 'board', text: JOB_POSTING_FUTURE_PARAGRAPH }] },
    ]
    for (const purpose of invalid) expect(JobSchema.safeParse({ ...old, postingPurpose: purpose }).success).toBe(false)
  })

  it('never accepts a Greenhouse-only board assertion on another provider', () => {
    const purpose: JobPostingPurpose = {
      version: 1, kind: 'talent-pool', basis: 'greenhouse-prospect',
      evidence: [{ source: 'board', text: 'Greenhouse prospect metadata: internal_job_id is null.' }],
    }
    expect(JobSchema.safeParse({ ...legacyPostingJob(), postingPurpose: purpose }).success).toBe(true)
    for (const source of ['ashby', 'lever', 'smartrecruiters'] as const) {
      const job = legacyPostingJob('foreign-signal', { source, postingPurpose: purpose })
      expect(JobSchema.safeParse(job).success).toBe(false)
      expect(SavedJobSchema.safeParse(legacyPostingSaved(job)).success).toBe(false)
    }
  })

  it('accepts old public and incremental records, enriches their bodies, and keeps all eight jobs', () => {
    const catalog = postingCatalog()
    const original = structuredClone(catalog)
    expect(isPublicCatalog(catalog)).toBe(true)
    const { cities: _cities, companies: _companies, jobs, ...metadata } = catalog
    expect(CatalogUpdateDataSchema.safeParse({
      catalog: metadata, companyIds: ['posting-alder', 'posting-birch', 'posting-cedar', 'posting-dogwood'], jobs,
    }).success).toBe(true)
    const current = upgradeCatalog(catalog)
    expect(current.jobs).toHaveLength(8)
    expect(current.jobs.filter(job => job.postingPurpose).map(job => job.id)).toEqual([
      'greenhouse-posting-alder-pool-london', 'greenhouse-posting-alder-pool-remote',
      'ashby-posting-birch-pool-unmapped', 'smartrecruiters-posting-dogwood-pool-paris',
    ])
    expect(current.fetchedAt).toBe(JOB_POSTING_TIME)
    expect(current.jobs.every(job => job.fetchedAt === JOB_POSTING_TIME && job.updatedAt === JOB_POSTING_UPDATED_AT)).toBe(true)
    expect(upgradeCatalog(current)).toEqual(current)
    expect(catalog).toEqual(original)
  })

  it.each([4, 5])('cache version %i keeps pools, ordinary jobs and full publication history without renewing dates', version => {
    const future = legacyPostingJob('cached-future', { stale: true })
    const prospect = normalizeJob(postingGreenhouseRaw(), 'posting-alder', JOB_POSTING_TIME)!
    const ordinary = legacyPostingJob('cached-opening', { title: 'Backend Engineer', description: JOB_POSTING_ORDINARY_PARAGRAPH })
    const input = { version, boards: [{
      companyId: 'posting-alder', provider: 'greenhouse', board: 'AlderPurpose43',
      checkedAt: '2026-09-20T07:02:00.000Z', failures: 2, retryAt: '2026-09-20T07:05:00.000Z',
      snapshot: {
        fetchedAt: JOB_POSTING_TIME, jobs: [future, prospect, ordinary], total: 4, unmappedCount: 0,
        publishedIds: [
          'greenhouse-posting-alder-cached-future', 'greenhouse-posting-alder-4301',
          'greenhouse-posting-alder-cached-opening', 'greenhouse-posting-alder-outside-technical-scope',
        ],
      },
    }] }
    const original = structuredClone(input)
    const boards = parseCachedBoards(input)
    expect(boards).toHaveLength(1)
    expect(boards[0]).toMatchObject({
      companyId: 'posting-alder', provider: 'greenhouse', board: 'AlderPurpose43',
      checkedAt: '2026-09-20T07:02:00.000Z', failures: 2, retryAt: '2026-09-20T07:05:00.000Z',
      snapshot: { fetchedAt: JOB_POSTING_TIME, total: 4, unmappedCount: 0, publishedIds: input.boards[0].snapshot.publishedIds },
    })
    const stored = boards[0].snapshot!.jobs
    expect(stored.map(job => job.id)).toEqual([
      'greenhouse-posting-alder-cached-future', 'greenhouse-posting-alder-4301', 'greenhouse-posting-alder-cached-opening',
    ])
    expect(stored[0]).toMatchObject({ postingPurpose: descriptionPurpose(), stale: true, fetchedAt: JOB_POSTING_TIME, updatedAt: JOB_POSTING_UPDATED_AT })
    expect(stored[1].postingPurpose).toMatchObject({ basis: 'greenhouse-prospect', evidence: [{ source: 'board' }] })
    expect(stored[2]).not.toHaveProperty('postingPurpose')
    expect(parseCachedBoards({ version: 5, boards })).toEqual(boards)
    expect(input).toEqual(original)
  })

  it('migrates a saved body once while preserving note, applied status, source dates and JSON round trips', () => {
    const old = legacyPostingSaved()
    const original = structuredClone(old)
    const decoded = decodeSavedJobs(JSON.stringify([old, { invalid: true }]))
    expect(decoded.omitted).toBe(1)
    expect(decoded.records).toHaveLength(1)
    const saved = decoded.records[0]
    expect(saved).toMatchObject({
      savedAt: JOB_POSTING_SAVED_AT, status: 'applied', note: JOB_POSTING_NOTE,
      job: {
        id: 'greenhouse-posting-alder-legacy-future', url: 'https://example.com/jobs/posting/legacy-future',
        fetchedAt: JOB_POSTING_TIME, updatedAt: JOB_POSTING_UPDATED_AT, postingPurpose: descriptionPurpose(),
      },
    })
    const backup = createSavedBackup([saved], 0)
    const restored = parseSavedImport(backup)
    expect(restored.invalid).toBe(0)
    expect(restored.groups).toHaveLength(1)
    expect(restored.groups[0].variants).toEqual([saved])
    expect(parseSavedImport(createSavedBackup([old], 0)).groups[0].variants).toEqual([saved])
    expect(decodeSavedJobs(JSON.stringify([saved])).records).toEqual([saved])
    expect(old).toEqual(original)
    expect(old.job).not.toHaveProperty('postingPurpose')
  })

  it('preserves full-body evidence outside the retained description without inventing it for an old truncated record', () => {
    const body = 'Engineering team notes about reliable infrastructure.\n\n'.repeat(550) + JOB_POSTING_FUTURE_PARAGRAPH
    const job = normalized('greenhouse', body)
    expect(job.description).not.toContain(JOB_POSTING_FUTURE_PARAGRAPH)
    const saved = SavedJobSchema.parse(legacyPostingSaved(job))
    const restored = parseSavedImport(createSavedBackup([saved], 0)).groups[0].variants[0]
    expect(restored.job.postingPurpose).toEqual(descriptionPurpose())
    expect(restored.job.description).toBe(job.description)
    expect(restored.job.fetchedAt).toBe(JOB_POSTING_TIME)
    const old = legacyPostingJob('truncated-without-purpose', { description: job.description })
    expect(upgradeJob(old)).not.toHaveProperty('postingPurpose')
  })
})

describe('revision semantics keep publication separate from purpose', () => {
  it('canonical old-body enrichment does not fabricate any changed revision section', async () => {
    const old = legacyPostingJob()
    const current = upgradeJob(old)
    expect(current.postingPurpose).toEqual(descriptionPurpose())
    const revision = await createJobRevision(old)
    expect(await createJobRevision(current)).toEqual(revision)
    expect(await createJobRevision(upgradeJob(current))).toEqual(revision)
    expect(old).not.toHaveProperty('postingPurpose')
  })

  it('a same-ID metadata-only purpose change affects conditions but never means a published post is closed', async () => {
    const old = normalizeJob(postingGreenhouseRaw({ internal_job_id: 7301 }), 'posting-alder', JOB_POSTING_TIME)!
    const current = normalizeJob(postingGreenhouseRaw(), 'posting-alder', JOB_POSTING_TIME)!
    expect(old).not.toHaveProperty('postingPurpose')
    expect(current.postingPurpose?.basis).toBe('greenhouse-prospect')
    expect(current.id).toBe('greenhouse-posting-alder-4301')
    expect(current.description).toBe(old.description)
    const before = await createJobRevision(old)
    const after = await createJobRevision(current)
    const sections = ['title', 'location', 'conditions', 'compensation', 'qualifications', 'description', 'url'] as const
    expect(sections.filter(section => before[section] !== after[section])).toEqual(['conditions'])
    const index = PostingStatusIndexSchema.parse({
      version: 1, checkedAt: JOB_POSTING_NOW, refreshAfter: '2026-09-20T07:13:00.000Z',
      boards: [{
        companyId: 'posting-alder', provider: 'greenhouse', board: 'AlderPurpose43',
        checkedAt: JOB_POSTING_NOW, lastSuccessAt: JOB_POSTING_TIME, retryAt: null, status: 'ok',
        listing: {
          validUntil: '2026-09-20T07:30:00.000Z', publishedIds: ['greenhouse-posting-alder-4301'],
          jobs: [{ id: current.id, title: current.title, url: current.url, revision: after }],
        },
      }],
    })
    expect(observeSavedPosting(legacyPostingSaved(old), index, before, Date.parse(JOB_POSTING_NOW)))
      .toMatchObject({ state: 'listed', changedFields: ['conditions'] })
    expect(observeSavedPosting(legacyPostingSaved(current), index, after, Date.parse(JOB_POSTING_NOW)))
      .toMatchObject({ state: 'listed', changedFields: [] })
  })
})

function localExploration(postingType: unknown) {
  const values = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  })
  values.set(STORAGE_KEYS.exploration, JSON.stringify({
    source: 'public', selectedId: 'london', panelTab: 'cities', mapMode: 'flat', light: false, citySort: 'salary',
    filters: { ...JOB_POSTING_FILTERS, query: 'Backend Engineer', region: 'europe', employment: 'fulltime', postingType },
  }))
  return values
}

describe('purpose filter migration and independently counted search scopes', () => {
  it.each([undefined, null, 'unrecognized', true, {}])('old or invalid saved purpose %s defaults to openings without erasing other conditions', value => {
    localExploration(value)
    expect(loadExploration(JOB_POSTING_PROFILE)).toMatchObject({
      source: 'public', selectedId: 'london', panelTab: 'cities', mapMode: 'flat', citySort: 'salary',
      filters: { postingType: 'opening', query: 'Backend Engineer', region: 'europe', role: 'backend', employment: 'fulltime' },
    })
  })

  it.each(['talent-pool', 'all'] as const)('explicit %s survives reload and is cleared by memory opt-out', postingType => {
    localExploration(postingType)
    const state = loadExploration(JOB_POSTING_PROFILE)
    expect(state.filters.postingType).toBe(postingType)
    expect(persistExploration(state, true)).toBe(true)
    expect(loadExploration(JOB_POSTING_PROFILE)).toEqual(state)
    expect(persistExploration(state, false)).toBe(true)
    expect(loadExploration(JOB_POSTING_PROFILE)).toMatchObject({
      source: 'public', selectedId: null, panelTab: 'cities', filters: { postingType: 'opening', query: '' },
    })
  })

  it('counts only explicit nondefault purpose as an active filter', () => {
    expect(DEFAULT_FILTERS.postingType).toBe('opening')
    expect(countFilters({ ...DEFAULT_FILTERS, postingType: 'opening' })).toBe(0)
    expect(countFilters({ ...DEFAULT_FILTERS, postingType: 'talent-pool' })).toBe(1)
    expect(countFilters({ ...DEFAULT_FILTERS, postingType: 'all' })).toBe(1)
  })

  it.each([
    {
      postingType: 'opening', total: 4,
      ids: ['ashby-posting-birch-open-paris', 'greenhouse-posting-alder-open-london', 'lever-posting-cedar-open-remote', 'lever-posting-cedar-open-unmapped'],
      cities: { jobs: 2, companies: 2, cities: 2 }, london: { jobs: 1, companies: 1, cities: 1 },
      remote: { jobs: 1, companies: 1, cities: 0 }, unmapped: { jobs: 1, companies: 1, cities: 0 },
    },
    {
      postingType: 'talent-pool', total: 4,
      ids: ['ashby-posting-birch-pool-unmapped', 'greenhouse-posting-alder-pool-london', 'greenhouse-posting-alder-pool-remote', 'smartrecruiters-posting-dogwood-pool-paris'],
      cities: { jobs: 2, companies: 2, cities: 2 }, london: { jobs: 1, companies: 1, cities: 1 },
      remote: { jobs: 1, companies: 1, cities: 0 }, unmapped: { jobs: 1, companies: 1, cities: 0 },
    },
    {
      postingType: 'all', total: 8,
      ids: ['ashby-posting-birch-open-paris', 'ashby-posting-birch-pool-unmapped', 'greenhouse-posting-alder-open-london', 'greenhouse-posting-alder-pool-london', 'greenhouse-posting-alder-pool-remote', 'lever-posting-cedar-open-remote', 'lever-posting-cedar-open-unmapped', 'smartrecruiters-posting-dogwood-pool-paris'],
      cities: { jobs: 4, companies: 3, cities: 2 }, london: { jobs: 2, companies: 1, cities: 1 },
      remote: { jobs: 2, companies: 2, cities: 0 }, unmapped: { jobs: 2, companies: 2, cities: 0 },
    },
  ] as const)('$postingType has literal city, company, remote and unmapped counts', expected => {
    const catalog = postingCatalog()
    const entries = selectSearchJobs(createSearchIndex(catalog, JOB_POSTING_PROFILE), { ...JOB_POSTING_FILTERS, postingType: expected.postingType })
    expect(entries).toHaveLength(expected.total)
    expect(entries.map(entry => entry.job.id).sort()).toEqual(expected.ids)
    expect(countSearchJobs(entries, { kind: 'cities' }, 'all')).toEqual(expected.cities)
    expect(countSearchJobs(entries, { kind: 'city', cityId: 'london' }, 'all')).toEqual(expected.london)
    expect(countSearchJobs(entries, { kind: 'remote' }, 'all')).toEqual(expected.remote)
    expect(countSearchJobs(entries, { kind: 'unmapped' }, 'all')).toEqual(expected.unmapped)
    expect(catalog.jobs).toHaveLength(8)
    expect(catalog.jobs.every(job => !job.postingPurpose)).toBe(true)
  })

  it('reuses ranking across opening, pool, all and back without retaining excluded records', () => {
    const rank = createSearchRanker(createSearchIndex(postingCatalog(), JOB_POSTING_PROFILE), JOB_POSTING_PROFILE)
    const openings = [
      'greenhouse-posting-alder-open-london', 'ashby-posting-birch-open-paris',
      'lever-posting-cedar-open-remote', 'lever-posting-cedar-open-unmapped',
    ]
    expect(rank(JOB_POSTING_FILTERS).map(item => item.job.id)).toEqual(openings)
    expect(rank({ ...JOB_POSTING_FILTERS, postingType: 'talent-pool' }).map(item => item.job.id)).toEqual([
      'greenhouse-posting-alder-pool-london', 'greenhouse-posting-alder-pool-remote',
      'ashby-posting-birch-pool-unmapped', 'smartrecruiters-posting-dogwood-pool-paris',
    ])
    expect(rank({ ...JOB_POSTING_FILTERS, postingType: 'all' }).map(item => item.job.id)).toEqual([
      'greenhouse-posting-alder-open-london', 'greenhouse-posting-alder-pool-london', 'greenhouse-posting-alder-pool-remote',
      'ashby-posting-birch-open-paris', 'ashby-posting-birch-pool-unmapped',
      'lever-posting-cedar-open-remote', 'lever-posting-cedar-open-unmapped', 'smartrecruiters-posting-dogwood-pool-paris',
    ])
    expect(rank(JOB_POSTING_FILTERS).map(item => item.job.id)).toEqual(openings)
  })

  it('proposes only an explicit purpose expansion for an empty city while another city has an opening, then undoes only that change', () => {
    const jobs = postingScopeJobs().filter(job => [
      'greenhouse-posting-alder-pool-london', 'ashby-posting-birch-open-paris',
    ].includes(job.id))
    const index = createSearchIndex(postingCatalog(jobs), JOB_POSTING_PROFILE)
    const filters: Filters = { ...JOB_POSTING_FILTERS, region: 'europe', workMode: 'onsite', query: 'Backend Engineer' }
    const scope = { kind: 'city' as const, cityId: 'london' }
    const analysis = analyzeSearchRecovery(index, filters, scope)
    expect(analysis).toMatchObject({
      available: 1, profileExcluded: 0,
      alternatives: [{ scope: { kind: 'cities' }, count: { jobs: 1, companies: 1, cities: 1 } }],
      suggestions: [{ changes: { postingType: 'all' }, count: { jobs: 1, companies: 1, cities: 1 } }],
    })
    expect(analysis!.suggestions).toHaveLength(1)
    expect(countSearchJobs(selectSearchJobs(index, filters), scope, 'europe')).toEqual({ jobs: 0, companies: 0, cities: 0 })
    const expanded: Filters = { ...filters, postingType: 'all' }
    expect(countSearchJobs(selectSearchJobs(index, expanded), scope, 'europe')).toEqual({ jobs: 1, companies: 1, cities: 1 })
    expect(undoRecoveryChanges({ ...expanded, query: 'Alder' }, filters, { postingType: 'all' })).toEqual({ ...filters, query: 'Alder' })
    expect(filters.postingType).toBe('opening')
  })
})
