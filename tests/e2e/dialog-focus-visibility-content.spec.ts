/**
 * Stage81 D2 final E2E: full-content reading and real editing inside the native
 * dialogs (docs/design/dialog-focus-visibility.md, D2 candidate 01, SHA256
 * 4f9f5cb4…). Rows covered: 「긴 원문/백업 본문」 (original description, backup
 * note/description/url/whole-record readers with first, interior and last
 * markers) and 「긴/사용자 resize 메모」 (modeled caret at the start, interior and
 * end, literal edit, noncollapsed selection with its direction and focus
 * endpoint, caret remeasured after every size change, a user resize bounded on
 * a small screen and restored later).
 *
 * Oracles are independent of the product: every marker check measures the
 * read-only Range rectangles of a literal fixture string against the focused
 * element's padding box, the viewport, its clipping ancestors and the dialog
 * port above a sticky footer. Caret geometry is modeled from the textarea's own
 * value, selection direction, computed line height, padding, border and inner
 * scroll, and is only trusted when the measured no-soft-wrap precondition holds
 * (rendered content height equals one line per newline-delimited line). Two
 * visible lines or a few arrow presses are never accepted as full access: the
 * first, an interior and the last literal marker must actually be seen, with
 * single arrow nudges completing a partially visible marker.
 *
 * Preparation (seeding, opening by locator focus plus Enter, the synthetic
 * backup file, one paste-like insertText for the long body, the mouse drag on
 * the resize grip) is labeled; between a key press and its observation nothing
 * focuses, scrolls or frames the page.
 */
import { expect } from '@playwright/test'
import type { Page } from '@playwright/test'
import { literalOf, noteField, test, titleButton } from './helpers/saved-removal-undo'
import { readCommitted } from './helpers/saved-lifecycle'
import { waitForSavedCommit } from './helpers/saved-store'
import { KeyboardWalk, LABEL, LANTERN, openSavedViewPlain, pressKey, seedSavedWithoutClock, walkUntil } from './helpers/dialog-focus-visibility'
import {
  CARET_BODY, CARET_BODY_EDITED, CARET_INTERIOR_EDIT, CARET_INTERIOR_LINE, D2_CONTRACT, D2_LABEL, HARBOR, HARBOR_INCOMING, HARBOR_JSON_MARKERS, LANTERN_DESCRIPTION_TEXT,
  LANTERN_SENTENCES, READER_DESCRIPTION, READER_NOTE, caretGeometry, dragResize, loadBackupFile, moveCaret, openBackupByKeyboard, openLanternDetail,
  sentenceVisibility, settleLayout, textareaMetrics,
} from './helpers/dialog-focus-visibility-d2'
import type { CaretGeometry, SentenceVisibility } from './helpers/dialog-focus-visibility-d2'

interface Viewport { width: number; height: number }
const tag = (viewport: Viewport) => `${viewport.width}x${viewport.height}`
const READING_VIEWPORTS: Viewport[] = [{ width: 1440, height: 960 }, { width: 320, height: 800 }, { width: 320, height: 480 }]
const EDITING_VIEWPORTS: Viewport[] = [{ width: 1440, height: 960 }, { width: 320, height: 480 }]
const PREPARATION_NOTE = 'Preparation only: localStorage seed, saved view load, opener focused with locator.focus() and Enter, synthetic backup file chosen through the real file input. From the first observation on, only Tab, Shift+Tab, Enter, End, Home, PageDown, arrow keys, Escape and typed characters are used; the long note body is one paste-like insertText, labeled as such.'

test.describe.configure({ timeout: 150_000 })

interface Markers { first: string; middle: string; last: string }
interface Reading { reader: string; phase: string; sentence: string; visibility: SentenceVisibility }
interface ReadThrough { interiorReached: boolean; dialogScrollTops: number[]; presses: string[] }

const partiallyVisible = (visibility: SentenceVisibility) =>
  visibility.found && !visibility.fullyVisible && visibility.clip !== null
  && visibility.rects.some(rect => rect.bottom > visibility.clip!.top && rect.top < visibility.clip!.bottom)

/**
 * Entry → End → Home → PageDown until the interior marker is fully visible. When a
 * PageDown leaves the marker partially inside the clip, single ArrowUp/ArrowDown
 * presses complete it (TA1). Every stop is judged; dialog scroll is recorded at each.
 */
async function readThrough(page: Page, walk: KeyboardWalk, reader: string, markers: Markers, readings: Reading[]): Promise<ReadThrough> {
  const entry = walk.stops[walk.stops.length - 1]
  const dialogScrollTops = [entry.probe.dialog?.scrollTop ?? Number.NaN]
  const presses: string[] = []
  const record = async (phase: string, sentence: keyof Markers, which: 'first' | 'last' = 'first') => {
    const visibility = await sentenceVisibility(page, markers[sentence], which)
    readings.push({ reader, phase, sentence, visibility })
    return visibility
  }
  await record('entry', 'first')
  await pressKey(page, 'End')
  presses.push('End')
  dialogScrollTops.push((await walk.observe(`${reader}-inner-end`, 'End', { screenshot: true })).probe.dialog?.scrollTop ?? Number.NaN)
  await record('end', 'last', 'last')
  await pressKey(page, 'Home')
  presses.push('Home')
  dialogScrollTops.push((await walk.observe(`${reader}-inner-home`, 'Home')).probe.dialog?.scrollTop ?? Number.NaN)
  await record('home', 'first')
  let interiorReached = false
  for (let pages = 1; pages <= 30 && !interiorReached; pages++) {
    await pressKey(page, 'PageDown')
    presses.push('PageDown')
    dialogScrollTops.push((await walk.observe(`${reader}-inner-page-down`, 'PageDown')).probe.dialog?.scrollTop ?? Number.NaN)
    let middle = await record(`page-down-${pages}`, 'middle')
    for (let nudge = 1; nudge <= 8 && partiallyVisible(middle); nudge++) {
      const key = middle.rects.some(rect => rect.top < (middle.clip?.top ?? 0)) ? 'ArrowUp' : 'ArrowDown'
      await pressKey(page, key)
      presses.push(key)
      dialogScrollTops.push((await walk.observe(`${reader}-inner-${key === 'ArrowUp' ? 'arrow-up' : 'arrow-down'}`, key)).probe.dialog?.scrollTop ?? Number.NaN)
      middle = await record(`page-down-${pages}-nudge-${nudge}`, 'middle')
    }
    interiorReached = middle.fullyVisible
  }
  return { interiorReached, dialogScrollTops, presses }
}

const visibilityOf = (readings: Reading[], reader: string, phase: string) => readings.find(reading => reading.reader === reader && reading.phase === phase)?.visibility
const steady = (values: number[]) => values.every(value => Math.abs(value - values[0]) <= 0.5)

function expectReaderCovered(readings: Reading[], reads: Record<string, ReadThrough>, reader: string, labels: { first: string; last: string }) {
  expect(visibilityOf(readings, reader, 'entry')?.fullyVisible, `${reader}: ${labels.first} fully visible on entry`).toBe(true)
  expect(visibilityOf(readings, reader, 'end')?.fullyVisible, `${reader}: ${labels.last} fully visible after End`).toBe(true)
  expect(visibilityOf(readings, reader, 'home')?.fullyVisible, `${reader}: ${labels.first} fully visible again after Home`).toBe(true)
  expect(reads[reader]?.interiorReached, `${reader}: the interior marker becomes fully visible (presses: ${reads[reader]?.presses.join(' ')})`).toBe(true)
  expect(steady(reads[reader]?.dialogScrollTops ?? []), `${reader}: inner reading never moved the dialog: ${reads[reader]?.dialogScrollTops.join(', ')}`).toBe(true)
}

const caretVisible = (geometry: CaretGeometry) => geometry.isTextarea && geometry.noSoftWrap && geometry.caretInsideBox && geometry.caretInsideBodyArea

for (const viewport of READING_VIEWPORTS) {
  test.describe(`full-content reading at ${tag(viewport)}`, () => {
    test.use({ viewport, hasTouch: viewport.width === 320 })

    test(`R-read original description: native End, Home and PageDown expose the first, interior and last sentences without moving the dialog, and Tab exits both ways at ${tag(viewport)}`, async ({ page }, testInfo) => {
      for (const sentence of Object.values(LANTERN_SENTENCES)) expect(LANTERN_DESCRIPTION_TEXT, 'FIXTURE PRECONDITION: every sentinel is a literal sentence of the fixture').toContain(sentence)
      const dialog = await openLanternDetail(page)
      const walk = new KeyboardWalk(page, testInfo, `read-original-${tag(viewport)}`, {
        contract: D2_CONTRACT, row: '긴 원문/백업 본문', requirements: ['requirement 1', 'requirement 2', 'requirement 9', 'requirement 10'], fixture: LANTERN.job.id, viewport, preparation: PREPARATION_NOTE,
        measurement: 'Tab to the original summary, Enter, Tab into the reading region; End, Home, then PageDown (with single arrow nudges for a partially visible marker) until the interior sentinel is fully visible; Tab out forward, Shift+Tab back in, Shift+Tab out backward. Every stop is judged and every sentinel check is a read-only Range measurement.',
      })
      const readings: Reading[] = []
      const reads: Record<string, ReadThrough> = {}
      let exits: { forward: string; back: string; backward: string } | null = null
      try {
        const initial = await walk.observe('initial-close')
        expect(initial.name, 'the dialog opens with Close focused').toBe(LABEL.close)
        const summary = await walkUntil(walk, 'Tab', 'forward', stop => stop.name === LABEL.descriptionSummary, 60)
        if (summary.probe.active.detailsOpen === false) await walk.press('Enter', 'open-description')
        const region = await walk.press('Tab', 'enter-region', { screenshot: true })
        expect(region.name, 'Tab from the opened summary enters the reading region').toBe(LABEL.descriptionRegion)
        reads.original = await readThrough(page, walk, 'original', LANTERN_SENTENCES, readings)
        const forward = await walk.press('Tab', 'exit-forward', { screenshot: true })
        const back = await walk.press('Shift+Tab', 'reenter-backward', { screenshot: true })
        const backward = await walk.press('Shift+Tab', 'exit-backward', { screenshot: true })
        exits = { forward: forward.name, back: back.name, backward: backward.name }
      } finally {
        await walk.attach({ readings, reads })
      }

      expect(walk.stops.every(stop => stop.judgement === 'asserted')).toBe(true)
      expect(walk.failures(), `every stop of the reading walk is visible (see the ${walk.name}-stops attachment)`).toEqual([])
      expectReaderCovered(readings, reads, 'original', { first: 'the first sentence', last: 'the last sentence' })
      expect(walk.stops.every(stop => stop.probe.windowScroll.x === 0 && stop.probe.windowScroll.y === 0), 'the locked background never scrolled').toBe(true)
      expect(exits).toEqual({ forward: LABEL.appliedToggle, back: LABEL.descriptionRegion, backward: LABEL.descriptionSummary })

      await page.keyboard.press('Escape')
      await expect(dialog).toHaveCount(0)
      await expect(titleButton(page, LANTERN), 'requirement 7: Escape returns focus to the opener').toBeFocused()
      const committed = await readCommitted(page)
      expect(committed).toHaveLength(1)
      expect(committed[0], 'reading changes nothing').toMatchObject(literalOf(LANTERN))
    })
  })
}

for (const viewport of EDITING_VIEWPORTS) {
  test.describe(`backup record readers and the note editor at ${tag(viewport)}`, () => {
    test.use({ viewport, hasTouch: viewport.width === 320 })

    test(`R-read backup record: the note, description, url and whole-record readers expose their first, interior and last markers with native keys and exit both ways at ${tag(viewport)}`, async ({ page }, testInfo) => {
      await seedSavedWithoutClock(page, [HARBOR])
      await openSavedViewPlain(page, [HARBOR.job.title])
      const { dialog, opener } = await openBackupByKeyboard(page)
      await loadBackupFile(page, dialog, [HARBOR_INCOMING], 1)
      const walk = new KeyboardWalk(page, testInfo, `read-backup-${tag(viewport)}`, {
        contract: D2_CONTRACT, row: '긴 원문/백업 본문', requirements: ['requirement 1', 'requirement 2', 'requirement 9', 'requirement 10'], fixture: [HARBOR.job.id, 'incoming file variant'], viewport, preparation: PREPARATION_NOTE,
        measurement: 'Tab to the differences summary, Enter; Tab into the current note reader, read End/Home/PageDown to the interior marker; Tab to the description summary, Enter, Tab into the description reader, read; Tab to the url reader; Tab to the whole-record summary, Enter, Tab into the pre reader, read its opening brace, the savedAt line and the closing brace; Shift+Tab back out.',
      })
      const readings: Reading[] = []
      const reads: Record<string, ReadThrough> = {}
      let exitName: string | null = null
      try {
        const initial = await walk.observe('initial-close')
        expect(initial.name).toBe(LABEL.close)
        const summary = await walkUntil(walk, 'Tab', 'forward', stop => D2_LABEL.importSummaryDifferent.test(stop.name), 40)
        if (summary.probe.active.detailsOpen === false) await walk.press('Enter', 'open-differences')
        const note = await walk.press('Tab', 'enter-note-reader', { screenshot: true })
        expect(note.name.startsWith(READER_NOTE.first.slice(0, 30)), `Tab enters the current record's note reader first; reached: ${note.name}`).toBe(true)
        reads.note = await readThrough(page, walk, 'note', READER_NOTE, readings)
        const descriptionSummary = await walk.press('Tab', 'to-description-summary')
        expect(descriptionSummary.name).toBe(D2_LABEL.recordDescriptionSummary)
        await walk.press('Enter', 'open-description-pane')
        const description = await walk.press('Tab', 'enter-description-reader', { screenshot: true })
        expect(description.name.startsWith(READER_DESCRIPTION.first.slice(0, 30)), `Tab enters the description reader; reached: ${description.name}`).toBe(true)
        reads.description = await readThrough(page, walk, 'description', READER_DESCRIPTION, readings)
        const url = await walk.press('Tab', 'to-url-reader')
        expect(url.name.startsWith(HARBOR.job.url), `the url reader follows; reached: ${url.name}`).toBe(true)
        const jsonSummary = await walk.press('Tab', 'to-json-summary')
        expect(jsonSummary.name).toBe(D2_LABEL.recordJsonSummary)
        await walk.press('Enter', 'open-json-pane')
        const json = await walk.press('Tab', 'enter-json-reader', { screenshot: true })
        expect(json.probe.active.tag, 'the whole-record reader is the pre element').toBe('pre')
        reads.json = await readThrough(page, walk, 'json', HARBOR_JSON_MARKERS, readings)
        const exit = await walk.press('Shift+Tab', 'exit-json-backward', { screenshot: true })
        exitName = exit.name
      } finally {
        await walk.attach({ readings, reads })
      }

      expect(walk.stops.every(stop => stop.judgement === 'asserted')).toBe(true)
      expect(walk.failures(), `every stop of the backup reading walk is visible (see the ${walk.name}-stops attachment)`).toEqual([])
      expectReaderCovered(readings, reads, 'note', { first: 'the first line', last: 'the last line' })
      expectReaderCovered(readings, reads, 'description', { first: 'the first line', last: 'the last line' })
      expectReaderCovered(readings, reads, 'json', { first: 'the opening brace', last: 'the closing brace' })
      expect(walk.stops.every(stop => stop.probe.windowScroll.x === 0 && stop.probe.windowScroll.y === 0), 'the locked background never scrolled').toBe(true)
      expect(exitName).toBe(D2_LABEL.recordJsonSummary)

      await page.keyboard.press('Escape')
      await expect(dialog).toHaveCount(0)
      await expect(opener, 'requirement 7: Escape returns focus to the opener').toBeFocused()
      const committed = await readCommitted(page)
      expect(committed).toHaveLength(1)
      expect(committed[0], 'reviewing the file changes nothing').toMatchObject(literalOf(HARBOR))
    })

    test(`R-edit note: the modeled caret at the start, interior and end stays visible under a measured no-wrap precondition, the literal edit and the forward noncollapsed selection survive every resize with their focus endpoint visible, and a user resize is bounded on the small screen and restored later at ${tag(viewport)}`, async ({ page }, testInfo) => {
      const dialog = await openLanternDetail(page)
      const field = noteField(dialog)
      const walk = new KeyboardWalk(page, testInfo, `edit-note-${tag(viewport)}`, {
        contract: D2_CONTRACT, row: '긴/사용자 resize 메모', requirements: ['requirement 1', 'requirement 2', 'requirement 4', 'requirement 10'], fixture: LANTERN.job.id, viewport, preparation: PREPARATION_NOTE,
        measurement: 'Tab to the note; insertText the 40-line body (paste-like, labeled); caret to the start with a real chord; ArrowDown to the interior line; End and a typed literal; Shift+ArrowDown twice; resize to 320x800 and 1440x960; mouse drag on the resize grip; resize to 320x480 and back to 1440x960. Every stop is judged; caret geometry is modeled from value, selection direction, computed line height, padding, border and inner scroll and is trusted only with the measured no-soft-wrap precondition.',
      })
      const carets: Record<string, CaretGeometry> = {}
      const metrics: Record<string, Awaited<ReturnType<typeof textareaMetrics>>> = {}
      const chords: string[] = []
      let selectionAfterExtend: { start: number; end: number; direction: string } | null = null
      let availableAtShrunk: number | null = null
      try {
        const initial = await walk.observe('initial-close')
        expect(initial.name).toBe(LABEL.close)
        await walkUntil(walk, 'Tab', 'forward-to-note', stop => stop.name === LABEL.note, 60)
        await page.keyboard.insertText(CARET_BODY)
        await expect(field).toHaveValue(CARET_BODY)
        await waitForSavedCommit(page)
        await settleLayout(page, 'after inserting the body')
        await walk.observe('body-inserted', 'insertText', { screenshot: true })
        carets.end = await caretGeometry(page)
        chords.push(await moveCaret(page, 'start'))
        await walk.observe('caret-start', chords[0])
        carets.start = await caretGeometry(page)
        for (let presses = 0; presses < CARET_INTERIOR_LINE; presses++) await pressKey(page, 'ArrowDown')
        await walk.observe('caret-interior', `ArrowDown x${CARET_INTERIOR_LINE}`, { screenshot: true })
        carets.interior = await caretGeometry(page)
        await pressKey(page, 'End')
        await page.keyboard.type(CARET_INTERIOR_EDIT)
        await expect(field).toHaveValue(CARET_BODY_EDITED)
        await walk.observe('interior-edit', `type:${CARET_INTERIOR_EDIT}`)
        carets.afterEdit = await caretGeometry(page)
        await pressKey(page, 'Shift+ArrowDown')
        await pressKey(page, 'Shift+ArrowDown')
        const extended = await walk.observe('selection-extended', 'Shift+ArrowDown x2', { screenshot: true })
        selectionAfterExtend = extended.probe.active.selection
        carets.extended = await caretGeometry(page)
        for (const target of [{ width: 320, height: 800 }, { width: 1440, height: 960 }]) {
          await page.setViewportSize(target)
          await settleLayout(page, `after resizing to ${tag(target)}`)
          await walk.observe(`already-focused-${tag(target)}`, `resize:${tag(target)}`, { screenshot: true })
          carets[`after-${tag(target)}`] = await caretGeometry(page)
        }
        metrics.beforeDrag = await textareaMetrics(field)
        await dragResize(page, field, 160)
        await settleLayout(page, 'after the user resize')
        metrics.afterDrag = await textareaMetrics(field)
        await walk.observe('after-user-resize-1440x960', 'mouse-drag-resize', { screenshot: true })
        carets.afterDrag = await caretGeometry(page)
        await page.setViewportSize({ width: 320, height: 480 })
        await settleLayout(page, 'after resizing to 320x480')
        const shrunk = await walk.observe('already-focused-320x480-after-user-resize', 'resize:320x480', { screenshot: true })
        availableAtShrunk = shrunk.probe.availableArea?.height ?? null
        metrics.shrunk = await textareaMetrics(field)
        carets.shrunk = await caretGeometry(page)
        await page.setViewportSize({ width: 1440, height: 960 })
        await settleLayout(page, 'after restoring 1440x960')
        await walk.observe('restored-1440x960', 'resize:1440x960', { screenshot: true })
        metrics.restored = await textareaMetrics(field)
        carets.restored = await caretGeometry(page)
      } finally {
        await walk.attach({ carets, metrics, chords, selectionAfterExtend, availableAtShrunk })
      }

      expect(walk.stops.every(stop => stop.judgement === 'asserted')).toBe(true)
      expect(walk.failures(), `every stop of the editing walk is visible, including the already-focused states after each resize (see the ${walk.name}-stops attachment)`).toEqual([])
      for (const [phase, geometry] of Object.entries(carets)) {
        expect(geometry.noSoftWrap, `${phase}: measured no-soft-wrap precondition (rendered ${geometry.renderedLineCount} lines for ${geometry.logicalLineCount} logical lines)`).toBe(true)
        expect(caretVisible(geometry), `${phase}: the modeled caret line is inside the textarea box and the body area (${JSON.stringify({ top: geometry.modeledCaretTop, bottom: geometry.modeledCaretBottom, box: geometry.box, bodyArea: geometry.bodyArea })})`).toBe(true)
      }
      expect(carets.end, 'caret geometry at the end of the inserted body').toMatchObject({ lineIndex: 39, selectionStart: CARET_BODY.length, selectionEnd: CARET_BODY.length, focusOffset: CARET_BODY.length })
      expect(carets.start, 'caret geometry at the start').toMatchObject({ lineIndex: 0, selectionStart: 0, selectionEnd: 0, scrollTop: 0 })
      expect(carets.interior, 'caret geometry at the interior line').toMatchObject({ lineIndex: CARET_INTERIOR_LINE })
      expect(carets.afterEdit, 'caret geometry after the literal edit').toMatchObject({ lineIndex: CARET_INTERIOR_LINE, valueLength: CARET_BODY_EDITED.length })
      expect(selectionAfterExtend, 'two Shift+ArrowDown presses leave a noncollapsed selection').not.toBeNull()
      expect(selectionAfterExtend!.start, 'noncollapsed selection').toBeLessThan(selectionAfterExtend!.end)
      expect(carets.extended, 'the forward selection keeps its focus endpoint at selectionEnd, two lines below the anchor').toMatchObject({ direction: 'forward', focusOffset: selectionAfterExtend!.end, lineIndex: CARET_INTERIOR_LINE + 2 })
      for (const phase of ['already-focused-320x800', 'already-focused-1440x960', 'after-user-resize-1440x960', 'already-focused-320x480-after-user-resize', 'restored-1440x960']) {
        const stop = walk.stops.find(candidate => candidate.phase === phase)
        expect(stop?.name, `${phase}: the note keeps focus`).toBe(LABEL.note)
        expect(stop?.probe.active.value, `${phase}: the literal value is preserved`).toBe(CARET_BODY_EDITED)
        expect(stop?.probe.active.selection, `${phase}: the noncollapsed selection and its direction are preserved`).toEqual(selectionAfterExtend)
      }
      expect(metrics.afterDrag.inlineHeight, 'the user resize records a requested inline height').not.toBe('')
      expect(metrics.afterDrag.renderedHeight, 'the user resize made the editor taller').toBeGreaterThan(metrics.beforeDrag.renderedHeight + 100)
      expect(metrics.shrunk.inlineHeight, 'the requested inline height is retained while bounded').toBe(metrics.afterDrag.inlineHeight)
      expect(metrics.shrunk.renderedHeight, 'the displayed editor is bounded on the small screen').toBeLessThan(metrics.afterDrag.renderedHeight)
      expect(availableAtShrunk, 'the available body area was measured at 320x480').not.toBeNull()
      expect(metrics.shrunk.renderedHeight, 'the bounded editor fits the available body area').toBeLessThanOrEqual(availableAtShrunk! + 0.5)
      expect(Math.abs(metrics.restored.renderedHeight - metrics.afterDrag.renderedHeight), 'the requested height is used again when space returns').toBeLessThanOrEqual(1)

      await waitForSavedCommit(page)
      await page.keyboard.press('Escape')
      await expect(dialog).toHaveCount(0)
      await expect(titleButton(page, LANTERN), 'requirement 7: Escape returns focus to the opener').toBeFocused()
      expect((await readCommitted(page)).find(record => record.job.id === LANTERN.job.id)?.note, 'the committed note equals the edited literal').toBe(CARET_BODY_EDITED)
    })
  })
}
