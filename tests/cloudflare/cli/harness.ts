import { execFile, spawn } from 'node:child_process'
import { access, chmod, constants, cp, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

/**
 * Subprocess harness for scripts/publish-catalog.ts. The CLI insists on a clean
 * git checkout of its own repository root, so each run uses a throwaway fixture
 * repository: a real copy of the script plus symlinks to the worktree's product
 * directories and dependencies. Git runs with an isolated configuration and a
 * bounded lifetime.
 *
 * Environment (ACT82-1): HOME is passed through unchanged. Only the reviewed
 * controller/observer/cache names in INHERITED_ENV reach the CLI, so a run
 * under the stage runner keeps its register-processes preload (NODE_OPTIONS),
 * registry path, actor and isolated caches, while nothing else from the harness
 * environment leaks. The CLI is the parent's direct child and is observed as
 * such; its synchronous execFileSync git children are outside the existing
 * observer whether or not the context is inherited, so a PATH shim records the
 * real executions while the preload records the ordered API calls.
 *
 * Ownership (ACT82-3/4, MCT82-1, ACLI82-R4/R5, MCLR82-4): a run stays
 * registered until its finalization (exit, evidence reads and TMPDIR removal)
 * has completed; `stop()` joins that finalization even when the child already
 * exited and reports a cleanup failure instead of hiding it. Child closure
 * ('exited' or 'spawn-failed') is recorded separately from a later TMPDIR
 * cleanup failure; a child that does not exit within the stop bounds has
 * unknown closure and `stop()` rejects distinctly. Completed finalization
 * failures are retained until teardown consumes them, so a test that failed
 * before reading its outcome cannot hide them. Deliberate signals go through the
 * retained child handle, never a raw numeric pid. The exit-grace timers are
 * cancelled when exit wins their race.
 *
 * Evidence (ACT82-5/8, MCT82-3, ACLI82-R3/MCLR82-3): the preload's ordered
 * ledger of execFileSync/mkdtemp/checkpoint/head/provider events is the
 * same-process causal witness, the PATH shim log proves that git really ran,
 * and the post-exit TMPDIR state is the cleanup proof. There is no fs.watch
 * observer any more; nothing optional gates acceptance. Missing or foreign
 * provider instrumentation is reported as unavailable evidence (with the read
 * error kept for diagnosis), never as zero traffic. Setup and teardown cleanup
 * failures are preserved together with the failure that preceded them
 * (ACT82-2). Nothing here runs at import time.
 */
export const WORKTREE = fileURLToPath(new URL('../../..', import.meta.url))
export const CLI_TOKEN = 'fictional-publish-cli-token-0123456789abcdef0123456789abcdef0123456789'
const PRELOAD = new URL('./provider-preload.ts', import.meta.url).href
const GIT_TIMEOUT_MS = 30_000
const STOP_GRACE_MS = 5_000
const execFileAsync = promisify(execFile)
const INHERITED_ENV = [
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'TERM',
  'NODE_OPTIONS', 'ORBIT_PROCESS_REGISTRY', 'ORBIT_VERIFICATION_ACTOR', 'XDG_CONFIG_HOME',
  'NODE_COMPILE_CACHE', 'npm_config_cache', 'npm_config_userconfig', 'npm_config_globalconfig',
  'GIT_OPTIONAL_LOCKS', 'GIT_TERMINAL_PROMPT',
] as const
const GIT_SHIM = `#!/bin/sh
# Stage82 CLI fixture witness: record the git arguments, then run the real git unchanged.
printf '%s\\n' "$*" >> "$ORBIT_TEST_GIT_WITNESS"
exec "$ORBIT_TEST_REAL_GIT" "$@"
`

/** Remove an owned path after a failure; if that also fails, keep both errors and the path (ACT82-2). */
async function failAndRemove(target: string, original: unknown): Promise<never> {
  try {
    await rm(target, { recursive: true, force: true })
  } catch (cleanupError) {
    throw new AggregateError([original, cleanupError], `Setup failed and the owned path ${target} could not be removed`)
  }
  throw original
}

async function realGit(): Promise<string> {
  for (const directory of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!directory) continue
    const candidate = path.join(directory, 'git')
    try {
      await access(candidate, constants.X_OK)
      return candidate
    } catch { /* try the next PATH entry */ }
  }
  throw new Error('git is not available on PATH for the fixture repository')
}

export interface CollectorRepo {
  root: string
  commit: string
  /** Directory holding the git witness shim, prepended to the CLI's PATH. */
  shims: string
  realGit: string
  /** Leave an untracked file behind; returns the cleanup. */
  dirty: () => Promise<() => Promise<void>>
  remove: () => Promise<void>
}

export async function prepareCollectorRepo(): Promise<CollectorRepo> {
  for (const required of ['node_modules/tsx/package.json', 'scripts/publish-catalog.ts', 'package.json', 'tsconfig.json']) {
    await access(path.join(WORKTREE, required)).catch(() => {
      throw new Error(`The publish CLI harness needs ${required} in the worktree (install dependencies there first)`)
    })
  }
  const git = await realGit()
  const root = await mkdtemp(path.join(os.tmpdir(), 'orbit-cli-contract-'))
  // Cleanup is owned from this point; any setup failure removes the partial directory and rethrows, keeping a cleanup failure too.
  try {
    await mkdir(path.join(root, 'scripts'))
    await cp(path.join(WORKTREE, 'scripts/publish-catalog.ts'), path.join(root, 'scripts/publish-catalog.ts'))
    for (const name of ['package.json', 'tsconfig.json']) await cp(path.join(WORKTREE, name), path.join(root, name))
    for (const name of ['server', 'shared', 'src', 'node_modules']) await symlink(path.join(WORKTREE, name), path.join(root, name), 'dir')
    const shims = path.join(root, '.fixture-shims')
    await mkdir(shims)
    await writeFile(path.join(shims, 'git'), GIT_SHIM, { mode: 0o755 })
    const run = (...args: string[]) => execFileAsync(git, ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args], {
      cwd: root, encoding: 'utf8', timeout: GIT_TIMEOUT_MS, killSignal: 'SIGKILL',
      env: {
        PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
        GIT_AUTHOR_NAME: 'Orbit Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.com',
        GIT_COMMITTER_NAME: 'Orbit Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.com',
        GIT_TERMINAL_PROMPT: '0', LANG: 'C',
      },
    })
    await run('init', '-q', '-b', 'fixture')
    await run('add', '-A')
    await run('commit', '-q', '-m', 'Fictional collector fixture')
    const commit = (await run('rev-parse', 'HEAD')).stdout.trim()
    if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error('The fixture repository has no commit')
    return {
      root, commit, shims, realGit: git,
      dirty: async () => {
        const file = path.join(root, 'UNTRACKED-CHANGE.txt')
        await writeFile(file, 'fictional uncommitted change\n')
        return () => rm(file, { force: true })
      },
      remove: () => rm(root, { recursive: true, force: true }),
    }
  } catch (error) {
    return failAndRemove(root, error)
  }
}

export type PreloadEvent =
  | { seq: number; kind: 'execFileSync'; file: string; args: string[] }
  | { seq: number; kind: 'mkdtemp'; prefix: string }
  | { seq: number; kind: 'checkpoint-start'; file: string; status: number }
  | { seq: number; kind: 'checkpoint-complete'; file: string }
  | { seq: number; kind: 'head-response'; status: number; ordinal: number }
  | { seq: number; kind: 'provider-attempt'; host: string }
export interface ProviderEvidence {
  version: 3
  pid: number
  forwarded: number
  blocked: Record<string, number>
  /** Ordered same-process ledger (Git/mkdtemp calls, checkpoint start/completion, head responses, first provider attempt). */
  events: PreloadEvent[]
  liveLogErrors: string[]
  completedAt: string
}
export interface CliOutcome {
  code: number | null
  signal: NodeJS.Signals | null
  /** How the child ended: observed exit/close, or a spawn that never produced a process. */
  closure: 'exited' | 'spawn-failed'
  spawnError: string | null
  /** Non-fatal child `error` events (for example a failed signal delivery). */
  childErrors: string[]
  stdout: string
  stderr: string
  /** The last JSON line on stdout (success) or stderr (failure). */
  report: Record<string, unknown> | null
  reportStream: 'stdout' | 'stderr' | null
  /** 'valid' only when the preload wrote a complete version-3 record naming this child's pid. */
  providerEvidence: 'valid' | 'missing' | 'invalid'
  /** The read/parse error behind 'missing'/'invalid', kept for diagnosis; null for a plain absent file. */
  providerEvidenceError: string | null
  providers: ProviderEvidence | null
  /** The preload's ordered ledger (empty unless providerEvidence is 'valid'). */
  events: PreloadEvent[]
  /** Argument lines of every real git execution through the PATH shim, in order. */
  gitInvocations: string[]
  /** Entries left in the CLI's TMPDIR besides the fixture's own `unrelated-keep` directory; null if unreadable. */
  leftovers: string[] | null
  unrelatedKept: boolean
  /** The owned TMPDIR; retained on disk only when cleanupError is set. */
  tmpDir: string
  /** Reasons passed to stop(). */
  stopRequests: string[]
  /** Deliberate signals sent through the retained child handle. */
  signals: string[]
  evidenceErrors: string[]
  cleanupError: string | null
  elapsedMs: number
}
export interface CliRun {
  readonly pid: number | undefined
  readonly finished: Promise<CliOutcome>
  /** Bounded stop of the retained direct child only (SIGTERM, 5 s, SIGKILL, 5 s), then a join of its finalization; idempotent, never a group sweep. */
  stop: (reason: string) => Promise<void>
  /** Deliver one signal to the retained direct child (the test's own cancellation witness). */
  signal: (name: NodeJS.Signals) => void
  /** The preload's live event log as written so far (same-process ledger, read while the child still runs). */
  liveEvents: () => Promise<PreloadEvent[]>
}
export interface RetainedFailure { pid: number | undefined; closure: CliOutcome['closure']; cleanupError: string | null; evidenceErrors: string[] }

const activeRuns = new Set<CliRun>()
const liveChildren = new Set<CliRun>()
const retainedFailures: RetainedFailure[] = []
/** Stop and join every registered CLI run before servers close or directories are removed; returns one result per run. */
export async function stopAllRuns(reason: string): Promise<PromiseSettledResult<void>[]> {
  return Promise.allSettled([...activeRuns].map(run => run.stop(reason)))
}
export const activeRunCount = () => activeRuns.size
/** Runs whose child has not been observed to exit (closure unknown until it does). */
export const liveChildCount = () => liveChildren.size
/** Completed finalization failures (cleanup or evidence) not yet reported by any test; consuming them clears the list. */
export function takeRetainedFailures(): RetainedFailure[] {
  return retainedFailures.splice(0)
}
/** Teardown policy (ACLI82-R4): the fixture repository may be deleted only when every child is known closed and every stop joined. */
export function teardownDecision(input: { stopFailures: string[]; liveChildren: number; retainedFailures: RetainedFailure[] }): { removeRepository: boolean; reasons: string[] } {
  const reasons: string[] = []
  if (input.liveChildren > 0) reasons.push(`${input.liveChildren} child process(es) have unknown closure; the fixture repository is retained`)
  if (input.stopFailures.length) reasons.push(...input.stopFailures.map(failure => `stop failed: ${failure}`))
  for (const failure of input.retainedFailures) reasons.push(`run ${failure.pid ?? 'unspawned'} (${failure.closure}) left unreported failures: ${[failure.cleanupError, ...failure.evidenceErrors].filter(Boolean).join('; ')}`)
  return { removeRepository: input.liveChildren === 0, reasons }
}

function lastJsonLine(text: string): Record<string, unknown> | null {
  const lines = text.split('\n').map(line => line.trim()).filter(line => line.startsWith('{') && line.endsWith('}'))
  if (!lines.length) return null
  try { return JSON.parse(lines[lines.length - 1]) as Record<string, unknown> }
  catch { return null }
}

const EVENT_KINDS = new Set(['execFileSync', 'mkdtemp', 'checkpoint-start', 'checkpoint-complete', 'head-response', 'provider-attempt'])
function validEvent(event: unknown, index: number | null): event is PreloadEvent {
  if (!event || typeof event !== 'object') return false
  const candidate = event as Record<string, unknown>
  if (!Number.isInteger(candidate.seq) || (index !== null && candidate.seq !== index + 1)) return false
  if (typeof candidate.kind !== 'string' || !EVENT_KINDS.has(candidate.kind)) return false
  switch (candidate.kind) {
    case 'execFileSync': return typeof candidate.file === 'string' && Array.isArray(candidate.args) && candidate.args.every(item => typeof item === 'string')
    case 'mkdtemp': return typeof candidate.prefix === 'string'
    case 'checkpoint-start': return typeof candidate.file === 'string' && Number.isInteger(candidate.status)
    case 'checkpoint-complete': return typeof candidate.file === 'string'
    case 'head-response': return Number.isInteger(candidate.status) && Number.isInteger(candidate.ordinal)
    default: return typeof candidate.host === 'string'
  }
}
async function readProviderEvidence(file: string, pid: number | undefined): Promise<Pick<CliOutcome, 'providerEvidence' | 'providerEvidenceError' | 'providers' | 'events'>> {
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    return { providerEvidence: 'missing', providerEvidenceError: code === 'ENOENT' ? null : String(error), providers: null, events: [] }
  }
  try {
    const value = JSON.parse(text) as Partial<ProviderEvidence>
    const valid = value.version === 3 && value.pid === pid && Number.isInteger(value.forwarded)
      && value.blocked !== null && typeof value.blocked === 'object' && !Array.isArray(value.blocked)
      && Object.values(value.blocked).every(count => Number.isInteger(count))
      && Array.isArray(value.events) && value.events.every((event, index) => validEvent(event, index))
      && Array.isArray(value.liveLogErrors) && value.liveLogErrors.every(item => typeof item === 'string') && typeof value.completedAt === 'string'
    return valid
      ? { providerEvidence: 'valid', providerEvidenceError: null, providers: value as ProviderEvidence, events: value.events as PreloadEvent[] }
      : { providerEvidence: 'invalid', providerEvidenceError: 'the completion record is not a complete version-3 record for this child', providers: null, events: [] }
  } catch (error) {
    return { providerEvidence: 'invalid', providerEvidenceError: String(error), providers: null, events: [] }
  }
}
async function readLiveEvents(file: string): Promise<PreloadEvent[]> {
  let text: string
  try { text = await readFile(file, 'utf8') }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  return text.split('\n').filter(Boolean).map(line => {
    const event = JSON.parse(line) as unknown
    if (!validEvent(event, null)) throw new Error(`Malformed live event: ${line}`)
    return event
  })
}

export async function startPublishCli(repo: CollectorRepo, options: {
  args?: string[]
  publicationUrl: string
  /** The only origin the preload lets through; defaults to the publication URL. */
  allowedOrigin?: string
  token?: string
  /**
   * Controlled cleanup-failure witness: a write-protected entry inside the
   * fixture's own `unrelated-keep` directory makes the owned TMPDIR removal fail
   * for real, so the reporting path can be exercised; the test must unlock and
   * remove `outcome.tmpDir` itself afterwards.
   */
  witness?: { lockedUnrelatedEntry?: boolean }
}): Promise<CliRun> {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'orbit-cli-tmpdir-'))
  const evidenceErrors: string[] = []
  try {
    const keep = path.join(tmp, 'unrelated-keep')
    await mkdir(keep)
    const marker = path.join(keep, 'marker.txt')
    await writeFile(marker, 'unrelated content that the CLI must not touch\n')
    const providerLog = path.join(keep, 'providers.json')
    const eventLog = path.join(keep, 'events.log')
    const gitWitness = path.join(keep, 'git-invocations.log')
    if (options.witness?.lockedUnrelatedEntry) {
      const locked = path.join(keep, 'locked')
      await mkdir(locked)
      await writeFile(path.join(locked, 'pinned.txt'), 'this entry makes the owned TMPDIR removal fail on purpose\n')
      await chmod(locked, 0o500)
    }
    const env: Record<string, string> = {}
    for (const name of INHERITED_ENV) {
      const value = process.env[name]
      if (value !== undefined) env[name] = value
    }
    env.PATH = `${repo.shims}${path.delimiter}${env.PATH ?? ''}`
    Object.assign(env, {
      TMPDIR: tmp, NODE_NO_WARNINGS: '1',
      // The `--import tsx` loader keeps a transform cache at os.tmpdir()/tsx-<uid>, which would
      // land inside this owned TMPDIR and be counted as CLI residue by the post-exit leftovers
      // witness; disable it explicitly for the child (stage82 CT-1; set here, not inherited).
      TSX_DISABLE_CACHE: '1',
      ORBIT_PUBLICATION_URL: options.publicationUrl,
      ORBIT_PUBLISH_TOKEN: options.token ?? CLI_TOKEN,
      ORBIT_TEST_ALLOWED_ORIGIN: options.allowedOrigin ?? options.publicationUrl,
      ORBIT_TEST_PROVIDER_LOG: providerLog,
      ORBIT_TEST_EVENT_LOG: eventLog,
      ORBIT_TEST_GIT_WITNESS: gitWitness,
      ORBIT_TEST_REAL_GIT: repo.realGit,
    })
    const startedAt = Date.now()
    const child = spawn(process.execPath, ['--import', 'tsx', '--import', PRELOAD, 'scripts/publish-catalog.ts', ...(options.args ?? ['collect'])], {
      cwd: repo.root, stdio: ['ignore', 'pipe', 'pipe'], env,
    })
    let stdout = ''
    let stderr = ''
    child.stdout!.setEncoding('utf8')
    child.stderr!.setEncoding('utf8')
    child.stdout!.on('data', chunk => { stdout += chunk })
    child.stderr!.on('data', chunk => { stderr += chunk })
    const stopRequests: string[] = []
    const signals: string[] = []
    const childErrors: string[] = []
    let finalizing = false
    let resolveFinished!: (outcome: CliOutcome) => void
    const finished = new Promise<CliOutcome>(resolve => { resolveFinished = resolve })
    const exited = new Promise<void>(resolve => { child.once('exit', () => resolve()) })
    const hasExited = () => child.exitCode !== null || child.signalCode !== null
    const finalize = async (exit: { code: number | null; signal: NodeJS.Signals | null; spawnError?: Error }) => {
      if (finalizing) return
      finalizing = true
      liveChildren.delete(run)
      const closure: CliOutcome['closure'] = exit.spawnError ? 'spawn-failed' : 'exited'
      const evidence = await readProviderEvidence(providerLog, child.pid)
      let gitInvocations: string[] = []
      try {
        gitInvocations = (await readFile(gitWitness, 'utf8')).split('\n').filter(Boolean)
      } catch (error) {
        // No shim log means git never ran; anything else is unavailable evidence, not zero invocations.
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') evidenceErrors.push(`git witness unreadable: ${String(error)}`)
      }
      const entries = await readdir(tmp).catch(error => { evidenceErrors.push(`TMPDIR unreadable: ${String(error)}`); return null })
      const leftovers = entries === null ? null : entries.filter(name => name !== 'unrelated-keep')
      const unrelatedKept = (await readFile(marker, 'utf8').catch(() => '')).startsWith('unrelated content')
      const successReport = lastJsonLine(stdout)
      const failureReport = lastJsonLine(stderr)
      let cleanupError: string | null = null
      try { await rm(tmp, { recursive: true, force: true }) }
      catch (error) { cleanupError = String(error) }
      if (cleanupError || evidenceErrors.length) retainedFailures.push({ pid: child.pid, closure, cleanupError, evidenceErrors: [...evidenceErrors] })
      resolveFinished({
        code: exit.code, signal: exit.signal, closure, spawnError: exit.spawnError ? String(exit.spawnError) : null, childErrors: [...childErrors], stdout, stderr,
        report: successReport ?? failureReport, reportStream: successReport ? 'stdout' : failureReport ? 'stderr' : null,
        ...evidence, gitInvocations, leftovers, unrelatedKept, tmpDir: tmp,
        stopRequests: [...stopRequests], signals: [...signals], evidenceErrors: [...evidenceErrors], cleanupError, elapsedMs: Date.now() - startedAt,
      })
      // Registration ends only after finalization has reported.
      activeRuns.delete(run)
    }
    child.once('error', error => {
      childErrors.push(String(error))
      // Only a failed spawn (no pid, no close to come) is terminal; other errors are recorded and the close event decides.
      if (child.pid === undefined) void finalize({ code: null, signal: null, spawnError: error })
    })
    child.once('close', (code, signal) => { void finalize({ code, signal }) })
    /** True when the child exits within the bound; the losing grace timer is cancelled. */
    const exitedWithin = async (milliseconds: number) => {
      const timer = new AbortController()
      const result = await Promise.race([exited.then(() => true), delay(milliseconds, false, { signal: timer.signal }).catch(() => false)])
      timer.abort()
      return result
    }
    const run: CliRun = {
      pid: child.pid,
      finished,
      stop: async reason => {
        if (!finalizing && !hasExited()) {
          stopRequests.push(reason)
          child.kill('SIGTERM')
          if (!(await exitedWithin(STOP_GRACE_MS))) {
            child.kill('SIGKILL')
            if (!(await exitedWithin(STOP_GRACE_MS))) throw new Error(`CLI child ${child.pid} did not exit within the stop bounds; its closure is unknown and its TMPDIR ${tmp} is retained`)
          }
        }
        const outcome = await finished
        if (outcome.cleanupError) throw new Error(`CLI child ${child.pid} ${outcome.closure}, but its TMPDIR ${tmp} could not be removed: ${outcome.cleanupError}`)
      },
      signal: name => {
        if (finalizing || hasExited()) throw new Error('The CLI child has already exited')
        if (!child.kill(name)) throw new Error(`Could not deliver ${name} to the CLI child`)
        signals.push(name)
      },
      liveEvents: () => readLiveEvents(eventLog),
    }
    activeRuns.add(run)
    if (child.pid !== undefined) liveChildren.add(run)
    return run
  } catch (error) {
    return failAndRemove(tmp, error)
  }
}

export async function runPublishCli(repo: CollectorRepo, options: Parameters<typeof startPublishCli>[1]): Promise<CliOutcome> {
  return (await startPublishCli(repo, options)).finished
}
