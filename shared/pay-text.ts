import { normalizeCompensation } from './compensation'
import type { CompensationInput, SalaryData } from './compensation'
import type { CompensationRange, FactEvidence } from './types'

const CODES = 'USD|EUR|GBP|CAD|SGD|AUD|KRW|JPY|CHF|PLN|INR|SEK|NOK|DKK|NZD|HKD|CNY|BRL|MXN|CZK|HUF|RON|TRY|ZAR|AED|ILS'
const MARKER = `(?:US\\$|CA\\$|C\\$|A\\$|AU\\$|S\\$|SG\\$|NZ\\$|HK\\$|R\\$|(?:${CODES})(?![A-Za-z])|[$€£¥₩])`
const NUMBER = '(?:\\d{1,3}(?:,\\d{3})+|\\d+)(?:\\.\\d+)?'
const PAY = /\b(?:salary|salaries|compensation|remuneration|base (?:pay|range)|pay (?:range|rate|band)|hourly (?:pay|rate)|on[- ]target earnings|OTE)\b/i
const NON_BASE = /^[\s,:;]*(?:(?:plus|and|with|an?|annual|yearly|monthly|target|discretionary|additional|cash|sign[- ]on|signing)\s+)*(?:equity|stock|bonus|stipend|allowance|budget|reimbursement)\b/i
const TOTAL = /\b(?:total (?:annual |cash |target )?(?:compensation|pay|remuneration)|on[- ]target earnings|OTE)\b/i
const GEO = /\b(?:United States|U\.?S\.?A?|United Kingdom|U\.?K\.?|Canada|Canadian|Europe|European|EMEA|APAC|Americas?|Portugal|Germany|France|Ireland|Australia|Singapore|Japan|Korea|India|California|Colorado|Washington|New York|San Francisco|Seattle|NYC|London|Berlin|Toronto|Vancouver|Lisbon|Dublin)\b/i
const MAX_TEXT = 100000

interface Mention {
  index: number
  end: number
  raw: string
  min: number
  max: number
  markers: string[]
  single: boolean
}

function amount(value: string, suffix?: string): number {
  return Number(value.replaceAll(',', '')) * (suffix?.toLowerCase() === 'm' ? 1000000 : suffix?.toLowerCase() === 'k' ? 1000 : 1)
}

function mentions(text: string): Mention[] {
  const found: Mention[] = []
  const ranges = new RegExp(`(${MARKER})?[ \\t]*(${NUMBER})[ \\t]*(?:([km])(?![A-Za-z]))?[ \\t]*(?:[-–—−]|\\bto\\b|\\bthrough\\b)[ \\t]*(${MARKER})?[ \\t]*(${NUMBER})[ \\t]*(?:([km])(?![A-Za-z]))?[ \\t]*(${MARKER})?(?!\\d|[,.]\\d|[A-Za-z])`, 'gi')
  for (const match of text.matchAll(ranges)) {
    if (!match[1] && !match[4] && !match[7]) continue
    const left = match[3] || (Number(match[2].replaceAll(',', '')) < 1000 ? match[6] : undefined)
    const right = match[6] || (Number(match[5].replaceAll(',', '')) < 1000 ? match[3] : undefined)
    found.push({
      index: match.index, end: match.index + match[0].length, raw: match[0].trim(),
      min: amount(match[2], left), max: amount(match[5], right),
      markers: [match[1], match[4], match[7]].filter(Boolean), single: false,
    })
  }
  const singles = new RegExp(`(${MARKER})?[ \\t]*(${NUMBER})[ \\t]*(?:([km])(?![A-Za-z]))?[ \\t]*(${MARKER})?(?!\\d|[,.]\\d|[A-Za-z])`, 'gi')
  for (const match of text.matchAll(singles)) {
    if ((!match[1] && !match[4]) || found.some(item => match.index < item.end && match.index + match[0].length > item.index)) continue
    found.push({
      index: match.index, end: match.index + match[0].length, raw: match[0].trim(),
      min: amount(match[2], match[3]), max: amount(match[2], match[3]),
      markers: [match[1], match[4]].filter(Boolean), single: true,
    })
  }
  return found.sort((a, b) => a.index - b.index).slice(0, 101)
}

export function payPeriod(text: string): CompensationRange['period'] {
  const monetary = new RegExp(`[$€£¥₩]\\s*\\d|\\b(?:${CODES})\\s*\\d|\\d[\\d, .]*\\b(?:${CODES})\\b`, 'i')
  const relevant = text.split(/\n|(?<=[.!?])\s+/).filter(clause => {
    if (NON_BASE.test(clause)) return false
    if (PAY.test(clause) || /\b(?:paid|pays|payable|payment)\b/i.test(clause)) return true
    return monetary.test(clause) && !/\b(?:equity|stock|bonus|stipend|allowance|budget|revenue|funding|raised)\b/i.test(clause)
  }).join('\n').replace(/\b(?:annual|yearly|monthly|weekly|daily|hourly)\s+(?:bonus|equity|stock|leave|holiday|allowance|budget)\b/gi, '')
  const periods: [CompensationRange['period'], RegExp][] = [
    ['year', /\b(?:annual(?:ized|ly)?|yearly|per (?:year|annum)|a year|each year)\b|\/(?:year|yr)\b|\bp\.a\.(?:\s|$)/i],
    ['month', /\b(?:monthly|per month|a month|each month)\b|\/(?:month|mo)\b/i],
    ['week', /\b(?:weekly|per week|a week|each week)\b|\/(?:week|wk)\b/i],
    ['day', /\b(?:daily|per day|a day|each day)\b|\/day\b/i],
    ['hour', /\b(?:hourly|per hour|an hour|each hour)\b|\/(?:hour|hr|h)\b/i],
  ]
  const found = periods.filter(([, pattern]) => pattern.test(relevant))
  return found.length === 1 ? found[0][0] : 'unknown'
}

export function payBasis(text: string): NonNullable<CompensationRange['basis']> {
  if (TOTAL.test(text) || /\b(?:salary|base pay)\b[^.\n]{0,80}\bincludes? (?:both |any |a )?(?:bonus|bonuses|equity|commission)/i.test(text)) return 'total'
  return /\b(?:salary|salaries|base (?:pay|range)|hourly (?:pay|rate)|pay rate)\b/i.test(text) ? 'base' : 'unknown'
}

/** Only a specific eligibility phrase or geographic pay heading creates a restriction. */
export function payScope(text: string): string | undefined {
  const clauses = text.split(/\n|(?<=[.!?])\s+/).map(line => line.trim()).filter(Boolean)
  const explicit = clauses.find(line =>
    /\bfor\b[^.\n]{1,120}\bbased (?:hires|employees|candidates|positions|roles)\b/i.test(line)
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

function contextOf(text: string, mention: Mention, previous?: Mention) {
  const lineStart = text.lastIndexOf('\n', mention.index) + 1
  const nextLine = text.indexOf('\n', mention.end)
  const lineEnd = nextLine < 0 ? text.length : nextLine
  // Keep a bonus or equity sentence from being mistaken for the salary sentence next to it.
  const boundaries = [...text.slice(lineStart, lineEnd).matchAll(/[.!?;]\s+(?=[A-Z])/g)].map(match => lineStart + match.index + match[0].length)
  const start = boundaries.filter(index => index <= mention.index).at(-1) ?? lineStart
  const end = boundaries.find(index => index > mention.end) ?? lineEnd
  const clause = text.slice(start, end).trim().slice(0, 1600)
  const before = text.slice(start, mention.index).trim()
  const segmentBefore = previous && previous.end >= start ? text.slice(previous.end, mention.index).trim() : before
  const preceding = text.slice(Math.max(0, lineStart - 2200), lineStart).split('\n').map(line => line.trim()).filter(Boolean).slice(-3)
  const last = preceding.at(-1) ?? ''
  const bare = !before || /^(?:USD|EUR|GBP|CAD|SGD|AUD|CHF)\s*:?$/i.test(before)
  const inherited = bare && (PAY.test(last) || NON_BASE.test(last)) ? last : ''
  // A heading can establish the unit for the immediately following pay description.
  const heading = preceding.filter(line => line.length < 100 && PAY.test(line) && !/[\d$€£]/.test(line)).at(-1) ?? ''
  const context = [inherited || heading, clause].filter(Boolean).join('\n')
  const evidence = [inherited ? preceding.slice(-2).join('\n') : heading, clause].filter(Boolean).join('\n').slice(0, 2000)
  return { clause, before, segmentBefore, bare, inherited, heading, context, evidence }
}

export function textCompensationInputs(input: string): CompensationInput[] {
  const text = input.slice(0, MAX_TEXT)
  const found = mentions(text)
  const inputs: CompensationInput[] = []
  for (const [index, mention] of found.slice(0, 100).entries()) {
    const details = contextOf(text, mention, found[index - 1])
    const labelText = details.bare ? details.inherited : details.segmentBefore || details.before
    if (NON_BASE.test(labelText) || (!PAY.test(details.before) && !(details.bare && PAY.test(details.inherited)))) continue
    const after = text.slice(mention.end, mention.end + 180).split(/[.!?;,\n]/)[0]
    const basisText = `${PAY.test(labelText) ? labelText : details.inherited || details.before}\n${after}`
    const period = payPeriod(details.clause)
    const interval = period !== 'unknown' ? period : payPeriod(details.inherited || details.heading)
    const evidence: FactEvidence = { source: 'description', text: details.evidence }
    // A one-sided offer is not an exact salary. Keep the quote without inventing the other bound.
    const partial = mention.single && /\b(?:up to|from|starting (?:at|from)|at least|minimum of|maximum of|more than|over)\s*$/i.test(details.before)
    const scope = payScope(details.context)
    inputs.push({
      label: labelText.replace(/[:\s]+$/, '').slice(0, 180) || '공고의 보상 범위',
      min: partial ? null : mention.min, max: mention.max,
      currency: currencyOf(mention.markers, details.clause || details.inherited),
      interval, basis: payBasis(basisText), ...(scope ? { scope } : {}), evidence,
    })
  }
  if ((found.length > 100 || input.length > MAX_TEXT) && inputs.length) inputs.push({
    evidence: { source: 'description', text: inputs[0].evidence!.text },
  })
  return inputs
}

export function parseTextCompensation(text: string): SalaryData {
  return normalizeCompensation(textCompensationInputs(text))
}
