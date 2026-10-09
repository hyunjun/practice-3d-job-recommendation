import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PRIVATE_FILES } from '../shared/publication'
import type { PublicationHead } from '../shared/publication'
import { buildPublication } from '../server/publication-build'
import { createPublicationClient, PublicationClientError } from '../server/publication-client'
import { collectPublication, restorePublicationCheckpoint } from '../server/publication-collector'

const operation = process.argv[2] ?? 'collect'
const controller = new AbortController()
const stop = () => controller.abort()
let timeout: ReturnType<typeof setTimeout> | undefined
let temporary: string | undefined
let published: PublicationHead | null = null
let attempted: { generation: string; parent: Pick<PublicationHead, 'generation' | 'revision'> | null } | undefined
const originalFetch = globalThis.fetch
const startedAt = Date.now()
try {
  if (!['collect', 'rollback'].includes(operation) || process.argv.length > 3) throw new Error('Use collect or rollback')
  const token = process.env.ORBIT_PUBLISH_TOKEN ?? ''
  const origin = process.env.ORBIT_PUBLICATION_URL ?? 'https://job.hyunjun.workers.dev'
  const gitEnvironment = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')))
  const git = (args: string[]) => execFileSync('git', ['--no-pager', '--literal-pathspecs', '-c', 'core.fsmonitor=false', ...args], {
    cwd: fileURLToPath(new URL('..', import.meta.url)), encoding: 'utf8',
    env: { ...gitEnvironment, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
  }).trim()
  const collectorCommit = git(['rev-parse', 'HEAD'])
  if (!/^[a-f0-9]{40}$/.test(collectorCommit) || git(['status', '--porcelain', '--untracked-files=all'])) {
    throw new Error('Publish only from a clean, verified collector commit')
  }
  const client = createPublicationClient({ url: origin, token, signal: controller.signal })
  temporary = await mkdtemp(path.join(os.tmpdir(), 'orbit-publication-'))
  timeout = setTimeout(stop, 22 * 60 * 1000)
  process.once('SIGTERM', stop)
  process.once('SIGINT', stop)
  // Provider requests share the CLI budget. Account tokens are not accepted.
  globalThis.fetch = (input, init) => {
    const requestSignal = init?.signal ?? (input instanceof Request ? input.signal : undefined)
    return originalFetch(input, {
      ...init, signal: requestSignal ? AbortSignal.any([requestSignal, controller.signal]) : controller.signal,
    })
  }
  const before = await client.head()
  if (operation === 'rollback') {
    if (!before.head) throw new Error('No current publication can be rolled back')
    attempted = { generation: randomUUID(), parent: { generation: before.head.generation, revision: before.head.revision } }
    const head = await client.rollback(before.head, attempted.generation)
    published = head
    const storage = await client.metrics()
    console.log(JSON.stringify({ operation, success: true, head, storage, elapsedMs: Date.now() - startedAt }))
  } else {
    let checkpoint
    if (before.head && before.manifest) {
      const files = await client.checkpoint(before.head, before.manifest)
      const directory = path.join(temporary, 'restore')
      await mkdir(directory, { mode: 0o700 })
      for (const name of PRIVATE_FILES) await writeFile(path.join(directory, `${name}.json`), files[name], { mode: 0o600, flag: 'wx' })
      checkpoint = restorePublicationCheckpoint(before.manifest.checkpoint.capture, files)
    }
    const { capture, metrics } = await collectPublication({ checkpoint, measureHttp: true })
    controller.signal.throwIfAborted()
    const publication = buildPublication(capture, collectorCommit, before.head)
    const directory = path.join(temporary, 'publish')
    await mkdir(directory, { mode: 0o700 })
    await writeFile(path.join(directory, 'manifest.json'), publication.manifestText, { mode: 0o600, flag: 'wx' })
    for (const [index, chunk] of publication.chunks.entries()) {
      await writeFile(path.join(directory, `${index}.bin`), chunk, { mode: 0o600, flag: 'wx' })
    }
    controller.signal.throwIfAborted()
    attempted = { generation: publication.manifest.generation, parent: publication.manifest.parent }
    const head = await client.publish(publication)
    published = head
    const storage = await client.metrics()
    const usable = capture.catalog.boards.filter(board => board.dataStatus !== 'unavailable').length
    console.log(JSON.stringify({
      operation, success: true, head, collectorCommit, capturedAt: capture.capturedAt,
      companies: capture.catalog.companies.length, usableBoards: usable, jobs: capture.catalog.jobs.length,
      failedBoards: capture.catalog.boards.filter(board => board.status === 'error').length,
      compressedBytes: publication.chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0),
      manifestBytes: Buffer.byteLength(publication.manifestText),
      checkpointBytes: Object.fromEntries(PRIVATE_FILES.map(name => [name,
        publication.manifest.fragments[publication.manifest.checkpoint.files[name]].decodedBytes])),
      providerPasses: metrics, storage, elapsedMs: Date.now() - startedAt,
    }))
  }
} catch (error) {
  // Small, credential-free outcome; raw checkpoint/provider errors stay private.
  console.error(JSON.stringify({
    operation: ['collect', 'rollback'].includes(operation) ? operation : 'invalid',
    success: false, published: published ? true : attempted ? null : false,
    ...(published ? { head: published } : {}), ...(attempted ? { attempted } : {}),
    code: controller.signal.aborted ? 'CANCELLED'
      : error instanceof PublicationClientError ? error.code : 'COLLECTION_OR_VALIDATION_FAILED',
    elapsedMs: Date.now() - startedAt,
  }))
  process.exitCode = 1
} finally {
  globalThis.fetch = originalFetch
  if (timeout) clearTimeout(timeout)
  process.removeListener('SIGTERM', stop)
  process.removeListener('SIGINT', stop)
  if (temporary) await rm(temporary, { recursive: true, force: true })
}
