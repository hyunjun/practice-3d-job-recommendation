import { existsSync } from 'node:fs'
import { defineConfig } from '@playwright/test'

const hasSystemChrome = process.platform === 'darwin' && existsSync('/Applications/Google Chrome.app')
const baseURL = process.env.ORBIT_TEST_BASE_URL ?? 'http://127.0.0.1:5173'

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 30000,
  expect: { timeout: 8000 },
  reporter: [['list'], ['html', { open: 'never' }]],
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
    command: 'npm run dev',
    url: `${baseURL}/api/health`,
    env: { PORT: new URL(baseURL).port || '5173' },
    reuseExistingServer: !process.env.CI,
    timeout: 30000,
  },
})
