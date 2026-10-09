import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { TestInfo } from '@playwright/test'
import { birthOf, execBounded, requireUsableMemory, sampleFromResult, summarizeSamples, validateOwnedEndpoints } from './instrumentation'
import type { BoundedResult, CommandLease, CommandObservation, CommandText, CommandWitness, MemorySample, MemorySummary, OwnedRuntime, ProcessIdentity } from './instrumentation'

/** Remedy07: application payload/retention limits, not a native IPC allocation cap. */
export const SAMPLER_LIMITS = Object.freeze({
  frameBytes: 65_536, frames: 64, directionBytes: 262_144, outputBytes: 65_536,
  descriptionBytes: 4096, samples: 8192, artifactBytes: 134_217_728,
  terminalReserve: 4_194_304, leaseReserve: 1024,
  startupMs: 5000, phaseMs: 5000, cadenceMs: 250,
  escalateMs: 12_000, killMs: 13_500, ownerMs: 15_000,
})
export interface SamplerTime { epochMs: number; monotonicMs: number }
export type SamplerOperation = 'initialize' | 'phase' | 'stop'
export type SamplerKind = 'request' | 'ready' | 'ack' | 'terminal' | 'fatal'
export interface SamplerFrame {
  version: 1; session: string; sequence: number; requestId: number
  kind: SamplerKind; operation: SamplerOperation; senderPid: number
  at: SamplerTime; payload: Record<string, unknown>
}
export interface SamplerBinding {
  run: string; actor: string; sourceDigest: string; planSha256: string
  runtime: OwnedRuntime; artifactPath: string; cadence: 250
}
export interface SamplerPhase { phase: string; at: SamplerTime }
export interface SamplerLeaseFacts {
  sequence: number; pid: number | null; terminal: boolean
  exit: number; close: number; stdoutEnd: number; stdoutClose: number
  stderrEnd: number; stderrClose: number; observerFailures: number
}
export interface SamplerArtifact {
  version: 1; session: string; binding: SamplerBinding
  parentPid: number; childPid: number
  clocks: { parent: string; child: string }
  phases: SamplerPhase[]; control: { received: SamplerHistory; sent: SamplerHistory }
  summary: MemorySummary; leases: SamplerLeaseFacts[]
  retention: { records: number; accountedBytes: number; terminalReserve: number; leaseReserve: number
    overflow: { reason: string; attemptedRecords: number; originalBytes: number | null; retainedBytes: number; preview: CommandText | null } | null }
  complete: boolean; failures: SamplerFailureEvidence
  terminalOverflow: SamplerTerminalOverflow | null
}
export interface SamplerTerminalOverflow {
  reason: string; originalBytes: number; retainedBytes: number; limitBytes: number; accountedBytes: number
  originalSampleCount: number; retainedSampleCount: number; omittedSampleCount: number
  originalInvalidCount: number; retainedInvalidCount: number
  originalLeaseCount: number; retainedLeaseCount: number
}
export interface SamplerFailureEvidence { count: number; retained: CommandText[]; omitted: number }
export interface SamplerHistory { frames: number; originalBytes: number; retainedBytes: number; values: string[]; overflow: string | null }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const SHA256 = /^[0-9a-f]{64}$/
const positive = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) > 0
const count = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) >= 0
const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n)
export function samplerAssert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(`owned sampler: ${message}`)
}
function record(value: unknown, keys: readonly string[], label: string): Record<string, any> {
  samplerAssert(value !== null && typeof value === 'object' && !Array.isArray(value), `${label} is not a record`)
  const result = value as Record<string, any>
  const actual = Object.keys(result).sort()
  const expected = [...keys].sort()
  samplerAssert(actual.length === expected.length && actual.every((key, index) => key === expected[index]), `${label} has missing or extra fields`)
  return result
}
function list(value: unknown, max: number, label: string): any[] {
  samplerAssert(Array.isArray(value) && value.length <= max, `${label} is not a bounded array`)
  return value
}
function text(value: unknown, max: number, label: string, empty = false): asserts value is string {
  samplerAssert(typeof value === 'string' && (empty || value.length > 0) && Buffer.byteLength(value, 'utf8') <= max, `${label} is not bounded UTF-8 text`)
}
function utf8Prefix(original: string, budget: number): string {
  let retained = ''
  let retainedBytes = 0
  for (const character of original) {
    const bytes = Buffer.byteLength(character)
    if (retainedBytes + bytes > budget) break
    retained += character; retainedBytes += bytes
  }
  return retained
}
export function samplerDescription(value: unknown): CommandText {
  const original = String(value)
  const originalBytes = Buffer.byteLength(original)
  const retained = utf8Prefix(original, SAMPLER_LIMITS.descriptionBytes)
  const retainedBytes = Buffer.byteLength(retained)
  return { text: retained, originalBytes, retainedBytes, truncated: originalBytes > retainedBytes }
}
export class SamplerFailures {
  readonly evidence: SamplerFailureEvidence = { count: 0, retained: [], omitted: 0 }
  add(error: unknown): void {
    this.evidence.count = Math.min(Number.MAX_SAFE_INTEGER, this.evidence.count + 1)
    if (this.evidence.retained.length < 64) this.evidence.retained.push(samplerDescription(error))
    else this.evidence.omitted++
  }
}
export function samplerTime(now = performance.now(), wall = Date.now()): SamplerTime {
  samplerAssert(finite(now) && now >= 0 && finite(wall) && Number.isFinite(new Date(wall).getTime()), 'invalid clock')
  return { monotonicMs: now, epochMs: wall }
}
function validateTime(value: unknown, label: string): SamplerTime {
  const at = record(value, ['epochMs', 'monotonicMs'], label)
  return samplerTime(at.monotonicMs, at.epochMs)
}
function validateDescription(value: unknown, label: string): void {
  const entry = record(value, ['text', 'originalBytes', 'retainedBytes', 'truncated'], label)
  text(entry.text, 4096, label, true)
  samplerAssert(count(entry.originalBytes) && entry.retainedBytes === Buffer.byteLength(entry.text)
    && entry.originalBytes >= entry.retainedBytes && entry.truncated === (entry.originalBytes > entry.retainedBytes), `${label} byte accounting`)
}
export class SamplerWire {
  readonly sent: SamplerHistory = { frames: 0, originalBytes: 0, retainedBytes: 0, values: [], overflow: null }
  readonly received: SamplerHistory = { frames: 0, originalBytes: 0, retainedBytes: 0, values: [], overflow: null }
  private sendSequence = 0
  private receiveSequence = 0
  constructor(readonly session: string, readonly pid: number, readonly peerPid: number, readonly side: 'parent' | 'child', private readonly clock = () => samplerTime()) {
    samplerAssert(UUID.test(session) && positive(pid) && positive(peerPid), 'invalid wire identity')
  }
  private retain(history: SamplerHistory, value: unknown): string {
    const raw = typeof value === 'string' ? value : `[nonstring ${value === null ? 'null' : typeof value}]`
    const bytes = Buffer.byteLength(raw)
    history.frames = Math.min(Number.MAX_SAFE_INTEGER, history.frames + 1)
    history.originalBytes = Math.min(Number.MAX_SAFE_INTEGER, history.originalBytes + bytes)
    const remaining = Math.max(0, SAMPLER_LIMITS.directionBytes - history.retainedBytes)
    if (history.values.length < SAMPLER_LIMITS.frames && remaining) {
      // Store bytes only within both history bounds, including the first bad frame.
      // No full Buffer copy and no replacement-character expansion on a split
      // codepoint. Both the individual and cumulative caps apply on failure.
      const retained = utf8Prefix(raw, Math.min(remaining, SAMPLER_LIMITS.frameBytes))
      history.values.push(retained); history.retainedBytes += Buffer.byteLength(retained)
    }
    const failure = typeof value !== 'string' ? 'nonstring IPC payload'
      : bytes > SAMPLER_LIMITS.frameBytes ? 'IPC application payload exceeds65536 bytes'
        : history.frames > SAMPLER_LIMITS.frames ? 'IPC direction exceeds64 frames'
          : history.originalBytes > SAMPLER_LIMITS.directionBytes ? 'IPC direction exceeds262144 bytes' : null
    if (failure) { history.overflow ??= failure; throw new Error(`owned sampler: ${failure}`) }
    return raw
  }
  encode(kind: SamplerKind, operation: SamplerOperation, payload: Record<string, unknown>, requestId?: number): { raw: string; frame: SamplerFrame } {
    const sequence = ++this.sendSequence
    const frame: SamplerFrame = { version: 1, session: this.session, sequence, requestId: requestId ?? sequence, kind, operation, senderPid: this.pid, at: this.clock(), payload }
    validateSamplerFrame(frame, this.side)
    const raw = this.retain(this.sent, JSON.stringify(frame))
    return { raw, frame }
  }
  receive(value: unknown): SamplerFrame {
    const raw = this.retain(this.received, value)
    let frame: unknown
    try { frame = JSON.parse(raw) } catch { throw new Error('owned sampler: malformed application JSON') }
    validateSamplerFrame(frame, this.side === 'parent' ? 'child' : 'parent')
    samplerAssert(frame.session === this.session && frame.senderPid === this.peerPid, 'wrong session or sender PID')
    samplerAssert(frame.sequence === this.receiveSequence + 1, 'duplicate, gap or out-of-order sequence')
    this.receiveSequence = frame.sequence
    return frame
  }
}
export function validateSamplerFrame(value: unknown, sender: 'parent' | 'child'): asserts value is SamplerFrame {
  const frame = record(value, ['version', 'session', 'sequence', 'requestId', 'kind', 'operation', 'senderPid', 'at', 'payload'], 'frame')
  samplerAssert(frame.version === 1 && typeof frame.session === 'string' && UUID.test(frame.session)
    && positive(frame.sequence) && count(frame.requestId) && positive(frame.senderPid), 'invalid frame identity/counters')
  validateTime(frame.at, 'frame.at')
  samplerAssert(['initialize', 'phase', 'stop'].includes(frame.operation), 'unknown operation')
  samplerAssert(frame.payload !== null && typeof frame.payload === 'object' && !Array.isArray(frame.payload), 'invalid payload record')
  if (sender === 'parent') {
    samplerAssert(frame.kind === 'request' && frame.requestId === frame.sequence, 'invalid parent kind/requestId')
    if (frame.operation === 'initialize') validateSamplerBinding(frame.payload)
    else if (frame.operation === 'phase') {
      const p = record(frame.payload, ['phase'], 'phase payload'); text(p.phase, 128, 'phase')
    } else samplerAssert(typeof record(frame.payload, ['cancel'], 'stop payload').cancel === 'boolean', 'invalid cancel flag')
  } else {
    samplerAssert(['ready', 'ack', 'terminal', 'fatal'].includes(frame.kind), 'invalid child kind')
    if (frame.kind === 'ready') {
      const p = record(frame.payload, ['controlReady', 'parentPid'], 'ready payload')
      samplerAssert(frame.operation === 'initialize' && frame.requestId === 0 && p.controlReady === true && positive(p.parentPid), 'invalid ready substate')
    } else if (frame.kind === 'terminal') {
      const p = record(frame.payload, ['path', 'bytes', 'sha256', 'complete'], 'terminal payload')
      text(p.path, 4096, 'terminal path')
      samplerAssert(frame.operation === 'stop' && positive(frame.requestId) && positive(p.bytes) && SHA256.test(p.sha256) && typeof p.complete === 'boolean', 'invalid terminal payload')
    } else if (frame.kind === 'fatal') {
      const p = record(frame.payload, ['failure', 'stage'], 'fatal payload')
      validateDescription(p.failure, 'fatal failure'); text(p.stage, 128, 'fatal stage')
    } else {
      samplerAssert(positive(frame.requestId) && frame.operation !== 'stop', 'invalid acknowledgement')
      if (frame.operation === 'initialize') {
        const p = record(frame.payload, ['binding', 'cadenceStarted', 'acceptedAt'], 'initialize acknowledgement')
        validateSamplerBinding(p.binding); validateTime(p.acceptedAt, 'initialize acceptedAt')
        samplerAssert(p.cadenceStarted === true, 'cadence did not start')
      } else {
        const p = record(frame.payload, ['phase', 'acceptedAt'], 'phase acknowledgement')
        text(p.phase, 128, 'accepted phase'); validateTime(p.acceptedAt, 'phase acceptedAt')
      }
    }
  }
}
export function validateSamplerBinding(value: unknown): asserts value is SamplerBinding {
  const b = record(value, ['run', 'actor', 'sourceDigest', 'planSha256', 'runtime', 'artifactPath', 'cadence'], 'binding')
  text(b.run, 128, 'run'); text(b.actor, 4096, 'actor'); text(b.artifactPath, 4096, 'artifact path')
  samplerAssert(SHA256.test(b.sourceDigest) && SHA256.test(b.planSha256) && path.isAbsolute(b.artifactPath) && b.cadence === 250, 'invalid source/plan/path/cadence')
  const runtime = record(b.runtime, ['endpoints', 'registryPath', 'registeredPids', 'listeners', 'workerd'], 'runtime')
  text(runtime.registryPath, 4096, 'registry path')
  const endpoints = record(runtime.endpoints, ['host', 'devPort', 'inspectorPort', 'devOrigin', 'inspectorOrigin'], 'endpoints')
  samplerAssert(JSON.stringify(endpoints) === JSON.stringify(validateOwnedEndpoints(endpoints.devOrigin, endpoints.inspectorPort)), 'noncanonical runtime endpoints')
  const registered = list(runtime.registeredPids, 65_536, 'registered PIDs')
  samplerAssert(registered.every(positive) && new Set(registered).size === registered.length, 'invalid registered PID set')
  const workerd = list(runtime.workerd, 64, 'workerd')
  samplerAssert(workerd.length > 0 && new Set(workerd.map(p => p.pid)).size === workerd.length, 'empty/duplicate workerd set')
  for (const item of workerd) {
    const p = record(item, ['pid', 'ppid', 'pgid', 'started', 'command', 'role', 'registeredAt', 'registeredBy'], 'owned workerd')
    samplerAssert([p.pid, p.ppid, p.pgid, p.registeredBy].every(positive) && registered.includes(p.pid) && p.ppid === p.registeredBy
      && finite(p.registeredAt) && Number.isFinite(birthOf(p as ProcessIdentity)) && ['proxy-listener', 'owned-runtime'].includes(p.role), 'invalid workerd ownership')
    text(p.command, 16_384, 'workerd command'); text(p.started, 128, 'workerd birth')
  }
  for (const item of list(runtime.listeners, 2, 'listeners')) {
    const listener = record(item, ['port', 'pids'], 'listener')
    samplerAssert([endpoints.devPort, endpoints.inspectorPort].includes(listener.port)
      && list(listener.pids, 64, 'listener PIDs').every(pid => positive(pid) && registered.includes(pid)), 'invalid listener ownership')
  }
}
/** One incremental finalized record plus a bounded unfinalized16MiB command. */
export class SamplerRetention {
  records = 0
  accountedBytes: number = SAMPLER_LIMITS.terminalReserve
  overflow: SamplerArtifact['retention']['overflow'] = null
  beforeSample(): void {
    if (this.records >= SAMPLER_LIMITS.samples) {
      this.overflow ??= { reason: 'retained samples would exceed8192; required sample cannot be omitted', attemptedRecords: this.records + 1,
        originalBytes: null, retainedBytes: this.accountedBytes, preview: null }
      throw new Error(`owned sampler: ${this.overflow.reason}`)
    }
  }
  account(serializedBytes: number, preview?: string): void {
    samplerAssert(count(serializedBytes), 'invalid record accounting')
    this.beforeSample()
    const next = this.accountedBytes + serializedBytes + SAMPLER_LIMITS.leaseReserve + 1
    if (next > SAMPLER_LIMITS.artifactBytes) {
      this.overflow ??= { reason: 'incremental artifact retention exceeds134217728 bytes', attemptedRecords: this.records + 1,
        originalBytes: next, retainedBytes: this.accountedBytes, preview: preview === undefined ? null : samplerDescription(preview) }
      throw new Error(`owned sampler: ${this.overflow.reason}`)
    }
    this.records++; this.accountedBytes = next
  }
  evidence() { return { records: this.records, accountedBytes: this.accountedBytes, terminalReserve: SAMPLER_LIMITS.terminalReserve, leaseReserve: SAMPLER_LIMITS.leaseReserve, overflow: this.overflow } }
}
export function samplerLeaseFacts(lease: CommandLease): SamplerLeaseFacts {
  const o = lease.observation
  return { sequence: o.sequence, pid: o.child.pid, terminal: lease.observedTerminal(), exit: o.child.exit.count, close: o.child.close.count,
    stdoutEnd: o.stdout.end.count, stdoutClose: o.stdout.close.count, stderrEnd: o.stderr.end.count, stderrClose: o.stderr.close.count, observerFailures: o.observerFailures.count }
}

export class SamplerTerminalPreservationFailure extends Error {
  readonly overflow: SamplerTerminalOverflow
  constructor(available: SamplerTerminalOverflow) {
    const unwritten = { ...available, retainedBytes: 0, retainedSampleCount: 0, omittedSampleCount: available.originalSampleCount,
      retainedInvalidCount: 0, retainedLeaseCount: 0 }
    super(`owned sampler: failed terminal evidence could not fit safely; no artifact written; candidateBytes=${available.retainedBytes}; ${JSON.stringify(unwritten)}`)
    this.name = 'SamplerTerminalPreservationFailure'
    this.overflow = unwritten
  }
}
/** Called only after sampling stopped and command observations are final/failed. */
export function sealSamplerArtifact(artifact: SamplerArtifact): { body: Buffer; complete: boolean; overflow: SamplerTerminalOverflow | null } {
  const candidate = JSON.stringify(artifact)
  const originalBytes = Buffer.byteLength(candidate)
  if (originalBytes <= SAMPLER_LIMITS.artifactBytes && originalBytes <= artifact.retention.accountedBytes) {
    return { body: Buffer.from(candidate), complete: artifact.complete, overflow: null }
  }
  const reason = originalBytes > SAMPLER_LIMITS.artifactBytes
    ? 'terminal envelope exceeds134217728 bytes' : 'terminal envelope exceeds its incremental metadata/escaping reservation'
  const overflow: SamplerTerminalOverflow = {
    reason, originalBytes, retainedBytes: 0, limitBytes: 134217728, accountedBytes: artifact.retention.accountedBytes,
    originalSampleCount: artifact.summary.samples.length, retainedSampleCount: artifact.summary.samples.length, omittedSampleCount: 0,
    originalInvalidCount: artifact.summary.invalidSamples.length, retainedInvalidCount: artifact.summary.invalidSamples.length,
    originalLeaseCount: artifact.leases.length, retainedLeaseCount: artifact.leases.length,
  }
  const failures: SamplerFailureEvidence = { count: artifact.failures.count + 1, retained: [...artifact.failures.retained], omitted: artifact.failures.omitted }
  if (failures.retained.length < 64) failures.retained.push(samplerDescription(reason))
  else failures.omitted++
  const partial: SamplerArtifact = { ...artifact, complete: false, failures, terminalOverflow: overflow,
    summary: { ...artifact.summary, usable: false } }
  // A reservation failure within the absolute cap can preserve every byte-bearing
  // observation. It remains failed even when no sample needs omission.
  const withSize = () => {
    overflow.retainedBytes = 0
    const initial = JSON.stringify(partial)
    const initialBytes = Buffer.byteLength(initial)
    let finalBytes = initialBytes
    for (let attempt = 0; attempt < 4; attempt++) finalBytes = initialBytes - 1 + String(finalBytes).length
    overflow.retainedBytes = finalBytes
    const serialized = JSON.stringify(partial)
    samplerAssert(Buffer.byteLength(serialized) === finalBytes, 'partial envelope byte accounting disagrees')
    return serialized
  }
  let serialized = withSize()
  if (overflow.retainedBytes > SAMPLER_LIMITS.artifactBytes) {
    // Prefer original raw samples over the duplicate invalid-sample problem list.
    // Counts retain their original meaning and explicit omission fields prevent
    // this partial prefix from ever becoming a complete usable interval.
    partial.summary = { ...partial.summary, samples: [], invalidSamples: [] }
    partial.leases = []
    overflow.retainedSampleCount = 0; overflow.omittedSampleCount = overflow.originalSampleCount
    overflow.retainedInvalidCount = 0; overflow.retainedLeaseCount = 0
    const fixed = Buffer.byteLength(JSON.stringify(partial)) + 4096
    if (fixed > SAMPLER_LIMITS.artifactBytes) throw new SamplerTerminalPreservationFailure(overflow)
    let retainedBytes = fixed
    const leasesBySequence = new Map(artifact.leases.map(value => [value.sequence, value]))
    for (const sample of artifact.summary.samples) {
      const lease = sample.commandObservation ? leasesBySequence.get(sample.commandObservation.sequence) : undefined
      const bytes = Buffer.byteLength(JSON.stringify(sample)) + (lease ? Buffer.byteLength(JSON.stringify(lease)) : 0) + 2
      if (retainedBytes + bytes > SAMPLER_LIMITS.artifactBytes) break
      partial.summary.samples.push(sample)
      if (lease) partial.leases.push(lease)
      retainedBytes += bytes
    }
    overflow.retainedSampleCount = partial.summary.samples.length
    overflow.omittedSampleCount = overflow.originalSampleCount - overflow.retainedSampleCount
    overflow.retainedLeaseCount = partial.leases.length
    serialized = withSize()
    if (overflow.retainedBytes > SAMPLER_LIMITS.artifactBytes) throw new SamplerTerminalPreservationFailure(overflow)
  }
  return { body: Buffer.from(serialized), complete: false, overflow }
}

function validateCommandTime(value: unknown, label: string): void {
  const at = record(value, ['epochMs', 'monotonicMs'], label)
  samplerAssert((at.epochMs === null || (finite(at.epochMs) && Number.isFinite(new Date(at.epochMs).getTime())))
    && (at.monotonicMs === null || (finite(at.monotonicMs) && at.monotonicMs >= 0)), `invalid ${label}`)
}
function validateMark(value: unknown, label: string, extras: string[] = []): Record<string, any> {
  const mark = record(value, ['order', 'at', ...extras], label)
  samplerAssert(positive(mark.order), `${label} order`); validateCommandTime(mark.at, label)
  return mark
}
function validateError(value: unknown): void {
  if (value === null) return
  const error = record(value, ['text', 'code', 'signal', 'killed'], 'command error')
  for (const k of ['text', 'signal']) if (error[k] !== null) validateDescription(error[k], k)
  if (error.code !== null && !Number.isSafeInteger(error.code)) validateDescription(error.code, 'error code')
  samplerAssert(error.killed === null || typeof error.killed === 'boolean', 'error killed flag')
}
function validateEvents(value: unknown, validate: (entry: unknown) => void): void {
  const event = record(value, ['count', 'first', 'last', 'omitted'], 'events')
  samplerAssert(count(event.count) && event.omitted === Math.max(0, event.count - 2), 'event counts')
  if (!event.count) samplerAssert(event.first === null && event.last === null, 'empty event holders')
  else { validate(event.first); validate(event.last) }
}
function validateFlags(value: unknown): void {
  if (value === null) return
  const flags = record(value, ['killed', 'exitCode', 'signalCode'], 'child flags')
  samplerAssert(flags.killed === null || typeof flags.killed === 'boolean', 'child killed flag')
  samplerAssert(flags.exitCode === null || Number.isSafeInteger(flags.exitCode), 'child exit code')
  if (flags.signalCode !== null) validateDescription(flags.signalCode, 'child signal')
}
function validateObservation(value: unknown, binding: SamplerBinding, childPid: number, parentPid: number): asserts value is CommandObservation {
  const o = record(value, ['version', 'sequence', 'file', 'argv', 'parent', 'timeoutMs', 'killSignal', 'maxBuffer', 'startedAt', 'deadline', 'dispatchPhase', 'callbackCount', 'callback', 'laterCallback', 'settlements', 'invocationFailure', 'child', 'stdout', 'stderr', 'observerFailures', 'available'], 'command observation')
  samplerAssert(o.version === 1 && positive(o.sequence) && o.timeoutMs === 5000 && o.killSignal === 'SIGKILL' && o.maxBuffer === 16_777_216, 'command contract changed')
  validateDescription(o.file, 'command file'); validateDescription(o.argv, 'command argv')
  samplerAssert(o.file.text === 'ps' && !o.file.truncated && !o.argv.truncated
    && o.argv.text === JSON.stringify(['-o', 'pid=,ppid=,pgid=,lstart=,rss=,command=', '-p', binding.runtime.workerd.map(p => p.pid).join(',')]), 'command is not the exact owned RSS acquisition')
  const parent = record(o.parent, ['pid', 'ppid', 'actor', 'registry', 'run'], 'command parent')
  samplerAssert(parent.pid === childPid && parent.ppid === parentPid && positive(parentPid), 'command parent PID/PPID binding')
  for (const [key, expected] of [['actor', binding.actor], ['registry', binding.runtime.registryPath], ['run', binding.run]] as const) {
    validateDescription(parent[key], key); samplerAssert(parent[key].text === expected && !parent[key].truncated, `command ${key} binding`)
  }
  validateCommandTime(o.startedAt, 'command start')
  samplerAssert(o.deadline === (o.startedAt.monotonicMs === null ? null : o.startedAt.monotonicMs + 5000), 'renewed command deadline')
  if (o.dispatchPhase !== null) validateDescription(o.dispatchPhase, 'dispatch phase')
  samplerAssert(count(o.callbackCount) && count(o.settlements) && o.settlements <= 1, 'command settlement counters')
  validateError(o.invocationFailure)
  const child = record(o.child, ['acquired', 'pid', 'flagsAtReturn', 'exit', 'close', 'error'], 'command child')
  samplerAssert(typeof child.acquired === 'boolean' && (child.pid === null || positive(child.pid)), 'command child identity')
  validateFlags(child.flagsAtReturn)
  for (const kind of ['exit', 'close']) validateEvents(child[kind], entry => {
    const e = validateMark(entry, kind, ['code', 'signal'])
    samplerAssert(e.code === null || Number.isSafeInteger(e.code), 'exit/close code')
    if (e.signal !== null) validateDescription(e.signal, 'exit/close signal')
  })
  const errorEvent = (entry: unknown) => { const e = validateMark(entry, 'error event', ['error']); validateError(e.error) }
  validateEvents(child.error, errorEvent)
  for (const name of ['stdout', 'stderr']) {
    const stream = record(o[name], ['present', 'attached', 'data', 'end', 'close', 'error'], name)
    samplerAssert(stream.present === null || typeof stream.present === 'boolean', 'pipe presence')
    const attached = record(stream.attached, ['data', 'end', 'close', 'error'], 'attached observers')
    samplerAssert(Object.values(attached).every(v => typeof v === 'boolean'), 'observer attachment flags')
    const data = record(stream.data, ['count', 'decodedUtf8Bytes', 'bufferBytes', 'unknownChunks', 'first', 'last'], 'pipe data')
    samplerAssert(['count', 'decodedUtf8Bytes', 'bufferBytes', 'unknownChunks'].every(k => count(data[k])), 'pipe data counts')
    if (data.count) { validateMark(data.first, 'first data'); validateMark(data.last, 'last data') }
    else samplerAssert(data.first === null && data.last === null, 'empty data marks')
    for (const kind of ['end', 'close']) validateEvents(stream[kind], entry => { validateMark(entry, kind) })
    validateEvents(stream.error, errorEvent)
  }
  validateEvents(o.observerFailures, entry => {
    const failure = record(entry, ['source', 'error'], 'observer failure')
    validateDescription(failure.source, 'failure source'); if (failure.error !== null) validateDescription(failure.error, 'failure error')
  })
  for (const name of ['callback', 'laterCallback']) if (o[name] !== null) {
    const cb = validateMark(o[name], name, ['phase', 'error', 'code', 'childFlags', 'observedAtCallback', 'output'])
    if (cb.phase !== null) validateDescription(cb.phase, 'callback phase')
    validateError(cb.error); validateFlags(cb.childFlags)
    if (cb.code !== null && !Number.isSafeInteger(cb.code)) validateDescription(cb.code, 'callback code')
    const seen = record(cb.observedAtCallback, ['exit', 'close', 'stdoutEnd', 'stdoutClose', 'stderrEnd', 'stderrClose', 'observerFailures'], 'callback observations')
    samplerAssert(Object.values(seen).every(count), 'callback observation counts')
    const out = record(cb.output, ['stdoutDecodedUtf8Bytes', 'stderrDecodedUtf8Bytes', 'maxBufferFailureReported', 'completeness'], 'callback output')
    samplerAssert([out.stdoutDecodedUtf8Bytes, out.stderrDecodedUtf8Bytes].every(n => n === null || count(n))
      && typeof out.maxBufferFailureReported === 'boolean' && ['not-reported-incomplete', 'unknown-on-failure'].includes(out.completeness), 'callback output facts')
  }
  const at = o.callback?.at.monotonicMs
  const available = at != null && o.deadline !== null && finite(o.deadline)
    && at >= o.startedAt.monotonicMs && at <= o.deadline && !o.observerFailures.count && o.invocationFailure === null
    && !child.error.count && !o.stdout.error.count && !o.stderr.error.count
  samplerAssert(o.available === available, 'supplied available flag contradicts original timing/observers')
  samplerAssert((o.callbackCount === 0) === (o.callback === null) && (o.callbackCount > 1) === (o.laterCallback !== null), 'callback holders/counts disagree')
}
/** Schema and cross-field verification precede the unchanged complete-summary check. */
export function qualifySamplerSummary(value: unknown, binding: SamplerBinding, childPid: number, phases: SamplerPhase[], parentPid = process.pid): MemorySummary {
  const summary = record(value, ['unit', 'scope', 'owned', 'samples', 'sampleCount', 'validSampleCount', 'invalidSamples', 'skippedTicks', 'peakRssKiBByPid', 'errors', 'usable'], 'memory summary') as unknown as MemorySummary
  const owned = binding.runtime.workerd.map(p => ({ pid: p.pid, role: p.role, command: p.command }))
  samplerAssert(JSON.stringify(summary.owned) === JSON.stringify(owned), 'summary owned set changed')
  samplerAssert(count(summary.skippedTicks), 'invalid coalesced tick count')
  for (const error of list(summary.errors, 64, 'sampler errors')) text(error, 4096, 'sampler error', true)
  const samples = list(summary.samples, SAMPLER_LIMITS.samples, 'samples') as MemorySample[]
  let previousSequence = 0
  let previousTerminal = -1
  const phaseAt = (time: number) => phases.filter(p => p.at.monotonicMs <= time).at(-1)?.phase ?? 'start'
  for (const sample of samples) {
    const s = record(sample, ['at', 'phase', 'processes', 'identityProblems', 'commandError', 'raw', 'commandObservation', 'provenance'], 'sample')
    text(s.at, 128, 'sample time'); text(s.phase, 128, 'sample phase')
    samplerAssert(s.commandError === null || typeof s.commandError === 'string', 'command error text')
    const raw = record(s.raw, ['code', 'stdout', 'stderr'], 'raw result')
    samplerAssert(raw.code === null || Number.isSafeInteger(raw.code), 'raw result code')
    text(raw.stdout, 16_777_216, 'raw stdout', true); text(raw.stderr, 16_777_216, 'raw stderr', true)
    validateObservation(s.commandObservation, binding, childPid, parentPid)
    const o = s.commandObservation
    samplerAssert(o.child.acquired && positive(o.child.pid) && o.child.pid !== childPid && o.child.pid !== parentPid
      && !binding.runtime.workerd.some(p => p.pid === o.child.pid), 'complete acquisition has no positive distinct retained command PID')
    samplerAssert(o.sequence > previousSequence, 'duplicate/out-of-order acquisition'); previousSequence = o.sequence
    const cb = o.callback
    samplerAssert(cb && o.settlements === 1, 'missing original command settlement')
    const callbackCode = cb.error === null ? 0 : cb.error.code
    samplerAssert(JSON.stringify(cb.code) === JSON.stringify(callbackCode), 'callback code/error status disagreement')
    const expectedCode = cb.error === null ? 0 : cb.error.killed === true ? null : typeof cb.error.code === 'number' ? cb.error.code : null
    samplerAssert(raw.code === expectedCode && cb.output.stdoutDecodedUtf8Bytes === Buffer.byteLength(raw.stdout)
      && cb.output.stderrDecodedUtf8Bytes === Buffer.byteLength(raw.stderr), 'raw result/callback disagreement')
    const maxBufferFailure = callbackCode !== null && typeof callbackCode === 'object' && callbackCode.text === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
    samplerAssert(cb.output.maxBufferFailureReported === maxBufferFailure
      && cb.output.completeness === (cb.error === null ? 'not-reported-incomplete' : 'unknown-on-failure'), 'callback error/output status disagreement')
    samplerAssert(o.callbackCount <= 1 || o.observerFailures.count > 0, 'duplicate callback lost its sticky observer failure')
    samplerAssert(o.startedAt.monotonicMs !== null && o.startedAt.monotonicMs >= previousTerminal, 'overlapping serialized command acquisitions')
    samplerAssert(cb.observedAtCallback.exit <= o.child.exit.count && cb.observedAtCallback.close <= o.child.close.count
      && cb.observedAtCallback.stdoutEnd <= o.stdout.end.count && cb.observedAtCallback.stdoutClose <= o.stdout.close.count
      && cb.observedAtCallback.stderrEnd <= o.stderr.end.count && cb.observedAtCallback.stderrClose <= o.stderr.close.count
      && cb.observedAtCallback.observerFailures <= o.observerFailures.count, 'callback observed counters exceed final observations')
    const provenance = record(s.provenance, ['dispatch', 'callback', 'completion'], 'sample provenance')
    for (const key of ['dispatch', 'callback', 'completion']) {
      const p = record(provenance[key], ['phase', 'at'], `${key} provenance`)
      validateTime(p.at, key)
      samplerAssert(p.phase === phaseAt(p.at.monotonicMs), `${key} phase was not active in the child clock domain`)
    }
    samplerAssert(JSON.stringify(provenance.dispatch.at) === JSON.stringify(o.startedAt)
      && provenance.dispatch.phase === o.dispatchPhase?.text
      && JSON.stringify(provenance.callback.at) === JSON.stringify(cb.at)
      && provenance.callback.phase === cb.phase?.text
      && provenance.dispatch.at.monotonicMs <= provenance.callback.at.monotonicMs
      && provenance.callback.at.monotonicMs <= provenance.completion.at.monotonicMs
      && s.phase === provenance.completion.phase && s.at === new Date(provenance.completion.at.epochMs).toISOString(), 'sample timing/provenance contradiction')
    // Passing observations require the complete producer result. Failed observations
    // remain in the interval and are rejected by the shared classifier below.
    samplerAssert(o.available || s.commandError !== null, 'unavailable command omitted its diagnostic')
    if (cb.error !== null || !o.available) samplerAssert(s.commandError !== null || raw.code !== 0, 'failed callback claimed success')
    const reconstructed = sampleFromResult(binding.runtime, { code: raw.code, stdout: raw.stdout, stderr: raw.stderr, diagnostic: s.commandError, killed: cb.error?.killed === true, observation: o }, s.at, s.phase)
    samplerAssert(JSON.stringify(s.processes) === JSON.stringify(reconstructed.processes)
      && JSON.stringify(s.identityProblems) === JSON.stringify(reconstructed.identityProblems), 'RSS/identity fields contradict original raw result')
    samplerAssert(o.child.acquired && o.child.exit.count > 0 && o.child.close.count > 0
      && ['stdout', 'stderr'].every(k => (o as any)[k].present === true && (o as any)[k].end.count > 0 && (o as any)[k].close.count > 0), 'missing physical command/stdio closure')
    const terminalStatuses = [o.child.exit.first!, o.child.exit.last!, o.child.close.first!, o.child.close.last!]
    samplerAssert(terminalStatuses.every(status => status.code === terminalStatuses[0].code
      && JSON.stringify(status.signal) === JSON.stringify(terminalStatuses[0].signal)), 'command exit/close status disagreement')
    if (cb.error === null && raw.code === 0) {
      // execFile's null-error callback is delivered after its successful native
      // exit. A serialized callback is not allowed to contradict those retained
      // physical facts or replace unknown callback flags with assumed success.
      samplerAssert(terminalStatuses.every(status => status.code === 0 && status.signal === null),
        'successful callback contradicts command exit/close status')
      samplerAssert(cb.childFlags && cb.childFlags.killed === false && cb.childFlags.exitCode === 0 && cb.childFlags.signalCode === null,
        'successful callback contradicts command callback child flags')
      samplerAssert(['stdout', 'stderr'].every(name => Object.values((o as any)[name].attached).every(flag => flag === true)),
        'successful callback lacks acquired command/stdio observers')
      samplerAssert(o.child.flagsAtReturn && o.child.flagsAtReturn.killed === false && o.child.flagsAtReturn.signalCode === null
        && (o.child.flagsAtReturn.exitCode === null || o.child.flagsAtReturn.exitCode === 0),
        'successful callback contradicts returned command flags')
    }
    const terminalTimes = [o.child.exit.last!.at.monotonicMs, o.child.close.last!.at.monotonicMs,
      o.stdout.end.last!.at.monotonicMs, o.stdout.close.last!.at.monotonicMs, o.stderr.end.last!.at.monotonicMs, o.stderr.close.last!.at.monotonicMs]
    samplerAssert(terminalTimes.every(t => t !== null && finite(t) && t >= o.startedAt.monotonicMs!), 'invalid command terminal clocks')
    previousTerminal = Math.max(provenance.completion.at.monotonicMs, ...(terminalTimes as number[]))
  }
  const expected = summarizeSamples(owned, samples, summary.skippedTicks, summary.errors)
  for (const key of ['unit', 'scope', 'sampleCount', 'validSampleCount', 'invalidSamples', 'peakRssKiBByPid', 'usable'] as const) {
    samplerAssert(JSON.stringify(summary[key]) === JSON.stringify(expected[key]), `summary ${key} disagrees with complete samples`)
  }
  requireUsableMemory(summary)
  return summary
}

function acknowledgedArtifactPhases(artifact: SamplerArtifact, binding: SamplerBinding, session: string, parentPid: number, childPid: number): SamplerPhase[] {
  const decode = (values: string[], sender: 'parent' | 'child', pid: number) => values.map((raw, index) => {
    samplerAssert(Buffer.byteLength(raw) <= 65536, 'artifact control frame exceeds its individual cap')
    let value: unknown
    try { value = JSON.parse(raw) } catch { throw new Error('owned sampler: malformed saved control frame') }
    validateSamplerFrame(value, sender)
    samplerAssert(value.session === session && value.senderPid === pid && value.sequence === index + 1, 'saved control identity/sequence disagreement')
    return value
  })
  const requests = decode(artifact.control.received.values, 'parent', parentPid)
  const replies = decode(artifact.control.sent.values, 'child', childPid)
  samplerAssert(requests.length >= 2 && requests[0].operation === 'initialize'
    && requests.at(-1)!.operation === 'stop' && requests.at(-1)!.payload.cancel === false
    && requests.slice(1, -1).every(frame => frame.operation === 'phase'), 'saved requests omit/reorder initialize, phase or stop')
  samplerAssert(JSON.stringify(requests[0].payload) === JSON.stringify(binding), 'saved initialize binding differs')
  samplerAssert(replies.length === requests.length && replies[0].kind === 'ready' && replies[0].payload.parentPid === parentPid, 'missing/reordered pre-terminal ready/ACK history')
  const phases: SamplerPhase[] = []
  let accepted = replies[0].at.monotonicMs
  for (const [index, request] of requests.slice(0, -1).entries()) {
    const reply = replies[index + 1]
    samplerAssert(reply.kind === 'ack' && reply.operation === request.operation && reply.requestId === request.requestId, 'saved acknowledgement does not match its request')
    const at = reply.payload.acceptedAt as SamplerTime
    samplerAssert(at.monotonicMs >= accepted && at.monotonicMs <= reply.at.monotonicMs, 'saved child acceptance clocks contradict ACK order')
    accepted = at.monotonicMs
    if (request.operation === 'initialize') {
      samplerAssert(reply.payload.cadenceStarted === true && JSON.stringify(reply.payload.binding) === JSON.stringify(binding), 'saved cadence acknowledgement differs')
    } else {
      samplerAssert(reply.payload.phase === request.payload.phase, 'saved phase acknowledgement changed the requested phase')
      phases.push({ phase: reply.payload.phase as string, at })
    }
  }
  return phases
}
export function validateSamplerArtifact(value: unknown, binding: SamplerBinding, session: string, parentPid: number, childPid: number): SamplerArtifact {
  const a = record(value, ['version', 'session', 'binding', 'parentPid', 'childPid', 'clocks', 'phases', 'control', 'summary', 'leases', 'retention', 'complete', 'failures', 'terminalOverflow'], 'terminal artifact') as unknown as SamplerArtifact
  samplerAssert(a.version === 1 && a.session === session && a.parentPid === parentPid && a.childPid === childPid, 'artifact session/parent/child mismatch')
  validateSamplerBinding(a.binding)
  samplerAssert(JSON.stringify(a.binding) === JSON.stringify(binding), 'artifact binding changed')
  const clocks = record(a.clocks, ['parent', 'child'], 'clock domains')
  samplerAssert(clocks.parent === `parent ${parentPid}: performance.now; receipt deadline authority`
    && clocks.child === `child ${childPid}: performance.now; command/phase observations only`, 'incorrect clock domains')
  const phases = list(a.phases, 64, 'phase history')
  let lastPhaseAt = -1
  for (const phase of phases) {
    const p = record(phase, ['phase', 'at'], 'phase observation')
    text(p.phase, 128, 'phase'); validateTime(p.at, 'phase accepted')
    samplerAssert(p.at.monotonicMs >= lastPhaseAt, 'phase clock regressed'); lastPhaseAt = p.at.monotonicMs
  }
  const control = record(a.control, ['received', 'sent'], 'child control evidence')
  for (const direction of ['received', 'sent']) {
    const h = record(control[direction], ['frames', 'originalBytes', 'retainedBytes', 'values', 'overflow'], 'control history')
    samplerAssert(count(h.frames) && count(h.originalBytes) && count(h.retainedBytes)
      && h.retainedBytes <= 262144 && h.originalBytes >= h.retainedBytes, 'control history counts')
    const values = list(h.values, 64, 'control frames')
    samplerAssert(values.every(v => typeof v === 'string') && values.reduce((n, v) => n + Buffer.byteLength(v), 0) === h.retainedBytes, 'control retained bytes')
    samplerAssert(h.overflow === null || typeof h.overflow === 'string', 'control overflow')
    if (a.complete) samplerAssert(h.overflow === null && h.frames === values.length && h.frames <= 64 && h.originalBytes === h.retainedBytes, 'incomplete control history')
  }
  const failures = record(a.failures, ['count', 'retained', 'omitted'], 'failure evidence')
  samplerAssert(count(failures.count) && count(failures.omitted), 'failure counters')
  const retained = list(failures.retained, 64, 'retained failures')
  retained.forEach(v => validateDescription(v, 'failure'))
  samplerAssert(retained.length + failures.omitted === failures.count, 'failure retention counts')
  const retention = record(a.retention, ['records', 'accountedBytes', 'terminalReserve', 'leaseReserve', 'overflow'], 'sample retention')
  samplerAssert(count(retention.records) && retention.records <= 8192 && count(retention.accountedBytes)
    && retention.accountedBytes <= 134217728 && retention.terminalReserve === 4194304 && retention.leaseReserve === 1024, 'retention accounting')
  samplerAssert(typeof a.complete === 'boolean', 'missing completeness')
  // A partial artifact is safe preserved failure evidence, never a success input.
  samplerAssert(a.complete && failures.count === 0, 'partial/failed terminal evidence')
  samplerAssert(a.terminalOverflow === null, 'terminal overflow cannot become complete')
  samplerAssert(retention.overflow === null, 'retention overflow cannot become complete')
  const acknowledgedPhases = acknowledgedArtifactPhases(a, binding, session, parentPid, childPid)
  samplerAssert(JSON.stringify(a.phases) === JSON.stringify(acknowledgedPhases), 'artifact phases differ from the actual acknowledged request/reply history')
  const summary = qualifySamplerSummary(a.summary, binding, childPid, phases, parentPid)
  samplerAssert(retention.records === summary.sampleCount && retention.accountedBytes === 4194304
    + summary.samples.reduce((n, s) => n + Buffer.byteLength(JSON.stringify(s)) + 1025, 0), 'incremental record accounting disagrees')
  const leases = list(a.leases, 8192, 'command leases')
  samplerAssert(leases.length === summary.sampleCount, 'final acquisition/lease missing')
  for (const [index, item] of leases.entries()) {
    const lease = record(item, ['sequence', 'pid', 'terminal', 'exit', 'close', 'stdoutEnd', 'stdoutClose', 'stderrEnd', 'stderrClose', 'observerFailures'], 'command lease')
    const o = summary.samples[index].commandObservation!
    samplerAssert(lease.sequence === o.sequence && lease.pid === o.child.pid && lease.terminal === true
      && lease.exit === o.child.exit.count && lease.close === o.child.close.count
      && lease.stdoutEnd === o.stdout.end.count && lease.stdoutClose === o.stdout.close.count
      && lease.stderrEnd === o.stderr.end.count && lease.stderrClose === o.stderr.close.count
      && lease.observerFailures === 0, 'lease terminal facts disagree with the sample')
  }
  return a
}
export interface SamplerArtifactRead {
  body: Buffer; path: string; bytes: number; sha256: string
  descriptor: Record<string, string | number>
  value: unknown
}
export class SamplerArtifactReadFailure extends Error {
  constructor(message: string, readonly safeRead: SamplerArtifactRead, readonly qualificationCause: unknown) {
    super(message)
    this.name = 'SamplerArtifactReadFailure'
  }
}
/** The path is selected by the parent. Never open a path supplied by an invalid frame. */
export async function readSamplerArtifact(expected: string, payload: Record<string, unknown>, deadline: number, now = () => performance.now(), io: { open?: typeof open; lstat?: typeof lstat } = {}): Promise<SamplerArtifactRead> {
  samplerAssert(payload.path === expected, 'terminal path mismatch (not opened)')
  samplerAssert(positive(payload.bytes) && payload.bytes <= SAMPLER_LIMITS.artifactBytes && typeof payload.sha256 === 'string' && SHA256.test(payload.sha256), 'terminal size/hash declaration')
  const checkTime = () => samplerAssert(now() <= deadline, 'artifact verification exceeded the original owner deadline')
  checkTime()
  // A FIFO must not wait for a writer before we can reject its descriptor.
  const file = await (io.open ?? open)(expected, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  let result: SamplerArtifactRead | undefined
  let qualificationFailure: unknown = null
  try {
    checkTime()
    const before = await file.stat({ bigint: true })
    samplerAssert(before.isFile() && (before.mode & 0o777n) === 0o600n
      && (process.getuid === undefined || before.uid === BigInt(process.getuid())), 'artifact is not a private owned regular file')
    samplerAssert(before.size === BigInt(payload.bytes as number), 'artifact size differs before read')
    const descriptor = (s: typeof before) => ({ device: String(s.dev), inode: String(s.ino), mode: String(s.mode), size: String(s.size),
      mtimeNs: String(s.mtimeNs), ctimeNs: String(s.ctimeNs), birthtimeNs: String(s.birthtimeNs) })
    const body = Buffer.alloc(payload.bytes as number)
    const hash = createHash('sha256')
    let offset = 0
    while (offset < body.length) {
      checkTime()
      const read = await file.read(body, offset, Math.min(65_536, body.length - offset), offset)
      samplerAssert(read.bytesRead > 0, 'artifact ended early')
      hash.update(body.subarray(offset, offset + read.bytesRead))
      offset += read.bytesRead
    }
    const extra = Buffer.alloc(1)
    samplerAssert((await file.read(extra, 0, 1, offset)).bytesRead === 0, 'artifact has trailing bytes')
    const after = await file.stat({ bigint: true })
    const named = await (io.lstat ?? lstat)(expected, { bigint: true })
    samplerAssert(!named.isSymbolicLink() && named.isFile()
      && JSON.stringify(descriptor(before)) === JSON.stringify(descriptor(after))
      && JSON.stringify(descriptor(after)) === JSON.stringify(descriptor(named)), 'artifact descriptor/path changed during read')
    checkTime()
    const sha256 = hash.digest('hex')
    // Only now are these bounded expected-file bytes eligible for preservation.
    // Integrity/JSON errors below retain them without qualifying a summary.
    result = { body, path: expected, bytes: body.length, sha256, descriptor: descriptor(after), value: null }
    samplerAssert(sha256 === payload.sha256, 'artifact SHA256 mismatch')
    let value: unknown
    try { value = JSON.parse(body.toString('utf8')) } catch { throw new Error('owned sampler: artifact is not complete JSON') }
    checkTime()
    result.value = value
  } catch (error) { qualificationFailure = error }
  finally {
    try { await file.close(); if (result) result.descriptor.closedAtMonotonicMs = now() }
    catch (error) {
      qualificationFailure = qualificationFailure === null ? error
        : new AggregateError([qualificationFailure, error], `${String(qualificationFailure)}; artifact descriptor close failed: ${String(error)}`)
    }
  }
  try { checkTime() } catch (error) { qualificationFailure ??= error }
  if (qualificationFailure !== null) {
    if (result) throw new SamplerArtifactReadFailure(String(qualificationFailure), result, qualificationFailure)
    throw qualificationFailure
  }
  return result!
}

export interface SamplerClock {
  now(): number; wallNow(): number
  schedule(callback: () => void, ms: number): unknown
  clear(handle: unknown): void
}
const realClock: SamplerClock = {
  now: () => performance.now(), wallNow: Date.now,
  schedule: (fn, ms) => setTimeout(fn, ms),
  clear: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
}
function before<T>(work: Promise<T>, deadline: number, clock: SamplerClock, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false
    const settle = (error: unknown, value?: T) => {
      if (settled) return
      settled = true; clock.clear(timer)
      if (error) reject(error); else resolve(value!)
    }
    const timer = clock.schedule(() => settle(new Error(`owned sampler: ${label} original deadline expired`)), Math.max(0, deadline - clock.now()))
    work.then(value => {
      if (clock.now() > deadline) settle(new Error(`owned sampler: ${label} completed after its original deadline`))
      else settle(null, value)
    }, error => settle(error))
  })
}
export interface SamplerChild {
  pid?: number; connected: boolean
  exitCode: number | null; signalCode: string | null
  stdout: { on(event: string, listener: (...args: any[]) => void): unknown } | null
  stderr: { on(event: string, listener: (...args: any[]) => void): unknown } | null
  on(event: string, listener: (...args: any[]) => void): unknown
  send(value: string, callback: (error: Error | null) => void): unknown
  kill(signal: NodeJS.Signals): boolean
}
export interface RegisteredProcess { event: string; pid: number; ppid: number; at: number; argv?: string[]; code?: number | null; signal?: string | null }
export interface SamplerOwnedProcess {
  pid: number; ppid: number; argv: string[]; registeredAt: number
  identity: ProcessIdentity | null; observedGoneAt: SamplerTime | null
  exit: { at: number; code: number | null; signal: string | null } | null
  live: boolean
}
export interface SamplerOwnership {
  evidence: { processes: SamplerOwnedProcess[]; queries: unknown[]; signals: unknown[]; failures: string[] }
  capture(deadline: number): Promise<void>
  closed(deadline: number): Promise<boolean>
  signal(signal: 'SIGTERM' | 'SIGKILL', cutoff: number): Promise<void>
}
async function runBinding(runtime: OwnedRuntime, artifactPath: string): Promise<SamplerBinding> {
  const registry = process.env.ORBIT_PROCESS_REGISTRY
  const stage = path.dirname(path.resolve(fileURLToPath(new URL('../../../', import.meta.url))))
  samplerAssert(registry && registry === runtime.registryPath && path.basename(registry) === 'processes.ndjson'
    && path.dirname(path.dirname(registry)) === path.join(stage, 'verification')
    && /^worker-capacity-[a-f0-9]{12}$/.test(path.basename(path.dirname(registry))), 'registry is not this approved capacity run')
  samplerAssert(process.env.NODE_OPTIONS === `--require=${path.join(stage, 'collaboration/register-processes.cjs')}`, 'approved registration preload is missing or changed')
  const run = path.dirname(registry)
  const request = JSON.parse(await readFile(path.join(run, 'request.json'), 'utf8'))
  const source = JSON.parse(await readFile(path.join(run, 'source-before.json'), 'utf8'))
  samplerAssert(request.check === 'worker-capacity' && request.actor === process.env.ORBIT_VERIFICATION_ACTOR
    && source.contentDigest === request.sourceDigest, 'dispatcher source/actor/check mismatch')
  const binding: SamplerBinding = { run: path.basename(run), actor: request.actor, sourceDigest: request.sourceDigest,
    planSha256: request.planSha256, runtime, artifactPath, cadence: 250 }
  validateSamplerBinding(binding)
  return binding
}
/** This reader is restricted to the named current run's process registry, never collaboration streams. */
async function registeredProcesses(binding: SamplerBinding): Promise<RegisteredProcess[]> {
  const name = binding.runtime.registryPath
  samplerAssert(path.basename(name) === 'processes.ndjson' && !name.split(path.sep).includes('collaboration')
    && path.basename(path.dirname(name)) === binding.run, 'unsafe registry path')
  const file = await open(name, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = await file.stat()
    samplerAssert(stat.isFile() && stat.size <= 16_777_216, 'registry is not bounded regular evidence')
    const body = Buffer.alloc(stat.size)
    let offset = 0
    while (offset < body.length) {
      const { bytesRead } = await file.read(body, offset, body.length - offset, offset)
      samplerAssert(bytesRead > 0, 'registry became shorter'); offset += bytesRead
    }
    // appendFileSync writes complete records; a trailing partial record is not invented.
    const decoded = body.toString('utf8')
    samplerAssert(!decoded || decoded.endsWith('\n'), 'incomplete process registry record')
    return decoded.split('\n').filter(Boolean).map(line => {
      const r = JSON.parse(line) as RegisteredProcess
      samplerAssert(['spawn', 'exit', 'observer-start'].includes(r.event) && positive(r.pid) && positive(r.ppid) && finite(r.at), 'invalid owned process record')
      if (r.event === 'spawn') samplerAssert(Array.isArray(r.argv) && r.argv.length > 0 && r.argv.every(v => typeof v === 'string'), 'invalid spawn argv')
      return r
    })
  } finally { await file.close() }
}
export interface SamplerOwnershipProducers {
  records?: () => Promise<RegisteredProcess[]>
  table?: (pids: number[], cutoff: number) => Promise<ProcessIdentity[]>
  signal?: (pid: number, signal: 'SIGTERM' | 'SIGKILL') => boolean
  command?: CommandWitness
}
export class NativeSamplerOwnership implements SamplerOwnership {
  readonly evidence: SamplerOwnership['evidence'] = { processes: [], queries: [], signals: [], failures: [] }
  private readonly queryLeases: CommandLease[] = []
  constructor(private readonly binding: SamplerBinding, private readonly child: SamplerChild, private readonly argv: string[],
    private readonly launchedAt: number, private readonly clock: SamplerClock, private readonly producers: SamplerOwnershipProducers = {},
    private readonly onFailure?: (error: unknown) => void) {}
  private stamp() { return samplerTime(this.clock.now(), this.clock.wallNow()) }
  private async table(pids: number[], cutoff: number): Promise<ProcessIdentity[]> {
    if (!pids.length) return []
    samplerAssert(pids.every(positive) && !pids.some(pid => this.binding.runtime.workerd.some(p => p.pid === pid)), 'ownership lookup included workerd')
    const timeout = Math.floor(Math.min(5000, cutoff - this.clock.now()))
    samplerAssert(timeout >= 1, 'ownership lookup has no original remaining time')
    samplerAssert(this.evidence.queries.length < 64, 'ownership query history exceeds64')
    if (this.producers.table) {
      const rows = await before(this.producers.table(pids, cutoff), cutoff, this.clock, 'literal ownership query')
      this.evidence.queries.push({ pids: [...pids], cutoff, rows, producer: 'instance-local literal ownership table' })
      return rows
    }
    let lease: CommandLease | undefined
    const query: { pids: number[]; cutoff: number; result: BoundedResult | null; observation: CommandObservation | null; terminal: boolean; failure: CommandText | null } =
      { pids: [...pids], cutoff, result: null, observation: null, terminal: false, failure: null }
    this.evidence.queries.push(query)
    const failed = (error: unknown) => {
      query.failure ??= samplerDescription(error)
      if (this.evidence.failures.length < 64) this.evidence.failures.push(query.failure.text)
      this.onFailure?.(error)
    }
    const work = execBounded('ps', ['-o', 'pid=,ppid=,pgid=,lstart=,command=', '-p', pids.join(',')], timeout, {
      ...this.producers.command,
      lifetime: value => {
        lease = value; this.queryLeases.push(value); query.observation = value.observation
        let notified = false
        value.onChange(() => {
          query.terminal = value.observedTerminal()
          const o = value.observation
          if (!notified && (o.invocationFailure || o.observerFailures.count || o.child.error.count || o.stdout.error.count || o.stderr.error.count)) {
            notified = true; failed(new Error('owned sampler: ownership command producer/observer failure'))
          }
        })
      },
    }).then(result => { query.result = result; return result }, error => { failed(error); throw error })
    let result: BoundedResult
    try { result = await before(work, cutoff, this.clock, 'ownership query') }
    catch (error) {
      failed(error)
      // No new allowance or post-cutoff signal; the original command timeout
      // remains configured. Its holder continues retaining any later result.
      if (lease && !lease.observedTerminal() && this.clock.now() < cutoff) {
        try { lease.cancel() } catch (cancelError) { failed(cancelError) }
      }
      throw error
    }
    samplerAssert(lease, 'ownership command lease missing')
    try { await before(lease.terminal, cutoff, this.clock, 'ownership query closure') }
    catch (error) { failed(error); throw error }
    query.terminal = lease.observedTerminal()
    samplerAssert(query.terminal && result.diagnostic === null && !result.killed && !result.stderr.trim(), 'ownership query/closure unavailable')
    if (result.code === 1 && !result.stdout.trim()) return []
    samplerAssert(result.code === 0, 'ownership query failed')
    const rows: ProcessIdentity[] = []
    for (const line of result.stdout.split('\n').filter(v => v.trim())) {
      const parts = line.trim().split(/\s+/)
      samplerAssert(parts.length >= 9, 'ownership process row malformed')
      const [pid, ppid, pgid] = parts.slice(0, 3).map(Number)
      samplerAssert([pid, ppid, pgid].every(positive) && pids.includes(pid) && !rows.some(r => r.pid === pid), 'ownership process row unexpected')
      rows.push({ pid, ppid, pgid, started: parts.slice(3, 8).join(' '), command: parts.slice(8).join(' ') })
    }
    return rows
  }
  private async scan(cutoff: number): Promise<void> {
    samplerAssert(this.clock.now() < cutoff, 'ownership scan has no original remaining time')
    const records = await before(this.producers.records?.() ?? registeredProcesses(this.binding), cutoff, this.clock, 'registry read')
    const root = records.filter(r => r.event === 'spawn' && r.pid === this.child.pid)
    samplerAssert(root.length === 1 && root[0].ppid === process.pid && root[0].at >= this.launchedAt - 1000
      && JSON.stringify(root[0].argv) === JSON.stringify(this.argv), 'returned sampler child does not have the exact same-run spawn record')
    const selected = new Map<number, RegisteredProcess>([[root[0].pid, root[0]]])
    let changed = true
    while (changed) {
      changed = false
      for (const r of records) if (r.event === 'spawn' && selected.has(r.ppid) && r.at >= selected.get(r.ppid)!.at) {
        const old = selected.get(r.pid)
        samplerAssert(!old || (old.at === r.at && old.ppid === r.ppid), 'owned descendant PID was reused')
        if (!old) { selected.set(r.pid, r); changed = true }
      }
    }
    samplerAssert(selected.size <= 8194, 'owned descendant history exceeds bound')
    for (const r of selected.values()) {
      samplerAssert(r.pid !== process.pid && !this.binding.runtime.workerd.some(p => p.pid === r.pid)
        && !r.argv!.some(arg => /(^|\/)workerd(\s|$)|workerd-darwin|workerd-linux/.test(arg)), 'ownership tree crossed workerd/controller boundary')
      let owned = this.evidence.processes.find(p => p.pid === r.pid)
      if (!owned) {
        owned = { pid: r.pid, ppid: r.ppid, argv: [...r.argv!], registeredAt: r.at, identity: null, observedGoneAt: null, exit: null, live: true }
        this.evidence.processes.push(owned)
      }
      const exits = records.filter(e => e.event === 'exit' && e.pid === r.pid && e.ppid === r.ppid && e.at >= r.at)
      if (exits.length) {
        samplerAssert(exits.length === 1, 'duplicate descendant exit ownership')
        owned.exit = { at: exits[0].at, code: exits[0].code ?? null, signal: exits[0].signal ?? null }
        owned.live = false; owned.observedGoneAt ??= this.stamp()
      }
    }
    const pending = this.evidence.processes.filter(p => p.live)
    const rows = await this.table(pending.map(p => p.pid), cutoff)
    for (const owned of pending) {
      const current = rows.find(r => r.pid === owned.pid)
      if (!current) {
        samplerAssert(owned.identity !== null, `descendant ${owned.pid} disappeared before positive identity/exit observation`)
        owned.live = false; owned.observedGoneAt = this.stamp(); continue
      }
      samplerAssert(current.ppid === owned.ppid && Number.isFinite(birthOf(current))
        && Math.abs(birthOf(current) - owned.registeredAt) <= 120_000
        && current.command === owned.argv.join(' '), `descendant ${owned.pid} launch/birth/argv mismatch`)
      if (owned.identity) samplerAssert(JSON.stringify(current) === JSON.stringify(owned.identity), `descendant ${owned.pid} identity changed`)
      else owned.identity = { ...current }
    }
    samplerAssert(this.clock.now() <= cutoff, 'ownership qualification exceeded its cutoff')
  }
  async capture(deadline: number): Promise<void> { await this.scan(deadline); samplerAssert(this.evidence.processes.some(p => p.pid === this.child.pid && p.live && p.identity), 'sampler child was not positively identified alive') }
  async closed(deadline: number): Promise<boolean> {
    await this.scan(deadline)
    samplerAssert(this.queryLeases.every(lease => lease.observedTerminal()), 'ownership query command closure is unconfirmed')
    return this.evidence.processes.every(p => !p.live && p.observedGoneAt !== null)
  }
  async signal(signal: 'SIGTERM' | 'SIGKILL', cutoff: number): Promise<void> {
    await this.scan(cutoff)
    // Recheck immediately before each signal; no shared process-group signalling.
    for (const owned of [...this.evidence.processes].reverse()) {
      if (!owned.live || owned.observedGoneAt) continue
      samplerAssert(owned.identity !== null, 'cannot signal unknown descendant identity')
      const rows = await this.table([owned.pid], cutoff)
      const current = rows[0]
      if (!current) { owned.live = false; owned.observedGoneAt = this.stamp(); continue }
      samplerAssert(JSON.stringify(current) === JSON.stringify(owned.identity), 'cannot signal a replaced descendant')
      samplerAssert(this.clock.now() < cutoff, 'identity recheck reached signal cutoff')
      const requested = this.producers.signal ? this.producers.signal(owned.pid, signal) : owned.pid === this.child.pid
        ? this.child.exitCode === null && this.child.signalCode === null && this.child.kill(signal)
        : (process.kill(owned.pid, signal), true)
      this.evidence.signals.push({ pid: owned.pid, signal, identity: current, at: this.stamp(), cutoff, requested, closureConfirmed: false })
    }
  }
}

export interface SamplerProcessOptions {
  /** Instance-local literal producers; production uses the native owned launcher. */
  binding?: SamplerBinding
  clock?: SamplerClock
  launch?: (session: string, argv: string[]) => SamplerChild
  ownership?: (child: SamplerChild, binding: SamplerBinding) => SamplerOwnership
  readArtifact?: typeof readSamplerArtifact
}
export interface SamplerOwnerOutcome {
  complete: boolean; summary: MemorySummary | null; rawSummary: unknown
  artifact: { path: string; bytes: number; sha256: string; descriptor: Record<string, string | number> } | null
  evidence: SamplerProcess['evidence']
}
interface PendingSamplerRequest {
  operation: SamplerOperation; requestId: number; deadline: number; payload: Record<string, unknown>
  resolve(frame: SamplerFrame): void; reject(error: unknown): void; timer: unknown
}
/** One retained session, one initialization/stop, and one object-identical finalizer. */
export class SamplerProcess {
  readonly session = randomUUID()
  readonly failures = new SamplerFailures()
  readonly evidence: {
    session: string; binding: SamplerBinding | null; startup: { enteredAt: SamplerTime; deadline: number; qualifiedAt: SamplerTime | null } | null
    launch: { requestedAt: SamplerTime; argv: string[]; returnedPid: number | null; ownershipUnknown: boolean } | null
    control: { received: SamplerHistory; sent: SamplerHistory } | null
    observerAcquisition: { component: string; attached: boolean; failure: CommandText | null }[]
    receipts: { kind: string; sequence: number; requestId: number; at: SamplerTime }[]
    physical: { exit: { code: number | null; signal: string | null; at: SamplerTime } | null; close: { code: number | null; signal: string | null; at: SamplerTime } | null
      disconnect: SamplerTime | null; stdoutEnd: SamplerTime | null; stdoutClose: SamplerTime | null; stderrEnd: SamplerTime | null; stderrClose: SamplerTime | null }
    output: { stdout: { originalBytes: number; retainedBytes: number; base64: string }; stderr: { originalBytes: number; retainedBytes: number; base64: string } }
    ownership: SamplerOwnership['evidence'] | null
    finalization: { enteredAt: SamplerTime; escalation: number; kill: number; deadline: number; settledAt: SamplerTime | null; physicalClosed: boolean; descendantsClosed: boolean } | null
    failures: SamplerFailureEvidence; qualificationFailure: CommandText | null
  }
  private readonly clock: SamplerClock
  private binding: SamplerBinding | null = null
  private child: SamplerChild | null = null
  private ownership: SamplerOwnership | null = null
  private wire: SamplerWire | null = null
  private pending: PendingSamplerRequest | null = null
  private firstError: unknown = null
  private readySeen = false
  private initialized = false
  private startPromise: Promise<void> | null = null
  private finalPromise: Promise<SamplerOwnerOutcome> | null = null
  private terminalRead: SamplerArtifactRead | null = null
  private summary: MemorySummary | null = null
  private readyResolve!: () => void
  private readyReject!: (error: unknown) => void
  private readonly ready: Promise<void>
  private closeResolve!: () => void
  private readonly closed: Promise<void>
  private finalWake = () => {}
  constructor(readonly runtime: OwnedRuntime, readonly artifactPath: string, private readonly options: SamplerProcessOptions = {}) {
    this.clock = options.clock ?? realClock
    this.ready = new Promise((resolve, reject) => { this.readyResolve = resolve; this.readyReject = reject })
    // Install rejection observation before a native event can arrive.
    void this.ready.catch(() => {})
    this.closed = new Promise(resolve => { this.closeResolve = resolve })
    this.evidence = {
      session: this.session, binding: null, startup: null, launch: null, control: null, observerAcquisition: [], receipts: [],
      physical: { exit: null, close: null, disconnect: null, stdoutEnd: null, stdoutClose: null, stderrEnd: null, stderrClose: null },
      output: { stdout: { originalBytes: 0, retainedBytes: 0, base64: '' }, stderr: { originalBytes: 0, retainedBytes: 0, base64: '' } },
      ownership: null, finalization: null, failures: this.failures.evidence, qualificationFailure: null,
    }
  }
  private time() { return samplerTime(this.clock.now(), this.clock.wallNow()) }
  private healthy(): void { if (this.firstError !== null) throw this.firstError }
  private failure(error: unknown): void {
    this.firstError ??= error
    this.failures.add(error)
    this.readyReject(error)
    if (this.pending && this.pending.operation !== 'stop') {
      const pending = this.pending; this.pending = null
      this.clock.clear(pending.timer); pending.reject(error)
    }
  }
  private asynchronousFailure(error: unknown): void {
    this.failure(error)
    // Acquired resources cannot wait for the next application assertion to fail.
    void this.stop(true)
    this.finalWake()
  }
  private physicalClosed(): boolean {
    const p = this.evidence.physical
    return Boolean(p.exit && p.close && p.disconnect && p.stdoutEnd && p.stdoutClose && p.stderrEnd && p.stderrClose)
  }
  private observeTime(): SamplerTime {
    const at = this.time()
    const final = this.evidence.finalization
    if (final && !final.settledAt && at.monotonicMs >= final.escalation && this.failures.evidence.count === 0) {
      this.failure(new Error('owned sampler: normal finalization was incomplete at its original12000ms cutoff'))
    }
    return at
  }
  private observeChild(child: SamplerChild): void {
    // Each acquired component is attempted independently, before PID/identity
    // qualification can fail. Registration errors stay handled and do not skip
    // a later error/close/message observer.
    const attempt = <T>(component: string, acquire: () => T): T | undefined => {
      const observed = { component, attached: false, failure: null as CommandText | null }
      this.evidence.observerAcquisition.push(observed)
      try { const value = acquire(); observed.attached = true; return value }
      catch (error) {
        observed.failure = samplerDescription(error)
        this.failure(new Error(`owned sampler: ${component} observation unavailable: ${observed.failure.text}`))
      }
    }
    const listen = (emitter: { on(event: string, listener: (...args: any[]) => void): unknown }, event: string, component: string, listener: (...args: any[]) => void) =>
      attempt(component, () => { emitter.on(event, listener) })
    listen(child, 'error', 'child error', error => this.asynchronousFailure(error))
    listen(child, 'exit', 'child exit', (code: number | null, signal: string | null) => {
      const at = this.observeTime()
      if (this.evidence.physical.exit) this.failure(new Error('owned sampler: duplicate child exit'))
      this.evidence.physical.exit ??= { code, signal, at }
      if (!this.finalPromise || code !== 0 || signal !== null) this.asynchronousFailure(new Error(`owned sampler: unexpected child exit ${code}/${signal}`))
      this.changed()
    })
    listen(child, 'close', 'child close', (code: number | null, signal: string | null) => {
      const at = this.observeTime()
      if (this.evidence.physical.close) this.failure(new Error('owned sampler: duplicate child close'))
      this.evidence.physical.close ??= { code, signal, at }
      if (code !== 0 || signal !== null) this.asynchronousFailure(new Error(`owned sampler: unexpected child close ${code}/${signal}`))
      this.changed()
    })
    listen(child, 'disconnect', 'child disconnect', () => {
      this.evidence.physical.disconnect ??= this.observeTime()
      if (!this.finalPromise) this.asynchronousFailure(new Error('owned sampler: IPC disconnected before finalization'))
      this.changed()
    })
    for (const name of ['stdout', 'stderr'] as const) {
      const stream = attempt(`${name} handle`, () => {
        const acquired = child[name]
        samplerAssert(acquired, `acquired ${name} pipe missing`)
        return acquired
      })
      if (!stream) continue
      // Install this acquired pipe's error observer before data/terminal
      // subscriptions; every registration is still attempted if another throws.
      listen(stream, 'error', `${name} error`, error => this.asynchronousFailure(error))
      listen(stream, 'data', `${name} data`, (value: unknown) => {
        this.observeTime()
        const output = this.evidence.output[name]
        const remaining = Math.max(0, 65536 - output.retainedBytes)
        const originalBytes = typeof value === 'string' ? Buffer.byteLength(value) : Buffer.isBuffer(value) ? value.length : null
        if (originalBytes === null) { this.asynchronousFailure(new Error(`owned sampler: unknown ${name} data`)); return }
        const bytes = typeof value === 'string' ? Buffer.from(utf8Prefix(value, remaining)) : (value as Buffer).subarray(0, remaining)
        output.originalBytes = Math.min(Number.MAX_SAFE_INTEGER, output.originalBytes + originalBytes)
        const retained = Buffer.concat([Buffer.from(output.base64, 'base64'), bytes])
        output.retainedBytes = retained.length; output.base64 = retained.toString('base64')
        this.asynchronousFailure(new Error(`owned sampler: unexpected ${name}${output.originalBytes > 65536 ? ' (65536-byte retention overflow)' : ''}`))
      })
      listen(stream, 'end', `${name} end`, () => { this.evidence.physical[`${name}End`] ??= this.observeTime(); this.changed() })
      listen(stream, 'close', `${name} close`, () => { this.evidence.physical[`${name}Close`] ??= this.observeTime(); this.changed() })
    }
    listen(child, 'message', 'child message', value => this.receive(value))
  }
  private changed(): void { if (this.physicalClosed()) this.closeResolve(); this.finalWake() }
  private receive(value: unknown): void {
    const receivedAt = this.observeTime()
    try {
      samplerAssert(this.wire, 'message before wire ownership')
      const frame = this.wire.receive(value)
      if (this.evidence.receipts.length < 64) this.evidence.receipts.push({ kind: frame.kind, sequence: frame.sequence, requestId: frame.requestId, at: receivedAt })
      else throw new Error('owned sampler: receipt history exceeds64')
      if (frame.kind === 'ready') {
        samplerAssert(!this.readySeen && !this.initialized && !this.pending && frame.payload.parentPid === process.pid, 'duplicate/unexpected control-ready or wrong parent')
        samplerAssert(this.evidence.startup && receivedAt.monotonicMs <= this.evidence.startup.deadline, 'control-ready missed original startup deadline')
        this.readySeen = true; this.readyResolve(); return
      }
      if (frame.kind === 'fatal') {
        const current = this.pending?.requestId ?? this.wire.sent.frames
        samplerAssert(frame.requestId === current && (frame.requestId !== 0 || !this.initialized), 'fatal request attribution mismatch')
        throw new Error(`owned sampler: child fatal at ${frame.payload.stage}: ${(frame.payload.failure as CommandText).text}`)
      }
      const pending = this.pending
      samplerAssert(pending && frame.requestId === pending.requestId && frame.operation === pending.operation, 'unsolicited or mismatched response')
      samplerAssert(receivedAt.monotonicMs <= pending.deadline, 'reply received after original request deadline')
      samplerAssert(frame.kind === (pending.operation === 'stop' ? 'terminal' : 'ack'), 'wrong reply kind')
      if (pending.operation === 'initialize') samplerAssert(frame.payload.cadenceStarted === true && JSON.stringify(frame.payload.binding) === JSON.stringify(this.binding), 'startup did not bind the active cadence/identities')
      if (pending.operation === 'phase') samplerAssert(frame.payload.phase === pending.payload.phase, 'phase acknowledgement changed phase')
      this.pending = null; this.clock.clear(pending.timer); pending.resolve(frame)
    } catch (error) { this.asynchronousFailure(error) }
  }
  private request(operation: SamplerOperation, payload: Record<string, unknown>, deadline: number): Promise<SamplerFrame> {
    return new Promise((resolve, reject) => {
      try {
        samplerAssert(this.wire && this.child && this.child.connected && !this.pending, 'no owned channel or another request is pending')
        samplerAssert(this.clock.now() <= deadline, 'request has no original remaining time')
        const encoded = this.wire.encode('request', operation, payload)
        const timer = this.clock.schedule(() => {
          if (this.pending?.requestId === encoded.frame.requestId) this.asynchronousFailure(new Error(`owned sampler: ${operation} original deadline expired`))
        }, Math.max(0, deadline - this.clock.now()))
        this.pending = { operation, payload, deadline, requestId: encoded.frame.requestId, resolve, reject, timer }
        try {
          this.child.send(encoded.raw, error => {
            if (error) this.asynchronousFailure(error)
          })
        } catch (error) { this.asynchronousFailure(error) }
      } catch (error) { reject(error) }
    })
  }
  start(): Promise<void> {
    if (this.startPromise) return this.startPromise
    const enteredAt = this.time()
    this.evidence.startup = { enteredAt, deadline: enteredAt.monotonicMs + 5000, qualifiedAt: null }
    this.startPromise = this.startOwned(this.evidence.startup.deadline)
    return this.startPromise
  }
  private async startOwned(deadline: number): Promise<void> {
    try {
      this.binding = this.options.binding ?? await before(runBinding(this.runtime, this.artifactPath), deadline, this.clock, 'run binding')
      validateSamplerBinding(this.binding)
      samplerAssert(this.binding.artifactPath === this.artifactPath && JSON.stringify(this.binding.runtime) === JSON.stringify(this.runtime), 'initial runtime/path changed')
      this.evidence.binding = this.binding
      if (!this.options.launch) await before(mkdir(path.dirname(this.artifactPath), { recursive: true }), deadline, this.clock, 'artifact directory')
      this.healthy()
      samplerAssert(this.clock.now() <= deadline, 'startup budget expired before launch')
      const entry = fileURLToPath(new URL('./memory-sampler-child.ts', import.meta.url))
      const argv = [process.execPath, '--import', 'tsx', entry, '--orbit-sampler', this.session]
      const requestedAt = this.time()
      this.evidence.launch = { requestedAt, argv, returnedPid: null, ownershipUnknown: false }
      try {
        this.child = this.options.launch ? this.options.launch(this.session, argv)
          : spawn(process.execPath, argv.slice(1), { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: { ...process.env } })
      } catch (error) {
        this.evidence.launch.ownershipUnknown = true
        throw error // The preload may already have spawned; no guessed PID or local closure.
      }
      this.observeChild(this.child)
      let returnedPid: number | undefined
      try { returnedPid = this.child.pid }
      catch (error) { this.evidence.launch.ownershipUnknown = true; throw error }
      this.evidence.launch.returnedPid = returnedPid ?? null
      if (!positive(returnedPid)) {
        this.evidence.launch.ownershipUnknown = true
        throw new Error('owned sampler: returned child PID unavailable')
      }
      this.wire = new SamplerWire(this.session, process.pid, returnedPid, 'parent', () => this.time())
      this.evidence.control = { sent: this.wire.sent, received: this.wire.received }
      this.ownership = this.options.ownership?.(this.child, this.binding)
        ?? new NativeSamplerOwnership(this.binding, this.child, argv, requestedAt.epochMs, this.clock, {}, error => this.asynchronousFailure(error))
      this.evidence.ownership = this.ownership.evidence
      this.healthy()
      await before(this.ready, deadline, this.clock, 'control readiness')
      this.healthy()
      await before(this.ownership.capture(deadline), deadline, this.clock, 'startup ownership')
      this.healthy()
      await this.request('initialize', this.binding as unknown as Record<string, unknown>, deadline)
      samplerAssert(this.clock.now() <= deadline, 'startup qualification missed original deadline')
      this.healthy()
      this.initialized = true; this.evidence.startup!.qualifiedAt = this.time()
    } catch (error) {
      this.failure(error)
      void this.stop(true)
      throw error
    }
  }
  async phase(phase: string): Promise<void> {
    const deadline = this.clock.now() + 5000
    try {
      this.healthy()
      samplerAssert(this.initialized && !this.finalPromise, 'phase outside active initialized session')
      text(phase, 128, 'phase')
      await this.request('phase', { phase }, deadline)
      this.healthy()
    } catch (error) { this.failure(error); void this.stop(true); throw error }
  }
  stop(cancel = false): Promise<SamplerOwnerOutcome> {
    if (this.finalPromise) return this.finalPromise
    const enteredAt = this.time()
    this.evidence.finalization = { enteredAt, escalation: enteredAt.monotonicMs + 12000, kill: enteredAt.monotonicMs + 13500,
      deadline: enteredAt.monotonicMs + 15000, settledAt: null, physicalClosed: false, descendantsClosed: false }
    // Assign before calling any producer: synchronous fake events see this owner.
    let begin!: () => void
    this.finalPromise = new Promise(resolve => { begin = () => this.finalizeOwned(cancel, resolve) })
    begin()
    return this.finalPromise
  }
  private finalizeOwned(cancel: boolean, resolve: (value: SamplerOwnerOutcome) => void): void {
    const final = this.evidence.finalization!
    let settled = false
    let reportFinished = false
    let descendantsClosed = false
    let ownershipBusy = false
    let escalationWork = 0
    const timers: unknown[] = []
    const finish = () => {
      if (settled) return
      settled = true
      for (const timer of timers) this.clock.clear(timer)
      if (this.pending) {
        const pending = this.pending; this.pending = null; this.clock.clear(pending.timer)
        pending.reject(new Error('owned sampler: finalizer settled with a pending request'))
      }
      final.settledAt = this.time(); final.physicalClosed = this.physicalClosed(); final.descendantsClosed = descendantsClosed
      this.finalWake = () => {}
      const complete = this.failures.evidence.count === 0 && reportFinished && Boolean(this.summary) && final.physicalClosed && descendantsClosed
        && final.settledAt.monotonicMs < final.escalation
      resolve({ complete, summary: this.summary, rawSummary: this.terminalRead && typeof this.terminalRead.value === 'object' && this.terminalRead.value !== null
        ? (this.terminalRead.value as { summary?: unknown }).summary ?? null : null, artifact: this.terminalRead ? { path: this.terminalRead.path, bytes: this.terminalRead.bytes,
        sha256: this.terminalRead.sha256, descriptor: this.terminalRead.descriptor } : null, evidence: this.evidence })
    }
    const check = () => {
      if (settled) return
      if (this.clock.now() >= final.escalation && !this.failures.evidence.count) this.failure(new Error('owned sampler: normal finalization incomplete at original12000ms cutoff'))
      if (this.clock.now() > final.deadline) { this.failure(new Error('owned sampler: owner closure exceeded original15000ms deadline')); finish(); return }
      if (reportFinished && this.physicalClosed() && descendantsClosed && escalationWork === 0) finish()
    }
    const qualifyClosure = async () => {
      if (settled || ownershipBusy || !this.physicalClosed() || !this.ownership || descendantsClosed) { check(); return }
      ownershipBusy = true
      try { descendantsClosed = await before(this.ownership.closed(final.deadline), final.deadline, this.clock, 'owned descendant closure') }
      catch (error) { this.failure(error) }
      finally { ownershipBusy = false }
      check()
      if (!settled && !descendantsClosed && this.clock.now() < final.deadline) {
        timers.push(this.clock.schedule(() => { void qualifyClosure() }, Math.min(100, final.deadline - this.clock.now())))
      }
    }
    this.finalWake = () => { check(); if (!settled) void qualifyClosure() }
    const escalate = async (signal: 'SIGTERM' | 'SIGKILL', cutoff: number) => {
      if (settled) return
      escalationWork++
      this.failure(new Error(`owned sampler: ${signal} escalation; original normal-finalization failure is sticky`))
      try {
        samplerAssert(this.ownership && this.clock.now() < cutoff, 'no positively retained owner or no signal time remaining')
        await before(this.ownership.signal(signal, cutoff), cutoff, this.clock, 'owned termination recheck')
      } catch (error) { this.failure(error) }
      finally { escalationWork--; this.finalWake() }
    }
    timers.push(this.clock.schedule(() => { void escalate('SIGTERM', final.kill) }, Math.max(0, final.escalation - this.clock.now())))
    timers.push(this.clock.schedule(() => { void escalate('SIGKILL', final.deadline) }, Math.max(0, final.kill - this.clock.now())))
    timers.push(this.clock.schedule(() => {
      if (settled) return
      this.failure(new Error('owned sampler: original15000ms owner deadline reached with incomplete evidence/closure'))
      finish()
    }, Math.max(0, final.deadline - this.clock.now())))
    if (!this.child) {
      this.failure(new Error(this.evidence.launch?.ownershipUnknown
        ? 'owned sampler: launch returned no handle; acquisition/ownership unknown; outer dispatcher closure required'
        : 'owned sampler: no child acquired before finalization'))
      finish(); return
    }
    void (async () => {
      try {
        samplerAssert(this.binding && this.wire, 'stop has no initialized binding/channel')
        if (cancel && !this.failures.evidence.count) this.failure(new Error('owned sampler: caller requested failed-owner cancellation'))
        const terminal = await this.request('stop', { cancel: cancel || this.failures.evidence.count > 0 }, final.deadline)
        this.terminalRead = await before((this.options.readArtifact ?? readSamplerArtifact)(this.artifactPath, terminal.payload, final.deadline, () => this.clock.now()), final.deadline, this.clock, 'safe artifact read')
        const artifact = validateSamplerArtifact(this.terminalRead.value, this.binding, this.session, process.pid, this.child!.pid!)
        samplerAssert(terminal.payload.complete === artifact.complete, 'terminal/file completeness disagreement')
        this.summary = artifact.summary
        // Child component facts do not stand in for this parent's actual close facts.
        const received = artifact.control.received.values
        samplerAssert(JSON.stringify(received) === JSON.stringify(this.wire.sent.values), 'child did not retain the exact parent request history')
        // The immutable file precedes its own terminal/hash frame. Only that
        // exact pre-terminal prefix is compared; subsequent fatal notices remain
        // separate parent-observed failures and never rewrite the artifact.
        samplerAssert(JSON.stringify(artifact.control.sent.values) === JSON.stringify(this.wire.received.values.slice(0, terminal.sequence - 1)),
          'child sent-history differs from the parent-observed pre-terminal frame prefix')
      } catch (error) {
        if (error instanceof SamplerArtifactReadFailure) this.terminalRead = error.safeRead
        this.evidence.qualificationFailure ??= samplerDescription(error); this.failure(error)
      }
      finally { reportFinished = true; this.finalWake() }
    })()
    void this.closed.then(() => { this.finalWake() })
  }
  assertComplete(outcome: SamplerOwnerOutcome): void {
    samplerAssert(outcome.complete && this.failures.evidence.count === 0 && outcome.summary,
      `owner evidence is not complete: ${this.failures.evidence.retained.map(e => e.text).join('; ')}`)
    requireUsableMemory(outcome.summary)
  }
  async attach(info: Pick<TestInfo, 'attach'>, name: string): Promise<void> {
    if (!this.terminalRead) return
    // Preserve the bytes actually verified through the safe descriptor, not a
    // reopened path which could have been replaced after verification.
    await info.attach(name, { body: this.terminalRead.body, contentType: 'application/json' })
  }
}
