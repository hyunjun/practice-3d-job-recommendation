import { describe, expect, it } from 'vitest'
import { normalizeJob, parseSalary } from '../../server/normalize'
import { greenhouseCompensation } from '../../server/greenhouse-compensation'
import { parseTextCompensation } from '../../shared/pay-text'
import { upgradeJobCompensation } from '../../shared/job-compensation'
import { formatCompensation, formatJobSalary, filterJobs, medianSalary } from '../../shared/matching'
import { JobSchema } from '../../shared/schemas'
import { createSampleCatalog } from '../../shared/sample'
import { DEFAULT_FILTERS, SAMPLE_PROFILE } from '../../shared/types'
import type { Job } from '../../shared/types'

const timestamp = '2026-09-19T07:00:00.000Z'
const tiered = [
  'For Portugal based hires: Annual base salary €54,000–€91,000.',
  'For Colorado based hires: Annual base salary USD 136,000–187,000.',
  'For Washington based hires: Annual base salary USD 150,000–206,000.',
].join('\n')
const posting = (text: string) => normalizeJob({
  id: 5601, title: 'Backend Engineer — pay fixture', absolute_url: 'https://example.com/jobs/pay-fixture',
  content: `<p>5 years of software engineering with Python and AWS.</p><p>${text}</p>`,
  location: { name: 'London, UK' },
}, 'stripe', timestamp)!

describe('amounts, currencies and payment periods from posting text', () => {
  it.each([
    ['Annual base salary: $145,000 — $195,000 USD.', 145000, 195000, 'USD'],
    ['Base salary: USD 120,000–180,000 per year.', 120000, 180000, 'USD'],
    ['Annual salary: £85–120k.', 85000, 120000, 'GBP'],
    ['Annual base salary: €90,000–€130,000.', 90000, 130000, 'EUR'],
    ['Annual Base Salary Range:\n$170,000—$178,000 USD', 170000, 178000, 'USD'],
    ['Annual salary: SGD 200000–240000.', 200000, 240000, 'SGD'],
  ])('retains the complete explicitly annual range: %s', (text, min, max, currency) => {
    const pay = parseTextCompensation(String(text))
    expect(pay.salary).toEqual({ min, max, currency })
    expect(pay.compensationRanges).toHaveLength(1)
    expect(pay.compensationRanges![0].evidence).toEqual({ source: 'description', text })
  })

  it.each([
    ['Monthly base salary: USD 12,000–15,000.', 12000, 15000, 'month'],
    ['Hourly base pay: $55–$55 USD.', 55, 55, 'hour'],
    ['Base salary: USD 120,000–180,000.', 120000, 180000, 'unknown'],
  ])('does not infer an annual period: %s', (text, min, max, period) => {
    const pay = parseTextCompensation(String(text))
    expect(pay.salary).toBeNull()
    expect(pay.compensationRanges?.[0]).toMatchObject({ min, max, period })
  })

  it('keeps ambiguous or conflicting currency visible and never infers dollars from a city', () => {
    const text = 'Annual base salary: $120,000–$180,000.'
    expect(parseSalary(text, ['san-francisco'])).toBeNull()
    const pay = parseTextCompensation(text)
    expect(pay.compensationRanges![0]).toMatchObject({ min: 120000, max: 180000, currency: null, period: 'year' })
    expect(formatCompensation(pay.compensationRanges![0])).toBe('통화 미확인 120,000–180,000 / 년')
    expect(parseTextCompensation('Annual base salary: €90,000–€130,000 USD.').salary).toBeNull()
  })

  it('reads every regional range instead of applying the first range to all locations', () => {
    const job = posting(tiered)
    expect(job.salary).toBeNull()
    expect(job.compensationRanges?.map(range => [range.min, range.max, range.currency])).toEqual([
      [54000, 91000, 'EUR'], [136000, 187000, 'USD'], [150000, 206000, 'USD'],
    ])
    expect(job.compensationRanges?.every(range => range.scope && range.evidence?.text.includes(range.scope))).toBe(true)
    expect(JobSchema.safeParse(job).success).toBe(true)
    const catalog = { ...createSampleCatalog(), jobs: [job] }
    const matches = filterJobs(catalog, SAMPLE_PROFILE, DEFAULT_FILTERS)
    expect(matches).toHaveLength(1)
    expect(medianSalary(matches)).toBeNull()
    expect(filterJobs(catalog, SAMPLE_PROFILE, { ...DEFAULT_FILTERS, includeUnknownSalary: false })).toHaveLength(0)
  })

  it('distinguishes total compensation and unknown composition from base salary', () => {
    const total = parseTextCompensation('Annual total compensation (OTE): USD 180,000–250,000.')
    expect(total.salary).toBeNull()
    expect(total.compensationRanges![0]).toMatchObject({ min: 180000, max: 250000, basis: 'total' })
    expect(formatCompensation(total.compensationRanges![0])).toContain('총보상')
    const unknown = parseTextCompensation('Annual compensation: USD 180,000–250,000.')
    expect(unknown.salary).toBeNull()
    expect(unknown.compensationRanges![0].basis).toBe('unknown')
  })

  it('does not count adjacent equity, bonuses or budgets as a second base salary', () => {
    const pay = parseTextCompensation('Annual base salary: USD 120,000–180,000. Equity grant: USD 20,000–40,000.')
    expect(pay.salary).toEqual({ min: 120000, max: 180000, currency: 'USD' })
    expect(pay.compensationRanges).toHaveLength(1)
    const unspecified = parseTextCompensation('Base salary: USD 120,000–180,000, plus an annual bonus of USD 20,000.')
    expect(unspecified.salary).toBeNull()
    expect(unspecified.compensationRanges).toHaveLength(1)
    expect(unspecified.compensationRanges![0].period).toBe('unknown')
    expect(parseTextCompensation('We raised USD 100,000,000. Our benefits include an annual learning budget of USD 5,000.').salary).toBeNull()
    const combined = parseTextCompensation('Annual base salary: USD 120,000–180,000, and total compensation USD 150,000–220,000.')
    expect(combined.salary).toBeNull()
    expect(combined.compensationRanges?.map(range => range.basis)).toEqual(['base', 'total'])
    expect(parseTextCompensation('We raised USD 100,000,000 and offer an annual base salary: USD 120,000–180,000.').salary).toEqual({ min: 120000, max: 180000, currency: 'USD' })
  })

  it('supports an explicit fixed salary but preserves one-sided offers without inventing a range', () => {
    expect(parseTextCompensation('Annual base salary: USD 180,000.').salary).toEqual({ min: 180000, max: 180000, currency: 'USD' })
    const pay = parseTextCompensation('Annual base salary up to USD 180,000.')
    expect(pay.salary).toBeNull()
    expect(pay.compensationRanges).toBeUndefined()
    expect(pay.compensationEvidence?.[0].text).toContain('up to USD 180,000')
  })
})

describe('Greenhouse pay transparency metadata', () => {
  it('uses every structured range, including its title, currency and original explanation', () => {
    const pay = greenhouseCompensation('Annual base salary: USD 999,999–999,999.', [
      { title: 'Annual base salary', min_cents: 10000000, max_cents: 14000000, currency_type: 'GBP', blurb: 'For United Kingdom based hires.' },
      { title: 'Annual base salary', min_cents: 9000000, max_cents: 13000000, currency_type: 'EUR', blurb: 'For Germany based hires.' },
    ])
    expect(pay.salary).toBeNull()
    expect(pay.compensationRanges).toHaveLength(2)
    expect(pay.compensationRanges![0]).toMatchObject({ currency: 'GBP', min: 100000, max: 140000, period: 'year', scope: 'For United Kingdom based hires.' })
    expect(pay.compensationRanges![0].evidence).toEqual({ source: 'board', text: 'Annual base salary\nFor United Kingdom based hires.' })
  })

  it('reads a 55-dollar hourly disclosure and does not assume a period from cents or the word salary', () => {
    const hourly = greenhouseCompensation('', [{
      title: 'Internship', min_cents: 5500, max_cents: 5500, currency_type: 'USD',
      blurb: '<p>This role has the hourly base pay rate stated below.</p>',
    }])
    expect(hourly.salary).toBeNull()
    expect(hourly.compensationRanges![0]).toMatchObject({ min: 55, max: 55, period: 'hour', basis: 'base' })
    const unknown = greenhouseCompensation('', [{ title: 'Salary Range', min_cents: 15000000, max_cents: 20000000, currency_type: 'USD' }])
    expect(unknown.salary).toBeNull()
    expect(unknown.compensationRanges![0].period).toBe('unknown')
  })

  it('keeps a country-specific disclosure out of a global annual comparison even when only one range exists', () => {
    const pay = greenhouseCompensation('', [{
      title: 'United States Salary Range', min_cents: 11520000, max_cents: 19440000, currency_type: 'USD',
      blurb: 'The annual base salary range is for residents of the United States only.',
    }])
    expect(pay.salary).toBeNull()
    expect(pay.compensationRanges![0]).toMatchObject({ period: 'year', currency: 'USD', scope: expect.stringContaining('United States only') })
  })

  it('does not take a base-pay period from equity vesting or an annual benefit', () => {
    const range = { title: 'Salary Range', min_cents: 12000000, max_cents: 18000000, currency_type: 'USD' }
    const unknown = greenhouseCompensation('', [{ ...range, blurb: 'Equity vests annually. Employees receive an annual learning budget of USD 5,000.' }])
    expect(unknown.salary).toBeNull()
    expect(unknown.compensationRanges![0].period).toBe('unknown')
    const monthly = greenhouseCompensation('', [{ ...range, blurb: 'The base salary is paid monthly. Equity vests annually.' }])
    expect(monthly.compensationRanges![0].period).toBe('month')
  })
})

describe('rechecking existing compensation without losing saved context', () => {
  const oldJob = (): Job => {
    const { compensationVersion: _version, compensationRanges: _ranges, compensationNote: _note, ...job } = posting(tiered)
    return { ...job, salary: { min: 54000, max: 91000, currency: 'EUR' } }
  }

  it('corrects old first-range snapshots while retaining identity, description and original collection time', () => {
    const job = oldJob()
    const updated = upgradeJobCompensation(job)
    expect(updated).toMatchObject({ id: job.id, fetchedAt: timestamp, description: job.description, salary: null, compensationVersion: 1 })
    expect(updated.compensationRanges).toHaveLength(3)
    expect(upgradeJobCompensation(updated)).toBe(updated)
    expect(job.salary).not.toBeNull()
  })

  it('preserves an unverifiable saved amount as an earlier record but does not reuse it for fresh recommendations', () => {
    const job = { ...oldJob(), description: 'The stored excerpt does not include compensation.' }
    const saved = upgradeJobCompensation(job, true)
    expect(saved).toBe(job)
    expect(formatJobSalary(saved)).toContain('이전 기록')
    const cached = upgradeJobCompensation(job)
    expect(cached.salary).toBeNull()
    expect(cached.compensationNote).toContain('보상 근거')
    expect(cached.fetchedAt).toBe(timestamp)
  })
})
