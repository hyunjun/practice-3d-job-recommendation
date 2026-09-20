import { qualificationSection } from './job-qualifications'
import { WORK_TIME_REQUIREMENTS_VERSION } from './types'
import type { Job, JobWorkTimeRequirements, WorkTimeRequirement, WorkTimeRequirementKind } from './types'

export const WORK_TIME_KIND_LABELS: Record<WorkTimeRequirementKind, string> = {
  location: '거주·근무 시간대', collaboration: '협업 시간대',
  'core-hours': '코어 근무시간', 'working-hours': '근무시간 안내', overlap: '근무시간 중첩',
}
export const WORK_TIME_LEVEL_LABELS: Record<WorkTimeRequirement['level'], string> = {
  required: '필수로 명시', preferred: '우대 사항', stated: '공고 안내',
}

const MAX_TEXT = 100_000
const MAX_RULES = 50
const MAX_STATEMENT = 1000
const MAX_EVIDENCE = 3000
type Section = WorkTimeRequirement['level'] | 'excluded'
// Preserve abbreviations, never turn CST/IST/PST into a guessed geographical zone.
// Case matters: the French word "est" and a business group's "PST" are not clocks.
const ABBREVIATION = /\b(?:UTC|GMT)(?:\s*[+\u2212-]\s*\d{1,2}(?::\d{2}|\.\d{1,2})?)?|\b(?:PST|PDT|EST|EDT|CST|CDT|MST|MDT|CET|CEST|EET|EEST|BST|IST|JST|KST|SGT|AEST|AEDT|ACST|ACDT|AWST|NZST|NZDT|HST|AST|ADT)\b/
const ZONE = /\btime[- ]?zones?\b|\b(?:eastern|central|pacific|mountain|atlantic|central european|western european|eastern european|greenwich|japan|korea|singapore|australian eastern)(?: standard| daylight| summer)? (?:time|hours)\b|시간대|표준시/i
const NAMED_ZONE = /\b(?:eastern|central|pacific|mountain|atlantic|(?:central |western |eastern )?european|americas?|AMER|EMEA|APAC|greenwich|japan|korea|singapore|australian(?: eastern| central| western)?)(?: standard| daylight| summer| mean)? (?:time[- ]?zones?|time|hours)\b|(?:동부|서부|중부|태평양|유럽|미주|한국|일본)\s*(?:시간대|표준시)/i
const REQUIRED = /\b(?:must|required|requires?|mandatory|essential|need to|needs to)\b|필수|반드시|해야\s*(?:합니다|해요|한다|함|됩니다)|필요(?:합니다|해요|함|하다)/i
const PREFERRED = /\b(?:preferred|preferably|ideally|a plus|a bonus|nice[- ]to[- ]have)\b|우대|있으면 좋/i
const META = /\b(?:example (?:sentence|requirement|schedule)|sample (?:text|sentence|schedule)|training (?:material|example)|prompt (?:example|template)|quoted (?:example|phrase|text|sentence)|the phrase|literal string)\b|예시\s*문(?:장|구)|인용\s*문/i
const OTHER_ROLE = /\b(?:another|other|a different|separate)\b[^.;!?\n]{0,90}\b(?:roles?|positions?|vacanc(?:y|ies)|jobs?|openings?)\b|다른\s*(?:채용|직무|공고|포지션)/i
const PAST = /\b(?:experience|previously|previous roles?|past roles?|used to|historically)\b|과거|이전\s*(?:직장|직무)|경험/i
const APPLICATION = /\b(?:application|interview|assessment|recruitment|recruiter|webinar|conference|event)\b|지원서|면접|채용\s*설명회/i
const PRODUCT = /\b(?:timestamps?|date[- ]time|database|calendar (?:API|library)|clock (?:API|library)|parser|unit tests?|software (?:stores?|converts?|displays?)|product (?:stores?|converts?|displays?))\b|타임스탬프|예제\s*코드/i

function temporalText(text: string): string {
  return text.replace(/\b(?:PST|CST|EST|IST)\s*(?:\([^)]{0,100}\b(?:Team|Platform|Product|Service|Department)\b[^)]{0,100}\)|\s+(?:team|platform|product|service|department)\b)/gi, ' ')
}

function zoneMention(text: string): boolean {
  const temporal = temporalText(text)
  return ZONE.test(temporal) || ABBREVIATION.test(temporal)
}

function negated(text: string): boolean {
  return /\b(?:no|without)\s+(?:(?:fixed|mandatory|required|minimum|specific|set|daily|core|working|time[- ]?zone)\s+){0,4}(?:overlap|hours?|time[- ]?zones?|restrictions?|requirements?)\b/i.test(text)
    || /\b(?:do not|don't|does not|doesn't|not need to)\s+(?:need|require|have to|work|overlap)\b/i.test(text)
    || /\b(?:not required|not necessary|not mandatory|not needed|is optional|are optional)\b/i.test(text)
    || /(?:시간대|표준시|근무\s*시간|협업\s*시간|중첩|코어\s*타임).{0,80}(?:무관|제한.{0,5}없|필수.{0,5}아니|요구하지\s*않|필요하지\s*않|필요(?:가|는|도)?\s*없)/i.test(text)
}

function sectionOf(text: string): Section | undefined {
  const value = text.replace(/[:：\s]+$/g, '').replace(/[’‘]/g, "'")
  if (/^(?:other (?:open )?(?:positions|jobs|roles|vacancies)|application.*|interview.*|recruitment.*|채용\s*절차|전형\s*절차)$/i.test(value)) return 'excluded'
  if (/^(?:where you(?:'ll| will)? (?:be|work)|(?:work(?:ing)? |job )?locations?|location and (?:working )?hours|working (?:hours|arrangements|overlap)|work (?:schedule|arrangements|style)|how we work|collaboration|(?:working )?overlap|time[- ]?zones?|core (?:working )?hours|근무\s*(?:조건|시간|장소|지역|형태|방식)|협업\s*시간|코어\s*(?:근무\s*시간|타임))$/i.test(value)) return 'stated'
  const section = qualificationSection(value.replace(/^the\s+/i, '').replace(/\s+\(\d+\s+(?:titles?|roles?|levels?)\)$/i, ''))
  if (section === 'required' || section === 'preferred' || section === 'excluded') return section
  return section === undefined ? undefined : 'stated'
}

function roleHeading(text: string): boolean {
  return /^(?:(?:senior|staff|principal|lead|junior|associate|mid[- ]level)\s*(?:\/|&|or|and)\s*)*(?:senior|staff|principal|lead|junior|associate|mid[- ]level)\s+levels?$/i.test(text)
    || /^(?:(?:senior|staff|principal|lead|junior|associate|software|machine learning|applied|research|data|security|frontend|backend|full[- ]stack|platform|systems?)\s+){0,5}(?:engineer|developer|scientist|researcher)(?:\s+(?:[IVX]+|\d+))?(?:\s*[-–—]\s*[\p{L}\s/&-]{1,70})?$/iu.test(text)
}

function clockMention(text: string): boolean {
  return /(?:\d{1,2}(?::\d{2})?\s*(?:am|pm|시)|\b\d{1,2}:\d{2}\b|\b\d{1,2}\s*(?:to|[-–—~])\s*\d{1,2}\b|\b(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+(?:hours?|am|pm)\b)/i.test(text)
}

function headingDeclarationKind(heading: string, statement: string): WorkTimeRequirementKind | undefined {
  const value = heading.replace(/[:：\s]+$/g, '')
  // Only a time-specific heading can supply the omitted predicate of a bare
  // clock range. The retained statement itself stays an exact source substring.
  const bareTime = /^(?:(?:from|between)\s+|(?:UTC|GMT)(?:[+\u2212-]\d{1,2}(?::\d{2})?)?\s+|(?:[A-Za-z]+\s+){0,4}Time\s+|오전\s*|오후\s*)?\d{1,2}(?=[:\s시–—~-])/i.test(statement)
  if (!bareTime || !clockMention(statement)) return undefined
  if (/^(?:core(?: working)? hours|코어\s*(?:근무\s*시간|타임))$/i.test(value)) return 'core-hours'
  if (/^(?:(?:main |normal |regular |standard )?working hours|근무\s*시간)$/i.test(value)) return 'working-hours'
  return undefined
}

function declarationKind(text: string): WorkTimeRequirementKind | undefined {
  const zone = zoneMention(text)
  const temporal = temporalText(text)
  const named = ABBREVIATION.test(temporal) || NAMED_ZONE.test(temporal)
  const clock = clockMention(text)
  const overlap = /\boverlap(?:ping)?\b|시간.{0,15}(?:겹치|겹쳐|중첩)|(?:겹치|겹쳐|중첩).{0,15}시간/i.test(text)
  if (overlap && (zone || /\b(?:hours?|hrs?)\b|\d+\s*시간/i.test(text))
    && (/\b(?:work|working|business|core|hours?|team|collaborat\w*|availability|available)\b|근무|업무|협업|시간/i.test(text)
      || REQUIRED.test(text) || PREFERRED.test(text) || /^overlap\b/i.test(text))) return 'overlap'
  if (/\b(?:core|shared|collaboration)\s+(?:working\s+)?hours\b|코어\s*(?:근무\s*시간|타임)|공통\s*(?:근무|협업)\s*시간/i.test(text)
    && clock) return 'core-hours'
  if (clock && /\b(?:main|normal|regular|standard|working|business)\s+(?:working\s+)?hours\b|(?:정규|기본|실제|일반)?\s*근무\s*시간/i.test(text)) return 'working-hours'
  if (!zone) return undefined
  if (/^(?:our|the|existing|current)\s+(?:team(?:mates?| members?)?|colleagues?|staff|employees?|engineers?|developers?)\b.{0,80}\b(?:live|reside|based|located)\b/i.test(text)
    && !REQUIRED.test(text) && !/\b(?:candidates?|applicants?|you)\b/i.test(text)) return undefined
  if ((named || /\b(?:same|specific|required) time[- ]?zone\b/i.test(text))
    && (/\b(?:based|located|reside|residency|living|live|location|residence|work(?:ing)? from|be within)\b|거주|근무지|시간대.{0,15}(?:기반|위치)/i.test(text)
      || /\bremote\s*(?:\(|[-–—,:])/.test(text.toLowerCase()))) return 'location'
  // Where team members happen to live is not a declaration of operating hours.
  if (/\bdistributed\b/i.test(text) && !/\boperat(?:e|es|ing)\b|\bwork(?:s|ing)? within\b|\bworking hours\b/i.test(text)) return undefined
  if (named && /\b(?:operat(?:e|es|ing)|collaborat(?:e|es|ing|ion)|work(?:s|ing)? (?:hours|within|in|across|on)|comfortable working)\b|(?:협업|근무).{0,30}(?:시간대|표준시)|(?:시간대|표준시).{0,30}(?:협업|근무)/i.test(text)) return 'collaboration'
  return undefined
}

function levelOf(statement: string, section: Section | undefined): WorkTimeRequirement['level'] {
  // A preference about Canada or another skill in a following clause must not
  // turn "Located in Eastern time" into a preferred rather than stated schedule.
  const focus = statement.split(/,\s+(?:with|although|while)\b|\s+but\s+/i)[0]
  if (REQUIRED.test(focus)) return 'required'
  if (PREFERRED.test(focus)) return 'preferred'
  return section === 'required' || section === 'preferred' ? section : 'stated'
}

function workTimeStatements(line: string): string[] {
  const statements: string[] = []
  for (const sentence of line.split(/(?<!\be\.g\.)(?<!\bi\.e\.)(?<=[.!?])\s+(?=[A-Z가-힣])/i)) {
    const parts = sentence.split(/(;\s*|\s+but\s+)/i)
    let statement = parts[0]
    for (let index = 1; index < parts.length; index += 2) {
      const clause = parts[index + 1] ?? ''
      // A continuation can qualify or negate the preceding time declaration.
      // Split only when it supplies another independent time declaration.
      if (declarationKind(clause.trim()) && !/^(?:only|except|unless|provided|during|when|if)\b/i.test(clause.trim())) {
        if (statement.trim()) statements.push(statement.trim())
        statement = clause
      } else {
        statement += parts[index] + clause
      }
    }
    if (statement.trim()) statements.push(statement.trim())
  }
  return statements
}

/** Read declared work-time conditions, retaining the employer's words and ambiguity. */
export function workTimeRequirements(text: string): JobWorkTimeRequirements {
  const result: JobWorkTimeRequirements = { version: WORK_TIME_REQUIREMENTS_VERSION, rules: [] }
  let bounded = text
  if (text.length > MAX_TEXT) {
    result.truncated = true
    // A trailing partial line may have lost "not required" or a timezone qualifier.
    bounded = text.slice(0, MAX_TEXT)
    bounded = bounded.slice(0, Math.max(0, bounded.lastIndexOf('\n')))
  }
  const lines = bounded.split(/\r?\n/).map(line => line.trim().replace(/^(?:[-*•#]\s+|\d+[.)]\s+)/, '')).filter(Boolean)
  let section: Section | undefined
  let heading = ''
  let headingLine = -1
  let scope = ''
  let scopeLine = -1
  for (const [index, original] of lines.entries()) {
    let line = original
    const candidateHeading = line.replace(/[:：]\s*$/, '')
    if (roleHeading(candidateHeading)) {
      scope = candidateHeading
      scopeLine = index
      continue
    }
    const colon = line.search(/[:：]/)
    const prefix = colon > 0 ? line.slice(0, colon) : ''
    const inlineRole = prefix && roleHeading(prefix)
    const inlineSection = prefix ? sectionOf(prefix) : undefined
    const next = inlineSection ?? sectionOf(line)
    if (inlineRole) {
      scope = prefix
      scopeLine = index
      line = line.slice(colon + 1).trim()
    } else if (next !== undefined || (line.length < 150 && /[:：]$/.test(line) && !zoneMention(line))) {
      if (scopeLine > headingLine && scopeLine !== index - 1) scope = ''
      section = next
      heading = inlineSection !== undefined ? prefix : original
      headingLine = index
      if (section === 'excluded' || next === undefined) scope = ''
      if (inlineSection === undefined || colon === line.length - 1) continue
      line = line.slice(colon + 1).trim()
    }
    if (section === 'excluded' || META.test(line) || /^\s*["“'‘].*["”'’][.!]?\s*$/.test(line)) continue
    const contexts = [{ text: heading, index: headingLine }, { text: scope, index: scopeLine }]
      .filter(item => item.text && item.index < index).sort((left, right) => left.index - right.index)
    const quote = [...contexts.map(item => item.text), original].join('\n')
    const statements = workTimeStatements(line)
    for (const statement of statements) {
      if (META.test(statement) || OTHER_ROLE.test(statement) || PAST.test(statement) || APPLICATION.test(statement) || PRODUCT.test(statement) || negated(statement)) continue
      const kind = declarationKind(statement) ?? headingDeclarationKind(heading, statement)
      if (!kind) continue
      if (quote.length > MAX_EVIDENCE || statement.length > MAX_STATEMENT || scope.length > 200) { result.truncated = true; continue }
      const rule: WorkTimeRequirement = {
        kind, level: levelOf(statement, section), statement,
        ...(scope ? { scope } : {}), evidence: { source: 'description', text: quote },
      }
      if (result.rules.some(previous => JSON.stringify(previous) === JSON.stringify(rule))) continue
      if (result.rules.length === MAX_RULES) { result.truncated = true; return result }
      result.rules.push(rule)
    }
  }
  return result
}

export function upgradeJobWorkTime<T extends Job>(job: T): T {
  if (job.source === 'sample' || job.workTimeRequirements?.version === WORK_TIME_REQUIREMENTS_VERSION) return job
  return { ...job, workTimeRequirements: workTimeRequirements(job.description) }
}

export function workTimeSummary(job: Job): string {
  if (job.source === 'sample') return ''
  const lines = job.workTimeRequirements?.rules.map(rule => `${WORK_TIME_KIND_LABELS[rule.kind]} · ${WORK_TIME_LEVEL_LABELS[rule.level]}${rule.scope ? ` · 적용 항목: ${rule.scope}` : ''}: ${rule.statement}`) ?? []
  if (job.workTimeRequirements?.truncated) lines.push('일부 시간대·협업 시간만 확인 · 전체 원문 확인 필요')
  return lines.join('\n')
}

export function workTimeSearchText(job: Job): string {
  if (job.source === 'sample') return ''
  const rules = job.workTimeRequirements?.rules ?? []
  return rules.map(rule => {
    const aliases = [
      [/\bEastern(?: Standard| Daylight)? (?:time|hours)/i, '동부 시간대'],
      [/\bPacific(?: Standard| Daylight)? (?:time|hours)/i, '태평양 시간대'],
      [/\bCentral European(?: Summer)? (?:time|hours)/i, '중앙 유럽 시간대'],
      [/\bGreenwich Mean Time\b/i, '그리니치 표준시'],
    ] as const
    return [WORK_TIME_KIND_LABELS[rule.kind], rule.statement, rule.scope ?? '',
      ...aliases.filter(([expression]) => expression.test(rule.statement)).map(([, label]) => label)].join(' ')
  }).join(' ')
}

export function workTimeCaution(job: Job): string | undefined {
  if (job.source === 'sample' || !job.workTimeRequirements?.rules.some(rule => rule.level !== 'preferred')) return undefined
  return '공고에 시간대·협업 시간 안내가 있어요. 상세의 원문에서 근무 시간대와 함께 일할 시간을 확인해 주세요.'
}
