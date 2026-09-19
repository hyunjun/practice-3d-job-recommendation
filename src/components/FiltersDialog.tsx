import { useMemo, useState } from 'react'
import { ArrowRight, RotateCcw, SlidersHorizontal } from 'lucide-react'
import { filterJobs } from '../../shared/matching'
import { DEFAULT_FILTERS, EMPLOYMENT_LABELS, MODE_LABELS, ROLE_LABELS, VISA_FILTER_LABELS } from '../../shared/types'
import type { Catalog, Filters, Profile } from '../../shared/types'
import { Dialog, Toggle } from './ui'

export function FiltersDialog({ filters, catalog, profile, onApply, onClose }: { filters: Filters; catalog: Catalog; profile: Profile; onApply: (filters: Filters) => void; onClose: () => void }) {
  const [draft, setDraft] = useState(filters)
  const matches = useMemo(() => filterJobs(catalog, profile, draft), [catalog, profile, draft])
  const update = <K extends keyof Filters>(key: K, value: Filters[K]) => setDraft(previous => ({ ...previous, [key]: value }))
  return <Dialog title="내게 중요한 조건으로." eyebrow="REFINE YOUR ORBIT" onClose={onClose} className="filters-dialog">
    <div className="dialog-body">
      <p className="dialog-intro">경험과 맞는 기회 중, 원하는 조건을 더해보세요.</p>
      <div className="field-group"><label htmlFor="filter-role">직무</label><select id="filter-role" value={draft.role} onChange={event => update('role', event.target.value as Filters['role'])}>{Object.entries(ROLE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></div>
      <div className="field-group"><label>근무 형태</label><div className="filter-options">{Object.entries(MODE_LABELS).map(([value, label]) => <button key={value} className={draft.workMode === value ? 'selected' : ''} aria-pressed={draft.workMode === value} onClick={() => update('workMode', value as Filters['workMode'])}>{label}</button>)}</div></div>
      <div className="form-grid preference-grid">
        <div className="field-group"><label htmlFor="filter-visa">비자 지원</label><select id="filter-visa" value={draft.visa} onChange={event => update('visa', event.target.value as Filters['visa'])}>{Object.entries(VISA_FILTER_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></div>
        <div className="field-group"><label htmlFor="filter-employment">고용 형태</label><select id="filter-employment" value={draft.employment} onChange={event => update('employment', event.target.value as Filters['employment'])}>{Object.entries(EMPLOYMENT_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></div>
      </div>
      {draft.visa !== 'all' && <p className="inline-note">{draft.visa === 'yes' ? '지원 문구가 있고 별도 제한 조건이 감지되지 않은 공고만 포함해요. 조건부·미확인 공고는 제외됩니다.' : draft.visa === 'supported' ? '지원 문구가 있는 공고를 보여줘요. 조건부 지원은 별도로 표시하며, 직무·지원자별 조건을 원문에서 확인할 수 있어요.' : '지원 불가 공고만 제외해요. 조건부·미확인 공고는 개별 확인이 필요합니다.'}</p>}
      <div className="salary-field">
        <label htmlFor="filter-salary">희망 연봉 <strong>{draft.salaryMin ? `$${draft.salaryMin / 1000}k 이상` : '제한 없음'}</strong></label>
        <input id="filter-salary" type="range" min={0} max={250000} step={10000} value={draft.salaryMin} onChange={event => update('salaryMin', Number(event.target.value))} />
        <div className="range-labels"><span>제한 없음</span><span>$250k</span></div>
        <p className="field-description">세전 연간 보상 · 표시 범위의 상한이 희망 금액 이상인 공고를 보여줘요. 고정 환율로 USD 환산하며 실제 제안 금액은 다를 수 있어요.</p>
      </div>
      <Toggle checked={draft.includeUnknownSalary} onChange={value => update('includeUnknownSalary', value)} label="연봉 미공개 공고도 포함" description="보상이 공개되지 않아도 다른 조건에 맞는 기회를 찾아요." />
      <Toggle checked={draft.remoteEligibleOnly} onChange={value => update('remoteEligibleOnly', value)} label="거주 국가에서 가능한 원격근무만" description="프로필의 거주 국가를 기준으로, 지원 지역이 확인된 공고만 포함해요." />
    </div>
    <footer className="dialog-footer"><button className="text-button muted" onClick={() => setDraft({ ...DEFAULT_FILTERS, query: filters.query, region: filters.region })}><RotateCcw size={15} />조건 초기화</button><button className="button primary" onClick={() => onApply(draft)}><SlidersHorizontal size={16} />{matches.length}개 공고 보기<ArrowRight size={16} /></button></footer>
  </Dialog>
}
