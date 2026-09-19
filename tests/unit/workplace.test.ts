import { describe, expect, it } from 'vitest'
import { BoardSnapshotSchema, parseCachedBoards } from '../../server/board-cache'
import { normalizeJob } from '../../server/normalize'
import { normalizeAshbyJob } from '../../server/providers/ashby'
import { normalizeLeverJob } from '../../server/providers/lever'
import { normalizeSmartRecruitersJob } from '../../server/providers/smartrecruiters'
import { createSearchIndex, selectSearchJobs, inSearchScope } from '../../shared/job-search'
import { isUnmappedJob, unmappedCoverage, upgradeJobLocation, upgradeJobLocations } from '../../shared/job-location'
import { createJobRevision } from '../../shared/posting-status'
import { createSavedBackup, parseSavedImport } from '../../shared/saved-backup'
import { SavedJobSchema, decodeSavedJobs } from '../../shared/saved-jobs'
import { JobSchema } from '../../shared/schemas'
import { DEFAULT_FILTERS, REMOTE_SCOPE_VERSION } from '../../shared/types'
import type { SavedJob } from '../../shared/types'
import { CONFLICT_BODY, legacyWorkplaceJob, RELOCATION_BODY, RELOCATION_TITLE, WORKPLACE_BODY, WORKPLACE_TITLE, workplacePosting } from '../fixtures/workplace'
import { SEARCH_COMPANIES, SEARCH_PROFILE, SEARCH_TIME, searchCatalog, searchJob } from '../fixtures/search-catalog'

const company = SEARCH_COMPANIES[0]
const conflict = () => legacyWorkplaceJob(workplacePosting(2402, 'Security Engineer', 'Sydney', CONFLICT_BODY))
const fresh = () => normalizeJob(workplacePosting(), company.id, SEARCH_TIME)!

describe('current workplace and listing location', () => {
  it('uses the current internship cities and retains the entire later-employment and residence context', () => {
    const legacy = legacyWorkplaceJob()
    const current = upgradeJobLocation(legacy)
    expect(current.cityIds.sort()).toEqual(['london', 'paris'])
    expect(current.locationLabel).toBe('Paris or London')
    expect(current.locationResolution).toMatchObject({
      version: 1, status: 'relocation', listedCityIds: ['seoul'], listedLabel: 'Seoul',
      evidence: [{ source: 'title', text: WORKPLACE_TITLE }, { source: 'description', text: WORKPLACE_BODY }],
    })
    expect(current).toEqual(fresh())
    expect(upgradeJobLocation(current)).toBe(current)
    expect(legacy.cityIds).toEqual(['seoul'])
    const { cityIds: _cities, locationLabel: _label, locationResolution: _resolution, ...unchanged } = current
    const { cityIds: _oldCities, locationLabel: _oldLabel, ...original } = legacy
    expect(unchanged).toEqual(original)
  })

  it('normalizes the same explicit workplace through all four providers without changing employment, identity or remote scope', () => {
    const jobs = [
      fresh(),
      normalizeAshbyJob({
        id: '2401', title: WORKPLACE_TITLE, jobUrl: 'https://example.com/ashby/2401', isListed: true,
        location: 'Seoul', address: { postalAddress: { addressLocality: 'Seoul', addressCountry: 'South Korea' } },
        workplaceType: 'OnSite', employmentType: 'FullTime', descriptionPlain: WORKPLACE_BODY,
      }, company.id, SEARCH_TIME)!,
      normalizeLeverJob({
        id: '2401', text: WORKPLACE_TITLE, hostedUrl: 'https://example.com/lever/2401',
        categories: { location: 'Seoul', commitment: 'Full-time' }, country: 'KR',
        workplaceType: 'on-site', descriptionPlain: WORKPLACE_BODY,
      }, company.id, SEARCH_TIME)!,
      normalizeSmartRecruitersJob({
        id: '2401', name: WORKPLACE_TITLE, company: { identifier: company.board! },
        visibility: 'PUBLIC', active: true, releasedDate: SEARCH_TIME, postingUrl: 'https://example.com/smart/2401',
        location: { city: 'Seoul', country: 'kr', remote: false, hybrid: false },
        typeOfEmployment: { label: 'Full-time' }, jobAd: { sections: { jobDescription: { text: WORKPLACE_BODY } } },
      }, company.id, SEARCH_TIME)!,
    ]
    expect(new Set(jobs.map(job => job.source)).size).toBe(4)
    for (const job of jobs) {
      expect(job).toMatchObject({
        cityIds: ['london', 'paris'], locationLabel: 'Paris or London', workMode: 'onsite',
        employment: 'intern', fetchedAt: SEARCH_TIME, remoteCountries: [], remoteWorldwide: false,
        locationResolution: { status: 'relocation', listedCityIds: ['seoul'] },
      })
      expect(job.id).toBe(`${job.source}-${company.id}-2401`)
      expect(JobSchema.safeParse(job).success).toBe(true)
    }
  })

  it('keeps separately published relocation listings as separate jobs in the destination city', () => {
    const jobs = ['New York', 'San Francisco'].map((location, index) => {
      const raw = workplacePosting(2410 + index, RELOCATION_TITLE, location, RELOCATION_BODY)
      raw.metadata = [{ name: 'workplaceType', value: 'Hybrid' }]
      return normalizeJob(raw, company.id, SEARCH_TIME)!
    })
    expect(jobs[0].id).not.toBe(jobs[1].id)
    expect(jobs.map(job => job.cityIds)).toEqual([['sydney'], ['sydney']])
    expect(jobs.map(job => job.locationLabel)).toEqual(['Sydney · Hybrid', 'Sydney · Hybrid'])
    expect(jobs.map(job => job.locationResolution!.listedLabel)).toEqual(['New York · Hybrid', 'San Francisco · Hybrid'])
  })

  it('retains conflicting locations outside the map, without asserting the body must be correct', () => {
    const current = upgradeJobLocation(conflict())
    expect(current.cityIds).toEqual([])
    expect(current.locationLabel).toBe('Sydney')
    expect(current.workMode).toBe('onsite')
    expect(current.locationResolution).toMatchObject({
      status: 'conflict', listedCityIds: ['sydney'], listedLabel: 'Sydney',
      statedCityIds: ['melbourne'], statedLabel: 'Melbourne', evidence: [{ source: 'description', text: CONFLICT_BODY }],
    })
    expect(isUnmappedJob(current)).toBe(true)
    expect(upgradeJobLocation(current)).toBe(current)
    const contradictoryBody = upgradeJobLocation({
      ...legacyWorkplaceJob(), description: `${WORKPLACE_BODY}\nThis internship is based in Berlin.`,
    })
    expect(contradictoryBody.locationResolution?.status).toBe('conflict')
    expect(contradictoryBody.cityIds).toEqual([])
  })

  it('does not turn offices, applicant residence, managers, visits or conditional future locations into a current workplace', () => {
    const unrelated = [
      'Our offices are in Paris or London. Candidates must be based in Korea.',
      'You will report to a manager based in Singapore.',
      'This role is based in Vietnam. Your manager is based in Singapore.',
      'This role is based in Beijing, with trips to London.',
      'After the internship, the role will be based in Seoul.',
      'The role will be based in Seoul after completing an internship in London.',
      'If the candidate accepts an additional offer, this role will be based in Seoul.',
      'This role may be based in Paris or London.',
      'This role is not based in Paris or London.',
      'This role is based in Paris or Warsaw.',
      'This role is based in Paris, Texas.',
      'This role is based in London, Ontario.',
      'This role is based in Sydney if you choose to transfer.',
      'Travel to Paris or London is required for this role.',
      'This role is based in our Seoul office, with travel to Paris or London.',
    ]
    for (const description of unrelated) {
      const job = { ...legacyWorkplaceJob(), description }
      expect(upgradeJobLocation(job), description).toBe(job)
    }
    const titleOnly = { ...legacyWorkplaceJob(), description: 'See the recruiter for the location.' }
    expect(upgradeJobLocation(titleOnly)).toBe(titleOnly)
  })

  it('preserves overlapping multi-location listings, unmapped places, sample scenarios and remote restrictions', () => {
    for (const override of [
      { cityIds: ['london', 'paris', 'seoul'], locationLabel: 'London · Paris · Seoul' },
      { cityIds: ['paris'], locationLabel: 'Paris' },
      { cityIds: [], locationLabel: 'South Korea' },
      { source: 'sample' as const },
      { workMode: 'remote' as const, cityIds: [], remoteCountries: ['KR'], remoteScopeUnknown: false, remoteScopeVersion: REMOTE_SCOPE_VERSION },
    ]) {
      const job = { ...legacyWorkplaceJob(), ...override }
      expect(upgradeJobLocation(job)).toBe(job)
    }
  })

  it('retains evidence beyond the body limit and bounds a very long paragraph without losing its workplace clause', () => {
    const exact = `${'x'.repeat(3000 - WORKPLACE_BODY.length - 2)}. ${WORKPLACE_BODY}`
    const atLimit = normalizeJob(workplacePosting(2429, WORKPLACE_TITLE, 'Seoul', exact), company.id, SEARCH_TIME)!
    expect(atLimit.locationResolution?.evidence.at(-1)?.text).toBe(exact)
    for (const separator of ['\n', '']) {
      const body = `${'Background text. '.repeat(2000)}${separator}${WORKPLACE_BODY}`
      const job = normalizeJob(workplacePosting(2430, WORKPLACE_TITLE, 'Seoul', body), company.id, SEARCH_TIME)!
      expect(job.description).toHaveLength(26000)
      expect(job.description).not.toContain(WORKPLACE_BODY)
      expect(job.locationResolution?.evidence.at(-1)?.text).toContain(WORKPLACE_BODY)
      expect(job.locationResolution?.evidence.every(item => item.text.length <= 3000)).toBe(true)
      expect(JobSchema.parse(job)).toEqual(job)
      expect(upgradeJobLocation(job)).toBe(job)
    }
  })

  it('uses corrected cities and regions in direct searches, with conflicts searchable in other locations', () => {
    const catalog = searchCatalog([legacyWorkplaceJob(), conflict(), searchJob('seoul', { cityIds: ['seoul'], locationLabel: 'Seoul' })])
    const index = createSearchIndex(catalog, { ...SEARCH_PROFILE, skills: [] })
    const all = selectSearchJobs(index, DEFAULT_FILTERS)
    expect(all.filter(entry => inSearchScope(entry, { kind: 'city', cityId: 'seoul' })).map(entry => entry.job.id)).toEqual([catalog.jobs[2].id])
    expect(all.filter(entry => inSearchScope(entry, { kind: 'city', cityId: 'paris' })).map(entry => entry.job.id)).toEqual([catalog.jobs[0].id])
    expect(selectSearchJobs(index, { ...DEFAULT_FILTERS, region: 'europe' }).map(entry => entry.job.id)).toEqual([catalog.jobs[0].id])
    for (const query of ['Melbourne', '멜버른', 'Sydney', '시드니']) {
      const results = selectSearchJobs(index, { ...DEFAULT_FILTERS, query })
      expect(results.map(entry => entry.job.id)).toEqual([catalog.jobs[1].id])
      expect(inSearchScope(results[0], { kind: 'unmapped' })).toBe(true)
      expect(inSearchScope(results[0], { kind: 'remote' })).toBe(false)
    }
    expect(catalog.jobs[0].cityIds).toEqual(['seoul'])
  })
})

describe('workplace migration without loss of prior records', () => {
  it('migrates caches atomically with unmapped counts, preserving old omitted counts and all published IDs', () => {
    const jobs = [legacyWorkplaceJob(), conflict()]
    const snapshot = {
      jobs, fetchedAt: SEARCH_TIME, total: 5, unmappedCount: 3,
      publishedIds: [...jobs.map(job => job.id), ...[1, 2, 3].map(id => `greenhouse-${company.id}-omitted-${id}`)],
    }
    const entry = { companyId: company.id, board: company.board, provider: 'greenhouse', checkedAt: SEARCH_TIME, failures: 0, retryAt: null, snapshot }
    const migrated = parseCachedBoards({ version: 5, boards: [entry] })
    expect(migrated).toHaveLength(1)
    expect(migrated[0]).toMatchObject({ ...entry, snapshot: { ...snapshot, jobs: jobs.map(job => upgradeJobLocation(job)), unmappedCount: 4 } })
    expect(unmappedCoverage(migrated[0].snapshot!)).toEqual({ available: 1, unavailable: 3 })
    expect(parseCachedBoards({ version: 5, boards: migrated })).toEqual(migrated)
    expect(BoardSnapshotSchema.parse({ ...snapshot, unmappedCount: null }).unmappedCount).toBeNull()
    expect(BoardSnapshotSchema.safeParse({ ...snapshot, total: 1 }).success).toBe(false)
    expect(BoardSnapshotSchema.safeParse({ ...snapshot, publishedIds: jobs.map(job => job.id) }).success).toBe(false)
    const current = upgradeJobLocations(searchCatalog(jobs))
    expect(current.unmappedCount).toBe(1)
    expect(upgradeJobLocations(current)).toEqual(current)
  })

  it('preserves saved notes, status, identity and timestamps through legacy loading and JSON backup restore', () => {
    const record: SavedJob = {
      job: legacyWorkplaceJob(), company, savedAt: SEARCH_TIME, status: 'applied',
      note: 'private-workplace-note\nKeep this application and its original timestamp.',
    }
    const expected = { ...record, job: fresh() }
    expect(SavedJobSchema.parse(record)).toEqual(expected)
    expect(decodeSavedJobs(JSON.stringify([record])).records).toEqual([expected])
    const restored = parseSavedImport(createSavedBackup([record], 0))
    expect(restored.invalid).toBe(0)
    expect(restored.groups[0].variants).toEqual([expected])
    expect(parseSavedImport(createSavedBackup([expected], 0)).groups[0].variants).toEqual([expected])
    expect(record.job.cityIds).toEqual(['seoul'])
  })

  it('compares old and new snapshots by the same workplace interpretation, while detecting real source changes', async () => {
    const legacy = legacyWorkplaceJob()
    expect(await createJobRevision(legacy)).toEqual(await createJobRevision(fresh()))
    const oldConflict = conflict()
    expect(await createJobRevision(oldConflict)).toEqual(await createJobRevision(upgradeJobLocation(oldConflict)))
    const revised = upgradeJobLocation({ ...legacy, description: WORKPLACE_BODY.replace('6 months', '9 months') })
    expect((await createJobRevision(revised)).location).not.toBe((await createJobRevision(legacy)).location)
    const changedListing = upgradeJobLocation({ ...legacy, cityIds: ['tokyo'], locationLabel: 'Tokyo' })
    expect((await createJobRevision(changedListing)).location).not.toBe((await createJobRevision(legacy)).location)
  })
})
