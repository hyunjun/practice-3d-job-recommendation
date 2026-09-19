import { CircleHelp, RefreshCw } from 'lucide-react'
import type { Catalog } from '../../shared/types'
import { EmptyState, Spinner } from './ui'

interface Props {
  catalog: Catalog
  loading: boolean
  error: string
  onRetry: () => void
  onData: () => void
}

export function CatalogStatus({ catalog, loading, error, onRetry, onData }: Props) {
  if (!catalog.fetchedAt) return <section className="catalog-placeholder" aria-live="polite" aria-busy={loading}>
    <EmptyState
      icon={loading ? <Spinner label="공개 공고 조회 중" /> : <CircleHelp size={27} />}
      title={loading ? '공개 공고를 불러오고 있어요' : '공개 공고에 연결하지 못했어요'}
      text={loading ? '현재 탐색 조건을 유지한 채 채용 게시판을 조회하고 있어요.' : error || '연결 상태를 확인한 뒤 다시 조회해 주세요.'}
    >
      {!loading && <button className="button primary" onClick={onRetry}><RefreshCw size={15} />다시 조회</button>}
      <button className="text-button" onClick={onData}>데이터 모드 선택</button>
    </EmptyState>
  </section>
  if (!loading && !error) return null
  return <div className="catalog-notice" role="status">
    {loading ? <Spinner /> : <CircleHelp size={16} />}
    <p>{loading ? '공개 공고를 조회하고 있어요.' : error}<span>{catalog.source === 'sample' ? '현재는 샘플 결과를 표시하고 있어요.' : '현재 화면에는 이전 조회 결과가 유지됩니다.'}</span></p>
    {!loading && <button className="text-button" onClick={onRetry}>다시 조회</button>}
  </div>
}
