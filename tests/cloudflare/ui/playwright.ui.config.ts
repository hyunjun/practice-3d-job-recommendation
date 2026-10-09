import { defineConfig } from '@playwright/test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Stage82 local scheduled-build UI E2E: the built `dist-cloudflare` assets and the
 * real Worker/SQLite Durable Object in local workerd on the owned loopback port
 * 8790 (never 8787), started from the test-only wrangler configuration. The
 * default Playwright configuration and its Express fixture guard are untouched;
 * this configuration has its own guard in helpers/ui-server-check.ts.
 */
const worktree = fileURLToPath(new URL('../../..', import.meta.url))
export const UI_BASE_URL = process.env.ORBIT_WORKER_TEST_BASE_URL ?? 'http://127.0.0.1:8790'
export const UI_INSPECTOR_PORT = process.env.ORBIT_WORKER_INSPECTOR_PORT ?? '9230'
const endpoint = new URL(UI_BASE_URL)
if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1' || endpoint.port === '8787' || endpoint.port === ''
  || endpoint.pathname !== '/' || endpoint.search || endpoint.hash || endpoint.username || endpoint.password) {
  throw new Error('Scheduled UI tests require an owned loopback URL on an explicit port other than 8787.')
}
if (!/^\d{4,5}$/.test(UI_INSPECTOR_PORT) || UI_INSPECTOR_PORT === '8787' || UI_INSPECTOR_PORT === endpoint.port) {
  throw new Error('The wrangler inspector port must be an explicit, distinct, reviewed local port.')
}

export default defineConfig({
  testDir: './',
  testMatch: /scheduled-ui.*\.spec\.ts$/,
  globalSetup: './helpers/ui-server-check.ts',
  fullyParallel: false,
  workers: 1,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  outputDir: path.join(worktree, '.local/worker-ui/results'),
  reporter: [['list'], ['json', { outputFile: path.join(worktree, '.local/worker-ui/playwright.json') }]],
  use: {
    baseURL: UI_BASE_URL,
    browserName: 'chromium',
    channel: process.env.PLAYWRIGHT_CHANNEL ?? 'chromium',
    viewport: { width: 1440, height: 960 },
    reducedMotion: 'reduce',
    serviceWorkers: 'block',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: [
      'npx', '--no-install', 'wrangler', 'dev',
      '--config', 'tests/cloudflare/ui/wrangler.ui.jsonc',
      '--ip', endpoint.hostname, '--port', endpoint.port,
      '--inspector-port', UI_INSPECTOR_PORT,
      '--persist-to', '.local/worker-ui/wrangler-state',
      '--log-level', 'warn',
      '--show-interactive-dev-session=false',
    ].join(' '),
    cwd: worktree,
    url: `${endpoint.origin}/__test/identity`,
    env: { WRANGLER_SEND_METRICS: 'false', CI: '1' },
    reuseExistingServer: false,
    timeout: 180_000,
  },
})
