import { describe, expect, it } from 'vitest'
import { BoardSnapshotSchema } from '../../server/board-cache'
import { normalizeJob } from '../../server/normalize'
import { normalizeAshbyJob } from '../../server/providers/ashby'
import { normalizeLeverJob } from '../../server/providers/lever'
import { normalizeSmartRecruitersJob } from '../../server/providers/smartrecruiters'
import { eligibilityFacts, sponsorshipTransferSummary, upgradeJobEligibility, visaFact } from '../../shared/job-eligibility'
import { filterJobs, matchJob } from '../../shared/matching'
import { createJobRevision, REVISION_FIELDS } from '../../shared/posting-status'
import { createSavedBackup, parseSavedImport } from '../../shared/saved-backup'
import { decodeSavedJobs, SavedJobSchema } from '../../shared/saved-jobs'
import { JobSchema } from '../../shared/schemas'
import { DEFAULT_FILTERS, ELIGIBILITY_VERSION } from '../../shared/types'
import type { FactEvidence, Job, SavedJob } from '../../shared/types'
import { SEARCH_COMPANIES, SEARCH_PROFILE, SEARCH_TIME, searchCatalog, searchJob } from '../fixtures/search-catalog'
import { INTERNSHIP_SPONSORSHIP, legacySponsorshipJob, NON_IMMIGRATION, sponsorshipJob, TRANSFER_SPONSORSHIP } from '../fixtures/sponsorship'
import { workplacePosting, WORKPLACE_TITLE } from '../fixtures/workplace'

const company = SEARCH_COMPANIES[0]

describe('explicit sponsorship, coordinated benefits and transfer scope', () => {
  it('recognizes sponsorship offered with other benefits, retaining current internship and later employment context', () => {
    for (const text of [
      INTERNSHIP_SPONSORSHIP,
      'Visa sponsorship and relocation support are provided.',
      'Visa sponsorship & relocation assistance will be provided by the employer.',
      'Visa sponsorship and immigration assistance is available for this internship.',
    ]) {
      expect(visaFact(text), text).toEqual({ value: 'yes', evidence: { source: 'description', text } })
    }
    const job = sponsorshipJob('internship')
    expect(job).toMatchObject({ visa: 'yes', employment: 'intern', cityIds: ['london', 'paris'] })
    expect(job.eligibility?.rules).toEqual([
      { kind: 'residency', level: 'required', evidence: { source: 'description', text: INTERNSHIP_SPONSORSHIP } },
    ])
  })

  it('classifies supported transfers as conditional without treating relocation denial as visa denial', () => {
    for (const text of [
      TRANSFER_SPONSORSHIP,
      'We can support transfer of existing visa sponsorship.',
      'We provide support for visa sponsorship transfers.',
      'Visa sponsorship transfers are supported.',
    ]) {
      const facts = eligibilityFacts(text)
      expect(facts.visa, text).toBe('conditional')
      expect(facts.visaEvidence?.text).toBe(text)
      expect(facts.eligibility.rules).toContainEqual({
        kind: 'sponsorship-scope', level: 'conditional', evidence: { source: 'description', text },
      })
    }
    expect(sponsorshipTransferSummary(sponsorshipJob('transfer'))).toBe('기존 비자 스폰서십 변경 지원 · 적용 조건 확인')
    expect(sponsorshipTransferSummary(sponsorshipJob('internship'))).toBeNull()
    const unrestricted = eligibilityFacts('We offer visa sponsorship to all applicants. We support transfer of visa sponsorship.')
    expect(unrestricted.visa).toBe('yes')
    expect(unrestricted.eligibility.rules).toEqual([])
  })

  it('keeps location restrictions on coordinated benefits and separates limited transfer denials from all sponsorship', () => {
    expect(visaFact('Visa sponsorship and relocation support are provided in Canada.').value).toBe('conditional')
    for (const text of [
      "We don't support transfer of visa sponsorship.",
      'Visa sponsorship transfers are not supported.',
      'No visa sponsorship transfer support is offered.',
      'No support for transfers of visa sponsorship is provided.',
    ]) {
      expect(visaFact(text).value).toBe('unknown')
      expect(visaFact(text).evidence?.text).toBe(text)
    }
    expect(visaFact("We offer visa sponsorship. We don't support transfer of visa sponsorship.").value).toBe('conditional')
  })

  it('preserves firm denials and contradictions, including contractions and coordinated subjects', () => {
    for (const text of [
      "We don't offer visa sponsorship.",
      'We don’t provide visa sponsorship.',
      "We won't sponsor visas.",
      'Visa sponsorship and relocation support are not provided.',
      "Visa sponsorship & relocation assistance isn't available.",
      'Relocation support is available, but visa sponsorship is not offered.',
    ]) expect(visaFact(text), text).toEqual({ value: 'no', evidence: { source: 'description', text } })
    const contradiction = 'Visa sponsorship and relocation support are provided.\nWe cannot sponsor visas for this role.'
    expect(visaFact(contradiction)).toEqual({ value: 'unknown', evidence: { source: 'description', text: contradiction.replace('\n', '\n\n') } })
    expect(visaFact('Relocation support is not provided. We offer visa sponsorship.').value).toBe('yes')
  })

  it('does not convert questions, required experience, tentative benefits or payment-network sponsorship into an offer', () => {
    for (const text of [
      NON_IMMIGRATION,
      'Relocation and immigration guidance are provided.',
      'Is visa sponsorship and relocation support provided?',
      'Will we support transfer of visa sponsorship?',
      'Do you offer visa sponsorship?',
      'Experience with visa sponsorship transfers supported by case-management software.',
      '• Experience with visa sponsorship transfers supported by case-management software.',
      'Visa sponsorship and relocation support may be provided.',
      'Visa sponsorship and relocation support was provided previously.',
    ]) expect(visaFact(text).value, text).toBe('unknown')
  })

  it('does not apply sponsorship for a subsequent job to the current internship', () => {
    const later = 'After the internship, we offer visa sponsorship for a subsequent full-time role.'
    expect(visaFact(later)).toEqual({ value: 'unknown', evidence: { source: 'description', text: later } })
    expect(visaFact(`We cannot sponsor visas. ${later}`).value).toBe('no')
    expect(visaFact(`Visa sponsorship and relocation support are provided for this internship. ${later}`).value).toBe('yes')
    expect(eligibilityFacts(later).eligibility.rules[0]).toMatchObject({ kind: 'sponsorship-scope', level: 'conditional' })
  })
})

describe('sponsorship persistence and discovery', () => {
  it('uses the same support statement in all four public providers', () => {
    const jobs = [
      sponsorshipJob('internship'),
      normalizeAshbyJob({
        id: '2501', title: WORKPLACE_TITLE, jobUrl: 'https://example.com/sponsorship/ashby', isListed: true,
        location: 'Seoul', descriptionPlain: INTERNSHIP_SPONSORSHIP, workplaceType: 'OnSite', employmentType: 'FullTime',
      }, company.id, SEARCH_TIME)!,
      normalizeLeverJob({
        id: '2501', text: WORKPLACE_TITLE, hostedUrl: 'https://example.com/sponsorship/lever',
        categories: { location: 'Seoul', commitment: 'Full-time' }, workplaceType: 'on-site', descriptionPlain: INTERNSHIP_SPONSORSHIP,
      }, company.id, SEARCH_TIME)!,
      normalizeSmartRecruitersJob({
        id: '2501', name: WORKPLACE_TITLE, company: { identifier: company.board! }, visibility: 'PUBLIC', active: true,
        releasedDate: SEARCH_TIME, postingUrl: 'https://example.com/sponsorship/smart',
        location: { city: 'Seoul', country: 'kr', remote: false, hybrid: false },
        typeOfEmployment: { label: 'Full-time' }, jobAd: { sections: { jobDescription: { text: INTERNSHIP_SPONSORSHIP } } },
      }, company.id, SEARCH_TIME)!,
    ]
    for (const job of jobs) {
      expect(job).toMatchObject({ visa: 'yes', employment: 'intern', fetchedAt: SEARCH_TIME, eligibility: { version: ELIGIBILITY_VERSION } })
      expect(job.evidence?.visa?.text).toBe(INTERNSHIP_SPONSORSHIP)
      expect(JobSchema.safeParse(job).success).toBe(true)
    }
    expect(new Set(jobs.map(job => job.source)).size).toBe(4)
  })

  it('preserves old legal conditions beyond the retained body and recovers sponsorship from retained original paragraphs', () => {
    const job = legacySponsorshipJob('internship')
    job.description = 'The saved body was shortened before the location and eligibility paragraphs.'
    job.eligibility!.rules.push({
      kind: 'security-clearance', level: 'preferred',
      evidence: { source: 'description', text: 'Preferred qualifications\nActive security clearance or eligibility to obtain one.' },
    })
    const before = structuredClone(job)
    const migrated = upgradeJobEligibility(job)
    expect(migrated.visa).toBe('yes')
    expect(migrated.evidence?.visa?.text).toBe(INTERNSHIP_SPONSORSHIP)
    expect(migrated.eligibility?.rules).toEqual(before.eligibility!.rules)
    expect(migrated.eligibility?.version).toBe(ELIGIBILITY_VERSION)
    expect(job).toEqual(before)
    expect(upgradeJobEligibility(migrated)).toBe(migrated)
    const capped: Job = {
      ...legacySponsorshipJob('transfer'),
      eligibility: { version: 1, rules: Array.from({ length: 50 }, (_, i) => ({
        kind: 'work-authorization', level: 'required', evidence: { source: 'description', text: `Applicants must have valid work authorization for assignment ${i}.` },
      })) },
    }
    const upgraded = upgradeJobEligibility(capped)
    expect(upgraded.eligibility?.rules).toEqual(capped.eligibility!.rules)
    expect(upgraded.eligibility?.truncated).toBe(true)
    expect(upgraded.visa).toBe('conditional')
  })

  it('reads separately retained evidence without losing a late denial to the body scanning limit', () => {
    const retained: FactEvidence[] = Array.from({ length: 50 }, (_, i) => ({
      source: 'description', text: `${i} ${'Context '.repeat(373)}`,
    }))
    retained.push({ source: 'description', text: 'We cannot sponsor visas.' })
    expect(visaFact('We offer visa sponsorship.', retained)).toEqual({
      value: 'unknown', evidence: { source: 'description', text: 'We offer visa sponsorship.\n\nWe cannot sponsor visas.' },
    })
  })

  it('migrates old cache, saved records and portable backups without changing identity, times, notes or non-visa facts', () => {
    const jobs = [legacySponsorshipJob('internship'), legacySponsorshipJob('transfer')]
    const expected = jobs.map(job => upgradeJobEligibility(job))
    const snapshot = { jobs, fetchedAt: SEARCH_TIME, total: 2, unmappedCount: 0, publishedIds: jobs.map(job => job.id) }
    expect(BoardSnapshotSchema.parse(snapshot)).toEqual({ ...snapshot, jobs: expected })
    const records: SavedJob[] = jobs.map((job, i) => ({ job, company, savedAt: SEARCH_TIME, status: i ? 'saved' : 'applied', note: `private-sponsorship-note-${i}` }))
    const migrated = records.map((record, i) => ({ ...record, job: expected[i] }))
    expect(decodeSavedJobs(JSON.stringify(records)).records).toEqual(migrated)
    expect(parseSavedImport(createSavedBackup(records, 0)).groups.map(group => group.variants[0])).toEqual(migrated)
    for (const [i, record] of migrated.entries()) {
      expect(SavedJobSchema.parse(record)).toEqual(record)
      const { visa: _v, evidence: _e, eligibility: _q, ...other } = record.job
      const { visa: _ov, evidence: _oe, eligibility: _oq, ...original } = records[i].job
      expect(other).toEqual(original)
    }
  })

  it('applies current support facts to legacy search, explanations and saved comparisons without inferring legal eligibility', async () => {
    const jobs = [legacySponsorshipJob('internship'), legacySponsorshipJob('transfer'), legacySponsorshipJob('unknown')]
    const catalog = searchCatalog(jobs)
    const profile = { ...SEARCH_PROFILE, desiredRole: 'all' as const, skills: [], residence: 'KR' }
    expect(filterJobs(catalog, profile, { ...DEFAULT_FILTERS, visa: 'yes' }).map(match => match.job.id)).toEqual([jobs[0].id])
    expect(filterJobs(catalog, profile, { ...DEFAULT_FILTERS, visa: 'supported' }).map(match => match.job.id).sort()).toEqual(jobs.slice(0, 2).map(job => job.id).sort())
    expect(matchJob(jobs[0], profile).reasons).toContain('공고에서 비자 지원을 명시했어요')
    expect(matchJob(jobs[1], profile).cautions.join(' ')).toContain('지원자별 조건')
    expect(matchJob(jobs[0], profile).cautions.join(' ')).toContain('거주 요건')
    expect(matchJob(jobs[1], profile)).toEqual(matchJob(jobs[1], { ...profile, residence: 'GB' }))
    for (const job of jobs) expect(await createJobRevision(job)).toEqual(await createJobRevision(upgradeJobEligibility(job)))
    const sample = { ...searchJob('sample'), source: 'sample' as const }
    expect(upgradeJobEligibility(sample)).toBe(sample)
  })

  it('detects a change in sponsorship evidence beyond the saved body even when the support value stays the same', async () => {
    const make = (verb: string) => normalizeJob(workplacePosting(2510, 'Backend Engineer', 'London',
      `${'Background. '.repeat(2500)}\nVisa sponsorship and relocation support are ${verb}.`), company.id, SEARCH_TIME)!
    const before = make('provided')
    const after = make('offered')
    expect(before.visa).toBe('yes')
    expect(after.visa).toBe('yes')
    expect(before.description).toBe(after.description)
    expect(before.description).not.toContain('visa sponsorship')
    const left = await createJobRevision(before)
    const right = await createJobRevision(after)
    expect(REVISION_FIELDS.filter(field => left[field] !== right[field])).toEqual(['conditions'])
  })
})
