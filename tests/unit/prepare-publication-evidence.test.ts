import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const script = fileURLToPath(new URL('../../scripts/prepare-publication-evidence.mjs', import.meta.url))
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const generation = '11111111-1111-4111-8111-111111111111'
const head = { generation, revision: 1, publishedAt: '2026-10-25T00:00:00.000Z' }
const attempt = { generation, parent: null }
const payload = Buffer.from('{"version":1,"synthetic":"대한민국 café"}\n', 'utf8')
const receipt = (bytes = payload) => ({ version: 1, bytes: bytes.length, sha256: hash(bytes) })
const success = () => ({ operation: 'collect', success: true, head, elapsedMs: 42, evidence: receipt() })
const failure = () => ({ operation: 'collect', success: false, published: false, code: 'COLLECTION_OR_VALIDATION_FAILED', elapsedMs: 42 })
let root: string
let output: string
let evidence: string
let githubOutput: string
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'orbit-prepare-evidence-'))
  output = path.join(root, 'current-output.log')
  evidence = path.join(root, 'evidence.json')
  githubOutput = path.join(root, 'github-output')
  await writeFile(githubOutput, 'prior=value\n')
  await writeFile(evidence, payload)
})
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

// A direct finite Node child, no server or grandchildren. execFile's callback
// joins child closure; its bounded output and SIGKILL timeout cannot pass a test.
async function prepare(record: unknown, options: { raw?: Buffer | string; args?: string[]; env?: NodeJS.ProcessEnv } = {}) {
  await writeFile(output, options.raw ?? `synthetic collector progress\n${JSON.stringify(record)}\n`)
  return new Promise<{ code: number | string | null; stdout: string; stderr: string }>((resolve, reject) => {
    execFile(process.execPath, [script, ...(options.args ?? ['--output-record', output, '--evidence-file', evidence])], {
      env: { ...process.env, GITHUB_OUTPUT: githubOutput, ...options.env },
      timeout: 3000, killSignal: 'SIGKILL', maxBuffer: 64 * 1024, encoding: 'utf8',
    }, (error, stdout, stderr) => {
      if (error?.killed || error?.signal) reject(new Error(`Preparation child did not exit normally: ${String(error)}`))
      else resolve({ code: error?.code ?? 0, stdout, stderr })
    })
  })
}
async function refused(record: unknown, options: Parameters<typeof prepare>[1] = {}) {
  expect(await prepare(record, options)).toEqual({
    code: 1, stdout: '', stderr: 'Publication evidence preparation failed.\n',
  })
  expect(await readFile(githubOutput, 'utf8')).toBe('prior=value\n')
}

describe('this invocation’s completed evidence receipt', () => {
  it.each(['success', 'before-attempt', 'unconfirmed', 'confirmed'] as const)('admits exact UTF-8 evidence after %s', async outcome => {
    const record = outcome === 'success' ? success() : {
      ...failure(), evidence: receipt(),
      ...(outcome === 'unconfirmed' ? { published: null, attempted: attempt } : {}),
      ...(outcome === 'confirmed' ? { published: true, attempted: attempt, head } : {}),
    }
    expect(await prepare(record)).toEqual({ code: 0, stdout: '', stderr: '' })
    expect(await readFile(githubOutput, 'utf8')).toBe(`prior=value\nready=true\nbytes=${payload.length}\nsha256=${hash(payload)}\n`)
    expect(await readFile(evidence)).toEqual(payload)
  })

  it.each(['old-file', 'partial-file', 'missing', 'symlink', 'directory'] as const)(
    'a failed run without a receipt never admits %s evidence', async kind => {
      if (kind === 'partial-file') await writeFile(evidence, '{"partial":')
      if (kind === 'missing' || kind === 'symlink' || kind === 'directory') await rm(evidence)
      if (kind === 'symlink') await symlink(path.join(root, 'not-present'), evidence)
      if (kind === 'directory') await mkdir(evidence)
      expect(await prepare(failure())).toEqual({ code: 0, stdout: '', stderr: '' })
      expect(await readFile(githubOutput, 'utf8')).toBe('prior=value\nready=false\n')
    },
  )

  it('refuses a successful result without a completed receipt even when a matching old file exists', async () => {
    const { evidence: _receipt, ...record } = success()
    await refused(record)
  })

  it.each([
    ['array result', []],
    ['null result', null],
    ['rollback operation', { ...success(), operation: 'rollback' }],
    ['string success', { ...success(), success: 'true' }],
    ['negative elapsed', { ...success(), elapsedMs: -1 }],
    ['fractional elapsed', { ...success(), elapsedMs: 0.5 }],
    ['missing head', { ...success(), head: undefined }],
    ['zero revision', { ...success(), head: { ...head, revision: 0 } }],
    ['malformed generation', { ...success(), head: { ...head, generation: 'not-a-uuid' } }],
    ['bad timestamp', { ...success(), head: { ...head, publishedAt: 'yesterday' } }],
    ['success with failure field', { ...success(), published: false }],
    ['missing failure code', { ...failure(), code: undefined }],
    ['invalid published type', { ...failure(), published: 'false' }],
    ['false with attempt', { ...failure(), attempted: attempt }],
    ['null without attempt', { ...failure(), published: null }],
    ['null with head', { ...failure(), published: null, attempted: attempt, head }],
    ['true without head', { ...failure(), published: true, attempted: attempt }],
    ['true mismatched head', { ...failure(), published: true, attempted: { ...attempt, generation: '22222222-2222-4222-9222-222222222222' }, head }],
    ['invalid parent', { ...failure(), published: null, attempted: { ...attempt, parent: { generation, revision: 0 } } }],
  ])('rejects %s rather than selecting any candidate file', async (_label, record) => { await refused(record) })

  it.each([
    ['missing version', { bytes: payload.length, sha256: hash(payload) }],
    ['wrong version', { ...receipt(), version: 2 }],
    ['zero bytes', { ...receipt(), bytes: 0 }],
    ['fractional bytes', { ...receipt(), bytes: 1.5 }],
    ['unsafe integer', { ...receipt(), bytes: Number.MAX_SAFE_INTEGER + 1 }],
    ['uppercase hash', { ...receipt(), sha256: hash(payload).toUpperCase() }],
    ['extra key', { ...receipt(), path: '/private/sentinel' }],
    ['wrong bytes', { ...receipt(), bytes: payload.length + 1 }],
    ['wrong hash', { ...receipt(), sha256: '0'.repeat(64) }],
    ['nonobject', []],
  ])('rejects a %s receipt without readiness', async (_label, invalid) => { await refused({ ...success(), evidence: invalid }) })

  it.each(['malformed-json', 'two-results', 'other-json-array', 'invalid-utf8', 'empty'] as const)(
    'refuses a %s output record', async kind => {
      const valid = JSON.stringify(success())
      const raw = kind === 'malformed-json' ? '{broken\n'
        : kind === 'two-results' ? `${valid}\n${valid}\n`
          : kind === 'other-json-array' ? `[]\n${valid}\n`
            : kind === 'invalid-utf8' ? Buffer.concat([Buffer.from([0xff]), Buffer.from(`\n${valid}\n`)]) : ''
      await refused(null, { raw })
    },
  )

  it.each(['output', 'evidence'] as const)('accepts the exact %s byte limit and refuses limit plus one', async which => {
    if (which === 'evidence') {
      const exact = Buffer.alloc(8 * 1024 * 1024, 0x20)
      await writeFile(evidence, exact)
      expect((await prepare({ ...success(), evidence: receipt(exact) })).code).toBe(0)
      await writeFile(githubOutput, 'prior=value\n')
      const over = Buffer.concat([exact, Buffer.from(' ')])
      await writeFile(evidence, over)
      await refused({ ...success(), evidence: receipt(over) })
    } else {
      const final = `\n${JSON.stringify(success())}\n`
      const exact = `${'x'.repeat(1024 * 1024 - Buffer.byteLength(final))}${final}`
      expect((await prepare(null, { raw: exact })).code).toBe(0)
      await writeFile(githubOutput, 'prior=value\n')
      await refused(null, { raw: `x${exact}` })
    }
  })

  it('rejects invalid evidence UTF-8 even when its complete byte receipt matches', async () => {
    const invalid = Buffer.from([0x7b, 0xff, 0x7d])
    await writeFile(evidence, invalid)
    await refused({ ...success(), evidence: receipt(invalid) })
  })

  it.each(['evidence-symlink', 'evidence-directory', 'evidence-fifo', 'record-symlink', 'record-directory', 'record-fifo'] as const)(
    'rejects %s promptly without following or blocking on it', async kind => {
      const target = kind.startsWith('record') ? path.join(root, 'nonregular-record') : evidence
      if (target === evidence) await rm(evidence)
      if (kind.endsWith('symlink')) await symlink(githubOutput, target)
      if (kind.endsWith('directory')) await mkdir(target)
      if (kind.endsWith('fifo')) await promisify(execFile)('mkfifo', [target], { timeout: 1000, killSignal: 'SIGKILL' })
      await refused(success(), { args: ['--output-record', kind.startsWith('record') ? target : output, '--evidence-file', evidence] })
    },
  )

  it.each(['relative-record', 'relative-evidence', 'missing-arg', 'relative-output', 'unwritable-output'] as const)(
    'rejects %s configuration with no readiness output', async kind => {
      const args = ['--output-record', kind === 'relative-record' ? 'record.log' : output, '--evidence-file', kind === 'relative-evidence' ? 'evidence.json' : evidence]
      if (kind === 'missing-arg') args.pop()
      await refused(success(), {
        args, env: kind === 'relative-output' ? { GITHUB_OUTPUT: 'relative-output' }
          : kind === 'unwritable-output' ? { GITHUB_OUTPUT: root } : {},
      })
    },
  )
})
