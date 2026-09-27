import { expect } from '@playwright/test'
import type { Locator, Page, Route } from '@playwright/test'
import { resourceCheckedTest } from './public-app'
import {
  PRESENTATION_COLLECTION, PRESENTATION_FILTERS, PRESENTATION_PROFILE, PRESENTATION_TIME,
  presentationCatalog, presentationSnapshot, presentationUpdate,
} from '../../fixtures/catalog-presentation'

type Mode = 'globe' | 'flat'
type InitialReply = (route: Route) => Promise<void>
interface ReplyRecord { id: number; kind: string; revision?: number; error?: string; at: number; held: boolean }
interface VisibleRecord { at: number; heading: string; counts: string[]; companies: string[]; loading: string }
interface PresentationControl {
  commands: { id: number; kind: string; revision?: number; at: number }[]
  replies: ReplyRecord[]
  pointer: { type: string; pointerId: number; buttons: number; trusted: boolean; at: number }[]
  visible: VisibleRecord[]
  holdDecoded: boolean
  held: { revision: number; release: () => void }[]
  capture: () => void
}
declare global { interface Window { __catalogPresentationQA?: PresentationControl } }

export interface PresentationHarness {
  mode: Mode
  open: (options?: { mode?: Mode; selectedId?: 'london' | 'amsterdam' | null; expiringAster?: boolean; completePrefix?: boolean; waitInitial?: boolean }) => Promise<void>
  respondInitial: (reply: InitialReply) => void
  take: (after: 1 | 2) => Promise<Route>
  deliver: (stage: 2 | 3, route?: Route) => Promise<ReplyRecord>
  decoded: (revision: number) => Promise<ReplyRecord>
  advance: (milliseconds: number) => Promise<void>
  until: (receipt: ReplyRecord, elapsed: number) => Promise<void>
  hold: () => Promise<void>
  end: () => Promise<void>
  geometry: () => Promise<unknown>
  control: () => Promise<Omit<PresentationControl, 'held' | 'capture'> & { held: number[] }>
  holdDecoded: () => Promise<void>
  releaseDecoded: (revision: number) => Promise<void>
  resetVisible: () => Promise<void>
  finish: () => Promise<void>
  traffic: { path: string; method: string; body: string | null }[]
}

/** Observe genuine worker replies; gate only explicitly requested diagnostic
 * receipts. No worker result, catalog count, map callback or product function
 * is fabricated. Primary gesture tests only observe this boundary. */
async function installObserver(page: Page) {
  await page.addInitScript(() => {
    const NativeWorker = window.Worker
    const replay = new WeakSet<Event>()
    const state: PresentationControl = {
      commands: [], replies: [], pointer: [], visible: [], holdDecoded: false, held: [],
      capture() {
        const record: VisibleRecord = {
          at: performance.now(), heading: document.querySelector('.city-hero-caption h2')?.textContent ?? '',
          counts: [...document.querySelectorAll('.city-detail-count strong')].map(node => node.textContent ?? ''),
          companies: [...document.querySelectorAll('.company-card h3')].map(node => node.textContent ?? ''),
          loading: document.querySelector('.data-status-button')?.textContent ?? '',
        }
        const previous = state.visible.at(-1)
        if (!previous || JSON.stringify({ ...previous, at: 0 }) !== JSON.stringify({ ...record, at: 0 }))
          state.visible.push(record)
      },
    }
    window.__catalogPresentationQA = state
    const observe = () => {
      new MutationObserver(() => state.capture()).observe(document.documentElement, { subtree: true, childList: true, characterData: true })
      state.capture()
    }
    if (document.documentElement) observe()
    else document.addEventListener('DOMContentLoaded', observe, { once: true })
    for (const type of ['pointerdown', 'pointerup', 'pointercancel', 'lostpointercapture']) {
      document.addEventListener(type, event => {
        const pointer = event as PointerEvent
        const target = pointer.target as Element
        if (!target.closest?.('.earth-canvas, .flat-map')) return
        state.pointer.push({ type, pointerId: pointer.pointerId, buttons: pointer.buttons, trusted: pointer.isTrusted, at: performance.now() })
      }, true)
    }
    window.Worker = class extends NativeWorker {
      private readonly catalog: boolean
      constructor(url: URL | string, options?: WorkerOptions) {
        super(url, options)
        this.catalog = options?.name === 'orbit-catalog'
        if (!this.catalog) return
        this.addEventListener('message', (event: MessageEvent<{
          id: number; result?: { kind: string; value?: { revision?: number } }; error?: { code?: string }
        }>) => {
          if (replay.has(event)) return
          const result = event.data.result
          const held = result?.kind === 'decoded' && state.holdDecoded
          state.replies.push({
            id: event.data.id, kind: result?.kind ?? 'error',
            revision: result?.value?.revision, error: event.data.error?.code,
            at: performance.now(), held,
          })
          if (!held) return
          event.stopImmediatePropagation()
          state.held.push({
            revision: result!.value!.revision!,
            release: () => {
              const delivered = new MessageEvent('message', { data: event.data })
              replay.add(delivered)
              this.dispatchEvent(delivered)
            },
          })
        })
      }
      override postMessage(message: unknown, transfer: Transferable[] | StructuredSerializeOptions = []) {
        if (this.catalog) {
          const request = message as { id: number; command: { kind: string; revision?: number } }
          state.commands.push({ id: request.id, kind: request.command.kind, revision: request.command.revision, at: performance.now() })
        }
        if (Array.isArray(transfer)) super.postMessage(message, transfer)
        else super.postMessage(message, transfer)
      }
    }
  })
}

export const presentationTest = resourceCheckedTest.extend<{ presentation: PresentationHarness }>({
  presentation: async ({ page, context, baseURL }, use, info) => {
    const origin = new URL(baseURL!).origin
    const traffic: PresentationHarness['traffic'] = [], errors: string[] = [], unexpected: string[] = []
    const monitors: { after: number; route: Route }[] = []
    let expiringAster = false, latest = 1, heldPointer = false, customInitial = false
    let initialReply: InitialReply = route => route.fulfill({
      status: 202, headers: { 'Retry-After': '1' }, json: presentationSnapshot({ expiringAster }),
    })
    page.on('pageerror', error => errors.push(error.message))
    await context.route('**/*', route => {
      const request = route.request(), url = new URL(request.url()), requestPath = url.pathname + url.search
      if (url.origin !== origin) { unexpected.push(`External ${url.href}`); return route.abort('blockedbyclient') }
      if (!url.pathname.startsWith('/api/')) return route.continue()
      traffic.push({ path: requestPath, method: request.method(), body: request.postData() })
      if (request.method() !== 'GET' || request.postData() !== null) {
        unexpected.push(`Unexpected write ${request.method()} ${url.href}`)
        return route.abort('blockedbyclient')
      }
      if (requestPath === '/api/catalog?source=public' || requestPath === '/api/catalog?source=public&refresh=1')
        return initialReply(route)
      const after = url.searchParams.get('after') === '1' ? 1 : url.searchParams.get('after') === '2' ? 2 : 0
      if (after && requestPath === `/api/catalog/progress?id=${PRESENTATION_COLLECTION}&after=${after}`) {
        monitors.push({ after, route })
        return
      }
      if (requestPath === '/api/observations') return route.fulfill({ json: {
        version: 1, retentionDays: 90, storage: 'ok', days: [], otherSeries: [],
        method: 'observations-1.occupation-6.roles-1.qualifications-1.remote-2.employment-1.purpose-1',
        scope: { key: '6'.repeat(64), boards: [{
          companyId: 'presentation-aster', name: 'Aster Presentation', provider: 'greenhouse', board: 'presentation-aster',
        }] },
      } })
      unexpected.push(`Unexpected API ${request.method()} ${url.href}`)
      return route.abort('blockedbyclient')
    })
    await context.routeWebSocket('**/*', route => {
      if (new URL(route.url()).host === new URL(origin).host) route.connectToServer()
      else { unexpected.push(`External socket ${route.url()}`); route.close() }
    })
    await installObserver(page)
    // Functional scheduler tests deliberately control page time/RAF; these are
    // not performance samples. Worker execution remains genuine and asynchronous.
    await page.clock.install({ time: new Date(PRESENTATION_TIME) })
    const harness: PresentationHarness = {
      mode: 'globe', traffic,
      respondInitial(reply) { customInitial = true; initialReply = reply },
      async open(options = {}) {
        harness.mode = options.mode ?? 'globe'
        expiringAster = options.expiringAster ?? false
        if (options.completePrefix && !customInitial)
          initialReply = route => route.fulfill({ json: presentationCatalog(1, { expiringAster, complete: true }) })
        await page.addInitScript(({ profile, exploration }) => {
          if (sessionStorage.getItem('catalog-presentation-seeded')) return
          localStorage.setItem('orbit.v1.profile', JSON.stringify(profile))
          localStorage.setItem('orbit.v1.exploration', JSON.stringify(exploration))
          sessionStorage.setItem('catalog-presentation-seeded', 'true')
        }, {
          profile: PRESENTATION_PROFILE,
          exploration: {
            source: 'public', mapMode: harness.mode, selectedId: options.selectedId === undefined ? 'london' : options.selectedId,
            panelTab: 'cities', citySort: 'companies', filters: PRESENTATION_FILTERS,
          },
        })
        await page.goto('/')
        await expect(page.getByRole('button', { name: harness.mode === 'globe' ? '3D 지구' : '2D 지도', exact: true })).toHaveAttribute('aria-pressed', 'true')
        if (harness.mode === 'globe') {
          await expect(page.locator('.earth-canvas')).toHaveClass(/is-ready/)
          await expect(page.locator('.flat-map')).toHaveCount(0)
          expect(await page.locator('.earth-canvas > canvas').evaluate(element => {
            const gl = (element as HTMLCanvasElement).getContext('webgl2')!
            return gl.getParameter(gl.VERSION) as string
          })).toMatch(/WebGL 2/)
        } else await expect(page.locator('.flat-map svg')).toBeVisible()
        if (options.waitInitial !== false) {
          if (options.selectedId === null) await expect(page.locator('.city-row-main')).toHaveCount(2)
          else await expect(page.locator('.city-detail-count strong')).toHaveText(options.selectedId === 'amsterdam' ? ['1', '1'] : ['1', '2'])
        }
        await page.evaluate(async () => { await document.fonts.ready })
        const pauseAt = await page.evaluate(() => Date.now() + 1000)
        await page.clock.pauseAt(new Date(pauseAt))
        await page.clock.runFor(1250)
        await harness.resetVisible()
      },
      async take(after) {
        await expect.poll(() => monitors.filter(item => item.after === after).length).toBe(1)
        const index = monitors.findIndex(item => item.after === after)
        return monitors.splice(index, 1)[0].route
      },
      async deliver(stage, supplied) {
        const route = supplied ?? await harness.take(stage === 2 ? 1 : 2)
        await route.fulfill({ headers: { 'Retry-After': '1' }, json: presentationUpdate(stage, { expiringAster }) })
        latest = stage
        return harness.decoded(stage)
      },
      async decoded(revision) {
        await expect.poll(() => page.evaluate(revision => window.__catalogPresentationQA!.replies.some(reply => reply.kind === 'decoded' && reply.revision === revision), revision)).toBe(true)
        // A round trip follows the real message's microtasks, before time moves.
        return page.evaluate(revision => window.__catalogPresentationQA!.replies.find(reply => reply.kind === 'decoded' && reply.revision === revision)!, revision)
      },
      async advance(milliseconds) { await page.clock.runFor(milliseconds) },
      async until(receipt, elapsed) {
        const current = await page.evaluate(() => performance.now())
        const remaining = receipt.at + elapsed - current
        expect(remaining, 'Test setup advanced past the boundary under review').toBeGreaterThanOrEqual(0)
        await page.clock.runFor(remaining)
      },
      async geometry() {
        if (harness.mode === 'flat') return page.locator('.flat-map svg > g').getAttribute('transform')
        return page.locator('.globe-pin').evaluateAll(elements => elements.map(element => ({
          label: element.getAttribute('aria-label'), transform: (element as HTMLElement).style.transform,
        })))
      },
      async hold() {
        const surface = page.locator(harness.mode === 'globe' ? '.earth-canvas > canvas' : '.flat-map svg')
        const box = (await surface.boundingBox())!
        const before = await harness.geometry()
        const x = box.x + box.width * .28, y = box.y + box.height * .80
        expect(await page.evaluate(({ x, y }) => {
          const target = document.elementFromPoint(x, y)
          return !!target?.closest('.earth-canvas, .flat-map') && !target.closest('.globe-pin, [data-map-marker]')
        }, { x, y })).toBe(true)
        await page.mouse.move(x, y)
        await page.mouse.down()
        heldPointer = true
        await page.mouse.move(x + 45, y - 24, { steps: 6 })
        await page.clock.runFor(32)
        expect(await harness.geometry()).not.toEqual(before)
        const state = await harness.control()
        expect(state.pointer.at(-1)).toMatchObject({ type: 'pointerdown', buttons: 1, trusted: true })
      },
      async end() { await page.mouse.up(); heldPointer = false },
      async control() {
        return page.evaluate(() => {
          const state = window.__catalogPresentationQA!
          return { commands: state.commands, replies: state.replies, pointer: state.pointer, visible: state.visible, holdDecoded: state.holdDecoded, held: state.held.map(item => item.revision) }
        })
      },
      async holdDecoded() { await page.evaluate(() => { window.__catalogPresentationQA!.holdDecoded = true }) },
      async releaseDecoded(revision) {
        await page.evaluate(revision => {
          const state = window.__catalogPresentationQA!, index = state.held.findIndex(item => item.revision === revision)
          if (index < 0) throw new Error('No held genuine decoded receipt ' + revision)
          const [held] = state.held.splice(index, 1)
          state.holdDecoded = false
          held.release()
        }, revision)
      },
      async resetVisible() {
        await page.evaluate(() => { const state = window.__catalogPresentationQA!; state.visible = []; state.capture() })
      },
      async finish() {
        if (heldPointer) await harness.end()
        if (latest === 1) {
          if (!monitors.some(item => item.after === 1)) await harness.advance(1000)
          await harness.deliver(2)
        }
        if (latest === 2) {
          await harness.advance(1000)
          await harness.deliver(3)
        }
        await harness.advance(1500)
        await expect(page.locator('.collection-progress')).toHaveCount(0)
        await expect(page.locator('.data-status-button')).toContainText('공개 채용')
      },
    }
    try {
      await use(harness)
    } finally {
      await info.attach('catalog-presentation-evidence', {
        body: Buffer.from(JSON.stringify({
          source: 'fictional public HTTP payloads / genuine worker receipts / visible DOM',
          traffic, errors, unexpected, control: await harness.control().catch(() => null),
        }, null, 2)), contentType: 'application/json',
      })
      if (heldPointer) await page.mouse.up().catch(() => {})
    }
    expect(unexpected).toEqual([])
    expect(errors).toEqual([])
    expect(traffic.every(request => request.method === 'GET' && request.body === null)).toBe(true)
    expect(JSON.stringify(traffic)).not.toContain(PRESENTATION_PROFILE.name)
    expect(JSON.stringify(traffic)).not.toContain('PRIVATE_PRESENTATION_QUERY')
  },
})

export const presentationHeading = (page: Page) => page.locator('.city-hero-caption h2')
export const presentationCounts = (page: Page) => page.locator('.city-detail-count strong')
export const presentationQuery = (page: Page) => page.getByRole('textbox', { name: '도시, 회사 또는 포지션 검색', exact: true })
export async function activateWithKeyboard(locator: Locator) { await locator.focus(); await locator.press('Enter') }
