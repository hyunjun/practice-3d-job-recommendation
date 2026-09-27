import { describe, expect, test } from 'vitest'
import type { City, CityResult, MatchedJob } from '../../shared/types'
import { createClusterCompanyCounter, createGlobeCities } from '../../src/lib/globe-cities'
import type { GlobeCity } from '../../src/lib/globe-cities'
import { GLOBE_COMPANIES } from '../fixtures/globe-responsiveness'
import { PUBLIC_TEST_CITIES } from '../fixtures/public-geography'
import { publicProtocolJob } from '../fixtures/public-protocol'

const london = PUBLIC_TEST_CITIES.find(city => city.id === 'london')!
const amsterdam = PUBLIC_TEST_CITIES.find(city => city.id === 'amsterdam')!

function match(companyIndex: number, id: string): MatchedJob {
  const company = GLOBE_COMPANIES[companyIndex]
  return {
    company, job: publicProtocolJob(id, { companyId: company.id }),
    score: 80, matchedSkills: ['TypeScript'], missingSkills: [], skillSummary: 'TypeScript',
    reasons: ['Synthetic match'], cautions: [],
  }
}

function result(city: City, companies: number[], companyCount: number): CityResult {
  return {
    city, matches: companies.map((company, index) => match(company, `${city.id}-${index}`)),
    companyCount, averageScore: 80,
  }
}

describe('globe city summaries', () => {
  test('repeated vacancies retain exact city/company identities and authored geographic coordinates', () => {
    const input = [
      result(london, [0, 0, 0, 1, 2, 2], 3),
      result(amsterdam, [0, 1, 1, 2], 3),
    ]
    const summaries = createGlobeCities(input)
    expect(summaries).toHaveLength(2)
    expect(summaries[0].city).toBe(london)
    expect(summaries[1].city).toBe(amsterdam)
    expect(summaries.map(summary => [summary.city.id, summary.city.lat, summary.city.lng, summary.companyCount]))
      .toEqual([['london', 51.5074, -0.1278, 3], ['amsterdam', 52.3676, 4.9041, 3]])
    expect([...summaries[0].companyIds].sort())
      .toEqual(['globe-fixture-aster', 'globe-fixture-beacon', 'globe-fixture-copper'])
    expect([...summaries[1].companyIds].sort())
      .toEqual(['globe-fixture-aster', 'globe-fixture-beacon', 'globe-fixture-copper'])
    // Job detail is not part of the input contract consumed by animation.
    expect(summaries.every(summary => !('matches' in summary))).toBe(true)
    expect(input[0].matches).toHaveLength(6)
    expect(input[1].matches).toHaveLength(4)
  })

  test('empty inputs and cities with no matches produce zero companies', () => {
    expect(createGlobeCities([])).toEqual([])
    const summaries = createGlobeCities([result(london, [], 0)])
    expect(summaries[0].companyCount).toBe(0)
    expect([...summaries[0].companyIds]).toEqual([])
    const count = createClusterCompanyCounter(summaries)
    expect(count([])).toBe(0)
    expect(count(['london'])).toBe(0)
    expect(count(['unknown-city'])).toBe(0)
  })

  test('duplicate companies across a cluster are counted once, including repeated or reordered city IDs', () => {
    const count = createClusterCompanyCounter(createGlobeCities([
      result(london, [0, 0, 1, 2], 3),
      result(amsterdam, [0, 1, 1, 5], 3),
    ]))
    expect(count(['london'])).toBe(3)
    expect(count(['amsterdam'])).toBe(3)
    expect(count(['london', 'amsterdam'])).toBe(4)
    expect(count(['amsterdam', 'london', 'amsterdam'])).toBe(4)
    expect(count(['london', 'unknown-city'])).toBe(3)
    expect(count([])).toBe(0)
  })

  test('a new snapshot invalidates a warm cluster even when both city counts remain four', () => {
    const before = createClusterCompanyCounter(createGlobeCities([
      result(london, [0, 1, 2, 5], 4),
      result(amsterdam, [0, 1, 2, 5], 4),
    ]))
    expect(before(['london', 'amsterdam'])).toBe(4)
    expect(before(['amsterdam', 'london'])).toBe(4)
    const nextCities = createGlobeCities([
      result(london, [0, 1, 5, 6], 4),
      result(amsterdam, [0, 1, 2, 5], 4),
    ])
    expect(nextCities.map(city => city.companyCount)).toEqual([4, 4])
    const after = createClusterCompanyCounter(nextCities)
    expect(after(['london', 'amsterdam'])).toBe(5)
    expect(after(['amsterdam', 'london'])).toBe(5)
    expect(before(['london', 'amsterdam'])).toBe(4)
    const removed = createClusterCompanyCounter(createGlobeCities([result(london, [0], 1)]))
    expect(removed(['london', 'amsterdam'])).toBe(1)
  })

  test('city IDs containing delimiters cannot alias a different cluster cache entry', () => {
    const cities: GlobeCity[] = [
      { city: { ...london, id: 'a_b' }, companyIds: new Set(['one']), companyCount: 1 },
      { city: { ...london, id: 'c' }, companyIds: new Set(['two']), companyCount: 1 },
      { city: { ...london, id: 'a' }, companyIds: new Set(['one']), companyCount: 1 },
      { city: { ...london, id: 'b_c' }, companyIds: new Set(['one']), companyCount: 1 },
    ]
    const count = createClusterCompanyCounter(cities)
    expect(count(['a_b', 'c'])).toBe(2)
    expect(count(['a', 'b_c'])).toBe(1)
    expect(count(['c', 'a_b'])).toBe(2)
  })
})

// Supplemental work-count checks avoid hardware-sensitive timing assertions.
// Literal union assertions above and browser tests remain the correctness oracle.
class ObservedCompanies extends Set<string> {
  iterations = 0
  override [Symbol.iterator]() {
    this.iterations++
    return super[Symbol.iterator]()
  }
}

describe('bounded work while rotating the globe', () => {
  test('a warm canonical cluster, including zero-count clusters, does not reread company sets', () => {
    const a = new ObservedCompanies(['one', 'two'])
    const b = new ObservedCompanies(['one', 'three'])
    const empty = new ObservedCompanies()
    const count = createClusterCompanyCounter([
      { city: london, companyIds: a, companyCount: 2 },
      { city: amsterdam, companyIds: b, companyCount: 2 },
      { city: { ...london, id: 'empty' }, companyIds: empty, companyCount: 0 },
    ])
    expect(count(['london', 'amsterdam'])).toBe(3)
    expect(count(['empty'])).toBe(0)
    const reads = [a.iterations, b.iterations, empty.iterations]
    for (let frame = 0; frame < 1000; frame++) {
      expect(count(frame % 2 ? ['amsterdam', 'london'] : ['london', 'amsterdam', 'london'])).toBe(3)
      expect(count(['empty'])).toBe(0)
    }
    expect([a.iterations, b.iterations, empty.iterations]).toEqual(reads)
  })

  test('hundreds of distinct clusters evict old entries without changing recomputed answers', () => {
    const sets = Array.from({ length: 300 }, () => new ObservedCompanies(['shared']))
    const cities = sets.map((companyIds, index): GlobeCity => ({
      city: { ...london, id: `cache-${index}` }, companyIds, companyCount: 1,
    }))
    const count = createClusterCompanyCounter(cities)
    expect(count(['cache-0'])).toBe(1)
    const reads = sets[0].iterations
    for (let index = 1; index < 300; index++) expect(count([`cache-${index}`])).toBe(1)
    expect(count(['cache-0'])).toBe(1)
    expect(sets[0].iterations).toBeGreaterThan(reads)
    expect(count(['cache-0', 'cache-299'])).toBe(1)
  })
})
