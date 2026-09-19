import { describe, expect, it } from 'vitest'
import { qualificationFacts, upgradeJobQualifications, formatExperienceYears } from '../../shared/job-qualifications'
import { matchJob, filterJobs } from '../../shared/matching'
import { JobSchema } from '../../shared/schemas'
import { createSampleCatalog } from '../../shared/sample'
import { DEFAULT_FILTERS, SAMPLE_PROFILE } from '../../shared/types'
import type { Job } from '../../shared/types'
import { normalizeJob } from '../../server/normalize'
import { normalizeAshbyJob } from '../../server/providers/ashby'
import { normalizeLeverJob } from '../../server/providers/lever'

const now = '2026-09-19T07:00:00.000Z'
const demo = createSampleCatalog()
const makeJob = (text: string): Job => ({
  ...demo.jobs[0], id: 'greenhouse-stripe-qualifications', companyId: 'stripe', source: 'greenhouse',
  workMode: 'hybrid', cityIds: ['london'], fetchedAt: now, description: text, ...qualificationFacts(text),
})
const rules = (text: string) => qualificationFacts(text).qualifications!

describe('evidence-backed qualification extraction', () => {
  it('separates company introductions, explicit requirements, generic qualifications, preferences and the working stack', () => {
    const text = [
      'About Acme', 'Our company provides Python and AWS products.',
      'Minimum requirements', 'You must have Java and SQL experience.',
      'Who you are', 'Experience with Git.',
      'Nice to have', 'Experience with Python and AWS.',
      'Our tech', 'We use Rust and Kubernetes.',
      'What we offer', 'An annual bonus and a Figma license.',
    ].join('\n')
    expect(rules(text).skills.map(({ kind, skills, match }) => ({ kind, skills, match }))).toEqual([
      { kind: 'required', skills: ['Java', 'SQL'], match: 'all' },
      { kind: 'qualification', skills: ['Git'], match: 'all' },
      { kind: 'preferred', skills: ['Python', 'AWS'], match: 'all' },
      { kind: 'context', skills: ['Rust', 'Kubernetes'], match: 'all' },
    ])
    expect(rules(text).skills[0].evidence.text).toBe('Minimum requirements\nYou must have Java and SQL experience.')
  })

  it('does not mistake an employer name, employment benefits or company culture for a skill', () => {
    const text = [
      'Figma helps people design together.',
      'Our systems shape the experience of backend engineers across Figma.',
      'We’d love to hear from you if you have:', 'Fluency in SQL and proficiency in Python.',
      'While it’s not required, it’s an added plus if you also have:', 'Experience with Rust.',
      'Finally, Figma is a close-knit company with a strong culture.',
      'Pay Transparency Disclosure', 'Figma offers an annual bonus and other benefits.',
      'Figma provides a package including Java training and cloud credits.',
    ].join('\n')
    const facts = qualificationFacts(text, 'figma')
    expect(facts.skills.sort()).toEqual(['Python', 'Rust', 'SQL'])
    expect(facts.qualifications!.skills.map(rule => rule.kind)).toEqual(['qualification', 'preferred'])
    expect(qualificationFacts('Minimum requirements\nExperience using Figma.', 'figma').skills).toEqual(['Figma'])
    expect(qualificationFacts('Key Qualifications\nFamiliarity with MongoDB.', 'mongodb').skills).toEqual(['MongoDB'])
  })

  it.each([
    ['Minimum requirements: Python and SQL.', 'required', ['Python', 'SQL']],
    ['About you\nYou have experience in Python (Rust is a plus).', 'qualification', ['Python']],
    ['Who You Are\nYou have experience with Python and ideally Rust.', 'qualification', ['Python']],
    ['자격 요건\nPython 경험이 있는 분\n우대 사항\nAWS 경험', 'qualification', ['Python']],
  ])('handles inline headings and optional phrases: %s', (text, kind, skills) => {
    const facts = rules(text)
    expect(facts.skills[0]).toMatchObject({ kind, skills })
    if (text.includes('Rust')) expect(facts.skills.at(-1)).toMatchObject({ kind: 'preferred', skills: ['Rust'] })
  })

  it('does not require React web experience solely because React Native is requested', () => {
    expect(qualificationFacts('Required qualifications\nExperience with React Native and TypeScript.').skills).toEqual(['TypeScript', 'React Native'])
    expect(qualificationFacts('Required qualifications\nExperience with React Native and React.js.').skills).toEqual(['React Native', 'React'])
  })

  it('keeps a complete quote around abbreviations and preserves mixed skill choices as uncertain', () => {
    const text = 'Fluency in SQL and a scripting language like Python or R, with exposure to data systems (e.g. Snowflake).'
    const fact = rules(`Who you are\n${text}`).skills[0]
    expect(fact.match).toBe('unspecified')
    expect(fact.evidence.text).toBe(`Who you are\n${text}`)
  })

  it('keeps unknown headings from carrying a must-have claim into another section', () => {
    const facts = rules('Minimum requirements\nPython experience.\nEmployee Wellbeing\nWe use Figma in voluntary workshops.')
    expect(facts.skills[0].kind).toBe('required')
    expect(facts.skills[1].kind).toBe('context')
  })

  it('does not treat a statement that prior experience is unnecessary as a skill requirement', () => {
    const fact = rules('Who you are\nNo prior Rust experience is required.').skills[0]
    expect(fact.kind).toBe('context')
    expect(matchJob(makeJob('Who you are\nNo prior Rust experience is required.'), { ...SAMPLE_PROFILE, skills: ['Rust'] }).matchedSkills).toEqual([])
  })

  it.each([
    'Strong candidates may also have experience with:',
    'Strong candidates may also:',
    'Ideally you will be:',
    'While not required, it’s an added plus if you also have:',
  ])('recognizes optional qualification headings without turning them into requirements: %s', heading => {
    const fact = qualificationFacts(`You may be a good fit if you:\nExperience with Python.\n${heading}\nExperience with Rust.\n5 years of software development experience.`)
    expect(fact.qualifications!.skills.map(rule => rule.kind)).toEqual(['qualification', 'preferred'])
    expect(fact.minExperience).toBeNull()
    expect(fact.qualifications!.experience[0].kind).toBe('preferred')
  })
})

describe('job-specific experience rather than the largest number anywhere in the posting', () => {
  it('uses required three years and retains preferred five years separately', () => {
    const text = 'Minimum requirements\nHave at least 3 years of experience shipping ML systems.\nPreferred qualifications\n5+ years of experience in full time software development.'
    const fact = qualificationFacts(text)
    expect(fact.minExperience).toBe(3)
    expect(fact.qualifications!.experience.map(rule => [rule.kind, rule.minYears])).toEqual([['required', 3], ['preferred', 5]])
    const match = matchJob(makeJob(text), { ...SAMPLE_PROFILE, years: 3 })
    expect(match.cautions.some(text => text.includes('2년 많아요'))).toBe(false)
    expect(match.reasons).toContain('입력 경력 3년 · 공고에서 확인한 연수 하한 3년')
    expect(match.reasons.some(text => text.includes('조건에 부합'))).toBe(false)
  })

  it('preserves degree-dependent alternatives rather than claiming a single total-year requirement', () => {
    const text = 'Minimum requirements\nA Bachelor’s degree and five (5) years of software engineering experience. In the alternative, a Master’s degree and three (3) years of experience.\nMust also have two (2) years of experience in each of the following:\nPython and SQL.'
    const fact = qualificationFacts(text)
    expect(fact.minExperience).toBeNull()
    expect(fact.qualifications!.experience.map(rule => [rule.minYears, rule.conditional])).toEqual([[5, true], [3, true], [2, false]])
    expect(fact.qualifications!.experienceNote).toContain('학력')
  })

  it('does not collapse alternative fields of experience to an unconditional minimum', () => {
    const fact = qualificationFacts('Required qualifications\n3 years of software engineering experience or 2 years of research experience.')
    expect(fact.minExperience).toBeNull()
    expect(fact.qualifications!.experience).toHaveLength(2)
  })

  it.each([
    ['Key Qualifications\n4–7 years of experience in software development.', 4, '4년'],
    ['About you\nYou have 2+ years as a technical individual contributor on AI products.', 2, '2년'],
    ['Minimum requirements\n18 months of professional engineering experience.', 1.5, '18개월'],
    ['Required qualifications\n0 years of experience required.', 0, '0년'],
    ['자격 요건\nPython 개발 경력 3년 이상', 3, '3년'],
  ])('reads an explicit professional duration: %s', (text, years, label) => {
    expect(qualificationFacts(text).minExperience).toBe(years)
    expect(formatExperienceYears(years)).toBe(label)
  })

  it('does not take experience from a company history, university attendance or benefits', () => {
    const text = 'About Acme\nOur company has 25 years of engineering experience.\nMinimum requirements\n2 years of university education or equivalent work experience.\nWhat we offer\nA sabbatical after 5 years of experience at our company.'
    expect(qualificationFacts(text).minExperience).toBeNull()
    expect(rules(text).experience).toEqual([])
  })

  it('excludes post-hire milestones and planning horizons from experience evidence', () => {
    const text = 'Your Expertise\nRequired\n3 years of engineering experience.\nSuccess Measures\nIn 12 months, you will work on gaining expertise in Python.\nAs a senior engineer, you will think 12+ months ahead and mentor engineers.'
    const fact = qualificationFacts(text)
    expect(fact.minExperience).toBe(3)
    expect(fact.qualifications!.experience).toHaveLength(1)
    expect(qualificationFacts('In 12 months, you will work on gaining expertise in Python.').minExperience).toBeNull()
  })

  it('does not confuse an OR list of fields with alternative year requirements', () => {
    const fact = qualificationFacts('Your Expertise\nRequired\n9+ years of experience in technology, software development, or systems integration, with at least 5–6 years of hands-on software development.')
    expect(fact.minExperience).toBe(9)
    expect(fact.qualifications!.experience.map(rule => rule.minYears)).toEqual([9, 5])
    expect(fact.qualifications!.experience.every(rule => !rule.conditional)).toBe(true)
  })

  it('never labels a truncated extraction as a complete experience comparison', () => {
    const text = `Minimum requirements\n3 years of software engineering experience.\n${'Long text '.repeat(11000)}`
    expect(qualificationFacts(text)).toMatchObject({ minExperience: null, qualifications: { truncated: true } })
  })
})

describe('ranking and explanations follow the kind of qualification', () => {
  it('does not penalize a profile for additional unmatched preferred technologies', () => {
    const base = makeJob('Minimum requirements\nExperience with Python and AWS.')
    const extra = makeJob(`${base.description}\nPreferred qualifications\nExperience with Rust, Java, C++ and Kubernetes.`)
    expect(matchJob(extra, SAMPLE_PROFILE).score).toBe(matchJob(base, SAMPLE_PROFILE).score)
    expect(matchJob(extra, SAMPLE_PROFILE).missingSkills).toEqual([])
    expect(matchJob(extra, SAMPLE_PROFILE).cautions.join(' ')).not.toContain('Rust')
  })

  it('does not demand every alternative when one language is sufficient', () => {
    const job = makeJob('Minimum requirements\nExperience with Python or Java.')
    expect(job.qualifications!.skills[0].match).toBe('any')
    const match = matchJob(job, SAMPLE_PROFILE)
    expect(match.missingSkills).toEqual([])
    expect(match.cautions.join(' ')).not.toContain('Java')
    const missing = matchJob(job, { ...SAMPLE_PROFILE, skills: ['Rust'] })
    expect(missing.cautions).toContain('필수 항목에서 프로필로 확인하지 못한 조건: Python / Java 중 하나')
  })

  it('gives core requirements more weight than an optional-only overlap and labels the reason correctly', () => {
    const optional = makeJob('Minimum requirements\nExperience with Java and SQL.\nNice to have\nExperience with Python and AWS.')
    const core = makeJob('Minimum requirements\nExperience with Python and AWS.')
    expect(matchJob(core, SAMPLE_PROFILE).score).toBeGreaterThan(matchJob(optional, SAMPLE_PROFILE).score)
    expect(matchJob(optional, SAMPLE_PROFILE).skillSummary).toBe('우대 항목 · Python · AWS')
    expect(matchJob(optional, SAMPLE_PROFILE).missingSkills).toEqual(['Java', 'SQL'])
  })

  it('does not use company or working-stack mentions to create a positive recommendation', () => {
    const job = makeJob('Our tech\nWe use Python and AWS.\nAbout Acme\nJava is used by our customers.')
    const match = matchJob(job, SAMPLE_PROFILE)
    expect(match.matchedSkills).toEqual([])
    expect(match.skillSummary).toBe('기술 자격 요건 확인 필요')
    expect(filterJobs({ ...demo, jobs: [job] }, SAMPLE_PROFILE, DEFAULT_FILTERS)).toHaveLength(1)
    expect(filterJobs({ ...demo, jobs: [job] }, SAMPLE_PROFILE, { ...DEFAULT_FILTERS, query: 'Python' })).toHaveLength(1)
  })

  it('does not double-count the same required skill just because it is repeated', () => {
    const text = 'Minimum requirements\nPython and Java experience.'
    expect(matchJob(makeJob(`${text}\nPython experience is required.`), SAMPLE_PROFILE).score)
      .toBe(matchJob(makeJob(text), SAMPLE_PROFILE).score)
  })
})

describe('provider and snapshot integration', () => {
  it('preserves section context from Greenhouse HTML, Ashby text and Lever lists', () => {
    const body = 'Minimum requirements\nPython and SQL experience.\nPreferred qualifications\nRust experience.'
    const gh = normalizeJob({ id: 1, title: 'Backend Engineer', absolute_url: 'https://example.com/jobs/1', location: { name: 'London' }, content: '<h3>Minimum requirements</h3><ul><li>Python and SQL experience.</li></ul><h3>Preferred qualifications</h3><li>Rust experience.</li>' }, 'stripe', now)!
    const ashby = normalizeAshbyJob({ id: '2', title: 'Backend Engineer', jobUrl: 'https://example.com/jobs/2', isListed: true, location: 'London', descriptionPlain: body }, 'linear', now)!
    const lever = normalizeLeverJob({ id: '3', text: 'Backend Engineer', hostedUrl: 'https://example.com/jobs/3', categories: { location: 'London' }, lists: [{ text: 'Minimum requirements', content: '<li>Python and SQL experience.</li>' }, { text: 'Preferred qualifications', content: '<li>Rust experience.</li>' }] }, 'spotify', now)!
    for (const job of [gh, ashby, lever]) {
      expect(job.qualifications!.skills.map(rule => rule.kind)).toEqual(['required', 'preferred'])
      expect(JobSchema.safeParse(job).success).toBe(true)
      expect(job.fetchedAt).toBe(now)
    }
  })

  it('rechecks derived skills and years in old snapshots without changing the record identity or age', () => {
    const { qualifications: _facts, ...old } = makeJob('Minimum requirements\n3 years of software development experience with Python.\nPreferred qualifications\n5 years of software development experience with Rust.')
    old.minExperience = 5
    old.skills = ['Python', 'Rust', 'Figma']
    const updated = upgradeJobQualifications(old)
    expect(updated).toMatchObject({ id: old.id, fetchedAt: now, minExperience: 3, skills: ['Python', 'Rust'], description: old.description })
    expect(upgradeJobQualifications(updated)).toBe(updated)
    expect(old.minExperience).toBe(5)
    expect(upgradeJobQualifications(demo.jobs[0])).toBe(demo.jobs[0])
  })
})
