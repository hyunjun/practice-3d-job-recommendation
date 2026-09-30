import { ageCatalog } from '../../shared/catalog-freshness'
import { compareCityResults, summarizeCityMatches } from '../../shared/matching'
import type { MatchedJob } from '../../shared/types'
import type { CatalogProjection } from './catalog-worker-types'
import { createGlobeCities } from './globe-cities'

export function projectionBoundary(deadlines: readonly number[], now: number): number {
  return deadlines.reduce((latest, time) => time <= now ? Math.max(latest, time) : latest, 0)
}

/**
 * Retain only the recommendations actually displayed for one profile/filter intent.
 * Selection and scores are per job, independent of other jobs and freshness. If that
 * premise changes, this age-only subset must be redesigned alongside matching.
 */
export function createRetainedProjection(anchor: CatalogProjection): (now: number) => CatalogProjection {
  let previousBoundary: number | undefined
  let previous: CatalogProjection | undefined
  return now => {
    const boundary = projectionBoundary(anchor.deadlines, now)
    if (previous && previousBoundary === boundary) return previous
    const { catalog, expired } = ageCatalog(anchor.catalog, now)
    if (catalog === anchor.catalog) {
      previous = anchor.recovery ? { ...anchor, recovery: null } : anchor
    } else {
      const jobs = new Map(catalog.jobs.map(job => [job.id, job]))
      const matches = anchor.matches.flatMap(match => {
        const job = jobs.get(match.job.id)
        return job ? [job === match.job ? match : { ...match, job }] : []
      })
      const selected = new Map(matches.map(match => [match.job.id, match]))
      const retain = (items: MatchedJob[]) => items.flatMap(match => {
        const remaining = selected.get(match.job.id)
        return remaining ? [remaining] : []
      })
      // Preserve the applied region and original group membership; never regroup
      // against the user's newly requested filters while the worker is unavailable.
      const cities = anchor.cities.flatMap(result => {
        const remaining = retain(result.matches)
        return remaining.length ? [summarizeCityMatches(result.city, remaining)] : []
      }).sort(compareCityResults)
      previous = {
        ...anchor, catalog, matches, cities,
        remote: retain(anchor.remote), unmapped: retain(anchor.unmapped),
        globeCities: createGlobeCities(cities),
        companyCount: new Set(matches.map(match => match.company.id)).size,
        recovery: null, expired: anchor.expired || expired,
      }
    }
    previousBoundary = boundary
    return previous
  }
}
