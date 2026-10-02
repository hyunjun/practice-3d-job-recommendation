import { vi } from 'vitest'
import { CatalogWorkerModel } from '../../../src/lib/catalog-worker-model'
import type { CatalogWorkerRequest, CatalogWorkerResponse } from '../../../src/lib/catalog-worker-types'

export type ReplyGate = 'project' | 'preview' | 'decoded' | 'acknowledged' | 'error'
/** Returns a modified copy of a genuine reply. Used only for explicitly labelled synthetic corruption. */
export type ReplyMutation = (reply: CatalogWorkerResponse) => CatalogWorkerResponse

export interface HeldReply {
  kind: ReplyGate
  requestId: number
  reply: CatalogWorkerResponse
  deliver: (mutate?: ReplyMutation) => void
}

/**
 * In-process stand-in for the browser Worker. It runs the real CatalogWorkerModel, serialises
 * commands FIFO, structured-clones requests and replies like a Worker boundary, and records
 * every genuine reply. It never fabricates results: a held reply is the genuine one, and a
 * mutation is applied to a structured clone that the test labels as synthetic corruption.
 * This is a unit double, not a browser Worker thread or a performance measurement.
 */
export class CatalogWorkerDouble extends EventTarget {
  static instances: CatalogWorkerDouble[] = []
  readonly model = new CatalogWorkerModel()
  readonly commands: CatalogWorkerRequest[] = []
  readonly replies: CatalogWorkerResponse[] = []
  readonly terminate = vi.fn()
  readonly holding = new Set<ReplyGate>()
  readonly held: HeldReply[] = []
  private queue = Promise.resolve()
  constructor(readonly url: URL, readonly options: WorkerOptions) { super(); CatalogWorkerDouble.instances.push(this) }

  postMessage(message: CatalogWorkerRequest, transfer: Transferable[] = []) {
    const copied = structuredClone(message, { transfer })
    this.commands.push(copied)
    this.queue = this.queue.then(async () => {
      let response: CatalogWorkerResponse
      try { response = { id: copied.id, result: await this.model.handle(copied.command) } }
      catch (error) {
        const cause = error as Error & { code?: string; retryAt?: string }
        response = { id: copied.id, error: { message: cause.message, code: cause.code, retryAt: cause.retryAt } }
      }
      const reply = structuredClone(response)
      const kind: ReplyGate = 'result' in reply
        ? reply.result.kind === 'projected' ? 'project' : reply.result.kind === 'previewed' ? 'preview' : reply.result.kind
        : 'error'
      const deliver = (mutate?: ReplyMutation) => {
        const delivered = mutate ? mutate(structuredClone(reply)) : reply
        this.replies.push(delivered)
        this.dispatchEvent(new MessageEvent('message', { data: delivered }))
      }
      if (this.holding.has(kind)) { this.held.push({ kind, requestId: copied.id, reply, deliver }); return }
      deliver()
    })
  }

  /** Wait until the model has produced replies for every command posted so far. */
  async settle() { await this.queue }

  heldOf(kind: ReplyGate) { return this.held.filter(item => item.kind === kind) }

  /** Deliver the oldest held reply of a kind, optionally as a labelled synthetic mutation of its clone. */
  releaseOne(kind: ReplyGate, mutate?: ReplyMutation) {
    const index = this.held.findIndex(item => item.kind === kind)
    if (index < 0) throw new Error(`No held ${kind} reply`)
    const [item] = this.held.splice(index, 1)
    item.deliver(mutate)
    return item
  }

  releaseAll(kind: ReplyGate) {
    this.holding.delete(kind)
    for (const item of this.heldOf(kind)) {
      this.held.splice(this.held.indexOf(item), 1)
      item.deliver()
    }
  }
}

export function installCatalogWorkerDouble() {
  CatalogWorkerDouble.instances = []
  vi.stubGlobal('Worker', CatalogWorkerDouble)
}

export const projectedReplies = (double: CatalogWorkerDouble) => double.replies.flatMap(reply =>
  'result' in reply && reply.result.kind === 'projected' ? [reply.result.value] : [])
