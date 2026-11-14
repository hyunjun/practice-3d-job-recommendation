/** A live owner comes from showModal registration order, never DOM order. */
export interface DialogFocusOwner {
  lifetime: symbol
  node: HTMLElement
  dialog: HTMLDialogElement | null
}

export interface DialogFocusTicket {
  readonly scope: DialogFocusScope
  readonly owner: DialogFocusOwner
  readonly epoch: number
  readonly stack: number
  readonly origin: HTMLElement | null
  readonly action: string
}

type IntentKind = 'focus' | 'edit' | 'selection' | 'key' | 'pointer' | 'pointer-end'
  | 'wheel' | 'touch' | 'touch-end' | 'composition-start' | 'composition-end' | 'owner' | 'navigation'
interface Intent {
  kind: IntentKind
  target: HTMLElement | null
  event?: Event
  owned: boolean
}
type Alignment = 'nearest' | 'start'
interface DialogController {
  request: (ticket: DialogFocusTicket, target: HTMLElement, alignment: Alignment) => void
}

export interface DialogFocusScope {
  currentOwner: () => DialogFocusOwner | null
  listen: () => () => void
  ownerChanged: () => void
  subscribe: (listener: (intent: Intent) => void) => () => void
  register: (dialog: HTMLDialogElement, controller: DialogController) => () => void
  capture: (origin: HTMLElement | null, action: string) => DialogFocusTicket | null
  navigate: (origin: HTMLElement | null, action: string) => DialogFocusTicket | null
  valid: (ticket: DialogFocusTicket | null) => boolean
  run: (ticket: DialogFocusTicket | null, operation: () => boolean) => boolean
  reveal: (ticket: DialogFocusTicket | null, target: HTMLElement | null, alignment?: Alignment) => void
}

function htmlTarget(target: EventTarget | null): HTMLElement | null {
  if (target instanceof HTMLElement) return target
  return target instanceof Node ? target.parentElement : null
}

function isEditor(target: HTMLElement | null): target is HTMLInputElement | HTMLTextAreaElement {
  return target instanceof HTMLTextAreaElement
    || target instanceof HTMLInputElement && target.selectionStart !== null
}

/**
 * Action permission and engaged-focus protection are deliberately separate.
 * A late result may render, but it cannot renew the action that requested it.
 */
export function createDialogFocusScope(document: Document, currentOwner: () => DialogFocusOwner | null): DialogFocusScope {
  let epoch = 0
  let stack = 0
  let owned = 0
  let listening = false
  let focused = htmlTarget(document.activeElement)
  const subscribers = new Set<(intent: Intent) => void>()
  const controllers = new WeakMap<HTMLDialogElement, DialogController>()
  let selection: { target: HTMLElement; start: number | null; end: number | null; direction: string | null } | null = null
  const rememberSelection = (target: HTMLElement | null) => {
    selection = isEditor(target)
      ? { target, start: target.selectionStart, end: target.selectionEnd, direction: target.selectionDirection }
      : null
  }
  const publish = (kind: IntentKind, target: HTMLElement | null, event?: Event) => {
    if (!owned) epoch++
    for (const listener of subscribers) listener({ kind, target, event, owned: owned > 0 })
  }
  const scope: DialogFocusScope = {
    currentOwner,
    listen() {
      if (listening) throw new Error('Dialog focus scope already attached')
      listening = true
      const bindings: [string, EventListener][] = []
      const on = (name: string, listener: EventListener) => {
        bindings.push([name, listener])
        document.addEventListener(name, listener, { capture: true, passive: true })
      }
      on('focusin', event => {
        const target = htmlTarget(event.target)
        // Removing an action button can leave focus at body. That is not a
        // subsequent user choice and must not cancel its legitimate recovery.
        if (!target || target === document.body || target === document.documentElement) return
        if (target === focused) return
        focused = target
        rememberSelection(target)
        publish('focus', target, event)
      })
      on('focusout', () => queueMicrotask(() => {
        // Window deactivation can repeat focus events for the same field on
        // return. Only an actual in-document blur clears its identity.
        if (listening && document.hasFocus() && document.activeElement === document.body) focused = null
      }))
      on('input', event => {
        const target = htmlTarget(event.target)
        rememberSelection(target)
        publish('edit', target, event)
      })
      on('selectionchange', event => {
        const target = htmlTarget(document.activeElement)
        if (!isEditor(target)) return
        if (selection?.target === target && selection.start === target.selectionStart
          && selection.end === target.selectionEnd && selection.direction === target.selectionDirection) return
        rememberSelection(target)
        publish('selection', target, event)
      })
      for (const [name, kind] of [
        ['keydown', 'key'], ['pointerdown', 'pointer'], ['pointerup', 'pointer-end'],
        ['pointercancel', 'pointer-end'], ['wheel', 'wheel'], ['touchstart', 'touch'], ['touchmove', 'touch'],
        ['touchend', 'touch-end'], ['touchcancel', 'touch-end'],
        ['compositionstart', 'composition-start'], ['compositionend', 'composition-end'],
      ] as const) on(name, event => publish(kind, htmlTarget(event.target), event))
      return () => {
        for (const [name, listener] of bindings) document.removeEventListener(name, listener, true)
        listening = false
        stack++
        publish('owner', null)
      }
    },
    ownerChanged() {
      stack++
      publish('owner', null)
    },
    subscribe(listener) {
      subscribers.add(listener)
      return () => { subscribers.delete(listener) }
    },
    register(dialog, controller) {
      controllers.set(dialog, controller)
      return () => { if (controllers.get(dialog) === controller) controllers.delete(dialog) }
    },
    capture(origin, action) {
      const owner = currentOwner()
      if (!owner?.node.isConnected || owner.dialog && !owner.dialog.open) return null
      const originDialog = origin?.closest('dialog')
      if (originDialog && originDialog !== owner.dialog) return null
      return { scope, owner, epoch, stack, origin, action }
    },
    navigate(origin, action) {
      publish('navigation', origin)
      return scope.capture(origin, action)
    },
    valid(ticket) {
      if (!ticket || ticket.scope !== scope || ticket.epoch !== epoch || ticket.stack !== stack) return false
      const owner = currentOwner()
      return !!owner && owner.lifetime === ticket.owner.lifetime && owner.node === ticket.owner.node
        && owner.node.isConnected && (!owner.dialog || owner.dialog.open)
    },
    run(ticket, operation) {
      if (!scope.valid(ticket)) return false
      // A recovery's own focus event must not invalidate the same operation
      // between its focus and scroll. Other, later events still expire it.
      owned++
      try { return operation() } finally { owned-- }
    },
    reveal(ticket, target, alignment = 'nearest') {
      if (!ticket || !scope.valid(ticket) || !target?.isConnected) return
      const dialog = target.closest('dialog')
      if (dialog instanceof HTMLDialogElement && dialog === ticket.owner.dialog) {
        controllers.get(dialog)?.request(ticket, target, alignment)
      }
    },
  }
  return scope
}

const CLEARANCE = 8
const EPSILON = .5
const READERS = '.original-description .job-description, .saved-record-note, .saved-record-description > p, .saved-record-description > pre, .saved-note-section textarea'
interface Box { top: number; right: number; bottom: number; left: number }
const number = (value: string) => Number.parseFloat(value) || 0
const clippedOverflow = (value: string) => ['auto', 'scroll', 'hidden', 'clip'].includes(value)

function clientBox(element: HTMLElement): Box {
  const rect = element.getBoundingClientRect()
  const scaleX = element.offsetWidth ? rect.width / element.offsetWidth : 1
  const scaleY = element.offsetHeight ? rect.height / element.offsetHeight : 1
  const left = rect.left + element.clientLeft * scaleX
  const top = rect.top + element.clientTop * scaleY
  return { left, top, right: left + element.clientWidth * scaleX, bottom: top + element.clientHeight * scaleY }
}

function proxyFor(target: HTMLElement): HTMLElement {
  const track = target.matches('.toggle-row > input') ? target.nextElementSibling : null
  return track instanceof HTMLElement && track.classList.contains('toggle-track') ? track : target
}

function indicatorBox(target: HTMLElement): Box {
  const rect = target.getBoundingClientRect()
  const style = getComputedStyle(target)
  const outline = style.outlineStyle === 'none' ? 0 : Math.max(0, number(style.outlineWidth) + number(style.outlineOffset))
  let top = outline; let right = outline; let bottom = outline; let left = outline
  // The fields use a spread shadow instead of an outline. Include that paint,
  // without treating the transparent checkbox as the toggle's visible control.
  for (const shadow of style.boxShadow.replace(/rgba?\([^)]*\)/g, '').split(',')) {
    if (shadow.includes('inset')) continue
    const values = shadow.match(/-?[\d.]+px/g)?.map(number)
    if (!values || values.length < 3) continue
    const [x, y, blur, spread = 0] = values
    const extent = Math.max(0, spread + blur / 2)
    top = Math.max(top, extent - y); right = Math.max(right, extent + x)
    bottom = Math.max(bottom, extent + y); left = Math.max(left, extent - x)
  }
  return { top: rect.top - top, right: rect.right + right, bottom: rect.bottom + bottom, left: rect.left - left }
}

function availableBox(dialog: HTMLDialogElement, target: HTMLElement, footer: HTMLElement | null, flow: boolean): Box {
  const box = clientBox(dialog)
  const view = dialog.ownerDocument.defaultView!
  const viewport = view.visualViewport
  box.top = Math.max(box.top, viewport?.offsetTop ?? 0)
  box.bottom = Math.min(box.bottom, (viewport?.offsetTop ?? 0) + (viewport?.height ?? view.innerHeight))
  box.left = Math.max(box.left, viewport?.offsetLeft ?? 0)
  box.right = Math.min(box.right, (viewport?.offsetLeft ?? 0) + (viewport?.width ?? view.innerWidth))
  for (let parent = target.parentElement; parent && parent !== dialog; parent = parent.parentElement) {
    const style = getComputedStyle(parent)
    const clip = clientBox(parent)
    if (clippedOverflow(style.overflowY)) { box.top = Math.max(box.top, clip.top); box.bottom = Math.min(box.bottom, clip.bottom) }
    if (clippedOverflow(style.overflowX)) { box.left = Math.max(box.left, clip.left); box.right = Math.min(box.right, clip.right) }
  }
  if (footer && !flow && !footer.contains(target)) {
    const obstacle = footer.getBoundingClientRect()
    const rect = target.getBoundingClientRect()
    if (obstacle.bottom > box.top && obstacle.top < box.bottom && obstacle.right > rect.left && obstacle.left < rect.right) {
      box.bottom = Math.min(box.bottom, obstacle.top)
    }
  }
  return box
}

function fullyInside(target: Box, box: Box) {
  return target.top >= box.top - EPSILON && target.bottom <= box.bottom + EPSILON
    && target.left >= box.left - EPSILON && target.right <= box.right + EPSILON
}

function sameGeometry(previous: readonly number[] | null, next: readonly number[]) {
  return previous?.length === next.length && previous.every((value, index) => Math.abs(value - next[index]) <= EPSILON)
}

/** Mounted once with showModal; children and draft renders do not reinstall it. */
export function installDialogVisibility(dialog: HTMLDialogElement, scope: DialogFocusScope): () => void {
  const document = dialog.ownerDocument
  const view = document.defaultView!
  const lifetime = scope.currentOwner()?.lifetime
  let live = true
  let frame = 0
  let gestureFrame = 0
  let generation = 0
  let contextGeneration = 0
  interface Gesture {
    context: number
    owner: symbol | undefined
    top: number
    kind: 'transient' | 'pointer' | 'touch'
    identifier: number | null
    held: boolean
  }
  let gesture: Gesture | null = null
  let composing: HTMLElement | null = null
  let selecting: {
    target: HTMLElement
    identifier: number
    context: number
    owner: symbol | undefined
  } | null = null
  let editingTarget: HTMLElement | null = null
  let armed = true
  let target = htmlTarget(document.activeElement)
  let footer: HTMLElement | null = null
  let flow = false
  let basisGeometry: number[] | null = null
  let basisText = ''
  let lastProxy: HTMLElement | null = null
  let lastGeometry: number[] | null = null
  let explicit: { ticket: DialogFocusTicket; target: HTMLElement; alignment: Alignment } | null = null
  const observed = new Set<Element>()
  const originalStyles = new Map<string, { value: string; priority: string }>()
  const publishedStyles = new Map<string, string>()
  const originalFlow = dialog.getAttribute('data-dialog-footer-flow')
  let publishedFlow: string | null = null

  const isOwner = () => {
    const owner = scope.currentOwner()
    return live && dialog.isConnected && dialog.open && owner?.dialog === dialog && owner.lifetime === lifetime
  }
  const eligible = (element: HTMLElement | null): element is HTMLElement => !!element?.isConnected && element !== dialog
    && dialog.contains(element) && !element.matches(':disabled') && !element.closest('[inert]')
    && !element.matches('input.sr-only') && element.getClientRects().length > 0
    && getComputedStyle(element).visibility === 'visible'
  const active = () => {
    const element = htmlTarget(document.activeElement)
    return eligible(element) ? element : null
  }
  const styleValue = (name: string, value: number) => {
    if (!isOwner()) return false
    const next = `${Math.max(0, value).toFixed(3)}px`
    if (dialog.style.getPropertyValue(name) === next) return false
    if (!originalStyles.has(name)) originalStyles.set(name, {
      value: dialog.style.getPropertyValue(name), priority: dialog.style.getPropertyPriority(name),
    })
    dialog.style.setProperty(name, next)
    publishedStyles.set(name, next)
    return true
  }
  const observeChildren = () => {
    footer = dialog.querySelector<HTMLElement>(':scope > .dialog-footer')
    const wanted = new Set<Element>([dialog, ...dialog.children])
    if (target && eligible(target)) wanted.add(proxyFor(target))
    for (const element of observed) {
      if (!wanted.has(element)) { resize.unobserve(element); observed.delete(element) }
    }
    for (const element of wanted) {
      if (!observed.has(element)) { resize.observe(element); observed.add(element) }
    }
  }
  const size = () => {
    if (!isOwner()) return false
    const style = getComputedStyle(dialog)
    const border = number(style.borderTopWidth) + number(style.borderBottomWidth)
    const scrollbar = Math.max(0, dialog.offsetHeight - dialog.clientHeight - border)
    const inset = number(style.getPropertyValue('--dialog-viewport-inset'))
    const resolvedMax = /^\d+(?:\.\d+)?px$/.test(style.maxHeight) ? number(style.maxHeight) : Infinity
    // Current clientHeight depends on content. Using it here would make a
    // reader's cap shrink itself on every observer notification.
    const capacity = Math.max(0, Math.min(view.innerHeight - inset, resolvedMax) - border - scrollbar)
    const rect = dialog.getBoundingClientRect()
    const scale = dialog.offsetHeight ? rect.height / dialog.offsetHeight : 1
    const footerHeight = footer ? footer.getBoundingClientRect().height / scale : 0
    const stickySpace = capacity - footerHeight - CLEARANCE * 2
    const flowSpace = capacity - CLEARANCE * 2
    const requirements = [...dialog.querySelectorAll<HTMLElement>(READERS)]
      .filter(element => element.getClientRects().length > 0)
      .map(element => {
        const computed = getComputedStyle(element)
        const line = number(computed.lineHeight) || number(computed.fontSize) * 1.2
        return line * 2 + number(computed.paddingTop) + number(computed.paddingBottom)
          + number(computed.borderTopWidth) + number(computed.borderBottomWidth)
      })
    const nextBasis = [
      capacity, view.innerWidth, view.innerHeight, footerHeight, footer?.offsetWidth ?? 0,
      ...requirements,
    ]
    const nextText = footer?.textContent ?? ''
    if (!sameGeometry(basisGeometry, nextBasis) || nextText !== basisText) {
      basisGeometry = nextBasis; basisText = nextText; flow = false
    }
    const focused = active()
    const focusedHeight = focused ? proxyFor(focused).getBoundingClientRect().height / scale : 0
    if (footer && (requirements.some(required => stickySpace < required)
      || focused && !footer.contains(focused) && focusedHeight <= flowSpace && focusedHeight > stickySpace)) flow = true
    if (!footer) flow = false
    const nextFlow = flow ? 'true' : null
    let changed = false
    if (dialog.getAttribute('data-dialog-footer-flow') !== nextFlow) {
      if (nextFlow) dialog.setAttribute('data-dialog-footer-flow', nextFlow)
      else dialog.removeAttribute('data-dialog-footer-flow')
      changed = true
    }
    publishedFlow = nextFlow
    changed = styleValue('--dialog-footer-clearance', flow ? 0 : footerHeight) || changed
    changed = styleValue('--dialog-reader-max-height', flow ? flowSpace : stickySpace) || changed
    return changed
  }
  const geometry = (proxy: HTMLElement) => {
    const rect = proxy.getBoundingClientRect()
    const client = clientBox(dialog)
    const clip = availableBox(dialog, proxy, footer, flow)
    const scale = dialog.offsetHeight ? dialog.getBoundingClientRect().height / dialog.offsetHeight : 1
    return [
      (rect.top - client.top) / scale + dialog.scrollTop, rect.left - client.left,
      rect.width, rect.height, client.top, client.bottom, client.left, client.right,
      clip.top, clip.bottom, clip.left, clip.right, footer?.getBoundingClientRect().height ?? 0, Number(flow),
    ]
  }
  const sharedClip = (first: HTMLElement, second: HTMLElement): Box | null => {
    const usesDialogPort = (element: HTMLElement) => {
      if (element.closest('dialog') !== dialog || footer?.contains(element)) return false
      for (let node: HTMLElement | null = element; node && node !== dialog; node = node.parentElement) {
        const style = getComputedStyle(node)
        if (style.position === 'fixed' || style.position === 'sticky'
          || clippedOverflow(style.overflowX) || clippedOverflow(style.overflowY)) return false
      }
      return true
    }
    if (!usesDialogPort(first) || !usesDialogPort(second)) return null
    const a = availableBox(dialog, first, footer, flow)
    const b = availableBox(dialog, second, footer, flow)
    if (!sameGeometry([a.top, a.right, a.bottom, a.left], [b.top, b.right, b.bottom, b.left])) return null
    const clip = {
      top: Math.max(a.top, b.top), right: Math.min(a.right, b.right),
      bottom: Math.min(a.bottom, b.bottom), left: Math.max(a.left, b.left),
    }
    return Object.values(clip).every(Number.isFinite) && clip.bottom > clip.top && clip.right > clip.left ? clip : null
  }
  const jointMovement = (element: HTMLElement, ticket: DialogFocusTicket, scale: number) => {
    const origin = ticket.origin
    if (!scope.valid(ticket) || ticket.owner.dialog !== dialog || origin !== document.activeElement
      || !eligible(origin) || element.closest('dialog') !== dialog || !(scale > 0) || !Number.isFinite(scale)) return null
    const proxy = proxyFor(element)
    const companion = proxyFor(origin)
    const clip = sharedClip(proxy, companion)
    if (!clip) return null
    const rect = proxy.getBoundingClientRect()
    const originRect = companion.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0 || originRect.width <= 0 || originRect.height <= 0) return null
    const paint = indicatorBox(proxy)
    const originPaint = indicatorBox(companion)
    const union: Box = {
      top: Math.min(paint.top, originPaint.top), right: Math.max(paint.right, originPaint.right),
      bottom: Math.max(paint.bottom, originPaint.bottom), left: Math.min(paint.left, originPaint.left),
    }
    if (!Object.values(union).every(Number.isFinite) || union.left < clip.left - EPSILON || union.right > clip.right + EPSILON) return null
    if (fullyInside(union, clip)) return { delta: 0, origin }
    const before = dialog.scrollTop
    const maximum = Math.max(0, dialog.scrollHeight - dialog.clientHeight)
    const interval = (box: Box): [number, number] | null => {
      if (box.left < clip.left - EPSILON || box.right > clip.right + EPSILON) return null
      const low = Math.max((box.bottom - clip.bottom) / scale, -before)
      const high = Math.min((box.top - clip.top) / scale, maximum - before)
      return Number.isFinite(low) && Number.isFinite(high) && low <= high ? [low, high] : null
    }
    const actual = interval(union)
    if (!actual) return null
    // Both paints must be reachable first. Optional breathing room cannot
    // turn a fitting pair into a destination-only reveal.
    const preferred = interval({
      top: Math.min(union.top, rect.top - CLEARANCE, originRect.top - CLEARANCE),
      right: Math.max(union.right, rect.right + CLEARANCE, originRect.right + CLEARANCE),
      bottom: Math.max(union.bottom, rect.bottom + CLEARANCE, originRect.bottom + CLEARANCE),
      left: Math.min(union.left, rect.left - CLEARANCE, originRect.left - CLEARANCE),
    })
    const [low, high] = preferred ?? actual
    return { delta: Math.max(low, Math.min(0, high)), origin }
  }
  const expose = (element: HTMLElement, alignment: Alignment = 'nearest', ticket?: DialogFocusTicket): 'none' | 'destination' | 'joint' => {
    if (!isOwner() || !eligible(element) || ticket && !scope.valid(ticket)) return 'none'
    const proxy = proxyFor(element)
    const scale = dialog.offsetHeight ? dialog.getBoundingClientRect().height / dialog.offsetHeight : 1
    // Consider the exact action origin before the destination's no-move gate:
    // a visible result may still have displaced its focused action.
    const joint = ticket && alignment === 'nearest' ? jointMovement(element, ticket, scale) : null
    if (joint && ticket) {
      if (Math.abs(joint.delta * scale) <= EPSILON) return 'none'
      if (!isOwner() || !scope.valid(ticket) || !eligible(element)
        || !eligible(joint.origin) || document.activeElement !== joint.origin) return 'none'
      const before = dialog.scrollTop
      dialog.scrollTo({ top: before + joint.delta, behavior: 'instant' })
      if (Math.abs(dialog.scrollTop - before) * scale <= EPSILON) return 'none'
      const currentClip = sharedClip(proxyFor(element), proxyFor(joint.origin))
      return isOwner() && scope.valid(ticket) && eligible(element) && eligible(joint.origin) && document.activeElement === joint.origin
        && currentClip && fullyInside(indicatorBox(proxyFor(joint.origin)), currentClip) ? 'joint' : 'destination'
    }
    const rect = proxy.getBoundingClientRect()
    const paint = indicatorBox(proxy)
    const clip = availableBox(dialog, proxy, footer, flow)
    // Visibility is the gate; 8px is only the landing goal. A visible 6px
    // outline must not move merely to obtain another 2px of breathing room.
    if (alignment === 'nearest' && fullyInside(paint, clip)) return 'none'
    const height = clip.bottom - clip.top
    if (height <= 0) return 'none'
    let top = rect.top - CLEARANCE
    let bottom = rect.bottom + CLEARANCE
    if (bottom - top > height && paint.bottom - paint.top <= height) {
      top = paint.top; bottom = paint.bottom
    }
    let delta = 0
    if (alignment === 'start' || bottom - top > height) delta = top - clip.top
    else if (top < clip.top) delta = top - clip.top
    else if (bottom > clip.bottom) delta = bottom - clip.bottom
    if (Math.abs(delta) <= EPSILON || !isOwner() || !eligible(element) || ticket && !scope.valid(ticket)) return 'none'
    const before = dialog.scrollTop
    dialog.scrollTo({ top: dialog.scrollTop + delta / scale, behavior: 'instant' })
    return Math.abs(dialog.scrollTop - before) > EPSILON ? 'destination' : 'none'
  }
  const repair = (freshFocus = false) => {
    if (!isOwner() || !armed || composing || selecting || gesture !== null) return
    const element = active()
    if (!element || element !== target) return
    const proxy = proxyFor(element)
    const next = geometry(proxy)
    const changed = proxy !== lastProxy || !sameGeometry(lastGeometry, next)
    lastProxy = proxy
    lastGeometry = next
    if (!freshFocus && !changed) return
    expose(element)
    lastGeometry = geometry(proxy)
  }
  function schedule() {
    if (!isOwner() || frame) return
    frame = view.requestAnimationFrame(() => {
      frame = 0
      if (!isOwner() || composing || selecting || gesture !== null) return
      observeChildren()
      // Never write from ResizeObserver delivery. If these local properties
      // changed layout, use one coalesced follow-up frame with fresh rectangles.
      if (size()) { schedule(); return }
      if (explicit) {
        const request = explicit
        explicit = null
        scope.run(request.ticket, () => {
          if (!isOwner() || !eligible(request.target)) return false
          const context = contextGeneration
          const outcome = expose(request.target, request.alignment, request.ticket)
          // A joint reveal leaves the current protection state unchanged,
          // including a prior manual abandonment. Only destination-only
          // movement can intentionally leave the origin behind.
          if (outcome === 'destination' && context === contextGeneration && isOwner() && scope.valid(request.ticket)) armed = false
          return true
        })
      }
      repair()
    })
  }
  const invalidate = () => {
    generation++
    explicit = null
    if (frame) { view.cancelAnimationFrame(frame); frame = 0 }
  }
  const retireGesture = () => {
    if (gestureFrame) view.cancelAnimationFrame(gestureFrame)
    gestureFrame = 0
    gesture = null
  }
  const engage = () => {
    const element = active()
    if (!isOwner() || !element) return
    // A held selection/composition belongs to its original editor. Moving to a
    // different field must not leave that field paused by the earlier editor.
    if (selecting?.target !== element) selecting = null
    if (composing !== element) composing = null
    // A new field/editing context wins over an earlier gesture's deferred work.
    // Cancelling a layout frame alone would still let that gesture disarm B.
    retireGesture()
    contextGeneration++
    if (selecting) selecting.context = contextGeneration
    target = element
    armed = true
    lastProxy = null
    lastGeometry = null
    const currentGeneration = generation
    queueMicrotask(() => {
      if (!live || currentGeneration !== generation || !isOwner()) return
      if (frame || gesture !== null || composing || selecting) { schedule(); return }
      observeChildren()
      if (size()) { schedule(); return }
      repair(true)
    })
  }
  const ownsGesture = (current: Gesture) => gesture === current && isOwner()
    && current.context === contextGeneration && current.owner === scope.currentOwner()?.lifetime
  const settleGesture = (current = gesture) => {
    if (current && ownsGesture(current) && Math.abs(dialog.scrollTop - current.top) > EPSILON) armed = false
  }
  const settleAfterRelease = (current: Gesture) => {
    if (gestureFrame) view.cancelAnimationFrame(gestureFrame)
    gestureFrame = view.requestAnimationFrame(() => {
      if (!ownsGesture(current) || current.held) return
      settleGesture(current)
      gestureFrame = view.requestAnimationFrame(() => {
        gestureFrame = 0
        if (!ownsGesture(current) || current.held) return
        settleGesture(current)
        gesture = null
        schedule()
      })
    })
  }
  const trackGesture = (kind: Gesture['kind'] = 'transient', identifier: number | null = null) => {
    if (gesture && ownsGesture(gesture)) {
      settleGesture(gesture)
      // Wheel/key input during a held drag does not shorten that drag's life.
      if (gesture.held && kind === 'transient') return
      if (gesture.kind === kind && gesture.identifier === identifier && (kind === 'transient' || gesture.held)) {
        if (!gesture.held) settleAfterRelease(gesture)
        return
      }
    }
    retireGesture()
    const current: Gesture = {
      context: contextGeneration, owner: scope.currentOwner()?.lifetime, top: dialog.scrollTop,
      kind, identifier, held: kind !== 'transient',
    }
    gesture = current
    // A held scrollbar/touch has no expiry and no idle animation-frame loop.
    // Actual scroll events remain attributable until release or cancellation.
    if (!current.held) settleAfterRelease(current)
  }
  const releaseGesture = (kind: Gesture['kind'], identifier: number | null) => {
    const current = gesture
    if (!current || !ownsGesture(current) || current.kind !== kind
      || identifier !== null && current.identifier !== identifier) return
    settleGesture(current)
    current.held = false
    settleAfterRelease(current)
  }
  const unsubscribe = scope.subscribe(intent => {
    invalidate()
    if (['wheel', 'touch', 'owner', 'navigation'].includes(intent.kind)) selecting = null
    if (['wheel', 'touch', 'owner', 'navigation'].includes(intent.kind)
      || intent.target && intent.target !== editingTarget && intent.kind !== 'selection') editingTarget = null
    if (intent.kind === 'owner') {
      if (!isOwner()) {
        retireGesture()
        contextGeneration++
        armed = false; selecting = null; composing = null
      } else schedule() // fresh sizing on resumption; no implicit re-engagement
      return
    }
    if (!isOwner()) return
    const inside = !!intent.target && dialog.contains(intent.target)
    if (intent.kind === 'focus') {
      if (inside) engage()
      else { armed = false; selecting = null; composing = null }
      return
    }
    if (intent.kind === 'navigation') { retireGesture(); armed = false; return }
    if (intent.kind === 'pointer-end') {
      const identifier = (intent.event as PointerEvent).pointerId
      releaseGesture('pointer', identifier)
      if (selecting?.identifier === identifier) {
        const selection = selecting
        selecting = null
        // Release only removes this editor's pause. It does not create a new
        // focus/editing context or revive one abandoned by manual movement.
        if (selection.target !== active() || selection.owner !== lifetime
          || selection.context !== contextGeneration) return
      }
      schedule()
      return
    }
    if (intent.kind === 'touch-end') {
      const event = intent.event as TouchEvent
      for (const touch of Array.from(event.changedTouches)) releaseGesture('touch', touch.identifier)
      schedule()
      return
    }
    if (intent.kind === 'composition-start') {
      if (inside && isEditor(intent.target) && intent.target === active()) composing = intent.target
      else schedule()
      return
    }
    if (intent.kind === 'composition-end') {
      if (!inside || composing !== intent.target) {
        // Cancellation retired the old event's work, not B's right to remain
        // visible. Resume its guarded check without creating or rearming B.
        schedule()
        return
      }
      composing = null
      if (intent.target === active()) engage()
      else schedule()
      return
    }
    if (!inside) return
    if (intent.kind === 'edit') { editingTarget = intent.target; engage(); return }
    if (intent.kind === 'selection') {
      if (armed || selecting?.target === intent.target || editingTarget === intent.target) engage()
      return
    }
    if (intent.kind === 'wheel') { trackGesture(); return }
    if (intent.kind === 'touch') {
      const touch = (intent.event as TouchEvent).changedTouches.item(0)
      trackGesture('touch', touch?.identifier ?? null)
      return
    }
    if (intent.kind === 'pointer') {
      const event = intent.event as PointerEvent
      if (event.pointerType === 'touch') return // the touch lifecycle owns its pan
      selecting = null
      const node = intent.target!
      const box = clientBox(node)
      const scrollBar = node.scrollHeight > node.clientHeight && event.clientX >= box.right
      if (scrollBar || node === dialog) trackGesture('pointer', event.pointerId)
      else if (isEditor(node)) {
        editingTarget = node
        selecting = { target: node, identifier: event.pointerId, context: contextGeneration, owner: lifetime }
        // The native focus change follows pointerdown. Do not engage the old
        // active field before the clicked editor receives that focus.
        if (node === active()) engage()
      }
      return
    }
    if (intent.kind === 'key') {
      const event = intent.event as KeyboardEvent
      if (event.isComposing) return
      if (isEditor(intent.target)) {
        editingTarget = intent.target
        return // native caret/selection emits its own editing context
      }
      if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) trackGesture()
    }
  })
  const resize = new ResizeObserver(schedule)
  const mutation = new MutationObserver(records => {
    if (records.some(record => record.target !== dialog || record.attributeName !== 'style')) schedule()
  })
  mutation.observe(dialog, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['class', 'style', 'open', 'hidden'] })
  const onScroll = (event: Event) => {
    if (event.target === dialog) settleGesture()
  }
  document.addEventListener('scroll', onScroll, true)
  view.addEventListener('resize', schedule)
  view.visualViewport?.addEventListener('resize', schedule)
  document.fonts.addEventListener('loadingdone', schedule)
  const unregister = scope.register(dialog, {
    request(ticket, destination, alignment) {
      if (!scope.valid(ticket) || !isOwner()) return
      explicit = { ticket, target: destination, alignment }
      schedule()
    },
  })
  if (isOwner()) { observeChildren(); schedule() }
  return () => {
    live = false
    generation++
    explicit = null
    selecting = null
    composing = null
    unsubscribe()
    unregister()
    resize.disconnect()
    mutation.disconnect()
    if (frame) view.cancelAnimationFrame(frame)
    retireGesture()
    document.removeEventListener('scroll', onScroll, true)
    view.removeEventListener('resize', schedule)
    view.visualViewport?.removeEventListener('resize', schedule)
    document.fonts.removeEventListener('loadingdone', schedule)
    for (const [name, previous] of originalStyles) {
      if (dialog.style.getPropertyValue(name) !== publishedStyles.get(name)) continue
      if (previous.value) dialog.style.setProperty(name, previous.value, previous.priority)
      else dialog.style.removeProperty(name)
    }
    if (dialog.getAttribute('data-dialog-footer-flow') === publishedFlow) {
      if (originalFlow === null) dialog.removeAttribute('data-dialog-footer-flow')
      else dialog.setAttribute('data-dialog-footer-flow', originalFlow)
    }
  }
}

/** Keep legitimate synchronous restoration; cancel its deferred reveal on new intent. */
export function revealRestoredOpener(target: HTMLElement, currentOwner: () => DialogFocusOwner | null) {
  const document = target.ownerDocument
  const view = document.defaultView
  if (!view) return
  let cancelled = false
  const owner = currentOwner()
  const cancel = () => { cancelled = true }
  const events = ['wheel', 'touchstart', 'touchmove', 'pointerdown', 'keydown', 'focusin']
  for (const event of events) document.addEventListener(event, cancel, { capture: true, passive: true, once: true })
  view.requestAnimationFrame(() => {
    for (const event of events) document.removeEventListener(event, cancel, true)
    if (cancelled || !target.isConnected || document.activeElement !== target || currentOwner()?.dialog || document.querySelector('dialog[open]')
      || currentOwner()?.lifetime !== owner?.lifetime || target === document.body || target === document.documentElement
      || target.matches(':disabled') || target.closest('[inert]') || !target.getClientRects().length
      || view.getComputedStyle(target).visibility !== 'visible') return
    target.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' })
  })
}
