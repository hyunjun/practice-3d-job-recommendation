import { expect, test } from '@playwright/test'
import type { BrowserContext, Page } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { installRemoteBrowserGuard } from './browser-guard'
import type { BrowserGuard } from './browser-guard'
import { ApiBudgetLedger, REMOTE_MAX_API_REQUESTS } from './ledger'
import type { LedgerFile, RemoteConfig } from './ledger'
import { LOCAL_HEALTH, startLocalOrigin } from './local-origin'
import type { HeldRoute, LocalOrigin } from './local-origin'

/**
 * Real Chromium through the browser guard against owned loopback origins
 * (ART82-1/6/7, MREMOTE82-1/3, ARR82-2/3/4, ARR82-R3-1/3/4, MRR82-R9/R10): gzip
 * JSON delivered decoded, HEAD counted, every redirect (same-origin API,
 * same-origin static, off-origin) refused before the browser can follow it,
 * method and off-origin violations never reach a server, a connection failure is
 * charged and recorded, the 60-attempt budget stops the 61st request before send
 * with its structured code and actual message, and an early failure while a
 * counted request is still pending at the server: the first bounded join times
 * out and stays recorded, new activity is refused, the hold is released and the
 * work joined as independent obligations, evidence is read, the context closed, a
 * final post-close accounting performed, and the scratch directory removed only
 * when nothing owned can still write to it. Every guard outcome retained in
 * arrays is accounted for unconditionally next to the primary failure; expected
 * violations are acknowledged only as the exact verified multiset. The shared
 * ledger directory of the first case is owned through suite teardown and removed
 * only after bounded accounting shows nothing owned can still write to it. The
 * guard is configured with the local origin as its exact origin; the production
 * origin constant and the runner environment are not involved, so nothing can
 * contact the deployed Worker from here.
 */
test.describe.configure({ mode: 'serial' })
let origin: LocalOrigin
let foreign: LocalOrigin
let directory: string | undefined
let config: RemoteConfig
let ledger: ApiBudgetLedger
const UUID = 'abcdef12-abcd-4abc-8abc-abcdefabcdef'
/** A counted public API path the local origin holds until released (allowed query parameters only). */
const HELD_PATH = `/api/observations?generation=${UUID}&refresh=1`

type Failure = { error: unknown } | null
type Step = { label: string; run: () => Promise<unknown> }
type Violation = BrowserGuard['violations'][number]
/** Attempt every finalization step independently, in order, and return the labelled failures. */
async function attemptAll(steps: Step[]): Promise<string[]> {
  const problems: string[] = []
  for (const step of steps) {
    try { await step.run() } catch (error) { problems.push(`${step.label}: ${String(error)}`) }
  }
  return problems
}
/** Surface the primary failure together with every finalization failure; without a primary, finalization failures fail the case on their own. */
function conclude(primary: Failure, problems: string[]): void {
  if (primary && problems.length) {
    throw new AggregateError([primary.error, ...problems.map(problem => new Error(problem))], `${String(primary.error)} | finalization also failed: ${problems.join(' | ')}`)
  }
  if (primary) throw primary.error
  expect(problems).toEqual([])
}
const violationKey = (violation: Violation) => JSON.stringify([violation.method, violation.url, violation.reason])
/** Violations as a comparable multiset (sorted by method, URL and reason). */
const sortedViolations = (violations: Violation[]) => [...violations].sort((left, right) => violationKey(left).localeCompare(violationKey(right)))
/**
 * Guard outcomes that drain() retains in arrays rather than throwing (ARR82-R3-3,
 * MRR82-R10): every entry the case has not explicitly acknowledged is a failure
 * to surface, and pending owned work after the final accounting is one too.
 * Acknowledged values are subtracted as exact records with multiplicity, never as
 * a blanket exemption of a whole array.
 */
function guardFailures(guard: BrowserGuard | undefined, acknowledged: { violations?: Violation[]; ledgerErrors?: string[]; settleErrors?: string[] } = {}): string[] {
  if (!guard) return []
  const failures: string[] = []
  const unexpected = <T>(label: string, values: T[], accepted: T[] = [], key: (value: T) => string) => {
    const remaining = values.map(key)
    for (const value of accepted.map(key)) {
      const index = remaining.indexOf(value)
      if (index >= 0) remaining.splice(index, 1)
    }
    failures.push(...remaining.map(value => `${label}: ${value}`))
  }
  unexpected('settleErrors', guard.settleErrors, acknowledged.settleErrors, value => value)
  unexpected('ledgerErrors', guard.ledgerErrors, acknowledged.ledgerErrors, value => value)
  unexpected('routeErrors', guard.routeErrors, [], value => value)
  unexpected('violations', guard.violations, acknowledged.violations, violationKey)
  failures.push(...guard.resourceFailures.map(failure => `resourceFailures: ${failure.url}: ${failure.error}`))
  const pending = guard.pending()
  if (pending.handlers || pending.writes) failures.push(`owned work still pending after the final accounting: ${JSON.stringify(pending)}`)
  return failures
}

/** Guards whose outcome writes target the shared ledger directory; teardown removes that directory only after their bounded accounting shows nothing pending (MRR82-R9). */
const sharedLedgerGuards: BrowserGuard[] = []

test.beforeAll(async () => {
  origin = await startLocalOrigin()
  foreign = await startLocalOrigin()
  origin.setForeignOrigin(foreign.origin)
  directory = await mkdtemp(path.join(os.tmpdir(), 'orbit-local-guard-'))
  config = { origin: origin.origin, max: REMOTE_MAX_API_REQUESTS, ledgerPath: path.join(directory, 'deployed-api-budget.json') }
  ledger = new ApiBudgetLedger(config, 'local-guard')
  expect((await ledger.initialize('local-guard')).created).toBe(true)
})
/** Only acquired shared resources are released; each release is attempted independently and every failure is reported. */
test.afterAll(async () => {
  const problems = await attemptAll([
    { label: 'origin.close', run: async () => { if (origin) await origin.close() } },
    { label: 'foreign.close', run: async () => { if (foreign) await foreign.close() } },
    {
      label: 'directory.remove',
      run: async () => {
        if (!directory) return
        // The shared ledger directory is removed only when every guard that writes into it is confirmed settled; otherwise the path is retained and reported.
        const pending: string[] = []
        for (const guard of sharedLedgerGuards) {
          await guard.drain({ timeoutMs: 10_000 })
          const state = guard.pending()
          if (state.handlers || state.writes) pending.push(JSON.stringify(state))
        }
        if (pending.length) throw new Error(`shared ledger directory ${directory} is retained: owned work may still write to it (${pending.join(', ')})`)
        await rm(directory, { recursive: true, force: true })
      },
    },
  ])
  expect(problems).toEqual([])
})
const pageFetch = (page: Page, input: string, init: { method?: string } = {}) =>
  page.evaluate(async ([url, options]) => {
    try {
      const response = await fetch(url, options as RequestInit)
      const text = await response.text()
      return { ok: true as const, status: response.status, encoding: response.headers.get('content-encoding'), text }
    } catch (error) {
      return { ok: false as const, error: String(error) }
    }
  }, [input, init] as const)
const sawPath = (server: LocalOrigin, pathWithQuery: string, method = 'GET') => server.requests.filter(request => request.path === pathWithQuery && request.method === method).length

test('the guard admits, counts and decodes real API responses, refuses every redirect and violation before send, and stops at the 61st attempt', async ({ browser }) => {
  test.setTimeout(300_000)
  let context: BrowserContext | undefined
  let guard: BrowserGuard | undefined
  let acknowledgedViolations: Violation[] = []
  let primary: Failure = null
  try {
    context = await browser.newContext({ serviceWorkers: 'block' })
    guard = await installRemoteBrowserGuard(context, ledger, config)
    // This guard writes into the shared ledger directory: it is owned through suite teardown (MRR82-R9).
    sharedLedgerGuards.push(guard)
    const page = await context.newPage()
    await page.goto(`${origin.origin}/`)
    await expect(page.locator('#out')).toHaveText('guard witness')
    // 1. gzip JSON: the page receives the decoded body of a counted 200.
    const health = await pageFetch(page, '/api/health')
    expect(health).toMatchObject({ ok: true, status: 200 })
    expect(JSON.parse((health as { text: string }).text)).toEqual(LOCAL_HEALTH)
    expect(origin.requests.at(-1)).toMatchObject({ method: 'GET', path: '/api/health' })
    expect(/\bgzip\b/.test(String(origin.requests.at(-1)!.headers['accept-encoding'] ?? ''))).toBe(true)
    // 2. HEAD is counted like GET.
    expect(await pageFetch(page, '/api/health', { method: 'HEAD' })).toMatchObject({ ok: true, status: 200 })
    expect(sawPath(origin, '/api/health', 'HEAD')).toBe(1)
    // 3. A same-origin API redirect is refused: the page's fetch fails, the redirect target is never requested.
    const catalog = await pageFetch(page, '/api/catalog?source=public')
    expect(catalog.ok).toBe(false)
    expect(sawPath(origin, '/api/catalog?source=public')).toBe(1)
    expect(sawPath(origin, '/elsewhere')).toBe(0)
    // 4. A same-origin static redirect is refused too (uncounted); its target is never requested through the hop.
    const asset = await pageFetch(page, '/redirect-asset')
    expect(asset.ok).toBe(false)
    expect(sawPath(origin, '/assets/app.js')).toBe(0)
    // 5. An off-origin redirect is refused before the foreign origin sees anything.
    expect((await pageFetch(page, '/redirect-off-origin')).ok).toBe(false)
    expect(foreign.requests).toEqual([])
    // 6. Method and off-origin violations never leave the browser.
    expect((await pageFetch(page, '/api/health', { method: 'POST' })).ok).toBe(false)
    expect(origin.requests.some(request => request.method === 'POST')).toBe(false)
    expect((await pageFetch(page, `${foreign.origin}/api/health`)).ok).toBe(false)
    expect(foreign.requests).toEqual([])
    // 7. A connection failure is charged and recorded with its error; no retry happens.
    const dropped = await pageFetch(page, '/api/posting-status?refresh=1')
    expect(dropped.ok).toBe(false)
    expect(sawPath(origin, '/api/posting-status?refresh=1')).toBe(1)
    // 8. The remaining budget: fill to exactly 60 counted attempts, then the 61st is refused before send.
    const countedSoFar = guard.apiRequests.length
    expect(countedSoFar).toBe(4)
    const healthBefore = sawPath(origin, '/api/health')
    for (let index = countedSoFar; index < REMOTE_MAX_API_REQUESTS; index++) {
      expect((await pageFetch(page, `/api/observations?generation=${UUID}`)).ok, `attempt ${index + 1}`).toBe(true)
    }
    const refused = await pageFetch(page, '/api/health')
    expect(refused.ok).toBe(false)
    expect(sawPath(origin, '/api/health')).toBe(healthBefore)
    // Stop new activity and join every admitted handler and outcome write before the evidence is read.
    await guard.drain()
    expect(guard.settleErrors).toEqual([])
    expect(guard.lateRequests).toEqual([])
    expect(guard.pending()).toEqual({ handlers: 0, writes: 0 })
    expect(guard.ledgerErrors).toEqual([])
    expect(guard.routeErrors).toEqual([])
    expect(guard.apiRequests).toHaveLength(REMOTE_MAX_API_REQUESTS)
    expect(guard.apiRequests.map(request => request.sequence)).toEqual(Array.from({ length: REMOTE_MAX_API_REQUESTS }, (_, index) => index + 1))
    expect(guard.apiRequests.filter(request => request.error !== null)).toHaveLength(1)
    expect(guard.apiRequests.filter(request => request.status === 302)).toHaveLength(1)
    // The complete expected violation multiset (URL, method, reason, multiplicity): three refused redirects, the method and off-origin
    // violations, and the 61st attempt refused by the ledger with its structured code and actual message (ARR82-2/MRT82-2, MRR82-R10).
    const expectedViolations: Violation[] = [
      { url: `${origin.origin}/api/catalog?source=public`, method: 'GET', reason: 'redirect:302:/elsewhere' },
      { url: `${origin.origin}/redirect-asset`, method: 'GET', reason: 'redirect:302:/assets/app.js' },
      { url: `${origin.origin}/redirect-off-origin`, method: 'GET', reason: `redirect:302:${foreign.origin}/api/health` },
      { url: `${origin.origin}/api/health`, method: 'POST', reason: 'method' },
      { url: `${foreign.origin}/api/health`, method: 'GET', reason: 'off-origin' },
      { url: `${origin.origin}/api/health`, method: 'GET', reason: 'ledger:BUDGET_EXHAUSTED:The 60-attempt public API budget is exhausted' },
    ]
    expect(sortedViolations(guard.violations)).toEqual(sortedViolations(expectedViolations))
    // Only this fully verified multiset is acknowledged; anything appended later or beyond it surfaces in the final accounting.
    acknowledgedViolations = expectedViolations
    const file = await ledger.read()
    expect(file.attempts).toHaveLength(REMOTE_MAX_API_REQUESTS)
    expect(file.attempts.every(attempt => attempt.status !== undefined || attempt.error !== undefined)).toBe(true)
    expect(file.attempts.filter(attempt => attempt.method === 'HEAD')).toHaveLength(1)
    await expect(ledger.reserve({ method: 'GET', path: '/api/health' })).rejects.toMatchObject({ code: 'BUDGET_EXHAUSTED', message: 'The 60-attempt public API budget is exhausted' })
  } catch (error) {
    primary = { error }
  }
  // Finalization runs on every path: stop/join, close, a final bounded accounting after closure, then every retained guard outcome not exactly acknowledged is surfaced (ARR82-R3-3/4, MRR82-R10).
  const problems = await attemptAll([
    { label: 'drain', run: async () => { if (guard) await guard.drain() } },
    { label: 'context.close', run: async () => { if (context) await context.close() } },
    { label: 'post-close-accounting', run: async () => { if (guard) await guard.drain({ timeoutMs: 10_000 }) } },
  ])
  problems.push(...guardFailures(guard, { violations: acknowledgedViolations }))
  conclude(primary, problems)
})

interface StopWitness {
  pendingAfterTimeout: { handlers: number; writes: number } | null
  settleErrorsAfterTimeout: string[] | null
  lateFetch: Awaited<ReturnType<typeof pageFetch>> | null
  healthHitsDuringStop: number | null
  pendingAfterRelease: { handlers: number; writes: number } | null
  ledger: LedgerFile | null
}
const FIRST_DRAIN_MS = 500
/** The one expected finalization failure of the controlled case: the first bounded join times out on the deliberately held handler. */
const EXPECTED_SETTLE_ERRORS = [`1 route handler(s) still pending after the ${FIRST_DRAIN_MS}ms drain bound`]
/** The accepted narrow post-send record witness: both charged attempts' outcome writes fail synthetically. */
const EXPECTED_LEDGER_ERRORS = ['Error: synthetic ledger write failure', 'Error: synthetic ledger write failure']

test('an early failure while a counted request is pending: the first join times out and stays recorded, new activity stops, the hold is released and the work joined independently, and evidence, closure and removal follow only after accounting', async ({ browser }) => {
  const deliberate = new Error('deliberate early failure while a counted request is pending')
  let scratch: string | undefined
  let failingLedger: ApiBudgetLedger | undefined
  let hold: HeldRoute | undefined
  let context: BrowserContext | undefined
  let guard: BrowserGuard | undefined
  let page: Page | undefined
  let primary: Failure = null
  const witness: StopWitness = { pendingAfterTimeout: null, settleErrorsAfterTimeout: null, lateFetch: null, healthHitsDuringStop: null, pendingAfterRelease: null, ledger: null }
  try {
    // Acquisition happens inside the owned scope (ARR82-4): whatever was acquired is released below, on every path.
    scratch = await mkdtemp(path.join(os.tmpdir(), 'orbit-local-guard-fail-'))
    const failingConfig: RemoteConfig = { origin: origin.origin, max: REMOTE_MAX_API_REQUESTS, ledgerPath: path.join(scratch, 'ledger.json') }
    failingLedger = new ApiBudgetLedger(failingConfig, 'local-guard-fail')
    expect((await failingLedger.initialize('local-guard-fail')).created).toBe(true)
    // Reservations succeed and requests are sent; every outcome write fails synthetically after the send, as a disk or lock failure would (accepted narrow witness; no physical fault).
    failingLedger.record = async () => { throw new Error('synthetic ledger write failure') }
    hold = origin.hold(HELD_PATH)
    context = await browser.newContext({ serviceWorkers: 'block' })
    guard = await installRemoteBrowserGuard(context, failingLedger, failingConfig)
    page = await context.newPage()
    await page.goto(`${origin.origin}/`)
    expect(await pageFetch(page, '/api/health')).toMatchObject({ ok: true, status: 200 })
    // A second counted request is reserved, sent and held by the server: its handler is pending in route.fetch with no outcome write scheduled yet.
    await page.evaluate(url => { void fetch(url).catch(() => undefined) }, HELD_PATH)
    expect(await hold.arrived).toMatchObject({ method: 'GET', path: HELD_PATH })
    await expect.poll(() => guard!.pending().handlers, { timeout: 5_000 }).toBe(1)
    throw deliberate
  } catch (error) {
    primary = { error }
  }
  // Finalization (ARR82-R3-1/4): every obligation is attempted independently. The first bounded join is expected to time out while the route
  // is held and its failure stays recorded; the hold is released whether or not a guard exists; the owned work is joined again before evidence,
  // closure and removal; a final accounting runs after the context closed; the scratch ledger is removed only when nothing owned can still write to it.
  const problems = await attemptAll([
    {
      label: 'stop-and-first-join',
      run: async () => {
        if (!guard) return
        await guard.drain({ timeoutMs: FIRST_DRAIN_MS })
        witness.pendingAfterTimeout = guard.pending()
        witness.settleErrorsAfterTimeout = [...guard.settleErrors]
      },
    },
    {
      label: 'shutdown-probe',
      run: async () => {
        if (!guard || !page) return
        const healthBefore = sawPath(origin, '/api/health')
        witness.lateFetch = await pageFetch(page, '/api/health')
        witness.healthHitsDuringStop = sawPath(origin, '/api/health') - healthBefore
      },
    },
    { label: 'release-hold', run: async () => { hold?.release() } },
    {
      label: 'final-join',
      run: async () => {
        if (!guard) return
        await guard.drain({ timeoutMs: 20_000 })
        witness.pendingAfterRelease = guard.pending()
      },
    },
    { label: 'ledger-evidence', run: async () => { if (failingLedger) witness.ledger = await failingLedger.read() } },
    { label: 'context.close', run: async () => { if (context) await context.close() } },
    { label: 'post-close-accounting', run: async () => { if (guard) await guard.drain({ timeoutMs: 10_000 }) } },
    {
      label: 'scratch.remove',
      run: async () => {
        if (!scratch) return
        const pending = guard?.pending() ?? { handlers: 0, writes: 0 }
        if (pending.handlers || pending.writes) throw new Error(`scratch ${scratch} is retained: owned work may still write to it (${JSON.stringify(pending)})`)
        await rm(scratch, { recursive: true, force: true })
      },
    },
  ])
  // Accounting (ARR82-R3-3): the synthetic record failures and the first-join timeout are acknowledged only after their assertions succeed;
  // every other retained outcome, finalization problem or witness mismatch is reported together with the primary.
  const witnessFailures: string[] = []
  const check = (label: string, assertion: () => void) => {
    try { assertion() } catch (error) { witnessFailures.push(`${label}: ${String(error)}`) }
  }
  let acknowledgedLedgerErrors: string[] = []
  let acknowledgedSettleErrors: string[] = []
  check('both outcome writes failed synthetically', () => {
    expect(guard?.ledgerErrors).toEqual(EXPECTED_LEDGER_ERRORS)
    acknowledgedLedgerErrors = EXPECTED_LEDGER_ERRORS
  })
  check('the first join timed out on the held handler and the timeout stayed recorded', () => {
    expect(witness.pendingAfterTimeout).toEqual({ handlers: 1, writes: 0 })
    expect(witness.settleErrorsAfterTimeout).toEqual(EXPECTED_SETTLE_ERRORS)
    expect(guard?.settleErrors).toEqual(EXPECTED_SETTLE_ERRORS)
    acknowledgedSettleErrors = EXPECTED_SETTLE_ERRORS
  })
  check('a request during shutdown was refused before the server saw it', () => {
    expect(witness.lateFetch).toMatchObject({ ok: false })
    expect(witness.healthHitsDuringStop).toBe(0)
    expect(guard?.lateRequests).toEqual([{ url: `${origin.origin}/api/health`, method: 'GET' }])
  })
  check('the held request completed after release and its late outcome write was joined', () => {
    expect(witness.pendingAfterRelease).toEqual({ handlers: 0, writes: 0 })
    expect(guard?.apiRequests.map(request => [request.sequence, request.path, request.status, request.error])).toEqual([[1, '/api/health', 200, null], [2, HELD_PATH, 200, null]])
  })
  check('both charged attempts stay charged and explicitly unrecorded; the refused late request was never reserved', () => {
    expect(witness.ledger?.attempts.map(attempt => [attempt.sequence, attempt.path, attempt.status ?? null, attempt.recordedAt ?? null])).toEqual([
      [1, '/api/health', null, null], [2, HELD_PATH, null, null],
    ])
  })
  const failures = [...problems, ...witnessFailures, ...guardFailures(guard, { ledgerErrors: acknowledgedLedgerErrors, settleErrors: acknowledgedSettleErrors })]
  // The primary must be exactly the deliberate sentinel; anything else is an unexpected primary and is rethrown with every diagnostic.
  if (primary?.error !== deliberate) {
    const unexpected = primary ? primary.error : new Error('the guarded body did not fail with the deliberate sentinel')
    if (failures.length) throw new AggregateError([unexpected, ...failures.map(failure => new Error(failure))], `${String(unexpected)} | finalization/witness also failed: ${failures.join(' | ')}`)
    throw unexpected
  }
  expect(failures).toEqual([])
})
