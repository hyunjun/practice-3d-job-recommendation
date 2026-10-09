import { randomBytes } from 'node:crypto'
import { setImmediate as nextTurn, setTimeout as delay } from 'node:timers/promises'
import { deflateRawSync, deflateSync, gunzipSync, gzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { inflatePublicationGzip } from '../../worker/gzip'

/**
 * Stage82 bounded gzip decoder regression (worker/gzip.ts, pako 3.0.2 low-level
 * API). Fixtures are produced by Node's own zlib or crafted byte by byte here;
 * nothing derives an expectation from the decoder under test.
 *
 * Output contract (AGZ82-1/MGT82-1): every yielded block is non-empty and at
 * most 64 KiB, the concatenation equals the original bytes and the total equals
 * expectedBytes. Only when the whole member arrives in ONE input slice is the
 * exact partition (full 64 KiB blocks, then the remainder) also asserted: the
 * decoder yields whatever a slice produced before pulling the next one, so
 * arbitrary slicing legitimately yields shorter intermediate blocks.
 *
 * Demand tests (AGZ82-3/MGT82-3) observe INPUT demand through the iterator the
 * decoder pulls from: entries are labelled with the consumer phase, so a pull
 * while the consumer holds a yielded block would be recorded. They do not claim
 * to observe internal decode instructions; the fixed output buffer is a
 * source-reviewed property and memory is measured by the capacity suite.
 *
 * Every manually driven generator is owned (AGZ82-2/MGT82-2, AGZ82-R4/MGTR82-1):
 * each next/return/throw operation is recorded with its terminal outcome and
 * kept until finalization accounts for it, whether it settles before or during
 * `finish`. Finalization releases any input gate first, joins the operations and
 * the generator return boundedly, and reports every unacknowledged rejection
 * together with the primary failure and any release/return/timeout error. A
 * deliberately expected rejection is acknowledged only after its awaited
 * assertion succeeded (`handle.rejects`). Cancellation is cooperative (a pending
 * next() finishes first); nothing here claims synchronous preemption.
 */
const BLOCK = 64 * 1024
const JOIN_MS = 5_000
const text = (value: string) => new Uint8Array(Buffer.from(value, 'utf8'))
/** Deterministic, moderately compressible bytes (period 251 ramp with a slow drift). */
function pattern(length: number, seed = 1): Uint8Array {
  const bytes = new Uint8Array(length)
  for (let index = 0; index < length; index++) bytes[index] = (index + seed * 7 + Math.floor(index / 251)) % 251
  return bytes
}
const zeros = (length: number) => new Uint8Array(length)
const gz = (data: Uint8Array, level = 6) => new Uint8Array(gzipSync(data, { level }))
/** Cut `bytes` at the given absolute offsets (sorted, within range) into consecutive slices. */
function cut(bytes: Uint8Array, offsets: number[]): Uint8Array[] {
  const points = [0, ...offsets.filter(offset => offset > 0 && offset < bytes.length), bytes.length]
  const slices: Uint8Array[] = []
  for (let index = 1; index < points.length; index++) slices.push(bytes.subarray(points[index - 1], points[index]))
  return slices
}
const everyByte = (bytes: Uint8Array) => Array.from({ length: bytes.length }, (_, index) => bytes.subarray(index, index + 1))
async function* from(chunks: Uint8Array[]): AsyncGenerator<Uint8Array> {
  for (const chunk of chunks) yield chunk
}
/** The exact partition a single-slice member must produce: full 64 KiB blocks, then the remainder. */
function partition(total: number): number[] {
  const blocks = Array.from({ length: Math.floor(total / BLOCK) }, () => BLOCK)
  if (total % BLOCK) blocks.push(total % BLOCK)
  return blocks
}
async function drain(input: AsyncIterable<Uint8Array>, expected: number) {
  const blocks: number[] = []
  const parts: Uint8Array[] = []
  for await (const block of inflatePublicationGzip(input, expected)) {
    expect(block.byteLength).toBeGreaterThan(0)
    expect(block.byteLength).toBeLessThanOrEqual(BLOCK)
    blocks.push(block.byteLength)
    parts.push(block)
  }
  return { output: Buffer.concat(parts), blocks, parts }
}
/** Arbitrary-slice contract: bounded blocks (checked in drain), exact bytes and exact total. */
function expectExactBytes(result: { output: Buffer; blocks: number[] }, data: Uint8Array, label = '') {
  expect(result.blocks.reduce((sum, length) => sum + length, 0), `${label} total`).toBe(data.length)
  expect(Buffer.compare(result.output, Buffer.from(data)), `${label} bytes`).toBe(0)
}
/** Run to the failure and report the message plus how many bytes had been yielded before it. */
async function failure(input: AsyncIterable<Uint8Array>, expected: number): Promise<{ message: string; yielded: number }> {
  let yielded = 0
  try {
    for await (const block of inflatePublicationGzip(input, expected)) yielded += block.byteLength
  } catch (error) {
    return { message: (error as Error).message, yielded }
  }
  throw new Error(`Expected the decoder to fail after ${yielded} bytes`)
}
async function expectFailure(chunks: Uint8Array[], expected: number, message: string, maxYielded = expected) {
  const result = await failure(from(chunks), expected)
  expect(result.message).toBe(message)
  expect(result.yielded).toBeLessThanOrEqual(maxYielded)
  return result
}
/**
 * An input whose pulls and closes are counted; `return()` ends it like the
 * store's SQL slice source would. Each pull also records the consumer phase the
 * test declared at that moment, so demand can be attributed to a phase.
 */
function tracked(chunks: Uint8Array[]) {
  const state = { nextCalls: 0, pulled: 0, returned: 0, phase: 'initial', pulls: [] as { call: number; phase: string; done: boolean }[] }
  let index = 0
  const iterable: AsyncIterable<Uint8Array> = {
    [Symbol.asyncIterator]: () => ({
      async next(): Promise<IteratorResult<Uint8Array>> {
        state.nextCalls++
        const done = index >= chunks.length
        state.pulls.push({ call: state.nextCalls, phase: state.phase, done })
        if (done) return { done: true, value: undefined }
        state.pulled++
        return { done: false, value: chunks[index++] }
      },
      async return(value?: unknown): Promise<IteratorResult<Uint8Array>> {
        state.returned++
        index = chunks.length
        return { done: true, value: value as undefined }
      },
    }),
  }
  const counters = () => ({ nextCalls: state.nextCalls, pulled: state.pulled, returned: state.returned })
  return { iterable, state, counters }
}
/**
 * Ownership of a manually driven generator (AGZ82-2, AGZ82-R4): every operation
 * it issues is recorded with its terminal outcome and kept until `finish`
 * accounts for it; settlement alone never erases the record. `finish` runs the
 * caller's release hook first, joins the recorded operations and the generator
 * return boundedly, and returns every failure (release, timeout, return
 * rejection, unacknowledged operation rejection) instead of throwing it away.
 * `rejects` asserts a deliberately expected rejection and acknowledges it only
 * once that awaited assertion succeeded; a rejection that is itself the body's
 * primary failure is not reported twice.
 */
interface OwnedOperation { label: string; promise: Promise<unknown>; state: 'pending' | 'fulfilled' | 'rejected'; reason: unknown; acknowledged: boolean }
function manual<T>(generator: AsyncGenerator<T>) {
  const operations: OwnedOperation[] = []
  const records = new Map<Promise<unknown>, OwnedOperation>()
  const track = <R>(kind: string, operation: Promise<R>): Promise<R> => {
    const record: OwnedOperation = { label: `${kind} #${operations.length + 1}`, promise: operation, state: 'pending', reason: undefined, acknowledged: false }
    operations.push(record)
    records.set(operation, record)
    // Outcome bookkeeping only; the caller receives the original promise and its rejection unchanged.
    operation.then(() => { record.state = 'fulfilled' }, reason => { record.state = 'rejected'; record.reason = reason })
    return operation
  }
  const joinBounded = async (label: string, work: Promise<unknown>, errors: string[]) => {
    const outcome = await Promise.race([work.then(() => 'settled' as const, () => 'settled' as const), delay(JOIN_MS).then(() => 'timeout' as const)])
    if (outcome === 'timeout') errors.push(`${label} did not settle within ${JOIN_MS} ms`)
  }
  return {
    next: () => track('next()', generator.next()),
    return: () => track('return()', generator.return(undefined)),
    throw: (error: unknown) => track('throw()', generator.throw(error)),
    /** Await an owned operation that must reject; the rejection counts as accounted for only after `assertion` succeeded. */
    async rejects(operation: Promise<unknown>, assertion: (reason: unknown) => void): Promise<void> {
      const record = records.get(operation)
      if (!record) throw new Error('rejects() takes an operation issued through this handle')
      let rejected = false
      let reason: unknown
      try { await operation } catch (error) { rejected = true; reason = error }
      expect(rejected, `${record.label} was expected to reject`).toBe(true)
      assertion(reason)
      record.acknowledged = true
    },
    async finish(options: { release?: () => void; failure?: { error: unknown } | null } = {}): Promise<string[]> {
      const errors: string[] = []
      try { options.release?.() } catch (error) { errors.push(`release: ${String(error)}`) }
      await joinBounded('owned operations', Promise.allSettled(operations.map(operation => operation.promise)), errors)
      await joinBounded('generator.return()', generator.return(undefined).catch(error => { errors.push(`generator.return() rejected: ${String(error)}`) }), errors)
      for (const operation of operations) {
        if (operation.state === 'pending') errors.push(`${operation.label} is still pending`)
        else if (operation.state === 'rejected' && !operation.acknowledged && !(options.failure && operation.reason === options.failure.error)) errors.push(`${operation.label} rejected: ${String(operation.reason)}`)
      }
      return errors
    },
  }
}
/** Run `body` against an owned generator; the primary failure and every cleanup failure are preserved together. */
async function withManual<T>(generator: AsyncGenerator<T>, body: (handle: ReturnType<typeof manual<T>>) => Promise<void>, release?: () => void): Promise<void> {
  const handle = manual(generator)
  let failure: { error: unknown } | null = null
  try {
    await body(handle)
  } catch (error) {
    failure = { error }
  }
  const cleanup = await handle.finish({ release, failure })
  if (failure && cleanup.length) throw new AggregateError([failure.error, ...cleanup.map(message => new Error(message))], 'The assertion failed and the owned generator cleanup also failed')
  if (failure) throw failure.error
  expect(cleanup).toEqual([])
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()
function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
const le32 = (value: number) => new Uint8Array([value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff])
const concat = (...parts: Uint8Array[]) => new Uint8Array(Buffer.concat(parts))
/** A gzip member crafted byte by byte (RFC 1952) so every header field can be exercised independently. */
function member(data: Uint8Array, options: { fextra?: Uint8Array; fname?: string; fcomment?: string; fhcrc?: boolean; method?: number; flags?: number; magic?: [number, number] } = {}): Uint8Array {
  const flags = (options.flags ?? 0) | (options.fextra ? 0x04 : 0) | (options.fname ? 0x08 : 0) | (options.fcomment ? 0x10 : 0) | (options.fhcrc ? 0x02 : 0)
  const magic = options.magic ?? [0x1f, 0x8b]
  const fixed = new Uint8Array([magic[0], magic[1], options.method ?? 8, flags, 0, 0, 0, 0, 0, 255])
  const parts: Uint8Array[] = [fixed]
  if (options.fextra) parts.push(new Uint8Array([options.fextra.length & 0xff, options.fextra.length >>> 8]), options.fextra)
  if (options.fname) parts.push(text(options.fname), new Uint8Array([0]))
  if (options.fcomment) parts.push(text(options.fcomment), new Uint8Array([0]))
  let header = concat(...parts)
  if (options.fhcrc) header = concat(header, new Uint8Array([crc32(header) & 0xff, (crc32(header) >>> 8) & 0xff]))
  return concat(header, new Uint8Array(deflateRawSync(data)), le32(crc32(data)), le32(data.length >>> 0))
}
const patched = (bytes: Uint8Array, offset: number, value: number) => { const copy = new Uint8Array(bytes); copy[offset] = value; return copy }

describe('inflatePublicationGzip round trips', () => {
  it('decodes an empty member to zero bytes and completes without yielding', async () => {
    const { output, blocks } = await drain(from([gz(zeros(0))]), 0)
    expect(output.length).toBe(0)
    expect(blocks).toEqual([])
  })

  it('reproduces UTF-8 text whose 64 KiB block boundary falls inside a multibyte character (single slice: exact partition)', async () => {
    const source = `${'a'.repeat(BLOCK - 1)}한글 경계 ${'b'.repeat(2000)}`
    const data = text(source)
    expect(data[BLOCK] & 0xc0, 'byte 65536 must be a UTF-8 continuation byte').toBe(0x80)
    const result = await drain(from([gz(data)]), data.length)
    expect(result.blocks).toEqual(partition(data.length))
    expectExactBytes(result, data)
    expect(result.output.toString('utf8')).toBe(source)
  })

  it('reproduces incompressible random bytes delivered in uneven slices: bounded blocks, exact bytes and total', async () => {
    const data = new Uint8Array(randomBytes(300_000))
    const compressed = gz(data, 9)
    expect(compressed.length).toBeGreaterThan(data.length * 0.99)
    const slices = cut(compressed, [1, 11, 5000, 65536, 131072, 131073, 299_990])
    expect(slices.length).toBe(8)
    const sliced = await drain(from(slices), data.length)
    expectExactBytes(sliced, data, 'sliced')
    expect(sliced.blocks.length).toBeGreaterThanOrEqual(partition(data.length).length)
    // The same member in one slice yields the exact partition.
    const whole = await drain(from([compressed]), data.length)
    expect(whole.blocks).toEqual([BLOCK, BLOCK, BLOCK, BLOCK, 300_000 - 4 * BLOCK])
    expectExactBytes(whole, data, 'whole')
  })

  it('expands a highly compressible 8 MiB member from one small input slice into 128 fixed blocks', async () => {
    const data = zeros(8 * 1024 * 1024)
    const compressed = gz(data, 9)
    expect(compressed.length).toBeLessThan(16 * 1024)
    const input = tracked([compressed])
    const { output, blocks } = await drain(input.iterable, data.length)
    expect(blocks).toEqual(Array.from({ length: 128 }, () => BLOCK))
    expect(output.every(byte => byte === 0)).toBe(true)
    expect(input.counters()).toEqual({ nextCalls: 2, pulled: 1, returned: 0 })
  })

  it('accepts the same member split at every byte, after the header, inside the trailer and with empty slices', async () => {
    const data = text('Hello, bounded gzip decoding. '.repeat(5000))
    const compressed = gz(data)
    for (const [label, slices] of [
      ['every byte', everyByte(compressed)],
      ['after header', cut(compressed, [10])],
      ['inside trailer', cut(compressed, [compressed.length - 8, compressed.length - 4, compressed.length - 1])],
      ['inside header', cut(compressed, [5, 10, 11])],
      ['empty slices', [new Uint8Array(), ...cut(compressed, [20]).flatMap(slice => [slice, new Uint8Array()])]],
    ] as [string, Uint8Array[]][]) {
      expectExactBytes(await drain(from(slices), data.length), data, label)
    }
    expect((await drain(from([compressed]), data.length)).blocks).toEqual(partition(data.length))
  })

  it('yields exact 64 KiB partitions for whole-member input at sizes below, at, above and at multiples of the block, and exact bytes when sliced', async () => {
    for (const size of [1, BLOCK - 1, BLOCK, BLOCK + 1, 2 * BLOCK, 2 * BLOCK + 1, 200_000, 3 * BLOCK]) {
      const data = pattern(size, size)
      const compressed = gz(data)
      const whole = await drain(from([compressed]), size)
      expect(whole.blocks, `size ${size} whole member`).toEqual(partition(size))
      expectExactBytes(whole, data, `size ${size} whole member`)
      expectExactBytes(await drain(from(cut(compressed, [7, 64])), size), data, `size ${size} sliced`)
    }
  })

  it('keeps every yielded block intact: output buffers are never reused by later decoding', async () => {
    const data = pattern(3 * BLOCK + 123, 9)
    const { parts, output } = await drain(from([gz(data)]), data.length)
    expect(parts.length).toBe(4)
    expect(Buffer.compare(Buffer.from(parts[0]), Buffer.from(data.subarray(0, BLOCK)))).toBe(0)
    expect(Buffer.compare(Buffer.from(parts[1]), Buffer.from(data.subarray(BLOCK, 2 * BLOCK)))).toBe(0)
    expect(Buffer.compare(output, Buffer.from(data))).toBe(0)
  })

  it('consumes 100 KiB of zero-output optional header fields across slices without yielding or stalling', async () => {
    const data = pattern(70_000, 3)
    const crafted = member(data, { fextra: pattern(2000, 5), fname: 'fixture-name.json', fcomment: 'c'.repeat(100_000), fhcrc: true })
    expect(Buffer.compare(gunzipSync(crafted), Buffer.from(data)), 'Node zlib accepts the crafted member').toBe(0)
    const input = tracked(cut(crafted, [30_000, 60_000, 90_000, crafted.length - 20]))
    const result = await drain(input.iterable, data.length)
    expectExactBytes(result, data)
    expect(input.state.pulled).toBe(5)
    expect(input.state.returned).toBe(0)
  })

  it('decodes a crafted member with FNAME/FCOMMENT/FEXTRA and a correct header CRC, which Node zlib also accepts', async () => {
    const data = text('header fields fixture')
    const crafted = member(data, { fextra: new Uint8Array([1, 2, 3]), fname: 'n', fcomment: 'comment', fhcrc: true })
    expect(Buffer.compare(gunzipSync(crafted), Buffer.from(data)), 'Node zlib accepts the crafted member').toBe(0)
    expectExactBytes(await drain(from(everyByte(crafted)), data.length), data)
  })
})

describe('inflatePublicationGzip framing and integrity failures', () => {
  const data = pattern(70_000, 11)
  const compressed = gz(data)

  it('rejects wrong magic, an unknown method, reserved flags, zlib wrapping and raw deflate as invalid gzip', async () => {
    await expectFailure([patched(compressed, 0, 0x1e)], data.length, 'Invalid gzip fragment', 0)
    await expectFailure([patched(compressed, 1, 0x8c)], data.length, 'Invalid gzip fragment', 0)
    await expectFailure([member(data, { method: 7 })], data.length, 'Invalid gzip fragment', 0)
    await expectFailure([member(data, { flags: 0xe0 })], data.length, 'Invalid gzip fragment', 0)
    await expectFailure([new Uint8Array(deflateSync(data))], data.length, 'Invalid gzip fragment', 0)
    await expectFailure([new Uint8Array(deflateRawSync(data))], data.length, 'Invalid gzip fragment', 0)
  })

  it('rejects a wrong optional header CRC before any output', async () => {
    const good = member(data, { fname: 'fixture', fhcrc: true })
    const headerEnd = 10 + 'fixture'.length + 1
    const bad = patched(good, headerEnd, good[headerEnd] ^ 0xff)
    await expectFailure(cut(bad, [headerEnd + 1]), data.length, 'Invalid gzip fragment', 0)
    expectExactBytes(await drain(from([good]), data.length), data)
  })

  it('rejects a corrupted CRC32 and a wrong ISIZE after the body, in one slice and with the trailer split', async () => {
    const crcOffset = compressed.length - 8
    const isizeOffset = compressed.length - 4
    for (const offsets of [[], [crcOffset + 2], [compressed.length - 1]]) {
      await expectFailure(cut(patched(compressed, crcOffset, compressed[crcOffset] ^ 0x01), offsets), data.length, 'Invalid gzip fragment')
      await expectFailure(cut(patched(compressed, isizeOffset, compressed[isizeOffset] ^ 0x01), offsets), data.length, 'Invalid gzip fragment')
    }
  })

  it('reports truncation at the header, inside the body, before and inside the trailer, and for empty input', async () => {
    for (const keep of [0, 5, 10, 11, 300, compressed.length - 8, compressed.length - 7, compressed.length - 1]) {
      const result = await failure(from(cut(compressed.subarray(0, keep), [4])), data.length)
      expect(result.message, `keep ${keep}`).toBe('Incomplete gzip fragment')
      expect(result.yielded, `keep ${keep}`).toBeLessThanOrEqual(data.length)
    }
    await expectFailure([], data.length, 'Incomplete gzip fragment', 0)
    await expectFailure([new Uint8Array(), new Uint8Array()], data.length, 'Incomplete gzip fragment', 0)
  })

  it('rejects trailing bytes and concatenated members inside one slice and across slices', async () => {
    const second = gz(text('second member'))
    const withZero = concat(compressed, new Uint8Array([0]))
    const twoMembers = concat(compressed, second)
    await expectFailure([withZero], data.length, 'Trailing bytes after gzip fragment')
    await expectFailure([compressed, new Uint8Array([0])], data.length, 'Trailing bytes after gzip fragment')
    await expectFailure([twoMembers], data.length, 'Trailing bytes after gzip fragment')
    await expectFailure([compressed, second], data.length, 'Trailing bytes after gzip fragment')
    await expectFailure(cut(twoMembers, [compressed.length - 1]), data.length, 'Trailing bytes after gzip fragment')
    await expectFailure(cut(twoMembers, [compressed.length + 1]), data.length, 'Trailing bytes after gzip fragment')
    await expectFailure([compressed, new Uint8Array(), second], data.length, 'Trailing bytes after gzip fragment')
  })

  it('fails before yielding an overrunning block when the member decodes to more than expectedBytes', async () => {
    const atBlock = await expectFailure([compressed], BLOCK, 'Decoded fragment exceeds its size')
    expect(atBlock.yielded).toBe(BLOCK)
    const small = await expectFailure([gz(pattern(100, 2))], 99, 'Decoded fragment exceeds its size')
    expect(small.yielded).toBe(0)
    const none = await expectFailure([compressed], 0, 'Decoded fragment exceeds its size')
    expect(none.yielded).toBe(0)
    const belowFirstBlock = await expectFailure([compressed], BLOCK - 1, 'Decoded fragment exceeds its size')
    expect(belowFirstBlock.yielded).toBe(0)
  })

  it('fails at the end when the member decodes to fewer bytes than expectedBytes, after yielding everything', async () => {
    const result = await expectFailure([compressed], data.length + 1, 'Incomplete gzip fragment', data.length)
    expect(result.yielded).toBe(data.length)
    const empty = await expectFailure([gz(zeros(0))], 1, 'Incomplete gzip fragment', 0)
    expect(empty.yielded).toBe(0)
  })

  it('rejects negative, fractional, non-finite and unsafe expected sizes before pulling any input', async () => {
    for (const expected of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 2 ** 53]) {
      const input = tracked([compressed])
      await withManual(inflatePublicationGzip(input.iterable, expected), async handle => {
        // The expected rejection is acknowledged only after this assertion succeeds (AGZ82-R4).
        await handle.rejects(handle.next(), reason => {
          expect(reason).toBeInstanceOf(Error)
          expect((reason as Error).message).toBe('Invalid decoded size')
        })
        expect(input.state.nextCalls, `expected ${expected}`).toBe(0)
      })
    }
  })

  it('propagates an input iterator failure unchanged and ends the decoder', async () => {
    const boom = new Error('synthetic SQL slice failure')
    async function* failing(afterChunks: number): AsyncGenerator<Uint8Array> {
      const slices = cut(compressed, [50, 100])
      for (const [index, slice] of slices.entries()) {
        if (index === afterChunks) throw boom
        yield slice
      }
    }
    for (const after of [0, 1, 2]) {
      const generator = inflatePublicationGzip(failing(after), data.length)
      let caught: unknown
      try {
        for await (const block of generator) expect(block.byteLength).toBeLessThanOrEqual(BLOCK)
      } catch (error) {
        caught = error
      }
      expect(caught, `after ${after}`).toBe(boom)
      expect(await generator.next()).toEqual({ done: true, value: undefined })
    }
  })

  it('closes the input iterator exactly once when the decoder itself detects corruption with input remaining', async () => {
    const bad = patched(compressed, compressed.length - 8, compressed[compressed.length - 8] ^ 0x01)
    const input = tracked([...cut(bad, [100, 200]), text('never consumed')])
    const result = await failure(input.iterable, data.length)
    expect(result.message).toBe('Invalid gzip fragment')
    expect(input.state.pulled).toBe(3)
    expect(input.state.returned).toBe(1)
  })
})

describe('inflatePublicationGzip demand and cancellation', () => {
  const data = zeros(8 * 1024 * 1024)
  const compressed = gz(data, 9)

  it('pulls input only on consumer demand: no input pull is recorded while the consumer holds a yielded block', async () => {
    // The first 1000 compressed bytes of an all-zero member expand to far more than one 64 KiB block.
    const input = tracked(cut(compressed, [1000]))
    await withManual(inflatePublicationGzip(input.iterable, data.length), async handle => {
      input.state.phase = 'first-demand'
      const first = await handle.next()
      expect(first.done).toBe(false)
      expect(first.value!.byteLength).toBe(BLOCK)
      expect(input.state.pulls).toEqual([{ call: 1, phase: 'first-demand', done: false }])
      // Consumer paused: one bounded scheduling turn lets any already queued work run; a pull in this phase would be recorded.
      input.state.phase = 'consumer-paused'
      await nextTurn()
      await delay(0)
      expect(input.state.pulls.filter(pull => pull.phase === 'consumer-paused')).toEqual([])
      expect(input.counters()).toEqual({ nextCalls: 1, pulled: 1, returned: 0 })
      // Released: the remaining demand pulls the second slice and then observes the end of input.
      input.state.phase = 'released'
      let rest = 0
      for (let item = await handle.next(); !item.done; item = await handle.next()) {
        expect(item.value.byteLength).toBeGreaterThan(0)
        expect(item.value.byteLength).toBeLessThanOrEqual(BLOCK)
        expect(item.value.every(byte => byte === 0)).toBe(true)
        rest += item.value.byteLength
      }
      expect(rest).toBe(data.length - BLOCK)
      expect(input.state.pulls.slice(1)).toEqual([{ call: 2, phase: 'released', done: false }, { call: 3, phase: 'released', done: true }])
      expect(input.counters()).toEqual({ nextCalls: 3, pulled: 2, returned: 0 })
    })
  })

  it('return() while suspended closes the input iterator exactly once and ends the generator', async () => {
    const input = tracked(cut(compressed, [1000, 2000]))
    await withManual(inflatePublicationGzip(input.iterable, data.length), async handle => {
      await handle.next()
      expect(input.counters()).toEqual({ nextCalls: 1, pulled: 1, returned: 0 })
      expect(await handle.return()).toEqual({ done: true, value: undefined })
      expect(input.counters()).toEqual({ nextCalls: 1, pulled: 1, returned: 1 })
      expect(await handle.next()).toEqual({ done: true, value: undefined })
      expect(input.counters()).toEqual({ nextCalls: 1, pulled: 1, returned: 1 })
    })
  })

  it('return() before the first pull never touches the input', async () => {
    const input = tracked([compressed])
    await withManual(inflatePublicationGzip(input.iterable, data.length), async handle => {
      expect(await handle.return()).toEqual({ done: true, value: undefined })
      expect(input.counters()).toEqual({ nextCalls: 0, pulled: 0, returned: 0 })
      expect(await handle.next()).toEqual({ done: true, value: undefined })
    })
  })

  it('throw() while suspended rejects with the consumer error and closes the input once', async () => {
    const input = tracked(cut(compressed, [1000]))
    await withManual(inflatePublicationGzip(input.iterable, data.length), async handle => {
      await handle.next()
      const consumerError = new Error('consumer cancelled the body')
      await handle.rejects(handle.throw(consumerError), reason => expect(reason).toBe(consumerError))
      expect(input.counters()).toEqual({ nextCalls: 1, pulled: 1, returned: 1 })
      expect(await handle.next()).toEqual({ done: true, value: undefined })
    })
  })

  it('a concurrent next() during an in-flight pull completes before return() takes effect (cooperative cancellation), with the gate released in every outcome', async () => {
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const state = { pulled: 0, returned: 0, entered: 0 }
    const slow: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]: () => ({
        async next(): Promise<IteratorResult<Uint8Array>> {
          state.entered++
          if (state.pulled) return { done: true, value: undefined }
          state.pulled++
          await gate
          return { done: false, value: compressed }
        },
        async return(): Promise<IteratorResult<Uint8Array>> { state.returned++; return { done: true, value: undefined } },
      }),
    }
    // The release hook runs first in finalization, so a failing assertion can never leave the pending pull gated.
    await withManual(inflatePublicationGzip(slow, data.length), async handle => {
      const pending = handle.next()
      const cancelled = handle.return()
      expect(state).toEqual({ pulled: 1, returned: 0, entered: 1 })
      release()
      const first = await pending
      expect(first.done).toBe(false)
      expect(first.value!.byteLength).toBe(BLOCK)
      expect(await cancelled).toEqual({ done: true, value: undefined })
      expect(state).toEqual({ pulled: 1, returned: 1, entered: 1 })
    }, release)
  })

  it('finalization keeps an unexpected owned rejection next to a distinct primary failure, whether it settles before or during finish, and acknowledges only asserted rejections', async () => {
    const secondary = new Error('synthetic owned-operation rejection')
    const primary = new Error('deliberate primary assertion failure')
    /** An input whose first pull rejects with `secondary`, either at once or only after the gate opens. */
    const failingInput = (gate: Promise<void> | null): AsyncIterable<Uint8Array> => ({
      [Symbol.asyncIterator]: () => ({
        async next(): Promise<IteratorResult<Uint8Array>> {
          if (gate) await gate
          throw secondary
        },
        async return(): Promise<IteratorResult<Uint8Array>> { return { done: true, value: undefined } },
      }),
    })
    const outcomeOf = (run: Promise<void>) => run.then(() => null, error => error as unknown)
    const rejectionLine = 'Error: next() #1 rejected: Error: synthetic owned-operation rejection'
    // 1. Settles during finalization: the pull is gated, the body fails first, finish releases the gate and the owned pull then rejects.
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const during = await outcomeOf(withManual(inflatePublicationGzip(failingInput(gate), 1), async handle => {
      void handle.next()
      throw primary
    }, release))
    expect(during).toBeInstanceOf(AggregateError)
    expect((during as AggregateError).errors[0]).toBe(primary)
    expect((during as AggregateError).errors.slice(1).map(String)).toEqual([rejectionLine])
    // 2. Settles before finalization: the pull has already rejected (unacknowledged) when the body fails on the distinct primary.
    const before = await outcomeOf(withManual(inflatePublicationGzip(failingInput(null), 1), async handle => {
      await handle.next().catch(() => undefined)
      throw primary
    }))
    expect(before).toBeInstanceOf(AggregateError)
    expect((before as AggregateError).errors[0]).toBe(primary)
    expect((before as AggregateError).errors.slice(1).map(String)).toEqual([rejectionLine])
    // 3. The rejection that is itself the primary failure is reported once, not duplicated as cleanup.
    expect(await outcomeOf(withManual(inflatePublicationGzip(failingInput(null), 1), async handle => { await handle.next() }))).toBe(secondary)
    // 4. A deliberately expected rejection, asserted through the handle, leaves no cleanup failure behind.
    await withManual(inflatePublicationGzip(failingInput(null), 1), async handle => {
      await handle.rejects(handle.next(), reason => expect(reason).toBe(secondary))
    })
    // 5. A failed acknowledgement keeps the rejection as evidence next to the assertion failure.
    const unacknowledged = await outcomeOf(withManual(inflatePublicationGzip(failingInput(null), 1), async handle => {
      await handle.rejects(handle.next(), reason => expect(reason).toBe(primary))
    }))
    expect(unacknowledged).toBeInstanceOf(AggregateError)
    expect((unacknowledged as AggregateError).errors).toHaveLength(2)
    expect(String((unacknowledged as AggregateError).errors[1])).toBe(rejectionLine)
  })
})
