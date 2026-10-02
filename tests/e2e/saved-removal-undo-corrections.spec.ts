/**
 * Stage80 final test authoring 02: Astra's required product corrections and the
 * late storage-result focus rule of D2 §표시 6.
 *
 * - A80-P01-1  a schema-valid legacy record whose company id differs from the
 *              job's company must restore like any other original.
 * - A80-P01-2  one stable feedback host per mounted view: a passive update
 *              (another tab's write, a held catalog reply, a held content
 *              comparison) must not replace the element that holds keyboard focus.
 * - A80-P01-3  generic modals route the storage retry through the feedback host:
 *              the queue drains, the modal draft survives and Close takes focus.
 * - D2 §표시 6  a restore whose result arrives after the user moved on never
 *              steals focus; the application's completion callback for the
 *              committed transaction is held until an explicit test release.
 * - busy        Undo while a file import is committed but unacknowledged is
 *              rejected with the busy reason and the original stays pinned.
 *
 * Every expectation is a literal fixture value, approved copy, or equality with
 * the record the application itself committed before the removal. Real
 * IndexedDB is read for every record. Survival of a focused control is checked
 * on the same DOM node, never by a fresh selector lookup alone.
 */
import { expect } from '@playwright/test'
import type { Locator, Page } from '@playwright/test'
import type { PostingStatusIndex } from '../../shared/posting-status'
import type { SavedJob } from '../../shared/types'
import { readSaved, waitForSavedCommit } from './helpers/saved-store'
import { dispatchReturn, installStorageProbe, readCommitted, storageProbe } from './helpers/saved-lifecycle'
import {
  CINDER, EMBER, EXPLORE_CLOCK, LEGACY_MISMATCH, OTHER_TAB, RESULTS_PANEL, appliedMarker, attachShot, closeButton, committedById, dismissOf,
  expectAbsentFromStorage, expectCommittedExactly, expectFocusedControlSurvives, expectNativeCompletions, expectRegionBeforeSavedGrid,
  expectRegionInsideDialog, expectRegionInsideResultsPanel, expectVisibleFocus, footerToggle, holdCatalog, holdCompletionDelivery, holdRevisionDigest,
  installStoreFault, latestEntryOf, literalOf, messageOf, navCount, noteField, openDetailByKeyboard, openSavedView, pendingEntryOf, pressTabUntil,
  recoveryRegion, removeCardByKeyboard, retryOf, savedSearch, seedSaved, test, titleButton, undoOf, writeExternalEntry,
} from './helpers/saved-removal-undo'

const WAITING_FOR_COMMIT = '원래 기록의 저장 완료를 확인하고 있어요.'
const WAITING_WITH_STORAGE_FAILURE = '원래 기록은 보관 중이에요. 저장소 안내의 ‘저장 다시 시도’로 계속할 수 있어요.'
const UNSAVED_CHANGES = '아직 저장하지 못한 변경이 있어요.'
const GLOBAL_SEARCH = '도시, 회사 또는 포지션 검색'
const PROFILE_DIALOG = '커리어의 다음 좌표를 찾아보세요.'
const LINKEDIN_DRAFT = 'https://www.linkedin.com/in/undo80-draft-kept'
const storageRetry = (scope: Page | Locator) => scope.getByRole('button', { name: '저장 다시 시도', exact: true })
const waitText = (entry: Locator, text: string) => entry.getByText(text, { exact: true })

const ZERO_DIGEST = '0'.repeat(64)
const DIFFERENT_REVISION = {
  title: ZERO_DIGEST, location: ZERO_DIGEST, conditions: ZERO_DIGEST, compensation: ZERO_DIGEST,
  qualifications: ZERO_DIGEST, description: ZERO_DIGEST, url: ZERO_DIGEST,
}
/** Both fixture boards are listed with a deliberately different published revision. No application digest is used to build this. */
const UNDO_POSTING_INDEX: PostingStatusIndex = {
  version: 1, checkedAt: '2026-10-02T08:58:00.000Z', refreshAfter: '2026-10-02T09:03:00.000Z',
  boards: [
    {
      companyId: 'ember-forge', provider: 'greenhouse', board: 'ember-forge', status: 'ok',
      checkedAt: '2026-10-02T08:58:00.000Z', lastSuccessAt: '2026-10-02T08:58:00.000Z', retryAt: null,
      listing: {
        validUntil: '2026-10-02T09:18:00.000Z', publishedIds: [EMBER.job.id],
        jobs: [{ id: EMBER.job.id, title: 'Ember 80 · Revised fictional opening', url: EMBER.job.url, revision: { ...DIFFERENT_REVISION } }],
      },
    },
    {
      companyId: 'cinder-works', provider: 'greenhouse', board: 'cinder-works', status: 'ok',
      checkedAt: '2026-10-02T08:58:00.000Z', lastSuccessAt: '2026-10-02T08:58:00.000Z', retryAt: null,
      listing: {
        validUntil: '2026-10-02T09:18:00.000Z', publishedIds: [CINDER.job.id],
        jobs: [{ id: CINDER.job.id, title: 'Cinder 81 · Revised fictional opening', url: CINDER.job.url, revision: { ...DIFFERENT_REVISION } }],
      },
    },
  ],
}

async function expectNoStorageIssue(page: Page) {
  await expect(page.getByRole('alert')).toHaveCount(0)
  await expect(page.locator('.main-nav button[aria-busy="true"]')).toHaveCount(0)
}

/** Region hosted inside the compare page's main, once, after the catalog status and before the comparison content. */
async function expectRegionInsideCompareMain(page: Page) {
  await expect(recoveryRegion(page)).toHaveCount(1)
  const placement = await recoveryRegion(page).evaluate(region => {
    const main = region.closest('main.compare-page')
    const content = main?.querySelector('.compare-empty, .comparison-scroll, .recommendations-unavailable')
    return {
      insideMain: Boolean(main),
      beforeContent: content ? Boolean(region.compareDocumentPosition(content) & Node.DOCUMENT_POSITION_FOLLOWING) : null,
    }
  })
  expect(placement.insideMain).toBe(true)
  if (placement.beforeContent !== null) expect(placement.beforeContent).toBe(true)
}

test.describe('A80-P01-1: a legacy record with a different company id restores exactly', () => {
  test('removing it in the detail and undoing by keyboard commits the original without a storage error', async ({ page }, testInfo) => {
    await seedSaved(page, [LEGACY_MISMATCH])
    await openSavedView(page, [LEGACY_MISMATCH.job.title])
    const before = (await committedById(page, LEGACY_MISMATCH.job.id))!
    expect(before).toMatchObject(literalOf(LEGACY_MISMATCH))
    expect(before.company.id).toBe('ember-forge-eu')
    expect(before.job.companyId).toBe('ember-forge')

    const dialog = await openDetailByKeyboard(page, LEGACY_MISMATCH)
    await expect(footerToggle(dialog)).toHaveText('저장 목록에서 제거')
    await footerToggle(dialog).focus()
    await page.keyboard.press('Enter')
    await expect(footerToggle(dialog)).toHaveText('제거 취소')
    await expectAbsentFromStorage(page, LEGACY_MISMATCH.job.id)
    // The footer control survives the removal, so it keeps focus (D2 §표시 7 moves focus only when the pressed control disappears).
    await expect(footerToggle(dialog)).toBeFocused()
    await expectRegionInsideDialog(page, dialog)
    const entry = latestEntryOf(dialog, LEGACY_MISMATCH)
    await expect(entry.getByLabel('원래 메모', { exact: true })).toHaveText(LEGACY_MISMATCH.note)

    // Footer toggle → original-posting link → (dialog boundary wraps) Close → Undo.
    await pressTabUntil(page, undoOf(entry), { max: 4 })
    await page.keyboard.press('Enter')
    await expectCommittedExactly(page, LEGACY_MISMATCH, before)
    await expect(recoveryRegion(page)).toHaveCount(0)
    await expectNoStorageIssue(page)
    await expect(footerToggle(dialog)).toHaveText('저장 목록에서 제거')
    await expect(noteField(dialog)).toHaveValue(LEGACY_MISMATCH.note)
    await expect(appliedMarker(dialog)).toBeVisible()
    await expect(closeButton(dialog)).toBeFocused()
    await expect(navCount(page)).toHaveText('1')
    await attachShot(page, testInfo, 'legacy-mismatch-restored')
  })
})

test.describe('A80-P01-2: passive updates keep the focused Undo in its one host', () => {
  test('saved view: the collection filling from empty after another tab’s write keeps the same focused Undo, which then restores', async ({ page }, testInfo) => {
    await seedSaved(page, [EMBER])
    await openSavedView(page, [EMBER.job.title])
    const before = (await committedById(page, EMBER.job.id))!
    await removeCardByKeyboard(page, EMBER)
    await expect(savedSearch(page)).toBeFocused()
    const entry = latestEntryOf(page, EMBER)
    await pressTabUntil(page, undoOf(entry), { max: 4 })
    await expectVisibleFocus(undoOf(entry))
    const survival = await expectFocusedControlSurvives(undoOf(entry))

    await installStorageProbe(page)
    await writeExternalEntry(page, OTHER_TAB, 9_000)
    await dispatchReturn(page, 'focus')
    await expect(page.locator('.saved-title')).toHaveText([OTHER_TAB.job.title])
    await expect(navCount(page)).toHaveText('1')
    await survival.verify()
    await expectRegionBeforeSavedGrid(page)
    await expect(entry).toBeVisible()
    expect(await storageProbe(page)).toMatchObject({ mutations: 0 })
    await expectAbsentFromStorage(page, EMBER.job.id)
    await attachShot(page, testInfo, 'saved-empty-to-list-undo-kept')

    await page.keyboard.press('Enter')
    await expectCommittedExactly(page, EMBER, before)
    await expect(page.locator('.saved-title')).toHaveText([EMBER.job.title, OTHER_TAB.job.title])
    await expect(recoveryRegion(page)).toHaveCount(0)
    await expect(titleButton(page, EMBER)).toBeFocused()
    await expect(navCount(page)).toHaveText('2')
  })

  test.describe('explore and compare hosts while the catalog is still loading', () => {
    test.use({ apiPolicy: 'catalog-reads' })

    test('city panel: a held catalog reply arriving later keeps the same focused Undo, which then restores', async ({ page }, testInfo) => {
      await seedSaved(page, [EMBER], { clock: EXPLORE_CLOCK })
      await openSavedView(page, [EMBER.job.title])
      const before = (await committedById(page, EMBER.job.id))!
      await removeCardByKeyboard(page, EMBER)
      const catalog = await holdCatalog(page)
      await page.getByRole('button', { name: '기회 탐색', exact: true }).click()
      await expect(page.getByRole('complementary', { name: RESULTS_PANEL, exact: true })).toBeVisible()
      await expect(page.locator('.data-status-button')).toContainText('공개 공고 조회 중')
      await expectRegionInsideResultsPanel(page)
      const entry = latestEntryOf(page, EMBER)
      await page.getByRole('button', { name: /^기타 근무지/ }).focus()
      await pressTabUntil(page, undoOf(entry), { max: 8 })
      await expectVisibleFocus(undoOf(entry))
      const survival = await expectFocusedControlSurvives(undoOf(entry))
      await attachShot(page, testInfo, 'explore-loading-undo-focused')

      await installStorageProbe(page)
      catalog.release()
      await expect(page.getByRole('button', { name: /^런던, 추천 회사 \d+곳 보기$/ })).toBeVisible()
      await expect(page.locator('.data-status-button')).toContainText('공개 채용')
      expect(catalog.served()).toBeGreaterThanOrEqual(1)
      await survival.verify()
      await expectRegionInsideResultsPanel(page)
      expect(await storageProbe(page)).toMatchObject({ mutations: 0 })
      await expectAbsentFromStorage(page, EMBER.job.id)

      await page.keyboard.press('Enter')
      await expectCommittedExactly(page, EMBER, before)
      await expect(recoveryRegion(page)).toHaveCount(0)
      await expect(navCount(page)).toHaveText('1')
      // No restored title or live save control exists on the explore page: D2's next target is the search box.
      await expect(page.getByRole('textbox', { name: GLOBAL_SEARCH, exact: true })).toBeFocused()
    })

    test('compare page: readiness arriving later keeps the same focused Undo, which then restores', async ({ page }, testInfo) => {
      await seedSaved(page, [EMBER], { clock: EXPLORE_CLOCK })
      await openSavedView(page, [EMBER.job.title])
      const before = (await committedById(page, EMBER.job.id))!
      await removeCardByKeyboard(page, EMBER)
      const catalog = await holdCatalog(page)
      await page.getByRole('button', { name: '도시 비교', exact: true }).click()
      await expect(page.locator('main.compare-page')).toBeVisible()
      await expect(page.getByRole('heading', { level: 1, name: /어느 도시에서 시작할까요/ })).toHaveCount(0)
      await expectRegionInsideCompareMain(page)
      const entry = latestEntryOf(page, EMBER)
      await page.locator('#main-content').focus()
      await pressTabUntil(page, undoOf(entry), { max: 8 })
      await expectVisibleFocus(undoOf(entry))
      const survival = await expectFocusedControlSurvives(undoOf(entry))

      await installStorageProbe(page)
      catalog.release()
      await expect(page.getByRole('heading', { level: 1, name: /어느 도시에서 시작할까요/ })).toBeVisible()
      await expect(page.getByRole('button', { name: '도시 탐색하기', exact: true })).toBeVisible()
      await survival.verify()
      await expectRegionInsideCompareMain(page)
      expect(await storageProbe(page)).toMatchObject({ mutations: 0 })
      await expectAbsentFromStorage(page, EMBER.job.id)
      await attachShot(page, testInfo, 'compare-ready-undo-kept')

      await page.keyboard.press('Enter')
      await expectCommittedExactly(page, EMBER, before)
      await expect(recoveryRegion(page)).toHaveCount(0)
      await expect(navCount(page)).toHaveText('1')
      // No title, save control or search box on the compare page: D2's next target is the empty-state action.
      await expect(page.getByRole('button', { name: '도시 탐색하기', exact: true })).toBeFocused()
    })
  })

  test.describe('saved view while a content comparison is pending', () => {
    test.use({ apiPolicy: 'posting-status-reads' })

    test('comparison completion replaces the placeholder with the list and keeps the same focused Undo, which then restores', async ({ page }, testInfo) => {
      await page.route('**/api/posting-status*', route => route.fulfill({ json: UNDO_POSTING_INDEX }))
      await seedSaved(page, [EMBER, CINDER])
      await openSavedView(page, [EMBER.job.title, CINDER.job.title])
      const before = (await committedById(page, EMBER.job.id))!
      await removeCardByKeyboard(page, EMBER)
      await expect(titleButton(page, CINDER)).toBeFocused()

      const digest = await holdRevisionDigest(page)
      await page.getByRole('button', { name: '게시 상태 확인', exact: true }).click()
      const filter = page.locator('.posting-filter select')
      await expect(filter).toBeEnabled()
      await filter.focus()
      await filter.selectOption('changed')
      await expect(page.locator('.saved-comparison-pending')).toBeVisible()
      await expect(page.locator('.saved-results-summary')).toHaveText('저장한 공고 내용을 비교하고 있어요.')
      await expect(recoveryRegion(page)).toHaveCount(1)
      expect(await recoveryRegion(page).evaluate(region => {
        const placeholder = document.querySelector('.saved-comparison-pending')!
        return Boolean(region.compareDocumentPosition(placeholder) & Node.DOCUMENT_POSITION_FOLLOWING)
      })).toBe(true)
      const entry = latestEntryOf(page, EMBER)
      await pressTabUntil(page, undoOf(entry), { max: 8 })
      await expectVisibleFocus(undoOf(entry))
      const survival = await expectFocusedControlSurvives(undoOf(entry))
      await attachShot(page, testInfo, 'comparison-pending-undo-focused')

      await installStorageProbe(page)
      await digest.release()
      await expect(page.locator('.saved-comparison-pending')).toHaveCount(0)
      await expect(page.locator('.saved-title')).toHaveText([CINDER.job.title])
      await expect(page.locator('.saved-results-summary')).toHaveText('1개 기회 중 1–1개 표시')
      await survival.verify()
      await expectRegionBeforeSavedGrid(page)
      expect(await storageProbe(page)).toMatchObject({ mutations: 0 })
      await expectAbsentFromStorage(page, EMBER.job.id)

      // The restored record needs its own content comparison. Hold that digest so the grid is replaced by the
      // placeholder when the receipt clears: with no restored title or save control on the page, D2 names the
      // collection search box as the focus target, and the comparison finishing later must not take it back.
      const secondDigest = await holdRevisionDigest(page)
      await page.keyboard.press('Enter')
      await expectCommittedExactly(page, EMBER, before)
      await expect(recoveryRegion(page)).toHaveCount(0)
      await expect(page.locator('.saved-comparison-pending')).toBeVisible()
      await expect(page.locator('.saved-title')).toHaveCount(0)
      await expect(savedSearch(page)).toBeFocused()
      await expectVisibleFocus(savedSearch(page), false)
      await attachShot(page, testInfo, 'comparison-restored-search-focused-while-comparing')

      await secondDigest.release()
      await expect(page.locator('.saved-comparison-pending')).toHaveCount(0)
      await expect(page.locator('.saved-title')).toHaveText([EMBER.job.title, CINDER.job.title])
      await expect(page.locator('.saved-results-summary')).toHaveText('2개 기회 중 1–2개 표시')
      await expect(savedSearch(page)).toBeFocused()
      await expect(navCount(page)).toHaveText('2')
    })
  })
})

test.describe('A80-P01-3: a generic modal hands the storage retry to the feedback host', () => {
  test('after dismissing a failed restore, the profile dialog’s retry drains the queue, keeps the draft and focuses Close', async ({ page }, testInfo) => {
    await seedSaved(page, [EMBER])
    await openSavedView(page, [EMBER.job.title])
    const before = (await committedById(page, EMBER.job.id))!
    await removeCardByKeyboard(page, EMBER)
    const fault = await installStoreFault(page, 'put')
    await undoOf(latestEntryOf(page, EMBER)).click()
    await expect(waitText(pendingEntryOf(page, EMBER), WAITING_WITH_STORAGE_FAILURE)).toBeVisible()
    await expect(page.getByRole('alert')).toContainText(UNSAVED_CHANGES)
    expect(await fault.attempts()).toBe(1)

    await page.getByRole('button', { name: '내 프로필 편집', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: PROFILE_DIALOG, exact: true })
    await expect(dialog).toBeVisible()
    await expectRegionInsideDialog(page, dialog)
    await expect(pendingEntryOf(dialog, EMBER)).toBeVisible()
    await expect(page.getByRole('alert')).toHaveCount(1)
    await expect(dialog.getByRole('alert')).toContainText(UNSAVED_CHANGES)
    await expect(storageRetry(dialog)).toBeVisible()
    // The profile opens on its resume tab; the LinkedIn address field is rendered only under the LinkedIn tab.
    const linkedinTab = dialog.getByRole('button', { name: 'LinkedIn', exact: true })
    await linkedinTab.click()
    await expect(linkedinTab).toHaveAttribute('aria-pressed', 'true')
    const linkedin = dialog.getByLabel(/^LinkedIn 프로필 주소/)
    await expect(linkedin).toBeVisible()
    await expect(linkedin).toBeEnabled()
    await linkedin.fill(LINKEDIN_DRAFT)
    await attachShot(page, testInfo, 'profile-dialog-pending-and-storage-notice')

    await pressTabUntil(page, dismissOf(pendingEntryOf(dialog, EMBER)), { shift: true, max: 12 })
    await page.keyboard.press('Enter')
    await expect(recoveryRegion(page)).toHaveCount(0)
    await expect(closeButton(dialog)).toBeFocused()
    await expect(dialog.getByRole('alert')).toContainText(UNSAVED_CHANGES)
    await expectAbsentFromStorage(page, EMBER.job.id)

    await fault.restore()
    await pressTabUntil(page, storageRetry(dialog), { max: 4 })
    await page.keyboard.press('Enter')
    await expectCommittedExactly(page, EMBER, before)
    await expect(page.getByRole('alert')).toHaveCount(0)
    await expect(closeButton(dialog)).toBeFocused()
    await expect(dialog).toBeVisible()
    await expect(linkedin).toHaveValue(LINKEDIN_DRAFT)
    await expect(navCount(page)).toHaveText('1')
    expect(await fault.attempts()).toBe(1)
    await attachShot(page, testInfo, 'profile-dialog-after-generic-retry')

    await closeButton(dialog).click()
    await expect(dialog).toHaveCount(0)
    await expect(page.locator('.saved-title')).toHaveText([EMBER.job.title])
    await expect(recoveryRegion(page)).toHaveCount(0)
  })
})

test.describe('busy admission: Undo while a file import is committed but unacknowledged', () => {
  const IMPORTED: SavedJob = {
    ...CINDER,
    job: { ...CINDER.job, id: 'greenhouse-cinder-works-85', title: 'Cinder 85 · Imported Engineer', url: 'https://example.org/undo80/greenhouse-cinder-works-85' },
    savedAt: '2026-09-30T10:00:00.000Z', status: 'saved', note: 'PRIVATE-UNDO80 imported from a backup file while recovery was offered',
  }
  const BACKUP_FILE = JSON.stringify({
    format: 'orbit-saved-backup', version: 1, exportedAt: '2026-10-01T18:00:00.000Z', includesUnsavedChanges: false, records: [IMPORTED],
  }, null, 2)
  const BUSY_HELP = '파일을 반영하고 있어요. 완료된 뒤 다시 시도해 주세요.'
  const APPLYING = '기록을 반영하고 있어요…'

  test('the backup dialog hosts L; Undo during the held import is rejected with the busy reason and keeps the original, which settles after the import completes', async ({ page }, testInfo) => {
    await seedSaved(page, [EMBER])
    await openSavedView(page, [EMBER.job.title])
    const before = (await committedById(page, EMBER.job.id))!
    await removeCardByKeyboard(page, EMBER)
    await page.getByRole('button', { name: '기록 백업·복원', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '기록 백업과 복원', exact: true })
    await expect(dialog).toBeVisible()
    await expectRegionInsideDialog(page, dialog)
    await dialog.getByLabel('백업 또는 복구 파일', { exact: true }).setInputFiles({ name: 'undo80-backup.json', mimeType: 'application/json', buffer: Buffer.from(BACKUP_FILE) })
    const row = dialog.locator('.saved-import-row')
    await expect(row).toHaveCount(1)
    await expect(row).toContainText(`${IMPORTED.company.name} · ${IMPORTED.job.title}`)
    await expect(row.getByRole('checkbox')).toBeChecked()

    // The import transaction commits natively; its acknowledgement is held, so the application stays in its applying state.
    const hold = await holdCompletionDelivery(page)
    await dialog.getByRole('button', { name: '선택한 1개 가져오기', exact: true }).click()
    await expect(dialog.locator('.saved-data-footer')).toContainText(APPLYING)
    await expectNativeCompletions(hold, 1)
    expect((await readCommitted(page)).map(record => record.job.id)).toEqual([IMPORTED.job.id])
    await expect(dialog.getByLabel('백업 또는 복구 파일', { exact: true })).toBeDisabled()

    await undoOf(latestEntryOf(dialog, EMBER)).click()
    const pending = pendingEntryOf(dialog, EMBER)
    await expect(messageOf(pending)).toHaveText(BUSY_HELP)
    await expect(retryOf(pending)).toBeEnabled()
    await expect(pending.getByLabel('원래 메모', { exact: true })).toContainText('PRIVATE-UNDO80 ask about the Ember runtime team before applying')
    await expect(pending.locator('.saved-removal-meta')).toHaveText(/^지원 완료 · .+ 저장$/)
    await expect(dialog.locator('.saved-data-footer')).toContainText(APPLYING)
    expect((await readCommitted(page)).map(record => record.job.id)).toEqual([IMPORTED.job.id])
    await attachShot(page, testInfo, 'busy-import-undo-rejected-original-pinned')

    await hold.release()
    await expect(dialog.locator('.saved-file-message')).toContainText('선택한 1개 기록을 저장했어요.')
    await expect(dialog.locator('.saved-data-footer')).not.toContainText(APPLYING)
    await expect(navCount(page)).toHaveText('1')
    await expect(pendingEntryOf(dialog, EMBER)).toBeVisible()
    await expect(messageOf(pendingEntryOf(dialog, EMBER))).toHaveText(BUSY_HELP)

    await retryOf(pendingEntryOf(dialog, EMBER)).focus()
    await page.keyboard.press('Enter')
    await waitForSavedCommit(page)
    await expectCommittedExactly(page, EMBER, before)
    expect(await committedById(page, IMPORTED.job.id)).toMatchObject(literalOf(IMPORTED))
    expect((await readSaved(page)).map(record => record.job.id).sort()).toEqual([EMBER.job.id, IMPORTED.job.id].sort())
    await expect(recoveryRegion(page)).toHaveCount(0)
    await expect(closeButton(dialog)).toBeFocused()
    await expect(navCount(page)).toHaveText('2')
    await expectNoStorageIssue(page)
  })
})

test.describe('D2 §표시 6: a late storage result never steals focus', () => {
  test('page: the user moves into the search box before the restore is acknowledged; the commit lands, focus and typed text stay', async ({ page }, testInfo) => {
    await seedSaved(page, [EMBER])
    await openSavedView(page, [EMBER.job.title])
    const before = (await committedById(page, EMBER.job.id))!
    await removeCardByKeyboard(page, EMBER)
    await expect(savedSearch(page)).toBeFocused()
    const hold = await holdCompletionDelivery(page)
    const entry = latestEntryOf(page, EMBER)
    await pressTabUntil(page, undoOf(entry), { max: 4 })
    await page.keyboard.press('Enter')
    await savedSearch(page).click()
    await page.keyboard.type('Ember')

    const pending = pendingEntryOf(page, EMBER)
    await expect(pending).toBeVisible()
    await expect(waitText(pending, WAITING_FOR_COMMIT)).toBeVisible()
    // The native transaction has committed; the application's acknowledgement waits for the test's release.
    await expectNativeCompletions(hold, 1)
    expect((await readCommitted(page)).map(record => record.job.id)).toEqual([EMBER.job.id])
    expect((await readCommitted(page))[0]).toMatchObject(literalOf(EMBER))
    await expect(pending).toBeVisible()
    await expect(savedSearch(page)).toBeFocused()
    await expect(savedSearch(page)).toHaveValue('Ember')
    await attachShot(page, testInfo, 'late-result-page-typing-while-held')

    await hold.release()
    await expect(recoveryRegion(page)).toHaveCount(0)
    expect(await hold.delivered()).toBe(1)
    await expect(savedSearch(page)).toBeFocused()
    await expect(savedSearch(page)).toHaveValue('Ember')
    await expectCommittedExactly(page, EMBER, before)
    await expect(page.locator('.saved-title')).toHaveText([EMBER.job.title])
    await expect(navCount(page)).toHaveText('1')
    await expectNoStorageIssue(page)
  })

  test('detail: the user moves to the original-posting link before the restore is acknowledged; the link keeps focus and the saved footer appears', async ({ page }, testInfo) => {
    await seedSaved(page, [EMBER])
    await openSavedView(page, [EMBER.job.title])
    const before = (await committedById(page, EMBER.job.id))!
    const dialog = await openDetailByKeyboard(page, EMBER)
    await footerToggle(dialog).focus()
    await page.keyboard.press('Enter')
    await expect(footerToggle(dialog)).toHaveText('제거 취소')
    await expectAbsentFromStorage(page, EMBER.job.id)
    await expect(footerToggle(dialog)).toBeFocused()

    const hold = await holdCompletionDelivery(page)
    const entry = latestEntryOf(dialog, EMBER)
    // Footer toggle → original-posting link → (dialog boundary wraps) Close → Undo.
    await pressTabUntil(page, undoOf(entry), { max: 4 })
    await page.keyboard.press('Enter')
    // Shift+Tab leaves the now-disabled action for Close; the dialog's focus boundary then wraps to its last control, the footer link.
    const link = dialog.getByRole('link', { name: '원문에서 지원하기', exact: true })
    await pressTabUntil(page, link, { shift: true, max: 3 })

    const pending = pendingEntryOf(dialog, EMBER)
    await expect(pending).toBeVisible()
    await expect(waitText(pending, WAITING_FOR_COMMIT)).toBeVisible()
    await expectNativeCompletions(hold, 1)
    expect((await readCommitted(page)).map(record => record.job.id)).toEqual([EMBER.job.id])
    await expect(pending).toBeVisible()
    await expect(link).toBeFocused()
    await attachShot(page, testInfo, 'late-result-dialog-link-focused-while-held')

    await hold.release()
    await expect(recoveryRegion(page)).toHaveCount(0)
    expect(await hold.delivered()).toBe(1)
    await expect(link).toBeFocused()
    await expect(closeButton(dialog)).not.toBeFocused()
    await expect(footerToggle(dialog)).toHaveText('저장 목록에서 제거')
    await expect(noteField(dialog)).toHaveValue(EMBER.note)
    await expect(appliedMarker(dialog)).toBeVisible()
    await expectCommittedExactly(page, EMBER, before)
    await expect(navCount(page)).toHaveText('1')
    await expectNoStorageIssue(page)
  })
})
