import { expect, test } from '@playwright/test'
import { buildPublication } from '../../server/publication-build'
import type { BuiltPublication } from '../../server/publication-build'
import type { CatalogPublicationCapture } from '../../server/catalog-service'
import { FICTIONAL_COMMIT, GENERATION_FOUR, GENERATION_ONE, publicationHarness, stamp82 } from '../fixtures/publication'
import { finalizeCase } from './helpers/instrumentation'
import {
  addBallast, authorized, contractClient, dispatchAlarm, dropBallast, freezeClock, HttpObservation, jsonBody, rawRequest, removePhantomPayload, setPhantomPayload, wipeStore,
} from './helpers/worker-http'
import type { RawResponse } from './helpers/worker-http'

/**
 * Stage82 storage admission at the literal limits (MCAP82-6, ACR82-6/7/8, design
 * §인증과 한도): the product refuses a publication when the recorded payload
 * would exceed 512 MiB or when the actual SQLite database size plus the new
 * bytes and the manifest would exceed 900 MiB. Both checks run against the real
 * SQLite counters the product reads, through the reviewed test-only seams of
 * tests/cloudflare/runtime/entry.ts:
 *
 * - payload: a phantom generation row references one chunk row whose recorded
 *   `size` the product's own `SUM(size)` counter includes. Its body is ONE byte:
 *   this is a counter-boundary witness for the 512 MiB referenced-payload check,
 *   not 512 MiB of physical valid publication. The boundary is asserted at
 *   exactly 512 MiB (admitted) and 512 MiB + 1 (refused) on both the begin and
 *   the upload path. The phantom is owned from its attempted creation and
 *   removed in unconditional finalization, with the removal verified;
 * - database: zero-filled ballast rows grow the real database file. After the
 *   admitted begin, the stage is expired through the inherited alarm body and
 *   its deletion verified, the size is re-measured and ballast refilled as
 *   needed, and only then is the refusal requested. Admitted and refused sizes
 *   bracket the 900 MiB boundary; no monotonic size across deletion is assumed.
 *
 * Product caps and public errors are unchanged; the literals below are the
 * design's numbers, not imports from the product. Evidence, size stages and
 * cleanup outcomes are attached even when an assertion fails.
 */
const KiB = 1024
const MiB = 1024 * 1024
const PAYLOAD_LIMIT = 512 * MiB
const DATABASE_LIMIT = 900 * MiB
const IDLE_MS = 15 * 60_000
const T0 = Date.parse(stamp82('06:35:00.000'))
const iso = (ms: number) => new Date(ms).toISOString()
const LIMIT_ERROR = { error: '발행 자료의 크기 한도를 초과했습니다.', code: 'PUBLISH_LIMIT' }
let capture: CatalogPublicationCapture
test.beforeAll(async () => { capture = (await publicationHarness().run()).capture })

const beginRaw = (origin: string, text: string) => rawRequest(origin, '/__orbit/publish/begin', {
  method: 'POST', headers: authorized({ 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) }), body: text,
})
const putChunkRaw = (origin: string, generation: string, index: number, bytes: Uint8Array) => rawRequest(origin, `/__orbit/publish/chunks/${generation}/${index}`, {
  method: 'PUT', headers: authorized({ 'Content-Type': 'application/octet-stream', 'Content-Length': bytes.byteLength }), body: Buffer.from(bytes),
})
const commitRaw = (origin: string, body: unknown) => rawRequest(origin, '/__orbit/publish/commit', {
  method: 'POST', headers: authorized({ 'Content-Type': 'application/json' }), body: JSON.stringify(body),
})
const metricsOf = (origin: string) => contractClient(origin).metrics()
const chunkBytes = (built: BuiltPublication) => built.manifest.chunks.reduce((sum, chunk) => sum + chunk.bytes, 0)
function expectRefused(response: RawResponse) {
  expect(response.status).toBe(413)
  expect(response.headers['cache-control']).toBe('no-store')
  expect(jsonBody(response)).toEqual(LIMIT_ERROR)
}
function expectBegun(response: RawResponse) {
  expect(response.status).toBe(200)
  expect(jsonBody(response)).toEqual({ committed: false, generation: GENERATION_ONE })
}

test('payload admission refuses at 512 MiB + 1 byte and admits at exactly 512 MiB on both the begin and the upload path (one-byte phantom counter boundary)', async ({ baseURL }, info) => {
  const origin = baseURL!
  const phantom = GENERATION_FOUR
  const evidence: Record<string, unknown> = { payloadLimit: PAYLOAD_LIMIT, phantomOwner: phantom, phantomNote: 'one-byte body with a recorded size: a referenced-payload counter boundary, not 512 MiB of physical publication', steps: [] as unknown[] }
  const httpObservation = new HttpObservation(info.testId)
  evidence.httpObservation = httpObservation.evidence
  const steps = evidence.steps as unknown[]
  const owned = { phantomAttempted: false }
  let primary: { error: unknown } | null = null
  let total = 0
  try {
    await wipeStore(origin, httpObservation.scope('store-reset', 'admission-prepare'))
    await freezeClock(origin, iso(T0))
    const built = buildPublication(capture, FICTIONAL_COMMIT, null, GENERATION_ONE)
    total = chunkBytes(built)
    expect(total).toBe(built.chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0))
    const firstChunk = built.manifest.chunks[0].bytes
    evidence.publication = { totalChunkBytes: total, firstChunkBytes: firstChunk, chunks: built.chunks.length }
    // Begin: one byte over the cap is refused before any stage exists; exactly the cap is admitted.
    owned.phantomAttempted = true
    const over = await setPhantomPayload(origin, phantom, PAYLOAD_LIMIT - total + 1)
    steps.push({ step: 'phantom-over-by-one', payloadBytes: over.payloadBytes })
    expect(over.payloadBytes).toBe(PAYLOAD_LIMIT - total + 1)
    expectRefused(await beginRaw(origin, built.manifestText))
    expect(await metricsOf(origin)).toMatchObject({ staging: null, payloadBytes: PAYLOAD_LIMIT - total + 1, chunks: 1, generations: 1 })
    const exact = await setPhantomPayload(origin, phantom, PAYLOAD_LIMIT - total)
    steps.push({ step: 'phantom-exact', payloadBytes: exact.payloadBytes })
    expect(exact.payloadBytes).toBe(PAYLOAD_LIMIT - total)
    expectBegun(await beginRaw(origin, built.manifestText))
    expect((await metricsOf(origin)).staging).toBe(GENERATION_ONE)
    // Upload: the same strict comparison applies to the actual chunk bytes; a refused upload leaves the stage untouched.
    await setPhantomPayload(origin, phantom, PAYLOAD_LIMIT - firstChunk + 1)
    steps.push({ step: 'phantom-upload-over-by-one', payloadBytes: PAYLOAD_LIMIT - firstChunk + 1 })
    expectRefused(await putChunkRaw(origin, GENERATION_ONE, 0, built.chunks[0]))
    expect(await metricsOf(origin)).toMatchObject({ staging: GENERATION_ONE, chunks: 1, payloadBytes: PAYLOAD_LIMIT - firstChunk + 1 })
    await setPhantomPayload(origin, phantom, PAYLOAD_LIMIT - firstChunk)
    steps.push({ step: 'phantom-upload-exact', payloadBytes: PAYLOAD_LIMIT - firstChunk })
    expect((await putChunkRaw(origin, GENERATION_ONE, 0, built.chunks[0])).status).toBe(200)
    expect((await metricsOf(origin)).payloadBytes).toBe(PAYLOAD_LIMIT)
    // The remaining chunks end exactly at the cap as well.
    await setPhantomPayload(origin, phantom, PAYLOAD_LIMIT - total)
    for (const [index, chunk] of built.chunks.entries()) {
      expect((await putChunkRaw(origin, GENERATION_ONE, index, chunk)).status, `chunk ${index}`).toBe(200)
    }
    const full = await metricsOf(origin)
    steps.push({ step: 'all-chunks-uploaded', metrics: full })
    expect(full).toMatchObject({ payloadBytes: PAYLOAD_LIMIT, chunks: 1 + built.chunks.length, staging: GENERATION_ONE })
    const committed = await commitRaw(origin, { generation: GENERATION_ONE })
    expect(committed.status).toBe(200)
    expect(jsonBody(committed)).toMatchObject({ head: { revision: 1, generation: GENERATION_ONE } })
    const served = await rawRequest(origin, '/api/catalog')
    expect(served.status).toBe(200)
    expect(served.headers['x-orbit-generation']).toBe(GENERATION_ONE)
  } catch (error) {
    primary = { error }
  }
  await finalizeCase(info, 'payload-admission', evidence, primary, [
    { label: 'remove-phantom', run: async () => {
      if (!owned.phantomAttempted) return 'never created'
      const removed = await removePhantomPayload(origin, phantom)
      if (removed.removed.chunks !== 1 || removed.removed.generations !== 1) throw new Error(`phantom removal removed ${JSON.stringify(removed.removed)}, expected one chunk and one generation row`)
      // After removal the counter holds only the real uploaded chunks (all of them on success, a prefix after an early failure), never the phantom size.
      const metrics = await metricsOf(origin)
      if (metrics.payloadBytes > total) throw new Error(`payload counter after phantom removal is ${metrics.payloadBytes}, above the real publication's ${total}`)
      return { removed: removed.removed, payloadBytes: metrics.payloadBytes, generations: metrics.generations, chunks: metrics.chunks }
    } },
    { label: 'http-observation', run: async () => { httpObservation.assertHealthy(); return httpObservation.evidence.observedCounts } },
  ])
})

test('database admission refuses a begin once the real SQLite size plus the publication would exceed 900 MiB, with the stage expired and the size re-measured before the refusal', async ({ baseURL }, info) => {
  test.setTimeout(1_500_000)
  const origin = baseURL!
  const evidence: Record<string, unknown> = { databaseLimit: DATABASE_LIMIT, stages: {} as Record<string, unknown>, ballastSteps: [] as unknown[] }
  const httpObservation = new HttpObservation(info.testId)
  evidence.httpObservation = httpObservation.evidence
  const stages = evidence.stages as Record<string, unknown>
  const ballastSteps = evidence.ballastSteps as { rows: number; bytesPerRow: number; databaseSize: number }[]
  let ballastAttempted = false
  let primary: { error: unknown } | null = null
  try {
    await wipeStore(origin, httpObservation.scope('store-reset', 'admission-prepare'))
    await freezeClock(origin, iso(T0))
    const built = buildPublication(capture, FICTIONAL_COMMIT, null, GENERATION_ONE)
    const bytes = chunkBytes(built)
    // The Worker measures the manifest text it was sent (re-serialised after parsing with the same keys and values); the sent byte length is that number.
    const metadataBytes = Buffer.byteLength(built.manifestText)
    const headroom = DATABASE_LIMIT - bytes - metadataBytes
    evidence.publication = { chunkBytes: bytes, metadataBytes, headroom }
    let size = (await metricsOf(origin)).databaseBytes
    stages.initial = size
    const grow = async (rows: number, bytesPerRow: number) => {
      ballastAttempted = true
      const result = await addBallast(origin, rows, bytesPerRow)
      size = result.databaseSize
      ballastSteps.push({ rows, bytesPerRow, databaseSize: size })
    }
    while (size + 66 * MiB <= headroom) await grow(64, MiB)
    while (size + 2 * MiB <= headroom) await grow(1, MiB)
    while (size + 128 * KiB <= headroom) await grow(1, 64 * KiB)
    const admittedSize = size
    stages.admittedSize = admittedSize
    expect(admittedSize + bytes + metadataBytes).toBeLessThanOrEqual(DATABASE_LIMIT)
    expect((await metricsOf(origin)).databaseBytes).toBe(admittedSize)
    expectBegun(await beginRaw(origin, built.manifestText))
    const afterAdmit = await metricsOf(origin)
    stages.afterAdmittedBegin = afterAdmit.databaseBytes
    expect(afterAdmit.staging).toBe(GENERATION_ONE)
    // Expire the stage through the inherited alarm body at exactly the idle deadline and verify its deletion (ACR82-6).
    await freezeClock(origin, iso(T0 + IDLE_MS))
    const dispatched = await dispatchAlarm(origin)
    expect(dispatched.error).toBeNull()
    const afterExpiry = await metricsOf(origin)
    stages.afterStageExpiry = afterExpiry.databaseBytes
    expect(afterExpiry.staging).toBeNull()
    // Re-measure the real size after the deletion (no assumption about whether SQLite reclaimed space), then refill in 64 KiB steps until the next begin must be refused.
    size = afterExpiry.databaseBytes
    while (size + bytes + metadataBytes <= DATABASE_LIMIT) await grow(1, 64 * KiB)
    const refusedSize = size
    stages.refusedSize = refusedSize
    expect(refusedSize + bytes + metadataBytes).toBeGreaterThan(DATABASE_LIMIT)
    expectRefused(await beginRaw(origin, built.manifestText))
    const atRefusal = await metricsOf(origin)
    stages.atRefusal = atRefusal.databaseBytes
    expect(atRefusal.staging).toBeNull()
    const window = refusedSize - admittedSize
    evidence.bracket = { admittedSize, refusedSize, windowBytes: window, note: 'the admitted begin and the refused begin bracket the literal 900 MiB check on the real SQLite size; the exact > comparison is proven byte-exactly on the payload path' }
    expect(window).toBeLessThanOrEqual(metadataBytes + 512 * KiB + Math.max(0, admittedSize - afterExpiry.databaseBytes))
  } catch (error) {
    primary = { error }
  }
  await finalizeCase(info, 'database-admission', evidence, primary, [
    { label: 'drop-ballast', run: async () => { if (!ballastAttempted) return 'never created'; const dropped = await dropBallast(origin); return dropped } },
    { label: 'http-observation', run: async () => { httpObservation.assertHealthy(); return httpObservation.evidence.observedCounts } },
  ])
})
