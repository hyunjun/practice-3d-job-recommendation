import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The exact v11 identity/execute control map approved by Main/Astra against
 * main/without-fable-01/proposal-02.json (f61506dbc642f0e08f7004efa1e7e2dd9e66e6ffe461f84387e10552ce49ff69)
 * is selected from the public-safe byte-preserving archive and verified against
 * the embedded hashes before any isolated synthetic copy is written. The
 * unchanged v10 run-review.py is used only by the synthetic legacy wrapper fixture.
 * Nothing here reads the live stage controls, gates or model streams.
 */
export const WORKTREE = fileURLToPath(new URL('../../..', import.meta.url))
export const ARCHIVE_PATH = 'docs/validation/82-cloudflare-controls.json'
export const CONTROL_NAMES = ['stage-identity.py', 'run-review.py', 'process-ownership.py', 'register-processes.cjs', 'run-validation.py'] as const
export type ControlName = typeof CONTROL_NAMES[number]
export const APPROVED_CONTROL_HASHES: Record<ControlName, string> = {
  'stage-identity.py': 'd8a66213ccc323697b2df7fa7844fbae09d419346d743a0d001a0efbd5cee1f4',
  'run-review.py': '047deaa894a6cf3d3f5030bcb20833056fa9d8756484fc5d85bf69be36da5867',
  'process-ownership.py': 'af40f04ad990b422b3bd028e196f90475578382527b07d51c08a03caf5dec969',
  'register-processes.cjs': 'c7f08bdb647030798117bf0ff5a1edfd6ee5a0243f1e1e9998c1340daed35b1e',
  'run-validation.py': '31d70ce21e597c0e3a501b0534b765a81e3d3d8190f5394a902ebce4fa501c17',
}

interface ArchiveEntry { historicalSourcePath: string; bytes: number; sha256: string; originalUtf8: string }

export async function loadApprovedControls(): Promise<Record<ControlName, string>> {
  const archive = JSON.parse(await readFile(path.join(WORKTREE, ARCHIVE_PATH), 'utf8')) as { sources: Record<string, ArchiveEntry> }
  const entries = Object.values(archive.sources ?? {})
  const sources = {} as Record<ControlName, string>
  const missing: string[] = []
  for (const name of CONTROL_NAMES) {
    const expected = APPROVED_CONTROL_HASHES[name]
    const entry = entries.find(item => item.sha256 === expected)
    if (!entry) {
      missing.push(`${name} ${expected}`)
      continue
    }
    const bytes = Buffer.from(entry.originalUtf8, 'utf8')
    if (createHash('sha256').update(bytes).digest('hex') !== expected || bytes.length !== entry.bytes) {
      throw new Error(`The archived ${name} does not match its recorded hash or size`)
    }
    sources[name] = entry.originalUtf8
  }
  if (missing.length) throw new Error(`The public archive lacks the approved control sources: ${missing.join(', ')}`)
  return sources
}
