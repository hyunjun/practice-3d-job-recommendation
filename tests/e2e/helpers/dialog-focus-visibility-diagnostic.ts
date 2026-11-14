/**
 * Stage81 DIAG81 TEMPORARY diagnostic helper, used only by
 * tests/e2e/dialog-focus-visibility-diagnostic.spec.ts under the all3-approved
 * common direction (.local/research/81/main/dev02-diagnostic-direction-proposal-02.json,
 * SHA256 cea2f6b2dd6d147d0a56f8054f0ff6c2c0a3a90c36dc39949ac64518c6d80fb4), corrected
 * under the all3 correction direction (.local/research/81/main/diagnostic-source-correction-proposal-01.json,
 * SHA256 b18a4718e0f91189e8a9c15835c15402142553bd60ffb07fb4ac772fdf4dc05c): C3 actual-node
 * identity witnesses and the atomic release gate, C4 current-node font census, C5 reader facts.
 *
 * Everything here is passive observation for a bounded diagnostic run: a
 * read-only native signal log with its own integer order and a hard entry cap,
 * read-only dialog/footer/placement surveys, a font-obligation ledger over the
 * existing authored-font fixture registry, a diagnostic classification of the
 * unchanged scroll-route recorder's stream, and failure-safe cleanup/attachment
 * bookkeeping. Nothing here focuses, scrolls, prevents default, changes CSS,
 * advances the Clock or supplies expected values from product code. None of it
 * is a verification oracle; the verification ledgers of the intent and lifecycle
 * specs are not reproduced here. This file is removed in a reviewed later
 * candidate before the final check/build/DEV/PROD sequence.
 */
import type { ElementHandle, Locator, Page, TestInfo } from '@playwright/test'
import { footerState, placement } from './dialog-focus-visibility-d2'
import type { ElementPlacement, FontReference, FooterState, FrameProbeResult } from './dialog-focus-visibility-d2'
import type { RecorderTuple, ScrollRouteSnapshot } from './dialog-focus-visibility-scroll'

export const DIAG81_PROPOSAL = {
  path: '.local/research/81/main/dev02-diagnostic-direction-proposal-02.json',
  sha256: 'cea2f6b2dd6d147d0a56f8054f0ff6c2c0a3a90c36dc39949ac64518c6d80fb4',
} as const
/** The all3 correction direction (C1–C6) under which the base candidate was corrected. */
export const DIAG81_CORRECTION = {
  path: '.local/research/81/main/diagnostic-source-correction-proposal-01.json',
  sha256: 'b18a4718e0f91189e8a9c15835c15402142553bd60ffb07fb4ac772fdf4dc05c',
} as const

/* --------------------------------------------------------------------------
 * Passive native signal log (one document, one integer order, hard cap).
 * -------------------------------------------------------------------------- */

export interface NativeSignalEntry {
  /** Log-owned integer order; the only ordering key inside this stream. */
  order: number
  /** performance.now() at the callback; diagnostic only, ties are possible, never a cross-stream order. */
  time: number
  kind: string
  target: string
  key: string | null
  buttons: number | null
  clientX: number | null
  clientY: number | null
  dialogScrollTop: number | null
  textareaScrollTop: number | null
  selection: { start: number; end: number; direction: string } | null
  viewport: { width: number; height: number }
  active: string
}
export interface NativeSignalRead {
  installed: boolean
  cap: number
  count: number
  dropped: number
  errors: number
  firstError: string | null
  markers: number
  listeners: number
  installedAt: number | null
  entries: NativeSignalEntry[]
}
export interface NativeSignalDisposal extends NativeSignalRead { listenersRemoved: number; disposedAt: number | null; alreadyDisposed: boolean }
export interface NativeSignalInstallOptions { textareaSelector: string | null; cap: number }
export interface NativeSignalInstall { installed: boolean; listeners: number; installedAt: number; dialogFound: boolean; textareaFound: boolean; reason: string | null }

interface SignalControl { read: () => NativeSignalRead; mark: (label: string) => number; dispose: () => NativeSignalDisposal }

/** Runs inside the page; self-contained (serialized by Playwright). Passive capture listeners only; lightweight property reads; no layout-forcing geometry except scrollTop. */
function installNativeSignalLogInPage(options: NativeSignalInstallOptions): NativeSignalInstall {
  const round = (value: number) => Math.round(value * 100) / 100
  if (Reflect.get(window, '__diag81SignalLog')) return { installed: false, listeners: 0, installedAt: round(performance.now()), dialogFound: false, textareaFound: false, reason: 'already installed' }
  const describe = (node: EventTarget | null | undefined): string => {
    if (!node) return 'none'
    if (node === window) return 'window'
    if (node === document) return 'document'
    if (typeof VisualViewport !== 'undefined' && node instanceof VisualViewport) return 'visualViewport'
    if (node instanceof Element) return `${node.tagName.toLowerCase()}${node.id ? `#${node.id}` : ''}${Array.from(node.classList).slice(0, 2).map(name => `.${name}`).join('')}`
    return typeof node
  }
  const dialog = document.querySelector<HTMLDialogElement>('dialog[open]')
  const textarea = options.textareaSelector ? document.querySelector<HTMLTextAreaElement>(options.textareaSelector) : null
  const state = { entries: [] as NativeSignalEntry[], order: 0, dropped: 0, errors: 0, firstError: null as string | null, markers: 0, installedAt: round(performance.now()), listeners: 0, disposed: false }
  const noteError = (error: unknown) => { state.errors++; if (!state.firstError) state.firstError = error instanceof Error ? error.message : String(error) }
  const push = (kind: string, event: Event | null, label: string | null): number => {
    try {
      if (state.entries.length >= options.cap) { state.dropped++; return -1 }
      const order = ++state.order
      const mouse = event instanceof MouseEvent ? event : null
      state.entries.push({
        order, time: round(performance.now()), kind, target: label ?? describe(event?.target ?? null),
        key: event instanceof KeyboardEvent ? event.key : null,
        buttons: mouse ? mouse.buttons : null, clientX: mouse ? round(mouse.clientX) : null, clientY: mouse ? round(mouse.clientY) : null,
        dialogScrollTop: dialog && dialog.isConnected ? round(dialog.scrollTop) : null,
        textareaScrollTop: textarea && textarea.isConnected ? round(textarea.scrollTop) : null,
        selection: textarea && textarea.isConnected ? { start: textarea.selectionStart, end: textarea.selectionEnd, direction: textarea.selectionDirection } : null,
        viewport: { width: window.innerWidth, height: window.innerHeight },
        active: describe(document.activeElement),
      })
      return order
    } catch (error) { noteError(error); return -1 }
  }
  const removers: (() => void)[] = []
  const listen = (target: EventTarget | null, type: string, kind: string, capture: boolean) => {
    if (!target) return
    const handler = (event: Event) => { push(kind, event, null) }
    target.addEventListener(type, handler, { passive: true, capture })
    removers.push(() => target.removeEventListener(type, handler, { capture }))
    state.listeners++
  }
  listen(window, 'resize', 'window:resize', false)
  listen(window.visualViewport, 'resize', 'visualViewport:resize', false)
  listen(window.visualViewport, 'scroll', 'visualViewport:scroll', false)
  listen(document, 'selectionchange', 'document:selectionchange', false)
  listen(document, 'focusin', 'focusin', true)
  listen(document, 'focusout', 'focusout', true)
  listen(document, 'keydown', 'keydown', true)
  listen(document, 'pointerdown', 'pointerdown', true)
  listen(document, 'pointermove', 'pointermove', true)
  listen(document, 'pointerup', 'pointerup', true)
  listen(document, 'mousemove', 'mousemove', true)
  listen(dialog, 'scroll', 'dialog:scroll', false)
  listen(dialog, 'scrollend', 'dialog:scrollend', false)
  listen(textarea, 'scroll', 'textarea:scroll', false)
  listen(textarea, 'scrollend', 'textarea:scrollend', false)
  const read = (): NativeSignalRead => ({
    installed: true, cap: options.cap, count: state.entries.length, dropped: state.dropped, errors: state.errors, firstError: state.firstError,
    markers: state.markers, listeners: state.listeners, installedAt: state.installedAt, entries: state.entries.slice(),
  })
  const control: SignalControl = {
    read,
    mark: (label: string) => { const order = push('marker', null, label); if (order > 0) state.markers++; return order },
    dispose: () => {
      const alreadyDisposed = state.disposed
      let listenersRemoved = 0
      if (!alreadyDisposed) {
        for (const remove of removers.splice(0)) { try { remove(); listenersRemoved++ } catch (error) { noteError(error) } }
        state.disposed = true
        Reflect.deleteProperty(window, '__diag81SignalLog')
      }
      return { ...read(), listenersRemoved, disposedAt: round(performance.now()), alreadyDisposed }
    },
  }
  Reflect.set(window, '__diag81SignalLog', control)
  return { installed: true, listeners: state.listeners, installedAt: state.installedAt, dialogFound: dialog !== null, textareaFound: textarea !== null, reason: null }
}

/** Install in the FINAL live document (after every navigation/preparation step), before the native input under observation. */
export const installNativeSignalLog = (page: Page, options: Partial<NativeSignalInstallOptions> = {}): Promise<NativeSignalInstall> =>
  page.evaluate(installNativeSignalLogInPage, { textareaSelector: options.textareaSelector ?? null, cap: options.cap ?? 600 })
/** Host-side marker pushed into the native stream (same integer order); returns the marker's order, -1 when capped, null when the log is absent. */
export const markNativeSignal = (page: Page, label: string): Promise<number | null> => page.evaluate(label => {
  const control = Reflect.get(window, '__diag81SignalLog') as SignalControl | undefined
  return control ? control.mark(label) : null
}, label)
export const readNativeSignalLog = (page: Page): Promise<NativeSignalRead | null> => page.evaluate(() => {
  const control = Reflect.get(window, '__diag81SignalLog') as SignalControl | undefined
  return control ? control.read() : null
})
/** Remove every listener deterministically and return the final log; null when nothing is installed (already disposed or never installed). */
export const disposeNativeSignalLog = (page: Page): Promise<NativeSignalDisposal | null> => page.evaluate(() => {
  const control = Reflect.get(window, '__diag81SignalLog') as SignalControl | undefined
  return control ? control.dispose() : null
})

/* --------------------------------------------------------------------------
 * Read-only dialog, footer and placement surveys.
 * -------------------------------------------------------------------------- */

export interface Box { left: number; top: number; right: number; bottom: number; width: number; height: number }

export interface DialogMetrics {
  found: boolean
  /** Unrounded element.scrollTop as read. */
  scrollTopExact: number
  scrollHeight: number
  clientHeight: number
  range: number
  clientBox: Box | null
  /** Public attribute the product sets when its footer is in flow mode; null when absent. */
  footerFlowAttribute: string | null
  footerClearanceVar: string
  readerMaxHeightVar: string
  viewport: { width: number; height: number }
  windowScroll: { x: number; y: number }
  active: string
  time: number
}

function dialogMetricsInPage(): DialogMetrics {
  const round = (value: number) => Math.round(value * 100) / 100
  const describe = (node: Element | null) => node ? `${node.tagName.toLowerCase()}${node.id ? `#${node.id}` : ''}${Array.from(node.classList).slice(0, 3).map(name => `.${name}`).join('')}` : 'none'
  const dialog = document.querySelector<HTMLDialogElement>('dialog[open]')
  const base = { viewport: { width: window.innerWidth, height: window.innerHeight }, windowScroll: { x: window.scrollX, y: window.scrollY }, active: describe(document.activeElement), time: round(performance.now()) }
  if (!dialog) return { found: false, scrollTopExact: 0, scrollHeight: 0, clientHeight: 0, range: 0, clientBox: null, footerFlowAttribute: null, footerClearanceVar: '', readerMaxHeightVar: '', ...base }
  const box = dialog.getBoundingClientRect()
  const style = getComputedStyle(dialog)
  return {
    found: true, scrollTopExact: dialog.scrollTop, scrollHeight: dialog.scrollHeight, clientHeight: dialog.clientHeight, range: Math.max(0, dialog.scrollHeight - dialog.clientHeight),
    clientBox: { left: round(box.left + dialog.clientLeft), top: round(box.top + dialog.clientTop), right: round(box.left + dialog.clientLeft + dialog.clientWidth), bottom: round(box.top + dialog.clientTop + dialog.clientHeight), width: dialog.clientWidth, height: dialog.clientHeight },
    footerFlowAttribute: dialog.getAttribute('data-dialog-footer-flow'),
    footerClearanceVar: style.getPropertyValue('--dialog-footer-clearance').trim(),
    readerMaxHeightVar: style.getPropertyValue('--dialog-reader-max-height').trim(),
    ...base,
  }
}
export const dialogMetrics = (page: Page): Promise<DialogMetrics> => page.evaluate(dialogMetricsInPage)
/** Unrounded scrollTop of a scroller; the zero-offset prerequisite compares this with exactly 0. */
export const exactScrollTop = (scroller: Locator): Promise<number> => scroller.evaluate(element => element.scrollTop)
export const textareaSelection = (field: Locator) => field.evaluate(element => {
  const area = element as HTMLTextAreaElement
  return { start: area.selectionStart, end: area.selectionEnd, direction: area.selectionDirection, valueLength: area.value.length, scrollTop: Math.round(area.scrollTop * 100) / 100 }
})

export interface VisualRow { top: number; bottom: number; members: string[] }
export interface FooterRows {
  present: boolean
  rect: Box | null
  children: { descriptor: string; rect: Box; textRects: Box[] }[]
  /** Direct children grouped into visual rows by vertical overlap. */
  childRows: VisualRow[]
  /** Text fragments of each child grouped into visual rows; several fragments on one row are NOT wrapping. */
  textRowsPerChild: { descriptor: string; rows: number }[]
  totalTextRects: number
  wrapped: boolean
}

function footerRowsInPage(): FooterRows {
  const round = (value: number) => Math.round(value * 100) / 100
  const toBox = (rect: DOMRect): Box => ({ left: round(rect.left), top: round(rect.top), right: round(rect.right), bottom: round(rect.bottom), width: round(rect.width), height: round(rect.height) })
  const describe = (element: Element) => `${element.tagName.toLowerCase()}${Array.from(element.classList).slice(0, 4).map(name => `.${name}`).join('')}`
  const dialog = document.querySelector<HTMLDialogElement>('dialog[open]')
  const footer = dialog?.querySelector<HTMLElement>(':scope > .dialog-footer') ?? null
  if (!footer) return { present: false, rect: null, children: [], childRows: [], textRowsPerChild: [], totalTextRects: 0, wrapped: false }
  const group = (boxes: { box: Box; member: string }[]): VisualRow[] => {
    const sorted = boxes.slice().sort((a, b) => a.box.top - b.box.top || a.box.left - b.box.left)
    const rows: VisualRow[] = []
    for (const { box, member } of sorted) {
      const last = rows[rows.length - 1]
      if (last && Math.min(last.bottom, box.bottom) - Math.max(last.top, box.top) > Math.min(last.bottom - last.top, box.height) / 2) {
        last.top = Math.min(last.top, box.top); last.bottom = Math.max(last.bottom, box.bottom); last.members.push(member); continue
      }
      rows.push({ top: box.top, bottom: box.bottom, members: [member] })
    }
    return rows
  }
  const children: FooterRows['children'] = []
  let totalTextRects = 0
  for (const child of Array.from(footer.children)) {
    if (!child.getClientRects().length) continue
    const textRects: Box[] = []
    const walker = document.createTreeWalker(child, NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode(); node && textRects.length < 200; node = walker.nextNode()) {
      if (!(node.textContent ?? '').trim()) continue
      const range = document.createRange()
      range.selectNodeContents(node)
      for (const rect of Array.from(range.getClientRects())) if (rect.width > 0 && rect.height > 0) textRects.push(toBox(rect))
      range.detach()
    }
    totalTextRects += textRects.length
    children.push({ descriptor: describe(child), rect: toBox(child.getBoundingClientRect()), textRects })
  }
  const childRows = group(children.map(child => ({ box: child.rect, member: child.descriptor })))
  const textRowsPerChild = children.map(child => ({ descriptor: child.descriptor, rows: group(child.textRects.map((box, index) => ({ box, member: `${child.descriptor}#${index}` }))).length }))
  return {
    present: true, rect: toBox(footer.getBoundingClientRect()), children, childRows, textRowsPerChild, totalTextRects,
    wrapped: childRows.length >= 2 || textRowsPerChild.some(entry => entry.rows >= 2),
  }
}
export const footerRows = (page: Page): Promise<FooterRows> => page.evaluate(footerRowsInPage)

export const ROW_SUMMARY_SELECTOR = '.saved-import-row > details.saved-import-differences > summary'

export interface SurveyState {
  label: string
  /** Host-side integer order of survey states within one case. */
  order: number
  time: number
  metrics: DialogMetrics
  footer: FooterState
  footerRows: FooterRows
  archive: ElementPlacement
  message: ElementPlacement
  rowSummary: ElementPlacement
  recoveryConfirm: ElementPlacement
  /** footer.rect.top minus rowSummary.rect.bottom when both exist; the border-box gap a late insertion would have to close. */
  rowSummaryGapToFooter: number | null
}

/** Several sequential read-only evaluations; not one atomic instant (each field carries the page time of the metrics read). */
export async function surveyState(page: Page, label: string, order: number): Promise<SurveyState> {
  const metrics = await dialogMetrics(page)
  const footer = await footerState(page)
  const rows = await footerRows(page)
  const archive = await placement(page, '.saved-recovery-source')
  const message = await placement(page, '.saved-file-message')
  const rowSummary = await placement(page, ROW_SUMMARY_SELECTOR)
  const recoveryConfirm = await placement(page, '.saved-recovery-confirm')
  const gap = footer.rect && rowSummary.rect ? Math.round((footer.rect.top - rowSummary.rect.bottom) * 100) / 100 : null
  return { label, order, time: metrics.time, metrics, footer, footerRows: rows, archive, message, rowSummary, recoveryConfirm, rowSummaryGapToFooter: gap }
}

/* --------------------------------------------------------------------------
 * Semantic font references and the font-obligation ledger.
 * -------------------------------------------------------------------------- */

export interface SemanticReference {
  selector: string
  count: number
  sizes: number[]
  texts: string[]
  /** HTMLDetailsElement.open for details elements, else null. */
  open: (boolean | null)[]
  /** getClientRects().length > 0 at the read. */
  rendered: boolean[]
}

function semanticReferencesInPage(selectors: string[]): SemanticReference[] {
  const dialog = document.querySelector<HTMLDialogElement>('dialog[open]')
  return selectors.map(selector => {
    const elements = dialog ? Array.from(dialog.querySelectorAll(selector)) : []
    return {
      selector, count: elements.length,
      sizes: elements.map(element => Math.round((Number.parseFloat(getComputedStyle(element).fontSize) || 0) * 100) / 100),
      texts: elements.map(element => (element.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 40)),
      open: elements.map(element => element instanceof HTMLDetailsElement ? element.open : null),
      rendered: elements.map(element => element.getClientRects().length > 0),
    }
  })
}
export const semanticReferences = (page: Page, selectors: string[]): Promise<SemanticReference[]> => page.evaluate(semanticReferencesInPage, selectors)
/** The shape the existing applyFontReferences/fontReferenceMismatches helpers consume. */
export const toFontReferences = (references: SemanticReference[]): FontReference[] => references.map(reference => ({ selector: reference.selector, sizes: reference.sizes }))
/** Identity drift between a 100% reference read and a later read of the same selectors: count or text changes mean a different control, not the same one at 2×. */
export function referenceIdentityDrift(before: SemanticReference[], after: SemanticReference[]): string[] {
  const drift: string[] = []
  for (const reference of before) {
    const current = after.find(entry => entry.selector === reference.selector)
    if (!current) { drift.push(`${reference.selector}: not read back`); continue }
    if (current.count !== reference.count) drift.push(`${reference.selector}: ${reference.count} element(s) at reference time but ${current.count} now`)
    reference.texts.forEach((text, index) => { if (current.texts[index] !== undefined && current.texts[index] !== text) drift.push(`${reference.selector}[${index}]: text changed from "${text}" to "${current.texts[index]}"`) })
  }
  return drift
}

export type FontObligationState = 'verified' | 'mismatch' | 'deferred-hidden' | 'detached' | 'zero-reference' | 'dynamic-unreferenced' | 'unregistered-unknown-reference'
export interface FontObligation {
  index: number
  /** snapshot = recorded at 100% by snapshotFonts; dynamic = enrolled by an explicit applyFontReferences write; unregistered = a current dialog node in neither registry list (C4 census). */
  origin: 'snapshot' | 'dynamic' | 'unregistered'
  descriptor: string
  before: number | null
  now: number
  inline: string
  connected: boolean
  /** The node is the open dialog or one of its current descendants at this read. */
  inDialog: boolean
  rendering: 'rendered' | 'closed-details' | 'not-rendered' | 'detached'
  state: FontObligationState
}
export interface FontObligationCensus {
  dialogFound: boolean
  /** The open dialog plus every current descendant element, deduplicated by node identity. */
  currentNodes: number
  registeredSnapshotCurrent: number
  registeredDynamicCurrent: number
  /** Registered nodes (snapshot or dynamic) that are no longer inside the open dialog at this read. */
  registeredNotCurrent: number
  /** Current nodes in neither registry list: no 100% record, no explicit reference write, no readback. */
  unregisteredCurrent: number
}
export interface FontObligationLedger {
  registryPresent: boolean
  total: number
  counts: Record<FontObligationState, number>
  verified: number
  /** PARTIAL sum over registered obligations only: mismatch + deferred-hidden + detached. Never a completeness statement. */
  unmetRegistered: number
  /** COMPLETE nonverified total: total − verified. zero-reference, dynamic-unreferenced and unregistered-unknown-reference nodes are nonverified, not verified. */
  nonverifiedTotal: number
  census: FontObligationCensus
  /** Non-verified obligations first (unregistered included), then verified ones, up to the limit. */
  listed: FontObligation[]
  omitted: number
  limits: string
}

/**
 * Reads the authored-font fixture's in-page registry (window.__focus81Fonts, written by
 * snapshotFonts) without modifying it, and (C4) censuses the open dialog and ALL of its
 * current descendants, deduplicated by actual node identity against the snapshot list and
 * the registered dynamic list. Nodes in neither list (for example a completion message and
 * its icon created after the snapshot, or recreated footer nodes before their own reference
 * write) are listed as unregistered-unknown-reference. No font is written here.
 */
function fontObligationLedgerInPage(limit: number): FontObligationLedger {
  const describe = (element: Element) => `${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : ''}${Array.from(element.classList).slice(0, 4).map(name => `.${name}`).join('')}`
  const counts: Record<FontObligationState, number> = { verified: 0, mismatch: 0, 'deferred-hidden': 0, detached: 0, 'zero-reference': 0, 'dynamic-unreferenced': 0, 'unregistered-unknown-reference': 0 }
  const registry = Reflect.get(window, '__focus81Fonts') as { elements: Element[]; before: number[]; inline: string[]; dynamic: { element: Element; inline: string }[] } | undefined
  const dialog = document.querySelector<HTMLDialogElement>('dialog[open]')
  const current: Element[] = dialog ? [dialog, ...Array.from(dialog.querySelectorAll('*'))] : []
  const currentSet = new Set<Element>(current)
  const sizeOf = (element: Element) => Number.parseFloat(getComputedStyle(element).fontSize) || 0
  const inlineOf = (element: Element) => (element instanceof HTMLElement || element instanceof SVGElement) ? element.style.fontSize : ''
  const renderingOf = (element: Element): FontObligation['rendering'] => {
    if (!element.isConnected) return 'detached'
    const closed = element.closest('details:not([open])')
    if (closed && closed !== element) {
      const summary = closed.querySelector(':scope > summary')
      if (!(summary && (summary === element || summary.contains(element)))) return 'closed-details'
    }
    return element.getClientRects().length > 0 ? 'rendered' : 'not-rendered'
  }
  const obligations: FontObligation[] = []
  const registered = new Set<Element>()
  let registeredSnapshotCurrent = 0
  let registeredDynamicCurrent = 0
  if (registry) {
    registry.elements.forEach((element, index) => {
      registered.add(element)
      const inDialog = currentSet.has(element)
      if (inDialog) registeredSnapshotCurrent++
      const before = registry.before[index] ?? 0
      const now = sizeOf(element)
      const rendering = renderingOf(element)
      const state: FontObligationState = before <= 0 ? 'zero-reference' : rendering === 'detached' ? 'detached' : rendering !== 'rendered' ? 'deferred-hidden' : Math.abs(now - 2 * before) <= 0.1 ? 'verified' : 'mismatch'
      counts[state]++
      obligations.push({ index, origin: 'snapshot', descriptor: describe(element), before, now, inline: registry.inline[index] ?? '', connected: element.isConnected, inDialog, rendering, state })
    })
    registry.dynamic.forEach((entry, index) => {
      if (registered.has(entry.element)) return
      registered.add(entry.element)
      const inDialog = currentSet.has(entry.element)
      if (inDialog) registeredDynamicCurrent++
      const rendering = renderingOf(entry.element)
      const state: FontObligationState = rendering === 'detached' ? 'detached' : 'dynamic-unreferenced'
      counts[state]++
      obligations.push({ index, origin: 'dynamic', descriptor: describe(entry.element), before: null, now: sizeOf(entry.element), inline: entry.inline, connected: entry.element.isConnected, inDialog, rendering, state })
    })
  }
  let unregisteredCurrent = 0
  current.forEach((element, index) => {
    if (registered.has(element)) return
    unregisteredCurrent++
    counts['unregistered-unknown-reference']++
    obligations.push({ index, origin: 'unregistered', descriptor: describe(element), before: null, now: sizeOf(element), inline: inlineOf(element), connected: element.isConnected, inDialog: true, rendering: renderingOf(element), state: 'unregistered-unknown-reference' })
  })
  const ordered = [...obligations.filter(item => item.state !== 'verified'), ...obligations.filter(item => item.state === 'verified')]
  return {
    registryPresent: registry !== undefined, total: obligations.length, counts, verified: counts.verified,
    unmetRegistered: counts.mismatch + counts['deferred-hidden'] + counts.detached,
    nonverifiedTotal: obligations.length - counts.verified,
    census: {
      dialogFound: dialog !== null, currentNodes: current.length, registeredSnapshotCurrent, registeredDynamicCurrent,
      registeredNotCurrent: registered.size - registeredSnapshotCurrent - registeredDynamicCurrent, unregisteredCurrent,
    },
    listed: ordered.slice(0, limit), omitted: Math.max(0, ordered.length - limit),
    limits: 'Phase census of the open dialog and its current descendants at this read only; nodes created and removed between reads are not observed. Only verified means a rendered readback at exactly 2× the node\'s own 100% record. dynamic-unreferenced nodes have no snapshot record and are verifiable only through the separate semantic readbacks where a matching reference exists. unregistered-unknown-reference nodes have no 100% record, no reference write and no readback. unmetRegistered is a partial sum; nonverifiedTotal is the complete count of everything not verified. When the registry is absent (after restoreFonts) every current node is listed as unregistered.',
  }
}
export const fontObligationLedger = (page: Page, limit = 400): Promise<FontObligationLedger> => page.evaluate(fontObligationLedgerInPage, limit)

/* --------------------------------------------------------------------------
 * Diagnostic classification of the unchanged recorder's stream (not the verification ledger).
 * -------------------------------------------------------------------------- */

export type EdgeKind = 'owned-call' | 'quiet' | 'content-compensated' | 'clamp' | 'range-growth' | 'unexplained'
export interface RecorderEdge {
  from: number
  to: number
  fromRole: RecorderTuple['role']
  toRole: RecorderTuple['role']
  fromLabel: string | null
  toLabel: string | null
  ownedCall: string | null
  deltaOffset: number
  deltaContentTop: number | null
  deltaRange: number
  deltaClipTop: number | null
  deltaFooterTop: number | null
  coherent: boolean
  rightOccluded: boolean | null
  rightOverlapPx: number | null
  kind: EdgeKind
}
export interface RecorderEdgeSummary {
  note: string
  entries: number
  edges: RecorderEdge[]
  kinds: Record<EdgeKind, number>
  firstOccludedSequence: number | null
  clearedAfterOcclusion: boolean | null
  focusedThroughout: boolean
  sameEngagedThroughout: boolean
  integrity: string[]
}

/** Consecutive-tuple classification with interval deltas. Diagnostic labels only: 'content-compensated' means the offset change equals the engaged control's content shift (an anchoring-like compensation), it does not identify the writer. */
export function recorderEdgeSummary(snapshot: ScrollRouteSnapshot): RecorderEdgeSummary {
  const round = (value: number) => Math.round(value * 100) / 100
  type Entry = { tuple: RecorderTuple; call: string | null; end: 'pre' | 'post' | null; callSequence: number | null }
  const entries: Entry[] = snapshot.tuples.map(tuple => ({ tuple, call: null, end: null, callSequence: null }))
  const integrity: string[] = []
  for (const record of snapshot.records) {
    if (record.pre) entries.push({ tuple: record.pre, call: record.method, end: 'pre', callSequence: record.callSequence }); else integrity.push(`call ${record.callSequence} ${record.method} has no pre tuple`)
    if (record.post) entries.push({ tuple: record.post, call: record.method, end: 'post', callSequence: record.callSequence }); else integrity.push(`call ${record.callSequence} ${record.method} has no post tuple`)
  }
  entries.sort((left, right) => left.tuple.sequence - right.tuple.sequence)
  for (let index = 1; index < entries.length; index++) if (entries[index].tuple.sequence === entries[index - 1].tuple.sequence) integrity.push(`duplicate sequence ${entries[index].tuple.sequence}`)
  if (!snapshot.finalized) integrity.push('the recorder was not finalized')
  if (snapshot.nested > 0) integrity.push(`${snapshot.nested} nested recorded call(s)`)
  if (snapshot.overflow) integrity.push(`recorder overflow (${snapshot.dropped} dropped)`)
  for (const error of snapshot.errors) integrity.push(`recorder error: ${error}`)
  const kinds: Record<EdgeKind, number> = { 'owned-call': 0, quiet: 0, 'content-compensated': 0, clamp: 0, 'range-growth': 0, unexplained: 0 }
  const edges: RecorderEdge[] = []
  for (let index = 1; index < entries.length; index++) {
    const left = entries[index - 1]
    const right = entries[index]
    const a = left.tuple
    const b = right.tuple
    const deltaOffset = round(b.dialogScrollTop - a.dialogScrollTop)
    const deltaContentTop = a.engaged && b.engaged ? round(b.engaged.contentTop - a.engaged.contentTop) : null
    const deltaRange = round(b.range - a.range)
    const deltaClipTop = a.engaged && b.engaged ? round(b.engaged.clip.top - a.engaged.clip.top) : null
    const deltaFooterTop = a.footer && b.footer ? round(b.footer.top - a.footer.top) : null
    const owned = left.end === 'pre' && right.end === 'post' && left.callSequence !== null && left.callSequence === right.callSequence
    let kind: EdgeKind
    if (owned) kind = 'owned-call'
    else if (Math.abs(deltaOffset) <= 0.5) kind = 'quiet'
    else if (deltaContentTop !== null && Math.abs(deltaOffset - deltaContentTop) <= 0.5) kind = 'content-compensated'
    else if (a.dialogScrollTop > b.range + 0.5 && Math.abs(b.dialogScrollTop - b.range) <= 0.5) kind = 'clamp'
    else if (deltaRange > 0.5) kind = 'range-growth'
    else kind = 'unexplained'
    kinds[kind]++
    edges.push({
      from: a.sequence, to: b.sequence, fromRole: a.role, toRole: b.role, fromLabel: a.label, toLabel: b.label, ownedCall: owned ? left.call : null,
      deltaOffset, deltaContentTop, deltaRange, deltaClipTop, deltaFooterTop, coherent: a.coherent && b.coherent,
      rightOccluded: b.engaged ? b.engaged.occluded : null, rightOverlapPx: b.engaged ? b.engaged.overlapPx : null, kind,
    })
  }
  const occludedIndex = entries.findIndex(entry => entry.tuple.engaged?.occluded === true)
  const firstOccludedSequence = occludedIndex >= 0 ? entries[occludedIndex].tuple.sequence : null
  const clearedAfterOcclusion = occludedIndex >= 0 ? entries.slice(occludedIndex + 1).some(entry => entry.tuple.engaged !== null && !entry.tuple.engaged.occluded && entry.tuple.engaged.connected && entry.tuple.engaged.focused) : null
  const firstDescriptor = entries.find(entry => entry.tuple.engaged)?.tuple.engaged?.descriptor ?? null
  return {
    note: 'Diagnostic classification of consecutive recorder tuples by interval deltas; not the intent/lifecycle verification ledger; a no-call edge is native/unattributed until the combined measurements discriminate mechanisms.',
    entries: entries.length, edges, kinds, firstOccludedSequence, clearedAfterOcclusion,
    focusedThroughout: entries.every(entry => entry.tuple.engaged?.focused === true),
    sameEngagedThroughout: firstDescriptor !== null && entries.every(entry => entry.tuple.engaged?.descriptor === firstDescriptor),
    integrity,
  }
}

/** Occlusion evidence from the D2 frame probe, identical in meaning to the lifecycle spec's local predicate: occluded in at least one sampled frame before a later clear frame, focus kept throughout. */
export function occlusionEvidenceFromProbe(probe: FrameProbeResult) {
  const firstOccluded = probe.samples.findIndex(sample => sample.occluded)
  const clearedAfter = firstOccluded >= 0 && probe.samples.slice(firstOccluded).some(sample => !sample.occluded && sample.sameElement)
  const maxOverlap = probe.samples.reduce((most, sample) => Math.max(most, sample.overlapPx), 0)
  const focusKept = probe.samples.every(sample => sample.sameElement)
  return { frames: probe.samples.length, firstOccluded, clearedAfter, maxOverlap, focusKept }
}

/* --------------------------------------------------------------------------
 * Actual DOM node identity witnesses and the B3 atomic release gate (C3/C5).
 * -------------------------------------------------------------------------- */

/** A handle to the actual node: object identity across evaluations, which a descriptor, label, count or first-match selector position never establishes. */
export type NodeHandle = ElementHandle<Element>

/** The current document.activeElement as a handle to the actual node. Throws when there is no active element. Read-only; nothing is focused. */
export async function activeElementHandle(page: Page): Promise<NodeHandle> {
  return page.evaluateHandle(() => {
    const node = document.activeElement
    if (!(node instanceof Element)) throw new Error('no active element to capture')
    return node
  })
}

export interface NodeIdentityFacts {
  descriptor: string
  connected: boolean
  /** node === document.activeElement at this read. */
  isActive: boolean
  /** node === window.__focus81Engaged (the timing helper's marker) at this read. */
  isMarkedEngaged: boolean
  inOpenDialog: boolean
}
export const nodeIdentityFacts = (handle: NodeHandle): Promise<NodeIdentityFacts> => handle.evaluate(node => ({
  descriptor: `${node.tagName.toLowerCase()}${node.id ? `#${node.id}` : ''}${Array.from(node.classList).slice(0, 4).map(name => `.${name}`).join('')}`,
  connected: node.isConnected,
  isActive: node === document.activeElement,
  isMarkedEngaged: node === Reflect.get(window, '__focus81Engaged'),
  inOpenDialog: node.closest('dialog[open]') !== null,
}))

export interface ReaderFontFacts extends NodeIdentityFacts {
  computedFontSizePx: number
  inlineFontSize: string
  /** The node's place in the authored-font fixture registry at this read (read-only): snapshot with its 100% record, dynamic (enrolled by an explicit reference write), none, or no registry installed. */
  registry: { kind: 'snapshot'; before: number } | { kind: 'dynamic' } | { kind: 'none' } | { kind: 'no-registry' }
  /** Index of this node among the open dialog's current matches of `selector` (so its own semantic 100% reference is addressable), or -1. */
  selectorIndex: number
  /** The node's enclosing <details> has the captured summary node as its own direct summary; null when no summary node was supplied. */
  underCapturedSummary: boolean | null
}
/** Read-only facts about the SAME reader node (by handle), not about whichever node currently matches a label or selector. */
export const readerFontFacts = (reader: NodeHandle, summary: NodeHandle | null, selector: string): Promise<ReaderFontFacts> => reader.evaluate((node, { summary, selector }) => {
  const registry = Reflect.get(window, '__focus81Fonts') as { elements: Element[]; before: number[]; dynamic: { element: Element }[] } | undefined
  const snapshotIndex = registry ? registry.elements.indexOf(node) : -1
  const registryFacts: ReaderFontFacts['registry'] = !registry ? { kind: 'no-registry' }
    : snapshotIndex >= 0 ? { kind: 'snapshot', before: registry.before[snapshotIndex] ?? 0 }
    : registry.dynamic.some(entry => entry.element === node) ? { kind: 'dynamic' } : { kind: 'none' }
  const dialog = node.closest('dialog[open]')
  const details = node.closest('details')
  const ownSummary = details ? details.querySelector(':scope > summary') : null
  return {
    descriptor: `${node.tagName.toLowerCase()}${node.id ? `#${node.id}` : ''}${Array.from(node.classList).slice(0, 4).map(name => `.${name}`).join('')}`,
    connected: node.isConnected, isActive: node === document.activeElement, isMarkedEngaged: node === Reflect.get(window, '__focus81Engaged'), inOpenDialog: dialog !== null,
    computedFontSizePx: Math.round((Number.parseFloat(getComputedStyle(node).fontSize) || 0) * 100) / 100,
    inlineFontSize: node instanceof HTMLElement || node instanceof SVGElement ? node.style.fontSize : '',
    registry: registryFacts,
    selectorIndex: dialog ? Array.from(dialog.querySelectorAll(selector)).indexOf(node) : -1,
    underCapturedSummary: summary ? ownSummary === summary : null,
  }
}, { summary, selector })

export interface HoldSnapshot { completed: number; delivered: number; queued: number }
/** Written in-page immediately BEFORE the release call, so an attempt survives even if the evaluation itself throws afterwards. */
export interface B3ReleaseMarker { attempted: boolean; attemptedAt: number; released: boolean; error: string | null }
export interface ZeroOffsetGateInput { row: NodeHandle; t0: RecorderTuple; engagedSource: 'marker' | 'active' | 'none'; label: string; rowSelector: string }
export interface ZeroOffsetGateResult {
  /** The fresh public recorder tuple read FIRST in this evaluation; it also enters the recorder stream as a host sample with the given label. */
  boundary: RecorderTuple | null
  /** dialog.scrollTop as read in this evaluation, unrounded. */
  rawScrollTop: number | null
  identity: { rowsMatching: number; firstMatchIsRow: boolean; rowIsActive: boolean; rowIsMarkedEngaged: boolean; rowConnected: boolean; rowInOpenDialog: boolean; recorderEngagedSource: string }
  /** T0 is the recorder's retained baseline tuple: its offset is ROUNDED (0.01) and is never a raw exact-zero reading; a contradictory T0 disqualifies the release. */
  t0Checks: { roundedOffsetZero: boolean; engagedPresent: boolean; connected: boolean; proxyConnected: boolean; focused: boolean; positiveFinite: boolean; paintInsideClip: boolean; notOccluded: boolean; coherent: boolean; descriptorMatchesBoundary: boolean }
  boundaryChecks: { present: boolean; coherent: boolean; engagedPresent: boolean; connected: boolean; proxyConnected: boolean; focused: boolean; positiveFinite: boolean; paintInsideClip: boolean; notOccluded: boolean; rawScrollTopExactlyZero: boolean }
  reasons: string[]
  met: boolean
  holdPresent: boolean
  holdBefore: HoldSnapshot | null
  /** True as soon as the release call is decided, BEFORE it runs; a thrown or partially delivered release is attempted:true, released:false with releaseError. */
  attempted: boolean
  released: boolean
  releaseError: string | null
  holdAfter: HoldSnapshot | null
  note: string
}

/**
 * C3: ONE synchronous page evaluation that (1) samples the unchanged recorder's public
 * tuple at the release boundary, (2) rechecks the SAME row node by object identity
 * (unique selector match, document.activeElement, engaged marker), the raw unrounded
 * dialog.scrollTop and the retained T0 facts, and (3) invokes the SAME test-owned
 * __undo80CompletionHold.release (saved-removal-undo.ts) only when every gate holds.
 * No host await separates the decision from the release. Nothing is focused or
 * scrolled; no product-private state is read; the recorder and hold helpers are unchanged.
 */
export async function atomicZeroOffsetRelease(page: Page, input: ZeroOffsetGateInput): Promise<ZeroOffsetGateResult> {
  return page.evaluate(({ row, t0, engagedSource, label, rowSelector }) => {
    const reasons: string[] = []
    const recorder = Reflect.get(window, '__focus81ScrollRoutes') as { sample: (role: 'host' | 'verdict', label: string) => RecorderTuple } | undefined
    const hold = Reflect.get(window, '__undo80CompletionHold') as { snapshot: () => HoldSnapshot; release: () => void } | undefined
    const dialog = document.querySelector<HTMLDialogElement>('dialog[open]')
    let boundary: RecorderTuple | null = null
    if (recorder) {
      try { boundary = recorder.sample('host', label) } catch (error) { reasons.push(`boundary sample failed: ${error instanceof Error ? error.message : String(error)}`) }
    } else reasons.push('the scroll-route recorder is not installed')
    const rawScrollTop = dialog ? dialog.scrollTop : null
    const rows = dialog ? Array.from(dialog.querySelectorAll(rowSelector)) : []
    const identity = {
      rowsMatching: rows.length, firstMatchIsRow: rows[0] === row, rowIsActive: document.activeElement === row,
      rowIsMarkedEngaged: Reflect.get(window, '__focus81Engaged') === row, rowConnected: row.isConnected,
      rowInOpenDialog: dialog !== null && dialog.contains(row), recorderEngagedSource: engagedSource,
    }
    if (rows.length !== 1) reasons.push(`${rows.length} row disclosure summaries match (expected exactly 1)`)
    if (!identity.firstMatchIsRow) reasons.push('the matching row disclosure is not the same node captured at load')
    if (!identity.rowIsActive) reasons.push('the captured row node is not document.activeElement')
    if (!identity.rowIsMarkedEngaged) reasons.push('the engaged marker is not the captured row node')
    if (!identity.rowConnected) reasons.push('the captured row node is disconnected')
    if (!identity.rowInOpenDialog) reasons.push('the captured row node is not inside the open dialog')
    if (engagedSource !== 'marker') reasons.push(`the recorder measured its ${engagedSource} element, not the marked row`)
    const e0 = t0.engaged
    const eb = boundary ? boundary.engaged : null
    const t0Checks = {
      roundedOffsetZero: t0.dialogScrollTop === 0, engagedPresent: e0 !== null, connected: e0 !== null && e0.connected, proxyConnected: e0 !== null && e0.proxyConnected, focused: e0 !== null && e0.focused,
      positiveFinite: e0 !== null && e0.positiveFinite, paintInsideClip: e0 !== null && e0.paintInsideClip, notOccluded: e0 !== null && !e0.occluded, coherent: t0.coherent,
      descriptorMatchesBoundary: e0 !== null && eb !== null && e0.descriptor === eb.descriptor,
    }
    for (const [name, ok] of Object.entries(t0Checks)) if (!ok) reasons.push(`T0 contradicts the prerequisite: ${name}`)
    const boundaryChecks = {
      present: boundary !== null, coherent: boundary !== null && boundary.coherent, engagedPresent: eb !== null, connected: eb !== null && eb.connected, proxyConnected: eb !== null && eb.proxyConnected, focused: eb !== null && eb.focused,
      positiveFinite: eb !== null && eb.positiveFinite, paintInsideClip: eb !== null && eb.paintInsideClip, notOccluded: eb !== null && !eb.occluded, rawScrollTopExactlyZero: rawScrollTop === 0,
    }
    for (const [name, ok] of Object.entries(boundaryChecks)) if (!ok) reasons.push(`boundary: ${name}`)
    if (!hold) reasons.push('the test-owned completion hold is not installed')
    const met = reasons.length === 0
    let holdBefore: HoldSnapshot | null = null
    try { holdBefore = hold ? hold.snapshot() : null } catch (error) { reasons.push(`hold snapshot failed: ${error instanceof Error ? error.message : String(error)}`) }
    let attempted = false
    let released = false
    let releaseError: string | null = null
    let holdAfter: HoldSnapshot | null = null
    if (met && hold) {
      attempted = true
      const marker: B3ReleaseMarker = { attempted: true, attemptedAt: performance.now(), released: false, error: null }
      Reflect.set(window, '__diag81B3Release', marker)
      try { hold.release(); released = true } catch (error) { releaseError = error instanceof Error ? `${error.name}: ${error.message}` : String(error) }
      marker.released = released
      marker.error = releaseError
      try { holdAfter = hold.snapshot() } catch (error) { reasons.push(`post-release hold snapshot failed: ${error instanceof Error ? error.message : String(error)}`) }
    }
    const result: ZeroOffsetGateResult = {
      boundary, rawScrollTop, identity, t0Checks, boundaryChecks, reasons, met, holdPresent: hold !== undefined, holdBefore, attempted, released, releaseError, holdAfter,
      note: 'One synchronous evaluation: boundary sample, same-node identity, raw scrollTop, retained T0 facts, gate, attempted marker, then the same test-owned __undo80CompletionHold.release. T0 offset is rounded (0.01) and is a retained baseline fact, not a raw zero reading. A coherent raw zero here does not rule out queued native anchoring or later movement; reading geometry flushes layout.',
    }
    return result
  }, { row: input.row, t0: input.t0, engagedSource: input.engagedSource, label: input.label, rowSelector: input.rowSelector })
}

/** The in-page attempted-release marker written before the release call; recoverable even when the gate evaluation threw afterwards. */
export const readB3ReleaseMarker = (page: Page): Promise<B3ReleaseMarker | null> => page.evaluate(() => (Reflect.get(window, '__diag81B3Release') as B3ReleaseMarker | undefined) ?? null)

/* --------------------------------------------------------------------------
 * Host-side phase marks and failure-safe cleanup bookkeeping.
 * -------------------------------------------------------------------------- */

export interface PhaseMark { order: number; label: string; pageTime: number | null; hostTime: number }
/** Host-side integer order of phases; the page time is read separately and may tie or fail (null), it is never an ordering key. */
export class PhaseLog {
  readonly marks: PhaseMark[] = []
  async mark(page: Page, label: string): Promise<PhaseMark> {
    let pageTime: number | null = null
    try { pageTime = await page.evaluate(() => Math.round(performance.now() * 100) / 100) } catch { pageTime = null }
    const mark = { order: this.marks.length + 1, label, pageTime, hostTime: Date.now() }
    this.marks.push(mark)
    return mark
  }
}

export interface CleanupStep { order: number; step: string; ok: boolean; error: string | null; detail: unknown }
/** Every cleanup action runs in its own try/catch; a failure is recorded and never suppresses the test body's original error or the remaining steps. */
export class CleanupLedger {
  readonly steps: CleanupStep[] = []
  async run<T>(step: string, action: () => Promise<T>): Promise<T | null> {
    try {
      const detail = await action()
      this.steps.push({ order: this.steps.length + 1, step, ok: true, error: null, detail: detail ?? null })
      return detail
    } catch (error) {
      this.steps.push({ order: this.steps.length + 1, step, ok: false, error: error instanceof Error ? `${error.name}: ${error.message}` : String(error), detail: null })
      return null
    }
  }
}

/** Attach through the ledger; an attachment failure is recorded as a step and surfaced as an annotation (annotations cannot throw). */
export async function attachSafely(testInfo: TestInfo, name: string, body: unknown, ledger: CleanupLedger) {
  await ledger.run(`attach:${name}`, async () => { await testInfo.attach(name, { body: JSON.stringify(body, null, 2), contentType: 'application/json' }); return name })
  const last = ledger.steps[ledger.steps.length - 1]
  if (last && !last.ok) testInfo.annotations.push({ type: 'diag81-attach-failed', description: `${name}: ${last.error}` })
}
