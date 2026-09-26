import { useEffect, useState } from 'react'
import { ChartNoAxesCombined, ChevronDown, RefreshCw } from 'lucide-react'
import {
  ObservationHistorySchema, OBSERVATION_REGION_LABELS, observationComparison,
} from '../../shared/catalog-observations'
import type { ObservationHistory, ObservationPoint, ObservationStats } from '../../shared/catalog-observations'
import { formatCollectionTime } from '../../shared/catalog-health'
import { MODE_LABELS, ROLE_FILTER_LABELS } from '../../shared/types'
import { Spinner } from './ui'

const number = (value: number) => value.toLocaleString('ko-KR')
const percent = (count: number, total: number) => total ? `${(count / total * 100).toFixed(1)}%` : '—'
const BOARD_STATUS = {
  complete: '확인 완료', missing: '조회 기록 없음', error: '최근 조회 실패',
  stale: '조회 시각 차이가 큼', incomplete: '전체 집계 미확인',
} as const
type Distribution = 'companies' | 'regions' | 'roles' | 'workModes' | 'skills'

export function ObservationPanel({ collectionStamp, collecting }: { collectionStamp?: string; collecting: boolean }) {
  const [open, setOpen] = useState(false)
  const [history, setHistory] = useState<ObservationHistory | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [retry, setRetry] = useState(0)
  const [date, setDate] = useState('')
  const [distribution, setDistribution] = useState<Distribution>('companies')
  useEffect(() => {
    if (!open || collecting) return
    const controller = new AbortController()
    let cancelled = false
    const timeout = window.setTimeout(() => controller.abort(), 15_000)
    setLoading(true)
    setError('')
    void (async () => {
      try {
        const response = await fetch('/api/observations', { signal: controller.signal })
        if (!response.ok) throw new Error('관측 기록 응답 오류')
        const parsed = ObservationHistorySchema.safeParse(await response.json())
        if (!parsed.success) throw new Error('관측 기록 형식 오류')
        if (!cancelled) setHistory(parsed.data)
      } catch {
        if (!cancelled) setError('관측 기록을 불러오지 못했어요. 다시 읽어 주세요.')
      } finally {
        window.clearTimeout(timeout)
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true; window.clearTimeout(timeout); controller.abort() }
  }, [open, collecting, collectionStamp, retry])
  const days = [...(history?.days ?? [])].sort((left, right) => right.day.localeCompare(left.day))
  const selected = days.find(day => day.day === date) ?? days[0]
  const point = selected?.complete
  const comparison = history && selected && point?.comparable ? observationComparison(history.days, selected.day) : null
  const latestFailure = selected?.latest.boards.some(board => board.status !== 'complete')
  return <details className="observation-panel" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary><span><ChartNoAxesCombined size={16} />관측 기록과 채용 분포</span><ChevronDown size={15} /></summary>
    {open && <div className="observation-content">
      <p className="field-description">설정된 공개 게시판을 본문까지 조회한 기록입니다. 기록을 읽거나 분포를 바꿀 때 채용 사이트를 다시 조회하지 않아요.</p>
      <div className="observation-toolbar">
        {days.length > 0 && <label>관측 날짜 (UTC)<select value={selected?.day ?? ''} onChange={event => setDate(event.target.value)}>
          {days.map(day => <option key={day.day} value={day.day}>{day.day}{day.complete ? '' : ' · 전체 집계 미확인'}</option>)}
        </select></label>}
        <button className="text-button" disabled={loading || collecting} onClick={() => setRetry(value => value + 1)}><RefreshCw size={13} />관측 기록 다시 읽기</button>
      </div>
      {(loading || collecting && !history) && <Spinner label={collecting ? '본문 수집이 끝나면 관측 기록을 읽어요…' : '관측 기록을 읽고 있어요…'} />}
      {error && <p className="form-error" role="alert">{error}{history && ' 아래는 앞서 읽은 기록입니다.'}</p>}
      {history?.error && <p className="form-error" role="alert">{history.error}</p>}
      {history && <>
        <p className="observation-scope">대상 {number(history.scope.boards.length)}개 회사 · 최근 {history.retentionDays}일 이내 · UTC 날짜별 마지막 정상 집계</p>
        {!selected && <p className="observation-empty" role="status">아직 관측 기록이 없어요. 공개 공고의 본문 조회가 완료되면 기록이 쌓입니다. 수집하지 않은 날은 0개로 채우지 않아요.</p>}
        {selected && <>
          <p className="field-description">최근 시도 · <time dateTime={selected.latest.observedAt}>{formatCollectionTime(selected.latest.observedAt)}</time>{selected.latest.origin === 'cache' && ' · 이전 캐시에서 읽음'}</p>
          {latestFailure && <div className="observation-incomplete" role="status">
            <strong>이 날짜의 최근 시도는 전체 집계를 확인하지 못했어요.</strong>
            <p>{point ? '아래에는 같은 날 마지막으로 완성된 집계를 유지합니다.' : '일부 회사의 숫자를 전체 채용 규모로 표시하지 않아요.'}</p>
            <ul>{selected.latest.boards.filter(board => board.status !== 'complete').map(board => <li key={board.companyId}>
              {history.scope.boards.find(source => source.companyId === board.companyId)?.name} · {BOARD_STATUS[board.status]}
              {board.lastSuccessAt && <small>마지막 정상 조회 · {formatCollectionTime(board.lastSuccessAt)}</small>}
            </li>)}</ul>
          </div>}
          {point && <>
            <p className="field-description">집계 기준 · <time dateTime={point.observedAt}>{formatCollectionTime(point.observedAt)}</time>{point.origin === 'cache' && ' · 이전 캐시에서 읽음'}<br />회사를 순서대로 조회한 결과이며, 모든 회사의 같은 순간을 측정한 값은 아닙니다.</p>
            {!point.comparable && <p className="observation-incomplete">이전 캐시의 분류 기준을 확인할 수 없어 이 집계는 날짜 간 비교에서 제외해요. 새로 본문을 조회한 기록부터 비교합니다.</p>}
            <dl className="observation-totals">
              <div><dt>공개 목록 전체 직군</dt><dd>{number(point.stats.published)}<small>개</small></dd></div>
              <div><dt>개발·컴퓨팅 후보</dt><dd>{number(point.stats.technical)}<small>개</small></dd></div>
              <div><dt>일반 채용 공고</dt><dd>{number(point.stats.openings)}<small>개</small></dd></div>
              <div><dt>인재풀·관심 등록</dt><dd>{number(point.stats.talentPools)}<small>개</small></dd></div>
            </dl>
            <div className="observation-comparison" role="status">{comparison && comparison.currentDay === selected.day
              ? <><strong>{comparison.previousDay} → {comparison.currentDay}: 일반 공고 {comparison.difference > 0 ? '+' : ''}{number(comparison.difference)}개</strong><p>{number(comparison.previous)}개에서 {number(comparison.current)}개로 관측됐어요. 동일 회사·게시판과 분류 기준의 직전 정상 기록을 비교합니다. 신규 채용·채용 종료 건수나 시장 전체의 성장률은 아닙니다.</p></>
              : <p>같은 회사·게시판과 분류 기준으로 확인된 서로 다른 날짜의 기록이 2개 이상 쌓이면 변화를 비교해요.</p>}</div>
            <ObservationDistribution point={point} distribution={distribution} onDistribution={setDistribution} />
          </>}
        </>}
        {history.otherSeries.length > 0 && <p className="field-description">회사·게시판 구성 또는 분류 기준이 다른 이전 기록 {history.otherSeries.length}개 묶음은 현재 비교에서 제외했어요.</p>}
        <p className="observation-method">이 표본은 설정된 회사의 공개 게시판에 한정됩니다. 프로필·검색 조건과 무관하며, 전체 채용시장이나 실제 채용 인원을 대표하지 않아요. 정상 조회가 없던 날은 기록이 없고, 하루 중 변동은 마지막 정상 집계에 합쳐집니다.</p>
      </>}
    </div>}
  </details>
}

function ObservationDistribution({ point, distribution, onDistribution }: {
  point: ObservationPoint; distribution: Distribution; onDistribution: (value: Distribution) => void
}) {
  const stats = point.stats
  const topCompany = stats.companies[0]
  const topFive = stats.companies.slice(0, 5).reduce((sum, company) => sum + company.count, 0)
  const rows = distribution === 'companies' ? stats.companies.map(company => ({ key: company.companyId, label: company.name, count: company.count }))
    : distribution === 'regions' ? stats.regions.map(item => ({ ...item, label: OBSERVATION_REGION_LABELS[item.key] }))
      : distribution === 'roles' ? stats.roles.map(item => ({ ...item, label: ROLE_FILTER_LABELS[item.key] }))
        : stats.workModes.map(item => ({ ...item, label: MODE_LABELS[item.key] }))
  return <section className="observation-distribution" aria-label="일반 채용 공고 분포">
    <label className="observation-dimension">분포 항목<select value={distribution} onChange={event => onDistribution(event.target.value as Distribution)}>
      <option value="companies">회사</option><option value="regions">근무 지역</option><option value="roles">개발 직무</option><option value="workModes">근무 형태</option><option value="skills">기술 언급과 자격 항목</option>
    </select></label>
    <p className="observation-denominator">분모: 일반 개발·컴퓨팅 공고 {number(stats.openings)}개 · 인재풀 {number(stats.talentPools)}개 제외</p>
    {stats.openings > 0 && topCompany
      ? <p className="observation-concentration">가장 많은 회사 {topCompany.name}: {number(topCompany.count)}개 ({percent(topCompany.count, stats.openings)}) · 상위 {Math.min(5, stats.companies.filter(company => company.count > 0).length)}개 회사 합계 {percent(topFive, stats.openings)}</p>
      : <p className="field-description">일반 공고가 0개여서 비중을 계산하지 않아요.</p>}
    {distribution === 'skills' ? <SkillDistribution stats={stats} />
      : <div className="observation-table-wrap" role="region" aria-label="공고 분포 표" tabIndex={0}><table className="observation-table">
        <caption>{distribution === 'companies' ? '회사별 일반 공고' : distribution === 'regions' ? '근무 지역별 일반 공고' : distribution === 'roles' ? '개발 직무별 일반 공고' : '근무 형태별 일반 공고'}</caption>
        <thead><tr><th scope="col">구분</th><th scope="col">공고 수</th><th scope="col">비중</th></tr></thead>
        <tbody>{rows.map(row => <tr key={row.key}><th scope="row">{row.label}</th><td>{number(row.count)}</td><td>{percent(row.count, stats.openings)}</td></tr>)}</tbody>
      </table></div>}
    {distribution === 'regions' && <p className="field-description">공고마다 확인된 근무 지역에서 한 번씩 셉니다. 복수 지역이나 일부 미확인이 겹쳐 합계가 분모를 넘을 수 있어요. 원격 공고는 별도로 세며 지원 가능한 거주 국가를 오피스 위치로 해석하지 않아요.</p>}
    {distribution === 'roles' && <p className="field-description">복수 직무 공고는 해당 직무마다 한 번씩 셉니다. 합계가 분모를 넘을 수 있으며, 기술 키워드만으로 직무를 추측하지 않아요.</p>}
    {distribution === 'workModes' && <p className="field-description">명시된 근무 형태를 기준으로 셉니다. 미확인을 오피스 근무나 원격근무로 바꾸지 않아요.</p>}
  </section>
}

function SkillDistribution({ stats }: { stats: ObservationStats }) {
  return <>
    <p className="field-description">언급 공고 수 기준 상위 {Math.min(20, stats.skills.length)}개 기술을 표시해요. 공고 하나에서 같은 기술을 여러 번 언급해도 항목별로 한 번만 셉니다.</p>
    {stats.skills.length ? <div className="observation-table-wrap" role="region" aria-label="기술별 공고 수 표" tabIndex={0}><table className="observation-table observation-skills">
      <caption>기술별 언급과 자격 항목의 공고 수</caption>
      <thead><tr><th scope="col">기술</th><th scope="col">언급</th><th scope="col">필수 항목에 포함</th><th scope="col">자격 항목에 포함</th><th scope="col">우대 항목에 포함</th></tr></thead>
      <tbody>{stats.skills.slice(0, 20).map(skill => <tr key={skill.name}><th scope="row">{skill.name}</th><td>{number(skill.mentioned)}</td><td>{number(skill.required)}</td><td>{number(skill.qualification)}</td><td>{number(skill.preferred)}</td></tr>)}</tbody>
    </table></div> : <p className="observation-empty">이 집계에서 확인된 기술 언급이 없어요. 기술 요구가 없다는 뜻은 아닙니다.</p>}
    <p className="field-description">“Python 또는 Go” 같은 필수 항목의 대안도 각각 포함됩니다. 해당 기술 하나가 반드시 필요하다는 뜻은 아니며, 우대·자격·필수 항목은 같은 공고에서 겹칠 수 있어요. 언급에는 업무 설명도 포함되고, 키워드로 확인하지 못한 기술은 집계되지 않습니다.</p>
  </>
}
