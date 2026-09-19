import { afterEach, describe, expect, it, vi } from 'vitest'
import { PUBLIC_COMPANIES } from '../../shared/companies'
import { eligibilityFacts, eligibilitySummary, upgradeJobEligibility, visaFact } from '../../shared/job-eligibility'
import { filterJobs, matchJob } from '../../shared/matching'
import { createJobRevision, REVISION_FIELDS } from '../../shared/posting-status'
import { createSampleCatalog } from '../../shared/sample'
import { JobSchema } from '../../shared/schemas'
import { DEFAULT_FILTERS, SAMPLE_PROFILE } from '../../shared/types'
import type { Job, SavedJob } from '../../shared/types'
import { BoardSnapshotSchema } from '../../server/board-cache'
import { normalizeJob } from '../../server/normalize'
import { normalizeAshbyJob } from '../../server/providers/ashby'
import { normalizeLeverJob } from '../../server/providers/lever'
import { loadSaved, STORAGE_KEYS } from '../../src/lib/storage'
import { ashbyPosting, leverPosting, POSTING_TIME } from '../fixtures/public-postings'

const company = PUBLIC_COMPANIES[0]
const countryPolicy = 'We can sponsor visas to Germany; for any other country, you need to have existing right to work.'
const limitedPolicy = "Visa sponsorship: We do sponsor visas! However, we aren't able to successfully sponsor visas for every role and every candidate."
const makeJob = (text: string): Job => normalizeJob({
  id: 8801, title: 'Backend Engineer', location: { name: 'Remote, Global' },
  absolute_url: 'https://example.com/eligibility/8801',
  content: `<p>Minimum requirements</p><p>3 years of engineering experience. Experience with Python and AWS.</p>${text.split('\n').map(line => `<p>${line}</p>`).join('')}`,
}, company.id, POSTING_TIME)!

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('country-specific sponsorship is a conditional policy', () => {
  it.each([
    countryPolicy,
    'We provide visa sponsorship in Canada.',
    'Visa sponsorship is available in the United Kingdom.',
    'We can sponsor visas for US-based roles.',
    'We offer visa sponsorship.\nSponsorship is limited to Germany.',
    'We can sponsor visas to Brazil.',
    'Visa sponsorship is available in poland.',
    'Visa sponsorship is only available in Bangladesh.',
    'We offer visa sponsorship for London.',
  ])('preserves location restrictions in the evidence: %s', text => {
    expect(visaFact(text)).toMatchObject({ value: 'conditional', evidence: { source: 'description' } })
    for (const line of text.split('\n')) expect(visaFact(text).evidence?.text).toContain(line)
  })

  it('does not confuse ordinary recipients or additional benefits with a geographical restriction', () => {
    for (const text of [
      'We provide visa sponsorship to all applicants.',
      'We offer visa sponsorship for this role.',
      'We provide visa sponsorship in addition to relocation assistance.',
      'Visa sponsorship is available for us.',
    ]) expect(visaFact(text).value, text).toBe('yes')
  })

  it('does not infer visa support from an existing work permit or a required right to work', () => {
    for (const text of [
      'Applicants must already have work authorization in France.',
      'You need to have the right to work in the UK.',
      'You must hold a valid work permit.',
    ]) {
      const result = eligibilityFacts(text)
      expect(result.visa, text).toBe('unknown')
      expect(result.eligibility.rules, text).toContainEqual(expect.objectContaining({ kind: 'work-authorization', level: 'required' }))
    }
  })

  it('keeps firm denials, conditional support and contradictions distinct', () => {
    expect(visaFact('We cannot sponsor visas for this role in Germany.').value).toBe('no')
    expect(visaFact('Applicants must be authorized to work without sponsorship.').value).toBe('no')
    expect(visaFact(limitedPolicy).value).toBe('conditional')
    expect(visaFact('We provide visa sponsorship. We cannot sponsor visas for this role.').value).toBe('unknown')
    expect(visaFact('No visa sponsorship is required.').value).toBe('unknown')
    expect(visaFact('Do you require visa sponsorship?').value).toBe('unknown')
  })

  it('records both the support scope and the other-country authorization requirement', () => {
    expect(eligibilityFacts(countryPolicy).eligibility.rules).toEqual([
      { kind: 'sponsorship-scope', level: 'conditional', evidence: { source: 'description', text: countryPolicy } },
      { kind: 'work-authorization', level: 'conditional', evidence: { source: 'description', text: countryPolicy } },
    ])
  })
})

describe('requirements are separate from sponsorship and applicant identity', () => {
  it.each([
    'Be a US Citizen',
    'Only US citizens may apply.',
    'Applicants must be a United States Citizen and must be based in the United States.',
    'Eligibility: must hold citizenship in the target territory (France for now).',
    'This role is fully remote for a candidate based in the United States with US citizenship.',
  ])('retains an explicit citizenship condition without converting it into visa support: %s', text => {
    const result = eligibilityFacts(text)
    expect(result.visa).toBe('unknown')
    expect(result.eligibility.rules).toContainEqual({ kind: 'citizenship', level: 'required', evidence: { source: 'description', text } })
  })

  it('distinguishes preferred clearance from a separate mandatory citizenship statement and its proof alternatives', () => {
    const citizenship = 'This position requires verification of U.S. citizenship due to citizenship-based legal restrictions. This position supports a government customer and is subject to citizenship-based restrictions where required or permitted by applicable law. Citizenship will be verified via a valid passport, other approved documents, or verified US government clearance.'
    const text = `Preferred qualifications\nActive federal security clearance (Secret or above)\n${citizenship}\n${limitedPolicy}`
    const result = eligibilityFacts(text)
    expect(result.visa).toBe('conditional')
    expect(result.eligibility.rules.filter(rule => rule.kind === 'citizenship')).toEqual([
      { kind: 'citizenship', level: 'required', evidence: { source: 'description', text: citizenship } },
    ])
    expect(result.eligibility.rules.filter(rule => rule.kind === 'security-clearance')).toEqual([
      { kind: 'security-clearance', level: 'preferred', evidence: { source: 'description', text: 'Preferred qualifications\nActive federal security clearance (Secret or above)' } },
    ])
  })

  it('preserves alternatives between holding and obtaining clearance without saying it must already be held', () => {
    const text = 'Required qualifications\nActive secret security clearance or higher, or eligibility to obtain one'
    const result = eligibilityFacts(text)
    expect(result.eligibility.rules).toEqual([
      { kind: 'security-clearance', level: 'required', evidence: { source: 'description', text: text.split('\n')[1] } },
    ])
    expect(eligibilityFacts('Qualifications\nClearable: must meet all local requirements for high-level security clearance.').eligibility.rules[0]).toMatchObject({ kind: 'security-clearance', level: 'required' })
  })

  it('retains subnational residence restrictions without widening them to legal eligibility in the entire country', () => {
    const text = 'This position is US - Remote Eligible. While the position is Remote Eligible, you must live in a state where our company has a registered entity. Check the current list of excluded states.'
    const rules = eligibilityFacts(text).eligibility.rules
    expect(rules).toEqual([{ kind: 'residency', level: 'required', evidence: { source: 'description', text } }])
  })

  it('keeps export authorization separate from visas and does not equate U.S. person with citizenship', () => {
    const exportPolicy = 'This position may require access to information protected under U.S. export control laws. Any offer of employment may be conditioned on authorization to receive software under these export laws without sponsorship for an export license.'
    const result = eligibilityFacts(exportPolicy)
    expect(result.visa).toBe('unknown')
    expect(result.eligibility.rules).toEqual([{ kind: 'export-authorization', level: 'conditional', evidence: { source: 'description', text: exportPolicy } }])
    const person = eligibilityFacts('Applicants must be a U.S. Person under ITAR. This may include lawful permanent residents; U.S. citizenship is not required.')
    expect(person.eligibility.rules.map(rule => rule.kind)).toEqual(['export-authorization'])
    expect(eligibilityFacts(`We provide visa sponsorship.\n${exportPolicy}`).visa).toBe('yes')
  })

  it('ignores equal-opportunity policies, software metaphors, privacy inventories, questions and past experience with clearance systems', () => {
    for (const text of [
      'Qualifications\nWe do not discriminate based on nationality or citizenship.',
      'You must build APIs as first-class citizens in our ecosystem.',
      'Qualifications\nWork authorization (if applicable)',
      'What is your citizenship status?',
      'Preferred qualifications\nExperience building systems that manage security clearance records.',
      'US citizenship is not required.',
    ]) expect(eligibilityFacts(text).eligibility.rules, text).toEqual([])
  })

  it('does not inherit a preferred heading across a company policy paragraph', () => {
    const text = `Nice-to-have skills\nExperience with Rust.\nWe are an equal opportunity employer.\n${countryPolicy}`
    expect(eligibilityFacts(text).eligibility.rules.every(rule => rule.level === 'conditional')).toBe(true)
    expect(eligibilityFacts('Preferred qualifications\nBe a US Citizen').eligibility.rules[0].level).toBe('required')
  })

  it('bounds evidence and result size and marks incomplete extraction', () => {
    const text = Array.from({ length: 70 }, (_, index) => `Applicants must have valid work authorization for assignment ${index}.`).join('\n')
    const result = eligibilityFacts(text).eligibility
    expect(result.rules).toHaveLength(50)
    expect(result.truncated).toBe(true)
    const long = eligibilityFacts(`Applicants must be US citizens. ${'More information. '.repeat(7000)}`).eligibility
    expect(long.truncated).toBe(true)
    expect(long.rules.every(rule => rule.evidence.text.length <= 3000)).toBe(true)
  })
})

describe('normalization, persistence and matching', () => {
  it('uses the same facts across Greenhouse, Ashby and Lever feeds', () => {
    const results = [
      makeJob(countryPolicy),
      normalizeAshbyJob(ashbyPosting({ descriptionPlain: countryPolicy }), 'supabase', POSTING_TIME)!,
      normalizeLeverJob(leverPosting({ descriptionPlain: countryPolicy }), 'spotify', POSTING_TIME)!,
    ]
    for (const job of results) {
      expect(job.visa).toBe('conditional')
      expect(job.eligibility?.rules.map(rule => rule.kind)).toEqual(['sponsorship-scope', 'work-authorization'])
      expect(JobSchema.safeParse(job).success).toBe(true)
    }
  })

  it('excludes country-limited support from the unconditional filter but keeps it when conditional support is requested', () => {
    const job = makeJob(countryPolicy)
    const catalog = { ...createSampleCatalog(), companies: [company], jobs: [job] }
    expect(filterJobs(catalog, SAMPLE_PROFILE, { ...DEFAULT_FILTERS, visa: 'yes' })).toEqual([])
    expect(filterJobs(catalog, SAMPLE_PROFILE, { ...DEFAULT_FILTERS, visa: 'supported' })).toHaveLength(1)
  })

  it('never treats matching residence as citizenship, permission to work or clearance', () => {
    const job = { ...makeJob('Applicants must be US citizens. Applicants must hold active security clearance.'), remoteWorldwide: false, remoteCountries: ['US'] }
    const match = matchJob(job, { ...SAMPLE_PROFILE, residence: 'US' })
    expect(match.reasons).toContain('선택한 거주 국가가 공고의 원격근무 지역에 포함돼요')
    expect(match.reasons.join(' ')).not.toMatch(/지원이 가능|시민권.*충족|취업 허가.*충족|보안 인가.*충족/)
    expect(match.cautions.join(' ')).toContain('국적·시민권')
    expect(match.cautions.join(' ')).toContain('보안 인가')
    expect(match.score).toBe(matchJob(job, { ...SAMPLE_PROFILE, residence: 'GB' }).score)
    expect(eligibilitySummary(job)).toBe('국적·시민권 · 보안 인가 조건 확인')
  })

  it('rechecks old cache and saved visa facts without changing collection time or application records', () => {
    const { eligibility: _current, ...legacy } = makeJob(countryPolicy)
    const oldJob = { ...legacy, visa: 'yes' as const, stale: true }
    const previous: SavedJob = { job: oldJob, company, savedAt: '2026-09-18T06:00:00.000Z', status: 'applied', note: 'Original application note' }
    vi.stubGlobal('localStorage', { getItem: (key: string) => key === STORAGE_KEYS.saved ? JSON.stringify([previous]) : null })
    const restored = loadSaved()[0]
    expect(restored).toMatchObject({ savedAt: previous.savedAt, status: 'applied', note: previous.note, job: { id: oldJob.id, fetchedAt: POSTING_TIME, stale: true, visa: 'conditional', eligibility: { version: 1 } } })
    const snapshot = BoardSnapshotSchema.parse({ fetchedAt: POSTING_TIME, jobs: [oldJob], total: 1, unmappedCount: 0, publishedIds: [oldJob.id] })
    expect(snapshot.jobs[0]).toMatchObject({ id: oldJob.id, fetchedAt: POSTING_TIME, visa: 'conditional' })
    expect(snapshot.publishedIds).toEqual([oldJob.id])
    expect(upgradeJobEligibility(restored.job)).toBe(restored.job)
    const sample = createSampleCatalog().jobs[0]
    expect(upgradeJobEligibility(sample)).toBe(sample)
  })

  it('includes eligibility changes in saved content comparison without changing unrelated sections', async () => {
    const job = makeJob('Applicants must be US citizens.')
    const before = { ...job, eligibility: undefined }
    const first = await createJobRevision(before)
    const next = await createJobRevision(job)
    expect(REVISION_FIELDS.filter(field => first[field] !== next[field])).toEqual(['conditions'])
  })
})
