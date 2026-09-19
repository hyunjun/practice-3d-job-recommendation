import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { readFile } from 'node:fs/promises'
import { normalizeJob } from '../../server/normalize'
import { createJobRevision } from '../../shared/posting-status'
import type { PostingStatusIndex } from '../../shared/posting-status'
import { DEFAULT_FILTERS } from '../../shared/types'
import type { Catalog, Filters, Job } from '../../shared/types'
import { SEARCH_COMPANIES, SEARCH_PROFILE, SEARCH_TIME, searchCatalog } from '../fixtures/search-catalog'

function posting(id: number, title: string, departments: string[] = []): Job {
  return normalizeJob({
    id, title, departments: departments.map(name => ({ name })),
    absolute_url: `https://example.com/jobs/${id}`, location: { name: 'London, UK' },
    content: '<h2>Requirements</h2><p>Experience with TypeScript.</p>',
  }, SEARCH_COMPANIES[0].id, SEARCH_TIME)!
}
const generic = posting(1, 'Software Engineer — Product', ['Engineering'])
const fullstack = posting(2, 'Full Stack Engineer')
const combined = posting(3, 'Applied AI, Fullstack Engineer')
const web = posting(4, 'Backend / Frontend Engineer')
const department = posting(5, 'Software Engineer — Reporting', ['Data Engineering'])

async function restore(page: Page, catalog: Catalog, filters: Filters) {
  await page.clock.install({ time: new Date(Date.parse(SEARCH_TIME) + 10_000) })
  await page.route('**/api/catalog?source=public*', route => route.fulfill({ json: catalog }))
  await page.addInitScript(({ profile, filters }) => {
    if (!localStorage.getItem('orbit.v1.profile')) localStorage.setItem('orbit.v1.profile', JSON.stringify(profile))
    if (!localStorage.getItem('orbit.v1.exploration')) localStorage.setItem('orbit.v1.exploration', JSON.stringify({
      source: 'public', filters, selectedId: 'london', panelTab: 'cities', mapMode: 'flat',
    }))
  }, { profile: SEARCH_PROFILE, filters })
  await page.goto('/')
}

const stored = (page: Page) => page.evaluate(() => JSON.parse(localStorage.getItem('orbit.v1.exploration') || '{}'))
async function postingIndex(jobs: Job[]): Promise<PostingStatusIndex> {
  return {
    version: 1, checkedAt: SEARCH_TIME, refreshAfter: new Date(Date.parse(SEARCH_TIME) + 60_000).toISOString(),
    boards: [{
      companyId: SEARCH_COMPANIES[0].id, provider: 'greenhouse', board: SEARCH_COMPANIES[0].board!,
      checkedAt: SEARCH_TIME, lastSuccessAt: SEARCH_TIME, retryAt: null, status: 'ok',
      listing: {
        validUntil: new Date(Date.parse(SEARCH_TIME) + 30 * 60_000).toISOString(),
        publishedIds: jobs.map(job => job.id),
        jobs: await Promise.all(jobs.map(async job => ({ id: job.id, title: job.title, url: job.url, revision: await createJobRevision(job) }))),
      },
    }],
  }
}

test('specific role filters use published evidence, retain multi-role jobs and keep company counts unique', async ({ page }) => {
  await restore(page, searchCatalog([generic, fullstack, combined, web, department]), { ...DEFAULT_FILTERS, role: 'fullstack' })
  await expect(page.locator('.city-detail-count strong')).toHaveText(['1', '2'])
  await expect(page.locator('.active-filter-summary')).toContainText('직무 미확인 공고 제외')
  await expect(page.locator('.mini-job-title')).not.toContainText('Software Engineer — Product')
  await page.getByLabel('직무 필터', { exact: true }).selectOption('ml')
  await expect(page.locator('.city-detail-count strong')).toHaveText(['1', '1'])
  await expect(page.locator('.mini-job-title')).toHaveText(combined.title)
  await expect(page.locator('.mini-job-role')).toHaveText('풀스택 · AI · 머신러닝')
  for (const role of ['frontend', 'backend']) {
    await page.getByLabel('직무 필터', { exact: true }).selectOption(role)
    await expect(page.locator('.mini-job-title')).toHaveText(web.title)
    await expect(page.locator('.city-detail-count strong')).toHaveText(['1', '1'])
  }
  await page.getByLabel('직무 필터', { exact: true }).selectOption('unknown')
  await expect(page.locator('.mini-job-title')).toHaveText(generic.title)
  await expect(page.locator('.mini-job-role')).toHaveText('세부 직무 미확인')
  await page.getByLabel('직무 필터', { exact: true }).selectOption('data')
  await expect(page.locator('.mini-job-title')).toHaveText(department.title)
  await page.locator('.mini-job-title').click()
  const detail = page.getByRole('region', { name: '직무 분류', exact: true })
  await expect(detail).toContainText('데이터 엔지니어링')
  await detail.locator('summary').click()
  await expect(detail.locator('blockquote')).toHaveText('Data Engineering')
  await expect(detail).toContainText('공개 부서·팀')
  await page.getByRole('button', { name: '닫기', exact: true }).click()
  await page.getByLabel('직무 필터', { exact: true }).selectOption('all')
  await expect(page.locator('.city-detail-count strong')).toHaveText(['1', '5'])
  await expect(page.locator('.map-stats strong')).toHaveText(['1곳', '1곳'])
})

test('legacy unknown roles and new evidence survive saving, reload, local searching, posting comparison and CSV export', async ({ page }) => {
  const legacy = { ...generic, role: 'fullstack' as const, roleClassification: undefined }
  const savedAt = '2026-09-19T08:01:00.000Z'
  await page.addInitScript(({ job, company, savedAt }) => {
    if (!localStorage.getItem('orbit.v1.saved')) localStorage.setItem('orbit.v1.saved', JSON.stringify([
      { job, company, savedAt, status: 'applied', note: 'private-role-note' },
    ]))
  }, { job: legacy, company: SEARCH_COMPANIES[0], savedAt })
  const requests: { url: string; body: string | null }[] = []
  page.on('request', request => { if (request.url().includes('/api/')) requests.push({ url: request.url(), body: request.postData() }) })
  const index = await postingIndex([generic, department])
  await page.route('**/api/posting-status*', route => route.fulfill({ json: index }))
  await restore(page, searchCatalog([legacy, department]), { ...DEFAULT_FILTERS, role: 'unknown' })
  await expect(page.locator('.mini-job-role')).toHaveText('세부 직무 미확인')
  await page.locator('.mini-job-title').click()
  await expect(page.getByLabel('직무 분류', { exact: true })).toContainText('세부 직무 미확인')
  await expect(page.getByLabel('이 기회에 대한 나의 메모')).toHaveValue('private-role-note')
  await expect(page.getByRole('button', { name: '지원 완료로 표시됨', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '닫기', exact: true }).click()
  await page.getByLabel('직무 필터', { exact: true }).selectOption('data')
  await page.locator('.mini-job-title').click()
  await page.getByRole('button', { name: '기회 저장', exact: true }).click()
  await page.getByRole('button', { name: '닫기', exact: true }).click()
  await page.getByLabel('직무 필터', { exact: true }).selectOption('unknown')
  await page.reload()
  await expect(page.getByLabel('직무 필터', { exact: true })).toHaveValue('unknown')
  expect((await stored(page)).filters.role).toBe('unknown')
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('orbit.v1.profile')!).desiredRole)).toBe('backend')
  await page.getByRole('navigation', { name: '주요 메뉴' }).getByRole('button', { name: /저장한 기회/ }).click()
  await expect(page.locator('.saved-card')).toHaveCount(2)
  await page.getByRole('button', { name: '게시 상태 확인', exact: true }).click()
  await expect(page.locator('.posting-notice.listed')).toHaveCount(2)
  await expect(page.locator('.posting-notice.changed')).toHaveCount(0)
  await page.getByLabel('저장한 기회 검색', { exact: true }).fill('세부 직무 미확인')
  await expect(page.locator('.saved-card')).toHaveCount(1)
  await expect(page.locator('.saved-status')).toHaveText('지원 완료')
  await expect(page.locator('.saved-note-preview')).toHaveText('private-role-note')
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('orbit.v1.saved')!))
  expect(saved.find((item: { job: Job }) => item.job.id === generic.id)).toMatchObject({ savedAt, status: 'applied', note: 'private-role-note', job: { role: 'unknown', fetchedAt: SEARCH_TIME } })
  await page.getByLabel('저장한 기회 검색', { exact: true }).fill('데이터 엔지니어링')
  await expect(page.locator('.saved-card')).toHaveCount(1)
  await page.locator('.saved-title').click()
  await page.getByLabel('직무 분류', { exact: true }).locator('summary').click()
  await expect(page.getByLabel('직무 분류', { exact: true }).locator('blockquote')).toHaveText('Data Engineering')
  await page.getByRole('button', { name: '닫기', exact: true }).click()
  const download = page.waitForEvent('download')
  await page.getByRole('button', { name: 'CSV 내보내기', exact: true }).click()
  const csv = await readFile((await (await download).path())!, 'utf8')
  for (const text of ['직무 분류', '직무 분류 근거', '세부 직무 미확인', 'Data Engineering', 'private-role-note', savedAt, '표시 내용 일치']) expect(csv).toContain(text)
  for (const request of requests) {
    const url = new URL(request.url)
    expect(['/api/catalog', '/api/posting-status']).toContain(url.pathname)
    expect([...url.searchParams.keys()].every(key => key === 'source' || key === 'refresh')).toBe(true)
    expect(request.body).toBeNull()
    expect(request.url).not.toMatch(/private-role|Reporting|Software|TypeScript/)
  }
})

test('role recovery remains explicit and accessible at 320px with long department evidence', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 900 })
  const longDepartment = `Data Engineering — ${'DepartmentIdentifier'.repeat(40)}`
  const job = posting(9, 'Software Engineer', [longDepartment])
  const filters = { ...DEFAULT_FILTERS, role: 'fullstack' as const }
  await restore(page, searchCatalog([job]), filters)
  await expect(page.locator('.recovery-option dt')).toHaveText('직무')
  await expect(page.locator('.recovery-option button')).toHaveText('회사 1곳 · 공고 1개 보기')
  expect((await stored(page)).filters).toEqual(filters)
  await page.locator('.recovery-option button').focus()
  await page.locator('.recovery-option button').press('Enter')
  await expect(page.locator('.results-panel')).toBeFocused()
  await expect(page.locator('.mini-job-role')).toHaveText('데이터 엔지니어링')
  await page.getByRole('button', { name: '실행 취소', exact: true }).click()
  await expect(page.getByLabel('직무 필터', { exact: true })).toHaveValue('fullstack')
  await page.getByLabel('직무 필터', { exact: true }).selectOption('unknown')
  await expect(page.locator('.recovery-option')).toContainText('세부 직무 미확인')
  await page.locator('.recovery-option button').click()
  await page.locator('.mini-job-title').click()
  await page.getByLabel('직무 분류', { exact: true }).locator('summary').click()
  await expect(page.getByLabel('직무 분류', { exact: true }).locator('blockquote')).toHaveText(longDepartment)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  expect((await new AxeBuilder({ page }).include('.job-dialog').analyze()).violations).toEqual([])
  await page.getByRole('button', { name: '닫기', exact: true }).click()
  await page.getByRole('button', { name: /모든 필터/ }).click()
  await page.getByLabel('직무', { exact: true }).selectOption('unknown')
  await expect(page.locator('#filter-role-help')).toContainText('프로필의 기술 조건')
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  expect((await new AxeBuilder({ page }).include('.filters-dialog').analyze()).violations).toEqual([])
})
