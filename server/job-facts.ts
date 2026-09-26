import type { Employment, FactEvidence, JobManagement, WorkMode } from '../shared/types'
import { employmentDescriptionFact, employmentTitleFact, employmentValue } from '../shared/job-employment'

export { visaFact } from '../shared/job-eligibility'

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

export function managementFact(metadata: BoardMetadata[]): JobManagement | undefined {
  return metadataFacts(metadata, /^(?:job[\s_-]*level|career[\s_-]*track|management[\s_-]*level)$/i, text => {
    const value = text.trim()
    if (/^(?:people manager|management|manager|executive)$/i.test(value)) return 'management'
    if (/^(?:professional\s*-\s*)?(?:ic|individual contributor)$/i.test(value)) return 'individual'
    return 'unknown'
  })
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
// An office location between the role and its explicit work schedule is still
// about this vacancy. Require the schedule clause, not a nearby company's
// policy, hybrid cloud product, or remote colleagues.
const LOCATED_WORK_ASSERTION = /\b(?:this|the)\s+(?:role|position|job)\s+(?:is|will be)\s+(?:based|located)\s+(?:in|at)\s+[^.!?\n;]{1,140}?\s+(?:with|on)\s+(?:(?:a|an|our)\s+)?(?:office[- ]centric\s+)?(remote|hybrid|on[- ]?site|in[- ]office|office[- ]based)\s+(?:work(?:ing)?\s+)?(?:schedule|arrangement|model)\b/i
const FOLLOWED_WORK_ASSERTION = /\b(?:this|the)\s+(?:role|position|job)\s+(?:follows|will follow)\s+(?:(?:a|an|our)\s+)?(?:office[- ]centric\s+)?(remote|hybrid|on[- ]?site|in[- ]office|office[- ]based)\s+(?:work(?:ing)?\s+)?(?:schedule|arrangement)\b/i
const NON_REMOTE_ASSERTION = new RegExp(`${ROLE_ASSERTION}(?:not\\s+(?:(?:a|an|fully|entirely)\\s+){0,2}remote|non[- ]remote)\\b`, 'i')

export function workModeFact(location: string, metadata: BoardMetadata[], text: string): Fact<WorkMode> {
  const structured = metadataFacts(metadata, /^(?:workplace[\s_-]*type|work[\s_-]*arrangement|work[\s_-]*location[\s_-]*type|location[\s_-]*type)$/i, workModeValue)
  if (structured) return structured
  const located = workModeValue(location)
  if (located !== 'unknown') return { value: located, evidence: evidence('board', location) }
  const statements = roleSentences(text).flatMap(sentence => {
    // "Not remote" does not distinguish onsite from hybrid. Keep the explicit
    // restriction so a remote-job feed cannot fill this unknown with "remote".
    if (NON_REMOTE_ASSERTION.test(sentence) && !/\b(?:may|might|could|potential)\b/i.test(sentence)) {
      return [{ value: 'unknown' as WorkMode, text: sentence }]
    }
    if (/\b(?:may|might|could|potential|not|isn't|cannot)\b/i.test(sentence)) return []
    const assertion = sentence.match(WORK_ASSERTION)?.[1] ?? sentence.match(LOCATED_WORK_ASSERTION)?.[1]
      ?? sentence.match(FOLLOWED_WORK_ASSERTION)?.[1]
    const value = workModeValue(assertion ?? (/^(?:workplace(?: type)?|work arrangement|location type)\s*:/i.test(sentence) ? sentence : ''))
    return value !== 'unknown' ? [{ value, text: sentence }] : []
  })
  const modes = [...new Set(statements.map(statement => statement.value))]
  return {
    value: modes.length === 1 ? modes[0] : 'unknown',
    ...(statements.length ? { evidence: evidence('description', statements.map(statement => statement.text).join('\n')) } : {}),
  }
}

export function employmentFact(title: string, metadata: BoardMetadata[], text: string): Fact<Employment> {
  const titled = employmentTitleFact(title)
  // An internship/contract may also be full-time. Keep its explicit contract category.
  if (titled.evidence && ['intern', 'contract', 'temporary', 'unknown'].includes(titled.value)) return titled
  const structured = metadataFacts(metadata, /^(?:employment[\s_-]*type|commitment|time[\s_-]*type|job[\s_-]*type)$/i, employmentValue)
  if (structured) return structured
  return titled.evidence ? titled : employmentDescriptionFact(text)
}
