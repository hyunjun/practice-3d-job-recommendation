import { expect, test } from '@playwright/test'
import type { Locator, Page, TestInfo } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { createJobRevision } from '../../shared/posting-status'
import type { PostingStatusIndex } from '../../shared/posting-status'
import type { Catalog, Filters, Job, SavedJob } from '../../shared/types'
import {
  JOB_POSTING_COMPANIES, JOB_POSTING_EOI_TITLE, JOB_POSTING_FILTERS,
  JOB_POSTING_FUTURE_PARAGRAPH, JOB_POSTING_FUTURE_TITLE, JOB_POSTING_NOTE,
  JOB_POSTING_NOW, JOB_POSTING_ORDINARY_PARAGRAPH, JOB_POSTING_ORDINARY_TITLE,
  JOB_POSTING_PROFILE, JOB_POSTING_PROSPECT_TITLE, JOB_POSTING_SAVED_AT, JOB_POSTING_TIME,
  legacyPostingJob, legacyPostingSaved, postingCatalog, postingDescription, postingScopeJobs,
} from '../fixtures/job-posting'
import { createJobPostingServer } from '../fixtures/job-posting-server'
import { expectInitialCatalogRequest, readServerMode, watchApiRequests } from './helpers/api-requests'
import { readSaved, waitForSavedCommit } from './helpers/saved-store'

const poolLabel = '인재풀·관심 등록'
const allLabel = '일반 공고·인재풀 모두'
const purposeNotice = '현재 채용 중인 특정 포지션이 아닌 인재풀·향후 기회 등록입니다. 모집 내용은 원문에서 확인해 주세요.'
const oldSourceTime = '2026-09-18T07:00:00.000Z'
const oldUpdatedTime = '2026-09-17T07:00:00.000Z'
const ordinaryNote = 'Keep the published ordinary snapshot; do not replace it with fresh metadata.'
const metadataQuote = 'Greenhouse Job Board API: internal_job_id is null (prospect post).'
const navigation = (page: Page) => page.getByRole('navigation', { name: '주요 메뉴' })
const filtersButton = (page: Page) => page.getByRole('button', { name: /^모든 필터/ })
const purposeScope = (page: Page) => page.getByRole('region', { name: '모집 유형 안내', exact: true })
const resultsTab = (page: Page, name: string) => page.locator('.results-tabs').getByRole('button', { name: new RegExp(`^${name}`) })
const stored = (page: Page) => page.evaluate(() => JSON.parse(localStorage.getItem('orbit.v1.exploration') || '{}'))

async function isolateBrowser(page: Page, origin: string) {
  await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.fallback() : route.abort('blockedbyclient'))
}

async function seed(page: Page, origin: string, saved: SavedJob[] = [], filters = JOB_POSTING_FILTERS) {
  await isolateBrowser(page, origin)
  await page.addInitScript(({ origin, profile, saved, filters }) => {
    if (location.origin !== origin || sessionStorage.getItem('posting-purpose-seeded')) return
    localStorage.setItem('orbit.v1.profile', JSON.stringify(profile))
    localStorage.setItem('orbit.v1.saved', JSON.stringify(saved))
    localStorage.setItem('orbit.v1.compare', JSON.stringify(['london', 'paris']))
    localStorage.setItem('orbit.v1.exploration', JSON.stringify({
      source: 'public', filters, selectedId: 'london', panelTab: 'cities',
      mapMode: 'flat', citySort: 'companies', light: false,
    }))
    sessionStorage.setItem('posting-purpose-seeded', 'true')
  }, { origin, profile: JOB_POSTING_PROFILE, saved, filters })
}

async function escapeTo(page: Page, opener: Locator) {
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(opener).toBeFocused()
}

async function choosePurpose(page: Page, value: Filters['postingType'], preview: number) {
  const opener = filtersButton(page)
  await opener.click()
  await page.getByLabel('모집 유형', { exact: true }).selectOption(value)
  await page.getByRole('button', { name: `${preview}개 공고 보기`, exact: true }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(opener).toBeFocused()
}

async function showPurposeEvidence(page: Page, source: 'board' | 'description', quote?: string) {
  const scope = purposeScope(page)
  await expect(scope.getByRole('heading', { name: poolLabel, exact: true })).toBeVisible()
  await expect(scope.locator('p')).toHaveText(purposeNotice)
  const disclosure = scope.locator('summary')
  await expect(disclosure).toHaveText('모집 유형 판단 근거')
  await disclosure.focus()
  await expect(disclosure).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(scope.locator('details')).toHaveJSProperty('open', true)
  await expect(scope.locator('li > span')).toHaveText(source === 'board' ? '공개 게시판의 관심 등록 표기' : '공고 본문')
  if (quote) await expect(scope.locator('blockquote')).toHaveText([quote])
  else {
    await expect(scope.locator('blockquote')).toHaveCount(1)
    await expect(scope.locator('blockquote')).toContainText('internal_job_id')
    await expect(scope.locator('blockquote')).toContainText('null')
  }
  await scope.locator('blockquote').scrollIntoViewIfNeeded()
  expect(await scope.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
}

async function audit(page: Page, info: TestInfo, screenshot?: string) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  for (const dialog of await page.getByRole('dialog').all()) {
    expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
  }
  expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze()).violations).toEqual([])
  if (screenshot) await page.screenshot({ path: info.outputPath(screenshot) })
}

function browserFailures(page: Page) {
  const errors: string[] = []
  const resources: { status: number; url: string }[] = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('response', response => {
    if (response.status() >= 400) resources.push({ status: response.status(), url: response.url() })
  })
  return { errors, resources }
}

function expectPrivateTraffic(traffic: ReturnType<typeof watchApiRequests>, origin: string) {
  for (const request of traffic.requests) {
    const url = new URL(request.url)
    expect(url.origin).toBe(origin)
    expect(request.method).toBe('GET')
    expect(request.body).toBeNull()
    expect(['/api/catalog', '/api/catalog/progress', '/api/posting-status']).toContain(url.pathname)
    expect(url.search).not.toContain('Synthetic')
    expect(url.search).not.toContain('TypeScript')
    expect(url.search).not.toContain('Backend')
  }
}

async function actualCatalog(page: Page, origin: string): Promise<Catalog> {
  const response = await page.request.get(`${origin}/api/catalog?source=public`)
  try {
    expect(response.status()).toBe(200)
    return await response.json()
  } finally { await response.dispose() }
}

function originalSaved(): SavedJob[] {
  return [
    legacyPostingSaved(legacyPostingJob('saved-future', {
      companyId: 'posting-birch', source: 'ashby', title: JOB_POSTING_FUTURE_TITLE,
      fetchedAt: oldSourceTime, updatedAt: oldUpdatedTime,
    })),
    {
      ...legacyPostingSaved(legacyPostingJob('saved-prospect', {
        title: JOB_POSTING_PROSPECT_TITLE, description: postingDescription(JOB_POSTING_ORDINARY_PARAGRAPH),
        fetchedAt: oldSourceTime, updatedAt: oldUpdatedTime,
      })),
      note: ordinaryNote, status: 'saved',
    },
  ]
}

function expectPreservedRecords(records: SavedJob[]) {
  expect(records).toHaveLength(2)
  expect(records.map(record => record.job.id).sort()).toEqual([
    'ashby-posting-birch-saved-future', 'greenhouse-posting-alder-saved-prospect',
  ])
  const future = records.find(record => record.job.id === 'ashby-posting-birch-saved-future')!
  const ordinary = records.find(record => record.job.id === 'greenhouse-posting-alder-saved-prospect')!
  expect(future).toMatchObject({
    savedAt: JOB_POSTING_SAVED_AT, note: JOB_POSTING_NOTE, status: 'applied',
    company: { id: 'posting-birch', provider: 'ashby', board: 'BirchPurpose43' },
    job: {
      title: JOB_POSTING_FUTURE_TITLE, url: 'https://example.com/jobs/posting/saved-future',
      fetchedAt: oldSourceTime, updatedAt: oldUpdatedTime,
      postingPurpose: {
        version: 1, kind: 'talent-pool', basis: 'description',
        evidence: [{ source: 'description', text: JOB_POSTING_FUTURE_PARAGRAPH }],
      },
    },
  })
  expect(ordinary).toMatchObject({
    savedAt: JOB_POSTING_SAVED_AT, note: ordinaryNote, status: 'saved',
    company: { id: 'posting-alder', provider: 'greenhouse', board: 'AlderPurpose43' },
    job: {
      title: JOB_POSTING_PROSPECT_TITLE, url: 'https://example.com/jobs/posting/saved-prospect',
      fetchedAt: oldSourceTime, updatedAt: oldUpdatedTime,
      description: postingDescription(JOB_POSTING_ORDINARY_PARAGRAPH),
    },
  })
  expect(ordinary.job).not.toHaveProperty('postingPurpose')
}

// Only encodes the synthetic posting-status response. The expected changed
// fields, publication states, preserved records and counts remain literal.
async function postingIndex(jobs: Job[]): Promise<PostingStatusIndex> {
  return {
    version: 1, checkedAt: JOB_POSTING_NOW, refreshAfter: '2026-09-20T07:13:00.000Z',
    boards: await Promise.all(JOB_POSTING_COMPANIES.map(async company => {
      const records = jobs.filter(job => job.companyId === company.id)
      return {
        companyId: company.id, provider: company.provider!, board: company.board!,
        ...(company.boardRegion ? { boardRegion: company.boardRegion } : {}),
        status: 'ok', checkedAt: JOB_POSTING_NOW, lastSuccessAt: JOB_POSTING_TIME, retryAt: null,
        listing: {
          validUntil: '2026-09-20T07:30:00.000Z', publishedIds: records.map(job => job.id),
          jobs: await Promise.all(records.map(async job => ({
            id: job.id, title: job.title, url: job.url, revision: await createJobRevision(job),
          }))),
        },
      }
    })),
  }
}

function csvRecords(text: string) {
  const cells = (value: string) => [...value.matchAll(/"((?:[^"]|"")*)"(?:,|\r\n|$)/g)].map(match => match[1].replaceAll('""', '"'))
  const headerEnd = text.indexOf('\r\n')
  const headers = cells(text.slice(0, headerEnd))
  expect(headers.slice(-6)).toEqual(['원격근무 지역 판단', '원격근무 지역 원문 근거', '모집 유형', '모집 유형 근거', '언어 조건', '언어 조건 근거'])
  const values = cells(text.slice(headerEnd + 2))
  expect(values).toHaveLength(headers.length * 2)
  return [0, 1].map(row => Object.fromEntries(headers.map((header, index) => [header, values[row * headers.length + index]])))
}

for (const width of [1440, 320]) test.describe(`posting purpose across real collection and saved context at ${width}px`, () => {
  test.use({ viewport: { width, height: 960 }, isMobile: width === 320, hasTouch: width === 320 })

  test('a real four-provider collector separates two openings from two registrations through drafts, cache restart and saved identity', async ({ page, request, baseURL }, info) => {
    const mode = await readServerMode(request, `${baseURL}/api/health`)
    const server = await createJobPostingServer(info.outputPath('posting-server'), mode)
    const failures = browserFailures(page)
    const traffic = watchApiRequests(page)
    try {
      await server.start()
      await server.verifyProductionBytes()
      await seed(page, server.origin)
      await page.goto(server.origin)
      await expectInitialCatalogRequest(page, traffic)
      await expect(page.locator('.city-detail-count strong')).toHaveText(['2', '2'])
      await expect(page.locator('.mini-job-title')).toHaveText([JOB_POSTING_ORDINARY_TITLE, JOB_POSTING_EOI_TITLE])
      await expect(page.locator('.map-stats strong')).toHaveText(['2곳', '1곳'])
      await expect(page.locator('.posting-purpose-badge')).toHaveCount(0)
      const activeEOI = page.getByRole('button', { name: JOB_POSTING_EOI_TITLE, exact: true })
      await activeEOI.click()
      await expect(purposeScope(page)).toHaveCount(0)
      await escapeTo(page, activeEOI)

      const dataButton = page.getByRole('button', { name: '데이터와 추천 방식', exact: true })
      await dataButton.click()
      await expect(page.getByRole('dialog').locator('.coverage-stats > div').filter({
        has: page.getByText('조회된 개발 공고', { exact: true }),
      }).locator('strong')).toHaveText('4')
      await expect(page.locator('.posting-purpose-count')).toHaveText('조회된 개발 공고에 인재풀·관심 등록 2개가 포함되어 있어요. 기본 추천에서는 제외하며 모집 유형 필터로 따로 볼 수 있어요.')
      await expect(page.locator('.provider-coverage li strong')).toHaveText(['Greenhouse', 'Ashby', 'Lever', 'SmartRecruiters'])
      await escapeTo(page, dataButton)

      const filterButton = filtersButton(page)
      await filterButton.click()
      const purpose = page.getByLabel('모집 유형', { exact: true })
      await expect(purpose).toHaveValue('opening')
      await expect(purpose.locator('option')).toHaveText(['일반 채용 공고', poolLabel, allLabel])
      await purpose.selectOption('talent-pool')
      await expect(page.getByRole('button', { name: '2개 공고 보기', exact: true })).toBeVisible()
      await purpose.selectOption('all')
      await expect(page.getByRole('button', { name: '4개 공고 보기', exact: true })).toBeVisible()
      await escapeTo(page, filterButton)
      await expect(page.locator('.mini-job-title')).toHaveText([JOB_POSTING_ORDINARY_TITLE, JOB_POSTING_EOI_TITLE])
      expect((await stored(page)).filters.postingType).toBe('opening')

      await choosePurpose(page, 'talent-pool', 2)
      await expect(page.locator('.city-detail-count strong')).toHaveText(['2', '2'])
      await expect(page.locator('.mini-job-title')).toHaveText([JOB_POSTING_PROSPECT_TITLE, JOB_POSTING_FUTURE_TITLE])
      await expect(page.locator('.posting-purpose-badge')).toHaveText([poolLabel, poolLabel])
      await expect(page.locator('.active-filter-summary')).toContainText(poolLabel)
      const prospect = page.getByRole('button', { name: JOB_POSTING_PROSPECT_TITLE, exact: true })
      await prospect.click()
      await showPurposeEvidence(page, 'board')
      await page.getByRole('button', { name: '기회 저장', exact: true }).click()
      await page.getByLabel('이 기회에 대한 나의 메모', { exact: true }).fill(JOB_POSTING_NOTE)
      await page.getByRole('button', { name: '지원 완료로 표시', exact: true }).click()
      await escapeTo(page, prospect)
      const saved = await readSaved(page)
      expect(saved).toHaveLength(1)
      expect(saved[0]).toMatchObject({
        note: JOB_POSTING_NOTE, status: 'applied',
        company: { id: 'posting-alder', provider: 'greenhouse', board: 'AlderPurpose43' },
        job: { id: 'greenhouse-posting-alder-4301', postingPurpose: { basis: 'greenhouse-prospect' } },
      })

      const future = page.getByRole('button', { name: JOB_POSTING_FUTURE_TITLE, exact: true })
      await future.click()
      await showPurposeEvidence(page, 'description', JOB_POSTING_FUTURE_PARAGRAPH)
      await audit(page, info, width === 320 ? 'posting-purpose-description-320.png' : undefined)
      await escapeTo(page, future)
      await choosePurpose(page, 'all', 4)
      await expect(page.locator('.city-detail-count strong')).toHaveText(['4', '4'])
      await expect(page.locator('.active-filter-summary')).toContainText(allLabel)
      const before = await actualCatalog(page, server.origin)
      expect(before.jobs.map(job => job.id)).toEqual([
        'greenhouse-posting-alder-4301', 'ashby-posting-birch-4302',
        'lever-posting-cedar-4303', 'smartrecruiters-posting-dogwood-4304',
      ])
      expect(before.jobs.map(job => job.postingPurpose?.basis ?? null)).toEqual(['greenhouse-prospect', 'description', null, null])
      const cacheFiles = await server.cacheFiles()
      expect(cacheFiles).toHaveLength(1)

      await page.goto('about:blank')
      await server.stop()
      await server.start()
      await server.verifyProductionBytes()
      await page.goto(server.origin)
      await expect(page.locator('.city-detail-count strong')).toHaveText(['4', '4'])
      await expect(page.locator('.active-filter-summary')).toContainText(allLabel)
      expect((await stored(page)).filters.postingType).toBe('all')
      const after = await actualCatalog(page, server.origin)
      expect(after.jobs).toEqual(before.jobs)
      expect(await server.cacheFiles()).toEqual(cacheFiles)
      const cache = JSON.parse(await readFile(path.join(server.cwd, '.local', cacheFiles[0]), 'utf8')) as {
        boards: { snapshot: { jobs: Job[]; publishedIds: string[] } }[]
      }
      expect(cache.boards.flatMap(board => board.snapshot.publishedIds).sort()).toEqual([
        'ashby-posting-birch-4302', 'greenhouse-posting-alder-4301',
        'lever-posting-cedar-4303', 'smartrecruiters-posting-dogwood-4304',
      ])
      expect(cache.boards.flatMap(board => board.snapshot.jobs).filter(job => job.postingPurpose)).toHaveLength(2)
      const upstream = await server.requests()
      expect(upstream).toHaveLength(5)
      expect(upstream.every(item => item.synthetic && !item.networkSent && item.method === 'GET')).toBe(true)
      expect(await readFile(server.defaultCache, 'utf8')).toBe(server.defaultBytes)
      await navigation(page).getByRole('button', { name: /^저장한 기회/ }).click()
      await expect(page.locator('.saved-card')).toHaveCount(1)
      await expect(page.locator('.saved-card .posting-purpose-badge')).toHaveText(poolLabel)
      await expect(page.locator('.saved-status')).toHaveText('지원 완료')
      expect(await readSaved(page)).toEqual(saved)
      expectPrivateTraffic(traffic, server.origin)
      expect(failures).toEqual({ errors: [], resources: [] })
      await writeFile(info.outputPath('real-collection-cache-saved.json'), JSON.stringify({ before, after, saved, upstream }, null, 2))
    } finally {
      await page.close()
      await server.stop()
    }
  })

  test('old saved bodies enrich once, distinguish a real metadata change and preserve expired source records through CSV and fresh JSON restore', async ({ page, browser, baseURL }, info) => {
    const origin = new URL(baseURL!).origin
    const originals = originalSaved()
    const current: Job[] = originals.map(record => ({ ...record.job, fetchedAt: JOB_POSTING_TIME }))
    current[1] = {
      ...current[1], postingPurpose: {
        version: 1, kind: 'talent-pool', basis: 'greenhouse-prospect',
        evidence: [{ source: 'board', text: metadataQuote }],
      },
    }
    const catalog = postingCatalog(current)
    const status = await postingIndex(current)
    const failures = browserFailures(page)
    const traffic = watchApiRequests(page)
    await page.clock.setFixedTime(new Date(JOB_POSTING_NOW))
    await seed(page, origin, originals)
    await page.route('**/api/**', route => route.abort('blockedbyclient'))
    await page.route('**/api/catalog?source=public*', route => route.fulfill({ json: catalog }))
    await page.route('**/api/posting-status*', route => route.fulfill({ json: status }))
    await page.goto(`${origin}/#saved`)
    await expectInitialCatalogRequest(page, traffic)
    await expect(page.locator('.saved-card')).toHaveCount(2)
    const futureCard = page.locator('.saved-card').filter({ has: page.getByRole('button', { name: JOB_POSTING_FUTURE_TITLE, exact: true }) })
    const ordinaryCard = page.locator('.saved-card').filter({ has: page.getByRole('button', { name: JOB_POSTING_PROSPECT_TITLE, exact: true }) })
    await expect(futureCard.locator('.posting-purpose-badge')).toHaveText(poolLabel)
    await expect(ordinaryCard.locator('.posting-purpose-badge')).toHaveCount(0)
    await expect(page.locator('.stale-job-badge')).toHaveText(['확인 기간 지남', '확인 기간 지남'])
    const records = await readSaved(page)
    expectPreservedRecords(records)
    expect(originals.every(record => !record.job.postingPurpose)).toBe(true)

    await page.getByRole('button', { name: '게시 상태 확인', exact: true }).click()
    await expect(page.locator('.posting-summary strong')).toHaveText(['2', '1', '0', '0'])
    await expect(futureCard.locator('.posting-notice.listed')).toHaveCount(1)
    await expect(futureCard.locator('.posting-notice.changed')).toHaveCount(0)
    await expect(ordinaryCard.locator('.posting-changes')).toHaveText('모집·근무·고용·비자 확인 필요')
    await expect(page.locator('.posting-notice.missing')).toHaveCount(0)
    const future = page.getByRole('button', { name: JOB_POSTING_FUTURE_TITLE, exact: true })
    await future.click()
    await showPurposeEvidence(page, 'description', JOB_POSTING_FUTURE_PARAGRAPH)
    await expect(page.getByRole('dialog').locator('.job-freshness-notice time')).toHaveAttribute('dateTime', oldSourceTime)
    await expect(page.getByRole('dialog').locator('.job-freshness-notice strong')).toHaveText('추천에서 제외된 조회 기록이에요')
    await expect(page.getByLabel('이 기회에 대한 나의 메모', { exact: true })).toHaveValue(JOB_POSTING_NOTE)
    await expect(page.getByRole('button', { name: '지원 완료로 표시됨', exact: true })).toBeVisible()
    await purposeScope(page).locator('blockquote').scrollIntoViewIfNeeded()
    await audit(page, info, width === 320 ? 'saved-registration-source-320.png' : undefined)
    await escapeTo(page, future)

    const csvDownload = page.waitForEvent('download')
    await page.getByRole('button', { name: 'CSV 내보내기', exact: true }).click()
    const csvText = await readFile((await (await csvDownload).path())!, 'utf8')
    const csv = csvRecords(csvText)
    expect(csv.find(record => record['회사'] === 'Birch Engine')).toMatchObject({
      '포지션': JOB_POSTING_FUTURE_TITLE, '모집 유형': poolLabel,
      '모집 유형 근거': `공고 본문\n${JOB_POSTING_FUTURE_PARAGRAPH}`,
      '저장일': JOB_POSTING_SAVED_AT, '저장 내용의 조회 시각': oldSourceTime,
      '상태': '지원 완료', '메모': JOB_POSTING_NOTE, '공개 게시 상태': '게시 확인',
      '내용 비교': '표시 내용 일치', '저장 내용과 다른 항목': '',
    })
    expect(csv.find(record => record['회사'] === 'Alder Workshop')).toMatchObject({
      '포지션': JOB_POSTING_PROSPECT_TITLE, '모집 유형': '일반 채용 공고', '모집 유형 근거': '',
      '저장일': JOB_POSTING_SAVED_AT, '저장 내용의 조회 시각': oldSourceTime,
      '상태': '저장됨', '메모': ordinaryNote, '공개 게시 상태': '게시 확인',
      '내용 비교': '차이 있음', '저장 내용과 다른 항목': '모집·근무·고용·비자',
    })
    await page.getByRole('button', { name: '기록 백업·복원', exact: true }).click()
    const jsonDownload = page.waitForEvent('download')
    await page.getByRole('button', { name: 'JSON 백업', exact: true }).click()
    const backupText = await readFile((await (await jsonDownload).path())!, 'utf8')
    const backup = JSON.parse(backupText) as { records: SavedJob[] }
    expectPreservedRecords(backup.records)
    expect(backup.records).toEqual(records)
    expect(backupText).not.toContain('Synthetic purpose profile')
    await page.getByRole('button', { name: '완료', exact: true }).click()
    await page.reload()
    await expect(page.locator('.saved-card')).toHaveCount(2)
    expect(await readSaved(page)).toEqual(records)
    expectPrivateTraffic(traffic, origin)
    expect(failures).toEqual({ errors: [], resources: [] })
    await writeFile(info.outputPath('saved-registration.csv'), csvText)
    await writeFile(info.outputPath('saved-registration-backup.json'), backupText)

    const destination = await browser.newContext({ viewport: { width, height: 960 }, isMobile: width === 320, hasTouch: width === 320 })
    try {
      const target = await destination.newPage()
      const restoredFailures = browserFailures(target)
      const restoredTraffic = watchApiRequests(target)
      await target.clock.setFixedTime(new Date(JOB_POSTING_NOW))
      await isolateBrowser(target, origin)
      await target.route('**/api/**', route => route.abort('blockedbyclient'))
      await target.route('**/api/catalog?source=public*', route => route.fulfill({ json: catalog }))
      await target.goto(`${origin}/#saved`)
      await waitForSavedCommit(target)
      await target.getByRole('button', { name: '기록 백업·복원', exact: true }).click()
      await target.getByLabel('백업 또는 복구 파일', { exact: true }).setInputFiles({
        name: 'synthetic-posting-purpose.json', mimeType: 'application/json', buffer: Buffer.from(backupText),
      })
      await expect(target.locator('.saved-import-row')).toHaveCount(2)
      expect(await readSaved(target)).toEqual([])
      await target.getByRole('button', { name: '선택한 2개 가져오기', exact: true }).click()
      await expect(target.locator('.saved-file-message')).toContainText('선택한 2개 기록을 저장했어요.')
      expectPreservedRecords(await readSaved(target))
      await target.getByRole('button', { name: '완료', exact: true }).click()
      await target.getByRole('button', { name: JOB_POSTING_FUTURE_TITLE, exact: true }).click()
      await showPurposeEvidence(target, 'description', JOB_POSTING_FUTURE_PARAGRAPH)
      await expect(target.getByLabel('이 기회에 대한 나의 메모', { exact: true })).toHaveValue(JOB_POSTING_NOTE)
      await expect(target.getByRole('button', { name: '지원 완료로 표시됨', exact: true })).toBeVisible()
      await target.keyboard.press('Escape')
      await target.reload()
      await expect(target.locator('.saved-card')).toHaveCount(2)
      expectPreservedRecords(await readSaved(target))
      expect(await target.evaluate(() => localStorage.getItem('orbit.v1.profile'))).toBeNull()
      expectPrivateTraffic(restoredTraffic, origin)
      expect(restoredFailures).toEqual({ errors: [], resources: [] })
    } finally { await destination.close() }
  })

  test('an empty selected city offers explicit pool recovery while comparison, remote and unmapped results keep their own literal counts', async ({ page, baseURL }, info) => {
    const origin = new URL(baseURL!).origin
    const jobs = postingScopeJobs()
    // A hybrid current opening is filtered out by onsite; the London
    // registration and an opening in Paris remain independently identifiable.
    jobs[0] = { ...jobs[0], workMode: 'hybrid' }
    const filters = { ...JOB_POSTING_FILTERS, query: 'Backend Engineer' }
    const failures = browserFailures(page)
    const traffic = watchApiRequests(page)
    await page.clock.setFixedTime(new Date(JOB_POSTING_NOW))
    await seed(page, origin, [], filters)
    await page.route('**/api/**', route => route.abort('blockedbyclient'))
    await page.route('**/api/catalog?source=public*', route => route.fulfill({ json: postingCatalog(jobs) }))
    await page.goto(origin)
    await expectInitialCatalogRequest(page, traffic)
    await expect(page.locator('.city-detail-count strong')).toHaveText(['1', '1'])
    await expect(page.locator('.mini-job-title')).toHaveText(['Backend Engineer Alder Opening'])
    await expect(page.locator('.map-stats strong')).toHaveText(['3곳', '2곳'])

    await page.getByLabel('근무 형태 필터', { exact: true }).selectOption('onsite')
    await expect(page.locator('.city-detail-count strong')).toHaveText(['0', '0'])
    await expect(page.locator('.map-stats strong')).toHaveText(['2곳', '1곳'])
    await expect(page.getByRole('heading', { name: '이 도시에서 맞는 공고를 찾지 못했어요', exact: true })).toBeVisible()
    const recovery = page.locator('.recovery-option').filter({ has: page.getByText('모집 유형', { exact: true }) })
    await expect(recovery).toHaveCount(1)
    await expect(recovery.locator('dt')).toHaveText('모집 유형')
    await expect(recovery.locator('dd')).toHaveText(`일반 채용 공고→${allLabel}`)
    await expect(recovery.locator('.recovery-warning')).toHaveText('인재풀·향후 기회 등록도 포함합니다. 현재 채용 중인 특정 포지션이 없을 수 있어요.')
    await expect(page.locator('.recovery-alternatives button').filter({ hasText: '다른 도시 보기' })).toContainText('회사 1곳 · 공고 1개 · 1개 도시')
    expect((await stored(page)).filters).toEqual({ ...filters, workMode: 'onsite' })
    const applyRecovery = recovery.getByRole('button', { name: '회사 1곳 · 공고 1개 보기', exact: true })
    await applyRecovery.focus()
    await page.keyboard.press('Enter')
    await expect(page.locator('.results-panel')).toBeFocused()
    await expect(page.locator('.city-detail-count strong')).toHaveText(['1', '1'])
    await expect(page.locator('.mini-job-title')).toHaveText(['Backend Engineer Alder Future Opportunities'])
    await expect(page.locator('.active-filter-summary')).toContainText(allLabel)
    await expect.poll(() => stored(page)).toMatchObject({
      selectedId: 'london', panelTab: 'cities', filters: { ...filters, workMode: 'onsite', postingType: 'all' },
    })
    await page.getByRole('button', { name: '실행 취소', exact: true }).click()
    await expect(page.locator('.city-detail-count strong')).toHaveText(['0', '0'])
    await expect(recovery).toHaveCount(1)
    expect((await stored(page)).filters).toEqual({ ...filters, workMode: 'onsite' })

    await page.getByLabel('근무 형태 필터', { exact: true }).selectOption('all')
    await choosePurpose(page, 'all', 8)
    await expect(page.locator('.city-detail-count strong')).toHaveText(['1', '2'])
    await expect(page.locator('.map-stats strong')).toHaveText(['4곳', '2곳'])
    await page.getByRole('button', { name: '전체 2개 공고 보기', exact: true }).click()
    await expect(page.locator('.mini-job-title')).toHaveText(['Backend Engineer Alder Opening', 'Backend Engineer Alder Future Opportunities'])
    await expect(page.locator('.company-card')).toHaveCount(1)
    await expect(page.locator('.posting-purpose-badge')).toHaveText(poolLabel)
    await navigation(page).getByRole('button', { name: /^도시 비교/ }).click()
    const metric = (name: string) => page.getByRole('row').filter({
      has: page.getByRole('rowheader', { name: new RegExp(`^${name}`) }),
    }).getByRole('cell')
    await expect(page.locator('.comparison-city h2')).toHaveText(['런던', '파리'])
    await expect(metric('추천 회사')).toHaveText(['1곳', '2곳', '—'])
    await expect(metric('관련 채용공고')).toHaveText(['2개', '2개', '—'])
    await expect(page.locator('.comparison-source-note')).toContainText(`모집 유형: ${allLabel}`)
    await audit(page, info, width === 320 ? 'purpose-scoped-comparison-320.png' : undefined)

    await navigation(page).getByRole('button', { name: '기회 탐색', exact: true }).click()
    await resultsTab(page, '원격 기회').click()
    await expect(page.locator('.list-toolbar')).toContainText('2개 회사 · 2개 공고')
    await expect(page.locator('.mini-job-title')).toHaveText(['Backend Engineer Alder Remote Future Opportunities', 'Backend Engineer Cedar Remote Opening'])
    await choosePurpose(page, 'talent-pool', 4)
    await expect(resultsTab(page, '원격 기회')).toHaveAttribute('aria-pressed', 'true')
    await expect(page.locator('.list-toolbar')).toContainText('1개 회사 · 1개 공고')
    await expect(page.locator('.mini-job-title')).toHaveText(['Backend Engineer Alder Remote Future Opportunities'])
    await expect(page.locator('.residence-button')).toHaveText('영국 거주 기준')
    await resultsTab(page, '기타 근무지').click()
    await expect(page.locator('.mini-job-title')).toHaveText(['Backend Engineer Birch Future Opportunities'])
    await expect(page.locator('.list-toolbar')).toContainText('1개 회사 · 1개 공고')
    await choosePurpose(page, 'all', 8)
    await expect(page.locator('.list-toolbar')).toContainText('2개 회사 · 2개 공고')
    await expect(page.locator('.mini-job-title')).toHaveText(['Backend Engineer Birch Future Opportunities', 'Backend Engineer Cedar Station Opening'])
    const opener = filtersButton(page)
    await opener.click()
    await page.getByRole('button', { name: '조건 초기화', exact: true }).click()
    await expect(page.getByLabel('모집 유형', { exact: true })).toHaveValue('opening')
    await page.getByRole('button', { name: '4개 공고 보기', exact: true }).click()
    await expect(opener).toBeFocused()
    await expect(page.locator('.list-toolbar')).toContainText('1개 회사 · 1개 공고')
    await expect(page.locator('.mini-job-title')).toHaveText(['Backend Engineer Cedar Station Opening'])
    await expect(page.locator('.posting-purpose-badge')).toHaveCount(0)
    await page.reload()
    await expect(resultsTab(page, '기타 근무지')).toHaveAttribute('aria-pressed', 'true')
    await expect(page.locator('.mini-job-title')).toHaveText(['Backend Engineer Cedar Station Opening'])
    await expect(page.getByLabel('도시, 회사 또는 포지션 검색', { exact: true })).toHaveValue('Backend Engineer')
    expect((await stored(page)).filters.postingType).toBe('opening')
    expectPrivateTraffic(traffic, origin)
    expect(failures).toEqual({ errors: [], resources: [] })
  })
})
