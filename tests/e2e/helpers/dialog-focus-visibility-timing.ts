/**
 * Stage81 D2 timing helpers for the TR2 race protocol (docs/design/dialog-focus-visibility.md,
 * D2 candidate 01, SHA256 4f9f5cb4…): a completed native wheel witness, a
 * test-owned nested frame counter, host-side samples of the engaged control
 * between explicit Clock ticks, and judged native stops recorded without any
 * frame, readiness or screenshot wait.
 *
 * Everything here observes. Nothing focuses, scrolls, writes product state or
 * reads product private state; page functions are serialized by Playwright and
 * are self-contained. Playwright's public Clock (1.63) fakes Date, performance,
 * timers and requestAnimationFrame in the page's main world only: native input
 * delivery, layout, scroll/scrollend dispatch, observers, microtasks and
 * Playwright's own injected scripts keep running. Ordering is therefore
 * witnessed with test-owned sequence numbers and frame counts (page timestamps
 * tie while paused), and completed native movement is established by host-side
 * polling of plain DOM reads plus a native scrollend receipt, never by an
 * immediate scrollTop read after mouse.wheel, by a sleep or by advancing the
 * Clock to obtain a receipt.
 */
import { expect } from '@playwright/test'
import type { Locator, Page } from '@playwright/test'
import { KeyboardWalk, assessStop, probeActive } from './dialog-focus-visibility'
import type { WalkStop } from './dialog-focus-visibility'

/* --------------------------------------------------------------------------
 * Test-owned nested frame counter.
 * -------------------------------------------------------------------------- */

export interface FrameOpportunities {
  /** False until armFrameCounter ran in this page. */
  armed: boolean
  /** Frame opportunities delivered since arming: 0, 1 (outer callback ran) or 2 (nested callback ran). */
  fired: number
}

/**
 * Queue one nested pair of requestAnimationFrame callbacks. `fired` counts the
 * frame opportunities delivered since arming (0, 1 or 2). Arm it before the
 * gesture whose deferred two-frame tail is under test: the counter's two
 * opportunities are then registered before that tail's two, so `fired === 2`
 * witnesses that the tail's window has passed as well. Nothing is replaced or
 * intercepted; the counter only records whether controlled frames occurred.
 */
export async function armFrameCounter(page: Page) {
  await page.evaluate(() => {
    const counter: { armed: boolean; fired: number } = { armed: true, fired: 0 }
    Reflect.set(window, '__focus81FrameCounter', counter)
    requestAnimationFrame(() => {
      counter.fired = 1
      requestAnimationFrame(() => { counter.fired = 2 })
    })
  })
}

export const frameOpportunities = (page: Page): Promise<FrameOpportunities> => page.evaluate(() =>
  (Reflect.get(window, '__focus81FrameCounter') as { armed: boolean; fired: number } | undefined) ?? { armed: false, fired: 0 })

/** Advance the paused Clock in explicit 16ms ticks until the counter has delivered `wanted` opportunities or `maxTicks` ticks were spent. */
export async function advanceFrames(page: Page, wanted: number, maxTicks: number) {
  let ticks = 0
  let counter = await frameOpportunities(page)
  while (counter.fired < wanted && ticks < maxTicks) {
    await page.clock.runFor(16)
    ticks++
    counter = await frameOpportunities(page)
  }
  return { ticks, counter }
}

/* --------------------------------------------------------------------------
 * Completed native wheel witness.
 * -------------------------------------------------------------------------- */

export interface WheelCompletion {
  scroller: 'dialog' | 'window'
  pointer: { x: number; y: number }
  deltaY: number
  /** Primary-axis position (dialog scrollTop or window scrollY) before the wheel and when completion was witnessed. */
  before: number
  after: number
  moved: number
  /** Both axes of the scroller when completion was witnessed. */
  position: { x: number; y: number }
  /** Native scroll and scrollend events received by the test-owned listeners between arming and completion. */
  scrollEvents: number
  scrollEnds: number
  /** Position recorded inside the last native scrollend listener call; completion requires it to equal `after`. */
  lastScrollEndAt: number | null
  /** Host-side read-only polls spent waiting for completion. */
  polls: number
  /** Frame opportunities the test-owned counter delivered while waiting; null when no counter is armed. Must stay 0 under a paused Clock. */
  frameOpportunitiesDuring: number | null
}

interface WheelReceiptRead { before: number; scrolls: number; ends: number; lastEndAt: number | null; now: number; x: number }

/** Listen on the dialog scroller itself: element scroll/scrollend events do not bubble. */
function armDialogReceiptInPage(element: Element) {
  const state = { before: element.scrollTop, scrolls: 0, ends: 0, lastEndAt: null as number | null }
  const onScroll = () => { state.scrolls++ }
  const onEnd = () => { state.ends++; state.lastEndAt = element.scrollTop }
  element.addEventListener('scroll', onScroll)
  element.addEventListener('scrollend', onEnd)
  Reflect.set(window, '__focus81WheelReceipt', {
    read: (): WheelReceiptRead => ({ ...state, now: element.scrollTop, x: element.scrollLeft }),
    dispose: () => { element.removeEventListener('scroll', onScroll); element.removeEventListener('scrollend', onEnd) },
  })
}

/** Listen for the viewport scroller: its scroll/scrollend events are dispatched at the document. */
function armWindowReceiptInPage() {
  const state = { before: window.scrollY, scrolls: 0, ends: 0, lastEndAt: null as number | null }
  const onScroll = (event: Event) => { if (event.target === document) state.scrolls++ }
  const onEnd = (event: Event) => { if (event.target === document) { state.ends++; state.lastEndAt = window.scrollY } }
  document.addEventListener('scroll', onScroll, { capture: true })
  document.addEventListener('scrollend', onEnd, { capture: true })
  Reflect.set(window, '__focus81WheelReceipt', {
    read: (): WheelReceiptRead => ({ ...state, now: window.scrollY, x: window.scrollX }),
    dispose: () => { document.removeEventListener('scroll', onScroll, true); document.removeEventListener('scrollend', onEnd, true) },
  })
}

const readReceipt = (page: Page) => page.evaluate(() => (Reflect.get(window, '__focus81WheelReceipt') as { read: () => WheelReceiptRead }).read())
const disposeReceipt = (page: Page) => page.evaluate(() => (Reflect.get(window, '__focus81WheelReceipt') as { dispose: () => void } | undefined)?.dispose())

/**
 * A real mouse wheel over `target` (the dialog scroller; its upper body, never
 * its footer) or, with `target` null and an explicit pointer, over the page.
 * Returns only once host-side polling of plain DOM reads has witnessed the
 * intended scroller moved by more than `minMove` px AND a native scrollend
 * arrived whose recorded position equals the current position. No synthetic
 * wheel or scroll, no page timer/RAF wait, no Clock advancement and no sleep
 * stands in for that receipt; if the engine never delivers it within the
 * deadline the call fails with the last observation, as an unproven fixture,
 * not as a product result. The frame counter, when armed, is read alongside so
 * a paused-Clock caller can assert that no frame opportunity was consumed.
 */
export async function wheelUntilComplete(page: Page, target: Locator | null, deltaY: number, options: { minMove: number; pointer?: { x: number; y: number }; timeout?: number }): Promise<WheelCompletion> {
  let pointer = options.pointer
  if (target) {
    const box = await target.boundingBox()
    expect(box, 'the wheel target must have a box').not.toBeNull()
    pointer ??= { x: box!.x + box!.width / 2, y: box!.y + Math.min(box!.height / 3, 120) }
    await target.evaluate(armDialogReceiptInPage)
  } else {
    expect(pointer, 'a page wheel needs an explicit pointer position').toBeDefined()
    await page.evaluate(armWindowReceiptInPage)
  }
  const counterBefore = await frameOpportunities(page)
  const seen: { last: WheelReceiptRead | null; polls: number; framesDuring: number | null } = { last: null, polls: 0, framesDuring: counterBefore.armed ? 0 : null }
  const complete = (state: WheelReceiptRead) => Math.abs(state.now - state.before) > options.minMove
    && state.ends >= 1 && state.lastEndAt !== null && Math.abs(state.lastEndAt - state.now) <= 0.5
  const scroller = target ? 'dialog' : 'window'
  try {
    await page.mouse.move(pointer!.x, pointer!.y)
    await page.mouse.wheel(0, deltaY)
    try {
      await expect.poll(async () => {
        seen.last = await readReceipt(page)
        seen.polls++
        if (counterBefore.armed) seen.framesDuring = Math.max(seen.framesDuring ?? 0, (await frameOpportunities(page)).fired - counterBefore.fired)
        return complete(seen.last)
      }, { timeout: options.timeout ?? 8000, message: `native wheel(${deltaY}) over the ${scroller} scroller: more than ${options.minMove}px of actual movement and a native scrollend at the completed position` }).toBe(true)
    } catch (error) {
      throw new Error(`${error instanceof Error ? error.message : String(error)}\nlast observation: ${JSON.stringify(seen.last)}`)
    }
  } finally {
    await disposeReceipt(page)
  }
  const state = seen.last
  expect(state, 'the completion poll recorded an observation').not.toBeNull()
  return {
    scroller, pointer: pointer!, deltaY, before: state!.before, after: state!.now, moved: Math.round((state!.now - state!.before) * 100) / 100,
    position: { x: state!.x, y: state!.now }, scrollEvents: state!.scrolls, scrollEnds: state!.ends, lastScrollEndAt: state!.lastEndAt, polls: seen.polls, frameOpportunitiesDuring: seen.framesDuring,
  }
}

/* --------------------------------------------------------------------------
 * Host-side samples of the engaged control between explicit Clock ticks.
 * -------------------------------------------------------------------------- */

/** Same geometry as the D2 frame probe's per-frame sample, read from the host between ticks, plus identity, scroll range and background facts. */
export interface EngagedSample {
  /** Test-owned sequence number (page time ties while the Clock is paused). */
  sequence: number
  /** Frame opportunities the test-owned counter had delivered when this sample was read. */
  frame: number
  activeDescriptor: string
  /** document.activeElement is still the control marked by markEngaged. */
  sameElement: boolean
  /** The marked control is still connected. */
  connected: boolean
  top: number
  bottom: number
  portTop: number
  portBottom: number
  /** Top of a sticky footer that does not contain the control; null when the footer is in flow or absent. */
  footerTop: number | null
  dialogScrollTop: number
  dialogScrollHeight: number
  dialogClientHeight: number
  /** Border-box overlap with the port edges or the sticky footer; the same measure the D2 frame probe records. */
  overlapPx: number
  occluded: boolean
  windowScroll: { x: number; y: number }
}

/** Remember document.activeElement as the engaged control for later samples. Read-only; nothing is focused. */
export async function markEngaged(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const element = document.activeElement
    if (!(element instanceof HTMLElement) || element === document.body) return false
    Reflect.set(window, '__focus81Engaged', element)
    return true
  })
}

export async function sampleEngaged(page: Page, sequence: number): Promise<EngagedSample> {
  return page.evaluate(sequence => {
    const round = (value: number) => Math.round(value * 100) / 100
    const describe = (node: Element | null) => node ? `${node.tagName.toLowerCase()}${Array.from(node.classList).slice(0, 3).map(name => `.${name}`).join('')}` : 'none'
    const element = Reflect.get(window, '__focus81Engaged') as HTMLElement | undefined
    const counter = Reflect.get(window, '__focus81FrameCounter') as { fired: number } | undefined
    const dialog = document.querySelector<HTMLDialogElement>('dialog[open]')
    const base = {
      sequence, frame: counter?.fired ?? 0, activeDescriptor: describe(document.activeElement),
      sameElement: element !== undefined && document.activeElement === element, connected: element?.isConnected ?? false,
      windowScroll: { x: round(window.scrollX), y: round(window.scrollY) },
    }
    if (!dialog || !element) {
      return { ...base, top: Number.NaN, bottom: Number.NaN, portTop: Number.NaN, portBottom: Number.NaN, footerTop: null, dialogScrollTop: Number.NaN, dialogScrollHeight: 0, dialogClientHeight: 0, overlapPx: Number.NaN, occluded: true }
    }
    const dialogBox = dialog.getBoundingClientRect()
    const portTop = dialogBox.top + dialog.clientTop
    const portBottom = portTop + dialog.clientHeight
    const footer = dialog.querySelector<HTMLElement>(':scope > .dialog-footer')
    const footerTop = footer && getComputedStyle(footer).position === 'sticky' && !footer.contains(element) ? footer.getBoundingClientRect().top : null
    const box = element.getBoundingClientRect()
    const limit = footerTop === null ? portBottom : Math.min(portBottom, footerTop)
    const overlap = Math.max(0, box.bottom - limit, portTop - box.top)
    return {
      ...base, top: round(box.top), bottom: round(box.bottom), portTop: round(portTop), portBottom: round(portBottom), footerTop: footerTop === null ? null : round(footerTop),
      dialogScrollTop: round(dialog.scrollTop), dialogScrollHeight: dialog.scrollHeight, dialogClientHeight: dialog.clientHeight,
      overlapPx: round(overlap), occluded: overlap > 0.5 || !element.isConnected,
    }
  }, sequence)
}

/* --------------------------------------------------------------------------
 * Judged native stop without frame, readiness or screenshot waits.
 * -------------------------------------------------------------------------- */

/**
 * Probe and judge the current native stop exactly as KeyboardWalk.observe does,
 * but without the two-frame wait of pressKey and without any screenshot, so a
 * stop inside a paused-Clock critical window is still recorded and asserted
 * (judgement 'asserted', failures surfaced by walk.failures()) while no frame
 * opportunity is consumed. Capture, if wanted, happens later in the walk and is
 * labeled by its own phase; it is never presented as this instant.
 */
export async function recordNativeStop(walk: KeyboardWalk, page: Page, phase: string, key: string | null): Promise<WalkStop> {
  const probe = await probeActive(page)
  const assessment = assessStop(probe)
  const stop: WalkStop = {
    index: walk.stops.length, phase, key, name: probe.active.name, descriptor: probe.active.descriptor,
    kind: assessment.kind, judgement: 'asserted', recordOnlyReason: null, failures: assessment.failures,
    screenshot: null, screenshotAttempt: null, probe, assessment,
  }
  walk.stops.push(stop)
  return stop
}
