import { ChevronDown, Coins } from 'lucide-react'
import { formatCompensation } from '../../shared/matching'
import { COMPENSATION_VERSION } from '../../shared/types'
import type { FactEvidence, Job } from '../../shared/types'

export function CompensationDetails({ job }: { job: Job }) {
  const ranges = job.compensationRanges ?? []
  const legacy = job.source !== 'sample' && job.salary && job.compensationVersion !== COMPENSATION_VERSION
  if (!ranges.length && !job.compensationNote && !legacy) return null
  return <details className="job-compensation" open={!job.salary || Boolean(legacy)}>
    <summary><Coins size={16} />공고의 보상 조건{ranges.length > 0 && <small>{ranges.length}개 구간</small>}<ChevronDown size={14} /></summary>
    <div className="compensation-body">
      <p>{job.compensationNote || (legacy ? '이전 형식으로 저장된 금액입니다. 지급 기간과 적용 조건은 원문에서 다시 확인해 주세요.' : '공고에서 확인한 급여 구간입니다. 보너스·주식은 기본 연봉에 합산하지 않았어요.')}</p>
      {ranges.length > 0 && <dl>{ranges.map((range, index) => <div key={`${range.label}-${index}`}>
        <dt>{range.label}</dt><dd>
          <span>{formatCompensation(range)}</span>
          {range.scope && <p className="compensation-scope"><strong>적용 조건</strong>{range.scope}</p>}
          {range.evidence && <CompensationEvidence evidence={range.evidence} />}
        </dd>
      </div>)}</dl>}
      {job.compensationEvidence?.map((evidence, index) => <CompensationEvidence evidence={evidence} key={index} />)}
    </div>
  </details>
}

function CompensationEvidence({ evidence }: { evidence: FactEvidence }) {
  return <details className="compensation-evidence">
    <summary>{evidence.source === 'board' ? '게시판의 보상 설명' : '금액의 원문 근거'}<ChevronDown size={13} /></summary>
    <blockquote>{evidence.text}</blockquote>
  </details>
}
