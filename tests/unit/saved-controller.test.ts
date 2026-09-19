import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'
import { createSampleCatalog } from '../../shared/sample'
import type { SavedJob } from '../../shared/types'
import { SavedController } from '../../src/lib/saved-controller'
import { openSavedStore, SavedStorageError } from '../../src/lib/saved-store'
import type { SavedStore } from '../../src/lib/saved-store'

const sample = createSampleCatalog()
function item(id = 'one', note = 'Original note'): SavedJob {
  const job = { ...sample.jobs[0], id }
  return { job, company: sample.companies.find(company => company.id === job.companyId)!, savedAt: '2026-09-19T10:00:00.000Z', status: 'saved', note }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
let factory: IDBFactory
let stores: SavedStore[]
let controllers: SavedController[]
beforeEach(() => { factory = new IDBFactory(); stores = []; controllers = [] })
afterEach(() => { controllers.forEach(controller => controller.stop()); stores.forEach(store => store.close()) })
async function open() {
  const store = await openSavedStore({ factory, name: 'controller-test', legacy: { getItem: () => null, removeItem: () => undefined } })
  stores.push(store)
  return store
}
function create(connect: () => Promise<SavedStore> = open) {
  const controller = new SavedController(connect)
  controllers.push(controller)
  return controller
}
async function ready(controller: SavedController) {
  await vi.waitFor(() => expect(controller.getSnapshot().phase).toBe('ready'))
}

describe('saved drafts and committed records', () => {
  it('blocks changes until the initial read succeeds and retries a failed load without showing an empty collection as ready', async () => {
    const store = await open()
    await store.apply({ kind: 'add', record: item() })
    let available = false
    const controller = create(async () => {
      if (!available) throw new SavedStorageError('unavailable')
      return open()
    })
    expect(controller.change({ kind: 'add', record: item('two') })).toEqual({ accepted: false, reason: 'loading' })
    await controller.start()
    expect(controller.getSnapshot()).toMatchObject({ phase: 'error', ready: false, pending: 0, error: 'unavailable' })
    available = true
    await controller.retry()
    expect(controller.getSnapshot()).toMatchObject({ phase: 'ready', ready: true })
    expect(controller.getSnapshot().records).toEqual([item()])
  })

  it('keeps the latest draft visible while coalescing queued keystrokes and waits for each commit', async () => {
    const store = await open()
    await store.apply({ kind: 'add', record: item() })
    const gate = deferred<void>()
    const apply = vi.fn<SavedStore['apply']>().mockImplementationOnce(async operation => {
      await gate.promise
      return store.apply(operation)
    }).mockImplementation(operation => store.apply(operation))
    const controller = create(async () => ({ ...store, apply }))
    await controller.start()
    controller.change({ kind: 'update', id: 'one', patch: { note: 'First keystroke' } })
    controller.change({ kind: 'update', id: 'one', patch: { note: 'More typing' } })
    controller.change({ kind: 'update', id: 'one', patch: { status: 'applied' } })
    controller.change({ kind: 'update', id: 'one', patch: { note: 'Latest complete note' } })
    expect(controller.getSnapshot()).toMatchObject({ phase: 'saving', pending: 2 })
    expect(controller.getSnapshot().records[0]).toMatchObject({ note: 'Latest complete note', status: 'applied' })
    expect((await store.read()).records[0].note).toBe('Original note')
    gate.resolve()
    await ready(controller)
    expect(apply).toHaveBeenCalledTimes(2)
    expect((await store.read()).records[0]).toMatchObject({ note: 'Latest complete note', status: 'applied', savedAt: item().savedAt })
    expect(controller.getSnapshot().pending).toBe(0)
  })

  it('retains edits after a failed write, accepts further typing and retries against the newest database records', async () => {
    const store = await open()
    await store.apply({ kind: 'add', record: item() })
    let failing = true
    const controller = create(async () => {
      const connection = await open()
      return { ...connection, apply: (operation, draft) => failing ? Promise.reject(new SavedStorageError('quota')) : connection.apply(operation, draft) }
    })
    await controller.start()
    controller.change({ kind: 'update', id: 'one', patch: { note: 'Failed note' } })
    await vi.waitFor(() => expect(controller.getSnapshot().error).toBe('quota'))
    controller.change({ kind: 'update', id: 'one', patch: { note: 'Latest unsaved note' } })
    expect(controller.getSnapshot()).toMatchObject({ phase: 'error', ready: true, pending: 1 })
    expect(controller.getSnapshot().records[0].note).toBe('Latest unsaved note')
    expect((await store.read()).records[0].note).toBe('Original note')
    await store.apply({ kind: 'update', id: 'one', patch: { status: 'applied' } })
    await store.apply({ kind: 'add', record: item('other-tab') })
    failing = false
    await controller.retry()
    await ready(controller)
    expect(controller.getSnapshot().records.map(record => record.job.id)).toEqual(['other-tab', 'one'])
    expect((await store.read()).records.find(record => record.job.id === 'one')).toMatchObject({ note: 'Latest unsaved note', status: 'applied' })
  })

  it('defers cross-tab refresh during a write and merges another tab’s different field without losing the local draft', async () => {
    const store = await open()
    await store.apply({ kind: 'add', record: item() })
    const gate = deferred<void>()
    const controller = create(async () => ({ ...store, apply: async operation => { await gate.promise; return store.apply(operation) } }))
    await controller.start()
    controller.change({ kind: 'update', id: 'one', patch: { note: 'Local draft' } })
    await store.apply({ kind: 'update', id: 'one', patch: { status: 'applied' } })
    await store.apply({ kind: 'add', record: item('other-tab') })
    await controller.refresh()
    expect(controller.getSnapshot().records[0].note).toBe('Local draft')
    gate.resolve()
    await vi.waitFor(() => expect(controller.getSnapshot().records).toHaveLength(2))
    expect(controller.getSnapshot().records.find(record => record.job.id === 'one')).toMatchObject({ note: 'Local draft', status: 'applied' })
  })

  it('keeps a new local edit when a previously started cross-tab read returns', async () => {
    const store = await open()
    await store.apply({ kind: 'add', record: item() })
    const gate = deferred<void>()
    let delay = false
    const controller = create(async () => ({
      ...store,
      read: async () => { const snapshot = await store.read(); if (delay) await gate.promise; return snapshot },
    }))
    await controller.start()
    delay = true
    const refreshing = controller.refresh()
    controller.change({ kind: 'update', id: 'one', patch: { note: 'Typed during refresh' } })
    expect(controller.getSnapshot().records[0].note).toBe('Typed during refresh')
    gate.resolve()
    await refreshing
    await ready(controller)
    expect((await store.read()).records[0].note).toBe('Typed during refresh')
  })

  it('ignores a late acknowledgement from a stopped connection and safely replays an already committed save', async () => {
    const committed = deferred<void>()
    const acknowledge = deferred<void>()
    let first = true
    const controller = create(async () => {
      const store = await open()
      if (!first) return store
      first = false
      return { ...store, apply: async operation => {
        const result = await store.apply(operation)
        committed.resolve()
        await acknowledge.promise
        return result
      } }
    })
    await controller.start()
    controller.change({ kind: 'add', record: item() })
    await committed.promise
    controller.stop()
    await controller.start()
    await ready(controller)
    acknowledge.resolve()
    await Promise.resolve()
    expect(controller.getSnapshot()).toMatchObject({ phase: 'ready', pending: 0 })
    expect(controller.getSnapshot().records).toEqual([item()])
    expect((await (await open()).read()).records).toEqual([item()])
  })

  it('keeps an externally removed job’s note available and recreates it only on explicit retry', async () => {
    const store = await open()
    await store.apply({ kind: 'add', record: item() })
    const controller = create()
    await controller.start()
    await store.apply({ kind: 'remove', id: 'one' })
    controller.change({ kind: 'update', id: 'one', patch: { note: 'Do not lose this draft' } })
    await vi.waitFor(() => expect(controller.getSnapshot().error).toBe('missing'))
    expect(controller.getSnapshot().records[0].note).toBe('Do not lose this draft')
    expect((await store.read()).records).toEqual([])
    await controller.retry()
    await ready(controller)
    expect((await store.read()).records[0]).toMatchObject({ note: 'Do not lose this draft', savedAt: item().savedAt })
  })

  it('lets a removal supersede a failed note instead of blocking the whole queue on an unwanted edit', async () => {
    const store = await open()
    await store.apply({ kind: 'add', record: item() })
    const controller = create(async () => {
      const connection = await open()
      return { ...connection, apply: (operation, draft) => operation.kind === 'update'
        ? Promise.reject(new SavedStorageError('quota')) : connection.apply(operation, draft) }
    })
    await controller.start()
    controller.change({ kind: 'update', id: 'one', patch: { note: 'Unwanted draft' } })
    await vi.waitFor(() => expect(controller.getSnapshot().error).toBe('quota'))
    controller.change({ kind: 'remove', id: 'one' })
    await controller.retry()
    await ready(controller)
    expect((await store.read()).records).toEqual([])
    expect(controller.getSnapshot().pending).toBe(0)
  })

  it('frees a slot before retrying an add that hit capacity because another tab saved a record', async () => {
    const initial = Array.from({ length: 499 }, (_, index) => item(`job-${index}`))
    const seeded = await openSavedStore({ factory, name: 'controller-test', legacy: { getItem: () => JSON.stringify(initial), removeItem: () => undefined } })
    stores.push(seeded)
    const controller = create()
    await controller.start()
    await seeded.apply({ kind: 'add', record: item('other-tab') })
    expect(controller.change({ kind: 'add', record: item('local-add') }).accepted).toBe(true)
    await vi.waitFor(() => expect(controller.getSnapshot().error).toBe('limit'))
    controller.change({ kind: 'remove', id: 'job-0' })
    await controller.retry()
    await ready(controller)
    const committed = (await seeded.read()).records
    expect(committed).toHaveLength(500)
    expect(committed.some(record => record.job.id === 'job-0')).toBe(false)
    expect(committed.some(record => record.job.id === 'local-add')).toBe(true)
    expect(committed.some(record => record.job.id === 'other-tab')).toBe(true)
  })

  it('keeps import exclusive with local edits and refreshes other-tab records after the import commits', async () => {
    const store = await open()
    await store.apply({ kind: 'add', record: item() })
    const gate = deferred<void>()
    const controller = create(async () => ({
      ...store,
      importRecords: async plan => { await gate.promise; await store.importRecords(plan) },
    }))
    await controller.start()
    const importing = controller.importRecords({ items: [{ record: item('imported'), expected: null }] })
    expect(controller.getSnapshot()).toMatchObject({ busy: true, phase: 'saving', pending: 0 })
    expect(controller.change({ kind: 'update', id: 'one', patch: { note: 'Cannot interleave' } })).toEqual({ accepted: false, reason: 'busy' })
    expect(await controller.importRecords({ items: [] })).toEqual({ ok: false, error: 'busy' })
    await store.apply({ kind: 'add', record: item('other-tab') })
    await controller.refresh()
    gate.resolve()
    expect(await importing).toEqual({ ok: true })
    await ready(controller)
    expect(controller.getSnapshot().records.map(record => record.job.id)).toEqual(['imported', 'other-tab', 'one'])
    expect(controller.getSnapshot().busy).toBe(false)
  })

  it('leaves the prior collection usable after an atomic import failure without adding an unsaved draft', async () => {
    const store = await open()
    await store.apply({ kind: 'add', record: item() })
    const controller = create(async () => ({ ...store, importRecords: async () => { throw new SavedStorageError('quota') } }))
    await controller.start()
    expect(await controller.importRecords({ items: [{ record: item('file'), expected: null }] })).toEqual({ ok: false, error: 'quota' })
    expect(controller.getSnapshot()).toMatchObject({ records: [item()], phase: 'ready', pending: 0, busy: false, error: null })
    controller.change({ kind: 'update', id: 'one', patch: { note: 'Normal editing still works' } })
    await ready(controller)
    expect((await store.read()).records[0].note).toBe('Normal editing still works')
  })

  it('reports a committed import separately from a failed subsequent read and recovers by reconnecting', async () => {
    let failRead = false
    const controller = create(async () => {
      const store = await open()
      return {
        ...store,
        read: () => failRead ? Promise.reject(new SavedStorageError('unavailable')) : store.read(),
        importRecords: async plan => { await store.importRecords(plan); failRead = true },
      }
    })
    await controller.start()
    expect(await controller.importRecords({ items: [{ record: item('file'), expected: null }] })).toEqual({ ok: true, refreshFailed: true })
    expect(controller.getSnapshot()).toMatchObject({ phase: 'error', pending: 0, busy: false, error: 'unavailable' })
    expect((await (await open()).read()).records).toEqual([item('file')])
    failRead = false
    await controller.retry()
    expect(controller.getSnapshot()).toMatchObject({ phase: 'ready', records: [item('file')] })
  })
})
