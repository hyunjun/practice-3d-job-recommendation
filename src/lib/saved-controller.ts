import { applySavedOperation, MAX_SAVED_JOBS } from '../../shared/saved-jobs'
import type { SavedOperation } from '../../shared/saved-jobs'
import type { SavedJob } from '../../shared/types'
import type { SavedImportPlan } from '../../shared/saved-backup'
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
}
export type SavedChangeResult = { accepted: true } | { accepted: false; reason: 'loading' | 'limit' | 'unreadable' | 'missing' | 'busy' }
export type SavedBulkResult = { ok: true; refreshFailed?: boolean } | { ok: false; error: SavedStorageErrorCode }

function reuseJobSnapshot(record: SavedJob, previous?: SavedJob): SavedJob {
  // IndexedDB decodes fresh objects even for a note-only update. Retain an
  // identical, validated JSON snapshot so job-keyed comparisons remain ready.
  // A matching posting ID alone must never keep an older job's content.
  if (!previous || record.job === previous.job || JSON.stringify(record.job) !== JSON.stringify(previous.job)) return record
  return { ...record, job: previous.job }
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
  private running = false
  private active: Pending | null = null
  private refreshing = false
  private refreshRequested = false
  private recreateMissing = false
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

  private publish() {
    this.snapshot = {
      records: this.records(), phase: this.phase, ready: this.ready,
      error: this.error, pending: this.pending.length, recovery: this.recovery,
      occupied: this.base.length + this.unreadableCount, unreadableIds: [...this.unreadableIds], busy: this.exclusive,
    }
    this.listeners.forEach(listener => listener())
  }

  private accept(snapshot: SavedStoreSnapshot) {
    const previous = new Map(this.base.map(record => [record.job.id, record]))
    this.base = snapshot.records.map(record => reuseJobSnapshot(record, previous.get(record.job.id)))
    this.recovery = snapshot.recovery
    this.unreadableIds = new Set(snapshot.unreadableIds)
    this.unreadableCount = snapshot.occupied - snapshot.records.length
  }

  async start() {
    const epoch = ++this.epoch
    this.store?.close()
    this.store = null
    this.running = false
    this.active = null
    this.refreshing = false
    this.exclusive = false
    this.error = null
    this.phase = this.ready && this.pending.length ? 'saving' : 'loading'
    this.publish()
    let opened: SavedStore | null = null
    try {
      opened = await this.open()
      if (epoch !== this.epoch) { opened.close(); return }
      const snapshot = await opened.read()
      if (epoch !== this.epoch) { opened.close(); return }
      this.store = opened
      this.accept(snapshot)
      this.ready = true
      this.phase = this.pending.length ? 'saving' : 'ready'
      this.publish()
      void this.flush()
    } catch (error) {
      opened?.close()
      if (epoch !== this.epoch) return
      this.fail(error)
    }
  }

  stop() {
    this.epoch++
    this.store?.close()
    this.store = null
    this.running = false
    this.active = null
    this.exclusive = false
  }

  change(operation: SavedOperation): SavedChangeResult {
    if (!this.ready) return { accepted: false, reason: 'loading' }
    if (this.exclusive) return { accepted: false, reason: 'busy' }
    const id = operation.kind === 'add' ? operation.record.job.id : operation.id
    if (this.unreadableIds.has(id)) return { accepted: false, reason: 'unreadable' }
    const current = this.snapshot.records.find(item => item.job.id === id)
    if (operation.kind === 'add') {
      if (current) return { accepted: true }
      if (this.snapshot.records.length + this.unreadableCount >= MAX_SAVED_JOBS) return { accepted: false, reason: 'limit' }
    }
    if (operation.kind === 'update' && !current) return { accepted: false, reason: 'missing' }
    if (operation.kind === 'remove' && !current) return { accepted: true }
    const draft = operation.kind === 'update' && current ? { ...current, ...operation.patch } : undefined
    const last = this.pending.at(-1)
    // Preserve an in-flight operation, but collapse queued keystrokes for one record.
    if (operation.kind === 'update' && last && last !== this.active && last.operation.kind === 'update' && last.operation.id === id) {
      last.operation = { ...last.operation, patch: { ...last.operation.patch, ...operation.patch } }
      last.draft = draft
    } else this.pending.push({ operation, draft })
    this.phase = this.error ? 'error' : 'saving'
    this.publish()
    if (!this.error) void this.flush()
    return { accepted: true }
  }

  private fail(error: unknown) {
    this.error = error instanceof SavedStorageError ? error.code : 'write'
    this.phase = 'error'
    this.publish()
  }

  private async flush() {
    if (this.running || this.refreshing || this.exclusive || !this.store || this.error || !this.pending.length) return
    const epoch = this.epoch
    this.running = true
    try {
      while (this.pending.length && this.store && !this.error) {
        const current = this.pending[0]
        this.active = current
        const committed = await this.store.apply(current.operation, this.recreateMissing ? current.draft : undefined)
        if (epoch !== this.epoch) return
        const id = current.operation.kind === 'add' ? current.operation.record.job.id : current.operation.id
        if (committed) {
          this.base = this.base.some(item => item.job.id === id)
            ? this.base.map(item => item.job.id === id ? reuseJobSnapshot(committed.record, item) : item) : [committed.record, ...this.base]
        } else this.base = this.base.filter(item => item.job.id !== id)
        this.pending.shift()
        this.active = null
        this.phase = this.pending.length ? 'saving' : 'ready'
        this.publish()
        this.onCommit?.()
      }
      this.recreateMissing = false
    } catch (error) {
      if (epoch === this.epoch) this.fail(error)
    } finally {
      if (epoch === this.epoch) {
        this.running = false
        this.active = null
        if (!this.pending.length && this.refreshRequested && !this.error) void this.refresh()
      }
    }
  }

  async retry() {
    if (this.exclusive) return
    // A deliberate removal supersedes earlier failed edits to that record.
    // Delete first so a full database can accept the remaining saves.
    const removed = new Set<string>()
    const retained: Pending[] = []
    for (let index = this.pending.length - 1; index >= 0; index--) {
      const entry = this.pending[index]
      const id = entry.operation.kind === 'add' ? entry.operation.record.job.id : entry.operation.id
      if (removed.has(id)) continue
      retained.unshift(entry)
      if (entry.operation.kind === 'remove') removed.add(id)
    }
    this.pending = [
      ...retained.filter(entry => entry.operation.kind === 'remove'),
      ...retained.filter(entry => entry.operation.kind !== 'remove'),
    ]
    this.recreateMissing = true
    await this.start()
  }

  importRecords(plan: SavedImportPlan): Promise<SavedBulkResult> {
    return this.bulk(store => store.importRecords(plan))
  }

  discardRecovery(target: SavedRecovery): Promise<SavedBulkResult> {
    return this.bulk(store => store.discardRecovery(target))
  }

  private async bulk(action: (store: SavedStore) => Promise<void>): Promise<SavedBulkResult> {
    if (!this.store || !this.ready || this.pending.length || this.error || this.running || this.refreshing || this.exclusive) return { ok: false, error: 'busy' }
    const store = this.store
    const epoch = this.epoch
    this.exclusive = true
    this.phase = 'saving'
    this.publish()
    let committed = false
    try {
      await action(store)
      committed = true
      this.onCommit?.()
      if (epoch !== this.epoch) return { ok: true, refreshFailed: true }
      const snapshot = await store.read()
      if (epoch !== this.epoch) return { ok: true, refreshFailed: true }
      this.accept(snapshot)
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
        if (this.refreshRequested && !this.error) void this.refresh()
      }
    }
  }

  /** Cross-tab refresh never replaces an uncommitted local draft. */
  async refresh() {
    this.refreshRequested = true
    if (!this.store || this.running || this.refreshing || this.exclusive || this.pending.length || this.error) return
    const epoch = this.epoch
    const store = this.store
    this.refreshing = true
    this.refreshRequested = false
    try {
      const snapshot = await store.read()
      if (epoch !== this.epoch) return
      this.accept(snapshot)
      this.publish()
    } catch (error) {
      if (epoch === this.epoch) this.fail(error)
    } finally {
      if (epoch === this.epoch) {
        this.refreshing = false
        if (this.pending.length && !this.error) void this.flush()
        else if (this.refreshRequested && !this.error) void this.refresh()
      }
    }
  }
}
