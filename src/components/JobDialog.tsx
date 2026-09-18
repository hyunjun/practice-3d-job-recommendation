import { ArrowUpRight, Bookmark, BookmarkCheck, BriefcaseBusiness, Check, CheckCircle2, CircleHelp, Clock3, Globe2, MapPin, ShieldCheck } from 'lucide-react'
import { formatSalary, safeExternalUrl } from '../../shared/matching'
import { COUNTRIES, EMPLOYMENT_LABELS, MODE_LABELS } from '../../shared/types'
import type { MatchedJob, SavedJob } from '../../shared/types'
import { CompanyLogo, Dialog } from './ui'

interface Props {
  match: MatchedJob
  saved?: SavedJob
  onToggleSave: () => void
  onUpdateSaved: (update: Partial<Pick<SavedJob, 'note' | 'status'>>) => void
  onClose: () => void
}

export function JobDialog({ match, saved, onToggleSave, onUpdateSaved, onClose }: Props) {
  const { job, company, matchedSkills, reasons, cautions } = match
  const url = safeExternalUrl(job.url)
  const date = new Date(job.fetchedAt).toLocaleDateString('ko-KR')
  return <Dialog title={company.name} eyebrow={company.industry} onClose={onClose} className="job-dialog">
    <div className="dialog-body">
      <div className="job-detail-heading"><CompanyLogo company={company} /><div><h3>{job.title}</h3><p><MapPin size={14} />{job.locationLabel}</p></div></div>
      <div className="job-meta-pills"><span><BriefcaseBusiness size={13} />{EMPLOYMENT_LABELS[job.employment]}</span><span><Globe2 size={13} />{MODE_LABELS[job.workMode]}</span><span><Clock3 size={13} />{job.minExperience !== null ? `${job.minExperience}년 이상` : '경력 확인 필요'}</span></div>
      {job.source === 'sample' && <div className="sample-notice"><span className="sample-dot" /><span><strong>체험용 샘플 공고</strong>회사별 채용 여부·기술·보상 조건은 실제 공고가 아닌 예시입니다.</span></div>}
      <div className="job-key-facts"><div><span>세전 연봉</span><strong>{formatSalary(job.salary)}</strong>{job.salary && job.salary.currency !== 'USD' && <small>약 {formatSalary(job.salary, true)} USD / 년</small>}</div><div><span>비자 지원</span><strong className={job.visa === 'yes' ? 'text-accent' : ''}>{job.visa === 'yes' ? '지원 명시' : job.visa === 'no' ? '지원 없음' : '확인 필요'}</strong><small>{job.source === 'sample' ? '샘플 시나리오 기준' : '공고의 명시적 문구 기준'}</small></div></div>
      {job.workMode === 'remote' && <div className="remote-scope"><Globe2 size={18} /><div><strong>원격 지원 가능 지역</strong><p>{job.remoteWorldwide ? '전 세계 · 공고에 Worldwide 명시' : job.remoteCountries.length ? job.remoteCountries.map(code => COUNTRIES.find(([id]) => id === code)?.[1] ?? code).join(' · ') : '국가별 지원 가능 여부 미확인'}</p><small>고용 계약 방식과 협업 시간대는 회사에 확인해 주세요.</small></div></div>}
      <section className="match-section"><h4><span className="section-icon green"><Check size={15} /></span>이 기회와 연결되는 이유</h4>{reasons.length ? <ul>{reasons.map(reason => <li key={reason}><Check size={14} /><span>{reason}</span></li>)}</ul> : <p className="field-description">선택한 개발 직무에 해당해요. 구체적인 기술 요구사항은 원문에서 확인해 주세요.</p>}<div className="skill-list">{job.skills.map(skill => <span className={`skill-tag ${matchedSkills.includes(skill) ? 'matched' : ''}`} key={skill}>{matchedSkills.includes(skill) && <Check size={11} />}{skill}</span>)}</div></section>
      {cautions.length > 0 && <section className="match-section caution"><h4><span className="section-icon amber"><CircleHelp size={15} /></span>함께 확인하면 좋을 것들</h4><ul>{cautions.map(caution => <li key={caution}><span className="caution-bullet" /><span>{caution}</span></li>)}</ul></section>}
      <p className="matching-footnote">입력한 기술·경력과 공고의 문구를 비교한 결과이며, 합격 가능성을 의미하지 않습니다.</p>
      {job.source === 'sample' ? <section className="job-description"><h4>이런 일을 하게 돼요</h4><p>{job.description}</p><h4>이런 경험을 기대해요</h4><ul>{job.requirements.map(item => <li key={item}>{item}</li>)}</ul></section> : <details className="original-description"><summary>채용공고 원문 읽기 <ArrowUpRight size={14} /></summary><div className="job-description"><p>{job.description}</p></div></details>}
      {saved && <section className="saved-note-section"><div><label htmlFor="saved-note">이 기회에 대한 나의 메모</label><button className={`applied-toggle ${saved.status === 'applied' ? 'active' : ''}`} onClick={() => onUpdateSaved({ status: saved.status === 'applied' ? 'saved' : 'applied' })}><CheckCircle2 size={14} />{saved.status === 'applied' ? '지원 완료로 표시됨' : '지원 완료로 표시'}</button></div><textarea id="saved-note" rows={3} maxLength={5000} value={saved.note} placeholder="관심 있는 이유, 준비할 것, 채용 담당자에게 물어볼 내용..." onChange={event => onUpdateSaved({ note: event.target.value })} /><small>이 브라우저에 자동 저장돼요.</small></section>}
      <div className="source-line"><ShieldCheck size={13} /><span>{job.source === 'sample' ? 'ORBIT 샘플 시나리오 · 회사 채용 페이지로 연결' : `Greenhouse 공개 게시판 · ${date} 조회`}</span></div>
    </div>
    <footer className="dialog-footer job-footer"><button className={`button ${saved ? 'saved-button' : 'secondary'}`} onClick={onToggleSave}>{saved ? <BookmarkCheck size={17} /> : <Bookmark size={17} />}{saved ? '저장됨' : '기회 저장'}</button>{url && <a className="button primary" href={url} target="_blank" rel="noopener noreferrer">{job.source === 'sample' ? '회사 채용 페이지' : '원문에서 지원하기'}<ArrowUpRight size={17} /></a>}</footer>
  </Dialog>
}
