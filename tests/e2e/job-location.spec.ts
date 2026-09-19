import { readSavedJson, waitForSavedCommit } from './helpers/saved-store'
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { readFile } from 'node:fs/promises'
import { createJobRevision } from '../../shared/posting-status'
import type { PostingStatusIndex } from '../../shared/posting-status'
import type { Catalog, Filters, Job } from '../../shared/types'
import type { ExplorationState } from '../../src/lib/storage'
import { SEARCH_COMPANIES, SEARCH_FILTERS, SEARCH_PROFILE, SEARCH_TIME, searchCatalog, searchJob } from '../fixtures/search-catalog'

function locationJob(id: string, overrides: Partial<Job> = {}) {
  return searchJob(id, {
    cityIds: [], locationLabel: 'Gurugram', workMode: 'unknown',
    qualifications: { version: 1, skills: [], experience: [] }, ...overrides,
  })
}
const jobs = [
  searchJob('london'),
  locationJob('gurugram'),
  locationJob('cork', { locationLabel: 'Cork, Ireland', workMode: 'hybrid' }),
  locationJob('placeholder', {
    id: `greenhouse-${SEARCH_COMPANIES[1].id}-placeholder`, companyId: SEARCH_COMPANIES[1].id, locationLabel: 'N/A', workMode: 'onsite',
  }),
  searchJob('remote', { cityIds: [], workMode: 'remote', remoteWorldwide: true, locationLabel: 'Remote, Global' }),
]

async function restore(page: Page, getCatalog: () => Catalog, tab: ExplorationState['panelTab'] = 'cities', filters: Filters = SEARCH_FILTERS) {
  await page.clock.install({ time: new Date(Date.parse(SEARCH_TIME) + 10_000) })
  await page.route('**/api/catalog?source=public*', route => route.fulfill({ json: getCatalog() }))
  await page.addInitScript(({ profile, filters, tab }) => {
    if (!localStorage.getItem('orbit.v1.profile')) localStorage.setItem('orbit.v1.profile', JSON.stringify(profile))
    if (!localStorage.getItem('orbit.v1.exploration')) localStorage.setItem('orbit.v1.exploration', JSON.stringify({
      source: 'public', filters, selectedId: null, panelTab: tab, mapMode: 'flat',
    }))
  }, { profile: SEARCH_PROFILE, filters, tab })
  await page.goto('/')
}

async function postingIndex(catalog: Catalog): Promise<PostingStatusIndex> {
  return {
    version: 1, checkedAt: SEARCH_TIME, refreshAfter: new Date(Date.parse(SEARCH_TIME) + 60_000).toISOString(),
    boards: await Promise.all(catalog.companies.map(async company => {
      const records = catalog.jobs.filter(job => job.companyId === company.id)
      return {
        companyId: company.id, provider: company.provider!, board: company.board!, status: 'ok',
        checkedAt: SEARCH_TIME, lastSuccessAt: SEARCH_TIME, retryAt: null,
        listing: {
          validUntil: new Date(Date.parse(SEARCH_TIME) + 30 * 60_000).toISOString(),
          publishedIds: records.map(job => job.id),
          jobs: await Promise.all(records.map(async job => ({ id: job.id, title: job.title, url: job.url, revision: await createJobRevision(job) }))),
        },
      }
    })),
  }
}
const stored = (page: Page) => page.evaluate(() => JSON.parse(localStorage.getItem('orbit.v1.exploration') || '{}'))

test('search finds other locations and preserves their source through detail, saving, comparison and CSV', async ({ page }) => {
  const catalog = searchCatalog(jobs)
  const index = await postingIndex(catalog)
  const requests: { url: string; body: string | null }[] = []
  page.on('request', request => {
    if (request.url().includes('/api/')) requests.push({ url: request.url(), body: request.postData() })
  })
  await page.route('**/api/posting-status*', route => route.fulfill({ json: index }))
  await restore(page, () => catalog)
  await expect(page.locator('.city-row')).toHaveCount(1)
  await expect(page.locator('.map-stats strong')).toHaveText(['2곳', '1곳'])
  await expect(page.locator('.results-tabs button').last()).toHaveText('기타 근무지2')
  await page.getByLabel('도시, 회사 또는 포지션 검색').fill('Gurugram')
  await expect(page.locator('.city-row')).toHaveCount(0)
  const alternative = page.getByRole('button', { name: /기타 근무지 보기/ })
  await expect(alternative).toContainText('회사 1곳 · 공고 1개')
  await alternative.focus()
  await alternative.press('Enter')
  await expect(page.locator('.results-panel')).toBeFocused()
  await expect(page.locator('.list-toolbar')).toHaveText('1개 회사 · 1개 공고조건')
  await expect(page.locator('.mini-job-location')).toHaveText('Gurugram')
  await expect(page.locator('.mini-job-meta')).toContainText('근무 형태 미확인')
  await expect(page.locator('.map-stats strong')).toHaveText(['1곳', '0곳'])
  expect((await stored(page)).filters).toEqual({ ...SEARCH_FILTERS, query: 'Gurugram' })

  await page.locator('.mini-job-title').click()
  await expect(page.locator('.job-detail-heading p')).toHaveText('Gurugram')
  await expect(page.locator('.unmapped-job-notice')).toContainText('지도에 표시되지 않은 근무지')
  await expect(page.locator('.remote-scope')).toHaveCount(0)
  await expect(page.getByRole('link', { name: '원문에서 지원하기' })).toHaveAttribute('href', jobs[1].url)
  await page.getByRole('button', { name: '기회 저장', exact: true }).click()
  await page.getByLabel('이 기회에 대한 나의 메모').fill('private-location-note')
  await page.getByRole('button', { name: '지원 완료로 표시', exact: true }).click()
  await page.getByRole('button', { name: '닫기', exact: true }).click()
  await page.getByRole('navigation', { name: '주요 메뉴' }).getByRole('button', { name: /저장한 기회/ }).click()
  await waitForSavedCommit(page)
  await page.reload()
  await expect(page.locator('.saved-card')).toHaveCount(1)
  await expect(page.locator('.saved-location')).toHaveText('Gurugram')
  await expect(page.locator('.saved-status')).toHaveText('지원 완료')
  await expect(page.locator('.saved-note-preview')).toHaveText('private-location-note')
  const savedBefore = await readSavedJson(page)
  await page.getByRole('button', { name: '게시 상태 확인', exact: true }).click()
  await expect(page.locator('.posting-notice')).toHaveClass(/listed/)
  await expect(page.locator('.posting-notice')).not.toHaveClass(/changed/)
  await expect(page.locator('.posting-notice')).not.toContainText('탐색 범위 밖')
  expect(await readSavedJson(page)).toBe(savedBefore)
  const download = page.waitForEvent('download')
  await page.getByRole('button', { name: 'CSV 내보내기', exact: true }).click()
  const csvPath = await (await download).path()
  const csv = await readFile(csvPath!, 'utf8')
  expect(csv).toContain('Gurugram')
  expect(csv).toContain('private-location-note')
  expect(csv).toContain('지원 완료')
  expect(csv).toContain('표시 내용 일치')
  await page.locator('.saved-title').click()
  await expect(page.locator('.unmapped-job-notice')).toBeVisible()
  await page.getByRole('button', { name: '닫기', exact: true }).click()
  await page.getByRole('navigation', { name: '주요 메뉴' }).getByRole('button', { name: '기회 탐색', exact: true }).click()
  await expect(page.locator('.mini-job-location')).toHaveText('Gurugram')
  expect((await stored(page)).panelTab).toBe('unmapped')
  for (const request of requests) {
    const url = new URL(request.url)
    expect(['/api/catalog', '/api/posting-status']).toContain(url.pathname)
    expect([...url.searchParams.keys()].every(key => key === 'source' || key === 'refresh')).toBe(true)
    expect(request.body).toBeNull()
    expect(request.url).not.toMatch(/Gurugram|private-location-note|Search%20fixture/)
  }
})

test('region recovery discloses the broader scope, supports undo and keeps non-remote work filters in the same tab', async ({ page }) => {
  const catalog = searchCatalog(jobs)
  const filters = { ...SEARCH_FILTERS, query: 'Gurugram', region: 'europe' as const }
  await restore(page, () => catalog, 'unmapped', filters)
  await expect(page.locator('.company-card')).toHaveCount(0)
  await expect(page.locator('.unmapped-range-note')).toContainText('‘전 세계’에서만 표시')
  await expect(page.locator('.recovery-option dt')).toHaveText('탐색 지역')
  await expect(page.locator('.recovery-warning')).toContainText('기존에 선택한 지역의 공고라는 뜻은 아니에요')
  expect((await stored(page)).filters).toEqual(filters)
  await page.locator('.recovery-option button').click()
  await expect(page.locator('.mini-job-location')).toHaveText('Gurugram')
  await expect.poll(async () => (await stored(page)).filters).toEqual({ ...filters, region: 'all' })
  await page.getByRole('button', { name: '실행 취소', exact: true }).click()
  await expect(page.locator('.company-card')).toHaveCount(0)
  await expect.poll(async () => (await stored(page)).filters).toEqual(filters)
  await page.locator('.recovery-option button').click()
  await page.getByLabel('근무 형태 필터').selectOption('unknown')
  await expect(page.locator('.mini-job-location')).toHaveText('Gurugram')
  expect((await stored(page)).panelTab).toBe('unmapped')
  await waitForSavedCommit(page)
  await page.reload()
  await expect(page.locator('.mini-job-location')).toHaveText('Gurugram')
  expect((await stored(page)).filters).toEqual({ ...filters, region: 'all', workMode: 'unknown' })
})

test('older count-only snapshots disclose omitted contents and refresh into actual browsable results', async ({ page }) => {
  let catalog: Catalog = { ...searchCatalog([jobs[0]]), unmappedCount: 2 }
  await restore(page, () => catalog, 'unmapped')
  await expect(page.locator('.unmapped-previous-note')).toContainText('공고 2개가 더 있어요')
  await expect(page.locator('.results-tabs button').last()).toHaveText('기타 근무지0')
  await expect(page.locator('.company-card')).toHaveCount(0)
  await page.getByRole('button', { name: '조회 상태 확인', exact: true }).click()
  await expect(page.locator('.data-dialog')).toContainText('이전 조회에서 목록에 포함하지 못한 공고 2개가 더 있어요')
  catalog = searchCatalog(jobs.slice(0, 3))
  await page.getByRole('button', { name: '새로고침', exact: true }).click()
  await expect(page.locator('.coverage-stats strong').last()).toHaveText('3')
  await expect(page.locator('.data-dialog')).toContainText('지도에 연결되지 않은 2개 개발 공고')
  await page.getByRole('button', { name: '닫기', exact: true }).click()
  await expect(page.locator('.unmapped-previous-note')).toHaveCount(0)
  await expect(page.locator('.results-tabs button').last()).toHaveText('기타 근무지1')
  await expect(page.locator('.list-toolbar')).toHaveText('1개 회사 · 2개 공고조건')
  await page.getByRole('button', { name: '전체 2개 공고 보기', exact: true }).click()
  await expect(page.locator('.mini-job-location')).toHaveCount(2)
  expect((await page.locator('.mini-job-location').allTextContents()).sort()).toEqual(['Cork, Ireland', 'Gurugram'])
})

test.describe('other locations at 320px', () => {
  test.use({ viewport: { width: 320, height: 780 }, isMobile: true, hasTouch: true })
  test('all three tabs, unstructured locations and details remain readable and accessible', async ({ page }) => {
    const location = `Gurugram, Haryana; ${'UnstructuredLocation'.repeat(12)}`
    const catalog = searchCatalog([locationJob('long-location', { locationLabel: location })])
    await restore(page, () => catalog, 'unmapped')
    await page.locator('.results-tabs').scrollIntoViewIfNeeded()
    for (const tab of await page.locator('.results-tabs button').all()) {
      await expect(tab).toBeInViewport()
      expect(await tab.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
    }
    await expect(page.locator('.mini-job-location')).toHaveText(location)
    expect(await page.locator('body').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
    expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([])
    await page.locator('.mini-job-title').click()
    await expect(page.locator('.unmapped-job-notice')).toBeVisible()
    expect(await page.locator('.dialog').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
    expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([])
    await page.getByRole('button', { name: '기회 저장', exact: true }).click()
    await page.getByRole('button', { name: '닫기', exact: true }).click()
    await page.getByRole('navigation', { name: '주요 메뉴' }).getByRole('button', { name: /저장한 기회/ }).click()
    await expect(page.locator('.saved-location')).toHaveText(location)
    expect(await page.locator('body').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
  })
})
