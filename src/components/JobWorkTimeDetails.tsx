import { Clock3 } from 'lucide-react'
import { WORK_TIME_KIND_LABELS, WORK_TIME_LEVEL_LABELS } from '../../shared/job-work-time'
import type { Job } from '../../shared/types'

export function JobWorkTimeDetails({ job }: { job: Job }) {
  const requirements = job.workTimeRequirements
  if (job.source === 'sample' || !requirements || !requirements.rules.length && !requirements.truncated) return null
  return <section className="job-eligibility job-work-time" aria-labelledby="job-work-time-title">
    <h4 id="job-work-time-title"><Clock3 size={16} />시간대·협업 시간</h4>
    <p>공고에 적힌 시간과 적용 항목입니다. 펼치면 앞뒤 맥락이 담긴 원문을 확인할 수 있어요.</p>
    <div className="eligibility-rules">{requirements.rules.map((rule, index) => <details className={`eligibility-rule ${rule.level}`} key={`${index}:${rule.kind}`}>
      <summary><span>{WORK_TIME_KIND_LABELS[rule.kind]}</span><small>{WORK_TIME_LEVEL_LABELS[rule.level]}</small>
        {rule.scope && <span className="work-time-scope">{rule.scope}</span>}
        <span className="work-time-statement">{rule.statement}</span>
      </summary>
      <blockquote>{rule.evidence.text}</blockquote>
    </details>)}</div>
    <p className="eligibility-footnote">시간대 약어와 시각은 원문 그대로예요. 서머타임 적용과 실제 협업 시간은 회사에 확인해 주세요. 거주 국가만으로 시간대나 이 조건의 충족 여부를 판단하지 않습니다.{requirements.truncated ? ' 일부 안내만 확인했습니다. 전체 원문도 확인해 주세요.' : ''}</p>
  </section>
}
