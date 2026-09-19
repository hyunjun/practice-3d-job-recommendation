import type { Job, Profile, SkillRequirement } from './types'

export function matchingSkills(job: Job): string[] {
  return job.qualifications
    ? [...new Set(job.qualifications.skills.filter(rule => rule.kind !== 'context').flatMap(rule => rule.skills))]
    : job.skills
}

export function matchQualifications(job: Job, profile: Profile) {
  const profileSkills = new Set(profile.skills.map(skill => skill.toLowerCase()))
  const has = (skill: string) => profileSkills.has(skill.toLowerCase())
  const rules = job.qualifications!.skills
  const byKind = (kind: SkillRequirement['kind']) => rules.filter(rule => rule.kind === kind)
  const hits = (kind: SkillRequirement['kind']) => [...new Set(byKind(kind).flatMap(rule => rule.skills.filter(has)))]
  const required = hits('required')
  const qualifications = hits('qualification').filter(skill => !required.includes(skill))
  const preferred = hits('preferred').filter(skill => !required.includes(skill) && !qualifications.includes(skill))
  const matchedSkills = [...required, ...qualifications, ...preferred]
  const core = rules.filter(rule => rule.kind === 'required' || rule.kind === 'qualification')
  const units = new Map<string, { weight: number; matched: boolean }>()
  for (const rule of core) {
    if (rule.match === 'unspecified') continue
    const weight = rule.kind === 'required' ? 2 : 1
    const groups = rule.match === 'any' ? [rule.skills] : rule.skills.map(skill => [skill])
    for (const skills of groups) {
      const key = [...skills].sort().join('|')
      const previous = units.get(key)
      if (!previous || previous.weight < weight) units.set(key, { weight, matched: skills.some(has) })
    }
  }
  const total = [...units.values()].reduce((sum, unit) => sum + unit.weight, 0)
  const matched = [...units.values()].reduce((sum, unit) => sum + (unit.matched ? unit.weight : 0), 0)
  // Optional skills add a bounded bonus. Adding an unmatched preference never lowers the score.
  const skillScore = (total ? matched / total * 50 : 12) + Math.min(10, preferred.length * 2)
  const missingRules = (kind: SkillRequirement['kind']) => byKind(kind).filter(rule =>
    rule.match !== 'unspecified' && (rule.match === 'any' ? !rule.skills.some(has) : rule.skills.some(skill => !has(skill))),
  )
  const missingRequired = missingRules('required')
  const missingQualifications = missingRules('qualification')
  const missingSkills = [...new Set([...missingRequired, ...missingQualifications].flatMap(rule => rule.skills.filter(skill => !has(skill))))]
  const missingText = (items: SkillRequirement[]) => [...new Set(items.map(rule => rule.match === 'any'
    ? `${rule.skills.join(' / ')} 중 하나`
    : rule.skills.filter(skill => !has(skill)).join(' · ')))].slice(0, 3).join(', ')
  const reasons: string[] = []
  const cautions: string[] = []
  if (required.length) reasons.push(`필수 항목의 ${required.slice(0, 3).join(' · ')} 기술과 연결돼요`)
  if (qualifications.length) reasons.push(`자격 항목의 ${qualifications.slice(0, 3).join(' · ')} 기술과 연결돼요`)
  if (preferred.length) reasons.push(`우대 항목의 ${preferred.slice(0, 3).join(' · ')} 경험이 있어요`)
  if (missingRequired.length) cautions.push(`필수 항목에서 프로필로 확인하지 못한 조건: ${missingText(missingRequired)}`)
  if (missingQualifications.length) cautions.push(`자격 항목에서 프로필로 확인하지 못한 기술: ${missingText(missingQualifications)}`)
  if (!matchingSkills(job).length) cautions.push('기술 자격 요건을 확인하지 못했어요. 회사 소개와 업무에서 언급한 기술은 필수로 판단하지 않습니다.')
  if (core.some(rule => rule.match === 'unspecified')) cautions.push('기술의 선택·예시 관계를 한 가지 조건으로 단정하지 않았어요. 기술 조건의 원문을 확인해 주세요.')
  if (job.qualifications?.truncated) cautions.push('본문의 일부 조건만 해석했습니다. 원문 전체를 확인해 주세요.')
  const first = required.length ? ['필수 항목', required] as const
    : qualifications.length ? ['자격 항목', qualifications] as const
      : preferred.length ? ['우대 항목', preferred] as const : null
  return {
    skillScore, matchedSkills, missingSkills, reasons, cautions,
    skillSummary: first ? `${first[0]} · ${first[1].slice(0, 2).join(' · ')}` : '기술 자격 요건 확인 필요',
  }
}
