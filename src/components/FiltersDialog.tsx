import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowRight, RotateCcw, SlidersHorizontal } from 'lucide-react'
import { DEFAULT_FILTERS, EMPLOYMENT_LABELS, MODE_LABELS, POSTING_TYPE_LABELS, ROLE_FILTER_LABELS, VISA_FILTER_LABELS } from '../../shared/types'
import type { Filters } from '../../shared/types'
import { Dialog, Toggle } from './ui'

export function FiltersDialog({ filters, preview, onApply, onClose }: { filters: Filters; preview: (filters: Filters) => Promise<number>; onApply: (filters: Filters) => void; onClose: () => void }) {
  const [draft, setDraft] = useState(filters)
  const [result, setResult] = useState<{ draft: Filters; preview: typeof preview; count?: number; error?: string }>()
  const latest = useRef({ draft, preview })
  latest.current = { draft, preview }
  const wanted = useRef(0)
  const working = useRef(false)
  const mounted = useRef(true)
  const refresh = useCallback(() => {
    wanted.current++
    setResult(undefined)
    if (working.current) return
    working.current = true
    void (async () => {
      while (mounted.current) {
        const ticket = wanted.current
        const request = latest.current
        try {
          const count = await request.preview(request.draft)
          if (!mounted.current) return
          if (ticket !== wanted.current || request.draft !== latest.current.draft || request.preview !== latest.current.preview) continue
          setResult({ ...request, count })
        } catch (cause) {
          if (!mounted.current) return
          if (ticket !== wanted.current) continue
          setResult({ ...request, error: cause instanceof Error ? cause.message : '공고 수를 확인하지 못했어요.' })
        }
        return
      }
    })().finally(() => { working.current = false })
  }, [])
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useEffect(() => { refresh() }, [draft, preview, refresh])
  const current = result?.draft === draft && result.preview === preview ? result : undefined
  const counting = !current
  const update = <K extends keyof Filters>(key: K, value: Filters[K]) => setDraft(previous => ({ ...previous, [key]: value }))
  return <Dialog title="내게 중요한 조건으로." eyebrow="REFINE YOUR ORBIT" onClose={onClose} className="filters-dialog">
    <div className="dialog-body">
      <p className="dialog-intro">경험과 맞는 기회 중, 원하는 조건을 더해보세요.</p>
      <div className="field-group"><label htmlFor="filter-role">직무</label><select id="filter-role" aria-describedby="filter-role-help" value={draft.role} onChange={event => update('role', event.target.value as Filters['role'])}>{Object.entries(ROLE_FILTER_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select><p id="filter-role-help" className="field-description">공고 제목을 우선하고 공개 부서·팀 표기를 보조로 분류해요. 특정 직무를 선택하면 세부 직무 미확인 공고는 제외됩니다.{draft.role === 'unknown' && ' 미확인 공고에도 프로필의 기술 조건을 적용해요.'}</p></div>
      <div className="field-group"><label htmlFor="filter-posting-type">모집 유형</label><select id="filter-posting-type" aria-describedby="filter-posting-type-help" value={draft.postingType} onChange={event => update('postingType', event.target.value as Filters['postingType'])}>{Object.entries(POSTING_TYPE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select><p id="filter-posting-type-help" className="field-description">일반 채용 공고에서는 인재풀·향후 관심 등록으로 확인된 공고를 제외해요. 인재풀에는 현재 채용 중인 특정 포지션이 없을 수 있습니다.</p></div>
      <div className="field-group"><label>근무 형태</label><div className="filter-options">{Object.entries(MODE_LABELS).map(([value, label]) => <button key={value} className={draft.workMode === value ? 'selected' : ''} aria-pressed={draft.workMode === value} onClick={() => update('workMode', value as Filters['workMode'])}>{label}</button>)}</div></div>
      <div className="form-grid preference-grid">
        <div className="field-group"><label htmlFor="filter-visa">비자 지원</label><select id="filter-visa" value={draft.visa} onChange={event => update('visa', event.target.value as Filters['visa'])}>{Object.entries(VISA_FILTER_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></div>
        <div className="field-group"><label htmlFor="filter-employment">고용 형태</label><select id="filter-employment" value={draft.employment} onChange={event => update('employment', event.target.value as Filters['employment'])}>{Object.entries(EMPLOYMENT_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></div>
      </div>
      {draft.visa !== 'all' && <p className="inline-note">{draft.visa === 'yes' ? '지원 문구가 있고 별도 제한 조건이 감지되지 않은 공고만 포함해요. 국가·직무별 조건부 지원과 미확인 공고는 제외됩니다.' : draft.visa === 'supported' ? '지원 문구가 있는 공고를 보여줘요. 지원하는 국가·직무·지원자별 조건은 원문에서 확인해야 합니다.' : '비자 지원 불가로 명시된 공고만 제외해요. 조건부·미확인 공고는 개별 확인이 필요합니다.'} 비자 지원 표시만으로 국적·취업 허가 등 다른 요건을 충족한 것은 아닙니다.</p>}
      <div className="salary-field">
        <label htmlFor="filter-salary">희망 연봉 <strong>{draft.salaryMin ? `$${draft.salaryMin / 1000}k 이상` : '제한 없음'}</strong></label>
        <input id="filter-salary" type="range" min={0} max={250000} step={10000} value={draft.salaryMin} onChange={event => update('salaryMin', Number(event.target.value))} />
        <div className="range-labels"><span>제한 없음</span><span>$250k</span></div>
        <p className="field-description">세전 연간 보상 · 표시 범위의 상한이 희망 금액 이상인 공고를 보여줘요. 고정 환율로 USD 환산하며 실제 제안 금액은 다를 수 있어요.</p>
      </div>
      <Toggle checked={draft.includeUnknownSalary} onChange={value => update('includeUnknownSalary', value)} label="연봉 미공개·별도 보상 공고도 포함" description="지역별 구간이나 다른 지급 기간 때문에 연봉을 함께 비교할 수 없는 공고도 찾아요." />
      <Toggle checked={draft.remoteEligibleOnly} onChange={value => update('remoteEligibleOnly', value)} label="거주 국가가 포함된 원격근무만" description="명시된 근무 지역과 거주 국가를 비교해요. 취업 허가나 주별 제한까지 확인한 결과는 아닙니다." />
    </div>
    {current?.error && <p className="inline-note" role="alert">{current.error}<button className="text-button" onClick={refresh}>다시 계산</button></p>}
    <footer className="dialog-footer"><button className="text-button muted" onClick={() => setDraft({ ...DEFAULT_FILTERS, query: filters.query, region: filters.region })}><RotateCcw size={15} />조건 초기화</button><button className="button primary" disabled={counting || Boolean(current?.error)} aria-busy={counting} onClick={() => onApply(draft)}><SlidersHorizontal size={16} />{counting ? '공고 수 계산 중' : current?.error ? '공고 수 확인 필요' : `${current?.count}개 공고 보기`}<ArrowRight size={16} /></button></footer>
  </Dialog>
}
