import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { FullConfig } from '@playwright/test'

/**
 * Global setup for the scheduled-build UI runtime. It refuses any server that is
 * not the test-only entry on the owned loopback origin serving the exact built
 * `dist-cloudflare/index.html`, before any browser navigation.
 */
const worktree = fileURLToPath(new URL('../../../..', import.meta.url))

export default async function requireScheduledUiServer(config: FullConfig) {
  const origins = new Set(config.projects.map(project => new URL(project.use.baseURL!).origin))
  assert.equal(origins.size, 1, 'Scheduled UI projects must share one owned origin.')
  const [origin] = origins
  const url = new URL(origin)
  assert.equal(url.hostname, '127.0.0.1', 'Scheduled UI tests run only against loopback.')
  assert.notEqual(url.port, '8787', 'Port 8787 belongs to another project and is never used.')
  const identity = await fetch(new URL('/__test/identity', origin), { signal: AbortSignal.timeout(5000) })
  assert.equal(identity.status, 200)
  const body = await identity.json()
  assert.deepEqual(
    { harness: body.harness, storeName: body.storeName, entry: body.entry },
    { harness: 'orbit-worker-contract', storeName: 'catalog-v1', entry: 'tests/cloudflare/runtime/entry.ts' },
    'Refusing UI tests: the server is not the stage82 test-only entry.',
  )
  const health = await fetch(new URL('/api/health', origin), { signal: AbortSignal.timeout(5000) })
  assert.equal(health.status, 200)
  const status = await health.json()
  assert.equal(status.delivery, 'scheduled', 'The product handler must be the scheduled Worker.')
  assert.equal(status.app, 'orbit')
  const builtIndex = await readFile(path.join(worktree, 'dist-cloudflare/index.html'), 'utf8')
  assert.ok(builtIndex.includes('<div id="root"></div>'), 'dist-cloudflare/index.html is not the built application shell.')
  const shell = await fetch(new URL('/', origin), { signal: AbortSignal.timeout(5000) })
  assert.equal(shell.status, 200)
  assert.equal(await shell.text(), builtIndex, 'The served shell must be exactly the built dist-cloudflare/index.html.')
  await readFile(path.join(worktree, 'dist-cloudflare/_headers'), 'utf8')
}
