import { existsSync } from 'node:fs'
import { defineConfig } from '@playwright/test'

const hasSystemChrome = process.platform === 'darwin' && existsSync('/Applications/Google Chrome.app')
const mode = process.env.ORBIT_TEST_MODE ?? 'development'
if (mode !== 'development' && mode !== 'production')
  throw new Error('ORBIT_TEST_MODE must be development or production.')
const baseURL = process.env.ORBIT_TEST_BASE_URL ?? 'http://127.0.0.1:5173'
const endpoint = new URL(baseURL)
if (endpoint.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(endpoint.hostname)
  || endpoint.port === '8787' || endpoint.username || endpoint.password
  || endpoint.pathname !== '/' || endpoint.search || endpoint.hash) {
  throw new Error('Default E2E requires an owned loopback synthetic server URL, excluding port 8787.')
}

export default defineConfig({
  testDir: './tests/e2e',
  globalSetup: './tests/e2e/helpers/default-server-check.ts',
  fullyParallel: false,
  workers: 1,
  timeout: 30000,
  expect: { timeout: 8000 },
  outputDir: './.local/playwright/results',
  reporter: [['list'], ['html', { open: 'never', outputFolder: './.local/playwright/report' }]],
  use: {
    baseURL,
    browserName: 'chromium',
    channel: process.env.PLAYWRIGHT_CHANNEL ?? (hasSystemChrome ? 'chrome' : undefined),
    viewport: { width: 1440, height: 960 },
    reducedMotion: 'reduce',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'node --import tsx tests/fixtures/default-e2e-server.ts',
    url: `${endpoint.origin}/api/health`,
    env: { PORT: endpoint.port || '80', HOST: endpoint.hostname, NODE_ENV: mode, ORBIT_TEST_MODE: mode },
    // Reusing an arbitrary dev server would reintroduce real collector/cache access.
    reuseExistingServer: false,
    timeout: 30000,
  },
})
