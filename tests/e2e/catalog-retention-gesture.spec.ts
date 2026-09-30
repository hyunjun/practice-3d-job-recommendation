import { expect } from '@playwright/test'
import { PRESENTATION_COLLECTION, presentationCatalog } from '../fixtures/catalog-presentation'
import {
  activateWithKeyboard, presentationCounts as counts, presentationHeading as heading, presentationTest as test,
} from './helpers/catalog-presentation'
import { crashCatalogWorker, WORKER_FAILURE_MESSAGE } from './helpers/catalog-retention'

// Stage73 contract §독립 검증 필수 기대값: a failure while a newer reply is deferred by
// a genuine map gesture keeps only the displayed projection as the anchor, applies
// expiry immediately, and never lets the deferred reply appear.
test.use({ viewport: { width: 1440, height: 960 }, reducedMotion: 'no-preference', serviceWorkers: 'block' })
test.setTimeout(60000)

test('a crash during a genuine held pan keeps the displayed prefix as anchor, expires it during the gesture, and never shows the held reply', async ({ page, presentation: app }) => {
  await app.open({ mode: 'flat', expiringAster: true, completePrefix: true })
  await expect(counts(page)).toHaveText(['1', '2'])
  await expect(page.locator('.company-card h3')).toHaveText(['Aster Presentation'])
  // Reach the cutoff neighbourhood before the refresh so the deferred reply and
  // the expiry both fall inside one real pointer gesture.
  await page.clock.pauseAt(new Date('2026-09-27T09:01:58.000Z'))
  await app.hold()
  app.respondInitial(route => route.fulfill({
    status: 202, headers: { 'Retry-After': '1' },
    json: {
      catalog: presentationCatalog(2, { expiringAster: true }),
      progress: { id: PRESENTATION_COLLECTION, revision: 2, total: 4, completed: 2, done: false },
    },
  }))
  await activateWithKeyboard(page.locator('.data-status-button'))
  await activateWithKeyboard(page.getByRole('button', { name: '새로고침', exact: true }))
  await activateWithKeyboard(page.getByRole('button', { name: '닫기', exact: true }))
  const receipt = await app.decoded(2)
  expect(receipt.kind).toBe('decoded')
  // Past the 120 ms idle debounce and before the 1 s monitor poll: only the
  // still-held pointer explains why the decoded Birch reply is not on screen.
  await page.clock.runFor(500)
  const gesture = await app.control()
  expect(gesture.pointer.at(-1)).toMatchObject({ type: 'pointerdown', buttons: 1, trusted: true })
  await expect(counts(page)).toHaveText(['1', '2'])
  await expect(page.locator('.company-card h3')).toHaveText(['Aster Presentation'])
  await expect(page.locator('.data-status-button')).toContainText('공개 공고 조회 중')

  await crashCatalogWorker(page)
  await expect(page.locator('.catalog-notice')).toContainText(WORKER_FAILURE_MESSAGE)
  await expect(page.locator('.data-status-button')).not.toContainText('조회 중')
  await expect(counts(page)).toHaveText(['1', '2'])
  await expect(page.locator('.company-card h3')).toHaveText(['Aster Presentation'])

  const remaining = Date.parse('2026-09-27T09:02:00.001Z') - await page.evaluate(() => Date.now())
  expect(remaining).toBeGreaterThan(0)
  await page.clock.runFor(remaining)
  // Expiry applies while the pointer is still down; the held Birch reply never publishes.
  await expect(counts(page)).toHaveText(['0', '0'])
  await expect(page.locator('.company-card')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Backend Engineer — Aster London Alpha', exact: true })).toHaveCount(0)
  await expect(heading(page)).toContainText('런던')
  expect(await page.evaluate(() => Date.now())).toBe(Date.parse('2026-09-27T09:02:00.001Z'))
  expect((await app.control()).pointer.at(-1)).toMatchObject({ type: 'pointerdown', buttons: 1, trusted: true })

  await app.end()
  await app.advance(2000)
  await expect(counts(page)).toHaveText(['0', '0'])
  await expect(page.locator('.company-card')).toHaveCount(0)
  await expect(page.locator('.catalog-notice')).toContainText(WORKER_FAILURE_MESSAGE)
  const recorded = await app.control()
  expect(recorded.visible.some(record => record.companies.includes('Birch Presentation'))).toBe(false)
  expect(recorded.visible.some(record => record.counts.join(',') === '2,3')).toBe(false)
  expect(app.traffic.filter(request => request.path === '/api/catalog?source=public&refresh=1')).toHaveLength(1)
  expect(app.traffic.filter(request => request.path.startsWith('/api/catalog/progress?'))).toHaveLength(0)
  expect(JSON.stringify(app.traffic)).not.toContain('PRIVATE_PRESENTATION_PROFILE')
})
