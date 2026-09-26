import { ArrowUpRight, CheckCircle2, CircleHelp, FileDiff } from 'lucide-react'
import { formatCollectionTime } from '../../shared/catalog-health'
import { safeExternalUrl } from '../../shared/matching'
import { jobPostingUrl } from '../../shared/job-links'
import { POSTING_STATE_LABELS, REVISION_LABELS } from '../../shared/posting-status'
import type { PostingObservation } from '../../shared/posting-status'
import type { Job } from '../../shared/types'

export function SavedPostingNotice({ observation, job, compact = false }: {
  observation?: PostingObservation
  job: Job
  compact?: boolean
}) {
  if (!observation || observation.state === 'sample') return null
  const changed = Boolean(observation.changedFields?.length)
  const url = safeExternalUrl(jobPostingUrl({ ...job, url: observation.currentUrl ?? job.url }))
  const Icon = changed ? FileDiff : observation.state === 'listed' ? CheckCircle2 : CircleHelp
  return <div className={`posting-notice ${observation.state} ${changed ? 'changed' : ''} ${compact ? 'compact' : ''}`}>
    <div className="posting-notice-heading"><Icon size={14} /><strong>{POSTING_STATE_LABELS[observation.state]}</strong>{changed && <span>저장 내용과 차이</span>}</div>
    {observation.checkedAt && <p className="posting-check-time">{formatCollectionTime(observation.checkedAt)} 목록 기준</p>}
    {job.source === 'himalayas' && <p>Himalayas의 게시 목록 기준입니다. 회사 공식 채용 페이지의 현재 모집 여부와 다를 수 있어요.</p>}
    {observation.contentCheckedAt && <p className="posting-check-time">{formatCollectionTime(observation.contentCheckedAt)} 본문 기준{observation.contentState === 'stale' ? ' · 다시 확인 필요' : ''}</p>}
    {changed && <p className="posting-changes">{observation.changedFields!.map(field => REVISION_LABELS[field]).join(' · ')} 확인 필요</p>}
    {changed && observation.changedFields?.includes('title') && <p className="posting-current-title">현재 포지션: {observation.currentTitle}</p>}
    {observation.message && <p>{observation.message}</p>}
    {changed && !compact && <p>저장 당시 표시 내용과 비교한 결과예요. 원문 변경이나 정보 해석 방식의 차이일 수 있습니다. 저장한 공고·메모·지원 기록은 그대로 보관해요.</p>}
    {observation.state !== 'unchecked' && url && <a href={url} target="_blank" rel="noopener noreferrer">현재 원문 확인<ArrowUpRight size={12} /></a>}
  </div>
}
