import { expect } from '@playwright/test'
import type { Page, Route, TestInfo } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { writeFile } from 'node:fs/promises'
import {
  SOURCE_TIME, SOURCE_PROFILE, SOURCE_EXPLORATION, SOURCE_SAVED, SOURCE_NOTE,
  sourceCatalog, sourcePartial, sourceDelta,
} from '../fixtures/catalog-source-selection'
import { expectInitialCatalogRequest, readServerMode, watchApiRequests } from './helpers/api-requests'
import { readSavedJson, waitForSavedCommit } from './helpers/saved-store'
import { expectPublicOnlyDialog, resourceCheckedTest as test } from './helpers/public-app'

// This retains all five Stage49/52 flows at both widths. Source-toggle actions
// migrate to automatic public startup, public refresh or saved-page cancellation.
const ordinary = '/api/catalog?source=public'
const forced = '/api/catalog?source=public&refresh=1'
const monitor = '/api/catalog/progress?id=00000000-0000-4000-8000-000000000049&after=1'
type Reply = (route: Route) => Promise<void> | void
const query = (page: Page) => page.getByRole('textbox', { name: '도시, 회사 또는 포지션 검색', exact: true })
const metric = (page: Page, label: string) => page.getByRole('row').filter({
  has: page.getByRole('rowheader').filter({ hasText: new RegExp(`^${label}`) }),
}).getByRole('cell')

async function contextState(page: Page) {
  return {
    ...await page.evaluate(() => ({
      profile: localStorage.getItem('orbit.v1.profile'),
      exploration: JSON.parse(localStorage.getItem('orbit.v1.exploration') ?? '{}'),
      compare: JSON.parse(localStorage.getItem('orbit.v1.compare') ?? '[]'),
    })),
    saved: await readSavedJson(page),
  }
}

async function setup(page: Page, options: {
  view?: 'explore' | 'compare' | 'saved'; reply?: Reply; legacySource?: 'sample' | 'greenhouse'
} = {}) {
  const traffic = watchApiRequests(page)
  const failures = { pageErrors: [] as string[], failedResources: [] as string[], unexpectedRequests: [] as string[] }
  let reply: Reply = options.reply ?? (route => route.fulfill({ json: sourceCatalog() }))
  let progress: Reply = route => route.fulfill({ status: 500, json: { error: 'Unexpected public49 monitor' } })
  const origin = new URL(test.info().project.use.baseURL!).origin
  page.on('pageerror', error => failures.pageErrors.push(error.message))
  page.on('response', response => {
    if (!new URL(response.url()).pathname.startsWith('/api/') && response.status() >= 400)
      failures.failedResources.push(`${response.status()} ${response.url()}`)
  })
  page.on('requestfailed', request => {
    if (!new URL(request.url()).pathname.startsWith('/api/') && request.failure()?.errorText !== 'net::ERR_ABORTED')
      failures.failedResources.push(`${request.failure()?.errorText} ${request.url()}`)
  })
  await page.route('**/*', route => {
    const target = new URL(route.request().url()), key = target.pathname + target.search
    if (target.origin !== origin) {
      failures.unexpectedRequests.push(target.href)
      return route.abort('blockedbyclient')
    }
    if (key === '/__source49-seed') return route.fulfill({
      contentType: 'text/html', body: '<!doctype html><title>Once-only synthetic storage</title>',
    })
    if (key === ordinary || key === forced) return reply(route)
    if (key === monitor) return progress(route)
    if (target.pathname.startsWith('/api/')) {
      failures.unexpectedRequests.push(`${route.request().method()} ${key}`)
      return route.abort('blockedbyclient')
    }
    return route.fallback()
  })
  await page.clock.setFixedTime(new Date(SOURCE_TIME))
  // Seed once, before app startup. Reloads and revisits cannot recreate fixtures.
  await page.goto('/__source49-seed')
  await page.evaluate(seed => {
    localStorage.setItem('orbit.v1.profile', JSON.stringify(seed.profile))
    localStorage.setItem('orbit.v1.exploration', JSON.stringify(seed.exploration))
    localStorage.setItem('orbit.v1.compare', JSON.stringify(['london', 'berlin']))
    localStorage.setItem('orbit.v1.saved', JSON.stringify(seed.saved))
  }, {
    profile: SOURCE_PROFILE, exploration: { ...SOURCE_EXPLORATION, source: options.legacySource ?? 'public' }, saved: SOURCE_SAVED,
  })
  await page.goto(options.view === 'compare' ? '/#compare' : options.view === 'saved' ? '/#saved' : '/')
  await waitForSavedCommit(page)
  const before = await contextState(page)
  expect(before.exploration).toEqual(SOURCE_EXPLORATION)
  expect(before.compare).toEqual(['london', 'berlin'])
  if (options.view === 'saved') expect(traffic.requests).toEqual([])
  return {
    traffic, failures, before, expectedAborts: 0, seedWrites: 1,
    blockedInputs: [] as { phase: string; catalogRequests: number }[],
    respond(handler: Reply) { reply = handler },
    monitor(handler: Reply) { progress = handler },
  }
}

type State = Awaited<ReturnType<typeof setup>>
async function startup(page: Page, state: State, status: 200 | 202 | 503 = 200, offset = 0) {
  const requests = () => state.traffic.catalog().slice(offset)
  const mode = await readServerMode(page.request, new URL('/api/health', page.url()).href)
  await expect.poll(() => ({
    finished: requests().filter(request => request.state === 'finished').length,
    pending: requests().filter(request => request.state === 'pending').length,
  })).toEqual({ finished: 1, pending: 0 })
  const aborted = requests().filter(request => request.state === 'failed')
  expect(aborted.length).toBeLessThanOrEqual(mode === 'development' ? 1 : 0)
  for (const request of requests()) {
    expect(request.url).toBe(new URL(ordinary, page.url()).href)
    expect(request.method).toBe('GET')
    expect(request.body).toBeNull()
  }
  expect(requests().map(request => request.state)).toEqual(aborted.length ? ['failed', 'finished'] : ['finished'])
  for (const request of aborted) expect(request.error).toBe('net::ERR_ABORTED')
  expect(requests().find(request => request.state === 'finished')?.status).toBe(status)
  state.expectedAborts += aborted.length
  return requests().length
}

async function blockedRefreshInput(page: Page, state: State, phase: string, catalogRequests: number) {
  const button = page.getByRole('dialog').getByRole('button', { name: /^(?:새로고침|공개 공고 다시 조회)$/ })
  await expect(button).toBeDisabled()
  await button.scrollIntoViewIfNeeded()
  const box = await button.boundingBox()
  expect(box).not.toBeNull()
  await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2)
  const close = page.getByRole('dialog').getByRole('button', { name: '닫기', exact: true })
  await close.focus()
  // Background app controls and disabled refresh must never receive focus.
  await page.locator('button.brand').evaluate(element => (element as HTMLElement).focus())
  await expect(close).toBeFocused()
  const last = page.getByRole('dialog').locator('.observation-panel > summary')
  await expect(last).toHaveText('관측 기록과 채용 분포')
  await close.press('Shift+Tab')
  await expect(last).toBeFocused()
  await last.press('Tab')
  await expect(close).toBeFocused()
  const focusTrace = []
  for (const key of ['Tab', 'Shift+Tab']) {
    for (let step = 0; step < 5; step++) {
      await page.keyboard.press(key)
      await expect(button).not.toBeFocused()
      const focus = await page.getByRole('dialog').evaluate(dialog => ({
        inside: dialog.contains(document.activeElement),
        documentHasFocus: document.hasFocus(),
        activeTag: document.activeElement?.tagName ?? null,
        modal: dialog.matches(':modal'),
      }))
      focusTrace.push({ key, ...focus })
      expect(focus.modal).toBe(true)
      expect(focus.inside).toBe(true)
      expect(focus.documentHasFocus).toBe(true)
    }
  }
  await test.info().attach(`disabled-refresh-focus-${phase}`, { body: JSON.stringify(focusTrace, null, 2), contentType: 'application/json' })
  await expect(button).toBeDisabled()
  expect(state.traffic.catalog()).toHaveLength(catalogRequests)
  state.blockedInputs.push({ phase, catalogRequests })
  await close.focus()
}

async function publicUnknown(page: Page) {
  await expectPublicOnlyDialog(page)
  await expect(page.locator('.coverage-stats strong')).toHaveText(['35', '—', '—'])
  await expect(page.locator('.coverage-stats')).toContainText('조회된 개발 공고')
  await expect(page.locator('.company-card, .flat-marker, .city-row, .comparison-city')).toHaveCount(0)
  expect((await contextState(page)).exploration.source).toBe('public')
}
async function retainedContext(page: Page, state: State) { expect(await contextState(page)).toEqual(state.before) }
async function reloadPublic(page: Page, state: State) {
  const offset = state.traffic.catalog().length
  await page.reload()
  const attempt = await expectInitialCatalogRequest(page, {
    requests: state.traffic.requests, catalog: () => state.traffic.catalog().slice(offset),
  })
  state.expectedAborts += attempt.cancelled
  await expect(page.getByRole('button', { name: '공개 채용', exact: true })).toBeVisible()
  return attempt.attempts
}
async function audit(page: Page, info: TestInfo, screenshot?: string) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  for (const dialog of await page.getByRole('dialog').all())
    expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
  expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze()).violations).toEqual([])
  if (screenshot) await page.screenshot({ path: info.outputPath(screenshot) })
}
async function evidence(page: Page, info: TestInfo, state: State, paths: string[]) {
  expect(state.traffic.requests.map(request => new URL(request.url).pathname + new URL(request.url).search)).toEqual(paths)
  expect(state.traffic.requests.every(request => request.method === 'GET' && request.body === null)).toBe(true)
  expect(state.traffic.requests.filter(request => request.state === 'pending')).toEqual([])
  const failed = state.traffic.requests.filter(request => request.state === 'failed')
  expect(failed).toHaveLength(state.expectedAborts)
  expect(failed.every(request => request.error === 'net::ERR_ABORTED')).toBe(true)
  expect(state.failures).toEqual({ pageErrors: [], failedResources: [], unexpectedRequests: [] })
  for (const marker of ['PRIVATE_SOURCE_49', SOURCE_NOTE, 'private-source49', 'greenhouse-search-fixture-a-Saved49'])
    expect(JSON.stringify(state.traffic.requests)).not.toContain(marker)
  expect(state.seedWrites).toBe(1)
  await writeFile(info.outputPath('public-startup-observation.json'), JSON.stringify({
    seededOnceBeforeApp: true, noReloadInitScript: true,
    requests: state.traffic.requests, failures: state.failures, context: await contextState(page),
    blockedInputs: state.blockedInputs, boundary: 'Synthetic public protocol replies; no collected vacancy data',
  }, null, 2))
}

for (const width of [1440, 320]) test.describe(`public startup and refresh at ${width}px`, () => {
  test.use({ viewport: { width, height: 960 }, isMobile: width === 320, hasTouch: width === 320 })

  test('legacy settings start public comparison without fake rows; progressive arrivals restore cities, counts and private context', async ({ page }, info) => {
    const held: Route[] = [], monitors: Route[] = []
    const state = await setup(page, { view: 'compare', legacySource: width === 1440 ? 'sample' : 'greenhouse', reply: route => { held.push(route) } })
    state.monitor(route => { monitors.push(route) })
    await expect.poll(() => held.filter(route => !route.request().failure()).length).toBe(1)
    await page.getByRole('button', { name: '공개 공고 조회 중', exact: true }).press('Enter')
    await publicUnknown(page)
    await expect(page.locator('.data-loading')).toBeVisible()
    await expect(page.getByRole('dialog').getByRole('button', { name: /새로고침|공개 공고 다시 조회/ })).toHaveCount(0)
    await retainedContext(page, state)
    await audit(page, info, width === 320 ? 'pending-public-startup-320.png' : undefined)
    await page.keyboard.press('Escape')
    await expect(page.getByRole('button', { name: '공개 공고 조회 중', exact: true })).toBeFocused()
    expect(new URL(page.url()).hash).toBe('#compare')
    await expect(page.getByRole('heading', { name: '공개 공고를 불러오고 있어요', exact: true })).toBeVisible()
    await expect(page.locator('.comparison-source-note, .comparison-city')).toHaveCount(0)
    await held.find(route => !route.request().failure())!.fulfill({ status: 202, headers: { 'Retry-After': '1' }, json: sourcePartial() })
    const attempts = await startup(page, state, 202)
    await expect(page.locator('.comparison-city h2')).toHaveText(['런던', '베를린'])
    await expect(metric(page, '추천 회사')).toHaveText(['1곳', '0곳', '—'])
    await expect(metric(page, '관련 채용공고')).toHaveText(['2개', '0개', '—'])
    await expect.poll(() => monitors.length).toBe(1)
    await page.getByRole('button', { name: '공개 공고 조회 중', exact: true }).press('Enter')
    await expectPublicOnlyDialog(page)
    await expect(page.locator('.coverage-stats strong')).toHaveText(['22', '2', '2'])
    await blockedRefreshInput(page, state, 'partial-public', attempts)
    await page.keyboard.press('Escape')
    await expect(page.getByRole('button', { name: '공개 공고 조회 중', exact: true })).toBeFocused()
    const complete = sourceDelta()
    complete.catalog.refreshAfter = '2026-09-20T08:02:00.000Z'
    await monitors[0].fulfill({ json: complete })
    await expect(metric(page, '추천 회사')).toHaveText(['1곳', '1곳', '—'])
    await expect(metric(page, '관련 채용공고')).toHaveText(['2개', '1개', '—'])
    await expect(page.locator('.comparison-source-note')).toHaveText('조회한 공개 채용공고의 비교 · 생활비와 세금은 반영하지 않습니다.')
    await retainedContext(page, state)
    await page.getByRole('button', { name: '공개 채용', exact: true }).click()
    await expect(page.locator('.coverage-stats strong')).toHaveText(['22', '2', '3'])
    await expectPublicOnlyDialog(page)
    await blockedRefreshInput(page, state, 'complete-public-cooldown', attempts)
    await evidence(page, info, state, [...Array<string>(attempts).fill(ordinary), monitor])
  })

  test('failed automatic public startup retains unknown counts and conditions; reload and failed refresh preserve the dated public snapshot', async ({ page }, info) => {
    const state = await setup(page, { reply: route => route.fulfill({ status: 503, json: {
      error: 'Fictional source49 unavailable', code: 'CATALOG_UNAVAILABLE', retryAt: '2026-09-20T08:02:00.000Z',
    } }) })
    const attempts = await startup(page, state, 503)
    await page.getByRole('button', { name: '공개 공고 연결 필요', exact: true }).click()
    await expect(page.getByRole('dialog').getByRole('alert')).toHaveText('Fictional source49 unavailable')
    await publicUnknown(page)
    await blockedRefreshInput(page, state, 'failed-startup-cooldown', attempts)
    await retainedContext(page, state)
    await audit(page, info, width === 320 ? 'failed-public-startup-320.png' : undefined)
    await page.keyboard.press('Escape')
    await expect(page.getByRole('button', { name: '공개 공고 연결 필요', exact: true })).toBeFocused()
    await expect(page.getByRole('heading', { name: '공개 공고에 연결하지 못했어요', exact: true })).toBeVisible()
    await expect(query(page)).toHaveValue('Engineer')
    await expect(page.locator('.company-card, .flat-marker, .city-row')).toHaveCount(0)
    await page.getByRole('button', { name: '공개 공고 연결 필요', exact: true }).press('Enter')
    await publicUnknown(page)
    await page.keyboard.press('Escape')
    await expect(page.getByRole('button', { name: '공개 공고 연결 필요', exact: true })).toBeFocused()
    state.respond(route => route.fulfill({ json: sourceCatalog() }))
    const reloadAttempts = await reloadPublic(page, state)
    await expect(page.locator('.company-card')).toHaveCount(1)
    await expect(page.locator('.mini-job-title')).toHaveText(['Backend Engineer First49'])
    await page.getByRole('button', { name: '전체 2개 공고 보기', exact: true }).click()
    await expect(page.locator('.mini-job-title')).toHaveText(['Backend Engineer First49', 'Backend Engineer Second49'])
    await retainedContext(page, state)
    state.respond(route => route.fulfill({ status: 503, json: { error: 'Fictional retained49 failure', code: 'CATALOG_UNAVAILABLE' } }))
    await page.getByRole('button', { name: '공개 채용', exact: true }).click()
    await expectPublicOnlyDialog(page)
    await page.getByRole('button', { name: '새로고침', exact: true }).click()
    await expect(page.getByRole('dialog').getByRole('alert')).toHaveText('Fictional retained49 failure')
    await expect(page.locator('.coverage-stats strong')).toHaveText(['22', '2', '3'])
    await expect(page.locator('.board-row time')).toHaveCount(2)
    for (const time of await page.locator('.board-row time').all()) await expect(time).toHaveAttribute('datetime', SOURCE_TIME)
    await expectPublicOnlyDialog(page)
    await retainedContext(page, state)
    await evidence(page, info, state, [...Array<string>(attempts + reloadAttempts).fill(ordinary), forced])
  })

  test('failed public startup stays readable through its deadline and a keyboard retry preserves private context', async ({ page }, info) => {
    const state = await setup(page, { reply: route => route.fulfill({ status: 503, json: {
      error: 'Fictional source52 retry required', code: 'CATALOG_UNAVAILABLE', retryAt: '2026-09-20T08:02:00.000Z',
    } }) })
    const attempts = await startup(page, state, 503)
    await page.getByRole('button', { name: '공개 공고 연결 필요', exact: true }).press('Enter')
    await expect(page.getByRole('dialog').getByRole('alert')).toHaveText('Fictional source52 retry required')
    await publicUnknown(page)
    await blockedRefreshInput(page, state, 'retry-cooldown', attempts)
    await retainedContext(page, state)
    await page.clock.setFixedTime(new Date('2026-09-20T08:01:59.000Z'))
    await expect(page.getByRole('button', { name: '공개 공고 다시 조회', exact: true })).toBeDisabled()
    expect(state.traffic.catalog()).toHaveLength(attempts)
    await page.clock.setFixedTime(new Date('2026-09-20T08:02:00.000Z'))
    await expect(page.getByRole('button', { name: '공개 공고 다시 조회', exact: true })).toBeEnabled()
    state.respond(route => route.fulfill({ json: sourceCatalog() }))
    await page.getByRole('button', { name: '공개 공고 다시 조회', exact: true }).press('Enter')
    await expect(page.locator('.coverage-stats strong')).toHaveText(['22', '2', '3'])
    await expect(page.getByRole('dialog').getByRole('alert')).toHaveCount(0)
    await expectPublicOnlyDialog(page)
    await retainedContext(page, state)
    await audit(page, info, width === 320 ? 'keyboard-public-retry-320.png' : undefined)
    await page.keyboard.press('Escape')
    await expect(page.getByRole('button', { name: '공개 채용', exact: true })).toBeFocused()
    await expect(query(page)).toHaveValue('Engineer')
    await expect(page.getByLabel('직무 필터', { exact: true })).toHaveValue('backend')
    await expect(page.getByLabel('비자 지원 필터', { exact: true })).toHaveValue('yes')
    await evidence(page, info, state, [...Array<string>(attempts).fill(ordinary), forced])
  })

  test('saved navigation cancels an old response; rejoin accepts only the latest failure and a saved-only revisit keeps the application record', async ({ page }, info) => {
    const held: Route[] = []
    const state = await setup(page, { view: 'saved', reply: route => { held.push(route) } })
    await page.getByRole('button', { name: '기회 탐색', exact: true }).press('Enter')
    await expect.poll(() => held.length).toBe(1)
    await page.getByRole('button', { name: '공개 공고 조회 중', exact: true }).press('Enter')
    await publicUnknown(page)
    await page.keyboard.press('Escape')
    await page.getByRole('navigation', { name: '주요 메뉴' }).getByRole('button', { name: /저장한 기회/ }).press('Space')
    state.expectedAborts = 1
    await expect.poll(() => state.traffic.requests.filter(request => request.state === 'failed').length).toBe(1)
    await retainedContext(page, state)
    await page.getByRole('button', { name: '기회 탐색', exact: true }).click()
    await expect.poll(() => held.length).toBe(2)
    await page.getByRole('button', { name: '공개 공고 조회 중', exact: true }).click()
    await held[0].fulfill({ json: sourceCatalog() })
    await expect(page.locator('.data-loading')).toBeVisible()
    await expect(page.getByRole('dialog').getByRole('alert')).toHaveCount(0)
    await publicUnknown(page)
    await held[1].fulfill({ status: 503, json: { error: 'Only the latest49 request failed', code: 'CATALOG_UNAVAILABLE' } })
    await expect(page.getByRole('dialog').getByRole('alert')).toHaveText('Only the latest49 request failed')
    await publicUnknown(page)
    await page.keyboard.press('Escape')
    await page.getByRole('navigation', { name: '주요 메뉴' }).getByRole('button', { name: /저장한 기회/ }).click()
    await page.reload()
    await waitForSavedCommit(page)
    expect(state.traffic.catalog()).toHaveLength(2)
    await retainedContext(page, state)
    await page.getByRole('button', { name: '공개 채용', exact: true }).press('Enter')
    await publicUnknown(page)
    await page.keyboard.press('Escape')
    await expect(page.getByRole('button', { name: '공개 채용', exact: true })).toBeFocused()
    await expect(page.locator('.saved-title')).toHaveText(['Backend Engineer Saved49'])
    await expect(page.locator('.saved-note-preview')).toHaveText(SOURCE_NOTE)
    await expect(page.locator('.saved-status.applied')).toHaveText('지원 완료')
    await page.getByRole('button', { name: '자세히', exact: true }).click()
    await expect(page.getByLabel('이 기회에 대한 나의 메모', { exact: true })).toHaveValue(SOURCE_NOTE)
    await page.getByLabel('이 기회에 대한 나의 메모', { exact: true }).scrollIntoViewIfNeeded()
    await audit(page, info, width === 320 ? 'saved-record-after-cancel-320.png' : undefined)
    await evidence(page, info, state, [ordinary, ordinary])
  })

  test('profile memory opt-out retains only public mode and display settings through refresh failure and reload without restoring private search', async ({ page }, info) => {
    const state = await setup(page)
    const attempts = await startup(page, state)
    await page.getByRole('button', { name: '내 프로필 편집', exact: true }).click()
    await page.getByRole('checkbox', { name: /이 브라우저에 프로필 기억하기/ }).uncheck()
    await page.getByRole('button', { name: '변경 사항 적용', exact: true }).click()
    await query(page).fill('PRIVATE_SOURCE_49_QUERY')
    const privateMemory = async () => {
      const current = await contextState(page)
      expect(current.profile).toBeNull()
      expect(current.exploration).toEqual({
        source: 'public', selectedId: null, panelTab: 'cities', mapMode: 'flat', citySort: 'salary', light: false,
        filters: {
          query: '', region: 'all', role: 'all', workMode: 'all', visa: 'all', employment: 'all',
          postingType: 'opening', salaryMin: 0, includeUnknownSalary: true, remoteEligibleOnly: true,
        },
      })
      expect(current.compare).toEqual(['london', 'berlin'])
      expect(current.saved).toBe(state.before.saved)
      const stored = await page.evaluate(() => Object.values(localStorage).join('\n') + Object.values(sessionStorage).join('\n'))
      for (const marker of ['PRIVATE_SOURCE_49_QUERY', 'private-source49', '"name":"PRIVATE_SOURCE_49"']) expect(stored).not.toContain(marker)
    }
    await privateMemory()
    state.respond(route => route.fulfill({ status: 503, json: { error: 'Fictional private49 failure', code: 'CATALOG_UNAVAILABLE' } }))
    await page.getByRole('button', { name: '공개 채용', exact: true }).click()
    await expectPublicOnlyDialog(page)
    await page.getByRole('button', { name: '새로고침', exact: true }).click()
    await expect(page.getByRole('dialog').getByRole('alert')).toHaveText('Fictional private49 failure')
    await expect(page.locator('.coverage-stats strong')).toHaveText(['22', '2', '3'])
    await privateMemory()
    await page.keyboard.press('Escape')
    await expect(query(page)).toHaveValue('PRIVATE_SOURCE_49_QUERY')
    state.respond(route => route.fulfill({ json: sourceCatalog() }))
    const reloadAttempts = await reloadPublic(page, state)
    if (width === 1440) await expect(page.locator('.sample-profile-card')).toBeVisible()
    const profileButton = page.getByRole('button', { name: '내 프로필 편집', exact: true })
    await expect(profileButton).toHaveText('AK')
    await profileButton.click()
    await expect(page.getByRole('dialog').getByRole('heading', { name: '커리어의 다음 좌표를 찾아보세요.', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: '경력에서 가능성 찾기', exact: true })).toBeDisabled()
    await page.keyboard.press('Escape')
    await expect(profileButton).toBeFocused()
    await expect(query(page)).toHaveValue('')
    await expect(page.getByLabel('직무 필터', { exact: true })).toHaveValue('all')
    await expect(page.getByLabel('비자 지원 필터', { exact: true })).toHaveValue('all')
    await expect(page.getByRole('button', { name: '2D 지도', exact: true })).toHaveAttribute('aria-pressed', 'true')
    await privateMemory()
    await audit(page, info)
    await page.getByRole('button', { name: '공개 채용', exact: true }).press('Enter')
    await expectPublicOnlyDialog(page)
    await page.keyboard.press('Escape')
    await expect(page.getByRole('button', { name: '공개 채용', exact: true })).toBeFocused()
    await evidence(page, info, state, [...Array<string>(attempts).fill(ordinary), forced, ...Array<string>(reloadAttempts).fill(ordinary)])
  })
})
