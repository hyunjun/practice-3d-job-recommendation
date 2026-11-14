/**
 * Stage81 D2 final E2E: lifecycle regressions for the product review items
 * AP5 (a held native editor selection must not control a newer engaged field),
 * AP6 (a retired editor's late composition end must not discard the newer
 * field's pending visibility check) and AP2 (a held native scrollbar drag is a
 * manual abandonment that later geometry work must not undo)
 * (docs/design/dialog-focus-visibility.md, D2 candidate 01, SHA256 4f9f5cb4…).
 *
 * Prerequisites are established independently and asserted hard: read-only
 * samples of the engaged control prove it really left the port before a repair
 * is credited; a wheel is credited only once host polling has witnessed completed
 * native movement plus a scrollend; a scrollbar drag is credited only after the
 * scroller's own scrollTop proves the movement; a classic native scrollbar is
 * required to be rendered before the scrollbar case proceeds. No product utility,
 * CSS variable or product private state is read, nothing focuses, scrolls or
 * frames the page before an observation, and the original 0.5px/no-refocus
 * boundaries are kept.
 *
 * Measurement discipline for causal statements: every tuple that carries a
 * sequence number is read in ONE synchronous browser evaluation in a fixed
 * order (dialog rectangle first as the one layout boundary, then offsets,
 * range, measured scale and client origin, control box and painted indicator,
 * footer, ancestors and clip, viewport and window scroll, identity, UI, frame
 * and sentinel facts) and stamped AFTER the complete read; the facts a causal
 * statement relies on are then recaptured, and `coherent` certifies exactly that
 * they did not change within that evaluation. It certifies nothing about
 * anchoring or layout work between evaluations, and a coherent tuple is not a
 * snapshot of every public fact. Every consumed causal baseline, witness, tick,
 * verdict and endpoint tuple must be coherent, and "clear" for the engaged B
 * means control AND painted indicator inside the clip of that same coherent
 * tuple; the deliberately abandoned B of AP2 is never required to be clear.
 * Host-side judged verdicts are bracketed by markers in the same ordered log.
 * Content coordinates are normalized with each tuple's own client origin and
 * measured public scale (rendered height / offsetHeight), reported as read and
 * never forced to 1. AP2's late-A interval is accounted for by the accepted
 * scroll-route recorder (helpers/dialog-focus-visibility-scroll): its baseline
 * tuple T0 is read together with the nine route wrappers immediately after the
 * held drag returns, every later causal sample is a recorder tuple read after an
 * explicit tick, every public scroll call carries its own pre/post tuples, and
 * the final tuple Tf is read when the recorder is finalized before page time
 * resumes. Edges between consecutive tuples are judged for a deliberately
 * abandoned B: any owned outer movement fails, the settle prefix must be quiet,
 * only the release prefix may admit a measured clamp or a native-layout residual
 * with attached same-edge evidence and full context, and everything after the
 * pre-frame baseline must be quiet or a measured clamp. The absence of a frame is
 * never a native proof, and the browser's anchor is never named.
 *
 * Input provenance is labeled: mouse press/drag/release and wheel are real
 * pointer input; keyboard focus moves are real key presses; composition events
 * are explicit CompositionEvent dispatches on chosen elements (synthetic
 * lifecycle setup, not an OS IME). Two cases hold page time with Playwright's
 * public Clock, installed before navigation and paused only after the engaged
 * control settled: native input, layout, scroll/scrollend events and
 * ResizeObserver deliveries keep running while requestAnimationFrame waits for
 * explicit 16ms ticks, so pending product work can be witnessed as pending. The
 * AP6 ordering case additionally installs a labeled, initially pass-through
 * ResizeObserver wrapper so the retired end can be dispatched inside the
 * resize's own native observer delivery and later deliveries of that one
 * observer can be held until the judged verdict; this is a test-controlled
 * scheduling fixture, not ordinary resize scheduling. The scrollbar case runs in
 * a browser launched without Playwright's default hide-scrollbars flag so that a
 * classic native scrollbar exists; if the platform renders overlay scrollbars
 * instead, the rendered-scrollbar prerequisite fails and reports that
 * limitation honestly.
 *
 * Static-only boundary kept: AP4 (deferred sizing of a dialog retained beneath
 * another modal) has no reachable state here because the application replaces
 * modals; the reachable replacement path is covered by the intent spec.
 */
import { expect } from '@playwright/test'
import type { Locator, Page } from '@playwright/test'
import { UNDO_CLOCK, activeElementDescriptor, holdCompletionDelivery, literalOf, noteField, pauseContextClock, queueFrameProbe, seedSaved, test, titleButton } from './helpers/saved-removal-undo'
import { readCommitted } from './helpers/saved-lifecycle'
import { waitForSavedCommit } from './helpers/saved-store'
import { BACKUP_FOOTER_TEXT, BEACON, KeyboardWalk, LABEL, LANTERN, LEGACY_UNREADABLE_ENTRY, openSavedViewPlain, pressKey, walkUntil } from './helpers/dialog-focus-visibility'
import type { WalkStop } from './helpers/dialog-focus-visibility'
import {
  D2_CONTRACT, D2_LABEL, IMPORT_ROWS, caretGeometry, installFrameProbe, loadBackupFile, openBackupByKeyboard, openLanternDetail, readFrameProbe, scrollTopOf, settleLayout,
} from './helpers/dialog-focus-visibility-d2'
import type { CaretGeometry, FrameProbeResult } from './helpers/dialog-focus-visibility-d2'
import { armFrameCounter, markEngaged, recordNativeStop, wheelUntilComplete } from './helpers/dialog-focus-visibility-timing'
import type { WheelCompletion } from './helpers/dialog-focus-visibility-timing'
import {
  armReschedulerLog, armStaleEndOnResize, beginHeldMouseSelection, dispatchCompositionOn, dragScrollbarHeld, fixtureMark, installResizeObserverFixture, measureEngagedTuple,
  releaseResizeObserverGate, reschedulerLog, staleEndFixture,
} from './helpers/dialog-focus-visibility-lifecycle'
import type { CompositionDispatch, EngagedTuple, HeldScrollbarDrag, ReschedulerEntry, StaleEndFixtureState } from './helpers/dialog-focus-visibility-lifecycle'
import { SCROLL_ROUTES, finalizeScrollRouteRecorder, installScrollRouteRecorder, sampleRecorderTuple } from './helpers/dialog-focus-visibility-scroll'
import type { RecorderInstall, RecorderTuple, ScrollRouteRecord, ScrollRouteSnapshot } from './helpers/dialog-focus-visibility-scroll'

const asserted = (stop: WalkStop) => stop.judgement === 'asserted'
const SELECTION_TEXT = 'select81 anchor text for native mouse selection'
const NOTE_SELECTOR = 'textarea#saved-note'
const OUTSIDE_SELECTOR = '.collection-search input'
const HOLD_NOTE = 'Completion-delivery hold: the native readwrite commit on the saved database happens normally; only the application completion handler waits until release().'
const CLOCK_NOTE = 'Clock fixture (labeled): Playwright\'s public Clock is installed before navigation and paused only after the engaged control settled. While paused, page Date/performance/timers/requestAnimationFrame stop; native input, layout, scroll/scrollend events, ResizeObserver deliveries, microtasks and Playwright\'s injected scripts keep running. Frame opportunities are delivered by explicit 16ms ticks and witnessed by a one-shot sentinel; ordering is recorded with test-owned sequence numbers allocated after each complete synchronous read, never with page timestamps.'
const OBSERVER_FIXTURE_NOTE = 'ResizeObserver fixture (labeled test-controlled scheduling): a narrowly scoped, initially pass-through wrapper installed before the application runs. Actual entries are forwarded first with the wrapper as this/observer; observe/unobserve/disconnect delegate to the native observer; other observers are untouched. The dialog controller\'s observer is identified only by its public observed targets (the open dialog element). On the one armed delivery, after forwarding, the fixture reads the marked engaged control inside the same synchronous callback in the tuple\'s read order with the same recapture (a coherent witness of the same connected focused control, positive width and height, border-box occlusion, zero frame opportunities; an incoherent witness is recorded as a skipped delivery), closes a gate that queues later deliveries of that one observer, records a dispatch-start sequence, dispatches the synthetic retired compositionend, and records a dispatch-end sequence. Only that exact injected Event object is tagged as fixture traffic in the rescheduler log; every nested or unrelated event keeps its own kind. Gate and log stay sealed through the judged control/paint verdict, which is bracketed by markers in the same ordered log; release then restores pass-through delivery only (queued deliveries for still-observed targets are forwarded in order; the wrapper constructor and passive listeners remain for the page\'s lifetime).'

test.describe.configure({ timeout: 150_000 })

type Hold = Awaited<ReturnType<typeof holdCompletionDelivery>>
async function awaitHeldCompletion(hold: Hold) {
  await expect.poll(() => hold.completed(), { message: 'the native readwrite completion fired while its delivery is held' }).toBeGreaterThanOrEqual(1)
  expect(await hold.delivered(), 'no application handler ran while held').toBe(0)
}

/** Occlusion evidence from the frame probe: the engaged control was occluded in at least one sampled frame before a later frame shows it clear, with focus kept throughout. */
function occlusionEvidence(probe: FrameProbeResult) {
  const firstOccluded = probe.samples.findIndex(sample => sample.occluded)
  const clearedAfter = firstOccluded >= 0 && probe.samples.slice(firstOccluded).some(sample => !sample.occluded && sample.sameElement)
  const maxOverlap = probe.samples.reduce((most, sample) => Math.max(most, sample.overlapPx), 0)
  const focusKept = probe.samples.every(sample => sample.sameElement)
  return { frames: probe.samples.length, firstOccluded, clearedAfter, maxOverlap, focusKept }
}

/** The geometry fields the predicates use, as a structural shape (also satisfied by the timing helper's EngagedSample) so the predicates stay sampler-independent. */
type GeometrySample = Pick<EngagedTuple, 'sameElement' | 'connected' | 'top' | 'bottom' | 'portTop' | 'portBottom' | 'footerTop' | 'overlapPx' | 'dialogScrollTop' | 'dialogScrollHeight' | 'dialogClientHeight'>
/** The same connected, focused control that was marked as engaged, with a positive border-box height. */
const sameConnected = (sample: GeometrySample) => sample.sameElement && sample.connected && sample.bottom - sample.top > 0
/** Geometry with a measured width and height in addition to the shared fields; the lifecycle tuple and the AP2 recorder-tuple adapter both satisfy it. */
type PositiveGeometry = GeometrySample & { width: number; height: number }
/** The same connected, focused control with positive width AND height. */
const positiveBox = (sample: PositiveGeometry) => sameConnected(sample) && sample.width > 0 && sample.height > 0
/** Genuinely clear by the border box: inside the available port with no border-box overlap. */
const clearSample = (sample: GeometrySample) => sameConnected(sample) && sample.overlapPx <= 0.5
/** Clear by control AND painted indicator: the same connected focused B with a positive box and its paint inside the clip measured in the same coherent tuple. The first-clear and quiescent-clear observations use this; the deliberately abandoned B of AP2 is never required to satisfy it. */
const clearTuple = (tuple: EngagedTuple) => positiveBox(tuple) && tuple.paintClear && tuple.coherent
/** Genuinely outside the available port (below a sticky footer or the port bottom, or above the port top), not merely partly clipped. */
const outsideAvailablePort = (sample: GeometrySample) => {
  const limit = sample.footerTop ?? sample.portBottom
  return sample.top >= limit - 0.5 || sample.bottom <= sample.portTop + 0.5
}
/** The dialog's measured scroll range at a sample. */
const rangeOf = (sample: GeometrySample) => Math.max(0, sample.dialogScrollHeight - sample.dialogClientHeight)
/** Offset relation between consecutive samples: unchanged (0.5px), or the clamp projection onto a range that the previous offset had left. Anything else is unaccounted movement. */
const offsetAccounted = (from: GeometrySample, to: GeometrySample) =>
  Math.abs(to.dialogScrollTop - from.dialogScrollTop) <= 0.5 || (from.dialogScrollTop > rangeOf(to) + 0.5 && Math.abs(to.dialogScrollTop - rangeOf(to)) <= 0.5)
const round = (value: number) => Math.round(value * 100) / 100
/** One frame opportunity under a paused Clock: queue a one-shot requestAnimationFrame sentinel, run 16ms, report whether it fired. */
const clockFrame = (page: Page) => async () => {
  const sentinel = await queueFrameProbe(page)
  await page.clock.runFor(16)
  return sentinel.fired()
}

/* --------------------------------------------------------------------------
 * AP2 attribution ledger for a deliberately abandoned B (LR2).
 * -------------------------------------------------------------------------- */

const ATTRIBUTION_NOTE = 'Scroll-route recorder for the abandoned-B interval (labeled attribution instrumentation, helpers/dialog-focus-visibility-scroll): the nine public scrolling routes are wrapped transactionally in one evaluation together with the baseline tuple T0, read immediately after the held drag returned (mouse released, four settle frames delivered) and before the two quiet baseline ticks; automatic frame sampling is disabled under the paused Clock, so every later causal sample (two baselines, the pre-frame tuple, every tick) is a host read after an explicit tick stamped by the recorder\'s own integer counter, which every recorded call shares; finalization reads Tf, collects every tuple and record and restores every wrapper in one evaluation before page time resumes. The stream is judged for a deliberately abandoned B: any owned outer movement fails, valid no-op calls pass, the settle prefix must be quiet, only the release prefix may admit a measured clamp or a native-layout residual with attached same-edge evidence under full context, and every edge after the pre-frame tuple must be quiet or a measured clamp. Literal UI facts are read separately by DOM-only locator reads at their own instants; they are neither atomic with any recorder tuple nor proof that layout or observer work drained. The no-new-user-input premise is the spec sequence itself (no pointer or key input between the drag\'s mouse release and the fresh Tab after resume). Coverage is the nine named routes; the browser\'s scroll anchor is never named; the absence of a frame is never a native proof.'

/** Literal UI facts of the backup dialog read by DOM-only locator reads at one instant (no layout flush); neither atomic with any recorder tuple nor proof that layout or observer work drained. */
interface BackupUiFacts { messagePresent: boolean; recoverySources: number; importRows: number; rowCDetailsOpen: boolean }
const backupUi = async (dialog: Locator, rowC: Locator): Promise<BackupUiFacts> => ({
  messagePresent: (await dialog.locator('.saved-file-message').count()) > 0,
  recoverySources: await dialog.locator('.saved-recovery-source').count(),
  importRows: await dialog.locator('.saved-import-row').count(),
  rowCDetailsOpen: await rowC.locator('details').evaluate(node => (node as HTMLDetailsElement).open),
})

/** A recorder tuple's geometry in the shape the lifecycle predicates judge: a minimal structural adapter that fabricates no UI facts and never merges the recorder's integer order with the lifecycle tuple counter. */
interface AbandonedGeometry extends PositiveGeometry {
  sequence: number
  role: RecorderTuple['role']
  label: string | null
  coherent: boolean
  incoherentFacts: string[]
  sentinelFired: boolean | null
  contentTop: number
  dialogScrollLeft: number
  windowScroll: { x: number; y: number }
}
const geometryOf = (tuple: RecorderTuple): AbandonedGeometry => ({
  sequence: tuple.sequence, role: tuple.role, label: tuple.label,
  sameElement: tuple.engaged?.focused ?? false, connected: tuple.engaged?.connected ?? false,
  width: tuple.engaged?.rect.width ?? Number.NaN, height: tuple.engaged?.rect.height ?? Number.NaN,
  top: tuple.engaged?.rect.top ?? Number.NaN, bottom: tuple.engaged?.rect.bottom ?? Number.NaN,
  portTop: tuple.dialogClient?.top ?? Number.NaN, portBottom: tuple.dialogClient?.bottom ?? Number.NaN,
  footerTop: tuple.footer && tuple.footer.position === 'sticky' && !tuple.footer.containsEngaged ? tuple.footer.top : null,
  overlapPx: tuple.engaged?.overlapPx ?? Number.NaN,
  dialogScrollTop: tuple.dialogScrollTop, dialogScrollHeight: tuple.dialogScrollHeight, dialogClientHeight: tuple.dialogClientHeight,
  coherent: tuple.coherent, incoherentFacts: tuple.incoherentFacts, sentinelFired: tuple.sentinelFired,
  contentTop: tuple.engaged?.contentTop ?? Number.NaN, dialogScrollLeft: tuple.dialogScrollLeft, windowScroll: tuple.windowScroll,
})
/** The same connected focused positive B inside a connected dialog, as the recorder tuple reports it. */
const sameEngagedTuple = (tuple: RecorderTuple) => tuple.dialogConnected && tuple.engaged !== null && tuple.engaged.connected && tuple.engaged.focused && tuple.engaged.positiveFinite
/** Routes that set an offset directly; they can move only their own receiver's scroller. */
const DIRECT_OFFSET_ROUTES = new Set<string>(['Element.scrollTo', 'Element.scroll', 'Element.scrollBy', 'Element.scrollTop=', 'window.scrollTo', 'window.scroll', 'window.scrollBy'])

/** One tuple of the sorted stream with the record and end it belongs to (null for external tuples). */
interface StreamEntry { tuple: RecorderTuple; geometry: AbandonedGeometry; record: ScrollRouteRecord | null; end: 'pre' | 'post' | null }
/** settle: T0 → baseline-2 (quiet only); release: baseline-2 → pre-frame (quiet, measured clamp, or evidenced native layout); post: pre-frame → Tf (quiet or measured clamp). */
type AbandonedPhase = 'settle' | 'release' | 'post'

interface AbandonedCallVerdict {
  callSequence: number; method: string; receiver: string; relevance: ScrollRouteRecord['relevance']; depth: number
  displacement: number | null
  kind: 'owned-none' | 'owned-movement-after-abandonment' | 'forbidden-route' | 'unmeasured'
  pass: boolean
  reasons: string[]
}
/**
 * Judge one recorded public scroll call for a deliberately abandoned B. Context
 * first: the same connected focused positive B at both ends, coherent tuples,
 * unchanged horizontal dialog offset and window scroll. Then movement: a call
 * that moved the dialog by at most the write gate with intact context is a
 * valid owned-none record (no blanket zero-record or zero-focus rule); any owned
 * outer displacement above 0.5px fails in either direction, including a partial
 * reveal. No landing, nonzero-repair or clear-B rule applies here: B was
 * abandoned by a real manual drag and the product must not move it.
 */
function judgeAbandonedCall(record: ScrollRouteRecord): AbandonedCallVerdict {
  const base = { callSequence: record.callSequence, method: record.method, receiver: record.receiver, relevance: record.relevance, depth: record.depth }
  const reasons: string[] = []
  if (record.depth > 0) reasons.push(`nested inside recorded call ${record.parent} (a flat recorded stream is a prerequisite of this ledger)`)
  if (record.threw) reasons.push('the native call threw')
  if (record.error) reasons.push(`recorder bookkeeping failed: ${record.error}`)
  const { pre, post } = record
  if (!pre || !post || !pre.engaged || !post.engaged || !pre.dialogConnected || !post.dialogConnected) return { ...base, displacement: null, kind: 'unmeasured', pass: false, reasons: [...reasons, 'pre/post tuple or engaged facts unavailable'] }
  if (!sameEngagedTuple(pre) || !sameEngagedTuple(post)) reasons.push(`B is not the same connected focused positive control across the call (pre focused ${pre.engaged.focused}/connected ${pre.engaged.connected}, post focused ${post.engaged.focused}/connected ${post.engaged.connected})`)
  if (!pre.coherent || !post.coherent) reasons.push(`incoherent call tuple (${[...pre.incoherentFacts, ...post.incoherentFacts].join(', ')})`)
  if (Math.abs(post.dialogScrollLeft - pre.dialogScrollLeft) > 0.5) reasons.push(`horizontal dialog offset changed ${pre.dialogScrollLeft} → ${post.dialogScrollLeft}`)
  if (Math.abs(post.windowScroll.x - pre.windowScroll.x) > 0.5 || Math.abs(post.windowScroll.y - pre.windowScroll.y) > 0.5) reasons.push(`window scroll changed (${pre.windowScroll.x}, ${pre.windowScroll.y}) → (${post.windowScroll.x}, ${post.windowScroll.y})`)
  const displacement = round(post.dialogScrollTop - pre.dialogScrollTop)
  if (Math.abs(displacement) <= 0.5) return { ...base, displacement, kind: 'owned-none', pass: reasons.length === 0, reasons }
  const direct = DIRECT_OFFSET_ROUTES.has(record.method)
  const forbidden = direct ? record.relevance !== 'dialog' : record.relevance === 'ancestor' || record.relevance === 'other'
  return {
    ...base, displacement, kind: forbidden ? 'forbidden-route' : 'owned-movement-after-abandonment', pass: false,
    reasons: [...reasons, `${record.method} on ${record.relevance} receiver ${record.receiver} moved the dialog B was abandoned in by ${displacement}px (${forbidden ? 'this route earns no outer-dialog movement at all' : 'any owned outer movement of an abandoned B fails, including a partial reveal'})`],
  }
}

interface AbandonedEdge {
  from: number; to: number; fromRole: RecorderTuple['role']; toRole: RecorderTuple['role']; fromLabel: string | null; toLabel: string | null
  phase: AbandonedPhase
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
 * Judge one edge with no recorded call inside it, by phase. Context first: the
 * same connected focused positive B outside the available port at both ends,
 * coherent tuples, unchanged horizontal and window offsets. Settle (T0 →
 * baseline-2): quiet only. Release (baseline-2 → pre-frame): quiet, the measured
 * clamp projection onto a shrunken range, or a native-layout residual beside a
 * measured same-edge content, footer or range change, admitted only under the
 * sealed-input, nine-route coverage and integer-order context the ledger asserts
 * and never as proof of the browser's anchor. Post (pre-frame → Tf): quiet or the
 * measured clamp projection only. Nothing is excused by its position alone.
 */
function judgeAbandonedEdge(from: StreamEntry, to: StreamEntry, phase: AbandonedPhase): AbandonedEdge {
  const a = from.geometry
  const b = to.geometry
  const base = { from: a.sequence, to: b.sequence, fromRole: a.role, toRole: b.role, fromLabel: a.label, toLabel: b.label, phase, call: null }
  const delta = round(b.dialogScrollTop - a.dialogScrollTop)
  const contentShift = Number.isFinite(a.contentTop) && Number.isFinite(b.contentTop) ? round(b.contentTop - a.contentTop) : null
  const footerShift = a.footerTop !== null && b.footerTop !== null ? round(b.footerTop - a.footerTop) : (a.footerTop === null) !== (b.footerTop === null) ? Number.NaN : null
  const rangeChange = rangeOf(b) - rangeOf(a)
  const clampProjection = a.dialogScrollTop > rangeOf(b) + 0.5 ? round(rangeOf(b) - a.dialogScrollTop) : 0
  const facts = { delta, contentShift, footerShift, rangeChange, clampProjection }
  const context: string[] = []
  if (!sameEngagedTuple(from.tuple) || !sameEngagedTuple(to.tuple)) context.push('B is not the same connected focused positive control at both ends')
  if (!a.coherent || !b.coherent) context.push(`incoherent tuple (${[...a.incoherentFacts, ...b.incoherentFacts].join(', ')})`)
  if (!outsideAvailablePort(a) || !outsideAvailablePort(b)) context.push('B is not outside the available port at both ends')
  if (Math.abs(b.dialogScrollLeft - a.dialogScrollLeft) > 0.5) context.push(`horizontal dialog offset changed ${a.dialogScrollLeft} → ${b.dialogScrollLeft}`)
  if (Math.abs(b.windowScroll.x - a.windowScroll.x) > 0.5 || Math.abs(b.windowScroll.y - a.windowScroll.y) > 0.5) context.push('window scroll changed')
  if (context.length) return { ...base, ...facts, kind: 'context-broken', pass: false, evidence: context.join('; ') }
  if (Math.abs(delta) <= 0.5) return { ...base, ...facts, kind: 'quiet', pass: true, evidence: 'offset unchanged' }
  if (phase === 'settle') return { ...base, ...facts, kind: 'unexplained', pass: false, evidence: `offset changed ${delta}px between the after-drag baseline and the quiet baselines; only quiet edges are admitted before release` }
  if (clampProjection !== 0 && Math.abs(delta - clampProjection) <= 0.5) return { ...base, ...facts, kind: 'native-clamp', pass: true, evidence: `the previous offset ${a.dialogScrollTop} left the measured range 0..${rangeOf(b)}; projection ${clampProjection}px` }
  if (phase === 'release') {
    const layoutChanged = (contentShift !== null && Math.abs(contentShift) > 0.5) || (footerShift !== null && (Number.isNaN(footerShift) || Math.abs(footerShift) > 0.5)) || rangeChange !== 0
    if (layoutChanged) return { ...base, ...facts, kind: 'native-layout', pass: true, evidence: `release prefix with no recorded call inside this edge; B content top shift ${contentShift}px, footer shift ${footerShift}px, range change ${rangeChange}px, each from its own client origin and measured scale; admitted only under sealed input, the asserted nine-route coverage and integer order, with the same connected focused positive B outside the port at both ends; the browser's anchor is not named` }
    return { ...base, ...facts, kind: 'unexplained', pass: false, evidence: `offset changed ${delta}px in the release prefix with no recorded call and no measured layout change` }
  }
  return { ...base, ...facts, kind: 'unexplained', pass: false, evidence: `offset changed ${delta}px after the pre-frame tuple with no recorded call; only quiet or the measured clamp projection is admitted there` }
}

interface AbandonedLedger {
  /** The complete stream in integer order: every external tuple and every call pre/post tuple. */
  stream: { sequence: number; role: RecorderTuple['role']; label: string | null; call: number | null }[]
  integrity: string[]
  calls: AbandonedCallVerdict[]
  edges: AbandonedEdge[]
  phases: { settle: number; release: number; post: number }
  /** LA-B1: every tuple's window x/y and horizontal dialog offset against T0, and both quiet baselines' vertical offsets against T0. */
  baseline: {
    usable: boolean
    checked: number
    offenders: { sequence: number; role: RecorderTuple['role']; label: string | null; call: number | null; windowDelta: { x: number; y: number }; horizontalDelta: number }[]
    verticalOffenders: { sequence: number; label: string | null; dialogScrollTop: number; delta: number }[]
  }
  /** The release-prefix edges: the decided account of the pre-frame displacement that frozen13 could only label. */
  releaseAccount: AbandonedEdge[]
  /** Tf judged from itself: the same connected focused positive coherent B outside the port, after the last tick, offset related to it, sentinel fired. */
  endpoint: { tf: number | null; lastTick: number | null; pass: boolean; detail: string }
}

/** Assemble the complete recorder stream of the abandoned-B interval and judge it. Never throws: every problem becomes an integrity entry, a failing verdict or a failing edge, so the attachments stay complete on failure. */
function buildAbandonedLedger(snapshot: ScrollRouteSnapshot): AbandonedLedger {
  const integrity: string[] = []
  const entries: StreamEntry[] = snapshot.tuples.map(tuple => ({ tuple, geometry: geometryOf(tuple), record: null, end: null }))
  for (const record of snapshot.records) {
    if (record.pre) entries.push({ tuple: record.pre, geometry: geometryOf(record.pre), record, end: 'pre' }); else integrity.push(`call ${record.callSequence} ${record.method} has no pre tuple`)
    if (record.post) entries.push({ tuple: record.post, geometry: geometryOf(record.post), record, end: 'post' }); else integrity.push(`call ${record.callSequence} ${record.method} has no post tuple`)
  }
  entries.sort((left, right) => left.tuple.sequence - right.tuple.sequence)
  for (let index = 1; index < entries.length; index++) if (entries[index].tuple.sequence === entries[index - 1].tuple.sequence) integrity.push(`duplicate sequence ${entries[index].tuple.sequence}`)
  const find = (predicate: (tuple: RecorderTuple) => boolean) => entries.find(entry => predicate(entry.tuple))?.tuple ?? null
  const t0 = find(tuple => tuple.role === 'baseline')
  const baseline2 = find(tuple => tuple.role === 'host' && tuple.label === 'baseline-2')
  const preFrame = find(tuple => tuple.role === 'host' && tuple.label === 'pre-frame')
  const tf = find(tuple => tuple.role === 'final')
  const tickEntries = entries.filter(entry => entry.tuple.role === 'host' && (entry.tuple.label ?? '').startsWith('tick-'))
  const lastTick = tickEntries.length ? tickEntries[tickEntries.length - 1].tuple : null
  if (entries.filter(entry => entry.tuple.role === 'baseline').length !== 1) integrity.push(`${entries.filter(entry => entry.tuple.role === 'baseline').length} baseline tuple(s)`)
  if (!find(tuple => tuple.role === 'host' && tuple.label === 'baseline-1')) integrity.push('no baseline-1 tuple')
  if (!baseline2) integrity.push('no baseline-2 tuple')
  if (!preFrame) integrity.push('no pre-frame tuple')
  if (entries.filter(entry => entry.tuple.role === 'final').length !== 1) integrity.push(`${entries.filter(entry => entry.tuple.role === 'final').length} final tuple(s)`)
  if (tickEntries.length < 6) integrity.push(`${tickEntries.length} tick tuple(s); the causal series needs more than five`)
  if (tickEntries.length > 90) integrity.push(`${tickEntries.length} tick tuple(s); the ceiling is ninety`)
  if (entries.length && entries[0].tuple.role !== 'baseline') integrity.push(`the stream starts with ${entries[0].tuple.role} ${entries[0].tuple.sequence}, not T0`)
  if (entries.length && entries[entries.length - 1].tuple.role !== 'final') integrity.push(`the stream ends with ${entries[entries.length - 1].tuple.role} ${entries[entries.length - 1].tuple.sequence}, not Tf`)
  if (baseline2 && preFrame && baseline2.sequence > preFrame.sequence) integrity.push('baseline-2 is after pre-frame')
  if (preFrame && lastTick && preFrame.sequence > lastTick.sequence) integrity.push('pre-frame is after the last tick')
  if (!snapshot.finalized) integrity.push('the recorder was not finalized')
  if (snapshot.nested > 0) integrity.push(`${snapshot.nested} nested recorded call(s)`)
  if (snapshot.overflow) integrity.push(`recorder overflow (${snapshot.dropped} dropped)`)
  for (const error of snapshot.errors) integrity.push(`recorder error: ${error}`)
  const calls = snapshot.records.map(judgeAbandonedCall)
  const phaseOf = (toSequence: number): AbandonedPhase => baseline2 && toSequence <= baseline2.sequence ? 'settle' : preFrame && toSequence <= preFrame.sequence ? 'release' : 'post'
  const edges: AbandonedEdge[] = []
  for (let index = 1; index < entries.length; index++) {
    const left = entries[index - 1]
    const right = entries[index]
    const phase = phaseOf(right.tuple.sequence)
    if (left.end === 'pre' && right.end === 'post' && left.record !== null && left.record === right.record) {
      const verdict = calls.find(candidate => candidate.callSequence === left.record!.callSequence)!
      const contentShift = Number.isFinite(left.geometry.contentTop) && Number.isFinite(right.geometry.contentTop) ? round(right.geometry.contentTop - left.geometry.contentTop) : null
      const footerShift = left.geometry.footerTop !== null && right.geometry.footerTop !== null ? round(right.geometry.footerTop - left.geometry.footerTop) : null
      edges.push({
        from: left.tuple.sequence, to: right.tuple.sequence, fromRole: left.tuple.role, toRole: right.tuple.role, fromLabel: left.tuple.label, toLabel: right.tuple.label, phase, kind: 'owned', call: left.record.callSequence,
        delta: verdict.displacement ?? Number.NaN, contentShift, footerShift, rangeChange: rangeOf(right.geometry) - rangeOf(left.geometry), clampProjection: 0, pass: verdict.pass,
        evidence: verdict.reasons.length ? verdict.reasons.join('; ') : `${verdict.method}: ${verdict.kind}`,
      })
      continue
    }
    if (left.end === 'pre' || right.end === 'post') {
      integrity.push(`call tuple ${left.end === 'pre' ? left.tuple.sequence : right.tuple.sequence} is not adjacent to its own ${left.end === 'pre' ? 'post' : 'pre'} tuple (nested or interleaved)`)
      edges.push({ from: left.tuple.sequence, to: right.tuple.sequence, fromRole: left.tuple.role, toRole: right.tuple.role, fromLabel: left.tuple.label, toLabel: right.tuple.label, phase, kind: 'interleaved', call: left.record?.callSequence ?? right.record?.callSequence ?? null, delta: round(right.geometry.dialogScrollTop - left.geometry.dialogScrollTop), contentShift: null, footerShift: null, rangeChange: rangeOf(right.geometry) - rangeOf(left.geometry), clampProjection: 0, pass: false, evidence: 'call pre/post tuples are not adjacent' })
      continue
    }
    edges.push(judgeAbandonedEdge(left, right, phase))
  }
  const phases = { settle: edges.filter(edge => edge.phase === 'settle').length, release: edges.filter(edge => edge.phase === 'release').length, post: edges.filter(edge => edge.phase === 'post').length }
  // LA-B1: whole-stream window/horizontal baseline against T0 and the two quiet baselines' vertical offsets against T0; a non-finite T0 makes the baseline unusable.
  const usable = t0 !== null && Number.isFinite(t0.windowScroll.x) && Number.isFinite(t0.windowScroll.y) && Number.isFinite(t0.dialogScrollLeft) && Number.isFinite(t0.dialogScrollTop)
  const offenders: AbandonedLedger['baseline']['offenders'] = []
  const verticalOffenders: AbandonedLedger['baseline']['verticalOffenders'] = []
  if (t0 && usable) {
    for (const entry of entries) {
      const tuple = entry.tuple
      const windowDelta = { x: round(tuple.windowScroll.x - t0.windowScroll.x), y: round(tuple.windowScroll.y - t0.windowScroll.y) }
      const horizontalDelta = round(tuple.dialogScrollLeft - t0.dialogScrollLeft)
      // Non-finite deltas fail these comparisons, so a tuple without usable data is an offender, never a pass.
      if (!(Math.abs(windowDelta.x) <= 0.5 && Math.abs(windowDelta.y) <= 0.5 && Math.abs(horizontalDelta) <= 0.5)) offenders.push({ sequence: tuple.sequence, role: tuple.role, label: tuple.label, call: entry.record?.callSequence ?? null, windowDelta, horizontalDelta })
      if (tuple.role === 'host' && (tuple.label === 'baseline-1' || tuple.label === 'baseline-2')) {
        const delta = round(tuple.dialogScrollTop - t0.dialogScrollTop)
        if (!(Math.abs(delta) <= 0.5)) verticalOffenders.push({ sequence: tuple.sequence, label: tuple.label, dialogScrollTop: tuple.dialogScrollTop, delta })
      }
    }
  } else integrity.push(t0 ? `T0 ${t0.sequence} has a non-finite window scroll or offset; the whole-stream baseline is unusable` : 'no T0 for the window/horizontal baseline')
  let endpoint: AbandonedLedger['endpoint']
  if (!tf || !lastTick) endpoint = { tf: tf?.sequence ?? null, lastTick: lastTick?.sequence ?? null, pass: false, detail: 'Tf or the last tick tuple is missing' }
  else {
    const final = geometryOf(tf)
    const last = geometryOf(lastTick)
    const problems: string[] = []
    if (!positiveBox(final)) problems.push('B is not the same connected focused positive control at Tf')
    if (!outsideAvailablePort(final)) problems.push('B is not outside the available port at Tf')
    if (!final.coherent) problems.push(`Tf is incoherent (${final.incoherentFacts.join(', ')})`)
    if (!(tf.sequence > lastTick.sequence)) problems.push('Tf does not follow the last tick tuple')
    if (!offsetAccounted(last, final)) problems.push(`Tf offset ${final.dialogScrollTop} is neither unchanged from the last tick ${last.dialogScrollTop} nor its clamp projection onto 0..${rangeOf(final)}`)
    if (tf.sentinelFired !== true) problems.push('the sentinel queued before release had not fired at Tf')
    endpoint = { tf: tf.sequence, lastTick: lastTick.sequence, pass: problems.length === 0, detail: problems.length ? problems.join('; ') : 'Tf: the same connected focused positive coherent B outside the available port, after the last tick, offset accounted, sentinel fired' }
  }
  return {
    stream: entries.map(entry => ({ sequence: entry.tuple.sequence, role: entry.tuple.role, label: entry.tuple.label, call: entry.record?.callSequence ?? null })),
    integrity, calls, edges, phases, baseline: { usable, checked: usable ? entries.length : 0, offenders, verticalOffenders }, releaseAccount: edges.filter(edge => edge.phase === 'release'), endpoint,
  }
}

interface RecorderState { snapshot: ScrollRouteSnapshot | null; finalizeError: string | null }
const recorderState = (): RecorderState => ({ snapshot: null, finalizeError: null })
/** Finalize once: the body's result is kept; `finally` only finalizes when the body did not, retaining partial diagnostics on failure. */
async function finalizeIfNeeded(recorder: RecorderState, page: Page) {
  if (recorder.snapshot) return
  try {
    recorder.snapshot = await finalizeScrollRouteRecorder(page)
  } catch (error) {
    recorder.finalizeError = error instanceof Error ? error.message : String(error)
  }
}

/** The whole-interval attribution verdict for the abandoned B over the complete T0..Tf recorder stream. */
function expectAbandonedAccounting(recorder: RecorderState, ledger: AbandonedLedger | null, label: string) {
  expect(recorder.finalizeError, `${label}: the recorder finalized without error`).toBeNull()
  expect(recorder.snapshot, `${label}: the recorder stream was collected`).not.toBeNull()
  expect(ledger, `${label}: the ledger was built`).not.toBeNull()
  const snapshot = recorder.snapshot!
  const judged = ledger!
  expect(snapshot.wrapped, `${label}: the recorder covered every public scrolling route`).toEqual([...SCROLL_ROUTES])
  expect(snapshot.restored, `${label}: every wrapper was restored at finalization, in reverse order`).toEqual([...SCROLL_ROUTES].reverse())
  expect(judged.integrity, `${label}: one complete flat stream from T0 (after the drag) through Tf (before resume) in unique integer order, with baseline-1, baseline-2, pre-frame and six to ninety tick tuples, every call paired with adjacent pre/post tuples, no nested call, no overflow, no recorder error`).toEqual([])
  expect(judged.calls.filter(verdict => !verdict.pass), `${label}: every recorded public scroll call kept the same connected focused positive B, the window and the horizontal offset, and moved the dialog B was abandoned in by at most 0.5px; valid no-op calls are admitted, any owned outer movement fails`).toEqual([])
  expect(judged.baseline.usable, `${label}: T0 supplies a finite window, horizontal and vertical baseline`).toBe(true)
  expect(judged.baseline.offenders, `${label}: every tuple from T0 through Tf (external and call pre/post, ${judged.baseline.checked} checked) keeps window x/y and the horizontal dialog offset within 0.5px of T0`).toEqual([])
  expect(judged.baseline.verticalOffenders, `${label}: both quiet baselines keep the vertical offset within 0.5px of T0`).toEqual([])
  expect(judged.edges.filter(edge => !edge.pass), `${label}: every edge is an admitted owned no-op, quiet, a measured clamp projection, or (release prefix only) a native-layout residual with attached same-edge evidence under full context`).toEqual([])
  expect(judged.phases.settle, `${label}: the settle prefix (T0 → baseline-1 → baseline-2) is in the stream`).toBeGreaterThanOrEqual(2)
  expect(judged.phases.release, `${label}: the release prefix (baseline-2 → pre-frame) is in the stream`).toBeGreaterThanOrEqual(1)
  expect(judged.phases.post, `${label}: the post ticks through Tf are in the stream`).toBeGreaterThanOrEqual(7)
  expect(judged.endpoint.pass, `${label}: ${judged.endpoint.detail}`).toBe(true)
}

/** Preparation: open the detail, Tab to the note, type a literal and let it commit. */
async function noteWithText(page: Parameters<typeof openLanternDetail>[0], walk: KeyboardWalk, text: string) {
  const dialog = await openLanternDetail(page)
  const initial = await walk.observe('initial-close')
  expect(initial.name).toBe(LABEL.close)
  await walkUntil(walk, 'Tab', 'forward-to-note', stop => stop.name === LABEL.note, 60)
  await page.keyboard.type(text)
  await expect(noteField(dialog)).toHaveValue(text)
  await waitForSavedCommit(page)
  await settleLayout(page, 'after typing the literal')
  return dialog
}

test.describe('AP5 held native mouse selection at 320x800 (mouse pointer)', () => {
  test.use({ viewport: { width: 320, height: 800 }, hasTouch: false })

  test('same-editor native selection: a mouse drag selects literal text, release keeps value, selection and direction, Shift+ArrowLeft adjusts it natively, and nothing moves the dialog', async ({ page }, testInfo) => {
    const walk = new KeyboardWalk(page, testInfo, 'ap5-same-editor-selection', {
      contract: D2_CONTRACT, row: 'AP5 — 같은 editor의 native 선택', requirements: ['requirement 4', 'requirement 5'], viewport: { width: 320, height: 800 },
      measurement: 'Tab to the note, type a literal; real mouse press and drag inside the note (held), observe; release, observe; Shift+ArrowLeft, observe. Caret geometry is the modeled textarea geometry with the measured no-wrap precondition.',
    })
    const dialog = await noteWithText(page, walk, SELECTION_TEXT)
    const field = noteField(dialog)
    const carets: Record<string, CaretGeometry> = {}
    const scrolls: number[] = []
    try {
      const typed = await walk.observe('typed', 'type')
      scrolls.push(typed.probe.dialog?.scrollTop ?? Number.NaN)
      await beginHeldMouseSelection(page, field)
      const held = await walk.observe('selection-held', 'mouse-drag-held', { screenshot: true })
      scrolls.push(held.probe.dialog?.scrollTop ?? Number.NaN)
      carets.held = await caretGeometry(page)
      await page.mouse.up()
      await settleLayout(page, 'after the release')
      const released = await walk.observe('selection-released', 'mouse-up', { screenshot: true })
      scrolls.push(released.probe.dialog?.scrollTop ?? Number.NaN)
      carets.released = await caretGeometry(page)
      await pressKey(page, 'Shift+ArrowLeft')
      const adjusted = await walk.observe('selection-adjusted', 'Shift+ArrowLeft')
      scrolls.push(adjusted.probe.dialog?.scrollTop ?? Number.NaN)
      carets.adjusted = await caretGeometry(page)
    } finally {
      await walk.attach({ carets, scrolls })
    }

    expect(walk.stops.every(asserted)).toBe(true)
    expect(walk.failures(), `every stop is visible (see the ${walk.name}-stops attachment)`).toEqual([])
    const fromTyped = walk.stops.slice(walk.stops.findIndex(stop => stop.phase === 'typed'))
    expect(fromTyped.length, 'the typed, held, released and adjusted observations were recorded').toBe(4)
    expect(fromTyped.every(stop => stop.name === LABEL.note), 'the note keeps focus through press, drag, release and adjustment').toBe(true)
    expect(carets.held.selectionStart, 'the held drag selected text (noncollapsed)').toBeLessThan(carets.held.selectionEnd)
    expect(carets.held.direction, 'a left-to-right drag is a forward selection').toBe('forward')
    expect(carets.released, 'release keeps the exact selection').toMatchObject({ selectionStart: carets.held.selectionStart, selectionEnd: carets.held.selectionEnd, direction: 'forward', valueLength: SELECTION_TEXT.length })
    expect(carets.adjusted, 'Shift+ArrowLeft shrinks the forward selection by one from its focus end, natively').toMatchObject({ selectionStart: carets.released.selectionStart, selectionEnd: carets.released.selectionEnd - 1, direction: 'forward' })
    for (const [phase, geometry] of Object.entries(carets)) expect(geometry.noSoftWrap && geometry.caretInsideBox && geometry.caretInsideBodyArea, `${phase}: the modeled focus endpoint is visible`).toBe(true)
    expect(scrolls.every(value => Math.abs(value - scrolls[0]) <= 0.5), `no owned movement during the native selection: ${scrolls.join(', ')}`).toBe(true)
    await expect(field, 'the literal value is untouched by the selection').toHaveValue(SELECTION_TEXT)

    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await expect(titleButton(page, LANTERN)).toBeFocused()
    expect((await readCommitted(page)).find(record => record.job.id === LANTERN.job.id)?.note).toBe(SELECTION_TEXT)
  })

  test('held A selection, keyboard focus B: a real resize that hides B is repaired despite the held selection, a completed wheel then abandons B, and the old release neither rearms nor snaps B back', async ({ page }, testInfo) => {
    const walk = new KeyboardWalk(page, testInfo, 'ap5-held-a-focus-b', {
      contract: D2_CONTRACT, row: 'AP5 — 보류된 선택과 새 맥락', requirements: ['requirement 4', 'requirement 6'], viewport: { width: 320, height: 800 },
      measurement: 'Tab to the note (A), type; real mouse press and drag inside A and keep the button held; Shift+Tab to the applied toggle (B); frame probe on B; resize to 320x320 (B hidden, must be repaired while A is still held); a wheel witnessed to completion abandons B with focus kept, then the stable baseline is recorded; release the old press; observe.',
    })
    const dialog = await noteWithText(page, walk, SELECTION_TEXT)
    const field = noteField(dialog)
    let wheel: WheelCompletion | null = null
    let probe: FrameProbeResult | null = null
    const scrolls: Record<string, number | null> = { afterResize: null, afterWheel: null, afterRelease: null }
    const focus: Record<string, Awaited<ReturnType<typeof activeElementDescriptor>> | null> = { afterWheel: null, afterRelease: null }
    try {
      await beginHeldMouseSelection(page, field)
      const held = await walk.observe('a-selection-held', 'mouse-drag-held')
      expect((held.probe.active.selection?.start ?? 0) < (held.probe.active.selection?.end ?? 0), 'the held drag selected text in A').toBe(true)
      await pressKey(page, 'Shift+Tab')
      const engaged = await walk.observe('b-engaged-while-a-held', 'Shift+Tab', { screenshot: true })
      expect(engaged.name, 'Shift+Tab moves focus to the applied toggle while the mouse button is still held').toBe(LABEL.appliedToggle)
      expect(await installFrameProbe(page, 90), 'the frame probe is armed on B').toBe(true)
      await page.setViewportSize({ width: 320, height: 320 })
      await settleLayout(page, 'after the resize with the selection still held')
      probe = await readFrameProbe(page)
      const repaired = await walk.observe('b-after-resize-held-selection', 'resize:320x320', { screenshot: true })
      scrolls.afterResize = repaired.probe.dialog?.scrollTop ?? null
      wheel = await wheelUntilComplete(page, dialog, 200, { minMove: 50 })
      await settleLayout(page, 'after the completed wheel: the gesture tail may run before the baseline is taken')
      scrolls.afterWheel = await scrollTopOf(dialog)
      focus.afterWheel = await activeElementDescriptor(page)
      await page.mouse.up()
      await settleLayout(page, 'after the old selection release')
      scrolls.afterRelease = await scrollTopOf(dialog)
      focus.afterRelease = await activeElementDescriptor(page)
    } finally {
      await walk.attach({ wheel, probe, scrolls, focus })
    }

    const evidence = occlusionEvidence(probe!)
    expect(evidence.frames).toBeGreaterThan(5)
    expect(evidence.firstOccluded, 'FIXTURE PREREQUISITE (coverage failure if -1): the resize must really hide B in at least one sampled frame').toBeGreaterThanOrEqual(0)
    expect(evidence.clearedAfter, 'B is repaired while A\'s selection is still held').toBe(true)
    expect(evidence.focusKept, 'B keeps focus in every sampled frame').toBe(true)
    expect(walk.stops.every(asserted)).toBe(true)
    expect(walk.failures(), `every stop is visible, including B after the resize (see the ${walk.name}-stops attachment)`).toEqual([])
    expect(wheel?.moved ?? 0, `the wheel really moved the dialog to completion (${wheel?.before} → ${wheel?.after}, scrollend at ${wheel?.lastScrollEndAt})`).toBeGreaterThan(50)
    expect(focus.afterWheel?.text ?? '', 'B keeps focus through the manual movement').toContain(LABEL.appliedToggle)
    expect(Math.abs((scrolls.afterRelease ?? Number.NaN) - (scrolls.afterWheel ?? Number.NaN)), 'the old selection release neither rearms B nor snaps the dialog back (PF2: it may schedule a guarded check of the existing context, which must not move an abandoned B)').toBeLessThanOrEqual(0.5)
    expect(focus.afterRelease?.text ?? '', 'B still owns focus after the old release').toContain(LABEL.appliedToggle)
    await expect(field, 'the literal note value is untouched').toHaveValue(SELECTION_TEXT)

    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await expect(titleButton(page, LANTERN)).toBeFocused()
    expect((await readCommitted(page)).find(record => record.job.id === LANTERN.job.id)?.note).toBe(SELECTION_TEXT)
  })
})

test.describe('AP6 retired composition at 320x800', () => {
  test.use({ viewport: { width: 320, height: 800 }, hasTouch: true })

  test('stale A composition end delivered inside the resize\'s own native observer delivery while page time is held: the same connected, focused, positive-sized B is genuinely occluded with its repair still only queued when the retired end arrives, B is first clear only after that end under explicit frame ticks, the observer gate and the rescheduler log stay sealed through the judged control/paint verdict with no unrelated rescheduler, and composition events from outside the dialog remain only a stable boundary', async ({ page }, testInfo) => {
    // Labeled fixtures: the public Clock is installed before navigation and paused only after B settled; the pass-through ResizeObserver wrapper is installed before the application runs. Composition events are explicit synthetic dispatches, not an OS IME.
    await page.clock.install({ time: new Date(UNDO_CLOCK) })
    await installResizeObserverFixture(page)
    const walk = new KeyboardWalk(page, testInfo, 'ap6-stale-end-pending-b', {
      contract: D2_CONTRACT, row: 'AP6 — 은퇴한 composition의 늦은 end와 B의 대기 중 검사', requirements: ['requirement 4', 'requirement 6'], viewport: { width: 320, height: 800 },
      scope: 'Explicit CompositionEvent dispatches on the retired note (A) and on the page search box behind the dialog; not an OS IME. Keyboard focus moves and the resize are real.', clock: CLOCK_NOTE, observerFixture: OBSERVER_FIXTURE_NOTE,
      measurement: 'Tab to the note (A), type; compositionstart/update on A; Shift+Tab to the applied toggle (B); settle; pause page time; mark B and arm the frame counter; one same-evaluation coherent tuple of B (clear, control and paint); arm the rescheduler log and the one-shot hook; resize to 320x320. Inside the resize\'s native observer delivery, after forwarding the actual entries: read B in the same synchronous callback (a coherent witness of the same connected focused B, positive width and height, border-box occlusion by whatever native layout the shrink produced, zero frame opportunities), close the gate, record dispatch start, dispatch compositionend on A, record dispatch end. Then explicit 16ms ticks with one tuple each until four quiescent coherent tuples clear by control and paint (ceiling 90); marker; judged control/paint stop and a sealed tuple; marker; log snapshot; gate release; resume; capture; outside-dialog compositionstart/end as the limited stable boundary.',
    })
    const dialog = await noteWithText(page, walk, 'ab')
    const samples: EngagedTuple[] = []
    const dispatches: Record<string, CompositionDispatch | null> = { outsideStart: null, outsideEnd: null }
    const scrolls: Record<string, number | null> = { afterStaleEnd: null, afterOutside: null }
    let beforeResize: EngagedTuple | null = null
    let hookArmedSequence: number | null = null
    let logArmedSequence: number | null = null
    let fixture: StaleEndFixtureState | null = null
    let preRepair: EngagedTuple | null = null
    let firstClear: EngagedTuple | null = null
    let verdict: { begin: number; tuple: EngagedTuple; end: number } | null = null
    let repairTicks = 0
    let quiescentClear = 0
    let log: ReschedulerEntry[] = []
    let gateRelease: { forwarded: number; releasedSequence: number | null } | null = null
    let paused = false
    try {
      await dispatchCompositionOn(page, NOTE_SELECTOR, 'start')
      await dispatchCompositionOn(page, NOTE_SELECTOR, 'update', '가')
      await pressKey(page, 'Shift+Tab')
      const engaged = await walk.observe('b-engaged-after-retiring-a', 'Shift+Tab', { screenshot: true })
      expect(engaged.name, 'deliberate keyboard focus moves to the applied toggle (B)').toBe(LABEL.appliedToggle)
      await settleLayout(page, 'B settled before page time is held')
      await pauseContextClock(page)
      paused = true
      expect(await markEngaged(page), 'B is marked as the engaged control for the witnesses').toBe(true)
      await armFrameCounter(page)
      beforeResize = await measureEngagedTuple(page)
      expect(clearTuple(beforeResize) && clearSample(beforeResize), `B is connected, focused, positive-sized and clear (control and paint) in a coherent tuple before the resize (${JSON.stringify(beforeResize)})`).toBe(true)
      logArmedSequence = await armReschedulerLog(page)
      hookArmedSequence = await armStaleEndOnResize(page, NOTE_SELECTOR, '가')
      await page.setViewportSize({ width: 320, height: 320 })
      // Host polling of the fixture state only; nothing waits on page time. The hook either fired or recorded why it did not.
      await expect.poll(async () => {
        fixture = await staleEndFixture(page)
        return fixture.hook?.used === true || (fixture.hook?.skipped.length ?? 0) > 0
      }, { message: 'the resize\'s native ResizeObserver delivery carrying the open dialog entry reached the controller observer' }).toBe(true)
      fixture = await staleEndFixture(page)
      // The occlusion prerequisite is judged at the pre-end instant from the layout that actually exists then, whatever native work (UA scroll anchoring included) the shrink produced; a shrink that leaves B visible is a coverage failure, not a product verdict.
      expect(fixture.hook?.result, `FIXTURE PREREQUISITE (coverage failure if null, not a product defect): on the resize\'s own observer delivery the same connected, focused B must have a positive width and height and be genuinely occluded with zero frame opportunities so the retired end can be dispatched while its repair is only queued; skipped deliveries: ${JSON.stringify(fixture.hook?.skipped)}`).not.toBeNull()
      preRepair = await measureEngagedTuple(page)
      // Explicit frame ticks: the only way page requestAnimationFrame work can run from here. At least six samples are always taken (TN1 floor retained); the loop then stops after four quiescent samples that are clear by control AND paint in a coherent tuple, or at the 90-tick ceiling.
      let previousTop: number | null = null
      while (repairTicks < 90 && (quiescentClear < 4 || repairTicks < 6)) {
        await page.clock.runFor(16)
        repairTicks++
        const sample = await measureEngagedTuple(page)
        samples.push(sample)
        if (firstClear === null && clearTuple(sample)) firstClear = sample
        quiescentClear = clearTuple(sample) ? (previousTop !== null && Math.abs(sample.dialogScrollTop - previousTop) <= 0.5 ? quiescentClear + 1 : 1) : 0
        previousTop = sample.dialogScrollTop
      }
      // Sealed verdict: the gate is still closed and the log still recording. The judged control/paint stop (no frame, no screenshot) and one same-evaluation tuple are bracketed by markers in the same ordered log, so every event through the end of the verdict is inside the no-rescue window; only then are the log read and the gate released.
      const begin = await fixtureMark(page, 'verdict-begin')
      const afterStale = await recordNativeStop(walk, page, 'b-after-stale-a-end', 'compositionend(A, stale)')
      const tuple = await measureEngagedTuple(page)
      const end = await fixtureMark(page, 'verdict-end')
      verdict = { begin, tuple, end }
      scrolls.afterStaleEnd = afterStale.probe.dialog?.scrollTop ?? null
      log = await reschedulerLog(page)
      gateRelease = await releaseResizeObserverGate(page)
      fixture = await staleEndFixture(page)
      await page.clock.resume()
      paused = false
      // Capture after page time resumed; labeled by its own phase, not presented as a sealed observation.
      await walk.observe('b-after-stale-a-end-capture-after-resume', null, { screenshot: true })
      // Limited boundary only: B is already clear here, so these events can prove no more than that nothing moves.
      dispatches.outsideStart = await dispatchCompositionOn(page, OUTSIDE_SELECTOR, 'start')
      dispatches.outsideEnd = await dispatchCompositionOn(page, OUTSIDE_SELECTOR, 'end', 'x')
      await settleLayout(page, 'after composition events outside the dialog')
      const afterOutside = await walk.observe('b-after-outside-composition', 'composition(outside dialog)')
      scrolls.afterOutside = afterOutside.probe.dialog?.scrollTop ?? null
    } finally {
      if (paused) {
        if (gateRelease === null) gateRelease = await releaseResizeObserverGate(page)
        await page.clock.resume()
      }
      await walk.attach({ clock: CLOCK_NOTE, observerFixture: OBSERVER_FIXTURE_NOTE, beforeResize, hookArmedSequence, logArmedSequence, fixture, preRepair, samples, firstClear, verdict, repairTicks, quiescentClear, log, gateRelease, dispatches, scrolls })
    }

    // Pre-end instant, read inside the native delivery after the actual entries were forwarded: same connected focused B, positive width and height, real occlusion, zero frame opportunities.
    const hook = fixture!.hook!.result!
    expect(hook.witness.sameElement && hook.witness.connected, 'the witness inside the native delivery is the same connected, focused B').toBe(true)
    expect(hook.witness.coherent, `the pre-end witness is coherent: its recaptured dialog, window, control and footer facts did not change within the callback read (changed: ${hook.witness.incoherentFacts.join(', ') || 'none'})`).toBe(true)
    expect(hook.witness.width > 0 && hook.witness.height > 0, `B had a positive width and height when the retired end was dispatched (${hook.witness.width}x${hook.witness.height})`).toBe(true)
    expect(hook.witness.overlapPx, `B was genuinely occluded when the retired end was dispatched (overlap ${hook.witness.overlapPx}px, paint clear ${hook.witness.paintClear})`).toBeGreaterThan(0.5)
    expect(hook.witness.framesFired, 'no frame opportunity had run when the retired end was dispatched: B\'s repair was only queued').toBe(0)
    expect(hook, 'the retired end was dispatched on A while B was active, inside the open dialog').toMatchObject({ dispatched: true, wasActive: false, insideOpenDialog: true })
    expect(positiveBox(preRepair!) && preRepair!.coherent && preRepair!.overlapPx > 0.5, `right after the stale end B is still occluded (border box) in a coherent tuple and its repair still pending (${JSON.stringify(preRepair)})`).toBe(true)
    expect(preRepair!.frame, 'no frame opportunity ran between the stale end and the pre-repair tuple').toBe(0)
    expect(firstClear, `B became clear under the explicit ticks (ticks used ${repairTicks}, samples ${samples.length})`).not.toBeNull()
    expect(samples.length, 'enough samples were taken').toBeGreaterThan(5)
    expect(quiescentClear, `B stayed clear with an unchanged outer scroll for at least four consecutive samples within the 90-tick ceiling (ticks used: ${repairTicks})`).toBeGreaterThanOrEqual(4)
    expect(samples.every(sample => sample.sameElement && sample.connected), 'B keeps focus in every sample').toBe(true)
    expect(samples.every(sample => sample.coherent), `every tick tuple is coherent (its recaptured dialog, window, control and footer facts were unchanged within its evaluation): ${JSON.stringify(samples.filter(sample => !sample.coherent).map(sample => ({ sequence: sample.sequence, incoherentFacts: sample.incoherentFacts })))}`).toBe(true)
    // The judged verdict inside the sealed window: the D1 control/paint assessment is the judged stop (walk.failures below); the sealed tuple ties it to the sequence log.
    const sealedTuple = verdict!.tuple
    expect(positiveBox(sealedTuple) && clearSample(sealedTuple) && sealedTuple.paintClear && sealedTuple.coherent, `the sealed verdict tuple is the same connected, focused, positive-sized B with control and paint inside the available clip (${JSON.stringify(sealedTuple)})`).toBe(true)
    expect(Math.abs(sealedTuple.dialogScrollTop - samples[samples.length - 1].dialogScrollTop), 'the sealed verdict tuple relates to the last tick tuple: no further movement').toBeLessThanOrEqual(0.5)
    expect(fixture!.gate, 'the gate was closed at the hook and is released only after the verdict').toMatchObject({ closed: false })
    expect(fixture!.gate!.releasedSequence, 'the gate release was recorded').not.toBeNull()
    // Causal ordering from the shared sequence counter, every stamp allocated after its complete read.
    const order = [hookArmedSequence!, hook.forwardedSequence, hook.witness.sequence, hook.gateClosedSequence, hook.dispatchStartSequence, hook.dispatchEndSequence, preRepair!.sequence, firstClear!.sequence, verdict!.begin, sealedTuple.sequence, verdict!.end, fixture!.gate!.releasedSequence!]
    const strictlyIncreasing = order.every((value, index) => index === 0 || order[index - 1] < value)
    expect(strictlyIncreasing, `sequence order (adjacent strict <): armed < forwarded native delivery < pre-end witness < gate closed < dispatch start < dispatch end < pre-repair tuple < first clear tuple < verdict begin < sealed verdict tuple < verdict end < gate release; actual ${order.join(' < ')}`).toBe(true)
    // No-rescue window: from the forwarded native delivery through the verdict's end marker. Only the exact injected compositionend Event object is exempt; nested focus/input/composition events and relevant mutations keep their own kind and would fail here. Later deliveries of the controller's observer were held by the gate for the whole window.
    const sealed = log.filter(entry => entry.sequence > hook.forwardedSequence && entry.sequence < verdict!.end)
    const injected = sealed.filter(entry => entry.kind === 'fixture-compositionend')
    expect(injected.length, 'exactly one logged event is the injected compositionend Event object itself').toBe(1)
    expect(injected[0].sequence > hook.dispatchStartSequence && injected[0].sequence < hook.dispatchEndSequence, 'the injected event was logged between the recorded dispatch start and dispatch end').toBe(true)
    const unrelated = sealed.filter(entry => entry.kind !== 'fixture-compositionend' && entry.kind !== 'marker')
    expect(unrelated, 'no other event (resize, viewport, fonts, input/focus/composition, nested or not) and no relevant mutation occurred from the forwarded native delivery through the end of the judged verdict: nothing but the already-queued frame work supplied the repair').toEqual([])
    expect(log.some(entry => entry.kind === 'marker' && entry.detail === 'verdict-end' && entry.sequence === verdict!.end), 'the log snapshot contains the verdict\'s end marker, so nothing before the end of the verdict is missing from it').toBe(true)
    expect(walk.stops.every(asserted)).toBe(true)
    expect(walk.failures(), `every stop is visible, including the judged B stop inside the sealed window (see the ${walk.name}-stops attachment)`).toEqual([])
    expect(dispatches.outsideStart?.insideOpenDialog, 'the outside element is outside the open dialog').toBe(false)
    expect(Math.abs((scrolls.afterOutside ?? Number.NaN) - (scrolls.afterStaleEnd ?? Number.NaN)), 'limited boundary: composition events outside the dialog move nothing while B is already clear').toBeLessThanOrEqual(0.5)
    await expect(noteField(dialog), 'synthetic composition events insert no text').toHaveValue('ab')

    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await expect(titleButton(page, LANTERN)).toBeFocused()
    expect((await readCommitted(page)).find(record => record.job.id === LANTERN.job.id)?.note).toBe('ab')
  })

  test('manual abandonment then stale A composition end: a wheel witnessed to completion leaves B outside the available port with focus kept and a recorded stable baseline, and the retired end neither re-engages B nor snaps the dialog back', async ({ page }, testInfo) => {
    const walk = new KeyboardWalk(page, testInfo, 'ap6-stale-end-after-abandonment', {
      contract: D2_CONTRACT, row: 'AP6 — 수동 이동 후 늦은 composition end', requirements: ['requirement 4', 'requirement 6'], viewport: { width: 320, height: 800 },
      scope: 'Explicit CompositionEvent dispatches on the retired note (A); not an OS IME. The wheel is real pointer input witnessed to completion.',
      measurement: 'Tab to the note (A), type; compositionstart/update on A; Shift+Tab to the applied toggle (B); mark B; wheel until completed native movement scrolls B out of the available port; settle and record two stable baseline samples; dispatch compositionend on A (stale); settle; observe. No fresh focus or input after the wheel.',
    })
    const dialog = await noteWithText(page, walk, 'ab')
    let wheel: WheelCompletion | null = null
    let stale: CompositionDispatch | null = null
    const samples: Record<string, EngagedTuple | null> = { afterWheel: null, baseline: null, afterStale: null }
    const focus: Record<string, Awaited<ReturnType<typeof activeElementDescriptor>> | null> = { afterWheel: null, afterStale: null }
    try {
      await dispatchCompositionOn(page, NOTE_SELECTOR, 'start')
      await dispatchCompositionOn(page, NOTE_SELECTOR, 'update', '가')
      await pressKey(page, 'Shift+Tab')
      const engaged = await walk.observe('b-engaged-after-retiring-a', 'Shift+Tab', { screenshot: true })
      expect(engaged.name).toBe(LABEL.appliedToggle)
      expect(await markEngaged(page), 'B is marked as the engaged control').toBe(true)
      wheel = await wheelUntilComplete(page, dialog, 600, { minMove: 100 })
      await settleLayout(page, 'after the completed wheel: the gesture tail may run before the baseline is taken')
      samples.afterWheel = await measureEngagedTuple(page)
      focus.afterWheel = await activeElementDescriptor(page)
      await settleLayout(page, 'quiet interval for the stable baseline')
      samples.baseline = await measureEngagedTuple(page)
      stale = await dispatchCompositionOn(page, NOTE_SELECTOR, 'end', '가')
      await settleLayout(page, 'after the stale A end')
      samples.afterStale = await measureEngagedTuple(page)
      focus.afterStale = await activeElementDescriptor(page)
    } finally {
      await walk.attach({ wheel, stale, samples, focus })
    }

    expect(walk.stops.every(asserted)).toBe(true)
    expect(walk.failures(), `every stop before the abandonment is visible (see the ${walk.name}-stops attachment)`).toEqual([])
    expect([samples.afterWheel, samples.baseline, samples.afterStale].every(sample => sample !== null && positiveBox(sample) && sample.coherent), `the three abandonment tuples are coherent reads of the same connected, focused, positive-sized B (${JSON.stringify([samples.afterWheel, samples.baseline, samples.afterStale].map(sample => sample && { sequence: sample.sequence, coherent: sample.coherent, incoherentFacts: sample.incoherentFacts }))})`).toBe(true)
    expect(wheel?.moved ?? 0, `the wheel really moved the dialog to completion (${wheel?.before} → ${wheel?.after}, scrollend at ${wheel?.lastScrollEndAt})`).toBeGreaterThan(100)
    expect(samples.afterWheel !== null && sameConnected(samples.afterWheel) && outsideAvailablePort(samples.afterWheel), `FIXTURE PREREQUISITE (coverage failure if false): the completed wheel must leave the same connected, focused B genuinely outside the available port (${JSON.stringify(samples.afterWheel)})`).toBe(true)
    expect(focus.afterWheel?.text ?? '', 'B keeps focus through the manual movement').toContain(LABEL.appliedToggle)
    expect(Math.abs((samples.baseline?.dialogScrollTop ?? Number.NaN) - (samples.afterWheel?.dialogScrollTop ?? Number.NaN)), 'the baseline is stable before the stale end').toBeLessThanOrEqual(0.5)
    expect(stale, 'the stale end was dispatched on the retired editor').toMatchObject({ dispatched: true, wasActive: false, insideOpenDialog: true })
    expect(Math.abs((samples.afterStale?.dialogScrollTop ?? Number.NaN) - (samples.baseline?.dialogScrollTop ?? Number.NaN)), 'the retired composition end neither re-engages B nor snaps the dialog back (PF2: a guarded check of the existing context may run, but an intentionally abandoned B must not be moved)').toBeLessThanOrEqual(0.5)
    expect(samples.afterStale !== null && sameConnected(samples.afterStale) && outsideAvailablePort(samples.afterStale), 'B stays the same connected, focused node where the user left it, outside the available port').toBe(true)
    expect(focus.afterStale?.text ?? '', 'B still owns focus').toContain(LABEL.appliedToggle)

    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await expect(titleButton(page, LANTERN)).toBeFocused()
    expect((await readCommitted(page)).find(record => record.job.id === LANTERN.job.id)?.note).toBe('ab')
  })
})

const scrollbarTest = test.extend({
  launchOptions: { ignoreDefaultArgs: ['--hide-scrollbars'] },
})

scrollbarTest.describe('AP2 held native scrollbar at 320x480 (classic scrollbars restored for this browser)', () => {
  scrollbarTest.use({ viewport: { width: 320, height: 480 }, hasTouch: false })

  scrollbarTest('scrollbar held for six frame opportunities, dragged and released with the surviving Import Row C disclosure (B) focused and left outside the available port: with page time held, every public scroll call and every edge of the recorder stream from the after-drag baseline T0 through the final tuple Tf before resume is accounted for, the late archive deletion changes the layout without any owned movement of the dialog B was abandoned in, the same connected focused B stays outside the port through the pre-frame tuple and the product frames, and the next native Tab lands on a visible stop', async ({ page }, testInfo) => {
    // Labeled fixture: the public Clock is installed before navigation (seedSaved) and paused only after B settled. Native pointer input, layout and scroll events keep running; page requestAnimationFrame runs only on explicit ticks.
    await seedSaved(page, [BEACON, LEGACY_UNREADABLE_ENTRY])
    await openSavedViewPlain(page, [BEACON.job.title])
    const { dialog, opener } = await openBackupByKeyboard(page)
    await loadBackupFile(page, dialog, IMPORT_ROWS, 3)
    const rowC = dialog.locator('.saved-import-row').filter({ hasText: IMPORT_ROWS[2].job.title })
    const summaryC = rowC.locator('details > summary')
    const footerText = dialog.locator('.dialog-footer > span')
    const walk = new KeyboardWalk(page, testInfo, 'ap2-held-scrollbar-320x480', {
      contract: D2_CONTRACT, row: 'AP2 — 보류된 native scrollbar 드래그', requirements: ['requirement 4', 'requirement 6'], viewport: { width: 320, height: 480 }, hold: HOLD_NOTE, clock: CLOCK_NOTE, attribution: ATTRIBUTION_NOTE,
      browser: 'launched without the default --hide-scrollbars flag so a classic native scrollbar is rendered; the thumb position is modeled from the scroller\'s own metrics only to place the pointer',
      measurement: 'Tab to the archive deletion, Enter, Tab to the confirm action; hold completions; Enter (A); Shift+Tab to the download action (judged intermediate stop), Shift+Tab to the Import Row C disclosure (B, proved by its literal row and marked by node identity); settle; pause page time; one before-gesture lifecycle tuple (UI + validity); press the scrollbar thumb, hold six explicit frame opportunities, drag up, release, four settle frames; install the scroll-route recorder with its baseline tuple T0 (one evaluation, frame sampling disabled); two quiet baseline recorder tuples after one tick each; queue the sentinel; release A while paused (message above B, recovery removed below B, footer leaves busy); literal UI facts by DOM reads; pre-frame recorder tuple before any frame opportunity; explicit ticks with one recorder tuple each until four quiescent tuples (six to ninety); literal UI facts again; finalize (Tf, every record, wrappers restored, one evaluation) and judge Tf before resume; resume; next native Tab (judged). Every public scroll call and every edge of the T0..Tf stream is accounted for in the abandoned-B ledger.',
    })
    const records: { before: EngagedTuple | null; t0: RecorderTuple | null; preFrame: RecorderTuple | null; tf: RecorderTuple | null } = { before: null, t0: null, preFrame: null, tf: null }
    const baselineSamples: RecorderTuple[] = []
    const postSamples: RecorderTuple[] = []
    const ui: { beforePreFrame: BackupUiFacts | null; beforeTf: BackupUiFacts | null } = { beforePreFrame: null, beforeTf: null }
    let drag: HeldScrollbarDrag | null = null
    let installed: RecorderInstall | null = null
    let heldAtRelease: { completed: number; delivered: number } | null = null
    let ticks = 0
    let quiescent = 0
    const recorder = recorderState()
    let ledger: AbandonedLedger | null = null
    let paused = false
    try {
      const initial = await walk.observe('initial-close')
      expect(initial.name).toBe(LABEL.close)
      await walkUntil(walk, 'Tab', 'forward', stop => stop.name === LABEL.deleteArchive, 40)
      await walk.press('Enter', 'activate-delete-archive')
      await expect(footerText).toHaveText(BACKUP_FOOTER_TEXT.confirmDelete)
      await settleLayout(page, 'confirm footer')
      await walkUntil(walk, 'Tab', 'forward-to-confirm', stop => stop.name === LABEL.confirmDelete, 6)
      const hold = await holdCompletionDelivery(page)
      await pressKey(page, 'Enter')
      await awaitHeldCompletion(hold)
      await expect(footerText).toHaveText(D2_LABEL.busyFooter)
      await settleLayout(page, 'busy footer sized')
      const download = await walk.press('Shift+Tab', 'backward-into-body-while-busy', { screenshot: true })
      expect(download.name, 'the first body stop while busy is the download action (the deletion action is disabled); it is judged and retained, not the engaged control').toBe(LABEL.downloadOriginal)
      const summary = await walk.press('Shift+Tab', 'backward-to-row-c-disclosure', { screenshot: true })
      expect(summary.name, 'the surviving engaged control B is a row disclosure').toBe(D2_LABEL.importSummaryNew)
      await expect(summaryC, `B is the summary of the literal row "${IMPORT_ROWS[2].job.title}", which the archive deletion does not remove`).toBeFocused()
      expect(await markEngaged(page), 'B\'s DOM node identity is retained for every later sample').toBe(true)
      await settleLayout(page, 'B settled before page time is held')
      await walk.observe('b-engaged-before-drag', null, { screenshot: true })
      await pauseContextClock(page)
      paused = true
      await awaitHeldCompletion(hold)
      await expect(footerText, 'A is still held after the pause').toHaveText(D2_LABEL.busyFooter)
      // Before-gesture record (lifecycle tuple): a validity-guarded tuple of the same connected focused B whose UI facts are consumed (disclosure closed); its geometry is not a causal baseline. The causal baseline is the recorder's T0 below.
      records.before = await measureEngagedTuple(page)
      // Real native scrollbar gesture with six explicit frame opportunities while the button is held, then a drag witnessed by the scroller's own scrollTop, then release and four settle frames.
      drag = await dragScrollbarHeld(page, dialog, { holdFrames: 6, deltaY: -140, frame: clockFrame(page) })
      // Attribution instrumentation, one evaluation immediately after the drag returned: nine route wrappers installed transactionally and the baseline tuple T0 read and stamped by the recorder's own counter; frame sampling disabled under the paused Clock. From here every causal sample is a recorder tuple and every public scroll call carries its own pre/post tuples in the same integer order.
      installed = await installScrollRouteRecorder(page, { frameSamples: 0 })
      records.t0 = installed.baseline
      for (let quiet = 1; quiet <= 2; quiet++) {
        await clockFrame(page)()
        baselineSamples.push(await sampleRecorderTuple(page, `baseline-${quiet}`))
      }
      heldAtRelease = { completed: await hold.completed(), delivered: await hold.delivered() }
      // Late A while page time is still paused. Frame-deferred work waits for the explicit ticks below; synchronous public routes stay possible and are recorded by the wrappers, so attribution comes from the ledger, never from the absence of a frame. The one-shot sentinel queued here is read by every later recorder tuple in the same evaluation as its geometry.
      await queueFrameProbe(page)
      await hold.release()
      await expect(dialog.locator('.saved-file-message')).toContainText(D2_LABEL.deleteMessage)
      // Literal UI facts at this instant, by DOM-only locator reads: neither atomic with the next recorder tuple nor proof that layout or observer work drained.
      ui.beforePreFrame = await backupUi(dialog, rowC)
      records.preFrame = await sampleRecorderTuple(page, 'pre-frame')
      let previous = geometryOf(records.preFrame)
      // At least six samples are always taken (TN1 floor retained); the loop then stops after four quiescent samples or at the 90-tick ceiling.
      while (ticks < 90 && (quiescent < 4 || ticks < 6)) {
        await page.clock.runFor(16)
        ticks++
        const sample = await sampleRecorderTuple(page, `tick-${ticks}`)
        postSamples.push(sample)
        const geometry = geometryOf(sample)
        quiescent = positiveBox(geometry) && geometry.coherent && outsideAvailablePort(geometry) && Math.abs(geometry.dialogScrollTop - previous.dialogScrollTop) <= 0.5 ? quiescent + 1 : 0
        previous = geometry
      }
      // Literal UI facts again, immediately before finalization.
      ui.beforeTf = await backupUi(dialog, rowC)
      // Finalize in one evaluation while page time is still held: Tf read and stamped, every tuple and record collected, every wrapper restored in reverse. Tf is the last recorder geometry verdict before resume and the fresh Tab.
      recorder.snapshot = await finalizeScrollRouteRecorder(page)
      records.tf = recorder.snapshot?.tuples.find(tuple => tuple.role === 'final') ?? null
      ledger = recorder.snapshot ? buildAbandonedLedger(recorder.snapshot) : null
      // Endpoint judged BEFORE page time resumes and before any fresh input: Tf itself, the preceding tick, the sentinel and the literal UI facts read before finalization.
      expect(records.tf, 'the final tuple Tf was collected at finalization').not.toBeNull()
      const tf = geometryOf(records.tf!)
      const last = geometryOf(postSamples[postSamples.length - 1])
      expect(positiveBox(tf) && outsideAvailablePort(tf) && tf.coherent, `Tf before resume: the same connected, focused, positive-sized B is outside the available port in a coherent tuple (${JSON.stringify(tf)})`).toBe(true)
      expect(tf.sequence > last.sequence, 'Tf follows the last tick tuple').toBe(true)
      expect(offsetAccounted(last, tf), `Tf offset relates to the last tick tuple (${last.dialogScrollTop} → ${tf.dialogScrollTop}, range 0..${rangeOf(tf)}): unchanged or the clamp projection onto a shrunken range`).toBe(true)
      expect(tf.sentinelFired, 'the sentinel queued before release fired: frame opportunities were delivered by the ticks before Tf').toBe(true)
      expect(ui.beforeTf, 'before Tf: late A removed the archive, kept the three import rows, rendered its message, and the Row C disclosure stays closed').toEqual({ messagePresent: true, recoverySources: 0, importRows: 3, rowCDetailsOpen: false })
      await page.clock.resume()
      paused = false
      const next = await walk.press('Tab', 'next-native-stop-after-late-a', { screenshot: true })
      expect(next.probe.active.insideDialog, 'Tab moves focus inside the dialog after the scrollbar gesture and the late completion').toBe(true)
    } finally {
      // Finalize once, before page time resumes: the body's snapshot is kept; a failing body still finalizes here and keeps partial diagnostics.
      await finalizeIfNeeded(recorder, page)
      if (paused) await page.clock.resume()
      if (recorder.snapshot && !ledger) ledger = buildAbandonedLedger(recorder.snapshot)
      await walk.attach({ hold: HOLD_NOTE, clock: CLOCK_NOTE, attribution: ATTRIBUTION_NOTE, drag, installed, records, baselineSamples, heldAtRelease, ui, postSamples, ticks, quiescent, stream: recorder.snapshot, ledger, finalizeError: recorder.finalizeError })
    }

    expect(walk.stops.every(asserted)).toBe(true)
    expect(walk.failures(), `every judged stop is visible: the traversal to B, B before the drag, and the next native stop after late A (see the ${walk.name}-stops attachment)`).toEqual([])
    // The real held gesture: rendered classic scrollbar, six witnessed frame opportunities with the button held and no movement, an actual upward drag, a matching release that moves nothing.
    expect(drag!.geometry.rendered, 'a classic native scrollbar was rendered').toBe(true)
    expect(drag!.holdFramesWitnessed, 'six frame opportunities were delivered while the thumb was held').toEqual([true, true, true, true, true, true])
    expect(drag!.holdSamples.every(value => Math.abs(value - drag!.before) <= 0.5), `holding the thumb still for six frame opportunities moves nothing: ${drag!.holdSamples.join(', ')}`).toBe(true)
    expect(drag!.moved, `the held drag really moved the dialog upward (${drag!.before} → ${drag!.afterDrag})`).toBeLessThan(-40)
    expect(Math.abs(drag!.afterRelease - drag!.afterDrag), 'the matching release moves nothing further').toBeLessThanOrEqual(0.5)
    // B after the drag: T0 is the recorder's baseline, read with the route wrappers immediately after the drag returned: the same connected, focused, positive-sized node, genuinely outside the available port, coherent.
    expect(installed?.engagedSource, 'the recorder measures the marked Row C summary (B)').toBe('marker')
    expect(records.t0, 'the recorder baseline T0 was read when the wrappers were installed').not.toBeNull()
    const t0 = geometryOf(records.t0!)
    expect(positiveBox(t0) && outsideAvailablePort(t0) && t0.coherent, `FIXTURE PREREQUISITE (coverage failure if false): after the held drag the same connected, focused, positive-sized B must be genuinely outside the available port (${JSON.stringify(t0)})`).toBe(true)
    expect(baselineSamples.map(geometryOf).every(sample => positiveBox(sample) && sample.coherent && outsideAvailablePort(sample) && Math.abs(sample.dialogScrollTop - t0.dialogScrollTop) <= 0.5), `the two quiet baselines are coherent recorder tuples of B outside the port within 0.5px of T0's vertical offset: ${JSON.stringify(baselineSamples.map(sample => ({ label: sample.label, scrollTop: sample.dialogScrollTop, coherent: sample.coherent, incoherentFacts: sample.incoherentFacts })))}`).toBe(true)
    expect(heldAtRelease, 'A was still held when the baselines were recorded').toMatchObject({ delivered: 0 })
    expect(positiveBox(records.before!) && records.before!.coherent, `the before-gesture record is a coherent lifecycle tuple of the same connected, focused, positive-sized B (UI + validity; its geometry is not a causal baseline) (changed: ${records.before!.incoherentFacts.join(', ') || 'none'})`).toBe(true)
    expect(records.before!.ui.focusedDetailsOpen, 'B\'s disclosure is closed before the gesture').toBe(false)
    // Pre-frame tuple: the first recorder read after late A precedes any frame opportunity. B staying outside the available port is the hard prerequisite; the offset change since the after-drag baseline is no longer labeled but judged edge by edge in the ledger below (release prefix: quiet, the measured clamp projection, or a native-layout residual with attached same-edge evidence under full context; nothing is inferred from the absence of a frame).
    expect(records.preFrame, 'the pre-frame tuple was read').not.toBeNull()
    const preFrame = geometryOf(records.preFrame!)
    expect(preFrame.sentinelFired, 'no frame opportunity ran between release and the pre-frame tuple').toBe(false)
    expect(preFrame.coherent, `the pre-frame tuple is coherent (changed: ${preFrame.incoherentFacts.join(', ') || 'none'})`).toBe(true)
    expect(ui.beforePreFrame, 'before the pre-frame tuple: late A rendered its message, removed the archive, kept the three import rows, and the Row C disclosure stays closed (DOM reads at that instant)').toEqual({ messagePresent: true, recoverySources: 0, importRows: 3, rowCDetailsOpen: false })
    expect(positiveBox(preFrame), 'the same connected B stays focused with a positive box through late A').toBe(true)
    expect(outsideAvailablePort(preFrame), `FIXTURE PREREQUISITE (coverage failure if false, not a product defect): the layout change of late A must not itself bring B back into the available port, otherwise this fixture does not establish the held-abandonment boundary (${JSON.stringify(preFrame)})`).toBe(true)
    // Product frames after the pre-frame tuple: no owned movement, no snap toward B; the only tolerated offset change is the clamp projection when a later layout shrinks the range below the current offset. Every sample is a coherent recorder tuple.
    expect(postSamples.length, 'enough samples were taken').toBeGreaterThan(5)
    expect(quiescent, `B stayed the same connected focused node outside the available port with an unchanged offset for at least four consecutive samples within the 90-tick ceiling (ticks used: ${ticks})`).toBeGreaterThanOrEqual(4)
    let previousSample: AbandonedGeometry = preFrame
    for (const [index, raw] of postSamples.entries()) {
      const sample = geometryOf(raw)
      expect(positiveBox(sample) && outsideAvailablePort(sample), `sample ${index + 1} after the pre-frame tuple: B is still the same connected, focused, positive-sized node outside the available port (no snap back) ${JSON.stringify(sample)}`).toBe(true)
      expect(sample.coherent, `sample ${index + 1} is coherent (recaptured facts unchanged within its evaluation; changed: ${sample.incoherentFacts.join(', ') || 'none'})`).toBe(true)
      expect(offsetAccounted(previousSample, sample), `sample ${index + 1}: no unaccounted movement after the pre-frame tuple (${previousSample.dialogScrollTop} → ${sample.dialogScrollTop}, range 0..${rangeOf(sample)}); only the clamp projection onto a shrunken range is tolerated`).toBe(true)
      previousSample = sample
    }
    // The whole-interval attribution verdict over the complete T0..Tf recorder stream: every recorded public scroll call and every edge, with the release prefix's account attached as evidence.
    expectAbandonedAccounting(recorder, ledger, 'AP2 abandoned B')
    testInfo.annotations.push({ type: 'release-prefix-account', description: JSON.stringify(ledger!.releaseAccount.map(edge => ({ from: edge.from, to: edge.to, kind: edge.kind, delta: edge.delta, contentShift: edge.contentShift, footerShift: edge.footerShift, rangeChange: edge.rangeChange, clampProjection: edge.clampProjection, evidence: edge.evidence }))) })
    await expect(dialog.locator('.saved-recovery-source'), 'the archive was deleted by A').toHaveCount(0)
    await expect(dialog.locator('.saved-import-row'), 'the import rows are untouched').toHaveCount(3)
    expect(await rowC.locator('details').evaluate(node => (node as HTMLDetailsElement).open), 'B\'s disclosure state is unchanged (closed) after resume').toBe(false)

    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await expect(opener).toBeFocused()
    const committed = await readCommitted(page)
    expect(committed).toHaveLength(1)
    expect(committed[0], 'the saved record is untouched').toMatchObject(literalOf(BEACON))
  })
})
