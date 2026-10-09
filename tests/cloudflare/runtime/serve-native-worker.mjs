/**
 * Contract-only native workerd HTTP transport. Wrangler's configured bindings,
 * SQLite export, assets and compatibility settings are retained. A direct
 * Miniflare socket avoids its frontend encoding normalization and Wrangler's
 * separate development HTTP proxy. This does not emulate the deployed edge.
 * Capacity/UI keep their separately reviewed launchers and inspector contracts.
 */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import path from 'node:path'
import { build, stop as stopBundler } from 'esbuild'
import { unstable_getMiniflareWorkerOptions } from 'wrangler'

// Resolve Miniflare through the pinned Wrangler dependency, not a second install.
const wranglerRequire = createRequire(import.meta.resolve('wrangler'))
const { Miniflare, convertV4MiniflareOptions, Log, LogLevel } = wranglerRequire('miniflare')
assert.equal(wranglerRequire('miniflare/package.json').version, '5.20261001.0-alpha')

const endpoint = new URL(process.env.ORBIT_WORKER_TEST_BASE_URL ?? 'http://127.0.0.1:8790')
const port = (value, label) => {
  const text = String(value)
  assert.match(text, /^[1-9][0-9]{3,4}$/, `${label} must be a canonical decimal port`)
  const parsed = Number(text)
  assert.ok(parsed >= 1024 && parsed <= 65535 && parsed !== 8787, `${label} must be owned and cannot be 8787`)
  return parsed
}
assert.equal(endpoint.protocol, 'http:')
assert.equal(endpoint.hostname, '127.0.0.1')
assert.equal(endpoint.pathname, '/')
assert.equal(endpoint.search + endpoint.hash + endpoint.username + endpoint.password, '')
const httpPort = port(endpoint.port, 'HTTP port')
const inspectorPort = port(process.env.ORBIT_WORKER_INSPECTOR_PORT ?? '9230', 'inspector port')
assert.notEqual(inspectorPort, httpPort)
const stateRoot = path.resolve('.local/worker-contract/native-state')
const { workerOptions, main, define, externalWorkers } = unstable_getMiniflareWorkerOptions(
  path.resolve('tests/cloudflare/runtime/wrangler.test.jsonc'),
  undefined,
  { overrides: { enableContainers: false } },
)
assert.equal(path.resolve(main ?? ''), path.resolve('tests/cloudflare/runtime/entry.ts'))
assert.equal(externalWorkers.length, 0, 'The native contract runtime must have no external Workers')

let runtime
let stopRequested = false
let requestStop
const stopped = new Promise(resolve => { requestStop = resolve })
const onSignal = () => { stopRequested = true; requestStop() }
process.once('SIGINT', onSignal)
process.once('SIGTERM', onSignal)
try {
  const bundlePath = path.join(stateRoot, 'entry.mjs')
  const bundle = await build({
    entryPoints: [main], outfile: bundlePath, bundle: true, format: 'esm',
    platform: 'browser', target: 'esnext', external: ['cloudflare:*'],
    define, sourcemap: 'inline', write: false, logLevel: 'warning',
  })
  assert.equal(bundle.outputFiles.length, 1)
  if (!stopRequested) {
    runtime = new Miniflare(convertV4MiniflareOptions({
      host: '127.0.0.1', port: 0, inspectorHost: '127.0.0.1', inspectorPort,
      cf: false, logRequests: false, log: new Log(LogLevel.WARN),
      resourcePersistencePath: stateRoot, resourceTmpPath: path.join(stateRoot, 'tmp'),
      telemetry: { enabled: false },
      workers: [{
        ...workerOptions, name: 'job-contract-test',
        modulesRoot: stateRoot,
        modules: [{ type: 'ESModule', path: bundlePath, contents: bundle.outputFiles[0].text }],
        unsafeDirectSockets: [{ host: '127.0.0.1', port: httpPort }],
        unsafeRegisterWorker: false,
      }],
    }))
    await Promise.race([runtime.ready, stopped])
    if (!stopRequested) {
      const direct = await runtime.unsafeGetDirectURL('job-contract-test')
      assert.equal(direct.origin, endpoint.origin, 'Tests must connect to the owned direct workerd socket')
      console.log(`Native Worker contract socket ready at ${direct.origin}`)
      await stopped
    }
  }
} finally {
  try { await runtime?.dispose() }
  finally {
    stopBundler()
    process.removeListener('SIGINT', onSignal)
    process.removeListener('SIGTERM', onSignal)
  }
}
