import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'
import { PUBLIC_PROTOCOL_COMPANIES, publicProtocolJob } from '../fixtures/public-protocol'
import { LEGACY_ENTRY } from '../fixtures/legacy-saved-contract'
import type { SavedJob } from '../../shared/types'
import { SavedController } from '../../src/lib/saved-controller'
import { openSavedStore, SavedStorageError } from '../../src/lib/saved-store'
import type { SavedStore } from '../../src/lib/saved-store'

function item(id = 'one', note = 'Original note'): SavedJob {
  const job = publicProtocolJob(id, { id })
  return { job, company: PUBLIC_PROTOCOL_COMPANIES[0], savedAt: '2026-09-19T10:00:00.000Z', status: 'saved', note }
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

/** Each gated read captures its database snapshot first and then waits, so only a later read can observe a commit made after that capture. */
function gatedReads(store: SavedStore, count: number, skip = 0) {
  const gates = Array.from({ length: count }, () => deferred<void>())
  const waiting = [...gates]
  let reads = 0
  const wrapper: SavedStore = {
    ...store,
    read: async () => {
      const index = reads++
      const snapshot = await store.read()
      if (index >= skip) {
        const gate = waiting.shift()
        if (gate) await gate.promise
      }
      return snapshot
    },
  }
  return { wrapper, gates, reads: () => reads }
}
async function rawPut(entry: unknown) {
  await new Promise<void>((resolve, reject) => {
    const opening = factory.open('controller-test')
    opening.onerror = () => reject(opening.error)
    opening.onsuccess = () => {
      const db = opening.result
      const tx = db.transaction('records', 'readwrite')
      tx.objectStore('records').put(entry)
      tx.oncomplete = () => { db.close(); resolve() }
      tx.onabort = () => { db.close(); reject(tx.error) }
    }
  })
}

describe('return hints, startup coverage, identity reuse and finite retry permission', () => {
  it('performs exactly one read for a start without hints', async () => {
    const store = await open()
    await store.apply({ kind: 'add', record: item() })
    const { wrapper, reads } = gatedReads(store, 0)
    const controller = create(async () => wrapper)
    await controller.start()
    await ready(controller)
    expect(controller.getSnapshot().records).toEqual([item()])
    expect(reads()).toBe(1)
  })

  it('drains a hint that arrives after the initial read captured its snapshot, even with no pending writes', async () => {
    const store = await open()
    await store.apply({ kind: 'add', record: item() })
    const { wrapper, gates, reads } = gatedReads(store, 1)
    const controller = create(async () => wrapper)
    const starting = controller.start()
    await vi.waitFor(() => expect(reads()).toBe(1))
    await store.apply({ kind: 'update', id: 'one', patch: { note: 'Committed after the snapshot' } })
    controller.requestRefresh()
    gates[0].resolve()
    await starting
    await vi.waitFor(() => expect(controller.getSnapshot().records[0].note).toBe('Committed after the snapshot'))
    expect(controller.getSnapshot()).toMatchObject({ phase: 'ready', pending: 0, error: null })
    expect(reads()).toBe(2)
  })

  it('does not drop a hint that arrives while a return read is already in flight', async () => {
    const store = await open()
    await store.apply({ kind: 'add', record: item() })
    const { wrapper, gates, reads } = gatedReads(store, 1, 1)
    const controller = create(async () => wrapper)
    await controller.start()
    await ready(controller)
    controller.requestRefresh()
    await vi.waitFor(() => expect(reads()).toBe(2))
    await store.apply({ kind: 'update', id: 'one', patch: { note: 'Newer note' } })
    controller.requestRefresh()
    gates[0].resolve()
    await vi.waitFor(() => expect(controller.getSnapshot().records[0].note).toBe('Newer note'))
    expect(reads()).toBe(3)
    expect(controller.getSnapshot()).toMatchObject({ phase: 'ready', pending: 0 })
  })

  it('closes a connection whose first read is still pending when stopped, and the stopped lifetime publishes nothing', async () => {
    const writer = await open()
    await writer.apply({ kind: 'add', record: item() })
    // Every lifetime opens its own connection. The first one's close is observed but still performs the real close;
    // its gated read has already captured its snapshot, so the late completion needs no transaction.
    const gate = deferred<void>()
    const closes: Mock<() => void>[] = []
    let reads = 0
    const controller = create(async () => {
      const connection = await open()
      const close = vi.fn(() => connection.close())
      closes.push(close)
      return {
        ...connection,
        close,
        read: async () => {
          const index = reads++
          const snapshot = await connection.read()
          if (index === 0) await gate.promise
          return snapshot
        },
      }
    })
    const listener = vi.fn()
    controller.subscribe(listener)
    const starting = controller.start()
    await vi.waitFor(() => expect(reads).toBe(1))
    listener.mockClear()
    controller.stop()
    await Promise.resolve()
    expect(closes).toHaveLength(1)
    expect(closes[0]).toHaveBeenCalledTimes(1)
    gate.resolve()
    await starting
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(listener).not.toHaveBeenCalled()
    expect(controller.getSnapshot()).toMatchObject({ ready: false, records: [] })
    await controller.start()
    await ready(controller)
    expect(closes).toHaveLength(2)
    expect(closes[0]).toHaveBeenCalledTimes(1)
    expect(closes[1]).not.toHaveBeenCalled()
    expect(controller.getSnapshot().records).toEqual([item()])
    expect(reads).toBe(2)
  })

  it('grants no recreation permission from an empty-queue reconnect: a later edit of an externally removed record reports missing until its own explicit retry', async () => {
    const store = await open()
    await store.apply({ kind: 'add', record: item() })
    let failRead = false
    const controller = create(async () => {
      const connection = await open()
      return { ...connection, read: () => failRead ? Promise.reject(new SavedStorageError('unavailable')) : connection.read() }
    })
    await controller.start()
    await ready(controller)
    failRead = true
    expect(await controller.refresh()).toEqual({ status: 'failed', error: 'unavailable' })
    expect(controller.getSnapshot()).toMatchObject({ phase: 'error', ready: true, pending: 0, error: 'unavailable' })
    expect(controller.getSnapshot().records).toEqual([item()])
    failRead = false
    await controller.retry()
    await ready(controller)
    await store.apply({ kind: 'remove', id: 'one' })
    expect(controller.change({ kind: 'update', id: 'one', patch: { note: 'Edited after reconnect' } })).toEqual({ accepted: true })
    await vi.waitFor(() => expect(controller.getSnapshot().error).toBe('missing'))
    expect((await store.read()).records).toEqual([])
    expect(controller.getSnapshot().records[0].note).toBe('Edited after reconnect')
    await controller.retry()
    await ready(controller)
    expect((await store.read()).records[0]).toMatchObject({ note: 'Edited after reconnect', savedAt: item().savedAt })
  })

  it('consumes recreation permission with the retried attempt: a later edit after another external removal reports missing again', async () => {
    const store = await open()
    await store.apply({ kind: 'add', record: item() })
    const controller = create()
    await controller.start()
    await ready(controller)
    await store.apply({ kind: 'remove', id: 'one' })
    controller.change({ kind: 'update', id: 'one', patch: { note: 'First draft' } })
    await vi.waitFor(() => expect(controller.getSnapshot().error).toBe('missing'))
    await controller.retry()
    await ready(controller)
    expect((await store.read()).records[0]).toMatchObject({ note: 'First draft', savedAt: item().savedAt })
    await store.apply({ kind: 'remove', id: 'one' })
    controller.change({ kind: 'update', id: 'one', patch: { note: 'Second draft' } })
    await vi.waitFor(() => expect(controller.getSnapshot().error).toBe('missing'))
    expect((await store.read()).records).toEqual([])
    expect(controller.getSnapshot().records[0].note).toBe('Second draft')
    await controller.retry()
    await ready(controller)
    expect((await store.read()).records[0]).toMatchObject({ note: 'Second draft', savedAt: item().savedAt })
  })

  it('keeps typing coalesced into the retried entry but grants nothing to a new operation on another record', async () => {
    const store = await open()
    await store.apply({ kind: 'add', record: item() })
    await store.apply({ kind: 'add', record: item('two', 'Second note') })
    const controller = create()
    await controller.start()
    await ready(controller)
    await store.apply({ kind: 'remove', id: 'one' })
    controller.change({ kind: 'update', id: 'one', patch: { note: 'Draft one' } })
    await vi.waitFor(() => expect(controller.getSnapshot().error).toBe('missing'))
    controller.change({ kind: 'update', id: 'one', patch: { note: 'Draft one, more typing' } })
    expect(controller.getSnapshot()).toMatchObject({ pending: 1, error: 'missing' })
    expect(controller.getSnapshot().records.find(record => record.job.id === 'one')?.note).toBe('Draft one, more typing')
    await controller.retry()
    await ready(controller)
    expect((await store.read()).records.find(record => record.job.id === 'one')).toMatchObject({ note: 'Draft one, more typing', savedAt: item().savedAt })
    expect((await store.read()).records.find(record => record.job.id === 'two')).toMatchObject({ note: 'Second note' })
    await store.apply({ kind: 'remove', id: 'two' })
    controller.change({ kind: 'update', id: 'two', patch: { note: 'Draft two' } })
    await vi.waitFor(() => expect(controller.getSnapshot().error).toBe('missing'))
    expect((await store.read()).records.map(record => record.job.id)).toEqual(['one'])
    expect(controller.getSnapshot().records.find(record => record.job.id === 'two')?.note).toBe('Draft two')
  })

  it('reuses the whole snapshot for an unchanged collection with empty recovery and keeps unchanged record and job identity when one field changes', async () => {
    const store = await open()
    await store.apply({ kind: 'add', record: item('one', 'Original note') })
    await store.apply({ kind: 'add', record: item('two', 'Second note') })
    const controller = create()
    await controller.start()
    await ready(controller)
    const before = controller.getSnapshot()
    expect(before.records.map(record => record.job.id)).toEqual(['two', 'one'])
    const listener = vi.fn()
    controller.subscribe(listener)
    for (let attempt = 0; attempt < 3; attempt++) {
      const result = await controller.refresh()
      expect(result.status).toBe('refreshed')
      if (result.status === 'refreshed') expect(result.snapshot).toBe(before)
    }
    expect(listener).not.toHaveBeenCalled()
    expect(controller.getSnapshot()).toBe(before)
    await store.apply({ kind: 'update', id: 'two', patch: { status: 'applied' } })
    await controller.refresh()
    expect(listener).toHaveBeenCalledTimes(1)
    const current = controller.getSnapshot()
    expect(current.records.map(record => record.job.id)).toEqual(['two', 'one'])
    expect(current.records[0]).toMatchObject({ status: 'applied', note: 'Second note', savedAt: item().savedAt })
    expect(current.records[0].job).toBe(before.records[0].job)
    expect(current.records[1]).toBe(before.records[1])
    expect(current.records).not.toBe(before.records)
  })

  it('keeps the active records array across reads with an opaque retired-samples archive and surfaces a real archive change', async () => {
    const store = await open()
    await store.apply({ kind: 'add', record: item() })
    await rawPut(LEGACY_ENTRY)
    const controller = create()
    await controller.start()
    await ready(controller)
    const before = controller.getSnapshot()
    expect(before.records).toEqual([item()])
    expect(before.occupied).toBe(1)
    expect(before.recovery).toEqual([{ kind: 'retired-samples', count: 1, original: [LEGACY_ENTRY] }])
    const listener = vi.fn()
    controller.subscribe(listener)
    await controller.refresh()
    await controller.refresh()
    const after = controller.getSnapshot()
    expect(after.records).toBe(before.records)
    expect(after.recovery).toEqual(before.recovery)
    expect(after.occupied).toBe(1)
    const rewritten = { ...LEGACY_ENTRY, record: { ...LEGACY_ENTRY.record, note: 'OLD_TAB_NEW_NOTE' } }
    await rawPut(rewritten)
    listener.mockClear()
    await controller.refresh()
    const changed = controller.getSnapshot()
    expect(changed.records).toBe(before.records)
    expect(changed.recovery).toMatchObject([{ kind: 'retired-samples', count: 2 }])
    expect(changed.recovery[0].original).toEqual(expect.arrayContaining([LEGACY_ENTRY, rewritten]))
    expect(listener).toHaveBeenCalled()
    expect(changed).not.toBe(after)
  })
})
