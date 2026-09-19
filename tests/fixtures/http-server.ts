import { createServer, request } from 'node:http'
import type { IncomingHttpHeaders, OutgoingHttpHeaders } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Express } from 'express'

export async function serveHttp(app: Express) {
  const server = createServer(app)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return {
    origin,
    close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
  }
}

export function requestBytes(origin: string, path: string, headers: OutgoingHttpHeaders = {}, method = 'GET') {
  return new Promise<{ status: number; headers: IncomingHttpHeaders; body: Buffer }>((resolve, reject) => {
    const req = request(new URL(path, origin), { headers, method }, response => {
      const chunks: Buffer[] = []
      response.on('data', chunk => chunks.push(chunk))
      response.on('error', reject)
      response.on('end', () => resolve({ status: response.statusCode!, headers: response.headers, body: Buffer.concat(chunks) }))
    })
    req.on('error', reject)
    req.setTimeout(5000, () => req.destroy(new Error('HTTP test request timed out')))
    req.end()
  })
}
