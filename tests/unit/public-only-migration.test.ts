/** Public-only compatibility contracts. All inputs and storage are synthetic. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadExploration, persistExploration } from '../../src/lib/storage'
import { isPublicCatalog } from '../../src/lib/catalog-validation'
import { LEGACY_EXPLORATION, PROFILE, publicCatalog } from '../fixtures/public-only-contract'
import { LEGACY_SAVED } from '../fixtures/legacy-saved-contract'

let values: Map<string, string>
beforeEach(() => {
  values = new Map()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value) },
    removeItem: (key: string) => { values.delete(key) },
  })
})
afterEach(() => vi.unstubAllGlobals())

const expectedRestoration = {
  source: 'public',
  filters: { query: 'Backend Engineer', region: 'europe', role: 'backend', workMode: 'onsite',
    visa: 'all', employment: 'fulltime', postingType: 'opening', salaryMin: 0,
    includeUnknownSalary: true, remoteEligibleOnly: true },
  selectedId: 'london', panelTab: 'cities', mapMode: 'flat', light: true, citySort: 'salary',
}
const expectedDefaults = {
  source: 'public',
  filters: { query: '', region: 'all', role: 'all', workMode: 'all', visa: 'all',
    employment: 'all', postingType: 'opening', salaryMin: 0,
    includeUnknownSalary: true, remoteEligibleOnly: true },
  selectedId: null, panelTab: 'cities', mapMode: 'globe', light: false, citySort: 'companies',
}

describe('public-only exploration migration', () => {
  it('starts a fresh visitor with public data selected', () => {
    expect(loadExploration(PROFILE)).toEqual(expectedDefaults)
  })
  it.each(['sample', 'greenhouse', 'public', 'obsolete-source', undefined])(
    'recovers %s as public while retaining every valid search/display field', source => {
      values.set('orbit.v1.exploration', JSON.stringify({ ...LEGACY_EXPLORATION, source }))
      expect(loadExploration(PROFILE)).toEqual(expectedRestoration)
    },
  )
  it('persists public once and is idempotent after a real second read', () => {
    values.set('orbit.v1.exploration', JSON.stringify(LEGACY_EXPLORATION))
    expect(persistExploration(loadExploration(PROFILE), true)).toBe(true)
    expect(JSON.parse(values.get('orbit.v1.exploration')!)).toEqual(expectedRestoration)
    const firstWrite = values.get('orbit.v1.exploration')
    expect(persistExploration(loadExploration(PROFILE), true)).toBe(true)
    expect(values.get('orbit.v1.exploration')).toBe(firstWrite)
  })
  it('repairs only invalid fields and rejects an out-of-region saved city', () => {
    values.set('orbit.v1.exploration', JSON.stringify({
      ...LEGACY_EXPLORATION, selectedId: 'seoul', rawResume: 'PRIVATE_65_DO_NOT_RESTORE',
      filters: { ...LEGACY_EXPLORATION.filters, salaryMin: -1, visa: 'obsolete' },
    }))
    expect(loadExploration(PROFILE)).toEqual({ ...expectedRestoration, selectedId: null })
  })
  it('keeps public selected when remembered personal conditions are disabled', () => {
    values.set('orbit.v1.exploration', JSON.stringify(LEGACY_EXPLORATION))
    values.set('orbit.v1.saved', 'untouched synthetic saved input')
    values.set('orbit.v1.compare', '["london","berlin"]')
    persistExploration(loadExploration(PROFILE), false)
    expect(JSON.parse(values.get('orbit.v1.exploration')!)).toEqual({
      ...expectedDefaults, mapMode: 'flat', light: true, citySort: 'salary',
    })
    expect(values.get('orbit.v1.saved')).toBe('untouched synthetic saved input')
    expect(values.get('orbit.v1.compare')).toBe('["london","berlin"]')
  })
  it('falls back to public for malformed JSON and unavailable storage', () => {
    values.set('orbit.v1.exploration', '{broken')
    expect(loadExploration(PROFILE)).toEqual(expectedDefaults)
    const denied = () => { throw new Error('Synthetic storage denied') }
    vi.stubGlobal('localStorage', { getItem: denied, setItem: denied, removeItem: denied })
    expect(loadExploration(PROFILE)).toEqual(expectedDefaults)
    expect(persistExploration(loadExploration(PROFILE), true)).toBe(false)
  })
})

describe('the public wire cannot smuggle a fictional legacy posting', () => {
  it('accepts the standalone synthetic public protocol fixture', () => {
    expect(isPublicCatalog(publicCatalog())).toBe(true)
    expect(isPublicCatalog(publicCatalog('empty'))).toBe(true)
  })
  it('rejects a sample-labelled job even when its ID and owner resemble a public record', () => {
    const input = publicCatalog()
    const mixed = { ...input, jobs: [{ ...input.jobs[0], source: LEGACY_SAVED.job.source }, ...input.jobs.slice(1)] }
    expect(isPublicCatalog(mixed)).toBe(false)
    expect(isPublicCatalog({ ...publicCatalog(), source: 'sample' })).toBe(false)
  })
})
