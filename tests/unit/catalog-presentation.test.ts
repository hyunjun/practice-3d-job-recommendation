import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CatalogPresentationQueue } from '../../src/lib/catalog-presentation'

function deferred() {
  let resolve!: () => void
  let reject!: (cause: unknown) => void
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'performance'] })
  vi.setSystemTime(new Date('2032-01-01T00:00:00.000Z'))
})
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

describe('catalog presentation: observable publication and waiter contracts', () => {
  it('waits the full 120 ms idle debounce, then publishes once and resolves its caller', async () => {
    const queue = new CatalogPresentationQueue(), visible: string[] = []
    const done = queue.enqueue(async () => { visible.push('London: 2 companies / 3 jobs') })
    await vi.advanceTimersByTimeAsync(119)
    expect(visible).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    await done
    expect(visible).toEqual(['London: 2 companies / 3 jobs'])
    await vi.advanceTimersByTimeAsync(3000)
    expect(visible).toEqual(['London: 2 companies / 3 jobs'])
  })

  it('debounces from the latest receipt and resolves both callers with only the latest publication', async () => {
    const queue = new CatalogPresentationQueue(), visible: string[] = [], settled: string[] = []
    const first = queue.enqueue(async () => { visible.push('London: 2 companies') }).then(() => { settled.push('first') })
    await vi.advanceTimersByTimeAsync(119)
    const second = queue.enqueue(async () => { visible.push('London: 4 companies') }).then(() => { settled.push('second') })
    await vi.advanceTimersByTimeAsync(119)
    expect(visible).toEqual([])
    expect(settled).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    await Promise.all([first, second])
    expect(visible).toEqual(['London: 4 companies'])
    expect(settled).toEqual(['first', 'second'])
    expect(performance.now()).toBe(239)
  })

  it('repeated idle arrivals cannot renew the original 1500 ms publication deadline', async () => {
    const queue = new CatalogPresentationQueue(), visible: number[] = [], waiting: Promise<void>[] = []
    for (let receipt = 0; receipt < 15; receipt++) {
      if (receipt) await vi.advanceTimersByTimeAsync(100)
      waiting.push(queue.enqueue(async () => { visible.push(receipt) }))
      expect(visible).toEqual([])
    }
    await vi.advanceTimersByTimeAsync(99)
    expect(visible).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    await Promise.all(waiting)
    expect(visible).toEqual([14])
    expect(performance.now()).toBe(1500)
  })

  it('a held gesture defers an arrival through 1499 ms and publishes at 1500 ms', async () => {
    const queue = new CatalogPresentationQueue(), visible: number[] = []
    queue.setInteracting(true)
    const done = queue.enqueue(async () => { visible.push(performance.now()) })
    await vi.advanceTimersByTimeAsync(1499)
    expect(visible).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    await done
    expect(visible).toEqual([1500])
  })

  it('a newer receipt and duplicate active notifications retain the first held-gesture deadline', async () => {
    const queue = new CatalogPresentationQueue(), visible: string[] = []
    queue.setInteracting(true)
    const first = queue.enqueue(async () => { visible.push('older') })
    await vi.advanceTimersByTimeAsync(1000)
    queue.setInteracting(true)
    const latest = queue.enqueue(async () => { visible.push('latest') })
    await vi.advanceTimersByTimeAsync(499)
    expect(visible).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    await Promise.all([first, latest])
    expect(visible).toEqual(['latest'])
    expect(performance.now()).toBe(1500)
  })

  it('ending a gesture allows the idle debounce without losing the pending latest value', async () => {
    const queue = new CatalogPresentationQueue(), visible: number[] = []
    queue.setInteracting(true)
    const done = queue.enqueue(async () => { visible.push(performance.now()) })
    await vi.advanceTimersByTimeAsync(80)
    queue.setInteracting(false)
    await vi.advanceTimersByTimeAsync(119)
    expect(visible).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    await done
    expect(visible).toEqual([200])
  })

  it('ending a gesture near its deadline never adds a fresh 120 ms past the cap', async () => {
    const queue = new CatalogPresentationQueue(), visible: number[] = []
    queue.setInteracting(true)
    const done = queue.enqueue(async () => { visible.push(performance.now()) })
    await vi.advanceTimersByTimeAsync(1490)
    queue.setInteracting(false)
    await vi.advanceTimersByTimeAsync(9)
    expect(visible).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    await done
    expect(visible).toEqual([1500])
  })

  it('starting interaction before an idle timer expires prevents its 120 ms publication', async () => {
    const queue = new CatalogPresentationQueue(), visible: number[] = []
    const done = queue.enqueue(async () => { visible.push(performance.now()) })
    await vi.advanceTimersByTimeAsync(119)
    queue.setInteracting(true)
    await vi.advanceTimersByTimeAsync(1380)
    expect(visible).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    await done
    expect(visible).toEqual([1500])
  })

  it('a first urgent catalog has a zero-ms asynchronous publication when idle', async () => {
    const queue = new CatalogPresentationQueue(), visible: number[] = []
    const done = queue.enqueue(async () => { visible.push(performance.now()) }, true)
    expect(visible).toEqual([])
    await vi.advanceTimersByTimeAsync(0)
    await done
    expect(visible).toEqual([0])
  })

  it('urgency does not break an active gesture, but its end releases the urgent latest catalog without 120 ms', async () => {
    const queue = new CatalogPresentationQueue(), visible: string[] = []
    queue.setInteracting(true)
    const first = queue.enqueue(async () => { visible.push('initial') }, true)
    await vi.advanceTimersByTimeAsync(80)
    const latest = queue.enqueue(async () => { visible.push('latest first catalog') })
    expect(visible).toEqual([])
    queue.setInteracting(false)
    await vi.advanceTimersByTimeAsync(0)
    await Promise.all([first, latest])
    expect(visible).toEqual(['latest first catalog'])
    expect(performance.now()).toBe(80)
  })

  it('an urgent first catalog is still bounded at 1500 ms when the gesture never ends', async () => {
    const queue = new CatalogPresentationQueue(), visible: number[] = []
    queue.setInteracting(true)
    const done = queue.enqueue(async () => { visible.push(performance.now()) }, true)
    await vi.advanceTimersByTimeAsync(1499)
    expect(visible).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    await done
    expect(visible).toEqual([1500])
  })

  it('explicit intent flushes the latest pending catalog immediately and preserves interaction for the next receipt', async () => {
    const queue = new CatalogPresentationQueue(), visible: string[] = []
    queue.setInteracting(true)
    const old = queue.enqueue(async () => { visible.push('obsolete query') })
    const newest = queue.enqueue(async () => { visible.push('explicit query: Birch') })
    await queue.flush()
    await Promise.all([old, newest])
    expect(visible).toEqual(['explicit query: Birch'])
    expect(performance.now()).toBe(0)
    const subsequent = queue.enqueue(async () => { visible.push('next receipt') })
    await vi.advanceTimersByTimeAsync(1499)
    expect(visible).toEqual(['explicit query: Birch'])
    await vi.advanceTimersByTimeAsync(1)
    await subsequent
    expect(visible).toEqual(['explicit query: Birch', 'next receipt'])
  })

  it('flush waits for an already running task, then publishes the newest queued task serially', async () => {
    const queue = new CatalogPresentationQueue(), gate = deferred(), events: string[] = []
    const first = queue.enqueue(async () => { events.push('first starts'); await gate.promise; events.push('first ends') })
    const firstFlush = queue.flush()
    await Promise.resolve()
    const second = queue.enqueue(async () => { events.push('discarded second') })
    const third = queue.enqueue(async () => { events.push('third starts'); events.push('third ends') })
    const flushed = queue.flush()
    await vi.advanceTimersByTimeAsync(2000)
    expect(events).toEqual(['first starts'])
    gate.resolve()
    await Promise.all([first, second, third, firstFlush, flushed])
    expect(events).toEqual(['first starts', 'first ends', 'third starts', 'third ends'])
  })

  it('a queued task already past its idle debounce starts as soon as the preceding serial task ends', async () => {
    const queue = new CatalogPresentationQueue(), gate = deferred(), events: string[] = []
    const first = queue.enqueue(async () => { events.push('first starts at 0'); await gate.promise; events.push('first ends at 200') }, true)
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(10)
    const second = queue.enqueue(async () => { events.push(`second starts at ${performance.now()}`) })
    await vi.advanceTimersByTimeAsync(190)
    expect(events).toEqual(['first starts at 0'])
    gate.resolve()
    await first
    await vi.advanceTimersByTimeAsync(0)
    // Receipt at 10 became eligible at 130. Serial execution blocked it until
    // 200; it must not pay another idle debounce until 320.
    expect(events).toEqual(['first starts at 0', 'first ends at 200', 'second starts at 200'])
    await second
  })

  it('a queued receipt keeps only its remaining idle debounce after a short preceding task', async () => {
    const queue = new CatalogPresentationQueue(), gate = deferred(), visible: number[] = []
    const first = queue.enqueue(async () => { await gate.promise }, true)
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(10)
    const second = queue.enqueue(async () => { visible.push(performance.now()) })
    await vi.advanceTimersByTimeAsync(40)
    gate.resolve()
    await first
    await vi.advanceTimersByTimeAsync(79)
    expect(visible).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(visible).toEqual([130])
    await second
  })

  it('a blocked serial task never overlaps a successor even when the successor exceeds the maximum wait', async () => {
    const queue = new CatalogPresentationQueue(), gate = deferred(), events: string[] = []
    queue.setInteracting(true)
    const first = queue.enqueue(async () => { events.push('first starts'); await gate.promise; events.push('first ends') })
    const flushed = queue.flush()
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(10)
    const second = queue.enqueue(async () => { events.push('second starts') })
    await vi.advanceTimersByTimeAsync(1600)
    expect(events).toEqual(['first starts'])
    gate.resolve()
    await Promise.all([first, second, flushed])
    expect(events).toEqual(['first starts', 'first ends', 'second starts'])
  })

  it('coalesced callers receive the same failure and a subsequent catalog can still publish', async () => {
    const queue = new CatalogPresentationQueue(), failure = new Error('Fictional presentation failed'), visible: string[] = []
    const first = queue.enqueue(async () => { visible.push('discarded') })
    const second = queue.enqueue(async () => { throw failure })
    const rejectedFirst = expect(first).rejects.toBe(failure)
    const rejectedSecond = expect(second).rejects.toBe(failure)
    await vi.advanceTimersByTimeAsync(120)
    await Promise.all([rejectedFirst, rejectedSecond])
    expect(visible).toEqual([])
    const recovered = queue.enqueue(async () => { visible.push('valid recovery') })
    await vi.advanceTimersByTimeAsync(120)
    await recovered
    expect(visible).toEqual(['valid recovery'])
  })

  it('a synchronous callback throw rejects the caller instead of leaving its waiter pending', async () => {
    const queue = new CatalogPresentationQueue(), failure = new Error('Fictional synchronous callback failure')
    const done = queue.enqueue(() => { throw failure })
    const rejected = expect(done).rejects.toBe(failure)
    await vi.advanceTimersByTimeAsync(120)
    await rejected
    await expect(queue.flush()).resolves.toBeUndefined()
  })

  it('cancel rejects every queued caller with AbortError and prevents a delayed stale publication', async () => {
    const queue = new CatalogPresentationQueue(), visible: string[] = []
    const first = queue.enqueue(async () => { visible.push('first') })
    const second = queue.enqueue(async () => { visible.push('second') })
    const rejectedFirst = expect(first).rejects.toMatchObject({ name: 'AbortError' })
    const rejectedSecond = expect(second).rejects.toMatchObject({ name: 'AbortError' })
    queue.cancel()
    queue.cancel()
    await Promise.all([rejectedFirst, rejectedSecond])
    await vi.advanceTimersByTimeAsync(10000)
    expect(visible).toEqual([])
    await expect(queue.flush()).resolves.toBeUndefined()
  })

  it('cancel and rejoin do not clear an active map flag or inherit the old deadline', async () => {
    const queue = new CatalogPresentationQueue(), visible: string[] = []
    queue.setInteracting(true)
    const old = queue.enqueue(async () => { visible.push('cancelled stream') })
    const rejected = expect(old).rejects.toMatchObject({ name: 'AbortError' })
    await vi.advanceTimersByTimeAsync(1000)
    queue.cancel()
    await rejected
    const fresh = queue.enqueue(async () => { visible.push('new stream') }, true)
    await vi.advanceTimersByTimeAsync(1499)
    expect(visible).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    await fresh
    expect(visible).toEqual(['new stream'])
    expect(performance.now()).toBe(2500)
  })

  it('cancel removes queued work but allows an already running publication and its caller to finish', async () => {
    const queue = new CatalogPresentationQueue(), gate = deferred(), visible: string[] = []
    const running = queue.enqueue(async () => { visible.push('running starts'); await gate.promise; visible.push('running ends') })
    const flushed = queue.flush()
    await Promise.resolve()
    const queued = queue.enqueue(async () => { visible.push('cancelled queued work') })
    const rejected = expect(queued).rejects.toMatchObject({ name: 'AbortError' })
    queue.cancel()
    await rejected
    gate.resolve()
    await Promise.all([running, flushed])
    await vi.advanceTimersByTimeAsync(3000)
    expect(visible).toEqual(['running starts', 'running ends'])
  })

  it('an explicit flush failure preserves the active gesture when the next receipt arrives', async () => {
    const queue = new CatalogPresentationQueue(), failure = new Error('Fictional failed projection'), visible: number[] = []
    queue.setInteracting(true)
    const done = queue.enqueue(async () => { throw failure })
    const rejected = expect(done).rejects.toBe(failure)
    await expect(queue.flush()).rejects.toBe(failure)
    await rejected
    const next = queue.enqueue(async () => { visible.push(performance.now()) })
    await vi.advanceTimersByTimeAsync(1499)
    expect(visible).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    await next
    expect(visible).toEqual([1500])
  })

  it('wall-clock jumps in either direction cannot lengthen or prematurely release a native-performance deadline', async () => {
    const queue = new CatalogPresentationQueue(), visible: number[] = []
    queue.setInteracting(true)
    const first = queue.enqueue(async () => { visible.push(-1) })
    await vi.advanceTimersByTimeAsync(600)
    vi.setSystemTime(new Date('1999-01-01T00:00:00.000Z'))
    const latest = queue.enqueue(async () => { visible.push(performance.now()) })
    await vi.advanceTimersByTimeAsync(600)
    vi.setSystemTime(new Date('2099-01-01T00:00:00.000Z'))
    queue.setInteracting(true)
    await vi.advanceTimersByTimeAsync(299)
    expect(visible).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    await Promise.all([first, latest])
    expect(visible).toEqual([1500])
  })
})
