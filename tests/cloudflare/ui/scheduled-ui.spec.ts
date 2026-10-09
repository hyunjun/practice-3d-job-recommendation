import { expect } from '@playwright/test'
import type { ConsoleMessage, Page, Response as PageResponse, Route, TestInfo } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import type { CatalogPublicationCapture } from '../../../server/catalog-service'
import type { SavedJob } from '../../../shared/types'
import { expectGlobeScreen, expectNoGlobeInput, globeIdle } from '../../e2e/helpers/globe-first-frame'
import { resourceCheckedTest as test } from '../../e2e/helpers/public-app'
import { readSaved, waitForSavedCommit } from '../../e2e/helpers/saved-store'
import { GENERATION_LETTERS, GENERATION_THREE, GENERATION_TWO } from '../../fixtures/publication'
import { authorized, freezeClock, rawRequest } from '../helpers/worker-http'
import {
  observeApi, publishUi, resetScheduledWorld, UI_CHANGED_INPUT, UI_CHANGED_JOBS, UI_COMPANIES, UI_INPUT, UI_JOBS, UI_LONDON_JOB, UI_LONDON_TITLE,
  UI_LONDON_TITLE_CHANGED, UI_RUN, uiCapture,
} from './helpers/ui-fixture'
import type { ApiObservation } from './helpers/ui-fixture'

/**
 * Stage82 common design v2 §검증 5: on the local Workers server (127.0.0.1:8790)
 * with the built scheduled assets, check the first globe at 1440/320, search,
 * filter, city, compare (two rendered columns), save, body-content confirmation
 * with a fixed saved-versus-published difference, observations with a visibly
 * changed later publication and old history removed on 410, transient 503 and
 * mismatched-generation notices that keep the read history until the real retry
 * recovers, backup export and restore after a local change, Korean PDF import,
 * accessibility, static assets
 * and console errors, plus the truthful scheduled wording and reload behaviour
 * (§HTTP와 UI). Every interactive journey runs at both widths (AUI82-4).
 * Expected strings are the product's user-visible text as the design and the
 * default suite state them; nothing is derived from product functions at test
 * time.
 */
const worktree = fileURLToPath(new URL('../../..', import.meta.url))
const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']
const SECURITY = {
  'x-content-type-options': 'nosniff', 'referrer-policy': 'strict-origin-when-cross-origin',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()', 'x-frame-options': 'DENY',
} as const
const CATALOG_ROUTE = '**/api/catalog?source=public'
/**
 * Literal facts of the actual collected publications (UI remedy candidate 01 §1): every authored board is
 * admitted ok and fresh with its authored posting count, the initial input keeps its one unmapped Oxford
 * posting and the changed input has none, and the admitted postings cover the 22 authored cities. The
 * collector is the only product call; no expected value here comes from product matching, schema or
 * collector functions, and only the observed distinct city count is computed from the capture itself.
 */
const UI_COLLECTED = {
  initial: { jobs: UI_INPUT.jobs, unmapped: 1, boards: { 'fixture-aster-transit': 24, 'fixture-cedar-loom': 3, 'fixture-mosaic-clinic': 2 } },
  changed: { jobs: UI_CHANGED_INPUT.jobs, unmapped: 0, boards: { 'fixture-aster-transit': 23, 'fixture-cedar-loom': 3, 'fixture-mosaic-clinic': 2 } },
} as const
function expectCollectedPublication(collected: CatalogPublicationCapture, expected: (typeof UI_COLLECTED)[keyof typeof UI_COLLECTED]) {
  const catalog = collected.catalog
  expect(catalog.jobs, 'admitted postings of the collected publication').toHaveLength(expected.jobs)
  expect(catalog.unmappedCount, 'unmapped postings declared by the collected boards').toBe(expected.unmapped)
  expect(new Set(catalog.jobs.flatMap(job => job.cityIds)).size, 'distinct mapped cities among the admitted postings').toBe(UI_INPUT.cities)
  expect(Object.fromEntries(catalog.boards.map(board => [board.companyId, { status: board.status, dataStatus: board.dataStatus, total: board.total, included: board.included }])))
    .toEqual(Object.fromEntries(Object.entries(expected.boards).map(([companyId, count]) => [companyId, { status: 'ok', dataStatus: 'fresh', total: count, included: count }])))
}
let capture: CatalogPublicationCapture
let changedCapture: CatalogPublicationCapture
test.beforeAll(async () => {
  // Static witness of the authored input (AUI82-7): three employers, 29 postings, 22 cities; the changed input keeps the employers.
  expect(UI_JOBS).toHaveLength(UI_INPUT.jobs)
  expect(new Set(UI_JOBS.map(job => job.companyId)).size).toBe(UI_INPUT.employers)
  expect(UI_COMPANIES.every(company => UI_JOBS.some(job => job.companyId === company.id))).toBe(true)
  expect(new Set(UI_JOBS.flatMap(job => job.cityIds)).size).toBe(UI_INPUT.cities)
  expect(UI_CHANGED_JOBS).toHaveLength(UI_CHANGED_INPUT.jobs)
  expect(new Set(UI_CHANGED_JOBS.map(job => job.companyId)).size).toBe(UI_CHANGED_INPUT.employers)
  expect(new Set(UI_CHANGED_JOBS.flatMap(job => job.cityIds)).size).toBe(UI_CHANGED_INPUT.cities)
  expect(UI_CHANGED_JOBS.some(job => job.title === UI_LONDON_TITLE_CHANGED && job.id === UI_LONDON_JOB.id)).toBe(true)
  capture = await uiCapture()
  changedCapture = await uiCapture(UI_RUN, undefined, UI_CHANGED_JOBS)
  // The actual collected publications are checked before any browser journey relies on them (UI remedy candidate 01 §1).
  expectCollectedPublication(capture, UI_COLLECTED.initial)
  expectCollectedPublication(changedCapture, UI_COLLECTED.changed)
})

/** Console/page errors; `allow` matches intentional, precisely described errors which are collected separately. */
function watchConsole(page: Page, allow: ((message: ConsoleMessage) => boolean)[] = []) {
  const errors: string[] = []
  const allowed: string[] = []
  page.on('pageerror', error => errors.push(`pageerror: ${error.message}`))
  page.on('console', message => {
    if (message.type() !== 'error') return
    const text = `console: ${message.text()} @ ${message.location().url}`
    if (allow.some(predicate => predicate(message))) allowed.push(text)
    else errors.push(text)
  })
  return { errors, allowed }
}
async function installInputWitness(page: Page) {
  await page.addInitScript(() => {
    window.__orbitFirstFrameInputs = []
    for (const type of ['pointerdown', 'pointermove', 'wheel', 'keydown', 'click']) {
      document.addEventListener(type, event => {
        const target = event.target
        if (event.isTrusted && target instanceof Element && target.closest('.earth-canvas, .flat-map, .map-control-stack, .region-tabs')) {
          window.__orbitFirstFrameInputs.push({ type, target: target.closest('button')?.getAttribute('aria-label') ?? target.className.toString(), at: performance.now() })
        }
      }, { capture: true, passive: true })
    }
  })
}
async function expectAccessible(page: Page) {
  expect((await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze()).violations).toEqual([])
}
async function seedSaved(page: Page, records: SavedJob[]) {
  await page.addInitScript(records => {
    if (sessionStorage.getItem('scheduled-ui-seeded')) return
    localStorage.setItem('orbit.v1.saved', JSON.stringify(records))
    localStorage.setItem('orbit.v1.exploration', JSON.stringify({ source: 'public', mapMode: 'flat' }))
    sessionStorage.setItem('scheduled-ui-seeded', 'true')
  }, records)
}
const londonRecord: SavedJob = {
  job: { ...UI_LONDON_JOB, fetchedAt: UI_RUN }, company: UI_COMPANIES[0], savedAt: '2026-10-02T08:00:00.000Z', status: 'saved', note: 'Private scheduled-build note 🌱',
}
const nav = (page: Page) => page.getByRole('navigation', { name: '주요 메뉴' })
async function openData(page: Page) {
  await page.getByRole('button', { name: '데이터와 추천 방식', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  return dialog
}
async function attachJson(info: TestInfo, name: string, value: unknown) {
  await info.attach(name, { body: Buffer.from(JSON.stringify(value, null, 2)), contentType: 'application/json' })
}
/**
 * Transport disposition of one observed API request (observation disposal design 03 §request lifecycle): `finished` is the raw
 * requestfinished evidence with no failure, `aborted` is no finish with exactly net::ERR_ABORTED, `pending` is neither yet, and
 * any other combination (a finish next to a failure, or a different failure text) is named as such and can never pass.
 */
function disposition(record: ApiObservation): string {
  if (record.finished && record.failure === null) return 'finished'
  if (!record.finished && record.failure === null) return 'pending'
  if (!record.finished && record.failure === 'net::ERR_ABORTED') return 'aborted'
  return record.finished ? `contradictory(finished with failure ${record.failure})` : `failed(${record.failure})`
}
/**
 * Every observed API record that breaks the audited contract, named with its index and reasons. GET and a null request body are
 * required of every record, including the deliberately rejected ones. A record accepted as data must be `finished`; only a record
 * the case has bound in `allowed` (the exact received 410/503/wrong-generation object, never a URL or a status) may instead be
 * `aborted` by the product's own disposal. Pending, contradictory and otherwise failed dispositions always violate.
 */
function apiViolations(api: ApiObservation[], allowed: ApiObservation[] = []) {
  const violations: { index: number; reasons: string[]; record: ApiObservation }[] = []
  api.forEach((record, index) => {
    const reasons: string[] = []
    if (record.method !== 'GET') reasons.push(`method ${record.method}`)
    if (record.body !== null) reasons.push('request body present')
    const shape = disposition(record)
    const permitted = allowed.includes(record) ? ['finished', 'aborted'] : ['finished']
    if (!permitted.includes(shape)) reasons.push(`disposition ${shape} (permitted: ${permitted.join(' or ')})`)
    if (reasons.length) violations.push({ index, reasons, record })
  })
  return violations
}
/**
 * The complete API audit of a case under ONE bounded existing expect budget: first every record must have left `pending`
 * (finished or failed), then no record may violate the contract. Offending records are reported by name, never as a boolean.
 */
async function expectCleanApi(api: ApiObservation[], allowed: ApiObservation[] = []) {
  await expect.poll(() => api.filter(record => disposition(record) === 'pending').map(record => `#${api.indexOf(record)} ${record.method} ${record.path}`), {
    message: 'every API request must reach a terminal disposition',
  }).toEqual([])
  expect(apiViolations(api, allowed)).toEqual([])
}
/** An accepted-data API record: a finished GET with no request body and no failure, carrying the given generation header. */
const acceptedGet = (path: string, generation: string): ApiObservation => ({ method: 'GET', path, status: 200, generation, body: null, failure: null, finished: true })
/** A case's API records registered as evidence from the start of observation, with the exact records bound as deliberately rejected and the terminal dispositions seen for them. */
interface ApiEvidence { name: string; api: ApiObservation[]; allowed: ApiObservation[]; terminal: { label: string; index: number; disposition: string }[]; extra: () => Record<string, unknown> }
const apiEvidence = new Map<string, ApiEvidence[]>()
/**
 * Registers a case's API records as evidence the moment observation begins (observation disposal design 03 §evidence on failure);
 * the afterEach below attaches them whether the case passed or failed, so the records a failing audit judged are never lost.
 */
function registerApiEvidence(info: TestInfo, name: string, api: ApiObservation[], extra: () => Record<string, unknown> = () => ({})): ApiEvidence {
  const entry: ApiEvidence = { name, api, allowed: [], terminal: [], extra }
  apiEvidence.set(info.testId, [...(apiEvidence.get(info.testId) ?? []), entry])
  return entry
}
test.afterEach(async ({}, info) => {
  const entries = apiEvidence.get(info.testId) ?? []
  // Per-case state is cleared first, so a failing attachment can never leak records into another case.
  apiEvidence.delete(info.testId)
  const failures: string[] = []
  for (const entry of entries) {
    // Every registered attachment is attempted independently; an earlier failure never stops a later attempt.
    try {
      await attachJson(info, entry.name, {
        api: entry.api,
        allowed: entry.allowed.map(record => ({ index: entry.api.indexOf(record), disposition: disposition(record) })),
        terminal: entry.terminal,
        violations: apiViolations(entry.api, entry.allowed),
        ...entry.extra(),
      })
    } catch (error) {
      failures.push(`${entry.name}: ${String(error)}`)
    }
  }
  // Reported in addition to the case's own error, never instead of it: the runner keeps the test error and adds this hook error.
  if (failures.length) throw new Error(`API evidence attachment failed: ${failures.join('; ')}`)
})
/**
 * A deliberately rejected record is bound as the exact object (never a URL or a status) whose disposal may differ from a success,
 * and must be terminal BEFORE the next user action, route removal or other cleanup could dispose of it incidentally (observation
 * disposal design 03): `finished` with no failure, or `aborted` with exactly net::ERR_ABORTED by the product's own disposal. The
 * disposition actually seen is recorded in the case's evidence; a finished/null outcome is valid disposal, not proof of cancellation.
 */
async function expectRejectedTerminal(evidence: ApiEvidence, record: ApiObservation, label: string): Promise<string> {
  if (!evidence.allowed.includes(record)) evidence.allowed.push(record)
  await expect.poll(() => disposition(record), { message: `${label} must reach a terminal disposition before the next action` }).not.toBe('pending')
  const shape = disposition(record)
  evidence.terminal.push({ label, index: evidence.api.indexOf(record), disposition: shape })
  expect(['finished', 'aborted'], `${label} disposition`).toContain(shape)
  return shape
}
const JOIN_MS = 15_000
/** True when `work` settles before `ms` elapse, false otherwise; the losing timer is cancelled either way, so no orphan timeout outlives the race. */
async function settlesWithin(work: Promise<unknown>, ms: number): Promise<boolean> {
  const timer = new AbortController()
  const outcome = await Promise.race([
    work.then(() => true, () => true),
    delay(ms, false, { signal: timer.signal }).catch(() => false),
  ])
  timer.abort()
  return outcome
}
/**
 * A held catalog route owned from installation (AUI82-3/MUI82-2, MUR82-1,
 * ASUI82-R1/R2, UI remedy candidate 01 §2, timeout-accounting addendum 01):
 * every handler the route admits and every navigation the test hands to `own()`
 * is recorded with its label from creation, and its settled outcome is retained
 * the moment it settles, so a later timeout of another entry can never lose it.
 * `finish()` runs unconditionally and in this order: release the gate; drain the
 * admitted handler continuations (including any admitted while draining) BEFORE
 * the interceptor is removed, because the pinned Playwright auto-continues an
 * in-flight route whose last handler is removed and the owned `route.continue()`
 * would then be rejected as already handled; attempt the real matching unroute
 * even when that drain expired, retaining a removal error; then account for every
 * retained entry (navigations and late handlers) within what remains of ONE shared
 * `JOIN_MS` deadline. A join that finds the deadline exhausted while entries are
 * still pending expires at once (no zero-delay grace), and every expiry is latched
 * with its phase and the labels pending at that boundary, so work that settles
 * later during cleanup cannot erase an observed timeout. Every known rejection is
 * reported exactly once, latched expiries are always reported, and labels still
 * pending at the end are reported separately; nothing is suppressed. The
 * continuation and unroute seams exist for the controlled witnesses only; sections
 * use the real `route.continue()` and `page.unroute(CATALOG_ROUTE, handler)`.
 */
type RouteHandler = (route: Route) => Promise<void>
interface Retained { label: string; promise: Promise<unknown>; outcome: 'pending' | 'fulfilled' | { rejected: string } }
function holdCatalog(page: Page, options: { continuation?: RouteHandler; unroute?: (installed: RouteHandler) => Promise<void> } = {}) {
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const continuation = options.continuation ?? (route => route.continue())
  const unroute = options.unroute ?? (installed => page.unroute(CATALOG_ROUTE, installed))
  const history: Retained[] = []
  let entered = 0
  let navigations = 0
  const retain = (label: string, promise: Promise<unknown>) => {
    const entry: Retained = { label, promise, outcome: 'pending' }
    history.push(entry)
    // The outcome is captured from creation; joins only wait for it and never re-read the promise.
    void promise.then(() => { entry.outcome = 'fulfilled' }, (reason: unknown) => { entry.outcome = { rejected: String(reason) } })
  }
  const handler = async (route: Route) => {
    entered++
    const work = (async () => { await gate; await continuation(route) })()
    retain(`handler #${entered}`, work)
    // The outcome is accounted for by finish(); it is not rethrown into Playwright's route dispatch.
    await work.catch(() => undefined)
  }
  const pending = (only: (entry: Retained) => boolean = () => true) => history.filter(entry => entry.outcome === 'pending' && only(entry))
  const isHandler = (entry: Retained) => entry.label.startsWith('handler #')
  return {
    install: () => page.route(CATALOG_ROUTE, handler),
    entered: () => entered,
    /** Retain a navigation (or any promise) so finalization joins it and reports its rejection rather than ignoring it. */
    own<T>(promise: Promise<T>): Promise<T> {
      retain(`navigation #${++navigations}`, promise)
      return promise
    },
    async finish(): Promise<string[]> {
      const errors: string[] = []
      const deadline = Date.now() + JOIN_MS
      /** Latched at the boundary where a join found the shared deadline exhausted: the phase and the labels pending right then. Later settlement never erases an entry here. */
      const expiries: { phase: string; labels: string[] }[] = []
      /**
       * Wait for these entries within what remains of the shared deadline. No time left with entries pending expires at once;
       * no zero-delay timer is ever started. Returns false once this phase has expired, after latching the expiry.
       */
      const settleWithin = async (phase: string, entries: Retained[]): Promise<boolean> => {
        if (!entries.length) return true
        const remaining = deadline - Date.now()
        const settled = remaining > 0 && await settlesWithin(Promise.allSettled(entries.map(entry => entry.promise)), remaining)
        if (!settled) {
          // The entries had not all settled when the deadline was found exhausted; name those still pending at this boundary
          // (all of them if their settlement reactions ran in the same tick as the losing race).
          const labels = entries.filter(entry => entry.outcome === 'pending').map(entry => entry.label)
          expiries.push({ phase, labels: labels.length ? labels : entries.map(entry => entry.label) })
        }
        return settled
      }
      release()
      // Drain the handler continuations the route admitted, including any admitted while draining, before the interceptor goes away.
      let drained = true
      while (drained && pending(isHandler).length) drained = await settleWithin('handler drain before unroute', pending(isHandler))
      // The matching unroute is attempted regardless of the drain's outcome; a removal failure is retained, never thrown away.
      try { await unroute(handler) } catch (error) { errors.push(`unroute: ${String(error)}`) }
      // Final accounting of everything retained: navigations, late handlers and anything admitted during finalization.
      let joined = true
      while (joined && pending().length) joined = await settleWithin('final accounting', pending())
      for (const expiry of expiries) errors.push(`${expiry.phase} expired after ${JOIN_MS} ms with ${expiry.labels.join(', ')} pending`)
      for (const entry of history) if (typeof entry.outcome === 'object') errors.push(`${entry.label} rejected: ${entry.outcome.rejected}`)
      const unsettled = pending().map(entry => entry.label)
      if (unsettled.length) errors.push(`still pending after finalization: ${unsettled.join(', ')}`)
      return errors
    },
  }
}
/** Run a section against a held route: installation, body, release, handler drain, matching unroute and the bounded final accounting share one boundary and one deadline, and the primary failure and every cleanup failure are preserved together. */
async function withHeldCatalog(page: Page, body: (held: ReturnType<typeof holdCatalog>) => Promise<void>, options: Parameters<typeof holdCatalog>[1] = {}): Promise<void> {
  const held = holdCatalog(page, options)
  let failure: { error: unknown } | null = null
  try {
    await held.install()
    await body(held)
  } catch (error) {
    failure = { error }
  }
  const cleanup = await held.finish()
  if (failure && cleanup.length) throw new AggregateError([failure.error, ...cleanup.map(message => new Error(message))], 'The held-route section failed and its cleanup also failed')
  if (failure) throw failure.error
  expect(cleanup).toEqual([])
}
/**
 * A scripted observations route owned from installation (observation disposal design 03 §new combined sibling journey), under the
 * same ownership discipline as the held catalog route above, which is unchanged: each admitted request is answered by the next
 * scripted reply, every reply promise is retained with its outcome from admission, and an admission beyond the script is reported
 * and refused with `route.abort()` rather than silently passed to the Worker while the route is installed. `finish()` drains the
 * retained replies (including any admitted while draining) within ONE shared `JOIN_MS` deadline, latching an expiry with the labels
 * pending at that boundary, performs the matching unroute of exactly this matcher and handler even when the drain expired, then
 * reports every latched expiry, every rejection, every excess admission and anything still pending; nothing is suppressed.
 */
function scriptObservations(page: Page, matcher: (url: URL) => boolean, replies: RouteHandler[]) {
  const history: Retained[] = []
  const excess: string[] = []
  let admitted = 0
  const handler = async (route: Route) => {
    const index = admitted++
    const reply = replies[index]
    const work = (async () => {
      if (reply) {
        await reply(route)
        return
      }
      excess.push(`admission #${index + 1} exceeded the ${replies.length} scripted replies: ${route.request().method()} ${route.request().url()}`)
      await route.abort('failed')
    })()
    const entry: Retained = { label: `reply #${index + 1}`, promise: work, outcome: 'pending' }
    history.push(entry)
    void work.then(() => { entry.outcome = 'fulfilled' }, (reason: unknown) => { entry.outcome = { rejected: String(reason) } })
    // The outcome is accounted for by finish(); it is not rethrown into Playwright's route dispatch.
    await work.catch(() => undefined)
  }
  const pending = () => history.filter(entry => entry.outcome === 'pending')
  return {
    install: () => page.route(matcher, handler),
    admitted: () => admitted,
    async finish(): Promise<string[]> {
      const errors: string[] = []
      const deadline = Date.now() + JOIN_MS
      // Drain every admitted reply before the interceptor goes away; an exhausted deadline with replies pending expires at once and is latched.
      let drained = true
      while (drained && pending().length) {
        const waiting = pending()
        const remaining = deadline - Date.now()
        drained = remaining > 0 && await settlesWithin(Promise.allSettled(waiting.map(entry => entry.promise)), remaining)
        if (!drained) {
          const labels = waiting.filter(entry => entry.outcome === 'pending').map(entry => entry.label)
          errors.push(`reply drain before unroute expired after ${JOIN_MS} ms with ${(labels.length ? labels : waiting.map(entry => entry.label)).join(', ')} pending`)
        }
      }
      // The matching unroute is attempted regardless of the drain's outcome; a removal failure is retained, never thrown away.
      try { await page.unroute(matcher, handler) } catch (error) { errors.push(`unroute: ${String(error)}`) }
      errors.push(...excess)
      for (const entry of history) if (typeof entry.outcome === 'object') errors.push(`${entry.label} rejected: ${entry.outcome.rejected}`)
      const unsettled = pending().map(entry => entry.label)
      if (unsettled.length) errors.push(`still pending after finalization: ${unsettled.join(', ')}`)
      return errors
    },
  }
}
/** Run a section against a scripted route: installation, body, reply drain, matching unroute and reporting share one boundary and one deadline, and the primary failure and every cleanup failure are preserved together. */
async function withScriptedObservations(page: Page, matcher: (url: URL) => boolean, replies: RouteHandler[], body: (scripted: ReturnType<typeof scriptObservations>) => Promise<void>): Promise<void> {
  const scripted = scriptObservations(page, matcher, replies)
  let failure: { error: unknown } | null = null
  try {
    await scripted.install()
    await body(scripted)
  } catch (error) {
    failure = { error }
  }
  const cleanup = await scripted.finish()
  if (failure && cleanup.length) throw new AggregateError([failure.error, ...cleanup.map(message => new Error(message))], 'The scripted observations section failed and its cleanup also failed')
  if (failure) throw failure.error
  expect(cleanup).toEqual([])
}
/**
 * Owns a response waiter from creation through the actions that provoke it (implementation correction 01 §1). The waiter's
 * fulfilment or rejection is retained the moment it settles, and the provoking actions run inside the same guard. When one of
 * them fails first, the observer wait is cancelled through the pinned `waitForResponse` AbortSignal, which cancels the waiting
 * and never the browser's request, and is joined within the existing JOIN_MS bound. The settled outcome is inspected only AFTER
 * that join (MOBS82-I3): a pending outcome at the moment of failure is timing, not cause, so a rejection is excluded only when it
 * demonstrably is the owned cancellation, which the pinned client reports as an AbortError whose `cause` is the exact reason
 * handed to abort(); every other rejection, including one that surfaced during the join, is preserved with the primary failure
 * in one AggregateError. A waiter failure after the actions succeeded is itself the primary and is rethrown unchanged. Nothing is
 * left pending for page teardown and nothing is swallowed.
 */
async function acquireResponse(page: Page, matches: (response: PageResponse) => boolean, provoke: () => Promise<void>): Promise<PageResponse> {
  const observer = new AbortController()
  // The private reason handed to abort(): only a rejection carrying this exact object as its cause is the owned cancellation.
  const cancellation = new Error('owned observer cancellation after the guarded actions failed')
  const waiter = page.waitForResponse(matches, { signal: observer.signal })
  const retained: Retained = { label: 'response waiter', promise: waiter, outcome: 'pending' }
  let rejection: unknown
  // The outcome and the raw rejection are captured from creation; the cleanup below reads them only after joining the promise under the shared bound.
  void waiter.then(() => { retained.outcome = 'fulfilled' }, (reason: unknown) => { rejection = reason; retained.outcome = { rejected: String(reason) } })
  const outcome = () => retained.outcome
  let provoked = false
  try {
    await provoke()
    provoked = true
    return await waiter
  } catch (error) {
    if (provoked) throw error
    const cleanup: string[] = []
    if (outcome() === 'pending') {
      // Cancel only this observer's wait and join its settlement within the shared bound; the page's request is untouched.
      observer.abort(cancellation)
      if (!(await settlesWithin(waiter, JOIN_MS))) cleanup.push(`the response waiter did not settle within ${JOIN_MS} ms after its observer was cancelled`)
    }
    // Inspected after the join: the owned cancellation is excluded by the identity of its cause; any other rejection is retained verbatim.
    const settled = outcome()
    const ownedCancellation = rejection instanceof Error && rejection.name === 'AbortError' && rejection.cause === cancellation
    if (typeof settled === 'object' && !ownedCancellation) cleanup.push(`the response waiter rejected with a cause other than the owned cancellation: ${settled.rejected}`)
    if (cleanup.length) throw new AggregateError([error, ...cleanup.map(message => new Error(message))], 'The guarded actions failed and the response waiter also failed')
    throw error
  }
}

for (const width of [1440, 320]) test.describe(`scheduled build at ${width}px`, () => {
  test.use({ viewport: { width, height: 960 }, isMobile: width === 320, hasTouch: width === 320 })

  test('paints the first globe without input from the real Worker publication and keeps every static asset path healthy', async ({ page, baseURL }, info) => {
    const origin = baseURL!
    await resetScheduledWorld(origin, page)
    const { head } = await publishUi(origin, capture, GENERATION_LETTERS)
    const monitor = watchConsole(page)
    const api = observeApi(page)
    registerApiEvidence(info, `api-requests-${width}`, api)
    await installInputWitness(page)
    await page.goto('/', { waitUntil: 'domcontentloaded' })
    await expect(page.getByRole('button', { name: '3D 지구', exact: true })).toHaveAttribute('aria-pressed', 'true')
    await expectGlobeScreen(page, info, `first-screen-${width}`)
    await expectNoGlobeInput(page)
    await expect(page.locator('.city-row')).toHaveCount(UI_INPUT.cities)
    await expect(page.locator('.map-stats strong')).toHaveText([`${UI_INPUT.employers}곳`, `${UI_INPUT.cities}곳`])
    await globeIdle(page)
    await expectGlobeScreen(page, info, `textured-idle-${width}`, { textured: true })
    await expectNoGlobeInput(page)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    // The catalog came from the Worker publication, as one finished GET with the published generation; every API request is a clean, finished GET.
    await expectCleanApi(api)
    expect(api.filter(entry => entry.path.startsWith('/api/catalog'))).toEqual([acceptedGet('/api/catalog?source=public', head.generation)])
    expect(api.some(entry => entry.path.startsWith('/api/catalog/progress'))).toBe(false)
    await expectAccessible(page)
    expect(monitor.errors).toEqual([])
  })

  test('search, filter reset, city selection, a two-city comparison view and save work against the scheduled publication with only GET requests', async ({ page, baseURL }, info) => {
    const origin = baseURL!
    await resetScheduledWorld(origin, page)
    await publishUi(origin, capture, GENERATION_LETTERS)
    const monitor = watchConsole(page)
    const api = observeApi(page)
    registerApiEvidence(info, `api-requests-journey-${width}`, api)
    await page.goto('/')
    await expect(page.locator('.earth-canvas')).toHaveClass(/is-ready/)
    await expect(page.locator('.city-row')).toHaveCount(UI_INPUT.cities)
    const londonRow = page.getByRole('button', { name: /^런던, 추천 회사 \d+곳 보기$/ })
    const londonCount = /추천 회사 (\d+)곳/.exec((await londonRow.getAttribute('aria-label')) ?? (await londonRow.textContent()) ?? '')?.[1]
    expect(londonCount, 'the London row states its recommended company count').toBeDefined()
    await londonRow.click()
    await expect(page.locator('.city-hero-caption h2')).toContainText('런던')
    await expect(page.locator('.company-card h3').filter({ hasText: 'Aster Transit' })).toHaveCount(1)
    await page.getByRole('button', { name: '모든 도시', exact: true }).click()
    await page.getByRole('button', { name: '유럽', exact: true }).click()
    await expect(page.locator('.city-row')).toHaveCount(9)
    await page.getByLabel('도시, 회사 또는 포지션 검색').fill('존재하지않는회사')
    await expect(page.getByRole('heading', { name: '조건에 맞는 도시가 아직 없어요' })).toBeVisible()
    await page.locator('.active-filter-summary').getByRole('button', { name: '초기화', exact: true }).click()
    await expect(page.locator('.city-row')).toHaveCount(UI_INPUT.cities)
    // Two cities in the comparison view (AUI82-1): both columns render with their own data, the third slot stays empty.
    await page.getByRole('button', { name: '런던 비교에 추가', exact: true }).click()
    await expect(page.getByRole('button', { name: '런던 비교에서 제거', exact: true })).toBeVisible()
    await page.getByRole('button', { name: '베를린 비교에 추가', exact: true }).click()
    await expect(page.getByRole('button', { name: '베를린 비교에서 제거', exact: true })).toBeVisible()
    await nav(page).getByRole('button', { name: /^도시 비교/ }).click()
    await expect(page.getByRole('table', { name: '도시별 채용 조건 비교' })).toBeVisible()
    await expect(page.locator('.comparison-city h2')).toHaveText(['런던', '베를린'])
    await expect(page.locator('.comparison-placeholder')).toHaveCount(1)
    const companyRow = page.getByRole('row').filter({ has: page.getByRole('rowheader').filter({ hasText: '추천 회사' }) })
    const companyCells = companyRow.getByRole('cell')
    await expect(companyCells).toHaveCount(3)
    await expect(companyCells.nth(0)).toHaveText(`${londonCount}곳`)
    await expect(companyCells.nth(1)).toHaveText(/^\d+곳$/)
    await expect(companyCells.nth(2)).toHaveText('—')
    const postingsRow = page.getByRole('row').filter({ has: page.getByRole('rowheader').filter({ hasText: '관련 채용공고' }) })
    await expect(postingsRow.getByRole('cell').nth(0)).toHaveText(/^[1-9]\d*개$/)
    await expect(postingsRow.getByRole('cell').nth(1)).toHaveText(/^[1-9]\d*개$/)
    await expect(page.getByRole('button', { name: '회사 살펴보기' })).toHaveCount(2)
    await page.getByRole('button', { name: '베를린 비교에서 제거', exact: true }).click()
    await expect(page.locator('.comparison-city h2')).toHaveText(['런던'])
    await page.getByRole('button', { name: '회사 살펴보기' }).first().click()
    await expect(page.locator('.city-hero-caption h2')).toContainText('런던')
    await page.getByRole('button', { name: UI_LONDON_TITLE, exact: true }).click()
    await page.getByRole('button', { name: '기회 저장', exact: true }).click()
    await page.getByLabel('이 기회에 대한 나의 메모').fill('다음 주 포트폴리오를 준비해서 지원하기')
    await page.getByRole('button', { name: '지원 완료로 표시', exact: true }).click()
    await page.getByRole('button', { name: '닫기', exact: true }).click()
    await nav(page).getByRole('button', { name: /저장한 기회/ }).click()
    await expect(page.locator('.saved-card')).toHaveCount(1)
    await expect(page.locator('.saved-note-preview')).toContainText('다음 주 포트폴리오')
    await waitForSavedCommit(page)
    await page.reload()
    await expect(page.locator('.saved-status')).toHaveText('지원 완료')
    expect((await readSaved(page)).map(record => record.job.id)).toEqual([UI_LONDON_JOB.id])
    await expectCleanApi(api)
    expect(api.map(entry => entry.path).every(entry => entry.startsWith('/api/catalog?source=public'))).toBe(true)
    await expectAccessible(page)
    expect(monitor.errors).toEqual([])
  })

  test('scheduled wording is truthful: loading, publication time, refresh re-reads the latest publication and never starts a collection', async ({ page, baseURL }, info) => {
    const origin = baseURL!
    await resetScheduledWorld(origin, page)
    const { head } = await publishUi(origin, capture, GENERATION_LETTERS)
    const monitor = watchConsole(page)
    const api = observeApi(page)
    registerApiEvidence(info, `api-requests-wording-${width}`, api)
    await withHeldCatalog(page, async held => {
      await held.own(page.goto('/'))
      await expect(page.getByText('저장된 공개 공고를 불러오고 있어요', { exact: true })).toBeVisible()
      await expect(page.getByText('현재 탐색 조건을 유지한 채 최근 발행된 공고 자료를 읽고 있어요.', { exact: true })).toBeVisible()
      expect(held.entered()).toBe(1)
    })
    await expect(page.locator('.city-row')).toHaveCount(UI_INPUT.cities)
    const dialog = await openData(page)
    await expect(dialog.getByRole('heading', { name: '예약 수집으로 갱신되는 공고' })).toBeVisible()
    await expect(dialog.getByText('약 30분마다 공개 자료를 수집해 발행합니다. 예약 작업은 지연되거나 건너뛸 수 있고, 출처마다 확인 간격이 다릅니다. 회사별 마지막 정상 확인 시각을 기준으로 자료의 최신 여부를 표시해요.', { exact: true })).toBeVisible()
    await expect(dialog.getByText('새로고침은 최근 발행 자료를 다시 읽습니다. 채용 사이트의 수집을 즉시 실행하지 않아요.', { exact: true })).toBeVisible()
    expect(await dialog.locator('p').filter({ hasText: '최근 발행 ·' }).locator('time').getAttribute('datetime')).toBe(head.publishedAt)
    await expect(dialog.getByRole('link', { name: '지도·이미지·폰트 출처와 고지' })).toHaveAttribute('href', '/legal/attributions.md')
    await expect(dialog.getByRole('link', { name: '번들에 포함된 오픈소스 라이선스' })).toHaveAttribute('href', '/legal/bundled-licenses.md')
    await expect(dialog.locator('.data-source-options')).toHaveCount(0)
    // Refresh re-reads the publication: one GET with refresh=1, same generation, no collection route, no write.
    const before = api.length
    await dialog.getByRole('button', { name: /^새로고침/ }).click()
    await expect.poll(() => api.slice(before).filter(entry => disposition(entry) !== 'pending').length).toBeGreaterThanOrEqual(1)
    const refresh = api.slice(before)
    expect(refresh).toEqual([acceptedGet('/api/catalog?source=public&refresh=1', head.generation)])
    expect(api.some(entry => entry.path.startsWith('/api/catalog/progress'))).toBe(false)
    expect(await dialog.locator('p').filter({ hasText: '최근 발행 ·' }).locator('time').getAttribute('datetime')).toBe(head.publishedAt)
    // A newer, visibly different publication: refresh shows the new content and the new publication time.
    await freezeClock(origin, '2026-10-03T06:35:00.000Z')
    const second = await publishUi(origin, await uiCapture('2026-10-03T06:30:00.000Z', capture, UI_CHANGED_JOBS), GENERATION_TWO, head)
    await page.clock.setFixedTime(new Date('2026-10-03T06:35:00.000Z'))
    const beforeSecond = api.length
    await dialog.getByRole('button', { name: /^새로고침/ }).click()
    await expect(dialog.locator('p').filter({ hasText: '최근 발행 ·' }).locator('time')).toHaveAttribute('datetime', second.head.publishedAt)
    await expect.poll(() => api.slice(beforeSecond).map(entry => disposition(entry))).toEqual(['finished'])
    expect(api.slice(beforeSecond)).toEqual([acceptedGet('/api/catalog?source=public&refresh=1', second.head.generation)])
    await page.keyboard.press('Escape')
    await expect(page.locator('.city-row')).toHaveCount(UI_CHANGED_INPUT.cities)
    await expect(page.locator('.map-stats strong')).toHaveText([`${UI_CHANGED_INPUT.employers}곳`, `${UI_CHANGED_INPUT.cities}곳`])
    await page.getByRole('button', { name: /^런던, 추천 회사 \d+곳 보기$/ }).click()
    await expect(page.getByRole('button', { name: UI_LONDON_TITLE_CHANGED, exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: UI_LONDON_TITLE, exact: true })).toHaveCount(0)
    await expectCleanApi(api)
    await expectAccessible(page)
    expect(monitor.errors).toEqual([])
  })

  test('the held loading route releases, joins its owned handler and navigation, and is removed even when the guarded section fails', async ({ page, baseURL }) => {
    const origin = baseURL!
    await resetScheduledWorld(origin, page)
    await publishUi(origin, capture, GENERATION_LETTERS)
    const deliberate = new Error('deliberate failure before the normal release')
    const secondary = new Error('synthetic continuation rejection after the real continue')
    let navigation: Promise<unknown> | undefined
    let entered = () => -1
    // Deterministic causal ordering (MUIR82-R3, UI remedy candidate 01 §2): finish() drains the owned handler before the interceptor is removed, so the
    // labelled rejection has SETTLED before the matching unroute even begins (the former release-then-unroute order let the pinned runtime auto-continue
    // the route and lose this outcome). The continuation signals its settlement from a macrotask (after the handler promise has rejected); the unroute
    // stub performs the real matching unroute and completes only after that signal. Both events are recorded in order.
    const order: string[] = []
    let rejectionSettled!: () => void
    const settled = new Promise<void>(resolve => { rejectionSettled = resolve })
    // The same ownership/aggregation path as the real sections (ASUI82-R2): installation, body, release, handler drain, matching-handler unroute and the
    // bounded final accounting. The continuation seam continues the real request and then rejects with a labelled error: a settled handler outcome that
    // must survive (ASUI82-R1).
    const outcome = await withHeldCatalog(page, async held => {
      entered = held.entered
      // The navigation is owned from creation; it is joined by finish(), never void-caught.
      navigation = held.own(page.goto('/'))
      await expect(page.getByText('저장된 공개 공고를 불러오고 있어요', { exact: true })).toBeVisible()
      await expect.poll(() => held.entered()).toBe(1)
      throw deliberate
    }, {
      continuation: async route => {
        await route.continue()
        try {
          throw secondary
        } finally {
          setTimeout(() => { order.push('rejection-settled'); rejectionSettled() }, 0)
        }
      },
      unroute: async installed => {
        await page.unroute(CATALOG_ROUTE, installed)
        // Bounded settlement signal with its losing timer cancelled (addendum 01 §5); the expectations below are unchanged.
        await settlesWithin(settled, JOIN_MS)
        order.push('unroute-complete')
      },
    }).then(() => null, error => error as unknown)
    // Exactly the deliberate primary plus the labelled continuation rejection survive; any other primary or aggregate is rethrown unchanged.
    if (!(outcome instanceof AggregateError) || outcome.errors[0] !== deliberate) throw outcome ?? new Error('the guarded section did not fail with the deliberate sentinel')
    expect(outcome.errors.slice(1).map(String)).toEqual([`Error: handler #1 rejected: ${String(secondary)}`])
    // The witnessed order: the rejection settled first, then the unroute completed, so the retained history (not a pending set) carried the outcome.
    expect(order).toEqual(['rejection-settled', 'unroute-complete'])
    expect(navigation).toBeDefined()
    await navigation
    // The owned handler settled and the route is gone: the real response arrived and later requests are not intercepted.
    await expect(page.locator('.city-row')).toHaveCount(UI_INPUT.cities)
    await page.reload()
    await expect(page.locator('.city-row')).toHaveCount(UI_INPUT.cities)
    expect(entered()).toBe(1)
  })

  test('a continuation that outlives the drain deadline is reported as a latched expiry even though it settles during the matching unroute', async ({ page, baseURL }) => {
    const origin = baseURL!
    await resetScheduledWorld(origin, page)
    await publishUi(origin, capture, GENERATION_LETTERS)
    const deliberate = new Error('deliberate failure before a continuation that outlives the drain deadline')
    let navigation: Promise<unknown> | undefined
    let entered = () => -1
    // Causal latches (timeout-accounting addendum 01): the continuation performs the real continue and then stays pending on
    // `heldContinuation` until the matching-unroute seam releases it, so the pre-unroute drain must expire at the existing JOIN_MS
    // deadline and the owned handler settles only during the unroute, exactly the branch where a lost expiry would read as clean
    // cleanup. No sleep or wall-clock tolerance decides the outcome; the inherent 15 s deadline is exercised under the unchanged
    // 120 s case timeout.
    let releaseHeld!: () => void
    const heldContinuation = new Promise<void>(resolve => { releaseHeld = resolve })
    let continuationSettled!: () => void
    const continuationSettlement = new Promise<void>(resolve => { continuationSettled = resolve })
    const order: string[] = []
    const outcome = await withHeldCatalog(page, async held => {
      entered = held.entered
      navigation = held.own(page.goto('/'))
      await expect(page.getByText('저장된 공개 공고를 불러오고 있어요', { exact: true })).toBeVisible()
      await expect.poll(() => held.entered()).toBe(1)
      throw deliberate
    }, {
      continuation: async route => {
        await route.continue()
        order.push('continued')
        try {
          await heldContinuation
        } finally {
          setTimeout(() => { order.push('continuation-settled'); continuationSettled() }, 0)
        }
      },
      unroute: async installed => {
        // The real matching removal first. Its rejection is captured as a value before the unconditional latch release, and the
        // settlement observation failure is captured independently, so neither failure can replace the other (AUIR82-TS1): the
        // seam rejects with the single failure when one occurred, or with one error whose text carries both labelled original
        // strings, because finish() records String(error) and owns neither promise. The handler never stays pending behind a
        // removal error and its settlement is causally observed, within the same bound, before this seam returns.
        const failures: string[] = []
        try {
          await page.unroute(CATALOG_ROUTE, installed)
        } catch (removal) {
          failures.push(`matching unroute rejected: ${String(removal)}`)
        }
        order.push('unrouted')
        releaseHeld()
        if (!(await settlesWithin(continuationSettlement, JOIN_MS))) {
          failures.push(`the released continuation did not settle within ${JOIN_MS} ms during the matching unroute`)
        }
        if (failures.length) throw new Error(failures.join('; '))
        order.push('unroute-complete')
      },
    }).then(() => null, error => error as unknown)
    // Exactly the deliberate primary plus the latched expiry survive; any other primary or aggregate is rethrown unchanged.
    if (!(outcome instanceof AggregateError) || outcome.errors[0] !== deliberate) throw outcome ?? new Error('the guarded section did not fail with the deliberate sentinel')
    // Literal expected report: the pre-unroute drain expired with the owned handler pending, even though that handler settled afterwards
    // and nothing remained pending at final accounting.
    expect(outcome.errors.slice(1).map(String)).toEqual(['Error: handler drain before unroute expired after 15000 ms with handler #1 pending'])
    expect(order).toEqual(['continued', 'unrouted', 'continuation-settled', 'unroute-complete'])
    expect(navigation).toBeDefined()
    await navigation
    // The real response arrived through the real continue and later requests are not intercepted.
    await expect(page.locator('.city-row')).toHaveCount(UI_INPUT.cities)
    await page.reload()
    await expect(page.locator('.city-row')).toHaveCount(UI_INPUT.cities)
    expect(entered()).toBe(1)
  })

  test('공고 내용 확인 compares the saved posting with the published body: a changed title is reported while the saved record stays unchanged', async ({ page, baseURL }, info) => {
    const origin = baseURL!
    await resetScheduledWorld(origin, page)
    const published = await publishUi(origin, changedCapture, GENERATION_LETTERS)
    const monitor = watchConsole(page)
    const api = observeApi(page)
    registerApiEvidence(info, `api-requests-content-${width}`, api)
    await seedSaved(page, [londonRecord])
    await page.goto('/#saved')
    await waitForSavedCommit(page)
    await expect(page.locator('.saved-card')).toHaveCount(1)
    await expect(page.locator('.posting-refresh small').filter({ hasText: '최근 발행된 본문과 저장 내용 비교' })).toHaveCount(1)
    await page.getByRole('button', { name: '공고 내용 확인', exact: true }).click()
    await expect(page.locator('.saved-card .posting-notice')).toHaveClass(/listed/)
    await expect(page.locator('.posting-summary')).toHaveText('게시 확인 1내용 차이 1목록에서 미확인 0확인 필요 0')
    await expect(page.locator('.saved-card .posting-changes')).toHaveText('포지션 확인 필요')
    await expect(page.locator('.saved-card .posting-current-title')).toHaveText(`현재 포지션: ${UI_LONDON_TITLE_CHANGED}`)
    await expect(page.locator('.saved-card .saved-title')).toContainText(UI_LONDON_TITLE)
    await page.getByRole('combobox', { name: '게시 상태', exact: true }).selectOption('changed')
    await expect(page.locator('.saved-card')).toHaveCount(1)
    await expectCleanApi(api)
    expect(api.filter(entry => entry.path.startsWith('/api/posting-status'))).toEqual([acceptedGet('/api/posting-status?refresh=1&content=1', published.head.generation)])
    const saved = await readSaved(page)
    expect(saved.map(record => [record.job.id, record.job.title, record.note, record.status])).toEqual([[UI_LONDON_JOB.id, UI_LONDON_TITLE, londonRecord.note, 'saved']])
    await expectAccessible(page)
    expect(monitor.errors).toEqual([])
  })

  test('observations follow the catalog generation: old history disappears on 410 and the refreshed generation shows its own distinct values', async ({ page, baseURL }, info) => {
    const origin = baseURL!
    await resetScheduledWorld(origin, page)
    const first = await publishUi(origin, capture, GENERATION_LETTERS)
    const observationsUrl = `/api/observations?generation=${first.head.generation}`
    // At most one intentional console error is tolerated: Chromium may report the deliberate 410 of the retired generation's history (asserted as zero or one below).
    const monitor = watchConsole(page, [message => /410/.test(message.text()) && message.location().url.includes(observationsUrl)])
    const api = observeApi(page)
    const evidence = registerApiEvidence(info, `api-requests-observations-${width}`, api, () => ({ intentionalConsoleErrors: monitor.allowed }))
    await page.goto('/')
    await expect(page.locator('.city-row')).toHaveCount(UI_INPUT.cities)
    const dialog = await openData(page)
    const panel = dialog.locator('details.observation-panel')
    await panel.locator('summary').click()
    await expect(panel).toHaveJSProperty('open', true)
    const dateControl = panel.getByRole('combobox', { name: '관측 날짜 (UTC)', exact: true })
    const publishedTotal = panel.locator('.observation-totals > div').filter({ hasText: '공개 목록 전체 직군' }).locator('dd')
    await expect(dateControl).toHaveValue('2026-10-03')
    await expect(publishedTotal).toHaveText(`${UI_INPUT.jobs}개`)
    const observationRequests = () => api.filter(entry => entry.path.startsWith('/api/observations'))
    await expectCleanApi(api)
    expect(observationRequests()).toEqual([acceptedGet(observationsUrl, first.head.generation)])
    // Two newer publications with visibly changed content retire the displayed generation; exactly five minutes later the sweep removes it.
    await freezeClock(origin, '2026-10-03T06:35:00.000Z')
    const second = await publishUi(origin, await uiCapture('2026-10-03T06:30:00.000Z', capture, UI_CHANGED_JOBS), GENERATION_TWO, first.head)
    await freezeClock(origin, '2026-10-03T07:05:00.000Z')
    const third = await publishUi(origin, await uiCapture('2026-10-03T07:00:00.000Z', capture, UI_CHANGED_JOBS), GENERATION_THREE, second.head)
    await freezeClock(origin, '2026-10-03T07:10:00.000Z')
    await rawRequest(origin, '/__orbit/publish/begin', { method: 'POST', headers: authorized({ 'Content-Type': 'application/json' }), body: third.built.manifestText })
    await page.clock.setFixedTime(new Date('2026-10-03T07:10:00.000Z'))
    expect((await rawRequest(origin, observationsUrl)).status).toBe(410)
    await panel.getByRole('button', { name: '관측 기록 다시 읽기', exact: true }).click()
    await expect(panel.getByRole('alert')).toContainText('이 자료 버전의 관측 기록은 더 이상 보관하지 않아요. 공고를 새로고침해 주세요.')
    // The retired history is gone from the panel: no date control, no totals, no comparison (AUI82-2/MUI82-3).
    await expect(dateControl).toHaveCount(0)
    await expect(panel.locator('.observation-totals')).toHaveCount(0)
    await expect(panel.locator('.observation-comparison')).toHaveCount(0)
    const refreshCatalog = panel.getByRole('button', { name: '공고 새로고침', exact: true })
    await expect(refreshCatalog).toBeVisible()
    // The retired response is this exact Request record, disposed of by the product at its own decision and therefore terminal BEFORE the
    // refresh (observation disposal design 03). The former pre-refresh `failure: null` timing expectation is intentionally replaced by this
    // terminal check; the visible retirement assertions above are unchanged.
    const retired = observationRequests().at(-1)!
    await expectRejectedTerminal(evidence, retired, 'the retired 410 history request')
    expect(retired).toMatchObject({ method: 'GET', path: observationsUrl, status: 410, generation: null, body: null })
    await refreshCatalog.click()
    await expect(dialog.locator('p').filter({ hasText: '최근 발행 ·' }).locator('time')).toHaveAttribute('datetime', third.head.publishedAt)
    await expect(panel.getByRole('alert')).toHaveCount(0)
    await expect(dateControl).toHaveValue('2026-10-03')
    // The refreshed generation renders its own value: 28 published postings, not the retired 29.
    await expect(publishedTotal).toHaveText(`${UI_CHANGED_INPUT.jobs}개`)
    await expect.poll(() => observationRequests().at(-1)?.generation).toBe(third.head.generation)
    expect(observationRequests().at(-1)).toMatchObject({ path: `/api/observations?generation=${third.head.generation}`, status: 200 })
    expect(api.filter(entry => entry.path.startsWith('/api/catalog')).at(-1)).toMatchObject({ path: '/api/catalog?source=public&refresh=1', status: 200, generation: third.head.generation })
    await page.keyboard.press('Escape')
    await expect(page.locator('.city-row')).toHaveCount(UI_CHANGED_INPUT.cities)
    await page.getByRole('button', { name: /^런던, 추천 회사 \d+곳 보기$/ }).click()
    await expect(page.getByRole('button', { name: UI_LONDON_TITLE_CHANGED, exact: true })).toBeVisible()
    await expectCleanApi(api, evidence.allowed)
    // Exactly the five causally ordered requests of this journey (observation disposal design 03): every accepted 200 finished without failure,
    // and the retired record is the same object identified before the refresh, with no generation header and one of its two permitted dispositions.
    expect(api).toEqual([
      acceptedGet('/api/catalog?source=public', first.head.generation),
      acceptedGet(observationsUrl, first.head.generation),
      expect.objectContaining({ method: 'GET', path: observationsUrl, status: 410, generation: null, body: null }),
      acceptedGet('/api/catalog?source=public&refresh=1', third.head.generation),
      acceptedGet(`/api/observations?generation=${third.head.generation}`, third.head.generation),
    ])
    expect(api[2]).toBe(retired)
    expect(['finished', 'aborted']).toContain(disposition(retired))
    await expectAccessible(page)
    expect(monitor.errors).toEqual([])
    // Chromium may report the deliberate 410 once; anything else, or a second report, is an unexpected error above.
    expect(monitor.allowed.length).toBeLessThanOrEqual(1)
  })

  test('transient observation errors keep the panel truthful: a 503 and a mismatched generation show the generic notice without discarding the read history, and 다시 읽기 recovers from the real publication', async ({ page, baseURL }, info) => {
    const origin = baseURL!
    await resetScheduledWorld(origin, page)
    const first = await publishUi(origin, capture, GENERATION_LETTERS)
    const observationsUrl = `/api/observations?generation=${first.head.generation}`
    const isObservations = (url: URL) => url.origin === origin && url.pathname + url.search === observationsUrl
    // At most one intentional console error is tolerated: Chromium may report the controlled 503 of this exact URL once (asserted as zero or one below).
    const monitor = watchConsole(page, [message => /503/.test(message.text()) && message.location().url.includes(observationsUrl)])
    const api = observeApi(page)
    const evidence = registerApiEvidence(info, `api-requests-transient-${width}`, api, () => ({ intentionalConsoleErrors: monitor.allowed }))
    const observationRequests = () => api.filter(entry => entry.path.startsWith('/api/observations'))
    await page.goto('/')
    await expect(page.locator('.city-row')).toHaveCount(UI_INPUT.cities)
    const dialog = await openData(page)
    const panel = dialog.locator('details.observation-panel')
    const dateControl = panel.getByRole('combobox', { name: '관측 날짜 (UTC)', exact: true })
    const publishedTotal = panel.locator('.observation-totals > div').filter({ hasText: '공개 목록 전체 직군' }).locator('dd')
    // The page's own real first history is acquired under one owned guard (implementation correction 01 §1): the summary click and the first visible
    // facts run inside it, so an early failure cancels only the observer wait and is reported together with any independent waiter failure. The body
    // lets the controlled wrong-generation reply carry valid data, so only its header can make it unusable.
    const firstHistory = await acquireResponse(page, response => isObservations(new URL(response.url())) && response.status() === 200, async () => {
      await panel.locator('summary').click()
      await expect(panel).toHaveJSProperty('open', true)
      await expect(dateControl).toHaveValue('2026-10-03')
      await expect(publishedTotal).toHaveText(`${UI_INPUT.jobs}개`)
    })
    const historyBody = await firstHistory.text()
    await expectCleanApi(api)
    expect(observationRequests()).toEqual([acceptedGet(observationsUrl, first.head.generation)])
    const retry = panel.getByRole('button', { name: '관측 기록 다시 읽기', exact: true })
    const catalogRefresh = panel.getByRole('button', { name: '공고 새로고침', exact: true })
    /**
     * Judged only after the current reply's record is terminal (implementation correction 01 §2), so these facts belong to that reply and not to an
     * earlier notice with the same wording: the retry control is enabled again, the generic notice carries its prior-history sentence, no catalog
     * refresh is offered, and the retained date and 29 postings are still shown.
     */
    const expectCurrentRejectionNotice = async () => {
      await expect(retry).toBeEnabled()
      await expect(panel.getByRole('alert')).toHaveText('관측 기록을 불러오지 못했어요. 다시 읽어 주세요. 아래는 앞서 읽은 기록입니다.')
      await expect(catalogRefresh).toHaveCount(0)
      await expect(dateControl).toHaveValue('2026-10-03')
      await expect(publishedTotal).toHaveText(`${UI_INPUT.jobs}개`)
    }
    // The Worker's literal CATALOG_UNAVAILABLE body with the retry time it computes one minute after the frozen UI_NOW; served, like every Worker error response, without a generation header.
    const unavailable = { error: '공개 채용 게시판에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요.', code: 'CATALOG_UNAVAILABLE', retryAt: '2026-10-03T06:06:00.000Z' }
    const jsonHeaders = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
    await withScriptedObservations(page, isObservations, [
      route => route.fulfill({ status: 503, headers: jsonHeaders, body: JSON.stringify(unavailable) }),
      route => route.fulfill({ status: 200, headers: { ...jsonHeaders, 'X-Orbit-Generation': GENERATION_TWO }, body: historyBody }),
    ], async scripted => {
      // Controlled 503: its exact record must be terminal and carry the literal received fields FIRST; only then is the panel judged, so the notice,
      // retained history and re-enabled retry are attributed to this reply and never sampled from an earlier state.
      await retry.click()
      await expect.poll(() => observationRequests().length).toBe(2)
      const unavailableRecord = observationRequests()[1]
      await expectRejectedTerminal(evidence, unavailableRecord, 'the controlled 503 history request')
      expect(unavailableRecord).toMatchObject({ method: 'GET', path: observationsUrl, status: 503, generation: null, body: null })
      expect(scripted.admitted()).toBe(1)
      await expectCurrentRejectionNotice()
      // Controlled 200 under the wrong generation header: the body is the valid first history and the wording repeats the 503 notice, so the header
      // alone must reject it, and the same terminal-first order is the only attribution of this notice to this reply.
      await retry.click()
      await expect.poll(() => observationRequests().length).toBe(3)
      const mismatched = observationRequests()[2]
      await expectRejectedTerminal(evidence, mismatched, 'the controlled wrong-generation 200 history request')
      expect(mismatched).toMatchObject({ method: 'GET', path: observationsUrl, status: 200, generation: GENERATION_TWO, body: null })
      expect(scripted.admitted()).toBe(2)
      await expectCurrentRejectionNotice()
    })
    // The scripted handler has been drained and removed; the real Worker answers the retry, the notice clears and the same valid history is shown again.
    await retry.click()
    await expect.poll(() => observationRequests().length).toBe(4)
    const recovered = observationRequests()[3]
    await expect.poll(() => disposition(recovered), { message: 'the real recovery history request must finish' }).toBe('finished')
    await expect(panel.getByRole('alert')).toHaveCount(0)
    await expect(dateControl).toHaveValue('2026-10-03')
    await expect(publishedTotal).toHaveText(`${UI_INPUT.jobs}개`)
    await page.keyboard.press('Escape')
    await expect(page.locator('.city-row')).toHaveCount(UI_INPUT.cities)
    await expectCleanApi(api, evidence.allowed)
    // Exactly the five causally ordered requests of this journey (observation disposal design 03): the two controlled replies are the same objects bound
    // above with their received status and header, the wrong-generation 200 was never accepted as data, and every accepted 200 finished without failure.
    expect(api).toEqual([
      acceptedGet('/api/catalog?source=public', first.head.generation),
      acceptedGet(observationsUrl, first.head.generation),
      expect.objectContaining({ method: 'GET', path: observationsUrl, status: 503, generation: null, body: null }),
      expect.objectContaining({ method: 'GET', path: observationsUrl, status: 200, generation: GENERATION_TWO, body: null }),
      acceptedGet(observationsUrl, first.head.generation),
    ])
    expect(evidence.allowed).toHaveLength(2)
    expect(api[2]).toBe(evidence.allowed[0])
    expect(api[3]).toBe(evidence.allowed[1])
    await expectAccessible(page)
    expect(monitor.errors).toEqual([])
    // Chromium may report the controlled 503 once; anything else, or a second report, is an unexpected error above.
    expect(monitor.allowed.length).toBeLessThanOrEqual(1)
  })

  test('backup exports saved records and restores them after a local change, without any API request carrying saved data', async ({ page, baseURL }, info) => {
    const origin = baseURL!
    await resetScheduledWorld(origin, page)
    await publishUi(origin, capture, GENERATION_LETTERS)
    const monitor = watchConsole(page)
    const api = observeApi(page)
    registerApiEvidence(info, `api-requests-backup-${width}`, api)
    const second: SavedJob = { ...londonRecord, job: { ...londonRecord.job, id: `${londonRecord.job.id}-second`, title: 'Backup fixture second' }, note: 'Second private note' }
    const records = [londonRecord, second]
    await seedSaved(page, records)
    await page.goto('/#saved')
    await waitForSavedCommit(page)
    await expect(page.locator('.saved-card')).toHaveCount(2)
    await page.getByRole('button', { name: '기록 백업·복원', exact: true }).click()
    await expect(page.getByRole('dialog', { name: '기록 백업과 복원', exact: true })).toBeVisible()
    const downloading = page.waitForEvent('download')
    await page.getByRole('button', { name: 'JSON 백업', exact: true }).click()
    const text = await readFile((await (await downloading).path())!, 'utf8')
    expect(JSON.parse(text).records).toEqual(records)
    await page.keyboard.press('Escape')
    // A deliberate local change: the London note is edited and committed.
    await page.locator('.saved-title').filter({ hasText: UI_LONDON_TITLE }).click()
    await page.getByLabel('이 기회에 대한 나의 메모').fill('LOCALLY CHANGED NOTE')
    await page.getByRole('button', { name: '닫기', exact: true }).click()
    await waitForSavedCommit(page)
    expect((await readSaved(page)).find(record => record.job.id === UI_LONDON_JOB.id)?.note).toBe('LOCALLY CHANGED NOTE')
    // Restore from the downloaded backup: the changed record is offered as a difference and replaced only after explicit selection.
    await page.getByRole('button', { name: '기록 백업·복원', exact: true }).click()
    await page.getByLabel('백업 또는 복구 파일', { exact: true }).setInputFiles({ name: 'scheduled-backup.json', mimeType: 'application/json', buffer: Buffer.from(text) })
    const row = page.locator('.saved-import-row').filter({ hasText: UI_LONDON_TITLE })
    await expect(row).toHaveCount(1)
    await expect(row.getByRole('checkbox')).not.toBeChecked()
    await expect(page.locator('.saved-import-row').filter({ hasText: 'Backup fixture second' }).getByRole('checkbox')).toBeDisabled()
    await row.locator('.saved-import-differences > summary').click()
    await expect(row.locator('.saved-record-comparison')).toContainText('LOCALLY CHANGED NOTE')
    await expect(row.locator('.saved-record-comparison')).toContainText(londonRecord.note)
    await row.getByRole('checkbox').check()
    await page.getByRole('button', { name: '선택한 1개 가져오기', exact: true }).click()
    await expect(page.locator('.saved-file-message')).toContainText('기존 공고 변경 1개')
    await page.keyboard.press('Escape')
    await waitForSavedCommit(page)
    await page.reload()
    await expect(page.locator('.saved-card')).toHaveCount(2)
    const restored = await readSaved(page)
    expect(restored.map(record => [record.job.id, record.note, record.status]).sort()).toEqual(records.map(record => [record.job.id, record.note, record.status]).sort())
    await expectCleanApi(api)
    expect(api.every(entry => entry.path.startsWith('/api/catalog?source=public'))).toBe(true)
    await expectAccessible(page)
    expect(monitor.errors).toEqual([])
  })

  test('Korean PDF import extracts the name and experience using the served PDF helpers', async ({ page, baseURL }, info) => {
    const origin = baseURL!
    await resetScheduledWorld(origin, page)
    await publishUi(origin, capture, GENERATION_LETTERS)
    const monitor = watchConsole(page)
    const api = observeApi(page)
    registerApiEvidence(info, `api-requests-pdf-${width}`, api)
    const assets: { path: string; status: number; type: string }[] = []
    page.on('response', response => {
      const url = new URL(response.url())
      if (url.origin === origin && !url.pathname.startsWith('/api/')) assets.push({ path: url.pathname, status: response.status(), type: response.headers()['content-type'] ?? '' })
    })
    await page.goto('/')
    await page.getByRole('button', { name: '내 프로필 편집', exact: true }).click()
    await page.getByLabel('이력서 파일 선택').setInputFiles(path.join(worktree, 'tests/fixtures/resume-ko.pdf'))
    await expect(page.getByLabel('읽어온 경력 · 필요한 부분을 수정하세요')).toHaveValue(/김민준/)
    await page.getByRole('button', { name: '경력에서 가능성 찾기', exact: true }).click()
    await expect(page.getByLabel('이름 또는 별명')).toHaveValue('김민준')
    await expect(page.getByLabel('개발 경력', { exact: true })).toHaveValue('5')
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    const pdfAssets = assets.filter(asset => /\/assets\/pdf[^/]*\.m?js$/.test(asset.path) || asset.path.startsWith('/pdf/'))
    expect(pdfAssets.length).toBeGreaterThan(0)
    for (const asset of pdfAssets) {
      expect(asset.status, asset.path).toBe(200)
      expect(asset.type, asset.path).not.toMatch(/text\/html/)
    }
    await expectCleanApi(api)
    await expectAccessible(page)
    expect(monitor.errors).toEqual([])
    await attachJson(info, `pdf-assets-${width}`, pdfAssets)
  })
})

test('static assets are served with the right MIME types, immutable hashed assets, security headers and no exposed rules file', async ({ request, baseURL }, info) => {
  const origin = baseURL!
  const dist = path.join(worktree, 'dist-cloudflare')
  const index = await readFile(path.join(dist, 'index.html'), 'utf8')
  const referenced = [...index.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map(match => match[1])
  expect(referenced.length).toBeGreaterThan(0)
  const assetFiles = await readdir(path.join(dist, 'assets'))
  // Required selections (AUI82-5): known font files and one real helper per PDF category, chosen by their intended extensions.
  const fonts = assetFiles.filter(name => name.endsWith('.woff2')).slice(0, 3).map(name => `/assets/${name}`)
  expect(fonts.length, 'the build must ship woff2 fonts').toBeGreaterThan(0)
  const workerChunks = assetFiles.filter(name => /^catalog\.worker.*\.js$/.test(name)).map(name => `/assets/${name}`)
  expect(workerChunks.length, 'the catalog worker chunk must be part of the build').toBeGreaterThanOrEqual(1)
  const pdfHelper = async (directory: string, extension: string) => {
    const file = (await readdir(path.join(dist, 'pdf', directory))).filter(name => name.endsWith(extension)).sort()[0]
    expect(file, `pdf/${directory} must contain a ${extension} helper`).toBeDefined()
    return `/pdf/${directory}/${file}`
  }
  const pdfHelpers = [await pdfHelper('cmaps', '.bcmap'), await pdfHelper('standard_fonts', '.pfb'), await pdfHelper('wasm', '.wasm')]
  // Every audited path must match exactly one expected-type rule; an extension without a rule fails.
  const expectedType: [RegExp, RegExp][] = [
    [/\.m?js$/, /^(text|application)\/javascript/], [/\.css$/, /^text\/css/], [/\.woff2$/, /^font\/woff2/],
    [/\.wasm$/, /^application\/wasm/], [/\.json$/, /^application\/json/], [/\.jpg$/, /^image\/jpeg/], [/\.svg$/, /^image\/svg\+xml/],
    [/\.md$/, /^text\/markdown/], [/\.bcmap$/, /^application\/octet-stream/], [/\.pfb$/, /^application\/(octet-stream|x-font-type1)/],
    [/\.ttf$/, /^font\/(ttf|sfnt)|^application\/x-font-ttf/], [/\.png$/, /^image\/png/], [/\.webp$/, /^image\/webp/], [/\.ico$/, /^image\/(x-icon|vnd\.microsoft\.icon)/],
  ]
  const results: { path: string; status: number; type: string; cacheControl: string }[] = []
  for (const asset of [...referenced, ...fonts, ...workerChunks, ...pdfHelpers, '/earth/day.jpg', '/earth/night.jpg', '/earth/countries-110m.json', '/orbit.svg', '/legal/attributions.md', '/legal/bundled-licenses.md']) {
    const response = await request.get(new URL(asset, origin).href, { maxRedirects: 0 })
    const type = response.headers()['content-type'] ?? ''
    results.push({ path: asset, status: response.status(), type, cacheControl: response.headers()['cache-control'] ?? '' })
    expect(response.status(), asset).toBe(200)
    expect(type, asset).not.toMatch(/text\/html/)
    const rules = expectedType.filter(([pattern]) => pattern.test(asset))
    expect(rules.length, `${asset} needs exactly one expected MIME rule`).toBe(1)
    expect(type, asset).toMatch(rules[0][1])
    for (const [name, value] of Object.entries(SECURITY)) expect(response.headers()[name], `${asset} ${name}`).toBe(value)
    if (asset.startsWith('/assets/')) expect(response.headers()['cache-control'], asset).toBe('public, max-age=31536000, immutable')
    else expect(response.headers()['cache-control'] ?? '', asset).not.toContain('immutable')
  }
  const shell = await request.get(new URL('/', origin).href)
  expect(shell.status()).toBe(200)
  expect(shell.headers()['content-type']).toMatch(/^text\/html/)
  expect(shell.headers()['cache-control'] ?? '').not.toContain('immutable')
  for (const [name, value] of Object.entries(SECURITY)) expect(shell.headers()[name], name).toBe(value)
  const deep = await request.get(new URL('/saved/anything', origin).href)
  expect(deep.status()).toBe(200)
  expect(await deep.text()).toBe(index)
  const rules = await request.get(new URL('/_headers', origin).href)
  expect(await rules.text()).not.toContain('X-Frame-Options: DENY')
  await attachJson(info, 'static-assets', results)
})
