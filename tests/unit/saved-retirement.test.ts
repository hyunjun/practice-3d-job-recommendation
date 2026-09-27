/** Public-only compatibility contracts. All inputs and storage are synthetic. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IDBFactory, IDBObjectStore as FakeObjectStore } from 'fake-indexeddb'
import { decodeSavedJobs } from '../../shared/saved-jobs'
import { createSavedBackup, parseSavedImport } from '../../shared/saved-backup'
import { openSavedStore } from '../../src/lib/saved-store'
import type { SavedStore, SavedStoreSnapshot } from '../../src/lib/saved-store'
import type { SavedJob } from '../../shared/types'
import { IMPORTED_SAVED, PUBLIC_NOTE, PUBLIC_SAVED } from '../fixtures/public-only-contract'
import {
  LEGACY_ENTRY, LEGACY_NOTE, LEGACY_SAVED, OLD_META, PUBLIC_ENTRY, SECOND_LEGACY_SAVED,
  SHADOWING_SAMPLE, importFile, mixedImport, retiredRecoveryFile,
} from '../fixtures/legacy-saved-contract'

let factory: IDBFactory
let values: Map<string, string>
let opened: SavedStore[]
const database = 'synthetic-stage65-retirement'
beforeEach(() => {
  factory = new IDBFactory()
  values = new Map()
  opened = []
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('Draft retirement checks must not contact a provider') }))
})
afterEach(() => {
  opened.forEach(store => store.close())
  expect(vi.mocked(fetch)).not.toHaveBeenCalled()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
async function open() {
  const store = await openSavedStore({
    factory, name: database,
    legacy: { getItem: key => values.get(key) ?? null, removeItem: key => { values.delete(key) } },
  })
  opened.push(store)
  return store
}
async function raw(options?: { entries: unknown[]; meta?: unknown }) {
  return new Promise<{ entries: unknown[]; meta: Record<string, unknown> | undefined }>((resolve, reject) => {
    const opening = factory.open(database, 1)
    opening.onupgradeneeded = () => {
      opening.result.createObjectStore('records', { keyPath: 'id' })
      opening.result.createObjectStore('meta', { keyPath: 'key' })
    }
    opening.onerror = () => reject(opening.error)
    opening.onsuccess = () => {
      const db = opening.result, tx = db.transaction(['records', 'meta'], options ? 'readwrite' : 'readonly')
      if (options) {
        options.entries.forEach(entry => { tx.objectStore('records').put(entry) })
        if (options.meta !== undefined) tx.objectStore('meta').put(options.meta)
      }
      const entries = tx.objectStore('records').getAll(), meta = tx.objectStore('meta').get('state')
      tx.oncomplete = () => { db.close(); resolve({ entries: entries.result, meta: meta.result }) }
      tx.onabort = () => { db.close(); reject(tx.error) }
    }
  })
}
function retired(snapshot: SavedStoreSnapshot) {
  // String permits compilation before Stage65 extends SavedRecovery's union.
  // The assertion still requires exactly the newly decided archive kind.
  const archive = snapshot.recovery.find(item => String(item.kind) === 'retired-samples')
  expect(archive).toBeDefined()
  return archive!
}
function publicSurvives(snapshot: SavedStoreSnapshot) {
  expect(snapshot.records.map(record => record.job.id)).toEqual(['greenhouse-fixture65-rail-api'])
  expect(snapshot.records[0]).toMatchObject({
    job: { source: 'greenhouse', title: 'Backend Engineer — Fable Rail API',
      url: 'https://example.test/jobs/greenhouse-fixture65-rail-api', fetchedAt: '2026-09-26T23:55:00.000Z' },
    savedAt: '2026-09-26T23:56:00.000Z', status: 'applied', note: PUBLIC_NOTE,
  })
}

describe('sample exclusion before deduplication and import grouping', () => {
  it('does not let a sample-source ID mask a valid public neighbour during local migration', () => {
    const decoded = decodeSavedJobs(JSON.stringify([SHADOWING_SAMPLE, { invalid: true }, IMPORTED_SAVED]))
    expect(decoded.omitted).toBe(2)
    expect(decoded.reason).toBe('records')
    expect(decoded.records.map(record => record.job.id)).toEqual(['ashby-fixture65-textile-platform'])
    expect(decoded.records[0]).toMatchObject({
      job: { source: 'ashby', title: 'Backend Engineer — Loom Textiles Platform' },
      note: 'PRIVATE_65_IMPORTED_NOTE 원본 유지', status: 'saved', savedAt: '2026-09-26T23:57:00.000Z',
    })
    expect(decodeSavedJobs(JSON.stringify([LEGACY_SAVED, SECOND_LEGACY_SAVED])))
      .toEqual({ records: [], omitted: 2, reason: 'records' })
  })
  it('keeps all 500 public records when the legacy array begins with an excluded sample', () => {
    const records = Array.from({ length: 500 }, (_, index) => ({
      ...PUBLIC_SAVED, job: { ...PUBLIC_SAVED.job, id: `greenhouse-fixture65-rail-local-capacity-${index + 1}` },
    }))
    const decoded = decodeSavedJobs(JSON.stringify([LEGACY_SAVED, ...records]))
    expect(decoded.records).toHaveLength(500)
    expect(decoded.records[499].job.id).toBe('greenhouse-fixture65-rail-local-capacity-500')
    expect(decoded.omitted).toBe(1)
    expect(decoded.reason).toBe('records')
  })

  it.each(['backup', 'legacy', 'recovery'] as const)(
    'reports one excluded sample and one invalid neighbour, keeping the public record in %s', format => {
      const parsed = parseSavedImport(mixedImport(format))
      expect(parsed).toMatchObject({ excludedSamples: 1, invalid: 1, unreadableSources: 0, duplicates: 0 })
      expect(parsed.groups.map(group => group.id)).toEqual(['ashby-fixture65-textile-platform'])
      expect(parsed.groups[0]).toMatchObject({ occurrences: 1, variants: [{
        job: { source: 'ashby', title: 'Backend Engineer — Loom Textiles Platform' },
        note: 'PRIVATE_65_IMPORTED_NOTE 원본 유지', status: 'saved', savedAt: '2026-09-26T23:57:00.000Z',
      }] })
    },
  )

  it.each(['backup', 'legacy', 'recovery'] as const)('makes a sample-only %s file an explicit zero-selection import', format => {
    expect(parseSavedImport(importFile(format, [LEGACY_SAVED, SECOND_LEGACY_SAVED]))).toMatchObject({
      groups: [], excludedSamples: 2, invalid: 0, unreadableSources: 0, duplicates: 0,
    })
  })

  it('excludes sample occurrences before grouping and preserves both conflicting PUBLIC variants', () => {
    const otherPublic = { ...IMPORTED_SAVED, note: 'SECOND PUBLIC VARIANT', status: 'applied' }
    const parsed = parseSavedImport(importFile('backup', [SHADOWING_SAMPLE, IMPORTED_SAVED, SHADOWING_SAMPLE, otherPublic]))
    expect(parsed).toMatchObject({ excludedSamples: 2, invalid: 0, unreadableSources: 0, duplicates: 1 })
    expect(parsed.groups.map(group => group.id)).toEqual(['ashby-fixture65-textile-platform'])
    expect(parsed.groups[0].occurrences).toBe(2)
    expect(parsed.groups[0].variants.map(record => [record.job.source, record.note, record.status])).toEqual([
      ['ashby', 'PRIVATE_65_IMPORTED_NOTE 원본 유지', 'saved'],
      ['ashby', 'SECOND PUBLIC VARIANT', 'applied'],
    ])
  })

  it('cannot reimport retired archive entries as opportunities and exposes excludedSamples=0 for public-only input', () => {
    expect(parseSavedImport(retiredRecoveryFile())).toMatchObject({
      groups: [], excludedSamples: 1, invalid: 0, unreadableSources: 0, duplicates: 0,
    })
    expect(parseSavedImport(importFile('backup', [IMPORTED_SAVED]))).toMatchObject({
      excludedSamples: 0, invalid: 0, unreadableSources: 0, duplicates: 0,
    })
  })
})

describe('localStorage migration preserves the exact original as recovery', () => {
  it('keeps whitespace, full sample note/status/date and the public neighbour after restart', async () => {
    const original = ` \n${JSON.stringify([LEGACY_SAVED, { invalid: true }, PUBLIC_SAVED], null, 2)}\n`
    values.set('orbit.v1.saved', original)
    const store = await open()
    const snapshot = await store.read()
    publicSurvives(snapshot)
    expect(snapshot.recovery).toEqual([{ kind: 'legacy', count: 2, original }])
    expect(values.has('orbit.v1.saved')).toBe(false)
    store.close()
    const reopened = await (await open()).read()
    publicSurvives(reopened)
    expect(reopened.recovery).toEqual([{ kind: 'legacy', count: 2, original }])
    const backup = createSavedBackup(reopened.records)
    expect(JSON.parse(backup).records.map((record: SavedJob) => record.job.id)).toEqual(['greenhouse-fixture65-rail-api'])
    expect(backup).not.toContain(LEGACY_NOTE)
    expect(backup).not.toContain('sample-fixture65-obsolete')
  })

  it('rolls back public writes and leaves the original key intact if recovery metadata cannot commit', async () => {
    const original = JSON.stringify([LEGACY_SAVED, PUBLIC_SAVED])
    values.set('orbit.v1.saved', original)
    const put = FakeObjectStore.prototype.put
    const fault = vi.spyOn(FakeObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, value, key) {
      if (this.name === 'meta') throw new DOMException('Synthetic full storage', 'QuotaExceededError')
      return put.call(this, value, key)
    })
    await expect(open()).rejects.toMatchObject({ code: 'quota' })
    expect(values.get('orbit.v1.saved')).toBe(original)
    expect(await raw()).toEqual({ entries: [], meta: undefined })
    fault.mockRestore()
    const recovered = await (await open()).read()
    publicSurvives(recovered)
    expect(recovered.recovery).toEqual([{ kind: 'legacy', count: 1, original }])
    expect(values.has('orbit.v1.saved')).toBe(false)
  })
})

describe('already-initialized IndexedDB v1 sample retirement', () => {
  it('moves the complete original Entry into meta.retiredSamples and is stable across reads/reopen', async () => {
    await raw({ entries: [LEGACY_ENTRY, PUBLIC_ENTRY], meta: OLD_META })
    const store = await open()
    const snapshot = await store.read()
    publicSurvives(snapshot)
    expect(snapshot.occupied).toBe(1)
    expect(snapshot.unreadableIds).toEqual([])
    expect(retired(snapshot)).toEqual({ kind: 'retired-samples', count: 1, original: [LEGACY_ENTRY] })
    const persisted = await raw()
    expect(persisted.entries).toEqual([PUBLIC_ENTRY])
    expect(persisted.meta).toEqual({ ...OLD_META, retiredSamples: [LEGACY_ENTRY] })
    expect(retired(await store.read()).original).toEqual([LEGACY_ENTRY])
    store.close()
    expect(retired(await (await open()).read()).original).toEqual([LEGACY_ENTRY])
  })

  it('rechecks an older tab write on read and keeps distinct note versions without exposing either as a card', async () => {
    await raw({ entries: [LEGACY_ENTRY, PUBLIC_ENTRY], meta: OLD_META })
    const store = await open()
    await store.read()
    const olderTabEdit = {
      ...LEGACY_ENTRY, record: { ...LEGACY_ENTRY.record, note: 'OLD_TAB_65_NEW_NOTE', status: 'saved' },
    }
    await raw({ entries: [olderTabEdit] })
    const reread = await store.read()
    publicSurvives(reread)
    expect(retired(reread)).toMatchObject({ kind: 'retired-samples', count: 2 })
    expect(retired(reread).original).toEqual(expect.arrayContaining([LEGACY_ENTRY, olderTabEdit]))
    expect((await raw()).entries).toEqual([PUBLIC_ENTRY])
    expect(retired(await store.read()).original).toEqual(retired(reread).original)
  })

  it.each(['quota-before-meta-commit', 'abort-after-active-delete'] as const)(
    '%s rolls back BOTH archive metadata and active deletion before a successful retry', async mode => {
      await raw({ entries: [LEGACY_ENTRY, PUBLIC_ENTRY], meta: OLD_META })
      const before = await raw()
      let triggered = 0
      const put = FakeObjectStore.prototype.put, remove = FakeObjectStore.prototype.delete
      const fault = mode === 'quota-before-meta-commit'
        ? vi.spyOn(FakeObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, value, key) {
          if (this.name === 'meta' && value?.retiredSamples?.length) {
            triggered++
            throw new DOMException('Synthetic archive quota', 'QuotaExceededError')
          }
          return put.call(this, value, key)
        })
        : vi.spyOn(FakeObjectStore.prototype, 'delete').mockImplementation(function (this: IDBObjectStore, key) {
          const request = remove.call(this, key)
          if (this.name === 'records' && key === 'sample-fixture65-obsolete')
            request.addEventListener('success', () => { triggered++; this.transaction.abort() }, { once: true })
          return request
        })
      await expect((async () => (await open()).read())()).rejects.toBeDefined()
      expect(triggered).toBeGreaterThan(0)
      expect(await raw()).toEqual(before)
      fault.mockRestore()
      const retried = await (await open()).read()
      publicSurvives(retried)
      expect(retired(retried)).toEqual({ kind: 'retired-samples', count: 1, original: [LEGACY_ENTRY] })
      expect((await raw()).entries).toEqual([PUBLIC_ENTRY])
    },
  )

  it('does not charge the archive against the 500 active-opportunity limit', async () => {
    const publicRecords = Array.from({ length: 499 }, (_, index) => ({
      ...structuredClone(PUBLIC_SAVED),
      job: { ...structuredClone(PUBLIC_SAVED.job), id: `greenhouse-fixture65-rail-capacity-${index + 1}` },
    }))
    await raw({
      entries: [
        ...publicRecords.map((record, index) => ({ id: record.job.id, order: index + 1, record })),
        { ...LEGACY_ENTRY, order: 500 },
      ],
      meta: { key: 'state', nextOrder: 501, legacyDigest: null },
    })
    const store = await open()
    expect((await store.read()).occupied).toBe(499)
    const last: SavedJob = { ...PUBLIC_SAVED, job: { ...PUBLIC_SAVED.job, id: 'greenhouse-fixture65-rail-capacity-500' } }
    await store.apply({ kind: 'add', record: last })
    const full = await store.read()
    expect(full.records).toHaveLength(500)
    expect(full.occupied).toBe(500)
    expect(full.records[0].job.id).toBe('greenhouse-fixture65-rail-capacity-500')
    expect(retired(full)).toMatchObject({ count: 1 })
    await expect(store.apply({
      kind: 'add', record: { ...last, job: { ...last.job, id: 'greenhouse-fixture65-rail-capacity-501' } },
    })).rejects.toMatchObject({ code: 'limit' })
    expect(retired(await store.read()).original).toEqual([{ ...LEGACY_ENTRY, order: 500 }])
  })

  it('keeps the current collection and migration marker when an explicitly selected retired archive is deleted', async () => {
    await raw({ entries: [LEGACY_ENTRY, PUBLIC_ENTRY], meta: OLD_META })
    const store = await open()
    const target = retired(await store.read())
    await store.discardRecovery(target)
    const state = await store.read()
    publicSurvives(state)
    expect(state.recovery).toEqual([])
    const persisted = await raw()
    expect(persisted.entries).toEqual([PUBLIC_ENTRY])
    expect(persisted.meta).toMatchObject(OLD_META)
    expect(persisted.meta?.retiredSamples ?? []).toEqual([])
    store.close()
    const reopened = await (await open()).read()
    publicSurvives(reopened)
    expect(reopened.recovery).toEqual([])
  })

  it('rejects deletion of a stale archive preview if a subsequent read retired another old-tab note', async () => {
    await raw({ entries: [LEGACY_ENTRY, PUBLIC_ENTRY], meta: OLD_META })
    const store = await open()
    const staleTarget = retired(await store.read())
    const newer = { ...LEGACY_ENTRY, record: { ...LEGACY_ENTRY.record, note: 'PRIVATE_65_NEWER_OLD_TAB_NOTE' } }
    await raw({ entries: [newer] })
    await store.read()
    await expect(store.discardRecovery(staleTarget)).rejects.toMatchObject({ code: 'changed' })
    const current = await store.read()
    publicSurvives(current)
    expect(retired(current)).toMatchObject({ count: 2 })
    expect(retired(current).original).toEqual(expect.arrayContaining([LEGACY_ENTRY, newer]))
  })

  it('serializes two readers so the original entry is archived once', async () => {
    await raw({ entries: [LEGACY_ENTRY, PUBLIC_ENTRY], meta: OLD_META })
    const first = await open(), second = await open()
    const states = await Promise.all([first.read(), second.read()])
    for (const state of states) {
      publicSurvives(state)
      expect(retired(state)).toEqual({ kind: 'retired-samples', count: 1, original: [LEGACY_ENTRY] })
    }
    expect((await raw()).entries).toEqual([PUBLIC_ENTRY])
  })
})
