import { expect, test } from '@playwright/test'
import type { BrowserContext, Page } from '@playwright/test'
import { readFile, writeFile } from 'node:fs/promises'
import type { Catalog, SavedJob } from '../../shared/types'
import type { ObservationHistory } from '../../shared/catalog-observations'
import { SURVEY_JOBS, SURVEY_REGISTRATIONS } from '../fixtures/public-company-survey'
import {
  HIMALAYAS_CHANGED_TITLE, INTEGRATION_FULL_URLS,
  INTEGRATION_NOTE, INTEGRATION_NOW, WORKABLE_CAREER_URLS,
} from '../fixtures/source-integration-contract'
import { integrationOld83Cache, integrationOldSaved, integrationResponses } from '../fixtures/source-integrations'
import {
  expectSurveyPrivacy, seedSurvey, surveyBoardHistory, surveyClose, surveyDataButton,
  surveyImage, surveyJson, surveyNavigation, surveyRole, surveySearch,
} from './helpers/public-company-survey'
import { readSaved } from './helpers/saved-store'
import { sourceChoice } from './helpers/source-choice'
import {
  assertSynthetic, catalog93, csvRows, downloadText, integrationServer,
  saveWithNote, sourceCredit, statusAction,
} from './helpers/source-integrations'

const microsoftUrl = 'https://himalayas.app/companies/microsoft/jobs/synthetic-cedar-api63'
const microsoftId = 'himalayas-microsoft-70eecd3ec601cdc5f4ecb1750bf585e529f95296f170a59abec71bc88be82cdf'
const microsoftTitle = 'Backend Engineer — Synthetic Cedar API63'
const smartNewsTitle = 'Backend Engineer — Synthetic Birch News63'
const microsoftSaved = (page: Page) => page.locator('.saved-card').filter({
  has: page.getByRole('button', { name: microsoftTitle, exact: true }),
})

async function openRemote(page: Page, query: string) {
  await surveySearch(page).fill(query)
  await page.locator('.results-tabs').getByRole('button', { name: /^원격 기회/ }).click()
}

function expectSavedMicrosoft(records: SavedJob[]) {
  expect(records.find(record => record.job.id === microsoftId)).toMatchObject({
    company: { id: 'microsoft', name: 'Microsoft', provider: 'himalayas', board: 'microsoft' },
    job: { id: microsoftId, source: 'himalayas', title: microsoftTitle, url: microsoftUrl,
      locationLabel: 'South Korea · Remote · 시간대 조건 확인', cityIds: [], workMode: 'remote' },
    status: 'applied', note: INTEGRATION_NOTE,
  })
}

for (const width of [1440, 320]) test.describe(`independent source integrations at ${width}px`, () => {
  test.use({ viewport: { width, height: 960 }, isMobile: width === 320, hasTouch: width === 320 })

  test('ten new feeds retain literal search/filter facts and source credit through save, CSV, JSON import and restart', async ({ page, browser, baseURL }, info) => {
    test.setTimeout(150_000)
    const server = await integrationServer(page, info, baseURL)
    let destination: BrowserContext | undefined
    try {
      await server.start()
      await server.verifyProductionBytes()
      const state = await seedSurvey(page, server.origin, { selectedId: null, clock: INTEGRATION_NOW })
      const catalog = await catalog93(page, server.origin, 75)
      const oldJobs = catalog.jobs.filter(job => SURVEY_REGISTRATIONS.some(company => company.id === job.companyId)
        && job.id !== 'greenhouse-xai-61901')
      const facts = (job: { id: string; title: string; url: string }) => ({ id: job.id, title: job.title, url: job.url })
      expect(oldJobs.map(facts)).toEqual(SURVEY_JOBS.map(facts))
      expect(catalog.boards.reduce((count, board) => count + board.total, 0)).toBe(80)
      await expect(page.locator('.catalog-source-credit').getByRole('link', { name: 'Himalayas', exact: true }))
        .toHaveAttribute('href', 'https://himalayas.app')
      await expect(page.locator('.catalog-source-credit')).toHaveText('원격 공고 출처: Himalayas · 회사 공식 게시판과 수집 범위가 다릅니다.')
      await surveyDataButton(page).click()
      const data = page.getByRole('dialog')
      await expect(data.locator('.coverage-stats strong')).toHaveText(['22', '93', '75'])
      await expect(data.getByRole('list', { name: '공개 공고 출처' }).locator('li')).toHaveText([
        'Greenhouse50개 회사', 'Ashby24개 회사', 'Lever4개 회사', 'SmartRecruiters5개 회사',
        'Workable3개 회사', 'Himalayas7개 회사',
      ])
      await expect(data.getByText('Himalayas는 하루 단위로 갱신됩니다. 정상 조회 후 24시간 동안 자료를 재사용하며 새로고침도 같은 대기 시간을 따릅니다. 거주 국가·시간대 조건을 회사의 오피스 위치로 표시하지 않습니다.', { exact: true })).toBeVisible()
      await surveyBoardHistory(page)
      await expect(data.locator('.board-row')).toHaveCount(93)
      for (const [name, id] of [['Hugging Face', 'hugging-face'], ['SmartNews', 'smartnews'], ['Mercari', 'mercari']] as const) {
        const row = data.locator('.board-row').filter({ has: page.getByText(name, { exact: true }) })
        await expect(row.getByRole('link', { name: `${name} 채용 페이지`, exact: true })).toHaveAttribute('href', WORKABLE_CAREER_URLS[id])
      }
      await sourceChoice(page, 'sample').click()
      await expect(data.locator('.coverage-stats strong')).toHaveText(['22', '32', '179'])
      await sourceChoice(page, 'public').click()
      await expect(data.locator('.coverage-stats strong')).toHaveText(['22', '93', '75'])
      await surveyClose(page, surveyDataButton(page))

      await openRemote(page, 'Microsoft')
      await surveyRole(page, 'backend', 1)
      await expect(page.locator('.company-card h3')).toHaveText('Microsoft')
      await expect(page.locator('.mini-job-title')).toHaveText(microsoftTitle)
      await sourceCredit(page.locator('.company-card'), microsoftUrl)
      await page.locator('.company-card').scrollIntoViewIfNeeded()
      await surveyImage(page, info, `microsoft-source-card-${width}`)
      const opener = page.getByRole('button', { name: microsoftTitle, exact: true })
      await opener.click()
      const detail = page.getByRole('dialog', { name: 'Microsoft', exact: true })
      await sourceCredit(detail, microsoftUrl)
      await expect(detail.locator('.job-detail-heading p')).toHaveText('South Korea · Remote · 시간대 조건 확인')
      await expect(detail.getByRole('link', { name: 'Himalayas 공고 보기', exact: true })).toHaveAttribute('href', microsoftUrl)
      await expect(detail.locator('.job-source-credit')).toContainText('회사의 전체 공식 공고와 범위가 다르며')
      await expect(detail.locator('.job-source-credit')).toContainText('정상 조회 후 24시간 동안 같은 자료를 사용합니다.')
      await saveWithNote(page, INTEGRATION_NOTE, true)
      await surveyClose(page, opener)

      await surveySearch(page).fill('Adobe')
      await expect(page.locator('.mini-job-title')).toHaveCount(0)
      // The inherited KR profile starts with residence-only enabled. Make the
      // unknown-country preview explicit before the original frontend1 check.
      await page.getByRole('button', { name: /^모든 필터/ }).click()
      const eligibleOnly = page.getByRole('checkbox', { name: /거주 국가가 포함된 원격근무만/ })
      await expect(eligibleOnly).toBeChecked()
      await eligibleOnly.uncheck()
      await page.getByRole('button', { name: '0개 공고 보기', exact: true }).click()
      await surveyRole(page, 'frontend', 1)
      await expect(page.locator('.mini-job-title')).toHaveText('Frontend Engineer — Synthetic Iris Editor63')
      await page.getByRole('button', { name: /^모든 필터/ }).click()
      await page.getByRole('checkbox', { name: /거주 국가가 포함된 원격근무만/ }).check()
      await page.getByRole('button', { name: '0개 공고 보기', exact: true }).click()
      await expect(page.locator('.mini-job-title')).toHaveCount(0)
      await page.getByRole('button', { name: /^모든 필터/ }).click()
      await page.getByRole('checkbox', { name: /거주 국가가 포함된 원격근무만/ }).uncheck()
      await page.getByRole('button', { name: '1개 공고 보기', exact: true }).click()
      const adobe = page.getByRole('button', { name: 'Frontend Engineer — Synthetic Iris Editor63', exact: true })
      await adobe.click()
      await expect(page.getByRole('dialog').locator('.job-detail-heading p')).toHaveText('거주 국가 미확인 · Remote · 시간대 조건 확인')
      await sourceCredit(page.getByRole('dialog'), 'https://himalayas.app/companies/adobe/jobs/synthetic-iris-editor63')
      await surveyClose(page, adobe)

      await surveySearch(page).fill('SmartNews')
      await surveyRole(page, 'all', 1)
      await page.locator('.results-tabs').getByRole('button', { name: /^기타 근무지/ }).click()
      await expect(page.locator('.company-card h3')).toHaveText('SmartNews')
      const smart = page.getByRole('button', { name: smartNewsTitle, exact: true })
      await smart.click()
      await expect(page.getByRole('dialog').locator('.job-detail-heading p')).toHaveText('근무지 미확인')
      await expect(page.getByRole('dialog')).not.toContainText('New York')
      await expect(page.getByRole('dialog')).not.toContainText('Tokyo')
      await expect(page.getByRole('dialog').locator('.job-meta-pills')).toContainText('근무 형태 미확인')
      await saveWithNote(page, 'SmartNews 원문 위치 확인63')
      await surveyClose(page, smart)
      await surveySearch(page).fill('Mercari')
      await page.locator('.results-tabs').getByRole('button', { name: /^도시 탐색/ }).click()
      await page.getByRole('button', { name: '도쿄, 추천 회사 1곳 보기', exact: true }).click()
      await expect(page.locator('.mini-job-title')).toHaveText('Backend Engineer — Synthetic Elm Market63')
      await expect(page.locator('.mini-job-meta')).toContainText('근무 형태 미확인')

      await surveyNavigation(page).getByRole('button', { name: /^저장한 기회/ }).click()
      const saved = await readSaved(page)
      expect(saved).toHaveLength(2)
      expectSavedMicrosoft(saved)
      await sourceCredit(microsoftSaved(page), microsoftUrl)
      const csv = await downloadText(page, 'CSV 내보내기')
      const rows = csvRows(csv)
      expect(rows).toHaveLength(3)
      expect(rows.every(row => row.length === 48)).toBe(true)
      expect(rows[0].slice(0, 8)).toEqual(['회사', '포지션', '근무지', '데이터', '상태', '저장일', '메모', '채용 링크'])
      const microsoft = rows.find(row => row[0] === 'Microsoft')!
      expect(microsoft[3]).toBe('Himalayas · https://himalayas.app')
      expect(microsoft[4]).toBe('지원 완료')
      expect(microsoft[6]).toBe(INTEGRATION_NOTE)
      expect(microsoft[7]).toBe(microsoftUrl)
      const smartRow = rows.find(row => row[0] === 'SmartNews')!
      expect([smartRow[2], smartRow[3], smartRow[7]]).toEqual([
        '근무지 미확인', 'Workable', 'https://apply.workable.com/j/SN63HIDDEN/',
      ])
      expect(csv).not.toContain('New York')
      expect(csv).not.toContain('Tokyo')
      await page.getByRole('button', { name: '기록 백업·복원', exact: true }).click()
      const backup = await downloadText(page, 'JSON 백업')
      expect(JSON.parse(backup).records).toEqual(saved)
      await writeFile(info.outputPath('source-export.csv'), csv)
      await writeFile(info.outputPath('source-backup.json'), backup)

      destination = await browser.newContext({ viewport: { width, height: 960 }, isMobile: width === 320, hasTouch: width === 320 })
      const target = await destination.newPage()
      const importedState = await seedSurvey(target, server.origin, { source: 'sample', hash: '#saved', clock: INTEGRATION_NOW })
      await target.getByRole('button', { name: '기록 백업·복원', exact: true }).click()
      await target.getByLabel('백업 또는 복구 파일', { exact: true }).setInputFiles({
        name: 'source63-backup.json', mimeType: 'application/json', buffer: Buffer.from(backup),
      })
      await expect(target.locator('.saved-import-row')).toHaveCount(2)
      const incoming = target.locator('.saved-import-row').filter({ hasText: microsoftTitle })
      await sourceCredit(incoming, microsoftUrl)
      await incoming.locator('.saved-import-differences > summary').click()
      await sourceCredit(incoming.locator('.saved-record-contents'), microsoftUrl)
      await incoming.scrollIntoViewIfNeeded()
      await surveyImage(target, info, `himalayas-import-credit-${width}`)
      expect(await readSaved(target)).toEqual([])
      await target.getByRole('button', { name: '선택한 2개 가져오기', exact: true }).click()
      expect(await readSaved(target)).toEqual(saved)
      await target.keyboard.press('Escape')
      await page.goto('about:blank')
      await target.goto('about:blank')
      const cacheBytes = await readFile(server.defaultCache, 'utf8')
      await server.stop()
      await server.start()
      await server.verifyProductionBytes()
      await target.goto(`${server.origin}/#saved`)
      expect(await readSaved(target)).toEqual(saved)
      await sourceCredit(microsoftSaved(target), microsoftUrl)
      await microsoftSaved(target).scrollIntoViewIfNeeded()
      await surveyImage(target, info, `himalayas-restored-note-${width}`)
      expect(await readFile(server.defaultCache, 'utf8')).toBe(cacheBytes)
      await assertSynthetic(server, 96)
      expectSurveyPrivacy(state, server.origin)
      expectSurveyPrivacy(importedState, server.origin)
    } finally { await destination?.close(); await page.close(); await server.stop() }
  })

  test('old83 cache adds only ten boards and a daily list never renews saved body evidence before a due body check and restart', async ({ page, baseURL }, info) => {
    test.setTimeout(150_000)
    const old = integrationOld83Cache()
    expect(old.boards).toHaveLength(83)
    const server = await integrationServer(page, info, baseURL, { cacheSeed: old })
    try {
      await server.start()
      await server.verifyProductionBytes()
      const state = await seedSurvey(page, server.origin, { saved: integrationOldSaved(), selectedId: null, clock: INTEGRATION_NOW })
      await catalog93(page, server.origin, 12)
      const firstRequests = await assertSynthetic(server, 11)
      expect(firstRequests.map(request => request.url).sort()).toEqual([...INTEGRATION_FULL_URLS].sort())
      const before = await readFile(server.defaultCache, 'utf8')
      const cache = JSON.parse(before)
      expect(cache.boards).toHaveLength(93)
      for (const previous of old.boards) expect(cache.boards.find((board: { companyId: string }) => board.companyId === previous.companyId))
        .toMatchObject({ checkedAt: '2026-10-01T23:39:55.000Z', snapshot: {
          fetchedAt: '2026-10-01T23:39:55.000Z', total: previous.snapshot.total,
          jobs: previous.snapshot.jobs.map(job => expect.objectContaining({ id: job.id, url: job.url, fetchedAt: job.fetchedAt })),
        } })
      await openRemote(page, 'Microsoft')
      const opener = page.getByRole('button', { name: microsoftTitle, exact: true })
      await opener.click()
      await sourceCredit(page.getByRole('dialog'), microsoftUrl)
      await saveWithNote(page, INTEGRATION_NOTE, true)
      await surveyClose(page, opener)
      await surveyNavigation(page).getByRole('button', { name: /^저장한 기회/ }).click()
      const saved = await readSaved(page)
      expect(saved).toHaveLength(2)
      expectSavedMicrosoft(saved)
      const originalBodyAt = saved.find(record => record.job.id === microsoftId)!.job.fetchedAt
      const oldSaved = saved.find(record => record.job.id === 'ashby-notion-synthetic-57102')!
      expect(oldSaved.job.fetchedAt).toBe('2026-10-01T23:39:55.000Z')

      await server.respond(integrationResponses({ microsoft: 'presence-invalid-body' }))
      await server.advance(86_402_000)
      await page.clock.fastForward(86_402_000)
      const listed = await statusAction(page, false)
      const microsoft = listed.boards.find(board => board.companyId === 'microsoft')!
      expect(microsoft.listing!.jobs).toEqual([])
      expect(microsoft.listing!.content!.checkedAt).toBe(originalBodyAt)
      expect(Date.parse(microsoft.listing!.content!.validUntil) - Date.parse(originalBodyAt)).toBe(86_400_000)
      await expect(microsoftSaved(page).locator('.posting-notice')).toContainText('Himalayas의 게시 목록 기준입니다.')
      await expect(microsoftSaved(page).locator('.posting-current-title')).toHaveCount(0)
      expect(await readFile(server.defaultCache, 'utf8')).toBe(before)
      expect(await readSaved(page)).toEqual(saved)
      await assertSynthetic(server, 105)

      await server.respond(integrationResponses({ microsoft: 'changed-body' }))
      const content = await statusAction(page, true)
      const current = content.boards.find(board => board.companyId === 'microsoft')!.listing!
      expect(current.jobs[0]).toMatchObject({ id: microsoftId, title: HIMALAYAS_CHANGED_TITLE, url: microsoftUrl })
      await expect(microsoftSaved(page).locator('.posting-current-title')).toHaveText(`현재 포지션: ${HIMALAYAS_CHANGED_TITLE}`)
      await expect(microsoftSaved(page).locator('.posting-changes')).toHaveText('포지션 · 본문 확인 필요')
      expect(await readSaved(page)).toEqual(saved)
      await page.getByRole('textbox', { name: '저장한 기회 검색', exact: true }).fill('Stage63')
      await page.getByRole('combobox', { name: '게시 상태', exact: true }).selectOption('changed')
      await expect(page.locator('.saved-card')).toHaveCount(1)
      await sourceCredit(microsoftSaved(page), microsoftUrl)
      await microsoftSaved(page).scrollIntoViewIfNeeded()
      await surveyImage(page, info, `daily-list-body-saved-${width}`)
      const currentBytes = await readFile(server.defaultCache, 'utf8')
      await page.goto('about:blank')
      await server.stop()
      await server.start()
      await server.verifyProductionBytes()
      await page.goto(`${server.origin}/#saved`)
      expect(await readSaved(page)).toEqual(saved)
      expect((await readSaved(page)).find(record => record.job.id === oldSaved.job.id)).toEqual(oldSaved)
      expect(await readFile(server.defaultCache, 'utf8')).toBe(currentBytes)
      await assertSynthetic(server, 201)
      expectSurveyPrivacy(state, server.origin)
      await writeFile(info.outputPath('list-body-evidence.json'), JSON.stringify({ listed, content, originalBodyAt, saved }, null, 2))
    } finally { await page.close(); await server.stop() }
  })
})

test('daily source remains browse-fresh while a new UTC day cannot claim a comparable30-minute observation', async ({ page, baseURL }, info) => {
  test.setTimeout(120_000)
  await page.setViewportSize({ width: 1440, height: 960 })
  const server = await integrationServer(page, info, baseURL)
  try {
    await server.start()
    await server.verifyProductionBytes()
    const state = await seedSurvey(page, server.origin, { selectedId: null, clock: INTEGRATION_NOW })
    await catalog93(page, server.origin, 75)
    const initial = await surveyJson<ObservationHistory>(page, server.origin, '/api/observations')
    expect(initial.days[0].complete).toMatchObject({
      comparable: true, stats: { published: 80, technical: 75, openings: 73, talentPools: 2 },
    })
    await surveyNavigation(page).getByRole('button', { name: /^저장한 기회/ }).click()
    await server.advance(31 * 60_000)
    await page.clock.fastForward(31 * 60_000)
    const current = await catalog93(page, server.origin, 75)
    expect(current.boards.filter(board => board.provider === 'himalayas').map(board => board.dataStatus)).toEqual([
      'fresh', 'fresh', 'fresh', 'fresh', 'fresh', 'fresh', 'fresh',
    ])
    const history = await surveyJson<ObservationHistory>(page, server.origin, '/api/observations')
    expect(history.days.map(day => day.day)).toEqual(['2026-10-01', '2026-10-02'])
    expect(history.days[1].complete).toBeUndefined()
    expect(history.days[1].latest.boards.filter(board => board.status === 'stale').map(board => board.companyId)).toEqual([
      'microsoft', 'adobe', 'salesforce', 'cisco', 'qualcomm', 'broadcom', 'redhat',
    ])
    expect(history.days[0].complete).toEqual(initial.days[0].complete)
    const requests = await assertSynthetic(server, 184)
    expect(requests.filter(request => request.url.startsWith('https://himalayas.app/'))).toHaveLength(8)
    await surveyNavigation(page).getByRole('button', { name: '기회 탐색', exact: true }).click()
    await surveyDataButton(page).click()
    const explanation = page.getByRole('dialog').locator('.data-explanation').filter({ hasText: 'Himalayas 공개 원격 공고' })
    await expect(explanation).toContainText('날짜별 공고 수 비교는 모든 회사의 수집 시각이 30분 안에 모인 기록에만 적용합니다.')
    await explanation.scrollIntoViewIfNeeded()
    await surveyImage(page, info, 'daily-source-observation-1440')
    await writeFile(info.outputPath('daily-observation.json'), JSON.stringify({ initial, history, current, requests }, null, 2))
    expectSurveyPrivacy(state, server.origin)
  } finally { await page.close(); await server.stop() }
})

test('real HTTP304 remains stable before each provider expiry and after an owned file-cache restart', async ({ page, baseURL }, info) => {
  test.setTimeout(120_000)
  await page.setViewportSize({ width: 1440, height: 960 })
  const server = await integrationServer(page, info, baseURL)
  try {
    await server.start()
    await server.verifyProductionBytes()
    // No page routing: exercise the real Chromium HTTP cache. The independent
    // launch configuration blocks external DNS and uses a fresh browser profile.
    const state = await seedSurvey(page, server.origin, { source: 'sample', hash: '#saved', route: false, clock: INTEGRATION_NOW })
    const fetchCatalog = () => page.evaluate(async () => {
      const response = await fetch('/api/catalog?source=public')
      return { status: response.status, catalog: await response.json() as Catalog }
    })
    const first = await fetchCatalog()
    expect(first.status).toBe(200)
    expect(first.catalog.jobs).toHaveLength(75)
    expect(await fetchCatalog()).toEqual(first)
    await server.advance(85_800_000)
    await page.clock.fastForward(85_800_000)
    const beforeDay = await fetchCatalog()
    expect(beforeDay.catalog.jobs.find(job => job.id === microsoftId)!.fetchedAt)
      .toBe(first.catalog.jobs.find(job => job.id === microsoftId)!.fetchedAt)
    expect(beforeDay.catalog.boards.find(board => board.companyId === 'microsoft')!.dataStatus).toBe('fresh')
    const bytes = await readFile(server.defaultCache, 'utf8')
    await server.advance(300_000)
    await page.clock.fastForward(300_000)
    expect(await fetchCatalog()).toEqual(beforeDay)
    expect(await readFile(server.defaultCache, 'utf8')).toBe(bytes)
    await page.goto('about:blank')
    await server.stop()
    await server.start()
    await server.verifyProductionBytes()
    await page.goto(`${server.origin}/#saved`)
    expect(await fetchCatalog()).toEqual(beforeDay)
    const wire = (await server.wireResponses()).filter(event => event.path === '/api/catalog?source=public')
    expect(wire.map(event => event.status)).toEqual([200, 304, 200, 304, 304])
    expect(wire[4]).toMatchObject({ ifNoneMatch: expect.any(String), cacheControl: 'private, no-cache, must-revalidate' })
    expect(await readFile(server.defaultCache, 'utf8')).toBe(bytes)
    const requests = await assertSynthetic(server, 184)
    expect(requests.filter(request => request.url.startsWith('https://himalayas.app/'))).toHaveLength(8)
    expectSurveyPrivacy(state, server.origin)
    await writeFile(info.outputPath('source-http-cache.json'), JSON.stringify({ first, beforeDay, wire, requests }, null, 2))
  } finally { await page.close(); await server.stop() }
})
