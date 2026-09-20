import { CITY_BY_ID } from './cities'
import { COUNTRY_BY_CODE, countrySearchText } from './countries'
import { matchingSkills } from './qualification-matching'
import { isUnmappedJob, jobLocationSearchText } from './job-location'
import { jobRoleLabel, matchesJobRole } from './job-roles'
import { isTechnicalJob } from './job-occupation'
import { isTalentPoolJob } from './job-posting'
import { languageSearchText } from './job-languages'
import { upgradeJob } from './job-upgrade'
import { MODE_LABELS, POSTING_TYPE_LABELS, USD_RATES } from './types'
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
  return { entries: catalog.jobs.flatMap(previous => {
    const job = upgradeJob(previous)
    if (!isTechnicalJob(job)) return []
    const company = companies.get(job.companyId)
    if (!company) return []
    const skills = matchingSkills(job)
    const locations = job.cityIds.flatMap(id => {
      const city = CITY_BY_ID.get(id)
      return city ? [city.name, city.en, city.country, city.countryCode] : []
    })
    // A concrete body restriction can narrow a broader posting-region hint.
    // Keep those original hints on the job, but search the now-confirmed countries.
    const regions = job.workMode === 'remote'
      ? [...(job.remoteScopeResolution?.status === 'description' ? [] : job.remoteRegions ?? []),
        ...job.remoteCountries.flatMap(code => COUNTRY_BY_CODE.get(code)?.region ?? [])]
      : job.cityIds.flatMap(id => CITY_BY_ID.get(id)?.region ?? [])
    return [{
      job, company,
      text: [company.name, company.industry, job.title, jobRoleLabel(job), MODE_LABELS[job.workMode],
        isTalentPoolJob(job) ? POSTING_TYPE_LABELS['talent-pool'] : '', ...job.skills, ...locations,
        ...countrySearchText(job.remoteCountries), jobLocationSearchText(job), languageSearchText(job)].join(' ').toLowerCase(),
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
  if (!matchesJobRole(job, filters.role)) failed.push('role')
  if (filters.workMode !== 'all' && job.workMode !== filters.workMode) failed.push('workMode')
  if (filters.visa === 'yes' && job.visa !== 'yes'
    || filters.visa === 'supported' && job.visa !== 'yes' && job.visa !== 'conditional'
    || filters.visa === 'possible' && job.visa === 'no') failed.push('visa')
  if (filters.employment !== 'all' && job.employment !== filters.employment) failed.push('employment')
  const postingType = filters.postingType ?? 'opening'
  if (postingType !== 'all' && isTalentPoolJob(job) !== (postingType === 'talent-pool')) failed.push('postingType')
  if (entry.salaryMax === null && !filters.includeUnknownSalary) failed.push('includeUnknownSalary')
  if (filters.salaryMin > 0 && entry.salaryMax !== null && entry.salaryMax < filters.salaryMin) failed.push('salaryMin')
  if (job.workMode === 'remote' && filters.remoteEligibleOnly && !entry.residenceMatches) failed.push('remoteEligibleOnly')
  if (filters.region !== 'all' && !(job.workMode === 'remote' && job.remoteWorldwide) && !entry.regions.has(filters.region)) failed.push('region')
  if (!words.every(word => entry.text.includes(word))) failed.push('query')
  if ((filters.role === 'all' || filters.role === 'unknown') && !entry.profileMatches) failed.push('profile')
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
