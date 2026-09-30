import { expect } from '@playwright/test'
import { sourceUiTest as test } from './helpers/source-public-page'
import type { Page } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { readFile } from 'node:fs/promises'
import { normalizeJob } from '../../server/normalize'
import { createJobRevision } from '../../shared/posting-status'
import { createSavedBackup } from '../../shared/saved-backup'
import { DEFAULT_FILTERS } from '../../shared/types'
import type { Catalog, Job } from '../../shared/types'
import {
  E2E_FRESH_TITLES, E2E_REFRESH_ADDED, E2E_REFRESH_RECLASSIFIED, E2E_REFRESHED_TITLES, E2E_ROWS,
  OTHER_LABEL, UNCONFIRMED_LABEL, V7_BODIES, V7_COMPANY, V7_NEXT_TIME, V7_SAVED_AT, V7_TIME,
  htmlBody, legacyV6Job, legacyV6Saved,
} from '../fixtures/occupation-v7'
import type { E2ERow } from '../fixtures/occupation-v7'
import { SEARCH_PROFILE, searchCatalog } from '../fixtures/search-catalog'
import { readSaved, waitForSavedCommit } from './helpers/saved-store'

// Stage 71 contract docs/design/occupation-v7.md revision 4, verification plan items 2 and 3.
// Production normalization builds the public responses; every visible title, count,
// label and saved field asserted below is an independent literal. All data is fictional.
const savedMenu = (page: Page) => page.getByRole('navigation', { name: '주요 메뉴' }).getByRole('button', { name: /저장한 기회/ })
const close = (page: Page) => page.getByRole('button', { name: '닫기', exact: true }).click()
const card = (page: Page, title: string) => page.locator('.saved-card').filter({ hasText: title })

function catalogWith(jobs: Job[], total: number, refreshed = false): Catalog {
  const time = refreshed ? V7_NEXT_TIME : V7_TIME
  return {
    ...searchCatalog([]), fetchedAt: time, checkedAt: time, stale: false,
    refreshAfter: refreshed ? '2026-10-01T09:03:00.000Z' : '2026-10-01T09:01:00.000Z',
    companies: [{ ...V7_COMPANY, name: refreshed ? 'Quill Hardware Studio Revised' : 'Quill Hardware Studio' }],
    jobs, unmappedCount: 0,
    boards: [{
      companyId: 'quill-hardware', provider: 'greenhouse', board: 'quill-hardware',
      status: 'ok', dataStatus: 'fresh', total, included: jobs.length,
      checkedAt: time, lastSuccessAt: time, retryAt: null,
    }],
  }
}

/** Production normalization is the subject under test; the expected visible values stay literal. */
function normalizedRows(rows: E2ERow[], fetchedAt: string): Job[] {
  return rows.map(row => normalizeJob({
    id: row.id, title: row.title, location: { name: 'London, UK' },
    departments: row.departments.map(name => ({ name })), content: htmlBody(row.description),
    absolute_url: `https://example.org/quill-hardware/${row.id}`,
  }, 'quill-hardware', fetchedAt)).filter((job): job is Job => job !== null)
}

function freshCatalog(refreshed = false): Catalog {
  const rows = refreshed ? [...E2E_ROWS.map(row => row.id === 107 ? E2E_REFRESH_RECLASSIFIED : row), E2E_REFRESH_ADDED] : E2E_ROWS
  return catalogWith(normalizedRows(rows, refreshed ? V7_NEXT_TIME : V7_TIME), rows.length, refreshed)
}

async function seedExploration(page: Page) {
  await page.addInitScript(({ profile, filters }) => {
    if (sessionStorage.getItem('occupation-v7-exploration-seeded')) return
    localStorage.setItem('orbit.v1.profile', JSON.stringify(profile))
    localStorage.setItem('orbit.v1.exploration', JSON.stringify({
      source: 'public', mapMode: 'flat', selectedId: 'london', panelTab: 'cities', filters,
    }))
    sessionStorage.setItem('occupation-v7-exploration-seeded', 'true')
  }, { profile: { ...SEARCH_PROFILE, desiredRole: 'all', skills: [] }, filters: DEFAULT_FILTERS })
}

async function expectVisibleTitles(page: Page, sortedLiteralTitles: string[]) {
  await expect.poll(async () => (await page.locator('.mini-job-title').allTextContents()).map(text => text.trim()).sort())
    .toEqual(sortedLiteralTitles)
}

function csvRecords(text: string): Record<string, string>[] {
  const cells = (value: string) => [...value.matchAll(/"((?:[^"]|"")*)"(?:,|\r\n|$)/g)].map(match => match[1].replaceAll('""', '"'))
  const headers = cells(text.slice(0, text.indexOf('\r\n')))
  const values = cells(text).slice(headers.length)
  expect(values.length % headers.length).toBe(0)
  return Array.from({ length: values.length / headers.length }, (_, index) =>
    Object.fromEntries(headers.map((header, column) => [header, values[index * headers.length + column]])))
}

// Literal titles carrying the "Engineer" token, in JavaScript default sort order. The
// firmware internship has no such token, so a nonempty query must hide exactly that row.
const E2E_FRESH_ENGINEER_TITLES = [
  'Cloud Engineer - Hardware', 'Failure Analysis Engineer', 'Machine Learning Engineer, Failure Prediction',
  'Senior Firmware Engineer', 'Senior Software Engineer - Production Test Systems', 'Senior iOS Engineer',
  'Software Engineer, Talent Tools',
]
const E2E_REFRESHED_ENGINEER_TITLES = [
  'Android Engineer - Hardware', 'Cloud Engineer - Hardware', 'Machine Learning Engineer, Failure Prediction',
  'Senior Firmware Engineer', 'Senior Software Engineer - Production Test Systems', 'Senior iOS Engineer',
  'Software Engineer, Talent Tools',
]

async function download(page: Page, button: string): Promise<string> {
  const pending = page.waitForEvent('download')
  await page.getByRole('button', { name: button, exact: true }).click()
  return readFile((await (await pending).path())!, 'utf8')
}

for (const width of [1440, 320]) {
  test(`v7 scope, Talent/Failure search, an Engineer query with the mobile filter, save and same-ID reclassifying refresh keep literal results at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 960 })
    await page.clock.setFixedTime(new Date('2026-10-01T09:00:10.000Z'))
    await seedExploration(page)
    const first = freshCatalog()
    const next = freshCatalog(true)
    let refreshed = false
    const errors: string[] = []
    const requests: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await page.route('**/api/catalog?source=public*', route => {
      const url = new URL(route.request().url())
      requests.push(url.pathname + url.search)
      return route.fulfill({ json: refreshed ? next : first })
    })
    await page.goto('/')
    await waitForSavedCommit(page)
    await expect(page.locator('.city-detail-count strong')).toHaveText(['1', '8'])
    await page.getByRole('button', { name: '전체 8개 공고 보기', exact: true }).click()
    await expectVisibleTitles(page, E2E_FRESH_TITLES)
    const search = page.getByLabel('도시, 회사 또는 포지션 검색')
    const role = page.getByLabel('직무 필터', { exact: true })
    await search.fill('Talent')
    await expectVisibleTitles(page, ['Software Engineer, Talent Tools'])
    await search.fill('Failure')
    await expectVisibleTitles(page, ['Failure Analysis Engineer', 'Machine Learning Engineer, Failure Prediction'])
    for (const excluded of ['Supplier', 'Electronics', 'Specialist']) {
      await search.fill(excluded)
      await expect(page.locator('.mini-job-title')).toHaveCount(0)
    }
    // A nonempty query stays active through the refresh together with the mobile filter.
    await search.fill('Engineer')
    // The three zero-result searches removed the company card, so it remounts collapsed to a
    // single preview. Assert and use the seven-result expand action before reading the titles.
    await expect(page.getByRole('button', { name: '전체 7개 공고 보기', exact: true })).toBeVisible()
    await page.getByRole('button', { name: '전체 7개 공고 보기', exact: true }).click()
    await expectVisibleTitles(page, E2E_FRESH_ENGINEER_TITLES)
    await expect(page.locator('.city-detail-count strong')).toHaveText(['1', '7'])
    await role.selectOption('mobile')
    await expectVisibleTitles(page, ['Senior iOS Engineer'])
    await expect(page.locator('.mini-job-role')).toHaveText('모바일')
    await page.getByRole('button', { name: 'Senior iOS Engineer', exact: true }).click()
    await expect(page.getByRole('region', { name: '직무 분류', exact: true })).toContainText('모바일')
    await page.getByRole('button', { name: '기회 저장', exact: true }).click()
    await page.getByLabel('이 기회에 대한 나의 메모').fill('Fictional mobile note before the v7 refresh.')
    await page.getByRole('button', { name: '지원 완료로 표시', exact: true }).click()
    expect((await new AxeBuilder({ page }).include('.job-dialog').analyze()).violations).toEqual([])
    await close(page)
    await waitForSavedCommit(page)
    const originalSaved = await readSaved(page)
    expect(originalSaved).toHaveLength(1)
    expect(originalSaved[0]).toMatchObject({
      savedAt: '2026-10-01T09:00:10.000Z', status: 'applied', note: 'Fictional mobile note before the v7 refresh.',
      company: { id: 'quill-hardware', name: 'Quill Hardware Studio' },
      job: {
        id: 'greenhouse-quill-hardware-111', title: 'Senior iOS Engineer', role: 'mobile',
        description: V7_BODIES.softwareDuties, fetchedAt: '2026-10-01T09:00:00.000Z',
        url: 'https://example.org/quill-hardware/111',
        occupation: { version: 7, category: 'engineering', departments: ['Hardware', 'Companion App'] },
      },
    })

    refreshed = true
    await page.clock.setFixedTime(new Date('2026-10-01T09:02:10.000Z'))
    await page.getByRole('button', { name: '공개 채용', exact: true }).click()
    await expect(page.getByRole('button', { name: '새로고침', exact: true })).toBeEnabled()
    await page.getByRole('button', { name: '새로고침', exact: true }).click()
    await expectVisibleTitles(page, ['Android Engineer - Hardware', 'Senior iOS Engineer'])
    await close(page)
    expect(requests).toContain('/api/catalog?source=public&refresh=1')
    await expect(search).toHaveValue('Engineer')
    await expect(role).toHaveValue('mobile')
    await expect(page.locator('.city-detail-count strong')).toHaveText(['1', '2'])
    await expect(page.locator('.company-card h3')).toHaveText('Quill Hardware Studio Revised')
    await role.selectOption('all')
    await expectVisibleTitles(page, E2E_REFRESHED_ENGINEER_TITLES)
    await expect(page.locator('.city-detail-count strong')).toHaveText(['1', '7'])
    // Clear the query explicitly before checking the whole refreshed catalog; the internship is otherwise hidden.
    await search.fill('')
    await expectVisibleTitles(page, E2E_REFRESHED_TITLES)
    await expect(page.locator('.city-detail-count strong')).toHaveText(['1', '8'])
    await search.fill('Failure')
    await expectVisibleTitles(page, ['Machine Learning Engineer, Failure Prediction'])
    await search.fill('Cloud')
    await expectVisibleTitles(page, ['Cloud Engineer - Hardware'])
    await expect(page.locator('.mini-job-role')).toHaveText('인프라 · DevOps')
    await search.fill('Talent')
    await expectVisibleTitles(page, ['Software Engineer, Talent Tools'])
    expect(await readSaved(page)).toEqual(originalSaved)
    await savedMenu(page).click()
    await expect(page.locator('.saved-card')).toHaveCount(1)
    await expect(page.locator('.saved-title')).toHaveText('Senior iOS Engineer')
    await expect(page.locator('.saved-role')).toHaveText('모바일')
    await expect(page.locator('.saved-note-preview')).toHaveText('Fictional mobile note before the v7 refresh.')
    await expect(page.locator('.saved-status')).toHaveText('지원 완료')
    await expect(page.locator('.occupation-notice')).toHaveCount(0)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    expect((await new AxeBuilder({ page }).include('.collection-page').analyze()).violations).toEqual([])
    await page.reload()
    expect(await readSaved(page)).toEqual(originalSaved)
    expect(errors).toEqual([])
  })

  test(`saved v6 supplier-quality and Failure Analysis records keep notes, literal labels, listed status, exports and imports at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 960 })
    await page.clock.setFixedTime(new Date('2026-10-01T09:00:10.000Z'))
    await seedExploration(page)
    const supplierSaved = legacyV6Saved('supplier-quality', 'Fictional supplier note: keep my original record.')
    const failureSaved = legacyV6Saved('failure-analysis-empty', 'Fictional failure-analysis note: keep my original record.')
    await page.addInitScript(records => {
      if (sessionStorage.getItem('occupation-v7-saved-seeded')) return
      localStorage.setItem('orbit.v1.saved', JSON.stringify(records))
      sessionStorage.setItem('occupation-v7-saved-seeded', 'true')
    }, [supplierSaved, failureSaved])
    const developer = normalizedRows([E2E_ROWS[5]], V7_TIME)[0]
    const legacyCatalog = catalogWith([legacyV6Job('supplier-quality'), legacyV6Job('failure-analysis-empty'), developer], 3)
    await page.route('**/api/catalog?source=public*', route => route.fulfill({ json: legacyCatalog }))
    const index = {
      version: 1, checkedAt: V7_TIME, refreshAfter: '2026-10-01T09:01:00.000Z',
      boards: [{
        companyId: 'quill-hardware', provider: 'greenhouse', board: 'quill-hardware',
        status: 'ok', checkedAt: V7_TIME, lastSuccessAt: V7_TIME, retryAt: null,
        listing: {
          validUntil: '2026-10-01T09:30:00.000Z',
          publishedIds: [supplierSaved.job.id, failureSaved.job.id, developer.id],
          jobs: [{ id: developer.id, title: developer.title, url: developer.url, revision: await createJobRevision(developer) }],
        },
      }],
    }
    await page.route('**/api/posting-status*', route => route.fulfill({ json: index }))
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await page.goto('/')
    await expectVisibleTitles(page, ['Senior Firmware Engineer'])
    await expect(page.locator('.city-detail-count strong')).toHaveText(['1', '1'])
    await savedMenu(page).click()
    await expect(page.locator('.saved-card')).toHaveCount(2)
    const supplier = card(page, 'Lead Supplier Quality Engineer')
    const failure = card(page, 'Failure Analysis Engineer')
    await expect(supplier.locator('.saved-role')).toHaveText(OTHER_LABEL)
    await expect(failure.locator('.saved-role')).toHaveText(UNCONFIRMED_LABEL)
    await expect(supplier.locator('.occupation-notice')).toContainText(`현재 탐색 범위 밖 · ${OTHER_LABEL}`)
    await expect(failure.locator('.occupation-notice')).toContainText(`현재 탐색 범위 밖 · ${UNCONFIRMED_LABEL}`)
    await expect(supplier.locator('.saved-note-preview')).toHaveText('Fictional supplier note: keep my original record.')
    await expect(failure.locator('.saved-note-preview')).toHaveText('Fictional failure-analysis note: keep my original record.')
    await expect(page.locator('.saved-status')).toHaveText(['지원 완료', '지원 완료'])
    const savedSearch = page.getByRole('textbox', { name: '저장한 기회 검색', exact: true })
    await savedSearch.fill('미확인')
    await expect(page.locator('.saved-title')).toHaveText('Failure Analysis Engineer')
    await savedSearch.fill(OTHER_LABEL)
    await expect(page.locator('.saved-title')).toHaveText('Lead Supplier Quality Engineer')
    await savedSearch.fill('')
    await page.getByRole('button', { name: '게시 상태 확인', exact: true }).click()
    await expect(page.locator('.posting-notice.listed')).toHaveCount(2)
    for (const notice of await page.locator('.posting-notice.listed').all()) await expect(notice).toContainText('게시판에는 있지만 현재 탐색 범위 밖')
    await expect(page.locator('.posting-notice.changed, .posting-notice.missing')).toHaveCount(0)

    await supplier.locator('.saved-title').click()
    const detail = page.getByRole('region', { name: '직무 분류', exact: true })
    await expect(detail.locator(':scope > strong')).toHaveText(OTHER_LABEL)
    await expect(detail).toContainText('공개 부서·팀: Hardware · Supply Chain')
    await expect(page.locator('.job-dialog .occupation-notice')).toContainText('채용 종료를 뜻하지 않으며')
    await page.getByText('탐색 직군을 판단한 원문', { exact: true }).click()
    await expect(detail.locator('.occupation-evidence')).toContainText('Lead Supplier Quality Engineer')
    await page.locator('.original-description summary').click()
    await expect(page.locator('.original-description .job-description')).toHaveText(V7_BODIES.supplierInspection)
    await expect(page.getByRole('link', { name: '원문에서 지원하기', exact: true })).toHaveAttribute('href', 'https://example.org/quill-hardware/supplier-quality')
    await expect(page.getByLabel('이 기회에 대한 나의 메모')).toHaveValue('Fictional supplier note: keep my original record.')
    await expect(page.getByRole('button', { name: '지원 완료로 표시됨', exact: true })).toBeVisible()
    await page.getByLabel('이 기회에 대한 나의 메모').fill('Fictional revised supplier note after v7.')
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    expect((await new AxeBuilder({ page }).include('.job-dialog').analyze()).violations).toEqual([])
    await close(page)
    await waitForSavedCommit(page)
    await failure.locator('.saved-title').click()
    await expect(detail.locator(':scope > strong')).toHaveText(UNCONFIRMED_LABEL)
    await expect(detail).toContainText('공개 부서·팀: Hardware')
    await expect(page.locator('.job-dialog .occupation-notice')).toContainText(`현재 탐색 범위 밖 · ${UNCONFIRMED_LABEL}`)
    await expect(page.getByLabel('이 기회에 대한 나의 메모')).toHaveValue('Fictional failure-analysis note: keep my original record.')
    await close(page)
    await waitForSavedCommit(page)

    await page.reload()
    await savedMenu(page).click()
    await expect(page.locator('.saved-card')).toHaveCount(2)
    const records = await readSaved(page)
    expect(records).toHaveLength(2)
    expect(records.find(record => record.job.id === 'greenhouse-quill-hardware-supplier-quality')).toMatchObject({
      savedAt: V7_SAVED_AT, status: 'applied', note: 'Fictional revised supplier note after v7.',
      job: {
        title: 'Lead Supplier Quality Engineer', description: V7_BODIES.supplierInspection,
        url: 'https://example.org/quill-hardware/supplier-quality', fetchedAt: '2026-10-01T09:00:00.000Z',
        occupation: { version: 7, category: 'other', departments: ['Hardware', 'Supply Chain'] },
      },
    })
    expect(records.find(record => record.job.id === 'greenhouse-quill-hardware-failure-analysis-empty')).toMatchObject({
      savedAt: V7_SAVED_AT, status: 'applied', note: 'Fictional failure-analysis note: keep my original record.',
      job: {
        title: 'Failure Analysis Engineer', description: '', fetchedAt: '2026-10-01T09:00:00.000Z',
        occupation: { version: 7, category: 'unconfirmed', departments: ['Hardware'] },
      },
    })
    await expect(supplier.locator('.saved-role')).toHaveText(OTHER_LABEL)
    await expect(failure.locator('.saved-role')).toHaveText(UNCONFIRMED_LABEL)
    expect((await new AxeBuilder({ page }).include('.collection-page').analyze()).violations).toEqual([])

    const exported = csvRecords(await download(page, 'CSV 내보내기'))
    expect(exported).toHaveLength(2)
    expect(exported.find(row => row['포지션'] === 'Lead Supplier Quality Engineer')).toMatchObject({
      '직무 분류': OTHER_LABEL, '직무 분류 근거': '', '탐색 직군': OTHER_LABEL,
      '저장일': V7_SAVED_AT, '메모': 'Fictional revised supplier note after v7.',
    })
    expect(exported.find(row => row['포지션'] === 'Failure Analysis Engineer')).toMatchObject({
      '직무 분류': UNCONFIRMED_LABEL, '직무 분류 근거': '', '탐색 직군': UNCONFIRMED_LABEL,
      '저장일': V7_SAVED_AT, '메모': 'Fictional failure-analysis note: keep my original record.',
    })

    await page.getByRole('button', { name: '기록 백업·복원', exact: true }).click()
    await expect(page.getByRole('dialog', { name: '기록 백업과 복원', exact: true })).toBeVisible()
    const backup = JSON.parse(await download(page, 'JSON 백업'))
    expect(backup).toMatchObject({ format: 'orbit-saved-backup', version: 1 })
    expect(backup.records).toHaveLength(2)
    expect(Object.fromEntries(backup.records.map((record: { job: Job }) => [record.job.id, record.job.occupation]))).toMatchObject({
      'greenhouse-quill-hardware-supplier-quality': { version: 7, category: 'other' },
      'greenhouse-quill-hardware-failure-analysis-empty': { version: 7, category: 'unconfirmed' },
    })
    // A backup that still carries the v6 assessment imports as a v7 record without losing the note it brings.
    await page.getByLabel('백업 또는 복구 파일', { exact: true }).setInputFiles({
      name: 'v6-backup.json', mimeType: 'application/json',
      buffer: Buffer.from(createSavedBackup([{ ...supplierSaved, note: 'Imported fictional note from a version 6 backup.' }])),
    })
    const importRow = page.locator('.saved-import-row').filter({ hasText: 'Lead Supplier Quality Engineer' })
    await expect(importRow.getByRole('checkbox')).not.toBeChecked()
    await importRow.locator('.saved-import-differences > summary').click()
    await expect(importRow.locator('.saved-record-comparison')).toContainText('Imported fictional note from a version 6 backup.')
    await importRow.getByRole('checkbox').check()
    await page.getByRole('button', { name: '선택한 1개 가져오기', exact: true }).click()
    await expect(page.locator('.saved-file-message')).toContainText('기존 공고 변경 1개')
    const imported = await readSaved(page)
    expect(imported).toHaveLength(2)
    expect(imported.find(record => record.job.id === 'greenhouse-quill-hardware-supplier-quality')).toMatchObject({
      savedAt: V7_SAVED_AT, status: 'applied', note: 'Imported fictional note from a version 6 backup.',
      job: { description: V7_BODIES.supplierInspection, occupation: { version: 7, category: 'other', departments: ['Hardware', 'Supply Chain'] } },
    })
    expect(imported.find(record => record.job.id === 'greenhouse-quill-hardware-failure-analysis-empty')?.note).toBe('Fictional failure-analysis note: keep my original record.')
    expect(errors).toEqual([])
  })
}
