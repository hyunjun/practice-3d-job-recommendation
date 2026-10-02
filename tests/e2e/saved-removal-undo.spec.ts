/**
 * Stage80 removal recovery inside the native saved detail (D2 contract).
 * These are the four frozen baseline reproductions, upgraded to final behavior:
 * the recovery must be operable inside the still-open modal by real Tab/Enter
 * and by pointer, and well past the old 7 s toast lifetime the same-job footer
 * action must restore the exact original (note, applied status, savedAt, job,
 * company) instead of saving a blank record. Expected values are literal
 * fixture values plus equality with the record the application itself had
 * committed before the removal; no product function computes an expectation.
 * The footer toggle is located by its stable position so a label change alone
 * can never masquerade as the recovery defect; D2 labels are asserted separately.
 */
import { expect } from '@playwright/test'
import type { Locator, Page, TestInfo } from '@playwright/test'
import type { SavedJob } from '../../shared/types'
import { waitForSavedCommit } from './helpers/saved-store'
import {
  EMBER, EMBER_NOTE, PAST_OLD_TOAST_LIFETIME_MS, appliedMarker, attachShot, closeButton, committedById, dialogOf, expectAbsentFromStorage,
  expectCommittedExactly, expectRegionInsideDialog, expectVisibleFocus, footerButtons, footerToggle, literalOf, navCount, noteField,
  openDetailByKeyboard, openSavedView, pressTabUntil, recoveryEntry, recoveryRegion, seedSaved, test, undoOf,
} from './helpers/saved-removal-undo'

/** Seed the single original, open its detail from the saved view and verify the literal starting state. */
async function openOriginalDetail(page: Page) {
  await seedSaved(page, [EMBER])
  await openSavedView(page, [EMBER.job.title])
  await expect(page.locator('.saved-card .saved-status')).toHaveText('지원 완료')
  const committedBeforeRemoval = await committedById(page, EMBER.job.id)
  expect(committedBeforeRemoval).toMatchObject(literalOf(EMBER))
  const dialog = await openDetailByKeyboard(page, EMBER)
  await expect(noteField(dialog)).toHaveValue(EMBER_NOTE)
  await expect(appliedMarker(dialog)).toBeVisible()
  await expect(footerButtons(dialog)).toHaveCount(1)
  await expect(footerToggle(dialog)).toBeEnabled()
  await expect(footerToggle(dialog)).toHaveText('저장 목록에서 제거')
  return { dialog, committedBeforeRemoval: committedBeforeRemoval! }
}

/** Remove through the actual footer action (pointer) and keep the native dialog open. */
async function removeInsideDetail(page: Page, dialog: Locator) {
  await footerToggle(dialog).click()
  await waitForSavedCommit(page)
  await expectAbsentFromStorage(page, EMBER.job.id)
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole('heading', { name: EMBER.job.title, exact: true })).toBeVisible()
  await expect(noteField(dialog)).toHaveCount(0)
  await expect(navCount(page)).toHaveCount(0)
  // The same-job footer action now offers the original back instead of a blank save.
  await expect(footerToggle(dialog)).toHaveText('제거 취소')
}

async function expectOriginalRestored(page: Page, dialog: Locator, committedBeforeRemoval: SavedJob) {
  await waitForSavedCommit(page)
  await expectCommittedExactly(page, EMBER, committedBeforeRemoval)
  await expect(dialog).toBeVisible()
  await expect(noteField(dialog)).toHaveValue(EMBER_NOTE)
  await expect(appliedMarker(dialog)).toBeVisible()
  await expect(footerToggle(dialog)).toHaveText('저장 목록에서 제거')
  await expect(navCount(page).first()).toHaveText('1')
  // A settled recovery leaves no candidate behind.
  await expect(recoveryRegion(page)).toHaveCount(0)
}

/** Evidence about where every Undo control lives relative to the open modal; attachment only. */
async function attachRecoveryAudit(page: Page, testInfo: TestInfo, name: string) {
  const audit = await page.evaluate(() => {
    const dialog = document.querySelector('dialog[open]')
    const describe = (element: Element | null) => element
      ? `${element.tagName.toLowerCase()}${Array.from(element.classList).map(name => `.${name}`).join('')}`
      : null
    const undoButtons = [...document.querySelectorAll('button')].filter(button => button.textContent?.trim() === '실행 취소')
    return {
      modalOpen: Boolean(dialog),
      toasts: [...document.querySelectorAll('.toast')].map(toast => toast.textContent),
      undoButtons: undoButtons.map(button => {
        const rect = button.getBoundingClientRect()
        const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
        return {
          insideOpenDialog: Boolean(dialog?.contains(button)),
          hitTestTarget: describe(hit), hitTestReachesButton: hit === button || button.contains(hit),
          rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        }
      }),
      activeElement: describe(document.activeElement),
    }
  })
  await testInfo.attach(name, { body: JSON.stringify(audit, null, 2), contentType: 'application/json' })
}

for (const viewport of [{ width: 1440, height: 960 }, { width: 320, height: 800 }]) {
  test.describe(`removal recovery inside the native saved detail at ${viewport.width}px`, () => {
    test.use({ viewport, hasTouch: viewport.width === 320 })

    test('an operable Undo inside the still-open detail restores the exact original record by keyboard', async ({ page }, testInfo) => {
      const { dialog, committedBeforeRemoval } = await openOriginalDetail(page)
      await removeInsideDetail(page, dialog)
      await attachRecoveryAudit(page, testInfo, `recovery-controls-after-removal-${viewport.width}`)
      await expectRegionInsideDialog(page, dialog)
      const entry = recoveryEntry(dialog, EMBER)
      await expect(entry.getByText('최근 제거', { exact: true })).toBeVisible()
      await expect(entry.getByText(/^지원 완료 · .+ 저장$/)).toBeVisible()
      await expect(entry.getByLabel('원래 메모', { exact: true })).toContainText('PRIVATE-UNDO80 ask about the Ember runtime team before applying')

      // Removal never steals focus: the footer action that was activated keeps it.
      await expect(footerToggle(dialog)).toBeFocused()
      // Real keyboard travel from the footer, around the modal's own Tab cycle, to the Undo.
      const undo = undoOf(entry)
      await expect(undo).toBeVisible()
      await expect(undo).toBeEnabled()
      const presses = await pressTabUntil(page, undo, { max: 4 })
      await testInfo.attach(`tab-presses-to-undo-${viewport.width}`, { body: JSON.stringify({ presses }), contentType: 'application/json' })
      await expectVisibleFocus(undo)
      await attachShot(page, testInfo, `in-dialog-undo-focus-${viewport.width}`)
      await page.keyboard.press('Enter')

      await expectOriginalRestored(page, dialog, committedBeforeRemoval)
      // The focused action disappeared with the settled recovery: neutral Close takes focus.
      await expectVisibleFocus(closeButton(dialog), false)
      await attachShot(page, testInfo, `in-dialog-restored-${viewport.width}`)
    })

    test('a pointer activation of the in-modal Undo restores the exact original and leaves focus on the neutral Close', async ({ page }, testInfo) => {
      const { dialog, committedBeforeRemoval } = await openOriginalDetail(page)
      await removeInsideDetail(page, dialog)
      await expectRegionInsideDialog(page, dialog)
      const undo = undoOf(recoveryEntry(dialog, EMBER))
      await expect(undo).toBeEnabled()
      await undo.click()
      await expectOriginalRestored(page, dialog, committedBeforeRemoval)
      await expectVisibleFocus(closeButton(dialog), false)
      await attachShot(page, testInfo, `in-dialog-pointer-restored-${viewport.width}`)
    })

    test('well past the old 7 s toast lifetime, the same-job footer action restores the original instead of saving a blank record', async ({ page }, testInfo) => {
      const { dialog, committedBeforeRemoval } = await openOriginalDetail(page)
      await removeInsideDetail(page, dialog)
      await attachRecoveryAudit(page, testInfo, `recovery-controls-before-timeout-${viewport.width}`)

      await page.clock.fastForward(PAST_OLD_TOAST_LIFETIME_MS)
      await attachRecoveryAudit(page, testInfo, `recovery-controls-after-timeout-${viewport.width}`)
      await expect(dialog).toBeVisible()
      await expect(recoveryEntry(dialog, EMBER)).toBeVisible()
      await expect(footerToggle(dialog)).toHaveText('제거 취소')
      await footerToggle(dialog).click()
      await waitForSavedCommit(page)
      await testInfo.attach(`committed-after-footer-action-${viewport.width}`, {
        body: JSON.stringify(await committedById(page, EMBER.job.id), null, 2), contentType: 'application/json',
      })
      await expectOriginalRestored(page, dialog, committedBeforeRemoval)
      await attachShot(page, testInfo, `footer-alias-restored-${viewport.width}`)
    })

    test('the same-job footer alias is reachable by keyboard after the old timeout and restores the original on Enter', async ({ page }, testInfo) => {
      const { dialog, committedBeforeRemoval } = await openOriginalDetail(page)
      await removeInsideDetail(page, dialog)
      await page.clock.fastForward(PAST_OLD_TOAST_LIFETIME_MS)
      // Start from the modal's first control and travel forward through the whole dialog to the footer alias.
      await closeButton(dialog).focus()
      await expect(closeButton(dialog)).toBeFocused()
      const presses = await pressTabUntil(page, footerToggle(dialog), { max: 60 })
      await testInfo.attach(`tab-presses-to-footer-alias-${viewport.width}`, { body: JSON.stringify({ presses }), contentType: 'application/json' })
      await expectVisibleFocus(footerToggle(dialog))
      await expect(footerToggle(dialog)).toHaveText('제거 취소')
      await page.keyboard.press('Enter')
      await expectOriginalRestored(page, dialog, committedBeforeRemoval)
      // The alias stays connected as the saved-state toggle, so focus remains on it.
      await expectVisibleFocus(footerToggle(dialog))
      await expect(dialogOf(page, EMBER)).toBeVisible()
    })
  })
}
