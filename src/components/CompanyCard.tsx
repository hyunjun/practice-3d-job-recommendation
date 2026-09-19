import { useId, useLayoutEffect, useRef, useState } from 'react'
import { ArrowUpRight, Bookmark, BookmarkCheck, Check, ChevronDown, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, CircleHelp, MapPinOff, ShieldCheck } from 'lucide-react'
import { isUnmappedJob } from '../../shared/job-location'
import { jobRoleLabel } from '../../shared/job-roles'
import { formatJobSalary } from '../../shared/matching'
import { MODE_LABELS, VISA_LABELS } from '../../shared/types'
import type { MatchedJob } from '../../shared/types'
import { EligibilityNotice } from './JobEligibilityDetails'
import { JobFreshnessNotice } from './JobFreshnessNotice'
import { JobLocationNotice } from './JobLocationDetails'
import { CompanyLogo } from './ui'

const PAGE_SIZE = 10

interface Props {
  matches: MatchedJob[]
  savedIds: Set<string>
  saveReady: boolean
  onOpen: (match: MatchedJob) => void
  onSave: (match: MatchedJob) => void
}

function revealCard(element: HTMLElement | null) {
  if (!element) return
  const margin = Number.parseFloat(getComputedStyle(element).scrollMarginTop) || 0
  const top = element.getBoundingClientRect().top - margin
  const panel = element.closest<HTMLElement>('.results-scroll')
  if (panel && ['auto', 'scroll'].includes(getComputedStyle(panel).overflowY)) {
    // scrollIntoView also moves the document through its overflow-hidden root.
    // The desktop panel owns its scroll; mobile results use the document.
    panel.scrollTop += top - panel.getBoundingClientRect().top
  } else window.scrollTo({ top: window.scrollY + top, behavior: 'instant' })
}

export function CompanyCard({ matches, savedIds, saveReady, onOpen, onSave }: Props) {
  const [expanded, setExpanded] = useState(false)
  const resultIds = JSON.stringify(matches.map(match => match.job.id))
  const [position, setPosition] = useState({ results: resultIds, page: 0 })
  const card = useRef<HTMLElement>(null)
  const toggle = useRef<HTMLButtonElement>(null)
  const firstJob = useRef<HTMLButtonElement>(null)
  const focusAfterAction = useRef<'toggle' | 'job' | null>(null)
  const id = useId()
  const company = matches[0].company
  const pages = Math.ceil(matches.length / PAGE_SIZE)
  // Saving a job or receiving an unrelated company does not change this key.
  // A different set or order of results starts at its first page.
  if (position.results !== resultIds) setPosition({ results: resultIds, page: 0 })
  const page = position.results === resultIds ? Math.min(position.page, pages - 1) : 0
  const start = expanded ? page * PAGE_SIZE : 0
  const visible = matches.slice(start, start + (expanded ? PAGE_SIZE : 1))
  const listId = `${id}-jobs`

  useLayoutEffect(() => {
    const target = focusAfterAction.current
    if (!target) return
    focusAfterAction.current = null
    const element = target === 'job' ? firstJob.current : toggle.current ?? firstJob.current
    element?.focus({ preventScroll: true })
    revealCard(card.current)
  }, [page, expanded, resultIds])

  const changeExpanded = () => {
    focusAfterAction.current = 'toggle'
    setPosition({ results: resultIds, page: 0 })
    setExpanded(value => !value)
  }
  const changePage = (next: number) => {
    if (next < 0 || next >= pages || next === page) return
    focusAfterAction.current = 'job'
    setPosition({ results: resultIds, page: next })
  }
  const pagination = (placement: 'top' | 'bottom') => <nav className="company-job-pagination" aria-label={`${company.name} 공고 페이지 이동 (${placement === 'top' ? '위' : '아래'})`}>
    <button aria-label="처음 공고 페이지" title="처음 페이지" disabled={page === 0} onClick={() => changePage(0)}><ChevronsLeft size={16} /></button>
    <button aria-label="이전 공고 페이지" title="이전 페이지" disabled={page === 0} onClick={() => changePage(page - 1)}><ChevronLeft size={16} /></button>
    <span><span className="sr-only">{pages}페이지 중 {page + 1}페이지</span><span aria-hidden="true">{page + 1}<small> / {pages}</small></span></span>
    <button aria-label="다음 공고 페이지" title="다음 페이지" disabled={page === pages - 1} onClick={() => changePage(page + 1)}><ChevronRight size={16} /></button>
    <button aria-label="마지막 공고 페이지" title="마지막 페이지" disabled={page === pages - 1} onClick={() => changePage(pages - 1)}><ChevronsRight size={16} /></button>
  </nav>

  return <article className="company-card" ref={card} aria-labelledby={`${id}-company`}>
    <header><CompanyLogo company={company} /><div><h3 id={`${id}-company`}>{company.name}</h3><p>{company.industry}</p></div>{matches[0].job.source === 'sample' && <span className="sample-label">샘플</span>}</header>
    {matches.length > 1 && <div className="company-job-toolbar">
      <p role={expanded ? 'status' : undefined}>{expanded ? `${start + 1}–${start + visible.length}` : '1'} / {matches.length}개 공고</p>
      <button ref={toggle} className="more-jobs" aria-expanded={expanded} aria-controls={listId} onClick={changeExpanded}>{expanded ? '공고 접기' : `전체 ${matches.length}개 공고 보기`}<ChevronDown size={13} className={expanded ? 'rotated' : ''} /></button>
    </div>}
    {expanded && pages > 1 && pagination('top')}
    <div id={listId} className="company-jobs">
      {visible.map((match, index) => <div key={match.job.id} className="mini-job">
        <button ref={index === 0 ? firstJob : undefined} className="mini-job-title" onClick={() => onOpen(match)}>{match.job.title}<ArrowUpRight size={14} /></button>
        {match.job.source !== 'sample' && <p className="mini-job-role">{jobRoleLabel(match.job)}</p>}
        {isUnmappedJob(match.job) && <p className="mini-job-location"><MapPinOff size={12} /><span>{match.job.locationLabel}</span></p>}
        <JobLocationNotice job={match.job} />
        <div className="mini-job-meta"><span>{formatJobSalary(match.job)}</span><span>·</span><span>{MODE_LABELS[match.job.workMode]}</span></div>
        <JobFreshnessNotice job={match.job} compact />
        <EligibilityNotice job={match.job} />
        <div className="mini-job-reason">{match.matchedSkills.length ? <Check size={12} /> : <CircleHelp size={12} />}<span>{match.skillSummary}</span></div>
        <div className="mini-job-footer"><span className={`visa-tag ${match.job.visa === 'yes' ? 'confirmed' : match.job.visa === 'conditional' ? 'conditional' : ''}`}>{match.job.visa === 'yes' ? <ShieldCheck size={12} /> : <CircleHelp size={12} />}비자 {VISA_LABELS[match.job.visa]}</span><button className={`icon-button bookmark-button ${savedIds.has(match.job.id) ? 'is-saved' : ''}`} aria-label={`${company.name} ${match.job.title} ${savedIds.has(match.job.id) ? '저장 취소' : '저장'}`} disabled={!saveReady} onClick={() => onSave(match)}>{savedIds.has(match.job.id) ? <BookmarkCheck size={17} /> : <Bookmark size={17} />}</button></div>
      </div>)}
    </div>
    {expanded && pages > 1 && <div className="company-job-bottom">
      {pagination('bottom')}
      <button className="more-jobs" aria-expanded="true" aria-controls={listId} onClick={changeExpanded}>공고 접기<ChevronDown size={13} className="rotated" /></button>
    </div>}
  </article>
}
