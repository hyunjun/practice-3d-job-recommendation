import { BriefcaseBusiness, ChevronDown } from 'lucide-react'
import { jobRoleEvidence, jobRoleLabel, jobRoles, upgradeJobRole } from '../../shared/job-roles'
import { isTechnicalJob, jobOccupationLabel, upgradeJobOccupation } from '../../shared/job-occupation'
import { ROLE_FILTER_LABELS } from '../../shared/types'
import type { Job } from '../../shared/types'

export function JobRoleDetails({ job }: { job: Job }) {
  if (job.source === 'sample') return null
  const current = upgradeJobRole(upgradeJobOccupation(job))
  const roles = jobRoles(current)
  const evidence = jobRoleEvidence(current)
  const occupation = current.occupation!
  const technical = isTechnicalJob(current)
  const research = occupation.category === 'research'
  return <><JobOccupationNotice job={current} /><section className="job-role-details" aria-label="직무 분류">
    <h4><BriefcaseBusiness size={15} />{technical ? '공고의 직무 표기' : '공고의 직군'}</h4>
    <strong>{jobRoleLabel(current)}</strong>
    <p>{!technical ? '세부 개발 직무는 표시하지 않아요. 공고 제목과 원문에서 실제 담당 업무를 확인해 주세요.'
      : roles.length
      ? evidence.some(item => item.source === 'description')
        ? '연구 업무·자격 항목의 AI·머신러닝 근거로 분류했어요. 실제 담당 업무는 원문에서 확인해 주세요.'
        : '제목을 우선하고 공개 부서·팀 표기를 보조로 분류했어요. 실제 담당 업무는 원문에서 확인해 주세요.'
      : '확인 가능한 공고 정보만으로는 세부 직무를 특정하기 어려워요. 실제 담당 업무는 원문에서 확인해 주세요.'}</p>
    {research && <p>컴퓨터·AI 연구 직군으로 탐색에 포함했어요. 필요한 연구 경력과 학위는 자격 항목에서 따로 확인해 주세요.</p>}
    {evidence.length > 0 && <details className="qualification-evidence">
      <summary>직무 분류에 사용한 원문<ChevronDown size={14} /></summary>
      <ul>{evidence.map((evidence, index) => <li key={`${evidence.role}-${index}`}>
        <span>{ROLE_FILTER_LABELS[evidence.role]} · {evidence.source === 'title' ? '공고 제목' : evidence.source === 'board' ? '공개 부서·팀' : '연구 업무·자격 원문'}</span>
        <blockquote>{evidence.text}</blockquote>
      </li>)}</ul>
    </details>}
    {!technical && occupation.departments.length > 0 && <p>공개 부서·팀: {occupation.departments.join(' · ')}</p>}
    {(research || !technical) && <details className="qualification-evidence occupation-evidence">
      <summary>탐색 직군을 판단한 원문<ChevronDown size={14} /></summary>
      <ul>{occupation.evidence.map((evidence, index) => <li key={index}>
        <span>{jobOccupationLabel(current)} · {evidence.source === 'title' ? '공고 제목' : evidence.source === 'board' ? '공개 게시판 정보' : '업무·자격 원문'}</span>
        <blockquote>{evidence.text}</blockquote>
      </li>)}</ul>
    </details>}
  </section></>
}

export function JobOccupationNotice({ job, compact = false }: { job: Job; compact?: boolean }) {
  if (isTechnicalJob(job)) return null
  return <div className="occupation-notice">
    <strong>현재 탐색 범위 밖 · {jobOccupationLabel(job)}</strong>
    <p>{compact ? '저장한 공고·메모·지원 기록은 계속 보관해요.'
      : '개발·컴퓨터 연구 중심의 탐색 목록에서는 제외되었어요. 채용 종료를 뜻하지 않으며 저장한 공고·메모·지원 기록은 계속 보관해요. 게시 여부와 담당 업무는 원문에서 확인해 주세요.'}</p>
  </div>
}
