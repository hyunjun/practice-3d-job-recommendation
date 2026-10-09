import { expect, test } from '@playwright/test'
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { constants as fsConstants } from 'node:fs'
import { lstat, mkdtemp, open, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer, request as httpRequestForWitness } from 'node:http'
import type { ClientRequest, IncomingMessage, Server } from 'node:http'
import type { AddressInfo, Socket } from 'node:net'
import type { TestInfo } from '@playwright/test'
import os from 'node:os'
import path from 'node:path'
import {
  bindOwnedRuntime, birthOf, canonicalPort, classifyListenerResult, closeNativeTransport, CONTEXT_LIMITS, cooperativeForEach, execBounded, fetchNativeFirstDiscoveryJson, finalizeCase, Inspector, InspectorAcquisitionError, loadWs, MemorySampler,
  NativeFrameEvidence, nativeCapacityMode, nativeWitnessMode, ownedIdentityGet, parsePidLines, PINNED_WRANGLER, processTable, recheckRuntime, requireUsableMemory, sampleFromResult, summarizeSamples, validateOwnedEndpoints,
} from './helpers/instrumentation'
import type { BoundedResult, CommandLease, CommandObservation, CommandWitness, ContextDescriptor, ExecFileFailure, InspectorAcquisition, MemorySample, MemorySummary, NativeMode, NativeWitnessOptions, ObservedCommandChild, OwnedEndpoints, OwnedRuntime, ProcessIdentity, WsSocket } from './helpers/instrumentation'
import { NativeSamplerOwnership, qualifySamplerSummary, readSamplerArtifact, SamplerArtifactReadFailure, SamplerFailures, SamplerProcess, SamplerRetention, SamplerWire, sealSamplerArtifact, validateSamplerArtifact } from './helpers/memory-sampler-process'
import type { RegisteredProcess, SamplerArtifact, SamplerBinding, SamplerClock, SamplerFrame, SamplerHistory, SamplerOwnershipProducers, SamplerPhase } from './helpers/memory-sampler-process'
import { SamplerChildExitPolicy } from './helpers/memory-sampler-child'
import { contractClient, HeldRequestAcquisitionError, HttpObservation, openHeldRequest, openSlowStream, rawRequest, storeRoute, StreamRegistry, wipeStore } from './helpers/worker-http'
import type { HeldRequest, HeldRequestClosure, HeldRequestTransport, HttpTime, SlowStream } from './helpers/worker-http'

/**
 * Local failure witnesses for the capacity instrumentation (ACR82-3/5,
 * MCR82-R9..R14): owned loopback servers stand in for the Wrangler inspector
 * proxy and the validation registry so the corrected helper paths are exercised
 * without the real runtime. Literal parser/classifier, raw-result conversion and
 * summary witnesses exercise the lsof and RSS contracts with PID-scoped reads
 * of this test process and one observed, subsequently reaped owned child. The fake proxy owns
 * every connection it accepts and destroys them before waiting on its own
 * shutdown. Nothing here contacts the Worker under test, the foreign port 8787 or
 * any other endpoint. The local `ws` server/client come from the requested direct
 * dependency (independent/author04-capacity-dependency-request.json).
 */
/** The ws server surface the factory relies on; its close callback may report an error (for example when the server is not running), which is retained, never discarded. */
interface WsServerLike { on(event: 'connection', listener: (socket: ServerSocket, request: IncomingMessage) => void): void; close(callback?: (error?: Error) => void): void }
interface ServerSocket { readyState: number; send(data: string | Buffer, callback?: (error?: Error) => void): void; close(code?: number, reason?: string): void; terminate(): void; on(event: 'message', listener: (data: Buffer | string) => void): void }
interface ScriptedCommand { id: number; method: string; params: Record<string, unknown> }
type ScriptedDispatch = (command: ScriptedCommand, socket: ServerSocket) => boolean
type Mode = 'two-targets' | 'wrong-version' | 'foreign-endpoint' | 'close-after-upgrade' | 'invalid-json' | 'null-frame' | 'nonce-mismatch' | 'ok' | 'ok-isolate-changes' | 'ok-zero-deltas'
const NONCE = 'f0f0f0f0-0000-4000-8000-0f0f0f0f0f0f'
const OWNED_CONTEXT: ContextDescriptor = { id: 7, uniqueId: 'owned-context-one', name: 'Worker', origin: '', auxData: { isDefault: false, label: '가상' } }
const COMPILER_CONTEXT: ContextDescriptor = { id: 4, uniqueId: 'compiler-context-one', name: 'Worker', origin: 'compiler' }
type ContextMode = 'unique' | 'absent' | 'wrong' | 'ambiguous' | 'undefined' | 'missing-unique' | 'delayed' | 'late' | 'stale-only' | 'changing' | 'exception' | 'malformed-nonce' | 'live-cap' | 'history-cap' | 'descriptor-cap'
type RuntimeFault = 'none' | 'enable-once' | 'enable-always' | 'enable-close' | 'enable-detach' | 'enable-protocol-error'
type Invalidation = { method: string; kind: 'destroy' | 'replace' | 'clear' | 'unrelated' }
const otherPort = (port: number) => (port === 65000 ? 65001 : 65000)
type FakeInspector = Awaited<ReturnType<typeof startFakeInspector>>
/** Race a promise against a bound whose losing timer is cleared; 'timeout' when the bound wins, otherwise the promise's own outcome (rejections propagate). */
async function within<T>(work: Promise<T>, ms: number): Promise<T | 'timeout'> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<'timeout'>(resolve => { timer = setTimeout(() => resolve('timeout'), ms) })
  try {
    return await Promise.race([work, expired])
  } finally {
    clearTimeout(timer)
  }
}

/** Conditional callback/event sequences, not a reconstruction of the failed OS command. No child is spawned. */
function controlledCommand(observerFault = false) {
  class Pipe extends EventEmitter {
    override on(event: string | symbol, listener: (...args: any[]) => void) {
      if (observerFault && event === 'end') throw new Error('owned observer registration failure')
      return super.on(event, listener)
    }
  }
  class Child extends EventEmitter implements ObservedCommandChild {
    pid = 4242
    killed = false
    exitCode: number | null = null
    signalCode: string | null = null
    stdout = new EventEmitter()
    stderr = new Pipe()
    killCalls = 0
    kill() { this.killCalls++; return false }
  }
  const child = new Child()
  let monotonicMs = 1000.25
  let epochMs = 1_000_000
  let callback: Parameters<NonNullable<CommandWitness['invoke']>>[3] | undefined
  const invocations: { file: string; args: string[]; encoding: string | undefined; timeout: number | undefined; killSignal: string | number | undefined; maxBuffer: number | undefined; TZ: string | undefined; LC_ALL: string | undefined }[] = []
  const witness: CommandWitness = {
    now: () => monotonicMs, wallNow: () => epochMs,
    invoke(file, args, options, done) {
      invocations.push({ file, args: [...args], encoding: options.encoding, timeout: options.timeout, killSignal: options.killSignal, maxBuffer: options.maxBuffer, TZ: options.env?.TZ, LC_ALL: options.env?.LC_ALL })
      callback = done
      return child
    },
  }
  return {
    child, witness, invocations,
    at(time: number, wall = 1_000_000) { monotonicMs = time; epochMs = wall },
    complete(error: ExecFileFailure | null, stdout = '', stderr = '') {
      if (!callback) throw new Error('Controlled command callback has not been acquired')
      callback(error, stdout, stderr)
    },
  }
}
function literalCommandRuntime(): OwnedRuntime {
  return {
    endpoints: validateOwnedEndpoints('http://127.0.0.1:8790/', '9230'), registryPath: '(controlled command witness; no OS child)', registeredPids: [4242], listeners: [],
    workerd: [{ pid: 4242, ppid: 1, pgid: 4242, started: 'Sat Oct 3 06:00:00 2026', command: 'workerd serve', role: 'owned-runtime', registeredAt: 0, registeredBy: 1 }],
  }
}
const COMMAND_ROW = '4242 1 4242 Sat Oct 3 06:00:00 2026 123456 workerd serve\n'
const COMMAND_ARGS = ['-o', 'pid=,ppid=,pgid=,lstart=,rss=,command=', '-p', '4242']

async function commandAcquisitionWitnesses(info: TestInfo) {
  const rows: Record<string, unknown>[] = []
  const evidence = { producerKind: 'controlled in-memory command callbacks/events; no OS child, timeout task, command or probe is executed by these rows', rows }
  let primary: { error: unknown } | null = null
  const runtime = literalCommandRuntime()
  const owned = [{ pid: 4242, role: 'owned-runtime' as const, command: 'workerd serve' }]
  const sampleAt = '2026-10-03T06:05:00.000Z'
  try {
    for (const row of [
      { name: 'timely nonempty callback', callbackAt: 6000.0, stdout: COMMAND_ROW, usable: true, diagnostic: null },
      { name: 'inclusive exact original deadline', callbackAt: 6000.25, stdout: COMMAND_ROW, usable: true, diagnostic: null },
      { name: 'late empty success before any timeout task', callbackAt: 6000.5, stdout: '', usable: false, diagnostic: 'ps callback exceeded the original 5000 ms acquisition deadline' },
      { name: 'late nonempty success before any timeout task', callbackAt: 6000.5, stdout: COMMAND_ROW, usable: false, diagnostic: 'ps callback exceeded the original 5000 ms acquisition deadline' },
    ]) {
      const control = controlledCommand()
      const pending = execBounded('ps', COMMAND_ARGS, 5000, control.witness)
      control.at(row.callbackAt)
      control.complete(null, row.stdout)
      const result = await pending
      const sample = sampleFromResult(runtime, result, sampleAt, 'literal')
      rows.push({ name: row.name, result, sample, invocations: control.invocations, killCalls: control.child.killCalls })
      expect(result.code).toBe(0)
      expect(result.stdout).toBe(row.stdout)
      expect(result.stderr).toBe('')
      expect(result.diagnostic).toBe(row.diagnostic)
      expect(result.observation).toMatchObject({ startedAt: { monotonicMs: 1000.25 }, deadline: 6000.25, callbackCount: 1, settlements: 1, callback: { at: { monotonicMs: row.callbackAt }, code: 0, error: null }, available: row.usable })
      expect(control.invocations).toEqual([{ file: 'ps', args: ['-o', 'pid=,ppid=,pgid=,lstart=,rss=,command=', '-p', '4242'], encoding: 'utf8', timeout: 5000, killSignal: 'SIGKILL', maxBuffer: 16_777_216, TZ: 'UTC', LC_ALL: 'C' }])
      expect(control.child.killCalls).toBe(0)
      expect(summarizeSamples(owned, [sample], 0, []).usable).toBe(row.usable)
      if (!row.usable) {
        expect(sample.processes).toEqual([{ pid: 4242, role: 'owned-runtime', rssKiB: null, availability: 'missing-row' }])
        expect(sample.commandError).toBe('ps callback exceeded the original 5000 ms acquisition deadline')
        expect(classifyListenerResult(result).kind).toBe('error')
      } else {
        expect(sample.processes).toEqual([{ pid: 4242, role: 'owned-runtime', rssKiB: 123456, availability: 'valid' }])
      }
    }

    const ordering = controlledCommand()
    const orderedPending = execBounded('ps', COMMAND_ARGS, 5000, ordering.witness)
    ordering.at(5999.75)
    ordering.child.stdout.emit('data', '가')
    ordering.child.stderr.emit('data', Buffer.from('x'))
    ordering.child.emit('exit', 0, null)
    ordering.child.exitCode = 0
    ordering.child.stdout.emit('end')
    ordering.child.stderr.emit('end')
    ordering.at(6000.0)
    ordering.complete(null, COMMAND_ROW)
    const ordered = await orderedPending
    const callbackFacts = ordered.observation!.callback!
    expect(callbackFacts.observedAtCallback).toEqual({ exit: 1, close: 0, stdoutEnd: 1, stdoutClose: 0, stderrEnd: 1, stderrClose: 0, observerFailures: 0 })
    expect(ordered.observation!.child.close.first).toBeNull()
    ordering.at(6000.25)
    ordering.child.stdout.emit('close')
    ordering.child.stderr.emit('close')
    ordering.child.emit('close', 0, null)
    rows.push({ name: 'callback before later observers keeps callback-time and final facts separate', result: ordered })
    expect(callbackFacts.observedAtCallback.close).toBe(0)
    expect(ordered.observation!.child.close.count).toBe(1)
    expect(ordered.observation!.child.close.first!.order).toBeGreaterThan(callbackFacts.order)
    expect(ordered.observation!.child.close.first!.at.monotonicMs).toBe(6000.25)
    expect(ordered.observation!.stdout.data).toMatchObject({ count: 1, decodedUtf8Bytes: 3, bufferBytes: 0, unknownChunks: 0 })
    expect(ordered.observation!.stderr.data).toMatchObject({ count: 1, decodedUtf8Bytes: 0, bufferBytes: 1, unknownChunks: 0 })
    expect(ordered.diagnostic).toBeNull()

    const earlier = controlledCommand()
    const earlierPending = execBounded('ps', COMMAND_ARGS, 5000, earlier.witness)
    earlier.at(6000.5)
    const originalError = Object.assign(new Error('spawn ps ENOENT'), { code: 'ENOENT', killed: false })
    earlier.complete(originalError, 'original partial output', 'original stderr')
    const failed = await earlierPending
    const firstCallback = failed.observation!.callback
    expect(failed.diagnostic).toBe('Error: spawn ps ENOENT')
    earlier.at(7000.25)
    // Supplied close without end and a later callback are conditional evidence;
    // neither rewrites the original failure or renews its deadline.
    earlier.child.stdout.emit('close')
    earlier.child.stderr.emit('close')
    earlier.child.emit('close', 0, null)
    earlier.complete(null, COMMAND_ROW, 'later output is not substituted')
    rows.push({ name: 'earlier failure, close without end and duplicate late callback stay failed once', result: failed })
    expect(failed.code).toBeNull()
    expect(failed.stdout).toBe('original partial output')
    expect(failed.stderr).toBe('original stderr')
    expect(failed.diagnostic).toBe('Error: spawn ps ENOENT')
    expect(failed.observation!.callback).toBe(firstCallback)
    expect(failed.observation).toMatchObject({ deadline: 6000.25, callbackCount: 2, settlements: 1, available: false, stdout: { end: { count: 0 }, close: { count: 1 } }, stderr: { end: { count: 0 }, close: { count: 1 } }, child: { close: { first: { at: { monotonicMs: 7000.25 } } } }, observerFailures: { count: 1 } })
    expect(failed.observation!.callback!.error).toMatchObject({ text: { text: 'Error: spawn ps ENOENT', truncated: false }, code: { text: 'ENOENT' }, signal: null, killed: false })
    expect(failed.observation!.laterCallback).toMatchObject({ code: 0, at: { monotonicMs: 7000.25 } })
    expect(earlier.invocations).toHaveLength(1)
    expect(earlier.child.killCalls).toBe(0)

    for (const row of [
      { name: 'numeric exit1 empty is lost identity', stdout: '', stderr: '', expected: null, listeners: 'none' },
      { name: 'numeric exit1 rows remains a failed command', stdout: COMMAND_ROW, stderr: '', expected: 'ps -p exited 1 with rows on stdout', listeners: 'error' },
      { name: 'numeric exit1 stderr remains a failed command', stdout: '', stderr: 'ps: illegal option\n', expected: 'ps -p exited 1 with stderr "ps: illegal option"', listeners: 'error' },
    ]) {
      const control = controlledCommand()
      const pending = execBounded('ps', COMMAND_ARGS, 5000, control.witness)
      control.at(6000.0)
      control.complete(Object.assign(new Error('Command failed: ps'), { code: 1, killed: false }), row.stdout, row.stderr)
      const result = await pending
      const sample = sampleFromResult(runtime, result, sampleAt, 'numeric-exit')
      rows.push({ name: row.name, result, sample })
      expect(result).toMatchObject({ code: 1, stdout: row.stdout, stderr: row.stderr, diagnostic: null, killed: false })
      expect(sample.commandError).toBe(row.expected)
      expect(sample.processes).toEqual([{ pid: 4242, role: 'owned-runtime', rssKiB: null, availability: 'missing-row' }])
      expect(sample.identityProblems).toEqual(row.expected === null ? ['owned-runtime workerd 4242 is gone'] : [])
      expect(classifyListenerResult(result).kind).toBe(row.listeners)
      expect(summarizeSamples(owned, [sample], 0, []).usable).toBe(false)
    }
    for (const row of [
      { name: 'ENOENT raw error', error: Object.assign(new Error('spawn ps ENOENT'), { code: 'ENOENT' }), expected: 'Error: spawn ps ENOENT', stdout: '', rawCode: null },
      { name: 'signal kill preserves partial output and returned-child flag separately', error: Object.assign(new Error('Command failed: ps'), { signal: 'SIGKILL', killed: true }), expected: 'Error: Command failed: ps', stdout: 'partial owned row\n', rawCode: null },
      { name: 'maxBuffer failure retains the complete supplied partial output', error: Object.assign(new Error('stdout maxBuffer length exceeded'), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }), expected: 'Error: stdout maxBuffer length exceeded', stdout: `${'x'.repeat(4100)}tail`, rawCode: null },
      { name: 'maxBuffer killed callback retains overflow cause without a timeout claim', error: Object.assign(new Error('stdout maxBuffer length exceeded'), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', signal: 'SIGKILL', killed: true }), expected: 'Error: stdout maxBuffer length exceeded', stdout: 'retained overflow prefix\n', rawCode: null },
      { name: 'nonnull callback error with numeric code0 remains a failure', error: Object.assign(new Error('supplied zero-code callback error'), { code: 0 }), expected: 'Error: supplied zero-code callback error', stdout: COMMAND_ROW, rawCode: 0 },
    ]) {
      const control = controlledCommand()
      const pending = execBounded('ps', COMMAND_ARGS, 5000, control.witness)
      if ('killed' in row.error) control.child.killed = true
      control.at(6000.0)
      control.complete(row.error, row.stdout, 'retained stderr')
      const result = await pending
      const sample = sampleFromResult(runtime, result, sampleAt, 'failure')
      rows.push({ name: row.name, result, sample })
      expect(result.diagnostic).toBe(row.expected)
      expect(sample.commandError).toBe(row.expected)
      expect(sample.raw).toEqual({ code: row.rawCode, stdout: row.stdout, stderr: 'retained stderr' })
      expect(result.observation).toMatchObject({ startedAt: { monotonicMs: 1000.25 }, deadline: 6000.25, callbackCount: 1, settlements: 1, callback: { at: { monotonicMs: 6000.0 }, error: { text: { text: row.expected } } } })
      expect(result.observation!.child.close.first).toBeNull()
      expect(control.child.killCalls).toBe(0)
      expect(summarizeSamples(owned, [sample], 0, []).peakRssKiBByPid).toEqual({ '4242': null })
      expect(summarizeSamples(owned, [sample], 0, []).usable).toBe(false)
      expect(classifyListenerResult(result)).toEqual({ kind: 'error', reason: row.expected })
      if (row.name.startsWith('signal')) {
        expect(result.observation!.callback).toMatchObject({ code: null, error: { code: null, signal: { text: 'SIGKILL' }, killed: true }, childFlags: { killed: true, exitCode: null, signalCode: null } })
      }
      if (row.name.startsWith('maxBuffer killed')) {
        expect(result.killed).toBe(true)
        expect(result.observation!.callback).toMatchObject({ code: { text: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }, error: { code: { text: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }, signal: { text: 'SIGKILL' }, killed: true }, childFlags: { killed: true, exitCode: null, signalCode: null } })
      }
      if (row.name.startsWith('maxBuffer')) expect(result.observation!.callback!.output.maxBufferFailureReported).toBe(true)
    }

    for (const originalFailure of [false, true]) {
      const control = controlledCommand(true)
      const pending = execBounded('ps', COMMAND_ARGS, 5000, control.witness)
      control.at(6000.0)
      control.complete(originalFailure ? originalError : null, COMMAND_ROW)
      const result = await pending
      rows.push({ name: originalFailure ? 'observer failure remains secondary to original ENOENT' : 'observer failure cannot make code0 usable', result })
      expect(result.observation!.observerFailures).toMatchObject({ count: 1, first: { source: { text: 'stderr end listener' }, error: { text: 'Error: owned observer registration failure' } } })
      expect(result.observation!.stderr.attached).toEqual({ data: true, end: false, close: true, error: true })
      expect(result.diagnostic).toBe(originalFailure ? 'Error: spawn ps ENOENT' : 'Command observation failed (1 recorded observer failures)')
      expect(result.observation!.available).toBe(false)
      expect(summarizeSamples(owned, [sampleFromResult(runtime, result, sampleAt, 'observer')], 0, []).usable).toBe(false)
    }

    const lateObserver = controlledCommand()
    const lateObserverPending = execBounded('ps', COMMAND_ARGS, 5000, lateObserver.witness)
    lateObserver.at(6000.0)
    lateObserver.complete(null, COMMAND_ROW)
    const previouslyValid = await lateObserverPending
    const observedSample = sampleFromResult(runtime, previouslyValid, sampleAt, 'observer-after-callback')
    const beforeObserverFailure = summarizeSamples(owned, [observedSample], 0, [])
    expect(beforeObserverFailure.usable).toBe(true)
    // Invalid supplied chunks fail observation rather than escaping an event
    // handler; no chunk body is retained and later failures remain bounded.
    expect(() => lateObserver.child.stdout.emit('data', { supplied: 'not a decoded string or Buffer' })).not.toThrow()
    expect(() => lateObserver.child.stdout.emit('data', null)).not.toThrow()
    expect(() => lateObserver.child.stdout.emit('data', 42)).not.toThrow()
    rows.push({ name: 'later observer failures invalidate even an earlier successful summary', result: previouslyValid, sample: observedSample, current: summarizeSamples(owned, [observedSample], 0, []) })
    expect(previouslyValid.observation!.observerFailures).toMatchObject({ count: 3, omitted: 1, first: { source: { text: 'stdout data' } }, last: { source: { text: 'stdout data' } } })
    expect(previouslyValid.observation!.stdout.data.unknownChunks).toBe(3)
    expect(previouslyValid.observation!.callback!.observedAtCallback.observerFailures).toBe(0)
    expect(() => requireUsableMemory(beforeObserverFailure)).toThrow('Command observation failed (3 recorded observer failures)')
    expect(summarizeSamples(owned, [observedSample], 0, []).peakRssKiBByPid).toEqual({ '4242': null })

    const nativeError = controlledCommand()
    const nativeErrorPending = execBounded('ps', COMMAND_ARGS, 5000, nativeError.witness)
    nativeError.child.stderr.emit('error', Object.assign(new Error('supplied pipe failure'), { code: 'EIO' }))
    nativeError.at(6000.0)
    nativeError.complete(null, COMMAND_ROW)
    const nativeFailed = await nativeErrorPending
    rows.push({ name: 'supplied pipe error remains separate from a null callback error', result: nativeFailed })
    expect(nativeFailed.observation!.callback!.error).toBeNull()
    expect(nativeFailed.observation!.stderr.error).toMatchObject({ count: 1, first: { error: { text: { text: 'Error: supplied pipe failure' }, code: { text: 'EIO' } } } })
    expect(nativeFailed.diagnostic).toBe('Command child/stdio error was observed')
    expect(summarizeSamples(owned, [sampleFromResult(runtime, nativeFailed, sampleAt, 'pipe-error')], 0, []).usable).toBe(false)

    const metadata = controlledCommand()
    const metadataPending = execBounded('ps', ['가'.repeat(2000)], 5000, metadata.witness)
    metadata.at(6000.0)
    metadata.complete(new Error('가'.repeat(2000)), 'raw-output-once', 'raw-stderr-once')
    const bounded = await metadataPending
    rows.push({ name: 'UTF8 metadata bounds preserve original lengths and explicit truncation', result: bounded })
    expect(bounded.observation!.argv).toMatchObject({ originalBytes: 6004, retainedBytes: 4094, truncated: true })
    expect(bounded.observation!.callback!.error!.text).toMatchObject({ originalBytes: 6007, retainedBytes: 4096, truncated: true })
    expect(bounded.stdout).toBe('raw-output-once')
    expect(bounded.stderr).toBe('raw-stderr-once')

    const changedControl = controlledCommand()
    const changedPending = execBounded('ps', COMMAND_ARGS, 5000, changedControl.witness)
    changedControl.at(6000.0)
    changedControl.complete(null, '4242 1 4243 Sat Oct 3 06:00:00 2026 123456 workerd serve\n')
    const changedResult = await changedPending
    const changedSample = sampleFromResult(runtime, changedResult, sampleAt, 'changed-identity')
    rows.push({ name: 'timely acquisition does not waive changed process identity', result: changedResult, sample: changedSample })
    expect(changedSample.identityProblems).toEqual(['owned-runtime workerd 4242 changed pgid: 4242 -> 4243'])
    expect(summarizeSamples(owned, [changedSample], 0, []).usable).toBe(false)

    const phaseControl = controlledCommand()
    const phaseSampler = new MemorySampler(runtime, phaseControl.witness)
    phaseSampler.phase = 'dispatch-phase'
    const phasePending = phaseSampler.sampleOnce()
    phaseSampler.phase = 'callback-phase'
    phaseControl.at(6000.0, 1_005_000)
    phaseControl.complete(null, COMMAND_ROW)
    phaseSampler.phase = 'completion-phase'
    phaseControl.at(6000.25, 1_005_001)
    const phaseSample = await phasePending
    rows.push({ name: 'pending sample keeps dispatch callback and legacy completion phases', sample: phaseSample })
    expect(phaseSample.phase).toBe('completion-phase')
    expect(phaseSample.at).toBe('1970-01-01T00:16:45.001Z')
    expect(phaseSample.provenance).toEqual({
      dispatch: { phase: 'dispatch-phase', at: { monotonicMs: 1000.25, epochMs: 1_000_000 } },
      callback: { phase: 'callback-phase', at: { monotonicMs: 6000.0, epochMs: 1_005_000 } },
      completion: { phase: 'completion-phase', at: { monotonicMs: 6000.25, epochMs: 1_005_001 } },
    })
    expect(phaseControl.invocations).toHaveLength(1)

    const clockControl = controlledCommand()
    let completionClockFails = false
    const clockSampler = new MemorySampler(runtime, {
      ...clockControl.witness,
      now: () => { if (completionClockFails) throw new Error('supplied completion clock failure'); return clockControl.witness.now!() },
    })
    const clockPending = clockSampler.sampleOnce()
    clockControl.at(6000.0)
    clockControl.complete(null, COMMAND_ROW)
    completionClockFails = true
    const clockSample = await clockPending
    rows.push({ name: 'completion observer failure retains the original command output and invalidates the sample', sample: clockSample })
    expect(clockSample.raw).toEqual({ code: 0, stdout: COMMAND_ROW, stderr: '' })
    expect(clockSample.provenance!.completion.at.monotonicMs).toBeNull()
    expect(clockSample.commandObservation!.observerFailures).toMatchObject({ count: 1, first: { source: { text: 'sample completion monotonicMs' }, error: { text: 'Error: supplied completion clock failure' } } })
    expect(clockSampler.summary().usable).toBe(false)
    expect(() => requireUsableMemory(clockSampler.summary())).toThrow('Command observation failed (1 recorded observer failures)')

    const intervalControl = controlledCommand()
    const intervalSampler = new MemorySampler(runtime, intervalControl.witness)
    intervalSampler.phase = 'valid-first'
    const first = intervalSampler.sampleOnce()
    intervalControl.at(6000.0)
    intervalControl.complete(null, '4242 1 4242 Sat Oct 3 06:00:00 2026 100000 workerd serve\n')
    await first
    intervalControl.at(10000.25)
    intervalSampler.phase = 'invalid-middle'
    const middle = intervalSampler.sampleOnce()
    intervalControl.at(15000.5)
    intervalControl.complete(null)
    await middle
    intervalControl.at(20000.25)
    intervalSampler.phase = 'valid-last'
    const last = intervalSampler.sampleOnce()
    intervalControl.at(25000.0)
    intervalControl.complete(null, '4242 1 4242 Sat Oct 3 06:00:00 2026 120000 workerd serve\n')
    await last
    const interval = intervalSampler.summary()
    rows.push({ name: 'valid late-empty-invalid valid interval remains unusable', summary: interval, invocations: intervalControl.invocations })
    expect(interval.sampleCount).toBe(3)
    expect(interval.validSampleCount).toBe(2)
    expect(interval.invalidSamples).toHaveLength(1)
    expect(interval.invalidSamples[0].phase).toBe('invalid-middle')
    expect(interval.samples[1].raw).toEqual({ code: 0, stdout: '', stderr: '' })
    expect(interval.samples[1].commandObservation).toMatchObject({ startedAt: { monotonicMs: 10000.25 }, deadline: 15000.25, callback: { at: { monotonicMs: 15000.5 } }, available: false })
    expect(interval.peakRssKiBByPid).toEqual({ '4242': 120000 })
    expect(interval.usable).toBe(false)
    expect(() => requireUsableMemory(interval)).toThrow('original 5000 ms acquisition deadline')
    expect(intervalControl.invocations).toHaveLength(3)
    expect(intervalControl.child.killCalls).toBe(0)

    // A timely empty acquisition has missing RSS, without establishing why the row is absent.
    const timelyEmptyControl = controlledCommand()
    const timelyEmptyPending = execBounded('ps', COMMAND_ARGS, 5000, timelyEmptyControl.witness)
    timelyEmptyControl.at(6000.0)
    timelyEmptyControl.complete(null)
    const timelyEmptyResult = await timelyEmptyPending
    const timelyEmptySample = sampleFromResult(runtime, timelyEmptyResult, '2026-10-03T06:06:01.000Z', 'timely-empty-middle')
    const timelyEmptyInterval = summarizeSamples(owned, [
      sampleFromResult(runtime, { code: 0, stdout: '4242 1 4242 Sat Oct 3 06:00:00 2026 100000 workerd serve\n', stderr: '', diagnostic: null, killed: false }, '2026-10-03T06:06:00.000Z', 'valid-first'),
      timelyEmptySample,
      sampleFromResult(runtime, { code: 0, stdout: '4242 1 4242 Sat Oct 3 06:00:00 2026 120000 workerd serve\n', stderr: '', diagnostic: null, killed: false }, '2026-10-03T06:06:02.000Z', 'valid-last'),
    ], 0, [])
    rows.push({ name: 'valid timely-empty-invalid valid interval remains unusable without a timing failure', result: timelyEmptyResult, summary: timelyEmptyInterval, invocations: timelyEmptyControl.invocations })
    expect(timelyEmptyResult).toMatchObject({ code: 0, stdout: '', stderr: '', diagnostic: null, killed: false })
    expect(timelyEmptySample.commandObservation).toMatchObject({ startedAt: { monotonicMs: 1000.25 }, deadline: 6000.25, callbackCount: 1, settlements: 1, callback: { at: { monotonicMs: 6000.0 }, code: 0, error: null }, available: true })
    expect(timelyEmptySample.commandError).toBeNull()
    expect(timelyEmptySample.raw).toEqual({ code: 0, stdout: '', stderr: '' })
    expect(timelyEmptySample.processes).toEqual([{ pid: 4242, role: 'owned-runtime', rssKiB: null, availability: 'missing-row' }])
    expect(timelyEmptyInterval.sampleCount).toBe(3)
    expect(timelyEmptyInterval.validSampleCount).toBe(2)
    expect(timelyEmptyInterval.invalidSamples).toHaveLength(1)
    expect(timelyEmptyInterval.invalidSamples[0].phase).toBe('timely-empty-middle')
    expect(timelyEmptyInterval.samples.map(sample => sample.processes[0].rssKiB)).toEqual([100000, null, 120000])
    expect(timelyEmptyInterval.peakRssKiBByPid).toEqual({ '4242': 120000 })
    expect(timelyEmptyInterval.usable).toBe(false)
    expect(() => requireUsableMemory(timelyEmptyInterval)).toThrow('missing-row')
    expect(timelyEmptyControl.invocations).toHaveLength(1)
    expect(timelyEmptyControl.child.killCalls).toBe(0)
  } catch (error) {
    primary = { error }
  }
  await finalizeCase(info, 'bounded-command-acquisition-witnesses', evidence, primary, [])
}

async function cooperativeContentWitnesses(info: TestInfo) {
  const evidence: Record<string, unknown> = {}
  let primary: { error: unknown } | null = null
  try {
    const visits: string[] = []
    let finished = false
    let pendingObservation: { finished: boolean; visits: string[] } | undefined
    const pendingTurn = new Promise<void>(resolve => setImmediate(() => {
      pendingObservation = { finished, visits: [...visits] }
      resolve()
    }))
    try {
      await cooperativeForEach([
        { name: 'A', jobs: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17] },
        { name: 'B', jobs: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17] },
      ], async board => {
        visits.push(board.name)
        await cooperativeForEach(board.jobs, job => { visits.push(`${board.name}${job}`) })
      })
      finished = true
    } finally { await pendingTurn }
    evidence.completeNestedWalk = { visits, pendingObservation, finished }
    expect(visits).toEqual(['A', 'A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7', 'A8', 'A9', 'A10', 'A11', 'A12', 'A13', 'A14', 'A15', 'A16', 'A17', 'B', 'B1', 'B2', 'B3', 'B4', 'B5', 'B6', 'B7', 'B8', 'B9', 'B10', 'B11', 'B12', 'B13', 'B14', 'B15', 'B16', 'B17'])
    expect(pendingObservation).toEqual({ finished: false, visits: ['A', 'A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7', 'A8', 'A9', 'A10', 'A11', 'A12', 'A13', 'A14', 'A15', 'A16'] })

    const failedVisits: number[] = []
    let turnServiced = false
    let servicedAtFailure = false
    let originalAssertion: unknown
    let propagated: unknown
    const pendingBeforeFailure = new Promise<void>(resolve => setImmediate(() => { turnServiced = true; resolve() }))
    try {
      await cooperativeForEach([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 999, 18], item => {
        failedVisits.push(item)
        if (item === 999) {
          servicedAtFailure = turnServiced
          try { expect(item, 'literal wrong late item must remain wrong').toBe(17) }
          catch (error) { originalAssertion = error; throw error }
        }
      })
    } catch (error) { propagated = error }
    finally { await pendingBeforeFailure }
    evidence.lateFailure = { visits: failedVisits, servicedAtFailure, identicalAssertion: propagated === originalAssertion, error: String(propagated) }
    expect(failedVisits).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 999])
    expect(servicedAtFailure).toBe(true)
    expect(originalAssertion).toBeInstanceOf(Error)
    expect(propagated).toBe(originalAssertion)
    expect(String(propagated)).toContain('literal wrong late item must remain wrong')
  } catch (error) {
    primary = { error }
  }
  await finalizeCase(info, 'cooperative-content-witnesses', evidence, primary, [])
}

/**
 * C2 synthetic sampler witness, not workerd. The finite child stays alive on
 * its retained stdin until EOF, with a 15s self-expiry as a last resort. Error,
 * exit/reaping, close and every stdio close are latched before awaiting it.
 */
function acquireSamplerChild() {
  const spawnedAt = Date.now()
  const child = spawn(process.execPath, ['-e', `/* orbit-capacity-owned-child */ const timer = setTimeout(() => { process.exitCode = 2; process.stdin.destroy(); }, 15000); process.stdin.resume(); process.stdin.on('end', () => { clearTimeout(timer); process.stdout.write('input-ended\\n'); }); process.stdout.write('held-ready\\n');`], { stdio: ['pipe', 'pipe', 'pipe'] })
  const observation = {
    kind: 'synthetic owned sampler child, not native workerd', spawnedAt, pid: child.pid ?? null,
    identity: null as ProcessIdentity | null, stdout: '', stderr: '', errors: [] as string[],
    exit: null as { code: number | null; signal: NodeJS.Signals | null } | null,
    close: null as { code: number | null; signal: NodeJS.Signals | null } | null,
    stdioClosed: { stdin: false, stdout: false, stderr: false }, eofRequested: false, fallbackTerminationRequested: false,
  }
  let readyResolve!: () => void
  let readyReject!: (error: Error) => void
  const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject })
  ready.catch(() => {})
  let closeResolve!: () => void
  const closed = new Promise<void>(resolve => { closeResolve = resolve })
  child.on('error', error => { observation.errors.push(String(error)); readyReject(error) })
  child.on('exit', (code, signal) => { observation.exit = { code, signal }; if (!observation.stdout.includes('held-ready\n')) readyReject(new Error('Owned child exited before its handshake')) })
  child.on('close', (code, signal) => { observation.close = { code, signal }; closeResolve() })
  for (const name of ['stdin', 'stdout', 'stderr'] as const) {
    child[name].on('close', () => { observation.stdioClosed[name] = true })
    child[name].on('error', error => { observation.errors.push(`${name}: ${String(error)}`); readyReject(error) })
  }
  child.stdout.on('data', data => {
    observation.stdout += String(data)
    if (observation.stdout.includes('held-ready\n')) readyResolve()
  })
  child.stderr.on('data', data => { observation.stderr += String(data) })
  let cleanup: Promise<{ confirmed: boolean; failures: string[]; observation: typeof observation }> | undefined
  const stop = () => cleanup ??= (async () => {
    const failures: string[] = []
    if (!observation.close) {
      observation.eofRequested = true
      try { child.stdin.end() } catch (error) {
        failures.push(`owned stdin EOF: ${String(error)}`)
        try { child.stdin.destroy() } catch (destroyError) { failures.push(`owned stdin close: ${String(destroyError)}`) }
      }
      if (await within(closed, 5_000) === 'timeout') {
        failures.push('Owned child did not exit/reap/close within 5000 ms of EOF')
        // Only this still-retained child handle can be terminated. Never search
        // for a replacement PID, and never signal after its exit was observed.
        if (!observation.exit && child.exitCode === null && child.signalCode === null) {
          observation.fallbackTerminationRequested = true
          try { if (!child.kill('SIGTERM')) failures.push('Owned child handle refused SIGTERM') } catch (error) { failures.push(`owned child termination: ${String(error)}`) }
        }
        if (await within(closed, 5_000) === 'timeout') failures.push('Owned child closure remains unconfirmed after bounded fallback join')
      }
    }
    failures.push(...observation.errors)
    const confirmed = observation.exit !== null && observation.close !== null && Object.values(observation.stdioClosed).every(Boolean)
    if (!confirmed) failures.push('Owned child exit/reaping and every stdio closure were not all observed')
    return { confirmed, failures, observation }
  })()
  return { child, ready, observation, stop }
}

/**
 * The fake proxy owns every resource it acquires (MCR82-R13): if a later
 * acquisition step (reserved-port check, ws dependency, WebSocket server) fails
 * after the HTTP listener is up, the acquired listener and sockets are closed and
 * the original error is preserved. Its close is idempotent and dependency-correct:
 * owned raw sockets (upgraded WebSocket clients included) are destroyed FIRST, so
 * the WebSocket server shutdown never waits on a client the factory itself must
 * close; the WebSocket and HTTP shutdowns are then attempted independently within
 * bounds and every failure is reported together.
 */
async function startFakeInspector(scriptedDispatch?: ScriptedDispatch) {
  const state = {
    mode: 'ok' as Mode, contextMode: 'unique' as ContextMode, runtimeFault: 'none' as RuntimeFault,
    upgrades: 0, calls: [] as string[], requests: [] as { client: number; method: string; params: Record<string, unknown> }[],
    unavailableRestoration: [] as { fault: RuntimeFault; socketReadyState: number }[],
    isolateCalls: 0, runtimeEnabled: true, freshInventories: 0, staleReplay: false,
    invalidate: null as Invalidation | null, cleanupStopError: false, cleanupIdentity: 'same' as 'same' | 'changed' | 'absent' | 'lost-after-stop',
    profileMayBeEnabled: false, profileMayBeRunning: false, invalidations: 0,
  }
  const sockets = new Set<Socket>()
  const webSockets = new Set<Socket>()
  let port = 0
  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://fake.invalid')
    const target = { id: '0c9e1f2a-3b4c-4d5e-8f60-718293a4b5c6', type: PINNED_WRANGLER.targetType, title: PINNED_WRANGLER.targetTitle, description: PINNED_WRANGLER.targetDescription, webSocketDebuggerUrl: `ws://127.0.0.1:${port}${PINNED_WRANGLER.webSocketPath}` }
    if (url.pathname === '/json' || url.pathname === '/json/list') {
      const targets = state.mode === 'two-targets' ? [target, { ...target, id: '1c9e1f2a-3b4c-4d5e-8f60-718293a4b5c6' }]
        : state.mode === 'foreign-endpoint' ? [{ ...target, webSocketDebuggerUrl: 'ws://127.0.0.1:1/ws' }] : [target]
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify(targets))
      return
    }
    if (url.pathname === '/json/version') {
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ Browser: state.mode === 'wrong-version' ? 'wrangler/v0.0.0' : PINNED_WRANGLER.browser, 'Protocol-Version': PINNED_WRANGLER.protocolVersion }))
      return
    }
    response.writeHead(404)
    response.end()
  })
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)) })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  port = (server.address() as AddressInfo).port
  const closeHttp = () => new Promise<void>((resolve, reject) => {
    server.closeAllConnections()
    server.close(error => error ? reject(error) : resolve())
  })
  /**
   * Dependency-correct, bounded, independent cleanup of whatever was acquired; failures are collected, never masked. Each acquired resource
   * is attempted on its own: a WebSocket server close that times out, reports a callback error or throws from its invocation is recorded,
   * and the HTTP listener close is still attempted within its own bound (MCR82-R13 completion; MFIN82-C1 / ACR82-R05-2).
   */
  const closeAll = async (webSocketServer: WsServerLike | undefined): Promise<void> => {
    const failures: string[] = []
    for (const socket of sockets) socket.destroy()
    if (webSocketServer) {
      try {
        // A callback error rejects (it is never resolved as closed); an exception thrown by the invocation itself rejects the executor's promise.
        const closed = await within(new Promise<'closed'>((resolve, reject) => webSocketServer.close(error => error ? reject(error) : resolve('closed'))), 5_000)
        if (closed === 'timeout') failures.push('WebSocket server did not close within 5 s')
      } catch (error) {
        failures.push(`WebSocket server close: ${String(error)}`)
      }
    }
    try {
      const closed = await within(closeHttp(), 5_000)
      if (closed === 'timeout') failures.push('HTTP listener did not close within 5 s')
    } catch (error) {
      failures.push(`HTTP listener close: ${String(error)}`)
    }
    if (failures.length) throw new Error(`fake inspector cleanup: ${failures.join('; ')}`)
  }
  let wss: WsServerLike | undefined
  try {
    if (port === 8787 || port === 8790) throw new Error('The fake inspector must not use a reserved local port')
    const ws = await loadWs()
    wss = new ws.WebSocketServer({ server, path: PINNED_WRANGLER.webSocketPath }) as unknown as WsServerLike
    wss.on('connection', (socket, request) => {
      state.upgrades++
      const client = state.upgrades
      let enableAttempts = 0
      let cleanupIdentityCalls = 0
      const liveContexts = new Map<string, { descriptor: ContextDescriptor; nonce: string | undefined }>()
      const event = (method: string, params?: unknown) => socket.send(JSON.stringify({ method, ...(params === undefined ? {} : { params }) }))
      const created = (descriptor: ContextDescriptor, nonce: string | undefined) => {
        liveContexts.set(descriptor.uniqueId, { descriptor, nonce })
        event('Runtime.executionContextCreated', { context: descriptor })
      }
      const freshInventory = () => {
        state.freshInventories++
        if (state.contextMode === 'absent' || state.contextMode === 'stale-only') return
        if (state.contextMode === 'missing-unique') {
          event('Runtime.executionContextCreated', { context: { id: 7, name: 'Worker', origin: '' } })
          return
        }
        if (state.contextMode === 'live-cap') {
          for (let index = 1; index <= 17; index++) created({ id: index, uniqueId: `context-${index}`, name: '', origin: '' }, NONCE)
          return
        }
        if (state.contextMode === 'history-cap') {
          for (let index = 0; index < 129; index++) event('Runtime.executionContextsCleared')
          return
        }
        if (state.contextMode === 'descriptor-cap') {
          created({ ...OWNED_CONTEXT, name: '가'.repeat(1400) }, NONCE)
          return
        }
        created(COMPILER_CONTEXT, state.contextMode === 'ambiguous' ? NONCE : undefined)
        created(OWNED_CONTEXT, state.contextMode === 'undefined' ? undefined : state.contextMode === 'wrong' || state.mode === 'nonce-mismatch' ? 'another-isolate' : NONCE)
      }
      const invalidate = (kind: Invalidation['kind']) => {
        state.invalidations++
        if (kind === 'destroy') {
          liveContexts.delete(OWNED_CONTEXT.uniqueId)
          event('Runtime.executionContextDestroyed', { executionContextId: OWNED_CONTEXT.id, executionContextUniqueId: OWNED_CONTEXT.uniqueId })
        } else if (kind === 'replace') {
          created({ ...OWNED_CONTEXT, uniqueId: 'replacement-context' }, NONCE)
        } else if (kind === 'clear') {
          liveContexts.clear()
          event('Runtime.executionContextsCleared')
        } else {
          created({ id: 9, uniqueId: 'unrelated-context', name: '', origin: '' }, undefined)
        }
      }
      const raw = request.socket
      webSockets.add(raw)
      raw.on('close', () => webSockets.delete(raw))
      if (request.headers.origin !== `http://127.0.0.1:${port}`) { socket.close(1008, 'origin'); return }
      if (state.mode === 'close-after-upgrade') { socket.close(1013, 'busy'); return }
      if (state.staleReplay) created({ id: 99, uniqueId: 'stale-replay-context', name: 'Worker', origin: '' }, NONCE)
      socket.on('message', data => {
        if (state.mode === 'invalid-json') { socket.send('not json'); return }
        if (state.mode === 'null-frame') { socket.send('null'); return }
        const message = JSON.parse(String(data)) as { id: number; method: string; params: Record<string, unknown> }
        state.calls.push(message.method)
        state.requests.push({ client, method: message.method, params: message.params })
        const reply = (result: unknown) => socket.send(JSON.stringify({ id: message.id, result }))
        const reject = (reason: string) => socket.send(JSON.stringify({ id: message.id, error: { code: -32000, message: reason } }))
        const finish = (result: unknown) => {
          // The operation may already have taken effect when an event arrives
          // before its correlated acknowledgement. The client's awaited guard
          // must reject the measurement without losing cleanup responsibility.
          if (state.invalidate?.method === message.method) {
            const invalidation = state.invalidate
            state.invalidate = null
            invalidate(invalidation.kind)
          }
          reply(result)
        }
        // Opt-in literal producer script. Every original generic witness leaves
        // this absent and follows the unchanged switch below.
        if (scriptedDispatch?.(message, socket)) return
        switch (message.method) {
          case 'Runtime.getIsolateId':
            state.isolateCalls++
            if (state.invalidations) {
              cleanupIdentityCalls++
              if (state.cleanupIdentity === 'absent') { reply({}); return }
              if (state.cleanupIdentity === 'changed' || (state.cleanupIdentity === 'lost-after-stop' && cleanupIdentityCalls > 1)) { reply({ id: 'isolate-two' }); return }
            }
            finish({ id: state.mode === 'ok-isolate-changes' && state.isolateCalls > 1 ? 'isolate-two' : 'isolate-one' })
            return
          case 'Runtime.disable':
            state.runtimeEnabled = false
            liveContexts.clear()
            reply({})
            return
          case 'Runtime.enable': {
            enableAttempts++
            if (state.runtimeFault === 'enable-close') { socket.terminate(); return }
            if (state.runtimeFault === 'enable-detach' || state.runtimeFault === 'enable-protocol-error') {
              // Keep the owned transport open: lost attribution/unusable CDP,
              // rather than readyState or peer close, must forbid restoration.
              state.unavailableRestoration.push({ fault: state.runtimeFault, socketReadyState: socket.readyState })
              if (state.runtimeFault === 'enable-detach') event('Target.detachedFromTarget', { sessionId: 'owned-session-detached' })
              else socket.send('null')
              return
            }
            if (state.runtimeFault === 'enable-always' || (state.runtimeFault === 'enable-once' && enableAttempts === 1)) {
              reject('controlled enable failure after disable')
              return
            }
            // The upstream Runtime domain survives frontend close. Re-enabling
            // an already-enabled domain does not replay context-created events.
            if (state.runtimeEnabled) { reply({}); return }
            state.runtimeEnabled = true
            if (state.contextMode === 'delayed') { queueMicrotask(() => { if (socket.readyState === 1) { freshInventory(); reply({}) } }); return }
            if (state.contextMode === 'late') { reply({}); freshInventory(); return }
            freshInventory()
            reply({})
            return
          }
          case 'Runtime.evaluate': {
            if (typeof message.params.uniqueContextId !== 'string') { reject('Cannot find default execution context'); return }
            if ('contextId' in message.params) { reject('contextId and uniqueContextId are mutually exclusive'); return }
            if (message.params.expression !== 'globalThis.__orbitIsolateNonce' || message.params.returnByValue !== true) { reject('Unexpected nonce expression'); return }
            const context = liveContexts.get(message.params.uniqueContextId)
            if (!context) { reject('uniqueContextId not found'); return }
            if (state.contextMode === 'exception') { reply({ result: { type: 'undefined' }, exceptionDetails: { text: 'controlled exception' } }); return }
            if (state.contextMode === 'malformed-nonce') { reply({ result: { type: 'string', value: 42 } }); return }
            if (state.contextMode === 'changing') invalidate('destroy')
            finish({ result: context.nonce === undefined ? { type: 'undefined' } : { type: 'string', value: context.nonce } })
            return
          }
          case 'Runtime.getHeapUsage': finish({ usedSize: 1_048_576, totalSize: 2_097_152, embedderHeapUsedSize: 0 }); return
          case 'Profiler.enable': state.profileMayBeEnabled = true; finish({}); return
          case 'Profiler.start': state.profileMayBeRunning = true; finish({}); return
          case 'Profiler.disable': state.profileMayBeEnabled = false; finish({}); return
          case 'Profiler.stop':
            if (state.cleanupStopError) { reject('controlled profile stop failure'); return }
            state.profileMayBeRunning = false
            finish({ profile: { nodes: [{ id: 1, callFrame: { functionName: '(root)' } }, { id: 2, callFrame: { functionName: '(idle)' } }], samples: [1, 2, 1], timeDeltas: state.mode === 'ok-zero-deltas' ? [0, 0, 0] : [500, 500, 500], startTime: 1, endTime: 1501 } })
            return
          case 'Witness.pending': return
          default: finish({})
        }
      })
    })
  } catch (error) {
    // Partial acquisition: close what was acquired and keep the original error (with the cleanup failure if that fails too).
    try {
      await closeAll(wss)
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'The fake inspector could not be started and its partially acquired resources could not be closed')
    }
    throw error
  }
  // Reaching this point means the acquisition block completed, so the WebSocket server exists.
  const webSocketServer = wss!
  let closing: Promise<void> | null = null
  return {
    port, state,
    endpoints: (): OwnedEndpoints => validateOwnedEndpoints(`http://127.0.0.1:${otherPort(port)}/`, port),
    /** Upgraded WebSocket connections still open on the server side (HTTP keep-alive sockets are not counted). */
    openWebSockets: () => webSockets.size,
    /** Pause every raw connection so no further frame, including a close reply, reaches the client. */
    stall: () => { for (const socket of sockets) socket.pause() },
    /** Idempotent: owned connections destroyed first, then bounded independent WebSocket/HTTP shutdown. */
    close: () => (closing ??= closeAll(webSocketServer)),
  }
}

test('storeRoute frames the exact once-serialized UTF-8 JSON for DELETE, preserves null and an absent body, and leaves explicit low-level framing intact', async ({}, info) => {
  const evidence: Record<string, unknown> = { wire: [] }
  const wire = evidence.wire as unknown[]
  const sockets = new Set<Socket>()
  const serverErrors: string[] = []
  let server: Server | undefined
  let primary: { error: unknown } | null = null
  try {
    server = createServer((request, response) => {
      const chunks: Buffer[] = []
      request.on('error', error => serverErrors.push(String(error)))
      request.on('data', chunk => chunks.push(chunk))
      request.on('end', () => {
        const bytes = Buffer.concat(chunks)
        const received = { method: request.method, path: request.url, headers: request.headers, body: bytes.toString('utf8'), bytes: bytes.length, hex: bytes.toString('hex') }
        wire.push(received)
        response.writeHead(200, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify(received))
      })
    })
    server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)) })
    await new Promise<void>((resolve, reject) => { server!.once('error', reject); server!.listen(0, '127.0.0.1', resolve) })
    const port = (server.address() as AddressInfo).port
    if (port === 8787 || port === 8790) throw new Error('The wire witness acquired a reserved port')
    const origin = `http://127.0.0.1:${port}`
    evidence.port = port
    let serializations = 0
    type Received = { method: string; headers: Record<string, string>; body: string; bytes: number; hex: string }
    const nonAscii = await storeRoute<Received>(origin, 'wire', { method: 'DELETE', body: { toJSON: () => { serializations++; return { message: '한글🙂' } } } })
    expect(serializations).toBe(1)
    expect(nonAscii).toMatchObject({ method: 'DELETE', body: '{"message":"한글🙂"}', bytes: 24, headers: { 'content-type': 'application/json', 'content-length': '24' } })
    expect(nonAscii.hex).toBe(Buffer.from('{"message":"한글🙂"}', 'utf8').toString('hex'))
    expect(nonAscii.headers['transfer-encoding']).toBeUndefined()
    expect(await storeRoute<Received>(origin, 'wire', { method: 'DELETE', body: null }))
      .toMatchObject({ body: 'null', bytes: 4, headers: { 'content-type': 'application/json', 'content-length': '4' } })
    const absent = await storeRoute<Received>(origin, 'wire', { method: 'DELETE' })
    expect(absent.body).toBe('')
    expect(absent.bytes).toBe(0)
    expect(absent.headers['content-type']).toBeUndefined()
    expect(absent.headers['content-length']).toBeUndefined()
    expect(absent.headers['transfer-encoding']).toBeUndefined()
    const framed = await rawRequest(origin, '/wire', { method: 'DELETE', headers: { 'Content-Type': 'custom/type', 'Content-Length': '2' }, body: 'ø' })
    expect(JSON.parse(framed.body.toString('utf8'))).toMatchObject({ body: 'ø', bytes: 2, headers: { 'content-type': 'custom/type', 'content-length': '2' } })
    const chunked = await rawRequest(origin, '/wire', { method: 'DELETE', headers: { 'Transfer-Encoding': 'chunked' }, body: '界' })
    const chunkedBody = JSON.parse(chunked.body.toString('utf8')) as Received
    expect(chunkedBody).toMatchObject({ body: '界', bytes: 3, headers: { 'transfer-encoding': 'chunked' } })
    expect(chunkedBody.headers['content-length']).toBeUndefined()
    expect(serverErrors).toEqual([])
  } catch (error) {
    primary = { error }
  }
  await finalizeCase(info, 'instrumentation-json-wire', evidence, primary, [
    { label: 'owned-wire-server-close', run: async () => {
      if (!server) return 'not acquired'
      for (const socket of sockets) socket.destroy()
      const closed = await within(new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve())), 5_000)
      if (closed === 'timeout') throw new Error('Owned wire server did not close within 5000 ms')
      return { closed: true, serverErrors }
    } },
  ])
})

/** No network resources: controllable Node-shaped emitters expose the helper's terminal-event contract. */
function heldTransportWitness(options: { response?: 'complete' | 'fail-before-end'; acquisition?: 'factory-fails' | 'flush-fails' | 'before-socket-fails'; destruction?: 'normal' | 'throws-but-closes' | 'missing-socket-close' } = {}) {
  const request = new EventEmitter()
  const socket = new EventEmitter()
  const response = new EventEmitter()
  const observation = { destroyCalls: 0, timeoutConfigured: null as number | null }
  let responseListener!: (message: IncomingMessage) => void
  const transport: HeldRequestTransport = (_url, _options, listener) => {
    if (options.acquisition === 'factory-fails') throw new Error('controlled request factory failure')
    responseListener = listener
    return Object.assign(request, {
      socket: null,
      setTimeout: (ms: number) => { observation.timeoutConfigured = ms; return request },
      flushHeaders: () => {
        if (options.acquisition === 'before-socket-fails') throw new Error('controlled flush failure before socket')
        request.emit('socket', socket)
        if (options.acquisition === 'flush-fails') throw new Error('controlled flush failure after socket')
        queueMicrotask(() => {
          responseListener(Object.assign(response, { statusCode: 409, headers: { 'content-type': 'application/json' } }) as unknown as IncomingMessage)
          response.emit('data', Buffer.from(options.response === 'fail-before-end' ? '{"partial":' : '{"rejected":true}'))
          if (options.response === 'fail-before-end') {
            response.emit('aborted')
            response.emit('error', new Error('controlled response failure before end'))
          } else response.emit('end')
          response.emit('close')
        })
      },
      end: () => { throw new Error('This witness must never send a withheld body') },
      destroy: (error: Error) => {
        observation.destroyCalls++
        request.emit('error', error)
        const close = () => {
          request.emit('close')
          if (options.destruction !== 'missing-socket-close' && options.acquisition !== 'before-socket-fails') socket.emit('close')
        }
        if (options.destruction === 'throws-but-closes') { queueMicrotask(close); throw new Error('controlled destroy invocation failure') }
        close()
        return request
      },
    }) as unknown as ClientRequest
  }
  return { transport, request, observation }
}

test('held-request failure before response end and partial acquisition retain primary errors; one failed close join never prevents another acquired handle cleanup', async ({}, info) => {
  const evidence: Record<string, unknown> = { controlledTransport: true, outcomes: {}, finalHeld: [] }
  const outcomes = evidence.outcomes as Record<string, unknown>
  const handles: HeldRequest[] = []
  const verifiedFaults = new Set<HeldRequest>()
  let primary: { error: unknown } | null = null
  const acquire = async (fixture: ReturnType<typeof heldTransportWitness>) => {
    const held = await openHeldRequest('http://controlled.invalid', '/held', { method: 'PUT', headers: { 'Content-Length': 1_048_576 } }, fixture.transport)
    handles.push(held)
    return held
  }
  const requireClosure = (outcome: HeldRequestClosure) => {
    if (!outcome.confirmed || outcome.failures.length) throw new Error(`Held cleanup failed: ${outcome.failures.join('; ')}`)
    return outcome
  }
  try {
    const failing = heldTransportWitness({ response: 'fail-before-end' })
    const held = await acquire(failing)
    await expect(held.response).rejects.toThrow(/response aborted|response failure/)
    const closing = held.cleanup()
    expect(held.cleanup()).toBe(closing)
    const closed = await closing
    outcomes.responseFailure = { closure: closed, observation: held.observation }
    expect(closed).toMatchObject({ confirmed: true, responseEnded: false, requestClosed: true, socket: 'closed', joinBudgetMs: 3000 })
    expect(closed.failures.some(failure => failure.includes('response failure before end'))).toBe(true)
    expect(held.sentBodyBytes).toBe(0)
    expect(failing.observation.destroyCalls).toBe(1)
    expect(failing.observation.timeoutConfigured).toBe(30_000)
    verifiedFaults.add(held)
    for (const acquisition of ['factory-fails', 'before-socket-fails', 'flush-fails'] as const) {
      const partial = heldTransportWitness({ acquisition, ...(acquisition === 'flush-fails' ? { destruction: 'throws-but-closes' as const } : {}) })
      const failure = await acquire(partial).then(() => null, error => error as unknown)
      expect(failure).toBeInstanceOf(HeldRequestAcquisitionError)
      const error = failure as HeldRequestAcquisitionError
      outcomes[acquisition] = { primary: String(error.primary), observation: error.observation, cleanup: error.cleanup }
      expect(String(error.primary)).toContain(acquisition === 'factory-fails' ? 'factory failure' : 'flush failure')
      if (acquisition === 'factory-fails') {
        expect(error.observation.requestAcquired).toBe(false)
        expect(error.cleanup).toBeNull()
        expect(partial.observation.destroyCalls).toBe(0)
      } else {
        expect(error.observation.requestAcquired).toBe(true)
        expect(error.cleanup?.confirmed, 'even a destroy throw must not skip close observation').toBe(true)
        expect(error.cleanup?.socket).toBe(acquisition === 'before-socket-fails' ? 'not-acquired' : 'closed')
        expect(partial.observation.destroyCalls).toBe(1)
        if (acquisition === 'flush-fails') expect(error.cleanup?.failures.some(reason => reason.includes('destroy invocation failure'))).toBe(true)
      }
    }
    const stuckFixture = heldTransportWitness({ destruction: 'missing-socket-close' })
    const ordinaryFixture = heldTransportWitness()
    const stuck = await acquire(stuckFixture)
    const ordinary = await acquire(ordinaryFixture)
    await Promise.all([stuck.response, ordinary.response])
    const original = new Error('controlled primary response assertion failure')
    const joined: HeldRequestClosure[] = []
    const finalizerEvidence: Record<string, unknown> = {}
    const failure = await finalizeCase(info, 'held-independent-finalizer-witness', finalizerEvidence, { error: original }, [stuck, ordinary].map((handle, index) => ({
      label: `held-${index}`,
      run: async () => { const outcome = await handle.cleanup(); joined[index] = outcome; return requireClosure(outcome) },
    }))).then(() => null, error => error as unknown)
    expect(failure).toBeInstanceOf(AggregateError)
    expect((failure as AggregateError).errors[0]).toBe(original)
    expect(finalizerEvidence.cleanupFailures).toEqual([expect.stringContaining('Held request/socket closure unconfirmed within 3000 ms')])
    expect(joined[0]).toMatchObject({ confirmed: false, requestClosed: true, socket: 'unconfirmed', responseEnded: true, joinBudgetMs: 3000 })
    expect(joined[1]).toMatchObject({ confirmed: true, socket: 'closed', responseEnded: true, failures: [] })
    expect(stuckFixture.observation.destroyCalls).toBe(1)
    expect(ordinaryFixture.observation.destroyCalls).toBe(1)
    expect(await stuck.cleanup()).toBe(joined[0])
    expect(stuckFixture.observation.destroyCalls).toBe(1)
    verifiedFaults.add(stuck)
    outcomes.independentFinalizers = { primary: String(original), finalizerEvidence, joined }
    // The same common code as a connection reset cannot excuse an unknown late
    // error; only the exact owned destroy sentinel is intentional.
    const lateFixture = heldTransportWitness()
    const late = await acquire(lateFixture)
    await late.response
    const lateCleanup = await late.cleanup()
    expect(lateCleanup.failures).toEqual([])
    lateFixture.request.emit('error', Object.assign(new Error('unknown late socket hang up'), { code: 'ECONNRESET' }))
    outcomes.lateError = { closure: lateCleanup, observation: late.observation }
    expect(lateCleanup.confirmed).toBe(true)
    expect(lateCleanup.failures).toContain('request: Error: unknown late socket hang up')
    expect(late.observation.errors).toContainEqual({ source: 'request', message: 'Error: unknown late socket hang up', code: 'ECONNRESET', afterResponseEnd: true, duringCleanup: true, intentional: false })
    verifiedFaults.add(late)
  } catch (error) {
    primary = { error }
  }
  await finalizeCase(info, 'instrumentation-held-request-failures', evidence, primary, handles.map((handle, index) => ({
    label: `held-${index}`,
    run: async () => {
      const outcome = await handle.cleanup()
      ;(evidence.finalHeld as unknown[]).push({ index, outcome, observation: handle.observation })
      if (!verifiedFaults.has(handle)) requireClosure(outcome)
      return outcome
    },
  })))
})

test('endpoint validation refuses the foreign port in every spelling, invalid ranges, equal ports and non-loopback hosts before any probe', () => {
  expect(validateOwnedEndpoints('http://127.0.0.1:8790/', '9230')).toEqual({ host: '127.0.0.1', devPort: 8790, inspectorPort: 9230, devOrigin: 'http://127.0.0.1:8790', inspectorOrigin: 'http://127.0.0.1:9230' })
  expect(() => canonicalPort('8787', 'port')).toThrow(/foreign port 8787/)
  expect(() => canonicalPort('08787', 'port')).toThrow(/foreign port 8787/)
  expect(() => canonicalPort(8787, 'port')).toThrow(/foreign port 8787/)
  expect(() => validateOwnedEndpoints('http://127.0.0.1:08787/', '9230')).toThrow(/foreign port 8787/)
  expect(() => validateOwnedEndpoints('http://127.0.0.1:8790/', '08787')).toThrow(/foreign port 8787/)
  expect(() => canonicalPort('80', 'port')).toThrow(/\[1024, 65535\]/)
  expect(() => canonicalPort('65536', 'port')).toThrow(/\[1024, 65535\]/)
  expect(() => canonicalPort('9230x', 'port')).toThrow(/plain decimal port/)
  expect(() => canonicalPort(' 9230 ', 'port')).not.toThrow()
  expect(() => validateOwnedEndpoints('http://127.0.0.1:8790/', '8790')).toThrow(/must differ/)
  expect(() => validateOwnedEndpoints('http://localhost:8790/', '9230')).toThrow(/exactly/)
  expect(() => validateOwnedEndpoints('http://0.0.0.0:8790/', '9230')).toThrow(/exactly/)
  expect(() => validateOwnedEndpoints('https://127.0.0.1:8790/', '9230')).toThrow(/exactly/)
  expect(() => validateOwnedEndpoints('http://127.0.0.1:8790/path', '9230')).toThrow(/exactly/)
  expect(birthOf({ started: 'Sat Oct  3 16:23:55 2026' })).toBe(Date.UTC(2026, 9, 3, 16, 23, 55))
  expect(Number.isNaN(birthOf({ started: 'not a start time' }))).toBe(true)
})

test('listener parsing accepts newline-terminated positive PIDs only, recognizes the ordinary no-listener exit and reports every other outcome as an error', () => {
  // Parser: a trailing newline never becomes PID 0; zero, negative and non-numeric lines are invalid, duplicates collapse (MCR82-R9).
  expect(parsePidLines('4242\n')).toEqual({ pids: [4242], invalid: [] })
  expect(parsePidLines('4242\n4243\n\n')).toEqual({ pids: [4242, 4243], invalid: [] })
  expect(parsePidLines('4242\n4242\n')).toEqual({ pids: [4242], invalid: [] })
  expect(parsePidLines('0\n')).toEqual({ pids: [], invalid: ['0'] })
  expect(parsePidLines('-1\n12a\n 7 \n')).toEqual({ pids: [7], invalid: ['-1', '12a'] })
  expect(parsePidLines('')).toEqual({ pids: [], invalid: [] })
  // Classifier: raw command output is judged separately from Node's diagnostic.
  const ran = (code: number | null, stdout: string, stderr: string, diagnostic: string | null = null, killed = false): BoundedResult => ({ code, stdout, stderr, diagnostic, killed })
  expect(classifyListenerResult(ran(0, '4242\n', ''))).toEqual({ kind: 'listeners', pids: [4242] })
  expect(classifyListenerResult(ran(0, '4242\n4243\n', ''))).toEqual({ kind: 'listeners', pids: [4242, 4243] })
  expect(classifyListenerResult(ran(1, '', ''))).toEqual({ kind: 'none' })
  expect(classifyListenerResult(ran(0, '0\n', ''))).toEqual({ kind: 'error', reason: 'lsof printed non-PID lines: 0' })
  expect(classifyListenerResult(ran(0, '', ''))).toEqual({ kind: 'error', reason: 'lsof exited 0 without any PID line' })
  expect(classifyListenerResult(ran(1, '', 'lsof: WARNING: can\'t stat() a file system\n'))).toEqual({ kind: 'error', reason: 'exit 1 lsof: WARNING: can\'t stat() a file system' })
  expect(classifyListenerResult(ran(1, '4242\n', ''))).toEqual({ kind: 'error', reason: 'exit 1 (stdout "4242")' })
  expect(classifyListenerResult(ran(null, '', '', 'lsof exceeded 5000 ms and was killed', true))).toEqual({ kind: 'error', reason: 'lsof exceeded 5000 ms and was killed' })
  expect(classifyListenerResult(ran(null, '', '', 'Error: spawn lsof ENOENT'))).toEqual({ kind: 'error', reason: 'Error: spawn lsof ENOENT' })
  expect(classifyListenerResult(ran(2, '', 'lsof: unknown option'))).toEqual({ kind: 'error', reason: 'exit 2 lsof: unknown option' })
})

test('the inspector client refuses a non-singleton, a wrong version envelope and a foreign endpoint before connecting, reports early close, invalid and non-object frames, nonce mismatch with observed socket closure, isolate change, zero-delta profiles and unconfirmed closure, and the fake proxy tears down a live owned client', async ({}, info) => {
  const evidence: Record<string, unknown> = { outcomes: {} as Record<string, unknown> }
  const outcomes = evidence.outcomes as Record<string, unknown>
  let fake: FakeInspector | undefined
  let fresh: FakeInspector | undefined
  let inspector: Inspector | undefined
  let primary: { error: unknown } | null = null
  try {
    // The fake proxies are acquired inside the owned scope so their handles reach finalization even when a later step fails.
    fake = await startFakeInspector()
    evidence.fakePort = fake.port
    const endpoints = fake.endpoints()
    for (const [mode, pattern] of [['two-targets', /exactly one target/], ['wrong-version', /not the pinned/], ['foreign-endpoint', /not the owned/]] as [Mode, RegExp][]) {
      fake.state.mode = mode
      const before = fake.state.upgrades
      const refused = await Inspector.connect(endpoints, { isolateNonce: NONCE }, 3_000)
        .then(value => { inspector = value; return value }, error => error as unknown)
      expect(refused).toBeInstanceOf(InspectorAcquisitionError)
      const failure = refused as InspectorAcquisitionError
      expect(failure.message).toMatch(pattern)
      expect(failure.acquisition.json).not.toBeNull()
      expect(failure.acquisition.httpDiscovery[0]).toMatchObject({ status: 200, failure: null })
      expect(failure.acquisition.httpDiscovery[0].textUtf8Bytes).toBeGreaterThan(0)
      expect(failure.acquisition.socketAcquired).toBe(false)
      expect(failure.cleanup.socket).toEqual({ acquired: false })
      expect(failure.instrumentation).toBeNull()
      expect(fake.state.upgrades, `${mode} must fail before any WebSocket upgrade`).toBe(before)
      outcomes[mode] = { result: 'refused before connecting', acquisition: failure.acquisition, cleanup: failure.cleanup }
    }
    fake.state.mode = 'close-after-upgrade'
    await expect(Inspector.connect(endpoints, { isolateNonce: NONCE }, 3_000)).rejects.toThrow(/closed|1013/)
    outcomes['close-after-upgrade'] = 'rejected by the early close'
    fake.state.mode = 'invalid-json'
    await expect(Inspector.connect(endpoints, { isolateNonce: NONCE }, 3_000)).rejects.toThrow(/not JSON/)
    outcomes['invalid-json'] = 'pending call rejected by the parse failure'
    // Valid JSON that is not an object (null) is a protocol failure that rejects the pending call; it never escapes the message callback.
    fake.state.mode = 'null-frame'
    const nullFrame = await Inspector.connect(endpoints, { isolateNonce: NONCE }, 3_000).then(() => null, error => error as unknown)
    expect(nullFrame).toBeInstanceOf(InspectorAcquisitionError)
    expect((nullFrame as InspectorAcquisitionError).message).toMatch(/not a CDP object/)
    outcomes['null-frame'] = 'pending call rejected by the object guard'
    // Nonce mismatch: the opened socket is owned through the failure, terminated, and its closure observed on both sides.
    fake.state.mode = 'nonce-mismatch'
    const mismatch = await Inspector.connect(endpoints, { isolateNonce: NONCE }, 3_000).then(() => null, error => error as unknown)
    expect(mismatch).toBeInstanceOf(InspectorAcquisitionError)
    const acquisition = mismatch as InspectorAcquisitionError
    expect(acquisition.message).toMatch(/nonce/)
    expect(acquisition.closure.confirmed, `acquisition closure: ${acquisition.closure.reason}`).toBe(true)
    await expect.poll(() => fake!.openWebSockets(), { timeout: 5_000 }).toBe(0)
    outcomes['nonce-mismatch'] = { rejected: 'the inspected isolate is not the HTTP-served isolate', closure: acquisition.closure, serverSideOpenWebSockets: fake.openWebSockets() }
    // A positive binding: singleton, version, exact endpoint, correlated isolate id and matching nonce.
    fake.state.mode = 'ok'
    inspector = await Inspector.connect(endpoints, { isolateNonce: NONCE }, 3_000)
    expect(inspector.boundIsolateId).toBe('isolate-one')
    expect(inspector.target.webSocketDebuggerUrl).toBe(`ws://127.0.0.1:${fake.port}/ws`)
    const sample = await inspector.heapUsage('witness')
    expect(sample.isolateId).toBe('isolate-one')
    // A reported 0 is present with value 0; an omitted field is absent, never 0.
    expect(sample.embedderHeapUsedSize).toEqual({ present: true, value: 0 })
    expect(sample.backingStorageSize).toEqual({ present: false })
    expect(sample.raw).toEqual({ usedSize: 1_048_576, totalSize: 2_097_152, embedderHeapUsedSize: 0 })
    await inspector.startProfile()
    const profile = await inspector.stopProfile()
    expect(profile.summary).toMatchObject({ busyMicros: 1000, idleMicros: 500, sampleCount: 3, nodeCount: 2, totalDeltaMicros: 1500 })
    fake.state.mode = 'ok-zero-deltas'
    await inspector.startProfile()
    await expect(inspector.stopProfile()).rejects.toThrow(/time deltas total zero/)
    const profileCleanup = await inspector.cleanupProfile()
    outcomes.profileCleanup = profileCleanup
    expect(profileCleanup.confirmed).toBe(true)
    expect(profileCleanup.failures).toEqual([])
    fake.state.mode = 'ok-isolate-changes'
    await expect(inspector.heapUsage('after-reload')).rejects.toThrow(/isolate changed/)
    outcomes.positiveBinding = { isolateId: inspector.boundIsolateId, heapFields: { embedder: sample.embedderHeapUsedSize, backing: sample.backingStorageSize } }
    const closed = await inspector.close(3_000)
    expect(closed.confirmed).toBe(true)
    expect(closed.code).toBe(1000)
    outcomes.confirmedClose = closed
    inspector = undefined
    // Unconfirmed closure: a session whose close handshake is never answered is terminated and reported as unconfirmed, never as closed.
    fake.state.mode = 'ok'
    const stalled = await Inspector.connect(endpoints, { isolateNonce: NONCE }, 3_000)
    inspector = stalled
    fake.stall()
    const unconfirmed = await stalled.close(500)
    outcomes.unconfirmedClose = unconfirmed
    expect(unconfirmed.confirmed).toBe(false)
    expect(unconfirmed.reason).toContain('no close event')
    inspector = undefined
    // The stall paused EVERY raw connection of that factory, the fetch keep-alive sockets included, and setting the mode back to ok restores
    // nothing. The stalled factory is therefore finalized here within a bound (its paused sockets are destroyed first) and the clean baseline
    // is checked positively before the live-client witness runs on a fresh owned factory with its own endpoints (MFIN82-C2 / ACR82-R05-1).
    const stalledFactoryClose = await within(fake.close().then(() => 'closed' as const), 10_000)
    expect(stalledFactoryClose, 'the stalled factory must settle its own close').toBe('closed')
    expect(fake.openWebSockets(), 'the stalled server-side WebSocket must be gone before a fresh factory is used').toBe(0)
    outcomes.stalledFactoryClose = { result: stalledFactoryClose, serverSideOpenWebSockets: fake.openWebSockets() }
    // Live owned client teardown (MCR82-R13 residual): a client this case never closes is still factory-owned (as it would be if an
    // expected-rejection assertion unexpectedly succeeded and lost its handle). The fresh factory's close must settle without waiting on that
    // client, destroying it first; the client then observes the closure.
    fresh = await startFakeInspector()
    evidence.freshPort = fresh.port
    const freshEndpoints = fresh.endpoints()
    const live = await Inspector.connect(freshEndpoints, { isolateNonce: NONCE }, 3_000)
    inspector = live
    expect(fresh.openWebSockets(), 'exactly the live client is connected to the fresh factory').toBe(1)
    expect(live.events.closes, 'the client is live when the factory shutdown starts').toEqual([])
    const factoryClose = await within(fresh.close().then(() => 'closed' as const), 10_000)
    expect(factoryClose, 'the factory must settle its own close while a live owned client exists').toBe('closed')
    expect(fresh.openWebSockets()).toBe(0)
    await expect.poll(() => live.events.closes.length, { timeout: 5_000 }).toBe(1)
    outcomes.liveClientTeardown = { freshPort: fresh.port, closes: live.events.closes, serverSideOpenWebSockets: fresh.openWebSockets() }
  } catch (error) {
    primary = { error }
  }
  // Every acquired factory and client stays reachable here; the factory closes are idempotent, so an already-established closure is harmless.
  await finalizeCase(info, 'instrumentation-inspector-witness', evidence, primary, [
    { label: 'inspector-profile', run: async () => {
      if (!inspector) return 'not open'
      const outcome = await inspector.cleanupProfile()
      evidence.profileCleanup = outcome
      if (!outcome.confirmed || outcome.failures.length) throw new Error(`Profiler cleanup: ${outcome.failures.join('; ')}`)
      return outcome
    } },
    { label: 'inspector-close', run: async () => {
      if (!inspector) return 'not open'
      const outcome = await inspector.close(1_000)
      evidence.inspectorClosure = outcome
      if (!outcome.confirmed) throw new Error(`Inspector closure unconfirmed: ${outcome.reason}`)
      return outcome
    } },
    { label: 'fake-inspector-close', run: async () => { if (!fake) return 'not started'; await fake.close(); return 'closed' } },
    { label: 'fresh-fake-inspector-close', run: async () => { if (!fresh) return 'not started'; await fresh.close(); return 'closed' } },
  ])
})

test('explicit context discovery refreshes an already-enabled upstream for sequential frontends and rejects absent, ambiguous, malformed, stale or overflowing inventories without retries', async ({}, info) => {
  const evidence: Record<string, unknown> = { refusals: [], frontends: [] }
  const refusals = evidence.refusals as unknown[]
  const frontends = evidence.frontends as unknown[]
  const inspectors: Inspector[] = []
  let fake: FakeInspector | undefined
  let primary: { error: unknown } | null = null
  try {
    fake = await startFakeInspector()
    expect(CONTEXT_LIMITS).toEqual({ live: 16, history: 128, descriptorBytes: 4096 })
    fake.state.staleReplay = true
    for (const [contextMode, pattern] of [
      ['absent', /no live execution context/], ['wrong', /exactly one.*found 0/],
      ['undefined', /exactly one.*found 0/], ['ambiguous', /exactly one.*found 2/],
      ['missing-unique', /Malformed executionContextCreated/], ['stale-only', /no live execution context/],
      ['late', /no live execution context|inventory changed/], ['changing', /inventory changed/],
      ['exception', /Runtime.evaluate failed/], ['malformed-nonce', /malformed nonce RemoteObject/],
      ['live-cap', /live cap exceeded: 17 > 16/], ['history-cap', /history cap exceeded/],
      ['descriptor-cap', /descriptorBytes cap exceeded/],
    ] as [ContextMode, RegExp][]) {
      fake.state.contextMode = contextMode
      const beforeUpgrade = fake.state.upgrades
      const result = await Inspector.connect(fake.endpoints(), { isolateNonce: NONCE }, 3_000)
        .then(value => { inspectors.push(value); return value }, error => error as unknown)
      expect(result, contextMode).toBeInstanceOf(InspectorAcquisitionError)
      const failure = result as InspectorAcquisitionError
      refusals.push({ contextMode, primary: String(failure.primary), acquisition: failure.acquisition, cleanup: failure.cleanup, instrumentation: failure.instrumentation })
      expect(failure.message, contextMode).toMatch(pattern)
      expect(fake.state.upgrades).toBe(beforeUpgrade + 1)
      expect(failure.closure.confirmed, contextMode).toBe(true)
      expect(failure.cleanup.pendingCallsAfterCleanup).toBe(0)
      const snapshot = failure.instrumentation as ReturnType<Inspector['evidence']>
      expect(snapshot.events.history.length).toBeLessThanOrEqual(128)
      expect(snapshot.events.history.some(event => event.descriptor?.uniqueId === 'stale-replay-context')).toBe(true)
      expect(failure.acquisition.binding).toBeNull()
      if (contextMode === 'history-cap') {
        expect(snapshot.events.contextClears).toBe(129)
        expect(snapshot.events.lifecycleCount).toBe(130) // stale creation plus every clear, with no counter reset
        expect(snapshot.events.overflows).toContainEqual({ kind: 'history', limit: 128, observed: 130 })
      }
      if (contextMode === 'live-cap') expect(snapshot.events.overflows).toContainEqual({ kind: 'live', limit: 16, observed: 17 })
      if (contextMode === 'descriptor-cap') {
        expect(snapshot.events.maxDescriptorBytes).toBeGreaterThan(4096)
        expect(snapshot.events.history.find(event => event.unavailable?.includes('descriptor byte cap'))?.descriptor).toBeNull()
      }
      if (contextMode === 'wrong') {
        expect(failure.acquisition.enableAcknowledged).toBe(true)
        expect(failure.cleanup.runtime.attempted, 'a normal enable acknowledgement forbids a later Runtime reset').toBe(false)
      }
    }
    fake.state.contextMode = 'unique'
    fake.state.mode = 'ok-isolate-changes'
    fake.state.isolateCalls = 0
    const changedIsolate = await Inspector.connect(fake.endpoints(), { isolateNonce: NONCE }, 3_000)
      .then(value => { inspectors.push(value); return value }, error => error as unknown)
    expect(changedIsolate).toBeInstanceOf(InspectorAcquisitionError)
    const changedFailure = changedIsolate as InspectorAcquisitionError
    refusals.push({ contextMode: 'acquisition-isolate-change', primary: String(changedFailure.primary), acquisition: changedFailure.acquisition, cleanup: changedFailure.cleanup, instrumentation: changedFailure.instrumentation })
    expect(changedFailure.message).toContain('isolate changed during acquisition')
    expect(changedFailure.acquisition).toMatchObject({ initialIsolateId: 'isolate-one', finalIsolateId: 'isolate-two', binding: null, enableAcknowledged: true })
    expect(changedFailure.cleanup.runtime.attempted).toBe(false)
    expect(changedFailure.closure.confirmed).toBe(true)
    fake.state.mode = 'ok'
    fake.state.contextMode = 'delayed'
    const inventoriesBefore = fake.state.freshInventories
    for (let frontend = 1; frontend <= 2; frontend++) {
      expect(fake.state.runtimeEnabled, 'the upstream domain remains enabled between frontend clients').toBe(true)
      const start = fake.state.requests.length
      const inspector = await Inspector.connect(fake.endpoints(), { isolateNonce: NONCE }, 3_000)
      inspectors.push(inspector)
      expect(inspector.acquisition.binding).toEqual(OWNED_CONTEXT)
      expect(inspector.evidence().liveContexts).toEqual([COMPILER_CONTEXT, OWNED_CONTEXT])
      expect(inspector.acquisition.nonceResults.map(result => ({ id: result.context.id, match: result.matches })))
        .toEqual([{ id: 4, match: false }, { id: 7, match: true }])
      expect(fake.state.requests.slice(start).map(request => request.method))
        .toEqual(['Runtime.getIsolateId', 'Runtime.disable', 'Runtime.enable', 'Runtime.evaluate', 'Runtime.evaluate', 'Runtime.getIsolateId'])
      const evaluations = fake.state.requests.slice(start).filter(request => request.method === 'Runtime.evaluate')
      expect(evaluations.map(request => request.params)).toEqual([
        { expression: 'globalThis.__orbitIsolateNonce', returnByValue: true, uniqueContextId: 'compiler-context-one' },
        { expression: 'globalThis.__orbitIsolateNonce', returnByValue: true, uniqueContextId: 'owned-context-one' },
      ])
      // This proxy deliberately has no implicit default context; a successful
      // explicit binding cannot be a fake that silently accepts default calls.
      await expect(inspector.call('Runtime.evaluate', { expression: 'globalThis.__orbitIsolateNonce', returnByValue: true })).rejects.toThrow(/Cannot find default execution context/)
      expect(await inspector.evaluateNonce()).toBe(NONCE)
      const timeout = await inspector.call('Witness.pending', {}, 25).then(() => null, error => String(error))
      expect(timeout).toContain('Inspector call timed out: Witness.pending')
      expect(inspector.evidence().pendingCalls).toBe(0)
      // A pending ordinary RPC is rejected and its timer cleared by independent
      // socket cleanup, rather than being left active after the frontend closes.
      const pending = inspector.call('Witness.pending').then(() => 'unexpected success', error => String(error))
      expect(inspector.evidence().pendingCalls).toBe(1)
      const closed = await inspector.close(3_000)
      expect(closed).toMatchObject({ confirmed: true, code: 1000 })
      expect(await pending).toMatch(/Inspector closed by the test/)
      expect(inspector.evidence().pendingCalls).toBe(0)
      frontends.push({ frontend, evidence: inspector.evidence(), closure: closed })
    }
    expect(fake.state.freshInventories - inventoriesBefore).toBe(2)
    expect(fake.state.runtimeEnabled).toBe(true)
  } catch (error) {
    primary = { error }
  }
  await finalizeCase(info, 'instrumentation-context-discovery', evidence, primary, [
    ...inspectors.map((inspector, index) => ({ label: `frontend-${index}-close`, run: async () => {
      const outcome = await inspector.close()
      if (!outcome.confirmed) throw new Error(`Inspector closure unconfirmed: ${outcome.reason}`)
      return outcome
    } })),
    { label: 'fake-close', run: async () => { if (!fake) return 'not acquired'; await fake.close(); return { openWebSockets: fake.openWebSockets() } } },
  ])
})

test('failed context acquisition restores Runtime at most once when possible and independently confirms socket and pending-call cleanup', async ({}, info) => {
  const evidence: Record<string, unknown> = { outcomes: [] }
  const outcomes = evidence.outcomes as unknown[]
  const fakes: FakeInspector[] = []
  const unexpected: Inspector[] = []
  let primary: { error: unknown } | null = null
  try {
    for (const runtimeFault of ['enable-once', 'enable-always', 'enable-close', 'enable-detach', 'enable-protocol-error'] as const) {
      const fake = await startFakeInspector()
      fakes.push(fake)
      fake.state.runtimeFault = runtimeFault
      const result = await Inspector.connect(fake.endpoints(), { isolateNonce: NONCE }, 3_000)
        .then(value => { unexpected.push(value); return value }, error => error as unknown)
      expect(result).toBeInstanceOf(InspectorAcquisitionError)
      const failure = result as InspectorAcquisitionError
      outcomes.push({ runtimeFault, primary: String(failure.primary), acquisition: failure.acquisition, cleanup: failure.cleanup, instrumentation: failure.instrumentation, calls: [...fake.state.calls], unavailableRestoration: [...fake.state.unavailableRestoration] })
      expect(failure.acquisition.disableMayHaveBeenSent).toBe(true)
      expect(failure.acquisition.disableAcknowledged).toBe(true)
      expect(failure.acquisition.enableAcknowledged).toBe(false)
      const canRestore = runtimeFault === 'enable-once' || runtimeFault === 'enable-always'
      expect(failure.cleanup.runtime.attempted).toBe(canRestore)
      expect(failure.cleanup.runtime.enabledConfirmed).toBe(runtimeFault === 'enable-once')
      expect(failure.cleanup.runtime.limitation).toContain('cannot restore bindings')
      expect(fake.state.calls.filter(method => method === 'Runtime.disable')).toHaveLength(1)
      expect(fake.state.calls.filter(method => method === 'Runtime.enable')).toHaveLength(canRestore ? 2 : 1)
      expect(fake.state.calls).not.toContain('Runtime.evaluate')
      expect(fake.state.upgrades).toBe(1)
      expect(failure.closure.confirmed).toBe(true)
      expect(failure.cleanup.pendingCallsAfterCleanup).toBe(0)
      if (runtimeFault === 'enable-once') expect(failure.cleanup.failures).toEqual([])
      else expect(failure.cleanup.failures.some(reason => reason.includes('Runtime-state-unconfirmed'))).toBe(true)
      if (runtimeFault === 'enable-detach' || runtimeFault === 'enable-protocol-error') {
        expect(fake.state.unavailableRestoration).toEqual([{ fault: runtimeFault, socketReadyState: 1 }])
        const reason = runtimeFault === 'enable-detach'
          ? 'Inspector target ownership changed: Target.detachedFromTarget'
          : 'Inspector message is not a CDP object: null'
        expect(String(failure.primary), 'the original acquisition refusal survives cleanup').toBe(`Error: ${reason}`)
        expect(failure.cleanup.runtime.failure).toContain(reason)
        expect(fake.state.calls, 'no restoration, rebind or other RPC follows known channel loss').toEqual(['Runtime.getIsolateId', 'Runtime.disable', 'Runtime.enable'])
      }
      await expect.poll(() => fake.openWebSockets(), { timeout: 5_000 }).toBe(0)
    }
  } catch (error) {
    primary = { error }
  }
  await finalizeCase(info, 'instrumentation-runtime-restoration', evidence, primary, [
    ...unexpected.map((inspector, index) => ({ label: `unexpected-${index}-close`, run: async () => {
      const outcome = await inspector.close()
      if (!outcome.confirmed) throw new Error(`Inspector closure unconfirmed: ${outcome.reason}`)
      return outcome
    } })),
    ...fakes.map((fake, index) => ({ label: `fake-${index}-close`, run: async () => { await fake.close(); return { openWebSockets: fake.openWebSockets() } } })),
  ])
})

test('awaited binding invalidation rejects measurement while same-isolate profiler side effects receive independent bounded cleanup; ownership loss never directs cleanup to a replacement', async ({}, info) => {
  const resources: { fake: FakeInspector; inspector?: Inspector; evidence: Record<string, unknown>; expectedCleanupVerified: boolean }[] = []
  const evidence: Record<string, unknown> = { cases: resources.map(resource => resource.evidence) }
  let primary: { error: unknown } | null = null
  const scenarios = [
    { method: 'Runtime.getHeapUsage', kind: 'destroy' }, { method: 'Runtime.evaluate', kind: 'replace' },
    { method: 'HeapProfiler.collectGarbage', kind: 'clear' }, { method: 'Profiler.enable', kind: 'destroy' },
    { method: 'Profiler.setSamplingInterval', kind: 'destroy' }, { method: 'Profiler.start', kind: 'destroy' },
    { method: 'Profiler.stop', kind: 'destroy' }, { method: 'Profiler.start', kind: 'destroy', stopError: true },
    { method: 'Profiler.start', kind: 'destroy', identity: 'changed' },
    { method: 'Profiler.start', kind: 'destroy', identity: 'absent' },
    { method: 'Profiler.start', kind: 'destroy', identity: 'lost-after-stop' },
  ] as const
  try {
    for (const scenario of scenarios) {
      const fake = await startFakeInspector()
      const resource: (typeof resources)[number] = { fake, evidence: { scenario }, expectedCleanupVerified: false }
      resources.push(resource)
      evidence.cases = resources.map(item => item.evidence)
      const inspector = await Inspector.connect(fake.endpoints(), { isolateNonce: NONCE }, 3_000)
      resource.inspector = inspector
      // An unrelated context notification is retained without invalidating the
      // bound numeric/unique pair.
      fake.state.invalidate = { method: 'Runtime.getHeapUsage', kind: 'unrelated' }
      expect((await inspector.heapUsage('unrelated-context')).usedSize).toBe(1_048_576)
      expect(inspector.evidence().bindingFailure).toBeNull()
      expect(inspector.events.history.some(event => event.descriptor?.uniqueId === 'unrelated-context')).toBe(true)
      fake.state.invalidations = 0
      if (scenario.method === 'Profiler.stop') await inspector.startProfile()
      fake.state.invalidate = { method: scenario.method, kind: scenario.kind }
      const before = fake.state.requests.length
      const measured = scenario.method === 'Runtime.getHeapUsage' ? inspector.heapUsage('awaited-destruction')
        : scenario.method === 'Runtime.evaluate' ? inspector.evaluateNonce()
        : scenario.method === 'HeapProfiler.collectGarbage' ? inspector.collectGarbage()
        : scenario.method === 'Profiler.stop' ? inspector.stopProfile() : inspector.startProfile()
      await expect(measured).rejects.toThrow(/binding invalid|invalidated binding/)
      resource.evidence.measurement = inspector.evidence()
      const measurementCalls = fake.state.requests.slice(before).map(request => request.method)
      resource.evidence.measurementCalls = measurementCalls
      if (scenario.method === 'Profiler.enable') expect(measurementCalls).toEqual(['Runtime.getIsolateId', 'Profiler.enable'])
      if (scenario.method === 'Profiler.setSamplingInterval') expect(measurementCalls).toEqual(['Runtime.getIsolateId', 'Profiler.enable', 'Profiler.setSamplingInterval'])
      if (scenario.method === 'Profiler.start') {
        expect(inspector.profileState).toMatchObject({ enableMayHaveBeenSent: true, enableAcknowledged: true, startMayHaveBeenSent: true, startAcknowledged: true })
        expect(fake.state.profileMayBeRunning).toBe(true)
      }
      const afterInvalidation = fake.state.requests.length
      await expect(inspector.heapUsage('no-rebinding')).rejects.toThrow(/binding invalid/)
      await expect(inspector.startProfile()).rejects.toThrow(/binding invalid/)
      expect(fake.state.requests.length, 'no later measurement RPC follows invalidation').toBe(afterInvalidation)
      fake.state.cleanupStopError = 'stopError' in scenario
      fake.state.cleanupIdentity = 'identity' in scenario ? scenario.identity : 'same'
      const cleanupStart = fake.state.requests.length
      const cleanupPromise = inspector.cleanupProfile()
      expect(inspector.cleanupProfile(), 'cleanup is idempotent with no new RPC budgets').toBe(cleanupPromise)
      const cleanup = await cleanupPromise
      resource.evidence.profileCleanup = cleanup
      const cleanupCalls = fake.state.requests.slice(cleanupStart).map(request => request.method)
      resource.evidence.cleanupCalls = cleanupCalls
      expect(cleanup.budgetMsPerRpc).toBe(3000)
      expect(cleanup.configuredRpcBudgetMs).toBe(12000)
      expect(cleanupCalls.length).toBeLessThanOrEqual(4)
      expect(cleanupCalls).not.toContain('Runtime.enable')
      expect(cleanupCalls).not.toContain('Runtime.disable')
      const profiled = scenario.method.startsWith('Profiler.')
      if ('identity' in scenario && scenario.identity !== 'lost-after-stop') {
        expect(cleanupCalls).toEqual(['Runtime.getIsolateId'])
        expect(cleanup).toMatchObject({ confirmed: false, stopped: false, disabled: false })
      } else if ('identity' in scenario) {
        expect(cleanupCalls).toEqual(['Runtime.getIsolateId', 'Profiler.stop', 'Profiler.disable', 'Runtime.getIsolateId'])
        expect(cleanup).toMatchObject({ initialIsolateId: 'isolate-one', finalIsolateId: 'isolate-two', confirmed: false, stopped: false, disabled: false })
        expect(inspector.profileState).toMatchObject({ stopAcknowledged: true, disableAcknowledged: true })
      } else if ('stopError' in scenario) {
        expect(cleanupCalls).toEqual(['Runtime.getIsolateId', 'Profiler.stop', 'Profiler.disable', 'Runtime.getIsolateId'])
        expect(cleanup).toMatchObject({ confirmed: false, stopped: false, disabled: true })
        expect(cleanup.failures.some(failure => failure.includes('controlled profile stop failure'))).toBe(true)
        expect(cleanup.actions.find(action => action.method === 'Profiler.disable')?.status).toBe('acknowledged')
      } else {
        expect(cleanup.confirmed).toBe(true)
        expect(cleanup.failures).toEqual([])
        expect(cleanupCalls).toEqual(!profiled ? [] : scenario.method === 'Profiler.start'
          ? ['Runtime.getIsolateId', 'Profiler.stop', 'Profiler.disable', 'Runtime.getIsolateId']
          : ['Runtime.getIsolateId', 'Profiler.disable', 'Runtime.getIsolateId'])
      }
      if (scenario.method === 'Profiler.stop') {
        expect(inspector.profileState.stopAcknowledged).toBe(true)
        expect(cleanup.actions.find(action => action.method === 'Profiler.stop')?.status).toBe('skipped')
        expect(cleanup.stopped).toBe(true)
      }
      resource.expectedCleanupVerified = true
      const closed = await inspector.close()
      resource.evidence.socketCleanup = closed
      expect(closed.confirmed).toBe(true)
      expect(inspector.evidence().pendingCalls).toBe(0)
      resource.evidence.final = inspector.evidence()
    }
  } catch (error) {
    primary = { error }
  }
  await finalizeCase(info, 'instrumentation-awaited-invalidation', evidence, primary, resources.flatMap((resource, index) => [
    { label: `case-${index}-profile`, run: async () => {
      if (!resource.inspector) return 'not acquired'
      const cleanup = await resource.inspector.cleanupProfile()
      resource.evidence.finalProfileCleanup = cleanup
      if ((!cleanup.confirmed || cleanup.failures.length) && !resource.expectedCleanupVerified) throw new Error(`Unverified profiler cleanup failure: ${cleanup.failures.join('; ')}`)
      return cleanup
    } },
    { label: `case-${index}-socket`, run: async () => {
      if (!resource.inspector) return 'not acquired'
      const outcome = await resource.inspector.close()
      resource.evidence.socketCleanup = outcome
      if (!outcome.confirmed) throw new Error(`Inspector closure unconfirmed: ${outcome.reason}`)
      return outcome
    } },
    { label: `case-${index}-fake`, run: async () => { await resource.fake.close(); return { openWebSockets: resource.fake.openWebSockets() } } },
  ]))
})

test('the memory sampler coalesces overlapping ticks, reports a gone process as lost identity with a null RSS, and on a stop that misses its bound records the failure without starting a second sample', async ({}, info) => {
  const evidence: Record<string, unknown> = {}
  let primary: { error: unknown } | null = null
  let sampler: MemorySampler | undefined
  let delayed: MemorySampler | undefined
  let ownedChild: ReturnType<typeof acquireSamplerChild> | undefined
  let release: (() => void) | undefined
  const joinTimeoutMessage = 'the in-flight sample did not settle within 200 ms; no final sample was started while it remains active'
  try {
    const table = await processTable()
    const self = table.find(row => row.pid === process.pid)
    expect(self, 'the test process must appear in the process table').toBeDefined()
    const runtime: OwnedRuntime = {
      endpoints: validateOwnedEndpoints('http://127.0.0.1:8790/', '9230'), registryPath: '(synthetic)', registeredPids: [process.pid], listeners: [],
      workerd: [{ ...self!, role: 'owned-runtime', registeredAt: Date.now(), registeredBy: self!.ppid }],
    }
    // 1. Real ps at a 1 ms interval: ticks coalesce, every sample is valid and the summary is usable.
    sampler = new MemorySampler(runtime)
    sampler.phase = 'witness'
    sampler.start(1)
    await new Promise(resolve => setTimeout(resolve, 400))
    const summary = await sampler.stop()
    sampler = undefined
    evidence.summary = { sampleCount: summary.sampleCount, validSampleCount: summary.validSampleCount, skippedTicks: summary.skippedTicks, errors: summary.errors, phases: [...new Set(summary.samples.map(sample => sample.phase))], peaks: summary.peakRssKiBByPid }
    expect(summary.errors).toEqual([])
    expect(summary.sampleCount).toBeGreaterThan(0)
    expect(summary.validSampleCount).toBe(summary.sampleCount)
    expect(summary.invalidSamples).toEqual([])
    expect(summary.usable).toBe(true)
    expect(summary.skippedTicks, 'a 1 ms interval must coalesce while a ps sample is in flight').toBeGreaterThan(0)
    expect(summary.samples.every(sample => sample.commandError === null && sample.identityProblems.length === 0 && sample.processes[0].availability === 'valid' && (sample.processes[0].rssKiB ?? 0) > 0)).toBe(true)
    expect(summary.samples.every(sample => sample.phase === 'witness')).toBe(true)
    expect(summary.peakRssKiBByPid[String(process.pid)]).toBeGreaterThan(0)
    requireUsableMemory(summary)
    // 2. A gone process: ps -p exits 1 with no rows, which is lost identity (null RSS, missing row), never a number; the peak stays null and the interval is unusable.
    ownedChild = acquireSamplerChild()
    evidence.ownedChild = ownedChild.observation
    expect(await within(ownedChild.ready, 5_000), 'the retained finite child must report it is held alive').not.toBe('timeout')
    const childPid = ownedChild.child.pid
    expect(Number.isSafeInteger(childPid) && childPid! > 0).toBe(true)
    const liveChild = (await processTable([childPid!])).find(row => row.pid === childPid)
    expect(liveChild, 'positive OS identity before requesting this child to exit').toBeDefined()
    ownedChild.observation.identity = liveChild!
    expect(liveChild!.ppid).toBe(process.pid)
    expect(liveChild!.pgid).toBeGreaterThan(0)
    expect(Number.isFinite(birthOf(liveChild!))).toBe(true)
    expect(Math.abs(birthOf(liveChild!) - ownedChild.observation.spawnedAt)).toBeLessThanOrEqual(120_000)
    expect(liveChild!.command).toContain('orbit-capacity-owned-child')
    const gone: OwnedRuntime = {
      ...runtime, registryPath: '(synthetic retained owned child, not workerd)', registeredPids: [childPid!],
      workerd: [{ ...liveChild!, role: 'owned-runtime', registeredAt: ownedChild.observation.spawnedAt, registeredBy: liveChild!.ppid }],
    }
    evidence.goneRuntime = gone
    const childClosed = await ownedChild.stop()
    evidence.childTermination = childClosed
    expect(childClosed.failures).toEqual([])
    expect(childClosed.confirmed).toBe(true)
    expect(childClosed.observation.exit).toEqual({ code: 0, signal: null })
    expect(childClosed.observation.close).toEqual({ code: 0, signal: null })
    expect(childClosed.observation.stdioClosed).toEqual({ stdin: true, stdout: true, stderr: true })
    expect(childClosed.observation.stdout).toBe('held-ready\ninput-ended\n')
    expect(childClosed.observation.fallbackTerminationRequested).toBe(false)
    // Only the PID identifier varies. Reuse is a failure, never a reason to
    // choose another PID or signal a replacement.
    const problems = await recheckRuntime(gone)
    evidence.goneProblems = problems
    expect(problems).toEqual([`owned-runtime workerd ${childPid} is gone`])
    const goneSampler = new MemorySampler(gone)
    const goneSample = await goneSampler.sampleOnce()
    const goneSummary = await goneSampler.stop()
    evidence.goneSummary = goneSummary
    evidence.goneSample = { commandError: goneSample.commandError, processes: goneSample.processes, identityProblems: goneSample.identityProblems, raw: goneSample.raw }
    expect(goneSample.commandError).toBeNull()
    expect(goneSample.identityProblems).toEqual([`owned-runtime workerd ${childPid} is gone`])
    expect(goneSample.processes).toEqual([{ pid: childPid, role: 'owned-runtime', rssKiB: null, availability: 'missing-row' }])
    expect(goneSummary.samples.every(sample => sample.commandError === null && sample.identityProblems.length === 1 && sample.identityProblems[0] === `owned-runtime workerd ${childPid} is gone`)).toBe(true)
    expect(goneSummary.peakRssKiBByPid).toEqual({ [String(childPid)]: null })
    expect(goneSummary.validSampleCount).toBe(0)
    expect(goneSummary.usable).toBe(false)
    expect(() => requireUsableMemory(goneSummary)).toThrow(/is gone/)
    // 3. A controlled delayed sample: stop misses its bound, records the failure and starts no second sample; the sample is then released and joined.
    delayed = new MemorySampler(runtime)
    delayed.phase = 'delayed'
    const gate = new Promise<void>(resolve => { release = resolve })
    const original = delayed.sampleOnce.bind(delayed)
    let calls = 0
    delayed.sampleOnce = async () => { calls++; await gate; return original() }
    delayed.start(1)
    await expect.poll(() => calls, { timeout: 5_000 }).toBe(1)
    const stopped = await delayed.stop(200)
    evidence.delayedStop = { errors: stopped.errors, sampleCount: stopped.sampleCount, calls }
    expect(stopped.errors).toEqual([joinTimeoutMessage])
    expect(stopped.sampleCount).toBe(0)
    expect(calls, 'no second sample is started while the first is still active').toBe(1)
    expect(delayed.pendingSample()).not.toBeNull()
    if (!release) throw new Error('Delayed sample release is not initialized')
    release()
    await expect.poll(() => delayed!.pendingSample(), { timeout: 10_000 }).toBeNull()
    const afterRelease = delayed.summary()
    evidence.delayedAfterRelease = { errors: afterRelease.errors, sampleCount: afterRelease.sampleCount, validSampleCount: afterRelease.validSampleCount, usable: afterRelease.usable }
    expect(afterRelease.sampleCount).toBe(1)
    expect(calls).toBe(1)
    // The released sample is valid, yet the recorded stop timeout keeps the interval unusable.
    expect(afterRelease.validSampleCount).toBe(1)
    expect(afterRelease.errors).toEqual([joinTimeoutMessage])
    expect(afterRelease.usable).toBe(false)
    delayed = undefined
    await samplerProcessWitnesses(info)
  } catch (error) {
    primary = { error }
  }
  await finalizeCase(info, 'instrumentation-sampler-witness', evidence, primary, [
    { label: 'release-delayed-sample', run: async () => { release?.(); const pending = delayed?.pendingSample(); if (pending) await pending; return pending ? 'released and joined' : 'nothing pending' } },
    { label: 'sampler-stop', run: async () => sampler ? (await sampler.stop()).sampleCount : 'already stopped' },
    { label: 'delayed-stop', run: async () => delayed ? (await delayed.stop()).sampleCount : 'already stopped' },
    { label: 'owned-child-join', run: async () => {
      if (!ownedChild) return 'not acquired'
      const outcome = await ownedChild.stop()
      evidence.childTermination = outcome
      if (!outcome.confirmed || outcome.failures.length) throw new Error(`Owned child cleanup: ${outcome.failures.join('; ')}`)
      return outcome
    } },
  ])
})

test('raw ps results convert through the actual sample seam: exit 1 with empty output is lost identity, exit 1 with rows is a failed command, and a valid row needs a safe nonnegative RSS', async ({}, info) => {
  const table = await processTable()
  const self = table.find(row => row.pid === process.pid)
  expect(self, 'the test process must appear in the process table').toBeDefined()
  const runtime: OwnedRuntime = {
    endpoints: validateOwnedEndpoints('http://127.0.0.1:8790/', '9230'), registryPath: '(synthetic)', registeredPids: [process.pid], listeners: [],
    workerd: [{ ...self!, role: 'owned-runtime', registeredAt: Date.now(), registeredBy: self!.ppid }],
  }
  const owned = [{ pid: process.pid, role: 'owned-runtime' as const, command: self!.command }]
  const at = '2026-10-03T06:05:00.000Z'
  const ran = (code: number | null, stdout: string, stderr: string, diagnostic: string | null = null, killed = false): BoundedResult => ({ code, stdout, stderr, diagnostic, killed })
  const row = (rss: string) => `${self!.pid} ${self!.ppid} ${self!.pgid} ${self!.started} ${rss} ${self!.command}\n`
  const missing = { pid: process.pid, role: 'owned-runtime', rssKiB: null, availability: 'missing-row' }
  // 1. Normal no-match: exit 1 with EMPTY stdout and stderr is lost identity (null RSS), not a command error.
  const gone = sampleFromResult(runtime, ran(1, '', ''), at, 'witness')
  expect(gone.commandError).toBeNull()
  expect(gone.identityProblems).toEqual([`owned-runtime workerd ${process.pid} is gone`])
  expect(gone.processes).toEqual([missing])
  // 2. Exit 1 with a valid-looking row and empty stderr is a failed command whose raw rows are preserved; the interval is unusable (MCR82-R14).
  const exitOneWithRows = sampleFromResult(runtime, ran(1, row('123456'), ''), at, 'witness')
  expect(exitOneWithRows.commandError).toBe('ps -p exited 1 with rows on stdout')
  expect(exitOneWithRows.identityProblems).toEqual([])
  expect(exitOneWithRows.processes).toEqual([missing])
  expect(exitOneWithRows.raw).toEqual({ code: 1, stdout: row('123456'), stderr: '' })
  const exitOneSummary = summarizeSamples(owned, [exitOneWithRows], 0, [])
  expect(exitOneSummary.peakRssKiBByPid).toEqual({ [String(process.pid)]: null })
  expect(() => requireUsableMemory(exitOneSummary)).toThrow(/exited 1 with rows on stdout/)
  // 3. Exit 1 with empty stdout but a stderr message, a diagnostic, a killed command or another exit status are failed commands.
  expect(sampleFromResult(runtime, ran(1, '', 'ps: illegal option\n'), at, 'witness').commandError).toBe('ps -p exited 1 with stderr "ps: illegal option"')
  expect(sampleFromResult(runtime, ran(null, '', '', 'Error: spawn ps ENOENT'), at, 'witness').commandError).toBe('Error: spawn ps ENOENT')
  expect(sampleFromResult(runtime, ran(null, row('123456'), '', 'ps exceeded 5000 ms and was killed', true), at, 'witness').commandError).toBe('ps exceeded 5000 ms and was killed')
  expect(sampleFromResult(runtime, ran(2, row('123456'), ''), at, 'witness').commandError).toBe('ps -p exited 2 with rows on stdout')
  // 4. Exit 0 with a well-formed owned row is a valid sample; the peak is that row's RSS.
  const valid = sampleFromResult(runtime, ran(0, row('123456'), ''), at, 'witness')
  expect(valid).toMatchObject({ commandError: null, identityProblems: [], processes: [{ pid: process.pid, role: 'owned-runtime', rssKiB: 123456, availability: 'valid' }] })
  expect(summarizeSamples(owned, [valid], 0, [])).toMatchObject({ usable: true, validSampleCount: 1, peakRssKiBByPid: { [String(process.pid)]: 123456 } })
  // 5. Exit 0 whose RSS field is not a canonical finite nonnegative safe integer is invalid-rss, never a number (optional precision ACR82-R04-O2).
  for (const rss of ['n/a', 'NaN', '-5', '12.5', '99999999999999999999']) {
    expect(sampleFromResult(runtime, ran(0, row(rss), ''), at, 'witness').processes[0], `rss ${rss}`).toEqual({ pid: process.pid, role: 'owned-runtime', rssKiB: null, availability: 'invalid-rss' })
  }
  // 6. Exit 0 whose row carries a changed identity is an identity problem; such a sample contributes no peak and makes the interval unusable.
  const changed = sampleFromResult(runtime, ran(0, `${self!.pid} ${self!.ppid} ${self!.pgid + 1} ${self!.started} 123456 ${self!.command}\n`, ''), at, 'witness')
  expect(changed.identityProblems).toEqual([`owned-runtime workerd ${process.pid} changed pgid: ${self!.pgid} -> ${self!.pgid + 1}`])
  const changedSummary = summarizeSamples(owned, [changed], 0, [])
  expect(changedSummary.peakRssKiBByPid).toEqual({ [String(process.pid)]: null })
  expect(changedSummary.usable).toBe(false)
  await commandAcquisitionWitnesses(info)
})

test('the shared usable-sample check rejects an interval with one invalid intermediate sample even when the final identity is clean, and never turns absence into a zero peak', async ({}, info) => {
  const owned = [{ pid: 4242, role: 'owned-runtime' as const, command: 'workerd serve' }]
  const valid = (at: string, rssKiB: number): MemorySample => ({ at, phase: 'held', processes: [{ pid: 4242, role: 'owned-runtime', rssKiB, availability: 'valid' }], identityProblems: [], commandError: null, raw: { code: 0, stdout: '', stderr: '' } })
  const lost: MemorySample = { at: '2026-10-03T06:05:01.000Z', phase: 'held', processes: [{ pid: 4242, role: 'owned-runtime', rssKiB: null, availability: 'missing-row' }], identityProblems: ['owned-runtime workerd 4242 is gone'], commandError: null, raw: { code: 1, stdout: '', stderr: '' } }
  const mixed = summarizeSamples(owned, [valid('2026-10-03T06:05:00.000Z', 100_000), lost, valid('2026-10-03T06:05:02.000Z', 120_000)], 0, [])
  expect(mixed.sampleCount).toBe(3)
  expect(mixed.validSampleCount).toBe(2)
  expect(mixed.invalidSamples).toEqual([{ at: '2026-10-03T06:05:01.000Z', phase: 'held', problems: ['owned-runtime workerd 4242 is gone', 'owned-runtime 4242: missing-row'] }])
  expect(mixed.peakRssKiBByPid).toEqual({ '4242': 120_000 })
  expect(mixed.usable).toBe(false)
  expect(() => requireUsableMemory(mixed)).toThrow(/is gone/)
  // A valid-looking row inside a sample that has an identity problem contributes no peak (peaks are over wholly valid samples only).
  const tainted: MemorySample = { at: '2026-10-03T06:05:03.000Z', phase: 'held', processes: [{ pid: 4242, role: 'owned-runtime', rssKiB: 999_999, availability: 'valid' }], identityProblems: ['owned-runtime workerd 4242 changed pgid: 1 -> 2'], commandError: null, raw: { code: 0, stdout: '', stderr: '' } }
  expect(summarizeSamples(owned, [tainted], 0, []).peakRssKiBByPid).toEqual({ '4242': null })
  // A command failure invalidates the interval and leaves the peak null rather than 0.
  const commandFailed = summarizeSamples(owned, [{ at: '2026-10-03T06:05:04.000Z', phase: 'held', processes: [{ pid: 4242, role: 'owned-runtime', rssKiB: null, availability: 'missing-row' }], identityProblems: [], commandError: 'ps exceeded 5000 ms and was killed', raw: { code: null, stdout: '', stderr: '' } }], 0, [])
  expect(commandFailed.peakRssKiBByPid).toEqual({ '4242': null })
  expect(commandFailed.usable).toBe(false)
  expect(() => requireUsableMemory(commandFailed)).toThrow(/command: ps exceeded 5000 ms/)
  // A non-numeric RSS field is invalid evidence.
  const invalidRss = summarizeSamples(owned, [{ at: '2026-10-03T06:05:05.000Z', phase: 'held', processes: [{ pid: 4242, role: 'owned-runtime', rssKiB: null, availability: 'invalid-rss' }], identityProblems: [], commandError: null, raw: { code: 0, stdout: '4242 1 4242 Sat Oct  3 06:00:00 2026 n/a workerd', stderr: '' } }], 0, [])
  expect(() => requireUsableMemory(invalidRss)).toThrow(/invalid-rss/)
  // No sample at all is unusable; a sampler error alone is unusable even with valid samples.
  expect(summarizeSamples(owned, [], 0, []).usable).toBe(false)
  expect(() => requireUsableMemory(summarizeSamples(owned, [], 0, []))).toThrow(/no valid owned-process sample/)
  expect(summarizeSamples(owned, [valid('2026-10-03T06:05:06.000Z', 90_000)], 0, ['synthetic sampler error']).usable).toBe(false)
  expect(summarizeSamples(owned, [valid('2026-10-03T06:05:06.000Z', 90_000)], 3, []).usable).toBe(true)
  await cooperativeContentWitnesses(info)
})

test('runtime binding refuses to run without this run\'s registry and refuses listeners that the registry did not record, naming the actual listener PID', async ({}, info) => {
  const evidence: Record<string, unknown> = {}
  const saved = process.env.ORBIT_PROCESS_REGISTRY
  const servers: Server[] = []
  let directory: string | undefined
  let primary: { error: unknown } | null = null
  try {
    delete process.env.ORBIT_PROCESS_REGISTRY
    await expect(bindOwnedRuntime(validateOwnedEndpoints('http://127.0.0.1:65002/', '65003'))).rejects.toThrow(/ORBIT_PROCESS_REGISTRY is not set/)
    evidence.withoutRegistry = 'refused'
    // Two owned local listeners on validated ports whose PID (this test process) is NOT in the synthetic registry: never treated as owned.
    const listen = async () => {
      const server = createServer((_request, response) => { response.writeHead(204); response.end() })
      servers.push(server)
      await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
      const port = (server.address() as AddressInfo).port
      if (port === 8787 || port === 8790) throw new Error('reserved local port')
      return port
    }
    const devPort = await listen()
    const inspectorPort = await listen()
    directory = await mkdtemp(path.join(os.tmpdir(), 'orbit-capacity-registry-'))
    const registry = path.join(directory, 'processes.ndjson')
    await writeFile(registry, `${JSON.stringify({ event: 'observer-start', pid: 1, ppid: 0, at: Date.now() })}\n${JSON.stringify({ event: 'spawn', pid: 2, ppid: 1, argv: ['workerd', 'serve'], at: Date.now() })}\n`)
    process.env.ORBIT_PROCESS_REGISTRY = registry
    // The refusal names the real listener PID: a fabricated PID 0 from a trailing newline cannot satisfy this (MCR82-R9).
    await expect(bindOwnedRuntime(validateOwnedEndpoints(`http://127.0.0.1:${devPort}/`, inspectorPort))).rejects.toThrow(`Listener PID(s) ${process.pid} on the owned ports are not recorded in this run's registry ${registry}`)
    evidence.unregisteredListener = { devPort, inspectorPort, listenerPid: process.pid, result: 'refused' }
  } catch (error) {
    primary = { error }
  }
  await finalizeCase(info, 'instrumentation-ownership-witness', evidence, primary, [
    { label: 'restore-env', run: async () => { if (saved === undefined) delete process.env.ORBIT_PROCESS_REGISTRY; else process.env.ORBIT_PROCESS_REGISTRY = saved; return 'restored' } },
    { label: 'close-servers', run: async () => { for (const server of servers) await new Promise<void>((resolve, reject) => { server.closeAllConnections(); server.close(error => error ? reject(error) : resolve()) }); return { closed: servers.length } } },
    { label: 'remove-registry', run: async () => { if (!directory) return 'not created'; await rm(directory, { recursive: true, force: true }); return 'removed' } },
  ])
})

// Remedy03 witnesses below are synthetic, explicitly selected producers. Their
// frames, active-state transitions, unsafe-reset counters and expected figures
// are independent of the Inspector validators.
function literalNativeProfile() {
  return {
    nodes: [
      { id: 1, callFrame: { functionName: '(root)', scriptId: '0', url: '', lineNumber: -1, columnNumber: -1 }, children: [2, 3], hitCount: 0 },
      { id: 2, callFrame: { functionName: 'render가', scriptId: '17', url: 'fixture://worker', lineNumber: 4, columnNumber: 2 }, hitCount: 2, positionTicks: [{ line: 5, ticks: 2 }], deoptReason: '' },
      { id: 3, callFrame: { functionName: '(idle)', scriptId: '0', url: '', lineNumber: -1, columnNumber: -1 } },
    ],
    startTime: 10, endTime: 1510, samples: [2, 3, 2], timeDeltas: [500, 500, 500],
  }
}
type NativeGcClockScript = Readonly<{
  initial: number
  gcSend: number
  barrierReply: number
  httpRequest: number
  finalReply: number
}>
type NativePeer = Awaited<ReturnType<typeof startNativePeer>>
async function startNativePeer() {
  const clock = { offset: 0, scripted: undefined as number | undefined }
  const now = () => clock.scripted ?? performance.now() + clock.offset
  const state = {
    active: false, enableCalls: 0, unsafeResets: 0, stopCalls: 0, gcCommands: 0, barrierReplies: 0, finalIdentities: 0,
    gets: 0, wakeBeforeBarrier: 0, requireBarrier: true,
    gcMode: 'on-get' as 'on-get' | 'early' | 'error' | 'malformed' | 'late' | 'missing',
    barrierMode: 'same' as 'same' | 'wrong' | 'malformed' | 'clear' | 'detach' | 'late' | 'error',
    finalMode: 'same' as 'same' | 'wrong' | 'clear',
    httpMode: 'ok' as 'ok' | 'wrong-nonce' | 'redirect' | 'encoded' | 'malformed' | 'oversized' | 'never-end',
    commands: [] as { id: number; method: string; params: Record<string, unknown>; at: number }[],
    frames: [] as { id: number; method: string; at: number; bytes: number; base64: string; sha256: string }[],
    http: [] as { method: string | undefined; path: string | undefined; headers: IncomingMessage['headers']; at: number }[],
    events: [] as string[],
    errors: [] as string[],
    gcClockScript: null as {
      domain: string
      declared: NativeGcClockScript
      phases: { phase: keyof NativeGcClockScript; at: number }[]
      inverseArithmeticEvidence?: { deadline: number; sentAt: number; subtraction: number; usedAsBudgetOracle: false }
    } | null,
  }
  // Only the three literal-clock witnesses opt in. Producer and client use
  // this same comparison clock; actual socket events and host timers stay real.
  const scriptPhase = (phase: keyof NativeGcClockScript) => {
    if (!state.gcClockScript) return
    clock.scripted = state.gcClockScript.declared[phase]
    state.gcClockScript.phases.push({ phase, at: clock.scripted })
  }
  const scriptGcClock = (declared: NativeGcClockScript) => {
    if (state.gcClockScript || state.commands.length || state.gets) throw new Error('A literal GC clock must be declared once before client acquisition')
    const times = [declared.initial, declared.gcSend, declared.barrierReply, declared.httpRequest, declared.finalReply]
    if (times.some((at, index) => !Number.isFinite(at) || (index > 0 && at <= times[index - 1]))) throw new Error('Literal GC clock phases must be finite and strictly increasing')
    state.gcClockScript = { domain: 'scripted monotonic milliseconds; not real transport elapsed time', declared: Object.freeze({ ...declared }), phases: [] }
    scriptPhase('initial')
  }
  let override: ScriptedDispatch | undefined
  let pendingGc: { command: ScriptedCommand; socket: ServerSocket; barrier: boolean; replied: boolean } | undefined
  const emit = (command: ScriptedCommand, socket: ServerSocket, frame: unknown) => {
    const payload = Buffer.isBuffer(frame) ? frame : Buffer.from(typeof frame === 'string' ? frame : JSON.stringify(frame), 'utf8')
    state.frames.push({ id: command.id, method: command.method, at: now(), bytes: payload.length, base64: payload.toString('base64'), sha256: createHash('sha256').update(payload).digest('hex') })
    socket.send(payload)
  }
  const event = (socket: ServerSocket, method: string) => { state.events.push(method); socket.send(JSON.stringify({ method, params: {} })) }
  const replyGc = () => {
    if (!pendingGc || pendingGc.replied) return
    pendingGc.replied = true
    if (state.gcMode === 'late') clock.offset += 30001
    const { command, socket } = pendingGc
    emit(command, socket, state.gcMode === 'error' ? { id: command.id, error: { code: -32000, message: 'literal queued GC failure' } }
      : state.gcMode === 'malformed' ? { id: command.id, result: null } : { id: command.id, result: {} })
  }
  const fake = await startFakeInspector((command, socket) => {
    state.commands.push({ ...command, at: now() })
    if (command.method === 'Profiler.enable') { state.enableCalls++; if (state.active) state.unsafeResets++ }
    if (command.method === 'Profiler.start') state.active = true
    if (command.method === 'Profiler.stop') state.stopCalls++
    if (override?.(command, socket)) return true
    switch (command.method) {
      case 'HeapProfiler.enable':
        // The ordinary fake ACK releases the client to send GC at this literal.
        scriptPhase('gcSend')
        return false
      case 'Profiler.enable':
        state.active = false
        emit(command, socket, { id: command.id, method: 'Profiler.enable', params: {} }); return true
      case 'Profiler.setSamplingInterval':
        emit(command, socket, { id: command.id, method: 'Profiler.setSamplingInterval', params: { interval: command.params.interval } }); return true
      case 'Profiler.start':
        emit(command, socket, { id: command.id, method: 'Profiler.start', params: {} }); return true
      case 'Profiler.stop':
        state.active = false
        emit(command, socket, { id: command.id, method: 'Profiler.stop', result: { profile: literalNativeProfile() } }); return true
      case 'HeapProfiler.collectGarbage':
        state.gcCommands++; pendingGc = { command, socket, barrier: false, replied: false }
        if (state.gcMode === 'early') replyGc()
        return true
      case 'Runtime.getIsolateId':
        if (!pendingGc) return false
        if (!pendingGc.barrier) {
          pendingGc.barrier = true
          scriptPhase('barrierReply')
          if (state.barrierMode === 'clear') event(socket, 'Runtime.executionContextsCleared')
          if (state.barrierMode === 'detach') event(socket, 'Target.detachedFromTarget')
          if (state.barrierMode === 'late') clock.offset += 30001
          state.barrierReplies++
          emit(command, socket, state.barrierMode === 'error' ? { id: command.id, error: { code: -32000, message: 'literal barrier failure' } }
            : { id: command.id, result: state.barrierMode === 'malformed' ? {} : { id: state.barrierMode === 'wrong' ? 'isolate-two' : 'isolate-one' } })
        } else {
          state.finalIdentities++
          scriptPhase('finalReply')
          if (state.finalMode === 'clear') event(socket, 'Runtime.executionContextsCleared')
          emit(command, socket, { id: command.id, result: { id: state.finalMode === 'wrong' ? 'isolate-two' : 'isolate-one' } })
          if (state.finalMode === 'same') pendingGc = undefined
        }
        return true
      default: return false
    }
  })
  const sockets = new Set<Socket>()
  const http = createServer((request, response) => {
    scriptPhase('httpRequest')
    state.gets++
    state.http.push({ method: request.method, path: request.url, headers: { ...request.headers }, at: now() })
    request.on('error', error => state.errors.push(`owned server request: ${String(error)}`))
    response.on('error', error => state.errors.push(`owned server response: ${String(error)}`))
    if (state.requireBarrier && !pendingGc?.barrier) { state.wakeBeforeBarrier++; response.writeHead(409); response.end('before barrier'); return }
    if (request.method !== 'GET' || request.url !== '/__test/identity') { response.writeHead(404); response.end(); return }
    if (pendingGc && state.gcMode !== 'missing') replyGc()
    if (state.httpMode === 'redirect') { response.writeHead(302, { Location: '/must-not-follow' }); response.end('{}'); return }
    response.writeHead(200, { 'Content-Type': 'application/json', ...(state.httpMode === 'encoded' ? { 'Content-Encoding': 'gzip' } : {}) })
    if (state.httpMode === 'never-end') { response.write('{"harness":'); return }
    response.end(state.httpMode === 'malformed' ? '{' : state.httpMode === 'oversized' ? 'x'.repeat(4097) : JSON.stringify({
      harness: 'orbit-worker-contract', storeName: 'catalog-v1', entry: 'tests/cloudflare/runtime/entry.ts',
      isolateNonce: state.httpMode === 'wrong-nonce' ? 'foreign-nonce' : NONCE,
    }))
  })
  http.on('connection', socket => {
    sockets.add(socket)
    socket.on('error', error => state.errors.push(`owned server socket: ${String(error)}`))
    socket.on('close', () => sockets.delete(socket))
  })
  let closed: Promise<void> | undefined
  const close = () => closed ??= (async () => {
    for (const socket of sockets) socket.destroy()
    const results = await Promise.allSettled([
      fake.close(),
      within(new Promise<void>((resolve, reject) => { http.closeAllConnections(); http.close(error => error ? reject(error) : resolve()) }), 5000),
    ])
    const failures = results.flatMap(item => item.status === 'rejected' ? [String(item.reason)] : item.value === 'timeout' ? ['Owned native HTTP server close timed out'] : [])
    if (failures.length) throw new Error(failures.join('; '))
  })()
  try {
    await new Promise<void>((resolve, reject) => { http.once('error', reject); http.listen(0, '127.0.0.1', resolve) })
    const port = (http.address() as AddressInfo).port
    if (port === 8787 || port === 8790) throw new Error('Native witness acquired a reserved port')
    return {
      state, clock, now, fake, close, emit, event, replyGc, scriptGcClock,
      script: (value: ScriptedDispatch | undefined) => { override = value },
      endpoints: validateOwnedEndpoints(`http://127.0.0.1:${port}`, fake.port),
    }
  } catch (error) {
    try { await close() } catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Native peer partial acquisition/cleanup') }
    throw error
  }
}

interface NativeWitnessEnvironment {
  directory: string
  peer: NativePeer
  connect(permission?: 'encoding-cpu' | 'heap-only', options?: Partial<NativeWitnessOptions>): Promise<Inspector>
  connectMode(mode: NativeMode): Promise<Inspector>
  connectGeneric(): Promise<Inspector>
  unconfirmedProfile(client: Inspector): void
  failedHttpCleanup(client: Inspector): void
  cancelledHttp(client: Inspector): void
  unconfirmedHttp(client: Inspector): void
}
/** Every iteration preserves failures before independently closing owned handles. */
async function withNativeWitness(rows: Record<string, unknown>[], name: string, exercise: (environment: NativeWitnessEnvironment) => Promise<void>): Promise<void> {
  const row: Record<string, unknown> = { name, producerKind: 'synthetic literal producer' }
  rows.push(row)
  let directory: string | undefined
  let peer: NativePeer | undefined
  let primary: unknown
  const clients: { client: Inspector; profileConfirmed: boolean; httpFailed: boolean | 'cancellation-evidence'; httpClosed: boolean }[] = []
  const cleanupErrors: unknown[] = []
  try {
    directory = await mkdtemp(path.join(os.tmpdir(), 'orbit-native-witness-'))
    directory = await realpath(directory)
    peer = await startNativePeer()
    const connectMode = async (mode: NativeMode) => {
      try {
        const client = await Inspector.connect(peer!.endpoints, { isolateNonce: NONCE, native: mode }, 3000)
        clients.push({ client, profileConfirmed: true, httpFailed: false, httpClosed: true })
        return client
      } catch (error) {
        if (error instanceof InspectorAcquisitionError) row.acquisitionFailure = { primary: String(error.primary), cleanup: error.cleanup, instrumentation: error.instrumentation }
        throw error
      }
    }
    const environment: NativeWitnessEnvironment = {
      directory, peer, connectMode,
      connect: (permission = 'encoding-cpu', options = {}) => connectMode(nativeWitnessMode({ directory: directory!, permission, now: peer!.now, ...options })),
      connectGeneric: async () => {
        const client = await Inspector.connect(peer!.endpoints, { isolateNonce: NONCE }, 3000)
        clients.push({ client, profileConfirmed: true, httpFailed: false, httpClosed: true })
        return client
      },
      unconfirmedProfile: client => { clients.find(item => item.client === client)!.profileConfirmed = false },
      failedHttpCleanup: client => { clients.find(item => item.client === client)!.httpFailed = true },
      cancelledHttp: client => { clients.find(item => item.client === client)!.httpFailed = 'cancellation-evidence' },
      unconfirmedHttp: client => { const entry = clients.find(item => item.client === client)!; entry.httpClosed = false; entry.httpFailed = true },
    }
    await exercise(environment)
  } catch (error) { primary = error; row.primary = String(error) }
  const retained: Record<string, unknown>[] = []
  row.clients = retained
  for (const entry of clients) {
    const data: Record<string, unknown> = {}
    retained.push(data)
    const [profile, http] = await Promise.allSettled([entry.client.cleanupProfile(), entry.client.cleanupGcHttp()])
    data.profileCleanup = profile.status === 'fulfilled' ? profile.value : String(profile.reason)
    data.httpCleanup = http.status === 'fulfilled' ? http.value : String(http.reason)
    try {
      if (profile.status !== 'fulfilled') throw profile.reason
      if (http.status !== 'fulfilled') throw http.reason
      expect(profile.value.confirmed, `${name}: profiler cleanup`).toBe(entry.profileConfirmed)
      expect(http.value.outcomes.every(item => item.confirmed), `${name}: HTTP physical closure`).toBe(entry.httpClosed)
      if (entry.httpFailed === 'cancellation-evidence') {
        // These deliberately failed cycles can race response delivery with
        // cancellation. Keep every resulting secondary error; only physical
        // closure, rather than a manufactured zero-error count, is required.
        expect(http.value.failures.every(item => typeof item === 'string' && item.length > 0)).toBe(true)
      } else expect(http.value.failures.length > 0, `${name}: retained HTTP errors`).toBe(entry.httpFailed)
    } catch (error) { cleanupErrors.push(error) }
    try {
      const closed = await entry.client.close(500)
      data.closure = closed
      expect(closed.confirmed, `${name}: inspector physical closure`).toBe(true)
      expect(closed.errors ?? []).toEqual([])
    } catch (error) { cleanupErrors.push(error) }
    data.inspector = entry.client.evidence()
  }
  if (peer) {
    row.producer = peer.state
    try { await peer.close(); row.peerClosed = true } catch (error) { cleanupErrors.push(error); row.peerClosureFailure = String(error) }
  }
  if (directory) {
    try {
      const claimPath = path.join(directory, 'native-profiler-owner-claim.json')
      try {
        const bytes = await readFile(claimPath)
        row.claim = { path: claimPath, base64: bytes.toString('base64'), sha256: createHash('sha256').update(bytes).digest('hex'), mode: (await lstat(claimPath)).mode & 0o777 }
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; row.claim = null }
    } catch (error) { cleanupErrors.push(error) }
    try { await rm(directory, { recursive: true, force: true }); row.syntheticDirectoryRemoved = true } catch (error) { cleanupErrors.push(error) }
  }
  row.cleanupErrors = cleanupErrors.map(String)
  if (primary || cleanupErrors.length) throw new AggregateError([...(primary ? [primary] : []), ...cleanupErrors], `${name}: witness/cleanup failure`)
}

test('explicit pinned native returns require exact owned Int32 envelopes and immutable params; generic reflections, provenance mismatch and byte-evidence overflow remain failures', async ({}, info) => {
  const rows: Record<string, unknown>[] = []
  const evidence: Record<string, unknown> = { witnesses: rows }
  let primary: { error: unknown } | null = null
  try {
    expect(() => nativeCapacityMode({} as OwnedRuntime, 'encoding-cpu')).toThrow(/validated owned runtime/)
    await withNativeWitness(rows, 'generic remains generic', async environment => {
      const client = await environment.connectGeneric()
      environment.unconfirmedProfile(client)
      await expect(client.startProfile()).rejects.toThrow(/Malformed CDP result for Profiler.enable/)
      expect(environment.peer.state.enableCalls).toBe(1)
      expect(environment.peer.state.commands.some(item => item.method === 'Profiler.start')).toBe(false)
    })
    for (const versions of [
      { workerd: '1.20261000.1', platform: '1.20261001.1', wrangler: '4.147.0', protocol: '1.3' },
      { workerd: '1.20261001.1', platform: '1.20261000.1', wrangler: '4.147.0', protocol: '1.3' },
      { workerd: '1.20261001.1', platform: '1.20261001.1', wrangler: '4.146.0', protocol: '1.3' },
      { workerd: '1.20261001.1', platform: '1.20261001.1', wrangler: '4.147.0', protocol: '1.2' },
    ]) await withNativeWitness(rows, `wrong provenance ${JSON.stringify(versions)}`, async environment => {
      await expect(environment.connect('encoding-cpu', { versions })).rejects.toThrow(/provenance mismatch/)
      expect(environment.peer.fake.state.upgrades).toBe(0)
      expect(environment.peer.state.enableCalls).toBe(0)
    })
    const invalid: { name: string; method: string; frame: (id: number) => unknown }[] = [
      { name: 'generic ACK is not a native fallback', method: 'Profiler.enable', frame: id => ({ id, result: {} }) },
      { name: 'result null is present', method: 'Profiler.enable', frame: id => ({ id, method: 'Profiler.enable', params: {}, result: null }) },
      { name: 'error null is present', method: 'Profiler.enable', frame: id => ({ id, method: 'Profiler.enable', params: {}, error: null }) },
      { name: 'zero id', method: 'Profiler.enable', frame: () => ({ id: 0, method: 'Profiler.enable', params: {} }) },
      { name: 'outside positive Int32', method: 'Profiler.enable', frame: () => ({ id: 2147483648, method: 'Profiler.enable', params: {} }) },
      { name: 'fractional id', method: 'Profiler.enable', frame: () => ({ id: 1.5, method: 'Profiler.enable', params: {} }) },
      { name: 'string id', method: 'Profiler.enable', frame: id => ({ id: String(id), method: 'Profiler.enable', params: {} }) },
      { name: 'wrong method', method: 'Profiler.enable', frame: id => ({ id, method: 'Profiler.start', params: {} }) },
      { name: 'missing params', method: 'Profiler.enable', frame: id => ({ id, method: 'Profiler.enable' }) },
      { name: 'null params', method: 'Profiler.enable', frame: id => ({ id, method: 'Profiler.enable', params: null }) },
      { name: 'array params', method: 'Profiler.enable', frame: id => ({ id, method: 'Profiler.enable', params: [] }) },
      { name: 'scalar params', method: 'Profiler.enable', frame: id => ({ id, method: 'Profiler.enable', params: 1 }) },
      { name: 'extra param', method: 'Profiler.enable', frame: id => ({ id, method: 'Profiler.enable', params: { unexpected: true } }) },
      { name: 'extra envelope key', method: 'Profiler.enable', frame: id => ({ id, method: 'Profiler.enable', params: {}, extra: true }) },
      { name: 'different interval', method: 'Profiler.setSamplingInterval', frame: id => ({ id, method: 'Profiler.setSamplingInterval', params: { interval: 501 } }) },
      { name: 'missing interval', method: 'Profiler.setSamplingInterval', frame: id => ({ id, method: 'Profiler.setSamplingInterval', params: {} }) },
      { name: 'fractional interval', method: 'Profiler.setSamplingInterval', frame: id => ({ id, method: 'Profiler.setSamplingInterval', params: { interval: 500.5 } }) },
      { name: 'string interval', method: 'Profiler.setSamplingInterval', frame: id => ({ id, method: 'Profiler.setSamplingInterval', params: { interval: '500' } }) },
      { name: 'altered start params after possible effect', method: 'Profiler.start', frame: id => ({ id, method: 'Profiler.start', params: { changed: 1 } }) },
      { name: 'standard result/error contradiction', method: 'Profiler.enable', frame: id => ({ id, result: {}, error: { code: -32000, message: 'contradiction' } }) },
      { name: 'invalid UTF-8 bytes', method: 'Profiler.enable', frame: () => Buffer.from([0x7b, 0x22, 0xff, 0x22, 0x7d]) },
      { name: 'valid reflected frame exceeds4096', method: 'Profiler.enable', frame: id => `${JSON.stringify({ id, method: 'Profiler.enable', params: {} })}${' '.repeat(4096)}` },
    ]
    for (const fixture of invalid) await withNativeWitness(rows, fixture.name, async environment => {
      const { peer } = environment
      peer.script((command, socket) => {
        if (command.method !== fixture.method) return false
        peer.emit(command, socket, fixture.frame(command.id)); return true
      })
      const client = await environment.connect()
      environment.unconfirmedProfile(client)
      await expect(client.startProfile()).rejects.toThrow()
      const snapshot = client.evidence()
      expect(snapshot.native!.frames.records.length).toBeGreaterThan(0)
      const frame = peer.state.frames.find(item => item.method === fixture.method)!
      expect(snapshot.native!.frames.records.some(item => item.sha256 === frame.sha256 && item.bytes === frame.bytes)).toBe(true)
      await expect(client.startProfile()).rejects.toThrow()
      expect(peer.state.enableCalls).toBe(1)
      expect(peer.state.unsafeResets).toBe(0)
    })
    await withNativeWitness(rows, 'unissued id cannot acknowledge owned work; exact returns and immutable interval do', async environment => {
      const { peer } = environment
      peer.script((command, socket) => {
        if (command.method !== 'Profiler.enable') return false
        peer.emit(command, socket, { id: 2000000000, method: 'Profiler.enable', params: {} })
        peer.emit(command, socket, { id: command.id, method: 'Profiler.enable', params: {} })
        return true
      })
      const client = await environment.connect()
      for (const interval of [0, -1, 0.5, 2147483648, Number.NaN, Number.POSITIVE_INFINITY]) await expect(client.startProfile(interval)).rejects.toThrow(/positive Int32/)
      expect(peer.state.enableCalls).toBe(0)
      await client.startProfile(500)
      const profile = await client.stopProfile(500)
      expect(profile.summary).toEqual({ busyMicros: 1000, idleMicros: 500, sampleCount: 3, nodeCount: 3, durationMicros: 1500, totalDeltaMicros: 1500, samplingIntervalMicros: 500 })
      expect(profile.raw).toEqual(literalNativeProfile())
      expect(peer.state.commands.find(item => item.method === 'Profiler.setSamplingInterval')!.params).toEqual({ interval: 500 })
      expect(client.evidence().native!.frames.records.some(item => item.id === 2000000000)).toBe(false)
      expect((await client.cleanupProfile()).native).toMatchObject({ quiescent: true, freshAllocationRemains: true, globalPredecessorStateConfirmed: false })
      expect(peer.state.enableCalls).toBe(2)
      expect(peer.state.unsafeResets).toBe(0)
      expect(peer.state.commands.some(item => item.method === 'Profiler.disable')).toBe(false)
    })
    const meta = { id: 7, method: 'Profiler.enable', phase: 'literal-test', arrivedAt: 12, disposition: 'literal' }
    const utf8 = Buffer.from('{"id":7,"method":"가","params":{}}')
    const bytes = new NativeFrameEvidence()
    expect(bytes.capture(utf8, meta)).toBe(true)
    expect(bytes.records[0]).toMatchObject({ rawBase64: utf8.toString('base64'), bytes: utf8.length, rawUtf8: '{"id":7,"method":"가","params":{}}', shape: { id: 'number', method: 'string', params: 'object' } })
    expect(bytes.records[0].sha256).toBe(createHash('sha256').update(utf8).digest('hex'))
    const invalidUtf8 = Buffer.from([0xf0, 0x28, 0x8c, 0x28])
    expect(bytes.capture(invalidUtf8, meta)).toBe(true)
    expect(bytes.records[1].rawUtf8).toBeNull()
    expect(bytes.records[1].rawBase64).toBe('8CiMKA==')
    const frameCap = new NativeFrameEvidence()
    expect(frameCap.capture(Buffer.alloc(4097, 0x61), meta)).toBe(false)
    expect(frameCap.records[0]).toMatchObject({ bytes: 4097, retainedBytes: 4096, truncated: true })
    const countCap = new NativeFrameEvidence()
    for (let index = 0; index < 64; index++) expect(countCap.capture(Buffer.from('{}'), meta)).toBe(true)
    expect(countCap.capture(Buffer.from('{}'), meta)).toBe(false)
    for (let index = 0; index < 1000; index++) expect(countCap.capture(Buffer.from('{}'), meta)).toBe(false)
    expect(countCap.records).toHaveLength(64)
    expect(countCap.overflow!.reason).toBe('frame record cap')
    expect(countCap.discardedAfterOverflow).toBe(1000)
    const totalCap = new NativeFrameEvidence()
    for (let index = 0; index < 16; index++) expect(totalCap.capture(Buffer.alloc(4096, 0x61), meta)).toBe(true)
    expect(totalCap.retainedBytes).toBe(65536)
    expect(totalCap.capture(Buffer.from('x'), meta)).toBe(false)
    expect(totalCap.retainedBytes).toBe(65536)
    expect(totalCap.records[16]).toMatchObject({ retainedBytes: 0, truncated: true, bytes: 1 })
    evidence.byteLimits = { bytes, frameCap, countCap, totalCap }
  } catch (error) { primary = { error } }
  await finalizeCase(info, 'native-command-and-byte-witnesses', evidence, primary, [])
})

test('native run claims are atomic and nontransferable; both next-start and cleanup guard owner epochs, overlapping operations and heap-only permission', async ({}, info) => {
  const rows: Record<string, unknown>[] = []
  let primary: { error: unknown } | null = null
  try {
    await withNativeWitness(rows, 'two valid epochs and one idempotent inactive reset', async environment => {
      const client = await environment.connect()
      await client.startProfile()
      await expect(client.startProfile()).rejects.toThrow(/replacement forbidden/)
      expect(environment.peer.state.enableCalls).toBe(1)
      await client.stopProfile()
      await client.startProfile()
      const active = client.evidence().native!.owner
      expect(active).toMatchObject({ enableEpoch: 2, startEpoch: 2, mayBeActive: true, stopEffect: null })
      await expect(client.startProfile()).rejects.toThrow(/replacement forbidden/)
      const first = client.cleanupProfile()
      expect(client.cleanupProfile()).toBe(first)
      const outcome = await first
      expect(outcome).toMatchObject({ confirmed: true, stopped: true, disabled: false, budgetMsPerRpc: 3000, configuredRpcBudgetMs: 12000 })
      expect(outcome.actions.map(action => action.method)).toEqual(['Runtime.getIsolateId', 'Profiler.stop', 'Profiler.enable', 'Runtime.getIsolateId'])
      expect(outcome.native).toMatchObject({ resetAcknowledged: true, quiescent: true, freshAllocationRemains: true })
      expect(environment.peer.state.enableCalls).toBe(3)
      expect(environment.peer.state.stopCalls).toBe(2)
      expect(environment.peer.state.unsafeResets).toBe(0)
      expect(client.evidence().native!.owner).toMatchObject({ enableEpoch: 3, startEpoch: 2, startedInEpoch: false, stopEffect: null, resetEnableEpoch: 3 })
      expect(client.evidence().native!.owner.stopEffects.map(effect => ({ enable: effect.enableEpoch, start: effect.startEpoch, profile: effect.profileIndex }))).toEqual([
        { enable: 1, start: 1, profile: 0 }, { enable: 2, start: 2, profile: 1 },
      ])
      await expect(client.startProfile()).rejects.toThrow(/finalized owner/)
      const claimPath = path.join(environment.directory, 'native-profiler-owner-claim.json')
      const bytes = await readFile(claimPath)
      expect((await lstat(claimPath)).mode & 0o777).toBe(0o600)
      expect(JSON.parse(bytes.toString('utf8'))).toMatchObject({ contract: 'workerd-1.20261001.1', claimant: { permission: 'encoding-cpu' }, isolate: 'isolate-one', nonce: NONCE })
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(client.evidence().native!.owner.claim!.sha256)
    })
    await withNativeWitness(rows, 'acknowledged enable with no possible start permits one inactive reset', async environment => {
      const { peer } = environment
      const client = await environment.connect()
      peer.script((command, socket) => {
        if (command.method !== 'Profiler.setSamplingInterval') return false
        peer.emit(command, socket, { id: command.id, error: { code: -32000, message: 'literal interval failure before start' } }); return true
      })
      await expect(client.startProfile()).rejects.toThrow(/literal interval failure before start/)
      expect(client.evidence().native!.owner).toMatchObject({ enableEpoch: 1, startedInEpoch: false, mayBeActive: false, stopEffect: null })
      const cleanup = await client.cleanupProfile()
      expect(cleanup.confirmed).toBe(true)
      expect(cleanup.native).toMatchObject({ resetAcknowledged: true, freshAllocationRemains: true })
      expect(peer.state.stopCalls).toBe(0)
      expect(peer.state.enableCalls).toBe(2)
      expect(peer.state.commands.some(item => item.method === 'Profiler.start')).toBe(false)
      expect(peer.state.unsafeResets).toBe(0)
    })
    await withNativeWitness(rows, 'atomic race and new frontend cannot replace the run owner', async environment => {
      const first = await environment.connect()
      const second = await environment.connect()
      const results = await Promise.allSettled([first.startProfile(), second.startProfile()])
      expect(results.filter(item => item.status === 'fulfilled')).toHaveLength(1)
      expect(results.filter(item => item.status === 'rejected')).toHaveLength(1)
      const loser = results.find(item => item.status === 'rejected') as PromiseRejectedResult
      expect(String(loser.reason)).toMatch(/claim refused.*EEXIST/)
      const winner = results[0].status === 'fulfilled' ? first : second
      expect(environment.peer.state.enableCalls).toBe(1)
      const original = await readFile(path.join(environment.directory, 'native-profiler-owner-claim.json'))
      await winner.stopProfile()
      const third = await environment.connect()
      await expect(third.startProfile()).rejects.toThrow(/claim refused.*EEXIST/)
      expect(await readFile(path.join(environment.directory, 'native-profiler-owner-claim.json'))).toEqual(original)
      expect(environment.peer.state.enableCalls).toBe(1)
      expect(environment.peer.state.unsafeResets).toBe(0)
    })
    await withNativeWitness(rows, 'partial predecessor claim remains byte-identical and forbids enable', async environment => {
      const claimPath = path.join(environment.directory, 'native-profiler-owner-claim.json')
      await writeFile(claimPath, '{"claimant":', { flag: 'wx', mode: 0o600 })
      environment.peer.state.active = true // independently model an unknown predecessor
      const client = await environment.connect()
      await expect(client.startProfile()).rejects.toThrow(/claim refused.*EEXIST/)
      await expect(client.startProfile()).rejects.toThrow(/claim refused/)
      expect(await readFile(claimPath, 'utf8')).toBe('{"claimant":')
      const cleanup = await client.cleanupProfile()
      expect(cleanup.native).toMatchObject({ noProfilerCommandsIssued: true, globalPredecessorStateConfirmed: false })
      expect(environment.peer.state.enableCalls).toBe(0)
      expect(environment.peer.state.active).toBe(true)
    })
    await withNativeWitness(rows, 'changed claim fails before either replacement boundary', async environment => {
      const client = await environment.connect()
      await client.startProfile()
      await client.stopProfile()
      const claimPath = path.join(environment.directory, 'native-profiler-owner-claim.json')
      await writeFile(claimPath, 'deliberately changed synthetic claim\n')
      environment.unconfirmedProfile(client)
      await expect(client.startProfile()).rejects.toThrow(/claim.*changed/)
      const cleanup = await client.cleanupProfile()
      expect(cleanup.confirmed).toBe(false)
      expect(cleanup.actions.filter(action => action.method === 'Profiler.enable').every(action => action.status === 'skipped')).toBe(true)
      expect(environment.peer.state.enableCalls).toBe(1)
      expect(environment.peer.state.unsafeResets).toBe(0)
    })
    await withNativeWitness(rows, 'single-client capability cannot be copied or reused', async environment => {
      const mode = nativeWitnessMode({ directory: environment.directory, permission: 'encoding-cpu' })
      expect(Object.isFrozen(mode)).toBe(true)
      await expect(environment.connectMode({ ...mode })).rejects.toThrow(/copied\/reused/)
      const client = await environment.connectMode(mode)
      await expect(environment.connectMode(mode)).rejects.toThrow(/copied\/reused/)
      await client.startProfile()
      await client.stopProfile()
      expect(environment.peer.fake.state.upgrades).toBe(1)
    })
    await withNativeWitness(rows, 'heap-only frontend has no profiler permission or predecessor-state claim', async environment => {
      environment.peer.state.active = true
      const client = await environment.connect('heap-only')
      await expect(client.startProfile()).rejects.toThrow(/no CPU profiler permission/)
      await expect(client.stopProfile()).rejects.toThrow(/no CPU profiler permission/)
      for (const method of ['Profiler.enable', 'Profiler.start', 'Profiler.stop', 'Profiler.disable']) await expect(client.call(method)).rejects.toThrow(/owned coordinated operation/)
      const cleanup = await client.cleanupProfile()
      expect(cleanup).toMatchObject({ confirmed: true, stopped: false, disabled: false })
      expect(cleanup.native).toMatchObject({ noProfilerCommandsIssued: true, resetAcknowledged: false, globalPredecessorStateConfirmed: false })
      expect(environment.peer.state.commands.filter(item => item.method.startsWith('Profiler.'))).toEqual([])
      expect(environment.peer.state.active).toBe(true)
    })
    await withNativeWitness(rows, 'overlap refuses replacement and reports cleanup uncertainty', async environment => {
      const client = await environment.connect()
      let observed!: () => void
      const arrived = new Promise<void>(resolve => { observed = resolve })
      let release!: () => void
      environment.peer.script((command, socket) => {
        if (command.method !== 'Profiler.start') return false
        release = () => environment.peer.emit(command, socket, { id: command.id, method: 'Profiler.start', params: {} })
        observed(); return true
      })
      const pending = client.startProfile()
      void pending.catch(() => {})
      try {
        expect(await within(arrived, 3000)).not.toBe('timeout')
        await expect(client.startProfile()).rejects.toThrow(/overlap/)
        await expect(client.stopProfile()).rejects.toThrow(/overlap/)
        environment.unconfirmedProfile(client)
        expect((await client.cleanupProfile()).failures).toContain('Native cleanup overlaps an in-flight start/stop; no replacement permitted')
      } finally { release?.() }
      await pending
      expect(environment.peer.state.enableCalls).toBe(1)
      expect(environment.peer.state.unsafeResets).toBe(0)
    })
  } catch (error) { primary = { error } }
  await finalizeCase(info, 'native-claim-and-epoch-witnesses', { witnesses: rows }, primary, [])
})

test('complete native stop effects require the full producer tree and schema; errors, late profiles and lost identity never authorize unsafe enable or reset', async ({}, info) => {
  const rows: Record<string, unknown>[] = []
  let primary: { error: unknown } | null = null
  try {
    const nodes = (value: Record<string, unknown>) => value.nodes as Record<string, unknown>[]
    const frame = (value: Record<string, unknown>) => nodes(value)[1].callFrame as Record<string, unknown>
    const malformed: { name: string; change: (value: Record<string, unknown>) => void }[] = [
      ...['nodes', 'startTime', 'endTime', 'samples', 'timeDeltas'].map(key => ({ name: `missing ${key}`, change: (value: Record<string, unknown>) => { delete value[key] } })),
      { name: 'empty nodes', change: value => { value.nodes = [] } },
      { name: 'duplicate id', change: value => { nodes(value)[1].id = 1 } },
      { name: 'zero id', change: value => { nodes(value)[1].id = 0 } },
      { name: 'id outside Int32', change: value => { nodes(value)[1].id = 2147483648 } },
      { name: 'fractional id', change: value => { nodes(value)[1].id = 2.5 } },
      { name: 'unknown child', change: value => { nodes(value)[0].children = [2, 4] } },
      { name: 'duplicate child', change: value => { nodes(value)[0].children = [2, 2, 3] } },
      { name: 'cycle to root', change: value => { nodes(value)[1].children = [1] } },
      { name: 'multiple parents', change: value => { nodes(value)[1].children = [3] } },
      { name: 'disconnected node', change: value => { nodes(value)[0].children = [2] } },
      { name: 'not root first', change: value => { nodes(value).reverse() } },
      { name: 'unknown sample', change: value => { value.samples = [2, 9, 2] } },
      { name: 'unequal arrays', change: value => { value.timeDeltas = [500] } },
      { name: 'negative delta', change: value => { value.timeDeltas = [500, -1, 500] } },
      { name: 'fractional delta', change: value => { value.timeDeltas = [500, 0.5, 500] } },
      { name: 'delta outside Int32', change: value => { value.timeDeltas = [500, 2147483648, 500] } },
      { name: 'negative time', change: value => { value.startTime = -1 } },
      { name: 'end before start', change: value => { value.endTime = 9 } },
      { name: 'nonfinite time encoded null', change: value => { value.endTime = Number.POSITIVE_INFINITY } },
      { name: 'required frame scriptId absent', change: value => { delete frame(value).scriptId } },
      { name: 'required frame column absent', change: value => { delete frame(value).columnNumber } },
      { name: 'wrong function type', change: value => { frame(value).functionName = 1 } },
      { name: 'wrong URL type', change: value => { frame(value).url = null } },
      { name: 'fractional line', change: value => { frame(value).lineNumber = 1.5 } },
      { name: 'column outside Int32', change: value => { frame(value).columnNumber = -2147483649 } },
      { name: 'negative optional hitCount', change: value => { nodes(value)[1].hitCount = -1 } },
      { name: 'wrong optional children', change: value => { nodes(value)[1].children = null } },
      { name: 'wrong optional positionTicks', change: value => { nodes(value)[1].positionTicks = {} } },
      { name: 'missing tick member', change: value => { nodes(value)[1].positionTicks = [{ line: 5 }] } },
      { name: 'negative ticks', change: value => { nodes(value)[1].positionTicks = [{ line: 5, ticks: -1 }] } },
      { name: 'fractional tick line', change: value => { nodes(value)[1].positionTicks = [{ line: 5.5, ticks: 2 }] } },
      { name: 'wrong optional deoptReason', change: value => { nodes(value)[1].deoptReason = false } },
    ]
    const envelopes: { name: string; payload: (id: number) => unknown }[] = [
      { name: 'reflected stop', payload: id => ({ id, method: 'Profiler.stop', params: {} }) },
      { name: 'generic empty ACK', payload: id => ({ id, result: {} }) },
      { name: 'missing profile', payload: id => ({ id, method: 'Profiler.stop', result: {} }) },
      { name: 'stop error null contradiction', payload: id => ({ id, method: 'Profiler.stop', result: { profile: literalNativeProfile() }, error: null }) },
      { name: 'stop params contradiction', payload: id => ({ id, method: 'Profiler.stop', result: { profile: literalNativeProfile() }, params: {} }) },
      { name: 'wrong stop method', payload: id => ({ id, method: 'Profiler.start', result: { profile: literalNativeProfile() } }) },
      ...malformed.map(fixture => ({
        name: fixture.name,
        payload: (id: number) => {
          const profile = literalNativeProfile() as unknown as Record<string, unknown>
          fixture.change(profile)
          return { id, method: 'Profiler.stop', result: { profile } }
        },
      })),
    ]
    for (const fixture of envelopes) await withNativeWitness(rows, fixture.name, async environment => {
      const { peer } = environment
      const client = await environment.connect()
      await client.startProfile()
      peer.script((command, socket) => {
        if (command.method !== 'Profiler.stop') return false
        // This adversary leaves the independent producer active. A reset sent
        // merely because a stop response arrived would increment unsafeResets.
        peer.emit(command, socket, fixture.payload(command.id)); return true
      })
      environment.unconfirmedProfile(client)
      await expect(client.stopProfile()).rejects.toThrow()
      expect(client.evidence().native!.owner.stopEffect).toBeNull()
      expect(client.profileState.stopAcknowledged).toBe(false)
      expect(client.evidence().native!.completeProfiles).toEqual([])
      await expect(client.startProfile()).rejects.toThrow()
      expect((await client.cleanupProfile()).confirmed).toBe(false)
      const received = client.evidence().native!.frames.records
      const sent = peer.state.frames.find(item => item.method === 'Profiler.stop')!
      expect(received.some(item => item.sha256 === sent.sha256 && item.bytes === sent.bytes)).toBe(true)
      expect(peer.state.active).toBe(true)
      expect(peer.state.enableCalls).toBe(1)
      expect(peer.state.unsafeResets).toBe(0)
    })
    for (const zero of ['samples', 'duration', 'deltas'] as const) await withNativeWitness(rows, `valid stop effect with zero ${zero} fails measured CPU`, async environment => {
      const { peer } = environment
      const client = await environment.connect()
      await client.startProfile()
      peer.script((command, socket) => {
        if (command.method !== 'Profiler.stop') return false
        const profile = literalNativeProfile()
        if (zero === 'samples') { profile.samples = []; profile.timeDeltas = [] }
        if (zero === 'duration') profile.endTime = 10
        if (zero === 'deltas') profile.timeDeltas = [0, 0, 0]
        peer.state.active = false
        peer.emit(command, socket, { id: command.id, method: 'Profiler.stop', result: { profile } }); return true
      })
      await expect(client.stopProfile()).rejects.toThrow(/no samples|no positive duration|total zero/)
      expect(client.profileState.stopAcknowledged).toBe(true)
      expect(client.evidence().native!.owner.stopEffect).not.toBeNull()
      expect(client.evidence().native!.completeProfiles).toHaveLength(1)
      expect((await client.cleanupProfile()).confirmed).toBe(true)
      expect(peer.state.stopCalls).toBe(1)
      expect(peer.state.enableCalls).toBe(2)
      expect(peer.state.unsafeResets).toBe(0)
    })
    await withNativeWitness(rows, 'full valid large profile stays uncropped and absent optional fields stay absent', async environment => {
      const { peer } = environment
      const client = await environment.connect()
      await client.startProfile()
      peer.script((command, socket) => {
        if (command.method !== 'Profiler.stop') return false
        const profile = literalNativeProfile()
        profile.nodes[1].callFrame.url = `fixture://${'x'.repeat(5000)}`
        peer.state.active = false
        peer.emit(command, socket, { id: command.id, method: 'Profiler.stop', result: { profile } }); return true
      })
      const result = await client.stopProfile()
      expect(result.summary.busyMicros).toBe(1000)
      expect(result.raw.nodes[2]).not.toHaveProperty('children')
      expect(result.raw.nodes[2]).not.toHaveProperty('hitCount')
      const retained = client.evidence().native!.completeProfiles[0]
      expect(retained.bytes).toBeGreaterThan(4096)
      expect(Buffer.byteLength(retained.rawUtf8)).toBe(retained.bytes)
      expect(createHash('sha256').update(retained.rawUtf8).digest('hex')).toBe(retained.sha256)
      expect(JSON.parse(retained.rawUtf8).result.profile).toEqual(result.raw)
      expect(client.evidence().native!.frames.overflow).toBeNull()
    })
    await withNativeWitness(rows, 'ordinary native stop errors preserve activity and never call generic disable or reset', async environment => {
      const { peer } = environment
      const client = await environment.connect()
      await client.startProfile()
      peer.script((command, socket) => {
        if (command.method !== 'Profiler.stop') return false
        peer.emit(command, socket, { id: command.id, error: { code: -32000, message: 'literal native stop failed' } }); return true
      })
      environment.unconfirmedProfile(client)
      await expect(client.stopProfile()).rejects.toThrow(/literal native stop failed/)
      await expect(client.startProfile()).rejects.toThrow(/replacement forbidden/)
      const cleanup = await client.cleanupProfile()
      expect(cleanup.confirmed).toBe(false)
      expect(cleanup.failures.some(item => item.includes('literal native stop failed'))).toBe(true)
      expect(peer.state.stopCalls).toBe(2)
      expect(peer.state.enableCalls).toBe(1)
      expect(peer.state.commands.some(item => item.method === 'Profiler.disable')).toBe(false)
      expect(peer.state.active).toBe(true)
      expect(peer.state.unsafeResets).toBe(0)
    })
    await withNativeWitness(rows, 'late stop never qualifies and a later cleanup ACK does not erase the stop failure', async environment => {
      const { peer } = environment
      const client = await environment.connect()
      await client.startProfile()
      let once = true
      peer.script((command, socket) => {
        if (command.method !== 'Profiler.stop' || !once) return false
        once = false; peer.clock.offset += 30001
        peer.emit(command, socket, { id: command.id, method: 'Profiler.stop', result: { profile: literalNativeProfile() } }); return true
      })
      environment.unconfirmedProfile(client)
      await expect(client.stopProfile()).rejects.toThrow(/reply after original deadline/)
      expect(client.evidence().native!.completeProfiles).toEqual([])
      expect(client.evidence().native!.frames.records.some(item => item.disposition === 'late-owned-reply' && item.method === 'Profiler.stop')).toBe(true)
      await expect(client.startProfile()).rejects.toThrow(/replacement forbidden/)
      expect((await client.cleanupProfile()).confirmed).toBe(false)
      expect(peer.state.stopCalls).toBe(2)
      expect(peer.state.enableCalls).toBe(1)
      expect(peer.state.unsafeResets).toBe(0)
    })
    for (const point of ['after-measured-stop', 'final-cleanup-identity'] as const) await withNativeWitness(rows, point, async environment => {
      const { peer } = environment
      const client = await environment.connect()
      await client.startProfile()
      let identities = 0
      if (point === 'final-cleanup-identity') await client.stopProfile()
      peer.script((command, socket) => {
        if (command.method !== 'Runtime.getIsolateId') return false
        if (++identities !== 2) return false
        peer.emit(command, socket, { id: command.id, result: { id: 'isolate-two' } }); return true
      })
      environment.unconfirmedProfile(client)
      if (point === 'after-measured-stop') await expect(client.stopProfile()).rejects.toThrow(/isolate changed/)
      const cleanup = await client.cleanupProfile()
      expect(cleanup.confirmed).toBe(false)
      expect(peer.state.enableCalls).toBe(point === 'after-measured-stop' ? 1 : 2)
      await expect(client.startProfile()).rejects.toThrow(/binding invalid/)
      expect(peer.state.unsafeResets).toBe(0)
    })
    await withNativeWitness(rows, 'detached target on an open retained socket forbids replacement', async environment => {
      const { peer } = environment
      const client = await environment.connect()
      peer.script((command, socket) => {
        if (command.method !== 'Profiler.start') return false
        peer.event(socket, 'Target.detachedFromTarget')
        peer.emit(command, socket, { id: command.id, method: 'Profiler.start', params: {} }); return true
      })
      environment.unconfirmedProfile(client)
      await expect(client.startProfile()).rejects.toThrow(/ownership changed/)
      expect(peer.fake.openWebSockets()).toBe(1)
      expect((await client.cleanupProfile()).confirmed).toBe(false)
      expect(peer.state.stopCalls).toBe(0)
      expect(peer.state.enableCalls).toBe(1)
      expect(peer.state.unsafeResets).toBe(0)
    })
  } catch (error) { primary = { error } }
  await finalizeCase(info, 'native-stop-effect-witnesses', { witnesses: rows }, primary, [])
})

test('native transport observes actual graceful or forced closure within one original deadline, preserves call errors and cannot rehabilitate absent or late events', async ({}, info) => {
  const rows: Record<string, unknown>[] = []
  let primary: { error: unknown } | null = null
  try {
    for (const scenario of ['graceful', 'forced', 'absent', 'late', 'close-error-with-event', 'terminate-error', 'socket-error-with-event'] as const) {
      const events = new EventEmitter()
      const observed = { closeCalls: 0, terminateCalls: 0, time: 100, closeObserved: 0 }
      const event = (code: number) => { observed.closeObserved++; events.emit('close', code, Buffer.from('literal close')) }
      const socket = Object.assign(events, {
        readyState: 1, send: () => {},
        close: () => {
          observed.closeCalls++
          if (scenario === 'graceful') { observed.time = 110; event(1000) }
          if (scenario === 'close-error-with-event' || scenario === 'terminate-error') throw new Error('literal close call error')
          if (scenario === 'socket-error-with-event') { events.emit('error', new Error('literal socket error')); observed.time = 112; event(1006) }
        },
        terminate: () => {
          observed.terminateCalls++
          if (scenario === 'terminate-error') throw new Error('literal terminate call error')
          if (scenario === 'late') { observed.time = 201; event(1006) }
          if (scenario === 'forced' || scenario === 'close-error-with-event') { observed.time = 121; event(1006) }
        },
      }) as unknown as WsSocket
      const outcome = await closeNativeTransport(socket, 100, () => observed.time)
      rows.push({ scenario, observed, outcome })
      expect(outcome.native).toMatchObject({ beganAt: 100, deadline: 200, graceMs: 20 })
      expect(observed.closeCalls).toBe(1)
      if (scenario === 'graceful') {
        expect(outcome).toMatchObject({ confirmed: true, code: 1000, errors: [], native: { disposition: 'graceful', closeAt: 110, terminateAt: null } })
        expect(observed.terminateCalls).toBe(0)
      } else if (scenario === 'forced' || scenario === 'close-error-with-event') {
        expect(outcome).toMatchObject({ confirmed: true, code: 1006, native: { disposition: 'forced', closeAt: 121 } })
        expect(observed.terminateCalls).toBe(1)
        expect(outcome.errors!.length).toBe(scenario === 'forced' ? 0 : 1)
        if (scenario === 'close-error-with-event') expect(outcome.errors![0]).toContain('literal close call error')
      } else if (scenario === 'socket-error-with-event') {
        expect(outcome.confirmed).toBe(true)
        expect(outcome.errors).toEqual(['socket: Error: literal socket error'])
      } else {
        expect(outcome.confirmed).toBe(false)
        expect(outcome.native!.disposition).toBe('unconfirmed')
        expect(observed.terminateCalls).toBe(1)
        if (scenario === 'terminate-error') expect(outcome.errors).toEqual(['close: Error: literal close call error', 'terminate: Error: literal terminate call error'])
        const beforeLate = structuredClone(outcome)
        observed.time = 250; event(1000)
        expect(outcome).toEqual(beforeLate)
      }
    }
    let calls = 0
    const invalid = Object.assign(new EventEmitter(), { readyState: 1, send: () => {}, close: () => { calls++ }, terminate: () => { calls++ } }) as unknown as WsSocket
    for (const budget of [0, -1, 5001, Number.NaN, Number.POSITIVE_INFINITY]) await expect(closeNativeTransport(invalid, budget)).rejects.toThrow(/positive finite budget/)
    expect(calls).toBe(0)
    const fractionalEvents = new EventEmitter()
    const fractional = Object.assign(fractionalEvents, { readyState: 1, send: () => {}, close: () => fractionalEvents.emit('close', 1000, 'literal'), terminate: () => {} }) as unknown as WsSocket
    expect(await closeNativeTransport(fractional, 1.5, () => 100)).toMatchObject({ confirmed: true, native: { deadline: 101.5, graceMs: 0 } })
    for (const stall of [false, true]) await withNativeWitness(rows, `owned actual WebSocket ${stall ? 'force-joined' : 'graceful'}`, async environment => {
      const client = await environment.connect('heap-only')
      if (stall) environment.peer.fake.stall()
      const first = client.close(500)
      expect(client.close(3000)).toBe(first)
      const outcome = await first
      expect(outcome.confirmed).toBe(true)
      expect(outcome.errors).toEqual([])
      expect(outcome.native!.deadline - outcome.native!.beganAt).toBe(500)
      expect(outcome.native!.graceMs).toBe(100)
      expect(outcome.native!.disposition).toBe(stall ? 'forced' : 'graceful')
      expect(outcome.native!.closeAt).toBeLessThan(outcome.native!.deadline)
      expect(outcome.code).toBe(stall ? 1006 : 1000)
    })
  } catch (error) { primary = { error } }
  await finalizeCase(info, 'native-transport-witnesses', { witnesses: rows }, primary, [])
})

test('native GC uses one ordered owned identity GET even after early acknowledgement, retains its original30s deadline and refuses failed barriers, replies, binding changes and repeats', async ({}, info) => {
  const rows: Record<string, unknown>[] = []
  let primary: { error: unknown } | null = null
  try {
    for (const mode of ['on-get', 'early'] as const) await withNativeWitness(rows, `ordered GC ${mode}`, async environment => {
      const { peer } = environment
      peer.state.gcMode = mode
      const client = await environment.connect('heap-only')
      for (let cycle = 0; cycle < 2; cycle++) await client.collectGarbage()
      expect(peer.state.gcCommands).toBe(2)
      expect(peer.state.gets).toBe(2)
      expect(peer.state.barrierReplies).toBe(2)
      expect(peer.state.finalIdentities).toBe(2)
      expect(peer.state.wakeBeforeBarrier).toBe(0)
      for (const request of peer.state.http) {
        expect(request).toMatchObject({ method: 'GET', path: '/__test/identity', headers: { 'accept-encoding': 'identity', connection: 'close' } })
      }
      const cycles = client.evidence().native!.gcCycles
      expect(cycles).toHaveLength(2)
      for (const cycle of cycles) {
        expect(cycle.failure).toBeNull()
        expect(cycle.gc.deadline).toBe(cycle.gc.sentAt! + 30000)
        expect(cycle.deadline).toBe(cycle.gc.deadline)
        expect(cycle.deadline).toBe(cycle.gc.sentAt! + 30000)
        expect(cycle.barrier.id).toBe(cycle.gc.id! + 1)
        expect(cycle.barrier.deadline).toBe(cycle.deadline)
        expect(cycle.finalIdentity.deadline).toBe(cycle.deadline)
        expect(cycle.http).toMatchObject({ bodyCap: 4096, overflow: false, expectedNonce: NONCE, observedNonce: NONCE, cancelAt: null, deadline: cycle.deadline })
        expect(cycle.http!.startedAt).toBeGreaterThanOrEqual(cycle.barrier.acknowledgedAt!)
        for (const at of [cycle.gc.acknowledgedAt, cycle.http!.responseEndedAt, cycle.http!.requestClosedAt, cycle.http!.socketClosedAt, cycle.finalIdentity.acknowledgedAt, cycle.completedAt]) {
          expect(at).not.toBeNull()
          expect(at).toBeLessThanOrEqual(cycle.deadline)
        }
        if (mode === 'early') expect(cycle.gc.acknowledgedAt).toBeLessThanOrEqual(cycle.barrier.acknowledgedAt!)
        else expect(cycle.gc.acknowledgedAt).toBeGreaterThanOrEqual(cycle.http!.startedAt)
      }
      const cleanup = client.cleanupGcHttp()
      expect(client.cleanupGcHttp()).toBe(cleanup)
      expect((await cleanup).outcomes).toHaveLength(2)
      await expect(client.collectGarbage()).rejects.toThrow(/finalized/)
      expect(peer.state.gets).toBe(2)
      expect(peer.state.commands.filter(item => item.method.startsWith('Profiler.'))).toEqual([])
    })
    for (const mode of ['wrong', 'malformed', 'clear', 'detach', 'late', 'error'] as const) await withNativeWitness(rows, `failed barrier ${mode} cannot wake`, async environment => {
      const { peer } = environment
      peer.state.barrierMode = mode
      const client = await environment.connect('heap-only')
      await expect(client.collectGarbage()).rejects.toThrow()
      expect(peer.state.gcCommands).toBe(1)
      expect(peer.state.gets).toBe(0)
      expect(peer.state.wakeBeforeBarrier).toBe(0)
      const cycle = client.evidence().native!.gcCycles[0]
      expect(cycle.failure).not.toBeNull()
      expect(cycle.gc.deadline).toBe(cycle.gc.sentAt! + 30000)
      expect(cycle.deadline).toBe(cycle.gc.deadline)
      expect(cycle.possibleQueuedEffect).toBe(true)
      expect(cycle.http).toBeNull()
      const before = peer.state.commands.length
      await expect(client.collectGarbage()).rejects.toThrow()
      expect(peer.state.commands).toHaveLength(before)
    })
    for (const mode of ['error', 'malformed', 'late'] as const) await withNativeWitness(rows, `failed original GC ${mode} cannot become an HTTP-only success`, async environment => {
      const { peer } = environment
      peer.state.gcMode = mode
      const client = await environment.connect('heap-only')
      environment.cancelledHttp(client)
      await expect(client.collectGarbage()).rejects.toThrow()
      expect(peer.state.gcCommands).toBe(1)
      expect(peer.state.gets).toBe(1)
      expect(peer.state.wakeBeforeBarrier).toBe(0)
      expect(peer.state.finalIdentities).toBe(0)
      const cycle = client.evidence().native!.gcCycles[0]
      expect(cycle.completedAt).toBeNull()
      expect(cycle.gc.deadline).toBe(cycle.gc.sentAt! + 30000)
      expect(cycle.deadline).toBe(cycle.gc.deadline)
      expect(cycle.http!.cancelAt).not.toBeNull()
      expect(client.evidence().native!.frames.records.some(frame => frame.method === 'HeapProfiler.collectGarbage')).toBe(true)
      await expect(client.collectGarbage()).rejects.toThrow()
      expect(peer.state.gets).toBe(1)
    })
    for (const mode of ['wrong', 'clear'] as const) await withNativeWitness(rows, `final qualification ${mode} rejects earlier GC and HTTP success`, async environment => {
      const { peer } = environment
      peer.state.finalMode = mode
      const client = await environment.connect('heap-only')
      environment.cancelledHttp(client)
      await expect(client.collectGarbage()).rejects.toThrow(/isolate changed|contexts.*cleared/i)
      const cycle = client.evidence().native!.gcCycles[0]
      expect(cycle.gc.acknowledgedAt).toBeDefined()
      expect(cycle.http!.completedAt).not.toBeNull()
      expect(cycle.completedAt).toBeNull()
      expect(peer.state.gcCommands).toBe(1)
      expect(peer.state.gets).toBe(1)
      await expect(client.collectGarbage()).rejects.toThrow()
    })
    for (const mode of ['wrong-nonce', 'redirect', 'encoded', 'malformed', 'oversized'] as const) await withNativeWitness(rows, `identity witness ${mode} fails despite original GC acknowledgement`, async environment => {
      const { peer } = environment
      peer.state.httpMode = mode
      const client = await environment.connect('heap-only')
      environment.failedHttpCleanup(client)
      await expect(client.collectGarbage()).rejects.toThrow()
      const cycle = client.evidence().native!.gcCycles[0]
      expect(cycle.completedAt).toBeNull()
      expect(cycle.http!.cancelAt).not.toBeNull()
      expect(cycle.http!.errors.length).toBeGreaterThan(0)
      expect(peer.state.gets).toBe(1)
      expect(peer.state.gcCommands).toBe(1)
      expect(peer.state.finalIdentities).toBe(0)
      expect(peer.state.http[0].path).toBe('/__test/identity')
      if (mode === 'oversized') {
        expect(cycle.http!.bodyBytes).toBe(4097)
        expect(Buffer.from(cycle.http!.bodyBase64, 'base64')).toHaveLength(4096)
        expect(cycle.http!.overflow).toBe(true)
      }
    })
    await withNativeWitness(rows, 'dispatch-only pending GC cannot overlap or gain a second wake; late ACK stays evidence', async environment => {
      const { peer } = environment
      peer.state.gcMode = 'missing'
      let wake!: () => void
      const woken = new Promise<void>(resolve => { wake = resolve })
      const client = await environment.connect('heap-only', { httpFactory: (url, options, response) => {
        // Use the real owned HTTP transport; this hook only observes acquisition.
        const request = httpRequestForWitness(url, options, response)
        const closed = { request: false, socket: false }
        const complete = () => { if (closed.request && closed.socket) queueMicrotask(wake) }
        request.once('close', () => { closed.request = true; complete() })
        request.once('socket', socket => { socket.once('close', () => { closed.socket = true; complete() }) })
        return request
      } })
      environment.cancelledHttp(client)
      const gc = client.collectGarbage()
      void gc.catch(() => {})
      try {
        expect(await within(woken, 3000)).not.toBe('timeout')
        expect(client.evidence().native!.gcCycles[0].http!.completedAt).not.toBeNull()
        expect(client.evidence().native!.gcCycles[0].gc.acknowledgedAt).toBeUndefined()
        await expect(client.collectGarbage()).rejects.toThrow(/overlaps/)
        expect(peer.state.gcCommands).toBe(1)
        expect(peer.state.gets).toBe(1)
        peer.clock.offset += 30001
        peer.replyGc()
        await expect(gc).rejects.toThrow(/deadline/)
        expect(client.evidence().native!.gcCycles[0].completedAt).toBeNull()
        expect(client.evidence().native!.frames.records.some(frame => frame.disposition === 'late-owned-reply')).toBe(true)
      } finally {
        // Cancels an unfinished owned cycle without another command or budget.
        await client.cleanupGcHttp()
      }
      const before = peer.state.commands.length
      await expect(client.collectGarbage()).rejects.toThrow()
      expect(peer.state.commands).toHaveLength(before)
    })
    // Independent producer schedules: none of these times or expected deadlines
    // comes from an Inspector trace. The barrier reply, HTTP producer and final
    // reply advance the shared clock; the GC budget is never renewed.
    for (const fixture of [
      {
        name: 'literal fractional GC send preserves 14982.969042 and original deadline 44982.969042',
        clock: { initial: 14000.25, gcSend: 14982.969042, barrierReply: 15000.25, httpRequest: 16000.25, finalReply: 17000.25 },
        deadline: 44982.969042, preserveInverseEvidence: true,
      },
      {
        name: 'advancing binary-fraction GC phases all retain original deadline 31000.25',
        clock: { initial: 100.25, gcSend: 1000.25, barrierReply: 2000.25, httpRequest: 3000.25, finalReply: 4000.25 },
        deadline: 31000.25, preserveInverseEvidence: false,
      },
    ] as const) await withNativeWitness(rows, fixture.name, async environment => {
      const { peer } = environment
      peer.scriptGcClock(fixture.clock)
      const client = await environment.connect('heap-only')
      const before = peer.state.commands.length
      await client.collectGarbage()
      const instrumentation = client.evidence()
      const cycles = instrumentation.native!.gcCycles
      expect(cycles).toHaveLength(1)
      const cycle = cycles[0]
      if (fixture.preserveInverseEvidence) {
        // Retain the obsolete inverse's observed result for reconciliation only.
        // Success is decided by the literal raw values and original-D events.
        peer.state.gcClockScript!.inverseArithmeticEvidence = {
          deadline: cycle.gc.deadline!, sentAt: cycle.gc.sentAt!,
          subtraction: cycle.gc.deadline! - cycle.gc.sentAt!, usedAsBudgetOracle: false,
        }
      }
      expect(cycle.enable).toMatchObject({ sentAt: fixture.clock.initial, acknowledgedAt: fixture.clock.gcSend })
      expect(cycle.gc).toMatchObject({ sentAt: fixture.clock.gcSend, deadline: fixture.deadline, acknowledgedAt: fixture.clock.httpRequest })
      expect(cycle.gc.deadline).toBe(cycle.gc.sentAt! + 30000)
      expect(cycle.deadline).toBe(fixture.deadline)
      expect(cycle.deadline).toBe(cycle.gc.deadline)
      expect(cycle.barrier).toMatchObject({ sentAt: fixture.clock.gcSend, deadline: fixture.deadline, acknowledgedAt: fixture.clock.barrierReply })
      expect(cycle.barrier.id).toBe(cycle.gc.id! + 1)
      expect(cycle.http).toMatchObject({
        startedAt: fixture.clock.barrierReply, deadline: fixture.deadline, status: 200,
        bodyCap: 4096, overflow: false, expectedNonce: NONCE, observedNonce: NONCE,
        requestAcquired: true, socketAcquired: true, responseEndedAt: fixture.clock.httpRequest,
        requestClosedAt: fixture.clock.httpRequest, socketClosedAt: fixture.clock.httpRequest,
        completedAt: fixture.clock.httpRequest, cancelAt: null, errors: [],
      })
      expect(cycle.finalIdentity).toMatchObject({ sentAt: fixture.clock.httpRequest, deadline: fixture.deadline, acknowledgedAt: fixture.clock.finalReply })
      expect(cycle.completedAt).toBe(fixture.clock.finalReply)
      expect(cycle.failure).toBeNull()
      expect(cycle.possibleQueuedEffect).toBe(false)
      expect(cycle.secondaryFailures).toEqual([])
      expect(cycle.lateReplies).toEqual([])
      expect(instrumentation.pendingCalls).toBe(0)
      for (const at of [cycle.barrier.acknowledgedAt, cycle.gc.acknowledgedAt, cycle.http!.responseEndedAt, cycle.http!.requestClosedAt, cycle.http!.socketClosedAt, cycle.finalIdentity.acknowledgedAt, cycle.completedAt]) {
        expect(at).not.toBeNull()
        expect(at).toBeLessThan(fixture.deadline)
      }
      expect(peer.state).toMatchObject({ gcCommands: 1, gets: 1, barrierReplies: 1, finalIdentities: 1, wakeBeforeBarrier: 0, errors: [] })
      expect(peer.state.commands.slice(before).map(item => item.method)).toEqual([
        'HeapProfiler.enable', 'HeapProfiler.collectGarbage', 'Runtime.getIsolateId', 'Runtime.getIsolateId',
      ])
      expect(peer.state.http).toHaveLength(1)
      expect(peer.state.http[0]).toMatchObject({
        at: fixture.clock.httpRequest, method: 'GET', path: '/__test/identity',
        headers: { 'accept-encoding': 'identity', connection: 'close' },
      })
      expect(peer.state.gcClockScript!.phases).toEqual([
        { phase: 'initial', at: fixture.clock.initial },
        { phase: 'gcSend', at: fixture.clock.gcSend },
        { phase: 'barrierReply', at: fixture.clock.barrierReply },
        { phase: 'httpRequest', at: fixture.clock.httpRequest },
        { phase: 'finalReply', at: fixture.clock.finalReply },
      ])
      const cleanup = client.cleanupGcHttp()
      expect(client.cleanupGcHttp()).toBe(cleanup)
      expect(await cleanup).toMatchObject({ outcomes: [{ confirmed: true, requestClosed: true, socket: 'closed', failures: [] }], failures: [] })
      const commandsAfter = peer.state.commands.length
      await expect(client.collectGarbage()).rejects.toThrow(/finalized/)
      expect(peer.state.commands).toHaveLength(commandsAfter)
      expect(peer.state.gets).toBe(1)
      expect(peer.state.commands.filter(item => item.method.startsWith('Profiler.'))).toEqual([])
    })
    await withNativeWitness(rows, 'final identity at 31000.5 cannot renew the original 31000.25 GC deadline', async environment => {
      const { peer } = environment
      peer.scriptGcClock({ initial: 100.25, gcSend: 1000.25, barrierReply: 2000.25, httpRequest: 3000.25, finalReply: 31000.5 })
      const client = await environment.connect('heap-only')
      environment.cancelledHttp(client)
      const before = peer.state.commands.length
      await expect(client.collectGarbage()).rejects.toThrow(/Runtime.getIsolateId: reply after original deadline/)
      const instrumentation = client.evidence()
      const cycles = instrumentation.native!.gcCycles
      expect(cycles).toHaveLength(1)
      const cycle = cycles[0]
      expect(cycle.enable).toMatchObject({ sentAt: 100.25, acknowledgedAt: 1000.25 })
      expect(cycle.gc).toMatchObject({ sentAt: 1000.25, deadline: 31000.25, acknowledgedAt: 3000.25 })
      expect(cycle.gc.deadline).toBe(cycle.gc.sentAt! + 30000)
      expect(cycle.deadline).toBe(31000.25)
      expect(cycle.deadline).toBe(cycle.gc.deadline)
      expect(cycle.barrier).toMatchObject({ sentAt: 1000.25, deadline: 31000.25, acknowledgedAt: 2000.25 })
      expect(cycle.http).toMatchObject({
        startedAt: 2000.25, deadline: 31000.25, status: 200,
        expectedNonce: NONCE, observedNonce: NONCE, bodyCap: 4096, overflow: false,
        requestAcquired: true, socketAcquired: true, responseEndedAt: 3000.25,
        requestClosedAt: 3000.25, socketClosedAt: 3000.25, completedAt: 3000.25,
        cancelAt: 31000.5,
      })
      expect(cycle.finalIdentity).toMatchObject({ sentAt: 3000.25, deadline: 31000.25, failedAt: 31000.5, failure: 'Error: Runtime.getIsolateId: reply after original deadline' })
      expect(cycle.finalIdentity.acknowledgedAt).toBeUndefined()
      expect(cycle.completedAt).toBeNull()
      expect(cycle.failure).toBe('Error: Runtime.getIsolateId: reply after original deadline')
      expect(cycle.possibleQueuedEffect).toBe(true)
      expect(instrumentation.pendingCalls).toBe(0)
      const late = instrumentation.native!.frames.records.filter(frame => frame.disposition === 'late-owned-reply')
      expect(late).toHaveLength(1)
      expect(late[0]).toMatchObject({ id: cycle.finalIdentity.id, method: 'Runtime.getIsolateId', arrivedAt: 31000.5, truncated: false })
      expect(JSON.parse(Buffer.from(late[0].rawBase64, 'base64').toString('utf8'))).toEqual({ id: cycle.finalIdentity.id, result: { id: 'isolate-one' } })
      // The later final request was sent at literal3000.25: its renewed budget
      // would be33000.25, so only the original deadline can reject this reply.
      expect(late[0].arrivedAt).toBeGreaterThan(31000.25)
      expect(late[0].arrivedAt).toBeLessThan(33000.25)
      expect(peer.state.frames.find(frame => frame.id === cycle.finalIdentity.id)).toMatchObject({ at: 31000.5, base64: late[0].rawBase64, sha256: late[0].sha256 })
      expect(peer.state).toMatchObject({ gcCommands: 1, gets: 1, barrierReplies: 1, finalIdentities: 1, wakeBeforeBarrier: 0, errors: [] })
      expect(peer.state.commands.slice(before).map(item => item.method)).toEqual([
        'HeapProfiler.enable', 'HeapProfiler.collectGarbage', 'Runtime.getIsolateId', 'Runtime.getIsolateId',
      ])
      expect(peer.state.http).toHaveLength(1)
      expect(peer.state.http[0]).toMatchObject({ at: 3000.25, method: 'GET', path: '/__test/identity', headers: { 'accept-encoding': 'identity', connection: 'close' } })
      expect(peer.state.gcClockScript!.phases).toEqual([
        { phase: 'initial', at: 100.25 }, { phase: 'gcSend', at: 1000.25 },
        { phase: 'barrierReply', at: 2000.25 }, { phase: 'httpRequest', at: 3000.25 },
        { phase: 'finalReply', at: 31000.5 },
      ])
      const commandsAfter = peer.state.commands.length
      await expect(client.collectGarbage()).rejects.toThrow(/failed cycle/)
      expect(peer.state.commands).toHaveLength(commandsAfter)
      expect(peer.state.gcCommands).toBe(1)
      expect(peer.state.gets).toBe(1)
      expect(client.evidence().native!.gcCycles).toHaveLength(1)
      expect(client.evidence().native!.gcCycles[0].failure).toBe(cycle.failure)
      expect(peer.state.commands.filter(item => item.method.startsWith('Profiler.'))).toEqual([])
    })
  } catch (error) { primary = { error } }
  await finalizeCase(info, 'native-ordered-gc-witnesses', { witnesses: rows }, primary, [])
})

type IdentityScriptMode = 'complete' | 'cap-boundary' | 'trickle' | 'end-only' | 'request-open' | 'socket-open' | 'both-open' | 'destroy-errors' | 'destroy-throws-after-close' | 'acquisition-error' | 'request-error' | 'socket-error' | 'response-error'
function scriptedIdentityTransport(mode: IdentityScriptMode, afterEnd?: () => void) {
  const request = new EventEmitter()
  const socket = new EventEmitter()
  const response = new EventEmitter()
  const state = {
    factoryCalls: 0, endCalls: 0, requestDestroyCalls: 0, socketDestroyCalls: 0, responseDestroyCalls: 0,
    requestClosed: false, socketClosed: false, responseEnded: false, cancelled: false, dataEvents: 0,
    requestErrorListeners: 0, socketErrorListeners: 0, responseErrorListeners: 0,
    url: '', options: null as unknown, destroyTimes: [] as number[], closeTimes: [] as number[],
  }
  let tick: ReturnType<typeof setInterval> | undefined
  let disposed = false
  const closeRequest = () => { if (!state.requestClosed) { state.requestClosed = true; state.closeTimes.push(performance.now()); request.emit('close') } }
  const closeSocket = () => { if (!state.socketClosed) { state.socketClosed = true; state.closeTimes.push(performance.now()); socket.emit('close') } }
  const cancel = () => { state.cancelled = true; state.destroyTimes.push(performance.now()); clearInterval(tick) }
  const rawSocket = Object.assign(socket, { destroy: () => {
    state.socketDestroyCalls++; cancel()
    if (mode === 'destroy-errors') throw new Error('literal socket destroy failure')
    if (mode !== 'socket-open' && mode !== 'both-open') closeSocket()
    if (mode === 'destroy-throws-after-close') throw new Error('literal socket destroy failure')
  } })
  const rawResponse = Object.assign(response, {
    statusCode: 200, headers: { 'content-type': 'application/json' },
    destroy: () => { state.responseDestroyCalls++ },
  })
  const rawRequest = Object.assign(request, {
    destroy: () => {
      state.requestDestroyCalls++; cancel()
      if (mode === 'destroy-errors') throw new Error('literal request destroy failure')
      if (mode !== 'request-open' && mode !== 'both-open') closeRequest()
      if (mode === 'destroy-throws-after-close') throw new Error('literal request destroy failure')
    },
    end: () => {},
  })
  const factory: NonNullable<NativeWitnessOptions['httpFactory']> = (url, options, callback) => {
    state.factoryCalls++; state.url = url.href; state.options = options
    if (mode === 'acquisition-error') throw new Error('literal identity acquisition failure')
    rawRequest.end = () => {
      state.endCalls++
      queueMicrotask(() => {
        if (disposed) return
        state.requestErrorListeners = request.listenerCount('error')
        request.emit('socket', rawSocket)
        state.socketErrorListeners = socket.listenerCount('error')
        if (mode === 'request-error') { request.emit('error', new Error('literal early request error')); return }
        if (mode === 'socket-error') { socket.emit('error', new Error('literal early socket error')); return }
        callback(rawResponse as unknown as IncomingMessage)
        state.responseErrorListeners = response.listenerCount('error')
        if (mode === 'response-error') { response.emit('error', new Error('literal early response error')); return }
        if (mode === 'trickle') {
          response.emit('data', Buffer.from('{')); state.dataEvents++
          tick = setInterval(() => { response.emit('data', Buffer.from(' ')); state.dataEvents++ }, 10)
          return
        }
        const literal = JSON.stringify({ harness: 'orbit-worker-contract', storeName: 'catalog-v1', entry: 'tests/cloudflare/runtime/entry.ts', isolateNonce: NONCE })
        const body = mode === 'cap-boundary' ? literal + ' '.repeat(4096 - Buffer.byteLength(literal)) : literal
        state.dataEvents++; response.emit('data', Buffer.from(body))
        if (state.cancelled) return
        state.responseEnded = true; response.emit('end')
        if (mode === 'complete' || mode === 'cap-boundary' || mode === 'socket-open') closeRequest()
        if (mode === 'complete' || mode === 'cap-boundary' || mode === 'request-open') closeSocket()
        afterEnd?.()
      })
    }
    return rawRequest as unknown as ClientRequest
  }
  return {
    state, factory,
    dispose: () => { disposed = true; clearInterval(tick); closeRequest(); closeSocket() },
  }
}

test('the owned GC HTTP witness requires complete identity and actual request/socket closure, keeps a hard deadline under trickle, and preserves independent acquisition and cancellation failures', async ({}, info) => {
  const rows: Record<string, unknown>[] = []
  let primary: { error: unknown } | null = null
  try {
    for (const mode of ['complete', 'cap-boundary', 'trickle', 'end-only', 'request-open', 'socket-open', 'destroy-errors', 'destroy-throws-after-close', 'acquisition-error', 'request-error', 'socket-error', 'response-error'] as const) {
      const transport = scriptedIdentityTransport(mode)
      const row: Record<string, unknown> = { mode, syntheticTransport: true, transport: transport.state }
      rows.push(row)
      const deadline = performance.now() + 100
      const get = ownedIdentityGet('http://127.0.0.1:65004', NONCE, deadline, { factory: transport.factory })
      try {
        if (mode === 'complete' || mode === 'cap-boundary') {
          expect(await get.result).toEqual({ harness: 'orbit-worker-contract', storeName: 'catalog-v1', entry: 'tests/cloudflare/runtime/entry.ts', isolateNonce: NONCE })
          expect(get.evidence.completedAt).not.toBeNull()
          expect(get.evidence.requestClosedAt).not.toBeNull()
          expect(get.evidence.socketClosedAt).not.toBeNull()
          expect(get.evidence.cancelAt).toBeNull()
          if (mode === 'cap-boundary') expect(get.evidence.bodyBytes).toBe(4096)
        } else {
          await expect(get.result).rejects.toThrow()
          expect(get.evidence.completedAt).toBeNull()
          expect(get.evidence.cancelAt).not.toBeNull()
          if (mode === 'trickle') {
            expect(transport.state.dataEvents).toBeGreaterThan(0)
            expect(get.evidence.responseEndedAt).toBeNull()
            expect(get.evidence.errors.some(item => item.source === 'deadline')).toBe(true)
          }
          if (mode === 'end-only' || mode === 'request-open' || mode === 'socket-open') expect(get.evidence.responseEndedAt).not.toBeNull()
        }
        expect(get.evidence.deadline).toBe(deadline)
        expect(transport.state.factoryCalls).toBe(1)
        expect(transport.state.url).toBe('http://127.0.0.1:65004/__test/identity')
        expect(transport.state.options).toEqual({ method: 'GET', agent: false, headers: { 'Accept-Encoding': 'identity' } })
        const first = get.cleanup()
        expect(get.cleanup()).toBe(first)
        const outcome = await first
        row.http = get.evidence; row.cleanup = outcome
        const unconfirmed = mode === 'request-open' || mode === 'socket-open' || mode === 'destroy-errors'
        expect(outcome.confirmed).toBe(!unconfirmed)
        expect(outcome.joinBudgetMs).toBe(3000)
        if (unconfirmed) expect(outcome.failures.some(item => item.includes('unconfirmed after3000ms'))).toBe(true)
        if (mode === 'destroy-errors' || mode === 'destroy-throws-after-close') {
          expect(outcome.failures.some(item => item.includes('literal request destroy failure'))).toBe(true)
          expect(outcome.failures.some(item => item.includes('literal socket destroy failure'))).toBe(true)
        }
        if (mode !== 'acquisition-error') {
          expect(transport.state.requestErrorListeners).toBeGreaterThan(0)
          expect(transport.state.socketErrorListeners).toBeGreaterThan(0)
          if (!['request-error', 'socket-error'].includes(mode)) expect(transport.state.responseErrorListeners).toBeGreaterThan(0)
        } else {
          expect(get.evidence.requestAcquired).toBe(false)
          expect(outcome.socket).toBe('not-acquired')
          expect(outcome.failures.some(item => item.includes('literal identity acquisition failure'))).toBe(true)
        }
        const frozenOutcome = structuredClone(outcome)
        transport.dispose() // independent witness teardown; late events cannot change the receipt
        expect(outcome).toEqual(frozenOutcome)
        expect(await get.cleanup()).toBe(outcome)
      } finally {
        await get.cleanup()
        row.http = get.evidence
        transport.dispose()
        row.syntheticTransportDisposed = true
      }
    }
  } catch (error) { primary = { error } }
  await finalizeCase(info, 'native-owned-http-witnesses', { witnesses: rows }, primary, [])
})

test('failed native GC retains late original replies and joins HTTP independently alongside profiler cleanup before closing the inspector', async ({}, info) => {
  const rows: Record<string, unknown>[] = []
  let primary: { error: unknown } | null = null
  try {
    await withNativeWitness(rows, 'failed enable issues neither GC nor wake', async environment => {
      const { peer } = environment
      const client = await environment.connect('heap-only')
      peer.script((command, socket) => {
        if (command.method !== 'HeapProfiler.enable') return false
        peer.emit(command, socket, { id: command.id, error: { code: -32000, message: 'literal heap enable failure' } }); return true
      })
      await expect(client.collectGarbage()).rejects.toThrow(/literal heap enable failure/)
      expect(peer.state.gcCommands).toBe(0)
      expect(peer.state.gets).toBe(0)
      const cycle = client.evidence().native!.gcCycles[0]
      expect(cycle.gc.sentAt).toBeUndefined()
      expect(cycle.possibleQueuedEffect).toBe(false)
      await expect(client.collectGarbage()).rejects.toThrow(/failed cycle/)
      expect(peer.state.commands.filter(item => item.method === 'HeapProfiler.enable')).toHaveLength(1)
    })
    await withNativeWitness(rows, 'original GC may execute after barrier failure without rehabilitating it', async environment => {
      const { peer } = environment
      peer.state.barrierMode = 'error'
      let lateId: number | undefined
      let observed!: () => void
      const late = new Promise<void>(resolve => { observed = resolve })
      const ws = await loadWs()
      const client = await environment.connect('heap-only', { socketFactory: address => {
        const socket = new ws.WebSocket(address, { headers: { Origin: peer.endpoints.inspectorOrigin }, handshakeTimeout: 3000, perMessageDeflate: false })
        socket.on('message', data => {
          const frame = JSON.parse(String(data)) as { id?: number }
          if (lateId !== undefined && frame.id === lateId) queueMicrotask(observed)
        })
        return socket
      } })
      await expect(client.collectGarbage()).rejects.toThrow(/literal barrier failure/)
      const before = client.evidence().native!.gcCycles[0]
      lateId = before.gc.id
      expect(before.gc.acknowledgedAt).toBeUndefined()
      expect(peer.state.gets).toBe(0)
      peer.replyGc() // reply to the sole already-issued command, not a new probe
      expect(await within(late, 3000)).not.toBe('timeout')
      const after = client.evidence().native!.gcCycles[0]
      expect(after.failure).toBe(before.failure)
      expect(after.completedAt).toBeNull()
      expect(after.gc.acknowledgedAt).toBeUndefined()
      expect(after.lateReplies).toHaveLength(1)
      const raw = peer.state.frames.find(frame => frame.id === lateId)!
      expect(after.lateReplies[0]).toMatchObject({ bytes: raw.bytes, sha256: raw.sha256 })
      expect(client.evidence().native!.frames.records.some(frame => frame.disposition === 'late-original-gc-reply' && frame.sha256 === raw.sha256)).toBe(true)
      await expect(client.collectGarbage()).rejects.toThrow(/failed cycle/)
      expect(peer.state.gcCommands).toBe(1)
      expect(peer.state.gets).toBe(0)
    })
    await withNativeWitness(rows, 'HTTP unknown closure never blocks independent owned profiler stop/reset or socket close', async environment => {
      const { peer } = environment
      peer.state.gcMode = 'error'
      const order: string[] = []
      const transport = scriptedIdentityTransport('both-open', () => peer.replyGc())
      const client = await environment.connect('encoding-cpu', { httpFactory: transport.factory })
      environment.unconfirmedHttp(client)
      let release: (() => void) | undefined
      let stopSeen!: () => void
      const stopArrived = new Promise<void>(resolve => { stopSeen = resolve })
      try {
        await client.startProfile()
        await expect(client.collectGarbage()).rejects.toThrow(/literal queued GC failure/)
        const failed = client.evidence().native!.gcCycles[0]
        expect(failed.http!.cancelAt).not.toBeNull()
        expect(transport.state.requestDestroyCalls).toBe(1)
        expect(transport.state.socketDestroyCalls).toBe(1)
        expect(transport.state.factoryCalls).toBe(1)
        peer.script((command, socket) => {
          if (command.method !== 'Profiler.stop') return false
          order.push('profile-stop-arrived')
          let released = false
          release = () => {
            if (released) return
            released = true
            peer.state.active = false
            peer.emit(command, socket, { id: command.id, method: 'Profiler.stop', result: { profile: literalNativeProfile() } })
          }
          stopSeen(); return true
        })
        let httpSettled = false
        const profile = client.cleanupProfile().then(outcome => { order.push('profile-settled'); return outcome })
        const http = client.cleanupGcHttp().then(outcome => { httpSettled = true; order.push('http-settled'); return outcome })
        void profile.catch(() => {}); void http.catch(() => {})
        try {
          expect(await within(stopArrived, 3000)).not.toBe('timeout')
          expect(httpSettled).toBe(false)
        } finally { release?.() }
        const [profileResult, httpResult] = await Promise.allSettled([profile, http])
        expect(profileResult.status).toBe('fulfilled')
        expect(httpResult.status).toBe('fulfilled')
        if (profileResult.status !== 'fulfilled' || httpResult.status !== 'fulfilled') throw new Error('The independent cleanup promises did not both fulfill with receipts')
        expect(profileResult.value.confirmed).toBe(true)
        expect(profileResult.value.failures).toEqual([])
        expect(profileResult.value.actions.map(action => action.method)).toEqual(['Runtime.getIsolateId', 'Profiler.stop', 'Profiler.enable', 'Runtime.getIsolateId'])
        expect(httpResult.value.outcomes).toHaveLength(1)
        expect(httpResult.value.outcomes[0]).toMatchObject({ confirmed: false, joinBudgetMs: 3000, requestClosed: false, socket: 'unconfirmed' })
        expect(httpResult.value.failures.some(item => item.includes('unconfirmed'))).toBe(true)
        expect(order).toEqual(['profile-stop-arrived', 'profile-settled', 'http-settled'])
        expect(peer.state.enableCalls).toBe(2)
        expect(peer.state.stopCalls).toBe(1)
        expect(peer.state.unsafeResets).toBe(0)
        order.push('inspector-close-requested')
        expect((await client.close(500)).confirmed).toBe(true)
        rows[rows.length - 1].composition = {
          order, profile: profileResult.value, http: httpResult.value, syntheticHttp: transport.state,
          configuredMaximumMs: 17000, allowance: 'max(12000,3000)+5000; not measured elapsed time',
        }
      } finally {
        release?.()
        await client.cleanupGcHttp()
        transport.dispose()
      }
    })
  } catch (error) { primary = { error } }
  await finalizeCase(info, 'native-gc-finalization-witnesses', { witnesses: rows }, primary, [])
})

test('native first discovery charges the original deadline at the real integer-only API, refuses submillisecond or invalid budgets before I/O, and leaves generic acquisition unchanged', async ({}, info) => {
  interface Observation {
    row: Record<string, unknown>
    timerArguments: number[]
    hostArgumentText: string[]
    hostErrors: string[]
    fetchCalls: { url: string; redirect: RequestRedirect | null; signalFromHost: boolean }[]
    signals: AbortSignal[]
  }
  const rows: Record<string, unknown>[] = []
  const evidence: Record<string, unknown> = { witnesses: rows }
  const describe = (error: unknown) => error instanceof Error ? error.stack ?? String(error) : String(error)
  let primary: { error: unknown } | null = null
  let active: Observation | undefined
  const observe = (name: string, input: Record<string, unknown>): Observation => {
    const timerArguments: number[] = []
    const hostArgumentText: string[] = []
    const hostErrors: string[] = []
    const fetchCalls: Observation['fetchCalls'] = []
    const row: Record<string, unknown> = { name, ...input, timerArguments, hostArgumentText, hostErrors, fetchCalls }
    rows.push(row)
    return (active = { row, timerArguments, hostArgumentText, hostErrors, fetchCalls, signals: [] })
  }
  const finishObservation = (observation: Observation) => {
    observation.row.signals = observation.signals.map(signal => ({ aborted: signal.aborted, reason: signal.aborted ? String(signal.reason) : null }))
    active = undefined
  }
  const originalTimeout = AbortSignal.timeout
  const originalFetch = globalThis.fetch
  const timeoutDescriptor = Object.getOwnPropertyDescriptor(AbortSignal, 'timeout')
  const fetchDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'fetch')
  let timeoutWrapped = false
  let fetchWrapped = false
  const restorationErrors: unknown[] = []
  const observeTimeout = (ms: number): AbortSignal => {
    const observation = active
    observation?.timerArguments.push(ms)
    observation?.hostArgumentText.push(String(ms))
    try {
      const signal = originalTimeout.call(AbortSignal, ms)
      observation?.signals.push(signal)
      return signal
    } catch (error) {
      observation?.hostErrors.push(describe(error))
      throw error
    }
  }
  const observeFetch: typeof fetch = (input, init) => {
    const observation = active
    if (observation) {
      observation.fetchCalls.push({
        url: typeof input === 'string' ? input : String(input), redirect: init?.redirect ?? null,
        signalFromHost: !!init?.signal && observation.signals.includes(init.signal),
      })
    }
    return originalFetch.call(globalThis, input, init)
  }

  let server: Server | undefined
  let listenerAcquired = false
  let httpClosing = false
  const sockets = new Set<Socket>()
  const socketClosures: Promise<void>[] = []
  const connections: { closed: boolean; errors: string[] }[] = []
  const requests: { method: string | undefined; url: string | undefined }[] = []
  const listenerErrors: unknown[] = []
  const responseErrors: string[] = []
  evidence.httpOwner = { connections, requests, responseErrors }
  let fake: FakeInspector | undefined
  let directory: string | undefined
  const unexpectedClients: Inspector[] = []
  try {
    server = createServer((request, response) => {
      requests.push({ method: request.method, url: request.url })
      response.on('error', error => responseErrors.push(describe(error)))
      response.writeHead(200, { 'Content-Type': 'application/json', Connection: 'close' })
      response.end('{"witness":"native first discovery","value":17}')
    })
    server.on('error', error => listenerErrors.push(error))
    server.on('connection', socket => {
      const observation = { closed: false, errors: [] as string[] }
      connections.push(observation)
      sockets.add(socket)
      socket.on('error', error => observation.errors.push(describe(error)))
      socketClosures.push(new Promise<void>(resolve => socket.once('close', () => {
        observation.closed = true; sockets.delete(socket); resolve()
      })))
      if (httpClosing) socket.destroy()
    })
    await new Promise<void>((resolve, reject) => {
      server!.once('error', reject)
      server!.listen(0, '127.0.0.1', () => { server!.off('error', reject); listenerAcquired = true; resolve() })
    })
    const port = (server.address() as AddressInfo).port
    if ([8787, 8790, 9230].includes(port)) throw new Error('The deadline witness must not use a reserved port')
    const origin = `http://127.0.0.1:${port}`
    fake = await startFakeInspector()
    directory = await mkdtemp(path.join(os.tmpdir(), 'orbit-integer-deadline-'))
    directory = await realpath(directory)
    if ((timeoutDescriptor && !('value' in timeoutDescriptor)) || (fetchDescriptor && !('value' in fetchDescriptor))) {
      throw new Error('Host observation requires restorable data-property descriptors')
    }
    Object.defineProperty(AbortSignal, 'timeout', { ...(timeoutDescriptor ?? { configurable: true, writable: true, enumerable: false }), value: observeTimeout })
    timeoutWrapped = true
    Object.defineProperty(globalThis, 'fetch', { ...(fetchDescriptor ?? { configurable: true, writable: true, enumerable: false }), value: observeFetch })
    fetchWrapped = true

    for (const fixture of [
      { name: 'fractional', deadline: 2999.804750000001, now: 0, expectedHostMs: 2999 },
      { name: 'whole', deadline: 3000, now: 0, expectedHostMs: 3000 },
      { name: 'preparation-charged', deadline: 4000, now: 1000.19525, expectedHostMs: 2999 },
    ]) {
      const observation = observe(fixture.name, { originalDeadline: fixture.deadline, currentTime: fixture.now, expectedHostMs: fixture.expectedHostMs })
      const discoveries: InspectorAcquisition['httpDiscovery'] = []
      const url = `${origin}/json?case=${fixture.name}`
      const before = requests.length
      observation.row.discovery = discoveries
      try {
        const body = await fetchNativeFirstDiscoveryJson(url, fixture.deadline, discoveries, () => fixture.now)
        observation.row.body = body
        expect(body).toEqual({ witness: 'native first discovery', value: 17 })
        expect(observation.timerArguments).toEqual([fixture.expectedHostMs])
        expect(observation.hostErrors).toEqual([])
        expect(observation.signals).toHaveLength(1)
        expect(observation.fetchCalls).toEqual([{ url, redirect: 'manual', signalFromHost: true }])
        expect(requests.slice(before)).toEqual([{ method: 'GET', url: `/json?case=${fixture.name}` }])
        expect(discoveries).toHaveLength(1)
        expect(discoveries[0]).toMatchObject({ url, status: 200, text: '{"witness":"native first discovery","value":17}', failure: null })
      } finally { finishObservation(observation) }
    }

    for (const fixture of [
      { name: 'submillisecond', deadline: 0.75, now: 0, expectedError: /native first discovery: insufficient whole-millisecond budget/ },
      { name: 'below-one', deadline: 0.999999, now: 0, expectedError: /native first discovery: insufficient whole-millisecond budget/ },
      { name: 'preparation-leaves-submillisecond', deadline: 4000, now: 3999.25, expectedError: /native first discovery: insufficient whole-millisecond budget/ },
      { name: 'zero', deadline: 0, now: 0, expectedError: /native first discovery: original deadline expired/ },
      { name: 'negative', deadline: -1, now: 0, expectedError: /native first discovery: original deadline expired/ },
      { name: 'elapsed', deadline: 4000, now: 4001, expectedError: /native first discovery: original deadline expired/ },
      { name: 'NaN', deadline: Number.NaN, now: 0, expectedError: /native first discovery: original deadline expired/ },
      { name: 'positive-infinity', deadline: Number.POSITIVE_INFINITY, now: 0, expectedError: /native first discovery: original deadline expired/ },
      { name: 'negative-infinity', deadline: Number.NEGATIVE_INFINITY, now: 0, expectedError: /native first discovery: original deadline expired/ },
      { name: 'invalid-current-time', deadline: 4000, now: Number.NaN, expectedError: /native first discovery: original deadline expired/ },
    ]) {
      const observation = observe(fixture.name, { originalDeadline: String(fixture.deadline), currentTime: String(fixture.now) })
      const discoveries: InspectorAcquisition['httpDiscovery'] = []
      const before = { requests: requests.length, connections: connections.length, upgrades: fake.state.upgrades }
      observation.row.discovery = discoveries
      let refused: unknown
      try {
        try { await fetchNativeFirstDiscoveryJson(`${origin}/json?case=${fixture.name}`, fixture.deadline, discoveries, () => fixture.now) } catch (error) { refused = error }
        observation.row.refusal = describe(refused)
        observation.row.before = before
        observation.row.after = { requests: requests.length, connections: connections.length, upgrades: fake.state.upgrades }
        expect(refused).toBeInstanceOf(Error)
        expect(String(refused)).toMatch(fixture.expectedError)
        expect(observation.timerArguments).toEqual([])
        expect(observation.signals).toEqual([])
        expect(observation.fetchCalls).toEqual([])
        expect(observation.row.after).toEqual(before)
        expect(discoveries).toHaveLength(1)
        expect(discoveries[0]).toMatchObject({ status: null, headers: null, text: null, textUtf8Bytes: null, failure: String(refused) })
      } finally { finishObservation(observation) }
    }

    // The smallest whole interval is an API/dispatch boundary, not a promise
    // that a real HTTP round trip can finish in one millisecond.
    const minimum = observe('one-whole-millisecond', { originalDeadline: 1, currentTime: 0, expectedHostMs: 1 })
    const minimumDiscovery: InspectorAcquisition['httpDiscovery'] = []
    minimum.row.discovery = minimumDiscovery
    let minimumBody: unknown
    let minimumFailure: unknown
    try {
      try { minimumBody = await fetchNativeFirstDiscoveryJson(`${origin}/json?case=one`, 1, minimumDiscovery, () => 0) } catch (error) { minimumFailure = error }
      minimum.row.body = minimumBody
      minimum.row.failure = minimumFailure === undefined ? null : describe(minimumFailure)
      expect(minimum.timerArguments).toEqual([1])
      expect(minimum.hostErrors).toEqual([])
      expect(minimum.signals).toHaveLength(1)
      expect(minimum.fetchCalls).toEqual([{ url: `${origin}/json?case=one`, redirect: 'manual', signalFromHost: true }])
      if (minimumFailure === undefined) expect(minimumBody).toEqual({ witness: 'native first discovery', value: 17 })
      else {
        expect(minimum.signals[0].aborted).toBe(true)
        if (minimumDiscovery[0]?.status === null) {
          minimum.row.abortPhase = 'before-response'
          expect(minimumFailure).toBe(minimum.signals[0].reason)
        } else {
          // Fetch body consumption reports AbortError after response headers,
          // while fetch itself rejects with the original signal reason.
          minimum.row.abortPhase = 'response-body'
          expect(minimumDiscovery[0]?.status).toBe(200)
          expect(minimumFailure).toBeInstanceOf(DOMException)
          expect((minimumFailure as DOMException).name).toBe('AbortError')
          expect((minimumFailure as DOMException).code).toBe(20)
        }
      }
    } finally { finishObservation(minimum) }

    for (const native of [true, false]) {
      const observation = observe(native ? 'real-connect-submillisecond-refusal' : 'generic-fractional-input-unchanged', { originalBudgetMs: native ? 0.75 : 2999.804750000001 })
      let socketFactoryCalls = 0
      const mode = native ? nativeWitnessMode({
        directory, permission: 'heap-only',
        socketFactory: () => { socketFactoryCalls++; throw new Error('The exhausted acquisition must not create a WebSocket') },
      }) : undefined
      const beforeUpgrades = fake.state.upgrades
      let refused: unknown
      try {
        try {
          const client = await Inspector.connect(fake.endpoints(), { isolateNonce: NONCE, ...(mode ? { native: mode } : {}) }, native ? 0.75 : 2999.804750000001)
          unexpectedClients.push(client)
          refused = client
        } catch (error) { refused = error }
        observation.row.refusal = describe(refused)
        observation.row.socketFactoryCalls = socketFactoryCalls
        observation.row.upgrades = { before: beforeUpgrades, after: fake.state.upgrades }
        expect(refused).toBeInstanceOf(InspectorAcquisitionError)
        if (!(refused instanceof InspectorAcquisitionError)) throw new Error('The controlled acquisition unexpectedly succeeded')
        observation.row.acquisition = refused.acquisition
        observation.row.acquisitionCleanup = refused.cleanup
        observation.row.primary = describe(refused.primary)
        expect(refused.acquisition.socketAcquired).toBe(false)
        expect(refused.cleanup.socket).toEqual({ acquired: false })
        expect(refused.cleanup.runtime.attempted).toBe(false)
        expect(refused.cleanup.pendingCallsAfterCleanup).toBe(0)
        expect(refused.cleanup.failures).toEqual([])
        expect(refused.instrumentation).toBeNull()
        expect(socketFactoryCalls).toBe(0)
        expect(fake.state.upgrades).toBe(beforeUpgrades)
        expect(observation.fetchCalls).toEqual([])
        expect(observation.signals).toEqual([])
        if (native) {
          expect(String(refused.primary)).toMatch(/native (preparation|first discovery): (original deadline expired|insufficient whole-millisecond budget)/)
          expect(observation.timerArguments).toEqual([])
          expect(observation.hostErrors).toEqual([])
        } else {
          expect(refused.primary).toBeInstanceOf(RangeError)
          expect((refused.primary as NodeJS.ErrnoException).code).toBe('ERR_OUT_OF_RANGE')
          expect(observation.timerArguments).toEqual([2999.804750000001])
          expect(observation.hostErrors).toHaveLength(1)
        }
      } finally { finishObservation(observation) }
    }
  } catch (error) { primary = { error } }
  finally {
    active = undefined
    // Restore exact descriptors even after a partial installation or an
    // assertion failure; restoration failure cannot prevent owned cleanup.
    if (fetchWrapped) {
      try {
        if (fetchDescriptor) Object.defineProperty(globalThis, 'fetch', fetchDescriptor)
        else if (!Reflect.deleteProperty(globalThis, 'fetch')) throw new Error('Could not remove the temporary fetch observer')
      } catch (error) { restorationErrors.push(error) }
    }
    if (timeoutWrapped) {
      try {
        if (timeoutDescriptor) Object.defineProperty(AbortSignal, 'timeout', timeoutDescriptor)
        else if (!Reflect.deleteProperty(AbortSignal, 'timeout')) throw new Error('Could not remove the temporary timeout observer')
      } catch (error) { restorationErrors.push(error) }
    }
    evidence.observerRestorationErrors = restorationErrors.map(describe)
  }
  await finalizeCase(info, 'native-integer-first-discovery-witnesses', evidence, primary, [
    { label: 'restore-host-observers', run: async () => {
      if (restorationErrors.length) throw new AggregateError(restorationErrors, 'Host observer restoration failed')
      expect(Object.getOwnPropertyDescriptor(AbortSignal, 'timeout')).toEqual(timeoutDescriptor)
      expect(Object.getOwnPropertyDescriptor(globalThis, 'fetch')).toEqual(fetchDescriptor)
      expect(AbortSignal.timeout).toBe(originalTimeout)
      expect(globalThis.fetch).toBe(originalFetch)
      return 'exact original descriptors and functions restored'
    } },
    ...unexpectedClients.map((client, index) => ({ label: `unexpected-inspector-${index}`, run: async () => {
      const closure = await client.close(3000)
      evidence[`unexpectedInspector${index}`] = { closure, inspector: client.evidence() }
      expect(closure.confirmed).toBe(true)
      expect(closure.errors ?? []).toEqual([])
      return closure
    } })),
    { label: 'fake-inspector-close', run: async () => { if (!fake) return 'not acquired'; await fake.close(); return { closed: true, upgrades: fake.state.upgrades } } },
    { label: 'http-listener-and-connections-close', run: async () => {
      const failures: unknown[] = [...listenerErrors]
      let closed = !listenerAcquired
      if (server && listenerAcquired) {
        httpClosing = true
        const close = new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()))
        for (const socket of sockets) { try { socket.destroy() } catch (error) { failures.push(error) } }
        try { server.closeAllConnections() } catch (error) { failures.push(error) }
        try {
          if (await within(close, 3000) === 'timeout') throw new Error('Owned HTTP listener close was not observed within3000ms')
          closed = true
        } catch (error) { failures.push(error) }
      }
      // A server-close callback does not replace the separately observed raw
      // socket close events, and one failed join must not skip the other.
      try {
        if (await within(Promise.all(socketClosures), 3000) === 'timeout') throw new Error('Owned HTTP socket close events were not observed within3000ms')
      } catch (error) { failures.push(error) }
      if (!closed || sockets.size || connections.some(connection => !connection.closed)) failures.push(new Error('Owned HTTP physical closure is incomplete'))
      const outcome = { listenerAcquired, closed, remainingSockets: sockets.size, connections, errors: failures.map(describe) }
      evidence.httpClosure = outcome
      if (failures.length) throw new AggregateError(failures, 'Deadline witness HTTP cleanup failed')
      return outcome
    } },
    { label: 'remove-synthetic-directory', run: async () => {
      if (!directory) return 'not acquired'
      await rm(directory, { recursive: true, force: true })
      return 'removed'
    } },
  ])
})

/** Independent, owned emitters for failure paths that a real socket cannot safely manufacture. */
function httpObservationProducer(mode: 'paused' | 'early-error' | 'factory-failure' | 'no-socket-failure' | 'after-socket-failure' | 'destroy-throws' | 'missing-close' = 'paused') {
  const request = new EventEmitter()
  const socket = new EventEmitter()
  const response = new EventEmitter()
  const original = Object.assign(new Error(`owned producer ${mode}`), { code: 'E_OWNED_PRODUCER' })
  const destruction = new Error('owned response destroy invocation failed')
  const state = { requestDestroyCalls: 0, responseDestroyCalls: 0, timeoutMs: 0, requestClosed: false, socketClosed: false, latchesBeforeEnd: false, latchesBeforeData: false }
  let listener!: (message: IncomingMessage) => void
  let replied = false
  const reply = () => {
    if (replied) return
    replied = true
    listener(Object.assign(response, {
      statusCode: 200, headers: {}, pause: () => response, resume: () => response,
      destroy: () => {
        state.responseDestroyCalls++
        if (mode === 'destroy-throws') throw destruction
        response.emit('aborted')
        response.emit('close')
        return response
      },
    }) as unknown as IncomingMessage)
    state.latchesBeforeData = ['end', 'error', 'aborted', 'close'].every(event => response.listenerCount(event) > 0)
    if (mode === 'early-error') response.emit('error', original)
    else response.emit('data', Buffer.from('literal-first'))
  }
  const transport: HeldRequestTransport = (_url, _options, callback) => {
    if (mode === 'factory-failure') throw original
    listener = callback
    return Object.assign(request, {
      socket: mode === 'no-socket-failure' ? null : socket,
      setTimeout: (milliseconds: number) => { state.timeoutMs = milliseconds; return request },
      end: () => {
        state.latchesBeforeEnd = ['error', 'close', 'socket'].every(event => request.listenerCount(event) > 0)
          && (mode === 'no-socket-failure' || ['error', 'close'].every(event => socket.listenerCount(event) > 0))
        if (mode === 'no-socket-failure' || mode === 'after-socket-failure') throw original
        // The caller explicitly delivers the response after registering the handle.
        return request
      },
      destroy: () => {
        state.requestDestroyCalls++
        queueMicrotask(() => {
          state.requestClosed = true
          request.emit('close')
          if (mode !== 'no-socket-failure' && mode !== 'missing-close') { state.socketClosed = true; socket.emit('close') }
        })
        return request
      },
    }) as unknown as ClientRequest
  }
  return { transport, request, socket, response, original, destruction, state, reply }
}

test('bounded HTTP observations retain real owned closes, original and late errors, one destruction deadline, independent cleanup, all wipe evidence and unchanged metrics transport/consumer identity', async ({}, info) => {
  const evidence: Record<string, unknown> = { observations: [], controlledProducers: [], heldDeadlineRows: [], clockDomain: 'literal clocks in controlled rows are not actual elapsed time' }
  const observations = evidence.observations as unknown[]
  const controlledProducers = evidence.controlledProducers as unknown[]
  const heldDeadlineRows = evidence.heldDeadlineRows as unknown[]
  const handles: SlowStream[] = []
  const verifiedFailures = new Set<SlowStream>()
  const heldHandles: HeldRequest[] = []
  const heldJoins = new Map<HeldRequest, Promise<HeldRequestClosure>>()
  const verifiedHeldFailures = new Set<HeldRequest>()
  const contexts: { context: HttpObservation; expectedIncomplete: boolean }[] = []
  const context = (label: string, clock?: () => HttpTime, nonce = '012345abcdef') => {
    const value = new HttpObservation(label, clock, nonce)
    observations.push(value.evidence)
    contexts.push({ context: value, expectedIncomplete: false })
    return value
  }
  const incomplete = (value: HttpObservation) => { contexts.find(row => row.context === value)!.expectedIncomplete = true }
  const controlled = (mode: Parameters<typeof httpObservationProducer>[0], owner: HttpObservation) => {
    const producer = httpObservationProducer(mode)
    controlledProducers.push({ mode, state: producer.state })
    const stream = openSlowStream('http://owned-producer.invalid', '/literal-stream', {}, owner.scope(mode ?? 'paused', 'controlled'), producer.transport)
    handles.push(stream)
    return { producer, stream }
  }
  let server: Server | undefined
  let listening = false
  let closingServer = false
  const sockets = new Set<Socket>()
  const socketJoins: Promise<void>[] = []
  const connections: { closed: boolean; errors: string[] }[] = []
  const requests: { method: string | undefined; url: string | undefined }[] = []
  const serverErrors: unknown[] = []
  const responseErrors: string[] = []
  const metricBytes = '{"instance":"11111111-1111-4111-8111-111111111111","rowsRead":17,"rowsWritten":19,"databaseBytes":4096,"payloadBytes":23,"chunks":2,"generations":1,"activeBodies":4,"peakBodies":8,"activeGenerations":4,"explicitChunkCacheEntries":1,"peakExplicitChunkBuffers":2,"staging":null}'
  const wipeBytes = '{"wiped":true,"nonce":"owned-wipe-17","abortObserved":true,"abortError":"Error: intentional owned-wipe-17","before":{"harnessInstance":"before-17","productInstance":"product-17","nativeAlarm":null,"alarmInFlight":false},"prepared":{"harnessInstance":"before-17","nativeAlarmAfterPrepare":null},"after":{"harnessInstance":"after-17","productInstance":null,"nativeAlarm":null,"alarmInFlight":false},"verified":{"generations":0,"chunks":0,"payloadBytes":0,"staging":null,"activeBodies":0,"peakBodies":0,"activeGenerations":0,"head":null}}'
  evidence.realProducer = { connections, requests, responseErrors }
  let primary: { error: unknown } | null = null
  try {
    server = createServer((request, response) => {
      requests.push({ method: request.method, url: request.url })
      response.on('error', error => responseErrors.push(String(error)))
      const pathname = new URL(request.url!, 'http://owned.invalid').pathname
      response.writeHead(200, { 'Content-Type': 'application/json', Connection: 'close' })
      if (pathname === '/paused') response.write('held-prefix')
      else response.end(pathname === '/__test/wipe' ? wipeBytes : pathname === '/__orbit/publish/metrics' ? metricBytes : 'complete owned body: α\n')
    })
    server.on('error', error => serverErrors.push(error))
    server.on('connection', socket => {
      sockets.add(socket)
      const record = { closed: false, errors: [] as string[] }
      connections.push(record)
      socket.on('error', error => record.errors.push(String(error)))
      socketJoins.push(new Promise<void>(resolve => socket.once('close', () => { record.closed = true; sockets.delete(socket); resolve() })))
      if (closingServer) socket.destroy()
    })
    await new Promise<void>((resolve, reject) => {
      server!.once('error', reject)
      server!.listen(0, '127.0.0.1', () => { server!.off('error', reject); listening = true; resolve() })
    })
    const port = (server.address() as AddressInfo).port
    if ([8787, 8790, 9230].includes(port)) throw new Error('HTTP observation producer cannot own a reserved port')
    const origin = `http://127.0.0.1:${port}`
    const completeContext = context('actual-complete-body')
    const complete = openSlowStream(origin, '/complete', {}, completeContext.scope('complete-reader', 'reading'))
    handles.push(complete)
    await complete.ready
    expect(complete.status).toBe(200)
    expect((await complete.finish()).toString('utf8')).toBe('complete owned body: α\n')
    const completeJoin = complete.cleanup!()
    expect(complete.cleanup!()).toBe(completeJoin)
    expect(await completeJoin).toMatchObject({ confirmed: true, requestAcquired: true, requestClosed: true, socket: 'closed', responseEnded: true, joinBudgetMs: 3000, failures: [] })
    complete.destroy()
    expect((await complete.finish()).toString('utf8')).toBe('complete owned body: α\n')
    expect(complete.observation?.terminal?.kind).toBe('complete-body')
    expect(complete.observation?.events.map(event => event.name)).toEqual(expect.arrayContaining(['request-close', 'socket-close', 'response-end']))
    completeContext.assertHealthy()

    const cancelContext = context('actual-cancelled-body')
    const cancel = openSlowStream(origin, '/paused', {}, cancelContext.scope('cancel-reader', 'held'))
    handles.push(cancel)
    await cancel.ready
    expect(cancel.status).toBe(200)
    expect(cancel.firstChunkBytes).toBe(11)
    cancel.phase!('cancel')
    cancel.destroy()
    const cancelJoin = cancel.cleanup!()
    expect(cancel.cleanup!()).toBe(cancelJoin)
    expect(await cancelJoin).toMatchObject({ confirmed: true, requestClosed: true, socket: 'closed', responseEnded: false, joinBudgetMs: 3000, failures: [] })
    expect(cancel.observation?.terminal?.kind).toBe('error')
    expect(cancel.observation?.events.map(event => event.name)).toEqual(expect.arrayContaining(['phase-change', 'destruction-requested', 'response-aborted', 'request-close', 'socket-close']))
    // Retained client errors are evidence, not a warning allowlist or a native-ID attribution.
    cancelContext.assertHealthy()

    for (const fixture of [
      {
        name: 'held socket closes after D before timeout dispatch',
        closes: [{ owner: 'request', at: 2000.25 }, { owner: 'socket', at: 4000.5 }],
        expected: { confirmed: false, requestClosedAt: 2000.25, socketClosedAt: 4000.5, socket: 'closed', settledAt: 4000.5, elapsedMs: 3000.25 },
        afterSettlementSocketAt: null, lateLookalike: true,
      },
      {
        name: 'held late request fails before the later actual socket close',
        closes: [{ owner: 'request', at: 4000.5 }],
        expected: { confirmed: false, requestClosedAt: 4000.5, socketClosedAt: null, socket: 'unconfirmed', settledAt: 4000.5, elapsedMs: 3000.25 },
        afterSettlementSocketAt: 5000.5, lateLookalike: false,
      },
      {
        name: 'held timely closes after independently failed owners',
        closes: [{ owner: 'request', at: 2000.25 }, { owner: 'socket', at: 3000.25 }],
        expected: { confirmed: true, requestClosedAt: 2000.25, socketClosedAt: 3000.25, socket: 'closed', settledAt: 3000.25, elapsedMs: 2000 },
        afterSettlementSocketAt: null, lateLookalike: false,
      },
      {
        name: 'held actual closes exactly at the inclusive original deadline',
        closes: [{ owner: 'request', at: 4000.25 }, { owner: 'socket', at: 4000.25 }],
        expected: { confirmed: true, requestClosedAt: 4000.25, socketClosedAt: 4000.25, socket: 'closed', settledAt: 4000.25, elapsedMs: 3000 },
        afterSettlementSocketAt: null, lateLookalike: false,
      },
    ] as const) {
      let heldClock = 1000.25
      const owner = context(fixture.name, () => ({ epochMs: 1710000010000 + heldClock - 1000.25, monotonicMs: heldClock }))
      const request = new EventEmitter()
      const socket = new EventEmitter()
      const response = new EventEmitter()
      const producer = { destroyCalls: 0, timeoutMs: 0, requestCloses: [] as number[], socketCloses: [] as number[] }
      const ownedDestroy: { error?: Error } = {}
      const transport: HeldRequestTransport = (_url, _options, listener) => Object.assign(request, {
        socket: null,
        setTimeout: (milliseconds: number) => { producer.timeoutMs = milliseconds; return request },
        flushHeaders: () => {
          request.emit('socket', socket)
          listener(Object.assign(response, { statusCode: 409, headers: { 'content-type': 'application/json' } }) as unknown as IncomingMessage)
          response.emit('data', Buffer.from('{"rejected":true}'))
          response.emit('end')
          response.emit('close')
        },
        end: () => { throw new Error('The held deadline witness must never send its withheld body') },
        destroy: (error: Error) => {
          producer.destroyCalls++
          ownedDestroy.error = error
          request.emit('error', error)
          // Deliver literal-time close events synchronously. The helper's real
          // timer cannot dispatch inside this call; no global clock is changed.
          for (const close of fixture.closes) {
            heldClock = close.at
            if (close.owner === 'request') { producer.requestCloses.push(heldClock); request.emit('close') }
            else { producer.socketCloses.push(heldClock); socket.emit('close') }
          }
          return request
        },
      }) as unknown as ClientRequest
      const held = await openHeldRequest('http://owned-producer.invalid', '/literal-held-deadline', {
        method: 'PUT', headers: { 'Content-Length': 1_048_576 }, observation: owner.scope('held-deadline', 'controlled'),
      }, transport)
      heldHandles.push(held)
      const record = { name: fixture.name, scriptedCloses: fixture.closes, expected: fixture.expected, producer, observation: held.observation, closure: null as HeldRequestClosure | null }
      heldDeadlineRows.push(record)
      const reply = await held.response
      expect(reply.status).toBe(409)
      expect(reply.body.toString('utf8')).toBe('{"rejected":true}')
      expect(held.sentBodyBytes).toBe(0)
      const join = held.cleanup()
      heldJoins.set(held, join)
      expect(held.cleanup()).toBe(join)
      let resolvedBeforeTimerDispatch = false
      void join.then(() => { resolvedBeforeTimerDispatch = true })
      await Promise.resolve()
      expect(resolvedBeforeTimerDispatch, 'close-event qualification must settle before the timer task can dispatch').toBe(true)
      const closure = await join
      record.closure = closure
      expect(closure).toMatchObject({
        ...fixture.expected, startedAt: 1000.25, deadline: 4000.25,
        requestClosed: true, responseEnded: true, joinBudgetMs: 3000,
      })
      expect(held.observation).toMatchObject({
        cleanupStartedAt: 1000.25, cleanupDeadline: 4000.25,
        requestClosedAt: fixture.expected.requestClosedAt, socketClosedAt: fixture.expected.socketClosedAt,
      })
      expect(closure.failures).toEqual(fixture.expected.confirmed ? [] : ['Held request/socket closure unconfirmed within 3000 ms'])
      expect(closure.errors).toEqual([{
        source: 'request', message: 'Error: Held request intentionally destroyed by the test: /literal-held-deadline',
        code: null, afterResponseEnd: true, duringCleanup: true, intentional: true,
      }])
      expect(producer).toMatchObject({ destroyCalls: 1, timeoutMs: 30000 })
      const originalFailures = [...closure.failures]
      if (fixture.afterSettlementSocketAt !== null) {
        heldClock = fixture.afterSettlementSocketAt
        producer.socketCloses.push(heldClock)
        socket.emit('close')
        expect(closure).toMatchObject({
          confirmed: false, requestClosedAt: 4000.5, socketClosedAt: 5000.5, socket: 'closed',
          startedAt: 1000.25, deadline: 4000.25, settledAt: 4000.5, elapsedMs: 3000.25,
          failures: ['Held request/socket closure unconfirmed within 3000 ms'],
        })
        expect(held.observation.socketClosedAt).toBe(5000.5)
        expect(owner.evidence.operations[0].events).toContainEqual(expect.objectContaining({ name: 'socket-close', at: { epochMs: 1710000014000.25, monotonicMs: 5000.5 } }))
      }
      heldClock = 10000.25
      if (fixture.lateLookalike) {
        expect(ownedDestroy.error).toBeInstanceOf(Error)
        // Identical text is not the exact owned Error; retain the new late
        // failure alongside the original deadline failure after settlement.
        request.emit('error', new Error(ownedDestroy.error!.message))
        expect(closure.errors).toContainEqual({
          source: 'request', message: 'Error: Held request intentionally destroyed by the test: /literal-held-deadline',
          code: null, afterResponseEnd: true, duringCleanup: true, intentional: false,
        })
        expect(closure.failures).toContain('request: Error: Held request intentionally destroyed by the test: /literal-held-deadline')
        expect(owner.evidence.operations[0].errors).toContainEqual(expect.objectContaining({
          source: 'request', intentional: false, afterClosure: true, afterResponseEnd: true, duringCleanup: true,
          at: { epochMs: 1710000019000, monotonicMs: 10000.25 },
        }))
      }
      held.destroy()
      expect(held.cleanup()).toBe(join)
      expect(await held.cleanup()).toBe(closure)
      expect(closure).toMatchObject({ confirmed: fixture.expected.confirmed, startedAt: 1000.25, deadline: 4000.25, settledAt: fixture.expected.settledAt })
      expect(closure.failures.slice(0, originalFailures.length)).toEqual(originalFailures)
      expect(owner.evidence.operations[0].closure).toEqual(closure)
      expect(producer.destroyCalls).toBe(1)
      expect(held.sentBodyBytes).toBe(0)
      if (!fixture.expected.confirmed) {
        expect(() => owner.assertHealthy()).toThrow('HTTP ownership closure incomplete')
        verifiedHeldFailures.add(held)
        incomplete(owner)
      } else owner.assertHealthy()
    }

    let time = { epochMs: 1710000000000, monotonicMs: 1000.25 }
    const earlyContext = context('controlled-early-error', () => time)
    const early = controlled('early-error', earlyContext)
    early.producer.reply()
    await expect(early.stream.ready).rejects.toBe(early.producer.original)
    await expect(early.stream.finish()).rejects.toBe(early.producer.original)
    const earlyJoin = early.stream.cleanup!()
    expect(early.stream.cleanup!()).toBe(earlyJoin)
    expect(await earlyJoin).toMatchObject({ confirmed: true, deadline: 4000.25, startedAt: { epochMs: 1710000000000, monotonicMs: 1000.25 }, socket: 'closed' })
    expect(early.producer.state).toMatchObject({ latchesBeforeEnd: true, latchesBeforeData: true, timeoutMs: 60000, requestDestroyCalls: 1 })
    expect(early.stream.observation?.errors).toContainEqual({
      source: 'response', message: 'Error: owned producer early-error', code: 'E_OWNED_PRODUCER',
      at: { epochMs: 1710000000000, monotonicMs: 1000.25 }, intentional: false, afterResponseEnd: false, duringCleanup: false, afterClosure: false,
    })
    const late = Object.assign(new Error('original late error after the owned close'), { code: 'ECONNRESET' })
    time = { epochMs: 1710000000400, monotonicMs: 1400.25 }
    early.producer.request.emit('error', late)
    expect(early.stream.observation?.errors).toContainEqual({
      source: 'request', message: 'Error: original late error after the owned close', code: 'ECONNRESET',
      at: { epochMs: 1710000000400, monotonicMs: 1400.25 }, intentional: false, afterResponseEnd: false, duringCleanup: true, afterClosure: true,
    })
    await expect(early.stream.finish()).rejects.toBe(early.producer.original)
    expect(early.producer.state.requestDestroyCalls).toBe(1)
    expect(await early.stream.cleanup!()).toBe(await earlyJoin)

    for (const mode of ['factory-failure', 'no-socket-failure', 'after-socket-failure'] as const) {
      const owner = context(mode, () => ({ epochMs: 1710000001000, monotonicMs: 2000.5 }))
      const partial = controlled(mode, owner)
      await expect(partial.stream.ready).rejects.toBe(partial.producer.original)
      const closure = await partial.stream.cleanup!()
      expect(closure).toMatchObject({ confirmed: true, responseEnded: false, deadline: 5000.5, joinBudgetMs: 3000, failures: [] })
      expect(closure.requestAcquired).toBe(mode !== 'factory-failure')
      expect(closure.requestClosed).toBe(mode !== 'factory-failure')
      expect(closure.socket).toBe(mode === 'after-socket-failure' ? 'closed' : 'not-acquired')
      expect(partial.producer.state.requestDestroyCalls).toBe(mode === 'factory-failure' ? 0 : 1)
      expect(partial.stream.observation?.errors).toContainEqual(expect.objectContaining({ source: 'acquisition', message: `Error: owned producer ${mode}`, code: 'E_OWNED_PRODUCER', intentional: false }))
    }

    const throwingContext = context('throwing-response-destruction', () => ({ epochMs: 1710000002000, monotonicMs: 3000.75 }))
    const throwing = controlled('destroy-throws', throwingContext)
    throwing.producer.reply()
    await throwing.stream.ready
    const throwingClosure = await throwing.stream.cleanup!()
    expect(throwingClosure).toMatchObject({ confirmed: true, requestClosed: true, socket: 'closed', deadline: 6000.75, failures: ['1 owned destruction/ownership failures'] })
    expect(throwing.producer.state).toMatchObject({ responseDestroyCalls: 1, requestDestroyCalls: 1, requestClosed: true, socketClosed: true })
    expect(throwing.stream.observation?.errors).toContainEqual(expect.objectContaining({ source: 'destroy', message: 'Error: owned response destroy invocation failed', intentional: false }))
    expect(() => throwingContext.assertHealthy()).toThrow('HTTP ownership cleanup failed')
    verifiedFailures.add(throwing.stream)
    incomplete(throwingContext)

    let closeClock = { epochMs: 1710000003000, monotonicMs: 4000.125 }
    const stuckContext = context('one-unconfirmed-owned-socket', () => closeClock)
    const stuck = controlled('missing-close', stuckContext)
    const independentContext = context('other-owner-still-closes', () => ({ epochMs: 1710000003000, monotonicMs: 4000.125 }))
    const independent = controlled('paused', independentContext)
    stuck.producer.reply(); independent.producer.reply()
    await Promise.all([stuck.stream.ready, independent.stream.ready])
    const registry = new StreamRegistry()
    registry.streams.push(stuck.stream, independent.stream)
    const batch = registry.cleanupAll()
    expect(registry.cleanupAll()).toBe(batch)
    await Promise.resolve()
    expect(stuck.producer.state.requestDestroyCalls).toBe(1)
    expect(independent.producer.state.requestDestroyCalls).toBe(1)
    const joined = await batch
    evidence.independentCleanup = joined
    expect(joined.outcomes[0].outcome).toMatchObject({ confirmed: false, requestClosed: true, socket: 'unconfirmed', deadline: 7000.125, joinBudgetMs: 3000 })
    expect(joined.outcomes[1].outcome).toMatchObject({ confirmed: true, requestClosed: true, socket: 'closed', deadline: 7000.125, failures: [] })
    closeClock = { epochMs: 1710000006001, monotonicMs: 7001.125 }
    stuck.producer.socket.emit('close')
    expect(await stuck.stream.cleanup!()).toBe(joined.outcomes[0].outcome)
    expect((await stuck.stream.cleanup!()).confirmed).toBe(false)
    expect(stuck.stream.observation?.events).toContainEqual(expect.objectContaining({ name: 'socket-close', at: { epochMs: 1710000006001, monotonicMs: 7001.125 } }))
    expect(stuck.producer.state.requestDestroyCalls).toBe(1)
    expect(() => stuckContext.assertHealthy()).toThrow('HTTP ownership closure incomplete')
    verifiedFailures.add(stuck.stream)
    incomplete(stuckContext)

    const bounded = context('retention-overflow')
    const overflow = controlled('paused', bounded)
    const firstError = Object.assign(new Error('π'.repeat(3000)), { code: 'E_LITERAL_OVERFLOW' })
    overflow.producer.request.emit('error', firstError)
    for (let index = 1; index < 34; index++) overflow.producer.request.emit('error', new Error(`independent producer error ${index}`))
    await expect(overflow.stream.ready).rejects.toBe(firstError)
    expect((await overflow.stream.cleanup!()).confirmed).toBe(true)
    expect(overflow.stream.observation?.errors).toHaveLength(32)
    expect(overflow.stream.observation?.observedCounts.errors).toBe(34)
    expect(overflow.stream.observation?.errors[0].message).toEqual({
      truncated: true, prefix: `Error: ${'π'.repeat(2044)}`, originalBytes: 6007,
      sha256: createHash('sha256').update(`Error: ${'π'.repeat(3000)}`).digest('hex'),
    })
    expect(bounded.evidence.retainedBytes).toBeLessThanOrEqual(8388608)
    expect(bounded.evidence.overflow.count).toBeGreaterThan(0)
    expect(bounded.evidence.overflow.first).toMatchObject({ scope: 'error', limit: 4096, originalBytes: 6007 })
    expect(() => bounded.assertHealthy()).toThrow('HTTP observation incomplete')
    incomplete(bounded)

    let breakObserver = false
    const brokenObserver = context('observer-callback-failure', () => {
      if (breakObserver) throw new Error('literal observer callback failure')
      return { epochMs: 1710000007000, monotonicMs: 8000.25 }
    })
    const survivesObserver = controlled('paused', brokenObserver)
    breakObserver = true
    expect(() => survivesObserver.producer.reply()).not.toThrow()
    await survivesObserver.stream.ready
    breakObserver = false
    expect((await survivesObserver.stream.cleanup!()).confirmed).toBe(true)
    expect(brokenObserver.evidence.observerFailures.count).toBeGreaterThan(0)
    expect(brokenObserver.evidence.observerFailures.first).toMatchObject({ source: 'timestamp', message: 'Error: literal observer callback failure' })
    expect(() => brokenObserver.assertHealthy()).toThrow('HTTP observation incomplete')
    incomplete(brokenObserver)

    const wipeContext = context('actual-wipe-return')
    const wipe = await wipeStore(origin, wipeContext.scope('reset-once', 'prepare'))
    expect(wipe).toEqual({
      wiped: true, nonce: 'owned-wipe-17', abortObserved: true, abortError: 'Error: intentional owned-wipe-17',
      before: { harnessInstance: 'before-17', productInstance: 'product-17', nativeAlarm: null, alarmInFlight: false },
      prepared: { harnessInstance: 'before-17', nativeAlarmAfterPrepare: null },
      after: { harnessInstance: 'after-17', productInstance: null, nativeAlarm: null, alarmInFlight: false },
      verified: { generations: 0, chunks: 0, payloadBytes: 0, staging: null, activeBodies: 0, peakBodies: 0, activeGenerations: 0, head: null },
    })
    expect(wipeContext.evidence.wipes).toHaveLength(1)
    expect(wipeContext.evidence.wipes[0]).toMatchObject({ caseId: 'actual-wipe-return', label: 'reset-once', witness: wipe })
    expect(wipeContext.evidence.operations[0].closure).toMatchObject({ confirmed: true, requestClosed: true, socket: 'closed', responseEnded: true })
    expect(requests.filter(request => request.url === '/__test/wipe')).toEqual([{ method: 'GET', url: '/__test/wipe' }])

    let metricsTime = { epochMs: 1710000010000, monotonicMs: 1000.25 }
    const metricsContext = context('metrics-identity-and-retry', () => metricsTime, 'abcdef123456')
    let pulls = 0
    const identicalResponse = new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls++
        metricsTime = { epochMs: 1710000011000, monotonicMs: 2000.25 }
        controller.enqueue(Buffer.from(metricBytes)); controller.close()
      },
    }, { highWaterMark: 0 }), { status: 200 })
    const identicalError = Object.assign(new Error('literal first metrics attempt failed'), { code: 'E_METRICS_LITERAL' })
    const calls: { url: string; init: RequestInit | undefined }[] = []
    let errorIdentity = false
    let responseIdentity = false
    let initIdentity = true
    let signalIdentity = true
    const metrics = metricsContext.metrics(origin, 'metrics-existing-consumer', 'cancel', async (input, init) => {
      calls.push({ url: String(input), init })
      if (calls.length === 1) {
        metricsTime = { epochMs: 1710000010250, monotonicMs: 1250.25 }
        throw identicalError
      }
      metricsTime = { epochMs: 1710000010500, monotonicMs: 1500.25 }
      return identicalResponse
    })
    const identityTap: typeof fetch = async (input, init) => {
      try {
        const response = await metrics.fetcher(`${String(input)}?keep=a%20b&other=%2f`, init)
        responseIdentity = response === identicalResponse
        expect(response.bodyUsed).toBe(false)
        expect(pulls).toBe(0)
        return response
      } catch (error) { errorIdentity = error === identicalError; throw error }
      finally {
        const call = calls.at(-1)!
        initIdentity &&= call.init === init
        signalIdentity &&= call.init?.signal === init?.signal
      }
    }
    let consumerResult: Awaited<ReturnType<ReturnType<typeof contractClient>['metrics']>> | undefined
    const result = await metrics.consume(async () => {
      consumerResult = await contractClient(origin, undefined, identityTap).metrics()
      return consumerResult
    })
    expect(result).toBe(consumerResult)
    expect({ errorIdentity, responseIdentity, initIdentity, signalIdentity, pulls }).toEqual({ errorIdentity: true, responseIdentity: true, initIdentity: true, signalIdentity: true, pulls: 1 })
    expect(result).toEqual({
      instance: '11111111-1111-4111-8111-111111111111', rowsRead: 17, rowsWritten: 19, databaseBytes: 4096, payloadBytes: 23, chunks: 2,
      generations: 1, activeBodies: 4, peakBodies: 8, activeGenerations: 4, explicitChunkCacheEntries: 1, peakExplicitChunkBuffers: 2, staging: null,
    })
    expect(calls.map(call => call.url)).toEqual([
      `${origin}/__orbit/publish/metrics?keep=a%20b&other=%2f&__orbit_capacity_op=s82.abcdef123456.m1.a1`,
      `${origin}/__orbit/publish/metrics?keep=a%20b&other=%2f&__orbit_capacity_op=s82.abcdef123456.m1.a2`,
    ])
    for (const call of calls) {
      expect(call.init).toMatchObject({ method: 'GET', redirect: 'manual' })
      expect(call.init?.body).toBeUndefined()
      expect(call.init?.signal).toBeInstanceOf(AbortSignal)
      expect(call.init?.headers).toEqual({ Authorization: 'Bearer fictional-worker-contract-token-0123456789abcdef0123456789abcdef0123456789', 'Accept-Encoding': 'gzip' })
    }
    expect(identicalResponse.bodyUsed).toBe(true)
    expect(metricsContext.evidence.metricsAttempts).toHaveLength(2)
    expect(metricsContext.evidence.metricsAttempts[0]).toMatchObject({
      attempt: 1, startedAt: { epochMs: 1710000010000, monotonicMs: 1000.25 }, headers: null,
      delegated: true, error: { source: 'fetch', at: { epochMs: 1710000010250, monotonicMs: 1250.25 }, message: 'Error: literal first metrics attempt failed', code: 'E_METRICS_LITERAL' },
    })
    expect(metricsContext.evidence.metricsAttempts[1]).toMatchObject({
      attempt: 2, delegated: true, startedAt: { epochMs: 1710000010250, monotonicMs: 1250.25 }, headers: { at: { epochMs: 1710000010500, monotonicMs: 1500.25 }, status: 200 }, error: null,
    })
    expect(metricsContext.evidence.metricsOperations[0].consumer).toEqual({ at: { epochMs: 1710000011000, monotonicMs: 2000.25 }, outcome: 'validated-result', result })
    evidence.metricsIdentity = { errorIdentity, responseIdentity, initIdentity, signalIdentity, pulls, calls: calls.map(call => ({ url: call.url, method: call.init?.method, bodyAbsent: call.init?.body === undefined })) }

    const actualMetricsContext = context('metrics-real-producer', undefined, 'fedcba654321')
    const actualMetrics = actualMetricsContext.metrics(origin, 'real-metrics', 'recovery')
    expect(await actualMetrics.consume(() => contractClient(origin, undefined, actualMetrics.fetcher).metrics())).toEqual({
      instance: '11111111-1111-4111-8111-111111111111', rowsRead: 17, rowsWritten: 19, databaseBytes: 4096, payloadBytes: 23, chunks: 2,
      generations: 1, activeBodies: 4, peakBodies: 8, activeGenerations: 4, explicitChunkCacheEntries: 1, peakExplicitChunkBuffers: 2, staging: null,
    })
    expect(requests.filter(request => request.url?.startsWith('/__orbit/publish/metrics'))).toEqual([
      { method: 'GET', url: '/__orbit/publish/metrics?__orbit_capacity_op=s82.fedcba654321.m1.a1' },
    ])
    expect(actualMetricsContext.evidence.metricsAttempts[0].headers?.status).toBe(200)
    expect(actualMetricsContext.evidence.operations).toEqual([]) // fetch supplies no per-request socket receipt.
    const invalidMetricsContext = context('metrics-consumer-failure')
    const invalidMetrics = invalidMetricsContext.metrics(origin, 'schema-failure', 'controlled', async () => new Response('{"not":"metrics"}', { status: 200 }))
    let consumerError: unknown
    const invalidOutcome = await invalidMetrics.consume(async () => {
      try { return await contractClient(origin, undefined, invalidMetrics.fetcher).metrics() }
      catch (error) { consumerError = error; throw error }
    }).then(() => null, error => error as unknown)
    expect(invalidOutcome).toBe(consumerError)
    expect(String(invalidOutcome)).toBe('Error: Publication request failed (INVALID_METRICS)')
    expect(invalidMetricsContext.evidence.metricsAttempts).toHaveLength(1)
    expect(invalidMetricsContext.evidence.metricsAttempts[0]).toMatchObject({ headers: { status: 200 }, error: null })
    expect(invalidMetricsContext.evidence.metricsOperations[0].consumer).toMatchObject({
      outcome: 'error', error: { source: 'consumer', message: 'Error: Publication request failed (INVALID_METRICS)', code: 'INVALID_METRICS' },
    })
    const refusedContext = context('metrics-tag-boundaries')
    let outsideCalls = 0
    for (const url of [`${origin}/other`, `${origin}/__orbit/publish/metrics?__orbit_capacity_op=foreign`, 'http://127.0.0.1:8787/__orbit/publish/metrics', 'https://job.hyunjun.workers.dev/__orbit/publish/metrics']) {
      const refused = refusedContext.metrics(origin, 'refused-url', 'controlled', async () => { outsideCalls++; throw new Error('The refused URL reached the delegate') })
      await expect(refused.consume(async () => {
        await refused.fetcher(url, { method: 'GET' })
        throw new Error('The refused metrics call unexpectedly succeeded')
      })).rejects.toThrow('Observed metrics URL is outside the owned untagged metrics route')
    }
    expect(outsideCalls).toBe(0)
    expect(refusedContext.evidence.metricsAttempts.map(attempt => attempt.url)).toEqual([null, null, null, null])
    expect(refusedContext.evidence.metricsAttempts.map(attempt => attempt.delegated)).toEqual([false, false, false, false])
  } catch (error) { primary = { error } }
  await finalizeCase(info, 'bounded-http-observation-witnesses', evidence, primary, [
    ...handles.map((handle, index) => ({ label: `owned-http-${index}`, run: async () => {
      const closure = await handle.cleanup!()
      if (!verifiedFailures.has(handle) && (!closure.confirmed || closure.failures.length)) throw new Error(`Owned HTTP witness closure failed: ${closure.failures.join('; ')}`)
      return closure
    } })),
    ...heldHandles.map((handle, index) => ({ label: `owned-held-deadline-${index}`, run: async () => {
      const join = handle.cleanup()
      const original = heldJoins.get(handle)
      if (original) expect(join).toBe(original)
      const closure = await join
      if (original) expect(closure).toMatchObject({ startedAt: 1000.25, deadline: 4000.25 })
      if (!verifiedHeldFailures.has(handle) && (!closure.confirmed || closure.failures.length)) throw new Error(`Owned held witness closure failed: ${closure.failures.join('; ')}`)
      return closure
    } })),
    { label: 'observations-complete-or-explicitly-proven-failure', run: async () => {
      for (const row of contexts) {
        if (!row.expectedIncomplete) row.context.assertHealthy()
        else expect(() => row.context.assertHealthy()).toThrow()
      }
      return { contexts: contexts.length, provenIncomplete: contexts.filter(row => row.expectedIncomplete).length }
    } },
    { label: 'owned-producer-listener-and-sockets', run: async () => {
      const failures: unknown[] = [...serverErrors]
      let closed = !listening
      const joined = Promise.all(socketJoins)
      if (server && listening) {
        closingServer = true
        const listenerClose = new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()))
        for (const socket of sockets) { try { socket.destroy() } catch (error) { failures.push(error) } }
        try { server.closeAllConnections() } catch (error) { failures.push(error) }
        try {
          if (await within(listenerClose, 3000) === 'timeout') throw new Error('Owned observation producer listener close was not observed')
          closed = true
        } catch (error) { failures.push(error) }
      }
      try { if (await within(joined, 3000) === 'timeout') throw new Error('Owned observation producer socket closes were not observed') }
      catch (error) { failures.push(error) }
      if (!closed || sockets.size || connections.some(connection => !connection.closed)) failures.push(new Error('Owned observation producer physical closure incomplete'))
      if (responseErrors.length || connections.some(connection => connection.errors.length)) failures.push(new Error('Owned observation producer reported an unexpected error'))
      const result = { closed, remainingSockets: sockets.size, connections, failures: failures.map(String) }
      evidence.realProducerClosure = result
      if (failures.length) throw new AggregateError(failures, 'Owned HTTP observation producer cleanup failed')
      return result
    } },
  ])
})

// Remedy07 literal process-boundary producers. These fixtures do not launch a
// process, consult a port, or derive their expected verdict from the validator.
const SAMPLER_FAKE_PID = 620001
const SAMPLER_COMMAND_PID = 620002
const SAMPLER_LOADER_PID = 620003
function samplerLiteralBinding(info: TestInfo): SamplerBinding {
  const runtime = literalCommandRuntime()
  runtime.registryPath = '/literal/verification/worker-capacity-000000000000/processes.ndjson'
  return { run: 'worker-capacity-000000000000', actor: 'literal-capacity-owner', sourceDigest: '1'.repeat(64), planSha256: '2'.repeat(64),
    runtime, artifactPath: info.outputPath(`literal-sampler-${randomUUID()}.json`), cadence: 250 }
}
function samplerLiteralSample(binding: SamplerBinding, phase = 'idle', sequence = 1, rss: number | null = 123456): MemorySample {
  const bounded = (value: string) => ({ text: value, originalBytes: Buffer.byteLength(value), retainedBytes: Buffer.byteLength(value), truncated: false })
  const offset = (sequence - 1) * 3000
  const at = (monotonicMs: number) => ({ monotonicMs: monotonicMs + offset, epochMs: 1_000_000 })
  const mark = (order: number, monotonicMs: number) => ({ order, at: at(monotonicMs) })
  const zero = <T>() => ({ count: 0, first: null as T | null, last: null as T | null, omitted: 0 })
  const one = <T>(value: T) => ({ count: 1, first: value, last: value, omitted: 0 })
  const raw = rss === null ? '' : `4242 1 4242 Sat Oct 3 06:00:00 2026 ${rss} workerd serve\n`
  const startedAt = at(1000.25)
  const callbackAt = at(2000.5)
  const completionAt = at(2000.75)
  const observation: CommandObservation = {
    version: 1, sequence, file: bounded('ps'), argv: bounded(JSON.stringify(['-o', 'pid=,ppid=,pgid=,lstart=,rss=,command=', '-p', '4242'])),
    parent: { pid: SAMPLER_FAKE_PID, ppid: process.pid, actor: bounded(binding.actor), registry: bounded(binding.runtime.registryPath), run: bounded(binding.run) },
    timeoutMs: 5000, killSignal: 'SIGKILL', maxBuffer: 16777216, startedAt, deadline: 6000.25 + offset, dispatchPhase: bounded(phase),
    callbackCount: 1, settlements: 1, invocationFailure: null, laterCallback: null, available: true,
    callback: { order: 5, at: callbackAt, phase: bounded(phase), error: null, code: 0,
      childFlags: { killed: false, exitCode: 0, signalCode: null },
      observedAtCallback: { exit: 1, close: 0, stdoutEnd: 1, stdoutClose: 0, stderrEnd: 1, stderrClose: 0, observerFailures: 0 },
      output: { stdoutDecodedUtf8Bytes: Buffer.byteLength(raw), stderrDecodedUtf8Bytes: 0, maxBufferFailureReported: false, completeness: 'not-reported-incomplete' } },
    child: { acquired: true, pid: SAMPLER_COMMAND_PID + sequence - 1, flagsAtReturn: { killed: false, exitCode: null, signalCode: null },
      exit: one({ ...mark(4, 1950), code: 0, signal: null }), close: one({ ...mark(8, 2000.7), code: 0, signal: null }), error: zero() },
    stdout: { present: true, attached: { data: true, end: true, close: true, error: true },
      data: { count: raw ? 1 : 0, decodedUtf8Bytes: Buffer.byteLength(raw), bufferBytes: 0, unknownChunks: 0,
        first: raw ? mark(1, 1500) : null, last: raw ? mark(1, 1500) : null },
      end: one(mark(2, 1900)), close: one(mark(6, 2000.6)), error: zero() },
    stderr: { present: true, attached: { data: true, end: true, close: true, error: true },
      data: { count: 0, decodedUtf8Bytes: 0, bufferBytes: 0, unknownChunks: 0, first: null, last: null },
      end: one(mark(3, 1900.1)), close: one(mark(7, 2000.61)), error: zero() },
    observerFailures: zero(),
  }
  return { at: '1970-01-01T00:16:40.000Z', phase,
    processes: [{ pid: 4242, role: 'owned-runtime', rssKiB: rss, availability: rss === null ? 'missing-row' : 'valid' }],
    identityProblems: rss === null ? ['owned-runtime workerd 4242 is gone'] : [], commandError: null,
    raw: { code: 0, stdout: raw, stderr: '' }, commandObservation: observation,
    provenance: { dispatch: { phase, at: startedAt }, callback: { phase, at: callbackAt }, completion: { phase, at: completionAt } } }
}
function samplerLiteralSummary(binding: SamplerBinding, samples = [samplerLiteralSample(binding)]): MemorySummary {
  return {
    unit: 'KiB resident set size (ps rss) per owned workerd process, phase-labelled',
    scope: 'host-level process memory of this run\'s registered workerd processes (proxy listener and owned runtime reported separately); includes runtime overhead and every isolate in that process; context only, not a bound on provider-charged isolate memory',
    owned: [{ pid: 4242, role: 'owned-runtime', command: 'workerd serve' }],
    samples, sampleCount: 1, validSampleCount: 1, invalidSamples: [], skippedTicks: 0, peakRssKiBByPid: { '4242': 123456 }, errors: [], usable: true,
  }
}
function samplerLiteralHistory(values: string[]): SamplerHistory {
  const bytes = values.reduce((sum, value) => sum + Buffer.byteLength(value), 0)
  return { frames: values.length, originalBytes: bytes, retainedBytes: bytes, values: [...values], overflow: null }
}
function samplerLiteralArtifact(binding: SamplerBinding, session: string, requests: string[] = [], replies: string[] = [], phases: SamplerPhase[] = [{ phase: 'idle', at: { monotonicMs: 900, epochMs: 1_000_000 } }]): SamplerArtifact {
  if (!requests.length && !replies.length) {
    const frame = (senderPid: number, sequence: number, requestId: number, kind: string, operation: string, payload: unknown, monotonicMs: number) =>
      JSON.stringify({ version: 1, session, sequence, requestId, kind, operation, senderPid, at: { monotonicMs, epochMs: 1_000_000 }, payload })
    requests = [frame(process.pid, 1, 1, 'request', 'initialize', binding, 1000.25)]
    replies = [frame(SAMPLER_FAKE_PID, 1, 0, 'ready', 'initialize', { controlReady: true, parentPid: process.pid }, 800),
      frame(SAMPLER_FAKE_PID, 2, 1, 'ack', 'initialize', { binding, cadenceStarted: true, acceptedAt: { monotonicMs: 850, epochMs: 1_000_000 } }, 860)]
    for (const [index, p] of phases.entries()) {
      requests.push(frame(process.pid, index + 2, index + 2, 'request', 'phase', { phase: p.phase }, 1010 + index))
      replies.push(frame(SAMPLER_FAKE_PID, index + 3, index + 2, 'ack', 'phase', { phase: p.phase, acceptedAt: p.at }, p.at.monotonicMs + 0.25))
    }
    requests.push(frame(process.pid, requests.length + 1, requests.length + 1, 'request', 'stop', { cancel: false }, 2100.125))
  }
  const sample = samplerLiteralSample(binding, phases.at(-1)?.phase ?? 'start')
  const summary = samplerLiteralSummary(binding, [sample])
  return { version: 1, session, binding, parentPid: process.pid, childPid: SAMPLER_FAKE_PID,
    clocks: { parent: `parent ${process.pid}: performance.now; receipt deadline authority`, child: `child ${SAMPLER_FAKE_PID}: performance.now; command/phase observations only` },
    phases, control: { received: samplerLiteralHistory(requests), sent: samplerLiteralHistory(replies) }, summary,
    leases: [{ sequence: 1, pid: SAMPLER_COMMAND_PID, terminal: true, exit: 1, close: 1, stdoutEnd: 1, stdoutClose: 1, stderrEnd: 1, stderrClose: 1, observerFailures: 0 }],
    retention: { records: 1, accountedBytes: 4194304 + Buffer.byteLength(JSON.stringify(sample)) + 1025, terminalReserve: 4194304, leaseReserve: 1024, overflow: null },
    complete: true, failures: { count: 0, retained: [], omitted: 0 }, terminalOverflow: null }
}
function samplerFakeClock(start = 1000.25) {
  let monotonic = start
  let nextId = 0
  const timers = new Map<number, { at: number; callback: () => void }>()
  const clock: SamplerClock = {
    now: () => monotonic, wallNow: () => 1_000_000 + monotonic - start,
    schedule(callback, ms) { const id = ++nextId; timers.set(id, { at: monotonic + ms, callback }); return id },
    clear(handle) { timers.delete(handle as number) },
  }
  return {
    clock,
    at(value: number, dispatchTimers = false) {
      monotonic = value
      if (dispatchTimers) {
        let budget = 200
        while (budget-- > 0) {
          const next = [...timers.entries()].filter(([, timer]) => timer.at <= monotonic).sort((a, b) => a[1].at - b[1].at)[0]
          if (!next) break
          timers.delete(next[0]); next[1].callback()
        }
        if (budget <= 0) throw new Error('Literal timer producer did not settle')
      }
    },
    pending: () => timers.size,
  }
}
async function samplerMicrotasks() {
  // Drain this finite literal producer's promises; this is not a real-time retry.
  for (let turn = 0; turn < 32; turn++) await Promise.resolve()
}
function samplerControllerFixture(info: TestInfo, settings: {
  launchThrows?: boolean; autoInitialize?: boolean; autoPhase?: boolean; autoStop?: boolean; autoClose?: boolean
  captureFault?: 'parent' | 'birth' | 'argv' | 'registration'; sendFailure?: boolean
  artifactPath?: string; realArtifactRead?: boolean
  returnedNoPid?: boolean; missingStdout?: boolean; stdoutObserverThrow?: boolean
} = {}) {
  const binding = samplerLiteralBinding(info)
  if (settings.artifactPath) binding.artifactPath = settings.artifactPath
  const timing = samplerFakeClock()
  const requests: { raw: string; frame: SamplerFrame }[] = []
  const replies: string[] = []
  const phases: SamplerPhase[] = []
  const records: RegisteredProcess[] = []
  const tables: ProcessIdentity[] = []
  const signals: { pid: number; signal: string }[] = []
  let ownership: NativeSamplerOwnership | null = null
  let replySequence = 0
  let sealed: SamplerArtifact | null = null
  let frozenBody: Buffer | null = null
  let throwRead: Error | null = null
  let observedReadFailure: unknown = null
  let completeReadAt: number | null = null
  let alterArtifact: ((value: SamplerArtifact) => void) | null = null
  class Pipe extends EventEmitter {
    constructor(private readonly label: string) { super() }
    override on(event: string | symbol, listener: (...args: any[]) => void) {
      if (settings.stdoutObserverThrow && this.label === 'stdout' && event === 'data') throw new Error('literal stdout data observer acquisition failed')
      return super.on(event, listener)
    }
  }
  class Child extends EventEmitter {
    pid = SAMPLER_FAKE_PID
    connected = true
    exitCode: number | null = null
    signalCode: string | null = null
    stdout = new Pipe('stdout')
    stderr = new Pipe('stderr')
    killCalls: string[] = []
    send(raw: string, callback: (error: Error | null) => void) {
      const frame = JSON.parse(raw) as SamplerFrame
      requests.push({ raw, frame })
      if (settings.sendFailure) { callback(new Error('literal send failure')); return }
      callback(null)
      if (frame.operation === 'initialize' && settings.autoInitialize !== false) queueMicrotask(() => initializeAck(frame.requestId))
      if (frame.operation === 'phase' && settings.autoPhase !== false) queueMicrotask(() => phaseAck(frame.requestId, frame.payload.phase as string))
      if (frame.operation === 'stop' && settings.autoStop !== false) queueMicrotask(() => terminal(frame.requestId))
    }
    kill(signal: NodeJS.Signals) { this.killCalls.push(signal); return true }
  }
  const child = new Child()
  const reply = (kind: SamplerFrame['kind'], operation: SamplerFrame['operation'], requestId: number, payload: Record<string, unknown>, override: Partial<SamplerFrame> = {}) => {
    const frame = { version: 1, session: owner.session, sequence: ++replySequence, requestId, kind, operation, senderPid: SAMPLER_FAKE_PID,
      at: { monotonicMs: 950 + replySequence, epochMs: 1_000_000 }, payload, ...override }
    const raw = JSON.stringify(frame); replies.push(raw); child.emit('message', raw)
    return raw
  }
  const ready = (override: Partial<SamplerFrame> = {}) => reply('ready', 'initialize', 0, { controlReady: true, parentPid: process.pid }, { at: { monotonicMs: 800, epochMs: 1_000_000 }, ...override })
  const initializeAck = (id = requests.find(r => r.frame.operation === 'initialize')!.frame.requestId) =>
    reply('ack', 'initialize', id, { binding, cadenceStarted: true, acceptedAt: { monotonicMs: 850, epochMs: 1_000_000 } })
  const phaseAck = (id: number, phase: string) => {
    const acceptedAt = { monotonicMs: 900 + phases.length, epochMs: 1_000_000 }
    phases.push({ phase, at: acceptedAt })
    return reply('ack', 'phase', id, { phase, acceptedAt })
  }
  const close = (omit: string[] = [], code = 0) => {
    const wall = timing.clock.wallNow()
    const emit = (event: string, action: () => void) => { if (!omit.includes(event)) action() }
    emit('exit', () => {
      if (child.exitCode !== null) return
      child.exitCode = code
      if (!settings.returnedNoPid) records.push({ event: 'exit', pid: child.pid, ppid: process.pid, at: wall, code, signal: null })
      child.emit('exit', code, null)
    })
    emit('disconnect', () => { if (child.connected) { child.connected = false; child.emit('disconnect') } })
    for (const name of ['stdout', 'stderr'] as const) {
      emit(`${name}End`, () => child[name].emit('end'))
      emit(`${name}Close`, () => child[name].emit('close'))
    }
    emit('close', () => { if (!owner.evidence.physical.close) child.emit('close', code, null) })
  }
  const terminal = (id = requests.find(r => r.frame.operation === 'stop')!.frame.requestId) => {
    sealed = samplerLiteralArtifact(binding, owner.session, requests.map(r => r.raw), replies, phases)
    alterArtifact?.(sealed)
    frozenBody = Buffer.from(JSON.stringify(sealed))
    reply('terminal', 'stop', id, { path: binding.artifactPath, bytes: frozenBody.length, sha256: createHash('sha256').update(frozenBody).digest('hex'), complete: sealed.complete })
    if (settings.autoClose !== false) close()
  }
  const producers: SamplerOwnershipProducers = {
    records: async () => records,
    table: async pids => tables.filter(row => pids.includes(row.pid)),
    signal: (pid, signal) => { signals.push({ pid, signal }); return true },
  }
  const owner = new SamplerProcess(binding.runtime, binding.artifactPath, {
    binding, clock: timing.clock,
    launch(_session, argv) {
      if (settings.launchThrows) throw new Error('literal preload append threw after native launch; no handle returned')
      if (!settings.returnedNoPid) {
        records.push({ event: 'spawn', pid: child.pid, ppid: settings.captureFault === 'parent' ? process.pid + 1 : process.pid,
          at: 1_000_000, argv: settings.captureFault === 'argv' ? ['unrelated-program'] : argv })
        tables.push({ pid: child.pid, ppid: process.pid, pgid: child.pid, started: settings.captureFault === 'birth' ? 'Thu Jan 1 01:16:40 1970' : 'Thu Jan 1 00:16:40 1970', command: argv.join(' ') })
      }
      if (settings.captureFault === 'registration') records.length = 0
      if (settings.returnedNoPid || settings.missingStdout) {
        // Independent returned-handle view: the backing emitters are retained,
        // but a missing native PID/pipe is never filled in from the fixture PID.
        return {
          get pid() { return settings.returnedNoPid ? undefined : child.pid },
          get connected() { return child.connected },
          get exitCode() { return child.exitCode },
          get signalCode() { return child.signalCode },
          stdout: settings.missingStdout ? null : child.stdout, stderr: child.stderr,
          on: (event: string, listener: (...args: any[]) => void) => child.on(event, listener),
          send: (raw: string, callback: (error: Error | null) => void) => child.send(raw, callback),
          kill: (signal: NodeJS.Signals) => child.kill(signal),
        }
      }
      return child
    },
    ownership(value, b) {
      ownership = new NativeSamplerOwnership(b, value, owner.evidence.launch!.argv, 1_000_000, timing.clock, producers)
      return ownership
    },
    async readArtifact(expected, payload, deadline, now) {
      if (settings.realArtifactRead) {
        try { return await readSamplerArtifact(expected, payload, deadline, now) }
        catch (error) { observedReadFailure = error; throw error }
      }
      if (throwRead) throw throwRead
      if (completeReadAt !== null) timing.at(completeReadAt, false)
      if (!sealed || !frozenBody || expected !== binding.artifactPath || payload.path !== expected) throw new Error('literal artifact producer unavailable')
      return { path: expected, body: frozenBody, bytes: frozenBody.length, sha256: createHash('sha256').update(frozenBody).digest('hex'),
        descriptor: { device: '7', inode: '9', mode: '33152', size: frozenBody.length }, value: sealed }
    },
  })
  return {
    owner, child, binding, timing, requests, replies, records, tables, signals, producers,
    ready, reply, initializeAck, phaseAck, terminal, close, ownership: () => ownership!,
    artifact: () => sealed, artifactBytes: () => frozenBody,
    readFailure: () => observedReadFailure,
    changeArtifact(fn: (artifact: SamplerArtifact) => void) { alterArtifact = fn },
    failRead(error: Error) { throwRead = error },
    readAt(value: number) { completeReadAt = value },
    async start() { const started = owner.start(); ready(); await started },
    async cleanup() {
      const pending = owner.stop(true)
      if (settings.returnedNoPid) close(['exit'], -2)
      else close()
      await samplerMicrotasks()
      const deadline = owner.evidence.finalization!.deadline
      if (timing.clock.now() <= deadline) timing.at(deadline, true)
      return pending
    },
  }
}

async function samplerProcessWitnesses(info: TestInfo) {
  const rows: { id: string; variants: unknown[]; completed: boolean }[] = []
  const evidence: Record<string, unknown> = { rows, expectedRows: ['SP01', 'SP02', 'SP03', 'SP04', 'SP05', 'SP06', 'SP07', 'SP08', 'SP09', 'SP10', 'SP11', 'SP12', 'SP13', 'SP14', 'SP15', 'SP16', 'SP17'],
    distinction: 'SP01 uses the one real registered child path. Other rows use named literal in-memory producers or owned temporary files; they do not diagnose the historical failure.' }
  const controls: ReturnType<typeof samplerControllerFixture>[] = []
  const directories: string[] = []
  const componentSamplers: MemorySampler[] = []
  const releaseComponents: (() => void)[] = []
  let actual: SamplerProcess | undefined
  let primary: { error: unknown } | null = null
  const row = (id: string) => { const value = { id, variants: [] as unknown[], completed: false }; rows.push(value); return value }
  const fixture = (settings: Parameters<typeof samplerControllerFixture>[1] = {}) => {
    const value = samplerControllerFixture(info, settings); controls.push(value); return value
  }
  try {
    const real = row('SP01')
    const runtime = await bindOwnedRuntime(validateOwnedEndpoints(
      process.env.ORBIT_WORKER_TEST_BASE_URL ?? 'http://127.0.0.1:8790',
      process.env.ORBIT_WORKER_INSPECTOR_PORT ?? '9230',
    ))
    actual = new SamplerProcess(runtime, info.outputPath(`sampler-independent-busy-${randomUUID()}.json`))
    evidence.actualOwner = actual.evidence
    await actual.start()
    await actual.phase('idle')
    await actual.phase('controller-busy')
    let queuedCallbackRan = false
    const queued = new Promise<void>(resolve => setImmediate(() => { queuedCallbackRan = true; resolve() }))
    const busyStart = { epochMs: Date.now(), monotonicMs: performance.now() }
    while (performance.now() - busyStart.monotonicMs < 1200) { /* Deliberate finite controller scheduling witness. */ }
    const busyEnd = { epochMs: Date.now(), monotonicMs: performance.now() }
    const callbackBeforeYield = queuedCallbackRan
    await queued
    await actual.phase('after-controller-busy')
    const actualOutcome = await actual.stop()
    real.variants.push({ busyStart, busyEnd, callbackBeforeYield, callbackAfterYield: queuedCallbackRan,
      clocks: 'Parent monotonic establishes1200ms. Same-host epoch window locates child samples; child command clocks remain a separate monotonic domain.',
      outcome: actualOutcome })
    await actual.attach(info, 'SP01-owned-sampler-complete-terminal')
    actual.assertComplete(actualOutcome)
    expect(callbackBeforeYield).toBe(false)
    expect(queuedCallbackRan).toBe(true)
    expect(busyEnd.monotonicMs - busyStart.monotonicMs).toBeGreaterThanOrEqual(1200)
    expect(busyEnd.epochMs).toBeGreaterThan(busyStart.epochMs)
    const during = actualOutcome.summary!.samples.filter(sample => sample.provenance!.dispatch.at.epochMs! >= busyStart.epochMs
      && sample.provenance!.completion.at.epochMs! <= busyEnd.epochMs)
    real.variants.push({ completeChildSamplesInsideParentEpochWindow: during })
    expect(during.length).toBeGreaterThanOrEqual(2)
    expect(during.every(sample => sample.phase === 'controller-busy' && sample.commandError === null
      && sample.commandObservation?.available === true && sample.identityProblems.length === 0
      && sample.processes.every(p => p.availability === 'valid'))).toBe(true)
    expect(actualOutcome.evidence.finalization).toMatchObject({ physicalClosed: true, descendantsClosed: true })
    expect(actualOutcome.evidence.physical.exit).toMatchObject({ code: 0, signal: null })
    expect(actualOutcome.evidence.physical.close).toMatchObject({ code: 0, signal: null })
    expect(actualOutcome.evidence.failures.count).toBe(0)
    real.completed = true

    const identities = row('SP02')
    for (const captureFault of ['parent', 'birth', 'argv', 'registration'] as const) {
      const control = fixture({ captureFault })
      const started = control.owner.start().then(() => null, error => error)
      control.ready()
      const error = await started
      expect(error).toBeInstanceOf(Error)
      expect(control.owner.evidence.startup!.qualifiedAt).toBeNull()
      expect(control.requests.filter(r => r.frame.operation === 'initialize')).toHaveLength(0)
      expect(control.signals).toEqual([])
      identities.variants.push({ captureFault, error: String(error), evidence: control.owner.evidence })
      await control.cleanup()
    }
    for (const field of ['run', 'actor', 'sourceDigest', 'planSha256'] as const) {
      const control = fixture({ autoInitialize: false })
      const started = control.owner.start().then(() => null, error => error)
      control.ready(); await samplerMicrotasks()
      control.reply('ack', 'initialize', 1, { binding: { ...control.binding, [field]: field.includes('Digest') || field.includes('Sha256') ? '3'.repeat(64) : 'wrong-owned-binding' },
        cadenceStarted: true, acceptedAt: { monotonicMs: 900, epochMs: 1_000_000 } })
      expect(await started).toBeInstanceOf(Error)
      expect(control.owner.evidence.startup!.qualifiedAt).toBeNull()
      identities.variants.push({ wrongBinding: field, evidence: control.owner.evidence })
      await control.cleanup()
    }
    const wrongPid = fixture()
    const wrongPidStart = wrongPid.owner.start().then(() => null, error => error)
    wrongPid.ready({ senderPid: 620099 })
    expect(await wrongPidStart).toBeInstanceOf(Error)
    expect(wrongPid.signals).toEqual([])
    identities.variants.push({ wrongReturnedSenderPid: true, evidence: wrongPid.owner.evidence })
    await wrongPid.cleanup()
    identities.completed = true

    const malformed = row('SP03')
    const wireFrame = (sequence = 1) => ({ version: 1, session: NONCE, sequence, requestId: 0, kind: 'ready', operation: 'initialize', senderPid: SAMPLER_FAKE_PID,
      at: { monotonicMs: 900.5, epochMs: 1_000_000 }, payload: { controlReady: true, parentPid: process.pid } })
    const invalidFrames: { name: string; value: unknown }[] = [
      { name: 'nonstring null', value: null }, { name: 'array envelope', value: '[]' }, { name: 'malformed JSON', value: '{' },
      { name: 'wrong nonce', value: JSON.stringify({ ...wireFrame(), session: '11111111-1111-4111-8111-111111111111' }) },
      { name: 'wrong version', value: JSON.stringify({ ...wireFrame(), version: 2 }) },
      { name: 'extra key', value: JSON.stringify({ ...wireFrame(), additional: true }) },
      { name: 'missing key', value: JSON.stringify({ ...wireFrame(), at: undefined }) },
      { name: 'unknown operation', value: JSON.stringify({ ...wireFrame(), operation: 'restart' }) },
      { name: 'unsafe sequence', value: JSON.stringify({ ...wireFrame(), sequence: 9007199254740992 }) },
      { name: 'null clock', value: JSON.stringify({ ...wireFrame(), at: { epochMs: 1_000_000, monotonicMs: null } }) },
    ]
    for (const entry of invalidFrames) {
      const wire = new SamplerWire(NONCE, process.pid, SAMPLER_FAKE_PID, 'parent')
      expect(() => wire.receive(entry.value), entry.name).toThrow()
      malformed.variants.push({ name: entry.name, received: wire.received })
    }
    malformed.completed = true

    const sequence = row('SP04')
    for (const variant of ['duplicate', 'gap', 'response-before-request', 'wrong-request-id', 'wrong-operation', 'ready-again'] as const) {
      const control = fixture({ autoPhase: false, autoClose: false })
      await control.start()
      const pending = control.owner.phase('phase-A').then(() => null, error => error)
      await samplerMicrotasks()
      if (variant === 'duplicate') control.child.emit('message', control.replies.at(-1)!)
      else if (variant === 'ready-again') control.ready()
      else control.reply('ack', variant === 'wrong-operation' ? 'initialize' : 'phase',
        variant === 'wrong-request-id' || variant === 'response-before-request' ? 3 : 2,
        variant === 'wrong-operation' ? { binding: control.binding, cadenceStarted: true, acceptedAt: { monotonicMs: 900, epochMs: 1_000_000 } }
          : { phase: 'phase-A', acceptedAt: { monotonicMs: 900, epochMs: 1_000_000 } },
        variant === 'gap' ? { sequence: 4 } : {})
      expect(await pending).toBeInstanceOf(Error)
      expect(control.requests.filter(r => r.frame.operation === 'phase')).toHaveLength(1)
      sequence.variants.push({ variant, evidence: control.owner.evidence })
      await control.cleanup()
    }
    const afterStop = fixture()
    await afterStop.start(); const once = await afterStop.owner.stop()
    expect(once.complete).toBe(true)
    await expect(afterStop.owner.phase('after-stop')).rejects.toThrow(/outside active/)
    expect(afterStop.requests.filter(r => r.frame.operation === 'stop')).toHaveLength(1)
    sequence.variants.push({ afterStop: afterStop.owner.evidence })
    sequence.completed = true

    const deadlines = row('SP05')
    for (const operation of ['initialize', 'phase'] as const) for (const receivedAt of [6000, 6000.25, 6000.5]) {
      const control = fixture({ autoInitialize: operation !== 'initialize', autoPhase: operation !== 'phase' })
      let pending: Promise<unknown>
      if (operation === 'initialize') {
        pending = control.owner.start().then(() => null, error => error)
        control.ready(); await samplerMicrotasks()
      } else {
        await control.start()
        pending = control.owner.phase('deadline-phase').then(() => null, error => error)
      }
      control.timing.at(receivedAt, false) // The timeout callback has NOT run.
      if (operation === 'initialize') control.initializeAck(1)
      else control.phaseAck(2, 'deadline-phase')
      const result = await pending
      if (receivedAt === 6000.5) expect(result).toBeInstanceOf(Error)
      else expect(result).toBeNull()
      deadlines.variants.push({ operation, start: 1000.25, originalDeadline: 6000.25, receivedAt, timeoutTaskDispatched: false, result: result === null ? 'accepted' : String(result), evidence: control.owner.evidence })
      await control.cleanup()
    }
    const readiness = fixture({ autoInitialize: false })
    const notYet = readiness.owner.start().then(() => null, error => error)
    readiness.ready(); await samplerMicrotasks()
    expect(readiness.owner.evidence.startup!.qualifiedAt).toBeNull()
    expect(readiness.requests.filter(r => r.frame.operation === 'initialize')).toHaveLength(1)
    readiness.timing.at(6000.5, false); readiness.initializeAck(1)
    expect(await notYet).toBeInstanceOf(Error)
    deadlines.variants.push({ controlReadyIsNotCadenceAcknowledgement: readiness.owner.evidence })
    await readiness.cleanup()
    deadlines.completed = true

    const provenance = row('SP06')
    const pendingPhase = controlledCommand()
    const phaseSampler = new MemorySampler(literalCommandRuntime(), pendingPhase.witness)
    phaseSampler.phase = 'phase-A'
    const pendingSample = phaseSampler.sampleOnce()
    phaseSampler.phase = 'phase-B'
    pendingPhase.at(2000.5); pendingPhase.complete(null, COMMAND_ROW)
    const transitioned = await pendingSample
    expect(transitioned.provenance!.dispatch).toMatchObject({ phase: 'phase-A', at: { monotonicMs: 1000.25 } })
    expect(transitioned.provenance!.callback).toMatchObject({ phase: 'phase-B', at: { monotonicMs: 2000.5 } })
    expect(transitioned.provenance!.completion).toMatchObject({ phase: 'phase-B', at: { monotonicMs: 2000.5 } })
    expect(transitioned.phase).toBe('phase-B')
    provenance.variants.push({ childCommandPhaseTransition: transitioned, limit: 'Literal child command domain; parent send/receipt times remain separately recorded by the controller fixtures and SP01.' })
    const transitionBinding = samplerLiteralBinding(info)
    const transitionArtifact = samplerLiteralArtifact(transitionBinding, NONCE, [], [], [
      { phase: 'phase-A', at: { monotonicMs: 900, epochMs: 1_000_000 } },
      { phase: 'phase-B', at: { monotonicMs: 1500, epochMs: 1_000_000 } },
    ])
    transitionArtifact.summary.samples[0].commandObservation!.dispatchPhase!.text = 'phase-A'
    transitionArtifact.summary.samples[0].provenance!.dispatch.phase = 'phase-A'
    const acceptedTransition = validateSamplerArtifact(transitionArtifact, transitionBinding, NONCE, process.pid, SAMPLER_FAKE_PID)
    expect(acceptedTransition.summary.samples[0].provenance!.dispatch.phase).toBe('phase-A')
    expect(acceptedTransition.summary.samples[0].provenance!.callback!.phase).toBe('phase-B')
    expect(acceptedTransition.summary.samples[0].phase).toBe('phase-B')
    provenance.variants.push({ literalAcknowledgedTransitionAcrossPendingCommand: transitionArtifact })
    provenance.completed = true

    const partial = row('SP07')
    for (const variant of ['error', 'exit0', 'exit1', 'disconnect', 'stdout-error', 'send-failure'] as const) {
      const control = fixture({ sendFailure: variant === 'send-failure' })
      const started = control.owner.start().then(() => null, error => error)
      if (variant === 'error') control.child.emit('error', new Error('literal child error before ready'))
      else if (variant === 'exit0' || variant === 'exit1') control.close([], variant === 'exit0' ? 0 : 1)
      else if (variant === 'disconnect') { control.child.connected = false; control.child.emit('disconnect') }
      else if (variant === 'stdout-error') control.child.stdout.emit('error', new Error('literal early stdout error'))
      else control.ready()
      expect(await started).toBeInstanceOf(Error)
      expect(control.owner.evidence.startup!.qualifiedAt).toBeNull()
      partial.variants.push({ variant, evidence: control.owner.evidence })
      await control.cleanup()
    }
    for (const variant of ['missing-first-pipe', 'first-pipe-observer-throws'] as const) {
      const control = fixture({ missingStdout: variant === 'missing-first-pipe', stdoutObserverThrow: variant === 'first-pipe-observer-throws' })
      const started = control.owner.start().then(() => null, error => error as unknown)
      expect(String(await started)).toContain(variant === 'missing-first-pipe' ? 'acquired stdout pipe missing' : 'literal stdout data observer acquisition failed')
      const firstFailure = control.owner.evidence.failures.retained[0].text
      const stopped = control.owner.stop()
      expect(control.owner.stop(true)).toBe(stopped)
      expect(control.child.listenerCount('error')).toBe(1)
      expect(control.child.listenerCount('close')).toBe(1)
      expect(control.child.listenerCount('message')).toBe(1)
      expect(control.child.stderr.listenerCount('error')).toBe(1)
      expect(control.child.stderr.listenerCount('end')).toBe(1)
      expect(control.child.stderr.listenerCount('close')).toBe(1)
      expect(() => control.child.stderr.emit('error', new Error('literal independent stderr failure after stdout acquisition fault'))).not.toThrow()
      const outcome = await control.cleanup()
      expect(outcome.complete).toBe(false)
      expect(control.owner.stop()).toBe(stopped)
      expect(outcome.evidence.finalization!.deadline).toBe(16000.25)
      expect(outcome.evidence.failures.retained[0].text).toBe(firstFailure)
      expect(outcome.evidence.failures.retained.some(item => item.text.includes('literal independent stderr failure'))).toBe(true)
      expect(outcome.evidence.observerAcquisition).toEqual(expect.arrayContaining([
        expect.objectContaining({ component: variant === 'missing-first-pipe' ? 'stdout handle' : 'stdout data', attached: false }),
        { component: 'stderr error', attached: true, failure: null },
        { component: 'stderr end', attached: true, failure: null },
        { component: 'stderr close', attached: true, failure: null },
        { component: 'child message', attached: true, failure: null },
      ]))
      expect(outcome.evidence.physical.stderrEnd).not.toBeNull()
      expect(outcome.evidence.physical.stderrClose).not.toBeNull()
      if (variant === 'missing-first-pipe') {
        expect(outcome.evidence.physical.stdoutEnd).toBeNull()
        expect(outcome.evidence.physical.stdoutClose).toBeNull()
        expect(outcome.evidence.finalization!.physicalClosed).toBe(false)
      }
      expect(control.signals).toEqual([])
      expect(control.child.killCalls).toEqual([])
      partial.variants.push({ variant, correction: 'MIR82-R07-01 / ASTRA-CR07-IMPL-02', firstFailure, outcome })
    }
    partial.completed = true

    const intervals = row('SP08')
    const binding = samplerLiteralBinding(info)
    const phases = [{ phase: 'idle', at: { monotonicMs: 900, epochMs: 1_000_000 } }]
    const three = samplerLiteralSummary(binding, [samplerLiteralSample(binding, 'idle', 1, 100000), samplerLiteralSample(binding, 'idle', 2, null), samplerLiteralSample(binding, 'idle', 3, 120000)])
    three.sampleCount = 3; three.validSampleCount = 2; three.peakRssKiBByPid = { '4242': 120000 }; three.usable = false
    three.invalidSamples = [{ at: '1970-01-01T00:16:40.000Z', phase: 'idle', problems: ['owned-runtime workerd 4242 is gone', 'owned-runtime 4242: missing-row'] }]
    expect(() => qualifySamplerSummary(three, binding, SAMPLER_FAKE_PID, phases)).toThrow(/not usable/)
    expect(three.samples[1].commandObservation!.available).toBe(true)
    expect(three.samples[1].commandError).toBeNull()
    expect(three.samples[1].processes[0].rssKiB).toBeNull()
    const claimed = structuredClone(three); claimed.usable = true
    expect(() => qualifySamplerSummary(claimed, binding, SAMPLER_FAKE_PID, phases)).toThrow()
    const late = samplerLiteralSummary(binding)
    const lateObservation = late.samples[0].commandObservation!
    lateObservation.callback!.at.monotonicMs = 6000.5
    late.samples[0].provenance!.completion.at.monotonicMs = 6000.75
    expect(() => qualifySamplerSummary(late, binding, SAMPLER_FAKE_PID, phases)).toThrow(/available flag/)
    intervals.variants.push({ validInvalidValid: three, forgedUsableRejected: true, lateCodeZeroWithForgedAvailability: late })
    intervals.completed = true

    const later = row('SP09')
    const observed = controlledCommand()
    let lease: CommandLease | undefined
    const bounded = execBounded('ps', COMMAND_ARGS, 5000, { ...observed.witness, lifetime: value => { lease = value } })
    observed.at(2000.5); observed.complete(null, COMMAND_ROW)
    const result = await bounded
    expect(result.diagnostic).toBeNull()
    expect(lease!.observedTerminal()).toBe(false)
    observed.child.emit('exit', 0, null); observed.child.stdout.emit('end'); observed.child.stderr.emit('end')
    observed.child.stdout.emit('close'); observed.child.stderr.emit('close'); observed.child.emit('close', 0, null)
    await lease!.terminal
    expect(lease!.observedTerminal()).toBe(true)
    observed.child.stderr.emit('error', new Error('literal late observer mutation'))
    expect(result.diagnostic).toBe('Command child/stdio error was observed')
    const reported = fixture({ autoClose: false })
    await reported.start()
    const reportPending = reported.owner.stop()
    await samplerMicrotasks()
    const originalArtifactSha = createHash('sha256').update(reported.artifactBytes()!).digest('hex')
    reported.child.stdout.emit('data', Buffer.from('late unexpected output'))
    reported.close()
    const lateOutcome = await reportPending
    expect(lateOutcome.complete).toBe(false)
    expect(() => reported.owner.assertComplete(lateOutcome)).toThrow()
    expect(createHash('sha256').update(reported.artifactBytes()!).digest('hex')).toBe(originalArtifactSha)
    expect(reported.artifact()!.complete).toBe(true)
    later.variants.push({ resultAfterLaterObserver: result, provisionalArtifactSha: originalArtifactSha, laterOwner: lateOutcome })
    const childFailureOwner = fixture({ autoClose: false })
    await childFailureOwner.start()
    const childFailureStop = childFailureOwner.owner.stop()
    await samplerMicrotasks()
    const beforeChildFailure = Buffer.from(childFailureOwner.artifactBytes()!)
    expect(childFailureOwner.artifact()!.complete).toBe(true)
    const childFailures = new SamplerFailures()
    let disconnectCalls = 0
    let disconnectReceiver: unknown
    const childExitTarget = {
      exitCode: undefined as number | string | null | undefined,
      get connected() { return childFailureOwner.child.connected },
      disconnect() {
        disconnectCalls++
        disconnectReceiver = this
        childFailureOwner.child.connected = false
        childFailureOwner.child.emit('disconnect')
      },
    }
    // This is the exported policy used by the actual child fail()/shutdown(),
    // imported without running the entry. Its chosen exit code drives the
    // physical producer below; a hard-coded parent-side exit1 is not the oracle.
    const childExitPolicy = new SamplerChildExitPolicy(childFailures, childExitTarget)
    childExitPolicy.shutdown()
    expect(childExitTarget.exitCode).toBe(0)
    expect(childExitTarget.connected).toBe(false)
    expect(disconnectReceiver).toBe(childExitTarget)
    expect(disconnectCalls).toBe(1)
    expect(childFailureOwner.owner.evidence.physical.exit).toBeNull()
    const preFailureReplies = childFailureOwner.replies.length
    childExitPolicy.fail(new Error('literal child process failure after terminal disconnect'))
    childExitPolicy.fail(new Error('literal retained command observer failure before physical exit'))
    expect(childExitTarget.exitCode).toBe(1)
    expect(childFailures.evidence.count).toBe(2)
    expect(childFailures.evidence.retained[0].text).toContain('literal child process failure after terminal disconnect')
    childExitPolicy.shutdown()
    expect(childExitTarget.exitCode).toBe(1)
    expect(disconnectCalls).toBe(1)
    expect(childFailureOwner.replies).toHaveLength(preFailureReplies)
    expect(childFailureOwner.artifactBytes()!.equals(beforeChildFailure)).toBe(true)
    childFailureOwner.close(['disconnect'], Number(childExitTarget.exitCode))
    const childFailureOutcome = await childFailureStop
    expect(childFailureOutcome.complete).toBe(false)
    expect(childFailureOutcome.evidence.physical.exit?.code).toBe(1)
    expect(childFailureOutcome.evidence.physical.close?.code).toBe(1)
    expect(childFailureOutcome.evidence.finalization).toMatchObject({ physicalClosed: true, descendantsClosed: true })
    expect(() => childFailureOwner.owner.assertComplete(childFailureOutcome)).toThrow()
    expect(childFailureOwner.artifactBytes()!.equals(beforeChildFailure)).toBe(true)
    later.variants.push({ correction: 'MIR82-R07-02', actualChildPolicy: childFailures.evidence, disconnectCalls,
      sealedArtifactSha256: createHash('sha256').update(beforeChildFailure).digest('hex'), outcome: childFailureOutcome,
      qualification: 'Actual child failure/exit policy under a literal process-property target; no child entry execution or new IPC operation.' })
    const disconnectedFailures = new SamplerFailures()
    const disconnectedTarget: { exitCode?: number | string | null; connected: boolean } = { connected: false }
    const disconnectedPolicy = new SamplerChildExitPolicy(disconnectedFailures, disconnectedTarget)
    disconnectedPolicy.shutdown()
    disconnectedPolicy.shutdown()
    expect(disconnectedTarget.exitCode).toBe(0)
    expect(disconnectedFailures.evidence.count).toBe(0)
    const startupFailure = new Error('literal startup failure with already-disconnected IPC')
    disconnectedPolicy.fail(startupFailure)
    disconnectedPolicy.shutdown()
    disconnectedPolicy.shutdown()
    expect(disconnectedTarget.exitCode).toBe(1)
    expect(disconnectedTarget.connected).toBe(false)
    expect(disconnectedFailures.evidence).toMatchObject({ count: 1, omitted: 0,
      retained: [{ text: 'Error: literal startup failure with already-disconnected IPC', truncated: false }] })
    later.variants.push({ correction: 'TYPECHECK-11CFA151-OPTIONAL-DISCONNECT-01', variant: 'already-disconnected-missing-method',
      target: disconnectedTarget, actualChildPolicy: disconnectedFailures.evidence })
    for (const variant of ['missing-method', 'throwing-method'] as const) {
      const disconnectOwner = fixture({ autoClose: false })
      await disconnectOwner.start()
      const disconnectStop = disconnectOwner.owner.stop()
      await samplerMicrotasks()
      const sealedBeforeDisconnect = Buffer.from(disconnectOwner.artifactBytes()!)
      const originalDisconnectError = new Error('literal disconnect invocation failure')
      const caughtDisconnectErrors: unknown[] = []
      const disconnectFailures = new class extends SamplerFailures {
        override add(error: unknown): void { caughtDisconnectErrors.push(error); super.add(error) }
      }()
      let calls = 0
      let receiver: unknown
      const target: { exitCode?: number | string | null; connected: boolean; disconnect?: () => void } = {
        get connected() { return disconnectOwner.child.connected },
      }
      if (variant === 'throwing-method') target.disconnect = function (this: typeof target) {
        calls++; receiver = this
        throw originalDisconnectError
      }
      const policy = new SamplerChildExitPolicy(disconnectFailures, target)
      const disconnectEvidence = { correction: 'TYPECHECK-11CFA151-OPTIONAL-DISCONNECT-01', variant,
        actualChildPolicy: disconnectFailures.evidence, physical: disconnectOwner.owner.evidence.physical,
        sealedArtifactSha256: createHash('sha256').update(sealedBeforeDisconnect).digest('hex') }
      later.variants.push(disconnectEvidence)
      expect(() => policy.shutdown()).not.toThrow()
      expect(target.exitCode).toBe(1)
      expect(target.connected).toBe(true)
      expect(disconnectFailures.evidence.count).toBe(1)
      expect(disconnectFailures.evidence.omitted).toBe(0)
      expect(caughtDisconnectErrors).toHaveLength(1)
      if (variant === 'throwing-method') {
        expect(calls).toBe(1)
        expect(receiver).toBe(target)
        expect(caughtDisconnectErrors[0]).toBe(originalDisconnectError)
        expect(disconnectFailures.evidence.retained).toMatchObject([
          { text: 'Error: literal disconnect invocation failure', truncated: false },
        ])
      } else {
        expect(calls).toBe(0)
        expect(caughtDisconnectErrors[0]).toBeInstanceOf(Error)
        expect(disconnectFailures.evidence.retained).toMatchObject([
          { text: 'Error: owned sampler: connected child disconnect is unavailable', truncated: false },
        ])
      }
      expect(disconnectOwner.owner.evidence.physical).toMatchObject({ disconnect: null, exit: null, close: null })
      expect(disconnectOwner.artifact()!.complete).toBe(true)
      expect(disconnectOwner.artifactBytes()!.equals(sealedBeforeDisconnect)).toBe(true)
      expect(disconnectOwner.owner.stop()).toBe(disconnectStop)
      // Only the literal producer supplies physical closure. The real policy's
      // chosen exit code must still make the parent reject the sealed artifact.
      disconnectOwner.close([], Number(target.exitCode))
      const disconnectOutcome = await disconnectStop
      expect(disconnectOutcome.complete).toBe(false)
      expect(disconnectOutcome.evidence.physical.exit?.code).toBe(1)
      expect(disconnectOutcome.evidence.physical.close?.code).toBe(1)
      expect(disconnectOutcome.evidence.finalization).toMatchObject({ physicalClosed: true, descendantsClosed: true })
      expect(() => disconnectOwner.owner.assertComplete(disconnectOutcome)).toThrow()
      expect(disconnectOwner.artifactBytes()!.equals(sealedBeforeDisconnect)).toBe(true)
      Object.assign(disconnectEvidence, { calls,
        invocationErrorRetained: variant === 'throwing-method' ? caughtDisconnectErrors[0] === originalDisconnectError : null,
        outcome: disconnectOutcome, qualification: 'Actual child policy, literal closure producer; no OS child or entry execution.' })
    }
    const queryOwner = fixture()
    await queryOwner.start()
    const queryCommand = controlledCommand()
    queryCommand.child.pid = 620004
    const queryFailures: string[] = []
    const queryOwnership = new NativeSamplerOwnership(queryOwner.binding, queryOwner.child, queryOwner.owner.evidence.launch!.argv,
      1_000_000, queryOwner.timing.clock, { records: async () => queryOwner.records, command: queryCommand.witness,
        signal: () => { throw new Error('Literal late ownership query must not signal') } }, error => queryFailures.push(String(error)))
    const queryPending = queryOwnership.capture(6000.25).then(() => null, error => error as unknown)
    await samplerMicrotasks()
    expect(queryCommand.invocations).toMatchObject([{ file: 'ps', args: ['-o', 'pid=,ppid=,pgid=,lstart=,command=', '-p', '620001'],
      timeout: 5000, killSignal: 'SIGKILL', maxBuffer: 16777216 }])
    queryOwner.timing.at(6000.5, true)
    const queryFailure = await queryPending
    expect(String(queryFailure)).toContain('ownership query')
    expect(queryCommand.child.killCalls).toBe(0) // Already past the original cutoff.
    const lateQueryRow = `620001 ${process.pid} 620001 Thu Jan 1 00:16:40 1970 ${queryOwner.owner.evidence.launch!.argv.join(' ')}\n`
    queryCommand.at(6000.5); queryCommand.complete(null, lateQueryRow)
    queryCommand.child.emit('exit', 0, null); queryCommand.child.stdout.emit('end'); queryCommand.child.stdout.emit('close')
    queryCommand.child.stderr.emit('end'); queryCommand.child.stderr.emit('close'); queryCommand.child.emit('close', 0, null)
    await samplerMicrotasks()
    expect(queryOwnership.evidence.queries).toHaveLength(1)
    expect(queryOwnership.evidence.queries[0]).toMatchObject({ terminal: true,
      result: { stdout: lateQueryRow, diagnostic: 'ps callback exceeded the original 5000 ms acquisition deadline' },
      observation: { callbackCount: 1, child: { pid: 620004 } } })
    expect(queryFailures.length).toBeGreaterThan(0)
    expect(queryOwnership.evidence.signals).toHaveLength(0)
    later.variants.push({ lateOwnershipQuery: queryOwnership.evidence, originalFailure: String(queryFailure), failures: queryFailures,
      qualification: 'A late callback/close updates the retained query holder; it cannot undo the original ownership deadline failure.' })
    await queryOwner.owner.stop()
    later.completed = true

    const components = row('SP10')
    const finalCommand = controlledCommand()
    const finalLeases: CommandLease[] = []
    const finalSampler = new MemorySampler(literalCommandRuntime(), { ...finalCommand.witness, lifetime: value => finalLeases.push(value) },
      { beforeSample() {}, retainSample: async sample => sample })
    componentSamplers.push(finalSampler)
    const finalPending = finalSampler.stop()
    expect(finalSampler.pendingSample()).toBeNull()
    expect(finalLeases).toHaveLength(1)
    expect(finalLeases[0].observedTerminal()).toBe(false)
    expect(finalCommand.invocations).toMatchObject([{ timeout: 5000, killSignal: 'SIGKILL', maxBuffer: 16777216 }])
    let finalReleased = false
    const releaseFinal = () => {
      if (finalReleased) return
      finalReleased = true
      finalCommand.at(2000.5); finalCommand.complete(null, COMMAND_ROW)
      finalCommand.child.emit('exit', 0, null); finalCommand.child.stdout.emit('end'); finalCommand.child.stdout.emit('close')
      finalCommand.child.stderr.emit('end'); finalCommand.child.stderr.emit('close'); finalCommand.child.emit('close', 0, null)
    }
    releaseComponents.push(releaseFinal); releaseFinal()
    const finalSummary = await finalPending
    await finalLeases[0].terminal
    expect(finalSummary.sampleCount).toBe(1)
    expect(finalLeases[0].observedTerminal()).toBe(true)
    expect(finalCommand.invocations).toHaveLength(1)
    components.variants.push({ eligibleFinalOutsideCadencePending: finalSummary, observation: finalLeases[0].observation, invocations: finalCommand.invocations })
    const joiningCommand = controlledCommand()
    const joiningLeases: CommandLease[] = []
    const joining = new MemorySampler(literalCommandRuntime(), { ...joiningCommand.witness, lifetime: value => joiningLeases.push(value) },
      { beforeSample() {}, retainSample: async sample => sample })
    componentSamplers.push(joining)
    let joiningReleased = false
    const releaseJoining = () => {
      if (joiningReleased || !joiningCommand.invocations.length) return
      joiningReleased = true
      joiningCommand.at(2000.5); joiningCommand.complete(null, COMMAND_ROW)
      joiningCommand.child.emit('exit', 0, null); joiningCommand.child.stdout.emit('end'); joiningCommand.child.stdout.emit('close')
      joiningCommand.child.stderr.emit('end'); joiningCommand.child.stderr.emit('close'); joiningCommand.child.emit('close', 0, null)
    }
    releaseComponents.push(releaseJoining)
    joining.start(250)
    await expect.poll(() => joiningCommand.invocations.length, { timeout: 5000 }).toBe(1)
    const missedJoin = await joining.stop() // The real original6000ms timer, not a reduced witness budget.
    expect(missedJoin.errors).toEqual(['the in-flight sample did not settle within 6000 ms; no final sample was started while it remains active'])
    expect(joiningCommand.invocations).toHaveLength(1)
    expect(joining.pendingSample()).not.toBeNull()
    releaseJoining(); await joining.pendingSample()
    expect(joining.summary().sampleCount).toBe(1)
    expect(joining.summary().usable).toBe(false)
    expect(joiningCommand.invocations).toHaveLength(1)
    components.variants.push({ originalJoinMiss: missedJoin, afterRelease: joining.summary(), observations: joiningLeases.map(value => value.observation) })
    const cancelledCommand = controlledCommand()
    const cancelledLeases: CommandLease[] = []
    const cancelledSampler = new MemorySampler(literalCommandRuntime(), { ...cancelledCommand.witness, lifetime: value => cancelledLeases.push(value) },
      { beforeSample() {}, retainSample: async sample => sample })
    componentSamplers.push(cancelledSampler)
    const cancellationSample = cancelledSampler.sampleOnce()
    let cancellationReleased = false
    const releaseCancellation = () => {
      if (cancellationReleased) return
      cancellationReleased = true
      cancelledCommand.at(2000.5); cancelledCommand.complete(null, COMMAND_ROW)
      cancelledCommand.child.emit('exit', 0, null); cancelledCommand.child.stdout.emit('end'); cancelledCommand.child.stdout.emit('close')
      cancelledCommand.child.stderr.emit('end'); cancelledCommand.child.stderr.emit('close'); cancelledCommand.child.emit('close', 0, null)
    }
    releaseComponents.push(releaseCancellation)
    cancelledSampler.cancelSampling()
    expect(cancelledLeases[0].cancel().requested).toBe(false) // This literal handle reports the kill request failed.
    expect(cancelledCommand.child.killCalls).toBe(1)
    expect(cancelledLeases[0].observedTerminal()).toBe(false)
    const cancelledStop = await cancelledSampler.stop()
    expect(cancelledCommand.invocations).toHaveLength(1)
    expect(cancelledStop.sampleCount).toBe(0)
    releaseCancellation()
    await cancellationSample; await cancelledLeases[0].terminal
    expect(cancelledLeases[0].observedTerminal()).toBe(true)
    components.variants.push({ failedCancellationCannotInventCloseOrSample: cancelledStop, invocations: cancelledCommand.invocations, killCalls: cancelledCommand.child.killCalls })
    components.completed = true

    const repeated = row('SP11')
    for (const finishKind of ['success', 'timeout'] as const) {
      const control = fixture({ autoClose: false })
      await control.start()
      control.timing.at(2000.125)
      const first = control.owner.stop()
      const second = control.owner.stop(true)
      expect(second).toBe(first)
      await samplerMicrotasks()
      expect(control.requests.filter(r => r.frame.operation === 'stop')).toHaveLength(1)
      expect(control.owner.evidence.finalization).toMatchObject({ escalation: 14000.125, kill: 15500.125, deadline: 17000.125 })
      if (finishKind === 'success') control.close()
      else control.timing.at(17000.125, true)
      const outcome = await first
      expect(outcome.complete).toBe(finishKind === 'success')
      expect(control.owner.stop()).toBe(first)
      expect(control.owner.evidence.finalization!.deadline).toBe(17000.125)
      repeated.variants.push({ finishKind, outcome, stopRequestCount: control.requests.filter(r => r.frame.operation === 'stop').length })
    }
    repeated.completed = true

    const artifacts = row('SP12')
    const original = samplerLiteralArtifact(binding, NONCE)
    expect(validateSamplerArtifact(original, binding, NONCE, process.pid, SAMPLER_FAKE_PID).summary.sampleCount).toBe(1)
    const mutations: { name: string; change: (artifact: SamplerArtifact) => void }[] = [
      { name: 'wrong nested controller PPID (Main R7-WIP-ARTIFACT-IDENTITY-01)', change: a => { a.summary.samples[0].commandObservation!.parent.ppid = process.pid + 1 } },
      { name: 'null command PID with forged terminal lease (Main R7-WIP-ARTIFACT-IDENTITY-01)', change: a => { a.summary.samples[0].commandObservation!.child.pid = null; a.leases[0].pid = null } },
      { name: 'duplicate callback without sticky failure (Main R7-WIP-ARTIFACT-IDENTITY-01)', change: a => {
        const o = a.summary.samples[0].commandObservation!; o.callbackCount = 2; o.laterCallback = structuredClone(o.callback)
      } },
      { name: 'wrong sample count', change: a => { a.summary.sampleCount = 2 } },
      { name: 'wrong peak', change: a => { a.summary.peakRssKiBByPid['4242'] = 0 } },
      { name: 'missing final command lease', change: a => { a.leases = [] } },
      { name: 'workerd identity changed', change: a => { a.binding = structuredClone(a.binding); a.binding.runtime.workerd[0].pid = 4243 } },
      { name: 'sample provenance renamed', change: a => { a.summary.samples[0].phase = 'replacement-phase' } },
      { name: 'missing phases after actual idle acknowledgement (Main R7-WIP-ARTIFACT-PHASE-01)', change: a => {
        a.phases = []
        const s = a.summary.samples[0]
        s.phase = 'start'
        s.provenance!.dispatch.phase = 'start'; s.provenance!.callback!.phase = 'start'; s.provenance!.completion.phase = 'start'
        for (const phase of [s.commandObservation!.dispatchPhase!, s.commandObservation!.callback!.phase!]) {
          phase.text = 'start'; phase.originalBytes = 5; phase.retainedBytes = 5
        }
      } },
      { name: 'changed acknowledged phase name', change: a => { a.phases[0].phase = 'not-acknowledged' } },
      { name: 'changed acknowledged phase acceptance time', change: a => { a.phases[0].at.monotonicMs = 901 } },
      { name: 'missing command close', change: a => { a.summary.samples[0].commandObservation!.child.close = { count: 0, first: null, last: null, omitted: 0 } } },
      { name: 'partial terminal artifact', change: a => { a.complete = false } },
      { name: 'unknown terminal schema field', change: a => { (a as unknown as Record<string, unknown>).replacement = true } },
    ]
    for (const mutation of mutations) {
      const changed = structuredClone(original)
      mutation.change(changed)
      expect(() => validateSamplerArtifact(changed, binding, NONCE, process.pid, SAMPLER_FAKE_PID), mutation.name).toThrow()
      artifacts.variants.push({ name: mutation.name, rejected: true, artifact: changed })
    }
    const statusMutations: { name: string; change: (o: CommandObservation) => void; rejection: RegExp }[] = [
      { name: 'exit1 against callback0 and close0', change: o => { o.child.exit.first!.code = 1; o.child.exit.last!.code = 1 },
        rejection: /command exit\/close status disagreement/ },
      { name: 'close1 against callback0 and exit0', change: o => { o.child.close.first!.code = 1; o.child.close.last!.code = 1 },
        rejection: /command exit\/close status disagreement/ },
      { name: 'both physical statuses1 against successful callback/raw0', change: o => {
        o.child.exit.first!.code = 1; o.child.exit.last!.code = 1; o.child.close.first!.code = 1; o.child.close.last!.code = 1
      }, rejection: /successful callback contradicts command exit\/close status/ },
      { name: 'callback code1 without an error against raw0', change: o => { o.callback!.code = 1 },
        rejection: /callback code\/error status disagreement/ },
      { name: 'callback child exitCode1 against physical success0', change: o => { o.callback!.childFlags!.exitCode = 1 },
        rejection: /successful callback contradicts command callback child flags/ },
    ]
    const originalArtifactBytes = Buffer.byteLength(JSON.stringify(original))
    for (const variant of statusMutations) {
      const changed = structuredClone(original)
      variant.change(changed.summary.samples[0].commandObservation!)
      const originalFacts = JSON.stringify(changed)
      expect(Buffer.byteLength(originalFacts), 'Single-digit contradiction preserves the exact input byte count').toBe(originalArtifactBytes)
      expect(changed.retention).toEqual(original.retention)
      expect(() => validateSamplerArtifact(changed, binding, NONCE, process.pid, SAMPLER_FAKE_PID), variant.name).toThrow(variant.rejection)
      expect(JSON.stringify(changed), 'Qualification retains every contradictory raw fact').toBe(originalFacts)
      artifacts.variants.push({ correction: 'MIR82-R07-03 / ASTRA-CR07-IMPL-01', name: variant.name,
        unchangedBytes: originalArtifactBytes, expectedStatusRejection: variant.rejection.source, artifact: changed })
    }
    const flagMutations: { name: string; change: (o: CommandObservation) => void; rejection: RegExp }[] = [
      { name: 'unknown callback child flags', change: o => { o.callback!.childFlags = null },
        rejection: /successful callback contradicts command callback child flags/ },
      { name: 'callback killed flag contradicts successful exit', change: o => { o.callback!.childFlags!.killed = true },
        rejection: /successful callback contradicts command callback child flags/ },
      { name: 'returned killed flag contradicts successful command', change: o => { o.child.flagsAtReturn!.killed = true },
        rejection: /successful callback contradicts returned command flags/ },
      { name: 'reported maxBuffer failure without callback error', change: o => { o.callback!.output.maxBufferFailureReported = true },
        rejection: /callback error\/output status disagreement/ },
      { name: 'unknown-on-failure output with null callback error', change: o => { o.callback!.output.completeness = 'unknown-on-failure' },
        rejection: /callback error\/output status disagreement/ },
      { name: 'unacquired stdout observer without reported failure', change: o => { o.stdout.attached.data = false },
        rejection: /successful callback lacks acquired command\/stdio observers/ },
      { name: 'signal termination contradicts successful code0', change: o => {
        for (const kind of ['exit', 'close'] as const) for (const position of ['first', 'last'] as const) {
          o.child[kind][position]!.signal = { text: 'SIGTERM', originalBytes: 7, retainedBytes: 7, truncated: false }
        }
      }, rejection: /successful callback contradicts command exit\/close status/ },
    ]
    for (const variant of flagMutations) {
      const changed = structuredClone(original.summary)
      variant.change(changed.samples[0].commandObservation!)
      const originalFacts = JSON.stringify(changed)
      // The public qualifier has no artifact accounting to mask these reasons.
      expect(() => qualifySamplerSummary(changed, binding, SAMPLER_FAKE_PID, original.phases), variant.name).toThrow(variant.rejection)
      expect(JSON.stringify(changed)).toBe(originalFacts)
      artifacts.variants.push({ correction: 'MIR82-R07-03 / ASTRA-CR07-IMPL-01', name: variant.name,
        expectedStatusRejection: variant.rejection.source, rawSummary: changed })
    }
    expect(Object.keys(original.summary.samples[0].commandObservation!.stdout.attached).sort()).toEqual(['close', 'data', 'end', 'error'])
    expect(qualifySamplerSummary(original.summary, binding, SAMPLER_FAKE_PID, original.phases).usable).toBe(true)
    const keyCollision = structuredClone(original.summary)
    keyCollision.samples[0].commandObservation!.stdout.attached = {
      'close|data': true, end: true, error: true,
    } as unknown as CommandObservation['stdout']['attached']
    const collisionFacts = JSON.stringify(keyCollision)
    expect(() => qualifySamplerSummary(keyCollision, binding, SAMPLER_FAKE_PID, original.phases))
      .toThrow(/attached observers has missing or extra fields/)
    expect(JSON.stringify(keyCollision)).toBe(collisionFacts)
    artifacts.variants.push({ correction: 'MIR82-R07-03 schema supplement Main7d0c2c6c/Astra0873b826',
      malformedOwnKeys: ['close|data', 'end', 'error'], requiredOwnKeys: ['close', 'data', 'end', 'error'],
      expectedRejection: 'attached observers has missing or extra fields', rawSummary: keyCollision,
      qualification: 'Direct public summary qualification reaches the exact-key-set guard; no artifact retention mismatch can satisfy this rejection.' })
    const alteredHistory = fixture()
    await alteredHistory.start(); await alteredHistory.owner.phase('idle')
    alteredHistory.changeArtifact(a => {
      const values = [...a.control.sent.values]
      const phaseAck = JSON.parse(values.at(-1)!) as SamplerFrame
      ;(phaseAck.payload.acceptedAt as { monotonicMs: number }).monotonicMs = 901
      values[values.length - 1] = JSON.stringify(phaseAck)
      a.control.sent = samplerLiteralHistory(values)
      a.phases[0].at.monotonicMs = 901
    })
    const alteredHistoryOutcome = await alteredHistory.owner.stop()
    expect(alteredHistoryOutcome.complete).toBe(false)
    expect(alteredHistoryOutcome.evidence.qualificationFailure!.text).toContain('parent-observed pre-terminal frame prefix')
    artifacts.variants.push({ internallyConsistentAlteredAckHistoryRejectedAgainstParentReceipt: alteredHistoryOutcome,
      mainFinding: 'R7-WIP-ARTIFACT-PHASE-01' })
    const directory = await mkdtemp(path.join(os.tmpdir(), 'orbit-sampler-artifact-'))
    directories.push(directory)
    const expectedFile = path.join(directory, 'expected.json')
    const body = Buffer.from('{"literal":"owned-artifact"}')
    const digest = createHash('sha256').update(body).digest('hex')
    await writeFile(expectedFile, body, { flag: 'wx', mode: 0o600 })
    const metadata = { path: expectedFile, bytes: body.length, sha256: digest, complete: true }
    const safe = await readSamplerArtifact(expectedFile, metadata, 6000.25, () => 1000.25)
    expect(safe.body.equals(body)).toBe(true)
    expect(safe.sha256).toBe(digest)
    let openedForeign = false
    await expect(readSamplerArtifact(expectedFile, { ...metadata, path: path.join(directory, 'not-expected.json') }, 6000.25, () => 1000.25,
      { open: (async () => { openedForeign = true; throw new Error('must not open foreign path') }) as unknown as typeof open })).rejects.toThrow(/path mismatch/)
    expect(openedForeign).toBe(false)
    await expect(readSamplerArtifact(expectedFile, { ...metadata, bytes: body.length + 1 }, 6000.25, () => 1000.25)).rejects.toThrow(/size differs/)
    await expect(readSamplerArtifact(expectedFile, { ...metadata, sha256: '0'.repeat(64) }, 6000.25, () => 1000.25)).rejects.toThrow(/SHA256 mismatch/)
    const malformedFile = path.join(directory, 'malformed.json')
    const malformedBody = Buffer.from('{"literal":')
    await writeFile(malformedFile, malformedBody, { flag: 'wx', mode: 0o600 })
    for (const variant of [
      { name: 'wrong digest', path: expectedFile, body, bytes: 28, declared: '0'.repeat(64), failure: 'SHA256 mismatch' },
      { name: 'malformed JSON', path: malformedFile, body: malformedBody, bytes: 11,
        declared: createHash('sha256').update(malformedBody).digest('hex'), failure: 'not complete JSON' },
    ]) {
      const owner = fixture({ artifactPath: variant.path, realArtifactRead: true, autoStop: false })
      await owner.start()
      const stopping = owner.owner.stop()
      const stopId = owner.requests.find(request => request.frame.operation === 'stop')!.frame.requestId
      owner.reply('terminal', 'stop', stopId, { path: variant.path, bytes: variant.bytes, sha256: variant.declared, complete: true })
      owner.close()
      const outcome = await stopping
      const readFailure = owner.readFailure()
      expect(readFailure).toBeInstanceOf(SamplerArtifactReadFailure)
      if (!(readFailure instanceof SamplerArtifactReadFailure)) throw new Error('Safe read failure evidence was not retained')
      expect(readFailure.message).toContain(variant.failure)
      expect(readFailure.safeRead.body.equals(variant.body)).toBe(true)
      expect(readFailure.safeRead.bytes).toBe(variant.bytes)
      expect(readFailure.safeRead.value).toBeNull()
      expect(readFailure.safeRead.descriptor.closedAtMonotonicMs).toBe(1000.25)
      expect(outcome.complete).toBe(false)
      expect(outcome.summary).toBeNull()
      expect(outcome.rawSummary).toBeNull()
      expect(outcome.artifact).toMatchObject({ path: variant.path, bytes: variant.bytes,
        sha256: createHash('sha256').update(variant.body).digest('hex'), descriptor: readFailure.safeRead.descriptor })
      expect(() => owner.owner.assertComplete(outcome)).toThrow()
      const attachments: { name: string; body: Buffer; contentType?: string }[] = []
      await owner.owner.attach({ async attach(name, options) {
        if (!options || !Buffer.isBuffer(options.body)) throw new Error('Safe failure attachment must use retained bytes')
        attachments.push({ name, body: options.body, contentType: options.contentType })
      } }, `literal-safe-failed-${variant.name}`)
      expect(attachments).toHaveLength(1)
      expect(attachments[0].body.equals(variant.body)).toBe(true)
      expect(attachments[0].contentType).toBe('application/json')
      artifacts.variants.push({ name: variant.name, mainFinding: 'R7-WIP-SAFE-READ-EVIDENCE-01', owner: outcome,
        qualificationFailure: readFailure.message, attachedBytes: attachments[0].body.length,
        attachmentSha256: createHash('sha256').update(attachments[0].body).digest('hex') })
    }
    const link = path.join(directory, 'link.json')
    await symlink(expectedFile, link)
    await expect(readSamplerArtifact(link, { ...metadata, path: link }, 6000.25, () => 1000.25)).rejects.toThrow()
    const wrongInode = (async (...args: Parameters<typeof lstat>) => {
      const actualStat = await lstat(args[0], { bigint: true })
      return Object.assign(Object.create(Object.getPrototypeOf(actualStat)), actualStat, { ino: actualStat.ino + 1n })
    }) as unknown as typeof lstat
    const unstableRead = await readSamplerArtifact(expectedFile, metadata, 6000.25, () => 1000.25, { lstat: wrongInode })
      .then(() => null, error => error as unknown)
    expect(String(unstableRead)).toContain('descriptor/path changed')
    expect(unstableRead).not.toBeInstanceOf(SamplerArtifactReadFailure)
    let nonregularClose = 0
    let nonregularRead = 0
    let nonregularFlags = 0
    const nonregularOpen = (async (_path: string, flags: number) => {
      nonregularFlags = flags
      // Literal POSIX FIFO descriptor: open is observable only with NONBLOCK;
      // reading this producer would be an error, never an actual blocking FIFO.
      if ((flags & fsConstants.O_NONBLOCK) === 0) throw new Error('literal FIFO open would wait for a writer')
      return { stat: async () => ({ isFile: () => false }), read: async () => { nonregularRead++; throw new Error('nonregular read forbidden') },
        close: async () => { nonregularClose++ } }
    }) as unknown as typeof open
    await expect(readSamplerArtifact(expectedFile, metadata, 6000.25, () => 1000.25, { open: nonregularOpen })).rejects.toThrow(/private owned regular file/)
    expect(nonregularFlags & fsConstants.O_NONBLOCK).toBe(fsConstants.O_NONBLOCK)
    expect(nonregularFlags & fsConstants.O_NOFOLLOW).toBe(fsConstants.O_NOFOLLOW)
    expect(nonregularRead).toBe(0)
    expect(nonregularClose).toBe(1)
    artifacts.variants.push({ safeOwnedFile: { bytes: safe.bytes, sha256: safe.sha256, descriptor: safe.descriptor }, mismatchedPathOpened: openedForeign,
      nonregular: { producer: 'independent no-writer FIFO open semantics, no FIFO command/probe', flags: nonregularFlags, readCalls: nonregularRead, closeCalls: nonregularClose } })
    artifacts.completed = true

    const bounds = row('SP13')
    for (const size of [65536, 65537]) {
      const wire = new SamplerWire(NONCE, process.pid, SAMPLER_FAKE_PID, 'parent')
      const base = JSON.stringify(wireFrame())
      const payload = base + ' '.repeat(size - Buffer.byteLength(base))
      if (size === 65536) expect(wire.receive(payload)).toMatchObject({ version: 1, sequence: 1 })
      else expect(() => wire.receive(payload)).toThrow(/65536/)
      expect(wire.received.values.every(v => Buffer.byteLength(v) <= 65536)).toBe(true)
      bounds.variants.push({ applicationUtf8Bytes: size, history: wire.received })
    }
    const multibyte = new SamplerWire(NONCE, process.pid, SAMPLER_FAKE_PID, 'parent')
    const splitEuro = 'a'.repeat(65535) + '€'
    expect(Buffer.byteLength(splitEuro)).toBe(65538)
    expect(() => multibyte.receive(splitEuro)).toThrow(/65536/)
    expect(multibyte.received.originalBytes).toBe(65538)
    expect(multibyte.received.retainedBytes).toBe(65535)
    expect(Buffer.byteLength(multibyte.received.values[0])).toBeLessThanOrEqual(65536)
    expect(multibyte.received.retainedBytes).toBeLessThanOrEqual(262144)
    bounds.variants.push({ multibyteBoundary: multibyte.received, mainFinding: 'R7-WIP-UTF8-RETENTION-01' })
    const cumulative = new SamplerWire(NONCE, process.pid, SAMPLER_FAKE_PID, 'parent')
    for (let n = 1; n <= 4; n++) {
      const base = JSON.stringify(wireFrame(n))
      cumulative.receive(base + ' '.repeat(65536 - Buffer.byteLength(base)))
    }
    expect(cumulative.received.retainedBytes).toBe(262144)
    expect(() => cumulative.receive(' ')).toThrow(/262144/)
    expect(cumulative.received.originalBytes).toBe(262145)
    expect(cumulative.received.retainedBytes).toBe(262144)
    const frames = new SamplerWire(NONCE, process.pid, SAMPLER_FAKE_PID, 'parent')
    for (let n = 1; n <= 64; n++) frames.receive(JSON.stringify(wireFrame(n)))
    expect(frames.received.frames).toBe(64)
    expect(() => frames.receive(JSON.stringify(wireFrame(65)))).toThrow(/64 frames/)
    expect(frames.received.values).toHaveLength(64)
    const counts = new SamplerRetention()
    for (let n = 0; n < 8192; n++) counts.account(0)
    expect(counts.records).toBe(8192)
    expect(() => counts.account(0)).toThrow(/8192/)
    expect(counts.records).toBe(8192)
    const exactArtifact = new SamplerRetention()
    exactArtifact.account(130022399)
    expect(exactArtifact.accountedBytes).toBe(134217728)
    const overArtifact = new SamplerRetention()
    expect(() => overArtifact.account(130022400)).toThrow(/134217728/)
    expect(overArtifact.records).toBe(0)
    expect(overArtifact.overflow).toMatchObject({ originalBytes: 134217729, retainedBytes: 4194304 })
    const escaped = new SamplerRetention()
    const escapedLiteral = JSON.stringify({ raw: '\u0000'.repeat(1024) })
    escaped.account(Buffer.byteLength(escapedLiteral))
    expect(Buffer.byteLength(escapedLiteral)).toBe(6154)
    expect(escaped.accountedBytes).toBe(4201483)
    // Independent, already-failed sealing fixture: both bounded raw histories
    // contain rejected NUL payloads, and64 bounded failure descriptions survive.
    // JSON escaping exceeds the original metadata reservation without approaching
    // the absolute128MiB cap. These are data, never actual IPC sends or a usable
    // interval; the expected byte counts below are literal UTF-8 accounting.
    const escapedRawHistory = '\u0000'.repeat(65536)
    const escapedFailure = '\u0000'.repeat(4096)
    const firstSealingFailure = { text: 'literal first failure', originalBytes: 21, retainedBytes: 21, truncated: false }
    const escapingEnvelope: SamplerArtifact = {
      version: 1, session: NONCE,
      binding: { run: 'worker-capacity-000000000000', actor: 'literal', sourceDigest: '1'.repeat(64), planSha256: '2'.repeat(64),
        runtime: { endpoints: { host: '127.0.0.1', devPort: 8790, inspectorPort: 9230, devOrigin: 'http://127.0.0.1:8790', inspectorOrigin: 'http://127.0.0.1:9230' },
          registryPath: '/literal/processes.ndjson', registeredPids: [4242], listeners: [],
          workerd: [{ pid: 4242, ppid: 1, pgid: 4242, started: 'Sat Oct 3 06:00:00 2026', command: 'workerd serve', role: 'owned-runtime', registeredAt: 0, registeredBy: 1 }] },
        artifactPath: '/literal/failed-envelope.json', cadence: 250 },
      parentPid: 620000, childPid: 620001, clocks: { parent: 'literal-parent', child: 'literal-child' }, phases: [],
      control: {
        received: { frames: 4, originalBytes: 262144, retainedBytes: 262144, values: Array(4).fill(escapedRawHistory), overflow: 'literal first protocol failure' },
        sent: { frames: 4, originalBytes: 262144, retainedBytes: 262144, values: Array(4).fill(escapedRawHistory), overflow: 'literal first protocol failure' },
      },
      summary: { unit: 'literal KiB', scope: 'literal failed sealing boundary', owned: [{ pid: 4242, role: 'owned-runtime', command: 'workerd serve' }],
        samples: [{ at: '1970-01-01T00:16:40.000Z', phase: 'idle', processes: [{ pid: 4242, role: 'owned-runtime', rssKiB: null, availability: 'missing-row' }],
          identityProblems: ['literal missing row'], commandError: null, raw: { code: 0, stdout: '', stderr: '' } }],
        sampleCount: 1, validSampleCount: 0, invalidSamples: [{ at: '1970-01-01T00:16:40.000Z', phase: 'idle', problems: ['literal missing row'] }],
        skippedTicks: 0, peakRssKiBByPid: { '4242': null }, errors: ['literal first failure'], usable: false },
      leases: [], retention: { records: 1, accountedBytes: 4195574, terminalReserve: 4194304, leaseReserve: 1024, overflow: null },
      complete: false, failures: { count: 64, retained: [firstSealingFailure, ...Array.from({ length: 63 },
        () => ({ text: escapedFailure, originalBytes: 4096, retainedBytes: 4096, truncated: false }))], omitted: 0 }, terminalOverflow: null,
    }
    expect(Buffer.byteLength(JSON.stringify(escapingEnvelope.summary.samples[0]))).toBe(245)
    expect(Buffer.byteLength(JSON.stringify(escapingEnvelope))).toBe(4700650)
    const sealedOverflow = sealSamplerArtifact(escapingEnvelope)
    expect(sealedOverflow.complete).toBe(false)
    expect(sealedOverflow.body.length).toBe(4700993)
    expect(sealedOverflow.body.length).toBeLessThanOrEqual(134217728)
    expect(createHash('sha256').update(sealedOverflow.body).digest('hex')).toBe('1cd7ad1078a65f7f24491955e704774bd1cfa37741baf19d690fbb0269d8be37')
    expect(sealedOverflow.overflow).toEqual({ reason: 'terminal envelope exceeds its incremental metadata/escaping reservation',
      originalBytes: 4700650, retainedBytes: 4700993, limitBytes: 134217728, accountedBytes: 4195574,
      originalSampleCount: 1, retainedSampleCount: 1, omittedSampleCount: 0, originalInvalidCount: 1, retainedInvalidCount: 1,
      originalLeaseCount: 0, retainedLeaseCount: 0 })
    const failedEnvelope = JSON.parse(sealedOverflow.body.toString('utf8')) as SamplerArtifact
    expect(failedEnvelope.complete).toBe(false)
    expect(failedEnvelope.summary.usable).toBe(false)
    expect(failedEnvelope.summary.samples).toEqual(escapingEnvelope.summary.samples)
    expect(failedEnvelope.failures).toMatchObject({ count: 65, omitted: 1 })
    expect(failedEnvelope.failures.retained).toHaveLength(64)
    expect(failedEnvelope.failures.retained[0]).toEqual(firstSealingFailure)
    expect(() => requireUsableMemory(failedEnvelope.summary)).toThrow()
    expect(escapingEnvelope.terminalOverflow).toBeNull()
    expect(escapingEnvelope.failures.count).toBe(64)
    bounds.variants.push({ mainFinding: 'R7-WIP-TERMINAL-OVERFLOW-EVIDENCE-01', originalBytes: 4700650, retainedBytes: sealedOverflow.body.length,
      sha256: createHash('sha256').update(sealedOverflow.body).digest('hex'), terminalOverflow: sealedOverflow.overflow,
      firstFailure: failedEnvelope.failures.retained[0], retainedSamples: failedEnvelope.summary.samples,
      complete: failedEnvelope.complete, usable: failedEnvelope.summary.usable, failureCount: failedEnvelope.failures.count, omittedDescriptions: failedEnvelope.failures.omitted })
    for (const size of [4096, 4097]) {
      const producer = fixture({ autoClose: false })
      await producer.start()
      producer.reply('fatal', 'initialize', 1, { failure: { text: 'x'.repeat(size), originalBytes: size, retainedBytes: size, truncated: false }, stage: 'active' })
      expect(producer.owner.evidence.failures.count).toBeGreaterThan(0)
      bounds.variants.push({ descriptionBytes: size, interpretation: size === 4096 ? 'valid fatal description still fails the owner' : 'oversized description rejected', evidence: producer.owner.evidence })
      await producer.cleanup()
    }
    for (const size of [65536, 65537]) {
      const producer = fixture({ autoClose: false })
      await producer.start()
      producer.child.stderr.emit('data', Buffer.alloc(size, 120))
      expect(producer.owner.evidence.output.stderr.originalBytes).toBe(size)
      expect(producer.owner.evidence.output.stderr.retainedBytes).toBe(65536)
      expect(producer.owner.evidence.failures.count).toBeGreaterThan(0)
      bounds.variants.push({ unexpectedStderrBytes: size, output: producer.owner.evidence.output.stderr, failedEvenAtCap: true })
      await producer.cleanup()
    }
    bounds.variants.push({ cumulative: cumulative.received, frameCount: frames.received, sampleLimit: counts.evidence(),
      artifactLimit: exactArtifact.evidence(), artifactOverflow: overArtifact.evidence(), escapingBytes: Buffer.byteLength(escapedLiteral), escapingReservation: escaped.evidence(),
      qualification: 'Exact-cap examples test storage predicates only; no truncated or omitted record becomes an accepted interval.' })
    bounds.completed = true

    const closure = row('SP14')
    for (const variant of ['exact-D', 'late-D-before-timer', 'exit-only', 'missing-ipc', 'missing-stdout', 'missing-stderr', 'wrong-exit', 'late-verification'] as const) {
      const control = fixture({ autoClose: false })
      await control.start(); control.timing.at(2000.125)
      if (variant === 'late-verification') control.readAt(17000.375)
      const stopped = control.owner.stop()
      await samplerMicrotasks()
      if (variant === 'exact-D' || variant === 'late-D-before-timer') {
        control.timing.at(variant === 'exact-D' ? 17000.125 : 17000.375, false)
        control.close()
      } else {
        const omit = variant === 'exit-only' ? ['disconnect', 'stdoutEnd', 'stdoutClose', 'stderrEnd', 'stderrClose', 'close']
          : variant === 'missing-ipc' ? ['disconnect'] : variant === 'missing-stdout' ? ['stdoutEnd', 'stdoutClose']
            : variant === 'missing-stderr' ? ['stderrEnd', 'stderrClose'] : []
        control.close(omit, variant === 'wrong-exit' ? 1 : 0)
      }
      await samplerMicrotasks()
      if (!control.owner.evidence.finalization!.settledAt) control.timing.at(17000.125, true)
      const outcome = await stopped
      expect(outcome.complete).toBe(false)
      expect(control.owner.evidence.finalization!.deadline).toBe(17000.125)
      expect(() => control.owner.assertComplete(outcome)).toThrow()
      if (variant === 'late-verification') expect(outcome.evidence.qualificationFailure!.text).toContain('completed after its original deadline')
      closure.variants.push({ variant, original: { T: 2000.125, escalation: 14000.125, kill: 15500.125, D: 17000.125 }, outcome })
    }
    const escalation = fixture({ autoClose: false })
    await escalation.start(); escalation.timing.at(2000.125)
    const escalatedStop = escalation.owner.stop()
    await samplerMicrotasks()
    escalation.timing.at(14000.125, true); await samplerMicrotasks()
    expect(escalation.signals).toEqual([{ pid: SAMPLER_FAKE_PID, signal: 'SIGTERM' }])
    escalation.timing.at(15500.125, true); await samplerMicrotasks()
    expect(escalation.signals).toEqual([{ pid: SAMPLER_FAKE_PID, signal: 'SIGTERM' }, { pid: SAMPLER_FAKE_PID, signal: 'SIGKILL' }])
    escalation.timing.at(16000.125); escalation.close()
    const forced = await escalatedStop
    expect(forced.complete).toBe(false)
    expect(forced.evidence.finalization!.physicalClosed).toBe(true)
    closure.variants.push({ stickyFailureDespiteBeforeDPhysicalClose: forced, signals: escalation.signals })
    for (const finishAt of [13500, 13500.25]) {
      const control = fixture()
      await control.start()
      control.producers.table = async pids => { control.timing.at(finishAt); return control.tables.filter(p => pids.includes(p.pid)) }
      await expect(control.ownership().signal('SIGTERM', 13500)).rejects.toThrow()
      expect(control.signals).toEqual([])
      closure.variants.push({ identityRecheckFinishedAt: finishAt, cutoff: 13500, signals: control.signals, evidence: control.owner.evidence })
      await control.cleanup()
    }
    closure.completed = true

    const independent = row('SP15')
    const ownerA = fixture({ autoClose: false })
    const ownerB = fixture()
    await ownerA.start(); await ownerB.start()
    const originalError = new Error('literal original assertion failure')
    ownerA.child.emit('error', originalError)
    const aStop = ownerA.owner.stop()
    const bStop = ownerB.owner.stop()
    ownerA.tables[0].command = 'replacement-program'
    ownerA.timing.at(ownerA.owner.evidence.finalization!.escalation, true)
    await samplerMicrotasks()
    expect(ownerA.signals).toEqual([])
    const bOutcome = await bStop
    expect(bOutcome.complete).toBe(true)
    expect(bOutcome.evidence.finalization).toMatchObject({ physicalClosed: true, descendantsClosed: true })
    ownerA.timing.at(ownerA.owner.evidence.finalization!.deadline, true)
    const aOutcome = await aStop
    expect(aOutcome.complete).toBe(false)
    expect(aOutcome.evidence.failures.retained[0].text).toContain('literal original assertion failure')
    independent.variants.push({ originalError: String(originalError), ownerA: aOutcome, ownerB: bOutcome, replacementSignals: ownerA.signals })
    independent.completed = true

    const unknown = row('SP16')
    const unreturned = fixture({ launchThrows: true })
    await expect(unreturned.owner.start()).rejects.toThrow(/preload append threw/)
    const unknownOutcome = await unreturned.owner.stop()
    expect(unknownOutcome.complete).toBe(false)
    expect(unknownOutcome.evidence.launch).toMatchObject({ returnedPid: null, ownershipUnknown: true })
    expect(unknownOutcome.evidence.finalization).toMatchObject({ physicalClosed: false, descendantsClosed: false })
    expect(unreturned.signals).toEqual([])
    expect(unreturned.child.killCalls).toEqual([])
    unknown.variants.push({ outcome: unknownOutcome, qualification: 'No returned handle is an explicit unknown acquisition; no locally retained child or timely local closure is claimed. Outer dispatcher obligation remains.' })
    const noPid = fixture({ returnedNoPid: true })
    const noPidStart = noPid.owner.start()
    await expect(noPidStart).rejects.toThrow(/returned child PID unavailable/)
    const noPidStop = noPid.owner.stop()
    expect(noPid.owner.stop(true)).toBe(noPidStop)
    expect(noPid.child.listenerCount('error')).toBe(1)
    expect(noPid.child.listenerCount('exit')).toBe(1)
    expect(noPid.child.listenerCount('close')).toBe(1)
    expect(noPid.child.listenerCount('message')).toBe(1)
    expect(noPid.child.stderr.listenerCount('error')).toBe(1)
    expect(() => noPid.child.emit('error', new Error('literal asynchronous native spawn failure without a returned PID'))).not.toThrow()
    expect(noPid.owner.evidence.launch).toMatchObject({ returnedPid: null, ownershipUnknown: true })
    expect(noPid.owner.evidence.ownership).toBeNull()
    expect(noPid.records).toEqual([])
    expect(noPid.requests).toEqual([])
    // A failed spawn may close acquired pipes without ever emitting exit.
    noPid.close(['exit'], -2)
    expect(noPid.owner.evidence.physical.exit).toBeNull()
    expect(noPid.owner.evidence.physical.close?.code).toBe(-2)
    expect(noPid.owner.evidence.physical.stdoutClose).not.toBeNull()
    expect(noPid.owner.evidence.physical.stderrClose).not.toBeNull()
    expect(noPid.owner.evidence.finalization!.deadline).toBe(16000.25)
    noPid.timing.at(16000.25, true)
    const noPidOutcome = await noPidStop
    expect(noPidOutcome.complete).toBe(false)
    expect(noPidOutcome.evidence.finalization).toMatchObject({ deadline: 16000.25, physicalClosed: false, descendantsClosed: false })
    expect(noPidOutcome.evidence.failures.retained[0].text).toContain('returned child PID unavailable')
    expect(noPidOutcome.evidence.failures.retained.some(item => item.text.includes('literal asynchronous native spawn failure'))).toBe(true)
    expect(noPid.owner.stop()).toBe(noPidStop)
    expect(noPid.signals).toEqual([])
    expect(noPid.child.killCalls).toEqual([])
    unknown.variants.push({ correction: 'MIR82-R07-01 / ASTRA-CR07-IMPL-02', returnedHandleWithoutPid: noPidOutcome,
      qualification: 'Acquired emitters remain observed, but no guessed registry identity, missing exit or descendant closure is supplied.' })
    unknown.completed = true

    const descendants = row('SP17')
    const addLoader = (control: ReturnType<typeof samplerControllerFixture>) => {
      control.records.push({ event: 'spawn', pid: SAMPLER_LOADER_PID, ppid: SAMPLER_FAKE_PID, at: 1_000_000, argv: ['/owned/esbuild', '--service=0.28.2', '--ping'] })
      control.tables.push({ pid: SAMPLER_LOADER_PID, ppid: SAMPLER_FAKE_PID, pgid: SAMPLER_FAKE_PID, started: 'Thu Jan 1 00:16:40 1970', command: '/owned/esbuild --service=0.28.2 --ping' })
    }
    for (const variant of ['unchanged', 'reused', 'unconfirmed', 'already-closed', 'workerd-boundary'] as const) {
      const control = fixture({ autoClose: false })
      await control.start()
      addLoader(control)
      await control.ownership().capture(6000.25)
      expect(control.ownership().evidence.processes.find(p => p.pid === SAMPLER_LOADER_PID)?.identity).toMatchObject({ ppid: SAMPLER_FAKE_PID, command: '/owned/esbuild --service=0.28.2 --ping' })
      expect(control.binding.runtime.workerd.map(p => p.pid)).toEqual([4242])
      if (variant === 'reused') control.tables.find(p => p.pid === SAMPLER_LOADER_PID)!.started = 'Thu Jan 1 00:17:40 1970'
      if (variant === 'unconfirmed') control.producers.table = async () => { throw new Error('literal ownership query unavailable') }
      if (variant === 'already-closed') control.records.push({ event: 'exit', pid: SAMPLER_LOADER_PID, ppid: SAMPLER_FAKE_PID, at: 1_000_001, code: 0, signal: null })
      if (variant === 'workerd-boundary') control.records.push({ event: 'spawn', pid: 4242, ppid: SAMPLER_FAKE_PID, at: 1_000_001, argv: ['workerd', 'serve'] })
      if (variant === 'reused' || variant === 'unconfirmed' || variant === 'workerd-boundary') {
        await expect(control.ownership().signal('SIGTERM', 6000.25)).rejects.toThrow()
        expect(control.signals).toEqual([])
      } else {
        await control.ownership().signal('SIGTERM', 6000.25)
        if (variant === 'unchanged') expect(control.signals).toEqual([{ pid: SAMPLER_LOADER_PID, signal: 'SIGTERM' }, { pid: SAMPLER_FAKE_PID, signal: 'SIGTERM' }])
        else expect(control.signals).toEqual([{ pid: SAMPLER_FAKE_PID, signal: 'SIGTERM' }])
      }
      descendants.variants.push({ variant, signals: control.signals, ownership: control.ownership().evidence })
      await control.cleanup()
    }
    descendants.variants.push({ actualLoaderAncestryAndClosure: actualOutcome.evidence.ownership,
      qualification: 'SP01 actual registered sampler/loader descendants are independently observed by its parent; the literal rows above never signal an OS PID.' })
    descendants.completed = true
    expect(rows.map(value => value.id)).toEqual(['SP01', 'SP02', 'SP03', 'SP04', 'SP05', 'SP06', 'SP07', 'SP08', 'SP09', 'SP10', 'SP11', 'SP12', 'SP13', 'SP14', 'SP15', 'SP16', 'SP17'])
    expect(rows.every(value => value.completed)).toBe(true)
  } catch (error) { primary = { error } }
  await finalizeCase(info, 'instrumentation-owned-sampler-process-witnesses', evidence, primary, [
    { label: 'actual-owned-sampler', run: async () => {
      if (!actual) return 'not acquired'
      const outcome = await actual.stop(Boolean(primary))
      evidence.actualOwnerOutcome = outcome
      await actual.attach(info, 'owned-sampler-witness-terminal-preserved')
      actual.assertComplete(outcome)
      return { physicalClosed: outcome.evidence.finalization!.physicalClosed, descendantsClosed: outcome.evidence.finalization!.descendantsClosed }
    } },
    { label: 'literal-command-release', run: async () => {
      for (const release of releaseComponents) release()
      const outcomes = []
      for (const sampler of componentSamplers) {
        sampler.cancelSampling()
        const pending = sampler.pendingSample()
        if (pending) await pending
        outcomes.push(await sampler.stop())
      }
      return outcomes
    } },
    { label: 'each-literal-owner', run: async () => {
      const outcomes: unknown[] = []
      const failures: unknown[] = []
      for (const control of controls) {
        try { outcomes.push(await control.cleanup()) } catch (error) { failures.push(error) }
      }
      evidence.literalOwnerCleanup = outcomes
      if (failures.length) throw new AggregateError(failures, 'Literal owner cleanup did not settle independently')
      return { count: controls.length, noOsPidsSignalled: true, simulatedClosureOnly: true }
    } },
    { label: 'owned-artifact-directories', run: async () => {
      for (const directory of directories) await rm(directory, { recursive: true, force: true })
      return { removed: directories }
    } },
  ])
}
