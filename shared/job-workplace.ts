import { CITY_BY_ID } from './cities'
import { countryCode, countrySearchText, locationCountries } from './countries'
import type { FactEvidence, Job } from './types'

type WorkplaceLocation = NonNullable<Job['workplaceLocations']>['locations'][number]

export interface WorkplaceCountryInfo {
  countries: string[]
  uncertain: boolean
  conflict: boolean
  evidence: FactEvidence[]
}

/** Preserve each posting location's country field independently of its display label. */
export function createWorkplaceLocations(locations: WorkplaceLocation[]): Job['workplaceLocations'] {
  const unique = new Map<string, WorkplaceLocation>()
  let truncated = locations.length > 300
  for (const location of locations.slice(0, 300)) {
    const label = location.label.trim()
    const country = location.country?.trim()
    if (!label && !country) continue
    if (label.length > 2000 || country && country.length > 1000) truncated = true
    const entry = {
      label: label.length > 2000 ? `${label.slice(0, 1999)}…` : label,
      ...(country ? { country: country.length > 1000 ? `${country.slice(0, 999)}…` : country } : {}),
    }
    unique.set(JSON.stringify(entry), entry)
  }
  return unique.size ? { version: 1, locations: [...unique.values()], ...(truncated ? { truncated: true } : {}) } : undefined
}

function explicitCountry(value: string): string | undefined {
  const code = countryCode(value)
  // A structured country may say CA; a free-form location may mean California.
  return code && locationCountries(value).includes(code) ? code : undefined
}

/** A country field or address suffix is evidence; a country name inside a city is not. */
function countriesInLabel(label: string): { countries: string[]; uncertain: boolean } {
  const whole = explicitCountry(label.trim())
  if (whole) return { countries: [whole], uncertain: false }
  const countries = new Set<string>()
  let uncertain = false
  for (const part of label.split(/[;|·•/()\n]/)) {
    const text = part.trim()
      .replace(/^(?:hybrid|remote|on[- ]?site|in[- ]?office)\b[\s:–—-]*/i, '')
      .replace(/[\s:–—-]+\b(?:hybrid|remote|on[- ]?site|in[- ]?office)$/i, '').trim()
    if (!text) continue
    const found = new Set<string>()
    const direct = explicitCountry(text)
    if (direct) { countries.add(direct); continue }
    const parts = text.split(',').map(part => part.trim())
    const codes = parts.map(explicitCountry)
    // A strong leading country identifier establishes a country list, as in
    // "US, Canada". Names shared with cities ("Lebanon, Canada") stay addresses.
    const countryLead = /^[A-Z]{3}$/.test(parts[0]) || codes[0] === 'US' || codes[0] === 'GB'
    if (parts.length > 1 && countryLead && codes.every((code): code is string => Boolean(code))) {
      for (const code of codes) countries.add(code)
      continue
    }
    // Use a complete trailing country, keeping "Lebanon, NH, United States" in US.
    const commas = [...text.matchAll(/,/g)]
    for (const comma of commas) {
      const code = explicitCountry(text.slice(comma.index + 1).trim())
      if (code) { found.add(code); break }
    }
    if (!commas.length) {
      for (const item of text.split(/\s+(?:and|or)\s+|&/i)) {
        const code = explicitCountry(item.trim())
        if (code) found.add(code)
      }
    }
    if (!found.size) uncertain = true
    for (const code of found) countries.add(code)
  }
  return { countries: [...countries], uncertain }
}

function cityCountries(ids: string[]): string[] {
  return [...new Set(ids.flatMap(id => CITY_BY_ID.get(id)?.countryCode ?? []))].sort()
}

function sourceEvidence(location: WorkplaceLocation): FactEvidence {
  return {
    source: 'board',
    text: [location.label, location.country ? `국가: ${location.country}` : ''].filter(Boolean).join('\n'),
  }
}

/**
 * Country evidence locates non-remote work; it does not establish residence
 * eligibility, a city coordinate, or an additional mapped workplace.
 */
export function workplaceCountryInfo(job: Job): WorkplaceCountryInfo {
  if (job.workMode === 'remote') return { countries: [], uncertain: false, conflict: false, evidence: [] }
  const resolution = job.locationResolution
  if (resolution) {
    const listed = cityCountries(resolution.listedCityIds)
    const stated = cityCountries(resolution.statedCityIds)
    const agree = listed.length > 0 && listed.length === stated.length && listed.every((code, index) => code === stated[index])
    const countries = resolution.status === 'relocation' ? stated : agree ? listed : []
    return {
      countries, uncertain: !countries.length, conflict: resolution.status === 'conflict' && !agree,
      evidence: [{ source: 'board', text: resolution.listedLabel }, ...resolution.evidence],
    }
  }
  const sources = job.workplaceLocations?.locations ?? [{ label: job.locationLabel }]
  const countries = new Set<string>()
  let uncertain = Boolean(job.workplaceLocations?.truncated)
  let conflict = false
  let unknownCountryField = false
  for (const source of sources) {
    const named = countriesInLabel(source.label)
    if (source.country !== undefined) {
      const structured = countryCode(source.country)
      if (!structured) {
        unknownCountryField = true
        uncertain = true
      } else if (named.countries.some(code => code !== structured)) {
        conflict = true
        uncertain = true
      } else {
        countries.add(structured)
        if (named.countries.length && named.uncertain) uncertain = true
      }
    } else if (named.countries.length) {
      for (const code of named.countries) countries.add(code)
      if (named.uncertain) uncertain = true
    } else uncertain = true
  }
  // These cities already have a verified map identity. Do not geocode new names.
  if (!conflict && !unknownCountryField && job.cityIds.length) {
    const hadCountryEvidence = countries.size > 0
    for (const code of cityCountries(job.cityIds)) countries.add(code)
    if (!hadCountryEvidence && countries.size) uncertain = Boolean(job.workplaceLocations?.truncated)
  }
  return {
    countries: [...countries].sort(), uncertain, conflict,
    evidence: sources.map(sourceEvidence).filter(item => item.text),
  }
}

export function workplaceCountrySearchText(job: Job): string {
  return countrySearchText(workplaceCountryInfo(job).countries).join(' ')
}

/** Compare meaningful country changes, not country-code spelling or newly retained metadata. */
export function workplaceCountryRevision(job: Job) {
  const { countries, uncertain, conflict } = workplaceCountryInfo(job)
  return { countries, uncertain, conflict }
}
