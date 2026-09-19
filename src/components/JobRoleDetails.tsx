import { BriefcaseBusiness, ChevronDown } from 'lucide-react'
import { jobRoleLabel, upgradeJobRole } from '../../shared/job-roles'
import { ROLE_FILTER_LABELS } from '../../shared/types'
import type { Job } from '../../shared/types'

export function JobRoleDetails({ job }: { job: Job }) {
  if (job.source === 'sample') return null
  const classification = upgradeJobRole(job).roleClassification!
  return <section className="job-role-details" aria-label="직무 분류">
    <h4><BriefcaseBusiness size={15} />공고의 직무 표기</h4>
    <strong>{jobRoleLabel(job)}</strong>
    <p>{classification.roles.length
      ? '제목을 우선하고 공개 부서·팀 표기를 보조로 분류했어요. 실제 담당 업무는 원문에서 확인해 주세요.'
      : '제목과 확인 가능한 부서 정보만으로는 세부 직무를 특정하기 어려워요. 모든 개발 직무 또는 세부 직무 미확인 필터에서 탐색할 수 있어요.'}</p>
    {classification.evidence.length > 0 && <details className="qualification-evidence">
      <summary>직무 분류에 사용한 원문<ChevronDown size={14} /></summary>
      <ul>{classification.evidence.map((evidence, index) => <li key={`${evidence.role}-${index}`}>
        <span>{ROLE_FILTER_LABELS[evidence.role]} · {evidence.source === 'title' ? '공고 제목' : '공개 부서·팀'}</span>
        <blockquote>{evidence.text}</blockquote>
      </li>)}</ul>
    </details>}
  </section>
}
