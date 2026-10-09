import { afterEach, describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { allowedApiPath, ApiBudgetLedger, classifyRequest, LedgerError, REMOTE_MAX_API_REQUESTS, REMOTE_ORIGIN, remoteConfigFromEnv, RemoteScopeError } from './ledger'
import type { RemoteConfig } from './ledger'
import { LOCAL_HEALTH, startLocalOrigin } from './local-origin'
import type { LocalOrigin } from './local-origin'
import { createRemoteApi } from './transport'

/**
 * Local verification of the deployed read-only transport itself: the fixed
 * scope, request classification, count-before-send including failures, the
 * exact 60-attempt cap, manual redirects, 304 handling, fail-closed corruption,
 * lock and missing-ledger handling, one-time initialisation, atomic counting
 * across concurrent processes, and the real Node client against an owned
 * loopback HTTP origin (gzip JSON decoded once, identity, HEAD, 304, a 302 that
 * is never followed, a dropped connection). Nothing contacts the production
 * origin: the real-HTTP cases rewrite only the host of each request to the owned
 * origin, so the transport still classifies against the authorized origin. The
 * owned origin is always closed, and a close failure is reported together with
 * the case's own failure, never in its place (ARR82-5/MRS82-2).
 */
const execFileAsync = promisify(execFile)
const here = fileURLToPath(new URL('.', import.meta.url))
const worktree = fileURLToPath(new URL('../../..', import.meta.url))
const directories: string[] = []
async function ledgerPath() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'orbit-remote-ledger-'))
  directories.push(directory)
  return path.join(directory, 'deployed-api-budget.json')
}
afterEach(async () => {
  const results = await Promise.allSettled(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
  expect(results.filter((result): result is PromiseRejectedResult => result.status === 'rejected').map(result => String(result.reason))).toEqual([])
})
const config = async (): Promise<RemoteConfig> => ({ origin: REMOTE_ORIGIN, max: REMOTE_MAX_API_REQUESTS, ledgerPath: await ledgerPath() })
async function initialized(remote: RemoteConfig, actor = 'local-test') {
  const ledger = new ApiBudgetLedger(remote, actor)
  expect((await ledger.initialize(`init|${actor}`)).created).toBe(true)
  return ledger
}
const response = (status: number, body = '{}', headers: Record<string, string> = {}) => new Response(status === 304 || status >= 300 && status < 400 ? null : body, { status, headers: { 'Content-Type': 'application/json', ...headers } })
/** Real fetch whose host is rewritten to an owned loopback origin; the transport still sees the authorized origin. */
const rewriting = (local: string): typeof fetch => (input, init) => fetch(String(input instanceof Request ? input.url : input).replace(REMOTE_ORIGIN, local), init)
const child = (ledgerFile: string, count: string) => execFileAsync(process.execPath, ['--import', 'tsx', path.join(here, 'ledger-child.ts'), ledgerFile, count], { cwd: worktree, encoding: 'utf8', timeout: 120_000 })
/** Run a real-HTTP case against an owned loopback origin and always close it; the case failure and a close failure are reported together. */
async function withLocalOrigin(run: (local: LocalOrigin) => Promise<void>): Promise<void> {
  const local = await startLocalOrigin()
  let primary: { error: unknown } | null = null
  try { await run(local) } catch (error) { primary = { error } }
  let closeFailure: { error: unknown } | null = null
  try { await local.close() } catch (error) { closeFailure = { error } }
  if (primary && closeFailure) throw new AggregateError([primary.error, closeFailure.error], `${String(primary.error)} | the owned origin also failed to close: ${String(closeFailure.error)}`)
  if (primary) throw primary.error
  if (closeFailure) throw closeFailure.error
}

describe('fixed scope', () => {
  it('accepts only the exact runner-supplied origin, budget and absolute ledger path', async () => {
    const good = { ORBIT_REMOTE_ORIGIN: REMOTE_ORIGIN, ORBIT_REMOTE_MAX_API_REQUESTS: '60', ORBIT_REMOTE_API_LEDGER: '/tmp/orbit-synthetic/deployed-api-budget.json' }
    expect(remoteConfigFromEnv(good)).toEqual({ origin: REMOTE_ORIGIN, max: 60, ledgerPath: good.ORBIT_REMOTE_API_LEDGER })
    for (const [patch, code] of [
      [{ ORBIT_REMOTE_ORIGIN: undefined }, 'MISSING_ENV'], [{ ORBIT_REMOTE_ORIGIN: 'https://job.hyunjun.workers.dev/' }, 'ORIGIN_MISMATCH'],
      [{ ORBIT_REMOTE_ORIGIN: 'https://staging.job.hyunjun.workers.dev' }, 'ORIGIN_MISMATCH'], [{ ORBIT_REMOTE_ORIGIN: 'http://job.hyunjun.workers.dev' }, 'ORIGIN_MISMATCH'],
      [{ ORBIT_REMOTE_MAX_API_REQUESTS: '61' }, 'BUDGET_MISMATCH'], [{ ORBIT_REMOTE_MAX_API_REQUESTS: '600' }, 'BUDGET_MISMATCH'],
      [{ ORBIT_REMOTE_API_LEDGER: 'relative/ledger.json' }, 'LEDGER_PATH'], [{ ORBIT_REMOTE_API_LEDGER: '/tmp/ledger.txt' }, 'LEDGER_PATH'],
    ] as [Record<string, string | undefined>, string][]) {
      const env = { ...good, ...patch } as NodeJS.ProcessEnv
      for (const key of Object.keys(patch)) if (patch[key] === undefined) delete env[key]
      expect(() => remoteConfigFromEnv(env)).toThrow(RemoteScopeError)
      try { remoteConfigFromEnv(env) } catch (error) { expect((error as RemoteScopeError).code).toBe(code) }
    }
  })

  it('classifies requests: exact origin, GET/HEAD, public API paths counted, assets uncounted, private/test routes refused', async () => {
    const remote = await config()
    expect(classifyRequest(`${REMOTE_ORIGIN}/api/catalog?source=public`, 'GET', remote)).toEqual({ allow: true, counted: true })
    expect(classifyRequest(`${REMOTE_ORIGIN}/api/health`, 'HEAD', remote)).toEqual({ allow: true, counted: true })
    expect(classifyRequest(`${REMOTE_ORIGIN}/api/observations?generation=abcdef12-abcd-4abc-8abc-abcdefabcdef`, 'GET', remote)).toEqual({ allow: true, counted: true })
    expect(classifyRequest(`${REMOTE_ORIGIN}/api/posting-status?refresh=1&content=1`, 'GET', remote)).toEqual({ allow: true, counted: true })
    expect(classifyRequest(`${REMOTE_ORIGIN}/`, 'GET', remote)).toEqual({ allow: true, counted: false })
    expect(classifyRequest(`${REMOTE_ORIGIN}/assets/app.js`, 'GET', remote)).toEqual({ allow: true, counted: false })
    expect(classifyRequest(`${REMOTE_ORIGIN}/api/catalog`, 'POST', remote)).toEqual({ allow: false, reason: 'method' })
    expect(classifyRequest(`${REMOTE_ORIGIN}/__orbit/publish/head`, 'GET', remote)).toEqual({ allow: false, reason: 'private-path' })
    expect(classifyRequest(`${REMOTE_ORIGIN}/__orbit/publish`, 'GET', remote)).toEqual({ allow: false, reason: 'private-path' })
    expect(classifyRequest(`${REMOTE_ORIGIN}/__test/wipe`, 'GET', remote)).toEqual({ allow: false, reason: 'test-route' })
    expect(classifyRequest(`${REMOTE_ORIGIN}/api/catalog/progress?id=x`, 'GET', remote)).toEqual({ allow: false, reason: 'unsupported-api-path' })
    expect(classifyRequest(`${REMOTE_ORIGIN}/api/catalog?source=public&debug=1`, 'GET', remote)).toEqual({ allow: false, reason: 'unsupported-api-path' })
    expect(classifyRequest(`${REMOTE_ORIGIN}/api`, 'GET', remote)).toEqual({ allow: false, reason: 'unsupported-api-path' })
    expect(classifyRequest('https://job.hyunjun.workers.dev.example.test/api/health', 'GET', remote)).toEqual({ allow: false, reason: 'off-origin' })
    expect(classifyRequest('https://example.test/api/health', 'GET', remote)).toEqual({ allow: false, reason: 'off-origin' })
    expect(classifyRequest('wss://job.hyunjun.workers.dev/socket', 'GET', remote)).toEqual({ allow: false, reason: 'off-origin' })
    expect(allowedApiPath('/api/health?generation=abcdef12-abcd-4abc-8abc-abcdefabcdef')).toBe(false)
    expect(allowedApiPath('/api/catalog?source=other')).toBe(false)
    expect(allowedApiPath('/api/observations?generation=not-a-uuid')).toBe(false)
  })
})

describe('ledger and client', () => {
  it('counts before sending, records failures, refuses private paths, never follows a redirect, and does not call 304 a redirect', async () => {
    const remote = await config()
    const ledger = await initialized(remote)
    const calls: { url: string; method: string; redirect: string | undefined }[] = []
    const scripted: Response[] = [response(200, '{"status":"ok"}'), response(302, '', { Location: 'https://example.test/elsewhere' }), response(304, '', { ETag: 'W/"abc"' })]
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), method: init?.method ?? 'GET', redirect: init?.redirect })
      if (calls.length === 4) throw new TypeError('synthetic network failure')
      return scripted.shift()!
    }) as typeof fetch
    const api = createRemoteApi(ledger, remote, fetcher)
    const health = await api.get('/api/health')
    expect(health.status).toBe(200)
    expect(health.bodyRepresentation).toBe('fetch-decoded')
    expect(health.attempt.sequence).toBe(1)
    expect(Date.parse(health.respondedAt)).toBeGreaterThanOrEqual(Date.parse(health.requestedAt))
    const redirected = await api.get('/api/catalog?source=public')
    expect(redirected.redirected).toBe(true)
    expect(redirected.status).toBe(302)
    expect(redirected.body.length).toBe(0)
    const conditional = await api.get('/api/observations?generation=abcdef12-abcd-4abc-8abc-abcdefabcdef', { 'If-None-Match': 'W/"abc"' })
    expect(conditional.status).toBe(304)
    expect(conditional.redirected).toBe(false)
    expect(conditional.body.length).toBe(0)
    expect(calls).toHaveLength(3)
    expect(calls.every(call => call.redirect === 'manual')).toBe(true)
    await expect(api.get('/api/posting-status')).rejects.toThrow('synthetic network failure')
    await expect(api.get('/__orbit/publish/head')).rejects.toThrow(LedgerError)
    await expect(api.get('/api/catalog?source=public&debug=1')).rejects.toThrow(LedgerError)
    expect(calls).toHaveLength(4)
    const file = await ledger.read()
    expect(file.attempts.map(attempt => [attempt.sequence, attempt.method, attempt.path, attempt.status ?? null, attempt.error ? 'error' : null])).toEqual([
      [1, 'GET', '/api/health', 200, null], [2, 'GET', '/api/catalog?source=public', 302, null],
      [3, 'GET', '/api/observations?generation=abcdef12-abcd-4abc-8abc-abcdefabcdef', 304, null], [4, 'GET', '/api/posting-status', null, 'error'],
    ])
    expect(file.attempts.every(attempt => attempt.pid === process.pid && attempt.actor === 'local-test')).toBe(true)
  })

  it('reports both the request failure and a failed outcome write', async () => {
    const remote = await config()
    const ledger = await initialized(remote)
    ledger.record = async () => { throw new Error('synthetic ledger write failure') }
    const api = createRemoteApi(ledger, remote, (async () => { throw new TypeError('synthetic network failure') }) as typeof fetch)
    const failure = await api.get('/api/health').then(() => null, error => error as AggregateError)
    expect(failure).toBeInstanceOf(AggregateError)
    expect(failure!.errors.map(error => String(error))).toEqual(['TypeError: synthetic network failure', 'Error: synthetic ledger write failure'])
    expect((await ledger.read()).attempts).toHaveLength(1)
  })

  it('stops exactly at 60 attempts across the ledger lifetime without sending the 61st', async () => {
    const remote = await config()
    const ledger = await initialized(remote)
    let sent = 0
    const api = createRemoteApi(ledger, remote, (async () => { sent++; return response(200) }) as typeof fetch)
    for (let index = 0; index < 60; index++) expect((await api.head('/api/health')).status).toBe(200)
    await expect(api.head('/api/health')).rejects.toMatchObject({ code: 'BUDGET_EXHAUSTED' })
    expect(sent).toBe(60)
    const reopened = new ApiBudgetLedger(remote, 'second-process')
    await expect(reopened.reserve({ method: 'GET', path: '/api/health' })).rejects.toMatchObject({ code: 'BUDGET_EXHAUSTED' })
    expect((await reopened.read()).attempts).toHaveLength(60)
  })

  it('initialises exactly once: a second initialisation keeps the existing attempts and nothing resets a used budget', async () => {
    const remote = await config()
    const ledger = await initialized(remote)
    for (let index = 0; index < 3; index++) await ledger.reserve({ method: 'GET', path: '/api/health' })
    const again = await new ApiBudgetLedger(remote, 'owner-again').initialize('owner-again')
    expect(again.created).toBe(false)
    expect(again.file.attempts).toHaveLength(3)
    expect(again.file.initialized?.by).toBe('init|local-test')
  })

  it('fails closed on a missing ledger, a ledger lost after use, a corrupt ledger, a foreign header and a stale lock, sending nothing', async () => {
    const remote = await config()
    let sent = 0
    const fetcher = (async () => { sent++; return response(200) }) as typeof fetch
    await expect(createRemoteApi(new ApiBudgetLedger(remote, 'local-test'), remote, fetcher).get('/api/health')).rejects.toMatchObject({ code: 'LEDGER_MISSING' })
    await expect(new ApiBudgetLedger(remote, 'local-test').read()).rejects.toMatchObject({ code: 'LEDGER_MISSING' })
    const ledger = await initialized(remote)
    await ledger.reserve({ method: 'GET', path: '/api/health' })
    await ledger.reserve({ method: 'GET', path: '/api/health' })
    await rm(remote.ledgerPath, { force: true })
    await expect(createRemoteApi(new ApiBudgetLedger(remote, 'local-test'), remote, fetcher).get('/api/health')).rejects.toMatchObject({ code: 'LEDGER_MISSING' })
    await writeFile(remote.ledgerPath, '{"version":1,"origin":"https://job.hyunjun.workers.dev","max":60,"attempts":[')
    await expect(createRemoteApi(new ApiBudgetLedger(remote, 'local-test'), remote, fetcher).get('/api/health')).rejects.toMatchObject({ code: 'LEDGER_CORRUPT' })
    await writeFile(remote.ledgerPath, JSON.stringify({ version: 1, origin: 'https://example.test', max: 60, attempts: [] }))
    await expect(createRemoteApi(new ApiBudgetLedger(remote, 'local-test'), remote, fetcher).get('/api/health')).rejects.toMatchObject({ code: 'LEDGER_CORRUPT' })
    await writeFile(remote.ledgerPath, JSON.stringify({ version: 1, origin: REMOTE_ORIGIN, max: 61, attempts: [] }))
    await expect(createRemoteApi(new ApiBudgetLedger(remote, 'local-test'), remote, fetcher).get('/api/health')).rejects.toMatchObject({ code: 'LEDGER_CORRUPT' })
    await writeFile(remote.ledgerPath, JSON.stringify({ version: 1, origin: REMOTE_ORIGIN, max: 60, attempts: [{ sequence: 2, at: 'x', method: 'GET', path: '/api/health', pid: 1, actor: 'a' }] }))
    await expect(createRemoteApi(new ApiBudgetLedger(remote, 'local-test'), remote, fetcher).get('/api/health')).rejects.toMatchObject({ code: 'LEDGER_CORRUPT' })
    await writeFile(remote.ledgerPath, JSON.stringify({ version: 1, origin: REMOTE_ORIGIN, max: 60, attempts: [] }))
    await mkdir(`${remote.ledgerPath}.lock`)
    const stale = new Date(Date.now() - 2 * 60_000)
    await utimes(`${remote.ledgerPath}.lock`, stale, stale)
    await expect(createRemoteApi(new ApiBudgetLedger(remote, 'local-test'), remote, fetcher).get('/api/health')).rejects.toMatchObject({ code: 'LOCK_UNCERTAIN' })
    expect(sent).toBe(0)
  })

  it('drives the real Node client against an owned loopback origin: gzip JSON decoded once, identity, HEAD, 304, an unfollowed 302 and a dropped connection', async () => {
    const remote = await config()
    const ledger = await initialized(remote)
    await withLocalOrigin(async local => {
      const api = createRemoteApi(ledger, remote, rewriting(local.origin))
      const gzipped = await api.get('/api/health')
      expect(gzipped.status).toBe(200)
      expect(gzipped.headers['content-encoding']).toBe('gzip')
      expect(gzipped.bodyRepresentation).toBe('fetch-decoded')
      // The Fetch API already decoded the body; parsing it directly must work and a second decode would be wrong.
      expect(JSON.parse(gzipped.body.toString('utf8'))).toEqual(LOCAL_HEALTH)
      expect(/\bgzip\b/.test(String(local.requests[0].headers['accept-encoding']))).toBe(true)
      const identity = await api.get('/api/health', { 'Accept-Encoding': 'identity' })
      expect(identity.status).toBe(200)
      expect(identity.headers['content-encoding']).toBeUndefined()
      expect(JSON.parse(identity.body.toString('utf8'))).toEqual(LOCAL_HEALTH)
      const head = await api.head('/api/health')
      expect(head.status).toBe(200)
      expect(head.body.length).toBe(0)
      expect(head.headers.etag).toMatch(/^W\/"[a-f0-9]{64}"$/)
      const conditional = await api.get('/api/health', { 'If-None-Match': head.headers.etag })
      expect(conditional.status).toBe(304)
      expect(conditional.redirected).toBe(false)
      expect(conditional.body.length).toBe(0)
      const redirected = await api.get('/api/catalog?source=public')
      expect(redirected.status).toBe(302)
      expect(redirected.redirected).toBe(true)
      expect(redirected.headers.location).toBe('/elsewhere')
      await expect(api.get('/api/posting-status?refresh=1')).rejects.toThrow()
      expect(local.requests.map(request => `${request.method} ${request.path}`)).toEqual([
        'GET /api/health', 'GET /api/health', 'HEAD /api/health', 'GET /api/health', 'GET /api/catalog?source=public', 'GET /api/posting-status?refresh=1',
      ])
      const file = await ledger.read()
      expect(file.attempts.map(attempt => attempt.status ?? (attempt.error ? 'error' : null))).toEqual([200, 200, 200, 304, 302, 'error'])
      expect(file.attempts.every(attempt => attempt.recordedAt !== undefined)).toBe(true)
    })
  })

  it('sends exactly 60 real requests to the owned origin and refuses the 61st before send', async () => {
    const remote = await config()
    const ledger = await initialized(remote)
    await withLocalOrigin(async local => {
      const api = createRemoteApi(ledger, remote, rewriting(local.origin))
      for (let index = 0; index < 60; index++) expect((await api.head('/api/health')).status, `attempt ${index + 1}`).toBe(200)
      expect(local.requests).toHaveLength(60)
      await expect(api.head('/api/health')).rejects.toMatchObject({ code: 'BUDGET_EXHAUSTED' })
      expect(local.requests).toHaveLength(60)
      expect((await ledger.read()).attempts.map(attempt => attempt.sequence)).toEqual(Array.from({ length: 60 }, (_, index) => index + 1))
    })
  })

  it('counts atomically across concurrent processes: 80 attempts from 4 joined children yield exactly 60 counted and 20 refused, without a fairness assumption', async () => {
    const remote = await config()
    await initialized(remote)
    const settled = await Promise.allSettled(Array.from({ length: 4 }, () => child(remote.ledgerPath, '20')))
    expect(settled.filter((result): result is PromiseRejectedResult => result.status === 'rejected').map(result => String(result.reason))).toEqual([])
    const results = settled.map(result => JSON.parse((result as PromiseFulfilledResult<{ stdout: string }>).value.stdout.trim().split('\n').at(-1)!) as { pid: number; reserved: number; exhausted: number; other: number })
    expect(results).toHaveLength(4)
    expect(new Set(results.map(result => result.pid)).size).toBe(4)
    for (const result of results) expect(result.reserved + result.exhausted + result.other, `child ${result.pid}`).toBe(20)
    expect(results.reduce((sum, result) => sum + result.reserved, 0)).toBe(60)
    expect(results.reduce((sum, result) => sum + result.exhausted, 0)).toBe(20)
    expect(results.every(result => result.other === 0)).toBe(true)
    const file = JSON.parse(await readFile(remote.ledgerPath, 'utf8')) as { attempts: { sequence: number; pid: number }[] }
    expect(file.attempts.map(attempt => attempt.sequence)).toEqual(Array.from({ length: 60 }, (_, index) => index + 1))
    const contributors = new Set(file.attempts.map(attempt => attempt.pid))
    const childPids = new Set(results.map(result => result.pid))
    expect([...contributors].every(pid => childPids.has(pid))).toBe(true)
    // A valid schedule may let three children exhaust the budget before the fourth starts; the per-child totals above are the contract.
    expect(contributors.size).toBeGreaterThanOrEqual(1)
  }, 150_000)

  it('joins an early child failure alongside a working sibling before any shared cleanup', async () => {
    const remote = await config()
    await initialized(remote)
    const settled = await Promise.allSettled([child(remote.ledgerPath, ''), child(remote.ledgerPath, '20')])
    expect(settled[0].status).toBe('rejected')
    expect(settled[1].status).toBe('fulfilled')
    const sibling = JSON.parse((settled[1] as PromiseFulfilledResult<{ stdout: string }>).value.stdout.trim().split('\n').at(-1)!) as { reserved: number; exhausted: number; other: number }
    expect(sibling).toMatchObject({ reserved: 20, exhausted: 0, other: 0 })
    expect((await new ApiBudgetLedger(remote, 'reader').read()).attempts).toHaveLength(20)
  }, 150_000)
})
