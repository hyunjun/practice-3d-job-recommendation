import { useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { ArrowLeft, ArrowRight, ArrowUpRight, Bookmark, BookmarkCheck, Check, ChevronDown, CircleHelp, Globe2, MapPin, Plus, SearchX, ShieldCheck, SlidersHorizontal } from 'lucide-react'
import { CITY_BY_ID } from '../../shared/cities'
import { catalogNeedsAttention } from '../../shared/catalog-health'
import { formatJobSalary, groupCompanies, medianSalary } from '../../shared/matching'
import { COUNTRIES, MODE_LABELS, VISA_LABELS } from '../../shared/types'
import type { Catalog, CityResult, MatchedJob, Profile } from '../../shared/types'
import type { ExplorationState } from '../lib/storage'
import { CityImage, CompanyLogo, EmptyState } from './ui'
import { JobFreshnessNotice } from './JobFreshnessNotice'

interface Props {
  catalog: Catalog
  results: CityResult[]
  remote: MatchedJob[]
  selectedId: string | null
  tab: 'cities' | 'remote'
  sort: ExplorationState['citySort']
  status: ReactNode
  profile: Profile
  compareIds: string[]
  savedIds: Set<string>
  onTab: (tab: 'cities' | 'remote') => void
  onSort: (sort: ExplorationState['citySort']) => void
  onSelect: (id: string | null) => void
  onHover: (id: string | null) => void
  onCompare: (id: string) => void
  onOpenJob: (match: MatchedJob) => void
  onSave: (match: MatchedJob) => void
  onProfile: () => void
  onData: () => void
  onFilters: () => void
  onReset: () => void
}

export function CityPanel(props: Props) {
  const { catalog, results, remote, selectedId, tab, sort, status, profile, compareIds, savedIds, onSort, onTab, onSelect, onHover, onCompare, onOpenJob, onSave, onProfile, onData, onFilters, onReset } = props
  const sorted = useMemo(() => [...results].sort((a, b) => sort === 'match' ? b.averageScore - a.averageScore : sort === 'salary' ? (medianSalary(b.matches) ?? -1) - (medianSalary(a.matches) ?? -1) : b.companyCount - a.companyCount || b.averageScore - a.averageScore), [results, sort])
  const selectedResult = results.find(result => result.city.id === selectedId)
  const selectedCity = selectedId ? CITY_BY_ID.get(selectedId) : null
  const remoteCompanies = groupCompanies(remote)

  return <aside className="results-panel" aria-label="도시와 회사 탐색 결과">
    <div className="results-tabs">
      <button className={tab === 'cities' ? 'active' : ''} aria-pressed={tab === 'cities'} onClick={() => onTab('cities')}><MapPin size={15} />도시 탐색<span>{catalog.fetchedAt ? results.length : '—'}</span></button>
      <button className={tab === 'remote' ? 'active' : ''} aria-pressed={tab === 'remote'} onClick={() => onTab('remote')}><Globe2 size={15} />원격 기회<span>{catalog.fetchedAt ? remoteCompanies.length : '—'}</span></button>
    </div>
    <div className="results-scroll">
      {status}
      {catalog.fetchedAt && (tab === 'cities' ? selectedCity ? <>
        <div className="city-detail-hero">
          <CityImage city={selectedCity} />
          <div className="city-hero-shade" />
          <button className="city-back" onClick={() => onSelect(null)}><ArrowLeft size={15} />모든 도시</button>
          <div className="city-hero-caption"><span>{selectedCity.country} · {selectedCity.en}</span><h2>{selectedCity.name}<span className="city-coordinate">{Math.abs(selectedCity.lat).toFixed(2)}°{selectedCity.lat >= 0 ? 'N' : 'S'}</span></h2></div>
        </div>
        <div className="city-detail-summary"><p>{selectedCity.description}</p><div className="city-detail-count"><div><strong>{selectedResult?.companyCount ?? 0}</strong><span>추천 회사</span><span className="count-separator" /><strong>{selectedResult?.matches.length ?? 0}</strong><span>공고</span></div><button className={`compare-add ${compareIds.includes(selectedCity.id) ? 'added' : ''}`} onClick={() => onCompare(selectedCity.id)}>{compareIds.includes(selectedCity.id) ? <Check size={14} /> : <Plus size={14} />}비교</button></div>
          {selectedResult && <div className="city-reason"><SparkleMark /><span>{mostMatchedSkills(selectedResult.matches).slice(0, 2).join(' · ') || '개발'} 경험을 찾는 팀이 있어요.</span></div>}
        </div>
        <div className="company-list">
          {selectedResult ? groupCompanies(selectedResult.matches).map(group => <CompanyCard key={group.company.id} matches={group.matches} savedIds={savedIds} onOpen={onOpenJob} onSave={onSave} />) : <EmptyState icon={<SearchX size={25} />} title="이 도시에서 맞는 공고를 찾지 못했어요" text="다른 도시를 살펴보거나 검색 조건을 조정해 보세요."><button className="button secondary" onClick={onFilters}>조건 조정하기</button></EmptyState>}
        </div>
      </> : <>
        <div className="results-heading"><div><p className="eyebrow">YOUR NEXT DESTINATION</p><h2>가능성이 있는 도시<span className="accent-dot">.</span></h2><p>당신의 경험과 연결되는 팀을 찾아보세요.</p></div></div>
        <div className="list-toolbar"><span><span className="tiny-live-dot" />{results.length}개 도시</span><label className="sort-control"><span className="sr-only">도시 정렬</span><select value={sort} onChange={event => onSort(event.target.value as ExplorationState['citySort'])}><option value="companies">회사 많은 순</option><option value="match">기술 일치 순</option><option value="salary">공개 연봉 순</option></select><ChevronDown size={12} /></label></div>
        {sorted.length ? <div className="city-list">{sorted.map((result, index) => <article key={result.city.id} className="city-row" onPointerEnter={() => onHover(result.city.id)} onPointerLeave={() => onHover(null)}>
          <button className="city-row-main" onClick={() => onSelect(result.city.id)} onFocus={() => onHover(result.city.id)} onBlur={() => onHover(null)} aria-label={`${result.city.name}, 추천 회사 ${result.companyCount}곳 보기`}>
            <div className="city-row-picture"><CityImage city={result.city} /><span className="city-rank">{String(index + 1).padStart(2, '0')}</span></div>
            <div className="city-row-copy"><h3>{result.city.name}</h3><p>{result.city.country}<span>·</span>{result.matches.length}개 공고</p><div className="city-company-preview">{groupCompanies(result.matches).slice(0, 3).map(group => <CompanyLogo key={group.company.id} company={group.company} small />)}<span>{mostMatchedSkills(result.matches)[0] ?? 'Engineering'}</span></div></div>
            <div className="city-row-number"><strong>{result.companyCount}</strong><span>추천 회사</span></div>
            <ArrowUpRight className="city-hover-arrow" size={17} />
          </button>
          <button className={`row-compare ${compareIds.includes(result.city.id) ? 'added' : ''}`} aria-label={`${result.city.name} ${compareIds.includes(result.city.id) ? '비교에서 제거' : '비교에 추가'}`} title="도시 비교" onClick={() => onCompare(result.city.id)}>{compareIds.includes(result.city.id) ? <Check size={12} /> : <Plus size={12} />}</button>
        </article>)}</div> : <EmptyState icon={<SearchX size={27} />} title="조건에 맞는 도시가 아직 없어요" text="검색어를 바꾸거나 직무, 연봉, 비자 조건을 조정해 보세요."><button className="button secondary" onClick={onFilters}><SlidersHorizontal size={15} />조건 조정</button><button className="text-button" onClick={onReset}>검색 조건 초기화</button></EmptyState>}
        <div className="list-bottom-note"><CircleHelp size={14} /><span>숫자는 조건에 맞는 공고가 있는 회사 수예요.<br />기회가 많은 도시와 잘 맞는 도시는 다를 수 있어요.</span></div>
      </> : <>
        <div className="results-heading remote-heading"><span className="remote-illustration"><Globe2 size={30} /><span /></span><p className="eyebrow">A CAREER WITHOUT BORDERS</p><h2>어디서든, 함께<span className="accent-dot">.</span></h2><p>출근할 도시보다 함께할 팀이 중요하다면.</p><button className="residence-button" onClick={onProfile}><MapPin size={13} />{COUNTRIES.find(([id]) => id === profile.residence)?.[1] ?? profile.residence} 거주 기준<ArrowRight size={13} /></button></div>
        <div className="list-toolbar"><span>{remoteCompanies.length}개 회사 · {remote.length}개 공고</span><button className="text-button muted" onClick={onFilters}><SlidersHorizontal size={12} />조건</button></div>
        <div className="company-list">{remoteCompanies.length ? remoteCompanies.map(group => <CompanyCard key={group.company.id} matches={group.matches} savedIds={savedIds} onOpen={onOpenJob} onSave={onSave} />) : <EmptyState icon={<Globe2 size={27} />} title="지금 조건에 맞는 원격 기회가 없어요" text="거주 국가, 직무, 비자 필터를 확인해 주세요. 지원 지역이 미확인인 공고는 기본적으로 제외돼요."><button className="button secondary" onClick={onFilters}>원격 조건 확인</button><button className="text-button" onClick={onProfile}>거주 국가 변경</button></EmptyState>}</div>
      </>)}
    </div>
    <button className="panel-data-footer" onClick={onData}><span className={`source-status-dot ${catalog.source === 'sample' ? 'sample' : catalogNeedsAttention(catalog) ? 'attention' : ''}`} /><span>{catalog.source === 'sample' ? '샘플 데이터로 탐색 중' : !catalog.fetchedAt ? '공개 공고 연결 확인' : catalogNeedsAttention(catalog) ? '일부 게시판 · 조회 상태 확인' : '회사별 공개 채용공고'}</span><CircleHelp size={14} /></button>
  </aside>
}

export function CompanyCard({ matches, savedIds, onOpen, onSave }: { matches: MatchedJob[]; savedIds: Set<string>; onOpen: (match: MatchedJob) => void; onSave: (match: MatchedJob) => void }) {
  const [expanded, setExpanded] = useState(false)
  const company = matches[0].company
  const visible = expanded ? matches : matches.slice(0, 1)
  return <article className="company-card">
    <header><CompanyLogo company={company} /><div><h3>{company.name}</h3><p>{company.industry}</p></div>{matches[0].job.source === 'sample' && <span className="sample-label">샘플</span>}</header>
    {visible.map(match => <div key={match.job.id} className="mini-job">
      <button className="mini-job-title" onClick={() => onOpen(match)}>{match.job.title}<ArrowUpRight size={14} /></button>
      <div className="mini-job-meta"><span>{formatJobSalary(match.job)}</span><span>·</span><span>{MODE_LABELS[match.job.workMode]}</span></div>
      <JobFreshnessNotice job={match.job} compact />
      <div className="mini-job-reason">{match.matchedSkills.length ? <><Check size={12} /><span>{match.matchedSkills.slice(0, 2).join(' · ')} 경험 일치</span></> : <><CircleHelp size={12} /><span>기술 요구사항 확인 필요</span></>}</div>
      <div className="mini-job-footer"><span className={`visa-tag ${match.job.visa === 'yes' ? 'confirmed' : match.job.visa === 'conditional' ? 'conditional' : ''}`}>{match.job.visa === 'yes' ? <ShieldCheck size={12} /> : <CircleHelp size={12} />}비자 {VISA_LABELS[match.job.visa]}</span><button className={`icon-button bookmark-button ${savedIds.has(match.job.id) ? 'is-saved' : ''}`} aria-label={`${company.name} ${match.job.title} ${savedIds.has(match.job.id) ? '저장 취소' : '저장'}`} onClick={() => onSave(match)}>{savedIds.has(match.job.id) ? <BookmarkCheck size={17} /> : <Bookmark size={17} />}</button></div>
    </div>)}
    {matches.length > 1 && <button className="more-jobs" onClick={() => setExpanded(!expanded)}>{expanded ? '공고 접기' : `${matches.length - 1}개 공고 더 보기`}<ChevronDown size={13} className={expanded ? 'rotated' : ''} /></button>}
  </article>
}

function mostMatchedSkills(matches: MatchedJob[]) {
  const skills = new Map<string, number>()
  matches.forEach(match => match.matchedSkills.forEach(skill => skills.set(skill, (skills.get(skill) ?? 0) + 1)))
  return [...skills.entries()].sort((a, b) => b[1] - a[1]).map(([skill]) => skill)
}

function SparkleMark() {
  return <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m8 1 1.7 5.3L15 8l-5.3 1.7L8 15l-1.7-5.3L1 8l5.3-1.7L8 1Z" fill="currentColor" /></svg>
}
