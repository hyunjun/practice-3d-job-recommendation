import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import { setTimeout as delay } from 'node:timers/promises'

// Real HTTP bytes, with Content-Length deliberately incomplete until EOF release.
// JSON/arrayBuffer readers cannot finish before the final bytes arrive.
export class ResponseGate {
  constructor(response, bytes, { encoding = 'br', chunks = 24, cadenceMs = 50, tailBytes = 16, log = () => {} } = {}) {
    assert(bytes.length > tailBytes)
    this.response = response
    this.bytes = bytes
    this.options = { encoding, chunks, cadenceMs, tailBytes }
    this.log = log
    this.phase = 'headers-held'
    this.written = 0
    this.cancelled = false
    response.on('close', () => {
      if (!response.writableEnded) {
        this.cancelled = true
        this.phase = 'cancelled'
        log({ type: 'client-abort', bytes: this.written })
      }
    })
  }
  state() { return { phase: this.phase, written: this.written, total: this.bytes.length, cancelled: this.cancelled } }
  async body() {
    assert.equal(this.phase, 'headers-held')
    const { response, bytes, options } = this
    response.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8', 'Content-Length': bytes.length,
      ...(options.encoding === 'identity' ? {} : { 'Content-Encoding': options.encoding }),
      'Cache-Control': 'no-store', 'Timing-Allow-Origin': '*',
      'X-Globe-QA-Gated': 'body-then-eof',
    })
    response.flushHeaders()
    this.phase = 'body-sending'
    this.log({ type: 'body-start', bytes: bytes.length })
    const end = bytes.length - options.tailBytes, start = performance.now()
    for (let i = 1; i <= options.chunks; i++) {
      await delay(Math.max(0, start + (i - 1) * options.cadenceMs - performance.now()))
      if (this.cancelled) return
      const next = Math.floor(end * i / options.chunks)
      // The loopback fixture is small on the wire; drain waits preserve order.
      const drained = response.write(bytes.subarray(this.written, next))
      this.written = next
      if (!drained) await new Promise(resolve => {
        const done = () => { response.off('drain', done); response.off('close', done); resolve() }
        response.once('drain', done); response.once('close', done)
      })
    }
    if (this.cancelled) return
    this.phase = 'eof-held'
    this.log({ type: 'body-held-at-eof', bytes: this.written })
  }
  eof() {
    assert.equal(this.phase, 'eof-held')
    this.response.end(this.bytes.subarray(this.written))
    this.written = this.bytes.length
    this.phase = 'complete'
    this.log({ type: 'eof-release', bytes: this.written })
  }
  dispose() {
    if (!this.response.writableEnded) this.response.destroy()
  }
}
