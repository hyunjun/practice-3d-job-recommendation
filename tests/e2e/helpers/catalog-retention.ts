import { expect } from '@playwright/test'
import type { Page } from '@playwright/test'
import type { Catalog } from '../../../shared/types'

/** Literal copy from contract 설계 1 §요청한 조건과 실제 계산한 조건 and the worker client. */
export const WORKER_FAILURE_MESSAGE = '공고 처리 연결이 끊겼어요. 도착한 공고와 저장 기록은 유지됩니다. 다시 조회해 주세요.'
export const UNAVAILABLE_TITLE = '새 조건의 추천을 확인하지 못했어요'
export const RECOVERING_TITLE = '새 조건의 추천을 준비하고 있어요'
export const UNAVAILABLE_TEXT = '입력한 조건과 선택한 도시는 유지됩니다. 다시 조회한 뒤 추천을 확인해 주세요.'
export const EXPIRED_TITLE = '공고를 다시 확인해 주세요'
export const AGE_NOTICE = '공고를 다시 확인할 시간이 됐어요.'

/** Worker-fixture cutoffs: 08:00:00/01/02 on 2026-09-24, plus 24 hours and one millisecond. */
export const ASTER_EXACT_24H = '2026-09-25T08:00:00.000Z'
export const ASTER_EXPIRES = '2026-09-25T08:00:00.001Z'
export const BIRCH_EXPIRES = '2026-09-25T08:00:01.001Z'
export const CEDAR_EXPIRES = '2026-09-25T08:00:02.001Z'
/** Keeps automatic foreground revalidation gated so only explicit retries reach the server. */
export const FAR_REFRESH_AFTER = '2026-09-26T08:00:00.000Z'

export function withRefreshAfter(catalog: Catalog, refreshAfter: string): Catalog {
  return { ...catalog, refreshAfter }
}

/** Move every source time of an authored catalog to one instant; nothing else changes. */
export function retimed(catalog: Catalog, time: string): Catalog {
  return {
    ...catalog, fetchedAt: time, ...(catalog.checkedAt ? { checkedAt: time } : {}),
    jobs: catalog.jobs.map(job => ({ ...job, fetchedAt: time })),
    boards: catalog.boards.map(board => ({
      ...board,
      ...(board.checkedAt ? { checkedAt: time } : {}),
      ...(board.lastSuccessAt ? { lastSuccessAt: time } : {}),
    })),
  }
}

/**
 * Raise a genuine uncaught exception inside the live catalog worker. The
 * browser dispatches the native Worker error event; no app callback or result
 * is replaced. This is browser event control, not an OS-level crash claim.
 */
export async function crashCatalogWorker(page: Page) {
  await expect.poll(() => page.workers().filter(worker => /catalog\.worker/.test(worker.url())).length).toBe(1)
  const worker = page.workers().find(worker => /catalog\.worker/.test(worker.url()))!
  await worker.evaluate(() => { setTimeout(() => { throw new Error('Fictional Stage73 worker crash.') }, 0) })
}

export async function expectRetainedNotice(page: Page) {
  await expect(page.locator('.catalog-notice')).toContainText(WORKER_FAILURE_MESSAGE)
  await expect(page.locator('.catalog-collecting progress, .collection-progress')).toHaveCount(0)
}

/** Contract: inputs stay, lists/markers/comparison are withheld, counts show a dash rather than 0. */
export async function expectRecommendationsUnavailable(page: Page, title = UNAVAILABLE_TITLE) {
  await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible()
  await expect(page.getByText(UNAVAILABLE_TEXT, { exact: true })).toBeVisible()
  await expect(page.locator('.map-stats strong')).toHaveText(['—곳', '—곳'])
  await expect(page.locator('.results-tabs button span')).toHaveText(['—', '—', '—'])
  await expect(page.locator('.company-card, .city-row, .flat-marker, .globe-pin, .search-recovery, .recovery-option, .comparison-table')).toHaveCount(0)
  await expect(page.locator('.active-filter-summary').filter({ hasText: /\d+개 공고가 현재 조건에 맞아요/ })).toHaveCount(0)
}

export async function expectCompareUnavailable(page: Page, title = UNAVAILABLE_TITLE) {
  await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible()
  await expect(page.locator('.comparison-table, .compare-empty-cards button')).toHaveCount(0)
}
