/**
 * Stage81 D2 final E2E: authored 200% text growth and the no-space fallback
 * (docs/design/dialog-focus-visibility.md, D2 candidate 01, SHA256 4f9f5cb4…).
 * Rows covered: 「실제200% 작성 글꼴」 and 「공간 부족/복귀」.
 *
 * The growth fixture records every computed font size inside the open dialog at
 * 100% before any write and sets each element to exactly twice that recorded
 * value, so inheritance and relative units cannot compound. Content that is only
 * rendered later (the differences panes, the delete-confirm group and footer
 * actions) is first rendered once at 100% to capture its own references by
 * selector, then re-rendered under the fixture, set to twice those references
 * and read back from the actual computed sizes. Original inline declarations are
 * restored exactly. This is an explicit authored-font stress test, not native
 * zoom, OS text scaling or WCAG certification.
 *
 * The 320x320 case measures the shortage independently of the product: the
 * body band a sticky footer would leave (port height minus the footer's rendered
 * height) against the focused reader's own two rendered text lines plus its
 * computed padding, borders and painted outline allowance. That prerequisite is
 * hard: if the fixture does not create a shortage the case fails as a coverage
 * failure instead of skipping. Mode stability is asserted only between quiescent
 * observations; content changes may legitimately re-evaluate the mode.
 *
 * Two further oracles are read from the records the walks already keep: during
 * the enlarged reader's quiescent inner-reading interval (entry through the last
 * End/Home/PageDown/arrow stop) the outer dialog scroll and the background must
 * not move, and every grown footer state (the retained review footer and the
 * dynamically recreated deletion confirmation) is audited for horizontal overflow
 * and whole-label containment with the same read-only audit the job case uses.
 * Cancelling the deletion confirmation keeps the loaded review, so the footer
 * returns to the review summary, never to the empty-dialog idle copy.
 */
import { expect } from '@playwright/test'
import { literalOf, test } from './helpers/saved-removal-undo'
import { readCommitted } from './helpers/saved-lifecycle'
import { BACKUP_FOOTER_TEXT, KeyboardWalk, LABEL, LANTERN, LEGACY_UNREADABLE_ENTRY, openSavedViewPlain, pressKey, seedSavedWithoutClock, walkUntil } from './helpers/dialog-focus-visibility'
import {
  D2_CONTRACT, D2_LABEL, HARBOR, HARBOR_INCOMING, READER_NOTE, applyFontReferences, doubleFonts, fontReferenceMismatches, fontReferences, footerState, loadBackupFile,
  openBackupByKeyboard, openLanternDetail, overflowAudit, restoreFonts, sentenceVisibility, settleLayout, shortageIfSticky, snapshotFonts, verifyFonts,
} from './helpers/dialog-focus-visibility-d2'
import type { FontReference, FooterState, OverflowAudit, SentenceVisibility, ShortageMeasurement } from './helpers/dialog-focus-visibility-d2'

interface Viewport { width: number; height: number }
const tag = (viewport: Viewport) => `${viewport.width}x${viewport.height}`
const GROWTH_VIEWPORTS: Viewport[] = [{ width: 1440, height: 960 }, { width: 320, height: 480 }]
const FIXTURE_NOTE = 'Authored-font fixture: computed sizes of the open dialog and every descendant are recorded at 100% before any write and each element is set to exactly 2× its record by inline style; later-rendered content is set to 2× its own 100% references captured by rendering it once at 100%, then read back. Original inline declarations are restored exactly. Not native zoom, OS text scaling or a WCAG certification.'
const DIFFERENCES_SELECTORS = ['.saved-record-comparison', '.saved-record-comparison *']
const CONFIRM_SELECTORS = ['.saved-recovery-confirm', '.saved-recovery-confirm *', '.saved-recovery-footer-actions', '.saved-recovery-footer-actions *']
/**
 * Public footer summary of a loaded review with no selected row. HARBOR_INCOMING
 * replaces a record that already exists, so it starts unselected and the summary
 * counts zero selections, zero additions and zero replacements. Rendered text,
 * not product code; it is the footer the dialog shows before the deletion
 * confirmation is entered and again after the confirmation is cancelled.
 */
const RETAINED_REVIEW_FOOTER = '선택 0개 · 새 공고 0개 · 변경 0개'

test.describe.configure({ timeout: 150_000 })

const partiallyVisible = (visibility: SentenceVisibility) =>
  visibility.found && !visibility.fullyVisible && visibility.clip !== null
  && visibility.rects.some(rect => rect.bottom > visibility.clip!.top && rect.top < visibility.clip!.bottom)

/**
 * Whole-label outcome of one grown footer state, read from the existing
 * read-only overflow audit: no horizontal overflow of the dialog or the footer,
 * every measured text line inside its own control, a nonempty measured label on
 * every footer action, and the exercised labels actually present in the audit.
 */
function expectFooterWhole(audit: OverflowAudit | null, phase: string, labels: readonly (string | RegExp)[]) {
  expect(audit, `${phase}: the footer audit ran`).not.toBeNull()
  expect(audit!.footer, `${phase}: the footer was audited`).not.toBeNull()
  expect(audit!.dialog.overflow, `${phase}: the dialog does not overflow horizontally`).toBe(false)
  expect(audit!.footer!.overflow, `${phase}: the footer does not overflow horizontally`).toBe(false)
  expect(audit!.controls.some(control => control.lineBoxes > 0), `${phase}: footer labels were measured`).toBe(true)
  expect(audit!.controls.filter(control => control.overflow || control.linesOutside > 0).map(control => `${control.descriptor} ${control.text}`), `${phase}: every footer control keeps its whole label inside its box`).toEqual([])
  expect(audit!.controls.filter(control => /^(button|a)(\.|$)/.test(control.descriptor) && (control.text === '' || control.lineBoxes === 0)).map(control => control.descriptor), `${phase}: every footer action has a nonempty measured label`).toEqual([])
  for (const label of labels) expect(audit!.controls.some(control => typeof label === 'string' ? control.text === label : label.test(control.text)), `${phase}: the audited footer shows ${label}`).toBe(true)
}

for (const viewport of GROWTH_VIEWPORTS) {
  test.describe(`authored 200% text at ${tag(viewport)}`, () => {
    test.use({ viewport, hasTouch: viewport.width === 320 })

    test(`G-job detail: every recorded font reads back at exactly 2×, the footer grows without overflow or clipped labels, the already-focused note stays visible through the growth, native entries stay visible under the grown footer, and the fonts still read back at 2× afterwards at ${tag(viewport)}`, async ({ page }, testInfo) => {
      const dialog = await openLanternDetail(page)
      const walk = new KeyboardWalk(page, testInfo, `growth-job-${tag(viewport)}`, {
        contract: D2_CONTRACT, row: '실제200% 작성 글꼴', requirements: ['requirement 1', 'requirement 2', 'requirement 4'], fixture: LANTERN.job.id, viewport, fixtureNote: FIXTURE_NOTE,
        measurement: 'Tab from Close to the note at 100%; apply the doubling while the note is focused (already-focused layout change, judged); Tab to the footer link; Shift+Tab back to the note; read back every recorded size again. Footer height, overflow and label containment are measured before and after.',
      })
      let before: { footer: FooterState; audit: OverflowAudit } | null = null
      let after: { footer: FooterState; audit: OverflowAudit } | null = null
      let doubling: Awaited<ReturnType<typeof doubleFonts>> | null = null
      let verification: Awaited<ReturnType<typeof verifyFonts>> | null = null
      let verificationAfterWalk: Awaited<ReturnType<typeof verifyFonts>> | null = null
      let recorded = 0
      try {
        const initial = await walk.observe('initial-close')
        expect(initial.name).toBe(LABEL.close)
        await walkUntil(walk, 'Tab', 'forward-to-note', stop => stop.name === LABEL.note, 60)
        before = { footer: await footerState(page), audit: await overflowAudit(page) }
        recorded = await snapshotFonts(page)
        doubling = await doubleFonts(page)
        await settleLayout(page, 'after doubling the authored fonts')
        verification = await verifyFonts(page)
        after = { footer: await footerState(page), audit: await overflowAudit(page) }
        await walk.observe('already-focused-after-font-growth', 'font-growth', { screenshot: true })
        await walkUntil(walk, 'Tab', 'forward-under-grown-footer', stop => stop.name === LABEL.footerLink, 10, { screenshot: true })
        await walkUntil(walk, 'Shift+Tab', 'backward-under-grown-footer', stop => stop.name === LABEL.note, 10, { screenshot: true })
        verificationAfterWalk = await verifyFonts(page)
      } finally {
        await walk.attach({ before, after, doubling, verification, verificationAfterWalk, recorded })
      }

      expect(recorded, 'the fixture recorded the dialog subtree').toBeGreaterThan(20)
      expect(doubling?.doubled ?? 0, 'the fixture wrote a doubled size to every recorded sized element').toBeGreaterThan(20)
      expect(verification?.mismatches, 'every recorded element reads back at exactly 2× its 100% size').toEqual([])
      expect(verification?.checked ?? 0).toBeGreaterThan(20)
      expect(verificationAfterWalk?.mismatches, 'the sizes still read back at 2× after the walk').toEqual([])
      expect(before?.footer.present && after?.footer.present, 'the job footer was measured in both states').toBe(true)
      expect(after!.footer.rect!.height, `the footer really grew (before ${before!.footer.rect!.height}px)`).toBeGreaterThan(before!.footer.rect!.height + 0.5)
      expect(after!.audit.dialog.overflow, 'the dialog does not overflow horizontally at 200%').toBe(false)
      expect(after!.audit.footer?.overflow, 'the footer does not overflow horizontally at 200%').toBe(false)
      expect(after!.audit.controls.filter(control => control.overflow || control.linesOutside > 0).map(control => `${control.descriptor} ${control.text}`), 'every footer control keeps its whole label inside its box').toEqual([])
      expect(after!.audit.controls.some(control => control.lineBoxes > 0), 'footer labels were measured').toBe(true)
      expect(walk.stops.every(stop => stop.judgement === 'asserted')).toBe(true)
      expect(walk.failures(), `every stop is visible before and after the growth, including the already-focused note (see the ${walk.name}-stops attachment)`).toEqual([])
      const grown = walk.find(LABEL.note, 'already-focused-after-font-growth')
      expect(grown?.probe.active.textMetrics.fontSizePx, 'the focused note itself renders at twice its authored size').toBeGreaterThanOrEqual(19)

      await page.keyboard.press('Escape')
      await expect(dialog).toHaveCount(0)
      expect((await readCommitted(page))[0], 'the growth fixture changes no record').toMatchObject(literalOf(LANTERN))
    })
  })
}

test.describe('no-space fallback at 320x320 with authored 200% text', () => {
  test.use({ viewport: { width: 320, height: 320 }, hasTouch: true })

  test('G-backup dialog: under an independently measured shortage the footer is not sticky, every native stop and the engaged reader stay visible, first, interior and last lines stay reachable without moving the outer dialog or the background, cancelling the deletion keeps the loaded review, the later-rendered panes and confirm controls read back at 2× with whole footer labels and no overflow, the mode is stable while quiescent, the footer is sticky again at 1440x960 and 100%, and the archive survives Escape', async ({ page }, testInfo) => {
    await seedSavedWithoutClock(page, [HARBOR, LEGACY_UNREADABLE_ENTRY])
    await openSavedViewPlain(page, [HARBOR.job.title])
    const { dialog, opener } = await openBackupByKeyboard(page)
    await loadBackupFile(page, dialog, [HARBOR_INCOMING], 1)
    const archive = dialog.locator('.saved-recovery-source')
    const importRow = dialog.locator('.saved-import-row')
    const footerText = dialog.locator('.dialog-footer > span')
    const walk = new KeyboardWalk(page, testInfo, 'growth-backup-320x320', {
      contract: D2_CONTRACT, row: '공간 부족/복귀 · 실제200% 작성 글꼴', requirements: ['requirement 1', 'requirement 2', 'requirement 4', 'requirement 9', 'requirement 10'], fixture: [HARBOR.job.id, 'unreadable legacy entry', 'incoming file variant'], viewport: { width: 320, height: 320 }, fixtureNote: FIXTURE_NOTE,
      measurement: 'At 100%: open the differences panes and record their sizes, close them; with the review footer showing its unselected summary, activate the archive deletion and record the confirm controls, cancel (the review, its row and the archive are retained, so the review summary returns). Double the fonts and audit the grown review footer. Re-open the panes (apply and read back), Tab into the note reader, measure the shortage a sticky footer would leave, read first/End/Home/interior while recording the outer dialog scroll and the background at every reader stop, Tab on to the archive deletion, Enter (confirm footer; apply, read back and audit the recreated confirmation actions), Tab through the confirm footer and back, observe the footer mode while quiescent; then restore 100% and 1440x960 and observe again; Escape and reopen to confirm the archive survived.',
    })
    const modes: { phase: string; footer: FooterState }[] = []
    const readings: { phase: string; visibility: SentenceVisibility }[] = []
    const references: Record<string, FontReference[]> = {}
    const readbacks: Record<string, string[]> = {}
    const audits: Record<string, OverflowAudit> = {}
    let shortage: ShortageMeasurement | null = null
    let verification: Awaited<ReturnType<typeof verifyFonts>> | null = null
    let restored: FooterState | null = null
    const interiorPresses: string[] = []
    let interiorReached = false
    // Indices into walk.stops bounding the quiescent inner-reading interval: the reader entry stop through the last End/Home/PageDown/arrow observation.
    let readerEntryIndex = -1
    let readerExitIndex = -1
    const readerInterval = () => readerEntryIndex < 0 ? [] : walk.stops.slice(readerEntryIndex, readerExitIndex < 0 ? undefined : readerExitIndex)
    try {
      // 100% references for the later-rendered content, captured by rendering it once at 100%.
      const initial = await walk.observe('initial-close', null, { screenshot: true })
      expect(initial.name).toBe(LABEL.close)
      const summary100 = await walkUntil(walk, 'Tab', 'forward-100pct', stop => D2_LABEL.importSummaryDifferent.test(stop.name), 40)
      if (summary100.probe.active.detailsOpen === false) await walk.press('Enter', 'open-differences-100pct')
      await settleLayout(page, 'differences panes at 100%')
      references.differences = await fontReferences(page, DIFFERENCES_SELECTORS)
      await walk.press('Enter', 'close-differences-100pct')
      await walkUntil(walk, 'Tab', 'forward-100pct', stop => stop.name === LABEL.deleteArchive, 20)
      await expect(footerText, 'before the confirmation the footer shows the loaded review summary with its unselected replacement').toHaveText(RETAINED_REVIEW_FOOTER)
      await walk.press('Enter', 'activate-delete-archive-100pct')
      await expect(footerText).toHaveText(BACKUP_FOOTER_TEXT.confirmDelete)
      await settleLayout(page, 'confirm controls at 100%')
      references.confirm = await fontReferences(page, CONFIRM_SELECTORS)
      await walkUntil(walk, 'Tab', 'forward-100pct', stop => stop.name === LABEL.cancelDelete, 6)
      await pressKey(page, 'Enter')
      // Cancelling clears only the pending deletion. The loaded review and its unselected replacement row are retained, so the
      // footer returns to the review summary it showed before the confirmation, not to the empty-dialog idle copy.
      await expect(footerText, 'cancelling the deletion returns the footer to the retained review summary').toHaveText(RETAINED_REVIEW_FOOTER)
      await expect(importRow, 'the loaded review row is retained after cancelling').toHaveCount(1)
      await expect(archive, 'the archive is retained after cancelling').toHaveCount(1)
      await pressKey(page, 'Tab')
      const resumed = await walk.observe('resumed-after-cancel-100pct', 'Tab')
      expect(resumed.probe.active.insideDialog).toBe(true)

      // The fixture: every recorded element to exactly 2×; later-rendered content to 2× its own references.
      await snapshotFonts(page)
      await doubleFonts(page)
      await settleLayout(page, 'after doubling the authored fonts')
      verification = await verifyFonts(page)
      modes.push({ phase: 'doubled', footer: await footerState(page) })
      // Grown review footer: the retained summary and the import action under actual 2× text, audited read-only for overflow and whole labels.
      audits['doubled-review-footer'] = await overflowAudit(page)
      const summary = await walkUntil(walk, 'Tab', 'forward', stop => D2_LABEL.importSummaryDifferent.test(stop.name), 40)
      if (summary.probe.active.detailsOpen === false) await walk.press('Enter', 'open-differences')
      await applyFontReferences(page, references.differences)
      await settleLayout(page, 'differences panes after applying their 2× references')
      readbacks.differences = fontReferenceMismatches(references.differences, await fontReferences(page, DIFFERENCES_SELECTORS))
      const reader = await walk.press('Tab', 'enter-note-reader', { screenshot: true })
      expect(reader.name.startsWith(READER_NOTE.first.slice(0, 30)), `the note reader is entered; reached: ${reader.name}`).toBe(true)
      readerEntryIndex = reader.index
      shortage = await shortageIfSticky(page)
      modes.push({ phase: 'reader-entered', footer: await footerState(page) })
      readings.push({ phase: 'entry', visibility: await sentenceVisibility(page, READER_NOTE.first) })
      await pressKey(page, 'End')
      await walk.observe('reader-inner-end', 'End', { screenshot: true })
      readings.push({ phase: 'end', visibility: await sentenceVisibility(page, READER_NOTE.last, 'last') })
      await pressKey(page, 'Home')
      await walk.observe('reader-inner-home', 'Home')
      readings.push({ phase: 'home', visibility: await sentenceVisibility(page, READER_NOTE.first) })
      for (let pages = 1; pages <= 30 && !interiorReached; pages++) {
        await pressKey(page, 'PageDown')
        interiorPresses.push('PageDown')
        await walk.observe('reader-inner-page-down', 'PageDown')
        let middle = await sentenceVisibility(page, READER_NOTE.middle)
        readings.push({ phase: `page-down-${pages}`, visibility: middle })
        for (let nudge = 1; nudge <= 8 && partiallyVisible(middle); nudge++) {
          const key = middle.rects.some(rect => rect.top < (middle.clip?.top ?? 0)) ? 'ArrowUp' : 'ArrowDown'
          await pressKey(page, key)
          interiorPresses.push(key)
          await walk.observe(`reader-inner-${key === 'ArrowUp' ? 'arrow-up' : 'arrow-down'}`, key)
          middle = await sentenceVisibility(page, READER_NOTE.middle)
          readings.push({ phase: `page-down-${pages}-nudge-${nudge}`, visibility: middle })
        }
        interiorReached = middle.fullyVisible
      }
      // End of the quiescent inner-reading interval; the Tab that follows legitimately leaves the reader.
      readerExitIndex = walk.stops.length
      const deletion = await walkUntil(walk, 'Tab', 'forward-to-archive-deletion', stop => stop.name === LABEL.deleteArchive, 20)
      expect(deletion.name).toBe(LABEL.deleteArchive)
      await walk.press('Enter', 'activate-delete-archive', { screenshot: true })
      await expect(footerText).toHaveText(BACKUP_FOOTER_TEXT.confirmDelete)
      await applyFontReferences(page, references.confirm)
      await settleLayout(page, 'confirm controls after applying their 2× references')
      readbacks.confirm = fontReferenceMismatches(references.confirm, await fontReferences(page, CONFIRM_SELECTORS))
      await walk.observe('already-focused-after-footer-change', 'footer-state-change', { screenshot: true })
      modes.push({ phase: 'confirm-footer', footer: await footerState(page) })
      // Grown confirmation footer: the dynamically recreated cancel/confirm actions under actual 2× text, audited read-only for overflow and whole labels.
      audits['confirm-footer-2x'] = await overflowAudit(page)
      const cancel = await walk.press('Tab', 'forward-into-confirm-footer', { screenshot: true })
      expect(cancel.name).toBe(LABEL.cancelDelete)
      modes.push({ phase: 'confirm-tab-1', footer: await footerState(page) })
      const confirm = await walk.press('Tab', 'forward-confirm-footer', { screenshot: true })
      expect(confirm.name).toBe(LABEL.confirmDelete)
      modes.push({ phase: 'confirm-tab-2', footer: await footerState(page) })
      await walk.press('Shift+Tab', 'backward-confirm-footer')
      await walk.press('Shift+Tab', 'backward-into-body', { screenshot: true })
      modes.push({ phase: 'after-tab-cycle', footer: await footerState(page) })
      await settleLayout(page, 'idle frames')
      modes.push({ phase: 'after-idle-frames', footer: await footerState(page) })
      await restoreFonts(page)
      await page.setViewportSize({ width: 1440, height: 960 })
      await settleLayout(page, 'after restoring 100% and 1440x960')
      await walk.observe('already-focused-1440x960-100pct', 'restore:1440x960', { screenshot: true })
      restored = await footerState(page)
      modes.push({ phase: 'restored', footer: restored })
      await settleLayout(page, 'idle frames after restore')
      modes.push({ phase: 'restored-idle', footer: await footerState(page) })
    } finally {
      await walk.attach({
        modes, readings, shortage, verification, references, readbacks, audits, interiorPresses, interiorReached,
        readerInterval: readerInterval().map(stop => ({
          index: stop.index, phase: stop.phase, key: stop.key, descriptor: stop.descriptor, outerScrollTop: stop.probe.dialog?.scrollTop ?? null,
          innerScrollTop: stop.probe.active.innerScroll?.scrollTop ?? null, windowScroll: stop.probe.windowScroll,
        })),
      })
    }

    expect(verification?.mismatches, 'every recorded element reads back at exactly 2× its 100% size').toEqual([])
    expect(references.differences?.some(reference => reference.sizes.length > 0), 'the differences panes were rendered at 100% for their references').toBe(true)
    expect(references.confirm?.some(reference => reference.sizes.length > 0), 'the confirm controls were rendered at 100% for their references').toBe(true)
    expect(readbacks.differences, 'the re-rendered differences panes read back at exactly 2× their 100% references').toEqual([])
    expect(readbacks.confirm, 'the re-rendered confirm controls read back at exactly 2× their 100% references').toEqual([])
    // Independent shortage prerequisite (hard): the case is only meaningful when a sticky footer could not leave two reader lines.
    expect(shortage?.measured, 'the shortage was measured from the focused reader and the footer').toBe(true)
    expect(shortage!.holds, `FIXTURE PREREQUISITE (coverage failure if false): a sticky footer of ${shortage!.footerHeight}px in a ${shortage!.portHeight}px port leaves ${shortage!.bandIfSticky}px, but two rendered reader lines with their padding, borders and outline need ${shortage!.requiredForTwoLines}px`).toBe(true)
    expect(walk.stops.every(stop => stop.judgement === 'asserted')).toBe(true)
    expect(walk.failures(), `every stop is visible under the chosen footer mode (see the ${walk.name}-stops attachment)`).toEqual([])
    expect(readings.find(reading => reading.phase === 'entry')?.visibility.fullyVisible, 'the first reader line is fully visible on entry').toBe(true)
    expect(readings.find(reading => reading.phase === 'end')?.visibility.fullyVisible, 'the last reader line is fully visible after End').toBe(true)
    expect(readings.find(reading => reading.phase === 'home')?.visibility.fullyVisible, 'the first reader line is fully visible after Home').toBe(true)
    expect(interiorReached, `the interior reader line becomes fully visible (presses: ${interiorPresses.join(' ')})`).toBe(true)
    // Inner reading versus outer movement, from the records already kept for the reader interval (entry through the last End/Home/PageDown/arrow stop):
    // focus stays on the engaged reader, the outer dialog scroll stays within 0.5px and the locked background does not move. The later Tab,
    // confirmation, font and viewport transitions are outside this interval and are not compared.
    const interval = readerInterval()
    expect(interval.length, 'the reader interval holds the entry plus the End, Home and PageDown observations').toBeGreaterThanOrEqual(4)
    expect(interval.map(stop => stop.phase).filter(phase => phase !== 'enter-note-reader' && !phase.startsWith('reader-inner-')), 'the interval holds reader observations only').toEqual([])
    expect(new Set(interval.map(stop => stop.descriptor)).size, `focus stays on the engaged reader throughout the interval: ${interval.map(stop => stop.descriptor).join(', ')}`).toBe(1)
    const outerScrollTops = interval.map(stop => stop.probe.dialog?.scrollTop ?? Number.NaN)
    expect(outerScrollTops.every(value => Math.abs(value - outerScrollTops[0]) <= 0.5), `inner reading never moved the outer dialog (0.5px): ${outerScrollTops.join(', ')}`).toBe(true)
    const backgrounds = interval.map(stop => `${stop.probe.windowScroll.x},${stop.probe.windowScroll.y}`)
    expect(new Set(backgrounds).size, `inner reading never scrolled the background: ${backgrounds.join(' ')}`).toBe(1)
    // Grown footer states keep whole labels and no horizontal overflow: the retained review footer right after doubling, and the recreated confirmation actions at 2×.
    expectFooterWhole(audits['doubled-review-footer'] ?? null, 'the grown review footer', [RETAINED_REVIEW_FOOTER, D2_LABEL.importButton])
    expectFooterWhole(audits['confirm-footer-2x'] ?? null, 'the grown confirmation footer', [BACKUP_FOOTER_TEXT.confirmDelete, LABEL.cancelDelete, LABEL.confirmDelete])
    // Under the measured shortage the footer must not be pinned over the body from the reader onwards (content changes may re-evaluate, but never back to sticky while the shortage persists).
    const shortagePhases = modes.filter(entry => ['reader-entered', 'confirm-footer', 'confirm-tab-1', 'confirm-tab-2', 'after-tab-cycle', 'after-idle-frames'].includes(entry.phase))
    expect(shortagePhases.length).toBe(6)
    expect(shortagePhases.every(entry => entry.footer.position !== 'sticky'), `under measured shortage the footer is not sticky: ${shortagePhases.map(entry => `${entry.phase}=${entry.footer.position}`).join(', ')}`).toBe(true)
    // Quiescent stability: no change across Tab stops inside the confirm footer and across idle frames.
    const quiescent = modes.filter(entry => ['confirm-footer', 'confirm-tab-1', 'confirm-tab-2'].includes(entry.phase)).map(entry => entry.footer.position)
    expect(new Set(quiescent).size, `the footer mode does not change across Tab stops with unchanged content: ${quiescent.join(', ')}`).toBe(1)
    const idle = modes.filter(entry => ['after-tab-cycle', 'after-idle-frames'].includes(entry.phase)).map(entry => entry.footer.position)
    expect(new Set(idle).size, `the footer mode does not change across idle frames: ${idle.join(', ')}`).toBe(1)
    expect(restored?.position, 'at 1440x960 and 100% the footer is sticky again').toBe('sticky')
    expect(restored?.pinnedToClientBottom, 'the restored sticky footer is pinned to the port bottom').toBe(true)
    expect(modes.filter(entry => entry.phase.startsWith('restored')).every(entry => entry.footer.position === 'sticky'), 'the restored mode is stable across idle frames').toBe(true)

    await expect(archive, 'nothing was deleted').toHaveCount(1)
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await expect(opener, 'requirement 7: Escape returns focus to the opener').toBeFocused()
    const committed = await readCommitted(page)
    expect(committed).toHaveLength(1)
    expect(committed[0], 'the record is untouched').toMatchObject(literalOf(HARBOR))
    // Explicit post-Escape archive preservation: the cancelled flow deleted nothing, so the archive is still listed when the dialog is reopened.
    await opener.focus()
    await page.keyboard.press('Enter')
    await expect(dialog).toBeVisible()
    await expect(archive, 'the archive survives Escape').toHaveCount(1)
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
  })
})
