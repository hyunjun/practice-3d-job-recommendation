import type { CatalogCollectionSnapshot, CatalogCollectionUpdate } from '../../shared/catalog-progress'
import type { Catalog, Company, Job, Profile } from '../../shared/types'
import { PUBLIC_TEST_CITIES } from './public-geography'
import { publicProtocolJob } from './public-protocol'

export const GLOBE_TIME = '2026-09-27T03:00:00.000Z'
export const GLOBE_COLLECTION_ID = '00000000-0000-4000-8000-000000000066'
export const GLOBE_PAIR_QUERY = 'CanalPair'
export const GLOBE_PROFILE: Profile = {
  kind: 'personal', name: 'Globe QA', headline: 'Synthetic engineering profile',
  years: 5, skills: ['TypeScript', 'Python', 'PostgreSQL', 'AWS'],
  desiredRole: 'all', residence: 'GB', linkedinUrl: '',
}

const companyRows = [
  ['aster', 'Globe Aster', 'GA', '#3974cc'],
  ['beacon', 'Globe Beacon', 'GB', '#487950'],
  ['copper', 'Globe Copper', 'GC', '#8750ab'],
  ['delta', 'Globe Delta', 'GD', '#4c778f'],
  ['ember', 'Globe Ember', 'GE', '#ad7345'],
  ['fresnel', 'Globe Fresnel', 'GF', '#84576a'],
  ['grove', 'Globe Grove', 'GG', '#4d785c'],
] as const

export const GLOBE_COMPANIES: Company[] = companyRows.map(([key, name, initials, color]) => ({
  id: `globe-fixture-${key}`, name, initials, color, industry: 'Synthetic globe verification',
  provider: 'greenhouse', board: `globe-fixture-${key}`,
  careerUrl: `https://example.test/globe/${key}/careers`,
}))

const europe = ['london', 'berlin', 'amsterdam', 'paris', 'dublin', 'stockholm', 'zurich', 'barcelona', 'lisbon']
const americas = ['san-francisco', 'new-york', 'seattle', 'austin', 'boston', 'toronto', 'vancouver']
const asia = ['singapore', 'seoul', 'tokyo', 'sydney', 'melbourne', 'bengaluru']
const allCities = [...americas, ...europe, ...asia]
type Stage = 0 | 1 | 2

/**
 * Authored expectations, independent of match/group/summary implementation:
 * - 120 Aster + 100 Beacon + 80 regional jobs in each of 22 cities = 6,600.
 * - Fresnel then contributes 20 jobs in each of nine European cities = 6,780.
 * - Finally Copper's 80 London jobs are replaced by 80 Grove London jobs.
 * London and Amsterdam both still have FOUR companies, but their union becomes
 * FIVE (Aster, Beacon, Copper, Fresnel, Grove). Summing city counts gives eight.
 */
export const GLOBE_EXPECTED = {
  jobs: [6600, 6780, 6780],
  globalCompanies: [5, 6, 7],
  londonJobs: [300, 320, 320],
  londonCompanies: [3, 4, 4],
  amsterdamCompanies: [3, 4, 4],
  pairCompanies: [3, 4, 5],
  londonNames: [
    ['Globe Aster', 'Globe Beacon', 'Globe Copper'],
    ['Globe Aster', 'Globe Beacon', 'Globe Copper', 'Globe Fresnel'],
    ['Globe Aster', 'Globe Beacon', 'Globe Fresnel', 'Globe Grove'],
  ],
  boardJobs: [
    [2640, 2200, 720, 560, 480, 0, 0],
    [2640, 2200, 720, 560, 480, 180, 0],
    [2640, 2200, 640, 560, 480, 180, 80],
  ],
} as const

function companyJobs(index: number, cityIds: string[], copies: number, stage: Stage): Job[] {
  const company = GLOBE_COMPANIES[index]
  return cityIds.flatMap(cityId => {
    const city = PUBLIC_TEST_CITIES.find(item => item.id === cityId)!
    return Array.from({ length: copies }, (_, jobIndex) => {
      const suffix = `${cityId}-${String(jobIndex + 1).padStart(3, '0')}`
      const pair = cityId === 'london' || cityId === 'amsterdam' ? ` ${GLOBE_PAIR_QUERY}` : ''
      return publicProtocolJob(suffix, {
        id: `greenhouse-${company.id}-${suffix}`, companyId: company.id,
        title: `Backend Engineer — ${company.name} ${city.en}${pair} ${String(jobIndex + 1).padStart(3, '0')}`,
        cityIds: [cityId], locationLabel: `${city.en}, ${city.country}`,
        fetchedAt: `2026-09-27T03:00:0${stage}.000Z`,
        url: `https://example.test/globe/${company.id}/${suffix}`,
        description: 'Synthetic globe responsiveness vacancy. No actual employer or job listing.',
      })
    })
  })
}

export function globeCatalog(stage: Stage = 0): Catalog {
  const jobs = [
    ...companyJobs(0, allCities, 120, stage),
    ...companyJobs(1, allCities, 100, stage),
    ...companyJobs(2, stage === 2 ? europe.filter(id => id !== 'london') : europe, 80, stage),
    ...companyJobs(3, americas, 80, stage),
    ...companyJobs(4, asia, 80, stage),
    ...(stage > 0 ? companyJobs(5, europe, 20, stage) : []),
    ...(stage === 2 ? companyJobs(6, ['london'], 80, stage) : []),
  ]
  const fetchedAt = `2026-09-27T03:00:0${stage}.000Z`
  return {
    source: 'public', fetchedAt, checkedAt: fetchedAt,
    refreshAfter: '2026-09-27T09:00:00.000Z',
    stale: false, unmappedCount: 0,
    cities: structuredClone(PUBLIC_TEST_CITIES), companies: structuredClone(GLOBE_COMPANIES), jobs,
    boards: GLOBE_COMPANIES.map((company, index) => {
      const pending = index > 4 + stage
      return {
        companyId: company.id, provider: 'greenhouse', board: company.board!,
        status: pending ? 'pending' : 'ok', dataStatus: pending ? 'unavailable' : 'fresh',
        total: GLOBE_EXPECTED.boardJobs[stage][index], included: GLOBE_EXPECTED.boardJobs[stage][index],
        lastSuccessAt: pending ? null : fetchedAt,
        ...(pending ? {} : { checkedAt: fetchedAt }),
      }
    }),
  }
}

export function globeSnapshot(): CatalogCollectionSnapshot {
  return {
    catalog: globeCatalog(0),
    progress: { id: GLOBE_COLLECTION_ID, revision: 1, total: 7, completed: 5, done: false },
  }
}

export function globeUpdate(stage: 1 | 2): CatalogCollectionUpdate {
  const { companies: _companies, cities: _cities, jobs, ...catalog } = globeCatalog(stage)
  const companyIds = stage === 1
    ? ['globe-fixture-fresnel']
    : ['globe-fixture-copper', 'globe-fixture-grove']
  return {
    progress: { id: GLOBE_COLLECTION_ID, revision: stage + 1, total: 7, completed: 5 + stage, done: stage === 2 },
    companyIds, jobs: jobs.filter(job => companyIds.includes(job.companyId)), catalog,
  }
}
