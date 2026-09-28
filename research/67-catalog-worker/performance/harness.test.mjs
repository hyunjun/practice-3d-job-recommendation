import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import { brotliCompressSync } from 'node:zlib'
import { ResponseGate } from './response-gate.mjs'

for (const encoding of ['identity', 'br']) test(`real HTTP ${encoding}: body cannot finish until final-byte release`, async () => {
  const expected = { synthetic: true, jobs: ['authored-london', 'authored-amsterdam'], companies: 1 }
  const plain = Buffer.from(JSON.stringify(expected))
  const bytes = encoding === 'br' ? brotliCompressSync(plain) : plain
  let gate
  const server = createServer((_request, response) => {
    gate = new ResponseGate(response, bytes, { encoding, chunks: 3, cadenceMs: 1, tailBytes: 2 })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  assert.notEqual(server.address().port, 8787)
  let received = false
  const responsePromise = fetch(`http://127.0.0.1:${server.address().port}`).then(response => response.json()).then(body => { received = true; return body })
  try {
    for (let i = 0; !gate && i < 50; i++) await new Promise(resolve => setTimeout(resolve, 1))
    assert(gate)
    assert.equal(gate.phase, 'headers-held')
    assert.equal(received, false)
    assert.throws(() => gate.eof())
    await gate.body()
    assert.equal(gate.phase, 'eof-held')
    await new Promise(resolve => setTimeout(resolve, 15))
    assert.equal(received, false)
    assert.equal(gate.written, bytes.length - 2)
    gate.eof()
    assert.deepEqual(await responsePromise, expected)
    assert.equal(gate.phase, 'complete')
    assert.equal(gate.written, bytes.length)
    assert.throws(() => gate.eof())
  } finally {
    gate?.dispose()
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  }
})

test('pre-body client abort is recorded and never counted as a complete delivery', async () => {
  const events = []
  let gate
  const server = createServer((_request, response) => {
    gate = new ResponseGate(response, Buffer.alloc(64), { log: event => events.push(event) })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  assert.notEqual(server.address().port, 8787)
  const abort = new AbortController()
  const request = fetch(`http://127.0.0.1:${server.address().port}`, { signal: abort.signal }).catch(error => error)
  try {
    for (let i = 0; !gate && i < 50; i++) await new Promise(resolve => setTimeout(resolve, 1))
    assert(gate)
    abort.abort()
    await request
    for (let i = 0; !gate.cancelled && i < 50; i++) await new Promise(resolve => setTimeout(resolve, 1))
    assert.equal(gate.phase, 'cancelled')
    assert.equal(gate.written, 0)
    assert.deepEqual(events, [{ type: 'client-abort', bytes: 0 }])
  } finally {
    gate?.dispose()
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  }
})
