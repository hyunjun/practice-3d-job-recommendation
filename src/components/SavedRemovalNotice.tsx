import { RotateCcw, X } from 'lucide-react'
import type { SavedRemovalController } from '../hooks/useSavedRemoval'

interface Props {
  removal: SavedRemovalController
  storageFailed: boolean
  onAction: (button: HTMLButtonElement, jobId: string, action: () => void) => void
}

export function SavedRemovalNotice({ removal, storageFailed, onAction }: Props) {
  const entries = [removal.pending, removal.latest].filter(entry => entry !== null)
  return <section className="saved-removal-notice" aria-label="제거한 기회 복구">
    <header><RotateCcw size={17} aria-hidden="true" /><h3>제거한 기회 복구</h3></header>
    <p className="saved-removal-scope">복구 대기 1개와 최근 제거 1개를 이 탭을 열어 둔 동안 보관해요. 최근 제거는 다음 제거 시 바뀌어요.</p>
    <div className="saved-removal-records">{entries.map(entry => {
      const pending = entry === removal.pending
      const blocked = !pending && removal.pending !== null
      const waiting = entry.attempt !== null
      const { record } = entry
      const titleId = `saved-removal-${entry.generation}-title`
      const kindId = `saved-removal-${entry.generation}-kind`
      const messageId = `saved-removal-${entry.generation}-message`
      const savedDate = new Date(record.savedAt)
      const note = [...record.note]
      const message = blocked
        ? `${record.company.name}의 공고를 저장 목록에서 제거했어요. 먼저 ${removal.pending!.record.company.name} · ${removal.pending!.record.job.title}의 복구를 완료하거나 복구 안내를 닫아 주세요.`
        : entry.message ?? (!pending ? `${record.company.name}의 공고를 저장 목록에서 제거했어요.` : '')
      return <article className="saved-removal-record" key={entry.generation} aria-labelledby={`${kindId} ${titleId}`}>
        <p className="saved-removal-kind" id={kindId}>{pending ? '복구 대기' : '최근 제거'}</p>
        <h4 id={titleId}>{record.company.name}<span> · </span>{record.job.title}</h4>
        <p className="saved-removal-meta">{record.status === 'applied' ? '지원 완료' : '검토 중'}<span> · </span>{Number.isNaN(savedDate.getTime()) ? '저장일 확인 필요' : <><time dateTime={record.savedAt}>{savedDate.toLocaleDateString('ko-KR')}</time> 저장</>}</p>
        {record.note && <p className="saved-removal-note" aria-label="원래 메모">{note.length > 180 ? `${note.slice(0, 180).join('')}…` : record.note}</p>}
        <p id={messageId} className="saved-removal-message" role="status" aria-atomic="true">{message}</p>
        {waiting && <p className="saved-removal-wait">{storageFailed ? '원래 기록은 보관 중이에요. 저장소 안내의 ‘저장 다시 시도’로 계속할 수 있어요.' : '원래 기록의 저장 완료를 확인하고 있어요.'}</p>}
        <div className="saved-removal-actions">
          <button className="button secondary" disabled={waiting || blocked} aria-describedby={message ? messageId : undefined} onClick={event => onAction(event.currentTarget, record.job.id, () => removal.restore(entry.generation))}><RotateCcw size={15} aria-hidden="true" />{pending ? '복구 다시 시도' : '실행 취소'}</button>
          <button className="text-button" onClick={event => onAction(event.currentTarget, record.job.id, () => removal.dismiss(entry.generation))}><X size={15} aria-hidden="true" />복구 안내 닫기</button>
        </div>
      </article>
    })}</div>
  </section>
}
