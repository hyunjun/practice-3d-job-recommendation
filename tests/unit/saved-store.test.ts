import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IDBFactory, IDBObjectStore as FakeObjectStore } from 'fake-indexeddb'
import { createSampleCatalog } from '../../shared/sample'
import { decodeSavedJobs, MAX_SAVED_JOBS } from '../../shared/saved-jobs'
import type { SavedJob } from '../../shared/types'
import { openSavedStore, SAVED_RECORD_STORE } from '../../src/lib/saved-store'
import type { SavedStore } from '../../src/lib/saved-store'

const sample = createSampleCatalog()
const name = 'saved-storage-test'
const time = '2026-09-19T10:00:00.000Z'
function item(id: string, note = ''): SavedJob {
  const job = { ...sample.jobs[0], id }
  return { job, company: sample.companies.find(company => company.id === job.companyId)!, savedAt: time, status: 'applied', note }
}
let factory: IDBFactory
let values: Map<string, string>
let opened: SavedStore[]
let legacy: { getItem(key: string): string | null; removeItem(key: string): void }
beforeEach(() => {
  factory = new IDBFactory()
  values = new Map()
  opened = []
  legacy = { getItem: key => values.get(key) ?? null, removeItem: key => { values.delete(key) } }
})
afterEach(() => { opened.forEach(store => store.close()); vi.restoreAllMocks() })
async function open() {
  const store = await openSavedStore({ factory, name, legacy })
  opened.push(store)
  return store
}
async function rawEntries(write?: unknown): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const opening = factory.open(name)
    opening.onerror = () => reject(opening.error)
    opening.onsuccess = () => {
      const db = opening.result
      const tx = db.transaction(SAVED_RECORD_STORE, write === undefined ? 'readonly' : 'readwrite')
      const store = tx.objectStore(SAVED_RECORD_STORE)
      if (write !== undefined) store.put(write)
      const request = store.getAll()
      tx.oncomplete = () => { db.close(); resolve(request.result) }
      tx.onabort = () => { db.close(); reject(tx.error) }
    }
  })
}

describe('individual saved records and legacy recovery', () => {
  it('recovers valid neighbours, keeps the first duplicate and bounds the number of imported records', () => {
    const first = item('one', 'First note')
    const decoded = decodeSavedJobs(JSON.stringify([first, { invalid: true }, item('one', 'Duplicate note'), item('two')]))
    expect(decoded.records.map(record => record.job.id)).toEqual(['one', 'two'])
    expect(decoded.records[0].note).toBe('First note')
    expect(decoded.omitted).toBe(2)
    expect(decodeSavedJobs('{broken')).toEqual({ records: [], omitted: null, reason: 'format' })
    const overflow = decodeSavedJobs(JSON.stringify(Array.from({ length: MAX_SAVED_JOBS + 1 }, (_, index) => item(String(index)))))
    expect(overflow.records).toHaveLength(MAX_SAVED_JOBS)
    expect(overflow.omitted).toBe(1)
  })

  it('migrates the original order, notes, application status and dates before removing the legacy key', async () => {
    const original = [item('first', 'Original note'), item('second'), item('third')]
    values.set('orbit.v1.saved', JSON.stringify(original))
    const store = await open()
    expect((await store.read()).records).toEqual(original)
    expect((await store.read()).recovery).toEqual([])
    expect(values.has('orbit.v1.saved')).toBe(false)
    store.close()
    expect((await (await open()).read()).records).toEqual(original)
  })

  it('archives a malformed source and imports healthy records without overwriting them with an empty array', async () => {
    const raw = JSON.stringify([item('healthy', 'Keep this note'), { invalid: true }])
    values.set('orbit.v1.saved', raw)
    const store = await open()
    const restored = await store.read()
    expect(restored.records.map(record => record.job.id)).toEqual(['healthy'])
    expect(restored.recovery).toEqual([{ kind: 'legacy', count: 1, original: raw }])
    await store.apply({ kind: 'update', id: 'healthy', patch: { note: 'Edited note' } })
    expect((await store.read()).recovery[0].original).toBe(raw)
  })

  it('preserves malformed JSON verbatim and allows a new record after the source is safely archived', async () => {
    const raw = '{"truncated":'
    values.set('orbit.v1.saved', raw)
    const store = await open()
    expect((await store.read()).recovery).toEqual([{ kind: 'legacy', count: null, original: raw }])
    await store.apply({ kind: 'add', record: item('new') })
    expect((await store.read()).records).toHaveLength(1)
    expect((await store.read()).recovery[0].original).toBe(raw)
  })

  it('leaves the original key and no partial records when migration aborts', async () => {
    const raw = JSON.stringify([item('first'), item('second')])
    values.set('orbit.v1.saved', raw)
    const originalPut = FakeObjectStore.prototype.put
    const failing = vi.spyOn(FakeObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, value, key) {
      if (this.name === 'meta') throw new DOMException('No space', 'QuotaExceededError')
      return originalPut.call(this, value, key)
    })
    await expect(open()).rejects.toMatchObject({ code: 'quota' })
    expect(values.get('orbit.v1.saved')).toBe(raw)
    expect(await rawEntries()).toEqual([])
    failing.mockRestore()
    expect((await (await open()).read()).records).toHaveLength(2)
    expect(values.has('orbit.v1.saved')).toBe(false)
  })

  it('does not delete or overwrite an older tab edit that appeared during migration', async () => {
    const raw = JSON.stringify([item('one', 'Before migration')])
    const edited = JSON.stringify([item('one', 'Edited in an older tab')])
    values.set('orbit.v1.saved', raw)
    let reads = 0
    legacy.getItem = key => ++reads > 1 ? edited : values.get(key) ?? null
    const store = await open()
    expect(values.get('orbit.v1.saved')).toBe(raw)
    const state = await store.read()
    expect(state.records[0].note).toBe('Before migration')
    expect(state.recovery).toEqual([{ kind: 'additional-legacy', count: null, original: edited }])
  })

  it('does not reimport a known legacy snapshot or replace a newer note on reopening', async () => {
    const raw = JSON.stringify([item('one', 'Old note')])
    values.set('orbit.v1.saved', raw)
    const store = await open()
    await store.apply({ kind: 'update', id: 'one', patch: { note: 'New note' } })
    store.close()
    values.set('orbit.v1.saved', raw)
    const restored = await (await open()).read()
    expect(restored.records[0].note).toBe('New note')
    expect(values.has('orbit.v1.saved')).toBe(false)
  })

  it('retains an unreadable database entry and prevents a save or deletion from replacing it', async () => {
    const store = await open()
    await store.apply({ kind: 'add', record: item('healthy') })
    const damaged = { id: 'damaged', order: 2, record: { invalid: true } }
    await rawEntries(damaged)
    const restored = await store.read()
    expect(restored.records).toHaveLength(1)
    expect(restored.occupied).toBe(2)
    expect(restored.unreadableIds).toEqual(['damaged'])
    expect(restored.recovery).toEqual([{ kind: 'records', count: 1, original: [damaged] }])
    await expect(store.apply({ kind: 'add', record: item('damaged') })).rejects.toMatchObject({ code: 'unreadable' })
    await expect(store.apply({ kind: 'remove', id: 'damaged' })).rejects.toMatchObject({ code: 'unreadable' })
    expect(await rawEntries()).toContainEqual(damaged)
  })
})

describe('transactional edits', () => {
  it('acknowledges a transaction only after commit and keeps the old note when a successful put is followed by an abort', async () => {
    const store = await open()
    await store.apply({ kind: 'add', record: item('one', 'Committed note') })
    const originalPut = FakeObjectStore.prototype.put
    const failing = vi.spyOn(FakeObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, value, key) {
      const request = originalPut.call(this, value, key)
      if (this.name === SAVED_RECORD_STORE) request.addEventListener('success', () => this.transaction.abort(), { once: true })
      return request
    })
    await expect(store.apply({ kind: 'update', id: 'one', patch: { note: 'Uncommitted note' } })).rejects.toMatchObject({ code: 'write' })
    failing.mockRestore()
    expect((await store.read()).records[0].note).toBe('Committed note')
  })

  it('edits one record while merging a different field written through another connection', async () => {
    const first = await open()
    await first.apply({ kind: 'add', record: item('one', 'Original') })
    const second = await open()
    await second.apply({ kind: 'update', id: 'one', patch: { status: 'saved' } })
    await first.apply({ kind: 'update', id: 'one', patch: { note: 'New note' } })
    expect((await first.read()).records[0]).toMatchObject({ note: 'New note', status: 'saved', savedAt: time })
    await first.apply({ kind: 'add', record: item('one', 'A duplicate must not replace the note') })
    expect((await second.read()).records[0].note).toBe('New note')
  })

  it('keeps order stable on edits and puts a restored record first without changing its saved date', async () => {
    const store = await open()
    await store.apply({ kind: 'add', record: item('one') })
    await store.apply({ kind: 'add', record: item('two') })
    await store.apply({ kind: 'update', id: 'one', patch: { note: 'Edited' } })
    expect((await store.read()).records.map(record => record.job.id)).toEqual(['two', 'one'])
    await store.apply({ kind: 'remove', id: 'one' })
    await store.apply({ kind: 'add', record: item('one', 'Restored') })
    expect((await store.read()).records.map(record => record.job.id)).toEqual(['one', 'two'])
    expect((await store.read()).records[0].savedAt).toBe(time)
  })

  it('does not recreate an externally removed record until retry explicitly supplies the current draft', async () => {
    const store = await open()
    await expect(store.apply({ kind: 'update', id: 'removed', patch: { note: 'Draft' } })).rejects.toMatchObject({ code: 'missing' })
    await store.apply({ kind: 'update', id: 'removed', patch: { note: 'Draft' } }, item('removed', 'Original'))
    expect((await store.read()).records[0]).toMatchObject({ note: 'Draft', savedAt: time })
  })

  it('enforces capacity inside the transaction while still allowing notes and deletion', async () => {
    values.set('orbit.v1.saved', JSON.stringify(Array.from({ length: MAX_SAVED_JOBS }, (_, index) => item(`job-${index}`))))
    const store = await open()
    await expect(store.apply({ kind: 'add', record: item('overflow') })).rejects.toMatchObject({ code: 'limit' })
    await store.apply({ kind: 'update', id: 'job-0', patch: { note: 'Allowed at capacity' } })
    await store.apply({ kind: 'remove', id: 'job-1' })
    await store.apply({ kind: 'add', record: item('replacement') })
    expect((await store.read()).records).toHaveLength(MAX_SAVED_JOBS)
    expect((await store.read()).records.find(record => record.job.id === 'job-0')?.note).toBe('Allowed at capacity')
  })
})

describe('reviewed imports and recovery cleanup', () => {
  it('imports a selection atomically, preserves existing positions and keeps the file order and dates for new records', async () => {
    const store = await open()
    await store.apply({ kind: 'add', record: item('one', 'Current note') })
    await store.apply({ kind: 'add', record: item('two') })
    const current = (await store.read()).records.find(record => record.job.id === 'one')!
    await store.importRecords({ items: [
      { record: item('file-first'), expected: null },
      { record: item('one', 'Selected incoming note'), expected: current },
      { record: item('file-second'), expected: null },
    ] })
    const after = (await store.read()).records
    expect(after.map(record => record.job.id)).toEqual(['file-first', 'file-second', 'two', 'one'])
    expect(after.find(record => record.job.id === 'one')).toMatchObject({ note: 'Selected incoming note', savedAt: time })
    expect(after.every(record => record.savedAt === time)).toBe(true)
  })

  it('aborts every selected write when a transaction fails after an earlier record was written', async () => {
    const store = await open()
    await store.apply({ kind: 'add', record: item('one', 'Keep current note') })
    const current = (await store.read()).records[0]
    const originalPut = FakeObjectStore.prototype.put
    let writes = 0
    vi.spyOn(FakeObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, value, key) {
      if (this.name === SAVED_RECORD_STORE && ++writes === 2) throw new DOMException('Full storage', 'QuotaExceededError')
      return originalPut.call(this, value, key)
    })
    await expect(store.importRecords({ items: [
      { record: item('new'), expected: null },
      { record: item('one', 'Uncommitted replacement'), expected: current },
    ] })).rejects.toMatchObject({ code: 'quota' })
    expect(writes).toBe(2)
    expect((await store.read()).records).toEqual([current])
  })

  it('rejects stale previews if another connection edited, added or removed an affected record', async () => {
    const first = await open()
    await first.apply({ kind: 'add', record: item('one', 'Previewed note') })
    const preview = (await first.read()).records[0]
    const other = await open()
    await other.apply({ kind: 'update', id: 'one', patch: { note: 'Newer other-tab note' } })
    await expect(first.importRecords({ items: [
      { record: item('new'), expected: null },
      { record: item('one', 'File note'), expected: preview },
    ] })).rejects.toMatchObject({ code: 'changed' })
    expect((await first.read()).records).toHaveLength(1)
    await expect(first.importRecords({ items: [{ record: item('one'), expected: null }] })).rejects.toMatchObject({ code: 'changed' })
    await other.apply({ kind: 'remove', id: 'one' })
    await expect(first.importRecords({ items: [{ record: item('one'), expected: preview }] })).rejects.toMatchObject({ code: 'changed' })
  })

  it('checks total capacity before an import and allows a replacement at the limit', async () => {
    values.set('orbit.v1.saved', JSON.stringify(Array.from({ length: MAX_SAVED_JOBS }, (_, index) => item(`job-${index}`))))
    const store = await open()
    const current = (await store.read()).records[0]
    await expect(store.importRecords({ items: [
      { record: { ...current, note: 'Must roll back too' }, expected: current },
      { record: item('overflow'), expected: null },
    ] })).rejects.toMatchObject({ code: 'limit' })
    expect((await store.read()).records[0]).toEqual(current)
    await store.importRecords({ items: [{ record: { ...current, note: 'Replacement at capacity' }, expected: current }] })
    expect((await store.read()).records[0].note).toBe('Replacement at capacity')
    expect((await store.read()).records).toHaveLength(MAX_SAVED_JOBS)
  })

  it('does not overwrite unreadable entries and removes only the reviewed unreadable source', async () => {
    const store = await open()
    await store.apply({ kind: 'add', record: item('healthy') })
    const damaged = { id: 'damaged', order: 2, record: { invalid: true } }
    await rawEntries(damaged)
    const target = (await store.read()).recovery[0]
    await expect(store.importRecords({ items: [{ record: item('damaged'), expected: null }] })).rejects.toMatchObject({ code: 'unreadable' })
    await store.discardRecovery(target)
    expect((await store.read()).records).toEqual([item('healthy')])
    expect((await store.read()).recovery).toEqual([])
    await store.importRecords({ items: [{ record: item('damaged'), expected: null }] })
    expect((await store.read()).records).toHaveLength(2)
  })

  it('does not delete a source that changed after review or a now-healthy database entry', async () => {
    const store = await open()
    await rawEntries({ id: 'damaged', order: 2, record: { invalid: true } })
    const target = (await store.read()).recovery[0]
    await rawEntries({ id: 'damaged', order: 2, record: item('damaged', 'Repaired elsewhere') })
    await expect(store.discardRecovery(target)).rejects.toMatchObject({ code: 'changed' })
    expect((await store.read()).records[0].note).toBe('Repaired elsewhere')
    values.set('orbit.v1.saved', JSON.stringify([item('old-tab')]))
    const legacy = (await store.read()).recovery[0]
    const newer = JSON.stringify([item('old-tab', 'Changed after review')])
    values.set('orbit.v1.saved', newer)
    await expect(store.discardRecovery(legacy)).rejects.toMatchObject({ code: 'changed' })
    expect(values.get('orbit.v1.saved')).toBe(newer)
    await store.discardRecovery((await store.read()).recovery[0])
    expect(values.has('orbit.v1.saved')).toBe(false)
    expect((await store.read()).records[0].note).toBe('Repaired elsewhere')
  })

  it('retains the migration marker after clearing an archived source so deleted records do not reappear', async () => {
    const original = JSON.stringify([item('one'), { invalid: true }])
    values.set('orbit.v1.saved', original)
    const store = await open()
    await store.apply({ kind: 'remove', id: 'one' })
    await store.discardRecovery((await store.read()).recovery[0])
    expect((await store.read()).recovery).toEqual([])
    store.close()
    values.set('orbit.v1.saved', original)
    expect((await (await open()).read()).records).toEqual([])
    expect(values.has('orbit.v1.saved')).toBe(false)
  })

  it('discloses an undeleted legacy copy separately and never implies that deleting the archive removed it', async () => {
    const original = JSON.stringify([item('one'), { invalid: true }])
    values.set('orbit.v1.saved', original)
    legacy.removeItem = () => { throw new DOMException('Denied removal', 'SecurityError') }
    const store = await open()
    expect((await store.read()).recovery.map(source => source.kind)).toEqual(['legacy', 'additional-legacy'])
    await store.discardRecovery((await store.read()).recovery[0])
    expect((await store.read()).recovery.map(source => source.kind)).toEqual(['additional-legacy'])
    expect(values.get('orbit.v1.saved')).toBe(original)
  })
})
