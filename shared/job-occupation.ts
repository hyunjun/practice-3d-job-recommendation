import { qualificationSection } from './job-qualifications'
import { isUnmappedJob } from './job-location'
import { OCCUPATION_VERSION } from './types'
import type { Catalog, FactEvidence, Job, JobManagement, JobOccupation } from './types'

const TECHNICAL_TITLE = /\b(?:engineers?|engineering|developers?|data scientists?|software architects?)\b/i
const RESEARCH_TITLE = /\b(?:scientists?|researchers?)\b/i
const TECHNICAL_RESEARCH = /\b(?:computer science|computational|machine learning|deep learning|reinforcement learning|artificial intelligence|ai|ml|cyber[\s-]?security|security|cryptography)\b/i
const MANAGEMENT_TITLE = /\b(?:managers?|directors?|head of|vice president|vp|supervisors?)\b/i
const SUPPORT_TITLE = /\b(?:solutions? (?:engineers?|architects?)|sales engineers?|(?:technical |customer |product )?support (?:software )?engineers?|customer (?:success )?engineers?|field engineers?)\b/i
const SERVICES_TITLE = /\btechnical services? engineers?\b/i
const SUPPORT_DEPARTMENT = /\b(?:technical support|customer support|support engineering)\b/i
const PHYSICAL_TITLE = /\b(?:mechanical|electrical|civil|structural|chemical|manufacturing|facilities|hardware)\b|\bdata[\s-]?cent(?:er|re)\s+(?:(?:design|systems?|operations?|infrastructure)\s+){0,2}engineers?\b/i
const COMMERCIAL_TITLE = /\b(?:recruiter|recruiting|account executive|sales representative|pre[- ]sales|post[- ]sales)\b/i
const WRITING_TITLE = /\b(?:copy[\s-]?writers?|writers?|(?:technical|content)\s+editors?)\b/i
const NON_DEVELOPMENT_TITLE = /\b(?:designers?|(?:business|administrative) partners?|assistants?|representatives?|coordinators?)\b/i
const PHYSICAL_SPECIALTY = /\b(?:aerodynamics?|aerothermal|aerospace|aerostructures?|propulsion|actuators?|fluids?|thermal|avionics|rfic|antennas?|analog|mixed[\s-]?signal|radio[\s-]?frequency)\b|\b(?:flight|launch|vehicle|materials?|metallurg(?:y|ical)|weld(?:ing)?|structures?|power electronics|pcb|pcba)(?:\s+[a-z-]+){0,2}\s+engineers?\b/i
const COMPUTING_ROLE_TITLE = /\b(?:software|firmware|embedded|back[\s-]?end|front[\s-]?end|full[\s-]?stack|data|machine learning|ai|ml|computer|cyber[\s-]?security|security|devops|site reliability)(?:\s+[a-z][a-z-]*){0,3}\s+(?:engineers?|developers?|scientists?|researchers?)\b|\bsoftware architects?\b/i
const OTHER_RESEARCH = /\b(?:ux|user experience|(?:user|market|people) research(?:ers?)?|recruit(?:ing|ment)?|medicinal chemistry|wet[- ]lab)\b|\blife sciences\b.*\bchemistry\b/i
const SOFTWARE_TITLE = /\b(?:(?:software|firmware|embedded|back[\s-]?end|front[\s-]?end|full[\s-]?stack|data|machine learning|security|devops|site reliability)\s+(?:engineers?|developers?)|software architects?)\b/i
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
    const normalized = text.replace(/[’‘]/g, "'").replace(/[:：]$/, '')
    const next = qualificationSection(text)
    if (next || /^(?:your (?:mission|impact|role)|the opportunity|role overview|what you'll be doing|what you'll do at .+)$/i.test(normalized)) {
      heading = text
      section = next === 'preferred' ? 'preferred' : next === 'excluded' || /^(?:about (?:the |our )?team|our (?:tech|stack|technology)|tech(?:nology)? stack)$/i.test(normalized)
        ? 'excluded' : next === 'required' || next === 'qualification' ? 'qualification' : 'duties'
      continue
    }
    // Inline prose can establish a role even when the publisher did not add a heading.
    const directRole = /^(?:in this (?:role|position)|as (?:a|an|the) .{0,90}(?:engineer|scientist|researcher)|your (?:role|responsibilit))/i.test(normalized)
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

export function occupationFacts(input: { title: string; description: string; departments?: string[]; management?: JobManagement }): JobOccupation {
  const title = input.title.normalize('NFKC').replace(/[‐‑–—]/g, '-').trim()
  const departments = [...new Set((input.departments ?? []).map(value => value.trim().slice(0, 1000)).filter(Boolean))].slice(0, 20)
  const titleEvidence: FactEvidence = { source: 'title', text: input.title.trim().slice(0, 1000) }
  const assessment = (category: JobOccupation['category'], evidence: FactEvidence[]): JobOccupation => ({
    version: OCCUPATION_VERSION, category, evidence: evidence.slice(0, MAX_EVIDENCE), departments,
    ...(input.management ? { management: input.management } : {}),
  })
  if (input.management?.value === 'management') return assessment('management', input.management.evidence ? [input.management.evidence] : [titleEvidence])
  // A suffix can name the product ("Software Engineer, Resource Manager").
  // A published people-manager field still takes precedence over that title.
  const primaryTitle = title.split(/[,;|]|\s-\s/)[0]
  // Engineering/developers can name the audience or supported department of
  // a writer, designer or administrator. Keep the stated role separate from
  // these qualifiers, while retaining explicit engineering/research co-roles.
  const roleTitle = primaryTitle.split(/\s+(?:for|serving|supporting)\s+|\(/i)[0]
  if ((WRITING_TITLE.test(roleTitle) || NON_DEVELOPMENT_TITLE.test(roleTitle)) && !MANAGEMENT_TITLE.test(roleTitle)
    && !SOFTWARE_TITLE.test(roleTitle) && !RESEARCH_TITLE.test(roleTitle) && !/\bengineers?\b/i.test(roleTitle)) {
    return assessment('other', [titleEvidence])
  }
  if (MANAGEMENT_TITLE.test(title) && !(SOFTWARE_TITLE.test(primaryTitle) && !MANAGEMENT_TITLE.test(primaryTitle))) {
    return assessment('management', [titleEvidence])
  }
  if (SUPPORT_TITLE.test(title)) return assessment('support', [titleEvidence])
  if ((PHYSICAL_TITLE.test(title) || COMMERCIAL_TITLE.test(title)) && !SOFTWARE_TITLE.test(title)) return assessment('other', [titleEvidence])
  // Physical specialties describe the primary job, not its product/team suffix.
  // In particular, EDA/RTL tools can serve an RFIC team, and flight software
  // infrastructure remains computing even with words between software/engineer.
  const analogVerification = /\bAMS\s+(?:verification|design)\s+engineers?\b/i.test(roleTitle)
    && /\b(?:rfic|analog|mixed[\s-]?signal)\b/i.test(title)
  if ((PHYSICAL_SPECIALTY.test(roleTitle) || analogVerification)
    && !COMPUTING_ROLE_TITLE.test(roleTitle)
    && !(RESEARCH_TITLE.test(roleTitle) && TECHNICAL_RESEARCH.test(roleTitle))) {
    return assessment('other', [titleEvidence])
  }
  if (!TECHNICAL_TITLE.test(title) && !RESEARCH_TITLE.test(title)) return assessment('unconfirmed', [titleEvidence])

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
  if (TECHNICAL_TITLE.test(title)) return assessment('engineering', [titleEvidence])
  if (OTHER_RESEARCH.test(title)) return assessment('other', [titleEvidence])
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

/** A list-only provider must still fetch generic research duties before deciding scope. */
export function needsOccupationDescription(title: string): boolean {
  const preliminary = occupationFacts({ title, description: '' })
  return isTechnicalOccupation(preliminary)
    || preliminary.category === 'unconfirmed' && RESEARCH_TITLE.test(title.normalize('NFKC'))
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
