import { expect } from '@playwright/test'
import type { Page } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import type { CatalogCollectionSnapshot, CatalogCollectionUpdate } from '../../shared/catalog-progress'
import type { BoardStatus, Catalog } from '../../shared/types'
import { DEFAULT_FILTERS } from '../../shared/types'
import { PUBLIC_TEST_CITIES as CITIES } from '../fixtures/public-geography'
import { PUBLIC_PROTOCOL_COMPANIES, publicProtocolJob } from '../fixtures/public-protocol'
import { resourceCheckedTest as test } from './helpers/public-app'
import { watchApiRequests } from './helpers/api-requests'

// Authored catalog JSON reaches the real request pipeline, worker and views.
// These cases pin the client contract: explicit null history, legacy undefined
// resolved from the company's own job dates, the deferred error row, the
// accurate refresh announcement, and run-only progress wording.
const current = '2026-10-01T07:00:00.000Z'
const olderOwnJob = '2026-10-01T06:50:00.000Z'
const attempt = '2026-10-01T06:59:00.000Z'
const retry = '2026-10-01T07:09:00.000Z'
/** A later accepted list check moved the aggregate attempt past every body success. */
const aggregate = '2026-10-01T07:03:00.000Z'
/** The browser clock sits after every fixture time so nothing is in the future except the retry deadline. */
const browserNow = '2026-10-01T07:05:00.000Z'
/** Literal ko-KR renderings of the fixture times in the pinned UTC timezone; no product formatter is used. */
const TEXT = {
  success: '2026. 10. 01. 07:00', legacyOwn: '2026. 10. 01. 06:50', attempt: '2026. 10. 01. 06:59',
  retry: '2026. 10. 01. 07:09', aggregate: '2026. 10. 01. 07:03',
} as const
const COLLECTION_ID = '00000000-0000-4000-8000-000000000074'
const [aster, cedar, mosaic] = PUBLIC_PROTOCOL_COMPANIES
const identity = (company: typeof aster) => ({ companyId: company.id, board: company.board!, provider: 'greenhouse' as const })
const asterJob = publicProtocolJob('ledger', { title: 'Backend Engineer — Aster Transit Ledger', fetchedAt: current })
const mosaicLegacyJob = publicProtocolJob('legacy', {
  id: 'greenhouse-fixture-mosaic-clinic-legacy', companyId: mosaic.id, title: 'Backend Engineer — Mosaic Clinic Legacy', fetchedAt: olderOwnJob,
})
const asterFresh: BoardStatus = { ...identity(aster), status: 'ok', dataStatus: 'fresh', total: 1, included: 1, checkedAt: current, lastSuccessAt: current }
/** The pre-fix server shape: no failure, explicit null history. */
const cedarNullHistory: BoardStatus = { ...identity(cedar), status: 'ok', dataStatus: 'unavailable', total: 0, included: 0, lastSuccessAt: null }
/** A legacy response without per-company timestamps. */
const mosaicLegacy: BoardStatus = { ...identity(mosaic), status: 'ok', dataStatus: 'fresh', total: 1, included: 1 }
/** The agreed deferred failure row. */
const cedarDeferred: BoardStatus = {
  ...identity(cedar), status: 'error', dataStatus: 'unavailable', total: 0, included: 0,
  checkedAt: attempt, lastSuccessAt: null, retryAt: retry, message: 'Fictional public list 503',
}
const mosaicFresh: BoardStatus = { ...identity(mosaic), status: 'ok', dataStatus: 'fresh', total: 1, included: 1, checkedAt: current, lastSuccessAt: current }

function catalog(boards: BoardStatus[], jobs: Catalog['jobs'], options: { checkedAt?: string } = {}): Catalog {
  return {
    source: 'public', fetchedAt: current, checkedAt: options.checkedAt ?? current, stale: false,
    cities: CITIES, companies: PUBLIC_PROTOCOL_COMPANIES, jobs, unmappedCount: 0, boards,
  }
}
const legacyShapes = () => catalog([asterFresh, cedarNullHistory, mosaicLegacy], [asterJob, mosaicLegacyJob])
const deferredShape = () => catalog([asterFresh, cedarDeferred, mosaicFresh], [asterJob, publicProtocolJob('clinic', {
  id: 'greenhouse-fixture-mosaic-clinic-current', companyId: mosaic.id, title: 'Backend Engineer — Mosaic Clinic Current', fetchedAt: current,
})], { checkedAt: aggregate })
function collecting(): CatalogCollectionSnapshot {
  return {
    catalog: {
      source: 'public', fetchedAt: '', stale: false, cities: CITIES, companies: [aster, cedar], jobs: [], unmappedCount: 0, checkedAt: attempt,
      boards: [{ ...identity(aster), status: 'pending', dataStatus: 'unavailable', total: 0, included: 0, lastSuccessAt: null }, cedarDeferred],
    },
    progress: { id: COLLECTION_ID, revision: 0, total: 1, completed: 0, done: false },
  }
}
function collected(): CatalogCollectionUpdate {
  return {
    progress: { id: COLLECTION_ID, revision: 1, total: 1, completed: 1, done: true },
    companyIds: [aster.id], jobs: [asterJob],
    catalog: { source: 'public', fetchedAt: current, stale: false, unmappedCount: 0, checkedAt: current, boards: [asterFresh, cedarDeferred] },
  }
}

const search = (page: Page) => page.getByRole('textbox', { name: '도시, 회사 또는 포지션 검색', exact: true })
const row = (page: Page, company: string) => page.getByRole('dialog').locator('.board-row').filter({ hasText: company })
const lastSuccess = (page: Page, company: string) => row(page, company).locator('p').filter({ hasText: '마지막 정상 확인' }).locator('time')

async function restore(page: Page) {
  await page.clock.install({ time: new Date(browserNow) })
  await page.addInitScript(filters => {
    localStorage.setItem('orbit.v1.exploration', JSON.stringify({
      source: 'public', selectedId: 'london', mapMode: 'flat', panelTab: 'cities', filters: { ...filters, query: 'Backend' },
    }))
  }, DEFAULT_FILTERS)
  await page.goto('/')
}
async function audit(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  for (const dialog of await page.getByRole('dialog').all()) {
    expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
  }
  expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([])
}
function onlyCatalogTraffic(traffic: ReturnType<typeof watchApiRequests>, allowed: string[]) {
  for (const request of traffic.requests) {
    const url = new URL(request.url)
    expect(request.method).toBe('GET')
    expect(request.body).toBeNull()
    expect(allowed.some(prefix => (url.pathname + url.search).startsWith(prefix))).toBe(true)
  }
}

for (const width of [1440, 320]) test.describe(`board history provenance at ${width}px`, () => {
  // UTC keeps the rendered ko-KR times equal to the fixture's ISO hours and minutes.
  test.use({ viewport: { width, height: 960 }, isMobile: width === 320, hasTouch: width === 320, timezoneId: 'UTC' })

  test('explicit null history shows no time while a legacy record resolves to its own older job time, never another company\'s', async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    const traffic = watchApiRequests(page)
    await page.route('**/api/catalog?source=public*', route => route.fulfill({ json: legacyShapes() }))
    await restore(page)
    await expect(page.locator('.company-card')).toHaveCount(2)
    await expect(page.locator('.panel-data-footer')).toContainText('일부 게시판 · 조회 상태 확인')
    await page.getByRole('button', { name: '공개 채용', exact: true }).click()
    await expect(row(page, 'Cedar Loom')).toContainText('데이터 미확인')
    await expect(lastSuccess(page, 'Cedar Loom')).toHaveText('확인 기록 없음')
    expect(await lastSuccess(page, 'Cedar Loom').getAttribute('datetime')).toBeNull()
    await expect(row(page, 'Cedar Loom').locator('.board-error-detail')).toHaveCount(0)
    await expect(row(page, 'Mosaic Clinic')).toContainText('1개 반영')
    await expect(lastSuccess(page, 'Mosaic Clinic')).toHaveAttribute('datetime', olderOwnJob)
    await expect(lastSuccess(page, 'Mosaic Clinic')).toHaveText(TEXT.legacyOwn)
    await expect(row(page, 'Aster Transit')).toContainText('1개 반영')
    await expect(lastSuccess(page, 'Aster Transit')).toHaveAttribute('datetime', current)
    await expect(lastSuccess(page, 'Aster Transit')).toHaveText(TEXT.success)
    await expect(page.getByRole('dialog').locator('.collection-health dd')).toHaveText(['2개 공고', '0개 공고', '1개'])
    await expect(page.getByRole('dialog').locator('.board-section .field-description')).toContainText(`최근 게시판 조회 시도 · ${TEXT.success}`)
    await audit(page)
    await page.getByRole('button', { name: '닫기', exact: true }).click()
    await expect(search(page)).toHaveValue('Backend')
    onlyCatalogTraffic(traffic, ['/api/catalog?source=public'])
    expect(errors).toEqual([])
  })

  test('a deferred list failure row shows its own failure, attempt and retry times, and a refresh announces the accurate count', async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    const traffic = watchApiRequests(page)
    await page.route('**/api/catalog?source=public*', route => route.fulfill({ json: deferredShape() }))
    await restore(page)
    await expect(page.locator('.company-card')).toHaveCount(2)
    await expect(page.locator('.catalog-notice')).toContainText('일부 게시판의 최신 공고를 확인하지 못했어요.')
    await expect(page.locator('.catalog-notice')).toContainText('이전 조회 공고 0개를 포함합니다. 1개 회사는 확인 가능한 공고가 없어요.')
    await expect(page.locator('.catalog-notice').getByRole('button', { name: '조회 상태', exact: true })).toBeVisible()
    await expect(page.locator('.panel-data-footer')).toContainText('일부 게시판 · 조회 상태 확인')
    await page.getByRole('button', { name: '공개 채용', exact: true }).click()
    const cedarRow = row(page, 'Cedar Loom')
    await expect(cedarRow).toContainText('데이터 미확인')
    await expect(lastSuccess(page, 'Cedar Loom')).toHaveText('확인 기록 없음')
    expect(await lastSuccess(page, 'Cedar Loom').getAttribute('datetime')).toBeNull()
    await expect(cedarRow.locator('.board-error-detail')).toContainText('재조회 실패 · Fictional public list 503')
    // Three distinct rendered times: the row's own failed attempt, its retry deadline,
    // and the catalog-wide latest attempt, none of them a company's success time.
    await expect(cedarRow.locator('.board-error-detail')).toContainText(`조회 시도 · ${TEXT.attempt}`)
    await expect(cedarRow.locator('.board-error-detail')).toContainText(`${TEXT.retry} 이후 재시도`)
    await expect(cedarRow.locator('.board-error-detail time')).toHaveAttribute('datetime', retry)
    await expect(lastSuccess(page, 'Aster Transit')).toHaveAttribute('datetime', current)
    await expect(lastSuccess(page, 'Aster Transit')).toHaveText(TEXT.success)
    await expect(lastSuccess(page, 'Mosaic Clinic')).toHaveText(TEXT.success)
    await expect(page.getByRole('dialog').locator('.board-section .field-description')).toContainText(`최근 게시판 조회 시도 · ${TEXT.aggregate}`)
    await expect(page.getByRole('dialog').locator('.board-section .field-description')).not.toContainText(TEXT.success)
    await expect(page.getByRole('dialog').locator('.collection-health dd')).toHaveText(['2개 공고', '0개 공고', '1개'])
    await audit(page)
    const refreshed = page.waitForResponse(response => {
      const url = new URL(response.url())
      return url.pathname === '/api/catalog' && url.searchParams.get('refresh') === '1'
    })
    await page.getByRole('dialog').locator('.board-heading').getByRole('button', { name: /^새로고침/ }).click()
    expect((await refreshed).status()).toBe(200)
    await expect(page.locator('.toast')).toContainText('1개 게시판 연결 확인이 필요해요. 이전 조회 공고 0개를 유지했어요.')
    await expect(cedarRow.locator('.board-error-detail')).toContainText('Fictional public list 503')
    await page.getByRole('button', { name: '닫기', exact: true }).click()
    await expect(page.locator('.company-card')).toHaveCount(2)
    await expect(search(page)).toHaveValue('Backend')
    expect(JSON.parse(await page.evaluate(() => localStorage.getItem('orbit.v1.exploration') ?? '{}'))).toMatchObject({
      source: 'public', selectedId: 'london', filters: { query: 'Backend' },
    })
    onlyCatalogTraffic(traffic, ['/api/catalog?source=public'])
    expect(errors).toEqual([])
  })

  test('progress reads only this run\'s counts while the deferred failure is stated separately as the current state', async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    const traffic = watchApiRequests(page)
    let released = false
    await page.route('**/api/catalog?source=public*', route => route.fulfill({ status: 202, headers: { 'Retry-After': '1' }, json: collecting() }))
    await page.route('**/api/catalog/progress?*', route => released ? route.fulfill({ json: collected() }) : route.fulfill({ status: 204 }))
    await restore(page)
    const progress = page.getByRole('progressbar', { name: '공개 게시판 조회 진행' })
    await expect(progress).toHaveAttribute('value', '0')
    await expect(progress).toHaveAttribute('aria-valuetext', '1개 회사 중 0개 조회 종료')
    await expect(page.locator('.collection-progress-failed')).toHaveText('현재 조회 실패 상태인 회사는 1개입니다. 회사별 조회 기록에서 확인할 수 있습니다.')
    const remaining = page.locator('.collection-progress-remaining').filter({ hasText: '확인 중' })
    await expect(remaining).toContainText('확인 중 · Aster Transit')
    await expect(remaining).not.toContainText('Cedar Loom')
    await expect(page.locator('.panel-data-footer')).toContainText('회사별 수집 진행 확인')
    await page.getByRole('button', { name: '공개 공고 조회 중', exact: true }).click()
    await expect(page.getByRole('dialog').getByRole('progressbar')).toHaveAttribute('aria-valuetext', '1개 회사 중 0개 조회 종료')
    await expect(row(page, 'Aster Transit')).toContainText('조회 중')
    await expect(row(page, 'Aster Transit').locator('.board-error-detail')).toHaveCount(0)
    await expect(row(page, 'Cedar Loom')).toContainText('데이터 미확인')
    await expect(row(page, 'Cedar Loom').locator('.board-error-detail')).toContainText('재조회 실패 · Fictional public list 503')
    await expect(row(page, 'Cedar Loom').locator('.board-error-detail')).toContainText(`조회 시도 · ${TEXT.attempt}`)
    await expect(lastSuccess(page, 'Cedar Loom')).toHaveText('확인 기록 없음')
    // While only the failed check has happened, the aggregate attempt is that failure's time.
    await expect(page.getByRole('dialog').locator('.board-section .field-description')).toContainText(`최근 게시판 조회 시도 · ${TEXT.attempt}`)
    await audit(page)
    await page.getByRole('button', { name: '닫기', exact: true }).click()
    released = true
    await page.clock.fastForward(1100)
    await expect(page.getByRole('progressbar')).toHaveCount(0)
    await expect(page.locator('.company-card')).toHaveCount(1)
    await expect(page.locator('.panel-data-footer')).toContainText('일부 게시판 · 조회 상태 확인')
    await page.getByRole('button', { name: '공개 채용', exact: true }).click()
    await expect(page.getByRole('dialog').locator('.collection-health dd')).toHaveText(['1개 공고', '0개 공고', '1개'])
    await expect(page.getByRole('dialog').locator('.retry-note').filter({ hasText: '진행 상태가 미확인' })).toHaveCount(0)
    await expect(row(page, 'Cedar Loom').locator('.board-error-detail')).toContainText('Fictional public list 503')
    await expect(row(page, 'Cedar Loom').locator('.board-error-detail')).toContainText(`조회 시도 · ${TEXT.attempt}`)
    await expect(lastSuccess(page, 'Aster Transit')).toHaveAttribute('datetime', current)
    await expect(lastSuccess(page, 'Aster Transit')).toHaveText(TEXT.success)
    // After Alder's collection the aggregate is that newer success, still distinct from Cedar's failed attempt.
    await expect(page.getByRole('dialog').locator('.board-section .field-description')).toContainText(`최근 게시판 조회 시도 · ${TEXT.success}`)
    await page.getByRole('button', { name: '닫기', exact: true }).click()
    await expect(search(page)).toHaveValue('Backend')
    onlyCatalogTraffic(traffic, ['/api/catalog?source=public', `/api/catalog/progress?id=${COLLECTION_ID}&after=`])
    expect(errors).toEqual([])
  })
})
