import { useId } from 'react'
import { ArrowRight, CircleHelp, SearchX, SlidersHorizontal } from 'lucide-react'
import { describeRecoveryChanges } from '../../shared/search-recovery'
import type { RecoveryAnalysis, RecoverySuggestion } from '../../shared/search-recovery'
import type { SearchScope } from '../../shared/job-search'
import type { Filters } from '../../shared/types'

interface Props {
  analysis: RecoveryAnalysis | null
  filters: Filters
  scope: SearchScope
  sample: boolean
  onApply: (suggestion: RecoverySuggestion) => void
  onNavigate: (scope: SearchScope) => void
  onFilters: () => void
  onProfile: () => void
  onData: () => void
}

export function SearchRecovery({ analysis, filters, scope, sample, onApply, onNavigate, onFilters, onProfile, onData }: Props) {
  const id = useId()
  if (!analysis) return null
  return <section className="search-recovery" aria-labelledby={`${id}-title`}>
    <SearchX size={25} className="recovery-icon" />
    <h3 id={`${id}-title`}>{scope.kind === 'city' ? '이 도시에서 맞는 공고를 찾지 못했어요' : scope.kind === 'remote'
      ? '지금 조건에 맞는 원격 기회가 없어요' : '조건에 맞는 도시가 아직 없어요'}</h3>
    <p>{analysis.available
      ? `이 탐색 범위에서 조회한 ${analysis.available}개 공고에 현재 조건을 적용한 결과예요.`
      : '현재 불러온 자료에는 이 탐색 범위의 공고가 없어요. 수집되지 않은 채용 기회도 있을 수 있습니다.'}</p>
    {analysis.alternatives.length > 0 && <div className="recovery-alternatives">
      <h4>조건을 그대로 유지하고</h4>
      {analysis.alternatives.map(alternative => <button key={alternative.scope.kind} onClick={() => onNavigate(alternative.scope)}>
        <span><strong>{alternative.scope.kind === 'remote' ? '원격 기회 보기' : scope.kind === 'city' ? '다른 도시 보기' : '도시 탐색으로 이동'}</strong>
          <small>회사 {alternative.count.companies}곳 · 공고 {alternative.count.jobs}개{alternative.count.cities > 0 && ` · ${alternative.count.cities}개 도시`}</small></span><ArrowRight size={16} />
      </button>)}
    </div>}
    {analysis.profileExcluded > 0 && <p className="recovery-profile-note"><CircleHelp size={15} /><span>다른 조건을 통과한 {analysis.profileExcluded}개 공고는 입력한 기술과 자격 기술이 겹치지 않아 제외됐어요. 프로필의 기술과 직무를 확인해 보세요.</span></p>}
    {analysis.suggestions.length > 0 && <div className="recovery-suggestions">
      <h4>조건을 바꾼 결과 미리보기</h4>
      <p>아래에 표시한 항목만 바뀌어요. 필요한 조건인지 확인한 뒤 선택해 주세요.</p>
      {analysis.suggestions.map((suggestion, index) => {
        const changes = describeRecoveryChanges(filters, suggestion.changes)
        const optionId = `${id}-option-${index}`
        return <article className="recovery-option" key={suggestion.id} aria-label={`조건 변경안 ${index + 1}`}>
          <div id={optionId}>
            <h5>{changes.length}가지 조건 변경</h5>
            <dl>{changes.map(change => <div key={change.key}>
              <dt>{change.label}</dt>
              <dd><span>{change.before}</span><span aria-hidden="true">→</span><strong>{change.after}</strong></dd>
            </div>)}</dl>
            {suggestion.changes.visa && <p className="recovery-warning">{suggestion.changes.visa === 'all'
              ? '비자 지원이 없다고 명시한 공고도 포함합니다.'
              : suggestion.changes.visa === 'possible' ? '비자 지원이 미확인인 공고도 포함합니다. 지원 없음으로 명시된 공고는 제외해요.'
                : '국가·직무·지원자별 지원 조건을 원문에서 확인해야 합니다.'}</p>}
            {suggestion.changes.remoteEligibleOnly === false && <p className="recovery-warning">다른 국가만 허용하거나 지역이 미확인인 공고도 포함합니다. 선택한 거주 국가에서 근무할 수 있다는 뜻은 아닙니다.</p>}
            {suggestion.changes.includeUnknownSalary && <p className="recovery-warning">미공개·별도 보상은 희망 연봉을 충족하는지 확인되지 않았어요.</p>}
          </div>
          <button onClick={() => onApply(suggestion)} aria-describedby={optionId}>
            <span>회사 <strong>{suggestion.count.companies}</strong>곳 · 공고 <strong>{suggestion.count.jobs}</strong>개 보기</span><ArrowRight size={15} />
          </button>
        </article>
      })}
      <p className="recovery-count-note">{sample ? '샘플 시나리오' : '현재 불러온 대상 게시판 공고'} 기준입니다. 다른 조건과 프로필은 유지하며, 조회 결과가 바뀌면 후보 수도 달라집니다.</p>
    </div>}
    <div className="recovery-actions">
      <button className="button secondary" onClick={onFilters}><SlidersHorizontal size={14} />조건 직접 조정</button>
      {(analysis.profileExcluded > 0 || !analysis.suggestions.length && analysis.available > 0) && <button className="text-button" onClick={onProfile}>내 경력 확인</button>}
      <button className="text-button muted" onClick={onData}>수집 범위 확인<CircleHelp size={13} /></button>
    </div>
  </section>
}
