import { expect } from '@playwright/test'
import type { Locator, Page, TestInfo } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { writeFile } from 'node:fs/promises'
import type { Filters, SavedJob } from '../../../shared/types'
import { COVERAGE_FILTERS, COVERAGE_PROFILE } from '../../fixtures/public-coverage'
import { SURVEY_NOW } from '../../fixtures/public-company-survey'
import { watchApiRequests } from './api-requests'
import { waitForSavedCommit } from './saved-store'

export const surveySearch = (page: Page) => page.getByRole('textbox', { name: '도시, 회사 또는 포지션 검색', exact: true })
export const surveyDataButton = (page: Page) => page.getByRole('button', { name: '데이터와 추천 방식', exact: true })
export const surveyNavigation = (page: Page) => page.getByRole('navigation', { name: '주요 메뉴' })

export async function seedSurvey(page: Page, origin: string, options: {
  saved?: SavedJob[]; source?: 'public' | 'sample'; clock?: string
  selectedId?: string | null; query?: string; route?: boolean; hash?: string
} = {}) {
  const traffic = watchApiRequests(page)
  const errors: string[] = [], external: string[] = [], failedResources: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('request', request => {
    if (new URL(request.url()).origin !== origin) external.push(request.url())
  })
  page.on('response', response => {
    if (response.status() >= 400) failedResources.push(`${response.status()} ${response.url()}`)
  })
  // A caller testing the browser HTTP cache must explicitly omit routing.
  if (options.route !== false) await page.route('**/*', route =>
    new URL(route.request().url()).origin === origin ? route.fallback() : route.abort('blockedbyclient'))
  await page.clock.install({ time: new Date(options.clock ?? SURVEY_NOW) })
  await page.addInitScript(({ origin, profile, saved, exploration }) => {
    if (location.origin !== origin || sessionStorage.getItem('survey61-seeded')) return
    localStorage.setItem('orbit.v1.profile', JSON.stringify(profile))
    localStorage.setItem('orbit.v1.saved', JSON.stringify(saved))
    localStorage.setItem('orbit.v1.exploration', JSON.stringify(exploration))
    sessionStorage.setItem('survey61-seeded', 'true')
  }, {
    origin, profile: COVERAGE_PROFILE, saved: options.saved ?? [],
    exploration: {
      source: options.source ?? 'public', selectedId: options.selectedId === undefined ? 'seoul' : options.selectedId,
      panelTab: 'cities', mapMode: 'flat', citySort: 'companies', light: false,
      filters: { ...COVERAGE_FILTERS, query: options.query ?? '' },
    },
  })
  await page.goto(`${origin}/${options.hash ?? ''}`)
  await waitForSavedCommit(page)
  return { traffic, errors, external, failedResources }
}

export async function surveyJson<T>(page: Page, origin: string, resource: string): Promise<T> {
  const response = await page.request.get(`${origin}${resource}`)
  try {
    expect(response.status()).toBe(200)
    return await response.json()
  } finally { await response.dispose() }
}

export async function surveyClose(page: Page, opener: Locator) {
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(opener).toBeFocused()
}

export async function surveyRole(page: Page, role: Filters['role'], openings: number) {
  const opener = page.getByRole('button', { name: /^모든 필터/ })
  await opener.click()
  await page.getByLabel('직무', { exact: true }).selectOption(role)
  await page.getByRole('button', { name: `${openings}개 공고 보기`, exact: true }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(opener).toBeFocused()
}

export function expectSurveyPrivacy(state: Awaited<ReturnType<typeof seedSurvey>>, origin: string) {
  expect(state.errors).toEqual([])
  expect(state.external).toEqual([])
  expect(state.failedResources).toEqual([])
  for (const request of state.traffic.requests) {
    const url = new URL(request.url)
    expect(url.origin).toBe(origin)
    expect(request.method).toBe('GET')
    expect(request.body).toBeNull()
    expect(['/api/catalog', '/api/catalog/progress', '/api/posting-status', '/api/observations']).toContain(url.pathname)
    for (const parameter of url.searchParams.keys())
      expect(['source', 'refresh', 'content', 'id', 'after']).toContain(parameter)
  }
}

/** Save the actual viewport, never a stitched full-page image as mobile proof. */
export async function surveyImage(page: Page, info: TestInfo, name: string) {
  const viewport = await page.evaluate(() => ({
    width: innerWidth, height: innerHeight, dpr: devicePixelRatio,
    documentWidth: document.documentElement.scrollWidth,
    dialogs: [...document.querySelectorAll('[role="dialog"]')].map(element => ({
      width: element.clientWidth, scrollWidth: element.scrollWidth,
    })),
  }))
  expect(viewport.width).toBe(page.viewportSize()!.width)
  expect(viewport.height).toBe(page.viewportSize()!.height)
  expect(viewport.documentWidth).toBeLessThanOrEqual(viewport.width)
  for (const dialog of viewport.dialogs) expect(dialog.scrollWidth).toBeLessThanOrEqual(dialog.width)
  const axe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze()
  await writeFile(info.outputPath(`${name}-viewport.json`), JSON.stringify({ viewport, axe }, null, 2))
  await page.screenshot({ path: info.outputPath(`${name}.png`), fullPage: false })
  expect(axe.violations).toEqual([])
}
