import type { Catalog } from './types'

export function catalogNeedsAttention(catalog: Catalog): boolean {
  return catalog.source !== 'sample' && (catalog.stale || catalog.boards.some(board => board.status === 'error' || board.dataStatus === 'unavailable'))
}

export function collectionHealth(catalog: Catalog) {
  const retained = catalog.jobs.filter(job => job.stale ?? catalog.stale).length
  const unavailable = catalog.boards.filter(board => board.dataStatus === 'unavailable'
    || (!board.dataStatus && board.status === 'error' && !catalog.jobs.some(job => job.companyId === board.companyId))).length
  return { retained, recent: catalog.jobs.length - retained, unavailable, failed: catalog.boards.filter(board => board.status === 'error').length }
}

export function formatCollectionTime(value?: string | null): string {
  return value && Number.isFinite(Date.parse(value))
    ? new Date(value).toLocaleString('ko-KR', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
    : '확인 기록 없음'
}

export function formatRetryWait(seconds: number): string {
  return seconds >= 60 ? `${Math.ceil(seconds / 60)}분` : `${seconds}초`
}
