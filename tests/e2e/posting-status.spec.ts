import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { readFile } from 'node:fs/promises'
import { PUBLIC_COMPANIES } from '../../shared/companies'
import { createJobRevision } from '../../shared/posting-status'
import type { PostingStatusIndex } from '../../shared/posting-status'
import { createSampleCatalog } from '../../shared/sample'
import { DEFAULT_FILTERS, SAMPLE_PROFILE } from '../../shared/types'
import type { Company, Job, SavedJob } from '../../shared/types'
import { normalizeJob } from '../../server/normalize'

const BASE = Date.parse('2026-09-19T08:00:00.000Z')
const iso = (value: number) => new Date(value).toISOString()
const stripe = PUBLIC_COMPANIES.find(company => company.id === 'stripe')!
const figma = PUBLIC_COMPANIES.find(company => company.id === 'figma')!
const supabase = PUBLIC_COMPANIES.find(company => company.id === 'supabase')!
const spotify = PUBLIC_COMPANIES.find(company => company.id === 'spotify')!
const companies = [stripe, supabase, spotify, figma]

function fixture(company: Company, id: number, title: string): Job {
  return {
    ...normalizeJob({
      id, title: `Backend Engineer — ${title}`, location: { name: 'London, UK' },
      absolute_url: `https://example.com/postings/${id}`,
      content: '<h2>Minimum requirements</h2><p>3 years of software engineering experience.</p><p>Experience with Python and AWS.</p>',
    }, company.id, iso(BASE - 120_000))!,
    id: `${company.provider}-${company.id}-${id}`, source: company.provider!,
  }
}
const jobs = [
  fixture(stripe, 7701, 'unchanged fixture'), fixture(supabase, 7702, 'saved title fixture'),
  fixture(spotify, 7703, 'missing fixture'), fixture(figma, 7704, 'outage fixture'),
  fixture(stripe, 7705, 'outside map fixture'),
]
const sample = createSampleCatalog()
const saved: SavedJob[] = [
  ...jobs.map(job => ({ job, company: companies.find(company => company.id === job.companyId)!, savedAt: iso(BASE - 60_000), status: 'applied' as const, note: `Private note ${job.id}` })),
  { job: sample.jobs[0], company: sample.companies.find(company => company.id === sample.jobs[0].companyId)!, savedAt: iso(BASE - 60_000), status: 'saved', note: 'Sample bookmark' },
]

async function makeIndex(): Promise<PostingStatusIndex> {
  const current = { ...jobs[1], title: 'Staff Backend Engineer — current title fixture', salary: { min: 100000, max: 140000, currency: 'GBP' as const }, url: 'https://example.com/current/7702' }
  const indexed = [jobs[0], current]
  return {
    version: 1, checkedAt: iso(BASE), refreshAfter: iso(BASE + 60_000),
    boards: await Promise.all(companies.map(async company => ({
      companyId: company.id, provider: company.provider!, board: company.board!,
      status: company === figma ? 'error' : 'ok', checkedAt: iso(BASE),
      lastSuccessAt: company === figma ? null : iso(BASE),
      retryAt: company === figma ? iso(BASE + 300_000) : null,
      ...(company === figma ? { message: 'HTTP 503' } : {
        listing: {
          validUntil: iso(BASE + 30 * 60_000),
          publishedIds: [...indexed.filter(job => job.companyId === company.id).map(job => job.id), ...(company === stripe ? [jobs[4].id] : [])],
          jobs: await Promise.all(indexed.filter(job => job.companyId === company.id).map(async job => ({
            id: job.id, title: job.title, url: job.url, revision: await createJobRevision(job),
          }))),
        },
      }),
    }))),
  }
}

async function restore(page: Page, records = saved) {
  await page.clock.install({ time: new Date(BASE + 10_000) })
  await page.addInitScript(({ records, profile, filters }) => {
    if (!localStorage.getItem('orbit.v1.saved')) localStorage.setItem('orbit.v1.saved', JSON.stringify(records))
    localStorage.setItem('orbit.v1.profile', JSON.stringify({ ...profile, kind: 'personal', name: 'Private profile fixture' }))
    if (!localStorage.getItem('orbit.v1.exploration')) localStorage.setItem('orbit.v1.exploration', JSON.stringify({
      source: 'sample', mapMode: 'flat', selectedId: 'london', filters: { ...filters, query: 'keep this search', region: 'europe' },
    }))
  }, { records, profile: SAMPLE_PROFILE, filters: DEFAULT_FILTERS })
  await page.goto('/#saved')
  await expect(page.locator('.saved-card')).toHaveCount(records.length)
}
const card = (page: Page, text: string) => page.locator('.saved-card').filter({ hasText: text })

test('explicit status checks compare locally, preserve private records and export separate application and posting states', async ({ page }) => {
  const index = await makeIndex()
  const requests: { url: string; method: string; body: string | null }[] = []
  await page.route('**/api/posting-status*', route => {
    requests.push({ url: route.request().url(), method: route.request().method(), body: route.request().postData() })
    return route.fulfill({ json: index })
  })
  await restore(page)
  expect(requests).toHaveLength(0)
  await expect(page.locator('.posting-notice.unchecked')).toHaveCount(5)
  const before = await page.evaluate(() => ({
    saved: localStorage.getItem('orbit.v1.saved'), profile: localStorage.getItem('orbit.v1.profile'), exploration: localStorage.getItem('orbit.v1.exploration'),
  }))
  await page.getByRole('button', { name: '게시 상태 확인', exact: true }).click()
  await expect(card(page, 'saved title fixture').locator('.posting-changes')).toHaveText('포지션 · 보상 · 지원 링크 확인 필요')
  await expect(card(page, 'unchanged fixture').locator('.posting-notice')).toHaveClass(/listed/)
  await expect(card(page, 'missing fixture').locator('.posting-notice')).toHaveClass(/missing/)
  await expect(card(page, 'outage fixture').locator('.posting-notice')).toHaveClass(/unknown/)
  await expect(card(page, 'outside map fixture').locator('.posting-notice')).toContainText('탐색 범위 밖')
  await expect(page.locator('.posting-summary')).toHaveText('게시 확인 3내용 차이 1목록에서 미확인 1확인 필요 1')
  expect(requests).toEqual([{ url: expect.stringMatching(/\/api\/posting-status\?refresh=1$/), method: 'GET', body: null }])
  expect(await page.evaluate(() => ({
    saved: localStorage.getItem('orbit.v1.saved'), profile: localStorage.getItem('orbit.v1.profile'), exploration: localStorage.getItem('orbit.v1.exploration'),
  }))).toEqual(before)
  await page.getByRole('combobox', { name: '게시 상태', exact: true }).selectOption('changed')
  await expect(page.locator('.saved-card')).toHaveCount(1)
  await page.locator('.saved-title').click()
  await expect(page.locator('.job-dialog .posting-notice')).toContainText('정보 해석 방식의 차이')
  await expect(page.locator('.job-dialog .posting-notice a')).toHaveAttribute('href', 'https://example.com/current/7702')
  await expect(page.getByLabel('이 기회에 대한 나의 메모')).toHaveValue(`Private note ${jobs[1].id}`)
  await expect(page.getByRole('button', { name: '지원 완료로 표시됨', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '닫기', exact: true }).click()
  await page.getByRole('combobox', { name: '게시 상태', exact: true }).selectOption('unknown')
  await expect(page.locator('.saved-card')).toHaveCount(1)
  await expect(page.locator('.saved-card')).toContainText('outage fixture')
  const downloading = page.waitForEvent('download')
  await page.getByRole('button', { name: 'CSV 내보내기', exact: true }).click()
  const csv = await readFile((await (await downloading).path())!, 'utf8')
  for (const value of ['공개 게시 상태', '게시 목록 확인 시각', '내용 비교', '표시 내용 일치', '미확인', '저장 내용과 다른 항목', '지원 완료', '공개 목록에서 미확인', '포지션 · 보상 · 지원 링크', 'Sample bookmark']) expect(csv).toContain(value)
  await page.reload()
  await expect(page.locator('.posting-notice.unchecked')).toHaveCount(5)
  expect(requests).toHaveLength(1)
  expect(await page.evaluate(() => localStorage.getItem('orbit.v1.saved'))).toBe(before.saved)
})

test('expired checks and request failures become unknown, then recover after the retry deadline', async ({ page }) => {
  let index = await makeIndex()
  let fail = false
  let requests = 0
  await page.route('**/api/posting-status*', route => {
    requests++
    return fail ? route.fulfill({ status: 503, json: { error: 'offline' } }) : route.fulfill({ json: index })
  })
  await restore(page)
  await page.getByRole('button', { name: '게시 상태 확인', exact: true }).click()
  await expect(page.locator('.posting-notice.listed')).toHaveCount(3)
  await expect(page.getByRole('button', { name: '새로 확인', exact: true })).toBeDisabled()
  await page.clock.fastForward(30 * 60_000)
  await expect(page.locator('.posting-notice.unknown')).toHaveCount(5)
  await expect(page.getByRole('button', { name: '새로 확인', exact: true })).toBeEnabled()
  fail = true
  await page.getByRole('button', { name: '새로 확인', exact: true }).click()
  await expect(page.locator('.posting-summary')).toContainText('불러오지 못했어요')
  await expect(page.getByRole('button', { name: '새로 확인', exact: true })).toBeDisabled()
  await expect(card(page, 'saved title fixture').locator('.posting-changes')).toHaveCount(0)
  const time = await page.evaluate(() => Date.now())
  fail = false
  index = {
    ...index, checkedAt: iso(time + 60_000), refreshAfter: iso(time + 120_000),
    boards: index.boards.map(board => ({
      ...board, checkedAt: iso(time + 60_000), lastSuccessAt: iso(time + 60_000),
      status: 'ok', retryAt: null,
      listing: { validUntil: iso(time + 30 * 60_000), publishedIds: saved.filter(item => item.job.companyId === board.companyId && item.job.source !== 'sample').map(item => item.job.id), jobs: [] },
    })),
  }
  await page.clock.fastForward(60_000)
  await expect(page.getByRole('button', { name: '새로 확인', exact: true })).toBeEnabled()
  await page.getByRole('button', { name: '새로 확인', exact: true }).click()
  await expect(page.locator('.posting-notice.listed')).toHaveCount(5)
  await expect(page.locator('.posting-notice.missing, .posting-notice.unknown')).toHaveCount(0)
  expect(requests).toBe(3)
})

test('a legacy board snapshot remains unknown and unsafe current links never become clickable', async ({ page }) => {
  const index = await makeIndex()
  delete index.boards[0].listing
  index.boards[1].listing!.jobs[0].url = 'javascript:alert(document.cookie)'
  await page.route('**/api/posting-status*', route => route.fulfill({ json: index }))
  await restore(page)
  await page.getByRole('button', { name: '게시 상태 확인', exact: true }).click()
  await expect(card(page, 'unchanged fixture').locator('.posting-notice')).toHaveClass(/unknown/)
  await expect(card(page, 'saved title fixture').locator('.posting-notice')).toHaveClass(/listed/)
  await expect(card(page, 'saved title fixture').locator('.posting-notice a')).toHaveCount(0)
  await expect(page.locator('a[href^="javascript:"]')).toHaveCount(0)
})

test.describe('saved status on narrow screens', () => {
  test.use({ viewport: { width: 320, height: 780 }, isMobile: true, hasTouch: true })
  test('status controls, changed content and disclosure stay readable and accessible at 320px', async ({ page }) => {
    const index = await makeIndex()
    await page.route('**/api/posting-status*', route => route.fulfill({ json: index }))
    await restore(page)
    await page.getByRole('button', { name: '게시 상태 확인', exact: true }).click()
    await expect(card(page, 'saved title fixture').locator('.posting-changes')).toBeVisible()
    expect(await page.locator('body').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
    expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([])
    await page.getByRole('combobox', { name: '게시 상태', exact: true }).selectOption('changed')
    await page.locator('.saved-title').click()
    await expect(page.locator('.job-dialog .posting-notice')).toContainText('현재 포지션')
    expect(await page.locator('.dialog').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
    expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([])
  })
})
