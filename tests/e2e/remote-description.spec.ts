import { expect, test } from '@playwright/test'
import type { Locator, Page, TestInfo } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { readFile } from 'node:fs/promises'
import type { CatalogCollectionSnapshot, CatalogCollectionUpdate } from '../../shared/catalog-progress'
import { createJobRevision } from '../../shared/posting-status'
import type { PostingStatusIndex } from '../../shared/posting-status'
import type { Job, SavedJob } from '../../shared/types'
import {
  legacyRemoteDescriptionJob, legacyRemoteDescriptionSaved, remoteDescriptionCatalog,
  REMOTE_CONFLICT_PARAGRAPH, REMOTE_DESCRIPTION_FILTERS, REMOTE_DESCRIPTION_NOTE,
  REMOTE_DESCRIPTION_NOW, REMOTE_DESCRIPTION_PROFILE, REMOTE_DESCRIPTION_SAVED_AT,
  REMOTE_DESCRIPTION_TIME, REMOTE_DESCRIPTION_UPDATED_AT, REMOTE_UK_PARAGRAPH,
  REMOTE_US_PARAGRAPH, remoteDescriptionText,
} from '../fixtures/remote-description'
import { expectInitialCatalogRequest, watchApiRequests } from './helpers/api-requests'
import { readSaved, waitForSavedCommit } from './helpers/saved-store'

const derivedNotice = '이 공고의 본문에 명시된 국가를 반영했어요.'
const unconfirmedNotice = '게시 위치와 본문 조건을 하나의 국가 목록으로 확정하지 못했어요. 거주 국가에 포함된 공고로 분류하지 않아요.'
const countryCaution = '지역에 포함되어도 취업 허가·국적·주별 제한·협업 시간대는 별도로 확인해야 해요.'
const collectionId = '00000000-0000-4000-8000-000000000041'
const close = (page: Page) => page.getByRole('button', { name: '닫기', exact: true }).click()
const navigation = (page: Page) => page.getByRole('navigation', { name: '주요 메뉴' })
const scope = (page: Page) => page.getByRole('region', { name: '원격근무 지역', exact: true })

async function restore(page: Page, saved: SavedJob[] = [], hash = '') {
  await page.clock.setFixedTime(new Date(REMOTE_DESCRIPTION_NOW))
  await page.addInitScript(({ profile, filters, saved }) => {
    if (sessionStorage.getItem('remote-description-seeded')) return
    localStorage.setItem('orbit.v1.profile', JSON.stringify(profile))
    localStorage.setItem('orbit.v1.saved', JSON.stringify(saved))
    localStorage.setItem('orbit.v1.exploration', JSON.stringify({
      source: 'public', mapMode: 'flat', selectedId: null, panelTab: 'remote', filters,
    }))
    sessionStorage.setItem('remote-description-seeded', 'true')
  }, { profile: REMOTE_DESCRIPTION_PROFILE, filters: REMOTE_DESCRIPTION_FILTERS, saved })
  await page.goto(`/${hash}`)
  await waitForSavedCommit(page)
}

async function chooseResidence(page: Page, country: string) {
  const opener = page.getByRole('button', { name: '내 프로필 편집', exact: true })
  await opener.click()
  await page.getByLabel('원격근무 시 거주 국가·지역', { exact: true }).selectOption(country)
  await page.getByRole('button', { name: '변경 사항 적용', exact: true }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(opener).toBeFocused()
  await expect(page.locator('.results-tabs').getByRole('button', { name: /^원격 기회/ })).toHaveAttribute('aria-pressed', 'true')
}

async function expectScopeLabel(page: Page, label: string, notice?: string) {
  await expect(scope(page)).toBeVisible()
  await expect(scope(page).getByText('명시된 원격근무 지역', { exact: true })).toBeVisible()
  await expect(scope(page).locator('p').first()).toHaveText(label)
  await expect(scope(page).locator('small').first()).toHaveText(countryCaution)
  if (notice) await expect(scope(page).locator('.remote-scope-note')).toHaveText(notice)
}

async function expandEvidence(page: Page, paragraph: string) {
  const disclosure = scope(page).locator('summary')
  await expect(disclosure).toHaveText('원격근무 지역을 판단한 원문')
  await disclosure.focus()
  await expect(disclosure).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(scope(page).locator('details')).toHaveJSProperty('open', true)
  await expect(scope(page).locator('blockquote')).toHaveText([paragraph])
}

async function auditDialog(page: Page, info: TestInfo, screenshot?: string) {
  expect(await page.locator('.dialog').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
  expect(await scope(page).evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze()).violations).toEqual([])
  if (screenshot) await page.screenshot({ path: info.outputPath(screenshot) })
}

function expectPrivateTraffic(page: Page, traffic: ReturnType<typeof watchApiRequests>) {
  for (const request of traffic.requests) {
    const url = new URL(request.url)
    expect(url.origin).toBe(new URL(page.url()).origin)
    expect(request.method).toBe('GET')
    expect(request.body).toBeNull()
    expect([
      '/api/catalog?source=public',
      '/api/posting-status?refresh=1',
      `/api/catalog/progress?id=${collectionId}&after=1`,
    ]).toContain(`${url.pathname}${url.search}`)
  }
}

function expectOriginalSaved(records: SavedJob[]) {
  expect(records).toHaveLength(1)
  expect(records[0]).toMatchObject({
    company: { id: 'remote-description-a', name: 'Cedar Systems' },
    savedAt: REMOTE_DESCRIPTION_SAVED_AT, note: REMOTE_DESCRIPTION_NOTE, status: 'applied',
    job: {
      id: 'greenhouse-remote-description-a-4101', title: 'Backend Engineer Cedar',
      url: 'https://example.com/jobs/remote-description/4101', locationLabel: 'Remote',
      cityIds: [], remoteCountries: ['GB'], remoteWorldwide: false, remoteScopeUnknown: false,
      remoteScopeVersion: 2, fetchedAt: REMOTE_DESCRIPTION_TIME, updatedAt: REMOTE_DESCRIPTION_UPDATED_AT,
      description: remoteDescriptionText(REMOTE_UK_PARAGRAPH),
      remoteScopeResolution: { version: 1, status: 'description', listedCountries: [], listedWorldwide: false },
    },
  })
  expect(records[0].job.remoteScopeResolution?.evidence).toEqual([{ source: 'description', text: REMOTE_UK_PARAGRAPH }])
}

// This creates the mock endpoint payload, not expected countries/counts/UI labels.
// Unit tests separately assert literal scope values and changed revision sections.
async function postingIndex(jobs: Job[]): Promise<PostingStatusIndex> {
  const catalog = remoteDescriptionCatalog(jobs)
  return {
    version: 1, checkedAt: REMOTE_DESCRIPTION_NOW, refreshAfter: '2026-09-19T08:13:00.000Z',
    boards: await Promise.all(catalog.companies.map(async company => {
      const records = jobs.filter(job => job.companyId === company.id)
      const lastSuccessAt = records[0]?.fetchedAt ?? REMOTE_DESCRIPTION_TIME
      return {
        companyId: company.id, provider: 'greenhouse', board: company.board!, status: 'ok',
        checkedAt: REMOTE_DESCRIPTION_NOW, lastSuccessAt, retryAt: null,
        listing: {
          validUntil: new Date(Date.parse(lastSuccessAt) + 30 * 60_000).toISOString(),
          publishedIds: records.map(job => job.id),
          jobs: await Promise.all(records.map(async job => ({
            id: job.id, title: job.title, url: job.url, revision: await createJobRevision(job),
          }))),
        },
      }
    })),
  }
}

function singleCsvRecord(text: string) {
  const cells = (value: string) => [...value.matchAll(/"((?:[^"]|"")*)"(?:,|\r\n|$)/g)]
    .map(match => match[1].replaceAll('""', '"'))
  const headers = cells(text.slice(0, text.indexOf('\r\n')))
  const values = cells(text).slice(headers.length)
  expect(headers.slice(-10)).toEqual(['원격근무 지역 판단', '원격근무 지역 원문 근거', '모집 유형', '모집 유형 근거', '언어 조건', '언어 조건 근거', '시간대·협업 시간', '시간대·협업 시간 근거', '근무 국가', '근무 국가 근거'])
  expect(values).toHaveLength(headers.length)
  return Object.fromEntries(headers.map((header, index) => [header, values[index]]))
}

async function escapeTo(page: Page, opener: Locator) {
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(opener).toBeFocused()
}

for (const width of [1440, 320]) test.describe(`body-derived remote country context at ${width}px`, () => {
  test.use({ viewport: { width, height: 960 }, isMobile: width === 320, hasTouch: width === 320 })
  test.beforeEach(async ({ page }) => {
    // Specific synthetic responses registered by each case take precedence.
    await page.route('**/api/**', route => route.abort('blockedbyclient'))
  })

  test('country discovery preserves state restrictions, other-posting context and explicit uncertainty', async ({ page }, info) => {
    const traffic = watchApiRequests(page)
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await page.route('**/api/catalog?source=public*', route => route.fulfill({ json: remoteDescriptionCatalog() }))
    await restore(page)
    const initial = await expectInitialCatalogRequest(page, traffic)
    await expect(page.locator('.mini-job-title')).toHaveText(['Backend Engineer Cedar'])
    await expect(page.locator('.list-toolbar')).toContainText('1개 회사 · 1개 공고')
    await expect(page.locator('.map-stats strong')).toHaveText(['1곳', '0곳'])
    await expect(page.locator('.city-row')).toHaveCount(0)
    await expect(page.locator('.residence-button')).toHaveText('영국 거주 기준')

    const cedar = page.getByRole('button', { name: 'Backend Engineer Cedar', exact: true })
    await cedar.click()
    await expectScopeLabel(page, '영국', derivedNotice)
    await expandEvidence(page, REMOTE_UK_PARAGRAPH)
    await expect(scope(page).getByText('게시 위치: Remote', { exact: true })).toBeVisible()
    await escapeTo(page, cedar)

    await chooseResidence(page, 'US')
    await expect(page.locator('.mini-job-title')).toHaveText(['Backend Engineer Maple'])
    await expect(page.locator('.list-toolbar')).toContainText('1개 회사 · 1개 공고')
    await expect(page.locator('.residence-button')).toHaveText('미국 거주 기준')
    const maple = page.getByRole('button', { name: 'Backend Engineer Maple', exact: true })
    await maple.click()
    await expectScopeLabel(page, '미국', derivedNotice)
    await expandEvidence(page, REMOTE_US_PARAGRAPH)
    await auditDialog(page, info, width === 320 ? 'remote-description-us-320.png' : undefined)
    await escapeTo(page, maple)

    await chooseResidence(page, 'CA')
    await expect(page.locator('.mini-job-title')).toHaveCount(0)
    await expect(page.getByRole('heading', { name: '지금 조건에 맞는 원격 기회가 없어요', exact: true })).toBeVisible()
    const recovery = page.locator('.recovery-option')
    await expect(recovery).toHaveCount(1)
    await expect(recovery.locator('dt')).toHaveText('원격근무 지역')
    await expect(recovery.locator('.recovery-warning')).toContainText('선택한 거주 국가에서 근무할 수 있다는 뜻은 아닙니다.')
    await recovery.getByRole('button', { name: '회사 2곳 · 공고 4개 보기', exact: true }).click()
    await expect(page.locator('.list-toolbar')).toContainText('2개 회사 · 4개 공고')
    await expect(page.locator('.map-stats strong')).toHaveText(['2곳', '0곳'])
    for (const company of ['Cedar Systems', 'Maple Software']) {
      await page.locator('.company-card').filter({ has: page.getByRole('heading', { name: company, exact: true }) })
        .getByRole('button', { name: '전체 2개 공고 보기', exact: true }).click()
    }
    expect((await page.locator('.mini-job-title').allTextContents()).sort()).toEqual([
      'Backend Engineer Birch', 'Backend Engineer Cedar', 'Backend Engineer Maple', 'Backend Engineer Rowan',
    ])

    const rowan = page.getByRole('button', { name: 'Backend Engineer Rowan', exact: true })
    await rowan.click()
    await expectScopeLabel(page, '국가별 근무 지역 미확인', unconfirmedNotice)
    await expandEvidence(page, REMOTE_CONFLICT_PARAGRAPH)
    await expect(scope(page).getByText('게시 위치: United States · Remote', { exact: true })).toBeVisible()
    await expect(scope(page).getByText('게시 위치에서 확인한 지역: 미국', { exact: true })).toBeVisible()
    await expect(page.getByRole('dialog')).not.toContainText('선택한 거주 국가가 공고의 원격근무 지역에 포함돼요')
    expect(await page.locator('.dialog').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
    if (width === 320) await page.screenshot({ path: info.outputPath('remote-description-unconfirmed-320.png') })
    await escapeTo(page, rowan)

    await page.getByRole('button', { name: 'Backend Engineer Birch', exact: true }).click()
    await expectScopeLabel(page, '국가별 근무 지역 미확인')
    await expect(page.getByRole('dialog')).not.toContainText('선택한 거주 국가가 공고의 원격근무 지역에 포함돼요')
    await close(page)
    expect(traffic.catalog()).toHaveLength(initial.attempts)
    expectPrivateTraffic(page, traffic)
    expect(errors).toEqual([])
  })

  test('a version-one saved snapshot keeps its note and dates through reload, CSV and fresh-context JSON restore', async ({ page, browser }, info) => {
    const old = legacyRemoteDescriptionSaved()
    const catalog = remoteDescriptionCatalog([old.job])
    const index = await postingIndex([old.job])
    const traffic = watchApiRequests(page)
    await page.route('**/api/catalog?source=public*', route => route.fulfill({ json: catalog }))
    await page.route('**/api/posting-status*', route => route.fulfill({ json: index }))
    await restore(page, [old])
    await expectInitialCatalogRequest(page, traffic)
    await expect(page.locator('.mini-job-title')).toHaveText(['Backend Engineer Cedar'])
    await page.getByRole('button', { name: 'Backend Engineer Cedar', exact: true }).click()
    await expectScopeLabel(page, '영국', derivedNotice)
    await expandEvidence(page, REMOTE_UK_PARAGRAPH)
    await expect(page.getByLabel('이 기회에 대한 나의 메모')).toHaveValue(REMOTE_DESCRIPTION_NOTE)
    await expect(page.getByRole('button', { name: '지원 완료로 표시됨', exact: true })).toBeVisible()
    await close(page)
    expectOriginalSaved(await readSaved(page))
    expect(old.job.remoteCountries).toEqual([])
    expect(old.job.remoteScopeVersion).toBe(1)

    await navigation(page).getByRole('button', { name: /저장한 기회/ }).click()
    await expect(page.locator('.saved-card')).toHaveCount(1)
    await page.getByRole('button', { name: '게시 상태 확인', exact: true }).click()
    await expect(page.locator('.posting-notice.listed')).toHaveCount(1)
    await expect(page.locator('.posting-notice.changed, .posting-notice.missing')).toHaveCount(0)
    const csvDownload = page.waitForEvent('download')
    await page.getByRole('button', { name: 'CSV 내보내기', exact: true }).click()
    const csv = singleCsvRecord(await readFile((await (await csvDownload).path())!, 'utf8'))
    expect(csv).toMatchObject({
      '회사': 'Cedar Systems', '포지션': 'Backend Engineer Cedar', '근무지': 'Remote',
      '저장일': REMOTE_DESCRIPTION_SAVED_AT, '저장 내용의 조회 시각': REMOTE_DESCRIPTION_TIME,
      '상태': '지원 완료', '메모': REMOTE_DESCRIPTION_NOTE, '내용 비교': '표시 내용 일치',
      '명시된 원격근무 국가·지역': '영국', '원격근무 국가 코드': 'GB',
      '원격근무 추가 확인': countryCaution, '원격근무 지역 판단': derivedNotice,
      '원격근무 지역 원문 근거': REMOTE_UK_PARAGRAPH,
      '근무 국가': '', '근무 국가 근거': '',
    })

    await page.getByRole('button', { name: '기록 백업·복원', exact: true }).click()
    const jsonDownload = page.waitForEvent('download')
    await page.getByRole('button', { name: 'JSON 백업', exact: true }).click()
    const text = await readFile((await (await jsonDownload).path())!, 'utf8')
    const backup = JSON.parse(text) as { records: SavedJob[] }
    expectOriginalSaved(backup.records)
    expect(text).not.toContain('Synthetic remote description profile')
    await page.getByRole('button', { name: '완료', exact: true }).click()
    await page.reload()
    await expect(page.locator('.saved-card')).toHaveCount(1)
    expect(await readSaved(page)).toEqual(backup.records)
    await page.getByRole('button', { name: 'Backend Engineer Cedar', exact: true }).click()
    await expectScopeLabel(page, '영국', derivedNotice)
    await expect(page.getByLabel('이 기회에 대한 나의 메모')).toHaveValue(REMOTE_DESCRIPTION_NOTE)
    await close(page)
    expectPrivateTraffic(page, traffic)

    const destination = await browser.newContext({
      viewport: { width, height: 960 }, isMobile: width === 320, hasTouch: width === 320,
    })
    try {
      const target = await destination.newPage()
      const restoredTraffic = watchApiRequests(target)
      await target.clock.setFixedTime(new Date(REMOTE_DESCRIPTION_NOW))
      await target.route('**/api/**', route => route.abort('blockedbyclient'))
      await target.route('**/api/catalog?source=public*', route => route.fulfill({ json: catalog }))
      await target.goto(`${new URL(page.url()).origin}/#saved`)
      await waitForSavedCommit(target)
      await target.getByRole('button', { name: '기록 백업·복원', exact: true }).click()
      await target.getByLabel('백업 또는 복구 파일', { exact: true }).setInputFiles({
        name: 'remote-description.json', mimeType: 'application/json', buffer: Buffer.from(text),
      })
      await expect(target.locator('.saved-import-row')).toHaveCount(1)
      expect(await readSaved(target)).toEqual([])
      await target.getByRole('button', { name: '선택한 1개 가져오기', exact: true }).click()
      await expect(target.locator('.saved-file-message')).toContainText('선택한 1개 기록을 저장했어요.')
      expect(await readSaved(target)).toEqual(backup.records)
      await target.getByRole('button', { name: '완료', exact: true }).click()
      await target.getByRole('button', { name: 'Backend Engineer Cedar', exact: true }).click()
      await expectScopeLabel(target, '영국', derivedNotice)
      await expandEvidence(target, REMOTE_UK_PARAGRAPH)
      await expect(target.getByLabel('이 기회에 대한 나의 메모')).toHaveValue(REMOTE_DESCRIPTION_NOTE)
      await expect(target.getByRole('button', { name: '지원 완료로 표시됨', exact: true })).toBeVisible()
      await auditDialog(target, info)
      await close(target)
      await target.reload()
      await expect(target.locator('.saved-card')).toHaveCount(1)
      expect(await readSaved(target)).toEqual(backup.records)
      expect(await target.evaluate(() => localStorage.getItem('orbit.v1.profile'))).toBeNull()
      expectPrivateTraffic(target, restoredTraffic)
    } finally { await destination.close() }
  })

  test('a same-ID incremental body update changes current eligibility while the saved source stays intact', async ({ page }) => {
    const original = legacyRemoteDescriptionSaved()
    const updated = legacyRemoteDescriptionJob('4101', {
      description: remoteDescriptionText(REMOTE_US_PARAGRAPH),
      updatedAt: '2026-09-19T08:11:00.000Z', fetchedAt: REMOTE_DESCRIPTION_NOW,
    })
    const first = remoteDescriptionCatalog([original.job])
    first.boards[1] = {
      ...first.boards[1], status: 'pending', dataStatus: 'unavailable', lastSuccessAt: null,
    }
    const snapshot: CatalogCollectionSnapshot = {
      catalog: first, progress: { id: collectionId, revision: 1, total: 2, completed: 1, done: false },
    }
    const complete = remoteDescriptionCatalog([updated])
    complete.fetchedAt = REMOTE_DESCRIPTION_NOW
    const { companies: _companies, cities: _cities, jobs, ...metadata } = complete
    const delta: CatalogCollectionUpdate = {
      progress: { id: collectionId, revision: 2, total: 2, completed: 2, done: true },
      catalog: metadata, companyIds: ['remote-description-a', 'remote-description-b'], jobs,
    }
    const index = await postingIndex([updated])
    let releaseDelta!: () => void
    const ready = new Promise<void>(resolve => { releaseDelta = resolve })
    const traffic = watchApiRequests(page)
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await page.route('**/api/catalog?source=public*', route => route.fulfill({ status: 202, json: snapshot }))
    await page.route('**/api/catalog/progress?*', async route => {
      await ready
      await route.fulfill({ json: delta })
    })
    await page.route('**/api/posting-status*', route => route.fulfill({ json: index }))
    try {
      await restore(page, [original])
      await expectInitialCatalogRequest(page, traffic)
      await expect(page.locator('.mini-job-title')).toHaveText(['Backend Engineer Cedar'])
      await expect(page.getByRole('progressbar')).toHaveAttribute('value', '1')
      const savedBefore = await readSaved(page)
      expectOriginalSaved(savedBefore)

      releaseDelta()
      await expect(page.getByRole('progressbar')).toHaveCount(0)
      await expect(page.locator('.mini-job-title')).toHaveCount(0)
      await expect(page.getByRole('heading', { name: '지금 조건에 맞는 원격 기회가 없어요', exact: true })).toBeVisible()
      await expect(page.locator('.residence-button')).toHaveText('영국 거주 기준')
      expect(await readSaved(page)).toEqual(savedBefore)
      await chooseResidence(page, 'US')
      await expect(page.locator('.mini-job-title')).toHaveText(['Backend Engineer Cedar'])
      await expect(page.locator('.list-toolbar')).toContainText('1개 회사 · 1개 공고')
      await page.getByRole('button', { name: 'Backend Engineer Cedar', exact: true }).click()
      await expectScopeLabel(page, '미국', derivedNotice)
      await expandEvidence(page, REMOTE_US_PARAGRAPH)
      await close(page)

      await navigation(page).getByRole('button', { name: /저장한 기회/ }).click()
      await expect(page.locator('.saved-card')).toHaveCount(1)
      await page.getByRole('button', { name: '게시 상태 확인', exact: true }).click()
      await expect(page.locator('.posting-notice.changed')).toHaveCount(1)
      await expect(page.locator('.posting-notice.missing')).toHaveCount(0)
      await expect(page.locator('.posting-changes')).toHaveText('모집·근무·고용·비자 · 본문 확인 필요')
      await page.getByRole('button', { name: 'Backend Engineer Cedar', exact: true }).click()
      await expectScopeLabel(page, '영국', derivedNotice)
      await expandEvidence(page, REMOTE_UK_PARAGRAPH)
      await expect(page.getByLabel('이 기회에 대한 나의 메모')).toHaveValue(REMOTE_DESCRIPTION_NOTE)
      await expect(page.getByRole('button', { name: '지원 완료로 표시됨', exact: true })).toBeVisible()
      await close(page)
      expect(await readSaved(page)).toEqual(savedBefore)
      expectPrivateTraffic(page, traffic)
      expect(errors).toEqual([])
    } finally { releaseDelta() }
  })

  test('a UK-only body narrows a Global/AMER listing to Europe without losing the original posting evidence', async ({ page }, info) => {
    const paragraph = 'This role is open to candidates based in the United Kingdom only.'
    const old = legacyRemoteDescriptionJob('4190', {
      title: 'Backend Engineer Alder', locationLabel: 'Global, Remote · AMER',
      remoteWorldwide: true, remoteScopeUnknown: false, remoteRegions: ['americas'],
      description: remoteDescriptionText(paragraph),
    })
    const traffic = watchApiRequests(page)
    await page.route('**/api/catalog?source=public*', route => route.fulfill({ json: remoteDescriptionCatalog([old]) }))
    await restore(page)
    const initial = await expectInitialCatalogRequest(page, traffic)
    await expect(page.locator('.mini-job-title')).toHaveText(['Backend Engineer Alder'])
    await expect(page.locator('.list-toolbar')).toContainText('1개 회사 · 1개 공고')
    await expect(page.locator('.residence-button')).toHaveText('영국 거주 기준')

    await page.locator('.region-tabs').getByRole('button', { name: '유럽', exact: true }).click()
    await expect(page.locator('.mini-job-title')).toHaveText(['Backend Engineer Alder'])
    await expect(page.locator('.list-toolbar')).toContainText('1개 회사 · 1개 공고')
    await expect(page.locator('.map-stats strong')).toHaveText(['1곳', '0곳'])
    const opener = page.getByRole('button', { name: 'Backend Engineer Alder', exact: true })
    await opener.click()
    await expectScopeLabel(page, '영국', derivedNotice)
    await expandEvidence(page, paragraph)
    await expect(scope(page).getByText('게시 위치: Global, Remote · AMER', { exact: true })).toBeVisible()
    await expect(scope(page).getByText('게시 위치에서 확인한 지역: 전 세계', { exact: true })).toBeVisible()
    await auditDialog(page, info, width === 320 ? 'remote-description-region-320.png' : undefined)
    await escapeTo(page, opener)

    for (const region of ['미주', '아시아 · 태평양']) {
      const tab = page.locator('.region-tabs').getByRole('button', { name: region, exact: true })
      await tab.click()
      await expect(tab).toHaveAttribute('aria-pressed', 'true')
      await expect(page.locator('.mini-job-title')).toHaveCount(0)
      await expect(page.getByRole('heading', { name: '지금 조건에 맞는 원격 기회가 없어요', exact: true })).toBeVisible()
      await expect(page.locator('.map-stats strong')).toHaveText(['0곳', '0곳'])
      await expect(page.locator('.residence-button')).toHaveText('영국 거주 기준')
    }
    await page.locator('.region-tabs').getByRole('button', { name: '전 세계', exact: true }).click()
    await expect(page.locator('.mini-job-title')).toHaveText(['Backend Engineer Alder'])
    await expect(page.locator('.list-toolbar')).toContainText('1개 회사 · 1개 공고')
    await expect(page.locator('.city-row')).toHaveCount(0)
    expect(old).toMatchObject({ remoteScopeVersion: 1, remoteCountries: [], remoteWorldwide: true, remoteRegions: ['americas'] })
    expect(traffic.catalog()).toHaveLength(initial.attempts)
    expectPrivateTraffic(page, traffic)
  })
})
