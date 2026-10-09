import { defineConfig } from '@playwright/test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { remoteConfigFromEnv } from './ledger'

/**
 * Stage82 deployed READ-ONLY smoke and browser journeys against exactly
 * https://job.hyunjun.workers.dev. No web server is started; the scope (origin,
 * 60-attempt budget, persistent ledger path) comes from the execution runner's
 * environment and is validated by remote-check.ts before any request. The
 * configuration throws when that scope is absent or different.
 */
const worktree = fileURLToPath(new URL('../../..', import.meta.url))
const remote = remoteConfigFromEnv()

export default defineConfig({
  testDir: './',
  testMatch: /remote-.*\.spec\.ts$/,
  globalSetup: './helpers/remote-check.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 180_000,
  expect: { timeout: 20_000 },
  outputDir: path.join(worktree, '.local/remote-smoke/results'),
  reporter: [['list'], ['json', { outputFile: path.join(worktree, '.local/remote-smoke/playwright.json') }]],
  use: {
    baseURL: remote.origin,
    browserName: 'chromium',
    channel: process.env.PLAYWRIGHT_CHANNEL ?? 'chromium',
    viewport: { width: 1440, height: 960 },
    reducedMotion: 'reduce',
    serviceWorkers: 'block',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
})
