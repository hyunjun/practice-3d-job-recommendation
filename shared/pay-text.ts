import { normalizeCompensation, NO_COMPARABLE_PAY } from './compensation'
import { amountOwner, amountPeriod, contextBasis, OTHER_COMPONENT, PAY_SUBJECT, payClauses, structuredPayContext } from './pay-context'
import { PAY_CURRENCY_CODES as CODES, payNumberMentions as mentions } from './pay-numbers'
import type { PayNumberMention as Mention } from './pay-numbers'
import type { CompensationInput, SalaryData } from './compensation'
import type { CompensationRange, FactEvidence } from './types'

const PAY = PAY_SUBJECT
const GEO_NAME = String.raw`United States|U\.?S\.?A?\.?|United Kingdom|U\.?K\.?|Canada|Canadian|Europe|European|EMEA|APAC|Americas?|Portugal|Germany|France|Ireland|Australia|Singapore|Japan|Korea|India|California|Colorado|Washington|New York|San Francisco|Seattle|NYC|London|Berlin|Toronto|Vancouver|Lisbon|Dublin`
const GEO = new RegExp(String.raw`\b(?:${GEO_NAME})\b`, 'i')
const GEO_LABEL = new RegExp(String.raw`^(?:${GEO_NAME})(?:\s*(?:,|/|&|and)\s*(?:${GEO_NAME}))*(?:\s*\((?:${CODES})\))?$`, 'i')
const ONE_SIDED = /\b(?:up to|from|starting (?:at|from)|at least|minimum of|maximum of|more than|over)\s*$/i
const MAX_TEXT = 100000

export function payPeriod(text: string): CompensationRange['period'] {
  return structuredPayContext('', text).period
}

export function payBasis(text: string): NonNullable<CompensationRange['basis']> {
  return contextBasis(text)
}

/** Only a specific eligibility phrase or geographic pay heading creates a restriction. */
export function payScope(text: string): string | undefined {
  const clauses = text.split(/\r\n?|\n|(?<=[.!?])\s+/).map(line => line.trim()).filter(Boolean)
  const explicit = payClauses(text).map(clause => clause.text.trim()).find(line =>
    /\bfor\b[^;\n]{1,120}\bbased (?:hires|employees|candidates|positions|roles)\b/i.test(line)
    || (GEO.test(line) && /\b(?:only|residents of|based in|based candidates|based employees|based hires)\b/i.test(line) && PAY.test(line)),
  )
  if (explicit) return explicit.slice(0, 500)
  return clauses.find(line => line.length < 160 && GEO.test(line) && /\b(?:salary|pay) (?:range|band)\b/i.test(line))?.slice(0, 500)
}

function currencyOf(markers: string[], localText: string): string | null {
  const aliases: Record<string, string> = {
    'US$': 'USD', 'CA$': 'CAD', 'C$': 'CAD', 'AU$': 'AUD', 'A$': 'AUD', 'SG$': 'SGD', 'S$': 'SGD',
    'NZ$': 'NZD', 'HK$': 'HKD', 'R$': 'BRL', '€': 'EUR', '£': 'GBP', '₩': 'KRW',
  }
  const named = (values: string[]) => [...new Set(values.flatMap(value => aliases[value.toUpperCase()]
    ? [aliases[value.toUpperCase()]] : new RegExp(`^(?:${CODES})$`, 'i').test(value) ? [value.toUpperCase()] : []))]
  const direct = named(markers)
  const contextCodes = [...localText.matchAll(new RegExp(`\\b(?:${CODES})\\b|US dollars|U\\.S\\. dollars|Canadian dollars|Australian dollars|Singapore dollars`, 'gi'))]
    .map(match => ({ 'us dollars': 'USD', 'u.s. dollars': 'USD', 'canadian dollars': 'CAD', 'australian dollars': 'AUD', 'singapore dollars': 'SGD' }[match[0].toLowerCase()] ?? match[0]))
  const candidates = direct.length ? direct : named(contextCodes)
  if (candidates.length !== 1) return null
  if (markers.includes('$') && !['USD', 'CAD', 'AUD', 'SGD', 'NZD', 'HKD', 'MXN'].includes(candidates[0])) return null
  if (markers.includes('¥') && !['JPY', 'CNY'].includes(candidates[0])) return null
  return candidates[0]
}

function contextOf(text: string, mention: Mention, clauseSpan: { start: number; end: number }, previous?: Mention, next?: Mention) {
  const lineStart = Math.max(text.lastIndexOf('\n', mention.index), text.lastIndexOf('\r', mention.index)) + 1
  const nextLine = text.slice(mention.end).search(/[\r\n]/)
  const lineEnd = nextLine < 0 ? text.length : mention.end + nextLine
  const start = Math.max(lineStart, clauseSpan.start)
  const end = Math.min(lineEnd, clauseSpan.end)
  const clause = text.slice(start, end).trim().slice(0, 1600)
  const before = text.slice(Math.max(start, mention.index - 1600), mention.index)
  const segmentBefore = previous && previous.end >= start ? text.slice(previous.end, mention.index).slice(-1600) : before
  const after = text.slice(mention.end, Math.min(end, next && next.index < end ? next.index : end, mention.end + 1600))
  const preceding = text.slice(Math.max(0, lineStart - 2200), lineStart).split(/\r\n?|\n/).map(line => line.trim()).filter(Boolean).slice(-3)
  const last = preceding.at(-1) ?? ''
  const bare = !before.trim() || new RegExp(`^(?:${CODES})\\s*:?\\s*$`, 'i').test(before.trim())
  const inherited = bare && (PAY.test(last) || OTHER_COMPONENT.test(last)) ? last : ''
  // Immediate headings only. A benefit paragraph must not disappear from the
  // evidence while an older salary heading crosses it.
  const heading = last.length < 160 && PAY.test(last) && !mentions(last).length && !OTHER_COMPONENT.test(last) ? last : ''
  const context = [inherited || heading, clause].filter(Boolean).join('\n')
  // Keep the existing geographic eligibility policy separate from the new
  // amount-owner boundaries. A whole line could lend another range its scope.
  const scopeStart = Math.max(lineStart, mention.index - 1600)
  const scopeEnd = Math.min(lineEnd, mention.end + 1600)
  const scopeBoundaries = [...text.slice(scopeStart, scopeEnd).matchAll(/[.!?;]\s+(?=[A-Z])/g)]
    .map(match => scopeStart + match.index + match[0].length)
  const scopeClauseStart = scopeBoundaries.filter(index => index <= mention.index).at(-1) ?? scopeStart
  const scopeClauseEnd = scopeBoundaries.find(index => index > mention.end) ?? scopeEnd
  const scopeContext = [inherited || heading, text.slice(scopeClauseStart, scopeClauseEnd).trim().slice(0, 1600)].filter(Boolean).join('\n')
  const evidence = context.slice(0, 2000)
  const sameBandTail = next && next.index < end
    && new RegExp(`^\\s*(?:[-–—]|to|through)\\s*(?:${CODES})?\\s*$`, 'i').test(after)
    ? text.slice(mention.end, Math.min(end, next.end + 180)) : ''
  return { lineStart, clause, before, segmentBefore, after, sameBandTail, bare, inherited, heading, context, scopeContext, evidence }
}

function geographicLabel(prefix: string): string | undefined {
  const label = prefix.replace(ONE_SIDED, '').trim()
    .replace(/^[\s*•\-–—]+/, '').replace(/^[\p{Regional_Indicator}\uFE0F]+\s*/u, '')
    .replace(/:\s*$/, '').trim()
  return /:\s*(?:up to|from|starting (?:at|from)|at least|minimum of|maximum of|more than|over)?\s*$/i.test(prefix)
    && GEO_LABEL.test(label) ? label : undefined
}

function sectionHeading(line: string): boolean {
  const text = line.replace(/^[#*\s]+/, '').replace(/[:*\s]+$/, '')
  return text.length > 0 && text.length <= 100 && !/[.!?;\d$€£]/.test(text)
    && (text === text.toUpperCase() || text.split(/\s+/).every(word => /^[A-Z][A-Za-z'-]*$/.test(word) || /^(?:&|\/|and|by|for|of|the|in)$/.test(word)))
}

/** A country row may inherit pay context, but never a currency from another row. */
function geographicPayContext(text: string, lineStart: number): { text: string; evidence: string } | undefined {
  const lines = text.slice(Math.max(0, lineStart - 5000), lineStart).split(/\r\n?|\n/).map(line => line.trim()).filter(Boolean).slice(-20)
  const context: string[] = []
  const evidence: string[] = []
  let otherParagraphs = 0
  for (const line of lines.reverse()) {
    const firstAmount = mentions(line)[0]
    if (firstAmount && geographicLabel(line.slice(0, firstAmount.index))) continue
    if (OTHER_COMPONENT.test(line) && !PAY.test(line)) break
    const heading = sectionHeading(line)
    if (heading && !PAY.test(line)) break
    if (PAY.test(line)) {
      context.unshift(line)
      evidence.unshift(line)
      if (heading) break
    } else if (/[$€£¥₩]|\b(?:equity|stocks?|bonus(?:es)?|stipends?|allowances?|budgets?|reimbursements?|funding|valuation|revenue|donations?|benefits?)\b/i.test(line) || ++otherParagraphs > 2) break
    else evidence.unshift(line)
  }
  if (!context.length) return undefined
  return { text: context.join('\n'), evidence: evidence.slice(evidence.indexOf(context[0])).join('\n') }
}

export interface RejectedPay {
  mention: Mention
  kind: 'other' | 'change'
  apparentPay: boolean
  evidence: FactEvidence
}

export interface TextCompensationAnalysis {
  inputs: CompensationInput[]
  rejected: RejectedPay[]
}

/** Actual salary candidates and positively rejected components are separate facts. */
export function analyzeTextCompensation(input: string): TextCompensationAnalysis {
  const text = input.slice(0, MAX_TEXT)
  const found = mentions(text)
  const clauses = payClauses(text)
  const inputs: CompensationInput[] = []
  const rejected: RejectedPay[] = []
  let clauseIndex = 0
  let previousOwner: { clause: number; text: string; salary: boolean } | undefined
  for (const [index, mention] of found.slice(0, 100).entries()) {
    while (clauseIndex < clauses.length - 1 && clauses[clauseIndex].end <= mention.index) clauseIndex++
    const details = contextOf(text, mention, clauses[clauseIndex] ?? { start: 0, end: text.length }, found[index - 1], found[index + 1])
    if (/\(\s*accomplished:\s*~?\s*$/i.test(details.segmentBefore)) continue
    const geography = geographicLabel(details.before)
    const regional = geography ? geographicPayContext(text, details.lineStart) : undefined
    const labelText = regional ? geography! : details.bare ? details.inherited : details.segmentBefore.trim() || details.before.trim()
    const continuation = previousOwner?.clause === clauseIndex && previousOwner.salary
      && (new RegExp(`^[\\s,]*(?:(?:and|or|to|through)|[-–—])\\s*(?:${CODES})?\\s*$`, 'i').test(details.segmentBefore)
        || /^\s+in (?:our |the )?(?:lowest|highest) geographic market to\s*$/i.test(details.segmentBefore))
      ? previousOwner.text : ''
    const heading = continuation || regional?.text || details.inherited || details.heading
    const owner = amountOwner(details.segmentBefore, mention.raw, details.after, heading)
    previousOwner = { clause: clauseIndex, text: owner.text + (continuation ? `\n${continuation}` : ''), salary: !['other', 'change', 'irrelevant'].includes(owner.owner) }
    const evidence: FactEvidence = { source: 'description', text: regional ? `${regional.evidence}\n${details.clause}`.slice(-2000) : details.evidence }
    if (owner.owner === 'other' || owner.owner === 'change') {
      rejected.push({ mention, kind: owner.owner, apparentPay: owner.apparentPay || PAY.test(details.before), evidence })
      continue
    }
    if (owner.owner === 'irrelevant') continue
    const basis = owner.owner
    const unitContext = details.sameBandTail ? `${owner.text}\n${details.sameBandTail}` : owner.text
    const interval = owner.ambiguous || basis === 'unknown' && /\b(?:reviews?|discussions?|growth)\b/i.test(labelText)
      ? 'unknown' : amountPeriod(unitContext, heading)
    // A one-sided offer is not an exact salary. Keep the quote without inventing the other bound.
    const partial = mention.single && ONE_SIDED.test(details.before)
    const scope = regional ? geography : payScope(details.scopeContext)
    const currencyContext = regional && /\(accomplished:\s*~?/i.test(details.clause) && !OTHER_COMPONENT.test(details.clause)
      ? details.clause : [owner.text, heading].filter(Boolean).join('\n')
    inputs.push({
      label: labelText.replace(/[:\s]+$/, '').slice(0, 180) || '공고의 보상 범위',
      min: partial ? null : mention.min, max: mention.max,
      currency: currencyOf(mention.markers, currencyContext),
      interval, basis, ...(scope ? { scope } : {}), evidence,
    })
  }
  if ((found.length > 100 || input.length > MAX_TEXT) && inputs.length) inputs.push({
    evidence: { source: 'description', text: inputs[0].evidence!.text },
  })
  return { inputs, rejected }
}

export function textCompensationInputs(input: string): CompensationInput[] {
  return analyzeTextCompensation(input).inputs
}

export function rejectedPayEvidence(analysis: TextCompensationAnalysis): FactEvidence[] {
  return [...new Map(analysis.rejected.filter(item => item.apparentPay).map(item => [item.evidence.text, item.evidence])).values()].slice(0, 20)
}

export function compensationFromAnalysis(analysis: TextCompensationAnalysis): SalaryData {
  const pay = normalizeCompensation(analysis.inputs)
  if (analysis.inputs.length) return pay
  const evidence = rejectedPayEvidence(analysis)
  return evidence.length ? { salary: null, compensationEvidence: evidence, compensationNote: NO_COMPARABLE_PAY } : pay
}

export function parseTextCompensation(text: string): SalaryData {
  return compensationFromAnalysis(analyzeTextCompensation(text))
}
