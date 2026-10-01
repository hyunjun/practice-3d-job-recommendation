import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { SavedController } from '../lib/saved-controller'
import { installSavedLifecycle } from '../lib/saved-lifecycle'
import { openSavedStore } from '../lib/saved-store'
import type { SavedOperation } from '../../shared/saved-jobs'
import type { SavedImportPlan } from '../../shared/saved-backup'
import type { SavedRecovery } from '../lib/saved-store'

export function useSavedJobs(inSavedView = false) {
  const [controller] = useState(() => new SavedController(() => openSavedStore()))
  const wasSavedView = useRef(inSavedView)
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot)
  useEffect(() => {
    let channel: BroadcastChannel | undefined
    try {
      channel = new BroadcastChannel('orbit-saved-changes')
      channel.onmessage = () => controller.requestRefresh()
    } catch { /* Saving does not depend on cross-tab notifications. */ }
    controller.onCommit = () => { try { channel?.postMessage('changed') } catch { /* The database commit already succeeded. */ } }
    const legacyChange = (event: StorageEvent) => { if (event.key === 'orbit.v1.saved') controller.requestRefresh() }
    window.addEventListener('storage', legacyChange)
    const removeLifecycle = installSavedLifecycle(() => controller.requestRefresh())
    void controller.start()
    return () => {
      controller.onCommit = undefined
      removeLifecycle()
      controller.stop()
      channel?.close()
      window.removeEventListener('storage', legacyChange)
    }
  }, [controller])
  useEffect(() => {
    const entered = inSavedView && !wasSavedView.current
    wasSavedView.current = inSavedView
    if (entered && document.visibilityState === 'visible') controller.requestRefresh()
  }, [controller, inSavedView])
  useEffect(() => {
    if (!state.pending) return
    const preventLoss = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', preventLoss)
    return () => window.removeEventListener('beforeunload', preventLoss)
  }, [state.pending])
  return {
    ...state, change: (operation: SavedOperation) => controller.change(operation), retry: () => { void controller.retry() },
    importRecords: (plan: SavedImportPlan) => controller.importRecords(plan),
    discardRecovery: (target: SavedRecovery) => controller.discardRecovery(target),
    refresh: () => controller.refresh(),
  }
}

export type SavedJobsController = ReturnType<typeof useSavedJobs>
