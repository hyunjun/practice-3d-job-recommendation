import type { CatalogProgress } from '../../shared/catalog-progress'
import type { Catalog } from '../../shared/types'
import { collectionHealth } from '../../shared/catalog-health'

export function CollectionProgress({ catalog, progress }: { catalog: Catalog; progress: CatalogProgress }) {
  const health = collectionHealth(catalog)
  const pending = catalog.boards.filter(board => board.status === 'pending')
    .map(board => catalog.companies.find(company => company.id === board.companyId)?.name).filter(Boolean)
  const remaining = pending.slice(0, 3).join(', ') + (pending.length > 3 ? ` 외 ${pending.length - 3}곳` : '')
  return <div className="collection-progress" role="status" aria-live="polite">
    {progress.phase === 'waiting-for-presence' ? <>
      <div className="collection-progress-heading"><span>공고 조회 대기 중</span></div>
      <p>먼저 시작한 게시 상태 확인을 기다리고 있어요. 끝나면 필요한 회사의 공고를 이어서 조회합니다.</p>
    </> : <>
      <div className="collection-progress-heading"><span>이번 회사 조회</span><strong>{progress.completed}<span> / {progress.total}개</span></strong></div>
      <progress aria-label="공개 게시판 조회 진행" max={progress.total} value={progress.completed}
        aria-valuetext={`${progress.total}개 회사 중 ${progress.completed}개 조회 종료`} />
    </>}
    <p>{catalog.jobs.length ? `${catalog.jobs.length.toLocaleString()}개 공고를 먼저 탐색할 수 있어요. 결과가 도착하면 이어서 반영합니다.` : '먼저 확인된 회사부터 공고를 표시해요. 탐색 조건은 그대로 유지됩니다.'}</p>
    {health.retained > 0 && <p className="collection-progress-remaining">이전 조회 공고 {health.retained.toLocaleString()}개를 포함하며, 원래 조회 시각을 유지합니다.</p>}
    {remaining && <p className="collection-progress-remaining">확인 중 · {remaining}</p>}
    {health.failed > 0 && <p className="collection-progress-failed">현재 조회 실패 상태인 회사는 {health.failed}개입니다. 회사별 조회 기록에서 확인할 수 있습니다.</p>}
  </div>
}
