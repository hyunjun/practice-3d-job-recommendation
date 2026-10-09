import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { chmod, mkdir, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { APPROVED_CONTROL_HASHES } from './archive'
import { createSyntheticLegacyWrapperStage, createSyntheticStage, findByMarker, parseProcessRows, RELEASE_FLAG, settledWithin, waitGone } from './stage'
import type { CommandResult, EscapeClosure, PlanCheck, Receipt, SyntheticStage } from './stage'

/**
 * Stage82 independent local fault checks for the exact reviewed validation
 * controls (v11 Main/Astra identity/execute map from the approved
 * main/without-fable-01/proposal-02.json, selected from the public archive).
 * The unchanged v10 wrapper runs only in a separate synthetic legacy fixture
 * with a fictional third controls vote and the fake-claude PATH shim; it is
 * never a real Fable invocation or approval.
 * Every scenario runs an isolated synthetic copy: synthetic
 * stage tree, synthetic worktree, synthetic gates/plan, and PATH shims that
 * inject ps/pmset failures. Real controls, gates, processes and the real process
 * table are never mutated. Every command, run, wrapper model child and escaped
 * process is owned by the fixture from acquisition; before each scenario the
 * fixture settles work a previous scenario may have left behind, and the stage
 * is removed only after the finite owned set is confirmed closed (MCTRL82-1/2,
 * MCTRR82-1, MCTRR82-R6/R7). Fault counters are reset per scenario and each ps
 * call is logged with its mode, so the actual healthy-to-failing transition is
 * proven from the log rather than assumed from an earlier counter (MCTRL82-3,
 * MCTRR82-R8). Readiness is established by recorded witnesses, never by fixed
 * delays (MCTRL82-7); injections that must land while the application runs use a
 * held application released in unconditional finalization (MCTRR82-2/4). Each
 * case keeps its primary failure together with every finalization failure,
 * including closure results returned as data and rejected bounded stops
 * (MCTRR82-R9). Explicitly selected by tests/cloudflare/controls/vitest.controls.config.ts.
 */
const DETACHED_SCRIPT = "const { spawn } = require('node:child_process'); spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' }).unref(); setInterval(() => {}, 1000)"
// The intermediate `node -e` receives the marker after `--` so Node treats it as a script argument, not an option (MCTRL82-5).
const ESCAPED_SCRIPT = "const { execFileSync } = require('node:child_process'); const marker = '--orbit-escape-' + require('node:path').basename(process.env.ORBIT_FAULT_ESCAPE_MARKER); execFileSync(process.execPath, ['-e', \"require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', '--', process.argv[1]], { detached: true, stdio: 'ignore' }).unref()\", '--', marker], { env: { ...process.env, NODE_OPTIONS: '' }, stdio: 'ignore' }); process.exit(0)"
// The outer application stays alive until the inner run has a terminal receipt, so the outer lock is held during the inner admission (MCTRL82-6).
const RECURSIVE_SCRIPT = [
  "const { spawnSync } = require('node:child_process'); const fs = require('node:fs'); const path = require('node:path');",
  "const result = spawnSync('python3', [process.env.ORBIT_FAULT_RUNNER, 'start', 'fast'], { encoding: 'utf8' });",
  "let inner = null; try { inner = JSON.parse(result.stdout.trim().split('\\n').at(-1)).run } catch {}",
  'let innerReceipt = null; const deadline = Date.now() + 30000;',
  'while (inner && Date.now() < deadline) {',
  "  try { innerReceipt = JSON.parse(fs.readFileSync(path.join(process.env.ORBIT_FAULT_VERIFICATION, inner, 'receipt.json'), 'utf8')) } catch { innerReceipt = null }",
  "  if (innerReceipt && ['complete', 'failed', 'cancelled'].includes(innerReceipt.status)) break;",
  '  innerReceipt = null; Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);',
  '}',
  'console.log(JSON.stringify({ status: result.status, stdout: result.stdout, stderr: result.stderr, inner, innerReceipt })); process.exit(0)',
].join(' ')
// A finite application that stays alive until the test writes its release flag (or its own 90 s bound passes, exit 2). It spawns nothing,
// so its only registry record is the registrar's observer-start at startup; nothing is written after the test's injection (MCTRR82-2/4).
const HELD_SCRIPT = "const fs = require('node:fs'); const flag = process.env.ORBIT_FAULT_RELEASE; const deadline = Date.now() + 90000; const poll = () => { if (fs.existsSync(flag)) process.exit(0); if (Date.now() > deadline) process.exit(2); setTimeout(poll, 100) }; poll()"
const CHECKS: Record<string, PlanCheck> = {
  fast: { args: ['node', '-e', 'process.exit(0)'], timeoutSeconds: 60, ports: [] },
  held: { args: ['node', '-e', HELD_SCRIPT], timeoutSeconds: 120, ports: [], env: { ORBIT_FAULT_RELEASE: `{run}/${RELEASE_FLAG}` } },
  sleep: { args: ['node', '-e', 'setInterval(() => {}, 1000)'], timeoutSeconds: 120, ports: [] },
  'sleep-timeout': { args: ['node', '-e', 'setInterval(() => {}, 1000)'], timeoutSeconds: 2, ports: [] },
  detached: { args: ['node', '-e', DETACHED_SCRIPT], timeoutSeconds: 120, ports: [] },
  escaped: { args: ['node', '-e', ESCAPED_SCRIPT], timeoutSeconds: 60, ports: [], env: { ORBIT_FAULT_ESCAPE_MARKER: '{run}' } },
  recursive: { args: ['node', '-e', RECURSIVE_SCRIPT], timeoutSeconds: 120, ports: [], env: { ORBIT_FAULT_RUNNER: '{stage}/collaboration/run-validation.py', ORBIT_FAULT_VERIFICATION: '{stage}/verification' } },
}
const escapeMarker = (run: string, check: string) => check === 'escaped' ? `--orbit-escape-${run}` : null
let stage: SyntheticStage
beforeAll(async () => { stage = await createSyntheticStage(CHECKS, { escapeMarker }) }, 240_000)
afterAll(async () => {
  // The stage is removed only after the finite owned set (commands, runs, controllers, application/power processes, wrapper model children, escapes) is confirmed closed.
  const report = await stage?.cleanup()
  expect(report?.errors ?? ['no stage']).toEqual([])
  expect(report?.removed).toBe(true)
}, 240_000)
beforeEach(async () => {
  // Quiescence first: owned work a previous scenario left active (an early failure) is cancelled and joined before any fault state is reset.
  const settled = await stage.settle()
  expect(settled.errors).toEqual([])
  await stage.setPsMode('ok')
  await stage.setPmsetMode('real')
  await stage.resetFaults()
})

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
/** Surface the primary failure together with every finalization failure; without a primary, finalization failures fail the case on their own. */
function conclude(primary: Failure, problems: string[]): void {
  if (primary && problems.length) {
    throw new AggregateError([primary.error, ...problems.map(problem => new Error(problem))], `${String(primary.error)} | finalization also failed: ${problems.join(' | ')}`)
  }
  if (primary) throw primary.error
  expect(problems).toEqual([])
}
/**
 * The actual fault boundary (MCTRR82-R8): split the mode-labelled ps log at the
 * first call recorded under the injected mode. Everything before it must have
 * run healthy (`ok`), everything from it on must carry the fault mode. A counter
 * read before the mode was published is never used as the boundary.
 */
function modeTransition(log: string[], faultMode: string): { healthy: string[]; failing: string[] } {
  const first = log.findIndex(line => line.endsWith(` ${faultMode}`))
  expect(first, `no ps call was recorded under mode ${faultMode}: ${JSON.stringify(log)}`).toBeGreaterThanOrEqual(0)
  const healthy = log.slice(0, first)
  const failing = log.slice(first)
  expect(healthy.every(line => line.endsWith(' ok')), `healthy prefix must be all ok: ${JSON.stringify(healthy)}`).toBe(true)
  expect(failing.every(line => line.endsWith(` ${faultMode}`)), `failing suffix must be all ${faultMode}: ${JSON.stringify(failing)}`).toBe(true)
  return { healthy, failing }
}

const phases = (receipt: Receipt) => (receipt.errors ?? []).map(error => error.phase)
const expectDead = async (pid: number, label: string) => {
  expect(await waitGone(pid, 10_000), `${label} ${pid} must be gone`).toBe(true)
}
const registryLines = async (run: string) => ((await stage.runFile(run, 'processes.ndjson')) ?? '').split('\n').filter(Boolean)
const registryEvents = async (run: string) => (await registryLines(run))
  .map(line => { try { return JSON.parse(line) as { event: string; pid: number } } catch { return null } })
  .filter((event): event is { event: string; pid: number } => event !== null)
const registryPids = async (run: string) => (await registryEvents(run)).filter(event => event.event === 'spawn').map(event => event.pid)
const observerStarted = (pid: number) => (events: { event: string; pid: number }[]) => events.some(event => event.event === 'observer-start' && event.pid === pid)
/** Bounded readiness witness: poll until the predicate holds or the bound elapses. */
async function until<T>(read: () => Promise<T>, ready: (value: T) => boolean, timeoutMs: number, label: string): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let last = await read()
  while (!ready(last)) {
    if (Date.now() >= deadline) throw new Error(`${label} not observed within ${timeoutMs} ms: ${JSON.stringify(last)}`)
    await delay(100)
    last = await read()
  }
  return last
}

const GATE_NAMES = ['controls', 'design', 'source'] as const
type GateName = typeof GATE_NAMES[number]
type RequiredReviewer = 'main' | 'astra'
type VoteFault = 'missing' | 'explicit-refusal'
interface SyntheticGate {
  decision?: string
  requiredIssues: unknown[]
  allowedModes?: string[]
  controlHashes?: Record<string, string>
  designSha256?: string
  sourceDigest?: string
  planSha256?: string
  participants: Record<string, {
    decision: string
    controlHashes?: Record<string, string>
    designSha256?: string
    sourceDigest?: string
    planSha256?: string
    synthetic?: boolean
  }>
}
interface GateSnapshot { file: string; bytes: Buffer; value: SyntheticGate }
type GateSnapshots = Record<GateName, GateSnapshot>
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
async function snapshotGates(target: SyntheticStage): Promise<GateSnapshots> {
  return Object.fromEntries(await Promise.all(GATE_NAMES.map(async name => {
    const file = path.join(target.control, `${name}-gate.json`)
    const bytes = await readFile(file)
    return [name, { file, bytes, value: JSON.parse(bytes.toString('utf8')) as SyntheticGate }]
  }))) as GateSnapshots
}
/** Assert every unmodified approval and binding, including the deliberate absence of a third reviewer. */
async function expectMainAstraPolicy(target: SyntheticStage, saved: GateSnapshots): Promise<void> {
  expect(target.policy).toBe('identity-execute')
  for (const name of GATE_NAMES) {
    expect(Object.keys(saved[name].value.participants).sort(), `${name} reviewers`).toEqual(['astra', 'main'])
    expect(saved[name].value.requiredIssues, `${name} issues`).toEqual([])
  }
  const controls = saved.controls.value
  expect(controls.decision).toBe('CONTROLS_APPROVED')
  expect(controls.allowedModes).toEqual(['identity', 'execute'])
  expect(controls.controlHashes).toEqual(APPROVED_CONTROL_HASHES)
  const design = saved.design.value
  const designHash = sha256(await readFile(path.join(target.worktree, 'docs/design/cloudflare-deployment.md')))
  expect(design.designSha256).toBe(designHash)
  const source = saved.source.value
  expect(source).toMatchObject({ decision: 'IMPLEMENTATION_APPROVED', sourceDigest: target.sourceDigest, planSha256: target.planSha256 })
  expect(sha256(await readFile(path.join(target.control, 'execution-plan.json')))).toBe(target.planSha256)
  for (const actor of ['main', 'astra'] as const) {
    expect(controls.participants[actor]).toEqual({ decision: 'CONTROLS_APPROVED', controlHashes: APPROVED_CONTROL_HASHES })
    expect(design.participants[actor]).toEqual({ decision: 'DESIGN_APPROVED', designSha256: designHash })
    expect(source.participants[actor]).toEqual({ decision: 'IMPLEMENTATION_APPROVED', sourceDigest: target.sourceDigest, planSha256: target.planSha256 })
  }
}
async function expectSyntheticIdentity(result: CommandResult, target: SyntheticStage): Promise<void> {
  expect(result.timedOut).toBe(false)
  expect(result.signal).toBeNull()
  expect(result.code).toBe(0)
  expect(result.stderr).toBe('')
  const identity = JSON.parse(result.stdout) as { worktree: string; fileCount: number; contentDigest: string; files: { path: string }[] }
  expect(identity).toMatchObject({ worktree: await realpath(target.worktree), fileCount: 2, contentDigest: target.sourceDigest })
  expect(identity.files.map(file => file.path)).toEqual(['package.json', 'tests/README.txt'])
}
function expectVoteRefusal(result: CommandResult, gate: GateName, actor: RequiredReviewer, fault: VoteFault, entry: 'identity' | 'runner'): void {
  expect(result.timedOut).toBe(false)
  expect(result.signal).toBeNull()
  expect(result.code).toBe(1)
  expect(result.stdout).toBe('') // Neither an identity result nor a dispatch is allowed through a refusing gate.
  const location = gate === 'source' ? 'execution_inputs' : gate === 'controls' && entry === 'runner' ? 'bootstrap' : 'approved_controls'
  expect(result.stderr).toContain(`in ${location}`)
  const explicitCause = gate === 'controls'
    ? entry === 'identity' ? 'All participants must approve these exact controls' : 'Control votes do not agree'
    : gate === 'design' ? 'Design vote mismatch' : 'All3 source/test/plan votes are required'
  // The approved bytes still use KeyError for a missing reviewer and the historical "All3" source diagnostic.
  // Require that exact gate/actor cause, not a generic nonzero exit, launch error or timeout.
  expect(result.stderr.trim().split('\n').at(-1)).toBe(fault === 'missing' ? `KeyError: '${actor}'` : `RuntimeError: ${explicitCause}`)
}
async function expectNoLaunch(target: SyntheticStage, verificationBefore: string[]): Promise<void> {
  // Approved bootstrap/execution_inputs run before run.mkdir, the controller, caffeinate and the application.
  // An unchanged inventory plus no dispatch/observer calls is the pre-launch witness; no process-table probe is needed.
  expect((await readdir(target.verification)).sort()).toEqual(verificationBefore)
  expect(await target.psCalls()).toBe(0)
  expect(await target.psLog()).toEqual([])
  expect(target.modelReady()).toBe(false)
}

describe('process metadata parsing', () => {
  it('interprets well-formed rows, treats blank output and a no-marker table as known absence, and refuses an uninterpretable nonblank row as unknown', () => {
    const row = '4242 1 4242 Fri Oct  3 06:35:00 2026 node -e setInterval(() => {}, 1000) -- --orbit-escape-run-1'
    expect(parseProcessRows(`${row}\n`)).toEqual([{
      pid: 4242, ppid: 1, pgid: 4242, started: 'Fri Oct 3 06:35:00 2026', startedEpoch: Date.UTC(2026, 9, 3, 6, 35, 0) / 1000,
      command: 'node -e setInterval(() => {}, 1000) -- --orbit-escape-run-1',
    }])
    // Known absence: blank output, and a well-formed table whose rows do not carry the marker (no positive row count is required).
    expect(parseProcessRows('')).toEqual([])
    expect(parseProcessRows('\n\n')).toEqual([])
    const table = parseProcessRows(`1 0 1 Fri Oct  3 06:00:00 2026 /sbin/launchd\n${row}\n`)
    expect(table).toHaveLength(2)
    expect(table.filter(entry => entry.command.split(' ').includes('--orbit-escape-run-2'))).toEqual([])
    // Unknown: a nonblank line that is not interpretable makes the whole table unknown instead of silently shrinking the discovered set (MCTRR82-R6 residual).
    expect(() => parseProcessRows(`${row}\ngarbage that is not a process row\n`)).toThrow(/process table not interpretable: 1 malformed row\(s\)/)
    expect(() => parseProcessRows('4242 1 4242 Fri Xyz  3 06:35:00 2026 node\n')).toThrow(/not interpretable/)
    expect(() => parseProcessRows('abc 1 4242 Fri Oct  3 06:35:00 2026 node\n')).toThrow(/not interpretable/)
    expect(() => parseProcessRows('4242 1 4242 Fri Oct  3 06:35 2026 node\n')).toThrow(/not interpretable/)
  })
})

describe('Main/Astra controls, design and source approvals', () => {
  it('identifies the exact synthetic source with Fable absent and keeps wrapper entry points closed in the default fixture', async () => {
    await expectMainAstraPolicy(stage, await snapshotGates(stage))
    const inventory = (await readdir(stage.verification)).sort()
    await expectSyntheticIdentity(await stage.identity([]), stage)
    const commandCount = stage.commands.length
    expect(() => stage.wrapperStart(['review', 'faults-review', '0123abcd-4567-89ef-0123-456789abcdef']))
      .toThrow('Wrapper calls require the isolated synthetic legacy fixture in review mode')
    expect(stage.commands).toHaveLength(commandCount)
    await expectNoLaunch(stage, inventory)
  })

  const cases = GATE_NAMES.flatMap(gate => (['main', 'astra'] as const)
    .flatMap(actor => (['missing', 'explicit-refusal'] as const).map(fault => ({ gate, actor, fault }))))
  it.each(cases)('$gate rejects $actor $fault before dispatch or application/power launch', async ({ gate, actor, fault }) => {
    const saved = await snapshotGates(stage)
    let primary: Failure = null
    try {
      await expectMainAstraPolicy(stage, saved)
      const verificationBefore = (await readdir(stage.verification)).sort()
      const knownRuns = [...stage.runs].sort()
      const changed = JSON.parse(saved[gate].bytes.toString('utf8')) as SyntheticGate
      if (fault === 'missing') delete changed.participants[actor]
      else changed.participants[actor].decision = {
        controls: 'CONTROLS_REFUSED', design: 'DESIGN_REFUSED', source: 'IMPLEMENTATION_REFUSED',
      }[gate]
      // Only this reviewer's presence/decision changes; all other votes, gate decisions, issues and content/plan hashes stay valid.
      await writeFile(saved[gate].file, JSON.stringify(changed, null, 2) + '\n')
      for (const other of GATE_NAMES.filter(name => name !== gate)) {
        expect((await readFile(saved[other].file)).equals(saved[other].bytes), `${other} gate unchanged`).toBe(true)
      }
      const identity = await stage.identity([])
      if (gate === 'source') await expectSyntheticIdentity(identity, stage) // Reading identity does not require implementation approval.
      else expectVoteRefusal(identity, gate, actor, fault, 'identity')
      await expectNoLaunch(stage, verificationBefore)
      expectVoteRefusal(await stage.runner(['start', 'fast']), gate, actor, fault, 'runner')
      await expectNoLaunch(stage, verificationBefore)
      expect([...stage.runs].sort()).toEqual(knownRuns)
    } catch (error) {
      primary = { error }
    }
    // Always restore every exact gate byte before settlement so even an unexpectedly admitted actor-owned run can be reconciled/cancelled.
    // Every restoration/readback/settlement step is attempted independently and joins the primary failure.
    conclude(primary, await attemptAll([
      ...GATE_NAMES.map(name => ({ label: `restore ${name} gate`, run: () => writeFile(saved[name].file, saved[name].bytes) })),
      ...GATE_NAMES.map(name => ({
        label: `verify restored ${name} gate`,
        run: async () => {
          const restored = await readFile(saved[name].file)
          expect(restored.equals(saved[name].bytes), `${name} gate exact bytes restored`).toBe(true)
          expect(sha256(restored), `${name} gate exact hash restored`).toBe(sha256(saved[name].bytes))
        },
      })),
      {
        label: 'settle after gate restoration',
        run: async () => {
          const settled = await stage.settle()
          expect(settled.errors).toEqual([])
          expect(stage.commands.every(handle => handle.settled)).toBe(true)
        },
      },
    ]))
  }, 180_000)
})

describe('identity refusals happen before any read', () => {
  it('refuses a named .npmrc and a project .npmrc without opening them', async () => {
    const npmrc = path.join(stage.worktree, '.npmrc')
    await writeFile(npmrc, 'registry=https://example.test/\n')
    await chmod(npmrc, 0o000)
    try {
      const named = await stage.identity(['--sha256', '.local/research/82/worktree/.npmrc'])
      expect(named.code).not.toBe(0)
      expect(named.stderr).toContain('Npm configuration requires explicit source/privacy review')
      expect(named.stderr).not.toContain('Permission denied')
      const whole = await stage.identity([])
      expect(whole.code).not.toBe(0)
      expect(whole.stderr).toContain('Project npm configuration needs explicit source/privacy review')
      expect(whole.stderr).not.toContain('Permission denied')
    } finally {
      await chmod(npmrc, 0o600)
      await rm(npmrc, { force: true })
    }
  })

  it('refuses collaboration model streams, named or nested in the source identity, without opening them', async () => {
    // Newly created, empty stand-ins only: no model stream is ever read, hashed, copied or emitted, not even a synthetic one.
    const named = path.join(stage.control, 'synthetic-stream.ndjson')
    const nestedDirectory = path.join(stage.worktree, 'tests/collaboration')
    const nested = path.join(nestedDirectory, 'nested-synthetic.ndjson')
    await writeFile(named, '')
    await chmod(named, 0o000)
    await mkdir(nestedDirectory, { recursive: true })
    await writeFile(nested, '')
    await chmod(nested, 0o000)
    try {
      const direct = await stage.identity(['--sha256', '.local/research/82/collaboration/synthetic-stream.ndjson'])
      expect(direct.code).not.toBe(0)
      expect(direct.stderr).toContain('Private model streams are stat-only')
      expect(direct.stderr).not.toContain('Permission denied')
      const whole = await stage.identity([])
      expect(whole.code).not.toBe(0)
      expect(whole.stderr).toContain('Private model streams are stat-only')
      expect(whole.stderr).not.toContain('Permission denied')
    } finally {
      for (const file of [named, nested]) { await chmod(file, 0o600).catch(() => {}); await rm(file, { force: true }) }
      await rm(nestedDirectory, { recursive: true, force: true })
    }
    const restored = await stage.identity([])
    expect(restored.code).toBe(0)
    expect((JSON.parse(restored.stdout) as { contentDigest: string }).contentDigest).toBe(stage.sourceDigest)
  })
})

describe('validation runner lifecycle', () => {
  it('completes a fast child with Fable absent, registry, power assertions and an empty sleep interval, and ignores a late cancel', async () => {
    await expectMainAstraPolicy(stage, await snapshotGates(stage))
    await expectSyntheticIdentity(await stage.identity([]), stage)
    const { run } = await stage.start('fast')
    const receipt = await stage.waitTerminal(run)
    expect(receipt.status).toBe('complete')
    expect(receipt.exitCode).toBe(0)
    expect(receipt.error).toBeNull()
    expect(receipt).toMatchObject({ actor: stage.actor, check: 'fast', sourceDigest: stage.sourceDigest, planSha256: stage.planSha256, args: ['node', '-e', 'process.exit(0)'] })
    expect(stage.modelReady()).toBe(false)
    expect(receipt.cleanup).toMatchObject({ closureKnown: true, remaining: [], registryPresent: true, incompleteRegistryRecord: false, registryErrors: [] })
    expect(receipt.cleanup!.observerAcknowledgements as number).toBeGreaterThan(0)
    expect(receipt.powerCleanup).toMatchObject({ closureKnown: true, remaining: [] })
    // CTRL82-REAP-01: v8 kept the exact power child's exited, unreaped row through both stop polls (forced and remaining <defunct>).
    // The stop must signal exactly the retained power child, reap it through its own Popen inside the SIGTERM window and close from a fresh empty snapshot.
    expect(receipt.powerProcesses).toHaveLength(1)
    expect(receipt.powerCleanup).toMatchObject({ signalled: receipt.powerProcesses, forced: [], directChildReap: { enabled: true, returnCode: expect.any(Number) } })
    // The application child was already reaped by the runner's own poll before its cleanup: nothing is signalled and the callback reports its exit status 0.
    expect(receipt.cleanup).toMatchObject({ signalled: [], forced: [], directChildReap: { enabled: true, returnCode: 0 } })
    for (const name of ['power-before.json', 'power-after.json']) {
      const power = JSON.parse((await stage.runFile(run, name))!) as { system: boolean; idle: boolean }
      expect(power, name).toMatchObject({ system: true, idle: true })
    }
    const interval = JSON.parse((await stage.runFile(run, 'power-interval.json'))!) as { events: unknown[]; beganEpoch: number; endedEpoch: number }
    expect(interval.events).toEqual([])
    expect(interval.endedEpoch).toBeGreaterThanOrEqual(interval.beganEpoch)
    expect(await stage.runFile(run, 'source-after.json')).not.toBeNull()
    // The cancel command is synchronous: when it returns, its whole effect is observable.
    const cancelled = await stage.cancel(run)
    expect(cancelled.code).toBe(0)
    const after = (await stage.receipt(run))!
    expect(after.status).toBe('complete')
    expect(after.cancelled).not.toBe(true)
    expect(await stage.psCalls()).toBeGreaterThan(0)
  }, 120_000)

  it('cancels during preflight before any application launch', async () => {
    await stage.setPsMode('delay:3')
    const { run } = await stage.start('sleep')
    await stage.waitFor(run, receipt => receipt.status === 'starting', 30_000)
    expect((await stage.cancel(run)).code).toBe(0)
    const receipt = await stage.waitTerminal(run)
    expect(receipt.status).toBe('cancelled')
    expect(receipt.pid).toBeUndefined()
    expect(['Cancelled before execution', 'Cancelled at application launch boundary']).toContain(receipt.error)
    expect(receipt.cleanup).toEqual({ closureKnown: true, remaining: [] })
    expect(receipt.powerCleanup).toMatchObject({ closureKnown: true })
  }, 120_000)

  it('fails the check when the power log shows a sleep event captured while the held application was alive, after tearing the application down', async () => {
    const { run } = await stage.start('held')
    let capturedMs: number | null = null
    let eventLine: string | null = null
    let primary: Failure = null
    try {
      const running = await stage.waitFor(run, receipt => receipt.status === 'running', 60_000)
      await until(() => registryEvents(run), observerStarted(running.pid!), 30_000, 'observer-start record of the held application')
      // Acknowledged point: the runner reports the application running and the application has announced itself in the registry.
      // The actual instant is captured now, while the application is held alive, and handed to the pmset shim before the release.
      capturedMs = Date.now()
      eventLine = await stage.setPmsetEvent(capturedMs)
    } catch (error) {
      primary = { error }
    }
    // Unconditional release; a release failure is reported together with the primary, never in its place.
    conclude(primary, await attemptAll([{ label: 'release', run: () => stage.release(run) }]))
    const receipt = await stage.waitTerminal(run)
    expect(receipt.status).toBe('failed')
    expect(receipt.exitCode).toBe(0)
    expect(phases(receipt)).toContain('power-final-interval')
    expect(receipt.error).toBe('System sleep/wake occurred during application verification')
    const interval = JSON.parse((await stage.runFile(run, 'power-interval.json'))!) as { beganEpoch: number; endedEpoch: number; events: string[] }
    const iso = new Date(capturedMs!).toISOString()
    const stamp = `${iso.slice(0, 10)} ${iso.slice(11, 19)} +0000`
    const eventEpoch = Math.floor(capturedMs! / 1000)
    // The captured instant lies inside the recorded execution interval, and its one-second pmset representation overlaps it under the v8 policy.
    expect(capturedMs! / 1000).toBeGreaterThanOrEqual(interval.beganEpoch)
    expect(capturedMs! / 1000).toBeLessThanOrEqual(interval.endedEpoch)
    expect(eventEpoch <= interval.endedEpoch && eventEpoch + 1 > interval.beganEpoch).toBe(true)
    // Exactly the synthetic event: a real sleep/wake event inside the interval would appear here and fail the case as unexpected evidence.
    expect(interval.events).toEqual([eventLine])
    expect(interval.events[0]).toContain(`${stamp} Sleep`)
    expect(interval.events[0]).toContain("Entering Sleep state due to 'Synthetic fault check'")
    // The real log was queried first and spooled unchanged; the synthetic line follows it.
    const raw = (await stage.runFile(run, 'power-events-raw.log'))!
    expect(raw.trimEnd().endsWith(eventLine!)).toBe(true)
    expect(receipt.cleanup).toMatchObject({ closureKnown: true, remaining: [] })
  }, 120_000)

  it('kills an application that outlives its approved timeout and still audits power through teardown', async () => {
    const { run } = await stage.start('sleep-timeout')
    const receipt = await stage.waitTerminal(run)
    expect(receipt.status).toBe('failed')
    expect(receipt.error).toBe('Approved validation timeout exceeded')
    expect(receipt.cleanup).toMatchObject({ closureKnown: true, remaining: [] })
    expect((receipt.cleanup!.signalled as unknown[]).length).toBeGreaterThanOrEqual(1)
    // CTRL82-REAP-01 on a failure path. The application child is alive at teardown and exits on SIGTERM; the stop must signal exactly that
    // retained child and reap it inside the SIGTERM window (v8 kept its exited row, force-signalled it and returned it as remaining).
    expect(receipt.cleanup).toMatchObject({ signalled: [expect.objectContaining({ pid: receipt.pid })], forced: [], directChildReap: { enabled: true, returnCode: -15 } })
    // The runner records that same reaped status, and the timeout stays the only recorded error.
    expect(receipt.exitCode).toBe(-15)
    expect(phases(receipt)).toEqual(['execution'])
    // This status is already failed, so power retention would be invisible in it: the power child must still be reaped and closed from a fresh empty snapshot.
    expect(receipt.powerProcesses).toHaveLength(1)
    expect(receipt.powerCleanup).toMatchObject({ closureKnown: true, remaining: [], signalled: receipt.powerProcesses, forced: [], directChildReap: { enabled: true, returnCode: expect.any(Number) } })
    await expectDead(receipt.pid!, 'application')
    const interval = JSON.parse((await stage.runFile(run, 'power-interval.json'))!) as { beganEpoch: number; endedEpoch: number; events: unknown[] }
    expect(interval.endedEpoch - interval.beganEpoch).toBeGreaterThanOrEqual(2)
    expect(interval.events).toEqual([])
  }, 120_000)

  it('F82-X1: when the observer cannot be constructed, the retained direct child session is signalled and closure stays unknown', async () => {
    // ps calls in this scenario: power-observer construction (1) and its update (2) succeed; the application-observer construction (3) fails.
    await stage.setPsMode('fail-after:2')
    const { run } = await stage.start('sleep')
    const receipt = await stage.waitTerminal(run)
    expect(receipt.status).toBe('failed')
    // The running-phase pid is written only after a constructed observer; the retained child is reported by the fallback itself.
    expect(receipt.pid).toBeUndefined()
    const directChildPid = receipt.cleanup!.directChildPid as number
    expect(directChildPid).toBeGreaterThan(0)
    expect(phases(receipt)[0]).toBe('execution')
    // check_output inherits stderr: the synthetic marker lands in the owned controller log, the receipt carries the ps failure itself.
    expect(receipt.errors![0].error).toMatch(/ps.*returned non-zero exit status 1|synthetic ps failure/)
    expect(await stage.runFile(run, 'controller.log')).toContain('synthetic ps failure')
    const log = await stage.psLog()
    expect(log.length).toBeGreaterThanOrEqual(3)
    expect(log[2]).toBe('3 fail-after:2')
    expect(receipt.cleanup).toMatchObject({ closureKnown: false, remaining: null, fallbackSessionSignal: true })
    expect((receipt.cleanup!.sessionSignals as { signal: string; result: string }[])[0]).toEqual({ signal: 'SIGTERM', result: 'sent' })
    expect(receipt.cleanup!.directChildExitCode).toBeLessThan(0)
    await expectDead(directChildPid, 'application')
    expect(receipt.powerCleanup).toMatchObject({ closureKnown: false, remaining: null, fallbackSessionSignal: true })
  }, 120_000)

  it('F82-X2: when the constructed observer fails persistently at teardown, both stop attempts are recorded and the direct child session is signalled', async () => {
    const { run } = await stage.start('sleep')
    const running = await stage.waitFor(run, receipt => receipt.status === 'running', 60_000)
    expect(running.pid).toBeGreaterThan(0)
    // The running receipt is the constructor witness (v8 writes it only after both observers were constructed); the fault is published atomically now.
    // Healthy observer updates may still land between this point and the publication; the log transition below, not a counter, is the boundary.
    await stage.setPsMode('fail')
    const receipt = await stage.waitTerminal(run)
    expect(receipt.status).toBe('failed')
    expect(phases(receipt)).toEqual(expect.arrayContaining(['execution', 'application-cleanup-1', 'application-cleanup-2']))
    expect(receipt.cleanup).toMatchObject({ closureKnown: false, remaining: null, fallbackSessionSignal: true, directChildPid: running.pid })
    expect(receipt.cleanup!.directChildExitCode).toBeLessThan(0)
    // Actual fault boundary: an all-healthy prefix (power constructor, power update, application constructor and any later updates) followed only by
    // failing calls (the update that observed the fault, both application stop attempts, and the power stop attempts).
    const { healthy, failing } = modeTransition(await stage.psLog(), 'fail')
    expect(healthy.length).toBeGreaterThanOrEqual(3)
    expect(failing.length).toBeGreaterThanOrEqual(3)
    await expectDead(running.pid!, 'application')
    expect(receipt.powerCleanup).toMatchObject({ closureKnown: false, fallbackSessionSignal: true })
  }, 120_000)

  it('retries a transiently failing observation once and keeps known closure, while the first error still fails the check', async () => {
    const { run } = await stage.start('sleep')
    const running = await stage.waitFor(run, receipt => receipt.status === 'running', 60_000)
    // The polling update fails once, the first stop attempt fails once, the second stop attempt observes and cleans up.
    await stage.setPsMode('fail-count:2')
    const receipt = await stage.waitTerminal(run)
    expect(receipt.status).toBe('failed')
    expect(phases(receipt)).toEqual(['execution', 'application-cleanup-1'])
    expect(receipt.cleanup).toMatchObject({ closureKnown: true, remaining: [] })
    expect(receipt.cleanup).not.toHaveProperty('fallbackSessionSignal')
    await expectDead(running.pid!, 'application')
  }, 120_000)

  it('stops a registered detached descendant with its parent and reports complete cleanup', async () => {
    const { run } = await stage.start('detached')
    const running = await stage.waitFor(run, receipt => receipt.status === 'running', 60_000)
    // Readiness witness: the detached grandchild's spawn record is in the registry before cancellation.
    const spawned = await until(() => registryPids(run), pids => pids.length >= 1, 30_000, 'registry spawn record')
    expect((await stage.cancel(run)).code).toBe(0)
    const receipt = await stage.waitTerminal(run)
    expect(receipt.status).toBe('cancelled')
    expect(receipt.cleanup).toMatchObject({ closureKnown: true, remaining: [] })
    expect((receipt.cleanup!.signalled as { pid: number }[]).map(process => process.pid)).toEqual(expect.arrayContaining([running.pid, ...spawned]))
    for (const pid of [running.pid!, ...spawned]) await expectDead(pid, 'owned process')
  }, 120_000)

  it('treats an incomplete registry record as a failed check even when the application exits 0', async () => {
    const { run } = await stage.start('held')
    const registry = path.join(stage.verification, run, 'processes.ndjson')
    let primary: Failure = null
    try {
      const running = await stage.waitFor(run, receipt => receipt.status === 'running', 60_000)
      // Readiness witness: the held application's own complete observer-start record is in the registry while the application is still alive.
      const events = await until(() => registryEvents(run), observerStarted(running.pid!), 30_000, 'observer-start record of the held application')
      expect(events.filter(event => event.event === 'spawn')).toEqual([])
      // The partial, non-newline-terminated record is appended and its write has completed before the application is released;
      // the held application writes nothing to the registry afterwards, so this tail stays the final record.
      await writeFile(registry, '{"event":"spawn","pid":1', { flag: 'a' })
      expect((await readFile(registry, 'utf8')).endsWith('{"event":"spawn","pid":1')).toBe(true)
    } catch (error) {
      primary = { error }
    }
    conclude(primary, await attemptAll([{ label: 'release', run: () => stage.release(run) }]))
    const receipt = await stage.waitTerminal(run)
    expect(receipt.status).toBe('failed')
    expect(receipt.exitCode).toBe(0)
    expect(receipt.error).toBeNull()
    expect(receipt.cleanup).toMatchObject({ closureKnown: true, remaining: [], incompleteRegistryRecord: true, registryErrors: [], observerAcknowledgements: 1 })
  }, 120_000)

  it('documents the observer limit: an unregistered descendant that leaves the group escapes, and the fixture removes it by rechecked exact identity', async () => {
    const { run } = await stage.start('escaped')
    const marker = `--orbit-escape-${run}`
    // The fixture owns the escaped marker from dispatch, so finalization closes it even if the waits below fail.
    expect(stage.ownedEscapes()).toContain(marker)
    let primary: Failure = null
    try {
      const receipt = await stage.waitTerminal(run)
      expect(receipt.exitCode).toBe(0)
      expect(receipt.cleanup).toMatchObject({ remaining: [] })
      // The runner cannot see this process (no registration, new group, orphaned); the receipt does not claim otherwise.
      const escaped = await findByMarker(marker)
      expect(escaped).toHaveLength(1)
      expect(escaped[0]).toMatchObject({ ppid: 1, pgid: escaped[0].pid })
      expect(escaped[0].command.split(' ')).toContain(marker)
    } catch (error) {
      primary = { error }
    }
    // Unconditional closure by rechecked identity. The closure report returns its problems as data, so they join the finalization
    // problems before conclude: an earlier primary never hides a closure error or an unestablished closure (MCTRR82-R9).
    let closure: EscapeClosure | undefined
    const problems = await attemptAll([{ label: 'closeEscaped', run: async () => { closure = await stage.closeEscaped(marker) } }])
    if (closure) {
      problems.push(...closure.errors.map(error => `closeEscaped: ${error}`))
      if (!closure.closed) problems.push(`closeEscaped: closure not established (found ${closure.found.length}, terminated ${JSON.stringify(closure.terminated)})`)
    }
    conclude(primary, problems)
    const closed = closure!
    expect(closed.closed).toBe(true)
    expect(closed.found).toHaveLength(1)
    expect(closed.terminated).toEqual([{ pid: closed.found[0].pid, signals: expect.arrayContaining(['SIGTERM']), gone: true }])
    expect(await findByMarker(marker)).toEqual([])
  }, 120_000)

  it('refuses recursive validation admission while a worker holds the validation lock', async () => {
    const { run } = await stage.start('recursive')
    const receipt = await stage.waitTerminal(run)
    expect(receipt.status).toBe('complete')
    const output = (await stage.runFile(run, 'output.log')) ?? ''
    const outer = JSON.parse(output.trim().split('\n').at(-1)!) as { status: number; stdout: string; inner: string | null; innerReceipt: Receipt | null }
    expect(outer.status).toBe(0)
    expect(outer.inner).toBeTruthy()
    // The inner run is owned with its own controller identity (the receipt's workerPid), never as an identity-less entry.
    const adopted = await stage.adopt(outer.inner!)
    expect(adopted.controllerPid).toBeGreaterThan(0)
    // The outer application observed the inner terminal receipt while it still held the lock.
    expect(outer.innerReceipt?.status).toBe('failed')
    const innerReceipt = await stage.waitTerminal(outer.inner!, 30_000)
    expect(innerReceipt.status).toBe('failed')
    expect(innerReceipt.workerPid).toBe(adopted.controllerPid)
    expect(innerReceipt.error).toMatch(/Errno 35|temporarily unavailable|Resource deadlock|Errno 11/)
    expect(innerReceipt.pid).toBeUndefined()
  }, 120_000)
})

describe('synthetic legacy v10 review wrapper fallback (no real model)', () => {
  let wrapperStage: SyntheticStage
  beforeAll(async () => {
    wrapperStage = await createSyntheticLegacyWrapperStage()
    expect(wrapperStage.root).not.toBe(stage.root)
  }, 240_000)
  afterAll(async () => {
    const report = await wrapperStage?.cleanup()
    expect(report?.errors ?? ['no synthetic legacy stage']).toEqual([])
    expect(report?.removed).toBe(true)
  }, 240_000)
  beforeEach(async () => {
    const settled = await wrapperStage.settle()
    expect(settled.errors).toEqual([])
    await wrapperStage.setPsMode('ok')
    await wrapperStage.setPmsetMode('real')
    await wrapperStage.resetFaults()
    // The legacy exception exists only in this distinct synthetic root and only for the wrapper's bootstrap controls vote.
    expect(wrapperStage.policy).toBe('synthetic-legacy-wrapper')
    const legacy = await snapshotGates(wrapperStage)
    expect(legacy.controls.value.allowedModes).toEqual(['identity', 'review'])
    expect(Object.keys(legacy.controls.value.participants).sort()).toEqual(['astra', 'fable', 'main'])
    expect(legacy.controls.value.participants.fable).toMatchObject({ decision: 'CONTROLS_APPROVED', controlHashes: APPROVED_CONTROL_HASHES, synthetic: true })
    for (const name of ['design', 'source'] as const) expect(Object.keys(legacy[name].value.participants).sort()).toEqual(['astra', 'main'])
    expect(JSON.parse(await readFile(path.join(wrapperStage.control, 'execution-plan.json'), 'utf8'))).toEqual({ version: 1, checks: {} })
    await expectMainAstraPolicy(stage, await snapshotGates(stage))
  })
  const session = '0123abcd-4567-89ef-0123-456789abcdef'
  const receiptOf = async (label: string): Promise<Record<string, any> | null> => {
    try { return JSON.parse(await readFile(path.join(wrapperStage.control, `${label}.process.json`), 'utf8')) as Record<string, any> }
    catch { return null }
  }

  it('F82-X2 (wrapper): a constructed observer that fails during the run leads to the direct-session fallback and a failed receipt', async () => {
    // The wrapper starts with ps healthy and is owned from spawn (with its model child, through the label's receipt); the fault is published only
    // after BOTH witnesses below hold, in either order, so the first ps call (the Ownership constructor snapshot) can never be the failing one.
    const handle = wrapperStage.wrapperStart(['review', 'faults-review', session])
    let running: Record<string, any> | null = null
    let armed = false
    let primary: Failure = null
    try {
      // 1. Constructor witness: v8 writes the running receipt with a positive pid only after Ownership(child.pid) succeeded.
      running = await until(() => receiptOf('faults-review'), current => current !== null && current.processStatus === 'running' && Number.isSafeInteger(current.pid) && current.pid > 0, 30_000, 'wrapper running receipt')
      // 2. Child witness: the synthetic model printed its result and touched its readiness marker.
      await until(async () => wrapperStage.modelReady(), ready => ready, 30_000, 'model readiness marker')
      await until(() => readFile(path.join(wrapperStage.control, 'faults-review.result.json'), 'utf8').catch(() => ''), text => text.includes('"type":"result"'), 30_000, 'model result')
      await wrapperStage.setPsMode('fail')
      armed = true
    } catch (error) {
      primary = { error }
    }
    // Bounded, independent finalization (MCTRR82-R7/R9): a wrapper that never saw the fault is stopped through its own signal handling; the
    // join is bounded either way; an unresolved stop stays an explicit unknown that settle() keeps accounting for; and a rejection thrown by
    // this bounded step is caught and labelled so it combines with the captured primary instead of replacing it. The result is assigned in
    // this enclosing flow rather than inside a callback, so the assignment is visible to the type checker (MFIN82-T1 / ACRR82-R5-1).
    const step = armed ? 'bounded-join' : 'bounded-stop'
    const finalization: string[] = []
    let result: CommandResult | null = null
    try {
      if (!armed) {
        result = await handle.stop()
        if (!result) throw new Error(`the wrapper (pid ${handle.pid}) did not close within the stop bounds; its closure is unknown`)
      } else {
        result = (await settledWithin(handle.done, 60_000)) ? handle.result : null
        if (!result) throw new Error(`the wrapper (pid ${handle.pid}) did not close within 60 s after the fault was armed; its closure is unknown`)
      }
    } catch (error) {
      finalization.push(`${step}: ${String(error)}`)
    }
    conclude(primary, finalization)
    // conclude() threw unless the bounded step produced a result; this check states that dependency instead of asserting it away.
    if (result === null) throw new Error(`${step} concluded without a wrapper result for pid ${handle.pid}`)
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('synthetic ps failure')
    const receipt = (await receiptOf('faults-review'))!
    expect(receipt.processStatus).toBe('failed-or-interrupted')
    expect(receipt.pid).toBe(running!.pid)
    expect(receipt.processCleanup).toMatchObject({ closureKnown: false, remaining: null, fallbackSessionSignal: true, directChildPid: receipt.pid })
    expect(receipt.processCleanup.directChildExitCode).toBeLessThan(0)
    const cleanupPhases = (receipt.cleanupErrors as { phase: string; error: string }[]).map(error => error.phase)
    expect(cleanupPhases).toEqual(expect.arrayContaining(['model-execution', 'model-cleanup-1', 'model-cleanup-2']))
    expect((receipt.cleanupErrors as { phase: string; error: string }[])[0]).toMatchObject({ phase: 'model-execution', error: expect.stringMatching(/ps.*returned non-zero exit status 1/) })
    await expectDead(receipt.pid, 'synthetic model child')
    expect(await readFile(path.join(wrapperStage.control, 'faults-review.result.json'), 'utf8')).toContain('"type":"result"')
    // Actual fault boundary (MCTRR82-R8): an all-healthy prefix (at least the constructor snapshot, plus any updates before publication) followed only by
    // failing calls (the update that observed the fault and both stop attempts).
    const { healthy, failing } = modeTransition(await wrapperStage.psLog(), 'fail')
    expect(healthy.length).toBeGreaterThanOrEqual(1)
    expect(failing.length).toBeGreaterThanOrEqual(3)
  }, 120_000)

  it('F82-X1 (wrapper): an observer that cannot be constructed leads to the direct-session fallback and a failed receipt', async () => {
    await wrapperStage.setPsMode('fail')
    const result = await wrapperStage.wrapper(['review', 'faults-review-x1', session])
    expect(result.code).toBe(1)
    // The ps shim's stderr is inherited by the wrapper, so the synthetic failure is visible in the owned wrapper stderr.
    expect(result.stderr).toContain('synthetic ps failure')
    const receipt = (await receiptOf('faults-review-x1'))!
    expect(receipt.processStatus).toBe('failed-or-interrupted')
    // v8 writes the normal pid only after Ownership construction; here the constructor failed, so the retained child is named by the fallback alone.
    expect(receipt.pid).toBeNull()
    const directChildPid = receipt.processCleanup.directChildPid as number
    expect(Number.isSafeInteger(directChildPid) && directChildPid > 0).toBe(true)
    expect(receipt.processCleanup).toMatchObject({ closureKnown: false, remaining: null, fallbackSessionSignal: true })
    expect((receipt.processCleanup.sessionSignals as { signal: string; result: string }[])[0]).toEqual({ signal: 'SIGTERM', result: 'sent' })
    expect(receipt.processCleanup.directChildExitCode).toBeLessThan(0)
    const cleanupPhases = (receipt.cleanupErrors as { phase: string; error: string }[]).map(error => error.phase)
    expect(cleanupPhases[0]).toBe('model-execution')
    expect((receipt.cleanupErrors as { phase: string; error: string }[])[0].error).toMatch(/ps.*returned non-zero exit status 1/)
    // Distinct from X2: no constructed observer, so no stop attempts were made.
    expect(cleanupPhases).not.toContain('model-cleanup-1')
    expect(cleanupPhases).not.toContain('model-cleanup-2')
    await expectDead(directChildPid, 'synthetic model child')
    // The owned model stderr log exists (the wrapper opened it exclusively before the spawn); its content is diagnostic only.
    expect(await readFile(path.join(wrapperStage.control, 'faults-review-x1.stderr.log'), 'utf8')).toBeDefined()
    expect((await wrapperStage.psLog())[0]).toBe('1 fail')
  }, 120_000)
})
