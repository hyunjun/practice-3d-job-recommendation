/**
 * Stage81 D2 final E2E: delayed action authority versus the current engaged
 * context (docs/design/dialog-focus-visibility.md, D2 candidate 01, SHA256
 * 4f9f5cb4…). Rows covered: 「수동 이동 후 늦은 A」, 「B 편집 후 A 때문에 실제 가림」,
 * 「버튼 복귀/닫기」, the inner-reading clause of 「긴 원문/백업 본문」, the
 * same-message fresh-result revision, the explicit composition deferral, and
 * observable regressions for the product review items AP1 (a stale gesture tail
 * must not disarm a newly engaged field) and AP3 (a visible explicit result must
 * not consume the engaged protection).
 *
 * Late completions are produced with the repository's completion-delivery hold:
 * the native IndexedDB commit happens normally and only the application's
 * completion handler waits until the test releases it. Manual movement is a real
 * mouse wheel whose completed effect on the intended scroller is witnessed by
 * host-side polling of plain DOM reads plus a native scrollend receipt before any
 * baseline is taken; an immediate scrollTop read after the wheel is never used
 * as movement proof. Real occlusion by late content is recorded by read-only
 * samples of the engaged control against the port and the sticky footer, so a
 * repair is proven to have had something to repair. The movement itself is
 * accounted for over the COMPLETE late-A interval by the ledger below, fed by a
 * scoped read-through recorder at the public scrolling entry points (labeled
 * attribution instrumentation, see helpers/dialog-focus-visibility-scroll): one
 * rich public-geometry sampler and one recorder-owned integer order produce the
 * baseline tuple T0 (read together with the route wrappers, before the held
 * completion is released), every frame or tick sample, one tuple immediately
 * before and one immediately after every recorded call, the verdict tuple Tj
 * immediately before the judged no-screenshot native stop, and the final tuple
 * Tf read when the recorder is finalized and its wrappers restored. Every
 * consecutive pair of tuples is an edge. A call's own pre→post edge is judged
 * from its pre-call geometry: an already clear control earns no movement, an
 * occluded fitting control earns only the nearest landing with 8px in total
 * (which already covers the ordinary 6px paint), capped by the measured range,
 * within 1px, and inner, other and window operations earn no dialog movement.
 * Every other edge must be quiet, a measured clamp projection onto a shrunken
 * range, or a native-layout residual with attached content/footer/range
 * evidence. Nested recorded calls, missing or interleaved tuples, overflow and
 * recorder errors fail closed. T0 and Tf carry their own clear-B gates. Across
 * the whole stream every tuple keeps the window scroll and the horizontal dialog
 * offset within 0.5px of T0 (the vertical dialog offset is judged per call and
 * per edge and is never locked to T0, so valid repairs stay legitimate). Tj..Tf
 * is a separately labeled final-stability prerequisite: every observed tuple
 * between the judged stop and Tf, call tuples included, must be the same
 * connected focused positive coherent B within 0.5px of Tj's outer, horizontal
 * and window offsets with no owned call, so an excursion that cancels by Tf
 * still fails; it certifies nothing about facts outside those, so the full D1
 * stop stays independently required. No prefix is excused by its
 * position, no notice height is a cushion, and the absence of a frame is never a
 * native proof. The "destination not navigated" check reads where the message
 * block sits relative to the dialog port. Two cases install the Clock before
 * navigation and pause it only once the view settled: the AP1 race, which holds
 * page time and requestAnimationFrame through the final B engagement so the
 * stale gesture tail cannot be drained by observation waits, and the
 * frame-deferred page restore, exactly as the stage80 guards do. The composition
 * case dispatches explicit composition events on the focused textarea: it
 * exercises the composition listeners, not an OS IME.
 *
 * Not covered in THIS spec: AP2 (a held native scrollbar drag) lives in the
 * separate lifecycle spec, whose browser is launched with a narrowly scoped
 * override of Playwright's default hide-scrollbars argument and which still
 * requires a rendered classic scrollbar and real native movement; its native
 * prerequisites remain unverified until execution. Static-only boundary: AP4
 * (deferred sizing of a dialog retained beneath another modal) has no reachable
 * state in this application, which replaces modals instead of stacking them.
 */
import { expect } from '@playwright/test'
import type { Locator, Page } from '@playwright/test'
import type { SavedJob } from '../../shared/types'
import {
  activeElementDescriptor, closeButton, expectAbsentFromStorage, footerToggle, holdCompletionDelivery, literalOf, openDetailByKeyboard, openSavedView, pageScroll,
  pauseContextClock, pressTabUntil, queueFrameProbe, recoveryEntry, removeCardByKeyboard, seedSaved, test, titleButton, undoOf,
} from './helpers/saved-removal-undo'
import { readCommitted } from './helpers/saved-lifecycle'
import { waitForSavedCommit } from './helpers/saved-store'
import { BACKUP_FOOTER_TEXT, BEACON, KeyboardWalk, LABEL, LANTERN, LEGACY_UNREADABLE_ENTRY, assessStop, expectLayoutReady, openSavedViewPlain, pressKey, probeActive, seedSavedWithoutClock, walkUntil } from './helpers/dialog-focus-visibility'
import type { WalkStop } from './helpers/dialog-focus-visibility'
import {
  D2_CONTRACT, D2_LABEL, HARBOR, HARBOR_INCOMING, IMPORT_ROWS, READER_NOTE, caretGeometry, dispatchComposition, installFrameProbe, loadBackupFile, openBackupByKeyboard,
  openLanternDetail, placement, readFrameProbe, scrollTopOf, settleLayout,
} from './helpers/dialog-focus-visibility-d2'
import type { CaretGeometry, FrameProbeResult, FrameSample } from './helpers/dialog-focus-visibility-d2'
import { advanceFrames, armFrameCounter, frameOpportunities, markEngaged, recordNativeStop, sampleEngaged, wheelUntilComplete } from './helpers/dialog-focus-visibility-timing'
import type { EngagedSample, WheelCompletion } from './helpers/dialog-focus-visibility-timing'
import { SCROLL_ROUTES, finalizeScrollRouteRecorder, installScrollRouteRecorder, sampleRecorderTuple } from './helpers/dialog-focus-visibility-scroll'
import type { RecorderInstall, RecorderTuple, ScrollRouteRecord, ScrollRouteSnapshot } from './helpers/dialog-focus-visibility-scroll'

interface Viewport { width: number; height: number }
const tag = (viewport: Viewport) => `${viewport.width}x${viewport.height}`
const UNDO_VIEWPORTS: Viewport[] = [{ width: 1440, height: 960 }, { width: 320, height: 800 }]
const asserted = (stop: WalkStop) => stop.judgement === 'asserted'
const HOLD_NOTE = 'Completion-delivery hold: the native readwrite commit on the saved database happens normally; only the application completion handler waits until release().'

test.describe.configure({ timeout: 150_000 })

type Hold = Awaited<ReturnType<typeof holdCompletionDelivery>>
async function awaitHeldCompletion(hold: Hold) {
  await expect.poll(() => hold.completed(), { message: 'the native readwrite completion fired while its delivery is held' }).toBeGreaterThanOrEqual(1)
  expect(await hold.delivered(), 'no application handler ran while held').toBe(0)
}

const CLOCK_NOTE = 'Clock fixture (labeled): Playwright\'s public Clock is installed before navigation and paused only after the view and the held operation settled. While paused, page Date/performance/timers/requestAnimationFrame stop; native input, layout, scroll/scrollend events, observers, microtasks and Playwright\'s injected scripts keep running. Ordering is recorded with test-owned sequence numbers and frame counts, never with page timestamps.'
const RECORDER_NOTE = 'Scroll-route recorder (labeled attribution instrumentation): nine public scrolling routes (Element scrollTo/scroll/scrollBy/scrollIntoView, the Element scrollTop setter, HTMLElement focus, window scrollTo/scroll/scrollBy) are wrapped transactionally in one evaluation together with the baseline tuple T0; each call forwards the original once, unchanged, with one rich tuple immediately before and one immediately after it; a recorder-owned read-only frame sampler (real time) or host evaluations after explicit ticks (paused Clock) add the remaining tuples; the verdict tuple Tj is read immediately before the judged no-screenshot native stop; finalization cancels the sampler, reads Tf, collects every tuple and record and restores every wrapper in one evaluation. One integer order, allocated after each complete synchronous read, orders everything; performance.now is diagnostic only. A tuple\'s coherent flag certifies only that its rechecked facts did not change within that one evaluation. Every tuple in the complete T0..Tf stream keeps the window scroll and the horizontal dialog offset within 0.5px of T0 (the vertical dialog offset is never locked to T0). The Tj..Tf bracket is a final-stability prerequisite judged against every observed tuple in it, call tuples included (no owned call; the same connected focused positive coherent B; outer, horizontal and window offsets within 0.5px of Tj), so a cancelling excursion still fails; it does not establish that every D1 fact is identical at Tf, so the full D1 stop and the Tf control/paint gate remain independently required. Public geometry reads flush layout and may end a scroll-anchoring suppression window; descriptor wrapping, synchronous forwarding and the sampler\'s own cost are unexecuted transparency prerequisites.'

/** The geometry shared by the D2 frame probe's per-frame samples (AP3) and the recorder tuples: the engaged control's border box against the port edges and a sticky footer. */
type MovementSample = Pick<FrameSample, 'sameElement' | 'overlapPx' | 'top' | 'bottom' | 'portTop' | 'portBottom' | 'footerTop' | 'dialogScrollTop'> & { connected?: boolean }
/** Genuine geometric occlusion of the same connected, focused control; a disconnected or unfocused control is never counted as occluded here. */
const occludedSample = (sample: MovementSample) => sample.sameElement && (sample.connected ?? true) && sample.overlapPx > 0.5
const clearSample = (sample: MovementSample) => sample.sameElement && (sample.connected ?? true) && sample.overlapPx <= 0.5

/** Occlusion evidence from a sample series: the connected, focused control was genuinely occluded in at least one sample before a later sample shows it clear. */
function occlusionEvidence(samples: MovementSample[]) {
  const firstOccluded = samples.findIndex(occludedSample)
  const clearedAfter = firstOccluded >= 0 && samples.slice(firstOccluded).some(clearSample)
  const focusKept = samples.every(sample => sample.sameElement)
  return { frames: samples.length, firstOccluded, clearedAfter, focusKept }
}

/** A recorder tuple in the movement-sample shape: focus on the marked B, the visible proxy's border box against the dialog client box and the sticky footer. */
const movementOf = (tuple: RecorderTuple): MovementSample => ({
  sameElement: tuple.engaged?.focused ?? false, connected: tuple.engaged?.connected ?? false, overlapPx: tuple.engaged?.overlapPx ?? Number.NaN,
  top: tuple.engaged?.rect.top ?? Number.NaN, bottom: tuple.engaged?.rect.bottom ?? Number.NaN, portTop: tuple.dialogClient?.top ?? Number.NaN, portBottom: tuple.dialogClient?.bottom ?? Number.NaN,
  footerTop: tuple.footer && tuple.footer.position === 'sticky' && !tuple.footer.containsEngaged ? tuple.footer.top : null, dialogScrollTop: tuple.dialogScrollTop,
})

/** Public D2 landing allowance: 8px in total from the control's border box, already covering the ordinary 2px outline plus 4px offset. It is never added twice. */
const LANDING_ALLOWANCE_PX = 8
/** The contract's 0.5px write gate for unchanged geometry; applied to edges and to calls that must not move anything. */
const STABILITY_TOLERANCE_PX = 0.5
/** Landing tolerance for an owned repair: the 0.5px write gate plus 0.5px of geometry rounding. */
const LANDING_TOLERANCE_PX = 1
const round2 = (value: number) => Math.round(value * 100) / 100

/** The same connected, focused B with a positive finite proxy box, inside a connected dialog. */
const sameEngaged = (tuple: RecorderTuple) => tuple.dialogConnected && tuple.engaged !== null && tuple.engaged.connected && tuple.engaged.focused && tuple.engaged.positiveFinite
/** Endpoint gate (R8-1): the same connected focused B with its control and painted indicator inside the clip measured in this very tuple, read coherently. */
const endpointClear = (tuple: RecorderTuple) => sameEngaged(tuple) && tuple.engaged!.paintInsideClip && tuple.coherent
/** Routes that set an offset directly; they can move only their own receiver's scroller. scrollIntoView and focus can move the dialog from a descendant. */
const DIRECT_OFFSET_ROUTES = new Set<string>(['Element.scrollTo', 'Element.scroll', 'Element.scrollBy', 'Element.scrollTop=', 'window.scrollTo', 'window.scroll', 'window.scrollBy'])

interface CallVerdict {
  callSequence: number; method: string; receiver: string; relevance: ScrollRouteRecord['relevance']; depth: number
  displacement: number | null
  preState: 'clear' | 'occluded' | 'unmeasured'
  movement: 'none' | 'landing' | 'forbidden' | 'unmeasured'
  expected: number | null
  /** A valid nonzero owned landing of a genuinely occluded B. */
  repair: boolean
  pass: boolean
  reasons: string[]
}

/** The nearest landing for an occluded B from one pre-call tuple: border box plus the 8px total allowance aligned to the clip edge on the occluded side, entry edge when it does not fit, converted to scroll pixels with the measured scale and capped by the measured range. */
function nearestLanding(pre: RecorderTuple) {
  const { rect, clip } = pre.engaged!
  const top = rect.top - LANDING_ALLOWANCE_PX
  const bottom = rect.bottom + LANDING_ALLOWANCE_PX
  const fits = bottom - top <= clip.bottom - clip.top
  let visual: number
  let side: 'top' | 'bottom'
  if (!fits || top < clip.top) { visual = top - clip.top; side = 'top' }
  else if (bottom > clip.bottom) { visual = bottom - clip.bottom; side = 'bottom' }
  else { visual = 0; side = rect.top < clip.top ? 'top' : 'bottom' }
  const scroll = round2(Math.min(pre.range, Math.max(0, pre.dialogScrollTop + visual / pre.scale)) - pre.dialogScrollTop)
  return { visual: round2(visual), scroll, side }
}

/**
 * Judge one recorded call (any relevance, any depth) from its OWN pre/post
 * tuples. Context first: the same connected focused positive B at both ends,
 * coherent tuples, unchanged horizontal dialog offset and window scroll. Then
 * movement: a call that moved the dialog by at most the write gate is a
 * no-movement call; a direct offset operation on anything but the dialog's own
 * scroller, and any window route, earns no dialog movement; a dialog scroll or a
 * descendant scrollIntoView/focus that moved the dialog must find B's paint
 * outside the clip and must land exactly at the nearest landing. Recorded call
 * parameters are diagnostics only and never the expected answer.
 */
function judgeCall(record: ScrollRouteRecord): CallVerdict {
  const base = { callSequence: record.callSequence, method: record.method, receiver: record.receiver, relevance: record.relevance, depth: record.depth }
  const reasons: string[] = []
  if (record.depth > 0) reasons.push(`nested inside recorded call ${record.parent} (a flat recorded stream is a prerequisite of this ledger)`)
  if (record.threw) reasons.push('the native call threw')
  if (record.error) reasons.push(`recorder bookkeeping failed: ${record.error}`)
  const { pre, post } = record
  if (!pre || !post || !pre.engaged || !post.engaged || !pre.dialogConnected || !post.dialogConnected) {
    return { ...base, displacement: null, preState: 'unmeasured', movement: 'unmeasured', expected: null, repair: false, pass: false, reasons: [...reasons, 'pre/post tuple or engaged facts unavailable'] }
  }
  if (!sameEngaged(pre) || !sameEngaged(post)) reasons.push(`B is not the same connected focused positive control across the call (pre focused ${pre.engaged.focused}/connected ${pre.engaged.connected}, post focused ${post.engaged.focused}/connected ${post.engaged.connected})`)
  if (!pre.coherent || !post.coherent) reasons.push(`incoherent call tuple (${[...pre.incoherentFacts, ...post.incoherentFacts].join(', ')})`)
  if (Math.abs(post.dialogScrollLeft - pre.dialogScrollLeft) > STABILITY_TOLERANCE_PX) reasons.push(`horizontal dialog offset changed ${pre.dialogScrollLeft} → ${post.dialogScrollLeft}`)
  if (Math.abs(post.windowScroll.x - pre.windowScroll.x) > STABILITY_TOLERANCE_PX || Math.abs(post.windowScroll.y - pre.windowScroll.y) > STABILITY_TOLERANCE_PX) reasons.push(`window scroll changed (${pre.windowScroll.x}, ${pre.windowScroll.y}) → (${post.windowScroll.x}, ${post.windowScroll.y})`)
  const displacement = round2(post.dialogScrollTop - pre.dialogScrollTop)
  const preState = pre.engaged.paintInsideClip ? 'clear' : 'occluded'
  if (Math.abs(displacement) <= STABILITY_TOLERANCE_PX) return { ...base, displacement, preState, movement: 'none', expected: 0, repair: false, pass: reasons.length === 0, reasons }
  const direct = DIRECT_OFFSET_ROUTES.has(record.method)
  const mayMoveDialog = direct ? record.relevance === 'dialog' : record.relevance === 'dialog' || record.relevance === 'descendant'
  if (!mayMoveDialog) return { ...base, displacement, preState, movement: 'forbidden', expected: 0, repair: false, pass: false, reasons: [...reasons, `${record.method} on a ${record.relevance} receiver (${record.receiver}) moved the dialog by ${displacement}px; this operation earns no outer-dialog movement`] }
  if (preState === 'clear') return { ...base, displacement, preState, movement: 'landing', expected: 0, repair: false, pass: false, reasons: [...reasons, `moved ${displacement}px although control and paint were already inside the clip`] }
  const landing = nearestLanding(pre)
  if (Math.abs(displacement - landing.scroll) > LANDING_TOLERANCE_PX) reasons.push(`owned ${displacement}px but the nearest ${landing.side} landing from this call's own geometry is ${landing.scroll}px (visual ${landing.visual}px at scale ${pre.scale}, range 0..${pre.range})`)
  return { ...base, displacement, preState, movement: 'landing', expected: landing.scroll, repair: reasons.length === 0, pass: reasons.length === 0, reasons }
}

interface LedgerEdge {
  from: number; to: number
  fromRole: RecorderTuple['role']; toRole: RecorderTuple['role']; fromLabel: string | null; toLabel: string | null
  kind: 'owned' | 'quiet' | 'native-clamp' | 'native-layout' | 'unexplained' | 'context-broken' | 'interleaved'
  call: number | null
  delta: number
  contentShift: number | null
  footerShift: number | null
  rangeChange: number
  clampProjection: number
  pass: boolean
  evidence: string
}

/**
 * Judge one edge between consecutive tuples with no recorded call inside it.
 * Context first (same connected focused positive B at both ends, coherent
 * tuples, unchanged horizontal and window offsets). Then: quiet (0.5px); the
 * projection of the previous offset onto a measured shrunken range (clamp); or a
 * native-layout residual beside an actual content, footer or range change, with
 * its measurements attached and valid only under the asserted route coverage,
 * integer order and sealed input (the browser's anchor is never named). Anything
 * else is unexplained and fails. Nothing is excused by its position in the series.
 */
function judgeUnownedEdge(from: RecorderTuple, to: RecorderTuple): LedgerEdge {
  const base = { from: from.sequence, to: to.sequence, fromRole: from.role, toRole: to.role, fromLabel: from.label, toLabel: to.label, call: null }
  const delta = round2(to.dialogScrollTop - from.dialogScrollTop)
  const contentShift = from.engaged && to.engaged ? round2(to.engaged.contentTop - from.engaged.contentTop) : null
  const footerShift = from.footer && to.footer ? round2(to.footer.top - from.footer.top) : from.footer || to.footer ? Number.NaN : null
  const rangeChange = to.range - from.range
  const clampProjection = from.dialogScrollTop > to.range + STABILITY_TOLERANCE_PX ? round2(to.range - from.dialogScrollTop) : 0
  const facts = { delta, contentShift, footerShift, rangeChange, clampProjection }
  const context: string[] = []
  if (!sameEngaged(from) || !sameEngaged(to)) context.push('B is not the same connected focused positive control at both ends')
  if (!from.coherent || !to.coherent) context.push(`incoherent tuple (${[...from.incoherentFacts, ...to.incoherentFacts].join(', ')})`)
  if (Math.abs(to.dialogScrollLeft - from.dialogScrollLeft) > STABILITY_TOLERANCE_PX) context.push(`horizontal dialog offset changed ${from.dialogScrollLeft} → ${to.dialogScrollLeft}`)
  if (Math.abs(to.windowScroll.x - from.windowScroll.x) > STABILITY_TOLERANCE_PX || Math.abs(to.windowScroll.y - from.windowScroll.y) > STABILITY_TOLERANCE_PX) context.push('window scroll changed')
  if (context.length) return { ...base, ...facts, kind: 'context-broken', pass: false, evidence: context.join('; ') }
  if (Math.abs(delta) <= STABILITY_TOLERANCE_PX) return { ...base, ...facts, kind: 'quiet', pass: true, evidence: 'offset unchanged' }
  if (clampProjection !== 0 && Math.abs(delta - clampProjection) <= STABILITY_TOLERANCE_PX) return { ...base, ...facts, kind: 'native-clamp', pass: true, evidence: `the previous offset ${from.dialogScrollTop} left the measured range 0..${to.range}; projection ${clampProjection}px` }
  const layoutChanged = (contentShift !== null && Math.abs(contentShift) > STABILITY_TOLERANCE_PX) || (footerShift !== null && (Number.isNaN(footerShift) || Math.abs(footerShift) > STABILITY_TOLERANCE_PX)) || rangeChange !== 0
  if (layoutChanged) return { ...base, ...facts, kind: 'native-layout', pass: true, evidence: `no recorded call inside; B content top shift ${contentShift}px, footer shift ${footerShift}px, range change ${rangeChange}px, each from its own client origin and scale; valid only under the asserted route coverage, integer order and sealed input; the anchor is not named` }
  return { ...base, ...facts, kind: 'unexplained', pass: false, evidence: `offset changed ${delta}px with no recorded call and no measured layout change` }
}

interface EndpointReport { name: 'T0' | 'Tf'; sequence: number | null; sameEngaged: boolean; paintInsideClip: boolean; positiveFinite: boolean; coherent: boolean; pass: boolean; detail: string }
/** One tuple of the sorted stream with the record and end it belongs to (null for external tuples). */
interface StreamEntry { tuple: RecorderTuple; record: ScrollRouteRecord | null; end: 'pre' | 'post' | null }
/** A tuple observed inside Tj..Tf (external or call pre/post) that left Tj's state, with its measured deltas. */
interface BracketOffender { sequence: number; role: RecorderTuple['role']; label: string | null; call: number | null; sameEngaged: boolean; coherent: boolean; incoherentFacts: string[]; offsetDelta: number; horizontalDelta: number; windowDelta: { x: number; y: number } }
interface BracketReport {
  tj: number | null; tf: number | null; edgesInside: number; tuplesInside: number; ownedEdgesInside: number[]
  /** AIR11-1: every observed tuple in Tj..Tf inclusive that is not the same connected focused positive coherent B within 0.5px of Tj's outer, horizontal and window offsets. */
  offenders: BracketOffender[]
  /** Tj→Tf endpoint deltas; diagnostic only, the tuple-wise offenders decide stability. */
  offsetDelta: number | null; horizontalDelta: number | null; windowDelta: { x: number; y: number } | null
  contentShift: number | null; footerShift: number | null; clipDelta: { top: number; bottom: number } | null; paintDelta: { top: number; bottom: number } | null
  stable: boolean; detail: string
}
/** A tuple of the complete T0..Tf stream whose window scroll or horizontal dialog offset left T0's baseline by more than 0.5px, or carries non-finite data. */
interface BaselineOffender { sequence: number; role: RecorderTuple['role']; label: string | null; call: number | null; windowScroll: { x: number; y: number }; dialogScrollLeft: number; windowDelta: { x: number; y: number }; horizontalDelta: number }
/** AIR11-2: the whole-stream window/horizontal baseline against T0. The vertical dialog offset is judged per call and per edge and is never locked to T0. */
interface BaselineReport { t0: { sequence: number; windowScroll: { x: number; y: number }; dialogScrollLeft: number } | null; usable: boolean; checked: number; offenders: BaselineOffender[] }
interface Ledger {
  /** The complete stream in integer order: every external tuple and every call pre/post tuple. */
  stream: { sequence: number; role: RecorderTuple['role']; label: string | null; call: number | null }[]
  integrity: string[]
  edges: LedgerEdge[]
  calls: CallVerdict[]
  /** Valid nonzero owned repairs of a genuinely occluded B. */
  repairs: number
  endpoints: { t0: EndpointReport; tf: EndpointReport }
  baseline: BaselineReport
  bracket: BracketReport
}

const endpointReport = (tuple: RecorderTuple | null, name: EndpointReport['name']): EndpointReport => {
  if (!tuple) return { name, sequence: null, sameEngaged: false, paintInsideClip: false, positiveFinite: false, coherent: false, pass: false, detail: `${name} is missing from the stream` }
  const pass = endpointClear(tuple)
  return {
    name, sequence: tuple.sequence, sameEngaged: sameEngaged(tuple), paintInsideClip: tuple.engaged?.paintInsideClip ?? false, positiveFinite: tuple.engaged?.positiveFinite ?? false, coherent: tuple.coherent, pass,
    detail: pass ? `${name}: the same connected focused B with control and paint inside the clip measured in ${name}` : `${name} fails its clear-B gate: ${JSON.stringify({ engaged: tuple.engaged, coherent: tuple.coherent, incoherentFacts: tuple.incoherentFacts })}`,
  }
}

/** A1 with AIR11-1: the final-stability prerequisite judged against EVERY observed tuple in Tj..Tf inclusive, call pre/post tuples included, so an excursion that cancels by Tf still fails. Endpoint deltas stay diagnostic. */
const bracketReport = (tj: RecorderTuple | null, tf: RecorderTuple | null, edges: LedgerEdge[], entries: StreamEntry[]): BracketReport => {
  const empty = { edgesInside: 0, tuplesInside: 0, ownedEdgesInside: [], offenders: [], offsetDelta: null, horizontalDelta: null, windowDelta: null, contentShift: null, footerShift: null, clipDelta: null, paintDelta: null }
  if (!tj || !tf) return { tj: tj?.sequence ?? null, tf: tf?.sequence ?? null, ...empty, stable: false, detail: 'UNSTABLE_FINAL_VERDICT_PREREQUISITE: Tj or Tf is missing' }
  const inside = edges.filter(edge => edge.from >= tj.sequence && edge.to <= tf.sequence)
  const ownedEdgesInside = inside.filter(edge => edge.kind === 'owned').map(edge => edge.call!)
  const within = entries.filter(entry => entry.tuple.sequence >= tj.sequence && entry.tuple.sequence <= tf.sequence)
  const offenders: BracketOffender[] = []
  for (const entry of within) {
    const tuple = entry.tuple
    const offsetDelta = round2(tuple.dialogScrollTop - tj.dialogScrollTop)
    const horizontalDelta = round2(tuple.dialogScrollLeft - tj.dialogScrollLeft)
    const windowDelta = { x: round2(tuple.windowScroll.x - tj.windowScroll.x), y: round2(tuple.windowScroll.y - tj.windowScroll.y) }
    // Non-finite deltas fail these comparisons, so unusable data is an offender, never a pass.
    const held = sameEngaged(tuple) && tuple.coherent && Math.abs(offsetDelta) <= STABILITY_TOLERANCE_PX && Math.abs(horizontalDelta) <= STABILITY_TOLERANCE_PX && Math.abs(windowDelta.x) <= STABILITY_TOLERANCE_PX && Math.abs(windowDelta.y) <= STABILITY_TOLERANCE_PX
    if (!held) offenders.push({ sequence: tuple.sequence, role: tuple.role, label: tuple.label, call: entry.record?.callSequence ?? null, sameEngaged: sameEngaged(tuple), coherent: tuple.coherent, incoherentFacts: tuple.incoherentFacts, offsetDelta, horizontalDelta, windowDelta })
  }
  const offsetDelta = round2(tf.dialogScrollTop - tj.dialogScrollTop)
  const horizontalDelta = round2(tf.dialogScrollLeft - tj.dialogScrollLeft)
  const windowDelta = { x: round2(tf.windowScroll.x - tj.windowScroll.x), y: round2(tf.windowScroll.y - tj.windowScroll.y) }
  const contentShift = tj.engaged && tf.engaged ? round2(tf.engaged.contentTop - tj.engaged.contentTop) : null
  const footerShift = tj.footer && tf.footer ? round2(tf.footer.top - tj.footer.top) : null
  const clipDelta = tj.engaged && tf.engaged ? { top: round2(tf.engaged.clip.top - tj.engaged.clip.top), bottom: round2(tf.engaged.clip.bottom - tj.engaged.clip.bottom) } : null
  const paintDelta = tj.engaged && tf.engaged ? { top: round2(tf.engaged.paint.top - tj.engaged.paint.top), bottom: round2(tf.engaged.paint.bottom - tj.engaged.paint.bottom) } : null
  const problems: string[] = []
  if (ownedEdgesInside.length) problems.push(`owned call edge(s) ${ownedEdgesInside.join(', ')} ran inside Tj..Tf`)
  if (offenders.length) problems.push(`${offenders.length} of ${within.length} observed tuple(s) in Tj..Tf left Tj's state (same connected focused positive coherent B; outer, horizontal and window offsets within ${STABILITY_TOLERANCE_PX}px of Tj): ${JSON.stringify(offenders)}`)
  if (!endpointClear(tf)) problems.push('Tf does not pass its control/paint-inside-clip gate')
  return {
    tj: tj.sequence, tf: tf.sequence, edgesInside: inside.length, tuplesInside: within.length, ownedEdgesInside, offenders, offsetDelta, horizontalDelta, windowDelta, contentShift, footerShift, clipDelta, paintDelta,
    stable: problems.length === 0,
    detail: problems.length ? `UNSTABLE_FINAL_VERDICT_PREREQUISITE: ${problems.join('; ')}` : `stable final bracket: no owned call edge; every one of the ${within.length} observed tuples in Tj..Tf is the same connected focused positive coherent B within ${STABILITY_TOLERANCE_PX}px of Tj's outer, horizontal and window offsets; Tf clear`,
  }
}

/** AIR11-2: compare every tuple of the complete stream (external and call pre/post) with T0's window scroll and horizontal dialog offset; a non-finite T0 makes the baseline unusable. */
const baselineReport = (t0: RecorderTuple | null, entries: StreamEntry[]): BaselineReport => {
  if (!t0) return { t0: null, usable: false, checked: 0, offenders: [] }
  const usable = Number.isFinite(t0.windowScroll.x) && Number.isFinite(t0.windowScroll.y) && Number.isFinite(t0.dialogScrollLeft)
  const offenders: BaselineOffender[] = []
  if (usable) {
    for (const entry of entries) {
      const tuple = entry.tuple
      const windowDelta = { x: round2(tuple.windowScroll.x - t0.windowScroll.x), y: round2(tuple.windowScroll.y - t0.windowScroll.y) }
      const horizontalDelta = round2(tuple.dialogScrollLeft - t0.dialogScrollLeft)
      // Non-finite deltas fail these comparisons, so a tuple without usable data is an offender, never a pass.
      const held = Math.abs(windowDelta.x) <= STABILITY_TOLERANCE_PX && Math.abs(windowDelta.y) <= STABILITY_TOLERANCE_PX && Math.abs(horizontalDelta) <= STABILITY_TOLERANCE_PX
      if (!held) offenders.push({ sequence: tuple.sequence, role: tuple.role, label: tuple.label, call: entry.record?.callSequence ?? null, windowScroll: tuple.windowScroll, dialogScrollLeft: tuple.dialogScrollLeft, windowDelta, horizontalDelta })
    }
  }
  return { t0: { sequence: t0.sequence, windowScroll: t0.windowScroll, dialogScrollLeft: t0.dialogScrollLeft }, usable, checked: usable ? entries.length : 0, offenders }
}

/** Assemble the complete stream and judge it. Never throws: every problem becomes an integrity entry, a failing verdict or a failing edge, so the attachments stay complete on failure. */
function buildLedger(snapshot: ScrollRouteSnapshot): Ledger {
  const integrity: string[] = []
  const entries: StreamEntry[] = snapshot.tuples.map(tuple => ({ tuple, record: null, end: null }))
  for (const record of snapshot.records) {
    if (record.pre) entries.push({ tuple: record.pre, record, end: 'pre' }); else integrity.push(`call ${record.callSequence} ${record.method} has no pre tuple`)
    if (record.post) entries.push({ tuple: record.post, record, end: 'post' }); else integrity.push(`call ${record.callSequence} ${record.method} has no post tuple`)
  }
  entries.sort((left, right) => left.tuple.sequence - right.tuple.sequence)
  for (let index = 1; index < entries.length; index++) if (entries[index].tuple.sequence === entries[index - 1].tuple.sequence) integrity.push(`duplicate sequence ${entries[index].tuple.sequence}`)
  const t0 = entries.find(entry => entry.tuple.role === 'baseline')?.tuple ?? null
  const tf = entries.find(entry => entry.tuple.role === 'final')?.tuple ?? null
  const tj = entries.find(entry => entry.tuple.role === 'verdict')?.tuple ?? null
  const count = (role: RecorderTuple['role']) => entries.filter(entry => entry.tuple.role === role).length
  if (count('baseline') !== 1) integrity.push(`${count('baseline')} baseline tuple(s)`)
  if (count('final') !== 1) integrity.push(`${count('final')} final tuple(s)`)
  if (count('verdict') !== 1) integrity.push(`${count('verdict')} verdict tuple(s)`)
  if (entries.length && entries[0].tuple.role !== 'baseline') integrity.push(`the stream starts with ${entries[0].tuple.role} ${entries[0].tuple.sequence}, not T0`)
  if (entries.length && entries[entries.length - 1].tuple.role !== 'final') integrity.push(`the stream ends with ${entries[entries.length - 1].tuple.role} ${entries[entries.length - 1].tuple.sequence}, not Tf`)
  if (tj && tf && tj.sequence > tf.sequence) integrity.push('Tj is after Tf')
  if (!snapshot.finalized) integrity.push('the recorder was not finalized')
  if (snapshot.nested > 0) integrity.push(`${snapshot.nested} nested recorded call(s)`)
  if (snapshot.overflow) integrity.push(`recorder overflow (${snapshot.dropped} dropped)`)
  for (const error of snapshot.errors) integrity.push(`recorder error: ${error}`)
  const calls = snapshot.records.map(judgeCall)
  const edges: LedgerEdge[] = []
  for (let index = 1; index < entries.length; index++) {
    const left = entries[index - 1]
    const right = entries[index]
    if (left.end === 'pre' && right.end === 'post' && left.record !== null && left.record === right.record) {
      const verdict = calls.find(candidate => candidate.callSequence === left.record!.callSequence)!
      const contentShift = left.tuple.engaged && right.tuple.engaged ? round2(right.tuple.engaged.contentTop - left.tuple.engaged.contentTop) : null
      const footerShift = left.tuple.footer && right.tuple.footer ? round2(right.tuple.footer.top - left.tuple.footer.top) : null
      edges.push({
        from: left.tuple.sequence, to: right.tuple.sequence, fromRole: left.tuple.role, toRole: right.tuple.role, fromLabel: left.tuple.label, toLabel: right.tuple.label, kind: 'owned', call: left.record.callSequence,
        delta: verdict.displacement ?? Number.NaN, contentShift, footerShift, rangeChange: right.tuple.range - left.tuple.range, clampProjection: 0, pass: verdict.pass,
        evidence: verdict.reasons.length ? verdict.reasons.join('; ') : `${verdict.method}: ${verdict.movement}${verdict.expected !== null ? `, expected ${verdict.expected}px` : ''}, pre ${verdict.preState}`,
      })
      continue
    }
    if (left.end === 'pre' || right.end === 'post') {
      integrity.push(`call tuple ${left.end === 'pre' ? left.tuple.sequence : right.tuple.sequence} is not adjacent to its own ${left.end === 'pre' ? 'post' : 'pre'} tuple (nested or interleaved)`)
      edges.push({ from: left.tuple.sequence, to: right.tuple.sequence, fromRole: left.tuple.role, toRole: right.tuple.role, fromLabel: left.tuple.label, toLabel: right.tuple.label, kind: 'interleaved', call: left.record?.callSequence ?? right.record?.callSequence ?? null, delta: round2(right.tuple.dialogScrollTop - left.tuple.dialogScrollTop), contentShift: null, footerShift: null, rangeChange: right.tuple.range - left.tuple.range, clampProjection: 0, pass: false, evidence: 'call pre/post tuples are not adjacent' })
      continue
    }
    edges.push(judgeUnownedEdge(left.tuple, right.tuple))
  }
  const repairs = calls.filter(verdict => verdict.repair && Math.abs(verdict.displacement ?? 0) > STABILITY_TOLERANCE_PX).length
  // AIR11-2 over the complete sorted stream (external and call pre/post tuples); the vertical dialog offset is judged per call and per edge above and is never locked to T0.
  const baseline = baselineReport(t0, entries)
  if (!t0) integrity.push('no T0 for the window/horizontal baseline')
  else if (!baseline.usable) integrity.push(`T0 ${t0.sequence} has a non-finite window scroll or horizontal offset; the whole-stream baseline is unusable`)
  return {
    stream: entries.map(entry => ({ sequence: entry.tuple.sequence, role: entry.tuple.role, label: entry.tuple.label, call: entry.record?.callSequence ?? null })),
    integrity, edges, calls, repairs, endpoints: { t0: endpointReport(t0, 'T0'), tf: endpointReport(tf, 'Tf') }, baseline, bracket: bracketReport(tj, tf, edges, entries),
  }
}

interface RecorderState { snapshot: ScrollRouteSnapshot | null; ledger: Ledger | null; finalizeError: string | null }
const recorderState = (): RecorderState => ({ snapshot: null, ledger: null, finalizeError: null })
/** The collected stream, asserted present before any post-hoc read so a missing recorder fails as such and not as a TypeError. */
function collectedStream(recorder: RecorderState, label: string): ScrollRouteSnapshot {
  expect(recorder.finalizeError, `${label}: the recorder finalized without error`).toBeNull()
  expect(recorder.snapshot, `${label}: the recorder stream was collected`).not.toBeNull()
  return recorder.snapshot!
}
/** Finalize once: the body's result is kept; `finally` only finalizes when the body did not, retaining partial diagnostics on failure. */
async function finalizeIfNeeded(recorder: RecorderState, page: Page) {
  if (recorder.snapshot) return
  try {
    recorder.snapshot = await finalizeScrollRouteRecorder(page)
    recorder.ledger = recorder.snapshot ? buildLedger(recorder.snapshot) : null
  } catch (error) {
    recorder.finalizeError = error instanceof Error ? error.message : String(error)
  }
}

/** The whole-interval verdict over the complete T0..Tf stream. */
function expectAccountedMovement(recorder: RecorderState, label: string) {
  expect(recorder.finalizeError, `${label}: the recorder finalized without error`).toBeNull()
  expect(recorder.snapshot, `${label}: the recorder stream was collected`).not.toBeNull()
  expect(recorder.ledger, `${label}: the ledger was built`).not.toBeNull()
  const snapshot = recorder.snapshot!
  const ledger = recorder.ledger!
  expect(snapshot.wrapped, `${label}: the recorder covered every public scrolling route`).toEqual([...SCROLL_ROUTES])
  expect(snapshot.restored, `${label}: every wrapper was restored at finalization, in reverse order`).toEqual([...SCROLL_ROUTES].reverse())
  expect(ledger.integrity, `${label}: one complete flat stream from T0 through Tf in unique integer order, every call paired with adjacent pre/post tuples, exactly one verdict tuple, no nested call, no overflow, no recorder error`).toEqual([])
  expect(ledger.calls.filter(verdict => !verdict.pass), `${label}: every recorded call keeps the same connected focused B, the window and the horizontal offset, and any dialog movement is the nearest landing (8px total, range cap, 1px) of a genuinely occluded B from that call's own pre geometry; a clear B earns none, and no inner/other/window operation moves the dialog`).toEqual([])
  expect(ledger.edges.filter(edge => !edge.pass), `${label}: every edge between consecutive tuples is an owned justified call, quiet, a measured clamp projection, or a native-layout residual with attached geometry evidence`).toEqual([])
  expect(ledger.baseline.usable, `${label}: T0 supplies a finite window-scroll and horizontal-offset baseline for the whole stream`).toBe(true)
  expect(ledger.baseline.offenders, `${label}: every tuple from T0 through Tf (external and call pre/post, ${ledger.baseline.checked} checked) keeps window x/y and the horizontal dialog offset within ${STABILITY_TOLERANCE_PX}px of T0; the vertical dialog offset is judged per call and per edge and is never locked to T0`).toEqual([])
  expect(ledger.repairs, `${label}: at least one valid nonzero owned repair of a genuinely occluded B (a zero-effect range cap is not a repair witness)`).toBeGreaterThanOrEqual(1)
  expect(ledger.endpoints.t0.pass, `${label}: ${ledger.endpoints.t0.detail}`).toBe(true)
  expect(ledger.endpoints.tf.pass, `${label}: ${ledger.endpoints.tf.detail} (R8-1: judged from Tf itself; the earlier stop, net equality and the later capture are not substitutes)`).toBe(true)
  expect(ledger.bracket.stable, `${label}: ${ledger.bracket.detail} (A1 final-stability prerequisite with AIR11-1: every observed tuple in Tj..Tf, call tuples included, must be the same connected focused positive coherent B within ${STABILITY_TOLERANCE_PX}px of Tj's outer, horizontal and window offsets with no owned call edge, so an excursion that cancels by Tf still fails even when the full ledger accepts it as a legitimate native adjustment; it certifies nothing about facts outside those, so the full D1 stop stays independently required; no retry, no extra frame, no automatic product blame)`).toBe(true)
}

/** Preparation shared by the B-protection cases: walk to the archive deletion, confirm, hold completions, Enter (A), busy footer, and let the product's coalesced frames settle while page time still flows. */
async function holdArchiveDeletion(page: Page, dialog: Locator, walk: KeyboardWalk): Promise<Hold> {
  const initial = await walk.observe('initial-close')
  expect(initial.name).toBe(LABEL.close)
  await walkUntil(walk, 'Tab', 'forward', stop => stop.name === LABEL.deleteArchive, 40)
  await walk.press('Enter', 'activate-delete-archive')
  await expect(dialog.locator('.dialog-footer > span')).toHaveText(BACKUP_FOOTER_TEXT.confirmDelete)
  await settleLayout(page, 'confirm footer')
  await walkUntil(walk, 'Tab', 'forward-to-confirm', stop => stop.name === LABEL.confirmDelete, 6)
  const hold = await holdCompletionDelivery(page)
  await pressKey(page, 'Enter')
  await awaitHeldCompletion(hold)
  await expect(dialog.locator('.dialog-footer > span')).toHaveText(D2_LABEL.busyFooter)
  await settleLayout(page, 'busy footer sized')
  return hold
}

/** Remove the saved posting from its footer by keyboard and move focus to the Undo action of the recovery notice. */
async function removeAndReachUndo(page: Page, dialog: Locator) {
  await pressTabUntil(page, footerToggle(dialog), { max: 60 })
  await expect(footerToggle(dialog)).toHaveText(LABEL.footerRemove)
  await page.keyboard.press('Enter')
  await waitForSavedCommit(page)
  await expectAbsentFromStorage(page, LANTERN.job.id)
  await expect(footerToggle(dialog)).toHaveText('제거 취소')
  const undo = undoOf(recoveryEntry(dialog, LANTERN))
  await pressTabUntil(page, undo, { max: 8 })
  await expect(undo).toBeFocused()
  return undo
}

for (const viewport of UNDO_VIEWPORTS) {
  test.describe(`delayed Undo recovery at ${tag(viewport)}`, () => {
    test.use({ viewport, hasTouch: viewport.width === 320 })

    test(`A-recovery valid: a late Undo completion with no intervening user action still hands focus to the visible Close control at ${tag(viewport)}`, async ({ page }) => {
      const dialog = await openLanternDetail(page)
      const undo = await removeAndReachUndo(page, dialog)
      const hold = await holdCompletionDelivery(page)
      await pressKey(page, 'Enter')
      await awaitHeldCompletion(hold)
      await hold.release()
      await waitForSavedCommit(page)
      await expect(undo).toHaveCount(0)
      await settleLayout(page, 'after the late completion')
      await expect(closeButton(dialog), 'valid original recovery keeps its destination').toBeFocused()
      const assessment = assessStop(await probeActive(page))
      expect(assessment.failures, 'the recovered Close control is fully visible').toEqual([])
      expect((await readCommitted(page)).find(record => record.job.id === LANTERN.job.id), 'Undo restored the literal record').toMatchObject(literalOf(LANTERN))
    })

    test(`A-recovery invalid: after a measured manual wheel that moved the dialog with the same focus, the late Undo completion neither refocuses nor scrolls, and Tab and Escape stay usable at ${tag(viewport)}`, async ({ page }, testInfo) => {
      const dialog = await openLanternDetail(page)
      const undo = await removeAndReachUndo(page, dialog)
      const hold = await holdCompletionDelivery(page)
      await pressKey(page, 'Enter')
      await awaitHeldCompletion(hold)
      // Same focus, manual outer movement: the Undo action keeps focus while a real wheel moves the dialog's own scroller.
      const wheel: WheelCompletion = await wheelUntilComplete(page, dialog, 240, { minMove: 50 })
      expect(wheel.moved, `the wheel actually moved the dialog scroller to completion (${wheel.before} → ${wheel.after}, scrollend at ${wheel.lastScrollEndAt})`).toBeGreaterThan(50)
      const focusBefore = await activeElementDescriptor(page)
      expect(focusBefore.text ?? '', 'the Undo action still owns focus after the wheel').toContain(D2_LABEL.undo)
      const scrollBefore = await scrollTopOf(dialog)
      await hold.release()
      await waitForSavedCommit(page)
      await expect(undo).toHaveCount(0)
      await settleLayout(page, 'after the late completion')
      const scrollAfter = await scrollTopOf(dialog)
      const focusAfter = await activeElementDescriptor(page)
      await testInfo.attach('invalid-recovery', { body: JSON.stringify({ hold: HOLD_NOTE, wheel, focusBefore, focusAfter, scrollBefore, scrollAfter }, null, 2), contentType: 'application/json' })
      await expect(closeButton(dialog), 'an invalid ticket does not refocus Close').not.toBeFocused()
      expect(focusAfter.label, 'no refocus to the Close control').not.toBe(LABEL.close)
      expect(Math.abs(scrollAfter - scrollBefore), 'an invalid ticket does not scroll the dialog').toBeLessThanOrEqual(0.5)
      await pressKey(page, 'Tab')
      const next = await probeActive(page)
      expect(next.active.insideDialog, 'Tab moves focus inside the open dialog').toBe(true)
      expect(assessStop(next).failures, 'the next stop is fully visible').toEqual([])
      await page.keyboard.press('Escape')
      await expect(dialog).toHaveCount(0)
      await expect(titleButton(page, LANTERN), 'Escape closes and returns to the opener').toBeFocused()
      expect((await readCommitted(page)).find(record => record.job.id === LANTERN.job.id), 'Undo restored the literal record').toMatchObject(literalOf(LANTERN))
    })
  })
}

test.describe('late results in the backup dialog at 320x480', () => {
  test.use({ viewport: { width: 320, height: 480 }, hasTouch: true })

  test('B-protection: the late archive deletion really occludes the deliberately engaged row disclosure, the dialog repairs only that occlusion by the justified nearest landing, focus and the opened state are kept, and the message is not navigated to', async ({ page }, testInfo) => {
    await seedSavedWithoutClock(page, [BEACON, LEGACY_UNREADABLE_ENTRY])
    await openSavedViewPlain(page, [BEACON.job.title])
    const { dialog, opener } = await openBackupByKeyboard(page)
    await loadBackupFile(page, dialog, IMPORT_ROWS, 3)
    const walk = new KeyboardWalk(page, testInfo, 'b-protection-320x480', {
      contract: D2_CONTRACT, row: 'B 편집 후 A 때문에 실제 가림', requirements: ['requirement 4', 'requirement 6'], viewport: { width: 320, height: 480 }, hold: HOLD_NOTE, recorder: RECORDER_NOTE,
      measurement: 'Tab to the archive deletion, Enter, Tab to the confirm action; hold completions; Enter (A); Shift+Tab into the body (the deletion action is disabled while busy), Shift+Tab to the last row disclosure (B), Enter opens it; mark B; install the route recorder with its baseline tuple T0 and its own 90-frame read-only sampler (one evaluation); release A; settle; verdict tuple Tj; judged no-screenshot native stop; finalize (final tuple Tf, every record, wrappers restored, one evaluation); labeled capture and placement after finalization. Movement is judged over the complete T0..Tf stream: every recorded call from its own pre-call geometry against the public 8px total landing, every other edge as quiet, a measured clamp or a supported native-layout residual; T0 and Tf carry their own clear-B gates; Tj..Tf is the final-stability prerequisite.',
    })
    let engagedGapToFooter: number | null = null
    let scrollBefore: number | null = null
    let scrollAfterRelease: number | null = null
    let installed: RecorderInstall | null = null
    let tj: RecorderTuple | null = null
    const recorder = recorderState()
    let messagePlacement: Awaited<ReturnType<typeof placement>> | null = null
    try {
      const hold = await holdArchiveDeletion(page, dialog, walk)
      const download = await walk.press('Shift+Tab', 'backward-into-body-while-busy', { screenshot: true })
      expect(download.name, 'the first body stop while busy is the download action (the deletion action is disabled)').toBe(LABEL.downloadOriginal)
      const summary = await walk.press('Shift+Tab', 'backward-to-row-disclosure', { screenshot: true })
      expect(summary.name, 'the last import row disclosure is the engaged control B').toBe(D2_LABEL.importSummaryNew)
      await walk.press('Enter', 'open-row-disclosure', { screenshot: true })
      await settleLayout(page, 'after opening the row disclosure')
      const engaged = await walk.observe('b-engaged', null, { screenshot: true })
      engagedGapToFooter = (engaged.probe.footer?.rect.top ?? Number.NaN) - (engaged.probe.active.indicator.rect?.bottom ?? engaged.probe.active.rect.bottom)
      scrollBefore = engaged.probe.dialog?.scrollTop ?? null
      expect(await markEngaged(page), 'B is marked as the engaged control for the recorder').toBe(true)
      // Labeled attribution instrumentation, one evaluation: nine route wrappers installed transactionally, baseline tuple T0 read and stamped, recorder-owned read-only frame sampler started (90-frame ceiling). Every public scroll call during the late-A interval is forwarded once, unchanged, with its own pre/post tuples.
      installed = await installScrollRouteRecorder(page, { frameSamples: 90 })
      await hold.release()
      await expect(dialog.locator('.saved-file-message')).toContainText(D2_LABEL.deleteMessage)
      await settleLayout(page, 'after the late completion rendered its message')
      // A1: the verdict tuple Tj immediately precedes the judged no-screenshot native stop; Tj..Tf is the separately labeled final-stability prerequisite.
      tj = await sampleRecorderTuple(page, 'Tj', 'verdict')
      const after = await recordNativeStop(walk, page, 'b-after-late-a', 'late-completion')
      scrollAfterRelease = after.probe.dialog?.scrollTop ?? null
      // Finalize in one evaluation: sampler cancelled, Tf read and stamped, every tuple and record collected, every wrapper restored in reverse.
      recorder.snapshot = await finalizeScrollRouteRecorder(page)
      recorder.ledger = recorder.snapshot ? buildLedger(recorder.snapshot) : null
      // After finalization, labeled by their own phase: capture and placement.
      await walk.observe('b-after-late-a-capture-after-finalize', null, { screenshot: true })
      messagePlacement = await placement(page, '.saved-file-message')
    } finally {
      await finalizeIfNeeded(recorder, page)
      await walk.attach({ recorder: RECORDER_NOTE, engagedGapToFooter, scrollBefore, scrollAfterRelease, installed, tj, stream: recorder.snapshot, ledger: recorder.ledger, finalizeError: recorder.finalizeError, messagePlacement })
    }

    const snapshot = collectedStream(recorder, 'B-only repair')
    const evidence = occlusionEvidence(snapshot.tuples.map(movementOf))
    expect(snapshot.tuples.filter(tuple => tuple.role === 'frame').length, 'the recorder-owned sampler observed the late completion frame by frame').toBeGreaterThan(5)
    expect(evidence.firstOccluded, `FIXTURE PREREQUISITE (coverage failure if -1, not a product defect; UA scroll anchoring may have kept B in place): the late message must really displace the connected, focused B into occlusion in at least one sampled tuple (B was ${engagedGapToFooter}px above the footer)`).toBeGreaterThanOrEqual(0)
    expect(evidence.clearedAfter, 'B is clear again in a later sampled tuple').toBe(true)
    expect(evidence.focusKept, 'B keeps focus in every sampled tuple').toBe(true)
    expect(walk.stops.every(asserted)).toBe(true)
    expect(walk.failures(), `every stop is visible, including the judged B stop after the late message (see the ${walk.name}-stops attachment)`).toEqual([])
    const afterStop = walk.find(D2_LABEL.importSummaryNew, 'b-after-late-a')
    expect(afterStop?.name, 'B keeps focus through the late completion').toBe(D2_LABEL.importSummaryNew)
    expect(afterStop?.probe.active.detailsOpen, 'the disclosure the user opened stays open').toBe(true)
    expectAccountedMovement(recorder, 'B-only repair')
    expect(Math.abs((scrollAfterRelease ?? Number.NaN) - (tj?.dialogScrollTop ?? Number.NaN)), 'the judged stop read the dialog offset of the verdict tuple').toBeLessThanOrEqual(STABILITY_TOLERANCE_PX)
    expect(messagePlacement?.found, 'the message block rendered').toBe(true)
    expect(messagePlacement?.aboveClient, 'the stale destination was not navigated to: the message stays above the port').toBe(true)
    await expect(dialog.locator('.saved-recovery-source'), 'the archive was deleted by A').toHaveCount(0)
    await expect(dialog.locator('.saved-import-row'), 'the import rows are untouched').toHaveCount(3)

    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await expect(opener).toBeFocused()
    const committed = await readCommitted(page)
    expect(committed).toHaveLength(1)
    expect(committed[0], 'the saved record is untouched').toMatchObject(literalOf(BEACON))
  })

  test('B-protection after a stale gesture tail (AP1): with page time held, a real wheel moves the dialog to completion, Shift+Tab reaches the download action and the last row disclosure (B) and Enter opens it before any frame opportunity, two frame opportunities then pass with no further input, the late archive deletion really occludes the same connected B, and B is repaired by only the justified nearest landing while focus, the opened state and the message position are kept', async ({ page }, testInfo) => {
    // The Clock is installed before navigation (seedSaved) and paused only after the held deletion settled; while paused, the gesture's deferred frames cannot run until the explicit ticks below. See CLOCK_NOTE.
    await seedSaved(page, [BEACON, LEGACY_UNREADABLE_ENTRY])
    await openSavedViewPlain(page, [BEACON.job.title])
    const { dialog, opener } = await openBackupByKeyboard(page)
    await loadBackupFile(page, dialog, IMPORT_ROWS, 3)
    const footerText = dialog.locator('.dialog-footer > span')
    const walk = new KeyboardWalk(page, testInfo, 'b-protection-gesture-tail-320x480', {
      contract: D2_CONTRACT, row: 'B 편집 후 A 때문에 실제 가림 · 수동 이동 후 늦은 A (AP1)', requirements: ['requirement 4', 'requirement 6'], viewport: { width: 320, height: 480 }, hold: HOLD_NOTE, clock: CLOCK_NOTE, recorder: RECORDER_NOTE,
      measurement: 'Tab to the archive deletion, Enter, Tab to the confirm action; hold completions; Enter (A); settle; pause page time; arm the frame counter; real wheel on the dialog body until completed native movement (>20px plus scrollend) with zero frame opportunities; raw Shift+Tab to the download action, raw Shift+Tab to the last row disclosure (B), raw Enter opens it, each judged without frame, readiness or screenshot waits and all before the first frame opportunity; input sealed; two frame opportunities pass; four settlement ticks with samples (separate witness); install the route recorder with the pre-release baseline tuple T0, automatic frame sampling disabled (one evaluation); release A while paused; pre-repair tuple of the same connected B before any frame; repair ticks with one tuple each until four quiescent clear tuples (>5 and <=90 observations including the pre-repair tuple); verdict tuple Tj; judged no-screenshot native stop; finalize (Tf, every record, wrappers restored); resume the Clock; labeled capture and placement after finalization.',
    })
    const order: { order: number; event: string; frames: number; dialogScrollTop: number }[] = []
    /** Tail-settlement witness after the two-frame window, before late A; kept apart from the causal late-A series and from the recorder stream (unchanged timing sampler). */
    const settlementSamples: EngagedSample[] = []
    /** The causal late-A series: the pre-repair tuple first, then one tuple per repair tick (floor >5, ceiling 90, both including the pre-repair tuple). T0, Tj and Tf are not part of it. */
    const lateA: RecorderTuple[] = []
    /** Host-side order of marks and settlement samples; diagnostic, distinct from the recorder's integer order. */
    let hostOrder = 0
    const mark = async (event: string) => { order.push({ order: ++hostOrder, event, frames: (await frameOpportunities(page)).fired, dialogScrollTop: await scrollTopOf(dialog) }) }
    let wheel: WheelCompletion | null = null
    let windowTicks: number | null = null
    let installed: RecorderInstall | null = null
    let heldAtRelease: { completed: number; delivered: number } | null = null
    let sentinelBeforeRepair: boolean | null = null
    let sentinelAfterRepair: boolean | null = null
    let footerAtPreRepair: string | null = null
    let preRepair: RecorderTuple | null = null
    let repairTicks = 0
    let quiescentClear = 0
    let scrollAfterRelease: number | null = null
    let tj: RecorderTuple | null = null
    const recorder = recorderState()
    let messagePlacement: Awaited<ReturnType<typeof placement>> | null = null
    let paused = false
    try {
      const hold = await holdArchiveDeletion(page, dialog, walk)
      await pauseContextClock(page)
      paused = true
      await awaitHeldCompletion(hold)
      await expect(footerText, 'A is still held after the pause').toHaveText(D2_LABEL.busyFooter)
      await armFrameCounter(page)
      await mark('paused-and-armed')
      // AP1: a real outer movement whose deferred two-frame tail is still pending when the user engages B. Completion is witnessed natively; no frame opportunity is consumed.
      wheel = await wheelUntilComplete(page, dialog, 120, { minMove: 20 })
      await mark('wheel-completed')
      expect(wheel.frameOpportunitiesDuring, 'no frame opportunity was delivered while the wheel completed').toBe(0)
      // Raw native keys, each judged immediately: nothing waits for a frame, readiness or a screenshot before the final B engagement.
      await page.keyboard.press('Shift+Tab')
      const download = await recordNativeStop(walk, page, 'backward-into-body-while-busy', 'Shift+Tab')
      await mark('shift-tab-download')
      expect(download.name, 'the first body stop while busy is the download action (the deletion action is disabled)').toBe(LABEL.downloadOriginal)
      await page.keyboard.press('Shift+Tab')
      const summary = await recordNativeStop(walk, page, 'backward-to-row-disclosure', 'Shift+Tab')
      await mark('shift-tab-b')
      expect(summary.name, 'the last import row disclosure is the engaged control B').toBe(D2_LABEL.importSummaryNew)
      await page.keyboard.press('Enter')
      const opened = await recordNativeStop(walk, page, 'open-row-disclosure', 'Enter')
      await mark('enter-open-b')
      expect(opened.name, 'B keeps focus when it opens').toBe(D2_LABEL.importSummaryNew)
      expect(opened.probe.active.detailsOpen, 'Enter opened the disclosure').toBe(true)
      expect(await markEngaged(page), 'B is marked as the engaged control for the samples').toBe(true)
      expect((await frameOpportunities(page)).fired, 'every native stop and the final B engagement precede the first frame opportunity').toBe(0)
      // Input is sealed from here. Let the original two-frame window pass through explicit ticks; a corrected product may already have cancelled its own tail.
      const passed = await advanceFrames(page, 2, 3)
      windowTicks = passed.ticks
      expect(passed.counter.fired, 'two frame opportunities passed after the final B engagement').toBe(2)
      await mark('two-frame-window-passed')
      // Bounded settlement: the four frames settleLayout would spend, each followed by a sample of the same connected B. These are the tail witness, not part of the late-A series or of the recorder stream.
      for (let tick = 1; tick <= 4; tick++) {
        await page.clock.runFor(16)
        settlementSamples.push(await sampleEngaged(page, ++hostOrder))
      }
      const settled = await recordNativeStop(walk, page, 'b-engaged-after-window', null)
      expect(settled.name, 'B is still focused after the window').toBe(D2_LABEL.importSummaryNew)
      expect(settled.probe.active.detailsOpen, 'B is still open after the window').toBe(true)
      // Labeled attribution instrumentation, one evaluation: route wrappers plus the pre-release baseline tuple T0 of the same connected B; automatic frame sampling disabled under the paused Clock, so every later tuple is a host evaluation after an explicit tick and shares the recorder's integer order with every recorded call.
      installed = await installScrollRouteRecorder(page, { frameSamples: 0 })
      heldAtRelease = { completed: await hold.completed(), delivered: await hold.delivered() }
      await mark('b-clear-before-release')
      // Late A while page time is still paused: its message renders through the application's own scheduling. Frame-deferred work waits for the explicit ticks below, but synchronous public routes stay possible without a frame; they are recorded by the route wrappers, so attribution comes from the ledger, never from the absence of a frame.
      const sentinel = await queueFrameProbe(page)
      await hold.release()
      await expect(dialog.locator('.saved-file-message')).toContainText(D2_LABEL.deleteMessage)
      footerAtPreRepair = (await footerText.textContent())?.trim() ?? null
      preRepair = await sampleRecorderTuple(page, 'pre-repair')
      lateA.push(preRepair)
      sentinelBeforeRepair = preRepair.sentinelFired
      await mark('late-a-rendered-pre-repair')
      // Repair opportunities one tick at a time. The causal series always holds more than five observations (TN1 floor), stops after four consecutive clear samples with an unchanged outer scroll, and never exceeds ninety observations including the pre-repair tuple.
      let previousTop: number | null = null
      while (lateA.length < 90 && (quiescentClear < 4 || lateA.length < 6)) {
        await page.clock.runFor(16)
        repairTicks++
        const sample = await sampleRecorderTuple(page, `tick-${repairTicks}`)
        lateA.push(sample)
        quiescentClear = clearSample(movementOf(sample)) ? (previousTop !== null && Math.abs(sample.dialogScrollTop - previousTop) <= 0.5 ? quiescentClear + 1 : 1) : 0
        previousTop = sample.dialogScrollTop
      }
      sentinelAfterRepair = await sentinel.fired()
      // A1: the verdict tuple Tj immediately precedes the judged no-screenshot native stop; Tj..Tf is the separately labeled final-stability prerequisite.
      tj = await sampleRecorderTuple(page, 'Tj', 'verdict')
      const after = await recordNativeStop(walk, page, 'b-after-late-a', 'late-completion')
      scrollAfterRelease = after.probe.dialog?.scrollTop ?? null
      // Finalize in one evaluation while page time is still held: Tf read and stamped, every tuple and record collected, every wrapper restored in reverse.
      recorder.snapshot = await finalizeScrollRouteRecorder(page)
      recorder.ledger = recorder.snapshot ? buildLedger(recorder.snapshot) : null
      await mark('b-after-late-a')
      await page.clock.resume()
      paused = false
      // After finalization and resume, labeled by their own phase: capture and placement; neither is presented as a sealed observation.
      await walk.observe('b-after-late-a-capture-after-resume', null, { screenshot: true })
      messagePlacement = await placement(page, '.saved-file-message')
    } finally {
      await finalizeIfNeeded(recorder, page)
      if (paused) await page.clock.resume()
      await walk.attach({ hold: HOLD_NOTE, clock: CLOCK_NOTE, recorder: RECORDER_NOTE, order, wheel, windowTicks, settlementSamples, installed, heldAtRelease, sentinelBeforeRepair, sentinelAfterRepair, footerAtPreRepair, preRepair, lateA, repairTicks, quiescentClear, scrollAfterRelease, tj, stream: recorder.snapshot, ledger: recorder.ledger, finalizeError: recorder.finalizeError, messagePlacement })
    }

    // Ordering witness: every native stop and the final B engagement precede the first frame opportunity; A was still held when the window had passed.
    const framesBeforeB = order.filter(entry => ['paused-and-armed', 'wheel-completed', 'shift-tab-download', 'shift-tab-b', 'enter-open-b'].includes(entry.event)).map(entry => entry.frames)
    expect(framesBeforeB, 'no frame opportunity before the final B engagement').toEqual([0, 0, 0, 0, 0])
    expect(order.find(entry => entry.event === 'two-frame-window-passed')?.frames, 'the two-frame window passed before release').toBe(2)
    expect(heldAtRelease, 'A was still held when the window had passed').toMatchObject({ delivered: 0 })
    expect(heldAtRelease?.completed ?? 0, 'the native completion had fired while held').toBeGreaterThanOrEqual(1)
    expect(wheel?.moved ?? 0, `the stale gesture really moved the dialog to completion (${wheel?.before} → ${wheel?.after}, scrollend at ${wheel?.lastScrollEndAt})`).toBeGreaterThan(20)
    // Before release: the tail-settlement witness shows the same connected B clear and the dialog still while input is sealed; T0 then establishes the clear pre-release baseline inside the recorder stream.
    expect(settlementSamples.length, 'four settlement samples were taken').toBe(4)
    expect(settlementSamples.every(clearSample), `B is connected, focused and clear in every settlement sample: ${JSON.stringify(settlementSamples.map(sample => sample.overlapPx))}`).toBe(true)
    expect(settlementSamples.every(sample => Math.abs(sample.dialogScrollTop - settlementSamples[0].dialogScrollTop) <= 0.5), 'the dialog does not move while B is clear and input is sealed').toBe(true)
    expect(installed !== null && clearSample(movementOf(installed.baseline)), 'B is connected, focused and clear right before release (T0)').toBe(true)
    // Causal pre-repair geometry: late A displaced the same connected, focused B into occlusion before any frame ran.
    expect(sentinelBeforeRepair, 'no frame opportunity ran between release and the pre-repair tuple (read in the same evaluation as its geometry)').toBe(false)
    expect(preRepair !== null && sameEngaged(preRepair), 'the same connected B stays focused through late A').toBe(true)
    expect(preRepair?.engaged?.overlapPx ?? 0, `FIXTURE PREREQUISITE (coverage failure if ≤ 0.5, not a product defect; UA scroll anchoring may have kept B in place): the late message must really displace B into occlusion before any frame opportunity (pre-repair overlap ${preRepair?.engaged?.overlapPx}px, footer "${footerAtPreRepair}")`).toBeGreaterThan(0.5)
    // Repair under explicit ticks: the causal late-A series alone satisfies the observation budget, B clears, stays quiescent, and every edge of the recorder stream from T0 through Tf is accounted for.
    expect(sentinelAfterRepair, 'frame opportunities were delivered by the repair ticks').toBe(true)
    expect(lateA.length, `the causal late-A series (pre-repair tuple plus repair ticks) holds more than five observations (${lateA.length})`).toBeGreaterThan(5)
    expect(lateA.length, 'the causal late-A series stays within the ninety-observation ceiling').toBeLessThanOrEqual(90)
    expect(quiescentClear, `B is clear with an unchanged outer scroll for at least four consecutive late-A samples (ticks used: ${repairTicks})`).toBeGreaterThanOrEqual(4)
    const evidence = occlusionEvidence(lateA.map(movementOf))
    expect(evidence.firstOccluded, 'the late-A series begins occluded').toBe(0)
    expect(evidence.clearedAfter, 'B is clear again in a later late-A sample').toBe(true)
    expect(settlementSamples.every(sample => sample.sameElement && sample.connected) && lateA.every(sameEngaged), 'B keeps focus in every sample').toBe(true)
    expectAccountedMovement(recorder, 'AP1 B-only repair')
    expect(Math.abs((scrollAfterRelease ?? Number.NaN) - (tj?.dialogScrollTop ?? Number.NaN)), 'the judged stop read the dialog offset of the verdict tuple').toBeLessThanOrEqual(STABILITY_TOLERANCE_PX)
    expect(walk.stops.every(asserted)).toBe(true)
    expect(walk.failures(), `every stop is visible, including the raw stops inside the held window and the judged B stop after the late message (see the ${walk.name}-stops attachment)`).toEqual([])
    const afterStop = walk.find(D2_LABEL.importSummaryNew, 'b-after-late-a')
    expect(afterStop?.name, 'B keeps focus through the late completion').toBe(D2_LABEL.importSummaryNew)
    expect(afterStop?.probe.active.detailsOpen, 'the disclosure the user opened stays open').toBe(true)
    expect(messagePlacement?.found, 'the message block rendered').toBe(true)
    expect(messagePlacement?.aboveClient, 'the stale destination was not navigated to: the message stays above the port').toBe(true)
    await expect(dialog.locator('.saved-recovery-source'), 'the archive was deleted by A').toHaveCount(0)
    await expect(dialog.locator('.saved-import-row'), 'the import rows are untouched').toHaveCount(3)

    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await expect(opener).toBeFocused()
    const committed = await readCommitted(page)
    expect(committed).toHaveLength(1)
    expect(committed[0], 'the saved record is untouched').toMatchObject(literalOf(BEACON))
  })

  test('inner reading: ArrowDown and End inside the engaged note reader move only the reader, cancel the stale request, keep the reading position and never centre the outer dialog when the late message arrives', async ({ page }, testInfo) => {
    await seedSavedWithoutClock(page, [HARBOR, LEGACY_UNREADABLE_ENTRY])
    await openSavedViewPlain(page, [HARBOR.job.title])
    const { dialog, opener } = await openBackupByKeyboard(page)
    await loadBackupFile(page, dialog, [HARBOR_INCOMING], 1)
    const walk = new KeyboardWalk(page, testInfo, 'inner-reading-320x480', {
      contract: D2_CONTRACT, row: '긴 원문/백업 본문 · 수동 이동 후 늦은 A', requirements: ['requirement 4', 'requirement 6', 'requirement 9'], viewport: { width: 320, height: 480 }, hold: HOLD_NOTE,
      measurement: 'Open the differences panes; Tab to the archive deletion, Enter, Tab to the confirm action; hold; Enter (A); Shift+Tab back to the note reader; ArrowDown three times and End (inner reading, outer scroller measured unchanged); release A; observe the reader.',
    })
    const readerName = (stop: WalkStop) => stop.name.startsWith(READER_NOTE.first.slice(0, 30))
    const outer: { atEntry: number | null; afterReading: number | null; afterRelease: number | null } = { atEntry: null, afterReading: null, afterRelease: null }
    let innerBefore: number | null = null
    let innerAfter: number | null = null
    let messagePlacement: Awaited<ReturnType<typeof placement>> | null = null
    try {
      const initial = await walk.observe('initial-close')
      expect(initial.name).toBe(LABEL.close)
      const differences = await walkUntil(walk, 'Tab', 'forward', stop => D2_LABEL.importSummaryDifferent.test(stop.name), 40)
      if (differences.probe.active.detailsOpen === false) await walk.press('Enter', 'open-differences')
      await walkUntil(walk, 'Tab', 'forward', stop => stop.name === LABEL.deleteArchive, 40)
      await walk.press('Enter', 'activate-delete-archive')
      await expect(dialog.locator('.dialog-footer > span')).toHaveText(BACKUP_FOOTER_TEXT.confirmDelete)
      await settleLayout(page, 'confirm footer')
      await walkUntil(walk, 'Tab', 'forward-to-confirm', stop => stop.name === LABEL.confirmDelete, 6)
      const hold = await holdCompletionDelivery(page)
      await pressKey(page, 'Enter')
      await awaitHeldCompletion(hold)
      const reader = await walkUntil(walk, 'Shift+Tab', 'backward-to-note-reader', readerName, 16, { screenshot: true })
      expect(readerName(reader)).toBe(true)
      outer.atEntry = reader.probe.dialog?.scrollTop ?? null
      for (let presses = 0; presses < 3; presses++) await pressKey(page, 'ArrowDown')
      await pressKey(page, 'End')
      const read = await walk.observe('reader-inner-end', 'ArrowDown x3, End', { screenshot: true })
      innerBefore = read.probe.active.innerScroll?.scrollTop ?? null
      outer.afterReading = read.probe.dialog?.scrollTop ?? null
      await hold.release()
      await expect(dialog.locator('.saved-file-message')).toContainText(D2_LABEL.deleteMessage)
      await settleLayout(page, 'after the late completion rendered its message')
      const after = await walk.observe('reader-after-late-a', 'late-completion', { screenshot: true })
      innerAfter = after.probe.active.innerScroll?.scrollTop ?? null
      outer.afterRelease = after.probe.dialog?.scrollTop ?? null
      messagePlacement = await placement(page, '.saved-file-message')
      expect(readerName(after), 'the reader keeps focus').toBe(true)
    } finally {
      await walk.attach({ outer, innerBefore, innerAfter, messagePlacement })
    }

    expect(walk.stops.every(asserted)).toBe(true)
    expect(walk.failures(), `every stop is visible, including the reader after the late message (see the ${walk.name}-stops attachment)`).toEqual([])
    expect(innerBefore ?? 0, 'inner reading moved the reader content').toBeGreaterThan(0)
    expect(Math.abs((outer.afterReading ?? Number.NaN) - (outer.atEntry ?? Number.NaN)), 'inner reading did not move the outer dialog').toBeLessThanOrEqual(0.5)
    expect(Math.abs((innerAfter ?? Number.NaN) - (innerBefore ?? Number.NaN)), 'the reading position inside the reader is preserved').toBeLessThanOrEqual(0.5)
    expect(messagePlacement?.aboveClient, 'the stale destination was not navigated to').toBe(true)

    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await expect(opener).toBeFocused()
    expect((await readCommitted(page))[0], 'the record is untouched').toMatchObject(literalOf(HARBOR))
  })

  test('busy close refusal and reopen: Escape is refused while the import runs, succeeds after completion, and the reopened dialog walks cleanly', async ({ page, recoveryDiagnostics }, testInfo) => {
    await seedSavedWithoutClock(page, [BEACON])
    await openSavedViewPlain(page, [BEACON.job.title])
    const first = await openBackupByKeyboard(page)
    await loadBackupFile(page, first.dialog, IMPORT_ROWS, 3)
    const walk = new KeyboardWalk(page, testInfo, 'busy-close-320x480', {
      contract: D2_CONTRACT, row: '버튼 복귀/닫기', requirements: ['requirement 6', 'requirement 7'], viewport: { width: 320, height: 480 }, hold: HOLD_NOTE,
      measurement: 'Tab to the import action; hold; Enter; Escape while busy (refused); release; Escape; reopen; three judged stops.',
    })
    try {
      const initial = await walk.observe('initial-close')
      expect(initial.name).toBe(LABEL.close)
      const importAction = await walkUntil(walk, 'Tab', 'forward', stop => D2_LABEL.importButton.test(stop.name), 60)
      expect(importAction.probe.active.disabled).toBe(false)
      const hold = await holdCompletionDelivery(page)
      await pressKey(page, 'Enter')
      await awaitHeldCompletion(hold)
      await expect(first.dialog.locator('.dialog-footer > span')).toHaveText(D2_LABEL.busyFooter)
      await page.keyboard.press('Escape')
      await expect(first.dialog, 'requirement 7: closing is refused while the backup operation runs').toBeVisible()
      await hold.release()
      await expect(first.dialog.locator('.saved-file-message')).toContainText('선택한 3개 기록을 저장했어요.')
      await page.keyboard.press('Escape')
      await expect(first.dialog).toHaveCount(0)
      await expect(first.opener).toBeFocused()
      const second = await openBackupByKeyboard(page)
      const reopened = await walk.observe('reopened-close', 'reopen', { screenshot: true })
      expect(reopened.name).toBe(LABEL.close)
      await walk.press('Tab', 'reopened-forward', { screenshot: true })
      await walk.press('Tab', 'reopened-forward', { screenshot: true })
      await page.keyboard.press('Escape')
      await expect(second.dialog).toHaveCount(0)
    } finally {
      await walk.attach({ pageErrorsSoFar: recoveryDiagnostics.pageErrors.slice(), consoleErrorsSoFar: recoveryDiagnostics.consoleErrors.slice() })
    }
    expect(walk.stops.every(asserted)).toBe(true)
    expect(walk.failures(), `every stop before and after the reopen is visible (see the ${walk.name}-stops attachment)`).toEqual([])
    expect(recoveryDiagnostics.pageErrors, 'no callback from the closed dialog threw after cleanup').toEqual([])
    const committed = await readCommitted(page)
    expect(committed.map(record => record.job.id).sort()).toEqual([BEACON, ...IMPORT_ROWS].map(record => record.job.id).sort())
  })

  test('B-protection (editable): a late Undo completion that collapses the recovery notice above the engaged note really hides the note, the dialog repairs only that, the literal draft, backward selection and focus endpoint are kept, and Close is not refocused', async ({ page, recoveryDiagnostics }, testInfo) => {
    await seedSavedWithoutClock(page, [LANTERN, BEACON])
    await openSavedView(page)
    // Preparation: a different record is removed on the page so its recovery notice relocates into the detail's feedback host when the detail opens.
    await removeCardByKeyboard(page, BEACON)
    const dialog = await openDetailByKeyboard(page, LANTERN)
    await expectLayoutReady(page, 'SETUP detail with the relocated recovery notice')
    const undo = undoOf(recoveryEntry(dialog, BEACON))
    await expect(undo).toBeVisible()
    const walk = new KeyboardWalk(page, testInfo, 'b-protection-editable-320x480', {
      contract: D2_CONTRACT, row: 'B 편집 후 A 때문에 실제 가림 · 버튼 복귀/닫기', requirements: ['requirement 4', 'requirement 6'], viewport: { width: 320, height: 480 }, hold: HOLD_NOTE, recorder: RECORDER_NOTE,
      measurement: 'Tab to the Undo action of the relocated notice; hold; Enter (A); Tab to the note (B); type B81; Shift+ArrowLeft twice (backward selection); mark B; install the route recorder with its baseline tuple T0 and its own 90-frame read-only sampler (one evaluation); release A (the notice collapses above B); settle; verdict tuple Tj; judged no-screenshot native stop; finalize (Tf, every record, wrappers restored); labeled capture and caret geometry after finalization. Movement is judged over the complete T0..Tf stream exactly as in the row-disclosure case.',
    })
    const carets: Record<string, CaretGeometry> = {}
    let collapse: { noticeHeight: number | null; noteDistanceToPortTop: number | null } = { noticeHeight: null, noteDistanceToPortTop: null }
    let engagedTop: number | null = null
    let scrollBefore: number | null = null
    let scrollAfterRelease: number | null = null
    let installed: RecorderInstall | null = null
    let tj: RecorderTuple | null = null
    const recorder = recorderState()
    /** Measured, not assumed: the note's content-coordinate shift caused by the collapse up to the first recorded call (its own pre tuple against T0), and the offset change over the same interval; each edge of the interval is judged in the ledger rather than labeled UA. */
    let displacement: { contentShiftBeforeFirstOwnedCall: number | null; offsetChangeBeforeFirstOwnedCall: number | null; noticeHeight: number | null; reference: string } | null = null
    let selectionEngaged: { start: number; end: number; direction: string } | null = null
    try {
      const initial = await walk.observe('initial-close')
      expect(initial.name).toBe(LABEL.close)
      const undoStop = await walkUntil(walk, 'Tab', 'forward-to-undo', stop => stop.name === D2_LABEL.undo, 8, { screenshot: true })
      expect(undoStop.name).toBe(D2_LABEL.undo)
      const hold = await holdCompletionDelivery(page)
      await pressKey(page, 'Enter')
      await awaitHeldCompletion(hold)
      await walkUntil(walk, 'Tab', 'forward-to-note', stop => stop.name === LABEL.note, 60, { screenshot: true })
      await page.keyboard.type('B81')
      await pressKey(page, 'Shift+ArrowLeft')
      await pressKey(page, 'Shift+ArrowLeft')
      const engaged = await walk.observe('b-engaged', 'type:B81, Shift+ArrowLeft x2', { screenshot: true })
      selectionEngaged = engaged.probe.active.selection
      carets.engaged = await caretGeometry(page)
      const notice = await placement(page, '.saved-removal-notice')
      collapse = { noticeHeight: notice.rect?.height ?? null, noteDistanceToPortTop: (engaged.probe.active.rect.top) - (engaged.probe.dialog?.clientBox.top ?? Number.NaN) }
      engagedTop = engaged.probe.active.rect.top
      scrollBefore = engaged.probe.dialog?.scrollTop ?? null
      expect(await markEngaged(page), 'the note is marked as the engaged control for the recorder').toBe(true)
      // Labeled attribution instrumentation, one evaluation: nine route wrappers installed transactionally, baseline tuple T0 read and stamped, recorder-owned read-only frame sampler started (90-frame ceiling).
      installed = await installScrollRouteRecorder(page, { frameSamples: 90 })
      await hold.release()
      await waitForSavedCommit(page)
      await expect(undo).toHaveCount(0)
      await settleLayout(page, 'after the late completion collapsed the notice')
      // A1: the verdict tuple Tj immediately precedes the judged no-screenshot native stop; Tj..Tf is the separately labeled final-stability prerequisite.
      tj = await sampleRecorderTuple(page, 'Tj', 'verdict')
      const after = await recordNativeStop(walk, page, 'b-after-late-a', 'late-completion')
      scrollAfterRelease = after.probe.dialog?.scrollTop ?? null
      // Finalize in one evaluation: sampler cancelled, Tf read and stamped, every tuple and record collected, every wrapper restored in reverse.
      recorder.snapshot = await finalizeScrollRouteRecorder(page)
      recorder.ledger = recorder.snapshot ? buildLedger(recorder.snapshot) : null
      // After finalization, labeled by their own phase: capture and the caret geometry of the focus endpoint.
      await walk.observe('b-after-late-a-capture-after-finalize', null, { screenshot: true })
      carets.after = await caretGeometry(page)
      const firstRecorded = recorder.snapshot?.records[0] ?? null
      const reference = firstRecorded?.pre ?? recorder.snapshot?.tuples.find(tuple => tuple.role === 'final') ?? null
      const t0 = installed.baseline
      displacement = reference && reference.engaged && t0.engaged ? {
        contentShiftBeforeFirstOwnedCall: round2(reference.engaged.contentTop - t0.engaged.contentTop),
        offsetChangeBeforeFirstOwnedCall: round2(reference.dialogScrollTop - t0.dialogScrollTop),
        noticeHeight: collapse.noticeHeight,
        reference: firstRecorded ? `pre tuple ${reference.sequence} of recorded call ${firstRecorded.callSequence} ${firstRecorded.method}` : `Tf ${reference.sequence} (no recorded call)`,
      } : null
    } finally {
      await finalizeIfNeeded(recorder, page)
      await walk.attach({ recorder: RECORDER_NOTE, carets, collapse, engagedTop, scrollBefore, scrollAfterRelease, installed, tj, stream: recorder.snapshot, ledger: recorder.ledger, finalizeError: recorder.finalizeError, displacement, selectionEngaged, pageErrorsSoFar: recoveryDiagnostics.pageErrors.slice() })
    }

    expect(collapse.noticeHeight ?? 0, `FIXTURE PREREQUISITE (coverage failure if false): the notice (${collapse.noticeHeight}px) must be taller than the note's distance to the port top (${collapse.noteDistanceToPortTop}px) so its collapse would push the note above the port`).toBeGreaterThan((collapse.noteDistanceToPortTop ?? Number.POSITIVE_INFINITY) + 8)
    const snapshot = collectedStream(recorder, 'note-only repair')
    const evidence = occlusionEvidence(snapshot.tuples.map(movementOf))
    expect(snapshot.tuples.filter(tuple => tuple.role === 'frame').length, 'the recorder-owned sampler observed the late completion frame by frame').toBeGreaterThan(5)
    expect(evidence.firstOccluded, 'FIXTURE PREREQUISITE (coverage failure if -1, not a product defect; UA scroll anchoring may have kept the note in place): the collapse really displaced the connected, focused note into occlusion in at least one sampled tuple').toBeGreaterThanOrEqual(0)
    expect(evidence.clearedAfter, 'the note is clear again in a later sampled tuple').toBe(true)
    expect(evidence.focusKept, 'the note keeps focus in every sampled tuple').toBe(true)
    expect(walk.stops.every(asserted)).toBe(true)
    expect(walk.failures(), `every stop is visible, including the judged note stop after the late collapse (see the ${walk.name}-stops attachment)`).toEqual([])
    const afterStop = walk.find(LABEL.note, 'b-after-late-a')
    expect(afterStop?.probe.active.value, 'the literal draft is preserved').toBe('B81')
    expect(selectionEngaged, 'the backward selection was recorded').toEqual({ start: 1, end: 3, direction: 'backward' })
    expect(afterStop?.probe.active.selection, 'the backward selection and its direction are preserved').toEqual(selectionEngaged)
    expect(carets.after, 'the focus endpoint of the backward selection is at selectionStart and its modeled caret line is visible').toMatchObject({ direction: 'backward', focusOffset: 1, noSoftWrap: true, caretInsideBox: true, caretInsideBodyArea: true })
    // The collapse's displacement is measured, not assumed from the notice height: the note's content position moved up before the first recorded call. The offset change over the same interval is not labeled UA; every edge of it is judged in the ledger (owned call, measured clamp projection, or a native-layout residual with evidence), and anything unexplained fails.
    expect(displacement?.contentShiftBeforeFirstOwnedCall ?? 0, `the collapse really moved the note's content position upward before the first recorded call (content shift ${displacement?.contentShiftBeforeFirstOwnedCall}px, offset change ${displacement?.offsetChangeBeforeFirstOwnedCall}px, notice ${collapse.noticeHeight}px, reference ${displacement?.reference})`).toBeLessThan(-0.5)
    expectAccountedMovement(recorder, 'note-only repair')
    expect(Math.abs((scrollAfterRelease ?? Number.NaN) - (tj?.dialogScrollTop ?? Number.NaN)), 'the judged stop read the dialog offset of the verdict tuple').toBeLessThanOrEqual(STABILITY_TOLERANCE_PX)
    await expect(closeButton(dialog), 'the stale recovery ticket does not refocus Close').not.toBeFocused()
    expect(recoveryDiagnostics.pageErrors).toEqual([])
    const committed = await readCommitted(page)
    expect(committed.find(record => record.job.id === BEACON.job.id), 'Undo restored the removed record').toMatchObject(literalOf(BEACON))
    expect(committed.find(record => record.job.id === LANTERN.job.id)?.note, 'the typed draft was committed').toBe('B81')
  })
})

test.describe('same-message fresh result at 1440x960', () => {
  test.use({ viewport: { width: 1440, height: 960 } })

  test('a second export with the identical message text is a fresh result: its destination is revealed again after a measured wheel scrolled it away', async ({ page }, testInfo) => {
    await seedSavedWithoutClock(page, [BEACON])
    await openSavedViewPlain(page, [BEACON.job.title])
    const { dialog, opener } = await openBackupByKeyboard(page)
    await loadBackupFile(page, dialog, IMPORT_ROWS, 3)
    const message = dialog.locator('.saved-file-message')
    const walk = new KeyboardWalk(page, testInfo, 'fresh-result-1440x960', {
      contract: D2_CONTRACT, row: '늦은 결과 — 같은 문구의 새 작업', requirements: ['requirement 4', 'requirement 6'], viewport: { width: 1440, height: 960 },
      measurement: 'Tab to the export action; Enter (download, message); a measured wheel moves the dialog so the message leaves the port while the export action keeps focus; Enter again (same message text); observe where the message sits.',
    })
    const placements: Record<string, Awaited<ReturnType<typeof placement>>> = {}
    const texts: string[] = []
    const downloads: string[] = []
    let wheel: WheelCompletion | null = null
    try {
      const initial = await walk.observe('initial-close')
      expect(initial.name).toBe(LABEL.close)
      const exportAction = await walkUntil(walk, 'Tab', 'forward', stop => stop.name === LABEL.backupExport, 10, { screenshot: true })
      expect(exportAction.probe.active.disabled).toBe(false)
      const firstDownload = page.waitForEvent('download')
      await pressKey(page, 'Enter')
      downloads.push((await firstDownload).suggestedFilename())
      await expect(message).toContainText(D2_LABEL.exportMessage)
      texts.push((await message.textContent())?.trim() ?? '')
      await settleLayout(page, 'after the first export message')
      placements.first = await placement(page, '.saved-file-message')
      wheel = await wheelUntilComplete(page, dialog, 600, { minMove: 100 })
      placements.scrolledAway = await placement(page, '.saved-file-message')
      const focused = await activeElementDescriptor(page)
      expect(focused.text ?? '', 'the export action keeps focus through the wheel').toContain(LABEL.backupExport)
      const secondDownload = page.waitForEvent('download')
      await pressKey(page, 'Enter')
      downloads.push((await secondDownload).suggestedFilename())
      await expect(message).toContainText(D2_LABEL.exportMessage)
      texts.push((await message.textContent())?.trim() ?? '')
      await settleLayout(page, 'after the second export message')
      placements.second = await placement(page, '.saved-file-message')
      await walk.observe('export-after-second-result', 'Enter', { screenshot: true })
    } finally {
      await walk.attach({ placements, texts, downloads, wheel })
    }

    expect(walk.stops.every(asserted)).toBe(true)
    expect(walk.failures()).toEqual([])
    expect(placements.first?.insideClient, 'the first result is revealed').toBe(true)
    expect(wheel?.moved ?? 0, `the wheel really moved the dialog to completion (${wheel?.before} → ${wheel?.after}, scrollend at ${wheel?.lastScrollEndAt})`).toBeGreaterThan(100)
    expect(placements.scrolledAway?.aboveClient, 'FIXTURE PREREQUISITE (coverage failure if false): the wheel must move the message out of the port').toBe(true)
    expect(texts[1], 'the second result renders the identical message text').toBe(texts[0])
    expect(placements.second?.insideClient, 'a fresh action with identical text is revealed again').toBe(true)
    expect(downloads).toHaveLength(2)

    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await expect(opener).toBeFocused()
    expect((await readCommitted(page))[0], 'exporting changes no record').toMatchObject(literalOf(BEACON))
  })

  test('AP3: a visible result after Enter on the export action keeps the engaged protection, so a later resize that really hides the focused action is repaired', async ({ page }, testInfo) => {
    await seedSavedWithoutClock(page, [BEACON])
    await openSavedViewPlain(page, [BEACON.job.title])
    const { dialog, opener } = await openBackupByKeyboard(page)
    await loadBackupFile(page, dialog, IMPORT_ROWS, 3)
    const message = dialog.locator('.saved-file-message')
    const walk = new KeyboardWalk(page, testInfo, 'ap3-noop-reveal', {
      contract: D2_CONTRACT, row: '늦은 결과 — 이동 없는 명시적 결과와 현재 맥락 보호 (AP3)', requirements: ['requirement 4', 'requirement 6'], viewport: { width: 1440, height: 960 },
      measurement: 'Tab to the export action; Enter (download; the result is already visible, so the explicit reveal moves nothing); frame probe armed; resize to 320x320; observe the still-focused export action.',
    })
    let placements: Record<string, Awaited<ReturnType<typeof placement>>> = {}
    let scrollAfterReveal: number | null = null
    let probe: FrameProbeResult | null = null
    try {
      const initial = await walk.observe('initial-close')
      expect(initial.name).toBe(LABEL.close)
      await walkUntil(walk, 'Tab', 'forward', stop => stop.name === LABEL.backupExport, 10, { screenshot: true })
      const download = page.waitForEvent('download')
      await pressKey(page, 'Enter')
      await download
      await expect(message).toContainText(D2_LABEL.exportMessage)
      await settleLayout(page, 'after the export message')
      placements = { message: await placement(page, '.saved-file-message') }
      const revealed = await walk.observe('export-after-visible-result', 'Enter', { screenshot: true })
      scrollAfterReveal = revealed.probe.dialog?.scrollTop ?? null
      expect(await installFrameProbe(page, 90), 'the frame probe is armed on the export action').toBe(true)
      await page.setViewportSize({ width: 320, height: 320 })
      await settleLayout(page, 'after resizing to 320x320')
      probe = await readFrameProbe(page)
      await walk.observe('already-focused-320x320', 'resize:320x320', { screenshot: true })
    } finally {
      await walk.attach({ placements, scrollAfterReveal, probe })
    }

    expect(placements.message?.insideClient, 'the result was already visible when it rendered').toBe(true)
    expect(Math.abs(scrollAfterReveal ?? Number.NaN), 'the explicit reveal of an already visible result moved nothing').toBeLessThanOrEqual(0.5)
    const evidence = occlusionEvidence(probe!.samples)
    expect.soft(evidence.firstOccluded, 'FIXTURE PREREQUISITE (coverage, not a product defect): the resize should hide the focused export action in at least one sampled frame').toBeGreaterThanOrEqual(0)
    expect(evidence.focusKept, 'the export action keeps focus in every sampled frame').toBe(true)
    expect(walk.stops.every(asserted)).toBe(true)
    expect(walk.failures(), `the engaged export action is visible after the resize (see the ${walk.name}-stops attachment)`).toEqual([])
    const after = walk.find(LABEL.backupExport, 'already-focused-320x320')
    expect(after?.name).toBe(LABEL.backupExport)

    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await expect(opener).toBeFocused()
  })
})

test.describe('replacement modal and composition at 320x800', () => {
  test.use({ viewport: { width: 320, height: 800 }, hasTouch: true })

  test('replacement: opening the backup dialog from the detail replaces the modal with a visible Close focus, and closing it leaves focus in the document', async ({ page }, testInfo) => {
    const dialog = await openLanternDetail(page, [LEGACY_UNREADABLE_ENTRY])
    const walk = new KeyboardWalk(page, testInfo, 'replacement-320x800', {
      contract: D2_CONTRACT, row: '버튼 복귀/닫기', requirements: ['requirement 6', 'requirement 7'], viewport: { width: 320, height: 800 },
      measurement: 'Tab to the recovery disclosure in the note section, Enter, Tab to the manage action, Enter (the detail closes and the backup dialog opens); observe its Close; Escape.',
    })
    try {
      const initial = await walk.observe('initial-close')
      expect(initial.name).toBe(LABEL.close)
      const recovery = await walkUntil(walk, 'Tab', 'forward', stop => stop.name === D2_LABEL.recoverySummary, 60)
      if (recovery.probe.active.detailsOpen === false) await walk.press('Enter', 'open-recovery-disclosure')
      const manage = await walkUntil(walk, 'Tab', 'forward-to-manage', stop => stop.name === D2_LABEL.manageOriginals, 6, { screenshot: true })
      expect(manage.name).toBe(D2_LABEL.manageOriginals)
      await page.keyboard.press('Enter')
      const backup = page.getByRole('dialog', { name: LABEL.backupDialog, exact: true })
      await expect(backup).toBeVisible()
      await expect(dialog).toHaveCount(0)
      await settleLayout(page, 'after the replacement modal opened')
      const replacement = await walk.observe('replacement-close', 'Enter', { screenshot: true })
      expect(replacement.name, 'the replacement modal opens with its own Close focused').toBe(LABEL.close)
      await walk.press('Tab', 'replacement-forward', { screenshot: true })
      await page.keyboard.press('Escape')
      await expect(backup).toHaveCount(0)
    } finally {
      await walk.attach({})
    }
    expect(walk.stops.every(asserted)).toBe(true)
    expect(walk.failures()).toEqual([])
    const focus = await activeElementDescriptor(page)
    expect(focus.isBody, 'closing the replacement leaves focus on a document control, not on body').toBe(false)
    expect((await readCommitted(page))[0]).toMatchObject(literalOf(LANTERN))
  })

  test('composition: explicit composition events defer the correction after a real resize and a fresh check reveals the note after compositionend', async ({ page }, testInfo) => {
    const dialog = await openLanternDetail(page)
    const walk = new KeyboardWalk(page, testInfo, 'composition-320x800', {
      contract: D2_CONTRACT, row: '생명주기 — composition 중 보정 보류', requirements: ['requirement 4'], viewport: { width: 320, height: 800 },
      scope: 'Explicit CompositionEvent dispatches on the focused textarea; not an OS IME. The two observations during composition are record-only by contract (no correction while composing); stability between them and the post-composition visibility are asserted.',
      measurement: 'Tab to the note; type two characters; compositionstart and compositionupdate; resize to 320x480; observe twice during composition; compositionend; observe.',
    })
    let during: { first: number | null; second: number | null } = { first: null, second: null }
    try {
      const initial = await walk.observe('initial-close')
      expect(initial.name).toBe(LABEL.close)
      await walkUntil(walk, 'Tab', 'forward-to-note', stop => stop.name === LABEL.note, 60)
      await page.keyboard.type('ab')
      await waitForSavedCommit(page)
      await dispatchComposition(page, 'start')
      await dispatchComposition(page, 'update', '가')
      await page.setViewportSize({ width: 320, height: 480 })
      await settleLayout(page, 'after resizing during composition')
      const first = await walk.observe('during-composition-after-resize', 'resize:320x480', { screenshot: true, recordOnly: 'composition in progress: the contract defers any correction until compositionend; visibility is asserted after it' })
      await settleLayout(page, 'idle frames during composition')
      const second = await walk.observe('during-composition-idle', null, { recordOnly: 'composition in progress: the contract defers any correction until compositionend; visibility is asserted after it' })
      during = { first: first.probe.dialog?.scrollTop ?? null, second: second.probe.dialog?.scrollTop ?? null }
      await dispatchComposition(page, 'end', '가')
      await settleLayout(page, 'after compositionend')
      await walk.observe('after-compositionend', 'compositionend', { screenshot: true })
    } finally {
      await walk.attach({ during })
    }
    expect(Math.abs((during.second ?? Number.NaN) - (during.first ?? Number.NaN)), 'no owned movement while composing').toBeLessThanOrEqual(0.5)
    const after = walk.find(LABEL.note, 'after-compositionend')
    expect(after?.judgement).toBe('asserted')
    expect(after?.probe.active.value, 'synthetic composition events insert no text').toBe('ab')
    expect(walk.failures(), `the note is fully visible after compositionend (see the ${walk.name}-stops attachment)`).toEqual([])
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    expect((await readCommitted(page)).find(record => record.job.id === LANTERN.job.id)?.note).toBe('ab')
  })
})

test.describe('deferred page restore after close at 320x800', () => {
  test.use({ viewport: { width: 320, height: 800 }, hasTouch: true })

  test('restore: a measured manual page movement with the restored opener still focused is not undone by the deferred reveal', async ({ page }, testInfo) => {
    // Stage80 pattern: the Clock installed by seedSaved is paused only after the view settled, so a real wheel can land between the synchronous focus restore and the frame-deferred reveal.
    const records: SavedJob[] = [LANTERN, ...Array.from({ length: 5 }, (_, index): SavedJob => ({
      ...BEACON,
      job: { ...BEACON.job, id: `${BEACON.job.id}-${index}`, title: `${BEACON.job.title} ${index + 1}`, url: `${BEACON.job.url}-${index}` },
      savedAt: `2026-09-2${index}T08:00:00.000Z`,
    }))]
    await seedSaved(page, records)
    await openSavedView(page)
    const last = records[records.length - 1]
    const dialog = await openDetailByKeyboard(page, last)
    await waitForSavedCommit(page)
    await pauseContextClock(page)
    let scrolls: { beforeWheel: { x: number; y: number }; wheel: WheelCompletion; afterWheel: { x: number; y: number }; afterFrame: { x: number; y: number } } | null = null
    try {
      const probe = await queueFrameProbe(page)
      await page.keyboard.press('Escape')
      await expect(dialog).toHaveCount(0)
      await expect(titleButton(page, last)).toBeFocused()
      expect(await probe.fired(), 'the deferred reveal frame has not run before the wheel').toBe(false)
      const beforeWheel = await pageScroll(page)
      // Completed native page movement is witnessed (more than 20px plus a scrollend at the completed position) while the guarded frame is still pending; the Clock is never advanced to obtain that receipt.
      const wheel = await wheelUntilComplete(page, null, -400, { pointer: { x: 160, y: 300 }, minMove: 20 })
      expect(await probe.fired(), 'the guarded frame is still pending after the completed wheel').toBe(false)
      const afterWheel = await pageScroll(page)
      expect(afterWheel, 'the completed position is the stability baseline').toEqual(wheel.position)
      expect(Math.abs(afterWheel.y - beforeWheel.y), `the wheel really moved the page to completion (${beforeWheel.y} → ${afterWheel.y}, scrollend at ${wheel.lastScrollEndAt})`).toBeGreaterThan(20)
      await expect(titleButton(page, last), 'the wheel does not move focus').toBeFocused()
      await page.clock.runFor(32)
      expect(await probe.fired(), 'the guarded frame ran').toBe(true)
      const afterFrame = await pageScroll(page)
      scrolls = { beforeWheel, wheel, afterWheel, afterFrame }
      await testInfo.attach('restore-guard', { body: JSON.stringify({ clock: CLOCK_NOTE, ...scrolls }, null, 2), contentType: 'application/json' })
      expect(afterFrame, 'the deferred reveal does not pull the page back to the opener').toEqual(afterWheel)
      await expect(titleButton(page, last)).toBeFocused()
    } finally {
      await page.clock.resume()
    }
    expect(scrolls).not.toBeNull()
    expect((await readCommitted(page)).map(record => record.job.id).sort()).toEqual(records.map(record => record.job.id).sort())
  })
})
