import { CITY_BY_ID, LOCATION_ALIASES } from '../shared/cities'
import { extractSkills, extractYears, inferRole } from '../shared/profile'
import type { Employment, Job, JobProvider, Salary, Visa, WorkMode } from '../shared/types'
import { employmentFact, visaFact, workModeFact } from './job-facts'
import type { Fact } from './job-facts'

export interface GreenhouseJob {
  id: number
  title: string
  absolute_url: string
  updated_at?: string
  location?: { name?: string }
  content?: string
  offices?: { name?: string; location?: string | null }[]
  metadata?: { name?: string; value?: unknown }[]
  pay_input_ranges?: { min_cents?: number; max_cents?: number; currency_type?: string; currency_code?: string }[]
}

export function plainText(html: string): string {
  let result = html
  const entities: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', rsquo: '’', lsquo: '‘' }
  for (let pass = 0; pass < 2; pass++) {
    result = result.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code: string) => {
      if (code.startsWith('#')) {
        const n = code.toLowerCase().startsWith('#x') ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10)
        return n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : ''
      }
      return entities[code.toLowerCase()] ?? whole
    })
  }
  return result.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<\/(?:p|div|li|h[1-6])>|<br\s*\/?>/gi, '\n')
    .replace(/<[^>]*>/g, '').replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n\n').trim()
}

export function locateCities(location: string): string[] {
  const text = location.toLowerCase()
  const ambiguousLocations: Record<string, RegExp> = {
    london: /\blondon,?\s+(?:ontario|on\b|canada)/i,
    paris: /\bparis,?\s+(?:texas|tx\b)/i,
    dublin: /\bdublin,?\s+(?:ohio|oh\b|california|ca\b)/i,
    vancouver: /\bvancouver,?\s+(?:washington|wa\b)/i,
  }
  return Object.entries(LOCATION_ALIASES).filter(([id, aliases]) => !ambiguousLocations[id]?.test(text) && aliases.some(alias => {
    const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return new RegExp(`(^|[^\\p{L}])${escaped}($|[^\\p{L}])`, 'iu').test(text)
  })).map(([id]) => id)
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

export function parseSalary(text: string, cityIds: string[], ranges?: GreenhouseJob['pay_input_ranges']): Salary | null {
  const supported = ['USD', 'EUR', 'GBP', 'CAD', 'SGD', 'AUD', 'KRW', 'JPY', 'CHF']
  const structured = ranges?.find(range => typeof range.min_cents === 'number' && typeof range.max_cents === 'number' && supported.includes(range.currency_type ?? range.currency_code ?? ''))
  if (structured && structured.min_cents! >= 1000000 && structured.max_cents! >= structured.min_cents!) {
    return { min: structured.min_cents! / 100, max: structured.max_cents! / 100, currency: (structured.currency_type ?? structured.currency_code) as Salary['currency'] }
  }
  const pattern = /([$€£])\s*([\d,]{2,9}(?:\.\d+)?)\s*(k)?\s*(?:-|–|—|to)\s*[$€£]?\s*([\d,]{2,9}(?:\.\d+)?)\s*(k)?(?:\s*(USD|EUR|GBP|CAD|SGD|AUD|CHF))?/gi
  for (const match of text.matchAll(pattern)) {
    const context = text.slice(Math.max(0, match.index! - 200), match.index! + match[0].length + 160)
    if (!/salary|base pay|compensation|annual|pay range|per year|annum/i.test(context) || /per hour|hourly|\/hr\b/i.test(context)) continue
    const min = Number(match[2].replace(/,/g, '')) * (match[3] ? 1000 : 1)
    const max = Number(match[4].replace(/,/g, '')) * (match[5] ? 1000 : 1)
    if (min < 10000 || max < min || max > 2000000) continue
    let currency: Salary['currency'] | null = match[6]?.toUpperCase() as Salary['currency'] ?? null
    if (match[1] === '€') currency = 'EUR'
    if (match[1] === '£') currency = 'GBP'
    if (!currency && match[1] === '$') {
      if (/\bUSD\b|US dollars|U\.S\. dollars/i.test(context)) currency = 'USD'
      else if (/\bCAD\b|Canadian dollars/i.test(context)) currency = 'CAD'
      else {
        const countries = [...new Set(cityIds.map(id => CITY_BY_ID.get(id)?.countryCode))]
        if (countries.length === 1 && countries[0] === 'US') currency = 'USD'
        if (countries.length === 1 && countries[0] === 'CA') currency = 'CAD'
      }
    }
    if (currency) return { min, max, currency }
  }
  return null
}

export function isDeveloperTitle(title: string): boolean {
  return /engineer|developer|data scientist/i.test(title)
    && !/manager|director|head of|vice president|sales|solutions engineer|support engineer|field engineer|customer engineer|mechanical|electrical|hardware|facilities|manufacturing|recruit/i.test(title)
}

interface PostingInput extends Pick<Job, 'companyId' | 'title' | 'cityIds' | 'locationLabel' | 'salary' | 'compensationRanges' | 'compensationNote' | 'url' | 'fetchedAt'> {
  id: string | number
  provider: JobProvider
  text: string
  workMode: Fact<WorkMode>
  employment: Fact<Employment>
  scope?: ReturnType<typeof remoteScope>
  updatedAt?: string | null
}

export function normalizePosting(input: PostingInput): Job | null {
  if (!input.id || !/^https:\/\//i.test(input.url) || !isDeveloperTitle(input.title)) return null
  const { companyId, title, text, workMode, employment, salary, compensationRanges, compensationNote } = input
  const visa = visaFact(text)
  return {
    id: `${input.provider}-${companyId}-${input.id}`, companyId, title, role: inferRole(title),
    cityIds: input.cityIds, locationLabel: input.locationLabel, workMode: workMode.value,
    employment: employment.value, minExperience: extractYears(text), skills: extractSkills(text), salary,
    ...(compensationRanges?.length ? { compensationRanges } : {}),
    ...(compensationNote ? { compensationNote } : {}),
    visa: visa.value,
    ...(input.scope ?? { remoteCountries: [], remoteWorldwide: false, remoteScopeUnknown: false }),
    evidence: {
      ...(visa.evidence ? { visa: visa.evidence } : {}),
      ...(workMode.evidence ? { workMode: workMode.evidence } : {}),
      ...(employment.evidence ? { employment: employment.evidence } : {}),
    },
    description: text.slice(0, 26000), requirements: [], url: input.url,
    source: input.provider, updatedAt: input.updatedAt ?? null, fetchedAt: input.fetchedAt,
  }
}

export function normalizeJob(raw: GreenhouseJob, companyId: string, fetchedAt: string): Job | null {
  if (!raw.id || typeof raw.title !== 'string' || !isDeveloperTitle(raw.title) || !/^https:\/\//i.test(raw.absolute_url ?? '')) return null
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
    cityIds, locationLabel: location, workMode, employment, scope,
    salary: parseSalary(text, isRemote ? locateCities(remoteLocation) : cityIds, raw.pay_input_ranges),
    url: raw.absolute_url, updatedAt: raw.updated_at,
  })
}
