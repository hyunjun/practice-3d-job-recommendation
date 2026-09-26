import { z } from 'zod'
import { COUNTRY_BY_CODE } from './countries'
import { isTalentPoolJob } from './job-posting'
import { isTechnicalJob } from './job-occupation'
import { jobRoles } from './job-roles'
import { workplaceCountryInfo } from './job-workplace'
import { JobProviderSchema } from './schemas'
import { CATALOG_LIFETIME } from './catalog-freshness'
import {
  EMPLOYMENT_VERSION, JOB_ROLES, OCCUPATION_VERSION, POSTING_PURPOSE_VERSION,
  QUALIFICATIONS_VERSION, REMOTE_SCOPE_VERSION, ROLE_CLASSIFICATION_VERSION,
} from './types'
import type { Company, Job } from './types'

// Bump the leading version when aggregation, country interpretation or skill
// extraction changes without a corresponding source interpretation version.
export const OBSERVATION_METHOD = `observations-1.occupation-${OCCUPATION_VERSION}.roles-${ROLE_CLASSIFICATION_VERSION}.qualifications-${QUALIFICATIONS_VERSION}.remote-${REMOTE_SCOPE_VERSION}.employment-${EMPLOYMENT_VERSION}.purpose-${POSTING_PURPOSE_VERSION}`
export const OBSERVATION_RETENTION_DAYS = 90 as const
export const OBSERVATION_REGIONS = ['americas', 'europe', 'asia-pacific', 'remote', 'other', 'unknown'] as const
export const OBSERVATION_ROLES = [...JOB_ROLES, 'unknown'] as const
export const OBSERVATION_MODES = ['remote', 'hybrid', 'onsite', 'unknown'] as const
export const OBSERVATION_REGION_LABELS: Record<typeof OBSERVATION_REGIONS[number], string> = {
  americas: '미주', europe: '유럽', 'asia-pacific': '아시아 · 태평양',
  remote: '원격근무', other: '그 밖의 확인된 지역', unknown: '지역 일부 또는 전체 미확인',
}

const Count = z.number().int().min(0).max(20_000_000)
const Timestamp = z.iso.datetime({ offset: true })
const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(value => !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value)
const Method = z.string().min(1).max(200)
const ScopeBoardSchema = z.object({
  companyId: z.string().min(1).max(100), name: z.string().min(1).max(200),
  provider: JobProviderSchema, board: z.string().min(1).max(200), boardRegion: z.literal('eu').optional(),
}).refine(value => !value.boardRegion || value.provider === 'lever')
export const ObservationScopeSchema = z.object({
  key: z.string().regex(/^[a-f0-9]{64}$/),
  boards: z.array(ScopeBoardSchema).min(1).max(1000),
}).refine(scope => new Set(scope.boards.map(board => board.companyId)).size === scope.boards.length)

const CompanyCountSchema = z.object({
  companyId: z.string().min(1).max(100), name: z.string().min(1).max(200), count: Count,
})
const SkillCountSchema = z.object({
  name: z.string().min(1).max(100), mentioned: Count, required: Count, qualification: Count, preferred: Count,
}).refine(skill => Math.max(skill.required, skill.qualification, skill.preferred) <= skill.mentioned)
export const ObservationStatsSchema = z.object({
  published: Count, technical: Count, openings: Count, talentPools: Count,
  companies: z.array(CompanyCountSchema).max(1000),
  regions: z.array(z.object({ key: z.enum(OBSERVATION_REGIONS), count: Count })).length(OBSERVATION_REGIONS.length),
  roles: z.array(z.object({ key: z.enum(OBSERVATION_ROLES), count: Count })).length(OBSERVATION_ROLES.length),
  workModes: z.array(z.object({ key: z.enum(OBSERVATION_MODES), count: Count })).length(OBSERVATION_MODES.length),
  skills: z.array(SkillCountSchema).max(100), skillCount: Count,
}).refine(stats => {
  const unique = (values: string[]) => new Set(values).size === values.length
  return stats.technical === stats.openings + stats.talentPools && stats.published >= stats.technical
    && stats.companies.reduce((sum, company) => sum + company.count, 0) === stats.openings
    && stats.workModes.reduce((sum, mode) => sum + mode.count, 0) === stats.openings
    && stats.roles.reduce((sum, role) => sum + role.count, 0) >= stats.openings
    && stats.regions.reduce((sum, region) => sum + region.count, 0) >= stats.openings
    && [...stats.regions, ...stats.roles, ...stats.workModes].every(item => item.count <= stats.openings)
    && stats.skills.every(skill => skill.mentioned <= stats.openings)
    && stats.skillCount >= stats.skills.length
    && unique(stats.companies.map(company => company.companyId)) && unique(stats.skills.map(skill => skill.name))
    && [stats.regions, stats.roles, stats.workModes].every(items => unique(items.map(item => item.key)))
})
export type ObservationStats = z.infer<typeof ObservationStatsSchema>

const ObservationBoardSchema = z.object({
  companyId: z.string().min(1).max(100),
  status: z.enum(['complete', 'missing', 'error', 'stale', 'incomplete']),
  checkedAt: Timestamp.nullable(), lastSuccessAt: Timestamp.nullable(),
})
export const ObservationAttemptSchema = z.object({
  observedAt: Timestamp, recordedAt: Timestamp, origin: z.enum(['cache', 'collection']),
  boards: z.array(ObservationBoardSchema).min(1).max(1000),
}).refine(attempt => new Set(attempt.boards.map(board => board.companyId)).size === attempt.boards.length
  && Date.parse(attempt.observedAt) <= Date.parse(attempt.recordedAt)
  && Math.max(...attempt.boards.map(board => board.checkedAt ? Date.parse(board.checkedAt) : -Infinity)) === Date.parse(attempt.observedAt)
  && attempt.boards.every(board => (!board.checkedAt || Date.parse(board.checkedAt) <= Date.parse(attempt.observedAt))
    && (!board.lastSuccessAt || board.checkedAt && Date.parse(board.lastSuccessAt) <= Date.parse(board.checkedAt))
    && (board.status !== 'missing' || !board.checkedAt && !board.lastSuccessAt)
    && (board.status !== 'complete' || board.checkedAt && board.lastSuccessAt
      && Date.parse(attempt.observedAt) - Date.parse(board.lastSuccessAt) < CATALOG_LIFETIME.freshFor)))
export type ObservationAttempt = z.infer<typeof ObservationAttemptSchema>
export const ObservationPointSchema = ObservationAttemptSchema.safeExtend({
  stats: ObservationStatsSchema,
  /** A legacy cache can describe a distribution without establishing a comparable historical baseline. */
  comparable: z.boolean(),
}).refine(point => point.boards.every(board => board.status === 'complete'))
export type ObservationPoint = z.infer<typeof ObservationPointSchema>
export const ObservationDaySchema = z.object({
  day: Day, latest: ObservationAttemptSchema, complete: ObservationPointSchema.optional(),
}).refine(day => new Date(day.latest.observedAt).toISOString().slice(0, 10) === day.day
  && (!day.complete || new Date(day.complete.observedAt).toISOString().slice(0, 10) === day.day
    && Date.parse(day.complete.observedAt) <= Date.parse(day.latest.observedAt)))
export type ObservationDay = z.infer<typeof ObservationDaySchema>
export const ObservationSeriesSchema = z.object({
  scope: ObservationScopeSchema, method: Method, days: z.array(ObservationDaySchema).max(OBSERVATION_RETENTION_DAYS),
}).refine(series => new Set(series.days.map(day => day.day)).size === series.days.length
  && series.days.every(day => [day.latest, ...(day.complete ? [day.complete] : [])].every(attempt =>
    attempt.boards.length === series.scope.boards.length
    && attempt.boards.every(board => series.scope.boards.some(source => source.companyId === board.companyId))))
  && series.days.every(day => !day.complete || day.complete.stats.companies.length === series.scope.boards.length
    && day.complete.stats.companies.every(company => series.scope.boards.some(board => board.companyId === company.companyId))))
export type ObservationSeries = z.infer<typeof ObservationSeriesSchema>
export const ObservationHistorySchema = z.object({
  version: z.literal(1), retentionDays: z.literal(OBSERVATION_RETENTION_DAYS),
  scope: ObservationScopeSchema, method: Method, days: z.array(ObservationDaySchema).max(OBSERVATION_RETENTION_DAYS),
  otherSeries: z.array(z.object({
    scopeKey: z.string().regex(/^[a-f0-9]{64}$/), method: Method,
    firstDay: Day, lastDay: Day, companyCount: z.number().int().min(1).max(1000),
  // Before the new scope has any observation, all four retained series can be
  // historical. Saving its first point reduces the other series to three.
  })).max(4),
  storage: z.enum(['ok', 'error']), error: z.string().min(1).max(500).optional(),
}).refine(history => ObservationSeriesSchema.safeParse(history).success
  && (history.storage === 'error') === Boolean(history.error))
export type ObservationHistory = z.infer<typeof ObservationHistorySchema>

/** Each dimension counts a posting once, independently of its other dimensions. */
export function buildObservationStats(jobs: Job[], companies: Company[], published: number): ObservationStats {
  const knownCompanies = new Set(companies.map(company => company.id))
  const unique = [...new Map(jobs.filter(job => knownCompanies.has(job.companyId) && isTechnicalJob(job)).map(job => [job.id, job])).values()]
  const openings = unique.filter(job => !isTalentPoolJob(job))
  const regions = new Map<string, number>(OBSERVATION_REGIONS.map(key => [key, 0]))
  const roles = new Map<string, number>(OBSERVATION_ROLES.map(key => [key, 0]))
  const workModes = new Map<string, number>(OBSERVATION_MODES.map(key => [key, 0]))
  const companyCounts = new Map(companies.map(company => [company.id, 0]))
  const skills = new Map<string, z.infer<typeof SkillCountSchema>>()
  const increment = (counts: Map<string, number>, key: string) => counts.set(key, (counts.get(key) ?? 0) + 1)
  for (const job of openings) {
    increment(companyCounts, job.companyId)
    increment(workModes, job.workMode)
    const specialties = jobRoles(job)
    for (const role of new Set(specialties.length ? specialties : ['unknown'])) increment(roles, role)
    if (job.workMode === 'remote') increment(regions, 'remote')
    else {
      const info = workplaceCountryInfo(job)
      const locations = new Set<string>(info.countries.map(code => COUNTRY_BY_CODE.get(code)?.region ?? 'other'))
      if (!locations.size || info.uncertain || info.conflict) locations.add('unknown')
      for (const region of locations) increment(regions, region)
    }
    const rules = job.qualifications?.skills ?? []
    const mentioned = new Set([...job.skills, ...rules.flatMap(rule => rule.skills)].map(skill => skill.trim()).filter(skill => skill && skill.length <= 100))
    for (const name of mentioned) {
      const counts = skills.get(name) ?? { name, mentioned: 0, required: 0, qualification: 0, preferred: 0 }
      counts.mentioned++
      for (const kind of ['required', 'qualification', 'preferred'] as const) {
        if (rules.some(rule => rule.kind === kind && rule.skills.some(skill => skill.trim() === name))) counts[kind]++
      }
      skills.set(name, counts)
    }
  }
  return {
    published, technical: unique.length, openings: openings.length, talentPools: unique.length - openings.length,
    companies: companies.map(company => ({ companyId: company.id, name: company.name, count: companyCounts.get(company.id)! }))
      .sort((left, right) => right.count - left.count || left.companyId.localeCompare(right.companyId, 'en')),
    regions: OBSERVATION_REGIONS.map(key => ({ key, count: regions.get(key)! })),
    roles: OBSERVATION_ROLES.map(key => ({ key, count: roles.get(key)! })),
    workModes: OBSERVATION_MODES.map(key => ({ key, count: workModes.get(key)! })),
    skills: [...skills.values()].sort((left, right) => right.mentioned - left.mentioned || left.name.localeCompare(right.name, 'en')).slice(0, 100),
    skillCount: skills.size,
  }
}

/** Call only with days from one cohort and one interpretation method. */
export function observationComparison(days: ObservationDay[], throughDay?: string) {
  const complete = days.filter(day => day.complete?.comparable && (!throughDay || day.day <= throughDay))
    .sort((left, right) => left.day.localeCompare(right.day))
  if (complete.length < 2) return null
  const previous = complete.at(-2)!
  const current = complete.at(-1)!
  return {
    previousDay: previous.day, currentDay: current.day,
    previous: previous.complete!.stats.openings, current: current.complete!.stats.openings,
    difference: current.complete!.stats.openings - previous.complete!.stats.openings,
  }
}
