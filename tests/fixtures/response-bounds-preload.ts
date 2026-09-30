import { appendFileSync, readFileSync } from 'node:fs'
import { DEFAULT_CHUNK_BYTES, directiveBytes, directiveStream, isStreamDirective } from './response-bounds-stream'

// Loaded only by an owned test child. No app API/state is replaced. Native
// timers still run; only its wall-clock boundary and upstream HTTP are inputs.
// A stream directive becomes a Response over a real ReadableStream, so the
// product's shared HTTP reader consumes it chunk by chunk. A constructed
// Response never decodes Content-Encoding; compression is proven in unit tests.
const responsesFile = process.env.ORBIT_RESPONSE_BOUNDS_RESPONSES
const requestLog = process.env.ORBIT_RESPONSE_BOUNDS_REQUEST_LOG
const clockFile = process.env.ORBIT_RESPONSE_BOUNDS_CLOCK
if (!responsesFile || !requestLog || !clockFile) throw new Error('Isolated response-bounds fixture paths are required')
Date.now = () => {
  const value = Date.parse(readFileSync(clockFile, 'utf8').trim())
  if (!Number.isFinite(value)) throw new Error('Invalid fixture clock')
  return value
}
const log = (entry: object) => appendFileSync(requestLog, `${JSON.stringify(entry)}\n`)

globalThis.fetch = async (input, init) => {
  const url = input instanceof Request ? input.url : String(input)
  const method = init?.method ?? (input instanceof Request ? input.method : 'GET')
  try {
    const responses = JSON.parse(readFileSync(responsesFile, 'utf8')) as Record<string, unknown>
    if (method !== 'GET' || !Object.hasOwn(responses, url)) throw new Error(`Unexpected upstream request: ${method} ${url}`)
    const value = responses[url]
    const at = new Date(Date.now()).toISOString()
    if (isStreamDirective(value)) {
      const declaredBytes = directiveBytes(value)
      const chunkBytes = value.chunkBytes ?? DEFAULT_CHUNK_BYTES
      log({ kind: 'request', url, method, at, synthetic: true, networkSent: false, stream: { declaredBytes, chunkBytes } })
      let pulledBytes = 0
      const stream = directiveStream(value, {
        onPull: bytes => { pulledBytes = bytes },
        onCancel: reason => { log({ kind: 'stream', url, declaredBytes, pulledBytes, cancelled: true, reason: String(reason) }) },
        onClose: () => { log({ kind: 'stream', url, declaredBytes, pulledBytes, cancelled: false }) },
      })
      return new Response(stream, {
        status: value.status ?? 200,
        headers: { 'Content-Type': value.contentType ?? 'application/json', ...value.headers },
      })
    }
    log({ kind: 'request', url, method, at, synthetic: true, networkSent: false })
    return Response.json(value)
  } catch (error) {
    log({ kind: 'request', url, method, synthetic: false, networkSent: false, error: String(error) })
    throw error
  }
}
