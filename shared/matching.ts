import { COMPENSATION_VERSION, ROLE_LABELS, USD_RATES } from './types'
import { formatExperienceYears } from './job-qualifications'
import { matchQualifications } from './qualification-matching'
import { eligibilitySummary, upgradeJobEligibility } from './job-eligibility'
import { createSearchIndex, selectSearchJobs } from './job-search'
import { jobRoles, matchesJobRole } from './job-roles'
import { isTechnicalJob } from './job-occupation'
import { upgradeJobRemoteScope } from './job-remote'
import type { SearchEntry } from './job-search'
import type { Catalog, CityResult, Filters, Job, MatchedJob, Profile, Salary } from './types'

export function toUsd(salary: Salary): { min: number; max: number } {
  return { min: salary.min * USD_RATES[salary.currency], max: salary.max * USD_RATES[salary.currency] }
}

export function formatSalary(salary: Salary | null, usd = false): string {
  if (!salary) return '연봉 미공개'
  const value = usd ? { ...toUsd(salary), currency: 'USD' as const } : salary
  if (value.currency === 'KRW') {
    const short = (n: number) => n >= 100000000 ? `${Number((n / 100000000).toFixed(2))}억` : `${Math.round(n / 10000).toLocaleString('ko-KR')}만`
    return `${short(value.min)}–${short(value.max)} 원`
  }
  const symbol = { USD: '$', EUR: '€', GBP: '£', CAD: 'C$', AUD: 'A$', SGD: 'S$', JPY: '¥', CHF: 'CHF ' }[value.currency]
  const divisor = value.currency === 'JPY' ? 1000000 : 1000
  return `${symbol}${Math.round(value.min / divisor)}–${Math.round(value.max / divisor)}${value.currency === 'JPY' ? 'm' : 'k'}`
}

export function isRemoteEligible(job: Job, country: string): boolean {
  // Geographic coverage only. Residence never establishes permission to work or citizenship.
  job = upgradeJobRemoteScope(job)
  return job.remoteWorldwide || job.remoteCountries.includes(country)
}

export function formatJobSalary(job: Job): string {
  return job.salary ? `${formatSalary(job.salary)}${job.source !== 'sample' && job.compensationVersion !== COMPENSATION_VERSION ? ' · 이전 기록' : ''}` : job.compensationRanges?.length
    ? '별도 보상 조건' : job.compensationNote ? '보상 확인 필요' : '연봉 미공개'
}

export function formatCompensation(range: NonNullable<Job['compensationRanges']>[number]): string {
  const amount = (value: number) => value.toLocaleString('ko-KR', { maximumFractionDigits: 2 })
  const period = { year: '년', month: '월', week: '주', day: '일', hour: '시간', unknown: '기간 미확인' }[range.period]
  const basis = range.basis === 'total' ? ' · 총보상' : range.basis === 'unknown' ? ' · 구성 미확인' : ''
  return `${range.currency ?? '통화 미확인'} ${amount(range.min)}–${amount(range.max)} / ${period}${basis}`
}

export function matchJob(job: Job, profile: Profile): Omit<MatchedJob, 'company' | 'job'> {
  job = upgradeJobRemoteScope(upgradeJobEligibility(job))
  const technical = isTechnicalJob(job)
  const profileSkills = new Set(profile.skills.map(skill => skill.toLowerCase()))
  const qualificationMatch = job.qualifications ? matchQualifications(job, profile) : undefined
  const matchedSkills = qualificationMatch?.matchedSkills ?? job.skills.filter(skill => profileSkills.has(skill.toLowerCase()))
  const missingSkills = qualificationMatch?.missingSkills ?? job.skills.filter(skill => !profileSkills.has(skill.toLowerCase()))
  const skillScore = qualificationMatch?.skillScore ?? (job.skills.length ? matchedSkills.length / job.skills.length * 60 : 12)
  const roleMatches = matchesJobRole(job, profile.desiredRole)
  const roleScore = !technical ? 0 : profile.desiredRole === 'all' ? 15 : roleMatches ? 25 : 0
  // An omitted personal duration contributes no experience signal to ranking.
  const experienceScore = profile.years === null ? 0 : job.minExperience === null ? 8
    : Math.max(0, 15 - Math.max(0, job.minExperience - profile.years) * 5)
  const reasons: string[] = [...(qualificationMatch?.reasons ?? [])]
  const cautions: string[] = [...(qualificationMatch?.cautions ?? [])]
  if (!qualificationMatch && matchedSkills.length) reasons.push(`${matchedSkills.slice(0, 3).join(' · ')} 경험과 연결돼요`)
  if (profile.desiredRole !== 'all' && roleMatches) reasons.push(`희망하는 ${ROLE_LABELS[profile.desiredRole]} 직무 표기가 있어요`)
  if (technical && !jobRoles(job).length) cautions.push('세부 직무를 확인하지 못했어요. 실제 업무 범위는 원문에서 확인해 주세요.')
  if (profile.years !== null && job.minExperience !== null && job.minExperience <= profile.years) reasons.push(job.qualifications
    ? `입력 경력 ${formatExperienceYears(profile.years)} · 공고에서 확인한 연수 하한 ${formatExperienceYears(job.minExperience)}`
    : `경력 ${profile.years}년이 공고의 ${job.minExperience}년 이상 조건에 부합해요`)
  if (job.visa === 'yes') reasons.push('공고에서 비자 지원을 명시했어요')
  if (job.visa === 'conditional') cautions.push('비자 지원을 명시했지만 국가·직무·지원자별 조건이 있어요. 원문 근거를 확인해 주세요.')
  if (job.workMode === 'remote' && isRemoteEligible(job, profile.residence)) reasons.push('선택한 거주 국가가 공고의 원격근무 지역에 포함돼요')
  const eligibility = eligibilitySummary(job)
  if (eligibility) cautions.push(`${eligibility}. 적용 범위는 취업 자격 조건의 원문에서 확인해 주세요.`)
  if (!qualificationMatch && missingSkills.length) cautions.push(`경력에서 확인하지 못한 기술: ${missingSkills.slice(0, 5).join(', ')}`)
  if (!qualificationMatch && !job.skills.length) cautions.push('구체적인 기술 요구사항을 원문에서 확인해 주세요')
  if (profile.years === null) cautions.push('내 경력 연수가 미입력이라 공고의 경력 조건과 비교하지 않았어요. 프로필에서 입력할 수 있습니다.')
  if (profile.years !== null && job.minExperience !== null && job.minExperience > profile.years) cautions.push(`요구 경력 ${formatExperienceYears(job.minExperience)} · 현재 입력한 경력보다 ${formatExperienceYears(job.minExperience - profile.years)} 많아요`)
  if (job.minExperience === null) cautions.push(job.qualifications?.experienceNote || '최소 경력 연수가 확인되지 않았어요')
  if (job.qualifications?.experience.length) cautions.push(profile.years === null
    ? '기술·직무별 경력과 학력 조건의 충족 여부는 원문에서 확인해 주세요.'
    : '전체 경력 연수만 비교합니다. 기술·직무별 경력과 학력 조건의 충족 여부는 원문에서 확인해 주세요.')
  if (job.visa === 'unknown') cautions.push('비자 지원 여부는 회사에 확인이 필요해요')
  if (job.visa === 'no') cautions.push('비자 지원이 없는 공고예요')
  if (!job.salary) cautions.push(job.compensationRanges?.length || job.compensationNote
    ? '급여 구간·통화·지급 기간을 보상 조건에서 확인해 주세요' : '보상 범위가 공개되지 않았어요')
  if (job.workMode === 'unknown') cautions.push('출근·원격 근무 형태를 확인해 주세요')
  if (job.workMode === 'remote' && !isRemoteEligible(job, profile.residence)) cautions.push(job.remoteScopeUnknown ? '원격근무 가능한 국가가 확인되지 않았어요' : '현재 선택한 거주 국가는 명시된 원격근무 지역에 포함되지 않아요')
  if (job.workMode === 'remote') cautions.push('원격근무 시간대와 현지 고용 가능 여부를 최종 확인해 주세요')
  return {
    score: Math.round(skillScore + roleScore + experienceScore), matchedSkills, missingSkills, reasons, cautions,
    skillSummary: qualificationMatch?.skillSummary ?? (matchedSkills.length ? `${matchedSkills.slice(0, 2).join(' · ')} 경험 일치` : '기술 요구사항 확인 필요'),
  }
}

export function filterJobs(catalog: Catalog, profile: Profile, filters: Filters): MatchedJob[] {
  return rankSearchJobs(selectSearchJobs(createSearchIndex(catalog, profile), filters), profile)
}

export function rankSearchJobs(entries: SearchEntry[], profile: Profile): MatchedJob[] {
  return entries.map(({ job, company }) => ({ job, company, ...matchJob(job, profile) }))
    .sort((a, b) => b.score - a.score || a.company.name.localeCompare(b.company.name) || a.job.id.localeCompare(b.job.id))
}

export function groupCities(catalog: Catalog, matches: MatchedJob[], filters: Filters): CityResult[] {
  const byCity = new Map<string, MatchedJob[]>()
  for (const match of matches) {
    if (match.job.workMode === 'remote') continue
    for (const id of new Set(match.job.cityIds)) {
      const items = byCity.get(id) ?? []
      items.push(match)
      byCity.set(id, items)
    }
  }
  return catalog.cities.flatMap(city => {
    if (filters.region !== 'all' && city.region !== filters.region) return []
    const cityMatches = byCity.get(city.id) ?? []
    if (!cityMatches.length) return []
    return [{
      city, matches: cityMatches,
      companyCount: new Set(cityMatches.map(match => match.company.id)).size,
      averageScore: cityMatches.reduce((sum, match) => sum + match.score, 0) / cityMatches.length,
    }]
  }).sort((a, b) => b.companyCount - a.companyCount || b.averageScore - a.averageScore || a.city.en.localeCompare(b.city.en))
}

export function groupCompanies(matches: MatchedJob[]): { company: MatchedJob['company']; matches: MatchedJob[] }[] {
  const grouped = new Map<string, { company: MatchedJob['company']; matches: MatchedJob[] }>()
  for (const match of matches) {
    const entry = grouped.get(match.company.id) ?? { company: match.company, matches: [] }
    entry.matches.push(match)
    grouped.set(match.company.id, entry)
  }
  return [...grouped.values()].sort((a, b) => b.matches[0].score - a.matches[0].score)
}

export function countFilters(filters: Filters): number {
  return Number(filters.role !== 'all') + Number(filters.workMode !== 'all') + Number(filters.visa !== 'all')
    + Number(filters.employment !== 'all') + Number(filters.salaryMin > 0 || !filters.includeUnknownSalary)
    + Number(!filters.remoteEligibleOnly)
}

export function safeExternalUrl(value: string): string | undefined {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : undefined
  } catch { return undefined }
}

export function medianSalary(matches: MatchedJob[]): number | null {
  const salaries = matches.flatMap(({ job }) => job.salary ? [(toUsd(job.salary).min + toUsd(job.salary).max) / 2] : []).sort((a, b) => a - b)
  if (!salaries.length) return null
  const middle = Math.floor(salaries.length / 2)
  return salaries.length % 2 ? salaries[middle] : (salaries[middle - 1] + salaries[middle]) / 2
}
