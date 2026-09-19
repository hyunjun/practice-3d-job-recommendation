import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { readFile } from 'node:fs/promises'
import { createSampleCatalog } from '../../shared/sample'
import { createSavedBackup } from '../../shared/saved-backup'
import { SAMPLE_PROFILE } from '../../shared/types'
import type { SavedJob } from '../../shared/types'
import { readSaved, waitForSavedCommit } from './helpers/saved-store'

const sample = createSampleCatalog()
function record(id: string, note = '', status: SavedJob['status'] = 'saved'): SavedJob {
  const job = { ...sample.jobs[0], id, title: `Backup fixture ${id}` }
  return { job, company: sample.companies.find(company => company.id === job.companyId)!, savedAt: '2026-09-19T08:00:00.000Z', status, note }
}
async function seed(page: Page, records: unknown[]) {
  await page.addInitScript(records => {
    localStorage.setItem('orbit.v1.saved', JSON.stringify(records))
    localStorage.setItem('orbit.v1.exploration', JSON.stringify({ source: 'sample', mapMode: 'flat' }))
  }, records)
  await page.goto('/#saved')
  await waitForSavedCommit(page)
}
async function openFiles(page: Page) {
  await page.getByRole('button', { name: '기록 백업·복원', exact: true }).click()
  await expect(page.getByRole('dialog', { name: '기록 백업과 복원', exact: true })).toBeVisible()
}
async function chooseFile(page: Page, text: string, name = 'backup.json') {
  await page.getByLabel('백업 또는 복구 파일', { exact: true }).setInputFiles({ name, mimeType: 'application/json', buffer: Buffer.from(text) })
}
const importRow = (page: Page, id: string) => page.locator('.saved-import-row').filter({ hasText: `Backup fixture ${id}` })

test('round-trips full records into a fresh browser context without transferring profile data or sending file contents to the API', async ({ page, browser }) => {
  const records = [record('first', 'PRIVATE-BACKUP-NOTE\n=1+2 🌏', 'applied'), record('second', 'Another original note')]
  await page.addInitScript(profile => localStorage.setItem('orbit.v1.profile', JSON.stringify(profile)), { ...SAMPLE_PROFILE, kind: 'personal', name: 'PROFILE-NOT-IN-BACKUP' })
  await seed(page, records)
  await openFiles(page)
  const downloading = page.waitForEvent('download')
  await page.getByRole('button', { name: 'JSON 백업', exact: true }).click()
  const text = await readFile((await (await downloading).path())!, 'utf8')
  expect(JSON.parse(text).records).toEqual(records)
  expect(text).not.toContain('PROFILE-NOT-IN-BACKUP')
  const destination = await browser.newContext()
  try {
    const target = await destination.newPage()
    const requests: { url: string; body: string | null }[] = []
    target.on('request', request => { if (request.url().includes('/api/')) requests.push({ url: request.url(), body: request.postData() }) })
    await target.goto(`${new URL(page.url()).origin}/#saved`)
    await openFiles(target)
    await chooseFile(target, text)
    await expect(target.locator('.saved-import-row')).toHaveCount(2)
    expect(await readSaved(target)).toEqual([])
    await target.getByRole('button', { name: '선택한 2개 가져오기', exact: true }).click()
    await expect(target.locator('.saved-file-message')).toContainText('선택한 2개 기록을 저장했어요.')
    expect(await readSaved(target)).toEqual(records)
    await target.reload()
    expect(await readSaved(target)).toEqual(records)
    expect(await target.evaluate(() => localStorage.getItem('orbit.v1.profile'))).toBeNull()
    expect(requests.every(request => request.body === null && !request.url.includes('PRIVATE-BACKUP-NOTE'))).toBe(true)
  } finally { await destination.close() }
})

test('keeps current notes by default and replaces a conflicting record only after explicit selection and comparison', async ({ page }) => {
  const current = record('conflict', 'CURRENT NOTE', 'applied')
  const identical = record('identical', 'Unchanged')
  const incoming = record('conflict', 'FILE NOTE', 'saved')
  const text = createSavedBackup([incoming, record('new', 'New from file'), identical])
  await seed(page, [current, identical])
  await openFiles(page)
  await chooseFile(page, text)
  await expect(importRow(page, 'conflict').getByRole('checkbox')).not.toBeChecked()
  await expect(importRow(page, 'identical').getByRole('checkbox')).toBeDisabled()
  await expect(importRow(page, 'new').getByRole('checkbox')).toBeChecked()
  await page.getByRole('button', { name: '선택한 1개 가져오기', exact: true }).click()
  await expect(page.locator('.saved-file-message')).toContainText('새 공고 1개 · 기존 공고 변경 0개')
  expect((await readSaved(page)).find(item => item.job.id === current.job.id)).toEqual(current)
  await chooseFile(page, text)
  const row = importRow(page, 'conflict')
  await row.locator('.saved-import-differences > summary').click()
  await expect(row.locator('.saved-record-comparison')).toContainText('CURRENT NOTE')
  await expect(row.locator('.saved-record-comparison')).toContainText('FILE NOTE')
  await row.getByRole('checkbox').check()
  await page.getByRole('button', { name: '선택한 1개 가져오기', exact: true }).click()
  await expect(page.locator('.saved-file-message')).toContainText('기존 공고 변경 1개')
  expect((await readSaved(page)).find(item => item.job.id === current.job.id)).toEqual(incoming)
  expect((await readSaved(page)).find(item => item.job.id === identical.job.id)).toEqual(identical)
})

test('requires a new comparison when another tab changes the previewed note', async ({ page, context }) => {
  await seed(page, [record('conflict', 'Previewed note')])
  await openFiles(page)
  await chooseFile(page, createSavedBackup([record('conflict', 'File replacement')]))
  await importRow(page, 'conflict').getByRole('checkbox').check()
  const other = await context.newPage()
  try {
    await other.goto('/#saved')
    await other.locator('.saved-title').click()
    await other.getByLabel('이 기회에 대한 나의 메모').fill('NEWER OTHER-TAB NOTE')
    await waitForSavedCommit(other)
    await expect(page.getByText('검토 중 현재 목록이 갱신됐어요. 다시 비교한 뒤 반영해 주세요.', { exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: '선택한 1개 가져오기', exact: true })).toBeDisabled()
    await page.getByRole('button', { name: '현재 기록으로 다시 비교', exact: true }).click()
    await expect(importRow(page, 'conflict').getByRole('checkbox')).not.toBeChecked()
    await importRow(page, 'conflict').locator('.saved-import-differences > summary').click()
    await expect(importRow(page, 'conflict').locator('.saved-record-comparison')).toContainText('NEWER OTHER-TAB NOTE')
    expect((await readSaved(page))[0].note).toBe('NEWER OTHER-TAB NOTE')
  } finally { await other.close() }
})

test('rolls back all selected records on a real transaction abort and keeps the file selection available for retry', async ({ page }) => {
  const current = record('current', 'Keep this note')
  await seed(page, [current])
  await openFiles(page)
  await chooseFile(page, createSavedBackup([record('current', 'File replacement'), record('new')]))
  await importRow(page, 'current').getByRole('checkbox').check()
  await page.evaluate(() => {
    const put = IDBObjectStore.prototype.put
    let writes = 0
    IDBObjectStore.prototype.put = function (...args) {
      const result = Reflect.apply(put, this, args) as IDBRequest
      if (this.name === 'records' && ++writes === 2) result.addEventListener('success', () => this.transaction.abort(), { once: true })
      return result
    }
    Reflect.set(window, '__restoreImportPut', () => { IDBObjectStore.prototype.put = put })
  })
  await page.getByRole('button', { name: '선택한 2개 가져오기', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('기존 기록은 그대로예요.')
  expect(await readSaved(page)).toEqual([current])
  await expect(page.locator('.saved-import-row')).toHaveCount(2)
  await page.evaluate(() => Reflect.get(window, '__restoreImportPut')())
  await page.getByRole('button', { name: '선택한 2개 가져오기', exact: true }).click()
  await expect(page.locator('.saved-file-message')).toContainText('선택한 2개 기록을 저장했어요.')
  expect((await readSaved(page)).find(item => item.job.id === current.job.id)?.note).toBe('File replacement')
  expect(await readSaved(page)).toHaveLength(2)
})

test('imports an older recovery file, offers distinct duplicate notes and treats hostile strings and special IDs as plain data', async ({ page }) => {
  const inert = '<img src="https://example.com/backup-should-not-load" onerror="window.backupInjected=true">'
  const requests: string[] = []
  page.on('request', request => { if (request.url().includes('backup-should-not-load')) requests.push(request.url()) })
  await seed(page, [])
  await openFiles(page)
  const recovery = JSON.stringify({
    format: 'orbit-saved-recovery', version: 1, sources: [{
      kind: 'legacy', original: JSON.stringify([
        record('duplicate', 'First original'), { invalid: true },
        record('duplicate', 'Chosen recovered alternative', 'applied'), record('constructor', inert),
      ]),
    }],
  })
  await chooseFile(page, recovery)
  await expect(page.locator('.saved-import-summary')).toContainText('읽을 수 없는 항목 1개')
  await expect(page.locator('.saved-import-summary')).toContainText('같은 공고가 1번 더 있어요')
  await importRow(page, 'duplicate').getByRole('combobox').selectOption('1')
  await importRow(page, 'constructor').locator('.saved-import-differences > summary').click()
  await expect(importRow(page, 'constructor').locator('.saved-record-note')).toHaveText(inert)
  await expect(importRow(page, 'constructor').locator('img')).toHaveCount(0)
  await page.getByRole('button', { name: '선택한 2개 가져오기', exact: true }).click()
  await expect(page.locator('.saved-file-message')).toContainText('선택한 2개 기록을 저장했어요.')
  expect((await readSaved(page)).find(item => item.job.id === 'duplicate')).toMatchObject({ note: 'Chosen recovered alternative', status: 'applied' })
  expect((await readSaved(page)).find(item => item.job.id === 'constructor')?.note).toBe(inert)
  expect(await page.evaluate(() => Reflect.get(window, 'backupInjected'))).toBeUndefined()
  expect(requests).toEqual([])
})

test('downloads and deletes only a confirmed recovery archive, preserving the current collection and migration marker', async ({ page }) => {
  const current = record('kept', 'Keep the current copy')
  const raw = [current, { invalid: true }]
  await seed(page, raw)
  await openFiles(page)
  const downloading = page.waitForEvent('download')
  await page.getByRole('button', { name: '이 원본 내려받기', exact: true }).click()
  const recovery = JSON.parse(await readFile((await (await downloading).path())!, 'utf8'))
  expect(recovery.sources[0].original).toBe(JSON.stringify(raw))
  await page.getByRole('button', { name: '보관본 삭제', exact: true }).click()
  await page.getByRole('button', { name: '삭제 취소', exact: true }).click()
  await expect(page.locator('.saved-recovery-source')).toHaveCount(1)
  await page.getByRole('button', { name: '보관본 삭제', exact: true }).click()
  await page.getByRole('button', { name: '선택한 보관본 삭제', exact: true }).click()
  await expect(page.locator('.saved-file-message')).toContainText('선택한 보관본을 삭제했어요.')
  await expect(page.locator('.saved-recovery-source')).toHaveCount(0)
  expect(await readSaved(page)).toEqual([current])
  await page.reload()
  await openFiles(page)
  await expect(page.locator('.saved-recovery-source')).toHaveCount(0)
  expect(await readSaved(page)).toEqual([current])
})

test('recovers a valid record from an unreadable wrapper only after its reviewed original is cleared', async ({ page }) => {
  const current = record('healthy', 'Healthy current note')
  const rescued = record('rescued', 'Recover this note', 'applied')
  await seed(page, [current])
  await page.evaluate(record => new Promise<void>((resolve, reject) => {
    const opening = indexedDB.open('orbit-saved-opportunities')
    opening.onerror = () => reject(opening.error)
    opening.onsuccess = () => {
      const db = opening.result
      const tx = db.transaction('records', 'readwrite')
      tx.objectStore('records').put({ id: record.job.id, order: 'Unreadable order', record })
      tx.oncomplete = () => { db.close(); resolve() }
      tx.onabort = () => { db.close(); reject(tx.error) }
    }
  }), rescued)
  await page.reload()
  await openFiles(page)
  const downloading = page.waitForEvent('download')
  await page.getByRole('button', { name: '이 원본 내려받기', exact: true }).click()
  const source = await readFile((await (await downloading).path())!, 'utf8')
  await chooseFile(page, source)
  await expect(importRow(page, 'rescued').getByRole('checkbox')).toBeDisabled()
  await expect(page.getByRole('button', { name: '선택한 0개 가져오기', exact: true })).toBeDisabled()
  await page.getByRole('button', { name: '보관본 삭제', exact: true }).click()
  await page.getByRole('button', { name: '선택한 보관본 삭제', exact: true }).click()
  await expect(page.locator('.saved-file-message')).toContainText('선택한 보관본을 삭제했어요.')
  await page.getByRole('button', { name: '현재 기록으로 다시 비교', exact: true }).click()
  await expect(importRow(page, 'rescued').getByRole('checkbox')).toBeChecked()
  await page.getByRole('button', { name: '선택한 1개 가져오기', exact: true }).click()
  await expect(page.locator('.saved-file-message')).toContainText('선택한 1개 기록을 저장했어요.')
  expect(await readSaved(page)).toEqual([rescued, current])
})

test('backs up the latest failed draft while preventing an import from replacing pending local input', async ({ page }) => {
  const current = record('draft', 'Committed note')
  await seed(page, [current])
  await page.locator('.saved-title').click()
  await page.evaluate(() => {
    const put = IDBObjectStore.prototype.put
    IDBObjectStore.prototype.put = function (...args) {
      if (this.name === 'records') throw new DOMException('Full storage', 'QuotaExceededError')
      return Reflect.apply(put, this, args)
    }
    Reflect.set(window, '__restoreDraftPut', () => { IDBObjectStore.prototype.put = put })
  })
  await page.getByLabel('이 기회에 대한 나의 메모').fill('UNCOMMITTED 최신 메모')
  await expect(page.getByRole('alert')).toContainText('아직 저장하지 못한 변경이 있어요.')
  await page.getByRole('button', { name: 'JSON 백업·복원', exact: true }).click()
  const downloading = page.waitForEvent('download')
  await page.getByRole('button', { name: 'JSON 백업', exact: true }).click()
  const backup = JSON.parse(await readFile((await (await downloading).path())!, 'utf8'))
  expect(backup).toMatchObject({ includesUnsavedChanges: true, records: [{ note: 'UNCOMMITTED 최신 메모' }] })
  expect((await readSaved(page))[0].note).toBe('Committed note')
  await chooseFile(page, createSavedBackup([record('new')]))
  await expect(page.getByRole('button', { name: '선택한 1개 가져오기', exact: true })).toBeDisabled()
  await page.evaluate(() => Reflect.get(window, '__restoreDraftPut')())
  await page.getByRole('button', { name: '저장 다시 시도', exact: true }).click()
  await waitForSavedCommit(page)
  expect((await readSaved(page))[0].note).toBe('UNCOMMITTED 최신 메모')
})

test('reviews conflicting records and invalid files accessibly at 320px without horizontal overflow', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 800 })
  const current = record('mobile', '현재 메모 '.repeat(80))
  await seed(page, [current, { invalid: true }])
  await openFiles(page)
  await chooseFile(page, 'not,a,JSON,file', 'wrong.csv')
  await expect(page.getByRole('alert')).toContainText('CSV는 가져올 수 없어요.')
  expect(await readSaved(page)).toEqual([current])
  await chooseFile(page, createSavedBackup([record('mobile', '가져올 메모 '.repeat(80), 'applied')]), `${'긴백업파일이름'.repeat(22)}.json`)
  await importRow(page, 'mobile').locator('.saved-import-differences > summary').click()
  const note = importRow(page, 'mobile').locator('.saved-record-note').first()
  await note.focus()
  await expect(note).toBeFocused()
  await note.press('End')
  await expect.poll(() => note.evaluate(element => element.scrollTop)).toBeGreaterThan(0)
  await importRow(page, 'mobile').getByRole('checkbox').check()
  await page.getByRole('button', { name: '보관본 삭제', exact: true }).click()
  await page.getByRole('group', { name: '보관본 삭제 확인', exact: true }).scrollIntoViewIfNeeded()
  await expect(page.getByRole('button', { name: '선택한 1개 가져오기', exact: true })).toHaveCount(0)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  expect(await page.getByRole('dialog').evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true)
  const audit = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()
  expect(audit.violations).toEqual([])
})

test('keeps the most recently selected file when an earlier file finishes reading later', async ({ page }) => {
  await seed(page, [])
  await openFiles(page)
  await page.evaluate(() => {
    const text = File.prototype.text
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    File.prototype.text = async function () {
      if (this.name === 'slow.json') await gate
      return text.call(this)
    }
    Reflect.set(window, '__releaseEarlierFile', release)
  })
  await chooseFile(page, createSavedBackup([record('earlier')]), 'slow.json')
  await chooseFile(page, createSavedBackup([record('latest')]), 'latest.json')
  await expect(page.locator('.saved-import-summary')).toContainText('latest.json')
  await page.evaluate(() => Reflect.get(window, '__releaseEarlierFile')())
  await expect(importRow(page, 'latest')).toBeVisible()
  await expect(importRow(page, 'earlier')).toHaveCount(0)
  expect(await readSaved(page)).toEqual([])
})
