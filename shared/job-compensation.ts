import { INCOMPLETE_SALARY, normalizeCompensation, NO_COMPARABLE_PAY } from './compensation'
import type { CompensationInput, SalaryData } from './compensation'
import { structuredPayContext } from './pay-context'
import { payNumberMentions } from './pay-numbers'
import { analyzeTextCompensation, compensationFromAnalysis } from './pay-text'
import type { TextCompensationAnalysis } from './pay-text'
import { COMPENSATION_VERSION } from './types'
import type { CompensationRange, FactEvidence, Job } from './types'

const BOARD_CONTEXT_UNAVAILABLE = '이전 게시판 보상의 기간·구성 근거가 충분하지 않아 확인된 금액과 원문만 유지합니다.'
const TEXT_CONTEXT_UNAVAILABLE = '이전 조회 본문에서 보상 근거를 다시 확인하지 못했어요. 원문을 확인해 주세요.'
const whitespace = (text: string) => text.replace(/\s+/g, ' ').trim()
const rangeInput = (range: CompensationRange): CompensationInput => ({ ...range, interval: range.period })

function appendEvidence(pay: SalaryData, evidence: FactEvidence[]) {
  const distinct = new Map([...(pay.compensationEvidence ?? []), ...evidence].map(item => [`${item.source}|${item.text}`, item]))
  if (distinct.size) pay.compensationEvidence = [...distinct.values()].slice(0, 20)
}

function appendNote(pay: SalaryData, note: string) {
  if (!pay.compensationNote?.includes(note)) pay.compensationNote = [pay.compensationNote, note].filter(Boolean).join(' ').slice(0, 1000)
}

function greenhouseRange(range: CompensationRange): { input: CompensationInput; demoted: boolean } {
  const quote = range.evidence?.source === 'board' ? range.evidence.text : ''
  const label = range.label.trim()
  const generated = /^(?:기본 급여|게시판의 급여 범위|보상 구간 \d+|Greenhouse)$/i.test(label)
  const firstLine = quote.split(/\r\n?|\n/, 1)[0]?.trim() ?? ''
  const labelAtLimit = range.label.length >= 500
  const quoteComplete = quote.length > 0 && quote.length < 2000
  const titleMatches = labelAtLimit
    ? quoteComplete && whitespace(firstLine).startsWith(whitespace(label))
    : whitespace(firstLine) === whitespace(label)
  const attributable = !!label && !generated && titleMatches
  const title = attributable ? firstLine : ''
  const blurb = attributable ? quote.slice(quote.indexOf(firstLine) + firstLine.length).trim() : quote
  const derived = structuredPayContext(title, blurb)
  const complete = attributable && !labelAtLimit && quoteComplete
  if (complete) return { input: { ...rangeInput(range), basis: derived.basis, interval: derived.period }, demoted: false }
  // Only an identifiable complete native title can support old metadata when
  // the rest of the source is missing. Unknown never becomes an annual claim.
  const ownTitle = structuredPayContext(title, '')
  const basis = ownTitle.basis === 'other' ? 'other'
    : attributable && range.basis !== 'unknown' && ownTitle.basis === range.basis && derived.basis === range.basis
      ? range.basis : 'unknown'
  const period = attributable && range.period !== 'unknown'
    && ownTitle.period === range.period && derived.period === range.period ? range.period : 'unknown'
  return {
    input: { ...rangeInput(range), basis, interval: period },
    demoted: basis !== range.basis || period !== range.period,
  }
}

/** A range-owned quote and an unambiguous whole envelope, never numeric equality alone. */
function refutesRange(range: CompensationRange, analysis: TextCompensationAnalysis): boolean {
  if (range.evidence?.source !== 'description') return false
  if (analysis.inputs.some(input => input.min == null || input.max == null)) return false
  const rejected = analysis.rejected.filter(item => item.mention.min === range.min && item.mention.max === range.max)
  const salaryMatches = analysis.inputs.filter(item => item.min === range.min && item.max === range.max)
  // Equal envelopes in one quote, even in different currencies, are ambiguous.
  const envelopes = payNumberMentions(range.evidence.text).filter(item => item.min === range.min && item.max === range.max)
  return rejected.length === 1 && salaryMatches.length === 0 && envelopes.length === 1
}

function descriptionRange(range: CompensationRange): {
  inputs: CompensationInput[]; rejected: FactEvidence[]; unavailable: boolean
} {
  if (range.evidence?.source !== 'description' || !range.evidence.text.trim()) return {
    inputs: [{ ...rangeInput(range), basis: 'unknown', interval: 'unknown' }], rejected: [], unavailable: true,
  }
  const analysis = analyzeTextCompensation(range.evidence.text)
  const refuted = refutesRange(range, analysis)
  // Actual salary, including malformed bounds, must survive a bonus in this
  // same quote. A rejected component cannot prevent ordinary numeric recovery.
  if (analysis.inputs.length) return {
    inputs: analysis.inputs, rejected: refuted ? [range.evidence] : [], unavailable: false,
  }
  if (refuted) return { inputs: [], rejected: [range.evidence], unavailable: false }
  return { inputs: [{ ...rangeInput(range), basis: 'unknown', interval: 'unknown' }], rejected: [], unavailable: true }
}

function structuredMigration(job: Job): SalaryData {
  const inputs: CompensationInput[] = []
  const rejected: FactEvidence[] = []
  let boardDemoted = false
  let textUnavailable = false
  for (const range of job.compensationRanges ?? []) {
    if (range.evidence?.source === 'description') {
      const corrected = descriptionRange(range)
      inputs.push(...corrected.inputs)
      rejected.push(...corrected.rejected)
      textUnavailable ||= corrected.unavailable
    } else if (job.source === 'greenhouse') {
      const corrected = greenhouseRange(range)
      inputs.push(corrected.input)
      boardDemoted ||= corrected.demoted
    } else inputs.push(rangeInput(range))
  }
  for (const evidence of job.compensationEvidence ?? []) {
    if (evidence.source === 'description') {
      const analysis = analyzeTextCompensation(evidence.text)
      if (analysis.inputs.length) inputs.push(...analysis.inputs)
      else if (analysis.rejected.length) rejected.push(evidence)
      else inputs.push({ evidence })
    } else {
      // This quote represented unavailable bounds. A different range cannot
      // supply its missing endpoints.
      const basis = structuredPayContext(evidence.text.split(/\r\n?|\n/, 1)[0] ?? '', '').basis
      inputs.push({ evidence, basis: basis === 'other' ? 'other' : 'unknown' })
    }
  }
  // Old normalization did not preserve every incomplete input or its count.
  // Even a recovered bonus quote cannot account for an omitted salary item.
  // Fresh provider ingestion can resolve this; retained fragments cannot.
  const legacyIncomplete = job.compensationNote?.includes(INCOMPLETE_SALARY)
  if (legacyIncomplete) {
    inputs.push({})
  }
  const pay = normalizeCompensation(inputs)
  appendEvidence(pay, rejected)
  if (legacyIncomplete) pay.compensationNote = job.compensationNote
  if (boardDemoted) appendNote(pay, BOARD_CONTEXT_UNAVAILABLE)
  if (textUnavailable) appendNote(pay, TEXT_CONTEXT_UNAVAILABLE)
  if (!inputs.length && rejected.length) pay.compensationNote = NO_COMPARABLE_PAY
  return pay
}

/** Recheck derived pay against retained sources; never change collection/user metadata. */
export function upgradeJobCompensation<T extends Job>(job: T, preserveUnverifiable = false): T {
  if (job.source === 'sample' || job.compensationVersion === COMPENSATION_VERSION) return job
  const ranges = job.compensationRanges ?? []
  const evidence = [...ranges.flatMap(range => range.evidence ? [range.evidence] : []), ...(job.compensationEvidence ?? [])]
  const hasBoard = evidence.some(item => item.source === 'board')
    || job.source === 'greenhouse' && !!job.compensationVersion && ranges.some(range => !range.evidence)
  const structuredProvider = ['ashby', 'lever', 'smartrecruiters', 'himalayas'].includes(job.source)
  const boardOnly = evidence.length > 0
    && ranges.every(range => range.evidence?.source === 'board')
    && evidence.every(item => item.source === 'board')
  if (job.source === 'greenhouse' && boardOnly && !ranges.length
    && job.salary === null && job.compensationNote?.trim()) {
    // Quote-only incomplete records have no numeric metadata to re-derive.
    // Preserve their specific explanation; unexplained quotes still normalize.
    return { ...job, compensationVersion: COMPENSATION_VERSION }
  }
  if (structuredProvider && boardOnly) {
    // Preserve explicit provider payloads, including the reason bounds are
    // missing. A board marker alone cannot establish an unrelated scalar.
    const supported = normalizeCompensation(ranges.map(rangeInput)).salary
    const scalarSupported = !job.salary || !job.compensationEvidence?.length && supported
      && job.salary.min === supported.min && job.salary.max === supported.max
      && job.salary.currency === supported.currency
    if (scalarSupported) return { ...job, compensationVersion: COMPENSATION_VERSION }
  }
  let pay: SalaryData
  if (hasBoard) pay = structuredMigration(job)
  else if (!job.compensationVersion && job.source !== 'greenhouse' && ranges.length) {
    // Early provider snapshots already retained explicit structured intervals.
    pay = normalizeCompensation(ranges.map(rangeInput))
    if (!job.salary) {
      pay.salary = null
      pay.compensationNote = job.compensationNote || pay.compensationNote
    }
  } else {
    const body = whitespace(job.description)
    const quotes = [...new Set(evidence.filter(item => item.source === 'description'
      && !item.text.split(/\r\n?|\n/).filter(line => line.trim()).every(line => body.includes(whitespace(line))))
      .map(item => item.text))]
    const analyses = [analyzeTextCompensation(job.description), ...quotes.map(analyzeTextCompensation)]
    const analysis = { inputs: analyses.flatMap(item => item.inputs), rejected: analyses.flatMap(item => item.rejected) }
    pay = compensationFromAnalysis(analysis)
    const refuted = ranges.filter(range => range.evidence?.source === 'description'
      && refutesRange(range, analyzeTextCompensation(range.evidence.text)))
    appendEvidence(pay, refuted.flatMap(range => range.evidence ? [range.evidence] : []))
    if (!analysis.inputs.length) {
      // A bonus in a truncated body, or another item's quote, cannot refute an
      // unrelated scalar. That scalar must belong to the refuted range.
      const refutedScalar = refuted.some(range => job.salary && range.min === job.salary.min
        && range.max === job.salary.max && range.currency === job.salary.currency)
      if (preserveUnverifiable && job.salary && !refutedScalar) return job
      if (refuted.length) {
        pay.compensationNote = NO_COMPARABLE_PAY
      } else if (!pay.compensationEvidence?.length) {
        if (job.compensationNote) pay.compensationNote = job.compensationNote
        else if (job.salary) pay.compensationNote = TEXT_CONTEXT_UNAVAILABLE
      }
    }
  }
  const { salary: _salary, compensationRanges: _ranges, compensationNote: _note, compensationEvidence: _evidence, ...original } = job
  return { ...original, ...pay, compensationVersion: COMPENSATION_VERSION } as T
}
