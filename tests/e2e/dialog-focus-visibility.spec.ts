/**
 * Stage81 K1–K4: native keyboard focus visibility inside the native modal
 * dialogs. Authored for the D1 baseline (docs/design/dialog-focus-visibility.md
 * SHA256 0120a532…, frozen with the failed baseline run) and strengthened for the
 * D2 contract (same path, SHA256 4f9f5cb4…): every D1 expectation is kept, and
 * the observations that D1 recorded without asserting are now asserted too.
 *
 * These cases observe what ordinary Tab, Shift+Tab, Enter, ArrowDown and typed
 * characters do inside the job detail and the backup dialog. Every native entry
 * (the initial Close, each Tab/Shift+Tab arrival, both wrap boundaries) and
 * every observation of the focused element (disclosure opened by Enter, inner
 * ArrowDown reading, the first failed-save notice, the settled draft, the
 * return-signal states, the K3 observations of the still-focused archive button
 * while the footer changes state, and the K4 observations of the still-focused
 * note right after each viewport resize) is judged against the contract in the
 * state the case actually produces. No observation is record-only any more.
 *
 * A passing run is a valid result; nothing here is built to fail. A failing stop
 * keeps its own unframed screenshot and the full ordered record, both attached
 * before the assertion runs; a measured stop is persisted before its screenshot
 * is attempted. Fixture prerequisites, readiness and sequence errors carry their
 * own labels so they are never read as visibility findings.
 *
 * Preparation (seeding, loading the saved view, focusing the opener, the
 * synthetic storage fault, viewport changes) is labeled as such in each record.
 * No locator focus, click, fill, scrollIntoView, scrollTop change or screenshot
 * framing happens between a key press and its observation. No Playwright Clock
 * is installed; the only synthetic signals are the existing lifecycle return
 * bursts in K2, labeled where they are dispatched.
 *
 * Mapping: K1 → D1 requirements 1, 2, 3, 7, 9, 10 (long detail, both directions,
 * nested reading region). K2 → 1, 2, 3, 4, 5 (Tab entry into the note, typed
 * draft, first failed-save notice, reverse entry from the footer, settled T0
 * invariants). K3 → 1, 2, 3, 4, 7 (changing backup footer, reverse entry into
 * the body under both footer states). K4 → 1, 4 (same focused note across
 * viewport changes; first entries after each resize).
 */
import { expect } from '@playwright/test'
import type { Page } from '@playwright/test'
import { dialogOf, installStoreFault, literalOf, noteField, test, titleButton } from './helpers/saved-removal-undo'
import { dispatchReturn, readCommitted, settle, unloadIsProtected } from './helpers/saved-lifecycle'
import { waitForSavedCommit } from './helpers/saved-store'
import {
  ALERT_TEXT, BACKUP_FOOTER_TEXT, BEACON, K2_DRAFT, K2_FIRST_CHARACTER, K2_REMAINDER, K4_DRAFT, KeyboardWalk, LABEL, LANTERN,
  LEGACY_UNREADABLE_ENTRY, OVERSIZED_CONTEXT_LINES, expectLayoutReady, openSavedViewPlain, seedSavedWithoutClock, sequenceCheck, stabilityFailures,
  summarize, walkUntil,
} from './helpers/dialog-focus-visibility'
import type { ActiveProbe } from './helpers/dialog-focus-visibility'

interface Viewport { width: number; height: number }
const VIEWPORTS: Viewport[] = [{ width: 1440, height: 960 }, { width: 320, height: 800 }, { width: 320, height: 480 }]
const tag = (viewport: Viewport) => `${viewport.width}x${viewport.height}`
const MAX_PRESSES = 60
const KEY_STOPS = new Set<string>([LABEL.close, LABEL.descriptionSummary, LABEL.descriptionRegion, LABEL.appliedToggle, LABEL.note, LABEL.footerRemove, LABEL.footerLink])
const keyStop = (probe: ActiveProbe) => KEY_STOPS.has(probe.active.name)
const PREPARATION_NOTE = 'Preparation only: localStorage seed, saved view load, opener focused with locator.focus() and Enter. From the first observation on, only Tab, Shift+Tab, Enter, ArrowDown, Escape and typed characters are used; no locator focus, click, fill, scrollIntoView, scrollTop change or screenshot framing precedes an observation.'
const JUDGEMENT_NOTE = 'D2: every native entry and every observation of the focused element is judged for visibility, including the K3 observations of the still-focused archive button while the footer changes state and the K4 observations of the still-focused note right after each resize. Nothing is record-only; focus/value/selection facts are asserted beside visibility.'

// Every stop is probed and may be photographed; the long detail yields many stops in both directions.
test.describe.configure({ timeout: 90_000 })

/** After a real layout change, allow the dialog's coalesced layout work (one frame plus its follow-up frame) to finish before observing. Four frames; no timer. */
async function settleFrames(page: Page) {
  await page.evaluate(() => new Promise<void>(resolve => {
    const step = (remaining: number) => { if (remaining <= 0) resolve(); else requestAnimationFrame(() => step(remaining - 1)) }
    step(4)
  }))
}

/** Preparation: seed, load the saved view, focus the opener and press Enter. The measured keyboard sequence starts at the dialog's Close control. */
async function openLanternDetail(page: Page) {
  await seedSavedWithoutClock(page, [LANTERN])
  await openSavedViewPlain(page, [LANTERN.job.title])
  await titleButton(page, LANTERN).focus()
  await page.keyboard.press('Enter')
  const dialog = dialogOf(page, LANTERN)
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole('heading', { name: LANTERN.job.title, exact: true })).toBeVisible()
  await expectLayoutReady(page, 'SETUP after opening the detail')
  return dialog
}

for (const viewport of VIEWPORTS) {
  test.describe(`native keyboard focus visibility at ${tag(viewport)}`, () => {
    test.use({ viewport, hasTouch: viewport.width === 320 })

    test(`K1 long saved-job detail: every Tab and Shift+Tab stop stays visible above the sticky footer at ${tag(viewport)}`, async ({ page }, testInfo) => {
      const dialog = await openLanternDetail(page)
      const walk = new KeyboardWalk(page, testInfo, `k1-${tag(viewport)}`, {
        d1: ['requirement 1', 'requirement 2', 'requirement 3', 'requirement 7', 'requirement 9', 'requirement 10'],
        fixture: LANTERN.job.id, viewport, preparation: PREPARATION_NOTE, judgement: JUDGEMENT_NOTE,
        measurement: 'Tab from Close until Close returns (wrap), opening the original description with Enter and pressing ArrowDown three times inside the reading region on the way; then Shift+Tab from Close (wrap to the footer link) back to Close. Every observation in this case is judged.',
        oversizedContextCriterion: `proposal for all3 review: an oversized reading region must show at least ${OVERSIZED_CONTEXT_LINES} fully visible text lines (read-only Range line rectangles inside the region's padding box, viewport, clipping ancestors and the body area at its current inner scroll); only an element with role=region, a tabindex and actual inner overflow qualifies; nothing is derived from font-size heuristics and no product size is changed`,
      })
      let innerScroll: { before: number | null; after: number | null; dialogScrollDelta: number; windowScrollDelta: number; claim: string } | null = null
      try {
        const initial = await walk.observe('initial-close', null, { screenshot: true })
        expect(initial.name, 'D1 requirement 1: the dialog opens with Close focused').toBe(LABEL.close)
        expect(initial.probe.dialog?.overflowing, `FIXTURE PRECONDITION (setup, not a product result): the long detail must overflow the dialog scrollport at ${tag(viewport)}`).toBe(true)
        for (let presses = 1; ; presses++) {
          const stop = await walk.press('Tab', 'forward', { screenshot: keyStop })
          if (stop.name === LABEL.close) break
          if (presses >= MAX_PRESSES) throw new Error(`${walk.name} forward: Tab did not return to Close within ${MAX_PRESSES} presses; stops: ${walk.names().join(' → ')}`)
          if (stop.name === LABEL.descriptionSummary && stop.probe.active.detailsOpen === false) {
            // Keyboard activation of the disclosure; the summary keeps focus and the observation is judged like every other K1 stop.
            await walk.press('Enter', 'forward-open-description', { screenshot: true })
          }
          if (stop.name === LABEL.descriptionRegion) {
            // Same element, inner scrolling only; judged (D1 requirement 9). Three presses prove movement, not access to every line.
            let last = stop
            for (let arrows = 0; arrows < 3; arrows++) last = await walk.press('ArrowDown', 'forward-inner-scroll', { screenshot: arrows === 2 })
            innerScroll = {
              before: stop.probe.active.innerScroll?.scrollTop ?? null,
              after: last.probe.active.innerScroll?.scrollTop ?? null,
              dialogScrollDelta: (last.probe.dialog?.scrollTop ?? 0) - (stop.probe.dialog?.scrollTop ?? 0),
              windowScrollDelta: last.probe.windowScroll.y - stop.probe.windowScroll.y,
              claim: 'bounded: three ArrowDown presses moved the region content without moving the dialog or the background; access to all of the content and to the following controls is not proven here (D2 obligation).',
            }
          }
        }
        const wrap = await walk.press('Shift+Tab', 'backward-wrap', { screenshot: true })
        expect(wrap.name, 'Shift+Tab from Close wraps to the last footer control').toBe(LABEL.footerLink)
        for (let presses = 1; ; presses++) {
          const stop = await walk.press('Shift+Tab', 'backward', { screenshot: keyStop })
          if (stop.name === LABEL.close) break
          if (presses >= MAX_PRESSES) throw new Error(`${walk.name} backward: Shift+Tab did not return to Close within ${MAX_PRESSES} presses; stops: ${walk.names().join(' → ')}`)
        }
      } finally {
        await walk.attach({ innerScroll })
      }

      // Evidence is attached; the assertions below read the recorded stops only.
      const names = walk.names()
      expect(sequenceCheck(names, [
        LABEL.close, LABEL.descriptionSummary, LABEL.descriptionRegion, LABEL.appliedToggle, LABEL.note, LABEL.footerRemove, LABEL.footerLink, LABEL.close,
        LABEL.footerLink, LABEL.footerRemove, LABEL.note, LABEL.appliedToggle, LABEL.descriptionRegion, LABEL.descriptionSummary, LABEL.close,
      ]), `named stops must appear in this order in both directions; recorded order: ${names.join(' → ')}`).toEqual({ missing: [], outOfOrder: [] })
      expect(walk.stops.every(stop => stop.judgement === 'asserted'), 'K1 has no record-only observation').toBe(true)
      expect(walk.failures(), `D1 requirements 1, 2 and 10 at every K1 observation (see the ${walk.name}-stops attachment and the per-stop screenshots)`).toEqual([])

      const note = walk.find(LABEL.note, 'forward')
      expect(note?.probe.active.value, 'the saved note starts empty for this fixture').toBe('')
      expect(note?.probe.active.indicator.kind, 'the note shows the field indicator (border and shadow), not an outline').toBe('border-shadow')
      const link = walk.find(LABEL.footerLink, 'forward')
      expect(link?.probe.active.href).toBe(LANTERN.job.url)
      expect(link?.kind).toBe('footer-owned')
      const remove = walk.find(LABEL.footerRemove, 'forward')
      expect(remove?.probe.active.disabled).toBe(false)
      expect(remove?.kind).toBe('footer-owned')
      const region = walk.find(LABEL.descriptionRegion, 'forward')
      expect(region?.probe.active.readingRegion?.identified, `FIXTURE PRECONDITION: the original description must be an identified, genuinely overflowing reading region (reasons: ${region?.probe.active.readingRegion?.reasons.join(', ') ?? 'none'})`).toBe(true)
      expect(region?.probe.active.readingRegion?.lineCount ?? 0, 'FIXTURE PRECONDITION: the reading region must expose measurable text line rectangles').toBeGreaterThan(0)
      expect(['ordinary', 'oversized-region']).toContain(region?.kind)
      expect(innerScroll, 'the reading region was entered and scrolled with ArrowDown').not.toBeNull()
      expect(innerScroll?.after ?? 0, 'D1 requirement 9: ArrowDown scrolls the focused reading region').toBeGreaterThan(innerScroll?.before ?? 0)
      expect(Math.abs(innerScroll?.dialogScrollDelta ?? Number.NaN), 'D1 requirement 9: reading inside the region must not move the dialog').toBeLessThanOrEqual(0.5)
      expect(innerScroll?.windowScrollDelta, 'D1 requirement 9: reading inside the region must not scroll the locked background').toBe(0)

      await page.keyboard.press('Escape')
      await expect(dialog).toHaveCount(0)
      await expect(titleButton(page, LANTERN), 'D1 requirement 7: Escape returns focus to the connected opener').toBeFocused()
      const committed = await readCommitted(page)
      expect(committed).toHaveLength(1)
      expect(committed[0], 'the committed record is the untouched fixture (read migrations may add interpretation fields)').toMatchObject(literalOf(LANTERN))
    })

    test(`K2 note entered by Tab, typed draft, first failed-save notice and reverse entry from the footer at ${tag(viewport)}`, async ({ page }, testInfo) => {
      const dialog = await openLanternDetail(page)
      // Preparation (synthetic, labeled): from here every put on the records store throws QuotaExceededError.
      const fault = await installStoreFault(page, 'put')
      const walk = new KeyboardWalk(page, testInfo, `k2-${tag(viewport)}`, {
        d1: ['requirement 1', 'requirement 2', 'requirement 3', 'requirement 4', 'requirement 5'],
        fixture: LANTERN.job.id, viewport, judgement: JUDGEMENT_NOTE,
        preparation: `${PREPARATION_NOTE} Storage fault: IDBObjectStore.put on the records store throws a synthetic QuotaExceededError from before the first keystroke; it is not a visibility correction.`,
        measurement: 'Tab from Close to the note with every intermediate entry judged in this state (the disclosure stays closed here), observe entry, type one character, observe the first failed-save notice, type the rest, observe the settled draft, Tab through the notice actions into the footer, Shift+Tab back into the body and the note, then dispatch the existing synthetic return bursts and compare. Every observation in this case is judged.',
      })
      let attemptsAtSettled = -1
      let unloadProtectedAtSettled: boolean | null = null
      let bursts: { attemptsBefore: number; attemptsAfter: number; stability: string[]; unloadProtected: boolean } | null = null
      try {
        const initial = await walk.observe('initial-close')
        expect(initial.name, 'D1 requirement 1: the dialog opens with Close focused').toBe(LABEL.close)
        await walkUntil(walk, 'Tab', 'forward-to-note', stop => stop.name === LABEL.note, MAX_PRESSES, { screenshot: probe => probe.active.name === LABEL.note })

        await page.keyboard.type(K2_FIRST_CHARACTER)
        await expect(dialog.getByRole('alert')).toContainText(ALERT_TEXT.pending)
        await walk.observe('after-first-failed-save-notice', `type:${K2_FIRST_CHARACTER}`, { screenshot: true })
        await expect(dialog.getByRole('alert')).toContainText(ALERT_TEXT.quota)
        await expect(dialog.getByRole('alert')).toContainText(ALERT_TEXT.keep)

        await page.keyboard.type(K2_REMAINDER)
        await expect(noteField(dialog)).toHaveValue(K2_DRAFT)
        await expectLayoutReady(page, 'settled draft after the failed-save notice')
        await walk.observe('settled-draft-T0', `type:${K2_REMAINDER}`, { screenshot: true })
        attemptsAtSettled = await fault.attempts()
        unloadProtectedAtSettled = await unloadIsProtected(page)

        await walk.press('Tab', 'forward-notice-actions', { screenshot: true })
        await walk.press('Tab', 'forward-notice-actions', { screenshot: true })
        await walk.press('Tab', 'forward-notice-actions', { screenshot: true })
        await walk.press('Tab', 'forward-into-footer', { screenshot: true })
        await walk.press('Shift+Tab', 'backward-from-footer-into-body', { screenshot: true })
        await walk.press('Shift+Tab', 'backward')
        await walk.press('Shift+Tab', 'backward')
        await walk.press('Shift+Tab', 'backward-into-note', { screenshot: true })

        await expectLayoutReady(page, 'before the synthetic return bursts')
        const t0 = await walk.observe('return-T0')
        const attemptsBefore = await fault.attempts()
        // Synthetic focus/visibilitychange/pageshow bursts from the existing lifecycle helper: a listener-path signal, not a native tab switch.
        await dispatchReturn(page, 'burst')
        await dispatchReturn(page, 'burst')
        await settle(page, 200)
        const t2 = await walk.observe('return-T2', 'synthetic-return-bursts', { screenshot: true })
        bursts = { attemptsBefore, attemptsAfter: await fault.attempts(), stability: stabilityFailures(t0.probe, t2.probe), unloadProtected: await unloadIsProtected(page) }
      } finally {
        await walk.attach({ attemptsAtSettled, unloadProtectedAtSettled, bursts, timeline: walk.stops.map(summarize) })
      }

      const names = walk.names()
      expect(sequenceCheck(names, [
        LABEL.close, LABEL.note, LABEL.retry, LABEL.csv, LABEL.jsonBackup, LABEL.footerRemove, LABEL.jsonBackup, LABEL.csv, LABEL.retry, LABEL.note,
      ]), `named stops in order; recorded order: ${names.join(' → ')}`).toEqual({ missing: [], outOfOrder: [] })
      // Every observation of this case is judged: the path to the note, the note entry, the notice onset, the settled draft,
      // the notice actions, the footer, the reverse entries and both return-signal states.
      expect(walk.stops.every(stop => stop.judgement === 'asserted'), 'K2 has no record-only observation').toBe(true)
      expect(walk.failures(), `D1 requirements 1, 2 and 4 at every K2 observation (see the ${walk.name}-stops attachment)`).toEqual([])

      const entry = walk.find(LABEL.note, 'forward-to-note')
      expect(entry?.kind).toBe('ordinary')
      expect(entry?.probe.active.value, 'the note is empty on entry').toBe('')
      expect(entry?.probe.active.selection, 'caret at the start of the empty note on Tab entry').toMatchObject({ start: 0, end: 0 })
      expect(entry?.probe.active.indicator.kind).toBe('border-shadow')
      const onset = walk.find(LABEL.note, 'after-first-failed-save-notice')
      expect(onset?.name, 'D1 requirement 4: the note keeps focus when the notice appears').toBe(LABEL.note)
      expect(onset?.probe.active.value).toBe(K2_FIRST_CHARACTER)
      expect(onset?.probe.active.selection).toMatchObject({ start: 1, end: 1 })
      expect(onset?.probe.noteAlert, 'the failed-save notice renders inside the note section').not.toBeNull()
      const settled = walk.find(LABEL.note, 'settled-draft-T0')
      expect(settled?.probe.active.value).toBe(K2_DRAFT)
      expect(settled?.probe.active.selection).toMatchObject({ start: K2_DRAFT.length, end: K2_DRAFT.length })
      expect(attemptsAtSettled, 'the synthetic fault was exercised by the typed draft').toBeGreaterThanOrEqual(1)
      expect(unloadProtectedAtSettled, 'an unsaved draft keeps the unload protection').toBe(true)
      const reverseNote = walk.find(LABEL.note, 'backward-into-note')
      expect(reverseNote?.probe.active.value, 'reverse entry keeps the draft').toBe(K2_DRAFT)
      expect(bursts).not.toBeNull()
      expect(bursts?.stability, 'D1 requirement 5: unchanged return signals leave focus, value, selection, rectangle and scroll untouched').toEqual([])
      expect(bursts?.attemptsAfter, 'return signals must not retry the failed write').toBe(bursts?.attemptsBefore)
      expect(bursts?.unloadProtected).toBe(true)
      const committed = await readCommitted(page)
      expect(committed.find(record => record.job.id === LANTERN.job.id)?.note, 'the failed draft is not committed').toBe('')
    })

    test(`K3 backup dialog: deleting an archive changes the footer; keyboard entries under both footer states stay visible at ${tag(viewport)}`, async ({ page }, testInfo) => {
      // Preparation: one fictional record plus an unreadable legacy entry, which the migration keeps as a recovery source.
      await seedSavedWithoutClock(page, [BEACON, LEGACY_UNREADABLE_ENTRY])
      await openSavedViewPlain(page, [BEACON.job.title])
      const opener = page.getByRole('button', { name: LABEL.backupOpener, exact: true })
      await opener.focus()
      await page.keyboard.press('Enter')
      const dialog = page.getByRole('dialog', { name: LABEL.backupDialog, exact: true })
      await expect(dialog).toBeVisible()
      const archive = dialog.locator('.saved-recovery-source')
      await expect(archive).toHaveCount(1)
      await expect(archive.locator('strong').first()).toHaveText(LABEL.legacyArchive)
      const footerText = dialog.locator('.dialog-footer > span')
      await expect(footerText).toHaveText(BACKUP_FOOTER_TEXT.idle)
      await expectLayoutReady(page, 'SETUP after opening the backup dialog')
      const walk = new KeyboardWalk(page, testInfo, `k3-${tag(viewport)}`, {
        d1: ['requirement 1', 'requirement 2', 'requirement 3', 'requirement 4', 'requirement 7'],
        fixture: [BEACON.job.id, 'unreadable legacy entry'], viewport, judgement: JUDGEMENT_NOTE,
        preparation: 'Preparation only: localStorage seed with one record and one unreadable legacy entry, saved view load, backup opener focused with locator.focus() and Enter.',
        measurement: 'Tab from Close until Close returns under the idle footer; Shift+Tab back into the last body control; Enter activates the archive deletion so the footer changes state (both observations of the still-focused button are judged, D2 requirement 4); Tab into the changed footer; Shift+Tab back into the body under the changed footer; Tab through both footer actions to the wrap. Escape closes without deleting.',
        fixturePrerequisite: 'At 320px widths the backup footer must measurably change height between the idle and the delete-confirm state and must wrap in at least one state (child rows that are vertically separated, or a child whose text occupies two or more rendered lines); desktop is recorded only. Raw child rectangles and text line rectangles are attached for both states.',
      })
      let idleFooter: ActiveProbe['footer'] = null
      let confirmFooter: ActiveProbe['footer'] = null
      let confirmGroup: ActiveProbe['recoveryConfirm'] = null
      let dialogOverflowing: boolean | null = null
      try {
        const initial = await walk.observe('initial-close', null, { screenshot: true })
        expect(initial.name, 'D1 requirement 1: the dialog opens with Close focused').toBe(LABEL.close)
        idleFooter = initial.probe.footer
        dialogOverflowing = initial.probe.dialog?.overflowing ?? null
        for (let presses = 1; ; presses++) {
          const stop = await walk.press('Tab', 'forward-idle-footer', { screenshot: true })
          if (stop.name === LABEL.close) break
          if (presses >= 40) throw new Error(`${walk.name} forward: Tab did not return to Close within 40 presses; stops: ${walk.names().join(' → ')}`)
        }
        const wrap = await walk.press('Shift+Tab', 'backward-wrap', { screenshot: true })
        expect(wrap.name, 'Shift+Tab from Close wraps to the footer action').toBe(LABEL.done)
        const lastBody = await walk.press('Shift+Tab', 'backward-into-body-idle-footer', { screenshot: true })
        expect(lastBody.name, 'the last body control before the footer is the archive deletion').toBe(LABEL.deleteArchive)

        // Keyboard activation: the focused button stays, the confirmation group appears below it and the footer switches
        // to two actions. Both observations of the still-focused button are judged (D2 requirement 4: a real footer
        // change must leave the engaged control visible); entries under the changed footer are judged at the following stops.
        await walk.press('Enter', 'activate-delete-archive', { screenshot: true })
        await expect(dialog.getByRole('group', { name: LABEL.deleteConfirmGroup, exact: true })).toBeVisible()
        await expect(footerText).toHaveText(BACKUP_FOOTER_TEXT.confirmDelete)
        await expectLayoutReady(page, 'after the footer changed state')
        await settleFrames(page)
        const changed = await walk.observe('already-focused-after-footer-change', 'footer-state-change', { screenshot: true })
        confirmFooter = changed.probe.footer
        confirmGroup = changed.probe.recoveryConfirm

        await walk.press('Tab', 'forward-into-confirm-footer', { screenshot: true })
        await walk.press('Shift+Tab', 'backward-into-body-confirm-footer', { screenshot: true })
        await walk.press('Tab', 'forward-confirm-footer')
        await walk.press('Tab', 'forward-confirm-footer', { screenshot: true })
        await walk.press('Tab', 'forward-wrap-confirm-footer')
      } finally {
        await walk.attach({
          dialogOverflowing,
          footers: {
            idle: idleFooter, confirmDelete: confirmFooter,
            heightDelta: idleFooter && confirmFooter ? Math.round((confirmFooter.rect.height - idleFooter.rect.height) * 100) / 100 : null,
            wrapping: {
              idle: idleFooter ? { childRows: idleFooter.childRows, maxTextLinesInChild: idleFooter.maxTextLinesInChild, wrapped: idleFooter.wrapped } : null,
              confirmDelete: confirmFooter ? { childRows: confirmFooter.childRows, maxTextLinesInChild: confirmFooter.maxTextLinesInChild, wrapped: confirmFooter.wrapped } : null,
            },
          },
          confirmGroup,
        })
      }

      // Fixture prerequisite for the intended changing/wrapping second footer (BT4). Soft, labeled and evaluated before the
      // visibility assertions so an unmet prerequisite is reported as a coverage gap alongside, never as a focus defect.
      const heightDelta = idleFooter && confirmFooter ? Math.abs(confirmFooter.rect.height - idleFooter.rect.height) : null
      const wrappedInSomeState = Boolean(idleFooter?.wrapped || confirmFooter?.wrapped)
      if (viewport.width === 320) {
        expect.soft(heightDelta, `FIXTURE PREREQUISITE (coverage, not a focus defect): at ${tag(viewport)} the backup footer height must measurably change between the idle and the delete-confirm state; idle=${idleFooter?.rect.height}, confirm=${confirmFooter?.rect.height}`).toBeGreaterThan(0.5)
        expect.soft(wrappedInSomeState, `FIXTURE PREREQUISITE (coverage, not a focus defect): at ${tag(viewport)} the backup footer must wrap in at least one state, measured as vertically separated child rows or a child whose text occupies two or more rendered lines; idle rows=${idleFooter?.childRows}/lines=${idleFooter?.maxTextLinesInChild}, confirm rows=${confirmFooter?.childRows}/lines=${confirmFooter?.maxTextLinesInChild}`).toBe(true)
      }

      const names = walk.names()
      expect(sequenceCheck(names, [
        LABEL.close, LABEL.backupExport, LABEL.backupFile, LABEL.downloadOriginal, LABEL.deleteArchive, LABEL.done, LABEL.close,
        LABEL.done, LABEL.deleteArchive, LABEL.deleteArchive, LABEL.deleteArchive, LABEL.cancelDelete, LABEL.deleteArchive, LABEL.cancelDelete, LABEL.confirmDelete, LABEL.close,
      ]), `named stops in order; recorded order: ${names.join(' → ')}`).toEqual({ missing: [], outOfOrder: [] })
      expect(walk.stops.map(stop => stop.phase), 'both footer-change observations were recorded').toEqual(expect.arrayContaining(['activate-delete-archive', 'already-focused-after-footer-change']))
      expect(walk.stops.filter(stop => stop.judgement === 'record-only'), 'D2: no K3 observation is record-only').toEqual([])
      expect(walk.failures(), `D2 requirements 1, 2 and 4 at every K3 observation, including both footer-change states (see the ${walk.name}-stops attachment)`).toEqual([])

      const changed = walk.find(LABEL.deleteArchive, 'already-focused-after-footer-change')
      expect(changed?.name, 'D1 requirement 4: the activated control keeps focus while the footer changes').toBe(LABEL.deleteArchive)
      expect(changed?.probe.active.disabled).toBe(false)
      expect(idleFooter?.text).toContain(BACKUP_FOOTER_TEXT.idle)
      expect(confirmFooter?.text).toContain(BACKUP_FOOTER_TEXT.confirmDelete)
      expect(idleFooter?.rect.height ?? 0, 'the idle footer has a painted height').toBeGreaterThan(0)
      expect(confirmFooter?.rect.height ?? 0, 'the delete-confirm footer has a painted height').toBeGreaterThan(0)
      expect(idleFooter?.children.length ?? 0, 'the idle footer rendered children were measured').toBeGreaterThan(0)
      expect(confirmFooter?.children.length ?? 0, 'the delete-confirm footer rendered children were measured').toBeGreaterThan(0)
      expect(confirmGroup, 'the confirmation group has a painted rectangle').not.toBeNull()
      const reverse = walk.find(LABEL.deleteArchive, 'backward-into-body-confirm-footer')
      expect(reverse?.judgement, 'the reverse entry under the changed footer is a judged entry').toBe('asserted')
      expect(reverse?.kind, 'the archive deletion button is an ordinary control').toBe('ordinary')
      expect(walk.find(LABEL.cancelDelete, 'forward-into-confirm-footer')?.kind).toBe('footer-owned')
      const confirm = walk.find(LABEL.confirmDelete)
      expect(confirm?.kind).toBe('footer-owned')
      expect(confirm?.probe.active.disabled).toBe(false)

      await expect(archive, 'nothing was deleted during the walk').toHaveCount(1)
      await page.keyboard.press('Escape')
      await expect(dialog).toHaveCount(0)
      await expect(opener, 'D1 requirement 7: Escape returns focus to the opener').toBeFocused()
      const committed = await readCommitted(page)
      expect(committed).toHaveLength(1)
      expect(committed[0], 'the committed record is the untouched fixture; the unreadable legacy entry is not a record').toMatchObject(literalOf(BEACON))
      // D2 preservation after the cancelled flow: no deletion was intended, so the archive is still listed when the dialog is reopened.
      await opener.focus()
      await page.keyboard.press('Enter')
      await expect(dialog).toBeVisible()
      await expect(archive, 'the archive survives Escape').toHaveCount(1)
      await page.keyboard.press('Escape')
      await expect(dialog).toHaveCount(0)
      await expect(opener).toBeFocused()
    })
  })
}

test.describe('K4 same focused note across viewport changes', () => {
  test.use({ viewport: { width: 1440, height: 960 } })

  test('K4 the focused note keeps focus, value and selection through 320x800, 320x480 and back to 1440x960, and first entries after each resize stay visible', async ({ page }, testInfo) => {
    const dialog = await openLanternDetail(page)
    const walk = new KeyboardWalk(page, testInfo, 'k4-resize', {
      d1: ['requirement 1', 'requirement 4'],
      fixture: LANTERN.job.id, startViewport: { width: 1440, height: 960 }, judgement: JUDGEMENT_NOTE,
      preparation: `${PREPARATION_NOTE} Viewport changes are the event under observation; nothing else is done between a resize and its observation.`,
      measurement: 'Tab from Close to the note with every intermediate entry judged (the disclosure stays closed here), type a literal, wait for the commit, observe (judged); then for each viewport: resize, observe the already-focused note (judged, D2 requirement 4), Tab once (first entry at the new size, judged), Shift+Tab back into the note (reverse entry, judged).',
    })
    interface ResizeRow { viewport: Viewport; footer: ActiveProbe['footer']; dialog: ActiveProbe['dialog']; alreadyFocused: ReturnType<typeof summarize>; firstEntry: ReturnType<typeof summarize>; reverseEntry: ReturnType<typeof summarize> }
    const matrix: ResizeRow[] = []
    let settledSelection: ActiveProbe['active']['selection'] = null
    try {
      const initial = await walk.observe('initial-close')
      expect(initial.name, 'D1 requirement 1: the dialog opens with Close focused').toBe(LABEL.close)
      await walkUntil(walk, 'Tab', 'forward-to-note', stop => stop.name === LABEL.note, MAX_PRESSES, { screenshot: probe => probe.active.name === LABEL.note })
      await page.keyboard.type(K4_DRAFT)
      await expect(noteField(dialog)).toHaveValue(K4_DRAFT)
      await waitForSavedCommit(page)
      await expectLayoutReady(page, 'settled note at 1440x960')
      const settled = await walk.observe('settled-1440x960', `type:${K4_DRAFT}`, { screenshot: true })
      settledSelection = settled.probe.active.selection
      for (const target of [{ width: 320, height: 800 }, { width: 320, height: 480 }, { width: 1440, height: 960 }]) {
        await page.setViewportSize(target)
        await expectLayoutReady(page, `after resizing to ${tag(target)}`)
        await settleFrames(page)
        // D2 requirement 4: the still-focused note must be visible after the real size change itself, not only after the next Tab.
        const resized = await walk.observe(`already-focused-${tag(target)}`, `resize:${tag(target)}`, { screenshot: true })
        const next = await walk.press('Tab', `first-entry-after-resize-${tag(target)}`, { screenshot: true })
        const back = await walk.press('Shift+Tab', `reverse-entry-after-resize-${tag(target)}`, { screenshot: true })
        matrix.push({ viewport: target, footer: resized.probe.footer, dialog: resized.probe.dialog, alreadyFocused: summarize(resized), firstEntry: summarize(next), reverseEntry: summarize(back) })
      }
    } finally {
      await walk.attach({ settledSelection, matrix })
    }

    expect(matrix).toHaveLength(3)
    expect(settledSelection, 'caret at the end of the typed literal before any resize').toMatchObject({ start: K4_DRAFT.length, end: K4_DRAFT.length })
    for (const row of matrix) {
      expect(row.alreadyFocused.judgement, 'D2: the post-resize observation is asserted').toBe('asserted')
      expect(row.alreadyFocused.name, `D1 requirement 4: focus stays on the note after resizing to ${tag(row.viewport)}`).toBe(LABEL.note)
      expect(row.alreadyFocused.value, `D1 requirement 4: the note keeps its value after resizing to ${tag(row.viewport)}`).toBe(K4_DRAFT)
      expect(row.alreadyFocused.selection, `D1 requirement 4: the selection is preserved after resizing to ${tag(row.viewport)}`).toEqual(settledSelection)
      expect(row.firstEntry.judgement).toBe('asserted')
      expect(row.firstEntry.name, `Tab from the note reaches the footer toggle at ${tag(row.viewport)}`).toBe(LABEL.footerRemove)
      expect(row.reverseEntry.judgement).toBe('asserted')
      expect(row.reverseEntry.name, `Shift+Tab returns to the note at ${tag(row.viewport)}`).toBe(LABEL.note)
      expect(row.footer, `the footer rectangle was measured at ${tag(row.viewport)}`).not.toBeNull()
    }
    expect(walk.stops.map(stop => stop.phase), 'all three post-resize observations were recorded')
      .toEqual(expect.arrayContaining(['already-focused-320x800', 'already-focused-320x480', 'already-focused-1440x960']))
    expect(walk.stops.filter(stop => stop.judgement === 'record-only'), 'D2: no K4 observation is record-only').toEqual([])
    // Every stop is judged: the path to the note, the settled note, the already-focused note after each resize, and the first and reverse entries at every size.
    expect(walk.failures(), `D2 requirements 1, 2 and 4 at every K4 stop, including the three post-resize states (see the ${walk.name}-stops attachment)`).toEqual([])

    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await expect(titleButton(page, LANTERN), 'D1 requirement 7: Escape returns focus to the connected opener').toBeFocused()
    expect((await readCommitted(page)).find(record => record.job.id === LANTERN.job.id)?.note, 'the committed note equals the typed literal').toBe(K4_DRAFT)
  })
})
