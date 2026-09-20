import { expect, test } from '@playwright/test'
import type { Locator, Page, TestInfo } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { Catalog, Job, SavedJob } from '../../shared/types'
import {
  LANGUAGE_ALTERNATIVE, LANGUAGE_FETCHED_AT, LANGUAGE_FILTERS, LANGUAGE_FRENCH,
  LANGUAGE_JAPANESE, LANGUAGE_MIXED, LANGUAGE_NOTE, LANGUAGE_POOL, LANGUAGE_PROFILE,
  LANGUAGE_REMOTE, LANGUAGE_SAVED_AT, LANGUAGE_SCOPED, LANGUAGE_TITLES, LANGUAGE_UPDATED_AT,
  languageUpstreamResponses, legacyCollectedLanguageSaved, legacyLanguageJobs, legacyLanguageSaved,
} from '../fixtures/job-languages'
import { createJobLanguagesServer } from '../fixtures/job-languages-server'
import { expectInitialCatalogRequest, readServerMode, watchApiRequests } from './helpers/api-requests'
import { readSaved, waitForSavedCommit } from './helpers/saved-store'

const search = (page: Page) => page.getByRole('textbox', { name: '도시, 회사 또는 포지션 검색', exact: true })
const savedSearch = (page: Page) => page.getByRole('textbox', { name: '저장한 기회 검색', exact: true })
const navigation = (page: Page) => page.getByRole('navigation', { name: '주요 메뉴' })
const languages = (page: Page) => page.getByRole('region', { name: '공고의 언어 조건', exact: true })
const resultsTab = (page: Page, name: string) => page.locator('.results-tabs').getByRole('button', { name: new RegExp(`^${name}`) })
const languageCaution = '공고의 언어 조건 확인 필요: 영어. 요구 수준과 선택 조건은 원문 근거를 확인해 주세요.'
const mixedQuote = `Minimum requirements\n${LANGUAGE_MIXED}`
const seniorQuote = 'Basic Qualifications (2 Titles)\nSenior Software Engineer\nFluency in German.'
const engineerQuote = 'Basic Qualifications (2 Titles)\nSoftware Engineer II\nConversational German proficiency.'

async function isolate(page: Page, origin: string) {
  await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.fallback() : route.abort('blockedbyclient'))
}
async function seed(page: Page, origin: string, saved: SavedJob[] = []) {
  await isolate(page, origin)
  await page.addInitScript(({ origin, saved, profile, filters }) => {
    if (location.origin !== origin || sessionStorage.getItem('language-seeded')) return
    localStorage.setItem('orbit.v1.profile', JSON.stringify(profile))
    localStorage.setItem('orbit.v1.saved', JSON.stringify(saved))
    localStorage.setItem('orbit.v1.exploration', JSON.stringify({
      source: 'public', filters, selectedId: 'berlin', panelTab: 'cities',
      mapMode: 'flat', citySort: 'companies', light: false,
    }))
    sessionStorage.setItem('language-seeded', 'true')
  }, { origin, saved, profile: LANGUAGE_PROFILE, filters: LANGUAGE_FILTERS })
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
async function evidence(page: Page, labels: string[], kinds: string[], quotes: string[], scopes?: string[]) {
  const section = languages(page)
  await expect(section).toBeVisible()
  await expect(section.locator('summary > span:first-child')).toHaveText(labels)
  await expect(section.locator('summary > small')).toHaveText(kinds)
  if (scopes) await expect(section.locator('.language-scope')).toHaveText(scopes)
  else await expect(section.locator('.language-scope')).toHaveCount(0)
  for (const summary of await section.locator('summary').all()) {
    await summary.focus()
    await expect(summary).toBeFocused()
    await page.keyboard.press('Enter')
  }
  await expect(section.locator('details[open]')).toHaveCount(labels.length)
  await expect(section.locator('blockquote')).toHaveText(quotes)
  await expect(section.locator('.eligibility-footnote')).toHaveText('회화·비즈니스·원어민 수준 등은 공고의 표현을 그대로 남깁니다. 지원자의 언어 능력이나 조건 충족 여부를 판단한 결과는 아닙니다.')
  await section.locator('blockquote').last().scrollIntoViewIfNeeded()
}
async function audit(page: Page, info: TestInfo, screenshot?: string) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  for (const element of await page.locator('[role="dialog"], .job-languages, .job-languages blockquote').all()) {
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
    expect(decodeURIComponent(url.search)).not.toMatch(/가상 지원자|메모|영어|한국어|독일어|LANGUAGE_NOTE/)
  }
}
async function syntheticTraffic(server: Awaited<ReturnType<typeof createJobLanguagesServer>>, count: number) {
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
  expect(headers).toHaveLength(45)
  expect(headers.slice(-8)).toEqual(['원격근무 지역 판단', '원격근무 지역 원문 근거', '모집 유형', '모집 유형 근거', '언어 조건', '언어 조건 근거', '시간대·협업 시간', '시간대·협업 시간 근거'])
  expect(headers).toContain('기술·경력 근거')
  expect(values).toHaveLength(45 * count)
  return Array.from({ length: count }, (_, row) => Object.fromEntries(headers.map((header, i) => [header, values[row * 45 + i]])))
}
async function csvDownload(page: Page) {
  const event = page.waitForEvent('download')
  await page.getByRole('button', { name: 'CSV 내보내기', exact: true }).click()
  return readFile((await (await event).path())!, 'utf8')
}
function preservedMixed(record: SavedJob, oldDate = LANGUAGE_FETCHED_AT) {
  expect(record).toMatchObject({
    company: { id: 'language-aster', name: 'Aster Systems', provider: 'greenhouse', board: 'AsterLanguages45' },
    note: LANGUAGE_NOTE, status: 'applied',
    job: {
      id: 'greenhouse-language-aster-4501', source: 'greenhouse',
      url: 'https://example.com/jobs/language-aster-4501', fetchedAt: oldDate, updatedAt: LANGUAGE_UPDATED_AT,
      languageRequirements: { version: 1, rules: [
        { languages: ['en'], kind: 'required', match: 'all', evidence: { source: 'description', text: mixedQuote } },
        { languages: ['en'], kind: 'preferred', match: 'all', evidence: { source: 'description', text: mixedQuote } },
      ] },
    },
  })
}

for (const width of [1440, 320]) test.describe(`spoken languages through real four-provider collection at ${width}px`, () => {
  test.use({ viewport: { width, height: 960 }, isMobile: width === 320, hasTouch: width === 320 })

  test('language aliases find unique city, remote and other-location employers while pool and preference evidence keep their meaning', async ({ page, request, baseURL }, info) => {
    const server = await createJobLanguagesServer(info.outputPath('language-server'), await readServerMode(request, `${baseURL}/api/health`))
    const failures = browserFailures(page)
    const traffic = watchApiRequests(page)
    try {
      await server.start()
      await server.verifyProductionBytes()
      await seed(page, server.origin)
      await page.goto(server.origin)
      await expectInitialCatalogRequest(page, traffic)
      await expect(page.locator('.city-detail-count strong')).toHaveText(['2', '3'])
      await expect(page.locator('.company-card h3')).toHaveText(['Aster Systems', 'Birch Studio'])
      await expect(page.getByRole('button', { name: '전체 2개 공고 보기', exact: true })).toBeVisible()
      await expect(search(page)).toHaveAttribute('aria-description', '도시, 회사, 포지션, 기술과 공고의 언어·시간대·협업 시간 조건을 검색합니다.')
      const fresh = await catalog(page, server.origin)
      expect(fresh.jobs.map(job => job.id)).toEqual([
        'greenhouse-language-aster-4501', 'greenhouse-language-aster-4502', 'greenhouse-language-aster-4503',
        'ashby-language-birch-4504', 'lever-language-cedar-4505', 'smartrecruiters-language-dogwood-4506',
      ])
      expect(fresh.companies).toHaveLength(4)
      expect(fresh.jobs.map(job => job.languageRequirements?.rules.length)).toEqual([2, 0, 1, 2, 1, 1])
      expect(fresh.jobs.map(job => job.postingPurpose?.kind ?? null)).toEqual([null, null, 'talent-pool', null, null, null])
      expect(fresh.unmappedCount).toBe(1)

      for (const query of ['영어', 'English']) {
        await search(page).fill(query)
        await expect(page.locator('.city-detail-count strong')).toHaveText(['2', '2'])
        await expect(page.locator('.mini-job-title')).toHaveText([LANGUAGE_TITLES.mixed, LANGUAGE_TITLES.alternatives])
      }
      const mixed = page.getByRole('button', { name: LANGUAGE_TITLES.mixed, exact: true })
      await mixed.click()
      await evidence(page, ['영어', '영어'], ['필수로 명시', '우대 사항'], [mixedQuote, mixedQuote])
      await expect(page.getByRole('dialog').getByText(languageCaution, { exact: true })).toBeVisible()
      await expect(page.getByRole('link', { name: '원문에서 지원하기', exact: true })).toHaveAttribute('href', 'https://example.com/jobs/language-aster-4501')
      await audit(page, info, width === 320 ? 'required-preferred-language-320.png' : undefined)
      await closeDialog(page, mixed)

      await search(page).fill('한국어 영어')
      await expect(page.locator('.city-detail-count strong')).toHaveText(['1', '1'])
      await expect(page.locator('.mini-job-title')).toHaveText([LANGUAGE_TITLES.alternatives])
      const alternative = page.getByRole('button', { name: LANGUAGE_TITLES.alternatives, exact: true })
      await alternative.click()
      await evidence(page, ['영어 / 한국어 중 하나', '일본어'], ['자격 항목', '우대 사항'], [
        `Qualifications\n${LANGUAGE_ALTERNATIVE}`, `Preferred qualifications\n${LANGUAGE_JAPANESE}`,
      ])
      await closeDialog(page, alternative)
      await search(page).fill('일본어')
      await expect(page.locator('.city-detail-count strong')).toHaveText(['1', '1'])
      await search(page).fill('독일어')
      await expect(page.locator('.city-detail-count strong')).toHaveText(['0', '0'])

      await search(page).fill('영어')
      await resultsTab(page, '원격 기회').click()
      await expect(page.locator('.list-toolbar > span')).toHaveText('1개 회사 · 1개 공고')
      await expect(page.locator('.mini-job-title')).toHaveText([LANGUAGE_TITLES.remote])
      const remote = page.getByRole('button', { name: LANGUAGE_TITLES.remote, exact: true })
      await remote.click()
      await evidence(page, ['영어'], ['필수로 명시'], [`Minimum requirements\n${LANGUAGE_REMOTE}`])
      await closeDialog(page, remote)

      await search(page).fill('프랑스어')
      await resultsTab(page, '기타 근무지').click()
      await expect(page.locator('.list-toolbar > span')).toHaveText('1개 회사 · 1개 공고')
      await expect(page.locator('.company-card h3')).toHaveText(['Dogwood Forge'])
      const preferred = page.getByRole('button', { name: LANGUAGE_TITLES.preferred, exact: true })
      await preferred.click()
      await evidence(page, ['프랑스어'], ['우대 사항'], [`Preferred qualifications\n${LANGUAGE_FRENCH}`])
      await expect(page.getByRole('dialog').getByText(/^공고의 언어 조건 확인 필요:/)).toHaveCount(0)
      await closeDialog(page, preferred)

      await resultsTab(page, '도시 탐색').click()
      await search(page).fill('한국어')
      const filters = page.getByRole('button', { name: /^모든 필터/ })
      await filters.click()
      await page.getByLabel('모집 유형', { exact: true }).selectOption('talent-pool')
      await page.getByRole('button', { name: '1개 공고 보기', exact: true }).click()
      await expect(filters).toBeFocused()
      await expect(page.locator('.city-detail-count strong')).toHaveText(['1', '1'])
      await expect(page.locator('.mini-job-title')).toHaveText([LANGUAGE_TITLES.pool])
      await expect(page.locator('.posting-purpose-badge')).toHaveText('인재풀·관심 등록')
      const pool = page.getByRole('button', { name: LANGUAGE_TITLES.pool, exact: true })
      await pool.click()
      await evidence(page, ['영어 · 한국어 모두'], ['필수로 명시'], [`Minimum requirements\n${LANGUAGE_POOL}`])
      await expect(page.getByRole('region', { name: '모집 유형 안내', exact: true })).toBeVisible()
      await closeDialog(page, pool)
      privateTraffic(traffic, server.origin)
      expect(failures).toEqual({ errors: [], resources: [] })
      await writeFile(info.outputPath('real-language-collection.json'), JSON.stringify({ fresh, upstream: await syntheticTraffic(server, 5) }, null, 2))
    } finally { await page.close(); await server.stop() }
  })

  test('old saved language evidence enriches without a fake revision and survives AND search, cache restart, CSV and fresh JSON restore', async ({ page, browser, request, baseURL }, info) => {
    const server = await createJobLanguagesServer(info.outputPath('language-server'), await readServerMode(request, `${baseURL}/api/health`))
    const originals = [legacyCollectedLanguageSaved(), legacyLanguageSaved(legacyLanguageJobs()[3])]
    expect(originals.every(record => !record.job.languageRequirements)).toBe(true)
    const failures = browserFailures(page)
    const traffic = watchApiRequests(page)
    try {
      await server.start()
      await server.verifyProductionBytes()
      await seed(page, server.origin, originals)
      await page.goto(`${server.origin}/#saved`)
      await expectInitialCatalogRequest(page, traffic)
      await expect(page.locator('.saved-card')).toHaveCount(2)
      const before = await catalog(page, server.origin)
      const records = await readSaved(page)
      expect(records).toHaveLength(2)
      preservedMixed(records.find(record => record.job.id === 'greenhouse-language-aster-4501')!)
      expect(records.map(record => record.savedAt)).toEqual([LANGUAGE_SAVED_AT, LANGUAGE_SAVED_AT])
      for (const query of ['한국어 영어', '영어   한국어']) {
        await savedSearch(page).fill(query)
        await expect(page.locator('.saved-card h2')).toHaveText(['Birch Studio'])
        await expect(page.locator('.saved-status')).toHaveText('지원 완료')
      }
      await savedSearch(page).fill('독일어')
      await expect(page.locator('.saved-card')).toHaveCount(0)
      await savedSearch(page).fill('')
      await page.getByRole('button', { name: '게시 상태 확인', exact: true }).click()
      const aster = page.locator('.saved-card').filter({ has: page.getByRole('button', { name: LANGUAGE_TITLES.mixed, exact: true }) })
      await expect(aster.locator('.posting-notice.listed')).toHaveCount(1)
      await expect(aster.locator('.posting-notice.changed')).toHaveCount(0)
      const mixed = page.getByRole('button', { name: LANGUAGE_TITLES.mixed, exact: true })
      await mixed.click()
      await evidence(page, ['영어', '영어'], ['필수로 명시', '우대 사항'], [mixedQuote, mixedQuote])
      await expect(page.getByLabel('이 기회에 대한 나의 메모', { exact: true })).toHaveValue(LANGUAGE_NOTE)
      await expect(page.getByRole('button', { name: '지원 완료로 표시됨', exact: true })).toBeVisible()
      await audit(page, info, width === 320 ? 'old-saved-language-evidence-320.png' : undefined)
      await closeDialog(page, mixed)
      const csvText = await csvDownload(page)
      const rows = csvRows(csvText, 2)
      expect(rows.find(row => row['회사'] === 'Aster Systems')).toMatchObject({
        '상태': '지원 완료', '메모': LANGUAGE_NOTE, '저장일': LANGUAGE_SAVED_AT,
        '저장 내용의 조회 시각': LANGUAGE_FETCHED_AT, '채용 링크': 'https://example.com/jobs/language-aster-4501',
        '언어 조건': '필수로 명시: 영어\n우대 사항: 영어', '언어 조건 근거': mixedQuote,
        '공개 게시 상태': '게시 확인', '내용 비교': '표시 내용 일치', '저장 내용과 다른 항목': '',
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
      expect(cache.boards.flatMap(board => board.snapshot.jobs).map(job => job.languageRequirements?.rules.length)).toEqual([2, 0, 1, 2, 1, 1])
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
      await writeFile(info.outputPath('language-saved.csv'), csvText)
      await writeFile(info.outputPath('language-backup.json'), backupText)
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
          name: 'fictional-language-records.json', mimeType: 'application/json', buffer: Buffer.from(backupText),
        })
        await expect(target.locator('.saved-import-row')).toHaveCount(2)
        expect(await readSaved(target)).toEqual([])
        await target.getByRole('button', { name: '선택한 2개 가져오기', exact: true }).click()
        await expect(target.locator('.saved-file-message')).toContainText('선택한 2개 기록을 저장했어요.')
        await target.getByRole('button', { name: '완료', exact: true }).click()
        expect(await readSaved(target)).toEqual(records)
        await savedSearch(target).fill('한국어 영어')
        await expect(target.locator('.saved-card h2')).toHaveText(['Birch Studio'])
        await target.reload()
        await expect(target.locator('.saved-card')).toHaveCount(2)
        expect(await readSaved(target)).toEqual(records)
        expect(await target.evaluate(() => localStorage.getItem('orbit.v1.profile'))).toBeNull()
        expect(targetFailures).toEqual({ errors: [], resources: [] })
      } finally { await context.close() }
    } finally { await page.close(); await server.stop() }
  })

  test('the same upstream ID gains scoped German conditions while the saved English source, status and note remain intact', async ({ page, request, baseURL }, info) => {
    const server = await createJobLanguagesServer(info.outputPath('language-server'), await readServerMode(request, `${baseURL}/api/health`))
    const failures = browserFailures(page)
    const traffic = watchApiRequests(page)
    try {
      await server.start()
      await seed(page, server.origin)
      await page.goto(server.origin)
      await expectInitialCatalogRequest(page, traffic)
      await search(page).fill('영어 Aster')
      await expect(page.locator('.city-detail-count strong')).toHaveText(['1', '1'])
      const opener = page.getByRole('button', { name: LANGUAGE_TITLES.mixed, exact: true })
      await opener.click()
      await page.getByRole('button', { name: '기회 저장', exact: true }).click()
      await page.getByLabel('이 기회에 대한 나의 메모', { exact: true }).fill(LANGUAGE_NOTE)
      await page.getByRole('button', { name: '지원 완료로 표시', exact: true }).click()
      await closeDialog(page, opener)
      const saved = await readSaved(page)
      expect(saved).toHaveLength(1)
      preservedMixed(saved[0], saved[0].job.fetchedAt)
      const before = await catalog(page, server.origin)
      const files = await server.cacheFiles()
      expect(files).toHaveLength(1)
      const file = path.join(server.cwd, '.local', files[0])
      // This flow models a fresh collection after upstream content changes.
      // Only this owned fixture cache is archived/removed; the previous flow
      // verifies unchanged warm-cache reuse. No clock override or60s sleep.
      await writeFile(info.outputPath('cache-before-content-change.json'), await readFile(file))
      await page.goto('about:blank')
      await server.stop()
      expect(file.startsWith(`${server.cwd}${path.sep}.local${path.sep}configured-board-cache-v5-`)).toBe(true)
      await rm(file)
      await server.respond(languageUpstreamResponses(LANGUAGE_SCOPED))
      await server.start()
      await server.verifyProductionBytes()
      await page.goto(server.origin)
      await expect(page.locator('.city-detail-count strong')).toHaveText(['0', '0'])
      await search(page).fill('독일어')
      await expect(page.locator('.city-detail-count strong')).toHaveText(['1', '1'])
      await expect(page.locator('.mini-job-title')).toHaveText([LANGUAGE_TITLES.mixed])
      await opener.click()
      await evidence(page, ['독일어', '독일어'], ['필수로 명시', '필수로 명시'], [seniorQuote, engineerQuote], ['Senior Software Engineer', 'Software Engineer II'])
      await audit(page, info, width === 320 ? 'current-scoped-language-320.png' : undefined)
      await closeDialog(page, opener)
      const after = await catalog(page, server.origin)
      expect(after.jobs.map(job => job.id)).toEqual(before.jobs.map(job => job.id))
      const changed = after.jobs.find(job => job.id === 'greenhouse-language-aster-4501')!
      expect(changed.languageRequirements).toEqual({ version: 1, rules: [
        { languages: ['de'], kind: 'required', match: 'all', scope: 'Senior Software Engineer', evidence: { source: 'description', text: seniorQuote } },
        { languages: ['de'], kind: 'required', match: 'all', scope: 'Software Engineer II', evidence: { source: 'description', text: engineerQuote } },
      ] })
      expect(changed.updatedAt).toBe(LANGUAGE_UPDATED_AT)
      expect(changed.url).toBe('https://example.com/jobs/language-aster-4501')
      await navigation(page).getByRole('button', { name: /^저장한 기회/ }).click()
      await expect(page.locator('.saved-card')).toHaveCount(1)
      await page.getByRole('button', { name: '게시 상태 확인', exact: true }).click()
      await expect(page.locator('.saved-card .posting-notice.listed')).toHaveCount(1)
      await expect(page.locator('.saved-card .posting-changes')).toHaveText('기술·경력·언어 · 본문 확인 필요')
      await savedSearch(page).fill('독일어')
      await expect(page.locator('.saved-card')).toHaveCount(0)
      await savedSearch(page).fill('영어')
      await expect(page.locator('.saved-card')).toHaveCount(1)
      const old = page.getByRole('button', { name: LANGUAGE_TITLES.mixed, exact: true })
      await old.click()
      await evidence(page, ['영어', '영어'], ['필수로 명시', '우대 사항'], [mixedQuote, mixedQuote])
      await expect(page.getByLabel('이 기회에 대한 나의 메모', { exact: true })).toHaveValue(LANGUAGE_NOTE)
      await closeDialog(page, old)
      expect(await readSaved(page)).toEqual(saved)
      const csvText = await csvDownload(page)
      expect(csvRows(csvText, 1)[0]).toMatchObject({
        '언어 조건': '필수로 명시: 영어\n우대 사항: 영어', '언어 조건 근거': mixedQuote,
        '상태': '지원 완료', '메모': LANGUAGE_NOTE, '공개 게시 상태': '게시 확인',
        '내용 비교': '차이 있음', '저장 내용과 다른 항목': '기술·경력·언어 · 본문',
      })
      await writeFile(info.outputPath('language-change.csv'), csvText)
      await writeFile(info.outputPath('same-id-language-change.json'), JSON.stringify({ before, after, saved, upstream: await syntheticTraffic(server, 10) }, null, 2))
      privateTraffic(traffic, server.origin)
      expect(failures).toEqual({ errors: [], resources: [] })
    } finally { await page.close(); await server.stop() }
  })
})
