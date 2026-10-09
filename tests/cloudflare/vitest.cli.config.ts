import { defineConfig } from 'vitest/config'

/**
 * Stage82 publish CLI subprocess contracts. Selected explicitly with
 * `vitest run --config tests/cloudflare/vitest.cli.config.ts`; the default
 * vitest configuration (tests/unit/**) and `npm run check` never include it.
 * publish-cli.spec.ts declares eleven tests with thirteen nominal CLI launch
 * sites (two admission tests launch twice); files and tests run serially so the
 * owned child registry and fixture origins are torn down between tests.
 */
export default defineConfig({
  test: {
    include: ['tests/cloudflare/cli/**/*.spec.ts'],
    environment: 'node',
    testTimeout: 180_000,
    hookTimeout: 120_000,
    fileParallelism: false,
    maxWorkers: 1,
  },
})
