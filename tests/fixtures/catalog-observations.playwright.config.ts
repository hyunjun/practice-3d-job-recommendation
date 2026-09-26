import { defineConfig } from '@playwright/test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import original from '../../playwright.config'

const repository = fileURLToPath(new URL('../../', import.meta.url))
const evidence = process.env.ORBIT_OBSERVATIONS_EVIDENCE ?? path.join(repository, '.local/research/60/independent')
const run = process.env.ORBIT_OBSERVATIONS_RUN ?? 'e2e'

// These tests own every application process. Never start the ordinary suite
// server, contact its public providers, or borrow the user's preview process.
export default defineConfig({
  ...original,
  testDir: path.join(repository, 'tests/e2e'),
  testMatch: 'catalog-observations.spec.ts',
  webServer: [],
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 60_000,
  outputDir: path.join(evidence, run, 'test-results'),
  reporter: [['list'], ['json', { outputFile: path.join(evidence, run, 'results.json') }]],
})
