import { useCallback, useMemo, useRef, useState } from 'react'
import { sameNormalizedSavedRecord } from '../../shared/saved-backup'
import type { SavedJob } from '../../shared/types'
import { SAVED_CHANGE_HELP } from '../lib/saved-messages'
import type { SavedJobsController } from './useSavedJobs'

export interface SavedRemovalEntry {
  generation: number
  record: SavedJob
  attempt: number | null
  message: string | null
}

interface RemovalState {
  pending: SavedRemovalEntry | null
  latest: SavedRemovalEntry | null
}

/** Two document-local originals. No timer, persistence or separate write path. */
export function useSavedRemoval(storage: SavedJobsController) {
  const [state, setState] = useState<RemovalState>({ pending: null, latest: null })
  const current = useRef(state)
  const store = useRef(storage)
  store.current = storage
  const generation = useRef(0)
  const attempt = useRef(0)
  const update = useCallback((next: RemovalState) => {
    current.current = next
    setState(next)
  }, [])

  const remove = useCallback((id: string) => {
    // The controller snapshot includes accepted input that React has not yet
    // rendered. A stale remove control must never become a new blank save.
    const existing = store.current.getSnapshot().records.find(record => record.job.id === id)
    const original = existing ? structuredClone(existing) : null
    const result = store.current.change({ kind: 'remove', id })
    if (!result.accepted || !original) return { result, removed: false }
    const before = current.current
    let pending = before.pending
    if (pending?.record.job.id === id) {
      pending = sameNormalizedSavedRecord(pending.record, original) ? null : {
        ...pending, attempt: null,
        message: '현재 기록을 다시 제거했어요. 원래 기록은 복구 대기에 남아 있어요. 복구를 다시 시도해 주세요.',
      }
    }
    update({
      pending,
      latest: { generation: ++generation.current, record: original, attempt: null, message: null },
    })
    return { result, removed: true }
  }, [update])

  const restore = useCallback((target: number) => {
    const before = current.current
    const entry = before.pending?.generation === target ? before.pending
      : before.latest?.generation === target ? before.latest : null
    if (!entry || entry.attempt !== null) return
    if (before.pending && before.pending !== entry) return

    const request = ++attempt.current
    const pending = { ...entry, attempt: request, message: null }
    // Pin before admission: loading, capacity and other guards cannot consume
    // the last copy of a requested original.
    update({ pending, latest: before.latest === entry ? null : before.latest })
    const result = store.current.addTracked(entry.record)
    const finish = (next: SavedRemovalEntry | null) => {
      const live = current.current
      if (live.pending?.generation !== target || live.pending.attempt !== request) return
      update({ ...live, pending: next })
    }
    if (!result.accepted) {
      finish({ ...pending, attempt: null, message: SAVED_CHANGE_HELP[result.reason] })
      return
    }
    void result.completion.then(outcome => {
      if (outcome.status === 'settled') { finish(null); return }
      const message = outcome.status === 'noop'
        ? '현재 목록에 같은 공고가 있어요. 원래 기록의 저장 완료는 확인하지 못했어요. 현재 기록을 확인한 뒤 다시 시도해 주세요.'
        : outcome.status === 'conflict'
          ? '다른 내용의 기록이 먼저 저장돼 원래 메모를 복구하지 않았어요. 현재 기록을 확인하고 제거한 뒤 복구를 다시 시도해 주세요.'
          : '같은 공고를 다시 제거해 이전 복구 요청이 대체됐어요. 원래 기록은 남아 있으니 복구를 다시 시도해 주세요.'
      finish({ ...pending, attempt: null, message })
    })
  }, [update])

  const restoreJob = useCallback((id: string) => {
    const { pending, latest } = current.current
    const entry = pending?.record.job.id === id ? pending : latest?.record.job.id === id ? latest : null
    if (!entry) return false
    restore(entry.generation)
    return true
  }, [restore])

  const dismiss = useCallback((target: number) => {
    const before = current.current
    if (before.pending?.generation === target) update({ ...before, pending: null })
    else if (before.latest?.generation === target) update({ ...before, latest: null })
    // Accepted writes belong to the storage controller and continue normally.
  }, [update])

  const restorable = useMemo(() => {
    const result = new Map<string, number>()
    if (state.latest) result.set(state.latest.record.job.id, state.latest.generation)
    if (state.pending) result.set(state.pending.record.job.id, state.pending.generation)
    return result
  }, [state])

  return { ...state, restorable, remove, restore, restoreJob, dismiss }
}

export type SavedRemovalController = ReturnType<typeof useSavedRemoval>
