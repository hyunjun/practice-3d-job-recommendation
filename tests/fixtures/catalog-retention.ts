import type { RecoveryAnalysis } from '../../shared/search-recovery'
import type { BoardStatus, Catalog, City, Company, Job, MatchedJob } from '../../shared/types'
import type { CatalogProjection } from '../../src/lib/catalog-worker-types'
import { publicProtocolJob } from './public-protocol'

// Stage73 retained-projection anchor. Every ID, score, count, average, order and
// time in these fixtures is authored by hand. No matching, grouping, aging or
// worker function computes an oracle for the literal unit guards that use them.
export const RETENTION_ASTER_TIME = '2026-10-01T08:00:00.000Z'
export const RETENTION_BIRCH_TIME = '2026-10-01T08:00:01.000Z'
export const RETENTION_CEDAR_TIME = '2026-10-01T08:00:02.000Z'
/** One Cedar London job read an hour before Cedar's board snapshot. */
export const RETENTION_OLDER_CEDAR_TIME = '2026-10-01T07:00:00.000Z'

/** Freshness transitions of the three staggered company snapshots above. */
export const RETENTION_AT = {
  asterStale: '2026-10-01T08:30:00.000Z',
  birchStale: '2026-10-01T08:30:01.000Z',
  cedarStale: '2026-10-01T08:30:02.000Z',
  olderCedarExpired: '2026-10-02T07:00:00.001Z',
  asterExactly24h: '2026-10-02T08:00:00.000Z',
  asterExpired: '2026-10-02T08:00:00.001Z',
  birchExpired: '2026-10-02T08:00:01.001Z',
  cedarExpired: '2026-10-02T08:00:02.001Z',
} as const

export const RETENTION_DEADLINES = [
  RETENTION_AT.asterStale, RETENTION_AT.birchStale, RETENTION_AT.cedarStale,
  RETENTION_AT.asterExpired, RETENTION_AT.birchExpired, RETENTION_AT.cedarExpired,
].map(time => Date.parse(time))

export const RETENTION_COMPANIES: Company[] = [
  {
    id: 'retention-aster', name: 'Aster Retention', initials: 'AR', color: '#3974cc',
    industry: 'Fictional retention QA', provider: 'greenhouse', board: 'retention-aster',
    careerUrl: 'https://example.test/retention/aster',
  },
  {
    id: 'retention-birch', name: 'Birch Retention', initials: 'BR', color: '#497b55',
    industry: 'Fictional retention QA', provider: 'greenhouse', board: 'retention-birch',
    careerUrl: 'https://example.test/retention/birch',
  },
  {
    id: 'retention-cedar', name: 'Cedar Retention', initials: 'CR', color: '#9467bd',
    industry: 'Fictional retention QA', provider: 'greenhouse', board: 'retention-cedar',
    careerUrl: 'https://example.test/retention/cedar',
  },
]

export const RETENTION_CITIES: City[] = [
  {
    id: 'london', name: '런던', en: 'London', country: '영국', countryCode: 'GB', region: 'europe',
    lat: 51.5074, lng: -0.1278, timezone: 'Europe/London', description: 'Fictional retention geography: London.',
  },
  {
    id: 'berlin', name: '베를린', en: 'Berlin', country: '독일', countryCode: 'DE', region: 'europe',
    lat: 52.52, lng: 13.405, timezone: 'Europe/Berlin', description: 'Fictional retention geography: Berlin.',
  },
  // Present in the catalog but outside the applied "europe" region of the anchor.
  {
    id: 'tokyo', name: '도쿄', en: 'Tokyo', country: '일본', countryCode: 'JP', region: 'asia-pacific',
    lat: 35.6762, lng: 139.6503, timezone: 'Asia/Tokyo', description: 'Fictional retention geography: Tokyo.',
  },
]

type CompanyKey = 'aster' | 'birch' | 'cedar'
/** Overrides stay within the public-source job shape that publicProtocolJob accepts. */
type PublicJobChanges = Partial<ReturnType<typeof publicProtocolJob>>
const TIMES: Record<CompanyKey, string> = {
  aster: RETENTION_ASTER_TIME, birch: RETENTION_BIRCH_TIME, cedar: RETENTION_CEDAR_TIME,
}

function vacancy(company: CompanyKey, suffix: string, changes: PublicJobChanges = {}): Job {
  const companyId = `retention-${company}`
  return publicProtocolJob(suffix, {
    id: `greenhouse-${companyId}-${suffix}`, companyId,
    title: `Backend Engineer — Retention ${suffix}`, fetchedAt: TIMES[company], stale: false,
    url: `https://example.test/retention/${company}/${suffix}`,
    ...changes,
  })
}

function fact(job: Job, company: Company, score: number): MatchedJob {
  return {
    job, company, score, matchedSkills: ['TypeScript'], missingSkills: [],
    skillSummary: 'TypeScript 경험 일치', reasons: [`Fictional retention reason for ${job.id}`], cautions: [],
  }
}

function board(company: Company, total: number, included: number, time: string): BoardStatus {
  return {
    companyId: company.id, provider: company.provider ?? 'greenhouse', board: company.board!, status: 'ok', dataStatus: 'fresh',
    total, included, checkedAt: time, lastSuccessAt: time,
  }
}

export interface RetentionAnchorOptions {
  /** A non-null recovery proves derived views null it without copying anything else. */
  recovery?: RecoveryAnalysis | null
  /** Adds one Cedar London job whose fetchedAt cannot be parsed. */
  invalidTimestampJob?: boolean
  /** Adds Cedar job c3, read an hour before Cedar's own board snapshot. */
  olderCedarJob?: boolean
  /** Birch board carries no usable lastSuccessAt: omitted (legacy) or unparseable. */
  birchBoardTime?: 'legacy-missing' | 'unparseable'
}

/**
 * Anchor as the worker would have published it for the "europe" region with
 * default filters. Match order is score descending, then company name, then
 * job ID. Scores are authored literals:
 *   a1 90 · b2 85 · a3 80 · b1 80 · a2 70 · c1 70 · c2 70 · b3 50 (· c3 60 · x1 40)
 * London  = a1, b1, c1, c2  → 3 companies, average 77.5
 * Berlin  = b2, a2, c2      → 3 companies, average 75
 * remote  = a3 · unmapped = b3 · c2 also lists Tokyo, which the region excluded.
 */
export function retentionAnchor(options: RetentionAnchorOptions = {}): CatalogProjection {
  const [aster, birch, cedar] = structuredClone(RETENTION_COMPANIES)
  const [london, berlin, tokyo] = structuredClone(RETENTION_CITIES)
  const a1 = vacancy('aster', 'a1')
  const a2 = vacancy('aster', 'a2', { cityIds: ['berlin'], locationLabel: 'Berlin, Germany' })
  const a3 = vacancy('aster', 'a3', {
    cityIds: [], workMode: 'remote', locationLabel: 'Remote, United Kingdom', remoteCountries: ['GB'],
  })
  const b1 = vacancy('birch', 'b1')
  const b2 = vacancy('birch', 'b2', { cityIds: ['berlin'], locationLabel: 'Berlin, Germany' })
  const b3 = vacancy('birch', 'b3', { cityIds: [], locationLabel: 'Oxford, United Kingdom' })
  const c1 = vacancy('cedar', 'c1')
  const c2 = vacancy('cedar', 'c2', { cityIds: ['london', 'berlin', 'tokyo'], locationLabel: 'London · Berlin · Tokyo' })
  const c3 = options.olderCedarJob ? vacancy('cedar', 'c3', { fetchedAt: RETENTION_OLDER_CEDAR_TIME }) : undefined
  const invalid = options.invalidTimestampJob ? vacancy('cedar', 'x1', { fetchedAt: 'not-a-timestamp' }) : undefined
  const matchOf = {
    a1: fact(a1, aster, 90), b2: fact(b2, birch, 85), a3: fact(a3, aster, 80), b1: fact(b1, birch, 80),
    a2: fact(a2, aster, 70), c1: fact(c1, cedar, 70), c2: fact(c2, cedar, 70), b3: fact(b3, birch, 50),
  }
  const matches = [matchOf.a1, matchOf.b2, matchOf.a3, matchOf.b1, matchOf.a2, matchOf.c1, matchOf.c2, matchOf.b3]
  const londonMatches = [matchOf.a1, matchOf.b1, matchOf.c1, matchOf.c2]
  if (c3) {
    const extra = fact(c3, cedar, 60)
    matches.splice(7, 0, extra)
    londonMatches.push(extra)
  }
  if (invalid) {
    const extra = fact(invalid, cedar, 40)
    matches.push(extra)
    londonMatches.push(extra)
  }
  const londonAverage = londonMatches.reduce((sum, match) => sum + match.score, 0) / londonMatches.length
  const cities = [
    { city: london, matches: londonMatches, companyCount: 3, averageScore: londonAverage },
    { city: berlin, matches: [matchOf.b2, matchOf.a2, matchOf.c2], companyCount: 3, averageScore: 75 },
  ]
  const jobs = [a1, a2, a3, b1, b2, b3, c1, c2, ...(c3 ? [c3] : []), ...(invalid ? [invalid] : [])]
  const cedarJobs = 2 + (c3 ? 1 : 0) + (invalid ? 1 : 0)
  const birchBoard = board(birch, 3, 3, RETENTION_BIRCH_TIME)
  if (options.birchBoardTime === 'legacy-missing') {
    delete birchBoard.lastSuccessAt
    delete birchBoard.checkedAt
  } else if (options.birchBoardTime === 'unparseable') {
    birchBoard.lastSuccessAt = 'legacy'
  }
  const catalog: Catalog = {
    source: 'public', fetchedAt: RETENTION_CEDAR_TIME, checkedAt: RETENTION_CEDAR_TIME, stale: false,
    companies: [aster, birch, cedar], cities: [london, berlin, tokyo], jobs,
    boards: [board(aster, 3, 3, RETENTION_ASTER_TIME), birchBoard, board(cedar, cedarJobs, cedarJobs, RETENTION_CEDAR_TIME)],
    unmappedCount: 1,
  }
  return {
    revision: 4, catalog, matches, cities,
    remote: [matchOf.a3], unmapped: [matchOf.b3],
    globeCities: cities.map(result => ({
      city: result.city, companyIds: new Set(result.matches.map(match => match.company.id)), companyCount: 3,
    })),
    companyCount: 3, recovery: options.recovery ?? null, expired: false,
    deadlines: [...new Set([
      ...RETENTION_DEADLINES,
      ...(c3 ? [Date.parse('2026-10-01T07:30:00.000Z'), Date.parse(RETENTION_AT.olderCedarExpired)] : []),
    ])].sort((a, b) => a - b),
  }
}

/** A validated empty public catalog: a successful read with no postings. */
export function retentionEmptyAnchor(): CatalogProjection {
  const [aster, birch, cedar] = structuredClone(RETENTION_COMPANIES)
  const catalog: Catalog = {
    source: 'public', fetchedAt: RETENTION_CEDAR_TIME, checkedAt: RETENTION_CEDAR_TIME, stale: false,
    companies: [aster, birch, cedar], cities: structuredClone(RETENTION_CITIES), jobs: [],
    boards: [
      board(aster, 0, 0, RETENTION_ASTER_TIME), board(birch, 0, 0, RETENTION_BIRCH_TIME), board(cedar, 0, 0, RETENTION_CEDAR_TIME),
    ],
    unmappedCount: 0,
  }
  return {
    revision: 2, catalog, matches: [], cities: [], remote: [], unmapped: [], globeCities: [],
    companyCount: 0, recovery: { available: 0, profileExcluded: 0, suggestions: [], alternatives: [] },
    expired: false, deadlines: [...RETENTION_DEADLINES],
  }
}

/** A nonempty valid catalog whose applied filters matched nothing. Not an expired catalog. */
export function retentionZeroMatchAnchor(): CatalogProjection {
  const base = retentionAnchor()
  return {
    ...base, matches: [], cities: [], remote: [], unmapped: [], globeCities: [], companyCount: 0,
    recovery: { available: 8, profileExcluded: 0, suggestions: [], alternatives: [] },
  }
}

/** The projection a worker publishes after every company passed its 24-hour limit. */
export function retentionExpiredAnchor(): CatalogProjection {
  const [aster, birch, cedar] = structuredClone(RETENTION_COMPANIES)
  const catalog: Catalog = {
    source: 'public', fetchedAt: '', stale: false,
    companies: [aster, birch, cedar], cities: structuredClone(RETENTION_CITIES), jobs: [],
    boards: [aster, birch, cedar].map((company, index): BoardStatus => ({
      companyId: company.id, provider: 'greenhouse', board: company.board!, status: 'ok', dataStatus: 'unavailable',
      total: 0, included: 0, lastSuccessAt: [RETENTION_ASTER_TIME, RETENTION_BIRCH_TIME, RETENTION_CEDAR_TIME][index],
    })),
    unmappedCount: 0,
  }
  return {
    revision: 3, catalog, matches: [], cities: [], remote: [], unmapped: [], globeCities: [],
    companyCount: 0, recovery: null, expired: true, deadlines: [],
  }
}

/** Daily-source freshness: a Himalayas company read at the same instant as Aster. */
export const RETENTION_DAILY_AT = {
  asterStale: RETENTION_AT.asterStale,
  dailyExactly24h: '2026-10-02T08:00:00.000Z',
  bothExpired: '2026-10-02T08:00:00.001Z',
} as const

export function retentionDailyAnchor(): CatalogProjection {
  const [aster] = structuredClone(RETENTION_COMPANIES)
  const daily: Company = {
    id: 'retention-daily', name: 'Daily Retention', initials: 'DR', color: '#b8860b',
    industry: 'Fictional daily job site', provider: 'himalayas', board: 'retention-daily',
    careerUrl: 'https://example.test/retention/daily',
  }
  const [london, berlin, tokyo] = structuredClone(RETENTION_CITIES)
  const a1 = vacancy('aster', 'a1')
  const d1 = publicProtocolJob('d1', {
    id: 'himalayas-retention-daily-d1', companyId: daily.id, source: 'himalayas',
    title: 'Backend Engineer — Daily Retention d1', fetchedAt: RETENTION_ASTER_TIME, stale: false,
    url: 'https://example.test/retention/daily/d1',
  })
  const matches = [fact(a1, aster, 70), fact(d1, daily, 70)]
  const cities = [{ city: london, matches, companyCount: 2, averageScore: 70 }]
  const catalog: Catalog = {
    source: 'public', fetchedAt: RETENTION_ASTER_TIME, checkedAt: RETENTION_ASTER_TIME, stale: false,
    companies: [aster, daily], cities: [london, berlin, tokyo], jobs: [a1, d1],
    boards: [board(aster, 1, 1, RETENTION_ASTER_TIME), board(daily, 1, 1, RETENTION_ASTER_TIME)],
    unmappedCount: 0,
  }
  return {
    revision: 5, catalog, matches, cities, remote: [], unmapped: [],
    globeCities: [{ city: london, companyIds: new Set([aster.id, daily.id]), companyCount: 2 }],
    companyCount: 2, recovery: null, expired: false,
    deadlines: [RETENTION_DAILY_AT.asterStale, RETENTION_DAILY_AT.dailyExactly24h, RETENTION_DAILY_AT.bothExpired].map(time => Date.parse(time)),
  }
}
