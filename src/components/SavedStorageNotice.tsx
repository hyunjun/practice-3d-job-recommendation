import { useState } from 'react'
import { CheckCircle2, CircleAlert, Download, RefreshCw } from 'lucide-react'
import type { SavedJobsController } from '../hooks/useSavedJobs'
import type { SavedStorageErrorCode } from '../lib/saved-store'
import { exportSavedCsv } from '../lib/storage'
import { downloadSavedRecovery } from '../lib/saved-files'

const ERROR_HELP: Record<SavedStorageErrorCode, string> = {
  unavailable: '브라우저의 사이트 데이터 저장 설정을 확인한 뒤 다시 연결해 주세요.',
  blocked: '다른 ORBIT 탭을 닫은 뒤 다시 연결해 주세요.',
  'legacy-read': '이전에 저장한 기록에 접근할 수 없어요. 브라우저의 사이트 데이터 저장 설정을 확인해 주세요.',
  quota: '브라우저 저장 공간이 부족해요. CSV로 기록을 보관하고 불필요한 기록을 정리한 뒤 다시 시도해 주세요.',
  limit: '다른 탭의 기록을 포함해 최대 500개까지 저장할 수 있어요. 기록을 정리한 뒤 다시 시도해 주세요.',
  unreadable: '같은 공고의 기존 기록을 읽을 수 없어 덮어쓰지 않았어요. 원본은 그대로 보관돼요.',
  missing: '다른 탭에서 이 공고를 제거했어요. 다시 시도하면 현재 메모와 함께 복원해요.',
  write: '저장소에 연결하지 못했거나 저장이 중단됐어요. 다시 시도해 주세요.',
  changed: '다른 탭에서 기록이 바뀌었어요. 현재 내용을 다시 확인해 주세요.',
  busy: '진행 중인 저장이 끝난 뒤 다시 시도해 주세요.',
}

export function SavedStorageNotice({ storage, issuesOnly = false, onManage }: { storage: SavedJobsController; issuesOnly?: boolean; onManage?: () => void }) {
  const [downloadError, setDownloadError] = useState(false)
  const { phase, ready, pending, recovery, records, error, retry } = storage
  if (issuesOnly && phase !== 'error' && !recovery.length) return null
  const failed = phase === 'error'
  const busy = phase === 'loading' || phase === 'saving'
  const title = failed ? !ready ? '저장한 기회를 불러오지 못했어요.' : pending ? '아직 저장하지 못한 변경이 있어요.' : '저장소 연결을 확인해 주세요.'
    : phase === 'loading' ? '저장한 기회를 불러오는 중이에요.'
      : phase === 'saving' ? '변경 사항을 저장하고 있어요.'
        : records.length ? '이 브라우저에 저장됐어요.' : '공고와 메모를 이 브라우저에 보관해요.'
  const downloadOriginals = () => {
    try {
      downloadSavedRecovery(recovery)
      setDownloadError(false)
    } catch { setDownloadError(true) }
  }
  return <div className={`saved-storage-notice ${failed ? 'has-error' : busy ? 'is-busy' : ''}`}>
    <div className="saved-storage-summary" role={failed ? 'alert' : 'status'} aria-atomic="true">
      {failed ? <CircleAlert size={16} /> : busy ? <span className="spinner-wrap" aria-hidden="true"><span className="spinner" /></span> : <CheckCircle2 size={15} />}
      <div><p>{title}</p>{failed && <small>{error && ERROR_HELP[error]}{pending > 0 ? ' 마지막 입력은 이 탭에 남아 있어요. 저장 완료 전에는 탭을 닫지 마세요.' : ready ? ' 마지막으로 읽은 기록을 표시하고 있어요.' : ' 기존 기록을 확인하기 전까지 새 저장은 잠시 멈춰요.'}</small>}</div>
    </div>
    {failed && <div className="saved-storage-actions"><button className="button secondary" onClick={retry}><RefreshCw size={14} />{pending ? '저장 다시 시도' : '저장소 다시 연결'}</button>{pending > 0 && records.length > 0 && <button className="text-button" onClick={() => exportSavedCsv(records)}><Download size={14} />현재 내용 CSV로 보관</button>}{onManage && ready && <button className="text-button" onClick={onManage}>JSON 백업·복원</button>}</div>}
    {recovery.length > 0 && <details className="saved-recovery">
      <summary>따로 보관한 원본이 있어요</summary>
      <p>일부 기록을 읽거나 합칠 수 없어 이전 데이터의 원본을 따로 보관했어요. 정상 기록은 계속 사용할 수 있어요.</p>
      <button className="text-button" onClick={downloadOriginals}><Download size={14} />보관한 원본 내려받기</button>
      <small>원본에는 현재 목록의 메모도 포함될 수 있고, 목록에서 삭제해도 원본은 남아요. 파일에서 필요한 기록을 가져오거나 보관본을 따로 정리할 수 있어요.</small>
      {onManage && <button className="text-button" onClick={onManage}>원본 가져오기·정리</button>}
      {downloadError && <p role="alert">파일을 만들지 못했어요. 원본은 브라우저에 그대로 남아 있어요.</p>}
    </details>}
  </div>
}
