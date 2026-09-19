import { describe, expect, it } from 'vitest'
import { createSampleCatalog } from '../../shared/sample'
import { createSavedBackup, MAX_IMPORT_RECORDS, MAX_SAVED_FILE_BYTES, parseSavedImport, savedDifferences } from '../../shared/saved-backup'
import type { SavedJob } from '../../shared/types'

const sample = createSampleCatalog()
const record: SavedJob = {
  job: sample.jobs[0], company: sample.companies.find(company => company.id === sample.jobs[0].companyId)!,
  savedAt: '2026-09-19T08:10:00.000Z', status: 'applied', note: '지원 준비\n=SUM(A1:A2)\n따옴표 "기록"과 이모지 🌏',
}
const backup = (records: unknown[]) => JSON.stringify({ format: 'orbit-saved-backup', version: 1, records })

describe('portable saved record files', () => {
  it('round-trips the complete records, order, notes and original dates, including a visible unsaved draft', () => {
    const records = [record, { ...record, job: { ...record.job, id: 'second' }, note: 'Latest draft', status: 'saved' as const }]
    const text = createSavedBackup(records, 1, new Date('2026-09-19T10:00:00.000Z'))
    const parsed = parseSavedImport(`\uFEFF${text}`)
    expect(parsed).toMatchObject({ format: 'backup', exportedAt: '2026-09-19T10:00:00.000Z', invalid: 0, unreadableSources: 0, duplicates: 0 })
    expect(parsed.groups.map(group => group.variants[0])).toEqual(records)
    expect(JSON.parse(text)).toMatchObject({ includesUnsavedChanges: true })
    expect(Object.keys(JSON.parse(text))).toEqual(['format', 'version', 'exportedAt', 'includesUnsavedChanges', 'records'])
  })

  it('recovers valid neighbours while disclosing invalid records and distinct duplicate alternatives', () => {
    const second = { ...record, status: 'saved' as const, note: 'A different note in the same file' }
    const parsed = parseSavedImport(backup([record, { invalid: true }, second, record]))
    expect(parsed.invalid).toBe(1)
    expect(parsed.duplicates).toBe(2)
    expect(parsed.groups).toHaveLength(1)
    expect(parsed.groups[0]).toEqual({ id: record.job.id, occurrences: 3, variants: [record, second] })
    expect(savedDifferences(record, second)).toEqual(['note', 'status'])
  })

  it('reads prior recovery downloads and raw legacy lists without requiring the old database', () => {
    const restored = parseSavedImport(JSON.stringify({
      format: 'orbit-saved-recovery', version: 1, exportedAt: '2026-09-19T08:11:00.000Z',
      sources: [
        { kind: 'legacy', original: JSON.stringify([record, { invalid: true }]) },
        { kind: 'additional-legacy', original: JSON.stringify([{ ...record, note: 'Older tab alternative' }]) },
        { kind: 'records', original: [
          { id: 'second', order: 'damaged order', record: { ...record, job: { ...record.job, id: 'second' } } },
          { id: 'wrong-id', record },
        ] },
        { kind: 'legacy', original: '{"truncated":' },
      ],
    }))
    expect(restored).toMatchObject({ format: 'recovery', invalid: 2, unreadableSources: 1, duplicates: 1 })
    expect(restored.groups.map(group => group.id)).toEqual([record.job.id, 'second'])
    expect(restored.groups[0].variants.map(value => value.note)).toEqual([record.note, 'Older tab alternative'])
    expect(parseSavedImport(JSON.stringify([record])).groups[0].variants[0]).toEqual(record)
  })

  it('rejects unrelated and future formats and bounds the file and record counts before importing', () => {
    for (const text of ['{broken', '{}', '{"format":"other","version":1,"records":[]}']) {
      expect(() => parseSavedImport(text)).toThrowError(expect.objectContaining({ code: 'format' }))
    }
    expect(() => parseSavedImport('{"format":"orbit-saved-backup","version":2,"records":[]}')).toThrowError(expect.objectContaining({ code: 'version' }))
    expect(() => parseSavedImport(backup(Array(MAX_IMPORT_RECORDS + 1).fill(null)))).toThrowError(expect.objectContaining({ code: 'count' }))
    expect(() => parseSavedImport(' '.repeat(MAX_SAVED_FILE_BYTES + 1))).toThrowError(expect.objectContaining({ code: 'size' }))
  })

  it('keeps text inert, strips unexpected properties and rejects mismatched company identity', () => {
    const suspicious = { ...record, note: '<script>not executable</script>', company: { ...record.company, id: 'different-company' } }
    const parsed = parseSavedImport(backup([
      JSON.parse(JSON.stringify({ ...record, note: '<script>not executable</script>' }).replace(/}$/, ',"__proto__":{"injected":true}}')),
      suspicious,
    ]))
    expect(parsed.invalid).toBe(1)
    expect(parsed.groups[0].variants[0].note).toBe('<script>not executable</script>')
    expect(Object.hasOwn(parsed.groups[0].variants[0], '__proto__')).toBe(false)
    expect(Object.hasOwn(Object.prototype, 'injected')).toBe(false)
  })
})
