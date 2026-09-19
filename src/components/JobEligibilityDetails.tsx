import { CircleHelp, FileSearch } from 'lucide-react'
import { eligibilitySummary } from '../../shared/job-eligibility'
import { ELIGIBILITY_LABELS, ELIGIBILITY_LEVEL_LABELS } from '../../shared/types'
import type { EligibilityKind, EligibilityLevel, Job } from '../../shared/types'

export function EligibilityNotice({ job }: { job: Job }) {
  const summary = eligibilitySummary(job)
  return summary ? <p className="eligibility-notice"><CircleHelp size={13} /><span>{summary}</span></p> : null
}

export function JobEligibilityDetails({ job }: { job: Job }) {
  if (job.source === 'sample' || !job.eligibility?.rules.length) return null
  const groups = new Map<string, { kinds: EligibilityKind[]; level: EligibilityLevel; text: string }>()
  for (const rule of job.eligibility.rules) {
    const key = `${rule.level}:${rule.evidence.text}`
    const group = groups.get(key) ?? { kinds: [], level: rule.level, text: rule.evidence.text }
    if (!group.kinds.includes(rule.kind)) group.kinds.push(rule.kind)
    groups.set(key, group)
  }
  return <section className="job-eligibility" aria-labelledby="eligibility-title">
    <h4 id="eligibility-title"><FileSearch size={16} />취업 자격과 추가 조건</h4>
    <p>비자 지원이나 거주 국가와 별도로 확인할 조건이에요. 항목을 펼쳐 적용 범위와 원문을 확인해 주세요.</p>
    <div className="eligibility-rules">{[...groups].map(([key, group]) => <details className={`eligibility-rule ${group.level}`} key={key}>
      <summary><span>{group.kinds.map(kind => ELIGIBILITY_LABELS[kind]).join(' · ')}</span><small>{ELIGIBILITY_LEVEL_LABELS[group.level]}</small></summary>
      <blockquote>{group.text}</blockquote>
    </details>)}</div>
    <p className="eligibility-footnote">원문에서 확인한 문구이며, 지원자의 국적·취업 허가·보안 인가 충족 여부를 판단한 결과는 아닙니다.{job.eligibility.truncated ? ' 긴 공고의 일부 조건만 표시하고 있어요. 전체 원문도 확인해 주세요.' : ''}</p>
  </section>
}
