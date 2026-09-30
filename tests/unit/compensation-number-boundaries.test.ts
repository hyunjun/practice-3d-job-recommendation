import { describe, expect, it } from 'vitest'
import { normalizeJob } from '../../server/normalize'
import { parseTextCompensation } from '../../shared/pay-text'
import { upgradeJobCompensation } from '../../shared/job-compensation'
import { decodeSavedJobs } from '../../shared/saved-jobs'
import { formatCompensation, formatJobSalary } from '../../shared/matching'
import { COMPENSATION_VERSION } from '../../shared/types'
import type { Job } from '../../shared/types'
import {
  NUMBER_FORMAT_COMPANY, NUMBER_FORMAT_INTRO, NUMBER_FORMAT_LABEL_QUOTES, NUMBER_FORMAT_NOTES, NUMBER_FORMAT_TIME,
} from '../fixtures/compensation-number-format'

// Stage 76 · second authoring pass. Literal regressions for the product-review findings
// A76-P1 to A76-P6 and Main M1 recorded in .local/research/76/collaboration/product-discussion-04.md,
// under the unchanged candidate 3 contract (SHA-256 7352148a…9f5df). Expected values are
// contract literals and existing product notes; nothing is computed with the parser.

function evidenceOnly(text: string, quote: string) {
  const pay = parseTextCompensation(text)
  expect(pay.salary).toBeNull()
  expect(pay.compensationRanges).toBeUndefined()
  expect(pay.compensationEvidence).toHaveLength(1)
  expect(pay.compensationEvidence![0].source).toBe('description')
  expect(pay.compensationEvidence![0].text).toContain(quote)
  expect(pay.compensationNote).toBe(NUMBER_FORMAT_NOTES.none)
  return pay
}

function comparable(text: string, min: number, max: number, currency: string) {
  const pay = parseTextCompensation(text)
  expect(pay.salary).toEqual({ min, max, currency })
  expect(pay.compensationRanges).toEqual([expect.objectContaining({ min, max, currency, period: 'year' })])
  expect(pay.compensationEvidence).toBeUndefined()
  expect(pay.compensationNote).toBeUndefined()
  return pay
}

describe('P1 · range connectors versus unary signs', () => {
  const connectors: [string, string][] = [['ASCII hyphen', '-'], ['en dash', '–'], ['em dash', '—'], ['U+2212 minus', '−']]
  const links: [string, string][] = connectors.flatMap(([name, link]): [string, string][] => [
    [`${name}, tight, bare right endpoint`, `Annual base salary: USD 84,000${link}126,000.`],
    [`${name}, spaced, bare right endpoint`, `Annual base salary: USD 84,000 ${link} 126,000.`],
    [`${name}, tight, marked right endpoint`, `Annual base salary: USD 84,000${link}USD 126,000.`],
    [`${name}, spaced, marked right endpoint`, `Annual base salary: USD 84,000 ${link} USD 126,000.`],
  ])
  it.each(links)('reads the full range across an %s', (_name, text) => {
    comparable(text, 84000, 126000, 'USD')
  })

  it.each([
    ['Annual base salary: USD 84,000 to -126,000.', 'to -126,000'],
    ['Annual base salary: USD 84,000 to -USD 126,000.', 'to -USD 126,000'],
    ['Annual base salary: USD 84,000 to USD -126,000.', 'USD -126,000'],
    ['Annual base salary: USD 84,000 – -126,000.', '– -126,000'],
    ['Annual base salary: USD 84,000--126,000.', '84,000--126,000'],
    ['Annual base salary: USD -84,000–126,000.', '-84,000–126,000'],
  ])('rejects the whole range when an endpoint carries a unary sign: %s', (text, quote) => {
    evidenceOnly(text, quote)
  })

  it('keeps a separately labelled valid range after a signed range', () => {
    const pay = parseTextCompensation('Junior annual base salary: USD 84,000 to -126,000.\nSenior annual base salary: USD 130,000–150,000.')
    expect(pay.salary).toBeNull()
    expect(pay.compensationRanges).toEqual([expect.objectContaining({ min: 130000, max: 150000, currency: 'USD', period: 'year' })])
    expect(pay.compensationEvidence).toHaveLength(1)
    expect(pay.compensationEvidence![0].text).toContain('to -126,000')
    expect(pay.compensationEvidence![0].text).not.toContain('130,000')
    expect(pay.compensationNote).toBe(NUMBER_FORMAT_NOTES.partial)
  })
})

describe('P2 · numeric continuations after a multiplier, currency or period annotation', () => {
  it.each([
    ['Annual base salary: USD 84k.5.', 'USD 84k.5'],
    ['Annual base salary: USD 84k,5.', 'USD 84k,5'],
    ['Annual base salary: USD 84k–126k.5.', '84k–126k.5'],
    ['Annual base salary: 84,000 USD.5.', '84,000 USD.5'],
    ['Annual base salary: USD 84,000/year.5.', '84,000/year.5'],
    ['Annual base salary: USD 84,000/year,5 to USD 126,000/year.', '84,000/year,5'],
  ])('cannot salvage an amount from %s', (text, quote) => {
    evidenceOnly(text, quote)
  })

  it('keeps a decimal before the multiplier and ordinary terminal punctuation', () => {
    comparable('Annual base salary: USD 84.5k.', 84500, 84500, 'USD')
    comparable('Annual base salary: USD 84k.', 84000, 84000, 'USD')
    comparable('Annual base salary: USD 84k; equity is granted separately.', 84000, 84000, 'USD')
    comparable('Annual base salary: 84,000 USD.', 84000, 84000, 'USD')
    comparable('Annual base salary: USD 84,000/year.', 84000, 84000, 'USD')
  })
})

describe('P3 · LF, CRLF and CR line endings', () => {
  const endings: [string, string][] = [['LF', '\n'], ['CRLF', '\r\n'], ['CR', '\r']]

  it.each(endings)('keeps a valid salary ahead of numeric bullets separated by %s', (_name, eol) => {
    const pay = parseTextCompensation(`Annual base salary: USD 150,000${eol}- 4 weeks of vacation${eol}- 401(k) match`)
    expect(pay.salary).toEqual({ min: 150000, max: 150000, currency: 'USD' })
    expect(pay.compensationRanges).toHaveLength(1)
    expect(pay.compensationEvidence).toBeUndefined()
    expect(pay.compensationNote).toBeUndefined()
  })

  it.each(endings)('keeps wrapped ranges as evidence only across %s, with marked and bare right endpoints', (_name, eol) => {
    evidenceOnly(`Annual base salary: USD 120,000 –${eol}USD 150,000.`, 'USD 120,000 –')
    evidenceOnly(`Annual base salary: USD 120,000 –${eol}150,000.`, 'USD 120,000 –')
    evidenceOnly(`Annual base salary: USD 120,000 -${eol}150,000.`, 'USD 120,000 -')
    evidenceOnly(`Annual base salary: USD 120,000${eol}–${eol}USD 150,000.`, 'USD 120,000')
    evidenceOnly(`Annual base salary: USD 120,000${eol}–${eol}150,000.`, 'USD 120,000')
  })
})

describe('M1 · a trailing currency code belongs to its own endpoint', () => {
  it.each([
    ['ASCII hyphen', NUMBER_FORMAT_LABEL_QUOTES.trailingCurrency],
    ['en dash', 'Monthly salary range: 29,000 PLN – 32,900 PLN per month.'],
  ])('reads one monthly PLN range across an %s', (_name, text) => {
    const pay = parseTextCompensation(text)
    expect(pay.salary).toBeNull()
    expect(pay.compensationRanges).toEqual([expect.objectContaining({ min: 29000, max: 32900, currency: 'PLN', period: 'month', basis: 'base' })])
    expect(pay.compensationEvidence).toBeUndefined()
    expect(pay.compensationNote).toBe(NUMBER_FORMAT_NOTES.notAnnual)
    expect(formatCompensation(pay.compensationRanges![0])).toBe('PLN 29,000–32,900 / 월')
  })

  it('reads trailing-currency annual ranges with either connector', () => {
    comparable('Annual base salary: 120,000 USD - 150,000 USD.', 120000, 150000, 'USD')
    comparable('Annual base salary: 120,000 USD – 150,000 USD.', 120000, 150000, 'USD')
  })
})

describe('P4 · a whitespace-separated dash after an existing city label is punctuation, other dashes are signs', () => {
  it('reads the full EUR range after the label without inventing scope, currency or period', () => {
    const unperioded = parseTextCompensation('Salary Range: Paris - 50,000€ to 76,000€')
    expect(unperioded.salary).toBeNull()
    expect(unperioded.compensationRanges).toEqual([expect.objectContaining({ min: 50000, max: 76000, currency: 'EUR', period: 'unknown', basis: 'base' })])
    expect(unperioded.compensationRanges![0].scope).toBeUndefined()
    expect(unperioded.compensationEvidence).toBeUndefined()
    expect(unperioded.compensationNote).toBe(NUMBER_FORMAT_NOTES.periodUnknown)
    const annual = comparable(NUMBER_FORMAT_LABEL_QUOTES.cityLabel, 51000, 76000, 'EUR')
    expect(annual.compensationRanges![0].scope).toBeUndefined()
    expect(annual.compensationRanges![0].basis).toBe('base')
    expect(parseTextCompensation('Salary Range: Paris - 50,000 to 76,000')).toEqual({ salary: null })
  })

  it.each([
    ['Annual base salary: about - 84,000 USD.', 'about - 84,000 USD'],
    ['Annual base salary: approximately - 84,000 USD.', 'approximately - 84,000 USD'],
    ['Annual base salary: - 84,000 USD.', '- 84,000 USD'],
    ['Annual base salary: -84,000 USD.', '-84,000 USD'],
    ['Salary Range: Paris- 50,000€ to 76,000€', 'Paris- 50,000€'],
    ['Salary Range: Paris -50,000€ to 76,000€', 'Paris -50,000€'],
  ])('rejects a dash that is not a recognized label separator: %s', (text, quote) => {
    evidenceOnly(text, quote)
  })
})

describe('P5 · slash expressions versus slash annotations', () => {
  it.each([
    ['Annual base salary: USD 84,000/2.', '84,000/2'],
    ['Annual base salary: USD 84,000/ 2.', '84,000/ 2'],
    ['Annual base salary: USD 84,000 /2.', '84,000 /2'],
    ['Annual base salary: USD 84,000 / 2.', '84,000 / 2'],
    ['Annual base salary: USD 84,000/.5.', '84,000/.5'],
    ['Annual base salary: USD 84,000/ .5.', '84,000/ .5'],
    ['Annual base salary: USD 84,000/-2.', '84,000/-2'],
    ['Annual base salary: USD 84,000 / +2.', '84,000 / +2'],
    ['Annual base salary: USD 84,000/2 to USD 126,000/2.', '84,000/2 to USD 126,000/2'],
  ])('rejects a numeric slash expression with full evidence: %s', (text, quote) => {
    evidenceOnly(text, quote)
  })

  it('keeps legacy slash words and the approved slash periods without inventing a period from /gross', () => {
    comparable('Annual base salary: 84,000 USD/gross.', 84000, 84000, 'USD')
    comparable('The base salary is USD 165,000–230,000/per year.', 165000, 230000, 'USD')
    comparable('Annual base salary: USD 174,000/year to USD 299,000/year.', 174000, 299000, 'USD')
    const gross = parseTextCompensation('Base salary: EUR 5,300–7,000/gross.')
    expect(gross.salary).toBeNull()
    expect(gross.compensationRanges).toEqual([expect.objectContaining({ min: 5300, max: 7000, currency: 'EUR', period: 'unknown' })])
    expect(gross.compensationEvidence).toBeUndefined()
  })

  it('keeps a later valid compensation clause after a rejected slash expression', () => {
    const pay = parseTextCompensation('Annual base salary: USD 84,000 / 2.\nSenior annual base salary: USD 130,000.')
    expect(pay.salary).toBeNull()
    expect(pay.compensationRanges).toEqual([expect.objectContaining({ min: 130000, max: 130000, currency: 'USD', period: 'year' })])
    expect(pay.compensationEvidence).toHaveLength(1)
    expect(pay.compensationEvidence![0].text).toContain('84,000 / 2')
    expect(pay.compensationEvidence![0].text).not.toContain('130,000')
    expect(pay.compensationNote).toBe(NUMBER_FORMAT_NOTES.partial)
  })
})

describe('P6 · dense non-pay text near the text bound stays within the ordinary test timeout', () => {
  it('returns literal empty results for dense numeric, dash, colon and label-like text without pay context', () => {
    for (const text of [
      '1x '.repeat(33000),
      '1 - 2x '.repeat(14000),
      'a: 1 - 2 '.repeat(11000),
      'Paris - 1 '.repeat(9900),
      '1x '.repeat(40000),
    ]) expect(parseTextCompensation(text)).toEqual({ salary: null })
  })

  it('still reads a valid salary line after dense dash text inside the bound', () => {
    const text = `${'7 - 7x '.repeat(14000)}\nAnnual base salary: USD 120,000.`
    expect(text.length).toBeLessThan(100000)
    const pay = parseTextCompensation(text)
    expect(pay.salary).toEqual({ min: 120000, max: 120000, currency: 'USD' })
    expect(pay.compensationRanges).toHaveLength(1)
    expect(pay.compensationEvidence).toBeUndefined()
    expect(pay.compensationNote).toBeUndefined()
  })
})

describe('residual P2 and P5 · a rejected tail keeps its adjacent currency and never restarts a token', () => {
  // Third authoring pass, from astra-product-review-04.md and -05.md: a suffix-only currency
  // after an invalid continuation stays on the rejected span, and chained numeric slash
  // segments belong to one rejected span. Rejection is lexical; nothing is evaluated.
  const posting = (id: number, title: string, paragraphs: string[]) => normalizeJob({
    id, title, absolute_url: `https://example.test/quill-ledger/jobs/${id}`,
    content: [NUMBER_FORMAT_INTRO, ...paragraphs].map(paragraph => `<p>${paragraph}</p>`).join(''),
    location: { name: 'London, UK' },
  }, NUMBER_FORMAT_COMPANY.id, NUMBER_FORMAT_TIME)!
  const withoutPay = (job: Job) => {
    const { compensationRanges: _ranges, compensationNote: _note, compensationEvidence: _evidence, ...rest } = job
    return rest
  }

  it.each([
    ['Annual base salary: 84k.5 USD.', '84k.5 USD'],
    ['Annual base salary: 84k,5 USD.', '84k,5 USD'],
    ['Annual base salary: 84k.5USD.', '84k.5USD'],
    ['Annual base salary: 84,000/2/3 USD.', '84,000/2/3 USD'],
    ['Annual base salary: 84,000/2/3USD.', '84,000/2/3USD'],
    ['Annual base salary: USD 84,000/2/3.', 'USD 84,000/2/3'],
    ['Annual base salary: USD 84,000/2/3/4.', 'USD 84,000/2/3/4'],
    ['Annual base salary: 84,000/2/3 USD to USD 126,000.', '84,000/2/3 USD to USD 126,000'],
    ['Annual base salary: USD 84,000/2/3 – USD 126,000/2.', '84,000/2/3 – USD 126,000/2'],
  ])('keeps the whole rejected span with its currency as evidence and rescues no denominator: %s', (text, quote) => {
    evidenceOnly(text, quote)
  })

  it('keeps suffix-currency positives and ordinary terminal punctuation', () => {
    comparable('Annual base salary: 84.5k USD.', 84500, 84500, 'USD')
    comparable('Annual base salary: 84k USD.', 84000, 84000, 'USD')
    comparable('Annual base salary: 84k USD; equity is granted separately.', 84000, 84000, 'USD')
  })

  it('keeps a later valid clause after a rejected suffix-currency tail', () => {
    const pay = parseTextCompensation('Annual base salary: 84k.5 USD. Senior annual base salary: USD 120,000.')
    expect(pay.salary).toBeNull()
    expect(pay.compensationRanges).toEqual([expect.objectContaining({ min: 120000, max: 120000, currency: 'USD', period: 'year' })])
    expect(pay.compensationEvidence).toHaveLength(1)
    expect(pay.compensationEvidence![0].text).toContain('84k.5 USD')
    expect(pay.compensationEvidence![0].text).not.toContain('120,000')
    expect(pay.compensationNote).toBe(NUMBER_FORMAT_NOTES.partial)
  })

  it('replaces a saved version 2 wrong salary with the recovered incomplete evidence while preserving saved metadata', () => {
    const savedAt = '2026-09-28T09:15:00.000Z'
    const note = 'Keep this note while the wrong old amount is replaced'
    const cases: [string, string, string, Job['salary']][] = [
      ['greenhouse-fixture-quill-ledger-suffix-tail', 'Annual base salary: 84k.5 USD.', '84k.5 USD', { min: 84000, max: 84000, currency: 'USD' }],
      ['greenhouse-fixture-quill-ledger-slash-tail', 'Annual base salary: 84,000/2/3 USD.', '84,000/2/3 USD', { min: 3, max: 3, currency: 'USD' }],
    ]
    const records = cases.map(([id, sentence, quote, salary]) => {
      const old: Job = { ...withoutPay(posting(7630, 'Backend Engineer — residual tail fixture', [sentence])), id, compensationVersion: 2, salary }
      expect(formatJobSalary(old)).toContain('이전 기록')
      const kept = upgradeJobCompensation(old, true)
      expect(kept).not.toBe(old)
      expect(kept).toMatchObject({ id, fetchedAt: NUMBER_FORMAT_TIME, description: old.description, salary: null, compensationVersion: COMPENSATION_VERSION, compensationNote: NUMBER_FORMAT_NOTES.none })
      expect(kept.compensationRanges).toBeUndefined()
      expect(kept.compensationEvidence).toHaveLength(1)
      expect(kept.compensationEvidence![0].text).toContain(quote)
      expect(old).toMatchObject({ compensationVersion: 2, salary })
      return { job: old, company: NUMBER_FORMAT_COMPANY, savedAt, status: 'applied', note }
    })
    const decoded = decodeSavedJobs(JSON.stringify(records))
    expect(decoded.omitted).toBe(0)
    expect(decoded.records).toHaveLength(2)
    for (const [index, [id, , quote]] of cases.entries()) {
      const item = decoded.records[index]
      expect(item).toMatchObject({ savedAt, status: 'applied', note })
      expect(item.job).toMatchObject({ id, fetchedAt: NUMBER_FORMAT_TIME, salary: null, compensationVersion: COMPENSATION_VERSION, compensationNote: NUMBER_FORMAT_NOTES.none })
      expect(item.job.compensationRanges).toBeUndefined()
      expect(item.job.compensationEvidence).toHaveLength(1)
      expect(item.job.compensationEvidence![0].text).toContain(quote)
      expect(formatJobSalary(item.job)).toBe('보상 확인 필요')
    }
  })
})
