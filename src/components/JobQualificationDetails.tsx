import { Check, ChevronDown, ListChecks } from 'lucide-react'
import { formatExperienceYears } from '../../shared/job-qualifications'
import { QUALIFICATION_LABELS } from '../../shared/types'
import type { Job, QualificationKind } from '../../shared/types'

const kinds: QualificationKind[] = ['required', 'qualification', 'preferred', 'context']
const explanations: Record<QualificationKind, string> = {
  required: '필수·최소 요건으로 명시된 항목입니다. 선택 가능한 기술도 있으니 원문을 함께 확인하세요.',
  qualification: '지원자에게 기대하는 자격 항목입니다. 모두 필수라고 명시된 것은 아닙니다.',
  preferred: '추가로 도움이 되는 경험입니다. 없는 기술을 필수 조건의 부족으로 보지 않습니다.',
  context: '업무나 본문에서 언급한 기술입니다. 지원자의 필수 경험으로 판단하지 않습니다.',
}

export function JobQualificationDetails({ job, matchedSkills }: { job: Job; matchedSkills: string[] }) {
  const qualifications = job.qualifications
  if (!qualifications) return null
  return <section className="job-qualifications" aria-label="기술과 경력 조건">
    <h4><ListChecks size={17} />공고의 기술·경력 조건</h4>
    <p className="qualification-intro">공고의 자격 항목과 우대 사항을 구분했어요. 표시한 기술은 입력한 프로필과 비교하며, 원문에서 세부 조건을 확인할 수 있습니다.</p>
    {kinds.map(kind => {
      const rules = qualifications.skills.filter(rule => rule.kind === kind)
      if (!rules.length) return null
      const skills = [...new Set(rules.flatMap(rule => rule.skills))]
      return <div className={`qualification-group ${kind}`} key={kind} data-kind={kind}>
        <h5>{QUALIFICATION_LABELS[kind]}<small>{skills.length}개 기술</small></h5>
        <p className="qualification-help">{explanations[kind]}</p>
        <div className="skill-list">{skills.map(skill => {
          const matched = kind !== 'context' && matchedSkills.includes(skill)
          return <span className={`skill-tag ${matched ? 'matched' : ''}`} key={skill}>{matched && <Check size={11} />}{skill}</span>
        })}</div>
        <details className="qualification-evidence">
          <summary>{rules.length}개 원문과 선택 조건<ChevronDown size={13} /></summary>
          <ul>{rules.map((rule, index) => <li key={index}>
            {rule.match === 'any' && <span className="qualification-relation">이 중 하나 · {rule.skills.join(' / ')}</span>}
            {rule.match === 'unspecified' && <span className="qualification-relation">예시·선택 관계는 원문 확인</span>}
            <blockquote>{rule.evidence.text}</blockquote>
          </li>)}</ul>
        </details>
      </div>
    })}
    {!qualifications.skills.some(rule => rule.kind !== 'context') && <p className="qualification-empty">기술 자격 요건을 구분할 수 있는 문구를 찾지 못했어요. 원문 전체를 확인해 주세요.</p>}
    {qualifications.experience.length > 0 && <div className="qualification-experience">
      <h5>경력 연수의 원문</h5>
      <p className="qualification-help">전체 경력 연수만 비교합니다. 해당 분야의 경험과 학력 조건도 함께 확인해 주세요.</p>
      {qualifications.experience.map((rule, index) => <details className="qualification-evidence experience-rule" key={index}>
        <summary><span>{QUALIFICATION_LABELS[rule.kind]}</span><strong>{formatExperienceYears(rule.minYears)}{rule.maxYears === undefined ? ' 이상' : `–${formatExperienceYears(rule.maxYears)}`}</strong>{rule.conditional && <small>적용 조건 확인</small>}<ChevronDown size={13} /></summary>
        <blockquote>{rule.evidence.text}</blockquote>
      </details>)}
    </div>}
    {qualifications.experienceNote && <p className="qualification-note">{qualifications.experienceNote}</p>}
  </section>
}
