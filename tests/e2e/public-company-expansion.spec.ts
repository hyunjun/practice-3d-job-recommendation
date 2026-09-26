import { expect, test } from '@playwright/test'
import type { Locator, Page, TestInfo } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { readFile, writeFile } from 'node:fs/promises'
import type { Catalog, Filters, SavedJob } from '../../shared/types'
import {
  COVERAGE_EXPANSION_URLS, COVERAGE_FILTERS, COVERAGE_PROFILE, COVERAGE_TITLES,
  COVERAGE_UPDATED_AT, EXPANDED_PUBLIC_REGISTRATIONS,
} from '../fixtures/public-coverage'
import { EXPANSION_JOBS, EXPANSION_NOTE, expansionLegacyCache, expansionResponses } from '../fixtures/public-company-expansion'
import { SURVEY_FULL_URLS, withSurveyEmptyBoards } from '../fixtures/public-company-survey'
import { createPublicCoverageServer } from '../fixtures/public-coverage-server'
import { expectInitialCatalogRequest, readServerMode, watchApiRequests } from './helpers/api-requests'
import { readSaved, waitForSavedCommit } from './helpers/saved-store'
import { sourceChoice } from './helpers/source-choice'

const search = (page: Page) => page.getByRole('textbox', { name: '도시, 회사 또는 포지션 검색', exact: true })
const dataButton = (page: Page) => page.getByRole('button', { name: '데이터와 추천 방식', exact: true })

async function setup(page: Page, origin: string) {
  const traffic = watchApiRequests(page)
  const errors: string[] = [], external: string[] = [], failedResources: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('response', response => {
    if (response.status() >= 400) failedResources.push(`${response.status()} ${response.url()}`)
  })
  await page.route('**/*', route => {
    if (new URL(route.request().url()).origin === origin) return route.fallback()
    external.push(route.request().url())
    return route.abort('blockedbyclient')
  })
  await page.addInitScript(({ origin, profile, filters }) => {
    if (location.origin !== origin || sessionStorage.getItem('company-expansion-seeded')) return
    localStorage.setItem('orbit.v1.profile', JSON.stringify(profile))
    localStorage.setItem('orbit.v1.saved', '[]')
    localStorage.setItem('orbit.v1.exploration', JSON.stringify({
      source: 'public', selectedId: 'seoul', panelTab: 'cities', mapMode: 'flat', filters,
    }))
    sessionStorage.setItem('company-expansion-seeded', 'true')
  }, { origin, profile: COVERAGE_PROFILE, filters: COVERAGE_FILTERS })
  await page.goto(origin)
  await waitForSavedCommit(page)
  await expectInitialCatalogRequest(page, traffic)
  expect(await readSaved(page)).toEqual([])
  return { traffic, errors, external, failedResources }
}

async function catalog(page: Page, origin: string): Promise<Catalog> {
  const response = await page.request.get(`${origin}/api/catalog?source=public`)
  try {
    expect(response.status()).toBe(200)
    return await response.json()
  } finally { await response.dispose() }
}

function expectExpandedCatalog(value: Catalog, total: number) {
  expect(value.source).toBe('public')
  expect(value.companies).toHaveLength(83)
  expect(value.boards).toHaveLength(83)
  expect(value.companies.slice(0, 36)).toHaveLength(36)
  expect(value.jobs).toHaveLength(total)
  expect(value.companies.slice(24, 36).map(({ id, name, careerUrl, provider, board }) =>
    ({ id, name, careerUrl, provider, board }))).toEqual(EXPANDED_PUBLIC_REGISTRATIONS)
  expect(value.boards.every(board => board.status === 'ok' && board.dataStatus === 'fresh')).toBe(true)
  const addedIds = new Set(['openai', 'notion', 'reddit', 'discord', 'coinbase', 'dropbox',
    'duolingo', 'roblox', 'spacex', 'pinterest', 'databricks', 'robinhood'])
  expect(value.jobs.filter(job => addedIds.has(job.companyId)).map(job => ({
    companyId: job.companyId, source: job.source, id: job.id, title: job.title,
    role: job.role, url: job.url, cityIds: job.cityIds,
  }))).toEqual(EXPANSION_JOBS.map(({ nativeId: _nativeId, ...job }) => ({ ...job, cityIds: ['seoul'] })))
  expect(value.boards.filter(board => addedIds.has(board.companyId)).map(board =>
    [board.companyId, board.total, board.included])).toEqual([
    ['openai', 1, 1], ['notion', 1, 1], ['reddit', 1, 1], ['discord', 1, 1],
    ['coinbase', 1, 1], ['dropbox', 1, 1], ['duolingo', 1, 1], ['roblox', 1, 1],
    ['spacex', 1, 1], ['pinterest', 1, 1], ['databricks', 1, 1], ['robinhood', 1, 1],
  ])
}

async function closeTo(page: Page, opener: Locator) {
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(opener).toBeFocused()
}

async function role(page: Page, value: Filters['role'], count: number) {
  const opener = page.getByRole('button', { name: /^모든 필터/ })
  await opener.click()
  await page.getByLabel('직무', { exact: true }).selectOption(value)
  await page.getByRole('button', { name: `${count}개 공고 보기`, exact: true }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(opener).toBeFocused()
}

async function contextIs(page: Page, source: 'sample' | 'public', query: string, expectedRole: Filters['role']) {
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('orbit.v1.profile') ?? '{}'))).toEqual(COVERAGE_PROFILE)
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('orbit.v1.exploration') ?? '{}')))
    .toMatchObject({ source, filters: { query, role: expectedRole, region: 'all' } })
}

function expectSavedNotion(records: SavedJob[]) {
  expect(records).toHaveLength(1)
  expect(records[0]).toMatchObject({
    company: { id: 'notion', name: 'Notion', provider: 'ashby', board: 'notion' },
    job: {
      id: 'ashby-notion-synthetic-57102', companyId: 'notion', source: 'ashby',
      title: 'Backend Engineer — Synthetic Maple Index', cityIds: ['seoul'],
      locationLabel: 'Seoul, South Korea', url: 'https://example.com/synthetic/notion-57102',
    },
    status: 'applied', note: EXPANSION_NOTE,
  })
}

function privateTraffic(state: Awaited<ReturnType<typeof setup>>, origin: string) {
  for (const request of state.traffic.requests) {
    const url = new URL(request.url)
    expect(url.origin).toBe(origin)
    expect(request.method).toBe('GET')
    expect(request.body).toBeNull()
    expect(['/api/catalog', '/api/catalog/progress', '/api/posting-status']).toContain(url.pathname)
    for (const key of url.searchParams.keys()) expect(['source', 'refresh', 'id', 'after']).toContain(key)
  }
  expect(state.errors).toEqual([])
  expect(state.external).toEqual([])
  expect(state.failedResources).toEqual([])
}

async function image(page: Page, info: TestInfo, name: string) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  for (const dialog of await page.getByRole('dialog').all())
    expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
  expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze()).violations).toEqual([])
  await page.screenshot({ path: info.outputPath(name) })
}

for (const width of [1440, 320]) test.describe(`expanded default public companies at ${width}px`, () => {
  test.use({ viewport: { width, height: 960 }, isMobile: width === 320, hasTouch: width === 320 })

  test('the original twelve added registrations still collect fictional jobs through the83-source HTTP default and preserve query/filter context across sample selection', async ({ page, request, baseURL }, info) => {
    const mode = await readServerMode(request, `${baseURL}/api/health`)
    const server = await createPublicCoverageServer(info.outputPath('expanded-default-server'), mode)
    const responses = withSurveyEmptyBoards(expansionResponses())
    await server.respond(responses)
    try {
      await server.start()
      await server.verifyProductionBytes()
      const state = await setup(page, server.origin)
      await expect(page.locator('.city-detail-count strong')).toHaveText(['15', '16'])
      const before = await catalog(page, server.origin)
      expectExpandedCatalog(before, 17)
      expect(before.jobs.slice(0, 5).map(job => job.id)).toEqual([
        'greenhouse-stripe-44001', 'greenhouse-moloco-44101', 'greenhouse-moloco-44102',
        'greenhouse-sendbird-44201', 'greenhouse-sendbird-44202',
      ])
      await dataButton(page).click()
      await expect(page.getByRole('dialog').locator('.coverage-stats strong')).toHaveText(['22', '83', '17'])
      await expect(page.getByRole('list', { name: '공개 공고 출처' }).locator('li')).toHaveText([
        'Greenhouse50개 회사', 'Ashby24개 회사', 'Lever4개 회사', 'SmartRecruiters5개 회사',
      ])
      await page.getByRole('dialog').locator('.board-details > summary').click()
      for (const registration of EXPANDED_PUBLIC_REGISTRATIONS) {
        const row = page.getByRole('dialog').locator('.board-row').filter({ has: page.getByText(registration.name, { exact: true }) })
        await expect(row).toHaveCount(1)
        await expect(row).toContainText(registration.provider === 'ashby' ? 'Ashby' : 'Greenhouse')
      }
      await closeTo(page, dataButton(page))
      await role(page, 'backend', 14)
      await expect(page.locator('.city-detail-count strong')).toHaveText(['14', '14'])
      await search(page).fill('OpenAI')
      await expect(page.locator('.company-card h3')).toHaveText('OpenAI')
      await expect(page.locator('.mini-job-title')).toHaveText('Backend Engineer — Synthetic Cedar API')
      await search(page).fill('Discord')
      await expect(page.locator('.company-card h3')).toHaveText('Discord')
      await expect(page.locator('.mini-job-title')).toHaveText('Backend Engineer — Synthetic Willow Queue')
      await search(page).fill('Notion')
      await expect(page.locator('.mini-job-title')).toHaveText('Backend Engineer — Synthetic Maple Index')
      await contextIs(page, 'public', 'Notion', 'backend')

      await dataButton(page).click()
      await sourceChoice(page, 'sample').click()
      await expect(page.getByRole('dialog').locator('.coverage-stats strong')).toHaveText(['22', '32', '179'])
      await contextIs(page, 'sample', 'Notion', 'backend')
      await sourceChoice(page, 'public').click()
      await expect(page.getByRole('dialog').locator('.coverage-stats strong')).toHaveText(['22', '83', '17'])
      await closeTo(page, dataButton(page))
      await expect(search(page)).toHaveValue('Notion')
      await expect(page.locator('.city-detail-count strong')).toHaveText(['1', '1'])
      await expect(page.locator('.company-card h3')).toHaveText('Notion')
      await expect(page.locator('.mini-job-title')).toHaveText('Backend Engineer — Synthetic Maple Index')
      await contextIs(page, 'public', 'Notion', 'backend')
      expect(await readSaved(page)).toEqual([])
      await page.locator('.company-card').evaluate(element => element.scrollIntoView({ block: 'center' }))
      await expect(page.locator('.mini-job-title')).toBeInViewport({ ratio: 1 })
      await image(page, info, `new-default-notion-${width}.png`)

      const after = await catalog(page, server.origin)
      expect(after.jobs).toEqual(before.jobs)
      const upstream = await server.requests()
      expect(upstream).toHaveLength(83)
      expect(new Set(upstream.map(value => value.url)).size).toBe(83)
      expect(upstream.map(value => value.url).sort()).toEqual(Object.keys(responses).sort())
      expect(upstream.every(value => value.synthetic && !value.networkSent && value.method === 'GET')).toBe(true)
      await server.assertDefaultConfiguration()
      privateTraffic(state, server.origin)
      await writeFile(info.outputPath('expanded-default-observation.json'), JSON.stringify({ before, after, upstream }, null, 2))
    } finally {
      await page.close()
      await server.stop()
    }
  })

  test('an old24-board cache still fetches the original twelve plus47 missing sources and a saved public Notion remains unchanged across sample mode and a real restart', async ({ page, request, baseURL }, info) => {
    const mode = await readServerMode(request, `${baseURL}/api/health`)
    const oldTime = new Date(Date.now() - 5_000).toISOString()
    const old = expansionLegacyCache(oldTime)
    expect(old.boards).toHaveLength(24)
    const server = await createPublicCoverageServer(info.outputPath('expanded-cache-server'), mode, { cacheSeed: old })
    await server.respond(withSurveyEmptyBoards(expansionResponses()))
    try {
      await server.start()
      await server.verifyProductionBytes()
      const state = await setup(page, server.origin)
      await expect(page.locator('.city-detail-count strong')).toHaveText(['13', '13'])
      const before = await catalog(page, server.origin)
      expectExpandedCatalog(before, 13)
      expect(before.jobs[0]).toMatchObject({
        id: 'greenhouse-stripe-44001', title: COVERAGE_TITLES.stripe, fetchedAt: oldTime,
        updatedAt: COVERAGE_UPDATED_AT, url: 'https://example.com/synthetic/stripe-44001',
      })
      expect((await server.requests()).map(value => value.url).sort()).toEqual([...COVERAGE_EXPANSION_URLS, ...Object.values(SURVEY_FULL_URLS)].sort())
      const serializedCache = await readFile(server.defaultCache, 'utf8')
      const expanded = JSON.parse(serializedCache)
      expect(expanded.boards).toHaveLength(83)
      for (const original of old.boards) {
        expect(expanded.boards.find((board: { companyId: string }) => board.companyId === original.companyId)).toMatchObject(original)
      }

      await search(page).fill('Notion')
      await role(page, 'backend', 1)
      await expect(page.locator('.company-card h3')).toHaveText('Notion')
      const opener = page.getByRole('button', { name: 'Backend Engineer — Synthetic Maple Index', exact: true })
      await opener.click()
      await expect(page.getByRole('dialog', { name: 'Notion', exact: true }).locator('.job-detail-heading p')).toHaveText('Seoul, South Korea')
      await expect(page.getByRole('dialog').locator('.source-line')).toContainText('Ashby 공개 게시판')
      await expect(page.getByRole('link', { name: '원문에서 지원하기', exact: true })).toHaveAttribute('href', 'https://example.com/synthetic/notion-57102')
      await page.getByRole('button', { name: '기회 저장', exact: true }).click()
      await page.getByLabel('이 기회에 대한 나의 메모', { exact: true }).fill(EXPANSION_NOTE)
      await page.getByRole('button', { name: '지원 완료로 표시', exact: true }).click()
      await closeTo(page, opener)
      const records = await readSaved(page)
      expectSavedNotion(records)
      await page.getByRole('navigation', { name: '주요 메뉴' }).getByRole('button', { name: /^저장한 기회/ }).click()
      await page.getByRole('textbox', { name: '저장한 기회 검색', exact: true }).fill('확장 메모')
      await page.locator('.collection-tabs').getByRole('button', { name: /^지원 완료\s*1$/ }).click()
      await expect(page.locator('.saved-results-summary')).toHaveText('1개 기회 중 1–1개 표시')
      await expect(page.locator('.saved-title')).toHaveText('Backend Engineer — Synthetic Maple Index')
      await expect(page.locator('.saved-note-preview')).toHaveText(EXPANSION_NOTE)
      await expect(page.locator('.saved-status')).toHaveText('지원 완료')
      await page.getByRole('button', { name: '게시 상태 확인', exact: true }).click()
      await expect(page.locator('.posting-summary strong')).toHaveText(['1', '0', '0', '0'])
      await expect(page.locator('.posting-notice.changed')).toHaveCount(0)
      expect(await readSaved(page)).toEqual(records)
      await page.locator('.saved-card').evaluate(element => element.scrollIntoView({ block: 'center' }))
      await expect(page.locator('.saved-note-preview')).toBeInViewport({ ratio: 1 })
      await image(page, info, `new-default-saved-notion-${width}.png`)

      await dataButton(page).click()
      await sourceChoice(page, 'sample').click()
      await expect(page.getByRole('dialog').locator('.coverage-stats strong')).toHaveText(['22', '32', '179'])
      await closeTo(page, dataButton(page))
      await contextIs(page, 'sample', 'Notion', 'backend')
      expectSavedNotion(await readSaved(page))
      expect(await readSaved(page)).toEqual(records)
      await page.goto('about:blank')
      await server.stop()
      await server.start()
      await server.verifyProductionBytes()
      await page.goto(`${server.origin}/#saved`)
      await expect(page.locator('.saved-card h2')).toHaveText('Notion')
      await expect(page.locator('.saved-title')).toHaveText('Backend Engineer — Synthetic Maple Index')
      await expect(page.locator('.saved-note-preview')).toHaveText(EXPANSION_NOTE)
      await contextIs(page, 'sample', 'Notion', 'backend')
      expect(await readSaved(page)).toEqual(records)

      await dataButton(page).click()
      await sourceChoice(page, 'public').click()
      await expect(page.getByRole('dialog').locator('.coverage-stats strong')).toHaveText(['22', '83', '13'])
      await closeTo(page, dataButton(page))
      await contextIs(page, 'public', 'Notion', 'backend')
      const after = await catalog(page, server.origin)
      expect(after.jobs).toEqual(before.jobs)
      expect(await readFile(server.defaultCache, 'utf8')).toBe(serializedCache)
      expect(await readSaved(page)).toEqual(records)
      const upstream = await server.requests()
      expect(upstream).toHaveLength(59)
      expect(upstream.map(value => value.url).sort()).toEqual([...COVERAGE_EXPANSION_URLS, ...Object.values(SURVEY_FULL_URLS)].sort())
      expect(upstream.every(value => value.synthetic && !value.networkSent && value.method === 'GET')).toBe(true)
      await server.assertDefaultConfiguration()
      privateTraffic(state, server.origin)
      await writeFile(info.outputPath('expanded-cache-saved-observation.json'), JSON.stringify({ old, before, after, records, upstream }, null, 2))
    } finally {
      await page.close()
      await server.stop()
    }
  })
})
