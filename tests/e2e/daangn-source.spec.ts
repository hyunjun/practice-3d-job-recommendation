import { expect, test } from '@playwright/test'
import type { Page, TestInfo } from '@playwright/test'
import { writeFile } from 'node:fs/promises'
import type { Catalog } from '../../shared/types'
import {
  DAANGN_LIST_URL, DAANGN_MARKET_TITLE, DAANGN_MARKET_URL, DAANGN_NOW,
  DAANGN_PAY_TITLE, DAANGN_PAY_URL, DAANGN_ROBOTS_URL,
} from '../fixtures/daangn-contract'
import { daangnResponses, isDaangnRequest } from '../fixtures/daangn-wire'
import type { CoverageReply } from '../fixtures/public-coverage-transport'
import { withSurveyEmptyBoards } from '../fixtures/public-company-survey'
import { publicCoverageResponses } from '../fixtures/public-coverage'
import { integrationServer } from './helpers/source-integrations'
import {
  expectSurveyPrivacy, seedSurvey, surveyClose, surveyDataButton, surveyImage, surveySearch,
} from './helpers/public-company-survey'

// Only this test's fictional Daangn HTML gets the observed complete-module shape.
// Shared fixtures, robots text, response controls and every UI/request oracle stay intact.
function daangnResponsesWithPostlude() {
  const postlude = '<script type="module" src="/_astro/fictional-layout.js"></script>'
    + '<script type="module" src="/_astro/fictional-index.js"></script>'
  return Object.fromEntries(Object.entries(daangnResponses()).map(([url, value]) => {
    if (url === DAANGN_ROBOTS_URL) return [url, value]
    const reply = value as CoverageReply
    if (!isDaangnRequest(url) || reply.fixtureResponse !== 'orbit-public-coverage-v1'
      || reply.format !== 'text' || typeof reply.body !== 'string'
      || !/^<!doctype\s+html\s*>/i.test(reply.body)) {
      throw new Error(`Unexpected non-HTML Daangn fixture: ${url}`)
    }
    return [url, { ...reply, body: reply.body + postlude }]
  }))
}

async function nonemptyDialogGeometry(page: Page, info: TestInfo, name: string) {
  await expect(page.getByRole('dialog')).toHaveCount(1)
  const geometry = await page.getByRole('dialog').evaluate(dialog => {
    const root = dialog.getBoundingClientRect()
    const bodies = [...dialog.querySelectorAll('.dialog-body')].map(body => ({
      clientWidth: body.clientWidth, scrollWidth: body.scrollWidth, height: body.getBoundingClientRect().height,
    }))
    return { left: root.left, right: root.right, top: root.top, bottom: root.bottom, height: root.height,
      clientWidth: dialog.clientWidth, scrollWidth: dialog.scrollWidth, bodies,
      viewport: { width: innerWidth, height: innerHeight, documentWidth: document.documentElement.scrollWidth } }
  })
  expect(geometry.clientWidth).toBeGreaterThan(0)
  expect(geometry.height).toBeGreaterThan(0)
  expect(geometry.left).toBeGreaterThanOrEqual(0)
  expect(geometry.top).toBeGreaterThanOrEqual(0)
  expect(geometry.right).toBeLessThanOrEqual(geometry.viewport.width)
  expect(geometry.bottom).toBeLessThanOrEqual(geometry.viewport.height)
  expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth)
  expect(geometry.bodies).toHaveLength(1)
  expect(geometry.bodies[0].clientWidth).toBeGreaterThan(0)
  expect(geometry.bodies[0].height).toBeGreaterThan(0)
  expect(geometry.bodies[0].scrollWidth).toBeLessThanOrEqual(geometry.bodies[0].clientWidth)
  expect(geometry.viewport.documentWidth).toBeLessThanOrEqual(geometry.viewport.width)
  await writeFile(info.outputPath(`${name}-dialog-geometry.json`), JSON.stringify(geometry, null, 2))
  await surveyImage(page, info, name)
}

for (const width of [1440, 320]) test.describe(`official Daangn sources at ${width}px`, () => {
  test.use({ viewport: { width, height: 960 }, isMobile: width === 320, hasTouch: width === 320 })

  test('two company queries retain unknown cities in Asia-Pacific and link only to the original postings', async ({ page, baseURL }, info) => {
    test.setTimeout(180_000)
    const server = await integrationServer(page, info, baseURL, {
      clock: DAANGN_NOW,
      responses: { ...withSurveyEmptyBoards(publicCoverageResponses()), ...daangnResponsesWithPostlude() },
    })
    try {
      await server.start()
      await server.verifyProductionBytes()
      const state = await seedSurvey(page, server.origin, { selectedId: null, clock: DAANGN_NOW })
      const response = await page.request.get(`${server.origin}/api/catalog?source=public`, { timeout: 90_000 })
      let catalog: Catalog
      try { expect(response.status()).toBe(200); catalog = await response.json() as Catalog }
      finally { await response.dispose() }
      expect(catalog.companies).toHaveLength(132)
      expect(catalog.boards).toHaveLength(132)
      expect(catalog.jobs).toHaveLength(7) // Five unchanged Seoul fixtures plus two new country-only postings.
      expect(catalog.boards.filter(board => ['daangn', 'daangn-pay'].includes(board.companyId))).toMatchObject([
        { companyId: 'daangn', status: 'ok', total: 2, included: 1 },
        { companyId: 'daangn-pay', status: 'ok', total: 1, included: 1 },
      ])
      expect(catalog.jobs.filter(job => ['daangn', 'daangn-pay'].includes(job.companyId)).map(job => ({
        id: job.id, cityIds: job.cityIds, updatedAt: job.updatedAt, workMode: job.workMode,
      }))).toEqual([
        { id: 'careers-daangn-830001', cityIds: [], updatedAt: null, workMode: 'unknown' },
        { id: 'careers-daangn-pay-830101', cityIds: [], updatedAt: null, workMode: 'unknown' },
      ])
      await page.locator('.results-tabs').getByRole('button', { name: /^기타 근무지/ }).click()
      await surveySearch(page).fill('당근')
      await expect(page.locator('.company-card h3')).toHaveText(['당근', '당근페이'])
      await expect(page.locator('.mini-job-title')).toHaveText([DAANGN_MARKET_TITLE, DAANGN_PAY_TITLE])
      const regions = page.locator('.region-tabs[aria-label="탐색 지역"]')
      await regions.getByRole('button', { name: '아시아 · 태평양', exact: true }).click()
      await expect(page.locator('.mini-job-title')).toHaveText([DAANGN_MARKET_TITLE, DAANGN_PAY_TITLE])
      await regions.getByRole('button', { name: '유럽', exact: true }).click()
      await expect(page.locator('.mini-job-title')).toHaveCount(0)
      await regions.getByRole('button', { name: '아시아 · 태평양', exact: true }).click()

      for (const [query, title, url, company] of [
        ['Cedar Market83', DAANGN_MARKET_TITLE, DAANGN_MARKET_URL, '당근'],
        ['당근페이', DAANGN_PAY_TITLE, DAANGN_PAY_URL, '당근페이'],
      ]) {
        await surveySearch(page).fill(query)
        await expect(page.locator('.mini-job-title')).toHaveText(title)
        await expect(page.locator('.company-card h3')).toHaveText(company)
        const opener = page.getByRole('button', { name: title, exact: true })
        await opener.click()
        const dialog = page.getByRole('dialog', { name: company, exact: true })
        await expect(dialog.locator('.job-detail-heading p')).toHaveText('대한민국')
        await expect(dialog.locator('.unmapped-job-notice')).toContainText('도시를 특정하기 어려워')
        await expect(dialog.getByRole('link', { name: '원문에서 지원하기', exact: true })).toHaveAttribute('href', url)
        await expect(dialog.locator('.source-line')).toContainText('공식 채용 사이트')
        await nonemptyDialogGeometry(page, info, `${company}-${width}`)
        await surveyClose(page, opener)
      }
      await surveyDataButton(page).click()
      await expect(page.getByRole('dialog').getByRole('list', { name: '공개 공고 출처' }))
        .toContainText('공식 채용 사이트5개 회사')
      await surveyClose(page, surveyDataButton(page))
      const all = await server.requests()
      const requests = all.filter(request => isDaangnRequest(request.url))
      expect(requests.map(request => request.url).sort()).toEqual([
        DAANGN_ROBOTS_URL, DAANGN_ROBOTS_URL, DAANGN_LIST_URL, DAANGN_LIST_URL,
        DAANGN_MARKET_URL, DAANGN_PAY_URL,
      ].sort())
      for (const request of all) expect(request).toMatchObject({ method: 'GET', body: null, synthetic: true, networkSent: false })
      for (let index = 1; index < requests.length; index++)
        expect(Date.parse(requests[index].at) - Date.parse(requests[index - 1].at)).toBeGreaterThanOrEqual(3000)
      await writeFile(info.outputPath('daangn-catalog-and-requests.json'), JSON.stringify({ catalog, requests }, null, 2))
      expectSurveyPrivacy(state, server.origin)
      await server.assertDefaultConfiguration()
    } finally { await page.close(); await server.stop() }
  })
})
