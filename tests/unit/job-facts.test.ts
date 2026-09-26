import { describe, expect, it } from 'vitest'
import { employmentFact, visaFact, workModeFact } from '../../server/job-facts'
import { normalizeJob, parseSalary } from '../../server/normalize'

const conditionalPolicy = "We do sponsor visas! However, we aren't able to successfully sponsor visas for every role and every candidate."

describe('visa evidence and limitations', () => {
  it('preserves explicit support together with its qualification', () => {
    const fact = visaFact(conditionalPolicy)
    expect(fact.value).toBe('conditional')
    expect(fact.evidence).toEqual({ source: 'description', text: conditionalPolicy })
    expect(visaFact('We can sponsor work visas.\n\nVisa sponsorship is considered on a case-by-case basis.').value).toBe('conditional')
  })

  it('does not read negated support or a question as an affirmative policy', () => {
    for (const text of ['We do not provide visa sponsorship.', 'No visa sponsorship is available.', 'We cannot sponsor visas.']) {
      expect(visaFact(text).value, text).toBe('no')
    }
    for (const text of ['Do you require visa sponsorship?', 'Visa sponsorship may be available.', 'No visa sponsorship is required.']) {
      expect(visaFact(text).value, text).toBe('unknown')
    }
    expect(visaFact('We do sponsor visas.').value).toBe('yes')
  })

  it('retains contradictory statements for inspection without asserting support', () => {
    const text = 'We offer visa sponsorship.\n\nWe cannot sponsor visas for this role.'
    expect(visaFact(text).value).toBe('unknown')
    expect(visaFact(text).evidence?.text).toBe(text)
    expect(visaFact('We can sponsor visas on a case-by-case basis. No visa sponsorship is available for this role.').value).toBe('unknown')
  })

  it('does not equate payment networks, relocation, or a limited denial with visa support', () => {
    expect(visaFact('Experience with BIN sponsorship models, Visa and Mastercard.').value).toBe('unknown')
    expect(visaFact('Relocation and immigration guidance are available.').value).toBe('unknown')
    expect(visaFact('We cannot sponsor visas for every candidate.').value).toBe('unknown')
  })

  it('does not confuse export-license sponsorship with immigration sponsorship', () => {
    const exportPolicy = 'Any offer of employment may be conditioned on your authorization to receive software controlled under U.S. export laws without sponsorship for an export license.'
    expect(visaFact(exportPolicy)).toEqual({ value: 'unknown' })
    expect(visaFact(`We offer visa sponsorship. ${exportPolicy}`).value).toBe('yes')
    expect(visaFact('Applicants must be authorized to work without sponsorship.').value).toBe('no')
  })
})

describe('job-specific work and employment fields', () => {
  it('uses Location Type and Time Type while retaining the exact board values', () => {
    const metadata = [{ name: 'Location Type', value: 'On-Site' }, { name: 'Time Type', value: 'Full time' }]
    expect(workModeFact('San Francisco, CA', metadata, '')).toEqual({ value: 'onsite', evidence: { source: 'board', text: 'Location Type: On-Site' } })
    expect(employmentFact('Software Engineer', metadata, '')).toEqual({ value: 'fulltime', evidence: { source: 'board', text: 'Time Type: Full time' } })
  })

  it('prefers a board-specific arrangement over general company prose', () => {
    expect(workModeFact('London, UK', [{ name: 'Workplace Type', value: 'Remote' }], 'Some employees work in a hybrid model.').value).toBe('remote')
    expect(workModeFact('London, UK', [{ name: 'Working Model Eligibility', value: ['2-Flexible'] }], '').value).toBe('unknown')
  })

  it('does not assign a single arrangement to conflicting board fields', () => {
    const fact = workModeFact('Remote', [{ name: 'Workplace Type', value: 'Remote' }, { name: 'Location Type', value: 'On-Site' }], '')
    expect(fact.value).toBe('unknown')
    expect(fact.evidence?.text).toContain('On-Site')
  })

  it('only uses an explicit statement about this vacancy as a description fallback', () => {
    expect(workModeFact('London', [], 'This is a hybrid role based in London.').value).toBe('hybrid')
    expect(workModeFact('London', [], 'This role is fully remote.').value).toBe('remote')
    expect(workModeFact('London', [], 'Our company has remote and hybrid teams.').value).toBe('unknown')
    expect(workModeFact('London', [], 'This role builds remote monitoring software.').value).toBe('unknown')
    expect(workModeFact('London', [], 'This role is not remote.').value).toBe('unknown')
    expect(workModeFact('London', [], 'This role might become remote in the future.').value).toBe('unknown')
    expect(employmentFact('Software Engineer', [], 'This is a full-time position.').value).toBe('fulltime')
    expect(employmentFact('Software Engineer', [], 'Benefits for full-time employees include health insurance.').value).toBe('unknown')
    expect(employmentFact('Software Engineer', [], 'This role works with full-time colleagues.').value).toBe('unknown')
  })

  it.each([
    ['This role is based in our Vancouver office with an office-centric hybrid schedule.', 'hybrid'],
    ['This position will be located at the Toronto office on a hybrid working arrangement.', 'hybrid'],
    ['The job is based in Paris with a remote work arrangement.', 'remote'],
  ])('keeps the role-specific schedule after an office location: %s', (text, expected) => {
    expect(workModeFact('', [], text)).toEqual({ value: expected, evidence: { source: 'description', text } })
  })

  it.each([
    ['This role follows an office-centric hybrid schedule.', 'hybrid'],
    ['This position follows an on-site work arrangement.', 'onsite'],
  ])('retains an explicit role-specific follows statement: %s', (text, expected) => {
    expect(workModeFact('', [], text)).toEqual({ value: expected, evidence: { source: 'description', text } })
  })

  it.each([
    'Our company follows a hybrid schedule.',
    'This role might follow a hybrid schedule.',
    'This role does not follow an on-site work arrangement.',
    'This role follows hybrid cloud architecture standards.',
  ])('does not infer this vacancy arrangement from a nonassertive follows statement: %s', text => {
    expect(workModeFact('', [], text).value).toBe('unknown')
  })

  it.each([
    'Our company has a Vancouver office with an office-centric hybrid schedule.',
    'This role might be based in Vancouver with a hybrid schedule.',
    'This role is not based in Vancouver with a hybrid schedule.',
    'This role is based in Vancouver with a potential hybrid schedule.',
    'This role is based in Vancouver with a team building hybrid schedule optimizers.',
    'This role is based in Vancouver with a hybrid cloud model.',
    'This role is based in Vancouver. Our other offices have a hybrid schedule.',
  ])('does not turn a company policy, uncertain arrangement or product into the vacancy schedule: %s', text => {
    expect(workModeFact('', [], text).value).toBe('unknown')
  })

  it('retains conflicting prose as unknown and gives an explicit board field precedence over an office schedule', () => {
    const text = 'This role is based in our Vancouver office with an office-centric hybrid schedule.'
    const contradictory = workModeFact('', [], `${text}\nThis role is fully remote.`)
    expect(contradictory.value).toBe('unknown')
    expect(contradictory.evidence?.text).toContain(text)
    expect(workModeFact('', [{ name: 'Workplace Type', value: 'OnSite' }], text)).toEqual({
      value: 'onsite', evidence: { source: 'board', text: 'Workplace Type: OnSite' },
    })
  })

  it('preserves contract categories and supports part-time and temporary positions', () => {
    expect(employmentFact('Software Engineer Intern', [{ name: 'Time Type', value: 'Full time' }], '').value).toBe('intern')
    expect(employmentFact('Software Engineer (Contract)', [{ name: 'Time Type', value: 'Full time' }], '').value).toBe('contract')
    expect(employmentFact('Software Engineer', [{ name: 'Employment Type', value: 'Part-time' }], '').value).toBe('parttime')
    expect(employmentFact('Software Engineer — Fixed term', [], '').value).toBe('temporary')
  })
})

describe('Greenhouse adapter integration', () => {
  it('carries evidence through normalization and keeps a metadata remote role off the map', () => {
    const job = normalizeJob({
      id: 981, title: 'Software Engineer', absolute_url: 'https://example.com/jobs/981',
      location: { name: 'United Kingdom' },
      metadata: [{ name: 'Location Type', value: 'Remote' }, { name: 'Time Type', value: 'Full time' }],
      content: `<p>${conditionalPolicy}</p><p>Python and AWS. 5 years of software engineering experience.</p>`,
      offices: [{ name: 'San Francisco, CA' }],
    }, 'example', '2026-09-19T00:00:00.000Z')!
    expect(job.visa).toBe('conditional')
    expect(job.workMode).toBe('remote')
    expect(job.cityIds).toEqual([])
    expect(job.remoteCountries).toEqual(['GB'])
    expect(job.employment).toBe('fulltime')
    expect(job.evidence?.visa?.text).toBe(conditionalPolicy)
    expect(job.evidence?.workMode?.text).toBe('Location Type: Remote')
  })

  it('reads the documented currency_type property in structured pay ranges', () => {
    expect(parseSalary('', [], [{ title: 'Annual Base Salary Range', min_cents: 15000000, max_cents: 20000000, currency_type: 'USD' }])).toEqual({ min: 150000, max: 200000, currency: 'USD' })
  })
})
