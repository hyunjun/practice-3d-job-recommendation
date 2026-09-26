import { expect, test } from '@playwright/test'
import type { Locator, Page, TestInfo } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { Catalog, Filters, Job, SavedJob } from '../../shared/types'
import {
  WORKPLACE_COUNTRY_FETCHED_AT, WORKPLACE_COUNTRY_FILTERS, WORKPLACE_COUNTRY_NOTE,
  WORKPLACE_COUNTRY_PROFILE, WORKPLACE_COUNTRY_SAVED_AT,
  workplaceCountryAshbyPostings, workplaceCountryAshbyRaw, workplaceCountryCommaResponses, workplaceCountryResponses,
} from '../fixtures/workplace-countries'
import { legacyCountrySaved } from '../fixtures/workplace-countries-legacy'
import { createWorkplaceCountriesServer } from '../fixtures/workplace-countries-server'
import { expectInitialCatalogRequest, readServerMode, watchApiRequests } from './helpers/api-requests'
import { readSaved, waitForSavedCommit } from './helpers/saved-store'

const search = (page: Page) => page.getByRole('textbox', { name: '도시, 회사 또는 포지션 검색', exact: true })
const savedSearch = (page: Page) => page.getByRole('textbox', { name: '저장한 기회 검색', exact: true })
const navigation = (page: Page) => page.getByRole('navigation', { name: '주요 메뉴' })
const resultsTab = (page: Page, name: string) => page.locator('.results-tabs').getByRole('button', { name: new RegExp(`^${name}`) })
const region = (page: Page, name: string) => page.locator('.region-tabs').getByRole('button', { name, exact: true })
const countries = (page: Page) => page.getByRole('region', { name: '확인된 근무 국가', exact: true })
const ashbyUrl = 'https://api.ashbyhq.com/posting-api/job-board/MossCountries55?includeCompensation=true'
const allIds = [
  'greenhouse-country-fern-5501', 'greenhouse-country-fern-5502', 'greenhouse-country-fern-5503',
  'greenhouse-country-fern-5504', 'greenhouse-country-fern-5505', 'greenhouse-country-fern-5506',
  'greenhouse-country-fern-5507', 'greenhouse-country-fern-5508', 'greenhouse-country-fern-5509',
  'greenhouse-country-fern-5510', 'ashby-country-moss-5511', 'ashby-country-moss-5512',
  'ashby-country-moss-5513', 'ashby-country-moss-5514', 'ashby-country-moss-5515', 'ashby-country-moss-5516',
  'lever-country-wren-5521', 'lever-country-wren-5522', 'lever-country-wren-5523',
  'smartrecruiters-country-cove-5531', 'smartrecruiters-country-cove-5532', 'smartrecruiters-country-cove-5533',
]

async function isolate(page: Page, origin: string) {
  await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.fallback() : route.abort('blockedbyclient'))
}

async function seed(page: Page, origin: string, options: {
  saved?: SavedJob[]
  filters?: Filters
  tab?: 'cities' | 'unmapped' | 'remote'
} = {}) {
  await isolate(page, origin)
  await page.addInitScript(({ origin, profile, filters, saved, tab }) => {
    if (location.origin !== origin || sessionStorage.getItem('country-fixture-seeded')) return
    localStorage.setItem('orbit.v1.profile', JSON.stringify(profile))
    localStorage.setItem('orbit.v1.saved', JSON.stringify(saved))
    localStorage.setItem('orbit.v1.exploration', JSON.stringify({
      source: 'public', filters, selectedId: null, panelTab: tab, mapMode: 'flat',
    }))
    sessionStorage.setItem('country-fixture-seeded', 'true')
  }, {
    origin, profile: WORKPLACE_COUNTRY_PROFILE, filters: options.filters ?? WORKPLACE_COUNTRY_FILTERS,
    saved: options.saved ?? [], tab: options.tab ?? 'unmapped',
  })
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

async function catalog(page: Page, origin: string): Promise<Catalog> {
  let completed: Catalog | undefined
  await expect.poll(async () => {
    const response = await page.request.get(`${origin}/api/catalog?source=public`)
    try {
      expect([200, 202]).toContain(response.status())
      if (response.status() === 200) completed = await response.json()
      return response.status()
    } finally { await response.dispose() }
  }, 'The real collector must finish the fictional boards').toBe(200)
  return completed!
}

async function closeDialog(page: Page, opener: Locator) {
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(opener).toBeFocused()
}

async function countryEvidence(page: Page, names: string, quotes: string[]) {
  const section = countries(page)
  await expect(section.getByRole('heading', { name: '확인된 근무 국가', exact: true })).toBeVisible()
  await expect(section.locator(':scope > p').first()).toHaveText(names)
  const disclosure = section.getByText('근무 국가의 근거', { exact: true })
  await disclosure.focus()
  await page.keyboard.press('Enter')
  await expect(section.locator('details')).toHaveJSProperty('open', true)
  await expect(disclosure).toBeFocused()
  expect(await disclosure.evaluate(element => element.matches(':focus-visible'))).toBe(true)
  await expect(section.locator('blockquote')).toHaveText(quotes)
}

async function audit(page: Page, info: TestInfo, screenshot?: string) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  for (const element of await page.locator('[role="dialog"], .job-location-details, .job-location-details blockquote').all()) {
    expect(await element.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true)
  }
  expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze()).violations).toEqual([])
  if (screenshot) await info.attach(screenshot, { body: await page.screenshot(), contentType: 'image/png' })
}

async function expandedTitles(page: Page, expected: string[]) {
  const expand = page.getByRole('button', { name: /^전체 \d+개 공고 보기$/ })
  while (await expand.count()) await expand.first().click()
  await expect(page.locator('.mini-job-title')).toHaveCount(expected.length)
  expect((await page.locator('.mini-job-title').allTextContents()).sort()).toEqual(expected)
}

async function syntheticTraffic(server: Awaited<ReturnType<typeof createWorkplaceCountriesServer>>, expected: number) {
  const upstream = await server.requests()
  expect(upstream).toHaveLength(expected)
  expect(upstream.every(item => item.synthetic && !item.networkSent && item.method === 'GET')).toBe(true)
  expect(await readFile(server.defaultCache, 'utf8')).toBe(server.defaultBytes)
  return upstream
}

function privateTraffic(traffic: ReturnType<typeof watchApiRequests>, origin: string) {
  for (const request of traffic.requests) {
    const url = new URL(request.url)
    expect(url.origin).toBe(origin)
    expect(['/api/catalog', '/api/catalog/progress', '/api/posting-status']).toContain(url.pathname)
    expect(request.method).toBe('GET')
    expect(request.body).toBeNull()
    expect(decodeURIComponent(url.search)).not.toMatch(/가상|지원|메모|Ledger|Compass|에스토니아|Estonia|말레이시아/)
  }
}

function csvRows(text: string, count: number) {
  const cells = (value: string) => [...value.matchAll(/"((?:[^"]|"")*)"(?:,|\r\n|$)/g)].map(match => match[1].replaceAll('""', '"'))
  const end = text.indexOf('\r\n')
  const headers = cells(text.slice(0, end))
  const values = cells(text.slice(end + 2))
  expect(headers).toHaveLength(48)
  expect(headers.slice(0, 47)).toEqual([
    '회사', '포지션', '근무지', '데이터', '상태', '저장일', '메모', '채용 링크', '연봉', '보상 조건', '보상 근거',
    '기술 조건', '경력 조건', '기술·경력 근거', '공개 게시 상태', '게시 목록 확인 시각', '내용 비교', '저장 내용과 다른 항목',
    '비자 지원', '취업 자격 조건', '취업 자격 근거', '직무 분류', '직무 분류 근거', '탐색 직군', '탐색 직군 근거',
    '저장 내용의 조회 시각', '내보낼 때의 조회 기록', '내보낸 시각', '근무지 판단', '원래 게시 위치', '본문의 근무지',
    '근무지 원문 근거', '명시된 원격근무 국가·지역', '원격근무 국가 코드', '원격근무 추가 확인', '고용 형태',
    '고용 형태 근거', '원격근무 지역 판단', '원격근무 지역 원문 근거', '모집 유형', '모집 유형 근거', '언어 조건',
    '언어 조건 근거', '시간대·협업 시간', '시간대·협업 시간 근거', '근무 국가', '근무 국가 근거',
  ])
  expect(headers[47]).toBe('공고 내용 확인 시각')
  expect(values).toHaveLength(48 * count)
  return Array.from({ length: count }, (_, row) => Object.fromEntries(headers.map((header, column) => [header, values[row * 48 + column]])))
}

async function downloadCsv(page: Page) {
  const download = page.waitForEvent('download')
  await page.getByRole('button', { name: 'CSV 내보내기', exact: true }).click()
  return readFile((await (await download).path())!, 'utf8')
}

async function ownedCache(server: Awaited<ReturnType<typeof createWorkplaceCountriesServer>>) {
  const files = await server.cacheFiles()
  expect(files).toHaveLength(1)
  const file = path.join(server.cwd, '.local', files[0])
  expect(file.startsWith(`${server.cwd}${path.sep}.local${path.sep}configured-board-cache-v5-`)).toBe(true)
  return file
}

for (const width of [1440, 320]) test.describe(`confirmed workplace countries at ${width}px`, () => {
  test.use({ viewport: { width, height: 960 }, isMobile: width === 320, hasTouch: width === 320 })

  test('an unmapped Tallinn, Estonia posting visible worldwide remains discoverable in Europe Other locations', async ({ page, request, baseURL }, info) => {
    const server = await createWorkplaceCountriesServer(info.outputPath('country-server'), await readServerMode(request, `${baseURL}/api/health`), 'baseline')
    const traffic = watchApiRequests(page)
    try {
      await server.start()
      await server.verifyProductionBytes()
      await seed(page, server.origin)
      await page.goto(server.origin)
      await expectInitialCatalogRequest(page, traffic)
      await expect(resultsTab(page, '기타 근무지')).toHaveAttribute('aria-pressed', 'true')
      await expect(page.locator('.mini-job-title')).toHaveText(['Backend Engineer — Lantern Ledger'])
      await expect(page.locator('.mini-job-location')).toHaveText(['Tallinn, Estonia'])
      await expect(page.locator('.list-toolbar > span')).toHaveText('1개 회사 · 1개 공고')
      await expect(page.locator('.map-stats strong')).toHaveText(['1곳', '0곳'])
      const fresh = await catalog(page, server.origin)
      expect(fresh.jobs).toHaveLength(1)
      expect(fresh.jobs[0]).toMatchObject({
        id: 'greenhouse-country-fern-5501', companyId: 'country-fern',
        title: 'Backend Engineer — Lantern Ledger', locationLabel: 'Tallinn, Estonia',
        cityIds: [], workMode: 'onsite', remoteCountries: [], remoteWorldwide: false,
      })
      expect(fresh.unmappedCount).toBe(1)
      await info.attach('literal-worldwide-posting', {
        body: JSON.stringify({ companies: fresh.companies, jobs: fresh.jobs, unmappedCount: fresh.unmappedCount }, null, 2),
        contentType: 'application/json',
      })
      await region(page, '유럽').click()
      await expect(region(page, '유럽')).toHaveAttribute('aria-pressed', 'true')
      // The same strict parent-baseline outcome: no invented city or remote work.
      await expect(page.locator('.mini-job-title')).toHaveText(['Backend Engineer — Lantern Ledger'])
      await expect(page.locator('.list-toolbar > span')).toHaveText('1개 회사 · 1개 공고')
      await expect(page.locator('.map-stats strong')).toHaveText(['1곳', '0곳'])
      const dataButton = page.getByRole('button', { name: '데이터와 추천 방식', exact: true })
      await dataButton.click()
      const data = page.getByRole('dialog')
      for (const label of ['대상 회사', '조회된 개발 공고']) {
        await expect(data.locator('.coverage-stats > div').filter({ has: page.getByText(label, { exact: true }) }).locator('strong')).toHaveText('1')
      }
      const coverage = data.locator('.data-explanation').filter({
        has: page.getByRole('heading', { name: '지도에 표시하는 도시', exact: true }),
      })
      const note = coverage.locator(':scope > p').first()
      await expect(note).toHaveText('지도에 연결되지 않은 1개 개발 공고도 ‘기타 근무지’에서 검색·열람·저장할 수 있어요. 국가가 확인된 공고는 해당 지역에서도 표시하고, 국가가 미확인인 공고는 ‘전 세계’에서 찾을 수 있어요. 도시와 원격 기회에 임의로 포함하지 않아요.')
      await note.scrollIntoViewIfNeeded()
      await expect(note).toBeVisible()
      const bounds = await note.evaluate(element => {
        const rect = element.getBoundingClientRect()
        const frame = element.closest('dialog, [role="dialog"]')!.getBoundingClientRect()
        return {
          left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom,
          frameLeft: Math.max(0, frame.left), frameRight: Math.min(innerWidth, frame.right),
          frameTop: Math.max(0, frame.top), frameBottom: Math.min(innerHeight, frame.bottom),
          scrollWidth: element.scrollWidth, clientWidth: element.clientWidth,
          unobscured: element.contains(document.elementFromPoint((rect.left + rect.right) / 2, (rect.top + rect.bottom) / 2)),
        }
      })
      expect(bounds.left).toBeGreaterThanOrEqual(bounds.frameLeft)
      expect(bounds.right).toBeLessThanOrEqual(bounds.frameRight)
      expect(bounds.top).toBeGreaterThanOrEqual(bounds.frameTop)
      expect(bounds.bottom).toBeLessThanOrEqual(bounds.frameBottom)
      expect(bounds.scrollWidth).toBeLessThanOrEqual(bounds.clientWidth)
      expect(bounds.unobscured).toBe(true)
      await audit(page, info, `country-coverage-note-${width}.png`)
      await closeDialog(page, dataButton)
      await expect(region(page, '유럽')).toHaveAttribute('aria-pressed', 'true')
      await expect(resultsTab(page, '기타 근무지')).toHaveAttribute('aria-pressed', 'true')
      await expect(page.locator('.mini-job-title')).toHaveText(['Backend Engineer — Lantern Ledger'])
      await expect(page.locator('.list-toolbar > span')).toHaveText('1개 회사 · 1개 공고')
      await expect(page.locator('.map-stats strong')).toHaveText(['1곳', '0곳'])
      await syntheticTraffic(server, 1)
      privateTraffic(traffic, server.origin)
    } finally { await page.close(); await server.stop() }
  })

  test('Europe, Asia, Americas and world use literal country sources while keeping mapped, remote and employer totals disjoint', async ({ page, request, baseURL }, info) => {
    const server = await createWorkplaceCountriesServer(info.outputPath('country-server'), await readServerMode(request, `${baseURL}/api/health`))
    const traffic = watchApiRequests(page)
    const failures = browserFailures(page)
    try {
      await server.start()
      await server.verifyProductionBytes()
      await seed(page, server.origin)
      await page.goto(server.origin)
      const initial = await expectInitialCatalogRequest(page, traffic)
      await expect(page.locator('.list-toolbar > span')).toHaveText('4개 회사 · 20개 공고')
      const fresh = await catalog(page, server.origin)
      expect(fresh.jobs.map(job => job.id)).toEqual(allIds)
      expect(fresh.unmappedCount).toBe(20)
      expect(fresh.companies).toHaveLength(4)
      await region(page, '유럽').click()
      await expect(page.locator('.list-toolbar > span')).toHaveText('3개 회사 · 5개 공고')
      await expandedTitles(page, [
        'Backend Engineer — Atlas Bridge', 'Backend Engineer — Fern Compass', 'Backend Engineer — Half Compass',
        'Backend Engineer — Lantern Ledger', 'Backend Engineer — Twin Router',
      ])
      await expect(page.locator('.map-stats strong')).toHaveText(['3곳', '1곳'])
      await audit(page, info, `europe-country-results-${width}.png`)
      if (width === 320) await region(page, '아시아 · 태평양').tap()
      else await region(page, '아시아 · 태평양').click()
      await expect(page.locator('.list-toolbar > span')).toHaveText('4개 회사 · 6개 공고')
      await expandedTitles(page, [
        'Backend Engineer — Atlas Bridge', 'Backend Engineer — Coast Gauge', 'Backend Engineer — Fern Compass',
        'Backend Engineer — Reed Compass', 'Backend Engineer — Tide Channel', 'Backend Engineer — Twin Router',
      ])
      await expect(page.locator('.map-stats strong')).toHaveText(['4곳', '0곳'])
      await resultsTab(page, '원격 기회').click()
      await expect(page.locator('.mini-job-title')).toHaveText(['Backend Engineer — Cloud Current'])
      await expect(page.locator('.list-toolbar > span')).toHaveText('1개 회사 · 1개 공고')
      await resultsTab(page, '도시 탐색').click()
      await expect(page.locator('.city-row')).toHaveCount(0)
      await resultsTab(page, '기타 근무지').click()
      await region(page, '미주').click()
      await expect(page.locator('.list-toolbar > span')).toHaveText('4개 회사 · 5개 공고')
      await expandedTitles(page, [
        'Backend Engineer — Harbor Post', 'Backend Engineer — Hollow Router', 'Backend Engineer — Maple Compass',
        'Backend Engineer — Rain Router', 'Backend Engineer — Stone Channel',
      ])
      await region(page, '전 세계').click()
      await expect(page.locator('.list-toolbar > span')).toHaveText('4개 회사 · 20개 공고')
      await expandedTitles(page, [
        'Backend Engineer — Atlas Bridge', 'Backend Engineer — Cedar Dial', 'Backend Engineer — Coast Gauge',
        'Backend Engineer — Fern Compass', 'Backend Engineer — Fog Signal', 'Backend Engineer — Glass Compass',
        'Backend Engineer — Half Compass', 'Backend Engineer — Harbor Post', 'Backend Engineer — Hollow Router',
        'Backend Engineer — Lantern Ledger', 'Backend Engineer — Maple Compass', 'Backend Engineer — Paper Compass',
        'Backend Engineer — Quartz Relay', 'Backend Engineer — Quiet Channel', 'Backend Engineer — Rain Router',
        'Backend Engineer — Reed Compass', 'Backend Engineer — Split Gauge', 'Backend Engineer — Stone Channel',
        'Backend Engineer — Tide Channel', 'Backend Engineer — Twin Router',
      ])
      await expect(page.locator('.map-stats strong')).toHaveText(['4곳', '1곳'])
      await region(page, '유럽').click()
      for (const query of ['Ledger 에스토니아', 'Ledger Estonia', 'Ledger EST']) {
        await search(page).fill(query)
        await expect(page.locator('.mini-job-title')).toHaveText(['Backend Engineer — Lantern Ledger'])
      }
      await region(page, '아시아 · 태평양').click()
      await expect(page.locator('.list-toolbar > span')).toHaveText('0개 회사 · 0개 공고')
      await expect(search(page)).toHaveValue('Ledger EST')
      await region(page, '전 세계').click()
      await expect(page.locator('.mini-job-title')).toHaveText(['Backend Engineer — Lantern Ledger'])
      if (width === 320) {
        for (const button of await page.locator('.region-tabs button').all()) {
          await button.scrollIntoViewIfNeeded()
          const box = await button.boundingBox()
          expect(box).not.toBeNull()
          expect(box!.width).toBeGreaterThanOrEqual(44)
          expect(box!.height).toBeGreaterThanOrEqual(44)
          expect(box!.x).toBeGreaterThanOrEqual(0)
          expect(box!.x + box!.width).toBeLessThanOrEqual(320)
        }
      }
      expect(traffic.catalog()).toHaveLength(initial.attempts)
      privateTraffic(traffic, server.origin)
      expect(failures).toEqual({ errors: [], resources: [] })
      await writeFile(info.outputPath('country-collection.json'), JSON.stringify({ fresh, upstream: await syntheticTraffic(server, 7) }, null, 2))
    } finally { await page.close(); await server.stop() }
  })

  test('regional recovery keeps confirmed work in Europe and discloses world-only recovery for unconfirmed work', async ({ page, request, baseURL }, info) => {
    const server = await createWorkplaceCountriesServer(info.outputPath('country-server'), await readServerMode(request, `${baseURL}/api/health`))
    const traffic = watchApiRequests(page)
    try {
      await server.start()
      await server.verifyProductionBytes()
      await seed(page, server.origin, { filters: { ...WORKPLACE_COUNTRY_FILTERS, query: 'Ledger', region: 'europe' }, tab: 'cities' })
      await page.goto(server.origin)
      await expectInitialCatalogRequest(page, traffic)
      await expect(page.locator('.city-row')).toHaveCount(0)
      const alternative = page.getByRole('button', { name: /기타 근무지 보기/ })
      await expect(alternative).toContainText('회사 1곳 · 공고 1개')
      await alternative.focus()
      await page.keyboard.press('Enter')
      await expect(page.locator('.results-panel')).toBeFocused()
      await expect(region(page, '유럽')).toHaveAttribute('aria-pressed', 'true')
      await expect(page.locator('.mini-job-title')).toHaveText(['Backend Engineer — Lantern Ledger'])
      await expect(page.locator('.unmapped-range-note')).toHaveText('국가가 확인된 공고는 해당 지역에서도 표시해요. 국가가 미확인인 근무지는 ‘전 세계’에서 찾고, 공고에 적힌 지역명으로 검색할 수 있어요.')
      await search(page).fill('Fog')
      await expect(page.locator('.mini-job-title')).toHaveCount(0)
      const options = page.locator('.recovery-option')
      await expect(options).toHaveCount(2)
      await expect(options.locator('dt')).toHaveText(['검색어', '탐색 지역'])
      const clearQuery = options.filter({ has: page.getByText('검색어', { exact: true }) })
      await expect(clearQuery.locator('dd span').first()).toHaveText('“Fog”')
      await expect(clearQuery.locator('dd strong')).toHaveText('검색어 지우기')
      await expect(clearQuery.getByRole('button', { name: '회사 3곳 · 공고 5개 보기', exact: true })).toBeVisible()
      await expect(clearQuery.locator('.recovery-warning')).toHaveCount(0)
      const world = options.filter({ has: page.getByText('탐색 지역', { exact: true }) })
      await expect(world.locator('dd span').first()).toHaveText('유럽')
      await expect(world.locator('dd strong')).toHaveText('전 세계')
      await expect(world.locator('.recovery-warning')).toHaveText('지역을 구분하지 않고 표시합니다. 기존에 선택한 지역의 공고라는 뜻은 아니에요.')
      await world.getByRole('button', { name: '회사 1곳 · 공고 1개 보기', exact: true }).click()
      await expect(region(page, '전 세계')).toHaveAttribute('aria-pressed', 'true')
      await expect(page.locator('.mini-job-title')).toHaveText(['Backend Engineer — Fog Signal'])
      await expect(page.locator('.mini-job-location')).toHaveText('N/A')
      await page.getByRole('button', { name: '실행 취소', exact: true }).click()
      await expect(region(page, '유럽')).toHaveAttribute('aria-pressed', 'true')
      await expect(page.locator('.mini-job-title')).toHaveCount(0)
      await expect(search(page)).toHaveValue('Fog')
      const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('orbit.v1.exploration') || '{}'))
      expect(stored.filters).toEqual({ ...WORKPLACE_COUNTRY_FILTERS, query: 'Fog', region: 'europe' })
      expect(stored.panelTab).toBe('unmapped')
      await syntheticTraffic(server, 7)
      privateTraffic(traffic, server.origin)
    } finally { await page.close(); await server.stop() }
  })

  test('unknown structured and conflicting countries remain global-only while a separate confirmed source stays regional', async ({ page, request, baseURL }, info) => {
    const server = await createWorkplaceCountriesServer(info.outputPath('country-server'), await readServerMode(request, `${baseURL}/api/health`))
    const traffic = watchApiRequests(page)
    try {
      await server.start()
      await server.verifyProductionBytes()
      await seed(page, server.origin)
      await page.goto(server.origin)
      await expectInitialCatalogRequest(page, traffic)
      for (const example of [
        {
          query: 'Paper Compass', title: 'Backend Engineer — Paper Compass', conflict: false,
          quotes: ['Tallinn, Estonia\n국가: N/A'],
        },
        {
          query: 'Glass Compass', title: 'Backend Engineer — Glass Compass', conflict: true,
          quotes: ['Tallinn, Estonia\n국가: MY'],
        },
        {
          query: 'Split Gauge', title: 'Backend Engineer — Split Gauge', conflict: true,
          quotes: ['Seoul', 'This role is based in our London office.'],
        },
      ]) {
        await region(page, '전 세계').click()
        await search(page).fill(example.query)
        await expect(page.locator('.mini-job-title')).toHaveText([example.title])
        const opener = page.getByRole('button', { name: example.title, exact: true })
        await opener.click()
        await countryEvidence(page, '확인 필요', example.quotes)
        await expect(countries(page).getByText('일부 근무지의 국가 정보가 서로 달라요. 아래 근거와 원문을 확인해 주세요.', { exact: true })).toHaveCount(example.conflict ? 1 : 0)
        await expect(page.locator('.remote-scope')).toHaveCount(0)
        await closeDialog(page, opener)
        for (const scope of ['유럽', '아시아 · 태평양', '미주']) {
          await region(page, scope).click()
          await expect(page.locator('.list-toolbar > span')).toHaveText('0개 회사 · 0개 공고')
          await expect(page.locator('.mini-job-title')).toHaveCount(0)
        }
      }
      await region(page, '전 세계').click()
      await search(page).fill('Hollow Router')
      const separate = page.getByRole('button', { name: 'Backend Engineer — Hollow Router', exact: true })
      await separate.click()
      await countryEvidence(page, '캐나다', ['Wren Annex\n국가: XX', 'Canada'])
      await expect(countries(page).getByText('국가가 직접 표기되지 않았거나 미확인인 근무지도 있어요. 확인된 국가를 기준으로 표시해요.', { exact: true })).toBeVisible()
      await closeDialog(page, separate)
      await region(page, '미주').click()
      await expect(page.locator('.mini-job-title')).toHaveText(['Backend Engineer — Hollow Router'])
      await expect(page.locator('.list-toolbar > span')).toHaveText('1개 회사 · 1개 공고')
      await syntheticTraffic(server, 7)
      privateTraffic(traffic, server.origin)
    } finally { await page.close(); await server.stop() }
  })

  test('country evidence and aliases survive saves, filtered whole-collection CSV and fresh-context JSON restore', async ({ page, browser, request, baseURL }, info) => {
    const server = await createWorkplaceCountriesServer(info.outputPath('country-server'), await readServerMode(request, `${baseURL}/api/health`))
    const traffic = watchApiRequests(page)
    const failures = browserFailures(page)
    try {
      await server.start()
      await server.verifyProductionBytes()
      await seed(page, server.origin)
      await page.goto(server.origin)
      await expectInitialCatalogRequest(page, traffic)
      await search(page).fill('Ledger')
      const ledger = page.getByRole('button', { name: 'Backend Engineer — Lantern Ledger', exact: true })
      await ledger.click()
      await countryEvidence(page, '에스토니아', ['Tallinn, Estonia'])
      await expect(page.locator('.remote-scope')).toHaveCount(0)
      await page.getByRole('button', { name: '기회 저장', exact: true }).click()
      await page.getByLabel('이 기회에 대한 나의 메모', { exact: true }).fill(WORKPLACE_COUNTRY_NOTE)
      await page.getByRole('button', { name: '지원 완료로 표시', exact: true }).click()
      await closeDialog(page, ledger)
      await search(page).fill('Fern Compass')
      const compass = page.getByRole('button', { name: 'Backend Engineer — Fern Compass', exact: true })
      await compass.click()
      await countryEvidence(page, '에스토니아 · 말레이시아', ['Tallinn\n국가: EE', 'Petaling Jaya\n국가: MYS'])
      await audit(page, info, `structured-country-evidence-${width}.png`)
      await page.getByRole('button', { name: '기회 저장', exact: true }).click()
      await closeDialog(page, compass)
      await search(page).fill('Cedar Dial')
      const ambiguous = page.getByRole('button', { name: 'Backend Engineer — Cedar Dial', exact: true })
      await ambiguous.click()
      await countryEvidence(page, '확인 필요', ['CA'])
      await page.getByRole('button', { name: '기회 저장', exact: true }).click()
      await closeDialog(page, ambiguous)
      await resultsTab(page, '원격 기회').click()
      await search(page).fill('Cloud Current')
      const remote = page.getByRole('button', { name: 'Backend Engineer — Cloud Current', exact: true })
      await remote.click()
      await expect(countries(page)).toHaveCount(0)
      await expect(page.locator('.remote-scope p')).toHaveText('말레이시아')
      await page.getByRole('button', { name: '기회 저장', exact: true }).click()
      await closeDialog(page, remote)
      await navigation(page).getByRole('button', { name: /^저장한 기회/ }).click()
      await expect(page.locator('.saved-card')).toHaveCount(4)
      const records = await readSaved(page)
      expect(records.map(record => record.job.id).sort()).toEqual([
        'ashby-country-moss-5512', 'greenhouse-country-fern-5501', 'greenhouse-country-fern-5503', 'greenhouse-country-fern-5508',
      ])
      expect(records.find(record => record.job.id === 'greenhouse-country-fern-5501')).toMatchObject({
        note: WORKPLACE_COUNTRY_NOTE, status: 'applied', job: { workplaceLocations: { version: 1, locations: [{ label: 'Tallinn, Estonia' }] } },
      })
      expect(records.find(record => record.job.id === 'ashby-country-moss-5512')?.job.workplaceLocations).toEqual({
        version: 1, locations: [{ label: 'Tallinn', country: 'EE' }, { label: 'Petaling Jaya', country: 'MYS' }],
      })
      for (const query of ['Ledger 에스토니아', 'Ledger Estonia', 'Ledger EST']) {
        await savedSearch(page).fill(query)
        await expect(page.locator('.saved-title')).toHaveText(['Backend Engineer — Lantern Ledger'])
      }
      const csvText = await downloadCsv(page)
      const csv = csvRows(csvText, 4)
      expect(csv.find(row => row['포지션'] === 'Backend Engineer — Lantern Ledger')).toMatchObject({
        '근무 국가': '에스토니아', '근무 국가 근거': 'Tallinn, Estonia', '상태': '지원 완료', '메모': WORKPLACE_COUNTRY_NOTE,
      })
      expect(csv.find(row => row['포지션'] === 'Backend Engineer — Fern Compass')).toMatchObject({
        '근무 국가': '에스토니아 · 말레이시아', '근무 국가 근거': 'Tallinn\n국가: EE\n\nPetaling Jaya\n국가: MYS',
      })
      expect(csv.find(row => row['포지션'] === 'Backend Engineer — Cedar Dial')).toMatchObject({ '근무 국가': '확인 필요', '근무 국가 근거': 'CA' })
      expect(csv.find(row => row['포지션'] === 'Backend Engineer — Cloud Current')).toMatchObject({
        '근무 국가': '', '근무 국가 근거': '', '명시된 원격근무 국가·지역': '말레이시아', '원격근무 국가 코드': 'MY',
      })
      expect(csvText).not.toContain(WORKPLACE_COUNTRY_PROFILE.name)
      await page.getByRole('button', { name: '기록 백업·복원', exact: true }).click()
      const download = page.waitForEvent('download')
      await page.getByRole('button', { name: 'JSON 백업', exact: true }).click()
      const backupText = await readFile((await (await download).path())!, 'utf8')
      expect(JSON.parse(backupText).records).toEqual(records)
      expect(JSON.parse(backupText)).not.toHaveProperty('profile')
      expect(backupText).not.toContain(WORKPLACE_COUNTRY_PROFILE.name)
      await page.getByRole('button', { name: '완료', exact: true }).click()
      const context = await browser.newContext({ viewport: { width, height: 960 }, isMobile: width === 320, hasTouch: width === 320 })
      try {
        const target = await context.newPage()
        await isolate(target, server.origin)
        await target.goto(`${server.origin}/#saved`)
        await waitForSavedCommit(target)
        await target.getByRole('button', { name: '기록 백업·복원', exact: true }).click()
        await target.getByLabel('백업 또는 복구 파일', { exact: true }).setInputFiles({
          name: 'fictional-workplace-countries.json', mimeType: 'application/json', buffer: Buffer.from(backupText),
        })
        await expect(target.locator('.saved-import-row')).toHaveCount(4)
        expect(await readSaved(target)).toEqual([])
        await target.getByRole('button', { name: '선택한 4개 가져오기', exact: true }).click()
        await expect(target.locator('.saved-file-message')).toContainText('선택한 4개 기록을 저장했어요.')
        await target.getByRole('button', { name: '완료', exact: true }).click()
        expect(await readSaved(target)).toEqual(records)
        await savedSearch(target).fill('Compass MYS')
        await expect(target.locator('.saved-title')).toHaveText(['Backend Engineer — Fern Compass'])
        await target.reload()
        await expect(target.locator('.saved-card')).toHaveCount(4)
        expect(await readSaved(target)).toEqual(records)
        expect(await target.evaluate(() => localStorage.getItem('orbit.v1.profile'))).toBeNull()
      } finally { await context.close() }
      await writeFile(info.outputPath('country-saved.csv'), csvText)
      await writeFile(info.outputPath('country-backup.json'), backupText)
      await syntheticTraffic(server, 7)
      privateTraffic(traffic, server.origin)
      expect(failures).toEqual({ errors: [], resources: [] })
    } finally { await page.close(); await server.stop() }
  })

  test('a literal legacy saved label gains justified country search without a false change and retains the warm cache across restart', async ({ page, request, baseURL }, info) => {
    const server = await createWorkplaceCountriesServer(info.outputPath('country-server'), await readServerMode(request, `${baseURL}/api/health`))
    const original = legacyCountrySaved()
    const traffic = watchApiRequests(page)
    try {
      await server.start()
      await server.verifyProductionBytes()
      await seed(page, server.origin, {
        saved: [original], filters: { ...WORKPLACE_COUNTRY_FILTERS, query: 'Ledger', region: 'europe' },
      })
      await page.goto(`${server.origin}/#saved`)
      await expect(page.locator('.saved-title')).toHaveText(['Backend Engineer — Lantern Ledger'])
      expect(traffic.requests).toEqual([])
      expect(await server.requests()).toHaveLength(0)
      await page.getByRole('button', { name: '데이터와 추천 방식', exact: true }).click()
      await page.getByRole('dialog').getByRole('button', { name: '공개 공고 다시 조회', exact: true }).click()
      // Ten Greenhouse, six Ashby, three Lever and three SmartRecruiters jobs;
      // the separate Other locations result count is twenty.
      await expect(page.getByRole('dialog').locator('.coverage-stats strong')).toHaveText(['22', '4', '22'])
      await expect(page.locator('.data-loading')).toHaveCount(0)
      await page.getByRole('button', { name: '닫기', exact: true }).click()
      await savedSearch(page).fill('Ledger 에스토니아')
      await expect(page.locator('.saved-title')).toHaveText(['Backend Engineer — Lantern Ledger'])
      const before = await catalog(page, server.origin)
      const records = await readSaved(page)
      expect(records).toHaveLength(1)
      expect(records[0]).toMatchObject({
        note: WORKPLACE_COUNTRY_NOTE, status: 'applied', savedAt: WORKPLACE_COUNTRY_SAVED_AT,
        job: { id: 'greenhouse-country-fern-5501', locationLabel: 'Tallinn, Estonia', fetchedAt: WORKPLACE_COUNTRY_FETCHED_AT, cityIds: [], remoteCountries: [] },
      })
      expect(records[0].job.workplaceLocations).toBeUndefined()
      await page.getByRole('button', { name: '게시 상태 확인', exact: true }).click()
      await expect(page.locator('.posting-notice.listed')).toHaveCount(1)
      await expect(page.locator('.posting-notice.changed')).toHaveCount(0)
      expect(await readSaved(page)).toEqual(records)
      const csv = csvRows(await downloadCsv(page), 1)[0]
      expect(csv).toMatchObject({
        '근무 국가': '에스토니아', '근무 국가 근거': 'Tallinn, Estonia', '내용 비교': '표시 내용 일치',
        '저장 내용과 다른 항목': '', '메모': WORKPLACE_COUNTRY_NOTE, '상태': '지원 완료', '저장일': WORKPLACE_COUNTRY_SAVED_AT,
      })
      const cacheFile = await ownedCache(server)
      const cacheBefore = await readFile(cacheFile, 'utf8')
      const cache = JSON.parse(cacheBefore) as { boards: { snapshot: { jobs: Job[] } }[] }
      const storedJobs = cache.boards.flatMap(board => board.snapshot.jobs)
      expect(storedJobs.map(job => job.id)).toEqual(allIds)
      expect(storedJobs.find(job => job.id === 'ashby-country-moss-5512')?.workplaceLocations).toEqual({
        version: 1, locations: [{ label: 'Tallinn', country: 'EE' }, { label: 'Petaling Jaya', country: 'MYS' }],
      })
      expect(storedJobs.find(job => job.id === 'lever-country-wren-5522')?.workplaceLocations).toEqual({
        version: 1, locations: [{ label: 'Wren Annex', country: 'EE' }, { label: 'Petaling Jaya, Malaysia' }],
      })
      await page.goto('about:blank')
      await server.stop()
      await server.start()
      await server.verifyProductionBytes()
      await page.goto(`${server.origin}/#saved`)
      await expect(page.locator('.saved-title')).toHaveText(['Backend Engineer — Lantern Ledger'])
      expect(await readSaved(page)).toEqual(records)
      expect((await catalog(page, server.origin)).jobs).toEqual(before.jobs)
      expect(await readFile(cacheFile, 'utf8')).toBe(cacheBefore)
      await navigation(page).getByRole('button', { name: '기회 탐색', exact: true }).click()
      await expect(region(page, '유럽')).toHaveAttribute('aria-pressed', 'true')
      await expect(search(page)).toHaveValue('Ledger')
      await expect(page.locator('.mini-job-title')).toHaveText(['Backend Engineer — Lantern Ledger'])
      await syntheticTraffic(server, 7)
      privateTraffic(traffic, server.origin)
      await writeFile(info.outputPath('legacy-country-cache.json'), cacheBefore)
    } finally { await page.close(); await server.stop() }
  })

  test('a same-ID structured country change moves current regional results while saved source, note and status stay intact', async ({ page, request, baseURL }, info) => {
    const server = await createWorkplaceCountriesServer(info.outputPath('country-server'), await readServerMode(request, `${baseURL}/api/health`))
    const traffic = watchApiRequests(page)
    const failures = browserFailures(page)
    const first = workplaceCountryResponses()
    first[ashbyUrl] = { apiVersion: '1', jobs: [
      workplaceCountryAshbyRaw({ location: 'Assigned Workshop', address: { addressCountry: 'MY' } }),
      ...workplaceCountryAshbyPostings().slice(1),
    ] }
    try {
      await server.respond(first)
      await server.start()
      await server.verifyProductionBytes()
      await seed(page, server.origin, { filters: { ...WORKPLACE_COUNTRY_FILTERS, query: 'Reed Compass', region: 'asia-pacific' } })
      await page.goto(server.origin)
      await expectInitialCatalogRequest(page, traffic)
      const title = page.getByRole('button', { name: 'Backend Engineer — Reed Compass', exact: true })
      await title.click()
      await countryEvidence(page, '말레이시아', ['Assigned Workshop\n국가: MY'])
      await page.getByRole('button', { name: '기회 저장', exact: true }).click()
      await page.getByLabel('이 기회에 대한 나의 메모', { exact: true }).fill(WORKPLACE_COUNTRY_NOTE)
      await page.getByRole('button', { name: '지원 완료로 표시', exact: true }).click()
      await closeDialog(page, title)
      const saved = await readSaved(page)
      expect(saved).toHaveLength(1)
      expect(saved[0]).toMatchObject({
        note: WORKPLACE_COUNTRY_NOTE, status: 'applied',
        job: { id: 'ashby-country-moss-5511', locationLabel: 'Assigned Workshop', workplaceLocations: { version: 1, locations: [{ label: 'Assigned Workshop', country: 'MY' }] } },
      })
      const cacheFile = await ownedCache(server)
      await writeFile(info.outputPath('cache-before-country-change.json'), await readFile(cacheFile))
      await page.goto('about:blank')
      await server.stop()
      // Recollect this owned fixture after a publisher change. Warm-cache reuse
      // is independently asserted above; no timeout or refresh cooldown changes.
      await rm(cacheFile)
      const next = workplaceCountryResponses()
      next[ashbyUrl] = { apiVersion: '1', jobs: [
        workplaceCountryAshbyRaw({ location: 'Assigned Workshop', address: { addressCountry: 'EE' } }),
        ...workplaceCountryAshbyPostings().slice(1),
      ] }
      await server.respond(next)
      await server.start()
      await server.verifyProductionBytes()
      await page.goto(server.origin)
      const after = await catalog(page, server.origin)
      expect(after.jobs.map(job => job.id)).toEqual(allIds)
      expect(after.jobs.find(job => job.id === 'ashby-country-moss-5511')).toMatchObject({
        title: 'Backend Engineer — Reed Compass', locationLabel: 'Assigned Workshop', cityIds: [], remoteCountries: [],
        workplaceLocations: { version: 1, locations: [{ label: 'Assigned Workshop', country: 'EE' }] },
      })
      await expect(region(page, '아시아 · 태평양')).toHaveAttribute('aria-pressed', 'true')
      await expect(search(page)).toHaveValue('Reed Compass')
      await expect(page.locator('.list-toolbar > span')).toHaveText('0개 회사 · 0개 공고')
      await region(page, '유럽').click()
      await expect(page.locator('.mini-job-title')).toHaveText(['Backend Engineer — Reed Compass'])
      await title.click()
      await countryEvidence(page, '에스토니아', ['Assigned Workshop\n국가: EE'])
      if (width === 320) await audit(page, info, 'changed-current-country-320.png')
      await closeDialog(page, title)
      await navigation(page).getByRole('button', { name: /^저장한 기회/ }).click()
      await page.getByRole('button', { name: '게시 상태 확인', exact: true }).click()
      await expect(page.locator('.posting-notice.listed')).toHaveCount(1)
      await expect(page.locator('.posting-changes')).toHaveText('근무지 확인 필요')
      await savedSearch(page).fill('에스토니아')
      await expect(page.locator('.saved-card')).toHaveCount(0)
      await savedSearch(page).fill('말레이시아')
      await expect(page.locator('.saved-title')).toHaveText(['Backend Engineer — Reed Compass'])
      await page.locator('.saved-title').click()
      await countryEvidence(page, '말레이시아', ['Assigned Workshop\n국가: MY'])
      await expect(page.getByLabel('이 기회에 대한 나의 메모', { exact: true })).toHaveValue(WORKPLACE_COUNTRY_NOTE)
      await expect(page.getByRole('button', { name: '지원 완료로 표시됨', exact: true })).toBeVisible()
      await closeDialog(page, page.locator('.saved-title'))
      expect(await readSaved(page)).toEqual(saved)
      expect(csvRows(await downloadCsv(page), 1)[0]).toMatchObject({
        '근무 국가': '말레이시아', '근무 국가 근거': 'Assigned Workshop\n국가: MY',
        '내용 비교': '차이 있음', '저장 내용과 다른 항목': '근무지', '상태': '지원 완료', '메모': WORKPLACE_COUNTRY_NOTE,
      })
      await writeFile(info.outputPath('same-id-country-change.json'), JSON.stringify({ after, saved, upstream: await syntheticTraffic(server, 14) }, null, 2))
      privateTraffic(traffic, server.origin)
      expect(failures).toEqual({ errors: [], resources: [] })
    } finally { await page.close(); await server.stop() }
  })
})

test('a failed real board update retains prior country evidence, valid regional results and saved notes/status', async ({ page, request, baseURL }, info) => {
  const server = await createWorkplaceCountriesServer(info.outputPath('country-server'), await readServerMode(request, `${baseURL}/api/health`))
  const traffic = watchApiRequests(page)
  try {
    await server.start()
    await server.verifyProductionBytes()
    await seed(page, server.origin, { filters: { ...WORKPLACE_COUNTRY_FILTERS, query: 'Reed Compass', region: 'asia-pacific' } })
    await page.goto(server.origin)
    await expectInitialCatalogRequest(page, traffic)
    const title = page.getByRole('button', { name: 'Backend Engineer — Reed Compass', exact: true })
    await title.click()
    await page.getByRole('button', { name: '기회 저장', exact: true }).click()
    await page.getByLabel('이 기회에 대한 나의 메모', { exact: true }).fill(WORKPLACE_COUNTRY_NOTE)
    await page.getByRole('button', { name: '지원 완료로 표시', exact: true }).click()
    await closeDialog(page, title)
    const saved = await readSaved(page)
    const cacheFile = await ownedCache(server)
    const original = await readFile(cacheFile, 'utf8')
    await writeFile(info.outputPath('cache-before-failed-update.json'), original)
    await page.goto('about:blank')
    await server.stop()
    // A bounded synthetic stale-cache input makes a real update due. Source
    // content and country fields remain byte-for-byte the same; only the owned
    // cache timestamps move 90 minutes into the past, within fallback validity.
    const aged = JSON.parse(original) as { boards: { checkedAt: string; snapshot: { fetchedAt: string; jobs: Job[] } }[] }
    const past = new Date(Date.now() - 90 * 60_000).toISOString()
    for (const board of aged.boards) {
      board.checkedAt = past
      board.snapshot.fetchedAt = past
      for (const job of board.snapshot.jobs) job.fetchedAt = past
    }
    await writeFile(cacheFile, JSON.stringify(aged))
    const failed = workplaceCountryResponses()
    failed[ashbyUrl] = { apiVersion: 'invalid', jobs: [] }
    await server.respond(failed)
    await server.start()
    await server.verifyProductionBytes()
    await page.goto(server.origin)
    const current = await catalog(page, server.origin)
    expect(current.jobs.map(job => job.id)).toEqual(allIds)
    expect(current.boards.find(board => board.companyId === 'country-moss')).toMatchObject({ status: 'error', dataStatus: 'stale', included: 6 })
    expect(current.jobs.find(job => job.id === 'ashby-country-moss-5511')).toMatchObject({
      stale: true, fetchedAt: past, cityIds: [], locationLabel: 'Petaling Jaya',
      workplaceLocations: { version: 1, locations: [{ label: 'Petaling Jaya', country: 'MY' }] },
    })
    await expect(page.locator('.mini-job-title')).toHaveText(['Backend Engineer — Reed Compass'])
    await expect(page.locator('.stale-job-badge')).toHaveText('이전 조회 공고')
    await title.click()
    await countryEvidence(page, '말레이시아', ['Petaling Jaya\n국가: MY'])
    await expect(page.locator('.job-freshness-notice')).toContainText('이전 조회 결과를 보고 있어요')
    await closeDialog(page, title)
    expect(await readSaved(page)).toEqual(saved)
    await navigation(page).getByRole('button', { name: /^저장한 기회/ }).click()
    await savedSearch(page).fill('말레이시아')
    await expect(page.locator('.saved-title')).toHaveText(['Backend Engineer — Reed Compass'])
    await expect(page.locator('.saved-note-preview')).toHaveText(WORKPLACE_COUNTRY_NOTE)
    await expect(page.locator('.saved-status')).toHaveText('지원 완료')
    expect(await readSaved(page)).toEqual(saved)
    privateTraffic(traffic, server.origin)
    await writeFile(info.outputPath('failed-country-update.json'), JSON.stringify({ current, saved, past, upstream: await syntheticTraffic(server, 14) }, null, 2))
  } finally { await page.close(); await server.stop() }
})

test('strong US/Canada country lists retain both searchable countries through saving and export at 1440px, while city-name addresses stay suffix-only', async ({ page, request, baseURL }, info) => {
  await page.setViewportSize({ width: 1440, height: 960 })
  const server = await createWorkplaceCountriesServer(info.outputPath('country-server'), await readServerMode(request, `${baseURL}/api/health`), 'baseline')
  await server.respond(workplaceCountryCommaResponses())
  const traffic = watchApiRequests(page)
  const failures = browserFailures(page)
  try {
    await server.start()
    await server.verifyProductionBytes()
    await seed(page, server.origin)
    await page.goto(server.origin)
    await expectInitialCatalogRequest(page, traffic)
    const fresh = await catalog(page, server.origin)
    expect(fresh.jobs.map(job => job.id)).toEqual([
      'greenhouse-country-fern-5581', 'greenhouse-country-fern-5582', 'greenhouse-country-fern-5583',
      'greenhouse-country-fern-5584', 'greenhouse-country-fern-5585', 'greenhouse-country-fern-5586',
      'greenhouse-country-fern-5587', 'greenhouse-country-fern-5588',
    ])
    expect(fresh.unmappedCount).toBe(8)
    for (const job of fresh.jobs) expect(job).toMatchObject({
      cityIds: [], workMode: 'onsite', remoteCountries: [], remoteWorldwide: false,
    })
    await expect(page.locator('.list-toolbar > span')).toHaveText('1개 회사 · 8개 공고')
    await expect(page.getByRole('button', { name: '전체 8개 공고 보기', exact: true })).toBeVisible()
    await expandedTitles(page, [
      'Backend Engineer — Alder Span', 'Backend Engineer — Amber Dial', 'Backend Engineer — Birch Span',
      'Backend Engineer — Cedar Receipt', 'Backend Engineer — Harbor Receipt', 'Backend Engineer — Onyx Dial',
      'Backend Engineer — Quartz Receipt', 'Backend Engineer — Willow Span',
    ])
    await expect(page.locator('.map-stats strong')).toHaveText(['1곳', '0곳'])
    await region(page, '미주').click()
    await expect(page.locator('.list-toolbar > span')).toHaveText('1개 회사 · 6개 공고')
    await expandedTitles(page, [
      'Backend Engineer — Alder Span', 'Backend Engineer — Birch Span', 'Backend Engineer — Cedar Receipt',
      'Backend Engineer — Harbor Receipt', 'Backend Engineer — Quartz Receipt', 'Backend Engineer — Willow Span',
    ])
    await search(page).fill('미국')
    await expect(page.locator('.list-toolbar > span')).toHaveText('1개 회사 · 5개 공고')
    await expandedTitles(page, [
      'Backend Engineer — Alder Span', 'Backend Engineer — Birch Span', 'Backend Engineer — Harbor Receipt',
      'Backend Engineer — Quartz Receipt', 'Backend Engineer — Willow Span',
    ])
    const birch = page.getByRole('button', { name: 'Backend Engineer — Birch Span', exact: true })
    await birch.click()
    await countryEvidence(page, '캐나다 · 미국', ['US, Canada'])
    await expect(page.locator('.remote-scope')).toHaveCount(0)
    await audit(page, info, 'literal-us-canada-evidence-1440.png')
    await page.getByRole('button', { name: '기회 저장', exact: true }).click()
    await closeDialog(page, birch)
    await search(page).fill('캐나다')
    await expect(page.locator('.list-toolbar > span')).toHaveText('1개 회사 · 4개 공고')
    await expandedTitles(page, [
      'Backend Engineer — Alder Span', 'Backend Engineer — Birch Span',
      'Backend Engineer — Cedar Receipt', 'Backend Engineer — Willow Span',
    ])
    await region(page, '유럽').click()
    await expect(page.locator('.mini-job-title')).toHaveCount(0)
    await region(page, '전 세계').click()
    await expect(page.locator('.list-toolbar > span')).toHaveText('1개 회사 · 4개 공고')
    await expandedTitles(page, [
      'Backend Engineer — Alder Span', 'Backend Engineer — Birch Span',
      'Backend Engineer — Cedar Receipt', 'Backend Engineer — Willow Span',
    ])
    for (const query of ['레바논', '멕시코', '조지아']) {
      await search(page).fill(query)
      await expect(page.locator('.mini-job-title')).toHaveCount(0)
    }
    await search(page).fill('Cedar Receipt')
    const cedar = page.getByRole('button', { name: 'Backend Engineer — Cedar Receipt', exact: true })
    await cedar.click()
    await countryEvidence(page, '캐나다', ['Lebanon, Canada'])
    await page.getByRole('button', { name: '기회 저장', exact: true }).click()
    await closeDialog(page, cedar)
    for (const example of [
      { query: 'Harbor Receipt', title: 'Backend Engineer — Harbor Receipt', quote: 'Lebanon, NH, United States' },
      { query: 'Quartz Receipt', title: 'Backend Engineer — Quartz Receipt', quote: 'Mexico, United States' },
    ]) {
      await search(page).fill(example.query)
      const opener = page.getByRole('button', { name: example.title, exact: true })
      await opener.click()
      await countryEvidence(page, '미국', [example.quote])
      await closeDialog(page, opener)
    }
    await navigation(page).getByRole('button', { name: /^저장한 기회/ }).click()
    await expect(page.locator('.saved-card')).toHaveCount(2)
    const saved = await readSaved(page)
    expect(saved.map(record => record.job.id).sort()).toEqual(['greenhouse-country-fern-5581', 'greenhouse-country-fern-5585'])
    expect(saved.find(record => record.job.id === 'greenhouse-country-fern-5581')?.job.workplaceLocations).toEqual({
      version: 1, locations: [{ label: 'US, Canada' }],
    })
    expect(saved.find(record => record.job.id === 'greenhouse-country-fern-5585')?.job.workplaceLocations).toEqual({
      version: 1, locations: [{ label: 'Lebanon, Canada' }],
    })
    await savedSearch(page).fill('미국')
    await expect(page.locator('.saved-title')).toHaveText(['Backend Engineer — Birch Span'])
    const csvText = await downloadCsv(page)
    const csv = csvRows(csvText, 2)
    expect(csv.find(row => row['포지션'] === 'Backend Engineer — Birch Span')).toMatchObject({
      '근무 국가': '캐나다 · 미국', '근무 국가 근거': 'US, Canada',
    })
    expect(csv.find(row => row['포지션'] === 'Backend Engineer — Cedar Receipt')).toMatchObject({
      '근무 국가': '캐나다', '근무 국가 근거': 'Lebanon, Canada',
    })
    await page.getByRole('button', { name: '기록 백업·복원', exact: true }).click()
    const download = page.waitForEvent('download')
    await page.getByRole('button', { name: 'JSON 백업', exact: true }).click()
    const backupText = await readFile((await (await download).path())!, 'utf8')
    expect(JSON.parse(backupText).records).toEqual(saved)
    expect(JSON.parse(backupText)).not.toHaveProperty('profile')
    expect(backupText).not.toContain(WORKPLACE_COUNTRY_PROFILE.name)
    expect(csvText).not.toContain(WORKPLACE_COUNTRY_PROFILE.name)
    await page.getByRole('button', { name: '완료', exact: true }).click()
    await page.reload()
    await expect(page.locator('.saved-card')).toHaveCount(2)
    expect(await readSaved(page)).toEqual(saved)
    await savedSearch(page).fill('미국')
    await expect(page.locator('.saved-title')).toHaveText(['Backend Engineer — Birch Span'])
    await writeFile(info.outputPath('comma-country-saved.csv'), csvText)
    await writeFile(info.outputPath('comma-country-backup.json'), backupText)
    await syntheticTraffic(server, 1)
    privateTraffic(traffic, server.origin)
    for (const request of traffic.requests) {
      expect(decodeURIComponent(new URL(request.url).search)).not.toMatch(/미국|캐나다|레바논|멕시코|조지아|Birch|Receipt/)
    }
    expect(failures).toEqual({ errors: [], resources: [] })
  } finally { await page.close(); await server.stop() }
})
