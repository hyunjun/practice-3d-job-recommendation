import { z } from 'zod'
import { SAMPLE_PROFILE } from '../../shared/types'
import type { Profile, SavedJob } from '../../shared/types'

export const STORAGE_KEYS = {
  profile: 'orbit.v1.profile',
  saved: 'orbit.v1.saved',
  compare: 'orbit.v1.compare',
} as const

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

const EvidenceSchema = z.object({
  source: z.enum(['board', 'description', 'title']),
  text: z.string().max(3000),
})

const SavedSchema = z.array(z.object({
  job: z.object({
    id: z.string().max(200), companyId: z.string().max(100), title: z.string().max(1000),
    role: z.enum(['backend', 'frontend', 'fullstack', 'ml', 'data', 'devops', 'mobile', 'security']),
    cityIds: z.array(z.string()).max(50), locationLabel: z.string().max(2000),
    workMode: z.enum(['remote', 'hybrid', 'onsite', 'unknown']),
    employment: z.enum(['fulltime', 'parttime', 'contract', 'intern', 'temporary', 'unknown']),
    minExperience: z.number().min(0).max(50).nullable(), skills: z.array(z.string()).max(100),
    salary: z.object({
      min: z.number().nonnegative(), max: z.number().nonnegative(),
      currency: z.enum(['USD', 'EUR', 'GBP', 'CAD', 'SGD', 'AUD', 'KRW', 'JPY', 'CHF']),
    }).nullable(),
    visa: z.enum(['yes', 'conditional', 'no', 'unknown']), remoteCountries: z.array(z.string()).max(300),
    remoteWorldwide: z.boolean(), remoteScopeUnknown: z.boolean(),
    description: z.string().max(30000), requirements: z.array(z.string()).max(50),
    url: z.string().max(2000), source: z.enum(['sample', 'greenhouse']),
    updatedAt: z.string().nullable(), fetchedAt: z.string(),
    evidence: z.object({
      visa: EvidenceSchema.optional(),
      workMode: EvidenceSchema.optional(),
      employment: EvidenceSchema.optional(),
    }).optional(),
  }),
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

export function persist(key: string, value: unknown): boolean {
  try { localStorage.setItem(key, JSON.stringify(value)); return true }
  catch { return false }
}

export function deleteProfile(): void {
  try { localStorage.removeItem(STORAGE_KEYS.profile) } catch { /* Session remains usable without storage. */ }
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
