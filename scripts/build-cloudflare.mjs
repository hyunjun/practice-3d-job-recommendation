import { execFileSync } from 'node:child_process'
import { cp, mkdir, readdir, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const run = (script, args = [], env = process.env) =>
  execFileSync(process.execPath, [path.join(root, script), ...args], { cwd: root, stdio: 'inherit', env })

run('scripts/prepare-assets.mjs')
run('node_modules/typescript/bin/tsc', ['--noEmit'])
run('node_modules/typescript/bin/tsc', ['--project', 'tsconfig.worker.json', '--noEmit'])
run('node_modules/vite/bin/vite.js', ['build', '--outDir', 'dist-cloudflare'], {
  ...process.env, VITE_CATALOG_MODE: 'scheduled',
})
const output = path.join(root, 'dist-cloudflare')
await mkdir(path.join(output, 'legal'), { recursive: true })
await cp(path.join(root, 'docs/attributions.md'), path.join(output, 'legal/attributions.md'))
await cp(path.join(root, 'docs/licenses'), path.join(output, 'legal/licenses'), { recursive: true })
// Static Assets supplies public,max-age=0,must-revalidate by default. Define
// Cache-Control only once for /assets/* so matched rules cannot concatenate it.
await writeFile(path.join(output, '_headers'), `/*
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin
  Permissions-Policy: camera=(), microphone=(), geolocation=()
  X-Frame-Options: DENY

/assets/*
  Cache-Control: public, max-age=31536000, immutable

/pdf/cmaps/*.bcmap
  Content-Type: application/octet-stream
`)
let files = 0
let bytes = 0
async function inspect(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name)
    if (entry.isSymbolicLink()) throw new Error('Static asset symlinks are not supported')
    if (entry.isDirectory()) await inspect(file)
    else {
      const size = (await stat(file)).size
      if (size > 25 * 1024 * 1024) throw new Error(`Static asset exceeds 25 MiB: ${path.relative(output, file)}`)
      files++
      bytes += size
    }
  }
}
await inspect(output)
if (files > 20_000) throw new Error('Static asset count exceeds the free plan limit')
console.log(JSON.stringify({ output: 'dist-cloudflare', files, bytes, catalogMode: 'scheduled' }))
