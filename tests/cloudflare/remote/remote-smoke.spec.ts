import { expect, test as base } from '@playwright/test'
import type { BrowserContext, TestInfo } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { isPublicCatalog } from '../../../src/lib/catalog-validation'
import { ObservationHistorySchema } from '../../../shared/catalog-observations'
import { PostingStatusIndexSchema } from '../../../shared/posting-status'
import type { Catalog } from '../../../shared/types'
import { recentBoards } from './board-freshness'
import type { RecentBoards } from './board-freshness'
import { installRemoteBrowserGuard } from './browser-guard'
import type { BrowserGuard } from './browser-guard'
import { ApiBudgetLedger, remoteConfigFromEnv } from './ledger'
import type { RemoteConfig } from './ledger'
import { createRemoteApi } from './transport'
import type { RemoteResponse } from './transport'

/**
 * Stage82 common design v2 §검증 7 and §최초 운영 수집: read-only smoke and
 * browser journeys against exactly https://job.hyunjun.workers.dev, inside the
 * shared 60-attempt public API budget. Acceptance: 130 configured companies,
 * at least 115 normal boards with a real success whose age at the moment this
 * machine sent the request lies in the inclusive range 0..24 hours (no clock
 * tolerance, never a response timestamp or the arrival time; a future-stamped
 * board never qualifies and is listed as a diagnostic, the frozen criterion
 * being the qualifying count, not an all-board clock rule), valid
 * posting-status and observations for the same generation, and postings that
 * link to real sources. health.ready, historical totals, listing counts and
 * catalog-ID coverage are recorded as diagnostics, never accepted as proof. All
 * failure/rollback injection stays local. Bodies are the Fetch-decoded bytes
 * (never decoded twice); 304 is not a redirect. Every case keeps its primary
 * failure together with finalization failures and the guard outcomes retained
 * in arrays, and the final ledger/interval snapshot is written unconditionally;
 * a ledger that cannot be read fails the finalization after the diagnostic is
 * written.
 */
const REQUIRED_COMPANIES = 130
const REQUIRED_RECENT_BOARDS = 115
const SYNTHETIC_HOSTS = ['example.test', 'example.com', 'localhost', '127.0.0.1']
const LOWERCASE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']
const worktree = fileURLToPath(new URL('../../..', import.meta.url))

const test = base.extend<{ remote: { config: RemoteConfig; ledger: ApiBudgetLedger; api: ReturnType<typeof createRemoteApi> } }>({
  remote: async ({}, use, info) => {
    const config = remoteConfigFromEnv()
    const ledger = new ApiBudgetLedger(config, `remote-smoke|${info.testId}`)
    await use({ config, ledger, api: createRemoteApi(ledger, config) })
  },
})
const started = new Date().toISOString()
const json = <T>(response: RemoteResponse) => JSON.parse(response.body.toString('utf8')) as T
const attach = (info: TestInfo, name: string, value: unknown) => info.attach(name, { body: Buffer.from(JSON.stringify(value, null, 2)), contentType: 'application/json' })
function expectSecurity(response: RemoteResponse) {
  expect(response.headers['x-content-type-options']).toBe('nosniff')
  expect(response.headers['referrer-policy']).toBe('strict-origin-when-cross-origin')
  expect(response.headers['permissions-policy']).toBe('camera=(), microphone=(), geolocation=()')
  expect(response.headers['x-frame-options']).toBe('DENY')
}
type Failure = { error: unknown } | null
type Step = { label: string; run: () => Promise<unknown> }
/** Attempt every finalization step independently, in order, and return the labelled failures. */
async function attemptAll(steps: Step[]): Promise<string[]> {
  const problems: string[] = []
  for (const step of steps) {
    try { await step.run() } catch (error) { problems.push(`${step.label}: ${String(error)}`) }
  }
  return problems
}
/** Surface the primary failure together with every finalization failure (ARR82-5); without a primary, finalization failures fail the case on their own. */
function conclude(primary: Failure, problems: string[]): void {
  if (primary && problems.length) {
    throw new AggregateError([primary.error, ...problems.map(problem => new Error(problem))], `${String(primary.error)} | finalization also failed: ${problems.join(' | ')}`)
  }
  if (primary) throw primary.error
  expect(problems).toEqual([])
}
/** Guard outcomes that drain() retains in arrays rather than throwing (ARR82-R3-3): in the deployed journeys every entry is unexpected, as is pending owned work after the final accounting. */
function guardFailures(guard: BrowserGuard | undefined): string[] {
  if (!guard) return []
  const failures = [
    ...guard.settleErrors.map(value => `settleErrors: ${value}`),
    ...guard.ledgerErrors.map(value => `ledgerErrors: ${value}`),
    ...guard.routeErrors.map(value => `routeErrors: ${value}`),
    ...guard.resourceFailures.map(failure => `resourceFailures: ${failure.url}: ${failure.error}`),
    ...guard.violations.map(violation => `violations: ${violation.method} ${violation.url}: ${violation.reason}`),
  ]
  const pending = guard.pending()
  if (pending.handlers || pending.writes) failures.push(`owned work still pending after the final accounting: ${JSON.stringify(pending)}`)
  return failures
}
const record = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
const lengthOf = (value: unknown): number | null => Array.isArray(value) ? value.length : null
/** Diagnostic summary that tolerates an absent or malformed body, so the original acceptance failure is what gets reported (ARR82-5). */
function catalogSummary(body: unknown) {
  const catalog = record(body)
  const publication = record(catalog?.publication)
  return {
    publicationPresent: publication !== null, publishedAt: publication?.publishedAt ?? null, fetchedAt: catalog?.fetchedAt ?? null, stale: catalog?.stale ?? null,
    companies: lengthOf(catalog?.companies), boards: lengthOf(catalog?.boards), jobs: lengthOf(catalog?.jobs),
  }
}

test.describe.configure({ mode: 'serial' })
let catalog: Catalog | undefined
let generation: string | undefined

/**
 * Unconditional final evidence (ART82-6/ARR82-5): the ledger and interval are
 * captured even when an earlier serial test failed. A ledger that cannot be read
 * is written as the diagnostic and then fails this hook: a lost or corrupt used
 * ledger halts remote work and is never reported as a successful finalization.
 */
test.afterAll(async () => {
  const snapshot: Record<string, unknown> = { interval: { startedAt: started, endedAt: new Date().toISOString() }, generation: generation ?? null }
  const failures: unknown[] = []
  try {
    const config = remoteConfigFromEnv()
    const file = await new ApiBudgetLedger(config, 'final-snapshot').read()
    snapshot.origin = config.origin
    snapshot.ledger = { path: config.ledgerPath, attempts: file.attempts.length, max: file.max, remaining: file.max - file.attempts.length, unresolved: file.attempts.filter(attempt => attempt.status === undefined && attempt.error === undefined).length, entries: file.attempts }
  } catch (error) {
    snapshot.ledgerError = String(error)
    failures.push(error)
  }
  try {
    await mkdir(path.join(worktree, '.local/remote-smoke'), { recursive: true })
    await writeFile(path.join(worktree, '.local/remote-smoke/ledger-final.json'), `${JSON.stringify(snapshot, null, 2)}\n`)
  } catch (error) {
    failures.push(error)
  }
  if (failures.length) throw new AggregateError(failures, `Final ledger evidence failed; remote work must halt until the used ledger is accounted for: ${failures.map(String).join(' | ')}`)
})

test('health reports the scheduled Worker (recorded, not accepted)', async ({ remote }, info) => {
  const response = await remote.api.get('/api/health')
  expect(response.status).toBe(200)
  expect(response.redirected).toBe(false)
  expectSecurity(response)
  const health = json<Record<string, unknown>>(response)
  expect(health).toMatchObject({ status: 'ok', app: 'orbit', mode: 'production', delivery: 'scheduled', intervalMinutes: 30, boards: REQUIRED_COMPANIES })
  expect(typeof health.generation === 'string' ? LOWERCASE_UUID.test(health.generation) : health.generation === null).toBe(true)
  await attach(info, 'remote-health', { requestedAt: response.requestedAt, respondedAt: response.respondedAt, elapsedMs: response.elapsedMs, health, note: 'ready/usableBoards are recorded; acceptance comes from the catalog boards below' })
})

test('the catalog has 130 companies, at least 115 boards with a real success in the 24 hours before the request started, and postings linking to real sources', async ({ remote }, info) => {
  const response = await remote.api.get('/api/catalog?source=public')
  let body: unknown
  let freshness: RecentBoards | undefined
  let primary: Failure = null
  try {
    expect(response.status).toBe(200)
    expect(response.redirected).toBe(false)
    expectSecurity(response)
    expect(response.headers['cache-control']).toBe('private, no-cache, must-revalidate')
    expect(response.headers.etag).toMatch(/^W\/"[a-f0-9]{64}"$/)
    body = json<unknown>(response)
    expect(isPublicCatalog(body), 'the body must be a structurally valid, consistent public catalog').toBe(true)
    const accepted = body as Catalog
    catalog = accepted
    generation = response.headers['x-orbit-generation']
    expect(generation).toMatch(LOWERCASE_UUID)
    expect(accepted.publication).toEqual({ mode: 'scheduled', generation, publishedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/), intervalMinutes: 30 })
    expect(accepted.companies).toHaveLength(REQUIRED_COMPANIES)
    expect(accepted.boards).toHaveLength(REQUIRED_COMPANIES)
    // The reference is this machine's clock when the request was sent (ARR82-1/MRS82-1): inclusive age 0..24h, no tolerance, never a response timestamp or the arrival time.
    // A future-stamped board contributes nothing to the count and is listed in the attachment; the frozen acceptance is the qualifying count below (ARR82-R3-2).
    freshness = recentBoards(accepted, response.requestedAt)
    expect(accepted.jobs.length).toBeGreaterThan(0)
    const sampled = accepted.jobs.filter((_, index) => index % Math.max(1, Math.floor(accepted.jobs.length / 20)) === 0).slice(0, 20)
    for (const job of sampled) {
      const url = new URL(job.url)
      expect(url.protocol, job.id).toBe('https:')
      expect(SYNTHETIC_HOSTS.some(host => url.hostname === host || url.hostname.endsWith(`.${host}`)), job.id).toBe(false)
      expect(accepted.companies.some(company => company.id === job.companyId), job.id).toBe(true)
    }
    expect(freshness.qualifying).toBeGreaterThanOrEqual(REQUIRED_RECENT_BOARDS)
  } catch (error) {
    primary = { error }
  }
  const problems = await attemptAll([{
    label: 'attach',
    run: () => attach(info, 'remote-catalog-summary', {
      requestedAt: response.requestedAt, respondedAt: response.respondedAt, elapsedMs: response.elapsedMs, generation, status: response.status,
      ...catalogSummary(body),
      freshnessReference: response.requestedAt,
      freshnessRule: 'status ok, dataStatus not unavailable, 0 ms <= requestedAt - lastSuccessAt <= 86400000 ms; no clock tolerance; reference is the client request-start clock; future boards never qualify',
      qualifyingBoards: freshness?.qualifying ?? null, requiredQualifyingBoards: REQUIRED_RECENT_BOARDS, requiredCompanies: REQUIRED_COMPANIES,
      futureBoards: freshness?.boards.filter(board => board.reason === 'future') ?? null, boardFreshness: freshness?.boards ?? null,
      primaryFailure: primary ? String(primary.error) : null,
      note: 'historical 6,819 jobs / 130 ok boards are not acceptance; the counts above are this run\'s observation against the actual request-start time',
    }),
  }])
  conclude(primary, problems)
})

test('posting-status and observations of the same generation are valid and consistent with the catalog', async ({ remote }, info) => {
  expect(generation, 'the catalog test must have pinned a generation').toBeDefined()
  const status = await remote.api.get(`/api/posting-status?generation=${generation}`)
  expect(status.status).toBe(200)
  expect(status.redirected).toBe(false)
  expect(status.headers['x-orbit-generation']).toBe(generation)
  const index = json<Record<string, any>>(status)
  expect(PostingStatusIndexSchema.safeParse(index).success).toBe(true)
  expect(index.boards).toHaveLength(REQUIRED_COMPANIES)
  const companyIds = new Set(catalog!.companies.map(company => company.id))
  expect(index.boards.every((board: { companyId: string }) => companyIds.has(board.companyId))).toBe(true)
  // Diagnostics only (ART82-4): listing and body data have independent lifetimes; the frozen acceptance is the 130/115 board criterion above.
  const catalogIds = new Set(catalog!.jobs.map(job => job.id))
  const listed = index.boards.filter((board: { listing?: { publishedIds: string[] } }) => board.listing)
  const published = new Set(listed.flatMap((board: { listing: { publishedIds: string[] } }) => board.listing.publishedIds))
  const coverage = catalog!.jobs.length ? catalog!.jobs.filter(job => published.has(job.id)).length / catalog!.jobs.length : null
  const observations = await remote.api.get(`/api/observations?generation=${generation}`)
  expect(observations.status).toBe(200)
  expect(observations.redirected).toBe(false)
  expect(observations.headers['x-orbit-generation']).toBe(generation)
  const history = json<Record<string, any>>(observations)
  expect(ObservationHistorySchema.safeParse(history).success).toBe(true)
  expect(history.storage).toBe('ok')
  expect(new Set(history.scope.boards.map((board: { companyId: string }) => board.companyId))).toEqual(companyIds)
  expect(history.days.length).toBeGreaterThanOrEqual(1)
  // The newest day is selected explicitly; stats exist only on a complete point (ART82-3/MREMOTE82-5) and partial availability is reported, not failed.
  const newest = [...history.days].sort((left: { day: string }, right: { day: string }) => left.day.localeCompare(right.day)).at(-1) as Record<string, any>
  expect(newest.day).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  expect(Number.isFinite(Date.parse(newest.latest.observedAt))).toBe(true)
  expect(newest.latest.boards.length).toBeGreaterThan(0)
  const complete = newest.complete ?? null
  if (complete) expect(Number.isFinite(complete.stats.published)).toBe(true)
  await attach(info, 'remote-consistency', {
    generation, boards: index.boards.length,
    diagnostics: { listedBoards: listed.length, publishedIds: published.size, catalogJobs: catalogIds.size, catalogIdCoverage: coverage, note: 'listing counts and ID coverage are diagnostics, not the frozen acceptance' },
    observations: {
      days: history.days.map((day: { day: string }) => day.day), newestDay: newest.day, latestObservedAt: newest.latest.observedAt, latestBoards: newest.latest.boards.length,
      latestIncompleteBoards: newest.latest.boards.filter((board: { status: string }) => board.status !== 'complete').length,
      completeAvailable: Boolean(complete), stats: complete?.stats ?? null, partial: !complete,
    },
    elapsedMs: { postingStatus: status.elapsedMs, observations: observations.elapsedMs },
  })
})

test('HEAD and conditional revalidation work at the edge', async ({ remote }, info) => {
  const head = await remote.api.head('/api/catalog?source=public')
  expect(head.status).toBe(200)
  expect(head.redirected).toBe(false)
  expect(head.headers.etag).toMatch(/^W\/"[a-f0-9]{64}"$/)
  expect(head.body.length).toBe(0)
  const revalidated = await remote.api.get('/api/catalog?source=public', { 'If-None-Match': head.headers.etag })
  expect([304, 200]).toContain(revalidated.status)
  expect(revalidated.redirected).toBe(false)
  if (revalidated.status === 200) expect(revalidated.headers.etag, 'a 200 after If-None-Match means the representation changed in between').not.toBe(head.headers.etag)
  else expect(revalidated.body.length).toBe(0)
  expect(revalidated.headers.vary).toBe('Accept-Encoding')
  await attach(info, 'remote-revalidation', { head: { status: head.status, etag: head.headers.etag }, revalidated: { status: revalidated.status, etag: revalidated.headers.etag } })
})

for (const width of [1440, 320]) test(`browser journey at ${width}px inside the guarded transport`, async ({ browser, remote }, info) => {
  const errors: string[] = []
  let context: BrowserContext | undefined
  let guard: BrowserGuard | undefined
  let primary: Failure = null
  try {
    context = await browser.newContext({ viewport: { width, height: 960 }, isMobile: width === 320, hasTouch: width === 320, serviceWorkers: 'block', reducedMotion: 'reduce' })
    guard = await installRemoteBrowserGuard(context, remote.ledger, remote.config)
    const page = await context.newPage()
    page.on('pageerror', error => errors.push(error.message))
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
    await page.goto('/', { waitUntil: 'domcontentloaded' })
    await expect(page.locator('.earth-canvas')).toHaveClass(/is-ready/)
    await expect(page.locator('.city-row').first()).toBeVisible()
    await expect(page.locator('.map-stats strong').first()).toHaveText(/^\d+곳$/)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    if (width === 1440) {
      await page.getByLabel('도시, 회사 또는 포지션 검색').fill('London')
      await expect(page.locator('.city-row').first()).toBeVisible()
      await page.locator('.active-filter-summary').getByRole('button', { name: '초기화', exact: true }).click()
      await page.getByRole('button', { name: '데이터와 추천 방식', exact: true }).click()
      const dialog = page.getByRole('dialog')
      await expect(dialog.getByRole('heading', { name: '예약 수집으로 갱신되는 공고' })).toBeVisible()
      await expect(dialog.getByText('새로고침은 최근 발행 자료를 다시 읽습니다. 채용 사이트의 수집을 즉시 실행하지 않아요.', { exact: true })).toBeVisible()
      await expect(dialog.locator('p').filter({ hasText: '최근 발행 ·' }).locator('time')).toHaveAttribute('datetime', /^\d{4}-\d{2}-\d{2}T/)
    }
    expect((await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze()).violations).toEqual([])
    expect(errors).toEqual([])
    // Stop new browser activity and join every admitted handler and outcome write before the evidence is read (ARR82-3).
    await guard.drain()
    expect(guard.settleErrors).toEqual([])
    expect(guard.ledgerErrors).toEqual([])
    expect(guard.routeErrors).toEqual([])
    expect(guard.violations).toEqual([])
    expect(guard.resourceFailures).toEqual([])
    expect(guard.apiRequests.every(request => request.method === 'GET' && request.status === 200)).toBe(true)
    expect(guard.apiRequests.filter(request => request.path.startsWith('/api/catalog')).length).toBe(1)
  } catch (error) {
    primary = { error }
  }
  // Each owned step is attempted independently and every failure is kept (ART82-6/MREMOTE82-3/ARR82-5): stop/join, close, a final bounded
  // accounting after closure (ARR82-R3-4), then the guard outcomes retained in arrays are surfaced unconditionally (ARR82-R3-3) before the
  // evidence is attached with the cleanup outcomes.
  const cleanup = await attemptAll([
    { label: 'drain', run: async () => { if (guard) await guard.drain() } },
    { label: 'context.close', run: async () => { if (context) await context.close() } },
    { label: 'post-close-accounting', run: async () => { if (guard) await guard.drain({ timeoutMs: 10_000 }) } },
  ])
  cleanup.push(...guardFailures(guard))
  cleanup.push(...await attemptAll([{
    label: 'attach',
    run: () => attach(info, `remote-browser-${width}`, {
      apiRequests: guard?.apiRequests ?? null, violations: guard?.violations ?? null, resourceFailures: guard?.resourceFailures ?? null,
      routeErrors: guard?.routeErrors ?? null, ledgerErrors: guard?.ledgerErrors ?? null, lateRequests: guard?.lateRequests ?? null, settleErrors: guard?.settleErrors ?? null,
      pendingAfterAccounting: guard?.pending() ?? null, errors, cleanup: [...cleanup], primaryFailure: primary ? String(primary.error) : null,
    }),
  }]))
  conclude(primary, cleanup)
})

test('the ledger stayed within budget and records the smoke interval for Main\'s control-plane observation', async ({ remote }, info) => {
  const file = await remote.ledger.read()
  expect(file.attempts.length).toBeLessThanOrEqual(file.max)
  expect(file.attempts.every(attempt => (attempt.method === 'GET' || attempt.method === 'HEAD') && attempt.path.startsWith('/api/'))).toBe(true)
  expect(file.attempts.every(attempt => attempt.status !== undefined || attempt.error !== undefined)).toBe(true)
  await attach(info, 'remote-smoke-ledger', {
    origin: remote.config.origin, interval: { startedAt: started, endedAt: new Date().toISOString() },
    attempts: file.attempts.length, max: file.max, remaining: file.max - file.attempts.length, generation, initialized: file.initialized ?? null,
    ledger: file.attempts,
  })
})
