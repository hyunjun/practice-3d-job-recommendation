import { qualificationSection } from './job-qualifications'
import { LANGUAGE_REQUIREMENTS_VERSION, QUALIFICATION_LABELS, SPOKEN_LANGUAGE_CODES } from './types'
import type { Job, JobLanguageRequirements, LanguageRequirement, SpokenLanguageCode } from './types'

interface LanguageName { label: string; english: string; aliases: string[] }
export const SPOKEN_LANGUAGES: Record<SpokenLanguageCode, LanguageName> = {
  en: { label: '영어', english: 'English', aliases: ['English', '영어'] },
  ko: { label: '한국어', english: 'Korean', aliases: ['Korean', '한국어', '한국말'] },
  ja: { label: '일본어', english: 'Japanese', aliases: ['Japanese', '일본어'] },
  de: { label: '독일어', english: 'German', aliases: ['German', '독일어'] },
  fr: { label: '프랑스어', english: 'French', aliases: ['French', '프랑스어'] },
  es: { label: '스페인어', english: 'Spanish', aliases: ['Spanish', '스페인어'] },
  pt: { label: '포르투갈어', english: 'Portuguese', aliases: ['Portuguese', '포르투갈어'] },
  zh: { label: '중국어', english: 'Chinese', aliases: ['Chinese', '중국어'] },
  cmn: { label: '중국어(만다린)', english: 'Mandarin', aliases: ['Mandarin Chinese', 'Chinese (Mandarin)', 'Mandarin', 'Putonghua', '중국어(만다린)', '만다린', '보통화'] },
  yue: { label: '광둥어', english: 'Cantonese', aliases: ['Cantonese Chinese', 'Chinese (Cantonese)', 'Cantonese', '광둥어'] },
  it: { label: '이탈리아어', english: 'Italian', aliases: ['Italian', '이탈리아어'] },
  nl: { label: '네덜란드어', english: 'Dutch', aliases: ['Dutch', '네덜란드어'] },
  sv: { label: '스웨덴어', english: 'Swedish', aliases: ['Swedish', '스웨덴어'] },
  pl: { label: '폴란드어', english: 'Polish', aliases: ['Polish', '폴란드어'] },
  ar: { label: '아랍어', english: 'Arabic', aliases: ['Arabic', '아랍어'] },
  hi: { label: '힌디어', english: 'Hindi', aliases: ['Hindi', '힌디어'] },
  vi: { label: '베트남어', english: 'Vietnamese', aliases: ['Vietnamese', '베트남어'] },
  id: { label: '인도네시아어', english: 'Indonesian', aliases: ['Indonesian', 'Bahasa Indonesia', '인도네시아어'] },
  th: { label: '태국어', english: 'Thai', aliases: ['Thai', '태국어'] },
  ms: { label: '말레이어', english: 'Malay', aliases: ['Malay', 'Bahasa Melayu', '말레이어'] },
  ru: { label: '러시아어', english: 'Russian', aliases: ['Russian', '러시아어'] },
  da: { label: '덴마크어', english: 'Danish', aliases: ['Danish', '덴마크어'] },
  no: { label: '노르웨이어', english: 'Norwegian', aliases: ['Norwegian', '노르웨이어'] },
  fi: { label: '핀란드어', english: 'Finnish', aliases: ['Finnish', '핀란드어'] },
  tr: { label: '튀르키예어', english: 'Turkish', aliases: ['Turkish', '튀르키예어', '터키어'] },
  he: { label: '히브리어', english: 'Hebrew', aliases: ['Hebrew', '히브리어'] },
  cs: { label: '체코어', english: 'Czech', aliases: ['Czech', '체코어'] },
  ro: { label: '루마니아어', english: 'Romanian', aliases: ['Romanian', '루마니아어'] },
  uk: { label: '우크라이나어', english: 'Ukrainian', aliases: ['Ukrainian', '우크라이나어'] },
  el: { label: '그리스어', english: 'Greek', aliases: ['Greek', '그리스어'] },
  hu: { label: '헝가리어', english: 'Hungarian', aliases: ['Hungarian', '헝가리어'] },
}

const MAX_TEXT = 100_000
const MAX_RULES = 50
const MAX_EVIDENCE = 3000
const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const patterns = SPOKEN_LANGUAGE_CODES.map(code => ({
  code,
  expression: new RegExp(SPOKEN_LANGUAGES[code].aliases.map(alias => /[가-힣]/.test(alias)
    ? `${escape(alias)}(?=$|[^\\p{L}]|[은는이가을를로와과의]|구사|능력|실력)`
    : `(?<![\\p{L}])${escape(alias)}(?![\\p{L}])`).join('|'), 'giu'),
}))
const OPTIONAL = /\b(?:preferred|preferably|nice[- ]to[- ]have|a plus|a bonus|bonus points|ideally|optional|added value)\b|우대|있으면 좋/i
const REQUIRED = /\b(?:requires?|required|mandatory|essential|must|need to|needs to|minimum)\b|필수|반드시/i
const NEGATED = /\b(?:not (?:required|necessary|needed|essential)|no (?:\w+\s+){0,5}(?:required|necessary|needed)|(?:do not|don't|does not|doesn't) (?:need|require|have to)|not need to|without (?:any )?(?:knowledge|fluency|proficiency))\b|필수.{0,8}(?:아니|아님|아닙)|(?:요구|필요로?)\s*하지\s*않|(?:언어|어학).{0,10}무관/i
const LEVEL = /\b(?:conversational|business|professional|native|fluent|fluency|proficien\w*|basic|advanced|intermediate|CEFR|[ABC][12])(?:[- ]level)?\b|회화|비즈니스|원어민|유창|능통|구사|의사소통|어학|능력|원활/i
const META_CONTEXT = /\b(?:for example|example (?:sentence|requirement)|sample (?:text|sentence)|training (?:material|example)|prompt (?:example|template)|job description example|quoted (?:example|phrase|text|sentence)|the phrase|literal string|translation (?:of|for) this)\b|예시\s*문(?:장|구)|예를\s*들어|인용\s*문/i
const OTHER_ROLE = /\b(?:for|in|of)\s+(?:another|other|a different)\s+(?:role|position|vacancy|job)\b|다른\s*(?:채용|직무|공고|포지션)/i
const DOCUMENT_LANGUAGE = /\b(?:submit|send|upload|attach|provide)\b.{0,80}\b(?:CV|resume|résumé|application|cover letter)\b|\b(?:CV|resume|résumé|application|cover letter|documentation|manuals?|website|job posting|job description)\b.{0,50}\b(?:written|submitted|provided|published|translated|in English|in German|in French)\b|(?:이력서|자기소개서|지원서).{0,30}(?:작성|제출)/i
const PRODUCT_CONTEXT = /\b(?:language models?|NLP|corpora|corpus|datasets?|tokeni[sz]\w*|programming languages?|code generators?|translation (?:models?|engines?|systems?))\b/i

interface Mention { code: SpokenLanguageCode; start: number; end: number }
function mentions(text: string): Mention[] {
  const found = patterns.flatMap(({ code, expression }) => [...text.matchAll(expression)]
    .map(match => ({ code, start: match.index, end: match.index + match[0].length })))
    .sort((a, b) => a.start - b.start || b.end - a.end)
  // "Mandarin Chinese" is one named language; don't also infer general Chinese.
  const result: Mention[] = []
  for (const item of found) if (!result.some(previous => previous.end > item.start)) result.push(item)
  return result
}

function languageGroup(text: string, found: Mention[]): LanguageRequirement['match'] {
  if (/\b(?:such as|e\.g\.|for example|or equivalent|or similar|other languages?)\b|예를|등(?:의|을|에|\s|$)/i.test(text)) return 'unspecified'
  if (new Set(found.map(item => item.code)).size <= 1) {
    // "Native or fluent German" offers levels of German, not a different language.
    const before = text.slice(0, found[0]?.start)
    const after = text.slice(found.at(-1)?.end)
    return /(?:\bor\b|또는|혹은)\s*$/i.test(before) || /^\s*(?:or\b|또는|혹은)/i.test(after) ? 'unspecified' : 'all'
  }
  const connectors = found.slice(1).map((item, index) => text.slice(found[index].end, item.start))
  const any = connectors.some(part => /\bor\b|또는|혹은/i.test(part))
  const additive = /\b(?:and|with|as well as|along with|in addition to|on top of|plus)\b|&|및|그리고|와|과/i
  const all = connectors.some(part => additive.test(part.replace(/\band\/or\b/gi, 'or')))
  if (any && all) return 'unspecified'
  if (any) return 'any'
  if (all && connectors.every(part => additive.test(part) || /^\s*,\s*$/.test(part))) return 'all'
  return 'unspecified'
}

function abilityClaim(text: string, found: Mention[], inQualifications: boolean): boolean {
  let masked = text
  for (const item of [...found].reverse()) masked = masked.slice(0, item.start) + ' LANGUAGE ' + masked.slice(item.end)
  if (/^(?:our\b|we\b|the (?:team|company|product|platform)\b)/i.test(text) && !REQUIRED.test(text) && !/\byou\b|\bcandidates?\b|\bapplicants?\b/i.test(text)) return false
  if (PRODUCT_CONTEXT.test(text) && !/\b(?:you (?:must|can|are)|candidates?|applicants?|communicat\w*|speak|spoken|verbal|written)\b|의사소통|구사/i.test(text)) return false
  if (/\b(?:our|the|company|team)\b.{0,40}\b(?:working|official|business|primary|common) language\b/i.test(masked)) return false
  return /\b(?:fluent|fluency|proficien\w*|conversant|command|knowledge|native(?:[- ]level)?|conversational|business[- ]level|[ABC][12])\b.{0,70}\bLANGUAGE\b/i.test(masked)
    || /\bLANGUAGE\b.{0,70}\b(?:fluent|fluency|proficien\w*|communication|skills|speaking|writing|reading|spoken|written|verbal|oral|conversational|business level|native[- ]level|[ABC][12])\b/i.test(masked)
    || /\b(?:communicat\w*|speak(?:ing)?|read(?:ing)?|writ(?:e|ing|ten)|converse|spoken|verbal|oral)\b.{0,200}\bLANGUAGE\b/i.test(masked)
    || /\bLANGUAGE\b.{0,60}(?:능통|유창|구사|의사소통|커뮤니케이션|회화|원활|가능|능력|실력)|(?:능통|유창|구사).{0,40}\bLANGUAGE\b/i.test(masked)
    || ((inQualifications || REQUIRED.test(text) || OPTIONAL.test(text))
      && /^\s*(?:LANGUAGE|and|or|both|either|in|at|least|one|of|is|are|required|mandatory|preferred|essential|a|plus|fluent|fluency|proficiency|native|level|business|conversational|[ABC][12]|필수|우대|및|또는|가능|능통|유창|[.,;:/&()+–—-]|\s)+\s*$/i.test(masked))
}

function clauses(text: string): string[] {
  const optional: string[] = []
  const main = text.replace(/\(([^()]{1,600})\)/g, (whole, inside: string) => {
    if (!OPTIONAL.test(inside) && !NEGATED.test(inside)) return whole
    optional.push(inside)
    return ''
  })
  return [...main.split(/;\s*|(?<!\be\.g\.)(?<!\bi\.e\.)(?<=[.!?])\s+(?=[A-Z가-힣])|\s+but\s+/i), ...optional]
    .flatMap(part => {
      const boundaries = [...part.matchAll(/,\s+|\s+and\s+/gi)]
      const boundary = boundaries.find(match => {
        const before = part.slice(0, match.index)
        const after = part.slice(match.index + match[0].length)
        return (REQUIRED.test(before) || NEGATED.test(before) || match[0].startsWith(','))
          && (OPTIONAL.test(after) || NEGATED.test(after) || NEGATED.test(before) && REQUIRED.test(after))
          && (mentions(after).length > 0 || LEVEL.test(after))
      })
      return boundary ? [part.slice(0, boundary.index), part.slice(boundary.index + boundary[0].length)] : [part]
    }).map(part => part.trim()).filter(Boolean)
}

function headingKind(text: string): ReturnType<typeof qualificationSection> {
  const value = text.replace(/[:：\s]+$/g, '')
  if (/^(?:added value|additional advantages|it(?:'s| is) a plus if you(?: have)?|you get bonus points for)$/i.test(value)) return 'preferred'
  if (/^examples of desirable (?:skills|knowledge|experience)(?:[, ]+(?:and )?(?:skills|knowledge|experience))*$/i.test(value)) return 'preferred'
  if (/^(?:you need to have|what you bring to the table)$/i.test(value)) return 'qualification'
  if (/^other (?:open )?(?:positions|jobs|roles|vacancies)$/i.test(value)) return 'excluded'
  return qualificationSection(value.replace(/^the\s+/i, '').replace(/\s+\(\d+\s+(?:titles?|roles?|levels?)\)$/i, ''))
}

const ROLE_HEADING = /^(?:(?:senior|staff|principal|lead|junior|associate|software|machine learning|applied|research|data|security|frontend|backend|full[- ]stack|platform|systems?)\s+){0,5}(?:engineer|developer|scientist|researcher)(?:\s+(?:[IVX]+|\d+))?(?:\s*[-–—]\s*[\p{L}\s/&-]{1,70})?$/iu
function humanLanguageMentions(text: string): Mention[] {
  return mentions(text).filter(item => {
    const after = text.slice(item.end)
    // "English ... with the Korean team" requires English; Korean modifies
    // the team, not the applicant's spoken language.
    if (/^(?:[- ]speaking)?\s+(?:teams?|offices?|companies|company|colleagues?|customers?|clients?|users?|markets?|engineers?|developers?|citizens?|nationals?)\b/i.test(after)) return false
    return !/^\s+(?:language\s+)?(?:models?|NLP|corpora|corpus|datasets?|tokeni[sz]\w*|text (?:generation|classification))\b/i.test(after)
  })
}

function levelReference(text: string): boolean {
  // A following "business level preferred" can refer back to English. A following
  // "professional experience preferred" or "SQL proficiency" cannot.
  return LEVEL.test(text) && /^(?:[\s,.:;()/&+–—-]|(?:business|professional|native|conversational|fluent|fluency|proficiency|basic|advanced|intermediate|level|at|a|the|is|are|would|be|required|preferred|preferably|mandatory|essential|ideally|plus|CEFR|[ABC][12])\b|회화|비즈니스|업무|원어민|수준|정도|레벨|유창|능통|필수|우대|는|이|가|을|를)+$/i.test(text)
}

/** Interpret explicit applicant language claims; original levels remain quoted, never converted. */
export function languageRequirements(text: string): JobLanguageRequirements {
  const result: JobLanguageRequirements = { version: LANGUAGE_REQUIREMENTS_VERSION, rules: [] }
  if (text.length > MAX_TEXT) result.truncated = true
  let section: ReturnType<typeof qualificationSection>
  let heading = ''
  let subheading = ''
  let headingLine = -1
  let roleLine = -1
  const lines = text.slice(0, MAX_TEXT).split(/\r?\n/).map(line => line.trim().replace(/^(?:[-*•#]\s+|\d+[.)]\s+)/, '')).filter(Boolean)
  for (const [index, original] of lines.entries()) {
    let line = original
    if (ROLE_HEADING.test(line)) {
      subheading = line
      roleLine = index
      continue
    }
    const colon = line.search(/[:：]/)
    const inline = colon > 0 ? headingKind(line.slice(0, colon)) : undefined
    if (inline !== undefined && colon < line.length - 1) {
      if (roleLine > headingLine && roleLine !== index - 1) subheading = ''
      section = inline
      heading = line.slice(0, colon)
      headingLine = index
      if (section === 'excluded' || section === 'context') subheading = ''
      line = line.slice(colon + 1).trim()
    } else {
      const next = headingKind(line)
      if (next !== undefined || (line.length < 150 && /[:：]$/.test(line) && !mentions(line).length)) {
        if (roleLine > headingLine && roleLine !== index - 1) subheading = ''
        section = next
        heading = line
        headingLine = index
        if (next === undefined || next === 'excluded' || next === 'context') subheading = ''
        continue
      }
    }
    if (section === 'excluded' || section === 'context' || META_CONTEXT.test(line) || /^\s*["“'‘].*["”'’][.!]?\s*$/.test(line)) continue
    const parentMentions = mentions(line)
    if (!parentMentions.length) continue
    const headings = roleLine < headingLine ? [subheading, heading] : [heading, subheading]
    const quote = [...headings, line].filter(Boolean).join('\n')
    // Never crop away the negation, condition or proficiency level supporting a rule.
    if (quote.length > MAX_EVIDENCE) { result.truncated = true; continue }
    let previousLanguage: SpokenLanguageCode | undefined
    for (const clause of clauses(line)) {
      if (NEGATED.test(clause) || DOCUMENT_LANGUAGE.test(clause) || META_CONTEXT.test(clause) || OTHER_ROLE.test(clause)) { previousLanguage = undefined; continue }
      const found = humanLanguageMentions(clause)
      const inherited = !found.length && previousLanguage !== undefined && levelReference(clause) && (REQUIRED.test(clause) || OPTIONAL.test(clause))
      if (!found.length && !inherited) { previousLanguage = undefined; continue }
      if (!inherited && !abilityClaim(clause, found, section === 'required' || section === 'qualification' || section === 'preferred')) { previousLanguage = undefined; continue }
      const kind: LanguageRequirement['kind'] = OPTIONAL.test(clause) ? 'preferred'
        : REQUIRED.test(clause) ? 'required' : section === 'required' || section === 'preferred' ? section : 'qualification'
      const languages = inherited ? [previousLanguage!] : [...new Set(found.map(item => item.code))]
      const rule: LanguageRequirement = {
        languages, kind, match: inherited ? 'all' : languageGroup(clause, found),
        ...(subheading ? { scope: subheading } : {}),
        evidence: { source: 'description', text: quote },
      }
      previousLanguage = languages.length === 1 ? languages[0] : undefined
      if (result.rules.some(previous => JSON.stringify(previous) === JSON.stringify(rule))) continue
      if (result.rules.length === MAX_RULES) { result.truncated = true; return result }
      result.rules.push(rule)
    }
  }
  return result
}

/** Old descriptions gain the same display facts; current evidence beyond body truncation survives. */
export function upgradeJobLanguages<T extends Job>(job: T): T {
  if (job.source === 'sample' || job.languageRequirements?.version === LANGUAGE_REQUIREMENTS_VERSION) return job
  return { ...job, languageRequirements: languageRequirements(job.description) }
}

export function languageGroupLabel(rule: LanguageRequirement): string {
  const names = rule.languages.map(code => SPOKEN_LANGUAGES[code].label)
  if (rule.match === 'any') return `${names.join(' / ')} 중 하나`
  if (rule.match === 'unspecified') return `${names.join(' · ')} · 선택 관계 원문 확인`
  return names.join(' · ') + (names.length > 1 ? ' 모두' : '')
}

export function languageSummary(job: Job): string {
  if (job.source === 'sample') return ''
  const lines = job.languageRequirements?.rules.map(rule => `${QUALIFICATION_LABELS[rule.kind]}: ${languageGroupLabel(rule)}${rule.scope ? ` · 적용 항목: ${rule.scope}` : ''}`) ?? []
  if (job.languageRequirements?.truncated) lines.push('일부 언어 조건만 확인 · 전체 원문 확인 필요')
  return lines.join('\n')
}

export function languageSearchText(job: Job): string {
  if (job.source === 'sample') return ''
  const codes = [...new Set(job.languageRequirements?.rules.flatMap(rule => rule.languages) ?? [])]
  return codes.flatMap(code => [SPOKEN_LANGUAGES[code].label, SPOKEN_LANGUAGES[code].english, ...SPOKEN_LANGUAGES[code].aliases]).join(' ')
}

export function languageCaution(job: Job): string | undefined {
  if (job.source === 'sample') return undefined
  const core = job.languageRequirements?.rules.filter(rule => rule.kind !== 'preferred') ?? []
  if (!core.length) return undefined
  const names = [...new Set(core.flatMap(rule => rule.languages))].map(code => SPOKEN_LANGUAGES[code].label).join(' · ')
  return `공고의 언어 조건 확인 필요: ${names}. 요구 수준과 선택 조건은 원문 근거를 확인해 주세요.`
}
