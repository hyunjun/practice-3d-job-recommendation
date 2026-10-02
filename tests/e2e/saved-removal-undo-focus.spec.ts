/**
 * Stage80 D2 recovery focus and geometry at 1440px and 320px. Real Tab, Shift+Tab,
 * Enter, Escape, backdrop and pointer interactions only; no programmatic focus is
 * used as a substitute for a reachability claim. Focus targets follow the approved
 * contract: a focused recovery action that disappears moves focus to the modal's
 * neutral Close, or on the page to the restored card title, the live original
 * save control, the first current-page title, then search / empty state / main;
 * never to body, an inert background or a removed node.
 */
import { expect } from '@playwright/test'
import type { Page } from '@playwright/test'
import { waitForSavedCommit } from './helpers/saved-store'
import {
  CINDER, EMBER, EXPLORE_CLOCK, LONG_NAMES, activeElementDescriptor, attachShot, cardOf, cardRemoveButton, closeButton, committedById, dismissOf,
  entryName, expectAbsentFromStorage, expectCommittedExactly, expectReadable, expectRegionBeforeSavedGrid, expectRegionInsideDialog,
  expectRegionInsideResultsPanel, expectVisibleFocus, footerToggle, latestEntryOf, navCount, noteField, openDetailByKeyboard, openSavedView,
  pageScroll, pauseContextClock, pressTabUntil, queueFrameProbe, recoveryEntry, recoveryRegion, removeCardByKeyboard, savedSearch, seedSaved, test,
  titleButton, undoOf,
} from './helpers/saved-removal-undo'

async function closeByBackdrop(page: Page) {
  const dialog = page.getByRole('dialog')
  const box = await dialog.boundingBox()
  expect(box).not.toBeNull()
  expect(box!.x).toBeGreaterThan(8)
  await page.mouse.click(box!.x / 2, box!.y + box!.height / 2)
  await expect(dialog).toHaveCount(0)
}

for (const viewport of [{ width: 1440, height: 960 }, { width: 320, height: 800 }]) {
  test.describe(`recovery focus and geometry at ${viewport.width}px`, () => {
    test.use({ viewport, hasTouch: viewport.width === 320 })

    test('removing a focused card moves focus to the first surviving title, the panel is two Shift+Tabs away and Undo focuses the restored title', async ({ page }, testInfo) => {
      await seedSaved(page, [EMBER, CINDER])
      await openSavedView(page, [EMBER.job.title, CINDER.job.title])
      const before = (await committedById(page, EMBER.job.id))!
      await removeCardByKeyboard(page, EMBER)
      await expect(page.locator('.saved-title')).toHaveText([CINDER.job.title])
      // The card that owned focus is gone; the first surviving title takes it (non-clamping removal).
      await expectVisibleFocus(titleButton(page, CINDER))
      await expectRegionBeforeSavedGrid(page)
      const entry = recoveryEntry(page, EMBER)
      const presses = await pressTabUntil(page, dismissOf(entry), { shift: true, max: 2 })
      await testInfo.attach(`shift-tabs-to-last-recovery-action-${viewport.width}`, { body: JSON.stringify({ presses }), contentType: 'application/json' })
      await expectVisibleFocus(dismissOf(entry))
      await page.keyboard.press('Shift+Tab')
      await expectVisibleFocus(undoOf(entry))
      await attachShot(page, testInfo, `page-undo-focus-${viewport.width}`)
      await page.keyboard.press('Enter')
      await waitForSavedCommit(page)
      await expectCommittedExactly(page, EMBER, before)
      await expect(recoveryRegion(page)).toHaveCount(0)
      await expect(page.locator('.saved-title')).toHaveText([EMBER.job.title, CINDER.job.title])
      await expectVisibleFocus(titleButton(page, EMBER))
      await attachShot(page, testInfo, `page-restored-title-focus-${viewport.width}`)
    })

    test('dismissing the latest removal by keyboard focuses the first surviving title, or the search box once the collection is empty', async ({ page }, testInfo) => {
      await seedSaved(page, [EMBER, CINDER])
      await openSavedView(page, [EMBER.job.title, CINDER.job.title])
      await removeCardByKeyboard(page, EMBER)
      await expectVisibleFocus(titleButton(page, CINDER))
      await pressTabUntil(page, dismissOf(recoveryEntry(page, EMBER)), { shift: true, max: 2 })
      await page.keyboard.press('Enter')
      await expect(recoveryRegion(page)).toHaveCount(0)
      await expectVisibleFocus(titleButton(page, CINDER))
      await expectAbsentFromStorage(page, EMBER.job.id)

      await removeCardByKeyboard(page, CINDER)
      await expect(page.locator('.saved-card')).toHaveCount(0)
      await expect(page.getByText('다음 챕터의 첫 기회를 저장해 보세요', { exact: true })).toBeVisible()
      // No title survives: the search box is the next live target, never body.
      await expectVisibleFocus(savedSearch(page))
      const entry = recoveryEntry(page, CINDER)
      await expect(entry).toBeVisible()
      await expect(recoveryRegion(page).evaluate(element => element.closest('main#main-content') !== null)).resolves.toBe(true)
      const presses = await pressTabUntil(page, dismissOf(entry), { max: 6 })
      await testInfo.attach(`tabs-from-search-to-dismiss-${viewport.width}`, { body: JSON.stringify({ presses }), contentType: 'application/json' })
      await expectVisibleFocus(dismissOf(entry))
      await attachShot(page, testInfo, `empty-collection-recovery-${viewport.width}`)
      await page.keyboard.press('Enter')
      await expect(recoveryRegion(page)).toHaveCount(0)
      await expectVisibleFocus(savedSearch(page))
      await expect(navCount(page)).toHaveCount(0)
    })

    test('inside the detail, keyboard removal keeps focus on the footer, Undo returns focus to Close and dismissal does too', async ({ page }, testInfo) => {
      await seedSaved(page, [EMBER])
      await openSavedView(page, [EMBER.job.title])
      const before = (await committedById(page, EMBER.job.id))!
      const dialog = await openDetailByKeyboard(page, EMBER)
      await closeButton(dialog).focus()
      await pressTabUntil(page, footerToggle(dialog), { max: 60 })
      await expectVisibleFocus(footerToggle(dialog))
      await expect(footerToggle(dialog)).toHaveText('저장 목록에서 제거')
      await page.keyboard.press('Enter')
      await waitForSavedCommit(page)
      await expectAbsentFromStorage(page, EMBER.job.id)
      // Appearance of the recovery never steals focus from the activated control.
      await expectVisibleFocus(footerToggle(dialog))
      await expect(footerToggle(dialog)).toHaveText('제거 취소')
      await expectRegionInsideDialog(page, dialog)

      const entry = recoveryEntry(dialog, EMBER)
      const toUndo = await pressTabUntil(page, undoOf(entry), { max: 4 })
      await testInfo.attach(`dialog-tabs-to-undo-${viewport.width}`, { body: JSON.stringify({ toUndo }), contentType: 'application/json' })
      await expectVisibleFocus(undoOf(entry))
      await page.keyboard.press('Enter')
      await waitForSavedCommit(page)
      await expectCommittedExactly(page, EMBER, before)
      await expect(recoveryRegion(page)).toHaveCount(0)
      await expectVisibleFocus(closeButton(dialog), false)
      await expect(noteField(dialog)).toHaveValue(EMBER.note)

      // Remove again, then dismiss the recovery by keyboard: Close takes focus and the footer offers an ordinary save.
      await pressTabUntil(page, footerToggle(dialog), { max: 60 })
      await page.keyboard.press('Enter')
      await waitForSavedCommit(page)
      await expectAbsentFromStorage(page, EMBER.job.id)
      const dismiss = dismissOf(recoveryEntry(dialog, EMBER))
      await pressTabUntil(page, dismiss, { max: 5 })
      await expectVisibleFocus(dismiss)
      await attachShot(page, testInfo, `dialog-dismiss-focus-${viewport.width}`)
      await page.keyboard.press('Enter')
      await expect(recoveryRegion(page)).toHaveCount(0)
      await expectVisibleFocus(closeButton(dialog), false)
      await expect(footerToggle(dialog)).toHaveText('기회 저장')
      await expectAbsentFromStorage(page, EMBER.job.id)
    })

    test('Escape and a backdrop click keep the candidate while the host moves between the modal and the page', async ({ page }, testInfo) => {
      await seedSaved(page, [EMBER, CINDER])
      await openSavedView(page, [EMBER.job.title, CINDER.job.title])
      const before = (await committedById(page, EMBER.job.id))!
      const emberDetail = await openDetailByKeyboard(page, EMBER)
      await footerToggle(emberDetail).click()
      await waitForSavedCommit(page)
      await expectAbsentFromStorage(page, EMBER.job.id)
      await expectRegionInsideDialog(page, emberDetail)
      await page.keyboard.press('Escape')
      await expect(emberDetail).toHaveCount(0)
      await expectRegionBeforeSavedGrid(page)
      await expect(recoveryEntry(page, EMBER)).toBeVisible()

      const cinderDetail = await openDetailByKeyboard(page, CINDER)
      await expectRegionInsideDialog(page, cinderDetail)
      await expect(latestEntryOf(cinderDetail, EMBER)).toBeVisible()
      await closeByBackdrop(page)
      await expectRegionBeforeSavedGrid(page)
      await attachShot(page, testInfo, `host-moved-back-to-page-${viewport.width}`)
      await undoOf(recoveryEntry(page, EMBER)).click()
      await waitForSavedCommit(page)
      await expectCommittedExactly(page, EMBER, before)
      await expect(recoveryRegion(page)).toHaveCount(0)
      await expect(cardOf(page, EMBER)).toHaveCount(1)
    })

    /**
     * Guard regressions for the deferred close-focus reveal. The Playwright Clock
     * installed by seedSaved (it operates throughout the BrowserContext and
     * controls timers, Date/performance, idle callbacks and animation frames
     * alike) is paused only after the removal has fully settled, so a real user
     * action can deterministically land between the synchronous focus
     * restoration and the frame-deferred reveal; a plain probe queued through the
     * same scheduler witnesses that no frame ran before the explicit 32 ms
     * advance. The automatic-visibility case in dialog-focus.spec.ts stays the
     * primary, uninstrumented regression; these cases only prove that an
     * intervening action is never undone by the later reveal in a loaded, idle
     * Saved view, not every real event ordering.
     */
    test('an independent Shift+Tab before the deferred reveal keeps its own focus and scroll; the hidden fallback is not revealed later', async ({ page }, testInfo) => {
      await seedSaved(page, [EMBER])
      await openSavedView(page, [EMBER.job.title])
      const dialog = await openDetailByKeyboard(page, EMBER)
      await footerToggle(dialog).focus()
      await page.keyboard.press('Enter')
      await expect(footerToggle(dialog)).toHaveText('제거 취소')
      // Both the saved-commit signal and the committed absence settle before the clock pauses.
      await waitForSavedCommit(page)
      await expectAbsentFromStorage(page, EMBER.job.id)
      const explore = page.getByRole('button', { name: '기회 탐색하기', exact: true })
      const dismiss = dismissOf(latestEntryOf(page, EMBER))
      await pauseContextClock(page)
      try {
        const probe = await queueFrameProbe(page)
        await page.keyboard.press('Escape')
        await expect(dialog).toHaveCount(0)
        await expect(explore).toBeFocused()
        // The relocated recovery panel sits above the empty state, so the restored fallback starts
        // outside the viewport: an unguarded reveal would visibly move the page.
        await expect(explore).not.toBeInViewport()
        expect(await probe.fired()).toBe(false)

        await page.keyboard.press('Shift+Tab')
        await expectVisibleFocus(dismiss)
        const scrollBefore = await pageScroll(page)
        await attachShot(page, testInfo, `guard-independent-focus-paused-${viewport.width}`)
        expect(await probe.fired()).toBe(false)

        await page.clock.runFor(32)
        expect(await probe.fired()).toBe(true)
        await expectVisibleFocus(dismiss)
        expect(await pageScroll(page)).toEqual(scrollBefore)
        await expect(explore).not.toBeInViewport()
        await attachShot(page, testInfo, `guard-independent-focus-advanced-${viewport.width}`)
      } finally {
        await page.clock.resume()
      }
      await expect(latestEntryOf(page, EMBER)).toBeVisible()
      await expectAbsentFromStorage(page, EMBER.job.id)
    })

    test('a dialog opened before the deferred reveal keeps its own focus and scroll, and the page behind it is not moved', async ({ page }, testInfo) => {
      await seedSaved(page, [EMBER])
      await openSavedView(page, [EMBER.job.title])
      const dialog = await openDetailByKeyboard(page, EMBER)
      await footerToggle(dialog).focus()
      await page.keyboard.press('Enter')
      await expect(footerToggle(dialog)).toHaveText('제거 취소')
      // Both the saved-commit signal and the committed absence settle before the clock pauses.
      await waitForSavedCommit(page)
      await expectAbsentFromStorage(page, EMBER.job.id)
      const explore = page.getByRole('button', { name: '기회 탐색하기', exact: true })
      const backup = page.getByRole('dialog', { name: '기록 백업과 복원', exact: true })
      await pauseContextClock(page)
      try {
        const probe = await queueFrameProbe(page)
        await page.keyboard.press('Escape')
        await expect(dialog).toHaveCount(0)
        await expect(explore).toBeFocused()
        await expect(explore).not.toBeInViewport()
        expect(await probe.fired()).toBe(false)

        await page.getByRole('button', { name: '기록 백업·복원', exact: true }).click()
        await expect(backup).toBeVisible()
        const focusBefore = await activeElementDescriptor(page)
        expect(focusBefore.insideOpenDialog).toBe(true)
        const scrollBefore = await pageScroll(page)
        const dialogScrollBefore = await backup.evaluate(element => element.scrollTop)
        await attachShot(page, testInfo, `guard-new-dialog-paused-${viewport.width}`)
        expect(await probe.fired()).toBe(false)

        await page.clock.runFor(32)
        expect(await probe.fired()).toBe(true)
        await expect(backup).toBeVisible()
        expect(await activeElementDescriptor(page)).toEqual(focusBefore)
        expect(await pageScroll(page)).toEqual(scrollBefore)
        expect(await backup.evaluate(element => element.scrollTop)).toBe(dialogScrollBefore)
        await attachShot(page, testInfo, `guard-new-dialog-advanced-${viewport.width}`)
      } finally {
        await page.clock.resume()
      }
      await page.keyboard.press('Escape')
      await expect(backup).toHaveCount(0)
      await expect(latestEntryOf(page, EMBER)).toBeVisible()
      await expectAbsentFromStorage(page, EMBER.job.id)
    })
  })
}

test.describe('narrow viewport readability beside the bottom navigation and an ordinary toast', () => {
  test.use({ viewport: { width: 320, height: 800 }, hasTouch: true, apiPolicy: 'catalog-reads' })

  test('long company and posting names wrap, every recovery control stays readable and uncovered, and the alias survives an ordinary toast', async ({ page, recoveryDiagnostics }, testInfo) => {
    // This case navigates to explore: like the other exploring cases it runs at EXPLORE_CLOCK so the catalog stays fresh.
    await seedSaved(page, [LONG_NAMES], { clock: EXPLORE_CLOCK })
    await openSavedView(page, [LONG_NAMES.job.title])
    const before = (await committedById(page, LONG_NAMES.job.id))!
    const remove = cardRemoveButton(page, LONG_NAMES)
    await remove.focus()
    await page.keyboard.press('Enter')
    await waitForSavedCommit(page)
    await expectAbsentFromStorage(page, LONG_NAMES.job.id)
    const entry = recoveryEntry(page, LONG_NAMES)
    await expect(entry).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await expectReadable(entry.getByRole('heading', { name: entryName(LONG_NAMES), exact: true }))
    await expectReadable(entry.getByLabel('원래 메모', { exact: true }))
    await expectReadable(undoOf(entry))
    await expectReadable(dismissOf(entry))
    const lineCount = await entry.getByRole('heading', { name: entryName(LONG_NAMES), exact: true }).evaluate(element => {
      const range = document.createRange()
      range.selectNodeContents(element)
      return new Set([...range.getClientRects()].map(rect => Math.round(rect.top))).size
    })
    expect(lineCount).toBeGreaterThanOrEqual(2)
    await attachShot(page, testInfo, 'narrow-recovery-wrapped-320')

    // Explore hosts the same candidate beside an ordinary toast; its controls stay reachable and uncovered.
    await page.getByRole('navigation', { name: '주요 메뉴' }).getByRole('button', { name: '기회 탐색', exact: true }).click()
    await expect(page.getByRole('button', { name: '공개 채용', exact: true })).toBeVisible()
    await page.getByRole('button', { name: '도시 목록 보기', exact: true }).click()
    // The long recovery panel legitimately precedes the city rows in normal flow at 320px; the user scrolls to their city.
    const london = page.getByRole('button', { name: /^런던, 추천 회사 \d+곳 보기$/ })
    await london.scrollIntoViewIfNeeded()
    await expect(london).toBeInViewport()
    await expectRegionInsideResultsPanel(page)
    expect(recoveryDiagnostics.traffic.requests.filter(request => new URL(request.url).pathname === '/api/catalog' && request.state === 'finished')).toHaveLength(1)
    await page.getByRole('button', { name: '런던 비교에 추가', exact: true }).click()
    await expect(page.locator('.toast')).toContainText('비교에 추가했어요')
    const exploreEntry = recoveryEntry(page, LONG_NAMES)
    await expectReadable(undoOf(exploreEntry))
    await expectReadable(dismissOf(exploreEntry))
    await attachShot(page, testInfo, 'narrow-recovery-beside-toast-320')
    await undoOf(exploreEntry).click()
    await waitForSavedCommit(page)
    await expectCommittedExactly(page, LONG_NAMES, before)
    await expect(recoveryRegion(page)).toHaveCount(0)
  })
})
