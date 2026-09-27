/**
 * Publish the newest received snapshot as one update. The worker can continue preparing
 * data while a map gesture is active, but presentation has a bounded maximum wait.
 */
export class CatalogPresentationQueue {
  private timer: ReturnType<typeof setTimeout> | undefined
  private firstQueuedAt: number | undefined
  private idleReadyAt: number | undefined
  private interacting = false
  private immediate = false
  private pending: (() => Promise<void>) | undefined
  private running: Promise<void> | undefined
  private waiting: { resolve: () => void; reject: (cause: unknown) => void }[] = []

  constructor(private readonly delay = 120, private readonly maximumWait = 1500) {}

  enqueue(task: () => Promise<void>, immediate = false): Promise<void> {
    this.pending = task
    this.immediate ||= immediate
    const now = performance.now()
    this.firstQueuedAt ??= now
    this.idleReadyAt = now + this.delay
    const result = new Promise<void>((resolve, reject) => this.waiting.push({ resolve, reject }))
    this.plan()
    return result
  }

  setInteracting(active: boolean) {
    if (active === this.interacting) return
    this.interacting = active
    if (!active && this.pending) this.idleReadyAt = performance.now() + this.delay
    this.plan()
  }

  private plan() {
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
    if (!this.pending || this.running || this.firstQueuedAt === undefined) return
    const now = performance.now()
    const remaining = Math.max(0, this.maximumWait - (now - this.firstQueuedAt))
    const idleWait = this.immediate ? 0 : Math.max(0, (this.idleReadyAt ?? now) - now)
    this.timer = setTimeout(() => { this.timer = undefined; void this.run().catch(() => { /* Enqueue callers own the failure. */ }) },
      this.interacting ? remaining : Math.min(idleWait, remaining))
  }

  private run(): Promise<void> {
    if (this.running) return this.running
    const task = this.pending
    if (!task) return Promise.resolve()
    const waiting = this.waiting
    this.waiting = []
    this.pending = undefined
    this.firstQueuedAt = undefined
    this.idleReadyAt = undefined
    this.immediate = false
    const run = Promise.resolve().then(task).then(
      () => { for (const item of waiting) item.resolve() },
      cause => {
        for (const item of waiting) item.reject(cause)
        throw cause
      },
    ).finally(() => {
      if (this.running === run) this.running = undefined
      this.plan()
    })
    this.running = run
    return run
  }

  /** Explicit filter/profile changes may immediately request the prepared data. */
  flush(): Promise<void> {
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
    return this.run().then(() => this.pending ? this.flush() : undefined)
  }

  cancel() {
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
    this.pending = undefined
    this.firstQueuedAt = undefined
    this.idleReadyAt = undefined
    this.immediate = false
    const cause = new DOMException('공고 화면 갱신을 취소했어요.', 'AbortError')
    for (const item of this.waiting) item.reject(cause)
    this.waiting = []
  }
}
