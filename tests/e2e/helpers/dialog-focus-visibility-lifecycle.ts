/**
 * Stage81 D2 lifecycle helpers for the AP2/AP5/AP6 regressions
 * (docs/design/dialog-focus-visibility.md, D2 candidate 01, SHA256 4f9f5cb4…).
 *
 * Everything here is either a real input gesture (mouse press, drag, release
 * on the scroller's own native scrollbar or inside a textarea), an explicit,
 * labeled synthetic lifecycle event (CompositionEvent dispatched on a chosen
 * element), a labeled test-controlled scheduling fixture (a narrowly scoped,
 * initially pass-through ResizeObserver wrapper installed before the application
 * runs), or a read-only measurement. Positions are read from the elements
 * themselves; nothing writes scrollTop, focus or selection, and no product
 * utility, CSS variable or product private state is read. The scrollbar thumb is
 * modeled from the scroller's own box metrics (track = client height, thumb
 * proportional to clientHeight / scrollHeight); the model is only used to place
 * the pointer, and the spec proves the movement from the scroller's scrollTop
 * afterwards.
 *
 * Measurement discipline: a tuple used for causal statements is read in ONE
 * synchronous browser evaluation and stamped with its shared sequence AFTER the
 * complete read, so no logged event can fall between a stamp and the geometry it
 * labels. Every tuple (the host tuple and the in-callback witness alike) reads
 * the dialog rectangle first, as its one explicit layout boundary, then offsets,
 * range, measured scale and client origin, then the control's box, indicator
 * paint, footer, ancestors and clip, then the viewport and window scroll, then
 * identity, UI, frame and sentinel facts; it then re-reads the facts a causal
 * statement relies on (dialog top and height, scrollTop, scrollHeight,
 * clientHeight, window scroll x/y, control top and bottom, footer top) and
 * reports `coherent` together with `incoherentFacts`. Coherence certifies
 * exactly that those facts did not change within that one evaluation; it says
 * nothing about anchoring or layout work between evaluations, and a coherent
 * tuple is not a snapshot of every public fact. Geometry reads flush layout and
 * may end a scroll-anchoring suppression window. Content coordinates use the
 * tuple's own client origin and the measured public scale (rendered height /
 * offsetHeight), reported to four decimals and never forced to 1; the raw
 * height-minus-offsetHeight difference is reported as a diagnostic only.
 *
 * Under Playwright's public Clock the page's requestAnimationFrame is held, so a
 * held gesture's "frame opportunities" are delivered by explicit 16ms ticks and
 * witnessed by a one-shot frame sentinel; native pointer input, layout, scroll
 * events and ResizeObserver deliveries keep running. Host-side reads never wait
 * on page timers while the Clock is paused.
 */
import { expect } from '@playwright/test'
import type { Locator, Page } from '@playwright/test'
import { awaitFrames } from './dialog-focus-visibility-d2'

export interface ScrollbarGeometry {
  /** A classic (layout-occupying) vertical scrollbar is rendered and the content overflows. */
  rendered: boolean
  scrollbarWidth: number
  trackTop: number
  trackHeight: number
  thumbTop: number
  thumbLength: number
  pressX: number
  pressY: number
  scrollTop: number
  scrollHeight: number
  clientHeight: number
}

/** Native vertical scrollbar geometry of a scroll container, modeled from its own box metrics. */
export function scrollbarGeometry(target: Locator): Promise<ScrollbarGeometry> {
  return target.evaluate(element => {
    const round = (value: number) => Math.round(value * 100) / 100
    const style = getComputedStyle(element)
    const borderLeft = Number.parseFloat(style.borderLeftWidth) || 0
    const borderRight = Number.parseFloat(style.borderRightWidth) || 0
    const borderTop = Number.parseFloat(style.borderTopWidth) || 0
    const box = element.getBoundingClientRect()
    const scrollbarWidth = (element as HTMLElement).offsetWidth - element.clientWidth - borderLeft - borderRight
    const trackTop = box.top + borderTop
    const trackHeight = element.clientHeight
    const thumbLength = element.scrollHeight > 0 ? trackHeight * element.clientHeight / element.scrollHeight : 0
    const thumbTop = element.scrollHeight > 0 ? trackTop + element.scrollTop / element.scrollHeight * trackHeight : trackTop
    return {
      rendered: scrollbarWidth >= 3 && element.scrollHeight > element.clientHeight + 1,
      scrollbarWidth: round(scrollbarWidth), trackTop: round(trackTop), trackHeight, thumbTop: round(thumbTop), thumbLength: round(thumbLength),
      pressX: round(box.right - borderRight - scrollbarWidth / 2), pressY: round(thumbTop + Math.min(thumbLength, 40) / 2),
      scrollTop: round(element.scrollTop), scrollHeight: element.scrollHeight, clientHeight: element.clientHeight,
    }
  })
}

export interface HeldScrollbarDrag {
  geometry: ScrollbarGeometry
  before: number
  /** scrollTop after each held frame opportunity while the thumb is pressed and still. */
  holdSamples: number[]
  /** Whether each held frame opportunity was actually witnessed (true for native frames; the one-shot sentinel for Clock ticks). */
  holdFramesWitnessed: boolean[]
  afterHold: number
  afterDrag: number
  afterRelease: number
  moved: number
  /** Host-side polls spent waiting for the dragged scroll position to come to rest. */
  dragPolls: number
}

export interface HeldDragOptions {
  holdFrames: number
  deltaY: number
  /**
   * Delivers one frame opportunity and reports whether it was witnessed. Default:
   * one native animation frame. Under a paused Clock pass a function that queues
   * a one-shot requestAnimationFrame sentinel, runs the Clock for 16ms and
   * returns whether the sentinel fired.
   */
  frame?: () => Promise<boolean>
}

/**
 * Press the scroller's native scrollbar thumb, hold it still for `holdFrames`
 * frame opportunities, drag it by `deltaY` pixels of thumb travel, then
 * release. The scroller's scrollTop is read before, after every held frame,
 * after the drag has come to rest (host polling of plain reads; nothing waits on
 * page time) and after the release plus four frame opportunities, so the spec
 * can prove a real manual movement and a quiet hold.
 */
export async function dragScrollbarHeld(page: Page, target: Locator, options: HeldDragOptions): Promise<HeldScrollbarDrag> {
  const frame = options.frame ?? (async () => { await awaitFrames(page, 1); return true })
  const geometry = await scrollbarGeometry(target)
  expect(geometry.rendered, `FIXTURE PREREQUISITE (coverage failure if false): a classic native vertical scrollbar must be rendered on the scroller (measured width ${geometry.scrollbarWidth}px); the launch option restoring scrollbars did not take effect, overlay scrollbars are in use, or the content does not overflow`).toBe(true)
  const read = () => target.evaluate(element => Math.round(element.scrollTop * 100) / 100)
  const before = await read()
  await page.mouse.move(geometry.pressX, geometry.pressY)
  await page.mouse.down()
  const holdSamples: number[] = []
  const holdFramesWitnessed: boolean[] = []
  for (let held = 0; held < options.holdFrames; held++) {
    holdFramesWitnessed.push(await frame())
    holdSamples.push(await read())
  }
  const afterHold = await read()
  await page.mouse.move(geometry.pressX, geometry.pressY + options.deltaY / 2, { steps: 4 })
  await page.mouse.move(geometry.pressX, geometry.pressY + options.deltaY, { steps: 4 })
  // The dragged position has come to rest when it has actually left the pre-drag offset and two consecutive host reads agree; no page timer or frame is awaited.
  let dragPolls = 0
  let previous = await read()
  let afterDrag = previous
  await expect.poll(async () => {
    dragPolls++
    afterDrag = await read()
    const settled = Math.abs(afterDrag - previous) <= 0.01 && Math.abs(afterDrag - before) > 0.5
    previous = afterDrag
    return settled
  }, { message: 'the held scrollbar drag comes to rest away from the pre-drag offset (two consecutive equal scrollTop reads after actual movement)' }).toBe(true)
  await page.mouse.up()
  for (let settle = 0; settle < 4; settle++) await frame()
  const afterRelease = await read()
  return { geometry, before, holdSamples, holdFramesWitnessed, afterHold, afterDrag, afterRelease, moved: Math.round((afterDrag - before) * 100) / 100, dragPolls }
}

export interface HeldSelection { fromX: number; toX: number; y: number }

/** Start a native mouse selection inside a textarea and keep the button held: press on the first text line and drag to the right. The caller releases with page.mouse.up(). */
export async function beginHeldMouseSelection(page: Page, field: Locator, options: { fromX?: number; toX?: number } = {}): Promise<HeldSelection> {
  const box = await field.boundingBox()
  expect(box, 'the textarea must have a box').not.toBeNull()
  const y = box!.y + 20
  const fromX = box!.x + (options.fromX ?? 14)
  const toX = box!.x + (options.toX ?? 110)
  await page.mouse.move(fromX, y)
  await page.mouse.down()
  await page.mouse.move(toX, y, { steps: 6 })
  await awaitFrames(page, 2)
  return { fromX, toX, y }
}

export interface CompositionDispatch { dispatched: boolean; wasActive: boolean; insideOpenDialog: boolean; time: number }

/** Dispatch an explicit composition event on an element chosen by selector (the retired editor, or an element outside the dialog). Synthetic lifecycle setup; not an OS IME. */
export function dispatchCompositionOn(page: Page, selector: string, phase: 'start' | 'update' | 'end', data = ''): Promise<CompositionDispatch> {
  return page.evaluate(({ selector, phase, data }) => {
    const element = document.querySelector(selector)
    if (!(element instanceof HTMLElement)) throw new Error(`composition target not found: ${selector}`)
    const dispatched = element.dispatchEvent(new CompositionEvent(`composition${phase}`, { bubbles: true, cancelable: phase !== 'end', data }))
    return { dispatched, wasActive: document.activeElement === element, insideOpenDialog: element.closest('dialog[open]') !== null, time: Math.round(performance.now() * 100) / 100 }
  }, { selector, phase, data })
}

/* --------------------------------------------------------------------------
 * Coherent, same-evaluation, end-stamped tuple of the engaged control.
 * -------------------------------------------------------------------------- */

export interface TupleBox { top: number; bottom: number; left: number; right: number }

/**
 * One synchronous public reading of everything a causal statement about the
 * engaged control needs, read in the fixed order described in the file header:
 * the dialog rectangle first (the one explicit layout boundary of the
 * evaluation), then offsets, range, measured scale and client origin, then the
 * control's box and indicator paint, the footer and the overflow-clipped
 * ancestors, then the viewport and window scroll, then identity, UI, frame and
 * sentinel facts, then the recapture that yields `coherent`. `sequence` is taken
 * from the ResizeObserver fixture's shared counter when that fixture is
 * installed, else from a page-level counter, and it is allocated LAST, after the
 * complete read. Field names shared with the timing helper's EngagedSample keep
 * the spec's predicates usable on both shapes.
 */
export interface EngagedTuple {
  sequence: number
  /** Test-owned frame opportunities delivered (timing helper counter) when read; 0 when no counter is armed. */
  frame: number
  /** The saved-removal-undo one-shot frame sentinel's state when read; null when none is queued. */
  sentinelFired: boolean | null
  activeDescriptor: string
  /** The element whose geometry was measured: the control itself, or a checkbox's bound .toggle-track (D1 rule mirrored for consistency only; no current lifecycle B is a checkbox). */
  measuredDescriptor: string
  sameElement: boolean
  connected: boolean
  width: number
  height: number
  top: number
  bottom: number
  left: number
  right: number
  portTop: number
  portBottom: number
  portLeft: number
  portRight: number
  /** Measured public ratio of the dialog's rendered height to its offsetHeight, four decimals; 1 without a box. Used as read for content coordinates and never forced to 1. */
  scale: number
  /** Raw rendered height minus offsetHeight (not rounded to the 0.01 grid); a diagnostic for integer offsetHeight rounding versus a small transform, never asserted. */
  heightMinusOffsetHeight: number
  footerTop: number | null
  footerBottom: number | null
  footerPosition: string | null
  footerContainsEngaged: boolean
  /** Available clip: dialog client box ∩ viewport ∩ overflow-clipped ancestors, above a sticky footer that does not contain the control. */
  clip: TupleBox
  /** Border box expanded by the painted indicator (outline width + offset, or box-shadow spread). */
  paint: TupleBox
  /** Control and paint inside the available clip (0.5px): the full control/paint clearance of this control at this instant. */
  paintClear: boolean
  /** Border-box overlap with the port edges or the sticky footer; the same measure the frame probe records. */
  overlapPx: number
  occluded: boolean
  dialogScrollTop: number
  dialogScrollHeight: number
  dialogClientHeight: number
  /** Control top in the dialog's scroll-content coordinates: (top − portTop) / scale + scrollTop, from this tuple's own origin. */
  contentTop: number
  windowScroll: { x: number; y: number }
  viewport: { width: number; height: number }
  ui: { footerText: string; messagePresent: boolean; recoverySources: number; importRows: number; focusedDetailsOpen: boolean | null }
  /** True when every recaptured fact (dialog top/height, scrollTop, scrollHeight, clientHeight, window scroll x/y, control top/bottom, footer top) was unchanged within this evaluation. Certifies nothing about anchoring or time between evaluations and is not a snapshot of every public fact. */
  coherent: boolean
  /** The recaptured facts that changed within the evaluation; empty when coherent. */
  incoherentFacts: string[]
}

function measureEngagedTupleInPage(): EngagedTuple {
  const round = (value: number) => Math.round(value * 100) / 100
  const describe = (node: Element | null) => node ? `${node.tagName.toLowerCase()}${Array.from(node.classList).slice(0, 3).map(name => `.${name}`).join('')}` : 'none'
  const element = Reflect.get(window, '__focus81Engaged') as HTMLElement | undefined
  const counter = Reflect.get(window, '__focus81FrameCounter') as { fired: number } | undefined
  const sentinel = Reflect.get(window, '__undo80FrameProbe') as { fired: boolean } | undefined
  const fixture = Reflect.get(window, '__focus81ResizeObserverFixture') as { next: () => number } | undefined
  const nextSequence = () => {
    if (fixture) return fixture.next()
    const value = ((Reflect.get(window, '__focus81TupleSequence') as number | undefined) ?? 0) + 1
    Reflect.set(window, '__focus81TupleSequence', value)
    return value
  }
  // D1 rule mirrored for consistency only: a checkbox's visible control is its bound track while identity and focus stay on the input. No current lifecycle B is a checkbox.
  const measuredOf = (control: HTMLElement): Element => {
    const track = control instanceof HTMLInputElement && control.type === 'checkbox' && control.parentElement?.classList.contains('toggle-row') ? control.parentElement.querySelector<HTMLElement>('.toggle-track') : null
    return track ?? control
  }
  const dialog = document.querySelector<HTMLDialogElement>('dialog[open]')
  const empty: TupleBox = { top: Number.NaN, bottom: Number.NaN, left: Number.NaN, right: Number.NaN }
  if (!dialog || !element) {
    const active = document.activeElement
    return {
      frame: counter?.fired ?? 0, sentinelFired: sentinel ? sentinel.fired : null, activeDescriptor: describe(active), measuredDescriptor: 'none',
      sameElement: element !== undefined && active === element, connected: element?.isConnected ?? false,
      width: Number.NaN, height: Number.NaN, top: Number.NaN, bottom: Number.NaN, left: Number.NaN, right: Number.NaN, portTop: Number.NaN, portBottom: Number.NaN, portLeft: Number.NaN, portRight: Number.NaN, scale: 1, heightMinusOffsetHeight: Number.NaN,
      footerTop: null, footerBottom: null, footerPosition: null, footerContainsEngaged: false, clip: empty, paint: empty, paintClear: false, overlapPx: Number.NaN, occluded: true,
      dialogScrollTop: Number.NaN, dialogScrollHeight: 0, dialogClientHeight: 0, contentTop: Number.NaN,
      windowScroll: { x: round(window.scrollX), y: round(window.scrollY) }, viewport: { width: document.documentElement.clientWidth, height: document.documentElement.clientHeight },
      ui: { footerText: '', messagePresent: false, recoverySources: 0, importRows: 0, focusedDetailsOpen: null },
      coherent: false, incoherentFacts: [dialog ? 'no engaged element' : 'no open dialog'], sequence: nextSequence(),
    }
  }
  const facts: string[] = []
  // 1. The one explicit layout boundary of this evaluation: the dialog rectangle (this flushes layout and may end a pending anchoring suppression window). Every other read follows it.
  const dialogRectA = dialog.getBoundingClientRect()
  // 2. Offsets, range, measured scale (the public ratio, never forced to 1) and client origin.
  const scrollTopA = dialog.scrollTop
  const scrollHeightA = dialog.scrollHeight
  const clientHeightA = dialog.clientHeight
  const clientWidth = dialog.clientWidth
  const offsetHeight = dialog.offsetHeight
  const scale = offsetHeight ? dialogRectA.height / offsetHeight : 1
  const portTop = dialogRectA.top + dialog.clientTop * scale
  const portLeft = dialogRectA.left + dialog.clientLeft * scale
  const portBottom = portTop + clientHeightA * scale
  const portRight = portLeft + clientWidth * scale
  // 3. The control's box and indicator paint, then the footer and the overflow-clipped ancestors.
  const measured = measuredOf(element)
  const boxA = measured.getBoundingClientRect()
  const style = getComputedStyle(measured)
  const outline = style.outlineStyle === 'none' ? 0 : Math.max(0, (Number.parseFloat(style.outlineWidth) || 0) + (Number.parseFloat(style.outlineOffset) || 0))
  const shadow = /(-?[\d.]+)px\s+(-?[\d.]+)px\s+(-?[\d.]+)px\s+(-?[\d.]+)px/.exec(style.boxShadow)
  const extent = Math.max(outline, shadow ? Math.max(0, Number.parseFloat(shadow[4])) : 0)
  const footer = dialog.querySelector<HTMLElement>(':scope > .dialog-footer')
  const footerBoxA = footer?.getBoundingClientRect() ?? null
  const footerPosition = footer ? getComputedStyle(footer).position : null
  const footerContainsEngaged = footer !== null && footer.contains(element)
  const stickyFooterTop = footer && footerBoxA && footerPosition === 'sticky' && !footerContainsEngaged ? footerBoxA.top : null
  const ancestorClips: { left: number; top: number; right: number; bottom: number; clipsX: boolean; clipsY: boolean }[] = []
  for (let ancestor = measured.parentElement; ancestor && ancestor !== dialog && ancestor !== document.body; ancestor = ancestor.parentElement) {
    const ancestorStyle = getComputedStyle(ancestor)
    if (ancestorStyle.overflowX === 'visible' && ancestorStyle.overflowY === 'visible') continue
    const rect = ancestor.getBoundingClientRect()
    const left = rect.left + ancestor.clientLeft * scale
    const top = rect.top + ancestor.clientTop * scale
    ancestorClips.push({ left, top, right: left + ancestor.clientWidth * scale, bottom: top + ancestor.clientHeight * scale, clipsX: ancestorStyle.overflowX !== 'visible', clipsY: ancestorStyle.overflowY !== 'visible' })
  }
  // 4. Viewport and window scroll.
  const viewport = { width: document.documentElement.clientWidth, height: document.documentElement.clientHeight }
  const windowScrollA = { x: window.scrollX, y: window.scrollY }
  // 5. Identity, UI, frame and sentinel facts (no layout reads).
  const active = document.activeElement
  const ui = {
    footerText: (footer?.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 120),
    messagePresent: dialog.querySelector('.saved-file-message') !== null,
    recoverySources: dialog.querySelectorAll('.saved-recovery-source').length,
    importRows: dialog.querySelectorAll('.saved-import-row').length,
    focusedDetailsOpen: active instanceof HTMLElement && active.tagName.toLowerCase() === 'summary' && active.parentElement instanceof HTMLDetailsElement ? active.parentElement.open : null,
  }
  const sameElement = active === element
  const connected = element.isConnected
  const frame = counter?.fired ?? 0
  const sentinelFired = sentinel ? sentinel.fired : null
  // Geometry derived from the reads above.
  let clip: TupleBox = { top: Math.max(portTop, 0), bottom: Math.min(portBottom, viewport.height), left: Math.max(portLeft, 0), right: Math.min(portRight, viewport.width) }
  for (const ancestor of ancestorClips) {
    if (ancestor.clipsX) { clip.left = Math.max(clip.left, ancestor.left); clip.right = Math.min(clip.right, ancestor.right) }
    if (ancestor.clipsY) { clip.top = Math.max(clip.top, ancestor.top); clip.bottom = Math.min(clip.bottom, ancestor.bottom) }
  }
  if (stickyFooterTop !== null && footerBoxA && footerBoxA.right > boxA.left && footerBoxA.left < boxA.right) clip = { ...clip, bottom: Math.min(clip.bottom, stickyFooterTop) }
  const paint: TupleBox = { top: boxA.top - extent, bottom: boxA.bottom + extent, left: boxA.left - extent, right: boxA.right + extent }
  const paintClear = connected && measured.isConnected && paint.top >= clip.top - 0.5 && paint.bottom <= clip.bottom + 0.5 && paint.left >= clip.left - 0.5 && paint.right <= clip.right + 0.5
  const limit = stickyFooterTop === null ? portBottom : Math.min(portBottom, stickyFooterTop)
  const overlap = Math.max(0, boxA.bottom - limit, portTop - boxA.top)
  // 6. Recapture of the facts a causal statement relies on; `coherent` certifies only that these did not change within this evaluation.
  const dialogRectB = dialog.getBoundingClientRect()
  if (Math.abs(dialogRectB.top - dialogRectA.top) > 0.01) facts.push('dialog.top')
  if (Math.abs(dialogRectB.height - dialogRectA.height) > 0.01) facts.push('dialog.height')
  if (Math.abs(dialog.scrollTop - scrollTopA) > 0.01) facts.push('dialog.scrollTop')
  if (dialog.scrollHeight !== scrollHeightA) facts.push('dialog.scrollHeight')
  if (dialog.clientHeight !== clientHeightA) facts.push('dialog.clientHeight')
  if (Math.abs(window.scrollX - windowScrollA.x) > 0.01 || Math.abs(window.scrollY - windowScrollA.y) > 0.01) facts.push('window.scroll')
  const boxB = measured.getBoundingClientRect()
  if (Math.abs(boxB.top - boxA.top) > 0.01 || Math.abs(boxB.bottom - boxA.bottom) > 0.01) facts.push('control.rect')
  if (footer && footerBoxA && Math.abs(footer.getBoundingClientRect().top - footerBoxA.top) > 0.01) facts.push('footer.top')
  // 7. Stamp last.
  return {
    frame, sentinelFired, activeDescriptor: describe(active), measuredDescriptor: describe(measured), sameElement, connected,
    width: round(boxA.width), height: round(boxA.height), top: round(boxA.top), bottom: round(boxA.bottom), left: round(boxA.left), right: round(boxA.right),
    portTop: round(portTop), portBottom: round(portBottom), portLeft: round(portLeft), portRight: round(portRight),
    scale: Math.round(scale * 10000) / 10000, heightMinusOffsetHeight: dialogRectA.height - offsetHeight,
    footerTop: stickyFooterTop === null ? null : round(stickyFooterTop), footerBottom: footerBoxA ? round(footerBoxA.bottom) : null, footerPosition, footerContainsEngaged,
    clip: { top: round(clip.top), bottom: round(clip.bottom), left: round(clip.left), right: round(clip.right) }, paint: { top: round(paint.top), bottom: round(paint.bottom), left: round(paint.left), right: round(paint.right) }, paintClear,
    overlapPx: round(overlap), occluded: overlap > 0.5 || !connected,
    dialogScrollTop: round(scrollTopA), dialogScrollHeight: scrollHeightA, dialogClientHeight: clientHeightA, contentTop: round((boxA.top - portTop) / scale + scrollTopA),
    windowScroll: { x: round(windowScrollA.x), y: round(windowScrollA.y) }, viewport, ui,
    coherent: facts.length === 0, incoherentFacts: facts, sequence: nextSequence(),
  }
}

/** Read the engaged control's coherent tuple in one synchronous evaluation; the shared sequence is stamped after the complete read. Read-only. */
export const measureEngagedTuple = (page: Page): Promise<EngagedTuple> => page.evaluate(measureEngagedTupleInPage)

/* --------------------------------------------------------------------------
 * Labeled test-controlled scheduling fixture: pass-through ResizeObserver
 * wrapper with a one-shot stale-end hook and a temporary delivery gate.
 * -------------------------------------------------------------------------- */

/** Geometry of the marked engaged control read inside a native observer callback in the same order as EngagedTuple (dialog rectangle first, recapture last, stamp after the read); the same measures as EngagedTuple's core fields. */
export interface InCallbackWitness {
  sequence: number
  sameElement: boolean
  connected: boolean
  /** The element whose geometry was measured: the control, or a checkbox's bound .toggle-track (consistency only). */
  measuredDescriptor: string
  width: number
  height: number
  top: number
  bottom: number
  portTop: number
  portBottom: number
  /** Measured public ratio rect.height / offsetHeight, four decimals; never forced to 1. */
  scale: number
  footerTop: number | null
  clip: TupleBox
  paint: TupleBox
  paintClear: boolean
  dialogScrollTop: number
  overlapPx: number
  /** Test-owned frame opportunities delivered since the counter was armed; must be 0 for a pre-repair witness. */
  framesFired: number
  /** True when the recaptured facts (dialog top/height, scrollTop, scrollHeight, clientHeight, window scroll, control top/bottom, footer top) were unchanged within this callback read; certifies nothing beyond that. */
  coherent: boolean
  incoherentFacts: string[]
}

export interface StaleEndHookResult {
  /** Sequence of the forwarded native delivery that carried the open dialog's own entry (allocated before forwarding). */
  forwardedSequence: number
  witness: InCallbackWitness
  gateClosedSequence: number
  /** Sequence allocated immediately before dispatchEvent of the exact injected compositionend. */
  dispatchStartSequence: number
  /** Sequence allocated immediately after dispatchEvent returned. */
  dispatchEndSequence: number
  dispatched: boolean
  wasActive: boolean
  insideOpenDialog: boolean
}

/** A forwarded delivery to the dialog controller's observer on which the armed hook did not fire, with the reason and the witness read at that instant. */
export interface SkippedDelivery { sequence: number; dialogResized: boolean; coherent: boolean; occluded: boolean; positiveSize: boolean; framesFired: number; reason: string; witness: InCallbackWitness }

export interface StaleEndFixtureState {
  installed: boolean
  /** Wrapped observers created by the page so far, with how many of their targets are the open dialog. */
  observers: { id: number; targets: number; observesOpenDialog: boolean; delivered: number; queued: number }[]
  hook: { armedSequence: number; used: boolean; result: StaleEndHookResult | null; skipped: SkippedDelivery[] } | null
  gate: { recordId: number; closed: boolean; closedSequence: number; releasedSequence: number | null; forwardedOnRelease: number } | null
  sequence: number
}

/** One logged event or marker; the exact injected compositionend is the only event tagged `fixture-compositionend`. */
export interface ReschedulerEntry { sequence: number; kind: string; detail: string }

/**
 * Install, before navigation, a narrowly scoped ResizeObserver wrapper. It is
 * pass-through: every observer the page creates gets a real native observer,
 * actual entries are forwarded first with the wrapper instance as `this` and as
 * the observer argument, and observe/unobserve/disconnect delegate to the native
 * instance. The dialog controller's observer is identified only through its
 * public observed targets (it observes the open `dialog` element). Until a hook is
 * armed nothing else happens. Labeled fixture: it changes scheduling only after
 * the one-shot hook fires, and only for that one observer. Its lifetime is the
 * page/context; releasing the gate restores pass-through delivery only and does
 * not reinstall the native constructor or remove the passive log listeners.
 * Deliveries held by the gate are dropped for targets the page unobserves or
 * disconnects in the meantime, so release never reports a target the page has
 * stopped observing. It is not a general ResizeObserver polyfill.
 */
export async function installResizeObserverFixture(page: Page) {
  await page.addInitScript(resizeObserverFixtureInPage)
}

function resizeObserverFixtureInPage() {
  const Native = window.ResizeObserver
  if (typeof Native !== 'function') return
  interface ObserverRecord { id: number; callback: ResizeObserverCallback; targets: Set<Element>; delivered: number; queued: { sequence: number; entries: ResizeObserverEntry[]; wrapper: ResizeObserver }[]; native: ResizeObserver }
  interface Hook { retiredSelector: string; data: string; armedSequence: number; used: boolean; result: StaleEndHookResult | null; skipped: SkippedDelivery[] }
  interface Gate { recordId: number; closed: boolean; closedSequence: number; releasedSequence: number | null; forwardedOnRelease: number }
  const state = { sequence: 0, observers: [] as ObserverRecord[], hook: null as Hook | null, gate: null as Gate | null, log: [] as { sequence: number; kind: string; detail: string }[], injected: null as Event | null }
  const next = () => ++state.sequence
  const records = new WeakMap<object, ObserverRecord>()
  const round = (value: number) => Math.round(value * 100) / 100
  const describeNode = (node: Element | null) => node ? `${node.tagName.toLowerCase()}${Array.from(node.classList).slice(0, 3).map(name => `.${name}`).join('')}` : 'none'
  // D1 rule mirrored for consistency only: a checkbox's visible control is its bound track while identity and focus stay on the input. No current lifecycle B is a checkbox.
  const measuredOf = (control: HTMLElement): Element => {
    const track = control instanceof HTMLInputElement && control.type === 'checkbox' && control.parentElement?.classList.contains('toggle-row') ? control.parentElement.querySelector<HTMLElement>('.toggle-track') : null
    return track ?? control
  }
  /** Same read order and the same recapture as the host tuple: dialog rectangle first, recapture last, stamp after the read. */
  const witness = (): InCallbackWitness => {
    const element = Reflect.get(window, '__focus81Engaged') as HTMLElement | undefined
    const counter = Reflect.get(window, '__focus81FrameCounter') as { fired: number } | undefined
    const dialog = document.querySelector<HTMLDialogElement>('dialog[open]')
    const empty: TupleBox = { top: Number.NaN, bottom: Number.NaN, left: Number.NaN, right: Number.NaN }
    if (!dialog || !element) {
      return {
        sameElement: element !== undefined && document.activeElement === element, connected: element?.isConnected ?? false, measuredDescriptor: 'none',
        width: Number.NaN, height: Number.NaN, top: Number.NaN, bottom: Number.NaN, portTop: Number.NaN, portBottom: Number.NaN, scale: 1, footerTop: null, clip: empty, paint: empty, paintClear: false,
        dialogScrollTop: Number.NaN, overlapPx: Number.NaN, framesFired: counter?.fired ?? 0, coherent: false, incoherentFacts: [dialog ? 'no engaged element' : 'no open dialog'], sequence: next(),
      }
    }
    const facts: string[] = []
    // 1. Layout boundary: the dialog rectangle.
    const dialogBoxA = dialog.getBoundingClientRect()
    // 2. Offsets, range, measured scale (never forced to 1) and client origin.
    const scrollTopA = dialog.scrollTop
    const scrollHeightA = dialog.scrollHeight
    const clientHeightA = dialog.clientHeight
    const offsetHeight = dialog.offsetHeight
    const scale = offsetHeight ? dialogBoxA.height / offsetHeight : 1
    const portTop = dialogBoxA.top + dialog.clientTop * scale
    const portBottom = portTop + clientHeightA * scale
    const portLeft = dialogBoxA.left + dialog.clientLeft * scale
    const portRight = portLeft + dialog.clientWidth * scale
    // 3. Control box and indicator paint, then the footer and the overflow-clipped ancestors.
    const measured = measuredOf(element)
    const boxA = measured.getBoundingClientRect()
    const style = getComputedStyle(measured)
    const outline = style.outlineStyle === 'none' ? 0 : Math.max(0, (Number.parseFloat(style.outlineWidth) || 0) + (Number.parseFloat(style.outlineOffset) || 0))
    const shadow = /(-?[\d.]+)px\s+(-?[\d.]+)px\s+(-?[\d.]+)px\s+(-?[\d.]+)px/.exec(style.boxShadow)
    const extent = Math.max(outline, shadow ? Math.max(0, Number.parseFloat(shadow[4])) : 0)
    const footer = dialog.querySelector<HTMLElement>(':scope > .dialog-footer')
    const footerBoxA = footer?.getBoundingClientRect() ?? null
    const footerTop = footer && footerBoxA && getComputedStyle(footer).position === 'sticky' && !footer.contains(element) ? footerBoxA.top : null
    const ancestorClips: { left: number; top: number; right: number; bottom: number; clipsX: boolean; clipsY: boolean }[] = []
    for (let ancestor = measured.parentElement; ancestor && ancestor !== dialog && ancestor !== document.body; ancestor = ancestor.parentElement) {
      const ancestorStyle = getComputedStyle(ancestor)
      if (ancestorStyle.overflowX === 'visible' && ancestorStyle.overflowY === 'visible') continue
      const rect = ancestor.getBoundingClientRect()
      const left = rect.left + ancestor.clientLeft * scale
      const top = rect.top + ancestor.clientTop * scale
      ancestorClips.push({ left, top, right: left + ancestor.clientWidth * scale, bottom: top + ancestor.clientHeight * scale, clipsX: ancestorStyle.overflowX !== 'visible', clipsY: ancestorStyle.overflowY !== 'visible' })
    }
    // 4. Viewport and window scroll.
    const viewport = { width: document.documentElement.clientWidth, height: document.documentElement.clientHeight }
    const windowScrollA = { x: window.scrollX, y: window.scrollY }
    // 5. Identity and frame facts (no layout reads).
    const sameElement = document.activeElement === element
    const connected = element.isConnected
    const framesFired = counter?.fired ?? 0
    // Geometry derived from the reads above.
    let clip: TupleBox = { top: Math.max(portTop, 0), bottom: Math.min(portBottom, viewport.height), left: Math.max(portLeft, 0), right: Math.min(portRight, viewport.width) }
    for (const ancestor of ancestorClips) {
      if (ancestor.clipsX) { clip.left = Math.max(clip.left, ancestor.left); clip.right = Math.min(clip.right, ancestor.right) }
      if (ancestor.clipsY) { clip.top = Math.max(clip.top, ancestor.top); clip.bottom = Math.min(clip.bottom, ancestor.bottom) }
    }
    if (footerTop !== null && footerBoxA && footerBoxA.right > boxA.left && footerBoxA.left < boxA.right) clip = { ...clip, bottom: Math.min(clip.bottom, footerTop) }
    const paint: TupleBox = { top: boxA.top - extent, bottom: boxA.bottom + extent, left: boxA.left - extent, right: boxA.right + extent }
    const paintClear = connected && measured.isConnected && paint.top >= clip.top - 0.5 && paint.bottom <= clip.bottom + 0.5 && paint.left >= clip.left - 0.5 && paint.right <= clip.right + 0.5
    const limit = footerTop === null ? portBottom : Math.min(portBottom, footerTop)
    // 6. Recapture of the facts a causal statement relies on; `coherent` certifies only that these did not change within this callback read.
    const dialogBoxB = dialog.getBoundingClientRect()
    if (Math.abs(dialogBoxB.top - dialogBoxA.top) > 0.01) facts.push('dialog.top')
    if (Math.abs(dialogBoxB.height - dialogBoxA.height) > 0.01) facts.push('dialog.height')
    if (Math.abs(dialog.scrollTop - scrollTopA) > 0.01) facts.push('dialog.scrollTop')
    if (dialog.scrollHeight !== scrollHeightA) facts.push('dialog.scrollHeight')
    if (dialog.clientHeight !== clientHeightA) facts.push('dialog.clientHeight')
    if (Math.abs(window.scrollX - windowScrollA.x) > 0.01 || Math.abs(window.scrollY - windowScrollA.y) > 0.01) facts.push('window.scroll')
    const boxB = measured.getBoundingClientRect()
    if (Math.abs(boxB.top - boxA.top) > 0.01 || Math.abs(boxB.bottom - boxA.bottom) > 0.01) facts.push('control.rect')
    if (footer && footerBoxA && Math.abs(footer.getBoundingClientRect().top - footerBoxA.top) > 0.01) facts.push('footer.top')
    // 7. Stamp last.
    return {
      sameElement, connected, measuredDescriptor: describeNode(measured),
      width: round(boxA.width), height: round(boxA.height), top: round(boxA.top), bottom: round(boxA.bottom), portTop: round(portTop), portBottom: round(portBottom), scale: Math.round(scale * 10000) / 10000, footerTop: footerTop === null ? null : round(footerTop),
      clip: { top: round(clip.top), bottom: round(clip.bottom), left: round(clip.left), right: round(clip.right) }, paint: { top: round(paint.top), bottom: round(paint.bottom), left: round(paint.left), right: round(paint.right) }, paintClear,
      dialogScrollTop: round(scrollTopA), overlapPx: round(Math.max(0, boxA.bottom - limit, portTop - boxA.top)), framesFired, coherent: facts.length === 0, incoherentFacts: facts, sequence: next(),
    }
  }
  const deliver = (record: ObserverRecord, entries: ResizeObserverEntry[], wrapper: ResizeObserver) => {
    const gate = state.gate
    if (gate && gate.recordId === record.id && gate.closed) { record.queued.push({ sequence: next(), entries, wrapper }); return }
    record.delivered++
    const forwardedSequence = next()
    // Forward the actual native delivery first, unchanged.
    record.callback.call(wrapper, entries, wrapper)
    const hook = state.hook
    if (!hook || hook.used) return
    const observesOpenDialog = Array.from(record.targets).some(target => target instanceof HTMLDialogElement && target.open)
    if (!observesOpenDialog) return
    const dialogResized = entries.some(entry => entry.target instanceof HTMLDialogElement && (entry.target as HTMLDialogElement).open)
    const seen = witness()
    const positiveSize = seen.width > 0 && seen.height > 0
    const occluded = seen.sameElement && seen.connected && seen.overlapPx > 0.5
    // The hook fires only on a coherent witness of the same connected focused control with positive size, genuine border-box occlusion and zero frame opportunities; every other delivery is recorded as skipped with its reason.
    if (!dialogResized || !seen.coherent || !occluded || !positiveSize || seen.framesFired !== 0) {
      hook.skipped.push({
        sequence: next(), dialogResized, coherent: seen.coherent, occluded, positiveSize, framesFired: seen.framesFired,
        reason: !dialogResized ? 'delivery without the open dialog entry' : !seen.coherent ? `incoherent witness (${seen.incoherentFacts.join(', ')})` : !occluded ? 'engaged control not genuinely occluded' : !positiveSize ? 'engaged control has no positive width and height' : 'a frame opportunity had already run',
        witness: seen,
      })
      return
    }
    hook.used = true
    // From here, later native deliveries of this observer are queued until the decisive observation; everything else is untouched.
    state.gate = { recordId: record.id, closed: true, closedSequence: next(), releasedSequence: null, forwardedOnRelease: 0 }
    const target = document.querySelector(hook.retiredSelector)
    const injected = new CompositionEvent('compositionend', { bubbles: true, cancelable: false, data: hook.data })
    state.injected = injected
    const dispatchStartSequence = next()
    const dispatched = target instanceof HTMLElement ? target.dispatchEvent(injected) : false
    const dispatchEndSequence = next()
    state.injected = null
    hook.result = {
      forwardedSequence, witness: seen, gateClosedSequence: state.gate.closedSequence, dispatchStartSequence, dispatchEndSequence, dispatched,
      wasActive: target !== null && document.activeElement === target, insideOpenDialog: target?.closest('dialog[open]') !== null,
    }
  }
  class FixtureResizeObserver {
    constructor(callback: ResizeObserverCallback) {
      if (typeof callback !== 'function') throw new TypeError('ResizeObserver callback must be a function')
      const record: ObserverRecord = { id: state.observers.length + 1, callback, targets: new Set(), delivered: 0, queued: [], native: null as unknown as ResizeObserver }
      record.native = new Native(entries => deliver(record, entries, this as unknown as ResizeObserver))
      records.set(this, record)
      state.observers.push(record)
    }
    observe(target: Element, options?: ResizeObserverOptions) { const record = records.get(this)!; record.targets.add(target); record.native.observe(target, options) }
    unobserve(target: Element) {
      const record = records.get(this)!
      record.targets.delete(target)
      record.native.unobserve(target)
      // A delivery held by the gate must not later report a target the page has stopped observing.
      for (const queued of record.queued) queued.entries = queued.entries.filter(entry => entry.target !== target)
      record.queued = record.queued.filter(queued => queued.entries.length > 0)
    }
    disconnect() { const record = records.get(this)!; record.targets.clear(); record.queued.length = 0; record.native.disconnect() }
  }
  const describe = (node: EventTarget | null) => node instanceof Element ? `${node.tagName.toLowerCase()}${Array.from(node.classList).slice(0, 3).map(name => `.${name}`).join('')}` : node === document ? 'document' : node === window ? 'window' : 'none'
  const control = {
    arm(retiredSelector: string, data: string) {
      state.hook = { retiredSelector, data, armedSequence: next(), used: false, result: null, skipped: [] }
      return state.hook.armedSequence
    },
    armLog() {
      const dialog = document.querySelector<HTMLDialogElement>('dialog[open]')
      const log = (kind: string, detail: string) => { state.log.push({ sequence: next(), kind, detail }) }
      window.addEventListener('resize', () => log('window-resize', `${window.innerWidth}x${window.innerHeight}`))
      window.visualViewport?.addEventListener('resize', () => log('visual-viewport-resize', `${window.visualViewport?.width}x${window.visualViewport?.height}`))
      document.fonts.addEventListener('loadingdone', () => log('fonts-loadingdone', ''))
      for (const name of ['focusin', 'keydown', 'pointerdown', 'pointerup', 'wheel', 'touchstart', 'input', 'selectionchange', 'compositionstart', 'compositionend']) {
        // Only the exact intentionally injected compositionend Event object is tagged as fixture traffic; every nested or unrelated event keeps its own kind.
        document.addEventListener(name, event => log(event === state.injected ? 'fixture-compositionend' : name, describe(event.target)), { capture: true, passive: true })
      }
      if (dialog) {
        // The same filter the dialog controller applies: its own style writes on the dialog element are not a rescheduler.
        const observer = new MutationObserver(mutations => {
          const relevant = mutations.filter(mutation => mutation.target !== dialog || mutation.attributeName !== 'style')
          if (relevant.length) log('mutation', relevant.slice(0, 3).map(mutation => `${mutation.type}:${describe(mutation.target)}:${mutation.attributeName ?? ''}`).join(' '))
        })
        observer.observe(dialog, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['class', 'style', 'open', 'hidden'] })
      }
      return next()
    },
    /** Append a labeled marker to the same ordered log and return its sequence. */
    mark(label: string) {
      const sequence = next()
      state.log.push({ sequence, kind: 'marker', detail: label })
      return sequence
    },
    release() {
      const gate = state.gate
      if (!gate) return { forwarded: 0, releasedSequence: null }
      const record = state.observers.find(entry => entry.id === gate.recordId)
      gate.closed = false
      gate.releasedSequence = next()
      let forwarded = 0
      for (const queued of record?.queued.splice(0) ?? []) { record!.delivered++; record!.callback.call(queued.wrapper, queued.entries, queued.wrapper); forwarded++ }
      gate.forwardedOnRelease = forwarded
      return { forwarded, releasedSequence: gate.releasedSequence }
    },
    next,
    snapshot(): StaleEndFixtureState {
      return {
        installed: true,
        observers: state.observers.map(record => ({ id: record.id, targets: record.targets.size, observesOpenDialog: Array.from(record.targets).some(target => target instanceof HTMLDialogElement && target.open), delivered: record.delivered, queued: record.queued.length })),
        hook: state.hook ? { armedSequence: state.hook.armedSequence, used: state.hook.used, result: state.hook.result, skipped: state.hook.skipped.slice() } : null,
        gate: state.gate ? { ...state.gate } : null,
        sequence: state.sequence,
      }
    },
    log: () => state.log.slice(),
  }
  ;(window as unknown as { ResizeObserver: unknown }).ResizeObserver = FixtureResizeObserver
  Reflect.set(window, '__focus81ResizeObserverFixture', control)
}

type FixtureControl = {
  arm: (retiredSelector: string, data: string) => number
  armLog: () => number
  mark: (label: string) => number
  release: () => { forwarded: number; releasedSequence: number | null }
  next: () => number
  snapshot: () => StaleEndFixtureState
  log: () => ReschedulerEntry[]
}
const fixtureControl = (page: Page) => page.evaluate(() => {
  const control = Reflect.get(window, '__focus81ResizeObserverFixture') as FixtureControl | undefined
  if (!control) throw new Error('the ResizeObserver fixture was not installed before navigation')
  return control.snapshot()
})

/** Arm the one-shot stale-end hook: on the next forwarded delivery that carries the open dialog's own entry while a coherent in-callback witness shows the marked engaged control genuinely occluded, with positive width and height, and no frame opportunity has run, dispatch compositionend on the retired editor and close the gate; an incoherent witness is recorded as a skipped delivery with reason 'incoherent witness'. */
export const armStaleEndOnResize = (page: Page, retiredSelector: string, data: string) => page.evaluate(({ retiredSelector, data }) => {
  const control = Reflect.get(window, '__focus81ResizeObserverFixture') as FixtureControl | undefined
  if (!control) throw new Error('the ResizeObserver fixture was not installed before navigation')
  return control.arm(retiredSelector, data)
}, { retiredSelector, data })

/** Start the passive rescheduler log (window/visualViewport resize, fonts, input/focus/composition events, relevant dialog mutations with the controller's own style-write filter). */
export const armReschedulerLog = (page: Page) => page.evaluate(() => (Reflect.get(window, '__focus81ResizeObserverFixture') as FixtureControl).armLog())
export const reschedulerLog = (page: Page): Promise<ReschedulerEntry[]> => page.evaluate(() => (Reflect.get(window, '__focus81ResizeObserverFixture') as FixtureControl).log())
export const staleEndFixture = (page: Page): Promise<StaleEndFixtureState> => fixtureControl(page)
/** Next shared sequence number, so host-side samples order against in-page fixture events. */
export const nextFixtureSequence = (page: Page): Promise<number> => page.evaluate(() => (Reflect.get(window, '__focus81ResizeObserverFixture') as FixtureControl).next())
/** Append a labeled marker to the fixture's ordered log; used to bracket a host-side judged observation so the sealed window closes only after it. */
export const fixtureMark = (page: Page, label: string): Promise<number> => page.evaluate(label => (Reflect.get(window, '__focus81ResizeObserverFixture') as FixtureControl).mark(label), label)
/** Restore pass-through delivery for the gated observer and forward its queued native deliveries in order; returns how many were forwarded. */
export const releaseResizeObserverGate = (page: Page) => page.evaluate(() => (Reflect.get(window, '__focus81ResizeObserverFixture') as FixtureControl | undefined)?.release() ?? { forwarded: 0, releasedSequence: null })

/* --------------------------------------------------------------------------
 * Read-only UI state of the backup dialog (kept for callers that need UI alone).
 * -------------------------------------------------------------------------- */

export interface BackupUiState {
  footerText: string
  footerPosition: string | null
  footerRect: { top: number; bottom: number; height: number } | null
  messagePresent: boolean
  recoverySources: number
  importRows: number
  /** Whether the focused element is a details summary and whether its details are open; null when focus is elsewhere. */
  focusedDetailsOpen: boolean | null
}

export const backupUiState = (page: Page): Promise<BackupUiState> => page.evaluate(() => {
  const round = (value: number) => Math.round(value * 100) / 100
  const dialog = document.querySelector<HTMLDialogElement>('dialog[open]')
  const footer = dialog?.querySelector<HTMLElement>(':scope > .dialog-footer') ?? null
  const footerBox = footer?.getBoundingClientRect() ?? null
  const active = document.activeElement
  return {
    footerText: (footer?.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 120),
    footerPosition: footer ? getComputedStyle(footer).position : null,
    footerRect: footerBox ? { top: round(footerBox.top), bottom: round(footerBox.bottom), height: round(footerBox.height) } : null,
    messagePresent: dialog?.querySelector('.saved-file-message') !== null,
    recoverySources: dialog?.querySelectorAll('.saved-recovery-source').length ?? 0,
    importRows: dialog?.querySelectorAll('.saved-import-row').length ?? 0,
    focusedDetailsOpen: active instanceof HTMLElement && active.tagName.toLowerCase() === 'summary' && active.parentElement instanceof HTMLDetailsElement ? active.parentElement.open : null,
  }
})
