import { expect, test } from '@playwright/test'
import type { Locator, Page } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { CITIES } from '../../shared/cities'
import { PUBLIC_COMPANIES } from '../../shared/companies'
import { DEFAULT_FILTERS } from '../../shared/types'
import type { Catalog, Job } from '../../shared/types'
import { normalizeJob } from '../../server/normalize'
import { POSTING_TIME } from '../fixtures/public-postings'
import { readSaved, waitForSavedCommit } from './helpers/saved-store'

type Scope = 'cities' | 'remote' | 'unmapped'
const company = { ...PUBLIC_COMPANIES.find(value => value.id === 'stripe')!, name: 'Pagination Fixture' }

function catalog(scope: Scope = 'cities', count = 23): Catalog {
  const jobs: Job[] = Array.from({ length: count }, (_, index) => {
    const job = normalizeJob({
      id: 36100 + index,
      title: `Backend Engineer ${String(index + 1).padStart(2, '0')}${index === 3 ? ' UniqueNeedle' : ''}`,
      absolute_url: `https://example.com/pagination/${index + 1}`,
      location: { name: scope === 'cities' ? 'London, UK' : scope === 'remote' ? 'Remote' : 'Bengaluru, India' },
      content: '<h2>Required Qualifications</h2><p>5 years of software engineering experience with Python, TypeScript and AWS.</p>',
    }, company.id, POSTING_TIME)!
    return {
      ...job, workMode: scope === 'remote' ? 'remote' : 'hybrid',
      cityIds: scope === 'cities' ? ['london'] : [], remoteCountries: scope === 'remote' ? ['KR'] : [],
    }
  })
  return {
    source: 'public', cities: CITIES, companies: [company], jobs, stale: false,
    fetchedAt: POSTING_TIME, checkedAt: POSTING_TIME, unmappedCount: 0,
    boards: [{
      companyId: company.id, board: company.board!, provider: company.provider, total: jobs.length,
      included: jobs.length, status: 'ok', dataStatus: 'fresh', checkedAt: POSTING_TIME, lastSuccessAt: POSTING_TIME,
    }],
  }
}

async function open(page: Page, scope: Scope = 'cities', data = catalog(scope)) {
  await page.clock.setFixedTime(new Date(POSTING_TIME))
  await page.route('**/api/catalog?source=public*', route => route.fulfill({ json: data }))
  await page.addInitScript(({ scope, filters }) => {
    localStorage.setItem('orbit.v1.exploration', JSON.stringify({
      source: 'public', mapMode: 'flat', selectedId: scope === 'cities' ? 'london' : null,
      panelTab: scope, filters: { ...filters, remoteEligibleOnly: false },
    }))
  }, { scope, filters: DEFAULT_FILTERS })
  await page.goto('/')
  const card = page.getByRole('article', { name: company.name, exact: true })
  await expect(card.locator('.mini-job')).toHaveCount(1)
  await waitForSavedCommit(page)
  return card
}

function topPages(card: Locator) {
  return card.getByRole('navigation', { name: `${company.name} 공고 페이지 이동 (위)`, exact: true })
}
function disclosure(card: Locator) { return card.locator('.company-job-toolbar .more-jobs') }

test('visits every company job in recommendation order with bounded pages and saves and opens a later-page job', async ({ page }) => {
  const data = catalog()
  const requests: { method: string; path: string; body: string | null }[] = []
  page.on('request', request => {
    const url = new URL(request.url())
    if (url.pathname.startsWith('/api/')) requests.push({ method: request.method(), path: url.pathname + url.search, body: request.postData() })
  })
  const card = await open(page, 'cities', data)
  await expect(page.locator('.city-detail-count strong')).toHaveText(['1', '23'])
  await expect(disclosure(card)).toHaveAttribute('aria-expanded', 'false')
  await disclosure(card).click()
  await expect(disclosure(card)).toHaveAttribute('aria-expanded', 'true')
  await expect(card.locator('.mini-job')).toHaveCount(10)
  await expect(page.locator('.app-header')).toBeInViewport({ ratio: 1 })
  expect(await page.evaluate(() => scrollY)).toBe(0)
  await expect(topPages(card).getByRole('button', { name: '처음 공고 페이지', exact: true })).toBeDisabled()
  await expect(topPages(card).getByRole('button', { name: '이전 공고 페이지', exact: true })).toBeDisabled()
  const seen = await card.locator('.mini-job-title').allTextContents()
  for (const size of [10, 3]) {
    await topPages(card).getByRole('button', { name: '다음 공고 페이지', exact: true }).click()
    await expect(card.locator('.mini-job')).toHaveCount(size)
    await expect(card.locator('.mini-job-title').first()).toBeFocused()
    await expect(page.locator('.app-header')).toBeInViewport({ ratio: 1 })
    expect(await page.evaluate(() => scrollY)).toBe(0)
    seen.push(...await card.locator('.mini-job-title').allTextContents())
  }
  expect(seen).toEqual(data.jobs.map(job => job.title))
  await expect(topPages(card).getByRole('button', { name: '마지막 공고 페이지', exact: true })).toBeDisabled()
  await expect(topPages(card).getByRole('button', { name: '다음 공고 페이지', exact: true })).toBeDisabled()
  await expect(page.locator('.city-detail-count strong')).toHaveText(['1', '23'])
  await card.locator('.bookmark-button').first().click()
  await waitForSavedCommit(page)
  expect((await readSaved(page))[0].job.id).toBe(data.jobs[20].id)
  await expect(card.locator('.company-job-toolbar')).toContainText('21–23 / 23개 공고')
  await card.locator('.mini-job-title').first().click()
  await expect(page.getByRole('dialog')).toContainText(data.jobs[20].title)
  await page.getByLabel('이 기회에 대한 나의 메모').fill('A note from the third company page')
  await waitForSavedCommit(page)
  await page.keyboard.press('Escape')
  await expect(card.locator('.mini-job-title').first()).toBeFocused()
  await expect(card.locator('.company-job-toolbar')).toContainText('21–23 / 23개 공고')
  expect((await readSaved(page))[0].note).toBe('A note from the third company page')
  expect(requests).toEqual([{ method: 'GET', path: '/api/catalog?source=public', body: null }])
})

test('searches jobs outside the current page and resets to the beginning when the results change or return', async ({ page }) => {
  const card = await open(page)
  await disclosure(card).click()
  await topPages(card).getByRole('button', { name: '마지막 공고 페이지', exact: true }).click()
  const query = page.getByRole('textbox', { name: '도시, 회사 또는 포지션 검색', exact: true })
  await query.fill('UniqueNeedle')
  await expect(card.locator('.mini-job-title')).toHaveText(['Backend Engineer 04 UniqueNeedle'])
  await expect(card.getByRole('navigation')).toHaveCount(0)
  await expect(query).toBeFocused()
  await query.fill('')
  await expect(card.locator('.mini-job')).toHaveCount(10)
  await expect(card.locator('.company-job-toolbar')).toContainText('1–10 / 23개 공고')
  await expect(query).toBeFocused()
  await card.locator('.company-job-bottom').getByRole('button', { name: '다음 공고 페이지', exact: true }).click()
  await expect(card.locator('.company-job-toolbar')).toContainText('11–20 / 23개 공고')
  await expect(page.locator('.app-header')).toBeInViewport({ ratio: 1 })
  expect(await page.evaluate(() => scrollY)).toBe(0)
  await topPages(card).getByRole('button', { name: '이전 공고 페이지', exact: true }).click()
  await expect(card.locator('.mini-job-title').first()).toHaveText('Backend Engineer 01')
})

for (const scope of ['remote', 'unmapped'] as const) {
  test(`uses the same pages in ${scope} results without changing company or job counts`, async ({ page }) => {
    const card = await open(page, scope)
    await expect(page.locator('.list-toolbar')).toContainText('1개 회사 · 23개 공고')
    await disclosure(card).click()
    await topPages(card).getByRole('button', { name: '마지막 공고 페이지', exact: true }).click()
    await expect(card.locator('.mini-job-title').first()).toHaveText('Backend Engineer 21')
    await expect(card.locator('.mini-job')).toHaveCount(3)
    await expect(page.locator('.list-toolbar')).toContainText('1개 회사 · 23개 공고')
    await topPages(card).getByRole('button', { name: '처음 공고 페이지', exact: true }).click()
    await expect(card.locator('.mini-job-title').first()).toHaveText('Backend Engineer 01')
  })
}

test('supports keyboard page changes and bottom collapse at 320px with visible focus and accessible controls', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 800 })
  const card = await open(page)
  await disclosure(card).focus()
  await disclosure(card).press('Enter')
  await expect(disclosure(card)).toBeFocused()
  const controlledId = await disclosure(card).getAttribute('aria-controls')
  expect(await card.locator('.company-jobs').getAttribute('id')).toBe(controlledId)
  const last = topPages(card).getByRole('button', { name: '마지막 공고 페이지', exact: true })
  await last.focus()
  await last.press('Enter')
  const first = card.locator('.mini-job-title').first()
  await expect(first).toBeFocused()
  await expect(first).toBeInViewport({ ratio: 1 })
  await page.keyboard.press('Tab')
  await expect(card.locator('.bookmark-button').first()).toBeFocused()
  const audit = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()
  expect(audit.violations).toEqual([])
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  expect(await card.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true)
  await card.locator('.company-job-bottom').getByRole('button', { name: '공고 접기', exact: true }).click()
  await expect(card.locator('.mini-job')).toHaveCount(1)
  await expect(disclosure(card)).toHaveAttribute('aria-expanded', 'false')
  await expect(disclosure(card)).toBeFocused()
  await expect(disclosure(card)).toBeInViewport({ ratio: 1 })
  await disclosure(card).press('Space')
  await expect(card.locator('.company-job-toolbar')).toContainText('1–10 / 23개 공고')
})
