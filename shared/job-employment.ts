import { EMPLOYMENT_VERSION } from './types'
import type { Employment, FactEvidence, Job } from './types'

interface EmploymentFact {
  value: Employment
  evidence?: FactEvidence
}

const evidence = (source: FactEvidence['source'], text: string): FactEvidence => ({
  source, text: text.length > 3000 ? `${text.slice(0, 2999)}…` : text,
})

/** Read a dedicated board field or an already isolated employment qualifier. */
export function employmentValue(text: string): Employment {
  if (/^permanent(?: contract)?$/i.test(text.trim())) return 'permanent'
  if (/\bintern(?:ship)?\b/i.test(text)) return 'intern'
  if (/\bcontract(?:or)?\b|\bfreelance\b/i.test(text)) return 'contract'
  if (/\btemporary\b|\bfixed[- ]term\b/i.test(text)) return 'temporary'
  const full = /\bfull[\s_-]*time\b/i.test(text)
  const part = /\bpart[\s_-]*time\b/i.test(text)
  return full === part ? 'unknown' : full ? 'fulltime' : 'parttime'
}

const TYPE = String.raw`full[\s_-]*time|part[\s_-]*time|contract(?:or)?|freelance|intern(?:ship)?|temporary|fixed[- ]term|permanent`
const TYPES = new RegExp(String.raw`\b(?:${TYPE})\b`, 'gi')
const ROLE_WORD = String.raw`(?:software|engineer(?:ing)?|developer|scientist|research(?:er)?|data|machine learning|AI|ML|(?:front|back)[- ]?end|full[- ]?stack|mobile|platform|infrastructure|security|DevOps|site reliability|SRE|QA|quality|test)`
const PREFIX = new RegExp(String.raw`^(?:(?:senior|staff|principal|lead|junior|sr\.?|jr\.?)\s+){0,2}(contract(?:or)?|freelance|temporary|intern(?:ship)?)\s+(?:(?:senior|staff|principal|lead|junior)\s+)?(?=${ROLE_WORD}\b)`, 'i')
const QUALIFIER = new RegExp(String.raw`^(?:\d+(?:\.\d+)?\s*[- ]?\s*(?:weeks?|months?|years?)\s+)?(${TYPE})(?:[- ]to[- ]hire)?(?:\s+(?:role|position|opportunity))?$`, 'i')

function resolve(values: Employment[]): Employment {
  const unique = new Set(values.filter(value => value !== 'unknown'))
  if (unique.has('fulltime') && unique.has('parttime')) return 'unknown'
  const categories = [...unique].filter(value => ['intern', 'contract', 'temporary'].includes(value))
  if (categories.length > 1 || categories.length && unique.has('permanent')) return 'unknown'
  return categories[0] ?? (unique.has('fulltime') ? 'fulltime' : unique.has('parttime') ? 'parttime'
    : unique.has('permanent') ? 'permanent' : 'unknown')
}

export function employmentTitleFact(title: string): EmploymentFact {
  const values: Employment[] = []
  const prefix = title.match(PREFIX)?.[1]
  if (prefix) values.push(employmentValue(prefix))
  // Contract must qualify the vacancy, not an object such as Smart Contract,
  // API Contract Testing, or Contract Management inside the technical title.
  for (const section of title.split(/[()[\]{},;|:–—]|\s+-\s+/)) {
    const qualifier = section.trim().match(QUALIFIER)?.[1]
    if (qualifier) values.push(employmentValue(qualifier))
  }
  if (/\bintern(?:ship)?\b(?=\s*(?:$|[()[\],;:|–—-]|\bin\b|\bat\b|\bfor\b))/i.test(title)) values.push('intern')
  if (/\bcontractor\s*$/i.test(title)) values.push('contract')
  for (const hours of title.matchAll(/\b(?:full[\s_-]*time|part[\s_-]*time)\b/gi)) values.push(employmentValue(hours[0]))
  return { value: resolve(values), ...(values.length ? { evidence: evidence('title', title) } : {}) }
}

const QUALIFIERS = String.raw`(?:${TYPE})(?:(?:\s+(?:role|position|job|opportunity))?(?:\s*(?:[,/]|and\b|or\b)\s*|\s+)(?:an?\s+)?(?:${TYPE}))*`
const ASSERTION = new RegExp(String.raw`(?:\b(?:this|the)\s+(?:role|position|job)\s+(?:is|will be)|\bthis\s+is)\s+(?:(?:a|an|fully|primarily|entirely)\s+){0,3}(${QUALIFIERS})\b`, 'gi')
const LABELED = new RegExp(String.raw`^(?:employment(?: type)?|job type)\s*:\s*(${QUALIFIERS})\b`, 'i')
const CATEGORY_SUFFIX = new RegExp(String.raw`^\s*(?:$|[.,;:)]|(?:role|position|job|opportunity|work|basis|engagement|appointment|for|with|based|working|located|in|at|starting|until)\b|${ROLE_WORD}\b)`, 'i')

export function employmentDescriptionFact(text: string): EmploymentFact {
  const statements: { text: string; values: Employment[]; alternatives: boolean }[] = []
  for (const sentence of text.split(/\n+|(?<=[.!?])\s+/).map(value => value.trim())) {
    if (!sentence || sentence.endsWith('?')) continue
    const labeled = sentence.match(LABELED)
    const roleSentence = /\b(?:this|the)\s+(?:role|position|job)\b|\bthis\s+is\s+an?\b.*\b(?:role|position|job|opportunity)\b/i.test(sentence)
    const matches = labeled ? [labeled] : roleSentence ? [...sentence.matchAll(ASSERTION)] : []
    for (const match of matches) {
      const qualifiers = match[1]
      const values = [...qualifiers.matchAll(TYPES)].map(value => employmentValue(value[0]))
      const tail = sentence.slice((match.index ?? 0) + match[0].length)
      if (!labeled && values.some(value => ['intern', 'contract', 'temporary'].includes(value)) && !CATEGORY_SUFFIX.test(tail)) continue
      statements.push({ text: sentence, values, alternatives: /\bor\b/i.test(qualifiers) && new Set(values).size > 1 })
    }
  }
  return {
    value: statements.some(statement => statement.alternatives) ? 'unknown' : resolve(statements.flatMap(statement => statement.values)),
    ...(statements.length ? { evidence: evidence('description', [...new Set(statements.map(statement => statement.text))].join('\n')) } : {}),
  }
}

/** Recheck the original claim, without inventing board metadata absent from an old record. */
export function upgradeJobEmployment<T extends Job>(job: T): T {
  const previous = job.evidence?.employment
  if (job.source === 'sample' || job.employmentVersion === EMPLOYMENT_VERSION || !previous || previous.source === 'board') return job
  const titled = employmentTitleFact(job.title)
  const current = titled.evidence ? titled
    : employmentDescriptionFact(previous.source === 'description' ? previous.text : job.description)
  if (current.value === job.employment) return job
  const { employment: _previous, ...otherEvidence } = job.evidence ?? {}
  return {
    ...job, employment: current.value, employmentVersion: EMPLOYMENT_VERSION,
    evidence: { ...otherEvidence, ...(current.evidence ? { employment: current.evidence } : {}) },
  }
}
