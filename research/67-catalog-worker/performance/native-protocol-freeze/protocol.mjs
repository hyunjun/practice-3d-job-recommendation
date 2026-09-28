import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'

export const perf = path.dirname(fileURLToPath(import.meta.url))
export const root = path.resolve(perf, '../../../..')
export const oracle = JSON.parse(fs.readFileSync(path.join(perf, 'actual-landmarks.json'), 'utf8'))
export const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex')
export const shaFile = file => sha(fs.readFileSync(file))
export const sleep = ms => new Promise(resolve => setTimeout(resolve, Math.max(0, ms)))
export const quantile = (values, p) => {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)] ?? null
}
export const profile = {
  kind: 'personal', name: 'Globe QA', headline: 'Synthetic engineering profile',
  years: 5, skills: ['TypeScript', 'Python', 'PostgreSQL', 'AWS'],
  desiredRole: 'all', residence: 'GB', linkedinUrl: '',
}
export const filters = {
  query: '', region: 'all', role: 'all', workMode: 'all', visa: 'all',
  employment: 'all', postingType: 'opening', salaryMin: 0,
  includeUnknownSalary: true, remoteEligibleOnly: true,
}
export function requireWindow() {
  const acknowledgement = process.env.GLOBE_QA_WINDOW
  assert(acknowledgement?.trim(), 'CPU window CLOSED: set GLOBE_QA_WINDOW only after main explicitly grants this measurement window.')
  return acknowledgement
}
export function readFreeze(name) {
  assert.match(name, /^stage(?:66|67|68)-[a-zA-Z0-9-]+$/)
  const manifestPath = path.join(perf, 'frozen', name, 'manifest.json')
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  assert(manifest.kind === 'exact-stage66-baseline' || manifest.eligibleForAggregateTiming === true,
    'Provisional source/build pairs cannot be used for timing')
  const source = path.join(perf, 'frozen', name, 'source')
  assert.equal(path.resolve(manifest.source), source)
  return { name, source, manifest, manifestPath, manifestSha256: shaFile(manifestPath) }
}
export function auditFreeze(freeze) {
  const tests = Array.isArray(freeze.manifest.tests)
    ? Object.fromEntries(freeze.manifest.tests.map(test => [test.file, test.sha256]))
    : freeze.manifest.tests
  for (const [file, hash] of Object.entries({ ...freeze.manifest.inputs, ...freeze.manifest.artifacts, ...tests }))
    assert.equal(shaFile(path.join(freeze.source, file)), hash, `Frozen file changed: ${file}`)
}
export function assertOwnedOrigin(origin) {
  const url = new URL(origin)
  assert.equal(url.protocol, 'http:')
  assert.equal(url.hostname, '127.0.0.1')
  assert(['5890', '5891', '5892', '5893'].includes(url.port), 'Only dedicated owned performance ports are permitted')
  return url
}
