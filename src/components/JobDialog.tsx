import { ArrowUpRight, Bookmark, BookmarkCheck, BriefcaseBusiness, Check, CheckCircle2, CircleHelp, Clock3, Globe2, MapPin, ShieldCheck } from 'lucide-react'
import { formatJobSalary, formatSalary, safeExternalUrl } from '../../shared/matching'
import { COMPENSATION_VERSION, EMPLOYMENT_LABELS, JOB_SOURCE_LABELS, MODE_LABELS, VISA_LABELS } from '../../shared/types'
import { REMOTE_SCOPE_CAUTION, remoteScopeLabel } from '../../shared/job-remote'
import type { MatchedJob, SavedJob } from '../../shared/types'
import { CompanyLogo, Dialog } from './ui'
import { JobEvidenceDetails } from './JobEvidenceDetails'
import { JobFreshnessNotice } from './JobFreshnessNotice'
import { CompensationDetails } from './CompensationDetails'
import { JobQualificationDetails } from './JobQualificationDetails'
import { formatExperienceYears } from '../../shared/job-qualifications'
import type { PostingObservation } from '../../shared/posting-status'
import { SavedPostingNotice } from './SavedPostingNotice'
import { JobEligibilityDetails } from './JobEligibilityDetails'
import { sponsorshipTransferSummary } from '../../shared/job-eligibility'
import { isUnmappedJob } from '../../shared/job-location'
import { JobLocationDetails } from './JobLocationDetails'
import { isTechnicalJob } from '../../shared/job-occupation'
import { JobRoleDetails } from './JobRoleDetails'
import type { SavedJobsController } from '../hooks/useSavedJobs'
import { SavedStorageNotice } from './SavedStorageNotice'

interface Props {
  match: MatchedJob
  saved?: SavedJob
  storage: SavedJobsController
  onManageSaved: () => void
  postingObservation?: PostingObservation
  onToggleSave: () => void
  onUpdateSaved: (update: Partial<Pick<SavedJob, 'note' | 'status'>>) => void
  onClose: () => void
}

export function JobDialog({ match, saved, storage, onManageSaved, postingObservation, onToggleSave, onUpdateSaved, onClose }: Props) {
  const { job, company, matchedSkills, reasons, cautions } = match
  const technical = isTechnicalJob(job)
  const url = safeExternalUrl(job.url)
  const date = new Date(job.fetchedAt).toLocaleDateString('ko-KR')
  const verifiedSalary = job.salary && (job.source === 'sample' || job.compensationVersion === COMPENSATION_VERSION)
  return <Dialog title={company.name} eyebrow={company.industry} onClose={onClose} className="job-dialog">
    <div className="dialog-body">
      {!saved && <SavedStorageNotice storage={storage} onManage={onManageSaved} issuesOnly={storage.ready} />}
      <div className="job-detail-heading"><CompanyLogo company={company} /><div><h3>{job.title}</h3><p><MapPin size={14} />{job.locationLabel}</p></div></div>
      <div className="job-meta-pills"><span><BriefcaseBusiness size={13} />{EMPLOYMENT_LABELS[job.employment]}</span><span><Globe2 size={13} />{MODE_LABELS[job.workMode]}</span><span><Clock3 size={13} />{job.minExperience !== null ? `${formatExperienceYears(job.minExperience)} 이상` : '경력 확인 필요'}</span></div>
      {job.source === 'sample' && <div className="sample-notice"><span className="sample-dot" /><span><strong>체험용 샘플 공고</strong>회사별 채용 여부·기술·보상 조건은 실제 공고가 아닌 예시입니다.</span></div>}
      <JobFreshnessNotice job={job} />
      <JobLocationDetails job={job} />
      {saved && <SavedPostingNotice observation={postingObservation} job={saved.job} />}
      <JobRoleDetails job={job} />
      <div className="job-key-facts"><div><span>{verifiedSalary ? '세전 연봉' : '보상 정보'}</span><strong>{formatJobSalary(job)}</strong>{verifiedSalary && job.salary && job.salary.currency !== 'USD' && <small>약 {formatSalary(job.salary, true)} USD / 년</small>}</div><div><span>비자 지원</span><strong className={job.visa === 'conditional' ? 'conditional-visa' : job.visa === 'yes' ? 'text-accent' : ''}>{VISA_LABELS[job.visa]}</strong><small>{job.source === 'sample' ? '샘플 시나리오 기준' : sponsorshipTransferSummary(job) ?? '공고의 명시적 문구 기준'}</small></div></div>
      <CompensationDetails job={job} />
      {job.workMode === 'remote' && <div className="remote-scope"><Globe2 size={18} /><div><strong>명시된 원격근무 지역</strong><p>{remoteScopeLabel(job)}</p><small>{REMOTE_SCOPE_CAUTION}</small></div></div>}
      {isUnmappedJob(job) && job.locationResolution?.status !== 'conflict' && <div className="unmapped-job-notice"><MapPin size={17} /><div><strong>지도에 표시되지 않은 근무지</strong><p>위에 적힌 공고의 위치를 확인해 주세요. 제공 도시 밖이거나 도시를 특정하기 어려워 지도에는 표시하지 않아요. 출근 장소와 근무 형태는 원문에서 다시 확인해 주세요.</p></div></div>}
      <JobEvidenceDetails evidence={job.evidence} />
      <JobEligibilityDetails job={job} />
      <section className="match-section"><h4><span className={`section-icon ${technical ? 'green' : 'amber'}`}>{technical ? <Check size={15} /> : <CircleHelp size={15} />}</span>{technical ? '이 기회와 연결되는 이유' : '입력 정보와 공고의 조건'}</h4>{reasons.length ? <ul>{reasons.map(reason => <li key={reason}><Check size={14} /><span>{reason}</span></li>)}</ul> : <p className="field-description">현재 입력 정보에서 공고와 연결되는 조건을 확인하지 못했어요. 실제 업무와 자격 조건은 원문에서 확인해 주세요.</p>}{!job.qualifications && <div className="skill-list">{job.skills.map(skill => <span className={`skill-tag ${matchedSkills.includes(skill) ? 'matched' : ''}`} key={skill}>{matchedSkills.includes(skill) && <Check size={11} />}{skill}</span>)}</div>}</section>
      <JobQualificationDetails job={job} matchedSkills={matchedSkills} />
      {cautions.length > 0 && <section className="match-section caution"><h4><span className="section-icon amber"><CircleHelp size={15} /></span>함께 확인하면 좋을 것들</h4><ul>{cautions.map(caution => <li key={caution}><span className="caution-bullet" /><span>{caution}</span></li>)}</ul></section>}
      <p className="matching-footnote">입력한 기술·경력과 공고의 문구를 비교한 결과이며, 합격 가능성을 의미하지 않습니다.</p>
      {job.source === 'sample' ? <section className="job-description"><h4>이런 일을 하게 돼요</h4><p>{job.description}</p><h4>이런 경험을 기대해요</h4><ul>{job.requirements.map(item => <li key={item}>{item}</li>)}</ul></section> : <details className="original-description"><summary>채용공고 원문 읽기 <ArrowUpRight size={14} /></summary><div className="job-description"><p>{job.description}</p></div></details>}
      {saved && <section className="saved-note-section"><div><label htmlFor="saved-note">이 기회에 대한 나의 메모</label><button className={`applied-toggle ${saved.status === 'applied' ? 'active' : ''}`} onClick={() => onUpdateSaved({ status: saved.status === 'applied' ? 'saved' : 'applied' })}><CheckCircle2 size={14} />{saved.status === 'applied' ? '지원 완료로 표시됨' : '지원 완료로 표시'}</button></div><textarea id="saved-note" rows={3} maxLength={5000} value={saved.note} placeholder="관심 있는 이유, 준비할 것, 채용 담당자에게 물어볼 내용..." onChange={event => onUpdateSaved({ note: event.target.value })} /><SavedStorageNotice storage={storage} onManage={onManageSaved} /></section>}
      <div className="source-line"><ShieldCheck size={13} /><span>{job.source === 'sample' ? 'ORBIT 샘플 시나리오 · 회사 채용 페이지로 연결' : `${JOB_SOURCE_LABELS[job.source]} 공개 게시판 · ${date} 조회`}</span></div>
    </div>
    <footer className="dialog-footer job-footer"><button className={`button ${saved ? 'saved-button' : 'secondary'}`} disabled={!storage.ready} onClick={onToggleSave}>{saved ? <BookmarkCheck size={17} /> : <Bookmark size={17} />}{saved ? storage.phase === 'saving' ? '저장 중' : storage.pending ? '목록에서 제거' : '저장됨' : storage.ready ? '기회 저장' : '저장소 확인 중'}</button>{url && <a className="button primary" href={url} target="_blank" rel="noopener noreferrer">{job.source === 'sample' ? '회사 채용 페이지' : '원문에서 지원하기'}<ArrowUpRight size={17} /></a>}</footer>
  </Dialog>
}
