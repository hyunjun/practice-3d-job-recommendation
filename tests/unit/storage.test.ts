import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_FILTERS, SAMPLE_PROFILE } from '../../shared/types'
import type { Profile } from '../../shared/types'
import { deleteProfile, loadExploration, loadProfile, persist, persistExploration, STORAGE_KEYS } from '../../src/lib/storage'
import type { ExplorationState } from '../../src/lib/storage'

const personal: Profile = {
  ...SAMPLE_PROFILE, kind: 'personal', name: 'Profile fixture', desiredRole: 'backend',
  preferences: { workMode: 'remote', visa: 'supported', salaryMin: 130000 },
}
const exploration: ExplorationState = {
  source: 'public',
  filters: { ...DEFAULT_FILTERS, query: '런던 Stripe', region: 'europe', role: 'backend', visa: 'supported', salaryMin: 120000 },
  selectedId: 'london', panelTab: 'cities', mapMode: 'flat', light: true, citySort: 'salary',
}
let values: Map<string, string>

beforeEach(() => {
  values = new Map()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  })
})
afterEach(() => vi.unstubAllGlobals())

describe('restoring exploration without changing profile preferences', () => {
  it('migrates Greenhouse mode to public mode without resetting search and display preferences', () => {
    values.set(STORAGE_KEYS.exploration, JSON.stringify({ ...exploration, source: 'greenhouse' }))
    expect(loadExploration(personal)).toEqual(exploration)
  })

  it('uses legacy profile preferences until the user has saved an exploration state', () => {
    values.set(STORAGE_KEYS.profile, JSON.stringify(personal))
    const restored = loadExploration(loadProfile())
    expect(restored.filters).toMatchObject({ role: 'backend', workMode: 'remote', visa: 'supported', salaryMin: 130000 })
    expect(restored.panelTab).toBe('remote')
    expect(restored.source).toBe('sample')
  })

  it('retains an explicit filter reset instead of reapplying the old preferred role', () => {
    persistExploration(exploration, true)
    expect(loadExploration(personal)).toEqual(exploration)
    persistExploration({ ...exploration, filters: { ...DEFAULT_FILTERS }, selectedId: null }, true)
    expect(loadExploration(personal).filters).toEqual(DEFAULT_FILTERS)
    expect(personal.desiredRole).toBe('backend')
  })

  it('recovers invalid fields independently and drops unknown stored properties', () => {
    values.set(STORAGE_KEYS.exploration, JSON.stringify({
      ...exploration,
      filters: { ...exploration.filters, salaryMin: -10, visa: 'unsupported-option', query: 'x'.repeat(501) },
      selectedId: 'removed-city', citySort: 'obsolete', mapMode: 'flat', rawResume: 'do not restore',
    }))
    const restored = loadExploration(SAMPLE_PROFILE)
    expect(restored.source).toBe('public')
    expect(restored.mapMode).toBe('flat')
    expect(restored.filters).toMatchObject({ region: 'europe', role: 'backend', salaryMin: 0, visa: 'all', query: '' })
    expect(restored.selectedId).toBeNull()
    expect(restored.citySort).toBe('companies')
    expect(restored).not.toHaveProperty('rawResume')
  })

  it('does not restore a city outside the selected region or an unknown data source', () => {
    values.set(STORAGE_KEYS.exploration, JSON.stringify({ ...exploration, source: 'unknown-provider', selectedId: 'seoul' }))
    const restored = loadExploration(SAMPLE_PROFILE)
    expect(restored.source).toBe('sample')
    expect(restored.selectedId).toBeNull()
    expect(restored.filters.region).toBe('europe')
  })
})

describe('storage boundaries and opting out', () => {
  it.each([null, 0, 0.5, 3, 3.5, 7 / 12, 50])('restores personal experience %s without resetting the profile or preferences', years => {
    const profile = { ...personal, years }
    expect(persist(STORAGE_KEYS.profile, profile)).toBe(true)
    expect(loadProfile()).toEqual(profile)
    expect(loadExploration(loadProfile()).filters).toMatchObject({ role: 'backend', workMode: 'remote', visa: 'supported', salaryMin: 130000 })
  })

  it('rejects malformed or out-of-range stored durations without coercing them to zero', () => {
    for (const years of ['', '3.5', -1, 50.5, { value: 3 }]) {
      values.set(STORAGE_KEYS.profile, JSON.stringify({ ...personal, years }))
      expect(loadProfile()).toEqual(SAMPLE_PROFILE)
    }
  })

  it('omits personal exploration conditions when profile remembering is disabled', () => {
    persistExploration(exploration, false)
    const restored = loadExploration(SAMPLE_PROFILE)
    expect(restored).toMatchObject({ source: 'public', mapMode: 'flat', light: true, selectedId: null, panelTab: 'cities' })
    expect(restored.filters).toEqual(DEFAULT_FILTERS)
    expect(values.get(STORAGE_KEYS.exploration)).not.toContain('런던 Stripe')
  })

  it('deleting a profile clears remembered conditions while preserving saved jobs and comparison', () => {
    values.set(STORAGE_KEYS.profile, JSON.stringify(personal))
    values.set(STORAGE_KEYS.saved, 'saved fixture')
    values.set(STORAGE_KEYS.compare, 'comparison fixture')
    persistExploration(exploration, true)
    deleteProfile()
    expect(loadProfile()).toEqual(SAMPLE_PROFILE)
    expect(loadExploration(SAMPLE_PROFILE).filters).toEqual(DEFAULT_FILTERS)
    expect(loadExploration(SAMPLE_PROFILE).source).toBe('public')
    expect(values.get(STORAGE_KEYS.saved)).toBe('saved fixture')
    expect(values.get(STORAGE_KEYS.compare)).toBe('comparison fixture')
  })

  it('falls back safely for malformed JSON and browsers that block storage', () => {
    values.set(STORAGE_KEYS.exploration, '{not-json')
    expect(loadExploration(personal).filters.role).toBe('backend')
    const blocked = () => { throw new Error('Storage blocked') }
    vi.stubGlobal('localStorage', { getItem: blocked, setItem: blocked, removeItem: blocked })
    expect(loadProfile()).toEqual(SAMPLE_PROFILE)
    expect(loadExploration(SAMPLE_PROFILE).filters).toEqual(DEFAULT_FILTERS)
    expect(persist(STORAGE_KEYS.profile, personal)).toBe(false)
    expect(persistExploration(exploration, true)).toBe(false)
    expect(() => deleteProfile()).not.toThrow()
  })
})
