import { ChevronDown, Coins } from 'lucide-react'
import { formatCompensation } from '../../shared/matching'
import type { Job } from '../../shared/types'

export function CompensationDetails({ job }: { job: Job }) {
  const ranges = job.compensationRanges ?? []
  if (!ranges.length && !job.compensationNote) return null
  return <details className="job-compensation" open={!job.salary}>
    <summary><Coins size={16} />공고의 보상 조건{ranges.length > 0 && <small>{ranges.length}개 구간</small>}<ChevronDown size={14} /></summary>
    <div className="compensation-body">
      <p>{job.compensationNote || '게시판에 구분되어 있는 급여 구간입니다. 보너스·주식은 합산하지 않았어요.'}</p>
      {ranges.length > 0 && <dl>{ranges.map((range, index) => <div key={`${range.label}-${index}`}><dt>{range.label}</dt><dd>{formatCompensation(range)}</dd></div>)}</dl>}
    </div>
  </details>
}
