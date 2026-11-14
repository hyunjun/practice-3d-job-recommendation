/**
 * Stage81 D2 final E2E: the other dialog callers (docs/design/dialog-focus-visibility.md,
 * D2 candidate 01, SHA256 4f9f5cb4…). Rows covered: 「필터/토글」 (both toggle
 * tracks, literal count transitions on an explicit catalog, an inserted alert
 * with its retry control, keyboard reset and apply, and a later-inserted alert
 * under authored 200% text measured against its own 100% references) and
 * 「footer 없는 Profile/Data」 (no spacer, no needless scroll, the visible upload
 * button opening the chooser, the label import path, the years error focus, and
 * the data dialog traversal).
 *
 * The explore view is served an explicit synthetic catalog of three onsite
 * engineering postings that differ only in disclosed salary, so the count
 * button shows literal values: 3 with the default draft and 2 when undisclosed
 * salaries are excluded. The expectation is stated as public behaviour of the
 * toggle, never derived through product matching code. The count preview is made
 * to fail transiently by a labeled synthetic fault; nothing marks the worker
 * failed, and the fault is removed before the recalculation. Footerless
 * criteria are observable: no footer, zero bottom padding, no generated spacer
 * after the last rendered child, unchanged dialog scroll while the first
 * visible controls are traversed. No before-change baseline number is invented.
 *
 * Both Filters toggles are enabled native stops rendered before the inserted
 * alert, so the retry is reached from the salary toggle through the remote
 * toggle, which is traversed and judged, never skipped. The probe cannot tell the
 * two bare checkbox inputs apart (descriptor "input", empty name for both), so a
 * toggle's identity is proved read-only against its distinct accessible checkbox
 * before it is recorded, with a same-instant witness that its own track is a
 * rendered rectangle distinct from the other toggle track; viewport rectangles
 * recorded at different native scroll stops are never compared with each other,
 * because separate controls can be revealed to the same viewport edge. The grown
 * Filters footer is audited in its error and
 * result states for horizontal overflow and whole labels. The Profile dialog is
 * renamed by Analyze, so the step-two dialog is bound by its own accessible name
 * for the years error, the invalid field and the post-Escape absence.
 */
import { expect } from '@playwright/test'
import type { Page } from '@playwright/test'
import { literalOf, test } from './helpers/saved-removal-undo'
import { readCommitted } from './helpers/saved-lifecycle'
import { KeyboardWalk, LABEL, LANTERN, openSavedViewPlain, pressKey, seedSavedWithoutClock, walkUntil } from './helpers/dialog-focus-visibility'
import type { Rect, WalkStop } from './helpers/dialog-focus-visibility'
import {
  COUNT_CATALOG_JOBS, COUNT_EXPECTED, D2_CONTRACT, D2_LABEL, RESUME_TEXT, applyFontReferences, doubleFonts, fontReferenceMismatches, fontReferences, footerState,
  installPreviewFault, openDataByKeyboard, openExploreFresh, openFiltersByKeyboard, openProfileByKeyboard, overflowAudit, settleLayout, snapshotFonts, spacerAudit, verifyFonts,
} from './helpers/dialog-focus-visibility-d2'
import type { FontReference, OverflowAudit, SpacerAudit } from './helpers/dialog-focus-visibility-d2'

interface Viewport { width: number; height: number }
const tag = (viewport: Viewport) => `${viewport.width}x${viewport.height}`
const CALLER_VIEWPORTS: Viewport[] = [{ width: 1440, height: 960 }, { width: 320, height: 480 }]
const FAULT_MESSAGE = 'FICTIONAL81 preview unavailable for this synthetic check'
const ALERT_SELECTORS = ['.dialog > .inline-note', '.dialog > .inline-note > button']
const isToggle = (stop: WalkStop) => stop.probe.active.tag === 'input' && (stop.probe.active.indicator.proxy ?? '').includes('toggle-track')
const asserted = (stop: WalkStop) => stop.judgement === 'asserted'
const FILTERS_PREPARATION = 'Preparation only: exploration flags seeded, explore view with an explicit fresh synthetic catalog (page route), filters opener focused with locator.focus() and Enter. The preview fault is a labeled synthetic transient error; the font doubling is the labeled authored-font fixture.'
/** Public label of the Filters count action while the preview has failed (rendered text, not product code). */
const COUNT_UNAVAILABLE = '공고 수 확인 필요'

/** The two Filters checkboxes by their distinct accessible names (their label text), in the dialog's native order. */
type ToggleIdentity = 'salary' | 'remote'
const TOGGLE_IDENTITIES: readonly ToggleIdentity[] = ['salary', 'remote']
const filtersDialog = (page: Page) => page.getByRole('dialog', { name: D2_LABEL.filtersDialog, exact: true })
const checkboxOf = (page: Page, identity: ToggleIdentity) => filtersDialog(page).getByRole('checkbox', { name: identity === 'salary' ? D2_LABEL.toggleSalaryUnknown : D2_LABEL.toggleRemoteOnly })

/**
 * Same-instant, read-only witness of one named checkbox: whether it is the
 * focused element, its own rendered toggle track rectangle and the rectangles of
 * the dialog's other toggle tracks, all read in one evaluation so no native
 * scroll stop lies between them. The track is the same adjacent `.toggle-track`
 * the D1 probe judges. Serialized by Playwright; self-contained on purpose.
 */
interface TrackWitness { focused: boolean; track: Rect | null; otherTracks: Rect[] }
const trackWitness = (page: Page, identity: ToggleIdentity) => checkboxOf(page, identity).evaluate((input): TrackWitness => {
  const round = (value: number) => Math.round(value * 100) / 100
  const toRect = (box: DOMRect): Rect => ({ left: round(box.left), top: round(box.top), right: round(box.right), bottom: round(box.bottom), width: round(box.width), height: round(box.height) })
  const row = input.parentElement
  const track = row && row.classList.contains('toggle-row') ? row.querySelector('.toggle-track') : null
  const dialog = input.closest('dialog[open]')
  const others = dialog ? Array.from(dialog.querySelectorAll('.toggle-row .toggle-track')).filter(candidate => candidate !== track) : []
  return { focused: input === document.activeElement, track: track ? toRect(track.getBoundingClientRect()) : null, otherTracks: others.map(other => toRect(other.getBoundingClientRect())) }
})

/** A judged toggle stop: proved identity, the probe's judged track rectangle, the same-instant witness, and the indicator kind the probe assessed. */
interface JudgedTrack { identity: ToggleIdentity; phase: string; judgedTrack: Rect; witness: TrackWitness; distinctFromOtherTrackAtSameInstant: boolean; indicator: string }

/**
 * Which accessible checkbox holds focus at this stop. The probe's descriptor and
 * name cannot tell the two toggles apart (each is a bare "input" inside its
 * label), so the identity is read from document.activeElement against each
 * accessible checkbox locator and proved with a read-only toBeFocused assertion
 * before it is recorded. The same evaluation witnesses that the focused
 * checkbox's own track is a rendered rectangle distinct from the other toggle
 * track at that instant. Rectangles recorded at different native scroll stops
 * are never compared with each other: separate controls can legitimately be
 * revealed to the same viewport edge. Nothing is focused or scrolled.
 */
async function provedCheckbox(page: Page, stop: WalkStop, phase: string, expected?: ToggleIdentity): Promise<JudgedTrack> {
  expect(isToggle(stop), `${phase}: the stop is a toggle track (reached ${stop.descriptor})`).toBe(true)
  const witnesses: { identity: ToggleIdentity; witness: TrackWitness }[] = []
  for (const identity of TOGGLE_IDENTITIES) witnesses.push({ identity, witness: await trackWitness(page, identity) })
  const focused = witnesses.filter(entry => entry.witness.focused)
  expect(focused.map(entry => entry.identity), `${phase}: exactly one of the two accessible checkboxes is focused`).toHaveLength(1)
  const { identity, witness } = focused[0]
  if (expected) expect(identity, `${phase}: the engaged checkbox`).toBe(expected)
  await expect(checkboxOf(page, identity), `${phase}: the ${identity} checkbox is focused`).toBeFocused()
  expect(witness.track !== null && witness.track.width > 0 && witness.track.height > 0, `${phase}: the ${identity} checkbox has a rendered track (${JSON.stringify(witness.track)})`).toBe(true)
  expect(witness.otherTracks.length, `${phase}: the other toggle track is rendered at the same instant`).toBeGreaterThanOrEqual(1)
  const distinct = witness.otherTracks.every(other => Math.abs(other.top - witness.track!.top) > 0.5 || Math.abs(other.left - witness.track!.left) > 0.5)
  expect(distinct, `${phase}: at the same instant the ${identity} track ${JSON.stringify(witness.track)} is a different rectangle from the other toggle track ${JSON.stringify(witness.otherTracks)}`).toBe(true)
  return { identity, phase, judgedTrack: stop.probe.active.rect, witness, distinctFromOtherTrackAtSameInstant: distinct, indicator: stop.probe.active.indicator.kind }
}

/**
 * From the engaged toggle to the inserted retry control through bounded native
 * Tab presses. Both toggles are enabled native stops rendered before the alert,
 * so from the salary toggle exactly the remote toggle lies in between and from
 * the remote toggle nothing does. Every intermediate stop is judged for
 * visibility and its checkbox identity is proved before the retry is accepted.
 */
async function tabToRetry(page: Page, walk: KeyboardWalk, phase: string, engaged: ToggleIdentity, tracks: JudgedTrack[]): Promise<WalkStop> {
  const expected: ToggleIdentity[] = engaged === 'salary' ? ['remote'] : []
  const seen: ToggleIdentity[] = []
  for (let presses = 1; presses <= expected.length + 1; presses++) {
    const stop = await walk.press('Tab', presses <= expected.length ? `${phase}-through-${expected[presses - 1]}-toggle` : phase, { screenshot: true })
    if (stop.name === D2_LABEL.recalc) {
      expect(seen, `${phase}: the enabled toggle stops passed between the ${engaged} toggle and the retry`).toEqual(expected)
      return stop
    }
    expect(presses <= expected.length, `${phase}: Tab ${presses} reached ${stop.name || stop.descriptor} instead of the retry; stops: ${walk.names().join(' → ')}`).toBe(true)
    const track = await provedCheckbox(page, stop, `${phase}-through`, expected[presses - 1])
    tracks.push(track)
    seen.push(track.identity)
  }
  throw new Error(`${walk.name}: ${phase}: the retry was not reached within ${expected.length + 1} Tab presses; stops: ${walk.names().join(' → ')}`)
}

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

test.describe.configure({ timeout: 150_000 })

for (const viewport of CALLER_VIEWPORTS) {
  test.describe(`filters dialog at ${tag(viewport)}`, () => {
    test.use({ viewport, hasTouch: viewport.width === 320, apiPolicy: 'catalog-reads' })

    test(`F-filters counts: every native stop and both toggle tracks stay visible, Space switches the literal count between 3 and 2, a transient preview error inserts the alert and retry without hiding the engaged toggle, the remote toggle is traversed on the way to the retry, recalculation restores 3, keyboard apply persists the excluding draft with count 2, and keyboard reset returns to 3 at ${tag(viewport)}`, async ({ page }, testInfo) => {
      await seedSavedWithoutClock(page, [])
      await openExploreFresh(page, { jobs: COUNT_CATALOG_JOBS })
      const first = await openFiltersByKeyboard(page)
      const countButton = () => filtersDialog(page).getByRole('button', { name: D2_LABEL.countButton })
      const salaryToggle = () => checkboxOf(page, 'salary')
      const alert = () => filtersDialog(page).getByRole('alert')
      await expect(countButton(), 'the default draft counts every posting of the explicit catalog').toHaveText(COUNT_EXPECTED.all)
      await expect(salaryToggle(), 'the include-undisclosed toggle starts on').toBeChecked()
      const walk = new KeyboardWalk(page, testInfo, `filters-counts-${tag(viewport)}`, {
        contract: D2_CONTRACT, row: '필터/토글', requirements: ['requirement 1', 'requirement 2', 'requirement 4', 'requirement 7'], viewport, preparation: FILTERS_PREPARATION,
        catalog: COUNT_CATALOG_JOBS.map(job => ({ id: job.id, salary: job.salary })), expectation: 'public toggle behaviour: all three postings count by default; excluding undisclosed salaries removes the one posting without a disclosed salary',
        measurement: 'Tab from Close to the first toggle (proved to be the salary checkbox); Space (2); Space under the fault (alert, toggle keeps focus); Tab through the remote toggle (judged, proved) to the retry; Enter after the fault is removed (3); Tab on to the salary toggle again (proved), Space (2), Tab to the remote toggle (judged, proved), Tab through the reset action to the count action; Enter applies and closes; reopen (2, toggle off); Tab to the reset action; Enter (3, toggle on); Tab to the count action; Enter applies and closes. Toggle identity is never read from the diagnostic tag string, which is "input" for both.',
      })
      const counts: { phase: string; text: string }[] = []
      const tracks: JudgedTrack[] = []
      const recordCount = async (phase: string) => { await expect(countButton()).toBeVisible(); counts.push({ phase, text: (await countButton().textContent())?.trim() ?? '' }) }
      try {
        const initial = await walk.observe('initial-close', null, { screenshot: true })
        expect(initial.name).toBe(LABEL.close)
        await recordCount('initial')
        const firstToggle = await walkUntil(walk, 'Tab', 'forward', isToggle, 40, { screenshot: true })
        // The first toggle in native order is the salary checkbox; its identity is proved read-only before it is recorded.
        tracks.push(await provedCheckbox(page, firstToggle, 'first-toggle', 'salary'))
        await pressKey(page, 'Space')
        await walk.observe('after-space-exclude', 'Space', { screenshot: true })
        await expect(salaryToggle()).not.toBeChecked()
        await expect(countButton()).toHaveText(COUNT_EXPECTED.disclosedOnly)
        await recordCount('after-space-exclude')
        const fault = await installPreviewFault(page, FAULT_MESSAGE)
        await pressKey(page, 'Space')
        await expect(alert()).toContainText(FAULT_MESSAGE)
        await settleLayout(page, 'after the alert was inserted')
        const engaged = await walk.observe('already-focused-after-alert', 'alert-inserted', { screenshot: true })
        expect(isToggle(engaged), 'the toggle keeps focus while the alert is inserted').toBe(true)
        await expect(salaryToggle()).toBeChecked()
        const beside = await provedCheckbox(page, engaged, 'engaged-beside-alert', 'salary')
        // The remote toggle is an enabled native stop between the engaged salary toggle and the inserted retry: traversed and judged, never skipped.
        const retry = await tabToRetry(page, walk, 'forward-to-retry', beside.identity, tracks)
        expect(retry.name).toBe(D2_LABEL.recalc)
        await fault.restore()
        await pressKey(page, 'Enter')
        await expect(alert()).toHaveCount(0)
        await expect(countButton()).toHaveText(COUNT_EXPECTED.all)
        await recordCount('after-recalculation')
        await settleLayout(page, 'after the recalculation')
        // The retry control removed itself with the alert; the next Tab resumes the dialog's order at a visible stop.
        await walk.press('Tab', 'forward-after-recalc', { screenshot: true })
        const again = await walkUntil(walk, 'Tab', 'forward-to-first-toggle-again', isToggle, 40)
        await provedCheckbox(page, again, 'first-toggle-again', 'salary')
        await pressKey(page, 'Space')
        await walk.observe('after-space-exclude-again', 'Space')
        await expect(countButton()).toHaveText(COUNT_EXPECTED.disclosedOnly)
        await recordCount('after-space-exclude-again')
        const secondToggle = await walk.press('Tab', 'forward-to-second-toggle', { screenshot: true })
        tracks.push(await provedCheckbox(page, secondToggle, 'second-toggle', 'remote'))
        const reset = await walk.press('Tab', 'forward-into-footer', { screenshot: true })
        expect(reset.name).toBe(D2_LABEL.filtersReset)
        const apply = await walk.press('Tab', 'forward-footer-count', { screenshot: true })
        expect(apply.name, 'the count action shows the excluding draft').toBe(COUNT_EXPECTED.disclosedOnly)
        await pressKey(page, 'Enter')
        await expect(first.dialog).toHaveCount(0)
        await expect(first.opener, 'applying closes the dialog and returns to the opener').toBeFocused()
        const second = await openFiltersByKeyboard(page)
        await expect(salaryToggle(), 'the applied draft persists: the toggle stays off').not.toBeChecked()
        await expect(countButton()).toHaveText(COUNT_EXPECTED.disclosedOnly)
        await recordCount('reopened-applied')
        const reopened = await walk.observe('reopened-close', 'reopen', { screenshot: true })
        expect(reopened.name).toBe(LABEL.close)
        const resetAgain = await walkUntil(walk, 'Tab', 'forward-to-reset', stop => stop.name === D2_LABEL.filtersReset, 40, { screenshot: true })
        expect(resetAgain.name).toBe(D2_LABEL.filtersReset)
        await pressKey(page, 'Enter')
        await expect(salaryToggle(), 'reset restores the default draft').toBeChecked()
        await expect(countButton()).toHaveText(COUNT_EXPECTED.all)
        await recordCount('after-reset')
        await walk.observe('reset-after-enter', 'Enter', { screenshot: true })
        const applyAll = await walk.press('Tab', 'forward-footer-count-after-reset', { screenshot: true })
        expect(applyAll.name).toBe(COUNT_EXPECTED.all)
        await pressKey(page, 'Enter')
        await expect(second.dialog).toHaveCount(0)
        await expect(second.opener).toBeFocused()
      } finally {
        await walk.attach({ counts, tracks })
      }

      expect(walk.stops.every(asserted)).toBe(true)
      expect(walk.failures(), `every filters stop is visible, including both toggle tracks, the engaged toggle beside the inserted alert, the remote toggle on the way to the retry and the footer actions (see the ${walk.name}-stops attachment)`).toEqual([])
      // Two distinct accessible checkboxes were judged, each by a proved identity; at each judged stop the focused checkbox's own track was a rendered
      // rectangle distinct from the other toggle track at that same instant. Rectangles recorded at different native scroll stops are never compared.
      const judged = tracks.filter(track => track.phase === 'first-toggle' || track.phase === 'second-toggle')
      expect(judged.map(track => track.identity), 'both toggle tracks were judged in native order').toEqual(['salary', 'remote'])
      expect(judged.map(track => track.indicator), 'each toggle was judged by its rendered track indicator').toEqual(['toggle-track', 'toggle-track'])
      expect(judged.map(track => track.distinctFromOtherTrackAtSameInstant), 'each judged track was a rectangle distinct from the other toggle track at the same instant').toEqual([true, true])
      expect(tracks.filter(track => track.phase.endsWith('-through')).map(track => track.identity), 'the remote toggle was traversed and judged on the way to the retry').toEqual(['remote'])
      expect(counts.map(entry => entry.text), 'the literal count sequence').toEqual([
        COUNT_EXPECTED.all, COUNT_EXPECTED.disclosedOnly, COUNT_EXPECTED.all, COUNT_EXPECTED.disclosedOnly, COUNT_EXPECTED.disclosedOnly, COUNT_EXPECTED.all,
      ])
    })

    test(`F-filters 200%: a later-inserted alert reads back at exactly 2× its own 100% references, the filters footer grows with whole labels and no overflow in its error and result states, and the engaged toggle, the traversed remote toggle and the retry stay visible under the grown fonts at ${tag(viewport)}`, async ({ page }, testInfo) => {
      await seedSavedWithoutClock(page, [])
      await openExploreFresh(page, { jobs: COUNT_CATALOG_JOBS })
      const { dialog, opener } = await openFiltersByKeyboard(page)
      const alert = dialog.getByRole('alert')
      const countButton = dialog.getByRole('button', { name: D2_LABEL.countButton })
      const walk = new KeyboardWalk(page, testInfo, `filters-200pct-${tag(viewport)}`, {
        contract: D2_CONTRACT, row: '필터/토글 · 실제200% 작성 글꼴', requirements: ['requirement 1', 'requirement 2', 'requirement 4'], viewport, preparation: FILTERS_PREPARATION,
        measurement: 'At 100%: Tab to the first toggle (proved to be the salary checkbox), Space under the fault, record the alert references, Tab through the remote toggle (judged, proved) to the retry, Enter after removing the fault (2). Double the fonts; Tab to the first toggle again (proved); Space under the fault; apply the alert references and read back; audit the grown footer in its error state; Tab through the remote toggle (judged, proved) to the retry; Enter (3); audit the grown footer in its result state.',
      })
      let alertReferences: FontReference[] = []
      let alertReadback: string[] | null = null
      let verification: Awaited<ReturnType<typeof verifyFonts>> | null = null
      let footerBefore: number | null = null
      let footerAfter: number | null = null
      const tracks: JudgedTrack[] = []
      const audits: Record<string, OverflowAudit> = {}
      try {
        const initial = await walk.observe('initial-close')
        expect(initial.name).toBe(LABEL.close)
        const toggle100 = await walkUntil(walk, 'Tab', 'forward', isToggle, 40)
        const engaged100 = await provedCheckbox(page, toggle100, 'toggle-100pct', 'salary')
        tracks.push(engaged100)
        let fault = await installPreviewFault(page, FAULT_MESSAGE)
        await pressKey(page, 'Space')
        await expect(alert).toContainText(FAULT_MESSAGE)
        await settleLayout(page, 'alert at 100%')
        alertReferences = await fontReferences(page, ALERT_SELECTORS)
        const beside100 = await walk.observe('already-focused-after-alert-100pct', 'alert-inserted')
        await provedCheckbox(page, beside100, 'engaged-beside-alert-100pct', engaged100.identity)
        // The remote toggle lies between the engaged salary toggle and the inserted retry at 100% as well: traversed and judged.
        const retry = await tabToRetry(page, walk, 'forward-to-retry-100pct', engaged100.identity, tracks)
        expect(retry.name).toBe(D2_LABEL.recalc)
        await fault.restore()
        await pressKey(page, 'Enter')
        await expect(alert).toHaveCount(0)
        await expect(countButton, 'the recalculation at 100% shows the literal count of the excluding draft').toHaveText(COUNT_EXPECTED.disclosedOnly)
        await settleLayout(page, 'after the recalculation at 100%')
        footerBefore = (await footerState(page)).rect?.height ?? null
        await snapshotFonts(page)
        await doubleFonts(page)
        await settleLayout(page, 'after doubling the authored fonts')
        verification = await verifyFonts(page)
        footerAfter = (await footerState(page)).rect?.height ?? null
        await pressKey(page, 'Tab')
        await walk.observe('resumed-after-font-growth', 'Tab', { screenshot: true })
        const toggle200 = await walkUntil(walk, 'Tab', 'forward-under-grown-footer', isToggle, 40, { screenshot: true })
        const engaged200 = await provedCheckbox(page, toggle200, 'toggle-200pct', 'salary')
        tracks.push(engaged200)
        fault = await installPreviewFault(page, FAULT_MESSAGE)
        await pressKey(page, 'Space')
        await expect(alert).toContainText(FAULT_MESSAGE)
        await applyFontReferences(page, alertReferences)
        await settleLayout(page, 'alert after applying its 2× references')
        alertReadback = fontReferenceMismatches(alertReferences, await fontReferences(page, ALERT_SELECTORS))
        // Grown footer in the error state: the reset action and the count action's unavailable label, audited read-only for overflow and whole labels.
        audits['error-200pct'] = await overflowAudit(page)
        const beside200 = await walk.observe('already-focused-after-alert-200pct', 'alert-inserted', { screenshot: true })
        await provedCheckbox(page, beside200, 'engaged-beside-alert-200pct', engaged200.identity)
        // The 200% error phase uses the actually engaged toggle's position: the remote toggle is traversed and judged before the retry.
        const retryAgain = await tabToRetry(page, walk, 'forward-to-retry-200pct', engaged200.identity, tracks)
        expect(retryAgain.name).toBe(D2_LABEL.recalc)
        await fault.restore()
        await pressKey(page, 'Enter')
        await expect(alert).toHaveCount(0)
        await expect(countButton, 'the recalculation under the grown fonts shows the literal count of the default draft').toHaveText(COUNT_EXPECTED.all)
        await settleLayout(page, 'after the recalculation at 200%')
        // Grown footer in the result state: the reset action and the literal count label, audited read-only for overflow and whole labels.
        audits['result-200pct'] = await overflowAudit(page)
      } finally {
        await walk.attach({ alertReferences, alertReadback, verification, footerBefore, footerAfter, tracks, audits })
      }

      expect(walk.stops.every(asserted)).toBe(true)
      expect(walk.failures(), `every stop is visible at 100% and under the grown fonts, including the remote toggle traversed before each retry (see the ${walk.name}-stops attachment)`).toEqual([])
      expect(alertReferences.every(reference => reference.sizes.length > 0), 'the alert and its retry were rendered at 100% for their references').toBe(true)
      expect(alertReadback, 'the later-inserted alert reads back at exactly 2× its 100% references').toEqual([])
      expect(verification?.mismatches, 'every recorded element reads back at exactly 2× its 100% size').toEqual([])
      expect(footerAfter ?? 0, `the filters footer grew (before ${footerBefore}px)`).toBeGreaterThan((footerBefore ?? 0) + 0.5)
      expect(tracks.filter(track => track.phase.endsWith('-through')).map(track => track.identity), 'the remote toggle was traversed and judged before the retry at 100% and under the grown fonts').toEqual(['remote', 'remote'])
      expectFooterWhole(audits['error-200pct'] ?? null, 'the grown filters footer in the error state', [D2_LABEL.filtersReset, COUNT_UNAVAILABLE])
      expectFooterWhole(audits['result-200pct'] ?? null, 'the grown filters footer in the result state', [D2_LABEL.filtersReset, COUNT_EXPECTED.all])

      await page.keyboard.press('Escape')
      await expect(dialog).toHaveCount(0)
      await expect(opener, 'requirement 7: Escape returns focus to the opener').toBeFocused()
    })
  })

  test.describe(`profile dialog (footerless) at ${tag(viewport)}`, () => {
    test.use({ viewport, hasTouch: viewport.width === 320 })

    test(`P-profile: the clipped file input is not a Tab stop, Enter on the visible upload button opens the chooser and imports, the label path still imports, there is no spacer and no needless scroll, and the years error focus stays visible in the renamed step-two dialog at ${tag(viewport)}`, async ({ page }, testInfo) => {
      await seedSavedWithoutClock(page, [LANTERN])
      await openSavedViewPlain(page, [LANTERN.job.title])
      const { dialog, opener } = await openProfileByKeyboard(page)
      const resume = dialog.getByRole('textbox', { name: /읽어온 경력|경력 요약/ })
      // Analyze renames the dialog (its title is the accessible name), so the step-one locator matches nothing afterwards.
      // The step-two dialog is bound by its own exact name and owns the alert, the years field and the post-Escape absence check.
      const step2 = page.getByRole('dialog', { name: D2_LABEL.profileDialogStep2, exact: true })
      const yearsField = step2.getByLabel(D2_LABEL.years, { exact: true })
      const walk = new KeyboardWalk(page, testInfo, `profile-${tag(viewport)}`, {
        contract: D2_CONTRACT, row: 'footer 없는 Profile/Data', requirements: ['requirement 1', 'requirement 2', 'requirement 7', 'requirement 8'], viewport,
        preparation: 'Preparation only: saved view load, profile opener focused with locator.focus() and Enter; the synthetic resume text is supplied through the native file chooser opened by Enter and then through the labeled file input.',
        measurement: 'Tab from Close through the three input tabs to the visible upload button; Enter opens the chooser; label import; Tab to the analyze action; Enter (the dialog is renamed to step two and bound by that name); Tab to the years field; type 99; Tab to the submit action; Enter; observe the error focus. Every stop is judged.',
      })
      let audit: SpacerAudit | null = null
      let chooserFileAccepted = false
      let labelImportAccepted = false
      let topScrollTops: number[] = []
      try {
        const initial = await walk.observe('initial-close', null, { screenshot: true })
        expect(initial.name).toBe(LABEL.close)
        const tabs = [await walk.press('Tab', 'forward-tabs'), await walk.press('Tab', 'forward-tabs'), await walk.press('Tab', 'forward-tabs')]
        expect(tabs.map(stop => stop.name)).toEqual([D2_LABEL.profileTabFile, D2_LABEL.profileTabText, D2_LABEL.profileTabLinkedIn])
        const upload = await walk.press('Tab', 'forward-upload-button', { screenshot: true })
        expect(upload.probe.active.tag, `the stop after the LinkedIn tab is the visible upload button, not the clipped file input (reached ${upload.descriptor})`).toBe('button')
        expect(D2_LABEL.uploadZone.test(upload.name), `upload button name: ${upload.name}`).toBe(true)
        topScrollTops = walk.stops.map(stop => stop.probe.dialog?.scrollTop ?? Number.NaN)
        audit = await spacerAudit(page)
        const chooser = page.waitForEvent('filechooser')
        await page.keyboard.press('Enter')
        await (await chooser).setFiles({ name: 'resume81.txt', mimeType: 'text/plain', buffer: Buffer.from(RESUME_TEXT) })
        chooserFileAccepted = true
        await expect(resume).toHaveValue(RESUME_TEXT)
        await dialog.getByLabel(D2_LABEL.hiddenFileInput, { exact: true }).setInputFiles({ name: 'resume81-second.txt', mimeType: 'text/plain', buffer: Buffer.from(`${RESUME_TEXT} Second import.`) })
        await expect(resume).toHaveValue(`${RESUME_TEXT} Second import.`)
        labelImportAccepted = true
        await settleLayout(page, 'after both imports')
        const analyze = await walkUntil(walk, 'Tab', 'forward-to-analyze', stop => stop.name === D2_LABEL.analyze, 20, { screenshot: true })
        expect(analyze.probe.active.disabled, 'the analyze action is enabled after the import').toBe(false)
        await page.keyboard.press('Enter')
        await expect(step2, 'Analyze moves the dialog to step two under its new accessible name').toBeVisible()
        await expect(dialog, 'the step-one name matches no dialog once it is renamed; it is not reused below').toHaveCount(0)
        await settleLayout(page, 'after moving to step 2')
        await walk.press('Tab', 'step2-first-tab', { screenshot: true })
        const years = await walkUntil(walk, 'Tab', 'forward-to-years', stop => stop.name === D2_LABEL.years, 20, { screenshot: true })
        expect(years.probe.active.tag).toBe('input')
        await page.keyboard.type('99')
        const submit = await walkUntil(walk, 'Tab', 'forward-to-submit', stop => stop.name === D2_LABEL.submitProfile, 30, { screenshot: true })
        expect(submit.name).toBe(D2_LABEL.submitProfile)
        await page.keyboard.press('Enter')
        await expect(step2.getByRole('alert'), 'the years error is announced inside the step-two dialog').toContainText(D2_LABEL.yearsError)
        await settleLayout(page, 'after the years error')
        const errorFocus = await walk.observe('error-focus', 'Enter', { screenshot: true })
        expect(errorFocus.name, 'the existing error handling moves focus to the invalid years field').toBe(D2_LABEL.years)
        expect(errorFocus.probe.active.value).toBe('99')
      } finally {
        await walk.attach({ audit, chooserFileAccepted, labelImportAccepted, topScrollTops })
      }

      expect(walk.stops.every(asserted)).toBe(true)
      expect(walk.failures(), `every profile stop is visible, including the error focus (see the ${walk.name}-stops attachment)`).toEqual([])
      expect(walk.stops.some(stop => stop.descriptor.includes('sr-only')), 'no stop is the clipped file input').toBe(false)
      expect(audit?.hasFooter, 'the profile dialog has no footer').toBe(false)
      expect(audit?.paddingBottom, 'no bottom padding is added to the footerless dialog').toBe('0px')
      expect(audit?.afterContent, 'no generated spacer follows the content').toBe('none')
      expect(Math.abs(audit?.gap ?? Number.NaN), `the scrolled content ends with the last rendered child (gap ${audit?.gap}px)`).toBeLessThanOrEqual(1)
      expect(topScrollTops.every(value => Math.abs(value) <= 0.5), `traversing the first visible controls needs no scroll: ${topScrollTops.join(', ')}`).toBe(true)
      expect(chooserFileAccepted && labelImportAccepted).toBe(true)
      await expect(yearsField, 'the step-two years field is marked invalid').toHaveAttribute('aria-invalid', 'true')
      await expect(yearsField, 'the invalid years field keeps the literal 99').toHaveValue('99')
      await expect(yearsField, 'the invalid years field is the focused control').toBeFocused()

      await page.keyboard.press('Escape')
      await expect(step2, 'Escape closes the step-two dialog').toHaveCount(0)
      await expect(page.getByRole('dialog'), 'no dialog remains open').toHaveCount(0)
      await expect(opener, 'requirement 7: Escape returns focus to the opener').toBeFocused()
      expect((await readCommitted(page))[0], 'the profile dialog changes no saved record').toMatchObject(literalOf(LANTERN))
    })
  })
}

test.describe('data dialog (footerless) at 320x480', () => {
  test.use({ viewport: { width: 320, height: 480 }, hasTouch: true })

  test('D-data: every native stop stays visible with no spacer and no footer, and Escape returns to the opener', async ({ page }, testInfo) => {
    await seedSavedWithoutClock(page, [LANTERN])
    await openSavedViewPlain(page, [LANTERN.job.title])
    const { dialog, opener } = await openDataByKeyboard(page)
    const walk = new KeyboardWalk(page, testInfo, 'data-320x480', {
      contract: D2_CONTRACT, row: 'footer 없는 Profile/Data', requirements: ['requirement 1', 'requirement 2', 'requirement 7', 'requirement 8'], viewport: { width: 320, height: 480 },
      preparation: 'Preparation only: saved view load, data opener focused with locator.focus() and Enter. The observation disclosure is traversed, never opened, so no request is made.',
      measurement: 'Tab from Close until Close returns, then one Shift+Tab wrap. Every stop is judged.',
    })
    let audit: SpacerAudit | null = null
    try {
      const initial = await walk.observe('initial-close', null, { screenshot: true })
      expect(initial.name).toBe(LABEL.close)
      audit = await spacerAudit(page)
      for (let presses = 1; ; presses++) {
        const stop = await walk.press('Tab', 'forward', { screenshot: true })
        if (stop.name === LABEL.close) break
        if (presses >= 40) throw new Error(`${walk.name}: Tab did not return to Close within 40 presses; stops: ${walk.names().join(' → ')}`)
      }
      const wrap = await walk.press('Shift+Tab', 'backward-wrap', { screenshot: true })
      expect(wrap.name, 'Shift+Tab from Close wraps to the last control').not.toBe(LABEL.close)
    } finally {
      await walk.attach({ audit })
    }

    expect(walk.stops.length, 'the data dialog exposes controls beyond Close').toBeGreaterThanOrEqual(4)
    expect(walk.stops.every(asserted)).toBe(true)
    expect(walk.failures(), `every data dialog stop is visible (see the ${walk.name}-stops attachment)`).toEqual([])
    expect(audit?.hasFooter, 'the data dialog has no footer').toBe(false)
    expect(audit?.paddingBottom).toBe('0px')
    expect(audit?.afterContent).toBe('none')
    expect(Math.abs(audit?.gap ?? Number.NaN), `the scrolled content ends with the last rendered child (gap ${audit?.gap}px)`).toBeLessThanOrEqual(1)

    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await expect(opener, 'requirement 7: Escape returns focus to the opener').toBeFocused()
  })
})
