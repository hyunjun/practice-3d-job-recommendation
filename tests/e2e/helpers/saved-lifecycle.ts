import { expect } from '@playwright/test'
import type { ElementHandle, Locator, Page, TestInfo } from '@playwright/test'
import type { SavedJob } from '../../../shared/types'

/**
 * Stage78 lifecycle helpers. Every signal here is deliberately synthetic: it
 * exercises the application's listener path and is never evidence of a native
 * back/forward-cache restoration, an operating-system tab switch or a window
 * manager focus change. Database access by these helpers targets only the
 * ephemeral Playwright context's own saved database with fixture records, and
 * every helper-owned connection is registered with the probe so that only the
 * application's own requests are ever counted. Required images are captured
 * through captureFrame, which exposes semantic targets with the product's own
 * scrolling, verifies their geometry and attaches a measured geometry record
 * beside each image.
 */
export const SAVED_DATABASE_NAME = 'orbit-saved-opportunities'
export type ReturnSignal = 'focus' | 'visibilitychange' | 'pageshow'
export const RETURN_SIGNALS: ReturnSignal[] = ['focus', 'visibilitychange', 'pageshow']

/** Dispatch one visible return signal, or a synchronous burst of all of them twice. */
export async function dispatchReturn(page: Page, signal: ReturnSignal | 'burst'): Promise<void> {
  await page.evaluate(signal => {
    const fire = (name: string) => {
      if (name === 'visibilitychange') document.dispatchEvent(new Event('visibilitychange'))
      else if (name === 'pageshow') window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }))
      else window.dispatchEvent(new Event('focus'))
    }
    const names = signal === 'burst' ? ['focus', 'visibilitychange', 'pageshow', 'focus', 'visibilitychange', 'pageshow'] : [signal]
    for (const name of names) fire(name)
  }, signal)
}

/** Signals the contract excludes: a non-persisted pageshow and focus events that are not the Window's own focus. */
export async function dispatchExcludedSignal(page: Page, kind: 'pageshow-not-persisted' | 'focusin' | 'element-focus'): Promise<void> {
  await page.evaluate(kind => {
    if (kind === 'pageshow-not-persisted') window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: false }))
    else if (kind === 'focusin') document.body.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
    else document.body.dispatchEvent(new FocusEvent('focus'))
  }, kind)
}

/** Shadow document.visibilityState for the page's own scripts; null restores the native accessor. Synthetic. */
export async function overrideVisibility(page: Page, state: 'hidden' | 'visible' | null): Promise<void> {
  await page.evaluate(state => {
    if (state === null) { Reflect.deleteProperty(document, 'visibilityState'); return }
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state })
  }, state)
}

export interface StorageProbe { reads: number; mutations: number }

/**
 * Count the application's full saved-collection reads (getAll on records) and
 * every put/add/delete request on the saved database. Exclusion is by
 * connection identity: a helper registers each connection it opens in the
 * probe's owned set before issuing any request, so application requests on the
 * application's own connection stay counted even while a helper is mid-flight.
 * Install only after the page is ready, because the very first open of a fresh
 * profile legitimately writes its migration marker.
 */
export async function installStorageProbe(page: Page): Promise<void> {
  await page.evaluate(name => {
    const probe = { reads: 0, mutations: 0, owned: new WeakSet<IDBDatabase>() }
    Reflect.set(window, '__savedLifecycleProbe', probe)
    const counted = (store: IDBObjectStore) => {
      const db = store.transaction.db
      return db.name === name && !probe.owned.has(db)
    }
    const getAll = IDBObjectStore.prototype.getAll
    IDBObjectStore.prototype.getAll = function (...args) {
      if (counted(this) && this.name === 'records') probe.reads++
      return Reflect.apply(getAll, this, args)
    }
    const put = IDBObjectStore.prototype.put
    IDBObjectStore.prototype.put = function (...args) {
      if (counted(this)) probe.mutations++
      return Reflect.apply(put, this, args)
    }
    const add = IDBObjectStore.prototype.add
    IDBObjectStore.prototype.add = function (...args) {
      if (counted(this)) probe.mutations++
      return Reflect.apply(add, this, args)
    }
    const remove = IDBObjectStore.prototype.delete
    IDBObjectStore.prototype.delete = function (...args) {
      if (counted(this)) probe.mutations++
      return Reflect.apply(remove, this, args)
    }
  }, SAVED_DATABASE_NAME)
}

export async function storageProbe(page: Page): Promise<StorageProbe> {
  return page.evaluate(() => {
    const probe = Reflect.get(window, '__savedLifecycleProbe') as StorageProbe | undefined
    if (!probe) throw new Error('The saved storage probe is not installed on this page')
    return { reads: probe.reads, mutations: probe.mutations }
  })
}

/** Read committed records newest-first without waiting on the navigation busy state. */
export async function readCommitted(page: Page): Promise<SavedJob[]> {
  return page.evaluate(name => new Promise<SavedJob[]>((resolve, reject) => {
    const opening = indexedDB.open(name)
    opening.onupgradeneeded = () => { opening.transaction?.abort(); reject(new Error('Saved database has not been initialized')) }
    opening.onerror = () => reject(opening.error)
    opening.onsuccess = () => {
      const db = opening.result
      // Register this helper-owned connection before any request so the probe never attributes it to the application.
      ;(Reflect.get(window, '__savedLifecycleProbe') as { owned: WeakSet<IDBDatabase> } | undefined)?.owned.add(db)
      const tx = db.transaction('records', 'readonly')
      const request = tx.objectStore('records').getAll()
      tx.oncomplete = () => {
        db.close()
        resolve(request.result.sort((a, b) => b.order - a.order || a.id.localeCompare(b.id)).map(entry => entry.record))
      }
      tx.onabort = () => { db.close(); reject(tx.error) }
    }
  }), SAVED_DATABASE_NAME)
}

/** Rewrite one committed record in place (same key and order) without any notification, like another writer whose message was never delivered. */
export async function rewriteSavedRecord(page: Page, id: string, patch: {
  note?: string; status?: SavedJob['status']; job?: Record<string, unknown>; company?: Record<string, unknown>
}): Promise<void> {
  await page.evaluate(({ name, id, patch }) => new Promise<void>((resolve, reject) => {
    const opening = indexedDB.open(name)
    opening.onupgradeneeded = () => { opening.transaction?.abort(); reject(new Error('Saved database has not been initialized')) }
    opening.onerror = () => reject(opening.error)
    opening.onsuccess = () => {
      const db = opening.result
      ;(Reflect.get(window, '__savedLifecycleProbe') as { owned: WeakSet<IDBDatabase> } | undefined)?.owned.add(db)
      const tx = db.transaction('records', 'readwrite')
      const store = tx.objectStore('records')
      const reading = store.get(id)
      reading.onsuccess = () => {
        const entry = reading.result
        if (!entry) { tx.abort(); return }
        const record = { ...entry.record }
        if (patch.note !== undefined) record.note = patch.note
        if (patch.status !== undefined) record.status = patch.status
        if (patch.job) record.job = { ...record.job, ...patch.job }
        if (patch.company) record.company = { ...record.company, ...patch.company }
        store.put({ ...entry, record })
      }
      tx.oncomplete = () => { db.close(); resolve() }
      tx.onabort = () => { db.close(); reject(tx.error ?? new Error(`No committed record ${id} to rewrite`)) }
    }
  }), { name: SAVED_DATABASE_NAME, id, patch })
}

/** Put an arbitrary raw entry (for example an unreadable wrapper or an old sample) into the records store. */
export async function putRawSavedEntry(page: Page, entry: unknown): Promise<void> {
  await page.evaluate(({ name, entry }) => new Promise<void>((resolve, reject) => {
    const opening = indexedDB.open(name)
    opening.onupgradeneeded = () => { opening.transaction?.abort(); reject(new Error('Saved database has not been initialized')) }
    opening.onerror = () => reject(opening.error)
    opening.onsuccess = () => {
      const db = opening.result
      ;(Reflect.get(window, '__savedLifecycleProbe') as { owned: WeakSet<IDBDatabase> } | undefined)?.owned.add(db)
      const tx = db.transaction('records', 'readwrite')
      tx.objectStore('records').put(entry)
      tx.oncomplete = () => { db.close(); resolve() }
      tx.onabort = () => { db.close(); reject(tx.error) }
    }
  }), { name: SAVED_DATABASE_NAME, entry })
}

export async function rawSavedState(page: Page): Promise<{ entries: unknown[]; meta: Record<string, unknown> | undefined }> {
  return page.evaluate(name => new Promise((resolve, reject) => {
    const opening = indexedDB.open(name)
    opening.onupgradeneeded = () => { opening.transaction?.abort(); reject(new Error('Saved database has not been initialized')) }
    opening.onerror = () => reject(opening.error)
    opening.onsuccess = () => {
      const db = opening.result
      ;(Reflect.get(window, '__savedLifecycleProbe') as { owned: WeakSet<IDBDatabase> } | undefined)?.owned.add(db)
      const tx = db.transaction(['records', 'meta'], 'readonly')
      const entries = tx.objectStore('records').getAll()
      const meta = tx.objectStore('meta').get('state')
      tx.oncomplete = () => { db.close(); resolve({ entries: entries.result, meta: meta.result }) }
      tx.onabort = () => { db.close(); reject(tx.error) }
    }
  }), SAVED_DATABASE_NAME)
}

export interface NavBusyLog {
  initial: string | null
  transitions: { oldValue: string | null; value: string | null }[]
}

/**
 * Record the initial aria-busy value of the saved navigation button and every
 * individual attribute mutation with its old value, so a true that was already
 * reverted when the observer callback ran still leaves a visible trace.
 */
export async function watchNavBusy(page: Page): Promise<void> {
  await page.evaluate(() => {
    const button = [...document.querySelectorAll<HTMLButtonElement>('.main-nav button')].find(item => item.textContent?.includes('저장한 기회'))
    if (!button) throw new Error('The saved navigation button is missing')
    const log: NavBusyLog = { initial: button.getAttribute('aria-busy'), transitions: [] }
    Reflect.set(window, '__savedNavBusyLog', log)
    new MutationObserver(records => {
      for (const record of records) log.transitions.push({ oldValue: record.oldValue, value: button.getAttribute('aria-busy') })
    }).observe(button, { attributes: true, attributeOldValue: true, attributeFilter: ['aria-busy'] })
  })
}

export async function navBusyLog(page: Page): Promise<NavBusyLog> {
  return page.evaluate(() => (Reflect.get(window, '__savedNavBusyLog') as NavBusyLog | undefined) ?? { initial: null, transitions: [] })
}

/** Background reads must never make the navigation busy: the watcher saw false at install and no transition touched true. */
export async function expectNeverBusy(page: Page): Promise<void> {
  const log = await navBusyLog(page)
  expect(log.initial).toBe('false')
  expect(log.transitions.filter(transition => transition.oldValue === 'true' || transition.value === 'true')).toEqual([])
}

export function collectPageErrors(page: Page): () => string[] {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  return () => errors
}

/** Bounded in-page wait used only for negative assertions (nothing happened). */
export async function settle(page: Page, ms: number): Promise<void> {
  await page.evaluate(ms => new Promise<void>(resolve => setTimeout(resolve, ms)), ms)
}

export async function unloadIsProtected(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const event = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(event)
    return event.defaultPrevented
  })
}

/* --------------------------------------------------------------------------
 * Framed visual evidence (VC1 / VC1-A).
 *
 * A required image is captured only after its semantic targets have been
 * brought into view by ordinary scrolling of the product's own scroll
 * container and measured in the page: each target must have a painted size,
 * lie fully inside the layout viewport and inside every clipping ancestor,
 * body targets must clear the sticky footer, and hit tests at the target's
 * centre and four inset corners must land on the target itself. The same
 * measurement is repeated after the caller's literal reassertions and
 * immediately after the screenshot, so a layout or scroll change around the
 * capture fails instead of being hidden. Nothing is hidden, restyled, resized
 * or substituted; a target that cannot be exposed fails with its geometry.
 * Every capture attaches `${imageName}-geometry` (schemaVersion 1), also when
 * it fails.
 * -------------------------------------------------------------------------- */

export const GEOMETRY_SCHEMA_VERSION = 1
/** Sub-pixel layout noise tolerated by containment and stability comparisons; mirrored as `tol` inside the page functions. */
export const GEOMETRY_TOLERANCE_PX = 0.5
export const FRAMING_ACTION = "anchor.scrollIntoView({ block: 'start', inline: 'nearest', behavior: 'instant' })"
export const geometryAttachmentName = (imageName: string) => `${imageName}-geometry`

export interface Rect { left: number; top: number; right: number; bottom: number; width: number; height: number }
/** How a target's user-visible literal is read: rendered text, a control's value, a checkbox state or an aria-label. */
export type TargetKind = 'text' | 'value' | 'checked' | 'label'

export interface FrameTarget {
  name: string
  locator: Locator
  kind?: TargetKind
  /** A string must equal the whitespace-normalized literal; an array lists fragments the literal must contain. */
  expected: string | string[]
  /** For a select, the visible label of the selected option. */
  expectedSelectedOption?: string
  /**
   * A control that lives inside the sticky footer. It must still be inside the
   * viewport, unclipped and uncovered, but it cannot be required to clear the
   * footer that contains it.
   */
  footerOwned?: boolean
}

export interface FrameSpec {
  /** Exact image attachment name; the geometry record is attached as `${imageName}-geometry`. */
  imageName: string
  mode: string
  /** Scrolled to the start of the scroller before capture, using the product's own scrolling. */
  anchor: Locator
  scroller: Locator | 'document'
  stickyFooter?: Locator
  targets: FrameTarget[]
  /** Literal state the caller asserts around the frame, recorded for reviewers. */
  state?: Record<string, string | number | boolean | null>
  extra?: Record<string, unknown>
}

export interface ClippingAncestor { description: string; clientBox: Rect; overflowX: string; overflowY: string; clipsX: boolean; clipsY: boolean }
export interface HitTest { x: number; y: number; hit: string | null; ok: boolean }
export interface TargetSnapshot {
  name: string
  description: string
  attached: boolean
  rect: Rect
  literal: string | null
  selectedOptionLabel: string | null
  clippingAncestors: ClippingAncestor[]
  hitTests: HitTest[]
  checks: { positiveSize: boolean; insideViewport: boolean; insideClippingAncestors: boolean; clearOfStickyFooter: boolean | null; hitTestsOk: boolean }
}
export interface FrameSnapshot {
  fontsStatus: string
  viewport: { width: number; height: number }
  visualViewport: { width: number; height: number; offsetTop: number; offsetLeft: number; scale: number } | null
  scroller: { description: string; overflowY: string; scrollTop: number; scrollLeft: number; scrollHeight: number; clientHeight: number; clientWidth: number; clientBox: Rect; scrollable: boolean; atMaxScroll: boolean }
  stickyFooter: { description: string; position: string; rect: Rect } | null
  anchor: { description: string; rect: Rect }
  activeElement: string | null
  toastCount: number
  targets: TargetSnapshot[]
}
export interface LayoutReadiness { fontsStatus: string; frames: 'two-animation-frames' | 'animation-frame-timeout' }

/** The geometry record attached beside every required image. */
export interface FrameRecord {
  schemaVersion: typeof GEOMETRY_SCHEMA_VERSION
  kind: 'saved-lifecycle-frame-geometry'
  imageName: string
  mode: string
  framing: { action: string; bringToFrontInvoked: boolean }
  targets: { name: string; kind: TargetKind; expected: string | string[]; expectedSelectedOption: string | null; footerOwned: boolean }[]
  state: Record<string, string | number | boolean | null>
  layoutReadiness: LayoutReadiness | null
  snapshots: { before: FrameSnapshot | null; framed: FrameSnapshot | null; afterReassertions: FrameSnapshot | null; postCapture: FrameSnapshot | null }
  checks: { framedContainment: boolean | null; literalsMatched: boolean | null; stableThroughReassertions: boolean | null; stableThroughCapture: boolean | null }
  outcome: 'captured' | 'failed'
  failure: string | null
  extra: Record<string, unknown>
}

type Handle = ElementHandle<SVGElement | HTMLElement>
interface ResolvedFrame { anchor: Handle; scroller: Handle | null; footer: Handle | null; targets: { name: string; kind: TargetKind; footerOwned: boolean; element: Handle }[] }

/** Resolve every locator strictly (exactly one element each) at this instant. */
async function resolveFrame(spec: FrameSpec): Promise<ResolvedFrame> {
  return {
    anchor: await spec.anchor.elementHandle(),
    scroller: spec.scroller === 'document' ? null : await spec.scroller.elementHandle(),
    footer: spec.stickyFooter ? await spec.stickyFooter.elementHandle() : null,
    targets: await Promise.all(spec.targets.map(async target => ({
      name: target.name, kind: target.kind ?? 'text', footerOwned: target.footerOwned ?? false, element: await target.locator.elementHandle(),
    }))),
  }
}

async function disposeFrame(frame: ResolvedFrame): Promise<void> {
  const handles: (Handle | null)[] = [frame.anchor, frame.scroller, frame.footer, ...frame.targets.map(target => target.element)]
  await Promise.all(handles.map(handle => handle ? handle.dispose().catch(() => undefined) : undefined))
}

/**
 * One in-page measurement of the scroller, sticky footer, anchor and every
 * target, taken from freshly resolved elements. It reports; it never scrolls
 * and never throws on geometry.
 */
async function measure(page: Page, spec: FrameSpec): Promise<FrameSnapshot> {
  const frame = await resolveFrame(spec)
  try {
    return await page.evaluate((input): FrameSnapshot => {
      const tol = 0.5
      const round = (value: number) => Math.round(value * 100) / 100
      const toRect = (box: DOMRect): Rect => ({ left: round(box.left), top: round(box.top), right: round(box.right), bottom: round(box.bottom), width: round(box.width), height: round(box.height) })
      const describe = (element: Element | null): string | null => {
        if (!element) return null
        const classes = Array.from(element.classList).slice(0, 4).map(name => `.${name}`).join('')
        const role = element.getAttribute('role')
        const label = element.getAttribute('aria-label')
        return `${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : ''}${classes}${role ? `[role=${role}]` : ''}${label ? `[aria-label=${label}]` : ''}`
      }
      const clientBox = (element: Element): Rect => {
        const box = element.getBoundingClientRect()
        const left = box.left + element.clientLeft
        const top = box.top + element.clientTop
        return { left: round(left), top: round(top), right: round(left + element.clientWidth), bottom: round(top + element.clientHeight), width: round(element.clientWidth), height: round(element.clientHeight) }
      }
      const within = (rect: Rect, box: Rect, axes: { x: boolean; y: boolean }) =>
        (!axes.x || (rect.left >= box.left - tol && rect.right <= box.right + tol))
        && (!axes.y || (rect.top >= box.top - tol && rect.bottom <= box.bottom + tol))
      const viewport = { width: document.documentElement.clientWidth, height: document.documentElement.clientHeight }
      const viewportBox: Rect = { left: 0, top: 0, right: viewport.width, bottom: viewport.height, width: viewport.width, height: viewport.height }
      const scrolling: Element = input.scroller ?? document.scrollingElement ?? document.documentElement
      const scrollerBox = input.scroller ? clientBox(input.scroller) : viewportBox
      const footerRect = input.footer ? toRect(input.footer.getBoundingClientRect()) : null
      // html and body are not treated as clipping ancestors: body overflow is propagated to the viewport (and set to hidden
      // behind a modal), and the viewport check already covers the document.
      const clippingAncestors = (element: Element): ClippingAncestor[] => {
        const found: ClippingAncestor[] = []
        for (let ancestor = element.parentElement; ancestor && ancestor !== document.body && ancestor !== document.documentElement; ancestor = ancestor.parentElement) {
          const style = getComputedStyle(ancestor)
          const overflowX = style.overflowX
          const overflowY = style.overflowY
          if (overflowX === 'visible' && overflowY === 'visible') continue
          // A non-visible value on one axis makes the other axis clip as well, except for the per-axis `clip` keyword.
          const clipsX = overflowX !== 'visible' || overflowY !== 'clip'
          const clipsY = overflowY !== 'visible' || overflowX !== 'clip'
          found.push({ description: describe(ancestor) ?? ancestor.tagName.toLowerCase(), clientBox: clientBox(ancestor), overflowX, overflowY, clipsX, clipsY })
        }
        return found
      }
      const targets = input.targets.map((target): TargetSnapshot => {
        const element = target.element
        const rect = toRect(element.getBoundingClientRect())
        const ancestors = clippingAncestors(element)
        // Sample points stay inside the painted box: the centre and four corners inset by 2px (less for tiny controls).
        const inset = Math.min(2, rect.width / 4, rect.height / 4)
        const points: [number, number][] = [
          [rect.left + rect.width / 2, rect.top + rect.height / 2],
          [rect.left + inset, rect.top + inset], [rect.right - inset, rect.top + inset],
          [rect.left + inset, rect.bottom - inset], [rect.right - inset, rect.bottom - inset],
        ]
        const hitTests = points.map(([x, y]): HitTest => {
          const hit = document.elementFromPoint(x, y)
          return { x: round(x), y: round(y), hit: describe(hit), ok: hit !== null && (hit === element || element.contains(hit)) }
        })
        let literal: string | null
        if (target.kind === 'value') literal = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement ? element.value : null
        else if (target.kind === 'checked') literal = element instanceof HTMLInputElement ? String(element.checked) : null
        else if (target.kind === 'label') literal = element.getAttribute('aria-label')
        else literal = (element.textContent ?? '').replace(/\s+/g, ' ').trim()
        const selectedOptionLabel = element instanceof HTMLSelectElement ? (element.selectedOptions.item(0)?.textContent ?? '').replace(/\s+/g, ' ').trim() : null
        return {
          name: target.name, description: describe(element) ?? element.tagName.toLowerCase(), attached: element.isConnected, rect, literal, selectedOptionLabel,
          clippingAncestors: ancestors, hitTests,
          checks: {
            positiveSize: rect.width > 0 && rect.height > 0,
            insideViewport: within(rect, viewportBox, { x: true, y: true }),
            insideClippingAncestors: ancestors.every(ancestor => within(rect, ancestor.clientBox, { x: ancestor.clipsX, y: ancestor.clipsY })),
            clearOfStickyFooter: footerRect && !target.footerOwned ? rect.bottom <= footerRect.top + tol : null,
            hitTestsOk: hitTests.every(test => test.ok),
          },
        }
      })
      return {
        fontsStatus: document.fonts.status,
        viewport,
        visualViewport: window.visualViewport ? {
          width: round(window.visualViewport.width), height: round(window.visualViewport.height),
          offsetTop: round(window.visualViewport.offsetTop), offsetLeft: round(window.visualViewport.offsetLeft), scale: round(window.visualViewport.scale),
        } : null,
        scroller: {
          description: input.scroller ? (describe(input.scroller) ?? 'scroller') : `document (${describe(scrolling) ?? 'html'})`,
          overflowY: getComputedStyle(scrolling).overflowY,
          scrollTop: round(scrolling.scrollTop), scrollLeft: round(scrolling.scrollLeft),
          scrollHeight: scrolling.scrollHeight, clientHeight: scrolling.clientHeight, clientWidth: scrolling.clientWidth,
          clientBox: scrollerBox,
          scrollable: scrolling.scrollHeight > scrolling.clientHeight,
          atMaxScroll: scrolling.scrollTop + scrolling.clientHeight >= scrolling.scrollHeight - tol,
        },
        stickyFooter: input.footer && footerRect ? { description: describe(input.footer) ?? 'footer', position: getComputedStyle(input.footer).position, rect: footerRect } : null,
        anchor: { description: describe(input.anchor) ?? input.anchor.tagName.toLowerCase(), rect: toRect(input.anchor.getBoundingClientRect()) },
        activeElement: describe(document.activeElement),
        toastCount: document.querySelectorAll('.toast').length,
        targets,
      }
    }, { scroller: frame.scroller, footer: frame.footer, anchor: frame.anchor, targets: frame.targets })
  } finally {
    await disposeFrame(frame)
  }
}

/** Real readiness, bounded: fonts loaded and two animation frames rendered, or a reported 1 s bound; never an arbitrary sleep. */
export async function awaitLayoutReady(page: Page): Promise<LayoutReadiness> {
  return page.evaluate(async (): Promise<LayoutReadiness> => {
    await document.fonts.ready
    const frames = await Promise.race<LayoutReadiness['frames']>([
      new Promise<LayoutReadiness['frames']>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve('two-animation-frames')))),
      new Promise<LayoutReadiness['frames']>(resolve => setTimeout(() => resolve('animation-frame-timeout'), 1000)),
    ])
    return { fontsStatus: document.fonts.status, frames }
  })
}

function frameFailures(snapshot: FrameSnapshot, targets: FrameRecord['targets']): { containment: string[]; literals: string[] } {
  const containment: string[] = []
  const literals: string[] = []
  snapshot.targets.forEach((measured, index) => {
    const expected = targets[index]
    const where = `${measured.name} ${JSON.stringify(measured.rect)}`
    if (!measured.attached) containment.push(`${where} is no longer attached to the document`)
    if (!measured.checks.positiveSize) containment.push(`${where} has no painted size`)
    if (!measured.checks.insideViewport) containment.push(`${where} is not fully inside the ${snapshot.viewport.width}x${snapshot.viewport.height} viewport`)
    if (!measured.checks.insideClippingAncestors) containment.push(`${where} is clipped by ${JSON.stringify(measured.clippingAncestors)}`)
    if (measured.checks.clearOfStickyFooter === false) containment.push(`${where} lies behind the sticky footer ${JSON.stringify(snapshot.stickyFooter?.rect)}`)
    if (!measured.checks.hitTestsOk) containment.push(`${where} is covered at ${JSON.stringify(measured.hitTests.filter(test => !test.ok))}`)
    const literal = measured.literal ?? ''
    if (Array.isArray(expected.expected)) {
      for (const fragment of expected.expected) if (!literal.includes(fragment)) literals.push(`${measured.name}: "${literal}" does not contain "${fragment}"`)
    } else if (literal !== expected.expected) literals.push(`${measured.name}: "${literal}" is not "${expected.expected}"`)
    if (expected.expectedSelectedOption !== null && measured.selectedOptionLabel !== expected.expectedSelectedOption) {
      literals.push(`${measured.name}: selected option "${measured.selectedOptionLabel}" is not "${expected.expectedSelectedOption}"`)
    }
  })
  return { containment, literals }
}

/** Geometry, literals and focus must not change between two measurements with no intervening test action that scrolls or focuses. */
function stabilityFailures(reference: FrameSnapshot, current: FrameSnapshot): string[] {
  const failures: string[] = []
  const moved = (a: number, b: number) => Math.abs(a - b) > GEOMETRY_TOLERANCE_PX
  if (moved(reference.scroller.scrollTop, current.scroller.scrollTop) || moved(reference.scroller.scrollLeft, current.scroller.scrollLeft)) {
    failures.push(`scroller moved from (${reference.scroller.scrollLeft}, ${reference.scroller.scrollTop}) to (${current.scroller.scrollLeft}, ${current.scroller.scrollTop})`)
  }
  reference.targets.forEach((target, index) => {
    const now = current.targets[index]
    if (moved(target.rect.left, now.rect.left) || moved(target.rect.top, now.rect.top) || moved(target.rect.right, now.rect.right) || moved(target.rect.bottom, now.rect.bottom)) {
      failures.push(`${target.name} moved from ${JSON.stringify(target.rect)} to ${JSON.stringify(now.rect)}`)
    }
    if (target.literal !== now.literal) failures.push(`${target.name} changed from "${target.literal}" to "${now.literal}"`)
  })
  if (reference.activeElement !== current.activeElement) failures.push(`active element changed from ${reference.activeElement} to ${current.activeElement}`)
  return failures
}

/**
 * CS1: a later endpoint (afterReassertions, postCapture) is valid only if it
 * passes the same full containment, occlusion, attachment and literal
 * validation as the framed snapshot and shows no drift from it. A stationary
 * target that becomes covered, clipped or relabelled therefore fails instead of
 * being described as a successful capture.
 */
function endpointFailures(reference: FrameSnapshot, current: FrameSnapshot, targets: FrameRecord['targets']): string[] {
  const { containment, literals } = frameFailures(current, targets)
  return [...containment, ...literals, ...stabilityFailures(reference, current)]
}

/**
 * Frame, verify, reassert, capture and record one required image. The order is
 * fixed: measure before framing (diagnostic only), scroll the anchor to the
 * start of the product's own scroller, wait for real readiness, measure and
 * assert containment and literals, run the caller's reassertions, measure
 * again and require full validity plus no drift, take the viewport screenshot,
 * measure again and require the same. Any failure is preserved together with
 * the geometry attachment; nothing is retried.
 */
export async function captureFrame(page: Page, testInfo: TestInfo, spec: FrameSpec, reassert: () => Promise<void>): Promise<FrameRecord> {
  const record: FrameRecord = {
    schemaVersion: GEOMETRY_SCHEMA_VERSION, kind: 'saved-lifecycle-frame-geometry', imageName: spec.imageName, mode: spec.mode,
    framing: { action: FRAMING_ACTION, bringToFrontInvoked: false },
    targets: spec.targets.map(target => ({
      name: target.name, kind: target.kind ?? 'text', expected: target.expected, expectedSelectedOption: target.expectedSelectedOption ?? null, footerOwned: target.footerOwned ?? false,
    })),
    state: spec.state ?? {},
    layoutReadiness: null,
    snapshots: { before: null, framed: null, afterReassertions: null, postCapture: null },
    checks: { framedContainment: null, literalsMatched: null, stableThroughReassertions: null, stableThroughCapture: null },
    outcome: 'failed', failure: null,
    extra: spec.extra ?? {},
  }
  try {
    record.snapshots.before = await measure(page, spec)
    // Ordinary scrolling of the product's own scroll container; no style, size or content change.
    await spec.anchor.evaluate(element => element.scrollIntoView({ block: 'start', inline: 'nearest', behavior: 'instant' }))
    record.layoutReadiness = await awaitLayoutReady(page)
    expect(record.layoutReadiness, `${spec.imageName}: fonts must be loaded and two animation frames rendered after framing`).toEqual({ fontsStatus: 'loaded', frames: 'two-animation-frames' })
    const framed = await measure(page, spec)
    record.snapshots.framed = framed
    if (spec.scroller !== 'document') expect(['auto', 'scroll'], `${spec.imageName}: ${framed.scroller.description} must be the effective scroll container`).toContain(framed.scroller.overflowY)
    const { containment, literals } = frameFailures(framed, record.targets)
    record.checks.framedContainment = containment.length === 0
    record.checks.literalsMatched = literals.length === 0
    expect(containment, `${spec.imageName}: every target must be fully inside the viewport and its clipping ancestors, clear of the sticky footer and uncovered at its sample points`).toEqual([])
    expect(literals, `${spec.imageName}: the framed targets must show the expected literal state`).toEqual([])
    await reassert()
    const afterReassertions = await measure(page, spec)
    record.snapshots.afterReassertions = afterReassertions
    const reassertionFailures = endpointFailures(framed, afterReassertions, record.targets)
    record.checks.stableThroughReassertions = reassertionFailures.length === 0
    expect(reassertionFailures, `${spec.imageName}: after the state reassertions every target must still be fully inside the viewport and its clipping ancestors, clear of the sticky footer, uncovered, literal and unmoved`).toEqual([])
    await testInfo.attach(spec.imageName, { body: await page.screenshot(), contentType: 'image/png' })
    const postCapture = await measure(page, spec)
    record.snapshots.postCapture = postCapture
    const captureFailures = endpointFailures(framed, postCapture, record.targets)
    record.checks.stableThroughCapture = captureFailures.length === 0
    expect(captureFailures, `${spec.imageName}: immediately after the screenshot every target must still be fully inside the viewport and its clipping ancestors, clear of the sticky footer, uncovered, literal and unmoved`).toEqual([])
    record.outcome = 'captured'
  } catch (error) {
    record.failure = error instanceof Error ? error.message : String(error)
    throw error
  } finally {
    await testInfo.attach(geometryAttachmentName(spec.imageName), { body: JSON.stringify(record, null, 2), contentType: 'application/json' })
  }
  return record
}

/* --------------------------------------------------------------------------
 * A1: protected-draft timeline (T0 after the failed write and layout
 * readiness, T1 after the other tab's commit, T2 after the return bursts).
 * -------------------------------------------------------------------------- */

export interface DraftFieldSnapshot {
  label: string
  fontsStatus: string
  /** Viewport box of the job dialog; a change here with an equal content offset means the whole dialog moved. */
  dialogRect: Rect
  scrollTop: number
  scrollHeight: number
  clientHeight: number
  fieldRect: Rect
  /** Top of the field within the dialog's scrolled content: fieldRect.top - dialogRect.top + dialog.scrollTop. */
  fieldOffsetTop: number
  /** Whether the field lies inside the dialog scrollport and above the sticky footer; recorded, not asserted. */
  fieldClearOfFooter: boolean | null
  footerRect: Rect | null
  alertRect: Rect | null
  activeElement: string | null
  activeIsField: boolean
}

/** One timeline point for the protected draft: focus, dialog scroll metrics and the field's position, measured without scrolling. */
export async function snapshotDraftField(page: Page, label: string): Promise<DraftFieldSnapshot> {
  return page.evaluate((label): DraftFieldSnapshot => {
    const round = (value: number) => Math.round(value * 100) / 100
    const toRect = (box: DOMRect): Rect => ({ left: round(box.left), top: round(box.top), right: round(box.right), bottom: round(box.bottom), width: round(box.width), height: round(box.height) })
    const describe = (element: Element | null) => element
      ? `${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : ''}${Array.from(element.classList).slice(0, 4).map(name => `.${name}`).join('')}`
      : null
    const dialog = document.querySelector('dialog.job-dialog')
    const field = document.getElementById('saved-note')
    if (!(dialog instanceof HTMLElement) || !(field instanceof HTMLTextAreaElement)) throw new Error('The job dialog or its saved-note field is missing')
    const dialogBox = dialog.getBoundingClientRect()
    const fieldRect = toRect(field.getBoundingClientRect())
    const footer = dialog.querySelector('.dialog-footer')
    const footerRect = footer ? toRect(footer.getBoundingClientRect()) : null
    const alert = dialog.querySelector('.saved-note-section [role="alert"]')
    return {
      label, fontsStatus: document.fonts.status, dialogRect: toRect(dialogBox),
      scrollTop: round(dialog.scrollTop), scrollHeight: dialog.scrollHeight, clientHeight: dialog.clientHeight,
      fieldRect, fieldOffsetTop: round(fieldRect.top - dialogBox.top + dialog.scrollTop),
      fieldClearOfFooter: footerRect ? fieldRect.top >= dialogBox.top + dialog.clientTop - 0.5 && fieldRect.bottom <= footerRect.top + 0.5 : null,
      footerRect, alertRect: alert ? toRect(alert.getBoundingClientRect()) : null,
      activeElement: describe(document.activeElement), activeIsField: document.activeElement === field,
    }
  }, label)
}

/**
 * Between the baseline and the later point no test action scrolls or focuses
 * the inspected page, so the draft field must still hold focus, its viewport
 * rectangle must be unchanged (CM1: a whole-dialog displacement is movement
 * too), and both the dialog's scroll position and the field's content offset
 * must be unchanged. The messages carry both field and dialog rectangles so a
 * displacement can be attributed without assuming a cause.
 */
export function draftFieldStabilityFailures(baseline: DraftFieldSnapshot, current: DraftFieldSnapshot): string[] {
  const failures: string[] = []
  const edges: ('left' | 'top' | 'right' | 'bottom')[] = ['left', 'top', 'right', 'bottom']
  if (!current.activeIsField) failures.push(`${current.label}: the draft field is no longer the active element (now ${current.activeElement}; at ${baseline.label} ${baseline.activeElement})`)
  if (edges.some(edge => Math.abs(current.fieldRect[edge] - baseline.fieldRect[edge]) > GEOMETRY_TOLERANCE_PX)) {
    failures.push(`${current.label}: the field's viewport rectangle moved from ${JSON.stringify(baseline.fieldRect)} to ${JSON.stringify(current.fieldRect)} while the dialog box went from ${JSON.stringify(baseline.dialogRect)} to ${JSON.stringify(current.dialogRect)}`)
  }
  if (Math.abs(current.scrollTop - baseline.scrollTop) > GEOMETRY_TOLERANCE_PX) failures.push(`${current.label}: dialog scrollTop moved from ${baseline.scrollTop} to ${current.scrollTop}`)
  if (Math.abs(current.fieldOffsetTop - baseline.fieldOffsetTop) > GEOMETRY_TOLERANCE_PX) {
    failures.push(`${current.label}: the field's content offset moved from ${baseline.fieldOffsetTop} to ${current.fieldOffsetTop}, so content above it changed`)
  }
  return failures
}

/*
 * CM2: the protected-draft case attaches this record from its own enclosing
 * finally, independently of captureFrame, so the facts collected before a
 * failing readiness, T0, T1, T2 or framing step survive exactly as measured.
 */
export type DraftTimelinePhase = 'readiness' | 'T0' | 'T1' | 'T2' | 'frame' | 'post-frame'
export interface DraftTimeline {
  schemaVersion: typeof GEOMETRY_SCHEMA_VERSION
  kind: 'saved-lifecycle-draft-timeline'
  /** The protected-draft image this timeline belongs to; attached as `${imageName}-timeline`. */
  imageName: string
  mode: string
  width: number
  /** The actual T0 readiness result, or null when the readiness wait was never reached. */
  readiness: LayoutReadiness | null
  /** The last phase entered, or null before the readiness wait started. */
  phase: DraftTimelinePhase | null
  /** Only the snapshots actually taken, in order; nothing is invented for a phase that was not reached. */
  points: DraftFieldSnapshot[]
  a1: { t0Active: boolean | null; t2Failures: string[] | null }
  /** True once the protected-draft frame was captured with the complete timeline. */
  complete: boolean
  /** The thrown message when the case failed anywhere inside the timeline's scope, otherwise null. */
  failure: string | null
}
export const draftTimelineAttachmentName = (imageName: string) => `${imageName}-timeline`

export function createDraftTimeline(imageName: string, mode: string, width: number): DraftTimeline {
  return {
    schemaVersion: GEOMETRY_SCHEMA_VERSION, kind: 'saved-lifecycle-draft-timeline', imageName, mode, width,
    readiness: null, phase: null, points: [], a1: { t0Active: null, t2Failures: null }, complete: false, failure: null,
  }
}

/** Attach the timeline exactly as collected, whether or not framing was reached. */
export async function attachDraftTimeline(testInfo: TestInfo, timeline: DraftTimeline): Promise<void> {
  await testInfo.attach(draftTimelineAttachmentName(timeline.imageName), { body: JSON.stringify(timeline, null, 2), contentType: 'application/json' })
}

/* --------------------------------------------------------------------------
 * NV1: native navigation diagnostic.
 * -------------------------------------------------------------------------- */

export interface NavigationEntryDiagnostic { type: string; notRestoredReasons: unknown }
export interface NavigationDiagnostic {
  method: string
  status: 'collected' | 'empty' | 'unsupported' | 'error' | 'timeout'
  error: string | null
  timeoutMs: number
  entryCount: number
  entries: NavigationEntryDiagnostic[]
}

/**
 * The fixed test clock replaces performance.getEntries, getEntriesByName and
 * getEntriesByType with stubs that return [], so navigation entries are
 * observed through a buffered PerformanceObserver owned by this helper and
 * disconnected after delivery or after the bounded wait. The outcome is
 * diagnostic only: it never classifies a native return and never invents an
 * entry; an unavailable or timed-out observation is reported as such.
 */
export async function collectNavigationEntries(page: Page, timeoutMs = 2000): Promise<NavigationDiagnostic> {
  return page.evaluate(timeoutMs => new Promise<NavigationDiagnostic>(resolve => {
    const method = 'PerformanceObserver.observe({ type: "navigation", buffered: true }), owned by the test and disconnected after delivery; performance.getEntriesByType is stubbed by the fixed test clock and is not used'
    const base = { method, timeoutMs }
    if (typeof PerformanceObserver !== 'function') {
      resolve({ ...base, status: 'unsupported', error: 'PerformanceObserver is not defined', entryCount: 0, entries: [] })
      return
    }
    const supported = PerformanceObserver.supportedEntryTypes
    if (!supported.includes('navigation')) {
      resolve({ ...base, status: 'unsupported', error: `navigation is not in supportedEntryTypes [${supported.join(', ')}]`, entryCount: 0, entries: [] })
      return
    }
    let settled = false
    let observer: PerformanceObserver | null = null
    let timer: number | null = null
    const finish = (result: NavigationDiagnostic) => {
      if (settled) return
      settled = true
      if (timer !== null) window.clearTimeout(timer)
      try { observer?.disconnect() } catch { /* nothing left to disconnect */ }
      resolve(result)
    }
    try {
      observer = new PerformanceObserver(list => {
        const entries = list.getEntries().map(entry => ({
          type: (entry as PerformanceNavigationTiming).type,
          notRestoredReasons: (Reflect.get(entry, 'notRestoredReasons') as unknown) ?? null,
        }))
        finish({ ...base, status: entries.length ? 'collected' : 'empty', error: null, entryCount: entries.length, entries })
      })
      observer.observe({ type: 'navigation', buffered: true })
      timer = window.setTimeout(() => finish({ ...base, status: 'timeout', error: `no navigation entry was delivered within ${timeoutMs} ms`, entryCount: 0, entries: [] }), timeoutMs)
    } catch (error) {
      finish({ ...base, status: 'error', error: error instanceof Error ? `${error.name}: ${error.message}` : String(error), entryCount: 0, entries: [] })
    }
  }), timeoutMs)
}
