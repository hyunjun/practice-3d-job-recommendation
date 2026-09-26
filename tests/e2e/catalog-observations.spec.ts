import { expect, test } from '@playwright/test'
import type { APIRequestContext, Locator, Page, TestInfo } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { Catalog } from '../../shared/types'
import { DEFAULT_FILTERS } from '../../shared/types'
import { ObservationHistorySchema, OBSERVATION_METHOD } from '../../shared/catalog-observations'
import type { ObservationHistory } from '../../shared/catalog-observations'
import {
  OBSERVATION_DAY_ONE, OBSERVATION_DAY_TWO, OBSERVATION_EXPECTED,
  OBSERVATION_PRIVATE_NOTE, OBSERVATION_PRIVATE_QUERY, OBSERVATION_PROFILE, OBSERVATION_URLS,
  observationBoards, observationResponses, observationSaved,
} from '../fixtures/catalog-observations'
import { createObservationServer, OBSERVATION_PRIVATE_ROOT } from '../fixtures/catalog-observations-server'
import { watchApiRequests } from './helpers/api-requests'
import { readSaved, waitForSavedCommit } from './helpers/saved-store'

type Server = Awaited<ReturnType<typeof createObservationServer>>
const runId = `${new Date().toISOString().replaceAll(/[:.]/g, '-')}-${process.pid}`
const panel = (page: Page) => page.locator('details.observation-panel')
const date = (page: Page) => panel(page).getByRole('combobox', { name: '관측 날짜 (UTC)', exact: true })
const dimension = (page: Page) => panel(page).getByRole('combobox', { name: '분포 항목', exact: true })
const total = (page: Page, name: string) => panel(page).locator('.observation-totals > div')
  .filter({ has: page.getByText(name, { exact: true }) }).locator('dd')
const counts = (values: { key: string; count: number }[]) => Object.fromEntries(values.map(value => [value.key, value.count]))

async function fixture(info: TestInfo, options: Parameters<typeof createObservationServer>[2] = {}) {
  const mode = process.env.ORBIT_OBSERVATIONS_MODE ?? 'development'
  if (mode !== 'development' && mode !== 'production') throw new Error('Unknown observation test mode')
  return createObservationServer(path.join(OBSERVATION_PRIVATE_ROOT, 'runs', runId,
    `${info.testId.replaceAll(/[^a-zA-Z0-9-]/g, '-')}-${info.retry}`), mode, options)
}

async function json<T>(request: APIRequestContext, origin: string, route: string): Promise<T> {
  const response = await request.get(`${origin}${route}`)
  try {
    expect(response.status(), `${route} must use the real successful HTTP route`).toBe(200)
    return await response.json()
  } finally { await response.dispose() }
}
async function history(request: APIRequestContext, server: Server): Promise<ObservationHistory> {
  const value = await json<unknown>(request, server.origin, '/api/observations')
  expect(ObservationHistorySchema.safeParse(value).success).toBe(true)
  return value as ObservationHistory
}
async function collect(request: APIRequestContext, server: Server) {
  return json<Catalog>(request, server.origin, '/api/catalog?source=public&refresh=1')
}
async function traffic(server: Server, expected: number) {
  const requests = await server.requests()
  expect(requests).toHaveLength(expected)
  expect(requests.every(request => request.synthetic && request.networkSent === false
    && request.method === 'GET' && request.body === null)).toBe(true)
  return requests
}
async function seed(page: Page, server: Server) {
  await page.clock.setFixedTime(new Date(OBSERVATION_DAY_ONE))
  await page.route('**/*', route => new URL(route.request().url()).origin === server.origin
    ? route.fallback() : route.abort('blockedbyclient'))
  await page.addInitScript(({ origin, profile, saved, filters, query }) => {
    if (location.origin !== origin || sessionStorage.getItem('observation-fixture-seeded')) return
    localStorage.setItem('orbit.v1.profile', JSON.stringify(profile))
    localStorage.setItem('orbit.v1.saved', JSON.stringify(saved))
    localStorage.setItem('orbit.v1.exploration', JSON.stringify({
      source: 'public', selectedId: 'london', mapMode: 'flat', panelTab: 'cities',
      filters: { ...filters, query, region: 'europe', role: 'backend' },
    }))
    sessionStorage.setItem('observation-fixture-seeded', 'true')
  }, {
    origin: server.origin, profile: OBSERVATION_PROFILE, saved: observationSaved(),
    filters: DEFAULT_FILTERS, query: OBSERVATION_PRIVATE_QUERY,
  })
  await page.goto(server.origin)
  await expect(page.getByRole('textbox', { name: '도시, 회사 또는 포지션 검색', exact: true })).toHaveValue(OBSERVATION_PRIVATE_QUERY)
  await waitForSavedCommit(page)
}
async function open(page: Page) {
  const opener = page.getByRole('button', { name: '데이터와 추천 방식', exact: true })
  await opener.click()
  await expect(panel(page)).toBeVisible()
  const summary = panel(page).locator('summary')
  await summary.focus()
  await page.keyboard.press('Enter')
  await expect(panel(page)).toHaveJSProperty('open', true)
  await expect(summary).toBeFocused()
  return opener
}
async function readAgain(page: Page) {
  const response = page.waitForResponse(response => new URL(response.url()).pathname === '/api/observations')
  await panel(page).getByRole('button', { name: '관측 기록 다시 읽기', exact: true }).click()
  await response
  await expect(panel(page).getByRole('button', { name: '관측 기록 다시 읽기', exact: true })).toBeEnabled()
}
async function row(table: Locator, label: string, values: string[]) {
  await expect(table.getByRole('rowheader', { name: label, exact: true }).locator('..').getByRole('cell')).toHaveText(values)
}
async function textInScrollClip(locator: Locator) {
  return locator.evaluate(element => {
    const container = element.closest('.observation-table-wrap')
    if (!(container instanceof HTMLElement)) throw new Error('Expected a scrollable observation table')
    const bounds = container.getBoundingClientRect()
    const clip = {
      left: Math.max(0, bounds.left + container.clientLeft),
      right: Math.min(innerWidth, bounds.left + container.clientLeft + container.clientWidth),
      top: Math.max(0, bounds.top + container.clientTop),
      bottom: Math.min(innerHeight, bounds.top + container.clientTop + container.clientHeight),
    }
    const range = document.createRange()
    range.selectNodeContents(element)
    const text = range.getBoundingClientRect()
    const inset = Math.min(1, text.width / 4, text.height / 4)
    const points = [
      [text.left + inset, text.top + inset], [text.right - inset, text.top + inset],
      [text.left + inset, text.bottom - inset], [text.right - inset, text.bottom - inset],
      [text.left + text.width / 2, text.top + text.height / 2],
    ]
    return {
      text: element.textContent?.trim(), clip, bounds: text.toJSON(),
      withinClip: text.width > 0 && text.height > 0 && text.left >= clip.left
        && text.right <= clip.right && text.top >= clip.top && text.bottom <= clip.bottom,
      uncovered: points.every(([x, y]) => element.contains(document.elementFromPoint(x, y))),
    }
  })
}
async function keyboardSkillsContext(page: Page, server: Server) {
  const scroller = panel(page).getByRole('region', { name: '기술별 공고 수 표', exact: true })
  await scroller.scrollIntoViewIfNeeded()
  await scroller.focus()
  await expect(scroller).toBeFocused()
  const maximum = await scroller.evaluate(element => element.scrollWidth - element.clientWidth)
  expect(maximum, 'The 320px skills table must exercise horizontal scrolling').toBeGreaterThan(0)
  for (let count = 0; count < 32; count++) await page.keyboard.press('ArrowRight')
  await expect.poll(() => scroller.evaluate(element => element.scrollLeft)).toBeGreaterThanOrEqual(maximum - 1)
  const label = scroller.getByRole('rowheader', { name: 'TypeScript', exact: true })
  const preferred = label.locator('..').getByRole('cell').nth(3)
  await expect(scroller.getByRole('columnheader').last()).toHaveText('우대 항목에 포함')
  await expect(label).toHaveText('TypeScript')
  await expect(preferred).toHaveText('0')
  const evidence = {
    maximum, scrollLeft: await scroller.evaluate(element => element.scrollLeft),
    label: await textInScrollClip(label), preferred: await textInScrollClip(preferred),
  }
  await writeFile(path.join(server.directory, 'skills-keyboard-context-320.json'), JSON.stringify(evidence, null, 2))
  await page.screenshot({ path: path.join(server.directory, 'skills-keyboard-context-320.png'), fullPage: false })
  expect(evidence.label.withinClip, 'TypeScript must remain inside the visible table after scrolling right').toBe(true)
  expect(evidence.label.uncovered, 'The TypeScript row label must remain uncovered').toBe(true)
  expect(evidence.preferred.withinClip, 'The TypeScript preferred count 0 must share the visible table area').toBe(true)
  expect(evidence.preferred.uncovered, 'The TypeScript preferred count 0 must remain uncovered').toBe(true)
}
async function audit(page: Page, server: Server, name: string) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  for (const box of [page.getByRole('dialog'), panel(page), panel(page).locator('.observation-toolbar')]) {
    expect(await box.evaluate(element => element.scrollWidth <= element.clientWidth), `${name}: content must fit its container`).toBe(true)
  }
  const axe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze()
  await writeFile(path.join(server.directory, `${name}-axe.json`), JSON.stringify(axe, null, 2))
  expect(axe.violations).toEqual([])
  const distribution = panel(page).locator('.observation-distribution')
  if (await distribution.count()) {
    await dimension(page).scrollIntoViewIfNeeded()
    await expect(dimension(page)).toBeInViewport()
  }
  await page.screenshot({ path: path.join(server.directory, `${name}.png`), fullPage: true })
  const table = panel(page).locator('.observation-table-wrap')
  if (await table.count()) {
    await table.scrollIntoViewIfNeeded()
    await table.focus()
    await expect(table).toBeFocused()
    await expect(table).toBeInViewport()
    await page.screenshot({ path: path.join(server.directory, `${name}-table.png`), fullPage: true })
  }
}
function assertPrivateTraffic(requests: ReturnType<typeof watchApiRequests>['requests']) {
  for (const request of requests) {
    expect(request.method).toBe('GET')
    expect(request.body).toBeNull()
    const serialized = `${request.url}\n${request.body ?? ''}`
    for (const secret of [OBSERVATION_PRIVATE_NOTE, OBSERVATION_PRIVATE_QUERY, OBSERVATION_PROFILE.name, 'greenhouse-observation-orchard-6001']) {
      expect(serialized).not.toContain(secret)
      expect(serialized).not.toContain(encodeURIComponent(secret))
    }
    if (new URL(request.url).pathname === '/api/observations') expect(new URL(request.url).search).toBe('')
  }
}

test('real HTTP history reads, provider collection and cache restart preserve literal counts and source clocks', async ({ request }, info) => {
  const server = await fixture(info)
  try {
    await server.start()
    expect((await history(request, server)).days).toEqual([])
    await traffic(server, 0)
    const catalog = await collect(request, server)
    expect(catalog.jobs.map(job => job.id).sort()).toEqual([
      'greenhouse-observation-orchard-6001', 'greenhouse-observation-orchard-6002',
      'greenhouse-observation-orchard-6003', 'greenhouse-observation-orchard-6004',
      'lever-observation-relay-6011', 'lever-observation-relay-6012', 'lever-observation-relay-6013',
    ])
    const first = await history(request, server)
    expect(first.days).toHaveLength(1)
    expect(first.days[0].complete).toMatchObject({
      observedAt: OBSERVATION_DAY_ONE, recordedAt: OBSERVATION_DAY_ONE, origin: 'collection',
      comparable: true, stats: { published: 8, technical: 7, openings: 6, talentPools: 1 },
    })
    const stats = first.days[0].complete!.stats
    expect(counts(stats.regions)).toEqual(OBSERVATION_EXPECTED.regions)
    expect(counts(stats.roles)).toEqual(OBSERVATION_EXPECTED.roles)
    expect(counts(stats.workModes)).toEqual(OBSERVATION_EXPECTED.workModes)
    expect(Object.fromEntries(stats.skills.map(({ name, mentioned, ...rest }) => [name, { mentions: mentioned, ...rest }]))).toEqual(OBSERVATION_EXPECTED.skills)
    await traffic(server, 2)
    const cacheFile = await server.fullCacheFile()
    const fullBytes = await readFile(cacheFile, 'utf8')
    expect(JSON.parse(fullBytes).boards.map((board: { snapshot: { observationMethod: string } }) => board.snapshot.observationMethod)).toEqual([OBSERVATION_METHOD, OBSERVATION_METHOD])
    await server.at(OBSERVATION_DAY_TWO)
    expect(await history(request, server)).toEqual(first)
    expect(await readFile(cacheFile, 'utf8')).toBe(fullBytes)
    await server.stop()
    await server.start()
    expect(await history(request, server)).toEqual(first)
    await traffic(server, 2)
    expect(await readFile(cacheFile, 'utf8')).toBe(fullBytes)
    await writeFile(path.join(server.directory, 'history-and-catalog.json'), JSON.stringify({ first, catalog }, null, 2))
  } finally { await server.stop() }
})

for (const width of [1440, 320]) test.describe(`observation history at ${width}px`, () => {
  test.use({ viewport: { width, height: 960 }, isMobile: width === 320, hasTouch: width === 320 })

  test('date and distributions stay local, body refresh adds the next day, and a later failure preserves complete totals', async ({ page }, info) => {
    test.setTimeout(90_000)
    const server = await fixture(info)
    const api = watchApiRequests(page)
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    try {
      await server.start()
      await server.verifyProductionBytes()
      await collect(page.request, server)
      await seed(page, server)
      const localBefore = await page.evaluate(() => ({
        profile: localStorage.getItem('orbit.v1.profile'),
        filters: JSON.parse(localStorage.getItem('orbit.v1.exploration')!).filters,
      }))
      const savedBefore = await readSaved(page)
      expect(api.requests.filter(request => new URL(request.url).pathname === '/api/observations')).toEqual([])
      const opener = page.getByRole('button', { name: '데이터와 추천 방식', exact: true })
      await opener.click()
      await expect(panel(page)).toHaveJSProperty('open', false)
      expect(api.requests.filter(request => new URL(request.url).pathname === '/api/observations')).toEqual([])
      await panel(page).locator('summary').focus()
      await page.keyboard.press('Enter')
      await expect(total(page, '일반 채용 공고')).toHaveText('6개')
      await expect(total(page, '공개 목록 전체 직군')).toHaveText('8개')
      await expect(total(page, '개발·컴퓨팅 후보')).toHaveText('7개')
      await expect(total(page, '인재풀·관심 등록')).toHaveText('1개')
      await expect(date(page).locator('option')).toHaveText(['2026-09-24'])
      await expect(panel(page).locator('.observation-comparison')).toContainText('서로 다른 날짜의 기록이 2개 이상')
      await expect(panel(page).locator('.observation-denominator')).toHaveText('분모: 일반 개발·컴퓨팅 공고 6개 · 인재풀 1개 제외')
      await expect(panel(page).locator('.observation-concentration')).toHaveText('가장 많은 회사 Cobalt Orchard: 3개 (50.0%) · 상위 2개 회사 합계 100.0%')
      await row(panel(page).getByRole('table', { name: '회사별 일반 공고' }), 'Cobalt Orchard', ['3', '50.0%'])

      const historyRequests = api.requests.filter(request => new URL(request.url).pathname === '/api/observations').length
      await dimension(page).selectOption('regions')
      const regions = panel(page).getByRole('table', { name: '근무 지역별 일반 공고' })
      await row(regions, '미주', ['1', '16.7%'])
      await row(regions, '유럽', ['2', '33.3%'])
      await row(regions, '아시아 · 태평양', ['1', '16.7%'])
      await row(regions, '원격근무', ['1', '16.7%'])
      await row(regions, '그 밖의 확인된 지역', ['1', '16.7%'])
      await row(regions, '지역 일부 또는 전체 미확인', ['1', '16.7%'])
      await expect(panel(page)).toContainText('합계가 분모를 넘을 수 있어요')
      await dimension(page).selectOption('roles')
      const roles = panel(page).getByRole('table', { name: '개발 직무별 일반 공고' })
      await row(roles, '백엔드', ['3', '50.0%'])
      await row(roles, '프론트엔드', ['2', '33.3%'])
      await row(roles, 'AI · 머신러닝', ['1', '16.7%'])
      await row(roles, '데이터 엔지니어링', ['1', '16.7%'])
      await row(roles, '세부 직무 미확인', ['1', '16.7%'])
      await dimension(page).selectOption('workModes')
      const modes = panel(page).getByRole('table', { name: '근무 형태별 일반 공고' })
      await row(modes, '오피스 근무', ['2', '33.3%'])
      await row(modes, '하이브리드', ['2', '33.3%'])
      await row(modes, '원격근무', ['1', '16.7%'])
      await row(modes, '근무 형태 미확인', ['1', '16.7%'])
      await dimension(page).selectOption('skills')
      const skills = panel(page).getByRole('table', { name: '기술별 언급과 자격 항목의 공고 수' })
      await row(skills, 'TypeScript', ['3', '1', '1', '0'])
      await row(skills, 'Python', ['2', '2', '0', '0'])
      await row(skills, 'Go', ['2', '0', '0', '2'])
      await row(skills, 'React', ['2', '1', '1', '0'])
      await row(skills, 'AWS', ['1', '0', '0', '0'])
      await row(skills, 'SQL', ['1', '0', '1', '0'])
      await expect(skills.getByRole('rowheader', { name: 'Rust', exact: true })).toHaveCount(0)
      await expect(skills.getByRole('columnheader', { name: '필수 항목에 포함', exact: true })).toBeVisible()
      await expect(panel(page)).toContainText('해당 기술 하나가 반드시 필요하다는 뜻은 아니며')
      expect(api.requests.filter(request => new URL(request.url).pathname === '/api/observations')).toHaveLength(historyRequests)
      await traffic(server, 2)
      await audit(page, server, `day-one-skills-${width}`)
      if (width === 320) await keyboardSkillsContext(page, server)

      const full = await server.fullCacheFile()
      const fullBytes = await readFile(full, 'utf8')
      await server.at('2026-09-25T10:00:00.000Z')
      await json(page.request, server.origin, '/api/posting-status?refresh=1')
      const presenceTraffic = await traffic(server, 4)
      expect(presenceTraffic.at(-2)?.url).toBe(OBSERVATION_URLS.greenhousePresence)
      await readAgain(page)
      await expect(date(page).locator('option')).toHaveText(['2026-09-24'])
      expect(await readFile(full, 'utf8')).toBe(fullBytes)
      await traffic(server, 4)

      await server.respond(observationResponses({ nextDay: true }))
      await server.at(OBSERVATION_DAY_TWO)
      await page.clock.setFixedTime(new Date(OBSERVATION_DAY_TWO))
      const refresh = page.getByRole('dialog').getByRole('button', { name: /^새로고침/ })
      await expect(refresh).toBeEnabled()
      await refresh.click()
      await expect(total(page, '일반 채용 공고')).toHaveText('7개')
      await expect(date(page).locator('option')).toHaveText(['2026-09-26', '2026-09-24'])
      await expect(panel(page).locator('.observation-comparison')).toContainText('2026-09-24 → 2026-09-26: 일반 공고 +1개')
      await traffic(server, 6)
      const beforeLocal = api.requests.length
      await date(page).selectOption('2026-09-24')
      await expect(total(page, '일반 채용 공고')).toHaveText('6개')
      await expect(panel(page).locator('.observation-comparison')).toContainText('서로 다른 날짜의 기록이 2개 이상')
      await date(page).selectOption('2026-09-26')
      await dimension(page).selectOption('companies')
      await expect(total(page, '일반 채용 공고')).toHaveText('7개')
      await row(panel(page).getByRole('table', { name: '회사별 일반 공고' }), 'Cobalt Orchard', ['4', '57.1%'])
      expect(api.requests).toHaveLength(beforeLocal)
      await traffic(server, 6)

      const completeBeforeFailure = (await history(page.request, server)).days[1].complete
      await server.respond(observationResponses({ scenario: 'failed' }))
      await server.at('2026-09-26T10:05:00.000Z')
      await page.clock.setFixedTime(new Date('2026-09-26T10:05:00.000Z'))
      await expect(refresh).toBeEnabled()
      await refresh.click()
      await expect(panel(page)).toContainText('아래에는 같은 날 마지막으로 완성된 집계를 유지합니다.')
      await expect(panel(page)).toContainText('Juniper Relay · 최근 조회 실패')
      await expect(total(page, '일반 채용 공고')).toHaveText('7개')
      expect((await history(page.request, server)).days[1].complete).toEqual(completeBeforeFailure)
      await traffic(server, 8)
      await audit(page, server, `retained-complete-${width}`)
      await writeFile(path.join(server.directory, 'browser-api-requests.json'), JSON.stringify(api.requests, null, 2))
      assertPrivateTraffic(api.requests)
      expect(errors).toEqual([])
      await page.keyboard.press('Escape')
      await expect(page.getByRole('dialog')).toHaveCount(0)
      await expect(opener).toBeFocused()
      expect(await page.evaluate(() => ({
        profile: localStorage.getItem('orbit.v1.profile'),
        filters: JSON.parse(localStorage.getItem('orbit.v1.exploration')!).filters,
      }))).toEqual(localBefore)
      expect(await readSaved(page)).toEqual(savedBefore)
      expect((await readSaved(page))[0].note).toBe(OBSERVATION_PRIVATE_NOTE)
    } finally { await server.stop() }
  })

  test('history HTTP and schema errors remain explicit, retry locally, and preserve a previously displayed complete record', async ({ page }, info) => {
    const server = await fixture(info)
    const api = watchApiRequests(page)
    let failure: 'http' | 'schema' | null = 'http'
    try {
      await server.start()
      await collect(page.request, server)
      await seed(page, server)
      await page.route('**/api/observations', route => failure
        ? route.fulfill({
          status: failure === 'http' ? 503 : 200, contentType: 'application/json',
          body: JSON.stringify(failure === 'http' ? { error: 'Fictional history unavailable' } : { version: 99, days: [] }),
        }) : route.fallback())
      await open(page)
      await expect(panel(page).getByRole('alert')).toHaveText('관측 기록을 불러오지 못했어요. 다시 읽어 주세요.')
      await expect(total(page, '일반 채용 공고')).toHaveCount(0)
      await traffic(server, 2)
      failure = null
      await readAgain(page)
      await expect(total(page, '일반 채용 공고')).toHaveText('6개')
      failure = 'schema'
      await readAgain(page)
      await expect(panel(page).getByRole('alert')).toHaveText('관측 기록을 불러오지 못했어요. 다시 읽어 주세요. 아래는 앞서 읽은 기록입니다.')
      await expect(total(page, '일반 채용 공고')).toHaveText('6개')
      await audit(page, server, `history-schema-failure-${width}`)
      failure = null
      await readAgain(page)
      await expect(panel(page).getByRole('alert')).toHaveCount(0)
      await expect(total(page, '일반 채용 공고')).toHaveText('6개')
      await traffic(server, 2)
      assertPrivateTraffic(api.requests)
    } finally { await server.stop() }
  })

  test('legacy cache shows its original date and comparison exclusion while retaining top100 and displaying only top20 skills', async ({ page }, info) => {
    const server = await fixture(info)
    try {
      const boards = observationBoards()
      const names = Array.from({ length: 123 }, (_, index) => `FixtureSkill${String(index).padStart(3, '0')}`)
      boards[0].snapshot!.jobs[0].skills = ['Repeated', ...names.slice(0, 60)]
      boards[0].snapshot!.jobs[0].qualifications = { version: 1, experience: [], skills: [] }
      boards[0].snapshot!.jobs[1].skills = ['Repeated', ...names.slice(60)]
      boards[0].snapshot!.jobs[1].qualifications = { version: 1, experience: [], skills: [] }
      await server.seedFullCache(boards)
      const full = path.join(server.cwd, '.local/public-board-cache-v5.json')
      const fullBytes = await readFile(full, 'utf8')
      await server.at('2026-09-24T10:10:00.000Z')
      await server.start()
      const original = await history(page.request, server)
      expect(original.days[0].complete).toMatchObject({
        observedAt: OBSERVATION_DAY_ONE, recordedAt: '2026-09-24T10:10:00.000Z',
        origin: 'cache', comparable: false, stats: { openings: 6, skillCount: 129 },
      })
      expect(original.days[0].complete?.stats.skills).toHaveLength(100)
      expect(original.days[0].complete?.stats.skills.at(-1)?.name).toBe('FixtureSkill098')
      await seed(page, server)
      await page.clock.setFixedTime(new Date('2026-09-24T10:10:00.000Z'))
      await open(page)
      await expect(date(page).locator('option')).toHaveText(['2026-09-24'])
      await expect(panel(page)).toContainText('이전 캐시의 분류 기준을 확인할 수 없어 이 집계는 날짜 간 비교에서 제외해요.')
      await dimension(page).selectOption('skills')
      const table = panel(page).getByRole('table', { name: '기술별 언급과 자격 항목의 공고 수' })
      await expect(table.locator('tbody tr')).toHaveCount(20)
      await row(table, 'Repeated', ['2', '0', '0', '0'])
      await row(table, 'FixtureSkill018', ['1', '0', '0', '0'])
      await expect(table.getByRole('rowheader', { name: 'FixtureSkill019', exact: true })).toHaveCount(0)
      await traffic(server, 0)
      expect(await readFile(full, 'utf8')).toBe(fullBytes)
      await audit(page, server, `legacy-top20-${width}`)
    } finally { await server.stop() }
  })

  test('a complete empty provider cohort displays literal zero without percentages or invented skill requirements', async ({ page }, info) => {
    const server = await fixture(info, { responses: observationResponses({ scenario: 'empty' }) })
    try {
      await server.start()
      await collect(page.request, server)
      await seed(page, server)
      await open(page)
      await expect(total(page, '일반 채용 공고')).toHaveText('0개')
      await expect(total(page, '공개 목록 전체 직군')).toHaveText('0개')
      await expect(panel(page)).toContainText('일반 공고가 0개여서 비중을 계산하지 않아요.')
      await row(panel(page).getByRole('table', { name: '회사별 일반 공고' }), 'Cobalt Orchard', ['0', '—'])
      await row(panel(page).getByRole('table', { name: '회사별 일반 공고' }), 'Juniper Relay', ['0', '—'])
      await expect(panel(page)).not.toContainText('NaN')
      await expect(panel(page)).not.toContainText('Infinity')
      await expect(panel(page).locator('.observation-concentration')).toHaveCount(0)
      await dimension(page).selectOption('skills')
      await expect(panel(page)).toContainText('이 집계에서 확인된 기술 언급이 없어요. 기술 요구가 없다는 뜻은 아닙니다.')
      await traffic(server, 2)
      await audit(page, server, `complete-zero-${width}`)
    } finally { await server.stop() }
  })
})
