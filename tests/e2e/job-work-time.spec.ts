import { expect, test } from '@playwright/test'
import type { Locator, Page, TestInfo } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { Catalog, Job, SavedJob } from '../../shared/types'
import {
  WORK_TIME_AMBIGUOUS, WORK_TIME_COLLABORATION, WORK_TIME_CORE, WORK_TIME_FETCHED_AT,
  WORK_TIME_FILTERS, WORK_TIME_LANGUAGE, WORK_TIME_NOTE, WORK_TIME_OVERLAP,
  WORK_TIME_POOL, WORK_TIME_PREFERENCE, WORK_TIME_PROFILE, WORK_TIME_REMOTE, WORK_TIME_REMOTE_CORE,
  WORK_TIME_SAVED_AT, WORK_TIME_SCOPED, WORK_TIME_TITLES, WORK_TIME_UPDATED_AT, WORK_TIME_WORKING,
  legacyCollectedWorkTimeSaved, legacyWorkTimeJobs, legacyWorkTimeSaved, workTimeUpstreamResponses,
} from '../fixtures/job-work-time'
import { createJobWorkTimeServer } from '../fixtures/job-work-time-server'
import { expectInitialCatalogRequest, readServerMode, watchApiRequests } from './helpers/api-requests'
import { readSaved, waitForSavedCommit } from './helpers/saved-store'

const search = (page: Page) => page.getByRole('textbox', { name: '도시, 회사 또는 포지션 검색', exact: true })
const savedSearch = (page: Page) => page.getByRole('textbox', { name: '저장한 기회 검색', exact: true })
const navigation = (page: Page) => page.getByRole('navigation', { name: '주요 메뉴' })
const workTime = (page: Page) => page.getByRole('region', { name: '시간대·협업 시간', exact: true })
const resultsTab = (page: Page, name: string) => page.locator('.results-tabs').getByRole('button', { name: new RegExp(`^${name}`) })
const timeCaution = '공고에 시간대·협업 시간 안내가 있어요. 상세의 원문에서 근무 시간대와 함께 일할 시간을 확인해 주세요.'
const timeFootnote = '시간대 약어와 시각은 원문 그대로예요. 서머타임 적용과 실제 협업 시간은 회사에 확인해 주세요. 거주 국가만으로 시간대나 이 조건의 충족 여부를 판단하지 않습니다.'
const coreQuote = `Working hours\n${WORK_TIME_CORE}`
const overlapQuote = `Collaboration\n${WORK_TIME_OVERLAP}`
const originalSummary = `코어 근무시간 · 공고 안내: ${WORK_TIME_CORE}\n근무시간 중첩 · 필수로 명시: ${WORK_TIME_OVERLAP}`
const seniorStatement = 'Core hours are 09:00–12:00 GMT.'
const engineerStatement = 'Core hours are 14:00–17:00 GMT.'
const seniorQuote = `Basic Qualifications (2 Titles)\nSenior Software Engineer\n${seniorStatement}`
const engineerQuote = `Basic Qualifications (2 Titles)\nSoftware Engineer II\n${engineerStatement}`

async function isolate(page: Page, origin: string) {
  await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.fallback() : route.abort('blockedbyclient'))
}
async function seed(page: Page, origin: string, saved: SavedJob[] = []) {
  await isolate(page, origin)
  await page.addInitScript(({ origin, saved, profile, filters }) => {
    if (location.origin !== origin || sessionStorage.getItem('work-time-seeded')) return
    localStorage.setItem('orbit.v1.profile', JSON.stringify(profile))
    localStorage.setItem('orbit.v1.saved', JSON.stringify(saved))
    localStorage.setItem('orbit.v1.exploration', JSON.stringify({
      source: 'public', filters, selectedId: 'berlin', panelTab: 'cities',
      mapMode: 'flat', citySort: 'companies', light: false,
    }))
    sessionStorage.setItem('work-time-seeded', 'true')
  }, { origin, saved, profile: WORK_TIME_PROFILE, filters: WORK_TIME_FILTERS })
}
function browserFailures(page: Page) {
  const errors: string[] = []
  const resources: { url: string; status?: number; error?: string }[] = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('response', response => {
    if (response.status() >= 400) resources.push({ url: response.url(), status: response.status() })
  })
  page.on('requestfailed', request => {
    const error = request.failure()?.errorText
    if (!new URL(request.url()).pathname.startsWith('/api/') && error !== 'net::ERR_ABORTED') resources.push({ url: request.url(), error })
  })
  return { errors, resources }
}
async function closeDialog(page: Page, opener: Locator) {
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(opener).toBeFocused()
}
async function evidence(page: Page, kinds: string[], levels: string[], statements: string[], quotes: string[], scopes?: string[]) {
  const section = workTime(page)
  await expect(section).toBeVisible()
  await expect(section.locator('summary > span:first-child')).toHaveText(kinds)
  await expect(section.locator('summary > small')).toHaveText(levels)
  await expect(section.locator('.work-time-statement')).toHaveText(statements)
  if (scopes) await expect(section.locator('.work-time-scope')).toHaveText(scopes)
  else await expect(section.locator('.work-time-scope')).toHaveCount(0)
  for (const summary of await section.locator('summary').all()) {
    await summary.focus()
    await expect(summary).toBeFocused()
    await page.keyboard.press('Enter')
  }
  await expect(section.locator('details[open]')).toHaveCount(kinds.length)
  await expect(section.locator('blockquote')).toHaveText(quotes)
  await expect(section.locator('.eligibility-footnote')).toHaveText(timeFootnote)
  await section.locator('blockquote').last().scrollIntoViewIfNeeded()
}
async function audit(page: Page, info: TestInfo, screenshot?: string) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  for (const element of await page.locator('[role="dialog"], .job-work-time, .job-work-time blockquote').all()) {
    expect(await element.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true)
  }
  expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze()).violations).toEqual([])
  if (screenshot) await page.screenshot({ path: info.outputPath(screenshot) })
}
async function catalog(page: Page, origin: string): Promise<Catalog> {
  let completed: Catalog | undefined
  await expect.poll(async () => {
    const response = await page.request.get(`${origin}/api/catalog?source=public`)
    try {
      expect([200, 202]).toContain(response.status())
      if (response.status() === 200) completed = await response.json()
      return response.status()
    } finally { await response.dispose() }
  }, 'The real collector must finish all four synthetic boards').toBe(200)
  return completed!
}
function privateTraffic(traffic: ReturnType<typeof watchApiRequests>, origin: string) {
  for (const request of traffic.requests) {
    const url = new URL(request.url)
    expect(url.origin).toBe(origin)
    expect(['/api/catalog', '/api/catalog/progress', '/api/posting-status']).toContain(url.pathname)
    expect(request.method).toBe('GET')
    expect(request.body).toBeNull()
    expect(decodeURIComponent(url.search)).not.toMatch(/가상 지원자|메모|영어|한국어|코어|협업|\bUTC\b|\bGMT\b|\bCST\b|WORK_TIME_NOTE/)
  }
}
async function syntheticTraffic(server: Awaited<ReturnType<typeof createJobWorkTimeServer>>, count: number) {
  const upstream = await server.requests()
  expect(upstream).toHaveLength(count)
  expect(upstream.every(item => item.synthetic && !item.networkSent && item.method === 'GET')).toBe(true)
  expect(await readFile(server.defaultCache, 'utf8')).toBe(server.defaultBytes)
  return upstream
}
function csvRows(text: string, count: number) {
  const cells = (value: string) => [...value.matchAll(/"((?:[^"]|"")*)"(?:,|\r\n|$)/g)].map(match => match[1].replaceAll('""', '"'))
  const boundary = text.indexOf('\r\n')
  const headers = cells(text.slice(0, boundary))
  const values = cells(text.slice(boundary + 2))
  expect(headers).toHaveLength(48)
  expect(headers.slice(37, 47)).toEqual(['원격근무 지역 판단', '원격근무 지역 원문 근거', '모집 유형', '모집 유형 근거', '언어 조건', '언어 조건 근거', '시간대·협업 시간', '시간대·협업 시간 근거', '근무 국가', '근무 국가 근거'])
  expect(headers[47]).toBe('공고 내용 확인 시각')
  expect(headers).toContain('기술·경력 근거')
  expect(values).toHaveLength(48 * count)
  return Array.from({ length: count }, (_, row) => Object.fromEntries(headers.map((header, index) => [header, values[row * 48 + index]])))
}
async function csvDownload(page: Page) {
  const event = page.waitForEvent('download')
  await page.getByRole('button', { name: 'CSV 내보내기', exact: true }).click()
  return readFile((await (await event).path())!, 'utf8')
}
function preservedOriginal(record: SavedJob, oldDate = WORK_TIME_FETCHED_AT) {
  expect(record).toMatchObject({
    company: { id: 'time-dawn', name: 'Dawn Circuits', provider: 'greenhouse', board: 'DawnWorkTime46' },
    note: WORK_TIME_NOTE, status: 'applied',
    job: {
      id: 'greenhouse-time-dawn-4601', source: 'greenhouse',
      url: 'https://example.com/jobs/time-dawn-4601', fetchedAt: oldDate, updatedAt: WORK_TIME_UPDATED_AT,
      workMode: 'onsite', remoteCountries: [], remoteWorldwide: false,
      languageRequirements: { version: 1, rules: [
        { languages: ['en'], kind: 'required', match: 'all', evidence: { source: 'description', text: `Minimum requirements\n${WORK_TIME_LANGUAGE}` } },
      ] },
      workTimeRequirements: { version: 1, rules: [
        { kind: 'core-hours', level: 'stated', statement: WORK_TIME_CORE, evidence: { source: 'description', text: coreQuote } },
        { kind: 'overlap', level: 'required', statement: WORK_TIME_OVERLAP, evidence: { source: 'description', text: overlapQuote } },
      ] },
    },
  })
}

for (const width of [1440, 320]) test.describe(`work-time evidence through real four-provider collection at ${width}px`, () => {
  test.use({ viewport: { width, height: 960 }, isMobile: width === 320, hasTouch: width === 320 })

  test('literal language/time discovery preserves five kinds, ambiguous clocks, remote eligibility and separate talent-pool counts', async ({ page, request, baseURL }, info) => {
    const server = await createJobWorkTimeServer(info.outputPath('work-time-server'), await readServerMode(request, `${baseURL}/api/health`))
    const failures = browserFailures(page)
    const traffic = watchApiRequests(page)
    try {
      await server.start()
      await server.verifyProductionBytes()
      await seed(page, server.origin)
      await page.goto(server.origin)
      await expectInitialCatalogRequest(page, traffic)
      await expect(page.locator('.city-detail-count strong')).toHaveText(['2', '3'])
      await expect(page.locator('.company-card h3')).toHaveText(['Dawn Circuits', 'Juniper Labs'])
      const fresh = await catalog(page, server.origin)
      expect(fresh.jobs.map(job => job.id)).toEqual([
        'greenhouse-time-dawn-4601', 'greenhouse-time-dawn-4602', 'greenhouse-time-dawn-4603',
        'ashby-time-juniper-4604', 'lever-time-maple-4605', 'smartrecruiters-time-willow-4606',
      ])
      expect(fresh.companies).toHaveLength(4)
      expect(fresh.jobs.map(job => job.workTimeRequirements?.rules.length)).toEqual([2, 0, 1, 2, 2, 2])
      expect(fresh.jobs.map(job => job.postingPurpose?.kind ?? null)).toEqual([null, null, 'talent-pool', null, null, null])
      expect(fresh.jobs.map(job => job.workMode)).toEqual(['onsite', 'onsite', 'onsite', 'onsite', 'remote', 'onsite'])
      expect(fresh.jobs.map(job => job.remoteCountries)).toEqual([[], [], [], [], [], []])
      expect(fresh.unmappedCount).toBe(1)
      for (const query of ['UTC', '영어 코어 근무시간']) {
        await search(page).fill(query)
        await expect(page.locator('.city-detail-count strong')).toHaveText(['1', '1'])
        await expect(page.locator('.mini-job-title')).toHaveText([WORK_TIME_TITLES.mixed])
      }
      const mixed = page.getByRole('button', { name: WORK_TIME_TITLES.mixed, exact: true })
      await mixed.click()
      await evidence(page, ['코어 근무시간', '근무시간 중첩'], ['공고 안내', '필수로 명시'],
        [WORK_TIME_CORE, WORK_TIME_OVERLAP], [coreQuote, overlapQuote])
      await expect(page.getByRole('dialog').getByText(timeCaution, { exact: true })).toBeVisible()
      await expect(page.getByRole('link', { name: '원문에서 지원하기', exact: true })).toHaveAttribute('href', 'https://example.com/jobs/time-dawn-4601')
      await audit(page, info, width === 320 ? 'core-overlap-source-320.png' : undefined)
      await closeDialog(page, mixed)

      await search(page).fill('한국어 협업 시간대')
      await expect(page.locator('.city-detail-count strong')).toHaveText(['1', '1'])
      const collaboration = page.getByRole('button', { name: WORK_TIME_TITLES.collaboration, exact: true })
      await collaboration.click()
      await evidence(page, ['협업 시간대', '근무시간 중첩'], ['공고 안내', '우대 사항'],
        [WORK_TIME_COLLABORATION, WORK_TIME_PREFERENCE],
        [`Collaboration\n${WORK_TIME_COLLABORATION}`, `Nice to have\n${WORK_TIME_PREFERENCE}`])
      await closeDialog(page, collaboration)
      await search(page).fill('GMT')
      await expect(page.locator('.city-detail-count strong')).toHaveText(['0', '0'])

      await search(page).fill('영어 UTC')
      await resultsTab(page, '원격 기회').click()
      await expect(page.locator('.list-toolbar > span')).toHaveText('1개 회사 · 1개 공고')
      await expect(page.locator('.mini-job-title')).toHaveText([WORK_TIME_TITLES.remote])
      expect(fresh.jobs[4]).toMatchObject({ remoteWorldwide: true, remoteCountries: [], workMode: 'remote' })
      const remote = page.getByRole('button', { name: WORK_TIME_TITLES.remote, exact: true })
      await remote.click()
      await evidence(page, ['거주·근무 시간대', '코어 근무시간'], ['필수로 명시', '공고 안내'],
        [WORK_TIME_REMOTE, WORK_TIME_REMOTE_CORE], [`Location\n${WORK_TIME_REMOTE}`, `Working hours\n${WORK_TIME_REMOTE_CORE}`])
      await closeDialog(page, remote)

      await search(page).fill('CST')
      await resultsTab(page, '기타 근무지').click()
      await expect(page.locator('.list-toolbar > span')).toHaveText('1개 회사 · 1개 공고')
      await expect(page.locator('.company-card h3')).toHaveText(['Willow Instruments'])
      const ambiguous = page.getByRole('button', { name: WORK_TIME_TITLES.ambiguous, exact: true })
      await ambiguous.click()
      await evidence(page, ['코어 근무시간', '근무시간 안내'], ['공고 안내', '공고 안내'],
        [WORK_TIME_AMBIGUOUS, WORK_TIME_WORKING], [`Working hours\n${WORK_TIME_AMBIGUOUS}`, `Working hours\n${WORK_TIME_WORKING}`])
      await expect(workTime(page)).not.toContainText('America/Chicago')
      await expect(workTime(page)).not.toContainText('Asia/Shanghai')
      await audit(page, info, width === 320 ? 'ambiguous-working-hours-320.png' : undefined)
      await closeDialog(page, ambiguous)
      await search(page).fill('근무시간 안내')
      await expect(page.locator('.list-toolbar > span')).toHaveText('1개 회사 · 1개 공고')
      await search(page).fill('인도')
      await expect(page.locator('.company-card')).toHaveCount(0)

      await resultsTab(page, '도시 탐색').click()
      await search(page).fill('Eastern')
      const filters = page.getByRole('button', { name: /^모든 필터/ })
      await filters.click()
      await page.getByLabel('모집 유형', { exact: true }).selectOption('talent-pool')
      await page.getByRole('button', { name: '1개 공고 보기', exact: true }).click()
      await expect(filters).toBeFocused()
      await expect(page.locator('.city-detail-count strong')).toHaveText(['1', '1'])
      await expect(page.locator('.mini-job-title')).toHaveText([WORK_TIME_TITLES.pool])
      await expect(page.locator('.posting-purpose-badge')).toHaveText('인재풀·관심 등록')
      const pool = page.getByRole('button', { name: WORK_TIME_TITLES.pool, exact: true })
      await pool.click()
      await evidence(page, ['거주·근무 시간대'], ['필수로 명시'], [WORK_TIME_POOL], [`Location\n${WORK_TIME_POOL}`])
      await closeDialog(page, pool)
      privateTraffic(traffic, server.origin)
      expect(failures).toEqual({ errors: [], resources: [] })
      await writeFile(info.outputPath('real-work-time-collection.json'), JSON.stringify({ fresh, upstream: await syntheticTraffic(server, 5) }, null, 2))
    } finally { await page.close(); await server.stop() }
  })

  test('old saved source gains exact work-time evidence without a fake revision through AND search, warm cache, CSV and fresh JSON restore', async ({ page, browser, request, baseURL }, info) => {
    const server = await createJobWorkTimeServer(info.outputPath('work-time-server'), await readServerMode(request, `${baseURL}/api/health`))
    const originals = [legacyCollectedWorkTimeSaved(), legacyWorkTimeSaved(legacyWorkTimeJobs()[3])]
    expect(originals.every(record => !record.job.workTimeRequirements)).toBe(true)
    const failures = browserFailures(page)
    const traffic = watchApiRequests(page)
    try {
      await server.start()
      await server.verifyProductionBytes()
      await seed(page, server.origin, originals)
      await page.goto(`${server.origin}/#saved`)
      await expect(page.locator('.saved-card')).toHaveCount(2)
      expect(traffic.requests).toEqual([])
      expect(await server.requests()).toHaveLength(0)
      await page.getByRole('button', { name: '데이터와 추천 방식', exact: true }).click()
      await page.getByRole('dialog').getByRole('button', { name: '공개 공고 다시 조회', exact: true }).click()
      await expect(page.getByRole('dialog').locator('.coverage-stats strong')).toHaveText(['22', '4', '6'])
      await expect(page.locator('.data-loading')).toHaveCount(0)
      await page.getByRole('button', { name: '닫기', exact: true }).click()
      const before = await catalog(page, server.origin)
      const records = await readSaved(page)
      expect(records).toHaveLength(2)
      preservedOriginal(records.find(record => record.job.id === 'greenhouse-time-dawn-4601')!)
      expect(records.map(record => record.savedAt)).toEqual([WORK_TIME_SAVED_AT, WORK_TIME_SAVED_AT])
      for (const query of ['한국어 협업 시간대', '협업   시간대 한국어']) {
        await savedSearch(page).fill(query)
        await expect(page.locator('.saved-card h2')).toHaveText(['Juniper Labs'])
        await expect(page.locator('.saved-status')).toHaveText('지원 완료')
      }
      await savedSearch(page).fill('GMT')
      await expect(page.locator('.saved-card')).toHaveCount(0)
      await savedSearch(page).fill('')
      await page.getByRole('button', { name: '게시 상태 확인', exact: true }).click()
      const dawn = page.locator('.saved-card').filter({ has: page.getByRole('button', { name: WORK_TIME_TITLES.mixed, exact: true }) })
      await expect(dawn.locator('.posting-notice.listed')).toHaveCount(1)
      await expect(dawn.locator('.posting-notice.changed')).toHaveCount(0)
      const mixed = page.getByRole('button', { name: WORK_TIME_TITLES.mixed, exact: true })
      await mixed.click()
      await evidence(page, ['코어 근무시간', '근무시간 중첩'], ['공고 안내', '필수로 명시'],
        [WORK_TIME_CORE, WORK_TIME_OVERLAP], [coreQuote, overlapQuote])
      await expect(page.getByLabel('이 기회에 대한 나의 메모', { exact: true })).toHaveValue(WORK_TIME_NOTE)
      await expect(page.getByRole('button', { name: '지원 완료로 표시됨', exact: true })).toBeVisible()
      await audit(page, info, width === 320 ? 'old-saved-time-source-320.png' : undefined)
      await closeDialog(page, mixed)
      const csvText = await csvDownload(page)
      expect(csvRows(csvText, 2).find(row => row['회사'] === 'Dawn Circuits')).toMatchObject({
        '상태': '지원 완료', '메모': WORK_TIME_NOTE, '저장일': WORK_TIME_SAVED_AT,
        '저장 내용의 조회 시각': WORK_TIME_FETCHED_AT, '채용 링크': 'https://example.com/jobs/time-dawn-4601',
        '언어 조건': '필수로 명시: 영어', '언어 조건 근거': `Minimum requirements\n${WORK_TIME_LANGUAGE}`,
        '시간대·협업 시간': originalSummary, '시간대·협업 시간 근거': `${coreQuote}\n\n${overlapQuote}`,
        '공개 게시 상태': '게시 확인', '내용 비교': '표시 내용 일치', '저장 내용과 다른 항목': '',
        '근무 국가': '독일', '근무 국가 근거': 'Berlin, Germany',
      })
      await page.getByRole('button', { name: '기록 백업·복원', exact: true }).click()
      const download = page.waitForEvent('download')
      await page.getByRole('button', { name: 'JSON 백업', exact: true }).click()
      const backupText = await readFile((await (await download).path())!, 'utf8')
      expect(JSON.parse(backupText).records).toEqual(records)
      expect(JSON.parse(backupText)).not.toHaveProperty('profile')
      expect(backupText).not.toContain('가상 지원자')
      await page.getByRole('button', { name: '완료', exact: true }).click()

      const files = await server.cacheFiles()
      expect(files).toHaveLength(1)
      const cacheFile = path.join(server.cwd, '.local', files[0])
      const cacheBefore = await readFile(cacheFile, 'utf8')
      const cache = JSON.parse(cacheBefore) as { boards: { snapshot: { jobs: Job[] } }[] }
      expect(cache.boards.flatMap(board => board.snapshot.jobs).map(job => job.workTimeRequirements?.rules.length)).toEqual([2, 0, 1, 2, 2, 2])
      await page.goto('about:blank')
      await server.stop()
      await server.start()
      await server.verifyProductionBytes()
      await page.goto(`${server.origin}/#saved`)
      await expect(page.locator('.saved-card')).toHaveCount(2)
      expect(await readSaved(page)).toEqual(records)
      expect((await catalog(page, server.origin)).jobs).toEqual(before.jobs)
      expect(await readFile(cacheFile, 'utf8')).toBe(cacheBefore)
      await syntheticTraffic(server, 5)
      await writeFile(info.outputPath('work-time-saved.csv'), csvText)
      await writeFile(info.outputPath('work-time-backup.json'), backupText)
      privateTraffic(traffic, server.origin)
      expect(failures).toEqual({ errors: [], resources: [] })

      const context = await browser.newContext({ viewport: { width, height: 960 }, isMobile: width === 320, hasTouch: width === 320 })
      try {
        const target = await context.newPage()
        const targetFailures = browserFailures(target)
        await isolate(target, server.origin)
        await target.goto(`${server.origin}/#saved`)
        await waitForSavedCommit(target)
        await target.getByRole('button', { name: '기록 백업·복원', exact: true }).click()
        await target.getByLabel('백업 또는 복구 파일', { exact: true }).setInputFiles({
          name: 'fictional-work-time-records.json', mimeType: 'application/json', buffer: Buffer.from(backupText),
        })
        await expect(target.locator('.saved-import-row')).toHaveCount(2)
        expect(await readSaved(target)).toEqual([])
        await target.getByRole('button', { name: '선택한 2개 가져오기', exact: true }).click()
        await expect(target.locator('.saved-file-message')).toContainText('선택한 2개 기록을 저장했어요.')
        await target.getByRole('button', { name: '완료', exact: true }).click()
        expect(await readSaved(target)).toEqual(records)
        await savedSearch(target).fill('협업 시간대 한국어')
        await expect(target.locator('.saved-card h2')).toHaveText(['Juniper Labs'])
        await target.reload()
        await expect(target.locator('.saved-card')).toHaveCount(2)
        expect(await readSaved(target)).toEqual(records)
        expect(await target.evaluate(() => localStorage.getItem('orbit.v1.profile'))).toBeNull()
        expect(targetFailures).toEqual({ errors: [], resources: [] })
      } finally { await context.close() }
    } finally { await page.close(); await server.stop() }
  })

  test('a real same-ID recollection changes current UTC to scoped GMT while saved original language, hours, note and status survive', async ({ page, request, baseURL }, info) => {
    const server = await createJobWorkTimeServer(info.outputPath('work-time-server'), await readServerMode(request, `${baseURL}/api/health`))
    const failures = browserFailures(page)
    const traffic = watchApiRequests(page)
    try {
      await server.start()
      await server.verifyProductionBytes()
      await seed(page, server.origin)
      await page.goto(server.origin)
      await expectInitialCatalogRequest(page, traffic)
      await search(page).fill('영어 UTC')
      await expect(page.locator('.city-detail-count strong')).toHaveText(['1', '1'])
      const opener = page.getByRole('button', { name: WORK_TIME_TITLES.mixed, exact: true })
      await opener.click()
      await page.getByRole('button', { name: '기회 저장', exact: true }).click()
      await page.getByLabel('이 기회에 대한 나의 메모', { exact: true }).fill(WORK_TIME_NOTE)
      await page.getByRole('button', { name: '지원 완료로 표시', exact: true }).click()
      await closeDialog(page, opener)
      const saved = await readSaved(page)
      expect(saved).toHaveLength(1)
      preservedOriginal(saved[0], saved[0].job.fetchedAt)
      const before = await catalog(page, server.origin)
      const files = await server.cacheFiles()
      expect(files).toHaveLength(1)
      const file = path.join(server.cwd, '.local', files[0])
      // Recollect the changed source after archiving only this owned cache.
      // The preceding flow separately proves unchanged warm-cache reuse.
      await writeFile(info.outputPath('cache-before-content-change.json'), await readFile(file))
      await page.goto('about:blank')
      await server.stop()
      expect(file.startsWith(`${server.cwd}${path.sep}.local${path.sep}configured-board-cache-v5-`)).toBe(true)
      await rm(file)
      await server.respond(workTimeUpstreamResponses(WORK_TIME_SCOPED))
      await server.start()
      await server.verifyProductionBytes()
      await page.goto(server.origin)
      await expect(page.locator('.city-detail-count strong')).toHaveText(['0', '0'])
      await search(page).fill('영어 GMT')
      await expect(page.locator('.city-detail-count strong')).toHaveText(['1', '1'])
      await expect(page.locator('.mini-job-title')).toHaveText([WORK_TIME_TITLES.mixed])
      await opener.click()
      await evidence(page, ['코어 근무시간', '코어 근무시간'], ['필수로 명시', '필수로 명시'],
        [seniorStatement, engineerStatement], [seniorQuote, engineerQuote], ['Senior Software Engineer', 'Software Engineer II'])
      await audit(page, info, width === 320 ? 'current-scoped-time-320.png' : undefined)
      await closeDialog(page, opener)
      const after = await catalog(page, server.origin)
      expect(after.jobs.map(job => job.id)).toEqual(before.jobs.map(job => job.id))
      const changed = after.jobs.find(job => job.id === 'greenhouse-time-dawn-4601')!
      expect(changed.workTimeRequirements).toEqual({ version: 1, rules: [
        { kind: 'core-hours', level: 'required', statement: seniorStatement, scope: 'Senior Software Engineer', evidence: { source: 'description', text: seniorQuote } },
        { kind: 'core-hours', level: 'required', statement: engineerStatement, scope: 'Software Engineer II', evidence: { source: 'description', text: engineerQuote } },
      ] })
      expect(changed.languageRequirements).toEqual(saved[0].job.languageRequirements)
      expect(changed).toMatchObject({ updatedAt: WORK_TIME_UPDATED_AT, url: 'https://example.com/jobs/time-dawn-4601', workMode: 'onsite', remoteCountries: [] })
      await navigation(page).getByRole('button', { name: /^저장한 기회/ }).click()
      await expect(page.locator('.saved-card')).toHaveCount(1)
      await page.getByRole('button', { name: '게시 상태 확인', exact: true }).click()
      await expect(page.locator('.saved-card .posting-notice.listed')).toHaveCount(1)
      await expect(page.locator('.saved-card .posting-changes')).toHaveText('모집·근무·고용·비자 · 본문 확인 필요')
      await savedSearch(page).fill('GMT')
      await expect(page.locator('.saved-card')).toHaveCount(0)
      await savedSearch(page).fill('영어 UTC')
      await expect(page.locator('.saved-card')).toHaveCount(1)
      const old = page.getByRole('button', { name: WORK_TIME_TITLES.mixed, exact: true })
      await old.click()
      await evidence(page, ['코어 근무시간', '근무시간 중첩'], ['공고 안내', '필수로 명시'],
        [WORK_TIME_CORE, WORK_TIME_OVERLAP], [coreQuote, overlapQuote])
      await expect(page.getByLabel('이 기회에 대한 나의 메모', { exact: true })).toHaveValue(WORK_TIME_NOTE)
      await expect(page.getByRole('button', { name: '지원 완료로 표시됨', exact: true })).toBeVisible()
      await closeDialog(page, old)
      expect(await readSaved(page)).toEqual(saved)
      const csvText = await csvDownload(page)
      expect(csvRows(csvText, 1)[0]).toMatchObject({
        '언어 조건': '필수로 명시: 영어',
        '시간대·협업 시간': originalSummary, '시간대·협업 시간 근거': `${coreQuote}\n\n${overlapQuote}`,
        '상태': '지원 완료', '메모': WORK_TIME_NOTE, '공개 게시 상태': '게시 확인',
        '내용 비교': '차이 있음', '저장 내용과 다른 항목': '모집·근무·고용·비자 · 본문',
        '근무 국가': '독일', '근무 국가 근거': 'Berlin, Germany',
      })
      await writeFile(info.outputPath('work-time-change.csv'), csvText)
      await writeFile(info.outputPath('same-id-work-time-change.json'), JSON.stringify({ before, after, saved, upstream: await syntheticTraffic(server, 10) }, null, 2))
      privateTraffic(traffic, server.origin)
      expect(failures).toEqual({ errors: [], resources: [] })
    } finally { await page.close(); await server.stop() }
  })
})
