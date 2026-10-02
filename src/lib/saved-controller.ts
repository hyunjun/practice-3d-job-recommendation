import { applySavedOperation, isSampleSavedRecord, MAX_SAVED_JOBS, SavedJobSchema } from '../../shared/saved-jobs'
import type { SavedOperation } from '../../shared/saved-jobs'
import type { SavedJob } from '../../shared/types'
import type { SavedImportPlan } from '../../shared/saved-backup'
import { sameNormalizedSavedRecord } from '../../shared/saved-backup'
import { SavedStorageError } from './saved-store'
import type { SavedRecovery, SavedStorageErrorCode, SavedStore, SavedStoreSnapshot } from './saved-store'

export interface SavedState {
  records: SavedJob[]
  phase: 'loading' | 'ready' | 'saving' | 'error'
  ready: boolean
  error: SavedStorageErrorCode | null
  pending: number
  recovery: SavedRecovery[]
  occupied: number
  unreadableIds: string[]
  busy: boolean
}
interface Pending {
  operation: SavedOperation
  draft?: SavedJob
  recreate?: boolean
  settle?: (outcome: SavedAddOutcome) => void
}
export type SavedChangeResult = { accepted: true } | { accepted: false; reason: 'loading' | 'limit' | 'unreadable' | 'missing' | 'busy' }
export type SavedAddOutcome =
  | { status: 'noop' | 'superseded' }
  | { status: 'settled' | 'conflict'; record: SavedJob }
export type SavedTrackedAddResult =
  | { accepted: true; completion: Promise<SavedAddOutcome> }
  | Extract<SavedChangeResult, { accepted: false }>
export type SavedBulkResult = { ok: true; refreshFailed?: boolean } | { ok: false; error: SavedStorageErrorCode }
export type SavedRefreshResult =
  | { status: 'refreshed'; snapshot: SavedState }
  | { status: 'deferred' }
  | { status: 'failed'; error: SavedStorageErrorCode }
  | { status: 'stopped' }
interface RefreshWaiter {
  request: number
  resolve: (result: SavedRefreshResult) => void
}

function reuseRecord(record: SavedJob, previous?: SavedJob): SavedJob {
  if (!previous || record === previous) return record
  // Only validated active records are compared. Opaque recovery originals are
  // never serialized or normalized to make an unchanged read look cheaper.
  const job = record.job === previous.job || JSON.stringify(record.job) === JSON.stringify(previous.job) ? previous.job : record.job
  const company = record.company === previous.company || JSON.stringify(record.company) === JSON.stringify(previous.company) ? previous.company : record.company
  if (job === previous.job && company === previous.company && record.note === previous.note
    && record.status === previous.status && record.savedAt === previous.savedAt) return previous
  return job === record.job && company === record.company ? record : { ...record, job, company }
}

function reuseRecords(records: SavedJob[], previous: SavedJob[]): SavedJob[] {
  if (records === previous) return previous
  const byId = new Map(previous.map(record => [record.job.id, record]))
  const next = records.map(record => reuseRecord(record, byId.get(record.job.id)))
  return next.length === previous.length && next.every((record, index) => record === previous[index]) ? previous : next
}

function reuseRecovery(records: SavedRecovery[], previous: SavedRecovery[]): SavedRecovery[] {
  return records.length === previous.length && records.every((record, index) => {
    const before = previous[index]
    return record.kind === before.kind && record.count === before.count && Object.is(record.original, before.original)
  }) ? previous : records
}

/** The visible draft is separate from the last committed database state. */
export class SavedController {
  private base: SavedJob[] = []
  private pending: Pending[] = []
  private unreadableIds = new Set<string>()
  private unreadableCount = 0
  private recovery: SavedRecovery[] = []
  private listeners = new Set<() => void>()
  private store: SavedStore | null = null
  private epoch = 0
  private live = false
  private initializing = false
  private running = false
  private active: Pending | null = null
  private refreshing = false
  private requested = 0
  private covered = 0
  private refreshWaiters = new Set<RefreshWaiter>()
  private exclusive = false
  private ready = false
  private error: SavedStorageErrorCode | null = null
  private phase: SavedState['phase'] = 'loading'
  private snapshot: SavedState = { records: [], phase: 'loading', ready: false, error: null, pending: 0, recovery: [], occupied: 0, unreadableIds: [], busy: false }
  onCommit?: () => void

  constructor(private open: () => Promise<SavedStore>) {}

  getSnapshot = (): SavedState => this.snapshot
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private records(): SavedJob[] {
    return this.pending.reduce((records, { operation, draft }) => {
      // A draft remains available for export if another tab removed its record.
      const current = operation.kind === 'update' && draft && !records.some(item => item.job.id === operation.id)
        ? [draft, ...records] : records
      return applySavedOperation(current, operation)
    }, this.base)
  }

  private publish(): SavedState {
    const previous = this.snapshot
    const unreadableIds = previous.unreadableIds.length === this.unreadableIds.size
      && previous.unreadableIds.every(id => this.unreadableIds.has(id)) ? previous.unreadableIds : [...this.unreadableIds]
    const next: SavedState = {
      records: reuseRecords(this.records(), previous.records), phase: this.phase, ready: this.ready,
      error: this.error, pending: this.pending.length, recovery: this.recovery,
      occupied: this.base.length + this.unreadableCount, unreadableIds, busy: this.exclusive,
    }
    if ((Object.keys(next) as (keyof SavedState)[]).every(key => next[key] === previous[key])) return previous
    this.snapshot = next
    this.listeners.forEach(listener => listener())
    return next
  }

  private accept(snapshot: SavedStoreSnapshot) {
    this.base = reuseRecords(snapshot.records.filter(record => !isSampleSavedRecord(record)), this.base)
    this.recovery = reuseRecovery(snapshot.recovery, this.recovery)
    this.unreadableIds = new Set(snapshot.unreadableIds)
    this.unreadableCount = snapshot.occupied - snapshot.records.length
  }

  async start() {
    this.stop()
    const epoch = this.epoch
    this.live = true
    this.initializing = true
    this.error = null
    this.phase = this.ready && this.pending.length ? 'saving' : 'loading'
    this.publish()
    let opened: SavedStore | null = null
    try {
      opened = await this.open()
      if (epoch !== this.epoch) { opened.close(); return }
      // Own the connection before its first read, so stop can close it even if
      // that native read never finishes. Late results belong to this epoch only.
      this.store = opened
      const covered = this.requested
      const snapshot = await opened.read()
      if (epoch !== this.epoch) return
      this.accept(snapshot)
      this.covered = covered
      this.initializing = false
      this.ready = true
      this.phase = this.pending.length ? 'saving' : 'ready'
      this.publish()
      if (epoch === this.epoch) this.drain()
    } catch (error) {
      if (epoch !== this.epoch) return
      opened?.close()
      this.store = null
      this.initializing = false
      this.fail(error)
    }
  }

  stop() {
    this.epoch++
    this.live = false
    this.initializing = false
    this.finishRefreshes({ status: 'stopped' })
    this.store?.close()
    this.store = null
    this.running = false
    this.active = null
    this.refreshing = false
    this.requested = 0
    this.covered = 0
    this.exclusive = false
  }

  change(operation: SavedOperation): SavedChangeResult {
    return this.enqueue(operation)
  }

  /** Admission is not durability. Only the queued operation can settle its receipt. */
  addTracked(record: SavedJob): SavedTrackedAddResult {
    let settle!: (outcome: SavedAddOutcome) => void
    const completion = new Promise<SavedAddOutcome>(resolve => { settle = resolve })
    const result = this.enqueue({ kind: 'add', record }, settle)
    return result.accepted ? { accepted: true, completion } : result
  }

  private finishTracked(entry: Pending, outcome: SavedAddOutcome) {
    const settle = entry.settle
    entry.settle = undefined
    // This is a native Promise resolver, never a UI callback. Consumers run in
    // a later microtask, outside the storage transaction's error handling.
    settle?.(outcome)
  }

  private enqueue(operation: SavedOperation, settle?: Pending['settle']): SavedChangeResult {
    if (operation.kind === 'add' && isSampleSavedRecord(operation.record)) return { accepted: false, reason: 'unreadable' }
    if (!this.ready) return { accepted: false, reason: 'loading' }
    if (this.exclusive) return { accepted: false, reason: 'busy' }
    const id = operation.kind === 'add' ? operation.record.job.id : operation.id
    if (this.unreadableIds.has(id)) return { accepted: false, reason: 'unreadable' }
    const current = this.snapshot.records.find(item => item.job.id === id)
    if (operation.kind === 'add') {
      if (current) { settle?.({ status: 'noop' }); return { accepted: true } }
      if (this.snapshot.records.length + this.unreadableCount >= MAX_SAVED_JOBS) return { accepted: false, reason: 'limit' }
    }
    if (operation.kind === 'update' && !current) return { accepted: false, reason: 'missing' }
    if (operation.kind === 'remove' && !current) return { accepted: true }
    // Include a just-published active add: a subscriber may deliberately remove
    // it before this flush has delivered its receipt.
    const superseded = operation.kind === 'remove'
      ? [...new Set([...this.pending, ...(this.active ? [this.active] : [])])]
        .filter(entry => entry.operation.kind === 'add' && entry.operation.record.job.id === id)
      : []
    const draft = operation.kind === 'update' && current ? { ...current, ...operation.patch } : undefined
    const last = this.pending.at(-1)
    // Preserve an in-flight operation, but collapse queued keystrokes for one record.
    if (operation.kind === 'update' && last && last !== this.active && last.operation.kind === 'update' && last.operation.id === id) {
      last.operation = { ...last.operation, patch: { ...last.operation.patch, ...operation.patch } }
      last.draft = draft
    } else this.pending.push({ operation, draft, settle })
    this.finishRefreshes({ status: 'deferred' })
    this.phase = this.error ? 'error' : 'saving'
    this.publish()
    superseded.forEach(entry => this.finishTracked(entry, { status: 'superseded' }))
    this.drain()
    return { accepted: true }
  }

  private fail(error: unknown) {
    this.error = error instanceof SavedStorageError ? error.code : 'write'
    this.phase = 'error'
    this.finishRefreshes({ status: 'failed', error: this.error })
    this.publish()
  }

  private drain() {
    if (!this.live || this.initializing || !this.store || this.error || this.running || this.refreshing || this.exclusive) return
    if (this.pending.length) void this.flush()
    else if (this.requested > this.covered) void this.readRefresh()
  }

  private async flush() {
    if (!this.live || this.initializing || this.running || this.refreshing || this.exclusive || !this.store || this.error || !this.pending.length) return
    const epoch = this.epoch
    const store = this.store
    this.running = true
    try {
      while (epoch === this.epoch && this.pending.length && !this.error) {
        const current = this.pending[0]
        this.active = current
        // A deliberate retry permits this retained entry's next attempt only.
        // Failure, reconnect, and later edits cannot inherit that permission.
        const recreate = current.recreate ? current.draft : undefined
        current.recreate = false
        const committed = await store.apply(current.operation, recreate)
        if (epoch !== this.epoch) return
        const id = current.operation.kind === 'add' ? current.operation.record.job.id : current.operation.id
        let outcome: SavedAddOutcome | undefined
        if (current.operation.kind === 'add') {
          const parsed = SavedJobSchema.safeParse(committed?.record)
          if (!committed || committed.id !== id || !Number.isSafeInteger(committed.order) || committed.order < 0
            || !parsed.success || parsed.data.job.id !== id) {
            throw new SavedStorageError('write')
          }
          if (current.settle) outcome = {
            status: sameNormalizedSavedRecord(current.operation.record, parsed.data) ? 'settled' : 'conflict',
            record: parsed.data,
          }
        }
        if (committed) {
          this.base = this.base.some(item => item.job.id === id)
            ? this.base.map(item => item.job.id === id ? reuseRecord(committed.record, item) : item) : [committed.record, ...this.base]
        } else this.base = this.base.filter(item => item.job.id !== id)
        this.pending.shift()
        this.phase = this.pending.length ? 'saving' : 'ready'
        this.publish()
        if (outcome) this.finishTracked(current, outcome)
        this.active = null
        if (epoch === this.epoch) this.onCommit?.()
      }
    } catch (error) {
      if (epoch === this.epoch) this.fail(error)
    } finally {
      if (epoch === this.epoch) {
        this.running = false
        this.active = null
        this.drain()
      }
    }
  }

  async retry() {
    if (this.exclusive) return
    // A deliberate removal supersedes earlier failed edits to that record.
    // Delete first so a full database can accept the remaining saves.
    const removed = new Set<string>()
    const retained: Pending[] = []
    const superseded: Pending[] = []
    for (let index = this.pending.length - 1; index >= 0; index--) {
      const entry = this.pending[index]
      const id = entry.operation.kind === 'add' ? entry.operation.record.job.id : entry.operation.id
      if (removed.has(id)) { superseded.push(entry); continue }
      retained.unshift(entry)
      if (entry.operation.kind === 'remove') removed.add(id)
    }
    this.pending = [
      ...retained.filter(entry => entry.operation.kind === 'remove'),
      ...retained.filter(entry => entry.operation.kind !== 'remove'),
    ]
    this.pending.forEach(entry => { entry.recreate = entry.operation.kind === 'update' })
    const reconnect = this.start()
    superseded.forEach(entry => this.finishTracked(entry, { status: 'superseded' }))
    await reconnect
  }

  importRecords(plan: SavedImportPlan): Promise<SavedBulkResult> {
    return this.bulk(store => store.importRecords(plan))
  }

  discardRecovery(target: SavedRecovery): Promise<SavedBulkResult> {
    return this.bulk(store => store.discardRecovery(target))
  }

  private async bulk(action: (store: SavedStore) => Promise<void>): Promise<SavedBulkResult> {
    if (!this.live || this.initializing || !this.store || !this.ready || this.pending.length || this.error || this.running || this.refreshing || this.exclusive) return { ok: false, error: 'busy' }
    const store = this.store
    const epoch = this.epoch
    this.exclusive = true
    this.phase = 'saving'
    this.publish()
    let committed = false
    try {
      await action(store)
      committed = true
      if (epoch !== this.epoch) return { ok: true, refreshFailed: true }
      this.onCommit?.()
      if (epoch !== this.epoch) return { ok: true, refreshFailed: true }
      const covered = this.requested
      const snapshot = await store.read()
      if (epoch !== this.epoch) return { ok: true, refreshFailed: true }
      this.accept(snapshot)
      this.covered = covered
      this.phase = 'ready'
      return { ok: true }
    } catch (error) {
      if (epoch === this.epoch) {
        if (committed) this.fail(error)
        else this.phase = 'ready'
      }
      // A committed import must never be described as rolled back just because
      // re-reading the list failed; the regular reconnect action reloads it.
      return committed ? { ok: true, refreshFailed: true }
        : { ok: false, error: error instanceof SavedStorageError ? error.code : 'write' }
    } finally {
      if (epoch === this.epoch) {
        this.exclusive = false
        this.publish()
        if (epoch === this.epoch) this.drain()
      }
    }
  }

  /** Hints carry no idle waiter; later signals are never discarded by a cooldown. */
  requestRefresh(): void {
    if (!this.live) return
    this.requested++
    this.drain()
  }

  /** A comparison completes from a read covering its request, not global idle. */
  refresh(): Promise<SavedRefreshResult> {
    if (!this.live) return Promise.resolve({ status: 'stopped' })
    const request = ++this.requested
    if (this.error) return Promise.resolve({ status: 'failed', error: this.error })
    if (this.initializing || !this.store || this.running || this.exclusive || this.pending.length) return Promise.resolve({ status: 'deferred' })
    return new Promise(resolve => {
      this.refreshWaiters.add({ request, resolve })
      this.drain()
    })
  }

  private finishRefreshes(result: SavedRefreshResult, covered = Infinity) {
    for (const waiter of this.refreshWaiters) {
      if (waiter.request > covered) continue
      this.refreshWaiters.delete(waiter)
      waiter.resolve(result)
    }
  }

  /** Accept a database baseline beneath any input made while it was reading. */
  private async readRefresh() {
    if (!this.store) return
    const epoch = this.epoch
    const store = this.store
    const covered = this.requested
    this.refreshing = true
    try {
      const snapshot = await store.read()
      if (epoch !== this.epoch) return
      this.accept(snapshot)
      this.covered = covered
      this.phase = this.pending.length ? 'saving' : 'ready'
      const accepted = this.publish()
      if (epoch !== this.epoch) return
      if (this.pending.length) this.finishRefreshes({ status: 'deferred' })
      else this.finishRefreshes({ status: 'refreshed', snapshot: accepted }, covered)
    } catch (error) {
      if (epoch === this.epoch) this.fail(error)
    } finally {
      if (epoch === this.epoch) {
        this.refreshing = false
        this.drain()
      }
    }
  }
}
