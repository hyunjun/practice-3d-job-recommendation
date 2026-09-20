import type { Page } from '@playwright/test'

export const EARLIER_RESUME = `Ada Earlier
Backend Engineer
9 years of software engineering experience.
I built payment APIs and data services using Python, Django and PostgreSQL.
PRIVATE_RESUME_47_EARLIER old-private@example.test`

export const LATEST_RESUME = `Nora Latest
Frontend Engineer
2 years of software engineering experience.
I build accessible web interfaces with TypeScript and React.
PRIVATE_RESUME_47_LATEST new-private@example.test`

export const THIRD_RESUME = `Theo Current
Backend Engineer
4 years of software engineering experience.
I maintain reliable services and developer tools with Go, Docker and PostgreSQL.
PRIVATE_RESUME_47_CURRENT current-private@example.test`

export const CANCEL_MESSAGE = '파일 읽기를 취소했어요. 입력한 내용은 유지됩니다.'

type ReadMethod = 'text' | 'arrayBuffer'
interface ReadEvent {
  id: string
  filename: string
  method: ReadMethod
  nativeCompleted: boolean
  nativeLength?: number
  released: boolean
  rejected: boolean
  delivered: boolean
}
interface ReadGate {
  events: ReadEvent[]
  arm: (id: string, filename: string, method: ReadMethod) => void
  release: (id: string) => void
  reject: (id: string, message: string) => void
}
declare global {
  interface Window { __resumeReadGate47: ReadGate }
}

/**
 * Hold delivery of actual browser File reads. The native method still reads the
 * supplied fictional file; only promise ordering (or an explicit read error) is
 * controlled. No component state, resume parser or analyzed profile is replaced.
 */
export async function installResumeReadGates(page: Page) {
  // Explicit browser JavaScript prevents Node/tsx function-name helpers from
  // leaking into the isolated page. Native reads and returned values stay real.
  await page.addInitScript({ content: `(() => {
    const armed = []
    const pending = new Map()
    const events = []
    const originals = { text: File.prototype.text, arrayBuffer: File.prototype.arrayBuffer }
    for (const method of ['text', 'arrayBuffer']) {
      const original = originals[method]
      Object.defineProperty(File.prototype, method, {
        configurable: true,
        writable: true,
        value: function () {
          const native = original.call(this)
          const index = armed.findIndex(item => item.filename === this.name && item.method === method)
          if (index < 0) return native
          const { id } = armed.splice(index, 1)[0]
          const event = {
            id, filename: this.name, method, nativeCompleted: false, released: false, rejected: false, delivered: false,
          }
          events.push(event)
          const held = new Promise((resolve, reject) => {
            pending.set(id, {
              release: () => { event.released = true; resolve() },
              reject: error => { event.rejected = true; reject(error) },
            })
          })
          const observedNative = native.then(value => {
            event.nativeCompleted = true
            event.nativeLength = typeof value === 'string' ? value.length : value.byteLength
            return value
          })
          return Promise.all([observedNative, held]).then(
            ([value]) => { event.delivered = true; return value },
            error => { event.delivered = true; throw error },
          )
        },
      })
    }
    window.__resumeReadGate47 = {
      events,
      arm(id, filename, method) {
        if (armed.some(item => item.id === id) || pending.has(id)) throw new Error('Duplicate resume gate: ' + id)
        armed.push({ id, filename, method })
      },
      release(id) {
        const gate = pending.get(id)
        if (!gate) throw new Error('No native read is pending for ' + id)
        gate.release()
        pending.delete(id)
      },
      reject(id, message) {
        const gate = pending.get(id)
        if (!gate) throw new Error('No native read is pending for ' + id)
        gate.reject(new DOMException(message, 'NotReadableError'))
        pending.delete(id)
      },
    }
  })()` })
}

export async function armResumeRead(page: Page, id: string, filename: string, method: ReadMethod = 'text') {
  await page.evaluate(({ id, filename, method }) => window.__resumeReadGate47.arm(id, filename, method), { id, filename, method })
}

export async function releaseResumeRead(page: Page, id: string) {
  await page.evaluate(id => window.__resumeReadGate47.release(id), id)
}

export async function rejectResumeRead(page: Page, id: string, message: string) {
  await page.evaluate(({ id, message }) => window.__resumeReadGate47.reject(id, message), { id, message })
}

export async function resumeReadEvents(page: Page) {
  return page.evaluate(() => window.__resumeReadGate47.events)
}

/** Observe the next real browser paint after releasing/rejecting a native read. */
export async function afterResumeReadDelivery(page: Page) {
  await page.evaluate('new Promise(resolve => requestAnimationFrame(resolve))')
}
