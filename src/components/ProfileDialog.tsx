import { useRef, useState } from 'react'
import { ArrowLeft, ArrowRight, Check, CheckCheck, FileText, Fingerprint, Link2, Plus, ShieldCheck, Sparkles, Upload, X } from 'lucide-react'
import { analyzeResume, KNOWN_SKILLS } from '../../shared/profile'
import { COUNTRIES, MODE_LABELS, ROLE_LABELS } from '../../shared/types'
import type { Filters, Profile } from '../../shared/types'
import { readResume } from '../lib/resume'
import { Dialog, OrbitLogo, Spinner, Toggle } from './ui'

const EXAMPLE_RESUME = `Alex Kim\nSoftware Engineer · 5 years of experience\n\n핀테크 스타트업에서 결제 API와 내부 제품을 개발했습니다.\nTypeScript, React, Node.js를 사용해 프론트엔드와 백엔드를 함께 만들었고,\nPython과 PostgreSQL로 데이터 파이프라인을 구축했습니다.\nAWS 환경에서 서비스를 배포하고 운영한 경험이 있습니다.\n\n새로운 나라에서 글로벌 팀과 함께 성장하고 싶습니다.`

interface Props {
  profile: Profile
  filters: Filters
  onApply: (profile: Profile, preferences: Partial<Filters>, remember: boolean) => void
  onDelete: () => void
  onClose: () => void
}

export function ProfileDialog({ profile, filters, onApply, onDelete, onClose }: Props) {
  const [step, setStep] = useState(profile.kind === 'personal' ? 2 : 1)
  const [tab, setTab] = useState<'text' | 'file' | 'linkedin'>('file')
  const [text, setText] = useState('')
  const [linkedin, setLinkedin] = useState(profile.linkedinUrl)
  const [draft, setDraft] = useState<Profile>({ ...profile, kind: 'personal' })
  const [preferences, setPreferences] = useState({ workMode: filters.workMode, visa: filters.visa, salaryMin: filters.salaryMin })
  const [warnings, setWarnings] = useState<string[]>([])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [fileName, setFileName] = useState('')
  const [dragging, setDragging] = useState(false)
  const [skill, setSkill] = useState('')
  const [remember, setRemember] = useState(true)
  const fileRef = useRef<HTMLInputElement>(null)

  const importFile = async (file?: File) => {
    if (!file) return
    setBusy(true)
    setError('')
    try {
      const content = await readResume(file)
      setText(content.slice(0, 50000))
      setFileName(file.name)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '파일을 읽지 못했어요. 텍스트를 직접 붙여넣어 주세요.')
    } finally { setBusy(false) }
  }

  const analyze = () => {
    setError('')
    if (text.trim().length < 30) { setError('분석할 경력 내용을 30자 이상 입력해 주세요.'); return }
    if (linkedin && !/^https:\/\/(?:www\.)?linkedin\.com\/in\/[^/?#]+\/?(?:[?#].*)?$/.test(linkedin.trim())) {
      setError('https://www.linkedin.com/in/ 으로 시작하는 프로필 주소를 입력해 주세요.')
      return
    }
    const result = analyzeResume(text)
    setDraft({ ...result.profile, linkedinUrl: linkedin.trim() })
    setWarnings(result.warnings)
    setStep(2)
  }

  const addSkill = () => {
    const value = skill.trim().slice(0, 60)
    if (!value) return
    if (!draft.skills.some(item => item.toLowerCase() === value.toLowerCase()) && draft.skills.length < 60) {
      const canonical = KNOWN_SKILLS.find(item => item.toLowerCase() === value.toLowerCase()) ?? value
      setDraft(previous => ({ ...previous, skills: [...previous.skills, canonical] }))
    }
    setSkill('')
  }

  const submit = () => {
    if (!draft.name.trim()) { setError('프로필 이름을 입력해 주세요. 별명도 좋아요.'); return }
    if (!draft.skills.length && draft.desiredRole === 'all') { setError('기술을 하나 이상 추가하거나 희망 직무를 선택해 주세요.'); return }
    onApply({ ...draft, name: draft.name.trim(), kind: 'personal' }, { ...preferences, role: draft.desiredRole }, remember)
  }

  return <Dialog title={step === 1 ? '커리어의 다음 좌표를 찾아보세요.' : '당신의 경험을 이렇게 이해했어요.'} eyebrow="YOUR CAREER, A WORLD OF POSSIBILITIES" onClose={onClose} className="profile-dialog">
    <div className="profile-layout">
      <aside className="profile-story">
        <div className="profile-orbit-art"><div className="profile-orbit-ring ring-one" /><div className="profile-orbit-ring ring-two" /><OrbitLogo /><span className="orbit-satellite one" /><span className="orbit-satellite two" /></div>
        <p className="eyebrow">A LITTLE ABOUT YOU</p>
        <h3>세상은 넓고,<br />당신의 가능성은<br /><em>더 넓으니까.</em></h3>
        <p>쌓아온 경험이 새로운 도시의<br />어떤 기회와 연결되는지 발견하세요.</p>
        <ol className="profile-steps">
          <li className={step === 1 ? 'active' : 'done'}><span>{step > 1 ? <Check size={13} /> : '01'}</span>경력 가져오기</li>
          <li className={step === 2 ? 'active' : ''}><span>02</span>경험과 희망 조건 확인</li>
          <li><span>03</span>나만의 기회 지도 만나기</li>
        </ol>
        <div className="privacy-note"><ShieldCheck size={17} /><span>파일과 경력 원문은 브라우저에서만 읽고<br />외부 분석 서비스로 보내지 않아요.</span></div>
      </aside>
      <section className="profile-form">
        {step === 1 ? <>
          <div className="segmented profile-input-tabs" aria-label="경력 입력 방법">
            <button className={tab === 'file' ? 'selected' : ''} aria-pressed={tab === 'file'} onClick={() => setTab('file')}><Upload size={15} />이력서</button>
            <button className={tab === 'text' ? 'selected' : ''} aria-pressed={tab === 'text'} onClick={() => setTab('text')}><FileText size={15} />텍스트</button>
            <button className={tab === 'linkedin' ? 'selected' : ''} aria-pressed={tab === 'linkedin'} onClick={() => setTab('linkedin')}><Link2 size={15} />LinkedIn</button>
          </div>
          {tab === 'file' && <>
            <input ref={fileRef} type="file" accept=".pdf,.docx,.txt,.md" className="sr-only" aria-label="이력서 파일 선택" onChange={event => void importFile(event.target.files?.[0])} />
            <button className={`upload-zone ${dragging ? 'dragging' : ''} ${fileName ? 'has-file' : ''}`} disabled={busy} onClick={() => fileRef.current?.click()} onDragOver={event => { event.preventDefault(); setDragging(true) }} onDragLeave={() => setDragging(false)} onDrop={event => { event.preventDefault(); setDragging(false); void importFile(event.dataTransfer.files[0]) }}>
              <span className="upload-icon">{busy ? <Spinner /> : fileName ? <CheckCheck size={25} /> : <Upload size={25} />}</span>
              <strong>{busy ? '브라우저에서 이력서를 읽고 있어요' : fileName || '이력서를 이곳에 놓아주세요'}</strong>
              <span>{fileName ? '클릭해서 다른 파일 선택' : '또는 클릭해서 파일 선택'}</span>
              <small>PDF, DOCX, TXT, MD · 최대 5MB</small>
            </button>
            {fileName && <p className="success-text"><Check size={13} />{text.length.toLocaleString()}자의 경력 텍스트를 읽었어요.</p>}
          </>}
          {tab === 'linkedin' && <div className="field-group">
            <label htmlFor="linkedin-url">LinkedIn 프로필 주소 <span className="optional">선택</span></label>
            <input id="linkedin-url" type="url" value={linkedin} onChange={event => setLinkedin(event.target.value)} placeholder="https://www.linkedin.com/in/your-name" maxLength={400} />
            <p className="field-description">주소는 참고용으로 저장해요. 소개와 경력 내용을 아래에 직접 붙여넣어 주세요.</p>
          </div>}
          {(tab !== 'file' || fileName) && <div className="field-group">
            <label htmlFor="resume-text">{tab === 'file' ? '읽어온 경력 · 필요한 부분을 수정하세요' : '경력 요약'}</label>
            <textarea id="resume-text" value={text} onChange={event => setText(event.target.value)} maxLength={50000} rows={tab === 'file' ? 5 : 9} placeholder={'지금까지 어떤 일을 해오셨나요?\n\n예: 5년차 백엔드 개발자입니다. Python, TypeScript와 AWS로 결제 서비스를 개발했으며...'} />
            <div className="field-meta"><span>이름과 연락처는 포함하지 않아도 괜찮아요.</span><span>{text.length.toLocaleString()}자</span></div>
          </div>}
          {!fileName && tab === 'file' && <div className="profile-alternative"><span>파일이 없어도 괜찮아요</span><button className="text-button" onClick={() => setTab('text')}>경력 직접 입력 <ArrowRight size={14} /></button></div>}
          {error && <p className="form-error" role="alert">{error}</p>}
          <button className="button primary wide" disabled={busy || text.trim().length < 30} onClick={analyze}><Sparkles size={17} />경력에서 가능성 찾기<ArrowRight size={16} /></button>
          <button className="sample-text-button" onClick={() => { setText(EXAMPLE_RESUME); setTab('text'); setFileName(''); setError('') }}>먼저 샘플 경력으로 체험하기 <ArrowUpRightSmall /></button>
        </> : <>
          <div className="extraction-note"><Fingerprint size={18} /><span>경력에서 찾은 기술과 경험이에요.<br /><strong>빠진 내용이나 희망 조건을 자유롭게 수정하세요.</strong></span></div>
          <div className="form-grid">
            <div className="field-group"><label htmlFor="profile-name">이름 또는 별명</label><input id="profile-name" value={draft.name} maxLength={100} onChange={event => setDraft({ ...draft, name: event.target.value })} /></div>
            <div className="field-group"><label htmlFor="profile-years">개발 경력</label><div className="input-suffix"><input id="profile-years" type="number" min={0} max={50} value={draft.years} onChange={event => setDraft({ ...draft, years: Math.round(Math.max(0, Math.min(50, Number(event.target.value)))) })} /><span>년</span></div></div>
          </div>
          <div className="field-group">
            <label htmlFor="profile-skill">보유 기술 <span className="optional">{draft.skills.length}개</span></label>
            <div className="skill-editor">{draft.skills.map(item => <span className="skill-tag editable" key={item}>{item}<button aria-label={`${item} 삭제`} onClick={() => setDraft({ ...draft, skills: draft.skills.filter(value => value !== item) })}><X size={12} /></button></span>)}</div>
            <div className="skill-add"><input id="profile-skill" value={skill} list="skill-options" maxLength={60} placeholder="기술 추가 · 예: Kubernetes" onChange={event => setSkill(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); addSkill() } }} /><button className="icon-button" aria-label="기술 추가" onClick={addSkill}><Plus size={18} /></button></div>
            <datalist id="skill-options">{KNOWN_SKILLS.map(item => <option key={item} value={item} />)}</datalist>
          </div>
          {warnings.length > 0 && <p className="field-description">{warnings.join(' ')}</p>}
          <div className="form-section-label">다음 커리어에서 바라는 것</div>
          <div className="form-grid">
            <div className="field-group"><label htmlFor="profile-role">희망 직무</label><select id="profile-role" value={draft.desiredRole} onChange={event => setDraft({ ...draft, desiredRole: event.target.value as Profile['desiredRole'] })}>{Object.entries(ROLE_LABELS).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></div>
            <div className="field-group"><label htmlFor="profile-mode">선호 근무 형태</label><select id="profile-mode" value={preferences.workMode} onChange={event => setPreferences({ ...preferences, workMode: event.target.value as Filters['workMode'] })}>{Object.entries(MODE_LABELS).filter(([value]) => value !== 'unknown').map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></div>
            <div className="field-group"><label htmlFor="profile-country">원격근무 시 거주 국가</label><select id="profile-country" value={draft.residence} onChange={event => setDraft({ ...draft, residence: event.target.value })}>{COUNTRIES.map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></div>
            <div className="field-group"><label htmlFor="profile-visa">비자 지원</label><select id="profile-visa" value={preferences.visa} onChange={event => setPreferences({ ...preferences, visa: event.target.value as Filters['visa'] })}><option value="all">상관없음</option><option value="yes">지원 확인된 공고만</option><option value="possible">미확인 공고도 함께 보기</option></select></div>
          </div>
          <div className="salary-field"><label htmlFor="profile-salary">희망 연봉 <strong>{preferences.salaryMin ? `$${preferences.salaryMin / 1000}k 이상` : '제한 없음'}</strong></label><input id="profile-salary" type="range" min={0} max={250000} step={10000} value={preferences.salaryMin} onChange={event => setPreferences({ ...preferences, salaryMin: Number(event.target.value) })} /><p className="field-description">세전 연간 USD 환산 · 공고의 연봉 상한 기준으로 탐색해요.</p></div>
          <Toggle checked={remember} onChange={setRemember} label="이 브라우저에 프로필 기억하기" description="기술·경력·조건만 저장하고, 이력서 원문은 저장하지 않아요." />
          {error && <p className="form-error" role="alert">{error}</p>}
          <div className="profile-form-actions"><button className="button secondary" onClick={() => { setStep(1); setError('') }}><ArrowLeft size={16} />다시 입력</button><button className="button primary" onClick={submit}>내 기회 지도 만들기<ArrowRight size={16} /></button></div>
          {profile.kind === 'personal' && <button className="delete-profile-button" onClick={onDelete}>저장된 프로필 삭제 · 샘플로 돌아가기</button>}
        </>}
      </section>
    </div>
  </Dialog>
}

function ArrowUpRightSmall() {
  return <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true"><path d="M3 9 9 3M3 3h6v6" stroke="currentColor" strokeWidth="1.3" /></svg>
}
