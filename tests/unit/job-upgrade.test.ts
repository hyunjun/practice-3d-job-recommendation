import { describe, expect, it } from 'vitest'
import { BoardSnapshotSchema, filterBoardSnapshot } from '../../server/board-cache'
import { upgradeCatalog, upgradeJob, upgradeJobCollection } from '../../shared/job-upgrade'
import { createSearchIndex, selectSearchJobs } from '../../shared/job-search'
import { matchJob, formatJobSalary } from '../../shared/matching'
import { createJobRevision } from '../../shared/posting-status'
import { SavedJobSchema } from '../../shared/saved-jobs'
import { createSampleCatalog } from '../../shared/sample'
import { DEFAULT_FILTERS } from '../../shared/types'
import { currentUpgradeJob, legacyUpgradeJob } from '../fixtures/job-upgrade'
import { SEARCH_COMPANIES, SEARCH_PROFILE, SEARCH_TIME, searchCatalog } from '../fixtures/search-catalog'

describe('shared job read migration', () => {
  it('gives public results and saved snapshots the same original qualification rules and comparison', async () => {
    const previous = legacyUpgradeJob()
    const untouched = structuredClone(previous)
    const catalog = upgradeCatalog(searchCatalog([previous]))
    const saved = SavedJobSchema.parse({
      job: previous, company: SEARCH_COMPANIES[0], savedAt: SEARCH_TIME, status: 'applied', note: 'Private original note',
    })
    expect(catalog.jobs[0]).toEqual(saved.job)
    expect(catalog.jobs[0]).toEqual(currentUpgradeJob())
    expect(catalog.jobs[0]).toMatchObject({
      minExperience: 4, skills: ['TypeScript', 'Python', 'Go'],
      qualifications: { skills: [
        { kind: 'required', skills: ['TypeScript', 'Python'], match: 'any' },
        { kind: 'preferred', skills: ['Go'] },
      ] },
    })
    const profile = { ...SEARCH_PROFILE, years: 2 }
    expect(matchJob(previous, profile)).toEqual(matchJob(saved.job, profile))
    expect(matchJob(previous, profile).cautions).toContain('요구 경력 4년 · 현재 입력한 경력보다 2년 많아요')
    expect(await createJobRevision(previous)).toEqual(await createJobRevision(saved.job))
    expect(saved).toMatchObject({ savedAt: SEARCH_TIME, status: 'applied', note: 'Private original note', job: { fetchedAt: SEARCH_TIME } })
    expect(previous).toEqual(untouched)
  })

  it('does not use a company technology as an applicant skill when searching an old public response', () => {
    const catalog = searchCatalog([legacyUpgradeJob()])
    const filters = { ...DEFAULT_FILTERS, role: 'all' as const }
    expect(selectSearchJobs(createSearchIndex(catalog, { ...SEARCH_PROFILE, skills: ['React'] }), filters)).toEqual([])
    expect(selectSearchJobs(createSearchIndex(catalog, { ...SEARCH_PROFILE, skills: ['TypeScript'] }), filters).map(entry => entry.job.id)).toEqual([catalog.jobs[0].id])
  })

  it('applies all read migrations to a validated board while preserving public listing metadata', () => {
    const previous = legacyUpgradeJob()
    const snapshot = { fetchedAt: SEARCH_TIME, jobs: [previous], total: 2, unmappedCount: 0, publishedIds: [previous.id, 'greenhouse-search-fixture-a-unretained'] }
    const current = BoardSnapshotSchema.parse(snapshot)
    expect(current).toEqual({ ...snapshot, jobs: [currentUpgradeJob()] })
    expect(filterBoardSnapshot(current)).toEqual(current)
    expect(current.jobs[0]).toEqual(upgradeCatalog(searchCatalog([previous])).jobs[0])
  })

  it('preserves unverifiable old pay only for snapshots and does not silently renew its version', async () => {
    const previous = { ...legacyUpgradeJob(), salary: { min: 100000, max: 140000, currency: 'USD' as const }, compensationVersion: undefined }
    const stored = upgradeJob(previous, { preserveUnverifiablePay: true })
    expect(stored.salary).toEqual(previous.salary)
    expect(stored.compensationVersion).toBeUndefined()
    expect(formatJobSalary(stored)).toContain('이전 기록')
    expect(upgradeJob(previous).salary).toBeNull()
    expect(stored.qualifications).toEqual(currentUpgradeJob().qualifications)
    expect(await createJobRevision(previous)).toEqual(await createJobRevision(stored))
    expect(previous.salary).toEqual({ min: 100000, max: 140000, currency: 'USD' })
  })

  it('adjusts location conflicts and removed occupations together without losing count-only omissions', () => {
    const technical = { ...currentUpgradeJob(), description: 'This role is based in Sydney.', locationResolution: undefined }
    const excluded = { ...technical, id: 'greenhouse-search-fixture-a-manager', title: 'Engineering Manager', occupation: undefined, roleClassification: undefined }
    const catalog = { ...searchCatalog([technical, excluded]), unmappedCount: 3 }
    const current = upgradeCatalog(catalog)
    expect(current.jobs).toHaveLength(1)
    expect(current.jobs[0]).toMatchObject({ id: technical.id, cityIds: [], locationResolution: { status: 'conflict' } })
    expect(current.unmappedCount).toBe(4)
    expect(current.boards[0].included).toBe(1)
    expect(upgradeCatalog({ ...catalog, unmappedCount: null }).unmappedCount).toBeNull()
    expect(catalog.unmappedCount).toBe(3)
    expect(catalog.jobs.every(job => job.cityIds.includes('london'))).toBe(true)
  })

  it('rejects inconsistent stored counts and listing IDs before any migration can mask them', () => {
    const job = { ...currentUpgradeJob(), cityIds: [] }
    expect(BoardSnapshotSchema.safeParse({ fetchedAt: SEARCH_TIME, jobs: [job], total: 1, unmappedCount: 0, publishedIds: [job.id] }).success).toBe(false)
    expect(BoardSnapshotSchema.safeParse({ fetchedAt: SEARCH_TIME, jobs: [job], total: 1, unmappedCount: 1, publishedIds: ['greenhouse-search-fixture-a-other'] }).success).toBe(false)
  })

  it('retains subtype fields and keeps current jobs stable on repeated reads', () => {
    const current = { ...currentUpgradeJob(), ingestionMarker: 'retained' }
    expect(upgradeJob(current)).toBe(current)
    const upgraded = upgradeJob({ ...legacyUpgradeJob(), ingestionMarker: 'retained' })
    expect(upgraded.ingestionMarker).toBe('retained')
    expect(upgradeJob(upgraded)).toBe(upgraded)
    expect(upgradeJobCollection({ jobs: [upgraded], unmappedCount: 0 }).jobs[0]).toBe(upgraded)
  })

  it('preserves authored sample conditions and the original sample catalog', () => {
    const sample = createSampleCatalog()
    expect(upgradeCatalog(sample)).toBe(sample)
    expect(sample.jobs.every(job => upgradeJob(job) === job)).toBe(true)
  })
})
