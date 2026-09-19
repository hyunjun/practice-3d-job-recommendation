import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import AxeBuilder from '@axe-core/playwright'
import { createSampleCatalog } from '../../shared/sample'
import type { SavedJob } from '../../shared/types'
import { readSaved, waitForSavedCommit } from './helpers/saved-store'

const sample = createSampleCatalog()
const saved: SavedJob = {
  job: sample.jobs[0], company: sample.companies.find(company => company.id === sample.jobs[0].companyId)!,
  note: 'Original saved note', savedAt: '2026-09-19T08:00:00.000Z', status: 'saved',
}

async function seed(page: Page, records: unknown[] = [saved]) {
  await page.addInitScript(raw => {
    localStorage.setItem('orbit.v1.saved', raw)
    localStorage.setItem('orbit.v1.exploration', JSON.stringify({ source: 'sample', mapMode: 'flat' }))
  }, JSON.stringify(records))
}

async function unloadIsProtected(page: Page) {
  return page.evaluate(() => {
    const event = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(event)
    return event.defaultPrevented
  })
}

test('migrates healthy neighbours, retains the exact unreadable source and preserves subsequent edits across reload', async ({ page }) => {
  const rawRecords = [saved, { invalid: 'Keep this original' }, { ...saved, note: 'Duplicate must not overwrite the first note' }]
  await seed(page, rawRecords)
  await page.goto('/#saved')
  await expect(page.locator('.saved-card')).toHaveCount(1)
  await expect(page.locator('.saved-note-preview')).toHaveText(saved.note)
  expect(await page.evaluate(() => localStorage.getItem('orbit.v1.saved'))).toBeNull()
  await page.getByText('따로 보관한 원본이 있어요', { exact: true }).click()
  const downloading = page.waitForEvent('download')
  await page.getByRole('button', { name: '보관한 원본 내려받기', exact: true }).click()
  const original = JSON.parse(await readFile((await (await downloading).path())!, 'utf8'))
  expect(original.sources).toEqual([{ kind: 'legacy', count: 2, original: JSON.stringify(rawRecords) }])
  await page.locator('.saved-title').click()
  await page.getByLabel('이 기회에 대한 나의 메모').fill('Edited after migration')
  await page.getByRole('button', { name: '지원 완료로 표시', exact: true }).click()
  await waitForSavedCommit(page)
  await page.reload()
  await expect(page.locator('.saved-note-preview')).toHaveText('Edited after migration')
  await expect(page.locator('.saved-status')).toHaveText('지원 완료')
  expect((await readSaved(page))[0]).toMatchObject({ savedAt: saved.savedAt, job: { id: saved.job.id, fetchedAt: saved.job.fetchedAt } })
  expect(await page.evaluate(() => localStorage.getItem('orbit.v1.saved'))).toBeNull()
  expect(await unloadIsProtected(page)).toBe(false)
})

test('a failed initial connection preserves legacy data, avoids a false empty collection and leaves exploration available', async ({ page }) => {
  await seed(page)
  await page.addInitScript(() => {
    const open = IDBFactory.prototype.open
    let blocked = true
    IDBFactory.prototype.open = function (...args) {
      if (blocked) throw new DOMException('Test storage denial', 'SecurityError')
      return Reflect.apply(open, this, args)
    }
    Reflect.set(window, '__allowSavedStorage', () => { blocked = false })
  })
  await page.goto('/#saved')
  await expect(page.getByRole('alert')).toContainText('저장한 기회를 불러오지 못했어요.')
  await expect(page.getByText('다음 챕터의 첫 기회를 저장해 보세요', { exact: true })).toHaveCount(0)
  expect(await page.evaluate(() => localStorage.getItem('orbit.v1.saved'))).toBe(JSON.stringify([saved]))
  expect(await unloadIsProtected(page)).toBe(false)
  await page.getByRole('button', { name: '기회 탐색', exact: true }).click()
  await expect(page.locator('.city-row')).toHaveCount(22)
  await page.getByRole('button', { name: /^런던, 추천 회사 \d+곳 보기$/ }).click()
  await page.locator('.mini-job-title').first().click()
  await expect(page.getByRole('button', { name: '저장소 확인 중', exact: true })).toBeDisabled()
  await page.evaluate(() => Reflect.get(window, '__allowSavedStorage')())
  await page.getByRole('button', { name: '저장소 다시 연결', exact: true }).click()
  await waitForSavedCommit(page)
  expect(await readSaved(page)).toEqual([saved])
  await expect(page.locator('.job-dialog .saved-storage-notice.has-error')).toHaveCount(0)
})

for (const failure of ['quota', 'abort'] as const) {
  test(`${failure}: keeps the latest draft, exports it, retries a real transaction and removes the unload guard after commit`, async ({ page }) => {
    await seed(page)
    await page.goto('/#saved')
    await expect(page.locator('.saved-card')).toHaveCount(1)
    await page.locator('.saved-title').click()
    await page.evaluate(kind => {
      const put = IDBObjectStore.prototype.put
      IDBObjectStore.prototype.put = function (...args) {
        if (this.name === 'records' && kind === 'quota') throw new DOMException('Test full storage', 'QuotaExceededError')
        const request = Reflect.apply(put, this, args) as IDBRequest
        if (this.name === 'records' && kind === 'abort') request.addEventListener('success', () => this.transaction.abort(), { once: true })
        return request
      }
      Reflect.set(window, '__restoreSavedPut', () => { IDBObjectStore.prototype.put = put })
    }, failure)
    await page.getByLabel('이 기회에 대한 나의 메모').fill('First failed edit')
    await expect(page.getByRole('alert')).toContainText('아직 저장하지 못한 변경이 있어요.')
    await page.getByLabel('이 기회에 대한 나의 메모').fill('Latest draft after failure')
    await page.getByRole('button', { name: '지원 완료로 표시', exact: true }).click()
    expect((await readSaved(page))[0]).toMatchObject({ note: saved.note, status: 'saved' })
    expect(await unloadIsProtected(page)).toBe(true)
    const downloading = page.waitForEvent('download')
    await page.getByRole('button', { name: '현재 내용 CSV로 보관', exact: true }).click()
    const csv = await readFile((await (await downloading).path())!, 'utf8')
    expect(csv).toContain('Latest draft after failure')
    expect(csv).toContain('지원 완료')
    await page.getByRole('button', { name: '닫기', exact: true }).click()
    await page.getByRole('button', { name: '기회 탐색', exact: true }).click()
    await expect(page.locator('.global-saved-status')).toContainText('아직 저장하지 못한 변경이 있어요.')
    await page.evaluate(() => Reflect.get(window, '__restoreSavedPut')())
    await page.getByRole('button', { name: '저장 다시 시도', exact: true }).click()
    await waitForSavedCommit(page)
    expect((await readSaved(page))[0]).toMatchObject({ note: 'Latest draft after failure', status: 'applied', savedAt: saved.savedAt })
    expect(await unloadIsProtected(page)).toBe(false)
    await page.goto('/#saved')
    await expect(page.locator('.saved-note-preview')).toHaveText('Latest draft after failure')
  })
}

test('can remove an unwanted record and finish retrying even while record writes remain unavailable', async ({ page }) => {
  await seed(page)
  await page.goto('/#saved')
  await expect(page.locator('.saved-card')).toHaveCount(1)
  await page.locator('.saved-title').click()
  await page.evaluate(() => {
    const put = IDBObjectStore.prototype.put
    IDBObjectStore.prototype.put = function (...args) {
      if (this.name === 'records') throw new DOMException('Test full storage', 'QuotaExceededError')
      return Reflect.apply(put, this, args)
    }
  })
  await page.getByLabel('이 기회에 대한 나의 메모').fill('Unwanted failed edit')
  await expect(page.getByRole('alert')).toContainText('아직 저장하지 못한 변경이 있어요.')
  await page.getByRole('button', { name: '목록에서 제거', exact: true }).click()
  await page.getByRole('button', { name: '저장 다시 시도', exact: true }).click()
  await waitForSavedCommit(page)
  expect(await readSaved(page)).toEqual([])
  expect(await unloadIsProtected(page)).toBe(false)
  await page.getByRole('button', { name: '닫기', exact: true }).click()
  await expect(page.getByText('다음 챕터의 첫 기회를 저장해 보세요', { exact: true })).toBeVisible()
})

test('notifies another tab about notes, application status and removal without replacing unrelated fields', async ({ page, context }) => {
  await seed(page)
  await page.goto('/#saved')
  await expect(page.locator('.saved-card')).toHaveCount(1)
  const other = await context.newPage()
  try {
    await other.goto('/#saved')
    await expect(other.locator('.saved-card')).toHaveCount(1)
    await page.locator('.saved-title').click()
    await other.locator('.saved-title').click()
    await page.getByLabel('이 기회에 대한 나의 메모').fill('Shared local note')
    await expect(other.getByLabel('이 기회에 대한 나의 메모')).toHaveValue('Shared local note')
    await other.getByRole('button', { name: '지원 완료로 표시', exact: true }).click()
    await expect(page.getByRole('button', { name: '지원 완료로 표시됨', exact: true })).toBeVisible()
    expect((await readSaved(page))[0]).toMatchObject({ note: 'Shared local note', status: 'applied' })
    await other.getByRole('button', { name: '저장됨', exact: true }).click()
    await expect(page.getByLabel('이 기회에 대한 나의 메모')).toHaveCount(0)
    expect(await readSaved(page)).toEqual([])
  } finally { await other.close() }
})

test('storage recovery and retry controls remain accessible at 320px without horizontal overflow', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 800 })
  await seed(page, [saved, { invalid: true }])
  await page.goto('/#saved')
  await expect(page.locator('.saved-card')).toHaveCount(1)
  await page.getByText('따로 보관한 원본이 있어요', { exact: true }).click()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  const recovery = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()
  expect(recovery.violations).toEqual([])
  await page.locator('.saved-title').click()
  await page.evaluate(() => {
    const put = IDBObjectStore.prototype.put
    IDBObjectStore.prototype.put = function (...args) {
      if (this.name === 'records') throw new DOMException('Test full storage', 'QuotaExceededError')
      return Reflect.apply(put, this, args)
    }
  })
  await page.getByLabel('이 기회에 대한 나의 메모').fill('Mobile draft')
  await expect(page.getByRole('alert')).toContainText('아직 저장하지 못한 변경이 있어요.')
  await page.getByRole('button', { name: '저장 다시 시도', exact: true }).scrollIntoViewIfNeeded()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  const failed = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()
  expect(failed.violations).toEqual([])
})
