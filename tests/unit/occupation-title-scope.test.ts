import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseCachedBoards } from '../../server/board-cache'
import { normalizeJob } from '../../server/normalize'
import { fetchGreenhouseBoard } from '../../server/providers/greenhouse'
import { fetchAshbyBoard } from '../../server/providers/ashby'
import { fetchLeverBoard } from '../../server/providers/lever'
import { createSmartRecruitersFetcher } from '../../server/providers/smartrecruiters'
import { isTechnicalJob, occupationFacts, upgradeJobOccupation } from '../../shared/job-occupation'
import { classifyJobRoles, jobRoleEvidence, jobRoleLabel, jobRoles, matchesJobRole } from '../../shared/job-roles'
import { upgradeCatalog } from '../../shared/job-upgrade'
import { createSearchIndex, selectSearchJobs } from '../../shared/job-search'
import { createSavedBackup, parseSavedImport } from '../../shared/saved-backup'
import { decodeSavedJobs } from '../../shared/saved-jobs'
import { JobSchema } from '../../shared/schemas'
import { observeSavedPosting } from '../../shared/posting-status'
import type { PostingStatusIndex } from '../../shared/posting-status'
import { DEFAULT_FILTERS } from '../../shared/types'
import type { Catalog, Job } from '../../shared/types'
import {
  OUTSIDE_SCOPE_CASES, TECHNICAL_SCOPE_CASES, CONFIRMED_EXTRA_SCOPE_CASES, SCOPE_COMPANY, SCOPE_TIME,
  FLIGHT_SOFTWARE_INFRASTRUCTURE_CASE, legacyScopeJob, legacyScopeSaved, scopeJob,
} from '../fixtures/occupation-title-scope'
import type { ScopeCase } from '../fixtures/occupation-title-scope'
import { smartRecruitersPosting } from '../fixtures/public-postings'
import { SEARCH_PROFILE, searchCatalog } from '../fixtures/search-catalog'

// Current assessments use occupation v5 and must keep reading versions 1/2/3/4.
// A general requirement for every Engineer to prove its duties is out of scope.
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

const htmlBody = (text: string) => text.split('\n').map(line => `<p>${line}</p>`).join('')
function normalized(fixture: ScopeCase, id = 1) {
  return normalizeJob({
    id, title: fixture.title, content: htmlBody(fixture.description),
    departments: fixture.departments.map(name => ({ name })),
    location: { name: 'London, UK' }, absolute_url: `https://example.org/fable-orbit/${id}`,
  }, 'fable-orbit', SCOPE_TIME)
}

function catalogWith(jobs: Job[]): Catalog {
  const base = searchCatalog([])
  return {
    ...base, fetchedAt: SCOPE_TIME, companies: [SCOPE_COMPANY], jobs, unmappedCount: 0,
    boards: [{
      companyId: 'fable-orbit', provider: 'greenhouse', board: 'fable-orbit',
      status: 'ok', dataStatus: 'fresh', total: jobs.length, included: jobs.length,
      checkedAt: SCOPE_TIME, lastSuccessAt: SCOPE_TIME, retryAt: null,
    }],
  }
}

describe('the actual position, rather than its developer audience or engineering department', () => {
  it.each([...OUTSIDE_SCOPE_CASES, ...TECHNICAL_SCOPE_CASES, ...CONFIRMED_EXTRA_SCOPE_CASES])('$key has literal occupation and exploration expectations', fixture => {
    const occupation = occupationFacts(fixture)
    const roleClassification = classifyJobRoles(fixture.title, fixture.departments, occupation)
    const job = scopeJob(fixture, { occupation, roleClassification, role: roleClassification.roles[0] ?? 'unknown' })
    expect({
      version: occupation.version, category: occupation.category, explorable: isTechnicalJob(job),
      allRoleFilter: matchesJobRole(job, 'all'), roles: jobRoles(job),
    }).toEqual({
      version: 5, category: fixture.expectedCategory, explorable: fixture.expectedExplorable,
      allRoleFilter: fixture.expectedExplorable, roles: fixture.expectedRoles,
    })
  })

  it.each(OUTSIDE_SCOPE_CASES)('new collection drops $key even when its body mentions engineering tools', fixture => {
    expect(normalized(fixture)).toBeNull()
  })

  it.each(TECHNICAL_SCOPE_CASES)('new collection retains the computing position $key', fixture => {
    const job = normalized(fixture)
    expect(job).not.toBeNull()
    expect(job?.occupation?.version).toBe(5)
    expect(job?.occupation?.category).toBe(fixture.expectedCategory)
    expect(job?.title).toBe(fixture.title)
    expect(job?.fetchedAt).toBe('2026-09-26T07:00:00.000Z')
    expect(jobRoles(job!)).toEqual(fixture.expectedRoles)
  })

  it.each(CONFIRMED_EXTRA_SCOPE_CASES)('applies the confirmed primary-role boundary when collecting $key', fixture => {
    const job = normalized(fixture)
    if (!fixture.expectedExplorable) {
      expect(job).toBeNull()
      return
    }
    expect(job).toMatchObject({
      title: fixture.title, fetchedAt: '2026-09-26T07:00:00.000Z',
      occupation: { version: 5, category: fixture.expectedCategory },
    })
    expect(jobRoles(job!)).toEqual(fixture.expectedRoles)
  })

  it.each(['Engineer', 'Marketing Engineer', 'Developer Relations Engineer'])('preserves the existing title-only acceptance for %s', title => {
    const occupation = occupationFacts({ title, description: '', departments: ['Marketing'] })
    expect(occupation).toMatchObject({ version: 5, category: 'engineering' })
    const job = normalized({
      key: 'title-only', title, description: '', departments: ['Marketing'],
      expectedCategory: 'engineering', expectedExplorable: true, expectedRoles: [],
    })
    expect(job).toMatchObject({ title, occupation: { version: 5, category: 'engineering' } })
    expect(isTechnicalJob(job!)).toBe(true)
    expect(jobRoles(job!)).toEqual([])
  })

  it.each([
    'EDA Engineer (RFIC Engineering)',
    'EDA Engineer for RFIC Engineering',
    'EDA Engineer | RFIC Engineering',
    'RTL Design Engineer — Avionics',
    'RTL Design Engineer, Materials Engineering',
  ])('keeps the existing generic-engineer scope when %s only names a physical target team', title => {
    // Preserve the existing policy. This does not assert that every real EDA
    // or RTL vacancy has the same duties or settle the broader scope question.
    const occupation = occupationFacts({ title, description: '', departments: ['RFIC Engineering'] })
    expect(occupation).toMatchObject({ version: 5, category: 'engineering' })
    expect(isTechnicalJob(scopeJob(TECHNICAL_SCOPE_CASES[0], { title, description: '', occupation }))).toBe(true)
  })

  it.each([
    'Senior Product Designer — Developer Success',
    'Product Designer for Software Developers',
    'Administrative Business Partner | Engineering',
    'Executive Assistant (Software Engineering)',
    'Developer Engagement Representative, Community Programs',
  ])('does not turn a delimiter or audience qualifier into a development position: %s', title => {
    const occupation = occupationFacts({
      title, description: OUTSIDE_SCOPE_CASES[1].description, departments: ['Engineering'],
    })
    expect(occupation.category).toBe('other')
  })
})

describe('occupation v3 records, cache metadata and saved source material', () => {
  it.each([1, 2, 3, 4, 5] as const)('accepts the explicit occupation format v%s', version => {
    const input = {
      ...scopeJob(TECHNICAL_SCOPE_CASES[0]),
      occupation: {
        version, category: 'engineering',
        evidence: [{ source: 'title', text: 'Software Engineer, Product Designer Tools' }],
        departments: ['Product Design'],
      },
    }
    expect(JobSchema.safeParse(input).success).toBe(true)
  })

  it.each([0, 6] as const)('rejects unsupported occupation format v%s', version => {
    const input = legacyScopeJob()
    expect(JobSchema.safeParse({ ...input, occupation: { ...input.occupation, version } }).success).toBe(false)
  })

  it.each([1, 2, 3] as const)('accepts old occupation v%s and reclassifies it without rewriting the source snapshot', version => {
    const original = legacyScopeJob(OUTSIDE_SCOPE_CASES[1], version)
    const untouched = structuredClone(original)
    expect(JobSchema.safeParse(original).success).toBe(true)
    const current = upgradeJobOccupation(original)
    expect(current.occupation).toMatchObject({ version: 5, category: 'other' })
    expect(JobSchema.safeParse(current).success).toBe(true)
    expect(isTechnicalJob(current)).toBe(false)
    expect({ ...current, occupation: original.occupation }).toEqual(original)
    expect(original).toEqual(untouched)
    expect(upgradeJobOccupation(current)).toEqual(current)
    expect(jobRoles(current)).toEqual([])
    expect(jobRoleEvidence(current)).toEqual([])
    expect(jobRoleLabel(current)).toBe('기타 직군')
    expect(matchesJobRole(current, 'all')).toBe(false)
    expect(matchesJobRole(current, 'devops')).toBe(false)
  })

  it('filters a v3 board snapshot, adjusts only retained unmapped exclusions and preserves the full public listing', () => {
    const administrator = {
      ...legacyScopeJob(), cityIds: [], locationLabel: 'Fictional unlocated office',
    }
    const engineer = scopeJob(TECHNICAL_SCOPE_CASES[0])
    const entry = {
      companyId: 'fable-orbit', provider: 'greenhouse', board: 'fable-orbit',
      checkedAt: '2026-09-26T07:03:00.000Z', retryAt: '2026-09-26T07:08:00.000Z',
      failures: 2, error: 'Fictional HTTP 503',
      snapshot: {
        fetchedAt: SCOPE_TIME, total: 4, unmappedCount: 2, jobs: [administrator, engineer],
        publishedIds: [
          'greenhouse-fable-orbit-administrator', 'greenhouse-fable-orbit-designer-tools',
          'greenhouse-fable-orbit-unretained-1', 'greenhouse-fable-orbit-unretained-2',
        ],
      },
    }
    const untouched = structuredClone(entry)
    const loaded = parseCachedBoards({ version: 5, boards: [entry] })
    expect(loaded).toHaveLength(1)
    expect(loaded[0]).toMatchObject({
      checkedAt: '2026-09-26T07:03:00.000Z', retryAt: '2026-09-26T07:08:00.000Z',
      failures: 2, error: 'Fictional HTTP 503',
      snapshot: {
        fetchedAt: '2026-09-26T07:00:00.000Z', total: 4, unmappedCount: 1,
        publishedIds: [
          'greenhouse-fable-orbit-administrator', 'greenhouse-fable-orbit-designer-tools',
          'greenhouse-fable-orbit-unretained-1', 'greenhouse-fable-orbit-unretained-2',
        ],
      },
    })
    expect(loaded[0].snapshot?.jobs.map(job => job.id)).toEqual(['greenhouse-fable-orbit-designer-tools'])
    expect(loaded[0].snapshot?.jobs[0]).toMatchObject({
      fetchedAt: '2026-09-26T07:00:00.000Z', title: 'Software Engineer, Product Designer Tools',
      description: TECHNICAL_SCOPE_CASES[0].description,
      occupation: { version: 5, category: 'engineering' },
    })
    expect(parseCachedBoards({ version: 5, boards: loaded })).toEqual(loaded)
    expect(entry).toEqual(untouched)
    const unknownCount = parseCachedBoards({ version: 5, boards: [{
      ...entry, snapshot: { ...entry.snapshot, unmappedCount: null },
    }] })
    expect(unknownCount[0].snapshot?.unmappedCount).toBeNull()
    expect(parseCachedBoards({ version: 5, boards: [{
      ...entry, snapshot: { ...entry.snapshot, unmappedCount: 0 },
    }] })).toEqual([])
  })

  it('keeps an empty technical board with its original total and all-job IDs', () => {
    const entries = parseCachedBoards({ version: 5, boards: [{
      companyId: 'fable-orbit', provider: 'greenhouse', board: 'fable-orbit',
      checkedAt: SCOPE_TIME, retryAt: null, failures: 0,
      snapshot: {
        fetchedAt: SCOPE_TIME, total: 1, unmappedCount: 0,
        jobs: [legacyScopeJob()], publishedIds: ['greenhouse-fable-orbit-administrator'],
      },
    }] })
    expect(entries).toHaveLength(1)
    expect(entries[0].snapshot).toEqual({
      fetchedAt: '2026-09-26T07:00:00.000Z', total: 1, unmappedCount: 0,
      jobs: [], publishedIds: ['greenhouse-fable-orbit-administrator'],
    })
  })

  it('removes stale occupation and role labels from public search after reading v3 data', () => {
    const original = catalogWith([legacyScopeJob(), scopeJob(TECHNICAL_SCOPE_CASES[0])])
    const current = upgradeCatalog(original)
    expect(current.jobs.map(job => job.id)).toEqual(['greenhouse-fable-orbit-designer-tools'])
    expect(current.boards[0]).toMatchObject({ total: 2, included: 1 })
    expect(current.fetchedAt).toBe('2026-09-26T07:00:00.000Z')
    const index = createSearchIndex(original, { ...SEARCH_PROFILE, desiredRole: 'all', skills: [] })
    expect(selectSearchJobs(index, DEFAULT_FILTERS).map(entry => entry.job.id)).toEqual(['greenhouse-fable-orbit-designer-tools'])
    expect(selectSearchJobs(index, { ...DEFAULT_FILTERS, query: 'Administrative' })).toEqual([])
    expect(selectSearchJobs(index, { ...DEFAULT_FILTERS, role: 'devops' })).toEqual([])
    expect(original.jobs).toHaveLength(2)
  })

  it.each([1, 2, 3] as const)('retains a saved v%s record, its source, note and application state through export/import', version => {
    const original = legacyScopeSaved(version)
    const result = decodeSavedJobs(JSON.stringify([original]))
    expect(result.records).toHaveLength(1)
    const saved = result.records[0]
    expect(saved).toMatchObject({
      savedAt: '2026-09-25T09:15:00.000Z', status: 'applied',
      note: 'Fictional note: confirm the office schedule.',
      company: { id: 'fable-orbit', board: 'fable-orbit' },
      job: {
        id: 'greenhouse-fable-orbit-administrator',
        title: 'Administrative Business Partner - Engineering, Product and Design',
        description: OUTSIDE_SCOPE_CASES[1].description,
        url: 'https://example.org/fable-orbit/administrator',
        fetchedAt: '2026-09-26T07:00:00.000Z', occupation: { version: 5, category: 'other' },
      },
    })
    expect(saved.job.requirements).toEqual([])
    expect(saved.job.roleClassification).toEqual({
      version: 1, roles: ['devops'],
      evidence: [{ role: 'devops', source: 'board', text: 'Infrastructure' }],
    })
    expect(jobRoles(saved.job)).toEqual([])
    expect(parseSavedImport(createSavedBackup([saved])).groups[0].variants[0]).toEqual(saved)
    expect(original.job.occupation?.category).toBe('engineering')
  })

  it('uses complete publishedIds so reclassification alone cannot imply that a saved posting closed', () => {
    const saved = decodeSavedJobs(JSON.stringify([legacyScopeSaved()])).records[0]
    const index: PostingStatusIndex = {
      version: 1, checkedAt: '2026-09-26T07:03:00.000Z', refreshAfter: '2026-09-26T07:04:00.000Z',
      boards: [{
        companyId: 'fable-orbit', provider: 'greenhouse', board: 'fable-orbit',
        status: 'ok', checkedAt: '2026-09-26T07:03:00.000Z', lastSuccessAt: '2026-09-26T07:03:00.000Z',
        retryAt: null, listing: {
          validUntil: '2026-09-26T07:33:00.000Z',
          publishedIds: ['greenhouse-fable-orbit-administrator'], jobs: [],
        },
      }],
    }
    expect(observeSavedPosting(saved, index, undefined, Date.parse('2026-09-26T07:03:10.000Z'))).toEqual({
      state: 'listed', checkedAt: '2026-09-26T07:03:00.000Z',
      message: '게시판에는 있지만 현재 탐색 범위 밖의 공고라 내용은 원문에서 확인해야 합니다.',
    })
    expect(observeSavedPosting(saved, index, undefined, Date.parse('2026-09-26T07:33:00.000Z')).state).toBe('unknown')
    const missing = structuredClone(index)
    missing.boards[0].listing!.publishedIds = []
    expect(observeSavedPosting(saved, missing, undefined, Date.parse('2026-09-26T07:03:10.000Z')).state).toBe('missing')
  })
})

const liveCases = [
  OUTSIDE_SCOPE_CASES[1], OUTSIDE_SCOPE_CASES[0], OUTSIDE_SCOPE_CASES[3], OUTSIDE_SCOPE_CASES[4],
  TECHNICAL_SCOPE_CASES[0], TECHNICAL_SCOPE_CASES[2], CONFIRMED_EXTRA_SCOPE_CASES[0],
  FLIGHT_SOFTWARE_INFRASTRUCTURE_CASE,
]
const providerCases = [
  {
    provider: 'greenhouse' as const,
    published: ['greenhouse-fable-orbit-101', 'greenhouse-fable-orbit-102', 'greenhouse-fable-orbit-103', 'greenhouse-fable-orbit-104', 'greenhouse-fable-orbit-105', 'greenhouse-fable-orbit-106', 'greenhouse-fable-orbit-107', 'greenhouse-fable-orbit-108'],
    included: ['greenhouse-fable-orbit-105', 'greenhouse-fable-orbit-106', 'greenhouse-fable-orbit-108'],
  },
  {
    provider: 'ashby' as const,
    published: ['ashby-fable-orbit-101', 'ashby-fable-orbit-102', 'ashby-fable-orbit-103', 'ashby-fable-orbit-104', 'ashby-fable-orbit-105', 'ashby-fable-orbit-106', 'ashby-fable-orbit-107', 'ashby-fable-orbit-108'],
    included: ['ashby-fable-orbit-105', 'ashby-fable-orbit-106', 'ashby-fable-orbit-108'],
  },
  {
    provider: 'lever' as const,
    published: ['lever-fable-orbit-101', 'lever-fable-orbit-102', 'lever-fable-orbit-103', 'lever-fable-orbit-104', 'lever-fable-orbit-105', 'lever-fable-orbit-106', 'lever-fable-orbit-107', 'lever-fable-orbit-108'],
    included: ['lever-fable-orbit-105', 'lever-fable-orbit-106', 'lever-fable-orbit-108'],
  },
]

describe('fresh provider results and pre-selection public listing identity', () => {
  it.each(providerCases)('$provider returns the three literal computing positions while listing all eight IDs', async ({ provider, published, included }) => {
    const rows = liveCases.map((fixture, index) => ({
      id: 101 + index, title: fixture.title, absolute_url: `https://example.org/fable-orbit/${101 + index}`,
      content: htmlBody(fixture.description), location: { name: 'London, UK' },
      departments: fixture.departments.map(name => ({ name })),
    }))
    const payload = provider === 'greenhouse' ? { jobs: rows, meta: { total: 8 } }
      : provider === 'ashby' ? {
        apiVersion: '1', jobs: rows.map((row, index) => ({
          id: String(row.id), title: row.title, jobUrl: row.absolute_url, isListed: true,
          location: 'London, UK', department: liveCases[index].departments[0],
          descriptionPlain: liveCases[index].description,
        })),
      } : rows.map((row, index) => ({
        id: String(row.id), text: row.title, hostedUrl: row.absolute_url,
        categories: { location: 'London, UK', department: liveCases[index].departments[0] },
        descriptionPlain: liveCases[index].description,
      }))
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(payload)))
    const fetcher = provider === 'greenhouse' ? fetchGreenhouseBoard : provider === 'ashby' ? fetchAshbyBoard : fetchLeverBoard
    const result = await fetcher({ ...SCOPE_COMPANY, provider }, SCOPE_TIME)
    expect(result.total).toBe(8)
    expect(result.publishedIds).toEqual(published)
    expect(result.unmappedCount).toBe(0)
    expect(result.jobs.map(job => job.id)).toEqual(included)
    expect(result.jobs.map(job => job.title)).toEqual([
      'Software Engineer, Product Designer Tools', 'Frontend Engineer, Developer Community',
      'Flight Software Infrastructure Engineer',
    ])
  })

  it('reads a generic Design Engineer detail before deciding scope for a list-only provider', async () => {
    const input = [TECHNICAL_SCOPE_CASES[8], OUTSIDE_SCOPE_CASES[1]]
    const rows = input.map((fixture, index) => smartRecruitersPosting({
      id: String(301 + index), name: fixture.title, company: { identifier: 'FableScope' },
      location: { city: 'London', country: 'gb', fullLocation: 'London, UK' },
      function: { label: fixture.departments[0] },
      jobAd: { sections: {
        jobDescription: { title: 'Responsibilities', text: htmlBody(fixture.description) },
      } },
    }))
    const requested: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
      requested.push(url.pathname)
      if (url.search) return Response.json({
        offset: 0, limit: 100, totalFound: 2, content: rows.map(({ jobAd: _jobAd, ...summary }) => summary),
      })
      const detail = rows.find(row => url.pathname.endsWith(`/${row.id}`))
      if (!detail) throw new Error(`Unexpected fictional detail request: ${url.pathname}`)
      return Response.json(detail)
    }))
    const fetcher = createSmartRecruitersFetcher({ concurrency: 1, interval: 0, timeout: 120_000 })
    const result = await fetcher({ ...SCOPE_COMPANY, provider: 'smartrecruiters', board: 'FableScope' }, SCOPE_TIME)
    expect(requested).toEqual([
      '/v1/companies/FableScope/postings',
      '/v1/companies/FableScope/postings/301',
    ])
    expect(result.publishedIds).toEqual(['smartrecruiters-fable-orbit-301', 'smartrecruiters-fable-orbit-302'])
    expect(result.total).toBe(2)
    expect(result.jobs.map(job => job.title)).toEqual(['Design Engineer'])
  })
})
