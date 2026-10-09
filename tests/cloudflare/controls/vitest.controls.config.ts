import { defineConfig } from 'vitest/config'

/**
 * Stage82 validation-control fault checks against isolated synthetic copies of
 * the exact approved control bytes. Selected explicitly with
 * `vitest run --config tests/cloudflare/controls/vitest.controls.config.ts`;
 * never part of `npm run check`. Serial: every scenario shares one synthetic
 * stage whose validation lock serializes workers.
 */
export default defineConfig({
  test: {
    include: ['tests/cloudflare/controls/**/*.spec.ts'],
    environment: 'node',
    testTimeout: 180_000,
    hookTimeout: 240_000,
    fileParallelism: false,
    maxWorkers: 1,
  },
})
