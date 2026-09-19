import { qualificationSection } from './job-qualifications'
import { ELIGIBILITY_LABELS, ELIGIBILITY_VERSION } from './types'
import type { EligibilityKind, EligibilityLevel, FactEvidence, Job, JobEligibility, Visa } from './types'

const MAX_TEXT = 100_000
const MAX_RULES = 50
const VISA_POSITIVE = /\b(?:(?:we\s+)?(?:do\s+)?(?:offer|provide)\s+(?:(?:work|employment)\s+)?visa sponsorship|visa sponsorship\s+(?:(?:is|are|will be)\s+)?(?:(?:currently|only)\s+){0,2}(?:available|provided|offered)|we\s+(?:(?:do|will|can)\s+)?sponsor\s+(?:(?:work|employment)\s+)?visas?)\b/i
const VISA_NEGATIVE = /\b(?:no|without)\s+(?:(?:immigration|work|employment)\s+)?(?:visa\s+)?sponsorship\b(?!\s+(?:is\s+)?(?:required|needed))|\b(?:cannot|can't|can not|do not|don't|does not|doesn't|will not|won't|unable to|not able to|aren't able to|isn't able to)\s+(?:(?:currently|successfully)\s+)?(?:(?:provide|offer|support)\s+)?(?:visa\s+sponsorship|sponsor(?:ship)?(?:\s+(?:for\s+)?(?:work\s+)?visas?)?)\b|visa sponsorship\s+(?:(?:is|are)\s+not|isn't|aren't|not)\s+(?:available|provided|offered)/i
const VISA_CONDITION = /\b(?:not\s+(?:all|every)|(?:for|in)\s+(?:all|every)\s+(?:role|candidate|case)|case[- ]by[- ]case|subject to|depending on|eligible candidates|if we make you an offer|reasonable effort|may be available|(?:any\s+)?other countr(?:y|ies)|elsewhere|only (?:in|for|to)|limited to|restricted to)\b/i
const IMMIGRATION_TOPIC = /\bvisas?\b|\bimmigration\b|\bwork[\s-]+(?:permits?|authori[sz]ation)\b|\bauthori[sz]ed to work\b|\bright to work\b/i
const SPONSOR_SCOPE = /\b(?:visas?(?:\s+sponsorship)?|sponsorship)\b(?:\s+(?:is|are|will|be|currently|available|provided|offered|only|permitted)){0,4}\s+(?:in|to|for|within|outside|across|throughout)\s+([^.!?;\n]{1,180})/i
const TRANSFER_OBJECT = String.raw`(?:transfers?\s+of\s+(?:existing\s+)?visa sponsorship|(?:existing\s+)?visa sponsorship transfers?)`
const TRANSFER_POSITIVE = new RegExp(String.raw`\b(?:we\s+(?:(?:can|will|do)\s+|are\s+able\s+to\s+)?(?:support|offer|provide)\s+(?:support\s+for\s+)?(?:the\s+)?${TRANSFER_OBJECT}|${TRANSFER_OBJECT}\s+(?:(?:is|are|will be)\s+)?(?:supported|provided|available))\b`, 'i')
const TRANSFER_NEGATIVE = new RegExp(String.raw`\b(?:we\s+(?:cannot|can't|do not|don't|will not|won't|are not able to)\s+(?:support|offer|provide)\s+(?:the\s+)?${TRANSFER_OBJECT}|(?:no|without)\s+(?:support\s+for\s+)?${TRANSFER_OBJECT}|${TRANSFER_OBJECT}\s+(?:(?:is|are)\s+not|isn't|aren't|not)\s+(?:supported|provided|available))\b`, 'i')
const DEFERRED_ROLE = /\b(?:after|following)\s+(?:(?:successful\s+)?completion\s+of\s+)?(?:the|this|your|an?)\s+internship\b|\b(?:on|upon)\s+(?:successful\s+)?(?:completion of (?:the|this|your) internship|conversion)\b|\bfor\s+(?:(?:a|the|your)\s+)?(?:future|subsequent)\s+(?:full[- ]time\s+)?(?:role|position|employment)\b/i
const clean = (text: string) => text.replace(/[’‘]/g, "'").replace(/\bU\.S\.(?:A\.)?/g, 'US').replace(/\bU\.K\./g, 'UK')
const evidence = (text: string): FactEvidence => ({ source: 'description', text: text.length > 3000 ? `${text.slice(0, 2999)}…` : text })
const sentences = (text: string) => clean(text).split(/(?<=[.!?;])\s+/)
// Keep the original paragraph as evidence; simplify only this explicit coordinated subject.
const sponsorshipSubject = (text: string) => text.replace(/\bvisa sponsorship\s+(?:and|&)\s+(?:relocation|immigration)\s+(?:support|assistance)\b/gi, 'visa sponsorship')
const isQuestionOrExperience = (text: string) => /\?\s*$/.test(text) || /^(?:experience|familiarity|knowledge|understanding)\s+(?:with|of|in)\b/i.test(text.trim().replace(/^[#*•-]+\s*/, ''))
const currentSentences = (text: string) => sentences(text).filter(sentence => !isQuestionOrExperience(sentence)
  && !(IMMIGRATION_TOPIC.test(sentence) && DEFERRED_ROLE.test(sentence))).map(sponsorshipSubject)

function policyParagraphs(text: string, retained: readonly FactEvidence[] = []): string[] {
  // Previously extracted source paragraphs can survive beyond the saved 26,000-character body.
  const split = (source: string) => source.split(/\n+/).map(line => line.trim()).filter(Boolean)
  // Repeated headings in the actual body still reset required/preferred context.
  const lines = split(text.slice(0, MAX_TEXT))
  const seen = new Set(lines)
  for (const item of retained.slice(0, MAX_RULES + 10)) {
    if (item.source !== 'description') continue
    for (const line of split(item.text.slice(0, 3000))) {
      if (!seen.has(line)) { seen.add(line); lines.push(line) }
    }
  }
  return lines
}

function transferScope(text: string): boolean {
  return TRANSFER_POSITIVE.test(text) || TRANSFER_NEGATIVE.test(text)
}

function sponsorshipScope(text: string, includeTransfer = true): boolean {
  if (!IMMIGRATION_TOPIC.test(text) || !/\bsponsor/i.test(text)) return false
  return sentences(text).some(original => {
    if (isQuestionOrExperience(original) || !IMMIGRATION_TOPIC.test(original) || !/\bsponsor/i.test(original)) return false
    const sentence = sponsorshipSubject(original)
    return countryScope(sentence) || VISA_CONDITION.test(sentence) || includeTransfer && transferScope(sentence) || DEFERRED_ROLE.test(sentence)
  })
}

function countryScope(text: string): boolean {
  for (const sentence of sentences(text)) {
    // A separate export-license statement in the same paragraph is not a visa restriction.
    if (!IMMIGRATION_TOPIC.test(sentence)) continue
    const scope = SPONSOR_SCOPE.exec(sponsorshipSubject(sentence))?.[1].trim()
    if (!scope) continue
    // Retain explicit target scopes even outside the map's countries. Ordinary recipients,
    // this posting itself and "in addition" do not establish a geographical restriction.
    if (/^(?:(?:(?:all|any|our|the|successful|new)\s+){0,3}(?:candidates|applicants|employees|hires|staff|team members)|this (?:role|position|job|internship)|(?:the )?world|all countries)$/i.test(scope)) continue
    if (scope === 'us' || /^(?:addition|partnership|collaboration)\b|^full$/i.test(scope)) continue
    return true
  }
  return false
}

/** Sponsorship scope is not the applicant's legal eligibility, citizenship or residence. */
export function visaFact(text: string, retained: readonly FactEvidence[] = []): { value: Visa; evidence?: FactEvidence } {
  const lines = policyParagraphs(text, retained)
  const passages = lines.filter((line, index) => IMMIGRATION_TOPIC.test(line)
    || (/\bsponsor(?:ship)?\b/i.test(line) && VISA_CONDITION.test(line) && IMMIGRATION_TOPIC.test(lines[index - 1] ?? '')))
  const general = passages.filter(line => currentSentences(line).some(sentence =>
    VISA_POSITIVE.test(sentence.replace(new RegExp(TRANSFER_OBJECT, 'gi'), ''))
      && !VISA_NEGATIVE.test(sentence) && !TRANSFER_NEGATIVE.test(sentence)))
  const transfers = passages.filter(line => currentSentences(line).some(sentence =>
    TRANSFER_POSITIVE.test(sentence) && !VISA_NEGATIVE.test(sentence) && !TRANSFER_NEGATIVE.test(sentence)))
  const positive = [...new Set([...general, ...transfers])]
  const negative = passages.filter(line => currentSentences(line).some(sentence => IMMIGRATION_TOPIC.test(sentence) && VISA_NEGATIVE.test(sentence)))
  const conditional = passages.filter(line => {
    const current = currentSentences(line).join(' ')
    return VISA_CONDITION.test(current) || TRANSFER_NEGATIVE.test(current)
      || !general.length && TRANSFER_POSITIVE.test(current) || (positive.includes(line) && countryScope(current))
  })
  const firmDenial = passages.some(line => currentSentences(line).some(sentence =>
    IMMIGRATION_TOPIC.test(sentence) && VISA_NEGATIVE.test(sentence) && !VISA_CONDITION.test(sentence) && !transferScope(sentence),
  ))
  let value: Visa = 'unknown'
  if (positive.length && firmDenial) value = 'unknown'
  else if (positive.length && conditional.length) value = 'conditional'
  else if (positive.length && !negative.length) value = 'yes'
  else if (negative.length && !positive.length && !conditional.length) value = 'no'
  const deferred = passages.filter(line => sentences(line).some(sentence =>
    !isQuestionOrExperience(sentence) && IMMIGRATION_TOPIC.test(sentence) && /\bsponsor/i.test(sentence) && DEFERRED_ROLE.test(sentence)))
  const relevant = [...new Set([...positive, ...negative, ...conditional, ...deferred])]
  return { value, ...(relevant.length ? { evidence: evidence(relevant.join('\n\n')) } : {}) }
}

const EXCLUDED = /\b(?:without regard|regardless of|discriminat\w*|equal opportunit\w*|first[- ]class citizens?|privacy policy|personal data we collect)\b/i
const OPTIONAL = /\b(?:preferred|preferably|nice[- ]to[- ]have|a plus|a bonus|bonus points|ideally)\b/i
const NOT_REQUIRED = /\b(?:not (?:required|necessary)|no .{0,60}(?:required|necessary)|do not (?:need|require)|don't (?:need|require))\b/i
const REQUIRED = /\b(?:must|requires?|required|need to|needs to|have to|only if)\b|^(?:be (?:a|an)|valid proof|proof of|active .{0,50}clearance)\b/i
const POLICY_STATEMENT = /\b(?:this|the) (?:role|position|job)\b|\b(?:any offer of employment|to conform to|you must|candidates? must|applicants? must|we (?:can|do|will) sponsor)\b|^be (?:a|an) .{0,30}citizen\b/i
const CONDITIONAL = /\b(?:if applicable|may (?:be (?:conditioned|required)|require|depend)|depending|subject to|conditioned on|for (?:any )?other countr(?:y|ies)|anyone who|where (?:required|permitted))\b/i
const CITIZENSHIP = /\b(?:citizenship|citizens?|nationality)\b/i
const US_PERSON = /\bUS persons?\b/i
const AUTHORIZATION = /\b(?:right to work|work authori[sz]ation|authori[sz]ed to work|work permits?)\b/i
const CLEARANCE = /\b(?:security clearance|(?:secret|federal|government|TS\/SCI) clearance|clearable)\b/i
const CLEARANCE_CLAIM = /\b(?:active|current|hold|possess|have|obtain|maintain|eligible|eligibility|clearable)\b|\bclearance (?:is )?(?:required|necessary|preferred)\b/i
const EXPORT = /\b(?:export (?:controls?|laws?|regulations?|licen[cs]es?|authori[sz]ation)|US persons?)\b|\b(?:ITAR|EAR)\b/
const RESIDENCY = /\b(?:proof of .{0,45}residenc[ey]|must (?:be based|reside|live) in|on US soil|residency (?:is )?required)\b/i

export function eligibilityFacts(text: string, retained: readonly FactEvidence[] = []): { visa: Visa; visaEvidence?: FactEvidence; eligibility: JobEligibility } {
  const policy = visaFact(text, retained)
  const rules: JobEligibility['rules'] = []
  const seen = new Set<string>()
  let section: ReturnType<typeof qualificationSection> = undefined
  let heading = ''
  const add = (kind: EligibilityKind, level: EligibilityLevel, line: string, includeHeading = false) => {
    const original = includeHeading && heading ? `${heading}\n${line}` : line
    const key = `${kind}:${level}:${original}`
    if (seen.has(key)) return
    seen.add(key)
    rules.push({ kind, level, evidence: evidence(original) })
  }
  for (const original of policyParagraphs(text, retained)) {
    const line = original.trim()
    if (!line) continue
    const nextSection = qualificationSection(line)
    if (nextSection) { section = nextSection; heading = line; continue }
    const normalized = clean(line).replace(/^[\s#*•-]+/, '')
    if (EXCLUDED.test(normalized)) { section = undefined; heading = '' }
    const policyStatement = POLICY_STATEMENT.test(normalized)
    const policyConditional = policyStatement && CONDITIONAL.test(normalized)
    if (sponsorshipScope(normalized, policy.value !== 'yes')) {
      add('sponsorship-scope', 'conditional', line)
    }
    for (const sentence of sentences(normalized)) {
      if (EXCLUDED.test(sentence) || NOT_REQUIRED.test(sentence)) continue
      const explicit = REQUIRED.test(sentence) || /^\s*only\b.{0,60}\bcitizens?\b/i.test(sentence)
      const preferred = OPTIONAL.test(sentence) || (section === 'preferred' && !policyStatement)
      const eligibleSection = section === 'required' || section === 'qualification' || section === 'preferred'
      const obligation = explicit || eligibleSection
      let level: EligibilityLevel = preferred ? 'preferred' : policyConditional || CONDITIONAL.test(sentence) ? 'conditional'
        : explicit || section === 'required' ? 'required' : 'unspecified'
      const exportRule = (EXPORT.test(sentence) || US_PERSON.test(sentence) || /\bexport (?:control|laws?|regulations?|licen[cs]es?|authori[sz]ation)\b/i.test(sentence))
        && (obligation || /\b(?:comply|compliance|conditioned on|authorization to receive)\b/i.test(sentence))
      if (exportRule) {
        if (/conditioned on|may depend/i.test(sentence)) level = 'conditional'
        add('export-authorization', level, line, preferred)
      }
      // "U.S. person" can include permanent residents and other categories, not only citizens.
      if (CITIZENSHIP.test(sentence) && !US_PERSON.test(sentence) && (obligation || /\bwith US citizenship\b/i.test(sentence))) {
        if (/\bthis role\b.*\bfor a candidate\b.*\bwith US citizenship\b/i.test(sentence)
          || /\b(?:this|the) (?:role|position|job) requires? (?:verification|proof) of (?:US |United States )?citizenship\b/i.test(normalized)) level = 'required'
        add('citizenship', level, line, preferred)
      }
      if (AUTHORIZATION.test(sentence) && obligation && !exportRule
        && (explicit || /\b(?:existing|current|valid|hold|have|possess|proof|authori[sz]ed to work)\b/i.test(sentence))) {
        add('work-authorization', level, line, preferred)
      }
      if (CLEARANCE.test(sentence) && CLEARANCE_CLAIM.test(sentence) && obligation
        && !/^(?:experience|familiarity|knowledge|understanding)\b/i.test(sentence.trim())) add('security-clearance', level, line, preferred)
      if (RESIDENCY.test(sentence) && (obligation || /\bon US soil\b/i.test(sentence))) add('residency', level, line, preferred)
    }
  }
  return {
    visa: policy.value, ...(policy.evidence ? { visaEvidence: policy.evidence } : {}),
    eligibility: {
      version: ELIGIBILITY_VERSION, rules: rules.slice(0, MAX_RULES),
      ...(text.length > MAX_TEXT || rules.length > MAX_RULES ? { truncated: true } : {}),
    },
  }
}

export function upgradeJobEligibility<T extends Job>(job: T): T {
  if (job.source === 'sample' || job.eligibility?.version === ELIGIBILITY_VERSION) return job
  const retained = [
    ...(job.evidence?.visa ? [job.evidence.visa] : []),
    ...(job.eligibility?.rules.map(rule => rule.evidence) ?? []),
    ...(job.locationResolution?.evidence ?? []),
  ]
  let facts: ReturnType<typeof eligibilityFacts>
  if (job.eligibility?.version === 1) {
    // This revision changes sponsorship interpretation. Keep legal requirements already
    // extracted from the full posting, including paragraphs absent from the saved body.
    const policy = visaFact(job.description, retained)
    const rules = [...job.eligibility.rules]
    const scopes = policyParagraphs(job.description, retained)
      .filter(line => sponsorshipScope(clean(line).replace(/^[\s#*•-]+/, ''), policy.value !== 'yes'))
      .map(line => ({ kind: 'sponsorship-scope' as const, level: 'conditional' as const, evidence: evidence(line) }))
    for (const rule of scopes) {
      if (!rules.some(previous => previous.kind === rule.kind && previous.level === rule.level && previous.evidence.text === rule.evidence.text)) rules.push(rule)
    }
    facts = {
      visa: policy.value, ...(policy.evidence ? { visaEvidence: policy.evidence } : {}),
      eligibility: {
        ...job.eligibility, version: ELIGIBILITY_VERSION, rules: rules.slice(0, MAX_RULES),
        ...(job.eligibility.truncated || job.description.length > MAX_TEXT || rules.length > MAX_RULES ? { truncated: true } : {}),
      },
    }
  } else facts = eligibilityFacts(job.description, retained)
  const { visa: _previousVisa, ...otherEvidence } = job.evidence ?? {}
  return {
    ...job, visa: facts.visa, eligibility: facts.eligibility,
    evidence: { ...otherEvidence, ...(facts.visaEvidence ? { visa: facts.visaEvidence } : {}) },
  }
}

export function eligibilitySummary(job: Job): string | null {
  const rules = job.eligibility?.rules.filter(rule => rule.kind !== 'sponsorship-scope' && rule.kind !== 'export-authorization') ?? []
  if (!rules.length) return null
  const required = rules.filter(rule => rule.level !== 'preferred')
  const kinds = [...new Set((required.length ? required : rules).map(rule => ELIGIBILITY_LABELS[rule.kind]))]
  return `${kinds.join(' · ')} ${required.length ? '조건 확인' : '우대 명시'}`
}

export function sponsorshipTransferSummary(job: Job): string | null {
  if (job.source === 'sample' || job.visa !== 'conditional') return null
  return job.eligibility?.rules.some(rule => rule.kind === 'sponsorship-scope'
    && currentSentences(rule.evidence.text).some(sentence => TRANSFER_POSITIVE.test(sentence) && !TRANSFER_NEGATIVE.test(sentence)))
    ? '기존 비자 스폰서십 변경 지원 · 적용 조건 확인' : null
}
