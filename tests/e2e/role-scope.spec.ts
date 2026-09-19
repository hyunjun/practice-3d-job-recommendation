import { expect, test } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { readFile } from 'node:fs/promises'
import { normalizeJob } from '../../server/normalize'
import { jobOccupationLabel, upgradeJobOccupation } from '../../shared/job-occupation'
import { createJobRevision } from '../../shared/posting-status'
import { DEFAULT_FILTERS } from '../../shared/types'
import type { SavedJob } from '../../shared/types'
import { OUTSIDE_ROLES, outsideRoleJob } from '../fixtures/outside-roles'
import { SEARCH_COMPANIES, SEARCH_PROFILE, SEARCH_TIME, searchCatalog } from '../fixtures/search-catalog'
import { readSaved, waitForSavedCommit } from './helpers/saved-store'

// The export quotes every field, including embedded commas, quotes and newlines.
function csvRecords(text: string): Record<string, string>[] {
  const cells = (value: string) => [...value.matchAll(/"((?:[^"]|"")*)"(?:,|\r\n|$)/g)].map(match => match[1].replaceAll('""', '"'))
  const headers = cells(text.slice(0, text.indexOf('\r\n')))
  const values = cells(text).slice(headers.length)
  expect(values.length % headers.length).toBe(0)
  return Array.from({ length: values.length / headers.length }, (_, index) =>
    Object.fromEntries(headers.map((header, column) => [header, values[index * headers.length + column]])))
}

for (const width of [1440, 320]) {
  test(`saved role labels, search, explanations and exports follow occupation scope at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 960 })
    await page.clock.install({ time: new Date(Date.parse(SEARCH_TIME) + 10_000) })
    const company = SEARCH_COMPANIES[0]
    const engineer = normalizeJob({
      id: 2999, title: 'Infrastructure Engineer', absolute_url: 'https://example.com/saved-scope/engineer',
      location: { name: 'London, UK' }, content: '<h2>Requirements</h2><p>Experience with TypeScript.</p>',
    }, company.id, SEARCH_TIME)!
    const outside = OUTSIDE_ROLES.map((_, index) => outsideRoleJob(index, 2, index === 4 ? 'Contact the publisher for the full requirements.' : undefined))
    const longDepartment = `Engineering & Infra · ${'OriginalWriterTeam'.repeat(35)}`
    outside[0].occupation!.departments = [longDepartment]
    outside[0].roleClassification!.evidence[0].text = longDepartment
    const records: SavedJob[] = [...outside, engineer].map((job, index) => ({
      job, company, savedAt: SEARCH_TIME, status: index % 2 ? 'saved' : 'applied',
      note: `private-role-scope-note-${index}`,
    }))
    await page.addInitScript(({ records, profile, filters }) => {
      if (sessionStorage.getItem('role-scope-seeded')) return
      localStorage.setItem('orbit.v1.saved', JSON.stringify(records))
      localStorage.setItem('orbit.v1.profile', JSON.stringify(profile))
      localStorage.setItem('orbit.v1.exploration', JSON.stringify({ source: 'public', mapMode: 'flat', selectedId: 'london', panelTab: 'cities', filters }))
      sessionStorage.setItem('role-scope-seeded', 'true')
    }, { records, profile: { ...SEARCH_PROFILE, desiredRole: 'devops', skills: ['TypeScript'] }, filters: DEFAULT_FILTERS })
    await page.route('**/api/catalog?source=public*', route => route.fulfill({ json: searchCatalog([engineer]) }))
    const index = {
      version: 1, checkedAt: SEARCH_TIME, refreshAfter: new Date(Date.parse(SEARCH_TIME) + 60_000).toISOString(),
      boards: [{
        companyId: company.id, provider: 'greenhouse', board: company.board, status: 'ok',
        checkedAt: SEARCH_TIME, lastSuccessAt: SEARCH_TIME, retryAt: null,
        listing: {
          validUntil: new Date(Date.parse(SEARCH_TIME) + 30 * 60_000).toISOString(),
          publishedIds: records.map(record => record.job.id),
          jobs: [{ id: engineer.id, title: engineer.title, url: engineer.url, revision: await createJobRevision(engineer) }],
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
    await page.goto('/#saved')
    await waitForSavedCommit(page)
    await expect(page.locator('.saved-card')).toHaveCount(6)
    for (const job of outside) {
      const card = page.locator('.saved-card').filter({ has: page.getByRole('button', { name: job.title, exact: true }) })
      await expect(card.locator('.saved-role')).toHaveText(jobOccupationLabel(job))
    }
    const search = page.getByRole('textbox', { name: '저장한 기회 검색', exact: true })
    await search.fill('인프라')
    await expect(page.locator('.saved-title')).toHaveText(engineer.title)
    await search.fill('고객 지원')
    await expect(page.locator('.saved-title')).toHaveText(outside[1].title)
    await search.fill('기타 직군')
    await expect(page.locator('.saved-card')).toHaveCount(2)
    await search.fill('')
    await page.getByRole('button', { name: '게시 상태 확인', exact: true }).click()
    await expect(page.locator('.posting-notice.listed')).toHaveCount(6)
    await expect(page.locator('.posting-notice.changed, .posting-notice.missing')).toHaveCount(0)
    expect((await new AxeBuilder({ page }).include('.collection-page').analyze()).violations).toEqual([])
    for (const [position, job] of outside.entries()) {
      await page.getByRole('button', { name: job.title, exact: true }).click()
      const detail = page.getByRole('region', { name: '직무 분류', exact: true })
      await expect(detail.locator(':scope > strong')).toHaveText(jobOccupationLabel(job))
      await expect(detail).toContainText('공개 부서·팀:')
      await expect(detail.getByText('직무 분류에 사용한 원문', { exact: true })).toHaveCount(0)
      await detail.getByText('탐색 직군을 판단한 원문', { exact: true }).click()
      await expect(detail.locator('.occupation-evidence')).toContainText(job.title)
      const comparison = page.locator('.match-section:not(.caution)')
      await expect(comparison).toContainText('입력 정보와 공고의 조건')
      await expect(comparison).not.toContainText('희망하는')
      await expect(comparison).not.toContainText('현재 탐색 조건에 포함된 공고예요')
      await expect(comparison).toContainText(position === 4 ? '현재 입력 정보에서 공고와 연결되는 조건을 확인하지 못했어요' : 'TypeScript')
      await expect(page.getByLabel('이 기회에 대한 나의 메모')).toHaveValue(records[position].note)
      if (position === 0) {
        await expect(detail).toContainText(longDepartment)
        expect(await detail.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
        expect((await new AxeBuilder({ page }).include('.job-dialog').analyze()).violations).toEqual([])
        records[0].note = 'Updated private-role-scope-note'
        records[0].status = 'saved'
        await page.getByLabel('이 기회에 대한 나의 메모').fill(records[0].note)
        await page.getByRole('button', { name: '지원 완료로 표시됨', exact: true }).click()
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      await page.getByRole('button', { name: '닫기', exact: true }).click()
    }
    await page.getByRole('button', { name: engineer.title, exact: true }).click()
    await expect(page.locator('.job-role-details > strong')).toHaveText('인프라 · DevOps')
    await expect(page.locator('.match-section:not(.caution)')).toContainText('희망하는')
    await page.getByRole('button', { name: '닫기', exact: true }).click()
    await waitForSavedCommit(page)
    await page.reload()
    const expected = records.map(record => ({ ...record, job: upgradeJobOccupation(record.job) }))
    expect(await readSaved(page)).toEqual(expected)
    const csvDownload = page.waitForEvent('download')
    await page.getByRole('button', { name: 'CSV 내보내기', exact: true }).click()
    const exported = csvRecords(await readFile((await (await csvDownload).path())!, 'utf8'))
    expect(exported).toHaveLength(6)
    for (const record of records.slice(0, -1)) {
      const row = exported.find(row => row['포지션'] === record.job.title)!
      expect(row['직무 분류']).toBe(jobOccupationLabel(record.job))
      expect(row['직무 분류 근거']).toBe('')
      expect(row['탐색 직군 근거']).toContain(record.job.title)
      expect(row['저장일']).toBe(record.savedAt)
      expect(row['메모']).toBe(record.note)
    }
    expect(exported.find(row => row['포지션'] === engineer.title)?.['직무 분류']).toBe('인프라 · DevOps')
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
      expect(request.url).not.toMatch(/private-role|saved-scope|TypeScript|devops/)
    }
    expect(errors).toEqual([])
  })
}
