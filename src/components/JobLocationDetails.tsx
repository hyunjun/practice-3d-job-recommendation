import { MapPin, MapPinOff } from 'lucide-react'
import type { Job } from '../../shared/types'

export function JobLocationNotice({ job }: { job: Job }) {
  const resolution = job.locationResolution
  if (!resolution) return null
  const conflict = resolution.status === 'conflict'
  return <p className={`job-location-note ${resolution.status}`}>
    {conflict ? <MapPinOff size={13} /> : <MapPin size={13} />}
    <span>{conflict ? '게시 위치·본문의 근무지가 달라요' : '제목·본문의 근무지로 표시'}</span>
  </p>
}

export function JobLocationDetails({ job }: { job: Job }) {
  const resolution = job.locationResolution
  if (!resolution) return null
  const conflict = resolution.status === 'conflict'
  return <section className={`job-location-details ${resolution.status}`} aria-label="근무지 판단">
    <h4>{conflict ? '근무지 정보 확인 필요' : '현재 근무지 기준으로 표시했어요'}</h4>
    <p>{conflict
      ? '게시 위치와 본문의 근무지가 달라 지도에는 표시하지 않았어요. 실제 출근 장소를 원문에서 확인해 주세요.'
      : '제목과 본문에 같은 근무지가 명시되어 있어 이 위치에 연결했어요. 근무 기간, 지원자 거주지, 이후 전환 조건은 아래 원문을 함께 확인해 주세요.'}</p>
    <dl>
      <div><dt>원래 게시 위치</dt><dd>{resolution.listedLabel}</dd></div>
      <div><dt>{conflict ? '본문의 근무지' : '현재 근무지'}</dt><dd>{resolution.statedLabel}</dd></div>
    </dl>
    <details><summary>근무지를 판단한 원문</summary>
      {resolution.evidence.map((evidence, index) => <div className="location-evidence" key={`${evidence.source}-${index}`}>
        <strong>{evidence.source === 'title' ? '공고 제목' : evidence.source === 'board' ? '공개 게시판 정보' : '공고 본문'}</strong>
        <blockquote>{evidence.text}</blockquote>
      </div>)}
    </details>
  </section>
}
