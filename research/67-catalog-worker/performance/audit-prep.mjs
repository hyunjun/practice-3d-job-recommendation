import fs from 'node:fs'
import path from 'node:path'
import net from 'node:net'
import os from 'node:os'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { perf, root, oracle, shaFile, readFreeze, auditFreeze } from './protocol.mjs'

const baseline = readFreeze('stage66-34df6ee'), candidate = readFreeze('stage67-build-02')
auditFreeze(baseline)
auditFreeze(candidate)
const tests = Object.fromEntries(baseline.manifest.tests.map(test => [test.file, test.sha256]))
for (const [file, hash] of Object.entries(tests)) assert.equal(shaFile(path.join(root, file)), hash)
assert.equal(shaFile(path.join(perf, 'actual-frozen/catalog.json')), oracle.catalogSha256)
const fixture = JSON.parse(fs.readFileSync(path.join(perf, 'prepared-fixtures/receipt.json'), 'utf8'))
assert.equal(shaFile(path.join(perf, 'prepared-fixtures/actual.br')), fixture.wireSha256)
const staticChecks = JSON.parse(fs.readFileSync(path.join(perf, 'prep-checks/static-and-gates.json'), 'utf8'))
const guards = JSON.parse(fs.readFileSync(path.join(perf, 'prep-checks/window-guards.json'), 'utf8'))
assert.equal(staticChecks.complete, true)
assert.equal(guards.passed, true)
const socketState = async port => new Promise(resolve => {
  const socket = net.createConnection({ host: '127.0.0.1', port })
  socket.once('connect', () => { socket.destroy(); resolve({ port, listening: true }) })
  socket.once('error', error => resolve({ port, listening: false, code: error.code }))
  socket.setTimeout(1000, () => { socket.destroy(); resolve({ port, listening: null, code: 'timeout' }) })
})
const sockets = await Promise.all([9, 5890, 5891, 5892, 5893, 8787].map(socketState))
for (const port of [5890, 5891, 5892, 5893, 8787]) assert.equal(sockets.find(socket => socket.port === port).listening, false, `Unexpected listener on port ${port}; do not stop an unrelated process`)
assert.equal(sockets.find(socket => socket.port === 9).listening, false, 'Deny-all proxy port must remain closed before browser runs')
const files = fs.readdirSync(perf).filter(file => fs.statSync(path.join(perf, file)).isFile() && file !== 'prep-audit.json')
const scripts = Object.fromEntries(files.map(file => [file, shaFile(path.join(perf, file))]))
for (const file of ['actual-frozen/catalog.json', 'prepared-fixtures/actual.br', 'PREP.md']) {
  const ignored = execFileSync('git', ['-C', root, 'check-ignore', path.join(perf, file)], { encoding: 'utf8' }).trim()
  assert(ignored)
}
const freezes = [baseline, candidate].map(freeze => ({
  name: freeze.name, baseCommit: freeze.manifest.commit ?? freeze.manifest.baseCommit,
  manifestSha256: freeze.manifestSha256, inputs: Object.keys(freeze.manifest.inputs).length,
  artifacts: Object.keys(freeze.manifest.artifacts).length,
  buildFinishedAt: freeze.manifest.buildReceipt.finishedAt,
  source: freeze.source,
}))
const report = {
  status: 'PREP_READY_BROWSER_QUALIFICATION_PENDING_WINDOW',
  checkedAt: new Date().toISOString(), freezes, scripts, publicTestsUnchanged: tests,
  actual: { sha256: oracle.catalogSha256, decodedBytes: oracle.catalogBytes, wireSha256: fixture.wireSha256, wireBytes: fixture.wireBytes, fixedNow: oracle.fixedNow, companies: 124, jobs: 6756, cities: 22 },
  commands: [
    { command: 'node .local/research/67-catalog-worker/performance/freeze-candidate.mjs build-02', result: '120 source inputs / 361 artifacts / 4 test files verified and copied; no root build or dist write' },
    { command: 'node --import tsx .local/research/67-catalog-worker/performance/prepare-fixtures.mjs', result: 'Literal sanity checks, 2 landmarks and Brotli round-trip pass; prior manifest-schema checker issue corrected and rerun' },
    { command: 'node --test .local/research/67-catalog-worker/performance/harness.test.mjs', result: '3 passed, 0 failed, 0 skipped; only tiny synthetic ephemeral loopback servers' },
    { command: 'node --check (all local JS/MJS), esbuild TypeScript transform (synthetic v1)', result: 'Syntax/transpile checks pass; this is not a browser E2E run or a full root typecheck' },
    { command: 'server.mjs / measure-actual.mjs / measure-synthetic-v1.ts with GLOBE_QA_WINDOW absent', result: 'All 3 reject before starting a server/browser, expected exit 1' },
  ],
  timing: { window: 'CLOSED; no new native runs or diagnostic profiles launched', actualBeforeRuns: 0, actualAfterRuns: 0, syntheticStage67BeforeRuns: 0, syntheticStage67AfterRuns: 0 },
  cleanup: { sockets, ownedQaAppServersStarted: 0, ephemeralGateTestServersClosed: 3, browserProcessesStarted: 0, rootDistWritten: false, upstreamCalls: 0, actualDefaultCacheRead: false, commits: 0, pushes: 0 },
  environment: { node: process.version, platform: process.platform, arch: process.arch, release: os.release(), cpu: os.cpus()[0]?.model },
  remaining: 'Main grants a CPU window and final combined candidate. First qualify actual cold/refresh UI interactions and manually inspect rotation/landmark screenshots; freeze any harness corrections, then run the requested complete matched production samples. Singer owns functional E2E.',
}
fs.writeFileSync(path.join(perf, 'prep-audit.json'), JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify({ status: report.status, freezes, publicTestsUnchanged: Object.keys(tests).length, gateTests: '3/3', sockets, nativeRuns: 0, profiles: 0 }))
