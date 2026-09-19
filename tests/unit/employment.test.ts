import { describe, expect, it } from 'vitest'
import { employmentFact } from '../../server/job-facts'
import { normalizeJob } from '../../server/normalize'
import { normalizeAshbyJob } from '../../server/providers/ashby'
import { normalizeLeverJob } from '../../server/providers/lever'
import { normalizeSmartRecruitersJob } from '../../server/providers/smartrecruiters'
import { BoardSnapshotSchema } from '../../server/board-cache'
import { upgradeJobEmployment } from '../../shared/job-employment'
import { createJobRevision } from '../../shared/posting-status'
import { SavedJobSchema } from '../../shared/saved-jobs'
import { DEFAULT_FILTERS, EMPLOYMENT_VERSION } from '../../shared/types'
import { filterJobs } from '../../shared/matching'
import { CONTRACT_TECHNOLOGY_TITLE, employmentPosting, legacyEmploymentJob, MENTORING_BODY } from '../fixtures/employment'
import { ashbyPosting, leverPosting, smartRecruitersPosting } from '../fixtures/public-postings'
import { SEARCH_COMPANIES, SEARCH_PROFILE, SEARCH_TIME, searchCatalog } from '../fixtures/search-catalog'

describe('employment statements and technical titles', () => {
  it.each([
    CONTRACT_TECHNOLOGY_TITLE,
    'Smart Contract Engineer',
    'Smart-contract Engineer',
    'Software Engineer - API Contract Testing',
    'Software Engineer - Contract Management',
    'Software Engineer - Temporary Credentials',
    'Engineering Manager - Intern Program',
  ])('does not turn a technical subject into an employment category: %s', title => {
    expect(employmentFact(title, [], '')).toEqual({ value: 'unknown' })
    expect(employmentFact(title, [{ name: 'Employment Type', value: 'FullTime' }], '')).toEqual({
      value: 'fulltime', evidence: { source: 'board', text: 'Employment Type: FullTime' },
    })
  })

  it.each([
    ['Contract Software Engineer', 'contract'],
    ['Senior Contract Backend Engineer', 'contract'],
    ['Smart Contract Engineer (Contract)', 'contract'],
    ['Data Scientist - Video (12-month contract)', 'contract'],
    ['Software Engineer, Contractor', 'contract'],
    ['Freelance Software Developer', 'contract'],
    ['Temporary Software Engineer', 'temporary'],
    ['Software Engineer — Fixed term', 'temporary'],
    ['Software Engineer Intern (Summer 2027)', 'intern'],
    ['Applied Scientist (Internship in Paris or London)', 'intern'],
    ['Intern Software Engineer', 'intern'],
    ['Intern, Software Engineer', 'intern'],
  ])('retains an explicit employment qualifier: %s', (title, value) => {
    expect(employmentFact(title, [{ name: 'Time Type', value: 'Full time' }], '')).toEqual({
      value, evidence: { source: 'title', text: title },
    })
  })

  it.each([
    MENTORING_BODY,
    'This is a full-time position building smart contract tooling.',
    'This role is a full-time position supporting contract negotiations.',
    'This is a full-time position with employee benefits.',
    'This is a full-time position, not a contractor engagement.',
    'This is a full-time and permanent position.',
  ])('reads only the declared condition, retaining the surrounding sentence: %s', text => {
    expect(employmentFact('Software Engineer', [], text)).toEqual({
      value: 'fulltime', evidence: { source: 'description', text },
    })
  })

  it.each([
    'Benefits for full-time employees include health insurance.',
    'This role mentors full-time colleagues and an intern.',
    'This is a contract testing role.',
    'This role is contract management.',
    'This role may be full-time.',
    'This role could be full-time.',
    'This role can be full-time.',
    'This role is not full-time.',
    'This is a full-time position?',
  ])('keeps unrelated, uncertain or negated conditions unknown: %s', text => {
    expect(employmentFact('Software Engineer', [], text).value).toBe('unknown')
  })

  it('retains alternatives and conflicting assertions without selecting a single value', () => {
    for (const text of [
      'This is a full-time or part-time position.',
      'This is a full-time role or a part-time position.',
      'This role is full-time. This role is part-time.',
    ]) expect(employmentFact('Software Engineer', [], text)).toEqual({
      value: 'unknown', evidence: { source: 'description', text: text.replace('. This', '.\nThis') },
    })
  })

  it('does not equate indefinite duration with working hours or borrow a technical title over a board contract', () => {
    expect(employmentFact('Software Engineer', [], 'This is a permanent role.').value).toBe('permanent')
    expect(employmentFact(CONTRACT_TECHNOLOGY_TITLE, [{ name: 'Employment Type', value: 'Contract' }], MENTORING_BODY)).toEqual({
      value: 'contract', evidence: { source: 'board', text: 'Employment Type: Contract' },
    })
  })
})

describe('old employment records', () => {
  it('repairs a title-based claim without fabricating missing board metadata, while preserving the source record', () => {
    const original = legacyEmploymentJob()
    const current = upgradeJobEmployment(original)
    expect(current).toMatchObject({ employment: 'unknown', employmentVersion: EMPLOYMENT_VERSION, id: original.id, fetchedAt: original.fetchedAt, title: original.title })
    expect(current.evidence?.employment).toBeUndefined()
    expect(original.employment).toBe('contract')
    expect(original.evidence?.employment?.text).toBe(CONTRACT_TECHNOLOGY_TITLE)
    expect(upgradeJobEmployment(current)).toBe(current)
    const { employment: _oldValue, employmentVersion: _oldVersion, evidence: _oldEvidence, ...before } = original
    const { employment: _value, employmentVersion: _version, evidence: _evidence, ...after } = current
    expect(after).toEqual(before)
  })

  it('uses retained full evidence even when it is outside the truncated display body', () => {
    const original = { ...legacyEmploymentJob('description'), description: 'Archived display excerpt without the final conditions.' }
    expect(upgradeJobEmployment(original)).toMatchObject({
      employment: 'fulltime', evidence: { employment: { source: 'description', text: MENTORING_BODY } },
    })
  })

  it('preserves explicit board facts, authored samples and old values whose original evidence is unavailable', () => {
    const original = legacyEmploymentJob()
    for (const job of [
      { ...original, evidence: undefined },
      { ...original, source: 'sample' as const },
      { ...original, evidence: { employment: { source: 'board' as const, text: 'Employment type: Contract' } } },
    ]) expect(upgradeJobEmployment(job)).toBe(job)
  })

  it('keeps saved notes, application state, timestamps and public IDs while cache, search and revision comparison agree', async () => {
    const old = legacyEmploymentJob()
    const company = SEARCH_COMPANIES[0]
    const fresh = normalizeJob(employmentPosting(), company.id, SEARCH_TIME)!
    const saved = SavedJobSchema.parse({ job: old, company, savedAt: SEARCH_TIME, status: 'applied', note: 'Private preserved note' })
    expect(saved).toMatchObject({ job: { employment: 'unknown', fetchedAt: SEARCH_TIME }, savedAt: SEARCH_TIME, status: 'applied', note: 'Private preserved note' })
    const cache = BoardSnapshotSchema.parse({ fetchedAt: SEARCH_TIME, jobs: [old], total: 1, unmappedCount: 0, publishedIds: [old.id] })
    expect(cache).toMatchObject({ fetchedAt: SEARCH_TIME, publishedIds: [old.id], jobs: [{ employment: 'unknown', fetchedAt: SEARCH_TIME }] })
    const catalog = searchCatalog([old])
    const profile = { ...SEARCH_PROFILE, desiredRole: 'all' as const, skills: [] }
    expect(filterJobs(catalog, profile, { ...DEFAULT_FILTERS, employment: 'contract' })).toEqual([])
    expect(filterJobs(catalog, profile, { ...DEFAULT_FILTERS, employment: 'unknown' }).map(match => match.job.id)).toEqual([old.id])
    expect(await createJobRevision(old)).toEqual(await createJobRevision(fresh))
  })
})

describe('provider employment integration', () => {
  it('applies the same distinction through all four public providers and preserves their board fields', () => {
    const jobs = [
      normalizeJob({ ...employmentPosting(), metadata: [{ name: 'Time Type', value: 'Full time' }] }, 'fixture', SEARCH_TIME),
      normalizeAshbyJob(ashbyPosting({ title: CONTRACT_TECHNOLOGY_TITLE, employmentType: 'FullTime' }), 'fixture', SEARCH_TIME),
      normalizeLeverJob(leverPosting({ text: CONTRACT_TECHNOLOGY_TITLE, categories: { location: 'London, UK', commitment: 'Full-time' } }), 'fixture', SEARCH_TIME),
      normalizeSmartRecruitersJob(smartRecruitersPosting({ name: CONTRACT_TECHNOLOGY_TITLE }), 'fixture', SEARCH_TIME),
    ]
    for (const job of jobs) expect(job).toMatchObject({
      title: CONTRACT_TECHNOLOGY_TITLE, employment: 'fulltime', employmentVersion: EMPLOYMENT_VERSION,
      evidence: { employment: { source: 'board' } }, fetchedAt: SEARCH_TIME,
    })
  })
})
