/**
 * Stage80 D2: tracked restore receipts of the saved controller. Expected
 * outcomes are literal statuses and literal record fields; the committed
 * database is read through the real store on fake IndexedDB. Admission is never
 * durability: only the queued operation's transaction can settle a receipt.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'
import { PUBLIC_PROTOCOL_COMPANIES, publicProtocolJob } from '../fixtures/public-protocol'
import type { SavedJob } from '../../shared/types'
import { SavedController } from '../../src/lib/saved-controller'
import type { SavedAddOutcome } from '../../src/lib/saved-controller'
import { openSavedStore, SavedStorageError } from '../../src/lib/saved-store'
import type { SavedStore } from '../../src/lib/saved-store'

const DATABASE = 'undo80-receipts'
const ORIGINAL_NOTE = 'PRIVATE-UNDO80 original note\n둘째 줄: 포트폴리오 준비 🌱'
const ORIGINAL_SAVED_AT = '2026-09-28T07:30:00.000Z'
const ORIGINAL_ID = 'greenhouse-fixture-aster-transit-ember-80'

function original(overrides: Partial<Pick<SavedJob, 'note' | 'status' | 'savedAt'>> = {}): SavedJob {
  return {
    job: publicProtocolJob('ember-80', { title: 'Ember 80 · Backend Engineer' }),
    company: structuredClone(PUBLIC_PROTOCOL_COMPANIES[0]),
    savedAt: ORIGINAL_SAVED_AT, status: 'applied', note: ORIGINAL_NOTE, ...overrides,
  }
}
const ORIGINAL_LITERAL = {
  note: ORIGINAL_NOTE, status: 'applied', savedAt: ORIGINAL_SAVED_AT,
  job: { id: ORIGINAL_ID, title: 'Ember 80 · Backend Engineer', companyId: 'fixture-aster-transit' },
  company: { id: 'fixture-aster-transit', name: 'Aster Transit' },
}
const NEWER = original({ note: 'NEWER note from another tab', status: 'saved', savedAt: '2026-10-01T12:00:00.000Z' })
/** Schema-valid record saved under an earlier board registration: company id ≠ job.companyId (Astra A80-P01-1). */
const LEGACY_MISMATCH: SavedJob = {
  ...original({ note: 'PRIVATE-UNDO80 legacy relation note 🌱' }),
  company: { ...structuredClone(PUBLIC_PROTOCOL_COMPANIES[0]), id: 'fixture-aster-transit-eu', name: 'Aster Transit (EU board)', board: 'fixture-aster-transit-eu' },
}
const LEGACY_MISMATCH_LITERAL = {
  note: 'PRIVATE-UNDO80 legacy relation note 🌱', status: 'applied', savedAt: ORIGINAL_SAVED_AT,
  job: { id: ORIGINAL_ID, title: 'Ember 80 · Backend Engineer', companyId: 'fixture-aster-transit' },
  company: { id: 'fixture-aster-transit-eu', name: 'Aster Transit (EU board)', board: 'fixture-aster-transit-eu' },
}

function deferred<T = void>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
/** A receipt still pending after a macrotask is reported as such instead of blocking the test. */
async function settlement(completion: Promise<SavedAddOutcome>) {
  return Promise.race([
    completion.then(outcome => ({ settled: true as const, outcome })),
    new Promise<{ settled: false }>(resolve => setTimeout(() => resolve({ settled: false }), 30)),
  ])
}
function reorderKeys<T>(value: T): T {
  if (Array.isArray(value)) return value.map(reorderKeys) as T
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).reverse().map(([key, item]) => [key, reorderKeys(item)])) as T
  }
  return value
}

let factory: IDBFactory
let stores: SavedStore[]
let controllers: SavedController[]
beforeEach(() => { factory = new IDBFactory(); stores = []; controllers = [] })
afterEach(() => { controllers.forEach(controller => controller.stop()); stores.forEach(store => store.close()) })

async function open(legacy: string | null = null) {
  const store = await openSavedStore({ factory, name: DATABASE, legacy: { getItem: () => legacy, removeItem: () => undefined } })
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
async function committed() {
  const store = await open()
  const records = (await store.read()).records
  return records
}
async function writeRawEntry(entry: unknown) {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open(DATABASE)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction('records', 'readwrite')
    tx.objectStore('records').put(entry)
    tx.oncomplete = () => resolve()
    tx.onabort = () => reject(tx.error)
  })
  db.close()
}
function accepted(result: ReturnType<SavedController['addTracked']>): Promise<SavedAddOutcome> {
  expect(result.accepted).toBe(true)
  if (!result.accepted) throw new Error('rejected')
  return result.completion
}

describe('tracked restore receipts', () => {
  it('resolves noop at admission when the id is already present and queues nothing', async () => {
    const store = await open()
    await store.apply({ kind: 'add', record: original() })
    const controller = create()
    await controller.start()
    const completion = accepted(controller.addTracked(original({ note: 'would overwrite' })))
    expect(controller.getSnapshot().pending).toBe(0)
    expect(await completion).toEqual({ status: 'noop' })
    expect((await committed())[0]).toMatchObject(ORIGINAL_LITERAL)
  })

  it('settles with the committed original once the queue and snapshot are published, writing exactly one record', async () => {
    await open()
    const controller = create()
    await controller.start()
    const result = controller.addTracked(original())
    const outcome = await accepted(result)
    expect(outcome.status).toBe('settled')
    if (outcome.status !== 'settled') throw new Error('unexpected')
    expect(outcome.record).toMatchObject(ORIGINAL_LITERAL)
    expect(controller.getSnapshot()).toMatchObject({ phase: 'ready', pending: 0 })
    expect(controller.getSnapshot().records.map(record => record.job.id)).toEqual([ORIGINAL_ID])
    const records = await committed()
    expect(records).toHaveLength(1)
    expect(records[0]).toEqual(outcome.record)
  })

  it('settles a schema-valid legacy record whose company id differs from the job’s company, with exact metadata (A80-P01-1)', async () => {
    expect(LEGACY_MISMATCH.company.id).not.toBe(LEGACY_MISMATCH.job.companyId)
    await open()
    const controller = create()
    await controller.start()
    const outcome = await accepted(controller.addTracked(LEGACY_MISMATCH))
    expect(outcome.status).toBe('settled')
    if (outcome.status !== 'settled') throw new Error('unexpected')
    expect(outcome.record).toMatchObject(LEGACY_MISMATCH_LITERAL)
    expect(controller.getSnapshot()).toMatchObject({ phase: 'ready', pending: 0, error: null })
    const records = await committed()
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject(LEGACY_MISMATCH_LITERAL)
    expect(records[0]).toEqual(outcome.record)
  })

  it('keeps the stricter company relation for file imports (store and controller) while tracked restores accept it', async () => {
    const store = await open()
    await expect(store.importRecords({ items: [{ record: LEGACY_MISMATCH, expected: null }] })).rejects.toMatchObject({ code: 'write' })
    expect(await committed()).toEqual([])
    const controller = create()
    await controller.start()
    expect(await controller.importRecords({ items: [{ record: LEGACY_MISMATCH, expected: null }] })).toEqual({ ok: false, error: 'write' })
    expect(await committed()).toEqual([])
    const outcome = await accepted(controller.addTracked(LEGACY_MISMATCH))
    expect(outcome.status).toBe('settled')
    expect(await committed()).toHaveLength(1)
  })

  it('treats a committed record with another object key order as the same original', async () => {
    const store = await open()
    const controller = create(async () => ({
      ...store,
      apply: async (operation, draft) => {
        const entry = await store.apply(operation, draft)
        return entry ? { ...entry, record: reorderKeys(entry.record) } : entry
      },
    }))
    await controller.start()
    const outcome = await accepted(controller.addTracked(original()))
    expect(outcome.status).toBe('settled')
  })

  it('reports a conflict when the transaction returns another writer’s different same-ID record and never overwrites it', async () => {
    const store = await open()
    const other = await open()
    const gate = deferred()
    const controller = create(async () => ({
      ...store,
      apply: async (operation, draft) => { await gate.promise; return store.apply(operation, draft) },
    }))
    await controller.start()
    const completion = accepted(controller.addTracked(original()))
    await other.apply({ kind: 'add', record: NEWER })
    gate.resolve()
    const outcome = await completion
    expect(outcome.status).toBe('conflict')
    if (outcome.status !== 'conflict') throw new Error('unexpected')
    expect(outcome.record).toMatchObject({ note: 'NEWER note from another tab', status: 'saved', savedAt: '2026-10-01T12:00:00.000Z', job: { id: ORIGINAL_ID } })
    expect((await committed()).map(record => record.note)).toEqual(['NEWER note from another tab'])
    expect(controller.getSnapshot().records[0].note).toBe('NEWER note from another tab')
  })

  type Entry = { id: string; order: number; record: SavedJob }
  const corruptions: [string, (entry: Entry) => Entry | null][] = [
    ['a null result', (_entry: Entry) => null],
    ['a result for another id', (entry: Entry) => ({ ...entry, id: 'greenhouse-fixture-aster-transit-someone-else' })],
    ['a result whose record is not a saved record', (entry: Entry) => ({ ...entry, record: { broken: true } as unknown as SavedJob })],
    ['a result with a negative order', (entry: Entry) => ({ ...entry, order: -1 })],
    ['a result with a fractional order', (entry: Entry) => ({ ...entry, order: 1.5 })],
    ['a result whose record carries another job id', (entry: Entry) => ({ ...entry, record: { ...entry.record, job: { ...entry.record.job, id: 'greenhouse-fixture-aster-transit-someone-else' } } })],
  ]
  it.each(corruptions)('keeps the receipt pending and the add queued on %s, then settles exactly once after the explicit retry', async (_label, corrupt) => {
    // Every connect call opens a fresh connection to the same database: retry() restarts the
    // controller, which closes the previous connection, so a shared facade would be closed.
    let corrupting = true
    const controller = create(async () => {
      const connection = await open()
      return {
        ...connection,
        apply: async (operation, draft) => {
          const entry = await connection.apply(operation, draft)
          return corrupting && operation.kind === 'add' && entry ? corrupt(entry) : entry
        },
      }
    })
    await controller.start()
    const completion = accepted(controller.addTracked(original()))
    let resolutions = 0
    void completion.then(() => { resolutions++ })
    await vi.waitFor(() => expect(controller.getSnapshot().error).toBe('write'))
    expect(controller.getSnapshot()).toMatchObject({ phase: 'error', pending: 1 })
    expect(await settlement(completion)).toEqual({ settled: false })
    expect(resolutions).toBe(0)
    corrupting = false
    await controller.retry()
    await ready(controller)
    const outcome = await completion
    expect(outcome.status).toBe('settled')
    if (outcome.status !== 'settled') throw new Error('unexpected')
    expect(outcome.record).toMatchObject(ORIGINAL_LITERAL)
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(resolutions).toBe(1)
    expect(controller.getSnapshot()).toMatchObject({ phase: 'ready', pending: 0, error: null })
    const records = await committed()
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject(ORIGINAL_LITERAL)
    expect(records[0]).toEqual(outcome.record)
  })

  it('leaves the receipt pending through a storage failure and settles exactly once after the retry without a duplicate record', async () => {
    const store = await open()
    let failing = true
    const controller = create(async () => {
      const connection = await open()
      return { ...connection, apply: (operation, draft) => failing && operation.kind === 'add'
        ? Promise.reject(new SavedStorageError('quota')) : connection.apply(operation, draft) }
    })
    await controller.start()
    const completion = accepted(controller.addTracked(original()))
    let resolutions = 0
    void completion.then(() => { resolutions++ })
    await vi.waitFor(() => expect(controller.getSnapshot().error).toBe('quota'))
    expect(await settlement(completion)).toEqual({ settled: false })
    expect(controller.getSnapshot().records.map(record => record.job.id)).toEqual([ORIGINAL_ID])
    expect(await store.read()).toMatchObject({ records: [] })
    failing = false
    await controller.retry()
    await ready(controller)
    expect((await completion).status).toBe('settled')
    await Promise.resolve()
    expect(resolutions).toBe(1)
    expect(await committed()).toHaveLength(1)
  })

  it('resolves superseded when a later accepted removal of the same id arrives while the add is still queued', async () => {
    const store = await open()
    await store.apply({ kind: 'add', record: { ...original(), job: publicProtocolJob('other', { title: 'Other' }) } })
    const gate = deferred()
    const controller = create(async () => ({
      ...store,
      apply: async (operation, draft) => { if (operation.kind === 'update') await gate.promise; return store.apply(operation, draft) },
    }))
    await controller.start()
    controller.change({ kind: 'update', id: 'greenhouse-fixture-aster-transit-other', patch: { note: 'hold the queue' } })
    const completion = accepted(controller.addTracked(original()))
    expect(controller.getSnapshot().records.some(record => record.job.id === ORIGINAL_ID)).toBe(true)
    expect(controller.change({ kind: 'remove', id: ORIGINAL_ID })).toEqual({ accepted: true })
    expect(await completion).toEqual({ status: 'superseded' })
    gate.resolve()
    await ready(controller)
    expect((await committed()).map(record => record.job.id)).toEqual(['greenhouse-fixture-aster-transit-other'])
  })

  it('resolves superseded for an in-flight add when the same id is removed before its receipt, then commits both in order', async () => {
    const store = await open()
    const gate = deferred()
    const controller = create(async () => ({
      ...store,
      apply: async (operation, draft) => { if (operation.kind === 'add') await gate.promise; return store.apply(operation, draft) },
    }))
    await controller.start()
    const completion = accepted(controller.addTracked(original()))
    await Promise.resolve()
    expect(controller.change({ kind: 'remove', id: ORIGINAL_ID })).toEqual({ accepted: true })
    expect(await completion).toEqual({ status: 'superseded' })
    gate.resolve()
    await ready(controller)
    expect(await committed()).toEqual([])
    expect(controller.getSnapshot().records).toEqual([])
  })

  it('resolves superseded for a failed add that a later removal prunes on retry', async () => {
    await open()
    let failing = true
    const controller = create(async () => {
      const connection = await open()
      return { ...connection, apply: (operation, draft) => failing && operation.kind === 'add'
        ? Promise.reject(new SavedStorageError('quota')) : connection.apply(operation, draft) }
    })
    await controller.start()
    const completion = accepted(controller.addTracked(original()))
    await vi.waitFor(() => expect(controller.getSnapshot().error).toBe('quota'))
    expect(controller.change({ kind: 'remove', id: ORIGINAL_ID })).toEqual({ accepted: true })
    failing = false
    await controller.retry()
    await ready(controller)
    expect(await completion).toEqual({ status: 'superseded' })
    expect(await committed()).toEqual([])
    expect(controller.getSnapshot().pending).toBe(0)
  })

  it('answers a repeated request for the same original with noop while the first is still queued, writing one record', async () => {
    const store = await open()
    const gate = deferred()
    const controller = create(async () => ({
      ...store,
      apply: async (operation, draft) => { if (operation.kind === 'add') await gate.promise; return store.apply(operation, draft) },
    }))
    await controller.start()
    const first = accepted(controller.addTracked(original()))
    const second = accepted(controller.addTracked(original()))
    expect(await second).toEqual({ status: 'noop' })
    gate.resolve()
    expect((await first).status).toBe('settled')
    expect(await committed()).toHaveLength(1)
  })

  it('ignores a late acknowledgement from a stopped connection and settles the replayed add exactly once', async () => {
    const committedOnce = deferred()
    const acknowledge = deferred()
    let first = true
    const controller = create(async () => {
      const store = await open()
      if (!first) return store
      first = false
      return { ...store, apply: async (operation, draft) => {
        const result = await store.apply(operation, draft)
        committedOnce.resolve()
        await acknowledge.promise
        return result
      } }
    })
    await controller.start()
    const completion = accepted(controller.addTracked(original()))
    let resolutions = 0
    void completion.then(() => { resolutions++ })
    await committedOnce.promise
    controller.stop()
    await controller.start()
    await ready(controller)
    const outcome = await completion
    expect(outcome.status).toBe('settled')
    acknowledge.resolve()
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(resolutions).toBe(1)
    expect(controller.getSnapshot()).toMatchObject({ phase: 'ready', pending: 0 })
    expect(await committed()).toHaveLength(1)
    expect((await committed())[0]).toMatchObject(ORIGINAL_LITERAL)
  })

  it('rejects admission without a receipt: loading, busy, unreadable existing record and capacity', async () => {
    const loading = create()
    expect(loading.addTracked(original())).toEqual({ accepted: false, reason: 'loading' })

    const store = await open()
    const gate = deferred()
    const importing = create(async () => ({ ...store, importRecords: async plan => { await gate.promise; await store.importRecords(plan) } }))
    await importing.start()
    const bulk = importing.importRecords({ items: [{ record: { ...original(), job: publicProtocolJob('imported', { title: 'Imported' }) }, expected: null }] })
    expect(importing.addTracked(original())).toEqual({ accepted: false, reason: 'busy' })
    gate.resolve()
    expect(await bulk).toEqual({ ok: true })

    await writeRawEntry({ id: ORIGINAL_ID, order: 3, record: { damaged: 'unreadable wrapper' } })
    const unreadable = create()
    await unreadable.start()
    expect(unreadable.getSnapshot().unreadableIds).toEqual([ORIGINAL_ID])
    expect(unreadable.addTracked(original())).toEqual({ accepted: false, reason: 'unreadable' })

    const seeded = JSON.stringify(Array.from({ length: 500 }, (_, index) => ({
      ...original(), job: publicProtocolJob(`fill-${index}`, { title: `Fill ${index}` }),
    })))
    const fullFactory = new IDBFactory()
    const full = await openSavedStore({ factory: fullFactory, name: 'undo80-full', legacy: { getItem: () => seeded, removeItem: () => undefined } })
    stores.push(full)
    const capacity = create(async () => {
      const connection = await openSavedStore({ factory: fullFactory, name: 'undo80-full', legacy: { getItem: () => null, removeItem: () => undefined } })
      stores.push(connection)
      return connection
    })
    await capacity.start()
    expect(capacity.getSnapshot().records).toHaveLength(500)
    expect(capacity.addTracked(original())).toEqual({ accepted: false, reason: 'limit' })
  })
})
