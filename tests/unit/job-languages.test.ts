import { describe, expect, it } from 'vitest'
import { parseCachedBoards } from '../../server/board-cache'
import { normalizeJob } from '../../server/normalize'
import { normalizeAshbyJob } from '../../server/providers/ashby'
import { normalizeLeverJob } from '../../server/providers/lever'
import { normalizeSmartRecruitersJob } from '../../server/providers/smartrecruiters'
import { languageRequirements, languageSummary, upgradeJobLanguages } from '../../shared/job-languages'
import { countSearchJobs, createSearchIndex, inSearchScope, selectSearchJobs } from '../../shared/job-search'
import { upgradeCatalog, upgradeJob } from '../../shared/job-upgrade'
import { matchJob } from '../../shared/matching'
import { createJobRevision } from '../../shared/posting-status'
import { createSampleCatalog } from '../../shared/sample'
import { createSavedBackup, parseSavedImport } from '../../shared/saved-backup'
import { decodeSavedJobs, SavedJobSchema } from '../../shared/saved-jobs'
import { JobSchema } from '../../shared/schemas'
import type { Job, JobProvider, LanguageRequirement, SpokenLanguageCode } from '../../shared/types'
import {
  LANGUAGE_CHANGED, LANGUAGE_FETCHED_AT, LANGUAGE_FILTERS, LANGUAGE_MIXED,
  LANGUAGE_NOTE, LANGUAGE_NOW, LANGUAGE_PROFILE, LANGUAGE_SAVED_AT, LANGUAGE_SCOPED, LANGUAGE_UPDATED_AT,
  languageAshbyRaw, languageGreenhouseRaw, languageHtml, languageLeverRaw, languageSmartRecruitersRaw,
  legacyLanguageCatalog, legacyLanguageJob, legacyLanguageSaved,
} from '../fixtures/job-languages'

const literalRule = (
  languages: SpokenLanguageCode[], kind: LanguageRequirement['kind'],
  match: LanguageRequirement['match'], text: string,
): LanguageRequirement => ({ languages, kind, match, evidence: { source: 'description', text } })

const affirmative: {
  name: string; text: string; languages: SpokenLanguageCode[];
  kind: LanguageRequirement['kind']; match: LanguageRequirement['match'];
}[] = [
  { name: 'explicit applicant speech', text: 'Applicants must speak English fluently.', languages: ['en'], kind: 'required', match: 'all' },
  { name: 'employer directly requires applicant ability', text: 'We require fluency in English.', languages: ['en'], kind: 'required', match: 'all' },
  { name: 'unqualified proficiency claim', text: 'Proficiency in written German.', languages: ['de'], kind: 'qualification', match: 'all' },
  { name: 'French preference', text: 'Professional French communication skills are preferred.', languages: ['fr'], kind: 'preferred', match: 'all' },
  { name: 'explicit AND', text: 'You must be fluent in English and Korean.', languages: ['en', 'ko'], kind: 'required', match: 'all' },
  { name: 'explicit OR', text: 'Fluency in either English or Korean is required.', languages: ['en', 'ko'], kind: 'required', match: 'any' },
  { name: 'three-language OR', text: 'You must be fluent in English, Korean or Japanese.', languages: ['en', 'ko', 'ja'], kind: 'required', match: 'any' },
  { name: 'mixed AND and OR remains unresolved', text: 'You must be fluent in English and Korean or Japanese.', languages: ['en', 'ko', 'ja'], kind: 'required', match: 'unspecified' },
  { name: 'comma-only relation remains unresolved', text: 'Fluency in English, Korean, Japanese is required.', languages: ['en', 'ko', 'ja'], kind: 'required', match: 'unspecified' },
  { name: 'level alternatives are not language alternatives', text: 'Native or fluent German is required.', languages: ['de'], kind: 'required', match: 'all' },
  { name: 'native speaker plus another fluent language', text: 'A native German speaker with fluent English is required.', languages: ['de', 'en'], kind: 'required', match: 'all' },
  { name: 'on-top-of language is additive', text: 'Fluency in English is required on top of fluency in Thai.', languages: ['en', 'th'], kind: 'required', match: 'all' },
  { name: 'Korean AND qualification', text: '필수 요건\n한국어와 영어로 원활하게 의사소통할 수 있어야 합니다.', languages: ['ko', 'en'], kind: 'required', match: 'all' },
  { name: 'Korean conversation requirement', text: '영어 회화 능력 필수', languages: ['en'], kind: 'required', match: 'all' },
  { name: 'Korean Japanese preference', text: '일본어 구사 능력 우대', languages: ['ja'], kind: 'preferred', match: 'all' },
  { name: 'need-to-have heading stays a qualification', text: 'You need to have\nStrong English proficiency.', languages: ['en'], kind: 'qualification', match: 'all' },
  { name: 'must-have heading', text: 'The Must-Haves\nFluency in Spanish.', languages: ['es'], kind: 'required', match: 'all' },
  { name: 'nice-to-have heading', text: 'The Nice-to-Haves\nFluency in Portuguese.', languages: ['pt'], kind: 'preferred', match: 'all' },
  { name: 'added-value heading', text: 'Added Value\nNative-level English fluency.', languages: ['en'], kind: 'preferred', match: 'all' },
  { name: 'generic Chinese is not assumed Mandarin', text: 'Chinese fluency is required.', languages: ['zh'], kind: 'required', match: 'all' },
  { name: 'Mandarin Chinese is one concrete name', text: 'Mandarin Chinese fluency is required.', languages: ['cmn'], kind: 'required', match: 'all' },
  { name: 'parenthesized Mandarin is not duplicated as Chinese', text: 'Chinese (Mandarin) fluency is required.', languages: ['cmn'], kind: 'required', match: 'all' },
  { name: 'Cantonese Chinese is one concrete name', text: 'Cantonese Chinese fluency is required.', languages: ['yue'], kind: 'required', match: 'all' },
  { name: 'Mandarin/Cantonese remain distinct alternatives', text: 'Fluency in Mandarin or Cantonese is required.', languages: ['cmn', 'yue'], kind: 'required', match: 'any' },
  { name: 'qualification heading retains a title-count suffix', text: 'Basic Qualifications (3 Titles)\nFluency in English.', languages: ['en'], kind: 'required', match: 'all' },
  { name: 'desirable-skills heading is preferred, not a quoted example', text: 'Examples of desirable skills, knowledge and experience\nFluency in Japanese.', languages: ['ja'], kind: 'preferred', match: 'all' },
  { name: 'long explicit communication condition', text: 'You must communicate complex incident findings and architectural tradeoffs to colleagues across several distributed departments using clear and precise professional English.', languages: ['en'], kind: 'required', match: 'all' },
  { name: 'team nationality is not a second language requirement', text: 'You must be fluent in English to collaborate with the Korean team.', languages: ['en'], kind: 'required', match: 'all' },
  { name: 'customer nationality is not a second language requirement', text: 'Fluency in English is required to support French customers.', languages: ['en'], kind: 'required', match: 'all' },
]

describe('spoken-language semantics with literal oracles', () => {
  it.each(affirmative)('$name', ({ text, languages, kind, match }) => {
    expect(languageRequirements(text)).toEqual({ version: 1, rules: [literalRule(languages, kind, match, text)] })
  })

  it('keeps required conversational and preferred business levels in the same original paragraph', () => {
    expect(languageRequirements(LANGUAGE_MIXED)).toEqual({
      version: 1, rules: [
        literalRule(['en'], 'required', 'all', LANGUAGE_MIXED),
        literalRule(['en'], 'preferred', 'all', LANGUAGE_MIXED),
      ],
    })
  })
  it('inherits only a level-only preference after accepted single-language evidence', () => {
    const text = 'Conversational English is required; business level is preferred.'
    expect(languageRequirements(text)).toEqual({ version: 1, rules: [
      literalRule(['en'], 'required', 'all', text), literalRule(['en'], 'preferred', 'all', text),
    ] })
  })
  it.each([
    'English proficiency is required; professional experience is preferred.',
    'English proficiency is required; SQL proficiency is preferred.',
  ])('never lends English to an unrelated condition: %s', text => {
    expect(languageRequirements(text)).toEqual({ version: 1, rules: [literalRule(['en'], 'required', 'all', text)] })
  })
  it('does not inherit from an unaccepted working-language statement', () => {
    expect(languageRequirements('Our working language is English; business-level proficiency is preferred.'))
      .toEqual({ version: 1, rules: [] })
  })
  it('does not guess which of multiple languages owns an omitted-level preference', () => {
    const text = 'Fluency in German or French is required; native level is preferred.'
    expect(languageRequirements(text)).toEqual({ version: 1, rules: [literalRule(['de', 'fr'], 'required', 'any', text)] })
  })
  it('a negated English clause does not erase an explicit Japanese preference', () => {
    const text = 'English is not required; Japanese is preferred.'
    expect(languageRequirements(text)).toEqual({ version: 1, rules: [literalRule(['ja'], 'preferred', 'all', text)] })
  })
  it('an unnecessary French clause does not erase required English', () => {
    const text = 'Fluent English is required, but French is not required.'
    expect(languageRequirements(text)).toEqual({ version: 1, rules: [literalRule(['en'], 'required', 'all', text)] })
  })
  it('keeps the original sub-role headings beside separate qualification evidence', () => {
    const text = 'Backend Engineer\nBasic Qualifications (3 Titles)\nFluency in English.\n\nData Engineer\nBasic Qualifications (3 Titles)\nFluency in Korean.'
    const requirements = languageRequirements(text)
    expect(requirements.rules.map(rule => [rule.languages, rule.kind, rule.match])).toEqual([
      [['en'], 'required', 'all'], [['ko'], 'required', 'all'],
    ])
    expect(requirements.rules[0].evidence.text).toContain('Backend Engineer')
    expect(requirements.rules[0].evidence.text).toContain('Basic Qualifications (3 Titles)\nFluency in English.')
    expect(requirements.rules[0].evidence.text).not.toContain('Data Engineer')
    expect(requirements.rules[1].evidence.text).toContain('Data Engineer')
    expect(requirements.rules[1].evidence.text).toContain('Basic Qualifications (3 Titles)\nFluency in Korean.')
    expect(requirements.rules[1].evidence.text).not.toContain('Backend Engineer')
  })

  it('retains the two explicit sub-role scopes in parent-heading source order', () => {
    expect(languageRequirements(LANGUAGE_SCOPED)).toEqual({ version: 1, rules: [
      { ...literalRule(['de'], 'required', 'all', 'Basic Qualifications (2 Titles)\nSenior Software Engineer\nFluency in German.'), scope: 'Senior Software Engineer' },
      { ...literalRule(['de'], 'required', 'all', 'Basic Qualifications (2 Titles)\nSoftware Engineer II\nConversational German proficiency.'), scope: 'Software Engineer II' },
    ] })
  })
  it('does not lend the final sub-role scope to a new top-level qualification section', () => {
    const text = `${LANGUAGE_SCOPED}\n\nPreferred Qualifications\nFluency in French.`
    expect(languageRequirements(text)).toEqual({ version: 1, rules: [
      { ...literalRule(['de'], 'required', 'all', 'Basic Qualifications (2 Titles)\nSenior Software Engineer\nFluency in German.'), scope: 'Senior Software Engineer' },
      { ...literalRule(['de'], 'required', 'all', 'Basic Qualifications (2 Titles)\nSoftware Engineer II\nConversational German proficiency.'), scope: 'Software Engineer II' },
      literalRule(['fr'], 'preferred', 'all', 'Preferred Qualifications\nFluency in French.'),
    ] })
  })
})

describe('rejects non-applicant and negated spoken-language claims', () => {
  it.each([
    'Our working language is English.',
    'English is the working language of our company.',
    'Our existing engineers are fluent in English.',
    'Our product translates English, Korean and Japanese articles.',
    'We build large language models for English and Korean datasets.',
    'Experience with English tokenizers and French NLP corpora is required.',
    'Fluency in Python, JavaScript and SQL is required.',
    'Provide your résumé in English.',
    'English translations of certificates are required.',
    'Our documentation is written in English.',
    'English proficiency is not required.',
    'You do not need fluency in German or French.',
    '영어 구사 능력은 요구하지 않습니다.',
    '영어 회화 능력은 필수가 아닙니다.',
    '"English fluency is required."',
    'The phrase “English fluency is required” is a quoted example for documentation.',
    'For example, English fluency is required.',
    'Training example: English fluency is required.',
    'For another vacancy, fluent French is required. This backend role has no language requirements.',
    'Qualifications\nMinimum three years with TypeScript.\nAbout the company\nFluent English speakers lead our community.',
    'Our company offers free German language lessons.',
    'A bachelor degree in English literature is required.',
    'Please polish the English documentation.',
  ])('%s', text => {
    expect(languageRequirements(text)).toEqual({ version: 1, rules: [] })
  })
})

const providers: JobProvider[] = ['greenhouse', 'ashby', 'lever', 'smartrecruiters']
function normalized(provider: JobProvider, text: string): Job {
  const job = provider === 'greenhouse'
    ? normalizeJob(languageGreenhouseRaw({ content: languageHtml(text) }), 'language-aster', LANGUAGE_FETCHED_AT)
    : provider === 'ashby'
      ? normalizeAshbyJob(languageAshbyRaw({ descriptionPlain: text }), 'language-birch', LANGUAGE_FETCHED_AT)
      : provider === 'lever'
        ? normalizeLeverJob(languageLeverRaw({ descriptionPlain: text }), 'language-cedar', LANGUAGE_FETCHED_AT)
        : normalizeSmartRecruitersJob(languageSmartRecruitersRaw({
          jobAd: { sections: { qualifications: { title: 'Qualifications', text: languageHtml(text) } } },
        }), 'language-dogwood', LANGUAGE_FETCHED_AT)
  expect(job).not.toBeNull()
  return job!
}

describe('full provider normalization interprets original evidence', () => {
  it.each(providers)('%s retains mixed language kinds and verbatim levels', provider => {
    const job = normalized(provider, LANGUAGE_MIXED)
    expect(job.languageRequirements?.rules.map(rule => [rule.languages, rule.kind, rule.match])).toEqual([
      [['en'], 'required', 'all'], [['en'], 'preferred', 'all'],
    ])
    for (const rule of job.languageRequirements!.rules) {
      expect(rule.evidence.source).toBe('description')
      expect(rule.evidence.text).toContain(LANGUAGE_MIXED)
      expect(rule.evidence.text).not.toMatch(/\b(?:A1|A2|B1|B2|C1|C2|CEFR)\b/)
    }
    expect(job.fetchedAt).toBe(LANGUAGE_FETCHED_AT)
    if (provider === 'greenhouse' || provider === 'smartrecruiters') expect(job.updatedAt).toBe(LANGUAGE_UPDATED_AT)
  })
  it.each(providers)('%s keeps language evidence beyond the retained26k description', provider => {
    const phrase = 'Fluency in Korean is required.'
    const body = `${'Engineering notes about reliable systems.\n\n'.repeat(700)}${phrase}`
    const job = normalized(provider, body)
    expect(job.description.length).toBeLessThanOrEqual(26000)
    expect(job.description).not.toContain(phrase)
    expect(job.languageRequirements?.rules.map(rule => [rule.languages, rule.kind, rule.match])).toEqual([
      [['ko'], 'required', 'all'],
    ])
    expect(job.languageRequirements!.rules[0].evidence.text).toContain(phrase)
    expect(job.fetchedAt).toBe(LANGUAGE_FETCHED_AT)
  })
})

describe('bounded evidence and schema validation', () => {
  const valid = literalRule(['en'], 'required', 'all', 'Fluent English is required.')
  it.each([
    ['unknown language', { ...valid, languages: ['xx'] }],
    ['empty language group', { ...valid, languages: [] }],
    ['duplicate language', { ...valid, languages: ['en', 'en'] }],
    ['context is not an applicant criterion', { ...valid, kind: 'context' }],
    ['unknown relation', { ...valid, match: 'either' }],
    ['metadata is not description evidence', { ...valid, evidence: { source: 'board', text: valid.evidence.text } }],
    ['blank evidence', { ...valid, evidence: { source: 'description', text: '  ' } }],
    ['overlong evidence', { ...valid, evidence: { source: 'description', text: 'x'.repeat(3001) } }],
    ['blank scope', { ...valid, scope: '  ' }],
    ['scope missing from original quote', { ...valid, scope: 'Senior Software Engineer' }],
    ['scope longer than200', { ...valid, scope: 'x'.repeat(201), evidence: { source: 'description', text: 'x'.repeat(201) } }],
  ])('rejects %s without discarding a valid neighbour silently', (_name, rule) => {
    const job = { ...legacyLanguageJob(), languageRequirements: { version: 1, rules: [valid, rule] } }
    expect(JobSchema.safeParse(job).success).toBe(false)
    expect(decodeSavedJobs(JSON.stringify([legacyLanguageSaved(), { ...legacyLanguageSaved(), job }]))).toMatchObject({
      omitted: 1, reason: 'records', records: [{ job: { id: 'greenhouse-language-aster-4501' } }],
    })
  })
  it('accepts scoped source evidence and rejects an unknown version or more than50 rules', () => {
    const rule = { ...valid, scope: 'Senior Software Engineer', evidence: { source: 'description', text: 'Senior Software Engineer\nFluent English is required.' } }
    expect(JobSchema.safeParse({ ...legacyLanguageJob(), languageRequirements: { version: 1, rules: [rule] } }).success).toBe(true)
    expect(JobSchema.safeParse({ ...legacyLanguageJob(), languageRequirements: { version: 2, rules: [valid] } }).success).toBe(false)
    expect(JobSchema.safeParse({ ...legacyLanguageJob(), languageRequirements: { version: 1, rules: Array(51).fill(valid) } }).success).toBe(false)
  })
  it('keeps a complete3000-character paragraph but never crops an overlong quote into a requirement', () => {
    const start = 'Fluent English is required. '
    const accepted = start + 'x'.repeat(3000 - start.length)
    expect(languageRequirements(accepted)).toEqual({ version: 1, rules: [literalRule(['en'], 'required', 'all', accepted)] })
    expect(languageRequirements(`${accepted} French is not required.`)).toEqual({ version: 1, rules: [], truncated: true })
  })
  it('marks a body beyond100k partial without claiming an unseen tail language', () => {
    const body = `${'Engineering system notes.\n'.repeat(4000)}Fluency in Korean is required.`
    expect(body.indexOf('Fluency')).toBeGreaterThan(100000)
    expect(languageRequirements(body)).toEqual({ version: 1, rules: [], truncated: true })
  })
  it('keeps the first50 distinct original rules and exposes partial interpretation in the export summary', () => {
    const phrases = Array.from({ length: 51 }, (_, i) => `Fluent English is required for applicant group ${i + 1}.`)
    const result = languageRequirements(phrases.join('\n\n'))
    expect(result).toEqual({ version: 1, rules: phrases.slice(0, 50).map(text => literalRule(['en'], 'required', 'all', text)), truncated: true })
    expect(languageSummary({ ...legacyLanguageJob(), languageRequirements: result })).toContain('일부 언어 조건만 확인 · 전체 원문 확인 필요')
  })
})

describe('old records, exact source evidence and revisions', () => {
  const mixedRules = [
    literalRule(['en'], 'required', 'all', `Minimum requirements\n${LANGUAGE_MIXED}`),
    literalRule(['en'], 'preferred', 'all', `Minimum requirements\n${LANGUAGE_MIXED}`),
  ]
  it('upgrades an old public record once without changing source dates, identity or body', () => {
    const old = legacyLanguageJob()
    const copy = structuredClone(old)
    const current = upgradeJob(old)
    expect(current.languageRequirements).toEqual({ version: 1, rules: mixedRules })
    expect(current).toMatchObject({
      id: 'greenhouse-language-aster-4501', source: 'greenhouse', companyId: 'language-aster',
      url: 'https://example.com/jobs/language-aster-4501', description: old.description,
      fetchedAt: LANGUAGE_FETCHED_AT, updatedAt: LANGUAGE_UPDATED_AT,
    })
    expect(upgradeJob(current)).toBe(current)
    expect(upgradeJobLanguages(current)).toBe(current)
    expect(old).toEqual(copy)
  })
  it.each([4, 5])('migrates cache version%i without renewing time, losing published IDs or changing retry state', version => {
    const old = {
      version, boards: [{
        companyId: 'language-aster', provider: 'greenhouse', board: 'AsterLanguages45',
        checkedAt: LANGUAGE_NOW, failures: 2, retryAt: '2026-09-20T09:15:00.000Z',
        snapshot: { fetchedAt: LANGUAGE_FETCHED_AT, total: 2, unmappedCount: 0,
          publishedIds: ['greenhouse-language-aster-4501', 'greenhouse-language-aster-outside'],
          jobs: [legacyLanguageJob('4501', { stale: true })] },
      }],
    }
    const copy = structuredClone(old)
    const boards = parseCachedBoards(old)
    expect(boards).toHaveLength(1)
    expect(boards[0]).toMatchObject({
      checkedAt: LANGUAGE_NOW, failures: 2, retryAt: '2026-09-20T09:15:00.000Z',
      snapshot: { fetchedAt: LANGUAGE_FETCHED_AT, total: 2, unmappedCount: 0,
        publishedIds: ['greenhouse-language-aster-4501', 'greenhouse-language-aster-outside'],
        jobs: [{ stale: true, fetchedAt: LANGUAGE_FETCHED_AT, updatedAt: LANGUAGE_UPDATED_AT, languageRequirements: { version: 1, rules: mixedRules } }] },
    })
    expect(parseCachedBoards({ version: 5, boards })).toEqual(boards)
    expect(old).toEqual(copy)
  })
  it('keeps notes/status/source facts through old-saved migration and JSON backup import', () => {
    const old = legacyLanguageSaved()
    const copy = structuredClone(old)
    const result = decodeSavedJobs(JSON.stringify([old]))
    expect(result.omitted).toBe(0)
    expect(result.records).toHaveLength(1)
    expect(result.records[0]).toMatchObject({
      note: LANGUAGE_NOTE, status: 'applied', savedAt: LANGUAGE_SAVED_AT, company: old.company,
      job: { fetchedAt: LANGUAGE_FETCHED_AT, updatedAt: LANGUAGE_UPDATED_AT, url: old.job.url, languageRequirements: { version: 1, rules: mixedRules } },
    })
    const backup = createSavedBackup(result.records, 0, new Date(LANGUAGE_NOW))
    expect(JSON.parse(backup)).not.toHaveProperty('profile')
    const imported = parseSavedImport(backup)
    expect(imported).toMatchObject({ format: 'backup', invalid: 0, duplicates: 0, unreadableSources: 0, exportedAt: LANGUAGE_NOW })
    expect(imported.groups[0].variants).toEqual(result.records)
    expect(old).toEqual(copy)
  })
  it('retains valid full-body evidence after truncation and never invents it for an older truncated record', () => {
    const quote = 'Senior Software Engineer\nFluency in Korean is required.'
    const job = legacyLanguageJob('4501', {
      description: 'Engineering notes.\n'.repeat(1400).slice(0, 26000),
      languageRequirements: { version: 1, rules: [{ ...literalRule(['ko'], 'required', 'all', quote), scope: 'Senior Software Engineer' }] },
    })
    const saved = SavedJobSchema.parse(legacyLanguageSaved(job))
    expect(saved.job.languageRequirements).toEqual(job.languageRequirements)
    expect(saved.job.description).not.toContain(quote)
    expect(parseSavedImport(createSavedBackup([saved])).groups[0].variants[0]).toEqual(saved)
    const old = { ...job, languageRequirements: undefined }
    expect(upgradeJobLanguages(old).languageRequirements).toEqual({ version: 1, rules: [] })
  })
  it('does not produce a fake language revision during migration or repeated upgrades', async () => {
    const old = legacyLanguageJob()
    const current = upgradeJob(old)
    expect(await createJobRevision(old)).toEqual(await createJobRevision(current))
    expect(await createJobRevision(current)).toEqual(await createJobRevision(upgradeJob(current)))
    expect(current.languageRequirements).toEqual({ version: 1, rules: mixedRules })
  })
  it('reports an actual language change in qualifications while preserving identity and all other revision fields', async () => {
    const old = upgradeJob(legacyLanguageJob())
    const updated = { ...old, languageRequirements: {
      version: 1 as const, rules: [
        literalRule(['de'], 'required', 'all', LANGUAGE_CHANGED),
        literalRule(['de'], 'preferred', 'all', LANGUAGE_CHANGED),
      ],
    } }
    const before = await createJobRevision(old)
    const after = await createJobRevision(updated)
    expect(Object.keys(before).filter(key => before[key as keyof typeof before] !== after[key as keyof typeof after])).toEqual(['qualifications'])
    expect(updated.id).toBe('greenhouse-language-aster-4501')
    expect(old.languageRequirements).toEqual({ version: 1, rules: mixedRules })
  })
  it('exports two separate role scopes rather than indistinguishable language rows', () => {
    const job = normalized('greenhouse', LANGUAGE_SCOPED)
    expect(languageSummary(job)).toBe('필수로 명시: 독일어 · 적용 항목: Senior Software Engineer\n필수로 명시: 독일어 · 적용 항목: Software Engineer II')
  })
  it('leaves the32-company179-job22-city sample unchanged and without public language facts', () => {
    const sample = createSampleCatalog()
    const copy = structuredClone(sample)
    expect(sample.companies).toHaveLength(32)
    expect(sample.jobs).toHaveLength(179)
    expect(sample.cities).toHaveLength(22)
    expect(upgradeCatalog(sample)).toEqual(copy)
    expect(sample.jobs.every(job => upgradeJobLanguages(job) === job && job.languageRequirements === undefined)).toBe(true)
  })
})

describe('literal search, eligibility and technical-score outcomes', () => {
  it.each([
    ['영어', ['greenhouse-language-aster-4501', 'ashby-language-birch-4504', 'lever-language-cedar-4505']],
    ['English', ['greenhouse-language-aster-4501', 'ashby-language-birch-4504', 'lever-language-cedar-4505']],
    ['한국어', ['ashby-language-birch-4504']],
    ['일본어', ['ashby-language-birch-4504']],
    ['프랑스어', ['smartrecruiters-language-dogwood-4506']],
    ['독일어', []],
    ['영어 한국어', ['ashby-language-birch-4504']],
    ['한국어   영어', ['ashby-language-birch-4504']],
  ])('finds only verified aliases for %s, with every query word required', (query, ids) => {
    const catalog = legacyLanguageCatalog()
    const copy = structuredClone(catalog)
    expect(selectSearchJobs(createSearchIndex(catalog, LANGUAGE_PROFILE), { ...LANGUAGE_FILTERS, query }).map(entry => entry.job.id)).toEqual(ids)
    expect(catalog).toEqual(copy)
  })
  it('counts mapped, remote and unconfirmed-location results without promoting the language-qualified pool', () => {
    const index = createSearchIndex(legacyLanguageCatalog(), LANGUAGE_PROFILE)
    const english = selectSearchJobs(index, { ...LANGUAGE_FILTERS, query: '영어' })
    expect(countSearchJobs(english, { kind: 'city', cityId: 'berlin' }, 'all')).toEqual({ jobs: 2, companies: 2, cities: 1 })
    expect(countSearchJobs(english, { kind: 'remote' }, 'all')).toEqual({ jobs: 1, companies: 1, cities: 0 })
    const french = selectSearchJobs(index, { ...LANGUAGE_FILTERS, query: '프랑스어' })
    expect(french.filter(entry => inSearchScope(entry, { kind: 'unmapped' })).map(entry => entry.job.id)).toEqual(['smartrecruiters-language-dogwood-4506'])
    const pool = selectSearchJobs(index, { ...LANGUAGE_FILTERS, postingType: 'talent-pool', query: '한국어' })
    expect(pool.map(entry => entry.job.id)).toEqual(['greenhouse-language-aster-4503'])
    expect(countSearchJobs(pool, { kind: 'cities' }, 'all')).toEqual({ jobs: 1, companies: 1, cities: 1 })
  })
  it('does not infer applicant fluency or change the90-point technical match from a name or residence', () => {
    const job = legacyLanguageJob()
    for (const profile of [
      LANGUAGE_PROFILE,
      { ...LANGUAGE_PROFILE, name: 'English Native Speaker', residence: 'GB', headline: '영어 이력서' },
    ]) {
      const match = matchJob(job, profile)
      expect(match).toMatchObject({ score: 90, matchedSkills: ['TypeScript'], missingSkills: [] })
      expect(match.cautions).toContain('공고의 언어 조건 확인 필요: 영어. 요구 수준과 선택 조건은 원문 근거를 확인해 주세요.')
      expect(match.reasons.join(' ')).not.toMatch(/영어|English|언어 충족|language/i)
    }
    const preferred = matchJob(legacyLanguageJob('4501', { description: 'Minimum requirements\n3 years of software engineering experience with TypeScript.\nPreferred qualifications\nProfessional French communication skills are preferred.' }), LANGUAGE_PROFILE)
    expect(preferred).toMatchObject({ score: 90, matchedSkills: ['TypeScript'], missingSkills: [] })
    expect(preferred.cautions.join(' ')).not.toContain('언어 조건')
  })
})
