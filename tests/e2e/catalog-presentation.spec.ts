import { expect } from '@playwright/test'
import type { Page, Route } from '@playwright/test'
import {
  activateWithKeyboard, presentationCounts as counts, presentationHeading as heading,
  presentationQuery as query, presentationTest as test,
} from './helpers/catalog-presentation'
import {
  PRESENTATION_COLLECTION, PRESENTATION_EXPECTED, presentationCatalog, presentationUpdate,
} from '../fixtures/catalog-presentation'

test.use({ viewport: { width: 1440, height: 960 }, reducedMotion: 'no-preference', serviceWorkers: 'block' })
test.setTimeout(60000)

const london = (page: Page, companies: number) =>
  page.getByRole('button', { name: `런던, 추천 회사 ${companies}곳 보기`, exact: true })
const amsterdam = (page: Page, companies: number) =>
  page.getByRole('button', { name: `암스테르담, 추천 회사 ${companies}곳 보기`, exact: true })

for (const mode of ['globe', 'flat'] as const) {
  test(`${mode}: genuine held rotation/pan keeps the selected prefix, continues decoding, and publishes the latest union at the first 1500 ms deadline`, async ({ page, presentation: app }, info) => {
    await app.open({ mode })
    await app.hold()
    const first = await app.deliver(2)
    await expect(counts(page)).toHaveText(['1', '2'])
    await expect(page.locator('.company-card h3')).toHaveText(['Aster Presentation'])
    await app.until(first, 1000)
    // This next real HTTP request proves read/decode continued while the first
    // arrival was still gated. Holding the worker reply would not prove that.
    const finalRequest = await app.take(2)
    expect(app.traffic.filter(request => request.path.startsWith('/api/catalog/progress?')).map(request => request.path)).toEqual([
      `/api/catalog/progress?id=${PRESENTATION_COLLECTION}&after=1`,
      `/api/catalog/progress?id=${PRESENTATION_COLLECTION}&after=2`,
    ])
    await app.deliver(3, finalRequest)
    await expect(counts(page)).toHaveText(['1', '2'])
    await expect(page.locator('.data-status-button')).toContainText('공개 공고 조회 중')
    await app.until(first, 1499)
    await expect(counts(page)).toHaveText(['1', '2'])
    await app.until(first, 1500)
    await expect(counts(page)).toHaveText(['4', '5'])
    await expect(page.locator('.company-card h3')).toHaveText(PRESENTATION_EXPECTED.londonNames[2])
    await expect(heading(page)).toContainText('런던')
    await expect(page.locator('.city-coordinate')).toHaveText('51.51°N')
    await expect(page.locator('.collection-progress')).toHaveCount(0)
    await expect(page.locator('.data-status-button')).toContainText('공개 채용')
    const recorded = await app.control()
    expect(recorded.pointer.at(-1)).toMatchObject({ type: 'pointerdown', buttons: 1, trusted: true })
    expect(recorded.visible.filter(item => item.heading.startsWith('런던')).map(item => item.counts))
      .not.toContainEqual(['2', '3'])
    await app.advance(32)
    if (mode === 'globe') {
      // London 4 + Amsterdam 3 are a union of FOUR, not seven.
      await expect(page.getByRole('button', {
        name: '런던 외 1, 추천 회사 4곳, 확대해서 도시별로 보기', exact: true,
      })).toBeVisible()
    }
    await page.screenshot({ path: info.outputPath(`${mode}-latest-counts-while-still-held.png`) })
    await app.end()
    await app.finish()
  })

  test(`${mode}: native pointer-up releases only after the complete 120 ms idle debounce and keeps the selected city`, async ({ page, presentation: app }) => {
    await app.open({ mode })
    await app.hold()
    const receipt = await app.deliver(2)
    await app.until(receipt, 119)
    await expect(counts(page)).toHaveText(['1', '2'])
    await app.end()
    await app.advance(119)
    await expect(counts(page)).toHaveText(['1', '2'])
    await app.advance(1)
    await expect(counts(page)).toHaveText(['2', '3'])
    await expect(heading(page)).toContainText('런던')
    await expect(page.locator('.company-card h3')).toHaveText(['Aster Presentation', 'Birch Presentation'])
    await expect(page.locator('.city-coordinate')).toHaveText('51.51°N')
    expect((await app.control()).pointer.some(event => event.type === 'pointerup' && event.trusted)).toBe(true)
    await app.finish()
  })
}

test('an idle first catalog publishes on the zero-ms turn without waiting for the normal 120 ms debounce', async ({ page, presentation: app }) => {
  const initial: Route[] = []
  app.respondInitial(async route => { initial.push(route) })
  await app.open({ mode: 'flat', waitInitial: false })
  await expect(counts(page)).toHaveCount(0)
  expect(initial.length).toBeGreaterThan(0)
  await initial.at(-1)!.fulfill({ json: presentationCatalog(1, { complete: true }) })
  const receipt = await app.decoded(1)
  await app.advance(0)
  await expect(counts(page)).toHaveText(['1', '2'])
  expect(await page.evaluate(() => performance.now())).toBe(receipt.at)
  await expect(page.locator('.data-status-button')).toContainText('공개 채용')
})

test('2D loss of actual pointer capture releases a held pending catalog', async ({ page, presentation: app }) => {
  await app.open({ mode: 'flat' })
  await app.hold()
  await app.deliver(2)
  const pointerId = (await app.control()).pointer.at(-1)!.pointerId
  await page.locator('.flat-map svg').evaluate((element, id) => {
    if (!element.hasPointerCapture(id)) throw new Error('Expected real active pointer capture')
    element.releasePointerCapture(id)
  }, pointerId)
  // Move once so the browser dispatches the pending lostpointercapture event.
  await page.mouse.move(100, 180)
  await expect.poll(async () => (await app.control()).pointer.some(event => event.type === 'lostpointercapture')).toBe(true)
  await app.advance(119)
  await expect(counts(page)).toHaveText(['1', '2'])
  await app.advance(1)
  await expect(counts(page)).toHaveText(['2', '3'])
  await app.end()
  await app.finish()
})

test('a hidden-page lifecycle notification releases a 2D gesture and preserves its selected-city result', async ({ page, presentation: app }) => {
  await app.open({ mode: 'flat' })
  await app.hold()
  await app.deliver(2)
  try {
    // Synthetic lifecycle notification around a real held pointer. This tests
    // the browser listener boundary; no app callback or result is invoked.
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, value: true })
      document.dispatchEvent(new Event('visibilitychange'))
    })
    await app.advance(119)
    await expect(counts(page)).toHaveText(['1', '2'])
    await app.advance(1)
    await expect(counts(page)).toHaveText(['2', '3'])
    await expect(heading(page)).toContainText('런던')
  } finally {
    await page.evaluate(() => {
      Reflect.deleteProperty(document, 'hidden')
      document.dispatchEvent(new Event('visibilitychange'))
    })
    await app.end()
  }
  await app.finish()
})

test('3D keyboard camera tween defers incoming data and releases it after the tween ends before the hard deadline', async ({ page, presentation: app }) => {
  await app.open({ mode: 'globe' })
  const region = page.getByRole('region', { name: /^3D 기회 지도\./ })
  const before = await app.geometry()
  await region.focus()
  await page.keyboard.press('ArrowRight')
  const receipt = await app.deliver(2)
  await app.until(receipt, 300)
  expect(await app.geometry()).not.toEqual(before)
  await expect(counts(page)).toHaveText(['1', '2'])
  await app.until(receipt, 1000)
  await expect(counts(page)).toHaveText(['1', '2'])
  await app.until(receipt, 1400)
  await expect(counts(page)).toHaveText(['2', '3'])
  await expect(region).toBeFocused()
  await expect(page.locator('.city-coordinate')).toHaveText('51.51°N')
  await app.finish()
})

test('blur releases deferred data during a 3D tween while the camera still reaches its original destination', async ({ page, presentation: app }, info) => {
  await app.open({ mode: 'globe' })
  const region = page.getByRole('region', { name: /^3D 기회 지도\./ })
  const positions = () => page.locator('.globe-pin').evaluateAll(nodes => nodes.map(node => {
    const box = node.getBoundingClientRect()
    return { x: box.x, y: box.y }
  }))
  await region.focus()
  await page.keyboard.press('ArrowRight')
  await app.advance(1250)
  const intended = await positions()
  expect(intended.length).toBeGreaterThan(0)
  await page.keyboard.press('ArrowLeft')
  await app.advance(1250)
  await page.keyboard.press('ArrowRight')
  const receipt = await app.deliver(2)
  await app.until(receipt, 300)
  await expect(counts(page)).toHaveText(['1', '2'])
  await page.evaluate(() => window.dispatchEvent(new Event('blur')))
  await app.advance(120)
  await expect(counts(page)).toHaveText(['2', '3'])
  await app.advance(1000)
  const actual = await positions()
  expect(actual).toHaveLength(intended.length)
  for (const [index, point] of actual.entries()) {
    expect(point.x).toBeCloseTo(intended[index].x, 0)
    expect(point.y).toBeCloseTo(intended[index].y, 0)
  }
  await expect(heading(page)).toContainText('런던')
  await expect(page.locator('.city-coordinate')).toHaveText('51.51°N')
  await page.screenshot({ path: info.outputPath('blur-preserves-3d-camera-destination.png') })
  await app.finish()
})

for (const intent of ['query', 'profile', 'scope'] as const) {
  test(`explicit ${intent} immediately uses a decoded pending catalog while a genuine 3D gesture remains held`, async ({ page, presentation: app }) => {
    await app.open({ mode: 'globe' })
    await app.hold()
    const receipt = await app.deliver(2)
    await expect(counts(page)).toHaveText(['1', '2'])
    if (intent === 'query') {
      await query(page).fill('Birch')
      await expect(counts(page)).toHaveText(['1', '1'])
      await expect(page.locator('.company-card h3')).toHaveText(['Birch Presentation'])
      await expect(page.getByRole('button', { name: 'Backend Engineer — Birch London', exact: true })).toBeVisible()
      await expect(query(page)).toBeFocused()
    } else if (intent === 'profile') {
      await activateWithKeyboard(page.getByRole('button', { name: '내 프로필 편집', exact: true }))
      await page.getByLabel('개발 경력', { exact: true }).fill('9')
      await activateWithKeyboard(page.getByRole('button', { name: '변경 사항 적용', exact: true }))
      await expect(counts(page)).toHaveText(['2', '3'])
      await expect(page.locator('.company-card h3')).toHaveText(['Aster Presentation', 'Birch Presentation'])
      expect(await page.evaluate(() => JSON.parse(localStorage.getItem('orbit.v1.profile')!).years)).toBe(9)
    } else {
      await activateWithKeyboard(page.getByRole('button', { name: '모든 도시', exact: true }))
      await expect(london(page, 2)).toBeVisible()
      await expect(amsterdam(page, 2)).toBeVisible()
      await expect(heading(page)).toHaveCount(0)
    }
    expect(await page.evaluate(() => performance.now())).toBe(receipt.at)
    expect((await app.control()).pointer.at(-1)).toMatchObject({ type: 'pointerdown', buttons: 1, trusted: true })
    await app.end()
    await app.finish()
  })
}

test('the exact freshness-expiry boundary flushes a held receipt and removes expired jobs without waiting 1500 ms', async ({ page, presentation: app }) => {
  // Reach the wall-clock boundary before opening a new monitor request, so a
  // held HTTP response cannot hit the independent 30-second network timeout.
  await app.open({ mode: 'flat', expiringAster: true, completePrefix: true })
  await page.clock.pauseAt(new Date('2026-09-27T09:01:59.468Z'))
  await app.hold() // 32 controlled ms: receipt arrives at 09:01:59.500.
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
  await app.until(receipt, 500)
  // Exactly 24 hours remains valid. Aster is still the published prefix.
  await expect(counts(page)).toHaveText(['1', '2'])
  await app.advance(1)
  await expect(counts(page)).toHaveText(['1', '1'])
  await expect(page.locator('.company-card h3')).toHaveText(['Birch Presentation'])
  await expect(page.getByRole('button', { name: 'Backend Engineer — Aster London Alpha', exact: true })).toHaveCount(0)
  await expect(heading(page)).toContainText('런던')
  expect(await page.evaluate(() => Date.now())).toBe(Date.parse('2026-09-27T09:02:00.001Z'))
  await app.end()
  await app.advance(1000)
  await app.deliver(3, await app.take(2))
  await app.finish()
})

test('refresh loading transitions alone do not publish a pending catalog before the held-gesture deadline', async ({ page, presentation: app }) => {
  await app.open({ mode: 'flat', completePrefix: true })
  await expect(page.locator('.data-status-button')).toContainText('공개 채용')
  await app.hold()
  app.respondInitial(route => route.fulfill({
    status: 202, headers: { 'Retry-After': '1' },
    json: { catalog: presentationCatalog(2), progress: { id: PRESENTATION_COLLECTION, revision: 2, total: 4, completed: 2, done: false } },
  }))
  await activateWithKeyboard(page.locator('.data-status-button'))
  await activateWithKeyboard(page.getByRole('button', { name: '새로고침', exact: true }))
  await activateWithKeyboard(page.getByRole('button', { name: '닫기', exact: true }))
  const receipt = await app.decoded(2)
  await app.until(receipt, 1000)
  await expect(counts(page)).toHaveText(['1', '2'])
  await expect(page.locator('.data-status-button')).toContainText('공개 공고 조회 중')
  await app.deliver(3, await app.take(2))
  await app.until(receipt, 1499)
  await expect(counts(page)).toHaveText(['1', '2'])
  await expect(page.locator('.data-status-button')).toContainText('공개 공고 조회 중')
  await app.until(receipt, 1500)
  await expect(counts(page)).toHaveText(['4', '5'])
  await expect(page.locator('.data-status-button')).toContainText('공개 채용')
  expect((await app.control()).visible.filter(record => record.heading.startsWith('런던')).map(record => record.counts))
    .not.toContainEqual(['2', '3'])
  await app.end()
  await app.finish()
})

test('leaving exploration cancels deferred publication, and rejoining uses a new catalog without showing the cancelled intermediate', async ({ page, presentation: app }) => {
  await app.open({ mode: 'globe' })
  await app.hold()
  const pending = await app.deliver(2)
  await app.until(pending, 1000)
  const oldMonitor = await app.take(2)
  await activateWithKeyboard(page.getByRole('button', { name: '저장한 기회', exact: true }))
  await expect(page.getByRole('textbox', { name: '저장한 기회 검색', exact: true })).toBeVisible()
  await expect(page.locator('.earth-canvas')).toHaveCount(0)
  await app.end()
  await oldMonitor.fulfill({ json: presentationUpdate(3) }).catch(error => {
    if (oldMonitor.request().failure()?.errorText !== 'net::ERR_ABORTED') throw error
  })
  await app.advance(2000)
  await expect(page.getByRole('textbox', { name: '저장한 기회 검색', exact: true })).toBeVisible()
  app.respondInitial(route => route.fulfill({ json: presentationCatalog(3) }))
  await activateWithKeyboard(page.getByRole('button', { name: '기회 탐색', exact: true }))
  await expect(page.locator('.earth-canvas')).toHaveClass(/is-ready/)
  await app.advance(1500)
  await expect(counts(page)).toHaveText(['4', '5'])
  await expect(heading(page)).toContainText('런던')
  await expect(page.locator('.city-coordinate')).toHaveText('51.51°N')
  await expect(page.locator('.collection-progress')).toHaveCount(0)
  await expect(page.locator('.catalog-notice').filter({ hasText: '취소' })).toHaveCount(0)
  expect((await app.control()).visible.filter(record => record.heading.startsWith('런던')).map(record => record.counts))
    .not.toContainEqual(['2', '3'])
})

test('a final monitor error waits for the deferred valid prefix, then reports failure without clearing selected results', async ({ page, presentation: app }) => {
  await app.open({ mode: 'flat' })
  await app.hold()
  const receipt = await app.deliver(2)
  await app.until(receipt, 1000)
  await (await app.take(2)).fulfill({
    status: 503, json: { error: 'Fictional Stage68 final monitor failed.', code: 'CATALOG_UNAVAILABLE' },
  })
  await expect.poll(async () => (await app.control()).replies.some(reply => reply.error === 'CATALOG_UNAVAILABLE')).toBe(true)
  await app.until(receipt, 1499)
  await expect(counts(page)).toHaveText(['1', '2'])
  await expect(page.locator('.data-status-button')).toContainText('공개 공고 조회 중')
  await app.until(receipt, 1500)
  await expect(counts(page)).toHaveText(['2', '3'])
  await expect(page.locator('.company-card h3')).toHaveText(['Aster Presentation', 'Birch Presentation'])
  await expect(page.locator('.catalog-notice')).toContainText('Fictional Stage68 final monitor failed.')
  await expect(page.locator('.data-status-button')).not.toContainText('조회 중')
  await expect(heading(page)).toContainText('런던')
  expect((await app.control()).pointer.at(-1)).toMatchObject({ type: 'pointerdown', buttons: 1, trusted: true })
  await app.end()
  await app.advance(3000)
  await expect(counts(page)).toHaveText(['2', '3'])
  expect(app.traffic.filter(request => request.path === '/api/catalog?source=public&refresh=1')).toEqual([])
})

test('a genuine newer worker decode can supersede a deferred receipt without error UI or loss of the later final catalog', async ({ page, presentation: app }) => {
  await app.open({ mode: 'flat' })
  await app.hold()
  const second = await app.deliver(2)
  await app.until(second, 1000)
  await app.holdDecoded()
  await app.deliver(3, await app.take(2))
  expect((await app.control()).held).toEqual([3])
  // The worker really decoded revision 3 and pruned unacknowledged revision 2.
  // Only delivery of its genuine receipt is held; project(2) must now fail
  // naturally with CATALOG_SUPERSEDED rather than an injected fake error.
  await app.until(second, 1500)
  await expect.poll(async () => (await app.control()).replies.some(reply => reply.error === 'CATALOG_SUPERSEDED')).toBe(true)
  await expect(counts(page)).toHaveText(['1', '2'])
  await expect(page.locator('.catalog-notice').filter({ hasText: '더 최신 공고' })).toHaveCount(0)
  await app.releaseDecoded(3)
  await app.end()
  await app.advance(120)
  await expect(counts(page)).toHaveText(['4', '5'])
  await expect(page.locator('.company-card h3')).toHaveText(PRESENTATION_EXPECTED.londonNames[2])
  await expect(page.locator('.collection-progress')).toHaveCount(0)
  await expect(page.locator('.data-status-button')).toContainText('공개 채용')
  expect((await app.control()).held).toEqual([])
  expect((await app.control()).visible.filter(record => record.heading.startsWith('런던')).map(record => record.counts))
    .not.toContainEqual(['2', '3'])
})
