import { useEffect, useState, useSyncExternalStore } from 'react'
import { SavedController } from '../lib/saved-controller'
import { openSavedStore } from '../lib/saved-store'
import type { SavedOperation } from '../../shared/saved-jobs'

export function useSavedJobs() {
  const [controller] = useState(() => new SavedController(() => openSavedStore()))
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot)
  useEffect(() => {
    let channel: BroadcastChannel | undefined
    try {
      channel = new BroadcastChannel('orbit-saved-changes')
      channel.onmessage = () => { void controller.refresh() }
    } catch { /* Saving does not depend on cross-tab notifications. */ }
    controller.onCommit = () => { try { channel?.postMessage('changed') } catch { /* The database commit already succeeded. */ } }
    const legacyChange = (event: StorageEvent) => { if (event.key === 'orbit.v1.saved') void controller.refresh() }
    window.addEventListener('storage', legacyChange)
    void controller.start()
    return () => {
      controller.onCommit = undefined
      controller.stop()
      channel?.close()
      window.removeEventListener('storage', legacyChange)
    }
  }, [controller])
  useEffect(() => {
    if (!state.pending) return
    const preventLoss = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', preventLoss)
    return () => window.removeEventListener('beforeunload', preventLoss)
  }, [state.pending])
  return { ...state, change: (operation: SavedOperation) => controller.change(operation), retry: () => { void controller.retry() } }
}

export type SavedJobsController = ReturnType<typeof useSavedJobs>
