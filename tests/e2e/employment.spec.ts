import { expect, test } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { readFile } from 'node:fs/promises'
import { normalizeJob } from '../../server/normalize'
import { upgradeJobEmployment } from '../../shared/job-employment'
import { createJobRevision } from '../../shared/posting-status'
import { DEFAULT_FILTERS } from '../../shared/types'
import type { Filters, SavedJob } from '../../shared/types'
import { employmentPosting, legacyEmploymentJob, MENTORING_BODY } from '../fixtures/employment'
import { SEARCH_COMPANIES, SEARCH_PROFILE, SEARCH_TIME, searchCatalog } from '../fixtures/search-catalog'
import { expectInitialCatalogRequest, watchApiRequests } from './helpers/api-requests'
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
  test(`employment qualifiers survive legacy filters, saved records and exports at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 960 })
    await page.clock.install({ time: new Date(Date.parse(SEARCH_TIME) + 10_000) })
    const company = SEARCH_COMPANIES[0]
    const freshJobs = [
      employmentPosting(),
      employmentPosting(30002, 'Software Engineer - Developer Tools', MENTORING_BODY),
      employmentPosting(30003, 'Software Engineer (Contract)'),
      employmentPosting(30004, 'Software Engineer Intern'),
    ].map(raw => normalizeJob(raw, company.id, SEARCH_TIME)!)
    // Exercise both API compatibility and the old localStorage-to-IndexedDB migration.
    const jobs = [legacyEmploymentJob('title'), legacyEmploymentJob('description'), ...freshJobs.slice(2)]
    const records: SavedJob[] = jobs.slice(0, 2).map((job, index) => ({
      job, company, savedAt: SEARCH_TIME, status: index ? 'saved' : 'applied', note: `private-employment-note-${index}`,
    }))
    await page.addInitScript(({ records, profile, filters }) => {
      if (sessionStorage.getItem('employment-seeded')) return
      localStorage.setItem('orbit.v1.saved', JSON.stringify(records))
      localStorage.setItem('orbit.v1.profile', JSON.stringify(profile))
      localStorage.setItem('orbit.v1.exploration', JSON.stringify({
        source: 'public', mapMode: 'flat', selectedId: 'london', panelTab: 'cities', filters,
      }))
      sessionStorage.setItem('employment-seeded', 'true')
    }, { records, profile: { ...SEARCH_PROFILE, desiredRole: 'all', skills: [] }, filters: DEFAULT_FILTERS })
    await page.route('**/api/catalog?source=public*', route => route.fulfill({ json: searchCatalog(jobs) }))
    const index = {
      version: 1, checkedAt: SEARCH_TIME, refreshAfter: new Date(Date.parse(SEARCH_TIME) + 60_000).toISOString(),
      boards: [{
        companyId: company.id, provider: company.provider, board: company.board, status: 'ok',
        checkedAt: SEARCH_TIME, lastSuccessAt: SEARCH_TIME, retryAt: null,
        listing: {
          validUntil: new Date(Date.parse(SEARCH_TIME) + 30 * 60_000).toISOString(),
          publishedIds: jobs.map(job => job.id),
          jobs: await Promise.all(freshJobs.map(async job => ({
            id: job.id, title: job.title, url: job.url, revision: await createJobRevision(job),
          }))),
        },
      }],
    }
    await page.route('**/api/posting-status*', route => route.fulfill({ json: index }))
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    const traffic = watchApiRequests(page)
    await page.goto('/')
    const initial = await expectInitialCatalogRequest(page, traffic)
    await waitForSavedCommit(page)

    const filterEmployment = async (value: Filters['employment'], title: string) => {
      await page.getByRole('button', { name: /^모든 필터/ }).click()
      await page.getByLabel('고용 형태', { exact: true }).selectOption(value)
      await page.getByRole('button', { name: '1개 공고 보기', exact: true }).click()
      await expect(page.locator('.mini-job-title')).toHaveText(title)
    }
    await filterEmployment('contract', jobs[2].title)
    await filterEmployment('intern', jobs[3].title)
    await filterEmployment('fulltime', jobs[1].title)
    await page.locator('.mini-job-title').click()
    await expect(page.locator('.job-meta-pills > span').first()).toHaveText('풀타임')
    await page.locator('.job-evidence summary').click()
    await expect(page.locator('.job-evidence dl > div').filter({ hasText: '고용 형태' }).locator('blockquote')).toHaveText(MENTORING_BODY)
    await expect(page.getByLabel('이 기회에 대한 나의 메모')).toHaveValue(records[1].note)
    records[1].note = 'Updated private-employment-note: confirm the role’s employment terms'
    records[1].status = 'applied'
    await page.getByLabel('이 기회에 대한 나의 메모').fill(records[1].note)
    await page.getByRole('button', { name: '지원 완료로 표시', exact: true }).click()
    expect(await page.locator('.dialog').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
    expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze()).violations).toEqual([])
    await page.getByRole('button', { name: '닫기', exact: true }).click()

    await filterEmployment('unknown', jobs[0].title)
    await page.locator('.mini-job-title').click()
    await expect(page.locator('.job-meta-pills > span').first()).toHaveText('고용 형태 미확인')
    await expect(page.locator('.job-evidence dl > div').filter({ hasText: '고용 형태' })).toHaveCount(0)
    await expect(page.getByLabel('이 기회에 대한 나의 메모')).toHaveValue(records[0].note)
    await expect(page.getByRole('button', { name: '지원 완료로 표시됨', exact: true })).toBeVisible()
    expect(await page.locator('.dialog').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
    await page.getByRole('button', { name: '닫기', exact: true }).click()
    expect(traffic.requests).toHaveLength(initial.attempts)

    await page.getByRole('navigation', { name: '주요 메뉴' }).getByRole('button', { name: /저장한 기회/ }).click()
    await waitForSavedCommit(page)
    await page.reload()
    await expect(page.locator('.saved-card')).toHaveCount(2)
    const expected = records.map(record => ({ ...record, job: upgradeJobEmployment(record.job) }))
    expect(await readSaved(page)).toEqual(expected)
    await page.getByRole('button', { name: '게시 상태 확인', exact: true }).click()
    await expect(page.locator('.posting-notice.listed')).toHaveCount(2)
    await expect(page.locator('.posting-notice.changed, .posting-notice.missing')).toHaveCount(0)
    expect(await readSaved(page)).toEqual(expected)
    expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze()).violations).toEqual([])
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)

    const csvDownload = page.waitForEvent('download')
    await page.getByRole('button', { name: 'CSV 내보내기', exact: true }).click()
    const exported = csvRecords(await readFile((await (await csvDownload).path())!, 'utf8'))
    for (let i = 0; i < records.length; i++) {
      expect(exported[i]).toMatchObject({
        '포지션': jobs[i].title, '메모': records[i].note, '상태': '지원 완료',
        '저장일': SEARCH_TIME, '저장 내용의 조회 시각': SEARCH_TIME, '내용 비교': '표시 내용 일치',
      })
    }
    expect(exported[0]).toMatchObject({ '고용 형태': '고용 형태 미확인', '고용 형태 근거': '' })
    expect(exported[1]).toMatchObject({ '고용 형태': '풀타임', '고용 형태 근거': `공고 본문\n${MENTORING_BODY}` })
    await page.getByRole('button', { name: '기록 백업·복원', exact: true }).click()
    const backupDownload = page.waitForEvent('download')
    await page.getByRole('button', { name: 'JSON 백업', exact: true }).click()
    expect(JSON.parse(await readFile((await (await backupDownload).path())!, 'utf8')).records).toEqual(expected)
    await page.getByRole('button', { name: '완료', exact: true }).click()

    for (const request of traffic.requests) {
      const url = new URL(request.url)
      expect(['/api/catalog?source=public', '/api/posting-status?refresh=1']).toContain(`${url.pathname}${url.search}`)
      expect(request.method).toBe('GET')
      expect(request.body).toBeNull()
      expect(request.url).not.toMatch(/private-employment|30001|30002|30003|30004|Search%20fixture/)
    }
    expect(errors).toEqual([])
  })
}
