import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

/**
 * Deployed read-only scope for exactly https://job.hyunjun.workers.dev: one
 * total budget of 60 public API attempts shared by every browser, API client,
 * retry and process rerun. The scope comes only from the execution runner's
 * environment and is compared with the literal constants here, so a test cannot
 * replace or reset it. Attempts are counted before they are sent, failures
 * included, through an atomic persistent ledger guarded by a lock directory;
 * corruption or an uncertain lock fails closed (no request is sent).
 *
 * The ledger is created exactly once by the approved owner step
 * (tests/cloudflare/remote/ledger-init.ts, bound in the execution plan). Every
 * ordinary read or reservation refuses a missing ledger (ART82-5): a lost
 * evidence file never reopens a used budget.
 */
export const REMOTE_ORIGIN = 'https://job.hyunjun.workers.dev'
export const REMOTE_MAX_API_REQUESTS = 60
export interface RemoteConfig { origin: string; max: number; ledgerPath: string }

export class RemoteScopeError extends Error {
  constructor(readonly code: 'MISSING_ENV' | 'ORIGIN_MISMATCH' | 'BUDGET_MISMATCH' | 'LEDGER_PATH', message: string) { super(message) }
}
export function remoteConfigFromEnv(env: NodeJS.ProcessEnv = process.env): RemoteConfig {
  const origin = env.ORBIT_REMOTE_ORIGIN
  const max = env.ORBIT_REMOTE_MAX_API_REQUESTS
  const ledgerPath = env.ORBIT_REMOTE_API_LEDGER
  if (!origin || !max || !ledgerPath) throw new RemoteScopeError('MISSING_ENV', 'The deployed read-only scope must be supplied by the execution runner environment')
  if (origin !== REMOTE_ORIGIN) throw new RemoteScopeError('ORIGIN_MISMATCH', 'Only the exact authorized production origin is allowed')
  if (max !== String(REMOTE_MAX_API_REQUESTS)) throw new RemoteScopeError('BUDGET_MISMATCH', 'The public API budget is fixed at 60 attempts')
  if (!path.isAbsolute(ledgerPath) || !ledgerPath.endsWith('.json')) throw new RemoteScopeError('LEDGER_PATH', 'The ledger must be an absolute .json path owned by the runner')
  return { origin, max: REMOTE_MAX_API_REQUESTS, ledgerPath }
}

export interface LedgerAttempt {
  sequence: number
  at: string
  method: 'GET' | 'HEAD'
  path: string
  pid: number
  actor: string
  status?: number
  error?: string
  recordedAt?: string
}
export interface LedgerFile { version: 1; origin: string; max: number; initialized?: { at: string; by: string }; attempts: LedgerAttempt[] }
export class LedgerError extends Error {
  constructor(readonly code: 'BUDGET_EXHAUSTED' | 'LEDGER_CORRUPT' | 'LEDGER_MISSING' | 'LOCK_UNCERTAIN' | 'METHOD' | 'PATH', message: string) { super(message) }
}
const LOCK_WAIT_MS = 5_000
const LOCK_STALE_MS = 60_000
const LOCK_POLL_MS = 25

export const PUBLIC_API_PATHS = ['/api/health', '/api/catalog', '/api/posting-status', '/api/observations'] as const
const GENERATION = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
/** Public read-only API paths with only the query parameters the product itself sends. */
export function allowedApiPath(pathWithQuery: string): boolean {
  let url: URL
  try { url = new URL(pathWithQuery, 'https://ledger.invalid') } catch { return false }
  if (!(PUBLIC_API_PATHS as readonly string[]).includes(url.pathname)) return false
  for (const [key, value] of url.searchParams) {
    if (key === 'source' && url.pathname === '/api/catalog' && ['public', 'sample', 'greenhouse'].includes(value)) continue
    if (key === 'generation' && url.pathname !== '/api/health' && GENERATION.test(value)) continue
    if (key === 'refresh' && url.pathname !== '/api/health' && value === '1') continue
    if (key === 'content' && url.pathname === '/api/posting-status' && value === '1') continue
    return false
  }
  return true
}
export type RequestDecision = { allow: true; counted: boolean } | { allow: false; reason: string }
/** Pure classification shared by the Node client and the browser guard: exact origin, GET/HEAD, no private or test route. */
export function classifyRequest(url: string, method: string, config: RemoteConfig): RequestDecision {
  let target: URL
  try { target = new URL(url) } catch { return { allow: false, reason: 'invalid-url' } }
  if (target.origin !== config.origin) return { allow: false, reason: 'off-origin' }
  if (method !== 'GET' && method !== 'HEAD') return { allow: false, reason: 'method' }
  if (target.pathname === '/__orbit/publish' || target.pathname.startsWith('/__orbit/publish/')) return { allow: false, reason: 'private-path' }
  if (target.pathname === '/__test' || target.pathname.startsWith('/__test/')) return { allow: false, reason: 'test-route' }
  if (target.pathname === '/api' || target.pathname.startsWith('/api/')) {
    return allowedApiPath(target.pathname + target.search) ? { allow: true, counted: true } : { allow: false, reason: 'unsupported-api-path' }
  }
  return { allow: true, counted: false }
}

export function validateLedger(text: string, config: RemoteConfig): LedgerFile {
  let value: unknown
  try { value = JSON.parse(text) } catch { throw new LedgerError('LEDGER_CORRUPT', 'The ledger is not valid JSON') }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new LedgerError('LEDGER_CORRUPT', 'The ledger is not an object')
  const file = value as Partial<LedgerFile>
  if (file.version !== 1 || file.origin !== config.origin || file.max !== config.max || !Array.isArray(file.attempts)) {
    throw new LedgerError('LEDGER_CORRUPT', 'The ledger header does not match the authorized scope')
  }
  file.attempts.forEach((attempt, index) => {
    const valid = attempt && typeof attempt === 'object' && attempt.sequence === index + 1 && typeof attempt.at === 'string'
      && (attempt.method === 'GET' || attempt.method === 'HEAD') && typeof attempt.path === 'string' && Number.isInteger(attempt.pid) && typeof attempt.actor === 'string'
    if (!valid) throw new LedgerError('LEDGER_CORRUPT', `Ledger attempt ${index + 1} is malformed`)
  })
  if (file.attempts.length > config.max) throw new LedgerError('LEDGER_CORRUPT', 'The ledger records more attempts than the budget allows')
  return file as LedgerFile
}

export class ApiBudgetLedger {
  constructor(readonly config: RemoteConfig, readonly actor: string) {}
  private get lockDirectory() { return `${this.config.ledgerPath}.lock` }

  private async withLock<T>(operation: (file: LedgerFile) => Promise<{ file: LedgerFile; result: T }>): Promise<T> {
    const deadline = Date.now() + LOCK_WAIT_MS
    while (true) {
      try {
        await mkdir(this.lockDirectory)
        break
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        const info = await stat(this.lockDirectory).catch(() => null)
        if (info && Date.now() - info.mtimeMs > LOCK_STALE_MS) throw new LedgerError('LOCK_UNCERTAIN', 'A stale ledger lock exists; refusing to count or send')
        if (Date.now() > deadline) throw new LedgerError('LOCK_UNCERTAIN', 'The ledger lock could not be acquired in time; refusing to send')
        await delay(LOCK_POLL_MS)
      }
    }
    try {
      const file = await this.readUnlocked()
      const { file: next, result } = await operation(file)
      const temporary = `${this.config.ledgerPath}.${process.pid}.tmp`
      await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`)
      await rename(temporary, this.config.ledgerPath)
      return result
    } finally {
      await rm(this.lockDirectory, { recursive: true, force: true })
    }
  }
  private async readUnlocked(): Promise<LedgerFile> {
    let text: string
    try {
      text = await readFile(this.config.ledgerPath, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new LedgerError('LEDGER_MISSING', `The persistent ledger ${this.config.ledgerPath} does not exist; the approved owner must initialise it once before any deployed request`)
      }
      throw error
    }
    return validateLedger(text, this.config)
  }
  read(): Promise<LedgerFile> { return this.readUnlocked() }
  /**
   * One-time creation by the approved owner. Atomic exclusive create: an existing
   * ledger is validated and returned unchanged (created: false), never replaced.
   */
  async initialize(owner: string): Promise<{ created: boolean; file: LedgerFile }> {
    const file: LedgerFile = { version: 1, origin: this.config.origin, max: this.config.max, initialized: { at: new Date().toISOString(), by: owner }, attempts: [] }
    await mkdir(path.dirname(this.config.ledgerPath), { recursive: true })
    try {
      await writeFile(this.config.ledgerPath, `${JSON.stringify(file, null, 2)}\n`, { flag: 'wx' })
      return { created: true, file }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      return { created: false, file: await this.readUnlocked() }
    }
  }
  /** Count one attempt before it is sent. Throws before any request when the budget, lock or ledger is not sound. */
  async reserve(request: { method: string; path: string }): Promise<LedgerAttempt> {
    if (request.method !== 'GET' && request.method !== 'HEAD') throw new LedgerError('METHOD', `Only GET/HEAD may reach the deployed origin (${request.method})`)
    if (!allowedApiPath(request.path)) throw new LedgerError('PATH', `Not a public read-only API path: ${request.path}`)
    return this.withLock(async file => {
      if (file.attempts.length >= file.max) throw new LedgerError('BUDGET_EXHAUSTED', `The ${file.max}-attempt public API budget is exhausted`)
      const attempt: LedgerAttempt = {
        sequence: file.attempts.length + 1, at: new Date().toISOString(), method: request.method as 'GET' | 'HEAD',
        path: request.path, pid: process.pid, actor: this.actor,
      }
      return { file: { ...file, attempts: [...file.attempts, attempt] }, result: attempt }
    })
  }
  async record(sequence: number, outcome: { status?: number; error?: string }): Promise<void> {
    await this.withLock(async file => {
      const attempt = file.attempts.find(item => item.sequence === sequence)
      if (!attempt) throw new LedgerError('LEDGER_CORRUPT', `Attempt ${sequence} is missing from the ledger`)
      Object.assign(attempt, outcome, { recordedAt: new Date().toISOString() })
      return { file, result: undefined }
    })
  }
}
