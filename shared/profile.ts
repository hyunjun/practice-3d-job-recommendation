import type { Profile } from './types'

const SKILL_PATTERNS: [string, RegExp][] = [
  ['TypeScript', /\btypescript\b|\bts\b/i],
  ['JavaScript', /\bjavascript\b|\bjs\b/i],
  ['React Native', /\breact[\s-]+native\b/i],
  ['React', /\breact(?:\.?js)?\b/i],
  ['Next.js', /\bnext(?:\.?js|\s+js)\b/i],
  ['Vue', /\bvue(?:\.?js)?\b/i],
  ['Angular', /\bangular\b/i],
  ['Svelte', /\bsvelte\b/i],
  ['Node.js', /\bnode(?:\.?js|\s+js)\b/i],
  ['Python', /\bpython\b|파이썬/i],
  ['Java', /\bjava\b|자바(?!스크립트)/i],
  ['Go', /\bGolang\b|\bGo\b(?![- ](?:to|live|on|with|beyond|forward|through|the|a)\b)/],
  ['Rust', /\brust\b/i],
  ['C++', /(?<!\w)c\+\+(?!\w)/i],
  ['C#', /(?<!\w)c#(?!\w)/i],
  ['Ruby', /\bruby\b/i],
  ['Ruby on Rails', /\b(?:ruby on rails|rails)\b/i],
  ['PHP', /\bphp\b/i],
  ['Kotlin', /\bkotlin\b/i],
  ['Swift', /\bswift\b/i],
  ['Flutter', /\bflutter\b/i],
  ['SQL', /\bsql\b/i],
  ['PostgreSQL', /\bpostgres(?:ql)?\b/i],
  ['MySQL', /\bmysql\b/i],
  ['MongoDB', /\bmongo(?:db)?\b/i],
  ['Redis', /\bredis\b/i],
  ['Elasticsearch', /\belasticsearch\b/i],
  ['AWS', /\baws\b|\bamazon web services\b/i],
  ['GCP', /\bgcp\b|\bgoogle cloud\b/i],
  ['Azure', /\bazure\b/i],
  ['Docker', /\bdocker\b/i],
  ['Kubernetes', /\bkubernetes\b|\bk8s\b/i],
  ['Terraform', /\bterraform\b/i],
  ['Kafka', /\bkafka\b/i],
  ['Spark', /\b(?:apache )?spark\b/i],
  ['Airflow', /\bairflow\b/i],
  ['PyTorch', /\bpytorch\b/i],
  ['TensorFlow', /\btensorflow\b/i],
  ['scikit-learn', /\bscikit[- ]learn\b/i],
  ['GraphQL', /\bgraphql\b/i],
  ['Django', /\bdjango\b/i],
  ['FastAPI', /\bfastapi\b/i],
  ['Spring', /\bspring(?:\s+boot)?\b/i],
  ['CSS', /\bcss(?:3)?\b/i],
  ['HTML', /\bhtml(?:5)?\b/i],
  ['Figma', /\bfigma\b/i],
  ['Linux', /\blinux\b/i],
  ['Git', /\bgit\b/i],
]

export const KNOWN_SKILLS = SKILL_PATTERNS.map(([name]) => name)

export function extractSkills(text: string): string[] {
  return SKILL_PATTERNS.filter(([, pattern]) => pattern.test(text)).map(([name]) => name)
}

export function extractYears(text: string): number | null {
  // Match complete quantities so a decimal, range or date cannot become its last digit.
  const number = String.raw`\d{1,3}(?:\.\d+)?`
  const duration = new RegExp(String.raw`(?<![\p{N}\p{Pd}A-Za-z.,/+−])(${number})(?:\s*(?:[\p{Pd}−~～]|to)\s*(${number}))?\s*\+?\s*(years?|yrs?|months?|mos?|년차|년|개월)(?![a-z])(?:\s*(?:and\s+)?(${number})\s*(months?|mos?|개월)(?![a-z]))?`, 'giu')
  const values: { years: number | null; total: boolean }[] = []
  for (const line of text.normalize('NFKC').split(/\r?\n/)) {
    for (const match of line.matchAll(duration)) {
      const before = line.slice(0, match.index).trim()
      const after = line.slice(match.index + match[0].length).trim()
      const contextBefore = /(?:\b(?:experience|exp\.?)|(?:경력|경험)(?:\s*(?:기간|연수))?)\s*[:：=·-]?\s*$/i.test(before)
      const following = after.match(/^(?:['’]\s*)?(?:of\s+)?(?:[a-z][a-z-]*\s+){0,5}experience\b/i)?.[0]
        ?? after.match(/^(?:이상(?:의)?\s*|의\s*)?(?:(?:전체|개발|관련|실무|업무)\s*){0,2}(?:경력|경험)/)?.[0]
      const contextAfter = Boolean(following) || match[3] === '년차'
      if (!contextBefore && !contextAfter) continue
      // Scope "total" to this quantity's own phrase, not another duration on the same line.
      const total = /\b(?:total|overall)(?:\s+[a-z-]+){0,5}\s*[:：=·-]?\s*$/i.test(before)
        || /(?:총|전체)\s*(?:(?:개발|관련|실무|업무)\s*)?(?:경력|경험)?(?:\s*(?:기간|연수))?\s*[:：=·-]?\s*$/.test(before)
        || /\b(?:total|overall)\b|전체/i.test(following ?? '')
      // A range or upper bound is not a confirmed total. Leave it for the user.
      const unclear = Boolean(match[2]) || /\b(?:less than|under|up to|at most|about|around|nearly)\s*$/i.test(before)
        || /(?:약|미만|이하)\s*$/.test(before) || /^(?:미만|이하|정도)/.test(after)
      const monthly = /^(?:months?|mos?|개월)$/i.test(match[3])
      const years = Number(match[1]) / (monthly ? 12 : 1) + (match[4] ? Number(match[4]) / 12 : 0)
      values.push({ years: unclear || monthly && match[4] || !Number.isFinite(years) || years < 0 || years > 50 ? null : years, total })
    }
  }
  const totals = values.filter(value => value.total)
  const distinct = [...new Set((totals.length ? totals : values).map(value => value.years))]
  return distinct.length === 1 ? distinct[0] : null
}

export function analyzeResume(text: string): { profile: Profile; warnings: string[] } {
  const normalized = text.normalize('NFKC').trim()
  const skills = extractSkills(normalized)
  const years = extractYears(normalized)
  const lines = normalized.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
  const first = lines[0] ?? ''
  const plausibleName = first.length <= 32 && /^[\p{L}\s.'-]+$/u.test(first)
    && !/resume|curriculum|engineer|developer|profile|이력서|개발자|엔지니어|경력|summary/i.test(first)
  const headline = lines.find(line => line.length < 100 && /engineer|developer|scientist|엔지니어|개발자/i.test(line)) ?? 'Software Engineer'
  const warnings: string[] = []
  if (years === null) warnings.push('경력 연수를 확인하지 못해 비워 두었어요. 직접 입력하거나 그대로 탐색할 수 있습니다. 여러 기간은 자동으로 합산하지 않아요.')
  if (skills.length === 0) warnings.push('인식된 기술이 없어요. 아래에서 직접 기술을 추가할 수 있습니다.')
  return {
    profile: {
      kind: 'personal', name: plausibleName ? first : '내 프로필', headline,
      years, skills, desiredRole: 'all', residence: 'KR', linkedinUrl: '',
    },
    warnings,
  }
}
