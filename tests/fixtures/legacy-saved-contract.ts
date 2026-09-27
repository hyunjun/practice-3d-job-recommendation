/**
 * Intentionally retired/legacy input only. Routine API and saved-job tests use
 * public-only-contract.ts. No sample fixture is relabelled as a public provider.
 */
import type { Job, SavedJob } from '../../shared/types'
import { API_JOB, IMPORTED_SAVED, NOW, PUBLIC_SAVED, RAIL } from './public-only-contract'

export const LEGACY_NOTE = 'PRIVATE_65_LEGACY_NOTE 원본 메모·지원 상태 보존 🌱'
export const RETIRED_LABEL = '이전 가상 공고의 메모·기록'
export type LegacySampleSaved = Omit<SavedJob, 'job'> & { job: Omit<Job, 'source'> & { source: 'sample' } }
export const LEGACY_SAVED: LegacySampleSaved = {
  job: { ...structuredClone(API_JOB), id: 'sample-fixture65-obsolete', title: 'Legacy fictional opportunity 65', source: 'sample' },
  company: structuredClone(RAIL), savedAt: '2026-09-18T00:00:00.000Z', status: 'applied', note: LEGACY_NOTE,
}
export const SECOND_LEGACY_SAVED: LegacySampleSaved = {
  ...structuredClone(LEGACY_SAVED),
  job: { ...structuredClone(LEGACY_SAVED.job), id: 'sample-fixture65-second', title: 'Second retired fictional opportunity 65' },
  savedAt: '2026-09-18T01:00:00.000Z', status: 'saved', note: 'SECOND_PRIVATE_65_LEGACY_NOTE',
}
export const SHADOWING_SAMPLE: LegacySampleSaved = {
  ...structuredClone(IMPORTED_SAVED),
  job: { ...structuredClone(IMPORTED_SAVED.job), source: 'sample', title: 'Fictional legacy duplicate of a public ID' },
  note: 'LEGACY_DUPLICATE_ID_NOTE must not shadow the public neighbour',
}

export const PUBLIC_ENTRY = { id: PUBLIC_SAVED.job.id, order: 1, record: structuredClone(PUBLIC_SAVED) }
export const LEGACY_ENTRY = {
  id: 'sample-fixture65-obsolete', order: 2, record: structuredClone(LEGACY_SAVED),
  // Opaque old metadata is part of the original, not a reason to truncate it.
  legacyOpaque: { text: 'ORIGINAL_65_ENTRY_METADATA', version: 'before65' },
}
export const OLD_META = { key: 'state', nextOrder: 3, legacyDigest: null }
export type ImportFormat = 'backup' | 'legacy' | 'recovery'
export function importFile(format: ImportFormat, records: unknown[]): string {
  if (format === 'legacy') return JSON.stringify(records)
  if (format === 'recovery') return JSON.stringify({
    format: 'orbit-saved-recovery', version: 1, sources: [{ kind: 'legacy', original: JSON.stringify(records) }],
  })
  return JSON.stringify({ format: 'orbit-saved-backup', version: 1, exportedAt: NOW, includesUnsavedChanges: false, records })
}
export function mixedImport(format: ImportFormat): string {
  return importFile(format, [LEGACY_SAVED, { invalid: 'synthetic malformed neighbour' }, IMPORTED_SAVED])
}
export function retiredRecoveryFile(entries: unknown[] = [LEGACY_ENTRY]): string {
  return JSON.stringify({
    format: 'orbit-saved-recovery', version: 1, exportedAt: NOW,
    sources: [{ kind: 'retired-samples', count: entries.length, original: entries }],
  })
}
