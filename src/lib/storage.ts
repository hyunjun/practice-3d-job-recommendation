import { z } from 'zod'
import { CITY_BY_ID } from '../../shared/cities'
import { JobSchema } from '../../shared/schemas'
import { DEFAULT_FILTERS, SAMPLE_PROFILE } from '../../shared/types'
import type { Filters, Profile, SavedJob, Source } from '../../shared/types'

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
  panelTab: 'cities' | 'remote'
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
  desiredRole: z.enum(['all', 'backend', 'frontend', 'fullstack', 'ml', 'data', 'devops', 'mobile', 'security']),
  residence: z.string().min(2).max(2),
  linkedinUrl: z.string().max(400),
  preferences: z.object({
    workMode: z.enum(['all', 'remote', 'hybrid', 'onsite', 'unknown']),
    visa: z.enum(['all', 'yes', 'supported', 'possible']),
    salaryMin: z.number().min(0).max(250000),
  }).optional(),
})

const SavedSchema = z.array(z.object({
  job: JobSchema,
  company: z.object({
    id: z.string(), name: z.string().max(200), color: z.string().regex(/^#[0-9a-f]{6}$/i),
    initials: z.string().max(8), industry: z.string().max(200), careerUrl: z.string().max(2000),
    board: z.string().optional(),
  }),
  savedAt: z.string(),
  status: z.enum(['saved', 'applied']),
  note: z.string().max(5000),
})).max(500)

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

export function loadSaved(): SavedJob[] {
  return load(STORAGE_KEYS.saved, SavedSchema, [])
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
    source: z.enum(['sample', 'greenhouse']).catch(fallback.source),
    filters: z.object({
      query: z.string().max(500).catch(filters.query),
      region: z.enum(['all', 'americas', 'europe', 'asia-pacific']).catch(filters.region),
      role: z.enum(['all', 'backend', 'frontend', 'fullstack', 'ml', 'data', 'devops', 'mobile', 'security']).catch(filters.role),
      workMode: z.enum(['all', 'remote', 'hybrid', 'onsite', 'unknown']).catch(filters.workMode),
      visa: z.enum(['all', 'yes', 'supported', 'possible']).catch(filters.visa),
      employment: z.enum(['all', 'fulltime', 'parttime', 'contract', 'intern', 'temporary', 'unknown']).catch(filters.employment),
      salaryMin: z.number().int().min(0).max(250000).catch(filters.salaryMin),
      includeUnknownSalary: z.boolean().catch(filters.includeUnknownSalary),
      remoteEligibleOnly: z.boolean().catch(filters.remoteEligibleOnly),
    }).catch(filters),
    selectedId: z.string().refine(id => CITY_BY_ID.has(id)).nullable().catch(null),
    panelTab: z.enum(['cities', 'remote']).catch(fallback.panelTab),
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

export function exportSavedCsv(saved: SavedJob[]): void {
  // Neutralize spreadsheet formulas in imported job titles and user notes.
  const cell = (value: unknown) => {
    const text = String(value ?? '')
    const safe = /^[\s]*[=+\-@\t\r]/.test(text) ? `'${text}` : text
    return `"${safe.replace(/"/g, '""')}"`
  }
  const rows = [
    ['회사', '포지션', '근무지', '데이터', '상태', '저장일', '메모', '채용 링크'],
    ...saved.map(item => [item.company.name, item.job.title, item.job.locationLabel, item.job.source === 'sample' ? '샘플' : 'Greenhouse', item.status === 'applied' ? '지원 완료' : '저장됨', item.savedAt, item.note, item.job.url]),
  ]
  const blob = new Blob(['\ufeff', rows.map(row => row.map(cell).join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `orbit-saved-${new Date().toISOString().slice(0, 10)}.csv`
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
