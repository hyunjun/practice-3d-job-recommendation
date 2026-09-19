import { z } from 'zod'
import { CITY_BY_ID } from '../../shared/cities'
import { DEFAULT_FILTERS, ELIGIBILITY_LABELS, ELIGIBILITY_LEVEL_LABELS, JOB_ROLES, JOB_SOURCE_LABELS, QUALIFICATION_LABELS, ROLE_FILTER_LABELS, SAMPLE_PROFILE, VISA_LABELS } from '../../shared/types'
import { formatCompensation, formatJobSalary } from '../../shared/matching'
import { formatExperienceYears } from '../../shared/job-qualifications'
import { jobRoleEvidence, jobRoleLabel } from '../../shared/job-roles'
import { jobOccupationLabel, upgradeJobOccupation } from '../../shared/job-occupation'
import { jobFreshness } from '../../shared/catalog-freshness'
import type { Filters, Profile, SavedJob, Source } from '../../shared/types'
import { POSTING_STATE_LABELS, REVISION_LABELS } from '../../shared/posting-status'
import type { PostingObservation } from '../../shared/posting-status'

export const STORAGE_KEYS = {
  profile: 'orbit.v1.profile',
  saved: 'orbit.v1.saved',
  compare: 'orbit.v1.compare',
  exploration: 'orbit.v1.exploration',
} as const

export interface ExplorationState {
  source: Source
  filters: Filters
  selectedId: string | null
  panelTab: 'cities' | 'remote' | 'unmapped'
  mapMode: 'globe' | 'flat'
  light: boolean
  citySort: 'companies' | 'match' | 'salary'
}

const ProfileSchema = z.object({
  kind: z.literal('personal'),
  name: z.string().min(1).max(100),
  headline: z.string().max(200),
  years: z.number().int().min(0).max(50),
  skills: z.array(z.string().min(1).max(60)).max(60),
  desiredRole: z.enum(['all', ...JOB_ROLES]),
  residence: z.string().min(2).max(2),
  linkedinUrl: z.string().max(400),
  preferences: z.object({
    workMode: z.enum(['all', 'remote', 'hybrid', 'onsite', 'unknown']),
    visa: z.enum(['all', 'yes', 'supported', 'possible']),
    salaryMin: z.number().min(0).max(250000),
  }).optional(),
})

function load<T>(key: string, schema: z.ZodType<T>, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return fallback
    const result = schema.safeParse(JSON.parse(raw))
    return result.success ? result.data : fallback
  } catch { return fallback }
}

export function loadProfile(): Profile {
  return load<Profile>(STORAGE_KEYS.profile, ProfileSchema, SAMPLE_PROFILE)
}

export function loadCompare(): string[] {
  return load(STORAGE_KEYS.compare, z.array(z.string().max(100)).max(3), [])
}

export function loadExploration(profile: Profile): ExplorationState {
  const filters: Filters = { ...DEFAULT_FILTERS, ...profile.preferences, role: profile.desiredRole }
  const fallback: ExplorationState = {
    source: 'sample', filters, selectedId: null,
    panelTab: filters.workMode === 'remote' ? 'remote' : 'cities',
    mapMode: 'globe', light: false, citySort: 'companies',
  }
  // Recover fields independently so an obsolete option does not discard a valid data source.
  const schema = z.object({
    source: z.enum(['sample', 'public', 'greenhouse']).transform(source => source === 'greenhouse' ? 'public' as const : source).catch(fallback.source),
    filters: z.object({
      query: z.string().max(500).catch(filters.query),
      region: z.enum(['all', 'americas', 'europe', 'asia-pacific']).catch(filters.region),
      role: z.enum(['all', ...JOB_ROLES, 'unknown']).catch(filters.role),
      workMode: z.enum(['all', 'remote', 'hybrid', 'onsite', 'unknown']).catch(filters.workMode),
      visa: z.enum(['all', 'yes', 'supported', 'possible']).catch(filters.visa),
      employment: z.enum(['all', 'fulltime', 'parttime', 'permanent', 'contract', 'intern', 'temporary', 'unknown']).catch(filters.employment),
      salaryMin: z.number().int().min(0).max(250000).catch(filters.salaryMin),
      includeUnknownSalary: z.boolean().catch(filters.includeUnknownSalary),
      remoteEligibleOnly: z.boolean().catch(filters.remoteEligibleOnly),
    }).catch(filters),
    selectedId: z.string().refine(id => CITY_BY_ID.has(id)).nullable().catch(null),
    panelTab: z.enum(['cities', 'remote', 'unmapped']).catch(fallback.panelTab),
    mapMode: z.enum(['globe', 'flat']).catch(fallback.mapMode),
    light: z.boolean().catch(fallback.light),
    citySort: z.enum(['companies', 'match', 'salary']).catch(fallback.citySort),
  })
  const state = load<ExplorationState>(STORAGE_KEYS.exploration, schema, fallback)
  if (state.selectedId && state.filters.region !== 'all' && CITY_BY_ID.get(state.selectedId)?.region !== state.filters.region) {
    state.selectedId = null
  }
  return state
}

export function persistExploration(state: ExplorationState, rememberConditions: boolean): boolean {
  return persist(STORAGE_KEYS.exploration, rememberConditions ? state : {
    ...state, filters: { ...DEFAULT_FILTERS }, selectedId: null, panelTab: 'cities',
  })
}

export function persist(key: string, value: unknown): boolean {
  try { localStorage.setItem(key, JSON.stringify(value)); return true }
  catch { return false }
}

export function deleteProfile(): void {
  try { localStorage.removeItem(STORAGE_KEYS.profile) } catch { /* Session remains usable without storage. */ }
  persistExploration(loadExploration(SAMPLE_PROFILE), false)
}

export function exportSavedCsv(saved: SavedJob[], observations?: ReadonlyMap<string, PostingObservation>): void {
  const exportedAt = new Date()
  // Neutralize spreadsheet formulas in imported job titles and user notes.
  const cell = (value: unknown) => {
    const text = String(value ?? '')
    const safe = /^[\s]*[=+\-@\t\r]/.test(text) ? `'${text}` : text
    return `"${safe.replace(/"/g, '""')}"`
  }
  const rows = [
    ['회사', '포지션', '근무지', '데이터', '상태', '저장일', '메모', '채용 링크', '연봉', '보상 조건', '보상 근거', '기술 조건', '경력 조건', '기술·경력 근거', '공개 게시 상태', '게시 목록 확인 시각', '내용 비교', '저장 내용과 다른 항목', '비자 지원', '취업 자격 조건', '취업 자격 근거', '직무 분류', '직무 분류 근거', '탐색 직군', '탐색 직군 근거', '저장 내용의 조회 시각', '내보낼 때의 조회 기록', '내보낸 시각'],
    ...saved.map(item => [
      item.company.name, item.job.title, item.job.locationLabel, JOB_SOURCE_LABELS[item.job.source],
      item.status === 'applied' ? '지원 완료' : '저장됨', item.savedAt, item.note, item.job.url,
      formatJobSalary(item.job),
      [item.job.compensationNote, ...(item.job.compensationRanges?.map(range => `${range.label}: ${formatCompensation(range)}${range.scope ? `\n적용 조건: ${range.scope}` : ''}`) ?? [])].filter(Boolean).join('\n'),
      [...(item.job.compensationRanges?.flatMap(range => range.evidence ? [`${range.label}\n${range.evidence.text}`] : []) ?? []), ...(item.job.compensationEvidence?.map(evidence => evidence.text) ?? [])].join('\n\n'),
      item.job.qualifications?.skills.map(rule => `${QUALIFICATION_LABELS[rule.kind]}: ${rule.skills.join(rule.match === 'any' ? ' 또는 ' : ', ')}${rule.match === 'unspecified' ? ' · 선택 조건 원문 확인' : ''}`).join('\n') ?? '',
      [item.job.qualifications?.experienceNote, ...(item.job.qualifications?.experience.map(rule => `${QUALIFICATION_LABELS[rule.kind]}: ${formatExperienceYears(rule.minYears)}${rule.maxYears === undefined ? ' 이상' : `–${formatExperienceYears(rule.maxYears)}`}${rule.conditional ? ' · 적용 조건 확인' : ''}`) ?? [])].filter(Boolean).join('\n'),
      [...new Set([...(item.job.qualifications?.skills ?? []), ...(item.job.qualifications?.experience ?? [])].map(rule => rule.evidence.text))].join('\n\n'),
      POSTING_STATE_LABELS[observations?.get(item.job.id)?.state ?? (item.job.source === 'sample' ? 'sample' : 'unchecked')],
      observations?.get(item.job.id)?.checkedAt ?? '',
      item.job.source === 'sample' ? '대상 아님' : observations?.get(item.job.id)?.changedFields
        ? observations.get(item.job.id)!.changedFields!.length ? '차이 있음' : '표시 내용 일치' : '미확인',
      observations?.get(item.job.id)?.changedFields?.map(field => REVISION_LABELS[field]).join(' · ') ?? '',
      VISA_LABELS[item.job.visa],
      item.job.eligibility?.rules.map(rule => `${ELIGIBILITY_LABELS[rule.kind]}: ${ELIGIBILITY_LEVEL_LABELS[rule.level]}`).join('\n') ?? '',
      [...new Set(item.job.eligibility?.rules.map(rule => rule.evidence.text) ?? [])].join('\n\n'),
      jobRoleLabel(item.job),
      jobRoleEvidence(item.job).map(evidence => `${ROLE_FILTER_LABELS[evidence.role]} · ${evidence.source === 'title' ? '공고 제목' : evidence.source === 'board' ? '공개 부서·팀' : '연구 업무·자격 원문'}\n${evidence.text}`).join('\n\n'),
      jobOccupationLabel(item.job),
      upgradeJobOccupation(item.job).occupation?.evidence.map(evidence => `${evidence.source === 'title' ? '공고 제목' : evidence.source === 'board' ? '공개 게시판 정보' : '업무·자격 원문'}\n${evidence.text}`).join('\n\n') ?? '',
      item.job.source === 'sample' ? '' : item.job.fetchedAt,
      item.job.source === 'sample' ? '체험용 샘플' : { fresh: '최근 조회', stale: '이전 조회', expired: '확인 기간 지남', unknown: '조회 시각 미확인' }[jobFreshness(item.job, exportedAt.getTime())],
      exportedAt.toISOString(),
    ]),
  ]
  const blob = new Blob(['\ufeff', rows.map(row => row.map(cell).join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `orbit-saved-${new Date().toISOString().slice(0, 10)}.csv`
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
