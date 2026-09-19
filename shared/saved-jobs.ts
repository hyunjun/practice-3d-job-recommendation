import { z } from 'zod'
import { JobProviderSchema, JobSchema } from './schemas'
import { upgradeJobCompensation } from './job-compensation'
import { upgradeJobQualifications } from './job-qualifications'
import { upgradeJobEligibility } from './job-eligibility'
import { upgradeJobOccupation } from './job-occupation'
import { upgradeJobRole } from './job-roles'
import { upgradeJobLocation } from './job-location'
import type { SavedJob } from './types'

export const MAX_SAVED_JOBS = 500

export const SavedJobSchema = z.object({
  job: JobSchema.transform(job => upgradeJobLocation(upgradeJobRole(upgradeJobOccupation(upgradeJobEligibility(upgradeJobQualifications(upgradeJobCompensation(job, true))))))),
  company: z.object({
    id: z.string(), name: z.string().max(200), color: z.string().regex(/^#[0-9a-f]{6}$/i),
    initials: z.string().max(8), industry: z.string().max(200), careerUrl: z.string().max(2000),
    board: z.string().optional(), provider: JobProviderSchema.optional(), boardRegion: z.literal('eu').optional(),
  }),
  savedAt: z.string(),
  status: z.enum(['saved', 'applied']),
  note: z.string().max(5000),
})

export type SavedPatch = Partial<Pick<SavedJob, 'note' | 'status'>>
export type SavedOperation =
  | { kind: 'add'; record: SavedJob }
  | { kind: 'remove'; id: string }
  | { kind: 'update'; id: string; patch: SavedPatch }

export function applySavedOperation(records: SavedJob[], operation: SavedOperation): SavedJob[] {
  if (operation.kind === 'add') return records.some(item => item.job.id === operation.record.job.id)
    ? records : [operation.record, ...records]
  if (operation.kind === 'remove') return records.filter(item => item.job.id !== operation.id)
  return records.map(item => item.job.id === operation.id ? { ...item, ...operation.patch } : item)
}

export interface DecodedSavedJobs {
  records: SavedJob[]
  omitted: number | null
  reason?: 'format' | 'records'
}

/** A bad entry cannot erase its valid neighbours; the caller retains the raw input. */
export function decodeSavedJobs(raw: string): DecodedSavedJobs {
  let values: unknown
  try { values = JSON.parse(raw) } catch { return { records: [], omitted: null, reason: 'format' } }
  if (!Array.isArray(values)) return { records: [], omitted: null, reason: 'format' }
  const records: SavedJob[] = []
  const ids = new Set<string>()
  let processed = 0
  for (const value of values.slice(0, 5000)) {
    if (records.length >= MAX_SAVED_JOBS) break
    processed++
    const parsed = SavedJobSchema.safeParse(value)
    if (!parsed.success || ids.has(parsed.data.job.id)) continue
    ids.add(parsed.data.job.id)
    records.push(parsed.data)
  }
  const omitted = values.length - records.length
  return { records, omitted, ...(omitted || processed < values.length ? { reason: 'records' as const } : {}) }
}
