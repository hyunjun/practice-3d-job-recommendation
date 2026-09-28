import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { perf, root, sha, shaFile, oracle, readFreeze, auditFreeze } from './protocol.mjs'

const qa68 = path.join(root, '.local/research/68-catalog-presentation')
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'))
const main = file => read(path.join(qa68, 'main', file))
const main68Commit = '9a755830fdca29600a5cc3b32e5813af6b3bd86c'
const stage66Commit = '34df6eeed2a556f6148b592b4241e96b52e3f24e'
const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
execFileSync('git', ['merge-base', '--is-ancestor', main68Commit, head], { cwd: root })
const status = execFileSync('git', ['status', '--porcelain=v1'], { cwd: root, encoding: 'utf8' }).trim()
const audited = name => {
  const freeze = readFreeze(name)
  auditFreeze(freeze)
  const tests = Array.isArray(freeze.manifest.tests)
    ? Object.fromEntries(freeze.manifest.tests.map(test => [test.file, test.sha256]))
    : freeze.manifest.tests
  return { freeze, record: {
    name, source: freeze.source, resolvedSource: fs.realpathSync(freeze.source),
    manifestSha256: freeze.manifestSha256,
    sourceInputs: Object.keys(freeze.manifest.inputs).length,
    artifacts: Object.keys(freeze.manifest.artifacts).length,
    frozenTests: Object.keys(tests ?? {}).length,
    allFrozenBytesMatched: true,
  } }
}
const before = audited('stage66-34df6ee'), after = audited('stage68-root-build-01')
assert.equal(before.record.sourceInputs, 116)
assert.equal(before.record.artifacts, 360)
assert.equal(after.record.sourceInputs, 121)
assert.equal(after.record.artifacts, 361)
assert.notEqual(after.record.resolvedSource, root)
for (const [file, hash] of Object.entries({ ...after.freeze.manifest.inputs, ...after.freeze.manifest.artifacts }))
  assert.equal(shaFile(path.join(root, file)), hash, `Root differs from timed Stage68: ${file}`)

const ownedTests = read(path.join(qa68, 'public-test-handoff.json')).files
assert.equal(Object.keys(ownedTests).length, 4)
for (const [file, hash] of Object.entries(ownedTests)) {
  assert.equal(shaFile(path.join(root, file)), hash, `Owned public test changed: ${file}`)
  assert.equal(sha(execFileSync('git', ['show', `${main68Commit}:${file}`], { cwd: root })), hash)
}
const globePaths = ['tests/e2e/globe-responsiveness.spec.ts',
  'tests/e2e/helpers/globe-responsiveness.ts', 'tests/fixtures/globe-responsiveness.ts',
  'tests/unit/globe-summary.test.ts']
const globeTests = Object.fromEntries(globePaths.map(file => {
  const hash = shaFile(path.join(before.freeze.source, file))
  assert.equal(shaFile(path.join(root, file)), hash, `Stage66 test/protocol dependency changed: ${file}`)
  assert.equal(sha(execFileSync('git', ['show', `${stage66Commit}:${file}`], { cwd: root })), hash)
  return [file, hash]
}))
const finalInputs = main('types-final-01/after.json')
const unitInputs = main('checks-01/after.json')
assert.equal(Object.keys(finalInputs).length, 347)
for (const [file, hash] of Object.entries(finalInputs))
  assert.equal(shaFile(path.join(root, file)), hash, `Final type/check input changed: ${file}`)
const changedSinceWholeUnits = Object.keys(finalInputs).filter(file => finalInputs[file] !== unitInputs[file])
assert.deepEqual(changedSinceWholeUnits, ['tests/e2e/catalog-revalidation.spec.ts'])
assert.equal(finalInputs['tests/e2e/catalog-revalidation.spec.ts'],
  '22ed5c9554d1e3e228b923e70a554bf5277724609915d29ea5485ab6e6db72d3')
const typeReceipt = main('types-final-01/receipt.json')
const buildReceipt = main('root-build-01/receipt.json')
const isolatedBuildReceipt = main('build-01/receipt.json')
const unitReceipt = main('checks-01/receipt.json')
assert.equal(typeReceipt.exitCode, 0)
assert.equal(buildReceipt.exitCode, 0)
assert.deepEqual(buildReceipt.artifactDifferences, [])
const unitResults = main('checks-01/unit-results.json')
assert.equal(unitResults.numPassedTests, 1992)
assert.equal(unitResults.numFailedTests, 0)
assert.equal(unitResults.numPendingTests, 0)
assert.equal(unitResults.success, true)
const functionalCoverage = ['development', 'production'].map(mode => {
  const file = path.join(qa68, 'main', `${mode}-final-coverage.json`)
  const coverage = read(file)
  assert.equal(coverage.expected, 191)
  assert.equal(coverage.unique, 191)
  assert.deepEqual(coverage.missing, [])
  assert.deepEqual(coverage.extras, [])
  assert.deepEqual(coverage.notPassing, [])
  assert.equal(coverage.cases.length, 191)
  assert(coverage.cases.every(test => test.expectedStatus === 'passed' &&
    test.results.length === 1 && test.results[0].status === 'passed' && test.results[0].retry === 0))
  return { mode, expected: 191, acceptedUniquePassed: 191, acceptedRetries: 0,
    missing: 0, extras: 0, notPassing: 0, reuse: coverage.reused,
    receipt: path.relative(root, file), receiptSha256: shaFile(file),
    owner: mode === 'development' ? 'This independent sidecar' : 'Herschel; main reconciled original result files',
    runs: coverage.runs.map(run => ({ id: run.id, result: run.result, originalStats: run.stats })),
  }
})
const actualCopy = path.join(perf, 'actual-frozen/catalog.json')
const authorizedOriginal = path.join(root, '.local/research/67-catalog-worker/main/actual-frozen/catalog.json')
assert.equal(fs.statSync(actualCopy).size, 59894550)
assert.equal(shaFile(actualCopy), oracle.catalogSha256)
assert.equal(shaFile(authorizedOriginal), oracle.catalogSha256)
const wireReceipt = read(path.join(perf, 'prepared-fixtures/receipt.json'))
assert.equal(shaFile(path.join(perf, 'prepared-fixtures/actual.br')), wireReceipt.wireSha256)
for (const version of ['native-protocol-freeze', 'native-protocol-freeze-v2']) {
  const manifest = read(path.join(perf, version, 'manifest.json'))
  for (const [file, hash] of Object.entries(manifest.harness)) {
    assert.equal(shaFile(path.join(perf, file)), hash, `${version} working harness changed: ${file}`)
    assert.equal(shaFile(path.join(perf, version, file)), hash, `${version} preserved harness changed: ${file}`)
  }
}
const retirement = read(path.join(perf, 'metric-v1-retirement.json'))
for (const run of retirement.completedNativeV1)
  assert.equal(shaFile(path.join(perf, 'runs', run.label, 'summary.json')), run.summarySha256)
const result = {
  auditedAt: new Date().toISOString(), allMatched: true, rootHead: head, rootGitStatus: status,
  stage66ProductCommit: stage66Commit, stage68ProductCommit: main68Commit,
  stage68HeadChangeFrom67: 'Expected functional commit; timed source/build/test bytes unchanged.',
  before: { ...before.record, buildFinishedAt: '2026-09-27T07:04:58.218Z' },
  after: { ...after.record, buildFinishedAt: buildReceipt.finishedAt,
    identicalIsolatedBuildFinishedAt: isolatedBuildReceipt.finishedAt,
    currentRootSourceInputsMatched: 121, currentRootBuildArtifactsMatched: 361 },
  ownedNewStage68Tests: ownedTests, unchangedStage66TestAndProtocolDependencies: globeTests,
  rootFinalTypeAndCheckInputsMatched: 347, changedSinceWholeUnits,
  finalTypeReceipt: typeReceipt, fullUnitReceipt: unitReceipt,
  fullUnitResult: { passed: unitResults.numPassedTests, failed: unitResults.numFailedTests,
    pending: unitResults.numPendingTests, files: unitResults.testResults.length },
  functionalCoverage,
  actual: { authorizedOriginal, actualCopy, bytes: 59894550, sha256: oracle.catalogSha256,
    wireBytes: fs.statSync(path.join(perf, 'prepared-fixtures/actual.br')).size,
    wireSha256: wireReceipt.wireSha256, fixedNow: oracle.fixedNow,
    defaultActualCacheAccessed: false, providerCalls: 0 },
  v1AndV2HarnessBytesMatched: true, originalV1NativeSummariesPreserved: 20,
  environment: { platform: process.platform, arch: process.arch, node: process.version,
    osRelease: os.release(), cpu: os.cpus()[0]?.model },
  ownership: 'No product/config/docs edits, builds, commits or pushes by this sidecar. Stage68 public files remain the four agreed tests; this performance phase wrote only ignored private QA artifacts.',
}
fs.writeFileSync(path.join(perf, 'final-v2-source-audit.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' })
console.log(JSON.stringify({ allMatched: true, rootHead: head, rootGitStatus: status,
  before: result.before, after: result.after, ownedNewStage68Tests: Object.keys(ownedTests),
  finalTypeAndCheckInputsMatched: 347, fullUnits: result.fullUnitResult,
  functional: functionalCoverage.map(mode => ({ mode: mode.mode, passed: mode.acceptedUniquePassed })),
  actualSha256: result.actual.sha256, v1AndV2HarnessBytesMatched: true }, null, 2))
