import { ChevronDown, UsersRound } from 'lucide-react'
import { isTalentPoolJob, upgradeJobPostingPurpose } from '../../shared/job-posting'
import { POSTING_TYPE_LABELS } from '../../shared/types'
import type { Job } from '../../shared/types'

export function PostingPurposeBadge({ job }: { job: Job }) {
  if (!isTalentPoolJob(upgradeJobPostingPurpose(job))) return null
  return <span className="posting-purpose-badge"><UsersRound size={13} />{POSTING_TYPE_LABELS['talent-pool']}</span>
}

export function JobPostingPurposeDetails({ job }: { job: Job }) {
  const current = upgradeJobPostingPurpose(job)
  if (!isTalentPoolJob(current)) return null
  return <section className="job-posting-purpose" aria-label="모집 유형 안내">
    <h4><UsersRound size={16} />{POSTING_TYPE_LABELS['talent-pool']}</h4>
    <p>현재 채용 중인 특정 포지션이 아닌 인재풀·향후 기회 등록입니다. 모집 내용은 원문에서 확인해 주세요.</p>
    <details className="qualification-evidence">
      <summary>모집 유형 판단 근거<ChevronDown size={14} /></summary>
      <ul>{current.postingPurpose!.evidence.map((evidence, index) => <li key={index}>
        <span>{evidence.source === 'board' ? '공개 게시판의 관심 등록 표기' : '공고 본문'}</span>
        <blockquote>{evidence.text}</blockquote>
      </li>)}</ul>
    </details>
  </section>
}
