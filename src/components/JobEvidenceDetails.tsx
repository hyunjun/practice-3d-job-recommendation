import { ChevronDown, FileText } from 'lucide-react'
import { FACT_LABELS } from '../../shared/types'
import type { JobEvidence } from '../../shared/types'

export function JobEvidenceDetails({ evidence }: { evidence?: JobEvidence }) {
  const facts = (Object.keys(FACT_LABELS) as (keyof JobEvidence)[]).flatMap(field => {
    const fact = evidence?.[field]
    return fact ? [{ field, fact }] : []
  })
  if (!facts.length) return null
  return <details className="job-evidence">
    <summary><FileText size={15} /><span>채용 조건의 원문 근거</span><small>{facts.length}개</small><ChevronDown size={15} /></summary>
    <div className="job-evidence-body">
      <p>조건을 판별할 때 사용한 게시판 정보와 원문입니다. 제한 사항까지 함께 확인해 주세요.</p>
      <dl>{facts.map(({ field, fact }) => <div key={field}>
        <dt>{FACT_LABELS[field]}<span>{fact.source === 'board' ? '게시판 정보' : fact.source === 'title' ? '공고 제목' : '공고 본문'}</span></dt>
        <dd><blockquote>{fact.text}</blockquote></dd>
      </div>)}</dl>
    </div>
  </details>
}
