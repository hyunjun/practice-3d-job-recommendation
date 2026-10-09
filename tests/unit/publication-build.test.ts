import { afterEach, describe, expect, it, vi } from 'vitest'
import { gunzipSync } from 'node:zlib'
import { buildPublication } from '../../server/publication-build'
import type { BuiltPublication } from '../../server/publication-build'
import { restorePublicationCheckpoint } from '../../server/publication-collector'
import type { CatalogPublicationCapture } from '../../server/catalog-service'
import { CITIES } from '../../shared/cities'
import { OBSERVATION_METHOD } from '../../shared/catalog-observations'
import { GENERATION_PATTERN, parsePublicationManifest, PUBLICATION_LIMITS } from '../../shared/publication'
import type { PublicationManifest } from '../../shared/publication'
import { PROVENANCE_ALDER, PROVENANCE_BIRCH, PROVENANCE_CEDAR_DAILY } from '../fixtures/board-status-provenance'
import {
  checkpointFrom, compressedFragment, decodedFragment, decodedJson, deterministicText, FICTIONAL_COMMIT,
  GENERATION_ONE, GENERATION_TWO, packedBytes, privateFiles, PUBLICATION_FAILURES, publicationHarness, RUN_ONE, sha256, stamp82,
} from '../fixtures/publication'
import type { PublicationGeneration } from '../fixtures/publication'

/**
 * Stage82 common design v2 (docs/design/cloudflare-deployment.md, 8f9af5db…):
 * Node validates the captured state strictly, packs independent gzip fragments
 * into 1 MiB chunks with exact ranges and hashes, and the private checkpoint is
 * restorable only against its original registry. Hashes, sizes and decoded
 * values below are recomputed independently from the emitted bytes.
 */
const ALDER = 'provenance-alder'
const BIRCH = 'provenance-birch'
const CEDAR = 'provenance-cedar'
const ALDER_JOB = 'greenhouse-provenance-alder-7401'
const T = stamp82
const HEX64 = /^[a-f0-9]{64}$/
const CHUNK = 1024 * 1024
const alder = { companyId: ALDER, board: 'AlderProvenance74', provider: 'greenhouse' } as const
const birch = { companyId: BIRCH, board: 'BirchProvenance74', provider: 'smartrecruiters' } as const

afterEach(() => { vi.restoreAllMocks() })

// ANT82-1: the generation keeps the builder's UUID template type; a bare default would widen to string.
const build = (capture: CatalogPublicationCapture, generation: PublicationGeneration = GENERATION_ONE, parent: Parameters<typeof buildPublication>[2] = null) =>
  buildPublication(capture, FICTIONAL_COMMIT, parent, generation)
/** Chunk indexes a fragment must touch, computed from its range alone. */
const touchedChunks = (offset: number, length: number) => {
  const first = Math.floor(offset / CHUNK)
  const last = Math.floor((offset + length - 1) / CHUNK)
  return Array.from({ length: last - first + 1 }, (_, index) => first + index)
}
const cloneManifest = (built: BuiltPublication) => JSON.parse(built.manifestText) as PublicationManifest
const expectInvalid = (manifest: unknown) => expect(() => parsePublicationManifest(manifest)).toThrow('Invalid publication manifest relationships')

/** Every fragment's bytes, hashes and chunk coverage must agree with the emitted chunks. */
function expectConsistentPacking(built: BuiltPublication) {
  const { manifest, chunks } = built
  const packed = packedBytes(built)
  const total = Object.values(manifest.fragments).reduce((sum, fragment) => sum + fragment.compressedBytes, 0)
  expect(packed.length).toBe(total)
  expect(manifest.chunks.map(chunk => chunk.bytes)).toEqual(chunks.map(chunk => chunk.length))
  expect(manifest.chunks.map(chunk => chunk.hash)).toEqual(chunks.map(chunk => sha256(chunk)))
  expect(manifest.chunks.map(chunk => [chunk.owner, chunk.index])).toEqual(chunks.map((_, index) => [manifest.generation, index]))
  expect(chunks.length).toBe(Math.ceil(total / CHUNK))
  for (const [index, chunk] of chunks.entries()) {
    expect(chunk.length).toBeGreaterThan(0)
    expect(chunk.length).toBeLessThanOrEqual(CHUNK)
    if (index < chunks.length - 1) expect(chunk.length).toBe(CHUNK)
  }
  const ordered = Object.entries(manifest.fragments).sort(([, left], [, right]) => left.offset - right.offset)
  let expectedOffset = 0
  for (const [name, fragment] of ordered) {
    expect(fragment.owner).toBe(manifest.generation)
    expect(fragment.offset).toBe(expectedOffset)
    expectedOffset += fragment.compressedBytes
    const compressed = compressedFragment(built, name)
    expect(compressed.length).toBe(fragment.compressedBytes)
    expect(sha256(compressed)).toBe(fragment.compressedHash)
    const decoded = gunzipSync(compressed)
    expect(decoded.length).toBe(fragment.decodedBytes)
    expect(sha256(decoded)).toBe(fragment.decodedHash)
    expect(touchedChunks(fragment.offset, fragment.compressedBytes).every(index => index < chunks.length)).toBe(true)
  }
  expect(expectedOffset).toBe(total)
  expect(Buffer.byteLength(built.manifestText)).toBeLessThanOrEqual(PUBLICATION_LIMITS.manifest)
  expect(JSON.parse(built.manifestText)).toEqual(manifest)
  expect(parsePublicationManifest(JSON.parse(built.manifestText))).toEqual(manifest)
}

describe('a publication built from a complete first run', () => {
  it('records the capture context, per-board projection metadata and private checkpoint once each', async () => {
    const h = publicationHarness()
    const { capture } = await h.run()
    const built = build(capture)
    const { manifest } = built
    expect(manifest).toMatchObject({ version: 1, generation: GENERATION_ONE, parent: null })
    expect(manifest.capture).toEqual({
      capturedAt: RUN_ONE, collectorCommit: FICTIONAL_COMMIT, configId: manifest.capture.configId,
      companies: [PROVENANCE_ALDER, PROVENANCE_BIRCH],
    })
    expect(manifest.capture.configId).toMatch(HEX64)
    expect(manifest.checkpoint.capture).toEqual(manifest.capture)
    expect(manifest.catalog.cities).toEqual(CITIES)
    expect(manifest.catalog.checkedAt).toBe(RUN_ONE)
    expect(manifest.catalog.boards).toEqual([
      {
        base: { ...alder, status: 'ok', checkedAt: RUN_ONE, lastSuccessAt: RUN_ONE, retryAt: null },
        eligible: true, initiallyStale: false, fetchedAt: RUN_ONE, freshUntil: T('06:30:00.000'), total: 1, included: 1, unmappedCount: 0,
        fresh: expect.any(String), stale: expect.any(String), contentDeadline: T('06:01:00.000'),
      },
      {
        base: { ...birch, status: 'ok', checkedAt: RUN_ONE, lastSuccessAt: RUN_ONE, retryAt: null },
        eligible: true, initiallyStale: false, fetchedAt: RUN_ONE, freshUntil: T('06:30:00.000'), total: 1, included: 1, unmappedCount: 0,
        fresh: expect.any(String), stale: expect.any(String), contentDeadline: T('06:01:00.000'),
      },
    ])
    expect(manifest.posting.boards).toEqual([
      {
        base: { ...alder, status: 'ok', checkedAt: RUN_ONE, lastSuccessAt: RUN_ONE, retryAt: null },
        checkedAt: RUN_ONE, listingAt: RUN_ONE, bodyFreshUntil: T('06:30:00.000'), listing: expect.any(String), oldBody: expect.any(String),
        inventoryDeadline: T('06:01:00.000'), contentDeadline: T('06:01:00.000'),
      },
      {
        base: { ...birch, status: 'ok', checkedAt: RUN_ONE, lastSuccessAt: RUN_ONE, retryAt: null },
        checkedAt: RUN_ONE, listingAt: RUN_ONE, bodyFreshUntil: T('06:30:00.000'), listing: expect.any(String), oldBody: expect.any(String),
        inventoryDeadline: T('06:01:00.000'), contentDeadline: T('06:01:00.000'),
      },
    ])
    expect(manifest.observations).toEqual({
      scope: capture.history.scope, method: OBSERVATION_METHOD,
      days: [{ day: '2026-10-03', fragment: expect.any(String) }], otherSeries: [],
    })
    // Two catalog variants and two listing variants per board, one day, three private files.
    expect(Object.keys(manifest.fragments)).toHaveLength(12)
    const privateNames = Object.values(manifest.checkpoint.files)
    expect(new Set(privateNames).size).toBe(3)
    for (const [name, fragment] of Object.entries(manifest.fragments)) {
      expect(fragment.visibility).toBe(privateNames.includes(name) ? 'checkpoint' : 'public')
      expect(fragment.compressedBytes).toBeGreaterThanOrEqual(20)
      expect(fragment.compressedHash).toMatch(HEX64)
      expect(fragment.decodedHash).toMatch(HEX64)
    }
    for (const board of manifest.catalog.boards) {
      expect(manifest.fragments[board.fresh!].kind).toBe('items')
      expect(manifest.fragments[board.stale!].kind).toBe('items')
    }
    for (const board of manifest.posting.boards) {
      expect(manifest.fragments[board.listing!].kind).toBe('value')
      expect(manifest.fragments[board.oldBody!].kind).toBe('value')
    }
    expect(manifest.fragments[manifest.observations.days[0].fragment].kind).toBe('value')
    for (const name of privateNames) expect(manifest.fragments[name].kind).toBe('value')
    expect(manifest.chunks).toHaveLength(1)
    expectConsistentPacking(built)
  })

  it('decodes every public fragment back to the captured value with the requested stale flag', async () => {
    const h = publicationHarness()
    const { capture } = await h.run()
    const built = build(capture)
    const { manifest } = built
    for (const [index, board] of manifest.catalog.boards.entries()) {
      const jobs = capture.catalog.jobs.filter(job => job.companyId === capture.catalog.companies[index].id)
      expect(jobs).toHaveLength(1)
      expect(decodedJson(built, board.fresh!)).toEqual(jobs.map(job => ({ ...job, stale: false })))
      expect(decodedJson(built, board.stale!)).toEqual(jobs.map(job => ({ ...job, stale: true })))
    }
    for (const [index, board] of manifest.posting.boards.entries()) {
      const listing = capture.postingStatus.boards[index].listing!
      expect(listing.jobs).toHaveLength(1)
      expect(decodedJson(built, board.listing!)).toEqual(listing)
      expect(decodedJson(built, board.oldBody!)).toEqual({ ...listing, jobs: [] })
    }
    expect(decodedJson(built, manifest.observations.days[0].fragment)).toEqual(capture.history.days[0])
    expect(decodedJson(built, manifest.checkpoint.files.boards)).toEqual({ version: 5, boards: capture.boards })
    expect(decodedJson(built, manifest.checkpoint.files.presence)).toEqual({ version: 1, boards: capture.presences })
    expect(decodedJson(built, manifest.checkpoint.files.observations)).toEqual(capture.observationCheckpoint)
    // The private boards file carries the original job bodies and clocks, not a public projection.
    const privateBoards = decodedJson(built, manifest.checkpoint.files.boards) as { boards: { snapshot: { jobs: { id: string; fetchedAt: string }[] } }[] }
    expect(privateBoards.boards[0].snapshot.jobs.map(job => [job.id, job.fetchedAt])).toEqual([[ALDER_JOB, RUN_ONE]])
  })

  it('restores the private checkpoint losslessly and a run from the restored state neither collects nor changes clocks', async () => {
    const h = publicationHarness()
    const first = await h.run()
    const built = build(first.capture)
    const restored = restorePublicationCheckpoint(built.manifest.checkpoint.capture, privateFiles(built), Date.parse(first.capture.capturedAt))
    expect(restored).toEqual({ boards: first.capture.boards, presence: first.capture.presences, observations: first.capture.observationCheckpoint })
    const fromFiles = await h.run(restored)
    const fromMemory = await h.run(checkpointFrom(first.capture))
    expect(h.listCalls()).toHaveLength(2)
    expect(h.bodyCalls()).toHaveLength(2)
    expect(fromFiles.capture).toEqual(fromMemory.capture)
    expect(fromFiles.capture).toEqual(first.capture)
    // A later generation of the same captured state emits byte-identical fragments under its own owner.
    const again = build(fromFiles.capture, GENERATION_TWO, { revision: 1, generation: GENERATION_ONE, publishedAt: T('06:00:05.000') })
    expect(again.manifest.parent).toEqual({ revision: 1, generation: GENERATION_ONE })
    expect(again.manifest.generation).toBe(GENERATION_TWO)
    expect(Object.keys(again.manifest.fragments).sort()).toEqual(Object.keys(built.manifest.fragments).sort())
    for (const [name, fragment] of Object.entries(again.manifest.fragments)) {
      const original = built.manifest.fragments[name]
      expect([fragment.offset, fragment.compressedBytes, fragment.decodedBytes, fragment.compressedHash, fragment.decodedHash])
        .toEqual([original.offset, original.compressedBytes, original.decodedBytes, original.compressedHash, original.decodedHash])
      expect(fragment.owner).toBe(GENERATION_TWO)
    }
    expect(again.manifest.chunks.map(chunk => [chunk.index, chunk.bytes, chunk.hash]))
      .toEqual(built.manifest.chunks.map(chunk => [chunk.index, chunk.bytes, chunk.hash]))
    expect(again.chunks.map(chunk => Buffer.from(chunk).equals(Buffer.from(built.chunks[0])))).toEqual([true])
    expectConsistentPacking(again)
  })

  it('keeps the original source clocks when the capture happens later than the collection', async () => {
    const h = publicationHarness()
    const first = await h.run()
    h.at(T('06:10:00.000'))
    const second = await h.run(checkpointFrom(first.capture))
    const built = build(second.capture)
    expect(built.manifest.capture.capturedAt).toBe(T('06:10:00.000'))
    expect(built.manifest.catalog.checkedAt).toBe(RUN_ONE)
    expect(built.manifest.catalog.boards.map(board => [board.base.checkedAt, board.base.lastSuccessAt, board.fetchedAt, board.freshUntil, board.contentDeadline]))
      .toEqual([[RUN_ONE, RUN_ONE, RUN_ONE, T('06:30:00.000'), T('06:01:00.000')], [RUN_ONE, RUN_ONE, RUN_ONE, T('06:30:00.000'), T('06:01:00.000')]])
    expect(built.manifest.posting.boards.map(board => [board.checkedAt, board.listingAt, board.bodyFreshUntil, board.inventoryDeadline, board.contentDeadline]))
      .toEqual([[RUN_ONE, RUN_ONE, T('06:30:00.000'), T('06:01:00.000'), T('06:01:00.000')], [RUN_ONE, RUN_ONE, T('06:30:00.000'), T('06:01:00.000'), T('06:01:00.000')]])
    expect(built.manifest.observations.days).toEqual([{ day: '2026-10-03', fragment: expect.any(String) }])
    expect(decodedJson(built, built.manifest.observations.days[0].fragment)).toEqual(first.capture.history.days[0])
  })
})

describe('packing across the chunk boundary', () => {
  it('splits a multi-megabyte publication into full 1 MiB chunks with a fragment spanning the first boundary', async () => {
    const h = publicationHarness()
    h.bulkBody(ALDER, 72, 28000)
    const { capture } = await h.run()
    expect(capture.catalog.boards[0]).toMatchObject({ total: 72, included: 72, dataStatus: 'fresh' })
    const built = build(capture)
    const { manifest } = built
    expect(manifest.chunks.length).toBeGreaterThanOrEqual(2)
    expectConsistentPacking(built)
    const fresh = manifest.fragments[manifest.catalog.boards[0].fresh!]
    expect(fresh.offset).toBe(0)
    expect(fresh.compressedBytes).toBeGreaterThan(CHUNK)
    expect(touchedChunks(fresh.offset, fresh.compressedBytes).length).toBeGreaterThanOrEqual(2)
    const spanning = Object.values(manifest.fragments).filter(fragment => touchedChunks(fragment.offset, fragment.compressedBytes).length > 1)
    expect(spanning.length).toBeGreaterThanOrEqual(1)
    const jobs = decodedJson(built, manifest.catalog.boards[0].fresh!) as { id: string; description: string; stale: boolean }[]
    expect(jobs).toHaveLength(72)
    expect(jobs.map(job => job.id)).toEqual(Array.from({ length: 72 }, (_, index) => `greenhouse-provenance-alder-${7500 + index}`))
    expect(jobs.every((job, index) => job.description === deterministicText(index + 1, 28000) && job.stale === false)).toBe(true)
    const stale = decodedJson(built, manifest.catalog.boards[0].stale!) as { stale: boolean }[]
    expect(stale.every(job => job.stale === true)).toBe(true)
    const restored = restorePublicationCheckpoint(manifest.checkpoint.capture, privateFiles(built), Date.parse(capture.capturedAt))
    expect(restored.boards[0].snapshot?.jobs).toHaveLength(72)
    expect(restored).toEqual({ boards: capture.boards, presence: capture.presences, observations: capture.observationCheckpoint })
    expect(manifest.posting.boards[0].listing).not.toBeNull()
    const listing = decodedJson(built, manifest.posting.boards[0].listing!) as { publishedIds: string[]; jobs: unknown[] }
    expect(listing.publishedIds).toHaveLength(72)
    expect(listing.jobs).toHaveLength(72)
  })
})

describe('degenerate but valid captures', () => {
  it('an empty board publishes empty item fragments, an empty listing and zero counts', async () => {
    const h = publicationHarness()
    h.emptyBody(BIRCH)
    const { capture } = await h.run()
    const built = build(capture)
    const board = built.manifest.catalog.boards[1]
    expect(board).toMatchObject({ eligible: true, initiallyStale: false, fetchedAt: RUN_ONE, total: 0, included: 0, unmappedCount: 0 })
    for (const name of [board.fresh!, board.stale!]) {
      expect(built.manifest.fragments[name]).toMatchObject({ compressedBytes: 20, decodedBytes: 0, kind: 'items' })
      expect(decodedFragment(built, name).length).toBe(0)
      expect(decodedJson(built, name)).toEqual([])
    }
    expect(decodedJson(built, built.manifest.posting.boards[1].listing!)).toEqual({
      validUntil: T('06:30:00.000'), publishedIds: [], jobs: [],
      content: { checkedAt: RUN_ONE, validUntil: T('06:30:00.000'), status: 'ok', jobIds: [] },
    })
    expect(built.manifest.posting.boards[1]).toMatchObject({ listingAt: RUN_ONE, bodyFreshUntil: T('06:30:00.000') })
    expectConsistentPacking(built)
  })

  it('an all-unavailable first run still publishes failure metadata and the private checkpoint without any job fragment', async () => {
    const h = publicationHarness()
    h.failEveryList(PUBLICATION_FAILURES.list)
    const { capture } = await h.run()
    const built = build(capture)
    const { manifest } = built
    expect(manifest.catalog.checkedAt).toBe(RUN_ONE)
    expect(manifest.catalog.boards).toEqual([
      {
        base: { ...alder, status: 'error', checkedAt: RUN_ONE, lastSuccessAt: null, retryAt: T('06:01:00.000'), message: 'Fictional publication list 503' },
        eligible: false, initiallyStale: false, fetchedAt: null, freshUntil: null, total: 0, included: 0, unmappedCount: 0,
        fresh: null, stale: null, contentDeadline: T('06:01:00.000'),
      },
      {
        base: { ...birch, status: 'error', checkedAt: RUN_ONE, lastSuccessAt: null, retryAt: T('06:01:00.000'), message: 'Fictional publication list 503' },
        eligible: false, initiallyStale: false, fetchedAt: null, freshUntil: null, total: 0, included: 0, unmappedCount: 0,
        fresh: null, stale: null, contentDeadline: T('06:01:00.000'),
      },
    ])
    expect(manifest.posting.boards).toEqual([
      {
        base: { ...alder, status: 'error', checkedAt: RUN_ONE, lastSuccessAt: null, retryAt: T('06:01:00.000'), message: 'Fictional publication list 503' },
        checkedAt: RUN_ONE, listingAt: null, bodyFreshUntil: null, listing: null, oldBody: null,
        inventoryDeadline: T('06:01:00.000'), contentDeadline: T('06:01:00.000'),
      },
      {
        base: { ...birch, status: 'error', checkedAt: RUN_ONE, lastSuccessAt: null, retryAt: T('06:01:00.000'), message: 'Fictional publication list 503' },
        checkedAt: RUN_ONE, listingAt: null, bodyFreshUntil: null, listing: null, oldBody: null,
        inventoryDeadline: T('06:01:00.000'), contentDeadline: T('06:01:00.000'),
      },
    ])
    expect(manifest.observations).toMatchObject({ method: OBSERVATION_METHOD, days: [], otherSeries: [] })
    expect(Object.keys(manifest.fragments).sort()).toEqual(Object.values(manifest.checkpoint.files).sort())
    expect(manifest.chunks).toHaveLength(1)
    expect(decodedJson(built, manifest.checkpoint.files.boards)).toEqual({ version: 5, boards: [] })
    expect(decodedJson(built, manifest.checkpoint.files.presence)).toEqual({ version: 1, boards: capture.presences })
    expect(decodedJson(built, manifest.checkpoint.files.observations)).toEqual({ version: 1, series: [] })
    expectConsistentPacking(built)
    expect(restorePublicationCheckpoint(manifest.checkpoint.capture, privateFiles(built), Date.parse(RUN_ONE)))
      .toEqual({ boards: [], presence: capture.presences, observations: { version: 1, series: [] } })
  })

  it('a snapshot already expired at capture is published as metadata only and is never revived as items', async () => {
    const h = publicationHarness({ at: '2026-10-02T05:00:00.000Z' })
    const first = await h.run()
    h.at(RUN_ONE)
    h.failEveryList(PUBLICATION_FAILURES.list)
    const second = await h.run(checkpointFrom(first.capture))
    expect(h.bodyCalls()).toHaveLength(2)
    expect(h.listCalls()).toHaveLength(4)
    expect(second.capture.catalog).toMatchObject({ fetchedAt: '', checkedAt: RUN_ONE, jobs: [] })
    expect(second.capture.boards).toEqual(first.capture.boards)
    const built = build(second.capture)
    expect(built.manifest.catalog.boards[0]).toEqual({
      base: { ...alder, status: 'error', checkedAt: RUN_ONE, lastSuccessAt: '2026-10-02T05:00:00.000Z', retryAt: T('06:01:00.000'), message: 'Fictional publication list 503' },
      eligible: false, initiallyStale: false, fetchedAt: '2026-10-02T05:00:00.000Z', freshUntil: '2026-10-02T05:30:00.000Z',
      total: 0, included: 0, unmappedCount: 0, fresh: null, stale: null, contentDeadline: T('06:01:00.000'),
    })
    expect(built.manifest.posting.boards[0]).toEqual({
      base: { ...alder, status: 'error', checkedAt: RUN_ONE, lastSuccessAt: '2026-10-02T05:00:00.000Z', retryAt: T('06:01:00.000'), message: 'Fictional publication list 503' },
      checkedAt: RUN_ONE, listingAt: '2026-10-02T05:00:00.000Z', bodyFreshUntil: null, listing: null, oldBody: null,
      inventoryDeadline: T('06:01:00.000'), contentDeadline: T('06:01:00.000'),
    })
    expect(built.manifest.observations.days).toEqual([{ day: '2026-10-02', fragment: expect.any(String) }])
    expect(decodedJson(built, built.manifest.observations.days[0].fragment)).toEqual(first.capture.history.days[0])
    // The private checkpoint still carries the old bodies and backoff for the next run.
    expect(decodedJson(built, built.manifest.checkpoint.files.boards)).toEqual({ version: 5, boards: first.capture.boards })
    expect(decodedJson(built, built.manifest.checkpoint.files.presence)).toEqual({ version: 1, boards: second.capture.presences })
    expectConsistentPacking(built)
  })
})

describe('registry changes and checkpoint provenance', () => {
  it('a new registry gets a new configuration ID, keeps the old series as a summary and cannot restore the other registry\'s files', async () => {
    const h = publicationHarness()
    const first = await h.run()
    const built1 = build(first.capture)
    h.at(T('06:10:00.000'))
    const second = await h.run(checkpointFrom(first.capture), { companies: [PROVENANCE_ALDER, PROVENANCE_CEDAR_DAILY] })
    const built2 = build(second.capture, GENERATION_TWO, { revision: 1, generation: GENERATION_ONE, publishedAt: T('06:00:05.000') })
    expect(built2.manifest.capture.companies).toEqual([PROVENANCE_ALDER, PROVENANCE_CEDAR_DAILY])
    expect(built2.manifest.capture.configId).not.toBe(built1.manifest.capture.configId)
    expect(built2.manifest.observations.scope.boards.map(board => board.companyId)).toEqual([ALDER, CEDAR])
    expect(built2.manifest.observations.otherSeries).toEqual([
      { scopeKey: built1.manifest.observations.scope.key, method: OBSERVATION_METHOD, companyCount: 2, days: ['2026-10-03'] },
    ])
    const privateObservations = decodedJson(built2, built2.manifest.checkpoint.files.observations) as { series: { scope: { key: string } }[] }
    expect(privateObservations.series.map(series => series.scope.key).sort())
      .toEqual([built1.manifest.observations.scope.key, built2.manifest.observations.scope.key].sort())
    expectConsistentPacking(built2)
    const files1 = privateFiles(built1)
    const files2 = privateFiles(built2)
    expect(restorePublicationCheckpoint(built1.manifest.checkpoint.capture, files1, Date.parse(RUN_ONE)).boards.map(board => board.companyId)).toEqual([ALDER, BIRCH])
    expect(restorePublicationCheckpoint(built2.manifest.checkpoint.capture, files2, Date.parse(T('06:10:00.000'))).boards.map(board => board.companyId)).toEqual([ALDER, CEDAR])
    expect(() => restorePublicationCheckpoint(built2.manifest.checkpoint.capture, files1, Date.parse(T('06:10:00.000'))))
      .toThrow('Invalid checkpoint board identity or time')
    expect(() => restorePublicationCheckpoint(built1.manifest.checkpoint.capture, files2, Date.parse(T('06:10:00.000'))))
      .toThrow('Invalid checkpoint board identity or time')
    expect(() => restorePublicationCheckpoint({ ...built1.manifest.checkpoint.capture, companies: built2.manifest.checkpoint.capture.companies }, files1, Date.parse(RUN_ONE)))
      .toThrow('Checkpoint registry does not match its configuration ID')
  })
})

describe('checkpoint restore refuses corruption instead of resetting', () => {
  async function validFiles() {
    const h = publicationHarness()
    const { capture } = await h.run()
    const built = build(capture)
    const files = privateFiles(built)
    const parse = (name: keyof typeof files) => JSON.parse(Buffer.from(files[name]).toString('utf8')) as Record<string, unknown> & { boards: Record<string, unknown>[]; series: Record<string, unknown>[] }
    const encode = (value: unknown) => new Uint8Array(Buffer.from(JSON.stringify(value)))
    return { capture, built, files, parse, encode, context: built.manifest.checkpoint.capture, now: Date.parse(capture.capturedAt) }
  }

  it('accepts the exact files and the five-minute clock tolerance boundary', async () => {
    const { files, parse, encode, context, now, capture } = await validFiles()
    expect(restorePublicationCheckpoint(context, files, now)).toEqual({ boards: capture.boards, presence: capture.presences, observations: capture.observationCheckpoint })
    const boards = parse('boards')
    boards.boards[0].checkedAt = new Date(now + 5 * 60 * 1000).toISOString()
    expect(restorePublicationCheckpoint(context, { ...files, boards: encode(boards) }, now).boards[0].checkedAt).toBe(T('06:05:00.000'))
    boards.boards[0].checkedAt = new Date(now + 5 * 60 * 1000 + 1).toISOString()
    expect(() => restorePublicationCheckpoint(context, { ...files, boards: encode(boards) }, now)).toThrow('Invalid checkpoint board identity or time')
  })

  it('rejects a registry whose configuration ID does not match', async () => {
    const { files, context, now } = await validFiles()
    expect(() => restorePublicationCheckpoint({ ...context, companies: [{ ...PROVENANCE_ALDER, board: 'AlderRenamed' }, PROVENANCE_BIRCH] }, files, now))
      .toThrow('Checkpoint registry does not match its configuration ID')
    expect(() => restorePublicationCheckpoint({ ...context, companies: [PROVENANCE_ALDER] }, files, now))
      .toThrow('Checkpoint registry does not match its configuration ID')
    expect(() => restorePublicationCheckpoint({ ...context, configId: 'a'.repeat(64) }, files, now))
      .toThrow('Checkpoint registry does not match its configuration ID')
    expect(() => restorePublicationCheckpoint({ ...context, companies: [PROVENANCE_ALDER, PROVENANCE_ALDER] }, files, now))
      .toThrow('Invalid publication company registry')
  })

  const byteCases: [string, Uint8Array, new (...args: never[]) => Error][] = [
    ['invalid JSON', new Uint8Array(Buffer.from('{"version":5,"boards":[')), SyntaxError],
    ['invalid UTF-8', new Uint8Array([0xff, 0xfe, 0xfd]), TypeError],
  ]
  it.each(byteCases)('rejects %s bytes', async (_label, bytes, error) => {
    const { files, context, now } = await validFiles()
    expect(() => restorePublicationCheckpoint(context, { ...files, boards: bytes }, now)).toThrow(error)
    expect(() => restorePublicationCheckpoint(context, { ...files, observations: bytes }, now)).toThrow(error)
  })

  it('rejects unknown versions, unknown keys and oversized files before any entry is trusted', async () => {
    const { files, parse, encode, context, now } = await validFiles()
    expect(() => restorePublicationCheckpoint(context, { ...files, boards: encode({ ...parse('boards'), version: 4 }) }, now)).toThrow()
    expect(() => restorePublicationCheckpoint(context, { ...files, presence: encode({ ...parse('presence'), version: 2 }) }, now)).toThrow()
    expect(() => restorePublicationCheckpoint(context, { ...files, observations: encode({ ...parse('observations'), version: 99 }) }, now)).toThrow()
    expect(() => restorePublicationCheckpoint(context, { ...files, boards: encode({ ...parse('boards'), fictionalExtra: true }) }, now)).toThrow()
    expect(() => restorePublicationCheckpoint(context, { ...files, observations: new Uint8Array(16 * 1024 * 1024 + 1) }, now))
      .toThrow('Checkpoint observations exceeds its size limit')
  })

  it('rejects duplicate, wrong-scope, misnamed and time-inverted board records', async () => {
    const { files, parse, encode, context, now } = await validFiles()
    const duplicate = parse('boards')
    duplicate.boards.push(structuredClone(duplicate.boards[0]))
    expect(() => restorePublicationCheckpoint(context, { ...files, boards: encode(duplicate) }, now)).toThrow('Duplicate checkpoint board')
    const duplicatePresence = parse('presence')
    duplicatePresence.boards.push(structuredClone(duplicatePresence.boards[1]))
    expect(() => restorePublicationCheckpoint(context, { ...files, presence: encode(duplicatePresence) }, now)).toThrow('Duplicate checkpoint board')
    const foreignBoard = parse('boards')
    foreignBoard.boards[1].companyId = CEDAR
    expect(() => restorePublicationCheckpoint(context, { ...files, boards: encode(foreignBoard) }, now)).toThrow('Invalid checkpoint board identity or time')
    const foreignPresence = parse('presence')
    foreignPresence.boards[1].companyId = CEDAR
    ;(foreignPresence.boards[1].snapshot as { publishedIds: string[] }).publishedIds = ['smartrecruiters-provenance-cedar-7401']
    expect(() => restorePublicationCheckpoint(context, { ...files, presence: encode(foreignPresence) }, now)).toThrow('Invalid checkpoint board identity or time')
    const renamed = parse('boards')
    renamed.boards[0].board = 'AlderRenamed'
    expect(() => restorePublicationCheckpoint(context, { ...files, boards: encode(renamed) }, now)).toThrow('Invalid checkpoint board identity or time')
    const region = parse('boards')
    region.boards[0].boardRegion = 'eu'
    expect(() => restorePublicationCheckpoint(context, { ...files, boards: encode(region) }, now)).toThrow('Invalid checkpoint board identity or time')
    const inverted = parse('boards')
    const snapshot = inverted.boards[0].snapshot as { fetchedAt: string; jobs: { fetchedAt: string }[] }
    snapshot.fetchedAt = new Date(now + 1).toISOString()
    for (const job of snapshot.jobs) job.fetchedAt = snapshot.fetchedAt
    expect(() => restorePublicationCheckpoint(context, { ...files, boards: encode(inverted) }, now)).toThrow('Invalid checkpoint board identity or time')
  })

  it('rejects job records that belong to another board or repeat an ID', async () => {
    const { files, parse, encode, context, now } = await validFiles()
    const foreign = parse('boards')
    const snapshot = foreign.boards[0].snapshot as { jobs: { id: string }[]; publishedIds: string[] }
    snapshot.jobs[0].id = 'greenhouse-provenance-birch-7401'
    snapshot.publishedIds = ['greenhouse-provenance-birch-7401']
    expect(() => restorePublicationCheckpoint(context, { ...files, boards: encode(foreign) }, now)).toThrow('Invalid checkpoint job identity')
    const repeated = parse('boards')
    const twice = repeated.boards[0].snapshot as { jobs: unknown[]; publishedIds: string[]; total: number }
    twice.jobs = [structuredClone(twice.jobs[0]), structuredClone(twice.jobs[0])]
    twice.publishedIds = [ALDER_JOB, 'greenhouse-provenance-alder-7402']
    twice.total = 2
    expect(() => restorePublicationCheckpoint(context, { ...files, boards: encode(repeated) }, now)).toThrow('Invalid checkpoint job identity')
  })

  it('rejects observation series with a foreign scope key or records from the future', async () => {
    const { files, parse, encode, context, now } = await validFiles()
    const foreign = parse('observations')
    ;(foreign.series[0].scope as { key: string }).key = 'f'.repeat(64)
    expect(() => restorePublicationCheckpoint(context, { ...files, observations: encode(foreign) }, now)).toThrow('Invalid checkpoint observation scope or time')
    expect(() => restorePublicationCheckpoint(context, files, now - 1)).toThrow('Invalid checkpoint observation scope or time')
  })
})

describe('strict validation before any publication is produced', () => {
  it('refuses unsettled, incomplete or non-restorable captures', async () => {
    const h = publicationHarness()
    const { capture } = await h.run()
    const pending = structuredClone(capture)
    pending.catalog.boards[0] = { ...pending.catalog.boards[0], status: 'pending' }
    expect(() => build(pending)).toThrow('A settled, valid public catalog is required')
    const inconsistent = structuredClone(capture)
    inconsistent.catalog.boards[0] = { ...inconsistent.catalog.boards[0], included: 2 }
    expect(() => build(inconsistent)).toThrow('A settled, valid public catalog is required')
    const legacyIndex = structuredClone(capture)
    legacyIndex.postingStatus = { ...legacyIndex.postingStatus, version: 1 }
    expect(() => build(legacyIndex)).toThrow('Complete posting metadata and restorable observations are required')
    const brokenHistory = structuredClone(capture)
    brokenHistory.history = { ...brokenHistory.history, storage: 'error', error: 'Fictional storage error' }
    expect(() => build(brokenHistory)).toThrow('Complete posting metadata and restorable observations are required')
  })

  it('refuses invalid identifiers and parents', async () => {
    const h = publicationHarness()
    const { capture } = await h.run()
    expect(() => buildPublication(capture, 'abc', null, GENERATION_ONE)).toThrow()
    // NT82-1: the numeric fixtures have no letters, so uppercase rejection needs letter hex digits.
    const upperGeneration = 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA'
    const upperParent = 'BBBBBBBB-BBBB-4BBB-9BBB-BBBBBBBBBBBB'
    expect(() => build(capture, upperGeneration)).toThrow()
    expect(() => build(capture, '11111111-1111-1111-8111-111111111111')).toThrow()
    expect(() => build(capture, GENERATION_ONE, { revision: 0, generation: GENERATION_TWO, publishedAt: RUN_ONE })).toThrow()
    expect(() => build(capture, GENERATION_ONE, { revision: 1, generation: upperParent, publishedAt: RUN_ONE })).toThrow()
    // The same identifiers in lowercase are valid, so the refusal above is about case, not shape.
    // Literal lowercase UUIDs: toLowerCase() would widen to string against the builder's UUID parameter (ANT82-1).
    const lowered = build(capture, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', { revision: 1, generation: 'bbbbbbbb-bbbb-4bbb-9bbb-bbbbbbbbbbbb', publishedAt: RUN_ONE })
    expect(lowered.manifest.generation).toBe('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
    expect(lowered.manifest.parent).toEqual({ revision: 1, generation: 'bbbbbbbb-bbbb-4bbb-9bbb-bbbbbbbbbbbb' })
    expect(GENERATION_PATTERN.test(GENERATION_ONE)).toBe(true)
    expect(GENERATION_PATTERN.test(upperGeneration)).toBe(true)
    expect(GENERATION_PATTERN.test('11111111-1111-1111-8111-111111111111')).toBe(false)
  })

  it('validates the private checkpoint it is about to publish, not only the public arrays', async () => {
    const h = publicationHarness()
    const { capture } = await h.run()
    const foreignJob = structuredClone(capture)
    const snapshot = foreignJob.boards[0].snapshot!
    snapshot.jobs[0].id = 'greenhouse-provenance-birch-7401'
    snapshot.publishedIds = ['greenhouse-provenance-birch-7401']
    expect(() => build(foreignJob)).toThrow('Invalid checkpoint job identity')
    const duplicatePresence = structuredClone(capture)
    duplicatePresence.presences.push(structuredClone(duplicatePresence.presences[0]))
    expect(() => build(duplicatePresence)).toThrow('Duplicate checkpoint board')
    const futureBoard = structuredClone(capture)
    futureBoard.boards[0].checkedAt = T('06:05:00.001')
    expect(() => build(futureBoard)).toThrow('Invalid checkpoint board identity or time')
  })
})

describe('manifest relationship validation', () => {
  async function builtManifest() {
    const h = publicationHarness()
    const { capture } = await h.run()
    return build(capture)
  }

  it('accepts the emitted manifest and rejects a missing, shrunken, duplicated or re-owned chunk', async () => {
    const built = await builtManifest()
    expect(parsePublicationManifest(cloneManifest(built))).toEqual(built.manifest)
    const missing = cloneManifest(built)
    missing.chunks[0] = { ...missing.chunks[0], index: 1 }
    expectInvalid(missing)
    const empty = cloneManifest(built)
    empty.chunks = []
    expect(() => parsePublicationManifest(empty)).toThrow()
    const shrunken = cloneManifest(built)
    shrunken.chunks[shrunken.chunks.length - 1].bytes = 1
    expectInvalid(shrunken)
    const duplicated = cloneManifest(built)
    duplicated.chunks.push({ ...duplicated.chunks[0] })
    expectInvalid(duplicated)
    const reowned = cloneManifest(built)
    reowned.chunks[0] = { ...reowned.chunks[0], owner: GENERATION_TWO }
    expectInvalid(reowned)
  })

  it('rejects fragments that are missing, unreferenced, of the wrong visibility or inconsistent with eligibility', async () => {
    const built = await builtManifest()
    const freshName = built.manifest.catalog.boards[0].fresh!
    const missing = cloneManifest(built)
    delete missing.fragments[freshName]
    expectInvalid(missing)
    const unreferenced = cloneManifest(built)
    unreferenced.fragments['extra-fragment'] = { ...unreferenced.fragments[freshName] }
    expectInvalid(unreferenced)
    const privateOnly = cloneManifest(built)
    privateOnly.fragments[freshName] = { ...privateOnly.fragments[freshName], visibility: 'checkpoint' }
    expectInvalid(privateOnly)
    const ineligible = cloneManifest(built)
    ineligible.catalog.boards[0] = { ...ineligible.catalog.boards[0], fresh: null }
    expectInvalid(ineligible)
    const noListingTime = cloneManifest(built)
    noListingTime.posting.boards[0] = { ...noListingTime.posting.boards[0], listingAt: null }
    expectInvalid(noListingTime)
    const halfListing = cloneManifest(built)
    halfListing.posting.boards[0] = { ...halfListing.posting.boards[0], oldBody: null }
    expectInvalid(halfListing)
    const fewerBoards = cloneManifest(built)
    fewerBoards.catalog.boards.pop()
    expectInvalid(fewerBoards)
    const unorderedDays = cloneManifest(built)
    unorderedDays.observations.otherSeries = [{ scopeKey: 'b'.repeat(64), method: OBSERVATION_METHOD, companyCount: 2, days: ['2026-10-03', '2026-10-02'] }]
    expectInvalid(unorderedDays)
  })
})
