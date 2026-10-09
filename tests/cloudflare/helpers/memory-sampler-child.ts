import { createHash } from 'node:crypto'
import { open } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { MemorySampler } from './instrumentation'
import type { CommandLease, MemorySample } from './instrumentation'
import {
  SamplerFailures, SamplerRetention, SamplerWire,
  samplerAssert, samplerDescription, samplerLeaseFacts, samplerTime, sealSamplerArtifact, validateSamplerBinding,
} from './memory-sampler-process'
import type { SamplerArtifact, SamplerBinding, SamplerFrame, SamplerOperation, SamplerPhase } from './memory-sampler-process'

/**
 * The actual child exit policy, with only the process properties it owns exposed
 * for literal witnesses. Selecting an exit code never forces physical exit.
 */
export class SamplerChildExitPolicy {
  constructor(readonly failures: SamplerFailures,
    private readonly child: { exitCode?: number | string | null; connected: boolean; disconnect?: () => void }) {}
  fail(error: unknown): void {
    // IPC may already be disconnected and finish() may already be cached. The
    // physical exit outcome must still carry every subsequently caught failure.
    this.child.exitCode = 1
    this.failures.add(error)
  }
  shutdown(): void {
    this.child.exitCode = this.failures.evidence.count ? 1 : 0
    try {
      if (!this.child.connected) return
      const disconnect = this.child.disconnect
      samplerAssert(typeof disconnect === 'function', 'connected child disconnect is unavailable')
      disconnect.call(this.child)
    } catch (error) { this.fail(error) }
  }
}

/**
 * Checked-in test child; no generated program, listener, shell or private loader
 * API. Imported definitions alone do not launch this entry. Parent readiness
 * follows completion of the existing tsx/shared-sampler imports.
 */
async function main(exitPolicy: SamplerChildExitPolicy): Promise<void> {
  samplerAssert(process.argv.length === 4 && process.argv[2] === '--orbit-sampler'
    && process.send && process.connected, 'checked-in child needs one owned IPC session')
  const session = process.argv[3]
  const wire = new SamplerWire(session, process.pid, process.ppid, 'child')
  const failures = exitPolicy.failures
  const retention = new SamplerRetention()
  const leases: CommandLease[] = []
  const finalized = new Map<number, string>()
  const phases: SamplerPhase[] = []
  let binding: SamplerBinding | null = null
  let sampler: MemorySampler | null = null
  let state: 'ready' | 'active' | 'stopping' | 'terminal' = 'ready'
  let requestId = 0
  let operation: SamplerOperation = 'initialize'
  let requestBusy = false
  let lastFatalState: string | null = null
  let cancellationStarted = false
  let cancelledResolve!: () => void
  const cancelled = new Promise<void>(resolve => { cancelledResolve = resolve })
  let finishPromise: Promise<void> | null = null
  const signatures = (lease: CommandLease) => {
    const o = lease.observation
    // Fixed counters only; never serialize the growing summary in a data event.
    return [o.callbackCount, o.settlements, o.observerFailures.count, o.child.exit.count, o.child.close.count, o.child.error.count,
      o.stdout.data.count, o.stdout.end.count, o.stdout.close.count, o.stdout.error.count,
      o.stderr.data.count, o.stderr.end.count, o.stderr.close.count, o.stderr.error.count].join(':')
  }
  const send = (kind: SamplerFrame['kind'], op: SamplerOperation, payload: Record<string, unknown>, id: number): Promise<void> => {
    return new Promise((resolve, reject) => {
      try {
        samplerAssert(process.send && process.connected, 'child IPC unavailable')
        const { raw } = wire.encode(kind, op, payload, id)
        process.send(raw, (error: Error | null) => error ? reject(error) : resolve())
      } catch (error) { reject(error) }
    })
  }
  const cancelCommands = () => {
    sampler?.cancelSampling()
    if (cancellationStarted) { cancelledResolve(); return }
    cancellationStarted = true
    for (const lease of leases) {
      if (lease.observedTerminal()) continue
      try {
        const result = lease.cancel()
        if (!result.requested && !lease.observedTerminal()) failures.add(result.reason)
      } catch (error) { failures.add(error) }
    }
    cancelledResolve()
  }
  const fail = (error: unknown) => {
    exitPolicy.fail(error)
    cancelCommands()
    // At most one fatal notice per active/terminal substate; all descriptions and
    // counters stay bounded. A later failure does not rewrite a sealed artifact.
    if (process.connected && lastFatalState !== state) {
      lastFatalState = state
      void send('fatal', operation, { failure: samplerDescription(error), stage: state }, requestId).catch(sendError => {
        exitPolicy.fail(sendError)
      })
    }
  }
  const shutdown = () => {
    exitPolicy.shutdown()
    // Let Node close its acquired pipes naturally. An unrefed loader descendant
    // is still independently attributed and checked by the parent owner.
  }
  const finish = (cancel: boolean, replyId: number | null): Promise<void> => {
    if (finishPromise) return finishPromise
    state = 'stopping'
    finishPromise = (async () => {
      try {
        if (cancel) {
          if (!failures.evidence.count) failures.add('parent requested cancellation of an already failed owner')
          cancelCommands()
          if (sampler?.pendingSample()) await Promise.race([sampler.pendingSample()!, cancelled])
        } else {
          samplerAssert(sampler, 'normal stop before initialization')
          // Original6000ms join then eligible final5000ms acquisition. The
          // parent's original12s/13.5s/15s policy owns exceptional termination.
          await sampler.stop()
        }
        if (sampler?.pendingSample()) {
          // A missed original join never authorizes a replacement command.
          fail(new Error('sampler command remained pending after its original join'))
          await Promise.race([sampler.pendingSample()!, cancelled])
        }
        for (const lease of leases) {
          await Promise.race([lease.terminal, cancelled])
          if (!lease.observedTerminal()) failures.add(`command ${lease.observation.sequence}: terminal observations unconfirmed`)
          if (lease.observation.observerFailures.count || lease.observation.child.error.count
            || lease.observation.stdout.error.count || lease.observation.stderr.error.count) failures.add(`command ${lease.observation.sequence}: retained observer/stdio failure`)
        }
        samplerAssert(binding && sampler, 'cannot seal an artifact without validated initialization')
        const summary = sampler.summary()
        for (const error of summary.errors) failures.add(error)
        if (!summary.usable) failures.add('complete owned memory interval is unusable')
        // Every acquired lease, including the final sample, is accounted. A
        // producer throw or unfinished sample makes this partial evidence.
        if (leases.length !== summary.sampleCount) failures.add('sample/attempted lease count differs')
        const artifact: SamplerArtifact = {
          version: 1, session, binding, parentPid: process.ppid, childPid: process.pid,
          clocks: { parent: `parent ${process.ppid}: performance.now; receipt deadline authority`,
            child: `child ${process.pid}: performance.now; command/phase observations only` },
          phases, control: { received: wire.received, sent: wire.sent }, summary,
          leases: leases.map(samplerLeaseFacts), retention: retention.evidence(),
          complete: failures.evidence.count === 0, failures: failures.evidence, terminalOverflow: null,
        }
        // Incremental per-record accounting reserved4MiB terminal metadata plus
        //1024 bytes per lease. This final check includes escaping and every field.
        const sealed = sealSamplerArtifact(artifact)
        const body = sealed.body
        if (sealed.overflow) failures.add(`terminal envelope overflow: ${JSON.stringify(sealed.overflow)}`)
        try {
          const file = await open(binding.artifactPath, 'wx', 0o600)
          try { await file.writeFile(body); await file.sync() } finally { await file.close() }
        } catch (error) {
          throw new Error(`terminal artifact write/closure unconfirmed; originalBytes=${sealed.overflow?.originalBytes ?? body.length}; candidateBytes=${body.length}; samples=${summary.samples.length}; leases=${leases.length}; overflow=${JSON.stringify(sealed.overflow)}; ${samplerDescription(error).text}`)
        }
        const terminal = { path: binding.artifactPath, bytes: body.length, sha256: createHash('sha256').update(body).digest('hex'), complete: sealed.complete }
        state = 'terminal'
        if (replyId !== null) await send('terminal', 'stop', terminal, replyId)
      } catch (error) { fail(error) }
      finally { shutdown() }
    })()
    return finishPromise
  }
  const receive = async (value: unknown) => {
    // Capture arrival immediately. Producer timestamps do not qualify parent deadlines.
    const enteredAt = samplerTime()
    try {
      const frame = wire.receive(value)
      samplerAssert(frame.kind === 'request' && frame.requestId === frame.sequence && !requestBusy, 'overlapping/invalid parent request')
      samplerAssert(state !== 'terminal' && state !== 'stopping', 'request after stop')
      requestBusy = true
      requestId = frame.requestId; operation = frame.operation
      if (frame.operation === 'initialize') {
        samplerAssert(state === 'ready' && !sampler && !binding && failures.evidence.count === 0, 'initialize replay or failed startup')
        validateSamplerBinding(frame.payload)
        binding = frame.payload
        samplerAssert(binding.runtime.registryPath === process.env.ORBIT_PROCESS_REGISTRY
          && binding.actor === process.env.ORBIT_VERIFICATION_ACTOR
          && binding.run === path.basename(path.dirname(binding.runtime.registryPath)), 'child run/actor/registry mismatch')
        sampler = new MemorySampler(binding.runtime, {
          lifetime(lease) {
            samplerAssert(leases.length < 8192, 'command lease retention exceeds8192')
            leases.push(lease)
            let observationFailureReported = false
            let laterMutationReported = false
            lease.onChange(() => {
              const o = lease.observation
              if (!observationFailureReported && (o.invocationFailure || o.observerFailures.count
                || o.child.error.count || o.stdout.error.count || o.stderr.error.count)) {
                observationFailureReported = true
                fail(new Error(`command ${o.sequence}: producer/observer failure; exact returned-handle ownership may be unavailable`))
              }
              const previous = finalized.get(lease.observation.sequence)
              if (!laterMutationReported && previous && previous !== signatures(lease)) {
                laterMutationReported = true
                fail(new Error(`command ${lease.observation.sequence}: later observation after per-record finalization`))
              }
            })
          },
        }, {
          beforeSample() {
            try {
              samplerAssert(failures.evidence.count === 0, 'failed owner cannot acquire another sample')
              retention.beforeSample()
            } catch (error) { fail(error); throw error }
          },
          async retainSample(sample: MemorySample): Promise<MemorySample> {
            const lease = leases.find(item => item.observation === sample.commandObservation)
            samplerAssert(lease, 'sample is missing its exact command lease')
            await Promise.race([lease.terminal, cancelled])
            if (!lease.observedTerminal()) fail(new Error(`command ${lease.observation.sequence}: missing physical command/stdio closure`))
            // Snapshot a single completed/explicitly failed record. Its original
            // holder remains observed: any later mutation invalidates the owner.
            const serialized = JSON.stringify(sample)
            try { retention.account(Buffer.byteLength(serialized), serialized) }
            catch (error) { fail(error); throw error }
            const plain = JSON.parse(serialized) as MemorySample
            finalized.set(lease.observation.sequence, signatures(lease))
            return plain
          },
        })
        sampler.start(250)
        state = 'active'
        const acceptedAt = samplerTime()
        await send('ack', 'initialize', { binding, cadenceStarted: true, acceptedAt }, requestId)
      } else if (frame.operation === 'phase') {
        samplerAssert(state === 'active' && sampler && failures.evidence.count === 0, 'phase outside active cadence')
        samplerAssert(phases.length < 64, 'phase history exceeds64')
        const phase = frame.payload.phase as string
        sampler.phase = phase
        phases.push({ phase, at: enteredAt })
        await send('ack', 'phase', { phase, acceptedAt: enteredAt }, requestId)
      } else {
        samplerAssert(frame.payload.cancel === true || failures.evidence.count === 0, 'failed child needs cancellation stop')
        await finish(frame.payload.cancel === true, requestId)
      }
    } catch (error) {
      fail(error)
      if (state === 'ready') { await finish(true, null) }
    } finally { requestBusy = false }
  }
  process.on('message', value => { void receive(value) })
  process.on('error', error => { fail(error); void finish(true, null) })
  process.on('disconnect', () => {
    if (state === 'terminal') return
    fail(new Error('parent IPC disconnected before terminal shutdown')); void finish(true, null)
  })
  process.on('SIGTERM', () => { fail(new Error('owned parent requested SIGTERM escalation')); void finish(true, null) })
  // A successful send callback only confirms the control announcement was sent.
  await send('ready', 'initialize', { controlReady: true, parentPid: process.ppid }, 0)
}

// The checked-in native launcher supplies this exact entry path. Importing the
// exit-policy witness seam does not launch a child, install handlers or send IPC.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const exitPolicy = new SamplerChildExitPolicy(new SamplerFailures(), process)
  void main(exitPolicy).catch(error => {
    // Startup failed before a usable protocol existed. Parent retains native
    // error/exit/stdio evidence; keep the original failure in the same bounded
    // policy before attempting callable, receiver-preserving IPC cleanup.
    exitPolicy.fail(error)
    exitPolicy.shutdown()
  })
}
