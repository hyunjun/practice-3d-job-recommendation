import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowRight, ArrowUpRight, Bookmark, BriefcaseBusiness, Check, ChevronDown, CircleHelp, Compass, Database, GitCompareArrows, Globe2, Maximize, Minus, Moon, MousePointer2, Plus, RotateCcw, Search, SlidersHorizontal, Sparkles, Sun, X } from 'lucide-react'
import { CITY_BY_ID } from '../shared/cities'
import { catalogNeedsAttention } from '../shared/catalog-health'
import { ageCatalog, catalogDeadlines, snapshotDeadlines } from '../shared/catalog-freshness'
import { countFilters, createSearchRanker, groupCities, matchJob } from '../shared/matching'
import { createSearchIndex } from '../shared/job-search'
import { isUnmappedJob } from '../shared/job-location'
import type { SearchScope } from '../shared/job-search'
import { analyzeSearchRecovery, undoRecoveryChanges } from '../shared/search-recovery'
import type { RecoverySuggestion } from '../shared/search-recovery'
import { DEFAULT_FILTERS, MODE_LABELS, POSTING_TYPE_LABELS, REGION_LABELS, ROLE_FILTER_LABELS, SAMPLE_PROFILE, VISA_FILTER_LABELS } from '../shared/types'
import type { Filters, MatchedJob, Profile, Region } from '../shared/types'
import type { SavedOperation } from '../shared/saved-jobs'
import { CityPanel } from './components/CityPanel'
import { CatalogStatus } from './components/CatalogStatus'
import { SearchRecovery } from './components/SearchRecovery'
import { ProfileDialog } from './components/ProfileDialog'
import { FiltersDialog } from './components/FiltersDialog'
import { DataDialog } from './components/DataDialog'
import { JobDialog } from './components/JobDialog'
import { SavedStorageNotice } from './components/SavedStorageNotice'
import { SavedDataDialog } from './components/SavedDataDialog'
import { CompareView, SavedView } from './components/Views'
import { OrbitLogo, Spinner, Toast } from './components/ui'
import type { GlobeHandle } from './components/Globe'
import { useCatalog } from './hooks/useCatalog'
import { usePostingStatus } from './hooks/usePostingStatus'
import { useSavedJobs } from './hooks/useSavedJobs'
import { FreshnessTimeContext, useDeadlineClock } from './hooks/useDeadlineClock'
import { deleteProfile, loadCompare, loadExploration, loadProfile, persist, persistExploration, STORAGE_KEYS } from './lib/storage'
import type { ExplorationState } from './lib/storage'

const Globe = lazy(() => import('./components/Globe').then(module => ({ default: module.Globe })))
const FlatMap = lazy(() => import('./components/FlatMap').then(module => ({ default: module.FlatMap })))

type View = 'explore' | 'saved' | 'compare'
type Notice = { message: string; action?: { label: string; run: () => void }; tone?: 'error' }
const REGION_VIEWS: Record<Region, [number, number, number]> = {
  all: [29, -39, 3.4], americas: [36, -98, 2.65], europe: [48, 7, 2.15], 'asia-pacific': [20, 119, 2.9],
}

function currentView(): View {
  const hash = window.location.hash.slice(1)
  return hash === 'saved' || hash === 'compare' ? hash : 'explore'
}

export default function App() {
  const [initial] = useState(() => {
    const profile = loadProfile()
    return { profile, exploration: loadExploration(profile) }
  })
  const [view, setView] = useState<View>(currentView)
  const [profile, setProfile] = useState<Profile>(initial.profile)
  const [rememberProfile, setRememberProfile] = useState(true)
  const [filters, setFilters] = useState<Filters>(initial.exploration.filters)
  const savedStorage = useSavedJobs()
  const saved = savedStorage.records
  const postingStatus = usePostingStatus(saved)
  const [compareIds, setCompareIds] = useState<string[]>(loadCompare)
  const [selectedId, setSelectedId] = useState<string | null>(initial.exploration.selectedId)
  const [hoveredId, setHoveredId] = useState<string | null>(null)
  const [panelTab, setPanelTab] = useState<ExplorationState['panelTab']>(initial.exploration.panelTab)
  const [mapMode, setMapMode] = useState<ExplorationState['mapMode']>(initial.exploration.mapMode)
  const [light, setLight] = useState(initial.exploration.light)
  const [citySort, setCitySort] = useState<ExplorationState['citySort']>(initial.exploration.citySort)
  const [modal, setModal] = useState<'profile' | 'filters' | 'data' | 'saved-data' | null>(null)
  const [openJob, setOpenJob] = useState<MatchedJob | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const explorationStorageWarned = useRef(false)
  const mapRef = useRef<GlobeHandle>(null)
  const mapStageRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const closeNotice = useCallback(() => setNotice(null), [])
  const notify = useCallback((message: string, action?: Notice['action'], tone?: Notice['tone']) => setNotice({ message, action, tone }), [])
  const notifyCatalog = useCallback((message: string, tone?: Notice['tone']) => notify(message, undefined, tone), [notify])
  const { catalog: receivedCatalog, loading, progress, error: dataError, changeSource, retryAt } = useCatalog(initial.exploration.source, notifyCatalog)
  const catalogTimes = useMemo(() => catalogDeadlines(receivedCatalog), [receivedCatalog])
  const deadlines = useMemo(() => [
    ...catalogTimes,
    ...saved.flatMap(item => item.job.source === 'sample' ? [] : snapshotDeadlines(item.job.fetchedAt)),
    ...(openJob && openJob.job.source !== 'sample' ? snapshotDeadlines(openJob.job.fetchedAt) : []),
  ], [catalogTimes, saved, openJob])
  const freshnessNow = useDeadlineClock(deadlines)
  // Resume events within the same age window should not rebuild the search index.
  const catalogTime = catalogTimes.reduce((latest, time) => time <= freshnessNow ? Math.max(latest, time) : latest, 0)
  const { catalog, expired: catalogExpired } = useMemo(() => ageCatalog(receivedCatalog, catalogTime), [receivedCatalog, catalogTime])
  const catalogReady = Boolean(catalog.fetchedAt)
  const retryCatalog = () => void changeSource('public', { refresh: true, announce: catalogReady })
  const showData = () => setModal('data')
  const showSavedData = () => { setOpenJob(null); setModal('saved-data') }

  const searchIndex = useMemo(() => createSearchIndex(catalog, profile), [catalog, profile])
  const rankSearch = useMemo(() => createSearchRanker(searchIndex, profile), [searchIndex, profile])
  const matches = useMemo(() => rankSearch(filters), [rankSearch, filters])
  const cities = useMemo(() => groupCities(catalog, matches, filters), [catalog, matches, filters])
  const remote = useMemo(() => matches.filter(match => match.job.workMode === 'remote'), [matches])
  const unmapped = useMemo(() => matches.filter(match => isUnmappedJob(match.job)), [matches])
  const companyCount = useMemo(() => new Set(matches.map(match => match.company.id)).size, [matches])
  const savedIds = useMemo(() => new Set(saved.map(item => item.job.id)), [saved])
  const savedOpenJob = saved.find(item => item.job.id === openJob?.job.id)
  const searchScope = useMemo<SearchScope>(() => panelTab !== 'cities' ? { kind: panelTab }
    : selectedId && CITY_BY_ID.has(selectedId) ? { kind: 'city', cityId: selectedId } : { kind: 'cities' }, [panelTab, selectedId])
  // Other cities or tabs can still have matches when the displayed scope is empty.
  const hasScopeResults = searchScope.kind === 'cities' ? cities.length > 0
    : searchScope.kind === 'city' ? cities.some(result => result.city.id === searchScope.cityId)
    : searchScope.kind === 'remote' ? remote.length > 0 : unmapped.length > 0
  const recovery = useMemo(() => view === 'explore' && catalogReady && !loading && !hasScopeResults && !catalog.boards.some(board => board.status === 'pending')
    ? analyzeSearchRecovery(searchIndex, filters, searchScope) : null, [view, catalogReady, loading, hasScopeResults, catalog.boards, searchIndex, filters, searchScope])

  useEffect(() => {
    const onHash = () => setView(currentView())
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])
  useEffect(() => { persist(STORAGE_KEYS.compare, compareIds) }, [compareIds])
  useEffect(() => {
    const success = persistExploration({
      source: catalog.source, filters, selectedId, panelTab, mapMode, light, citySort,
    }, profile.kind === 'sample' || rememberProfile)
    if (!success && !explorationStorageWarned.current) {
      explorationStorageWarned.current = true
      notify('브라우저에 탐색 상태를 저장하지 못했어요. 현재 화면에서는 계속 탐색할 수 있어요.', undefined, 'error')
    }
  }, [catalog.source, filters, selectedId, panelTab, mapMode, light, citySort, profile.kind, rememberProfile, notify])
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const element = event.target as HTMLElement
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        if (modal || openJob) return
        event.preventDefault()
        if (view !== 'explore') navigate('explore')
        requestAnimationFrame(() => searchRef.current?.focus())
      } else if (event.key === '/' && !['INPUT', 'TEXTAREA', 'SELECT'].includes(element.tagName) && !modal && !openJob) {
        event.preventDefault()
        searchRef.current?.focus()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [view, modal, openJob])

  const navigate = (next: View) => {
    setView(next)
    window.location.hash = next === 'explore' ? '' : next
  }

  const positionMap = useCallback(() => {
    if (selectedId && panelTab === 'cities') {
      const city = CITY_BY_ID.get(selectedId)
      if (city) mapRef.current?.flyTo(city.lat, city.lng, 1.85)
    } else if (filters.region === 'all') mapRef.current?.reset()
    else mapRef.current?.flyTo(...REGION_VIEWS[filters.region])
  }, [selectedId, panelTab, filters.region])
  const positionMapRef = useRef(positionMap)
  positionMapRef.current = positionMap
  const onMapReady = useCallback(() => positionMapRef.current(), [])

  useEffect(() => { positionMap() }, [positionMap, mapMode, view])

  const onGlobeFailure = useCallback(() => {
    setMapMode('flat')
    notify('이 환경에서는 2D 지도로 같은 기회를 보여드릴게요.')
  }, [notify])

  const selectCity = (id: string | null) => {
    setSelectedId(id)
    setPanelTab('cities')
    if (id && window.innerWidth < 900) panelRef.current?.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'start' })
  }

  const updateFilters = (next: Filters) => {
    setFilters(next)
    if (next.workMode === 'remote') setPanelTab('remote')
    else if (next.workMode !== 'all') setPanelTab(current => current === 'remote' ? 'cities' : current)
    setModal(null)
  }

  const focusResults = () => requestAnimationFrame(() => panelRef.current?.querySelector<HTMLElement>('.results-panel')?.focus({ preventScroll: true }))
  const applyRecovery = (suggestion: RecoverySuggestion) => {
    const current = recovery?.suggestions.find(item => item.id === suggestion.id)
    if (!current || loading) return
    const previous = { ...filters }
    setFilters(value => ({ ...value, ...current.changes }))
    notify(`${Object.keys(current.changes).length}가지 검색 조건을 바꿨어요. 이 범위에 회사 ${current.count.companies}곳·공고 ${current.count.jobs}개가 표시돼요.`, {
      label: '실행 취소', run: () => { setFilters(value => undoRecoveryChanges(value, previous, current.changes)); focusResults() },
    })
    focusResults()
  }
  const navigateRecovery = (scope: SearchScope) => {
    setSelectedId(scope.kind === 'city' ? scope.cityId : null)
    setPanelTab(scope.kind === 'city' ? 'cities' : scope.kind)
    focusResults()
  }

  const changeSaved = (operation: SavedOperation) => {
    const result = savedStorage.change(operation)
    if (!result.accepted) {
      const messages = {
        loading: '저장한 기록을 먼저 확인하고 있어요. 저장소 상태를 확인해 주세요.',
        limit: '최대 500개까지 저장할 수 있어요. CSV로 내보낸 뒤 정리해 주세요.',
        unreadable: '이 공고의 기존 기록을 읽을 수 없어 원본을 그대로 보관했어요.',
        missing: '저장한 목록에서 이 공고를 찾지 못했어요. 다시 저장해 주세요.',
        busy: '파일을 반영하고 있어요. 완료된 뒤 다시 시도해 주세요.',
      }
      notify(messages[result.reason], undefined, 'error')
    }
    return result.accepted
  }
  const toggleSave = (match: MatchedJob) => {
    const existing = saved.find(item => item.job.id === match.job.id)
    if (existing) {
      if (!changeSaved({ kind: 'remove', id: match.job.id })) return
      notify('저장한 기회에서 제거했어요.', { label: '실행 취소', run: () => { changeSaved({ kind: 'add', record: existing }) } })
    } else {
      if (!changeSaved({ kind: 'add', record: { job: match.job, company: match.company, savedAt: new Date().toISOString(), status: 'saved', note: '' } })) return
      notify(`${match.company.name}의 기회를 목록에 추가했어요.`, { label: '모아보기', run: () => { setOpenJob(null); navigate('saved') } })
    }
  }

  const toggleCompare = (id: string) => {
    if (compareIds.includes(id)) {
      setCompareIds(current => current.filter(value => value !== id))
    } else if (compareIds.length < 3) {
      setCompareIds(current => current.includes(id) ? current : [...current, id].slice(0, 3))
      notify(`${CITY_BY_ID.get(id)?.name}을 비교에 추가했어요.`, { label: '비교하기', run: () => navigate('compare') })
    } else notify('도시는 최대 3개까지 비교할 수 있어요. 기존 도시를 하나 빼주세요.')
  }

  const applyProfile = (next: Profile, preferences: Partial<Filters>, remember: boolean) => {
    const isNewProfile = profile.kind !== 'personal'
    const updatedProfile: Profile = { ...next, preferences: {
      workMode: preferences.workMode ?? filters.workMode,
      visa: preferences.visa ?? filters.visa,
      salaryMin: preferences.salaryMin ?? filters.salaryMin,
    } }
    setProfile(updatedProfile)
    setFilters(current => ({ ...current, ...preferences }))
    if (isNewProfile) {
      setSelectedId(null)
      setPanelTab(preferences.workMode === 'remote' ? 'remote' : 'cities')
    } else if (preferences.workMode !== undefined && preferences.workMode !== filters.workMode) {
      if (preferences.workMode === 'remote') setPanelTab('remote')
      else if (preferences.workMode !== 'all') setPanelTab(current => current === 'remote' ? 'cities' : current)
    }
    if (remember) {
      const remembered = persist(STORAGE_KEYS.profile, updatedProfile)
      setRememberProfile(remembered)
      if (!remembered) notify('프로필을 저장하지 못했지만 이번 탐색에는 적용했어요.', undefined, 'error')
      else notify(isNewProfile ? `${next.name}님의 경험으로 기회 지도를 업데이트했어요.` : `${next.name}님의 프로필을 업데이트했어요.`)
    } else {
      setRememberProfile(false)
      deleteProfile()
      notify('프로필을 이번 탐색에만 적용했어요.')
    }
    setModal(null)
    if (isNewProfile) navigate('explore')
  }

  const resetFilters = () => {
    setFilters({ ...DEFAULT_FILTERS })
    setSelectedId(null)
    setPanelTab('cities')
    searchRef.current?.focus()
  }
  const initials = profile.name.split(/\s+/).map(part => part[0]).slice(0, 2).join('').toUpperCase()
  const fullscreen = () => {
    if (document.fullscreenElement) void document.exitFullscreen()
    else void mapStageRef.current?.requestFullscreen().catch(() => notify('이 브라우저에서는 전체 화면을 사용할 수 없어요.'))
  }
  const catalogStatus = <CatalogStatus catalog={catalog} expired={catalogExpired} loading={loading} progress={progress} error={dataError} retryAt={retryAt} onRetry={retryCatalog} onData={showData} />

  return <FreshnessTimeContext.Provider value={freshnessNow}><div className="app-shell">
    <a className="skip-link" href="#main-content" onClick={event => { event.preventDefault(); document.getElementById('main-content')?.focus() }}>본문으로 건너뛰기</a>
    <header className="app-header">
      <button className="brand" onClick={() => navigate('explore')} aria-label="ORBIT 홈"><OrbitLogo /><span>orbit<span className="brand-period">.</span></span><span className="brand-caption">CAREER ATLAS</span></button>
      <nav className="main-nav" aria-label="주요 메뉴">
        <button className={view === 'explore' ? 'active' : ''} aria-current={view === 'explore' ? 'page' : undefined} onClick={() => navigate('explore')}><Compass size={16} />기회 탐색</button>
        <button className={view === 'saved' ? 'active' : ''} aria-current={view === 'saved' ? 'page' : undefined} aria-busy={savedStorage.phase === 'loading' || savedStorage.phase === 'saving'} onClick={() => navigate('saved')}><Bookmark size={15} />저장한 기회{saved.length > 0 && <span className="nav-count">{saved.length}</span>}</button>
        <button className={view === 'compare' ? 'active' : ''} aria-current={view === 'compare' ? 'page' : undefined} onClick={() => navigate('compare')}><GitCompareArrows size={16} />도시 비교{compareIds.length > 0 && <span className="nav-count">{compareIds.length}</span>}</button>
      </nav>
      <div className="header-actions"><button className="data-status-button" onClick={showData}>{loading ? <Spinner /> : <span className={`source-status-dot ${catalog.source === 'sample' ? 'sample' : dataError || catalogNeedsAttention(catalog) ? 'attention' : ''}`} />}<span>{loading ? '공개 공고 조회 중' : catalog.source === 'sample' ? '샘플 탐색' : dataError ? '공개 공고 연결 필요' : catalogExpired ? '공개 공고 확인 필요' : '공개 채용'}</span><ChevronDown size={12} /></button><span className="header-divider" /><button className="profile-avatar" onClick={() => setModal('profile')} aria-label="내 프로필 편집" title="내 프로필">{initials}<span /></button></div>
    </header>
    {view !== 'saved' && !openJob && modal !== 'saved-data' && (savedStorage.phase === 'error' || savedStorage.recovery.length > 0) && <div className="global-saved-status"><SavedStorageNotice storage={savedStorage} onManage={showSavedData} issuesOnly /></div>}
    {view === 'explore' ? <>
      <div className="search-toolbar">
        <label className="global-search"><Search size={18} /><input ref={searchRef} value={filters.query} maxLength={500} aria-label="도시, 회사 또는 포지션 검색" aria-description="도시, 회사, 포지션, 기술과 공고의 언어 조건을 검색합니다." placeholder="도시·회사·직무·언어 검색" onChange={event => setFilters(current => ({ ...current, query: event.target.value }))} />{filters.query ? <button aria-label="검색어 지우기" onClick={() => setFilters(current => ({ ...current, query: '' }))}><X size={15} /></button> : <kbd>⌘ K</kbd>}</label>
        <div className="quick-filters">
          <label className={`quick-filter ${filters.role !== 'all' ? 'is-active' : ''}`}><BriefcaseBusiness size={14} /><select aria-label="직무 필터" value={filters.role} onChange={event => setFilters(current => ({ ...current, role: event.target.value as Filters['role'] }))}>{Object.entries(ROLE_FILTER_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select><ChevronDown size={12} /></label>
          <label className={`quick-filter ${filters.workMode !== 'all' ? 'is-active' : ''}`}><Globe2 size={14} /><select aria-label="근무 형태 필터" value={filters.workMode} onChange={event => { const value = event.target.value as Filters['workMode']; setFilters(current => ({ ...current, workMode: value })); if (value === 'remote') setPanelTab('remote'); else if (value !== 'all') setPanelTab(current => current === 'remote' ? 'cities' : current) }}>{Object.entries(MODE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select><ChevronDown size={12} /></label>
          <label className={`quick-filter visa-quick-filter ${filters.visa !== 'all' ? 'is-active' : ''}`}><select aria-label="비자 지원 필터" value={filters.visa} onChange={event => setFilters(current => ({ ...current, visa: event.target.value as Filters['visa'] }))}>{Object.entries(VISA_FILTER_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select><ChevronDown size={12} /></label>
          <button className={`all-filters-button ${countFilters(filters) ? 'is-active' : ''}`} onClick={() => setModal('filters')}><SlidersHorizontal size={15} /><span>모든 필터</span>{countFilters(filters) > 0 && <span className="filter-count">{countFilters(filters)}</span>}</button>
        </div>
        <span className="toolbar-match-note"><Sparkles size={13} />내 경험과 연결되는 기회</span>
      </div>
      {catalogReady && (filters.query || countFilters(filters) > 0) && <div className="active-filter-summary"><span>{matches.length}개 공고가 현재 조건에 맞아요{filters.postingType !== 'opening' && ` · ${POSTING_TYPE_LABELS[filters.postingType]}`}{catalog.source === 'public' && filters.role !== 'all' && (filters.role === 'unknown' ? ' · 세부 직무 미확인 공고' : ' · 직무 미확인 공고 제외')}{filters.salaryMin > 0 && ` · 희망 연봉 $${filters.salaryMin / 1000}k+`}{filters.employment !== 'all' && ' · 고용 형태 필터 적용'}{!filters.remoteEligibleOnly && ' · 원격근무 지역 제한 해제'}</span><button onClick={resetFilters}><RotateCcw size={11} />초기화</button></div>}
      <main id="main-content" className="explore-layout" tabIndex={-1}>
        <div className="map-stage" ref={mapStageRef}>
          <div className="space-grain" />
          <div className="map-title" data-map-overlay><p className="eyebrow"><span />YOUR NEXT CHAPTER</p><h1>당신의 다음 챕터,<br /><span>어디서 시작할까요?</span></h1><p className="map-title-description">익숙한 경력에서, 예상하지 못한 가능성으로.</p><button className={`profile-cta ${profile.kind === 'personal' ? 'personal' : ''}`} onClick={() => setModal('profile')}>{profile.kind === 'sample' ? <Sparkles size={14} /> : <Check size={14} />}<span>{profile.kind === 'sample' ? '내 경력으로 기회 찾기' : `${profile.name} · 프로필 수정`}</span><ArrowUpRight size={14} /></button></div>
          <div className="map-stats" data-map-overlay aria-live="polite" aria-atomic="true"><div><span>추천 회사</span><strong>{catalogReady ? companyCount : '—'}<small>곳</small></strong></div><span className="stats-divider" /><div><span>탐색 도시</span><strong>{catalogReady ? cities.length : '—'}<small>곳</small></strong></div></div>
          <div className="region-tabs" data-map-overlay aria-label="탐색 지역">{Object.entries(REGION_LABELS).map(([value, label]) => <button className={filters.region === value ? 'active' : ''} key={value} aria-pressed={filters.region === value} onClick={() => { setSelectedId(null); setFilters(current => ({ ...current, region: value as Region })) }}>{value === 'all' && <Globe2 size={12} />}{label}</button>)}</div>
          <div className="map-viewport">
            <Suspense fallback={<div className="map-loading"><span className="loading-planet" /><Spinner label="기회의 지도를 펼치는 중" /></div>}>
              {mapMode === 'globe' ? <Globe ref={mapRef} results={cities} selectedId={panelTab === 'cities' ? selectedId : null} hoveredId={hoveredId} onSelect={selectCity} onHover={setHoveredId} onFailure={onGlobeFailure} onReady={onMapReady} light={light} /> : <FlatMap ref={mapRef} results={cities} selectedId={panelTab === 'cities' ? selectedId : null} hoveredId={hoveredId} onSelect={selectCity} onHover={setHoveredId} onReady={onMapReady} />}
            </Suspense>
          </div>
          {profile.kind === 'sample' && <div className="sample-profile-card" data-map-overlay><div className="sample-avatar">AK<span /></div><div><span>지금은 샘플 프로필로 탐색 중</span><strong>Software Engineer <span>· 5년</span></strong><p>TypeScript · React · Python +3</p></div><button aria-label="내 프로필 입력" onClick={() => setModal('profile')}><ArrowUpRight size={17} /></button></div>}
          <div className="map-control-stack" data-map-overlay><button className="map-compass" onClick={() => mapRef.current?.reset()} aria-label="지구 처음 위치로" title="처음 위치로"><span>N</span><Compass size={23} /></button><div className="map-zoom-controls"><button aria-label="지도 확대" title="확대" onClick={() => mapRef.current?.zoom(1)}><Plus size={18} /></button><span /><button aria-label="지도 축소" title="축소" onClick={() => mapRef.current?.zoom(-1)}><Minus size={18} /></button></div>{mapMode === 'globe' && <button className="map-single-control" aria-label={light ? '야간 지구로 전환' : '주간 지구로 전환'} title={light ? '야간 지구' : '주간 지구'} onClick={() => setLight(!light)}>{light ? <Moon size={17} /> : <Sun size={17} />}</button>}<button className="map-single-control fullscreen-button" aria-label="지도 전체 화면" title="전체 화면" onClick={fullscreen}><Maximize size={16} /></button></div>
          <div className="map-bottom-bar" data-map-overlay><div className="map-view-switch segmented"><button className={mapMode === 'globe' ? 'selected' : ''} aria-pressed={mapMode === 'globe'} onClick={() => setMapMode('globe')}><Globe2 size={13} />3D 지구</button><button className={mapMode === 'flat' ? 'selected' : ''} aria-pressed={mapMode === 'flat'} onClick={() => setMapMode('flat')}>2D 지도</button></div><span className="map-interaction-hint"><MousePointer2 size={12} />{mapMode === 'globe' ? '드래그로 회전 · 스크롤로 확대' : '드래그로 이동 · + / −로 확대'}</span><button className="map-legend" onClick={() => setModal('data')}><span />숫자 = 추천 회사 수<CircleHelp size={12} /></button></div>
          <div className="map-footline" data-map-overlay><span><span className="tiny-live-dot" />{catalog.cities.length}개 도시를 연결하는 커리어 지도</span><button onClick={() => { setPanelTab('remote'); setSelectedId(null) }}>원격으로 세계와 연결되기<ArrowRight size={12} /></button><button className="mobile-results-link" onClick={() => panelRef.current?.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'start' })}>도시 목록 보기<ChevronDown size={12} /></button></div>
        </div>
        <div ref={panelRef} className="panel-container"><CityPanel catalog={catalog} results={cities} remote={remote} unmapped={unmapped} remoteEligibleOnly={filters.remoteEligibleOnly} selectedId={selectedId} tab={panelTab} sort={citySort} profile={profile} compareIds={compareIds} savedIds={savedIds} saveReady={savedStorage.ready} onSort={setCitySort} onTab={setPanelTab} onSelect={selectCity} onHover={setHoveredId} onCompare={toggleCompare} onOpenJob={setOpenJob} onSave={toggleSave} onProfile={() => setModal('profile')} onData={showData} onFilters={() => setModal('filters')} status={catalogStatus} emptyState={<SearchRecovery analysis={recovery} filters={filters} scope={searchScope} sample={catalog.source === 'sample'} onApply={applyRecovery} onNavigate={navigateRecovery} onFilters={() => setModal('filters')} onProfile={() => setModal('profile')} onData={showData} />} /></div>
      </main>
    </> : view === 'saved' ? <SavedView saved={saved} storage={savedStorage} showStorageStatus={!openJob && modal !== 'saved-data'} onManage={showSavedData} profile={profile} postingStatus={postingStatus} onOpen={setOpenJob} onRemove={toggleSave} onExplore={() => navigate('explore')} /> : !catalogReady ? <main id="main-content" className="collection-page" tabIndex={-1}>{catalogStatus}</main> : <CompareView catalog={catalog} results={cities} postingType={filters.postingType} compareIds={compareIds} status={catalogStatus} onToggle={toggleCompare} onAuto={() => setCompareIds(cities.slice(0, 3).map(result => result.city.id))} onSelect={id => { navigate('explore'); selectCity(id) }} onExplore={() => navigate('explore')} />}
    <footer className="app-footer"><span><OrbitLogo small />A WORLD OF POSSIBILITIES.</span><span>{catalog.source === 'sample' ? 'DEMO WORKSPACE' : 'PUBLIC JOB BOARDS'}<span className="footer-dot">·</span>LOCAL FIRST<button onClick={() => setModal('data')}><Database size={11} />데이터와 추천 방식</button></span></footer>
    {modal === 'profile' && <ProfileDialog profile={profile} filters={filters} remember={rememberProfile} onApply={applyProfile} onDelete={() => { deleteProfile(); setProfile(SAMPLE_PROFILE); setRememberProfile(true); setFilters({ ...DEFAULT_FILTERS }); setPanelTab('cities'); setSelectedId(null); setModal(null); notify('저장된 프로필을 삭제하고 샘플로 돌아왔어요.') }} onClose={() => setModal(null)} />}
    {modal === 'saved-data' && <SavedDataDialog storage={savedStorage} onClose={() => setModal(null)} />}
    {modal === 'filters' && <FiltersDialog filters={filters} searchIndex={searchIndex} source={catalog.source} onApply={updateFilters} onClose={() => setModal(null)} />}
    {modal === 'data' && <DataDialog catalog={catalog} expired={catalogExpired} loading={loading} progress={progress} error={dataError} retryAt={retryAt} onSource={source => void changeSource(source, { announce: catalogReady })} onRefresh={retryCatalog} onClose={() => setModal(null)} />}
    {openJob && <JobDialog storage={savedStorage} onManageSaved={showSavedData} match={{ ...openJob, ...matchJob(openJob.job, profile) }} saved={savedOpenJob} postingObservation={savedOpenJob ? postingStatus.observations.get(savedOpenJob.job.id) : undefined} onToggleSave={() => toggleSave(openJob)} onUpdateSaved={update => { changeSaved({ kind: 'update', id: openJob.job.id, patch: update }) }} onClose={() => setOpenJob(null)} />}
    {notice && <Toast message={notice.message} action={notice.action} tone={notice.tone} onDismiss={closeNotice} />}
  </div></FreshnessTimeContext.Provider>
}
