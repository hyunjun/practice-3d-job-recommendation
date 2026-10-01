/**
 * Stage78 lifecycle units: the return-signal installer against a synthetic
 * window/document, and the controller's typed explicit comparison across
 * startup, in-flight reads, writes, imports and stop. Expected values are
 * literal fixture values; no product function computes an expectation.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'
import { PUBLIC_PROTOCOL_COMPANIES, publicProtocolJob } from '../fixtures/public-protocol'
import type { SavedJob } from '../../shared/types'
import { installSavedLifecycle } from '../../src/lib/saved-lifecycle'
import { SavedController } from '../../src/lib/saved-controller'
import { openSavedStore, SavedStorageError } from '../../src/lib/saved-store'
import type { SavedStore } from '../../src/lib/saved-store'

class FakePageTransitionEvent extends Event {
  readonly persisted: boolean
  constructor(type: string, init: { persisted: boolean }) {
    super(type)
    this.persisted = init.persisted
  }
}
type FakeWindow = EventTarget & { setTimeout: typeof globalThis.setTimeout; clearTimeout: typeof globalThis.clearTimeout }

describe('installSavedLifecycle with a synthetic window and document', () => {
  let visibility: 'visible' | 'hidden'
  let win: FakeWindow
  let doc: EventTarget
  beforeEach(() => {
    vi.useFakeTimers()
    visibility = 'visible'
    win = Object.assign(new EventTarget(), {
      // Delegate lazily so the fake timers installed above control the zero-delay task.
      setTimeout: ((...args: Parameters<typeof globalThis.setTimeout>) => globalThis.setTimeout(...args)) as unknown as typeof globalThis.setTimeout,
      clearTimeout: ((timer: Parameters<typeof globalThis.clearTimeout>[0]) => globalThis.clearTimeout(timer)) as unknown as typeof globalThis.clearTimeout,
    })
    doc = new EventTarget()
    Object.defineProperty(doc, 'visibilityState', { configurable: true, get: () => visibility })
    vi.stubGlobal('window', win)
    vi.stubGlobal('document', doc)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('coalesces a visible focus, visibilitychange and persisted pageshow burst into one zero-delay hint and never imposes a cooldown', () => {
    const onHint = vi.fn()
    const dispose = installSavedLifecycle(onHint)
    win.dispatchEvent(new Event('focus'))
    doc.dispatchEvent(new Event('visibilitychange'))
    win.dispatchEvent(new FakePageTransitionEvent('pageshow', { persisted: true }))
    win.dispatchEvent(new Event('focus'))
    expect(onHint).not.toHaveBeenCalled()
    vi.runAllTimers()
    expect(onHint).toHaveBeenCalledTimes(1)
    win.dispatchEvent(new Event('focus'))
    vi.runAllTimers()
    expect(onHint).toHaveBeenCalledTimes(2)
    doc.dispatchEvent(new Event('visibilitychange'))
    win.dispatchEvent(new FakePageTransitionEvent('pageshow', { persisted: true }))
    vi.runAllTimers()
    expect(onHint).toHaveBeenCalledTimes(3)
    dispose()
  })

  it('ignores hidden visibility changes, a non-persisted pageshow and focus events that are not the window\'s own focus', () => {
    const onHint = vi.fn()
    const dispose = installSavedLifecycle(onHint)
    visibility = 'hidden'
    doc.dispatchEvent(new Event('visibilitychange'))
    win.dispatchEvent(new Event('focus'))
    win.dispatchEvent(new FakePageTransitionEvent('pageshow', { persisted: true }))
    vi.runAllTimers()
    expect(onHint).not.toHaveBeenCalled()
    visibility = 'visible'
    win.dispatchEvent(new FakePageTransitionEvent('pageshow', { persisted: false }))
    const element = new EventTarget()
    element.dispatchEvent(new Event('focus'))
    element.dispatchEvent(new Event('focusin'))
    win.dispatchEvent(new Event('focusin'))
    vi.runAllTimers()
    expect(onHint).not.toHaveBeenCalled()
    win.dispatchEvent(new Event('focus'))
    vi.runAllTimers()
    expect(onHint).toHaveBeenCalledTimes(1)
    dispose()
  })

  it('rechecks visibility when the scheduled task runs', () => {
    const onHint = vi.fn()
    const dispose = installSavedLifecycle(onHint)
    win.dispatchEvent(new Event('focus'))
    visibility = 'hidden'
    vi.runAllTimers()
    expect(onHint).not.toHaveBeenCalled()
    visibility = 'visible'
    doc.dispatchEvent(new Event('visibilitychange'))
    vi.runAllTimers()
    expect(onHint).toHaveBeenCalledTimes(1)
    dispose()
  })

  it('registers an ordinary bubbling window focus listener and removes every listener and the pending task on disposal', () => {
    const addWindow = vi.spyOn(win, 'addEventListener')
    const removeWindow = vi.spyOn(win, 'removeEventListener')
    const addDocument = vi.spyOn(doc, 'addEventListener')
    const removeDocument = vi.spyOn(doc, 'removeEventListener')
    const onHint = vi.fn()
    const dispose = installSavedLifecycle(onHint)
    const focusRegistrations = addWindow.mock.calls.filter(([type]) => type === 'focus')
    expect(focusRegistrations).toHaveLength(1)
    const options = focusRegistrations[0][2]
    expect(options === undefined || options === false || (typeof options === 'object' && options !== null && !(options as AddEventListenerOptions).capture)).toBe(true)
    expect(addWindow.mock.calls.map(([type]) => type)).not.toContain('focusin')
    expect(addDocument.mock.calls.map(([type]) => type)).not.toContain('focusin')
    win.dispatchEvent(new Event('focus'))
    dispose()
    vi.runAllTimers()
    expect(onHint).not.toHaveBeenCalled()
    expect(removeWindow.mock.calls.map(([type]) => type).sort()).toEqual(addWindow.mock.calls.map(([type]) => type).sort())
    expect(removeDocument.mock.calls.map(([type]) => type).sort()).toEqual(addDocument.mock.calls.map(([type]) => type).sort())
    // The exact listener references that were added are the ones removed.
    for (const [type, listener] of addWindow.mock.calls) expect(removeWindow.mock.calls.some(call => call[0] === type && call[1] === listener)).toBe(true)
    for (const [type, listener] of addDocument.mock.calls) expect(removeDocument.mock.calls.some(call => call[0] === type && call[1] === listener)).toBe(true)
    win.dispatchEvent(new Event('focus'))
    doc.dispatchEvent(new Event('visibilitychange'))
    win.dispatchEvent(new FakePageTransitionEvent('pageshow', { persisted: true }))
    vi.runAllTimers()
    expect(onHint).not.toHaveBeenCalled()
  })
})

const SAVED_AT = '2026-09-19T10:00:00.000Z'
function item(id = 'one', note = 'Original note'): SavedJob {
  const job = publicProtocolJob(id, { id })
  return { job, company: PUBLIC_PROTOCOL_COMPANIES[0], savedAt: SAVED_AT, status: 'saved', note }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
/** A typed result must settle on its own; waiting on the blocked work would be the failure the contract forbids. */
function promptly<T>(promise: Promise<T>, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${label} did not settle promptly`)), 1000)),
  ])
}

describe('explicit comparison completion and lifetime ownership', () => {
  let factory: IDBFactory
  let stores: SavedStore[]
  let controllers: SavedController[]
  beforeEach(() => { factory = new IDBFactory(); stores = []; controllers = [] })
  afterEach(() => { controllers.forEach(controller => controller.stop()); stores.forEach(store => store.close()) })
  async function open() {
    const store = await openSavedStore({ factory, name: 'lifecycle-test', legacy: { getItem: () => null, removeItem: () => undefined } })
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
  /**
   * Each controller lifetime receives its own freshly opened connection whose real close is kept, so stop() really
   * closes what it owns and a later start() cannot reuse a closed connection. The test keeps a separate writer/observer
   * connection. Gates and the read counter are shared across lifetimes; a gated read captures its snapshot first.
   */
  function gatedConnect(count: number, skip = 0, decorate: (connection: SavedStore) => SavedStore = connection => connection) {
    const gates = Array.from({ length: count }, () => deferred<void>())
    const waiting = [...gates]
    let reads = 0
    const connections: SavedStore[] = []
    const connect = async (): Promise<SavedStore> => {
      const connection = decorate(await open())
      const wrapper: SavedStore = {
        ...connection,
        read: async () => {
          const index = reads++
          const snapshot = await connection.read()
          if (index >= skip) {
            const gate = waiting.shift()
            if (gate) await gate.promise
          }
          return snapshot
        },
      }
      connections.push(wrapper)
      return wrapper
    }
    return { connect, gates, reads: () => reads, connections }
  }

  it('resolves an explicit comparison only from a read that covers it, never from an earlier read already in flight', async () => {
    const store = await open()
    await store.apply({ kind: 'add', record: item('one', 'OLD') })
    const { wrapper, gates, reads } = gatedReads(store, 2, 1)
    const controller = create(async () => wrapper)
    await controller.start()
    await ready(controller)
    controller.requestRefresh()
    await vi.waitFor(() => expect(reads()).toBe(2))
    await store.apply({ kind: 'update', id: 'one', patch: { note: 'NEW' } })
    const settled = vi.fn()
    const comparing = controller.refresh().then(result => { settled(result); return result })
    gates[0].resolve()
    await vi.waitFor(() => expect(reads()).toBe(3))
    expect(settled).not.toHaveBeenCalled()
    expect(controller.getSnapshot().records[0].note).toBe('OLD')
    gates[1].resolve()
    const result = await comparing
    expect(result.status).toBe('refreshed')
    if (result.status === 'refreshed') {
      expect(result.snapshot.records[0].note).toBe('NEW')
      expect(result.snapshot).toBe(controller.getSnapshot())
    }
    expect(reads()).toBe(3)
  })

  it('settles a covered comparison as soon as its read is accepted even while unrelated hints keep arriving', async () => {
    const store = await open()
    await store.apply({ kind: 'add', record: item('one', 'OLD') })
    const { wrapper, gates, reads } = gatedReads(store, 2, 1)
    const controller = create(async () => wrapper)
    await controller.start()
    await ready(controller)
    const comparing = controller.refresh()
    await vi.waitFor(() => expect(reads()).toBe(2))
    controller.requestRefresh()
    gates[0].resolve()
    expect(await promptly(comparing, 'a covered comparison')).toMatchObject({ status: 'refreshed' })
    await vi.waitFor(() => expect(reads()).toBe(3))
    gates[1].resolve()
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(controller.getSnapshot()).toMatchObject({ phase: 'ready', pending: 0, error: null })
  })

  it('returns deferred promptly while a write is in flight and reads once after the write commits', async () => {
    const store = await open()
    await store.apply({ kind: 'add', record: item() })
    const gate = deferred<void>()
    let hold = true
    const applyGated: SavedStore = {
      ...store,
      apply: async (operation, draft) => { if (hold) await gate.promise; return store.apply(operation, draft) },
    }
    const { wrapper, reads } = gatedReads(applyGated, 0)
    const controller = create(async () => wrapper)
    await controller.start()
    await ready(controller)
    expect(controller.change({ kind: 'update', id: 'one', patch: { note: 'Local draft' } })).toEqual({ accepted: true })
    expect(await promptly(controller.refresh(), 'a comparison during a write')).toEqual({ status: 'deferred' })
    expect(controller.getSnapshot().records[0].note).toBe('Local draft')
    await store.apply({ kind: 'update', id: 'one', patch: { status: 'applied' } })
    const readsBefore = reads()
    hold = false
    gate.resolve()
    await ready(controller)
    await vi.waitFor(() => expect(controller.getSnapshot().records[0]).toMatchObject({ note: 'Local draft', status: 'applied' }))
    expect(reads()).toBe(readsBefore + 1)
    expect((await store.read()).records[0]).toMatchObject({ note: 'Local draft', status: 'applied', savedAt: SAVED_AT })
  })

  it('returns deferred promptly during an exclusive import and reads after the import commits', async () => {
    const store = await open()
    await store.apply({ kind: 'add', record: item() })
    const gate = deferred<void>()
    const { wrapper } = gatedReads({
      ...store,
      importRecords: async plan => { await gate.promise; await store.importRecords(plan) },
    }, 0)
    const controller = create(async () => wrapper)
    await controller.start()
    await ready(controller)
    const importing = controller.importRecords({ items: [{ record: item('imported'), expected: null }] })
    expect(controller.getSnapshot()).toMatchObject({ busy: true, phase: 'saving' })
    expect(await promptly(controller.refresh(), 'a comparison during an import')).toEqual({ status: 'deferred' })
    await store.apply({ kind: 'add', record: item('other-tab') })
    gate.resolve()
    expect(await importing).toEqual({ ok: true })
    await ready(controller)
    await vi.waitFor(() => expect(controller.getSnapshot().records.map(record => record.job.id)).toEqual(['imported', 'other-tab', 'one']))
    expect(controller.getSnapshot().busy).toBe(false)
  })

  it('returns deferred promptly during startup and services the request after the initial read', async () => {
    const store = await open()
    await store.apply({ kind: 'add', record: item('one', 'OLD') })
    const { wrapper, gates, reads } = gatedReads(store, 1)
    const controller = create(async () => wrapper)
    const starting = controller.start()
    await vi.waitFor(() => expect(reads()).toBe(1))
    expect(await promptly(controller.refresh(), 'a comparison during startup')).toEqual({ status: 'deferred' })
    await store.apply({ kind: 'update', id: 'one', patch: { note: 'NEW' } })
    gates[0].resolve()
    await starting
    await vi.waitFor(() => expect(controller.getSnapshot().records[0].note).toBe('NEW'))
    expect(controller.getSnapshot()).toMatchObject({ phase: 'ready', pending: 0 })
    expect(reads()).toBe(2)
  })

  it('reports a failed read with its storage error code, keeps the last accepted records and keeps reporting the existing error until explicit retry', async () => {
    const store = await open()
    await store.apply({ kind: 'add', record: item() })
    let fail = false
    const applySpy = vi.fn<SavedStore['apply']>()
    const controller = create(async () => {
      const connection = await open()
      applySpy.mockImplementation((operation, draft) => connection.apply(operation, draft))
      return {
        ...connection,
        apply: applySpy,
        read: () => fail ? Promise.reject(new SavedStorageError('unavailable')) : connection.read(),
      }
    })
    await controller.start()
    await ready(controller)
    fail = true
    expect(await controller.refresh()).toEqual({ status: 'failed', error: 'unavailable' })
    expect(controller.getSnapshot()).toMatchObject({ phase: 'error', ready: true, pending: 0, error: 'unavailable' })
    expect(controller.getSnapshot().records).toEqual([item()])
    expect(await controller.refresh()).toEqual({ status: 'failed', error: 'unavailable' })
    controller.requestRefresh()
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(applySpy).not.toHaveBeenCalled()
    expect(controller.getSnapshot()).toMatchObject({ phase: 'error', error: 'unavailable' })
    expect(controller.getSnapshot().records).toEqual([item()])
    fail = false
    await controller.retry()
    await ready(controller)
    expect(controller.getSnapshot().records).toEqual([item()])
    expect(applySpy).not.toHaveBeenCalled()
  })

  it('settles a pending comparison as stopped when the lifetime ends and never publishes the late read', async () => {
    const writer = await open()
    await writer.apply({ kind: 'add', record: item() })
    const { connect, gates, reads, connections } = gatedConnect(1, 1)
    const controller = create(connect)
    await controller.start()
    await ready(controller)
    const comparing = controller.refresh()
    await vi.waitFor(() => expect(reads()).toBe(2))
    const listener = vi.fn()
    controller.subscribe(listener)
    controller.stop()
    expect(await promptly(comparing, 'a comparison across stop')).toEqual({ status: 'stopped' })
    expect(await controller.refresh()).toEqual({ status: 'stopped' })
    // The owned connection is really closed by stop: it can no longer carry a transaction, while the independent writer proceeds.
    expect(connections).toHaveLength(1)
    await expect(connections[0].apply({ kind: 'update', id: 'one', patch: { note: 'Must not reach the closed connection' } })).rejects.toBeInstanceOf(SavedStorageError)
    await writer.apply({ kind: 'update', id: 'one', patch: { note: 'Written after stop' } })
    gates[0].resolve()
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(listener).not.toHaveBeenCalled()
    await controller.start()
    await ready(controller)
    expect(connections).toHaveLength(2)
    expect(controller.getSnapshot().records[0].note).toBe('Written after stop')
    expect(reads()).toBe(3)
    expect((await writer.read()).records[0].note).toBe('Written after stop')
  })

  it('defers a comparison when a draft is typed during its read, accepts the base beneath the draft and lets the writer run', async () => {
    const store = await open()
    await store.apply({ kind: 'add', record: item() })
    const { wrapper, gates, reads } = gatedReads(store, 1, 1)
    const controller = create(async () => wrapper)
    await controller.start()
    await ready(controller)
    await store.apply({ kind: 'update', id: 'one', patch: { status: 'applied' } })
    const comparing = controller.refresh()
    await vi.waitFor(() => expect(reads()).toBe(2))
    expect(controller.change({ kind: 'update', id: 'one', patch: { note: 'Typed during refresh' } })).toEqual({ accepted: true })
    expect(await promptly(comparing, 'a comparison interrupted by typing')).toEqual({ status: 'deferred' })
    expect(controller.getSnapshot().records[0].note).toBe('Typed during refresh')
    gates[0].resolve()
    await ready(controller)
    await vi.waitFor(async () => expect((await store.read()).records[0]).toMatchObject({ note: 'Typed during refresh', status: 'applied' }))
    expect(controller.getSnapshot().records[0]).toMatchObject({ note: 'Typed during refresh', status: 'applied', savedAt: SAVED_AT })
    expect(controller.getSnapshot().pending).toBe(0)
  })

  it('reports the existing storage error for an explicit comparison even while the failed draft is still pending, and a stopped lifetime takes precedence over both', async () => {
    const writer = await open()
    await writer.apply({ kind: 'add', record: item() })
    let failing = true
    let attempts = 0
    const { connect, reads, connections } = gatedConnect(0, 0, connection => ({
      ...connection,
      apply: (operation, draft) => {
        attempts++
        return failing ? Promise.reject(new SavedStorageError('quota')) : connection.apply(operation, draft)
      },
    }))
    const controller = create(connect)
    await controller.start()
    await ready(controller)
    expect(controller.change({ kind: 'update', id: 'one', patch: { note: 'Latest unsaved note' } })).toEqual({ accepted: true })
    await vi.waitFor(() => expect(controller.getSnapshot().error).toBe('quota'))
    expect(controller.getSnapshot()).toMatchObject({ phase: 'error', pending: 1, error: 'quota' })
    const attemptsBefore = attempts
    const readsBefore = reads()
    // Existing error wins over the pending draft: the comparison names the actual remedy and nothing retries.
    expect(await promptly(controller.refresh(), 'a comparison over a failed pending draft')).toEqual({ status: 'failed', error: 'quota' })
    controller.requestRefresh()
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(attempts).toBe(attemptsBefore)
    expect(reads()).toBe(readsBefore)
    expect(controller.getSnapshot()).toMatchObject({ phase: 'error', pending: 1, error: 'quota' })
    expect(controller.getSnapshot().records[0].note).toBe('Latest unsaved note')
    expect((await writer.read()).records[0].note).toBe('Original note')
    // A stopped lifetime answers stopped even though the error and the draft still exist; its connection is really closed.
    controller.stop()
    expect(await controller.refresh()).toEqual({ status: 'stopped' })
    expect(controller.getSnapshot().records[0].note).toBe('Latest unsaved note')
    expect(connections).toHaveLength(1)
    await expect(connections[0].read()).rejects.toBeInstanceOf(SavedStorageError)
    failing = false
    await controller.retry()
    await ready(controller)
    expect(connections).toHaveLength(2)
    expect((await writer.read()).records[0]).toMatchObject({ note: 'Latest unsaved note', savedAt: SAVED_AT })
    expect(controller.getSnapshot()).toMatchObject({ phase: 'ready', pending: 0, error: null })
    expect(controller.getSnapshot().records[0]).toMatchObject({ note: 'Latest unsaved note', status: 'saved' })
  })
})
