import { useMemo, useState } from 'react'
import { ArrowRight, ArrowUpRight, Bookmark, BookmarkCheck, CheckCircle2, Download, GitCompareArrows, MapPin, Plus, RefreshCw, Search, Trash2, X } from 'lucide-react'
import { CITY_BY_ID } from '../../shared/cities'
import { formatJobSalary, groupCompanies, matchJob, medianSalary } from '../../shared/matching'
import { MODE_LABELS } from '../../shared/types'
import { catalogNeedsAttention, formatRetryWait } from '../../shared/catalog-health'
import type { Catalog, CityResult, MatchedJob, Profile, SavedJob } from '../../shared/types'
import { exportSavedCsv } from '../lib/storage'
import { CityImage, CompanyLogo, EmptyState } from './ui'
import { JobFreshnessNotice } from './JobFreshnessNotice'
import { SavedPostingNotice } from './SavedPostingNotice'
import type { PostingStatusController } from '../hooks/usePostingStatus'
import { EligibilityNotice } from './JobEligibilityDetails'
import { jobRoleLabel } from '../../shared/job-roles'
import { JobOccupationNotice } from './JobRoleDetails'
import type { SavedJobsController } from '../hooks/useSavedJobs'
import { SavedStorageNotice } from './SavedStorageNotice'

export function SavedView({ saved, storage, showStorageStatus, onManage, profile, postingStatus, onOpen, onRemove, onExplore }: { saved: SavedJob[]; storage: SavedJobsController; showStorageStatus: boolean; onManage: () => void; profile: Profile; postingStatus: PostingStatusController; onOpen: (match: MatchedJob) => void; onRemove: (match: MatchedJob) => void; onExplore: () => void }) {
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState('all')
  const [postingFilter, setPostingFilter] = useState('all')
  const { observations, checked, loading, error, remaining, check } = postingStatus
  const publicCount = saved.filter(item => item.job.source !== 'sample').length
  const counts = [...observations.values()].reduce((result, observation) => {
    if (observation.state === 'listed') result.listed++
    if (observation.changedFields?.length) result.changed++
    if (observation.state === 'missing') result.missing++
    if (observation.state === 'unknown' || observation.state === 'unchecked') result.unknown++
    return result
  }, { listed: 0, changed: 0, missing: 0, unknown: 0 })
  const matches = useMemo(() => saved.filter(item => {
    const observation = observations.get(item.job.id)
    const postingMatches = !publicCount || postingFilter === 'all'
      || (postingFilter === 'changed' ? Boolean(observation?.changedFields?.length)
        : postingFilter === 'unknown' ? observation?.state === 'unknown' || observation?.state === 'unchecked'
          : observation?.state === postingFilter)
    return postingMatches && (status === 'all' || item.status === status)
      && `${item.company.name} ${item.job.title} ${jobRoleLabel(item.job)} ${item.job.locationLabel} ${item.note}`.toLowerCase().includes(query.toLowerCase())
  }), [saved, status, query, postingFilter, observations, publicCount])
  return <main id="main-content" className="collection-page" tabIndex={-1}>
    <div className="page-heading"><div><p className="eyebrow">YOUR COLLECTION OF POSSIBILITIES</p><h1>가능성을 모아두는 곳<span className="accent-dot">.</span></h1><p>마음이 움직인 기회들. 이제 하나씩 다음 단계로 이어가 보세요.</p></div><div className="collection-file-actions"><button className="button secondary" onClick={onManage}>기록 백업·복원</button><button className="button secondary" disabled={!saved.length} onClick={() => exportSavedCsv(saved, observations)}><Download size={16} />CSV 내보내기</button></div></div>
    {showStorageStatus && <SavedStorageNotice storage={storage} onManage={onManage} />}
    {publicCount > 0 && <section className="posting-toolbar" aria-labelledby="posting-status-title">
      <div className="posting-toolbar-top"><div><h2 id="posting-status-title">저장한 공고, 지금도 게시 중일까요?</h2><p>공개 공고 {publicCount}개의 게시 여부와 저장 내용의 차이를 확인해 보세요. 메모와 지원 기록은 그대로 보관돼요.</p></div><div className="posting-refresh"><button className="button secondary" disabled={loading || remaining > 0} onClick={() => void check()}><RefreshCw size={15} className={loading ? 'posting-refreshing' : ''} />{loading ? '게시 상태 확인 중' : checked ? '새로 확인' : '게시 상태 확인'}</button>{remaining > 0 && !loading && <small>{formatRetryWait(remaining)} 후 다시 확인 가능</small>}</div></div>
      <div className="posting-summary" role="status">{loading ? <p>회사별 공개 게시판을 확인하고 있어요.</p> : error ? <p>{error}</p> : checked ? <p><span>게시 확인 <strong>{counts.listed}</strong></span><span>내용 차이 <strong>{counts.changed}</strong></span><span>목록에서 미확인 <strong>{counts.missing}</strong></span><span>확인 필요 <strong>{counts.unknown}</strong></span></p> : <p>직접 확인할 때만 조회해요. 저장한 공고·메모·프로필은 전송하지 않습니다.</p>}</div>
      <div className="posting-toolbar-bottom"><p>공개 목록에서 찾지 못해도 채용 종료가 확정되는 것은 아니에요. 내용 차이는 원문 변경이나 정보 해석 방식에 따라 생길 수 있어요.</p><label className="posting-filter">게시 상태<select value={postingFilter} onChange={event => setPostingFilter(event.target.value)}><option value="all">전체 게시 상태</option><option value="listed">게시 확인</option><option value="changed">저장 내용과 차이</option><option value="missing">공개 목록에서 미확인</option><option value="unknown">확인 필요 · 미조회</option></select></label></div>
    </section>}
    {storage.ready && <div className="collection-toolbar"><div className="collection-tabs">{[['all', '전체', saved.length], ['saved', '검토 중', saved.filter(item => item.status === 'saved').length], ['applied', '지원 완료', saved.filter(item => item.status === 'applied').length]].map(([value, label, count]) => <button key={value} className={status === value ? 'active' : ''} onClick={() => setStatus(String(value))}>{label}<span>{count}</span></button>)}</div><label className="collection-search"><Search size={16} /><input aria-label="저장한 기회 검색" placeholder="저장한 기회 검색" value={query} onChange={event => setQuery(event.target.value)} /></label></div>}
    {storage.ready && (matches.length ? <div className="saved-grid">{matches.map(item => {
      const match = { job: item.job, company: item.company, ...matchJob(item.job, profile) }
      return <article className="saved-card" key={item.job.id}>
        <header><CompanyLogo company={item.company} /><div><h2>{item.company.name}</h2><span>{item.company.industry}</span></div><button className="icon-button" aria-label={`${item.company.name} 저장 취소`} onClick={() => onRemove(match)}><BookmarkCheck size={18} /></button></header>
        <button className="saved-title" onClick={() => onOpen(match)}>{item.job.title}<ArrowUpRight size={17} /></button>
        {item.job.source !== 'sample' && <p className="saved-role">{jobRoleLabel(item.job)}</p>}
        <p className="saved-location"><MapPin size={13} />{item.job.locationLabel}</p>
        <div className="saved-card-tags"><span>{formatJobSalary(item.job)}</span><span>{MODE_LABELS[item.job.workMode]}</span>{item.job.source === 'sample' && <span className="sample-label">샘플</span>}</div>
        <JobFreshnessNotice job={item.job} compact />
        <SavedPostingNotice observation={observations.get(item.job.id)} job={item.job} compact />
        <JobOccupationNotice job={item.job} compact />
        <EligibilityNotice job={item.job} />
        <div className="saved-card-match"><CheckCircle2 size={13} />{match.skillSummary}</div>
        {item.note && <p className="saved-note-preview">{item.note}</p>}
        <footer><span className={`saved-status ${item.status === 'applied' ? 'applied' : ''}`}><span />{item.status === 'applied' ? '지원 완료' : '검토 중'}</span><span>{new Date(item.savedAt).toLocaleDateString('ko-KR')} 저장</span><button className="text-button" onClick={() => onOpen(match)}>자세히<ArrowRight size={13} /></button></footer>
      </article>
    })}</div> : <EmptyState icon={<Bookmark size={31} />} title={saved.length ? '검색에 맞는 저장한 기회가 없어요' : '다음 챕터의 첫 기회를 저장해 보세요'} text={saved.length ? '다른 검색어나 상태를 선택해 보세요.' : '도시에서 관심 있는 회사를 발견하면 북마크를 눌러주세요. 공고와 메모를 이곳에서 이어서 볼 수 있어요.'}><button className="button primary" onClick={onExplore}>기회 탐색하기<ArrowRight size={16} /></button></EmptyState>)}
    <p className="collection-footnote">저장한 공고와 메모는 이 브라우저에 보관돼요. 공개 공고의 채용 상태는 원문에서 다시 확인해 주세요.</p>
  </main>
}

export function CompareView({ catalog, results, compareIds, status, onToggle, onAuto, onSelect, onExplore }: { catalog: Catalog; results: CityResult[]; compareIds: string[]; status?: React.ReactNode; onToggle: (id: string) => void; onAuto: () => void; onSelect: (id: string) => void; onExplore: () => void }) {
  const selected = compareIds.flatMap(id => {
    const city = CITY_BY_ID.get(id)
    return city ? [{ city, result: results.find(result => result.city.id === id) }] : []
  })
  const available = results.filter(result => !compareIds.includes(result.city.id))
  const metricRows = [
    { label: '추천 회사', note: '조건에 맞는 공고가 있는 회사', render: (result?: CityResult) => <strong className="metric-primary">{result?.companyCount ?? 0}<small>곳</small></strong> },
    { label: '관련 채용공고', note: '현재 검색 조건 기준', render: (result?: CityResult) => <strong>{result?.matches.length ?? 0}<small>개</small></strong> },
    { label: '공고 조회 상태', note: '이전 결과는 원문 확인 필요', render: (result?: CityResult) => {
      if (catalog.source === 'sample') return <small>체험용 샘플 공고</small>
      const retained = result?.matches.filter(match => match.job.stale).length ?? 0
      return <><strong>{(result?.matches.length ?? 0) - retained}<small>개 최근 조회</small></strong><small>{retained}개 이전 조회 공고 포함</small></>
    } },
    { label: '공개 연봉의 중앙값', note: '세전 연간 USD · 고정 참고 환율', render: (result?: CityResult) => {
      const median = result ? medianSalary(result.matches) : null
      const count = result?.matches.filter(match => match.job.salary).length ?? 0
      return <><strong>{median === null ? '미확인' : `$${Math.round(median / 1000)}k`}</strong><small>{count ? `연봉 공개 ${count}개 공고 기준` : '비교 가능한 연봉 데이터 없음'}</small></>
    } },
    { label: '비자 지원 명시', note: '조건부 지원을 포함한 공고', render: (result?: CityResult) => <><strong>{result?.matches.filter(match => ['yes', 'conditional'].includes(match.job.visa)).length ?? 0}<small>개 공고</small></strong><small>이 중 조건부 {result?.matches.filter(match => match.job.visa === 'conditional').length ?? 0}개 · 미확인 {result?.matches.filter(match => match.job.visa === 'unknown').length ?? 0}개</small></> },
    { label: '하이브리드 근무', note: '미확인 근무 형태는 제외', render: (result?: CityResult) => <><strong>{result?.matches.filter(match => match.job.workMode === 'hybrid').length ?? 0}<small>개 공고</small></strong><small>근무 형태 미확인 {result?.matches.filter(match => match.job.workMode === 'unknown').length ?? 0}개</small></> },
    { label: '나와 연결되는 기술', note: '프로필과 공고에 공통으로 있는 기술', render: (result?: CityResult) => <div className="compare-skills">{[...new Set(result?.matches.flatMap(match => match.matchedSkills) ?? [])].slice(0, 5).map(skill => <span className="skill-tag matched" key={skill}>{skill}</span>)}{!result && <small>해당 조건의 공고 없음</small>}</div> },
    { label: '만나볼 회사', note: '기술·경력 일치 기준 정렬', render: (result?: CityResult) => <div className="compare-companies">{result ? groupCompanies(result.matches).slice(0, 3).map(group => <span key={group.company.id}><CompanyLogo company={group.company} small />{group.company.name}</span>) : <small>추천 회사 없음</small>}</div> },
  ]
  return <main id="main-content" className="collection-page compare-page" tabIndex={-1}>
    <div className="page-heading"><div><p className="eyebrow">DIFFERENT CITIES. YOUR POSSIBILITIES.</p><h1>어느 도시에서 시작할까요<span className="accent-dot">?</span></h1><p>최대 3개 도시를 나란히 놓고, 중요한 조건을 비교해 보세요.</p></div><button className="button secondary" onClick={onAuto} disabled={!results.length}><GitCompareArrows size={16} />회사 많은 3개 도시</button></div>
    <div className="comparison-source-note"><span className={`source-status-dot ${catalog.source === 'sample' ? 'sample' : catalogNeedsAttention(catalog) ? 'attention' : ''}`} />{catalog.source === 'sample' ? '샘플 시나리오로 비교 중 · 보상 및 채용 조건은 예시입니다.' : '조회한 공개 채용공고의 비교 · 생활비와 세금은 반영하지 않습니다.'}</div>
    {status}
    {selected.length > 0 ? <div className="comparison-scroll"><div className="comparison-table" role="table" aria-label="도시별 채용 조건 비교" style={{ '--city-columns': 3 } as React.CSSProperties}>
      <div className="comparison-row" role="row">
      <div className="comparison-corner" role="columnheader"><GitCompareArrows size={21} /><strong>나의 다음 도시</strong><span>현재 프로필과 필터 기준</span></div>
      {[0, 1, 2].map(index => {
        const item = selected[index]
        return item ? <div key={item.city.id} className="comparison-city" role="columnheader"><CityImage city={item.city} /><button className="comparison-remove icon-button" aria-label={`${item.city.name} 비교에서 제거`} onClick={() => onToggle(item.city.id)}><X size={16} /></button><div className="comparison-city-name"><span>{item.city.country}</span><h2>{item.city.name}</h2><p>{item.city.en}</p></div></div> : <div className="comparison-placeholder" role="columnheader" key={`empty-${index}`}><Plus size={23} /><label htmlFor={`compare-city-${index}`}>다른 도시 추가</label><select id={`compare-city-${index}`} value="" onChange={event => { if (event.target.value) onToggle(event.target.value) }}><option value="">도시 선택</option>{available.map(result => <option key={result.city.id} value={result.city.id}>{result.city.name} · {result.companyCount}개 회사</option>)}</select></div>
      })}
      </div>
      {metricRows.map(row => <ComparisonRow key={row.label} label={row.label} note={row.note}>{[0, 1, 2].map(index => <div className="comparison-value" role="cell" key={index}>{selected[index] ? row.render(selected[index].result) : <span className="empty-dash">—</span>}</div>)}</ComparisonRow>)}
      <div className="comparison-row" role="row"><div className="comparison-row-label" role="rowheader"><span>다음 기회로</span></div>{[0, 1, 2].map(index => <div className="comparison-value" role="cell" key={`action-${index}`}>{selected[index] && <button className="button secondary" onClick={() => onSelect(selected[index].city.id)}>회사 살펴보기<ArrowRight size={14} /></button>}</div>)}</div>
    </div></div> : <div className="compare-empty"><div className="compare-empty-cards">{results.slice(0, 3).map(result => <button key={result.city.id} onClick={() => onToggle(result.city.id)}><CityImage city={result.city} /><span><strong>{result.city.name}</strong><small>{result.companyCount}개 추천 회사</small></span><Plus size={19} /></button>)}</div><EmptyState icon={<GitCompareArrows size={30} />} title="궁금한 도시를 비교에 추가해 보세요" text="도시 목록의 + 버튼을 누르거나, 위 도시 중 하나를 선택하세요."><button className="button primary" onClick={onExplore}>도시 탐색하기<ArrowRight size={16} /></button></EmptyState></div>}
    {compareIds.length > 0 && <div className="compare-bottom"><p>공고 수가 많다고 더 적합한 도시는 아니에요. 지원 조건과 실제 근무 환경을 함께 살펴보세요.</p><button className="text-button muted" onClick={() => compareIds.forEach(onToggle)}><Trash2 size={13} />비교 비우기</button></div>}
  </main>
}

function ComparisonRow({ label, note, children }: { label: string; note: string; children: React.ReactNode }) {
  return <div className="comparison-row" role="row"><div className="comparison-row-label" role="rowheader"><strong>{label}</strong><small>{note}</small></div>{children}</div>
}
