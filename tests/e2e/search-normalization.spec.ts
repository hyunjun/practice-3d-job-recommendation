import { expect, test } from '@playwright/test'
import type { Page, TestInfo } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { DEFAULT_FILTERS } from '../../shared/types'
import type { Catalog, Filters, SavedJob } from '../../shared/types'
import {
  NORMALIZATION_FILTERS, NORMALIZATION_PROFILE, NORMALIZATION_TIME,
  markedScriptCatalog, normalizationCatalog, normalizationJob, normalizationSaved,
} from '../fixtures/search-normalization'
import { expectInitialCatalogRequest, watchApiRequests } from './helpers/api-requests'
import { parseSavedCsv } from './helpers/saved-pages'
import { readSaved, waitForSavedCommit } from './helpers/saved-store'

const MONTREAL = [
  'Backend Engineer — C++ Atlas', 'Backend Engineer — C# Beacon', 'Backend Engineer — .NET Compass',
]
const SAVED_TITLES = [
  'Backend Engineer — C++ Atlas', 'Backend Engineer — C# Beacon', 'Backend Engineer — .NET Compass',
  'Backend Engineer — São Paulo Ledger', 'Backend Engineer — Sao Paulo Harbor', 'Backend Engineer — Ｏｆｆｉｃｅ Grid',
]
const search = (page: Page) => page.getByRole('textbox', { name: '도시, 회사 또는 포지션 검색', exact: true })
const savedSearch = (page: Page) => page.getByRole('textbox', { name: '저장한 기회 검색', exact: true })
const tab = (page: Page, name: string) => page.locator('.results-tabs').getByRole('button', { name: new RegExp(`^${name}`) })
const region = (page: Page, name: string) => page.locator('.region-tabs').getByRole('button', { name, exact: true })
const savedStatus = (page: Page, name: string) => page.locator('.collection-tabs').getByRole('button', { name: new RegExp(`^${name}\\s*\\d+$`) })
const storedExploration = (page: Page) => page.evaluate(() => JSON.parse(localStorage.getItem('orbit.v1.exploration') || '{}'))

async function setup(page: Page, options: {
  getCatalog?: () => Catalog
  saved?: SavedJob[]
  filters?: Filters
  panelTab?: 'cities' | 'remote' | 'unmapped'
  savedOnly?: boolean
} = {}) {
  const origin = new URL(test.info().project.use.baseURL!).origin
  const traffic = watchApiRequests(page)
  const errors: string[] = []
  const external: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.route('**/*', route => {
    if (new URL(route.request().url()).origin === origin) return route.fallback()
    external.push(route.request().url())
    return route.abort('blockedbyclient')
  })
  await page.route('**/api/catalog?source=public*', route => route.fulfill({
    json: options.getCatalog?.() ?? normalizationCatalog(),
  }))
  await page.clock.setFixedTime(new Date(NORMALIZATION_TIME))
  await page.addInitScript(({ origin, profile, records, filters, panelTab, source }) => {
    if (location.origin !== origin || sessionStorage.getItem('normalization56-seeded')) return
    localStorage.setItem('orbit.v1.profile', JSON.stringify(profile))
    localStorage.setItem('orbit.v1.saved', JSON.stringify(records))
    localStorage.setItem('orbit.v1.exploration', JSON.stringify({
      source, mapMode: 'flat', selectedId: null, panelTab, filters,
    }))
    sessionStorage.setItem('normalization56-seeded', '1')
  }, {
    origin, profile: NORMALIZATION_PROFILE, records: options.saved ?? [],
    filters: options.filters ?? NORMALIZATION_FILTERS,
    panelTab: options.panelTab ?? 'unmapped', source: options.savedOnly ? 'sample' : 'public',
  })
  await page.goto(options.savedOnly ? '/#saved' : '/')
  await waitForSavedCommit(page)
  const initial = options.savedOnly ? { attempts: 0 } : await expectInitialCatalogRequest(page, traffic)
  return { origin, traffic, errors, external, initial }
}

async function expectTitles(page: Page, titles: string[], companyNames?: string[]) {
  if (companyNames) await expect(page.locator('.company-card h3')).toHaveText(companyNames)
  const collapsed = page.locator('.company-card .more-jobs[aria-expanded="false"]')
  while (await collapsed.count()) await collapsed.first().click()
  await expect(page.locator('.mini-job-title')).toHaveText(titles)
}

async function expectSaved(page: Page, titles: string[]) {
  await expect(page.locator('.saved-title')).toHaveText(titles)
  await expect(page.locator('.saved-card')).toHaveCount(titles.length)
  await expect(page.locator('.saved-results-summary')).toHaveText(
    titles.length ? `${titles.length}개 기회 중 1–${titles.length}개 표시` : '0개 기회',
  )
}

async function expectCount(page: Page, count: number) {
  await expect(page.locator('.active-filter-summary')).toContainText(`${count}개 공고가 현재 조건에 맞아요`)
}

async function privacy(page: Page, state: Awaited<ReturnType<typeof setup>>, following: string[] = []) {
  expect(state.traffic.requests.map(request => {
    const url = new URL(request.url)
    expect(url.origin).toBe(state.origin)
    expect(request.method).toBe('GET')
    expect(request.body).toBeNull()
    return url.pathname + url.search
  })).toEqual([
    ...Array<string>(state.initial.attempts).fill('/api/catalog?source=public'), ...following,
  ])
  expect(state.errors).toEqual([])
  expect(state.external).toEqual([])
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('orbit.v1.profile') || '{}'))).toEqual(NORMALIZATION_PROFILE)
}

async function screenshot(page: Page, info: TestInfo, name: string) {
  await page.screenshot({ path: info.outputPath(name) })
}

for (const width of [1440, 320]) test.describe(`Unicode search continuity at ${width}px`, () => {
  test.use({ viewport: { width, height: 960 }, isMobile: width === 320, hasTouch: width === 320 })

  test('folds actual spelling patterns across unmapped jobs while region, recovery Undo and hard filters keep their meaning', async ({ page }, info) => {
    const state = await setup(page, { filters: { ...NORMALIZATION_FILTERS, query: 'Montreal' } })
    await expectCount(page, 3)
    await expectTitles(page, MONTREAL, ['Café Atlas', 'Lumen Labs'])
    await expect(page.locator('.mini-job-location')).toHaveText(['Montréal, Canada', 'Montre\u0301al, Canada', 'Montreal, Canada'])
    for (const query of ['Montréal', 'Montre\u0301al', 'ＭＯＮＴＲＥＡＬ']) {
      await search(page).fill(query)
      await expectCount(page, 3)
      await expectTitles(page, MONTREAL)
      await expect(search(page)).toHaveValue(query)
    }
    await region(page, '미주').click()
    await expectTitles(page, MONTREAL)
    await region(page, '유럽').click()
    await expectCount(page, 0)
    await expect(page.locator('.mini-job-title')).toHaveCount(0)
    const worldRecovery = page.locator('.recovery-option').filter({ has: page.getByText('전 세계', { exact: true }) })
    await expect(worldRecovery.getByRole('button', { name: '회사 2곳 · 공고 3개 보기', exact: true })).toBeVisible()
    await worldRecovery.getByRole('button', { name: '회사 2곳 · 공고 3개 보기', exact: true }).click()
    await expect(region(page, '전 세계')).toHaveAttribute('aria-pressed', 'true')
    await expectTitles(page, MONTREAL)
    await expect(search(page)).toHaveValue('ＭＯＮＴＲＥＡＬ')
    await page.getByRole('button', { name: '실행 취소', exact: true }).click()
    await expect(region(page, '유럽')).toHaveAttribute('aria-pressed', 'true')
    await expectCount(page, 0)
    await expect(search(page)).toHaveValue('ＭＯＮＴＲＥＡＬ')
    await region(page, '미주').click()

    await page.getByRole('button', { name: /^모든 필터/ }).click()
    await page.getByLabel('고용 형태', { exact: true }).selectOption('contract')
    await page.getByRole('button', { name: '1개 공고 보기', exact: true }).click()
    await expectTitles(page, ['Backend Engineer — C# Beacon'])
    await search(page).fill('  Ｍｏｎｔｒｅａｌ\u00a0Ｃ＃  ')
    await expectTitles(page, ['Backend Engineer — C# Beacon'])
    await expect(search(page)).toHaveValue('  Ｍｏｎｔｒｅａｌ\u00a0Ｃ＃  ')
    await expect.poll(async () => (await storedExploration(page)).filters.query).toBe('  Ｍｏｎｔｒｅａｌ\u00a0Ｃ＃  ')
    await page.getByRole('button', { name: '검색어 지우기', exact: true }).click()
    await expect(search(page)).toHaveValue('')
    await expectTitles(page, ['Backend Engineer — C# Beacon'])
    await expect.poll(async () => (await storedExploration(page)).filters.employment).toBe('contract')
    await expect.poll(async () => (await storedExploration(page)).filters.region).toBe('americas')

    await page.getByRole('button', { name: /^모든 필터/ }).click()
    await page.getByLabel('고용 형태', { exact: true }).selectOption('all')
    await page.getByRole('button', { name: '7개 공고 보기', exact: true }).click()
    for (const [query, titles] of [
      ['Montréal C++', ['Backend Engineer — C++ Atlas']],
      ['Montreal .NET', ['Backend Engineer — .NET Compass']],
      ['Montreal C++ C#', []],
      ['Montreal NET.', []],
      ['Sao Paulo', ['Backend Engineer — São Paulo Ledger', 'Backend Engineer — Sao Paulo Harbor']],
      ['São\u3000Paulo', ['Backend Engineer — São Paulo Ledger', 'Backend Engineer — Sao Paulo Harbor']],
    ] as [string, string[]][]) {
      await search(page).fill(query)
      await expectCount(page, titles.length)
      await expectTitles(page, titles)
    }
    await screenshot(page, info, 'latin-source-spelling.png')
    await page.locator('.active-filter-summary').getByRole('button', { name: '초기화', exact: true }).click()
    await expect(search(page)).toHaveValue('')
    await expect(search(page)).toBeFocused()
    await expect(tab(page, '도시 탐색')).toHaveAttribute('aria-pressed', 'true')
    await expect(region(page, '전 세계')).toHaveAttribute('aria-pressed', 'true')
    await expect.poll(async () => (await storedExploration(page)).filters).toEqual(DEFAULT_FILTERS)
    await expect(page.locator('.city-row h3')).toHaveText(['서울', '런던'])
    await privacy(page, state)
  })

  test('equates canonical Hangul and width variants while keeping remote residence restrictions separate', async ({ page }, info) => {
    const state = await setup(page, { panelTab: 'cities' })
    for (const query of ['서울', '서울', 'Ｓｅｏｕｌ']) {
      await search(page).fill(query)
      await expectCount(page, 2)
      await expect(page.locator('.city-row h3')).toHaveText(['서울'])
      await expect(page.locator('.city-row-copy p')).toHaveText('대한민국·2개 공고')
      await expect(search(page)).toHaveValue(query)
    }
    await page.getByRole('button', { name: '서울, 추천 회사 2곳 보기', exact: true }).click()
    await expectTitles(page, ['Backend Engineer — 서울 Bridge', 'Backend Engineer — 서울 Beacon'])
    for (const [title, location] of [
      ['Backend Engineer — 서울 Bridge', '서울'],
      ['Backend Engineer — 서울 Beacon', '서울'],
    ]) {
      const opener = page.getByRole('button', { name: title, exact: true })
      await opener.click()
      await expect(page.getByRole('dialog').locator('.job-detail-heading p')).toHaveText(location)
      await page.keyboard.press('Escape')
      await expect(opener).toBeFocused()
    }
    await page.getByRole('button', { name: '모든 도시', exact: true }).click()
    await search(page).fill('oﬃce')
    await expectCount(page, 1)
    await expect(page.locator('.city-row h3')).toHaveText(['런던'])
    await page.getByRole('button', { name: '런던, 추천 회사 1곳 보기', exact: true }).click()
    await expectTitles(page, ['Backend Engineer — Ｏｆｆｉｃｅ Grid'])
    await expect(search(page)).toHaveValue('oﬃce')
    await screenshot(page, info, 'compatibility-title-preserved.png')

    await tab(page, '원격 기회').click()
    await search(page).fill('cafe relay')
    await expectTitles(page, ['Backend Engineer — Café Relay', 'Backend Engineer — Cafe\u0301 Relay Restricted'])
    await page.getByRole('button', { name: /^모든 필터/ }).click()
    await page.getByRole('checkbox', { name: /^거주 국가가 포함된 원격근무만/ }).check()
    await page.getByRole('button', { name: '1개 공고 보기', exact: true }).click()
    await expectTitles(page, ['Backend Engineer — Café Relay'])
    await expect(page.locator('.residence-button')).toHaveText('캐나다 거주 기준')
    await search(page).fill('Ｃａｆｅ\u0301 Relay Restricted')
    await expectCount(page, 0)
    const rangeRecovery = page.locator('.recovery-option').filter({ has: page.getByText('원격근무 지역', { exact: true }) })
    await expect(rangeRecovery.getByRole('button')).toHaveText('회사 1곳 · 공고 1개 보기')
    await rangeRecovery.getByRole('button').click()
    await expectTitles(page, ['Backend Engineer — Cafe\u0301 Relay Restricted'])
    await expect(page.locator('.remote-range-note')).toContainText('거주 국가 밖·지역 미확인 공고도 표시 중')
    await page.getByRole('button', { name: '실행 취소', exact: true }).click()
    await expectCount(page, 0)
    await expect(search(page)).toHaveValue('Ｃａｆｅ\u0301 Relay Restricted')
    await expect.poll(async () => (await storedExploration(page)).filters.remoteEligibleOnly).toBe(true)
    await privacy(page, state)
  })

  test('preserves Japanese voicing and Indic or Arabic marks in both global and saved search', async ({ page }, info) => {
    const catalog = markedScriptCatalog()
    const records: SavedJob[] = catalog.jobs.map(job => ({
      job, company: catalog.companies[1], savedAt: '2026-09-25T08:00:00.000Z', status: 'saved', note: '',
    }))
    const state = await setup(page, { getCatalog: () => catalog, saved: records })
    const cases: [string, string][] = [
      ['ガ', 'Backend Engineer — ガ'],
      ['カ\u3099', 'Backend Engineer — ガ'],
      ['ｶﾞ', 'Backend Engineer — ガ'],
      ['カ', 'Backend Engineer — カ'],
      ['कि', 'Backend Engineer — कि'],
      ['عَلَم', 'Backend Engineer — عَلَم'],
      ['علم', 'Backend Engineer — علم'],
    ]
    for (const [query, title] of cases) {
      await search(page).fill(query)
      await expectCount(page, 1)
      await expectTitles(page, [title])
      await expect(search(page)).toHaveValue(query)
    }
    await page.getByRole('navigation', { name: '주요 메뉴' }).getByRole('button', { name: /^저장한 기회/ }).click()
    for (const [query, title] of cases) {
      await savedSearch(page).fill(query)
      await expectSaved(page, [title])
      await expect(savedSearch(page)).toHaveValue(query)
    }
    await screenshot(page, info, 'meaningful-mark-search.png')
    expect((await readSaved(page)).map(record => record.job.title)).toEqual([
      'Backend Engineer — ガ', 'Backend Engineer — カ', 'Backend Engineer — कि',
      'Backend Engineer — क', 'Backend Engineer — عَلَم', 'Backend Engineer — علم',
    ])
    await privacy(page, state)
  })

  test('searches saved spelling and note variants with all tokens and status filters, then exports every original record', async ({ page }, info) => {
    const state = await setup(page, { savedOnly: true, saved: normalizationSaved() })
    await expectSaved(page, SAVED_TITLES)
    const before = await readSaved(page)
    for (const [query, titles] of [
      ['Montreal', MONTREAL],
      ['Montréal', MONTREAL],
      ['Montre\u0301al', MONTREAL],
      ['  ＭＯＮＴＲＥＡＬ  ', MONTREAL],
      ['Cafe\u0301 Atlas C#', ['Backend Engineer — C# Beacon']],
      ['naive facade', ['Backend Engineer — C++ Atlas']],
      ['Ｃ＋＋', ['Backend Engineer — C++ Atlas']],
      ['C#', ['Backend Engineer — C# Beacon']],
      ['.NET', ['Backend Engineer — .NET Compass']],
      ['NET.', []],
      ['C++ C#', []],
      ['resume ledger', ['Backend Engineer — São Paulo Ledger']],
      ['office', ['Backend Engineer — Ｏｆｆｉｃｅ Grid']],
      ['Ｓａｏ\u3000Ｐａｕｌｏ', ['Backend Engineer — São Paulo Ledger', 'Backend Engineer — Sao Paulo Harbor']],
    ] as [string, string[]][]) {
      await savedSearch(page).fill(query)
      await expectSaved(page, titles)
      await expect(savedSearch(page)).toHaveValue(query)
    }
    await savedSearch(page).fill('Montre\u0301al')
    await savedStatus(page, '지원 완료').click()
    await expectSaved(page, ['Backend Engineer — .NET Compass'])
    await expect(savedSearch(page)).toHaveValue('Montre\u0301al')
    await savedSearch(page).fill('')
    await expectSaved(page, ['Backend Engineer — .NET Compass', 'Backend Engineer — São Paulo Ledger'])
    await savedStatus(page, '전체').click()
    await expectSaved(page, SAVED_TITLES)
    await expect(page.locator('.collection-tabs button')).toHaveText(['전체6', '검토 중4', '지원 완료2'])
    await savedSearch(page).fill('naive facade')
    await expectSaved(page, ['Backend Engineer — C++ Atlas'])
    await screenshot(page, info, 'saved-literal-note-filter.png')

    const csvDownload = page.waitForEvent('download')
    await page.getByRole('button', { name: 'CSV 내보내기', exact: true }).click()
    const [headers, ...csv] = parseSavedCsv(await readFile((await (await csvDownload).path())!, 'utf8'))
    expect(csv).toHaveLength(6)
    expect(headers).toHaveLength(47)
    const column = (name: string) => {
      const index = headers.indexOf(name)
      expect(index, `CSV column ${name}`).toBeGreaterThanOrEqual(0)
      return index
    }
    expect(csv.map(row => row[column('포지션')])).toEqual(SAVED_TITLES)
    expect(csv.map(row => row[column('근무지')])).toEqual([
      'Montréal, Canada', 'Montre\u0301al, Canada', 'Montreal, Canada',
      'São Paulo, Brazil', 'Sao Paulo, Brazil', 'London',
    ])
    expect(csv.map(row => row[column('회사')])).toEqual(['Café Atlas', 'Café Atlas', 'Lumen Labs', 'Café Atlas', 'Lumen Labs', 'Lumen Labs'])
    expect(csv.map(row => row[column('메모')])).toEqual([
      'Révision originale — naïve façade', 'Cafe\u0301 follow-up', 'crème brûlée; PRIVATE56',
      'São Paulo — résumé', 'plain harbor note', '\'=1+2\nPRIVATE-NOTE56 résumé, "原文" ガ कि عَلَم',
    ])
    await page.getByRole('button', { name: '기록 백업·복원', exact: true }).click()
    const jsonDownload = page.waitForEvent('download')
    await page.getByRole('button', { name: 'JSON 백업', exact: true }).click()
    const backup = JSON.parse(await readFile((await (await jsonDownload).path())!, 'utf8'))
    expect(backup.format).toBe('orbit-saved-backup')
    expect(backup.records).toEqual(before)
    expect(backup.records).toHaveLength(6)
    expect(backup.records[5].note).toBe('=1+2\nPRIVATE-NOTE56 résumé, "原文" ガ कि عَلَم')
    expect(backup.profile).toBeUndefined()
    await page.keyboard.press('Escape')
    await expect(savedSearch(page)).toHaveValue('naive facade')
    await expectSaved(page, ['Backend Engineer — C++ Atlas'])
    expect(await readSaved(page)).toEqual(before)
    await privacy(page, state)
  })

  test('updates normalized note membership immediately, retains application status through delete Undo and reload, and preserves raw notes', async ({ page }, info) => {
    const state = await setup(page, { savedOnly: true, saved: normalizationSaved() })
    const before = await readSaved(page)
    await savedSearch(page).fill('CREME BRULEE')
    await savedStatus(page, '지원 완료').click()
    await expectSaved(page, ['Backend Engineer — .NET Compass'])
    await page.getByRole('button', { name: 'Backend Engineer — .NET Compass', exact: true }).click()
    const note = 'jalapeño re\u0301sume\u0301 — PRIVATE-NOTE56'
    await page.getByLabel('이 기회에 대한 나의 메모', { exact: true }).fill(note)
    await waitForSavedCommit(page)
    await expect(page.getByLabel('이 기회에 대한 나의 메모', { exact: true })).toHaveValue(note)
    await page.keyboard.press('Escape')
    await expectSaved(page, [])
    await expect(savedSearch(page)).toHaveValue('CREME BRULEE')
    await savedSearch(page).fill('JALAPENO RESUME')
    await expectSaved(page, ['Backend Engineer — .NET Compass'])
    await page.getByRole('button', { name: 'Backend Engineer — .NET Compass', exact: true }).click()
    await page.getByRole('button', { name: '지원 완료로 표시됨', exact: true }).click()
    await waitForSavedCommit(page)
    await page.keyboard.press('Escape')
    await expectSaved(page, [])
    await savedStatus(page, '검토 중').click()
    await expectSaved(page, ['Backend Engineer — .NET Compass'])
    await expect(page.locator('.saved-note-preview')).toHaveText(note)
    await expect(page.locator('.collection-tabs button')).toHaveText(['전체6', '검토 중5', '지원 완료1'])
    await page.getByRole('button', { name: 'Lumen Labs 저장 취소', exact: true }).click()
    await waitForSavedCommit(page)
    await expectSaved(page, [])
    await page.getByRole('button', { name: '실행 취소', exact: true }).click()
    await waitForSavedCommit(page)
    await expectSaved(page, ['Backend Engineer — .NET Compass'])
    await expect(savedSearch(page)).toHaveValue('JALAPENO RESUME')
    await expect(page.locator('.saved-status')).toHaveText('검토 중')
    await expect(page.locator('.saved-note-preview')).toHaveText(note)
    await screenshot(page, info, 'edited-note-after-undo.png')
    const after = await readSaved(page)
    expect(after.find(record => record.job.id === 'greenhouse-lumen56-03')).toEqual({
      ...before.find(record => record.job.id === 'greenhouse-lumen56-03')!, status: 'saved', note,
    })
    expect(after.filter(record => record.job.id !== 'greenhouse-lumen56-03')).toEqual(
      before.filter(record => record.job.id !== 'greenhouse-lumen56-03'),
    )
    await page.reload()
    await waitForSavedCommit(page)
    await expect(savedSearch(page)).toHaveValue('')
    await savedSearch(page).fill('jalapeño résumé')
    await expectSaved(page, ['Backend Engineer — .NET Compass'])
    await expect(page.locator('.saved-note-preview')).toHaveText(note)
    await expect(page.locator('.saved-status')).toHaveText('검토 중')
    expect(await readSaved(page)).toEqual(after)
    await expect(page.locator('.posting-summary')).toContainText('직접 확인할 때만 조회해요.')
    await privacy(page, state)
  })

  test('refreshes a same-ID catalog search while the saved snapshot and original query stay independent', async ({ page }, info) => {
    let current = normalizationCatalog([
      normalizationJob('greenhouse-lumen56-refresh', {
        title: 'Backend Engineer — Montréal Draft', locationLabel: 'Montréal, Canada',
        workplaceLocations: { version: 1, locations: [{ label: 'Montréal, Canada', country: 'CA' }] },
      }),
    ], 1)
    const state = await setup(page, {
      getCatalog: () => current, filters: { ...NORMALIZATION_FILTERS, query: '  Ｍｏｎｔｒｅａｌ  ' },
    })
    await expectTitles(page, ['Backend Engineer — Montréal Draft'])
    await page.getByRole('button', { name: 'Backend Engineer — Montréal Draft', exact: true }).click()
    await page.getByRole('button', { name: '기회 저장', exact: true }).click()
    await waitForSavedCommit(page)
    await page.getByLabel('이 기회에 대한 나의 메모', { exact: true }).fill('Original résumé — PRIVATE56')
    await waitForSavedCommit(page)
    await page.keyboard.press('Escape')
    const saved = await readSaved(page)
    current = normalizationCatalog([
      normalizationJob('greenhouse-lumen56-refresh', {
        title: 'Backend Engineer — Reykjavík Revision', locationLabel: 'Reykjavi\u0301k, Iceland',
        workplaceLocations: { version: 1, locations: [{ label: 'Reykjavi\u0301k, Iceland', country: 'IS' }] },
      }),
    ], 1)
    await page.getByRole('button', { name: '공개 채용', exact: true }).click()
    await page.getByRole('button', { name: '새로고침', exact: true }).click()
    await page.getByRole('button', { name: '닫기', exact: true }).click()
    await expectCount(page, 0)
    await expectTitles(page, [])
    await expect(search(page)).toHaveValue('  Ｍｏｎｔｒｅａｌ  ')
    await expect.poll(async () => (await storedExploration(page)).filters.query).toBe('  Ｍｏｎｔｒｅａｌ  ')
    await search(page).fill('reykjavik')
    await expectCount(page, 1)
    await expectTitles(page, ['Backend Engineer — Reykjavík Revision'])
    await expect(page.locator('.mini-job-location')).toHaveText('Reykjavi\u0301k, Iceland')
    await region(page, '유럽').click()
    await expectTitles(page, ['Backend Engineer — Reykjavík Revision'])
    await screenshot(page, info, 'refreshed-source-search.png')
    await page.getByRole('navigation', { name: '주요 메뉴' }).getByRole('button', { name: /^저장한 기회/ }).click()
    await savedSearch(page).fill('Montreal')
    await expectSaved(page, ['Backend Engineer — Montréal Draft'])
    await expect(page.locator('.saved-location')).toHaveText('Montréal, Canada')
    await expect(page.locator('.saved-note-preview')).toHaveText('Original résumé — PRIVATE56')
    await savedSearch(page).fill('Reykjavik')
    await expectSaved(page, [])
    expect(await readSaved(page)).toEqual(saved)
    await expect(page.locator('.posting-summary')).toContainText('직접 확인할 때만 조회해요.')
    await privacy(page, state, ['/api/catalog?source=public&refresh=1'])
  })
})
