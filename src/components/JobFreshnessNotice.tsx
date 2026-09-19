import { History } from 'lucide-react'
import { useContext } from 'react'
import { formatCollectionTime } from '../../shared/catalog-health'
import { jobFreshness } from '../../shared/catalog-freshness'
import type { Job } from '../../shared/types'
import { FreshnessTimeContext } from '../hooks/useDeadlineClock'

export function JobFreshnessNotice({ job, compact = false }: { job: Job; compact?: boolean }) {
  const now = useContext(FreshnessTimeContext)
  const freshness = jobFreshness(job, now ?? Date.now())
  if (freshness === 'fresh') return null
  const time = formatCollectionTime(job.fetchedAt)
  const expired = freshness === 'expired'
  if (compact) return <span className="stale-job-badge" title={`${time}에 마지막으로 확인한 공고예요. 현재 채용 여부는 원문에서 확인해 주세요.`}><History size={12} />{expired ? '확인 기간 지남' : '이전 조회 공고'}</span>
  return <aside className="job-freshness-notice">
    <History size={18} />
    <div><strong>{expired ? '추천에서 제외된 조회 기록이에요' : '이전 조회 결과를 보고 있어요'}</strong><p><time dateTime={job.fetchedAt}>{time}</time>에 마지막으로 확인한 내용이에요. {expired && '24시간이 지나 현재 추천 집계에서는 제외하며, 저장한 기록은 유지합니다. '}모집 종료를 뜻하지 않으니 현재 채용 여부와 변경된 조건은 원문에서 확인해 주세요.</p></div>
  </aside>
}
