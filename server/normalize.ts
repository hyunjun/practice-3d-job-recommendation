import { CITY_BY_ID, LOCATION_ALIASES } from '../shared/cities'
import { extractSkills, extractYears, inferRole } from '../shared/profile'
import type { Job, Salary, Visa } from '../shared/types'

export interface GreenhouseJob {
  id: number
  title: string
  absolute_url: string
  updated_at?: string
  location?: { name?: string }
  content?: string
  offices?: { name?: string; location?: string | null }[]
  metadata?: { name?: string; value?: unknown }[]
  pay_input_ranges?: { min_cents?: number; max_cents?: number; currency_code?: string }[]
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
  if (/\b(?:no|without)\s+(?:immigration\s+|work\s+)?(?:visa\s+)?sponsorship\b|\b(?:cannot|can't|can not|do not|does not|will not|unable to|not able to)\s+(?:currently\s+)?(?:provide\s+|offer\s+)?sponsor(?:ship)?(?:\s+(?:for\s+)?(?:work\s+)?visas?)?\b|visa sponsorship\s+(?:is\s+)?not\s+(?:available|provided|offered)/i.test(text)) return 'no'
  if (/\b(?:we\s+)?(?:offer|provide)\s+(?:work\s+)?visa sponsorship\b|\bvisa sponsorship\s+(?:is\s+)?(?:available|provided|offered)\b|\bwe\s+(?:will|can)\s+sponsor\s+(?:work\s+)?visas?\b/i.test(text)) return 'yes'
  return 'unknown'
}

const COUNTRY_TERMS: Record<string, RegExp> = {
  US: /\b(?:united states|usa|u\.s\.a?\.?|us)\b/i, CA: /\bcanada\b/i,
  GB: /\b(?:united kingdom|uk|great britain)\b/i, DE: /\bgermany\b/i,
  NL: /\bnetherlands\b/i, FR: /\bfrance\b/i, IE: /\bireland\b/i,
  SE: /\bsweden\b/i, CH: /\bswitzerland\b/i, ES: /\bspain\b/i,
  PT: /\bportugal\b/i, SG: /\bsingapore\b/i, KR: /\b(?:south korea|korea)\b|대한민국/i,
  JP: /\bjapan\b/i, AU: /\baustralia\b/i, IN: /\bindia\b/i,
}

export function remoteScope(location: string): { remoteCountries: string[]; remoteWorldwide: boolean; remoteScopeUnknown: boolean } {
  const remoteWorldwide = /\b(?:worldwide|anywhere in the world|global remote)\b/i.test(location)
  const countries = new Set(Object.entries(COUNTRY_TERMS).filter(([, pattern]) => pattern.test(location)).map(([id]) => id))
  for (const id of locateCities(location)) {
    const city = CITY_BY_ID.get(id)
    if (city) countries.add(city.countryCode)
  }
  // "Europe", "EMEA" and "APAC" do not establish legal country eligibility.
  return { remoteCountries: [...countries], remoteWorldwide, remoteScopeUnknown: !remoteWorldwide && countries.size === 0 }
}

export function parseSalary(text: string, cityIds: string[], ranges?: GreenhouseJob['pay_input_ranges']): Salary | null {
  const supported = ['USD', 'EUR', 'GBP', 'CAD', 'SGD', 'AUD', 'KRW', 'JPY', 'CHF']
  const structured = ranges?.find(range => typeof range.min_cents === 'number' && typeof range.max_cents === 'number' && supported.includes(range.currency_code ?? ''))
  if (structured && structured.min_cents! >= 1000000 && structured.max_cents! >= structured.min_cents!) {
    return { min: structured.min_cents! / 100, max: structured.max_cents! / 100, currency: structured.currency_code as Salary['currency'] }
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

export function normalizeJob(raw: GreenhouseJob, companyId: string, fetchedAt: string): Job | null {
  if (!raw.id || typeof raw.title !== 'string' || !/^https:\/\//i.test(raw.absolute_url ?? '')) return null
  if (!/engineer|developer|data scientist/i.test(raw.title)) return null
  if (/manager|director|head of|vice president|sales|solutions engineer|support engineer|field engineer|customer engineer|mechanical|electrical|hardware|facilities|manufacturing|recruit/i.test(raw.title)) return null
  const text = plainText(raw.content ?? '')
  const locationName = raw.location?.name?.trim() || ''
  const postingLocation = raw.metadata?.find(item => /^job posting location$|^job location$/i.test(item.name ?? ''))?.value
  const explicitLocations = typeof postingLocation === 'string' ? [postingLocation] : Array.isArray(postingLocation) ? postingLocation.filter(value => typeof value === 'string') as string[] : []
  const workplaceType = raw.metadata?.find(item => /^workplace type$|^work arrangement$|^work location type$/i.test(item.name ?? ''))?.value
  const workplace = typeof workplaceType === 'string' ? workplaceType : ''
  // These are offices attached to this vacancy, not a company's headquarters.
  // Explicit job-posting metadata takes precedence over potentially broader office tags.
  const officeNames = raw.offices?.map(office => office.location || office.name || '').filter(Boolean) ?? []
  const genericLocation = !locationName || /^(?:hybrid|remote|in[- ]office|on[- ]site|multiple locations|various locations)$/i.test(locationName)
  const locationDetails = explicitLocations.length ? explicitLocations.join(' · ') : genericLocation && officeNames.length ? officeNames.join(' · ') : locationName
  const workText = `${locationName} ${workplace}`
  const isRemote = /\bremote\b|원격/i.test(workText)
  const cityIds = isRemote ? [] : locateCities(locationDetails)
  const mode = isRemote ? 'remote' : /\bhybrid\b/i.test(workText) ? 'hybrid' : /\bon[- ]?site\b|\bin[- ]office\b/i.test(workText) ? 'onsite' : 'unknown'
  const role = inferRole(raw.title)
  // A remote post's own location establishes eligibility; office tags do not.
  const remoteLocation = explicitLocations.length ? explicitLocations.join(' · ') : locationName
  const displayLocation = isRemote ? remoteLocation : locationDetails
  const location = [displayLocation || '근무지 미확인', mode === 'remote' && !/\bremote\b/i.test(displayLocation) ? 'Remote' : mode === 'hybrid' && !/\bhybrid\b/i.test(displayLocation) ? 'Hybrid' : ''].filter(Boolean).join(' · ')
  const scope = isRemote ? remoteScope(remoteLocation) : { remoteCountries: [], remoteWorldwide: false, remoteScopeUnknown: false }
  const experience = extractYears(text)
  const employmentMetadata = raw.metadata?.find(item => /employment type|employment_type|commitment/i.test(item.name ?? ''))?.value
  const employmentText = `${raw.title} ${typeof employmentMetadata === 'string' ? employmentMetadata : ''}`
  const employment = /\bintern(?:ship)?\b/i.test(employmentText) ? 'intern' : /\bcontract(?:or)?\b/i.test(employmentText) ? 'contract' : /\bfull[\s-]?time\b/i.test(employmentText) ? 'fulltime' : 'unknown'
  return {
    id: `greenhouse-${companyId}-${raw.id}`, companyId, title: raw.title, role, cityIds,
    locationLabel: location, workMode: mode, employment, minExperience: experience,
    skills: extractSkills(text), salary: parseSalary(text, isRemote ? locateCities(remoteLocation) : cityIds, raw.pay_input_ranges),
    visa: detectVisa(text), ...scope,
    description: text.slice(0, 26000),
    requirements: [],
    url: raw.absolute_url,
    source: 'greenhouse', updatedAt: raw.updated_at ?? null, fetchedAt,
  }
}
