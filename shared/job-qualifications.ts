import { extractSkills } from './profile'
import { QUALIFICATIONS_VERSION } from './types'
import type { ExperienceRequirement, Job, JobQualifications, QualificationKind, SkillRequirement } from './types'

type Section = QualificationKind | 'other' | 'excluded'
const OPTIONAL = /\b(?:preferred|preferably|nice[- ]to[- ]have|bonus (?:skills|points)|a bonus|ideally|added plus|a plus|you (?:might|may) have)\b|우대|있으면 좋/i
const CANDIDATE = /\b(?:you (?:have|bring|know|are (?:proficient|familiar|fluent))|candidates? (?:have|with|must)|proficien\w*|expertise|familiarity|fluency|knowledge of|skilled in|experience (?:in|with|as|building|developing|working|using)|years? (?:of )?(?:\w+[- ]+){0,4}experience)\b|경력|경험|능숙|숙련/i
const REQUIRED = /\b(?:must (?:have|be|know)|required (?:skills?|experience|qualifications)|(?:is|are) required|requirements? include|need to (?:have|know))\b|필수|반드시/i
const NON_REQUIRED = /\b(?:no (?:prior |previous )?.{0,70}experience.{0,30}(?:required|necessary)|not (?:required|necessary)|don['’]t (?:need|require)|do not (?:need|require))\b|필수.{0,5}아님|경험.{0,15}무관/i
const MAX_TEXT = 100000
const MAX_RULES = 100

/** Headings define the kind of claim; a general "About you" is not a must-have. */
function sectionOf(value: string): Section | undefined {
  const text = value.replace(/^[\s#*•-]+|[:：\s]+$/g, '').replace(/[’‘]/g, "'").trim()
  if (text.length > 150) return undefined
  if (/^(?:(?:strongly )?preferred(?: (?:qualifications|requirements|skills))?|nice[- ]to[- ]haves?(?: skills)?|bonus(?: skills?(?: & attributes)?| points)?(?: if you(?: have)?)?|ideally(?: you (?:have|will be))?|while (?:it's )?not required, it's an added plus if you also have|strong candidates (?:may|might)(?: also)?(?: have(?: experience (?:with|in))?)?|it would be (?:ideal|great) if you(?: also)?(?: have)?|what makes you stand out(?: \(strong plus\))?|your application will be all the more interesting if you also have|우대\s*(?:사항|조건|역량|요건))$/i.test(text)) return 'preferred'
  if (/^(?:(?:minimum|required|basic|essential|core|role|job)\s+)?requirements(?:\s*\(must-have skills\))?$|^required$|^(?:minimum|required|basic|essential)\s+qualifications$|^must[- ]haves?(?: skills)?$|^필수\s*(?:사항|조건|역량|요건)$/i.test(text)) return 'required'
  if (/^(?:who you are|about you|your expertise|what (?:you(?:'ll| will)? (?:bring|need)|we(?:'re| are)? looking for)|we'd love to hear from you if you have|you (?:may|might) be a (?:good|great) fit if you(?: have)?|strong candidates will have|(?:key )?qualifications|skills(?: and experience)?|key competencies|자격\s*요건|지원\s*자격)$/i.test(text)) return 'qualification'
  if (/^(?:what you(?:'ll| will)? (?:do|own)(?: at .+)?|responsibilities|(?:about )?(?:the |this )?(?:role|job|team)|(?:your |key )?responsibilities|our (?:tech|stack|technology)|tech(?:nology)? stack|position (?:summary|expectations)|what you'll work on|in this role(?:,? you will)?|the difference you will make|success measures|what success looks like|strong candidates need not have|주요\s*업무|담당\s*업무|기술\s*스택)$/i.test(text)) return 'context'
  if (/^(?:about .+|who we are|why .+|what we offer|(?:our |your )?benefits|compensation.*|salary.*|pay transparency.*|privacy.*|(?:our )?(?:values|culture)|additional considerations|where you(?:'ll| will)? be|location.*|how (?:we|to|you) .+|learn .+|interview.*|hiring.*|application (?:process|instructions|steps)|회사\s*소개|복리\s*후생|근무\s*조건|전형\s*절차)$/i.test(text)) return 'excluded'
  return undefined
}

function isOtherHeading(text: string): boolean {
  return text.length < 90 && !extractSkills(text).length && !CANDIDATE.test(text) && !/\d/.test(text)
    && (/^[\p{L}][\p{L}\s/'’&()-]+:$/u.test(text) || /^(?:[A-Z][a-z]+[ ]+){1,5}[A-Z][a-z]+$/.test(text))
}

function kindOf(text: string, section: Section): QualificationKind | undefined {
  if (section === 'excluded') return undefined
  if (OPTIONAL.test(text)) return 'preferred'
  if (NON_REQUIRED.test(text)) return 'context'
  if (REQUIRED.test(text)) return 'required'
  if (section === 'other') {
    if (/^(?:our |we (?:use|write|build|develop|work)|this (?:role|team)|the (?:team|company))/i.test(text) && !/\byou (?:have|bring|must)\b/i.test(text)) return 'context'
    if (CANDIDATE.test(text)) return 'qualification'
    if (/\b(?:we (?:use|write|build|develop)|our (?:stack|systems?)|you(?:'ll| will) (?:use|work with|build|develop))\b/i.test(text)) return 'context'
    return undefined
  }
  return section
}

function clauseParts(line: string): string[] {
  const optional: string[] = []
  const main = line.replace(/\(([^()]{1,300})\)/g, (whole, inside: string) => {
    if (!OPTIONAL.test(inside) && !NON_REQUIRED.test(inside)) return whole
    optional.push(inside)
    return ''
  })
  return [...main.split(/;\s*|(?<!\be\.g\.)(?<!\bi\.e\.)(?<!\bU\.S\.)(?<=[.!?])\s+(?=[A-Z가-힣])|,\s+(?=(?:ideally|preferably)\b)|\s+(?:and|but)\s+(?=(?:ideally|preferably)\b)/), ...optional].map(part => part.trim()).filter(Boolean)
}

function jobSkills(text: string, employer: string): string[] {
  let skills = extractSkills(text)
  if (skills.includes('JavaScript') && !/\bjavascript\b|(?<![\w.])js\b/i.test(text)) skills = skills.filter(skill => skill !== 'JavaScript')
  if (skills.includes('TypeScript') && !/\btypescript\b|(?<![\w.])ts\b/i.test(text)) skills = skills.filter(skill => skill !== 'TypeScript')
  // React Native does not establish a separate React web requirement.
  if (skills.includes('React Native') && !/\breact(?:\.?js)?\b/i.test(text.replace(/\breact[\s-]+native\b/gi, ''))) skills = skills.filter(skill => skill !== 'React')
  return skills.filter(skill => {
    if (skill.toLowerCase() !== employer.toLowerCase()) return true
    const escaped = skill.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const withoutSelfReferences = text.replace(new RegExp(`\\b(?:at|join|about|why)\\s+${escaped}\\b|\\b${escaped}['’]s\\b`, 'gi'), '')
    if (!extractSkills(withoutSelfReferences).includes(skill)) return false
    // An employer can also be a tool name. Retain tool proficiency, not membership of that company.
    return new RegExp(`^${escaped}$|\\b(?:experience|proficien\\w*|fluency|familiarity|expertise)\\s+(?:working\\s+)?(?:with|in|using)\\b[^.]{0,70}\\b${escaped}\\b|\\b(?:using|use|knowledge of|databases?|tools?|migrat\\w*)\\b[^.]{0,60}\\b${escaped}\\b|\\b${escaped}\\s+(?:experience|proficiency|expertise|skills|knowledge)\\b`, 'i').test(withoutSelfReferences)
  })
}

function skillOperator(text: string, skills: string[]): SkillRequirement['match'] {
  if (skills.length <= 1) return /\b(?:or (?:equivalent|similar|another)|such as|e\.g\.|like)\b/i.test(text) ? 'unspecified' : 'all'
  const alternatives = /\b(?:one of|either|any of|at least one|such as|e\.g\.|like)\b/i.test(text)
  const or = /\bor\b|또는|혹은/i.test(text)
  const and = /\band\b|및|그리고/i.test(text.replace(/\band\/or\b/gi, 'or'))
  // Mixed lists can contain independent requirements and examples. Do not flatten them into OR.
  if ((or || alternatives) && and) return 'unspecified'
  if (or || alternatives || /\band\/or\b/i.test(text)) return 'any'
  return 'all'
}

const NUMBER = '(?:\\d{1,2}(?:\\.\\d+)?|zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty)'
const NUMBERS: Record<string, number> = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, fifteen: 15, twenty: 20 }
const numeric = (text: string) => NUMBERS[text.toLowerCase()] ?? Number(text)

function experienceOf(text: string, kind: QualificationKind, evidence: ExperienceRequirement['evidence']): ExperienceRequirement[] {
  if (!/\b(?:experience|engineering|development|engineer|developer|research|technical|professional)\b|경력|경험/i.test(text)) return []
  if (/\b(?:company|our team|our founders|we collectively)\b.{0,80}\b(?:years|experience)\b/i.test(text) && !/\byou\b/i.test(text)) return []
  const pattern = new RegExp(`(?<![\\w.])(${NUMBER})(?:\\s*\\((\\d{1,2})\\))?(?:\\s*(?:[-–—]|to)\\s*(${NUMBER}))?\\s*\\+?\\s*(years?|yrs?|months?|년|개월)(?:\\s*이상)?`, 'gi')
  const found = [...text.matchAll(pattern)]
  const conditional = /\b(?:bachelor|master|phd|ph\.d|doctorate|degree|in lieu|in (?:the )?alternative|depending on)\b|학위|학사|석사|박사/i.test(text)
    || found.some((match, index) => index > 0 && /(?:\bor|또는|혹은)(?:\s+[\p{L}'’-]+){0,6}\s*$/iu.test(text.slice(found[index - 1].index + found[index - 1][0].length, match.index)))
  return found.flatMap(match => {
    const tail = text.slice(match.index + match[0].length, match.index + match[0].length + 100)
    if (/^\s*(?:of )?(?:university|college|education|age|paid leave|vacation)\b/i.test(tail)) return []
    const before = text.slice(Math.max(0, match.index - 80), match.index)
    const adjacentExperience = /^\s*['’]?\s*(?:of\s+)?(?:[\w/-]+\s+){0,6}experience\b|^\s*(?:of\s+)?(?:경력|경험)/i.test(tail)
      || /\bexperience\s+(?:of\s+|for\s+)?(?:at least\s+)?$|(?:경력|경험)\s*$/i.test(before)
    const workDuration = /^\s*(?:(?:of|in|as)\s+)?(?:[\w/-]+\s+){0,3}(?:engineering|development|engineer|developer|technical individual contributor)\b|^\s*(?:of\s+)?(?:building|developing|shipping|leading|programming|coding|working|delivering)\b/i.test(tail)
    if (!adjacentExperience && !workDuration) return []
    const factor = /month|개월/i.test(match[4]) ? 1 / 12 : 1
    const minYears = numeric(match[2] || match[1]) * factor
    const maxYears = match[3] ? numeric(match[3]) * factor : undefined
    if (!Number.isFinite(minYears) || minYears < 0 || minYears > 50 || (maxYears !== undefined && (maxYears < minYears || maxYears > 50))) return []
    return [{ kind, minYears, ...(maxYears !== undefined ? { maxYears } : {}), conditional, evidence }]
  })
}

export function qualificationFacts(input: string, employer = ''): Pick<Job, 'skills' | 'minExperience' | 'qualifications'> {
  const qualifications: JobQualifications = { version: QUALIFICATIONS_VERSION, skills: [], experience: [] }
  let section: Section = 'other'
  let heading = ''
  let truncated = input.length > MAX_TEXT
  const lines = input.slice(0, MAX_TEXT).split(/\r?\n/).map(line => line.trim().replace(/^(?:[-*•]\s+|\d+[.)]\s+)/, '')).filter(Boolean)
  for (let line of lines) {
    const colon = line.indexOf(':')
    const inlineHeading = colon > 0 ? sectionOf(line.slice(0, colon)) : undefined
    if (inlineHeading && colon < line.length - 1) {
      heading = line.slice(0, colon).trim()
      section = inlineHeading
      line = line.slice(colon + 1).trim()
    } else {
      const next = sectionOf(line)
      if (next !== undefined || isOtherHeading(line)) {
        section = next ?? 'other'
        heading = line
        continue
      }
    }
    if (/\b(?:equal opportunity|reasonable accommodation|candidate privacy|pay transparency)\b/i.test(line)) {
      section = 'excluded'
      heading = ''
      continue
    }
    if (line.length > 2000) { truncated = true; continue }
    const lineKind = kindOf(line, section)
    for (const clause of clauseParts(line)) {
      const kind = kindOf(clause, section) ?? lineKind
      if (!kind) continue
      const evidence = { source: 'description' as const, text: [heading, clause].filter(Boolean).join('\n').slice(0, 2000) }
      const skills = jobSkills(clause, employer)
      if (skills.length) qualifications.skills.push({ kind, skills, match: skillOperator(clause, skills), evidence })
      qualifications.experience.push(...experienceOf(clause, kind, evidence))
      if (qualifications.skills.length > MAX_RULES || qualifications.experience.length > MAX_RULES) { truncated = true; break }
    }
    if (qualifications.skills.length > MAX_RULES || qualifications.experience.length > MAX_RULES) break
  }
  qualifications.skills = [...new Map(qualifications.skills.map(rule => [JSON.stringify(rule), rule])).values()].slice(0, MAX_RULES)
  qualifications.experience = [...new Map(qualifications.experience.map(rule => [JSON.stringify(rule), rule])).values()].slice(0, MAX_RULES)
  const core = qualifications.experience.filter(rule => rule.kind === 'required' || rule.kind === 'qualification')
  const conditional = core.some(rule => rule.conditional)
  if (conditional) qualifications.experienceNote = '학력·분야·선택 경로에 따라 경력 조건이 달라요. 하나의 최소 연수로 판단하지 않으며 원문을 함께 표시합니다.'
  if (truncated) {
    qualifications.truncated = true
    qualifications.experienceNote = '본문의 일부 조건만 확인했습니다. 원문 전체를 확인해 주세요.'
  }
  return {
    skills: [...new Set(qualifications.skills.flatMap(rule => rule.skills))],
    minExperience: !conditional && !truncated && core.length ? Math.max(...core.map(rule => rule.minYears)) : null,
    qualifications,
  }
}

/** Recheck only derived fields. Keep identity, collection age, application notes and original text. */
export function upgradeJobQualifications<T extends Job>(job: T): T {
  if (job.source === 'sample' || job.qualifications?.version === QUALIFICATIONS_VERSION) return job
  return { ...job, ...qualificationFacts(job.description, job.companyId) }
}

export function formatExperienceYears(years: number): string {
  const months = Math.round(years * 12)
  return months % 12 === 0 ? `${months / 12}년` : `${months}개월`
}
