import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { readFile } from 'node:fs/promises'
import type { SavedJob } from '../../shared/types'
import { readSaved, waitForSavedCommit } from './helpers/saved-store'
import { watchApiRequests } from './helpers/api-requests'
import {
  ALL_IDS, APPLIED_TITLES, FIRST_TITLES, POSTING_INDEX, SAVED_PAGES_TIME, SECOND_TITLES,
  UNDO_SECOND_TITLES, expectPagerGeometry, expectPagerState, expectRevealedTitle,
  expectSavedPage, expectSavedTotals, openSavedPages, parseSavedCsv, savedCard, savedPager,
  thirteenChangedPostings,
} from './helpers/saved-pages'

const query = (page: Page) => page.getByRole('textbox', { name: '저장한 기회 검색', exact: true })
const status = (page: Page, label: string) => page.locator('.collection-tabs').getByRole('button', { name: new RegExp(`^${label}\\s*\\d+$`) })
const nextPage = (page: Page, position: '위' | '아래' = '위') => savedPager(page, position).getByRole('button', { name: '다음 저장 페이지', exact: true })
const lastPage = (page: Page, position: '위' | '아래' = '위') => savedPager(page, position).getByRole('button', { name: '마지막 저장 페이지', exact: true })
const previousPage = (page: Page, position: '위' | '아래' = '위') => savedPager(page, position).getByRole('button', { name: '이전 저장 페이지', exact: true })
const firstPage = (page: Page, position: '위' | '아래' = '위') => savedPager(page, position).getByRole('button', { name: '처음 저장 페이지', exact: true })
const pagers = (page: Page) => page.getByRole('navigation', { name: /^저장한 기회 페이지 이동 / })

async function importReplacement(page: Page, record: SavedJob) {
  await page.getByRole('button', { name: '기록 백업·복원', exact: true }).click()
  await page.getByLabel('백업 또는 복구 파일', { exact: true }).setInputFiles({
    name: 'fictional-snapshot-update.json', mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify({
      format: 'orbit-saved-backup', version: 1, exportedAt: SAVED_PAGES_TIME,
      includesUnsavedChanges: false, records: [record],
    })),
  })
  await expect(page.locator('.saved-import-row')).toHaveCount(1)
  await page.locator('.saved-import-row').getByRole('checkbox').check()
  await page.getByRole('button', { name: '선택한 1개 가져오기', exact: true }).click()
  await expect(page.locator('.saved-file-message')).toContainText('선택한 1개 기록을 저장했어요.')
  await waitForSavedCommit(page)
  await page.keyboard.press('Escape')
}

for (const width of [1440, 320]) {
  test.describe(`saved collection pages at ${width}px`, () => {
    test.use({ viewport: { width, height: width === 320 ? 800 : 960 }, isMobile: width === 320, hasTouch: width === 320 })

    test('0 records: announces zero, shows the collection empty state and omits paging controls', async ({ page }) => {
      await openSavedPages(page, 0)
      await expectSavedPage(page, [], '0개 기회')
      await expect(page.getByRole('heading', { name: '다음 챕터의 첫 기회를 저장해 보세요', exact: true })).toBeVisible()
      await expect(pagers(page)).toHaveCount(0)
      await expect(page.getByRole('button', { name: 'CSV 내보내기', exact: true })).toBeDisabled()
      await expect(page.locator('.collection-tabs button')).toHaveText(['전체0', '검토 중0', '지원 완료0'])
    })

    test('1 record: displays the exact single result without an unnecessary pager', async ({ page }) => {
      await openSavedPages(page, 1)
      await expectSavedPage(page, ['Fable 01 · Backend Engineer'], '1개 기회 중 1–1개 표시')
      await expectSavedTotals(page, [1, 1, 0])
      await expect(pagers(page)).toHaveCount(0)
      await expect(page.getByRole('button', { name: 'CSV 내보내기', exact: true })).toBeEnabled()
    })

    test('12 records: fills one page exactly and never exposes an empty extra page', async ({ page }) => {
      await openSavedPages(page, 12)
      await expectSavedPage(page, FIRST_TITLES, '12개 기회 중 1–12개 표시')
      await expectSavedTotals(page, [12, 12, 0])
      await expect(pagers(page)).toHaveCount(0)
      expect((await readSaved(page)).map(record => record.job.id)).toEqual([
        'greenhouse-fable-labs-01', 'greenhouse-fable-labs-02', 'greenhouse-fable-labs-03',
        'greenhouse-fable-labs-04', 'greenhouse-fable-labs-05', 'greenhouse-fable-labs-06',
        'greenhouse-fable-labs-07', 'greenhouse-fable-labs-08', 'greenhouse-fable-labs-09',
        'greenhouse-fable-labs-10', 'greenhouse-fable-labs-11', 'greenhouse-fable-labs-12',
      ])
    })

    test('13 records: both pagers reach the one-card last page and enforce first/last bounds', async ({ page }) => {
      await openSavedPages(page, 13)
      await expectSavedPage(page, FIRST_TITLES, '13개 기회 중 1–12개 표시')
      await expectPagerState(page, '2페이지 중 1페이지', true, false)
      await expect(pagers(page)).toHaveCount(2)
      await expectPagerGeometry(savedPager(page))
      await nextPage(page, '아래').click()
      await expectSavedPage(page, ['Fable 13 · Backend Engineer'], '13개 기회 중 13–13개 표시')
      await expectPagerState(page, '2페이지 중 2페이지', false, true)
      await expectRevealedTitle(page, 'Fable 13 · Backend Engineer')
      await expectSavedTotals(page, [13, 13, 0])
      await previousPage(page).click()
      await expectSavedPage(page, FIRST_TITLES, '13개 기회 중 1–12개 표시')
      await expectRevealedTitle(page, 'Fable 01 · Backend Engineer')
    })

    test('25 records: visits every literal page in order using top and bottom controls', async ({ page }) => {
      const traffic = watchApiRequests(page)
      await openSavedPages(page)
      await expectSavedPage(page, FIRST_TITLES, '25개 기회 중 1–12개 표시')
      await expectPagerState(page, '3페이지 중 1페이지', true, false)
      await nextPage(page).click()
      await expectSavedPage(page, SECOND_TITLES, '25개 기회 중 13–24개 표시')
      await expectPagerState(page, '3페이지 중 2페이지', false, false)
      await expectRevealedTitle(page, 'Fable 13 · Backend Engineer')
      await nextPage(page, '아래').click()
      await expectSavedPage(page, ['Kite 25 · Backend Engineer'], '25개 기회 중 25–25개 표시')
      await expectPagerState(page, '3페이지 중 3페이지', false, true)
      await expectRevealedTitle(page, 'Kite 25 · Backend Engineer')
      await expectSavedTotals(page, [25, 13, 12])
      await firstPage(page, '아래').click()
      await expectSavedPage(page, FIRST_TITLES, '25개 기회 중 1–12개 표시')
      await expectRevealedTitle(page, 'Fable 01 · Backend Engineer')
      await lastPage(page).click()
      await expectSavedPage(page, ['Kite 25 · Backend Engineer'], '25개 기회 중 25–25개 표시')
      expect((await readSaved(page)).map(record => record.job.id)).toEqual(ALL_IDS)
      expect(traffic.requests).toEqual([])
    })

    test('searches off-page notes and resets later pages for query/status changes, including identical result sets', async ({ page }) => {
      await openSavedPages(page)
      await lastPage(page).click()
      await query(page).fill('Needle25')
      await expectSavedPage(page, ['Kite 25 · Backend Engineer'], '1개 기회 중 1–1개 표시')
      await expect(query(page)).toBeFocused()
      await expect(pagers(page)).toHaveCount(0)

      await query(page).fill('CohortNorth')
      await expectSavedPage(page, FIRST_TITLES, '13개 기회 중 1–12개 표시')
      await nextPage(page).click()
      await expectSavedPage(page, ['Fable 13 · Backend Engineer'], '13개 기회 중 13–13개 표시')
      await query(page).fill('  cohortnorth  ')
      await expectSavedPage(page, FIRST_TITLES, '13개 기회 중 1–12개 표시')
      await expect(query(page)).toBeFocused()
      await expectPagerState(page, '2페이지 중 1페이지', true, false)

      await query(page).fill('')
      await nextPage(page).click()
      await status(page, '검토 중').click()
      await expectSavedPage(page, FIRST_TITLES, '13개 기회 중 1–12개 표시')
      await expect(status(page, '검토 중')).toBeFocused()
      await nextPage(page).click()
      await status(page, '지원 완료').click()
      await expectSavedPage(page, APPLIED_TITLES, '12개 기회 중 1–12개 표시')
      await expect(status(page, '지원 완료')).toBeFocused()
      await expect(pagers(page)).toHaveCount(0)

      await query(page).fill('NoSuchSavedOpportunity53')
      await expectSavedPage(page, [], '0개 기회')
      await expect(page.getByRole('heading', { name: '검색에 맞는 저장한 기회가 없어요', exact: true })).toBeVisible()
      await expect(query(page)).toBeFocused()
      await expectSavedTotals(page, [25, 13, 12])
      await expect(pagers(page)).toHaveCount(0)
      await query(page).fill('')
      await expectSavedPage(page, APPLIED_TITLES, '12개 기회 중 1–12개 표시')
      await status(page, '전체').click()
      await expectSavedPage(page, FIRST_TITLES, '25개 기회 중 1–12개 표시')
    })

    test('retains page and original title focus through detail close, committed note edits and application edits', async ({ page }) => {
      const traffic = watchApiRequests(page)
      await openSavedPages(page)
      await nextPage(page).click()
      const title = page.getByRole('button', { name: 'Fable 13 · Backend Engineer', exact: true })
      await title.click()
      const dialog = page.getByRole('dialog', { name: 'Fable Labs', exact: true })
      await expect(dialog.getByRole('heading', { name: 'Fable 13 · Backend Engineer', exact: true })).toBeVisible()
      await expect(dialog.getByRole('link', { name: '원문에서 지원하기', exact: true })).toHaveAttribute('href', 'https://example.org/saved-pages/greenhouse-fable-labs-13')
      await page.keyboard.press('Escape')
      await expect(title).toBeFocused()
      await expectSavedPage(page, SECOND_TITLES, '25개 기회 중 13–24개 표시')

      await title.press('Enter')
      await page.getByLabel('이 기회에 대한 나의 메모', { exact: true }).fill('PRIVATE-SAVED53 CohortNorth retained note 13')
      await expect(page.getByLabel('이 기회에 대한 나의 메모', { exact: true })).toBeFocused()
      await page.getByRole('button', { name: '지원 완료로 표시', exact: true }).click()
      await waitForSavedCommit(page)
      await expect(page.getByRole('button', { name: '지원 완료로 표시됨', exact: true })).toBeVisible()
      await page.keyboard.press('Escape')
      await expect(title).toBeFocused()
      await expectSavedPage(page, SECOND_TITLES, '25개 기회 중 13–24개 표시')
      await expectSavedTotals(page, [25, 12, 13])
      await expect(savedCard(page, 'Fable 13 · Backend Engineer').locator('.saved-note-preview')).toHaveText('PRIVATE-SAVED53 CohortNorth retained note 13')
      await expect(savedCard(page, 'Fable 13 · Backend Engineer').locator('.saved-status')).toHaveText('지원 완료')
      expect((await readSaved(page)).find(record => record.job.id === 'greenhouse-fable-labs-13')).toMatchObject({
        savedAt: '2026-09-25T08:00:00.000Z', status: 'applied', note: 'PRIVATE-SAVED53 CohortNorth retained note 13',
      })
      expect(traffic.requests).toEqual([])
    })

    test('deletes the only final-page card, remembers the clamped page on undo and restores the exact record', async ({ page }, testInfo) => {
      await openSavedPages(page)
      await lastPage(page).click()
      await savedCard(page, 'Kite 25 · Backend Engineer').getByRole('button', { name: 'Paper Kite 저장 취소', exact: true }).click()
      await expectSavedPage(page, SECOND_TITLES, '24개 기회 중 13–24개 표시')
      await expectPagerState(page, '2페이지 중 2페이지', false, true)
      await testInfo.attach('focus-after-final-card-removal', {
        body: JSON.stringify(await page.evaluate(() => ({
          tag: document.activeElement?.tagName,
          className: document.activeElement?.className,
          firstTitleFocused: document.activeElement === document.querySelector('.saved-title'),
          bodyFocused: document.activeElement === document.body,
        }))),
        contentType: 'application/json',
      })
      await page.getByRole('button', { name: '실행 취소', exact: true }).click()
      await expectSavedPage(page, UNDO_SECOND_TITLES, '25개 기회 중 13–24개 표시')
      await expectPagerState(page, '3페이지 중 2페이지', false, false)
      await expectSavedTotals(page, [25, 13, 12])
      const restored = await readSaved(page)
      expect(restored[0]).toMatchObject({
        job: { id: 'greenhouse-paper-kite-25', title: 'Kite 25 · Backend Engineer' },
        savedAt: '2026-09-25T08:00:00.000Z', status: 'applied',
        note: '=1+2\nPRIVATE-SAVED53 CohortSouth Needle25, "가상 메모" 🌕',
      })
      expect(restored).toHaveLength(25)
      await lastPage(page).click()
      await expectSavedPage(page, ['Fable 24 · Backend Engineer'], '25개 기회 중 25–25개 표시')
      await expectRevealedTitle(page, 'Fable 24 · Backend Engineer')
      await query(page).fill('Needle25')
      await expectSavedPage(page, ['Kite 25 · Backend Engineer'], '1개 기회 중 1–1개 표시')
      await page.reload()
      await expectSavedPage(page, [
        'Kite 25 · Backend Engineer', 'Fable 01 · Backend Engineer', 'Fable 02 · Backend Engineer',
        'Fable 03 · Backend Engineer', 'Fable 04 · Backend Engineer', 'Fable 05 · Backend Engineer',
        'Fable 06 · Backend Engineer', 'Fable 07 · Backend Engineer', 'Fable 08 · Backend Engineer',
        'Fable 09 · Backend Engineer', 'Fable 10 · Backend Engineer', 'Fable 11 · Backend Engineer',
      ], '25개 기회 중 1–12개 표시')
    })

    test('uses whole-collection posting counts and resets intersecting filters from a later page', async ({ page }) => {
      const traffic = watchApiRequests(page)
      await page.route('**/api/posting-status*', route => route.fulfill({ json: POSTING_INDEX }))
      await openSavedPages(page)
      await lastPage(page).click()
      expect(traffic.requests).toEqual([])
      await page.getByRole('button', { name: '게시 상태 확인', exact: true }).click()
      await expect(page.locator('.posting-summary')).toHaveText('게시 확인 13내용 차이 1목록에서 미확인 11확인 필요 1')
      await expectSavedPage(page, ['Kite 25 · Backend Engineer'], '25개 기회 중 25–25개 표시')
      const posting = page.getByRole('combobox', { name: '게시 상태', exact: true })
      await posting.focus()
      await posting.selectOption('listed')
      await expectSavedPage(page, FIRST_TITLES, '13개 기회 중 1–12개 표시')
      await expect(posting).toBeFocused()
      await nextPage(page).click()
      await expectSavedPage(page, ['Fable 13 · Backend Engineer'], '13개 기회 중 13–13개 표시')
      await status(page, '지원 완료').click()
      await expectSavedPage(page, [], '0개 기회')
      await expect(pagers(page)).toHaveCount(0)
      await expect(status(page, '지원 완료')).toBeFocused()
      await status(page, '전체').click()
      await expectSavedPage(page, FIRST_TITLES, '13개 기회 중 1–12개 표시')
      await nextPage(page).click()
      await posting.focus()
      await posting.selectOption('changed')
      await expectSavedPage(page, ['Fable 13 · Backend Engineer'], '1개 기회 중 1–1개 표시')
      await expect(posting).toBeFocused()
      await expect(pagers(page)).toHaveCount(0)
      await posting.selectOption('missing')
      await expectSavedPage(page, [
        'Fable 14 · Backend Engineer', 'Fable 15 · Backend Engineer', 'Fable 16 · Backend Engineer',
        'Fable 17 · Backend Engineer', 'Fable 18 · Backend Engineer', 'Fable 19 · Backend Engineer',
        'Fable 20 · Backend Engineer', 'Fable 21 · Backend Engineer', 'Fable 22 · Backend Engineer',
        'Fable 23 · Backend Engineer', 'Fable 24 · Backend Engineer',
      ], '11개 기회 중 1–11개 표시')
      await posting.selectOption('unknown')
      await expectSavedPage(page, ['Kite 25 · Backend Engineer'], '1개 기회 중 1–1개 표시')
      await posting.selectOption('all')
      await expectSavedPage(page, FIRST_TITLES, '25개 기회 중 1–12개 표시')
      await expectSavedTotals(page, [25, 13, 12])
      await expect(page.locator('.posting-summary')).toHaveText('게시 확인 13내용 차이 1목록에서 미확인 11확인 필요 1')
      expect(traffic.requests.map(request => ({ url: request.url, method: request.method, body: request.body }))).toEqual([
        { url: new URL('/api/posting-status?refresh=1', page.url()).href, method: 'GET', body: null },
      ])
    })

    test('keeps the thirteenth changed result on page 2 through note/status commits and another tab’s note refresh', async ({ page, context }) => {
      const traffic = watchApiRequests(page)
      await page.route('**/api/posting-status*', route => route.fulfill({ json: thirteenChangedPostings() }))
      await openSavedPages(page)
      const original = await readSaved(page)
      await page.getByRole('button', { name: '게시 상태 확인', exact: true }).click()
      await expect(page.locator('.posting-summary')).toHaveText('게시 확인 13내용 차이 13목록에서 미확인 11확인 필요 1')
      await query(page).fill('CohortNorth')
      const posting = page.getByRole('combobox', { name: '게시 상태', exact: true })
      await posting.selectOption('changed')
      await expectSavedPage(page, FIRST_TITLES, '13개 기회 중 1–12개 표시')
      await nextPage(page).click()
      await expectSavedPage(page, ['Fable 13 · Backend Engineer'], '13개 기회 중 13–13개 표시')
      const title = page.getByRole('button', { name: 'Fable 13 · Backend Engineer', exact: true })
      await title.click()
      await page.getByLabel('이 기회에 대한 나의 메모', { exact: true }).fill('PRIVATE-SAVED53 CohortNorth revised note 13')
      await waitForSavedCommit(page)
      await expect(page.locator('.posting-summary')).toHaveText('게시 확인 13내용 차이 13목록에서 미확인 11확인 필요 1')
      await page.keyboard.press('Escape')
      await expectSavedPage(page, ['Fable 13 · Backend Engineer'], '13개 기회 중 13–13개 표시')
      await expect(title).toBeFocused()
      await expect(query(page)).toHaveValue('CohortNorth')
      await expect(posting).toHaveValue('changed')

      await title.click()
      await page.getByRole('button', { name: '지원 완료로 표시', exact: true }).click()
      await waitForSavedCommit(page)
      await expect(page.locator('.posting-summary')).toHaveText('게시 확인 13내용 차이 13목록에서 미확인 11확인 필요 1')
      await page.keyboard.press('Escape')
      await expectSavedPage(page, ['Fable 13 · Backend Engineer'], '13개 기회 중 13–13개 표시')
      await expect(title).toBeFocused()
      await expectPagerState(page, '2페이지 중 2페이지', false, true)
      await expectSavedTotals(page, [25, 12, 13])

      const other = await context.newPage()
      const otherTraffic = watchApiRequests(other)
      try {
        await other.clock.setFixedTime(new Date(SAVED_PAGES_TIME))
        await other.goto('/#saved')
        await waitForSavedCommit(other)
        await query(other).fill('Fable 13')
        await other.getByRole('button', { name: 'Fable 13 · Backend Engineer', exact: true }).click()
        await other.getByLabel('이 기회에 대한 나의 메모', { exact: true }).fill('PRIVATE-SAVED53 CohortNorth OtherTab revised note 13')
        await waitForSavedCommit(other)
        // The changed note is the visible acknowledgement that this tab has
        // accepted the other tab's fresh database snapshot.
        await expect(savedCard(page, 'Fable 13 · Backend Engineer').locator('.saved-note-preview')).toHaveText('PRIVATE-SAVED53 CohortNorth OtherTab revised note 13')
        await expectSavedPage(page, ['Fable 13 · Backend Engineer'], '13개 기회 중 13–13개 표시')
        await expectPagerState(page, '2페이지 중 2페이지', false, true)
        await expect(query(page)).toHaveValue('CohortNorth')
        await expect(posting).toHaveValue('changed')
        await expect(page.locator('.posting-summary')).toHaveText('게시 확인 13내용 차이 13목록에서 미확인 11확인 필요 1')
        const after = await readSaved(page)
        expect(after.map(record => record.job.id)).toEqual(ALL_IDS)
        expect(after.filter(record => record.job.id !== 'greenhouse-fable-labs-13')).toEqual(original.filter(record => record.job.id !== 'greenhouse-fable-labs-13'))
        expect(after.find(record => record.job.id === 'greenhouse-fable-labs-13')).toEqual({
          ...original.find(record => record.job.id === 'greenhouse-fable-labs-13')!,
          note: 'PRIVATE-SAVED53 CohortNorth OtherTab revised note 13', status: 'applied',
        })
        expect(otherTraffic.requests).toEqual([])
      } finally { await other.close() }
      expect(traffic.requests.map(request => ({ url: request.url, method: request.method, body: request.body }))).toEqual([
        { url: new URL('/api/posting-status?refresh=1', page.url()).href, method: 'GET', body: null },
      ])
    })
  })
}

test('500 saved records use 42 bounded pages and expose the exact eight final opportunities', async ({ page }) => {
  await openSavedPages(page, 500)
  await expectSavedPage(page, FIRST_TITLES, '500개 기회 중 1–12개 표시')
  await expectSavedTotals(page, [500, 488, 12])
  await expectPagerState(page, '42페이지 중 1페이지', true, false)
  await lastPage(page).click()
  await expectSavedPage(page, [
    'Fable 493 · Backend Engineer', 'Fable 494 · Backend Engineer',
    'Fable 495 · Backend Engineer', 'Fable 496 · Backend Engineer',
    'Fable 497 · Backend Engineer', 'Fable 498 · Backend Engineer',
    'Fable 499 · Backend Engineer', 'Fable 500 · Backend Engineer',
  ], '500개 기회 중 493–500개 표시')
  await expectPagerState(page, '42페이지 중 42페이지', false, true)
  await expectRevealedTitle(page, 'Fable 493 · Backend Engineer')
  await expectSavedTotals(page, [500, 488, 12])
  await page.getByRole('button', { name: 'Fable 500 · Backend Engineer', exact: true }).click()
  await expect(page.getByRole('dialog').getByRole('link', { name: '원문에서 지원하기', exact: true })).toHaveAttribute('href', 'https://example.org/saved-pages/greenhouse-fable-labs-500')
  await page.keyboard.press('Escape')
  await firstPage(page).click()
  await expectSavedPage(page, FIRST_TITLES, '500개 기회 중 1–12개 표시')
})

test('recompares actual same-ID snapshot changes and incoming company boards without reusing stale saved content', async ({ page, context }) => {
  const traffic = watchApiRequests(page)
  await page.route('**/api/posting-status*', route => route.fulfill({ json: thirteenChangedPostings() }))
  await openSavedPages(page)
  const original = await readSaved(page)
  await page.getByRole('button', { name: '게시 상태 확인', exact: true }).click()
  await expect(page.locator('.posting-summary')).toHaveText('게시 확인 13내용 차이 13목록에서 미확인 11확인 필요 1')
  await query(page).fill('CohortNorth')
  const posting = page.getByRole('combobox', { name: '게시 상태', exact: true })
  await posting.selectOption('changed')
  await nextPage(page).click()
  const other = await context.newPage()
  const otherTraffic = watchApiRequests(other)
  try {
    await other.clock.setFixedTime(new Date(SAVED_PAGES_TIME))
    await other.goto('/#saved')
    await waitForSavedCommit(other)
    const old = (await readSaved(other)).find(record => record.job.id === 'greenhouse-fable-labs-13')!
    const incoming: SavedJob = {
      ...old,
      job: {
        ...old.job, title: 'Fable 13 · Backend Engineer Updated Snapshot',
        description: 'Fictional updated source for Fable 13. Build weather tools with Python and review the new source carefully.',
        url: 'https://example.org/saved-pages/updated-snapshot-13',
      },
    }
    await importReplacement(other, incoming)
    await expect(page.locator('.posting-summary')).toHaveText('게시 확인 13내용 차이 13목록에서 미확인 11확인 필요 1')
    await expectSavedPage(page, ['Fable 13 · Backend Engineer Updated Snapshot'], '13개 기회 중 13–13개 표시')
    await expect(query(page)).toHaveValue('CohortNorth')
    await expect(posting).toHaveValue('changed')
    await page.getByRole('button', { name: 'Fable 13 · Backend Engineer Updated Snapshot', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Fable Labs', exact: true })
    await expect(dialog.getByRole('link', { name: '원문에서 지원하기', exact: true })).toHaveAttribute('href', 'https://example.org/saved-pages/updated-snapshot-13')
    await dialog.locator('.original-description > summary').click()
    await expect(dialog.locator('.original-description .job-description')).toHaveText('Fictional updated source for Fable 13. Build weather tools with Python and review the new source carefully.')
    await page.keyboard.press('Escape')

    await importReplacement(other, { ...incoming, company: { ...incoming.company, board: 'fable-board-moved' } })
    await expect(page.locator('.posting-summary')).toHaveText('게시 확인 12내용 차이 12목록에서 미확인 11확인 필요 2')
    await expectSavedPage(page, FIRST_TITLES, '12개 기회 중 1–12개 표시')
    await expect(pagers(page)).toHaveCount(0)
    await expect(query(page)).toHaveValue('CohortNorth')
    await expect(posting).toHaveValue('changed')
    await posting.selectOption('unknown')
    await expectSavedPage(page, ['Fable 13 · Backend Engineer Updated Snapshot'], '1개 기회 중 1–1개 표시')
    await expect(page.locator('.saved-card .posting-notice')).toHaveClass(/unknown/)
    await expect(page.locator('.saved-card .posting-notice')).toContainText('저장한 공고의 게시판이 현재 조회 범위와 달라요.')
    const after = await readSaved(page)
    expect(after.map(record => record.job.id)).toEqual(ALL_IDS)
    expect(after.filter(record => record.job.id !== 'greenhouse-fable-labs-13')).toEqual(original.filter(record => record.job.id !== 'greenhouse-fable-labs-13'))
    expect(after.find(record => record.job.id === 'greenhouse-fable-labs-13')).toMatchObject({
      job: {
        title: 'Fable 13 · Backend Engineer Updated Snapshot',
        description: 'Fictional updated source for Fable 13. Build weather tools with Python and review the new source carefully.',
        url: 'https://example.org/saved-pages/updated-snapshot-13',
      },
      company: { id: 'fable-labs', board: 'fable-board-moved' },
      note: 'PRIVATE-SAVED53 CohortNorth note 13', status: 'saved', savedAt: '2026-09-25T08:00:00.000Z',
    })
    expect(otherTraffic.requests).toEqual([])
  } finally { await other.close() }
  expect(traffic.requests.map(request => ({ url: request.url, method: request.method, body: request.body }))).toEqual([
    { url: new URL('/api/posting-status?refresh=1', page.url()).href, method: 'GET', body: null },
  ])
})

test('holds a changed-results page while a new snapshot comparison is pending and settles a rejected digest without a false empty state', async ({ page, context }) => {
  const traffic = watchApiRequests(page)
  await page.route('**/api/posting-status*', route => route.fulfill({ json: thirteenChangedPostings() }))
  await openSavedPages(page)
  const original = await readSaved(page)
  await page.getByRole('button', { name: '게시 상태 확인', exact: true }).click()
  await expect(page.locator('.posting-summary')).toHaveText('게시 확인 13내용 차이 13목록에서 미확인 11확인 필요 1')
  await query(page).fill('CohortNorth')
  const posting = page.getByRole('combobox', { name: '게시 상태', exact: true })
  await posting.selectOption('changed')
  await nextPage(page).click()
  await expectSavedPage(page, ['Fable 13 · Backend Engineer'], '13개 기회 중 13–13개 표시')
  const top = (await savedPager(page).boundingBox())!
  const bottom = (await savedPager(page, '아래').boundingBox())!
  const priorResultHeight = bottom.y + bottom.height - top.y

  // Hold only this tab's native digest boundary. The other tab's reviewed file
  // import and IndexedDB commits still execute normally.
  await page.evaluate(() => {
    const originalDigest = crypto.subtle.digest
    let holding = true
    const waiting: ((fail: boolean) => void)[] = []
    crypto.subtle.digest = function (this: SubtleCrypto, ...args: Parameters<SubtleCrypto['digest']>) {
      if (!holding) return Reflect.apply(originalDigest, this, args) as Promise<ArrayBuffer>
      const receiver = this
      return new Promise<ArrayBuffer>((resolve, reject) => {
        waiting.push(fail => {
          if (fail) reject(new DOMException('Fictional comparison failure', 'OperationError'))
          else (Reflect.apply(originalDigest, receiver, args) as Promise<ArrayBuffer>).then(resolve, reject)
        })
      })
    }
    Reflect.set(window, '__savedComparisonGate', {
      count: () => waiting.length,
      hold: () => { holding = true },
      release: () => { holding = false; waiting.splice(0).forEach(finish => finish(false)) },
      reject: () => { holding = false; waiting.splice(0).forEach(finish => finish(true)) },
      restore: () => {
        crypto.subtle.digest = originalDigest
        holding = false
        waiting.splice(0).forEach(finish => finish(false))
      },
    })
  })
  const other = await context.newPage()
  const otherTraffic = watchApiRequests(other)
  try {
    await other.clock.setFixedTime(new Date(SAVED_PAGES_TIME))
    await other.goto('/#saved')
    await waitForSavedCommit(other)
    const old = (await readSaved(other)).find(record => record.job.id === 'greenhouse-fable-labs-13')!
    const delayed: SavedJob = {
      ...old, job: {
        ...old.job, title: 'Fable 13 · Backend Engineer Delayed Snapshot',
        description: 'Fictional delayed source for Fable 13.',
      },
    }
    await importReplacement(other, delayed)
    const pending = page.locator('.saved-comparison-pending')
    await expect(pending).toBeVisible()
    await expect(pending).toHaveAttribute('aria-busy', 'true')
    await expect(page.locator('.saved-results-summary')).toHaveText('저장한 공고 내용을 비교하고 있어요.')
    await expect(page.getByRole('heading', { name: '검색에 맞는 저장한 기회가 없어요', exact: true })).toHaveCount(0)
    await expect(page.getByRole('heading', { name: '다음 챕터의 첫 기회를 저장해 보세요', exact: true })).toHaveCount(0)
    await expect.poll(() => page.evaluate(() => Reflect.get(window, '__savedComparisonGate').count())).toBeGreaterThan(0)
    expect((await pending.boundingBox())!.height).toBeGreaterThanOrEqual(priorResultHeight - 1)
    await expect(query(page)).toHaveValue('CohortNorth')
    await expect(posting).toHaveValue('changed')
    await expectSavedTotals(page, [25, 13, 12])

    await page.evaluate(() => Reflect.get(window, '__savedComparisonGate').release())
    await expect(pending).toHaveCount(0)
    await expectSavedPage(page, ['Fable 13 · Backend Engineer Delayed Snapshot'], '13개 기회 중 13–13개 표시')
    await expectPagerState(page, '2페이지 중 2페이지', false, true)

    await page.evaluate(() => Reflect.get(window, '__savedComparisonGate').hold())
    await importReplacement(other, {
      ...delayed, job: {
        ...delayed.job, title: 'Fable 13 · Backend Engineer Uncompared Snapshot',
        description: 'Fictional source whose local comparison fails.',
      },
    })
    await expect(pending).toHaveAttribute('aria-busy', 'true')
    await expect(page.locator('.saved-results-summary')).toHaveText('저장한 공고 내용을 비교하고 있어요.')
    await expect(page.getByRole('heading', { name: '검색에 맞는 저장한 기회가 없어요', exact: true })).toHaveCount(0)
    await expect.poll(() => page.evaluate(() => Reflect.get(window, '__savedComparisonGate').count())).toBeGreaterThan(0)
    await page.evaluate(() => Reflect.get(window, '__savedComparisonGate').reject())
    await expect(pending).toHaveCount(0)
    await expectSavedPage(page, FIRST_TITLES, '12개 기회 중 1–12개 표시')
    await expect(pagers(page)).toHaveCount(0)
    await expect(query(page)).toHaveValue('CohortNorth')
    await expect(posting).toHaveValue('changed')
    await expect(page.locator('.posting-summary')).toHaveText('게시 확인 13내용 차이 12목록에서 미확인 11확인 필요 1')

    await posting.selectOption('listed')
    await nextPage(page).click()
    await expectSavedPage(page, ['Fable 13 · Backend Engineer Uncompared Snapshot'], '13개 기회 중 13–13개 표시')
    await expect(page.locator('.saved-card .posting-notice')).toHaveClass(/listed/)
    await expect(page.locator('.saved-card .posting-notice')).not.toHaveClass(/changed/)
    await expect(page.locator('.saved-card .posting-notice')).toContainText('이 기록의 내용 비교는 확인하지 못했습니다.')
    await expectSavedTotals(page, [25, 13, 12])
    const after = await readSaved(page)
    expect(after.map(record => record.job.id)).toEqual(ALL_IDS)
    expect(after.filter(record => record.job.id !== 'greenhouse-fable-labs-13')).toEqual(original.filter(record => record.job.id !== 'greenhouse-fable-labs-13'))
    expect(after.find(record => record.job.id === 'greenhouse-fable-labs-13')).toMatchObject({
      job: {
        title: 'Fable 13 · Backend Engineer Uncompared Snapshot',
        description: 'Fictional source whose local comparison fails.',
      },
      company: { id: 'fable-labs', board: 'fable-labs' },
      note: 'PRIVATE-SAVED53 CohortNorth note 13', status: 'saved', savedAt: '2026-09-25T08:00:00.000Z',
    })
    expect(otherTraffic.requests).toEqual([])
    expect(traffic.requests.map(request => ({ url: request.url, method: request.method, body: request.body }))).toEqual([
      { url: new URL('/api/posting-status?refresh=1', page.url()).href, method: 'GET', body: null },
    ])
  } finally {
    await page.evaluate(() => Reflect.get(window, '__savedComparisonGate').restore())
    await other.close()
  }
})

test('note membership changes retain a valid later page, then clamp when only one matching page remains', async ({ page }, testInfo) => {
  await openSavedPages(page)
  await query(page).fill('PRIVATE-SAVED53')
  await nextPage(page).click()
  await page.getByRole('button', { name: 'Fable 13 · Backend Engineer', exact: true }).click()
  await page.getByLabel('이 기회에 대한 나의 메모', { exact: true }).fill('CohortNorth changed membership 13')
  await waitForSavedCommit(page)
  await page.keyboard.press('Escape')
  await expectSavedPage(page, APPLIED_TITLES, '24개 기회 중 13–24개 표시')
  await expectPagerState(page, '2페이지 중 2페이지', false, true)
  await expect(query(page)).toHaveValue('PRIVATE-SAVED53')

  await query(page).fill('CohortNorth')
  await expectSavedPage(page, FIRST_TITLES, '13개 기회 중 1–12개 표시')
  await nextPage(page).click()
  await page.getByRole('button', { name: 'Fable 13 · Backend Engineer', exact: true }).click()
  await page.getByLabel('이 기회에 대한 나의 메모', { exact: true }).fill('PRIVATE-SAVED53 moved to CohortSouth 13')
  await waitForSavedCommit(page)
  await page.keyboard.press('Escape')
  await expectSavedPage(page, FIRST_TITLES, '12개 기회 중 1–12개 표시')
  await expect(pagers(page)).toHaveCount(0)
  await expectSavedTotals(page, [25, 13, 12])
  // This opener disappeared while the dialog was open. Capture its focus result
  // for independent review without inventing a deletion-focus contract.
  await testInfo.attach('focus-after-filtered-opener-disappears', {
    body: JSON.stringify(await page.evaluate(() => ({
      tag: document.activeElement?.tagName,
      className: document.activeElement?.className,
      firstTitleFocused: document.activeElement === document.querySelector('.saved-title'),
      bodyFocused: document.activeElement === document.body,
    }))),
    contentType: 'application/json',
  })
})

test('a posting observation update clamps the current unknown-results page without changing records or filters', async ({ page }) => {
  await page.route('**/api/posting-status*', route => route.fulfill({ json: POSTING_INDEX }))
  await openSavedPages(page)
  const posting = page.getByRole('combobox', { name: '게시 상태', exact: true })
  await posting.selectOption('unknown')
  await lastPage(page).click()
  await expectSavedPage(page, ['Kite 25 · Backend Engineer'], '25개 기회 중 25–25개 표시')
  await page.getByRole('button', { name: '게시 상태 확인', exact: true }).click()
  await expectSavedPage(page, ['Kite 25 · Backend Engineer'], '1개 기회 중 1–1개 표시')
  await expect(posting).toHaveValue('unknown')
  await expect(pagers(page)).toHaveCount(0)
  await expectSavedTotals(page, [25, 13, 12])
  expect((await readSaved(page)).map(record => record.job.id)).toEqual(ALL_IDS)
})

test('other-tab edits and removals preserve a valid page, clamp an empty last page, and keep that clamp on undo', async ({ page, context }) => {
  await openSavedPages(page)
  await nextPage(page).click()
  const other = await context.newPage()
  try {
    await other.clock.setFixedTime(new Date(SAVED_PAGES_TIME))
    await other.goto('/#saved')
    await waitForSavedCommit(other)
    await expectSavedPage(other, FIRST_TITLES, '25개 기회 중 1–12개 표시')
    await other.getByRole('button', { name: 'Fable 01 · Backend Engineer', exact: true }).click()
    await other.getByLabel('이 기회에 대한 나의 메모', { exact: true }).fill('PRIVATE-SAVED53 OtherTab note 01')
    await other.getByRole('button', { name: '지원 완료로 표시', exact: true }).click()
    await waitForSavedCommit(other)
    await other.keyboard.press('Escape')
    await expectSavedTotals(page, [25, 12, 13])
    await expectSavedPage(page, SECOND_TITLES, '25개 기회 중 13–24개 표시')

    await savedCard(other, 'Fable 01 · Backend Engineer').getByRole('button', { name: 'Fable Labs 저장 취소', exact: true }).click()
    await expectSavedPage(page, APPLIED_TITLES, '24개 기회 중 13–24개 표시')
    await expectPagerState(page, '2페이지 중 2페이지', false, true)
    await other.getByRole('button', { name: '실행 취소', exact: true }).click()
    await expectSavedPage(page, SECOND_TITLES, '25개 기회 중 13–24개 표시')

    await lastPage(page).click()
    await lastPage(other).click()
    await savedCard(other, 'Kite 25 · Backend Engineer').getByRole('button', { name: 'Paper Kite 저장 취소', exact: true }).click()
    await expectSavedPage(page, SECOND_TITLES, '24개 기회 중 13–24개 표시')
    await other.getByRole('button', { name: '실행 취소', exact: true }).click()
    await expectSavedPage(page, UNDO_SECOND_TITLES, '25개 기회 중 13–24개 표시')
    await expectPagerState(page, '3페이지 중 2페이지', false, false)
    await query(page).fill('OtherTab')
    await expectSavedPage(page, ['Fable 01 · Backend Engineer'], '1개 기회 중 1–1개 표시')
    await expect(page.locator('.saved-note-preview')).toHaveText('PRIVATE-SAVED53 OtherTab note 01')
    await expect(page.locator('.saved-status')).toHaveText('지원 완료')
    await expectSavedTotals(page, [25, 12, 13])
  } finally { await other.close() }
})

test('CSV and JSON include every off-page record under active filters, preserve notes, and keep private data local', async ({ page }) => {
  const traffic = watchApiRequests(page)
  await page.route('**/api/posting-status*', route => route.fulfill({ json: POSTING_INDEX }))
  await openSavedPages(page)
  await page.getByRole('button', { name: '게시 상태 확인', exact: true }).click()
  await expect(page.locator('.posting-summary')).toHaveText('게시 확인 13내용 차이 1목록에서 미확인 11확인 필요 1')
  await status(page, '검토 중').click()
  await query(page).fill('CohortNorth')
  await page.getByRole('combobox', { name: '게시 상태', exact: true }).selectOption('listed')
  await nextPage(page).click()
  await expectSavedPage(page, ['Fable 13 · Backend Engineer'], '13개 기회 중 13–13개 표시')
  await expectSavedTotals(page, [25, 13, 12])

  const csvDownload = page.waitForEvent('download')
  await page.getByRole('button', { name: 'CSV 내보내기', exact: true }).click()
  const csv = await readFile((await (await csvDownload).path())!, 'utf8')
  const [headers, ...rows] = parseSavedCsv(csv)
  expect(rows).toHaveLength(25)
  for (const name of ['포지션', '상태', '저장일', '메모', '채용 링크', '공개 게시 상태']) expect(headers).toContain(name)
  const column = (name: string) => headers.indexOf(name)
  expect(rows.map(row => row[column('포지션')])).toEqual([...FIRST_TITLES, ...SECOND_TITLES, 'Kite 25 · Backend Engineer'])
  expect(rows.map(row => row[column('채용 링크')].replace('https://example.org/saved-pages/', ''))).toEqual(ALL_IDS)
  expect(rows[0][column('메모')]).toBe('PRIVATE-SAVED53 CohortNorth note 01')
  expect(rows[12][column('메모')]).toBe('PRIVATE-SAVED53 CohortNorth note 13')
  expect(rows[24][column('메모')]).toBe('\'=1+2\nPRIVATE-SAVED53 CohortSouth Needle25, "가상 메모" 🌕')
  expect(rows[0][column('상태')]).toBe('저장됨')
  expect(rows[24][column('상태')]).toBe('지원 완료')
  expect(rows[0][column('공개 게시 상태')]).toBe('게시 확인')
  expect(rows[13][column('공개 게시 상태')]).toBe('공개 목록에서 미확인')
  expect(rows[24][column('공개 게시 상태')]).toBe('현재 상태 확인 필요')
  expect(rows.every(row => row.length === headers.length)).toBe(true)

  await page.getByRole('button', { name: '기록 백업·복원', exact: true }).click()
  const jsonDownload = page.waitForEvent('download')
  await page.getByRole('button', { name: 'JSON 백업', exact: true }).click()
  const json = await readFile((await (await jsonDownload).path())!, 'utf8')
  const backup = JSON.parse(json) as { format: string; version: number; includesUnsavedChanges: boolean; records: SavedJob[] }
  expect(backup).toMatchObject({ format: 'orbit-saved-backup', version: 1, includesUnsavedChanges: false })
  expect(backup.records).toHaveLength(25)
  expect(backup.records.map(record => record.job.id)).toEqual(ALL_IDS)
  expect(backup.records.map(record => record.job.title)).toEqual([...FIRST_TITLES, ...SECOND_TITLES, 'Kite 25 · Backend Engineer'])
  expect(backup.records[24]).toMatchObject({
    savedAt: '2026-09-25T08:00:00.000Z', status: 'applied',
    note: '=1+2\nPRIVATE-SAVED53 CohortSouth Needle25, "가상 메모" 🌕',
  })
  expect(backup.records).toEqual(await readSaved(page))
  for (const sentinel of ['PRIVATE-PROFILE-SAVED53', 'PRIVATE-RESUME-SAVED53', 'PRIVATE-LINK-SAVED53']) {
    expect(csv).not.toContain(sentinel)
    expect(json).not.toContain(sentinel)
  }
  await page.keyboard.press('Escape')
  await expectSavedPage(page, ['Fable 13 · Backend Engineer'], '13개 기회 중 13–13개 표시')
  expect(traffic.requests.map(request => ({ url: request.url, method: request.method, body: request.body }))).toEqual([
    { url: new URL('/api/posting-status?refresh=1', page.url()).href, method: 'GET', body: null },
  ])
})

test.describe('saved pagination keyboard and touch', () => {
  test.use({ viewport: { width: 320, height: 800 }, isMobile: true, hasTouch: true })

  test('keeps both 44px pagers separate from cards and mobile navigation, with visible keyboard focus and touch paging', async ({ page }, testInfo) => {
    await openSavedPages(page)
    await expectPagerGeometry(savedPager(page))
    await expectPagerGeometry(savedPager(page, '아래'))
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    const positions = await page.evaluate(() => {
      const top = document.querySelector('nav[aria-label="저장한 기회 페이지 이동 (위)"]')!.getBoundingClientRect()
      const grid = document.querySelector('.saved-grid')!.getBoundingClientRect()
      const bottom = document.querySelector('nav[aria-label="저장한 기회 페이지 이동 (아래)"]')!.getBoundingClientRect()
      return { topBottom: top.bottom, gridTop: grid.top, gridBottom: grid.bottom, bottomTop: bottom.top }
    })
    expect(positions.topBottom).toBeLessThanOrEqual(positions.gridTop)
    expect(positions.gridBottom).toBeLessThanOrEqual(positions.bottomTop)
    await nextPage(page).focus()
    await nextPage(page).press('Enter')
    await expectSavedPage(page, SECOND_TITLES, '25개 기회 중 13–24개 표시')
    await expectRevealedTitle(page, 'Fable 13 · Backend Engineer')
    const focus = await page.locator('.saved-title').first().evaluate(element => ({
      visible: element.matches(':focus-visible'),
      style: getComputedStyle(element).outlineStyle,
      width: getComputedStyle(element).outlineWidth,
    }))
    expect(focus.visible).toBe(true)
    expect(focus.style).not.toBe('none')
    expect(Number.parseFloat(focus.width)).toBeGreaterThanOrEqual(2)
    await page.keyboard.press('Tab')
    await expect(savedCard(page, 'Fable 13 · Backend Engineer').getByRole('button', { name: '자세히', exact: true })).toBeFocused()
    await testInfo.attach('saved-page-2-keyboard-320', { body: await page.screenshot(), contentType: 'image/png' })

    await nextPage(page, '아래').scrollIntoViewIfNeeded()
    const bottomControl = await nextPage(page, '아래').boundingBox()
    const mobileNav = await page.locator('.main-nav').boundingBox()
    expect(bottomControl).not.toBeNull()
    expect(mobileNav).not.toBeNull()
    expect(bottomControl!.y + bottomControl!.height).toBeLessThanOrEqual(mobileNav!.y)
    await nextPage(page, '아래').tap()
    await expectSavedPage(page, ['Kite 25 · Backend Engineer'], '25개 기회 중 25–25개 표시')
    await expectRevealedTitle(page, 'Kite 25 · Backend Engineer')
    await expectPagerState(page, '3페이지 중 3페이지', false, true)
    await firstPage(page).tap()
    await expectSavedPage(page, FIRST_TITLES, '25개 기회 중 1–12개 표시')
    await expectRevealedTitle(page, 'Fable 01 · Backend Engineer')
    await lastPage(page).focus()
    await lastPage(page).press('Space')
    await expectSavedPage(page, ['Kite 25 · Backend Engineer'], '25개 기회 중 25–25개 표시')
    await expectRevealedTitle(page, 'Kite 25 · Backend Engineer')
    await expectPagerGeometry(savedPager(page))
    await expectPagerGeometry(savedPager(page, '아래'))
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    expect(await page.locator('.collection-page').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
    expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([])
    await testInfo.attach('saved-last-page-320', { body: await page.screenshot(), contentType: 'image/png' })
  })
})
