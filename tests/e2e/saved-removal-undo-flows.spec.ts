/**
 * Stage80 D2 recovery flows: the two bounded candidates (복구 대기 P and 최근 제거 L),
 * admission guards, asynchronous storage failure and retry, same-ID collisions,
 * generations, hosts in every modal and view, persistence and the company-list
 * restore alias. Every expectation is a literal fixture value, a user-visible
 * string from the approved contract, or equality with the record the application
 * itself had committed before a removal. Real IndexedDB is read for every record.
 */
import { expect } from '@playwright/test'
import type { Locator, Page } from '@playwright/test'
import { waitForSavedCommit, readSaved } from './helpers/saved-store'
import { dispatchReturn, overrideVisibility, readCommitted } from './helpers/saved-lifecycle'
import { expectInitialCatalogRequest } from './helpers/api-requests'
import { savedPageRecords } from './helpers/saved-pages'
import {
  CINDER, EMBER, EMBER_NOTE, EXPLORE_CLOCK, NEWER_EMBER, OTHER_TAB, RECOVERY_SCOPE_NOTE, attachShot, cardOf, cardRemoveButton, closeButton, committedById,
  deleteExternalEntry, dismissOf, entryName, expectAbsentFromStorage, expectCommittedExactly, expectEntryKind, expectNativeCompletions,
  expectRegionBeforeSavedGrid, expectRegionInsideDialog, expectRegionInsideResultsPanel, footerToggle, holdCompletionDelivery, installStoreFault,
  latestEntryOf, literalOf, messageOf, navCount, noteField, openDetailByKeyboard, openSavedView, pendingEntryOf, pressTabUntil, recoveryEntry,
  recoveryRegion, removeCardByKeyboard, removeCardNoWait, retryOf, seedSaved, test, titleButton, undoOf, writeDamagedEntry, writeExternalEntry,
} from './helpers/saved-removal-undo'

const LIMIT_HELP = '최대 500개까지 저장할 수 있어요. CSV로 내보낸 뒤 정리해 주세요.'
const UNREADABLE_HELP = '이 공고의 기존 기록을 읽을 수 없어 원본을 그대로 보관했어요.'
const NOOP_MESSAGE = '현재 목록에 같은 공고가 있어요. 원래 기록의 저장 완료는 확인하지 못했어요. 현재 기록을 확인한 뒤 다시 시도해 주세요.'
const CONFLICT_MESSAGE = '다른 내용의 기록이 먼저 저장돼 원래 메모를 복구하지 않았어요. 현재 기록을 확인하고 제거한 뒤 복구를 다시 시도해 주세요.'
const REREMOVED_MESSAGE = '현재 기록을 다시 제거했어요. 원래 기록은 복구 대기에 남아 있어요. 복구를 다시 시도해 주세요.'
const WAITING_FOR_COMMIT = '원래 기록의 저장 완료를 확인하고 있어요.'
const WAITING_WITH_STORAGE_FAILURE = '원래 기록은 보관 중이에요. 저장소 안내의 ‘저장 다시 시도’로 계속할 수 있어요.'
const UNSAVED_CHANGES = '아직 저장하지 못한 변경이 있어요.'
const blockedMessage = (removed: typeof EMBER, pending: typeof EMBER) =>
  `${removed.company.name}의 공고를 저장 목록에서 제거했어요. 먼저 ${entryName(pending)}의 복구를 완료하거나 복구 안내를 닫아 주세요.`
const removedMessage = (record: typeof EMBER) => `${record.company.name}의 공고를 저장 목록에서 제거했어요.`

/** Kind-first lookups when the test only cares which slot (P or L) an article occupies. */
const pendingEntry = (scope: Page | Locator) => recoveryRegion(scope).getByRole('article').filter({ hasText: '복구 대기' })
const latestEntry = (scope: Page | Locator) => recoveryRegion(scope).getByRole('article').filter({ hasText: '최근 제거' })
const storageRetry = (scope: Page | Locator) => scope.getByRole('button', { name: '저장 다시 시도', exact: true })

test.describe('two bounded recovery candidates, guards and storage failures', () => {
  test('a blocked second restore names the waiting original, keeps the latest removal and never becomes a blank save', async ({ page }, testInfo) => {
    await seedSaved(page, [EMBER, CINDER])
    await openSavedView(page, [EMBER.job.title, CINDER.job.title])
    const emberBefore = (await committedById(page, EMBER.job.id))!
    const cinderBefore = (await committedById(page, CINDER.job.id))!
    const fault = await installStoreFault(page, 'put')

    await removeCardByKeyboard(page, EMBER)
    await undoOf(recoveryEntry(page, EMBER)).click()
    const pending = recoveryEntry(page, EMBER)
    await expectEntryKind(pending, '복구 대기')
    await expect(pending.getByText(WAITING_WITH_STORAGE_FAILURE, { exact: true })).toBeVisible()
    await expect(retryOf(pending)).toBeDisabled()
    await expect(page.getByRole('alert')).toContainText(UNSAVED_CHANGES)
    // The accepted add is shown optimistically while its write waits for the storage retry.
    await expect(cardOf(page, EMBER)).toHaveCount(1)
    await expectAbsentFromStorage(page, EMBER.job.id)

    const dialog = await openDetailByKeyboard(page, CINDER)
    await footerToggle(dialog).click()
    // The removal is accepted and shown while the failed queue waits for the storage retry.
    await expect(noteField(dialog)).toHaveCount(0)
    await expect(cardOf(page, CINDER)).toHaveCount(0)
    expect(await committedById(page, CINDER.job.id)).toEqual(cinderBefore)
    await expectRegionInsideDialog(page, dialog)
    const latest = recoveryEntry(dialog, CINDER)
    await expectEntryKind(latest, '최근 제거')
    await expect(messageOf(latest)).toHaveText(blockedMessage(CINDER, EMBER))
    await expect(undoOf(latest)).toBeDisabled()
    await expect(footerToggle(dialog)).toHaveText('제거 취소')
    // The same-job alias respects the block: nothing is added, no blank record appears.
    await footerToggle(dialog).click()
    await expect(messageOf(latest)).toHaveText(blockedMessage(CINDER, EMBER))
    await expect(cardOf(page, CINDER)).toHaveCount(0)
    await expect(noteField(dialog)).toHaveCount(0)
    await expect(footerToggle(dialog)).toHaveText('제거 취소')
    await attachShot(page, testInfo, 'blocked-second-restore-in-dialog')

    await fault.restore()
    await storageRetry(dialog).click()
    await waitForSavedCommit(page)
    await expectCommittedExactly(page, EMBER, emberBefore)
    await expect(pendingEntry(dialog)).toHaveCount(0)
    await expect(undoOf(latest)).toBeEnabled()
    await expect(messageOf(latest)).toHaveText(removedMessage(CINDER))
    await undoOf(latest).click()
    await waitForSavedCommit(page)
    await expectCommittedExactly(page, CINDER, cinderBefore)
    await expect(recoveryRegion(page)).toHaveCount(0)
    await expect(footerToggle(dialog)).toHaveText('저장 목록에서 제거')
    await expect(noteField(dialog)).toHaveValue(CINDER.note)
  })

  test('explicitly dismissing the pinned original frees the blocked latest candidate: ordinary message, enabled Undo, exact originals and untouched queued work', async ({ page }, testInfo) => {
    await seedSaved(page, [EMBER, CINDER])
    await openSavedView(page, [EMBER.job.title, CINDER.job.title])
    const emberBefore = (await committedById(page, EMBER.job.id))!
    const cinderBefore = (await committedById(page, CINDER.job.id))!
    await removeCardByKeyboard(page, EMBER)

    // P: Ember's restore commits natively while the application's acknowledgement is held by the test.
    const hold = await holdCompletionDelivery(page)
    await undoOf(latestEntryOf(page, EMBER)).click()
    await expect(pendingEntryOf(page, EMBER).getByText(WAITING_FOR_COMMIT, { exact: true })).toBeVisible()
    await expectNativeCompletions(hold, 1)
    const committedRows = () => readCommitted(page)
    expect((await committedRows()).map(record => record.job.id).sort()).toEqual([CINDER.job.id, EMBER.job.id].sort())

    // L: Cinder is removed through its detail while P is held. Its deletion is queued behind the held write, so the
    // card and note disappear but the committed Cinder row is still the original.
    const dialog = await openDetailByKeyboard(page, CINDER)
    await footerToggle(dialog).focus()
    await page.keyboard.press('Enter')
    await expect(footerToggle(dialog)).toHaveText('제거 취소')
    await expect(noteField(dialog)).toHaveCount(0)
    await expect(cardOf(page, CINDER)).toHaveCount(0)
    expect((await committedRows()).find(record => record.job.id === CINDER.job.id)).toEqual(cinderBefore)
    const latest = latestEntryOf(dialog, CINDER)
    await expect(messageOf(latest)).toHaveText(blockedMessage(CINDER, EMBER))
    await expect(undoOf(latest)).toBeDisabled()

    // The blocked footer alias changes nothing: same named reason, no blank save, same persisted rows.
    await footerToggle(dialog).click()
    await expect(messageOf(latest)).toHaveText(blockedMessage(CINDER, EMBER))
    await expect(footerToggle(dialog)).toHaveText('제거 취소')
    await expect(noteField(dialog)).toHaveCount(0)
    expect((await committedRows()).find(record => record.job.id === CINDER.job.id)).toEqual(cinderBefore)
    expect((await committedRows()).find(record => record.job.id === EMBER.job.id)).toMatchObject(literalOf(EMBER))
    await attachShot(page, testInfo, 'blocked-latest-before-pending-dismiss')

    // Keyboard dismissal of P frees L: ordinary removal message, enabled Undo, nothing written or cancelled.
    await closeButton(dialog).focus()
    await pressTabUntil(page, dismissOf(pendingEntryOf(dialog, EMBER)), { max: 4 })
    await page.keyboard.press('Enter')
    await expect(pendingEntryOf(dialog, EMBER)).toHaveCount(0)
    await expect(recoveryRegion(page).getByRole('article')).toHaveCount(1)
    await expect(messageOf(latest)).toHaveText(removedMessage(CINDER))
    await expect(undoOf(latest)).toBeEnabled()
    expect((await committedRows()).find(record => record.job.id === CINDER.job.id)).toEqual(cinderBefore)
    expect((await committedRows()).find(record => record.job.id === EMBER.job.id)).toMatchObject(literalOf(EMBER))
    await attachShot(page, testInfo, 'latest-freed-after-pending-dismiss')

    // Release: the already committed Ember write is acknowledged and the queued Cinder deletion runs.
    await hold.release()
    await waitForSavedCommit(page)
    await expect(page.getByRole('alert')).toHaveCount(0)
    await expectCommittedExactly(page, EMBER, emberBefore)
    await expectAbsentFromStorage(page, CINDER.job.id)
    await expect(messageOf(latest)).toHaveText(removedMessage(CINDER))
    await expect(undoOf(latest)).toBeEnabled()

    // A deliberate Undo restores the whole Cinder original and leaves no candidate behind.
    await undoOf(latest).click()
    await waitForSavedCommit(page)
    await expectCommittedExactly(page, CINDER, cinderBefore)
    await expect(footerToggle(dialog)).toHaveText('저장 목록에서 제거')
    await expect(noteField(dialog)).toHaveValue(CINDER.note)
    await expect(recoveryRegion(page)).toHaveCount(0)
    await expect(closeButton(dialog)).toBeFocused()
    await expect(navCount(page)).toHaveText('2')
  })

  test('a capacity-rejected original survives removing another record to free room, and that removal keeps its own Undo', async ({ page }, testInfo) => {
    test.setTimeout(120_000)
    const fillers = savedPageRecords(500).slice(0, 499)
    // A named literal filler the test removes later to free room; not derived from the application.
    const FILLER = fillers[0]
    expect(FILLER.job.id).toBe('greenhouse-fable-labs-01')
    expect(FILLER.job.title).toBe('Fable 01 · Backend Engineer')
    await seedSaved(page, [EMBER, ...fillers])
    await openSavedView(page)
    await expect(page.locator('.saved-title').first()).toHaveText(EMBER.job.title)
    await expect(navCount(page).first()).toHaveText('500')
    const emberBefore = (await committedById(page, EMBER.job.id))!

    await removeCardByKeyboard(page, EMBER)
    await expect(navCount(page).first()).toHaveText('499')
    await writeExternalEntry(page, OTHER_TAB, 100_000)
    await dispatchReturn(page, 'focus')
    await expect(navCount(page).first()).toHaveText('500')
    await expect(page.locator('.saved-title').first()).toHaveText(OTHER_TAB.job.title)

    await undoOf(recoveryEntry(page, EMBER)).click()
    const pending = recoveryEntry(page, EMBER)
    await expectEntryKind(pending, '복구 대기')
    await expect(messageOf(pending)).toHaveText(LIMIT_HELP)
    await expect(retryOf(pending)).toBeEnabled()
    await expectAbsentFromStorage(page, EMBER.job.id)
    expect(await readSaved(page)).toHaveLength(500)

    await removeCardByKeyboard(page, OTHER_TAB)
    await expect(navCount(page).first()).toHaveText('499')
    await expect(recoveryEntry(page, EMBER)).toBeVisible()
    await expectEntryKind(recoveryEntry(page, OTHER_TAB), '최근 제거')
    await attachShot(page, testInfo, 'capacity-pinned-original-and-latest')

    await retryOf(recoveryEntry(page, EMBER)).click()
    await waitForSavedCommit(page)
    await expectCommittedExactly(page, EMBER, emberBefore)
    await expect(recoveryEntry(page, EMBER)).toHaveCount(0)
    expect(await readSaved(page)).toHaveLength(500)

    // The collection is full again, so the other tab's record cannot come back yet: its request is pinned with the limit reason.
    const latest = latestEntryOf(page, OTHER_TAB)
    await expect(undoOf(latest)).toBeEnabled()
    await undoOf(latest).click()
    const otherPending = pendingEntryOf(page, OTHER_TAB)
    await expect(messageOf(otherPending)).toHaveText(LIMIT_HELP)
    await expect(retryOf(otherPending)).toBeEnabled()
    await expectAbsentFromStorage(page, OTHER_TAB.job.id)
    expect(await readSaved(page)).toHaveLength(500)
    await expect(navCount(page).first()).toHaveText('500')

    // Deliberately free one place by removing a named filler; that removal takes the latest slot.
    await removeCardByKeyboard(page, FILLER)
    await expect(navCount(page).first()).toHaveText('499')
    await expect(latestEntryOf(page, FILLER)).toBeVisible()
    await expect(latestEntryOf(page, FILLER).getByLabel('원래 메모', { exact: true })).toHaveText(FILLER.note)
    await expect(pendingEntryOf(page, OTHER_TAB)).toBeVisible()
    await attachShot(page, testInfo, 'capacity-other-pinned-filler-latest')

    await retryOf(pendingEntryOf(page, OTHER_TAB)).click()
    await waitForSavedCommit(page)
    // The other tab's record was written raw, so only its literal fields are compared.
    expect(await committedById(page, OTHER_TAB.job.id)).toMatchObject(literalOf(OTHER_TAB))
    await expectCommittedExactly(page, EMBER, emberBefore)
    await expectAbsentFromStorage(page, FILLER.job.id)
    expect(await readSaved(page)).toHaveLength(500)
    await expect(navCount(page).first()).toHaveText('500')
    await expect(pendingEntryOf(page, OTHER_TAB)).toHaveCount(0)
    await expect(recoveryRegion(page).getByRole('article')).toHaveCount(1)
    await expect(latestEntryOf(page, FILLER)).toBeVisible()
    await expect(undoOf(latestEntryOf(page, FILLER))).toBeEnabled()
    await expect(page.getByRole('alert')).toHaveCount(0)
  })

  test('an unreadable same-ID wrapper rejects the restore with its reason and keeps the original waiting', async ({ page }) => {
    await seedSaved(page, [EMBER])
    await openSavedView(page, [EMBER.job.title])
    await removeCardByKeyboard(page, EMBER)
    await writeDamagedEntry(page, EMBER.job.id, 7)
    await dispatchReturn(page, 'focus')
    await expect(page.getByText('따로 보관한 원본이 있어요', { exact: true })).toBeVisible()
    await undoOf(recoveryEntry(page, EMBER)).click()
    const pending = recoveryEntry(page, EMBER)
    await expectEntryKind(pending, '복구 대기')
    await expect(messageOf(pending)).toHaveText(UNREADABLE_HELP)
    await expect(retryOf(pending)).toBeEnabled()
    await expect(pending.getByLabel('원래 메모', { exact: true })).toContainText('PRIVATE-UNDO80 ask about the Ember runtime team before applying')
    expect((await readSaved(page)).filter(record => record.job?.id === EMBER.job.id)).toEqual([])
  })

  test('a same-ID record written by another tab is kept: no-op first, then removing it frees the original for an explicit retry', async ({ page }, testInfo) => {
    await seedSaved(page, [EMBER])
    await openSavedView(page, [EMBER.job.title])
    const emberBefore = (await committedById(page, EMBER.job.id))!
    await removeCardByKeyboard(page, EMBER)
    await writeExternalEntry(page, NEWER_EMBER, 50)
    await dispatchReturn(page, 'focus')
    await expect(cardOf(page, EMBER).locator('.saved-note-preview')).toHaveText(NEWER_EMBER.note)
    await expect(cardOf(page, EMBER).locator('.saved-status')).toHaveText('검토 중')

    await undoOf(latestEntry(page)).click()
    await expect(pendingEntry(page)).toHaveCount(1)
    await expect(messageOf(pendingEntry(page))).toHaveText(NOOP_MESSAGE)
    await expect(retryOf(pendingEntry(page))).toBeEnabled()
    expect(await committedById(page, EMBER.job.id)).toMatchObject(literalOf(NEWER_EMBER))

    await removeCardByKeyboard(page, NEWER_EMBER)
    await expect(messageOf(pendingEntry(page))).toHaveText(REREMOVED_MESSAGE)
    // Astra R1: two same-ID candidates must have distinct accessible names, kind first.
    await expect(recoveryRegion(page).getByRole('article')).toHaveCount(2)
    await expect(pendingEntryOf(page, EMBER)).toHaveCount(1)
    await expect(latestEntryOf(page, NEWER_EMBER)).toHaveCount(1)
    await expect(recoveryRegion(page).getByRole('article', { name: entryName(EMBER), exact: true })).toHaveCount(0)
    await expect(pendingEntryOf(page, EMBER).getByLabel('원래 메모', { exact: true })).toContainText('PRIVATE-UNDO80 ask about the Ember runtime team before applying')
    await expect(latestEntryOf(page, NEWER_EMBER).getByLabel('원래 메모', { exact: true })).toHaveText(NEWER_EMBER.note)
    await attachShot(page, testInfo, 'collision-original-pending-newer-latest')

    await retryOf(pendingEntry(page)).click()
    await waitForSavedCommit(page)
    await expectCommittedExactly(page, EMBER, emberBefore)
    await expect(pendingEntry(page)).toHaveCount(0)
    // Restoring the other tab's version would overwrite the original; the no-op keeps it.
    await undoOf(latestEntry(page)).click()
    await expect(messageOf(pendingEntry(page))).toHaveText(NOOP_MESSAGE)
    await expectCommittedExactly(page, EMBER, emberBefore)
  })

  test('an unannounced same-ID record from another tab is met by the restore transaction: conflict message, original kept waiting, newer record untouched', async ({ page }, testInfo) => {
    await seedSaved(page, [EMBER])
    await openSavedView(page, [EMBER.job.title])
    const emberBefore = (await committedById(page, EMBER.job.id))!
    await removeCardByKeyboard(page, EMBER)
    // Written directly and never announced: the application has not re-read, so its list still shows no record for this id.
    await writeExternalEntry(page, NEWER_EMBER, 50)
    await expect(cardOf(page, EMBER)).toHaveCount(0)
    await expect(navCount(page)).toHaveCount(0)
    expect((await readCommitted(page)).map(record => record.job.id)).toEqual([EMBER.job.id])

    // Admission sees no current record and queues the add; the transaction finds the newer row and must not overwrite it.
    await undoOf(latestEntryOf(page, EMBER)).click()
    const pending = pendingEntryOf(page, EMBER)
    await expect(messageOf(pending)).toHaveText(CONFLICT_MESSAGE)
    await expect(retryOf(pending)).toBeEnabled()
    await expect(pending.getByLabel('원래 메모', { exact: true })).toContainText('PRIVATE-UNDO80 ask about the Ember runtime team before applying')
    expect(await committedById(page, EMBER.job.id)).toMatchObject(literalOf(NEWER_EMBER))
    expect(await readSaved(page)).toHaveLength(1)
    await expect(cardOf(page, EMBER).locator('.saved-note-preview')).toHaveText(NEWER_EMBER.note)
    await expect(page.getByRole('alert')).toHaveCount(0)
    await attachShot(page, testInfo, 'conflict-original-pending-newer-current')

    await removeCardByKeyboard(page, NEWER_EMBER)
    await expect(messageOf(pendingEntryOf(page, EMBER))).toHaveText(REREMOVED_MESSAGE)
    await expect(latestEntryOf(page, NEWER_EMBER).getByLabel('원래 메모', { exact: true })).toHaveText(NEWER_EMBER.note)
    await retryOf(pendingEntryOf(page, EMBER)).click()
    await waitForSavedCommit(page)
    await expectCommittedExactly(page, EMBER, emberBefore)
    expect(await readSaved(page)).toHaveLength(1)
    await expect(pendingEntryOf(page, EMBER)).toHaveCount(0)
    await expect(latestEntryOf(page, NEWER_EMBER)).toHaveCount(1)
  })

  test('removing an equal original again starts a fresh latest generation without stale messages', async ({ page }) => {
    await seedSaved(page, [EMBER])
    await openSavedView(page, [EMBER.job.title])
    const before = (await committedById(page, EMBER.job.id))!
    await removeCardByKeyboard(page, EMBER)
    await undoOf(recoveryEntry(page, EMBER)).click()
    await waitForSavedCommit(page)
    await expectCommittedExactly(page, EMBER, before)
    await expect(recoveryRegion(page)).toHaveCount(0)
    await removeCardByKeyboard(page, EMBER)
    const latest = recoveryEntry(page, EMBER)
    await expectEntryKind(latest, '최근 제거')
    await expect(messageOf(latest)).toHaveText(removedMessage(EMBER))
    await undoOf(latest).click()
    await waitForSavedCommit(page)
    await expectCommittedExactly(page, EMBER, before)
    await expect(recoveryRegion(page)).toHaveCount(0)
  })

  test('re-removing the equal original while its restore is committed but unacknowledged replaces P with a fresh L; the stale receipt cannot revive it', async ({ page }, testInfo) => {
    await seedSaved(page, [EMBER])
    await openSavedView(page, [EMBER.job.title])
    const before = (await committedById(page, EMBER.job.id))!
    await removeCardByKeyboard(page, EMBER)
    const hold = await holdCompletionDelivery(page)
    await undoOf(latestEntryOf(page, EMBER)).click()
    const pending = pendingEntryOf(page, EMBER)
    await expect(pending.getByText(WAITING_FOR_COMMIT, { exact: true })).toBeVisible()
    await expect(cardOf(page, EMBER)).toHaveCount(1)
    // The add has committed natively; only the application's acknowledgement is held.
    await expectNativeCompletions(hold, 1)
    expect((await readCommitted(page)).map(record => record.job.id)).toEqual([EMBER.job.id])

    // Deliberate re-removal through the card while P still waits for that acknowledgement.
    await removeCardNoWait(page, EMBER)
    await expect(pendingEntryOf(page, EMBER)).toHaveCount(0)
    const latest = latestEntryOf(page, EMBER)
    await expect(latest).toHaveCount(1)
    await expect(recoveryRegion(page).getByRole('article')).toHaveCount(1)
    await expect(messageOf(latest)).toHaveText(removedMessage(EMBER))
    await expect(latest.getByLabel('원래 메모', { exact: true })).toContainText('PRIVATE-UNDO80 ask about the Ember runtime team before applying')
    await expect(latest.locator('.saved-removal-meta')).toHaveText(/^지원 완료 · .+ 저장$/)
    await expect(undoOf(latest)).toBeEnabled()
    await attachShot(page, testInfo, 'equal-original-reremoved-while-pending')

    // Delivering the held acknowledgement settles the superseded add and lets the queued removal commit; L must survive untouched.
    await hold.release()
    await waitForSavedCommit(page)
    await expect(page.getByRole('alert')).toHaveCount(0)
    await expectAbsentFromStorage(page, EMBER.job.id)
    await expect(cardOf(page, EMBER)).toHaveCount(0)
    await expect(latestEntryOf(page, EMBER)).toHaveCount(1)
    await expect(pendingEntryOf(page, EMBER)).toHaveCount(0)
    await expect(messageOf(latestEntryOf(page, EMBER))).toHaveText(removedMessage(EMBER))

    await undoOf(latestEntryOf(page, EMBER)).click()
    await waitForSavedCommit(page)
    await expectCommittedExactly(page, EMBER, before)
    await expect(recoveryRegion(page)).toHaveCount(0)
    await expect(page.locator('.saved-title')).toHaveText([EMBER.job.title])
  })

  test('a failed restore write keeps the original waiting; the ordinary storage retry commits exactly one record', async ({ page }) => {
    await seedSaved(page, [EMBER])
    await openSavedView(page, [EMBER.job.title])
    const before = (await committedById(page, EMBER.job.id))!
    await removeCardByKeyboard(page, EMBER)
    const fault = await installStoreFault(page, 'put')
    await undoOf(recoveryEntry(page, EMBER)).click()
    const pending = recoveryEntry(page, EMBER)
    await expectEntryKind(pending, '복구 대기')
    await expect(pending.getByText(WAITING_WITH_STORAGE_FAILURE, { exact: true })).toBeVisible()
    await expect(page.getByRole('alert')).toContainText(UNSAVED_CHANGES)
    await expect(cardOf(page, EMBER)).toHaveCount(1)
    await expectAbsentFromStorage(page, EMBER.job.id)
    expect(await fault.attempts()).toBeGreaterThanOrEqual(1)
    await fault.restore()
    await storageRetry(page).click()
    await waitForSavedCommit(page)
    await expectCommittedExactly(page, EMBER, before)
    expect(await readSaved(page)).toHaveLength(1)
    await expect(recoveryRegion(page)).toHaveCount(0)
    await expect(page.getByRole('alert')).toHaveCount(0)
  })

  test('a failed delete followed by Undo commits the removal and then the restore in order', async ({ page }) => {
    await seedSaved(page, [EMBER])
    await openSavedView(page, [EMBER.job.title])
    const before = (await committedById(page, EMBER.job.id))!
    const fault = await installStoreFault(page, 'delete')
    const remove = cardRemoveButton(page, EMBER)
    await remove.focus()
    await page.keyboard.press('Enter')
    await expect(cardOf(page, EMBER)).toHaveCount(0)
    await expect(page.getByRole('alert')).toContainText(UNSAVED_CHANGES)
    const latest = recoveryEntry(page, EMBER)
    await expectEntryKind(latest, '최근 제거')
    expect(await committedById(page, EMBER.job.id)).toEqual(before)
    await undoOf(latest).click()
    await expectEntryKind(recoveryEntry(page, EMBER), '복구 대기')
    await expect(cardOf(page, EMBER)).toHaveCount(1)
    await fault.restore()
    await storageRetry(page).click()
    await waitForSavedCommit(page)
    await expectCommittedExactly(page, EMBER, before)
    expect(await readSaved(page)).toHaveLength(1)
    await expect(recoveryRegion(page)).toHaveCount(0)
  })

  test('explicit dismissal forgets the candidate but not the queued write; the open modal still offers the storage retry', async ({ page }, testInfo) => {
    await seedSaved(page, [EMBER])
    await openSavedView(page, [EMBER.job.title])
    const before = (await committedById(page, EMBER.job.id))!
    const dialog = await openDetailByKeyboard(page, EMBER)
    await footerToggle(dialog).click()
    await waitForSavedCommit(page)
    await expectAbsentFromStorage(page, EMBER.job.id)
    const fault = await installStoreFault(page, 'put')
    await undoOf(recoveryEntry(dialog, EMBER)).click()
    const pending = recoveryEntry(dialog, EMBER)
    await expectEntryKind(pending, '복구 대기')
    await expect(dialog.getByRole('alert')).toContainText(UNSAVED_CHANGES)
    await dismissOf(pending).click()
    await expect(recoveryRegion(page)).toHaveCount(0)
    await expect(dialog.getByRole('alert')).toContainText(UNSAVED_CHANGES)
    await expect(storageRetry(dialog)).toBeVisible()
    await attachShot(page, testInfo, 'dismissed-candidate-keeps-storage-retry')
    await fault.restore()
    await storageRetry(dialog).click()
    await waitForSavedCommit(page)
    await expectCommittedExactly(page, EMBER, before)
    await expect(noteField(dialog)).toHaveValue(EMBER_NOTE)
    await expect(footerToggle(dialog)).toHaveText('저장 목록에서 제거')
  })

  test('after explicit dismissal the same-job footer action is an ordinary blank save again', async ({ page }) => {
    await seedSaved(page, [EMBER])
    await openSavedView(page, [EMBER.job.title])
    const dialog = await openDetailByKeyboard(page, EMBER)
    await footerToggle(dialog).click()
    await waitForSavedCommit(page)
    await expect(footerToggle(dialog)).toHaveText('제거 취소')
    await dismissOf(recoveryEntry(dialog, EMBER)).click()
    await expect(recoveryRegion(page)).toHaveCount(0)
    await expect(footerToggle(dialog)).toHaveText('기회 저장')
    await footerToggle(dialog).click()
    await waitForSavedCommit(page)
    const blank = await committedById(page, EMBER.job.id)
    expect(blank).toMatchObject({ note: '', status: 'saved', job: { id: EMBER.job.id, title: EMBER.job.title }, company: EMBER.company })
    expect(blank!.savedAt).not.toBe(EMBER.savedAt)
    expect(Date.parse(blank!.savedAt)).toBeGreaterThanOrEqual(Date.parse('2026-10-02T09:00:00.000Z'))
    await expect(page.locator('.toast')).toContainText(`${EMBER.company.name}의 기회를 목록에 추가했어요.`)
    await expect(footerToggle(dialog)).toHaveText('저장 목록에서 제거')
    await expect(noteField(dialog)).toHaveValue('')
  })

  test('an external removal creates no candidate and the open detail returns to an ordinary save', async ({ page }) => {
    await seedSaved(page, [EMBER])
    await openSavedView(page, [EMBER.job.title])
    const dialog = await openDetailByKeyboard(page, EMBER)
    await deleteExternalEntry(page, EMBER.job.id)
    await dispatchReturn(page, 'focus')
    await expect(noteField(dialog)).toHaveCount(0)
    await expect(footerToggle(dialog)).toHaveText('기회 저장')
    await expect(recoveryRegion(page)).toHaveCount(0)
    await expect(navCount(page)).toHaveCount(0)
  })
})

test.describe('one host for the candidate across time, modals, views and ordinary notices', () => {
  // Navigation to explore and compare loads the public catalog; the policy admits that read's shape only.
  test.use({ apiPolicy: 'catalog-reads' })

  test('the candidate survives time, hidden returns, every modal, navigation and an ordinary toast, hosted exactly once', async ({ page }, testInfo) => {
    await seedSaved(page, [EMBER, CINDER], { clock: EXPLORE_CLOCK })
    await openSavedView(page, [EMBER.job.title, CINDER.job.title])
    const before = (await committedById(page, EMBER.job.id))!
    await removeCardByKeyboard(page, EMBER)
    await expectRegionBeforeSavedGrid(page)
    await expect(recoveryRegion(page).getByText(RECOVERY_SCOPE_NOTE, { exact: true })).toBeVisible()

    await page.clock.fastForward(60_000)
    await expect(recoveryEntry(page, EMBER)).toBeVisible()
    await overrideVisibility(page, 'hidden')
    await dispatchReturn(page, 'visibilitychange')
    await overrideVisibility(page, 'visible')
    await dispatchReturn(page, 'visibilitychange')
    await overrideVisibility(page, null)
    await expect(recoveryEntry(page, EMBER)).toBeVisible()

    await page.getByRole('button', { name: '기록 백업·복원', exact: true }).click()
    const backup = page.getByRole('dialog', { name: '기록 백업과 복원', exact: true })
    await expect(backup).toBeVisible()
    await expectRegionInsideDialog(page, backup)
    await page.keyboard.press('Escape')
    await expect(backup).toHaveCount(0)
    await expectRegionBeforeSavedGrid(page)

    // A different job's detail hosts the panel; a background change keeps the draft and focus.
    const detail = await openDetailByKeyboard(page, CINDER)
    await expectRegionInsideDialog(page, detail)
    await noteField(detail).fill(`${CINDER.note} — draft typed while recovery is shown`)
    await waitForSavedCommit(page)
    await writeExternalEntry(page, OTHER_TAB, 9_000)
    await dispatchReturn(page, 'focus')
    await expect(navCount(page).first()).toHaveText('2')
    await expect(noteField(detail)).toHaveValue(`${CINDER.note} — draft typed while recovery is shown`)
    await expect(noteField(detail)).toBeFocused()
    await expect(recoveryRegion(page)).toHaveCount(1)
    await expectRegionInsideDialog(page, detail)
    await page.keyboard.press('Escape')
    await expect(detail).toHaveCount(0)

    await page.getByRole('navigation', { name: '주요 메뉴' }).getByRole('button', { name: '기회 탐색', exact: true }).click()
    await expect(page.getByRole('button', { name: '공개 채용', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: /^런던, 추천 회사 \d+곳 보기$/ })).toBeVisible()
    await expectRegionInsideResultsPanel(page)
    await attachShot(page, testInfo, 'recovery-host-explore')

    await page.getByRole('button', { name: '모든 필터', exact: true }).click()
    const filters = page.getByRole('dialog', { name: '내게 중요한 조건으로.', exact: true })
    await expect(filters).toBeVisible()
    await expectRegionInsideDialog(page, filters)
    await page.keyboard.press('Escape')
    await expect(filters).toHaveCount(0)
    await page.getByRole('button', { name: '내 프로필 편집', exact: true }).click()
    const profile = page.getByRole('dialog', { name: '커리어의 다음 좌표를 찾아보세요.', exact: true })
    await expect(profile).toBeVisible()
    await expectRegionInsideDialog(page, profile)
    await page.keyboard.press('Escape')
    await expect(profile).toHaveCount(0)
    await page.getByRole('button', { name: '데이터와 추천 방식', exact: true }).click()
    const data = page.getByRole('dialog', { name: '기회의 지도, 그 안의 데이터.', exact: true })
    await expect(data).toBeVisible()
    await expectRegionInsideDialog(page, data)
    await page.keyboard.press('Escape')
    await expect(data).toHaveCount(0)
    await expectRegionInsideResultsPanel(page)

    await page.getByRole('button', { name: '런던 비교에 추가', exact: true }).click()
    await expect(page.locator('.toast')).toContainText('비교에 추가했어요')
    await expect(recoveryEntry(page, EMBER)).toBeVisible()
    await page.getByRole('navigation', { name: '주요 메뉴' }).getByRole('button', { name: /^도시 비교/ }).click()
    await expect(recoveryRegion(page)).toHaveCount(1)
    expect(await recoveryRegion(page).evaluate(element => element.closest('main#main-content') !== null && element.closest('dialog') === null)).toBe(true)

    await page.getByRole('navigation', { name: '주요 메뉴' }).getByRole('button', { name: /^저장한 기회/ }).click()
    await expectRegionBeforeSavedGrid(page)
    const undo = undoOf(recoveryEntry(page, EMBER))
    await undo.focus()
    await page.keyboard.press('Enter')
    await waitForSavedCommit(page)
    await expectCommittedExactly(page, EMBER, before)
    await expect(recoveryRegion(page)).toHaveCount(0)
    await expect(titleButton(page, EMBER)).toBeVisible()
  })
})

test.describe('company lists offer the same restore alias', () => {
  // The policy admits the catalog read's shape; each case also pins the exact attempt count after the
  // initial load settles and proves local save/edit/remove/restore added no Page /api attempt, cancelled or not.
  test.use({ apiPolicy: 'catalog-reads' })

  const ASTER = 'Aster Transit'
  type Traffic = Parameters<typeof expectInitialCatalogRequest>[1]
  async function openExplore(page: Page, traffic: Traffic) {
    await seedSaved(page, [], { clock: EXPLORE_CLOCK })
    await page.goto('/')
    await expect(page.getByRole('button', { name: '공개 채용', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: /^런던, 추천 회사 \d+곳 보기$/ })).toBeVisible()
    const initial = await expectInitialCatalogRequest(page, traffic)
    return { attempts: initial.attempts }
  }
  const expectNoFurtherApiAttempts = (traffic: Traffic, baseline: { attempts: number }) => {
    expect(traffic.requests.map(request => `${request.method} ${new URL(request.url).pathname}${new URL(request.url).search} ${request.state}`))
      .toHaveLength(baseline.attempts)
  }
  const saveControl = (page: Page, title: string, state: '저장' | '저장 취소' | '제거 취소') =>
    page.getByRole('button', { name: `${ASTER} ${title} ${state}`, exact: true })

  /** Save from the list, add private metadata in the detail, remove from the list by keyboard and restore through the alias. */
  async function saveRemoveRestore(page: Page, title: string, id: string, note: string) {
    await expect(saveControl(page, title, '저장')).toHaveAttribute('title', '기회 저장')
    await expect(saveControl(page, title, '저장').locator('svg.lucide-bookmark')).toHaveCount(1)
    await saveControl(page, title, '저장').click()
    await waitForSavedCommit(page)
    await page.getByRole('button', { name: title, exact: true }).click()
    const dialog = page.getByRole('dialog', { name: ASTER, exact: true })
    await noteField(dialog).fill(note)
    await dialog.getByRole('button', { name: '지원 완료로 표시', exact: true }).click()
    await waitForSavedCommit(page)
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    const before = (await committedById(page, id))!
    expect(before).toMatchObject({ note, status: 'applied' })

    const remove = saveControl(page, title, '저장 취소')
    await expect(remove).toHaveAttribute('title', '저장 목록에서 제거')
    await expect(remove.locator('svg.lucide-bookmark-check')).toHaveCount(1)
    await remove.focus()
    await page.keyboard.press('Enter')
    await waitForSavedCommit(page)
    await expectAbsentFromStorage(page, id)
    const alias = saveControl(page, title, '제거 취소')
    await expect(alias).toBeVisible()
    await expect(alias).toBeFocused()
    // M80: the visible alias matches its accessible name — restore icon and tooltip, not a bookmark.
    await expect(alias).toHaveAttribute('title', '제거 취소')
    await expect(alias.locator('svg.lucide-rotate-ccw')).toHaveCount(1)
    await expect(alias.locator('svg.lucide-bookmark, svg.lucide-bookmark-check')).toHaveCount(0)
    await expectRegionInsideResultsPanel(page)
    await page.keyboard.press('Enter')
    await waitForSavedCommit(page)
    const restored = await committedById(page, id)
    expect(restored).toMatchObject({ note, status: 'applied', savedAt: before.savedAt })
    expect(restored).toEqual(before)
    await expect(saveControl(page, title, '저장 취소')).toBeVisible()
    await expect(saveControl(page, title, '저장 취소')).toHaveAttribute('title', '저장 목록에서 제거')
    await expect(recoveryRegion(page)).toHaveCount(0)
  }

  test('city, remote and other-location lists all restore the exact record through the labelled alias', async ({ page, recoveryDiagnostics }, testInfo) => {
    const baseline = await openExplore(page, recoveryDiagnostics.traffic)
    await page.getByRole('button', { name: /^런던, 추천 회사 \d+곳 보기$/ }).click()
    await saveRemoveRestore(page, 'Backend Engineer — Aster Transit London', 'greenhouse-fixture-aster-transit-london', 'PRIVATE-UNDO80 city list note')
    expectNoFurtherApiAttempts(recoveryDiagnostics.traffic, baseline)
    await attachShot(page, testInfo, 'explore-city-alias-restored')

    await page.getByRole('button', { name: /^원격 기회/ }).click()
    await saveRemoveRestore(page, 'Backend Engineer — Aster Transit Remote', 'greenhouse-fixture-aster-transit-remote-world', 'PRIVATE-UNDO80 remote list note')
    expectNoFurtherApiAttempts(recoveryDiagnostics.traffic, baseline)

    await page.getByRole('button', { name: /^기타 근무지/ }).click()
    await saveRemoveRestore(page, 'Backend Engineer — Aster Transit Oxford', 'greenhouse-fixture-aster-transit-unmapped', 'PRIVATE-UNDO80 other-location note')
    expect(await readSaved(page)).toHaveLength(3)
    expectNoFurtherApiAttempts(recoveryDiagnostics.traffic, baseline)
  })

  test('the detail of a job removed from the list shows the alias and restores the original from the explore view', async ({ page, recoveryDiagnostics }) => {
    const baseline = await openExplore(page, recoveryDiagnostics.traffic)
    await page.getByRole('button', { name: /^런던, 추천 회사 \d+곳 보기$/ }).click()
    const title = 'Backend Engineer — Aster Transit London'
    const id = 'greenhouse-fixture-aster-transit-london'
    await saveControl(page, title, '저장').click()
    await waitForSavedCommit(page)
    await page.getByRole('button', { name: title, exact: true }).click()
    const dialog = page.getByRole('dialog', { name: ASTER, exact: true })
    await noteField(dialog).fill('PRIVATE-UNDO80 detail note before list removal')
    await waitForSavedCommit(page)
    await page.keyboard.press('Escape')
    const before = (await committedById(page, id))!
    await saveControl(page, title, '저장 취소').click()
    await waitForSavedCommit(page)
    await expectAbsentFromStorage(page, id)
    await page.getByRole('button', { name: title, exact: true }).click()
    await expect(dialog).toBeVisible()
    await expectRegionInsideDialog(page, dialog)
    await expect(footerToggle(dialog)).toHaveText('제거 취소')
    await footerToggle(dialog).click()
    await waitForSavedCommit(page)
    expect(await committedById(page, id)).toEqual(before)
    await expect(noteField(dialog)).toHaveValue('PRIVATE-UNDO80 detail note before list removal')
    await expect(footerToggle(dialog)).toHaveText('저장 목록에서 제거')
    await expect(recoveryRegion(page)).toHaveCount(0)
    await expect(closeButton(dialog)).toBeVisible()
    expectNoFurtherApiAttempts(recoveryDiagnostics.traffic, baseline)
  })
})
