import { ArrowUpRight, CheckCircle2, CircleHelp, Database, Globe2, RefreshCw, ShieldCheck } from 'lucide-react'
import { PUBLIC_COMPANIES } from '../../shared/companies'
import type { Catalog, Source } from '../../shared/types'
import { CompanyLogo, Dialog, Spinner } from './ui'

export function DataDialog({ catalog, loading, error, onSource, onRefresh, onClose }: { catalog: Catalog; loading: boolean; error: string; onSource: (source: Source) => void; onRefresh: () => void; onClose: () => void }) {
  const isSample = catalog.source === 'sample'
  const ready = Boolean(catalog.fetchedAt)
  return <Dialog title="기회의 지도, 그 안의 데이터." eyebrow="TRANSPARENT BY DESIGN" onClose={onClose} className="data-dialog">
    <div className="dialog-body">
      <div className="data-source-options">
        <button className={isSample ? 'selected' : ''} aria-pressed={isSample} onClick={() => onSource('sample')}><span className="data-option-icon"><Globe2 size={21} /></span><strong>샘플로 탐색</strong><span>설정 없이 전체 경험을 체험해요</span><small>가상의 공고 · 실제 회사 채용 페이지</small>{isSample && <CheckCircle2 size={16} className="data-option-check" />}</button>
        <button disabled={loading} className={!isSample ? 'selected' : ''} aria-pressed={!isSample} onClick={() => onSource('greenhouse')}><span className="data-option-icon"><Database size={21} /></span><strong>공개 채용공고</strong><span>Greenhouse 게시판에서 직접 조회해요</span><small>API 키 없이 · 인터넷 연결 필요</small>{!isSample && <CheckCircle2 size={16} className="data-option-check" />}</button>
      </div>
      {loading && <div className="data-loading"><Spinner label="회사별 공개 채용공고를 가져오고 있어요…" /></div>}
      {error && <p className="form-error" role="alert">{error}</p>}
      {!isSample && !ready && !loading && <button className="button secondary" onClick={onRefresh}><RefreshCw size={14} />공개 공고 다시 조회</button>}
      <div className="coverage-stats"><div><strong>{catalog.cities.length}</strong><span>제공 도시</span></div><div><strong>{catalog.companies.length}</strong><span>대상 회사</span></div><div><strong>{ready ? catalog.jobs.length.toLocaleString() : '—'}</strong><span>{isSample ? '샘플 공고' : '조회된 개발 공고'}</span></div></div>
      {!isSample && ready && <section className="data-explanation">
        <h3><CheckCircle2 size={16} />수집된 조건 정보</h3>
        <dl className="data-quality-list">
          <div><dt>비자 지원 명시</dt><dd>{catalog.jobs.filter(job => job.visa === 'yes').length}<small>개</small></dd></div>
          <div><dt>조건부 비자 지원</dt><dd>{catalog.jobs.filter(job => job.visa === 'conditional').length}<small>개</small></dd></div>
          <div><dt>근무 형태 확인</dt><dd>{catalog.jobs.filter(job => job.workMode !== 'unknown').length}<small> / {catalog.jobs.length}개</small></dd></div>
          <div><dt>고용 형태 확인</dt><dd>{catalog.jobs.filter(job => job.employment !== 'unknown').length}<small> / {catalog.jobs.length}개</small></dd></div>
        </dl>
        <p>전체 조회 공고 기준입니다. 조건부 지원과 미확인을 구분하며, 공고 상세에서 판단에 사용한 원문을 확인할 수 있어요.</p>
      </section>}
      <section className="data-explanation"><h3><CircleHelp size={16} />도시의 숫자는 무엇을 뜻하나요?</h3><p>내 경력과 현재 조건에 맞는 공고가 1개 이상 있는 <strong>회사 수</strong>예요. 같은 회사의 여러 공고는 한 곳으로 세고, 여러 도시에서 채용하는 회사는 각 도시에 표시합니다. 전체 회사 수에서는 중복을 제거해요.</p><p>멀리서 볼 때는 가까운 도시를 묶고, 그 안의 회사도 중복을 제거해 표시해요. 묶음을 선택하면 확대해서 도시별 결과를 볼 수 있어요.</p><p>원격근무 공고는 본사 위치에 표시하지 않고 별도로 보여줘요. 지도에 표시가 없는 지역에는 데이터가 없을 수도 있습니다.</p></section>
      <section className="data-explanation"><h3><Globe2 size={16} />현재 제공하는 지역</h3><div className="coverage-city-list">{catalog.cities.map(city => <span key={city.id}>{city.name}</span>)}</div><p>{isSample ? '샘플의 채용 여부, 보상, 비자 조건은 모두 체험을 위한 예시입니다. 실제 지원 전 회사 채용 페이지를 확인해 주세요.' : ready ? `${catalog.unmappedCount}개 개발 공고는 근무지가 제공 범위 밖이거나 위치를 확정할 수 없어 지도에 포함하지 않았어요.` : '공개 공고를 조회하면 제공 지역의 채용 정보와 수집 범위를 확인할 수 있어요.'}</p></section>
      {!isSample && ready && <section className="board-section"><div className="board-heading"><h3>게시판 조회 상태</h3><button className="text-button" disabled={loading} onClick={onRefresh}><RefreshCw size={13} />새로고침</button></div><p className="field-description">{new Date(catalog.fetchedAt).toLocaleString('ko-KR')} 조회 · 30분 캐시{catalog.stale ? ' · 연결 실패로 이전 조회 결과 표시 중' : ''}</p><div className="board-list">{catalog.boards.map(board => {
        const company = PUBLIC_COMPANIES.find(item => item.id === board.companyId)!
        return <div key={board.board}><CompanyLogo company={company} small /><span>{company.name}</span><span className={board.status === 'ok' ? 'board-ok' : 'board-error'}>{board.status === 'ok' ? `${board.included}개 반영` : '연결 실패'}</span><a href={company.careerUrl} target="_blank" rel="noopener noreferrer" aria-label={`${company.name} 채용 페이지`}><ArrowUpRight size={14} /></a></div>
      })}</div></section>}
      <section className="data-explanation"><h3><ShieldCheck size={16} />추천과 개인정보</h3><p>기술 키워드, 희망 직무, 경력 연수를 기준으로 공고를 정렬해요. 비자는 지원 명시·조건부·지원 없음·미확인을 구분하고, 발급 가능성을 보장하지 않아요. 풀타임은 근무 시간 분류이며 정규직 여부를 뜻하지 않습니다. 보상 비교에는 고정 참고 환율을 사용하며, 지역별 생활비나 합격 확률을 추정하지 않아요.</p><p>이력서 파일과 원문은 서버나 외부 AI로 전송하지 않아요. 기억하기를 선택하면 확인한 프로필을 이 브라우저에 저장합니다. 프로필 화면에서 언제든 삭제할 수 있어요.</p><p>데이터 모드·검색 조건·선택 도시·지도 보기는 다시 방문할 때 이어집니다. 프로필 기억하기를 끄거나 프로필을 삭제하면 개인 탐색 조건도 지워지고, 데이터 모드와 표시 설정만 유지돼요.</p></section>
    </div>
  </Dialog>
}
