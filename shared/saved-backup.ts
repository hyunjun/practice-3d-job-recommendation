import { SavedJobSchema } from './saved-jobs'
import type { SavedJob } from './types'

export const SAVED_BACKUP_FORMAT = 'orbit-saved-backup'
export const MAX_SAVED_FILE_BYTES = 50 * 1024 * 1024
export const MAX_IMPORT_RECORDS = 5000

export class SavedFileError extends Error {
  constructor(readonly code: 'format' | 'version' | 'size' | 'count') { super(code) }
}

export interface SavedImportGroup {
  id: string
  variants: SavedJob[]
  occurrences: number
}
export interface ParsedSavedImport {
  format: 'backup' | 'recovery' | 'legacy'
  exportedAt: string | null
  groups: SavedImportGroup[]
  invalid: number
  unreadableSources: number
  duplicates: number
}
export interface SavedImportItem {
  record: SavedJob
  expected: SavedJob | null
}
export interface SavedImportPlan { items: SavedImportItem[] }

export const SAVED_DIFFERENCE_LABELS = {
  note: '메모', status: '지원 상태', savedAt: '저장일', company: '회사 정보', job: '공고 스냅샷',
} as const
export type SavedDifference = keyof typeof SAVED_DIFFERENCE_LABELS

export function savedDifferences(current: SavedJob, incoming: SavedJob): SavedDifference[] {
  return (Object.keys(SAVED_DIFFERENCE_LABELS) as SavedDifference[])
    .filter(key => JSON.stringify(current[key]) !== JSON.stringify(incoming[key]))
}

export function sameSavedRecord(first: SavedJob, second: SavedJob): boolean {
  return savedDifferences(first, second).length === 0
}

/** Includes the visible draft; reading a backup does not send it to a server. */
export function createSavedBackup(records: SavedJob[], pending = 0, now = new Date()): string {
  return `${JSON.stringify({
    format: SAVED_BACKUP_FORMAT, version: 1, exportedAt: now.toISOString(),
    includesUnsavedChanges: pending > 0, records,
  }, null, 2)}\n`
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Validate individual records, retaining distinct duplicate variants for review. */
export function parseSavedImport(text: string): ParsedSavedImport {
  if (new TextEncoder().encode(text).byteLength > MAX_SAVED_FILE_BYTES) throw new SavedFileError('size')
  let root: unknown
  try { root = JSON.parse(text.replace(/^\uFEFF/, '')) } catch { throw new SavedFileError('format') }
  const result: ParsedSavedImport = { format: 'legacy', exportedAt: null, groups: [], invalid: 0, unreadableSources: 0, duplicates: 0 }
  const groups = new Map<string, SavedImportGroup>()
  const variants = new Map<string, Set<string>>()
  let inspected = 0
  const add = (value: unknown) => {
    if (++inspected > MAX_IMPORT_RECORDS) throw new SavedFileError('count')
    const parsed = SavedJobSchema.safeParse(value)
    if (!parsed.success || parsed.data.company.id !== parsed.data.job.companyId) { result.invalid++; return }
    const record = parsed.data
    const serialized = JSON.stringify(record)
    const existing = groups.get(record.job.id)
    if (existing) {
      existing.occurrences++
      result.duplicates++
      if (!variants.get(record.job.id)!.has(serialized)) {
        existing.variants.push(record)
        variants.get(record.job.id)!.add(serialized)
      }
    } else {
      groups.set(record.job.id, { id: record.job.id, variants: [record], occurrences: 1 })
      variants.set(record.job.id, new Set([serialized]))
    }
  }
  const addArray = (values: unknown) => {
    if (!Array.isArray(values)) { result.unreadableSources++; return }
    if (values.length + inspected > MAX_IMPORT_RECORDS) throw new SavedFileError('count')
    values.forEach(add)
  }
  if (Array.isArray(root)) addArray(root)
  else if (object(root) && (root.format === SAVED_BACKUP_FORMAT || root.format === 'orbit-saved-recovery')) {
    if (root.version !== 1) throw new SavedFileError('version')
    result.exportedAt = typeof root.exportedAt === 'string' && Number.isFinite(Date.parse(root.exportedAt)) ? root.exportedAt : null
    if (root.format === SAVED_BACKUP_FORMAT) {
      if (!Array.isArray(root.records)) throw new SavedFileError('format')
      result.format = 'backup'
      addArray(root.records)
    } else {
      if (!Array.isArray(root.sources) || root.sources.length > MAX_IMPORT_RECORDS) throw new SavedFileError('format')
      result.format = 'recovery'
      for (const source of root.sources) {
        if (!object(source)) { result.unreadableSources++; continue }
        if (source.kind === 'legacy' || source.kind === 'additional-legacy') {
          if (typeof source.original !== 'string') { result.unreadableSources++; continue }
          let values: unknown
          try { values = JSON.parse(source.original) } catch { result.unreadableSources++; continue }
          addArray(values)
        } else if (source.kind === 'records' && Array.isArray(source.original)) {
          for (const entry of source.original) {
            if (!object(entry) || !object(entry.record) || !object(entry.record.job) || entry.id !== entry.record.job.id) add(null)
            else add(entry.record)
          }
        } else result.unreadableSources++
      }
    }
  } else throw new SavedFileError('format')
  result.groups = [...groups.values()]
  return result
}
