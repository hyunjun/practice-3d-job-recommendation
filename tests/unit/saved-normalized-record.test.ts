/**
 * Stage80 D2: the normalized whole-record comparator used to decide whether a
 * transaction result is the original. Literal fixtures only; the comparator's
 * own output is never used to build an expectation.
 */
import { describe, expect, it } from 'vitest'
import { PUBLIC_PROTOCOL_COMPANIES, publicProtocolJob } from '../fixtures/public-protocol'
import type { SavedJob } from '../../shared/types'
import { sameNormalizedSavedRecord, sameSavedRecord } from '../../shared/saved-backup'

const ORIGINAL: SavedJob = {
  job: publicProtocolJob('ember-80', { title: 'Ember 80 · Backend Engineer' }),
  company: structuredClone(PUBLIC_PROTOCOL_COMPANIES[0]),
  savedAt: '2026-09-28T07:30:00.000Z', status: 'applied', note: 'PRIVATE-UNDO80 original note\n둘째 줄 🌱',
}

function reversedKeys<T>(value: T): T {
  if (Array.isArray(value)) return value.map(reversedKeys) as T
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).reverse().map(([key, item]) => [key, reversedKeys(item)])) as T
  }
  return value
}

describe('normalized saved-record equivalence', () => {
  it('treats the same record with every object key reordered as equal, where the raw comparison does not', () => {
    const reordered = reversedKeys(structuredClone(ORIGINAL))
    expect(JSON.stringify(reordered.job)).not.toBe(JSON.stringify(ORIGINAL.job))
    expect(sameSavedRecord(ORIGINAL, reordered)).toBe(false)
    expect(sameNormalizedSavedRecord(ORIGINAL, reordered)).toBe(true)
    expect(sameNormalizedSavedRecord(reordered, ORIGINAL)).toBe(true)
  })

  it('distinguishes every private metadata field and the job and company snapshots', () => {
    expect(sameNormalizedSavedRecord(ORIGINAL, { ...ORIGINAL, note: 'NEWER note' })).toBe(false)
    expect(sameNormalizedSavedRecord(ORIGINAL, { ...ORIGINAL, status: 'saved' })).toBe(false)
    expect(sameNormalizedSavedRecord(ORIGINAL, { ...ORIGINAL, savedAt: '2026-10-01T12:00:00.000Z' })).toBe(false)
    expect(sameNormalizedSavedRecord(ORIGINAL, { ...ORIGINAL, job: { ...ORIGINAL.job, title: 'Ember 80 · Platform Engineer' } })).toBe(false)
    expect(sameNormalizedSavedRecord(ORIGINAL, { ...ORIGINAL, company: { ...ORIGINAL.company, name: 'Aster Transit Holdings' } })).toBe(false)
  })

  it('returns false instead of throwing for a record that is not a valid saved record', () => {
    const broken = { ...ORIGINAL, note: 'x'.repeat(5001) }
    expect(sameNormalizedSavedRecord(ORIGINAL, broken)).toBe(false)
    expect(sameNormalizedSavedRecord(broken, ORIGINAL)).toBe(false)
  })

  it('leaves both inputs untouched', () => {
    const left = structuredClone(ORIGINAL)
    const right = reversedKeys(structuredClone(ORIGINAL))
    const leftBefore = JSON.stringify(left)
    const rightBefore = JSON.stringify(right)
    expect(sameNormalizedSavedRecord(left, right)).toBe(true)
    expect(JSON.stringify(left)).toBe(leftBefore)
    expect(JSON.stringify(right)).toBe(rightBefore)
  })
})
