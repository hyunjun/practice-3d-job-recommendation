import fs from 'node:fs/promises'
import path from 'node:path'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { perf, root, sha } from './protocol.mjs'

const qa68 = path.join(root, '.local/research/68-catalog-presentation')
const receiptDirectory = path.join(qa68, 'main/root-build-01')
const destination = path.join(perf, 'frozen/stage68-root-build-01')
const source = path.join(destination, 'source')
const read = async file => JSON.parse(await fs.readFile(path.join(receiptDirectory, file), 'utf8'))
const [receipt, before, inputs, artifacts, existing] = await Promise.all([
  read('receipt.json'), read('source-before.json'), read('source-after.json'), read('artifacts.json'),
  fs.readFile(path.join(qa68, 'frozen/build-01/manifest.json'), 'utf8').then(JSON.parse),
])
assert.deepEqual(before, inputs)
assert.equal(receipt.status, 'passed')
assert.equal(receipt.exitCode, 0)
assert.deepEqual(receipt.changed, [])
assert.deepEqual(receipt.artifactDifferences, [])
assert.equal(receipt.inputCount, 121)
assert.equal(receipt.artifactCount, 361)
assert.deepEqual(inputs, existing.inputs)
assert.deepEqual(artifacts, existing.artifacts)
const verify = async base => {
  const results = await Promise.allSettled(Object.entries({ ...inputs, ...artifacts }).map(async ([file, expected]) => {
    assert(!path.isAbsolute(file) && !file.split('/').includes('..'))
    assert.equal(sha(await fs.readFile(path.join(base, file))), expected, path.join(base, file))
  }))
  for (const result of results) if (result.status === 'rejected') throw result.reason
}
await verify(root)
await verify(existing.source)
await fs.mkdir(destination)
// Reuse the already verified local COW freeze, never the live root/worktree.
// No second artifact/data copy is needed on the shared disk.
await fs.symlink(existing.source, source)
await verify(source)
const tests = {}
for (const file of [
  'tests/fixtures/globe-responsiveness.ts', 'tests/e2e/helpers/globe-responsiveness.ts',
  'tests/e2e/globe-responsiveness.spec.ts', 'tests/unit/globe-summary.test.ts',
]) {
  tests[file] = sha(await fs.readFile(path.join(source, file)))
  assert.equal(tests[file], sha(await fs.readFile(path.join(root, file))), file)
}
for (const file of ['receipt.json', 'source-before.json', 'source-after.json', 'artifacts.json'])
  await fs.copyFile(path.join(receiptDirectory, file), path.join(destination, file), fs.constants.COPYFILE_EXCL)
const baseCommit = (await promisify(execFile)('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim()
const manifest = {
  kind: 'receipt-verified-stage68-candidate', source, reusedLocalCowSource: existing.source,
  rootBuildByteIdenticalToIsolatedBuild01: true, baseCommit,
  buildReceipt: receipt, receiptDirectory, inputs, artifacts, tests,
  frozenAt: new Date().toISOString(), eligibleForAggregateTiming: true,
  timingAuthorization: 'Only source/build pairing is approved here. Functional owners must finish and Main must explicitly open the quiet CPU window before any browser qualification or timing.',
  functionalStatusAtFreeze: 'Dedicated DEV17 passed; root types and all1992 units passed. Existing DEV/PROD and final authorized revalidation fixture runs remain in progress.',
}
const manifestText = JSON.stringify(manifest, null, 2) + '\n'
await fs.writeFile(path.join(destination, 'manifest.json'), manifestText, { flag: 'wx' })
await verify(root)
await verify(source)
console.log(JSON.stringify({
  source, reusedLocalCowSource: existing.source, inputs: Object.keys(inputs).length,
  artifacts: Object.keys(artifacts).length, manifestSha256: sha(manifestText),
  rootBuildFinishedAt: receipt.finishedAt, rootDistWritten: false,
  copiedActualData: false, browserStarted: false, nativeMeasurements: 0,
}, null, 2))
