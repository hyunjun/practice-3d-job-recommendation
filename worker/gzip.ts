import { Z_BUF_ERROR, Z_NO_FLUSH, Z_OK, Z_STREAM_END, ZStream, zlibInflate, zlibInflateEnd, zlibInflateInit2 } from 'pako'

const OUTPUT_BYTES = 64 * 1024
const empty = new Uint8Array()

/**
 * Decode one gzip member only when the caller asks for another output block.
 * A native DecompressionStream may accept writes without readable backpressure.
 * The low-level decoder instead stops at the fixed output buffer's boundary.
 */
export async function* inflatePublicationGzip(
  input: AsyncIterable<Uint8Array>,
  expectedBytes: number,
): AsyncGenerator<Uint8Array<ArrayBuffer>> {
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes < 0) throw new Error('Invalid decoded size')
  const stream = new ZStream()
  // 15-bit window + gzip wrapper: validate header, CRC32 and uncompressed size.
  if (zlibInflateInit2(stream, 31) !== Z_OK) throw new Error('Cannot initialize gzip decoder')
  let ended = false
  let decoded = 0
  try {
    for await (const chunk of input) {
      if (!chunk.byteLength) continue
      if (ended) throw new Error('Trailing bytes after gzip fragment')
      stream.input = chunk
      stream.next_in = 0
      stream.avail_in = chunk.byteLength
      while (true) {
        const output = new Uint8Array(OUTPUT_BYTES)
        stream.output = output
        stream.next_out = 0
        stream.avail_out = output.byteLength
        const before = stream.avail_in
        const status = zlibInflate(stream, Z_NO_FLUSH)
        if (status !== Z_OK && status !== Z_STREAM_END && status !== Z_BUF_ERROR) {
          throw new Error('Invalid gzip fragment')
        }
        const written = stream.next_out
        decoded += written
        if (decoded > expectedBytes) throw new Error('Decoded fragment exceeds its size')
        if (status === Z_STREAM_END) {
          ended = true
          if (stream.avail_in !== 0) throw new Error('Trailing bytes after gzip fragment')
        } else if (before === stream.avail_in && written === 0) {
          if (stream.avail_in !== 0) throw new Error('Gzip decoder made no progress')
          break
        }
        if (written) yield written === output.byteLength ? output : output.subarray(0, written)
        stream.output = empty
        if (ended || (stream.avail_in === 0 && written < output.byteLength)) break
      }
      // Release the current SQL blob before requesting another input chunk.
      stream.input = empty
    }
    if (!ended || decoded !== expectedBytes) throw new Error('Incomplete gzip fragment')
  } finally {
    zlibInflateEnd(stream)
    stream.input = empty
    stream.output = empty
  }
}
