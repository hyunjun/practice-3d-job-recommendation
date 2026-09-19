import { ArrowUpRight, CheckCircle2, ChevronDown, CircleHelp, Database, Globe2, RefreshCw, ShieldCheck } from 'lucide-react'
import { catalogNeedsAttention, collectionHealth, formatCollectionTime, formatRetryWait } from '../../shared/catalog-health'
import type { Catalog, Source } from '../../shared/types'
import { JOB_SOURCE_LABELS, PUBLIC_PROVIDERS } from '../../shared/types'
import { useRetryCountdown } from '../hooks/useRetryCountdown'
import { CompanyLogo, Dialog, Spinner } from './ui'

export function DataDialog({ catalog, loading, error, retryAt, onSource, onRefresh, onClose }: { catalog: Catalog; loading: boolean; error: string; retryAt?: string; onSource: (source: Source) => void; onRefresh: () => void; onClose: () => void }) {
  const isSample = catalog.source === 'sample'
  const ready = Boolean(catalog.fetchedAt)
  const health = collectionHealth(catalog)
  const retryIn = useRetryCountdown(retryAt)
  const providers = PUBLIC_PROVIDERS.map(provider => ({
    provider, count: catalog.companies.filter(company => (company.provider ?? 'greenhouse') === provider).length,
  })).filter(item => item.count)
  return <Dialog title="기회의 지도, 그 안의 데이터." eyebrow="TRANSPARENT BY DESIGN" onClose={onClose} className="data-dialog">
    <div className="dialog-body">
      <div className="data-source-options">
        <button className={isSample ? 'selected' : ''} aria-pressed={isSample} onClick={() => onSource('sample')}><span className="data-option-icon"><Globe2 size={21} /></span><strong>샘플로 탐색</strong><span>설정 없이 전체 경험을 체험해요</span><small>가상의 공고 · 실제 회사 채용 페이지</small>{isSample && <CheckCircle2 size={16} className="data-option-check" />}</button>
        <button disabled={loading || retryIn > 0} className={!isSample ? 'selected' : ''} aria-pressed={!isSample} onClick={() => onSource('public')}><span className="data-option-icon"><Database size={21} /></span><strong>공개 채용공고</strong><span>회사의 공개 게시판을 함께 조회해요</span><small>API 키 없이 · 인터넷 연결 필요</small>{!isSample && <CheckCircle2 size={16} className="data-option-check" />}</button>
      </div>
      {!isSample && <ul className="provider-coverage" aria-label="공개 공고 출처">{providers.map(item => <li key={item.provider}><strong>{JOB_SOURCE_LABELS[item.provider]}</strong><span>{item.count}개 회사</span></li>)}</ul>}
      {loading && <div className="data-loading"><Spinner label="회사별 공개 채용공고를 가져오고 있어요…" /></div>}
      {error && <p className="form-error" role="alert">{error}</p>}
      {retryIn > 0 && <p className="retry-note">다음 조회 가능 시각: <time dateTime={retryAt}>{formatCollectionTime(retryAt)}</time>. 게시판별 대기 시간을 지키며 다시 확인해요.</p>}
      {!isSample && !ready && !loading && <button className="button secondary" disabled={retryIn > 0} onClick={onRefresh}><RefreshCw size={14} />공개 공고 다시 조회{retryIn > 0 && <span aria-hidden="true"> · {formatRetryWait(retryIn)} 후</span>}</button>}
      <div className="coverage-stats"><div><strong>{catalog.cities.length}</strong><span>제공 도시</span></div><div><strong>{catalog.companies.length}</strong><span>대상 회사</span></div><div><strong>{ready ? catalog.jobs.length.toLocaleString() : '—'}</strong><span>{isSample ? '샘플 공고' : '조회된 개발 공고'}</span></div></div>
      {!isSample && ready && <>
        <dl className="collection-health" aria-label="공고 조회 상태 요약">
          <div><dt>최근 조회</dt><dd>{health.recent}<small>개 공고</small></dd></div>
          <div><dt>이전 조회</dt><dd>{health.retained}<small>개 공고</small></dd></div>
          <div><dt>미확인 게시판</dt><dd>{health.unavailable}<small>개</small></dd></div>
        </dl>
        <BoardHistory catalog={catalog} loading={loading} retryIn={retryIn} onRefresh={onRefresh} />
      </>}
      {!isSample && ready && <section className="data-explanation">
        <h3><CheckCircle2 size={16} />수집된 조건 정보</h3>
        <dl className="data-quality-list">
          <div><dt>비자 지원 명시</dt><dd>{catalog.jobs.filter(job => job.visa === 'yes').length}<small>개</small></dd></div>
          <div><dt>조건부 비자 지원</dt><dd>{catalog.jobs.filter(job => job.visa === 'conditional').length}<small>개</small></dd></div>
          <div><dt>근무 형태 확인</dt><dd>{catalog.jobs.filter(job => job.workMode !== 'unknown').length}<small> / {catalog.jobs.length}개</small></dd></div>
          <div><dt>고용 형태 확인</dt><dd>{catalog.jobs.filter(job => job.employment !== 'unknown').length}<small> / {catalog.jobs.length}개</small></dd></div>
          <div><dt>비교 가능한 연봉</dt><dd>{catalog.jobs.filter(job => job.salary).length}<small> / {catalog.jobs.length}개</small></dd></div>
          <div><dt>보상 조건 확인 필요</dt><dd>{catalog.jobs.filter(job => !job.salary && (job.compensationRanges?.length || job.compensationNote)).length}<small>개</small></dd></div>
          <div><dt>자격 항목의 기술</dt><dd>{catalog.jobs.filter(job => job.qualifications?.skills.some(rule => rule.kind === 'required' || rule.kind === 'qualification')).length}<small> / {catalog.jobs.length}개</small></dd></div>
          <div><dt>경력 조건의 원문</dt><dd>{catalog.jobs.filter(job => job.qualifications?.experience.length).length}<small> / {catalog.jobs.length}개</small></dd></div>
          <div><dt>취업 자격 조건의 원문</dt><dd>{catalog.jobs.filter(job => job.eligibility?.rules.length).length}<small> / {catalog.jobs.length}개</small></dd></div>
        </dl>
        <p>전체 조회 공고 기준입니다. 조건부 지원과 미확인을 구분하며, 공고 상세에서 판단에 사용한 원문을 확인할 수 있어요. 원격근무 지역과 취업 허가·국적·보안 인가는 별도로 확인해야 합니다. 원문을 찾지 못한 항목이 제한 없는 조건을 뜻하지는 않습니다.</p>
      </section>}
      <section className="data-explanation"><h3><CircleHelp size={16} />도시의 숫자는 무엇을 뜻하나요?</h3><p>내 경력과 현재 조건에 맞는 공고가 1개 이상 있는 <strong>회사 수</strong>예요. 같은 회사의 여러 공고는 한 곳으로 세고, 여러 도시에서 채용하는 회사는 각 도시에 표시합니다. 전체 회사 수에서는 중복을 제거해요.</p><p>멀리서 볼 때는 가까운 도시를 묶고, 그 안의 회사도 중복을 제거해 표시해요. 묶음을 선택하면 확대해서 도시별 결과를 볼 수 있어요.</p><p>원격근무 공고는 본사 위치에 표시하지 않고 별도로 보여줘요. 지도에 표시가 없는 지역에는 데이터가 없을 수도 있습니다.</p></section>
      <section className="data-explanation"><h3><Globe2 size={16} />현재 제공하는 지역</h3><div className="coverage-city-list">{catalog.cities.map(city => <span key={city.id}>{city.name}</span>)}</div><p>{isSample ? '샘플의 채용 여부, 보상, 비자 조건은 모두 체험을 위한 예시입니다. 실제 지원 전 회사 채용 페이지를 확인해 주세요.' : ready ? catalog.unmappedCount === null ? '일부 이전 조회 결과는 지도에서 제외된 공고 수를 확인할 수 없어요. 정상 조회 후 집계를 갱신합니다.' : `${catalog.unmappedCount}개 개발 공고는 근무지가 제공 범위 밖이거나 위치를 확정할 수 없어 지도에 포함하지 않았어요.` : '공개 공고를 조회하면 제공 지역의 채용 정보와 수집 범위를 확인할 수 있어요.'}</p></section>
      <section className="data-explanation"><h3><ShieldCheck size={16} />추천과 개인정보</h3><p>기술 키워드, 희망 직무, 경력 연수를 기준으로 공고를 정렬해요. 비자는 지원 명시·조건부·지원 없음·미확인을 구분하고, 발급 가능성을 보장하지 않아요. 풀타임은 근무 시간, 기간 제한 없음은 공고에 명시된 계약 기간 분류입니다. 지역·경력별 보상 구간은 상세에서 따로 확인할 수 있어요. 하나의 연봉으로 비교할 수 없는 금액은 연봉 집계에서 제외합니다.</p><p>연봉 비교에는 고정 참고 환율을 사용하며 생활비나 합격 확률을 추정하지 않아요. 이력서 파일과 원문은 서버나 외부 AI로 전송하지 않아요. 기억하기를 선택하면 확인한 프로필을 이 브라우저에 저장합니다. 프로필 화면에서 언제든 삭제할 수 있어요.</p><p>데이터 모드·검색 조건·선택 도시·지도 보기는 다시 방문할 때 이어집니다. 프로필 기억하기를 끄거나 프로필을 삭제하면 개인 탐색 조건도 지워지고, 데이터 모드와 표시 설정만 유지돼요.</p></section>
    </div>
  </Dialog>
}

function BoardHistory({ catalog, loading, retryIn, onRefresh }: { catalog: Catalog; loading: boolean; retryIn: number; onRefresh: () => void }) {
  return <section className="board-section">
    <div className="board-heading"><h3>게시판 조회 상태</h3><button className="text-button" disabled={loading || retryIn > 0} onClick={onRefresh}><RefreshCw size={13} />새로고침{retryIn > 0 && <span aria-hidden="true"> · {formatRetryWait(retryIn)} 후</span>}</button></div>
    <p className="field-description">최근 조회 시도 · {formatCollectionTime(catalog.checkedAt ?? catalog.fetchedAt)}<br />정상 결과는 30분간 사용해요. 연결 실패 시 마지막 정상 조회로부터 24시간 이내의 결과를 원래 조회 시각과 함께 유지합니다.</p>
    <details className="board-details" open={catalogNeedsAttention(catalog)}>
      <summary>회사별 조회 기록<ChevronDown size={14} /></summary>
      <div className="board-list">{catalog.boards.map(board => {
        const company = catalog.companies.find(item => item.id === board.companyId)
        if (!company) return null
        const lastSuccess = board.lastSuccessAt ?? (board.status === 'ok' ? catalog.fetchedAt : undefined)
        const retained = board.dataStatus === 'stale'
        return <div className="board-row" key={`${board.companyId}-${board.board}`}>
          <CompanyLogo company={company} small />
          <div className="board-copy">
            <div className="board-name"><strong>{company.name}</strong><small>{JOB_SOURCE_LABELS[board.provider ?? company.provider ?? 'greenhouse']}</small><span className={board.status === 'ok' && !retained ? 'board-ok' : 'board-error'}>{retained ? `이전 ${board.included}개 유지` : board.status === 'ok' ? `${board.included}개 반영` : '데이터 미확인'}</span></div>
            <p>마지막 정상 확인 · <time dateTime={lastSuccess ?? undefined}>{formatCollectionTime(lastSuccess)}</time></p>
            {board.status === 'error' && <p className="board-error-detail">재조회 실패{board.message ? ` · ${board.message}` : ''}{board.checkedAt && <span>조회 시도 · {formatCollectionTime(board.checkedAt)}</span>}{board.retryAt && <span><time dateTime={board.retryAt}>{formatCollectionTime(board.retryAt)}</time> 이후 재시도</span>}</p>}
          </div>
          <a href={company.careerUrl} target="_blank" rel="noopener noreferrer" aria-label={`${company.name} 채용 페이지`}><ArrowUpRight size={14} /></a>
        </div>
      })}</div>
    </details>
  </section>
}
