import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { readFile } from 'node:fs/promises'
import { createJobRevision } from '../../shared/posting-status'
import type { PostingStatusIndex } from '../../shared/posting-status'
import { DEFAULT_FILTERS } from '../../shared/types'
import type { SavedJob } from '../../shared/types'
import { SEARCH_COMPANIES, SEARCH_PROFILE, SEARCH_TIME, searchCatalog, searchJob } from '../fixtures/search-catalog'
import { readSaved, waitForSavedCommit } from './helpers/saved-store'
import { expectInitialCatalogRequest, watchApiRequests } from './helpers/api-requests'

const jobs = [
  ['poland-saved', 'Remote, Poland'],
  ['poland-new', 'Remote, Poland'],
  ['new-zealand', 'Wellington, New Zealand · Remote'],
  ['regional', 'Europe · Remote'],
  ['australia', 'Adelaide, SA, Australia · Remote'],
  ['united-states', 'New Jersey, USA · Remote'],
].map(([id, locationLabel]) => searchJob(id, {
  cityIds: [], workMode: 'remote', locationLabel, remoteScopeUnknown: true,
  qualifications: { version: 1, skills: [], experience: [] }, skills: [], minExperience: null,
}))
const catalog = searchCatalog(jobs)
const original: SavedJob = {
  job: jobs[0], company: SEARCH_COMPANIES[0], savedAt: SEARCH_TIME,
  note: 'Private existing remote note', status: 'applied',
}

async function postingIndex(): Promise<PostingStatusIndex> {
  return {
    version: 1, checkedAt: SEARCH_TIME, refreshAfter: new Date(Date.parse(SEARCH_TIME) + 60_000).toISOString(),
    boards: await Promise.all(catalog.companies.map(async company => {
      const records = jobs.filter(job => job.companyId === company.id)
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

async function chooseResidence(page: Page, country: string) {
  await page.getByRole('button', { name: '내 프로필 편집', exact: true }).click()
  const select = page.getByLabel('원격근무 시 거주 국가·지역', { exact: true })
  await expect(select.locator('option')).toHaveCount(250)
  await select.selectOption(country)
  await expect(select).toHaveValue(country)
  expect(await page.locator('.dialog').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
  expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze()).violations).toEqual([])
  await page.getByRole('button', { name: '변경 사항 적용', exact: true }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
}

for (const width of [1440, 320]) {
  test.describe(`remote country discovery at ${width}px`, () => {
    test.use({ viewport: { width, height: 960 } })
    test('country selection, saved records, posting comparison and exports agree without sending personal filters', async ({ page }) => {
      const traffic = watchApiRequests(page)
      const errors: string[] = []
      const requests: { url: string; method: string; body: string | null }[] = []
      page.on('pageerror', error => errors.push(error.message))
      page.on('request', request => {
        if (new URL(request.url()).pathname.startsWith('/api/')) requests.push({ url: request.url(), method: request.method(), body: request.postData() })
      })
      await page.clock.setFixedTime(new Date(SEARCH_TIME))
      await page.route('**/api/catalog?source=public*', route => route.fulfill({ json: catalog }))
      const index = await postingIndex()
      await page.route('**/api/posting-status*', route => route.fulfill({ json: index }))
      await page.addInitScript(({ profile, filters, original }) => {
        if (sessionStorage.getItem('remote-country-seeded')) return
        localStorage.setItem('orbit.v1.profile', JSON.stringify(profile))
        localStorage.setItem('orbit.v1.saved', JSON.stringify([original]))
        localStorage.setItem('orbit.v1.exploration', JSON.stringify({
          source: 'public', mapMode: 'flat', selectedId: null, panelTab: 'remote', filters,
        }))
        sessionStorage.setItem('remote-country-seeded', 'true')
      }, {
        profile: { ...SEARCH_PROFILE, kind: 'personal', name: 'Private country profile', skills: ['TypeScript'], desiredRole: 'all', residence: 'KR' },
        filters: { ...DEFAULT_FILTERS, role: 'all', workMode: 'remote', visa: 'all', region: 'europe', query: '폴란드' },
        original,
      })
      await page.goto('/')
      const initialRequest = await expectInitialCatalogRequest(page, traffic)
      await waitForSavedCommit(page)
      await expect(page.locator('.mini-job')).toHaveCount(0)
      await chooseResidence(page, 'PL')
      await expect(page.locator('.residence-button')).toHaveText('폴란드 거주 기준')
      await page.getByRole('button', { name: '전체 2개 공고 보기', exact: true }).click()
      await expect(page.locator('.mini-job-title')).toHaveText([jobs[1].title, jobs[0].title])
      await expect(page.locator('.map-stats strong')).toHaveText(['1곳', '0곳'])
      await expect(page.locator('.city-row')).toHaveCount(0)
      expect(requests.filter(request => new URL(request.url).pathname === '/api/catalog')).toHaveLength(initialRequest.attempts)

      await page.getByRole('button', { name: jobs[0].title, exact: true }).click()
      await expect(page.locator('.remote-scope p')).toHaveText('폴란드')
      await expect(page.locator('.remote-scope small')).toContainText('취업 허가·국적·주별 제한·협업 시간대')
      await expect(page.getByLabel('이 기회에 대한 나의 메모')).toHaveValue(original.note)
      await expect(page.locator('.match-section').first()).toContainText('선택한 거주 국가가 공고의 원격근무 지역에 포함돼요')
      await page.getByRole('button', { name: '닫기', exact: true }).click()
      await page.getByRole('button', { name: jobs[1].title, exact: true }).click()
      await page.getByRole('button', { name: '기회 저장', exact: true }).click()
      await page.getByLabel('이 기회에 대한 나의 메모').fill('Private new remote note')
      await page.getByRole('button', { name: '지원 완료로 표시', exact: true }).click()
      await page.getByRole('button', { name: '닫기', exact: true }).click()
      await waitForSavedCommit(page)

      await page.getByRole('navigation', { name: '주요 메뉴' }).getByRole('button', { name: /저장한 기회/ }).click()
      await expect(page.locator('.saved-card')).toHaveCount(2)
      await page.getByRole('button', { name: '게시 상태 확인', exact: true }).click()
      await expect(page.locator('.posting-notice.listed')).toHaveCount(2)
      await expect(page.locator('.posting-notice.changed')).toHaveCount(0)
      const csvDownload = page.waitForEvent('download')
      await page.getByRole('button', { name: 'CSV 내보내기', exact: true }).click()
      const csv = await readFile((await (await csvDownload).path())!, 'utf8')
      for (const value of ['명시된 원격근무 국가·지역', '원격근무 국가 코드', '폴란드', '"PL"', original.note, 'Private new remote note', '표시 내용 일치', SEARCH_TIME]) expect(csv).toContain(value)
      await page.getByRole('button', { name: '기록 백업·복원', exact: true }).click()
      const jsonDownload = page.waitForEvent('download')
      await page.getByRole('button', { name: 'JSON 백업', exact: true }).click()
      const backupText = await readFile((await (await jsonDownload).path())!, 'utf8')
      const backup = JSON.parse(backupText) as { records: SavedJob[] }
      expect(backup.records).toHaveLength(2)
      expect(backupText).not.toContain('Private country profile')
      for (const record of backup.records) expect(record).toMatchObject({ status: 'applied', job: { remoteCountries: ['PL'], remoteScopeUnknown: false, fetchedAt: SEARCH_TIME } })
      expect(backup.records.find(record => record.job.id === jobs[0].id)).toMatchObject({ note: original.note, savedAt: original.savedAt })
      await page.getByRole('button', { name: '완료', exact: true }).click()

      await page.getByRole('navigation', { name: '주요 메뉴' }).getByRole('button', { name: /기회 탐색/ }).click()
      await chooseResidence(page, 'NZ')
      await page.locator('.region-tabs').getByRole('button', { name: '아시아 · 태평양', exact: true }).click()
      await page.getByLabel('도시, 회사 또는 포지션 검색').fill('뉴질랜드')
      await expect(page.locator('.mini-job-title')).toHaveText([jobs[2].title])
      await expect(page.locator('.residence-button')).toHaveText('뉴질랜드 거주 기준')
      await expect(page.locator('.map-stats strong')).toHaveText(['1곳', '0곳'])
      await page.locator('.mini-job-title').click()
      await expect(page.locator('.remote-scope p')).toHaveText('뉴질랜드')
      await page.getByRole('button', { name: '닫기', exact: true }).click()
      await page.reload()
      await expect(page.getByLabel('도시, 회사 또는 포지션 검색')).toHaveValue('뉴질랜드')
      await expect(page.locator('.residence-button')).toHaveText('뉴질랜드 거주 기준')
      await expect(page.locator('.mini-job-title')).toHaveText([jobs[2].title])
      expect(await readSaved(page)).toEqual(backup.records)
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze()).violations).toEqual([])
      for (const request of requests) {
        const url = new URL(request.url)
        expect(request.method).toBe('GET')
        expect(request.body).toBeNull()
        if (url.pathname === '/api/catalog') expect([...url.searchParams]).toEqual([['source', 'public']])
        else { expect(url.pathname).toBe('/api/posting-status'); expect([...url.searchParams]).toEqual([['refresh', '1']]) }
      }
      expect(errors).toEqual([])
    })
  })
}
