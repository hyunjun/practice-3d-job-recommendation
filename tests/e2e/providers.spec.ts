import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { readFile } from 'node:fs/promises'
import { normalizeJob } from '../../server/normalize'
import { normalizeAshbyJob } from '../../server/providers/ashby'
import { normalizeLeverJob } from '../../server/providers/lever'
import { normalizeSmartRecruitersJob } from '../../server/providers/smartrecruiters'
import { CITIES } from '../../shared/cities'
import { PUBLIC_COMPANIES } from '../../shared/companies'
import { createJobRevision } from '../../shared/posting-status'
import type { PostingStatusIndex } from '../../shared/posting-status'
import { DEFAULT_FILTERS } from '../../shared/types'
import type { Catalog, Job, SavedJob } from '../../shared/types'
import { ashbyPosting, leverPosting, POSTING_TIME, smartRecruitersPosting } from '../fixtures/public-postings'

test.beforeEach(async ({ page }) => { await page.clock.setFixedTime(new Date(POSTING_TIME)) })

const ashby = PUBLIC_COMPANIES.find(company => company.id === 'supabase')!
const lever = PUBLIC_COMPANIES.find(company => company.id === 'spotify')!
const stripe = PUBLIC_COMPANIES.find(company => company.id === 'stripe')!
const canva = PUBLIC_COMPANIES.find(company => company.id === 'canva')!
const ashbyJob = normalizeAshbyJob(ashbyPosting({
  compensation: { compensationTiers: [
    { title: 'United Kingdom', components: [{ compensationType: 'Salary', interval: '1 YEAR', currencyCode: 'GBP', minValue: 100000, maxValue: 140000 }] },
    { title: 'Europe', components: [{ compensationType: 'Salary', interval: '1 YEAR', currencyCode: 'EUR', minValue: 90000, maxValue: 130000 }] },
  ] },
}), ashby.id, POSTING_TIME)!
const leverJob = normalizeLeverJob(leverPosting(), lever.id, POSTING_TIME)!
const smartJob = normalizeSmartRecruitersJob(smartRecruitersPosting({
  company: { identifier: canva.board! },
  compensation: { min: 160000, max: 210000, currency: 'AUD', period: 'YEARLY' },
}), canva.id, POSTING_TIME)!
const legacySaved: SavedJob = {
  job: normalizeJob({
    id: 940, title: 'Backend Engineer — saved Greenhouse fixture',
    absolute_url: 'https://example.com/jobs/legacy-saved', location: { name: 'London, UK' },
    content: '<p>5 years of software engineering with Python and AWS.</p>',
  }, stripe.id, POSTING_TIME)!,
  company: stripe, savedAt: POSTING_TIME, status: 'saved', note: 'Existing saved note',
}

function catalog(jobs: Job[] = [ashbyJob, leverJob]): Catalog {
  const companies = PUBLIC_COMPANIES.filter(company => jobs.some(job => job.companyId === company.id))
  return {
    source: 'public', cities: CITIES, companies, jobs, stale: false, fetchedAt: POSTING_TIME, checkedAt: POSTING_TIME, unmappedCount: 0,
    boards: companies.map(company => ({
      companyId: company.id, board: company.board!, provider: company.provider,
      total: jobs.filter(job => job.companyId === company.id).length,
      included: jobs.filter(job => job.companyId === company.id).length,
      status: 'ok', dataStatus: 'fresh', checkedAt: POSTING_TIME, lastSuccessAt: POSTING_TIME,
    })),
  }
}

async function restore(page: Page, data = catalog(), remote = false) {
  await page.route('**/api/catalog?source=public*', route => route.fulfill({ json: data }))
  await page.addInitScript(({ remote, saved, filters }) => {
    if (!localStorage.getItem('orbit.v1.exploration')) localStorage.setItem('orbit.v1.exploration', JSON.stringify({
      source: 'greenhouse', mapMode: 'flat', selectedId: remote ? null : 'london',
      panelTab: remote ? 'remote' : 'cities', filters: remote ? { ...filters, region: 'europe', workMode: 'remote' } : filters,
    }))
    if (!localStorage.getItem('orbit.v1.saved')) localStorage.setItem('orbit.v1.saved', JSON.stringify([saved]))
    if (!localStorage.getItem('orbit.v1.compare')) localStorage.setItem('orbit.v1.compare', JSON.stringify(['london']))
  }, { remote, saved: legacySaved, filters: DEFAULT_FILTERS })
  await page.goto('/')
  await expect(page.getByRole('button', { name: '공개 채용', exact: true })).toBeVisible()
}

test('mixed public sources preserve legacy exploration, saved jobs, conditional pay and CSV provenance', async ({ page }) => {
  await restore(page)
  await expect(page.locator('.company-card')).toHaveCount(2)
  await expect(page.getByRole('button', { name: '2D 지도', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('orbit.v1.exploration') || '{}').source)).toBe('public')
  await page.getByRole('button', { name: '공개 채용', exact: true }).click()
  await expect(page.getByRole('list', { name: '공개 공고 출처' }).locator('li')).toHaveText(['Ashby1개 회사', 'Lever1개 회사'])
  await page.locator('.board-details > summary').click()
  await expect(page.locator('.board-row').filter({ hasText: 'Supabase' })).toContainText('Ashby')
  await expect(page.locator('.board-row').filter({ hasText: 'Spotify' })).toContainText('Lever')
  await page.getByRole('button', { name: '닫기', exact: true }).click()
  await page.locator('.mini-job-title').filter({ hasText: 'Ashby fixture' }).click()
  await expect(page.locator('.job-key-facts')).toContainText('별도 보상 조건')
  await expect(page.locator('.job-compensation')).toHaveAttribute('open', '')
  await expect(page.locator('.job-compensation dd > span')).toHaveText(['GBP 100,000–140,000 / 년', 'EUR 90,000–130,000 / 년'])
  await expect(page.locator('.source-line')).toContainText('Ashby 공개 게시판')
  await expect(page.getByRole('link', { name: '원문에서 지원하기' })).toHaveAttribute('href', ashbyJob.url)
  await page.getByRole('button', { name: '기회 저장', exact: true }).click()
  await page.getByLabel('이 기회에 대한 나의 메모').fill('지역별 보상 조건 확인하기')
  await page.getByRole('button', { name: '닫기', exact: true }).click()
  await page.getByRole('navigation', { name: '주요 메뉴' }).getByRole('button', { name: /저장한 기회/ }).click()
  await page.reload()
  await expect(page.locator('.saved-card')).toHaveCount(2)
  await expect(page.locator('.saved-note-preview')).toContainText(['지역별 보상 조건 확인하기', 'Existing saved note'])
  await page.locator('.saved-title').filter({ hasText: 'Ashby fixture' }).click()
  await expect(page.locator('.job-compensation dd')).toHaveCount(2)
  await expect(page.locator('.source-line')).toContainText('Ashby 공개 게시판')
  await page.getByRole('button', { name: '닫기', exact: true }).click()
  const downloadPromise = page.waitForEvent('download')
  await page.getByRole('button', { name: 'CSV 내보내기', exact: true }).click()
  const csv = await readFile((await (await downloadPromise).path())!, 'utf8')
  for (const value of ['Greenhouse', 'Ashby', '별도 보상 조건', 'United Kingdom: GBP 100,000–140,000 / 년', 'Europe: EUR 90,000–130,000 / 년']) expect(csv).toContain(value)
  const saved = JSON.parse(await page.evaluate(() => localStorage.getItem('orbit.v1.saved')) || '[]')
  expect(saved.map((item: SavedJob) => item.job.source)).toEqual(['ashby', 'greenhouse'])
  expect(saved[0].company.provider).toBe('ashby')
})

test('only comparable annual pay enters city statistics and permanent employment remains distinct from full-time', async ({ page }) => {
  await restore(page)
  await page.getByRole('navigation', { name: '주요 메뉴' }).getByRole('button', { name: /도시 비교/ }).click()
  const pay = page.getByRole('row').filter({ hasText: '공개 연봉의 중앙값' })
  await expect(pay).toContainText('연봉 공개 1개 공고 기준')
  await page.getByRole('navigation', { name: '주요 메뉴' }).getByRole('button', { name: '기회 탐색', exact: true }).click()
  await page.getByRole('button', { name: /^모든 필터/ }).click()
  await page.getByRole('checkbox', { name: /연봉 미공개·별도 보상 공고도 포함/ }).uncheck()
  await page.getByLabel('고용 형태', { exact: true }).selectOption('fulltime')
  await expect(page.getByRole('button', { name: /0개 공고 보기$/ })).toBeVisible()
  await page.getByLabel('고용 형태', { exact: true }).selectOption('permanent')
  await page.getByRole('button', { name: /1개 공고 보기$/ }).click()
  await expect(page.locator('.mini-job-title')).toHaveCount(1)
  await page.locator('.mini-job-title').click()
  await expect(page.locator('.job-meta-pills')).toContainText('기간 제한 없음')
  await expect(page.locator('.job-meta-pills')).not.toContainText('풀타임')
  await expect(page.locator('.source-line')).toContainText('Lever 공개 게시판')
})

test('regional remote discovery never implies country eligibility from a local office address', async ({ page }) => {
  const remote = normalizeAshbyJob(ashbyPosting({
    location: 'Europe', workplaceType: 'Remote', isRemote: true, compensation: null,
  }), ashby.id, POSTING_TIME)!
  await restore(page, catalog([remote]), true)
  await expect(page.locator('.mini-job-title')).toHaveCount(0)
  await page.getByRole('button', { name: /^모든 필터/ }).click()
  await page.getByRole('checkbox', { name: /거주 국가가 포함된 원격근무만/ }).uncheck()
  await page.getByRole('button', { name: /1개 공고 보기$/ }).click()
  await expect(page.locator('.mini-job-title')).toHaveCount(1)
  await expect(page.locator('.flat-marker')).toHaveCount(0)
  await page.locator('.mini-job-title').click()
  await expect(page.locator('.remote-scope')).toContainText('국가별 근무 지역 미확인')
  await expect(page.locator('.remote-scope')).not.toContainText('영국')
  await expect(page.locator('.match-section.caution')).toContainText('원격근무 가능한 국가가 확인되지 않았어요')
})

test('SmartRecruiters discovery, saved records, status checks and CSV keep the same public source identity', async ({ page }) => {
  const data = catalog([smartJob])
  const index: PostingStatusIndex = {
    version: 1, checkedAt: POSTING_TIME, refreshAfter: new Date(Date.parse(POSTING_TIME) + 60_000).toISOString(),
    boards: [{
      companyId: canva.id, provider: 'smartrecruiters', board: canva.board!, status: 'ok',
      checkedAt: POSTING_TIME, lastSuccessAt: POSTING_TIME, retryAt: null,
      listing: {
        validUntil: new Date(Date.parse(POSTING_TIME) + 30 * 60_000).toISOString(), publishedIds: [smartJob.id],
        jobs: [{ id: smartJob.id, title: smartJob.title, url: smartJob.url, revision: await createJobRevision(smartJob) }],
      },
    }],
  }
  const requests: { url: string; method: string; body: string | null }[] = []
  await page.route('**/api/posting-status*', route => {
    requests.push({ url: route.request().url(), method: route.request().method(), body: route.request().postData() })
    return route.fulfill({ json: index })
  })
  await page.addInitScript(filters => {
    if (!localStorage.getItem('orbit.v1.exploration')) localStorage.setItem('orbit.v1.exploration', JSON.stringify({
      source: 'public', selectedId: 'melbourne', mapMode: 'flat', filters,
    }))
  }, DEFAULT_FILTERS)
  await restore(page, data)
  await expect(page.locator('.company-card')).toHaveCount(1)
  await expect(page.locator('.company-card')).toContainText('Canva')
  await page.locator('.mini-job-title').click()
  await expect(page.locator('.source-line')).toContainText('SmartRecruiters 공개 게시판')
  await expect(page.locator('.job-compensation')).toContainText('AUD 160,000–210,000 / 년')
  await expect(page.locator('.job-key-facts')).toContainText('별도 보상 조건')
  await expect(page.locator('.job-meta-pills')).toContainText('하이브리드')
  await expect(page.locator('.job-meta-pills')).toContainText('풀타임')
  await expect(page.getByRole('link', { name: '원문에서 지원하기' })).toHaveAttribute('href', smartJob.url)
  await page.getByRole('button', { name: '기회 저장', exact: true }).click()
  await page.getByLabel('이 기회에 대한 나의 메모').fill('멜버른 공고의 근무 조건 확인')
  await page.getByRole('button', { name: '지원 완료로 표시', exact: true }).click()
  await page.getByRole('button', { name: '닫기', exact: true }).click()
  await page.getByRole('navigation', { name: '주요 메뉴' }).getByRole('button', { name: /저장한 기회/ }).click()
  await page.reload()
  await expect(page.locator('.saved-card')).toHaveCount(2)
  const stored = await page.evaluate(() => localStorage.getItem('orbit.v1.saved'))
  expect(JSON.parse(stored || '[]')[0]).toMatchObject({
    company: { id: canva.id, provider: 'smartrecruiters', board: 'Canva' },
    job: { id: smartJob.id, source: 'smartrecruiters', fetchedAt: POSTING_TIME },
    note: '멜버른 공고의 근무 조건 확인', status: 'applied',
  })
  expect(requests).toHaveLength(0)
  await page.getByRole('button', { name: '게시 상태 확인', exact: true }).click()
  const notice = page.locator('.saved-card').filter({ hasText: 'SmartRecruiters fixture' }).locator('.posting-notice')
  await expect(notice).toHaveClass(/listed/)
  await expect(notice).not.toContainText('내용 비교는 확인하지 못했습니다')
  await expect(notice.locator('.posting-changes')).toHaveCount(0)
  expect(requests).toEqual([{ url: expect.stringMatching(/\/api\/posting-status\?refresh=1$/), method: 'GET', body: null }])
  expect(await page.evaluate(() => localStorage.getItem('orbit.v1.saved'))).toBe(stored)
  const downloadPromise = page.waitForEvent('download')
  await page.getByRole('button', { name: 'CSV 내보내기', exact: true }).click()
  const csv = await readFile((await (await downloadPromise).path())!, 'utf8')
  for (const value of ['SmartRecruiters', 'Greenhouse', 'AUD 160,000–210,000 / 년', '지원 완료', '표시 내용 일치', '멜버른 공고의 근무 조건 확인', smartJob.url]) expect(csv).toContain(value)
})

test.describe('mobile public sources', () => {
  test.use({ viewport: { width: 320, height: 780 }, isMobile: true, hasTouch: true })
  test('source coverage and multiple compensation ranges remain readable and accessible at 320px', async ({ page }) => {
    await restore(page)
    await page.getByRole('button', { name: '공개 채용', exact: true }).click()
    await expect(page.locator('.provider-coverage')).toBeVisible()
    expect(await page.locator('.dialog').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
    expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([])
    await page.getByRole('button', { name: '닫기', exact: true }).click()
    await page.locator('.mini-job-title').filter({ hasText: 'Ashby fixture' }).click()
    await expect(page.locator('.job-compensation dd')).toHaveCount(2)
    expect(await page.locator('.job-compensation').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([])
  })

  test('all four providers and a SmartRecruiters job remain readable and accessible at 320px', async ({ page }) => {
    const data = catalog([smartJob])
    data.companies = PUBLIC_COMPANIES
    data.boards = PUBLIC_COMPANIES.map(company => ({
      companyId: company.id, provider: company.provider, board: company.board!,
      total: company.id === canva.id ? 1 : 0, included: company.id === canva.id ? 1 : 0,
      status: 'ok', dataStatus: 'fresh', checkedAt: POSTING_TIME, lastSuccessAt: POSTING_TIME,
    }))
    await page.addInitScript(filters => localStorage.setItem('orbit.v1.exploration', JSON.stringify({
      source: 'public', selectedId: 'melbourne', mapMode: 'flat', filters,
    })), DEFAULT_FILTERS)
    await restore(page, data)
    await page.getByRole('button', { name: '공개 채용', exact: true }).click()
    await expect(page.getByRole('list', { name: '공개 공고 출처' }).locator('li')).toHaveText(['Greenhouse10개 회사', 'Ashby5개 회사', 'Lever2개 회사', 'SmartRecruiters3개 회사'])
    await expect(page.locator('.coverage-stats')).toContainText('20대상 회사')
    await page.locator('.board-details > summary').click()
    for (const name of ['Canva', 'Grab', 'Wise']) await expect(page.locator('.board-row').filter({ hasText: name })).toContainText('SmartRecruiters')
    expect(await page.locator('.dialog').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
    expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([])
    await page.getByRole('button', { name: '닫기', exact: true }).click()
    await page.locator('.mini-job-title').click()
    await expect(page.locator('.source-line')).toContainText('SmartRecruiters 공개 게시판')
    await expect(page.locator('.job-compensation')).toContainText('AUD 160,000–210,000 / 년')
    expect(await page.locator('.dialog').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
    expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([])
  })
})
