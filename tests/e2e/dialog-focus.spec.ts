import { expect, test } from '@playwright/test'
import type { Locator, Page } from '@playwright/test'
import {
  FIRST_TITLES, SAVED_PAGES_TIME, SECOND_TITLES, UNDO_SECOND_TITLES,
  expectPagerState, expectSavedPage, expectSavedTotals, openSavedPages, savedCard, savedPageRecords, savedPager,
} from './helpers/saved-pages'
import { readSaved, waitForSavedCommit } from './helpers/saved-store'
import { watchApiRequests } from './helpers/api-requests'

const AFTER_SEVENTEEN = [
  'Fable 13 · Backend Engineer', 'Fable 14 · Backend Engineer', 'Fable 15 · Backend Engineer',
  'Fable 16 · Backend Engineer', 'Fable 18 · Backend Engineer', 'Fable 19 · Backend Engineer',
  'Fable 20 · Backend Engineer', 'Fable 21 · Backend Engineer', 'Fable 22 · Backend Engineer',
  'Fable 23 · Backend Engineer', 'Fable 24 · Backend Engineer', 'Kite 25 · Backend Engineer',
]
const AFTER_SEVENTEEN_AND_EIGHTEEN = [
  'Fable 13 · Backend Engineer', 'Fable 14 · Backend Engineer', 'Fable 15 · Backend Engineer',
  'Fable 16 · Backend Engineer', 'Fable 19 · Backend Engineer', 'Fable 20 · Backend Engineer',
  'Fable 21 · Backend Engineer', 'Fable 22 · Backend Engineer', 'Fable 23 · Backend Engineer',
  'Fable 24 · Backend Engineer', 'Kite 25 · Backend Engineer',
]

const search = (page: Page) => page.getByRole('textbox', { name: '저장한 기회 검색', exact: true })
const title = (page: Page, name: string) => page.getByRole('button', { name, exact: true })
const footer = (page: Page, name: string) => savedCard(page, name).getByRole('button', { name: '자세히', exact: true })
const nextPage = (page: Page) => savedPager(page).getByRole('button', { name: '다음 저장 페이지', exact: true })

async function openDetail(page: Page, name: string, opener: 'title' | 'footer' = 'title') {
  const control = opener === 'title' ? title(page, name) : footer(page, name)
  await control.focus()
  await page.keyboard.press('Enter')
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole('heading', { name, exact: true })).toBeVisible()
  return dialog
}

async function closeDetail(page: Page, method: 'escape' | 'button' | 'touch-button' | 'backdrop' = 'escape') {
  const dialog = page.getByRole('dialog')
  if (method === 'touch-button') {
    await dialog.getByRole('button', { name: '닫기', exact: true }).tap()
  } else if (method === 'button') {
    await dialog.getByRole('button', { name: '닫기', exact: true }).focus()
    await page.keyboard.press('Enter')
  } else if (method === 'backdrop') {
    const box = await dialog.boundingBox()
    expect(box).not.toBeNull()
    expect(box!.x).toBeGreaterThan(8)
    await page.mouse.click(box!.x / 2, box!.y + box!.height / 2)
  } else {
    await page.keyboard.press('Escape')
  }
  await expect(dialog).toHaveCount(0)
  // Include any restoration scheduled by the closing render before checking
  // the final focus and beginning the next real keyboard interaction.
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
}

async function expectVisibleFocus(control: Locator, keyboard = true) {
  await expect(control).toBeFocused()
  await expect(control).toBeInViewport({ ratio: 1 })
  const state = await control.evaluate(element => {
    const box = element.getBoundingClientRect()
    const style = getComputedStyle(element)
    const nav = document.querySelector('.main-nav')
    const bottom = nav && getComputedStyle(nav).position === 'fixed' ? nav.getBoundingClientRect().top : innerHeight
    const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)
    return {
      top: box.top, bottom: box.bottom, left: box.left, right: box.right, limit: bottom, width: innerWidth,
      unobscured: hit === element || element.contains(hit),
      focusVisible: element.matches(':focus-visible'), outline: style.outlineStyle, outlineWidth: Number.parseFloat(style.outlineWidth),
      control: { tag: element.tagName, text: element.textContent, className: element.className },
      hit: hit ? { tag: hit.tagName, text: hit.textContent?.slice(0, 160), className: hit.getAttribute('class') } : null,
      notices: [...document.querySelectorAll('.toast')].map(notice => {
        const rect = notice.getBoundingClientRect()
        return { text: notice.textContent, top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right, height: rect.height }
      }),
    }
  })
  if (!state.unobscured || (keyboard && !state.focusVisible)) {
    await test.info().attach('focus-obstruction-geometry', { body: JSON.stringify(state), contentType: 'application/json' })
  }
  expect(state.top).toBeGreaterThanOrEqual(0)
  expect(state.bottom).toBeLessThanOrEqual(state.limit)
  expect(state.left).toBeGreaterThanOrEqual(0)
  expect(state.right).toBeLessThanOrEqual(state.width)
  expect(state.unobscured).toBe(true)
  if (keyboard) {
    expect(state.focusVisible).toBe(true)
    expect(state.outline).not.toBe('none')
    expect(state.outlineWidth).toBeGreaterThanOrEqual(2)
  }
}

async function continueFromTitle(page: Page, name: string) {
  await page.keyboard.press('Tab')
  await expectVisibleFocus(footer(page, name))
  await page.keyboard.press('Enter')
  await expect(page.getByRole('dialog').getByRole('heading', { name, exact: true })).toBeVisible()
  await closeDetail(page)
  await expectVisibleFocus(footer(page, name))
}

async function otherSavedPage(page: Page) {
  const other = await page.context().newPage()
  await other.clock.setFixedTime(new Date(SAVED_PAGES_TIME))
  return other
}

for (const viewport of [{ width: 1440, height: 960 }, { width: 320, height: 800 }]) {
  test.describe(`dialog focus after saved-result changes at ${viewport.width}px`, () => {
    test.use({ viewport, hasTouch: viewport.width === 320 })

    test('closing after the thirteenth note leaves the filter restores focus to the nearest surviving title, Fable 12', async ({ page }, testInfo) => {
      const traffic = watchApiRequests(page)
      await openSavedPages(page)
      const search = page.getByRole('textbox', { name: '저장한 기회 검색', exact: true })
      await search.fill('CohortNorth')
      await expectSavedPage(page, FIRST_TITLES, '13개 기회 중 1–12개 표시')
      await savedPager(page).getByRole('button', { name: '다음 저장 페이지', exact: true }).click()
      await expectSavedPage(page, ['Fable 13 · Backend Engineer'], '13개 기회 중 13–13개 표시')

      await page.getByRole('button', { name: 'Fable 13 · Backend Engineer', exact: true }).click()
      const dialog = page.getByRole('dialog', { name: 'Fable Labs', exact: true })
      await expect(dialog).toBeVisible()
      await dialog.getByLabel('이 기회에 대한 나의 메모', { exact: true }).fill('PRIVATE-SAVED54 moved to CohortSouth 13')
      await waitForSavedCommit(page)
      await page.keyboard.press('Escape')

      await expect(dialog).toHaveCount(0)
      await expectSavedPage(page, FIRST_TITLES, '12개 기회 중 1–12개 표시')
      await expectSavedTotals(page, [25, 13, 12])
      await expect(search).toHaveValue('CohortNorth')
      const records = await readSaved(page)
      expect(records).toHaveLength(25)
      expect(records.find(record => record.job.id === 'greenhouse-fable-labs-13')?.note).toBe('PRIVATE-SAVED54 moved to CohortSouth 13')
      await testInfo.attach('focus-after-disappeared-opener', {
        body: JSON.stringify(await page.evaluate(() => ({
          tag: document.activeElement?.tagName,
          className: document.activeElement?.className,
          bodyFocused: document.activeElement === document.body,
          firstTitleFocused: document.activeElement === document.querySelector('.saved-title'),
          searchFocused: document.activeElement === document.querySelector('[aria-label="저장한 기회 검색"]'),
        }))),
        contentType: 'application/json',
      })

      // Fable 13 was the last matching result. Fable 12 is the literal nearest
      // prior survivor on the clamped current page, regardless of DOM layout.
      await expect(page.getByRole('button', { name: 'Fable 12 · Backend Engineer', exact: true })).toBeFocused()
      await expectVisibleFocus(title(page, 'Fable 12 · Backend Engineer'))
      await testInfo.attach(`prior-survivor-focus-${viewport.width}`, { body: await page.screenshot(), contentType: 'image/png' })
      await continueFromTitle(page, 'Fable 12 · Backend Engineer')
      expect(traffic.requests).toEqual([])
    })

    test('connected title and footer openers retain their exact DOM focus and later page through keyboard dismissal', async ({ page }) => {
      const traffic = watchApiRequests(page)
      await openSavedPages(page)
      await nextPage(page).click()
      const before = await readSaved(page)
      const first = title(page, 'Fable 13 · Backend Engineer')
      const originalTitle = await first.elementHandle()
      await openDetail(page, 'Fable 13 · Backend Engineer')
      await closeDetail(page)
      expect(await originalTitle!.evaluate(element => element === document.activeElement && element.isConnected)).toBe(true)
      await expectVisibleFocus(first)

      const details = footer(page, 'Fable 13 · Backend Engineer')
      const originalFooter = await details.elementHandle()
      await openDetail(page, 'Fable 13 · Backend Engineer', 'footer')
      await closeDetail(page, 'button')
      expect(await originalFooter!.evaluate(element => element === document.activeElement && element.isConnected)).toBe(true)
      await expectVisibleFocus(details)
      await expect(first).not.toBeFocused()
      await expectSavedPage(page, SECOND_TITLES, '25개 기회 중 13–24개 표시')
      await expectPagerState(page, '3페이지 중 2페이지', false, false)
      expect(await readSaved(page)).toEqual(before)
      expect(traffic.requests).toEqual([])
    })

    test('a footer opener removed and recreated by note matching returns to the same job’s current title', async ({ page }) => {
      const traffic = watchApiRequests(page)
      await openSavedPages(page)
      await search(page).fill('CohortNorth')
      const before = await readSaved(page)
      const oldFooter = await footer(page, 'Fable 01 · Backend Engineer').elementHandle()
      const dialog = await openDetail(page, 'Fable 01 · Backend Engineer', 'footer')
      const note = dialog.getByLabel('이 기회에 대한 나의 메모', { exact: true })
      await note.fill('PRIVATE-SAVED54 temporarily outside the selected notes')
      await waitForSavedCommit(page)
      await expect(page.locator('.saved-results-summary')).toHaveText('12개 기회 중 1–12개 표시')
      await expect(page.locator('.saved-title').first()).toHaveText('Fable 02 · Backend Engineer')
      expect(await oldFooter!.evaluate(element => element.isConnected)).toBe(false)

      await note.fill('PRIVATE-SAVED53 CohortNorth note 01')
      await waitForSavedCommit(page)
      await expect(page.locator('.saved-results-summary')).toHaveText('13개 기회 중 1–12개 표시')
      await expect(page.locator('.saved-title').first()).toHaveText('Fable 01 · Backend Engineer')
      await closeDetail(page, 'button')
      await expectVisibleFocus(title(page, 'Fable 01 · Backend Engineer'))
      await expect(footer(page, 'Fable 01 · Backend Engineer')).not.toBeFocused()
      await expect(search(page)).toHaveValue('CohortNorth')
      await expectSavedPage(page, FIRST_TITLES, '13개 기회 중 1–12개 표시')
      expect(await readSaved(page)).toEqual(before)
      await continueFromTitle(page, 'Fable 01 · Backend Engineer')
      expect(traffic.requests).toEqual([])
    })

    test('excluding a middle result on page 2 chooses the next original result, Fable 18, without abandoning that page', async ({ page }) => {
      const traffic = watchApiRequests(page)
      await openSavedPages(page)
      await search(page).fill('PRIVATE-SAVED53')
      await nextPage(page).click()
      const dialog = await openDetail(page, 'Fable 17 · Backend Engineer')
      await dialog.getByLabel('이 기회에 대한 나의 메모', { exact: true }).fill('PRIVATE-SAVED54 hidden result 17')
      await waitForSavedCommit(page)
      await closeDetail(page)
      await expectSavedPage(page, AFTER_SEVENTEEN, '24개 기회 중 13–24개 표시')
      await expectPagerState(page, '2페이지 중 2페이지', false, true)
      await expectVisibleFocus(title(page, 'Fable 18 · Backend Engineer'))
      await expect(search(page)).toHaveValue('PRIVATE-SAVED53')
      await expectSavedTotals(page, [25, 13, 12])
      expect((await readSaved(page)).find(record => record.job.id === 'greenhouse-fable-labs-17')).toMatchObject({
        note: 'PRIVATE-SAVED54 hidden result 17', status: 'applied', savedAt: '2026-09-25T08:00:00.000Z',
      })
      await continueFromTitle(page, 'Fable 18 · Backend Engineer')
      expect(traffic.requests).toEqual([])
    })

    test('an applied-status edit removes the only later-page review result and returns to Fable 12 while retaining both filters', async ({ page }) => {
      const traffic = watchApiRequests(page)
      await openSavedPages(page)
      await search(page).fill('CohortNorth')
      await page.locator('.collection-tabs').getByRole('button', { name: /^검토 중/ }).click()
      await page.getByRole('combobox', { name: '게시 상태', exact: true }).selectOption('unknown')
      await nextPage(page).click()
      await expectSavedPage(page, ['Fable 13 · Backend Engineer'], '13개 기회 중 13–13개 표시')
      const dialog = await openDetail(page, 'Fable 13 · Backend Engineer', 'footer')
      await dialog.getByRole('button', { name: '지원 완료로 표시', exact: true }).click()
      await waitForSavedCommit(page)
      await closeDetail(page, 'button')
      await expectSavedPage(page, FIRST_TITLES, '12개 기회 중 1–12개 표시')
      await expectVisibleFocus(title(page, 'Fable 12 · Backend Engineer'))
      await expect(search(page)).toHaveValue('CohortNorth')
      await expect(page.getByRole('combobox', { name: '게시 상태', exact: true })).toHaveValue('unknown')
      await expectSavedTotals(page, [25, 12, 13])
      expect((await readSaved(page)).find(record => record.job.id === 'greenhouse-fable-labs-13')).toMatchObject({
        status: 'applied', note: 'PRIVATE-SAVED53 CohortNorth note 13',
      })
      await continueFromTitle(page, 'Fable 12 · Backend Engineer')
      expect(traffic.requests).toEqual([])
    })

    test('removing the twenty-fifth record inside its detail returns to Fable 24 on the clamped second page', async ({ page }, testInfo) => {
      const traffic = watchApiRequests(page)
      await openSavedPages(page)
      await savedPager(page).getByRole('button', { name: '마지막 저장 페이지', exact: true }).click()
      await expectSavedPage(page, ['Kite 25 · Backend Engineer'], '25개 기회 중 25–25개 표시')
      const dialog = await openDetail(page, 'Kite 25 · Backend Engineer')
      await dialog.getByRole('button', { name: '저장됨', exact: true }).click()
      await waitForSavedCommit(page)
      await expect(dialog.getByRole('button', { name: '기회 저장', exact: true })).toBeEnabled()
      await closeDetail(page, 'button')
      await expectSavedPage(page, SECOND_TITLES, '24개 기회 중 13–24개 표시')
      await expectPagerState(page, '2페이지 중 2페이지', false, true)
      await expectVisibleFocus(title(page, 'Fable 24 · Backend Engineer'))
      await expectSavedTotals(page, [24, 13, 11])
      expect((await readSaved(page)).map(record => record.job.id)).not.toContain('greenhouse-paper-kite-25')
      const notice = page.locator('.toast').filter({ hasText: '저장한 기회에서 제거했어요.' })
      await expect(notice).toBeVisible()
      const undo = notice.getByRole('button', { name: '실행 취소', exact: true })
      await expect(undo).toBeVisible()
      await page.keyboard.press('Tab')
      await expectVisibleFocus(footer(page, 'Fable 24 · Backend Engineer'))
      await expect(notice).toBeVisible()
      await expect(undo).toBeEnabled()
      if (viewport.width === 320) await testInfo.attach('live-undo-footer-focus-320', { body: await page.screenshot(), contentType: 'image/png' })
      await page.keyboard.press('Enter')
      await expect(page.getByRole('dialog').getByRole('heading', { name: 'Fable 24 · Backend Engineer', exact: true })).toBeVisible()
      await closeDetail(page)
      await expectVisibleFocus(footer(page, 'Fable 24 · Backend Engineer'))
      await expect(notice).toBeVisible()
      await undo.focus()
      await expectVisibleFocus(undo)
      await page.keyboard.press('Enter')
      await expect(notice).toHaveCount(0)
      await expectSavedPage(page, UNDO_SECOND_TITLES, '25개 기회 중 13–24개 표시')
      await expectPagerState(page, '3페이지 중 2페이지', false, false)
      await expectSavedTotals(page, [25, 13, 12])
      expect((await readSaved(page)).find(record => record.job.id === 'greenhouse-paper-kite-25')).toMatchObject({
        status: 'applied', savedAt: '2026-09-25T08:00:00.000Z',
        note: '=1+2\nPRIVATE-SAVED53 CohortSouth Needle25, "가상 메모" 🌕',
      })
      expect(traffic.requests).toEqual([])
    })

    test('zero filtered matches return to saved search and keyboard input can recover a later result', async ({ page }) => {
      const traffic = watchApiRequests(page)
      await openSavedPages(page)
      await search(page).fill('Needle25')
      await expectSavedPage(page, ['Kite 25 · Backend Engineer'], '1개 기회 중 1–1개 표시')
      const dialog = await openDetail(page, 'Kite 25 · Backend Engineer', 'footer')
      await dialog.getByLabel('이 기회에 대한 나의 메모', { exact: true }).fill('PRIVATE-SAVED54 no unique marker')
      await waitForSavedCommit(page)
      await closeDetail(page)
      await expectSavedPage(page, [], '0개 기회')
      await expect(page.getByText('검색에 맞는 저장한 기회가 없어요', { exact: true })).toBeVisible()
      await expectVisibleFocus(search(page))
      await expect(search(page)).toHaveValue('Needle25')
      await expectSavedTotals(page, [25, 13, 12])

      await page.keyboard.press('ControlOrMeta+A')
      await page.keyboard.type('CohortNorth')
      await expectSavedPage(page, FIRST_TITLES, '13개 기회 중 1–12개 표시')
      await page.keyboard.press('Tab')
      await expectVisibleFocus(nextPage(page))
      await page.keyboard.press('Enter')
      await expectSavedPage(page, ['Fable 13 · Backend Engineer'], '13개 기회 중 13–13개 표시')
      await expectVisibleFocus(title(page, 'Fable 13 · Backend Engineer'))
      expect(traffic.requests).toEqual([])
    })

    test('removing the entire saved collection returns to the empty-state explore action and Enter continues exploration', async ({ page }, testInfo) => {
      const traffic = watchApiRequests(page)
      await openSavedPages(page, 1)
      const dialog = await openDetail(page, 'Fable 01 · Backend Engineer')
      await dialog.getByRole('button', { name: '저장됨', exact: true }).click()
      await waitForSavedCommit(page)
      await closeDetail(page)
      await expectSavedPage(page, [], '0개 기회')
      await expect(page.locator('.collection-tabs button')).toHaveText(['전체0', '검토 중0', '지원 완료0'])
      await expect(page.locator('.main-nav .nav-count')).toHaveCount(0)
      await expect(page.getByText('다음 챕터의 첫 기회를 저장해 보세요', { exact: true })).toBeVisible()
      const explore = page.getByRole('button', { name: '기회 탐색하기', exact: true })
      await expectVisibleFocus(explore)
      await expect(search(page)).not.toBeFocused()
      expect(await readSaved(page)).toEqual([])
      if (viewport.width === 320) await testInfo.attach('empty-collection-focus-320', { body: await page.screenshot(), contentType: 'image/png' })
      await page.keyboard.press('Enter')
      await expect(page.getByRole('textbox', { name: '도시, 회사 또는 포지션 검색', exact: true })).toBeVisible()
      await expect(page.locator('.main-nav').getByRole('button', { name: '기회 탐색', exact: true })).toHaveAttribute('aria-current', 'page')
      expect(traffic.requests).toEqual([])
    })

    test('another tab removing the opener and its next neighbour restores Fable 19 on the still-valid current page', async ({ page }) => {
      const traffic = watchApiRequests(page)
      await openSavedPages(page)
      await search(page).fill('PRIVATE-SAVED53')
      await nextPage(page).click()
      await openDetail(page, 'Fable 17 · Backend Engineer', 'footer')
      const other = await otherSavedPage(page)
      const otherTraffic = watchApiRequests(other)
      try {
        await other.goto('/#saved')
        await waitForSavedCommit(other)
        await search(other).fill('Fable 17')
        await savedCard(other, 'Fable 17 · Backend Engineer').getByRole('button', { name: 'Fable Labs 저장 취소', exact: true }).click()
        await waitForSavedCommit(other)
        await search(other).fill('Fable 18')
        await savedCard(other, 'Fable 18 · Backend Engineer').getByRole('button', { name: 'Fable Labs 저장 취소', exact: true }).click()
        await waitForSavedCommit(other)
        await expect(page.locator('.saved-results-summary')).toHaveText('23개 기회 중 13–23개 표시')
        await expect(page.locator('.saved-title')).toHaveText(AFTER_SEVENTEEN_AND_EIGHTEEN)
        await closeDetail(page, viewport.width === 1440 ? 'backdrop' : 'touch-button')
        await expectSavedPage(page, AFTER_SEVENTEEN_AND_EIGHTEEN, '23개 기회 중 13–23개 표시')
        await expectPagerState(page, '2페이지 중 2페이지', false, true)
        await expectVisibleFocus(title(page, 'Fable 19 · Backend Engineer'), false)
        await expect(search(page)).toHaveValue('PRIVATE-SAVED53')
        await expectSavedTotals(page, [23, 13, 10])
        const ids = (await readSaved(page)).map(record => record.job.id)
        expect(ids).toHaveLength(23)
        expect(ids).not.toContain('greenhouse-fable-labs-17')
        expect(ids).not.toContain('greenhouse-fable-labs-18')
        await continueFromTitle(page, 'Fable 19 · Backend Engineer')
        expect(traffic.requests).toEqual([])
        expect(otherTraffic.requests).toEqual([])
      } finally {
        await other.close()
      }
    })

    test('closing after same-document navigation removes the original saved view returns to the current main content', async ({ page }) => {
      const traffic = watchApiRequests(page)
      await openSavedPages(page)
      const before = await readSaved(page)
      await openDetail(page, 'Fable 01 · Backend Engineer', 'footer')
      await page.goto('/#explore')
      await expect(page.getByRole('dialog').getByRole('heading', { name: 'Fable 01 · Backend Engineer', exact: true })).toBeVisible()
      await expect(page.locator('#main-content')).toHaveClass('explore-layout')
      await closeDetail(page)
      await expect(page.locator('#main-content')).toBeFocused()
      expect(await page.locator('#main-content').evaluate(element => element.matches(':focus-visible'))).toBe(true)
      await page.keyboard.press('Tab')
      const profile = page.getByRole('button', { name: 'PRIVATE-PROFILE-SAVED53 · 프로필 수정', exact: true })
      await expectVisibleFocus(profile)
      await page.keyboard.press('Enter')
      await expect(page.getByRole('dialog')).toBeVisible()
      await expect(page.getByRole('dialog').getByRole('button', { name: '닫기', exact: true })).toBeFocused()
      await closeDetail(page)
      await expectVisibleFocus(profile)
      expect(await readSaved(page)).toEqual(before)
      expect(traffic.requests).toEqual([])
    })

    test('a real detail-to-recovery-dialog handoff keeps focus inside the replacement modal through keyboard navigation', async ({ page }) => {
      const traffic = watchApiRequests(page)
      await page.clock.setFixedTime(new Date(SAVED_PAGES_TIME))
      await page.addInitScript(records => {
        localStorage.setItem('orbit.v1.saved', JSON.stringify([...records, { invalid: 'PRIVATE-RECOVERY54 preserved original' }]))
        localStorage.setItem('orbit.v1.exploration', JSON.stringify({ source: 'sample', mapMode: 'flat' }))
      }, savedPageRecords(1))
      await page.goto('/#saved')
      await waitForSavedCommit(page)
      const before = await readSaved(page)
      const dialog = await openDetail(page, 'Fable 01 · Backend Engineer')
      const originals = dialog.getByText('따로 보관한 원본이 있어요', { exact: true })
      await originals.focus()
      await page.keyboard.press('Enter')
      await dialog.getByRole('button', { name: '원본 가져오기·정리', exact: true }).focus()
      await page.keyboard.press('Enter')
      const recovery = page.getByRole('dialog', { name: '기록 백업과 복원', exact: true })
      await expect(recovery).toBeVisible()
      await expect(page.getByRole('dialog')).toHaveCount(1)
      await expect(page.getByRole('dialog', { name: 'Fable Labs', exact: true })).toHaveCount(0)
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
      await expectVisibleFocus(recovery.getByRole('button', { name: '닫기', exact: true }))
      await page.keyboard.press('Tab')
      await expectVisibleFocus(recovery.getByRole('button', { name: 'JSON 백업', exact: true }))
      await page.keyboard.press('Shift+Tab')
      await expectVisibleFocus(recovery.getByRole('button', { name: '닫기', exact: true }))
      await closeDetail(page)
      await expectSavedPage(page, ['Fable 01 · Backend Engineer'], '1개 기회 중 1–1개 표시')
      expect(await readSaved(page)).toEqual(before)
      expect(traffic.requests).toEqual([])
    })
  })
}

test('when none of the original filtered jobs survives, a newly matching record supplies the first current result', async ({ page }) => {
  const traffic = watchApiRequests(page)
  await openSavedPages(page)
  await search(page).fill('Needle25')
  await expectSavedPage(page, ['Kite 25 · Backend Engineer'], '1개 기회 중 1–1개 표시')
  await openDetail(page, 'Kite 25 · Backend Engineer')
  const other = await otherSavedPage(page)
  const otherTraffic = watchApiRequests(other)
  try {
    await other.goto('/#saved')
    await waitForSavedCommit(other)
    await search(other).fill('Fable 24')
    const added = await openDetail(other, 'Fable 24 · Backend Engineer')
    await added.getByLabel('이 기회에 대한 나의 메모', { exact: true }).fill('PRIVATE-SAVED54 Needle25 newly matching result 24')
    await waitForSavedCommit(other)
    await closeDetail(other)
    await search(other).fill('Kite 25')
    const removed = await openDetail(other, 'Kite 25 · Backend Engineer')
    await removed.getByLabel('이 기회에 대한 나의 메모', { exact: true }).fill('PRIVATE-SAVED54 former only result 25')
    await waitForSavedCommit(other)
    await closeDetail(other)
    await expect(page.locator('.saved-title')).toHaveText(['Fable 24 · Backend Engineer'])
    await closeDetail(page)
    await expectSavedPage(page, ['Fable 24 · Backend Engineer'], '1개 기회 중 1–1개 표시')
    await expectVisibleFocus(title(page, 'Fable 24 · Backend Engineer'))
    await expect(search(page)).toHaveValue('Needle25')
    await expectSavedTotals(page, [25, 13, 12])
    const records = await readSaved(page)
    expect(records.find(record => record.job.id === 'greenhouse-fable-labs-24')?.note).toBe('PRIVATE-SAVED54 Needle25 newly matching result 24')
    expect(records.find(record => record.job.id === 'greenhouse-paper-kite-25')?.note).toBe('PRIVATE-SAVED54 former only result 25')
    await continueFromTitle(page, 'Fable 24 · Backend Engineer')
    expect(traffic.requests).toEqual([])
    expect(otherTraffic.requests).toEqual([])
  } finally {
    await other.close()
  }
})

test('a still-saved opener moved off the current page by another tab does not pull focus or pagination onto its new page', async ({ page }) => {
  const traffic = watchApiRequests(page)
  await openSavedPages(page)
  await page.locator('.collection-tabs').getByRole('button', { name: /^지원 완료/ }).click()
  await expect(page.locator('.saved-results-summary')).toHaveText('12개 기회 중 1–12개 표시')
  await openDetail(page, 'Kite 25 · Backend Engineer', 'footer')
  const other = await otherSavedPage(page)
  const otherTraffic = watchApiRequests(other)
  try {
    await other.goto('/#saved')
    await waitForSavedCommit(other)
    await search(other).fill('Fable 13')
    const dialog = await openDetail(other, 'Fable 13 · Backend Engineer')
    await dialog.getByRole('button', { name: '지원 완료로 표시', exact: true }).click()
    await waitForSavedCommit(other)
    await closeDetail(other)
    await expect(page.locator('.saved-title')).toHaveText(SECOND_TITLES)
    await expect(page.locator('.saved-results-summary')).toHaveText('13개 기회 중 1–12개 표시')
    await closeDetail(page)
    await expectSavedPage(page, SECOND_TITLES, '13개 기회 중 1–12개 표시')
    await expectPagerState(page, '2페이지 중 1페이지', true, false)
    await expectVisibleFocus(title(page, 'Fable 24 · Backend Engineer'))
    await expectSavedTotals(page, [25, 12, 13])
    const records = await readSaved(page)
    expect(records.find(record => record.job.id === 'greenhouse-paper-kite-25')).toMatchObject({
      status: 'applied', note: '=1+2\nPRIVATE-SAVED53 CohortSouth Needle25, "가상 메모" 🌕',
    })
    await continueFromTitle(page, 'Fable 24 · Backend Engineer')
    await nextPage(page).focus()
    await page.keyboard.press('Enter')
    await expectSavedPage(page, ['Kite 25 · Backend Engineer'], '13개 기회 중 13–13개 표시')
    await expectVisibleFocus(title(page, 'Kite 25 · Backend Engineer'))
    expect(traffic.requests).toEqual([])
    expect(otherTraffic.requests).toEqual([])
  } finally {
    await other.close()
  }
})

test.describe('wrapped notification clearance at 320px', () => {
  test.use({ viewport: { width: 320, height: 800 }, hasTouch: true })

  test('a wrapped live save notice survives viewport resizing with the restored footer and notice action usable by keyboard', async ({ page }, testInfo) => {
    const traffic = watchApiRequests(page)
    const [record] = savedPageRecords(1)
    const fictional = {
      ...record,
      company: { ...record.company, name: 'Fable Lantern and Paper Moon Research Cooperative Fictional Accessibility Studio' },
    }
    await page.clock.setFixedTime(new Date(SAVED_PAGES_TIME))
    await page.addInitScript(item => {
      localStorage.setItem('orbit.v1.saved', JSON.stringify([item]))
      localStorage.setItem('orbit.v1.exploration', JSON.stringify({ source: 'sample', mapMode: 'flat' }))
    }, fictional)
    await page.goto('/#saved')
    await waitForSavedCommit(page)
    const dialog = await openDetail(page, 'Fable 01 · Backend Engineer', 'footer')
    await dialog.getByRole('button', { name: '저장됨', exact: true }).click()
    await waitForSavedCommit(page)
    await dialog.getByRole('button', { name: '기회 저장', exact: true }).click()
    await waitForSavedCommit(page)
    await closeDetail(page, 'button')

    const notice = page.locator('.toast')
    const message = notice.getByText('Fable Lantern and Paper Moon Research Cooperative Fictional Accessibility Studio의 기회를 목록에 추가했어요.', { exact: true })
    await expect(message).toBeVisible()
    const lineCount = await message.evaluate(element => {
      const range = document.createRange()
      range.selectNodeContents(element)
      return new Set([...range.getClientRects()].map(rect => rect.top)).size
    })
    expect(lineCount).toBeGreaterThanOrEqual(2)
    await expectVisibleFocus(title(page, 'Fable 01 · Backend Engineer'))
    await page.keyboard.press('Tab')
    await expectVisibleFocus(footer(page, 'Fable 01 · Backend Engineer'))
    await expect(message).toBeVisible()
    const initialBounds = await notice.boundingBox()
    expect(initialBounds).not.toBeNull()
    await page.setViewportSize({ width: 390, height: 800 })
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    await expectVisibleFocus(footer(page, 'Fable 01 · Backend Engineer'))
    await expect(message).toBeVisible()
    const widerBounds = await notice.boundingBox()
    expect(widerBounds).not.toBeNull()
    expect(widerBounds!.width).toBeGreaterThan(initialBounds!.width)
    await page.setViewportSize({ width: 320, height: 800 })
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    await expectVisibleFocus(footer(page, 'Fable 01 · Backend Engineer'))
    await expect(message).toBeVisible()
    await testInfo.attach('wrapped-toast-resize-bounds', {
      body: JSON.stringify({ initial320: initialBounds, wider390: widerBounds, returned320: await notice.boundingBox() }),
      contentType: 'application/json',
    })
    const showSaved = notice.getByRole('button', { name: '모아보기', exact: true })
    await expect(showSaved).toBeEnabled()
    await testInfo.attach('wrapped-toast-footer-focus-320', { body: await page.screenshot(), contentType: 'image/png' })
    await page.keyboard.press('Enter')
    await expect(page.getByRole('dialog').getByRole('heading', { name: 'Fable 01 · Backend Engineer', exact: true })).toBeVisible()
    await closeDetail(page)
    await expectVisibleFocus(footer(page, 'Fable 01 · Backend Engineer'))
    await expect(message).toBeVisible()
    await expectSavedPage(page, ['Fable 01 · Backend Engineer'], '1개 기회 중 1–1개 표시')
    expect((await readSaved(page))[0]).toMatchObject({
      job: { id: 'greenhouse-fable-labs-01' },
      company: { name: 'Fable Lantern and Paper Moon Research Cooperative Fictional Accessibility Studio' },
      status: 'saved', note: '', savedAt: '2026-09-26T08:00:10.000Z',
    })
    await showSaved.focus()
    await expectVisibleFocus(showSaved)
    await page.keyboard.press('Enter')
    await expect(notice).toHaveCount(0)
    await expectSavedPage(page, ['Fable 01 · Backend Engineer'], '1개 기회 중 1–1개 표시')
    await expect(page.getByRole('dialog')).toHaveCount(0)
    expect(traffic.requests).toEqual([])
  })
})
