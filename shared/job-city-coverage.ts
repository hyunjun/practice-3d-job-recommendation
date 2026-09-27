import { locateCitiesInCountry } from './city-location'
import { CITY_COVERAGE_VERSION } from './types'
import type { Job } from './types'

// Existing coordinates may have evidence that an older snapshot did not retain.
// A coverage expansion supplements new cities without reinterpreting those IDs.
const ADDED_CITIES = new Set([
  'taipei', 'hsinchu', 'hong-kong', 'bangkok', 'kuala-lumpur', 'manila',
  'auckland', 'wellington', 'christchurch', 'dubai', 'atlanta', 'los-angeles', 'portland',
])

/** Reuse a posting's own location fields; never use its company, body or fetch time as a city. */
export function upgradeJobCityCoverage<T extends Job>(job: T): T {
  if (job.source === 'sample' || job.workMode === 'remote' || job.cityCoverageVersion === CITY_COVERAGE_VERSION) return job
  const cityIds = new Set(job.cityIds)
  if (!job.locationResolution) {
    const locations = job.workplaceLocations?.locations ?? [{ label: job.locationLabel }]
    for (const location of locations) {
      for (const id of locateCitiesInCountry(location.label, location.country)) {
        if (ADDED_CITIES.has(id)) cityIds.add(id)
      }
    }
  }
  return { ...job, cityIds: [...cityIds], cityCoverageVersion: CITY_COVERAGE_VERSION }
}
