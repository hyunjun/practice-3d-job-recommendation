import { describe, expect, it } from 'vitest'
import { parseCachedBoards } from '../../server/board-cache'
import { normalizeJob } from '../../server/normalize'
import { normalizeAshbyJob } from '../../server/providers/ashby'
import { normalizeLeverJob } from '../../server/providers/lever'
import { normalizeSmartRecruitersJob } from '../../server/providers/smartrecruiters'
import { upgradeJobRemoteScope } from '../../shared/job-remote'
import { createSearchIndex, selectSearchJobs } from '../../shared/job-search'
import { upgradeCatalog, upgradeJob } from '../../shared/job-upgrade'
import { createJobRevision } from '../../shared/posting-status'
import { createSavedBackup, parseSavedImport } from '../../shared/saved-backup'
import { decodeSavedJobs, SavedJobSchema } from '../../shared/saved-jobs'
import { JobSchema } from '../../shared/schemas'
import type { Job, JobProvider } from '../../shared/types'
import { CatalogUpdateDataSchema, isPublicCatalog } from '../../src/lib/catalog-validation'
import {
  legacyRemoteDescriptionJob, legacyRemoteDescriptionSaved, longRemoteDescription,
  REMOTE_DESCRIPTION_COMPANIES, REMOTE_DESCRIPTION_FILTERS, REMOTE_DESCRIPTION_NOTE,
  REMOTE_DESCRIPTION_PROFILE, REMOTE_DESCRIPTION_SAVED_AT,
  REMOTE_DESCRIPTION_TIME, REMOTE_DESCRIPTION_UPDATED_AT, REMOTE_MIXED_PARAGRAPH,
  REMOTE_NOISE_PARAGRAPH, REMOTE_UK_PARAGRAPH, REMOTE_US_PARAGRAPH,
  remoteDescriptionCatalog, remoteDescriptionText,
} from '../fixtures/remote-description'

const providers: JobProvider[] = ['greenhouse', 'ashby', 'lever', 'smartrecruiters']

/** Real normalization entry points are subjects. Expected countries never come from them. */
function normalized(provider: JobProvider = 'greenhouse', body = remoteDescriptionText(REMOTE_UK_PARAGRAPH), location = 'Remote'): Job {
  const companyId = 'remote-description-a'
  const title = 'Backend Engineer Cedar'
  const url = 'https://example.com/jobs/remote-description/4101'
  let job: Job | null
  if (provider === 'greenhouse') job = normalizeJob({
    id: 4101, title, absolute_url: url, updated_at: REMOTE_DESCRIPTION_UPDATED_AT,
    location: { name: location }, content: body,
  }, companyId, REMOTE_DESCRIPTION_TIME)
  else if (provider === 'ashby') job = normalizeAshbyJob({
    id: '4101', title, jobUrl: url, isListed: true, location,
    workplaceType: 'Remote', descriptionPlain: body,
  }, companyId, REMOTE_DESCRIPTION_TIME)
  else if (provider === 'lever') job = normalizeLeverJob({
    id: '4101', text: title, hostedUrl: url, categories: { location },
    workplaceType: 'remote', descriptionPlain: body,
  }, companyId, REMOTE_DESCRIPTION_TIME)
  else job = normalizeSmartRecruitersJob({
    id: '4101', name: title, company: { identifier: companyId }, active: true, visibility: 'PUBLIC',
    releasedDate: REMOTE_DESCRIPTION_UPDATED_AT, postingUrl: url,
    location: { fullLocation: location, remote: true },
    jobAd: { sections: { jobDescription: { text: body } } },
  }, companyId, REMOTE_DESCRIPTION_TIME)
  expect(job, `${provider} should retain the synthetic backend posting`).not.toBeNull()
  return job!
}

function expectScope(job: Job, countries: string[], unknown = false) {
  expect(job).toMatchObject({
    workMode: 'remote', cityIds: [], remoteCountries: countries, remoteWorldwide: false,
    remoteScopeUnknown: unknown, remoteScopeVersion: 2, fetchedAt: REMOTE_DESCRIPTION_TIME,
  })
}

function expectParagraph(job: Job, paragraph: string) {
  expect(job.remoteScopeResolution?.evidence).toContainEqual({ source: 'description', text: paragraph })
}

describe('explicit current-role remote countries through provider normalization', () => {
  it.each(providers)('%s reads this role only and retains the separate-posting context', provider => {
    const job = normalized(provider)
    expectScope(job, ['GB'])
    expect(job.id).toBe(`${provider}-remote-description-a-4101`)
    expect(job.locationLabel).toBe('Remote')
    expect(job.remoteScopeResolution).toMatchObject({
      version: 1, status: 'description', listedCountries: [], listedWorldwide: false,
    })
    expectParagraph(job, REMOTE_UK_PARAGRAPH)
    expect(job.remoteCountries).not.toContain('US')
    expect(job.remoteCountries).not.toContain('CA')
  })

  it.each([
    ['original vacancy wording', 'For this vacancy, remote work is available only to people who live in the United Kingdom. For a separate vacancy, people who live in Canada or the United States should follow the other application link.', ['GB']],
    ['original location heading', 'Location for this role: United States — remote eligible. Residents of Nevada and Vermont cannot be employed for this role.', ['US']],
    ['candidate residence', 'This position is open to candidates based in Canada.', ['CA']],
    ['applicant location', 'The job is available to applicants located in New Zealand.', ['NZ']],
    ['complete names containing and', 'This role can be performed remotely from Bosnia and Herzegovina or Trinidad and Tobago.', ['BA', 'TT']],
    ['dotted abbreviation in a complete list', 'The role can be worked remotely from the U.S. and Canada.', ['US', 'CA']],
    ['territory rather than its parent country', 'Candidates for this job must live in the United States Virgin Islands.', ['VI']],
    ['required current residence', 'Candidates for the position must be based in Ireland.', ['IE']],
  ] as const)('accepts %s without splitting a whole country name', (_name, paragraph, countries) => {
    const job = normalized('greenhouse', remoteDescriptionText(paragraph))
    expectScope(job, [...countries])
    expectParagraph(job, paragraph)
  })

  it('preserves the US state limitations without granting Canada, India or Israel', () => {
    const paragraph = `${REMOTE_US_PARAGRAPH} The excluded US states also include CA, IN and IL.`
    const job = normalized('greenhouse', remoteDescriptionText(paragraph))
    expectScope(job, ['US'])
    expectParagraph(job, paragraph)
    expect(job.remoteScopeResolution?.status).toBe('description')
  })

  it('reads decoded HTML paragraph boundaries without making a second posting eligible', () => {
    const paragraph = 'This role can be performed remotely from the United Kingdom & Ireland. For another posting, applicants may be based in Canada.'
    const job = normalized('greenhouse', `<h2>Work location</h2><p>${paragraph.replace('&', '&amp;')}</p>`)
    expectScope(job, ['GB', 'IE'])
    expectParagraph(job, paragraph)
  })

  it.each(providers)('%s interprets the full source after the retained body limit', provider => {
    const body = longRemoteDescription()
    expect(body.indexOf(REMOTE_US_PARAGRAPH)).toBeGreaterThan(26000)
    const job = normalized(provider, body)
    expectScope(job, ['US'])
    expect(job.description).toHaveLength(26000)
    expect(job.description).not.toContain('Remote Eligible')
    expectParagraph(job, REMOTE_US_PARAGRAPH)
  })
})

describe('non-authorizing prose and regional branches', () => {
  it.each([
    ['salary', 'For this role, candidates based in Canada receive a salary of CAD 150,000.'],
    ['benefits', 'This role is eligible for United States medical and retirement benefits.'],
    ['offices and customers', REMOTE_NOISE_PARAGRAPH],
    ['citizenship', 'Candidates for this role must be citizens of the United States.'],
    ['work permission', 'Candidates for this role must be authorized to work in the United Kingdom.'],
    ['other posting', 'For another posting, this position is US - Remote Eligible.'],
    ['example', 'Example: this role is open to applicants residing in Canada.'],
    ['question', 'This role is available to candidates based in Canada?'],
    ['conditional prefix', 'If local payroll coverage is approved, this role can be performed remotely from Canada.'],
    ['conditional suffix', 'This role can be performed remotely from Canada if local payroll coverage is approved.'],
    ['later possibility', 'In the future, this role can be performed remotely from Canada.'],
    ['negative only', 'This role is not available to candidates based in Canada.'],
    ['mixed country and region', REMOTE_MIXED_PARAGRAPH],
    ['region only', 'This role can be performed remotely from EMEA.'],
    ['ambiguous state abbreviations', 'Candidates for this role must live in CA, IN or IL.'],
    ['global company', 'Our global company works remotely and supports customers worldwide.'],
  ])('does not infer positive countries from %s', (_name, paragraph) => {
    const job = normalized('greenhouse', remoteDescriptionText(paragraph))
    expectScope(job, [], true)
  })

  it.each([
    ['Europe · Remote', 'Candidates for this role must reside in the United Kingdom.'],
    ['EMEA · Remote', 'This position is United States - Remote Eligible.'],
  ])('does not turn %s into country permission using shared role prose', (location, paragraph) => {
    const job = normalized('greenhouse', remoteDescriptionText(paragraph), location)
    expectScope(job, [], true)
    expect(job.locationLabel).toBe(location)
    expect(job.remoteScopeResolution).toMatchObject({
      status: 'unconfirmed', listedCountries: [], listedWorldwide: false,
    })
    expectParagraph(job, paragraph)
  })

  it('keeps duplicate US/Europe branches distinct when the shared body has a mixed list', () => {
    const body = remoteDescriptionText(REMOTE_MIXED_PARAGRAPH)
    const unitedStates = normalized('greenhouse', body, 'United States · Remote')
    const europe = normalized('greenhouse', body, 'Europe · Remote')
    const generic = normalized('greenhouse', body)
    expectScope(unitedStates, ['US'])
    expectScope(europe, [], true)
    expectScope(generic, [], true)
  })
})

describe('reconciliation without broadening eligibility', () => {
  it('narrows a worldwide label and retains its original worldwide fact', () => {
    const job = normalized('greenhouse', remoteDescriptionText(REMOTE_UK_PARAGRAPH), 'Worldwide · Remote')
    expectScope(job, ['GB'])
    expect(job.locationLabel).toBe('Worldwide · Remote')
    expect(job.remoteScopeResolution).toMatchObject({
      status: 'description', listedCountries: [], listedWorldwide: true,
    })
    expectParagraph(job, REMOTE_UK_PARAGRAPH)
  })

  it('intersects concrete board countries instead of adding an unrelated one', () => {
    const paragraph = 'Candidates for this role must live in Canada.'
    const job = normalized('greenhouse', remoteDescriptionText(paragraph), 'United States; Canada · Remote')
    expectScope(job, ['CA'])
    expect(job.remoteScopeResolution).toMatchObject({
      status: 'description', listedCountries: ['US', 'CA'], listedWorldwide: false,
    })
    expectParagraph(job, paragraph)
  })

  it('retains disjoint board and body evidence without choosing either country', () => {
    const job = normalized('greenhouse', remoteDescriptionText(REMOTE_UK_PARAGRAPH), 'United States · Remote')
    expectScope(job, [], true)
    expect(job.remoteScopeResolution).toMatchObject({
      status: 'unconfirmed', listedCountries: ['US'], listedWorldwide: false,
    })
    expectParagraph(job, REMOTE_UK_PARAGRAPH)
  })

  it('retains both contradictory current-role paragraphs rather than unioning them', () => {
    const uk = 'This role is open to applicants based in the United Kingdom only.'
    const us = 'This role is open to applicants based in the United States only.'
    const job = normalized('greenhouse', `${uk}\n\n${us}`)
    expectScope(job, [], true)
    expect(job.remoteScopeResolution?.status).toBe('unconfirmed')
    expectParagraph(job, uk)
    expectParagraph(job, us)
  })

  it('subtracts an explicit current-role exclusion from a concrete country list', () => {
    const paragraph = 'This role is not open to applicants based in Canada.'
    const job = normalized('greenhouse', remoteDescriptionText(paragraph), 'United States; Canada · Remote')
    expectScope(job, ['US'])
    expect(job.remoteScopeResolution).toMatchObject({
      status: 'description', listedCountries: ['US', 'CA'], listedWorldwide: false,
    })
    expectParagraph(job, paragraph)
  })

  it('does not invent a replacement when all listed countries are excluded', () => {
    const paragraph = 'This role is not available to candidates based in the United States.'
    const job = normalized('greenhouse', remoteDescriptionText(paragraph), 'United States · Remote')
    expectScope(job, [], true)
    expect(job.remoteScopeResolution?.status).toBe('unconfirmed')
    expectParagraph(job, paragraph)
  })

  it('does not leave worldwide eligibility after an explicit country exclusion', () => {
    const paragraph = 'This role is not open to candidates residing in Canada.'
    const job = normalized('greenhouse', remoteDescriptionText(paragraph), 'Worldwide · Remote')
    expectScope(job, [], true)
    expect(job.remoteScopeResolution).toMatchObject({ status: 'unconfirmed', listedWorldwide: true })
    expectParagraph(job, paragraph)
  })

  it('marks too many distinct source paragraphs unconfirmed instead of discarding constraints silently', () => {
    const paragraphs = Array.from({ length: 9 }, (_, index) =>
      `This role is open to candidates based in the United Kingdom. Reference note ${index + 1}.`)
    const job = normalized('greenhouse', paragraphs.join('\n\n'))
    expectScope(job, [], true)
    expect(job.remoteScopeResolution).toMatchObject({ status: 'unconfirmed', truncated: true })
    expect(job.remoteScopeResolution?.evidence).toHaveLength(8)
  })

  it('does not count repetitions of the same source paragraph as distinct evidence', () => {
    const paragraph = 'This role is open to candidates based in the United Kingdom.'
    const job = normalized('greenhouse', Array(9).fill(paragraph).join('\n\n'))
    expectScope(job, ['GB'])
    expect(job.remoteScopeResolution?.truncated).not.toBe(true)
    expect(job.remoteScopeResolution?.evidence).toEqual([{ source: 'description', text: paragraph }])
  })
})

describe('displayed regions after a concrete body restriction', () => {
  it('finds a UK-only Global/AMER posting in Europe and all regions while preserving its original hint', () => {
    const paragraph = 'This role is open to candidates based in the United Kingdom only.'
    const job = normalized('greenhouse', remoteDescriptionText(paragraph), 'Global, Remote · AMER')
    expectScope(job, ['GB'])
    expect(job.remoteRegions).toEqual(['americas'])
    expect(job.remoteScopeResolution).toMatchObject({ status: 'description', listedWorldwide: true })
    expectParagraph(job, paragraph)
    const copy = structuredClone(job)
    const index = createSearchIndex(remoteDescriptionCatalog([job]), REMOTE_DESCRIPTION_PROFILE)
    for (const [region, expected] of [
      ['all', ['greenhouse-remote-description-a-4101']],
      ['europe', ['greenhouse-remote-description-a-4101']],
      ['americas', []],
      ['asia-pacific', []],
    ] as const) {
      expect(selectSearchJobs(index, { ...REMOTE_DESCRIPTION_FILTERS, region }).map(entry => entry.job.id), region).toEqual(expected)
    }
    expect(job).toEqual(copy)
    expect(job.remoteRegions).toEqual(['americas'])
  })

  it.each([
    ['no interpretation', 'Build and maintain backend services.', undefined],
    ['unconfirmed interpretation', 'Candidates for this role must reside in the United Kingdom.', 'unconfirmed'],
  ] as const)('keeps a regional hint for %s without turning it into country eligibility', (_name, paragraph, status) => {
    const job = normalized('greenhouse', remoteDescriptionText(paragraph), 'Europe · Remote')
    expectScope(job, [], true)
    expect(job.remoteScopeResolution?.status).toBe(status)
    expect(job.remoteRegions).toEqual(['europe'])
    const index = createSearchIndex(remoteDescriptionCatalog([job]), REMOTE_DESCRIPTION_PROFILE)
    expect(selectSearchJobs(index, { ...REMOTE_DESCRIPTION_FILTERS, region: 'europe' })).toHaveLength(0)
    for (const [region, expected] of [
      ['all', ['greenhouse-remote-description-a-4101']],
      ['europe', ['greenhouse-remote-description-a-4101']],
      ['americas', []],
      ['asia-pacific', []],
    ] as const) {
      expect(selectSearchJobs(index, {
        ...REMOTE_DESCRIPTION_FILTERS, region, remoteEligibleOnly: false,
      }).map(entry => entry.job.id), region).toEqual(expected)
    }
    expect(job.remoteCountries).toEqual([])
  })
})

describe('old snapshots, caches, saved records and revisions', () => {
  it.each([undefined, 1] as const)('migrates remote scope version %s once without changing source facts', version => {
    const old = legacyRemoteDescriptionJob('4101', { remoteScopeVersion: version })
    const copy = structuredClone(old)
    expect(JobSchema.safeParse(old).success).toBe(true)
    const current = upgradeJob(old)
    expectScope(current, ['GB'])
    expectParagraph(current, REMOTE_UK_PARAGRAPH)
    expect(current).toMatchObject({
      id: 'greenhouse-remote-description-a-4101', locationLabel: 'Remote',
      url: 'https://example.com/jobs/remote-description/4101',
      updatedAt: REMOTE_DESCRIPTION_UPDATED_AT, fetchedAt: REMOTE_DESCRIPTION_TIME,
      description: remoteDescriptionText(REMOTE_UK_PARAGRAPH),
    })
    expect(upgradeJob(current)).toBe(current)
    expect(old).toEqual(copy)
    expect(old.remoteCountries).toEqual([])
  })

  it('accepts old public and incremental records before their normal upgrade step', () => {
    const catalog = remoteDescriptionCatalog([legacyRemoteDescriptionJob()])
    expect(isPublicCatalog(catalog)).toBe(true)
    const update = {
      catalog: {
        source: 'public', fetchedAt: REMOTE_DESCRIPTION_TIME, stale: false,
        boards: catalog.boards, unmappedCount: 0,
      },
      companyIds: ['remote-description-a'], jobs: catalog.jobs,
    }
    expect(CatalogUpdateDataSchema.safeParse(update).success).toBe(true)
    const current = upgradeCatalog(catalog)
    expect(current.jobs).toHaveLength(1)
    expectScope(current.jobs[0], ['GB'])
    expectParagraph(current.jobs[0], REMOTE_UK_PARAGRAPH)
    expect(catalog.jobs[0].remoteCountries).toEqual([])
  })

  it.each([4, 5])('migrates board cache version %i without renewing or losing its publication history', version => {
    const old = legacyRemoteDescriptionJob('4101', { stale: true })
    const entry = {
      companyId: 'remote-description-a', provider: 'greenhouse', board: 'remote-description-a',
      checkedAt: '2026-09-19T08:02:00.000Z', failures: 2, retryAt: '2026-09-19T08:05:00.000Z',
      snapshot: {
        fetchedAt: REMOTE_DESCRIPTION_TIME, jobs: [old], total: 2, unmappedCount: 0,
        publishedIds: ['greenhouse-remote-description-a-4101', 'greenhouse-remote-description-a-outside-scope'],
      },
    }
    const input = { version, boards: [entry] }
    const copy = structuredClone(input)
    const boards = parseCachedBoards(input)
    expect(boards).toHaveLength(1)
    const job = boards[0].snapshot!.jobs[0]
    expectScope(job, ['GB'])
    expectParagraph(job, REMOTE_UK_PARAGRAPH)
    expect(job.stale).toBe(true)
    expect(boards[0]).toMatchObject({
      companyId: 'remote-description-a', provider: 'greenhouse', board: 'remote-description-a',
      checkedAt: '2026-09-19T08:02:00.000Z', failures: 2, retryAt: '2026-09-19T08:05:00.000Z',
      snapshot: {
        fetchedAt: REMOTE_DESCRIPTION_TIME, total: 2, unmappedCount: 0,
        publishedIds: ['greenhouse-remote-description-a-4101', 'greenhouse-remote-description-a-outside-scope'],
      },
    })
    expect(parseCachedBoards({ version: 5, boards })).toEqual(boards)
    expect(input).toEqual(copy)
  })

  it('keeps saved dates, status, notes and evidence through validation and backup import', () => {
    const old = legacyRemoteDescriptionSaved()
    const copy = structuredClone(old)
    const decoded = decodeSavedJobs(JSON.stringify([old, { invalid: true }]))
    expect(decoded.omitted).toBe(1)
    expect(decoded.records).toHaveLength(1)
    const saved = decoded.records[0]
    expectScope(saved.job, ['GB'])
    expectParagraph(saved.job, REMOTE_UK_PARAGRAPH)
    expect(saved).toMatchObject({
      savedAt: REMOTE_DESCRIPTION_SAVED_AT, status: 'applied', note: REMOTE_DESCRIPTION_NOTE,
      job: { updatedAt: REMOTE_DESCRIPTION_UPDATED_AT, fetchedAt: REMOTE_DESCRIPTION_TIME },
    })
    const parsed = parseSavedImport(createSavedBackup([old], 0))
    expect(parsed.invalid).toBe(0)
    expect(parsed.groups).toHaveLength(1)
    expect(parsed.groups[0].variants).toEqual([saved])
    expect(parseSavedImport(createSavedBackup([saved], 0)).groups[0].variants).toEqual([saved])
    expect(old).toEqual(copy)
  })

  it('retains long-body evidence in current caches, saved snapshots and JSON without inventing missing old text', () => {
    const job = normalized('greenhouse', longRemoteDescription())
    const saved = SavedJobSchema.parse({
      job, company: REMOTE_DESCRIPTION_COMPANIES[0], savedAt: REMOTE_DESCRIPTION_SAVED_AT,
      note: REMOTE_DESCRIPTION_NOTE, status: 'applied',
    })
    const restored = parseSavedImport(createSavedBackup([saved], 0)).groups[0].variants[0]
    const cached = parseCachedBoards({ version: 5, boards: [{
      companyId: 'remote-description-a', provider: 'greenhouse', board: 'remote-description-a',
      checkedAt: REMOTE_DESCRIPTION_TIME, failures: 0, retryAt: null,
      snapshot: { fetchedAt: REMOTE_DESCRIPTION_TIME, jobs: [job], total: 1, unmappedCount: 0, publishedIds: [job.id] },
    }] })
    expect(cached).toHaveLength(1)
    for (const current of [saved.job, restored.job, cached[0].snapshot!.jobs[0]]) {
      expectScope(current, ['US'])
      expectParagraph(current, REMOTE_US_PARAGRAPH)
      expect(current.remoteScopeResolution).toEqual(job.remoteScopeResolution)
      expect(current.description).not.toContain('Remote Eligible')
    }
    const oldTruncated = legacyRemoteDescriptionJob('4101', { description: job.description })
    expectScope(upgradeJob(oldTruncated), [], true)
  })

  it('continues rejecting unsupported versions and malformed evidence instead of dropping validation', () => {
    const job = normalized()
    expect(JobSchema.safeParse(job).success).toBe(true)
    for (const version of [999, '1', null]) {
      expect(JobSchema.safeParse({ ...job, remoteScopeVersion: version }).success).toBe(false)
    }
    expect(JobSchema.safeParse({
      ...job, remoteScopeResolution: { ...job.remoteScopeResolution, evidence: [{ source: 'description', text: 123 }] },
    }).success).toBe(false)
  })

  it('keeps sample and nonremote behavior outside this country interpretation', () => {
    const sample = legacyRemoteDescriptionJob('sample', { source: 'sample' })
    expect(upgradeJobRemoteScope(sample)).toBe(sample)
    const onsite = normalizeJob({
      id: 4101, title: 'Backend Engineer Cedar', absolute_url: 'https://example.com/jobs/remote-description/4101',
      location: { name: 'London · On-site' }, content: remoteDescriptionText(REMOTE_UK_PARAGRAPH),
    }, 'remote-description-a', REMOTE_DESCRIPTION_TIME)!
    expect(onsite).toMatchObject({ workMode: 'onsite', cityIds: ['london'], remoteCountries: [], remoteWorldwide: false })
    expect(onsite.remoteScopeResolution).toBeUndefined()
  })

  it('compares old and fresh interpretations equally while detecting a real same-ID country edit', async () => {
    const old = legacyRemoteDescriptionJob()
    const migrated = upgradeJob(old)
    const fresh = normalized()
    for (const current of [migrated, fresh]) {
      expectScope(current, ['GB'])
      expectParagraph(current, REMOTE_UK_PARAGRAPH)
    }
    const previous = await createJobRevision(old)
    expect(await createJobRevision(migrated)).toEqual(previous)
    expect(await createJobRevision(fresh)).toEqual(previous)
    const changedJob = normalized('greenhouse', remoteDescriptionText(REMOTE_US_PARAGRAPH))
    expectScope(changedJob, ['US'])
    expect(changedJob.id).toBe(old.id)
    const changed = await createJobRevision(changedJob)
    const sections = ['title', 'location', 'conditions', 'compensation', 'qualifications', 'description', 'url'] as const
    expect(sections.filter(section => changed[section] !== previous[section])).toEqual(['conditions', 'description'])
  })

  it('detects a changed state limitation outside the saved body even when the country is unchanged', async () => {
    const before = normalized('greenhouse', longRemoteDescription())
    const revisedParagraph = REMOTE_US_PARAGRAPH.replace('Vermont', 'Oregon')
    const after = normalized('greenhouse', longRemoteDescription(revisedParagraph))
    expectScope(before, ['US'])
    expectScope(after, ['US'])
    expect(before.description).toBe(after.description)
    expectParagraph(before, REMOTE_US_PARAGRAPH)
    expectParagraph(after, revisedParagraph)
    const previous = await createJobRevision(before)
    const changed = await createJobRevision(after)
    const sections = ['title', 'location', 'conditions', 'compensation', 'qualifications', 'description', 'url'] as const
    expect(sections.filter(section => changed[section] !== previous[section])).toEqual(['conditions'])
    expect(await createJobRevision(upgradeJob(after))).toEqual(changed)
  })
})
