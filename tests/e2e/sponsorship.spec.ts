import { expect, test } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { readFile } from 'node:fs/promises'
import { upgradeJobEligibility } from '../../shared/job-eligibility'
import { createJobRevision } from '../../shared/posting-status'
import { DEFAULT_FILTERS } from '../../shared/types'
import type { SavedJob } from '../../shared/types'
import { SEARCH_COMPANIES, SEARCH_PROFILE, SEARCH_TIME, searchCatalog } from '../fixtures/search-catalog'
import { INTERNSHIP_SPONSORSHIP, legacySponsorshipJob, TRANSFER_SPONSORSHIP } from '../fixtures/sponsorship'
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
  test(`sponsorship scope survives legacy filtering, saved records and exports at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 960 })
    await page.clock.install({ time: new Date(Date.parse(SEARCH_TIME) + 10_000) })
    const company = SEARCH_COMPANIES[0]
    const jobs = [legacySponsorshipJob('internship'), legacySponsorshipJob('transfer'), legacySponsorshipJob('unknown')]
    const records: SavedJob[] = jobs.slice(0, 2).map((job, index) => ({
      job, company, savedAt: SEARCH_TIME, status: index ? 'saved' : 'applied', note: `private-sponsorship-note-${index}`,
    }))
    await page.addInitScript(({ records, profile, filters }) => {
      if (sessionStorage.getItem('sponsorship-seeded')) return
      localStorage.setItem('orbit.v1.saved', JSON.stringify(records))
      localStorage.setItem('orbit.v1.profile', JSON.stringify(profile))
      localStorage.setItem('orbit.v1.exploration', JSON.stringify({
        source: 'public', mapMode: 'flat', selectedId: 'london', panelTab: 'cities', filters,
      }))
      sessionStorage.setItem('sponsorship-seeded', 'true')
    }, { records, profile: { ...SEARCH_PROFILE, desiredRole: 'all', skills: [] }, filters: { ...DEFAULT_FILTERS, visa: 'yes' } })
    // Both the API and local saves deliberately contain the previous interpretation.
    await page.route('**/api/catalog?source=public*', route => route.fulfill({ json: searchCatalog(jobs) }))
    const index = {
      version: 1, checkedAt: SEARCH_TIME, refreshAfter: new Date(Date.parse(SEARCH_TIME) + 60_000).toISOString(),
      boards: [{
        companyId: company.id, provider: company.provider, board: company.board, status: 'ok',
        checkedAt: SEARCH_TIME, lastSuccessAt: SEARCH_TIME, retryAt: null,
        listing: {
          validUntil: new Date(Date.parse(SEARCH_TIME) + 30 * 60_000).toISOString(),
          publishedIds: jobs.map(job => job.id),
          jobs: await Promise.all(jobs.map(async job => ({
            id: job.id, title: job.title, url: job.url, revision: await createJobRevision(upgradeJobEligibility(job)),
          }))),
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
    await expect(page.locator('.mini-job-title')).toHaveText(jobs[0].title)
    await expect(page.locator('.visa-tag')).toHaveText('비자 지원 명시')
    await expect(page.locator('.eligibility-notice')).toHaveText('거주 요건 조건 확인')
    await page.locator('.mini-job-title').click()
    await expect(page.locator('.job-detail-heading p')).toHaveText('Paris or London')
    await expect(page.locator('.job-key-facts > div').last().locator('strong')).toHaveText('지원 명시')
    await expect(page.locator('.job-eligibility .eligibility-rule')).toHaveCount(1)
    await page.locator('.job-eligibility summary').click()
    await expect(page.locator('.job-eligibility blockquote')).toHaveText(INTERNSHIP_SPONSORSHIP)
    await expect(page.getByLabel('이 기회에 대한 나의 메모')).toHaveValue(records[0].note)
    expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([])
    await page.getByRole('button', { name: '닫기', exact: true }).click()

    if (width < 600) {
      await page.getByRole('button', { name: /^모든 필터/ }).click()
      await page.getByLabel('비자 지원', { exact: true }).selectOption('supported')
      await page.getByRole('button', { name: /개 공고 보기$/ }).click()
    } else await page.getByLabel('비자 지원 필터').selectOption('supported')
    await page.getByRole('button', { name: '전체 2개 공고 보기', exact: true }).click()
    await expect(page.locator('.mini-job-title')).toHaveCount(2)
    const transfer = page.locator('.mini-job').filter({ hasText: jobs[1].title })
    const transferNotice = '기존 비자 스폰서십 변경 지원 · 적용 조건 확인'
    await expect(transfer.locator('.visa-tag')).toHaveText('비자 조건부 지원 명시')
    await expect(transfer.locator('.eligibility-notice')).toHaveText(transferNotice)
    await expect(page.locator('.mini-job-title').filter({ hasText: jobs[2].title })).toHaveCount(0)
    await transfer.locator('.mini-job-title').click()
    await expect(page.locator('.job-key-facts .conditional-visa')).toHaveText('조건부 지원 명시')
    await expect(page.locator('.job-key-facts > div').last().locator('small')).toHaveText(transferNotice)
    await expect(page.locator('.job-eligibility .eligibility-rule')).toHaveCount(1)
    await page.locator('.job-eligibility summary').click()
    await expect(page.locator('.job-eligibility summary')).toHaveText('비자 지원 적용 범위적용 조건 확인')
    await expect(page.locator('.job-eligibility blockquote')).toHaveText(TRANSFER_SPONSORSHIP)
    records[1].note = 'Updated private-sponsorship-note: confirm local transfer conditions'
    records[1].status = 'applied'
    await page.getByLabel('이 기회에 대한 나의 메모').fill(records[1].note)
    await page.getByRole('button', { name: '지원 완료로 표시', exact: true }).click()
    expect(await page.locator('.dialog').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
    expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([])
    await page.getByRole('button', { name: '닫기', exact: true }).click()
    await page.getByRole('navigation', { name: '주요 메뉴' }).getByRole('button', { name: /저장한 기회/ }).click()
    await waitForSavedCommit(page)
    await page.reload()
    await expect(page.locator('.saved-card')).toHaveCount(2)
    const expected = records.map(record => ({ ...record, job: upgradeJobEligibility(record.job) }))
    expect(await readSaved(page)).toEqual(expected)
    await expect(page.locator('.saved-card').filter({ hasText: jobs[1].title }).locator('.eligibility-notice')).toHaveText(transferNotice)
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
      '근무지': 'Paris or London', '비자 지원': '지원 명시', '메모': records[0].note,
      '상태': '지원 완료', '저장일': SEARCH_TIME, '내용 비교': '표시 내용 일치',
    })
    expect(exported[0]['취업 자격 근거']).toContain(INTERNSHIP_SPONSORSHIP)
    expect(exported[1]).toMatchObject({
      '비자 지원': '조건부 지원 명시', '메모': records[1].note, '상태': '지원 완료',
      '저장일': SEARCH_TIME, '내용 비교': '표시 내용 일치', '취업 자격 근거': TRANSFER_SPONSORSHIP,
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
      expect(request.url).not.toMatch(/private-sponsorship|2501|2502|2503|Seoul|Korea/)
    }
    expect(errors).toEqual([])
  })
}
