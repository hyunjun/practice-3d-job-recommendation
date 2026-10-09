import assert from 'node:assert/strict'
import type { FullConfig } from '@playwright/test'

/**
 * Global setup for the Worker contract runtime. It refuses any server that is not
 * the test-only entry on the owned loopback origin, before any request is made.
 */
export default async function requireWorkerContractServer(config: FullConfig) {
  const origins = new Set(config.projects.map(project => new URL(project.use.baseURL!).origin))
  assert.equal(origins.size, 1, 'Worker contract projects must share one owned origin.')
  const [origin] = origins
  const url = new URL(origin)
  assert.equal(url.hostname, '127.0.0.1', 'Worker contract tests run only against loopback.')
  assert.notEqual(url.port, '8787', 'Port 8787 belongs to another project and is never used.')
  const identity = await fetch(new URL('/__test/identity', origin), { signal: AbortSignal.timeout(5000) })
  assert.equal(identity.status, 200)
  const body = await identity.json()
  assert.deepEqual(
    { harness: body.harness, storeName: body.storeName, entry: body.entry },
    { harness: 'orbit-worker-contract', storeName: 'catalog-v1', entry: 'tests/cloudflare/runtime/entry.ts' },
    'Refusing Worker contract tests: the server is not the stage82 test-only entry.',
  )
  const health = await fetch(new URL('/api/health', origin), { signal: AbortSignal.timeout(5000) })
  let healthFailure = 'Worker health must return 200'
  if (health.status !== 200) {
    let healthBody: string
    try { healthBody = (await health.text()).slice(0, 4096) }
    catch (error) { healthBody = `unreadable: ${String(error)}` }
    let storeDiagnostic: unknown
    try {
      const store = await fetch(new URL('/__test/store/state', origin), { signal: AbortSignal.timeout(5000) })
      storeDiagnostic = { status: store.status, body: (await store.text()).slice(0, 4096) }
    } catch (error) {
      storeDiagnostic = { error: String(error) }
    }
    healthFailure = `Worker health must return 200; startup diagnostics: ${JSON.stringify({ healthBody, storeDiagnostic })}`
  }
  assert.equal(health.status, 200, healthFailure)
  const status = await health.json()
  assert.equal(status.delivery, 'scheduled', 'The product handler must be the scheduled Worker.')
  assert.equal(status.app, 'orbit')
}
