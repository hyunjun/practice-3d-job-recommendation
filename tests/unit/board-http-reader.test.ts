import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { ServerResponse } from 'node:http'
import { createGzip } from 'node:zlib'
import { BoardFetchError, BoardInventoryError } from '../../server/catalog-service'
import { BoardResponseError, MAX_BOARD_JSON_BYTES, MAX_BOARD_TEXT_BYTES, fetchBoardJson, fetchBoardText } from '../../server/providers/http'
import {
  HTML_CAP_BYTES, HTML_NO_BODY_MESSAGE, HTML_REDIRECT_MESSAGE, HTML_SIZE_MESSAGE, JSON_CANCELLED_MESSAGE, JSON_CAP_BYTES,
  JSON_FORMAT_MESSAGE, JSON_INTERRUPTED_MESSAGE, JSON_SIZE_MESSAGE, JSON_TIMEOUT_MESSAGE, paddedHtml, paddedJsonObject,
} from '../fixtures/response-bounds'
import {
  DEFAULT_CHUNK_BYTES, PAD_BYTE, chunkStream, directiveBytes, directiveChunks, directiveResponse, padChunk, pendingStream, splitAt, streamDirective,
} from '../fixtures/response-bounds-stream'
import type { StreamDirective, StreamHooks } from '../fixtures/response-bounds-stream'
import { startRawUpstream, startUpstream, waitFor } from '../fixtures/upstream-server'
import type { Upstream, UpstreamHandler } from '../fixtures/upstream-server'

// The subjects are the production entry points at their production caps. Heavy
// cases move 64 MiB through one socket or one in-memory stream; they run
// serially in this file and reuse a shared padding chunk.
const BASE = Date.parse('2026-09-30T09:00:00.000Z')
const HEAVY = 120_000
const readers = [['fetchBoardJson', fetchBoardJson], ['fetchBoardText', fetchBoardText]] as const
const JSON_HEADERS = { 'Content-Type': 'application/json' }
const never = () => new Promise<never>(() => undefined)
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

const unhandled: unknown[] = []
const noteUnhandled = (reason: unknown) => { unhandled.push(reason) }
beforeAll(() => { process.on('unhandledRejection', noteUnhandled) })
afterAll(() => { process.off('unhandledRejection', noteUnhandled) })
const upstreams: Upstream[] = []
const rawUpstreams: { close: () => Promise<void> }[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  await Promise.all(upstreams.splice(0).map(server => server.close(100)))
  await Promise.all(rawUpstreams.splice(0).map(server => server.close()))
  await new Promise(resolve => setImmediate(resolve))
  expect(unhandled.splice(0)).toEqual([])
})

async function upstream(handler: UpstreamHandler) {
  const server = await startUpstream(handler)
  upstreams.push(server)
  return server
}
async function caught(promise: Promise<unknown>): Promise<Error> {
  try { await promise } catch (error) { return error as Error }
  throw new Error('Expected the reader to reject')
}
const json = (response: ServerResponse) => { response.setHeader('Content-Type', 'application/json') }
const html = (response: ServerResponse) => { response.setHeader('Content-Type', 'text/html; charset=utf-8') }
async function writeAll(write: (chunk: Uint8Array | string) => Promise<void>, directive: StreamDirective) {
  for (const chunk of directiveChunks(directive)) await write(chunk)
}
async function gzipDirective(directive: StreamDirective): Promise<Buffer> {
  const gzip = createGzip()
  const parts: Buffer[] = []
  gzip.on('data', (part: Buffer) => parts.push(part))
  const ended = new Promise<void>((resolve, reject) => { gzip.once('end', resolve); gzip.once('error', reject) })
  for (const chunk of directiveChunks(directive)) {
    if (!gzip.write(chunk)) await new Promise(resolve => gzip.once('drain', resolve))
  }
  gzip.end()
  await ended
  return Buffer.concat(parts)
}
function gate() {
  let release!: () => void
  const promise = new Promise<void>(resolve => { release = resolve })
  return { promise, release }
}
const nativeFetch = globalThis.fetch
/**
 * Observe when native fetch hands a real Response to the reader. The transport,
 * Response, body stream and reader stay native; only the hand-over is recorded,
 * so a fixture can reset or abort strictly after the header phase and the
 * unchanged pre-header failure path is never mistaken for a body failure.
 */
function watchNativeFetch() {
  const responses: Response[] = []
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = await nativeFetch(input, init)
    responses.push(response)
    return response
  })
  return {
    responses,
    arrived: (count: number) => waitFor(() => responses.length >= count, 5000, `native fetch to hand over response ${count}`),
  }
}

describe('approved caps', () => {
  it('exports the literal contract limits', () => {
    expect(MAX_BOARD_JSON_BYTES).toBe(67_108_864)
    expect(MAX_BOARD_TEXT_BYTES).toBe(8_388_608)
    expect(JSON_CAP_BYTES).toBe(67_108_864)
    expect(HTML_CAP_BYTES).toBe(8_388_608)
  })
})

describe('native loopback transport through the production readers', () => {
  it('reads a JSON body of exactly the cap completely and rejects one more declared byte with the size message', async () => {
    const exact = paddedJsonObject({ jobs: [], meta: { total: 0 } }, JSON_CAP_BYTES)
    const over = paddedJsonObject({ jobs: [], meta: { total: 0 } }, JSON_CAP_BYTES + 1)
    const server = await upstream(async ({ request, response, write }) => {
      const directive = request.url === '/exact' ? exact : over
      json(response)
      response.setHeader('Content-Length', String(directiveBytes(directive)))
      await writeAll(write, directive)
      response.end()
    })
    const parsed = await fetchBoardJson(`${server.origin}/exact`, AbortSignal.timeout(60_000)) as { jobs: unknown[]; meta: { total: number }; pad: string }
    expect(parsed.jobs).toEqual([])
    expect(parsed.meta).toEqual({ total: 0 })
    expect(parsed.pad).toHaveLength(exact.padBytes)
    await waitFor(() => server.records[0].finished, 2000, 'the exact-cap response to finish')
    expect(server.records[0]).toMatchObject({ path: '/exact', bytesWritten: JSON_CAP_BYTES })
    const error = await caught(fetchBoardJson(`${server.origin}/over`, AbortSignal.timeout(60_000)))
    expect(error).toBeInstanceOf(BoardFetchError)
    expect(error).not.toBeInstanceOf(BoardResponseError)
    expect(error.message).toBe(JSON_SIZE_MESSAGE)
    // A finite declared body can be fully sent before the client observes the
    // excess byte, so neither server completion nor connection release is a
    // contract guarantee here. The endless and error-body cases below prove
    // early cancellation where content is still outstanding.
  }, HEAVY)

  it('rejects an over-cap chunked body without a declared length, and stops an endless body at the cap rather than the deadline', async () => {
    const chunked = paddedJsonObject({ jobs: [] }, JSON_CAP_BYTES + 1)
    const hardStop = JSON_CAP_BYTES + 8 * DEFAULT_CHUNK_BYTES
    const server = await upstream(async ({ request, response, write, record }) => {
      json(response)
      if (request.url === '/chunked') {
        await writeAll(write, chunked)
        response.end()
        return
      }
      // Endless body: never ends. A hard stop keeps memory bounded if the
      // client never cancels; the caller deadline would then end the test.
      await write('{"jobs":[],"pad":"')
      while (record.bytesWritten < hardStop) await write(padChunk())
      await never()
    })
    const first = await caught(fetchBoardJson(`${server.origin}/chunked`, AbortSignal.timeout(60_000)))
    expect(first).toBeInstanceOf(BoardFetchError)
    expect(first.message).toBe(JSON_SIZE_MESSAGE)
    const startedAt = performance.now()
    const second = await caught(fetchBoardJson(`${server.origin}/endless`, AbortSignal.timeout(30_000)))
    expect(second.message).toBe(JSON_SIZE_MESSAGE)
    expect(performance.now() - startedAt).toBeLessThan(20_000)
    const endless = server.records.find(record => record.path === '/endless')!
    await waitFor(() => endless.closedAt !== null, 2000, 'the endless connection to close')
    expect(endless.finished).toBe(false)
    expect(endless.bytesWritten).toBeLessThanOrEqual(hardStop + DEFAULT_CHUNK_BYTES)
    expect(await server.close(2000)).toBe('closed')
  }, HEAVY)

  it('counts gzip-decoded bytes: exactly the cap parses and one more decoded byte fails despite a tiny wire length', async () => {
    const exact = paddedJsonObject({ jobs: [] }, JSON_CAP_BYTES)
    const over = paddedJsonObject({ jobs: [] }, JSON_CAP_BYTES + 1)
    const [exactWire, overWire] = await Promise.all([gzipDirective(exact), gzipDirective(over)])
    expect(exactWire.length).toBeLessThan(DEFAULT_CHUNK_BYTES)
    expect(overWire.length).toBeLessThan(DEFAULT_CHUNK_BYTES)
    const server = await upstream(({ request, response }) => {
      const wire = request.url === '/exact' ? exactWire : overWire
      json(response)
      response.setHeader('Content-Encoding', 'gzip')
      response.setHeader('Content-Length', String(wire.length))
      response.end(wire)
    })
    const parsed = await fetchBoardJson(`${server.origin}/exact`, AbortSignal.timeout(60_000)) as { jobs: unknown[]; pad: string }
    expect(parsed.jobs).toEqual([])
    expect(parsed.pad).toHaveLength(exact.padBytes)
    // The production request advertises gzip itself; the fixture does not force it.
    expect(server.records[0].acceptEncoding).toMatch(/\bgzip\b/)
    const error = await caught(fetchBoardJson(`${server.origin}/over`, AbortSignal.timeout(60_000)))
    expect(error).toBeInstanceOf(BoardFetchError)
    expect(error.message).toBe(JSON_SIZE_MESSAGE)
  }, HEAVY)

  it('never rejects JSON from an inflated declared length; an unfinished small body ends at the caller deadline', async () => {
    const watch = watchNativeFetch()
    const server = await upstream(async ({ response, write }) => {
      json(response)
      response.setHeader('Content-Length', String(JSON_CAP_BYTES + 1))
      await write('{"jobs":[]}')
      await never()
    })
    const error = await caught(fetchBoardJson(`${server.origin}/inflated`, AbortSignal.timeout(700)))
    expect(error).toBeInstanceOf(BoardFetchError)
    expect(error.message).toBe(JSON_TIMEOUT_MESSAGE)
    // The Response had reached the reader, so the deadline ended the body phase, not the header phase.
    expect(watch.responses).toHaveLength(1)
    await waitFor(() => server.records[0].closedAt !== null, 2000, 'the abandoned connection to close')
  }, 10_000)

  it('leaves a failure before headers on the unchanged native fetch path, distinct from body-phase errors', async () => {
    const watch = watchNativeFetch()
    const server = await upstream(({ request }) => { request.socket.destroy() })
    const error = await caught(fetchBoardJson(`${server.origin}/no-headers`, AbortSignal.timeout(5000)))
    expect(error).not.toBeInstanceOf(BoardFetchError)
    expect(error).toBeInstanceOf(TypeError)
    expect(watch.responses).toHaveLength(0)
  }, 10_000)

  it('reports a connection dropped after the Response reached the reader as an interrupted read, not a format error', async () => {
    const watch = watchNativeFetch()
    const handoff = gate()
    const server = await upstream(async ({ response, write }) => {
      json(response)
      await write('{"jobs":[')
      await handoff.promise
      response.destroy()
    })
    const pending = caught(fetchBoardJson(`${server.origin}/dropped`, AbortSignal.timeout(5000)))
    await watch.arrived(1)
    handoff.release()
    const error = await pending
    expect(error).toBeInstanceOf(BoardFetchError)
    expect(error.message).toBe(JSON_INTERRUPTED_MESSAGE)
  }, 10_000)

  it('copies an application abort reason into a fresh error without another request\'s inventory phase', async () => {
    const watch = watchNativeFetch()
    const server = await upstream(async ({ response, write }) => {
      json(response)
      await write('{"jobs":[')
      await never()
    })
    const controller = new AbortController()
    const pending = caught(fetchBoardJson(`${server.origin}/abort`, controller.signal))
    await watch.arrived(1)
    const reason = new BoardInventoryError(new BoardFetchError('게시판의 전체 공고를 확인하는 시간이 초과됐어요.', BASE + 600_000))
    controller.abort(reason)
    const error = await pending
    expect(error).toBeInstanceOf(BoardFetchError)
    expect(error).not.toBeInstanceOf(BoardInventoryError)
    expect(error).not.toBe(reason)
    expect(error.message).toBe('게시판의 전체 공고를 확인하는 시간이 초과됐어요.')
    expect((error as BoardFetchError).retryAfter).toBe(BASE + 600_000)
    await waitFor(() => server.records[0].closedAt !== null, 2000, 'the aborted connection to close')
  }, 10_000)

  it('applies the caller deadline across arriving chunks and maps it to the timeout message', async () => {
    const watch = watchNativeFetch()
    const server = await upstream(async ({ response, write }) => {
      json(response)
      await write('{"jobs":[')
      while (true) {
        await delay(50)
        await write('{},')
      }
    })
    const startedAt = performance.now()
    const error = await caught(fetchBoardJson(`${server.origin}/slow`, AbortSignal.timeout(600)))
    expect(error).toBeInstanceOf(BoardFetchError)
    expect(error.message).toBe(JSON_TIMEOUT_MESSAGE)
    expect(performance.now() - startedAt).toBeLessThan(5000)
    expect(watch.responses).toHaveLength(1)
    await waitFor(() => server.records[0].closedAt !== null, 2000, 'the slow connection to close')
    // Several chunks arrived before the deadline, so arrival did not restart it.
    expect(server.records[0].bytesWritten).toBeGreaterThan(Buffer.byteLength('{"jobs":[{},'))
  }, 10_000)

  it('maps a generic abort, with or without a non-error reason, to the cancelled message', async () => {
    const watch = watchNativeFetch()
    const server = await upstream(async ({ response, write }) => {
      json(response)
      await write('{"jobs":[')
      await never()
    })
    const reasons: (string | undefined)[] = [undefined, 'stop']
    for (const [index, reason] of reasons.entries()) {
      const controller = new AbortController()
      const pending = caught(fetchBoardJson(`${server.origin}/cancel-${index}`, controller.signal))
      await watch.arrived(index + 1)
      if (reason === undefined) controller.abort()
      else controller.abort(reason)
      const error = await pending
      expect(error).toBeInstanceOf(BoardFetchError)
      expect(error.message).toBe(JSON_CANCELLED_MESSAGE)
    }
  }, 10_000)

  for (const [name, read] of readers) {
    it.each([
      [429, { 'Retry-After': '120' }, BASE + 120_000],
      [503, { 'Retry-After': new Date(BASE + 300_000).toUTCString() }, BASE + 300_000],
      [500, {}, undefined],
    ] as const)(`${name}: HTTP %s from a real header keeps status and Retry-After and releases an endless error body`, async (status, headers, retryAfter) => {
      vi.spyOn(Date, 'now').mockReturnValue(BASE)
      const server = await upstream(async ({ response, write }) => {
        response.writeHead(status, { 'Content-Type': 'application/json', ...headers })
        await write('{"error":"synthetic"')
        await never()
      })
      const error = await caught(read(`${server.origin}/status`, AbortSignal.timeout(5000)))
      expect(error).toBeInstanceOf(BoardResponseError)
      expect(error.message).toBe(`HTTP ${status}`)
      expect((error as BoardResponseError).status).toBe(status)
      expect((error as BoardResponseError).retryAfter).toBe(retryAfter)
      await waitFor(() => server.records[0].closedAt !== null, 2000, 'the error body connection to close')
      expect(await server.close(2000)).toBe('closed')
    }, 10_000)
  }

  it('cannot receive bytes beyond an understated declared length over a real socket; the framed body parses', async () => {
    const body = '{"jobs":[],"pad":12}'
    expect(Buffer.byteLength(body)).toBe(20)
    const server = await startRawUpstream(socket => {
      socket.write(`HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 20\r\nConnection: close\r\n\r\n${body}`)
      setTimeout(() => {
        socket.write('{"jobs":"bytes beyond the declared length"}')
        socket.end()
      }, 50)
    })
    rawUpstreams.push(server)
    expect(await fetchBoardJson(`${server.origin}/framed`, AbortSignal.timeout(5000))).toEqual({ jobs: [], pad: 12 })
  }, 10_000)

  it('reads HTML of exactly the cap, rejects one more byte, and pre-rejects an over-cap declared length without waiting', async () => {
    const page = '<!doctype html><html><body><p>Synthetic official page 72</p></body></html>'
    const exact = paddedHtml(page, HTML_CAP_BYTES)
    const over = paddedHtml(page, HTML_CAP_BYTES + 1)
    const server = await upstream(async ({ request, response, write }) => {
      html(response)
      if (request.url === '/exact' || request.url === '/over') {
        await writeAll(write, request.url === '/exact' ? exact : over)
        response.end()
        return
      }
      response.setHeader('Content-Length', String(HTML_CAP_BYTES + 1))
      await write('<html>')
      await never()
    })
    const text = await fetchBoardText(`${server.origin}/exact`, AbortSignal.timeout(30_000))
    expect(Buffer.byteLength(text)).toBe(HTML_CAP_BYTES)
    expect(text.startsWith('<!doctype html><html><body><p>Synthetic official page 72</p><!--')).toBe(true)
    expect(text.endsWith('--></body></html>')).toBe(true)
    const overError = await caught(fetchBoardText(`${server.origin}/over`, AbortSignal.timeout(30_000)))
    expect(overError).toBeInstanceOf(BoardFetchError)
    expect(overError.message).toBe(HTML_SIZE_MESSAGE)
    const startedAt = performance.now()
    const declared = await caught(fetchBoardText(`${server.origin}/declared`, AbortSignal.timeout(10_000)))
    expect(declared.message).toBe(HTML_SIZE_MESSAGE)
    expect(performance.now() - startedAt).toBeLessThan(5000)
    const record = server.records.find(item => item.path === '/declared')!
    await waitFor(() => record.closedAt !== null, 2000, 'the declared-length connection to close')
    expect(await server.close(2000)).toBe('closed')
  }, HEAVY)

  it('rejects an HTML redirect to another loopback origin and releases the foreign body, but follows a same-origin redirect', async () => {
    const foreign = await upstream(async ({ response, write }) => {
      html(response)
      await write('<html><body>foreign')
      await never()
    })
    const server = await upstream(({ request, response }) => {
      if (request.url === '/moved-away') {
        response.writeHead(302, { Location: `${foreign.origin}/landing` })
        response.end()
        return
      }
      if (request.url === '/moved-here') {
        response.writeHead(302, { Location: '/final' })
        response.end()
        return
      }
      html(response)
      response.end('<html><body>same origin 72</body></html>')
    })
    const error = await caught(fetchBoardText(`${server.origin}/moved-away`, AbortSignal.timeout(5000)))
    expect(error).toBeInstanceOf(BoardFetchError)
    expect(error.message).toBe(HTML_REDIRECT_MESSAGE)
    await waitFor(() => foreign.records.length === 1 && foreign.records[0].closedAt !== null, 2000, 'the foreign body to close')
    expect(await fetchBoardText(`${server.origin}/moved-here`, AbortSignal.timeout(5000))).toBe('<html><body>same origin 72</body></html>')
  }, 10_000)

  it('keeps native replacement decoding for invalid UTF-8 in JSON while HTML stays strict', async () => {
    const server = await upstream(({ request, response }) => {
      if (request.url === '/json') {
        json(response)
        response.end(Buffer.concat([Buffer.from('{"title":"a'), Buffer.from([0xff]), Buffer.from('b"}')]))
        return
      }
      html(response)
      response.end(Buffer.concat([Buffer.from('<html>'), Buffer.from([0xff]), Buffer.from('</html>')]))
    })
    expect(await fetchBoardJson(`${server.origin}/json`, AbortSignal.timeout(5000))).toEqual({ title: 'a�b' })
    await expect(fetchBoardText(`${server.origin}/html`, AbortSignal.timeout(5000))).rejects.toThrow()
  })
})

describe('constructed Response bodies through the production readers', () => {
  function stubFetch(factory: (init: RequestInit | undefined) => Response) {
    const fetcher = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => factory(init))
    vi.stubGlobal('fetch', fetcher)
    return fetcher
  }
  /** Mirror a real fetch: an aborted request signal errors the body stream with the abort reason. */
  const abortWiring = (init: RequestInit | undefined): StreamHooks['onStart'] => controller => {
    const signal = init?.signal
    if (!signal) return
    const fail = () => controller.error(signal.reason)
    if (signal.aborted) fail()
    else signal.addEventListener('abort', fail, { once: true })
  }

  it('accepts exactly the cap and rejects the first excess byte before decoding or parsing; an open source is cancelled, a closed one has nothing left to cancel', async () => {
    const exact = paddedJsonObject({ jobs: [] }, JSON_CAP_BYTES)
    let response = directiveResponse(exact)
    stubFetch(() => response)
    const parsed = await fetchBoardJson('https://example.com/exact', new AbortController().signal) as { jobs: unknown[]; pad: string }
    expect(parsed.jobs).toEqual([])
    expect(parsed.pad).toHaveLength(exact.padBytes)
    expect(response.body!.locked).toBe(false)
    // Pure padding is not JSON: a format error here would mean the excess was parsed.
    const big = Buffer.alloc(JSON_CAP_BYTES, PAD_BYTE)
    const variants: [string, Uint8Array[]][] = [
      ['the cap then one byte', [big, Buffer.from('x')]],
      ['one short of the cap then two bytes', [big.subarray(0, JSON_CAP_BYTES - 1), Buffer.from('xx')]],
      ['one chunk of the cap plus one', [Buffer.alloc(JSON_CAP_BYTES + 1, PAD_BYTE)]],
    ]
    for (const [label, chunks] of variants) {
      // The source stays open after the excess byte, so unread content exists to
      // cancel and a reader that kept reading would only end at the deadline.
      let cancelled = false
      let pulled = 0
      stubFetch(init => {
        response = new Response(pendingStream(chunks, {
          onStart: abortWiring(init), onPull: bytes => { pulled = bytes }, onCancel: () => { cancelled = true },
        }), { headers: JSON_HEADERS })
        return response
      })
      const error = await caught(fetchBoardJson('https://example.com/over', AbortSignal.timeout(20_000)))
      expect(error, label).toBeInstanceOf(BoardFetchError)
      expect(error.message, label).toBe(JSON_SIZE_MESSAGE)
      expect(pulled, label).toBe(JSON_CAP_BYTES + 1)
      expect(cancelled, label).toBe(true)
      expect(response.body!.locked, label).toBe(false)
    }
    // A finite source that closed on its excess byte leaves nothing to cancel;
    // the size error and the unlocked body still hold.
    response = new Response(chunkStream([big, Buffer.from('x')]), { headers: JSON_HEADERS })
    stubFetch(() => response)
    const closed = await caught(fetchBoardJson('https://example.com/closed', new AbortController().signal))
    expect(closed).toBeInstanceOf(BoardFetchError)
    expect(closed.message).toBe(JSON_SIZE_MESSAGE)
    expect(response.body!.locked).toBe(false)
    // A valid feed over the cap fails on size too, so nothing depends on the excess being unparsable.
    response = directiveResponse(paddedJsonObject({ jobs: [] }, JSON_CAP_BYTES + 1))
    const valid = await caught(fetchBoardJson('https://example.com/valid-over', new AbortController().signal))
    expect(valid.message).toBe(JSON_SIZE_MESSAGE)
  }, HEAVY)

  it('ignores an inflated Content-Length on a small complete JSON body and never trusts an understated one', async () => {
    const small = new Response('{"jobs":[]}', { headers: { ...JSON_HEADERS, 'Content-Length': String(JSON_CAP_BYTES + 1) } })
    stubFetch(() => small)
    expect(await fetchBoardJson('https://example.com/inflated', new AbortController().signal)).toEqual({ jobs: [] })
    const understated = directiveResponse({ ...paddedJsonObject({ jobs: [] }, JSON_CAP_BYTES + 1), headers: { 'Content-Length': '11' } })
    stubFetch(() => understated)
    const error = await caught(fetchBoardJson('https://example.com/understated', new AbortController().signal))
    expect(error.message).toBe(JSON_SIZE_MESSAGE)
  }, HEAVY)

  it('keeps the HTML header pre-rejection and cancels the unread body', async () => {
    let pulled = 0
    let cancelled = false
    const directive = streamDirective('<html>', '</html>', 64, {
      chunkBytes: 8, contentType: 'text/html; charset=utf-8', headers: { 'Content-Length': String(HTML_CAP_BYTES + 1) },
    })
    const response = directiveResponse(directive, { onPull: bytes => { pulled = bytes }, onCancel: () => { cancelled = true } })
    stubFetch(() => response)
    const error = await caught(fetchBoardText('https://example.com/declared', new AbortController().signal))
    expect(error).toBeInstanceOf(BoardFetchError)
    expect(error.message).toBe(HTML_SIZE_MESSAGE)
    expect(cancelled).toBe(true)
    expect(response.bodyUsed).toBe(true)
    expect(pulled).toBeLessThan(64)
    expect(response.body!.locked).toBe(false)
  })

  it('decodes multibyte characters and a BOM split across chunks like native JSON, replacing invalid bytes; HTML stays strict', async () => {
    const text = '{"title":"한글 🌏 café","board":"CedarBounds72"}'
    const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text)])
    const startOf = (part: string) => 3 + Buffer.byteLength(text.slice(0, text.indexOf(part)))
    const jsonChunks = splitAt(bytes, [1, startOf('한') + 1, startOf('글') + 2, startOf('🌏') + 2, startOf('é') + 1])
    expect(jsonChunks).toHaveLength(6)
    stubFetch(() => new Response(chunkStream(jsonChunks), { headers: JSON_HEADERS }))
    expect(await fetchBoardJson('https://example.com/split', new AbortController().signal)).toEqual({ title: '한글 🌏 café', board: 'CedarBounds72' })

    const page = '<html><body>한글 🌏 café</body></html>'
    const pageBytes = Buffer.from(page)
    const pageStart = (part: string) => Buffer.byteLength(page.slice(0, page.indexOf(part)))
    stubFetch(() => new Response(chunkStream(splitAt(pageBytes, [pageStart('한') + 1, pageStart('🌏') + 3, pageStart('é') + 1])), { headers: { 'Content-Type': 'text/html; charset=utf-8' } }))
    expect(await fetchBoardText('https://example.com/split-html', new AbortController().signal)).toBe(page)

    const invalidJson = Buffer.concat([Buffer.from('{"title":"a'), Buffer.from([0xff]), Buffer.from('b"}')])
    stubFetch(() => new Response(chunkStream([invalidJson.subarray(0, 11), invalidJson.subarray(11)]), { headers: JSON_HEADERS }))
    expect(await fetchBoardJson('https://example.com/invalid-json', new AbortController().signal)).toEqual({ title: 'a�b' })
    const invalidHtml = Buffer.concat([Buffer.from('<html>'), Buffer.from([0xff]), Buffer.from('</html>')])
    stubFetch(() => new Response(chunkStream([invalidHtml]), { headers: { 'Content-Type': 'text/html; charset=utf-8' } }))
    await expect(fetchBoardText('https://example.com/invalid-html', new AbortController().signal)).rejects.toThrow()
  })

  it('distinguishes complete malformed or empty JSON from an interrupted body, and keeps the HTML no-body message', async () => {
    for (const body of ['{"jobs":[', '', 'not json']) {
      stubFetch(() => new Response(body, { headers: JSON_HEADERS }))
      const error = await caught(fetchBoardJson('https://example.com/malformed', new AbortController().signal))
      expect(error, JSON.stringify(body)).toBeInstanceOf(BoardFetchError)
      expect(error.message, JSON.stringify(body)).toBe(JSON_FORMAT_MESSAGE)
    }
    stubFetch(() => new Response(null, { status: 200 }))
    expect((await caught(fetchBoardJson('https://example.com/null', new AbortController().signal))).message).toBe(JSON_FORMAT_MESSAGE)
    let sent = false
    const interrupted = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!sent) { sent = true; controller.enqueue(Buffer.from('{"jobs":[')); return }
        controller.error(new TypeError('terminated'))
      },
    })
    stubFetch(() => new Response(interrupted, { headers: JSON_HEADERS }))
    const dropped = await caught(fetchBoardJson('https://example.com/interrupted', new AbortController().signal))
    expect(dropped).toBeInstanceOf(BoardFetchError)
    expect(dropped.message).toBe(JSON_INTERRUPTED_MESSAGE)
    stubFetch(() => new Response(null, { status: 200 }))
    expect((await caught(fetchBoardText('https://example.com/no-body', new AbortController().signal))).message).toBe(HTML_NO_BODY_MESSAGE)
  })

  it('copies a long BoardFetchError abort reason to 500 characters with its retryAfter, and classifies native timeout and generic abort', async () => {
    const longMessage = '게'.repeat(600)
    const controller = new AbortController()
    stubFetch(init => new Response(pendingStream([Buffer.from('{"jobs":[')], { onStart: abortWiring(init) }), { headers: JSON_HEADERS }))
    const pending = caught(fetchBoardJson('https://example.com/app-abort', controller.signal))
    await delay(20)
    const reason = new BoardFetchError(longMessage, BASE + 90_000)
    controller.abort(reason)
    const error = await pending
    expect(error).toBeInstanceOf(BoardFetchError)
    expect(error).not.toBe(reason)
    expect(error.message).toBe(longMessage.slice(0, 500))
    expect(error.message).toHaveLength(500)
    expect((error as BoardFetchError).retryAfter).toBe(BASE + 90_000)

    stubFetch(init => new Response(pendingStream([Buffer.from('{')], { onStart: abortWiring(init) }), { headers: JSON_HEADERS }))
    const timeout = await caught(fetchBoardJson('https://example.com/timeout', AbortSignal.timeout(50)))
    expect(timeout).toBeInstanceOf(BoardFetchError)
    expect(timeout.message).toBe(JSON_TIMEOUT_MESSAGE)

    const generic = new AbortController()
    stubFetch(init => new Response(pendingStream([Buffer.from('{')], { onStart: abortWiring(init) }), { headers: JSON_HEADERS }))
    const pendingGeneric = caught(fetchBoardJson('https://example.com/generic', generic.signal))
    await delay(20)
    generic.abort()
    const cancelled = await pendingGeneric
    expect(cancelled).toBeInstanceOf(BoardFetchError)
    expect(cancelled.message).toBe(JSON_CANCELLED_MESSAGE)
  })

  it('fetchBoardText: an application abort reason during the body keeps its message and retryAfter', async () => {
    const controller = new AbortController()
    stubFetch(init => new Response(pendingStream([Buffer.from('<html>')], { onStart: abortWiring(init) }), { headers: { 'Content-Type': 'text/html; charset=utf-8' } }))
    const pending = caught(fetchBoardText('https://example.com/html-abort', controller.signal))
    await delay(20)
    const reason = new BoardFetchError('공식 채용 사이트의 수집 시간이 초과됐어요.', BASE + 60_000)
    controller.abort(reason)
    const error = await pending
    expect(error).toBeInstanceOf(BoardFetchError)
    expect(error.message).toBe('공식 채용 사이트의 수집 시간이 초과됐어요.')
    expect((error as BoardFetchError).retryAfter).toBe(BASE + 60_000)
  })

  for (const [name, read] of readers) {
    it.each([
      ['throws synchronously', () => { throw new Error('cancel exploded') }],
      ['rejects', () => Promise.reject(new Error('cancel rejected'))],
      ['never settles', () => new Promise<void>(() => undefined)],
    ] as const)(`${name}: keeps HTTP 429 and its Retry-After when the discarded body's cancel %s`, async (_label, misbehave) => {
      vi.spyOn(Date, 'now').mockReturnValue(BASE)
      let cancelAttempts = 0
      const response = new Response(pendingStream([Buffer.from('{"error":1')], {
        onCancel: () => { cancelAttempts++; return misbehave() },
      }), { status: 429, headers: { ...JSON_HEADERS, 'Retry-After': '120' } })
      stubFetch(() => response)
      const startedAt = performance.now()
      const error = await caught(read('https://example.com/limited', new AbortController().signal))
      expect(error).toBeInstanceOf(BoardResponseError)
      expect((error as BoardResponseError).status).toBe(429)
      expect((error as BoardResponseError).retryAfter).toBe(BASE + 120_000)
      expect(performance.now() - startedAt).toBeLessThan(1000)
      expect(cancelAttempts).toBe(1)
      expect(response.bodyUsed).toBe(true)
      expect(response.body!.locked).toBe(false)
    }, 5000)

    it(`${name}: cancels the unread body of an HTTP failure without reading it through`, async () => {
      let cancelled = false
      let pulled = 0
      const response = directiveResponse(streamDirective('{"error":"', '"}', 4096, { chunkBytes: 256, status: 503 }), {
        onCancel: () => { cancelled = true }, onPull: bytes => { pulled = bytes },
      })
      stubFetch(() => response)
      const error = await caught(read('https://example.com/unavailable', new AbortController().signal))
      expect(error).toBeInstanceOf(BoardResponseError)
      expect((error as BoardResponseError).status).toBe(503)
      expect(cancelled).toBe(true)
      expect(response.bodyUsed).toBe(true)
      expect(pulled).toBeLessThan(4096)
      expect(response.body!.locked).toBe(false)
    })
  }

  it('keeps the size error when the excess body\'s cancel throws and a later abort arrives', async () => {
    const controller = new AbortController()
    let cancelled = false
    // The source stays open past the excess byte so that cancel is actually invoked.
    const response = new Response(pendingStream([...directiveChunks(paddedJsonObject({ jobs: [] }, JSON_CAP_BYTES + 1))], {
      onCancel: () => {
        cancelled = true
        controller.abort(new BoardFetchError('나중에 도착한 취소'))
        throw new Error('cancel exploded')
      },
    }), { headers: JSON_HEADERS })
    stubFetch(() => response)
    const error = await caught(fetchBoardJson('https://example.com/over', controller.signal))
    expect(error).toBeInstanceOf(BoardFetchError)
    expect(error.message).toBe(JSON_SIZE_MESSAGE)
    expect(cancelled).toBe(true)
    expect(response.body!.locked).toBe(false)
  }, HEAVY)
})
