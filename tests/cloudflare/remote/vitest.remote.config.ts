import { defineConfig } from 'vitest/config'

/**
 * Local verification of the deployed read-only transport: fake networking plus
 * owned loopback HTTP origins; nothing contacts the production origin. Selected
 * explicitly with `vitest run --config tests/cloudflare/remote/vitest.remote.config.ts`;
 * the default vitest configuration and `npm run check` never include it. The
 * Chromium guard witness is a Playwright spec (playwright.local-guard.config.ts)
 * and is excluded here.
 */
export default defineConfig({
  test: {
    include: ['tests/cloudflare/remote/**/*.spec.ts'],
    exclude: ['**/remote-smoke.spec.ts', '**/local-browser-guard.spec.ts', '**/node_modules/**'],
    environment: 'node',
    testTimeout: 150_000,
    hookTimeout: 60_000,
    fileParallelism: false,
    maxWorkers: 1,
  },
})
