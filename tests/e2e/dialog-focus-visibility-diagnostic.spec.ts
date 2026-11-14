/**
 * Stage81 DIAG81: TEMPORARY bounded diagnostic cases authored under the all3
 * common direction (.local/research/81/main/dev02-diagnostic-direction-proposal-02.json,
 * SHA256 cea2f6b2dd6d147d0a56f8054f0ff6c2c0a3a90c36dc39949ac64518c6d80fb4) and its
 * gate collaboration/diagnostic-direction-gate-02.json, corrected under the all3
 * correction direction (.local/research/81/main/diagnostic-source-correction-proposal-01.json,
 * SHA256 b18a4718e0f91189e8a9c15835c15402142553bd60ffb07fb4ac772fdf4dc05c, gate
 * collaboration/diagnostic-correction-direction-gate-01.json): C1 live-note assertion
 * before close, C2 immediate hold ownership, C3 atomic same-node raw-zero release gate,
 * C4 current-node font census, C5 labelled pre/post nested-application reader samples.
 * Not verification: no result here resolves a DEV02 failure, replaces the untouched
 * regressions or any final check/build/DEV/PROD run. This file is removed in a
 * reviewed later candidate before the final sequence.
 *
 * Five fixed cases (exact titles frozen by the proposal), one dedicated file run
 * whole with no --grep, one worker, zero retries, 150 s per case:
 *   A1 reproduces the lifecycle AP5 held-selection sequence (product16 unchanged)
 *      only through the judged B-after-resize stop, with the unchanged pass-through
 *      scroll-route recorder and a passive native signal log; its B visibility
 *      assertions stay real and may fail as in DEV02 (a raw failed case).
 *   A2 is the same sequence with the mouse button released natively before a
 *      fresh frame-probe/recorder baseline; release changes native state AND
 *      product input intent, so it is a comparison, never unique isolation.
 *   B1/B2 are observational surveys of the backup dialog footer, text rows, B
 *      geometry and font obligations at 320x480 and 320x320 with the authored 200%
 *      fixture; they assert record completeness only. The reader shortage is sampled
 *      twice: before the nested rendered-reference application and, after one bounded
 *      native return to the same actual summary and reader nodes, after it. The font
 *      ledger censuses every current dialog node, registered or not.
 *   B3 is the fixed zero-offset insertion probe at 320x800 / 100%; the held late
 *      completion is released inside the measured interval only by one synchronous
 *      page evaluation that re-samples the boundary tuple, rechecks the same actual
 *      row node and a raw unrounded scrollTop of 0 against the retained (rounded) T0,
 *      and invokes the same test-owned release; otherwise the unmet prerequisite is
 *      recorded and the release is cleanup outside the interval.
 *
 * Worker-scoped Playwright options (trace, screenshot) are set once at file top
 * level below; nested describes carry only the test-scoped viewport/hasTouch.
 * Order bounds: the native signal log, the recorder and the host-side phase log
 * each keep their own integer order; host-side markers pushed into the native
 * stream around each recorder read document a partial cross-stream order only.
 * performance.now values are diagnostic and may tie.
 */
import { expect } from '@playwright/test'
import type { Locator, Page, TestInfo } from '@playwright/test'
import { activeElementDescriptor, holdCompletionDelivery, noteField, test, titleButton } from './helpers/saved-removal-undo'
import { readCommitted } from './helpers/saved-lifecycle'
import { waitForSavedCommit } from './helpers/saved-store'
import { BACKUP_FOOTER_TEXT, BEACON, KeyboardWalk, LABEL, LANTERN, LEGACY_UNREADABLE_ENTRY, openSavedViewPlain, pressKey, seedSavedWithoutClock, walkUntil } from './helpers/dialog-focus-visibility'
import type { WalkStop } from './helpers/dialog-focus-visibility'
import {
  D2_CONTRACT, D2_LABEL, HARBOR, HARBOR_INCOMING, applyFontReferences, caretGeometry, doubleFonts, fontReferenceMismatches, fontReferences, installFrameProbe, loadBackupFile,
  openBackupByKeyboard, openLanternDetail, overflowAudit, readFrameProbe, restoreFonts, scrollTopOf, settleLayout, shortageIfSticky, snapshotFonts, verifyFonts,
} from './helpers/dialog-focus-visibility-d2'
import type { CaretGeometry, FontReferenceApplication, FrameProbeResult, OverflowAudit, ShortageMeasurement } from './helpers/dialog-focus-visibility-d2'
import { beginHeldMouseSelection, measureEngagedTuple } from './helpers/dialog-focus-visibility-lifecycle'
import type { EngagedTuple, HeldSelection } from './helpers/dialog-focus-visibility-lifecycle'
import { markEngaged } from './helpers/dialog-focus-visibility-timing'
import { SCROLL_ROUTES, finalizeScrollRouteRecorder, installScrollRouteRecorder, sampleRecorderTuple } from './helpers/dialog-focus-visibility-scroll'
import type { RecorderInstall, RecorderTuple, ScrollRouteSnapshot } from './helpers/dialog-focus-visibility-scroll'
import {
  CleanupLedger, DIAG81_CORRECTION, DIAG81_PROPOSAL, PhaseLog, ROW_SUMMARY_SELECTOR, activeElementHandle, atomicZeroOffsetRelease, attachSafely, disposeNativeSignalLog, exactScrollTop,
  fontObligationLedger, installNativeSignalLog, markNativeSignal, nodeIdentityFacts, occlusionEvidenceFromProbe, readB3ReleaseMarker, readNativeSignalLog, readerFontFacts, recorderEdgeSummary,
  referenceIdentityDrift, semanticReferences, surveyState, textareaSelection, toFontReferences,
} from './helpers/dialog-focus-visibility-diagnostic'
import type {
  B3ReleaseMarker, FontObligationLedger, NativeSignalDisposal, NativeSignalInstall, NativeSignalRead, NodeHandle, ReaderFontFacts, RecorderEdgeSummary, SemanticReference, SurveyState, ZeroOffsetGateResult,
} from './helpers/dialog-focus-visibility-diagnostic'

test.describe.configure({ timeout: 150_000 })
// trace and screenshot are WORKER-scoped options in the installed Playwright 1.63.0 (lib/index.js 73-74); a describe-level use would abort collection.
// They are set here, at file top level, before every describe; nested describes set only the test-scoped viewport/hasTouch.
test.use({ trace: 'on', screenshot: 'on' })

const TITLES = {
  A1: 'DIAG81-A1 AP5 held A focused B resize attribution: original sequence to the judged B stop with pass-through recorder and native signal log',
  A2: 'DIAG81-A2 AP5 comparison: identical sequence with the mouse button released before the resize',
  B1: 'DIAG81-B1 backup footer and B geometry survey at 320x480 with 200% authored fonts',
  B2: 'DIAG81-B2 backup footer and B geometry survey at 320x320 with 200% authored fonts',
  B3: 'DIAG81-B3 scrollTop-zero insertion probe at 320x800 and 100%: is a row disclosure visible within the port with a measured gap smaller than the late message height',
} as const

const SELECTION_TEXT = 'select81 anchor text for native mouse selection'
const NOTE_SELECTOR = 'textarea#saved-note'
const HOLD_NOTE = 'Completion-delivery hold: the native readwrite commit on the saved database happens normally; only the application completion handler waits until release().'
const DIAGNOSTIC_NOTE = `DIAG81 temporary diagnostic under ${DIAG81_PROPOSAL.path} (${DIAG81_PROPOSAL.sha256}), corrected under ${DIAG81_CORRECTION.path} (${DIAG81_CORRECTION.sha256}: C1 live-note assertion before close, C2 immediate hold ownership, C3 atomic same-node raw-zero release gate, C4 current-node font census, C5 labelled pre/post nested-application reader samples): observation of unchanged product16; not verification; no DEV02 failure is resolved by any outcome; the untouched regressions remain required.`
const ORDER_LIMITS_NOTE = 'Three independent integer orders (native signal log, recorder tuples, host phase log). Host-side markers in the native stream bracket each recorder read and document a PARTIAL cross-stream order only; performance.now is diagnostic and may tie; the frame probe and the recorder sampler are two per-frame readers whose layout flushes are a measurement interference; a native event with no recorded public route call is native/unattributed until the combined measurements discriminate mechanisms.'
const RECORDER_OPTIONS = { frameSamples: 90, maxTuples: 400, maxRecords: 200 } as const
/** Record-only capture of the measurement state taken after each measured interval closes; excluded from the asserted-stop predicates below. */
const CAPTURE_PHASE = 'measurement-state-before-cleanup'
const CAPTURE_NOTE = 'DIAG81 measurement-state capture after the measured interval; visibility is judged at the preceding asserted stop'

const DIFFERENCES_SELECTORS = ['.saved-record-comparison', '.saved-record-comparison *']
/** The reader paragraphs of an open description pane; also a NESTED_SELECTORS entry so the actual reader node's own 100% reference is addressable by its index among the current matches. */
const READER_SELECTOR = 'details.saved-record-description[open] > p'
const NESTED_SELECTORS = ['details.saved-record-description[open] > summary', READER_SELECTOR, 'details.saved-record-description[open] > pre']
const CONFIRM_SELECTORS = ['.saved-recovery-confirm', '.saved-recovery-confirm *', '.saved-recovery-footer-actions', '.saved-recovery-footer-actions *']
const FOOTER_SELECTORS = ['.dialog-footer', '.dialog-footer *']
const SURVEY_STATE_LABELS = ['idle100', 'review100', 'confirm100', 'reviewAfterCancel100', 'review200', 'bEngaged200', 'confirm200', 'busy200', 'completedReview200', 'completedReview200PostApplication'] as const

const asserted = (stop: WalkStop) => stop.judgement === 'asserted'
const measuredStops = (walk: KeyboardWalk) => walk.stops.filter(stop => stop.phase !== CAPTURE_PHASE)
const stopFacts = (stop: WalkStop) => ({ index: stop.index, phase: stop.phase, key: stop.key, name: stop.name, descriptor: stop.descriptor, kind: stop.kind, failures: stop.failures, dialogScrollTop: stop.probe.dialog?.scrollTop ?? null })

type Hold = Awaited<ReturnType<typeof holdCompletionDelivery>>
async function awaitHeldCompletion(hold: Hold) {
  await expect.poll(() => hold.completed(), { message: 'the native readwrite completion fired while its delivery is held' }).toBeGreaterThanOrEqual(1)
  expect(await hold.delivered(), 'no application handler ran while held').toBe(0)
}

/** Preparation copied from the lifecycle spec: open the detail, Tab to the note, type a literal and let it commit. */
async function noteWithText(page: Page, walk: KeyboardWalk, text: string) {
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

/**
 * Preparation copied from the intent spec: walk to the archive deletion, confirm, hold completions, Enter (A), busy footer.
 * C2: `adopt` receives the hold synchronously the moment it exists, before Enter, the held-completion wait, the busy-footer
 * expectation and the settle, so the caller's cleanup owns the installed hold even when one of those later steps throws.
 * The shared hold helper is unchanged.
 */
async function holdArchiveDeletion(page: Page, dialog: Locator, walk: KeyboardWalk, adopt: (hold: Hold) => void): Promise<Hold> {
  const initial = await walk.observe('initial-close')
  expect(initial.name).toBe(LABEL.close)
  await walkUntil(walk, 'Tab', 'forward', stop => stop.name === LABEL.deleteArchive, 40)
  await walk.press('Enter', 'activate-delete-archive')
  await expect(dialog.locator('.dialog-footer > span')).toHaveText(BACKUP_FOOTER_TEXT.confirmDelete)
  await settleLayout(page, 'confirm footer')
  await walkUntil(walk, 'Tab', 'forward-to-confirm', stop => stop.name === LABEL.confirmDelete, 6)
  const hold = await holdCompletionDelivery(page)
  adopt(hold)
  await pressKey(page, 'Enter')
  await awaitHeldCompletion(hold)
  await expect(dialog.locator('.dialog-footer > span')).toHaveText(D2_LABEL.busyFooter)
  await settleLayout(page, 'busy footer sized')
  return hold
}

interface RecorderState { snapshot: ScrollRouteSnapshot | null; finalizeError: string | null; summary: RecorderEdgeSummary | null }
const recorderState = (): RecorderState => ({ snapshot: null, finalizeError: null, summary: null })
/** Finalize once (closing the measured interval); keep the body's snapshot, retain partial diagnostics on failure. */
async function finalizeRecorder(recorder: RecorderState, page: Page) {
  if (recorder.snapshot) return
  try {
    recorder.snapshot = await finalizeScrollRouteRecorder(page)
    recorder.summary = recorder.snapshot ? recorderEdgeSummary(recorder.snapshot) : null
  } catch (error) {
    recorder.finalizeError = error instanceof Error ? error.message : String(error)
  }
}

/* --------------------------------------------------------------------------
 * A1/A2: the AP5 held-selection resize interval.
 * -------------------------------------------------------------------------- */

async function heldResizeDiagnostic(page: Page, testInfo: TestInfo, variant: 'held' | 'released') {
  const name = variant === 'held' ? 'diag81-a1-held-resize' : 'diag81-a2-released-resize'
  const walk = new KeyboardWalk(page, testInfo, name, {
    contract: D2_CONTRACT, row: 'AP5 — 보류된 선택과 새 맥락 (DIAG81 attribution, resize interval only)', requirements: ['requirement 4', 'requirement 6'], viewport: { width: 320, height: 800 }, diagnostic: DIAGNOSTIC_NOTE, orderLimits: ORDER_LIMITS_NOTE, variant,
    measurement: variant === 'held'
      ? 'Original lifecycle AP5 sequence: Tab to the note (A), type; real mouse press and drag inside A and keep the button held; Shift+Tab to the applied toggle (B); mark B; frame probe and the unchanged pass-through recorder immediately before the resize; resize 320x800 → 320x320; settle; judged B stop. The passive native signal log is installed after the final preparation and before the held selection. The later wheel/release phases of the original regression are NOT part of this case; they stay required in the untouched lifecycle spec.'
      : 'Same preparation and B engagement; then the mouse button is released natively and the release settles BEFORE a fresh frame probe and recorder baseline; then the same resize, settle and judged B stop. Release changes native state and the product\'s input intent at the same time, so this is a comparison that can support or weaken a held-state contribution; it is not unique causal isolation.',
  })
  const phases = new PhaseLog()
  const cleanup = new CleanupLedger()
  const recorder = recorderState()
  const pointer: { held: HeldSelection | null; releasedAt: 'before-resize' | 'cleanup' | null } = { held: null, releasedAt: null }
  const selection: Record<string, Awaited<ReturnType<typeof textareaSelection>> | null> = { held: null, beforeResize: null, afterJudged: null, afterCleanupRelease: null }
  const carets: Record<string, CaretGeometry> = {}
  const tuples: Record<string, RecorderTuple | null> = { afterSettle: null, verdict: null }
  const scrolls: Record<string, number | null> = { beforeResize: null, afterResize: null, afterCleanupRelease: null }
  const focus: Record<string, Awaited<ReturnType<typeof activeElementDescriptor>> | null> = { afterJudged: null, afterCleanupRelease: null }
  let signalInstall: NativeSignalInstall | null = null
  let signal: NativeSignalRead | null = null
  let disposal: NativeSignalDisposal | null = null
  let installed: RecorderInstall | null = null
  let probe: FrameProbeResult | null = null
  let probeArmed: boolean | null = null
  let mouseDown = false
  let dialog: Locator | null = null
  let field: Locator | null = null
  let openerFocusedAfterEscape: boolean | null = null
  try {
    dialog = await noteWithText(page, walk, SELECTION_TEXT)
    field = noteField(dialog)
    await phases.mark(page, 'preparation-complete')
    // Passive native signal log: installed in the final live document AFTER preparation and BEFORE the held selection.
    signalInstall = await installNativeSignalLog(page, { textareaSelector: NOTE_SELECTOR })
    await phases.mark(page, 'signal-log-installed')
    await markNativeSignal(page, 'before-held-selection')
    mouseDown = true
    pointer.held = await beginHeldMouseSelection(page, field)
    await markNativeSignal(page, 'after-held-selection')
    const heldStop = await walk.observe('a-selection-held', 'mouse-drag-held')
    selection.held = await textareaSelection(field)
    carets.held = await caretGeometry(page)
    expect((heldStop.probe.active.selection?.start ?? 0) < (heldStop.probe.active.selection?.end ?? 0), 'the held drag selected text in A').toBe(true)
    await pressKey(page, 'Shift+Tab')
    const engaged = await walk.observe('b-engaged-while-a-held', 'Shift+Tab', { screenshot: true })
    expect(engaged.name, 'Shift+Tab moves focus to the applied toggle while the mouse button is still held').toBe(LABEL.appliedToggle)
    expect(await markEngaged(page), 'B is marked as the engaged control').toBe(true)
    if (variant === 'released') {
      await markNativeSignal(page, 'before-native-release')
      await page.mouse.up()
      mouseDown = false
      pointer.releasedAt = 'before-resize'
      await settleLayout(page, 'after releasing the mouse button before the resize')
      await markNativeSignal(page, 'after-release-settled')
      await walk.observe('a-released-before-resize', 'mouse-up', { screenshot: true })
    }
    selection.beforeResize = await textareaSelection(field)
    scrolls.beforeResize = await scrollTopOf(dialog)
    await markNativeSignal(page, 'before-frame-probe')
    probeArmed = await installFrameProbe(page, 90)
    expect(probeArmed, 'the frame probe is armed on B').toBe(true)
    await markNativeSignal(page, 'before-recorder-install')
    installed = await installScrollRouteRecorder(page, RECORDER_OPTIONS)
    await markNativeSignal(page, 'after-recorder-install')
    await phases.mark(page, 'instrumentation-complete')
    await markNativeSignal(page, 'before-resize')
    await page.setViewportSize({ width: 320, height: 320 })
    await settleLayout(page, variant === 'held' ? 'after the resize with the selection still held' : 'after the resize with the selection released')
    await markNativeSignal(page, 'after-settle')
    tuples.afterSettle = await sampleRecorderTuple(page, 'after-settle')
    probe = await readFrameProbe(page)
    // The judged B stop of the original case (asserted below exactly as there).
    const repaired = await walk.observe('b-after-resize-held-selection', 'resize:320x320', { screenshot: true })
    scrolls.afterResize = repaired.probe.dialog?.scrollTop ?? null
    selection.afterJudged = await textareaSelection(field)
    focus.afterJudged = await activeElementDescriptor(page)
    await markNativeSignal(page, 'after-judged-stop')
    tuples.verdict = await sampleRecorderTuple(page, 'after-judged-stop', 'verdict')
    await finalizeRecorder(recorder, page)
    await markNativeSignal(page, 'after-recorder-finalized')
    await phases.mark(page, 'measured-interval-closed')
    signal = await readNativeSignalLog(page)
    await walk.observe(CAPTURE_PHASE, null, { screenshot: true, recordOnly: CAPTURE_NOTE })
    // C1: the instrumentation-completeness and original B assertions run here, inside the measured body after the capture and BEFORE finally closes the dialog,
    // in their original order, so the live note still exists for the literal check. A failure here is a raw failed case and still reaches the failure-safe cleanup below.
    // Instrumentation completeness first: an incomplete capture invalidates the diagnostic claim before any B verdict is read.
    expect(installed?.wrapped, 'the pass-through recorder wrapped every public scrolling route').toEqual([...SCROLL_ROUTES])
    expect(recorder.finalizeError, 'the recorder finalized without error').toBeNull()
    expect(recorder.snapshot?.finalized, 'the recorder stream was collected').toBe(true)
    expect(signalInstall?.installed, 'the passive native signal log was installed in the final document').toBe(true)
    expect(probe, 'the frame probe was read').not.toBeNull()
    // Then the original case's assertions, in its order, through the judged B stop. These are real; a failure here is a raw failed diagnostic case.
    const evidence = occlusionEvidenceFromProbe(probe!)
    expect(evidence.frames).toBeGreaterThan(5)
    expect(evidence.firstOccluded, 'FIXTURE PREREQUISITE (coverage failure if -1): the resize must really hide B in at least one sampled frame').toBeGreaterThanOrEqual(0)
    expect(evidence.clearedAfter, variant === 'held' ? 'B is repaired while A\'s selection is still held' : 'B is repaired after the released selection').toBe(true)
    expect(evidence.focusKept, 'B keeps focus in every sampled frame').toBe(true)
    expect(measuredStops(walk).every(asserted)).toBe(true)
    expect(walk.failures(), `every stop is visible, including B after the resize (see the ${walk.name}-stops attachment)`).toEqual([])
    await expect(field!, 'the literal note value is untouched').toHaveValue(SELECTION_TEXT)
  } finally {
    // Failure-safe, ordered cleanup: close the interval, read and dispose the log, attach, then release (cleanup movement), observe, attach the cleanup record.
    await cleanup.run('finalize-recorder-if-needed', () => finalizeRecorder(recorder, page))
    if (!probe) await cleanup.run('read-frame-probe', async () => { probe = await readFrameProbe(page); return probe.samples.length })
    if (!signal) await cleanup.run('read-signal-log', async () => { signal = await readNativeSignalLog(page); return signal?.count ?? null })
    disposal = await cleanup.run('dispose-signal-log', () => disposeNativeSignalLog(page))
    await cleanup.run('attach-record', () => walk.attach({
      diagnostic: DIAGNOSTIC_NOTE, variant, orderLimits: ORDER_LIMITS_NOTE, phases: phases.marks, pointer, selection, carets, signalInstall, signal, disposal, probeArmed, probe, installed, tuples,
      recorder: { finalizeError: recorder.finalizeError, snapshot: recorder.snapshot, edgeSummary: recorder.summary }, scrolls, focus,
      cleanupPending: mouseDown ? 'the held mouse button is released after this attachment, as recorded cleanup' : 'no held mouse button remains',
    }))
    if (mouseDown) await cleanup.run('release-held-mouse (cleanup movement, outside the measured interval)', async () => { await page.mouse.up(); mouseDown = false; pointer.releasedAt = 'cleanup'; return pointer.releasedAt })
    if (dialog && field) {
      const scroller = dialog
      const note = field
      await cleanup.run('observe-after-cleanup-release', async () => {
        await settleLayout(page, 'after the cleanup release')
        scrolls.afterCleanupRelease = await scrollTopOf(scroller)
        selection.afterCleanupRelease = await textareaSelection(note)
        focus.afterCleanupRelease = await activeElementDescriptor(page)
        return scrolls.afterCleanupRelease
      })
      await cleanup.run('escape-and-observe-opener', async () => {
        await page.keyboard.press('Escape')
        await expect(scroller).toHaveCount(0)
        openerFocusedAfterEscape = await titleButton(page, LANTERN).evaluate(element => element === document.activeElement)
        return openerFocusedAfterEscape
      })
    }
    await attachSafely(testInfo, `${name}-cleanup`, { steps: cleanup.steps, pointer, scrolls, selection, focus, openerFocusedAfterEscape }, cleanup)
  }
}

/* --------------------------------------------------------------------------
 * B1/B2: observational footer, text-row, B geometry and font-obligation survey.
 * -------------------------------------------------------------------------- */

async function backupSurvey(page: Page, testInfo: TestInfo, viewport: { width: number; height: number }) {
  const tag = `${viewport.width}x${viewport.height}`
  const name = `diag81-survey-${tag}`
  const walk = new KeyboardWalk(page, testInfo, name, {
    contract: D2_CONTRACT, row: '공간 부족/복귀 · 실제200% 작성 글꼴 (DIAG81 observational survey)', requirements: ['requirement 1', 'requirement 2', 'requirement 4', 'requirement 9', 'requirement 10'], viewport, diagnostic: DIAGNOSTIC_NOTE, hold: HOLD_NOTE, orderLimits: ORDER_LIMITS_NOTE,
    measurement: 'Fixed HARBOR / unreadable archive / one HARBOR_INCOMING review. At 100%: idle and review footers; open the differences pane and its current-record description/json panes natively and record their rendered semantic references; close them; enter the delete confirmation and record the confirm references; cancel (the first Tab after cancel is observed, never repaired). Authored 200% fixture with stamped write phases: snapshot, double, verify, obligation ledger; re-open the differences pane natively and apply/read back its references; open the description pane, capture the actual summary and reader nodes, enter the reader and take the PRE-nested-application shortage sample (the earlier broad differences application may already overlap this reader, so neither 100% nor a wrong size is inferred from order); open the json pane and apply/read back the nested references; one bounded native return (at most 12 Shift+Tabs) to the SAME description summary node and one Tab to the SAME reader node for the post-application shortage sample and readback facts (an unreached node is recorded, not searched for); mark the row disclosure (B) and measure its gap; delete confirmation again at 2× (same-font review200 → confirm200 comparison); hold completions, Enter (A), busy footer; Shift+Tab to B; signal log and recorder; release A inside the recorded interval; completed review footer; recreated footer nodes read back before and after their own font application. Observational: assertions cover record completeness only.',
  })
  const phases = new PhaseLog()
  const cleanup = new CleanupLedger()
  const recorder = recorderState()
  const states: SurveyState[] = []
  const snap = async (label: string) => { states.push(await surveyState(page, label, states.length + 1)) }
  const references: Record<string, SemanticReference[]> = {}
  const applications: Record<string, FontReferenceApplication> = {}
  const readbacks: Record<string, string[]> = {}
  const identity: Record<string, string[]> = {}
  const ledgers: Record<string, FontObligationLedger | null> = { afterDouble: null, afterReRender: null, afterConfirm: null, afterCompletion: null, final: null }
  const audits: Record<string, OverflowAudit> = {}
  const footerTexts: Record<string, string | null> = {}
  const fonts: { recorded: number | null; doubling: Awaited<ReturnType<typeof doubleFonts>> | null; verification: Awaited<ReturnType<typeof verifyFonts>> | null; restored: number | null; doubled: boolean } = { recorded: null, doubling: null, verification: null, restored: null, doubled: false }
  const tuples: Record<string, RecorderTuple | null> = { verdict: null }
  /** C5: the shortage sample at the first reader entry PRECEDES the nested rendered-reference application and is labelled as such. */
  let shortagePreNested: ShortageMeasurement | null = null
  /** C5: the shortage sample after the nested application/readback at the SAME reader node reached by the one bounded native return; null when that return did not reach it. */
  let shortagePostNested: ShortageMeasurement | null = null
  const readerFacts: Record<string, ReaderFontFacts | null> = { preNested: null, postNested: null }
  let postNestedReturn: { shiftTabs: number; summaryReached: boolean; readerReached: boolean; reasons: string[] } | null = null
  let readerStop: ReturnType<typeof stopFacts> | null = null
  let bGap: EngagedTuple | null = null
  let bBeforeRelease: EngagedTuple | null = null
  let signalInstall: NativeSignalInstall | null = null
  let signal: NativeSignalRead | null = null
  let disposal: NativeSignalDisposal | null = null
  let installed: RecorderInstall | null = null
  let hold: Hold | null = null
  let released: 'inside-interval' | 'cleanup' | null = null
  let dialog: Locator | null = null
  let opener: Locator | null = null
  let closed: { escaped: boolean; openerFocused: boolean | null; committedIds: string[]; harborNote: string | null } | null = null
  try {
    await seedSavedWithoutClock(page, [HARBOR, LEGACY_UNREADABLE_ENTRY])
    await openSavedViewPlain(page, [HARBOR.job.title])
    const opened = await openBackupByKeyboard(page)
    dialog = opened.dialog
    opener = opened.opener
    const footerText = dialog.locator('.dialog-footer > span')
    await snap('idle100')
    footerTexts.idle100 = await footerText.textContent()
    references.footerIdle100 = await semanticReferences(page, FOOTER_SELECTORS)
    await loadBackupFile(page, dialog, [HARBOR_INCOMING], 1)
    await snap('review100')
    footerTexts.review100 = await footerText.textContent()
    references.footerReview100 = await semanticReferences(page, FOOTER_SELECTORS)
    // State-transition prerequisites (the labels of the surveyed states), not product verdicts.
    const initial = await walk.observe('initial-close', null, { screenshot: true })
    expect(initial.name, 'the backup dialog opens with Close focused (preparation)').toBe(LABEL.close)
    const summary100 = await walkUntil(walk, 'Tab', 'forward-100pct', stop => D2_LABEL.importSummaryDifferent.test(stop.name), 40)
    if (summary100.probe.active.detailsOpen === false) await walk.press('Enter', 'open-differences-100pct')
    await settleLayout(page, 'differences panes at 100%')
    references.differences = await semanticReferences(page, DIFFERENCES_SELECTORS)
    const descriptionSummary100 = await walkUntil(walk, 'Tab', 'forward-100pct', stop => stop.name === D2_LABEL.recordDescriptionSummary, 12)
    if (descriptionSummary100.probe.active.detailsOpen === false) await walk.press('Enter', 'open-description-100pct')
    const jsonSummary100 = await walkUntil(walk, 'Tab', 'forward-100pct', stop => stop.name === D2_LABEL.recordJsonSummary, 12)
    if (jsonSummary100.probe.active.detailsOpen === false) await walk.press('Enter', 'open-json-100pct')
    await settleLayout(page, 'nested panes rendered at 100%')
    references.nested = await semanticReferences(page, NESTED_SELECTORS)
    // Close the panes natively in reverse so the later 2× phase re-renders them from the closed state.
    await walk.press('Enter', 'close-json-100pct')
    await walkUntil(walk, 'Shift+Tab', 'backward-100pct', stop => stop.name === D2_LABEL.recordDescriptionSummary, 12)
    await walk.press('Enter', 'close-description-100pct')
    await walkUntil(walk, 'Shift+Tab', 'backward-100pct', stop => D2_LABEL.importSummaryDifferent.test(stop.name), 12)
    await walk.press('Enter', 'close-differences-100pct')
    await walkUntil(walk, 'Tab', 'forward-100pct', stop => stop.name === LABEL.deleteArchive, 40)
    await walk.press('Enter', 'activate-delete-archive-100pct', { screenshot: true })
    await expect(footerText).toHaveText(BACKUP_FOOTER_TEXT.confirmDelete)
    await settleLayout(page, 'confirm controls at 100%')
    references.confirm = await semanticReferences(page, CONFIRM_SELECTORS)
    references.footerConfirm100 = await semanticReferences(page, FOOTER_SELECTORS)
    await snap('confirm100')
    footerTexts.confirm100 = await footerText.textContent()
    await walk.observe('already-focused-after-footer-change-100pct', 'footer-state-change', { screenshot: true })
    // Cancel: the first native Tab after cancelling is observed and recorded with its failures; no focus or scroll repair.
    await walkUntil(walk, 'Tab', 'forward-100pct', stop => stop.name === LABEL.cancelDelete, 6)
    await pressKey(page, 'Enter')
    await settleLayout(page, 'after cancelling the deletion at 100%')
    footerTexts.afterCancel100 = await footerText.textContent()
    await walk.press('Tab', 'first-tab-after-cancel-100pct', { screenshot: true })
    await snap('reviewAfterCancel100')
    // Authored 200% fixture; every write is a stamped phase, separate from the late-A interval below.
    await phases.mark(page, 'fonts:snapshot')
    fonts.recorded = await snapshotFonts(page)
    await phases.mark(page, 'fonts:double')
    fonts.doubling = await doubleFonts(page)
    fonts.doubled = true
    await settleLayout(page, 'after doubling the authored fonts')
    fonts.verification = await verifyFonts(page)
    ledgers.afterDouble = await fontObligationLedger(page)
    await phases.mark(page, 'fonts:doubled-settled')
    await snap('review200')
    footerTexts.review200 = await footerText.textContent()
    audits.review200 = await overflowAudit(page)
    await walk.observe('review-200pct', null, { screenshot: true })
    // Re-render the deferred containers natively and apply/read back their rendered 100% references.
    const summary200 = await walkUntil(walk, 'Tab', 'forward-200pct', stop => D2_LABEL.importSummaryDifferent.test(stop.name), 40)
    if (summary200.probe.active.detailsOpen === false) await walk.press('Enter', 'open-differences-200pct')
    await phases.mark(page, 'fonts:apply-differences')
    applications.differences = await applyFontReferences(page, toFontReferences(references.differences))
    await settleLayout(page, 'differences panes after applying their 2× references')
    readbacks.differences = fontReferenceMismatches(toFontReferences(references.differences), await fontReferences(page, DIFFERENCES_SELECTORS))
    identity.differences = referenceIdentityDrift(references.differences, await semanticReferences(page, DIFFERENCES_SELECTORS))
    const descriptionSummary200 = await walkUntil(walk, 'Tab', 'forward-200pct', stop => stop.name === D2_LABEL.recordDescriptionSummary, 12)
    if (descriptionSummary200.probe.active.detailsOpen === false) await walk.press('Enter', 'open-description-200pct')
    // C5: actual node witnesses (object identity) for the current-record description summary and its reader; the file record has an identically labelled summary.
    const summaryHandle: NodeHandle = await activeElementHandle(page)
    const reader = await walk.press('Tab', 'enter-description-reader-200pct', { screenshot: true })
    readerStop = stopFacts(reader)
    const readerHandle: NodeHandle = await activeElementHandle(page)
    // C5: PRE-nested-application sample. The broad differences application above may already have written this reader, so neither 100% nor a wrong size follows from order alone; the facts record what the registry says about this node now.
    shortagePreNested = await shortageIfSticky(page)
    readerFacts.preNested = await readerFontFacts(readerHandle, summaryHandle, READER_SELECTOR)
    await walk.press('Shift+Tab', 'back-to-description-summary-200pct')
    const jsonSummary200 = await walkUntil(walk, 'Tab', 'forward-200pct', stop => stop.name === D2_LABEL.recordJsonSummary, 12)
    if (jsonSummary200.probe.active.detailsOpen === false) await walk.press('Enter', 'open-json-200pct')
    await phases.mark(page, 'fonts:apply-nested')
    applications.nested = await applyFontReferences(page, toFontReferences(references.nested))
    await settleLayout(page, 'nested panes after applying their 2× references')
    readbacks.nested = fontReferenceMismatches(toFontReferences(references.nested), await fontReferences(page, NESTED_SELECTORS))
    identity.nested = referenceIdentityDrift(references.nested, await semanticReferences(page, NESTED_SELECTORS))
    // C5: exactly one bounded native return to the SAME description summary node (at most 12 Shift+Tabs), then one Tab to the SAME reader node; identity by node, never by the duplicated label or a descriptor. An unreached node is recorded, not searched for.
    postNestedReturn = { shiftTabs: 0, summaryReached: false, readerReached: false, reasons: [] }
    for (let presses = 1; presses <= 12 && !postNestedReturn.summaryReached; presses++) {
      await walk.press('Shift+Tab', `c5-return-to-description-summary-${presses}`)
      postNestedReturn.shiftTabs = presses
      postNestedReturn.summaryReached = (await nodeIdentityFacts(summaryHandle)).isActive
    }
    if (postNestedReturn.summaryReached) {
      await walk.press('Tab', 'c5-re-enter-description-reader-200pct', { screenshot: true })
      const readerNow = await nodeIdentityFacts(readerHandle)
      postNestedReturn.readerReached = readerNow.isActive
      if (readerNow.isActive) {
        shortagePostNested = await shortageIfSticky(page)
        readerFacts.postNested = await readerFontFacts(readerHandle, summaryHandle, READER_SELECTOR)
        readbacks.nestedAtReaderReturn = fontReferenceMismatches(toFontReferences(references.nested), await fontReferences(page, NESTED_SELECTORS))
      } else postNestedReturn.reasons.push(`one Tab from the summary focused ${readerNow.descriptor}, not the same reader node`)
    } else postNestedReturn.reasons.push('the same description summary node was not focused within 12 Shift+Tabs')
    ledgers.afterReRender = await fontObligationLedger(page)
    // B candidate: the row's own disclosure summary; its gap to the footer measured by the lifecycle tuple.
    await walkUntil(walk, 'Shift+Tab', 'backward-200pct', stop => D2_LABEL.importSummaryDifferent.test(stop.name), 16)
    expect(await markEngaged(page), 'the row disclosure summary (B candidate) is marked for the engaged measurements').toBe(true)
    bGap = await measureEngagedTuple(page)
    await snap('bEngaged200')
    // Same-font comparison: review200 → confirm200.
    await walkUntil(walk, 'Tab', 'forward-200pct', stop => stop.name === LABEL.deleteArchive, 40)
    await walk.press('Enter', 'activate-delete-archive-200pct', { screenshot: true })
    await expect(footerText).toHaveText(BACKUP_FOOTER_TEXT.confirmDelete)
    await phases.mark(page, 'fonts:apply-confirm')
    applications.confirm = await applyFontReferences(page, toFontReferences(references.confirm))
    await settleLayout(page, 'confirm controls after applying their 2× references')
    readbacks.confirm = fontReferenceMismatches(toFontReferences(references.confirm), await fontReferences(page, CONFIRM_SELECTORS))
    identity.confirm = referenceIdentityDrift(references.confirm, await semanticReferences(page, CONFIRM_SELECTORS))
    ledgers.afterConfirm = await fontObligationLedger(page)
    await snap('confirm200')
    footerTexts.confirm200 = await footerText.textContent()
    audits.confirm200 = await overflowAudit(page)
    await walk.observe('already-focused-after-footer-change-200pct', 'footer-state-change', { screenshot: true })
    // Late A under hold; the recorder brackets only the release interval.
    await walkUntil(walk, 'Tab', 'forward-to-confirm-200pct', stop => stop.name === LABEL.confirmDelete, 6)
    hold = await holdCompletionDelivery(page)
    await pressKey(page, 'Enter')
    await awaitHeldCompletion(hold)
    await expect(footerText).toHaveText(D2_LABEL.busyFooter)
    await settleLayout(page, 'busy footer sized')
    await snap('busy200')
    footerTexts.busy200 = await footerText.textContent()
    audits.busy200 = await overflowAudit(page)
    references.footerBusy200Unreferenced = await semanticReferences(page, FOOTER_SELECTORS)
    await walkUntil(walk, 'Shift+Tab', 'backward-while-busy-200pct', stop => D2_LABEL.importSummaryDifferent.test(stop.name), 16, { screenshot: true })
    expect(await markEngaged(page), 'B is marked before the late-A interval').toBe(true)
    bBeforeRelease = await measureEngagedTuple(page)
    signalInstall = await installNativeSignalLog(page, { textareaSelector: null })
    await markNativeSignal(page, 'before-recorder-install')
    await phases.mark(page, 'lateA:recorder-install')
    installed = await installScrollRouteRecorder(page, RECORDER_OPTIONS)
    await markNativeSignal(page, 'after-recorder-install')
    await markNativeSignal(page, 'before-release')
    await hold.release()
    released = 'inside-interval'
    await phases.mark(page, 'lateA:released')
    await expect(dialog.locator('.saved-file-message')).toContainText(D2_LABEL.deleteMessage)
    await settleLayout(page, 'after the late completion rendered its message')
    await markNativeSignal(page, 'after-settle')
    tuples.verdict = await sampleRecorderTuple(page, 'after-completion', 'verdict')
    await walk.observe('b-after-late-a-200pct', 'late-completion')
    await finalizeRecorder(recorder, page)
    await markNativeSignal(page, 'after-recorder-finalized')
    await phases.mark(page, 'lateA:interval-closed')
    signal = await readNativeSignalLog(page)
    await snap('completedReview200')
    footerTexts.completed200 = await footerText.textContent()
    audits.completed200 = await overflowAudit(page)
    // Recreated footer nodes after completion: readback BEFORE and AFTER their own font application, each a separate phase outside the late-A interval.
    readbacks.footerCompletedPreApplication = fontReferenceMismatches(toFontReferences(references.footerReview100), await fontReferences(page, FOOTER_SELECTORS))
    await phases.mark(page, 'fonts:apply-footer-after-completion')
    applications.footerAfterCompletion = await applyFontReferences(page, toFontReferences(references.footerReview100))
    await settleLayout(page, 'footer after applying its 2× references after the completion')
    readbacks.footerCompletedPostApplication = fontReferenceMismatches(toFontReferences(references.footerReview100), await fontReferences(page, FOOTER_SELECTORS))
    identity.footerCompleted = referenceIdentityDrift(references.footerReview100, await semanticReferences(page, FOOTER_SELECTORS))
    ledgers.afterCompletion = await fontObligationLedger(page)
    await snap('completedReview200PostApplication')
    await walk.observe(CAPTURE_PHASE, null, { screenshot: true, recordOnly: CAPTURE_NOTE })
  } finally {
    await cleanup.run('finalize-recorder-if-needed', () => finalizeRecorder(recorder, page))
    if (!signal) await cleanup.run('read-signal-log', async () => { signal = await readNativeSignalLog(page); return signal?.count ?? null })
    disposal = await cleanup.run('dispose-signal-log', () => disposeNativeSignalLog(page))
    if (hold && !released) {
      const pending = hold
      await cleanup.run('release-held-completion (cleanup, outside any measured interval)', async () => { await pending.release(); released = 'cleanup'; return released })
    }
    await cleanup.run('attach-record', () => walk.attach({
      diagnostic: DIAGNOSTIC_NOTE, orderLimits: ORDER_LIMITS_NOTE, phases: phases.marks, states, footerTexts, references, applications, readbacks, identity, ledgers, audits, fonts, shortagePreNested, shortagePostNested, readerFacts, postNestedReturn, readerStop, bGap, bBeforeRelease,
      c5ReaderReference: (() => {
        const reference = references.nested?.find(entry => entry.selector === READER_SELECTOR) ?? null
        const facts = readerFacts.postNested
        const expected = reference && facts && facts.selectorIndex >= 0 ? reference.sizes[facts.selectorIndex] ?? null : null
        return {
          readerSelector: READER_SELECTOR, reference100Sizes: reference?.sizes ?? null, postNestedSelectorIndex: facts?.selectorIndex ?? null,
          expected2x: expected === null ? null : Math.round(expected * 200) / 100, postNestedComputed: facts?.computedFontSizePx ?? null,
          readerAt2x: expected === null || !facts ? null : Math.abs(facts.computedFontSizePx - 2 * expected) <= 0.2,
          meaning: 'readerAt2x true supports a rendered-2× reader at the post-application sample only; null or false is an unmet or unknown fact, not a wrong-size claim. The pre-nested sample is never certified by this later readback.',
        }
      })(),
      signalInstall, signal, disposal, installed, tuples, recorder: { finalizeError: recorder.finalizeError, snapshot: recorder.snapshot, edgeSummary: recorder.summary }, released,
      observedStopFailures: walk.failures(), observationalOnly: 'B survey: assertions cover record completeness; footer height/wrap, occlusion and visibility outcomes are recorded, not asserted.',
      sameFontComparison: (() => {
        const review = states.find(state => state.label === 'review200')
        const confirm = states.find(state => state.label === 'confirm200')
        return review && confirm ? {
          reviewHeight: review.footer.rect?.height ?? null, confirmHeight: confirm.footer.rect?.height ?? null,
          heightDelta: review.footer.rect && confirm.footer.rect ? Math.round((confirm.footer.rect.height - review.footer.rect.height) * 100) / 100 : null,
          reviewWrapped: review.footerRows.wrapped, confirmWrapped: confirm.footerRows.wrapped, reviewMode: review.footer.position, confirmMode: confirm.footer.position,
          reviewFlowAttribute: review.metrics.footerFlowAttribute, confirmFlowAttribute: confirm.metrics.footerFlowAttribute,
        } : null
      })(),
    }))
    if (fonts.doubled) await cleanup.run('restore-fonts', async () => { fonts.restored = await restoreFonts(page); ledgers.final = await fontObligationLedger(page); return fonts.restored })
    if (dialog && opener) {
      const scroller = dialog
      const button = opener
      await cleanup.run('escape-and-observe', async () => {
        await page.keyboard.press('Escape')
        const escaped = await scroller.count() === 0
        const openerFocused = await button.evaluate(element => element === document.activeElement)
        const committed = await readCommitted(page)
        closed = { escaped, openerFocused, committedIds: committed.map(record => record.job.id), harborNote: committed.find(record => record.job.id === HARBOR.job.id)?.note ?? null }
        return closed
      })
    }
    await attachSafely(testInfo, `${name}-cleanup`, { steps: cleanup.steps, released, fontsRestored: fonts.restored, finalLedger: ledgers.final, closed }, cleanup)
  }

  // Completeness only: every planned observation exists; no product outcome is asserted here.
  expect(states.map(state => state.label), 'every survey state was recorded in order').toEqual([...SURVEY_STATE_LABELS])
  expect(references.differences?.some(reference => reference.count > 0), 'the differences panes were rendered at 100% for their references').toBe(true)
  expect(references.nested?.some(reference => reference.count > 0), 'the nested description/json panes were rendered at 100% for their references').toBe(true)
  expect(references.confirm?.some(reference => reference.count > 0), 'the confirm controls were rendered at 100% for their references').toBe(true)
  expect(fonts.verification, 'the 2× verification was read').not.toBeNull()
  expect([ledgers.afterDouble, ledgers.afterReRender, ledgers.afterConfirm, ledgers.afterCompletion].every(ledger => ledger?.registryPresent === true), 'every font-obligation ledger phase was recorded against the fixture registry').toBe(true)
  expect(shortagePreNested, 'the pre-nested-application shortage sample was read with the description reader focused').not.toBeNull()
  expect(postNestedReturn, 'the one bounded post-application return was attempted and recorded (an unreached node is data, not a failure)').not.toBeNull()
  expect(bGap, 'the B candidate gap tuple was measured').not.toBeNull()
  expect(installed?.wrapped, 'the pass-through recorder wrapped every public scrolling route').toEqual([...SCROLL_ROUTES])
  expect(recorder.finalizeError, 'the recorder finalized without error').toBeNull()
  expect(recorder.snapshot?.finalized, 'the late-A recorder stream was collected').toBe(true)
  expect(released, 'the late completion was released inside the recorded interval').toBe('inside-interval')
  expect(signalInstall?.installed, 'the passive native signal log was installed before the late-A interval').toBe(true)
  expect(disposal?.listenersRemoved ?? 0, 'the native signal log listeners were removed').toBeGreaterThan(0)
}

/* --------------------------------------------------------------------------
 * B3: fixed zero-offset insertion probe.
 * -------------------------------------------------------------------------- */

async function zeroOffsetProbe(page: Page, testInfo: TestInfo) {
  const name = 'diag81-b3-zero-offset-probe'
  const walk = new KeyboardWalk(page, testInfo, name, {
    contract: D2_CONTRACT, row: 'B 편집 후 A 때문에 실제 가림 (DIAG81 zero-offset probe)', requirements: ['requirement 4', 'requirement 6'], viewport: { width: 320, height: 800 }, diagnostic: DIAGNOSTIC_NOTE, hold: HOLD_NOTE, orderLimits: ORDER_LIMITS_NOTE,
    measurement: 'Fixed BEACON / unreadable archive / one HARBOR_INCOMING new row at 320x800 and 100%. Measure the unique direct new-row disclosure (B) at scrollTop 0, its gap to the footer and the archive block; Tab to the archive deletion, Enter, Tab to the confirm action, hold completions, Enter (A); then exactly one bounded native sequence: Home, Shift+Tab, forward Tab at most 8 times, recording every stop and offset. Release A inside a recorder-bracketed interval ONLY when, in one synchronous page evaluation, the boundary recorder tuple and the retained (rounded) T0 both show the SAME actual row node connected, focused, positive-finite, coherent, control and paint inside the clip and not occluded, and the raw unrounded dialog.scrollTop is exactly 0; the same test-owned hold release is invoked in that evaluation, with the attempt recorded before the call. Otherwise record the unmet prerequisite and release A as cleanup outside any measured interval. No DOM focus/scroll writes, no alternate viewport or data, no retry.',
  })
  const phases = new PhaseLog()
  const cleanup = new CleanupLedger()
  const recorder = recorderState()
  const states: SurveyState[] = []
  const snap = async (label: string) => { states.push(await surveyState(page, label, states.length + 1)) }
  const sequence: { phase: string; name: string; exactScrollTop: number; probeScrollTop: number | null; failures: string[] }[] = []
  const tuples: Record<string, RecorderTuple | null> = { verdict: null }
  let rowSummaryCount: number | null = null
  let rowSummaryText: string | null = null
  let baseline: { exactScrollTop: number; rowSummaryGapToFooter: number | null; archiveHeight: number | null } | null = null
  /** Early candidate facts at the end of the bounded native sequence, BEFORE the survey and instrumentation; not the release gate (C3). */
  let earlyPrerequisite: { met: boolean; reached: boolean; exactScrollTop: number | null; focusedIsRowSummary: boolean | null; visibleFailures: string[] | null; reason: string } | null = null
  /** B's control/paint/clip tuple at the end of the bounded sequence, read only when the row disclosure is natively focused (no focus write). */
  let bAtSequenceEnd: EngagedTuple | null = null
  let signalInstall: NativeSignalInstall | null = null
  let signal: NativeSignalRead | null = null
  let disposal: NativeSignalDisposal | null = null
  let installed: RecorderInstall | null = null
  /** C2: adopted synchronously by holdArchiveDeletion's callback the moment the hold exists, before Enter, completion, busy and settle. */
  let hold: Hold | null = null
  /** C3 release bookkeeping. 'released-inside-interval' only when the atomic gate released without a throw; a thrown or partially delivered release stays 'attempted-inside-interval-error'. */
  const release: {
    outcome: 'not-attempted' | 'released-inside-interval' | 'attempted-inside-interval-error' | 'released-cleanup' | 'cleanup-error'
    gate: ZeroOffsetGateResult | null
    gateEvaluationError: string | null
    marker: B3ReleaseMarker | null
    markerReadError: string | null
    cleanupError: string | null
  } = { outcome: 'not-attempted', gate: null, gateEvaluationError: null, marker: null, markerReadError: null, cleanupError: null }
  let dialog: Locator | null = null
  let opener: Locator | null = null
  let closed: { escaped: boolean; openerFocused: boolean | null; committedIds: string[] } | null = null
  const record = async (phase: string, stop: WalkStop, scroller: Locator) => {
    sequence.push({ phase, name: stop.name, exactScrollTop: await exactScrollTop(scroller), probeScrollTop: stop.probe.dialog?.scrollTop ?? null, failures: stop.failures })
  }
  try {
    await seedSavedWithoutClock(page, [BEACON, LEGACY_UNREADABLE_ENTRY])
    await openSavedViewPlain(page, [BEACON.job.title])
    const opened = await openBackupByKeyboard(page)
    dialog = opened.dialog
    opener = opened.opener
    await snap('idle100')
    await loadBackupFile(page, dialog, [HARBOR_INCOMING], 1)
    const rowSummary = dialog.locator(ROW_SUMMARY_SELECTOR)
    rowSummaryCount = await rowSummary.count()
    expect(rowSummaryCount, 'exactly one direct row disclosure summary exists (the new-row disclosure of this seed)').toBe(1)
    rowSummaryText = await rowSummary.textContent()
    await expect(rowSummary, 'the single row is new in this seed, so its disclosure carries the new-row label').toHaveText(D2_LABEL.importSummaryNew)
    // C3: the actual row node (object identity) that every later identity check compares against; a count, label or descriptor never substitutes for it.
    const rowHandle: NodeHandle = await rowSummary.elementHandle()
    await snap('loaded100')
    const loaded = states[states.length - 1]
    baseline = { exactScrollTop: await exactScrollTop(dialog), rowSummaryGapToFooter: loaded.rowSummaryGapToFooter, archiveHeight: loaded.archive.rect?.height ?? null }
    // C2: the hold is adopted synchronously inside the preparation the moment it exists, so finally owns it even if Enter, completion, busy or settle throws.
    hold = await holdArchiveDeletion(page, dialog, walk, created => { hold = created })
    await snap('busy100AfterA')
    // The one bounded native sequence of the proposal.
    await pressKey(page, 'Home')
    await record('home', await walk.observe('home', 'Home', { screenshot: true }), dialog)
    const shiftTab = await walk.press('Shift+Tab', 'shift-tab-after-home', { screenshot: true })
    await record('shift-tab-after-home', shiftTab, dialog)
    let reached: WalkStop | null = shiftTab.name === D2_LABEL.importSummaryNew ? shiftTab : null
    for (let presses = 1; presses <= 8 && !reached; presses++) {
      const stop = await walk.press('Tab', `forward-tab-${presses}`, { screenshot: true })
      await record(`forward-tab-${presses}`, stop, dialog)
      if (stop.name === D2_LABEL.importSummaryNew) reached = stop
    }
    const exact = await exactScrollTop(dialog)
    // Early candidate identity: the SAME row node captured at load is document.activeElement right now (object identity; a label match is not enough).
    const focusedIsRowSummary = (await nodeIdentityFacts(rowHandle)).isActive
    if (focusedIsRowSummary) {
      expect(await markEngaged(page), 'the natively focused row disclosure is marked for the engaged measurement').toBe(true)
      bAtSequenceEnd = await measureEngagedTuple(page)
    }
    const visibleFailures = reached ? reached.failures : null
    const earlyReasons: string[] = []
    if (!reached) earlyReasons.push('B was not reached within Home, Shift+Tab and 8 forward Tabs')
    if (exact !== 0) earlyReasons.push(`exact scrollTop is ${exact}, not 0`)
    if (!focusedIsRowSummary) earlyReasons.push('the captured row disclosure node is not the active element')
    if (visibleFailures && visibleFailures.length) earlyReasons.push(`B stop visibility failures: ${visibleFailures.join('; ')}`)
    const earlyMet = earlyReasons.length === 0
    earlyPrerequisite = { met: earlyMet, reached: reached !== null, exactScrollTop: exact, focusedIsRowSummary, visibleFailures, reason: earlyMet ? 'early candidate: B focused, judged visible and at exact zero offset before the survey and instrumentation (not the release gate)' : earlyReasons.join(' | ') }
    await snap('afterNativeSequence')
    if (earlyMet) {
      // B is already marked above; the recorder measures the marked node (engagedSource must read 'marker' at the gate).
      signalInstall = await installNativeSignalLog(page, { textareaSelector: null })
      await markNativeSignal(page, 'before-recorder-install')
      await phases.mark(page, 'lateA:recorder-install')
      installed = await installScrollRouteRecorder(page, RECORDER_OPTIONS)
      await markNativeSignal(page, 'after-recorder-install')
      await markNativeSignal(page, 'before-release-gate')
      await phases.mark(page, 'lateA:release-gate')
      // C3: ONE synchronous page evaluation: boundary tuple, SAME-node identity, raw unrounded scrollTop === 0 and the retained T0 facts (rounded offset; never a raw reading), then the SAME test-owned hold.release only if every gate holds. The attempted marker is written in-page before the release call.
      try {
        release.gate = await atomicZeroOffsetRelease(page, { row: rowHandle, t0: installed.baseline, engagedSource: installed.engagedSource, label: 'release-gate', rowSelector: ROW_SUMMARY_SELECTOR })
      } catch (error) {
        release.gateEvaluationError = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
      }
      try { release.marker = await readB3ReleaseMarker(page) } catch (error) { release.markerReadError = error instanceof Error ? `${error.name}: ${error.message}` : String(error) }
      const attempted = release.gate?.attempted ?? release.marker?.attempted ?? false
      const releasedCleanly = release.gate ? release.gate.released : release.marker?.released ?? false
      if (attempted) release.outcome = releasedCleanly ? 'released-inside-interval' : 'attempted-inside-interval-error'
      await markNativeSignal(page, `after-release-gate:${release.outcome}`)
      if (release.outcome === 'released-inside-interval') {
        await phases.mark(page, 'lateA:released')
        await expect(dialog.locator('.saved-file-message')).toContainText(D2_LABEL.deleteMessage)
        await settleLayout(page, 'after the late completion rendered its message')
        await markNativeSignal(page, 'after-settle')
        tuples.verdict = await sampleRecorderTuple(page, 'after-completion', 'verdict')
        await walk.observe('b-after-late-a', 'late-completion')
      } else if (release.outcome === 'attempted-inside-interval-error') {
        // The release was invoked and threw or delivered partially: preserved as an attempted/error outcome, never as "not released".
        await phases.mark(page, 'lateA:release-attempted-with-error')
        await settleLayout(page, 'after the attempted release')
        tuples.verdict = await sampleRecorderTuple(page, 'after-attempted-release', 'verdict')
        await walk.observe('b-after-attempted-release', 'late-completion-attempted')
      } else {
        await phases.mark(page, 'lateA:gate-unmet:no-measured-release')
        tuples.verdict = await sampleRecorderTuple(page, 'release-gate-unmet', 'verdict')
      }
      await finalizeRecorder(recorder, page)
      await markNativeSignal(page, 'after-recorder-finalized')
      await phases.mark(page, 'lateA:interval-closed')
      signal = await readNativeSignalLog(page)
      await snap(release.outcome === 'released-inside-interval' ? 'afterCompletion' : 'afterClosedInterval')
    } else {
      await phases.mark(page, 'prerequisite-unmet:no-measured-release')
    }
    await walk.observe(CAPTURE_PHASE, null, { screenshot: true, recordOnly: CAPTURE_NOTE })
  } finally {
    await cleanup.run('finalize-recorder-if-needed', () => finalizeRecorder(recorder, page))
    if (!signal && signalInstall) await cleanup.run('read-signal-log', async () => { signal = await readNativeSignalLog(page); return signal?.count ?? null })
    disposal = await cleanup.run('dispose-signal-log', () => disposeNativeSignalLog(page))
    await cleanup.run('attach-record', () => walk.attach({
      diagnostic: DIAGNOSTIC_NOTE, orderLimits: ORDER_LIMITS_NOTE, phases: phases.marks, states, rowSummaryCount, rowSummaryText, baseline, sequence, earlyPrerequisite, bAtSequenceEnd, signalInstall, signal, disposal, installed, tuples,
      recorder: { finalizeError: recorder.finalizeError, snapshot: recorder.snapshot, edgeSummary: recorder.summary }, release,
      observedStopFailures: walk.failures(),
      limit: 'An unmet early or boundary prerequisite is a limited negative observation for this fixed fixture; it is not proof that every layout is unreachable. T0 is the recorder\'s rounded baseline, never a raw exact-zero reading; even a coherent raw zero at the release boundary does not prove that queued native anchoring or later movement is impossible.',
    }))
    if (hold && release.outcome === 'not-attempted') {
      const pending = hold
      await cleanup.run('release-held-completion (cleanup, OUTSIDE any measured interval)', async () => {
        await phases.mark(page, 'cleanup:release-outside-interval')
        try { await pending.release(); release.outcome = 'released-cleanup' } catch (error) {
          release.outcome = 'cleanup-error'
          release.cleanupError = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
          throw error
        }
        await settleLayout(page, 'after the cleanup release')
        await snap('afterCleanupRelease')
        return release.outcome
      })
    } else if (hold && release.outcome === 'attempted-inside-interval-error') {
      await cleanup.run('no-second-release', async () => 'the release was already attempted inside the interval; the unchanged fixture drains its queue before delivering, so a thrown handler loses the remaining handlers and a second release cannot recover them; the attempted/error outcome is preserved as such and no second release is performed')
    }
    if (dialog && opener) {
      const scroller = dialog
      const button = opener
      await cleanup.run('escape-and-observe', async () => {
        await page.keyboard.press('Escape')
        const escaped = await scroller.count() === 0
        const openerFocused = await button.evaluate(element => element === document.activeElement)
        closed = { escaped, openerFocused, committedIds: (await readCommitted(page)).map(record => record.job.id) }
        return closed
      })
    }
    await attachSafely(testInfo, `${name}-cleanup`, { steps: cleanup.steps, release, phases: phases.marks, statesAfterCleanup: states.filter(state => state.label === 'afterCleanupRelease'), closed }, cleanup)
  }

  // Completeness only.
  expect(rowSummaryCount, 'the unique direct row disclosure was located').toBe(1)
  expect(baseline, 'the zero-offset baseline geometry was recorded').not.toBeNull()
  expect(sequence.length, 'the bounded native sequence was recorded (Home, Shift+Tab, forward Tabs)').toBeGreaterThanOrEqual(2)
  expect(earlyPrerequisite, 'the early zero-offset candidate was evaluated and recorded').not.toBeNull()
  if (earlyPrerequisite?.met) {
    expect(installed?.wrapped, 'the pass-through recorder wrapped every public scrolling route').toEqual([...SCROLL_ROUTES])
    expect(release.gateEvaluationError, 'the atomic release-gate evaluation completed').toBeNull()
    expect(release.gate, 'the release gate (boundary tuple, same-node identity, raw offset, retained T0 facts) was evaluated and recorded').not.toBeNull()
    expect(recorder.finalizeError, 'the recorder finalized without error').toBeNull()
    expect(recorder.snapshot?.finalized, 'the late-A recorder stream was collected').toBe(true)
    if (release.gate?.met) expect(release.outcome, 'the late completion was released inside the recorded interval by the same test-owned release, without a thrown or partially delivered handler').toBe('released-inside-interval')
    else expect(release.outcome, 'with the boundary gate unmet, the late completion was released only as cleanup').toBe('released-cleanup')
  } else {
    expect(release.outcome, 'with the early prerequisite unmet, the late completion was released only as cleanup').toBe('released-cleanup')
  }
}

/* --------------------------------------------------------------------------
 * The five frozen cases.
 * -------------------------------------------------------------------------- */

test.describe('DIAG81', () => {
  test.describe('AP5 held native mouse selection at 320x800 (mouse pointer)', () => {
    test.use({ viewport: { width: 320, height: 800 }, hasTouch: false })

    test(TITLES.A1, async ({ page }, testInfo) => {
      await heldResizeDiagnostic(page, testInfo, 'held')
    })

    test(TITLES.A2, async ({ page }, testInfo) => {
      await heldResizeDiagnostic(page, testInfo, 'released')
    })
  })

  test.describe('backup dialog survey at 320x480', () => {
    test.use({ viewport: { width: 320, height: 480 }, hasTouch: true })

    test(TITLES.B1, async ({ page }, testInfo) => {
      await backupSurvey(page, testInfo, { width: 320, height: 480 })
    })
  })

  test.describe('backup dialog survey at 320x320', () => {
    test.use({ viewport: { width: 320, height: 320 }, hasTouch: true })

    test(TITLES.B2, async ({ page }, testInfo) => {
      await backupSurvey(page, testInfo, { width: 320, height: 320 })
    })
  })

  test.describe('backup dialog zero-offset probe at 320x800', () => {
    test.use({ viewport: { width: 320, height: 800 }, hasTouch: true })

    test(TITLES.B3, async ({ page }, testInfo) => {
      await zeroOffsetProbe(page, testInfo)
    })
  })
})
