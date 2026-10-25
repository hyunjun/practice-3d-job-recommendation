import { createHash } from 'node:crypto'
import { realpath, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { PRIVATE_FILES } from '../shared/publication'
import type { BuiltPublication } from './publication-build'

export interface PublicationEvidenceCounts {
  companies: number
  boards: number
  jobs: number
}

export interface PublicationEvidenceReceipt {
  version: 1
  bytes: number
  sha256: string
}

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

/** Only explicit metadata and fragment references; never serialize the capture. */
export function createPublicationEvidence(publication: BuiltPublication, counts: PublicationEvidenceCounts) {
  const { manifest, manifestText, chunks } = publication
  if (![counts.companies, counts.boards, counts.jobs].every(value => Number.isSafeInteger(value) && value >= 0)
    || chunks.length !== manifest.chunks.length) {
    throw new Error('Invalid publication evidence inputs')
  }
  const metadata = Buffer.from(manifestText, 'utf8')
  return {
    version: 1 as const,
    collectorCommit: manifest.capture.collectorCommit,
    generation: manifest.generation,
    parent: manifest.parent ? { generation: manifest.parent.generation, revision: manifest.parent.revision } : null,
    capturedAt: manifest.capture.capturedAt,
    configId: manifest.capture.configId,
    counts: { companies: counts.companies, boards: counts.boards, jobs: counts.jobs },
    manifest: { bytes: metadata.byteLength, sha256: sha256(metadata) },
    compressedBytes: chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0),
    chunks: chunks.map((bytes, index) => ({
      owner: manifest.chunks[index].owner, index: manifest.chunks[index].index,
      bytes: bytes.byteLength, sha256: sha256(bytes),
    })),
    fragments: Object.entries(manifest.fragments).map(([id, fragment]) => ({
      id, owner: fragment.owner, offset: fragment.offset, kind: fragment.kind, visibility: fragment.visibility,
      compressedBytes: fragment.compressedBytes, decodedBytes: fragment.decodedBytes,
      compressedHash: fragment.compressedHash, decodedHash: fragment.decodedHash,
    })),
    checkpoint: PRIVATE_FILES.map(name => ({ name, fragment: manifest.checkpoint.files[name] })),
    catalog: manifest.catalog.boards.map(board => ({ fresh: board.fresh, stale: board.stale })),
    posting: manifest.posting.boards.map(board => ({ listing: board.listing, oldBody: board.oldBody })),
    observations: manifest.observations.days.map(day => ({ day: day.day, fragment: day.fragment })),
  }
}

/** A completed receipt is returned only after the exclusive private write. */
export async function writePublicationEvidence(
  file: string,
  temporaryRoot: string,
  publication: BuiltPublication,
  counts: PublicationEvidenceCounts,
): Promise<PublicationEvidenceReceipt> {
  if (!path.isAbsolute(file)) throw new Error('An absolute publication evidence path is required')
  const target = path.resolve(file)
  const parent = await realpath(path.dirname(target))
  const resolvedTarget = path.join(parent, path.basename(target))
  const rawRoot = await realpath(temporaryRoot)
  const relative = path.relative(rawRoot, resolvedTarget)
  if (relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))) {
    throw new Error('Publication evidence must be outside the temporary publication directory')
  }
  const bytes = Buffer.from(`${JSON.stringify(createPublicationEvidence(publication, counts))}\n`, 'utf8')
  await writeFile(resolvedTarget, bytes, { flag: 'wx', mode: 0o600 })
  return { version: 1, bytes: bytes.byteLength, sha256: sha256(bytes) }
}
