import { expect, test } from '@playwright/test'
import type { Locator, Page, TestInfo } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { readFile, writeFile } from 'node:fs/promises'
import type { Catalog, Filters, SavedJob } from '../../shared/types'
import {
  COVERAGE_FILTERS, COVERAGE_NEW_URLS, COVERAGE_NOTE, COVERAGE_PROFILE, COVERAGE_SENDBIRD_JOB_URL,
  COVERAGE_SENDBIRD_SOURCE_URL, COVERAGE_TITLES, COVERAGE_UPDATED_AT, coverageLegacyCache,
} from '../fixtures/public-coverage'
import { createPublicCoverageServer } from '../fixtures/public-coverage-server'
import { expectInitialCatalogRequest, readServerMode, watchApiRequests } from './helpers/api-requests'
import { readSaved, waitForSavedCommit } from './helpers/saved-store'

const filtersButton = (page: Page) => page.getByRole('button', { name: /^모든 필터/ })
const navigation = (page: Page) => page.getByRole('navigation', { name: '주요 메뉴' })
const search = (page: Page) => page.getByRole('textbox', { name: '도시, 회사 또는 포지션 검색', exact: true })
const company = (page: Page, name: string) => page.locator('.company-card').filter({ has: page.getByRole('heading', { name, exact: true }) })

async function isolate(page: Page, origin: string) {
  await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.fallback() : route.abort('blockedbyclient'))
}
async function seed(page: Page, origin: string) {
  await isolate(page, origin)
  await page.addInitScript(({ origin, profile, filters }) => {
    if (location.origin !== origin || sessionStorage.getItem('public-coverage-seeded')) return
    localStorage.setItem('orbit.v1.profile', JSON.stringify(profile))
    localStorage.setItem('orbit.v1.exploration', JSON.stringify({
      source: 'public', filters, selectedId: 'seoul', panelTab: 'cities',
      mapMode: 'flat', citySort: 'companies', light: false,
    }))
    sessionStorage.setItem('public-coverage-seeded', 'true')
  }, { origin, profile: COVERAGE_PROFILE, filters: COVERAGE_FILTERS })
}
async function escapeTo(page: Page, opener: Locator) {
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(opener).toBeFocused()
}
async function purpose(page: Page, value: Filters['postingType'], count: number) {
  const opener = filtersButton(page)
  await opener.click()
  await page.getByLabel('모집 유형', { exact: true }).selectOption(value)
  await page.getByRole('button', { name: `${count}개 공고 보기`, exact: true }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(opener).toBeFocused()
}
async function catalog(page: Page, origin: string): Promise<Catalog> {
  const response = await page.request.get(`${origin}/api/catalog?source=public`)
  try {
    expect(response.status()).toBe(200)
    return await response.json()
  } finally { await response.dispose() }
}
function browserFailures(page: Page) {
  const errors: string[] = []
  const resources: { status: number; url: string }[] = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('response', response => {
    if (response.status() >= 400) resources.push({ status: response.status(), url: response.url() })
  })
  return { errors, resources }
}
function expectPrivateTraffic(traffic: ReturnType<typeof watchApiRequests>, origin: string) {
  for (const request of traffic.requests) {
    const url = new URL(request.url)
    expect(url.origin).toBe(origin)
    expect(request.method).toBe('GET')
    expect(request.body).toBeNull()
    expect(['/api/catalog', '/api/catalog/progress', '/api/posting-status']).toContain(url.pathname)
    for (const parameter of url.searchParams.keys()) expect(['source', 'refresh', 'id', 'after']).toContain(parameter)
  }
}
async function audit(page: Page, info: TestInfo, screenshot?: string) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  for (const dialog of await page.getByRole('dialog').all()) {
    expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
  }
  expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze()).violations).toEqual([])
  if (screenshot) await page.screenshot({ path: info.outputPath(screenshot) })
}
function csvRecord(text: string) {
  const cells = (value: string) => [...value.matchAll(/"((?:[^"]|"")*)"(?:,|\r\n|$)/g)].map(match => match[1].replaceAll('""', '"'))
  const end = text.indexOf('\r\n')
  const headers = cells(text.slice(0, end))
  expect(headers).toHaveLength(45)
  expect(headers.slice(0, 8)).toEqual(['회사', '포지션', '근무지', '데이터', '상태', '저장일', '메모', '채용 링크'])
  expect(headers.slice(-4)).toEqual(['언어 조건', '언어 조건 근거', '시간대·협업 시간', '시간대·협업 시간 근거'])
  const values = cells(text.slice(end + 2))
  expect(values).toHaveLength(45)
  return Object.fromEntries(headers.map((header, index) => [header, values[index]]))
}
function expectSavedSource(records: SavedJob[]) {
  expect(records).toHaveLength(1)
  expect(records[0]).toMatchObject({
    note: COVERAGE_NOTE, status: 'applied',
    company: { id: 'sendbird', name: 'Delight.ai (Sendbird)', provider: 'greenhouse', board: 'sendbird' },
    job: {
      id: 'greenhouse-sendbird-44201', companyId: 'sendbird', source: 'greenhouse',
      title: COVERAGE_TITLES.sendbird, url: 'https://sendbird.com/careers?gh_jid=44201',
      updatedAt: COVERAGE_UPDATED_AT, cityIds: ['seoul'],
    },
  })
}

for (const width of [1440, 320]) test.describe(`unconfigured public coverage at ${width}px`, () => {
  test.use({ viewport: { width, height: 960 }, isMobile: width === 320, hasTouch: width === 320 })

  test('the real24-board default collector groups Seoul openings, finds both brand names, retains the pool and keeps samples isolated', async ({ page, request, baseURL }, info) => {
    const mode = await readServerMode(request, `${baseURL}/api/health`)
    const server = await createPublicCoverageServer(info.outputPath('default-server'), mode)
    const failures = browserFailures(page)
    const traffic = watchApiRequests(page)
    try {
      await server.start()
      await server.verifyProductionBytes()
      await seed(page, server.origin)
      await page.goto(server.origin)
      await expectInitialCatalogRequest(page, traffic)
      await expect(page.locator('.city-detail-count strong')).toHaveText(['3', '4'])
      await expect(page.locator('.city-detail-hero')).toContainText('서울')
      expect((await page.locator('.company-card h3').allTextContents()).sort()).toEqual(['Delight.ai (Sendbird)', 'Moloco', 'Stripe'])
      await expect(page.locator('.posting-purpose-badge')).toHaveCount(0)
      await expect(company(page, 'Delight.ai (Sendbird)').locator('header p')).toHaveText('AI · 고객 경험')
      await expect(company(page, 'Moloco').locator('header p')).toHaveText('AI · 광고 기술')

      const before = await catalog(page, server.origin)
      expect(before.companies).toHaveLength(24)
      expect(before.companies.slice(-2).map(company => [company.id, company.name, company.provider, company.board, company.careerUrl])).toEqual([
        ['moloco', 'Moloco', 'greenhouse', 'moloco', 'https://www.moloco.com/company/careers'],
        ['sendbird', 'Delight.ai (Sendbird)', 'greenhouse', 'sendbird', 'https://delight.ai/careers'],
      ])
      expect(before.jobs.map(job => job.id)).toEqual([
        'greenhouse-stripe-44001', 'greenhouse-moloco-44101', 'greenhouse-moloco-44102',
        'greenhouse-sendbird-44201', 'greenhouse-sendbird-44202',
      ])
      expect(before.jobs.find(job => job.id === 'greenhouse-sendbird-44201')!.url).toBe(COVERAGE_SENDBIRD_SOURCE_URL)
      const dataButton = page.getByRole('button', { name: '데이터와 추천 방식', exact: true })
      await dataButton.click()
      const data = page.getByRole('dialog')
      await expect(data.getByRole('list', { name: '공개 공고 출처' }).locator('li')).toHaveText([
        'Greenhouse13개 회사', 'Ashby6개 회사', 'Lever2개 회사', 'SmartRecruiters3개 회사',
      ])
      await expect(data.locator('.coverage-stats > div').filter({ has: page.getByText('대상 회사', { exact: true }) }).locator('strong')).toHaveText('24')
      await expect(data.locator('.coverage-stats > div').filter({ has: page.getByText('조회된 개발 공고', { exact: true }) }).locator('strong')).toHaveText('5')
      await expect(data.locator('.posting-purpose-count')).toHaveText('조회된 개발 공고에 인재풀·관심 등록 1개가 포함되어 있어요. 기본 추천에서는 제외하며 모집 유형 필터로 따로 볼 수 있어요.')
      await data.locator('.board-details > summary').click()
      const molocoRow = data.locator('.board-row').filter({ hasText: 'Moloco' })
      const sendbirdRow = data.locator('.board-row').filter({ hasText: 'Delight.ai (Sendbird)' })
      await expect(molocoRow).toHaveCount(1)
      await expect(sendbirdRow).toHaveCount(1)
      await expect(molocoRow).toContainText('Greenhouse')
      await expect(sendbirdRow).toContainText('Greenhouse')
      await sendbirdRow.scrollIntoViewIfNeeded()
      await audit(page, info, width === 320 ? 'default-new-sources-320.png' : undefined)
      await escapeTo(page, dataButton)

      for (const query of ['Delight.ai', 'Sendbird']) {
        await search(page).fill(query)
        await expect(page.locator('.city-detail-count strong')).toHaveText(['1', '2'])
        await expect(page.locator('.company-card h3')).toHaveText('Delight.ai (Sendbird)')
      }
      const sendbird = company(page, 'Delight.ai (Sendbird)')
      await sendbird.getByRole('button', { name: '전체 2개 공고 보기', exact: true }).click()
      await expect(sendbird.locator('.mini-job-title')).toHaveCount(2)
      await expect(sendbird.getByRole('button', { name: COVERAGE_TITLES.frontend, exact: true })).toBeVisible()
      const opening = sendbird.getByRole('button', { name: COVERAGE_TITLES.sendbird, exact: true })
      await opening.click()
      await expect(page.getByRole('dialog').getByRole('link', { name: '원문에서 지원하기', exact: true })).toHaveAttribute('href', 'https://delight.ai/job/44201')
      await expect(page.getByRole('dialog').locator('.source-line')).toContainText('Greenhouse 공개 게시판')
      await escapeTo(page, opening)
      await search(page).fill('서울')
      await expect(page.locator('.city-detail-count strong')).toHaveText(['3', '4'])
      await search(page).fill('')
      await purpose(page, 'talent-pool', 1)
      await expect(page.locator('.city-detail-count strong')).toHaveText(['1', '1'])
      await expect(page.locator('.company-card h3')).toHaveText('Moloco')
      await expect(page.locator('.mini-job-title')).toHaveText(COVERAGE_TITLES.pool)
      await expect(page.locator('.posting-purpose-badge')).toHaveText('인재풀·관심 등록')
      const registration = page.getByRole('button', { name: COVERAGE_TITLES.pool, exact: true })
      await registration.click()
      const scope = page.getByRole('region', { name: '모집 유형 안내', exact: true })
      await expect(scope.locator('p')).toHaveText('현재 채용 중인 특정 포지션이 아닌 인재풀·향후 기회 등록입니다. 모집 내용은 원문에서 확인해 주세요.')
      await scope.locator('summary').focus()
      await page.keyboard.press('Enter')
      await expect(scope.locator('details')).toHaveJSProperty('open', true)
      await expect(scope.locator('blockquote')).toHaveText('Greenhouse internal_job_id: null (prospect post)')
      await expect(page.getByRole('link', { name: '원문에서 지원하기', exact: true })).toHaveAttribute('href', 'https://example.com/synthetic/moloco-44102')
      await escapeTo(page, registration)
      await purpose(page, 'all', 5)
      await expect(page.locator('.city-detail-count strong')).toHaveText(['3', '5'])
      expect(JSON.parse(await page.evaluate(() => localStorage.getItem('orbit.v1.exploration')) || '{}').selectedId).toBe('seoul')

      await dataButton.click()
      await page.getByRole('button', { name: /샘플로 탐색/ }).click()
      await expect(page.getByRole('dialog').locator('.coverage-stats strong')).toHaveText(['22', '32', '179'])
      await escapeTo(page, dataButton)
      expect(JSON.parse(await page.evaluate(() => localStorage.getItem('orbit.v1.exploration')) || '{}').source).toBe('sample')
      await expect(page.locator('.company-card h3').filter({ hasText: /Moloco|Delight\.ai|Sendbird/ })).toHaveCount(0)
      const upstream = await server.requests()
      expect(upstream).toHaveLength(24)
      expect(new Set(upstream.map(request => request.url)).size).toBe(24)
      expect(upstream.every(request => request.synthetic && !request.networkSent && request.method === 'GET')).toBe(true)
      await server.assertDefaultConfiguration()
      expectPrivateTraffic(traffic, server.origin)
      expect(failures).toEqual({ errors: [], resources: [] })
      await writeFile(info.outputPath('default-coverage.json'), JSON.stringify({ catalog: before, upstream }, null, 2))
    } finally {
      await page.close()
      await server.stop()
    }
  })

  test('an old22-board cache adds only missing sources and preserves raw saved identities while actions and CSV use the verified job route', async ({ page, browser, request, baseURL }, info) => {
    const mode = await readServerMode(request, `${baseURL}/api/health`)
    const oldTime = new Date(Date.now() - 5_000).toISOString()
    const originalCache = coverageLegacyCache(oldTime)
    const server = await createPublicCoverageServer(info.outputPath('default-server'), mode, { cacheSeed: originalCache })
    const failures = browserFailures(page)
    const traffic = watchApiRequests(page)
    try {
      await server.start()
      await server.verifyProductionBytes()
      await seed(page, server.origin)
      await page.goto(server.origin)
      await expectInitialCatalogRequest(page, traffic)
      await expect(page.locator('.city-detail-count strong')).toHaveText(['3', '4'])
      const before = await catalog(page, server.origin)
      expect(before.jobs[0]).toMatchObject({ id: 'greenhouse-stripe-44001', fetchedAt: oldTime, updatedAt: COVERAGE_UPDATED_AT })
      expect((await server.requests()).map(request => request.url).sort()).toEqual([...COVERAGE_NEW_URLS].sort())
      const expanded = JSON.parse(await readFile(server.defaultCache, 'utf8'))
      expect(expanded.boards).toHaveLength(24)
      for (const original of originalCache.boards) {
        expect(expanded.boards.find((board: { companyId: string }) => board.companyId === original.companyId)).toMatchObject(original)
      }
      expect(expanded.boards.find((board: { companyId: string }) => board.companyId === 'moloco').snapshot.publishedIds)
        .toEqual(['greenhouse-moloco-44101', 'greenhouse-moloco-44102', 'greenhouse-moloco-44103'])
      expect(expanded.boards.find((board: { companyId: string }) => board.companyId === 'sendbird').snapshot.publishedIds)
        .toEqual(['greenhouse-sendbird-44201', 'greenhouse-sendbird-44202', 'greenhouse-sendbird-44203'])

      await search(page).fill('Sendbird')
      await expect(page.locator('.city-detail-count strong')).toHaveText(['1', '2'])
      const opening = page.getByRole('button', { name: COVERAGE_TITLES.sendbird, exact: true })
      await opening.click()
      await expect(page.getByRole('link', { name: '원문에서 지원하기', exact: true })).toHaveAttribute('href', COVERAGE_SENDBIRD_JOB_URL)
      await page.getByRole('button', { name: '기회 저장', exact: true }).click()
      await page.getByLabel('이 기회에 대한 나의 메모', { exact: true }).fill(COVERAGE_NOTE)
      await page.getByRole('button', { name: '지원 완료로 표시', exact: true }).click()
      await escapeTo(page, opening)
      const records = await readSaved(page)
      expectSavedSource(records)
      const savedAt = records[0].savedAt
      const fetchedAt = records[0].job.fetchedAt
      await navigation(page).getByRole('button', { name: /^저장한 기회/ }).click()
      await expect(page.locator('.saved-card h2')).toHaveText('Delight.ai (Sendbird)')
      await expect(page.locator('.saved-status')).toHaveText('지원 완료')
      await page.getByRole('button', { name: '게시 상태 확인', exact: true }).click()
      await expect(page.locator('.posting-summary strong')).toHaveText(['1', '0', '0', '0'])
      await expect(page.locator('.saved-card').getByRole('link', { name: '현재 원문 확인', exact: true })).toHaveAttribute('href', 'https://delight.ai/job/44201')
      await expect(page.locator('.posting-notice.changed')).toHaveCount(0)
      const savedOpening = page.getByRole('button', { name: COVERAGE_TITLES.sendbird, exact: true })
      await savedOpening.click()
      await expect(page.getByRole('dialog').getByRole('link', { name: '현재 원문 확인', exact: true })).toHaveAttribute('href', COVERAGE_SENDBIRD_JOB_URL)
      await expect(page.getByRole('dialog').getByRole('link', { name: '원문에서 지원하기', exact: true })).toHaveAttribute('href', COVERAGE_SENDBIRD_JOB_URL)
      await page.getByRole('dialog').locator('.posting-notice').scrollIntoViewIfNeeded()
      await audit(page, info, width === 320 ? 'sendbird-saved-derived-link-320.png' : undefined)
      await escapeTo(page, savedOpening)

      const csvDownload = page.waitForEvent('download')
      await page.getByRole('button', { name: 'CSV 내보내기', exact: true }).click()
      const csvText = await readFile((await (await csvDownload).path())!, 'utf8')
      expect(csvRecord(csvText)).toMatchObject({
        '회사': 'Delight.ai (Sendbird)', '포지션': COVERAGE_TITLES.sendbird,
        '데이터': 'Greenhouse', '상태': '지원 완료', '메모': COVERAGE_NOTE, '저장일': savedAt,
        '채용 링크': 'https://delight.ai/job/44201', '저장 내용의 조회 시각': fetchedAt,
        '공개 게시 상태': '게시 확인', '내용 비교': '표시 내용 일치', '저장 내용과 다른 항목': '',
        '모집 유형': '일반 채용 공고',
      })
      await page.getByRole('button', { name: '기록 백업·복원', exact: true }).click()
      const jsonDownload = page.waitForEvent('download')
      await page.getByRole('button', { name: 'JSON 백업', exact: true }).click()
      const backupText = await readFile((await (await jsonDownload).path())!, 'utf8')
      const backup = JSON.parse(backupText) as { records: SavedJob[] }
      expectSavedSource(backup.records)
      expect(backup.records).toEqual(records)
      expect(backupText).not.toContain(COVERAGE_PROFILE.name)
      expect(backupText).not.toContain(COVERAGE_SENDBIRD_JOB_URL)
      await page.getByRole('button', { name: '완료', exact: true }).click()

      await page.goto('about:blank')
      await server.stop()
      await server.start()
      await server.verifyProductionBytes()
      await page.goto(`${server.origin}/#saved`)
      await expect(page.locator('.saved-card')).toHaveCount(1)
      expect(await readSaved(page)).toEqual(records)
      const after = await catalog(page, server.origin)
      expect(after.jobs).toEqual(before.jobs)
      expect((await server.requests()).map(request => request.url).sort()).toEqual([...COVERAGE_NEW_URLS].sort())
      const restartedCache = JSON.parse(await readFile(server.defaultCache, 'utf8'))
      expect(restartedCache).toEqual(expanded)
      expect(restartedCache.boards.find((board: { companyId: string }) => board.companyId === 'sendbird').snapshot.jobs[0].url)
        .toBe('https://sendbird.com/careers?gh_jid=44201')
      expectPrivateTraffic(traffic, server.origin)
      expect(failures).toEqual({ errors: [], resources: [] })
      await writeFile(info.outputPath('sendbird-saved.csv'), csvText)
      await writeFile(info.outputPath('sendbird-source-backup.json'), backupText)

      const destination = await browser.newContext({ viewport: { width, height: 960 }, isMobile: width === 320, hasTouch: width === 320 })
      try {
        const target = await destination.newPage()
        const restoredFailures = browserFailures(target)
        const restoredTraffic = watchApiRequests(target)
        await isolate(target, server.origin)
        await target.goto(`${server.origin}/#saved`)
        await waitForSavedCommit(target)
        expect(await readSaved(target)).toEqual([])
        await target.getByRole('button', { name: '기록 백업·복원', exact: true }).click()
        await target.getByLabel('백업 또는 복구 파일', { exact: true }).setInputFiles({
          name: 'synthetic-public-coverage.json', mimeType: 'application/json', buffer: Buffer.from(backupText),
        })
        await expect(target.locator('.saved-import-row')).toHaveCount(1)
        await target.getByRole('button', { name: '선택한 1개 가져오기', exact: true }).click()
        await expect(target.locator('.saved-file-message')).toContainText('선택한 1개 기록을 저장했어요.')
        await target.getByRole('button', { name: '완료', exact: true }).click()
        expect(await readSaved(target)).toEqual(records)
        const restoredOpening = target.getByRole('button', { name: COVERAGE_TITLES.sendbird, exact: true })
        await restoredOpening.click()
        await expect(target.getByRole('link', { name: '원문에서 지원하기', exact: true })).toHaveAttribute('href', 'https://delight.ai/job/44201')
        await expect(target.getByLabel('이 기회에 대한 나의 메모', { exact: true })).toHaveValue(COVERAGE_NOTE)
        await expect(target.getByRole('button', { name: '지원 완료로 표시됨', exact: true })).toBeVisible()
        await escapeTo(target, restoredOpening)
        await target.reload()
        await expect(target.locator('.saved-card')).toHaveCount(1)
        expectSavedSource(await readSaved(target))
        expect(await readSaved(target)).toEqual(records)
        expect(await target.evaluate(() => localStorage.getItem('orbit.v1.profile'))).toBeNull()
        expectPrivateTraffic(restoredTraffic, server.origin)
        expect(restoredFailures).toEqual({ errors: [], resources: [] })
      } finally { await destination.close() }
      const upstream = await server.requests()
      expect(upstream).toHaveLength(2)
      expect(upstream.every(request => request.synthetic && !request.networkSent && request.method === 'GET')).toBe(true)
      await writeFile(info.outputPath('cache-saved-identity.json'), JSON.stringify({ originalCache, before, after, records, upstream }, null, 2))
    } finally {
      await page.close()
      await server.stop()
    }
  })
})
