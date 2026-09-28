import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import { brotliCompressSync, brotliDecompressSync, constants } from 'node:zlib'
import { pathToFileURL } from 'node:url'
import { perf, oracle, sha, readFreeze, auditFreeze } from './protocol.mjs'

const before = readFreeze('stage66-34df6ee')
auditFreeze(before)
const input = path.join(perf, 'actual-frozen/catalog.json')
const bytes = fs.readFileSync(input)
assert.equal(bytes.length, oracle.catalogBytes)
assert.equal(sha(bytes), oracle.catalogSha256)
const catalog = JSON.parse(bytes)
for (const field of ['fetchedAt', 'checkedAt', 'refreshAfter']) assert.equal(catalog[field], oracle[field])
assert.equal(catalog.source, 'public')
assert.equal(catalog.jobs.length, 6756)
assert.equal(catalog.companies.length, 124)
assert.equal(catalog.cities.length, 22)
assert.equal(new Set(catalog.jobs.map(job => job.id)).size, 6756)
const companyIds = new Set(catalog.companies.map(company => company.id))
const cityIds = new Set(catalog.cities.map(city => city.id))
for (const job of catalog.jobs) {
  assert(companyIds.has(job.companyId))
  assert(job.cityIds.every(id => cityIds.has(id)))
  assert(job.id.startsWith(`${job.source}-${job.companyId}-`))
}
for (const landmark of oracle.landmarks) {
  const found = catalog.jobs.filter(job => job.id === landmark.id)
  assert.equal(found.length, 1)
  for (const field of ['id', 'title', 'companyId', 'cityIds', 'locationLabel', 'url', 'source', 'fetchedAt'])
    assert.deepEqual(found[0][field], landmark[field], `${landmark.id}.${field}`)
  assert.equal(catalog.companies.find(company => company.id === landmark.companyId).name, landmark.companyName)
}
const { publicProtocolJob, PUBLIC_PROTOCOL_COMPANIES } = await import(pathToFileURL(path.join(before.source, 'tests/fixtures/public-protocol.ts')))
const { PUBLIC_TEST_CITIES } = await import(pathToFileURL(path.join(before.source, 'tests/fixtures/public-geography.ts')))
const company = structuredClone(PUBLIC_PROTOCOL_COMPANIES[0])
const bootstrap = {
  source: 'public', fetchedAt: oracle.fixedNow, checkedAt: oracle.fixedNow,
  // Deliberately immediately refreshable. This is authored bootstrap data only.
  refreshAfter: oracle.refreshAfter, stale: false, unmappedCount: 0,
  companies: [company], cities: structuredClone(PUBLIC_TEST_CITIES),
  jobs: [
    publicProtocolJob('performance-bootstrap-london', {
      title: 'Backend Engineer — Synthetic Arrival Bootstrap London', fetchedAt: oracle.fixedNow,
    }),
    publicProtocolJob('performance-bootstrap-amsterdam', {
      title: 'Backend Engineer — Synthetic Arrival Bootstrap Amsterdam',
      cityIds: ['amsterdam'], locationLabel: 'Amsterdam, Netherlands', fetchedAt: oracle.fixedNow,
    }),
  ],
  boards: [{
    companyId: company.id, provider: 'greenhouse', board: company.board, status: 'ok',
    dataStatus: 'fresh', total: 2, included: 2, lastSuccessAt: oracle.fixedNow, checkedAt: oracle.fixedNow,
  }],
}
const directory = path.join(perf, 'prepared-fixtures')
fs.mkdirSync(directory, { recursive: true })
const writeStable = (name, data) => {
  const file = path.join(directory, name)
  if (fs.existsSync(file)) assert.equal(sha(fs.readFileSync(file)), sha(data), `Refusing to overwrite changed fixture: ${name}`)
  else fs.writeFileSync(file, data)
}
const compressed = brotliCompressSync(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: 4 } })
assert.equal(sha(brotliDecompressSync(compressed)), oracle.catalogSha256)
writeStable('actual.br', compressed)
writeStable('bootstrap.json', JSON.stringify(bootstrap))
writeStable('observations.json', JSON.stringify({
  version: 1, retentionDays: 90, storage: 'ok', days: [], otherSeries: [],
  method: 'observations-1.occupation-6.roles-1.qualifications-1.remote-2.employment-1.purpose-1',
  scope: { key: '1'.repeat(64), boards: [{ companyId: company.id, name: company.name, provider: 'greenhouse', board: company.board }] },
}))
const result = {
  checkedAt: new Date().toISOString(), input, defaultCacheRead: false, upstreamCalls: 0,
  actualSha256: oracle.catalogSha256, decodedBytes: bytes.length,
  wireSha256: sha(compressed), wireBytes: compressed.length, encoding: 'br', quality: 4,
  timestampsPreserved: true, literalLandmarksPassed: oracle.landmarks.length,
  companies: 124, jobs: 6756, uniqueJobIds: 6756, cities: 22,
  bootstrap: { companies: 1, jobs: 2, londonCompanies: 1, londonJobs: 1, amsterdamCompanies: 1, amsterdamJobs: 1 },
  observationResponse: 'Authored empty history; no actual observation/cache file accessed.',
}
fs.writeFileSync(path.join(directory, 'receipt.json'), JSON.stringify(result, null, 2) + '\n')
console.log(JSON.stringify(result))
