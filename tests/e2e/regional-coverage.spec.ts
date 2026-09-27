import { expect } from '@playwright/test'
import type { Locator, Page, TestInfo } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import type { SavedJob } from '../../shared/types'
import {
  REGIONAL_ALL_CITIES, REGIONAL_BODY, REGIONAL_LATER, REGIONAL_NOTE, REGIONAL_TIME,
  regionalCatalog, regionalLegacyJob, regionalLegacyJobs, regionalPartialCatalog, regionalSavedDubai,
} from '../fixtures/regional-coverage'
import { regionalObservationHistory } from '../fixtures/regional-observations'
import {
  regionalTest as test, regionalClose, regionalExploration, regionalRegion as region,
  regionalSearch as search, regionalTab as tab, regionalTitles as titles, regionalZoomCluster,
} from './helpers/regional-coverage'
import { expectFlatMapFocus, expectFlatMapTargets } from './helpers/flat-map'
import { readSaved, waitForSavedCommit } from './helpers/saved-store'
import { csvRows, downloadText } from './helpers/source-integrations'

const navigation = (page: Page) => page.getByRole('navigation', { name: '주요 메뉴' })
const dataButton = (page: Page) => page.getByRole('button', { name: '데이터와 추천 방식', exact: true })
const city = (page: Page, name: string) => page.getByRole('button', { name: `${name}, 추천 회사 1곳 보기`, exact: true })
const mapCity = (page: Page, name: string) => page.locator('.flat-map').getByRole('button', {
  name: `${name}, 추천 회사 1곳, 회사 보기`, exact: true,
})

async function audit(page: Page, info: TestInfo, name: string) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  for (const dialog of await page.getByRole('dialog').all())
    expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
  expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze()).violations).toEqual([])
  await info.attach(name, { body: await page.screenshot(), contentType: 'image/png' })
}

async function revealFlat(page: Page, name: string) {
  for (let step = 0; step < 8; step++) {
    if (await mapCity(page, name).count()) break
    const cluster = page.locator('.flat-marker[aria-label*="확대해서"]').first()
    await expect(cluster).toBeVisible()
    const scale = async () => Number((await page.locator('.flat-map svg > g').getAttribute('transform'))!.match(/scale\(([^)]+)\)/)![1])
    const before = await scale()
    await cluster.focus()
    await cluster.press('Enter')
    await expect.poll(scale).toBeGreaterThan(before)
    await expectFlatMapTargets(page)
  }
  const marker = mapCity(page, name)
  await expect(marker).toBeVisible()
  await marker.focus()
  await expectFlatMapFocus(marker)
  return marker
}

function savedDubai(records: SavedJob[]) {
  expect(records).toHaveLength(1)
  expect(records[0]).toMatchObject({
    company: { id: 'regional-cedar', name: 'Cedar Route Laboratory', provider: 'greenhouse', board: 'RegionalCedar70' },
    job: {
      id: 'greenhouse-regional-cedar-dubai', source: 'greenhouse', companyId: 'regional-cedar',
      title: 'Backend Engineer — Dubai Ledger', cityIds: ['dubai'], cityCoverageVersion: 1,
      // Remote re-interpretation applies to remote jobs; this onsite source
      // keeps its older remote stamp while receiving city coverage version1.
      remoteScopeVersion: 2, locationLabel: 'Dubai, United Arab Emirates',
      description: REGIONAL_BODY, url: 'https://example.test/regional/dubai',
      fetchedAt: '2026-09-27T06:00:00.000Z', updatedAt: '2026-09-26T18:30:00.000Z',
    },
    savedAt: '2026-09-26T20:00:00.000Z', status: 'applied', note: REGIONAL_NOTE,
  })
}

async function observationRow(table: Locator, name: string, cells: string[]) {
  await expect(table.getByRole('rowheader', { name, exact: true }).locator('..').getByRole('cell')).toHaveText(cells)
}

for (const width of [1440, 320]) test.describe(`regional coverage at ${width}px`, () => {
  test.use({ viewport: { width, height: 960 }, isMobile: width === 320, hasTouch: width === 320 })
  test.setTimeout(90_000)

  test('35 literal cities retain region counts and New Zealand is reachable from the APAC globe', async ({ page, regional }, info) => {
    const initial = await regional.open()
    await expect(page.locator('.city-row')).toHaveCount(35)
    await expect(page.locator('.map-stats strong')).toHaveText(['1곳', '35곳'])
    await expect(page.locator('.region-tabs button')).toHaveText(['전 세계', '미주', '유럽', '아시아 · 태평양', '중동'])
    for (const [name, count] of [['미주', 10], ['유럽', 9], ['아시아 · 태평양', 15], ['중동', 1], ['전 세계', 35]] as const) {
      const button = region(page, name)
      await button.focus()
      await button.press('Enter')
      await expect(button).toHaveAttribute('aria-pressed', 'true')
      await expect(page.locator('.city-row')).toHaveCount(count)
    }
    await region(page, '아시아 · 태평양').click()
    await search(page).fill('New Zealand')
    await expect(page.locator('.city-row')).toHaveCount(3)
    expect((await page.locator('.city-row h3').allTextContents()).sort()).toEqual(['오클랜드', '웰링턴', '크라이스트처치'])
    await page.getByRole('button', { name: '3D 지구', exact: true }).click()
    await expect(page.locator('.earth-canvas')).toHaveClass(/is-ready/)
    await expect(page.locator('.globe-pin').filter({ hasText: /오클랜드|웰링턴|크라이스트처치/ }).first()).toBeVisible()
    // Selecting a genuine cluster zooms it; no camera state is injected.
    const auckland = page.locator('.globe-markers').getByRole('button', {
      name: '오클랜드, 추천 회사 1곳, 회사 보기', exact: true,
    })
    for (let step = 0; step < 8 && !await auckland.count(); step++) {
      const cluster = page.locator('.globe-pin.is-cluster').first()
      await expect(cluster).toBeVisible()
      await regionalZoomCluster(page, cluster, info, step + 1)
    }
    await auckland.click()
    await expect(page.locator('.city-hero-caption h2')).toContainText('오클랜드')
    await expect(page.locator('.mini-job-title')).toHaveText('Backend Engineer — Auckland Harbor')
    await info.attach(`new-zealand-globe-selected-${width}`, {
      body: await page.locator('.earth-canvas').screenshot(), contentType: 'image/png',
    })
    await page.locator('.city-hero-caption h2').scrollIntoViewIfNeeded()
    await info.attach(`new-zealand-company-selected-${width}`, {
      body: await page.screenshot(), contentType: 'image/png',
    })
    await page.getByRole('button', { name: '2D 지도', exact: true }).click()
    await expect(page.locator('.city-hero-caption h2')).toContainText('오클랜드')
    await expect(search(page)).toHaveValue('New Zealand')
    await expect(region(page, '아시아 · 태평양')).toHaveAttribute('aria-pressed', 'true')
    await audit(page, info, `new-zealand-selected-${width}`)
    await regional.expectPaths(initial.attempts)
  })

  test('Taipei/Hsinchu and Pacific Northwest clusters expose individual cities with usable keyboard and touch targets', async ({ page, regional }, info) => {
    const dense = regionalCatalog([
      ...regionalLegacyJobs().filter(job => ['greenhouse-regional-cedar-taipei', 'greenhouse-regional-cedar-hsinchu', 'greenhouse-regional-cedar-portland'].includes(job.id)),
      regionalLegacyJob('near-seattle', { cityIds: ['seattle'], locationLabel: 'Seattle, Washington, United States' }),
      regionalLegacyJob('near-vancouver', { cityIds: ['vancouver'], locationLabel: 'Vancouver, Canada' }),
    ], 3, REGIONAL_ALL_CITIES)
    const initial = await regional.open({ catalog: dense, filters: { region: 'asia-pacific' } })
    await expect(page.locator('.city-row')).toHaveCount(2)
    await page.locator('.flat-map svg').focus()
    await page.locator('.flat-map svg').press('Home')
    await expect(page.locator('.flat-marker')).toHaveCount(1)
    await expect(page.locator('.flat-marker')).toHaveAttribute('aria-label', /외 1개 도시, 추천 회사 1곳, 확대해서 도시별로 보기$/)
    const taipei = await revealFlat(page, '타이베이')
    await expectFlatMapTargets(page)
    await taipei.press('Enter')
    await expect(page.locator('.mini-job-title')).toHaveText('Backend Engineer — Taipei Lantern')
    await page.getByRole('button', { name: '모든 도시', exact: true }).click()
    const hsinchu = await revealFlat(page, '신주')
    if (width === 320) await hsinchu.tap()
    else await hsinchu.press(' ')
    await expect(page.locator('.mini-job-title')).toHaveText('Backend Engineer — Hsinchu Relay')
    await region(page, '미주').click()
    await expect(page.locator('.city-row')).toHaveCount(3)
    await page.locator('.flat-map svg').focus()
    await page.locator('.flat-map svg').press('Home')
    const portland = await revealFlat(page, '포틀랜드')
    await portland.press('Enter')
    await expect(page.locator('.city-hero-caption h2')).toContainText('포틀랜드')
    await expect(page.locator('.mini-job-title')).toHaveText('Backend Engineer — Portland Switch')
    await expect(page.locator('.map-stats strong')).toHaveText(['1곳', '3곳'])
    await audit(page, info, `dense-regional-selection-${width}`)
    await regional.expectPaths(initial.attempts)
  })

  test('an older saved Dubai record keeps its source and private note through Middle East exploration, reload and backups', async ({ page, regional }, info) => {
    const initial = await regional.open({
      filters: { region: 'middle-east', query: 'Ledger' }, selectedId: 'dubai',
      saved: [regionalSavedDubai()],
    })
    await expect(page.locator('.city-hero-caption h2')).toContainText('두바이')
    await expect(page.locator('.mini-job-title')).toHaveText('Backend Engineer — Dubai Ledger')
    savedDubai(await readSaved(page))
    await page.getByRole('button', { name: '3D 지구', exact: true }).click()
    await expect(page.locator('.earth-canvas')).toHaveClass(/is-ready/)
    await expect(page.locator('.globe-markers').getByRole('button', { name: '두바이, 추천 회사 1곳, 회사 보기', exact: true })).toBeVisible()
    await page.reload()
    await expect(page.locator('.earth-canvas')).toHaveClass(/is-ready/)
    await expect(region(page, '중동')).toHaveAttribute('aria-pressed', 'true')
    await expect(search(page)).toHaveValue('Ledger')
    await expect(page.locator('.city-hero-caption h2')).toContainText('두바이')
    expect(await regionalExploration(page)).toMatchObject({
      source: 'public', selectedId: 'dubai', panelTab: 'cities', mapMode: 'globe',
      filters: { region: 'middle-east', query: 'Ledger', role: 'backend', remoteEligibleOnly: true },
    })
    await navigation(page).getByRole('button', { name: /^저장한 기회/ }).click()
    await expect(page.locator('.saved-title')).toHaveText('Backend Engineer — Dubai Ledger')
    await page.locator('.saved-title').click()
    await expect(page.getByRole('link', { name: '원문에서 지원하기', exact: true })).toHaveAttribute('href', 'https://example.test/regional/dubai')
    await expect(page.getByLabel('이 기회에 대한 나의 메모', { exact: true })).toHaveValue(REGIONAL_NOTE)
    await page.locator('.original-description > summary').click()
    await expect(page.locator('.job-description')).toHaveText(REGIONAL_BODY)
    await audit(page, info, `legacy-dubai-source-${width}`)
    await regionalClose(page)
    const csv = csvRows(await downloadText(page, 'CSV 내보내기'))
    expect(csv).toHaveLength(2)
    expect(csv[0]).toHaveLength(48)
    expect(Object.fromEntries(csv[0].map((header, index) => [header, csv[1][index]]))).toMatchObject({
      '포지션': 'Backend Engineer — Dubai Ledger', '근무지': 'Dubai, United Arab Emirates',
      '채용 링크': 'https://example.test/regional/dubai', '메모': REGIONAL_NOTE, '상태': '지원 완료',
      '저장일': '2026-09-26T20:00:00.000Z', '저장 내용의 조회 시각': '2026-09-27T06:00:00.000Z',
    })
    await page.getByRole('button', { name: '기록 백업·복원', exact: true }).click()
    const backup = JSON.parse(await downloadText(page, 'JSON 백업'))
    expect(backup).toMatchObject({ format: 'orbit-saved-backup', version: 1, includesUnsavedChanges: false })
    savedDubai(backup.records)
    await page.getByRole('button', { name: '완료', exact: true }).click()
    await navigation(page).getByRole('button', { name: '기회 탐색', exact: true }).click()
    await page.getByRole('button', { name: '2D 지도', exact: true }).click()
    await expect(page.locator('.city-hero-caption h2')).toContainText('두바이')
    await region(page, '아시아 · 태평양').click()
    await expect(page.locator('.city-hero-caption')).toHaveCount(0)
    await expect(search(page)).toHaveValue('Ledger')
    savedDubai(await readSaved(page))
    expect(regional.traffic.catalog().filter(request => request.state === 'finished')).toHaveLength(2)
    expect(regional.traffic.requests.every(request => new URL(request.url).pathname === '/api/catalog')).toBe(true)
    expect(initial.attempts).toBeGreaterThan(0)
  })

  test('the native Worker preserves a European other workplace, query recovery and saved source during a same-ID regional update', async ({ page, regional }, info) => {
    const first = regionalPartialCatalog()
    first.refreshAfter = '2026-09-27T06:01:00.000Z'
    const initial = await regional.open({ catalog: first, filters: { remoteEligibleOnly: false } })
    await expect(page.locator('.city-row')).toHaveCount(3)
    await tab(page, '기타 근무지').click()
    await titles(page, ['Backend Engineer — Estonian Workshop'])
    await region(page, '유럽').click()
    await titles(page, ['Backend Engineer — Baltic Bridge', 'Backend Engineer — Estonian Workshop'])
    await expect(page.locator('.list-toolbar > span')).toHaveText('1개 회사 · 2개 공고')
    await expect(page.locator('.map-stats strong')).toHaveText(['1곳', '1곳'])
    await search(page).fill('Baltic')
    await titles(page, ['Backend Engineer — Baltic Bridge'])
    await tab(page, '도시 탐색').click()
    await expect(page.locator('.city-row')).toHaveCount(0)
    await page.getByRole('button', { name: /기타 근무지 보기/ }).click()
    await titles(page, ['Backend Engineer — Baltic Bridge'])
    await expect(region(page, '유럽')).toHaveAttribute('aria-pressed', 'true')
    await search(page).fill('PRIVATE_REGIONAL70_MISSING')
    const queryRecovery = page.locator('.recovery-option').filter({ has: page.getByText('검색어', { exact: true }) })
    await expect(queryRecovery.locator('button')).toHaveText('회사 1곳 · 공고 2개 보기')
    await queryRecovery.locator('button').focus()
    await queryRecovery.locator('button').press('Enter')
    await titles(page, ['Backend Engineer — Baltic Bridge', 'Backend Engineer — Estonian Workshop'])
    await page.getByRole('button', { name: '실행 취소', exact: true }).click()
    await expect(search(page)).toHaveValue('PRIVATE_REGIONAL70_MISSING')
    await search(page).fill('Baltic')
    await titles(page, ['Backend Engineer — Baltic Bridge'])
    await page.locator('.mini-job-title').click()
    await page.getByRole('button', { name: '기회 저장', exact: true }).click()
    await page.getByLabel('이 기회에 대한 나의 메모', { exact: true }).fill('PRIVATE_REGIONAL70_BALTIC — preserve Tallinn evidence')
    await page.getByRole('button', { name: '지원 완료로 표시', exact: true }).click()
    await waitForSavedCommit(page)
    await regionalClose(page)
    await region(page, '아시아 · 태평양').click()
    await tab(page, '도시 탐색').click()
    await expect(page.locator('.city-row h3')).toHaveText('쿠알라룸푸르')
    await city(page, '쿠알라룸푸르').click()
    await expect(page.locator('.mini-job-title')).toHaveText('Backend Engineer — Baltic Bridge')
    await region(page, '유럽').click()
    await tab(page, '기타 근무지').click()
    await expect(page.locator('.mini-job-title')).toHaveText('Backend Engineer — Baltic Bridge')

    const changed = regionalPartialCatalog()
    changed.jobs[0].locationLabel = 'Dubai, United Arab Emirates · Petaling Jaya, Malaysia'
    changed.jobs[0].workplaceLocations = { version: 1, locations: [
      { label: 'Dubai', country: 'AE' }, { label: 'Petaling Jaya', country: 'MY' },
    ] }
    changed.checkedAt = changed.fetchedAt = REGIONAL_LATER
    changed.boards[0].checkedAt = changed.boards[0].lastSuccessAt = REGIONAL_LATER
    for (const job of changed.jobs) job.fetchedAt = REGIONAL_LATER
    regional.respond(changed)
    await page.clock.setFixedTime(new Date(REGIONAL_LATER))
    await dataButton(page).click()
    await page.getByRole('button', { name: '새로고침', exact: true }).click()
    await expect(page.getByRole('dialog').locator('.board-row time')).toHaveAttribute('datetime', REGIONAL_LATER)
    await expect(page.getByRole('dialog').locator('.coverage-stats strong')).toHaveText(['35', '1', '4'])
    await expect(page.getByRole('dialog')).toContainText('지도에 연결되지 않은 1개 개발 공고도')
    await regionalClose(page)
    await expect(page.locator('.mini-job-title')).toHaveCount(0)
    await expect(search(page)).toHaveValue('Baltic')
    await expect(region(page, '유럽')).toHaveAttribute('aria-pressed', 'true')
    await search(page).fill('')
    await titles(page, ['Backend Engineer — Estonian Workshop'])
    await region(page, '중동').click()
    await tab(page, '도시 탐색').click()
    await expect(page.locator('.city-row h3')).toHaveText('두바이')
    await city(page, '두바이').click()
    await expect(page.locator('.mini-job-title')).toHaveText('Backend Engineer — Baltic Bridge')
    const saved = await readSaved(page)
    expect(saved).toHaveLength(1)
    expect(saved[0]).toMatchObject({
      status: 'applied', note: 'PRIVATE_REGIONAL70_BALTIC — preserve Tallinn evidence',
      job: {
        id: 'greenhouse-regional-cedar-partial-baltic', cityIds: ['kuala-lumpur'],
        locationLabel: 'Tallinn, Estonia · Petaling Jaya, Malaysia',
        description: REGIONAL_BODY, fetchedAt: REGIONAL_TIME,
        url: 'https://example.test/regional/partial-baltic',
        workplaceLocations: { version: 1, locations: [{ label: 'Tallinn', country: 'EE' }, { label: 'Petaling Jaya', country: 'MY' }] },
      },
    })
    await audit(page, info, `partial-workplace-updated-${width}`)
    await regional.expectPaths(initial.attempts, ['/api/catalog?source=public&refresh=1'])
  })

  test('Middle East city, country-only and remote views stay separate while an eligibility toggle discloses unconfirmed regional scope', async ({ page, regional }, info) => {
    const catalog = regionalCatalog([
      regionalLegacyJob(),
      regionalLegacyJob('uae-country', { title: 'Backend Engineer — UAE Country', locationLabel: 'UAE' }),
      regionalLegacyJob('remote-uae', {
        title: 'Backend Engineer — UAE Remote', workMode: 'remote', locationLabel: 'Dubai · Remote', remoteScopeUnknown: true,
      }),
      regionalLegacyJob('remote-me', {
        title: 'Backend Engineer — Middle East Remote', workMode: 'remote', locationLabel: 'Remote · Middle East', remoteScopeUnknown: true,
      }),
      regionalLegacyJob('taiwan-country', { title: 'Backend Engineer — Taiwan Country', locationLabel: 'Taiwan' }),
      regionalLegacyJob('nz-country', { title: 'Backend Engineer — NZ Country', locationLabel: 'New Zealand' }),
      regionalLegacyJob('unknown-country', {
        title: 'Backend Engineer — Unconfirmed Source',
        workplaceLocations: { version: 1, locations: [{ label: 'Dubai, UAE', country: 'Unknown Republic' }] },
      }),
      regionalLegacyJob('conflicting-country', {
        title: 'Backend Engineer — Conflicting Source', locationLabel: 'Taipei, Taiwan',
        workplaceLocations: { version: 1, locations: [{ label: 'Taipei, Taiwan', country: 'NZ' }] },
      }),
    ], 6, REGIONAL_ALL_CITIES)
    const initial = await regional.open({ catalog, filters: { region: 'middle-east' } })
    await expect(page.locator('.city-row h3')).toHaveText('두바이')
    await tab(page, '기타 근무지').click()
    await titles(page, ['Backend Engineer — UAE Country'])
    await tab(page, '원격 기회').click()
    await titles(page, ['Backend Engineer — UAE Remote'])
    await page.getByRole('button', { name: /^모든 필터/ }).click()
    await page.getByRole('checkbox', { name: /^거주 국가가 포함된 원격근무만/ }).uncheck()
    await page.getByRole('button', { name: '4개 공고 보기', exact: true }).click()
    await titles(page, ['Backend Engineer — Middle East Remote', 'Backend Engineer — UAE Remote'])
    await expect(page.locator('.remote-range-note')).toContainText('거주 국가 밖·지역 미확인 공고도 표시 중')
    await expect(page.locator('.map-stats strong')).toHaveText(['1곳', '1곳'])
    await page.getByRole('button', { name: 'Backend Engineer — Middle East Remote', exact: true }).click()
    await expect(page.getByRole('region', { name: '원격근무 지역', exact: true }).locator('p').first()).toHaveText('국가별 근무 지역 미확인')
    await expect(page.getByRole('dialog').locator('.job-detail-heading')).toContainText('Remote · Middle East')
    await regionalClose(page)
    await region(page, '아시아 · 태평양').click()
    await titles(page, [])
    await tab(page, '기타 근무지').click()
    await titles(page, ['Backend Engineer — NZ Country', 'Backend Engineer — Taiwan Country'])
    await expect(page.locator('.map-stats strong')).toHaveText(['1곳', '0곳'])
    await region(page, '전 세계').click()
    await titles(page, [
      'Backend Engineer — Conflicting Source', 'Backend Engineer — NZ Country', 'Backend Engineer — Taiwan Country',
      'Backend Engineer — UAE Country', 'Backend Engineer — Unconfirmed Source',
    ])
    await audit(page, info, `country-remote-boundaries-${width}`)
    await regional.expectPaths(initial.attempts)
  })

  test('current seven-region history and legacy six-region history display their own literal totals without a cross-method comparison', async ({ page, regional }, info) => {
    regional.history(regionalObservationHistory())
    const initial = await regional.open({ filters: { region: 'middle-east', query: 'Ledger' } })
    await dataButton(page).click()
    const panel = page.locator('details.observation-panel')
    await panel.locator('summary').focus()
    await panel.locator('summary').press('Enter')
    await expect(panel.locator('.observation-totals dd')).toHaveText(['7개', '7개', '7개', '0개'])
    await panel.getByRole('combobox', { name: '분포 항목', exact: true }).selectOption('regions')
    const table = panel.getByRole('table', { name: '근무 지역별 일반 공고', exact: true })
    await expect(table.locator('tbody tr')).toHaveCount(7)
    await observationRow(table, '중동', ['2', '28.6%'])
    await observationRow(table, '아시아 · 태평양', ['3', '42.9%'])
    await observationRow(table, '원격근무', ['1', '14.3%'])
    await expect(panel.locator('.observation-comparison')).toHaveText('같은 회사·게시판과 분류 기준으로 확인된 서로 다른 날짜의 기록이 2개 이상 쌓이면 변화를 비교해요.')
    await expect(panel).toContainText('분류 기준이 다른 이전 기록 1개 묶음은 현재 비교에서 제외했어요.')
    await panel.getByRole('region', { name: '공고 분포 표', exact: true }).focus()
    await table.scrollIntoViewIfNeeded()
    await expect(table).toBeInViewport({ ratio: 1 })
    await audit(page, info, `current-seven-regions-${width}`)
    regional.history(regionalObservationHistory(true))
    await panel.getByRole('button', { name: '관측 기록 다시 읽기', exact: true }).click()
    await expect(panel.getByRole('combobox', { name: '관측 날짜 (UTC)', exact: true })).toHaveValue('2026-09-26')
    await expect(table.locator('tbody tr')).toHaveCount(6)
    await expect(table.getByRole('rowheader', { name: '중동', exact: true })).toHaveCount(0)
    await observationRow(table, '아시아 · 태평양', ['3', '100.0%'])
    await expect(panel.locator('.observation-totals dd')).toHaveText(['3개', '3개', '3개', '0개'])
    await expect(panel.locator('.form-error')).toHaveCount(0)
    await expect(panel.locator('.observation-comparison strong')).toHaveCount(0)
    await panel.getByRole('region', { name: '공고 분포 표', exact: true }).focus()
    await table.scrollIntoViewIfNeeded()
    await expect(table).toBeInViewport({ ratio: 1 })
    await audit(page, info, `legacy-six-regions-${width}`)
    await regionalClose(page)
    await expect(search(page)).toHaveValue('Ledger')
    await expect(region(page, '중동')).toHaveAttribute('aria-pressed', 'true')
    await regional.expectPaths(initial.attempts, ['/api/observations', '/api/observations'])
  })
})
