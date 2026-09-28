import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { performance } from 'node:perf_hooks'
import express from 'express'
import { ResponseGate } from './response-gate.mjs'
import { perf, oracle, sha, requireWindow, readFreeze, auditFreeze, assertOwnedOrigin } from './protocol.mjs'

const windowAcknowledgement = requireWindow()
const freeze = readFreeze(process.env.GLOBE_QA_FREEZE ?? 'stage66-34df6ee')
auditFreeze(freeze)
const port = Number(process.env.PORT ?? '5890')
const origin = `http://127.0.0.1:${port}`
assertOwnedOrigin(origin)
const mode = process.env.ORBIT_TEST_MODE ?? 'production'
assert(['development', 'production'].includes(mode))
const fixture = process.env.GLOBE_QA_FIXTURE ?? 'actual-frozen'
assert(['actual-frozen', 'synthetic-public'].includes(fixture))
const prepared = path.join(perf, 'prepared-fixtures')
const wire = fixture === 'actual-frozen' ? fs.readFileSync(path.join(prepared, 'actual.br')) : null
const wireReceipt = fixture === 'actual-frozen' ? JSON.parse(fs.readFileSync(path.join(prepared, 'receipt.json'), 'utf8')) : null
if (wire) {
  assert.equal(sha(wire), wireReceipt.wireSha256)
  assert.equal(wireReceipt.actualSha256, oracle.catalogSha256)
}
const bootstrap = fs.readFileSync(path.join(prepared, 'bootstrap.json'))
const observations = fs.readFileSync(path.join(prepared, 'observations.json'))
const token = crypto.randomUUID()
const startedAt = new Date().toISOString(), processStart = performance.now()
const directory = path.join(perf, 'servers')
fs.mkdirSync(directory, { recursive: true })
const ledgerFile = path.join(directory, `${port}-${Date.now()}.jsonl`)
const events = []
let scenario = null, runId = null, gate = null, bootstrapCompleted = 0, actualCompleted = 0
function record(data) {
  const entry = { at: performance.now() - processStart, runId, ...data }
  events.push(entry)
  fs.appendFileSync(ledgerFile, JSON.stringify(entry) + '\n')
}
function state() {
  return { scenario, runId, bootstrapCompleted, actualCompleted, gate: gate?.state() ?? null, events }
}
// This process never imports server/index, server/catalog or any collector.
globalThis.fetch = async () => { throw new Error('Forbidden upstream request from isolated performance server') }
const app = express()
app.disable('x-powered-by')
app.get('/api/health', (_request, response) => response.json({
  status: 'ok', fixture, mode, origin, pid: process.pid, startedAt,
  freeze: freeze.name, manifestSha256: freeze.manifestSha256,
  source: freeze.source, wireReceipt, ledgerFile,
}))
app.use('/__qa', express.json({ limit: '8kb' }), (request, response, next) => {
  if (request.headers['x-globe-qa-key'] !== token) return response.sendStatus(403)
  next()
})
app.get('/__qa/state', (_request, response) => response.json(state()))
app.post('/__qa/arm', (request, response) => {
  try {
    assert(fixture === 'actual-frozen')
    assert(!gate || ['complete', 'cancelled'].includes(gate.phase), 'An earlier response is still held')
    assert(['cold', 'refresh'].includes(request.body.scenario))
    assert.match(request.body.runId, /^[a-zA-Z0-9_-]+$/)
    scenario = request.body.scenario
    runId = request.body.runId
    gate = null; bootstrapCompleted = 0; actualCompleted = 0; events.length = 0
    record({ type: 'armed', scenario })
    response.json(state())
  } catch (error) { response.status(409).json({ error: String(error) }) }
})
app.post('/__qa/body', async (_request, response) => {
  try {
    assert(gate, 'No actual catalog request is held')
    await gate.body()
    response.json(state())
  } catch (error) { record({ type: 'gate-error', error: String(error) }); response.status(409).json({ error: String(error) }) }
})
app.post('/__qa/eof', (_request, response) => {
  try {
    assert(gate, 'No actual catalog request is held')
    gate.eof()
    actualCompleted++
    response.json(state())
  } catch (error) { record({ type: 'gate-error', error: String(error) }); response.status(409).json({ error: String(error) }) }
})
app.post('/__qa/dispose', (_request, response) => {
  gate?.dispose()
  response.json(state())
})
app.get('/api/catalog', (request, response) => {
  const requested = request.originalUrl
  record({ type: 'api', method: request.method, path: requested, prefer: request.headers.prefer ?? null })
  if (fixture !== 'actual-frozen' || !scenario) {
    record({ type: 'unexpected', reason: 'Synthetic v1 must intercept its catalog in the browser; actual scenario must be armed' })
    return response.status(409).json({ error: 'Fixture scenario not armed' })
  }
  const ordinary = requested === '/api/catalog?source=public'
  const refresh = requested === '/api/catalog?source=public&refresh=1'
  if (scenario === 'refresh' && ordinary && !gate && bootstrapCompleted < 1) {
    bootstrapCompleted++
    return response.type('json').set('Cache-Control', 'no-store').send(bootstrap)
  }
  if (!((scenario === 'cold' && ordinary) || (scenario === 'refresh' && refresh))
    || actualCompleted || (gate && !gate.cancelled)) {
    record({ type: 'unexpected', reason: 'Unexpected catalog request or duplicate full-payload delivery' })
    return response.status(409).json({ error: 'Unexpected catalog request' })
  }
  if (gate?.cancelled && gate.written) {
    record({ type: 'unexpected', reason: 'Partial actual response was aborted' })
    return response.status(409).json({ error: 'Partial response aborted' })
  }
  assert(request.headers['accept-encoding']?.includes('br'), 'Browser must support the pinned production Brotli encoding')
  gate = new ResponseGate(response, wire, { log: record })
  record({ type: 'actual-request-held', path: requested })
})
app.get('/api/observations', (request, response) => {
  record({ type: 'api', method: request.method, path: request.originalUrl })
  response.type('json').set('Cache-Control', 'no-store').send(observations)
})
app.use('/api', (request, response) => {
  record({ type: 'unexpected', method: request.method, path: request.originalUrl })
  response.status(404).json({ error: 'No provider transport exists in this fixture' })
})
const server = createServer(app)
let vite
if (mode === 'production') {
  assert(fs.existsSync(path.join(freeze.source, 'dist/index.html')))
  app.use(express.static(path.join(freeze.source, 'dist')))
  app.get('/{*path}', (_request, response) => response.sendFile(path.join(freeze.source, 'dist/index.html')))
} else {
  const { createServer: createViteServer } = await import('vite')
  vite = await createViteServer({
    root: freeze.source, appType: 'spa',
    cacheDir: path.join(perf, 'vite-cache', freeze.name, String(port)),
    server: { middlewareMode: true, hmr: { server }, fs: { allow: [freeze.source, fs.realpathSync(path.join(freeze.source, 'node_modules'))] } },
  })
  app.use(vite.middlewares)
}
server.on('error', error => { console.error(error); process.exitCode = 1; void vite?.close() })
server.listen(port, '127.0.0.1', () => {
  const owner = {
    pid: process.pid, cwd: process.cwd(), script: new URL(import.meta.url).pathname,
    origin, token, startedAt, fixture, mode, freeze: freeze.name,
    manifestSha256: freeze.manifestSha256, ledgerFile, windowAcknowledgement,
  }
  fs.writeFileSync(path.join(directory, `${port}.json`), JSON.stringify(owner, null, 2) + '\n', { mode: 0o600 })
  console.log(JSON.stringify({ ...owner, token: '[local control token in owner receipt]' }))
})
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
  record({ type: 'server-stop', signal })
  gate?.dispose()
  server.close(() => { void Promise.resolve(vite?.close()).then(() => process.exit(0)) })
  setTimeout(() => process.exit(1), 3000).unref()
})
