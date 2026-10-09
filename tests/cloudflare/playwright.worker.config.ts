import { defineConfig } from '@playwright/test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Stage82 Worker contract runtime: a direct native workerd socket configured from
 * the test-only Wrangler file, on owned loopback port 8790 (never 8787). The
 * default Playwright configuration and its synthetic fixture guard are untouched;
 * this configuration has its own guard in helpers/worker-server-check.ts.
 */
const worktree = fileURLToPath(new URL('../..', import.meta.url))
export const WORKER_BASE_URL = process.env.ORBIT_WORKER_TEST_BASE_URL ?? 'http://127.0.0.1:8790'
export const WORKER_INSPECTOR_PORT = process.env.ORBIT_WORKER_INSPECTOR_PORT ?? '9230'
const endpoint = new URL(WORKER_BASE_URL)
if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1' || endpoint.port === '8787' || endpoint.port === ''
  || endpoint.pathname !== '/' || endpoint.search || endpoint.hash || endpoint.username || endpoint.password) {
  throw new Error('Worker contract tests require an owned loopback URL on an explicit port other than 8787.')
}
if (!/^\d{4,5}$/.test(WORKER_INSPECTOR_PORT) || WORKER_INSPECTOR_PORT === '8787' || WORKER_INSPECTOR_PORT === endpoint.port) {
  throw new Error('The workerd inspector port must be an explicit, distinct, reviewed local port.')
}

export default defineConfig({
  testDir: './',
  testMatch: /worker-.*\.spec\.ts$/,
  globalSetup: './helpers/worker-server-check.ts',
  fullyParallel: false,
  workers: 1,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  outputDir: path.join(worktree, '.local/worker-contract/results'),
  reporter: [['list'], ['json', { outputFile: path.join(worktree, '.local/worker-contract/playwright.json') }]],
  use: { baseURL: WORKER_BASE_URL },
  webServer: {
    command: 'node tests/cloudflare/runtime/serve-native-worker.mjs',
    cwd: worktree,
    url: `${endpoint.origin}/__test/identity`,
    env: { WRANGLER_SEND_METRICS: 'false', CI: '1', ORBIT_WORKER_TEST_BASE_URL: endpoint.origin, ORBIT_WORKER_INSPECTOR_PORT: WORKER_INSPECTOR_PORT },
    // A foreign server could never be the test-only entry; identity is re-checked in globalSetup.
    reuseExistingServer: false,
    timeout: 180_000,
  },
})
