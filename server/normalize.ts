import { CITY_BY_ID } from '../shared/cities'
import { locateCities } from '../shared/city-location'
export { locateCities } from '../shared/city-location'
import { upgradeJobLocation } from '../shared/job-location'
import { classifyJobRoles } from '../shared/job-roles'
import { isTechnicalOccupation, occupationFacts } from '../shared/job-occupation'
import { qualificationFacts } from '../shared/job-qualifications'
import { plainText } from '../shared/text'
export { plainText } from '../shared/text'
import { COMPENSATION_VERSION } from '../shared/types'
import type { Employment, Job, JobManagement, JobProvider, Salary, Visa, WorkMode } from '../shared/types'
import { employmentFact, managementFact, visaFact, workModeFact } from './job-facts'
import { eligibilityFacts } from '../shared/job-eligibility'
import type { Fact } from './job-facts'
import { greenhouseCompensation } from './greenhouse-compensation'

export interface GreenhouseJob {
  id: number
  title: string
  absolute_url: string
  updated_at?: string
  location?: { name?: string }
  content?: string
  offices?: { name?: string; location?: string | null }[]
  metadata?: { name?: string; value?: unknown }[]
  departments?: { name?: string }[]
  pay_input_ranges?: { min_cents?: number; max_cents?: number; currency_type?: string; currency_code?: string; title?: string; blurb?: string }[]
}

export function detectVisa(text: string): Visa {
  return visaFact(text).value
}

const COUNTRY_TERMS: Record<string, RegExp> = {
  US: /\b(?:united states(?: of america)?|usa|u\.s\.a?\.?|us)\b/i, CA: /\bcanada\b/i,
  GB: /\b(?:united kingdom|uk|gbr|great britain)\b/i, DE: /\b(?:germany|deu)\b/i,
  NL: /\b(?:netherlands|nld)\b/i, FR: /\b(?:france|fra)\b/i, IE: /\b(?:ireland|irl)\b/i,
  SE: /\b(?:sweden|swe)\b/i, CH: /\b(?:switzerland|che)\b/i, ES: /\b(?:spain|esp)\b/i,
  PT: /\b(?:portugal|prt)\b/i, SG: /\b(?:singapore|sgp)\b/i, KR: /\b(?:south korea|korea|kor)\b|대한민국/i,
  JP: /\b(?:japan|jpn)\b/i, AU: /\b(?:australia|aus)\b/i, IN: /\b(?:india|ind)\b/i,
}

export function countryCode(value?: string | null): string | undefined {
  if (!value) return undefined
  const normalized = value.trim().toUpperCase().replaceAll('.', '')
  if (Object.hasOwn(COUNTRY_TERMS, normalized)) return normalized
  if (normalized === 'CAN') return 'CA'
  return Object.entries(COUNTRY_TERMS).find(([, pattern]) => new RegExp(`^(?:${pattern.source})$`, 'i').test(normalized))?.[0]
}

export interface PostingLocation {
  label: string
  address?: { addressLocality?: string | null; addressRegion?: string | null; addressCountry?: string | null } | null
}

/** Unknown countries never resolve to a namesake city in the coverage area. */
export function postingCities(locations: PostingLocation[]): string[] {
  return [...new Set(locations.flatMap(location => {
    const country = countryCode(location.address?.addressCountry)
    if (location.address?.addressCountry && !country) return []
    const text = location.address?.addressLocality
      ? [location.address.addressLocality, location.address.addressRegion, location.address.addressCountry].filter(Boolean).join(', ')
      : location.label
    return locateCities(text).filter(id => !country || CITY_BY_ID.get(id)?.countryCode === country)
  }))]
}

export function postingLocationLabel(locations: PostingLocation[], mode: WorkMode): string {
  const names = [...new Set(locations.map(location => location.label || [
    location.address?.addressLocality, location.address?.addressCountry,
  ].filter(Boolean).join(', ')).filter(Boolean))]
  const label = names.join(' · ') || '근무지 미확인'
  const suffix = mode === 'remote' && !/\bremote\b/i.test(label) ? 'Remote' : mode === 'hybrid' && !/\bhybrid\b/i.test(label) ? 'Hybrid' : ''
  return [label.length > 1800 ? `${label.slice(0, 1799)}…` : label, suffix].filter(Boolean).join(' · ')
}

export function remoteScope(location: string): Pick<Job, 'remoteCountries' | 'remoteWorldwide' | 'remoteScopeUnknown' | 'remoteRegions'> {
  if (/\b(?:except|excluding|outside|not worldwide|not global)\b/i.test(location)) {
    return { remoteCountries: [], remoteWorldwide: false, remoteScopeUnknown: true }
  }
  const remoteWorldwide = /\b(?:worldwide|anywhere in the world|global[\s,·(-]+remote|remote[\s,·(-]+global)\b/i.test(location) || /^global$/i.test(location.trim())
  const countries = new Set(Object.entries(COUNTRY_TERMS).filter(([, pattern]) => pattern.test(location)).map(([id]) => id))
  // In free-form locations, distinguish the country code CAN from the verb "can".
  if (/\bCAN\b/.test(location)) countries.add('CA')
  for (const id of locateCities(location)) {
    const city = CITY_BY_ID.get(id)
    if (city) countries.add(city.countryCode)
  }
  const remoteRegions: NonNullable<Job['remoteRegions']> = []
  if (/\b(?:americas?|north america|south america)\b/i.test(location) || /\bAMER\b/.test(location)) remoteRegions.push('americas')
  if (/\beurope(?:an(?: union)?)?\b/i.test(location) || /\bEU\b/.test(location)) remoteRegions.push('europe')
  if (/\b(?:asia[\s-]*(?:and |& )?pacific|APAC)\b/i.test(location)) remoteRegions.push('asia-pacific')
  // "Europe", "EMEA" and "APAC" do not establish legal country eligibility.
  return {
    remoteCountries: [...countries], remoteWorldwide, remoteScopeUnknown: !remoteWorldwide && countries.size === 0,
    ...(remoteRegions.length ? { remoteRegions } : {}),
  }
}

export function postingRemoteScope(locations: PostingLocation[]) {
  const labels = locations.map(location => location.label).join(' · ')
  const scope = remoteScope(labels)
  if (/\b(?:except|excluding|outside|not worldwide|not global)\b/i.test(labels)) return scope
  const countries = new Set(scope.remoteCountries)
  for (const location of locations) {
    // Country-only metadata can qualify a generic location; regional labels and office cities cannot.
    if (/^(?:remote)?$/i.test(location.label.trim()) && !location.address?.addressLocality) {
      const country = countryCode(location.address?.addressCountry)
      if (country) countries.add(country)
    }
  }
  return { ...scope, remoteCountries: [...countries], remoteScopeUnknown: !scope.remoteWorldwide && !countries.size }
}

export function parseSalary(text: string, _cityIds: string[], ranges?: GreenhouseJob['pay_input_ranges']): Salary | null {
  return greenhouseCompensation(text, ranges).salary
}

interface PostingInput extends Pick<Job, 'companyId' | 'title' | 'cityIds' | 'locationLabel' | 'salary' | 'compensationRanges' | 'compensationNote' | 'compensationEvidence' | 'url' | 'fetchedAt'> {
  id: string | number
  provider: JobProvider
  text: string
  workMode: Fact<WorkMode>
  employment: Fact<Employment>
  scope?: ReturnType<typeof remoteScope>
  updatedAt?: string | null
  departments?: string[]
  management?: JobManagement
}

export function normalizePosting(input: PostingInput): Job | null {
  if (!input.id || !/^https:\/\//i.test(input.url)) return null
  const { companyId, title, text, workMode, employment, salary, compensationRanges, compensationNote } = input
  const occupation = occupationFacts({ title, description: text, departments: input.departments, management: input.management })
  if (!isTechnicalOccupation(occupation)) return null
  const eligibility = eligibilityFacts(text)
  const roleClassification = classifyJobRoles(title, input.departments, occupation)
  const job: Job = {
    id: `${input.provider}-${companyId}-${input.id}`, companyId, title,
    role: roleClassification.roles[0] ?? 'unknown', roleClassification, occupation,
    cityIds: input.cityIds, locationLabel: input.locationLabel, workMode: workMode.value,
    employment: employment.value, ...qualificationFacts(text, companyId), salary,
    ...(compensationRanges?.length ? { compensationRanges } : {}),
    ...(compensationNote ? { compensationNote } : {}),
    ...(input.compensationEvidence?.length ? { compensationEvidence: input.compensationEvidence } : {}),
    compensationVersion: COMPENSATION_VERSION,
    visa: eligibility.visa, eligibility: eligibility.eligibility,
    ...(input.scope ?? { remoteCountries: [], remoteWorldwide: false, remoteScopeUnknown: false }),
    evidence: {
      ...(eligibility.visaEvidence ? { visa: eligibility.visaEvidence } : {}),
      ...(workMode.evidence ? { workMode: workMode.evidence } : {}),
      ...(employment.evidence ? { employment: employment.evidence } : {}),
    },
    description: text.slice(0, 26000), requirements: [], url: input.url,
    source: input.provider, updatedAt: input.updatedAt ?? null, fetchedAt: input.fetchedAt,
  }
  return upgradeJobLocation(job, text)
}

export function normalizeJob(raw: GreenhouseJob, companyId: string, fetchedAt: string): Job | null {
  if (!raw.id || typeof raw.title !== 'string' || !/^https:\/\//i.test(raw.absolute_url ?? '')) return null
  const text = plainText(raw.content ?? '')
  const locationName = raw.location?.name?.trim() || ''
  const postingLocation = raw.metadata?.find(item => /^job posting location$|^job location$/i.test(item.name ?? ''))?.value
  const explicitLocations = typeof postingLocation === 'string' ? [postingLocation] : Array.isArray(postingLocation) ? postingLocation.filter(value => typeof value === 'string') as string[] : []
  // These are offices attached to this vacancy, not a company's headquarters.
  // Explicit job-posting metadata takes precedence over potentially broader office tags.
  const officeNames = raw.offices?.map(office => office.location || office.name || '').filter(Boolean) ?? []
  const genericLocation = !locationName || /^(?:hybrid|remote|in[- ]office|on[- ]site|multiple locations|various locations)$/i.test(locationName)
  const locationDetails = explicitLocations.length ? explicitLocations.join(' · ') : genericLocation && officeNames.length ? officeNames.join(' · ') : locationName
  const workMode = workModeFact(locationName, raw.metadata ?? [], text)
  const mode = workMode.value
  const isRemote = mode === 'remote'
  const cityIds = isRemote ? [] : locateCities(locationDetails)
  // A remote post's own location establishes eligibility; office tags do not.
  const remoteLocation = explicitLocations.length ? explicitLocations.join(' · ') : locationName
  const displayLocation = isRemote ? remoteLocation : locationDetails
  const location = [displayLocation || '근무지 미확인', mode === 'remote' && !/\bremote\b/i.test(displayLocation) ? 'Remote' : mode === 'hybrid' && !/\bhybrid\b/i.test(displayLocation) ? 'Hybrid' : ''].filter(Boolean).join(' · ')
  const scope = isRemote ? remoteScope(remoteLocation) : { remoteCountries: [], remoteWorldwide: false, remoteScopeUnknown: false }
  const employment = employmentFact(raw.title, raw.metadata ?? [], text)
  return normalizePosting({
    provider: 'greenhouse', id: raw.id, companyId, title: raw.title, text, fetchedAt,
    departments: Array.isArray(raw.departments) ? raw.departments.flatMap(department => typeof department?.name === 'string' ? [department.name] : []) : [],
    management: managementFact(raw.metadata ?? []),
    cityIds, locationLabel: location, workMode, employment, scope,
    ...greenhouseCompensation(text, raw.pay_input_ranges),
    url: raw.absolute_url, updatedAt: raw.updated_at,
  })
}
