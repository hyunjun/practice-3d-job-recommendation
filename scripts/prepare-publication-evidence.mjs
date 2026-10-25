import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { appendFile, lstat, open } from 'node:fs/promises'
import path from 'node:path'

const OUTPUT_LIMIT = 1024 * 1024
const EVIDENCE_LIMIT = 8 * 1024 * 1024
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/
const hash = /^[a-f0-9]{64}$/
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const keys = (value, expected) => object(value)
  && Object.keys(value).length === expected.length && expected.every(key => Object.hasOwn(value, key))
const count = value => Number.isSafeInteger(value) && value >= 0
const parent = value => keys(value, ['generation', 'revision'])
  && typeof value.generation === 'string' && uuid.test(value.generation) && count(value.revision) && value.revision > 0
const head = value => keys(value, ['generation', 'revision', 'publishedAt'])
  && parent({ generation: value.generation, revision: value.revision })
  && typeof value.publishedAt === 'string'
  && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value.publishedAt)
  && Number.isFinite(Date.parse(value.publishedAt))
const attempted = value => keys(value, ['generation', 'parent'])
  && typeof value.generation === 'string' && uuid.test(value.generation)
  && (value.parent === null || parent(value.parent))

async function readRegular(file, limit) {
  if (!path.isAbsolute(file)) throw new Error('Invalid path')
  const before = await lstat(file)
  if (!before.isFile() || before.size > limit) throw new Error('Invalid input file')
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const current = await handle.stat()
    if (!current.isFile() || current.size > limit || before.dev !== current.dev || before.ino !== current.ino) {
      throw new Error('Invalid input file')
    }
    const buffer = Buffer.alloc(limit + 1)
    let length = 0
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null)
      if (bytesRead === 0) break
      length += bytesRead
    }
    if (length > limit) throw new Error('Input exceeds the size limit')
    const bytes = buffer.subarray(0, length)
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    return { bytes, text }
  } finally {
    await handle.close()
  }
}

function collectResult(text) {
  const candidates = text.split(/\r?\n/).map(line => line.trim()).filter(line => /^[{[]/.test(line))
  if (candidates.length !== 1) throw new Error('Ambiguous collector result')
  const result = JSON.parse(candidates[0])
  if (!object(result) || result.operation !== 'collect' || typeof result.success !== 'boolean' || !count(result.elapsedMs)) {
    throw new Error('Invalid collector result')
  }
  if (result.success) {
    if (!head(result.head) || ['published', 'attempted', 'code'].some(key => Object.hasOwn(result, key))) {
      throw new Error('Invalid successful outcome')
    }
  } else {
    if (![false, null, true].includes(result.published) || typeof result.code !== 'string' || result.code.length === 0) {
      throw new Error('Invalid failed outcome')
    }
    if (result.published === false) {
      if (Object.hasOwn(result, 'head') || Object.hasOwn(result, 'attempted')) throw new Error('Invalid unpublished outcome')
    } else {
      if (!attempted(result.attempted)) throw new Error('Invalid attempted outcome')
      if (result.published === true) {
        if (!head(result.head) || result.head.generation !== result.attempted.generation) throw new Error('Invalid confirmed outcome')
      } else if (Object.hasOwn(result, 'head')) {
        throw new Error('Invalid unconfirmed outcome')
      }
    }
  }
  return result
}

async function prepare() {
  const args = process.argv.slice(2)
  if (args.length !== 4 || args[0] !== '--output-record' || args[2] !== '--evidence-file'
    || !process.env.GITHUB_OUTPUT || !path.isAbsolute(process.env.GITHUB_OUTPUT)) {
    throw new Error('Invalid preparation configuration')
  }
  const { text } = await readRegular(args[1], OUTPUT_LIMIT)
  const result = collectResult(text)
  if (!Object.hasOwn(result, 'evidence')) {
    if (result.success) throw new Error('Successful collection is missing evidence')
    await appendFile(process.env.GITHUB_OUTPUT, 'ready=false\n')
    return
  }
  const receipt = result.evidence
  if (!keys(receipt, ['version', 'bytes', 'sha256']) || receipt.version !== 1
    || !count(receipt.bytes) || receipt.bytes === 0 || receipt.bytes > EVIDENCE_LIMIT
    || typeof receipt.sha256 !== 'string' || !hash.test(receipt.sha256)) {
    throw new Error('Invalid evidence receipt')
  }
  const { bytes } = await readRegular(args[3], EVIDENCE_LIMIT)
  const actualHash = createHash('sha256').update(bytes).digest('hex')
  if (bytes.byteLength !== receipt.bytes || actualHash !== receipt.sha256) throw new Error('Evidence does not match its receipt')
  // A failed collector may still have a complete pre-publication evidence file.
  // Never emit readiness until the exact file from this invocation is verified.
  await appendFile(process.env.GITHUB_OUTPUT, `ready=true\nbytes=${receipt.bytes}\nsha256=${actualHash}\n`)
}

try {
  await prepare()
} catch {
  console.error('Publication evidence preparation failed.')
  process.exitCode = 1
}
