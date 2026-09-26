import { useMemo } from 'react'
import type { ReactNode } from 'react'
import { ArrowLeft, ArrowRight, ArrowUpRight, Check, ChevronDown, CircleHelp, Globe2, MapPin, MapPinOff, Plus, SlidersHorizontal } from 'lucide-react'
import { CITY_BY_ID } from '../../shared/cities'
import { catalogNeedsAttention } from '../../shared/catalog-health'
import { unmappedCoverage } from '../../shared/job-location'
import { groupCompanies, medianSalary } from '../../shared/matching'
import { COUNTRIES } from '../../shared/types'
import type { Catalog, CityResult, MatchedJob, Profile } from '../../shared/types'
import type { ExplorationState } from '../lib/storage'
import { CityImage, CompanyLogo } from './ui'
import { CompanyCard } from './CompanyCard'

interface Props {
  catalog: Catalog
  results: CityResult[]
  remote: MatchedJob[]
  unmapped: MatchedJob[]
  remoteEligibleOnly: boolean
  selectedId: string | null
  tab: ExplorationState['panelTab']
  sort: ExplorationState['citySort']
  status: ReactNode
  profile: Profile
  compareIds: string[]
  savedIds: Set<string>
  saveReady: boolean
  onTab: (tab: ExplorationState['panelTab']) => void
  onSort: (sort: ExplorationState['citySort']) => void
  onSelect: (id: string | null) => void
  onHover: (id: string | null) => void
  onCompare: (id: string) => void
  onOpenJob: (match: MatchedJob) => void
  onSave: (match: MatchedJob) => void
  onProfile: () => void
  onData: () => void
  onFilters: () => void
  emptyState: ReactNode
}

export function CityPanel(props: Props) {
  const { catalog, results, remote, unmapped, remoteEligibleOnly, selectedId, tab, sort, status, emptyState, profile, compareIds, savedIds, saveReady, onSort, onTab, onSelect, onHover, onCompare, onOpenJob, onSave, onProfile, onData, onFilters } = props
  const sorted = useMemo(() => [...results].sort((a, b) => sort === 'match' ? b.averageScore - a.averageScore : sort === 'salary' ? (medianSalary(b.matches) ?? -1) - (medianSalary(a.matches) ?? -1) : b.companyCount - a.companyCount || b.averageScore - a.averageScore), [results, sort])
  const selectedResult = results.find(result => result.city.id === selectedId)
  const selectedCity = selectedId ? CITY_BY_ID.get(selectedId) : null
  const remoteCompanies = groupCompanies(remote)
  const unmappedCompanies = groupCompanies(unmapped)
  const coverage = unmappedCoverage(catalog)

  return <aside className="results-panel" aria-label="도시와 회사 탐색 결과" tabIndex={-1}>
    <div className="results-tabs">
      <button className={tab === 'cities' ? 'active' : ''} aria-pressed={tab === 'cities'} onClick={() => onTab('cities')}><MapPin size={15} />도시 탐색<span>{catalog.fetchedAt ? results.length : '—'}</span></button>
      <button className={tab === 'remote' ? 'active' : ''} aria-pressed={tab === 'remote'} onClick={() => onTab('remote')}><Globe2 size={15} />원격 기회<span>{catalog.fetchedAt ? remoteCompanies.length : '—'}</span></button>
      <button className={tab === 'unmapped' ? 'active' : ''} aria-pressed={tab === 'unmapped'} onClick={() => onTab('unmapped')}><MapPinOff size={15} />기타 근무지<span>{catalog.fetchedAt ? unmappedCompanies.length : '—'}</span></button>
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
          {selectedResult ? groupCompanies(selectedResult.matches).map(group => <CompanyCard key={group.company.id} matches={group.matches} savedIds={savedIds} saveReady={saveReady} onOpen={onOpenJob} onSave={onSave} />) : emptyState}
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
        </article>)}</div> : emptyState}
        <div className="list-bottom-note"><CircleHelp size={14} /><span>숫자는 조건에 맞는 공고가 있는 회사 수예요.<br />기회가 많은 도시와 잘 맞는 도시는 다를 수 있어요.</span></div>
      </> : tab === 'remote' ? <>
        <div className="results-heading remote-heading"><span className="remote-illustration"><Globe2 size={30} /><span /></span><p className="eyebrow">A CAREER WITHOUT BORDERS</p><h2>어디서든, 함께<span className="accent-dot">.</span></h2><p>출근할 도시보다 함께할 팀이 중요하다면.</p><button className="residence-button" onClick={onProfile}><MapPin size={13} />{COUNTRIES.find(([id]) => id === profile.residence)?.[1] ?? profile.residence}{remoteEligibleOnly ? ' 거주 기준' : ' · 프로필 거주 국가'}<ArrowRight size={13} /></button>{!remoteEligibleOnly && <p className="remote-range-note">거주 국가 밖·지역 미확인 공고도 표시 중이에요. 실제 근무 가능 지역은 원문에서 확인해 주세요.</p>}</div>
        <div className="list-toolbar"><span>{remoteCompanies.length}개 회사 · {remote.length}개 공고</span><button className="text-button muted" onClick={onFilters}><SlidersHorizontal size={12} />조건</button></div>
        <div className="company-list">{remoteCompanies.length ? remoteCompanies.map(group => <CompanyCard key={group.company.id} matches={group.matches} savedIds={savedIds} saveReady={saveReady} onOpen={onOpenJob} onSave={onSave} />) : emptyState}</div>
      </> : <>
        <div className="results-heading unmapped-heading">
          <p className="eyebrow">BEYOND THE MAP</p><h2>그 밖의 근무지<span className="accent-dot">.</span></h2>
          <p>제공 도시 밖이거나 도시를 특정하기 어려운 공고예요. 공고에 적힌 근무지와 실제 근무 형태를 확인해 주세요.</p>
          <p className="unmapped-range-note">국가가 확인된 공고는 해당 지역에서도 표시해요. 국가가 미확인인 근무지는 ‘전 세계’에서 찾고, 공고에 적힌 지역명으로 검색할 수 있어요.</p>
          {(coverage.unavailable === null || coverage.unavailable > 0) && <div className="unmapped-previous-note">
            <p>{coverage.unavailable === null ? '일부 이전 조회에서는 목록에 포함하지 못한 공고 수를 확인할 수 없어요.'
              : `이전 조회에서 목록에 포함하지 못한 공고 ${coverage.unavailable}개가 더 있어요.`} 정상 조회 후 목록이 갱신됩니다.</p>
            <button className="text-button" onClick={onData}>조회 상태 확인<ArrowRight size={13} /></button>
          </div>}
        </div>
        <div className="list-toolbar"><span>{unmappedCompanies.length}개 회사 · {unmapped.length}개 공고</span><button className="text-button muted" onClick={onFilters}><SlidersHorizontal size={12} />조건</button></div>
        <div className="company-list">{unmappedCompanies.length ? unmappedCompanies.map(group => <CompanyCard key={group.company.id} matches={group.matches} savedIds={savedIds} saveReady={saveReady} onOpen={onOpenJob} onSave={onSave} />) : emptyState}</div>
      </>)}
    </div>
    <button className="panel-data-footer" onClick={onData}><span className={`source-status-dot ${catalog.source === 'sample' ? 'sample' : catalogNeedsAttention(catalog) ? 'attention' : ''}`} /><span>{catalog.source === 'sample' ? '샘플 데이터로 탐색 중' : catalog.boards.some(board => board.status === 'pending') ? '회사별 수집 진행 확인' : !catalog.fetchedAt ? '공개 공고 연결 확인' : catalogNeedsAttention(catalog) ? '일부 게시판 · 조회 상태 확인' : '회사별 공개 채용공고'}</span><CircleHelp size={14} /></button>
  </aside>
}

function mostMatchedSkills(matches: MatchedJob[]) {
  const skills = new Map<string, number>()
  matches.forEach(match => match.matchedSkills.forEach(skill => skills.set(skill, (skills.get(skill) ?? 0) + 1)))
  return [...skills.entries()].sort((a, b) => b[1] - a[1]).map(([skill]) => skill)
}

function SparkleMark() {
  return <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m8 1 1.7 5.3L15 8l-5.3 1.7L8 15l-1.7-5.3L1 8l5.3-1.7L8 1Z" fill="currentColor" /></svg>
}
