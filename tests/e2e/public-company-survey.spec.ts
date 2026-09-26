import { expect, test } from '@playwright/test'
import type { Page, TestInfo } from '@playwright/test'
import { readFile, writeFile } from 'node:fs/promises'
import type { Catalog, SavedJob } from '../../shared/types'
import type { ObservationHistory } from '../../shared/catalog-observations'
import type { PostingStatusIndex } from '../../shared/posting-status'
import { COVERAGE_PROFILE } from '../fixtures/public-coverage'
import { expansionLegacy36Cache, expansionResponses } from '../fixtures/public-company-expansion'
import {
  SURVEY_DETAIL_URLS, SURVEY_FULL_URLS, SURVEY_JOBS, SURVEY_NOTE, SURVEY_NOW, SURVEY_OLD_NOTE,
  SURVEY_OLD_SCOPE_KEY, SURVEY_REGISTRATIONS, SURVEY_SERVICE_BODY, SURVEY_SERVICE_CHANGED_BODY,
  SURVEY_SERVICE_CHANGED_TITLE, SURVEY_SERVICE_TITLE, surveyOldHistory, surveyOldSaved, surveyResponses,
} from '../fixtures/public-company-survey'
import { createPublicCoverageServer } from '../fixtures/public-coverage-server'
import { expectInitialCatalogRequest, readServerMode } from './helpers/api-requests'
import { readSaved } from './helpers/saved-store'
import { sourceChoice } from './helpers/source-choice'
import {
  expectSurveyPrivacy, seedSurvey, surveyClose, surveyDataButton, surveyImage, surveyJson,
  surveyNavigation, surveyRole, surveySearch,
} from './helpers/public-company-survey'

type Server = Awaited<ReturnType<typeof createPublicCoverageServer>>
const oldTime = '2026-09-26T09:59:55.000Z'
const providerNames = { greenhouse: 'Greenhouse', ashby: 'Ashby', lever: 'Lever', smartrecruiters: 'SmartRecruiters' }
const serviceCard = (page: Page) => page.locator('.saved-card').filter({
  has: page.getByRole('button', { name: SURVEY_SERVICE_TITLE, exact: true }),
})
const allFullUrls = [...Object.keys(expansionResponses()), ...Object.values(SURVEY_FULL_URLS), ...SURVEY_DETAIL_URLS]

async function fixture(page: Page, info: TestInfo, baseURL: string | undefined, options: Parameters<typeof createPublicCoverageServer>[2] = {}) {
  const configured = process.env.ORBIT_SURVEY_MODE
  if (configured && configured !== 'development' && configured !== 'production') throw new Error('Unknown survey server mode')
  const mode = configured === 'development' || configured === 'production'
    ? configured : await readServerMode(page.request, `${baseURL}/api/health`)
  return createPublicCoverageServer(info.outputPath('survey-server'), mode, {
    clock: SURVEY_NOW, responses: surveyResponses(), ...options,
  })
}

async function requestsAre(server: Server, count: number) {
  const requests = await server.requests()
  expect(requests).toHaveLength(count)
  expect(requests.every(request => request.synthetic && !request.networkSent && request.method === 'GET' && request.body === null)).toBe(true)
  await server.assertDefaultConfiguration()
  return requests
}

function expectRegistrations(catalog: Catalog, jobs: number) {
  expect(catalog.source).toBe('public')
  expect(catalog.companies).toHaveLength(83)
  expect(catalog.boards).toHaveLength(83)
  expect(catalog.jobs).toHaveLength(jobs)
  expect(catalog.companies.slice(36).map(({ id, name, careerUrl, provider, board }) =>
    ({ id, name, careerUrl, provider, board }))).toEqual(SURVEY_REGISTRATIONS)
}

async function observations(page: Page) {
  const panel = page.getByRole('dialog').locator('.observation-panel')
  await panel.locator('> summary').click()
  await expect(panel.locator('.observation-scope')).toHaveText('대상 83개 회사 · 최근 90일 이내 · UTC 날짜별 마지막 정상 집계')
  return panel
}

async function checkSaved(page: Page, content: boolean) {
  const pending = page.waitForResponse(response => {
    const url = new URL(response.url())
    return url.pathname === '/api/posting-status' && url.search === (content ? '?refresh=1&content=1' : '?refresh=1')
  })
  await page.getByRole('button', { name: content ? '공고 내용 확인' : '게시 상태 확인', exact: true }).click()
  const response = await pending
  expect(response.status()).toBe(200)
  return await response.json() as PostingStatusIndex
}

function expectSaved(records: SavedJob[]) {
  expect(records).toHaveLength(2)
  expect(records.find(record => record.job.id === 'ashby-notion-synthetic-57102')).toMatchObject({
    company: { id: 'notion', name: 'Notion', provider: 'ashby', board: 'notion' },
    job: {
      title: 'Backend Engineer — Synthetic Maple Index', source: 'ashby',
      url: 'https://example.com/synthetic/notion-57102', fetchedAt: oldTime,
    },
    status: 'applied', note: SURVEY_OLD_NOTE,
  })
  expect(records.find(record => record.job.id === 'smartrecruiters-servicenow-synthetic-61038')).toMatchObject({
    company: { id: 'servicenow', name: 'ServiceNow', provider: 'smartrecruiters', board: 'ServiceNow' },
    job: {
      id: 'smartrecruiters-servicenow-synthetic-61038', source: 'smartrecruiters',
      title: SURVEY_SERVICE_TITLE, description: SURVEY_SERVICE_BODY,
      locationLabel: 'Seoul, South Korea', cityIds: ['seoul'],
      url: 'https://example.com/synthetic/stage61/servicenow-61038',
    },
    status: 'applied', note: SURVEY_NOTE,
  })
}

for (const width of [1440, 320]) test.describe(`independent Stage61 survey at ${width}px`, () => {
  test.use({ viewport: { width, height: 960 }, isMobile: width === 320, hasTouch: width === 320 })

  test('all47 new sources have literal positive jobs and search, role, region and sample selection retain their context', async ({ page, baseURL }, info) => {
    test.setTimeout(120_000)
    const server = await fixture(page, info, baseURL)
    try {
      await server.start()
      await server.verifyProductionBytes()
      const state = await seedSurvey(page, server.origin)
      await expectInitialCatalogRequest(page, state.traffic)
      await expect(page.locator('.city-detail-count strong')).toHaveText(['56', '57'])
      const catalog = await surveyJson<Catalog>(page, server.origin, '/api/catalog?source=public')
      expectRegistrations(catalog, 65)
      const fields = (job: typeof catalog.jobs[number] | typeof SURVEY_JOBS[number]) => ({
        companyId: job.companyId, id: job.id, source: job.source, title: job.title,
        role: job.role, cityIds: job.cityIds, url: job.url,
      })
      expect(catalog.jobs.filter(job => SURVEY_REGISTRATIONS.some(company => company.id === job.companyId)
        && job.id !== 'greenhouse-xai-61901').map(fields)).toEqual(SURVEY_JOBS.map(fields))
      expect(catalog.jobs.filter(job => job.postingPurpose).map(job => job.id)).toEqual([
        'greenhouse-moloco-44102', 'greenhouse-xai-61901',
      ])
      for (const absent of ['greenhouse-xai-61902', 'ashby-cursor-synthetic-61903', 'smartrecruiters-servicenow-synthetic-61904'])
        expect(catalog.jobs.map(job => job.id)).not.toContain(absent)

      await surveyDataButton(page).click()
      const dialog = page.getByRole('dialog')
      await expect(dialog.locator('.coverage-stats strong')).toHaveText(['22', '83', '65'])
      await expect(dialog.getByRole('list', { name: '공개 공고 출처' }).locator('li')).toHaveText([
        'Greenhouse50개 회사', 'Ashby24개 회사', 'Lever4개 회사', 'SmartRecruiters5개 회사',
      ])
      await expect(dialog.locator('.posting-purpose-count')).toHaveText('조회된 개발 공고에 인재풀·관심 등록 2개가 포함되어 있어요. 기본 추천에서는 제외하며 모집 유형 필터로 따로 볼 수 있어요.')
      await dialog.locator('.board-details > summary').click()
      await expect(dialog.locator('.board-row')).toHaveCount(83)
      for (const company of SURVEY_REGISTRATIONS) {
        const row = dialog.locator('.board-row').filter({ has: page.getByText(company.name, { exact: true }) })
        await expect(row).toHaveCount(1)
        await expect(row.locator('.board-name small')).toHaveText(providerNames[company.provider])
        await expect(row.getByRole('link', { name: `${company.name} 채용 페이지`, exact: true })).toHaveAttribute('href', company.careerUrl)
      }
      const xai = dialog.locator('.board-row').filter({ has: page.getByText('xAI (SpaceXAI)', { exact: true }) })
      await xai.scrollIntoViewIfNeeded()
      await expect(xai.locator('.board-name')).toBeInViewport()
      await surveyImage(page, info, `83-source-xai-${width}`)
      await surveyClose(page, surveyDataButton(page))

      await surveyRole(page, 'backend', 59)
      await expect(page.locator('.city-detail-count strong')).toHaveText(['55', '55'])
      for (const [query, company, title] of [
        ['Automattic', 'Automattic', 'Backend Engineer — Synthetic Cedar Publishing61'],
        ['DigitalOcean', 'DigitalOcean', 'Backend Engineer — Synthetic Nectar Droplets61'],
        ['Coupang', 'Coupang', 'Backend Engineer — Synthetic Kite Delivery61'],
        ['xAI', 'xAI (SpaceXAI)', 'Backend Engineer — Synthetic Umber Orbit61'],
        ['SpaceXAI', 'xAI (SpaceXAI)', 'Backend Engineer — Synthetic Umber Orbit61'],
        ['ServiceNow', 'ServiceNow', 'Backend Engineer — Synthetic Laurel Workflow61'],
      ]) {
        await surveySearch(page).fill(query)
        await expect(page.locator('.city-detail-count strong')).toHaveText(['1', '1'])
        await expect(page.locator('.company-card h3')).toHaveText(company)
        await expect(page.locator('.mini-job-title')).toHaveText(title)
      }
      await surveySearch(page).fill('Cursor')
      await expect(page.locator('.city-detail-count strong')).toHaveText(['0', '0'])
      await page.locator('.region-tabs[aria-label="탐색 지역"]').getByRole('button', { name: '유럽', exact: true }).click()
      await surveyRole(page, 'frontend', 1)
      await page.getByRole('button', { name: '런던, 추천 회사 1곳 보기', exact: true }).click()
      await expect(page.locator('.mini-job-title')).toHaveText('Frontend Engineer — Synthetic Linden Editor61')
      await surveySearch(page).fill('Miro')
      await expect(page.locator('.city-detail-count strong')).toHaveText(['0', '0'])
      await page.getByRole('button', { name: '모든 도시', exact: true }).click()
      await page.getByRole('button', { name: '베를린, 추천 회사 1곳 보기', exact: true }).click()
      await expect(page.locator('.mini-job-title')).toHaveText('Frontend Engineer — Synthetic Willow Canvas61')
      await surveySearch(page).fill('Synthetic absent company61')
      await expect(page.locator('.city-detail-count strong')).toHaveText(['0', '0'])
      await surveySearch(page).fill('Miro')
      await expect(page.locator('.city-detail-count strong')).toHaveText(['1', '1'])
      await surveyDataButton(page).click()
      await sourceChoice(page, 'sample').click()
      await expect(dialog.locator('.coverage-stats strong')).toHaveText(['22', '32', '179'])
      await sourceChoice(page, 'public').click()
      await expect(dialog.locator('.coverage-stats strong')).toHaveText(['22', '83', '65'])
      await surveyClose(page, surveyDataButton(page))
      await expect(page.locator('.company-card h3')).toHaveText('Miro')
      await expect(page.locator('.mini-job-title')).toHaveText('Frontend Engineer — Synthetic Willow Canvas61')
      await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('orbit.v1.exploration') ?? '{}'))).toMatchObject({
        source: 'public', selectedId: 'berlin', filters: { query: 'Miro', role: 'frontend', region: 'europe' },
      })
      expect(await page.evaluate(() => JSON.parse(localStorage.getItem('orbit.v1.profile') ?? '{}'))).toEqual(COVERAGE_PROFILE)
      expect(await readSaved(page)).toEqual([])
      await page.locator('.company-card').scrollIntoViewIfNeeded()
      await expect(page.locator('.mini-job-title')).toBeInViewport()
      await surveyImage(page, info, `new-location-miro-${width}`)
      const upstream = await requestsAre(server, 85)
      expect(upstream.map(request => request.url).sort()).toEqual([...allFullUrls].sort())
      expectSurveyPrivacy(state, server.origin)
      await writeFile(info.outputPath('positive-catalog.json'), JSON.stringify({ catalog, upstream }, null, 2))
    } finally { await page.close(); await server.stop() }
  })

  test('an old36 cache collects only missing47 boards, then list and full checks preserve saved source facts through a real restart', async ({ page, baseURL }, info) => {
    test.setTimeout(120_000)
    const old = expansionLegacy36Cache(oldTime)
    expect(old.boards).toHaveLength(36)
    const server = await fixture(page, info, baseURL, { cacheSeed: old })
    try {
      await server.start()
      await server.verifyProductionBytes()
      const state = await seedSurvey(page, server.origin, { saved: surveyOldSaved(oldTime) })
      await expect(page.locator('.city-detail-count strong')).toHaveText(['43', '43'])
      const catalog = await surveyJson<Catalog>(page, server.origin, '/api/catalog?source=public')
      expectRegistrations(catalog, 50)
      const upstream = await requestsAre(server, 49)
      expect(upstream.map(request => request.url).sort()).toEqual([...Object.values(SURVEY_FULL_URLS), ...SURVEY_DETAIL_URLS].sort())
      const initialBytes = await readFile(server.defaultCache, 'utf8')
      const expanded = JSON.parse(initialBytes)
      expect(expanded.boards).toHaveLength(83)
      for (const original of old.boards)
        expect(expanded.boards.find((board: { companyId: string }) => board.companyId === original.companyId)).toMatchObject(original)

      await surveySearch(page).fill('ServiceNow')
      await surveyRole(page, 'backend', 1)
      const opener = page.getByRole('button', { name: SURVEY_SERVICE_TITLE, exact: true })
      await opener.click()
      await expect(page.getByRole('dialog', { name: 'ServiceNow', exact: true }).locator('.job-detail-heading p')).toHaveText('Seoul, South Korea')
      await expect(page.getByRole('dialog').locator('.source-line')).toContainText('SmartRecruiters 공개 게시판')
      await expect(page.getByRole('link', { name: '원문에서 지원하기', exact: true })).toHaveAttribute('href', 'https://example.com/synthetic/stage61/servicenow-61038')
      await page.getByRole('dialog').locator('.original-description > summary').click()
      await expect(page.getByRole('dialog').locator('.job-description p')).toHaveText(SURVEY_SERVICE_BODY)
      await page.getByRole('button', { name: '기회 저장', exact: true }).click()
      await page.getByLabel('이 기회에 대한 나의 메모', { exact: true }).fill(SURVEY_NOTE)
      await page.getByRole('button', { name: '지원 완료로 표시', exact: true }).click()
      await surveyClose(page, opener)
      const saved = await readSaved(page)
      expectSaved(saved)
      const serviceOriginal = saved.find(record => record.job.id === 'smartrecruiters-servicenow-synthetic-61038')!.job
      const serviceTime = serviceOriginal.fetchedAt
      expect(serviceOriginal).toMatchObject({
        skills: ['TypeScript', 'PostgreSQL'], minExperience: 3,
        qualifications: { skills: [
          { kind: 'context', skills: ['TypeScript'], evidence: {
            source: 'description', text: 'Responsibilities\nBuild a fictional workflow service with TypeScript in Seoul.',
          } },
          { kind: 'qualification', skills: ['PostgreSQL'], evidence: {
            source: 'description', text: 'Qualifications\n3 years of software engineering experience with PostgreSQL.',
          } },
        ] },
      })
      await surveyNavigation(page).getByRole('button', { name: /^저장한 기회/ }).click()
      await expect(page.locator('.saved-card')).toHaveCount(2)

      await server.respond(surveyResponses({ changedServiceNow: true }))
      await server.advance(61_000)
      await page.clock.fastForward(61_000)
      const listing = await checkSaved(page, false)
      await expect(page.locator('.posting-notice.listed')).toHaveCount(2)
      await expect(serviceCard(page).locator('.posting-changes')).toHaveCount(0)
      expect(listing.boards.find(board => board.companyId === 'servicenow')!.listing!.content!.checkedAt).toBe(serviceTime)
      expect(await readFile(server.defaultCache, 'utf8')).toBe(initialBytes)
      expect(await readSaved(page)).toEqual(saved)
      const afterList = await requestsAre(server, 132)
      expect(afterList.slice(49)).toHaveLength(83)
      expect(afterList.slice(49).some(request => SURVEY_DETAIL_URLS.includes(request.url as typeof SURVEY_DETAIL_URLS[number]))).toBe(false)

      await server.advance(61_000)
      await page.clock.fastForward(61_000)
      const content = await checkSaved(page, true)
      await expect(serviceCard(page).locator('.posting-current-title')).toHaveText(`현재 포지션: ${SURVEY_SERVICE_CHANGED_TITLE}`)
      // The changed body sentence is also the displayed TypeScript context
      // evidence. Numeric/required qualifications remain explicitly unchanged.
      await expect(serviceCard(page).locator('.posting-changes')).toHaveText('포지션 · 기술·경력·언어 · 본문 확인 필요')
      expect(content.boards.find(board => board.companyId === 'servicenow')!.listing!.jobs.map(job => [job.id, job.title])).toEqual([
        ['smartrecruiters-servicenow-synthetic-61038', SURVEY_SERVICE_CHANGED_TITLE],
      ])
      const current = await surveyJson<Catalog>(page, server.origin, '/api/catalog?source=public')
      expectRegistrations(current, 65)
      expect(current.jobs.find(job => job.id === 'smartrecruiters-servicenow-synthetic-61038')).toMatchObject({
        description: SURVEY_SERVICE_CHANGED_BODY, skills: ['TypeScript', 'PostgreSQL'], minExperience: 3,
        qualifications: { skills: [
          { kind: 'context', skills: ['TypeScript'], evidence: {
            source: 'description', text: 'Responsibilities\nBuild a fictional revised workflow service with TypeScript in Seoul.',
          } },
          { kind: 'qualification', skills: ['PostgreSQL'], evidence: {
            source: 'description', text: 'Qualifications\n3 years of software engineering experience with PostgreSQL.',
          } },
        ] },
      })
      const afterFull = await requestsAre(server, 217)
      expect(afterFull.slice(132).map(request => request.url).sort()).toEqual([...allFullUrls].sort())
      expect(await readSaved(page)).toEqual(saved)
      await page.getByRole('textbox', { name: '저장한 기회 검색', exact: true }).fill('café')
      await page.getByRole('combobox', { name: '게시 상태', exact: true }).selectOption('changed')
      await expect(page.locator('.saved-results-summary')).toHaveText('1개 기회 중 1–1개 표시')
      await expect(page.locator('.saved-title')).toHaveText(SURVEY_SERVICE_TITLE)
      await expect(page.locator('.saved-note-preview')).toHaveText(SURVEY_NOTE)
      await expect(page.locator('.saved-status')).toHaveText('지원 완료')
      await serviceCard(page).scrollIntoViewIfNeeded()
      await expect(page.locator('.saved-note-preview')).toBeInViewport()
      await surveyImage(page, info, `saved-source-body-change-${width}`)

      await surveyDataButton(page).click()
      await sourceChoice(page, 'sample').click()
      await expect(page.getByRole('dialog').locator('.coverage-stats strong')).toHaveText(['22', '32', '179'])
      await surveyClose(page, surveyDataButton(page))
      expect(await readSaved(page)).toEqual(saved)
      const fullBytes = await readFile(server.defaultCache, 'utf8')
      await page.goto('about:blank')
      await server.stop()
      await server.start()
      await server.verifyProductionBytes()
      await page.goto(`${server.origin}/#saved`)
      await expect(page.locator('.saved-card')).toHaveCount(2)
      expectSaved(await readSaved(page))
      expect(await readSaved(page)).toEqual(saved)
      const reloaded = await surveyJson<Catalog>(page, server.origin, '/api/catalog?source=public')
      expect(reloaded.jobs).toEqual(current.jobs)
      expect(await readFile(server.defaultCache, 'utf8')).toBe(fullBytes)
      await requestsAre(server, 217)
      expectSurveyPrivacy(state, server.origin)
      await writeFile(info.outputPath('old36-list-body-restart.json'), JSON.stringify({
        old, catalog, listing, content, saved, reloaded, upstream: afterFull,
      }, null, 2))
    } finally { await page.close(); await server.stop() }
  })

  test('four provider failures remain unconfirmed through restart and recover only their failed boards without inventing an observation total', async ({ page, baseURL }, info) => {
    test.setTimeout(120_000)
    const server = await fixture(page, info, baseURL, { responses: surveyResponses({ failures: true }) })
    try {
      await server.start()
      await server.verifyProductionBytes()
      const state = await seedSurvey(page, server.origin)
      const first = await surveyJson<Catalog>(page, server.origin, '/api/catalog?source=public')
      expectRegistrations(first, 60)
      expect(first.boards.filter(board => board.status === 'error').map(board => [board.companyId, board.dataStatus, board.lastSuccessAt])).toEqual([
        ['clickhouse', 'unavailable', null], ['palantir', 'unavailable', null],
        ['servicenow', 'unavailable', null], ['xai', 'unavailable', null],
      ])
      await surveyDataButton(page).click()
      await expect(page.getByRole('dialog').locator('.coverage-stats strong')).toHaveText(['22', '83', '60'])
      await page.getByRole('dialog').locator('.board-details > summary').click()
      for (const name of ['ClickHouse', 'Palantir', 'ServiceNow', 'xAI (SpaceXAI)']) {
        const row = page.getByRole('dialog').locator('.board-row').filter({ has: page.getByText(name, { exact: true }) })
        await expect(row.locator('.board-error')).toHaveText('데이터 미확인')
        await expect(row.locator('.board-ok')).toHaveCount(0)
        await expect(row).not.toContainText('0개 반영')
      }
      const figma = page.getByRole('dialog').locator('.board-row').filter({ has: page.getByText('Figma', { exact: true }) })
      await expect(figma.locator('.board-ok')).toHaveText('0개 반영')
      await page.getByRole('dialog').locator('.board-details > summary').click()
      const panel = await observations(page)
      await expect(panel.locator('.observation-incomplete strong')).toHaveText('이 날짜의 최근 시도는 전체 집계를 확인하지 못했어요.')
      await expect(panel.locator('.observation-incomplete p')).toHaveText('일부 회사의 숫자를 전체 채용 규모로 표시하지 않아요.')
      await expect(panel.locator('.observation-incomplete li')).toHaveText([
        'ClickHouse · 최근 조회 실패', 'Palantir · 최근 조회 실패', 'ServiceNow · 최근 조회 실패', 'xAI (SpaceXAI) · 최근 조회 실패',
      ])
      await expect(panel.locator('.observation-totals')).toHaveCount(0)
      await panel.locator('.observation-incomplete').scrollIntoViewIfNeeded()
      await surveyImage(page, info, `unconfirmed-providers-${width}`)
      await requestsAre(server, 85)
      await page.goto('about:blank')
      await server.stop()
      await server.start()
      const retained = await surveyJson<Catalog>(page, server.origin, '/api/catalog?source=public')
      expect(retained.boards).toEqual(first.boards)
      await requestsAre(server, 85)
      await server.respond(surveyResponses())
      await server.advance(121_000)
      await page.clock.fastForward(121_000)
      const recovered = await surveyJson<Catalog>(page, server.origin, '/api/catalog?source=public')
      expectRegistrations(recovered, 65)
      expect(recovered.boards.every(board => board.status === 'ok' && board.dataStatus === 'fresh')).toBe(true)
      const upstream = await requestsAre(server, 90)
      expect(upstream.slice(85).map(request => request.url).sort()).toEqual([
        SURVEY_FULL_URLS.clickhouse, SURVEY_FULL_URLS.palantir, SURVEY_FULL_URLS.servicenow, SURVEY_FULL_URLS.xai, SURVEY_DETAIL_URLS[1],
      ].sort())
      await page.goto(server.origin)
      await surveySearch(page).fill('ServiceNow')
      await expect(page.locator('.mini-job-title')).toHaveText(SURVEY_SERVICE_TITLE)
      await expect(page.locator('.city-detail-count strong')).toHaveText(['1', '1'])
      await surveyDataButton(page).click()
      const complete = await observations(page)
      await expect(complete.locator('.observation-totals dd')).toHaveText(['69개', '65개', '63개', '2개'])
      await expect(complete.locator('.observation-incomplete')).toHaveCount(0)
      await requestsAre(server, 90)
      expectSurveyPrivacy(state, server.origin)
      await writeFile(info.outputPath('provider-failure-restart-recovery.json'), JSON.stringify({
        first, retained, recovered, events: await server.events(),
      }, null, 2))
    } finally { await page.close(); await server.stop() }
  })

  test('public coverage uses63 then64 opening denominators and excludes the complete old36 cohort from comparisons', async ({ page, baseURL }, info) => {
    test.setTimeout(120_000)
    const historical = surveyOldHistory()
    const server = await fixture(page, info, baseURL, { observationsSeed: historical })
    try {
      await server.start()
      await server.verifyProductionBytes()
      const old = await surveyJson<ObservationHistory>(page, server.origin, '/api/observations')
      expect(old.days).toEqual([])
      expect(old.otherSeries).toEqual([{
        scopeKey: SURVEY_OLD_SCOPE_KEY,
        method: 'observations-1.occupation-4.roles-1.qualifications-1.remote-2.employment-1.purpose-1',
        firstDay: '2026-09-25', lastDay: '2026-09-25', companyCount: 36,
      }])
      await requestsAre(server, 0)
      const state = await seedSurvey(page, server.origin, { query: 'Coupang' })
      await expect(page.locator('.city-detail-count strong')).toHaveText(['1', '1'])
      await surveyDataButton(page).click()
      const panel = await observations(page)
      await expect(panel.locator('.observation-totals dd')).toHaveText(['69개', '65개', '63개', '2개'])
      await expect(panel.locator('.observation-denominator')).toHaveText('분모: 일반 개발·컴퓨팅 공고 63개 · 인재풀 2개 제외')
      await expect(panel.locator('.observation-comparison strong')).toHaveCount(0)
      await expect(panel.locator('.observation-comparison')).toContainText('서로 다른 날짜의 기록이 2개 이상')
      const excluded = panel.getByText('회사·게시판 구성 또는 분류 기준이 다른 이전 기록 1개 묶음은 현재 비교에서 제외했어요.', { exact: true })
      await expect(excluded).toBeVisible()
      await expect(panel.getByRole('combobox', { name: '관측 날짜 (UTC)', exact: true }).locator('option')).toHaveText(['2026-09-26'])
      await expect(panel.locator('.observation-table tbody tr')).toHaveCount(83)
      await requestsAre(server, 85)
      await excluded.scrollIntoViewIfNeeded()
      await expect(excluded).toBeInViewport()
      await surveyImage(page, info, `old36-cohort-excluded-${width}`)

      await server.advance(86_400_000)
      await page.clock.setFixedTime(new Date('2026-09-27T10:00:00.000Z'))
      await panel.getByRole('button', { name: '관측 기록 다시 읽기', exact: true }).click()
      await expect(panel.getByRole('button', { name: '관측 기록 다시 읽기', exact: true })).toBeEnabled()
      await expect(panel.locator('.observation-totals dd')).toHaveText(['69개', '65개', '63개', '2개'])
      await requestsAre(server, 85)
      await server.respond(surveyResponses({ nextDay: true }))
      const next = await surveyJson<Catalog>(page, server.origin, '/api/catalog?source=public&refresh=1')
      expectRegistrations(next, 66)
      await panel.getByRole('button', { name: '관측 기록 다시 읽기', exact: true }).click()
      await expect(panel.getByRole('combobox', { name: '관측 날짜 (UTC)', exact: true }).locator('option')).toHaveText(['2026-09-27', '2026-09-26'])
      await panel.getByRole('combobox', { name: '관측 날짜 (UTC)', exact: true }).selectOption('2026-09-27')
      await expect(panel.locator('.observation-totals dd')).toHaveText(['70개', '66개', '64개', '2개'])
      await expect(panel.locator('.observation-denominator')).toHaveText('분모: 일반 개발·컴퓨팅 공고 64개 · 인재풀 2개 제외')
      await expect(panel.locator('.observation-comparison strong')).toHaveText('2026-09-26 → 2026-09-27: 일반 공고 +1개')
      await panel.getByRole('combobox', { name: '분포 항목', exact: true }).selectOption('regions')
      await expect(panel.locator('.observation-table tbody tr')).toHaveCount(6)
      await expect(panel.locator('.observation-denominator')).toHaveText('분모: 일반 개발·컴퓨팅 공고 64개 · 인재풀 2개 제외')
      await panel.locator('.observation-comparison').scrollIntoViewIfNeeded()
      await expect(panel.locator('.observation-comparison strong')).toBeInViewport()
      await surveyImage(page, info, `83-company-observation-delta-${width}`)
      const persisted = JSON.parse(await readFile(server.observationsFile, 'utf8'))
      expect(persisted.series.find((series: { scope: { key: string } }) => series.scope.key === SURVEY_OLD_SCOPE_KEY)).toEqual(historical.series[0])
      const history = await surveyJson<ObservationHistory>(page, server.origin, '/api/observations')
      expect(history.otherSeries).toEqual(old.otherSeries)
      await requestsAre(server, 170)
      expect(await readSaved(page)).toEqual([])
      expectSurveyPrivacy(state, server.origin)
      await writeFile(info.outputPath('observation-cohorts.json'), JSON.stringify({ old, history, persisted }, null, 2))
    } finally { await page.close(); await server.stop() }
  })
})

test('the unconfigured83-source server retains real browser304 and file-cache behavior across its owned process restart', async ({ page, baseURL }, info) => {
  test.setTimeout(90_000)
  const server = await fixture(page, info, baseURL)
  try {
    await server.start()
    await server.verifyProductionBytes()
    const state = await seedSurvey(page, server.origin, { source: 'sample', hash: '#saved', route: false })
    const fetchCatalog = () => page.evaluate(async () => {
      const response = await fetch('/api/catalog?source=public')
      return { status: response.status, catalog: await response.json() }
    })
    const first = await fetchCatalog()
    expect(first.status).toBe(200)
    expectRegistrations(first.catalog, 65)
    const bytes = await readFile(server.defaultCache, 'utf8')
    const second = await fetchCatalog()
    expect(second).toEqual(first)
    let wire = (await server.wireResponses()).filter(event => event.path === '/api/catalog?source=public')
    expect(wire.map(event => event.status)).toEqual([200, 304])
    expect(wire[1]).toMatchObject({ ifNoneMatch: expect.any(String), cacheControl: 'private, no-cache, must-revalidate' })
    await requestsAre(server, 85)
    await page.goto('about:blank')
    await server.stop()
    await server.start()
    await server.verifyProductionBytes()
    await page.goto(`${server.origin}/#saved`)
    expect(await fetchCatalog()).toEqual(first)
    wire = (await server.wireResponses()).filter(event => event.path === '/api/catalog?source=public')
    expect(wire.map(event => event.status)).toEqual([200, 304, 304])
    expect(await readFile(server.defaultCache, 'utf8')).toBe(bytes)
    const upstream = await requestsAre(server, 85)
    expectSurveyPrivacy(state, server.origin)
    await writeFile(info.outputPath('real-http-file-cache.json'), JSON.stringify({ first, wire, upstream }, null, 2))
  } finally { await page.close(); await server.stop() }
})
