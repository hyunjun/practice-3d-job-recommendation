import { useEffect, useMemo, useRef, useState } from 'react'
import { Check, ChevronLeft, ChevronRight, Download, FileJson, RefreshCw, Trash2, Upload } from 'lucide-react'
import { createSavedBackup, MAX_SAVED_FILE_BYTES, parseSavedImport, SavedFileError, savedDifferences, SAVED_DIFFERENCE_LABELS } from '../../shared/saved-backup'
import type { ParsedSavedImport } from '../../shared/saved-backup'
import { MAX_SAVED_JOBS } from '../../shared/saved-jobs'
import { JOB_SOURCE_LABELS } from '../../shared/types'
import type { SavedJob } from '../../shared/types'
import type { SavedJobsController } from '../hooks/useSavedJobs'
import type { SavedState } from '../lib/saved-controller'
import type { SavedRecovery, SavedStorageErrorCode } from '../lib/saved-store'
import { downloadSavedFile, downloadSavedRecovery } from '../lib/saved-files'
import { Dialog, Spinner } from './ui'
import { SavedStorageNotice } from './SavedStorageNotice'

type Base = Pick<SavedState, 'records' | 'occupied' | 'unreadableIds'>
interface Review {
  name: string
  parsed: ParsedSavedImport
  base: Base
  variants: Map<string, number>
  selected: Set<string>
  invalidated?: boolean
}
const PAGE_SIZE = 20
const OPERATION_ERRORS: Record<SavedStorageErrorCode, string> = {
  changed: '미리보기 이후 기록이 바뀌었어요. 현재 기록으로 다시 비교한 뒤 선택해 주세요.',
  limit: '저장 후 공고가 500개를 넘어요. 선택을 줄이거나 기존 기록을 정리해 주세요.',
  quota: '브라우저 저장 공간이 부족해 반영하지 못했어요. 기존 기록은 그대로예요. 공간을 확보한 뒤 다시 시도해 주세요.',
  unreadable: '선택한 공고의 기존 원본을 읽을 수 없어요. 원본을 내려받고 확인한 뒤 정리해 주세요.',
  busy: '현재 입력을 먼저 저장한 뒤 다시 시도해 주세요. 저장 실패 시 재연결하거나 파일로 보관할 수 있어요.',
  unavailable: '저장소에 연결하지 못했어요. 다시 연결한 뒤 시도해 주세요.',
  blocked: '다른 ORBIT 탭을 닫고 저장소에 다시 연결해 주세요.',
  'legacy-read': '이전 형식의 원본에 접근할 수 없어요. 브라우저의 사이트 데이터 설정을 확인해 주세요.',
  missing: '기존 기록을 찾지 못했어요. 현재 기록으로 다시 비교해 주세요.',
  write: '반영을 완료하지 못했어요. 기존 기록은 그대로예요. 다시 시도해 주세요.',
}
const FILE_ERRORS = {
  format: 'ORBIT의 JSON 백업·복구 파일 또는 이전 저장 목록을 선택해 주세요. CSV는 가져올 수 없어요.',
  version: '이 버전의 백업 파일은 아직 읽을 수 없어요. 더 최신 버전의 ORBIT에서 확인해 주세요.',
  size: '파일은 최대 50MB까지 읽을 수 있어요.',
  count: '한 파일에서 최대 5,000개 기록을 검토할 수 있어요. 파일을 나누어 주세요.',
}
function date(value: string): string {
  return Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString('ko-KR') : '날짜 미확인'
}
function recoveryLabel(source: SavedRecovery) {
  return source.kind === 'legacy' ? '이전 목록의 보관 원본'
    : source.kind === 'additional-legacy' ? '이전 형식의 브라우저 사본' : '읽을 수 없는 저장 항목'
}
function makeReview(name: string, parsed: ParsedSavedImport, base: Base): Review {
  const existing = new Set([...base.records.map(record => record.job.id), ...base.unreadableIds])
  const selected = new Set(parsed.groups.filter(group => !existing.has(group.id)).slice(0, Math.max(0, MAX_SAVED_JOBS - base.occupied)).map(group => group.id))
  return { name, parsed, base, selected, variants: new Map() }
}

export function SavedDataDialog({ storage, onClose }: { storage: SavedJobsController; onClose: () => void }) {
  const [review, setReview] = useState<Review | null>(null)
  const [reading, setReading] = useState(false)
  const [page, setPage] = useState(0)
  const [filter, setFilter] = useState('all')
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [removing, setRemoving] = useState<SavedRecovery | null>(null)
  const request = useRef(0)
  const section = useRef<HTMLElement>(null)
  const feedback = useRef<HTMLDivElement>(null)
  useEffect(() => { if (error || message) feedback.current?.scrollIntoView({ block: 'nearest' }) }, [error, message])
  const canWrite = storage.ready && storage.phase === 'ready' && !storage.pending && !storage.busy
  const stale = Boolean(review && (review.invalidated || review.base.records !== storage.records))
  const current = useMemo(() => new Map(review?.base.records.map(record => [record.job.id, record]) ?? []), [review?.base])
  const rows = useMemo(() => review?.parsed.groups.map(group => {
    const record = group.variants[review.variants.get(group.id) ?? 0]
    const previous = current.get(group.id)
    const differences = previous ? savedDifferences(previous, record) : []
    const state = review.base.unreadableIds.includes(group.id) ? 'blocked' : previous ? differences.length ? 'different' : 'same' : 'new'
    return { group, record, previous, differences, state }
  }) ?? [], [review, current])
  const filtered = rows.filter(row => filter === 'all' || row.state === filter || (filter === 'selected' && review?.selected.has(row.group.id)))
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const currentPage = Math.min(page, pages - 1)
  const chosen = rows.filter(row => review?.selected.has(row.group.id))
  const additions = chosen.filter(row => row.state === 'new').length
  const replacements = chosen.filter(row => row.state === 'different').length
  const resultingCount = (review?.base.occupied ?? storage.occupied) + additions
  const overLimit = resultingCount > MAX_SAVED_JOBS

  const readFile = async (file?: File) => {
    if (!file || storage.busy) return
    const ticket = ++request.current
    setReading(true); setReview(null); setError(null); setMessage(null); setRemoving(null)
    try {
      if (file.size > MAX_SAVED_FILE_BYTES) throw new SavedFileError('size')
      const text = await file.text()
      if (ticket !== request.current) return
      const parsed = parseSavedImport(text)
      setReview(makeReview(file.name, parsed, storage)); setPage(0); setFilter('all')
    } catch (failure) {
      if (ticket === request.current) setError(failure instanceof SavedFileError ? FILE_ERRORS[failure.code] : '파일을 읽지 못했어요. 파일을 다시 선택해 주세요.')
    } finally { if (ticket === request.current) setReading(false) }
  }
  const exportBackup = () => {
    try {
      downloadSavedFile(createSavedBackup(storage.records, storage.pending), `orbit-saved-backup-${new Date().toISOString().slice(0, 10)}.json`)
      setError(null)
      setMessage(`현재 공고 ${storage.records.length}개의 백업 파일을 만들었어요.${storage.pending ? ' 아직 브라우저에 저장하지 못한 입력도 포함했어요.' : ''}`)
    } catch { setError('백업 파일을 만들지 못했어요. 기록은 그대로 남아 있어요.') }
  }
  const refreshReview = async () => {
    if (!review || reading || storage.busy) return
    const ticket = ++request.current
    setReading(true); setError(null)
    const snapshot = await storage.refresh()
    if (ticket !== request.current) return
    if (snapshot.phase === 'ready' && !snapshot.pending) {
      setReview(makeReview(review.name, review.parsed, snapshot)); setPage(0); setFilter('all')
      setMessage('현재 기록으로 다시 비교했어요. 기존 기록을 바꾸는 선택은 초기화했어요.')
    } else setError(OPERATION_ERRORS.busy)
    setReading(false)
  }
  const apply = async () => {
    if (!review || !canWrite || stale || !chosen.length || overLimit) return
    setError(null); setMessage(null)
    const result = await storage.importRecords({ items: chosen.map(row => ({ record: row.record, expected: row.previous ?? null })) })
    if (result.ok) {
      setReview(null)
      setMessage(`선택한 ${chosen.length}개 기록을 저장했어요. 새 공고 ${additions}개 · 기존 공고 변경 ${replacements}개.${result.refreshFailed ? ' 목록을 다시 읽지 못했으니 저장소에 다시 연결해 주세요.' : ''}`)
    } else {
      setError(OPERATION_ERRORS[result.error])
      if (['changed', 'unreadable', 'limit'].includes(result.error)) setReview({ ...review, invalidated: true })
    }
  }
  const discard = async () => {
    if (!removing || !canWrite) return
    setError(null); setMessage(null)
    const result = await storage.discardRecovery(removing)
    if (result.ok) {
      setRemoving(null)
      setMessage(`선택한 보관본을 삭제했어요. 현재 공고 목록과 다른 보관본은 유지했어요.${result.refreshFailed ? ' 목록을 다시 읽으려면 저장소에 다시 연결해 주세요.' : ''}`)
    } else if (result.error === 'changed') {
      setRemoving(null)
      setError('보관본이 바뀌었어요. 갱신된 원본을 확인하고 다시 선택해 주세요.')
      await storage.refresh()
    } else setError(OPERATION_ERRORS[result.error])
  }
  const movePage = (next: number) => { setPage(next); section.current?.scrollIntoView({ block: 'start' }) }

  return <Dialog title="기록 백업과 복원" eyebrow="YOUR RECORDS, WITH YOU" className="saved-data-dialog" onClose={() => { if (!storage.busy) { request.current++; onClose() } }}>
    <div className="dialog-body saved-data-body">
      <section className="saved-backup-export" aria-labelledby="saved-export-title">
        <div><h3 id="saved-export-title"><FileJson size={18} />현재 기록을 파일로 보관</h3><p>목록의 공고·메모·지원 상태·저장일 {storage.ready ? `${storage.records.length}개` : ''}를 JSON 파일로 내려받아요. 다른 브라우저의 ORBIT에서도 가져올 수 있어요.</p>
          <small>프로필과 이력서는 포함하지 않아요.{storage.recovery.length > 0 && ' 따로 보관한 원본은 아래에서 각각 내려받아 주세요.'}{storage.pending > 0 && ' 아직 저장하지 못한 현재 입력도 파일에 포함돼요.'}</small></div>
        <button className="button secondary" onClick={exportBackup} disabled={!storage.ready || !storage.records.length || storage.busy}><Download size={15} />JSON 백업</button>
      </section>
      {storage.phase === 'error' && <SavedStorageNotice storage={storage} />}
      <div ref={feedback} className="saved-file-feedback">
      {message && <p className="saved-file-message" role="status"><Check size={16} />{message}</p>}
      {error && <p className="saved-file-error" role="alert">{error}</p>}
      </div>
      <section className="saved-import-section" aria-labelledby="saved-import-title" ref={section}>
        <h3 id="saved-import-title"><Upload size={18} />파일에서 가져오기</h3>
        <p className="field-description">파일을 먼저 검토하고 반영할 기록을 선택해요. 현재 기록과 다른 공고는 직접 선택하기 전까지 바꾸지 않아요.</p>
        <label className="saved-file-input"><span>백업 또는 복구 파일 선택</span><input type="file" accept=".json,application/json" aria-label="백업 또는 복구 파일" disabled={storage.busy} onChange={event => { void readFile(event.target.files?.[0]); event.target.value = '' }} /><small>JSON · 최대 50MB · 파일은 이 브라우저에서만 읽어요.</small></label>
        {reading && <Spinner label="파일과 현재 기록을 확인하는 중" />}
        {review && !reading && <>
          <div className="saved-import-summary">
            <strong>{review.name}</strong>
            {review.parsed.exportedAt && <small>{date(review.parsed.exportedAt)}에 만든 파일</small>}
            <p>공고 {rows.length}개 · 새 공고 {rows.filter(row => row.state === 'new').length}개 · 현재와 다른 공고 {rows.filter(row => row.state === 'different').length}개 · 같은 기록 {rows.filter(row => row.state === 'same').length}개</p>
            {(review.parsed.invalid > 0 || review.parsed.unreadableSources > 0) && <p className="saved-file-warning">읽을 수 없는 항목 {review.parsed.invalid}개 · 읽을 수 없는 원본 묶음 {review.parsed.unreadableSources}개는 가져오지 않아요. 선택한 원본 파일은 바꾸지 않아요.</p>}
            {review.parsed.duplicates > 0 && <p className="saved-file-warning">파일 안에 같은 공고가 {review.parsed.duplicates}번 더 있어요. 내용이 다르면 사용할 기록을 선택할 수 있어요.</p>}
            {stale && <p className="saved-file-warning">검토 중 현재 목록이 갱신됐어요. 다시 비교한 뒤 반영해 주세요.</p>}
            {rows.some(row => row.state === 'blocked') && <p className="saved-file-warning">기존 원본을 읽을 수 없는 공고는 선택할 수 없어요. 아래 보관 원본을 먼저 확인해 주세요.</p>}
            {!canWrite && <p className="saved-file-warning">현재 입력의 저장과 저장소 연결이 완료된 뒤 가져올 수 있어요.</p>}
          </div>
          {rows.length > 0 ? <>
            <div className="saved-import-tools">
              <label>파일 공고 보기<select value={filter} disabled={storage.busy} onChange={event => { setFilter(event.target.value); setPage(0) }}><option value="all">전체</option><option value="new">새 공고</option><option value="different">현재와 다른 공고</option><option value="blocked">기존 원본 확인 필요</option><option value="selected">선택한 공고</option></select></label>
              <button className="text-button" disabled={storage.busy} onClick={() => setReview({ ...review, selected: new Set() })}>선택 비우기</button>
              <button className="text-button" disabled={storage.busy || reading || !canWrite} onClick={() => void refreshReview()}><RefreshCw size={13} />현재 기록으로 다시 비교</button>
            </div>
            <p className="saved-import-selection" role="status">선택 {chosen.length}개 · 새 공고 {additions}개 추가 · 기존 {replacements}개 변경 · 저장 후 {resultingCount}/500개{overLimit && ' · 한도를 넘었어요. 선택을 줄여 주세요.'}</p>
            <div className="saved-import-list">{filtered.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE).map(row => <article className={`saved-import-row ${row.state}`} key={row.group.id}>
              <label className="saved-import-choice"><input type="checkbox" checked={review.selected.has(row.group.id)} disabled={storage.busy || stale || row.state === 'same' || row.state === 'blocked'} onChange={event => {
                const selected = new Set(review.selected)
                if (event.target.checked) selected.add(row.group.id); else selected.delete(row.group.id)
                setReview({ ...review, selected })
              }} /><span><strong>{row.record.company.name} · {row.record.job.title}</strong><small>{row.record.job.locationLabel} · {JOB_SOURCE_LABELS[row.record.job.source]}</small></span></label>
              <span className="saved-import-kind">{{ new: '새 공고', different: '현재 기록과 다름', same: '현재 기록과 같음', blocked: '원본 확인 필요' }[row.state]}</span>
              {row.group.variants.length > 1 && <label className="saved-import-variants">파일 안의 서로 다른 기록<select aria-label={`${row.record.company.name} ${row.record.job.title} 파일 기록 선택`} value={review.variants.get(row.group.id) ?? 0} disabled={storage.busy} onChange={event => {
                const selected = new Set(review.selected)
                if (row.previous) selected.delete(row.group.id)
                setReview({ ...review, variants: new Map(review.variants).set(row.group.id, Number(event.target.value)), selected })
              }}>{row.group.variants.map((variant, index) => <option value={index} key={index}>{index + 1}. {variant.status === 'applied' ? '지원 완료' : '검토 중'} · {variant.note.slice(0, 45) || '메모 없음'}</option>)}</select></label>}
              {row.previous && row.differences.length > 0 ? <details className="saved-import-differences">
                <summary>바뀌는 내용 확인 · {row.differences.map(key => SAVED_DIFFERENCE_LABELS[key]).join(' · ')}</summary>
                <div className="saved-record-comparison"><RecordContents title="현재 기록" record={row.previous} /><RecordContents title="파일의 기록" record={row.record} /></div>
                <p>이 공고를 선택하면 메모·지원 상태와 공고 스냅샷이 파일 내용으로 바뀌어요.</p>
              </details> : row.state !== 'same' && <details className="saved-import-differences"><summary>파일의 메모와 공고 확인</summary><RecordContents title="파일의 기록" record={row.record} /></details>}
            </article>)}</div>
            {!filtered.length && <p className="field-description">이 분류에 해당하는 공고가 없어요.</p>}
            {pages > 1 && <nav className="saved-import-pagination" aria-label="가져올 공고 페이지"><button className="button secondary" aria-label="이전 공고 페이지" disabled={currentPage === 0 || storage.busy} onClick={() => movePage(currentPage - 1)}><ChevronLeft size={15} />이전</button><span>{currentPage + 1} / {pages}</span><button className="button secondary" aria-label="다음 공고 페이지" disabled={currentPage === pages - 1 || storage.busy} onClick={() => movePage(currentPage + 1)}>다음<ChevronRight size={15} /></button></nav>}
          </> : <p className="field-description">이 파일에서 가져올 수 있는 공고를 찾지 못했어요. 현재 기록은 바뀌지 않았어요.</p>}
        </>}
      </section>
      {storage.recovery.length > 0 && <section className="saved-recovery-management" aria-labelledby="saved-recovery-title">
        <h3 id="saved-recovery-title">따로 보관한 원본 관리</h3>
        <p>이전 목록 전체에는 이미 삭제한 공고의 메모도 남아 있을 수 있어요. 필요한 보관본은 내려받은 뒤 정리할 수 있어요.</p>
        {storage.recovery.map((source, index) => <div className="saved-recovery-source" key={`${source.kind}-${index}`}><div><strong>{recoveryLabel(source)}</strong><small>{source.count === null ? '일부 기록을 읽을 수 없거나 별도 검토가 필요해요.' : `목록에 합치지 못한 항목 ${source.count}개`}</small></div><div className="saved-storage-actions"><button className="text-button" onClick={() => { try { downloadSavedRecovery([source]); setError(null) } catch { setError('원본 파일을 만들지 못했어요. 보관본은 그대로 남아 있어요.') } }}><Download size={14} />이 원본 내려받기</button><button className="text-button muted" disabled={!canWrite} onClick={() => { setRemoving(source); setError(null); setMessage(null) }}><Trash2 size={14} />보관본 삭제</button></div></div>)}
        {removing && <div className="saved-recovery-confirm" role="group" aria-label="보관본 삭제 확인">
          <strong>{recoveryLabel(removing)}을 삭제할까요?</strong><p>선택한 보관본만 삭제하며 되돌릴 수 없어요. 현재 공고 목록, 다른 보관본과 내려받은 파일은 유지해요.</p>
          {removing.kind === 'additional-legacy' && <p>이전 버전의 ORBIT 탭이 열려 있다면 먼저 닫아 주세요. 이 사본은 다른 탭의 동시 수정을 잠글 수 없고, 이전 탭이 다시 기록할 수도 있어요.</p>}
        </div>}
      </section>}
    </div>
    <footer className="dialog-footer saved-data-footer"><span>{storage.busy ? '기록을 반영하고 있어요…' : removing ? '선택한 보관본의 삭제 범위를 확인해 주세요.' : review ? `선택 ${chosen.length}개 · 새 공고 ${additions}개 · 변경 ${replacements}개` : '파일과 메모를 서버에 보내지 않아요.'}</span>
      {removing ? <div className="saved-recovery-footer-actions"><button className="button secondary" disabled={storage.busy} onClick={() => setRemoving(null)}>삭제 취소</button><button className="button secondary saved-delete-confirm" disabled={!canWrite} onClick={() => void discard()}><Trash2 size={14} />선택한 보관본 삭제</button></div>
        : <button className="button primary" disabled={storage.busy || reading || (Boolean(review) && (!canWrite || stale || !chosen.length || overLimit))} onClick={review ? () => void apply() : onClose}>{review ? `선택한 ${chosen.length}개 가져오기` : '완료'}{review && <Upload size={15} />}</button>}
    </footer>
  </Dialog>
}

function RecordContents({ title, record }: { title: string; record: SavedJob }) {
  return <section className="saved-record-contents"><h4>{title}</h4><dl>
    <div><dt>포지션</dt><dd>{record.company.name} · {record.job.title}</dd></div>
    <div><dt>근무지</dt><dd>{record.job.locationLabel}</dd></div>
    <div><dt>지원 상태</dt><dd>{record.status === 'applied' ? '지원 완료' : '검토 중'}</dd></div>
    <div><dt>저장일</dt><dd>{date(record.savedAt)}</dd></div>
    <div><dt>공고 조회</dt><dd>{date(record.job.fetchedAt)}</dd></div>
    <div><dt>메모</dt><dd className="saved-record-note" tabIndex={0}>{record.note || '메모 없음'}</dd></div>
  </dl><details className="saved-record-description"><summary>공고 본문 확인</summary><p tabIndex={0}>{record.job.description}</p><p tabIndex={0}>{record.job.url}</p></details><details className="saved-record-description"><summary>전체 저장 내용 보기</summary><pre tabIndex={0}>{JSON.stringify(record, null, 2)}</pre></details></section>
}
