import { describe, expect, it } from 'vitest'
import { normalizeJob } from '../../server/normalize'
import { greenhouseCompensation } from '../../server/greenhouse-compensation'
import { HimalayasJobSchema, normalizeHimalayasJob } from '../../server/providers/himalayas'
import type { SalaryData } from '../../shared/compensation'
import { parseTextCompensation } from '../../shared/pay-text'
import { upgradeJobCompensation } from '../../shared/job-compensation'
import { upgradeJob } from '../../shared/job-upgrade'
import { decodeSavedJobs } from '../../shared/saved-jobs'
import { filterJobs, formatCompensation, formatJobSalary, medianSalary } from '../../shared/matching'
import { JobSchema } from '../../shared/schemas'
import { COMPENSATION_VERSION, DEFAULT_FILTERS, SAMPLE_PROFILE } from '../../shared/types'
import type { Job } from '../../shared/types'
import { publicProtocolCatalog } from '../fixtures/public-protocol'
import {
  NUMBER_FORMAT_COMPANY, NUMBER_FORMAT_INTRO, NUMBER_FORMAT_LEGACY_PAY, NUMBER_FORMAT_NOTES,
  NUMBER_FORMAT_POSTINGS, NUMBER_FORMAT_QUOTES, NUMBER_FORMAT_TIME, quillHimalayasRaw,
} from '../fixtures/compensation-number-format'
import type { NumberFormatPostingKey } from '../fixtures/compensation-number-format'

// Stage 76 contract: docs/design/compensation-number-format.md (candidate 3).
// Every expected number, note and label below is written out literally. Non-ASCII
// space characters are used only through the named constants below, so reviewers can
// see which code point a row means: NBSP is U+00A0, NARROW_NBSP is U+202F and THIN_SPACE
// is U+2009 (supported grouping separators); FIGURE_SPACE is U+2007 and IDEOGRAPHIC_SPACE
// is U+3000 (both unsupported).
const NBSP = ' '
const NARROW_NBSP = ' '
const THIN_SPACE = ' '
const FIGURE_SPACE = ' '
const IDEOGRAPHIC_SPACE = '　'

const posting = (id: number, title: string, paragraphs: string[]) => normalizeJob({
  id, title, absolute_url: `https://example.test/quill-ledger/jobs/${id}`,
  content: [NUMBER_FORMAT_INTRO, ...paragraphs].map(paragraph => `<p>${paragraph}</p>`).join(''),
  location: { name: 'London, UK' },
}, NUMBER_FORMAT_COMPANY.id, NUMBER_FORMAT_TIME)!
const fixture = (key: NumberFormatPostingKey) => {
  const { id, title, paragraphs } = NUMBER_FORMAT_POSTINGS[key]
  return posting(id, title, paragraphs)
}
const withoutPay = (job: Job) => {
  const { compensationRanges: _ranges, compensationNote: _note, compensationEvidence: _evidence, ...rest } = job
  return rest
}

function expectEvidenceOnly(pay: SalaryData, quote: string) {
  expect(pay.salary).toBeNull()
  expect(pay.compensationRanges).toBeUndefined()
  expect(pay.compensationEvidence).toHaveLength(1)
  expect(pay.compensationEvidence![0].source).toBe('description')
  expect(pay.compensationEvidence![0].text).toContain(quote)
  expect(pay.compensationNote).toBe(NUMBER_FORMAT_NOTES.none)
}

describe('thousands groups and decimal separators are read as whole tokens', () => {
  const annual: [string, number, number, string][] = [
    ['Annual base salary: EUR 84 000–126 000.', 84000, 126000, 'EUR'],
    [`Annual base salary: EUR 84${NBSP}000–126${NBSP}000.`, 84000, 126000, 'EUR'],
    [`Annual base salary: EUR 84${NARROW_NBSP}000–126${NARROW_NBSP}000.`, 84000, 126000, 'EUR'],
    [`Annual base salary: EUR 84${THIN_SPACE}000–126${THIN_SPACE}000.`, 84000, 126000, 'EUR'],
    ['Annual base salary: €88 000 – €124 000.', 88000, 124000, 'EUR'],
    ['Annual base salary: USD 1 000 000.', 1000000, 1000000, 'USD'],
    [`Annual base salary: EUR 1 234${NBSP}567.`, 1234567, 1234567, 'EUR'],
    ['Annual base salary: EUR 1.200.000–1.500.000.', 1200000, 1500000, 'EUR'],
    ['Annual base salary: EUR 1,234.567–2,345.678.', 1234.567, 2345.678, 'EUR'],
    ['Annual base salary: EUR 1234.567–2345.678.', 1234.567, 2345.678, 'EUR'],
    ['Annual base salary: EUR 84 000.50–126 000.75.', 84000.5, 126000.75, 'EUR'],
    ['Annual base salary: EUR 84,000.50–126,000.75.', 84000.5, 126000.75, 'EUR'],
    ['Annual base salary: USD 120.5000.', 120.5, 120.5, 'USD'],
  ]
  it.each(annual)('reads the complete annual base range: %s', (text, min, max, currency) => {
    const pay = parseTextCompensation(text)
    expect(pay.salary).toEqual({ min, max, currency })
    expect(pay.compensationRanges).toEqual([expect.objectContaining({ min, max, currency, period: 'year', basis: 'base' })])
    expect(pay.compensationRanges![0].evidence).toEqual({ source: 'description', text })
    expect(pay.compensationEvidence).toBeUndefined()
    expect(pay.compensationNote).toBeUndefined()
  })

  const other: [string, number, number, string, string][] = [
    ['Monthly base salary: EUR 84.000,50–126.000,75.', 84000.5, 126000.75, 'EUR', 'month'],
    ['Monthly base salary: EUR 84 000,50–126 000,75.', 84000.5, 126000.75, 'EUR', 'month'],
    ['Hourly base pay: USD 55.50–60.', 55.5, 60, 'USD', 'hour'],
    ['Annual base salary: PLN 365 000 - PLN 485 000.', 365000, 485000, 'PLN', 'year'],
    ['Base salary: PLN 365 000 - PLN 485 000.', 365000, 485000, 'PLN', 'unknown'],
    ['Monthly salary range: 18 850 - 29 660 PLN per month.', 18850, 29660, 'PLN', 'month'],
  ]
  it.each(other)('keeps a non-annual or unsupported-currency range visible without comparison: %s', (text, min, max, currency, period) => {
    const pay = parseTextCompensation(text)
    expect(pay.salary).toBeNull()
    expect(pay.compensationRanges).toEqual([expect.objectContaining({ min, max, currency, period })])
    expect(pay.compensationEvidence).toBeUndefined()
  })

  it.each([
    ['Annual base salary: EUR 62.000–118.000.', '62.000–118.000'],
    ['Annual base salary: EUR 62.000.', 'EUR 62.000'],
    ['Annual salary: EUR 1.500k.', '1.500k'],
    ['Annual salary: EUR 1.500m.', '1.500m'],
    ['Annual base salary: EUR 62.000–118,000.', '62.000–118,000'],
    ['Annual base salary: EUR 62,000–118.000.', '62,000–118.000'],
    ['Compensation range\n62.000 - 118.000 EUR gross annually', '62.000 - 118.000 EUR gross annually'],
  ])('keeps a dotted three-digit core as evidence without choosing a locale: %s', (text, quote) => {
    expectEvidenceOnly(parseTextCompensation(text), quote)
  })
})

describe('unsupported notations never salvage a partial amount', () => {
  it.each([
    ['Annual base salary: EUR 24,50–38,75.', '24,50–38,75'],
    ['Annual base salary: $204,00 - $264,000.', '$204,00 - $264,000'],
    ['Annual base salary: €86 00 – €122 000.', '€86 00 – €122 000'],
    ['Annual base salary: €86 05 – €122 000.', '€86 05 – €122 000'],
    ['Annual base salary: €86 0000.', '€86 0000'],
    ["Annual base salary: CHF 120'000–150'000.", "120'000–150'000"],
    ['Annual base salary: CHF 120’000–150’000.', '120’000–150’000'],
    ['Annual base salary: INR 12,50,000–15,00,000.', '12,50,000–15,00,000'],
    ['Annual base salary: USD 1,0000–2,0000.', '1,0000–2,0000'],
    ['Annual base salary: EUR 1,234 567.', '1,234 567'],
    ['Annual salary: EUR 84 000k.', '84 000k'],
    ['Annual salary: EUR 1.200.000k.', '1.200.000k'],
    ['Annual salary: EUR 84.000,50k.', '84.000,50k'],
    ['Annual base salary: EUR 84.000,500.', '84.000,500'],
    ['Annual base salary: USD 120,000 3 days a week.', 'USD 120,000 3 days'],
    ['Annual base salary: USD 120,000 100% remote.', 'USD 120,000 100%'],
    ['Annual base salary: USD 120,000 –\nUSD 150,000.', 'USD 120,000 –'],
    ['Annual base salary: USD 120,000\n–\nUSD 150,000.', 'USD 120,000'],
  ])('retains only the quoted evidence: %s', (text, quote) => {
    expectEvidenceOnly(parseTextCompensation(text), quote)
  })

  it.each([
    'Annual base salary: USD 1e5–2e5.',
    'Annual base salary: USD +120,000.',
    'Annual base salary: USD １２０,０００.',
    `Annual base salary: EUR 84${FIGURE_SPACE}000.`,
    `Annual base salary: EUR 84${IDEOGRAPHIC_SPACE}000–126${IDEOGRAPHIC_SPACE}000.`,
  ])('keeps an unsupported digit, sign, exponent or space as evidence only: %s', text => {
    // Contract lines 73, 83 and 87: with an adjacent currency marker in a pay clause, an
    // unsupported notation keeps the quote and the existing no-confirmed-range note.
    expectEvidenceOnly(parseTextCompensation(text), text)
  })

  it('does not let unrelated malformed numbers or numeric bullets disturb a valid salary', () => {
    for (const text of [
      'Annual base salary: USD 120,000 for a team of 1 0.',
      '62.000 units shipped. Annual base salary: USD 120,000.',
    ]) {
      const pay = parseTextCompensation(text)
      expect(pay.salary).toEqual({ min: 120000, max: 120000, currency: 'USD' })
      expect(pay.compensationRanges).toHaveLength(1)
      expect(pay.compensationEvidence).toBeUndefined()
      expect(pay.compensationNote).toBeUndefined()
    }
    const bullets = parseTextCompensation('Annual base salary: USD 150,000\n- 4 weeks of vacation\n- 401(k) match')
    expect(bullets.salary).toEqual({ min: 150000, max: 150000, currency: 'USD' })
    expect(bullets.compensationRanges).toHaveLength(1)
    expect(bullets.compensationEvidence).toBeUndefined()
    expect(bullets.compensationNote).toBeUndefined()
  })
})

describe('range envelopes with period annotations, trailing currency and separate clauses', () => {
  it('reads annotated and trailing-currency endpoints as one range', () => {
    expect(parseTextCompensation('Annual base salary ranges from USD 174,000/year to USD 299,000/year.').salary).toEqual({ min: 174000, max: 299000, currency: 'USD' })
    expect(parseTextCompensation('Annual base salary: 120,000 USD – 150,000 USD.').salary).toEqual({ min: 120000, max: 150000, currency: 'USD' })
    const monthly = parseTextCompensation('Monthly base salary ranges from EUR 5,000/month to EUR 7,000/month.')
    expect(monthly.salary).toBeNull()
    expect(monthly.compensationRanges).toEqual([expect.objectContaining({ min: 5000, max: 7000, currency: 'EUR', period: 'month' })])
  })

  it('voids the whole annotated range when one endpoint is malformed', () => {
    expectEvidenceOnly(parseTextCompensation('Annual base salary: USD 84,00/year to USD 126,000/year.'), 'USD 84,00/year to USD 126,000/year')
    expectEvidenceOnly(parseTextCompensation(NUMBER_FORMAT_QUOTES.annotated), 'USD 84,00/year to USD 126,000/year')
  })

  it('keeps a separately labelled valid range visible next to a malformed one without comparing the posting', () => {
    const pay = parseTextCompensation('USA Sapphire base pay range: $204,00 - $264,000.\nUSA Pacific base pay range: USD 230,000 - USD 290,000.')
    expect(pay.salary).toBeNull()
    expect(pay.compensationRanges).toEqual([expect.objectContaining({ min: 230000, max: 290000, currency: 'USD' })])
    expect(pay.compensationEvidence).toHaveLength(1)
    expect(pay.compensationEvidence![0].text).toContain('$204,00 - $264,000')
    expect(pay.compensationEvidence![0].text).not.toContain('290,000')
    expect(pay.compensationNote).toBe(NUMBER_FORMAT_NOTES.partial)
  })

  it('shows the valid regional row and quotes the ambiguous row from the same section', () => {
    const job = fixture('mixed')
    expect(job.salary).toBeNull()
    expect(job.compensationRanges).toEqual([expect.objectContaining({ min: 136000, max: 187000, currency: 'USD', period: 'year', basis: 'base' })])
    expect(job.compensationRanges![0].scope).toContain('Colorado')
    expect(job.compensationEvidence).toHaveLength(1)
    expect(job.compensationEvidence![0].text).toContain(NUMBER_FORMAT_QUOTES.portugal)
    expect(job.compensationEvidence![0].text).not.toContain('Colorado')
    expect(job.compensationNote).toBe(NUMBER_FORMAT_NOTES.partial)
    expect(formatJobSalary(job)).toBe('별도 보상 조건')
  })
})

describe('multipliers, shorthand inheritance and the exact safe ceiling', () => {
  it.each([
    ['Annual salary: EUR 84–126k.', 84000, 126000],
    ['Annual salary: EUR 84 000–126k.', 84000, 126000],
    ['Annual salary: EUR 1.25m.', 1250000, 1250000],
    ['Annual salary: EUR 1.2345m.', 1234500, 1234500],
    ['Annual salary: EUR 84,000k.', 84000000, 84000000],
    ['Annual salary: EUR 120 k.', 120000, 120000],
    ['Annual salary: EUR 1.5–2k.', 1500, 2000],
    ['Annual salary: EUR 1 000–2k.', 1000, 2000],
  ] as [string, number, number][])('applies k and m only where the legacy grammar allows: %s', (text, min, max) => {
    const pay = parseTextCompensation(text)
    expect(pay.compensationRanges).toEqual([expect.objectContaining({ min, max, currency: 'EUR', period: 'year' })])
    expect(pay.salary).toEqual({ min, max, currency: 'EUR' })
  })

  it('accepts amounts up to the exact safe integer and keeps larger scaled values as evidence', () => {
    for (const text of ['Annual salary: USD 9007199254740991.', 'Annual salary: USD 9007199254740.991k.']) {
      expect(parseTextCompensation(text).compensationRanges).toEqual([expect.objectContaining({ min: Number.MAX_SAFE_INTEGER, max: Number.MAX_SAFE_INTEGER })])
    }
    for (const [text, quote] of [
      ['Annual salary: USD 9007199254740991.01.', '9007199254740991.01'],
      ['Annual salary: USD 9007199254.74099101m.', '9007199254.74099101m'],
      ['Annual salary: USD 9007199254740992.', '9007199254740992'],
      ['Annual salary: USD 9,007,199,254,740,992.', '9,007,199,254,740,992'],
      ['Annual salary: EUR 84 000 000 000 000 000 000.', '84 000 000 000 000 000 000'],
    ]) expectEvidenceOnly(parseTextCompensation(text), quote)
  })

  it('stays bounded on long pathological digit runs without claiming an amount', () => {
    for (const text of [
      `Annual base salary: USD ${'1 '.repeat(60000)}.`,
      `Annual base salary: USD 1${' 000'.repeat(30000)}.`,
      `Annual base salary: USD 1${',000'.repeat(30000)}.`,
      `Annual base salary: USD ${'9'.repeat(400)}.`,
      `Annual base salary: USD ${'1.'.repeat(40000)}5.`,
    ]) {
      const pay = parseTextCompensation(text)
      expect(pay.salary).toBeNull()
      expect(pay.compensationRanges).toBeUndefined()
    }
  })
})

describe('interpretation version 3 accepts earlier records and rejects unknown versions', () => {
  it('pins the current version and the accepted schema literals', () => {
    expect(COMPENSATION_VERSION).toBe(3)
    const job = fixture('spaceGrouped')
    expect(job.compensationVersion).toBe(3)
    for (const version of [1, 2, 3]) expect(JobSchema.safeParse({ ...job, compensationVersion: version }).success).toBe(true)
    expect(JobSchema.safeParse({ ...job, compensationVersion: undefined }).success).toBe(true)
    for (const version of [0, 4, 99]) expect(JobSchema.safeParse({ ...job, compensationVersion: version }).success).toBe(false)
  })

  it('decodes saved records from every accepted version, upgrades recoverable ones and drops an unknown future version', () => {
    const current = fixture('spaceGrouped')
    const base = withoutPay(current)
    const record = (job: Job, id: string) => ({ job: { ...job, id }, company: NUMBER_FORMAT_COMPANY, savedAt: NUMBER_FORMAT_TIME, status: 'saved', note: `note ${id}` })
    const decoded = decodeSavedJobs(JSON.stringify([
      record({ ...base, salary: null, compensationVersion: 1 }, 'greenhouse-fixture-quill-ledger-v1'),
      record({ ...base, ...NUMBER_FORMAT_LEGACY_PAY.spaceGrouped, compensationVersion: 2 }, 'greenhouse-fixture-quill-ledger-v2'),
      record(current, 'greenhouse-fixture-quill-ledger-v3'),
      record({ ...current, compensationVersion: 4 as unknown as Job['compensationVersion'] }, 'greenhouse-fixture-quill-ledger-v4'),
    ]))
    expect(decoded.omitted).toBe(1)
    expect(decoded.reason).toBe('records')
    expect(decoded.records.map(item => item.job.id)).toEqual([
      'greenhouse-fixture-quill-ledger-v1', 'greenhouse-fixture-quill-ledger-v2', 'greenhouse-fixture-quill-ledger-v3',
    ])
    for (const item of decoded.records) {
      expect(item.job).toMatchObject({ compensationVersion: COMPENSATION_VERSION, salary: { min: 88000, max: 124000, currency: 'EUR' }, fetchedAt: NUMBER_FORMAT_TIME })
      expect(item.job.compensationRanges).toEqual([expect.objectContaining({ min: 88000, max: 124000, currency: 'EUR', period: 'year' })])
      expect(item.job.compensationEvidence).toBeUndefined()
      expect(item.job.compensationNote).toBeUndefined()
    }
    expect(decoded.records[1].note).toBe('note greenhouse-fixture-quill-ledger-v2')
  })
})

describe('rechecking version 2 text-derived records', () => {
  const legacy = (key: 'spaceGrouped' | 'dotted'): Job => ({ ...withoutPay(fixture(key)), ...NUMBER_FORMAT_LEGACY_PAY[key], compensationVersion: 2 })

  it('replaces a truncated space-grouped range with the complete amounts and keeps identity and timestamps', () => {
    const old = legacy('spaceGrouped')
    expect(JobSchema.safeParse(old).success).toBe(true)
    const updated = upgradeJobCompensation(old)
    expect(updated).toMatchObject({
      id: old.id, fetchedAt: NUMBER_FORMAT_TIME, description: old.description,
      compensationVersion: COMPENSATION_VERSION, salary: { min: 88000, max: 124000, currency: 'EUR' },
    })
    expect(updated.compensationRanges).toEqual([expect.objectContaining({ min: 88000, max: 124000, currency: 'EUR', period: 'year', basis: 'base' })])
    expect(updated.compensationEvidence).toBeUndefined()
    expect(updated.compensationNote).toBeUndefined()
    expect(upgradeJobCompensation(updated)).toBe(updated)
    expect(upgradeJobCompensation(old, true)).toMatchObject({ salary: { min: 88000, max: 124000, currency: 'EUR' }, compensationVersion: COMPENSATION_VERSION })
    expect(old).toMatchObject({ compensationVersion: 2, salary: null })
    expect(old.compensationRanges![0].min).toBe(88)
  })

  it('replaces an ambiguous dotted range with the quote instead of preserving the earlier wrong number', () => {
    const old = legacy('dotted')
    for (const preserve of [false, true]) {
      const updated = upgradeJobCompensation(old, preserve)
      expect(updated).toMatchObject({ id: old.id, fetchedAt: NUMBER_FORMAT_TIME, salary: null, compensationVersion: COMPENSATION_VERSION, compensationNote: NUMBER_FORMAT_NOTES.none })
      expect(updated.compensationRanges).toBeUndefined()
      expect(updated.compensationEvidence).toHaveLength(1)
      expect(updated.compensationEvidence![0].text).toContain(NUMBER_FORMAT_QUOTES.dotted)
      expect(formatJobSalary(updated)).toBe('보상 확인 필요')
    }
    expect(old.compensationRanges![0]).toMatchObject({ min: 62, max: 118 })
  })

  it('removes a previously comparable wrong dotted salary from comparison', () => {
    const current = posting(7610, 'Backend Engineer — dotted comparable fixture', ['Annual base salary: 62.000–118.000 EUR.'])
    expect(current.salary).toBeNull()
    expect(current.compensationEvidence).toHaveLength(1)
    const old: Job = {
      ...withoutPay(current), compensationVersion: 2, salary: { min: 62, max: 118, currency: 'EUR' },
      compensationRanges: [{
        label: 'Annual base salary', min: 62, max: 118, currency: 'EUR', period: 'year', basis: 'base',
        evidence: { source: 'description', text: 'Annual base salary: 62.000–118.000 EUR.' },
      }],
    }
    expect(formatJobSalary(old)).toBe('€0–0k · 이전 기록')
    for (const preserve of [false, true]) {
      const updated = upgradeJobCompensation(old, preserve)
      expect(updated).toMatchObject({ salary: null, compensationVersion: COMPENSATION_VERSION, compensationNote: NUMBER_FORMAT_NOTES.none, fetchedAt: NUMBER_FORMAT_TIME })
      expect(updated.compensationRanges).toBeUndefined()
      expect(updated.compensationEvidence![0].text).toContain('62.000–118.000 EUR')
    }
  })

  it('keeps a version 2 salary without recoverable evidence as an earlier record only for saved snapshots', () => {
    const old: Job = {
      ...withoutPay(fixture('spaceGrouped')), compensationVersion: 2,
      salary: { min: 88000, max: 124000, currency: 'EUR' }, description: 'This older excerpt has no compensation information.',
    }
    expect(upgradeJobCompensation(old, true)).toBe(old)
    expect(formatJobSalary(old)).toBe('€88–124k · 이전 기록')
    const fresh = upgradeJobCompensation(old)
    expect(fresh).toMatchObject({ salary: null, compensationVersion: COMPENSATION_VERSION, fetchedAt: NUMBER_FORMAT_TIME })
    expect(fresh.compensationNote).toContain('보상 근거')
  })

  it('recovers a space-grouped quote retained beyond the stored body without extending the description', () => {
    const complete = fixture('spaceGrouped')
    const old: Job = {
      ...complete, ...NUMBER_FORMAT_LEGACY_PAY.spaceGrouped, compensationVersion: 2,
      description: 'Original technical responsibilities. '.repeat(900).slice(0, 26000),
    }
    const updated = upgradeJobCompensation(old)
    expect(updated.salary).toEqual({ min: 88000, max: 124000, currency: 'EUR' })
    expect(updated.compensationRanges).toEqual([expect.objectContaining({ min: 88000, max: 124000, currency: 'EUR', period: 'year' })])
    expect(updated.compensationEvidence).toBeUndefined()
    expect(updated.description).toBe(old.description)
    expect(updated.fetchedAt).toBe(NUMBER_FORMAT_TIME)
  })

  it.each(['greenhouse', 'ashby', 'lever', 'smartrecruiters', 'himalayas'] as const)('keeps version 2 %s structured disclosures unchanged apart from the version despite conflicting prose', source => {
    const body = posting(7620, 'Backend Engineer — structured fixture', ['Annual base salary: €50 000 – €60 000.'])
    const old: Job = {
      ...body, source, compensationVersion: 2,
      ...greenhouseCompensation('', [{ title: 'Annual base salary', min_cents: 9000000, max_cents: 12000000, currency_type: 'GBP' }]),
    }
    expect(old.salary).toEqual({ min: 90000, max: 120000, currency: 'GBP' })
    expect(upgradeJobCompensation(old)).toEqual({ ...old, compensationVersion: COMPENSATION_VERSION })
    expect(upgradeJob(old).salary).toEqual({ min: 90000, max: 120000, currency: 'GBP' })
    const incomplete: Job = {
      ...old, salary: null, compensationRanges: undefined, compensationNote: 'Provider did not return both bounds.',
      compensationEvidence: [{ source: 'board', text: 'Annual base salary · GBP · upper bound unavailable' }],
    }
    expect(upgradeJobCompensation(incomplete)).toEqual({ ...incomplete, compensationVersion: COMPENSATION_VERSION })
    expect(upgradeJobCompensation(incomplete, true)).toEqual({ ...incomplete, compensationVersion: COMPENSATION_VERSION })
  })
})

describe('catalog statistics, filters and display strings for the fictional postings', () => {
  const keys = Object.keys(NUMBER_FORMAT_POSTINGS) as NumberFormatPostingKey[]
  const jobs = keys.map(fixture)
  const catalog = publicProtocolCatalog({ jobs, fetchedAt: NUMBER_FORMAT_TIME, companies: [NUMBER_FORMAT_COMPANY] })

  it('counts only complete annual base ranges as comparable and excludes the rest from the known-salary filter', () => {
    expect(jobs.map(job => formatJobSalary(job))).toEqual([
      '€88–124k', '보상 확인 필요', '보상 확인 필요', '별도 보상 조건', '$150–150k',
    ])
    expect(formatCompensation(jobs[0].compensationRanges![0])).toBe('EUR 88,000–124,000 / 년')
    expect(formatCompensation(jobs[3].compensationRanges![0])).toBe('USD 136,000–187,000 / 년')
    expect(formatCompensation(jobs[4].compensationRanges![0])).toBe('USD 150,000–150,000 / 년')
    expect(jobs[1].compensationNote).toBe(NUMBER_FORMAT_NOTES.none)
    expect(jobs[2].compensationNote).toBe(NUMBER_FORMAT_NOTES.none)
    expect(jobs.filter(job => job.salary)).toHaveLength(2)
    expect(jobs.filter(job => !job.salary && (job.compensationRanges?.length || job.compensationNote))).toHaveLength(3)
    const matches = filterJobs(catalog, SAMPLE_PROFILE, DEFAULT_FILTERS)
    expect(matches).toHaveLength(5)
    expect(medianSalary(matches)).toBeCloseTo(133300, 5)
    const known = filterJobs(catalog, SAMPLE_PROFILE, { ...DEFAULT_FILTERS, includeUnknownSalary: false })
    expect(new Set(known.map(match => match.job.title))).toEqual(new Set([NUMBER_FORMAT_POSTINGS.spaceGrouped.title, NUMBER_FORMAT_POSTINGS.bullets.title]))
  })
})

describe('Himalayas keeps its body-first policy with the new incomplete evidence', () => {
  const normalize = (description: string) => normalizeHimalayasJob(HimalayasJobSchema.parse(quillHimalayasRaw({ description })), NUMBER_FORMAT_COMPANY.id, NUMBER_FORMAT_TIME)!

  it('uses a complete space-grouped body range ahead of API amounts', () => {
    const job = normalize('<p>Build a fictional ledger API with TypeScript.</p><p>Annual base salary: €88 000 – €124 000.</p>')
    expect(job.salary).toEqual({ min: 88000, max: 124000, currency: 'EUR' })
    expect(job.compensationRanges).toEqual([expect.objectContaining({ min: 88000, max: 124000, currency: 'EUR' })])
  })

  it.each([
    ['ambiguous dotted', 'Annual base salary: 62.000–118.000 EUR.', '62.000–118.000 EUR'],
    ['bare comma fraction', 'Annual base salary: EUR 24,50–38,75.', 'EUR 24,50–38,75'],
  ])('keeps an %s body statement as evidence and does not fall back to API amounts', (_label, sentence, quote) => {
    const job = normalize(`<p>Build a fictional ledger API with TypeScript.</p><p>${sentence}</p>`)
    expect(job.salary).toBeNull()
    expect(job.compensationRanges).toBeUndefined()
    expect(job.compensationEvidence).toHaveLength(1)
    expect(job.compensationEvidence![0]).toMatchObject({ source: 'description' })
    expect(job.compensationEvidence![0].text).toContain(quote)
    expect(job.compensationNote).toBe(NUMBER_FORMAT_NOTES.none)
  })

  it('still uses API amounts when the body states no pay', () => {
    const job = normalize('<p>Build a fictional ledger API with TypeScript.</p>')
    expect(job.salary).toBeNull()
    expect(job.compensationRanges).toEqual([expect.objectContaining({ min: 150000, max: 180000, currency: 'USD', period: 'year', basis: 'unknown' })])
    expect(job.compensationRanges![0].evidence?.source).toBe('board')
  })
})
