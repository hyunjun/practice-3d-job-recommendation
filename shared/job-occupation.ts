import { qualificationSection } from './job-qualifications'
import { isUnmappedJob } from './job-location'
import { OCCUPATION_VERSION } from './types'
import type { Catalog, FactEvidence, Job, JobManagement, JobOccupation } from './types'

const TECHNICAL_TITLE = /\b(?:engineers?|engineering|developers?|data scientists?|software architects?)\b/i
const RESEARCH_TITLE = /\b(?:scientists?|researchers?)\b/i
const TECHNICAL_RESEARCH = /\b(?:computer science|computational|machine learning|deep learning|reinforcement learning|artificial intelligence|ai|ml|cyber[\s-]?security|security|cryptography)\b/i
const MANAGEMENT_TITLE = /\b(?:managers?|mgrs?|directors?|dirs?|head of|vice president|vp|supervisors?)\b/i
const SUPPORT_TITLE = /\b(?:solutions? (?:engineers?|architects?)|sales engineers?|(?:technical |customer |product )?support (?:software )?engineers?|customer (?:success )?engineers?|field engineers?)\b/i
const SERVICES_TITLE = /\btechnical services? engineers?\b/i
const SUPPORT_DEPARTMENT = /\b(?:technical support|customer support|support engineering)\b/i
const PHYSICAL_TITLE = /\b(?:mechanical|electrical|civil|structural|chemical|manufacturing|facilities|hardware)\b|\bdata[\s-]?cent(?:er|re)\s+(?:(?:design|systems?|operations?|infrastructure)\s+){0,2}engineers?\b/i
const ELECTRONICS_TITLE = /\belectronics\b|\belectronic(?:\s+development)?\s+engineers?\b/i
const PHYSICAL_ROLE_WORDS = /\b(?:mechanical|electrical|electronics?|civil|structural|chemical|manufacturing|facilities|hardware)\b/gi
const COMMERCIAL_TITLE = /\b(?:recruiter|recruiting|account executive|sales representative|pre[- ]sales|post[- ]sales)\b/i
const TALENT_TITLE = /\b(?:talent acquisition|(?:talent|recruiting|recruitment|human resources|hr)\s+(?:specialists?|partners?|sourcers?|interns?|internships?)|(?:technical\s+)?sourcers?|people operations)\b/i
const WRITING_TITLE = /\b(?:copy[\s-]?writers?|writers?|(?:technical|content)\s+editors?)\b/i
const FINANCE_TITLE = /\b(?:finance|financial|accounting|fp&a)(?:\s+(?:planning|analysis|strategy|operations?)|\s*(?:&|and)\s*(?:planning|analysis|strategy|operations?))*\s+(?:leads?|analysts?|associates?|partners?|controllers?|accountants?)\b|\baccountants?\b/i
const NON_DEVELOPMENT_TITLE = /\b(?:designers?|(?:business|market) developers?|(?:business|administrative) partners?|assistants?|representatives?|coordinators?)\b/i
const PHYSICAL_SPECIALTY = /\b(?:aerodynamics?|aerothermal|aerospace|aerostructures?|propulsion|actuators?|fluids?|thermal|avionics|rfic|antennas?|analog|mixed[\s-]?signal|radio[\s-]?frequency)\b|\b(?:flight|launch|vehicle|materials?|metallurg(?:y|ical)|weld(?:ing)?|structures?|power electronics|pcb|pcba)(?:\s+[a-z-]+){0,2}\s+engineers?\b/i
const COMPUTING_ROLE_TITLE = /\b(?:software|firmware|embedded|back[\s-]?end|front[\s-]?end|full[\s-]?stack|data|machine learning|ai|ml|computer|cyber[\s-]?security|security|devops|site reliability|cloud|mobile|ios|android|platform|infrastructure|EDA|RTL|MES|web|network)(?:\s+[a-z][a-z-]*){0,3}?\s+(?:engineers?|developers?|scientists?|researchers?)\b|\b(?:software architects?|SDETs?|electronic trading developers?)\b/i
const COMPUTING_INTERNSHIP = /\b(?:software(?:\s+(?:engineering|development))?|firmware|embedded software|back[\s-]?end|front[\s-]?end|full[\s-]?stack|mobile|ios|android|machine learning|ai|ml)\s+(?:interns?|internships?)\b/i
const NEUTRAL_TITLE = /^(?:(?:(?:summer|winter|graduate|student)\s+)?interns?(?:ships?)?|working students?|(?:tech(?:nical)?|team)\s+leads?|engineering)$/i
const COMPUTING_DISCIPLINE = /^(?:software(?:\s+(?:engineering|development))?|firmware|embedded software|back[\s-]?end|front[\s-]?end|full[\s-]?stack|mobile|ios|android|machine learning|ai|ml)$/i
const OTHER_RESEARCH = /\b(?:ux|user experience|(?:user|market|people) research(?:ers?)?|recruit(?:ing|ment)?|medicinal chemistry|wet[- ]lab)\b|\blife sciences\b.*\bchemistry\b/i
const SOFTWARE_TITLE = /\b(?:(?:software|firmware|embedded|back[\s-]?end|front[\s-]?end|full[\s-]?stack|data|machine learning|security|devops|site reliability)\s+(?:engineers?|developers?)|software architects?)\b/i
// Titles in retailers and manufacturers often put the physical specialty after
// "Engineer". These are job-level clues, never an inference from the employer.
const INDUSTRIAL_ROLE = /\b(?:supplier (?:quality|industrialization|industrialisation|indusrialization)|industrialization|homologation|process(?: development)?|field quality|incoming quality|cost|CAD|BIM|BOM|NVH|mass|maintenance|stamping|fastener|plastics|brakes|steering|suspension|seatbelts?|dimensional|acoustic|camera|NPI project)\b/i
const SUPPLIER_QUALITY_TITLE = /\bsupplier quality\b/i
const PHYSICAL_CONTEXT = /\b(?:interiors?|interior trim|chassis|seatbelts?|safety restraints?|vehicle (?:crash|electronics)|body structures?|closures|lighting systems?|charging systems?|power electronics|powertrain|drive units?|batter(?:y|ies)|wire harness(?:es)?|inverter|textiles?|home furnishing|polymers?|composites?|antenna RF|NVH)\b/i
const COMPUTING_CONTEXT = /\b(?:software|firmware|embedded|machine learning|computer vision|cloud|cybersecurity|DevOps|SRE|EDA|RTL|MES|manufacturing execution systems?|web|network|front[\s-]?end|back[\s-]?end|full[\s-]?stack)\b/i
const COMPUTING_DEPARTMENT = /\b(?:software|firmware|digital technology|cloud infrastructure|front[\s-]?end|back[\s-]?end)\b/i
const AMBIGUOUS_DESIGN = /\bdesign(?: release)? engineers?\b/i
const AMBIGUOUS_FAILURE = /\bfailure[\s-]+analysis\s+(?:engineers?|specialists?)\b/i
const ROLE_INTRODUCTION = /^(?:in this (?:role|position)|as (?:a|an|the) [^,;.!?]{0,90}?(?:engineer|scientist|researcher))\b/i
const MAX_TEXT = 100000
const MAX_EVIDENCE = 8

export const OCCUPATION_LABELS: Record<JobOccupation['category'], string> = {
  engineering: '개발·컴퓨팅 엔지니어링',
  research: '컴퓨터·AI 연구',
  support: '고객 지원·솔루션',
  management: '관리·매니저 직무',
  other: '기타 직군',
  unconfirmed: '개발·컴퓨터 연구 여부 미확인',
}

export function jobOccupationLabel(job: Job): string {
  return job.source === 'sample' ? '샘플 개발직' : OCCUPATION_LABELS[upgradeJobOccupation(job).occupation!.category]
}

interface ScopeParagraph { text: string; heading: string; kind: 'duties' | 'qualification' }

/** Job-specific sections only: a company's AI introduction is not the scientist's job. */
function scopeParagraphs(input: string): ScopeParagraph[] {
  let section: 'unknown' | 'duties' | 'qualification' | 'preferred' | 'excluded' = 'unknown'
  let heading = ''
  const result: ScopeParagraph[] = []
  for (const raw of input.slice(0, MAX_TEXT).split(/\n+/)) {
    const text = raw.trim()
    if (!text) continue
    const normalized = text.replace(/[’‘]/g, "'").replace(/[:：.]$/, '')
    const next = qualificationSection(normalized)
    const dutiesHeading = /^(?:you(?:'ll| will)|your (?:general |specific )?responsibilities(?: (?:will|might) include)?|what you(?:'ll| will) (?:actually do|own))$/i.test(normalized)
    const qualificationsHeading = /^(?:you have|what you bring)$/i.test(normalized)
    if (next || dutiesHeading || qualificationsHeading || /^(?:your (?:mission|impact|role)|the opportunity|role overview|what you'll be doing|what you'll do at .+)$/i.test(normalized)) {
      heading = text
      section = next === 'preferred' ? 'preferred' : next === 'excluded' || /^(?:about (?:the |our )?team|our (?:tech|stack|technology)|tech(?:nology)? stack)$/i.test(normalized)
        ? 'excluded' : next === 'required' || next === 'qualification' || qualificationsHeading ? 'qualification' : 'duties'
      continue
    }
    // Inline prose can establish a role even when the publisher did not add a heading.
    const directRole = ROLE_INTRODUCTION.test(normalized) || /^your (?:role|responsibilit)/i.test(normalized)
    const directDuty = /^you(?:'ll| will)\b/i.test(normalized)
    if (section === 'preferred' || section === 'excluded' && !directRole
      || section === 'unknown' && !directRole && !directDuty || text.length > 2800) continue
    if (/\b(?:preferred|preferably|nice[- ]to[- ]have|bonus (?:points|skills)|a bonus|not required|not necessary)\b/i.test(text)) continue
    result.push({ text, heading: section === 'excluded' || section === 'unknown' ? '' : heading, kind: section === 'qualification' ? 'qualification' : 'duties' })
  }
  return result
}

function paragraphEvidence(paragraph: ScopeParagraph): FactEvidence {
  return { source: 'description', text: [paragraph.heading, paragraph.text].filter(Boolean).join('\n') }
}

const TECHNICAL_WORK = /\b(?:develop\w*|design\w*|build\w*|train\w*|fine[- ]?tun\w*|research\w*|evaluat\w*|improv\w*|scal\w*|implement\w*|deploy\w*|maintain\w*|writ\w*|programm\w*|automat\w*|reverse[- ]engineer\w*|leverag\w*)\b.{0,240}\b(?:software|code|algorithms?|machine learning|deep learning|reinforcement learning|llms?|(?:large )?language models?|neural networks?|(?:generative|statistical|predictive|foundation|sota|state[- ]of[- ]the[- ]art|ai|ml) models?|(?:ai|ml) (?:systems?|agents?)|model training|eval(?:uation)? datasets?|(?:analysis|data|production data) pipelines?|computational infrastructure|detection (?:systems?|signals?)|distributed systems?)\b/i
const ENGINEERING_QUALIFICATION = /\b(?:experience|skills?|proficiency|proficient|expertise|background)\b.{0,140}\b(?:software engineering|software development|(?:ml|ai) (?:systems?|models?)|building (?:machine learning|generative|neural)|training (?:llms?|language models)|scientific computing)\b|\b(?:software engineering|software development)\s+(?:skills?|experience)\b/i
const PEOPLE_MANAGEMENT_WORK = /\b(?:your direct reports|taken on direct reports|conduct(?:ing)? performance (?:reviews|evaluations)|manage(?:ment of| and (?:develop|mentor))? (?:a |the |your )?team of .{0,60}engineers)\b/i
const SUPPORT_WORK = /\b(?:customer service|technical support|support (?:tickets?|cases?|queues?)|troubleshoot(?:ing)? .{0,60}(?:customer|client))\b/i

// These match a position, not a department serving that position. In particular,
// "Data Center Infrastructure Engineer" and "Embedded Hardware Engineer" must
// not become computing merely because a broad computing modifier precedes them.
function sdetPosition(title: string): boolean {
  const otherPosition = [NON_DEVELOPMENT_TITLE, WRITING_TITLE, FINANCE_TITLE, TALENT_TITLE, /\brecruiters?\b/i]
  if (!otherPosition.some(pattern => pattern.test(title))) return /\bSDETs?\b/i.test(title)
  // A conjunction can join activities within one position ("SDET Training and
  // Development Coordinator"). Only a complete SDET co-role overrides that head.
  return title.split(/\s*(?:\/|&|\+|\band\b)\s*/i).some(role => /\bSDETs?(?:\s+(?:I{1,3}|IV|V|\d+))?$/i.test(role)
    && !otherPosition.some(pattern => pattern.test(role)))
}

function computingPosition(title: string): boolean {
  const namedSdet = sdetPosition(title)
  return [...title.matchAll(new RegExp(COMPUTING_ROLE_TITLE, 'gi'))].some(([position]) => {
    // A title such as "SDET Training Coordinator" names a coordinator; an
    // independently stated SDET co-role still establishes computing work.
    if (/^SDETs?$/i.test(position) && !namedSdet) return false
    if (!PHYSICAL_TITLE.test(position) && !ELECTRONICS_TITLE.test(position) || SOFTWARE_TITLE.test(position)) return true
    const physical = [...position.matchAll(PHYSICAL_ROLE_WORDS)].at(-1)
    // A modifier such as "reliability" or "quality" does not turn a hardware
    // position into software. A following explicit position ("Security Engineer")
    // does. A data-center compound has no such physical-word suffix to reinterpret.
    // Continue to later co-roles in this primary title if this position is physical.
    return Boolean(physical && COMPUTING_ROLE_TITLE.test(position.slice(physical.index + physical[0].length)))
  })
}

const FAILURE_SOFTWARE_WORK = /\b(?:develop\w*|design\w*|build\w*|implement\w*|maintain\w*|writ\w*|programm\w*|deliver\w*)\b.{0,200}?\b(?:software|firmware|application code|production code)\b/gi
const FAILURE_PHYSICAL_WORK = /\b(?:inspect\w*|cross[\s-]?section\w*|examin\w*|test(?:ing|ed)?|analy[sz]\w*|investigat\w*|diagnos\w*|characteri[sz]\w*|identif\w*|isolat\w*|determin\w*)\b.{0,200}?\b(?:hardware|boards?|circuits?|PCBAs?|PCBs?|semiconductors?|microelectronics|components?|solder joints?|silicon|piece parts?)\b|\b(?:physical|destructive|non[\s-]destructive|root[\s-]cause|failure)\s+(?:failure\s+)?analys(?:is|es)\b.{0,200}?\b(?:hardware|boards?|circuits?|PCBAs?|PCBs?|semiconductors?|microelectronics|components?|solder joints?|silicon|piece parts?)\b/gi

function dutyClauses(text: string): string[] {
  return text.replace(/[’‘]/g, "'").split(/(?:;\s*|[.!?]\s+|\s+but\s+|\s+(?:and|while|then)\s+(?=(?:you|this (?:role|position)|(?:the|our|another|other) .{0,35}team)\b))/i)
    .map(value => value.replace(/^[\s*•-]+/, '').trim()).filter(Boolean)
}

function remainingActionObject(text: string): string {
  return text.replace(/^\s+(?:(?:systems?|tools?|applications?|components?|features?|services?|tests?)\s+){0,3}/i, ' ')
}

const NOMINAL_ACTION = /^(?:[a-z-]+ing|cross[\s-]sectioning|(?:physical|destructive|non[\s-]destructive|root[\s-]cause|failure)\s+(?:failure\s+)?analys(?:is|es))\b/i

/** Responsibilities can quote another team's work or explicitly negate a duty. */
function attributableAction(text: string, action: RegExpExecArray, actions: RegExpExecArray[]): boolean {
  if (/^(?:(?:required|relevant|prior|proven|professional|strong)\s+)*(?:experience|expertise|proficiency|knowledge|familiarity|ability|background)\b|^(?:you (?:have|bring)|candidates? (?:have|with|must have)|(?:must|should) have)\b|^\d.{0,35}\byears?\b.{0,25}\bexperience\b/i.test(text)) return false
  const before = text.slice(0, action.index)
  if (/\b(?:not(?!\s+only\b)|never|without|no longer|don't|doesn't|won't|cannot|can't)\b[^.!?;]{0,90}$/i.test(before)) return false
  const team = /\b(?:(?:the|our|another|other|a separate)\s+(?:[a-z-]+\s+){0,4}teams?|colleagues|customers|clients)\b[^.!?;]{0,90}$/i.exec(before)
  if (team && !/\b(?:you|this (?:role|position)|your (?:role|responsibility))\b/i.test(team[0])) return false
  // "Developing software and maintaining firmware are handled by another team"
  // assigns both nominal actions to that team. An imperative or explicitly
  // assigned "you will develop" duty has its own subject and predicate.
  let end = action.index + action[0].length
  // A governing predicate need not use an auxiliary ("You focus on developing").
  // Anchor it to a clause boundary so "For this role developing..." is context,
  // and exclude prepositional phrases such as "Your role in developing...".
  const governedBefore = before.replace(ROLE_INTRODUCTION, '').trimStart()
  const governingPattern = /(?:^|,\s*)(?:you|(?:this|your|the) (?:role|position)|your responsibilit(?:y|ies))\s+(?!(?:in|on|for|of|to|with|at|as|from|within|through|via)\b)[a-z]+\b[^,;.!?]{0,120}$/i
  const governingSubject = governingPattern.test(before) || governingPattern.test(governedBefore)
  const explicitSubject = governingSubject || /\b(?:you(?:'ll|'re|'d)\b|(?:you|(?:this|your|the) (?:role|position)|your responsibilit(?:y|ies))\s+(?:will|would|can|could|must|should|shall|is|are|was|were|has|have|includes?|involves?)\b)[^,;.!?]{0,120}$/i.test(before)
  if (NOMINAL_ACTION.test(action[0]) && !explicitSubject) {
    for (const sibling of actions) {
      if (sibling.index < end) continue
      const between = remainingActionObject(text.slice(end, sibling.index))
      if (!NOMINAL_ACTION.test(sibling[0]) || !/^\s*(?:,\s*(?:(?:and|or|&)\s*)?|(?:and|or|&)\s+)$/i.test(between)) break
      end = sibling.index + sibling[0].length
    }
  }
  const after = remainingActionObject(text.slice(end))
  if (/^\s*(?:(?:is|are|was|were)\s+(?:not(?!\s+only\b)|never|no longer)|(?:will|would)\s+not be|isn't|aren't)\s+(?:required|expected|part of (?:this|your|the) (?:role|position|job)|(?:your|our) (?:duties|responsibilit))/i.test(after)) return false
  if (/^\s*(?:is|are|was|were|will be|would be)\s+(?:(?:normally|entirely|primarily)\s+)?(?:handled|owned|done|performed|undertaken|developed|maintained)\s+by\s+(?:(?:the|our|another|other|a separate)\s+(?:[a-z-]+\s+){0,4}teams?|colleagues|customers|clients)\b/i.test(after)) return false
  return true
}

function failureDuty(paragraph: ScopeParagraph, kind: 'physical' | 'computing'): boolean {
  if (paragraph.kind !== 'duties') return false
  return dutyClauses(paragraph.text).some(clause => {
    const softwareMatches = [...clause.matchAll(FAILURE_SOFTWARE_WORK)]
    const physicalMatches = [...clause.matchAll(FAILURE_PHYSICAL_WORK)]
    const actions = [...softwareMatches, ...physicalMatches].sort((a, b) => a.index - b.index)
    const software = softwareMatches.filter(match => attributableAction(clause, match, actions))
    if (kind === 'computing') return software.length > 0
    const manual = [...clause.matchAll(/\b(?:by hand|manually|personally)\b/gi)]
      .filter(match => attributableAction(clause, match, actions))
    return physicalMatches.some(match => {
      if (!attributableAction(clause, match, actions)) return false
      if (/\b(?:software|firmware|application|code)[\s-]+components?\b/i.test(match[0])) return false
      // A subsequent instruction can identify its worker after the object:
      // "... then inspect failed components by hand". That is manual work even
      // when an earlier software-purpose clause is in the same sentence.
      const nextAction = actions.find(action => action.index > match.index)
      const scopeEnd = nextAction?.index ?? clause.length
      if (manual.some(marker => marker.index >= match.index && marker.index < scopeEnd)) return true
      // Developing software *to inspect boards* is a software duty. An
      // independent "inspect boards" duty still wins in a mixed physical role.
      const softwarePurpose = software.some(work => {
        const end = work.index + work[0].length
        if (end > match.index) return false
        const scope = clause.slice(end, match.index)
        return /^\s+(?:(?!(?:and|but|while|you|this|your)\b)[a-z-]+\s+){0,3}(?:to|that|which)\b/i.test(scope)
          && !/\b(?:you|this (?:role|position)|your (?:role|responsibility)|personally|manually|independently|separately)\b/i.test(scope)
      })
      return !softwarePurpose
    })
  })
}

function normalizedOccupationTitle(title: string): string {
  return title.normalize('NFKC').replace(/[‐‑–—]/g, '-').trim()
}

export function occupationFacts(input: { title: string; description: string; departments?: string[]; management?: JobManagement }): JobOccupation {
  const title = normalizedOccupationTitle(input.title)
  const departments = [...new Set((input.departments ?? []).map(value => value.trim().slice(0, 1000)).filter(Boolean))].slice(0, 20)
  const titleEvidence: FactEvidence = { source: 'title', text: input.title.trim().slice(0, 1000) }
  const assessment = (category: JobOccupation['category'], evidence: FactEvidence[]): JobOccupation => ({
    version: OCCUPATION_VERSION, category, evidence: evidence.slice(0, MAX_EVIDENCE), departments,
    ...(input.management ? { management: input.management } : {}),
  })
  if (input.management?.value === 'management') return assessment('management', input.management.evidence ? [input.management.evidence] : [titleEvidence])
  // A suffix can name the product ("Software Engineer, Resource Manager").
  // A published people-manager field still takes precedence over that title.
  const segments = title.split(/[,;|]|\s-\s/).map(segment => segment.trim()).filter(Boolean)
  const head = segments[0] ?? ''
  const primaryTitle = NEUTRAL_TITLE.test(head) ? segments.find(segment => !NEUTRAL_TITLE.test(segment)) ?? head : head
  // Engineering/developers can name the audience or supported department of
  // a writer, designer, administrator or finance professional. Keep the stated
  // role separate from qualifiers, retaining engineering/research co-roles.
  const roleTitle = primaryTitle.split(/\s+(?:for|serving|supporting)\s+|\(/i)[0]
  const computingDiscipline = COMPUTING_INTERNSHIP.test(roleTitle)
    || NEUTRAL_TITLE.test(head) && COMPUTING_DISCIPLINE.test(roleTitle)
  const computingRole = computingPosition(roleTitle)
  const explicitPosition = computingRole || computingDiscipline
  const ambiguousFailure = AMBIGUOUS_FAILURE.test(roleTitle) && !explicitPosition
    && !PHYSICAL_TITLE.test(roleTitle) && !ELECTRONICS_TITLE.test(roleTitle)
  const technicalTitle = TECHNICAL_TITLE.test(title) || computingDiscipline || /\bSDETs?\b/i.test(roleTitle)
  if (TALENT_TITLE.test(roleTitle) && !MANAGEMENT_TITLE.test(roleTitle) && !explicitPosition) return assessment('other', [titleEvidence])
  if ((WRITING_TITLE.test(roleTitle) || NON_DEVELOPMENT_TITLE.test(roleTitle) || FINANCE_TITLE.test(roleTitle)) && !MANAGEMENT_TITLE.test(roleTitle)
    && !computingRole && !RESEARCH_TITLE.test(roleTitle) && !/\bengineers?\b/i.test(roleTitle)) {
    return assessment('other', [titleEvidence])
  }
  if (MANAGEMENT_TITLE.test(title) && !(SOFTWARE_TITLE.test(primaryTitle) && !MANAGEMENT_TITLE.test(primaryTitle))) {
    return assessment('management', [titleEvidence])
  }
  if (SUPPORT_TITLE.test(title)) return assessment('support', [titleEvidence])
  if (((PHYSICAL_TITLE.test(title) || ELECTRONICS_TITLE.test(title)) && !ambiguousFailure
    || COMMERCIAL_TITLE.test(title) || TALENT_TITLE.test(title) || SUPPLIER_QUALITY_TITLE.test(title)) && !explicitPosition) {
    return assessment('other', [titleEvidence])
  }
  // Physical specialties describe the primary job, not its product/team suffix.
  // In particular, EDA/RTL tools can serve an RFIC team, and flight software
  // infrastructure remains computing even with words between software/engineer.
  const analogVerification = /\bAMS\s+(?:verification|design)\s+engineers?\b/i.test(roleTitle)
    && /\b(?:rfic|analog|mixed[\s-]?signal)\b/i.test(title)
  if ((PHYSICAL_SPECIALTY.test(roleTitle) || analogVerification)
    && !explicitPosition
    && !(RESEARCH_TITLE.test(roleTitle) && TECHNICAL_RESEARCH.test(roleTitle))) {
    return assessment('other', [titleEvidence])
  }
  if (!technicalTitle && !RESEARCH_TITLE.test(title) && !ambiguousFailure) return assessment('unconfirmed', [titleEvidence])

  const paragraphs = scopeParagraphs(input.description)
  if (input.management?.value !== 'individual') {
    const management = paragraphs.find(paragraph => paragraph.kind === 'duties'
      && PEOPLE_MANAGEMENT_WORK.test(paragraph.text) && !/\b(?:not|no|without)\b.{0,50}\b(?:manag|direct reports)/i.test(paragraph.text))
    if (management) return assessment('management', [paragraphEvidence(management)])
  }
  const supportDepartment = departments.find(department => SUPPORT_DEPARTMENT.test(department))
  const supportWork = paragraphs.find(paragraph => SUPPORT_WORK.test(paragraph.text))
  if (SERVICES_TITLE.test(title) && (supportDepartment || supportWork)
    || supportDepartment && !SOFTWARE_TITLE.test(title)) {
    return assessment('support', [
      titleEvidence,
      ...(supportDepartment ? [{ source: 'board' as const, text: supportDepartment }] : []),
      ...(supportWork ? [paragraphEvidence(supportWork)] : []),
    ])
  }
  if (OTHER_RESEARCH.test(roleTitle) && !explicitPosition && !/\b(?:engineers?|developers?)\b/i.test(roleTitle)) {
    return assessment('other', [titleEvidence])
  }
  if (ambiguousFailure) {
    const physical = paragraphs.find(paragraph => failureDuty(paragraph, 'physical'))
    if (physical) return assessment('other', [titleEvidence, paragraphEvidence(physical)])
    const computing = paragraphs.filter(paragraph => failureDuty(paragraph, 'computing'))
    return assessment(computing.length ? 'engineering' : 'unconfirmed', [titleEvidence, ...computing.map(paragraphEvidence)])
  }
  const physicalDepartment = departments.find(department => PHYSICAL_CONTEXT.test(department)
    || /\b(?:mechanical|manufacturing|mfg|industrialization|vehicle engineering|supplier quality|corporate quality|electronics)\b/i.test(department))
  const physicalTitle = INDUSTRIAL_ROLE.test(roleTitle) || PHYSICAL_CONTEXT.test(title) || PHYSICAL_SPECIALTY.test(title)
  const explicitComputing = explicitPosition || COMPUTING_CONTEXT.test(title)
  if (technicalTitle && (physicalTitle || physicalDepartment) && !explicitComputing) {
    return assessment('other', [titleEvidence, ...(physicalDepartment ? [{ source: 'board' as const, text: physicalDepartment }] : [])])
  }
  // "Design Engineer" also describes textiles, furniture and industrial design.
  // A software duty/qualification can establish the computing interpretation.
  if (AMBIGUOUS_DESIGN.test(roleTitle) && !explicitComputing) {
    const physical = paragraphs.find(paragraph => paragraph.kind === 'duties' && PHYSICAL_CONTEXT.test(paragraph.text))
    if (physical) return assessment('other', [titleEvidence, paragraphEvidence(physical)])
    const department = departments.find(value => COMPUTING_DEPARTMENT.test(value))
    const computing = paragraphs.filter(paragraph => TECHNICAL_WORK.test(paragraph.text)
      || paragraph.kind === 'qualification' && ENGINEERING_QUALIFICATION.test(paragraph.text)
      || /\b(?:front[\s-]?end|back[\s-]?end|full[\s-]?stack|web apps?|web applications?)\b/i.test(paragraph.text)
        && /\b(?:develop\w*|implement\w*|engineer\w*|build\w*|experience|proficien\w*)\b/i.test(paragraph.text))
    if (!computing.length && !department) return assessment('unconfirmed', [titleEvidence])
    return assessment('engineering', [
      titleEvidence, ...(department ? [{ source: 'board' as const, text: department }] : []), ...computing.map(paragraphEvidence),
    ])
  }
  if (technicalTitle) return assessment('engineering', [titleEvidence])
  if (OTHER_RESEARCH.test(title) && !explicitPosition) return assessment('other', [titleEvidence])
  const technical = paragraphs.filter(paragraph => TECHNICAL_WORK.test(paragraph.text)
    || paragraph.kind === 'qualification' && ENGINEERING_QUALIFICATION.test(paragraph.text))
  if (TECHNICAL_RESEARCH.test(title) || technical.length) return assessment('research', [
    titleEvidence, ...technical.slice(0, MAX_EVIDENCE - 1).map(paragraphEvidence),
  ])
  return assessment('unconfirmed', [titleEvidence])
}

export function isTechnicalOccupation(occupation: JobOccupation): boolean {
  return occupation.category === 'engineering' || occupation.category === 'research'
}

/** Body-dependent titles must reach provider detail retrieval before deciding scope. */
export function needsOccupationDescription(title: string): boolean {
  const normalized = normalizedOccupationTitle(title)
  const preliminary = occupationFacts({ title: normalized, description: '' })
  return isTechnicalOccupation(preliminary)
    || preliminary.category === 'unconfirmed' && (RESEARCH_TITLE.test(normalized) || AMBIGUOUS_DESIGN.test(normalized) || AMBIGUOUS_FAILURE.test(normalized))
}

export function upgradeJobOccupation<T extends Job>(job: T): T {
  if (job.source === 'sample' || job.occupation?.version === OCCUPATION_VERSION) return job
  // Older snapshots may have only the department labels used for a role. Missing
  // job-level metadata is never manufactured, and collection dates remain unchanged.
  const departments = job.occupation?.departments
    ?? job.roleClassification?.evidence.filter(evidence => evidence.source === 'board').map(evidence => evidence.text) ?? []
  // Old evidence may come from beyond the stored description's length limit.
  const omittedEvidence = job.occupation?.evidence.filter(evidence => evidence.source === 'description'
    && !job.description.includes(evidence.text.split('\n').at(-1) ?? '')).map(evidence => evidence.text) ?? []
  return {
    ...job, occupation: occupationFacts({
      title: job.title, description: [job.description, ...omittedEvidence].join('\n'),
      departments, management: job.occupation?.management,
    }),
  }
}

export function isTechnicalJob(job: Job): boolean {
  return job.source === 'sample' || isTechnicalOccupation(upgradeJobOccupation(job).occupation!)
}

export function filterTechnicalJobs<T extends Job>(input: T[], unmappedCount: number | null): { jobs: T[]; unmappedCount: number | null } {
  const upgraded = input.map(job => upgradeJobOccupation(job))
  const removed = upgraded.filter(job => !isTechnicalJob(job))
  return {
    jobs: upgraded.filter(isTechnicalJob),
    unmappedCount: unmappedCount === null ? null : Math.max(0, unmappedCount - removed.filter(isUnmappedJob).length),
  }
}

export function upgradeCatalogOccupations(catalog: Catalog): Catalog {
  if (catalog.source === 'sample') return catalog
  const result = filterTechnicalJobs(catalog.jobs, catalog.unmappedCount)
  const counts = new Map<string, number>()
  for (const job of result.jobs) counts.set(job.companyId, (counts.get(job.companyId) ?? 0) + 1)
  return { ...catalog, ...result, boards: catalog.boards.map(board => ({ ...board, included: counts.get(board.companyId) ?? 0 })) }
}
