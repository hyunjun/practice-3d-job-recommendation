import type { City, CityResult } from '../../shared/types'

/** The animation loop needs city coordinates and company identities, not job bodies. */
export interface GlobeCity {
  city: City
  companyIds: ReadonlySet<string>
  companyCount: number
}

export function createGlobeCities(results: readonly CityResult[]): GlobeCity[] {
  return results.map(({ city, matches }) => {
    const companyIds = new Set(matches.map(match => match.company.id))
    return { city, companyIds, companyCount: companyIds.size }
  })
}

/** Cache only within one immutable set of city results, including overlapping companies. */
export function createClusterCompanyCounter(cities: readonly GlobeCity[]): (cityIds: readonly string[]) => number {
  const companies = new Map(cities.map(city => [city.city.id, city.companyIds]))
  const counts = new Map<string, number>()
  return cityIds => {
    const key = JSON.stringify([...new Set(cityIds)].sort())
    const previous = counts.get(key)
    if (previous !== undefined) return previous
    const unique = new Set<string>()
    for (const cityId of cityIds) {
      for (const companyId of companies.get(cityId) ?? []) unique.add(companyId)
    }
    // Many pan/zoom combinations must not retain an unbounded history of clusters.
    if (counts.size >= 256) counts.delete(counts.keys().next().value!)
    counts.set(key, unique.size)
    return unique.size
  }
}
