import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { gunzipSync } from 'node:zlib'
import { buildPublication } from '../../server/publication-build'
import { createPublicationEvidence, writePublicationEvidence } from '../../server/publication-evidence'
import { FICTIONAL_COMMIT, GENERATION_ONE, GENERATION_TWO, publicationHarness, RUN_ONE } from '../fixtures/publication'

vi.mock('node:fs/promises', async importOriginal => {
  const original = await importOriginal<typeof import('node:fs/promises')>()
  return { ...original, writeFile: vi.fn(original.writeFile) }
})
const actualFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex')
const owned: string[] = []
afterEach(async () => {
  vi.mocked(writeFile).mockReset().mockImplementation(actualFs.writeFile)
  const results = await Promise.allSettled(owned.splice(0).map(root => rm(root, { recursive: true, force: true })))
  expect(results.filter(result => result.status === 'rejected')).toEqual([])
})
async function fixture() {
  const { capture } = await publicationHarness().run()
  return buildPublication(capture, FICTIONAL_COMMIT, null, GENERATION_ONE)
}
async function directories() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'orbit-evidence-unit-'))
  owned.push(root)
  const raw = path.join(root, 'raw')
  await mkdir(raw)
  return { root, raw, target: path.join(root, 'evidence.json') }
}
const counts = { companies: 2, boards: 2, jobs: 2 }

describe('metadata-only publication evidence', () => {
  it('retains exact identities, references and independently verifiable byte operands without private data', async () => {
    const built = await fixture()
    // Unknown/private fields must never leak through a whole-object spread.
    Object.assign(built.manifest.capture, { privateToken: 'TOKEN_SENTINEL_대한민국' })
    Object.assign(built.manifest, { error: 'ERROR_SENTINEL', body: 'BODY_SENTINEL' })
    built.manifestText = `${JSON.stringify(built.manifest)}\n`
    const evidence = createPublicationEvidence(built, counts)
    expect(Object.keys(evidence).sort()).toEqual([
      'capturedAt', 'catalog', 'checkpoint', 'chunks', 'collectorCommit', 'compressedBytes', 'configId',
      'counts', 'fragments', 'generation', 'manifest', 'observations', 'parent', 'posting', 'version',
    ])
    expect(evidence).toMatchObject({
      version: 1, collectorCommit: FICTIONAL_COMMIT, generation: GENERATION_ONE, parent: null,
      capturedAt: RUN_ONE, configId: built.manifest.capture.configId, counts,
      manifest: { bytes: Buffer.byteLength(built.manifestText, 'utf8'), sha256: hash(Buffer.from(built.manifestText, 'utf8')) },
      checkpoint: [
        { name: 'boards', fragment: 'private-boards' },
        { name: 'presence', fragment: 'private-presence' },
        { name: 'observations', fragment: 'private-observations' },
      ],
      catalog: [{ fresh: 'c-0-fresh', stale: 'c-0-stale' }, { fresh: 'c-1-fresh', stale: 'c-1-stale' }],
      posting: [{ listing: 'p-0-full', oldBody: 'p-0-old' }, { listing: 'p-1-full', oldBody: 'p-1-old' }],
      observations: [{ day: '2026-10-03', fragment: 'h-0' }],
    })
    expect(evidence.manifest.bytes).toBeGreaterThan(built.manifestText.length)
    expect(evidence.checkpoint.every(item => Object.keys(item).length === 2)).toBe(true)
    expect(evidence.catalog.every(item => Object.keys(item).length === 2)).toBe(true)
    expect(evidence.posting.every(item => Object.keys(item).length === 2)).toBe(true)
    expect(evidence.observations.every(item => Object.keys(item).length === 2)).toBe(true)
    expect(evidence.chunks).toEqual(built.chunks.map((bytes, index) => ({
      owner: GENERATION_ONE, index, bytes: bytes.byteLength, sha256: hash(bytes),
    })))
    const packed = Buffer.concat(built.chunks)
    expect(evidence.compressedBytes).toBe(packed.length)
    expect(evidence.fragments).toHaveLength(12)
    let offset = 0
    for (const fragment of evidence.fragments) {
      expect(Object.keys(fragment).sort()).toEqual([
        'compressedBytes', 'compressedHash', 'decodedBytes', 'decodedHash', 'id', 'kind', 'offset', 'owner', 'visibility',
      ])
      expect(fragment.owner).toBe(GENERATION_ONE)
      expect(fragment.offset).toBe(offset)
      const compressed = packed.subarray(offset, offset + fragment.compressedBytes)
      const decoded = gunzipSync(compressed)
      expect(fragment.compressedHash).toBe(hash(compressed))
      expect(fragment.decodedHash).toBe(hash(decoded))
      expect(fragment.decodedBytes).toBe(decoded.length)
      expect(fragment.visibility).toBe(fragment.id.startsWith('private-') ? 'checkpoint' : 'public')
      expect(fragment.kind).toBe(fragment.id.startsWith('c-') ? 'items' : 'value')
      offset += compressed.length
    }
    expect(offset).toBe(packed.length)
    const sizes = new Map(evidence.fragments.map(item => [item.id, item.decodedBytes]))
    const size = (id: string | null) => id === null ? 0 : sizes.get(id)!
    const overhead = 2 * evidence.manifest.bytes + 4096
    expect(overhead + evidence.catalog.reduce((sum, b) => sum + Math.max(size(b.fresh), size(b.stale)), 0)).toBeLessThanOrEqual(128 * 1024 * 1024)
    expect(overhead + evidence.posting.reduce((sum, b) => sum + Math.max(size(b.listing), size(b.oldBody)), 0)).toBeLessThanOrEqual(64 * 1024 * 1024)
    expect(overhead + evidence.observations.reduce((sum, d) => sum + size(d.fragment), 0)).toBeLessThanOrEqual(16 * 1024 * 1024)
    const serialized = JSON.stringify(evidence)
    for (const privateText of ['TOKEN_SENTINEL', 'ERROR_SENTINEL', 'BODY_SENTINEL', 'Alder', 'Birch', 'https://', 'careerUrl', 'companyId', '"capture"', '"base"']) {
      expect(serialized).not.toContain(privateText)
    }
  })

  it('preserves a parent and null variants without forcing a 132-company count', async () => {
    const built = await fixture()
    built.manifest.parent = { generation: GENERATION_TWO, revision: 7 }
    built.manifest.catalog.boards[0].fresh = null
    built.manifest.catalog.boards[0].stale = null
    built.manifest.posting.boards[0].listing = null
    built.manifest.posting.boards[0].oldBody = null
    const evidence = createPublicationEvidence(built, { companies: 2, boards: 2, jobs: 0 })
    expect(evidence.parent).toEqual({ generation: GENERATION_TWO, revision: 7 })
    expect(evidence.counts).toEqual({ companies: 2, boards: 2, jobs: 0 })
    expect(evidence.catalog[0]).toEqual({ fresh: null, stale: null })
    expect(evidence.posting[0]).toEqual({ listing: null, oldBody: null })
  })
})

describe('exclusive completed evidence writes outside the raw temporary tree', () => {
  it('writes a 0600 UTF-8 file with a receipt for its exact bytes', async () => {
    const { raw, target } = await directories()
    const receipt = await writePublicationEvidence(target, raw, await fixture(), counts)
    const bytes = await readFile(target)
    expect(receipt).toEqual({ version: 1, bytes: bytes.length, sha256: hash(bytes) })
    expect(JSON.parse(bytes.toString('utf8'))).toMatchObject({ version: 1, counts })
    expect(bytes.at(-1)).toBe(10)
    expect((await stat(target)).mode & 0o777).toBe(0o600)
  })

  it.each(['relative', 'inside', 'same-root', 'missing-parent', 'aliased-parent', 'existing', 'leaf-symlink'] as const)(
    'rejects %s without overwriting a pre-existing target or creating parents', async kind => {
      const { root, raw, target } = await directories()
      const sentinel = path.join(root, 'sentinel')
      await actualFs.writeFile(sentinel, 'keep exact bytes')
      let destination = target
      if (kind === 'relative') destination = 'relative-evidence.json'
      if (kind === 'inside') destination = path.join(raw, 'evidence.json')
      if (kind === 'same-root') destination = raw
      if (kind === 'missing-parent') destination = path.join(root, 'missing', 'evidence.json')
      if (kind === 'existing') { destination = sentinel }
      if (kind === 'leaf-symlink') await symlink(sentinel, target)
      if (kind === 'aliased-parent') {
        const alias = path.join(root, 'raw-alias')
        await symlink(raw, alias)
        destination = path.join(alias, 'evidence.json')
      }
      await expect(writePublicationEvidence(destination, raw, await fixture(), counts)).rejects.toThrow()
      expect(await readFile(sentinel, 'utf8')).toBe('keep exact bytes')
      expect(await actualFs.readdir(raw)).toEqual([])
      await expect(stat(path.join(root, 'missing'))).rejects.toMatchObject({ code: 'ENOENT' })
    },
  )

  it('does not resolve the completed receipt before the file write settles', async () => {
    const { raw, target } = await directories()
    const built = await fixture()
    let release!: () => void
    let entered!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const started = new Promise<void>(resolve => { entered = resolve })
    vi.mocked(writeFile).mockImplementationOnce(async (...args) => {
      entered()
      await gate
      return actualFs.writeFile(...args)
    })
    let completed = false
    const writing = writePublicationEvidence(target, raw, built, counts).then(value => { completed = true; return value })
    try {
      await started
      await Promise.resolve()
      expect(completed).toBe(false)
      await expect(stat(target)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      release()
      await writing
    }
    const bytes = await readFile(target)
    expect(await writing).toEqual({ version: 1, bytes: bytes.length, sha256: hash(bytes) })
  })

  it('rejects a partial write without a receipt and never overwrites the partial file on another call', async () => {
    const { raw, target } = await directories()
    const built = await fixture()
    const failure = new Error('synthetic interrupted disk write')
    vi.mocked(writeFile).mockImplementationOnce(async () => {
      await actualFs.writeFile(target, 'partial', { flag: 'wx', mode: 0o600 })
      throw failure
    })
    await expect(writePublicationEvidence(target, raw, built, counts)).rejects.toBe(failure)
    expect(await readFile(target, 'utf8')).toBe('partial')
    await expect(writePublicationEvidence(target, raw, built, counts)).rejects.toMatchObject({ code: 'EEXIST' })
    expect(await readFile(target, 'utf8')).toBe('partial')
  })
})
