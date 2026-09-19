import { countSearchJobs, failedSearchFilters, inSearchScope, searchWords, selectSearchJobs } from './job-search'
import type { FilterFailure, SearchCount, SearchEntry, SearchIndex, SearchScope } from './job-search'
import { EMPLOYMENT_LABELS, MODE_LABELS, REGION_LABELS, ROLE_LABELS, VISA_FILTER_LABELS } from './types'
import type { Filters } from './types'

export interface RecoverySuggestion {
  id: string
  changes: Partial<Filters>
  count: SearchCount
}
export interface RecoveryAnalysis {
  available: number
  profileExcluded: number
  suggestions: RecoverySuggestion[]
  alternatives: { scope: SearchScope; count: SearchCount }[]
}

const ORDER: (keyof Filters)[] = ['query', 'region', 'role', 'workMode', 'employment', 'includeUnknownSalary', 'salaryMin', 'visa', 'remoteEligibleOnly']
const VISA_ORDER = { yes: 0, supported: 1, possible: 2, all: 3 }
const keys = (changes: Partial<Filters>) => ORDER.filter(key => key in changes)
const identity = (changes: Partial<Filters>) => JSON.stringify(keys(changes).map(key => [key, changes[key]]))

function relax(failure: FilterFailure, entry: SearchEntry): Partial<Filters> {
  switch (failure) {
    case 'query': return { query: '' }
    case 'region': return { region: 'all' }
    case 'role': return { role: 'all' }
    case 'workMode': return { workMode: 'all' }
    case 'employment': return { employment: 'all' }
    case 'salaryMin': return { salaryMin: 0 }
    case 'includeUnknownSalary': return { includeUnknownSalary: true }
    case 'remoteEligibleOnly': return { remoteEligibleOnly: false }
    case 'visa': return { visa: entry.job.visa === 'conditional' ? 'supported' : entry.job.visa === 'unknown' ? 'possible' : 'all' }
    case 'profile': return {}
  }
}

function lessRestrictiveChangeExists(smaller: Partial<Filters>, larger: Partial<Filters>): boolean {
  return keys(smaller).every(key => key in larger && (key === 'visa'
    ? VISA_ORDER[smaller.visa!] <= VISA_ORDER[larger.visa!]
    : smaller[key] === larger[key]))
}

/** Derive combinations from actual jobs, rather than guessing or enumerating every filter set. */
export function analyzeSearchRecovery(index: SearchIndex, filters: Filters, scope: SearchScope): RecoveryAnalysis | null {
  const current = selectSearchJobs(index, filters)
  if (countSearchJobs(current, scope, filters.region).jobs) return null
  const scopes: SearchScope[] = scope.kind === 'remote' ? [{ kind: 'cities' }]
    : scope.kind === 'city' ? [{ kind: 'cities' }, { kind: 'remote' }] : [{ kind: 'remote' }]
  const alternatives = scopes.map(next => ({ scope: next, count: countSearchJobs(current, next, filters.region) }))
    .filter(item => item.count.jobs > 0)
  const words = searchWords(filters.query)
  const available = index.entries.filter(entry => inSearchScope(entry, scope))
  const candidates = new Map<string, Partial<Filters>>()
  let profileExcluded = 0
  for (const entry of available) {
    const failed = failedSearchFilters(entry, filters, words)
    if (!inSearchScope(entry, scope, filters.region) && !failed.includes('region')) failed.push('region')
    if (failed.length === 1 && failed[0] === 'profile') profileExcluded++
    if (failed.includes('profile')) continue
    const changes = Object.assign({}, ...failed.map(failure => relax(failure, entry))) as Partial<Filters>
    // "All roles" enables the existing profile-skill match rule. Removing a role is not
    // necessarily an expansion, so never promise a job that the resulting filter excludes.
    if (changes.role === 'all' && !entry.profileMatches || !keys(changes).length) continue
    candidates.set(identity(changes), changes)
  }
  const cost = (changes: Partial<Filters>) => keys(changes).reduce((total, key) => total + ORDER.indexOf(key), 0)
  const sorted = [...candidates].sort(([aId, a], [bId, b]) => keys(a).length - keys(b).length
    || cost(a) - cost(b) || VISA_ORDER[a.visa ?? filters.visa] - VISA_ORDER[b.visa ?? filters.visa]
    || (aId < bId ? -1 : aId > bId ? 1 : 0))
  const suggestions: RecoverySuggestion[] = []
  for (const [id, changes] of sorted) {
    if (suggestions.some(suggestion => lessRestrictiveChangeExists(suggestion.changes, changes))) continue
    const next = { ...filters, ...changes }
    const count = countSearchJobs(selectSearchJobs(index, next), scope, next.region)
    if (!count.jobs) continue
    suggestions.push({ id, changes, count })
    if (suggestions.length === 3) break
  }
  return { available: available.length, profileExcluded, suggestions, alternatives }
}

export function describeRecoveryChanges(filters: Filters, changes: Partial<Filters>) {
  const next = { ...filters, ...changes }
  return keys(changes).map(key => ({
    key, label: {
      query: '검색어', region: '탐색 지역', role: '직무', workMode: '근무 형태', employment: '고용 형태',
      salaryMin: '희망 연봉 하한', includeUnknownSalary: '미공개·별도 보상', visa: '비자 지원', remoteEligibleOnly: '원격근무 지역',
    }[key],
    before: describeFilter(filters, key), after: describeFilter(next, key),
  }))
}

function describeFilter(filters: Filters, key: keyof Filters): string {
  switch (key) {
    case 'query': return filters.query.trim() ? `“${filters.query.trim().slice(0, 70)}${filters.query.trim().length > 70 ? '…' : ''}”` : '검색어 지우기'
    case 'region': return REGION_LABELS[filters.region]
    case 'role': return ROLE_LABELS[filters.role]
    case 'workMode': return MODE_LABELS[filters.workMode]
    case 'employment': return EMPLOYMENT_LABELS[filters.employment]
    case 'salaryMin': return filters.salaryMin ? `$${filters.salaryMin.toLocaleString('ko-KR')} 이상` : '연봉 하한 해제'
    case 'includeUnknownSalary': return filters.includeUnknownSalary ? '미공개·별도 보상도 포함' : '비교 가능한 연봉만'
    case 'visa': return filters.visa === 'all' ? '지원 없음까지 포함' : VISA_FILTER_LABELS[filters.visa]
    case 'remoteEligibleOnly': return filters.remoteEligibleOnly ? '거주 국가가 포함된 공고만' : '범위 밖·미확인도 포함'
  }
}

/** Undo only fields that still contain this action's value; preserve later user edits. */
export function undoRecoveryChanges(current: Filters, previous: Filters, changes: Partial<Filters>): Filters {
  const restore = Object.fromEntries(keys(changes).filter(key => current[key] === changes[key]).map(key => [key, previous[key]]))
  return { ...current, ...restore }
}
