import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseCachedBoards } from '../../server/board-cache'
import { createObservationStore } from '../../server/catalog-observations'
import { fetchAshbyBoard } from '../../server/providers/ashby'
import { observationComparison } from '../../shared/catalog-observations'
import { isTechnicalJob, needsOccupationDescription, occupationFacts, upgradeJobOccupation } from '../../shared/job-occupation'
import { jobRoleEvidence, jobRoleLabel, jobRoles, matchesJobRole } from '../../shared/job-roles'
import { createSearchIndex, selectSearchJobs } from '../../shared/job-search'
import { upgradeCatalog } from '../../shared/job-upgrade'
import { observeSavedPosting, PostingStatusIndexSchema } from '../../shared/posting-status'
import { createSavedBackup, parseSavedImport } from '../../shared/saved-backup'
import { decodeSavedJobs } from '../../shared/saved-jobs'
import { JobSchema } from '../../shared/schemas'
import { DEFAULT_FILTERS, OCCUPATION_VERSION } from '../../shared/types'
import {
  FINANCE_COMPANY, FINANCE_COMPUTING_CASES, FINANCE_DESCRIPTION, FINANCE_PRIMARY_TITLES,
  FINANCE_PROFILE, FINANCE_TIME, FINANCE_V4_METHOD, financeCatalog, financeFeed, financePostingIndex,
  legacyFinanceBoard, legacyFinanceDeveloper, legacyFinanceJob, legacyFinanceSaved,
} from '../fixtures/finance-occupation'

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('finance is the primary role and engineering can be its budget customer', () => {
  it.each(FINANCE_PRIMARY_TITLES)('excludes the stated financial position: %s', title => {
    const occupation = occupationFacts({ title, description: FINANCE_DESCRIPTION, departments: ['All Departments', 'Finance'] })
    expect(occupation.category).toBe('other')
    expect(occupation.evidence).toContainEqual({ source: 'title', text: title })
    const job = legacyFinanceJob({ title, occupation })
    expect(isTechnicalJob(job)).toBe(false)
    expect(matchesJobRole(job, 'all')).toBe(false)
    expect(jobRoles(job)).toEqual([])
    expect(jobRoleLabel(job)).toBe('기타 직군')
    expect(needsOccupationDescription(title)).toBe(false)
  })

  it.each(FINANCE_COMPUTING_CASES)('keeps the computing primary or co-role: $title', fixture => {
    const occupation = occupationFacts({ ...fixture, departments: ['All Departments', 'Finance'] })
    expect(occupation.category).toBe(fixture.category)
    const job = legacyFinanceJob({ title: fixture.title, description: fixture.description, occupation })
    expect(isTechnicalJob(job)).toBe(true)
    expect(matchesJobRole(job, 'all')).toBe(true)
    expect(jobRoles(job)).toEqual(fixture.roles)
    expect(needsOccupationDescription(fixture.title)).toBe(true)
  })

  it.each([{ departments: [] }, { departments: ['Finance'] }, { departments: ['Software Engineering'] }])('does not let department labels replace the primary title: $departments', ({ departments }) => {
    expect(occupationFacts({ title: 'Finance Analyst, Engineering', description: '', departments }).category).toBe('other')
    expect(occupationFacts({ title: 'Software Engineer', description: FINANCE_DESCRIPTION, departments }).category).toBe('engineering')
    expect(occupationFacts({ title: 'Scientist', description: FINANCE_DESCRIPTION, departments }).category).toBe('unconfirmed')
  })

  it.each([
    ['Finance Lead, Engineering', 'management', 'management'],
    ['Finance Lead, Engineering', 'individual', 'other'],
    ['Finance Lead, Engineering', 'unknown', 'other'],
    ['Software Engineer, Finance', 'management', 'management'],
    ['Lead Software Engineer, Finance', 'individual', 'engineering'],
  ] as const)('gives published people-management metadata precedence: %s / %s', (title, value, category) => {
    const management = { value, evidence: { source: 'board' as const, text: `Fictional job level: ${value}` } }
    expect(occupationFacts({ title, description: '', departments: ['Finance'], management }))
      .toMatchObject({ category, management })
  })

  it('keeps a Finance Manager a management position and mentorship alone an individual finance position', () => {
    expect(occupationFacts({ title: 'Finance Manager, Engineering', description: '' }).category).toBe('management')
    expect(occupationFacts({
      title: 'Finance Lead, Engineering',
      description: 'Responsibilities\nPrepare cost forecasts and mentor a colleague. This position has no direct reports.',
    }).category).toBe('other')
  })

  it('emits v5 and accepts historical v4 as well as v5, while rejecting adjacent unsupported versions', () => {
    expect(OCCUPATION_VERSION).toBe(5)
    expect(occupationFacts({ title: 'Finance Lead, Engineering', description: '' }).version).toBe(5)
    const legacy = legacyFinanceJob()
    for (const version of [1, 2, 3, 4, 5]) {
      expect(JobSchema.safeParse({ ...legacy, occupation: { ...legacy.occupation, version } }).success, `v${version}`).toBe(true)
    }
    for (const version of [0, 6]) {
      expect(JobSchema.safeParse({ ...legacy, occupation: { ...legacy.occupation, version } }).success, `v${version}`).toBe(false)
    }
  })
})

describe('fictional collection and v4 cache migration', () => {
  it('normalizes one Ashby feed to five computing jobs but preserves all eight published IDs', async () => {
    const fetch = vi.fn(async () => Response.json(financeFeed()))
    vi.stubGlobal('fetch', fetch)
    const result = await fetchAshbyBoard(FINANCE_COMPANY, FINANCE_TIME)
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(result).toMatchObject({
      total: 8, unmappedCount: 0,
      publishedIds: [
        'ashby-fable-ledger-101', 'ashby-fable-ledger-102', 'ashby-fable-ledger-103',
        'ashby-fable-ledger-201', 'ashby-fable-ledger-202', 'ashby-fable-ledger-203',
        'ashby-fable-ledger-204', 'ashby-fable-ledger-205',
      ],
    })
    expect(result.jobs.map(job => [job.id, job.title, jobRoles(job)])).toEqual([
      ['ashby-fable-ledger-201', 'Backend Software Engineer, Finance Ledger', ['backend']],
      ['ashby-fable-ledger-202', 'Backend Software Engineer, Finance Forecasts', ['backend']],
      ['ashby-fable-ledger-203', 'Financial Engineer, Finance Simulator', []],
      ['ashby-fable-ledger-204', 'Data Scientist, Finance Projections', ['data']],
      ['ashby-fable-ledger-205', 'Computer Science Researcher, Finance Algorithms', []],
    ])
    expect(result.jobs[0]).toMatchObject({
      source: 'ashby', fetchedAt: '2026-09-27T02:00:00.000Z', url: 'https://example.org/fable-ledger/201',
      occupation: { version: 5, category: 'engineering', departments: ['All Departments', 'Finance'] },
    })
  })

  it('removes only the retained unmapped finance record without renewing clocks, totals or the v4 observation method', () => {
    const entry = legacyFinanceBoard()
    entry.snapshot.jobs[0] = legacyFinanceJob({ cityIds: [], locationLabel: 'Fictional unlocated finance office' })
    entry.snapshot.unmappedCount = 2
    const original = structuredClone(entry)
    const result = parseCachedBoards({ version: 5, boards: [entry] })
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({
      checkedAt: '2026-09-27T02:00:00.000Z', retryAt: null, failures: 0,
      snapshot: {
        fetchedAt: '2026-09-27T02:00:00.000Z', total: 3, unmappedCount: 1,
        observationMethod: 'observations-1.occupation-4.roles-1.qualifications-1.remote-2.employment-1.purpose-1',
        publishedIds: ['ashby-fable-ledger-101', 'ashby-fable-ledger-201', 'ashby-fable-ledger-999'],
      },
    })
    expect(result[0].snapshot?.jobs.map(job => job.id)).toEqual(['ashby-fable-ledger-201'])
    expect(parseCachedBoards({ version: 5, boards: result })).toEqual(result)
    expect(entry).toEqual(original)
    expect(parseCachedBoards({ version: 5, boards: [{
      ...entry, snapshot: { ...entry.snapshot, unmappedCount: null },
    }] })[0].snapshot?.unmappedCount).toBeNull()
  })

  it('does not promote a cached v4 observation into a comparable v5 day on first read or restart', async () => {
    let file: unknown = { version: 1, series: [] }
    const cache = {
      load: async () => structuredClone(file),
      save: vi.fn(async (next: unknown) => { file = structuredClone(next) }),
    }
    const options = { companies: [FINANCE_COMPANY], cache, now: () => Date.parse('2026-09-27T02:02:00.000Z') }
    const entries = parseCachedBoards({ version: 5, boards: [legacyFinanceBoard()] })
    const store = createObservationStore(options)
    await store.record(entries, 'cache')
    const history = await store.read()
    expect(history.method).toBe('observations-1.occupation-5.roles-1.qualifications-1.remote-2.employment-1.purpose-1')
    expect(history.days).toHaveLength(1)
    expect(history.days[0]).toMatchObject({
      day: '2026-09-27', complete: {
        comparable: false, origin: 'cache',
        observedAt: '2026-09-27T02:00:00.000Z', recordedAt: '2026-09-27T02:02:00.000Z',
        stats: { published: 3, technical: 1, openings: 1, talentPools: 0 },
      },
    })
    expect(entries[0].snapshot?.observationMethod).toBe(FINANCE_V4_METHOD)
    const restarted = createObservationStore({ ...options, now: () => Date.parse('2026-09-28T02:02:00.000Z') })
    await restarted.record(entries, 'cache')
    expect(await restarted.read()).toEqual(history)
    expect(cache.save).toHaveBeenCalledTimes(1)
    expect(observationComparison(history.days)).toBeNull()
  })

  it('reads v4 catalogs through query, role and region filters without suggesting finance as an unknown developer', () => {
    const original = financeCatalog([legacyFinanceJob(), legacyFinanceDeveloper()], 3)
    const current = upgradeCatalog(original)
    expect(current.jobs.map(job => job.id)).toEqual(['ashby-fable-ledger-201'])
    expect(current.boards[0]).toMatchObject({ total: 3, included: 1 })
    const index = createSearchIndex(original, FINANCE_PROFILE)
    expect(selectSearchJobs(index, { ...DEFAULT_FILTERS, query: 'Finance', role: 'backend', region: 'europe' }).map(entry => entry.job.id))
      .toEqual(['ashby-fable-ledger-201'])
    for (const filters of [
      { ...DEFAULT_FILTERS, query: 'Strategic' },
      { ...DEFAULT_FILTERS, query: 'Finance', role: 'unknown' as const },
      { ...DEFAULT_FILTERS, query: 'Finance', region: 'americas' as const },
    ]) expect(selectSearchJobs(index, filters)).toEqual([])
    expect(original.jobs).toHaveLength(2)
  })
})

describe('v4 saved finance snapshots remain personal records', () => {
  it('upgrades only classification and preserves literal source content, identity, original times, memo and application state through JSON', () => {
    const original = legacyFinanceSaved()
    const untouched = structuredClone(original)
    const migrated = upgradeJobOccupation(original.job)
    expect(migrated.occupation).toMatchObject({ version: 5, category: 'other' })
    expect({ ...migrated, occupation: original.job.occupation }).toEqual(original.job)
    const decoded = decodeSavedJobs(JSON.stringify([original]))
    expect(decoded.omitted).toBe(0)
    expect(decoded.records).toHaveLength(1)
    const saved = decoded.records[0]
    expect(saved).toMatchObject({
      savedAt: '2026-09-26T03:04:05.000Z', status: 'applied',
      note: 'Fictional finance memo: keep the original forecast role.',
      company: { id: 'fable-ledger', name: 'Fable Ledger Lab', board: 'fable-ledger' },
      job: {
        id: 'ashby-fable-ledger-101', source: 'ashby',
        title: 'Strategic Finance Lead, Platform & Engineering', description: FINANCE_DESCRIPTION,
        url: 'https://example.org/fable-ledger/101', requirements: [],
        updatedAt: '2026-09-25T06:07:08.000Z', fetchedAt: '2026-09-27T02:00:00.000Z',
        occupation: { version: 5, category: 'other', departments: ['All Departments', 'Finance'] },
      },
    })
    expect(jobRoles(saved.job)).toEqual([])
    expect(jobRoleEvidence(saved.job)).toEqual([])
    const backup = createSavedBackup([saved], 0, new Date('2026-09-27T02:02:00.000Z'))
    expect(JSON.parse(backup)).toMatchObject({ exportedAt: '2026-09-27T02:02:00.000Z', includesUnsavedChanges: false })
    expect(parseSavedImport(backup).groups[0].variants[0]).toEqual(saved)
    expect(original).toEqual(untouched)
  })

  it('uses the complete v2 inventory to keep excluded finance listed without manufacturing a body comparison or body timestamp', () => {
    const saved = decodeSavedJobs(JSON.stringify([legacyFinanceSaved()])).records[0]
    const index = financePostingIndex()
    expect(PostingStatusIndexSchema.safeParse(index).success).toBe(true)
    expect(observeSavedPosting(saved, index, undefined, Date.parse('2026-09-27T02:00:10.000Z'))).toEqual({
      state: 'listed', checkedAt: '2026-09-27T02:00:00.000Z',
      contentCheckedAt: undefined, contentState: 'unavailable',
      message: '게시 여부는 확인했어요. 비교할 수 있는 최신 본문이 없어 내용의 차이는 미확인입니다. 공고 내용 확인이나 원문을 이용해 주세요.',
    })
    expect(observeSavedPosting(saved, index, undefined, Date.parse('2026-09-27T02:30:00.000Z')).state).toBe('unknown')
    index.boards[0].listing!.publishedIds = ['ashby-fable-ledger-201', 'ashby-fable-ledger-999']
    expect(observeSavedPosting(saved, index, undefined, Date.parse('2026-09-27T02:00:10.000Z')).state).toBe('missing')
  })
})
