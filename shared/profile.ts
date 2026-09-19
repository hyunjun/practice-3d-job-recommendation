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
  const explicit = [...text.matchAll(/(?<![\d/])(\d{1,2})(?:\s*[-–]\s*\d{1,2})?\+?\s*(?:years?(?:\s+of)?(?:\s+\w+){0,3}\s+experience|years?['’]\s+experience|년(?:\s*이상)?(?:의)?\s*(?:경력|경험)|년차)/gi)]
    .map(match => Number(match[1]))
    .filter(value => value >= 0 && value <= 45)
  return explicit.length ? Math.max(...explicit) : null
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
  if (years === null) warnings.push('전체 경력 연수를 확인해 주세요. 프로젝트 기간은 자동으로 합산하지 않습니다.')
  if (skills.length === 0) warnings.push('인식된 기술이 없어요. 아래에서 직접 기술을 추가할 수 있습니다.')
  return {
    profile: {
      kind: 'personal', name: plausibleName ? first : '내 프로필', headline,
      years: years ?? 3, skills, desiredRole: 'all', residence: 'KR', linkedinUrl: '',
    },
    warnings,
  }
}
