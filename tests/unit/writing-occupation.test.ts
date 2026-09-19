import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchGreenhouseBoard } from '../../server/providers/greenhouse'
import { fetchAshbyBoard } from '../../server/providers/ashby'
import { fetchLeverBoard } from '../../server/providers/lever'
import { createSmartRecruitersFetcher } from '../../server/providers/smartrecruiters'
import { parseCachedBoards } from '../../server/board-cache'
import { normalizeJob } from '../../server/normalize'
import { occupationFacts, needsOccupationDescription, upgradeCatalogOccupations, upgradeJobOccupation } from '../../shared/job-occupation'
import { JobSchema } from '../../shared/schemas'
import { decodeSavedJobs } from '../../shared/saved-jobs'
import { createSavedBackup, parseSavedImport } from '../../shared/saved-backup'
import { createJobRevision } from '../../shared/posting-status'
import { OCCUPATION_VERSION } from '../../shared/types'
import type { Job, SavedJob } from '../../shared/types'
import { SEARCH_COMPANIES, SEARCH_TIME, searchCatalog } from '../fixtures/search-catalog'
import { smartRecruitersPosting } from '../fixtures/public-postings'

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })
const company = SEARCH_COMPANIES[0]
const writingBody = 'Responsibilities\nWrite brand campaigns and tutorials for developers.\nRequirements\nExperience with software development and technical writing.'
const writingTitles = [
  'Copywriter, Developer', 'Senior Technical Writer / Developer Educator', 'Engineering Writer — Developer Documentation',
  'Content Writer for Software Developers', 'Technical Editor - Developer Documentation',
  'Writer, Developer Tools', 'Copywriter (Software Developer audience)', 'Technical Writer for Engineering Managers',
]
function oldWriter(version: 1 | 2 = 2): Job {
  const title = 'Copywriter, Developer'
  // Other fact formats are current so this isolates the occupation migration.
  const base = normalizeJob({
    id: 7101, title: 'Software Engineer', absolute_url: 'https://example.com/writing-scope/saved',
    content: writingBody, location: { name: 'London, UK' },
  }, company.id, SEARCH_TIME)!
  return JSON.parse(JSON.stringify({
    ...base,
    title, description: writingBody, cityIds: [], locationLabel: 'Unmapped fixture office',
    occupation: { version, category: 'engineering', evidence: [{ source: 'title', text: title }], departments: ['Marketing'] },
  }))
}

describe('writing roles and developer audiences', () => {
  it('recognizes the writing role without promoting its developer audience or software qualifications', () => {
    for (const title of writingTitles) {
      const result = occupationFacts({ title, description: writingBody, departments: ['Engineering', 'Marketing'] })
      expect(result.category, title).toBe('other')
      expect(result.evidence).toEqual([{ source: 'title', text: title }])
      expect(result.departments).toEqual(['Engineering', 'Marketing'])
      expect(needsOccupationDescription(title), title).toBe(false)
    }
  })

  it('retains explicit engineering and research roles, including writing tools and marketing departments', () => {
    for (const title of [
      'Marketing Engineer', 'Senior Fullstack Engineer, Marketing', 'Recruiting Analytics Data Engineer',
      'Developer Relations Engineer', 'Software Engineer, Technical Writer Tools', 'Developer, Documentation',
      'Software Engineer / Technical Writer', 'Database Writer Engineer', 'Backend Developer, Writer Platform',
    ]) {
      expect(occupationFacts({ title, description: '', departments: ['Marketing', 'Tech Writing'] }).category, title).toBe('engineering')
      expect(needsOccupationDescription(title), title).toBe(true)
    }
    expect(occupationFacts({ title: 'AI Research Scientist, Technical Writer Tools', description: '' }).category).toBe('research')
  })

  it('keeps direct management roles and published management metadata ahead of writing scope', () => {
    expect(occupationFacts({ title: 'Technical Writer Manager', description: '' }).category).toBe('management')
    expect(occupationFacts({
      title: writingTitles[0], description: writingBody,
      management: { value: 'management', evidence: { source: 'board', text: 'Job Level: People Manager' } },
    })).toMatchObject({ category: 'management', evidence: [{ source: 'board', text: 'Job Level: People Manager' }] })
  })
})

describe('versioned writing scope across stored and collected records', () => {
  it.each([1, 2] as const)('reads occupation version %s and changes only the occupation assessment', version => {
    const original = oldWriter(version)
    expect(JobSchema.safeParse(original).success).toBe(true)
    const upgraded = upgradeJobOccupation(original)
    expect(upgraded).toEqual({ ...original, occupation: { ...original.occupation, version: OCCUPATION_VERSION, category: 'other' } })
    expect(original.occupation).toMatchObject({ version, category: 'engineering' })
    expect(upgradeJobOccupation(upgraded)).toBe(upgraded)
  })

  it('updates old catalog and cache counts while retaining full published IDs and original failure and expiry metadata', () => {
    const writer = oldWriter()
    const engineer = normalizeJob({
      id: 7102, title: 'Software Engineer, Content Tools', absolute_url: 'https://example.com/writing-scope/engineering',
      content: writingBody, location: { name: 'London, UK' },
    }, company.id, SEARCH_TIME)!
    const publishedIds = [writer.id, engineer.id, `greenhouse-${company.id}-outside`]
    const cached = {
      companyId: company.id, provider: 'greenhouse', board: company.board,
      checkedAt: SEARCH_TIME, retryAt: '2026-09-19T08:36:00.000Z', failures: 2, error: 'HTTP 503',
      snapshot: { fetchedAt: SEARCH_TIME, total: 3, unmappedCount: 2, publishedIds, jobs: [writer, engineer] },
    }
    const loaded = parseCachedBoards({ version: 5, boards: [cached] })[0]
    expect(loaded).toEqual({
      ...cached, snapshot: { ...cached.snapshot, unmappedCount: 1, jobs: [upgradeJobOccupation(engineer)] },
    })
    expect(cached.snapshot.jobs).toHaveLength(2)
    const old = searchCatalog([writer, engineer])
    old.checkedAt = '2026-09-19T08:02:00.000Z'
    const upgraded = upgradeCatalogOccupations(old)
    expect(upgraded.jobs.map(job => job.id)).toEqual([engineer.id])
    expect(upgraded.boards[0]).toMatchObject({ total: 2, included: 1 })
    expect(upgraded).toMatchObject({ fetchedAt: old.fetchedAt, checkedAt: old.checkedAt, unmappedCount: 0 })
  })

  it('keeps saved writing jobs and portable backups with their notes, status and original dates', async () => {
    const saved: SavedJob = { job: oldWriter(), company, savedAt: '2026-09-19T08:01:00.000Z', status: 'applied', note: 'Retain this writing opportunity' }
    const restored = decodeSavedJobs(JSON.stringify([saved])).records[0]
    expect(restored).toEqual({ ...saved, job: upgradeJobOccupation(saved.job) })
    expect(restored.job.occupation).toMatchObject({ version: OCCUPATION_VERSION, category: 'other' })
    const imported = parseSavedImport(createSavedBackup([saved])).groups[0].variants[0]
    expect(imported).toEqual(restored)
    expect(parseSavedImport(createSavedBackup([restored])).groups[0].variants[0]).toEqual(restored)
    expect(await createJobRevision(saved.job)).toEqual(await createJobRevision(restored.job))
  })

  it.each(['greenhouse', 'ashby', 'lever'] as const)('keeps all public %s IDs while excluding writing jobs from engineering results', async provider => {
    const titles = [writingTitles[0], writingTitles[1], 'Frontend Engineer, Marketing']
    const payload = provider === 'greenhouse' ? {
      jobs: titles.map((title, index) => ({
        id: index + 1, title, absolute_url: `https://example.com/writing-scope/${index}`,
        location: { name: 'London, UK' }, content: '<p>Write documentation and build developer tools.</p>',
      })), meta: { total: 3 },
    } : provider === 'ashby' ? {
      apiVersion: '1', jobs: titles.map((title, index) => ({
        id: String(index + 1), title, jobUrl: `https://example.com/writing-scope/${index}`,
        isListed: true, location: 'London', department: 'Marketing', descriptionPlain: writingBody,
      })),
    } : titles.map((text, index) => ({
      id: String(index + 1), text, hostedUrl: `https://example.com/writing-scope/${index}`,
      categories: { location: 'London', department: 'Marketing' }, descriptionPlain: writingBody,
    }))
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(payload)))
    const fetcher = provider === 'greenhouse' ? fetchGreenhouseBoard : provider === 'ashby' ? fetchAshbyBoard : fetchLeverBoard
    const result = await fetcher({ ...company, provider }, SEARCH_TIME)
    expect(result.total).toBe(3)
    expect(result.publishedIds).toEqual([1, 2, 3].map(id => `${provider}-${company.id}-${id}`))
    expect(result.jobs.map(job => job.title)).toEqual(['Frontend Engineer, Marketing'])
    expect(result.jobs[0].occupation).toMatchObject({ version: OCCUPATION_VERSION, category: 'engineering' })
  })

  it('does not fetch clearly editorial SmartRecruiters details but retains their public listing IDs', async () => {
    const smartCompany = { ...company, provider: 'smartrecruiters' as const, board: 'WritingFixture' }
    const titles = [writingTitles[0], writingTitles[1], 'Frontend Engineer, Marketing']
    const postings = titles.map((name, index) => smartRecruitersPosting({
      id: String(index + 1), name, company: { identifier: smartCompany.board },
    }))
    const requested: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
      requested.push(url.pathname)
      return Response.json(url.search ? { offset: 0, limit: 100, totalFound: 3, content: postings }
        : postings.find(posting => url.pathname.endsWith(`/${posting.id}`)))
    }))
    const fetcher = createSmartRecruitersFetcher({ concurrency: 2, interval: 0, timeout: 120_000 })
    const result = await fetcher(smartCompany, SEARCH_TIME)
    expect(requested).toEqual(['/v1/companies/WritingFixture/postings', '/v1/companies/WritingFixture/postings/3'])
    expect(result.publishedIds).toEqual([1, 2, 3].map(id => `smartrecruiters-${company.id}-${id}`))
    expect(result.jobs.map(job => job.title)).toEqual(['Frontend Engineer, Marketing'])
    expect(result.total).toBe(3)
  })
})
