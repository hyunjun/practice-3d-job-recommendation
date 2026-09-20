import { expect, test } from '@playwright/test'
import type { Page, Route, TestInfo } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { writeFile } from 'node:fs/promises'
import {
  REVALIDATION_TIME, REVALIDATION_PROFILE, REVALIDATION_EXPLORATION,
  revalidationCatalog, revalidationJob, revalidationPartial, revalidationDelta,
} from '../fixtures/catalog-revalidation'
import { expectInitialCatalogRequest, watchApiRequests } from './helpers/api-requests'
import { readSavedJson, waitForSavedCommit } from './helpers/saved-store'

const start = Date.parse(REVALIDATION_TIME)
const iso = (offset: number) => new Date(start + offset).toISOString()
const ordinary = '/api/catalog?source=public'
const forced = '/api/catalog?source=public&refresh=1'
const monitor = '/api/catalog/progress?id=00000000-0000-4000-8000-000000000048&after=1'
const note = 'PRIVATE_REVALIDATION_48_NOTE 다음 주 지원 준비 🌱'
const query = (page: Page) => page.getByRole('textbox', { name: '도시, 회사 또는 포지션 검색', exact: true })
type Reply = (route: Route) => Promise<void> | void

async function setup(page: Page, catalog = revalidationCatalog(), source: 'public' | 'sample' = 'public') {
  let reply: Reply = route => route.fulfill({ json: catalog })
  let progressReply: Reply = route => route.fulfill({ status: 500, json: { error: 'Unexpected fictional progress request' } })
  const failures = { pageErrors: [] as string[], failedResources: [] as string[], externalRequests: [] as string[] }
  const traffic = watchApiRequests(page)
  page.on('pageerror', error => failures.pageErrors.push(error.message))
  page.on('response', response => {
    if (!new URL(response.url()).pathname.startsWith('/api/') && response.status() >= 400)
      failures.failedResources.push(`${response.status()} ${response.url()}`)
  })
  page.on('requestfailed', request => {
    if (!new URL(request.url()).pathname.startsWith('/api/') && request.failure()?.errorText !== 'net::ERR_ABORTED')
      failures.failedResources.push(`${request.failure()?.errorText} ${request.url()}`)
  })
  const origin = new URL(test.info().project.use.baseURL!).origin
  await page.route('**/*', route => {
    const target = new URL(route.request().url())
    if (target.origin === origin) return route.fallback()
    failures.externalRequests.push(target.href)
    return route.abort('blockedbyclient')
  })
  // These are fictional HTTP responses to the real request/validation pipeline.
  // No hook, catalog state, matching result or component output is replaced.
  await page.route('**/api/catalog?source=public*', route => reply(route))
  await page.route('**/api/catalog/progress?*', route => progressReply(route))
  await page.clock.install({ time: new Date(start - 1000) })
  await page.clock.pauseAt(new Date(start))
  await page.addInitScript(({ profile, exploration }) => {
    localStorage.setItem('orbit.v1.profile', JSON.stringify(profile))
    localStorage.setItem('orbit.v1.exploration', JSON.stringify(exploration))
  }, { profile: REVALIDATION_PROFILE, exploration: { ...REVALIDATION_EXPLORATION, source } })
  await page.goto('/')
  let initialAttempts = 0
  let initialCancelled = 0
  if (source === 'public') {
    const initial = await expectInitialCatalogRequest(page, traffic)
    initialAttempts = initial.attempts
    initialCancelled = initial.cancelled
    await expect(page.getByRole('button', { name: '공개 채용', exact: true })).toBeVisible()
  } else {
    await expect(page.getByRole('button', { name: '샘플 탐색', exact: true })).toBeVisible()
    expect(traffic.requests).toEqual([])
  }
  return {
    traffic, failures, initialAttempts, initialCancelled,
    respond(handler: Reply) { reply = handler },
    progress(handler: Reply) { progressReply = handler },
  }
}

async function visibility(page: Page, value: 'visible' | 'hidden') {
  // Synthetic browser visibility boundary, not a forged application state.
  await page.evaluate(value => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => value })
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => value === 'hidden' })
  }, value)
}

async function hint(page: Page, event: 'burst' | 'online' | 'focus' | 'visibilitychange' = 'burst') {
  // Explicit synthetic lifecycle signals; this does not claim actual OS/bfcache navigation.
  await page.evaluate(event => {
    for (const name of event === 'burst' ? ['focus', 'pageshow', 'visibilitychange', 'online'] : [event]) {
      if (name === 'visibilitychange') document.dispatchEvent(new Event(name))
      else if (name === 'pageshow') window.dispatchEvent(new PageTransitionEvent(name, { persisted: true }))
      else window.dispatchEvent(new Event(name))
    }
  }, event)
  // Advance one rendered frame, not a wall-clock sleep or an extended timeout.
  await page.clock.runFor(20)
}

async function wallTime(page: Page, offset: number) {
  await page.clock.setSystemTime(new Date(start + offset))
}

async function contextState(page: Page) {
  return page.evaluate(() => ({
    profile: localStorage.getItem('orbit.v1.profile'),
    exploration: JSON.parse(localStorage.getItem('orbit.v1.exploration') ?? '{}'),
  }))
}

async function audit(page: Page, info: TestInfo, screenshot?: string) {
  await page.clock.resume()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  for (const dialog of await page.getByRole('dialog').all())
    expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
  expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze()).violations).toEqual([])
  if (screenshot) await page.screenshot({ path: info.outputPath(screenshot) })
}

async function evidence(page: Page, info: TestInfo, state: Awaited<ReturnType<typeof setup>>, followingPaths: string[], expectedFailures = 0) {
  const paths = state.traffic.requests.map(request => {
    const url = new URL(request.url)
    return url.pathname + url.search
  })
  expect(paths).toEqual([...Array<string>(state.initialAttempts).fill(ordinary), ...followingPaths])
  expect(state.traffic.requests.every(request => request.method === 'GET' && request.body === null)).toBe(true)
  expect(state.traffic.requests.filter(request => request.state === 'pending')).toEqual([])
  const failed = state.traffic.requests.filter(request => request.state === 'failed')
  expect(failed).toHaveLength(state.initialCancelled + expectedFailures)
  expect(failed.every(request => request.error === 'net::ERR_ABORTED')).toBe(true)
  expect(state.failures).toEqual({ pageErrors: [], failedResources: [], externalRequests: [] })
  for (const marker of ['PRIVATE_REVALIDATION_48', note, 'private-revalidation48', 'greenhouse-search-fixture-a-Old48'])
    expect(JSON.stringify(state.traffic.requests)).not.toContain(marker)
  await writeFile(info.outputPath('revalidation-observation.json'), JSON.stringify({
    syntheticClockAndLifecycleEvents: true, requestBoundary: 'real application fetch and progressive response validation',
    initialAttempts: state.initialAttempts, initialCancelled: state.initialCancelled,
    requests: state.traffic.requests, failures: state.failures, context: await contextState(page), saved: await readSavedJson(page),
  }, null, 2))
}

for (const width of [1440, 320]) test.describe(`foreground public revalidation at ${width}px`, () => {
  test.use({ viewport: { width, height: 960 }, isMobile: width === 320, hasTouch: width === 320 })

  test('a visible return refreshes an old company beside a fresh one while an open saved job and private exploration stay intact', async ({ page }, info) => {
    const catalog = revalidationCatalog([
      revalidationJob('Old48', { fetchedAt: iso(-1_799_000) }),
      revalidationJob('AlreadyFresh48', { companyId: 'search-fixture-b' }),
    ])
    catalog.boards[0].lastSuccessAt = iso(-1_799_000)
    const state = await setup(page, catalog)
    await expect(page.locator('.mini-job-title')).toHaveText(['Backend Engineer Old48', 'Backend Engineer AlreadyFresh48'])
    await page.locator('.mini-job-title').filter({ hasText: 'Backend Engineer Old48' }).click()
    await page.getByRole('button', { name: '기회 저장', exact: true }).click()
    await page.getByLabel('이 기회에 대한 나의 메모', { exact: true }).fill(note)
    await page.getByRole('button', { name: '지원 완료로 표시', exact: true }).click()
    await page.clock.fastForward(8000)
    await waitForSavedCommit(page)
    const saved = await readSavedJson(page)
    const before = await contextState(page)
    expect(before.exploration).toMatchObject(REVALIDATION_EXPLORATION)
    await page.clock.fastForward(53000)
    await expect(page.locator('.job-freshness-notice')).toContainText('이전 조회 결과')
    expect(state.traffic.catalog()).toHaveLength(state.initialAttempts)

    state.respond(route => route.fulfill({ status: 202, headers: { 'Retry-After': '1' }, json: revalidationPartial(iso(61000)) }))
    state.progress(route => route.fulfill({ json: revalidationDelta(iso(61000)) }))
    await visibility(page, 'hidden')
    await hint(page)
    expect(state.traffic.catalog()).toHaveLength(state.initialAttempts)
    await visibility(page, 'visible')
    await hint(page)
    await expect.poll(() => state.traffic.catalog().length).toBe(state.initialAttempts + 1)
    // The native modal keeps background content inert; inspect that progress
    // without claiming the background control is currently keyboard-accessible.
    const backgroundProgress = page.locator('.catalog-collecting progress[aria-label="공개 게시판 조회 진행"]')
    await expect(backgroundProgress).toHaveAttribute('value', '1')
    await expect(page.locator('.job-detail-heading h3')).toHaveText('Backend Engineer Old48')
    await expect(page.getByLabel('이 기회에 대한 나의 메모', { exact: true })).toHaveValue(note)
    await page.clock.fastForward(1000)
    await expect(backgroundProgress).toHaveCount(0)
    await expect(page.getByRole('button', { name: '지원 완료로 표시됨', exact: true })).toBeVisible()
    expect(await readSavedJson(page)).toBe(saved)
    expect(await contextState(page)).toEqual(before)
    await expect(page.locator('.toast')).toHaveCount(0)
    await page.getByLabel('이 기회에 대한 나의 메모', { exact: true }).scrollIntoViewIfNeeded()
    await audit(page, info, width === 320 ? 'return-keeps-saved-job-320.png' : undefined)
    await page.getByRole('button', { name: '닫기', exact: true }).click()
    await expect(page.locator('.mini-job-title')).toHaveText(['Backend Engineer Early48', 'Backend Engineer Later48'])
    await expect(page.locator('.company-card')).toHaveCount(2)
    await expect(query(page)).toHaveValue('Backend')
    expect(await contextState(page)).toEqual(before)
    await evidence(page, info, state, [ordinary, monitor])
  })

  test('one-minute cooldown and catalog refreshAfter gate bursts while an active ordinary request is neither aborted nor duplicated', async ({ page }, info) => {
    const oldTime = iso(-1_800_000)
    const state = await setup(page, revalidationCatalog([revalidationJob('Stale48', { fetchedAt: oldTime })], oldTime))
    const held: Route[] = []
    state.respond(route => { held.push(route) })
    await wallTime(page, 59000)
    await hint(page)
    expect(state.traffic.catalog()).toHaveLength(state.initialAttempts)
    await wallTime(page, 60000)
    await hint(page, 'focus')
    await expect.poll(() => held.length).toBe(1)
    await expect(page.getByRole('button', { name: '공개 공고 조회 중', exact: true })).toBeVisible()
    await wallTime(page, 120000)
    await hint(page)
    expect(state.traffic.catalog()).toHaveLength(state.initialAttempts + 1)
    expect(state.traffic.catalog().at(-1)).toMatchObject({ state: 'pending', error: null })
    const gated = revalidationCatalog([revalidationJob('Stale48', { fetchedAt: oldTime })], oldTime)
    gated.refreshAfter = iso(240000)
    await held[0].fulfill({ json: gated })
    await expect(page.getByRole('button', { name: '공개 채용', exact: true })).toBeVisible()
    for (const offset of [180000, 239000]) {
      await wallTime(page, offset)
      await hint(page)
      expect(state.traffic.catalog()).toHaveLength(state.initialAttempts + 1)
    }
    state.respond(route => route.fulfill({ json: revalidationCatalog([revalidationJob('AfterWait48', { fetchedAt: iso(240000) })], iso(240000)) }))
    await wallTime(page, 240000)
    await hint(page)
    await expect(page.locator('.mini-job-title')).toHaveText(['Backend Engineer AfterWait48'])
    expect(state.traffic.catalog()).toHaveLength(state.initialAttempts + 2)
    await wallTime(page, 300000)
    await hint(page)
    expect(state.traffic.catalog()).toHaveLength(state.initialAttempts + 2)
    await expect(page.locator('.toast')).toHaveCount(0)
    await page.getByRole('button', { name: '공개 채용', exact: true }).click()
    await expect(page.locator('.coverage-stats strong')).toHaveText(['22', '2', '1'])
    await page.locator('.board-heading').scrollIntoViewIfNeeded()
    await audit(page, info, width === 320 ? 'return-recheck-history-320.png' : undefined)
    await page.keyboard.press('Escape')
    await expect(page.getByRole('button', { name: '공개 채용', exact: true })).toBeFocused()
    await evidence(page, info, state, [ordinary, ordinary])
  })

  test('manual refresh owns its monitor, a lost monitor recovers on return, and later sample and public choices defeat an older response', async ({ page }, info) => {
    const state = await setup(page)
    const heldMonitors: Route[] = []
    state.respond(route => route.fulfill({ status: 202, headers: { 'Retry-After': '1' }, json: revalidationPartial(REVALIDATION_TIME) }))
    state.progress(route => { heldMonitors.push(route) })
    await page.getByRole('button', { name: '공개 채용', exact: true }).click()
    await page.getByRole('button', { name: '새로고침', exact: true }).click()
    await expect(page.getByRole('dialog').getByRole('progressbar')).toHaveAttribute('value', '1')
    await page.clock.fastForward(1000)
    await expect.poll(() => heldMonitors.length).toBe(1)
    await wallTime(page, 120000)
    await hint(page)
    expect(state.traffic.catalog()).toHaveLength(state.initialAttempts + 1)
    expect(state.traffic.requests.at(-1)).toMatchObject({ state: 'pending', error: null })
    await heldMonitors[0].fulfill({ status: 503, json: { error: 'Fictional progress connection48', code: 'CATALOG_UNAVAILABLE' } })
    await expect(page.getByRole('dialog').getByRole('alert')).toHaveText('Fictional progress connection48')
    await expect(page.getByRole('dialog').getByRole('progressbar')).toHaveCount(0)
    await hint(page, 'online')
    await expect.poll(() => state.traffic.catalog().length).toBe(state.initialAttempts + 2)
    await expect(page.getByRole('dialog').getByRole('progressbar')).toHaveAttribute('value', '1')
    await page.clock.fastForward(1000)
    await expect.poll(() => heldMonitors.length).toBe(2)
    await page.getByRole('button', { name: /샘플로 탐색/ }).click()
    await expect(page.locator('.coverage-stats strong')).toHaveText(['22', '32', '179'])
    await expect.poll(() => state.traffic.requests.filter(request => request.error === 'net::ERR_ABORTED').length).toBe(state.initialCancelled + 1)
    await wallTime(page, 300000)
    await hint(page)
    expect(state.traffic.catalog()).toHaveLength(state.initialAttempts + 2)
    const latest: Route[] = []
    state.respond(route => { latest.push(route) })
    await page.getByRole('button', { name: /공개 채용공고/ }).click()
    await expect.poll(() => latest.length).toBe(1)
    await heldMonitors[1].fulfill({ json: revalidationDelta(REVALIDATION_TIME) })
    await page.clock.runFor(20)
    await expect(page.locator('.data-loading')).toHaveCount(1)
    await expect(page.getByRole('dialog').getByRole('progressbar')).toHaveCount(0)
    await expect(page.locator('.coverage-stats strong')).toHaveText(['22', '32', '179'])
    await latest[0].fulfill({ json: revalidationCatalog([revalidationJob('FinalChoice48', { fetchedAt: iso(300000) })], iso(300000)) })
    await expect(page.locator('.data-loading')).toHaveCount(0)
    await expect(page.locator('.coverage-stats strong')).toHaveText(['22', '2', '1'])
    await page.getByRole('button', { name: '닫기', exact: true }).click()
    await expect(page.locator('.mini-job-title')).toHaveText(['Backend Engineer FinalChoice48'])
    await expect(query(page)).toHaveValue('Backend')
    expect((await contextState(page)).exploration).toMatchObject(REVALIDATION_EXPLORATION)
    expect(state.traffic.requests.filter(request => request.status === 503)).toHaveLength(1)
    await audit(page, info)
    await evidence(page, info, state, [forced, monitor, ordinary, monitor, ordinary], 1)
  })

  test('a failed switch remains publicly intended despite retained samples, and a malformed refresh can recover while retained data is still fresh', async ({ page }, info) => {
    const state = await setup(page, revalidationCatalog(), 'sample')
    state.respond(route => route.fulfill({ status: 503, headers: { 'Retry-After': '120' }, json: {
      error: 'Fictional public retry48', code: 'CATALOG_UNAVAILABLE', retryAt: iso(120000),
    } }))
    await page.getByRole('button', { name: '샘플 탐색', exact: true }).click()
    await page.getByRole('button', { name: /공개 채용공고/ }).click()
    await expect(page.getByRole('dialog').getByRole('alert')).toHaveText('Fictional public retry48')
    await expect(page.locator('.coverage-stats strong')).toHaveText(['22', '32', '179'])
    expect(state.traffic.catalog()).toHaveLength(1)
    await page.clock.fastForward(8000)
    for (const offset of [60000, 119000]) {
      await wallTime(page, offset)
      await hint(page)
      expect(state.traffic.catalog()).toHaveLength(1)
    }
    state.respond(route => route.fulfill({ json: revalidationCatalog([revalidationJob('RecoveredPublic48', { fetchedAt: iso(120000) })], iso(120000)) }))
    await wallTime(page, 120000)
    await hint(page, 'online')
    await expect(page.locator('.coverage-stats strong')).toHaveText(['22', '2', '1'])
    await expect(page.getByRole('dialog').getByRole('alert')).toHaveCount(0)
    await expect(page.locator('.toast')).toHaveCount(0)
    expect(state.traffic.catalog()).toHaveLength(2)
    const malformed = revalidationCatalog([revalidationJob('MustNotApply48', { fetchedAt: iso(123000) })], iso(123000))
    malformed.jobs[0].id = 'wrong-provider-prefix-48'
    state.respond(route => route.fulfill({ json: malformed }))
    await wallTime(page, 123000)
    await page.getByRole('button', { name: '새로고침', exact: true }).click()
    await expect(page.getByRole('dialog').getByRole('alert')).toHaveText('공고 데이터 형식을 확인하지 못했어요. 다시 조회해 주세요.')
    await expect(page.locator('.coverage-stats strong')).toHaveText(['22', '2', '1'])
    await page.clock.fastForward(8000)
    await wallTime(page, 182000)
    await hint(page)
    expect(state.traffic.catalog()).toHaveLength(3)
    state.respond(route => route.fulfill({ json: revalidationCatalog([revalidationJob('FreshRecovery48', { fetchedAt: iso(183000) })], iso(183000)) }))
    await wallTime(page, 183000)
    await hint(page, 'online')
    await expect(page.getByRole('dialog').getByRole('alert')).toHaveCount(0)
    await expect(page.locator('.toast')).toHaveCount(0)
    await page.getByRole('button', { name: '닫기', exact: true }).click()
    await expect(page.locator('.mini-job-title')).toHaveText(['Backend Engineer FreshRecovery48'])
    await expect(page.getByText('Backend Engineer MustNotApply48', { exact: true })).toHaveCount(0)
    await expect(query(page)).toHaveValue('Backend')
    expect((await contextState(page)).exploration).toMatchObject(REVALIDATION_EXPLORATION)
    expect(state.traffic.requests.filter(request => request.status === 503)).toHaveLength(1)
    await audit(page, info)
    await evidence(page, info, state, [ordinary, ordinary, forced, ordinary])
  })
})
