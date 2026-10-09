import { execFile, spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { accessSync, constants, existsSync, lstatSync, readFileSync } from 'node:fs'
import type { Dirent } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'
import { APPROVED_CONTROL_HASHES, loadApprovedControls } from './archive'

/**
 * An isolated synthetic stage for the validation-control fault checks: the exact
 * approved control bytes copied into a throwaway `<root>/.local/research/82/`
 * tree with its own git worktree, gates, plan, verification directory and fault
 * shims on PATH (ps, pmset, claude). The real stage controls, gates, processes
 * and the real process table are never touched; failures are injected only
 * through the shims. HOME stays unchanged (the runner reads it for XDG checks).
 * Default gates require only Main/Astra and allow exactly identity/execute.
 * Only createSyntheticLegacyWrapperStage() adds a fictional third controls
 * vote and review mode for the unchanged v10 wrapper's two fake-child faults;
 * it has a separate root, no executable plan checks and no execute mode.
 * Wrapper entry points refuse every other fixture and require the exact local
 * fake-claude shim before spawning. No synthetic vote is a real model review.
 *
 * Ownership (MCTRL82-1/2, MCTRR82-1, MCTRR82-R6/R7): everything this fixture
 * acquires is retained from acquisition in small in-memory records. Every direct
 * control command keeps its handle and outcome (a ChildProcess `error` is a
 * diagnostic; only an observed close, or a confirmed failure to create any
 * child, settles it); every validation run is tracked by name with its
 * controller identity (the dispatch line's workerPid or the receipt's own
 * workerPid, cross-checked), and runs owned by this fixture's actor that were
 * never recorded (a partial dispatch, an inner recursive run) are reconciled
 * from their request/receipt JSON. The finite synthetic model child of every
 * review wrapper is owned through the wrapper's label and process receipt. The
 * deliberately escaped synthetic process is owned through its unpredictable
 * per-run marker from the moment its run is known. `settle()` attempts each
 * obligation independently: it stops and boundedly joins whatever is still
 * active through the controller protocol, confirms the finite owned process set
 * with non-faulted `/bin/ps` metadata, and closes the escaped processes only
 * after rechecking their birth, group, ancestry and marker immediately before
 * each signal. Legitimate startup absence (a receipt not written yet) is
 * distinct from unreadable or malformed metadata, an unreadable directory, an
 * unparseable successful ps or an unknown controller: those are reported as
 * unknown, never as gone, and the stage directory is removed only after a
 * settlement without errors; otherwise it is kept as evidence and every error is
 * reported. Nothing is ever signalled by a remembered numeric PID alone.
 *
 * Fault counters (MCTRL82-3, MCTRR82-R8): the ps shim's call counter is reset at
 * every scenario boundary and every call is appended to a phase log with its
 * mode, so a scenario can prove which calls ran healthy and which ran under the
 * injected fault. Fault modes are published atomically (temporary file plus
 * rename), so a shim never reads a transient empty mode. The pmset shim appends
 * one synthetic sleep event whose timestamp the test captured while its
 * application was held alive (MCTRR82-2); a held synthetic application exits only
 * when the test writes its release flag (MCTRR82-4).
 */
const execFileAsync = promisify(execFile)
const GIT_TIMEOUT_MS = 30_000
const METADATA_TIMEOUT_MS = 10_000
const TERMINAL = new Set(['complete', 'failed', 'cancelled'])
/** File a held synthetic application polls for inside its run directory (plan env `{run}/release.flag`). */
export const RELEASE_FLAG = 'release.flag'
const METADATA_ENV = { ...process.env, TZ: 'UTC', LC_ALL: 'C' }
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

export interface PlanCheck { args: string[]; timeoutSeconds: number; env?: Record<string, string>; ports?: number[] }
export interface Receipt {
  status: string
  pid?: number
  workerPid?: number
  args?: string[]
  exitCode?: number | null
  error?: string | null
  errors?: { phase: string; error: string }[]
  cleanup?: Record<string, unknown>
  powerCleanup?: Record<string, unknown>
  powerProcesses?: unknown[]
  cancelled?: boolean
  applicationBeganAt?: string
  [key: string]: unknown
}
export interface CommandResult { code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string; timedOut: boolean }
/** A direct control command owned from spawn: its outcome is retained whether it succeeded, failed, was parsed or timed out. */
export interface CommandHandle {
  readonly label: string
  readonly pid: number | undefined
  /** Resolves with the exit outcome and never rejects; a confirmed spawn failure is a null code with the error text in stderr. */
  readonly done: Promise<CommandResult>
  /** True only after the observed close (or a confirmed failure to create any child); a ChildProcess `error` alone does not settle. */
  readonly settled: boolean
  readonly result: CommandResult | null
  /** ChildProcess `error` events (signal delivery, spawn failure): diagnostics, never by themselves proof of close. */
  readonly diagnostics: readonly string[]
  /** SIGTERM, bounded wait, SIGKILL, bounded wait (losing timers cancelled); returns the outcome, or null when the command is still running. */
  stop: () => Promise<CommandResult | null>
}
/** One process-table row read with non-faulted `/bin/ps` under TZ=UTC/LC_ALL=C, matching the v8 snapshot identity fields. */
export interface ProcessIdentity { pid: number; ppid: number; pgid: number; started: string; startedEpoch: number; command: string }
export interface EscapeClosure {
  marker: string
  found: ProcessIdentity[]
  terminated: { pid: number; signals: string[]; gone: boolean }[]
  errors: string[]
  /** True only when discovery succeeded and every bound process is observed gone; unknown identity or metadata never counts as closed. */
  closed: boolean
}
export interface SettleReport {
  stoppedCommands: { label: string; pid: number | undefined; result: CommandResult | null }[]
  adoptedRuns: string[]
  cancelledRuns: string[]
  joined: { run: string; status: string; controllerPid: number | null; controllerGone: boolean | null }[]
  wrappers: { label: string; state: 'confirmed' | 'no-child' | 'running' | 'unknown' }[]
  escapes: EscapeClosure[]
  processes: { scope: string; pid: number; role: string; gone: boolean; detail: string }[]
  errors: string[]
}
export interface CleanupReport extends SettleReport { removed: boolean }
export interface StageOptions {
  /** The unpredictable marker an application of this check leaves on its escaped process, or null when the check cannot escape. */
  escapeMarker?: (run: string, check: string) => string | null
}

const PS_SHIM = `#!/bin/sh
# Stage82 fault shim: count calls, log the phase, inject the configured ps failure or delay, then run the real ps unchanged.
dir="$ORBIT_FAULT_DIR"
count=$(cat "$dir/ps.count" 2>/dev/null || echo 0)
count=$((count + 1))
printf '%s' "$count" > "$dir/ps.count"
mode=$(cat "$dir/ps.mode" 2>/dev/null || echo ok)
printf '%s %s\\n' "$count" "$mode" >> "$dir/ps.log"
case "$mode" in
  fail) echo "synthetic ps failure" >&2; exit 1 ;;
  fail-after:*) if [ "$count" -gt "\${mode#fail-after:}" ]; then echo "synthetic ps failure" >&2; exit 1; fi ;;
  fail-count:*) left=\${mode#fail-count:}; if [ "$left" -gt 0 ]; then printf 'fail-count:%s' "$((left - 1))" > "$dir/ps.mode"; echo "synthetic ps failure" >&2; exit 1; else printf 'ok' > "$dir/ps.mode"; fi ;;
  fail-when-ready) if [ -f "$dir/claude.ready" ]; then echo "synthetic ps failure" >&2; exit 1; fi ;;
  delay:*) sleep "\${mode#delay:}" ;;
esac
exec /bin/ps "$@"
`
const PMSET_SHIM = `#!/bin/sh
# Stage82 fault shim: real pmset, except that the power log can gain one synthetic sleep event whose timestamp the test captured while its application was held alive.
mode=$(cat "$ORBIT_FAULT_DIR/pmset.mode" 2>/dev/null || echo real)
if [ "$1" = "-g" ] && [ "$2" = "log" ] && [ "$mode" = "sleep-event" ]; then
  /usr/bin/pmset -g log
  cat "$ORBIT_FAULT_DIR/pmset.event"
  exit 0
fi
exec /usr/bin/pmset "$@"
`
const CLAUDE_SHIM = `#!/bin/sh
# Stage82 fault shim standing in for the model CLI: one terminal JSON result, a readiness marker, then it lingers until signalled.
printf '%s\\n' '{"type":"result","is_error":false,"result":"synthetic review","modelUsage":{"claude-fable-5-1":{"inputTokens":1}}}'
: > "$ORBIT_FAULT_DIR/claude.ready"
exec /bin/sleep 300
`
const SYNTHETIC_DESIGN = '# Synthetic design document for the stage82 control fault checks\n\nThis file stands in for docs/design/cloudflare-deployment.md inside an isolated copy. It carries no product content.\n'
const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const participants = (vote: Record<string, unknown>) => ({ main: { ...vote }, astra: { ...vote } })
/** pmset's own timestamp format for the synthetic event, rendered in UTC. */
export function pmsetTimestamp(epochMs: number): string {
  const iso = new Date(epochMs).toISOString()
  return `${iso.slice(0, 10)} ${iso.slice(11, 19)} +0000`
}
/** Race a promise against a bound whose losing timer is cleared; true when the promise settled first. */
export async function settledWithin(work: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined
  const expired = new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), ms) })
  try {
    return await Promise.race([work.then(() => true as const, () => true as const), expired])
  } finally {
    clearTimeout(timer)
  }
}
/** Publish a shim-read file atomically (temporary file plus rename), so a concurrent shim never reads a transient empty value. */
async function publishFile(file: string, text: string): Promise<void> {
  const temporary = `${file}.${process.pid}.tmp`
  await writeFile(temporary, text)
  await rename(temporary, file)
}
type JsonRead = { state: 'present'; value: Record<string, unknown> } | { state: 'absent' } | { state: 'invalid'; error: string }
/** Read a JSON object file: absent (ENOENT) is legitimate while polling; unreadable or malformed content is unknown metadata, never silently null. */
async function readJsonFile(file: string): Promise<JsonRead> {
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? { state: 'absent' } : { state: 'invalid', error: String(error) }
  }
  try {
    const value = JSON.parse(text) as unknown
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? { state: 'present', value: value as Record<string, unknown> } : { state: 'invalid', error: 'not a JSON object' }
  } catch (error) {
    return { state: 'invalid', error: String(error) }
  }
}

interface EscapeRecord { marker: string; run: string; closure: EscapeClosure | null }
interface WrapperRecord { label: string; handle: CommandHandle; confirmed: boolean }
type FixturePolicy = 'identity-execute' | 'synthetic-legacy-wrapper'

export interface SyntheticStage {
  readonly policy: FixturePolicy
  root: string
  control: string
  stage: string
  worktree: string
  verification: string
  shims: string
  faultDir: string
  actor: string
  sourceDigest: string
  planSha256: string
  env: (extra?: Record<string, string>) => NodeJS.ProcessEnv
  /** Publish the ps shim mode atomically. */
  setPsMode: (mode: string) => Promise<void>
  setPmsetMode: (mode: 'real' | 'sleep-event') => Promise<void>
  /** Arm the synthetic sleep event at an actual captured instant; returns the exact log line the shim will append after the real log. */
  setPmsetEvent: (epochMs: number) => Promise<string>
  psCalls: () => Promise<number>
  /** `<count> <mode>` per ps call since the last reset. */
  psLog: () => Promise<string[]>
  /** Whether the synthetic model child has printed its result and touched its readiness marker. */
  modelReady: () => boolean
  /** Scenario boundary: zero the ps counter, clear its log, the model-shim readiness marker and the synthetic power event. */
  resetFaults: () => Promise<void>
  identity: (args: string[]) => Promise<CommandResult>
  runner: (args: string[], timeoutMs?: number) => Promise<CommandResult>
  /** Synthetic legacy fixture only; refuses before spawn in the default identity/execute fixture. */
  wrapper: (args: string[], timeoutMs?: number) => Promise<CommandResult>
  /** Start the synthetic legacy review wrapper without waiting; the handle and its fake child are owned from spawn and settled by settle(). */
  wrapperStart: (args: string[], timeoutMs?: number) => CommandHandle
  start: (check: string) => Promise<{ run: string; workerPid: number }>
  /** Own a run this fixture's actor requested but did not dispatch here (an inner recursive run); its controller identity comes from its receipt. */
  adopt: (run: string) => Promise<{ run: string; controllerPid: number | null }>
  cancel: (run: string) => Promise<CommandResult>
  /** The run receipt: null while it does not exist yet; an unreadable or malformed receipt throws (unknown metadata). */
  receipt: (run: string) => Promise<Receipt | null>
  waitFor: (run: string, predicate: (receipt: Receipt) => boolean, timeoutMs?: number) => Promise<Receipt>
  waitTerminal: (run: string, timeoutMs?: number) => Promise<Receipt>
  runFile: (run: string, name: string) => Promise<string | null>
  /** Let a held synthetic application exit by writing its release flag. */
  release: (run: string) => Promise<void>
  /** Runs this stage started or adopted; settle() joins each through its controller. */
  runs: ReadonlySet<string>
  /** Every direct control command spawned by this fixture, with its retained outcome. */
  commands: readonly CommandHandle[]
  /** Markers of escaped synthetic processes this fixture owns (registered when their run became known). */
  ownedEscapes: () => string[]
  /** Close one owned escaped process now by rechecked identity; also performed by settle() for anything still open. */
  closeEscaped: (marker: string) => Promise<EscapeClosure>
  /** Quiesce: stop/join running commands, reconcile actor-owned runs, cancel/join the non-terminal ones, confirm controllers, owned processes and wrapper model children gone, close escapes; every step independent. */
  settle: () => Promise<SettleReport>
  /** settle(), then remove the stage only when every owned resource is confirmed closed. */
  cleanup: () => Promise<CleanupReport>
}

export async function createSyntheticStage(checks: Record<string, PlanCheck>, options: StageOptions = {}): Promise<SyntheticStage> {
  return createStage(checks, options, 'identity-execute')
}

/** Isolated compatibility fixture for the two unchanged v10 fake-wrapper faults; never a real Fable call or approval. */
export async function createSyntheticLegacyWrapperStage(): Promise<SyntheticStage> {
  return createStage({}, {}, 'synthetic-legacy-wrapper')
}

async function createStage(checks: Record<string, PlanCheck>, options: StageOptions, policy: FixturePolicy): Promise<SyntheticStage> {
  if (existsSync(path.join(os.homedir(), '.wrangler'))) {
    throw new Error('Precondition: the approved runner refuses a legacy ~/.wrangler directory, so the fault checks cannot exercise launches on this machine until it is moved aside (HOME is never changed by the harness).')
  }
  const sources = await loadApprovedControls()
  const root = await mkdtemp(path.join(os.tmpdir(), 'orbit-controls-faults-'))
  const commands: CommandHandle[] = []
  const wrappers: WrapperRecord[] = []
  const runs = new Set<string>()
  const runChecks = new Map<string, string>()
  const controllers = new Map<string, number>()
  const controllersGone = new Set<string>()
  const confirmedRuns = new Set<string>()
  const escapes = new Map<string, EscapeRecord>()
  let stage!: SyntheticStage
  try {
    const stageDirectory = path.join(root, '.local/research/82')
    const control = path.join(stageDirectory, 'collaboration')
    const worktree = path.join(stageDirectory, 'worktree')
    const verification = path.join(stageDirectory, 'verification')
    const repo = path.join(stageDirectory, 'repo')
    const shims = path.join(root, 'shims')
    const faultDir = path.join(root, 'faults')
    for (const directory of [control, verification, repo, shims, faultDir, path.join(stageDirectory, 'tmp'), path.join(stageDirectory, 'runtime')]) await mkdir(directory, { recursive: true })
    for (const [name, text] of Object.entries(sources)) await writeFile(path.join(control, name), text)
    for (const [name, text] of [['ps', PS_SHIM], ['pmset', PMSET_SHIM], ['claude', CLAUDE_SHIM]] as const) await writeFile(path.join(shims, name), text, { mode: 0o755 })
    await writeFile(path.join(faultDir, 'ps.mode'), 'ok')
    await writeFile(path.join(faultDir, 'pmset.mode'), 'real')
    await writeFile(path.join(faultDir, 'ps.count'), '0')
    await writeFile(path.join(faultDir, 'ps.log'), '')
    // A real git repository plus a linked worktree, so `.git` is the gitfile the identity control requires.
    const gitEnv = {
      PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'Orbit Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.com', GIT_COMMITTER_NAME: 'Orbit Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.com',
      GIT_TERMINAL_PROMPT: '0', LANG: 'C',
    }
    const git = (cwd: string, ...args: string[]) => execFileAsync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', env: gitEnv, timeout: GIT_TIMEOUT_MS, killSignal: 'SIGKILL' })
    await git(repo, 'init', '-q', '-b', 'main')
    await mkdir(path.join(repo, 'docs/design'), { recursive: true })
    await mkdir(path.join(repo, 'tests'), { recursive: true })
    await writeFile(path.join(repo, 'docs/design/cloudflare-deployment.md'), SYNTHETIC_DESIGN)
    await writeFile(path.join(repo, 'package.json'), '{"name":"synthetic-stage82-fault-fixture","private":true}\n')
    await writeFile(path.join(repo, 'tests/README.txt'), 'Synthetic worktree for control fault checks.\n')
    await git(repo, 'add', '-A')
    await git(repo, 'commit', '-q', '-m', 'Synthetic fixture')
    await git(repo, 'worktree', 'add', '--detach', worktree, 'HEAD')
    const actor = `${'0123456789abcdef0123456789abcdef'.replace(/^(.{8})(.{4})(.{4})(.{4})(.{12}).*$/, '$1-$2-$3-$4-$5')}|controls-faults`
    const env = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({
      ...process.env, PATH: `${shims}${path.delimiter}${process.env.PATH ?? ''}`, ORBIT_VERIFICATION_ACTOR: actor,
      ORBIT_FAULT_DIR: faultDir, PYTHONDONTWRITEBYTECODE: '1', ...extra,
    })
    /** Spawn one control command and own it from this moment: the handle, its PID, its diagnostics and its outcome stay in `commands`. */
    const spawnCommand = (label: string, file: string, args: string[], timeoutMs: number, extra: Record<string, string> = {}): CommandHandle => {
      let child: ChildProcess | undefined
      let result: CommandResult | null = null
      let timer: NodeJS.Timeout | undefined
      let timedOut = false
      const diagnostics: string[] = []
      const done = new Promise<CommandResult>(resolve => {
        const stdout: Buffer[] = []
        const stderr: Buffer[] = []
        const finish = (code: number | null, signal: NodeJS.Signals | null, failure?: unknown) => {
          if (result) return
          clearTimeout(timer)
          result = { code, signal, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') + (failure === undefined ? '' : String(failure)), timedOut }
          resolve(result)
        }
        try {
          child = spawn('python3', [file, ...args], { cwd: root, env: env(extra), stdio: ['ignore', 'pipe', 'pipe'] })
        } catch (error) {
          diagnostics.push(String(error))
          finish(null, null, error)
          return
        }
        child.stdout!.on('data', (chunk: Buffer) => stdout.push(chunk))
        child.stderr!.on('data', (chunk: Buffer) => stderr.push(chunk))
        child.on('error', error => {
          diagnostics.push(String(error))
          // Only a failed spawn (no pid, so no child exists) is a confirmed terminal state; otherwise the observed close decides.
          if (child?.pid === undefined) finish(null, null, error)
        })
        child.on('close', (code, signal) => finish(code, signal))
        timer = setTimeout(() => { timedOut = true; child?.kill('SIGKILL') }, timeoutMs)
      })
      const handle: CommandHandle = {
        label,
        get pid() { return child?.pid },
        done,
        get settled() { return result !== null },
        get result() { return result },
        diagnostics,
        stop: async () => {
          if (result) return result
          for (const [signal, waitMs] of [['SIGTERM', 15_000], ['SIGKILL', 5_000]] as const) {
            child?.kill(signal)
            if (await settledWithin(done, waitMs)) return result
          }
          return result
        },
      }
      commands.push(handle)
      return handle
    }
    const command = (label: string, file: string, args: string[], timeoutMs = 60_000, extra: Record<string, string> = {}) => spawnCommand(label, file, args, timeoutMs, extra).done
    const runnerPath = path.join(control, 'run-validation.py')
    const wrapperPath = path.join(control, 'run-review.py')
    const identity = (args: string[]) => command(`identity ${args.join(' ')}`, path.join(control, 'stage-identity.py'), args)
    const runner = (args: string[], timeoutMs?: number) => command(`runner ${args.join(' ')}`, runnerPath, args, timeoutMs)
    /** The wrapper's finite model child is owned through the wrapper label and its process receipt from acquisition (MCTRR82-R6). */
    const startWrapper = (args: string[], timeoutMs: number): CommandHandle => {
      if (policy !== 'synthetic-legacy-wrapper' || args.length !== 3 || args[0] !== 'review') {
        throw new Error('Wrapper calls require the isolated synthetic legacy fixture in review mode')
      }
      // Refuse before spawning if the shim was removed, replaced, linked or made non-executable; never fall through to a real model CLI on PATH.
      const shim = path.join(shims, 'claude')
      const metadata = lstatSync(shim)
      if (!metadata.isFile() || !(metadata.mode & 0o111) || readFileSync(shim, 'utf8') !== CLAUDE_SHIM) {
        throw new Error('The exact executable synthetic model shim is required')
      }
      accessSync(shim, constants.X_OK)
      const handle = spawnCommand(`wrapper ${args.join(' ')}`, wrapperPath, args, timeoutMs)
      const label = args[1]
      if (typeof label === 'string' && /^[A-Za-z0-9-]+$/.test(label)) wrappers.push({ label, handle, confirmed: false })
      return handle
    }
    const wrapper = (args: string[], timeoutMs = 120_000) => startWrapper(args, timeoutMs).done
    const designSha256 = sha256(SYNTHETIC_DESIGN)
    const controlVote = { decision: 'CONTROLS_APPROVED', controlHashes: APPROVED_CONTROL_HASHES }
    const controlsGate = {
      stage: 82, version: policy, decision: 'CONTROLS_APPROVED',
      allowedModes: policy === 'synthetic-legacy-wrapper' ? ['identity', 'review'] : ['identity', 'execute'], requiredIssues: [],
      controlHashes: APPROVED_CONTROL_HASHES,
      participants: {
        ...participants(controlVote),
        ...(policy === 'synthetic-legacy-wrapper' ? {
          fable: { ...controlVote, synthetic: true, purpose: 'Fictional legacy bootstrap vote for fake-wrapper faults only; not a model review or stage approval' },
        } : {}),
      },
    }
    await writeFile(path.join(control, 'controls-gate.json'), JSON.stringify(controlsGate, null, 2) + '\n')
    await writeFile(path.join(control, 'design-gate.json'), JSON.stringify({ designSha256, requiredIssues: [], participants: participants({ decision: 'DESIGN_APPROVED', designSha256 }) }, null, 2) + '\n')
    const identityResult = await identity([])
    if (identityResult.code !== 0) throw new Error(`Synthetic identity failed: ${identityResult.stderr}`)
    const sourceDigest = (JSON.parse(identityResult.stdout) as { contentDigest: string }).contentDigest
    const planText = JSON.stringify({ version: 1, checks }, null, 2) + '\n'
    await writeFile(path.join(control, 'execution-plan.json'), planText)
    const planSha256 = sha256(planText)
    await writeFile(path.join(control, 'source-gate.json'), JSON.stringify({
      decision: 'IMPLEMENTATION_APPROVED', requiredIssues: [], sourceDigest, planSha256,
      participants: participants({ decision: 'IMPLEMENTATION_APPROVED', sourceDigest, planSha256 }),
    }, null, 2) + '\n')
    if (policy === 'synthetic-legacy-wrapper') {
      await writeFile(path.join(control, 'faults-review.prompt.txt'), 'Synthetic prompt for the wrapper fault checks.\n')
      await writeFile(path.join(control, 'faults-review-x1.prompt.txt'), 'Synthetic prompt for the wrapper fault checks (observer construction failure).\n')
    }
    const receipt = async (run: string): Promise<Receipt | null> => {
      const read = await readJsonFile(path.join(verification, run, 'receipt.json'))
      if (read.state === 'present') return read.value as Receipt
      if (read.state === 'absent') return null
      throw new Error(`receipt.json of run ${run} is unreadable or malformed: ${read.error}`)
    }
    const waitFor = async (run: string, predicate: (receipt: Receipt) => boolean, timeoutMs = 60_000): Promise<Receipt> => {
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        const current = await receipt(run)
        if (current && predicate(current)) return current
        await delay(100)
      }
      const last = await receipt(run).then(current => JSON.stringify(current), error => String(error))
      throw new Error(`Run ${run} did not reach the expected state within ${timeoutMs} ms: ${last}`)
    }
    const waitTerminal = (run: string, timeoutMs = 120_000) => waitFor(run, current => TERMINAL.has(current.status), timeoutMs)
    /** Record a run as owned, with whatever identity is known now; the escaped marker of an escaping check is owned at the same moment. */
    const own = (run: string, check: string | null, controllerPid?: number) => {
      runs.add(run)
      if (check) runChecks.set(run, check)
      if (controllerPid !== undefined && !controllers.has(run)) controllers.set(run, controllerPid)
      const marker = check ? options.escapeMarker?.(run, check) ?? null : null
      if (marker && !escapes.has(marker)) escapes.set(marker, { marker, run, closure: null })
    }
    const adopt = async (run: string) => {
      const request = await readJsonFile(path.join(verification, run, 'request.json'))
      if (request.state !== 'present') throw new Error(`run ${run} has no readable request.json (${request.state === 'invalid' ? request.error : 'absent'})`)
      if (request.value.actor !== actor) throw new Error(`run ${run} is not owned by this fixture actor`)
      const current = await receipt(run)
      own(run, typeof request.value.check === 'string' ? request.value.check : null, typeof current?.workerPid === 'number' ? current.workerPid : undefined)
      return { run, controllerPid: controllers.get(run) ?? null }
    }
    /** Every run this actor requested becomes owned (partial dispatches, inner runs); unreadable directories or metadata are reported as unknown, never as an empty set. */
    const reconcile = async (report: SettleReport) => {
      let entries: Dirent[]
      try {
        entries = await readdir(verification, { withFileTypes: true })
      } catch (error) {
        report.errors.push(`reconciliation: the verification directory is unreadable, so owned runs are unknown: ${String(error)}`)
        return
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        const run = entry.name
        try {
          const request = await readJsonFile(path.join(verification, run, 'request.json'))
          if (request.state === 'invalid') {
            report.errors.push(`reconciliation: request.json of run directory ${run} is unreadable or malformed: ${request.error}`)
            continue
          }
          if (request.state === 'absent') {
            if (!runs.has(run)) report.errors.push(`reconciliation: run directory ${run} has no request.json; its origin and closure are unknown`)
            continue
          }
          if (request.value.actor !== actor) continue
          if (!runs.has(run)) report.adoptedRuns.push(run)
          let controllerPid: number | undefined
          if (!controllers.has(run)) {
            const current = await receipt(run)
            if (typeof current?.workerPid === 'number') controllerPid = current.workerPid
          }
          own(run, typeof request.value.check === 'string' ? request.value.check : null, controllerPid)
        } catch (error) {
          report.errors.push(`reconciliation: run directory ${run}: ${String(error)}`)
        }
      }
    }
    /** Independent confirmation that owned processes are gone; a live PID counts as gone only when its recorded birth proves OS reuse. */
    const confirmGone = async (scope: string, owned: { pid: number; role: string; started?: string }[], beganEpoch: number | null): Promise<SettleReport['processes']> => {
      const outcomes: SettleReport['processes'] = []
      for (const item of owned) {
        let identity: ProcessIdentity | null
        try {
          identity = await processIdentity(item.pid)
        } catch (error) {
          outcomes.push({ scope, pid: item.pid, role: item.role, gone: false, detail: `metadata unavailable, closure unknown: ${String(error)}` })
          continue
        }
        if (identity === null) {
          outcomes.push({ scope, pid: item.pid, role: item.role, gone: true, detail: 'absent' })
          continue
        }
        const reused = item.started !== undefined ? identity.started !== item.started
          : item.role === 'application' && beganEpoch !== null ? Math.abs(identity.startedEpoch - beganEpoch) > 3
          : null
        if (reused === true) outcomes.push({ scope, pid: item.pid, role: item.role, gone: true, detail: `pid reused by an unrelated process (${identity.command})` })
        else outcomes.push({ scope, pid: item.pid, role: item.role, gone: false, detail: reused === null ? `alive and birth unknown, closure not established (${identity.command})` : `still alive (${identity.command})` })
      }
      return outcomes
    }
    const closeEscaped = async (marker: string): Promise<EscapeClosure> => {
      const record = escapes.get(marker)
      if (!record) throw new Error(`escape marker ${marker} is not owned by this fixture`)
      if (record.closure?.closed) return record.closure
      record.closure = await terminateByMarker(marker)
      return record.closure
    }
    const settle = async (): Promise<SettleReport> => {
      const report: SettleReport = { stoppedCommands: [], adoptedRuns: [], cancelledRuns: [], joined: [], wrappers: [], escapes: [], processes: [], errors: [] }
      // 1. Direct commands still running (a case that failed early) are stopped through their own handles and boundedly joined; each independently.
      for (const handle of commands) {
        if (handle.settled) continue
        try {
          const result = await handle.stop()
          report.stoppedCommands.push({ label: handle.label, pid: handle.pid, result })
          if (!handle.settled) report.errors.push(`command "${handle.label}" (pid ${handle.pid}) did not close after SIGTERM and SIGKILL; its closure is unknown`)
        } catch (error) {
          report.errors.push(`command "${handle.label}": stop failed: ${String(error)}`)
        }
      }
      // 2. Every actor-owned run is owned (reconcile records its own errors), then joined through the controller protocol: cancel, terminal receipt, controller gone.
      await reconcile(report)
      for (const run of runs) {
        try {
          let current = await receipt(run)
          if (!current || !TERMINAL.has(current.status)) {
            const cancelled = await runner(['cancel', run])
            if (cancelled.code !== 0) report.errors.push(`cancel ${run} exited ${cancelled.code}: ${cancelled.stderr.trim()}`)
            current = await waitTerminal(run, 60_000).catch(error => { report.errors.push(String(error)); return null })
            if (current) report.cancelledRuns.push(run)
          }
          if (current && typeof current.workerPid === 'number') {
            const known = controllers.get(run)
            if (known === undefined) controllers.set(run, current.workerPid)
            else if (known !== current.workerPid) report.errors.push(`run ${run}: dispatched controller ${known} differs from the receipt's workerPid ${current.workerPid}`)
          }
          const controllerPid = controllers.get(run)
          let controllerGone: boolean | null = null
          if (controllerPid === undefined) {
            report.errors.push(`run ${run}: controller identity unknown, so its disappearance is not established`)
          } else if (controllersGone.has(run)) {
            controllerGone = true
          } else {
            controllerGone = await waitGone(controllerPid, 15_000)
            if (controllerGone) controllersGone.add(run)
            else report.errors.push(`controller ${controllerPid} of run ${run} is still alive after its terminal receipt`)
          }
          report.joined.push({ run, status: current?.status ?? 'unknown', controllerPid: controllerPid ?? null, controllerGone })
          // 3. A terminal receipt (including one that deliberately reports unknown closure) does not prove its processes are gone; confirm independently.
          if (current && TERMINAL.has(current.status) && !confirmedRuns.has(run)) {
            const beganAt = typeof current.applicationBeganAt === 'string' ? current.applicationBeganAt.replace(/(\.\d{3})\d+/, '$1') : ''
            const beganEpoch = Number.isFinite(Date.parse(beganAt)) ? Date.parse(beganAt) / 1000 : null
            const outcomes = await confirmGone(run, ownedProcessesOf(current), beganEpoch)
            report.processes.push(...outcomes)
            for (const outcome of outcomes) if (!outcome.gone) report.errors.push(`run ${run}: ${outcome.role} pid ${outcome.pid} ${outcome.detail}`)
            if (outcomes.every(outcome => outcome.gone)) confirmedRuns.add(run)
          }
        } catch (error) {
          report.errors.push(`${run}: ${String(error)}`)
        }
      }
      // 4. Every wrapper's finite model child is accounted for through the wrapper's own process receipt, whether or not the case reached its assertions.
      for (const record of wrappers) {
        if (record.confirmed) continue
        try {
          if (!record.handle.settled) {
            report.wrappers.push({ label: record.label, state: 'running' })
            report.errors.push(`wrapper ${record.label} (pid ${record.handle.pid}) has not closed; its model child closure is unknown`)
            continue
          }
          const read = await readJsonFile(path.join(control, `${record.label}.process.json`))
          if (read.state !== 'present') {
            report.wrappers.push({ label: record.label, state: 'unknown' })
            report.errors.push(read.state === 'absent' ? `wrapper ${record.label} left no process receipt; its model child closure is unknown` : `wrapper ${record.label} process receipt unreadable: ${read.error}`)
            continue
          }
          const wrapperReceipt = read.value
          if (wrapperReceipt.processStatus === 'running') {
            report.wrappers.push({ label: record.label, state: 'unknown' })
            report.errors.push(`wrapper ${record.label} receipt is not terminal; its model child closure is unknown`)
            continue
          }
          const processCleanup = wrapperReceipt.processCleanup as Record<string, unknown> | undefined
          const pids = [...new Set([wrapperReceipt.pid, processCleanup?.directChildPid].filter((value): value is number => Number.isSafeInteger(value) && (value as number) > 0))]
          if (!pids.length) {
            if (processCleanup?.closureKnown === true && wrapperReceipt.pid === null) {
              record.confirmed = true
              report.wrappers.push({ label: record.label, state: 'no-child' })
            } else {
              report.wrappers.push({ label: record.label, state: 'unknown' })
              report.errors.push(`wrapper ${record.label} receipt names no model child pid and reports no known closure`)
            }
            continue
          }
          const outcomes = await confirmGone(`wrapper:${record.label}`, pids.map(pid => ({ pid, role: 'model-child' })), null)
          report.processes.push(...outcomes)
          for (const outcome of outcomes) if (!outcome.gone) report.errors.push(`wrapper ${record.label}: model child pid ${outcome.pid} ${outcome.detail}`)
          if (outcomes.every(outcome => outcome.gone)) {
            record.confirmed = true
            report.wrappers.push({ label: record.label, state: 'confirmed' })
          } else {
            report.wrappers.push({ label: record.label, state: 'unknown' })
          }
        } catch (error) {
          report.errors.push(`wrapper ${record.label}: ${String(error)}`)
        }
      }
      // 5. Escaped synthetic processes are closed by rechecked identity; a metadata exception leaves the escape unknown and never skips the others.
      for (const record of escapes.values()) {
        if (record.closure?.closed) continue
        try {
          const closure = await closeEscaped(record.marker)
          report.escapes.push(closure)
          report.errors.push(...closure.errors.map(error => `escape ${record.marker}: ${error}`))
        } catch (error) {
          report.errors.push(`escape ${record.marker}: ${String(error)}; closure unknown`)
        }
      }
      return report
    }
    const cleanup = async (): Promise<CleanupReport> => {
      const report: CleanupReport = { ...await settle(), removed: false }
      // Closure unknown or incomplete: keep the stage as evidence and report; never sweep by PID.
      if (report.errors.length) return report
      try {
        await rm(root, { recursive: true, force: true })
        report.removed = true
      } catch (error) {
        report.errors.push(`remove ${root}: ${String(error)}`)
      }
      return report
    }
    stage = {
      policy, root, control, stage: stageDirectory, worktree, verification, shims, faultDir, actor, sourceDigest, planSha256, env, runs, commands,
      setPsMode: mode => publishFile(path.join(faultDir, 'ps.mode'), mode),
      setPmsetMode: mode => publishFile(path.join(faultDir, 'pmset.mode'), mode),
      setPmsetEvent: async epochMs => {
        const line = `${pmsetTimestamp(epochMs)} Sleep               Entering Sleep state due to 'Synthetic fault check'`
        await publishFile(path.join(faultDir, 'pmset.event'), `${line}\n`)
        await publishFile(path.join(faultDir, 'pmset.mode'), 'sleep-event')
        return line
      },
      psCalls: async () => Number(await readFile(path.join(faultDir, 'ps.count'), 'utf8')),
      psLog: async () => (await readFile(path.join(faultDir, 'ps.log'), 'utf8')).split('\n').filter(Boolean),
      modelReady: () => existsSync(path.join(faultDir, 'claude.ready')),
      resetFaults: async () => {
        await writeFile(path.join(faultDir, 'ps.count'), '0')
        await writeFile(path.join(faultDir, 'ps.log'), '')
        await rm(path.join(faultDir, 'claude.ready'), { force: true })
        await rm(path.join(faultDir, 'pmset.event'), { force: true })
      },
      identity, runner, wrapper,
      wrapperStart: (args, timeoutMs = 120_000) => startWrapper(args, timeoutMs),
      start: async check => {
        // The handle outlives a failed or unparsable dispatch; a run whose request was written anyway is reconciled by settle().
        const result = await spawnCommand(`runner start ${check}`, runnerPath, ['start', check], 60_000).done
        if (result.code !== 0) throw new Error(`start ${check} failed (code ${result.code}${result.timedOut ? ', timed out' : ''}): ${result.stderr}`)
        let dispatched: { run: string; workerPid: number }
        try {
          dispatched = JSON.parse(result.stdout.trim().split('\n').at(-1)!) as { run: string; workerPid: number }
          if (typeof dispatched.run !== 'string' || !Number.isSafeInteger(dispatched.workerPid) || dispatched.workerPid <= 0) throw new Error('the dispatch line lacks run/workerPid')
        } catch (error) {
          throw new Error(`start ${check} returned an unparsable dispatch (${String(error)}): ${result.stdout}`)
        }
        own(dispatched.run, check, dispatched.workerPid)
        return dispatched
      },
      adopt,
      cancel: run => runner(['cancel', run]),
      receipt,
      waitFor,
      waitTerminal,
      runFile: async (run, name) => readFile(path.join(verification, run, name), 'utf8').catch(() => null),
      release: async run => { await writeFile(path.join(verification, run, RELEASE_FLAG), '') },
      ownedEscapes: () => [...escapes.keys()],
      closeEscaped,
      settle,
      cleanup,
    }
    return stage
  } catch (error) {
    // Setup failed before any run existed: remove the partial tree, keeping both errors if that fails too.
    try {
      await rm(root, { recursive: true, force: true })
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], `Synthetic stage setup and cleanup failed at ${root}`)
    }
    throw error
  }
}

/** The processes a receipt names as owned by its run, with the recorded birth where the v8 snapshot supplied one. */
function ownedProcessesOf(current: Receipt): { pid: number; role: string; started?: string }[] {
  const owned: { pid: number; role: string; started?: string }[] = []
  const add = (pid: unknown, role: string, started?: unknown) => {
    if (!Number.isSafeInteger(pid) || (pid as number) <= 0) return
    const birth = typeof started === 'string' ? started : undefined
    const existing = owned.find(item => item.pid === pid)
    if (existing) {
      if (existing.started === undefined && birth !== undefined) existing.started = birth
      return
    }
    owned.push({ pid: pid as number, role, started: birth })
  }
  add(current.pid, 'application')
  for (const section of ['cleanup', 'powerCleanup'] as const) {
    const part = current[section]
    if (!part) continue
    add(part.directChildPid, `${section}.directChildPid`)
    for (const list of ['signalled', 'forced', 'remaining'] as const) {
      const items = part[list]
      if (Array.isArray(items)) for (const item of items as { pid?: unknown; started?: unknown }[]) add(item?.pid, `${section}.${list}`, item?.started)
    }
  }
  if (Array.isArray(current.powerProcesses)) for (const item of current.powerProcesses as { pid?: unknown; started?: unknown }[]) add(item?.pid, 'powerProcesses', item?.started)
  return owned
}

/** Whether a PID exists: ESRCH means gone, EPERM means alive but foreign; anything else is an error, not a verdict. */
export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ESRCH') return false
    if (code === 'EPERM') return true
    throw error
  }
}
/** Poll until the PID is gone or the bound elapses. */
export async function waitGone(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (alive(pid)) {
    if (Date.now() >= deadline) return false
    await delay(100)
  }
  return true
}

/** One `/bin/ps -o pid=,ppid=,pgid=,lstart=,command=` row parsed the way the v8 snapshot does (birth joined with single spaces), or null when the line is not interpretable. */
function parseProcessRow(line: string): ProcessIdentity | null {
  const parts = line.trim().split(/\s+/)
  if (parts.length < 9 || !parts.slice(0, 3).every(value => /^\d+$/.test(value))) return null
  const [, month, day, clock, year] = parts.slice(3, 8)
  const monthIndex = MONTHS.indexOf(month)
  const [hours, minutes, seconds] = clock.split(':').map(Number)
  if (monthIndex < 0 || ![day, year].every(value => /^\d+$/.test(value)) || [hours, minutes, seconds].some(value => !Number.isInteger(value))) return null
  return {
    pid: Number(parts[0]), ppid: Number(parts[1]), pgid: Number(parts[2]), started: parts.slice(3, 8).join(' '),
    startedEpoch: Date.UTC(Number(year), monthIndex, Number(day), hours, minutes, seconds) / 1000, command: parts.slice(8).join(' '),
  }
}
/**
 * Parse whole-table output (MCTRR82-R6 residual). Blank lines are ignored and a
 * well-formed table without a matching row is known absence, but a nonblank line
 * that is not interpretable makes the whole table unknown: the parser throws
 * instead of silently shrinking the discovered set, so discovery reports unknown
 * metadata and the stage is retained. No positive row count is required.
 */
export function parseProcessRows(text: string): ProcessIdentity[] {
  const rows: ProcessIdentity[] = []
  const malformed: string[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    const row = parseProcessRow(line)
    if (row) rows.push(row)
    else malformed.push(line.trim().slice(0, 160))
  }
  if (malformed.length) throw new Error(`process table not interpretable: ${malformed.length} malformed row(s), e.g. ${JSON.stringify(malformed.slice(0, 3))}`)
  return rows
}
/** The whole process table through non-faulted `/bin/ps` (never the shim), bounded; throws when the metadata is unavailable. */
export async function processTable(): Promise<ProcessIdentity[]> {
  const { stdout } = await execFileAsync('/bin/ps', ['-axo', 'pid=,ppid=,pgid=,lstart=,command='], { encoding: 'utf8', env: METADATA_ENV, timeout: METADATA_TIMEOUT_MS, killSignal: 'SIGKILL', maxBuffer: 32 * 1024 * 1024 })
  return parseProcessRows(stdout)
}
/** execFile's rejection shape: `code` is the numeric exit status when the command ran, a string errno when it did not (MCTRR82-R5). */
interface ExecFileFailure extends Omit<NodeJS.ErrnoException, 'code'> { code?: number | string; killed?: boolean; stdout?: string; stderr?: string }
/**
 * One PID's identity now. Only the ordinary absent result is a verdict: `/bin/ps`
 * exited 1 with nothing on stdout or stderr and was not killed, which yields null.
 * A failed, killed or ambiguous command, or a successful ps whose output does not
 * describe the requested pid, throws: unknown metadata, never absence.
 */
export async function processIdentity(pid: number): Promise<ProcessIdentity | null> {
  let stdout: string
  try {
    stdout = (await execFileAsync('/bin/ps', ['-o', 'pid=,ppid=,pgid=,lstart=,command=', '-p', String(pid)], { encoding: 'utf8', env: METADATA_ENV, timeout: METADATA_TIMEOUT_MS, killSignal: 'SIGKILL' })).stdout
  } catch (error) {
    const failure = error as ExecFileFailure
    if (failure.code === 1 && !failure.killed && !(failure.stdout ?? '').trim() && !(failure.stderr ?? '').trim()) return null
    throw new Error(`process metadata for pid ${pid} unavailable: ${String(error)}`)
  }
  let rows: ProcessIdentity[]
  try {
    rows = parseProcessRows(stdout)
  } catch (error) {
    throw new Error(`process metadata for pid ${pid} is not interpretable: ${String(error)}`)
  }
  const row = rows.find(candidate => candidate.pid === pid)
  if (!row) throw new Error(`process metadata for pid ${pid} is not interpretable: ps exited 0 with ${JSON.stringify(stdout.trim().slice(0, 200))}`)
  return row
}
/** Find synthetic processes carrying a unique command-line token; discovery only, with full identity for later rechecks. */
export async function findByMarker(marker: string): Promise<ProcessIdentity[]> {
  return (await processTable()).filter(row => row.command.split(' ').includes(marker))
}
/**
 * Terminate the synthetic process(es) carrying an unpredictable per-run marker.
 * Each candidate must be the expected escaped shape (an orphaned session leader:
 * ppid 1, pgid equal to its pid); its birth, group, ancestry and marker are
 * re-read with non-faulted bounded metadata immediately before every signal,
 * SIGTERM first and SIGKILL only if it survives. A metadata failure, a changed
 * identity or an unexpected shape is reported and never signalled: it stays
 * unknown. Nothing here throws; every problem is in `errors`.
 */
export async function terminateByMarker(marker: string): Promise<EscapeClosure> {
  const closure: EscapeClosure = { marker, found: [], terminated: [], errors: [], closed: false }
  try {
    closure.found = await findByMarker(marker)
  } catch (error) {
    closure.errors.push(`discovery metadata unavailable: ${String(error)}`)
    return closure
  }
  for (const bound of closure.found) {
    const entry = { pid: bound.pid, signals: [] as string[], gone: false }
    closure.terminated.push(entry)
    if (bound.pgid !== bound.pid || bound.ppid !== 1) {
      closure.errors.push(`pid ${bound.pid} carries the marker but is not an orphaned session leader (ppid ${bound.ppid}, pgid ${bound.pgid}); not signalled`)
      continue
    }
    let settled = false
    try {
      for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
        let current: ProcessIdentity | null
        try {
          current = await processIdentity(bound.pid)
        } catch (error) {
          closure.errors.push(`pid ${bound.pid}: ${String(error)}; not signalled`)
          settled = true
          break
        }
        if (current === null) {
          entry.gone = true
          settled = true
          break
        }
        if (current.started !== bound.started || current.pgid !== bound.pgid || current.ppid !== 1 || !current.command.split(' ').includes(marker)) {
          closure.errors.push(`pid ${bound.pid} no longer matches the bound identity (ppid ${current.ppid}, pgid ${current.pgid}, ${current.command}); not signalled`)
          settled = true
          break
        }
        try {
          process.kill(bound.pid, signal)
          entry.signals.push(signal)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
            entry.gone = true
            settled = true
            break
          }
          closure.errors.push(`pid ${bound.pid}: ${signal} failed: ${String(error)}`)
          settled = true
          break
        }
        if (await waitGone(bound.pid, 5_000)) {
          entry.gone = true
          settled = true
          break
        }
      }
    } catch (error) {
      // alive() throws on a metadata error other than ESRCH/EPERM: the state is unknown, not gone.
      closure.errors.push(`pid ${bound.pid}: metadata error while waiting, closure unknown: ${String(error)}`)
      settled = true
    }
    if (!settled) closure.errors.push(`pid ${bound.pid} survived SIGTERM and SIGKILL`)
  }
  closure.closed = closure.errors.length === 0 && closure.terminated.every(entry => entry.gone)
  return closure
}
