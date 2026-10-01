import { describe, expect, it } from 'vitest'
import { HimalayasJobSchema, normalizeHimalayasJob } from '../../server/providers/himalayas'
import { normalizeAshbyJob } from '../../server/providers/ashby'
import { normalizeLeverJob } from '../../server/providers/lever'
import { upgradeJobCompensation } from '../../shared/job-compensation'
import { JobSchema } from '../../shared/schemas'
import { COMPENSATION_VERSION } from '../../shared/types'
import type { Job } from '../../shared/types'
import { ashbyPosting, leverPosting } from '../fixtures/public-postings'
import {
  CONTEXT_ASHBY_COMPANY, CONTEXT_COMPANY, CONTEXT_INTRO, CONTEXT_LEGACY_PAY, CONTEXT_NOTES, CONTEXT_SENTENCES, CONTEXT_TIME,
  quillAtlasHimalayasRaw,
} from '../fixtures/compensation-context'

// Stage 77 contract, "Rejection evidence and Himalayas source selection": the body wins
// whenever it contains an actual salary disclosure of any validity; a rejection-only body
// permits the structured API fallback with unknown basis; discarded API fields are never
// invented for an old normalized record.

const normalize = (description: string, overrides: Record<string, unknown> = {}) => normalizeHimalayasJob(
  HimalayasJobSchema.parse(quillAtlasHimalayasRaw({ description: `<p>${CONTEXT_INTRO}</p><p>${description}</p>`, ...overrides })),
  CONTEXT_COMPANY.id, CONTEXT_TIME,
)!
const apiRow = { min: 150000, max: 180000, currency: 'USD', period: 'year', basis: 'unknown' }
const usesApi = (job: Job) => job.compensationRanges?.some(range => range.min === 150000 && range.max === 180000) ?? false

/** The contract keeps the same-clause rejection quote after API selection without touching the API row. */
function expectApiFallbackWithQuote(job: Job, quote: string, rejectedAmount: number) {
  expect(job.salary).toBeNull()
  expect(job.compensationRanges).toEqual([expect.objectContaining(apiRow)])
  expect(job.compensationRanges![0].evidence?.source).toBe('board')
  expect(job.compensationRanges!.some(range => range.min === rejectedAmount || range.max === rejectedAmount)).toBe(false)
  expect(job.compensationEvidence?.some(evidence => evidence.source === 'description' && evidence.text.includes(quote))).toBe(true)
  expect(JobSchema.safeParse(job).success).toBe(true)
}

describe('fresh Himalayas source selection is semantic, not a note check', () => {
  it('a rejection-only body allows the real API fallback with unknown basis and keeps its quote separately', () => {
    expectApiFallbackWithQuote(normalize(CONTEXT_SENTENCES.bonusOnly), CONTEXT_SENTENCES.bonusOnly, 25000)
  })

  it.each([
    ['component noun before the amount', CONTEXT_SENTENCES.includesBonusOf, 20000],
    ['component noun after the amount', CONTEXT_SENTENCES.includesBonusPostfix, 20000],
    ['worth relation', 'Compensation also includes a signing bonus worth USD 20,000.', 20000],
    ['valued at relation', 'Compensation also includes a signing bonus valued at USD 20,000.', 20000],
    ['bounded qualifier', 'Compensation also includes a signing bonus of up to USD 20,000.', 20000],
    ['worth up to qualifier', 'Compensation also includes a signing bonus worth up to USD 20,000.', 20000],
    ['at least qualifier', 'Compensation also includes a signing bonus of at least USD 20,000.', 20000],
    ['approximate qualifier', 'Compensation also includes a signing bonus of approximately USD 20,000.', 20000],
    ['amount-first bounded control', 'Compensation also includes up to USD 20,000 in signing bonus.', 20000],
    ['exclusion object, noun first', CONTEXT_SENTENCES.excludesBonusOf, 20000],
    ['exclusion object, does not include', 'Annual base salary does not include a signing bonus of USD 20,000.', 20000],
    ['exclusion object, excluding', 'Annual base salary excluding a signing bonus of USD 20,000.', 20000],
    ['exclusion object, amount first', 'Annual base salary excludes a USD 25,000 signing bonus.', 25000],
  ] as [string, string, number][])('an included or excluded bonus object is not a salary disclosure, so the API range wins: %s', (_name, sentence, amount) => {
    expectApiFallbackWithQuote(normalize(sentence), sentence, amount)
  })

  it.each([
    ['Annual base salary including bonuses is USD 100,000–120,000.'],
    ['Annual base salary including bonuses is in the range of USD 100,000–120,000.'],
    ['Annual base salary including bonuses is worth USD 100,000–120,000.'],
    ['Annual base salary including bonuses is valued at USD 100,000–120,000.'],
    ['Annual base salary: USD 100,000–120,000, including bonus.'],
  ])('a combined salary amount stated in the body stays the body total disclosure, not an API fallback: %s', sentence => {
    const job = normalize(sentence)
    expect(job.salary).toBeNull()
    expect(usesApi(job)).toBe(false)
    expect(job.compensationRanges).toEqual([expect.objectContaining({ min: 100000, max: 120000, currency: 'USD', period: 'year', basis: 'total' })])
    expect(job.compensationRanges![0].evidence?.source).toBe('description')
  })

  it('a benefits-include bonus is not a salary disclosure, so the API range stays eligible', () => {
    expectApiFallbackWithQuote(normalize(CONTEXT_SENTENCES.benefitsInclude), CONTEXT_SENTENCES.benefitsInclude, 25000)
    const alone = normalize(CONTEXT_SENTENCES.benefitsInclude, { minSalary: null, maxSalary: null, currency: null, salaryPeriod: null })
    expect(alone.salary).toBeNull()
    expect(alone.compensationRanges).toBeUndefined()
    expect(alone.compensationEvidence).toHaveLength(1)
    expect(alone.compensationEvidence![0].text).toContain(CONTEXT_SENTENCES.benefitsInclude)
    expect(alone.compensationNote).toBe(CONTEXT_NOTES.none)
  })

  it('a separate supplementary rejection quote never selects the body or blocks the API amounts', () => {
    const job = normalize(`${CONTEXT_SENTENCES.bonusOnly} Relocation support of USD 5,000 is also available.`)
    expect(job.salary).toBeNull()
    expect(usesApi(job)).toBe(true)
    expect(job.compensationRanges).toHaveLength(1)
  })

  it.each([
    ['comparable base beside a bonus', CONTEXT_SENTENCES.bonusAfterBase],
    ['base with unknown period', CONTEXT_SENTENCES.reviewedAnnually],
    ['unresolved review-labelled range', CONTEXT_SENTENCES.reviewLabel],
    ['conflicting direct owners', 'Annual base salary: USD 20,000 signing bonus.'],
  ])('a numeric salary disclosure in the body keeps body priority: %s', (_name, sentence) => {
    const job = normalize(sentence)
    expect(usesApi(job)).toBe(false)
    expect(job.compensationRanges).toHaveLength(1)
    expect(job.compensationRanges![0].evidence?.source).toBe('description')
  })

  it('the comparable body base keeps the comparison and the bonus adds no row', () => {
    const job = normalize(CONTEXT_SENTENCES.bonusAfterBase)
    expect(job.salary).toEqual({ min: 100000, max: 120000, currency: 'USD' })
    expect(job.compensationRanges).toEqual([expect.objectContaining({ min: 100000, max: 120000, currency: 'USD', period: 'year', basis: 'base' })])
  })

  it.each([
    ['malformed annotated range', 'Annual base salary: USD 84,00/year to USD 126,000/year.', 'USD 84,00/year to USD 126,000/year'],
    ['one-sided offer', CONTEXT_SENTENCES.incompleteBase, 'up to USD 180,000'],
  ])('an incomplete salary disclosure in the body still wins over the API: %s', (_name, sentence, quote) => {
    const job = normalize(sentence)
    expect(job.salary).toBeNull()
    expect(job.compensationRanges).toBeUndefined()
    expect(job.compensationEvidence).toHaveLength(1)
    expect(job.compensationEvidence![0]).toMatchObject({ source: 'description' })
    expect(job.compensationEvidence![0].text).toContain(quote)
    expect(job.compensationNote).toBe(CONTEXT_NOTES.none)
  })

  it('a body without any pay statement still uses the API amounts', () => {
    const job = normalize('Build a fictional ledger API with TypeScript.')
    expect(job.salary).toBeNull()
    expect(job.compensationRanges).toEqual([expect.objectContaining(apiRow)])
  })

  it('a rejection-only body with no API salary keeps only the quote and the no-comparable-range note', () => {
    const job = normalize(CONTEXT_SENTENCES.bonusOnly, { minSalary: null, maxSalary: null, currency: null, salaryPeriod: null })
    expect(job.salary).toBeNull()
    expect(job.compensationRanges).toBeUndefined()
    expect(job.compensationEvidence).toHaveLength(1)
    expect(job.compensationEvidence![0].text).toContain(CONTEXT_SENTENCES.bonusOnly)
    expect(job.compensationNote).toBe(CONTEXT_NOTES.none)
  })
})

describe('an old normalized Himalayas body record cannot invent its discarded API fallback', () => {
  it('clears the proven bonus salary, keeps the quote and adds no API range or new timestamp', () => {
    const fresh = normalize('Build a fictional ledger API with TypeScript.')
    const { compensationRanges: _ranges, compensationNote: _note, compensationEvidence: _evidence, ...rest } = fresh
    const old: Job = {
      ...rest, compensationVersion: 3, ...CONTEXT_LEGACY_PAY.bonusOnly,
      description: `${CONTEXT_INTRO}\n${CONTEXT_SENTENCES.bonusOnly}`,
    }
    for (const preserve of [true, false]) {
      const updated = upgradeJobCompensation(old, preserve)
      expect(updated).toMatchObject({ id: old.id, fetchedAt: CONTEXT_TIME, source: 'himalayas', salary: null, compensationVersion: COMPENSATION_VERSION, compensationNote: CONTEXT_NOTES.none })
      expect(updated.compensationRanges).toBeUndefined()
      expect(usesApi(updated)).toBe(false)
      expect(updated.compensationEvidence).toHaveLength(1)
      expect(updated.compensationEvidence![0].text).toContain(CONTEXT_SENTENCES.bonusOnly)
    }
    expect(old.salary).toEqual({ min: 25000, max: 25000, currency: 'USD' })
  })
})

describe('structured providers with explicit intervals ignore conflicting prose', () => {
  it('Ashby keeps its salary component and interval beside bonus and review prose', () => {
    const job = normalizeAshbyJob(ashbyPosting({
      id: 'context-structured-control', title: 'Backend Engineer — structured board control fixture',
      descriptionPlain: `${CONTEXT_INTRO}\n${CONTEXT_SENTENCES.bonusOnly}\n${CONTEXT_SENTENCES.reviewedAnnually}`,
    }), CONTEXT_ASHBY_COMPANY.id, CONTEXT_TIME)!
    expect(job.salary).toEqual({ min: 100000, max: 140000, currency: 'GBP' })
    expect(job.compensationRanges).toEqual([expect.objectContaining({ min: 100000, max: 140000, currency: 'GBP', period: 'year', basis: 'base' })])
    expect(job.compensationRanges![0].evidence?.source).toBe('board')
    expect(job.compensationEvidence).toBeUndefined()
    expect(job.compensationVersion).toBe(COMPENSATION_VERSION)
  })

  it('Lever keeps its explicit yearly range beside bonus and review prose', () => {
    const job = normalizeLeverJob(leverPosting({
      descriptionPlain: `${CONTEXT_INTRO}\n${CONTEXT_SENTENCES.bonusOnly}\n${CONTEXT_SENTENCES.reviewedAnnually}`,
    }), 'fixture-quill-lever', CONTEXT_TIME)!
    expect(job.salary).toEqual({ min: 90000, max: 130000, currency: 'EUR' })
    expect(job.compensationRanges).toEqual([expect.objectContaining({ min: 90000, max: 130000, currency: 'EUR', period: 'year', basis: 'base' })])
    expect(job.compensationRanges![0].evidence?.source).toBe('board')
  })
})
