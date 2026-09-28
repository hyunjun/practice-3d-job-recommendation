import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const perf = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(perf, '../../../..')
const build = process.argv[2] ?? 'build-02'
assert.match(build, /^build-\d+$/)
const receiptDirectory = path.resolve(perf, '../main', build)
const destination = path.join(perf, 'frozen', `stage67-${build}`)
const source = path.join(destination, 'source')
const read = name => JSON.parse(fs.readFileSync(path.join(receiptDirectory, name), 'utf8'))
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const inputs = read('source-after.json'), artifacts = read('artifacts.json'), receipt = read('receipt.json')
assert.deepEqual(inputs, read('source-before.json'))
assert.equal(receipt.status, 'passed')
assert.equal(receipt.sourceUnchanged, true)
assert.equal(receipt.inputCount, Object.keys(inputs).length)
function verify(base, hashes) {
  for (const [file, hash] of Object.entries(hashes)) {
    assert(!path.isAbsolute(file) && !file.split('/').includes('..'))
    assert.equal(sha(path.join(base, file)), hash, `Changed: ${base}/${file}`)
  }
}
verify(root, inputs)
verify(root, artifacts)
assert(!fs.existsSync(destination), 'Never overwrite a frozen candidate')
fs.mkdirSync(source, { recursive: true })
const baseCommit = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
execFileSync('git', ['-C', root, 'archive', '--format=tar', '--output', path.join(destination, 'source.tar'), baseCommit])
execFileSync('tar', ['-xf', path.join(destination, 'source.tar'), '-C', source])
for (const file of Object.keys(inputs)) {
  fs.mkdirSync(path.dirname(path.join(source, file)), { recursive: true })
  fs.copyFileSync(path.join(root, file), path.join(source, file))
}
for (const folder of ['dist', 'dist-server', 'public/pdf']) {
  assert(!fs.existsSync(path.join(source, folder)))
  fs.mkdirSync(path.dirname(path.join(source, folder)), { recursive: true })
  execFileSync('cp', ['-cR', path.join(root, folder), path.join(source, folder)])
}
fs.symlinkSync(path.join(root, 'node_modules'), path.join(source, 'node_modules'), 'dir')
verify(root, inputs)
verify(root, artifacts)
verify(source, inputs)
verify(source, artifacts)
const tests = Object.fromEntries([
  'tests/fixtures/globe-responsiveness.ts', 'tests/e2e/helpers/globe-responsiveness.ts',
  'tests/e2e/globe-responsiveness.spec.ts', 'tests/unit/globe-summary.test.ts',
].map(file => [file, sha(path.join(source, file))]))
verify(root, tests)
fs.writeFileSync(path.join(destination, 'manifest.json'), JSON.stringify({
  kind: 'receipt-verified-stage67-candidate', baseCommit, source, buildReceipt: receipt,
  receiptDirectory, inputs, artifacts, tests, frozenAt: new Date().toISOString(),
  eligibleForAggregateTiming: true,
  timingAuthorization: 'Separate main-issued CPU window still required; this flag only confirms source/build pairing.',
}, null, 2) + '\n')
console.log(JSON.stringify({ source, inputs: Object.keys(inputs).length, artifacts: Object.keys(artifacts).length, tests: Object.keys(tests).length, buildFinishedAt: receipt.finishedAt, rootDistWritten: false }))
