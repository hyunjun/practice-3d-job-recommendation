import { createContext, useCallback, useContext, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { SavedJobsController } from '../hooks/useSavedJobs'
import type { SavedRemovalController } from '../hooks/useSavedRemoval'
import { SavedRemovalNotice } from './SavedRemovalNotice'
import { SavedStorageNotice } from './SavedStorageNotice'
import { createDialogFocusScope } from '../lib/dialog-visibility'
import type { DialogFocusOwner, DialogFocusScope, DialogFocusTicket } from '../lib/dialog-visibility'

interface PageHost { lifetime: symbol; node: HTMLElement }
interface ModalHost extends PageHost { dialog: HTMLDialogElement; ownsStorageNotice: boolean }
interface FeedbackHosts {
  page: PageHost | null
  modal: ModalHost | null
  registerPage: (node: HTMLElement) => () => void
  registerDialog: (node: HTMLElement, dialog: HTMLDialogElement, ownsStorageNotice: boolean) => () => void
  focus: DialogFocusScope
}

const FeedbackContext = createContext<FeedbackHosts | null>(null)

/** Registration follows showModal order, with a separate token for each mount. */
export function DialogFeedbackProvider({ children }: { children: ReactNode }) {
  const [pages, setPages] = useState<PageHost[]>([])
  const [modals, setModals] = useState<ModalHost[]>([])
  const registry = useRef<{ pages: PageHost[]; modals: ModalHost[] }>({ pages: [], modals: [] })
  const currentOwner = useCallback((): DialogFocusOwner | null => {
    const modal = registry.current.modals.filter(host => host.node.isConnected && host.dialog.open).at(-1)
    if (modal) return { lifetime: modal.lifetime, node: modal.dialog, dialog: modal.dialog }
    const page = registry.current.pages.filter(host => host.node.isConnected).at(-1)
    return page ? { lifetime: page.lifetime, node: page.node, dialog: null } : null
  }, [])
  const focus = useMemo(() => createDialogFocusScope(document, currentOwner), [currentOwner])
  useLayoutEffect(() => focus.listen(), [focus])
  const registerPage = useCallback((node: HTMLElement) => {
    const host = { lifetime: Symbol(), node }
    registry.current.pages = [...registry.current.pages, host]
    focus.ownerChanged()
    setPages(registry.current.pages)
    return () => {
      registry.current.pages = registry.current.pages.filter(entry => entry.lifetime !== host.lifetime)
      focus.ownerChanged()
      setPages(registry.current.pages)
    }
  }, [focus])
  const registerDialog = useCallback((node: HTMLElement, dialog: HTMLDialogElement, ownsStorageNotice: boolean) => {
    const host = { lifetime: Symbol(), node, dialog, ownsStorageNotice }
    registry.current.modals = [...registry.current.modals, host]
    focus.ownerChanged()
    setModals(registry.current.modals)
    return () => {
      registry.current.modals = registry.current.modals.filter(entry => entry.lifetime !== host.lifetime)
      focus.ownerChanged()
      setModals(registry.current.modals)
    }
  }, [focus])
  const value = useMemo(() => ({
    page: pages.filter(host => host.node.isConnected).at(-1) ?? null,
    modal: modals.filter(host => host.node.isConnected && host.dialog.open).at(-1) ?? null,
    registerPage, registerDialog, focus,
  }), [pages, modals, registerPage, registerDialog, focus])
  return <FeedbackContext.Provider value={value}>{children}</FeedbackContext.Provider>
}

export function useDialogFeedbackRegistration() {
  return useContext(FeedbackContext)?.registerDialog
}

export function useDialogFocusScope() {
  return useContext(FeedbackContext)?.focus
}

export function SavedFeedbackSlot() {
  const ref = useRef<HTMLDivElement>(null)
  const register = useContext(FeedbackContext)?.registerPage
  useLayoutEffect(() => {
    if (ref.current && register) return register(ref.current)
  }, [register])
  return <div className="saved-feedback-host" ref={ref} />
}

function focusTarget(target: HTMLElement | null, permitted: () => boolean): boolean {
  if (!permitted() || !target?.isConnected || target === document.body || target === document.documentElement
    || target.matches(':disabled') || target.closest('[inert]') || !target.getClientRects().length
    || getComputedStyle(target).visibility === 'hidden') return false
  target.focus({ preventScroll: true })
  if (document.activeElement !== target || !permitted()) return false
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
  const afterAction = useRef<{ button: HTMLButtonElement; jobId: string | null; ticket: DialogFocusTicket | null } | null>(null)
  useLayoutEffect(() => {
    const request = afterAction.current
    if (!request) return
    const focus = hosts?.focus
    if (!focus?.valid(request.ticket)) { afterAction.current = null; return }
    const active = document.activeElement
    // A late storage result must not take focus from a subsequent input.
    if (active !== request.button && active !== document.body && active?.isConnected) {
      afterAction.current = null
      return
    }
    if (request.button.isConnected && !request.button.disabled) return
    if (!modal && document.querySelector('dialog[open]')) return
    afterAction.current = null
    focus.run(request.ticket, () => {
      const permitted = () => focus.valid(request.ticket)
      if (modal) return focusTarget(modal.dialog.querySelector<HTMLElement>('.dialog-close'), permitted)
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
          if (focusTarget(element, permitted)) return true
        }
      }
      return false
    })
  }, [removal.pending, removal.latest, storage.phase, modal, target, hosts?.focus])
  const onAction = (button: HTMLButtonElement, jobId: string | null, action: () => void) => {
    if (document.activeElement === button) afterAction.current = {
      button, jobId, ticket: hosts?.focus.capture(button, 'saved-feedback') ?? null,
    }
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
