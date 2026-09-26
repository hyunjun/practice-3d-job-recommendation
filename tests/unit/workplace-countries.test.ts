import { describe, expect, it } from 'vitest'
import { CITIES } from '../../shared/cities'
import { createSearchIndex, countSearchJobs, inSearchScope, selectSearchJobs } from '../../shared/job-search'
import {
  createWorkplaceLocations, workplaceCountryInfo, workplaceCountryRevision, workplaceCountrySearchText,
} from '../../shared/job-workplace'
import { createJobRevision } from '../../shared/posting-status'
import { JobSchema } from '../../shared/schemas'
import type { Catalog, Job } from '../../shared/types'
import { normalizeJob } from '../../server/normalize'
import { normalizeAshbyJob } from '../../server/providers/ashby'
import { normalizeLeverJob } from '../../server/providers/lever'
import { normalizeSmartRecruitersJob } from '../../server/providers/smartrecruiters'
import {
  COUNTRY_CONTEXT_BODY, WORKPLACE_COUNTRY_FETCHED_AT, WORKPLACE_COUNTRY_FILTERS,
  WORKPLACE_COUNTRY_PROFILE, WORKPLACE_COUNTRY_REGISTRATIONS,
  workplaceCountryAshbyPostings, workplaceCountryAshbyRaw, workplaceCountryGreenhousePostings,
  workplaceCountryGreenhouseRaw, workplaceCountryLeverPostings, workplaceCountryLeverRaw,
  workplaceCountrySmartRecruitersPostings, workplaceCountrySmartRecruitersRaw,
} from '../fixtures/workplace-countries'
import { legacyCountryJob } from '../fixtures/workplace-countries-legacy'

const fetchedAt = WORKPLACE_COUNTRY_FETCHED_AT

function collectedJobs(): Job[] {
  const jobs = [
    ...workplaceCountryGreenhousePostings().map(raw => normalizeJob(raw, 'country-fern', fetchedAt)),
    ...workplaceCountryAshbyPostings().map(raw => normalizeAshbyJob(raw, 'country-moss', fetchedAt)),
    ...workplaceCountryLeverPostings().map(raw => normalizeLeverJob(raw, 'country-wren', fetchedAt)),
    ...workplaceCountrySmartRecruitersPostings().map(raw => normalizeSmartRecruitersJob(raw, 'country-cove', fetchedAt)),
  ]
  expect(jobs).toHaveLength(22)
  expect(jobs).not.toContain(null)
  return jobs as Job[]
}

function catalog(jobs = collectedJobs()): Catalog {
  return {
    source: 'public', fetchedAt, stale: false, cities: CITIES, jobs, boards: [],
    companies: WORKPLACE_COUNTRY_REGISTRATIONS.map(company => ({ ...company, initials: 'QA', color: '#84dba6' })),
    unmappedCount: 20,
  }
}

describe('country evidence from a nonremote posting location', () => {
  it.each([
    { label: 'Tallinn, Estonia', countries: ['EE'], uncertain: false },
    { label: 'Estonia', countries: ['EE'], uncertain: false },
    { label: 'EST', countries: ['EE'], uncertain: false },
    { label: '에스토니아', countries: ['EE'], uncertain: false },
    { label: 'Petaling Jaya, Malaysia', countries: ['MY'], uncertain: false },
    { label: 'Lebanon, NH, United States', countries: ['US'], uncertain: false },
    { label: 'Tallinn, Estonia; Petaling Jaya, Malaysia', countries: ['EE', 'MY'], uncertain: false },
    { label: 'Bosnia and Herzegovina', countries: ['BA'], uncertain: false },
    { label: 'Tallinn, Estonia · N/A', countries: ['EE'], uncertain: true },
    { label: 'US, Canada', countries: ['CA', 'US'], uncertain: false },
    { label: 'USA, Canada', countries: ['CA', 'US'], uncertain: false },
    { label: 'United States, Canada', countries: ['CA', 'US'], uncertain: false },
    { label: 'Lebanon, Canada', countries: ['CA'], uncertain: false },
    { label: 'Mexico, United States', countries: ['US'], uncertain: false },
    { label: 'US; Canada', countries: ['CA', 'US'], uncertain: false },
    { label: 'US and Canada', countries: ['CA', 'US'], uncertain: false },
    { label: 'US or Canada', countries: ['CA', 'US'], uncertain: false },
  ])('reads only complete country evidence in $label', ({ label, countries, uncertain }) => {
    const job = legacyCountryJob({ locationLabel: label })
    expect(workplaceCountryInfo(job)).toEqual({
      countries, uncertain, conflict: false, evidence: [{ source: 'board', text: label }],
    })
    expect(job.cityIds).toEqual([])
    expect(job.remoteCountries).toEqual([])
    expect(job.workMode).toBe('onsite')
  })

  it.each(['N/A', 'Tallinn', 'Petaling Jaya', 'CA', 'Georgia', 'Lebanon, NH', 'New Zealand House', 'Canada Centre', 'Berlin'])(
    'keeps unconfirmed or ambiguous label %s global-only without city-name geocoding',
    locationLabel => {
      const job = legacyCountryJob({ locationLabel, description: COUNTRY_CONTEXT_BODY })
      expect(workplaceCountryInfo(job)).toEqual({
        countries: [], uncertain: true, conflict: false,
        evidence: [{ source: 'board', text: locationLabel }],
      })
    },
  )

  it.each([
    { label: 'CA', country: 'CA', countries: ['CA'], uncertain: false, conflict: false },
    { label: 'Paper Workshop', country: 'EST', countries: ['EE'], uncertain: false, conflict: false },
    { label: 'Tallinn, Estonia', country: 'EE', countries: ['EE'], uncertain: false, conflict: false },
    { label: 'Tallinn, Estonia', country: 'Malaysia', countries: [], uncertain: true, conflict: true },
    { label: 'Tallinn, Estonia', country: 'Unknown Republic', countries: [], uncertain: true, conflict: false },
    { label: 'Lebanon, NH, United States', country: 'USA', countries: ['US'], uncertain: false, conflict: false },
    { label: 'Georgia', country: 'GE', countries: ['GE'], uncertain: false, conflict: false },
    { label: 'US, Canada', country: 'CA', countries: [], uncertain: true, conflict: true },
  ])('reconciles $label with its own structured country $country', ({ label, country, countries, uncertain, conflict }) => {
    const job = legacyCountryJob({
      locationLabel: label, workplaceLocations: { version: 1, locations: [{ label, country }] },
    })
    expect(workplaceCountryInfo(job)).toEqual({
      countries, uncertain, conflict, evidence: [{ source: 'board', text: `${label}\n국가: ${country}` }],
    })
  })

  it('retains a separate confirmed country despite a different unknown or conflicting source', () => {
    const job = legacyCountryJob({
      workplaceLocations: { version: 1, locations: [
        { label: 'Tallinn', country: 'EE' },
        { label: 'Awaiting Assignment' },
        { label: 'Petaling Jaya, Malaysia', country: 'Unknown Republic' },
        { label: 'Tallinn, Estonia', country: 'MY' },
      ] },
    })
    expect(workplaceCountryInfo(job)).toEqual({
      countries: ['EE'], uncertain: true, conflict: true,
      evidence: [
        { source: 'board', text: 'Tallinn\n국가: EE' },
        { source: 'board', text: 'Awaiting Assignment' },
        { source: 'board', text: 'Petaling Jaya, Malaysia\n국가: Unknown Republic' },
        { source: 'board', text: 'Tallinn, Estonia\n국가: MY' },
      ],
    })
  })

  it('searches Korean, English and ISO aliases without borrowing country names from context', () => {
    const known = workplaceCountrySearchText(legacyCountryJob())
    for (const literal of ['EE', 'EST', '에스토니아', 'Estonia']) expect(known).toContain(literal)
    expect(workplaceCountrySearchText(legacyCountryJob({ locationLabel: 'N/A', description: COUNTRY_CONTEXT_BODY }))).toBe('')
  })

  it('retains both directly listed countries from a separate source without accepting either conflicting country', () => {
    const job = legacyCountryJob({
      workplaceLocations: { version: 1, locations: [
        { label: 'Tallinn, Estonia', country: 'MY' },
        { label: 'US, Canada' },
      ] },
    })
    expect(workplaceCountryInfo(job)).toEqual({
      countries: ['CA', 'US'], uncertain: true, conflict: true,
      evidence: [
        { source: 'board', text: 'Tallinn, Estonia\n국가: MY' },
        { source: 'board', text: 'US, Canada' },
      ],
    })
    expect(workplaceCountrySearchText(job)).toContain('미국')
    expect(workplaceCountrySearchText(job)).toContain('캐나다')
    expect(workplaceCountrySearchText(job)).not.toContain('에스토니아')
    expect(workplaceCountrySearchText(job)).not.toContain('말레이시아')
  })
})

describe('raw four-provider retention and existing scope semantics', () => {
  it('retains each Greenhouse workplace label while excluding body headquarters, travel and applicant residence', () => {
    const job = normalizeJob(workplaceCountryGreenhouseRaw({
      location: { name: 'N/A' }, content: `<p>${COUNTRY_CONTEXT_BODY}</p>`,
    }), 'country-fern', fetchedAt)!
    expect(job.workplaceLocations).toEqual({ version: 1, locations: [{ label: 'N/A' }] })
    expect(workplaceCountryRevision(job)).toEqual({ countries: [], uncertain: true, conflict: false })
    expect(job.description).toBe(COUNTRY_CONTEXT_BODY)
  })

  it('preserves flat Ashby primary and nested secondary country fields independently', () => {
    const job = normalizeAshbyJob(workplaceCountryAshbyPostings()[1], 'country-moss', fetchedAt)!
    expect(job).toMatchObject({
      id: 'ashby-country-moss-5512', cityIds: [], workMode: 'onsite', remoteCountries: [],
      workplaceLocations: { version: 1, locations: [
        { label: 'Tallinn', country: 'EE' }, { label: 'Petaling Jaya', country: 'MYS' },
      ] },
    })
    expect(workplaceCountryRevision(job)).toEqual({ countries: ['EE', 'MY'], uncertain: false, conflict: false })
  })

  it('accepts nested Ashby country-only CA and preserves an unknown field that blocks an otherwise explicit label', () => {
    const canada = normalizeAshbyJob(workplaceCountryAshbyPostings()[2], 'country-moss', fetchedAt)!
    expect(canada.workplaceLocations).toEqual({ version: 1, locations: [{ label: 'CA', country: 'CA' }] })
    expect(workplaceCountryRevision(canada)).toEqual({ countries: ['CA'], uncertain: false, conflict: false })
    const unknown = normalizeAshbyJob(workplaceCountryAshbyPostings()[3], 'country-moss', fetchedAt)!
    expect(unknown.workplaceLocations).toEqual({ version: 1, locations: [{ label: 'Tallinn, Estonia', country: 'N/A' }] })
    expect(workplaceCountryRevision(unknown)).toEqual({ countries: [], uncertain: true, conflict: false })
  })

  it('does not copy Lever primary country into a separately named secondary country', () => {
    const job = normalizeLeverJob(workplaceCountryLeverPostings()[1], 'country-wren', fetchedAt)!
    expect(job.workplaceLocations).toEqual({ version: 1, locations: [
      { label: 'Wren Annex', country: 'EE' }, { label: 'Petaling Jaya, Malaysia' },
    ] })
    expect(workplaceCountryRevision(job)).toEqual({ countries: ['EE', 'MY'], uncertain: false, conflict: false })
  })

  it('keeps a Lever primary structured country even when only a secondary location has a label', () => {
    const job = normalizeLeverJob(workplaceCountryLeverRaw({
      country: 'CA', categories: { allLocations: ['Mystery Station'], commitment: 'Full-time' },
    }), 'country-wren', fetchedAt)!
    expect(job.workplaceLocations).toEqual({ version: 1, locations: [
      { label: '', country: 'CA' }, { label: 'Mystery Station' },
    ] })
    expect(workplaceCountryRevision(job)).toEqual({ countries: ['CA'], uncertain: true, conflict: false })
  })

  it('retains SmartRecruiters original country spelling, without treating an unknown field as label evidence', () => {
    const job = normalizeSmartRecruitersJob(workplaceCountrySmartRecruitersRaw(), 'country-cove', fetchedAt)!
    expect(job.workplaceLocations).toEqual({ version: 1, locations: [{ label: 'Petaling Jaya', country: 'my' }] })
    expect(workplaceCountryRevision(job)).toEqual({ countries: ['MY'], uncertain: false, conflict: false })
    const unknown = normalizeSmartRecruitersJob(workplaceCountrySmartRecruitersPostings()[2], 'country-cove', fetchedAt)!
    expect(unknown.workplaceLocations).toEqual({ version: 1, locations: [{ label: 'Petaling Jaya, Malaysia', country: '??' }] })
    expect(workplaceCountryRevision(unknown)).toEqual({ countries: [], uncertain: true, conflict: false })
  })

  it('keeps agreeing Australian city conflict regional and a Seoul/London conflict global-only', () => {
    const jobs = collectedJobs()
    const australian = jobs.find(job => job.id === 'greenhouse-country-fern-5509')!
    const crossCountry = jobs.find(job => job.id === 'greenhouse-country-fern-5510')!
    expect(australian).toMatchObject({
      cityIds: [], locationResolution: { status: 'conflict', listedCityIds: ['sydney'], statedCityIds: ['melbourne'] },
    })
    expect(workplaceCountryRevision(australian)).toEqual({ countries: ['AU'], uncertain: false, conflict: false })
    expect(crossCountry).toMatchObject({
      cityIds: [], locationResolution: { status: 'conflict', listedCityIds: ['seoul'], statedCityIds: ['london'] },
    })
    expect(workplaceCountryRevision(crossCountry)).toEqual({ countries: [], uncertain: true, conflict: true })
  })

  it('uses country regions only for unmapped work and deduplicates employers across multi-country posts', () => {
    const index = createSearchIndex(catalog(), WORKPLACE_COUNTRY_PROFILE)
    const europe = selectSearchJobs(index, { ...WORKPLACE_COUNTRY_FILTERS, region: 'europe' })
    expect(europe.map(entry => entry.job.id)).toEqual([
      'greenhouse-country-fern-5501', 'greenhouse-country-fern-5506', 'greenhouse-country-fern-5507',
      'ashby-country-moss-5512', 'ashby-country-moss-5516', 'lever-country-wren-5522',
    ])
    expect(countSearchJobs(europe, { kind: 'unmapped' }, 'europe')).toEqual({ jobs: 5, companies: 3, cities: 0 })
    const asia = selectSearchJobs(index, { ...WORKPLACE_COUNTRY_FILTERS, region: 'asia-pacific' })
    expect(asia.filter(entry => inSearchScope(entry, { kind: 'unmapped' }, 'asia-pacific')).map(entry => entry.job.id)).toEqual([
      'greenhouse-country-fern-5506', 'greenhouse-country-fern-5509',
      'ashby-country-moss-5511', 'ashby-country-moss-5512', 'lever-country-wren-5522', 'smartrecruiters-country-cove-5531',
    ])
    expect(countSearchJobs(asia, { kind: 'unmapped' }, 'asia-pacific')).toEqual({ jobs: 6, companies: 4, cities: 0 })
    expect(asia.map(entry => entry.job.id)).not.toContain('greenhouse-country-fern-5507')
    const americas = selectSearchJobs(index, { ...WORKPLACE_COUNTRY_FILTERS, region: 'americas' })
    expect(americas.map(entry => entry.job.id)).toEqual([
      'greenhouse-country-fern-5505', 'ashby-country-moss-5513', 'lever-country-wren-5521',
      'lever-country-wren-5523', 'smartrecruiters-country-cove-5532',
    ])
    expect(countSearchJobs(americas, { kind: 'unmapped' }, 'americas')).toEqual({ jobs: 5, companies: 4, cities: 0 })
    const world = selectSearchJobs(index, WORKPLACE_COUNTRY_FILTERS)
    expect(world).toHaveLength(22)
    expect(new Set(world.map(entry => entry.company.id)).size).toBe(4)
    expect(countSearchJobs(world, { kind: 'cities' }, 'all')).toEqual({ jobs: 1, companies: 1, cities: 1 })
    expect(countSearchJobs(world, { kind: 'remote' }, 'all')).toEqual({ jobs: 1, companies: 1, cities: 0 })
    expect(countSearchJobs(world, { kind: 'unmapped' }, 'all')).toEqual({ jobs: 20, companies: 4, cities: 0 })
  })

  it('does not turn known on-site countries into remote work or residence eligibility', () => {
    const jobs = collectedJobs()
    const index = createSearchIndex(catalog(jobs), WORKPLACE_COUNTRY_PROFILE)
    expect(selectSearchJobs(index, { ...WORKPLACE_COUNTRY_FILTERS, workMode: 'remote' }).map(entry => entry.job.id)).toEqual(['greenhouse-country-fern-5508'])
    expect(selectSearchJobs(index, { ...WORKPLACE_COUNTRY_FILTERS, workMode: 'remote', remoteEligibleOnly: true })).toEqual([])
    const remote = jobs.find(job => job.id === 'greenhouse-country-fern-5508')!
    expect(remote).toMatchObject({ cityIds: [], workMode: 'remote', remoteCountries: ['MY'], remoteWorldwide: false })
    expect(remote.workplaceLocations).toBeUndefined()
    expect(workplaceCountryInfo(remote)).toEqual({ countries: [], uncertain: false, conflict: false, evidence: [] })
    expect(jobs.find(job => job.id === 'ashby-country-moss-5511')).toMatchObject({
      cityIds: [], workMode: 'onsite', remoteCountries: [], remoteWorldwide: false,
    })
  })

  it('keeps an already-mapped city country in details without manufacturing raw metadata or expanding mapped region scope', () => {
    const job = normalizeAshbyJob(workplaceCountryAshbyRaw({
      location: 'Berlin', address: undefined,
      secondaryLocations: [{ location: 'Petaling Jaya, Malaysia' }],
    }), 'country-moss', fetchedAt)!
    expect(job.cityIds).toEqual(['berlin'])
    expect(job.workplaceLocations).toEqual({
      version: 1, locations: [{ label: 'Berlin' }, { label: 'Petaling Jaya, Malaysia' }],
    })
    expect(workplaceCountryInfo(job).countries).toEqual(['DE', 'MY'])
    const index = createSearchIndex({ ...catalog([job]), unmappedCount: 0 }, WORKPLACE_COUNTRY_PROFILE)
    expect(selectSearchJobs(index, { ...WORKPLACE_COUNTRY_FILTERS, region: 'europe' }).map(entry => entry.job.id)).toEqual(['ashby-country-moss-5511'])
    expect(selectSearchJobs(index, { ...WORKPLACE_COUNTRY_FILTERS, region: 'asia-pacific' })).toEqual([])
    expect(countSearchJobs(index.entries, { kind: 'unmapped' }, 'all')).toEqual({ jobs: 0, companies: 0, cities: 0 })
  })
})

describe('retained fields, limits and semantic revision compatibility', () => {
  it('round-trips original structured spelling and deduplicates exact source entries without mutating inputs', () => {
    const input = [{ label: ' Tallinn ', country: ' est ' }, { label: 'Tallinn', country: 'est' }, { label: '', country: 'CA' }]
    const before = structuredClone(input)
    const locations = createWorkplaceLocations(input)
    expect(locations).toEqual({ version: 1, locations: [{ label: 'Tallinn', country: 'est' }, { label: '', country: 'CA' }] })
    expect(input).toEqual(before)
    const parsed = JobSchema.parse(JSON.parse(JSON.stringify(legacyCountryJob({ workplaceLocations: locations }))))
    expect(parsed.workplaceLocations).toEqual({ version: 1, locations: [{ label: 'Tallinn', country: 'est' }, { label: '', country: 'CA' }] })
    expect(workplaceCountryRevision(parsed)).toEqual({ countries: ['CA', 'EE'], uncertain: false, conflict: false })
  })

  it('marks loss at the 300-source boundary and never claims the discarded 301st country', () => {
    const locations = createWorkplaceLocations([
      ...Array.from({ length: 300 }, (_, index) => ({ label: `Fictional Station ${index + 1}`, country: 'EE' })),
      { label: 'Discarded Fictional Station', country: 'MY' },
    ])!
    expect(locations.locations).toHaveLength(300)
    expect(locations.locations[0]).toEqual({ label: 'Fictional Station 1', country: 'EE' })
    expect(locations.locations[299]).toEqual({ label: 'Fictional Station 300', country: 'EE' })
    expect(locations.truncated).toBe(true)
    const job = legacyCountryJob({ workplaceLocations: locations })
    expect(JobSchema.safeParse(job).success).toBe(true)
    expect(workplaceCountryRevision(job)).toEqual({ countries: ['EE'], uncertain: true, conflict: false })
  })

  it('bounds unusually long raw source values and keeps a visible uncertainty marker', () => {
    const locations = createWorkplaceLocations([{ label: 'A'.repeat(2001), country: 'B'.repeat(1001) }])!
    expect(locations.locations[0]).toEqual({ label: `${'A'.repeat(1999)}…`, country: `${'B'.repeat(999)}…` })
    expect(locations.truncated).toBe(true)
    expect(JobSchema.safeParse(legacyCountryJob({ workplaceLocations: locations })).success).toBe(true)
    expect(workplaceCountryRevision(legacyCountryJob({ workplaceLocations: locations }))).toEqual({ countries: [], uncertain: true, conflict: false })
    expect(JobSchema.safeParse(legacyCountryJob({ workplaceLocations: { version: 1, locations: [{ label: 'A'.repeat(2001) }] } })).success).toBe(false)
    expect(JobSchema.safeParse(legacyCountryJob({ workplaceLocations: { version: 1, locations: [{ label: 'Tallinn', country: 'B'.repeat(1001) }] } })).success).toBe(false)
  })

  it('does not manufacture a revision when a legacy label already establishes the new structured country', async () => {
    const old = legacyCountryJob()
    const retained = legacyCountryJob({ workplaceLocations: { version: 1, locations: [{ label: 'Tallinn, Estonia', country: 'EST' }] } })
    expect(old.workplaceLocations).toBeUndefined()
    expect(workplaceCountryRevision(old)).toEqual({ countries: ['EE'], uncertain: false, conflict: false })
    expect(workplaceCountryRevision(retained)).toEqual({ countries: ['EE'], uncertain: false, conflict: false })
    expect(await createJobRevision(retained)).toEqual(await createJobRevision(old))
  })

  it('keeps a legacy mixed known/unknown label semantically equal to separately retained sources', async () => {
    const old = legacyCountryJob({ locationLabel: 'Tallinn, Estonia · N/A' })
    const retained = legacyCountryJob({
      locationLabel: 'Tallinn, Estonia · N/A',
      workplaceLocations: { version: 1, locations: [{ label: 'Tallinn, Estonia' }, { label: 'N/A' }] },
    })
    expect(workplaceCountryRevision(old)).toEqual({ countries: ['EE'], uncertain: true, conflict: false })
    expect(workplaceCountryRevision(retained)).toEqual({ countries: ['EE'], uncertain: true, conflict: false })
    expect(await createJobRevision(retained)).toEqual(await createJobRevision(old))
  })

  it('keeps ISO spelling changes equal but reports genuine new structured country evidence in the location revision', async () => {
    const old = legacyCountryJob({ locationLabel: 'Assigned Workshop' })
    const estonia = legacyCountryJob({
      locationLabel: 'Assigned Workshop',
      workplaceLocations: { version: 1, locations: [{ label: 'Assigned Workshop', country: 'EE' }] },
    })
    const alias = legacyCountryJob({
      locationLabel: 'Assigned Workshop',
      workplaceLocations: { version: 1, locations: [{ label: 'Assigned Workshop', country: 'Estonia' }] },
    })
    expect(workplaceCountryRevision(old)).toEqual({ countries: [], uncertain: true, conflict: false })
    expect(workplaceCountryRevision(estonia)).toEqual({ countries: ['EE'], uncertain: false, conflict: false })
    const oldRevision = await createJobRevision(old)
    const newRevision = await createJobRevision(estonia)
    expect(newRevision.location).not.toBe(oldRevision.location)
    for (const field of ['title', 'conditions', 'compensation', 'qualifications', 'description', 'url'] as const) {
      expect(newRevision[field]).toBe(oldRevision[field])
    }
    expect(await createJobRevision(alias)).toEqual(newRevision)
  })

  it('compares conflict and uncertainty changes even when neither version has a confirmed country', async () => {
    const unknown = legacyCountryJob({
      workplaceLocations: { version: 1, locations: [{ label: 'Tallinn, Estonia', country: 'Unknown Republic' }] },
    })
    const conflict = legacyCountryJob({
      workplaceLocations: { version: 1, locations: [{ label: 'Tallinn, Estonia', country: 'MY' }] },
    })
    expect(workplaceCountryRevision(unknown)).toEqual({ countries: [], uncertain: true, conflict: false })
    expect(workplaceCountryRevision(conflict)).toEqual({ countries: [], uncertain: true, conflict: true })
    expect((await createJobRevision(unknown)).location).not.toBe((await createJobRevision(conflict)).location)
  })
})
