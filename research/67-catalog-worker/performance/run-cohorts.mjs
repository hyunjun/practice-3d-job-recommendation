import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { perf, root, requireWindow, shaFile } from './protocol.mjs'

const windowAcknowledgement = requireWindow()
const [phase] = process.argv.slice(2)
const plans = {
  'qualification-rest': [
    ['5891', 'refresh', 'qualify68-refresh-01'],
    ['5890', 'refresh', 'qualify66-refresh-01'],
    ['5890', 'cold', 'qualify66-cold-03'],
  ],
  'actual-native': [
    ['5890', 'cold', 'before66-actual-cold-01'],
    ['5891', 'cold', 'after68-actual-cold-01'],
    ['5891', 'refresh', 'after68-actual-refresh-01'],
    ['5890', 'refresh', 'before66-actual-refresh-01'],
  ],
  'synthetic-native': [
    ['5890', 'synthetic', 'before66-synthetic-v1-01'],
    ['5891', 'synthetic', 'after68-synthetic-v1-01'],
  ],
}
assert(Object.hasOwn(plans, phase))
const purpose = phase === 'qualification-rest' ? 'qualification' : 'native'
const file = path.join(perf, `${phase}-execution.jsonl`)
const fd = fs.openSync(file, 'wx')
const harnessFiles = ['measure-actual.mjs', 'actual-recorder.js', 'measure-synthetic-v1.ts',
  'protocol.mjs', 'response-gate.mjs', 'actual-landmarks.json', 'server.mjs']
const hashes = () => Object.fromEntries(harnessFiles.map(file => [file, shaFile(path.join(perf, file))]))
const frozenHashes = hashes()
const record = event => fs.writeSync(fd, JSON.stringify({ at: new Date().toISOString(), ...event }) + '\n')
record({ type: 'phase-start', phase, purpose, windowAcknowledgement, harness: frozenHashes, plan: plans[phase] })
try {
  for (const [port, scenario, label] of plans[phase]) {
    assert.deepEqual(hashes(), frozenHashes, 'The cohort harness must remain fixed')
    const args = scenario === 'synthetic'
      ? ['--import', 'tsx', path.join(perf, 'measure-synthetic-v1.ts')]
      : [path.join(perf, 'measure-actual.mjs')]
    const env = {
      ...process.env, GLOBE_QA_ORIGIN: `http://127.0.0.1:${port}`,
      GLOBE_QA_PURPOSE: purpose, GLOBE_QA_SCENARIO: scenario, GLOBE_QA_LABEL: label,
      GLOBE_QA_RUNS: purpose === 'native' ? '5' : '1',
      GLOBE_QA_PROFILE: '0', GLOBE_QA_THROTTLE: '1',
    }
    const log = fs.createWriteStream(path.join(perf, `${label}.log`), { flags: 'wx' })
    record({ type: 'cohort-start', label, scenario, port, executable: process.execPath, args })
    console.log(JSON.stringify({ started: label, scenario, purpose, runs: purpose === 'native' ? 5 : 1 }))
    const child = spawn(process.execPath, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] })
    for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => {
      log.write(chunk)
      process.stdout.write(chunk)
    })
    const exitCode = await new Promise(resolve => child.once('exit', resolve))
    await new Promise(resolve => log.end(resolve))
    record({ type: 'cohort-end', label, exitCode })
    assert.equal(exitCode, 0, `Preserved failed ${label}; subsequent cohorts have not run`)
    assert.deepEqual(hashes(), frozenHashes, 'The cohort harness changed during execution')
    const summary = JSON.parse(fs.readFileSync(path.join(perf, 'runs', label, 'summary.json'), 'utf8'))
    assert.equal(summary.complete, true, label)
    assert.equal(summary.runs.length, purpose === 'native' ? 5 : 1, label)
  }
  record({ type: 'phase-complete', phase, harnessUnchanged: true })
} finally {
  fs.closeSync(fd)
}
