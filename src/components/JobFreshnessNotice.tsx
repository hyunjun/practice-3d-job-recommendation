import { History } from 'lucide-react'
import { formatCollectionTime } from '../../shared/catalog-health'
import type { Job } from '../../shared/types'

export function JobFreshnessNotice({ job, compact = false }: { job: Job; compact?: boolean }) {
  if (!job.stale) return null
  const time = formatCollectionTime(job.fetchedAt)
  if (compact) return <span className="stale-job-badge" title={`${time}에 마지막으로 확인한 공고예요. 현재 채용 여부는 원문에서 확인해 주세요.`}><History size={12} />이전 조회 공고</span>
  return <aside className="job-freshness-notice">
    <History size={18} />
    <div><strong>이전 조회 결과를 보고 있어요</strong><p>게시판 재조회가 실패해 <time dateTime={job.fetchedAt}>{time}</time>에 확인한 내용을 유지했어요. 현재 채용 여부와 변경된 조건은 원문에서 확인해 주세요.</p></div>
  </aside>
}
