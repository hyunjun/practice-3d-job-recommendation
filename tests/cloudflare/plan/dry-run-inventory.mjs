import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Stage82 Wrangler dry-run artifact check: runs `wrangler deploy --dry-run` for
 * the product configuration into the run directory, then records a byte-exact
 * inventory (path, size, sha256) of every emitted module and of the built static
 * assets, plus the pinned Wrangler version. No upload, login or network is
 * involved; the inventory is what Main's deployment step must match exactly.
 */
const worktree = fileURLToPath(new URL('../../..', import.meta.url))
const run = process.argv[2]
if (!run || !path.isAbsolute(run)) throw new Error('Usage: node tests/cloudflare/plan/dry-run-inventory.mjs <absolute run directory>')
const outdir = path.join(run, 'dry-run')
await mkdir(outdir, { recursive: true })

execFileSync('npx', ['--no-install', 'wrangler', 'deploy', '--dry-run', '--outdir', outdir, '--config', 'wrangler.jsonc'], {
  cwd: worktree, stdio: 'inherit', env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1' },
})

async function inventory(root) {
  const files = []
  async function walk(directory) {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) {
      const file = path.join(directory, entry.name)
      if (entry.isSymbolicLink()) throw new Error(`Symbolic link in artifact output: ${file}`)
      if (entry.isDirectory()) await walk(file)
      else {
        const bytes = await readFile(file)
        files.push({ path: path.relative(root, file), bytes: (await stat(file)).size, sha256: createHash('sha256').update(bytes).digest('hex') })
      }
    }
  }
  await walk(root)
  return { root, fileCount: files.length, totalBytes: files.reduce((sum, file) => sum + file.bytes, 0), files }
}

const wranglerVersion = JSON.parse(await readFile(path.join(worktree, 'node_modules/wrangler/package.json'), 'utf8')).version
const report = {
  version: 1, at: new Date().toISOString(), wranglerVersion, config: 'wrangler.jsonc',
  artifact: await inventory(outdir), assets: await inventory(path.join(worktree, 'dist-cloudflare')),
}
if (wranglerVersion !== '4.147.0') throw new Error(`Unexpected Wrangler version ${wranglerVersion}; the plan pins 4.147.0`)
if (!report.artifact.files.some(file => /\.m?js$/.test(file.path))) throw new Error('The dry run emitted no Worker module')
if (report.assets.fileCount > 20_000 || report.assets.files.some(file => file.bytes > 25 * 1024 * 1024)) throw new Error('Static assets exceed the free plan limits')
await writeFile(path.join(run, 'dry-run-inventory.json'), `${JSON.stringify(report, null, 2)}\n`)
console.log(JSON.stringify({ wranglerVersion, artifactFiles: report.artifact.fileCount, artifactBytes: report.artifact.totalBytes, assetFiles: report.assets.fileCount, assetBytes: report.assets.totalBytes }))
