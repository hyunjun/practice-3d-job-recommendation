import { expect, test } from '@playwright/test'
import { readFile, writeFile } from 'node:fs/promises'
import type { Catalog, Job } from '../../shared/types'
import { BOOKING_LIST_URLS } from '../fixtures/careers-contract'
import { createPublicCoverageServer } from '../fixtures/public-coverage-server'
import {
  sourcePublicLifecycleCache, sourcePublicLifecycleResponses, sourcePublicLifecycleSaved,
} from '../fixtures/source-public-lifecycle'
import { SOURCE_EXPANSION_NOW } from '../fixtures/source-expansion-wire'
import { readServerMode } from './helpers/api-requests'
import { readSaved } from './helpers/saved-store'
import {
  expectSurveyPrivacy, seedSurvey, surveyClose, surveyDataButton, surveyImage,
  surveyJson, surveyNavigation, surveyRole, surveySearch,
} from './helpers/public-company-survey'
import { expectPublicSourceOverview } from './helpers/source-choice'

for (const width of [1440, 320]) test.describe(`public source collection lifecycle at ${width}px`, () => {
  test.use({ viewport: { width, height: 960 }, isMobile: width === 320, hasTouch: width === 320 })

  test('saved navigation cancels the monitor, public return rejoins one Booking collection, and saved-only restart sends no catalog request', async ({ page, baseURL }, info) => {
    test.setTimeout(90_000)
    const mode = await readServerMode(page.request, `${baseURL}/api/health`)
    const cacheSeed = sourcePublicLifecycleCache()
    expect(cacheSeed.boards).toHaveLength(129)
    const server = await createPublicCoverageServer(info.outputPath('source-public-lifecycle-server'), mode, {
      cacheSeed, clock: SOURCE_EXPANSION_NOW, responses: sourcePublicLifecycleResponses(), defaultEmptyBoards: false,
    })
    try {
      await server.start()
      await server.verifyProductionBytes()
      const state = await seedSurvey(page, server.origin, {
        legacySource: 'sample', clock: SOURCE_EXPANSION_NOW, selectedId: 'amsterdam', query: 'Booking.com',
        saved: sourcePublicLifecycleSaved(),
      })
      await expect(page.locator('.data-status-button')).toContainText('공개 공고 조회 중')
      await expect.poll(async () => (await server.requests()).map(request => request.url)).toEqual([BOOKING_LIST_URLS[0]])
      await surveyRole(page, 'backend', 0)
      await surveyNavigation(page).getByRole('button', { name: /^저장한 기회/ }).click()
      await expect(page.locator('.saved-title')).toHaveText('Backend Engineer — Synthetic Maple Index')
      await expect(page.locator('.saved-note-preview')).toHaveText('Stage61 이전 Notion 메모 — 원래 출처 보존')
      await expect(page.locator('.saved-status')).toHaveText('지원 완료')
      await expect(page.locator('.collection-progress')).toHaveCount(0)
      await expect(page.locator('.data-status-button')).not.toContainText('공개 공고 조회 중')
      const saved = await readSaved(page)
      expect(saved).toHaveLength(1)
      expect(saved[0]).toMatchObject({
        company: { id: 'notion', name: 'Notion', provider: 'ashby', board: 'notion' },
        job: {
          id: 'ashby-notion-synthetic-57102', source: 'ashby',
          title: 'Backend Engineer — Synthetic Maple Index',
          url: 'https://example.com/synthetic/notion-57102', fetchedAt: '2026-10-01T23:39:55.000Z',
        },
        savedAt: '2026-10-01T23:39:55.000Z', status: 'applied',
        note: 'Stage61 이전 Notion 메모 — 원래 출처 보존',
      })
      const beforeRejoin = state.traffic.catalog().length
      await surveyNavigation(page).getByRole('button', { name: '기회 탐색', exact: true }).click()
      await expect.poll(() => state.traffic.catalog().length).toBe(beforeRejoin + 1)
      await expect(surveySearch(page)).toHaveValue('Booking.com')
      await expect(page.locator('.mini-job-title')).toHaveText('Backend Engineer — Synthetic Canal API64', { timeout: 30_000 })
      await expect(page.locator('.city-detail-count strong')).toHaveText(['1', '1'])
      await expect(page.locator('.company-card h3')).toHaveText('Booking.com / Booking Holdings')
      await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('orbit.v1.exploration') ?? '{}')))
        .toMatchObject({ source: 'public', selectedId: 'amsterdam', filters: { query: 'Booking.com', role: 'backend' } })
      expect(await readSaved(page)).toEqual(saved)

      const catalog = await surveyJson<Catalog>(page, server.origin, '/api/catalog?source=public')
      expect(catalog.source).toBe('public')
      expect(catalog.companies).toHaveLength(130)
      expect(catalog.boards).toHaveLength(130)
      expect(catalog.jobs).toHaveLength(4)
      expect(catalog.jobs.some(job => job.source === 'sample')).toBe(false)
      expect(catalog.boards.find(board => board.companyId === 'booking')).toMatchObject({
        provider: 'careers', board: 'booking', status: 'ok', dataStatus: 'fresh', total: 101, included: 2,
      })
      const bytes = await readFile(server.defaultCache, 'utf8')
      const cache = JSON.parse(bytes)
      const raw = (job: Job) => [job.id, job.title, job.description, job.url, job.fetchedAt, job.updatedAt]
      for (const original of cacheSeed.boards) {
        const retained = cache.boards.find((board: { companyId: string }) => board.companyId === original.companyId)
        expect(retained).toMatchObject({
          checkedAt: original.checkedAt, failures: original.failures, retryAt: original.retryAt,
          snapshot: { fetchedAt: original.snapshot.fetchedAt, total: original.snapshot.total, publishedIds: original.snapshot.publishedIds },
        })
        expect(retained.snapshot.jobs.map(raw)).toEqual(original.snapshot.jobs.map(raw))
      }
      await surveyDataButton(page).click()
      const overview = await expectPublicSourceOverview(page, 'rejoined public collector')
      await expect(page.getByRole('dialog').locator('.coverage-stats strong')).toHaveText(['35', '130', '4'])
      await surveyImage(page, info, 'rejoined-public-source')
      await surveyClose(page, surveyDataButton(page))

      const attempts = state.traffic.catalog().length
      await page.goto('about:blank')
      await server.stop()
      await server.start()
      await server.verifyProductionBytes()
      await page.goto(`${server.origin}/#saved`)
      await expect(page.locator('.saved-title')).toHaveText('Backend Engineer — Synthetic Maple Index')
      expect(await readSaved(page)).toEqual(saved)
      expect(state.traffic.catalog()).toHaveLength(attempts)
      await surveyNavigation(page).getByRole('button', { name: '기회 탐색', exact: true }).click()
      await expect(page.locator('.mini-job-title')).toHaveText('Backend Engineer — Synthetic Canal API64')
      await expect(surveySearch(page)).toHaveValue('Booking.com')
      expect(await readSaved(page)).toEqual(saved)
      expect(await readFile(server.defaultCache, 'utf8')).toBe(bytes)
      const upstream = await server.requests()
      expect(upstream.map(request => request.url)).toEqual([...BOOKING_LIST_URLS])
      expect(upstream.every(request => request.synthetic && !request.networkSent && request.method === 'GET' && request.body === null)).toBe(true)
      expectSurveyPrivacy(state, server.origin)
      await server.assertDefaultConfiguration()
      await writeFile(info.outputPath('source-public-lifecycle.json'), JSON.stringify({ catalog, saved, upstream, overview, traffic: state.traffic.requests }, null, 2))
    } finally {
      await page.close()
      await server.stop()
    }
  })
})
