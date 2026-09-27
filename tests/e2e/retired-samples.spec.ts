/** Public-only behavior with intercepted synthetic inputs; no live provider requests. */
import { expect } from '@playwright/test'
import { resourceCheckedTest as test } from './helpers/public-app'
import { IMPORTED_SAVED, LEGACY_EXPLORATION, PUBLIC_NOTE, PUBLIC_SAVED, publicCatalog } from '../fixtures/public-only-contract'
import {
  LEGACY_ENTRY, LEGACY_NOTE, LEGACY_SAVED, OLD_META, PUBLIC_ENTRY, RETIRED_LABEL,
  SECOND_LEGACY_SAVED, SHADOWING_SAMPLE, importFile,
} from '../fixtures/legacy-saved-contract'
import {
  committed, expectSavedOnlyTraffic, expectTraffic, installHarness, noSampleChoice, ordinary,
  rawSavedDatabase, seed,
} from './helpers/public-only'
import { downloadText, expectExcludedImport, expectNoRetiredPaint, guardRetiredCards, openSavedFiles } from './helpers/saved-retirement'

// Preserve the original intercepted-context contract when using the root config.
test.use({ serviceWorkers: 'block' })

test('a fresh saved-page visit stays lazy until the user opens exploration', async ({ page, baseURL }) => {
  const h = await installHarness(page, baseURL!, { json: publicCatalog() })
  await page.goto(`${h.origin}/#saved`)
  await committed(page)
  await expect(page.locator('.saved-title')).toHaveCount(0)
  await noSampleChoice(page)
  await openSavedFiles(page)
  await expect(page.locator('.saved-recovery-source')).toHaveCount(0)
  await page.keyboard.press('Escape')
  await page.reload()
  await committed(page)
  expectSavedOnlyTraffic(h)
  const atlasLoaded = page.waitForEvent('requestfinished', {
    predicate: request => new URL(request.url()).pathname === '/earth/countries-110m.json',
  })
  await page.getByRole('navigation', { name: '주요 메뉴' }).getByRole('button', { name: '기회 탐색', exact: true }).click()
  await expect(page.locator('.city-row')).toHaveCount(3)
  expect((await (await atlasLoaded).response())?.status()).toBe(200)
  await expect(page.locator('.earth-canvas')).toHaveClass(/is-ready/)
  await expectTraffic(h, [{ path: ordinary, status: 200 }])
})

for (const width of [1440, 320]) {
  test(`retired notes have a separate full-original download and confirmed deletion, outside JSON/CSV at ${width}px`, async ({ page, baseURL }, testInfo) => {
    await page.setViewportSize({ width, height: 900 })
    const h = await installHarness(page, baseURL!, { json: publicCatalog() })
    await seed(page, h.origin, { exploration: LEGACY_EXPLORATION, store: 'indexedDB-v1', entries: [LEGACY_ENTRY, PUBLIC_ENTRY], meta: OLD_META })
    await guardRetiredCards(page)
    await page.goto(`${h.origin}/#saved`)
    await committed(page)
    await expect(page.locator('.saved-title')).toHaveText(['Backend Engineer — Fable Rail API'])
    const csv = await downloadText(page, page.getByRole('button', { name: 'CSV 내보내기', exact: true }))
    expect(csv).toContain(PUBLIC_NOTE)
    expect(csv).toContain('Greenhouse')
    expect(csv).not.toContain(LEGACY_NOTE)
    expect(csv).not.toContain('Legacy fictional opportunity 65')

    await openSavedFiles(page)
    const archive = page.locator('.saved-recovery-source').filter({ hasText: RETIRED_LABEL })
    await expect(archive.getByText(RETIRED_LABEL, { exact: true })).toBeVisible()
    if (width === 320) {
      await archive.evaluate(element => element.scrollIntoView({ block: 'center', behavior: 'instant' }))
      await expect(archive.getByText(RETIRED_LABEL, { exact: true })).toBeInViewport({ ratio: 1 })
      for (const name of ['이 원본 내려받기', '보관본 삭제']) {
        const action = archive.getByRole('button', { name, exact: true })
        await expect(action).toBeInViewport({ ratio: 1 })
        const box = await action.boundingBox()
        const footer = await page.locator('.saved-data-footer').boundingBox()
        expect(box).not.toBeNull()
        expect(footer).not.toBeNull()
        expect(box!.y + box!.height).toBeLessThanOrEqual(footer!.y)
      }
      await page.evaluate(async () => { await document.fonts.ready })
      const screenshot = testInfo.outputPath('retired-notes-manage-320.png')
      await page.screenshot({ path: screenshot })
      await testInfo.attach('retired-notes-manage-320', { path: screenshot, contentType: 'image/png' })
    }
    const backup = JSON.parse(await downloadText(page, page.getByRole('button', { name: 'JSON 백업', exact: true })))
    expect(backup.records.map((record: { job: { id: string } }) => record.job.id)).toEqual(['greenhouse-fixture65-rail-api'])
    expect(backup.records[0]).toMatchObject({ note: PUBLIC_NOTE, status: 'applied', savedAt: '2026-09-26T23:56:00.000Z' })
    expect(JSON.stringify(backup)).not.toContain(LEGACY_NOTE)
    const originalFile = await downloadText(page, archive.getByRole('button', { name: '이 원본 내려받기', exact: true }))
    const original = JSON.parse(originalFile)
    expect(original).toMatchObject({
      format: 'orbit-saved-recovery', version: 1,
    })
    expect(original.sources).toEqual([{ kind: 'retired-samples', count: 1, original: [LEGACY_ENTRY] }])
    expect((await rawSavedDatabase(page)).meta.retiredSamples).toEqual([LEGACY_ENTRY])

    // Even the local archive's own download is not an active-job import.
    await page.getByLabel('백업 또는 복구 파일', { exact: true }).setInputFiles({
      name: 'synthetic-retired-original.json', mimeType: 'application/json', buffer: Buffer.from(originalFile),
    })
    await expectExcludedImport(page, 1)
    await expect(page.locator('.saved-import-row')).toHaveCount(0)
    await expect(page.getByRole('button', { name: '선택한 0개 가져오기', exact: true })).toBeDisabled()
    expect((await rawSavedDatabase(page)).meta.retiredSamples).toEqual([LEGACY_ENTRY])
    await page.keyboard.press('Escape')
    await openSavedFiles(page)
    await archive.getByRole('button', { name: '보관본 삭제', exact: true }).click()
    await expect(page.getByRole('group', { name: '보관본 삭제 확인', exact: true })).toBeVisible()
    await page.getByRole('button', { name: '삭제 취소', exact: true }).click()
    expect((await rawSavedDatabase(page)).meta.retiredSamples).toEqual([LEGACY_ENTRY])
    await archive.getByRole('button', { name: '보관본 삭제', exact: true }).click()
    await page.getByRole('button', { name: '선택한 보관본 삭제', exact: true }).click()
    await expect(page.locator('.saved-file-message')).toContainText('선택한 보관본을 삭제했어요.')
    await expect(page.locator('.saved-recovery-source')).toHaveCount(0)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    const raw = await rawSavedDatabase(page)
    expect(raw.entries).toEqual([PUBLIC_ENTRY])
    expect(raw.meta).toMatchObject(OLD_META)
    expect(raw.meta.retiredSamples ?? []).toEqual([])
    await page.keyboard.press('Escape')
    await expectNoRetiredPaint(page)
    await page.reload()
    await committed(page)
    await expect(page.locator('.saved-title')).toHaveText(['Backend Engineer — Fable Rail API'])
    await openSavedFiles(page)
    await expect(page.locator('.saved-recovery-source')).toHaveCount(0)
    await expectNoRetiredPaint(page)
    expectSavedOnlyTraffic(h)
  })
}

test('a retirement transaction abort shows no fictional card, preserves both originals, and can retry', async ({ page, baseURL }) => {
  const h = await installHarness(page, baseURL!, { json: publicCatalog() })
  await seed(page, h.origin, { exploration: LEGACY_EXPLORATION, store: 'indexedDB-v1', entries: [LEGACY_ENTRY, PUBLIC_ENTRY], meta: OLD_META })
  const original = await rawSavedDatabase(page)
  await guardRetiredCards(page)
  await page.addInitScript(() => {
    const fault = { enabled: true, hits: 0 }
    Reflect.set(window, '__stage65RetirementFault', fault)
    const remove = IDBObjectStore.prototype.delete
    IDBObjectStore.prototype.delete = function (key) {
      const request = remove.call(this, key)
      if (this.name === 'records' && key === 'sample-fixture65-obsolete')
        request.addEventListener('success', () => {
          if (fault.enabled) { fault.hits++; this.transaction.abort() }
        }, { once: true })
      return request
    }
  })
  await page.goto(`${h.origin}/#saved`)
  await expect(page.getByRole('alert')).toContainText('저장한 기회를 불러오지 못했어요.')
  expect(await page.evaluate(() => Reflect.get(window, '__stage65RetirementFault').hits)).toBeGreaterThan(0)
  await expect(page.locator('.saved-title')).toHaveCount(0)
  await expectNoRetiredPaint(page)
  expect(await rawSavedDatabase(page)).toEqual(original)
  await page.evaluate(() => { Reflect.get(window, '__stage65RetirementFault').enabled = false })
  await page.getByRole('button', { name: '저장소 다시 연결', exact: true }).click()
  await committed(page)
  await expect(page.locator('.saved-title')).toHaveText(['Backend Engineer — Fable Rail API'])
  const recovered = await rawSavedDatabase(page)
  expect(recovered.entries).toEqual([PUBLIC_ENTRY])
  expect(recovered.meta.retiredSamples).toEqual([LEGACY_ENTRY])
  await expectNoRetiredPaint(page)
  expectSavedOnlyTraffic(h)
})

for (const format of ['backup', 'legacy', 'recovery'] as const) {
  test(`a sample-only ${format} file is explicitly excluded with zero selection and no automatic archive`, async ({ page, baseURL }) => {
    const h = await installHarness(page, baseURL!, { json: publicCatalog() })
    await seed(page, h.origin, { exploration: LEGACY_EXPLORATION, saved: [PUBLIC_SAVED] })
    await page.goto(`${h.origin}/#saved`)
    await committed(page)
    const before = await rawSavedDatabase(page)
    await openSavedFiles(page)
    await page.getByLabel('백업 또는 복구 파일', { exact: true }).setInputFiles({
      name: `synthetic-samples-only-${format}.json`, mimeType: 'application/json',
      buffer: Buffer.from(importFile(format, [LEGACY_SAVED, SECOND_LEGACY_SAVED])),
    })
    await expectExcludedImport(page, 2)
    await expect(page.locator('.saved-import-row')).toHaveCount(0)
    await expect(page.getByRole('button', { name: '선택한 0개 가져오기', exact: true })).toBeDisabled()
    await expect(page.locator('.saved-recovery-source')).toHaveCount(0)
    expect(await rawSavedDatabase(page)).toEqual(before)
    await page.keyboard.press('Escape')
    await page.reload()
    await committed(page)
    await expect(page.locator('.saved-title')).toHaveText(['Backend Engineer — Fable Rail API'])
    expect(await rawSavedDatabase(page)).toEqual(before)
    expectSavedOnlyTraffic(h)
  })
}

test('a sample-first duplicate ID cannot hide or relabel its public import neighbour', async ({ page, baseURL }) => {
  const h = await installHarness(page, baseURL!, { json: publicCatalog() })
  await seed(page, h.origin, { exploration: LEGACY_EXPLORATION, saved: [PUBLIC_SAVED] })
  await page.goto(`${h.origin}/#saved`)
  await committed(page)
  await openSavedFiles(page)
  await page.getByLabel('백업 또는 복구 파일', { exact: true }).setInputFiles({
    name: 'synthetic-shared-id.json', mimeType: 'application/json',
    buffer: Buffer.from(importFile('backup', [SHADOWING_SAMPLE, IMPORTED_SAVED])),
  })
  await expectExcludedImport(page, 1)
  await expect(page.locator('.saved-import-row')).toHaveCount(1)
  await expect(page.locator('.saved-import-row')).toContainText('Backend Engineer — Loom Textiles Platform')
  await expect(page.locator('.saved-import-row').getByRole('checkbox')).toBeChecked()
  await page.getByRole('button', { name: '선택한 1개 가져오기', exact: true }).click()
  await expect(page.locator('.saved-file-message')).toContainText('선택한 1개 기록을 저장했어요.')
  await page.keyboard.press('Escape')
  const records = await committed(page)
  expect(records.map(record => record.job.id)).toEqual(['ashby-fixture65-textile-platform', 'greenhouse-fixture65-rail-api'])
  expect(records[0]).toMatchObject({
    job: { source: 'ashby', title: 'Backend Engineer — Loom Textiles Platform' },
    note: 'PRIVATE_65_IMPORTED_NOTE 원본 유지', status: 'saved', savedAt: '2026-09-26T23:57:00.000Z',
  })
  await expect(page.locator('.saved-title')).toHaveText(['Backend Engineer — Loom Textiles Platform', 'Backend Engineer — Fable Rail API'])
  expect((await rawSavedDatabase(page)).meta.retiredSamples ?? []).toEqual([])
  expectSavedOnlyTraffic(h)
})
