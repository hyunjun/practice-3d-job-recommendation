import { defineConfig } from '@playwright/test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { validateOwnedEndpoints } from './helpers/instrumentation'

/**
 * Stage82 realistic capacity/streaming acceptance on the same local workerd
 * runtime as the contract suite (test-only entry, owned 127.0.0.1:8790, never
 * 8787; explicit inspector port for CPU/heap instrumentation). Separate from the
 * contract configuration so the long realistic cases carry their own timeouts
 * and evidence directory. Both ports are validated as canonical loopback
 * integers (ACR82-3): "08787" normalizes to the foreign port and is refused.
 */
const worktree = fileURLToPath(new URL('../..', import.meta.url))
export const CAPACITY_ENDPOINTS = validateOwnedEndpoints(
  process.env.ORBIT_WORKER_TEST_BASE_URL ?? 'http://127.0.0.1:8790',
  process.env.ORBIT_WORKER_INSPECTOR_PORT ?? '9230',
)

export default defineConfig({
  testDir: './',
  testMatch: /capacity-.*\.spec\.ts$/,
  globalSetup: './helpers/worker-server-check.ts',
  fullyParallel: false,
  workers: 1,
  timeout: 1_800_000,
  expect: { timeout: 60_000 },
  outputDir: path.join(worktree, '.local/worker-capacity/results'),
  reporter: [['list'], ['json', { outputFile: path.join(worktree, '.local/worker-capacity/playwright.json') }]],
  use: { baseURL: CAPACITY_ENDPOINTS.devOrigin },
  webServer: {
    command: [
      'npx', '--no-install', 'wrangler', 'dev',
      '--config', 'tests/cloudflare/runtime/wrangler.test.jsonc',
      '--ip', CAPACITY_ENDPOINTS.host, '--port', String(CAPACITY_ENDPOINTS.devPort),
      '--inspector-port', String(CAPACITY_ENDPOINTS.inspectorPort),
      '--persist-to', '.local/worker-capacity/wrangler-state',
      '--log-level', 'warn',
      '--show-interactive-dev-session=false',
    ].join(' '),
    cwd: worktree,
    url: `${CAPACITY_ENDPOINTS.devOrigin}/__test/identity`,
    env: { WRANGLER_SEND_METRICS: 'false', CI: '1' },
    reuseExistingServer: false,
    timeout: 180_000,
  },
})
