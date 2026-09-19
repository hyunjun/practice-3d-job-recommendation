import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { readFile } from 'node:fs/promises'
import { normalizeJob } from '../../server/normalize'
import { createJobRevision } from '../../shared/posting-status'
import type { PostingStatusIndex } from '../../shared/posting-status'
import { DEFAULT_FILTERS } from '../../shared/types'
import type { Catalog, Job } from '../../shared/types'
import { SEARCH_COMPANIES, SEARCH_PROFILE, SEARCH_TIME, searchCatalog, searchJob } from '../fixtures/search-catalog'

const company = SEARCH_COMPANIES[0]
const researchDuty = 'Develop and evaluate large language models for retrieval.'
function researchPosting(duty = researchDuty): Job {
  return normalizeJob({
    id: 901, title: 'Applied Scientist', absolute_url: 'https://example.com/jobs/research',
    location: { name: 'London, UK' }, departments: [{ name: 'Science' }],
    content: `<h2>About Example</h2><p>We build full stack applications.</p><h2>Responsibilities</h2><p>${duty}</p><h2>Requirements</h2><p>Experience with Python and software engineering.</p>`,
  }, company.id, SEARCH_TIME)!
}
const researcher = researchPosting()
const developer = normalizeJob({
  id: 902, title: 'Full Stack Engineer, Support Experience', absolute_url: 'https://example.com/jobs/support-product',
  location: { name: 'London, UK' }, departments: [{ name: 'Support Products - Eng' }],
  content: '<h2>Responsibilities</h2><p>Build services and user interfaces for our support products.</p><h2>Requirements</h2><p>Experience with TypeScript.</p>',
}, company.id, SEARCH_TIME)!
const legacySupport = searchJob('support-scope', {
  title: 'Technical Services Engineer', role: 'fullstack', roleClassification: undefined,
  description: 'Responsibilities\nProvide technical support and troubleshoot customer database issues.\nBuild software tools to help our support queue.',
})

async function restore(page: Page, catalog: Catalog) {
  await page.clock.install({ time: new Date(Date.parse(SEARCH_TIME) + 10_000) })
  await page.route('**/api/catalog?source=public*', route => route.fulfill({ json: catalog }))
  await page.addInitScript(({ profile, filters }) => {
    if (!localStorage.getItem('orbit.v1.profile')) localStorage.setItem('orbit.v1.profile', JSON.stringify(profile))
    if (!localStorage.getItem('orbit.v1.exploration')) localStorage.setItem('orbit.v1.exploration', JSON.stringify({
      source: 'public', filters, selectedId: 'london', panelTab: 'cities', mapMode: 'flat',
    }))
  }, { profile: { ...SEARCH_PROFILE, skills: ['Python', 'TypeScript'] }, filters: { ...DEFAULT_FILTERS, role: 'ml' } })
  await page.goto('/')
}

const savedMenu = (page: Page) => page.getByRole('navigation', { name: '주요 메뉴' }).getByRole('button', { name: /저장한 기회/ })
async function postingIndex(): Promise<PostingStatusIndex> {
  return {
    version: 1, checkedAt: SEARCH_TIME, refreshAfter: new Date(Date.parse(SEARCH_TIME) + 60_000).toISOString(),
    boards: [{
      companyId: company.id, provider: 'greenhouse', board: company.board!,
      checkedAt: SEARCH_TIME, lastSuccessAt: SEARCH_TIME, retryAt: null, status: 'ok',
      listing: {
        validUntil: new Date(Date.parse(SEARCH_TIME) + 30 * 60_000).toISOString(),
        publishedIds: [researcher.id, developer.id, legacySupport.id],
        jobs: await Promise.all([researcher, developer].map(async job => ({
          id: job.id, title: job.title, url: job.url, revision: await createJobRevision(job),
        }))),
      },
    }],
  }
}

test('research duties drive the ML filter and survive saving, reload, posting comparison and CSV', async ({ page }) => {
  const index = await postingIndex()
  await page.route('**/api/posting-status*', route => route.fulfill({ json: index }))
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await restore(page, searchCatalog([researcher, developer, legacySupport]))
  await expect(page.locator('.mini-job-title')).toHaveText(researcher.title)
  await expect(page.locator('.city-detail-count strong')).toHaveText(['1', '1'])
  await expect(page.locator('.mini-job-role')).toHaveText('AI · 머신러닝')
  await page.getByLabel('직무 필터', { exact: true }).selectOption('all')
  await expect(page.locator('.city-detail-count strong')).toHaveText(['1', '2'])
  await expect(page.locator('.mini-job-title')).not.toContainText(legacySupport.title)
  await page.getByLabel('직무 필터', { exact: true }).selectOption('ml')
  await page.locator('.mini-job-title').click()
  const classification = page.getByRole('region', { name: '직무 분류', exact: true })
  await expect(classification).toContainText('연구 업무·자격 항목의 AI·머신러닝 근거')
  await classification.getByText('직무 분류에 사용한 원문', { exact: true }).click()
  await expect(classification.locator('.qualification-evidence:not(.occupation-evidence) blockquote')).toHaveText(`Responsibilities\n${researchDuty}`)
  await classification.getByText('탐색 직군을 판단한 원문', { exact: true }).click()
  await expect(classification.locator('.occupation-evidence')).toContainText(researchDuty)
  await expect(classification).toContainText('컴퓨터·AI 연구')
  await page.getByRole('button', { name: '기회 저장', exact: true }).click()
  await page.getByLabel('이 기회에 대한 나의 메모').fill('private-research-note')
  await page.getByRole('button', { name: '지원 완료로 표시', exact: true }).click()
  await page.getByRole('button', { name: '닫기', exact: true }).click()
  await page.reload()
  await savedMenu(page).click()
  await expect(page.locator('.saved-card')).toHaveCount(1)
  await expect(page.locator('.saved-role')).toHaveText('AI · 머신러닝')
  await expect(page.locator('.saved-note-preview')).toHaveText('private-research-note')
  await expect(page.locator('.saved-status')).toHaveText('지원 완료')
  await page.getByRole('button', { name: '게시 상태 확인', exact: true }).click()
  await expect(page.locator('.posting-notice.listed')).toHaveCount(1)
  await expect(page.locator('.posting-notice.changed')).toHaveCount(0)
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('orbit.v1.saved')!))
  expect(saved[0]).toMatchObject({
    note: 'private-research-note', status: 'applied',
    job: { id: researcher.id, fetchedAt: SEARCH_TIME, occupation: { category: 'research' }, role: 'ml' },
  })
  const download = page.waitForEvent('download')
  await page.getByRole('button', { name: 'CSV 내보내기', exact: true }).click()
  const csv = await readFile((await (await download).path())!, 'utf8')
  for (const text of ['탐색 직군', '탐색 직군 근거', '컴퓨터·AI 연구', '연구 업무·자격 원문', researchDuty, 'private-research-note', '표시 내용 일치']) expect(csv).toContain(text)
  expect(errors).toEqual([])
})

test('an old out-of-scope saved posting remains readable and listed without sending the saved record to the server', async ({ page }) => {
  const savedAt = '2026-09-19T08:01:00.000Z'
  await page.addInitScript(({ job, company, savedAt }) => {
    if (!localStorage.getItem('orbit.v1.saved')) localStorage.setItem('orbit.v1.saved', JSON.stringify([
      { job, company, savedAt, status: 'applied', note: 'private-scope-note' },
    ]))
  }, { job: legacySupport, company, savedAt })
  const requests: { url: string; body: string | null }[] = []
  page.on('request', request => { if (request.url().includes('/api/')) requests.push({ url: request.url(), body: request.postData() }) })
  const index = await postingIndex()
  await page.route('**/api/posting-status*', route => route.fulfill({ json: index }))
  await restore(page, searchCatalog([researcher, developer, legacySupport]))
  await savedMenu(page).click()
  await expect(page.locator('.saved-card')).toHaveCount(1)
  await expect(page.locator('.occupation-notice')).toContainText('현재 탐색 범위 밖 · 고객 지원·솔루션')
  await expect(page.locator('.saved-note-preview')).toHaveText('private-scope-note')
  await page.getByRole('button', { name: '게시 상태 확인', exact: true }).click()
  await expect(page.locator('.posting-notice.listed')).toContainText('게시판에는 있지만 현재 탐색 범위 밖')
  await page.locator('.saved-title').click()
  await expect(page.locator('.job-dialog .occupation-notice')).toContainText('채용 종료를 뜻하지 않으며')
  await page.getByText('탐색 직군을 판단한 원문', { exact: true }).click()
  await expect(page.locator('.occupation-evidence')).toContainText('Provide technical support')
  await expect(page.getByLabel('이 기회에 대한 나의 메모')).toHaveValue('private-scope-note')
  await expect(page.getByRole('button', { name: '지원 완료로 표시됨', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '닫기', exact: true }).click()
  await page.reload()
  await savedMenu(page).click()
  await expect(page.locator('.occupation-notice')).toContainText('현재 탐색 범위 밖')
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('orbit.v1.saved')!))
  expect(saved[0]).toMatchObject({ savedAt, status: 'applied', note: 'private-scope-note', job: { id: legacySupport.id, fetchedAt: SEARCH_TIME, occupation: { category: 'support' } } })
  const download = page.waitForEvent('download')
  await page.getByRole('button', { name: 'CSV 내보내기', exact: true }).click()
  expect(await readFile((await (await download).path())!, 'utf8')).toContain('고객 지원·솔루션')
  for (const request of requests) {
    const url = new URL(request.url)
    expect(['/api/catalog', '/api/posting-status']).toContain(url.pathname)
    expect([...url.searchParams.keys()].every(key => key === 'source' || key === 'refresh')).toBe(true)
    expect(request.body).toBeNull()
    expect(request.url).not.toMatch(/private-scope|support-scope|Python/)
  }
})

test('long research evidence and preserved out-of-scope notices remain accessible at 320px', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 900 })
  const duty = `Develop large language models for ${'EvaluationDataset'.repeat(100)}.`
  await page.addInitScript(({ job, company }) => {
    localStorage.setItem('orbit.v1.saved', JSON.stringify([{ job, company, savedAt: job.fetchedAt, status: 'saved', note: '' }]))
  }, { job: legacySupport, company })
  await restore(page, searchCatalog([researchPosting(duty)]))
  await page.locator('.mini-job-title').click()
  await page.getByText('직무 분류에 사용한 원문', { exact: true }).click()
  await page.getByText('탐색 직군을 판단한 원문', { exact: true }).click()
  await expect(page.locator('.occupation-evidence')).toContainText(duty)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  expect((await new AxeBuilder({ page }).include('.job-dialog').analyze()).violations).toEqual([])
  await page.getByRole('button', { name: '닫기', exact: true }).click()
  await savedMenu(page).click()
  await expect(page.locator('.occupation-notice')).toBeVisible()
  expect((await new AxeBuilder({ page }).include('.collection-page').analyze()).violations).toEqual([])
  await page.locator('.saved-title').click()
  await page.getByText('탐색 직군을 판단한 원문', { exact: true }).click()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  expect((await new AxeBuilder({ page }).include('.job-dialog').analyze()).violations).toEqual([])
})
