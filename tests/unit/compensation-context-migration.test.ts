import { describe, expect, it } from 'vitest'
import { normalizeJob } from '../../server/normalize'
import { parseCachedBoards } from '../../server/board-cache'
import type { CachedBoard } from '../../server/board-cache'
import { upgradeJobCompensation } from '../../shared/job-compensation'
import { decodeSavedJobs } from '../../shared/saved-jobs'
import { createSavedBackup, parseSavedImport } from '../../shared/saved-backup'
import { formatCompensation, formatJobSalary } from '../../shared/matching'
import { JobSchema } from '../../shared/schemas'
import { COMPENSATION_VERSION } from '../../shared/types'
import type { CompensationRange, Job, JobProvider, Salary, SavedJob } from '../../shared/types'
import { NUMBER_FORMAT_LEGACY_PAY, NUMBER_FORMAT_QUOTES } from '../fixtures/compensation-number-format'
import {
  CONTEXT_BOARD_COMPLETE_ROW, CONTEXT_BOARD_QUOTES, CONTEXT_COMPANY, CONTEXT_INCOMPLETE_RANGES, CONTEXT_INTRO, CONTEXT_LEGACY_PAY,
  CONTEXT_LEGACY_ROWS, CONTEXT_NOTES, CONTEXT_SENTENCES, CONTEXT_TIME, OTHER_SUFFIX, cappedBoardQuote, contextBoardRaw, contextPostingRaw,
} from '../fixtures/compensation-context'
import type { ContextPostingKey } from '../fixtures/compensation-context'

// Stage 77 contract, "Stored data and provider behavior": version 3 text-derived records
// re-evaluate from their own body and retained quotes; Greenhouse board ranges keep their
// numbers and re-derive only period/basis per range; other providers keep structured data;
// saved scalars are refuted only through their own attributable evidence.

const posting = (key: ContextPostingKey) => normalizeJob(contextPostingRaw(key), CONTEXT_COMPANY.id, CONTEXT_TIME)!
const withoutPay = (job: Job) => {
  const { compensationRanges: _ranges, compensationNote: _note, compensationEvidence: _evidence, ...rest } = job
  return rest
}
const usd: Salary = { min: 100000, max: 120000, currency: 'USD' }
const boardComplete = CONTEXT_BOARD_COMPLETE_ROW
/** Astra M06: the native version 4 shape of a base row plus an unquoted invalid board item, re-stamped as version 3. */
const incompleteBoardJob = (): Job => {
  const fresh = normalizeJob(contextBoardRaw(7712, 'Backend Engineer — incomplete board item fixture', CONTEXT_INCOMPLETE_RANGES), CONTEXT_COMPANY.id, CONTEXT_TIME)!
  expect(fresh).toMatchObject({ salary: null, compensationNote: CONTEXT_NOTES.partial, compensationVersion: COMPENSATION_VERSION })
  expect(fresh.compensationRanges).toHaveLength(1)
  expect(fresh.compensationEvidence).toBeUndefined()
  return { ...fresh, compensationVersion: 3 }
}
const savedAt = '2026-10-01T10:00:00.000Z'
const record = (job: Job, id: string, note = `note ${id}`): SavedJob => ({ job: { ...job, id }, company: CONTEXT_COMPANY, savedAt, status: 'applied', note })

describe('version 3 text-derived records are corrected from their own evidence', () => {
  it('clears a signing bonus that was promoted to annual base salary, in saved and catalog paths', () => {
    const old: Job = { ...withoutPay(posting('bonusOnly')), ...CONTEXT_LEGACY_PAY.bonusOnly, compensationVersion: 3 }
    expect(formatJobSalary(old)).toBe('$25–25k · 이전 기록')
    for (const preserve of [true, false]) {
      const updated = upgradeJobCompensation(old, preserve)
      expect(updated).not.toBe(old)
      expect(updated).toMatchObject({ id: old.id, fetchedAt: CONTEXT_TIME, description: old.description, salary: null, compensationVersion: COMPENSATION_VERSION, compensationNote: CONTEXT_NOTES.none })
      expect(updated.compensationRanges).toBeUndefined()
      expect(updated.compensationEvidence).toHaveLength(1)
      expect(updated.compensationEvidence![0]).toMatchObject({ source: 'description' })
      expect(updated.compensationEvidence![0].text).toContain(CONTEXT_SENTENCES.bonusOnly)
      expect(formatJobSalary(updated)).toBe('보상 확인 필요')
    }
    expect(old).toMatchObject({ compensationVersion: 3, salary: { min: 25000, max: 25000, currency: 'USD' } })
  })

  it('removes the bonus row that made a real annual base range non-comparable', () => {
    const old: Job = { ...withoutPay(posting('bonusAfterBase')), ...CONTEXT_LEGACY_PAY.twoRows, description: `${CONTEXT_INTRO}\n${CONTEXT_SENTENCES.postfixBonus}`, compensationVersion: 3 }
    expect(old.compensationRanges).toHaveLength(2)
    for (const preserve of [true, false]) {
      const updated = upgradeJobCompensation(old, preserve)
      expect(updated).toMatchObject({ id: old.id, fetchedAt: CONTEXT_TIME, salary: usd, compensationVersion: COMPENSATION_VERSION })
      expect(updated.compensationRanges).toEqual([expect.objectContaining({ ...usd, period: 'year', basis: 'base' })])
      // The refuted bonus row's own quote is retained as the correcting evidence (contract line 109).
      expect(updated.compensationEvidence).toEqual([{ source: 'description', text: CONTEXT_SENTENCES.postfixBonus }])
      expect(updated.compensationNote).toBeUndefined()
    }
  })

  it('removes a review-derived annual unit while keeping the numeric base range', () => {
    const old: Job = { ...withoutPay(posting('reviewedAnnually')), ...CONTEXT_LEGACY_PAY.reviewedAnnually, compensationVersion: 3 }
    for (const preserve of [true, false]) {
      const updated = upgradeJobCompensation(old, preserve)
      expect(updated).toMatchObject({ salary: null, compensationVersion: COMPENSATION_VERSION, compensationNote: CONTEXT_NOTES.periodUnknown, fetchedAt: CONTEXT_TIME })
      expect(updated.compensationRanges).toEqual([expect.objectContaining({ min: 130000, max: 170000, currency: 'USD', period: 'unknown', basis: 'base' })])
      expect(formatJobSalary(updated)).toBe('별도 보상 조건')
    }
  })

  it('recovers a retained quote beyond the stored body without extending the description', () => {
    const old: Job = {
      ...withoutPay(posting('bonusAfterBase')), ...CONTEXT_LEGACY_PAY.twoRows, compensationVersion: 3,
      description: 'Original technical responsibilities. '.repeat(900).slice(0, 26000),
    }
    const updated = upgradeJobCompensation(old)
    expect(updated.salary).toEqual(usd)
    expect(updated.compensationRanges).toEqual([expect.objectContaining({ ...usd, period: 'year', basis: 'base' })])
    expect(updated.description).toBe(old.description)
    expect(updated.fetchedAt).toBe(CONTEXT_TIME)
  })

  it('keeps ordinary version 2 numeric recovery without an equality guard', () => {
    const old: Job = {
      ...withoutPay(posting('bonusAfterBase')), ...NUMBER_FORMAT_LEGACY_PAY.spaceGrouped, compensationVersion: 2,
      description: `${CONTEXT_INTRO}\n${NUMBER_FORMAT_QUOTES.spaceGrouped}`,
    }
    expect(old.compensationRanges![0].min).toBe(88)
    for (const preserve of [true, false]) {
      const updated = upgradeJobCompensation(old, preserve)
      expect(updated).toMatchObject({ salary: { min: 88000, max: 124000, currency: 'EUR' }, compensationVersion: COMPENSATION_VERSION })
      expect(updated.compensationRanges).toEqual([expect.objectContaining({ min: 88000, max: 124000, currency: 'EUR', period: 'year' })])
    }
  })

  it('leaves a current version 4 job untouched', () => {
    const fresh = posting('bonusAfterBase')
    expect(COMPENSATION_VERSION).toBe(4)
    expect(fresh.compensationVersion).toBe(4)
    expect(upgradeJobCompensation(fresh)).toBe(fresh)
    expect(upgradeJobCompensation(fresh, true)).toBe(fresh)
  })
})

describe('H1: a seniority abbreviation in an owned pay line is recovered only from real source text', () => {
  // historical-correction-resolution-01: a complete retained body may restore the "Sr." qualifier in the
  // label and owned quote; a missing source cannot be reconstructed from the job title or a guess.
  const seniorRow = {
    label: 'Sr. Orbit Systems Engineer', min: 140000, max: 190000, currency: null, period: 'year', basis: 'unknown',
    evidence: { source: 'description' as const, text: 'Pay range:\nSr. Orbit Systems Engineer: $140,000.00 - $190,000.00/per year' },
  }

  it('a complete retained body recovers the qualifier without changing identity, metadata or the numeric facts', () => {
    const old: Job = {
      ...withoutPay(posting('bonusOnly')), title: 'Sr. Backend Engineer — complete body fixture', compensationVersion: 3, salary: null,
      description: `${CONTEXT_INTRO}\n${CONTEXT_SENTENCES.seniorHeading}`,
    }
    const snapshot = JSON.stringify(old)
    for (const preserve of [true, false]) {
      const updated = upgradeJobCompensation(old, preserve)
      expect(updated).toMatchObject({
        id: old.id, title: old.title, description: old.description, fetchedAt: CONTEXT_TIME, salary: null,
        compensationVersion: COMPENSATION_VERSION, compensationNote: CONTEXT_NOTES.basis,
      })
      expect(updated.compensationRanges).toEqual([seniorRow])
      expect(updated.compensationEvidence).toBeUndefined()
      expect(formatCompensation(updated.compensationRanges![0])).toBe('통화 미확인 140,000–190,000 / 년 · 구성 미확인')
    }
    expect(JSON.stringify(old)).toBe(snapshot)
  })

  it('a truncated body with a stale quote keeps the stored label and quote and never invents the qualifier from the title', () => {
    const stale = CONTEXT_LEGACY_ROWS.seniorStaleQuote
    const old: Job = {
      ...withoutPay(posting('bonusOnly')), title: 'Sr. Backend Engineer — truncated quote fixture', compensationVersion: 3, salary: null,
      description: 'Original technical responsibilities. '.repeat(40).trim(),
      compensationRanges: [stale], compensationNote: CONTEXT_NOTES.basis,
    }
    const snapshot = JSON.stringify(old)
    for (const preserve of [true, false]) {
      const updated = upgradeJobCompensation(old, preserve)
      expect(updated).toMatchObject({
        id: old.id, title: old.title, description: old.description, fetchedAt: CONTEXT_TIME, salary: null,
        compensationVersion: COMPENSATION_VERSION, compensationNote: CONTEXT_NOTES.basis,
      })
      expect(updated.compensationRanges).toEqual([stale])
      expect(updated.compensationEvidence).toBeUndefined()
      expect(JSON.stringify(updated.compensationRanges)).not.toContain('Sr.')
    }
    expect(JSON.stringify(old)).toBe(snapshot)
  })
})

describe('saved scalars are refuted only through attributable evidence', () => {
  it('an unrelated equal-valued bonus in the body does not refute a scalar without its own quote', () => {
    const old: Job = {
      ...withoutPay(posting('bonusOnly')), compensationVersion: 3, salary: { min: 25000, max: 25000, currency: 'USD' },
      description: `${CONTEXT_INTRO}\n${CONTEXT_SENTENCES.benefitsBonus}`,
    }
    expect(upgradeJobCompensation(old, true)).toBe(old)
    expect(formatJobSalary(old)).toBe('$25–25k · 이전 기록')
    const catalog = upgradeJobCompensation(old)
    // A benefits list has no salary subject, so no public quote replaces the existing recheck note.
    expect(catalog).toMatchObject({ salary: null, compensationVersion: COMPENSATION_VERSION, fetchedAt: CONTEXT_TIME, compensationNote: CONTEXT_NOTES.unverifiable })
    expect(catalog.compensationRanges).toBeUndefined()
    expect(catalog.compensationEvidence).toBeUndefined()
  })

  it('an unavailable old scalar stays an earlier saved record and leaves fresh comparison', () => {
    const old: Job = {
      ...withoutPay(posting('bonusOnly')), compensationVersion: 3, salary: { min: 25000, max: 25000, currency: 'USD' },
      description: 'This older excerpt has no compensation information.',
    }
    expect(upgradeJobCompensation(old, true)).toBe(old)
    const catalog = upgradeJobCompensation(old)
    expect(catalog).toMatchObject({ salary: null, compensationVersion: COMPENSATION_VERSION, compensationNote: CONTEXT_NOTES.unverifiable })
    expect(catalog.compensationRanges).toBeUndefined()
  })

  it('a quote owned by another range cannot refute a different old salary', () => {
    const old: Job = {
      ...withoutPay(posting('structured')), compensationVersion: 3, salary: { min: 25000, max: 25000, currency: 'USD' },
      compensationRanges: [{
        label: 'Earlier salary', min: 25000, max: 25000, currency: 'USD', period: 'year', basis: 'base',
        evidence: { source: 'description', text: 'Annual base salary is competitive for this position.' },
      }],
      compensationEvidence: [{ source: 'description', text: 'Benefits also list a signing bonus of USD 25,000 for new hires.' }],
      description: 'This older excerpt keeps only the retained quotes above.',
    }
    expect(upgradeJobCompensation(old, true)).toBe(old)
    expect(upgradeJobCompensation(old).salary).toBeNull()
  })
})

describe('Greenhouse board ranges keep their numbers and re-derive only period and basis', () => {
  const boardBase = () => withoutPay(posting('structured'))

  it('demotes a review-derived annual period on a complete owned quote in both paths', () => {
    const old: Job = { ...boardBase(), ...CONTEXT_LEGACY_PAY.greenhouseReview, compensationVersion: 3 }
    for (const preserve of [true, false]) {
      const updated = upgradeJobCompensation(old, preserve)
      expect(updated).toMatchObject({ id: old.id, fetchedAt: CONTEXT_TIME, salary: null, compensationVersion: COMPENSATION_VERSION, compensationNote: CONTEXT_NOTES.periodUnknown })
      expect(updated.compensationRanges).toEqual([expect.objectContaining({
        label: 'Salary Range', ...usd, period: 'unknown', basis: 'base',
        evidence: { source: 'board', text: CONTEXT_BOARD_QUOTES.reviewedAnnually },
      })])
    }
    expect(old.compensationRanges![0].period).toBe('year')
  })

  it('restores an annual title unit that a monthly review cadence had suppressed', () => {
    const old: Job = { ...boardBase(), ...CONTEXT_LEGACY_PAY.greenhouseMonthlyReview, compensationVersion: 3 }
    const updated = upgradeJobCompensation(old)
    expect(updated).toMatchObject({ salary: usd, compensationVersion: COMPENSATION_VERSION })
    expect(updated.compensationRanges).toEqual([expect.objectContaining({
      label: 'Annual base salary', ...usd, period: 'year', basis: 'base',
      evidence: { source: 'board', text: CONTEXT_BOARD_QUOTES.annualTitleMonthlyReview },
    })])
    expect(updated.compensationNote).toBeUndefined()
  })

  it('a capped quote with an intact annual title retains an old base/year without contradiction', () => {
    const text = cappedBoardQuote('Annual base salary')
    expect(text).toHaveLength(2000)
    const old: Job = {
      ...boardBase(), compensationVersion: 3, salary: usd,
      compensationRanges: [{ label: 'Annual base salary', ...usd, period: 'year', basis: 'base', evidence: { source: 'board', text } }],
    }
    const updated = upgradeJobCompensation(old)
    expect(updated).toMatchObject({ salary: usd, compensationVersion: COMPENSATION_VERSION })
    expect(updated.compensationRanges).toEqual([expect.objectContaining({ label: 'Annual base salary', ...usd, period: 'year', basis: 'base', evidence: { source: 'board', text } })])
  })

  it('a capped quote never promotes an old unknown period to a comparable year', () => {
    const text = cappedBoardQuote('Annual base salary')
    const old: Job = {
      ...boardBase(), compensationVersion: 3, salary: null, compensationNote: CONTEXT_NOTES.periodUnknown,
      compensationRanges: [{ label: 'Annual base salary', ...usd, period: 'unknown', basis: 'base', evidence: { source: 'board', text } }],
    }
    const updated = upgradeJobCompensation(old)
    expect(updated.salary).toBeNull()
    expect(updated.compensationRanges).toEqual([expect.objectContaining({ ...usd, period: 'unknown', basis: 'base' })])
    expect(updated.compensationVersion).toBe(COMPENSATION_VERSION)
  })

  it('a capped quote whose title supplies no unit keeps base and demotes the old year', () => {
    const text = cappedBoardQuote('Base salary range')
    const old: Job = {
      ...boardBase(), compensationVersion: 3, salary: usd,
      compensationRanges: [{ label: 'Base salary range', ...usd, period: 'year', basis: 'base', evidence: { source: 'board', text } }],
    }
    const updated = upgradeJobCompensation(old)
    expect(updated.salary).toBeNull()
    expect(updated.compensationRanges).toEqual([expect.objectContaining({ label: 'Base salary range', ...usd, period: 'unknown', basis: 'base', evidence: { source: 'board', text } })])
    expect(updated.compensationNote).toContain(CONTEXT_NOTES.demoted)
    expect(updated.compensationVersion).toBe(COMPENSATION_VERSION)
  })

  it.each(['게시판의 급여 범위', '기본 급여', '보상 구간 1'])('missing evidence and the generated label %s prove no attribute', label => {
    const old: Job = {
      ...boardBase(), compensationVersion: 3, salary: usd,
      compensationRanges: [{ label, ...usd, period: 'year', basis: 'base' }],
    }
    for (const preserve of [true, false]) {
      const updated = upgradeJobCompensation(old, preserve)
      expect(updated).toMatchObject({ id: old.id, fetchedAt: CONTEXT_TIME, salary: null, compensationVersion: COMPENSATION_VERSION })
      expect(updated.compensationRanges).toEqual([expect.objectContaining({ label, ...usd, period: 'unknown', basis: 'unknown' })])
      expect(updated.compensationNote).toContain(CONTEXT_NOTES.demoted)
    }
  })

  it('a complete attributable other title corrects the basis to other without an annual claim', () => {
    const text = 'Signing bonus\nWe also offer a competitive annual base salary.'
    const old: Job = {
      ...boardBase(), compensationVersion: 3, salary: { min: 20000, max: 20000, currency: 'USD' },
      compensationRanges: [{ label: 'Signing bonus', min: 20000, max: 20000, currency: 'USD', period: 'year', basis: 'base', evidence: { source: 'board', text } }],
    }
    for (const preserve of [true, false]) {
      const updated = upgradeJobCompensation(old, preserve)
      expect(updated).toMatchObject({ salary: null, compensationVersion: COMPENSATION_VERSION, compensationNote: CONTEXT_NOTES.other })
      expect(updated.compensationRanges).toEqual([expect.objectContaining({ label: 'Signing bonus', min: 20000, max: 20000, currency: 'USD', period: 'unknown', basis: 'other', evidence: { source: 'board', text } })])
      expect(formatCompensation(updated.compensationRanges![0])).toBe(`USD 20,000–20,000 / 기간 미확인${OTHER_SUFFIX}`)
    }
  })

  it('a version 3 record with an unquoted invalid board item stays incomplete in saved and catalog paths', () => {
    const old = incompleteBoardJob()
    expect(CONTEXT_BOARD_QUOTES.completeAnnual).toContain('Annual base salary')
    for (const preserve of [true, false]) {
      const updated = upgradeJobCompensation(old, preserve)
      expect(updated).toMatchObject({ id: old.id, fetchedAt: CONTEXT_TIME, salary: null, compensationVersion: COMPENSATION_VERSION })
      expect(updated.compensationRanges).toEqual([expect.objectContaining({ label: 'Annual base salary', ...usd, period: 'year', basis: 'base' })])
      expect(updated.compensationNote).toContain(CONTEXT_NOTES.partial)
      expect(formatJobSalary(updated)).toBe('별도 보상 조건')
    }
    expect(old.compensationVersion).toBe(3)
  })

  it('a hand-written old record with a quoted invalid bonus and the exact incomplete-salary warning stays incomplete', () => {
    // Astra B01: histories A (base + quoted invalid bonus) and B (the same plus an unquoted invalid
    // salary item) serialize identically under the old schema. The surviving quote cannot prove
    // that no further item was lost, so the old warning is never discharged by migration.
    const old: Job = {
      ...boardBase(), compensationVersion: 3, salary: null, compensationNote: CONTEXT_NOTES.partial,
      compensationRanges: [boardComplete], compensationEvidence: [{ source: 'board', text: 'Signing bonus' }],
    }
    for (const preserve of [true, false]) {
      const updated = upgradeJobCompensation(old, preserve)
      expect(updated).toMatchObject({ id: old.id, fetchedAt: CONTEXT_TIME, description: old.description, salary: null, compensationVersion: COMPENSATION_VERSION, compensationNote: CONTEXT_NOTES.partial })
      expect(updated.compensationRanges).toEqual([boardComplete])
      expect(updated.compensationEvidence).toEqual([{ source: 'board', text: 'Signing bonus' }])
      expect(updated.compensationNote).not.toContain(CONTEXT_NOTES.incompleteOther)
      expect(formatJobSalary(updated)).toBe('별도 보상 조건')
      expect(upgradeJobCompensation(updated, preserve)).toBe(updated)
    }
  })

  it('an incompatible stored label and owned quote prove no attribute', () => {
    const old: Job = {
      ...boardBase(), compensationVersion: 3, salary: usd,
      compensationRanges: [{ label: 'Signing bonus', ...usd, period: 'year', basis: 'base', evidence: { source: 'board', text: CONTEXT_BOARD_QUOTES.completeAnnual } }],
    }
    const updated = upgradeJobCompensation(old)
    expect(updated.salary).toBeNull()
    expect(updated.compensationRanges).toEqual([expect.objectContaining({ label: 'Signing bonus', ...usd, period: 'unknown', basis: 'unknown', evidence: { source: 'board', text: CONTEXT_BOARD_QUOTES.completeAnnual } })])
    expect(updated.compensationNote).toContain(CONTEXT_NOTES.demoted)
    expect(updated.compensationVersion).toBe(COMPENSATION_VERSION)
  })

  // A 649-character native title stored as a 500-character display label beside its complete 709-character owned quote.
  const LONG_TITLE = `Annual base salary range for engineering roles in ${'the regional office '.repeat(30)}`.trim()
  const LONG_LABEL = LONG_TITLE.slice(0, 500)
  const LONG_QUOTE = `${LONG_TITLE}\nThe annual base salary range for this role is listed below.`

  it('a label at the 500-character limit is unproven, but its complete owned quote still supports base and year', () => {
    expect(LONG_TITLE).toHaveLength(649)
    expect(LONG_LABEL).toHaveLength(500)
    expect(LONG_QUOTE).toHaveLength(709)
    const old: Job = {
      ...boardBase(), compensationVersion: 3, salary: usd,
      compensationRanges: [{ label: LONG_LABEL, ...usd, period: 'year', basis: 'base', evidence: { source: 'board', text: LONG_QUOTE } }],
    }
    const updated = upgradeJobCompensation(old)
    expect(updated).toMatchObject({ salary: usd, compensationVersion: COMPENSATION_VERSION })
    expect(updated.compensationRanges).toEqual([expect.objectContaining({ label: LONG_LABEL, ...usd, period: 'year', basis: 'base', evidence: { source: 'board', text: LONG_QUOTE } })])
  })

  it.each([
    ['unknown period', { period: 'unknown', basis: 'base' }, CONTEXT_NOTES.periodUnknown],
    ['unknown basis', { period: 'year', basis: 'unknown' }, CONTEXT_NOTES.basis],
    ['unknown period and basis', { period: 'unknown', basis: 'unknown' }, CONTEXT_NOTES.basis],
  ] as [string, Pick<CompensationRange, 'period' | 'basis'>, string][])('the same complete long title never promotes an old %s under the capped-label policy', (_name, metadata, note) => {
    const old: Job = {
      ...boardBase(), compensationVersion: 3, salary: null, compensationNote: note,
      compensationRanges: [{ label: LONG_LABEL, ...usd, ...metadata, evidence: { source: 'board', text: LONG_QUOTE } }],
    }
    for (const preserve of [true, false]) {
      const updated = upgradeJobCompensation(old, preserve)
      expect(updated).toMatchObject({ id: old.id, fetchedAt: CONTEXT_TIME, salary: null, compensationVersion: COMPENSATION_VERSION })
      expect(updated.compensationRanges).toEqual([expect.objectContaining({ label: LONG_LABEL, ...usd, ...metadata, evidence: { source: 'board', text: LONG_QUOTE } })])
    }
  })

  it('a capped quote whose first line is cut off cannot establish the native title, so unsupported metadata becomes unknown', () => {
    const text = `${LONG_TITLE} ${'with further explanatory wording retained by the employer '.repeat(40)}`.slice(0, 2000)
    expect(text).toHaveLength(2000)
    expect(text).not.toContain('\n')
    const old: Job = {
      ...boardBase(), compensationVersion: 3, salary: usd,
      compensationRanges: [{ label: LONG_LABEL, ...usd, period: 'year', basis: 'base', evidence: { source: 'board', text } }],
    }
    for (const preserve of [true, false]) {
      const updated = upgradeJobCompensation(old, preserve)
      expect(updated).toMatchObject({ id: old.id, fetchedAt: CONTEXT_TIME, salary: null, compensationVersion: COMPENSATION_VERSION })
      expect(updated.compensationRanges).toEqual([expect.objectContaining({ label: LONG_LABEL, ...usd, period: 'unknown', basis: 'unknown', evidence: { source: 'board', text } })])
      expect(updated.compensationNote).toContain(CONTEXT_NOTES.demoted)
    }
  })

  it('contradictory retained wording under the same complete long title demotes the old year', () => {
    const text = `${LONG_TITLE}\nMonthly base salary applies to contractors in this band.`
    const old: Job = {
      ...boardBase(), compensationVersion: 3, salary: usd,
      compensationRanges: [{ label: LONG_LABEL, ...usd, period: 'year', basis: 'base', evidence: { source: 'board', text } }],
    }
    for (const preserve of [true, false]) {
      const updated = upgradeJobCompensation(old, preserve)
      expect(updated).toMatchObject({ id: old.id, fetchedAt: CONTEXT_TIME, salary: null, compensationVersion: COMPENSATION_VERSION })
      expect(updated.compensationRanges).toEqual([expect.objectContaining({ label: LONG_LABEL, ...usd, period: 'unknown', basis: 'base', evidence: { source: 'board', text } })])
      expect(updated.compensationNote).toContain(CONTEXT_NOTES.demoted)
    }
  })

  it('a capped quote whose retained wording states a conflicting unit demotes the old year', () => {
    const text = `Annual base salary\nMonthly base salary applies to contractors in this band. ${'The employer retained further explanatory text here. '.repeat(60)}`.slice(0, 2000)
    expect(text).toHaveLength(2000)
    const old: Job = {
      ...boardBase(), compensationVersion: 3, salary: usd,
      compensationRanges: [{ label: 'Annual base salary', ...usd, period: 'year', basis: 'base', evidence: { source: 'board', text } }],
    }
    const updated = upgradeJobCompensation(old)
    expect(updated.salary).toBeNull()
    expect(updated.compensationRanges).toEqual([expect.objectContaining({ ...usd, period: 'unknown', basis: 'base' })])
    expect(updated.compensationNote).toContain(CONTEXT_NOTES.demoted)
  })

  it('a capped quote never promotes an old unknown basis to base', () => {
    const text = cappedBoardQuote('Annual base salary')
    const old: Job = {
      ...boardBase(), compensationVersion: 3, salary: null, compensationNote: CONTEXT_NOTES.basis,
      compensationRanges: [{ label: 'Annual base salary', ...usd, period: 'year', basis: 'unknown', evidence: { source: 'board', text } }],
    }
    const updated = upgradeJobCompensation(old)
    expect(updated.salary).toBeNull()
    expect(updated.compensationRanges).toEqual([expect.objectContaining({ ...usd, period: 'year', basis: 'unknown' })])
    expect(updated.compensationVersion).toBe(COMPENSATION_VERSION)
  })

  it('a complete other title inside a capped quote still corrects the basis to other without a year', () => {
    const text = cappedBoardQuote('Signing bonus')
    const old: Job = {
      ...boardBase(), compensationVersion: 3, salary: { min: 20000, max: 20000, currency: 'USD' },
      compensationRanges: [{ label: 'Signing bonus', min: 20000, max: 20000, currency: 'USD', period: 'year', basis: 'base', evidence: { source: 'board', text } }],
    }
    const updated = upgradeJobCompensation(old)
    expect(updated.salary).toBeNull()
    expect(updated.compensationRanges).toEqual([expect.objectContaining({ label: 'Signing bonus', min: 20000, max: 20000, currency: 'USD', period: 'unknown', basis: 'other', evidence: { source: 'board', text } })])
    // The contract names the other-only note and the demotion note; it does not pin their combination here.
    expect(updated.compensationNote).toMatch(/기본급 외 보상 항목입니다|근거가 충분하지 않아/)
    expect(updated.compensationVersion).toBe(COMPENSATION_VERSION)
  })

  it('the incomplete-salary warning precedes the demotion explanation when both apply', () => {
    const text = cappedBoardQuote('Base salary range')
    const old: Job = {
      ...boardBase(), compensationVersion: 3, salary: null, compensationNote: CONTEXT_NOTES.partial,
      compensationRanges: [{ label: 'Base salary range', ...usd, period: 'year', basis: 'base', evidence: { source: 'board', text } }],
      compensationEvidence: [{ source: 'board', text: 'Signing bonus' }],
    }
    const updated = upgradeJobCompensation(old)
    expect(updated.salary).toBeNull()
    expect(updated.compensationRanges).toEqual([expect.objectContaining({ label: 'Base salary range', ...usd, period: 'unknown', basis: 'base' })])
    const note = updated.compensationNote ?? ''
    expect(note).toContain(CONTEXT_NOTES.partial)
    expect(note).toContain(CONTEXT_NOTES.demoted)
    expect(note.indexOf(CONTEXT_NOTES.partial)).toBeLessThan(note.indexOf(CONTEXT_NOTES.demoted))
  })

  it('corrects each item of a job independently without borrowing the other item unit', () => {
    const old: Job = {
      ...boardBase(), compensationVersion: 3, salary: null, compensationNote: CONTEXT_NOTES.variants,
      compensationRanges: [boardComplete, { label: 'Salary Range', min: 130000, max: 150000, currency: 'USD', period: 'year', basis: 'base', evidence: { source: 'board', text: CONTEXT_BOARD_QUOTES.reviewedAnnually } }],
    }
    const updated = upgradeJobCompensation(old)
    expect(updated.salary).toBeNull()
    expect(updated.compensationRanges?.map(range => [range.min, range.max, range.period])).toEqual([[100000, 120000, 'year'], [130000, 150000, 'unknown']])
    expect(updated.compensationVersion).toBe(COMPENSATION_VERSION)
  })
})

describe('mixed board and description records are migrated per provenance', () => {
  const mixedBase = () => withoutPay(posting('structured'))

  it('removes a false description salary by its own quote while the board base becomes comparable', () => {
    const old: Job = {
      ...mixedBase(), compensationVersion: 3, salary: null, compensationNote: CONTEXT_NOTES.variants,
      description: `${CONTEXT_INTRO}\n${CONTEXT_SENTENCES.bonusOnly}`,
      compensationRanges: [boardComplete, ...CONTEXT_LEGACY_PAY.bonusOnly.compensationRanges!],
    }
    for (const preserve of [true, false]) {
      const updated = upgradeJobCompensation(old, preserve)
      expect(updated).toMatchObject({ salary: usd, compensationVersion: COMPENSATION_VERSION, fetchedAt: CONTEXT_TIME })
      expect(updated.compensationRanges).toEqual([boardComplete])
      expect(updated.compensationEvidence?.some(evidence => evidence.source === 'description' && evidence.text.includes(CONTEXT_SENTENCES.bonusOnly))).toBe(true)
    }
  })

  it('keeps a legitimate description salary with unknown period beside the board base', () => {
    const old: Job = {
      ...mixedBase(), compensationVersion: 3, salary: null, compensationNote: CONTEXT_NOTES.variants,
      description: `${CONTEXT_INTRO}\n${CONTEXT_SENTENCES.legitimateUnknown}`,
      compensationRanges: [boardComplete, {
        label: 'Base salary', min: 90000, max: 110000, currency: 'EUR', period: 'unknown', basis: 'base',
        evidence: { source: 'description', text: CONTEXT_SENTENCES.legitimateUnknown },
      }],
    }
    const updated = upgradeJobCompensation(old)
    expect(updated.salary).toBeNull()
    expect(updated.compensationRanges).toHaveLength(2)
    expect(updated.compensationRanges![0]).toEqual(boardComplete)
    expect(updated.compensationRanges![1]).toMatchObject({ min: 90000, max: 110000, currency: 'EUR', period: 'unknown', basis: 'base' })
    expect(updated.compensationVersion).toBe(COMPENSATION_VERSION)
  })

  it('a malformed owned salary beside an equal-valued bonus stays incomplete salary evidence and blocks the board comparison', () => {
    const old: Job = {
      ...mixedBase(), compensationVersion: 2, salary: null, compensationNote: CONTEXT_NOTES.variants,
      description: `${CONTEXT_INTRO}\n${CONTEXT_SENTENCES.malformedWithEqualBonus}`,
      compensationRanges: [boardComplete, CONTEXT_LEGACY_ROWS.malformedEqualBonus],
    }
    for (const preserve of [true, false]) {
      const updated = upgradeJobCompensation(old, preserve)
      expect(updated).toMatchObject({ id: old.id, fetchedAt: CONTEXT_TIME, salary: null, compensationVersion: COMPENSATION_VERSION, compensationNote: CONTEXT_NOTES.partial })
      expect(updated.compensationRanges).toEqual([boardComplete])
      expect(updated.compensationEvidence?.some(evidence => evidence.source === 'description' && evidence.text.includes('EUR 20.000'))).toBe(true)
      expect(formatJobSalary(updated)).toBe('별도 보상 조건')
    }
    expect(old.compensationRanges![1].min).toBe(20000)
  })

  it('ordinary numeric recovery of an owned space-grouped range survives an unrelated rejected bonus', () => {
    const old: Job = {
      ...mixedBase(), compensationVersion: 2, salary: null, compensationNote: CONTEXT_NOTES.variants,
      description: `${CONTEXT_INTRO}\n${CONTEXT_SENTENCES.spaceGroupedWithBonus}`,
      compensationRanges: [boardComplete, CONTEXT_LEGACY_ROWS.spaceGroupedBonus],
    }
    const updated = upgradeJobCompensation(old)
    expect(updated.salary).toBeNull()
    expect(updated.compensationRanges).toHaveLength(2)
    expect(updated.compensationRanges![0]).toEqual(boardComplete)
    expect(updated.compensationRanges![1]).toMatchObject({ min: 84000, max: 126000, currency: 'EUR', period: 'year', basis: 'base' })
    expect(updated.compensationRanges!.some(range => range.min === 84 || range.max === 126)).toBe(false)
    expect(updated.compensationVersion).toBe(COMPENSATION_VERSION)
  })

  it('the same owned space-grouped quote alone becomes the comparable EUR range', () => {
    const old: Job = {
      ...withoutPay(posting('bonusAfterBase')), compensationVersion: 2, salary: null, compensationNote: CONTEXT_NOTES.periodUnknown,
      description: `${CONTEXT_INTRO}\n${CONTEXT_SENTENCES.spaceGroupedWithBonus}`,
      compensationRanges: [CONTEXT_LEGACY_ROWS.spaceGroupedBonus],
    }
    for (const preserve of [true, false]) {
      const updated = upgradeJobCompensation(old, preserve)
      expect(updated).toMatchObject({ salary: { min: 84000, max: 126000, currency: 'EUR' }, compensationVersion: COMPENSATION_VERSION })
      expect(updated.compensationRanges).toEqual([expect.objectContaining({ min: 84000, max: 126000, currency: 'EUR', period: 'year', basis: 'base' })])
      expect(updated.compensationEvidence).toBeUndefined()
      expect(updated.compensationNote).toBeUndefined()
    }
  })

  it('an equal-valued valid salary and bonus in one owned quote stays conservative and non-comparable', () => {
    const old: Job = {
      ...mixedBase(), compensationVersion: 2, salary: null, compensationNote: CONTEXT_NOTES.variants,
      description: `${CONTEXT_INTRO}\n${CONTEXT_LEGACY_ROWS.equalValidSalaryBonus.evidence!.text}`,
      compensationRanges: [boardComplete, CONTEXT_LEGACY_ROWS.equalValidSalaryBonus],
    }
    const updated = upgradeJobCompensation(old)
    expect(updated.salary).toBeNull()
    expect(updated.compensationRanges![0]).toEqual(boardComplete)
    expect(updated.compensationRanges!.some(range => range.min === 25000 && range.max === 25000 && range.currency === 'USD')).toBe(true)
    expect(updated.compensationVersion).toBe(COMPENSATION_VERSION)
  })

  it('a description numeric row without an owned quote stays visible with unknown metadata beside the board row', () => {
    const old: Job = {
      ...mixedBase(), compensationVersion: 3, salary: null, compensationNote: CONTEXT_NOTES.variants,
      description: `${CONTEXT_INTRO}\nThe stored excerpt no longer contains the quoted salary sentence.`,
      compensationRanges: [boardComplete, { label: 'Base salary', min: 90000, max: 110000, currency: 'EUR', period: 'year', basis: 'base' }],
    }
    for (const preserve of [true, false]) {
      const updated = upgradeJobCompensation(old, preserve)
      expect(updated).toMatchObject({ id: old.id, fetchedAt: CONTEXT_TIME, salary: null, compensationVersion: COMPENSATION_VERSION })
      expect(updated.compensationRanges).toHaveLength(2)
      expect(updated.compensationRanges![0]).toEqual(boardComplete)
      expect(updated.compensationRanges![1]).toMatchObject({ min: 90000, max: 110000, currency: 'EUR', period: 'unknown', basis: 'unknown' })
      // The contract requires an unavailable-evidence explanation without pinning its sentence.
      expect(updated.compensationNote).toMatch(/근거/)
      expect(updated.compensationNote).not.toBe(CONTEXT_NOTES.variants)
    }
  })

  it('keeps incomplete description salary evidence that still blocks a completeness claim', () => {
    const old: Job = {
      ...mixedBase(), compensationVersion: 3, salary: null, compensationNote: CONTEXT_NOTES.partial,
      description: `${CONTEXT_INTRO}\n${CONTEXT_SENTENCES.incompleteBase}`,
      compensationRanges: [boardComplete],
      compensationEvidence: [{ source: 'description', text: CONTEXT_SENTENCES.incompleteBase }],
    }
    const updated = upgradeJobCompensation(old)
    expect(updated.salary).toBeNull()
    expect(updated.compensationRanges).toEqual([boardComplete])
    expect(updated.compensationEvidence?.some(evidence => evidence.text.includes('up to USD 180,000'))).toBe(true)
    expect(updated.compensationVersion).toBe(COMPENSATION_VERSION)
  })
})

describe('other providers keep structured disclosures apart from the version', () => {
  it.each(['ashby', 'lever', 'smartrecruiters', 'himalayas'] as JobProvider[])('%s keeps a stored board range unchanged even with review wording and conflicting prose', source => {
    const old: Job = { ...withoutPay(posting('reviewedAnnually')), ...CONTEXT_LEGACY_PAY.greenhouseReview, source, compensationVersion: 3 }
    for (const preserve of [true, false]) expect(upgradeJobCompensation(old, preserve)).toEqual({ ...old, compensationVersion: COMPENSATION_VERSION })
    const incomplete: Job = {
      ...old, salary: null, compensationRanges: undefined, compensationNote: 'Provider did not return both bounds.',
      compensationEvidence: [{ source: 'board', text: 'Annual base salary · USD · upper bound unavailable' }],
    }
    expect(upgradeJobCompensation(incomplete)).toEqual({ ...incomplete, compensationVersion: COMPENSATION_VERSION })
  })

  const providers = ['ashby', 'lever', 'smartrecruiters', 'himalayas'] as JobProvider[]
  const boardMarker = { source: 'board' as const, text: 'Annual base salary · USD · upper bound unavailable' }

  it.each(providers.flatMap(source => [[source, 3], [source, undefined]] as [JobProvider, 3 | undefined][]))(
    'an unrelated board-only incomplete marker never establishes an unverifiable %s scalar (version %s)', (source, version) => {
      const old: Job = {
        ...withoutPay(posting('bonusOnly')), source, compensationVersion: version, salary: { min: 25000, max: 25000, currency: 'USD' },
        compensationEvidence: [boardMarker], compensationNote: 'Provider did not return both bounds.',
        description: 'This older excerpt has no compensation information.',
      }
      for (const preserve of [true, false]) {
        const updated = upgradeJobCompensation(old, preserve)
        expect(updated).toMatchObject({ id: old.id, fetchedAt: CONTEXT_TIME, source, salary: null, compensationVersion: COMPENSATION_VERSION })
        expect(updated.compensationRanges).toBeUndefined()
        expect(updated.compensationEvidence).toEqual([boardMarker])
        expect(updated.compensationNote).toBeTruthy()
        expect(formatJobSalary(updated)).toBe('보상 확인 필요')
      }
      expect(old.salary).toEqual({ min: 25000, max: 25000, currency: 'USD' })
    })

  it.each(providers)('%s mixed board row plus malformed description salary beside an equal bonus stays incomplete with the actual note', source => {
    const old: Job = {
      ...withoutPay(posting('structured')), source, compensationVersion: 3, salary: null, compensationNote: CONTEXT_NOTES.variants,
      description: `${CONTEXT_INTRO}\n${CONTEXT_SENTENCES.malformedWithEqualBonus}`,
      compensationRanges: [boardComplete, CONTEXT_LEGACY_ROWS.malformedEqualBonus],
    }
    for (const preserve of [true, false]) {
      const updated = upgradeJobCompensation(old, preserve)
      expect(updated).toMatchObject({ id: old.id, fetchedAt: CONTEXT_TIME, source, salary: null, compensationVersion: COMPENSATION_VERSION, compensationNote: CONTEXT_NOTES.partial })
      expect(updated.compensationRanges).toEqual([boardComplete])
      expect(updated.compensationEvidence?.some(evidence => evidence.source === 'description' && evidence.text.includes('EUR 20.000'))).toBe(true)
      expect(updated.compensationNote).not.toBe(CONTEXT_NOTES.variants)
    }
  })

  it.each(providers)('%s identity alone cannot exempt a description-derived signing-bonus scalar from correction', source => {
    const old: Job = { ...withoutPay(posting('bonusOnly')), source, ...CONTEXT_LEGACY_PAY.bonusOnly, compensationVersion: 3 }
    for (const preserve of [true, false]) {
      const updated = upgradeJobCompensation(old, preserve)
      expect(updated).toMatchObject({ id: old.id, fetchedAt: CONTEXT_TIME, source, salary: null, compensationVersion: COMPENSATION_VERSION, compensationNote: CONTEXT_NOTES.none })
      expect(updated.compensationRanges).toBeUndefined()
      expect(updated.compensationEvidence).toHaveLength(1)
      expect(updated.compensationEvidence![0]).toMatchObject({ source: 'description' })
      expect(updated.compensationEvidence![0].text).toContain(CONTEXT_SENTENCES.bonusOnly)
    }
    expect(old.salary).toEqual({ min: 25000, max: 25000, currency: 'USD' })
  })
})

describe('Greenhouse quote-only incomplete payloads keep their explanation only under the agreed guard', () => {
  // Agreed IR4 guard: exact payload preserved and only the version stamped when salary is null,
  // no numeric ranges exist, at least one compensation-evidence item exists, every item is
  // board-derived and the existing note is nonempty after trimming. Nothing else qualifies.
  const quoteOnlyBase = () => withoutPay(posting('structured'))
  const marker = { source: 'board' as const, text: 'Annual base salary · GBP · upper bound unavailable' }
  const customNote = 'Provider did not return both bounds.'

  it.each([undefined, 1, 2, 3] as (1 | 2 | 3 | undefined)[])('preserves the exact payload and custom note of a quote-only record at version %s', version => {
    const old: Job = { ...quoteOnlyBase(), compensationVersion: version, salary: null, compensationNote: customNote, compensationEvidence: [marker] }
    for (const preserve of [true, false]) expect(upgradeJobCompensation(old, preserve)).toEqual({ ...old, compensationVersion: COMPENSATION_VERSION })
  })

  it('keeps a whitespace-padded nonempty note byte for byte', () => {
    const note = '  Provider did not return both bounds.  '
    const old: Job = { ...quoteOnlyBase(), compensationVersion: 3, salary: null, compensationNote: note, compensationEvidence: [marker] }
    for (const preserve of [true, false]) {
      const updated = upgradeJobCompensation(old, preserve)
      expect(updated).toEqual({ ...old, compensationVersion: COMPENSATION_VERSION })
      expect(updated.compensationNote).toBe(note)
    }
  })

  it.each([['absent', undefined], ['empty', ''], ['whitespace-only', '   ']] as [string, string | undefined][])('a quote-only record with an %s note receives the standard explanation instead', (_name, note) => {
    const old: Job = { ...quoteOnlyBase(), compensationVersion: 3, salary: null, compensationNote: note, compensationEvidence: [marker] }
    for (const preserve of [true, false]) {
      const updated = upgradeJobCompensation(old, preserve)
      expect(updated).toMatchObject({ id: old.id, fetchedAt: CONTEXT_TIME, salary: null, compensationVersion: COMPENSATION_VERSION, compensationNote: CONTEXT_NOTES.none })
      expect(updated.compensationRanges).toBeUndefined()
      expect(updated.compensationEvidence).toEqual([marker])
    }
  })

  it('the same marker never stamps an unsupported scalar as current', () => {
    const old: Job = { ...quoteOnlyBase(), compensationVersion: 3, salary: { min: 25000, max: 25000, currency: 'USD' }, compensationNote: customNote, compensationEvidence: [marker] }
    for (const preserve of [true, false]) {
      const updated = upgradeJobCompensation(old, preserve)
      expect(updated).toMatchObject({ id: old.id, fetchedAt: CONTEXT_TIME, salary: null, compensationVersion: COMPENSATION_VERSION, compensationNote: CONTEXT_NOTES.none })
      expect(updated.compensationRanges).toBeUndefined()
      expect(updated.compensationEvidence).toEqual([marker])
    }
    expect(old.salary).toEqual({ min: 25000, max: 25000, currency: 'USD' })
  })

  it('without positive board evidence a real salary in the body is recovered normally', () => {
    const old: Job = { ...quoteOnlyBase(), compensationVersion: 3, salary: null, compensationNote: customNote, description: `${CONTEXT_INTRO}\nAnnual base salary: USD 100,000–120,000.` }
    for (const preserve of [true, false]) {
      const updated = upgradeJobCompensation(old, preserve)
      expect(updated).toMatchObject({ id: old.id, fetchedAt: CONTEXT_TIME, salary: usd, compensationVersion: COMPENSATION_VERSION })
      expect(updated.compensationRanges).toEqual([expect.objectContaining({ ...usd, period: 'year', basis: 'base' })])
      expect(updated.compensationEvidence).toBeUndefined()
      expect(updated.compensationNote).toBeUndefined()
    }
  })

  it('a board marker beside a description salary quote follows the ordinary per-item rules', () => {
    const old: Job = {
      ...quoteOnlyBase(), compensationVersion: 3, salary: null, compensationNote: customNote,
      compensationEvidence: [marker, { source: 'description', text: 'Annual base salary: USD 100,000–120,000.' }],
    }
    for (const preserve of [true, false]) {
      const updated = upgradeJobCompensation(old, preserve)
      expect(updated).toMatchObject({ id: old.id, fetchedAt: CONTEXT_TIME, salary: null, compensationVersion: COMPENSATION_VERSION, compensationNote: CONTEXT_NOTES.partial })
      expect(updated.compensationRanges).toEqual([expect.objectContaining({ ...usd, period: 'year', basis: 'base' })])
      expect(updated.compensationEvidence).toEqual([marker])
    }
  })
})

describe('server cache migration keeps board metadata and source age', () => {
  it('corrects version 3 pay inside a cached snapshot without refreshing the snapshot', () => {
    const twoRows: Job = { ...withoutPay(posting('bonusAfterBase')), ...CONTEXT_LEGACY_PAY.twoRows, description: `${CONTEXT_INTRO}\n${CONTEXT_SENTENCES.postfixBonus}`, compensationVersion: 3 }
    const board: Job = { ...withoutPay(posting('structured')), ...CONTEXT_LEGACY_PAY.greenhouseReview, compensationVersion: 3 }
    const incomplete = incompleteBoardJob()
    const cached: CachedBoard = {
      companyId: CONTEXT_COMPANY.id, board: CONTEXT_COMPANY.board!, provider: 'greenhouse', checkedAt: CONTEXT_TIME,
      failures: 1, retryAt: '2026-10-01T09:05:00.000Z',
      snapshot: {
        fetchedAt: CONTEXT_TIME, total: 4, unmappedCount: null, publishedIds: [twoRows.id, board.id, incomplete.id, `${board.id}-outside`],
        jobs: [twoRows as Job & { source: JobProvider }, board as Job & { source: JobProvider }, incomplete as Job & { source: JobProvider }],
      },
    }
    const [migrated] = parseCachedBoards({ version: 5, boards: [cached] })
    expect(migrated).toMatchObject({ checkedAt: CONTEXT_TIME, failures: 1, retryAt: '2026-10-01T09:05:00.000Z' })
    expect(migrated.snapshot).toMatchObject({ fetchedAt: CONTEXT_TIME, total: 4, publishedIds: cached.snapshot!.publishedIds })
    const [first, second, third] = migrated.snapshot!.jobs
    expect(first).toMatchObject({ id: twoRows.id, fetchedAt: CONTEXT_TIME, salary: usd, compensationVersion: COMPENSATION_VERSION })
    expect(first.compensationRanges).toHaveLength(1)
    expect(second).toMatchObject({ id: board.id, fetchedAt: CONTEXT_TIME, salary: null, compensationVersion: COMPENSATION_VERSION })
    expect(second.compensationRanges).toEqual([expect.objectContaining({ label: 'Salary Range', ...usd, period: 'unknown', basis: 'base' })])
    expect(third).toMatchObject({ id: incomplete.id, fetchedAt: CONTEXT_TIME, salary: null, compensationVersion: COMPENSATION_VERSION })
    expect(third.compensationRanges).toHaveLength(1)
    expect(third.compensationNote).toContain(CONTEXT_NOTES.partial)
    expect(twoRows.compensationVersion).toBe(3)
  })
})

describe('version 4 and the other basis across schema, saved records and backups', () => {
  const structured = posting('structured')

  it('pins the current version, accepts versions 1 to 4 and rejects unknown values and unknown bases', () => {
    expect(COMPENSATION_VERSION).toBe(4)
    expect(structured.compensationVersion).toBe(4)
    for (const version of [1, 2, 3, 4]) expect(JobSchema.safeParse({ ...structured, compensationVersion: version }).success).toBe(true)
    expect(JobSchema.safeParse({ ...structured, compensationVersion: undefined }).success).toBe(true)
    for (const version of [0, 5, 99]) expect(JobSchema.safeParse({ ...structured, compensationVersion: version }).success).toBe(false)
    expect(structured.compensationRanges![1].basis).toBe('other')
    expect(JobSchema.safeParse({ ...structured, compensationRanges: [{ ...structured.compensationRanges![1], basis: 'bonus' }] }).success).toBe(false)
  })

  it('decodes saved records from every accepted version, corrects recoverable ones and drops a future version', () => {
    const base = withoutPay(posting('bonusAfterBase'))
    const decoded = decodeSavedJobs(JSON.stringify([
      record({ ...base, salary: null, compensationVersion: 1 }, 'greenhouse-fixture-quill-atlas-v1'),
      record({ ...base, ...CONTEXT_LEGACY_PAY.twoRows, description: `${CONTEXT_INTRO}\n${CONTEXT_SENTENCES.postfixBonus}`, compensationVersion: 2 }, 'greenhouse-fixture-quill-atlas-v2'),
      record({ ...withoutPay(posting('bonusOnly')), ...CONTEXT_LEGACY_PAY.bonusOnly, compensationVersion: 3 }, 'greenhouse-fixture-quill-atlas-v3'),
      record(structured, 'greenhouse-fixture-quill-atlas-v4'),
      record({ ...structured, compensationVersion: 5 as unknown as Job['compensationVersion'] }, 'greenhouse-fixture-quill-atlas-v5'),
    ]))
    expect(decoded.omitted).toBe(1)
    expect(decoded.reason).toBe('records')
    expect(decoded.records.map(item => item.job.id)).toEqual([
      'greenhouse-fixture-quill-atlas-v1', 'greenhouse-fixture-quill-atlas-v2', 'greenhouse-fixture-quill-atlas-v3', 'greenhouse-fixture-quill-atlas-v4',
    ])
    for (const item of decoded.records) expect(item).toMatchObject({ savedAt, status: 'applied', job: { compensationVersion: COMPENSATION_VERSION, fetchedAt: CONTEXT_TIME } })
    expect(decoded.records[0].job.salary).toEqual(usd)
    expect(decoded.records[1].job.salary).toEqual(usd)
    expect(decoded.records[1].job.compensationRanges).toHaveLength(1)
    expect(decoded.records[2].job).toMatchObject({ salary: null, compensationNote: CONTEXT_NOTES.none })
    expect(decoded.records[2].job.compensationEvidence).toHaveLength(1)
    expect(decoded.records[3].job.salary).toEqual(usd)
    expect(decoded.records[3].job.compensationRanges![1]).toMatchObject({ basis: 'other', period: 'unknown' })
    expect(decoded.records[2].note).toBe('note greenhouse-fixture-quill-atlas-v3')
  })

  it('round-trips an other row through a portable backup file with its display string intact', () => {
    const saved = record(structured, structured.id, 'Keep the structured base and bonus')
    const parsed = parseSavedImport(createSavedBackup([saved], 0, new Date(savedAt)))
    expect(parsed).toMatchObject({ format: 'backup', invalid: 0 })
    const restored = parsed.groups[0].variants[0]
    expect(restored.job.salary).toEqual(usd)
    expect(restored.job.compensationRanges![1]).toMatchObject({ label: 'Signing bonus', min: 25000, max: 25000, currency: 'USD', period: 'unknown', basis: 'other' })
    expect(formatCompensation(restored.job.compensationRanges![1])).toBe(`USD 25,000–25,000 / 기간 미확인${OTHER_SUFFIX}`)
    expect(restored.note).toBe('Keep the structured base and bonus')
  })
})
