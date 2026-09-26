import { describe, expect, it } from 'vitest'
import { parseCachedBoards } from '../../server/board-cache'
import { normalizeJob } from '../../server/normalize'
import { normalizeAshbyJob } from '../../server/providers/ashby'
import { normalizeLeverJob } from '../../server/providers/lever'
import { normalizeSmartRecruitersJob } from '../../server/providers/smartrecruiters'
import { upgradeJobWorkTime, workTimeCaution, workTimeRequirements, workTimeSearchText, workTimeSummary } from '../../shared/job-work-time'
import { countSearchJobs, createSearchIndex, inSearchScope, selectSearchJobs } from '../../shared/job-search'
import { upgradeCatalog, upgradeJob } from '../../shared/job-upgrade'
import { matchJob } from '../../shared/matching'
import { createJobRevision } from '../../shared/posting-status'
import { createSampleCatalog } from '../../shared/sample'
import { createSavedBackup, parseSavedImport } from '../../shared/saved-backup'
import { decodeSavedJobs, SavedJobSchema } from '../../shared/saved-jobs'
import { JobSchema } from '../../shared/schemas'
import type { Job, JobProvider } from '../../shared/types'
import {
  WORK_TIME_AMBIGUOUS, WORK_TIME_CORE, WORK_TIME_FETCHED_AT, WORK_TIME_FILTERS,
  WORK_TIME_MIXED, WORK_TIME_NOTE, WORK_TIME_NOW, WORK_TIME_OVERLAP, WORK_TIME_PROFILE,
  WORK_TIME_SAVED_AT, WORK_TIME_SCOPED, WORK_TIME_UPDATED_AT,
  legacyCollectedWorkTimeSaved, legacyWorkTimeCatalog, legacyWorkTimeJob, legacyWorkTimeSaved,
  workTimeAshbyRaw, workTimeGreenhouseRaw, workTimeHtml, workTimeLeverRaw, workTimeSmartRecruitersRaw,
} from '../fixtures/job-work-time'

type Rule = NonNullable<Job['workTimeRequirements']>['rules'][number]
const literalRule = (kind: Rule['kind'], level: Rule['level'], statement: string, text = statement, scope?: string): Rule => ({
  kind, level, statement, ...(scope ? { scope } : {}), evidence: { source: 'description', text },
})
const affirmative: { name: string; text: string; kind: Rule['kind']; level: Rule['level'] }[] = [
  { name: 'explicit applicant timezone geography', text: 'Candidates must be based in the Eastern or Central time zones.', kind: 'location', level: 'required' },
  { name: 'direction is part of the geography', text: 'You must be based in the Eastern time zone or further east.', kind: 'location', level: 'required' },
  { name: 'fixed offset range without country inference', text: 'Applicants must be located in time zones from UTC-05:00 to UTC-02:00.', kind: 'location', level: 'required' },
  { name: 'preferred timezone residence', text: 'Candidates based in the Pacific time zone are preferred.', kind: 'location', level: 'preferred' },
  { name: 'team operating time is stated collaboration', text: 'This team works on Central European Time.', kind: 'collaboration', level: 'stated' },
  { name: 'spelled timezone stays original', text: 'Our engineering team operates on Japan Standard Time.', kind: 'collaboration', level: 'stated' },
  { name: 'IST collaboration does not guess India or Ireland', text: 'Our team operates on IST.', kind: 'collaboration', level: 'stated' },
  { name: 'core UTC wall times', text: 'Our core hours are 10:00–14:00 UTC.', kind: 'core-hours', level: 'stated' },
  { name: 'core positive offset stays unchanged', text: 'Our core hours are 09:00–13:00 UTC+02:00.', kind: 'core-hours', level: 'stated' },
  { name: 'quarter-hour offset is not rounded', text: 'Core hours are 10:15–14:45 UTC+05:45.', kind: 'core-hours', level: 'stated' },
  { name: 'CST core hours remain ambiguous', text: 'Core hours are 13:00–16:00 CST.', kind: 'core-hours', level: 'stated' },
  { name: 'ordinary main hours are not renamed core hours', text: 'Our main working hours are 9 to 5 Pacific Time.', kind: 'working-hours', level: 'stated' },
  { name: 'explicit seasonal offset qualification is retained', text: 'Core hours are 10:00–14:00 local time (UTC+1 in winter and UTC+2 in summer).', kind: 'core-hours', level: 'stated' },
  { name: 'weekly exception is not cut away', text: 'Core hours are 10:00–14:00 UTC from Monday to Thursday, with Friday optional.', kind: 'core-hours', level: 'stated' },
  { name: 'required overlap minimum', text: 'You must have at least 3 hours of overlap with Pacific Time.', kind: 'overlap', level: 'required' },
  { name: 'preferred overlap retains written number', text: 'Four hours of overlap with Central European Time is preferred.', kind: 'overlap', level: 'preferred' },
  { name: 'unquantified overlap never invents hours', text: 'Strong working overlap with Americas time zones is required.', kind: 'overlap', level: 'required' },
  { name: 'event restriction remains inside the statement', text: 'You must overlap with Pacific Time only during scheduled releases.', kind: 'overlap', level: 'required' },
  { name: 'skill preference does not soften required overlap', text: 'You must overlap working hours with Pacific Time, with Rust proficiency preferred.', kind: 'overlap', level: 'required' },
  { name: 'Korean applicant geography', text: '지원자는 한국 표준시 시간대에 거주해야 합니다.', kind: 'location', level: 'required' },
  { name: 'Korean team collaboration', text: '우리 팀은 한국 표준시를 기준으로 협업합니다.', kind: 'collaboration', level: 'stated' },
  { name: 'Korean core hours', text: '코어 근무시간은 UTC 기준 10:00–14:00입니다.', kind: 'core-hours', level: 'stated' },
  { name: 'Korean required overlap', text: '태평양 시간대와 최소 3시간의 근무시간 중첩이 필요합니다.', kind: 'overlap', level: 'required' },
  { name: 'Korean overlap preference', text: '중앙 유럽 시간대와 4시간의 근무시간 중첩이 가능하면 우대합니다.', kind: 'overlap', level: 'preferred' },
]

describe('work-time declarations with independent literal statements', () => {
  it.each(affirmative)('$name', ({ text, kind, level }) => {
    expect(workTimeRequirements(text)).toEqual({ version: 1, rules: [literalRule(kind, level, text)] })
  })
  it('retains both original UTC core-hours and required Pacific overlap as distinct facts', () => {
    expect(workTimeRequirements(WORK_TIME_MIXED)).toEqual({ version: 1, rules: [
      literalRule('core-hours', 'stated', WORK_TIME_CORE, `Working hours\n${WORK_TIME_CORE}`),
      literalRule('overlap', 'required', WORK_TIME_OVERLAP, `Collaboration\n${WORK_TIME_OVERLAP}`),
    ] })
  })
  it('does not borrow a neighbouring country preference for the team timezone', () => {
    const text = 'Our team operates on Pacific Time. Candidates in Canada are preferred.'
    expect(workTimeRequirements(text)).toEqual({ version: 1, rules: [
      literalRule('collaboration', 'stated', 'Our team operates on Pacific Time.', text),
    ] })
  })
  it('required and nice-to-have headings give separate original levels', () => {
    const first = 'At least 2 hours of working overlap with UTC is needed.'
    const second = 'Core hours from 11:00 to 14:00 GMT.'
    expect(workTimeRequirements(`The Must-Haves\n${first}\n\nThe Nice-to-Haves\n${second}`)).toEqual({ version: 1, rules: [
      literalRule('overlap', 'required', first, `The Must-Haves\n${first}`),
      literalRule('core-hours', 'preferred', second, `The Nice-to-Haves\n${second}`),
    ] })
  })
  it('keeps both explicit sub-role scopes and the parent heading in original source order', () => {
    expect(workTimeRequirements(WORK_TIME_SCOPED)).toEqual({ version: 1, rules: [
      literalRule('core-hours', 'required', 'Core hours are 09:00–12:00 GMT.', 'Basic Qualifications (2 Titles)\nSenior Software Engineer\nCore hours are 09:00–12:00 GMT.', 'Senior Software Engineer'),
      literalRule('core-hours', 'required', 'Core hours are 14:00–17:00 GMT.', 'Basic Qualifications (2 Titles)\nSoftware Engineer II\nCore hours are 14:00–17:00 GMT.', 'Software Engineer II'),
    ] })
  })
  it('role headings before qualifications remain scoped rather than becoming global', () => {
    const text = 'Senior Software Engineer\nBasic Qualifications\nCore hours are 09:00–12:00 GMT.'
    expect(workTimeRequirements(text)).toEqual({ version: 1, rules: [
      literalRule('core-hours', 'required', 'Core hours are 09:00–12:00 GMT.', text, 'Senior Software Engineer'),
    ] })
  })
  it('a new top-level heading clears the preceding nested role scope', () => {
    const final = 'Overlap with Pacific Time is preferred.'
    const result = workTimeRequirements(`${WORK_TIME_SCOPED}\n\nPreferred Qualifications\n${final}`)
    expect(result.rules).toHaveLength(3)
    expect(result.rules.map(rule => rule.scope ?? null)).toEqual(['Senior Software Engineer', 'Software Engineer II', null])
    expect(result.rules[2]).toEqual(literalRule('overlap', 'preferred', final, `Preferred Qualifications\n${final}`))
  })
  it('unrelated subsequent section cannot inherit a timezone from a previous accepted fact', () => {
    const text = 'Our team operates on Pacific Time.\n\nBenefits\nFlexible working hours and generous vacation.'
    expect(workTimeRequirements(text)).toEqual({ version: 1, rules: [literalRule('collaboration', 'stated', 'Our team operates on Pacific Time.')] })
  })
  it.each([
    ['inline core-hours heading', 'Core working hours: 09:00–12:00 UTC.', 'core-hours', '09:00–12:00 UTC.'],
    ['separate core-hours heading', 'Core working hours\n09:00–12:00 UTC.', 'core-hours', '09:00–12:00 UTC.'],
    ['separate ordinary working-hours heading', 'Working hours\n09:00–17:00 UTC.', 'working-hours', '09:00–17:00 UTC.'],
  ] as const)('%s carries the kind but never invents words in the statement', (_name, text, kind, statement) => {
    expect(workTimeRequirements(text)).toEqual({ version: 1, rules: [literalRule(kind, 'stated', statement, text)] })
  })
  it('an unknown reference heading does not turn a bare clock range into working hours', () => {
    expect(workTimeRequirements('Unrelated reference:\n09:00–17:00 UTC.')).toEqual({ version: 1, rules: [] })
  })
  it('a later unrelated heading clears time-specific context before another clock range', () => {
    const text = 'Core working hours\n09:00–12:00 UTC.\n\nDatabase documentation:\n10:00–11:00 GMT.'
    expect(workTimeRequirements(text)).toEqual({ version: 1, rules: [
      literalRule('core-hours', 'stated', '09:00–12:00 UTC.', 'Core working hours\n09:00–12:00 UTC.'),
    ] })
  })
  it.each([
    'Core hours are 09:00–12:00 UTC, but attendance is not required.',
    'Core hours are 09:00–12:00 UTC; attendance is optional.',
  ])('keeps a following attendance negation attached to its core-hours claim: %s', text => {
    expect(workTimeRequirements(text)).toEqual({ version: 1, rules: [] })
  })
  it('retains a release-only continuation in the exact required overlap statement', () => {
    const text = 'You must overlap with Pacific Time, but only during scheduled releases.'
    expect(workTimeRequirements(text)).toEqual({ version: 1, rules: [literalRule('overlap', 'required', text)] })
  })
  it('still separates two independent time declarations with their own levels', () => {
    const text = 'Core hours are 09:00–12:00 UTC; overlap with Pacific Time is preferred.'
    expect(workTimeRequirements(text)).toEqual({ version: 1, rules: [
      literalRule('core-hours', 'stated', 'Core hours are 09:00–12:00 UTC', text),
      literalRule('overlap', 'preferred', 'overlap with Pacific Time is preferred.', text),
    ] })
  })
})

describe('no work-time requirements invented from background or negation', () => {
  it.each([
    'Our team is distributed across many time zones.',
    'We are a remote-first and asynchronous company.',
    'Our teammates live in the Pacific and Eastern time zones.',
    'This role is based in Arbor City, and applicants can work from another timezone.',
    'This role is based in the NAMER region; we can support a different timezone.',
    'Our engineering team is distributed across AMER time zones.',
    'Experience working across time zones is preferred.',
    'You previously worked with a team in Pacific Time.',
    'Our product displays UTC clocks and converts PST timestamps.',
    'The database stores all events in UTC.',
    'Training example: Core hours are 10:00–14:00 UTC.',
    'The phrase “Core hours are 10:00–14:00 UTC” is an example for the product documentation.',
    '"You must be based in the Eastern time zone."',
    'Applications close at 17:00 GMT on Friday.',
    'Interviews are scheduled at 09:00 PST.',
    'The interview exercise asks you to convert CST to UTC.',
    'For another vacancy, candidates must be based in the Eastern time zone.',
    'For our separate Finance Manager opening, core hours are 09:00–12:00 GMT.',
    'Overlap with Pacific Time is not required.',
    'You do not need to live in the Eastern time zone.',
    'We do not require core hours from 09:00 to 12:00 GMT.',
    'No fixed core hours are required.',
    '태평양 시간대와 근무시간 중첩은 요구하지 않습니다.',
    '한국 표준시 시간대에 거주할 필요는 없습니다.',
    '지원 마감은 한국 표준시 18:00입니다.',
    '면접은 UTC 기준 10:00에 진행합니다.',
    'Notre équipe est distribuée dans plusieurs pays.',
    'You will collaborate with PST (Product Strategy Team) to improve our internal tools.',
  ])('%s', text => {
    expect(workTimeRequirements(text)).toEqual({ version: 1, rules: [] })
  })
})

const providers: JobProvider[] = ['greenhouse', 'ashby', 'lever', 'smartrecruiters']
function normalized(provider: JobProvider, text: string): Job {
  const job = provider === 'greenhouse'
    ? normalizeJob(workTimeGreenhouseRaw({ content: workTimeHtml(text) }), 'time-dawn', WORK_TIME_FETCHED_AT)
    : provider === 'ashby'
      ? normalizeAshbyJob(workTimeAshbyRaw({ descriptionPlain: text }), 'time-juniper', WORK_TIME_FETCHED_AT)
      : provider === 'lever'
        ? normalizeLeverJob(workTimeLeverRaw({ descriptionPlain: text }), 'time-maple', WORK_TIME_FETCHED_AT)
        : normalizeSmartRecruitersJob(workTimeSmartRecruitersRaw({
          jobAd: { sections: { jobDescription: { title: 'Working hours', text: workTimeHtml(text) } } },
        }), 'time-willow', WORK_TIME_FETCHED_AT)
  expect(job).not.toBeNull()
  return job!
}

describe('actual provider pipelines retain full original work-time evidence', () => {
  it.each(providers)('%s keeps the four kinds, levels and written times without modifying source geography', provider => {
    const statements = [
      'Candidates must be based in the Eastern time zone.',
      'Our team operates on IST.',
      'Core hours are 13:00–16:00 CST.',
      'Overlap with Pacific Time is preferred.',
    ]
    const job = normalized(provider, statements.join('\n\n'))
    expect(job.workTimeRequirements?.rules.map(rule => [rule.kind, rule.level, rule.statement])).toEqual([
      ['location', 'required', statements[0]], ['collaboration', 'stated', statements[1]],
      ['core-hours', 'stated', statements[2]], ['overlap', 'preferred', statements[3]],
    ])
    for (const rule of job.workTimeRequirements!.rules) {
      expect(rule.evidence.source).toBe('description')
      expect(rule.evidence.text).toContain(rule.statement)
      expect(Object.keys(rule).sort()).toEqual(['evidence', 'kind', 'level', 'statement'])
    }
    expect(job.fetchedAt).toBe(WORK_TIME_FETCHED_AT)
    if (provider === 'greenhouse' || provider === 'smartrecruiters') expect(job.updatedAt).toBe(WORK_TIME_UPDATED_AT)
    expect(job.workMode).toBe(provider === 'lever' ? 'remote' : 'onsite')
    expect(job.remoteCountries).toEqual([])
    expect(job.remoteWorldwide).toBe(provider === 'lever')
  })
  it.each(providers)('%s interprets a timezone fact beyond the retained26k body', provider => {
    const statement = 'Applicants must have at least 3 hours of working overlap with GMT.'
    const text = `${'Engineering notes about reliable systems.\n\n'.repeat(700)}${statement}`
    const job = normalized(provider, text)
    expect(job.description.length).toBeLessThanOrEqual(26000)
    expect(job.description).not.toContain(statement)
    expect(job.workTimeRequirements?.rules.map(rule => [rule.kind, rule.level, rule.statement])).toEqual([
      ['overlap', 'required', statement],
    ])
    expect(job.workTimeRequirements!.rules[0].evidence.text).toContain(statement)
    expect(job.fetchedAt).toBe(WORK_TIME_FETCHED_AT)
  })
})

describe('schema and bounded original evidence', () => {
  const valid = literalRule('core-hours', 'stated', WORK_TIME_AMBIGUOUS)
  it.each([
    ['unknown kind', { ...valid, kind: 'eligibility' }],
    ['unknown level', { ...valid, level: 'inferred' }],
    ['empty statement', { ...valid, statement: '  ' }],
    ['statement absent from quote', { ...valid, statement: 'Core hours are 10:00–14:00 UTC.' }],
    ['statement exceeds1000', { ...valid, statement: 'x'.repeat(1001), evidence: { source: 'description', text: 'x'.repeat(1001) } }],
    ['board evidence is not a body quotation', { ...valid, evidence: { source: 'board', text: valid.statement } }],
    ['blank evidence', { ...valid, evidence: { source: 'description', text: ' ' } }],
    ['quote exceeds3000', { ...valid, evidence: { source: 'description', text: valid.statement + 'x'.repeat(3001) } }],
    ['blank scope', { ...valid, scope: '  ' }],
    ['scope absent from quote', { ...valid, scope: 'Senior Software Engineer' }],
    ['scope exceeds200', { ...valid, scope: 'x'.repeat(201), evidence: { source: 'description', text: `${'x'.repeat(201)}\n${valid.statement}` } }],
  ])('rejects %s while preserving a valid neighbouring saved record', (_name, rule) => {
    const job = { ...legacyWorkTimeJob(), workTimeRequirements: { version: 1, rules: [valid, rule] } }
    expect(JobSchema.safeParse(job).success).toBe(false)
    expect(decodeSavedJobs(JSON.stringify([legacyWorkTimeSaved(), { ...legacyWorkTimeSaved(), job }]))).toMatchObject({
      omitted: 1, reason: 'records', records: [{ job: { id: 'greenhouse-time-dawn-4601' } }],
    })
  })
  it('accepts exact scoped evidence but rejects unknown versions and more than50 rules', () => {
    const rule = literalRule('core-hours', 'stated', WORK_TIME_AMBIGUOUS, `Senior Software Engineer\n${WORK_TIME_AMBIGUOUS}`, 'Senior Software Engineer')
    expect(JobSchema.safeParse({ ...legacyWorkTimeJob(), workTimeRequirements: { version: 1, rules: [rule] } }).success).toBe(true)
    expect(JobSchema.safeParse({ ...legacyWorkTimeJob(), workTimeRequirements: { version: 2, rules: [valid] } }).success).toBe(false)
    expect(JobSchema.safeParse({ ...legacyWorkTimeJob(), workTimeRequirements: { version: 1, rules: Array(51).fill(valid) } }).success).toBe(false)
  })
  it('never crops a too-long condition into a different shorter requirement', () => {
    const long = `Core hours are 10:00–14:00 UTC for ${'the designated maintenance group '.repeat(36)}only on scheduled release days.`
    expect(long.length).toBeGreaterThan(1000)
    expect(workTimeRequirements(long)).toEqual({ version: 1, rules: [], truncated: true })
  })
  it('does not assert the unseen tail of an input beyond100k', () => {
    const text = `${'Engineering system notes.\n'.repeat(4200)}${WORK_TIME_CORE}`
    expect(text.indexOf(WORK_TIME_CORE)).toBeGreaterThan(100000)
    expect(workTimeRequirements(text)).toEqual({ version: 1, rules: [], truncated: true })
  })
  it('an input cut in the middle of a declaration cannot erase its final negation', () => {
    const prefix = 'Engineering notes.\n'.repeat(5400).slice(0, 99955)
    const text = `${prefix}\n\nWorking overlap with Pacific Time during release days is not required.`
    expect(text.length).toBeGreaterThan(100000)
    expect(workTimeRequirements(text)).toEqual({ version: 1, rules: [], truncated: true })
  })
  it('retains only50 complete distinct rules and marks the omitted remainder', () => {
    const phrases = Array.from({ length: 51 }, (_, index) => `Core hours are 10:00–14:00 UTC for engineering group ${index + 1}.`)
    const result = workTimeRequirements(phrases.join('\n\n'))
    expect(result).toEqual({ version: 1, rules: phrases.slice(0, 50).map(statement => literalRule('core-hours', 'stated', statement)), truncated: true })
  })
})

const originalRules = [
  literalRule('core-hours', 'stated', WORK_TIME_CORE, `Working hours\n${WORK_TIME_CORE}`),
  literalRule('overlap', 'required', WORK_TIME_OVERLAP, `Collaboration\n${WORK_TIME_OVERLAP}`),
]
describe('old records, source-preserving migration and meaningful revisions', () => {
  it('adds only new time facts to the literal old source and is idempotent', () => {
    const old = legacyCollectedWorkTimeSaved().job
    const copy = structuredClone(old)
    const current = upgradeJobWorkTime(old)
    expect(current).toEqual({ ...copy, workTimeRequirements: { version: 1, rules: originalRules } })
    expect(upgradeJobWorkTime(current)).toBe(current)
    expect(upgradeJob(upgradeJob(current))).toEqual(upgradeJob(current))
    expect(old).toEqual(copy)
  })
  it.each([4, 5])('cache%i migration retains snapshot dates, IDs, retry state and raw source', version => {
    const job = legacyCollectedWorkTimeSaved().job
    expect(job.occupation?.version).toBe(3)
    const old = { version, boards: [{
      companyId: 'time-dawn', provider: 'greenhouse', board: 'DawnWorkTime46',
      checkedAt: WORK_TIME_NOW, failures: 2, retryAt: '2026-09-20T10:45:00.000Z',
      snapshot: { fetchedAt: WORK_TIME_FETCHED_AT, total: 2, unmappedCount: 0,
        publishedIds: ['greenhouse-time-dawn-4601', 'greenhouse-time-dawn-nontechnical'],
        jobs: [{ ...job, stale: true }] },
    }] }
    const copy = structuredClone(old)
    const boards = parseCachedBoards(old)
    expect(boards).toHaveLength(1)
    expect(boards[0]).toMatchObject({
      companyId: 'time-dawn', provider: 'greenhouse', board: 'DawnWorkTime46',
      checkedAt: WORK_TIME_NOW, failures: 2, retryAt: '2026-09-20T10:45:00.000Z',
      snapshot: { fetchedAt: WORK_TIME_FETCHED_AT, total: 2, unmappedCount: 0,
        publishedIds: ['greenhouse-time-dawn-4601', 'greenhouse-time-dawn-nontechnical'],
        jobs: [{
          ...job, stale: true, occupation: { ...job.occupation, version: 5 },
          workTimeRequirements: { version: 1, rules: originalRules },
        }] },
    })
    expect(parseCachedBoards({ version: 5, boards })).toEqual(boards)
    expect(old).toEqual(copy)
  })
  it('old saved JSON gains facts without changing note, status, source, body or timestamps', () => {
    const old = legacyCollectedWorkTimeSaved()
    expect(old.job.occupation?.version).toBe(3)
    const copy = structuredClone(old)
    const result = decodeSavedJobs(JSON.stringify([old]))
    expect(result.omitted).toBe(0)
    expect(result.records).toHaveLength(1)
    expect(result.records[0]).toMatchObject({ ...old, job: {
      ...old.job, occupation: { ...old.job.occupation, version: 5 },
      workTimeRequirements: { version: 1, rules: originalRules },
    } })
    const backup = createSavedBackup(result.records, 0, new Date(WORK_TIME_NOW))
    expect(JSON.parse(backup)).not.toHaveProperty('profile')
    const imported = parseSavedImport(backup)
    expect(imported).toMatchObject({ format: 'backup', invalid: 0, duplicates: 0, unreadableSources: 0, exportedAt: WORK_TIME_NOW })
    expect(imported.groups[0].variants).toEqual(result.records)
    expect(result.records[0]).toMatchObject({ note: WORK_TIME_NOTE, status: 'applied', savedAt: WORK_TIME_SAVED_AT })
    expect(old).toEqual(copy)
  })
  it('current valid evidence beyond the short body survives saved/JSON handling; old absent facts are not invented', () => {
    const statement = 'Core hours are 10:00–14:00 UTC.'
    const rule = literalRule('core-hours', 'required', statement, `Senior Software Engineer\n${statement}`, 'Senior Software Engineer')
    const job = legacyWorkTimeJob('4601', {
      description: 'Engineering notes.\n'.repeat(1500).slice(0, 26000),
      workTimeRequirements: { version: 1, rules: [rule], truncated: true },
    })
    const saved = SavedJobSchema.parse(legacyWorkTimeSaved(job))
    expect(saved.job.workTimeRequirements).toEqual(job.workTimeRequirements)
    expect(saved.job.description).not.toContain(statement)
    expect(parseSavedImport(createSavedBackup([saved])).groups[0].variants[0]).toEqual(saved)
    expect(upgradeJobWorkTime({ ...job, workTimeRequirements: undefined }).workTimeRequirements).toEqual({ version: 1, rules: [] })
  })
  it('empty read migration and populated read migration create no fake revision', async () => {
    for (const old of [legacyCollectedWorkTimeSaved().job, legacyWorkTimeJob('4601', { description: 'Maintain backend APIs.' })]) {
      const current = upgradeJob(old)
      expect(await createJobRevision(old)).toEqual(await createJobRevision(current))
      expect(await createJobRevision(current)).toEqual(await createJobRevision(upgradeJob(current)))
    }
  })
  it('a real work-time change affects only conditions when all other retained source fields stay identical', async () => {
    const old = upgradeJob(legacyCollectedWorkTimeSaved().job)
    const updated = { ...old, workTimeRequirements: { version: 1 as const, rules: [
      literalRule('core-hours', 'stated', 'Core hours are 09:00–12:00 GMT.'),
    ] } }
    const before = await createJobRevision(old)
    const after = await createJobRevision(updated)
    expect(Object.keys(before).filter(key => before[key as keyof typeof before] !== after[key as keyof typeof after])).toEqual(['conditions'])
    expect(old.workTimeRequirements).toEqual({ version: 1, rules: originalRules })
    expect(updated.id).toBe('greenhouse-time-dawn-4601')
  })
  it('partial interpretation alone is material in conditions, even when no complete rule fits', async () => {
    const old = upgradeJob(legacyWorkTimeJob('4601', { description: 'Maintain backend APIs.' }))
    const partial = { ...old, workTimeRequirements: { version: 1 as const, rules: [], truncated: true } }
    const before = await createJobRevision(old)
    const after = await createJobRevision(partial)
    expect(Object.keys(before).filter(key => before[key as keyof typeof before] !== after[key as keyof typeof after])).toEqual(['conditions'])
  })
  it('all32-company179-job22-city sample data stays unchanged and helpers return no time facts', () => {
    const sample = createSampleCatalog()
    const copy = structuredClone(sample)
    expect(sample.companies).toHaveLength(32)
    expect(sample.jobs).toHaveLength(179)
    expect(sample.cities).toHaveLength(22)
    expect(upgradeCatalog(sample)).toEqual(copy)
    for (const job of sample.jobs) {
      expect(upgradeJobWorkTime(job)).toBe(job)
      expect(job.workTimeRequirements).toBeUndefined()
      expect(workTimeSummary(job)).toBe('')
      expect(workTimeSearchText(job)).toBe('')
      expect(workTimeCaution(job)).toBeUndefined()
    }
  })
})

describe('literal discovery without timezone eligibility or score inference', () => {
  it.each([
    ['UTC', ['greenhouse-time-dawn-4601', 'lever-time-maple-4605']],
    ['코어 근무시간', ['greenhouse-time-dawn-4601', 'lever-time-maple-4605', 'smartrecruiters-time-willow-4606']],
    ['협업 시간대', ['ashby-time-juniper-4604']],
    ['근무시간 중첩', ['greenhouse-time-dawn-4601', 'ashby-time-juniper-4604']],
    ['영어 UTC', ['greenhouse-time-dawn-4601', 'lever-time-maple-4605']],
    ['한국어   협업 시간대', ['ashby-time-juniper-4604']],
    ['CST', ['smartrecruiters-time-willow-4606']],
    ['GMT', []],
  ])('%s selects the literal records with every search word required', (query, ids) => {
    const catalog = legacyWorkTimeCatalog()
    const copy = structuredClone(catalog)
    expect(selectSearchJobs(createSearchIndex(catalog, WORK_TIME_PROFILE), { ...WORK_TIME_FILTERS, query }).map(entry => entry.job.id)).toEqual(ids)
    expect(catalog).toEqual(copy)
  })
  it('counts cities/remote/unmapped separately and never promotes a time-restricted prospect', () => {
    const index = createSearchIndex(legacyWorkTimeCatalog(), WORK_TIME_PROFILE)
    const core = selectSearchJobs(index, { ...WORK_TIME_FILTERS, query: '코어 근무시간' })
    expect(countSearchJobs(core, { kind: 'city', cityId: 'berlin' }, 'all')).toEqual({ jobs: 1, companies: 1, cities: 1 })
    expect(countSearchJobs(core, { kind: 'remote' }, 'all')).toEqual({ jobs: 1, companies: 1, cities: 0 })
    expect(core.filter(entry => inSearchScope(entry, { kind: 'unmapped' })).map(entry => entry.job.id)).toEqual(['smartrecruiters-time-willow-4606'])
    const pool = selectSearchJobs(index, { ...WORK_TIME_FILTERS, postingType: 'talent-pool', query: 'Eastern' })
    expect(pool.map(entry => entry.job.id)).toEqual(['greenhouse-time-dawn-4603'])
  })
  it('CST and IST produce neither guessed geographic aliases nor hidden offset metadata', () => {
    for (const text of [WORK_TIME_AMBIGUOUS, 'Our team operates on IST.']) {
      const job = upgradeJob(legacyWorkTimeJob('4601', { description: text }))
      expect(job.workTimeRequirements!.rules).toHaveLength(1)
      expect(workTimeSearchText(job)).not.toMatch(/Chicago|Kolkata|Dublin|China|India|America\/|Asia\/|중국|인도|시카고|아일랜드|UTC[+-]/i)
      expect(job.remoteCountries).toEqual([])
      expect(job.workMode).toBe('onsite')
    }
  })
  it('residence and declared timezone do not change the baseline90 technical score or applicant eligibility', () => {
    const old = legacyCollectedWorkTimeSaved().job
    const inputCopy = structuredClone(old)
    for (const profile of [
      WORK_TIME_PROFILE,
      { ...WORK_TIME_PROFILE, name: 'Pacific Time Applicant', residence: 'US', headline: 'UTC availability' },
    ]) {
      expect(matchJob(old, profile)).toMatchObject({ score: 90, matchedSkills: ['TypeScript'], missingSkills: [] })
      const remote = legacyWorkTimeCatalog().jobs[4]
      const matches = selectSearchJobs(createSearchIndex({ ...legacyWorkTimeCatalog(), jobs: [remote] }, profile), WORK_TIME_FILTERS)
      expect(matches.map(entry => entry.job.id)).toEqual(['lever-time-maple-4605'])
      expect(remote).toMatchObject({ workMode: 'remote', remoteCountries: [], remoteWorldwide: true })
    }
    expect(old).toEqual(inputCopy)
  })
})
