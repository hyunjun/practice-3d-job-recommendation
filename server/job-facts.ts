import type { Employment, FactEvidence, Visa, WorkMode } from '../shared/types'

export interface BoardMetadata {
  name?: string
  value?: unknown
}

export interface Fact<T> {
  value: T
  evidence?: FactEvidence
}

const evidence = (source: FactEvidence['source'], text: string): FactEvidence => ({
  source,
  text: text.length > 3000 ? `${text.slice(0, 2999)}…` : text,
})

function metadataFacts<T extends string>(metadata: BoardMetadata[], names: RegExp, classify: (text: string) => T): Fact<T> | undefined {
  const entries = metadata.flatMap(item => {
    if (!names.test(item.name ?? '')) return []
    const values = typeof item.value === 'string' ? [item.value] : Array.isArray(item.value) ? item.value.filter(value => typeof value === 'string') as string[] : []
    return values.map(text => ({ value: classify(text), text: `${item.name}: ${text}` }))
  }).filter(item => item.value !== 'unknown')
  if (!entries.length) return undefined
  const unique = [...new Set(entries.map(item => item.value))]
  return { value: unique.length === 1 ? unique[0] : 'unknown' as T, evidence: evidence('board', entries.map(item => item.text).join('\n')) }
}

const VISA_POSITIVE = /\b(?:(?:we\s+)?(?:do\s+)?(?:offer|provide)\s+(?:(?:work|employment)\s+)?visa sponsorship|visa sponsorship\s+(?:is\s+)?(?:available|provided|offered)|we\s+(?:(?:do|will|can)\s+)?sponsor\s+(?:(?:work|employment)\s+)?visas?)\b/i
const VISA_NEGATIVE = /\b(?:no|without)\s+(?:(?:immigration|work|employment)\s+)?(?:visa\s+)?sponsorship\b(?!\s+(?:is\s+)?(?:required|needed))|\b(?:cannot|can't|can not|do not|does not|will not|unable to|not able to)\s+(?:currently\s+)?(?:(?:provide|offer)\s+)?(?:visa\s+sponsorship|sponsor(?:ship)?(?:\s+(?:for\s+)?(?:work\s+)?visas?)?)\b|visa sponsorship\s+(?:is\s+)?not\s+(?:available|provided|offered)/i
const VISA_CONDITION = /\b(?:not\s+(?:all|every)|(?:for|in)\s+(?:all|every)\s+(?:role|candidate|case)|case[- ]by[- ]case|subject to|depending on|eligible candidates|if we make you an offer|reasonable effort|may be available)\b/i
const IMMIGRATION_TOPIC = /\bvisas?\b|\bimmigration\b|\bwork[\s-]+(?:permits?|authori[sz]ation)\b|\bauthori[sz]ed to work\b/i

/** An affirmative policy with exceptions is distinct from both a guarantee and missing data. */
export function visaFact(text: string): Fact<Visa> {
  // Export licenses, event sponsorships and payment-network sponsorships are not immigration policies.
  const passages = text.split(/\n+/).map(line => line.trim()).filter(line => IMMIGRATION_TOPIC.test(line))
  const positive = passages.filter(line => line.split(/(?<=[.!?;])\s+/).some(sentence => VISA_POSITIVE.test(sentence) && !VISA_NEGATIVE.test(sentence)))
  const negative = passages.filter(line => line.split(/(?<=[.!?;])\s+/).some(sentence => IMMIGRATION_TOPIC.test(sentence) && VISA_NEGATIVE.test(sentence)))
  const conditional = passages.filter(line => VISA_CONDITION.test(line))
  const firmDenial = passages.some(line => line.split(/(?<=[.!?;])\s+/).some(sentence =>
    IMMIGRATION_TOPIC.test(sentence) && VISA_NEGATIVE.test(sentence) && !VISA_CONDITION.test(sentence),
  ))
  let value: Visa = 'unknown'
  if (positive.length && firmDenial) value = 'unknown'
  else if (positive.length && conditional.length) value = 'conditional'
  else if (positive.length && !negative.length) value = 'yes'
  else if (negative.length && !positive.length && !conditional.length) value = 'no'
  // Contradictory positive/negative claims without an explicit condition remain unknown.
  const relevant = [...new Set([...positive, ...negative, ...conditional])]
  return { value, ...(relevant.length ? { evidence: evidence('description', relevant.join('\n\n')) } : {}) }
}

function workModeValue(text: string): WorkMode {
  const modes: WorkMode[] = []
  if (/\bremote\b|원격/i.test(text) && !/\b(?:no|not|non)[- ]remote\b|remote\s+(?:is\s+)?(?:not|unavailable)/i.test(text)) modes.push('remote')
  if (/\bhybrid\b|하이브리드/i.test(text)) modes.push('hybrid')
  if (/\bon[- ]?site\b|\bin[- ]office\b|\boffice[- ]based\b/i.test(text)) modes.push('onsite')
  return modes.length === 1 ? modes[0] : 'unknown'
}

/** Only role-specific sentences may fill in a missing board field. */
function roleSentences(text: string): string[] {
  return text.split(/\n+|(?<=[.!?])\s+/).map(sentence => sentence.trim()).filter(sentence =>
    /\b(?:this|the)\s+(?:role|position|job)\b/i.test(sentence)
    || /\bthis is an?\b.*\b(?:role|position|job|opportunity)\b/i.test(sentence)
    || /^(?:employment(?: type)?|workplace(?: type)?|work arrangement|job type|location type)\s*:/i.test(sentence),
  )
}

const ROLE_ASSERTION = String.raw`(?:\b(?:this|the)\s+(?:role|position|job)\s+(?:is|will be|can be)|\bthis\s+is)\s+(?:(?:a|an|fully|primarily|entirely|permanently)\s+){0,3}`
const WORK_ASSERTION = new RegExp(`${ROLE_ASSERTION}(remote|hybrid|on[- ]?site|in[- ]office|office[- ]based)\\b`, 'i')
const EMPLOYMENT_ASSERTION = new RegExp(`${ROLE_ASSERTION}(full[\\s-]*time|part[\\s-]*time|contract(?:or)?|intern(?:ship)?|temporary|fixed[- ]term)\\b`, 'i')

export function workModeFact(location: string, metadata: BoardMetadata[], text: string): Fact<WorkMode> {
  const structured = metadataFacts(metadata, /^(?:workplace[\s_-]*type|work[\s_-]*arrangement|work[\s_-]*location[\s_-]*type|location[\s_-]*type)$/i, workModeValue)
  if (structured) return structured
  const located = workModeValue(location)
  if (located !== 'unknown') return { value: located, evidence: evidence('board', location) }
  const statements = roleSentences(text).flatMap(sentence => {
    if (/\b(?:may|might|could|potential|not|isn't|cannot)\b/i.test(sentence)) return []
    const assertion = sentence.match(WORK_ASSERTION)?.[1]
    const value = workModeValue(assertion ?? (/^(?:workplace(?: type)?|work arrangement|location type)\s*:/i.test(sentence) ? sentence : ''))
    return value !== 'unknown' ? [{ value, text: sentence }] : []
  })
  const modes = [...new Set(statements.map(statement => statement.value))]
  return {
    value: modes.length === 1 ? modes[0] : 'unknown',
    ...(statements.length ? { evidence: evidence('description', statements.map(statement => statement.text).join('\n')) } : {}),
  }
}

function employmentValue(text: string): Employment {
  // A board's exact contract-duration category does not establish working hours.
  if (/^permanent$/i.test(text.trim())) return 'permanent'
  if (/\bintern(?:ship)?\b/i.test(text)) return 'intern'
  if (/\bcontract(?:or)?\b|\bfreelance\b/i.test(text)) return 'contract'
  if (/\btemporary\b|\bfixed[- ]term\b/i.test(text)) return 'temporary'
  const full = /\bfull[\s-]*time\b/i.test(text)
  const part = /\bpart[\s-]*time\b/i.test(text)
  return full === part ? 'unknown' : full ? 'fulltime' : 'parttime'
}

export function employmentFact(title: string, metadata: BoardMetadata[], text: string): Fact<Employment> {
  const titled = employmentValue(title)
  // An internship/contract may also be full-time. Keep its explicit contract category.
  if (['intern', 'contract', 'temporary'].includes(titled)) return { value: titled, evidence: evidence('title', title) }
  const structured = metadataFacts(metadata, /^(?:employment[\s_-]*type|commitment|time[\s_-]*type|job[\s_-]*type)$/i, employmentValue)
  if (structured) return structured
  if (titled !== 'unknown') return { value: titled, evidence: evidence('title', title) }
  const sentences = roleSentences(text).filter(sentence => employmentValue(sentence) !== 'unknown'
    && (EMPLOYMENT_ASSERTION.test(sentence) || /^(?:employment(?: type)?|job type)\s*:/i.test(sentence))
    && !/\b(?:may|might|could|benefits?|employees|not|isn't)\b/i.test(sentence))
  const values = [...new Set(sentences.map(employmentValue))]
  return values.length === 1
    ? { value: values[0], evidence: evidence('description', sentences.join('\n')) }
    : { value: 'unknown' }
}
