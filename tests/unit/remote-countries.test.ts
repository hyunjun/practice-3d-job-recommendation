import { describe, expect, it } from 'vitest'
import { CITIES } from '../../shared/cities'
import { COUNTRY_BY_CODE, COUNTRY_OPTIONS, countryCode, countryName } from '../../shared/countries'
import { createSearchIndex, selectSearchJobs } from '../../shared/job-search'
import { upgradeJobLocation } from '../../shared/job-location'
import { remoteScope, remoteScopeLabel, upgradeJobRemoteScope } from '../../shared/job-remote'
import { createJobRevision } from '../../shared/posting-status'
import { createSavedBackup, parseSavedImport } from '../../shared/saved-backup'
import { SavedJobSchema } from '../../shared/saved-jobs'
import { DEFAULT_FILTERS, REMOTE_SCOPE_VERSION } from '../../shared/types'
import type { Job, SavedJob } from '../../shared/types'
import { parseCachedBoards } from '../../server/board-cache'
import { normalizeJob, postingCities, postingRemoteScope } from '../../server/normalize'
import { normalizeAshbyJob } from '../../server/providers/ashby'
import { normalizeLeverJob } from '../../server/providers/lever'
import { normalizeSmartRecruitersJob } from '../../server/providers/smartrecruiters'
import { SEARCH_COMPANIES, SEARCH_PROFILE, SEARCH_TIME, searchCatalog, searchJob } from '../fixtures/search-catalog'

function legacyRemote(location: string, overrides: Partial<Job> = {}): Job {
  return searchJob('country-scope', {
    workMode: 'remote', cityIds: [], locationLabel: location, remoteScopeUnknown: true,
    qualifications: { version: 1, skills: [], experience: [] }, skills: [], minExperience: null, requirements: [],
    remoteScopeVersion: undefined, ...overrides,
  })
}

describe('country coverage independent of map cities', () => {
  it('offers named countries and areas with unique identifiers without expanding map coverage', () => {
    expect(COUNTRY_OPTIONS).toHaveLength(250)
    expect(new Set(COUNTRY_OPTIONS.map(([code]) => code)).size).toBe(COUNTRY_OPTIONS.length)
    expect(COUNTRY_OPTIONS.every(([code, label]) => /^[A-Z]{2}$/.test(code) && label !== code)).toBe(true)
    for (const city of CITIES) expect(COUNTRY_BY_CODE.get(city.countryCode)?.region).toBe(city.region)
    expect(CITIES.some(city => city.countryCode === 'PL' || city.countryCode === 'NZ')).toBe(false)
    expect(countryName('PL')).toBe('폴란드')
    expect(countryName('NZ')).toBe('뉴질랜드')
  })

  it('reads whole structured country fields and protects same-named cities in other countries', () => {
    for (const value of ['PL', 'pol', 'Poland', '폴란드']) expect(countryCode(value)).toBe('PL')
    for (const value of ['NZ', 'NZL', 'New Zealand', '뉴질랜드']) expect(countryCode(value)).toBe('NZ')
    expect(countryCode('BR')).toBe('BR')
    expect(countryCode('North Korea')).toBe('KP')
    expect(countryCode('Kosovo')).toBe('XK')
    expect(countryCode('XKX')).toBe('XK')
    expect(countryCode('Czech Republic')).toBe('CZ')
    expect(countryCode('not a country')).toBeUndefined()
    expect(postingCities([{ label: 'London', address: { addressLocality: 'London', addressCountry: 'PL' } }])).toEqual([])
    expect(postingCities([{ label: 'London', address: { addressLocality: 'London', addressCountry: 'Uganda' } }])).toEqual([])
  })

  it('reads country lists, unambiguous codes and current provider naming variants', () => {
    expect(remoteScope('Remote, Poland; Remote, Israel; Remote, United Kingdom').remoteCountries).toEqual(['GB', 'IL', 'PL'])
    expect(remoteScope('Auckland, New Zealand · Remote').remoteCountries).toEqual(['NZ'])
    expect(remoteScope('Brazil · Remote').remoteCountries).toEqual(['BR'])
    expect(remoteScope('Bosnia · Czech Republic · Kosovo · Remote').remoteCountries).toEqual(['BA', 'CZ', 'XK'])
    expect(remoteScope('Remote, CAN').remoteCountries).toEqual(['CA'])
    expect(remoteScope('Remote, NZL').remoteCountries).toEqual(['NZ'])
    expect(remoteScope('Remote from the US').remoteCountries).toEqual(['US'])
    expect(remoteScope('Remote from the U.S.').remoteCountries).toEqual(['US'])
    expect(remoteScope('Remote, San Francisco, CA').remoteCountries).toEqual(['US'])
    expect(remoteScope('Adelaide, SA, Australia · Remote').remoteCountries).toEqual(['AU'])
    expect(remoteScope('New Jersey, USA, Remote').remoteCountries).toEqual(['US'])
    expect(remoteScope('Jersey City, New Jersey, USA, Remote').remoteCountries).toEqual(['US'])
    expect(remoteScope('Jersey · Remote').remoteCountries).toEqual(['JE'])
  })

  it('does not treat state abbreviations, ordinary prose, exclusions or broad regions as country permission', () => {
    for (const label of ['Remote, CA', 'Remote, IN', 'Remote, IL', 'Remote, Georgia', 'Remote, AND', 'Remote — can work anywhere', 'Come work with us']) {
      expect(remoteScope(label).remoteCountries, label).toEqual([])
    }
    for (const label of ['Europe', 'EMEA', 'APAC', 'AMER', 'Worldwide except US']) {
      expect(remoteScope(label), label).toMatchObject({ remoteCountries: [], remoteWorldwide: false, remoteScopeUnknown: true })
    }
    expect(remoteScope('Global, Remote').remoteWorldwide).toBe(true)
  })

  it('keeps complete country and territory names distinct from names contained inside them', () => {
    for (const [label, code, obsolete] of [
      ['North Korea', 'KP', 'KR'], ['Caribbean Netherlands', 'BQ', 'NL'],
      ['United States Virgin Islands', 'VI', 'US'], ['U.S. Virgin Islands', 'VI', 'US'],
      ['United States Minor Outlying Islands', 'UM', 'US'],
    ]) {
      expect(remoteScope(`Remote, ${label}`).remoteCountries, label).toEqual([code])
      expect(upgradeJobRemoteScope(legacyRemote(`Remote, ${label}`, { remoteCountries: [obsolete] })).remoteCountries, label).toEqual([code])
    }
    expect(remoteScope('United States; United States Virgin Islands').remoteCountries).toEqual(['US', 'VI'])
  })

  it('uses country-only posting metadata while retaining regional and office-address uncertainty', () => {
    expect(postingRemoteScope([{ label: 'Remote', address: { addressCountry: 'NZL' } }])).toMatchObject({ remoteCountries: ['NZ'], remoteScopeUnknown: false })
    expect(postingRemoteScope([{ label: 'Georgia', address: { addressCountry: 'GE' } }]).remoteCountries).toEqual(['GE'])
    expect(postingRemoteScope([{ label: 'Georgia', address: { addressCountry: 'US', addressRegion: 'Georgia' } }]).remoteCountries).toEqual([])
    expect(postingRemoteScope([{ label: 'Wellington, NZ', address: { addressCountry: 'NZ', addressLocality: 'Wellington' } }]).remoteCountries).toEqual(['NZ'])
    expect(postingRemoteScope([{ label: 'Adelaide, SA, AU', address: { addressCountry: 'AU', addressLocality: 'Adelaide' } }]).remoteCountries).toEqual(['AU'])
    expect(postingRemoteScope([{ label: 'Europe', address: { addressCountry: 'POL', addressLocality: 'Warsaw' } }])).toMatchObject({ remoteCountries: [], remoteScopeUnknown: true, remoteRegions: ['europe'] })
    expect(postingRemoteScope([{ label: 'Remote', address: { addressCountry: 'NZL', addressLocality: 'Wellington' } }]).remoteCountries).toEqual([])
  })

  it('normalizes explicit countries through all four providers without inventing map pins', () => {
    const company = SEARCH_COMPANIES[0]
    const title = 'Backend Software Engineer'
    const description = 'Build backend services using TypeScript.'
    const jobs = [
      normalizeJob({ id: 2701, title, absolute_url: 'https://example.com/greenhouse/2701', location: { name: 'Remote, New Zealand' }, content: description }, company.id, SEARCH_TIME),
      normalizeAshbyJob({ id: '2701', title, jobUrl: 'https://example.com/ashby/2701', isListed: true, location: 'New Zealand', workplaceType: 'Remote', descriptionPlain: description }, company.id, SEARCH_TIME),
      normalizeLeverJob({ id: '2701', text: title, hostedUrl: 'https://example.com/lever/2701', country: 'NZ', categories: { location: 'Remote' }, workplaceType: 'remote', descriptionPlain: description }, company.id, SEARCH_TIME),
      normalizeSmartRecruitersJob({ id: '2701', name: title, company: { identifier: company.board! }, active: true, visibility: 'PUBLIC', releasedDate: SEARCH_TIME, postingUrl: 'https://example.com/smart/2701', location: { city: 'Wellington', country: 'nz', remote: true }, jobAd: { sections: { jobDescription: { text: description } } } }, company.id, SEARCH_TIME),
    ]
    expect(new Set(jobs.map(job => job!.source)).size).toBe(4)
    for (const job of jobs) expect(job).toMatchObject({
      cityIds: [], workMode: 'remote', remoteCountries: ['NZ'], remoteWorldwide: false,
      remoteScopeUnknown: false, remoteScopeVersion: REMOTE_SCOPE_VERSION, fetchedAt: SEARCH_TIME,
    })
  })

  it('finds Korean country names and regional results even when the catalog has no map cities', () => {
    const jobs = [legacyRemote('Remote, Poland'), legacyRemote('Remote, New Zealand', { id: 'greenhouse-search-fixture-a-nz' })]
    const catalog = { ...searchCatalog(jobs), cities: [] }
    const filters = { ...DEFAULT_FILTERS, role: 'all' as const, workMode: 'remote' as const }
    const poland = createSearchIndex(catalog, { ...SEARCH_PROFILE, residence: 'PL' })
    for (const query of ['폴란드', 'Poland', 'POL']) {
      expect(selectSearchJobs(poland, { ...filters, region: 'europe', query }).map(entry => entry.job.id)).toEqual([jobs[0].id])
    }
    expect(selectSearchJobs(poland, { ...filters, region: 'asia-pacific' })).toHaveLength(0)
    const nz = createSearchIndex(catalog, { ...SEARCH_PROFILE, residence: 'NZ' })
    expect(selectSearchJobs(nz, { ...filters, region: 'asia-pacific', query: '뉴질랜드' }).map(entry => entry.job.id)).toEqual([jobs[1].id])
    expect(selectSearchJobs(nz, { ...filters, region: 'europe' })).toHaveLength(0)
    expect(jobs[0].remoteCountries).toEqual([])
  })

  it('keeps other geographic areas discoverable in the all-regions view and never expands Europe into country eligibility', () => {
    const job = legacyRemote('Remote, South Africa')
    const profile = { ...SEARCH_PROFILE, residence: 'ZA' }
    const index = createSearchIndex({ ...searchCatalog([job]), cities: [] }, profile)
    expect(selectSearchJobs(index, DEFAULT_FILTERS)).toHaveLength(1)
    expect(selectSearchJobs(index, { ...DEFAULT_FILTERS, region: 'europe' })).toHaveLength(0)
    const region = createSearchIndex(searchCatalog([legacyRemote('Europe · Remote')]), { ...profile, residence: 'PL' })
    expect(selectSearchJobs(region, { ...DEFAULT_FILTERS, region: 'europe' })).toHaveLength(0)
    expect(selectSearchJobs(region, { ...DEFAULT_FILTERS, region: 'europe', remoteEligibleOnly: false })).toHaveLength(1)
  })
})

describe('remote country interpretation across retained records', () => {
  it('preserves structured metadata, source facts and original timestamps while migrating only once', () => {
    const job = legacyRemote('Remote, Poland', { remoteCountries: ['CA'], remoteScopeUnknown: false })
    const copy = structuredClone(job)
    const current = upgradeJobLocation(job)
    expect(current.remoteCountries).toEqual(['CA', 'PL'])
    expect(current).toMatchObject({ ...job, remoteCountries: ['CA', 'PL'], remoteScopeVersion: REMOTE_SCOPE_VERSION })
    expect(upgradeJobLocation(current)).toBe(current)
    expect(job).toEqual(copy)
    const sample = { ...job, source: 'sample' as const }
    expect(upgradeJobRemoteScope(sample)).toBe(sample)
    expect(upgradeJobRemoteScope(searchJob('onsite'))).not.toHaveProperty('remoteScopeVersion')
  })

  it('upgrades cached board contents without changing published IDs, counts or collection history', () => {
    const job = legacyRemote('Remote, Poland')
    const company = SEARCH_COMPANIES[0]
    const snapshot = { fetchedAt: SEARCH_TIME, jobs: [job], total: 2, unmappedCount: 0, publishedIds: [job.id, 'greenhouse-search-fixture-a-outside-scope'] }
    const entry = { companyId: company.id, board: company.board, provider: 'greenhouse', checkedAt: SEARCH_TIME, failures: 0, retryAt: null, snapshot }
    const result = parseCachedBoards({ version: 5, boards: [entry] })
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({ ...entry, snapshot: { ...snapshot, jobs: [{ ...job, remoteCountries: ['PL'], remoteScopeUnknown: false, remoteScopeVersion: REMOTE_SCOPE_VERSION }] } })
    expect(parseCachedBoards({ version: 5, boards: result })).toEqual(result)
    expect(job.remoteCountries).toEqual([])
  })

  it('keeps notes, application status and country interpretation through saved records and backup restore', () => {
    const record: SavedJob = { job: legacyRemote('Remote, Poland'), company: SEARCH_COMPANIES[0], savedAt: SEARCH_TIME, note: 'Private country selection note', status: 'applied' }
    const saved = SavedJobSchema.parse(record)
    expect(saved).toMatchObject({ ...record, job: { ...record.job, remoteCountries: ['PL'], remoteScopeUnknown: false, remoteScopeVersion: REMOTE_SCOPE_VERSION } })
    expect(remoteScopeLabel(saved.job)).toBe('폴란드')
    const imported = parseSavedImport(createSavedBackup([record], 0))
    expect(imported.invalid).toBe(0)
    expect(imported.groups[0].variants).toEqual([saved])
    expect(parseSavedImport(createSavedBackup([saved], 0)).groups[0].variants).toEqual([saved])
    expect(record.job.remoteCountries).toEqual([])
  })

  it('does not flag a parser upgrade as a changed posting but detects a real country change', async () => {
    const job = legacyRemote('Remote, Poland')
    const previous = await createJobRevision(job)
    expect(await createJobRevision(upgradeJobRemoteScope(job))).toEqual(previous)
    const updated = await createJobRevision(legacyRemote('Remote, New Zealand'))
    expect(updated.conditions).not.toBe(previous.conditions)
    expect(updated.location).not.toBe(previous.location)
    expect(updated.title).toBe(previous.title)
  })
})
