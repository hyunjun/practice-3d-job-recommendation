import { Languages } from 'lucide-react'
import { languageGroupLabel } from '../../shared/job-languages'
import { QUALIFICATION_LABELS } from '../../shared/types'
import type { Job } from '../../shared/types'

export function JobLanguageDetails({ job }: { job: Job }) {
  const requirements = job.languageRequirements
  if (job.source === 'sample' || !requirements || !requirements.rules.length && !requirements.truncated) return null
  return <section className="job-eligibility job-languages" aria-labelledby="job-language-title">
    <h4 id="job-language-title"><Languages size={16} />공고의 언어 조건</h4>
    <p>항목을 펼쳐 요구 수준과 원문을 확인해 주세요. 기술·경력 추천과 별도로 확인할 조건입니다.</p>
    <div className="eligibility-rules">{requirements.rules.map((rule, index) => <details className={`eligibility-rule ${rule.kind}`} key={`${index}:${rule.kind}`}>
      <summary><span>{languageGroupLabel(rule)}</span><small>{QUALIFICATION_LABELS[rule.kind]}</small>{rule.scope && <span className="language-scope">{rule.scope}</span>}</summary>
      <blockquote>{rule.evidence.text}</blockquote>
    </details>)}</div>
    <p className="eligibility-footnote">회화·비즈니스·원어민 수준 등은 공고의 표현을 그대로 남깁니다. 지원자의 언어 능력이나 조건 충족 여부를 판단한 결과는 아닙니다.{requirements.truncated ? ' 긴 공고의 일부 조건만 확인했습니다. 전체 원문도 확인해 주세요.' : ''}</p>
  </section>
}
