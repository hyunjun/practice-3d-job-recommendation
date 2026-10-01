import { describe, expect, it } from 'vitest'
import { normalizeJob } from '../../server/normalize'
import { greenhouseCompensation } from '../../server/greenhouse-compensation'
import type { SalaryData } from '../../shared/compensation'
import { parseTextCompensation } from '../../shared/pay-text'
import { formatCompensation, formatJobSalary } from '../../shared/matching'
import { JobSchema } from '../../shared/schemas'
import type { CompensationRange, Salary } from '../../shared/types'
import { geographicPayText } from '../fixtures/geographic-pay'
import {
  CONTEXT_BOARD_QUOTES, CONTEXT_COMPANY, CONTEXT_INCOMPLETE_RANGES, CONTEXT_NOTES, CONTEXT_SENTENCES, CONTEXT_STRUCTURED_RANGES,
  CONTEXT_TIME, OTHER_SUFFIX, contextBoardRaw, contextPostingRaw,
} from '../fixtures/compensation-context'

// Stage 77 contract: docs/design/compensation-context.md (draft02). Every expected amount,
// unit, basis, note and quote below is a literal from that contract or an existing product
// note. Nothing is computed with the parser; fixtures only build inputs.

function comparable(text: string, min: number, max: number, currency: string) {
  const pay = parseTextCompensation(text)
  expect(pay.salary).toEqual({ min, max, currency })
  expect(pay.compensationRanges).toEqual([expect.objectContaining({ min, max, currency, period: 'year', basis: 'base' })])
  expect(pay.compensationEvidence).toBeUndefined()
  expect(pay.compensationNote).toBeUndefined()
  return pay
}

/** A positively rejected component or change amount with no salary subject amount left. */
function rejectedOnly(text: string, quote: string) {
  const pay = parseTextCompensation(text)
  expect(pay.salary).toBeNull()
  expect(pay.compensationRanges).toBeUndefined()
  expect(pay.compensationEvidence).toHaveLength(1)
  expect(pay.compensationEvidence![0].source).toBe('description')
  expect(pay.compensationEvidence![0].text).toContain(quote)
  expect(pay.compensationNote).toBe(CONTEXT_NOTES.none)
  return pay
}

/** One numeric salary candidate that is visible but not comparable. */
function single(text: string, expected: Partial<CompensationRange>, note: string) {
  const pay = parseTextCompensation(text)
  expect(pay.salary).toBeNull()
  expect(pay.compensationRanges).toEqual([expect.objectContaining(expected)])
  expect(pay.compensationEvidence).toBeUndefined()
  expect(pay.compensationNote).toBe(note)
  return pay
}

const usd: Salary = { min: 100000, max: 120000, currency: 'USD' }

describe('component ownership in either word order', () => {
  it.each([
    [CONTEXT_SENTENCES.bonusOnly, 'signing bonus of USD 25,000'],
    ['Annual base salary is competitive, with an annual bonus of USD 25,000.', 'annual bonus of USD 25,000'],
    [CONTEXT_SENTENCES.benefitsInclude, 'signing bonus of USD 25,000'],
    ['Annual base salary is competitive and the total rewards package includes a USD 25,000 signing bonus.', 'USD 25,000 signing bonus'],
    [CONTEXT_SENTENCES.includesBonusOf, 'signing bonus of USD 20,000'],
    [CONTEXT_SENTENCES.includesBonusPostfix, 'USD 20,000 signing bonus'],
    ['Compensation also includes a signing bonus worth USD 20,000.', 'signing bonus worth USD 20,000'],
    ['Compensation also includes a signing bonus valued at USD 20,000.', 'valued at USD 20,000'],
    ['Compensation also includes a signing bonus amounting to USD 20,000.', 'amounting to USD 20,000'],
    ['Compensation also includes a signing bonus of up to USD 20,000.', 'of up to USD 20,000'],
    ['Compensation also includes a signing bonus worth up to USD 20,000.', 'worth up to USD 20,000'],
    ['Compensation also includes a signing bonus of at least USD 20,000.', 'of at least USD 20,000'],
    ['Compensation also includes a signing bonus of approximately USD 20,000.', 'approximately USD 20,000'],
    ['Compensation also includes a signing bonus of about USD 20,000.', 'about USD 20,000'],
    ['Compensation also includes up to USD 20,000 in signing bonus.', 'up to USD 20,000 in signing bonus'],
    ['We offer a competitive annual base salary and a signing bonus of USD 20,000.', 'signing bonus of USD 20,000'],
    ['We offer a competitive annual base salary plus USD 20,000 signing bonus.', 'USD 20,000 signing bonus'],
    ['Annual base pay\nUSD 20,000 signing bonus', 'USD 20,000 signing bonus'],
    ['Base salary is market-rate, with USD 50,000 in equity.', 'USD 50,000 in equity'],
    ['Compensation also includes a USD 20,000 sign-on bonus.', 'USD 20,000 sign-on bonus'],
    ['Our engineers receive a competitive salary and USD 30,000 in RSUs.', 'USD 30,000 in RSUs'],
    ['Base pay is competitive, with USD 40,000 of stock options.', 'USD 40,000 of stock options'],
  ])('a generic salary phrase never owns a named component amount: %s', (text, quote) => {
    rejectedOnly(text, quote)
  })

  it.each([
    [CONTEXT_SENTENCES.bonusAfterBase],
    [CONTEXT_SENTENCES.postfixBonus],
    ['Annual base salary: USD 100,000–120,000 plus USD 25,000 signing bonus.'],
    ['Annual base salary of USD 100,000–120,000 and a USD 25,000 sign-on bonus.'],
    ['Annual base salary: USD 100,000–120,000, USD 25,000 signing bonus, and equity.'],
    ['Annual base salary: USD 100,000–120,000 base + USD 25,000 bonus.'],
    ['Annual base salary: USD 100,000–120,000 plus a monthly signing bonus of USD 25,000.'],
  ])('keeps exactly the real annual base range comparable beside a named bonus: %s', text => {
    comparable(text, usd.min, usd.max, usd.currency)
  })

  it.each([
    [CONTEXT_SENTENCES.bonusFirst],
    ['Signing bonus of USD 25,000 and annual base salary USD 100,000–120,000.'],
    ['A USD 25,000 signing bonus is offered in addition to the annual base salary of USD 100,000–120,000.'],
  ])('a later explicit salary subject re-establishes base ownership after a bonus clause: %s', text => {
    comparable(text, usd.min, usd.max, usd.currency)
  })

  it('reads a directly attached salary subject after the amount', () => {
    comparable('We offer USD 100,000–120,000 in annual base salary.', usd.min, usd.max, usd.currency)
  })

  it.each([
    ['Annual base salary: USD 100,000–120,000 plus equity.'],
    ['Annual base salary: USD 100,000–120,000, plus bonus.'],
    ['Annual base salary: USD 100,000–120,000 (bonus eligible).'],
    ['Annual base salary: USD 100,000–120,000 + 10% target bonus.'],
    ['Annual base salary: USD 100,000–120,000 before bonus.'],
    ['Annual base salary: USD 100,000–120,000 in base salary.'],
    ['Annual base salary: USD 100,000–120,000. Total compensation may also include equity and bonus.'],
    ['Annual base salary: USD 100,000–120,000. Benefits include a signing bonus of USD 25,000.'],
    ['Annual base salary: USD 100,000–120,000. Our packages include equity and an annual bonus.'],
    ['Annual base salary: USD 100,000–120,000. Equity grant: USD 20,000–40,000 in RSUs.'],
    ['Compensation and Equity\nAnnual base salary: USD 100,000–120,000'],
  ])('a bonus mention without an owned amount never drops the base salary: %s', text => {
    comparable(text, usd.min, usd.max, usd.currency)
  })

  it('an explicitly owned currency heading denominates the bare range below it', () => {
    comparable(CONTEXT_SENTENCES.headingCurrency, usd.min, usd.max, usd.currency)
  })

  it('keeps a total disclosure visible while the included bonus amount stays out of the rows', () => {
    single('Total compensation: USD 200,000 including a USD 20,000 bonus.', { min: 200000, max: 200000, currency: 'USD', basis: 'total' }, CONTEXT_NOTES.basis)
  })
})

describe('exclusion objects, base labels that exclude bonuses, and affirmative inclusion', () => {
  it.each([
    ['Annual base salary (excluding bonus): USD 100,000–120,000.'],
    ['Annual base salary (excluding equity and bonus): USD 100,000–120,000.'],
    ['Annual base salary (this does not include bonus, equity and benefits): USD 100,000–120,000.'],
    ['Annual base salary range (exclusive of commission): USD 100,000–120,000.'],
    ['Annual base salary: USD 100,000–120,000 not including bonus.'],
  ])('a base label that excludes other components still labels base salary: %s', text => {
    comparable(text, usd.min, usd.max, usd.currency)
  })

  it.each([
    ['Annual base salary excludes a USD 25,000 signing bonus.', 'USD 25,000 signing bonus'],
    [CONTEXT_SENTENCES.excludesBonusOf, 'signing bonus of USD 20,000'],
    ['Annual base salary does not include a signing bonus of USD 20,000.', 'signing bonus of USD 20,000'],
    ['Annual base salary excluding a signing bonus of USD 20,000.', 'signing bonus of USD 20,000'],
  ])('a monetary object inside the exclusion belongs to the excluded component in either noun order: %s', (text, quote) => {
    rejectedOnly(text, quote)
  })

  it.each([
    ['Annual base salary excluding bonus: USD 100,000–120,000.'],
    ['Annual base salary exclusive of bonus: USD 100,000–120,000.'],
  ])('an exclusion qualifier without a monetary object keeps the following base amount: %s', text => {
    comparable(text, usd.min, usd.max, usd.currency)
  })

  it.each([
    ['Annual base salary including bonus: USD 100,000–120,000.'],
    ['Annual base salary: USD 100,000–120,000 including bonus.'],
    ['Annual base salary: USD 100,000–120,000, including bonus.'],
    ['Annual base salary: USD 100,000–120,000, inclusive of bonus.'],
    ['Annual base salary: USD 100,000–120,000 (including bonus).'],
    ['Annual base salary including bonuses is USD 100,000–120,000.'],
    ['Annual base salary including bonuses is in the range of USD 100,000–120,000.'],
    ['Annual base salary including bonuses is worth USD 100,000–120,000.'],
    ['Annual base salary including bonuses is valued at USD 100,000–120,000.'],
    ['Annual salary: USD 100,000–120,000 inclusive of commission.'],
    ['Annual on-target earnings (including base salary and commission): USD 100,000–120,000.'],
    ['OTE compensation: USD 100,000–120,000 per year.'],
    ['On-target earnings: USD 100,000–120,000 per year (base salary plus commission).'],
    ['The annual base pay range shown below is inclusive of allowances and may change in the future.\nUSD 100,000–120,000'],
  ])('affirmative inclusion or on-target earnings describing the same amount is total compensation: %s', text => {
    single(text, { min: 100000, max: 120000, currency: 'USD', period: 'year', basis: 'total' }, CONTEXT_NOTES.basis)
  })

  // Paired controls for the composition-parenthesis boundary (execution-correction-resolution-01, F1):
  // the owner's own annual denomination survives a nonmonetary "(including ... and ...)" parenthesis,
  // payment cadence stays below that denomination, a true annual/per-month conflict remains unknown,
  // a separate monetary component never adds a row or supplementary evidence, and a real connector
  // outside the parenthesis still separates an earlier bonus. The basis note applies to every row
  // because a total is reported as non-base before any period wording is considered.
  it.each([
    ['Annual on-target earnings (including base salary and commission): USD 100,000–120,000, paid monthly.', 'year'],
    ['Annual on-target earnings (including base salary and commission): USD 100,000–120,000 per month.', 'unknown'],
    ['Annual on-target earnings (including base salary and commission): USD 100,000–120,000 plus a monthly bonus of USD 25,000.', 'year'],
    ['A USD 25,000 signing bonus and annual on-target earnings (including base salary and commission): USD 100,000–120,000.', 'year'],
  ] as [string, CompensationRange['period']][])('an annual total keeps exactly its own unit signals across a composition parenthesis: %s', (text, period) => {
    single(text, { min: 100000, max: 120000, currency: 'USD', period, basis: 'total' }, CONTEXT_NOTES.basis)
  })

  it.each([
    ['Annual base pay range: USD 100,000–120,000. The total rewards package includes allowances and equity.'],
    ['Your base pay is one part of your total compensation.\nThe base pay for this position ranges from USD 100,000/year to USD 120,000/year.'],
  ])('a separate package statement does not relabel an explicitly base amount: %s', text => {
    comparable(text, usd.min, usd.max, usd.currency)
  })

  it.each([
    ['Annual base salary: USD 100,000–120,000 or CAD 130,000–150,000.', [['USD', 100000, 120000], ['CAD', 130000, 150000]]],
    ['Annual base salary: USD 100,000–120,000 or USD 150,000–180,000.', [['USD', 100000, 120000], ['USD', 150000, 180000]]],
    ['Annual base salary: USD 100,000–120,000 and annual base salary CAD 130,000–150,000.', [['USD', 100000, 120000], ['CAD', 130000, 150000]]],
  ] as [string, [string, number, number][]][])('coordinated salary alternatives keep every annual base row: %s', (text, rows) => {
    const pay = parseTextCompensation(text)
    expect(pay.salary).toBeNull()
    expect(pay.compensationRanges?.map(range => [range.currency, range.min, range.max])).toEqual(rows)
    expect(pay.compensationRanges?.every(range => range.period === 'year' && range.basis === 'base')).toBe(true)
    expect(pay.compensationEvidence).toBeUndefined()
    expect(pay.compensationNote).toBe(CONTEXT_NOTES.variants)
  })

  it('a malformed coordinated alternative still blocks completeness beside the valid row', () => {
    const pay = parseTextCompensation('Annual base salary: USD 100,000–120,000 or USD 84,00–126,000.')
    expect(pay.salary).toBeNull()
    expect(pay.compensationRanges).toEqual([expect.objectContaining({ ...usd, period: 'year', basis: 'base' })])
    expect(pay.compensationEvidence).toHaveLength(1)
    expect(pay.compensationEvidence![0].text).toContain('84,00–126,000')
    expect(pay.compensationNote).toBe(CONTEXT_NOTES.partial)
  })
})

describe('conflicting direct owners, review labels and change amounts', () => {
  it('a generic salary label yields to the explicit bonus owner', () => {
    rejectedOnly('Salary: USD 20,000 (signing bonus).', 'USD 20,000 (signing bonus)')
  })

  it('two equally direct incompatible owners stay a numeric unknown-basis, unknown-period candidate', () => {
    single('Annual base salary: USD 20,000 signing bonus.', { min: 20000, max: 20000, currency: 'USD', period: 'unknown', basis: 'unknown' }, CONTEXT_NOTES.basis)
  })

  it.each([
    [CONTEXT_SENTENCES.reviewLabel],
    ['Annual salary reviews\nUSD 100,000–120,000'],
  ])('a review label establishes an unresolved compensation topic, not annual base pay: %s', text => {
    single(text, { min: 100000, max: 120000, currency: 'USD', period: 'unknown', basis: 'unknown' }, CONTEXT_NOTES.basis)
  })

  it('a separate explicit base-salary subject stays base when review prose appears nearby', () => {
    single('COMPENSATION\nAnnual salary reviews reflect contribution.\nBase salary: USD 120,000–180,000', { min: 120000, max: 180000, currency: 'USD', period: 'unknown', basis: 'base' }, CONTEXT_NOTES.periodUnknown)
  })

  it.each([
    ['Annual salary increase: USD 5,000.', 'USD 5,000'],
    ['Salary increased by USD 5,000 after probation.', 'USD 5,000'],
  ])('the size of a change is not the salary: %s', (text, quote) => {
    rejectedOnly(text, quote)
  })

  it('distinguishes an adjustment cadence from an adjusted-to base amount', () => {
    single('Base salary adjusted annually to USD 120,000.', { min: 120000, max: 120000, currency: 'USD', period: 'unknown', basis: 'base' }, CONTEXT_NOTES.periodUnknown)
    comparable('Annual base salary adjusted to USD 120,000.', 120000, 120000, 'USD')
  })

  it.each([
    'Signing bonus: USD 20,000.',
    CONTEXT_SENTENCES.benefitsBonus,
    'We raised USD 100,000,000 in funding.',
  ])('an amount with no salary subject is not an apparent compensation disclosure: %s', text => {
    expect(parseTextCompensation(text)).toEqual({ salary: null })
  })

  // Evidence eligibility for an independently bounded bonus clause after a competitive-salary
  // statement is pinned to Fable's design-review-02 clarification: the salary subject must apply
  // in the same clause or through an applicable heading. These clauses are separated by a
  // sentence or semicolon boundary, so no public quote or note is emitted. The bonus amount
  // never becomes base either way. This reading is submitted for explicit all3 agreement.
  it.each([
    ['Annual base salary is competitive; signing bonus: USD 20,000.'],
    ['Annual base salary is competitive; Signing bonus: USD 20,000.'],
    ['We offer a competitive annual base salary. signing bonus: USD 20,000.'],
    ['We offer a competitive annual base salary. Signing bonus: USD 20,000.'],
  ])('an independently bounded bonus clause after a salary statement yields neither base nor public evidence: %s', text => {
    expect(parseTextCompensation(text)).toEqual({ salary: null })
  })
})

describe('four amount-unit tiers: denomination before payment cadence, cadence never a unit', () => {
  it.each([
    [CONTEXT_SENTENCES.reviewedAnnually, 130000, 170000],
    ['Base salary: USD 120,000–180,000 with annual salary reviews.', 120000, 180000],
    ['Base salary: USD 120,000–180,000, adjusted annually.', 120000, 180000],
    ['Base salary: USD 120,000–180,000; salary is reviewed each year.', 120000, 180000],
    ['Base salary: USD 120,000–180,000 with annual performance reviews and merit increases.', 120000, 180000],
    ['Base salary: USD 120,000–180,000 with monthly salary reviews.', 120000, 180000],
    ['Base salary: USD 120,000–180,000 with 25 days of vacation per year.', 120000, 180000],
  ] as [string, number, number][])('a review, adjustment or benefit cadence supplies no unit: %s', (text, min, max) => {
    single(text, { min, max, currency: 'USD', period: 'unknown', basis: 'base' }, CONTEXT_NOTES.periodUnknown)
  })

  it.each([
    ['Annual base salary: USD 100,000–120,000, reviewed monthly.', 100000, 120000],
    ['Base salary: USD 120,000–180,000 per year, reviewed monthly.', 120000, 180000],
    ['Annual base salary: USD 100,000–120,000 paid monthly.', 100000, 120000],
    ['Base salary: USD 120,000–180,000, paid annually.', 120000, 180000],
    ['Annual base salary: USD 120,000–180,000, reviewed annually.', 120000, 180000],
    ['Base salary: USD 120,000–180,000 per annum with annual increases.', 120000, 180000],
    ['Base salary: USD 120,000–180,000 a year.', 120000, 180000],
    ['Annual base salary: USD 120,000–180,000 with 25 days of vacation per year.', 120000, 180000],
    ['Annual base salary\nUSD 120,000–180,000 paid monthly', 120000, 180000],
    ['Annual Base Salary Range:\nUSD 120,000–180,000', 120000, 180000],
    ['Salary (annual, gross):\nUSD 120,000–150,000', 120000, 150000],
    ['Base Pay Range (Annual)\nUSD 120,000–150,000', 120000, 150000],
    ['Annual base salary: USD 100,000–120,000, paid in 12 monthly payments.', 100000, 120000],
  ] as [string, number, number][])('an explicit annual denomination survives cadence and installment wording: %s', (text, min, max) => {
    comparable(text, min, max, 'USD')
  })

  it.each([
    ['Base salary: USD 8,000 per month and reviewed annually.', 8000, 8000],
    ['Monthly base salary: USD 12,000–15,000, adjusted annually.', 12000, 15000],
    ['Base salary: USD 5,000 per month, reviewed annually.', 5000, 5000],
    ['Base salary: USD 100,000–120,000, reviewed annually and paid monthly.', 100000, 120000],
    ['Base salary: USD 100,000–120,000, paid in twelve monthly instalments.', 100000, 120000],
  ] as [string, number, number][])('an explicit monthly denomination or installment predicate keeps month without annualizing: %s', (text, min, max) => {
    single(text, { min, max, currency: 'USD', period: 'month', basis: 'base' }, CONTEXT_NOTES.notAnnual)
  })

  it('keeps an hourly base rate when weekly hours are stated', () => {
    single('Hourly base pay: USD 55–65, 40 hours per week.', { min: 55, max: 65, currency: 'USD', period: 'hour', basis: 'base' }, CONTEXT_NOTES.notAnnual)
  })

  it.each([
    ['Monthly base salary: USD 8,000 per year.', 8000, 8000],
    ['Annual base salary\nUSD 120,000–180,000 per year or per month', 120000, 180000],
    ['Annual monthly base salary: USD 100,000–120,000.', 100000, 120000],
  ] as [string, number, number][])('conflicting explicit units remain unknown and a heading cannot resolve them: %s', (text, min, max) => {
    single(text, { min, max, currency: 'USD', period: 'unknown', basis: 'base' }, CONTEXT_NOTES.periodUnknown)
  })

  it('resolves each amount in one line with its own unit', () => {
    const pay = parseTextCompensation('Base salary USD 120,000–180,000 per year and base salary EUR 5,000–7,000 per month.')
    expect(pay.salary).toBeNull()
    expect(pay.compensationRanges?.map(range => [range.currency, range.min, range.max, range.period])).toEqual([
      ['USD', 120000, 180000, 'year'], ['EUR', 5000, 7000, 'month'],
    ])
    expect(pay.compensationNote).toBe(CONTEXT_NOTES.variants)
  })
})

describe('context boundaries: line endings, capitalization, abbreviations and intervening sections', () => {
  it.each([
    ['LF', 'Base salary: USD 120,000–180,000\nAnnual salary reviews reflect contribution.'],
    ['CRLF', 'Base salary: USD 120,000–180,000\r\nAnnual salary reviews reflect contribution.'],
    ['CR', 'Base salary: USD 120,000–180,000\rAnnual salary reviews reflect contribution.'],
  ])('a following review line lends no unit across %s', (_name, text) => {
    single(text, { min: 120000, max: 180000, currency: 'USD', period: 'unknown', basis: 'base' }, CONTEXT_NOTES.periodUnknown)
  })

  it.each([
    ['Annual base salary: USD 100,000–120,000; signing bonus: USD 25,000.'],
    ['Annual base salary: USD 100,000–120,000; Signing bonus: USD 25,000.'],
    ['Annual base salary: USD 100,000–120,000. signing bonus: USD 25,000.'],
    ['Annual base salary: USD 100,000–120,000. Signing bonus: USD 25,000.'],
  ])('sentence and semicolon boundaries keep the base row regardless of capitalization: %s', text => {
    comparable(text, usd.min, usd.max, usd.currency)
  })

  it('protects bounded abbreviations from splitting the salary clause', () => {
    comparable('Annual base salary: USD 120,000 p.a. plus a USD 20,000 signing bonus.', 120000, 120000, 'USD')
    const scoped = parseTextCompensation('For U.S. based hires: Annual base salary USD 136,000–187,000.')
    expect(scoped.salary).toBeNull()
    expect(scoped.compensationRanges).toEqual([expect.objectContaining({ min: 136000, max: 187000, currency: 'USD', period: 'year', basis: 'base' })])
    expect(scoped.compensationRanges![0].scope).toContain('U.S. based hires')
    expect(scoped.compensationNote).toBe(CONTEXT_NOTES.scoped)
    const kingdom = parseTextCompensation('For U.K. based hires: Annual base salary GBP 70,000–90,000.')
    expect(kingdom.salary).toBeNull()
    expect(kingdom.compensationRanges).toEqual([expect.objectContaining({ min: 70000, max: 90000, currency: 'GBP', period: 'year', basis: 'base' })])
    expect(kingdom.compensationRanges![0].scope).toContain('U.K. based hires')
  })

  it.each([
    ['alone', CONTEXT_SENTENCES.dcScope],
    ['with a heading line', `Compensation may differ by work location.\n${CONTEXT_SENTENCES.dcScope}`],
    ['before a lowercase bonus sentence', `${CONTEXT_SENTENCES.dcScope} signing bonus: USD 20,000.`],
    ['before an uppercase bonus sentence', `${CONTEXT_SENTENCES.dcScope} Signing bonus: USD 20,000.`],
  ])('a D.C. geographic qualifier keeps its label, quote and scope and the sentence still ends later: %s', (_name, text) => {
    const pay = parseTextCompensation(text)
    expect(pay.salary).toBeNull()
    expect(pay.compensationRanges).toEqual([expect.objectContaining({ min: 112000, max: 146000, currency: 'USD', period: 'year', basis: 'base' })])
    const range = pay.compensationRanges![0]
    expect(range.label).toContain('For Washington D.C. based hires')
    expect(range.scope).toContain('Washington D.C. based hires')
    expect(range.evidence?.text).toContain(CONTEXT_SENTENCES.dcScope)
    expect(range.evidence?.text).not.toContain('20,000')
    expect(pay.compensationNote).toBe(CONTEXT_NOTES.scoped)
  })

  it('stops heading inheritance at an intervening benefits section and never splices the quote across it', () => {
    const pay = parseTextCompensation('Annual base salary\nBENEFITS\nBase salary: USD 120,000–180,000')
    expect(pay.salary).toBeNull()
    expect(pay.compensationRanges).toEqual([expect.objectContaining({ min: 120000, max: 180000, currency: 'USD', period: 'unknown', basis: 'base' })])
    const quote = pay.compensationRanges![0].evidence!.text
    expect(quote).toContain('Base salary: USD 120,000–180,000')
    expect(quote.includes('Annual base salary') && !quote.includes('BENEFITS')).toBe(false)
  })

  it('a bare bonus amount under an intervening benefits heading is not salary', () => {
    expect(parseTextCompensation('Annual base salary\nBenefits\nUSD 20,000 signing bonus')).toEqual({ salary: null })
  })

  // H1 (historical-correction-resolution-01): the period of a word-bounded "Sr." abbreviation is not a
  // sentence boundary, so the role qualifier stays in the label and in the owned source quote. Bare
  // dollars never become USD, a heading-only context leaves the basis unknown and the salary null, and
  // the quote is joined with LF whatever the input line ending.
  const seniorRow = { min: 140000, max: 190000, currency: null, period: 'year', basis: 'unknown' } as const
  it.each([
    ['LF with a trailing heading space', CONTEXT_SENTENCES.seniorHeading, 'Pay range:', 'Sr.'],
    ['CRLF', 'Pay range:\r\nSr. Orbit Systems Engineer: $140,000.00 - $190,000.00/per year', 'Pay range:', 'Sr.'],
    ['CR', 'Pay range:\rSr. Orbit Systems Engineer: $140,000.00 - $190,000.00/per year', 'Pay range:', 'Sr.'],
    ['blank line and capitalised heading', 'Pay Range:\n\nSr. Orbit Systems Engineer: $140,000.00 - $190,000.00/per year', 'Pay Range:', 'Sr.'],
    ['upper-case abbreviation', 'Pay range:\nSR. Orbit Systems Engineer: $140,000.00 - $190,000.00/per year', 'Pay range:', 'SR.'],
    ['lower-case abbreviation', 'Pay range:\nsr. Orbit Systems Engineer: $140,000.00 - $190,000.00/per year', 'Pay range:', 'sr.'],
  ])('a pay heading above a Sr. role line keeps the qualifier in the label and the LF-joined quote: %s', (_name, text, heading, prefix) => {
    const pay = parseTextCompensation(text)
    expect(pay.salary).toBeNull()
    expect(pay.compensationRanges).toEqual([{
      label: `${prefix} Orbit Systems Engineer`, ...seniorRow,
      evidence: { source: 'description', text: `${heading}\n${prefix} Orbit Systems Engineer: $140,000.00 - $190,000.00/per year` },
    }])
    expect(pay.compensationEvidence).toBeUndefined()
    expect(pay.compensationNote).toBe(CONTEXT_NOTES.basis)
  })

  it.each([
    ['explicit annual base heading above the role line', CONTEXT_SENTENCES.seniorBaseHeading, 'Sr. Orbit Systems Engineer'],
    ['abbreviation inside the owning phrase', CONTEXT_SENTENCES.seniorInlineBase, 'Annual base salary for a Sr. Orbit Systems Engineer'],
  ])('an annual base amount keeps its Sr. role label and its complete source: %s', (_name, text, label) => {
    const pay = comparable(text, usd.min, usd.max, usd.currency)
    expect(pay.compensationRanges).toEqual([{ label, ...usd, period: 'year', basis: 'base', evidence: { source: 'description', text } }])
  })

  it.each([
    ['a full stop', CONTEXT_SENTENCES.seniorBonusSentence],
    ['a semicolon', CONTEXT_SENTENCES.seniorBonusSemicolon],
    ['the bonus sentence first', CONTEXT_SENTENCES.seniorBonusFirst],
  ])('a real boundary still separates a Sr. bonus clause from the base range: %s', (_name, text) => {
    const pay = comparable(text, usd.min, usd.max, usd.currency)
    expect(pay.compensationRanges![0].label).toBe('Annual base salary')
    expect(pay.compensationRanges![0].evidence!.text).not.toContain('25,000')
  })

  it('an earlier competitive-salary sentence lends no public evidence to a separate Sr. bonus clause (R01)', () => {
    expect(parseTextCompensation(CONTEXT_SENTENCES.seniorRejectionOnly)).toEqual({ salary: null })
  })
})

describe('currency belongs to the owning component', () => {
  it('a bonus currency cannot denominate an ambiguous base symbol', () => {
    const pay = single(CONTEXT_SENTENCES.currencyLeak, { min: 120000, max: 180000, currency: null, period: 'year', basis: 'base' }, CONTEXT_NOTES.currency)
    expect(formatCompensation(pay.compensationRanges![0])).toBe('통화 미확인 120,000–180,000 / 년')
  })

  it('an explicit marker on the base range remains its currency', () => {
    comparable('Annual base salary: $120,000–$180,000 USD plus a signing bonus of CAD 20,000.', 120000, 180000, 'USD')
  })

  it('an immediate annual heading above a same-band reference yields one scoped CAD row and no reference row', () => {
    const pay = parseTextCompensation(CONTEXT_SENTENCES.headingReference)
    expect(pay.salary).toBeNull()
    expect(pay.compensationRanges).toEqual([expect.objectContaining({ scope: 'Canada', min: 120000, max: 180000, currency: 'CAD', period: 'year', basis: 'base' })])
    expect(pay.compensationRanges![0].evidence?.text).toContain('accomplished: ~$145,000 CAD')
    expect(pay.compensationEvidence).toBeUndefined()
    expect(pay.compensationNote).toBe(CONTEXT_NOTES.scoped)
  })

  it('preserves the same-band geographic reference as denomination context without a second salary', () => {
    const pay = parseTextCompensation(geographicPayText)
    expect(pay.salary).toBeNull()
    expect(pay.compensationRanges).toMatchObject([
      { scope: 'Canada', min: 120000, max: 180000, currency: 'CAD', period: 'unknown', basis: 'base' },
      { scope: 'United States', min: 110000, max: 165000, currency: 'USD', period: 'unknown', basis: 'base' },
    ])
    for (const range of pay.compensationRanges!) {
      expect(range.evidence?.text).toContain('accomplished:')
      expect(range.evidence?.text).not.toContain('company was valued')
    }
  })
})

describe('structured other components and the annual-base comparison gate', () => {
  const base = { title: 'Annual base salary', min_cents: 10000000, max_cents: 12000000, currency_type: 'USD', blurb: 'Paid in twelve monthly installments.' }
  const bonus = { title: 'Signing bonus', min_cents: 2500000, max_cents: 2500000, currency_type: 'USD', blurb: 'We also offer a competitive annual base salary.' }
  const otherRow = { label: 'Signing bonus', min: 25000, max: 25000, currency: 'USD', period: 'unknown', basis: 'other' }

  function expectBase(pay: SalaryData) {
    expect(pay.salary).toEqual(usd)
    expect(pay.compensationRanges![0]).toMatchObject({ label: 'Annual base salary', ...usd, period: 'year', basis: 'base' })
  }

  it('compares exactly the base amount and shows the bonus as an other row without an annual unit', () => {
    const pay = greenhouseCompensation('', [base, bonus])
    expectBase(pay)
    expect(pay.compensationRanges).toHaveLength(2)
    expect(pay.compensationRanges![1]).toMatchObject(otherRow)
    expect(pay.compensationRanges![1].evidence).toEqual({ source: 'board', text: 'Signing bonus\nWe also offer a competitive annual base salary.' })
    expect(pay.compensationEvidence).toBeUndefined()
    expect(pay.compensationNote).toBeUndefined()
    expect(formatCompensation(pay.compensationRanges![1])).toBe(`USD 25,000–25,000 / 기간 미확인${OTHER_SUFFIX}`)
  })

  it('other metadata in another currency and scope never changes the base metadata or its comparison', () => {
    const pay = greenhouseCompensation('', [base, { title: 'Relocation bonus', min_cents: 500000, max_cents: 500000, currency_type: 'CAD', blurb: 'For Canada based hires.' }])
    expectBase(pay)
    expect(pay.compensationRanges![0].scope).toBeUndefined()
    expect(pay.compensationRanges![1]).toMatchObject({ label: 'Relocation bonus', min: 5000, max: 5000, currency: 'CAD', basis: 'other' })
    expect(pay.compensationRanges![1].scope).toContain('Canada based hires')
    expect(pay.compensationNote).toBeUndefined()
  })

  it('shows an other-only structured disclosure without any annual base salary', () => {
    const pay = greenhouseCompensation('', [bonus])
    expect(pay.salary).toBeNull()
    expect(pay.compensationRanges).toEqual([expect.objectContaining(otherRow)])
    expect(pay.compensationNote).toBe(CONTEXT_NOTES.other)
  })

  it('a valid base plus an invalid other amount keeps the base comparison and the other quote', () => {
    const pay = greenhouseCompensation('', [base, { ...bonus, min_cents: undefined }])
    expectBase(pay)
    expect(pay.compensationRanges).toHaveLength(1)
    expect(pay.compensationEvidence).toEqual([{ source: 'board', text: 'Signing bonus\nWe also offer a competitive annual base salary.' }])
    expect(pay.compensationNote).toBe(CONTEXT_NOTES.incompleteOther)
  })

  it('an invalid base plus a valid other keeps the salary evidence, the other row and the incomplete-salary note', () => {
    const pay = greenhouseCompensation('', [{ ...base, min_cents: undefined }, bonus])
    expect(pay.salary).toBeNull()
    expect(pay.compensationRanges).toEqual([expect.objectContaining(otherRow)])
    expect(pay.compensationEvidence).toEqual([{ source: 'board', text: 'Annual base salary\nPaid in twelve monthly installments.' }])
    expect(pay.compensationNote).toBe(CONTEXT_NOTES.partial)
  })

  it('a valid base plus a total disclosure keeps the existing conservative exclusion', () => {
    const pay = greenhouseCompensation('', [base, { title: 'Annual total compensation', min_cents: 15000000, max_cents: 18000000, currency_type: 'USD' }])
    expect(pay.salary).toBeNull()
    expect(pay.compensationRanges?.map(range => range.basis)).toEqual(['base', 'total'])
    expect(pay.compensationNote).toBe(CONTEXT_NOTES.variants)
  })

  it('a valid base plus an unknown-composition salary disclosure also stays excluded', () => {
    const pay = greenhouseCompensation('', [base, { title: 'Compensation range', min_cents: 13000000, max_cents: 15000000, currency_type: 'USD' }])
    expect(pay.salary).toBeNull()
    expect(pay.compensationRanges?.map(range => [range.basis, range.min, range.max])).toEqual([['base', 100000, 120000], ['unknown', 130000, 150000]])
    expect(pay.compensationNote).toBe(CONTEXT_NOTES.variants)
  })

  it('fresh history A and B differ only by an unquoted unresolved item, which keeps B incomplete', () => {
    const quotedInvalidBonus = { title: 'Signing bonus', max_cents: 2500000, currency_type: 'USD' }
    const plain = { title: 'Annual base salary', min_cents: 10000000, max_cents: 12000000, currency_type: 'USD' }
    const historyA = greenhouseCompensation('', [plain, quotedInvalidBonus])
    expect(historyA.salary).toEqual(usd)
    expect(historyA.compensationRanges).toEqual([expect.objectContaining({ label: 'Annual base salary', ...usd, period: 'year', basis: 'base' })])
    expect(historyA.compensationEvidence).toEqual([{ source: 'board', text: 'Signing bonus' }])
    expect(historyA.compensationNote).toBe(CONTEXT_NOTES.incompleteOther)
    const historyB = greenhouseCompensation('', [plain, quotedInvalidBonus, { max_cents: 3000000, currency_type: 'USD' }])
    expect(historyB.salary).toBeNull()
    expect(historyB.compensationRanges).toEqual([expect.objectContaining({ label: 'Annual base salary', ...usd, period: 'year', basis: 'base' })])
    expect(historyB.compensationEvidence).toEqual([{ source: 'board', text: 'Signing bonus' }])
    expect(historyB.compensationNote).toBe(CONTEXT_NOTES.partial)
  })

  it.each([
    ['text beyond the input bound', `Annual base salary: USD 100,000–120,000.\n${'Further role details follow here. '.repeat(3200)}`],
    ['more monetary mentions than the bound', `Annual base salary: USD 100,000–120,000.\n${'Budget line item: USD 1,000.\n'.repeat(101)}`],
  ])('unprocessed input still blocks a completeness claim: %s', (_name, text) => {
    const pay = parseTextCompensation(text)
    expect(pay.salary).toBeNull()
    expect(pay.compensationRanges![0]).toMatchObject({ ...usd, period: 'year', basis: 'base' })
    expect(pay.compensationNote).toBe(CONTEXT_NOTES.partial)
  })

  it.each([
    ['Salary Range', 'Base salary is reviewed annually.', 'unknown'],
    ['Annual base salary', 'Base salary is reviewed monthly.', 'year'],
    ['Salary Range', 'Base salary is paid monthly and reviewed annually.', 'month'],
    ['Salary Range', 'The base salary is paid monthly. Equity vests annually.', 'month'],
    ['Base salary', 'Base salary is paid monthly. Equity is awarded annually.', 'month'],
    ['Base salary', 'Bonus compensation is paid annually.', 'unknown'],
    ['Base salary', 'Bonus is paid annually.', 'unknown'],
    ['Annual base salary', 'Salary reviews occur monthly.', 'year'],
    ['Annual base salary', 'Monthly salary reviews.', 'year'],
    ['Annual base salary', 'Salary reviews occur monthly.\nEquity vests annually.', 'year'],
    // A unit that directly modifies installments or payments is payment cadence, below the
    // title's denomination; without a denomination that cadence is the only usable unit.
    ['Annual base salary', 'Paid in twelve monthly installments.', 'year'],
    ['Annual base salary', 'Paid in 12 monthly payments.', 'year'],
    ['Annual base salary', 'Paid in twelve monthly instalments.', 'year'],
    ['Annual base salary', 'Paid monthly.', 'year'],
    ['Annual base salary', 'A signing bonus is paid monthly.', 'year'],
    ['Base salary', 'Paid in twelve monthly installments.', 'month'],
    ['Monthly base salary', 'Paid monthly.', 'month'],
  ])('reads the board period from the owner, not from another component or cadence: %s + %s', (title, blurb, period) => {
    const pay = greenhouseCompensation('', [{ title, min_cents: 10000000, max_cents: 12000000, currency_type: 'USD', blurb }])
    expect(pay.compensationRanges).toEqual([expect.objectContaining({ label: title, ...usd, period, basis: 'base' })])
    expect(pay.salary).toEqual(period === 'year' ? usd : null)
  })

  it.each([
    ['Annual base salary: USD 100,000–120,000\nSalary reviews occur monthly.'],
    ['Annual base salary\nUSD 100,000–120,000\nSalary reviews occur monthly.'],
  ])('a following monthly review line never changes an annual salary in text either: %s', text => {
    comparable(text, usd.min, usd.max, usd.currency)
  })

  it('an affirmative same-amount inclusion blurb makes a titled base range total, a package sentence does not', () => {
    const included = greenhouseCompensation('', [{ title: 'Annual base salary', min_cents: 10000000, max_cents: 12000000, currency_type: 'USD', blurb: 'This salary range includes bonus and commission.' }])
    expect(included.salary).toBeNull()
    expect(included.compensationRanges).toEqual([expect.objectContaining({ ...usd, period: 'year', basis: 'total' })])
    expect(included.compensationNote).toBe(CONTEXT_NOTES.basis)
    const packaged = greenhouseCompensation('', [{ title: 'Annual base salary', min_cents: 10000000, max_cents: 12000000, currency_type: 'USD', blurb: 'The total rewards package may also include equity and bonus.' }])
    expect(packaged.salary).toEqual(usd)
    expect(packaged.compensationRanges).toEqual([expect.objectContaining({ ...usd, period: 'year', basis: 'base' })])
  })

  it('a conditional sales-role composition sentence does not relabel a titled annual salary; the unconditional form does', () => {
    const conditional = greenhouseCompensation('', [{
      title: 'Annual Salary', min_cents: 10000000, max_cents: 12000000, currency_type: 'USD',
      blurb: 'The annual pay range for this role appears below. For sales roles, the range shown is the on-target earnings and includes both the commission target and the annual base salary.',
    }])
    expect(conditional.salary).toEqual(usd)
    expect(conditional.compensationRanges).toEqual([expect.objectContaining({ label: 'Annual Salary', ...usd, period: 'year', basis: 'base' })])
    const unconditional = greenhouseCompensation('', [{
      title: 'Annual Salary', min_cents: 10000000, max_cents: 12000000, currency_type: 'USD',
      blurb: 'The range shown is the on-target earnings and includes both the commission target and the annual base salary.',
    }])
    expect(unconditional.salary).toBeNull()
    expect(unconditional.compensationRanges).toEqual([expect.objectContaining({ ...usd, period: 'year', basis: 'total' })])
  })

  it('a commission component with its own payment cadence is other with its own month', () => {
    const pay = greenhouseCompensation('', [base, { title: 'Commission', min_cents: 1000000, max_cents: 2000000, currency_type: 'USD', blurb: 'Commission is paid monthly.' }])
    expectBase(pay)
    expect(pay.compensationRanges![1]).toMatchObject({ label: 'Commission', min: 10000, max: 20000, currency: 'USD', period: 'month', basis: 'other' })
    expect(pay.compensationNote).toBeUndefined()
  })

  it('a native second board item without title, blurb or bounds keeps the base row and blocks completeness', () => {
    const job = normalizeJob(contextBoardRaw(7712, 'Backend Engineer — incomplete board item fixture', CONTEXT_INCOMPLETE_RANGES), CONTEXT_COMPANY.id, CONTEXT_TIME)!
    expect(job.salary).toBeNull()
    expect(job.compensationRanges).toEqual([expect.objectContaining({ label: 'Annual base salary', ...usd, period: 'year', basis: 'base' })])
    expect(job.compensationEvidence).toBeUndefined()
    expect(job.compensationNote).toBe(CONTEXT_NOTES.partial)
    expect(formatJobSalary(job)).toBe('별도 보상 조건')
    expect(JobSchema.safeParse(job).success).toBe(true)
  })

  it('normalizes a full posting with base and other rows into a schema-valid comparable job', () => {
    const job = normalizeJob(contextPostingRaw('structured'), CONTEXT_COMPANY.id, CONTEXT_TIME)!
    expect(job.salary).toEqual(usd)
    expect(job.compensationRanges).toHaveLength(2)
    expect(job.compensationRanges![1]).toMatchObject(otherRow)
    expect(job.compensationNote).toBeUndefined()
    expect(JobSchema.safeParse(job).success).toBe(true)
    expect(formatJobSalary(job)).toBe('$100–120k')
    expect(CONTEXT_STRUCTURED_RANGES).toHaveLength(2)
  })
})

describe('real-corpus-shaped structured controls rewritten as fictional text', () => {
  // Grammatical structure only: a generic compensation noun followed by a separate annual
  // performance bonus. Amounts and boilerplate are invented, not copied from any posting.
  const programBlurb = 'Pay Transparency Note\n\nThe range below is the anticipated base salary range for non-commissionable positions. The total compensation package for this position may additionally include eligibility for an annual performance bonus, equity, and the benefits described above.'

  it('a separate annual performance bonus program does not supply the amount period', () => {
    const pay = greenhouseCompensation('', [{ title: 'Local Pay Range', min_cents: 14830000, max_cents: 20465000, currency_type: 'USD', blurb: programBlurb }])
    expect(pay.salary).toBeNull()
    expect(pay.compensationRanges).toEqual([expect.objectContaining({ label: 'Local Pay Range', min: 148300, max: 204650, currency: 'USD', period: 'unknown' })])
  })

  it('an explicit hourly title keeps hour despite the annual bonus program sentence', () => {
    const pay = greenhouseCompensation('', [{ title: 'Harbor District Hourly Rate', min_cents: 5200, max_cents: 6100, currency_type: 'USD', blurb: programBlurb }])
    expect(pay.salary).toBeNull()
    expect(pay.compensationRanges).toEqual([expect.objectContaining({ label: 'Harbor District Hourly Rate', min: 52, max: 61, currency: 'USD', period: 'hour', basis: 'base' })])
  })

  it('a discretionary annual bonus program beside a base range remains unknown-period base pay', () => {
    const pay = greenhouseCompensation('', [{
      title: 'Salary Range', min_cents: 16800000, max_cents: 20900000, currency_type: 'USD',
      blurb: 'The anticipated base salary range for this full-time role appears below. Team members may also take part in a discretionary annual bonus program, an equity incentive plan and the benefits package, subject to eligibility rules.',
    }])
    expect(pay.salary).toBeNull()
    expect(pay.compensationRanges).toEqual([expect.objectContaining({ min: 168000, max: 209000, currency: 'USD', period: 'unknown', basis: 'base' })])
  })

  it.each([
    ['Pay range\n$120,000–$150,000', 'unknown'],
    ['Pay range:\n$120,000.00 - $150,000.00/per year', 'year'],
  ])('a generic pay-range heading over a bare dollar range keeps the numbers with unknown currency and composition: %s', (text, period) => {
    const pay = parseTextCompensation(text)
    expect(pay.salary).toBeNull()
    expect(pay.compensationRanges).toEqual([expect.objectContaining({ min: 120000, max: 150000, currency: null, period, basis: 'unknown' })])
    expect(pay.compensationEvidence).toBeUndefined()
  })

  it('a negated-include base label is base pay, still scoped, unknown period and not comparable', () => {
    const pay = greenhouseCompensation('', [{ title: 'The US base salary range for this position (this does not include bonus, equity and benefits):', min_cents: 12000000, max_cents: 16000000, currency_type: 'USD' }])
    expect(pay.salary).toBeNull()
    expect(pay.compensationRanges).toEqual([expect.objectContaining({ min: 120000, max: 160000, currency: 'USD', period: 'unknown', basis: 'base' })])
    expect(pay.compensationRanges![0].scope).toBeDefined()
  })

  it('a stored board quote reproduces the contract examples through the same title and blurb text', () => {
    expect(CONTEXT_BOARD_QUOTES.reviewedAnnually).toBe('Salary Range\nBase salary is reviewed annually.')
    const pay = greenhouseCompensation('', [{ title: 'Salary Range', min_cents: 10000000, max_cents: 12000000, currency_type: 'USD', blurb: 'Base salary is reviewed annually.' }])
    expect(pay.compensationRanges![0].evidence).toEqual({ source: 'board', text: CONTEXT_BOARD_QUOTES.reviewedAnnually })
  })
})
