import { createContext, useCallback, useContext, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { SavedJobsController } from '../hooks/useSavedJobs'
import type { SavedRemovalController } from '../hooks/useSavedRemoval'
import { SavedRemovalNotice } from './SavedRemovalNotice'
import { SavedStorageNotice } from './SavedStorageNotice'

interface PageHost { lifetime: symbol; node: HTMLElement }
interface ModalHost extends PageHost { dialog: HTMLDialogElement; ownsStorageNotice: boolean }
interface FeedbackHosts {
  page: PageHost | null
  modal: ModalHost | null
  registerPage: (node: HTMLElement) => () => void
  registerDialog: (node: HTMLElement, dialog: HTMLDialogElement, ownsStorageNotice: boolean) => () => void
}

const FeedbackContext = createContext<FeedbackHosts | null>(null)

/** Registration follows showModal order, with a separate token for each mount. */
export function DialogFeedbackProvider({ children }: { children: ReactNode }) {
  const [pages, setPages] = useState<PageHost[]>([])
  const [modals, setModals] = useState<ModalHost[]>([])
  const registerPage = useCallback((node: HTMLElement) => {
    const host = { lifetime: Symbol(), node }
    setPages(current => [...current, host])
    return () => setPages(current => current.filter(entry => entry.lifetime !== host.lifetime))
  }, [])
  const registerDialog = useCallback((node: HTMLElement, dialog: HTMLDialogElement, ownsStorageNotice: boolean) => {
    const host = { lifetime: Symbol(), node, dialog, ownsStorageNotice }
    setModals(current => [...current, host])
    return () => setModals(current => current.filter(entry => entry.lifetime !== host.lifetime))
  }, [])
  const value = useMemo(() => ({
    page: pages.filter(host => host.node.isConnected).at(-1) ?? null,
    modal: modals.filter(host => host.node.isConnected && host.dialog.open).at(-1) ?? null,
    registerPage, registerDialog,
  }), [pages, modals, registerPage, registerDialog])
  return <FeedbackContext.Provider value={value}>{children}</FeedbackContext.Provider>
}

export function useDialogFeedbackRegistration() {
  return useContext(FeedbackContext)?.registerDialog
}

export function SavedFeedbackSlot() {
  const ref = useRef<HTMLDivElement>(null)
  const register = useContext(FeedbackContext)?.registerPage
  useLayoutEffect(() => {
    if (ref.current && register) return register(ref.current)
  }, [register])
  return <div className="saved-feedback-host" ref={ref} />
}

function focusTarget(target: HTMLElement | null): boolean {
  if (!target?.isConnected || target === document.body || target === document.documentElement
    || target.matches(':disabled') || target.closest('[inert]') || !target.getClientRects().length
    || getComputedStyle(target).visibility === 'hidden') return false
  target.focus({ preventScroll: true })
  if (document.activeElement !== target) return false
  const panel = target.closest<HTMLElement>('.results-scroll')
  if (panel && ['auto', 'scroll'].includes(getComputedStyle(panel).overflowY)) {
    const rect = target.getBoundingClientRect()
    panel.scrollTop += rect.top - panel.getBoundingClientRect().top - (panel.clientHeight - rect.height) / 2
  } else target.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' })
  return true
}

/** One physical panel, moved into the actual top modal or current result list. */
export function SavedFeedback({ removal, storage, onManage }: { removal: SavedRemovalController; storage: SavedJobsController; onManage: () => void }) {
  const hosts = useContext(FeedbackContext)
  const modal = hosts?.modal ?? null
  const target = modal?.node ?? hosts?.page?.node ?? null
  const afterAction = useRef<{ button: HTMLButtonElement; jobId: string | null } | null>(null)
  useLayoutEffect(() => {
    const request = afterAction.current
    if (!request) return
    const active = document.activeElement
    // A late storage result must not take focus from a subsequent input.
    if (active !== request.button && active !== document.body && active?.isConnected) {
      afterAction.current = null
      return
    }
    if (request.button.isConnected && !request.button.disabled) return
    if (!modal && document.querySelector('dialog[open]')) return
    afterAction.current = null
    if (modal) {
      focusTarget(modal.dialog.querySelector<HTMLElement>('.dialog-close'))
      return
    }
    const id = request.jobId === null ? null : CSS.escape(request.jobId)
    const selectors = [
      ...(id === null ? [] : [`.saved-title[data-saved-job-id="${id}"]`, `[data-save-job-id="${id}"]`]),
      '.saved-title',
      '.collection-search input',
      '.empty-state button',
      '.global-search input',
      '#main-content',
    ]
    for (const selector of selectors) {
      for (const element of document.querySelectorAll<HTMLElement>(selector)) {
        if (focusTarget(element)) return
      }
    }
  }, [removal.pending, removal.latest, storage.phase, modal, target])
  const onAction = (button: HTMLButtonElement, jobId: string | null, action: () => void) => {
    if (document.activeElement === button) afterAction.current = { button, jobId }
    action()
  }
  const showRemoval = Boolean(removal.pending || removal.latest)
  const showStorage = modal && !modal.ownsStorageNotice && (storage.phase === 'error' || storage.recovery.length > 0)
  if (!target || (!showRemoval && !showStorage)) return null
  return createPortal(<>
    {showRemoval && <SavedRemovalNotice removal={removal} storageFailed={storage.phase === 'error'} onAction={onAction} />}
    {showStorage && <SavedStorageNotice storage={storage} onManage={onManage} onRetry={button => onAction(button, null, storage.retry)} issuesOnly />}
  </>, target)
}
