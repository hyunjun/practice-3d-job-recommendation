import { expect } from '@playwright/test'
import type { Page } from '@playwright/test'
import type { Filters } from '../../../shared/types'

type Gate = 'project' | 'preview'
interface ObservedCommand {
  worker: number
  id: number
  kind: string
  revision?: number
  filters?: Filters
  years?: number | null
  now?: number
  bytes?: number
}
interface BrowserControl {
  unavailable: boolean
  requests: ObservedCommand[]
  workers: { id: number; terminated: boolean }[]
  holding: Record<Gate, boolean>
  held: { kind: Gate; request: ObservedCommand; release: () => void }[]
  release: (kind: Gate, all: boolean) => number
}

declare global {
  interface Window { __catalogWorkerQA?: BrowserControl }
}

/**
 * Gate delivery of genuine worker replies, without replacing their contents.
 * Project replies stay FIFO because subsequent compact patches depend on
 * hydration of earlier replies, even when their UI intent is superseded.
 */
export async function installCatalogWorkerControl(page: Page, options: { unavailable?: boolean } = {}) {
  await page.addInitScript(unavailable => {
    const NativeWorker = window.Worker
    const replay = new WeakSet<Event>()
    const state: BrowserControl = {
      unavailable, requests: [], workers: [], holding: { project: false, preview: false }, held: [],
      release(kind, all) {
        if (all) state.holding[kind] = false
        const candidates = state.held.filter(item => item.kind === kind)
        const selected = all ? candidates : candidates.slice(0, 1)
        for (const item of selected) {
          state.held.splice(state.held.indexOf(item), 1)
          item.release()
        }
        return selected.length
      },
    }
    window.__catalogWorkerQA = state
    window.Worker = class extends NativeWorker {
      private readonly catalog: boolean
      private readonly ordinal: number
      constructor(url: URL | string, options?: WorkerOptions) {
        if (state.unavailable && options?.name === 'orbit-catalog')
          throw new DOMException('Fictional browser worker unavailable.', 'NotSupportedError')
        super(url, options)
        this.catalog = options?.name === 'orbit-catalog'
        this.ordinal = this.catalog ? state.workers.length + 1 : 0
        if (!this.catalog) return
        state.workers.push({ id: this.ordinal, terminated: false })
        this.addEventListener('message', (event: MessageEvent<{ id: number; result?: { kind: string } }>) => {
          if (replay.has(event)) return
          const kind = event.data.result?.kind === 'projected' ? 'project'
            : event.data.result?.kind === 'previewed' ? 'preview' : null
          if (!kind || !state.holding[kind]) return
          const request = state.requests.find(item => item.worker === this.ordinal && item.id === event.data.id)
          if (!request) throw new Error('A held worker result has no corresponding request.')
          event.stopImmediatePropagation()
          state.held.push({
            kind, request,
            release: () => {
              const delivered = new MessageEvent('message', { data: event.data })
              replay.add(delivered)
              this.dispatchEvent(delivered)
            },
          })
        })
      }
      override postMessage(value: unknown, transferOrOptions: Transferable[] | StructuredSerializeOptions = []) {
        if (this.catalog) {
          const message = value as { id: number; command: {
            kind: string; revision?: number; body?: ArrayBuffer; filters?: Filters;
            profile?: { years: number | null }; now?: number;
            input?: { filters: Filters; profile: { years: number | null }; now: number };
          } }
          const command = message.command
          state.requests.push({
            worker: this.ordinal, id: message.id, kind: command.kind, revision: command.revision,
            filters: command.input?.filters ?? command.filters,
            years: command.input?.profile.years ?? command.profile?.years,
            now: command.input?.now ?? command.now, bytes: command.body?.byteLength,
          })
        }
        if (Array.isArray(transferOrOptions)) super.postMessage(value, transferOrOptions)
        else super.postMessage(value, transferOrOptions)
      }
      override terminate() {
        const record = state.workers.find(item => item.id === this.ordinal)
        if (record) record.terminated = true
        super.terminate()
      }
    }
  }, options.unavailable ?? false)
  return {
    async hold(kind: Gate) { await page.evaluate(kind => { window.__catalogWorkerQA!.holding[kind] = true }, kind) },
    async held(kind: Gate) {
      return page.evaluate(kind => window.__catalogWorkerQA!.held.filter(item => item.kind === kind).map(item => item.request), kind)
    },
    async releaseOne(kind: Gate) {
      expect(await page.evaluate(kind => window.__catalogWorkerQA!.release(kind, false), kind)).toBe(1)
    },
    async releaseAll(kind: Gate) { await page.evaluate(kind => window.__catalogWorkerQA!.release(kind, true), kind) },
    async workers() { return page.evaluate(() => window.__catalogWorkerQA!.workers) },
    async unavailable(value: boolean) { await page.evaluate(value => { window.__catalogWorkerQA!.unavailable = value }, value) },
    async crash() {
      await expect.poll(() => page.workers().filter(worker => /catalog\.worker/.test(worker.url())).length).toBe(1)
      const worker = page.workers().find(worker => /catalog\.worker/.test(worker.url()))!
      // A real uncaught exception in the dedicated worker invokes the native
      // error event. No app callback or worker result is replaced.
      await worker.evaluate(() => { setTimeout(() => { throw new Error('Fictional Stage67 worker crash.') }, 0) })
    },
  }
}
