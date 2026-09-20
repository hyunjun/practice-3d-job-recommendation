import { Globe2 } from 'lucide-react'
import { countryName } from '../../shared/countries'
import { REMOTE_SCOPE_CAUTION, remoteScopeLabel, remoteScopeNote, upgradeJobRemoteScope } from '../../shared/job-remote'
import type { Job } from '../../shared/types'

export function JobRemoteScopeDetails({ job: previous }: { job: Job }) {
  if (previous.workMode !== 'remote') return null
  const job = upgradeJobRemoteScope(previous)
  const resolution = job.remoteScopeResolution
  return <section className={`remote-scope${resolution?.status === 'unconfirmed' ? ' unconfirmed' : ''}`} aria-label="원격근무 지역">
    <Globe2 size={18} />
    <div>
      <strong>명시된 원격근무 지역</strong>
      <p>{remoteScopeLabel(job)}</p>
      {resolution && <p className="remote-scope-note">{remoteScopeNote(job)}</p>}
      <small>{REMOTE_SCOPE_CAUTION}</small>
      {resolution && <details>
        <summary>원격근무 지역을 판단한 원문</summary>
        <p>게시 위치: {job.locationLabel}</p>
        {(resolution.listedCountries.length > 0 || resolution.listedWorldwide) && <p>게시 위치에서 확인한 지역: {resolution.listedWorldwide ? '전 세계' : resolution.listedCountries.map(countryName).join(' · ')}</p>}
        {resolution.evidence.map((evidence, index) => <blockquote key={index}>{evidence.text}</blockquote>)}
        {resolution.truncated && <small>확인할 문구가 많아 일부만 표시했어요. 전체 공고에서 근무 지역을 확인해 주세요.</small>}
      </details>}
    </div>
  </section>
}
