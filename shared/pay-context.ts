import type { CompensationRange } from './types'

export const PAY_SUBJECT = /\b(?:salar(?:y|ies)|compensation|remuneration|base (?:pay|range)|pay (?:range|rate|band)|hourly (?:pay|rate)|on[- ]target earnings|OTE)\b/i
const PAY_NOUN = String.raw`(?:salar(?:y|ies)|compensation|remuneration|(?:base |hourly )?pay|rate|on[- ]target earnings|OTE)`
const COMPONENT = String.raw`(?:bonuses|bonus|equity|stocks?(?: (?:options?|grants?))?|RSUs?|commissions?|stipends?|allowances?|budgets?|reimbursements?)`
export const OTHER_COMPONENT = new RegExp(String.raw`\b${COMPONENT}\b`, 'i')
const TOTAL = /\b(?:total (?:annual |cash |target )?(?:compensation|pay|remuneration)|on[- ]target earnings|OTE)\b/i
const BASE = /\b(?:salar(?:y|ies)|base (?:pay|range)|hourly (?:pay|rate)|pay rate)\b/i
const STRONG_BASE = /\bbase (?:salary|pay|range)\b/i
const EXCLUSION = String.raw`(?:excluding|excludes?|exclusive of|not including|does not include|do not include|before)`
const UNIT = String.raw`(?:annual(?:ized|ly)?|yearly|monthly|weekly|daily|hourly|per (?:year|annum|month|week|day|hour)|(?:a|an|each) (?:year|month|week|day|hour)|p\.a\.)`
const CADENCE_EVENT = String.raw`(?:reviews?|reviewed|reviewing|discussions?|adjustments?|adjusted|increases?|increased|growth|vesting|vests?|vested)`
const CADENCE_NOUN = String.raw`(?:reviews?|discussions?|adjustments?|increases?|growth|vesting)`
type Period = CompensationRange['period']
type Basis = NonNullable<CompensationRange['basis']>
export type PayOwner = Basis | 'change' | 'irrelevant'

/** Preserve positions while hiding a bounded, nonmonetary exclusion qualifier. */
export function withoutExclusions(text: string): string {
  return text.replace(new RegExp(String.raw`(?:\([^()\n]{0,70}\b${EXCLUSION}\b[^()\n$€£¥₩\d]{0,150}\)|\b${EXCLUSION}\b[^:;.\n$€£¥₩\d]{0,150})`, 'gi'),
    match => OTHER_COMPONENT.test(match) ? ' '.repeat(match.length) : match)
}

/** Composition parentheses do not introduce a separate amount owner. */
function withoutInclusionParentheses(text: string): string {
  return text.replace(/\([^()\n$€£¥₩\d]*\bincluding\b[^()\n$€£¥₩\d]*\)/gi, match => ' '.repeat(match.length))
}

/** Case-independent sentence boundaries, with numeric punctuation and abbreviations intact. */
export function payClauses(text: string): { start: number; end: number; text: string }[] {
  const spans: { start: number; end: number; text: string }[] = []
  let start = 0
  const boundary = /\r\n?|\n|;|[.!?](?=\s|$)/g
  for (const match of text.matchAll(boundary)) {
    const index = match.index
    if (match[0] === '.' && /(?:\bp\.a\.|\bU\.S\.(?:A\.)?|\bU\.K\.|\bD\.C\.|\be\.g\.|\bi\.e\.|\bSr\.)$/i.test(text.slice(Math.max(start, index - 8), index + 1))) continue
    const end = index + match[0].length
    spans.push({ start, end, text: text.slice(start, end) })
    start = end
  }
  if (start < text.length) spans.push({ start, end: text.length, text: text.slice(start) })
  return spans
}

function changeSubject(text: string): boolean {
  return new RegExp(String.raw`\b${PAY_NOUN}\s+(?:increase|increment|adjustment)\b`, 'i').test(text)
    || new RegExp(String.raw`\b${PAY_NOUN}[^;.\n]{0,60}\b(?:increased|adjusted|raised)\b[^;.\n]{0,30}\bby\s*$`, 'i').test(text)
}

function reviewSubject(text: string): boolean {
  return new RegExp(String.raw`\b${PAY_NOUN}\s+(?:reviews?|discussions?|growth)\b`, 'i').test(text)
}

function includesComponents(text: string): boolean {
  const cleaned = withoutExclusions(text).replace(/\b(?:may|might|could)\s+(?:also\s+)?include\b/gi, '')
  return new RegExp(String.raw`\b(?:includes?|including|inclusive of)\b[^;.\n]{0,80}\b${COMPONENT}\b`, 'i').test(cleaned)
}

function salaryIncludesComponents(text: string): boolean {
  const cleaned = withoutExclusions(text)
  if (!includesComponents(cleaned)) return false
  for (const match of cleaned.matchAll(/\b(?:includes?|including|inclusive of)\b/gi)) {
    const before = cleaned.slice(0, match.index)
    const subject = [...before.matchAll(/\b(?:salary|base pay|compensation|remuneration|pay range|on[- ]target earnings|OTE)\b/gi)].at(-1)
    if (!subject) continue
    if (new RegExp(String.raw`\b${COMPONENT}\s*$`, 'i').test(before.slice(0, subject.index))) continue
    const relation = before.slice(subject.index + subject[0].length)
    if (/\b(?:parts?|components?|packages?|rewards|benefits|may|might|could)\b/i.test(relation)) continue
    if (OTHER_COMPONENT.test(cleaned.slice(match.index + match[0].length, match.index + match[0].length + 80))) return true
  }
  return false
}

/** For an owned title/clause, not a whole job's unrelated compensation prose. */
export function contextBasis(text: string): Basis {
  const cleaned = withoutExclusions(text)
  if (reviewSubject(cleaned) || changeSubject(cleaned)) return 'unknown'
  const component = OTHER_COMPONENT.exec(cleaned)
  const pay = PAY_SUBJECT.exec(cleaned)
  if (component && (!pay || component.index < pay.index) && !BASE.test(cleaned) && !TOTAL.test(cleaned)) return 'other'
  if (TOTAL.test(cleaned) || PAY_SUBJECT.test(cleaned) && includesComponents(cleaned)) return 'total'
  if (BASE.test(cleaned)) return 'base'
  if (OTHER_COMPONENT.test(cleaned) && !PAY_SUBJECT.test(cleaned)) return 'other'
  return 'unknown'
}

function ownerBefore(text: string): { owner: PayOwner; index: number; strong: boolean } {
  // Resolve the monetary object before hiding nonmonetary exclusion wording.
  // The relation must attach directly to the component: a later salary
  // predicate ("including bonuses is in the range of") belongs to the whole.
  const componentValue = new RegExp(String.raw`\b${COMPONENT}(?: (?:compensation|pay|payments?))?\s+(?:of|worth|valued at|amounting to)\s+(?:(?:up to|at least|approximately|about|around|from|over|more than|less than|maximum of|minimum of)\s+)?$`, 'i').exec(text)
  if (componentValue) return { owner: 'other', index: componentValue.index, strong: false }
  const cleaned = withoutInclusionParentheses(withoutExclusions(text))
  const subjects = [...cleaned.matchAll(new RegExp(String.raw`\b(?:total (?:annual |cash |target )?(?:compensation|pay|remuneration)|on[- ]target earnings(?: compensation)?|OTE(?: compensation)?|base (?:salary|pay|range)|hourly (?:pay|rate)|salar(?:y|ies)|compensation|remuneration|pay (?:range|rate|band)|${COMPONENT}(?: (?:compensation|pay|payments?))?)\b`, 'gi'))]
  const last = subjects.at(-1)
  if (!last) return { owner: 'irrelevant', index: 0, strong: false }
  const part = cleaned.slice(last.index)
  const isOther = OTHER_COMPONENT.test(last[0])
  if (isOther) {
    // A component inside an affirmative combined-salary label describes composition.
    if (salaryIncludesComponents(cleaned) || TOTAL.test(cleaned) && includesComponents(cleaned)) return { owner: 'total', index: 0, strong: false }
    return { owner: 'other', index: last.index, strong: false }
  }
  // OTE followed by a parenthetical expansion or "/Base compensation" still
  // names a total-pay disclosure; the later generic noun is not a new amount.
  const totalOwner = TOTAL.test(cleaned) && !/\b(?:plus|and|with)\s+(?:an?\s+)?(?:annual\s+)?base (?:salary|pay)\b/i.test(cleaned)
  const owner = changeSubject(part) ? 'change' : reviewSubject(part) ? 'unknown' : totalOwner ? 'total' : contextBasis(part)
  return { owner, index: last.index, strong: STRONG_BASE.test(last[0]) && !/\b(?:competitive|negotiable|commensurate)\b/i.test(part) }
}

function directAfter(text: string): PayOwner | undefined {
  // A connector or payment/review predicate is not a component noun attached to this amount.
  const value = text.replace(/^[\s(]+/, '').replace(/^(?:in|of|as|for)\s+(?:an?\s+)?/i, '')
  const modifier = String.raw`(?:(?:annual|yearly|monthly|weekly|daily|hourly|cash|target|discretionary|additional|performance|sign[- ]on|signing|base|total)\s+)*`
  const other = new RegExp(String.raw`^${modifier}${COMPONENT}\b`, 'i').exec(value)
  if (other && !/^\s+(?:eligible|eligibility|percentage)\b/i.test(value.slice(other[0].length))) return 'other'
  const pay = new RegExp(String.raw`^${modifier}${PAY_NOUN}\b`, 'i').exec(value)
  return pay ? contextBasis(pay[0]) : undefined
}

export interface AmountOwner {
  owner: PayOwner
  ambiguous: boolean
  /** Local owner phrase used for currency and period, without a different component. */
  text: string
  apparentPay: boolean
}

/** Resolve both sides of one money envelope; the caller supplies bounded same-clause slices. */
export function amountOwner(before: string, raw: string, after: string, heading = ''): AmountOwner {
  const leading = ownerBefore(before)
  const following = directAfter(after)
  const inherited = PAY_SUBJECT.test(heading) ? { owner: contextBasis(heading) } : ownerBefore(heading)
  const apparentPay = PAY_SUBJECT.test(before) || PAY_SUBJECT.test(heading) || following !== undefined && following !== 'other'
  let owner = leading.owner === 'irrelevant' ? inherited.owner : leading.owner
  let ambiguous = false
  if (following === 'other') {
    const intervening = before.slice(leading.index)
    const separated = /\b(?:and|plus|with|excludes?|excluding|exclusive of|not including|does not include|do not include)\b/i.test(intervening)
    const strong = leading.strong
    owner = strong && !separated ? 'unknown' : 'other'
    ambiguous = strong && !separated
  } else if (following !== undefined) {
    owner = leading.owner === 'other' ? 'unknown' : following
    ambiguous = leading.owner === 'other'
  }
  // Retain earlier modifiers (annual, hourly) belonging to the nearest subject,
  // but never carry a preceding component/amount into the current owner's context.
  let localBefore = before
  const connectors = [...withoutInclusionParentheses(withoutExclusions(before)).matchAll(/\b(?:plus|and|with)\b|,/gi)]
  for (const connector of connectors.reverse()) {
    const tail = before.slice(connector.index + connector[0].length)
    if (PAY_SUBJECT.test(tail) || OTHER_COMPONENT.test(tail) || following === 'other') {
      localBefore = tail
      break
    }
  }
  let localAfter = after
  for (const connector of after.matchAll(/\b(?:plus|and|with)\b|,/gi)) {
    const tail = after.slice(connector.index + connector[0].length)
    if (connector[0] === ',' && /^\s*(?:including|inclusive of|excluding|exclusive of|not including|does not include|do not include)\b/i.test(tail)) continue
    if (PAY_SUBJECT.test(tail) || OTHER_COMPONENT.test(tail) || /[$€£¥₩]|\b[A-Z]{3}\s*\d/.test(tail)) {
      localAfter = after.slice(0, connector.index)
      break
    }
  }
  const local = `${localBefore}${raw}${localAfter}`
  if (owner === 'base' && includesComponents(local)) owner = 'total'
  return { owner, ambiguous, text: local, apparentPay }
}

const PERIODS: [Exclude<Period, 'unknown'>, RegExp][] = [
  ['year', /\b(?:annual(?:ized|ly)?|yearly|per (?:year|annum)|a year|each year)\b|\/(?:year|yr)\b|\bp\.a\.(?:\s|$)/gi],
  ['month', /\b(?:monthly|per month|a month|each month)\b|\/(?:month|mo)\b/gi],
  ['week', /\b(?:weekly|per week|a week|each week)\b|\/(?:week|wk)\b/gi],
  ['day', /\b(?:daily|per day|a day|each day)\b|\/day\b/gi],
  ['hour', /\b(?:hourly|per hour|an hour|each hour)\b|\/(?:hour|hr|h)\b/gi],
]

interface UnitSignals { denomination: Set<Period>; payment: Set<Period> }
function unitSignals(text: string, other: boolean): UnitSignals {
  const signals: UnitSignals = { denomination: new Set(), payment: new Set() }
  for (const clause of payClauses(text)) {
    // Cadence relations cannot consume a separate heading or sentence.
    let cleaned = withoutExclusions(clause.text)
    cleaned = cleaned
      .replace(new RegExp(String.raw`\b${UNIT}\s+(?:(?:base|salary|pay|compensation|performance|equity)\s+){0,3}${CADENCE_NOUN}\b`, 'gi'), '')
      .replace(new RegExp(String.raw`\b${CADENCE_EVENT}(?:\s+\w+){0,3}?\s+${UNIT}\b`, 'gi'), '')
      .replace(/\b\d+(?:\.\d+)?\s+(?:days?|hours?|weeks?|months?|years?)\s+(?:(?:of\s+)?(?:paid\s+)?(?:vacation|holidays?|leave|PTO)\s+)?(?:per|a|each)\s+(?:year|month|week|day)\b/gi, '')
    if (!other) cleaned = cleaned.replace(new RegExp(String.raw`\b${UNIT}\s+(?:(?:cash|target|discretionary|performance|signing|sign[- ]on|additional|stock)\s+){0,4}${COMPONENT}\b`, 'gi'), '')
    for (const [period, pattern] of PERIODS) {
      for (const match of cleaned.matchAll(pattern)) {
        const before = cleaned.slice(Math.max(0, match.index - 90), match.index)
        const after = cleaned.slice(match.index + match[0].length, match.index + match[0].length + 100)
        if (new RegExp(String.raw`^\s+(?:(?:base|salary|pay|compensation|performance|equity)\s+){0,3}${CADENCE_NOUN}\b`, 'i').test(after)) continue
        if (new RegExp(String.raw`\b${CADENCE_EVENT}(?:\s+\w+){0,3}\s*$`, 'i').test(before)) continue
        if (!other && new RegExp(String.raw`^\s+(?:(?:cash|target|discretionary|performance|additional)\s+){0,4}${COMPONENT}\b`, 'i').test(after)) continue
        const followingSalary = /^\s+(?:(?:base|total|gross)\s+){0,2}(?:salar(?:y|ies)|pay|compensation|remuneration)\b/i.test(after)
        if (!other && !followingSalary && ownerBefore(before).owner === 'other') continue
        if (/^\s+(?:instal{1,2}ments?|payments?)\b/i.test(after)
          || /\b(?:paid|pays|payable|payments?|instal{1,2}ments?)\s+(?:(?:on|an?|each|every|a)\s+){0,2}$/i.test(before)) signals.payment.add(period)
        else signals.denomination.add(period)
      }
    }
  }
  return signals
}

/** Absence and conflict remain distinct until all four precedence tiers resolve. */
export function amountPeriod(local: string, heading = '', other = false): Period {
  const own = unitSignals(local, other)
  const context = unitSignals(heading, other)
  for (const signals of [own.denomination, context.denomination, own.payment, context.payment]) {
    if (signals.size) return signals.size === 1 ? [...signals][0] : 'unknown'
  }
  return 'unknown'
}

/** Structured numbers have no inline envelope. Only their own title/blurb apply. */
export function structuredPayContext(title: string, blurb: string): { basis: Basis; period: Period } {
  const titleBasis = contextBasis(title)
  if (titleBasis === 'other') {
    const component = new RegExp(String.raw`\b${COMPONENT}\b`, 'i').exec(title)?.[0]
    const own = component ? payClauses(blurb).map(clause => clause.text.trim()).filter(clause =>
      !PAY_SUBJECT.test(clause) && new RegExp(String.raw`\b${component}\b`, 'i').test(clause)) : []
    return { basis: 'other', period: amountPeriod([title, ...own].join('\n'), '', true) }
  }
  const related = payClauses(blurb).map(clause => clause.text.trim()).filter(clause =>
    contextBasis(clause) !== 'other'
    && (PAY_SUBJECT.test(clause) || /\b(?:paid|pays|payable|payments?)\b/i.test(clause) && !OTHER_COMPONENT.test(clause)))
  // Explicitly base-only titles own their number even if a later package has
  // more components. Generic range titles may use their own explanatory blurb.
  const combinesSalary = related.some(clause =>
    !/\bfor (?:sales|commissionable) (?:roles|positions)\b/i.test(clause)
    && salaryIncludesComponents(clause))
  const basis = combinesSalary ? 'total' : titleBasis !== 'unknown' ? titleBasis
    : related.map(contextBasis).find(value => value === 'base' || value === 'total') ?? 'unknown'
  return { basis, period: amountPeriod([title, ...related].join('\n')) }
}
