import { defineConfig } from '@playwright/test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Local Chromium witness for the deployed read-only browser guard
 * (tests/cloudflare/remote/local-browser-guard.spec.ts): real Chromium requests
 * against owned loopback HTTP origins started by the spec itself. No web server
 * is configured here, no remote scope is read and nothing contacts the
 * production origin. The remote smoke configuration does not match this spec
 * (its testMatch requires the `remote-` prefix).
 */
const worktree = fileURLToPath(new URL('../../..', import.meta.url))

export default defineConfig({
  testDir: './',
  testMatch: /local-browser-guard\.spec\.ts$/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 180_000,
  expect: { timeout: 20_000 },
  outputDir: path.join(worktree, '.local/remote-guard/results'),
  reporter: [['list'], ['json', { outputFile: path.join(worktree, '.local/remote-guard/playwright.json') }]],
  use: {
    browserName: 'chromium',
    channel: process.env.PLAYWRIGHT_CHANNEL ?? 'chromium',
    viewport: { width: 1280, height: 800 },
    serviceWorkers: 'block',
    trace: 'retain-on-failure',
  },
})
