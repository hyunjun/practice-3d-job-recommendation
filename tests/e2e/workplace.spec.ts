import { expect, test } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { readFile } from 'node:fs/promises'
import { upgradeJobLocation } from '../../shared/job-location'
import { createJobRevision } from '../../shared/posting-status'
import { DEFAULT_FILTERS } from '../../shared/types'
import type { SavedJob } from '../../shared/types'
import { CONFLICT_BODY, legacyWorkplaceJob, RELOCATION_BODY, RELOCATION_TITLE, WORKPLACE_BODY, workplacePosting } from '../fixtures/workplace'
import { SEARCH_COMPANIES, SEARCH_PROFILE, SEARCH_TIME, searchCatalog } from '../fixtures/search-catalog'
import { readSaved, waitForSavedCommit } from './helpers/saved-store'

function csvRecords(text: string): Record<string, string>[] {
  const cells = (value: string) => [...value.matchAll(/"((?:[^"]|"")*)"(?:,|\r\n|$)/g)].map(match => match[1].replaceAll('""', '"'))
  const headers = cells(text.slice(0, text.indexOf('\r\n')))
  const values = cells(text).slice(headers.length)
  expect(values.length % headers.length).toBe(0)
  return Array.from({ length: values.length / headers.length }, (_, index) =>
    Object.fromEntries(headers.map((header, column) => [header, values[index * headers.length + column]])))
}

for (const width of [1440, 320]) {
  test(`current workplace evidence survives map, conflict search, legacy saves and exports at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 960 })
    await page.clock.install({ time: new Date(Date.parse(SEARCH_TIME) + 10_000) })
    const company = SEARCH_COMPANIES[0]
    const internship = legacyWorkplaceJob()
    const listingLabel = `Sydney · ${'OriginalLocation'.repeat(30)}`
    const conflict = legacyWorkplaceJob(workplacePosting(2402, 'Security Engineer', listingLabel, CONFLICT_BODY))
    const jobs = [
      internship, conflict,
      legacyWorkplaceJob(workplacePosting(2410, RELOCATION_TITLE, 'New York', RELOCATION_BODY)),
      legacyWorkplaceJob(workplacePosting(2411, RELOCATION_TITLE, 'San Francisco', RELOCATION_BODY)),
      legacyWorkplaceJob(workplacePosting(2412, 'Backend Engineer', 'Seoul', 'This role is based in our Seoul office.')),
    ]
    const records: SavedJob[] = [internship, conflict].map((job, index) => ({
      job, company, savedAt: SEARCH_TIME, status: index ? 'saved' : 'applied', note: `private-workplace-note-${index}`,
    }))
    await page.addInitScript(({ records, profile, filters }) => {
      if (sessionStorage.getItem('workplace-seeded')) return
      localStorage.setItem('orbit.v1.saved', JSON.stringify(records))
      localStorage.setItem('orbit.v1.profile', JSON.stringify(profile))
      localStorage.setItem('orbit.v1.exploration', JSON.stringify({
        source: 'public', mapMode: 'flat', selectedId: null, panelTab: 'cities', filters,
      }))
      sessionStorage.setItem('workplace-seeded', 'true')
    }, { records, profile: { ...SEARCH_PROFILE, desiredRole: 'all', skills: [] }, filters: DEFAULT_FILTERS })
    // Exercise the browser's compatibility path with an older API/cache response.
    await page.route('**/api/catalog?source=public*', route => route.fulfill({ json: searchCatalog(jobs) }))
    const index = {
      version: 1, checkedAt: SEARCH_TIME, refreshAfter: new Date(Date.parse(SEARCH_TIME) + 60_000).toISOString(),
      boards: [{
        companyId: company.id, provider: company.provider, board: company.board, status: 'ok',
        checkedAt: SEARCH_TIME, lastSuccessAt: SEARCH_TIME, retryAt: null,
        listing: {
          validUntil: new Date(Date.parse(SEARCH_TIME) + 30 * 60_000).toISOString(),
          publishedIds: jobs.map(job => job.id),
          jobs: await Promise.all(jobs.map(async job => ({ id: job.id, title: job.title, url: job.url, revision: await createJobRevision(upgradeJobLocation(job)) }))),
        },
      }],
    }
    await page.route('**/api/posting-status*', route => route.fulfill({ json: index }))
    const errors: string[] = []
    const requests: { url: string; method: string; body: string | null }[] = []
    page.on('pageerror', error => errors.push(error.message))
    page.on('request', request => {
      if (request.url().includes('/api/')) requests.push({ url: request.url(), method: request.method(), body: request.postData() })
    })
    await page.goto('/')
    await waitForSavedCommit(page)
    await expect(page.locator('.city-row')).toHaveCount(4)
    expect((await page.locator('.city-row').allTextContents()).join('\n')).not.toMatch(/뉴욕|샌프란시스코|멜버른/)
    await expect(page.locator('.results-tabs button').last()).toHaveText('기타 근무지1')
    await page.locator('.city-row').filter({ hasText: '파리' }).click()
    await expect(page.locator('.mini-job-title')).toHaveText(internship.title)
    await expect(page.locator('.job-location-note')).toHaveText('제목·본문의 근무지로 표시')
    await page.locator('.mini-job-title').click()
    const detail = page.getByRole('region', { name: '근무지 판단', exact: true })
    await expect(page.locator('.job-detail-heading p')).toHaveText('Paris or London')
    await expect(detail).toContainText('현재 근무지 기준으로 표시했어요')
    await expect(detail.locator('dd')).toHaveText(['Seoul', 'Paris or London'])
    await detail.getByText('근무지를 판단한 원문', { exact: true }).click()
    await expect(detail.locator('blockquote').last()).toHaveText(WORKPLACE_BODY)
    await expect(page.getByLabel('이 기회에 대한 나의 메모')).toHaveValue(records[0].note)
    records[0].note = 'Updated private-workplace-note'
    await page.getByLabel('이 기회에 대한 나의 메모').fill(records[0].note)
    expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([])
    expect(await detail.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
    await page.getByRole('button', { name: '닫기', exact: true }).click()

    await page.locator('.results-tabs button').last().click()
    await page.getByLabel('도시, 회사 또는 포지션 검색').fill('Melbourne')
    await expect(page.locator('.mini-job-title')).toHaveText(conflict.title)
    await expect(page.locator('.mini-job-location')).toHaveText(listingLabel)
    await expect(page.locator('.job-location-note.conflict')).toBeVisible()
    await expect(page.locator('.map-stats strong')).toHaveText(['1곳', '0곳'])
    expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([])
    await page.locator('.mini-job-title').click()
    await expect(detail).toContainText('지도에는 표시하지 않았어요')
    await expect(detail.locator('dd')).toHaveText([listingLabel, 'Melbourne'])
    await expect(page.locator('.remote-scope, .unmapped-job-notice')).toHaveCount(0)
    await detail.getByText('근무지를 판단한 원문', { exact: true }).click()
    await expect(detail.locator('blockquote')).toHaveText(CONFLICT_BODY)
    expect(await detail.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
    expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([])
    await page.getByRole('button', { name: '닫기', exact: true }).click()
    await page.getByRole('navigation', { name: '주요 메뉴' }).getByRole('button', { name: /저장한 기회/ }).click()
    await waitForSavedCommit(page)
    await page.reload()
    await expect(page.locator('.saved-card')).toHaveCount(2)
    const expected = records.map(record => ({ ...record, job: upgradeJobLocation(record.job) }))
    expect(await readSaved(page)).toEqual(expected)
    await expect(page.locator('.saved-location')).toHaveText(['Paris or London', listingLabel])
    await page.getByRole('textbox', { name: '저장한 기회 검색', exact: true }).fill('멜버른')
    await expect(page.locator('.saved-title')).toHaveText(conflict.title)
    await page.getByRole('textbox', { name: '저장한 기회 검색', exact: true }).fill('')
    await page.getByRole('button', { name: '게시 상태 확인', exact: true }).click()
    await expect(page.locator('.posting-notice.listed')).toHaveCount(2)
    await expect(page.locator('.posting-notice.changed, .posting-notice.missing')).toHaveCount(0)
    expect(await readSaved(page)).toEqual(expected)
    expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([])
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    const csvDownload = page.waitForEvent('download')
    await page.getByRole('button', { name: 'CSV 내보내기', exact: true }).click()
    const exported = csvRecords(await readFile((await (await csvDownload).path())!, 'utf8'))
    expect(exported[0]).toMatchObject({
      '근무지': 'Paris or London', '원래 게시 위치': 'Seoul', '본문의 근무지': 'Paris or London',
      '메모': records[0].note, '저장일': SEARCH_TIME, '상태': '지원 완료', '내용 비교': '표시 내용 일치',
    })
    expect(exported[0]['근무지 원문 근거']).toContain(WORKPLACE_BODY)
    expect(exported[1]).toMatchObject({
      '근무지': listingLabel, '원래 게시 위치': listingLabel, '본문의 근무지': 'Melbourne',
      '근무지 판단': '정보 불일치 · 근무지 확인 필요',
    })
    await page.getByRole('button', { name: '기록 백업·복원', exact: true }).click()
    const backupDownload = page.waitForEvent('download')
    await page.getByRole('button', { name: 'JSON 백업', exact: true }).click()
    expect(JSON.parse(await readFile((await (await backupDownload).path())!, 'utf8')).records).toEqual(expected)
    for (const request of requests) {
      const url = new URL(request.url)
      expect(['/api/catalog', '/api/posting-status']).toContain(url.pathname)
      expect([...url.searchParams.keys()].every(key => key === 'source' || key === 'refresh')).toBe(true)
      expect(request.method).toBe('GET')
      expect(request.body).toBeNull()
      expect(request.url).not.toMatch(/private-workplace|workplace\/|Melbourne|멜버른/)
    }
    expect(errors).toEqual([])
  })
}
