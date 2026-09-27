import { expect, test } from '@playwright/test'
import type { BrowserContext, Locator, Page, TestInfo } from '@playwright/test'
import { readFile, writeFile } from 'node:fs/promises'
import type { Catalog, SavedJob } from '../../shared/types'
import { CAREERS_WIRE_JOBS, bookingResponses, starbucksResponses, zalandoResponses } from '../fixtures/careers-wire'
import { CAREERS_NOW, STARBUCKS_LIST_URLS, careersCachedJob, careersCompany } from '../fixtures/careers-contract'
import { SOFTWARE_DESIGN_BODY } from '../fixtures/industry-occupation'
import { createPublicCoverageServer } from '../fixtures/public-coverage-server'
import { SOURCE_EXPANSION_IDS, SOURCE_EXPANSION_REGISTRATIONS } from '../fixtures/source-expansion-contract'
import { SOURCE_EXPANSION_ATS_JOBS } from '../fixtures/source-expansion-postings'
import { searchCatalog } from '../fixtures/search-catalog'
import {
  SOURCE_EXPANSION_ALL_FULL_URLS, SOURCE_EXPANSION_EXCLUDED_IDS, SOURCE_EXPANSION_NOTE, SOURCE_EXPANSION_NOW,
  sourceExpansionOld93Cache, sourceExpansionResponses,
} from '../fixtures/source-expansion-wire'
import { readServerMode } from './helpers/api-requests'
import { readSaved } from './helpers/saved-store'
import { sourceChoice } from './helpers/source-choice'
import { csvRows, downloadText, saveWithNote, statusAction } from './helpers/source-integrations'
import {
  expectSurveyPrivacy, seedSurvey, surveyBoardHistory, surveyClose, surveyDataButton, surveyImage,
  surveyNavigation, surveyRole, surveySearch,
} from './helpers/public-company-survey'

const bookingTitle = 'Backend Engineer — Synthetic Canal API64'
const starbucksTitle = 'Backend Engineer — Synthetic Maple Orders64'
const bookingUrl = 'https://jobs.booking.com/booking/jobs/640001?lang=en-us'
const starbucksUrl = 'https://apply.starbucks.com/careers/job/640001'
const scopeUrl = 'https://careers.starbucks.com/discover-opportunities/technology/'
const savedStarbucks = (page: Page) => page.locator('.saved-card').filter({ has: page.getByRole('button', { name: starbucksTitle, exact: true }) })

async function fixture(page: Page, info: TestInfo, baseURL?: string) {
  if (baseURL && new URL(baseURL).port === '8787') throw new Error('Stage64 never uses port8787')
  const configured = process.env.ORBIT_SURVEY_MODE
  const mode = configured === 'development' || configured === 'production' ? configured
    : await readServerMode(page.request, `${baseURL}/api/health`)
  return createPublicCoverageServer(info.outputPath('source-expansion-server'), mode, {
    cacheSeed: sourceExpansionOld93Cache(), clock: SOURCE_EXPANSION_NOW, responses: sourceExpansionResponses(),
  })
}

async function fullCatalog(page: Page, origin: string) {
  const response = await page.request.get(`${origin}/api/catalog?source=public`, { timeout: 90_000 })
  try {
    expect(response.status()).toBe(200)
    const catalog = await response.json() as Catalog
    expect(catalog.source).toBe('public')
    expect(catalog.companies).toHaveLength(124)
    expect(catalog.boards).toHaveLength(124)
    expect(catalog.jobs).toHaveLength(36)
    expect(catalog.boards.every(board => board.status === 'ok' && board.dataStatus === 'fresh')).toBe(true)
    expect(catalog.companies.slice(93).map(company => company.id)).toEqual(SOURCE_EXPANSION_IDS)
    expect(catalog.boards.reduce((sum, board) => sum + board.total, 0)).toBe(164)
    for (const expected of [...SOURCE_EXPANSION_ATS_JOBS, ...CAREERS_WIRE_JOBS]) {
      expect(catalog.jobs.find(job => job.id === expected.id)).toMatchObject({
        id: expected.id, companyId: expected.companyId, source: expected.source,
        title: expected.title, role: expected.role, url: expected.url, cityIds: expected.cityIds,
      })
    }
    for (const id of SOURCE_EXPANSION_EXCLUDED_IDS) expect(catalog.jobs.some(job => job.id === id)).toBe(false)
    expect(catalog.boards.filter(board => board.provider === 'careers').map(board => [board.companyId, board.total, board.included]))
      .toEqual([['booking', 101, 2], ['zalando', 16, 2], ['starbucks', 11, 2]])
    return catalog
  } finally { await response.dispose() }
}

async function technologyCredit(scope: Locator) {
  await expect(scope.locator('.job-source-credit').first().getByRole('link', { name: 'Starbucks Technology', exact: true }))
    .toHaveAttribute('href', scopeUrl)
}
function savedFacts(records: SavedJob[]) {
  expect(records).toHaveLength(2)
  expect(records.find(record => record.job.id === 'careers-booking-640001')).toMatchObject({
    company: { id: 'booking', name: 'Booking.com / Booking Holdings', provider: 'careers', board: 'booking' },
    job: { title: bookingTitle, source: 'careers', url: bookingUrl },
    note: 'Synthetic regional Booking note64', status: 'applied',
  })
  expect(records.find(record => record.job.id === 'careers-starbucks-640001')).toMatchObject({
    company: { id: 'starbucks', name: 'Starbucks', provider: 'careers', board: 'starbucks-technology' },
    job: { title: starbucksTitle, source: 'careers', url: starbucksUrl, updatedAt: null },
    note: SOURCE_EXPANSION_NOTE, status: 'applied',
  })
}
async function syntheticRequests(server: Awaited<ReturnType<typeof fixture>>) {
  const requests = await server.requests()
  expect(requests.every(request => request.synthetic && !request.networkSent && request.method === 'GET' && request.body === null)).toBe(true)
  expect(requests.some(request => request.url.includes('position_details'))).toBe(false)
  expect(requests.some(request => request.url.includes('/companies/AUTO1/'))).toBe(false)
  return requests
}

for (const width of [1440, 320]) test.describe(`two expansion cohorts at ${width}px`, () => {
  test.use({ viewport: { width, height: 960 }, isMobile: width === 320, hasTouch: width === 320 })
  test('literal new companies survive region/role search, save, source switching, import and an owned restart', async ({ page, browser, baseURL }, info) => {
    test.setTimeout(180_000)
    const server = await fixture(page, info, baseURL)
    let destination: BrowserContext | undefined
    try {
      await server.start()
      await server.verifyProductionBytes()
      const state = await seedSurvey(page, server.origin, { clock: SOURCE_EXPANSION_NOW, selectedId: 'amsterdam', query: 'Booking.com' })
      const catalog = await fullCatalog(page, server.origin)
      const originalCache = await readFile(server.defaultCache, 'utf8')
      const cache = JSON.parse(originalCache)
      for (const previous of sourceExpansionOld93Cache().boards) {
        const retained = cache.boards.find((board: { companyId: string }) => board.companyId === previous.companyId)
        expect(retained).toMatchObject({ checkedAt: previous.checkedAt, retryAt: previous.retryAt, failures: previous.failures,
          snapshot: { fetchedAt: previous.snapshot.fetchedAt, total: previous.snapshot.total, publishedIds: previous.snapshot.publishedIds } })
        expect(retained.snapshot.jobs.map((job: SavedJob['job']) => [job.id, job.title, job.url, job.description, job.fetchedAt, job.updatedAt]))
          .toEqual(previous.snapshot.jobs.map(job => [job.id, job.title, job.url, job.description, job.fetchedAt, job.updatedAt]))
      }
      await surveyDataButton(page).click()
      const data = page.getByRole('dialog')
      await expect(data.locator('.coverage-stats strong')).toHaveText(['22', '124', '36'])
      await expect(data.getByRole('list', { name: '공개 공고 출처' }).locator('li')).toHaveText([
        'Greenhouse65개 회사', 'Ashby27개 회사', 'Lever9개 회사', 'SmartRecruiters10개 회사',
        'Workable3개 회사', 'Himalayas7개 회사', '공식 채용 사이트3개 회사',
      ])
      await expect(data.getByText('Booking.com 게시판에는 Booking Holdings의 공고도 포함됩니다.', { exact: true })).toBeVisible()
      await expect(data.getByText('Starbucks는 공식 Technology 분류의 공고를 수집합니다. 매장 등 다른 분류의 전체 채용 수가 아니며, 분류 이동으로 목록에서 빠질 수도 있어 채용 마감을 단정하지 않아요.', { exact: true })).toBeVisible()
      await expect(data.getByText('공식 사이트의 부하를 줄이기 위해 정상 조회 후 24시간 동안 자료를 재사용합니다. 목록 확인과 본문 수집에 각각 적용하며, 새로고침도 같은 대기 시간을 지켜요.', { exact: true })).toBeVisible()
      await surveyBoardHistory(page)
      await expect(data.locator('.board-row')).toHaveCount(124)
      for (const company of SOURCE_EXPANSION_REGISTRATIONS) {
        const row = data.locator('.board-row').filter({ has: page.getByText(company.name, { exact: true }) })
        await expect(row.getByRole('link', { name: `${company.name} 채용 페이지`, exact: true })).toHaveAttribute('href', company.careerUrl)
      }
      await surveyClose(page, surveyDataButton(page))

      await surveyRole(page, 'backend', 1)
      await page.locator('.region-tabs[aria-label="탐색 지역"]').getByRole('button', { name: '유럽', exact: true }).click()
      await page.getByRole('button', { name: '암스테르담, 추천 회사 1곳 보기', exact: true }).click()
      await expect(page.locator('.company-card h3')).toHaveText('Booking.com / Booking Holdings')
      const booking = page.getByRole('button', { name: bookingTitle, exact: true })
      await booking.click()
      await expect(page.getByRole('dialog').getByRole('link', { name: '원문에서 지원하기', exact: true })).toHaveAttribute('href', bookingUrl)
      await saveWithNote(page, 'Synthetic regional Booking note64', true)
      await surveyClose(page, booking)

      await surveySearch(page).fill('Zalando')
      await page.getByRole('button', { name: '모든 도시', exact: true }).click()
      await page.getByRole('button', { name: '베를린, 추천 회사 1곳 보기', exact: true }).click()
      await expect(page.locator('.mini-job-title')).toHaveText('Backend Engineer — Synthetic Cedar Fashion64')
      const zalando = page.getByRole('button', { name: 'Backend Engineer — Synthetic Cedar Fashion64', exact: true })
      await zalando.click()
      await expect(page.getByRole('dialog').getByRole('link', { name: '원문에서 지원하기', exact: true }))
        .toHaveAttribute('href', 'https://jobs.zalando.com/en/jobs/640001')
      await surveyClose(page, zalando)

      await surveySearch(page).fill('IKEA')
      await surveyRole(page, 'unknown', 1)
      await expect(page.locator('.company-card h3')).toHaveText('IKEA (Inter IKEA Group)')
      await expect(page.locator('.mini-job-title')).toHaveText('Design Engineer')
      const design = page.getByRole('button', { name: 'Design Engineer', exact: true })
      await design.click()
      await expect(page.getByRole('dialog')).toContainText(SOFTWARE_DESIGN_BODY.split('\n')[1])
      await surveyClose(page, design)
      await surveySearch(page).fill('AUTO1')
      await surveyRole(page, 'backend', 1)
      await expect(page.locator('.company-card h3')).toHaveText('AUTO1 Group')
      await expect(page.locator('.mini-job-title')).toHaveText('Backend Engineer — Synthetic AUTO1 Group Service64')

      await surveySearch(page).fill('Starbucks')
      await page.getByRole('button', { name: '모든 도시', exact: true }).click()
      await page.locator('.region-tabs[aria-label="탐색 지역"]').getByRole('button', { name: '미주', exact: true }).click()
      await page.getByRole('button', { name: '시애틀, 추천 회사 1곳 보기', exact: true }).click()
      await expect(page.locator('.company-card h3')).toHaveText('Starbucks')
      await expect(page.locator('.mini-job-title')).toHaveText(starbucksTitle)
      await technologyCredit(page.locator('.company-card'))
      const starbucks = page.getByRole('button', { name: starbucksTitle, exact: true })
      await starbucks.click()
      const detail = page.getByRole('dialog')
      await technologyCredit(detail)
      await expect(detail.locator('.job-source-credit')).toContainText('목록에서 빠졌더라도 분류 이동일 수 있으므로 채용 마감을 단정하지 않아요.')
      await expect(detail.locator('.job-source-credit')).toContainText('정상 조회 후 24시간 동안 자료를 재사용합니다.')
      await expect(detail.getByRole('link', { name: '원문에서 지원하기', exact: true })).toHaveAttribute('href', starbucksUrl)
      await saveWithNote(page, SOURCE_EXPANSION_NOTE, true)
      await surveyImage(page, info, `starbucks-detail-${width}`)
      await surveyClose(page, starbucks)
      await surveyDataButton(page).click()
      await sourceChoice(page, 'sample').click()
      await expect(data.locator('.coverage-stats strong')).toHaveText(['22', '32', '179'])
      await sourceChoice(page, 'public').click()
      await expect(data.locator('.coverage-stats strong')).toHaveText(['22', '124', '36'])
      await surveyClose(page, surveyDataButton(page))
      await expect(page.locator('.mini-job-title')).toHaveText(starbucksTitle)
      await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('orbit.v1.exploration') ?? '{}')))
        .toMatchObject({ source: 'public', selectedId: 'seattle', filters: { query: 'Starbucks', role: 'backend', region: 'americas' } })

      await surveyNavigation(page).getByRole('button', { name: /^저장한 기회/ }).click()
      const saved = await readSaved(page)
      savedFacts(saved)
      await technologyCredit(savedStarbucks(page))
      await expect(savedStarbucks(page).locator('.posting-notice')).toContainText('Starbucks Technology 분류의 목록 기준입니다.')
      const csv = await downloadText(page, 'CSV 내보내기')
      const rows = csvRows(csv)
      expect(rows).toHaveLength(3)
      for (const [name, url] of [['Booking.com / Booking Holdings', bookingUrl], ['Starbucks', starbucksUrl]]) {
        const row = rows.find(row => row[0] === name)!
        expect([row[3], row[4], row[7]]).toEqual(['공식 채용 사이트', '지원 완료', url])
      }
      await page.getByRole('button', { name: '기록 백업·복원', exact: true }).click()
      const backup = await downloadText(page, 'JSON 백업')
      expect(JSON.parse(backup).records).toEqual(saved)
      await writeFile(info.outputPath('source-expansion-export.csv'), csv)
      await writeFile(info.outputPath('source-expansion-backup.json'), backup)

      destination = await browser.newContext({ viewport: { width, height: 960 }, isMobile: width === 320, hasTouch: width === 320 })
      const target = await destination.newPage()
      const imported = await seedSurvey(target, server.origin, { source: 'sample', hash: '#saved', clock: SOURCE_EXPANSION_NOW })
      await target.getByRole('button', { name: '기록 백업·복원', exact: true }).click()
      await target.getByLabel('백업 또는 복구 파일', { exact: true }).setInputFiles({ name: 'source64-backup.json', mimeType: 'application/json', buffer: Buffer.from(backup) })
      await expect(target.locator('.saved-import-row')).toHaveCount(2)
      const incoming = target.locator('.saved-import-row').filter({ hasText: starbucksTitle })
      await technologyCredit(incoming)
      await incoming.locator('.saved-import-differences > summary').click()
      await technologyCredit(incoming.locator('.saved-record-contents'))
      await surveyImage(target, info, `starbucks-import-${width}`)
      expect(await readSaved(target)).toEqual([])
      await target.getByRole('button', { name: '선택한 2개 가져오기', exact: true }).click()
      expect(await readSaved(target)).toEqual(saved)
      await target.keyboard.press('Escape')
      await page.goto('about:blank')
      await target.goto('about:blank')
      await server.stop()
      await server.start()
      await server.verifyProductionBytes()
      await target.goto(`${server.origin}/#saved`)
      expect(await readSaved(target)).toEqual(saved)
      await technologyCredit(savedStarbucks(target))
      await expect(savedStarbucks(target)).toContainText(SOURCE_EXPANSION_NOTE)
      expect(await readFile(server.defaultCache, 'utf8')).toBe(originalCache)
      const requests = await syntheticRequests(server)
      expect(requests.map(request => request.url).sort()).toEqual([...SOURCE_EXPANSION_ALL_FULL_URLS].sort())
      await writeFile(info.outputPath('source-expansion-result.json'), JSON.stringify({ catalog, saved, requests }, null, 2))
      expectSurveyPrivacy(state, server.origin)
      expectSurveyPrivacy(imported, server.origin)
    } finally { await destination?.close(); await page.close(); await server.stop() }
  })

  test('a long official description remains readable with the keyboard after expanding it', async ({ page, baseURL }, info) => {
    if (!baseURL || new URL(baseURL).port === '8787') throw new Error('Owned non8787 base URL required')
    const description = [
      'Responsibilities',
      ...Array.from({ length: 70 }, (_, index) => `Synthetic responsibility ${index + 1}: build backend software for a fictional coffee inventory service and review automated API tests.`),
      'Requirements',
      'Experience with TypeScript and PostgreSQL. End of the complete synthetic description64.',
    ].join('\n')
    const job = {
      ...careersCachedJob(), id: 'careers-starbucks-644001', companyId: 'starbucks',
      title: 'Backend Engineer — Synthetic Long Coffee Description64', description,
      cityIds: ['seattle'], locationLabel: 'Seattle, Washington, United States',
      url: 'https://apply.starbucks.com/careers/job/644001',
    }
    const catalog: Catalog = {
      ...searchCatalog([job]), fetchedAt: CAREERS_NOW, companies: [careersCompany('starbucks')],
      boards: [{
        companyId: 'starbucks', provider: 'careers', board: 'starbucks-technology',
        status: 'ok', dataStatus: 'fresh', checkedAt: CAREERS_NOW, lastSuccessAt: CAREERS_NOW, retryAt: null, total: 1, included: 1,
      }],
    }
    await page.route('**/api/catalog?source=public*', route => route.fulfill({ json: catalog }))
    const state = await seedSurvey(page, baseURL, { selectedId: 'seattle', query: 'Starbucks', clock: CAREERS_NOW })
    await page.getByRole('button', { name: job.title, exact: true }).click()
    const detail = page.getByRole('dialog')
    await technologyCredit(detail)
    const summary = detail.locator('.original-description > summary')
    await summary.focus()
    await page.keyboard.press('Enter')
    await expect(detail.locator('.original-description')).toHaveAttribute('open', '')
    const body = detail.getByRole('region', { name: '채용공고 원문', exact: true })
    expect(await body.textContent()).toBe(description)
    await page.keyboard.press('Tab')
    await expect(body).toBeFocused()
    await page.keyboard.press('PageDown')
    await expect.poll(() => body.evaluate(element => element.scrollTop)).toBeGreaterThan(0)
    await surveyImage(page, info, `long-official-description-${width}`)
    expectSurveyPrivacy(state, baseURL)
  })
})

test('truncated daily lists cannot close saved careers jobs, and Technology-scope removal stays distinct from closure after restart', async ({ page, baseURL }, info) => {
  test.setTimeout(210_000)
  const server = await fixture(page, info, baseURL)
  try {
    await server.start()
    await server.verifyProductionBytes()
    const state = await seedSurvey(page, server.origin, { clock: SOURCE_EXPANSION_NOW, selectedId: 'seattle', query: 'Starbucks' })
    await fullCatalog(page, server.origin)
    const opener = page.getByRole('button', { name: starbucksTitle, exact: true })
    await opener.click()
    await saveWithNote(page, SOURCE_EXPANSION_NOTE, true)
    await surveyClose(page, opener)
    await surveyNavigation(page).getByRole('button', { name: /^저장한 기회/ }).click()
    const saved = await readSaved(page)
    expect(saved).toHaveLength(1)
    const originalCache = await readFile(server.defaultCache, 'utf8')
    await server.respond({ ...sourceExpansionResponses(), ...bookingResponses('empty-final'), ...zalandoResponses('empty-final'), ...starbucksResponses('empty-final') })
    await server.advance(86_402_000)
    await page.clock.fastForward(86_402_000)
    const failed = await statusAction(page, false)
    expect(failed.boards.filter(board => board.provider === 'careers').map(board => [board.companyId, board.status]))
      .toEqual([['booking', 'error'], ['zalando', 'error'], ['starbucks', 'error']])
    expect(failed.boards.filter(board => board.provider !== 'careers').every(board => board.status === 'ok')).toBe(true)
    expect(failed.boards.find(board => board.companyId === 'stripe')?.listing?.publishedIds).toEqual(['greenhouse-stripe-44001'])
    expect(failed.boards.find(board => board.companyId === 'notion')?.listing?.publishedIds).toEqual(['ashby-notion-synthetic-57102'])
    await expect(savedStarbucks(page).locator('.posting-notice-heading strong')).toHaveText('현재 상태 확인 필요')
    await expect(savedStarbucks(page).locator('.posting-notice')).toContainText('이전 목록으로 게시 종료를 판단하지 않습니다.')
    expect(await readSaved(page)).toEqual(saved)
    expect(await readFile(server.defaultCache, 'utf8')).toBe(originalCache)
    const firstRequests = await syntheticRequests(server)
    await page.goto('about:blank')
    await server.stop()
    await server.start()
    await server.verifyProductionBytes()
    await page.goto(`${server.origin}/#saved`)
    await expect(savedStarbucks(page).locator('.posting-notice-heading strong')).toHaveText('아직 확인하지 않음')
    expect(await syntheticRequests(server)).toHaveLength(firstRequests.length)
    const restoredFailure = await statusAction(page, false)
    expect(restoredFailure.boards.filter(board => board.provider === 'careers').map(board => [board.companyId, board.status]))
      .toEqual([['booking', 'error'], ['zalando', 'error'], ['starbucks', 'error']])
    await expect(savedStarbucks(page).locator('.posting-notice-heading strong')).toHaveText('현재 상태 확인 필요')
    expect(await readSaved(page)).toEqual(saved)
    expect(await syntheticRequests(server)).toHaveLength(firstRequests.length)

    const recovered = sourceExpansionResponses()
    recovered[STARBUCKS_LIST_URLS[0]] = { data: { count: 0, positions: [], appliedFilters: { jobCategory: ['technology'] } } }
    await server.respond(recovered)
    // The real first-failure backoff includes up to20% jitter. The earlier
    // restart proves that a pre-deadline query cannot make another request.
    await server.advance(90_000)
    await page.clock.fastForward(90_000)
    const current = await statusAction(page, false, '새로 확인')
    expect(current.boards.find(board => board.companyId === 'starbucks')).toMatchObject({ status: 'ok', listing: { publishedIds: [], jobs: [] } })
    await expect(savedStarbucks(page).locator('.posting-notice-heading strong')).toHaveText('공개 목록에서 미확인')
    await expect(savedStarbucks(page).locator('.posting-notice')).toContainText('분류 이동으로 목록에서 빠질 수도 있으므로 채용 마감을 단정하지 않아요.')
    await technologyCredit(savedStarbucks(page))
    expect(await readSaved(page)).toEqual(saved)
    expect(await readFile(server.defaultCache, 'utf8')).toBe(originalCache)
    const beforeReloadRequests = await syntheticRequests(server)
    await page.reload()
    await expect(savedStarbucks(page).locator('.posting-notice-heading strong')).toHaveText('아직 확인하지 않음')
    expect(await syntheticRequests(server)).toHaveLength(beforeReloadRequests.length)
    await statusAction(page, false)
    await expect(savedStarbucks(page).locator('.posting-notice-heading strong')).toHaveText('공개 목록에서 미확인')
    expect(await readSaved(page)).toEqual(saved)
    const requests = await syntheticRequests(server)
    expect(requests).toHaveLength(beforeReloadRequests.length)
    expect(requests.filter(request => request.url.startsWith('https://apply.starbucks.com/careers/job/'))).toHaveLength(3)
    await surveyImage(page, info, 'starbucks-classification-removal')
    await writeFile(info.outputPath('source-expansion-failure-restart.json'), JSON.stringify({ failed, current, saved, requests }, null, 2))
    expectSurveyPrivacy(state, server.origin)
  } finally { await page.close(); await server.stop() }
})
