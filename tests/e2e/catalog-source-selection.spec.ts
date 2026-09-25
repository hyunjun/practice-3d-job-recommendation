import { expect, test } from '@playwright/test'
import type { Page, Route, TestInfo } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { writeFile } from 'node:fs/promises'
import {
  SOURCE_TIME, SOURCE_PROFILE, SOURCE_EXPLORATION, SOURCE_SAVED, SOURCE_NOTE,
  sourceCatalog, sourcePartial, sourceDelta,
} from '../fixtures/catalog-source-selection'
import { expectInitialCatalogRequest, watchApiRequests } from './helpers/api-requests'
import { readSavedJson } from './helpers/saved-store'
import { expectSourceChoice, sourceChoice } from './helpers/source-choice'

const ordinary = '/api/catalog?source=public'
const forced = '/api/catalog?source=public&refresh=1'
const monitor = '/api/catalog/progress?id=00000000-0000-4000-8000-000000000049&after=1'
type Reply = (route: Route) => Promise<void> | void
const sampleChoice = (page: Page) => sourceChoice(page, 'sample')
const publicChoice = (page: Page) => sourceChoice(page, 'public')
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

async function setup(page: Page, view: 'explore' | 'compare' = 'explore') {
  const traffic = watchApiRequests(page)
  const failures = { pageErrors: [] as string[], failedResources: [] as string[], unexpectedRequests: [] as string[] }
  let reply: Reply = route => route.fulfill({ json: sourceCatalog() })
  let progress: Reply = route => route.fulfill({ status: 500, json: { error: 'Unexpected source49 monitor' } })
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
    const target = new URL(route.request().url())
    const key = target.pathname + target.search
    if (target.origin !== origin) {
      failures.unexpectedRequests.push(target.href)
      return route.abort('blockedbyclient')
    }
    if (key === '/__source49-seed') return route.fulfill({
      contentType: 'text/html', body: '<!doctype html><title>Once-only storage fixture</title>',
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
  // Seed fresh storage exactly once on a blank same-origin page, before the
  // real app starts. There is deliberately no reload/revisit init script.
  await page.goto('/__source49-seed')
  await page.evaluate(seed => {
    localStorage.setItem('orbit.v1.profile', JSON.stringify(seed.profile))
    localStorage.setItem('orbit.v1.exploration', JSON.stringify(seed.exploration))
    localStorage.setItem('orbit.v1.compare', JSON.stringify(['london', 'berlin']))
    localStorage.setItem('orbit.v1.saved', JSON.stringify(seed.saved))
  }, { profile: SOURCE_PROFILE, exploration: SOURCE_EXPLORATION, saved: SOURCE_SAVED })
  await page.goto(view === 'compare' ? '/#compare' : '/')
  await expect(page.getByRole('button', { name: '샘플 탐색', exact: true })).toBeVisible()
  const before = await contextState(page)
  expect(before.exploration).toEqual(SOURCE_EXPLORATION)
  expect(before.compare).toEqual(['london', 'berlin'])
  expect(traffic.requests).toEqual([])
  return {
    traffic, failures, before, expectedAborts: 0, seedWrites: 1,
    sourceChoices: [] as Awaited<ReturnType<typeof expectSourceChoice>>[],
    blockedInputs: [] as { phase: string; catalogRequests: number; keyboardFocusAfterTab: string }[],
    respond(handler: Reply) { reply = handler },
    monitor(handler: Reply) { progress = handler },
  }
}

async function selectedChoice(page: Page, state: Awaited<ReturnType<typeof setup>>, phase: string, selected: 'sample' | 'public', publicDisabled: boolean) {
  state.sourceChoices.push(await expectSourceChoice(page, phase, selected, publicDisabled))
}

async function blockedPublicInput(page: Page, state: Awaited<ReturnType<typeof setup>>, phase: string, catalogRequests: number) {
  const button = publicChoice(page)
  await expect(button).toBeDisabled()
  expect(state.traffic.catalog()).toHaveLength(catalogRequests)
  await button.scrollIntoViewIfNeeded()
  const box = await button.boundingBox()
  expect(box).not.toBeNull()
  // A native pointer click reaches the disabled control. Avoid locator.click(),
  // which would wait for enabled actionability instead of testing the browser.
  await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2)
  await expect(button).toBeDisabled()
  await page.getByRole('dialog').getByRole('button', { name: '닫기', exact: true }).focus()
  await page.keyboard.press('Tab')
  await expect(sampleChoice(page)).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(button).not.toBeFocused()
  const keyboardFocusAfterTab = await page.evaluate(() => document.activeElement?.tagName ?? '')
  // Native-disabled public is not keyboard-reachable; sample activation and an
  // enabled retry are exercised with Space/Enter in the original flows below.
  expect(state.traffic.catalog()).toHaveLength(catalogRequests)
  state.blockedInputs.push({ phase, catalogRequests, keyboardFocusAfterTab })
  await page.getByRole('dialog').getByRole('button', { name: '닫기', exact: true }).focus()
}

async function publicUnknown(page: Page) {
  await expect(publicChoice(page)).toHaveAttribute('aria-pressed', 'true')
  await expect(sampleChoice(page)).toHaveAttribute('aria-pressed', 'false')
  await expect(page.locator('.coverage-stats strong')).toHaveText(['22', '—', '—'])
  await expect(page.locator('.coverage-stats')).toContainText('조회된 개발 공고')
  await expect(page.locator('.company-card, .flat-marker, .city-row, .comparison-city')).toHaveCount(0)
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('orbit.v1.exploration') ?? '{}').source)).toBe('public')
}

async function retainedContext(page: Page, before: Awaited<ReturnType<typeof contextState>>, source: 'sample' | 'public') {
  expect(await contextState(page)).toEqual({
    ...before, exploration: { ...before.exploration, source },
  })
}

async function reloadPublic(page: Page, state: Awaited<ReturnType<typeof setup>>) {
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

async function evidence(page: Page, info: TestInfo, state: Awaited<ReturnType<typeof setup>>, paths: string[]) {
  expect(state.traffic.requests.map(request => {
    const url = new URL(request.url)
    return url.pathname + url.search
  })).toEqual(paths)
  expect(state.traffic.requests.every(request => request.method === 'GET' && request.body === null)).toBe(true)
  expect(state.traffic.requests.filter(request => request.state === 'pending')).toEqual([])
  const failed = state.traffic.requests.filter(request => request.state === 'failed')
  expect(failed).toHaveLength(state.expectedAborts)
  expect(failed.every(request => request.error === 'net::ERR_ABORTED')).toBe(true)
  expect(state.failures).toEqual({ pageErrors: [], failedResources: [], unexpectedRequests: [] })
  for (const marker of ['PRIVATE_SOURCE_49', SOURCE_NOTE, 'private-source49', 'greenhouse-search-fixture-a-Saved49'])
    expect(JSON.stringify(state.traffic.requests)).not.toContain(marker)
  expect(state.seedWrites).toBe(1)
  await writeFile(info.outputPath('source-selection-observation.json'), JSON.stringify({
    seededOnceBeforeApp: true, noReloadInitScript: true, realReloadUsedWhereSpecified: true,
    clock: 'Fixed Date only; native browser requests, timers and reloads',
    requests: state.traffic.requests, failures: state.failures, context: await contextState(page),
    sourceChoices: state.sourceChoices, blockedInputs: state.blockedInputs,
    boundary: 'Invented HTTP catalog replies for UI verification; not live provider collection',
  }, null, 2))
}

for (const width of [1440, 320]) test.describe(`atomic source selection at ${width}px`, () => {
  test.use({ viewport: { width, height: 960 }, isMobile: width === 320, hasTouch: width === 320 })

  test('public selection clears sample comparisons immediately, then real progressive arrivals restore the selected cities and private context', async ({ page }, info) => {
    const state = await setup(page, 'compare')
    await expect(page.locator('.comparison-city h2')).toHaveText(['런던', '베를린'])
    const held: Route[] = []
    const monitors: Route[] = []
    state.respond(route => { held.push(route) })
    state.monitor(route => { monitors.push(route) })
    await page.getByRole('button', { name: '샘플 탐색', exact: true }).press('Enter')
    await selectedChoice(page, state, 'initial-sample', 'sample', false)
    await publicChoice(page).click()
    await expect.poll(() => held.length).toBe(1)
    await publicUnknown(page)
    await expect(page.locator('.data-loading')).toBeVisible()
    await retainedContext(page, state.before, 'public')
    await selectedChoice(page, state, 'pending-public', 'public', true)
    await blockedPublicInput(page, state, 'pending-public', 1)
    await audit(page, info, width === 320 ? 'pending-public-selection-320.png' : undefined)
    await page.keyboard.press('Escape')
    await expect(page.getByRole('button', { name: '공개 공고 조회 중', exact: true })).toBeFocused()
    expect(new URL(page.url()).hash).toBe('#compare')
    await expect(page.getByRole('heading', { name: '공개 공고를 불러오고 있어요', exact: true })).toBeVisible()
    await expect(page.locator('.comparison-source-note, .comparison-city')).toHaveCount(0)
    await held[0].fulfill({ status: 202, headers: { 'Retry-After': '1' }, json: sourcePartial() })
    await expect(page.locator('.comparison-city h2')).toHaveText(['런던', '베를린'])
    await expect(metric(page, '추천 회사')).toHaveText(['1곳', '0곳', '—'])
    await expect(metric(page, '관련 채용공고')).toHaveText(['2개', '0개', '—'])
    await expect.poll(() => monitors.length).toBe(1)
    await page.getByRole('button', { name: '공개 공고 조회 중', exact: true }).press('Enter')
    await selectedChoice(page, state, 'partial-public', 'public', true)
    await expect(page.locator('.coverage-stats strong')).toHaveText(['22', '2', '2'])
    await page.keyboard.press('Escape')
    await expect(page.getByRole('button', { name: '공개 공고 조회 중', exact: true })).toBeFocused()
    const complete = sourceDelta()
    complete.catalog.refreshAfter = '2026-09-20T08:02:00.000Z'
    await monitors[0].fulfill({ json: complete })
    await expect(metric(page, '추천 회사')).toHaveText(['1곳', '1곳', '—'])
    await expect(metric(page, '관련 채용공고')).toHaveText(['2개', '1개', '—'])
    await expect(page.locator('.comparison-source-note')).toHaveText('조회한 공개 채용공고의 비교 · 생활비와 세금은 반영하지 않습니다.')
    await retainedContext(page, state.before, 'public')
    await page.getByRole('button', { name: '공개 채용', exact: true }).click()
    await expect(page.locator('.coverage-stats strong')).toHaveText(['22', '2', '3'])
    await expect(publicChoice(page)).toHaveAttribute('aria-pressed', 'true')
    await selectedChoice(page, state, 'successful-public-cooldown', 'public', true)
    await blockedPublicInput(page, state, 'successful-public-cooldown', 1)
    if (width === 320) await page.screenshot({ path: info.outputPath('successful-public-selection-320.png') })
    await evidence(page, info, state, [ordinary, monitor])
  })

  test('a failed public choice stays selected and unknown across closing, then reload reads the persisted choice and same-public refresh keeps real data', async ({ page }, info) => {
    const state = await setup(page)
    state.respond(route => route.fulfill({ status: 503, json: {
      error: 'Fictional source49 unavailable', code: 'CATALOG_UNAVAILABLE', retryAt: '2026-09-20T08:02:00.000Z',
    } }))
    await page.getByRole('button', { name: '샘플 탐색', exact: true }).click()
    await selectedChoice(page, state, 'initial-sample', 'sample', false)
    await publicChoice(page).click()
    await expect(page.getByRole('dialog').getByRole('alert')).toHaveText('Fictional source49 unavailable')
    await publicUnknown(page)
    await expect(page.getByRole('button', { name: '공개 공고 다시 조회', exact: true })).toBeDisabled()
    await retainedContext(page, state.before, 'public')
    await selectedChoice(page, state, 'failed-public-cooldown', 'public', true)
    await blockedPublicInput(page, state, 'failed-public-cooldown', 1)
    await audit(page, info, width === 320 ? 'failed-public-selection-320.png' : undefined)
    await page.keyboard.press('Escape')
    await expect(page.getByRole('button', { name: '공개 공고 연결 필요', exact: true })).toBeVisible()
    await expect(page.getByRole('heading', { name: '공개 공고에 연결하지 못했어요', exact: true })).toBeVisible()
    await expect(query(page)).toHaveValue('Engineer')
    await expect(page.locator('.company-card, .flat-marker, .city-row')).toHaveCount(0)
    await page.getByRole('button', { name: '공개 공고 연결 필요', exact: true }).press('Enter')
    await selectedChoice(page, state, 'failed-public-return', 'public', true)
    await page.keyboard.press('Escape')
    await expect(page.getByRole('button', { name: '공개 공고 연결 필요', exact: true })).toBeFocused()
    expect(state.traffic.catalog()).toHaveLength(1)
    await expect(page.getByRole('heading', { name: '공개 공고에 연결하지 못했어요', exact: true })).toBeVisible()
    state.respond(route => route.fulfill({ json: sourceCatalog() }))
    const reloadAttempts = await reloadPublic(page, state)
    await expect(page.locator('.company-card')).toHaveCount(1)
    await expect(page.locator('.mini-job-title')).toHaveText(['Backend Engineer First49'])
    await page.getByRole('button', { name: '전체 2개 공고 보기', exact: true }).click()
    await expect(page.locator('.mini-job-title')).toHaveText(['Backend Engineer First49', 'Backend Engineer Second49'])
    await retainedContext(page, state.before, 'public')
    state.respond(route => route.fulfill({ status: 503, json: { error: 'Fictional retained49 failure', code: 'CATALOG_UNAVAILABLE' } }))
    await page.getByRole('button', { name: '공개 채용', exact: true }).click()
    await selectedChoice(page, state, 'reloaded-public', 'public', false)
    await page.getByRole('button', { name: '새로고침', exact: true }).click()
    await expect(page.getByRole('dialog').getByRole('alert')).toHaveText('Fictional retained49 failure')
    await expect(page.locator('.coverage-stats strong')).toHaveText(['22', '2', '3'])
    await expect(page.locator('.board-row time')).toHaveCount(2)
    for (const time of await page.locator('.board-row time').all())
      await expect(time).toHaveAttribute('datetime', SOURCE_TIME)
    await expect(publicChoice(page)).toHaveAttribute('aria-pressed', 'true')
    await selectedChoice(page, state, 'retained-public-after-refresh-error', 'public', false)
    await retainedContext(page, state.before, 'public')
    await evidence(page, info, state, [ordinary, ...Array<string>(reloadAttempts).fill(ordinary), forced])
  })

  test('a failed public source stays readable through its retry deadline and a keyboard retry preserves private context', async ({ page }, info) => {
    const state = await setup(page)
    state.respond(route => route.fulfill({ status: 503, json: {
      error: 'Fictional source52 retry required', code: 'CATALOG_UNAVAILABLE', retryAt: '2026-09-20T08:02:00.000Z',
    } }))
    await page.getByRole('button', { name: '샘플 탐색', exact: true }).press('Enter')
    await selectedChoice(page, state, 'retry-flow-initial-sample', 'sample', false)
    await publicChoice(page).click()
    await expect(page.getByRole('dialog').getByRole('alert')).toHaveText('Fictional source52 retry required')
    await publicUnknown(page)
    await expect(page.getByRole('button', { name: '공개 공고 다시 조회', exact: true })).toBeDisabled()
    await selectedChoice(page, state, 'retry-flow-public-cooldown', 'public', true)
    await blockedPublicInput(page, state, 'retry-flow-public-cooldown', 1)
    await retainedContext(page, state.before, 'public')
    await page.clock.setFixedTime(new Date('2026-09-20T08:01:59.000Z'))
    await expect(page.getByRole('button', { name: '공개 공고 다시 조회', exact: true })).toBeDisabled()
    await selectedChoice(page, state, 'one-second-before-retry', 'public', true)
    expect(state.traffic.catalog()).toHaveLength(1)
    await page.clock.setFixedTime(new Date('2026-09-20T08:02:00.000Z'))
    await expect(page.getByRole('button', { name: '공개 공고 다시 조회', exact: true })).toBeEnabled()
    await selectedChoice(page, state, 'retry-deadline-reached', 'public', false)
    state.respond(route => route.fulfill({ json: sourceCatalog() }))
    await page.getByRole('button', { name: '공개 공고 다시 조회', exact: true }).press('Enter')
    await expect(page.locator('.coverage-stats strong')).toHaveText(['22', '2', '3'])
    await expect(page.getByRole('dialog').getByRole('alert')).toHaveCount(0)
    expect(state.traffic.catalog()).toHaveLength(2)
    await selectedChoice(page, state, 'explicit-keyboard-retry-complete', 'public', false)
    await retainedContext(page, state.before, 'public')
    await audit(page, info, width === 320 ? 'retry-public-selection-320.png' : undefined)
    await page.keyboard.press('Escape')
    await expect(page.getByRole('button', { name: '공개 채용', exact: true })).toBeFocused()
    await expect(query(page)).toHaveValue('Engineer')
    await expect(page.getByLabel('직무 필터', { exact: true })).toHaveValue('backend')
    await expect(page.getByLabel('비자 지원 필터', { exact: true })).toHaveValue('yes')
    await retainedContext(page, state.before, 'public')
    await evidence(page, info, state, [ordinary, forced])
  })

  test('sample cancellation defeats an old response and later failure, and a real revisit keeps sample mode with the saved application record', async ({ page }, info) => {
    const state = await setup(page)
    const held: Route[] = []
    state.respond(route => { held.push(route) })
    await page.getByRole('button', { name: '샘플 탐색', exact: true }).click()
    await selectedChoice(page, state, 'initial-sample', 'sample', false)
    await publicChoice(page).press('Enter')
    await expect.poll(() => held.length).toBe(1)
    await publicUnknown(page)
    await selectedChoice(page, state, 'pending-before-sample-cancel', 'public', true)
    await sampleChoice(page).press('Space')
    await expect(sampleChoice(page)).toHaveAttribute('aria-pressed', 'true')
    await expect(page.locator('.coverage-stats strong')).toHaveText(['22', '32', '179'])
    state.expectedAborts = 1
    await expect.poll(() => state.traffic.requests.filter(request => request.state === 'failed').length).toBe(1)
    await retainedContext(page, state.before, 'sample')
    await selectedChoice(page, state, 'sample-keyboard-cancelled-public', 'sample', false)
    await publicChoice(page).click()
    await expect.poll(() => held.length).toBe(2)
    await publicUnknown(page)
    await held[0].fulfill({ json: sourceCatalog() })
    await expect(page.locator('.data-loading')).toBeVisible()
    await expect(page.getByRole('dialog').getByRole('alert')).toHaveCount(0)
    await publicUnknown(page)
    await selectedChoice(page, state, 'new-public-ignores-old-success', 'public', true)
    await held[1].fulfill({ status: 503, json: { error: 'Only the latest49 request failed', code: 'CATALOG_UNAVAILABLE' } })
    await expect(page.getByRole('dialog').getByRole('alert')).toHaveText('Only the latest49 request failed')
    await selectedChoice(page, state, 'latest-public-error', 'public', false)
    await sampleChoice(page).click()
    await expect(sampleChoice(page)).toHaveAttribute('aria-pressed', 'true')
    await expect(publicChoice(page)).toHaveAttribute('aria-pressed', 'false')
    await expect(page.locator('.coverage-stats strong')).toHaveText(['22', '32', '179'])
    await retainedContext(page, state.before, 'sample')
    await selectedChoice(page, state, 'sample-return-after-error', 'sample', false)
    await page.reload()
    await expect(page.getByRole('button', { name: '샘플 탐색', exact: true })).toBeVisible()
    await retainedContext(page, state.before, 'sample')
    await page.getByRole('button', { name: '샘플 탐색', exact: true }).press('Enter')
    await selectedChoice(page, state, 'sample-real-revisit', 'sample', false)
    if (width === 320) await page.screenshot({ path: info.outputPath('sample-selected-after-revisit-320.png') })
    await page.keyboard.press('Escape')
    await expect(page.getByRole('button', { name: '샘플 탐색', exact: true })).toBeFocused()
    await page.getByRole('button', { name: /저장한 기회/ }).click()
    await expect(page.locator('.saved-title')).toHaveText(['Backend Engineer Saved49'])
    await expect(page.locator('.saved-note-preview')).toHaveText(SOURCE_NOTE)
    await expect(page.locator('.saved-status.applied')).toHaveText('지원 완료')
    await page.getByRole('button', { name: '자세히', exact: true }).click()
    await expect(page.getByLabel('이 기회에 대한 나의 메모', { exact: true })).toHaveValue(SOURCE_NOTE)
    await page.getByLabel('이 기회에 대한 나의 메모', { exact: true }).scrollIntoViewIfNeeded()
    await audit(page, info, width === 320 ? 'saved-record-after-source-cancel-320.png' : undefined)
    await evidence(page, info, state, [ordinary, ordinary])
  })

  test('profile memory opt-out retains only public mode and display settings through failure and real reload without restoring the private search', async ({ page }, info) => {
    const state = await setup(page)
    await page.getByRole('button', { name: '내 프로필 편집', exact: true }).click()
    await page.getByRole('checkbox', { name: /이 브라우저에 프로필 기억하기/ }).uncheck()
    await page.getByRole('button', { name: '변경 사항 적용', exact: true }).click()
    await query(page).fill('PRIVATE_SOURCE_49_QUERY')
    const privateMemory = async (source: 'sample' | 'public') => {
      const current = await contextState(page)
      expect(current.profile).toBeNull()
      expect(current.exploration).toEqual({
        source, selectedId: null, panelTab: 'cities', mapMode: 'flat', citySort: 'salary', light: false,
        filters: {
          query: '', region: 'all', role: 'all', workMode: 'all', visa: 'all', employment: 'all',
          postingType: 'opening', salaryMin: 0, includeUnknownSalary: true, remoteEligibleOnly: true,
        },
      })
      expect(current.compare).toEqual(['london', 'berlin'])
      expect(current.saved).toBe(state.before.saved)
      const stored = await page.evaluate(() => Object.values(localStorage).join('\n') + Object.values(sessionStorage).join('\n'))
      for (const marker of ['PRIVATE_SOURCE_49_QUERY', 'private-source49', '"name":"PRIVATE_SOURCE_49"'])
        expect(stored).not.toContain(marker)
    }
    await privateMemory('sample')
    state.respond(route => route.fulfill({ status: 503, json: { error: 'Fictional private49 failure', code: 'CATALOG_UNAVAILABLE' } }))
    await page.getByRole('button', { name: '샘플 탐색', exact: true }).click()
    await selectedChoice(page, state, 'memory-optout-sample', 'sample', false)
    await publicChoice(page).click()
    await expect(page.getByRole('dialog').getByRole('alert')).toHaveText('Fictional private49 failure')
    await publicUnknown(page)
    await privateMemory('public')
    await selectedChoice(page, state, 'memory-optout-public-error', 'public', false)
    await page.keyboard.press('Escape')
    await expect(query(page)).toHaveValue('PRIVATE_SOURCE_49_QUERY')
    state.respond(route => route.fulfill({ json: sourceCatalog() }))
    const reloadAttempts = await reloadPublic(page, state)
    if (width === 1440) await expect(page.locator('.sample-profile-card')).toBeVisible()
    const profileButton = page.getByRole('button', { name: '내 프로필 편집', exact: true })
    await expect(profileButton).toBeVisible()
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
    await privateMemory('public')
    await audit(page, info)
    await page.getByRole('button', { name: '공개 채용', exact: true }).press('Enter')
    await selectedChoice(page, state, 'memory-optout-public-reloaded', 'public', false)
    await page.keyboard.press('Escape')
    await expect(page.getByRole('button', { name: '공개 채용', exact: true })).toBeFocused()
    await evidence(page, info, state, [ordinary, ...Array<string>(reloadAttempts).fill(ordinary)])
  })
})
