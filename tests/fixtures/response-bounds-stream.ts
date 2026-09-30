/**
 * Byte-exact streamed bodies for the response-bound tests. Plain Node only:
 * the fixture child's fetch preload also loads this module, so it must not
 * import vitest, Playwright or product code. Padding reuses one shared chunk
 * buffer, so a 64 MiB body never exists as one allocation in the test process.
 */
export const RESPONSE_BOUNDS_FIXTURE = 'orbit-response-bounds-v1' as const
export const DEFAULT_CHUNK_BYTES = 1024 * 1024
/** ASCII "x": one byte per character, harmless inside JSON strings and HTML comments. */
export const PAD_BYTE = 0x78

export interface StreamDirective {
  fixtureResponse: typeof RESPONSE_BOUNDS_FIXTURE
  /** UTF-8 text written before the padding. */
  prefix: string
  /** UTF-8 text written after the padding. */
  suffix: string
  padBytes: number
  chunkBytes?: number
  status?: number
  contentType?: string
  headers?: Record<string, string>
}

export interface StreamHooks {
  onStart?: (controller: ReadableStreamDefaultController<Uint8Array>) => void
  /** Called after each enqueue with the cumulative enqueued byte count. */
  onPull?: (enqueuedBytes: number) => void
  /** Its return value is returned from the underlying source's cancel(). */
  onCancel?: (reason: unknown) => void | PromiseLike<void>
  /** Called when every byte has been enqueued and the stream closed normally. */
  onClose?: () => void
}

export function isStreamDirective(value: unknown): value is StreamDirective {
  return typeof value === 'object' && value !== null
    && (value as { fixtureResponse?: unknown }).fixtureResponse === RESPONSE_BOUNDS_FIXTURE
}

export function streamDirective(prefix: string, suffix: string, totalBytes: number,
  options: Partial<Pick<StreamDirective, 'chunkBytes' | 'status' | 'contentType' | 'headers'>> = {}): StreamDirective {
  const padBytes = totalBytes - Buffer.byteLength(prefix) - Buffer.byteLength(suffix)
  if (!Number.isSafeInteger(padBytes) || padBytes < 0) throw new Error(`A ${totalBytes}-byte body cannot contain this prefix and suffix`)
  return { fixtureResponse: RESPONSE_BOUNDS_FIXTURE, prefix, suffix, padBytes, ...options }
}

export function directiveBytes(directive: StreamDirective): number {
  return Buffer.byteLength(directive.prefix) + directive.padBytes + Buffer.byteLength(directive.suffix)
}

const sharedPad = Buffer.alloc(DEFAULT_CHUNK_BYTES, PAD_BYTE)

/** A view of the shared padding buffer; never written to by consumers. */
export function padChunk(bytes = DEFAULT_CHUNK_BYTES): Uint8Array {
  return sharedPad.subarray(0, Math.min(bytes, DEFAULT_CHUNK_BYTES))
}

export function* directiveChunks(directive: StreamDirective): Generator<Uint8Array, void, undefined> {
  const chunkBytes = directive.chunkBytes ?? DEFAULT_CHUNK_BYTES
  if (!Number.isSafeInteger(chunkBytes) || chunkBytes < 1) throw new Error('chunkBytes must be a positive integer')
  const pad = chunkBytes <= DEFAULT_CHUNK_BYTES ? sharedPad : Buffer.alloc(chunkBytes, PAD_BYTE)
  if (directive.prefix) yield Buffer.from(directive.prefix)
  let remaining = directive.padBytes
  while (remaining > 0) {
    const size = Math.min(remaining, chunkBytes)
    yield pad.subarray(0, size)
    remaining -= size
  }
  if (directive.suffix) yield Buffer.from(directive.suffix)
}

/** One chunk per pull, in order, then a normal close. */
export function chunkStream(chunks: Iterable<Uint8Array>, hooks: StreamHooks = {}): ReadableStream<Uint8Array> {
  const iterator = chunks[Symbol.iterator]()
  let enqueued = 0
  return new ReadableStream<Uint8Array>({
    start(controller) { hooks.onStart?.(controller) },
    pull(controller) {
      const next = iterator.next()
      if (next.done) {
        controller.close()
        hooks.onClose?.()
        return
      }
      enqueued += next.value.byteLength
      controller.enqueue(next.value)
      hooks.onPull?.(enqueued)
    },
    cancel(reason) { return hooks.onCancel?.(reason) },
  })
}

/** Delivers the given chunks, then stays open forever unless cancelled or errored. */
export function pendingStream(chunks: Uint8Array[], hooks: StreamHooks = {}): ReadableStream<Uint8Array> {
  let index = 0
  let enqueued = 0
  return new ReadableStream<Uint8Array>({
    start(controller) { hooks.onStart?.(controller) },
    pull(controller) {
      if (index < chunks.length) {
        const chunk = chunks[index++]
        enqueued += chunk.byteLength
        controller.enqueue(chunk)
        hooks.onPull?.(enqueued)
        return undefined
      }
      return new Promise<void>(() => undefined)
    },
    cancel(reason) { return hooks.onCancel?.(reason) },
  })
}

export function directiveStream(directive: StreamDirective, hooks: StreamHooks = {}): ReadableStream<Uint8Array> {
  return chunkStream(directiveChunks(directive), hooks)
}

export function directiveResponse(directive: StreamDirective, hooks: StreamHooks = {}): Response {
  return new Response(directiveStream(directive, hooks), {
    status: directive.status ?? 200,
    headers: { 'Content-Type': directive.contentType ?? 'application/json', ...directive.headers },
  })
}

/** Split a buffer at the given byte offsets, for chunk-boundary cases. */
export function splitAt(bytes: Uint8Array, offsets: number[]): Uint8Array[] {
  const cuts = [...new Set(offsets.filter(offset => offset > 0 && offset < bytes.byteLength))].sort((a, b) => a - b)
  const parts: Uint8Array[] = []
  let start = 0
  for (const cut of cuts) {
    parts.push(bytes.subarray(start, cut))
    start = cut
  }
  parts.push(bytes.subarray(start))
  return parts
}
