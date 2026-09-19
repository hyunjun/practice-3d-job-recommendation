import { CITY_BY_ID } from './cities'
import { locateCities } from './city-location'
import { countryName, locationCountries } from './countries'
import { REMOTE_SCOPE_VERSION } from './types'
import type { Job } from './types'

type RemoteScope = Pick<Job, 'remoteCountries' | 'remoteWorldwide' | 'remoteScopeUnknown' | 'remoteRegions' | 'remoteScopeVersion'>
const RESTRICTED = /\b(?:except|excluding|outside|not worldwide|not global)\b/i
// Preserve the established display order while adding independent country codes.
const COUNTRY_ORDER = 'US CA GB DE NL FR IE SE CH ES PT SG KR JP AU IN'.split(' ')

export function remoteScope(location: string, retainedCountries: string[] = []): RemoteScope {
  if (RESTRICTED.test(location)) {
    return { remoteCountries: [], remoteWorldwide: false, remoteScopeUnknown: true, remoteScopeVersion: REMOTE_SCOPE_VERSION }
  }
  const remoteWorldwide = /\b(?:worldwide|anywhere in the world|global[\s,·(-]+remote|remote[\s,·(-]+global)\b/i.test(location) || /^global$/i.test(location.trim())
  const countries = new Set(locationCountries(location, retainedCountries))
  for (const id of locateCities(location)) {
    const city = CITY_BY_ID.get(id)
    if (city) countries.add(city.countryCode)
  }
  const remoteRegions: NonNullable<Job['remoteRegions']> = []
  if (/\b(?:americas?|north america|south america)\b/i.test(location) || /\bAMER\b/.test(location)) remoteRegions.push('americas')
  if (/\beurope(?:an(?: union)?)?\b/i.test(location) || /\bEU\b/.test(location)) remoteRegions.push('europe')
  if (/\b(?:asia[\s-]*(?:and |& )?pacific|APAC)\b/i.test(location)) remoteRegions.push('asia-pacific')
  const order = (code: string) => COUNTRY_ORDER.includes(code) ? COUNTRY_ORDER.indexOf(code) : COUNTRY_ORDER.length
  return {
    remoteCountries: [...countries].sort((left, right) => order(left) - order(right) || left.localeCompare(right, 'en')),
    remoteWorldwide, remoteScopeUnknown: !remoteWorldwide && countries.size === 0,
    remoteScopeVersion: REMOTE_SCOPE_VERSION,
    ...(remoteRegions.length ? { remoteRegions } : {}),
  }
}

/** Reinterpret only retained public location information, never the user's residence. */
export function upgradeJobRemoteScope<T extends Job>(job: T): T {
  if (job.source === 'sample' || job.workMode !== 'remote' || job.remoteScopeVersion === REMOTE_SCOPE_VERSION) return job
  const scope = remoteScope(job.locationLabel, job.remoteCountries)
  const worldwide = !RESTRICTED.test(job.locationLabel) && (scope.remoteWorldwide || job.remoteWorldwide)
  const regions = [...new Set([...(job.remoteRegions ?? []), ...(scope.remoteRegions ?? [])])]
  return {
    ...job, ...scope,
    remoteWorldwide: worldwide, remoteScopeUnknown: !worldwide && scope.remoteCountries.length === 0,
    ...(regions.length ? { remoteRegions: regions } : {}),
  }
}

export const REMOTE_SCOPE_CAUTION = '지역에 포함되어도 취업 허가·국적·주별 제한·협업 시간대는 별도로 확인해야 해요.'

export function remoteScopeLabel(job: Job): string {
  const current = upgradeJobRemoteScope(job)
  if (current.workMode !== 'remote') return ''
  return current.remoteWorldwide ? '전 세계 · 공고에 Global / Worldwide 명시'
    : current.remoteCountries.length ? current.remoteCountries.map(countryName).join(' · ') : '국가별 근무 지역 미확인'
}
