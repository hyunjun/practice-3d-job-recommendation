import assert from 'node:assert/strict'
import type { FullConfig } from '@playwright/test'

/** Global setup completes before any browser navigation. Never accept a live dev server. */
export default async function requireSyntheticDefaultServer(config: FullConfig) {
  const mode = process.env.ORBIT_TEST_MODE ?? 'development'
  assert.ok(mode === 'development' || mode === 'production', 'Invalid ORBIT_TEST_MODE.')
  const origins = new Set(config.projects.map(project => new URL(project.use.baseURL!).origin))
  assert.equal(origins.size, 1, 'Default E2E projects must use one owned synthetic app server.')
  const [origin] = origins
  const response = await fetch(new URL('/api/health', origin), { signal: AbortSignal.timeout(5000) })
  assert.equal(response.status, 200)
  const health = await response.json()
  assert.equal(health.mode, mode, 'The synthetic E2E server mode does not match ORBIT_TEST_MODE.')
  assert.deepEqual({
    fixture: health.fixture, companies: health.fixtureCompanies,
    jobs: health.fixtureJobs, cities: health.fixtureCities,
  }, { fixture: 'synthetic-public', companies: 3, jobs: 29, cities: 22 },
  'Refusing E2E navigation: the app server is not the test-only synthetic public fixture.')
}
