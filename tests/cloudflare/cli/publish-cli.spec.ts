import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { chmod, rm } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { buildPublication } from '../../../server/publication-build'
import { PUBLIC_COMPANIES } from '../../../shared/companies'
import { GENERATION_PATTERN } from '../../../shared/publication'
import type { PublicationHead } from '../../../shared/publication'
import { FICTIONAL_COMMIT, GENERATION_ONE, privateFiles, publicationHarness, RUN_ONE } from '../../fixtures/publication'
import { activeRunCount, CLI_TOKEN, liveChildCount, prepareCollectorRepo, runPublishCli, startPublishCli, stopAllRuns, takeRetainedFailures, teardownDecision } from './harness'
import type { CliOutcome, CollectorRepo, PreloadEvent } from './harness'
import { startPublicationServer } from './publication-server'
import type { PublicationServer } from './publication-server'

/**
 * Stage82 publish CLI fault contracts (scripts/publish-catalog.ts), run as a real
 * subprocess against a synthetic publication origin. Provider hosts are blocked
 * in-process by tests/cloudflare/cli/provider-preload.ts, so the collector sees
 * every real board fail and no request leaves the machine. Explicitly selected by
 * tests/cloudflare/vitest.cli.config.ts; never part of `npm run check`.
 *
 * Fifteen tests contain sixteen nominal CLI launch sites (two admission tests
 * launch twice). Every launch is a registered run that afterEach stops and joins
 * before the fixture origins close; completed finalization failures are retained
 * until teardown reports them, and the fixture repository is removed in afterAll
 * only when every child is known closed and every stop joined (ACLI82-R4/R5).
 */
const LOWERCASE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const UNRELATED_PORT_URL = 'http://127.0.0.1:8787'
/** The exact argv the CLI passes to git for its two admission checks (scripts/publish-catalog.ts:27-32). */
const GIT_PREFIX = ['--no-pager', '--literal-pathspecs', '-c', 'core.fsmonitor=false']
const GIT_REV_PARSE = [...GIT_PREFIX, 'rev-parse', 'HEAD']
const GIT_STATUS = [...GIT_PREFIX, 'status', '--porcelain', '--untracked-files=all']
let repo: CollectorRepo | undefined
let server: PublicationServer | undefined
let redirectTarget: PublicationServer | undefined
const rejectedReasons = (results: PromiseSettledResult<unknown>[]) => results.filter((result): result is PromiseRejectedResult => result.status === 'rejected').map(result => String(result.reason))

beforeAll(async () => { repo = await prepareCollectorRepo() }, 120_000)
afterAll(async () => {
  const stopFailures = rejectedReasons(await stopAllRuns('suite teardown'))
  const retained = takeRetainedFailures()
  const decision = teardownDecision({ stopFailures, liveChildren: liveChildCount(), retainedFailures: retained })
  let removal: string | null = null
  if (decision.removeRepository) {
    // Every child is known closed; the fixture repository is no longer in use.
    try { await repo?.remove() } catch (error) { removal = String(error) }
  }
  expect({ reasons: decision.reasons, removal, retainedRepository: decision.removeRepository ? null : repo?.root ?? null })
    .toEqual({ reasons: [], removal: null, retainedRepository: null })
  expect(activeRunCount()).toBe(0)
})
afterEach(async () => {
  // Children first (stopped and joined through finalization), then both origins independently; every failure is kept.
  const stops = await stopAllRuns('afterEach')
  const closes = await Promise.allSettled([server?.close(), redirectTarget?.close()])
  server = undefined
  redirectTarget = undefined
  expect(rejectedReasons([...stops, ...closes])).toEqual([])
  expect(takeRetainedFailures()).toEqual([])
  expect(liveChildCount()).toBe(0)
  expect(activeRunCount()).toBe(0)
})

const fixtureRepo = () => {
  if (!repo) throw new Error('The fixture repository was not prepared')
  return repo
}
const paths = () => server!.requests.map(request => `${request.method} ${request.path}`)
const count = (route: string, method = 'POST') => server!.requests.filter(request => request.method === method && request.path === `/__orbit/publish${route}`).length

function expectWellFormedRun(outcome: CliOutcome) {
  expect(outcome.closure).toBe('exited')
  expect(outcome.spawnError).toBeNull()
  expect(outcome.childErrors).toEqual([])
  expect(outcome.signal).toBeNull()
  expect(outcome.stopRequests).toEqual([])
  expect(outcome.signals).toEqual([])
  expect(outcome.cleanupError).toBeNull()
  expect(outcome.evidenceErrors).toEqual([])
  expect(outcome.providerEvidence, 'the preload completion record is required for every normal exit').toBe('valid')
  expect(outcome.providerEvidenceError).toBeNull()
  expect(outcome.providers!.pid).toBeGreaterThan(0)
  expect(outcome.providers!.liveLogErrors).toEqual([])
}
function expectSanitized(outcome: CliOutcome, token = CLI_TOKEN) {
  const text = `${outcome.stdout}\n${outcome.stderr}`
  expect(text).not.toContain(token)
  expect(text).not.toContain('Bearer')
  expect(text).not.toContain('"fragments"')
  expect(text).not.toContain('"chunks":[')
  expect(text).not.toContain('Fictional provider outage')
  expect(outcome.report).not.toBeNull()
  const report = JSON.stringify(outcome.report)
  for (const host of ['greenhouse.io', 'lever.co', 'ashbyhq.com', 'smartrecruiters.com', 'workable.com', 'himalayas.app']) expect(report).not.toContain(host)
}
function expectCleanTemp(outcome: CliOutcome) {
  expect(outcome.leftovers).toEqual([])
  expect(outcome.unrelatedKept).toBe(true)
}
function expectNoProviderTraffic(outcome: CliOutcome) {
  expect(outcome.providerEvidence).toBe('valid')
  expect(outcome.providers!.blocked).toEqual({})
  expect(outcome.events.filter(event => event.kind === 'provider-attempt')).toEqual([])
}
/** The preload's ordered admission ledger: git argv verbatim, mkdtemp by prefix basename (other event kinds are asserted separately). */
const admissionLines = (outcome: CliOutcome) => outcome.events
  .filter(event => event.kind === 'execFileSync' || event.kind === 'mkdtemp')
  .map(event => event.kind === 'execFileSync' ? `${event.file} ${event.args.join(' ')}` : `mkdtemp ${event.prefix.split('/').at(-1)}`)
/** Admission refused before the first check: no Git call, no temp directory, no provider attempt. */
function expectNoGitAndNoTemp(outcome: CliOutcome) {
  expect(admissionLines(outcome)).toEqual([])
  expect(outcome.gitInvocations).toEqual([])
}
function expectTwoGitChecksAndNoTemp(outcome: CliOutcome) {
  expect(admissionLines(outcome)).toEqual([`git ${GIT_REV_PARSE.join(' ')}`, `git ${GIT_STATUS.join(' ')}`])
  expect(outcome.gitInvocations).toEqual([GIT_REV_PARSE.join(' '), GIT_STATUS.join(' ')])
}
/** Same-process causal order: both git checks happen before the single publication temp directory is created (ACT82-7/8, MCT82-2/3); post-exit state proves its removal. */
function expectGitThenTemp(outcome: CliOutcome) {
  expect(admissionLines(outcome)).toEqual([`git ${GIT_REV_PARSE.join(' ')}`, `git ${GIT_STATUS.join(' ')}`, 'mkdtemp orbit-publication-'])
  expect(outcome.gitInvocations).toEqual([GIT_REV_PARSE.join(' '), GIT_STATUS.join(' ')])
  expectCleanTemp(outcome)
}
const seqOf = (events: PreloadEvent[], predicate: (event: PreloadEvent) => boolean, label: string) => {
  const found = events.find(predicate)
  expect(found, label).toBeDefined()
  return found!.seq
}
/** Restore-before-recollect order (ACLI82-R2/MCLR82-2): all three checkpoint bodies reach upstream EOF (transform flush), the second head response's headers arrive, then the first provider attempt. Consumer done reads and head validation/restore work are not timed directly by these events. */
function expectRestoreThenRecollect(outcome: CliOutcome, generation: string) {
  const events = outcome.events
  const starts = events.filter(event => event.kind === 'checkpoint-start')
  expect(starts.map(event => event.kind === 'checkpoint-start' ? [event.file, event.status] : null)).toEqual([['boards', 200], ['presence', 200], ['observations', 200]])
  const completes = events.filter(event => event.kind === 'checkpoint-complete').map(event => event.kind === 'checkpoint-complete' ? event.file : null)
  expect(completes).toEqual(['boards', 'presence', 'observations'])
  const heads = events.filter(event => event.kind === 'head-response')
  expect(heads.map(event => event.kind === 'head-response' ? [event.ordinal, event.status] : null)).toEqual([[1, 200], [2, 200]])
  const attempts = events.filter(event => event.kind === 'provider-attempt')
  expect(attempts).toHaveLength(1)
  const host = attempts[0].kind === 'provider-attempt' ? attempts[0].host : ''
  expect(['127.0.0.1', 'localhost', 'job.hyunjun.workers.dev']).not.toContain(host)
  const completeObservations = seqOf(events, event => event.kind === 'checkpoint-complete' && event.file === 'observations', 'observations completion')
  const secondHead = seqOf(events, event => event.kind === 'head-response' && event.ordinal === 2, 'second head response')
  const firstAttempt = seqOf(events, event => event.kind === 'provider-attempt', 'first provider attempt')
  expect(seqOf(events, event => event.kind === 'checkpoint-complete' && event.file === 'boards', 'boards completion')).toBeLessThan(seqOf(events, event => event.kind === 'checkpoint-complete' && event.file === 'presence', 'presence completion'))
  expect(seqOf(events, event => event.kind === 'checkpoint-complete' && event.file === 'presence', 'presence completion')).toBeLessThan(completeObservations)
  expect(completeObservations).toBeLessThan(secondHead)
  expect(secondHead).toBeLessThan(firstAttempt)
  const checkpointRequests = server!.requests.filter(request => request.path.includes('/checkpoint/'))
  expect(checkpointRequests).toHaveLength(3)
  expect(checkpointRequests.every(request => request.query === `?generation=${encodeURIComponent(generation)}`)).toBe(true)
}
async function initialPublication() {
  const capture = (await publicationHarness().run()).capture
  const built = buildPublication(capture, FICTIONAL_COMMIT, null, GENERATION_ONE)
  const head: PublicationHead = { revision: 1, generation: GENERATION_ONE, publishedAt: RUN_ONE }
  return { head, manifest: built.manifest, files: privateFiles(built) }
}
/**
 * Design rule (shared/catalog-freshness.ts): daily feeds and site-specific
 * crawling reuse a successful read for a full day; every other source is fresh
 * for 30 minutes. A scheduled run applies that due policy once, so a two-hour-old
 * checkpoint makes every non-daily board due for recollection while the daily
 * boards keep their restored reads.
 */
const DAILY_PROVIDERS = ['himalayas', 'careers']
const NON_DAILY_COMPANIES = PUBLIC_COMPANIES.filter(company => !DAILY_PROVIDERS.includes(company.provider ?? 'greenhouse'))
/**
 * An existing publication for the CLI's own registry: one fictional posting per
 * registered employer, collected two hours before the test so the restored
 * snapshots are due for recollection yet still usable fallbacks under the CLI's
 * real clock (24 h horizon).
 */
async function existingPublication() {
  const runAt = new Date(Date.now() - 2 * 60 * 60_000).toISOString()
  const harness = publicationHarness({ companies: PUBLIC_COMPANIES, at: runAt })
  const capture = (await harness.run()).capture
  const built = buildPublication(capture, FICTIONAL_COMMIT, null, GENERATION_ONE)
  const head: PublicationHead = { revision: 1, generation: GENERATION_ONE, publishedAt: runAt }
  return { head, manifest: built.manifest, files: privateFiles(built), capture, runAt }
}
/** Literal expectations of a due recollection over the two-hour-old registry checkpoint. */
function expectRecollectedReport(outcome: CliOutcome, existing: Awaited<ReturnType<typeof existingPublication>>) {
  const restoredJobs = existing.capture.catalog.jobs.length
  expect(restoredJobs).toBe(PUBLIC_COMPANIES.length)
  expect(NON_DAILY_COMPANIES.length).toBeGreaterThan(0)
  expect(NON_DAILY_COMPANIES.length).toBeLessThan(PUBLIC_COMPANIES.length)
  const report = outcome.report!
  expect(report).toMatchObject({
    operation: 'collect', success: true, collectorCommit: fixtureRepo().commit, companies: PUBLIC_COMPANIES.length,
    // Every due board failed in this run, yet every restored snapshot stays usable (stale or still fresh) and its postings are republished.
    failedBoards: NON_DAILY_COMPANIES.length, usableBoards: PUBLIC_COMPANIES.length, jobs: restoredJobs,
  })
  const head = report.head as PublicationHead
  expect(head.revision).toBe(2)
  expect(head.generation).toMatch(LOWERCASE_UUID)
  expect(head.generation).not.toBe(existing.head.generation)
  const requests = paths()
  expect(requests.slice(0, 5)).toEqual([
    'GET /__orbit/publish/head', 'GET /__orbit/publish/checkpoint/boards', 'GET /__orbit/publish/checkpoint/presence',
    'GET /__orbit/publish/checkpoint/observations', 'GET /__orbit/publish/head',
  ])
  expect(count('/begin')).toBe(1)
  expect(count('/commit')).toBe(1)
  expect(count('/metrics', 'GET')).toBe(1)
  expect(requests.at(-1)).toBe('GET /__orbit/publish/metrics')
  const begin = server!.requests.find(request => request.path === '/__orbit/publish/begin')!
  expect(begin.body).toMatchObject({
    generation: head.generation, parent: { revision: existing.head.revision, generation: existing.head.generation },
    collectorCommit: fixtureRepo().commit, companies: PUBLIC_COMPANIES.length,
  })
  expect(server!.current()?.head).toEqual(head)
  expect(server!.current()?.manifest.parent).toEqual({ revision: 1, generation: existing.head.generation })
  const passes = report.providerPasses as { pass: string; provider: string; requests: number; failedRequests: number }[]
  expect(passes.length).toBeGreaterThan(0)
  expect(passes.every(pass => pass.failedRequests === pass.requests && !DAILY_PROVIDERS.includes(pass.provider))).toBe(true)
  // head, three checkpoint files, head again, begin, at least one chunk, commit, metrics.
  expect(outcome.providers!.forwarded).toBeGreaterThanOrEqual(9)
  expect(Object.values(outcome.providers!.blocked).reduce((sum, value) => sum + value, 0)).toBeGreaterThanOrEqual(NON_DAILY_COMPANIES.length)
  expectRestoreThenRecollect(outcome, existing.head.generation)
  expectGitThenTemp(outcome)
  expectSanitized(outcome)
}

describe('publish CLI admission', () => {
  it('rejects an unknown operation and extra arguments before git runs, before any temp directory exists and before any request', async () => {
    server = await startPublicationServer({ token: CLI_TOKEN })
    const unknown = await runPublishCli(fixtureRepo(), { args: ['other'], publicationUrl: server.origin })
    expectWellFormedRun(unknown)
    expect(unknown.code).toBe(1)
    expect(unknown.reportStream).toBe('stderr')
    expect(unknown.report).toMatchObject({ operation: 'invalid', success: false, published: false, code: 'COLLECTION_OR_VALIDATION_FAILED' })
    expect(unknown.report).not.toHaveProperty('head')
    expect(unknown.report).not.toHaveProperty('attempted')
    const extra = await runPublishCli(fixtureRepo(), { args: ['collect', 'extra'], publicationUrl: server.origin })
    expectWellFormedRun(extra)
    expect(extra.code).toBe(1)
    expect(extra.report).toMatchObject({ operation: 'collect', success: false, published: false, code: 'COLLECTION_OR_VALIDATION_FAILED' })
    expect(server.requests).toEqual([])
    for (const outcome of [unknown, extra]) {
      expectSanitized(outcome)
      expectCleanTemp(outcome)
      expectNoProviderTraffic(outcome)
      expectNoGitAndNoTemp(outcome)
      expect(outcome.providers!.forwarded).toBe(0)
    }
  })

  it('refuses to publish from a dirty checkout after exactly the two git checks and never reaches the origin', async () => {
    server = await startPublicationServer({ token: CLI_TOKEN })
    const clean = await fixtureRepo().dirty()
    try {
      const outcome = await runPublishCli(fixtureRepo(), { publicationUrl: server.origin })
      expectWellFormedRun(outcome)
      expect(outcome.code).toBe(1)
      expect(outcome.report).toMatchObject({ operation: 'collect', success: false, published: false, code: 'COLLECTION_OR_VALIDATION_FAILED' })
      expect(outcome.report).not.toHaveProperty('attempted')
      expect(server.requests).toEqual([])
      expectTwoGitChecksAndNoTemp(outcome)
      expectSanitized(outcome)
      expectCleanTemp(outcome)
      expectNoProviderTraffic(outcome)
    } finally {
      await clean()
    }
  })

  it('rejects a short token and an unrelated local port after the git checks, before any request or temp directory', async () => {
    server = await startPublicationServer({ token: CLI_TOKEN })
    const shortToken = await runPublishCli(fixtureRepo(), { publicationUrl: server.origin, token: 'short-fictional-token' })
    expectWellFormedRun(shortToken)
    expect(shortToken.code).toBe(1)
    expect(shortToken.report).toMatchObject({ operation: 'collect', success: false, published: false, code: 'COLLECTION_OR_VALIDATION_FAILED' })
    const wrongPort = await runPublishCli(fixtureRepo(), { publicationUrl: UNRELATED_PORT_URL, allowedOrigin: server.origin })
    expectWellFormedRun(wrongPort)
    expect(wrongPort.code).toBe(1)
    expect(wrongPort.report).toMatchObject({ operation: 'collect', success: false, published: false, code: 'COLLECTION_OR_VALIDATION_FAILED' })
    expect(server.requests).toEqual([])
    for (const outcome of [shortToken, wrongPort]) {
      expectSanitized(outcome, 'short-fictional-token')
      expectCleanTemp(outcome)
      expectNoProviderTraffic(outcome)
      expectTwoGitChecksAndNoTemp(outcome)
      expect(outcome.providers!.forwarded).toBe(0)
    }
  })

  it('never follows a redirect, so the token is not forwarded anywhere', async () => {
    redirectTarget = await startPublicationServer({ token: CLI_TOKEN })
    server = await startPublicationServer({ token: CLI_TOKEN, redirectTo: redirectTarget.origin })
    const outcome = await runPublishCli(fixtureRepo(), { publicationUrl: server.origin })
    expectWellFormedRun(outcome)
    expect(outcome.code).toBe(1)
    expect(outcome.report).toMatchObject({ operation: 'collect', success: false, published: false, code: 'HTTP_302' })
    expect(paths()).toEqual(['GET /__orbit/publish/head'])
    expect(redirectTarget.requests).toEqual([])
    expectGitThenTemp(outcome)
    expectSanitized(outcome)
    expectNoProviderTraffic(outcome)
  })
})

describe('publish CLI collect outcomes', () => {
  it('collects with every provider blocked, publishes an all-failed capture and reports the exact success shape', async () => {
    server = await startPublicationServer({ token: CLI_TOKEN })
    const outcome = await runPublishCli(fixtureRepo(), { publicationUrl: server.origin })
    expectWellFormedRun(outcome)
    expect(outcome.stderr.trim()).toBe('')
    expect(outcome.code).toBe(0)
    expect(outcome.reportStream).toBe('stdout')
    const report = outcome.report!
    expect(Object.keys(report).sort()).toEqual([
      'capturedAt', 'checkpointBytes', 'collectorCommit', 'companies', 'compressedBytes', 'elapsedMs', 'failedBoards', 'head',
      'jobs', 'manifestBytes', 'operation', 'providerPasses', 'storage', 'success', 'usableBoards',
    ])
    expect(report).toMatchObject({ operation: 'collect', success: true, collectorCommit: fixtureRepo().commit, companies: PUBLIC_COMPANIES.length, usableBoards: 0, jobs: 0, failedBoards: PUBLIC_COMPANIES.length })
    const head = report.head as PublicationHead
    expect(head.revision).toBe(1)
    expect(head.generation).toMatch(LOWERCASE_UUID)
    expect(Number.isFinite(Date.parse(head.publishedAt))).toBe(true)
    expect(Number.isFinite(Date.parse(String(report.capturedAt)))).toBe(true)
    expect(report.compressedBytes as number).toBeGreaterThan(0)
    expect(report.manifestBytes as number).toBeGreaterThan(0)
    expect(report.manifestBytes as number).toBeLessThanOrEqual(512 * 1024)
    const checkpointBytes = report.checkpointBytes as Record<string, number>
    expect(Object.keys(checkpointBytes).sort()).toEqual(['boards', 'observations', 'presence'])
    for (const size of Object.values(checkpointBytes)) expect(size).toBeGreaterThan(0)
    const passes = report.providerPasses as { pass: string; provider: string; boards: number; requests: number; failedRequests: number }[]
    expect(passes.length).toBeGreaterThan(0)
    expect(passes.every(pass => ['inventory', 'content'].includes(pass.pass) && pass.boards > 0 && pass.failedRequests === pass.requests)).toBe(true)
    expect(passes.reduce((sum, pass) => sum + pass.requests, 0)).toBeGreaterThan(0)
    expect(report.storage).toMatchObject({ generations: 1, staging: null })
    const requests = paths()
    expect(requests[0]).toBe('GET /__orbit/publish/head')
    expect(requests.filter(entry => entry.includes('/checkpoint/'))).toEqual([])
    expect(count('/begin')).toBe(1)
    expect(requests.filter(entry => entry.startsWith('PUT /__orbit/publish/chunks/')).length).toBeGreaterThanOrEqual(1)
    expect(count('/commit')).toBe(1)
    expect(count('/metrics', 'GET')).toBe(1)
    expect(requests.at(-1)).toBe('GET /__orbit/publish/metrics')
    expect(server.requests.every(request => request.authorized)).toBe(true)
    const begin = server.requests.find(request => request.path === '/__orbit/publish/begin')!
    expect(begin.body).toMatchObject({ generation: head.generation, parent: null, collectorCommit: fixtureRepo().commit, companies: PUBLIC_COMPANIES.length })
    expect(server.current()?.head).toEqual(head)
    expectGitThenTemp(outcome)
    // The first provider attempt comes after the single head response, with nothing to restore.
    expect(outcome.events.filter(event => event.kind === 'checkpoint-start' || event.kind === 'checkpoint-complete')).toEqual([])
    const firstHead = outcome.events.find(event => event.kind === 'head-response')!
    const firstAttempt = outcome.events.find(event => event.kind === 'provider-attempt')!
    expect(firstHead.seq).toBeLessThan(firstAttempt.seq)
    expect(outcome.providers!.forwarded).toBeGreaterThanOrEqual(4)
    const blockedHosts = Object.keys(outcome.providers!.blocked)
    expect(blockedHosts.length).toBeGreaterThan(0)
    expect(blockedHosts.every(host => host !== '127.0.0.1' && host !== 'localhost' && host !== 'job.hyunjun.workers.dev')).toBe(true)
    expect(Object.values(outcome.providers!.blocked).reduce((sum, value) => sum + value, 0)).toBeGreaterThanOrEqual(PUBLIC_COMPANIES.length)
    expectSanitized(outcome)
  }, 180_000)

  it('restores the current head\'s private checkpoint before recollecting, keeps the restored snapshots when every due provider fails, and publishes a child of that head', async () => {
    expect(PUBLIC_COMPANIES, 'the design\'s registry size').toHaveLength(130)
    const existing = await existingPublication()
    server = await startPublicationServer({ token: CLI_TOKEN, initial: existing })
    const outcome = await runPublishCli(fixtureRepo(), { publicationUrl: server.origin })
    expectWellFormedRun(outcome)
    expect(outcome.stderr.trim()).toBe('')
    expect(outcome.code).toBe(0)
    expectRecollectedReport(outcome, existing)
  }, 240_000)

  it('a withheld final checkpoint body delays recollection: no provider attempt is recorded until the body completes, then the same order and results hold', async () => {
    const existing = await existingPublication()
    server = await startPublicationServer({ token: CLI_TOKEN, initial: existing, holdCheckpoint: 'observations' })
    const run = await startPublishCli(fixtureRepo(), { publicationUrl: server.origin })
    try {
      await server.waitFor(request => request.method === 'GET' && request.path === '/__orbit/publish/checkpoint/observations', 120_000)
      // The client is inside the withheld body read: both earlier files completed, the third started, nothing else happened.
      await expect.poll(async () => (await run.liveEvents()).some(event => event.kind === 'checkpoint-start' && event.file === 'observations'), { timeout: 30_000, interval: 100 }).toBe(true)
      // A bounded quiet window while the body stays withheld; the positive witnesses follow the release.
      await delay(750)
      const during = await run.liveEvents()
      expect(during.filter(event => event.kind === 'checkpoint-complete').map(event => event.kind === 'checkpoint-complete' ? event.file : null)).toEqual(['boards', 'presence'])
      expect(during.filter(event => event.kind === 'provider-attempt')).toEqual([])
      expect(during.filter(event => event.kind === 'head-response')).toHaveLength(1)
      expect(count('/head', 'GET')).toBe(1)
      expect(count('/begin')).toBe(0)
      expect(server.releaseCheckpoint()).toBe(1)
    } catch (error) {
      // The witness failed: stop and join the owned child; a stop failure is reported together with the primary failure.
      try { await run.stop('held checkpoint witness failed') } catch (stopError) { throw new AggregateError([error, stopError], 'The held checkpoint witness failed and the owned child could not be stopped cleanly') }
      throw error
    }
    const outcome = await run.finished
    expectWellFormedRun(outcome)
    expect(outcome.stderr.trim()).toBe('')
    expect(outcome.code).toBe(0)
    expectRecollectedReport(outcome, existing)
  }, 240_000)

  it('reconciles a lost commit response through the head without a second begin', async () => {
    server = await startPublicationServer({ token: CLI_TOKEN, commit: 'drop-after-commit' })
    const outcome = await runPublishCli(fixtureRepo(), { publicationUrl: server.origin })
    expectWellFormedRun(outcome)
    expect(outcome.code).toBe(0)
    expect(outcome.report).toMatchObject({ operation: 'collect', success: true })
    const head = (outcome.report as { head: PublicationHead }).head
    expect(head).toEqual(server.current()?.head)
    expect(count('/begin')).toBe(1)
    expect(count('/commit')).toBe(3)
    expect(count('/head', 'GET')).toBe(2)
    expect(count('/metrics', 'GET')).toBe(1)
    expect(paths().slice(-5)).toEqual([
      'POST /__orbit/publish/commit', 'POST /__orbit/publish/commit', 'POST /__orbit/publish/commit',
      'GET /__orbit/publish/head', 'GET /__orbit/publish/metrics',
    ])
    expectSanitized(outcome)
    expectCleanTemp(outcome)
  }, 180_000)

  it('reports an unknown outcome (published: null) when a lost commit cannot be confirmed, and never resets or recollects', async () => {
    server = await startPublicationServer({ token: CLI_TOKEN, commit: 'drop-without-commit', headAfterCommit: 'none' })
    const outcome = await runPublishCli(fixtureRepo(), { publicationUrl: server.origin })
    expectWellFormedRun(outcome)
    expect(outcome.code).toBe(1)
    expect(outcome.reportStream).toBe('stderr')
    expect(outcome.report).toMatchObject({ operation: 'collect', success: false, published: null, code: 'COMMIT_UNCONFIRMED' })
    expect(outcome.report).not.toHaveProperty('head')
    const attempted = (outcome.report as { attempted: { generation: string; parent: unknown } }).attempted
    expect(attempted.generation).toMatch(LOWERCASE_UUID)
    expect(attempted.parent).toBeNull()
    expect(count('/begin')).toBe(1)
    expect(count('/commit')).toBe(3)
    expect(count('/head', 'GET')).toBe(2)
    expect(count('/metrics', 'GET')).toBe(0)
    expect(server.current()).toBeNull()
    expectSanitized(outcome)
    expectCleanTemp(outcome)
  }, 180_000)

  it('keeps published: true with the confirmed head when only the metrics request fails afterwards', async () => {
    server = await startPublicationServer({ token: CLI_TOKEN, metrics: 'storage-error' })
    const outcome = await runPublishCli(fixtureRepo(), { publicationUrl: server.origin })
    expectWellFormedRun(outcome)
    expect(outcome.code).toBe(1)
    expect(outcome.reportStream).toBe('stderr')
    expect(outcome.report).toMatchObject({ operation: 'collect', success: false, published: true, code: 'PUBLISH_STORAGE_ERROR' })
    const report = outcome.report as { head: PublicationHead; attempted: { generation: string; parent: unknown } }
    expect(report.head).toEqual(server.current()?.head)
    expect(report.attempted).toEqual({ generation: report.head.generation, parent: null })
    expect(count('/commit')).toBe(1)
    expect(count('/metrics', 'GET')).toBe(1)
    expectSanitized(outcome)
    expectCleanTemp(outcome)
  }, 180_000)

  it('turns SIGTERM during a held commit into CANCELLED with published: null and removes its temp directory', async () => {
    server = await startPublicationServer({ token: CLI_TOKEN, commit: 'hold' })
    const run = await startPublishCli(fixtureRepo(), { publicationUrl: server.origin })
    try {
      await server.waitFor(request => request.method === 'POST' && request.path === '/__orbit/publish/commit', 150_000)
    } catch (error) {
      // The witness failed: stop and join the owned child; a stop failure is reported together with the primary failure.
      try { await run.stop('commit witness failed') } catch (stopError) { throw new AggregateError([error, stopError], 'The commit witness failed and the owned child could not be stopped cleanly') }
      throw error
    }
    // The deliberate cancellation goes through the retained child handle, never a raw numeric pid.
    run.signal('SIGTERM')
    const outcome = await run.finished
    expect(outcome.closure).toBe('exited')
    expect(outcome.spawnError).toBeNull()
    expect(outcome.childErrors).toEqual([])
    expect(outcome.stopRequests).toEqual([])
    expect(outcome.signals).toEqual(['SIGTERM'])
    expect(outcome.signal).toBeNull()
    expect(outcome.code).toBe(1)
    expect(outcome.providerEvidence).toBe('valid')
    expect(outcome.evidenceErrors).toEqual([])
    expect(outcome.report).toMatchObject({ operation: 'collect', success: false, published: null, code: 'CANCELLED' })
    expect(outcome.report).not.toHaveProperty('head')
    expect((outcome.report as { attempted: { generation: string } }).attempted.generation).toMatch(LOWERCASE_UUID)
    expect(count('/commit')).toBe(1)
    expect(count('/metrics', 'GET')).toBe(0)
    expect(outcome.cleanupError).toBeNull()
    expectSanitized(outcome)
    expectCleanTemp(outcome)
    // A stop after the fact only joins the already finished run.
    await run.stop('post-exit join')
    expect(activeRunCount()).toBe(0)
    expect(liveChildCount()).toBe(0)
  }, 180_000)
})

describe('publish CLI harness ownership witnesses', () => {
  it('a real post-exit TMPDIR cleanup failure is reported by stop(), retained for teardown and kept distinct from the child\'s known closure', async () => {
    server = await startPublicationServer({ token: CLI_TOKEN })
    const run = await startPublishCli(fixtureRepo(), { args: ['other'], publicationUrl: server.origin, witness: { lockedUnrelatedEntry: true } })
    const outcome = await run.finished
    let primary: { error: unknown } | null = null
    try {
      expect(outcome.closure).toBe('exited')
      expect(outcome.code).toBe(1)
      expect(outcome.report).toMatchObject({ operation: 'invalid', success: false })
      expect(outcome.cleanupError).not.toBeNull()
      expect(outcome.leftovers).toEqual([])
      expect(outcome.unrelatedKept).toBe(true)
      await expect(run.stop('after exit')).rejects.toThrow(/exited, but its TMPDIR .* could not be removed/)
      const retained = takeRetainedFailures()
      expect(retained).toHaveLength(1)
      expect(retained[0]).toMatchObject({ pid: run.pid, closure: 'exited', cleanupError: outcome.cleanupError, evidenceErrors: [] })
      // The teardown policy keeps reporting such a failure while still allowing removal of the fixture repository (closure is known).
      expect(teardownDecision({ stopFailures: [], liveChildren: 0, retainedFailures: retained })).toEqual({
        removeRepository: true, reasons: [`run ${run.pid} (exited) left unreported failures: ${outcome.cleanupError}`],
      })
      expect(activeRunCount()).toBe(0)
      expect(liveChildCount()).toBe(0)
    } catch (error) {
      primary = { error }
    }
    // Recovery of the owned TMPDIR is attempted independently of the assertions (ACLI82-R8): unlock, then force-remove. An already-absent
    // locked entry means the harness removed the directory itself (the cleanup-failure prerequisite then fails above); every other failure keeps the path.
    const locked = path.join(outcome.tmpDir, 'unrelated-keep', 'locked')
    const recovery: string[] = []
    try { await chmod(locked, 0o700) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') recovery.push(`unlock ${locked}: ${String(error)}`) }
    try { await rm(outcome.tmpDir, { recursive: true, force: true }) } catch (error) { recovery.push(`remove ${outcome.tmpDir}: ${String(error)}`) }
    if (primary && recovery.length) throw new AggregateError([primary.error, ...recovery.map(message => new Error(message))], `The cleanup-failure witness failed and its owned TMPDIR ${outcome.tmpDir} could not be recovered: ${recovery.join(' | ')}`)
    if (primary) throw primary.error
    expect(recovery).toEqual([])
  })

  it('the teardown policy retains the fixture repository while any child closure is unknown and reports every stop failure', () => {
    expect(teardownDecision({ stopFailures: [], liveChildren: 0, retainedFailures: [] })).toEqual({ removeRepository: true, reasons: [] })
    expect(teardownDecision({ stopFailures: ['Error: CLI child 4242 did not exit within the stop bounds'], liveChildren: 1, retainedFailures: [] })).toEqual({
      removeRepository: false,
      reasons: ['1 child process(es) have unknown closure; the fixture repository is retained', 'stop failed: Error: CLI child 4242 did not exit within the stop bounds'],
    })
    expect(teardownDecision({ stopFailures: [], liveChildren: 0, retainedFailures: [{ pid: 7, closure: 'exited', cleanupError: null, evidenceErrors: ['git witness unreadable: EACCES'] }] })).toEqual({
      removeRepository: true, reasons: ['run 7 (exited) left unreported failures: git witness unreadable: EACCES'],
    })
  })
})

describe('publish CLI rollback outcomes', () => {
  it('refuses to roll back when the origin has no publication', async () => {
    server = await startPublicationServer({ token: CLI_TOKEN })
    const outcome = await runPublishCli(fixtureRepo(), { args: ['rollback'], publicationUrl: server.origin })
    expectWellFormedRun(outcome)
    expect(outcome.code).toBe(1)
    expect(outcome.report).toMatchObject({ operation: 'rollback', success: false, published: false, code: 'COLLECTION_OR_VALIDATION_FAILED' })
    expect(outcome.report).not.toHaveProperty('attempted')
    expect(paths()).toEqual(['GET /__orbit/publish/head'])
    expectGitThenTemp(outcome)
    expectSanitized(outcome)
    expectNoProviderTraffic(outcome)
  })

  it('rolls back the current head with an exact two-key parent and reports the new head and storage', async () => {
    server = await startPublicationServer({ token: CLI_TOKEN, initial: await initialPublication() })
    const outcome = await runPublishCli(fixtureRepo(), { args: ['rollback'], publicationUrl: server.origin })
    expectWellFormedRun(outcome)
    expect(outcome.stderr.trim()).toBe('')
    expect(outcome.code).toBe(0)
    expect(outcome.reportStream).toBe('stdout')
    expect(Object.keys(outcome.report!).sort()).toEqual(['elapsedMs', 'head', 'operation', 'storage', 'success'])
    expect(outcome.report).toMatchObject({ operation: 'rollback', success: true })
    const head = (outcome.report as { head: PublicationHead }).head
    expect(head.revision).toBe(2)
    expect(head.generation).toMatch(LOWERCASE_UUID)
    expect(GENERATION_PATTERN.test(head.generation)).toBe(true)
    expect(head.generation).not.toBe(GENERATION_ONE)
    expect(paths()).toEqual(['GET /__orbit/publish/head', 'POST /__orbit/publish/rollback', 'GET /__orbit/publish/metrics'])
    const rollback = server.requests.find(request => request.path === '/__orbit/publish/rollback')!
    expect(rollback.body).toEqual({ generation: head.generation, parent: { revision: 1, generation: GENERATION_ONE } })
    expect(Object.keys(rollback.body as object)).toEqual(['generation', 'parent'])
    expect(Object.keys((rollback.body as { parent: object }).parent)).toEqual(['revision', 'generation'])
    expect(server.current()?.head).toEqual(head)
    expectGitThenTemp(outcome)
    expectSanitized(outcome)
    expectNoProviderTraffic(outcome)
  })
})
