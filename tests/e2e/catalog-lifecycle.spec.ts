import { expect, test } from '@playwright/test'
import type { Page, Route } from '@playwright/test'
import { DEFAULT_FILTERS } from '../../shared/types'
import { searchCatalog, searchJob, SEARCH_PROFILE, SEARCH_TIME } from '../fixtures/search-catalog'
import { expectInitialCatalogRequest, watchApiRequests } from './helpers/api-requests'

async function restore(page: Page) {
  await page.clock.install({ time: new Date(SEARCH_TIME) })
  await page.addInitScript(({ profile, filters }) => {
    localStorage.setItem('orbit.v1.profile', JSON.stringify(profile))
    localStorage.setItem('orbit.v1.exploration', JSON.stringify({
      source: 'public', selectedId: 'london', mapMode: 'flat', filters,
    }))
  }, { profile: SEARCH_PROFILE, filters: DEFAULT_FILTERS })
  await page.goto('/')
  await expect(page.getByRole('button', { name: '공개 공고 조회 중', exact: true })).toBeVisible()
}

test('initial load finishes once and a canceled development response cannot replace the current catalog', async ({ page }) => {
  const traffic = watchApiRequests(page)
  const held: Route[] = []
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.route('**/api/catalog?source=public*', route => { held.push(route) })
  await restore(page)
  await expect.poll(() => held.filter(route => !route.request().failure()).length).toBe(1)
  const active = held.find(route => !route.request().failure())!
  const current = searchJob('CurrentArrival')
  await active.fulfill({ json: searchCatalog([current]) })
  const initial = await expectInitialCatalogRequest(page, traffic)
  await expect(page.locator('.mini-job-title')).toHaveText([current.title])
  await page.getByLabel('도시, 회사 또는 포지션 검색').fill('CurrentArrival')

  // An intercepted, already-canceled development request may still finish its
  // server work later. Deliver different data after the active request settles.
  for (const route of held.filter(route => route !== active)) {
    expect(route.request().failure()?.errorText).toBe('net::ERR_ABORTED')
    await route.fulfill({ json: searchCatalog([searchJob('OldArrival')]) })
  }
  await page.clock.fastForward(120000)
  await expect(page.locator('.mini-job-title')).toHaveText([current.title])
  await expect(page.getByLabel('도시, 회사 또는 포지션 검색')).toHaveValue('CurrentArrival')
  await expect(page.getByRole('button', { name: '공개 채용', exact: true })).toBeVisible()
  await expect(page.locator('.catalog-notice, .collection-progress')).toHaveCount(0)
  expect(traffic.requests).toHaveLength(initial.attempts)
  expect(errors).toEqual([])
})
