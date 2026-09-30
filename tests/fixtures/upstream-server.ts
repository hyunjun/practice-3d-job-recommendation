import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createServer as createSocketServer } from 'node:net'
import type { AddressInfo, Socket } from 'node:net'

/**
 * Owned loopback upstream servers for the production HTTP readers. Unlike the
 * Express helper, this exposes raw framing, chunked writes with backpressure,
 * and the moment the client actually releases each connection.
 */
export interface UpstreamRecord {
  path: string
  method: string
  acceptEncoding: string | undefined
  /** Bytes the server flushed through the write helper. */
  bytesWritten: number
  /** The server ended the response normally. */
  finished: boolean
  /** performance.now() when the connection for this response closed, or null while open. */
  closedAt: number | null
  startedAt: number
}

export interface UpstreamContext {
  request: IncomingMessage
  response: ServerResponse
  record: UpstreamRecord
  /** Writes with backpressure; rejects once the client connection is gone. */
  write: (chunk: Uint8Array | string) => Promise<void>
}

export type UpstreamHandler = (context: UpstreamContext) => void | Promise<void>

export async function startUpstream(handler: UpstreamHandler) {
  const records: UpstreamRecord[] = []
  const server = createServer()
  server.on('request', (request, response) => {
    const record: UpstreamRecord = {
      path: request.url ?? '', method: request.method ?? 'GET',
      acceptEncoding: request.headers['accept-encoding'] as string | undefined,
      bytesWritten: 0, finished: false, closedAt: null, startedAt: performance.now(),
    }
    records.push(record)
    response.once('finish', () => { record.finished = true })
    response.once('close', () => { record.closedAt = performance.now() })
    const write = (chunk: Uint8Array | string) => new Promise<void>((resolve, reject) => {
      if (response.destroyed || response.writableEnded) {
        reject(new Error('The client connection is gone'))
        return
      }
      const bytes = typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.byteLength
      response.write(chunk, error => {
        if (error) { reject(error); return }
        record.bytesWritten += bytes
        resolve()
      })
    })
    Promise.resolve().then(() => handler({ request, response, record, write })).catch(() => {
      if (!response.destroyed) response.destroy()
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return {
    origin,
    records,
    /**
     * 'closed' when every connection ended by itself within the grace period,
     * which requires the client to have consumed or cancelled each body.
     * Otherwise the remaining connections are destroyed and 'forced' is returned.
     */
    close(gracePeriodMs = 2000): Promise<'closed' | 'forced'> {
      return new Promise(resolve => {
        const timer = setTimeout(() => { server.closeAllConnections(); resolve('forced') }, gracePeriodMs)
        server.close(() => { clearTimeout(timer); resolve('closed') })
      })
    },
  }
}

export type Upstream = Awaited<ReturnType<typeof startUpstream>>

/** A raw TCP responder for exact HTTP framing that node:http would normalize away. */
export async function startRawUpstream(respond: (socket: Socket, requestHead: string) => void) {
  const sockets = new Set<Socket>()
  const server = createSocketServer(socket => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.on('error', () => undefined)
    let head = ''
    let responded = false
    socket.on('data', chunk => {
      if (responded) return
      head += chunk.toString('latin1')
      if (!head.includes('\r\n\r\n')) return
      responded = true
      respond(socket, head)
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return {
    origin,
    close: () => new Promise<void>(resolve => {
      for (const socket of sockets) socket.destroy()
      server.close(() => resolve())
    }),
  }
}

export async function waitFor(condition: () => boolean, timeoutMs: number, description: string): Promise<void> {
  const deadline = performance.now() + timeoutMs
  while (!condition()) {
    if (performance.now() > deadline) throw new Error(`Timed out after ${timeoutMs}ms waiting for ${description}`)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}
