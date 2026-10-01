/**
 * Stage78: saved-job state across document lifecycle transitions and missed
 * cross-tab notifications. Expected values are literal fixture values and
 * user-visible strings; no product function computes an expectation.
 *
 * Every dispatched focus/visibilitychange/pageshow here is a synthetic signal
 * that exercises the listener path. Only the final test performs a native
 * history return in a separately owned browser, and it classifies what that
 * browser did (restoration or reload) instead of asserting cache eligibility.
 *
 * Required images are framed and measured through captureFrame (see the
 * helpers): targets are exposed with the product's own scrolling, verified to be
 * inside the viewport and clear of the sticky footer, and every image carries a
 * `-geometry` record beside it.
 */
import { chromium, expect } from '@playwright/test'
import type { Page } from '@playwright/test'
import { PUBLIC_PROTOCOL_COMPANIES, PUBLIC_PROTOCOL_TIME, publicProtocolJob } from '../fixtures/public-protocol'
import type { SavedJob } from '../../shared/types'
import { publicAppTest as test } from './helpers/public-app'
import { readServerMode, watchApiRequests } from './helpers/api-requests'
import { downloadText } from './helpers/saved-retirement'
import { waitForSavedCommit } from './helpers/saved-store'
import { SAVED_PAGES_TIME, expectPagerState, expectSavedPage, expectSavedTotals, openSavedPages, savedCard, savedPager } from './helpers/saved-pages'
import {
  RETURN_SIGNALS, SAVED_DATABASE_NAME, attachDraftTimeline, awaitLayoutReady, captureFrame, collectNavigationEntries, collectPageErrors,
  createDraftTimeline, dispatchExcludedSignal, dispatchReturn, draftFieldStabilityFailures, expectNeverBusy, installStorageProbe,
  overrideVisibility, putRawSavedEntry, rawSavedState, readCommitted, rewriteSavedRecord, settle, snapshotDraftField, storageProbe,
  unloadIsProtected, watchNavBusy,
} from './helpers/saved-lifecycle'

const SAVED_AT = '2026-09-19T08:00:00.000Z'
const COMPANY = PUBLIC_PROTOCOL_COMPANIES[0]
const jobId = (key: string) => `greenhouse-fixture-aster-transit-${key}`
const title = (key: string) => `Backend Engineer — Lifecycle ${key}`
function record(key: string, note = '', status: SavedJob['status'] = 'saved'): SavedJob {
  return { job: publicProtocolJob(key, { title: title(key) }), company: structuredClone(COMPANY), savedAt: SAVED_AT, status, note }
}
function backupFile(records: SavedJob[], name = 'lifecycle-backup.json') {
  return {
    name, mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify({ format: 'orbit-saved-backup', version: 1, exportedAt: PUBLIC_PROTOCOL_TIME, includesUnsavedChanges: false, records })),
  }
}
// An old sample entry exactly as an earlier tab could rewrite it. It must never become an active card.
const RETIRED_SAMPLE_ENTRY = {
  id: 'sample-lifecycle-obsolete', order: 9,
  record: {
    job: { ...publicProtocolJob('lifecycle-obsolete', { title: 'Legacy fictional opportunity (lifecycle)' }), id: 'sample-lifecycle-obsolete', source: 'sample' },
    company: structuredClone(COMPANY), savedAt: '2026-09-18T00:00:00.000Z', status: 'applied', note: 'RETIRED SAMPLE NOTE kept outside the active list',
  },
}

const noteField = (page: Page) => page.getByLabel('이 기회에 대한 나의 메모', { exact: true })
const navCount = (page: Page) => page.locator('.main-nav .nav-count').first()
const mainNav = (page: Page) => page.getByRole('navigation', { name: '주요 메뉴' })
const importRow = (page: Page, key: string) => page.locator('.saved-import-row').filter({ hasText: title(key) })
const staleWarning = (page: Page) => page.getByText('검토 중 현재 목록이 갱신됐어요. 다시 비교한 뒤 반영해 주세요.', { exact: true })
const removeButton = (page: Page, key: string) => savedCard(page, title(key)).getByRole('button', { name: 'Aster Transit 저장 취소', exact: true })
const preview = (page: Page, key: string) => savedCard(page, title(key)).locator('.saved-note-preview')
const statusBadge = (page: Page, key: string) => savedCard(page, title(key)).locator('.saved-status')

async function seed(page: Page, records: unknown[], options: { channel?: boolean } = {}) {
  await page.addInitScript(({ raw, channel }) => {
    localStorage.setItem('orbit.v1.saved', raw)
    localStorage.setItem('orbit.v1.exploration', JSON.stringify({ source: 'public', mapMode: 'flat' }))
    // An environment where the notification channel cannot be constructed at all.
    if (channel === false) Reflect.deleteProperty(window, 'BroadcastChannel')
  }, { raw: JSON.stringify(records), channel: options.channel })
}
async function openSaved(page: Page, titles: string[]) {
  await page.goto('/#saved')
  await expect(page.locator('.saved-title')).toHaveText(titles)
}
async function otherTab(page: Page, time = PUBLIC_PROTOCOL_TIME) {
  const other = await page.context().newPage()
  await other.clock.setFixedTime(new Date(time))
  return other
}
async function openFiles(page: Page) {
  await page.getByRole('button', { name: '기록 백업·복원', exact: true }).click()
  await expect(page.getByRole('dialog', { name: '기록 백업과 복원', exact: true })).toBeVisible()
}
async function chooseFile(page: Page, file: ReturnType<typeof backupFile>) {
  await page.getByLabel('백업 또는 복구 파일', { exact: true }).setInputFiles(file)
}
async function serverMode(page: Page) {
  return readServerMode(page.request, new URL('/api/health', page.url()).href)
}
async function importReplacement(page: Page, replacement: SavedJob) {
  await openFiles(page)
  await chooseFile(page, backupFile([replacement], 'fictional-replacement.json'))
  await expect(page.locator('.saved-import-row')).toHaveCount(1)
  await page.locator('.saved-import-row').getByRole('checkbox').check()
  await page.getByRole('button', { name: '선택한 1개 가져오기', exact: true }).click()
  await expect(page.locator('.saved-file-message')).toContainText('선택한 1개 기록을 저장했어요. 새 공고 0개 · 기존 공고 변경 1개.')
  await page.keyboard.press('Escape')
}
/** Records writes fail with a storage-full error; every attempt is counted so a retry can be proven absent. */
async function installFailingPut(page: Page) {
  await page.evaluate(() => {
    const put = IDBObjectStore.prototype.put
    const probe = { attempts: 0 }
    Reflect.set(window, '__lifecycleFailingPut', probe)
    IDBObjectStore.prototype.put = function (...args) {
      if (this.name === 'records') { probe.attempts++; throw new DOMException('Test full storage', 'QuotaExceededError') }
      return Reflect.apply(put, this, args)
    }
    Reflect.set(window, '__restoreLifecyclePut', () => { IDBObjectStore.prototype.put = put })
  })
  return {
    attempts: () => page.evaluate(() => (Reflect.get(window, '__lifecycleFailingPut') as { attempts: number }).attempts),
    restore: () => page.evaluate(() => (Reflect.get(window, '__restoreLifecyclePut') as () => void)()),
  }
}
/** Every transaction on the saved database fails like a connection another context closed. */
async function installTransactionFault(page: Page) {
  await page.evaluate(name => {
    const transaction = IDBDatabase.prototype.transaction
    const fault = { enabled: true }
    Reflect.set(window, '__lifecycleTransactionFault', fault)
    IDBDatabase.prototype.transaction = function (this: IDBDatabase, ...args: Parameters<IDBDatabase['transaction']>) {
      if (fault.enabled && this.name === name) throw new DOMException('Simulated closed saved connection', 'InvalidStateError')
      return Reflect.apply(transaction, this, args) as IDBTransaction
    }
  }, SAVED_DATABASE_NAME)
  return { disable: () => page.evaluate(() => { (Reflect.get(window, '__lifecycleTransactionFault') as { enabled: boolean }).enabled = false }) }
}

test.beforeEach(async ({ page }) => { await page.clock.setFixedTime(new Date(PUBLIC_PROTOCOL_TIME)) })

for (const signal of RETURN_SIGNALS) {
  test(`another tab's note, status, addition and removal appear after a visible ${signal} when the notification channel cannot be constructed (synthetic signal)`, async ({ page }) => {
    const errors = collectPageErrors(page)
    await seed(page, [record('first', 'Original saved note'), record('second', 'Second original note')], { channel: false })
    await openSaved(page, [title('first'), title('second')])
    await installStorageProbe(page)
    await watchNavBusy(page)
    const other = await otherTab(page)
    try {
      await other.goto('/#saved')
      await expect(other.locator('.saved-title')).toHaveText([title('first'), title('second')])
      await other.getByRole('button', { name: title('first'), exact: true }).click()
      await noteField(other).fill('OTHER TAB NOTE')
      await other.getByRole('button', { name: '지원 완료로 표시', exact: true }).click()
      await expect(other.getByRole('button', { name: '지원 완료로 표시됨', exact: true })).toBeVisible()
      await waitForSavedCommit(other)
      await other.getByRole('button', { name: '닫기', exact: true }).click()
      await removeButton(other, 'second').click()
      await waitForSavedCommit(other)
      await openFiles(other)
      await chooseFile(other, backupFile([record('added', 'Added in another tab', 'applied')]))
      await other.getByRole('button', { name: '선택한 1개 가져오기', exact: true }).click()
      await expect(other.locator('.saved-file-message')).toContainText('선택한 1개 기록을 저장했어요. 새 공고 1개 · 기존 공고 변경 0개.')
      await other.keyboard.press('Escape')
      const committed = await readCommitted(other)
      expect(committed.map(item => item.job.title)).toEqual([title('added'), title('first')])
      expect(committed[0]).toMatchObject({ note: 'Added in another tab', status: 'applied', savedAt: SAVED_AT })
      expect(committed[1]).toMatchObject({ note: 'OTHER TAB NOTE', status: 'applied', savedAt: SAVED_AT })

      // Precondition: with no channel this document still shows the earlier collection.
      await expect(page.locator('.saved-title')).toHaveText([title('first'), title('second')])
      await expect(preview(page, 'first')).toHaveText('Original saved note')
      const before = await storageProbe(page)
      await dispatchReturn(page, signal)
      await expect(page.locator('.saved-title')).toHaveText([title('added'), title('first')])
      await expect(preview(page, 'first')).toHaveText('OTHER TAB NOTE')
      await expect(statusBadge(page, 'first')).toHaveText('지원 완료')
      await expect(preview(page, 'added')).toHaveText('Added in another tab')
      await expect(navCount(page)).toHaveText('2')
      await expect(page.locator('.collection-tabs button')).toHaveText(['전체2', '검토 중0', '지원 완료2'])
      expect(await storageProbe(page)).toEqual({ reads: before.reads + 1, mutations: 0 })
      await expectNeverBusy(page)
      expect(await readCommitted(page)).toEqual(committed)
      const csv = await downloadText(page, page.getByRole('button', { name: 'CSV 내보내기', exact: true }))
      expect(csv).toContain('OTHER TAB NOTE')
      expect(csv).toContain(title('added'))
      expect(csv).not.toContain(title('second'))
      await openFiles(page)
      const backup = JSON.parse(await downloadText(page, page.getByRole('button', { name: 'JSON 백업', exact: true })))
      expect(backup.includesUnsavedChanges).toBe(false)
      expect(backup.records).toEqual(committed)
      expect(errors()).toEqual([])
    } finally { await other.close() }
  })
}

test('a change written without any notification appears on in-app entry to the saved view and on a visible focus, one read each (synthetic focus)', async ({ page }) => {
  const errors = collectPageErrors(page)
  await seed(page, [record('first', 'Original saved note')])
  await openSaved(page, [title('first')])
  await installStorageProbe(page)
  await rewriteSavedRecord(page, jobId('first'), { note: 'Written without a notification', status: 'applied' })
  await expect(preview(page, 'first')).toHaveText('Original saved note')
  await expect(statusBadge(page, 'first')).toHaveText('검토 중')
  const before = await storageProbe(page)
  await mainNav(page).getByRole('button', { name: '기회 탐색', exact: true }).click()
  await expect(page.getByRole('button', { name: '공개 채용', exact: true })).toBeVisible()
  await mainNav(page).getByRole('button', { name: /^저장한 기회/ }).click()
  await expect(preview(page, 'first')).toHaveText('Written without a notification')
  await expect(statusBadge(page, 'first')).toHaveText('지원 완료')
  expect(await storageProbe(page)).toEqual({ reads: before.reads + 1, mutations: 0 })
  await rewriteSavedRecord(page, jobId('first'), { note: 'Second silent change' })
  await dispatchReturn(page, 'focus')
  await expect(preview(page, 'first')).toHaveText('Second silent change')
  expect(await storageProbe(page)).toEqual({ reads: before.reads + 2, mutations: 0 })
  expect(errors()).toEqual([])
})

test('saving still works without a notification channel and the other tab catches up on its own visible return (synthetic signal)', async ({ page }) => {
  await seed(page, [record('first', 'Original saved note')], { channel: false })
  await openSaved(page, [title('first')])
  const other = await otherTab(page)
  try {
    await other.goto('/#saved')
    await expect(other.locator('.saved-title')).toHaveText([title('first')])
    await installStorageProbe(other)
    await page.getByRole('button', { name: title('first'), exact: true }).click()
    await noteField(page).fill('No channel note')
    await waitForSavedCommit(page)
    await expect(page.getByRole('button', { name: '저장됨', exact: true })).toBeVisible()
    expect((await readCommitted(page))[0]).toMatchObject({ note: 'No channel note', status: 'saved', savedAt: SAVED_AT })
    expect(await unloadIsProtected(page)).toBe(false)
    await expect(preview(other, 'first')).toHaveText('Original saved note')
    await dispatchReturn(other, 'visibilitychange')
    await expect(preview(other, 'first')).toHaveText('No channel note')
    expect(await storageProbe(other)).toEqual({ reads: 1, mutations: 0 })
  } finally { await other.close() }
})

test('hidden visibility, a non-persisted pageshow, element focus and typing cause no read; a synchronous visible burst causes exactly one; a later return is not dropped (synthetic signals)', async ({ page }) => {
  const errors = collectPageErrors(page)
  await seed(page, [record('first', 'Original saved note')])
  await openSaved(page, [title('first')])
  await installStorageProbe(page)
  await watchNavBusy(page)
  await overrideVisibility(page, 'hidden')
  await dispatchReturn(page, 'visibilitychange')
  await dispatchReturn(page, 'focus')
  await settle(page, 200)
  await overrideVisibility(page, null)
  expect(await storageProbe(page)).toEqual({ reads: 0, mutations: 0 })
  await dispatchExcludedSignal(page, 'pageshow-not-persisted')
  await dispatchExcludedSignal(page, 'focusin')
  await dispatchExcludedSignal(page, 'element-focus')
  const search = page.getByRole('textbox', { name: '저장한 기회 검색', exact: true })
  await search.focus()
  await search.fill('Lifecycle')
  await expect(page.locator('.saved-title')).toHaveText([title('first')])
  await settle(page, 200)
  expect(await storageProbe(page)).toEqual({ reads: 0, mutations: 0 })
  await dispatchReturn(page, 'burst')
  await expect.poll(async () => (await storageProbe(page)).reads).toBe(1)
  await settle(page, 200)
  expect(await storageProbe(page)).toEqual({ reads: 1, mutations: 0 })
  await dispatchReturn(page, 'focus')
  await expect.poll(async () => (await storageProbe(page)).reads).toBe(2)
  await settle(page, 200)
  expect(await storageProbe(page)).toEqual({ reads: 2, mutations: 0 })
  await expect(search).toHaveValue('Lifecycle')
  await expectNeverBusy(page)
  expect(await unloadIsProtected(page)).toBe(false)
  expect(errors()).toEqual([])
})

test('a new unreadable entry invalidates the import review until recompare, a retired sample archive change does not, and a stale archive confirmation cannot delete the newer archive (synthetic signals)', async ({ page }) => {
  await seed(page, [record('current', 'Keep the current copy')])
  await openSaved(page, [title('current')])
  await installStorageProbe(page)
  await openFiles(page)
  await chooseFile(page, backupFile([record('new', 'New from file')]))
  await expect(importRow(page, 'new').getByRole('checkbox')).toBeChecked()
  const selection = page.locator('.saved-import-selection')
  await expect(selection).toHaveText('선택 1개 · 새 공고 1개 추가 · 기존 0개 변경 · 저장 후 2/500개')
  await putRawSavedEntry(page, { id: jobId('damaged'), order: 'Unreadable order', record: record('damaged', 'Recover this note') })
  await dispatchReturn(page, 'focus')
  await expect(staleWarning(page)).toBeVisible()
  await expect(page.getByRole('button', { name: '선택한 1개 가져오기', exact: true })).toBeDisabled()
  const unreadable = page.locator('.saved-recovery-source').filter({ hasText: '읽을 수 없는 저장 항목' })
  await expect(unreadable).toContainText('목록에 합치지 못한 항목 1개')
  await page.getByRole('button', { name: '현재 기록으로 다시 비교', exact: true }).click()
  await expect(page.locator('.saved-file-message')).toContainText('현재 기록으로 다시 비교했어요. 기존 기록을 바꾸는 선택은 초기화했어요.')
  await expect(staleWarning(page)).toHaveCount(0)
  await expect(selection).toHaveText('선택 1개 · 새 공고 1개 추가 · 기존 0개 변경 · 저장 후 3/500개')
  await expect(page.getByRole('button', { name: '선택한 1개 가져오기', exact: true })).toBeEnabled()

  // A recovery-only change: an older tab rewrote a retired sample. The archive is disclosed; the unrelated review stays valid.
  await putRawSavedEntry(page, RETIRED_SAMPLE_ENTRY)
  await dispatchReturn(page, 'visibilitychange')
  const archive = page.locator('.saved-recovery-source').filter({ hasText: '이전 가상 공고의 메모·기록' })
  await expect(archive).toContainText('예전 메모·지원 상태·원본 1개를 보관했어요. 실제 공고 목록에는 포함하지 않아요.')
  await expect(staleWarning(page)).toHaveCount(0)
  await expect(selection).toHaveText('선택 1개 · 새 공고 1개 추가 · 기존 0개 변경 · 저장 후 3/500개')
  await expect(page.locator('.saved-title')).toHaveText([title('current')])
  let raw = await rawSavedState(page)
  expect((raw.entries as { id: string }[]).map(entry => entry.id).sort()).toEqual([jobId('current'), jobId('damaged')].sort())
  expect(raw.meta?.retiredSamples).toEqual([RETIRED_SAMPLE_ENTRY])

  // A deletion confirmed against the earlier archive must not remove the newer one.
  await archive.getByRole('button', { name: '보관본 삭제', exact: true }).click()
  await expect(page.getByRole('group', { name: '보관본 삭제 확인', exact: true })).toBeVisible()
  const rewritten = { ...RETIRED_SAMPLE_ENTRY, record: { ...RETIRED_SAMPLE_ENTRY.record, note: 'OLD TAB REWROTE THE SAMPLE' } }
  await putRawSavedEntry(page, rewritten)
  await dispatchReturn(page, 'focus')
  await expect(archive).toContainText('예전 메모·지원 상태·원본 2개를 보관했어요. 실제 공고 목록에는 포함하지 않아요.')
  await page.getByRole('button', { name: '선택한 보관본 삭제', exact: true }).click()
  await expect(page.locator('.saved-file-error')).toHaveText('보관본이 바뀌었어요. 갱신된 원본을 확인하고 다시 선택해 주세요.')
  raw = await rawSavedState(page)
  expect(raw.meta?.retiredSamples).toEqual([RETIRED_SAMPLE_ENTRY, rewritten])

  // The unrelated file review is still importable.
  await expect(staleWarning(page)).toHaveCount(0)
  await page.getByRole('button', { name: '선택한 1개 가져오기', exact: true }).click()
  await expect(page.locator('.saved-file-message')).toContainText('선택한 1개 기록을 저장했어요. 새 공고 1개 · 기존 공고 변경 0개.')
  const final = await rawSavedState(page)
  const byId = new Map((final.entries as { id: string; record: SavedJob }[]).map(entry => [entry.id, entry]))
  expect([...byId.keys()].sort()).toEqual([jobId('current'), jobId('damaged'), jobId('new')].sort())
  expect(byId.get(jobId('new'))?.record).toMatchObject({ note: 'New from file', status: 'saved', savedAt: SAVED_AT })
  await page.keyboard.press('Escape')
  await expect(page.locator('.saved-title')).toHaveText([title('new'), title('current')])
})

test('a note typed for a record another tab removed stays visible through return signals and is restored only by the explicit retry (synthetic signals)', async ({ page }) => {
  await seed(page, [record('first', 'Original saved note'), record('second', 'Second original note')], { channel: false })
  await openSaved(page, [title('first'), title('second')])
  const other = await otherTab(page)
  try {
    await other.goto('/#saved')
    await expect(other.locator('.saved-title')).toHaveText([title('first'), title('second')])
    await removeButton(other, 'first').click()
    await waitForSavedCommit(other)
    expect((await readCommitted(other)).map(item => item.job.title)).toEqual([title('second')])
  } finally { await other.close() }
  // Without a channel this tab is not yet aware of the removal.
  await expect(page.locator('.saved-title')).toHaveText([title('first'), title('second')])
  await page.getByRole('button', { name: title('first'), exact: true }).click()
  await noteField(page).fill('Do not lose this draft')
  const alert = page.getByRole('alert')
  await expect(alert).toContainText('아직 저장하지 못한 변경이 있어요.')
  await expect(alert).toContainText('다른 탭에서 이 공고를 제거했어요. 다시 시도하면 현재 메모와 함께 복원해요.')
  await expect(alert).toContainText('마지막 입력은 이 탭에 남아 있어요. 저장 완료 전에는 탭을 닫지 마세요.')
  await installStorageProbe(page)
  await dispatchReturn(page, 'burst')
  await dispatchReturn(page, 'burst')
  await settle(page, 200)
  await expect(noteField(page)).toHaveValue('Do not lose this draft')
  await expect(alert).toContainText('다른 탭에서 이 공고를 제거했어요. 다시 시도하면 현재 메모와 함께 복원해요.')
  expect(await storageProbe(page)).toEqual({ reads: 0, mutations: 0 })
  expect((await readCommitted(page)).map(item => item.job.title)).toEqual([title('second')])
  expect(await unloadIsProtected(page)).toBe(true)
  await page.getByRole('button', { name: '저장 다시 시도', exact: true }).click()
  await waitForSavedCommit(page)
  await expect(page.locator('.job-dialog .saved-storage-notice.has-error')).toHaveCount(0)
  await expect(noteField(page)).toHaveValue('Do not lose this draft')
  const restored = await readCommitted(page)
  expect(restored.map(item => item.job.title)).toEqual([title('first'), title('second')])
  expect(restored[0]).toMatchObject({ note: 'Do not lose this draft', status: 'saved', savedAt: SAVED_AT })
  expect(await unloadIsProtected(page)).toBe(false)
})

test('a failed return read is reported with the existing texts and keeps the collection; explicit comparison reports the failure; a save during the failure waits as a draft until reconnect (synthetic signal and fault)', async ({ page }) => {
  const errors = collectPageErrors(page)
  await seed(page, [record('first', 'Original saved note')])
  await openSaved(page, [title('first')])
  await installStorageProbe(page)
  const fault = await installTransactionFault(page)
  await dispatchReturn(page, 'visibilitychange')
  const alert = page.getByRole('alert')
  await expect(alert).toContainText('저장소 연결을 확인해 주세요.')
  await expect(alert).toContainText('저장소에 연결하지 못했거나 저장이 중단됐어요. 다시 시도해 주세요.')
  await expect(alert).toContainText('마지막으로 읽은 기록을 표시하고 있어요.')
  await expect(page.getByRole('button', { name: '저장소 다시 연결', exact: true })).toBeVisible()
  await expect(page.locator('.saved-title')).toHaveText([title('first')])
  await expect(preview(page, 'first')).toHaveText('Original saved note')
  expect(await unloadIsProtected(page)).toBe(false)
  expect((await storageProbe(page)).mutations).toBe(0)

  // Explicit comparison during the failure reports the mapped error and keeps the selection.
  await openFiles(page)
  await chooseFile(page, backupFile([record('from-file', 'From file')]))
  await expect(importRow(page, 'from-file').getByRole('checkbox')).toBeChecked()
  await page.getByRole('button', { name: '현재 기록으로 다시 비교', exact: true }).click()
  await expect(page.locator('.saved-file-error')).toHaveText('반영을 완료하지 못했어요. 기존 기록은 그대로예요. 다시 시도해 주세요.')
  await expect(page.locator('.saved-file-message')).toHaveCount(0)
  await expect(importRow(page, 'from-file').getByRole('checkbox')).toBeChecked()
  await page.keyboard.press('Escape')

  // A save requested while the connection is known-broken waits as a draft; nothing is written until reconnect.
  await mainNav(page).getByRole('button', { name: '기회 탐색', exact: true }).click()
  await expect(page.getByRole('button', { name: '공개 채용', exact: true })).toBeVisible()
  await page.getByRole('button', { name: /^런던, 추천 회사 \d+곳 보기$/ }).click()
  await page.locator('.mini-job-title', { hasText: 'Backend Engineer — Aster Transit London' }).click()
  await page.getByRole('button', { name: '기회 저장', exact: true }).click()
  await expect(page.locator('.toast')).toContainText('Aster Transit의 기회를 목록에 추가했어요.')
  await expect(navCount(page)).toHaveText('2')
  await expect(page.getByRole('button', { name: '목록에서 제거', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '닫기', exact: true }).click()
  await expect(page.locator('.global-saved-status')).toContainText('아직 저장하지 못한 변경이 있어요.')
  expect(await unloadIsProtected(page)).toBe(true)
  expect((await storageProbe(page)).mutations).toBe(0)
  await fault.disable()
  expect((await readCommitted(page)).map(item => item.job.title)).toEqual([title('first')])
  await page.locator('.global-saved-status').getByRole('button', { name: '저장 다시 시도', exact: true }).click()
  await waitForSavedCommit(page)
  await expect(page.locator('.global-saved-status')).toHaveCount(0)
  const committed = await readCommitted(page)
  expect(committed.map(item => item.job.title)).toEqual(['Backend Engineer — Aster Transit London', title('first')])
  expect(committed[0]).toMatchObject({ job: { id: 'greenhouse-fixture-aster-transit-london' }, status: 'saved', note: '', savedAt: PUBLIC_PROTOCOL_TIME })
  expect(await unloadIsProtected(page)).toBe(false)
  expect(errors()).toEqual([])
})

test('an explicit comparison while a failed draft is pending keeps the selection and reports the existing storage error instead of a false success', async ({ page }) => {
  await seed(page, [record('first', 'Original saved note')])
  await openSaved(page, [title('first')])
  await page.getByRole('button', { name: title('first'), exact: true }).click()
  await installFailingPut(page)
  await noteField(page).fill('Draft before comparison')
  await expect(page.getByRole('alert')).toContainText('아직 저장하지 못한 변경이 있어요.')
  await page.getByRole('button', { name: 'JSON 백업·복원', exact: true }).click()
  await expect(page.getByRole('dialog', { name: '기록 백업과 복원', exact: true })).toBeVisible()
  await chooseFile(page, backupFile([record('from-file', 'From file')]))
  await expect(importRow(page, 'from-file').getByRole('checkbox')).toBeChecked()
  await expect(page.getByRole('button', { name: '선택한 1개 가져오기', exact: true })).toBeDisabled()
  await page.getByRole('button', { name: '현재 기록으로 다시 비교', exact: true }).click()
  // Agreed reading (IC1): an existing storage error identifies the remedy, so the comparison reports that error
  // even while the failed draft is pending. Waiting would never resume a failed write; only the explicit retry can.
  await expect(page.locator('.saved-file-error')).toHaveText('브라우저 저장 공간이 부족해 반영하지 못했어요. 기존 기록은 그대로예요. 공간을 확보한 뒤 다시 시도해 주세요.')
  await expect(page.locator('.saved-file-message')).toHaveCount(0)
  await expect(importRow(page, 'from-file').getByRole('checkbox')).toBeChecked()
  expect((await readCommitted(page))[0]).toMatchObject({ note: 'Original saved note', status: 'saved' })
  const backup = JSON.parse(await downloadText(page, page.getByRole('button', { name: 'JSON 백업', exact: true })))
  expect(backup).toMatchObject({ includesUnsavedChanges: true, records: [{ note: 'Draft before comparison' }] })
})

test('a detail opened from exploration keeps its catalog posting while its saved note follows the other tab, and closing returns focus to the catalog title', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('orbit.v1.exploration', JSON.stringify({ source: 'public', mapMode: 'flat' })))
  await page.goto('/')
  await expect(page.getByRole('button', { name: '공개 채용', exact: true })).toBeVisible()
  await page.getByRole('button', { name: /^런던, 추천 회사 \d+곳 보기$/ }).click()
  const opener = page.locator('.mini-job-title', { hasText: 'Backend Engineer — Aster Transit London' })
  await opener.click()
  const dialog = page.getByRole('dialog', { name: 'Aster Transit', exact: true })
  await expect(dialog.getByRole('heading', { name: 'Backend Engineer — Aster Transit London', exact: true })).toBeVisible()
  await dialog.getByRole('button', { name: '기회 저장', exact: true }).click()
  await waitForSavedCommit(page)
  await expect(dialog.getByRole('button', { name: '저장됨', exact: true })).toBeVisible()
  const saved = (await readCommitted(page))[0]
  expect(saved).toMatchObject({ job: { id: 'greenhouse-fixture-aster-transit-london', title: 'Backend Engineer — Aster Transit London' }, status: 'saved', note: '' })
  const other = await otherTab(page)
  try {
    await other.goto('/#saved')
    await expect(other.locator('.saved-title')).toHaveText(['Backend Engineer — Aster Transit London'])
    await importReplacement(other, {
      ...saved, note: 'IMPORTED NOTE', status: 'applied',
      job: { ...saved.job, title: 'Backend Engineer — Replaced in another tab', url: 'https://example.test/jobs/replaced-london' },
    })
    await expect(noteField(page)).toHaveValue('IMPORTED NOTE')
    await expect(dialog.getByRole('button', { name: '지원 완료로 표시됨', exact: true })).toBeVisible()
    await expect(dialog.getByRole('heading', { name: 'Backend Engineer — Aster Transit London', exact: true })).toBeVisible()
    await expect(dialog.getByRole('link', { name: '원문에서 지원하기', exact: true })).toHaveAttribute('href', 'https://example.test/jobs/london')
    expect((await readCommitted(page))[0].job.title).toBe('Backend Engineer — Replaced in another tab')
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await expect(opener).toBeFocused()
  } finally { await other.close() }
})

test('500 saved records keep the last page, totals and focus through a return burst, the backup equals the database and no API request occurs (synthetic burst)', async ({ page }) => {
  const traffic = watchApiRequests(page)
  await openSavedPages(page, 500)
  await installStorageProbe(page)
  await savedPager(page).getByRole('button', { name: '마지막 저장 페이지', exact: true }).click()
  const lastTitles = [
    'Fable 493 · Backend Engineer', 'Fable 494 · Backend Engineer', 'Fable 495 · Backend Engineer', 'Fable 496 · Backend Engineer',
    'Fable 497 · Backend Engineer', 'Fable 498 · Backend Engineer', 'Fable 499 · Backend Engineer', 'Fable 500 · Backend Engineer',
  ]
  await expectSavedPage(page, lastTitles, '500개 기회 중 493–500개 표시')
  await expect(page.locator('.saved-title').first()).toBeFocused()
  await dispatchReturn(page, 'burst')
  await expect.poll(async () => (await storageProbe(page)).reads).toBe(1)
  await expectSavedPage(page, lastTitles, '500개 기회 중 493–500개 표시')
  await expectPagerState(page, '42페이지 중 42페이지', false, true)
  await expectSavedTotals(page, [500, 488, 12])
  await expect(page.locator('.saved-title').first()).toBeFocused()
  expect(await storageProbe(page)).toEqual({ reads: 1, mutations: 0 })
  await openFiles(page)
  const backup = JSON.parse(await downloadText(page, page.getByRole('button', { name: 'JSON 백업', exact: true })))
  expect(backup.records).toHaveLength(500)
  expect(backup.records).toEqual(await readCommitted(page))
  expect(traffic.requests).toEqual([])
})

for (const width of [1440, 320]) {
  test.describe(`saved lifecycle at ${width}px`, () => {
    test.use({ viewport: { width, height: width === 320 ? 800 : 960 }, isMobile: width === 320, hasTouch: width === 320 })

    test(`an unchanged return keeps the import selection, chosen variant and page at ${width}px (synthetic burst)`, async ({ page }, testInfo) => {
      await seed(page, [record('conflict', 'CURRENT NOTE', 'applied'), record('keep', 'Unchanged')])
      await openSaved(page, [title('conflict'), title('keep')])
      await installStorageProbe(page)
      await openFiles(page)
      const additions = Array.from({ length: 24 }, (_, index) => record(`new-${String(index + 1).padStart(2, '0')}`, `New ${index + 1} from file`))
      await chooseFile(page, backupFile([record('conflict', 'FILE NOTE A'), record('conflict', 'FILE NOTE B', 'applied'), ...additions]))
      await expect(page.locator('.saved-import-summary')).toContainText('공고 25개 · 새 공고 24개 · 현재와 다른 공고 1개 · 같은 기록 0개')
      const selection = page.locator('.saved-import-selection')
      await expect(selection).toHaveText('선택 24개 · 새 공고 24개 추가 · 기존 0개 변경 · 저장 후 26/500개')
      const variants = importRow(page, 'conflict').getByRole('combobox', { name: 'Aster Transit Backend Engineer — Lifecycle conflict 파일 기록 선택', exact: true })
      await variants.selectOption('1')
      await importRow(page, 'conflict').getByRole('checkbox').check()
      await expect(selection).toHaveText('선택 25개 · 새 공고 24개 추가 · 기존 1개 변경 · 저장 후 26/500개')
      await page.getByRole('button', { name: '다음 공고 페이지', exact: true }).click()
      const pageIndicator = page.locator('.saved-import-pagination span')
      await expect(pageIndicator).toHaveText('2 / 2')
      await dispatchReturn(page, 'burst')
      await expect.poll(async () => (await storageProbe(page)).reads).toBe(1)
      await expect(staleWarning(page)).toHaveCount(0)
      await expect(pageIndicator).toHaveText('2 / 2')
      await expect(selection).toHaveText('선택 25개 · 새 공고 24개 추가 · 기존 1개 변경 · 저장 후 26/500개')
      await expect(page.getByRole('button', { name: '선택한 25개 가져오기', exact: true })).toBeEnabled()
      await page.getByRole('button', { name: '이전 공고 페이지', exact: true }).click()
      await expect(importRow(page, 'conflict').getByRole('checkbox')).toBeChecked()
      await expect(variants).toHaveValue('1')
      await expect(pageIndicator).toHaveText('1 / 2')
      expect((await storageProbe(page)).mutations).toBe(0)
      // VC1: the checked conflict row, its chosen file variant and the retained totals are framed inside the import dialog's own
      // scroller and clear of its sticky footer. The pager cannot share a frame with row 1, so the page is asserted and recorded.
      const mode = await serverMode(page)
      const importDialog = page.getByRole('dialog', { name: '기록 백업과 복원', exact: true })
      const conflictRow = importRow(page, 'conflict')
      const importAction = page.getByRole('button', { name: '선택한 25개 가져오기', exact: true })
      await captureFrame(page, testInfo, {
        imageName: `saved-lifecycle-import-selection-${width}-${mode}`, mode,
        anchor: selection, scroller: importDialog, stickyFooter: importDialog.locator('.dialog-footer'),
        targets: [
          { name: 'conflict-row-checkbox', locator: conflictRow.getByRole('checkbox'), kind: 'checked', expected: 'true' },
          { name: 'conflict-row-kind', locator: conflictRow.locator('.saved-import-kind'), expected: '현재 기록과 다름' },
          { name: 'conflict-row-variant', locator: variants, kind: 'value', expected: '1', expectedSelectedOption: '2. 지원 완료 · FILE NOTE B' },
          { name: 'selection-totals', locator: selection, expected: '선택 25개 · 새 공고 24개 추가 · 기존 1개 변경 · 저장 후 26/500개' },
          { name: 'footer-totals', locator: importDialog.locator('.dialog-footer > span'), expected: '선택 25개 · 새 공고 24개 · 변경 1개', footerOwned: true },
          { name: 'import-action', locator: importAction, expected: '선택한 25개 가져오기', footerOwned: true },
        ],
        state: { page: '1 / 2', mutationsBeforeFraming: 0, staleWarnings: 0 },
      }, async () => {
        await expect(conflictRow.getByRole('checkbox')).toBeChecked()
        await expect(variants).toHaveValue('1')
        await expect(selection).toHaveText('선택 25개 · 새 공고 24개 추가 · 기존 1개 변경 · 저장 후 26/500개')
        await expect(pageIndicator).toHaveText('1 / 2')
        await expect(staleWarning(page)).toHaveCount(0)
        await expect(importAction).toBeEnabled()
        expect((await storageProbe(page)).mutations).toBe(0)
      })
      await page.getByRole('button', { name: '선택한 25개 가져오기', exact: true }).click()
      await expect(page.locator('.saved-file-message')).toContainText('선택한 25개 기록을 저장했어요. 새 공고 24개 · 기존 공고 변경 1개.')
      const committed = await readCommitted(page)
      expect(committed).toHaveLength(26)
      expect(committed.find(item => item.job.id === jobId('conflict'))).toMatchObject({ note: 'FILE NOTE B', status: 'applied', savedAt: SAVED_AT })
      expect(committed.find(item => item.job.id === jobId('keep'))).toMatchObject({ note: 'Unchanged', status: 'saved' })
    })

    test(`a failed draft survives return bursts without a write retry and merges with the other tab's status only on explicit retry at ${width}px (synthetic bursts)`, async ({ page }, testInfo) => {
      await seed(page, [record('first', 'Original saved note')])
      await openSaved(page, [title('first')])
      await page.getByRole('button', { name: title('first'), exact: true }).click()
      const failing = await installFailingPut(page)
      await noteField(page).fill('Draft kept across lifecycle')
      const alert = page.getByRole('alert')
      await expect(alert).toContainText('아직 저장하지 못한 변경이 있어요.')
      await expect(alert).toContainText('브라우저 저장 공간이 부족해요. CSV로 기록을 보관하고 불필요한 기록을 정리한 뒤 다시 시도해 주세요.')
      await expect(alert).toContainText('마지막 입력은 이 탭에 남아 있어요. 저장 완료 전에는 탭을 닫지 마세요.')
      const attempts = await failing.attempts()
      expect(attempts).toBeGreaterThanOrEqual(1)
      // CM2: the A1 timeline is attached from the enclosing finally below, independently of captureFrame, so a failure at
      // readiness, T0, T1, T2 or any earlier assertion still preserves exactly what was measured. Nothing absent is invented.
      const mode = await serverMode(page)
      const timeline = createDraftTimeline(`saved-lifecycle-protected-draft-${width}-${mode}`, mode, width)
      try {
        // A1 T0: the failed-write presentation is settled (fonts loaded, two frames rendered) before the baseline for the draft
        // field's focus, its viewport rectangle, the dialog's scroll position and the field's content offset is taken. Nothing is
        // scrolled here.
        timeline.phase = 'readiness'
        timeline.readiness = await awaitLayoutReady(page)
        expect(timeline.readiness).toEqual({ fontsStatus: 'loaded', frames: 'two-animation-frames' })
        timeline.phase = 'T0'
        const t0 = await snapshotDraftField(page, 'T0')
        timeline.points.push(t0)
        timeline.a1.t0Active = t0.activeIsField
        expect(t0.activeIsField, `T0: the draft field must be the active element after the failed write (active: ${t0.activeElement})`).toBe(true)
        const other = await otherTab(page)
        try {
          await other.goto('/#saved')
          await other.getByRole('button', { name: title('first'), exact: true }).click()
          await other.getByRole('button', { name: '지원 완료로 표시', exact: true }).click()
          await waitForSavedCommit(other)
          await expect(other.getByRole('button', { name: '지원 완료로 표시됨', exact: true })).toBeVisible()
          await other.getByRole('button', { name: '닫기', exact: true }).click()
          expect((await readCommitted(other))[0]).toMatchObject({ note: 'Original saved note', status: 'applied' })
          // A1 T1: after the other tab's commit, before any return signal reaches this page.
          timeline.phase = 'T1'
          const t1 = await snapshotDraftField(page, 'T1')
          timeline.points.push(t1)
          await dispatchReturn(page, 'burst')
          await dispatchReturn(page, 'burst')
          await settle(page, 200)
          await expect(noteField(page)).toHaveValue('Draft kept across lifecycle')
          await expect(alert).toContainText('아직 저장하지 못한 변경이 있어요.')
          // The other tab's status is held until the explicit retry; nothing moves under the user's failed input.
          await expect(page.getByRole('button', { name: '지원 완료로 표시', exact: true })).toBeVisible()
          expect(await failing.attempts()).toBe(attempts)
          expect(await unloadIsProtected(page)).toBe(true)
          expect((await readCommitted(page))[0]).toMatchObject({ note: 'Original saved note', status: 'applied' })
          // A1 T2: no test action has scrolled or focused this page since T0, so the return bursts must have left the draft field's
          // focus, its viewport rectangle, the dialog's scroll position and the field's content offset unchanged. A difference is
          // preserved as a failure together with the timeline attached below.
          timeline.phase = 'T2'
          const t2 = await snapshotDraftField(page, 'T2')
          timeline.points.push(t2)
          timeline.a1.t2Failures = draftFieldStabilityFailures(t0, t2)
          expect(timeline.a1.t2Failures, 'A1: focus, viewport rectangle, dialog scrollTop and field offset at T2 must equal T0').toEqual([])
          // VC1: frame the protected draft, its storage error and the explicit recovery actions inside the dialog's own scroller.
          timeline.phase = 'frame'
          const jobDialog = page.locator('dialog.job-dialog')
          await captureFrame(page, testInfo, {
            imageName: timeline.imageName, mode,
            anchor: jobDialog.locator('.saved-note-section'), scroller: jobDialog, stickyFooter: jobDialog.locator('.dialog-footer'),
            targets: [
              { name: 'draft-field', locator: noteField(page), kind: 'value', expected: 'Draft kept across lifecycle' },
              { name: 'storage-error', locator: alert, expected: ['아직 저장하지 못한 변경이 있어요.', '브라우저 저장 공간이 부족해요. CSV로 기록을 보관하고 불필요한 기록을 정리한 뒤 다시 시도해 주세요.', '마지막 입력은 이 탭에 남아 있어요. 저장 완료 전에는 탭을 닫지 마세요.'] },
              { name: 'retry-action', locator: page.getByRole('button', { name: '저장 다시 시도', exact: true }), expected: '저장 다시 시도' },
              { name: 'csv-recovery-action', locator: page.getByRole('button', { name: '현재 내용 CSV로 보관', exact: true }), expected: '현재 내용 CSV로 보관' },
              { name: 'status-control', locator: page.getByRole('button', { name: '지원 완료로 표시', exact: true }), expected: '지원 완료로 표시' },
            ],
            state: { draft: 'Draft kept across lifecycle', writeAttemptsBeforeFraming: attempts, committedNote: 'Original saved note', committedStatus: 'applied', unloadProtected: true },
            extra: { timeline: timeline.points },
          }, async () => {
            await expect(noteField(page)).toHaveValue('Draft kept across lifecycle')
            await expect(alert).toContainText('아직 저장하지 못한 변경이 있어요.')
            await expect(alert).toContainText('브라우저 저장 공간이 부족해요. CSV로 기록을 보관하고 불필요한 기록을 정리한 뒤 다시 시도해 주세요.')
            await expect(alert).toContainText('마지막 입력은 이 탭에 남아 있어요. 저장 완료 전에는 탭을 닫지 마세요.')
            await expect(page.getByRole('button', { name: '지원 완료로 표시', exact: true })).toBeVisible()
            expect(await failing.attempts()).toBe(attempts)
            expect(await unloadIsProtected(page)).toBe(true)
            expect((await readCommitted(page))[0]).toMatchObject({ note: 'Original saved note', status: 'applied' })
          })
          timeline.complete = true
          timeline.phase = 'post-frame'
          const csv = await downloadText(page, page.getByRole('button', { name: '현재 내용 CSV로 보관', exact: true }))
          expect(csv).toContain('Draft kept across lifecycle')
          await failing.restore()
          await page.getByRole('button', { name: '저장 다시 시도', exact: true }).click()
          await waitForSavedCommit(page)
          await expect(page.getByRole('button', { name: '지원 완료로 표시됨', exact: true })).toBeVisible()
          await expect(noteField(page)).toHaveValue('Draft kept across lifecycle')
          await expect(page.locator('.job-dialog .saved-storage-notice.has-error')).toHaveCount(0)
          expect((await readCommitted(page))[0]).toMatchObject({ note: 'Draft kept across lifecycle', status: 'applied', savedAt: SAVED_AT })
          expect(await unloadIsProtected(page)).toBe(false)
          await expect(preview(other, 'first')).toHaveText('Draft kept across lifecycle')
        } finally { await other.close() }
      } catch (error) {
        timeline.failure = error instanceof Error ? error.message : String(error)
        throw error
      } finally {
        await attachDraftTimeline(testInfo, timeline)
      }
    })

    test(`a saved-origin detail follows a same-ID replacement, returns focus to the renamed title, keeps the last displayed posting after removal and saves that posting at ${width}px`, async ({ page }, testInfo) => {
      const traffic = watchApiRequests(page)
      await openSavedPages(page)
      await page.getByRole('textbox', { name: '저장한 기회 검색', exact: true }).fill('Fable 13')
      await expect(page.locator('.saved-title')).toHaveText(['Fable 13 · Backend Engineer'])
      await page.getByRole('button', { name: 'Fable 13 · Backend Engineer', exact: true }).click()
      const dialog = page.getByRole('dialog', { name: 'Fable Labs', exact: true })
      await expect(dialog.getByRole('heading', { name: 'Fable 13 · Backend Engineer', exact: true })).toBeVisible()
      await expect(dialog.getByRole('link', { name: '원문에서 지원하기', exact: true })).toHaveAttribute('href', 'https://example.org/saved-pages/greenhouse-fable-labs-13')
      const other = await otherTab(page, SAVED_PAGES_TIME)
      const otherTraffic = watchApiRequests(other)
      try {
        await other.goto('/#saved')
        await waitForSavedCommit(other)
        const original = (await readCommitted(other)).find(item => item.job.id === 'greenhouse-fable-labs-13')!
        const description = 'Fictional updated source for Fable 13. Build weather tools with Python and review the new source carefully.'
        await importReplacement(other, {
          ...original,
          job: { ...original.job, title: 'Fable 13 · Backend Engineer Updated Snapshot', description, url: 'https://example.org/saved-pages/updated-snapshot-13' },
        })
        await expect(dialog.getByRole('heading', { name: 'Fable 13 · Backend Engineer Updated Snapshot', exact: true })).toBeVisible()
        await expect(dialog.getByRole('link', { name: '원문에서 지원하기', exact: true })).toHaveAttribute('href', 'https://example.org/saved-pages/updated-snapshot-13')
        await expect(noteField(page)).toHaveValue('PRIVATE-SAVED53 CohortNorth note 13')
        await expect(dialog.getByRole('button', { name: '저장됨', exact: true })).toBeVisible()
        // VC1: paired header view of the unchanged replacement state (company, full updated title, close control) at scroll top,
        // then the retained lower view (actual updated source excerpt, current note and status control). Both record the same state.
        const mode = await serverMode(page)
        const replacement = { company: 'Fable Labs', title: 'Fable 13 · Backend Engineer Updated Snapshot', href: 'https://example.org/saved-pages/updated-snapshot-13', note: 'PRIVATE-SAVED53 CohortNorth note 13', savedButton: '저장됨' }
        const reassertReplacement = async () => {
          await expect(dialog.getByRole('heading', { name: replacement.title, exact: true })).toBeVisible()
          await expect(dialog.getByRole('link', { name: '원문에서 지원하기', exact: true })).toHaveAttribute('href', replacement.href)
          await expect(noteField(page)).toHaveValue(replacement.note)
          await expect(dialog.getByRole('button', { name: '저장됨', exact: true })).toBeVisible()
          expect((await readCommitted(page)).find(item => item.job.id === 'greenhouse-fable-labs-13')).toMatchObject({ job: { title: replacement.title, url: replacement.href, description }, note: replacement.note })
        }
        await captureFrame(page, testInfo, {
          imageName: `saved-lifecycle-refreshed-detail-header-${width}-${mode}`, mode,
          anchor: dialog.locator('.dialog-header'), scroller: dialog, stickyFooter: dialog.locator('.dialog-footer'),
          targets: [
            { name: 'company-title', locator: dialog.locator('#dialog-title'), expected: replacement.company },
            { name: 'updated-job-title', locator: dialog.locator('.job-detail-heading h3'), expected: replacement.title },
            { name: 'close-control', locator: dialog.getByRole('button', { name: '닫기', exact: true }), kind: 'label', expected: '닫기' },
          ],
          state: { ...replacement, pairedImage: `saved-lifecycle-refreshed-detail-${width}-${mode}` },
        }, reassertReplacement)
        await dialog.locator('.original-description > summary').click()
        await expect(dialog.locator('.original-description .job-description')).toHaveText(description)
        await captureFrame(page, testInfo, {
          imageName: `saved-lifecycle-refreshed-detail-${width}-${mode}`, mode,
          anchor: dialog.locator('.original-description'), scroller: dialog, stickyFooter: dialog.locator('.dialog-footer'),
          targets: [
            { name: 'updated-source-excerpt', locator: dialog.locator('.original-description .job-description > p'), expected: description },
            { name: 'note-field', locator: noteField(page), kind: 'value', expected: replacement.note },
            { name: 'status-control', locator: dialog.getByRole('button', { name: '지원 완료로 표시', exact: true }), expected: '지원 완료로 표시' },
            { name: 'saved-action', locator: dialog.getByRole('button', { name: '저장됨', exact: true }), expected: '저장됨', footerOwned: true },
            { name: 'apply-link', locator: dialog.getByRole('link', { name: '원문에서 지원하기', exact: true }), expected: '원문에서 지원하기', footerOwned: true },
          ],
          state: { ...replacement, pairedImage: `saved-lifecycle-refreshed-detail-header-${width}-${mode}` },
        }, async () => {
          await expect(dialog.locator('.original-description .job-description')).toHaveText(description)
          await reassertReplacement()
        })
        await page.keyboard.press('Escape')
        await expect(dialog).toHaveCount(0)
        const renamed = page.getByRole('button', { name: 'Fable 13 · Backend Engineer Updated Snapshot', exact: true })
        await expect(renamed).toBeFocused()
        await renamed.click()
        await expect(dialog.getByRole('heading', { name: 'Fable 13 · Backend Engineer Updated Snapshot', exact: true })).toBeVisible()

        // The other tab removes the record while this detail is open.
        await other.getByRole('textbox', { name: '저장한 기회 검색', exact: true }).fill('Fable 13')
        await savedCard(other, 'Fable 13 · Backend Engineer Updated Snapshot').getByRole('button', { name: 'Fable Labs 저장 취소', exact: true }).click()
        await waitForSavedCommit(other)
        expect((await readCommitted(other)).some(item => item.job.id === 'greenhouse-fable-labs-13')).toBe(false)
        await expect(dialog.getByRole('button', { name: '기회 저장', exact: true })).toBeEnabled()
        await expect(noteField(page)).toHaveCount(0)
        await expect(dialog.getByRole('heading', { name: 'Fable 13 · Backend Engineer Updated Snapshot', exact: true })).toBeVisible()
        await expect(dialog.getByRole('link', { name: '원문에서 지원하기', exact: true })).toHaveAttribute('href', 'https://example.org/saved-pages/updated-snapshot-13')

        // An explicit new save stores exactly the posting the user was looking at, S2, not the original S1.
        await dialog.getByRole('button', { name: '기회 저장', exact: true }).click()
        await expect(page.locator('.toast')).toContainText('Fable Labs의 기회를 목록에 추가했어요.')
        await waitForSavedCommit(page)
        const saved = (await readCommitted(page)).find(item => item.job.id === 'greenhouse-fable-labs-13')
        expect(saved).toMatchObject({
          job: { id: 'greenhouse-fable-labs-13', title: 'Fable 13 · Backend Engineer Updated Snapshot', url: 'https://example.org/saved-pages/updated-snapshot-13', description },
          company: { id: 'fable-labs', name: 'Fable Labs' }, status: 'saved', note: '', savedAt: '2026-09-26T08:00:10.000Z',
        })
        await expect(dialog.getByRole('button', { name: '저장됨', exact: true })).toBeVisible()
        await expect(noteField(page)).toHaveValue('')
        expect(traffic.requests).toEqual([])
        expect(otherTraffic.requests).toEqual([])
      } finally { await other.close() }
    })
  })
}

interface NativeReturnEvent { tripId: string | null; url: string; token: string; persisted: boolean; isTrusted: boolean }
const nonEmpty = (value: unknown): value is string => typeof value === 'string' && value.length > 0

test('native history return is observed and classified from correlated trusted evidence, and the returned saved record is current on whichever path occurred', async ({ page: runnerPage, baseURL }, testInfo) => {
  const origin = new URL(baseURL!).origin
  const returnUrl = `${origin}/#saved`
  const channel = process.env.PLAYWRIGHT_CHANNEL ?? 'chromium'
  const mode = await readServerMode(runnerPage.request, `${origin}/api/health`)
  // Only the test runner's default BFCache-disabling argument is omitted. No sandbox or web-security argument changes.
  const browser = await chromium.launch({ channel, ignoreDefaultArgs: ['--disable-back-forward-cache'] })
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, reducedMotion: 'reduce' })
    const page = await context.newPage()
    const errors = collectPageErrors(page)
    await page.clock.setFixedTime(new Date(PUBLIC_PROTOCOL_TIME))
    await page.addInitScript(raw => {
      // Every document receives its own token before any pageshow can fire, so a reloaded document can never present the original token.
      const token = typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`
      Reflect.set(window, '__lifecycleDocumentToken', token)
      try {
        // Seed the legacy fixture once per tab; a reload must not supply a second migration input.
        if (!sessionStorage.getItem('__lifecycleNativeSeeded')) {
          localStorage.setItem('orbit.v1.saved', raw)
          localStorage.setItem('orbit.v1.exploration', JSON.stringify({ source: 'public', mapMode: 'flat' }))
          sessionStorage.setItem('__lifecycleNativeSeeded', '1')
        }
      } catch { /* a document without origin storage skips seeding */ }
      window.addEventListener('pageshow', event => {
        try {
          const entry = {
            tripId: sessionStorage.getItem('__lifecycleTrip'), url: location.href, token,
            persisted: (event as PageTransitionEvent).persisted, isTrusted: event.isTrusted,
          }
          const log = JSON.parse(sessionStorage.getItem('__lifecyclePageshowLog') ?? '[]') as unknown[]
          log.push(entry)
          sessionStorage.setItem('__lifecyclePageshowLog', JSON.stringify(log))
          // Only a pageshow at the expected return URL during the open trip may occupy the accepted slot. Any other
          // document, including a navigated about:blank whether or not it can reach this storage, stays in the log only.
          const expectedUrl = sessionStorage.getItem('__lifecycleReturnUrl')
          if (entry.tripId && expectedUrl && entry.url === expectedUrl) sessionStorage.setItem('__lifecycleReturnEvent', JSON.stringify(entry))
        } catch { /* a document without origin storage cannot record anything here */ }
      })
    }, JSON.stringify([record('first', 'Original saved note')]))
    // Observation only: enable page events and record the browser's own not-restored reasons, if it reports any.
    const session = await context.newCDPSession(page)
    await session.send('Page.enable')
    const notRestored: unknown[] = []
    ;(session as unknown as { on(event: string, listener: (payload: unknown) => void): void })
      .on('Page.backForwardCacheNotUsed', event => notRestored.push(event))

    await page.goto(returnUrl)
    await expect(page.locator('.saved-title')).toHaveText([title('first')])
    await expect(preview(page, 'first')).toHaveText('Original saved note')
    // Await this document's own trusted initial pageshow before departing, then open a fresh trip with an empty return slot.
    const readLog = () => page.evaluate(() => JSON.parse(sessionStorage.getItem('__lifecyclePageshowLog') ?? '[]') as NativeReturnEvent[])
    await expect.poll(async () => (await readLog()).length).toBe(1)
    const originalToken = await page.evaluate(() => Reflect.get(window, '__lifecycleDocumentToken') as string | undefined)
    expect(nonEmpty(originalToken)).toBe(true)
    expect((await readLog())[0]).toEqual({ tripId: null, url: returnUrl, token: originalToken, persisted: false, isTrusted: true })
    const tripId = `trip-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
    await page.evaluate(({ tripId, returnUrl }) => {
      sessionStorage.setItem('__lifecycleTrip', tripId)
      sessionStorage.setItem('__lifecycleReturnUrl', returnUrl)
      sessionStorage.removeItem('__lifecycleReturnEvent')
    }, { tripId, returnUrl })
    await page.goto('about:blank')

    const other = await context.newPage()
    await other.clock.setFixedTime(new Date(PUBLIC_PROTOCOL_TIME))
    await other.goto(returnUrl)
    await other.getByRole('button', { name: title('first'), exact: true }).click()
    await noteField(other).fill('Changed while away')
    await other.getByRole('button', { name: '지원 완료로 표시', exact: true }).click()
    await waitForSavedCommit(other)
    await expect(other.getByRole('button', { name: '지원 완료로 표시됨', exact: true })).toBeVisible()
    expect((await readCommitted(other))[0]).toMatchObject({ note: 'Changed while away', status: 'applied', savedAt: SAVED_AT })
    await other.close()

    await page.goBack({ waitUntil: 'commit' })
    // Only a return event for this trip and this URL counts; the initial pageshow, about:blank and earlier trips cannot satisfy it.
    await expect.poll(async () => {
      const raw = await page.evaluate(() => sessionStorage.getItem('__lifecycleReturnEvent')).catch(() => null)
      if (!raw) return null
      const event = JSON.parse(raw) as NativeReturnEvent
      return event.tripId === tripId && event.url === returnUrl ? event : null
    }).not.toBeNull()
    const observed = await page.evaluate(() => ({
      token: Reflect.get(window, '__lifecycleDocumentToken') as string | undefined,
      returnEvent: JSON.parse(sessionStorage.getItem('__lifecycleReturnEvent') ?? 'null') as NativeReturnEvent | null,
      pageshowLog: JSON.parse(sessionStorage.getItem('__lifecyclePageshowLog') ?? '[]') as NativeReturnEvent[],
    }))
    // NV1: the fixed test clock stubs performance.getEntriesByType to return [], so the navigation diagnostic comes from a buffered
    // PerformanceObserver owned by the test and disconnected afterwards. It is diagnostic only and never takes part in classification.
    const navigation = await collectNavigationEntries(page)
    const event = observed.returnEvent
    // Explicit nonempty-string checks: two missing tokens must never compare equal into a classification.
    const correlated = event !== null && nonEmpty(tripId) && nonEmpty(originalToken) && nonEmpty(observed.token) && nonEmpty(event.token)
      && event.tripId === tripId && event.url === returnUrl && event.isTrusted === true && event.token === observed.token
    const classification = !correlated ? 'incomplete'
      : event.persisted === true && observed.token === originalToken ? 'bfcache-restoration'
        : event.persisted === false && observed.token !== originalToken ? 'reload'
          : 'incomplete'

    // On either path the returned screen must show the record committed while this document was away.
    await expect(preview(page, 'first')).toHaveText('Changed while away')
    await expect(statusBadge(page, 'first')).toHaveText('지원 완료')
    const committed = (await readCommitted(page))[0]
    expect(committed).toMatchObject({ note: 'Changed while away', status: 'applied', savedAt: SAVED_AT })
    // Recorded after the literal assertions above, as observed values rather than manufactured ones.
    const currentRecord = {
      visibleNote: await preview(page, 'first').textContent(),
      visibleStatus: await statusBadge(page, 'first').textContent(),
      note: committed.note, status: committed.status, savedAt: committed.savedAt,
    }
    const body = {
      schemaVersion: 1, mode, classification, channel, awayDocument: 'about:blank', returnUrl, tripId, originalToken,
      observed: {
        token: observed.token, returnEvent: observed.returnEvent, navigation: navigation.entries,
        navigationCollection: { method: navigation.method, status: navigation.status, error: navigation.error, timeoutMs: navigation.timeoutMs, entryCount: navigation.entryCount },
      },
      currentRecord, pageErrors: errors(), cdpBackForwardCacheNotUsed: notRestored,
      diagnostics: { pageshowLog: observed.pageshowLog },
    }
    // Incomplete or inconsistent evidence is attached under a separate name and fails the test; it is never classified as a reload.
    await testInfo.attach(classification === 'incomplete' ? 'saved-lifecycle-native-history-incomplete' : 'saved-lifecycle-native-history-classification', {
      body: JSON.stringify(body, null, 2), contentType: 'application/json',
    })
    // VC1: frame the returned card's title, current note and status after the literal assertions above. The trip, tokens,
    // trusted event and classification recorded above are unchanged by this ordinary document scroll.
    await captureFrame(page, testInfo, {
      imageName: 'saved-lifecycle-native-history-return', mode,
      anchor: savedCard(page, title('first')), scroller: 'document',
      targets: [
        { name: 'returned-card-title', locator: savedCard(page, title('first')).locator('.saved-title'), expected: title('first') },
        { name: 'current-note', locator: preview(page, 'first'), expected: 'Changed while away' },
        { name: 'current-status', locator: statusBadge(page, 'first'), expected: '지원 완료' },
      ],
      state: { classification, tripId, returnUrl, originalToken: originalToken ?? null, observedToken: observed.token ?? null },
    }, async () => {
      await expect(preview(page, 'first')).toHaveText('Changed while away')
      await expect(statusBadge(page, 'first')).toHaveText('지원 완료')
      expect((await readCommitted(page))[0]).toMatchObject({ note: 'Changed while away', status: 'applied', savedAt: SAVED_AT })
    })
    expect(classification, 'native return evidence must be one trusted pageshow correlated to this trip, this URL and the current document').not.toBe('incomplete')
    expect(errors()).toEqual([])
  } finally { await browser.close() }
})
