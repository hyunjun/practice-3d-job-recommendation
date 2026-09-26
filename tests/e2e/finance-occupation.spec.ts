import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { readFile } from 'node:fs/promises'
import { normalizeAshbyJob } from '../../server/providers/ashby'
import { DEFAULT_FILTERS } from '../../shared/types'
import type { Catalog, Job } from '../../shared/types'
import {
  FINANCE_DESCRIPTION, FINANCE_NEXT_TIME, FINANCE_PROFILE, FINANCE_SOFTWARE_DESCRIPTION, FINANCE_TIME,
  financeCatalog, financeFeed, financePostingIndex,
  legacyFinanceDeveloper, legacyFinanceJob, legacyFinanceSaved,
} from '../fixtures/finance-occupation'
import { readSaved, waitForSavedCommit } from './helpers/saved-store'
import { sourceChoice } from './helpers/source-choice'

test.use({ serviceWorkers: 'block' })
const close = (page: Page) => page.getByRole('button', { name: '닫기', exact: true }).click()
const savedMenu = (page: Page) => page.getByRole('navigation', { name: '주요 메뉴' }).getByRole('button', { name: /저장한 기회/ })

function freshCatalog(refreshed = false) {
  // Normalization is under test. Expected titles, counts, IDs and timestamps
  // below are independently authored literals, never computed from these jobs.
  const jobs = financeFeed(refreshed).jobs.map(raw =>
    normalizeAshbyJob(raw, 'fable-ledger', refreshed ? FINANCE_NEXT_TIME : FINANCE_TIME))
    .filter((job): job is Job => job !== null)
  return financeCatalog(jobs, refreshed ? 9 : 8, refreshed)
}

async function seed(page: Page, withSaved = false) {
  await page.addInitScript(({ profile, filters, record }) => {
    if (sessionStorage.getItem('finance-scope-seeded')) return
    localStorage.setItem('orbit.v1.profile', JSON.stringify(profile))
    localStorage.setItem('orbit.v1.exploration', JSON.stringify({
      source: 'public', mapMode: 'flat', selectedId: 'london', panelTab: 'cities', filters,
    }))
    if (record) localStorage.setItem('orbit.v1.saved', JSON.stringify([record]))
    sessionStorage.setItem('finance-scope-seeded', 'true')
  }, { profile: FINANCE_PROFILE, filters: DEFAULT_FILTERS, record: withSaved ? legacyFinanceSaved() : null })
}

async function routes(page: Page, baseURL: string, current: () => Catalog) {
  const origin = new URL(baseURL).origin
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(origin).hostname) || new URL(origin).port === '8787') {
    throw new Error('Finance verification requires a dedicated loopback server outside port 8787.')
  }
  const errors: string[] = [], unexpected: string[] = []
  const requests: { path: string; method: string; body: string | null }[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url())
    if (url.origin !== origin) {
      unexpected.push(request.url())
      await route.abort()
    } else if (!url.pathname.startsWith('/api/')) {
      await route.continue()
    } else {
      const path = url.pathname + url.search
      requests.push({ path, method: request.method(), body: request.postData() })
      if (request.method() !== 'GET' || request.postData() !== null) {
        unexpected.push(path)
        await route.abort()
      } else if (['/api/catalog?source=public', '/api/catalog?source=public&refresh=1'].includes(path)) {
        await route.fulfill({ json: current() })
      } else if (path === '/api/posting-status?refresh=1') {
        await route.fulfill({ json: financePostingIndex() })
      } else if (path === '/api/observations') {
        await route.fulfill({ json: {
          version: 1, retentionDays: 90, storage: 'ok', days: [], otherSeries: [],
          method: 'observations-1.occupation-5.roles-1.qualifications-1.remote-2.employment-1.purpose-1',
          scope: {
            key: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            boards: [{ companyId: 'fable-ledger', name: 'Fable Ledger Lab', provider: 'ashby', board: 'fable-ledger' }],
          },
        } })
      } else {
        unexpected.push(path)
        await route.abort()
      }
    }
  })
  return { errors, unexpected, requests }
}

async function titles(page: Page, expected: string[]) {
  await expect.poll(async () => (await page.locator('.mini-job-title').allTextContents()).map(text => text.trim()).sort())
    .toEqual(expected)
}

function csvRecords(text: string): Record<string, string>[] {
  // Same small quoted-cell reader used by occupation-title-scope.spec.ts.
  const cells = (value: string) => [...value.matchAll(/"((?:[^"]|"")*)"(?:,|\r\n|$)/g)].map(match => match[1].replaceAll('""', '"'))
  const headers = cells(text.slice(0, text.indexOf('\r\n'))), values = cells(text).slice(headers.length)
  expect(values.length % headers.length).toBe(0)
  return Array.from({ length: values.length / headers.length }, (_, row) =>
    Object.fromEntries(headers.map((header, column) => [header, values[row * headers.length + column]])))
}

async function expectFinanceSaved(page: Page) {
  const records = await readSaved(page)
  expect(records).toHaveLength(1)
  expect(records[0]).toMatchObject({
    savedAt: '2026-09-26T03:04:05.000Z', status: 'applied',
    note: 'Fictional updated finance memo: retain the source.',
    company: { id: 'fable-ledger', name: 'Fable Ledger Lab', board: 'fable-ledger' },
    job: {
      id: 'ashby-fable-ledger-101', source: 'ashby',
      title: 'Strategic Finance Lead, Platform & Engineering', description: FINANCE_DESCRIPTION,
      updatedAt: '2026-09-25T06:07:08.000Z', fetchedAt: '2026-09-27T02:00:00.000Z',
      url: 'https://example.org/fable-ledger/101',
      occupation: { version: 5, category: 'other', departments: ['All Departments', 'Finance'] },
    },
  })
  return records
}

for (const width of [1440, 320]) {
  test(`finance audience suffix stays excluded across query, role, region and refresh at ${width}px`, async ({ page, baseURL }) => {
    await page.setViewportSize({ width, height: 960 })
    await page.clock.setFixedTime(new Date('2026-09-27T02:00:10.000Z'))
    await seed(page)
    const first = freshCatalog(), next = freshCatalog(true)
    let refreshed = false
    const traffic = await routes(page, baseURL!, () => refreshed ? next : first)
    await page.goto('/')
    await expect(page.locator('.city-detail-count strong')).toHaveText(['1', '4'])
    await page.getByRole('button', { name: '전체 4개 공고 보기', exact: true }).click()
    await titles(page, [
      'Backend Software Engineer, Finance Ledger', 'Computer Science Researcher, Finance Algorithms',
      'Data Scientist, Finance Projections', 'Financial Engineer, Finance Simulator',
    ])
    const search = page.getByLabel('도시, 회사 또는 포지션 검색'), role = page.getByLabel('직무 필터', { exact: true })
    await search.fill('Strategic')
    await expect(page.locator('.mini-job-title')).toHaveCount(0)
    await search.fill('Finance')
    await role.selectOption('backend')
    await titles(page, ['Backend Software Engineer, Finance Ledger'])
    await page.getByRole('button', { name: '유럽', exact: true }).click()
    await expect(page.locator('.city-row')).toHaveCount(1)
    await page.getByRole('button', { name: '런던, 추천 회사 1곳 보기', exact: true }).click()
    await titles(page, ['Backend Software Engineer, Finance Ledger'])
    await expect(page.locator('.mini-job-role')).toHaveText('백엔드')
    await page.locator('.mini-job-title').click()
    await page.getByRole('button', { name: '기회 저장', exact: true }).click()
    await page.getByLabel('이 기회에 대한 나의 메모').fill('Fictional software memo before finance refresh.')
    await page.getByRole('button', { name: '지원 완료로 표시', exact: true }).click()
    await close(page)
    await waitForSavedCommit(page)
    const originalSaved = await readSaved(page)
    expect(originalSaved).toHaveLength(1)
    expect(originalSaved[0]).toMatchObject({
      savedAt: '2026-09-27T02:00:10.000Z', status: 'applied', note: 'Fictional software memo before finance refresh.',
      job: {
        id: 'ashby-fable-ledger-201', source: 'ashby', title: 'Backend Software Engineer, Finance Ledger',
        description: FINANCE_SOFTWARE_DESCRIPTION, url: 'https://example.org/fable-ledger/201',
        fetchedAt: '2026-09-27T02:00:00.000Z', occupation: { version: 5, category: 'engineering' },
      },
    })
    await page.getByRole('button', { name: '미주', exact: true }).click()
    await expect(page.locator('.city-row')).toHaveCount(1)
    await page.getByRole('button', { name: '뉴욕, 추천 회사 1곳 보기', exact: true }).click()
    await titles(page, ['Backend Software Engineer, Finance Forecasts'])
    await page.getByRole('button', { name: '유럽', exact: true }).click()
    await page.getByRole('button', { name: '런던, 추천 회사 1곳 보기', exact: true }).click()
    refreshed = true
    await page.clock.setFixedTime(new Date('2026-09-27T02:02:10.000Z'))
    await page.getByRole('button', { name: '공개 채용', exact: true }).click()
    await page.getByRole('button', { name: '새로고침', exact: true }).click()
    await expect(page.locator('.coverage-stats strong')).toHaveText(['2', '1', '6'])
    await close(page)
    await expect(search).toHaveValue('Finance')
    await expect(role).toHaveValue('backend')
    await expect(page.getByRole('button', { name: '유럽', exact: true })).toHaveAttribute('aria-pressed', 'true')
    await titles(page, ['Backend Software Engineer, Finance Planning'])
    await expect(page.locator('.city-detail-count strong')).toHaveText(['1', '1'])
    await expect(page.locator('.company-card h3')).toHaveText('Fable Ledger Lab Revised')
    await search.fill('')
    await page.getByRole('button', { name: '전체 2개 공고 보기', exact: true }).click()
    await titles(page, ['Backend Software Engineer, Finance Planning', 'Backend Software Engineer, Ledger Core'])
    expect(await readSaved(page)).toEqual(originalSaved)
    await savedMenu(page).click()
    await expect(page.locator('.saved-title')).toHaveText('Backend Software Engineer, Finance Ledger')
    await expect(page.locator('.saved-note-preview')).toHaveText('Fictional software memo before finance refresh.')
    await expect(page.locator('.saved-status')).toHaveText('지원 완료')
    expect(traffic.requests.map(request => request.path)).toContain('/api/catalog?source=public&refresh=1')
    expect(traffic.unexpected).toEqual([])
    expect(traffic.errors).toEqual([])
  })

  test(`v4 saved finance remains readable as 기타 직군 through CSV, JSON, source changes and context restart at ${width}px`, async ({ page, browser, baseURL }, info) => {
    await page.setViewportSize({ width, height: 960 })
    await page.clock.setFixedTime(new Date('2026-09-27T02:00:10.000Z'))
    await seed(page, true)
    const catalog = financeCatalog([legacyFinanceJob(), legacyFinanceDeveloper()], 3)
    const traffic = await routes(page, baseURL!, () => catalog)
    await page.goto('/')
    await titles(page, ['Backend Software Engineer, Finance Ledger'])
    await expect(page.locator('.city-detail-count strong')).toHaveText(['1', '1'])
    await savedMenu(page).click()
    await expect(page.locator('.saved-role')).toHaveText('기타 직군')
    await expect(page.locator('.occupation-notice')).toContainText('현재 탐색 범위 밖 · 기타 직군')
    await expect(page.locator('.saved-note-preview')).toHaveText('Fictional finance memo: keep the original forecast role.')
    const savedSearch = page.getByRole('textbox', { name: '저장한 기회 검색', exact: true })
    await savedSearch.fill('세부 직무 미확인')
    await expect(page.locator('.saved-card')).toHaveCount(0)
    await savedSearch.fill('기타 직군')
    await expect(page.locator('.saved-title')).toHaveText('Strategic Finance Lead, Platform & Engineering')
    await savedSearch.fill('')
    await page.locator('.saved-title').click()
    const detail = page.getByRole('region', { name: '직무 분류', exact: true })
    await expect(detail.locator(':scope > strong')).toHaveText('기타 직군')
    await expect(detail).toContainText('공개 부서·팀: All Departments · Finance')
    await expect(page.locator('.job-dialog .occupation-notice')).toContainText('채용 종료를 뜻하지 않으며')
    await page.getByText('탐색 직군을 판단한 원문', { exact: true }).click()
    await expect(detail.locator('.occupation-evidence blockquote')).toHaveText('Strategic Finance Lead, Platform & Engineering')
    await page.locator('.original-description summary').click()
    await expect(page.locator('.original-description .job-description')).toHaveText(FINANCE_DESCRIPTION)
    await expect(page.getByRole('link', { name: '원문에서 지원하기', exact: true })).toHaveAttribute('href', 'https://example.org/fable-ledger/101')
    await expect(page.getByRole('button', { name: '지원 완료로 표시됨', exact: true })).toBeVisible()
    await page.getByLabel('이 기회에 대한 나의 메모').fill('Fictional updated finance memo: retain the source.')
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    expect((await new AxeBuilder({ page }).include('.job-dialog').analyze()).violations).toEqual([])
    await close(page)
    await waitForSavedCommit(page)
    await page.getByRole('button', { name: '게시 상태 확인', exact: true }).click()
    await expect(page.locator('.posting-notice.listed')).toContainText('비교할 수 있는 최신 본문이 없어')
    await expect(page.locator('.posting-notice.changed, .posting-notice.missing')).toHaveCount(0)
    const records = await expectFinanceSaved(page)
    await page.getByRole('button', { name: '공개 채용', exact: true }).click()
    await sourceChoice(page, 'sample').click()
    // Sample selection is client-side; the existing sample catalog is reused.
    await expect(sourceChoice(page, 'sample')).toHaveAttribute('aria-pressed', 'true')
    await close(page)
    await expect(page.getByRole('button', { name: '샘플 탐색', exact: true })).toBeVisible()
    await expect(page.locator('.saved-role')).toHaveText('기타 직군')
    expect(await expectFinanceSaved(page)).toEqual(records)
    await page.getByRole('button', { name: '샘플 탐색', exact: true }).click()
    await sourceChoice(page, 'public').click()
    await expect(page.locator('.coverage-stats strong')).toHaveText(['2', '1', '1'])
    await close(page)
    await expect(page.locator('.saved-status')).toHaveText('지원 완료')
    const csvDownload = page.waitForEvent('download')
    await page.getByRole('button', { name: 'CSV 내보내기', exact: true }).click()
    const csvPath = info.outputPath('fictional-finance.csv')
    await (await csvDownload).saveAs(csvPath)
    const exported = csvRecords(await readFile(csvPath, 'utf8'))
    expect(exported).toHaveLength(1)
    expect(exported[0]).toMatchObject({
      '회사': 'Fable Ledger Lab', '포지션': 'Strategic Finance Lead, Platform & Engineering', '데이터': 'Ashby',
      '상태': '지원 완료', '직무 분류': '기타 직군', '직무 분류 근거': '', '탐색 직군': '기타 직군',
      '저장일': '2026-09-26T03:04:05.000Z', '저장 내용의 조회 시각': '2026-09-27T02:00:00.000Z',
      '채용 링크': 'https://example.org/fable-ledger/101', '메모': 'Fictional updated finance memo: retain the source.',
      '내용 비교': '미확인', '공고 내용 확인 시각': '',
    })
    await page.getByRole('button', { name: '기록 백업·복원', exact: true }).click()
    const jsonDownload = page.waitForEvent('download')
    await page.getByRole('button', { name: 'JSON 백업', exact: true }).click()
    const jsonPath = info.outputPath('fictional-finance.json')
    await (await jsonDownload).saveAs(jsonPath)
    const backup = JSON.parse(await readFile(jsonPath, 'utf8'))
    expect(backup).toMatchObject({
      format: 'orbit-saved-backup', version: 1, exportedAt: '2026-09-27T02:00:10.000Z',
      includesUnsavedChanges: false, records,
    })
    await close(page)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    expect((await new AxeBuilder({ page }).include('.collection-page').analyze()).violations).toEqual([])
    await page.screenshot({ path: info.outputPath(`fictional-finance-saved-${width}.png`), fullPage: true })
    // Reopen committed IndexedDB in a fresh browser context without the legacy
    // seeding script. A reload that reinjected v4 would not verify persistence.
    const state = await page.context().storageState({ indexedDB: true })
    const restarted = await browser.newContext({ baseURL, storageState: state, viewport: { width, height: 960 }, reducedMotion: 'reduce', serviceWorkers: 'block' })
    try {
      const target = await restarted.newPage()
      await target.clock.setFixedTime(new Date('2026-09-27T02:00:10.000Z'))
      const restartedTraffic = await routes(target, baseURL!, () => catalog)
      await target.goto('/#saved')
      await expect(target.locator('.saved-role')).toHaveText('기타 직군')
      await expect(target.locator('.saved-note-preview')).toHaveText('Fictional updated finance memo: retain the source.')
      await expect(target.locator('.saved-status')).toHaveText('지원 완료')
      expect(await expectFinanceSaved(target)).toEqual(records)
      await target.reload()
      expect(await expectFinanceSaved(target)).toEqual(records)
      expect(restartedTraffic.unexpected).toEqual([])
      expect(restartedTraffic.errors).toEqual([])
    } finally { await restarted.close() }
    expect(traffic.unexpected).toEqual([])
    expect(traffic.errors).toEqual([])
    for (const request of traffic.requests) {
      expect(request.method).toBe('GET')
      expect(request.body).toBeNull()
      expect(request.path).not.toMatch(/fable-ledger|memo|forecast role/)
    }
  })
}
