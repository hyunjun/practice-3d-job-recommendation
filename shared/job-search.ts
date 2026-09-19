import { CITY_BY_ID } from './cities'
import { matchingSkills } from './qualification-matching'
import { isUnmappedJob } from './job-location'
import { MODE_LABELS, ROLE_LABELS, USD_RATES } from './types'
import type { Catalog, City, Company, Filters, Job, Profile, Region } from './types'

export type FilterFailure = keyof Filters | 'profile'
export type SearchScope = { kind: 'cities' } | { kind: 'city'; cityId: string } | { kind: 'remote' } | { kind: 'unmapped' }
export interface SearchEntry {
  job: Job
  company: Company
  text: string
  profileMatches: boolean
  residenceMatches: boolean
  salaryMax: number | null
  regions: Set<Region>
  cities: City[]
}
export interface SearchIndex { entries: SearchEntry[] }
export interface SearchCount { jobs: number; companies: number; cities: number }

/** Reuse the same inexpensive predicates for displayed results and recovery previews. */
export function createSearchIndex(catalog: Catalog, profile: Profile): SearchIndex {
  const companies = new Map(catalog.companies.map(company => [company.id, company]))
  const cities = new Map(catalog.cities.map(city => [city.id, city]))
  const profileSkills = new Set(profile.skills.map(skill => skill.toLowerCase()))
  return { entries: catalog.jobs.flatMap(job => {
    const company = companies.get(job.companyId)
    if (!company) return []
    const skills = matchingSkills(job)
    const locations = job.cityIds.flatMap(id => {
      const city = CITY_BY_ID.get(id)
      return city ? [city.name, city.en, city.country, city.countryCode] : []
    })
    const regions = job.workMode === 'remote'
      ? [...(job.remoteRegions ?? []), ...catalog.cities.filter(city => job.remoteCountries.includes(city.countryCode)).map(city => city.region)]
      : job.cityIds.flatMap(id => CITY_BY_ID.get(id)?.region ?? [])
    return [{
      job, company,
      text: [company.name, company.industry, job.title, ROLE_LABELS[job.role], MODE_LABELS[job.workMode], ...job.skills, ...locations, job.locationLabel].join(' ').toLowerCase(),
      profileMatches: !skills.length || !profileSkills.size || skills.some(skill => profileSkills.has(skill.toLowerCase())),
      residenceMatches: job.remoteWorldwide || job.remoteCountries.includes(profile.residence),
      salaryMax: job.salary ? job.salary.max * USD_RATES[job.salary.currency] : null,
      regions: new Set(regions),
      cities: [...new Set(job.cityIds)].flatMap(id => cities.get(id) ?? []),
    }]
  }) }
}

export function searchWords(query: string): string[] {
  return query.toLowerCase().trim().split(/\s+/).filter(Boolean)
}

export function failedSearchFilters(entry: SearchEntry, filters: Filters, words = searchWords(filters.query)): FilterFailure[] {
  const { job } = entry
  const failed: FilterFailure[] = []
  if (filters.role !== 'all' && job.role !== filters.role) failed.push('role')
  if (filters.workMode !== 'all' && job.workMode !== filters.workMode) failed.push('workMode')
  if (filters.visa === 'yes' && job.visa !== 'yes'
    || filters.visa === 'supported' && job.visa !== 'yes' && job.visa !== 'conditional'
    || filters.visa === 'possible' && job.visa === 'no') failed.push('visa')
  if (filters.employment !== 'all' && job.employment !== filters.employment) failed.push('employment')
  if (entry.salaryMax === null && !filters.includeUnknownSalary) failed.push('includeUnknownSalary')
  if (filters.salaryMin > 0 && entry.salaryMax !== null && entry.salaryMax < filters.salaryMin) failed.push('salaryMin')
  if (job.workMode === 'remote' && filters.remoteEligibleOnly && !entry.residenceMatches) failed.push('remoteEligibleOnly')
  if (filters.region !== 'all' && !(job.workMode === 'remote' && job.remoteWorldwide) && !entry.regions.has(filters.region)) failed.push('region')
  if (!words.every(word => entry.text.includes(word))) failed.push('query')
  if (filters.role === 'all' && !entry.profileMatches) failed.push('profile')
  return failed
}

export function selectSearchJobs(index: SearchIndex, filters: Filters): SearchEntry[] {
  const words = searchWords(filters.query)
  return index.entries.filter(entry => !failedSearchFilters(entry, filters, words).length)
}

export function inSearchScope(entry: SearchEntry, scope: SearchScope, region: Region = 'all'): boolean {
  if (scope.kind === 'remote') return entry.job.workMode === 'remote'
  if (scope.kind === 'unmapped') return isUnmappedJob(entry.job) && region === 'all'
  return entry.job.workMode !== 'remote' && entry.cities.some(city =>
    (scope.kind !== 'city' || city.id === scope.cityId) && (region === 'all' || city.region === region),
  )
}

export function countSearchJobs(entries: SearchEntry[], scope: SearchScope, region: Region): SearchCount {
  const included = entries.filter(entry => inSearchScope(entry, scope, region))
  return {
    jobs: included.length, companies: new Set(included.map(entry => entry.company.id)).size,
    cities: new Set(included.flatMap(entry => entry.job.workMode === 'remote' ? [] : entry.cities.filter(city =>
      (scope.kind !== 'city' || city.id === scope.cityId) && (region === 'all' || city.region === region),
    ).map(city => city.id))).size,
  }
}
