import { CITIES } from './cities'

/** Bounded, whole-token money recognition. Locale is never inferred from a job. */
export const PAY_CURRENCY_CODES = 'USD|EUR|GBP|CAD|SGD|AUD|KRW|JPY|CHF|PLN|INR|SEK|NOK|DKK|NZD|HKD|CNY|BRL|MXN|CZK|HUF|RON|TRY|ZAR|AED|ILS'
const MARKER = `(?:US\\$|CA\\$|C\\$|A\\$|AU\\$|S\\$|SG\\$|NZ\\$|HK\\$|R\\$|(?:${PAY_CURRENCY_CODES})(?![A-Za-z])|[$€£¥₩])`
const BEFORE_MARKER = new RegExp(`(${MARKER})$`, 'i')
const AFTER_MARKER = new RegExp(`^(${MARKER})`, 'i')
const SPACE = '[ \\u00a0\\u202f\\u2009]'
const SPACE_NUMBER = new RegExp(`^\\d{1,3}(?:${SPACE}\\d{3})+(?:[.,]\\d+)?$`)
const SPACE_CHARACTERS = new RegExp(SPACE, 'g')
const HORIZONTAL = /[^\S\r\n]/u
const DIGIT = /[0-9]/
const NUMERIC_RUN = /\p{Nd}+/uy
const WORD = /[\p{L}\p{N}_%]/u
const SIGN = /[+\-−]/
const SEPARATOR = /[.,'’]/
const CONNECTOR = /^(?:[-–—−]|to|through)$/i
const PERIOD = /^\/(?:year|yr|month|mo|week|wk|day|hour|hr|h)\b/i
const MAX_SAFE = String(Number.MAX_SAFE_INTEGER)
const CITY_LABELS = new Set(CITIES.flatMap(city => [city.en.toLowerCase(), city.name.toLowerCase()]))

export interface PayNumberMention {
  index: number
  end: number
  raw: string
  min: number | null
  max: number | null
  markers: string[]
  single: boolean
}

interface Decimal {
  normalized: string
  multiplierAllowed: boolean
}

interface Token {
  index: number
  end: number
  core: string
  decimal: Decimal | null
  suffix?: string
  markers: string[]
  invalid: boolean
  leadingSign: boolean
}

function isDigit(value: string | undefined): boolean {
  return value !== undefined && DIGIT.test(value)
}

function horizontalEnd(text: string, index: number): number {
  while (index < text.length && HORIZONTAL.test(text[index])) index++
  return index
}

function horizontalStart(text: string, index: number): number {
  while (index > 0 && HORIZONTAL.test(text[index - 1])) index--
  return index
}

/** Return an exact decimal string, before conversion or suffix multiplication. */
function decimalOf(core: string): Decimal | null {
  if (/^\d{1,3}\.\d{3}$/.test(core)) return null
  if (/^\d+(?:\.\d+)?$/.test(core)) return { normalized: core, multiplierAllowed: true }
  if (/^\d{1,3}(?:,\d{3})+(?:\.\d+)?$/.test(core)) {
    return { normalized: core.replaceAll(',', ''), multiplierAllowed: true }
  }
  if (/^\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?$/.test(core)) {
    return { normalized: core.replaceAll('.', '').replace(',', '.'), multiplierAllowed: false }
  }
  if (SPACE_NUMBER.test(core)) {
    const fraction = core.match(/,(\d+)$/)?.[1]
    if (fraction && fraction.length > 2) return null
    return { normalized: core.replace(SPACE_CHARACTERS, '').replace(',', '.'), multiplierAllowed: false }
  }
  return null
}

/** Compare exact decimal digits to the ceiling before Number can round an excess away. */
function amount(decimal: Decimal | null, suffix?: string): number | null {
  if (!decimal || suffix && !decimal.multiplierAllowed) return null
  const [integer, fraction = ''] = decimal.normalized.split('.')
  const shift = suffix?.toLowerCase() === 'm' ? 6 : suffix?.toLowerCase() === 'k' ? 3 : 0
  const digits = integer + fraction.padEnd(shift, '0')
  const point = integer.length + shift
  const whole = digits.slice(0, point).replace(/^0+/, '') || '0'
  const remainder = digits.slice(point)
  if (whole.length > MAX_SAFE.length || whole.length === MAX_SAFE.length
    && (whole > MAX_SAFE || whole === MAX_SAFE && /[1-9]/.test(remainder))) return null
  const result = Number(`${whole}${remainder ? `.${remainder}` : ''}`)
  return Number.isFinite(result) && result > 0 ? result : null
}

/** Scan a maximal digit run, including invalid grouping, without crossing a line. */
function coreEnd(text: string, start: number): number {
  const digitEnd = (index: number) => {
    NUMERIC_RUN.lastIndex = index
    return NUMERIC_RUN.exec(text) ? NUMERIC_RUN.lastIndex : index
  }
  // Non-ASCII decimal digits are consumed, but decimalOf never accepts them.
  // This retains their quote instead of rescuing an adjacent ASCII fragment.
  let end = digitEnd(start)
  while (end < text.length) {
    let next = end
    if (HORIZONTAL.test(text[next])) next = horizontalEnd(text, next)
    else if (SEPARATOR.test(text[next])) {
      // Repeated punctuation is part of a malformed run, not a new number.
      while (next < text.length && SEPARATOR.test(text[next])) next++
    } else break
    const afterDigits = digitEnd(next)
    if (afterDigits === next) break
    end = afterDigits
  }
  return end
}

function markerBefore(text: string, end: number, floor: number): { value: string; index: number } | undefined {
  const match = BEFORE_MARKER.exec(text.slice(Math.max(0, end - 8), end))
  if (!match) return undefined
  const index = end - match[0].length
  if (index < floor) return undefined
  if (/^[A-Za-z]/.test(match[0]) && index > 0 && WORD.test(text[index - 1])) return undefined
  return { value: match[0], index }
}

function labelDashBefore(text: string, signIndex: number, index: number, floor: number): boolean {
  if (text[signIndex] !== '-' || signIndex >= index - 1 || !HORIZONTAL.test(text[signIndex - 1] ?? '')) return false
  // A short clause window avoids repeatedly searching the whole description
  // when a long, non-pay input contains many numeric tokens and dashes.
  const context = text.slice(Math.max(floor, signIndex - 128), signIndex)
  const colon = context.lastIndexOf(':')
  const lineStart = Math.max(context.lastIndexOf('\n'), context.lastIndexOf('\r')) + 1
  if (colon < lineStart) return false
  const label = context.slice(colon + 1).trim().replace(/\s+/g, ' ').toLowerCase()
  // Recognize an existing city label, optionally followed by this explicit pay
  // label. This only classifies punctuation; it infers no currency or pay scope.
  const city = label.replace(/ - base annual gross$/, '')
  return CITY_LABELS.has(city)
}

function tokenAt(text: string, start: number, floor: number): Token {
  const end = coreEnd(text, start)
  const core = text.slice(start, end)
  let before = horizontalStart(text, start)
  let invalid = false
  let leadingPunctuation: number | undefined
  // Only a marker-owned sign belongs inside this prefix. A bare dash between
  // two endpoints must remain available to the range connector recognizer.
  if (before > floor && /[+\-−.,'’]/.test(text[before - 1])) {
    const punctuation = before - 1
    const beforePunctuation = horizontalStart(text, punctuation)
    if (markerBefore(text, beforePunctuation, floor)) {
      invalid = true
      before = beforePunctuation
    } else if (/[.,'’]/.test(text[punctuation])) {
      invalid = true
      leadingPunctuation = punctuation
    }
  }
  const prefix = markerBefore(text, before, floor)
  let index = prefix?.index ?? leadingPunctuation ?? start
  const signIndex = horizontalStart(text, index) - 1
  const connectorSign = floor > 0 && signIndex >= floor && /[-−]/.test(text[signIndex])
    && !text.slice(floor, signIndex).trim()
  const leadingSign = signIndex >= floor && SIGN.test(text[signIndex])
    && !connectorSign && !labelDashBefore(text, signIndex, index, floor)
  if (leadingSign) {
    invalid = true
    index = signIndex
  }
  if (!prefix && start > 0 && (WORD.test(text[start - 1]) || /[.,'’]/.test(text[start - 1]))) invalid = true
  const markers = prefix ? [prefix.value] : []
  let cursor = end
  let suffix: string | undefined
  let next = horizontalEnd(text, cursor)
  if (/[km]/i.test(text[next] ?? '') && !/[A-Za-z]/.test(text[next + 1] ?? '')) {
    suffix = text[next]
    cursor = next + 1
  }
  next = horizontalEnd(text, cursor)
  const trailing = AFTER_MARKER.exec(text.slice(next, next + 8))
  if (trailing) {
    markers.push(trailing[0])
    cursor = next + trailing[0].length
  }
  next = horizontalEnd(text, cursor)
  const period = PERIOD.exec(text.slice(next, next + 12))
  if (period) cursor = next + period[0].length
  // Own the entire rejecting tail before returning to the outer digit scan.
  // Chained numeric continuations must not resurrect their last fragment as a
  // new salary, and "84k.5 USD" still has a currency-bearing invalid amount.
  while (cursor < text.length) {
    const previous = cursor
    next = cursor
    while (next < text.length && SEPARATOR.test(text[next])) next++
    if (next > cursor && /^\p{Nd}/u.test(text.slice(next))) {
      invalid = true
      cursor = coreEnd(text, next)
    }
    // Slash words such as "/gross" and "/per year" keep their legacy meaning.
    // Numeric slash tails are consumed for rejection, never evaluated.
    next = horizontalEnd(text, cursor)
    if (text[next] === '/') {
      let denominator = horizontalEnd(text, next + 1)
      while (/[+\-−.,'’]/.test(text[denominator] ?? '')) denominator = horizontalEnd(text, denominator + 1)
      if (/^\p{Nd}/u.test(text.slice(denominator))) {
        invalid = true
        cursor = coreEnd(text, denominator)
      }
    }
    if (invalid) {
      next = horizontalEnd(text, cursor)
      const terminalMarker = AFTER_MARKER.exec(text.slice(next, next + 8))
      if (terminalMarker) {
        markers.push(terminalMarker[0])
        cursor = next + terminalMarker[0].length
      }
      next = horizontalEnd(text, cursor)
      const terminalPeriod = PERIOD.exec(text.slice(next, next + 12))
      if (terminalPeriod) cursor = next + terminalPeriod[0].length
    }
    if (WORD.test(text[cursor] ?? '')) {
      invalid = true
      while (cursor < text.length && (WORD.test(text[cursor]) || /[\/+\-]/.test(text[cursor]))) cursor++
    }
    if (cursor === previous) break
  }
  if (prefix && prefix.index > 0 && isDigit(text[prefix.index - 1])) invalid = true
  return { index, end: cursor, core, decimal: decimalOf(core), suffix, markers, invalid, leadingSign }
}

interface Link { wrapped: boolean }

function linkBetween(text: string, left: Token, right: Token): Link | undefined {
  const between = text.slice(left.end, right.index)
  if (!between.includes('\n') && !between.includes('\r')) {
    return CONNECTOR.test(between.trim()) ? { wrapped: false } : undefined
  }
  const lines = between.split(/\r\n?|\n/)
  // A dash followed by a number at the start of the next line is a list item.
  // Only a connector ending the first line, or alone on an intervening line,
  // can make a wrapped range, which remains unsupported and evidence-only.
  const first = lines[0].trim()
  if (CONNECTOR.test(first) && lines.slice(1).every(line => !line.trim())) return { wrapped: true }
  if (!first && !lines.at(-1)!.trim()) {
    const middle = lines.slice(1, -1).map(line => line.trim()).filter(Boolean)
    if (middle.length === 1 && CONNECTOR.test(middle[0])) return { wrapped: true }
  }
  return undefined
}

function mention(text: string, tokens: Token[], wrapped: boolean): PayNumberMention {
  const first = tokens[0]
  const last = tokens.at(-1)!
  const invalid = wrapped || tokens.length > 2 || tokens.some(token => token.invalid)
    || first.leadingSign
  const leftValue = amount(first.decimal)
  const rightValue = amount(last.decimal)
  const leftSuffix = first.suffix || (tokens.length === 2 && leftValue !== null && leftValue < 1000 ? last.suffix : undefined)
  const rightSuffix = last.suffix || (tokens.length === 2 && rightValue !== null && rightValue < 1000 ? first.suffix : undefined)
  const min = invalid ? null : amount(first.decimal, leftSuffix)
  const max = invalid ? null : amount(last.decimal, rightSuffix)
  return {
    index: first.index, end: last.end, raw: text.slice(first.index, last.end),
    min: min === null || max === null ? null : min,
    max: min === null || max === null ? null : max,
    markers: tokens.flatMap(token => token.markers), single: tokens.length === 1,
  }
}

/** Keep malformed money spans too; the pay-context layer decides whether they are evidence. */
export function payNumberMentions(text: string): PayNumberMention[] {
  const tokens: Token[] = []
  const digits = /\p{Nd}+/gu
  let match: RegExpExecArray | null
  while ((match = digits.exec(text))) {
    const token = tokenAt(text, match.index, tokens.at(-1)?.end ?? 0)
    tokens.push(token)
    digits.lastIndex = Math.max(token.end, match.index + match[0].length)
  }
  const found: PayNumberMention[] = []
  for (let index = 0; index < tokens.length;) {
    const group = [tokens[index++]]
    let wrapped = false
    while (index < tokens.length) {
      const link = linkBetween(text, group.at(-1)!, tokens[index])
      if (!link) break
      wrapped ||= link.wrapped
      group.push(tokens[index++])
    }
    if (!group.some(token => token.markers.length)) continue
    found.push(mention(text, group, wrapped))
    if (found.length > 100) break
  }
  return found
}
