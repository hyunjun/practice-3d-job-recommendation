import { decodeSavedJobs, MAX_SAVED_JOBS, SavedJobSchema } from '../../shared/saved-jobs'
import type { SavedOperation } from '../../shared/saved-jobs'
import type { SavedJob } from '../../shared/types'
import { sameSavedRecord } from '../../shared/saved-backup'
import type { SavedImportPlan } from '../../shared/saved-backup'

export const SAVED_DATABASE = 'orbit-saved-opportunities'
export const SAVED_DATABASE_VERSION = 1
export const SAVED_RECORD_STORE = 'records'
const META_STORE = 'meta'
const LEGACY_KEY = 'orbit.v1.saved'

interface Entry { id: string; order: number; record: SavedJob }
interface State {
  key: 'state'
  nextOrder: number
  legacyDigest: string | null
  recovery?: { raw: string; omitted: number | null; reason: 'format' | 'records' }
}
export interface SavedRecovery {
  kind: 'legacy' | 'additional-legacy' | 'records'
  count: number | null
  original: unknown
}
export interface SavedStoreSnapshot {
  records: SavedJob[]
  recovery: SavedRecovery[]
  unreadableIds: string[]
  occupied: number
}
export type SavedStorageErrorCode = 'unavailable' | 'blocked' | 'legacy-read' | 'quota' | 'limit' | 'unreadable' | 'missing' | 'write' | 'changed' | 'busy'
export class SavedStorageError extends Error {
  constructor(readonly code: SavedStorageErrorCode, options?: ErrorOptions) { super(code, options) }
}
export interface SavedStore {
  read(): Promise<SavedStoreSnapshot>
  apply(operation: SavedOperation, recreate?: SavedJob): Promise<Entry | null>
  importRecords(plan: SavedImportPlan): Promise<void>
  discardRecovery(target: SavedRecovery): Promise<void>
  close(): void
}
interface Options {
  factory?: IDBFactory
  name?: string
  legacy?: Pick<Storage, 'getItem' | 'removeItem'>
  timeoutMs?: number
}

function request<T>(value: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    value.onsuccess = () => resolve(value.result)
    value.onerror = () => reject(value.error ?? new SavedStorageError('write'))
  })
}

async function transaction<T>(db: IDBDatabase, mode: IDBTransactionMode, work: (records: IDBObjectStore, meta: IDBObjectStore) => Promise<T>): Promise<T> {
  const tx = db.transaction([SAVED_RECORD_STORE, META_STORE], mode, mode === 'readwrite' ? { durability: 'strict' } : undefined)
  const complete = new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onabort = () => reject(tx.error ?? new DOMException('Transaction aborted', 'AbortError'))
  })
  // Observe failure immediately, including an abort while a request is pending.
  void complete.catch(() => undefined)
  let result: T
  try { result = await work(tx.objectStore(SAVED_RECORD_STORE), tx.objectStore(META_STORE)) }
  catch (error) {
    try { tx.abort() } catch { /* The transaction may already have aborted. */ }
    await complete.catch(() => undefined)
    throw error
  }
  await complete
  return result
}

function decodeEntry(value: unknown): Entry | null {
  if (!value || typeof value !== 'object' || !('id' in value) || !('order' in value) || !('record' in value)
    || typeof value.id !== 'string' || typeof value.order !== 'number' || !Number.isSafeInteger(value.order) || value.order < 0) return null
  const parsed = SavedJobSchema.safeParse(value.record)
  return parsed.success && parsed.data.job.id === value.id ? { id: value.id, order: value.order, record: parsed.data } : null
}

async function digest(raw: string | null): Promise<string | null> {
  if (raw === null) return null
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw))
  return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

function storageError(error: unknown): SavedStorageError {
  if (error instanceof SavedStorageError) return error
  return new SavedStorageError(error instanceof DOMException && error.name === 'QuotaExceededError' ? 'quota' : 'write', { cause: error })
}

function connect(factory: IDBFactory, name: string, timeout: number): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let settled = false
    const opening = factory.open(name, SAVED_DATABASE_VERSION)
    const timer = setTimeout(() => finish(new SavedStorageError('blocked')), timeout)
    const finish = (error?: unknown, db?: IDBDatabase) => {
      if (settled) { db?.close(); return }
      settled = true
      clearTimeout(timer)
      if (error) reject(error)
      else resolve(db!)
    }
    opening.onupgradeneeded = () => {
      if (settled) { opening.transaction?.abort(); return }
      const db = opening.result
      if (!db.objectStoreNames.contains(SAVED_RECORD_STORE)) db.createObjectStore(SAVED_RECORD_STORE, { keyPath: 'id' })
      if (!db.objectStoreNames.contains(META_STORE)) db.createObjectStore(META_STORE, { keyPath: 'key' })
    }
    opening.onerror = () => finish(new SavedStorageError('unavailable', { cause: opening.error }))
    opening.onsuccess = () => {
      opening.result.onversionchange = () => opening.result.close()
      finish(undefined, opening.result)
    }
  })
}

/** One transaction copies legacy records before their unchanged localStorage key is removed. */
export async function openSavedStore(options: Options = {}): Promise<SavedStore> {
  let db: IDBDatabase
  try {
    const factory = options.factory ?? globalThis.indexedDB
    if (!factory) throw new SavedStorageError('unavailable')
    db = await connect(factory, options.name ?? SAVED_DATABASE, options.timeoutMs ?? 10000)
  } catch (error) { throw error instanceof SavedStorageError ? error : new SavedStorageError('unavailable', { cause: error }) }

  const readLegacy = (): string | null => (options.legacy ?? globalThis.localStorage).getItem(LEGACY_KEY)
  let legacy: string | null = null
  try {
    const state = await transaction(db, 'readonly', async (_records, meta) => request<State | undefined>(meta.get('state')))
    try { legacy = readLegacy() } catch (error) {
      if (!state) throw new SavedStorageError('legacy-read', { cause: error })
    }
    const fingerprint = await digest(legacy)
    const initialized = await transaction(db, 'readwrite', async (records, meta) => {
      const current = await request<State | undefined>(meta.get('state'))
      if (current) return current
      const existing = await request<unknown[]>(records.getAll())
      const valid = existing.flatMap(value => { const entry = decodeEntry(value); return entry ? [entry] : [] })
      const next: State = { key: 'state', nextOrder: Math.max(0, ...valid.map(entry => entry.order)) + 1, legacyDigest: fingerprint }
      if (legacy !== null) {
        const decoded = decodeSavedJobs(legacy)
        const occupied = new Set(valid.map(entry => entry.id))
        let count = existing.length
        let imported = 0
        // The first legacy item was the most recently saved one, even for equal timestamps.
        for (const record of [...decoded.records].reverse()) {
          if (occupied.has(record.job.id) || count >= MAX_SAVED_JOBS) continue
          const rawExisting = await request(records.get(record.job.id))
          if (rawExisting !== undefined) continue
          await request(records.add({ id: record.job.id, order: next.nextOrder++, record } satisfies Entry))
          occupied.add(record.job.id)
          count++
          imported++
        }
        if (decoded.reason || imported < decoded.records.length) next.recovery = {
          raw: legacy, omitted: decoded.omitted === null ? null : decoded.omitted + decoded.records.length - imported,
          reason: decoded.reason ?? 'records',
        }
      }
      await request(meta.put(next))
      return next
    })
    if (legacy !== null && initialized.legacyDigest === fingerprint) {
      // Never remove a concurrent edit made by an older tab.
      try { if (readLegacy() === legacy) (options.legacy ?? globalThis.localStorage).removeItem(LEGACY_KEY) } catch { /* The committed copy is still available. */ }
    }
  } catch (error) { db.close(); throw storageError(error) }

  return {
    async read() {
      const { raw, state } = await transaction(db, 'readonly', async (records, meta) => ({
        raw: await request<unknown[]>(records.getAll()),
        state: await request<State>(meta.get('state')),
      }))
      const valid: Entry[] = []
      const unreadable: unknown[] = []
      const unreadableIds: string[] = []
      for (const value of raw) {
        const entry = decodeEntry(value)
        if (entry) valid.push(entry)
        else {
          unreadable.push(value)
          if (value && typeof value === 'object' && 'id' in value && typeof value.id === 'string') unreadableIds.push(value.id)
        }
      }
      const recovery: SavedRecovery[] = []
      if (state.recovery) recovery.push({ kind: 'legacy', count: state.recovery.omitted, original: state.recovery.raw })
      if (unreadable.length) recovery.push({ kind: 'records', count: unreadable.length, original: unreadable })
      // An older tab can recreate a legacy key after migration. Preserve and disclose it.
      try {
        const additional = readLegacy()
        if (additional !== null) recovery.push({
          kind: 'additional-legacy', count: null, original: additional,
        })
      } catch { /* Reading the current database does not require legacy storage. */ }
      return {
        records: valid.sort((a, b) => b.order - a.order || a.id.localeCompare(b.id)).map(entry => entry.record),
        recovery, unreadableIds, occupied: raw.length,
      }
    },
    async apply(operation, recreate) {
      try {
        return await transaction(db, 'readwrite', async (records, meta) => {
          const id = operation.kind === 'add' ? operation.record.job.id : operation.id
          const raw = await request<unknown>(records.get(id))
          const existing = raw === undefined ? null : decodeEntry(raw)
          if (raw !== undefined && !existing) throw new SavedStorageError('unreadable')
          if (operation.kind === 'remove') { await request(records.delete(id)); return null }
          if (operation.kind === 'add' && existing) return existing
          if (operation.kind === 'update' && !existing && !recreate) throw new SavedStorageError('missing')
          const value = operation.kind === 'add' ? operation.record : {
            ...(existing?.record ?? recreate!), ...operation.patch,
          }
          const record = SavedJobSchema.parse(value)
          if (record.job.id !== id) throw new SavedStorageError('write')
          let order = existing?.order
          if (order === undefined) {
            if (await request(records.count()) >= MAX_SAVED_JOBS) throw new SavedStorageError('limit')
            const state = await request<State>(meta.get('state'))
            if (!Number.isSafeInteger(state.nextOrder) || state.nextOrder < 1) throw new SavedStorageError('write')
            order = state.nextOrder++
            await request(meta.put(state))
          }
          const entry: Entry = { id, order, record }
          await request(records.put(entry))
          return entry
        })
      } catch (error) { throw storageError(error) }
    },
    async importRecords(plan) {
      try {
        if (plan.items.length > MAX_SAVED_JOBS) throw new SavedStorageError('limit')
        const items = plan.items.map(item => ({ ...item, record: SavedJobSchema.parse(item.record) }))
        const ids = new Set(items.map(item => item.record.job.id))
        if (ids.size !== items.length || items.some(item => item.record.company.id !== item.record.job.companyId)) throw new SavedStorageError('write')
        await transaction(db, 'readwrite', async (records, meta) => {
          const existing = new Map<string, Entry | null>()
          let additions = 0
          for (const item of items) {
            const raw = await request<unknown>(records.get(item.record.job.id))
            const entry = raw === undefined ? null : decodeEntry(raw)
            if (raw !== undefined && !entry) throw new SavedStorageError('unreadable')
            if (entry ? !item.expected || !sameSavedRecord(entry.record, item.expected) : item.expected !== null) throw new SavedStorageError('changed')
            existing.set(item.record.job.id, entry)
            if (!entry) additions++
          }
          if (await request(records.count()) + additions > MAX_SAVED_JOBS) throw new SavedStorageError('limit')
          const state = await request<State>(meta.get('state'))
          if (!Number.isSafeInteger(state.nextOrder) || state.nextOrder < 1 || !Number.isSafeInteger(state.nextOrder + additions)) throw new SavedStorageError('write')
          // Preserve existing positions and the file's relative order for new records.
          for (const { record } of [...items].reverse()) {
            const order = existing.get(record.job.id)?.order ?? state.nextOrder++
            await request(records.put({ id: record.job.id, order, record } satisfies Entry))
          }
          if (additions) await request(meta.put(state))
        })
      } catch (error) { throw storageError(error) }
    },
    async discardRecovery(target) {
      try {
        if (target.kind === 'additional-legacy') {
          // Uncoordinated older tabs have no localStorage compare-and-delete API.
          // Check immediately before removal and advise closing those tabs in the UI.
          if (typeof target.original !== 'string' || readLegacy() !== target.original) throw new SavedStorageError('changed')
          const legacyStorage = options.legacy ?? globalThis.localStorage
          legacyStorage.removeItem(LEGACY_KEY)
          return
        }
        await transaction(db, 'readwrite', async (records, meta) => {
          if (target.kind === 'legacy') {
            const state = await request<State>(meta.get('state'))
            if (!state.recovery || state.recovery.raw !== target.original) throw new SavedStorageError('changed')
            delete state.recovery
            await request(meta.put(state))
          } else {
            if (!Array.isArray(target.original) || !target.original.length) throw new SavedStorageError('changed')
            const ids: IDBValidKey[] = []
            for (const expected of target.original) {
              if (!expected || typeof expected !== 'object' || !('id' in expected)) throw new SavedStorageError('unreadable')
              const raw = await request<unknown>(records.get(expected.id))
              if (raw === undefined || decodeEntry(raw) || JSON.stringify(raw) !== JSON.stringify(expected)) throw new SavedStorageError('changed')
              ids.push(expected.id)
            }
            for (const id of ids) await request(records.delete(id))
          }
        })
      } catch (error) { throw storageError(error) }
    },
    close() { db.close() },
  }
}
