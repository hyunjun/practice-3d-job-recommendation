/**
 * Stage81 D2 scroll-route recorder: a scoped, test-only read-through recorder at
 * the PUBLIC DOM scrolling entry points that can move the open dialog's own
 * scroller, with ONE rich public-geometry sampler and ONE integer order for every
 * observation it produces (docs/design/dialog-focus-visibility.md, D2 candidate
 * 01, SHA256 4f9f5cb4…). Labeled attribution instrumentation for the three TR1
 * consumers in the intent spec; not a general browser instrumentation framework.
 *
 * Install (one evaluation): the nine public routes are wrapped transactionally
 * (if any wrapper cannot be installed, the wrappers already installed are
 * restored and the failure is thrown), the baseline tuple T0 is read and stamped,
 * and, when requested, a recorder-owned read-only requestAnimationFrame sampler
 * is started under a frame ceiling. Every wrapper forwards the ORIGINAL primitive
 * synchronously, exactly once, with the same receiver, arguments, return value
 * and exception, and records one tuple immediately before and one immediately
 * after the call. Host evaluations add labeled tuples (paused-Clock samples, the
 * verdict tuple Tj). Finalize (one evaluation): the sampler is cancelled, the
 * final tuple Tf is read and stamped, every tuple and record is collected, and
 * every original descriptor is restored in reverse order. A second finalize finds
 * nothing installed and returns null, so the first restoration result is the one
 * that is kept.
 *
 * The sampler reads layout first (the dialog's rectangle, which flushes layout),
 * then offsets and range, the engaged control through its visible proxy (a
 * checkbox's bound track, otherwise the control itself), its painted indicator
 * and available clip (dialog client box ∩ viewport ∩ overflow-clipped ancestors,
 * above a sticky footer that does not contain it), the footer, the viewport and
 * window scroll, identity and frame witnesses; it then re-reads the facts a
 * causal statement relies on and reports `coherent` with the list of facts that
 * changed. The integer `sequence` is allocated LAST, after the complete
 * synchronous read; performance.now() is diagnostic only. Coherence establishes
 * exactly this: within that one synchronous evaluation the rechecked facts did
 * not change. It does not establish that the first read did not itself end a
 * scroll-anchoring suppression window, and it says nothing about the time
 * between evaluations. Scale is the measured public ratio of the dialog's
 * rendered height to its offsetHeight and is reported as read.
 *
 * What it does not do: suppress, delay, repeat or replace any scroll; change
 * anchoring, styles or focus; read product private state; or supply expected
 * movement. Argument diagnostics are primitive values or typeof labels only; no
 * object, array or proxy is enumerated. Bookkeeping is guarded so it can never
 * replace the native result or exception (its own failures are recorded as
 * evidence failures). A nested recorded call is recorded with its depth and is
 * never filtered away; the spec fails closed on it. Geometry reads inside a call
 * flush layout and may end a pending scroll-anchoring suppression window; that is
 * part of the instrumentation's unexecuted transparency prerequisites.
 */
import type { Page } from '@playwright/test'

export interface RouteBox { left: number; top: number; right: number; bottom: number; width: number; height: number }
export type TupleRole = 'baseline' | 'frame' | 'host' | 'verdict' | 'call-pre' | 'call-post' | 'final'
export type RouteRelevance = 'dialog' | 'descendant' | 'ancestor' | 'other'

/** The engaged control's public facts, measured through its visible proxy. */
export interface EngagedFacts {
  descriptor: string
  connected: boolean
  /** document.activeElement is the engaged control itself (semantic focus stays on the input for a checkbox). */
  focused: boolean
  proxyDescriptor: string
  proxyConnected: boolean
  /** Border box of the measured proxy. */
  rect: RouteBox
  /** Border box expanded by the painted indicator (outline width + offset, or box-shadow spread). */
  paint: RouteBox
  /** Available clip: dialog client box ∩ viewport ∩ overflow-clipped ancestors, above a sticky footer that does not contain the control. */
  clip: RouteBox
  paintInsideClip: boolean
  /** Border-box overlap with the dialog client edges or the sticky footer; the same measure the D2 frame probe records. */
  overlapPx: number
  occluded: boolean
  /** Control top in the dialog's scroll-content coordinates: (rect.top − client.top) / scale + scrollTop, from this tuple's own origin. */
  contentTop: number
  positiveFinite: boolean
}

/** One coherent synchronous reading; the shape shared by T0, frame samples, host samples, Tj, call pre/post and Tf. */
export interface RecorderTuple {
  /** Recorder-owned integer order, allocated after the complete read. */
  sequence: number
  role: TupleRole
  label: string | null
  /** performance.now() when the read completed; diagnostic only, never an ordering key. */
  time: number
  /** Index of a recorder-owned frame sample; null for every other role. */
  frame: number | null
  /** Test-owned frame opportunities delivered (timing helper counter) when read; 0 when no counter is armed. */
  frameOpportunities: number
  /** The saved-removal-undo one-shot frame sentinel's state when read; null when none is queued. */
  sentinelFired: boolean | null
  dialogConnected: boolean
  dialogRect: RouteBox | null
  dialogClient: RouteBox | null
  dialogScrollTop: number
  dialogScrollLeft: number
  dialogScrollHeight: number
  dialogClientHeight: number
  range: number
  /** Measured public ratio rect.height / offsetHeight; 1 when no box. */
  scale: number
  /** |rect.height − offsetHeight| as read, diagnostic for offsetHeight rounding. */
  offsetHeightDelta: number
  viewport: { width: number; height: number }
  windowScroll: { x: number; y: number }
  footer: { top: number; bottom: number; height: number; position: string; containsEngaged: boolean } | null
  engaged: EngagedFacts | null
  /** True when every rechecked fact (dialog top/height, scrollTop, scrollHeight, clientHeight, window scroll, proxy top/bottom, footer top) was unchanged within this evaluation. */
  coherent: boolean
  incoherentFacts: string[]
}

export interface ScrollRouteRecord {
  /** Integer allocated when the call began, before its pre tuple. */
  callSequence: number
  /** Integer allocated after its post tuple. */
  endSequence: number
  parent: number | null
  depth: number
  method: string
  receiver: string
  relevance: RouteRelevance
  /** Primitive argument values or typeof labels; nothing is enumerated. */
  args: (string | number | boolean | null)[]
  threw: boolean
  pre: RecorderTuple | null
  post: RecorderTuple | null
  /** Recorder bookkeeping failure for this call, if any; the native call itself was not affected. */
  error: string | null
}

export interface ScrollRouteSnapshot {
  installed: boolean
  finalized: boolean
  wrapped: string[]
  /** Labels restored at finalization, in restoration (reverse) order. */
  restored: string[]
  engaged: string
  engagedSource: 'marker' | 'active' | 'none'
  dialog: string
  /** External tuples in reading order: T0, frame samples, host samples, Tj, Tf. Call tuples live on their records. */
  tuples: RecorderTuple[]
  records: ScrollRouteRecord[]
  /** Recorded calls that began while another recorded call was still running. */
  nested: number
  overflow: boolean
  dropped: number
  errors: string[]
  sampler: { requested: number; delivered: number; active: boolean }
  sequence: number
}

export interface RecorderInstall { wrapped: string[]; engaged: string; engagedSource: ScrollRouteSnapshot['engagedSource']; dialog: string; baseline: RecorderTuple }

interface RecorderOptions { frameSamples: number; maxTuples: number; maxRecords: number }
interface RecorderControl {
  sample: (role: 'host' | 'verdict', label: string) => RecorderTuple
  snapshot: () => ScrollRouteSnapshot
  finalize: () => ScrollRouteSnapshot
}

/** The nine public routes the recorder must wrap for its coverage claim to hold; a spec asserts the installed list equals this. */
export const SCROLL_ROUTES = ['Element.scrollTo', 'Element.scroll', 'Element.scrollBy', 'Element.scrollTop=', 'Element.scrollIntoView', 'HTMLElement.focus', 'window.scrollTo', 'window.scroll', 'window.scrollBy'] as const

function installScrollRouteRecorderInPage(options: RecorderOptions): RecorderInstall {
  if (Reflect.get(window, '__focus81ScrollRoutes')) throw new Error('the scroll-route recorder is already installed')
  const round = (value: number) => Math.round(value * 100) / 100
  const toBox = (box: { left: number; top: number; right: number; bottom: number }): RouteBox => ({ left: round(box.left), top: round(box.top), right: round(box.right), bottom: round(box.bottom), width: round(box.right - box.left), height: round(box.bottom - box.top) })
  const describe = (node: unknown) => node === window ? 'window' : node === document ? 'document' : node instanceof Element ? `${node.tagName.toLowerCase()}${node.id ? `#${node.id}` : ''}${Array.from(node.classList).slice(0, 3).map(name => `.${name}`).join('')}` : node === null ? 'null' : typeof node
  const dialog = document.querySelector<HTMLDialogElement>('dialog[open]')
  const marked = Reflect.get(window, '__focus81Engaged') as HTMLElement | undefined
  const active = document.activeElement
  const engaged: HTMLElement | null = marked ?? (active instanceof HTMLElement && active !== document.body ? active : null)
  const engagedSource: RecorderInstall['engagedSource'] = marked ? 'marker' : engaged ? 'active' : 'none'
  // D2: a checkbox's real control is its rendered track; focus and checkbox semantics stay on the input.
  const proxyOf = (element: HTMLElement): Element => {
    const track = element instanceof HTMLInputElement && element.type === 'checkbox' && element.parentElement?.classList.contains('toggle-row') ? element.parentElement.querySelector<HTMLElement>('.toggle-track') : null
    return track ?? element
  }
  interface Original { owner: object; name: string; label: string; descriptor: PropertyDescriptor }
  const state = { sequence: 0, tuples: [] as RecorderTuple[], records: [] as ScrollRouteRecord[], stack: [] as number[], nested: 0, overflow: false, dropped: 0, errors: [] as string[], originals: [] as Original[], installed: false, finalized: false }
  const sampler = { requested: options.frameSamples, delivered: 0, active: false, handle: null as number | null }
  let wrapped: string[] = []
  let restored: string[] = []
  const next = () => ++state.sequence
  const paintExtent = (element: Element) => {
    const style = getComputedStyle(element)
    const outline = style.outlineStyle === 'none' ? 0 : Math.max(0, (Number.parseFloat(style.outlineWidth) || 0) + (Number.parseFloat(style.outlineOffset) || 0))
    const shadow = /(-?[\d.]+)px\s+(-?[\d.]+)px\s+(-?[\d.]+)px\s+(-?[\d.]+)px/.exec(style.boxShadow)
    const spread = shadow ? Math.max(0, Number.parseFloat(shadow[4])) : 0
    return Math.max(outline, spread)
  }
  /** The one rich sampler. Layout first, then everything a causal statement relies on, then the coherence re-read, then the stamp. */
  const readTuple = (role: TupleRole, label: string | null, frame: number | null): RecorderTuple => {
    const facts: string[] = []
    const d = dialog !== null && dialog.isConnected ? dialog : null
    const rect = d ? d.getBoundingClientRect() : null
    const scrollTop = d ? d.scrollTop : Number.NaN
    const scrollLeft = d ? d.scrollLeft : Number.NaN
    const scrollHeight = d ? d.scrollHeight : 0
    const clientHeight = d ? d.clientHeight : 0
    const clientWidth = d ? d.clientWidth : 0
    const offsetHeight = d ? d.offsetHeight : 0
    const scale = rect && offsetHeight > 0 ? rect.height / offsetHeight : 1
    const client = d && rect ? { left: rect.left + d.clientLeft * scale, top: rect.top + d.clientTop * scale, right: rect.left + d.clientLeft * scale + clientWidth * scale, bottom: rect.top + d.clientTop * scale + clientHeight * scale } : null
    const footer = d ? d.querySelector<HTMLElement>(':scope > .dialog-footer') : null
    const footerBox = footer?.getBoundingClientRect() ?? null
    const footerPosition = footer ? getComputedStyle(footer).position : null
    const footerContains = footer !== null && engaged !== null && footer.contains(engaged)
    let engagedFacts: EngagedFacts | null = null
    let proxyRect: DOMRect | null = null
    if (engaged && client) {
      const proxy = proxyOf(engaged)
      proxyRect = proxy.getBoundingClientRect()
      const box = proxyRect
      const proxyConnected = proxy.isConnected
      const extent = proxyConnected ? paintExtent(proxy) : 0
      let clip = { left: Math.max(client.left, 0), top: Math.max(client.top, 0), right: Math.min(client.right, document.documentElement.clientWidth), bottom: Math.min(client.bottom, document.documentElement.clientHeight) }
      for (let ancestor = proxy.parentElement; ancestor && ancestor !== d && ancestor !== document.body; ancestor = ancestor.parentElement) {
        const style = getComputedStyle(ancestor)
        if (style.overflowX === 'visible' && style.overflowY === 'visible') continue
        const ancestorRect = ancestor.getBoundingClientRect()
        const left = ancestorRect.left + ancestor.clientLeft * scale
        const top = ancestorRect.top + ancestor.clientTop * scale
        if (style.overflowX !== 'visible') { clip.left = Math.max(clip.left, left); clip.right = Math.min(clip.right, left + ancestor.clientWidth * scale) }
        if (style.overflowY !== 'visible') { clip.top = Math.max(clip.top, top); clip.bottom = Math.min(clip.bottom, top + ancestor.clientHeight * scale) }
      }
      const stickyLimit = footerBox && footerPosition === 'sticky' && !footerContains ? footerBox.top : null
      if (stickyLimit !== null && footerBox && footerBox.right > box.left && footerBox.left < box.right) clip = { ...clip, bottom: Math.min(clip.bottom, stickyLimit) }
      const paint = { left: box.left - extent, top: box.top - extent, right: box.right + extent, bottom: box.bottom + extent }
      const inside = paint.top >= clip.top - 0.5 && paint.bottom <= clip.bottom + 0.5 && paint.left >= clip.left - 0.5 && paint.right <= clip.right + 0.5
      const limit = stickyLimit === null ? client.bottom : Math.min(client.bottom, stickyLimit)
      const overlap = Math.max(0, box.bottom - limit, client.top - box.top)
      const numbers = [box.left, box.top, box.right, box.bottom, paint.left, paint.top, paint.right, paint.bottom, clip.left, clip.top, clip.right, clip.bottom, scrollTop, scale]
      engagedFacts = {
        descriptor: describe(engaged), connected: engaged.isConnected, focused: document.activeElement === engaged,
        proxyDescriptor: describe(proxy), proxyConnected,
        rect: toBox(box), paint: toBox(paint), clip: toBox(clip), paintInsideClip: inside && proxyConnected,
        overlapPx: round(overlap), occluded: overlap > 0.5 || !engaged.isConnected,
        contentTop: round((box.top - client.top) / scale + scrollTop),
        positiveFinite: box.width > 0 && box.height > 0 && numbers.every(Number.isFinite),
      }
    }
    const viewport = { width: document.documentElement.clientWidth, height: document.documentElement.clientHeight }
    const windowScroll = { x: window.scrollX, y: window.scrollY }
    const counter = Reflect.get(window, '__focus81FrameCounter') as { fired: number } | undefined
    const sentinel = Reflect.get(window, '__undo80FrameProbe') as { fired: boolean } | undefined
    // Coherence re-read of the facts a causal statement relies on; the first dialog read above is the layout boundary.
    if (d && rect) {
      const again = d.getBoundingClientRect()
      if (Math.abs(again.top - rect.top) > 0.01) facts.push('dialog.top')
      if (Math.abs(again.height - rect.height) > 0.01) facts.push('dialog.height')
      if (Math.abs(d.scrollTop - scrollTop) > 0.01) facts.push('dialog.scrollTop')
      if (d.scrollHeight !== scrollHeight) facts.push('dialog.scrollHeight')
      if (d.clientHeight !== clientHeight) facts.push('dialog.clientHeight')
    }
    if (Math.abs(window.scrollX - windowScroll.x) > 0.01 || Math.abs(window.scrollY - windowScroll.y) > 0.01) facts.push('window.scroll')
    if (engaged && proxyRect) {
      const again = proxyOf(engaged).getBoundingClientRect()
      if (Math.abs(again.top - proxyRect.top) > 0.01 || Math.abs(again.bottom - proxyRect.bottom) > 0.01) facts.push('engaged.rect')
    }
    if (footer && footerBox && Math.abs(footer.getBoundingClientRect().top - footerBox.top) > 0.01) facts.push('footer.top')
    return {
      sequence: next(), role, label, time: round(performance.now()), frame,
      frameOpportunities: counter?.fired ?? 0, sentinelFired: sentinel ? sentinel.fired : null,
      dialogConnected: d !== null, dialogRect: rect ? toBox(rect) : null, dialogClient: client ? toBox(client) : null,
      dialogScrollTop: round(scrollTop), dialogScrollLeft: round(scrollLeft), dialogScrollHeight: scrollHeight, dialogClientHeight: clientHeight,
      range: Math.max(0, scrollHeight - clientHeight), scale: Math.round(scale * 10000) / 10000, offsetHeightDelta: rect ? round(Math.abs(rect.height - offsetHeight)) : Number.NaN,
      viewport, windowScroll: { x: round(windowScroll.x), y: round(windowScroll.y) },
      footer: footer && footerBox ? { top: round(footerBox.top), bottom: round(footerBox.bottom), height: round(footerBox.height), position: footerPosition ?? '', containsEngaged: footerContains } : null,
      engaged: engagedFacts, coherent: facts.length === 0, incoherentFacts: facts,
    }
  }
  const keep = (tuple: RecorderTuple) => {
    if (state.tuples.length < options.maxTuples) state.tuples.push(tuple)
    else { state.overflow = true; state.dropped++ }
  }
  const relevance = (receiver: unknown): RouteRelevance => {
    if (receiver === window || receiver === document || receiver === document.documentElement || receiver === document.body) return 'ancestor'
    if (dialog && receiver === dialog) return 'dialog'
    if (dialog && receiver instanceof Node && dialog.contains(receiver)) return 'descendant'
    return 'other'
  }
  /** Diagnostics only: primitives are kept, everything else is a typeof label; nothing is enumerated or evaluated. */
  const diagnostic = (value: unknown): string | number | boolean | null => value === null ? null : typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean' ? value : typeof value
  interface Entry { callSequence: number; parent: number | null; depth: number; method: string; receiver: string; relevance: RouteRelevance; args: ScrollRouteRecord['args']; pre: RecorderTuple | null; error: string | null; pushed: boolean }
  const begin = (method: string, receiver: unknown, args: unknown[]): Entry => {
    const entry: Entry = { callSequence: 0, parent: null, depth: 0, method, receiver: 'unknown', relevance: 'other', args: [], pre: null, error: null, pushed: false }
    try {
      entry.callSequence = next()
      entry.parent = state.stack.length ? state.stack[state.stack.length - 1] : null
      entry.depth = state.stack.length
      if (entry.depth > 0) state.nested++
      entry.receiver = describe(receiver)
      entry.relevance = relevance(receiver)
      entry.args = args.map(diagnostic)
      entry.pre = readTuple('call-pre', method, null)
      state.stack.push(entry.callSequence)
      entry.pushed = true
    } catch (error) {
      entry.error = `begin: ${String(error)}`
      state.errors.push(`${method}: ${entry.error}`)
    }
    return entry
  }
  const complete = (entry: Entry, threw: boolean) => {
    try {
      let post: RecorderTuple | null = null
      try { post = readTuple('call-post', entry.method, null) } catch (error) { entry.error = `${entry.error ?? ''} post: ${String(error)}`.trim() }
      if (entry.pushed) state.stack.pop()
      const record: ScrollRouteRecord = { callSequence: entry.callSequence, endSequence: next(), parent: entry.parent, depth: entry.depth, method: entry.method, receiver: entry.receiver, relevance: entry.relevance, args: entry.args, threw, pre: entry.pre, post, error: entry.error }
      if (state.records.length < options.maxRecords) state.records.push(record)
      else { state.overflow = true; state.dropped++ }
    } catch (error) {
      state.errors.push(`${entry.method}: complete: ${String(error)}`)
    }
  }
  /** Forward the original exactly once; bookkeeping before and after is guarded and can neither replace the result nor swallow the exception. */
  const invoke = <T>(method: string, receiver: unknown, args: unknown[], call: () => T): T => {
    const entry = begin(method, receiver, args)
    let threw = false
    try {
      return call()
    } catch (error) {
      threw = true
      throw error
    } finally {
      complete(entry, threw)
    }
  }
  const wrapMethod = (owner: object, name: string, label: string) => {
    const descriptor = Object.getOwnPropertyDescriptor(owner, name)
    if (!descriptor || typeof descriptor.value !== 'function' || !descriptor.configurable) throw new Error(`${label} is not a configurable own function`)
    const original = descriptor.value as (...args: unknown[]) => unknown
    Object.defineProperty(owner, name, { ...descriptor, value: function (this: unknown, ...args: unknown[]) { return invoke(label, this, args, () => Reflect.apply(original, this, args)) } })
    state.originals.push({ owner, name, label, descriptor })
  }
  const wrapSetter = (owner: object, name: string, label: string) => {
    const descriptor = Object.getOwnPropertyDescriptor(owner, name)
    if (!descriptor || typeof descriptor.set !== 'function' || !descriptor.configurable) throw new Error(`${label} is not a configurable own accessor`)
    const originalSet = descriptor.set
    Object.defineProperty(owner, name, { ...descriptor, set(this: unknown, value: unknown) { invoke(label, this, [value], () => Reflect.apply(originalSet, this, [value])) } })
    state.originals.push({ owner, name, label, descriptor })
  }
  const restoreAll = (): string[] => {
    const done: string[] = []
    for (const entry of state.originals.splice(0).reverse()) {
      try { Object.defineProperty(entry.owner, entry.name, entry.descriptor); done.push(entry.label) } catch (error) { state.errors.push(`restore ${entry.label}: ${String(error)}`) }
    }
    return done
  }
  // Transactional install of the nine routes.
  try {
    wrapMethod(Element.prototype, 'scrollTo', 'Element.scrollTo')
    wrapMethod(Element.prototype, 'scroll', 'Element.scroll')
    wrapMethod(Element.prototype, 'scrollBy', 'Element.scrollBy')
    wrapSetter(Element.prototype, 'scrollTop', 'Element.scrollTop=')
    wrapMethod(Element.prototype, 'scrollIntoView', 'Element.scrollIntoView')
    wrapMethod(HTMLElement.prototype, 'focus', 'HTMLElement.focus')
    wrapMethod(window, 'scrollTo', 'window.scrollTo')
    wrapMethod(window, 'scroll', 'window.scroll')
    wrapMethod(window, 'scrollBy', 'window.scrollBy')
  } catch (error) {
    const undone = restoreAll()
    throw new Error(`scroll-route recorder install failed (${String(error)}); ${undone.length} wrapper(s) restored, none left installed`)
  }
  wrapped = state.originals.map(entry => entry.label)
  state.installed = true
  // Baseline T0 in the same evaluation; an unreadable baseline restores everything and exposes the failure.
  let baseline: RecorderTuple
  try {
    baseline = readTuple('baseline', 'T0', null)
  } catch (error) {
    restoreAll()
    state.installed = false
    throw new Error(`scroll-route recorder baseline failed (${String(error)}); wrappers restored`)
  }
  keep(baseline)
  // Recorder-owned read-only frame sampler (real-time consumers only; a paused-Clock consumer passes 0).
  const tick = () => {
    if (!sampler.active) return
    sampler.delivered++
    try { keep(readTuple('frame', null, sampler.delivered)) } catch (error) { state.errors.push(`frame ${sampler.delivered}: ${String(error)}`) }
    if (sampler.delivered >= sampler.requested) { sampler.active = false; sampler.handle = null; return }
    sampler.handle = requestAnimationFrame(tick)
  }
  if (sampler.requested > 0) { sampler.active = true; sampler.handle = requestAnimationFrame(tick) }
  const snapshot = (): ScrollRouteSnapshot => ({
    installed: state.installed, finalized: state.finalized, wrapped: wrapped.slice(), restored: restored.slice(), engaged: describe(engaged), engagedSource, dialog: describe(dialog),
    tuples: state.tuples.slice(), records: state.records.slice(), nested: state.nested, overflow: state.overflow, dropped: state.dropped, errors: state.errors.slice(),
    sampler: { requested: sampler.requested, delivered: sampler.delivered, active: sampler.active }, sequence: state.sequence,
  })
  const control: RecorderControl = {
    sample: (role, label) => { const tuple = readTuple(role, label, null); keep(tuple); return tuple },
    snapshot,
    finalize: () => {
      sampler.active = false
      if (sampler.handle !== null) { cancelAnimationFrame(sampler.handle); sampler.handle = null }
      try { keep(readTuple('final', 'Tf', null)) } catch (error) { state.errors.push(`final tuple: ${String(error)}`) }
      restored = restoreAll()
      state.installed = false
      state.finalized = true
      Reflect.deleteProperty(window, '__focus81ScrollRoutes')
      return snapshot()
    },
  }
  Reflect.set(window, '__focus81ScrollRoutes', control)
  return { wrapped: wrapped.slice(), engaged: describe(engaged), engagedSource, dialog: describe(dialog), baseline }
}

/**
 * Install the recorder on the open dialog and the engaged control (the one marked
 * by the timing helper, else the active element) and read the baseline tuple T0,
 * all in one evaluation. `frameSamples` > 0 starts the recorder-owned read-only
 * requestAnimationFrame sampler with that ceiling; pass 0 under a paused Clock and
 * sample from the host instead. Call after the control is engaged and before the
 * measured interval; finalize in the test body and again in `finally` (the second
 * call returns null when the first already restored everything).
 */
export async function installScrollRouteRecorder(page: Page, options: { frameSamples?: number; maxTuples?: number; maxRecords?: number } = {}): Promise<RecorderInstall> {
  return page.evaluate(installScrollRouteRecorderInPage, { frameSamples: options.frameSamples ?? 0, maxTuples: options.maxTuples ?? 400, maxRecords: options.maxRecords ?? 200 })
}

/** Read one labeled tuple with the recorder's sampler and stamp it in the shared integer order; 'verdict' marks Tj, the tuple immediately before the judged native stop. */
export const sampleRecorderTuple = (page: Page, label: string, role: 'host' | 'verdict' = 'host'): Promise<RecorderTuple> => page.evaluate(({ label, role }) => {
  const control = Reflect.get(window, '__focus81ScrollRoutes') as RecorderControl | undefined
  if (!control) throw new Error('the scroll-route recorder is not installed')
  return control.sample(role, label)
}, { label, role })

/** Cancel the recorder's sampler, read and stamp Tf, collect every tuple and record, and restore every wrapped descriptor in reverse order, in one evaluation. Returns null when nothing is installed (already finalized). */
export async function finalizeScrollRouteRecorder(page: Page): Promise<ScrollRouteSnapshot | null> {
  return page.evaluate(() => {
    const control = Reflect.get(window, '__focus81ScrollRoutes') as RecorderControl | undefined
    return control ? control.finalize() : null
  })
}
