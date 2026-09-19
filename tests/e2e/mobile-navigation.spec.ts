import { expect, test } from '@playwright/test'
import type { Locator, Page } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { CITIES } from '../../shared/cities'
import { DEFAULT_FILTERS } from '../../shared/types'
import { SEARCH_PROFILE, SEARCH_TIME, searchCatalog, searchJob } from '../fixtures/search-catalog'
import { readSaved, waitForSavedCommit } from './helpers/saved-store'

const jobs = [
  ...CITIES.map(city => searchJob(`navigation-${city.id}`, {
    title: `Backend Engineer — ${city.en}`, cityIds: [city.id], locationLabel: city.en,
  })),
  ...Array.from({ length: 12 }, (_, index) => searchJob(`navigation-london-${String(index + 1).padStart(2, '0')}`, {
    title: `Backend Engineer — London ${String(index + 1).padStart(2, '0')}`,
  })),
]
const catalog = searchCatalog(jobs)
const londonJobs = jobs.filter(job => job.cityIds.includes('london'))

async function expectUnobscured(target: Locator) {
  // In-viewport assertions alone still pass when a fixed menu covers the target.
  await expect.poll(() => target.evaluate(element => {
    const rect = element.getBoundingClientRect()
    return [0.15, 0.5, 0.85].every(x => [0.15, 0.5, 0.85].every(y => {
      const hit = document.elementFromPoint(rect.left + rect.width * x, rect.top + rect.height * y)
      return hit !== null && element.contains(hit)
    }))
  }), { message: 'The focused control must remain visible and reachable above fixed content' }).toBe(true)
}

async function tapEdge(page: Page, target: Locator) {
  await target.scrollIntoViewIfNeeded()
  const box = await target.boundingBox()
  expect(box).not.toBeNull()
  expect(box!.width).toBeGreaterThanOrEqual(44)
  expect(box!.height).toBeGreaterThanOrEqual(44)
  await page.touchscreen.tap(box!.x + 6, box!.y + box!.height - 6)
}

for (const { viewport, bottomInset } of [
  { viewport: { width: 320, height: 568 }, bottomInset: 0 },
  { viewport: { width: 390, height: 844 }, bottomInset: 0 },
  { viewport: { width: 667, height: 375 }, bottomInset: 0 },
  { viewport: { width: 390, height: 844 }, bottomInset: 34 },
]) {
  test.describe(`mobile navigation at ${viewport.width}×${viewport.height} with ${bottomInset}px bottom inset`, () => {
    test.use({ viewport, isMobile: true, hasTouch: true })
    test('touch targets, keyboard pages, saved notes and filter reset remain usable without overlays', async ({ page }) => {
      if (bottomInset) {
        const cdp = await page.context().newCDPSession(page)
        await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: { bottom: bottomInset } })
      }
      await page.clock.setFixedTime(new Date(SEARCH_TIME))
      await page.route('**/api/catalog?source=public*', route => route.fulfill({ json: catalog }))
      await page.addInitScript(({ profile, filters }) => {
        if (sessionStorage.getItem('navigation-seeded')) return
        localStorage.setItem('orbit.v1.profile', JSON.stringify(profile))
        localStorage.setItem('orbit.v1.exploration', JSON.stringify({
          source: 'public', mapMode: 'flat', selectedId: null, panelTab: 'cities', filters,
        }))
        sessionStorage.setItem('navigation-seeded', 'true')
      }, {
        profile: { ...SEARCH_PROFILE, name: 'Private mobile profile', desiredRole: 'all', skills: [] },
        filters: { ...DEFAULT_FILTERS, visa: 'supported', query: 'Backend' },
      })
      const errors: string[] = []
      const requests: { url: string; method: string; body: string | null }[] = []
      page.on('pageerror', error => errors.push(error.message))
      page.on('request', request => {
        if (new URL(request.url()).pathname.startsWith('/api/')) requests.push({ url: request.url(), method: request.method(), body: request.postData() })
      })
      await page.goto('/')
      await waitForSavedCommit(page)
      await expect(page.locator('.city-row')).toHaveCount(22)
      for (const button of await page.getByRole('navigation', { name: '주요 메뉴' }).getByRole('button').all()) {
        const box = await button.boundingBox()
        expect(box!.height).toBeGreaterThanOrEqual(44)
        expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height - bottomInset)
      }
      const summary = page.locator('.active-filter-summary')
      const summaryBox = await summary.boundingBox()
      const resultsBox = await page.locator('.explore-layout').boundingBox()
      expect(summaryBox!.y + summaryBox!.height).toBeLessThanOrEqual(resultsBox!.y)
      await page.getByRole('button', { name: '도시 목록 보기', exact: true }).tap()
      expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze()).violations).toEqual([])
      await tapEdge(page, page.getByRole('button', { name: '런던 비교에 추가', exact: true }))
      await expect(page.getByRole('button', { name: '런던 비교에서 제거', exact: true })).toBeVisible()
      await expect(page.locator('.city-detail-hero')).toHaveCount(0)
      await page.getByRole('button', { name: '런던, 추천 회사 1곳 보기', exact: true }).tap()
      await expect(page.locator('.city-detail-count strong')).toHaveText(['1', '13'])
      const card = page.locator('.company-card')
      const disclosure = card.locator('.company-job-toolbar .more-jobs')
      await tapEdge(page, disclosure)
      await expect(card.locator('.mini-job')).toHaveCount(10)
      await disclosure.focus()
      await expectUnobscured(disclosure)
      const buttons = await card.locator('button:visible:enabled').all()
      for (const button of buttons.slice(1)) {
        await page.keyboard.press('Tab')
        await expect(button).toBeFocused()
        await expectUnobscured(button)
      }
      const next = card.getByRole('navigation', { name: /공고 페이지 이동 \(위\)/ }).getByRole('button', { name: '마지막 공고 페이지', exact: true })
      await next.focus()
      await next.press('Enter')
      await expect(card.locator('.mini-job')).toHaveCount(3)
      const first = card.locator('.mini-job-title').first()
      await expect(first).toHaveText(londonJobs[10].title)
      await expect(first).toBeFocused()
      await expectUnobscured(first)
      await tapEdge(page, card.locator('.bookmark-button').first())
      await waitForSavedCommit(page)
      expect((await readSaved(page)).map(record => record.job.id)).toEqual([londonJobs[10].id])
      await first.tap()
      const note = page.getByLabel('이 기회에 대한 나의 메모')
      await note.fill('Private mobile navigation note')
      await page.getByRole('button', { name: '지원 완료로 표시', exact: true }).click()
      const close = page.getByRole('button', { name: '닫기', exact: true })
      await tapEdge(page, close)
      await expect(first).toBeFocused()
      await expectUnobscured(first)
      expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze()).violations).toEqual([])
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      expect(await card.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
      await summary.getByRole('button', { name: '초기화', exact: true }).click()
      const search = page.getByLabel('도시, 회사 또는 포지션 검색')
      await expect(search).toBeFocused()
      await expectUnobscured(search)
      await expect(search).toHaveValue('')
      await expect(summary).toHaveCount(0)
      await expect(page.locator('.city-row')).toHaveCount(22)
      await page.getByRole('navigation', { name: '주요 메뉴' }).getByRole('button', { name: /저장한 기회/ }).tap()
      await waitForSavedCommit(page)
      await page.reload()
      await expect(page.locator('.saved-card')).toHaveCount(1)
      expect((await readSaved(page))[0]).toMatchObject({
        note: 'Private mobile navigation note', status: 'applied', job: { id: londonJobs[10].id, fetchedAt: SEARCH_TIME },
      })
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      for (const request of requests) {
        const url = new URL(request.url)
        expect(url.pathname).toBe('/api/catalog')
        expect([...url.searchParams]).toEqual([['source', 'public']])
        expect(request.method).toBe('GET')
        expect(request.body).toBeNull()
      }
      expect(errors).toEqual([])
    })
  })
}
