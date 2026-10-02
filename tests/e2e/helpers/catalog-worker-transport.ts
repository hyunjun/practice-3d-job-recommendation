import { expect } from '@playwright/test'
import type { Page, TestInfo } from '@playwright/test'

type Gate = 'project' | 'preview'
/** Labelled synthetic corruptions applied to a structured clone of a genuine Worker reply. */
export type SyntheticCorruption = 'unknown-stale-id' | 'missing-protocol'

export interface ObservedRequest {
  worker: number
  id: number
  kind: string
  protocol?: unknown
  revision?: number
  now?: number
  query?: string
  years?: number | null
  bytes?: number
  at: number
}

export interface ObservedReply {
  worker: number
  id: number
  kind: string
  error?: string
  revision?: number
  protocol?: unknown
  bodyIds?: string[]
  jobIds?: string[]
  staleUpdates?: { id: string; stale: boolean | null }[]
  removed?: string[]
  factCount?: number
  bodyChars?: number
  requestKind?: string
  now?: number
  query?: string
  held: boolean
  synthetic: string | null
  at: number
}

export interface ObservedDispatch {
  worker: number
  id: number
  synthetic: string | null
  replay: boolean
  listeners: number
  dispatched: boolean
  at: number
}

interface TransportControl {
  unavailable: boolean
  requests: ObservedRequest[]
  replies: ObservedReply[]
  dispatches: ObservedDispatch[]
  workers: { id: number; terminated: boolean; messageListeners: number }[]
  holding: Record<Gate, boolean>
  held: { kind: Gate; request: ObservedRequest | undefined; release: (synthetic: SyntheticCorruption | null) => void }[]
  retained: { worker: number; id: number; replay: () => void }[]
  release: (kind: Gate, all: boolean, synthetic: SyntheticCorruption | null) => number
  endHold: (kind: Gate) => number
  replay: (worker: number, id: number) => boolean
}

declare global { interface Window { __catalogTransportQA?: TransportControl } }

/**
 * Test-only observation of the genuine catalog Worker message boundary: request envelopes and reply
 * summaries (bodyIds = IDs in patch.jobs, jobIds = complete live membership, staleUpdates, removed,
 * factCount, bodyChars = sum of description lengths, protocol) correlated by worker/request id/time.
 * Observation never mutates a genuine message. Holding replies and delivering a labelled synthetic
 * corruption of a structured clone are explicit, separate controls; replaying a retained genuine
 * reply is labelled same-request delayed delivery. A hold is shared by every catalog Worker the page
 * creates until endHold()/releaseAll() clears it. No product instrumentation is involved and no
 * natural-event or performance claim follows from these records.
 */
export async function installCatalogWorkerTransport(page: Page, options: { unavailable?: boolean } = {}) {
  await page.addInitScript((unavailable: boolean) => {
    const NativeWorker = window.Worker
    const replayed = new WeakSet<Event>()
    const state: TransportControl = {
      unavailable, requests: [], replies: [], dispatches: [], workers: [],
      holding: { project: false, preview: false }, held: [], retained: [],
      release(kind, all, synthetic) {
        if (all) state.holding[kind] = false
        const candidates = state.held.filter(item => item.kind === kind)
        const selected = all ? candidates : candidates.slice(0, 1)
        for (const item of selected) {
          state.held.splice(state.held.indexOf(item), 1)
          item.release(synthetic)
        }
        return selected.length
      },
      // Ends the hold for every current and future catalog Worker without delivering anything. The
      // number of replies still held is returned so a test can assert the hold was already drained.
      endHold(kind) {
        state.holding[kind] = false
        return state.held.filter(item => item.kind === kind).length
      },
      replay(worker, id) {
        const item = state.retained.find(entry => entry.worker === worker && entry.id === id)
        if (!item) return false
        item.replay()
        return true
      },
    }
    window.__catalogTransportQA = state
    type Reply = { id: number; result?: { kind: string; value?: Record<string, unknown> & { revision?: number } }; error?: { code?: string } }
    const corrupt = (payload: Reply, synthetic: SyntheticCorruption) => {
      const value = payload.result?.value as Record<string, unknown> | undefined
      if (!value) return
      if (synthetic === 'unknown-stale-id') {
        const updates = Array.isArray(value.staleUpdates) ? value.staleUpdates : []
        value.staleUpdates = [...updates, { id: 'greenhouse-catalog-worker-ghost', stale: true }]
      }
      if (synthetic === 'missing-protocol') delete value.protocol
    }
    const summarize = (worker: number, data: Reply, request: ObservedRequest | undefined, held: boolean, synthetic: string | null): ObservedReply => {
      const result = data.result
      const summary: ObservedReply = {
        worker, id: data.id, kind: result?.kind ?? 'error', error: data.error?.code,
        requestKind: request?.kind, now: request?.now, query: request?.query, held, synthetic, at: performance.now(),
      }
      if (result?.kind === 'projected' && result.value) {
        const value = result.value as Record<string, unknown>
        const jobs = Array.isArray(value.jobs) ? value.jobs as { id: string; description?: unknown }[] : undefined
        summary.revision = value.revision as number
        summary.protocol = value.protocol
        summary.bodyIds = jobs?.map(job => job.id)
        summary.jobIds = value.jobIds as string[]
        summary.staleUpdates = value.staleUpdates as { id: string; stale: boolean | null }[]
        summary.removed = value.removed as string[]
        summary.factCount = Array.isArray(value.facts) ? value.facts.length : undefined
        summary.bodyChars = jobs?.reduce((sum, job) => sum + (typeof job.description === 'string' ? job.description.length : 0), 0)
      } else if (result?.kind === 'decoded' && result.value) summary.revision = result.value.revision
      return summary
    }
    window.Worker = class extends NativeWorker {
      private readonly catalog: boolean
      private readonly ordinal: number
      private readonly record?: { id: number; terminated: boolean; messageListeners: number }
      private constructed = false
      constructor(url: URL | string, options?: WorkerOptions) {
        if (state.unavailable && options?.name === 'orbit-catalog')
          throw new DOMException('Fictional browser worker unavailable.', 'NotSupportedError')
        super(url, options)
        this.catalog = options?.name === 'orbit-catalog'
        this.ordinal = this.catalog ? state.workers.length + 1 : 0
        if (!this.catalog) return
        const record = { id: this.ordinal, terminated: false, messageListeners: 0 }
        this.record = record
        state.workers.push(record)
        this.addEventListener('message', (event: MessageEvent<Reply>) => {
          if (replayed.has(event)) return
          const data = event.data
          const request = state.requests.find(item => item.worker === this.ordinal && item.id === data.id)
          const kind = data.result?.kind
          const gate: Gate | null = kind === 'projected' ? 'project' : kind === 'previewed' ? 'preview' : null
          const holding = gate !== null && state.holding[gate]
          state.replies.push(summarize(this.ordinal, data, request, holding, null))
          const dispatch = (synthetic: SyntheticCorruption | null, replay: boolean) => {
            let payload: Reply = data
            if (synthetic) { payload = structuredClone(data); corrupt(payload, synthetic) }
            const delivered = new MessageEvent('message', { data: payload })
            replayed.add(delivered)
            const dispatched = this.dispatchEvent(delivered)
            state.dispatches.push({ worker: this.ordinal, id: data.id, synthetic, replay, listeners: record.messageListeners, dispatched, at: performance.now() })
            if (synthetic || replay) state.replies.push(summarize(this.ordinal, payload, request, false, synthetic ?? 'replay'))
          }
          if (gate === 'project') state.retained.push({ worker: this.ordinal, id: data.id, replay: () => dispatch(null, true) })
          if (!holding) return
          event.stopImmediatePropagation()
          state.held.push({ kind: gate!, request, release: synthetic => dispatch(synthetic, false) })
        })
        this.constructed = true
      }
      /**
       * The native Worker declaration types 'message' listeners through WorkerEventMap and accepts no
       * null listener. Both overloads are redeclared here so the observer's own MessageEvent callback
       * above and the client's registration keep their typing, and the implementation forwards a
       * non-null listener to the native method. Only listeners added after construction are counted,
       * which excludes the observer's own listener and keeps the dispatch evidence about the client.
       */
      override addEventListener<K extends keyof WorkerEventMap>(type: K, listener: (this: Worker, ev: WorkerEventMap[K]) => any, options?: boolean | AddEventListenerOptions): void
      override addEventListener(type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions): void
      override addEventListener(type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) {
        if (this.catalog && this.constructed && type === 'message' && this.record) this.record.messageListeners++
        super.addEventListener(type, listener, options)
      }
      override postMessage(value: unknown, transferOrOptions: Transferable[] | StructuredSerializeOptions = []) {
        if (this.catalog) {
          const message = value as { id: number; command: {
            kind: string; protocol?: unknown; revision?: number; body?: ArrayBuffer; now?: number
            filters?: { query?: string }; profile?: { years: number | null }
            input?: { filters: { query?: string }; profile: { years: number | null }; now: number }
          } }
          const command = message.command
          state.requests.push({
            worker: this.ordinal, id: message.id, kind: command.kind, protocol: command.protocol, revision: command.revision,
            now: command.input?.now ?? command.now, query: command.input?.filters.query ?? command.filters?.query,
            years: command.input?.profile.years ?? command.profile?.years, bytes: command.body?.byteLength, at: performance.now(),
          })
        }
        if (Array.isArray(transferOrOptions)) super.postMessage(value, transferOrOptions)
        else super.postMessage(value, transferOrOptions)
      }
      override terminate() {
        if (this.record) this.record.terminated = true
        super.terminate()
      }
    }
  }, options.unavailable ?? false)

  const transport = {
    async hold(kind: Gate) { await page.evaluate(gate => { window.__catalogTransportQA!.holding[gate] = true }, kind) },
    held(kind: Gate) {
      return page.evaluate(gate => window.__catalogTransportQA!.held.filter(item => item.kind === gate).map(item => item.request), kind)
    },
    /** Deliver the oldest held genuine reply, or a labelled synthetic corruption of its structured clone. */
    async releaseOne(kind: Gate, synthetic: SyntheticCorruption | null = null) {
      expect(await page.evaluate(([gate, label]) => window.__catalogTransportQA!.release(gate, false, label), [kind, synthetic] as const)).toBe(1)
    },
    async releaseAll(kind: Gate) { await page.evaluate(gate => window.__catalogTransportQA!.release(gate, true, null), kind) },
    /** End the shared hold without delivering anything; resolves to the number of replies still held. */
    endHold(kind: Gate) { return page.evaluate(gate => window.__catalogTransportQA!.endHold(gate), kind) },
    /** Same-request delayed delivery of a retained genuine reply after an injected corruption. */
    replay(worker: number, id: number) {
      return page.evaluate(([target, requestId]) => window.__catalogTransportQA!.replay(target, requestId), [worker, id] as const)
    },
    requests() { return page.evaluate(() => window.__catalogTransportQA!.requests) },
    replies() { return page.evaluate(() => window.__catalogTransportQA!.replies) },
    dispatches() { return page.evaluate(() => window.__catalogTransportQA!.dispatches) },
    workers() { return page.evaluate(() => window.__catalogTransportQA!.workers) },
    /** The genuine (non-synthetic) projected reply whose request carried this main-thread time. */
    async projectReplyAt(time: string) {
      const now = Date.parse(time)
      let found: ObservedReply | undefined
      await expect.poll(async () => {
        found = (await transport.replies()).find(reply => reply.requestKind === 'project' && reply.kind === 'projected' && reply.now === now && reply.synthetic === null)
        return found !== undefined
      }).toBe(true)
      return found!
    },
    async attach(info: TestInfo, name: string, metadata: Record<string, unknown>) {
      const body = {
        source: 'test-only observation of genuine Worker messages; holds, synthetic corruptions and replays are labelled controls, not natural events or performance measurements',
        ...metadata,
        requests: await transport.requests(), replies: await transport.replies(),
        dispatches: await transport.dispatches(), workers: await transport.workers(),
      }
      await info.attach(name, { body: Buffer.from(JSON.stringify(body, null, 2)), contentType: 'application/json' })
    },
  }
  return transport
}
