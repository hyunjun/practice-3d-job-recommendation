// Literal fictional inputs only. No product registry/normalizer/upgrader computes them.
import type { Catalog, City, Company, Filters, Job, Profile, SavedJob } from '../../shared/types'
import { COMPENSATION_VERSION } from '../../shared/types'
import { PUBLIC_TEST_CITIES } from './public-geography'

export const REGIONAL_TIME = '2026-09-27T06:00:00.000Z'
export const REGIONAL_NOW = '2026-09-27T06:00:10.000Z'
export const REGIONAL_LATER = '2026-09-27T06:05:00.000Z'
export const REGIONAL_NOTE = 'PRIVATE_REGIONAL70 — 두바이 원문과 지원 메모 보존 🌿'
export const REGIONAL_BODY = 'Fictional backend engineering vacancy.\nRequirements: experience with TypeScript.'

export const REGIONAL_COMPANY: Company = {
  id: 'regional-cedar', name: 'Cedar Route Laboratory', initials: 'CR', color: '#3974cc',
  industry: 'Fictional regional verification', provider: 'greenhouse', board: 'RegionalCedar70',
  careerUrl: 'https://example.test/regional-cedar/careers',
}
export const REGIONAL_PROFILE: Profile = {
  kind: 'personal', name: 'PRIVATE_REGIONAL70_PROFILE', headline: 'Backend Engineer', years: 5,
  desiredRole: 'backend', skills: ['TypeScript'], residence: 'AE', linkedinUrl: '',
}
export const REGIONAL_FILTERS: Filters = {
  query: '', region: 'all', role: 'backend', workMode: 'all', visa: 'all',
  employment: 'all', postingType: 'opening', salaryMin: 0,
  includeUnknownSalary: true, remoteEligibleOnly: true,
}

// These 13 city rows are authored independently of shared/cities.ts.
const newCityRows: [string, string, string, string, string, City['region'], number, number, string][] = [
  ['taipei', '타이베이', 'Taipei', '대만', 'TW', 'asia-pacific', 25.033, 121.5654, 'Asia/Taipei'],
  ['hsinchu', '신주', 'Hsinchu', '대만', 'TW', 'asia-pacific', 24.8138, 120.9675, 'Asia/Taipei'],
  ['hong-kong', '홍콩', 'Hong Kong', '홍콩', 'HK', 'asia-pacific', 22.3193, 114.1694, 'Asia/Hong_Kong'],
  ['bangkok', '방콕', 'Bangkok', '태국', 'TH', 'asia-pacific', 13.7563, 100.5018, 'Asia/Bangkok'],
  ['kuala-lumpur', '쿠알라룸푸르', 'Kuala Lumpur', '말레이시아', 'MY', 'asia-pacific', 3.139, 101.6869, 'Asia/Kuala_Lumpur'],
  ['manila', '마닐라', 'Manila', '필리핀', 'PH', 'asia-pacific', 14.5995, 120.9842, 'Asia/Manila'],
  ['auckland', '오클랜드', 'Auckland', '뉴질랜드', 'NZ', 'asia-pacific', -36.8485, 174.7633, 'Pacific/Auckland'],
  ['wellington', '웰링턴', 'Wellington', '뉴질랜드', 'NZ', 'asia-pacific', -41.2866, 174.7756, 'Pacific/Auckland'],
  ['christchurch', '크라이스트처치', 'Christchurch', '뉴질랜드', 'NZ', 'asia-pacific', -43.5321, 172.6362, 'Pacific/Auckland'],
  ['dubai', '두바이', 'Dubai', '아랍에미리트', 'AE', 'middle-east', 25.2048, 55.2708, 'Asia/Dubai'],
  ['atlanta', '애틀랜타', 'Atlanta', '미국', 'US', 'americas', 33.749, -84.388, 'America/New_York'],
  ['los-angeles', '로스앤젤레스', 'Los Angeles', '미국', 'US', 'americas', 34.0522, -118.2437, 'America/Los_Angeles'],
  ['portland', '포틀랜드', 'Portland', '미국', 'US', 'americas', 45.5152, -122.6784, 'America/Los_Angeles'],
]
export const REGIONAL_NEW_CITIES: City[] = newCityRows.map(([id, name, en, country, countryCode, region, lat, lng, timezone]) => ({
  id, name, en, country, countryCode, region, lat, lng, timezone,
  description: `Synthetic regional geography: ${en}.`,
}))
export const REGIONAL_ORIGINAL_IDS = [
  'san-francisco', 'new-york', 'seattle', 'austin', 'boston', 'toronto', 'vancouver',
  'london', 'berlin', 'amsterdam', 'paris', 'dublin', 'stockholm', 'zurich', 'barcelona', 'lisbon',
  'singapore', 'seoul', 'tokyo', 'sydney', 'melbourne', 'bengaluru',
]
export const REGIONAL_ALL_CITIES: City[] = [
  ...structuredClone(PUBLIC_TEST_CITIES.filter(city => REGIONAL_ORIGINAL_IDS.includes(city.id))),
  ...structuredClone(REGIONAL_NEW_CITIES),
]

export const REGIONAL_NEW_POSTINGS = [
  { id: 'taipei', title: 'Backend Engineer — Taipei Lantern', label: 'Taipei, Taiwan', expected: ['taipei'] },
  { id: 'hsinchu', title: 'Backend Engineer — Hsinchu Relay', label: 'Hsinchu, Taiwan', expected: ['hsinchu'] },
  { id: 'hong-kong', title: 'Backend Engineer — Hong Kong Beacon', label: 'Hong Kong', expected: ['hong-kong'] },
  { id: 'bangkok', title: 'Backend Engineer — Bangkok Compass', label: 'Bangkok, Thailand', expected: ['bangkok'] },
  { id: 'kuala-lumpur', title: 'Backend Engineer — Kuala Lumpur Bridge', label: 'Kuala Lumpur, Malaysia', expected: ['kuala-lumpur'] },
  { id: 'manila', title: 'Backend Engineer — Manila Circuit', label: 'Manila, Philippines', expected: ['manila'] },
  { id: 'auckland', title: 'Backend Engineer — Auckland Harbor', label: 'Auckland, New Zealand', expected: ['auckland'] },
  { id: 'wellington', title: 'Backend Engineer — Wellington Gauge', label: 'Wellington, New Zealand', expected: ['wellington'] },
  { id: 'christchurch', title: 'Backend Engineer — Christchurch Channel', label: 'Christchurch, New Zealand', expected: ['christchurch'] },
  { id: 'dubai', title: 'Backend Engineer — Dubai Ledger', label: 'Dubai, United Arab Emirates', expected: ['dubai'] },
  { id: 'atlanta', title: 'Backend Engineer — Atlanta Cloud', label: 'Atlanta, GA, United States', expected: ['atlanta'] },
  { id: 'los-angeles', title: 'Backend Engineer — Los Angeles Canvas', label: 'Los Angeles, CA, United States', expected: ['los-angeles'] },
  { id: 'portland', title: 'Backend Engineer — Portland Switch', label: 'Portland, OR, United States', expected: ['portland'] },
]

export const REGIONAL_ALIAS_CASES = [
  { label: '타이베이', expected: ['taipei'] },
  { label: '台北', expected: ['taipei'] },
  { label: '臺北', expected: ['taipei'] },
  { label: '신주', expected: ['hsinchu'] },
  { label: '新竹', expected: ['hsinchu'] },
  { label: '홍콩', expected: ['hong-kong'] },
  { label: '香港', expected: ['hong-kong'] },
  { label: '방콕', expected: ['bangkok'] },
  { label: 'กรุงเทพฯ', expected: ['bangkok'] },
  { label: 'กรุงเทพมหานคร', expected: ['bangkok'] },
  { label: '쿠알라룸푸르', expected: ['kuala-lumpur'] },
  { label: '마닐라', expected: ['manila'] },
  { label: '오클랜드', expected: ['auckland'] },
  { label: '웰링턴', expected: ['wellington'] },
  { label: '크라이스트처치', expected: ['christchurch'] },
  { label: '두바이', expected: ['dubai'] },
  { label: 'دبي', expected: ['dubai'] },
  { label: '애틀랜타', expected: ['atlanta'] },
  { label: '로스앤젤레스', expected: ['los-angeles'] },
  { label: '포틀랜드, 오리건', expected: ['portland'] },
  { label: 'Petaling Jaya, Malaysia', expected: ['kuala-lumpur'] },
  { label: 'Makati, Philippines', expected: ['manila'] },
  { label: 'Taguig, Philippines', expected: ['manila'] },
  { label: 'Santa Monica, CA, United States', expected: ['los-angeles'] },
  { label: 'Culver City, CA, United States', expected: ['los-angeles'] },
  { label: 'Beaverton, OR, United States', expected: ['portland'] },
  { label: 'Hillsboro, Oregon, United States', expected: ['portland'] },
  { label: 'Tigard, OR, United States', expected: ['portland'] },
]
export const REGIONAL_NEGATIVE_LABELS = [
  'Taiwan', 'Taiwan, Province of China', '대만', 'New Zealand', '뉴질랜드',
  'United Arab Emirates', 'UAE', '아랍에미리트', 'LA', 'L.A.', 'KL',
  'Portland, ME, United States', 'Portland, Maine', 'Portland, Victoria, Australia',
  'Wellington, FL, United States', 'Wellington, Florida', 'Wellington, Somerset, UK',
  'Wellington, Shropshire, United Kingdom',
  'DubaiX', 'Taipeix', 'Portlandia',
]
export const REGIONAL_MIXED_CASES = [
  { label: 'Portland, ME, United States; Portland, OR, United States', expected: ['portland'] },
  { label: 'Portland, OR, United States; Portland, ME, United States', expected: ['portland'] },
  { label: 'Portland, Victoria, Australia · Portland, Oregon, USA', expected: ['portland'] },
  { label: 'Wellington, Florida, USA / Wellington, New Zealand', expected: ['wellington'] },
  { label: 'Wellington, New Zealand | Wellington, Somerset, UK', expected: ['wellington'] },
  { label: 'Taipei, Taiwan; Hsinchu, Taiwan', expected: ['hsinchu', 'taipei'] },
  { label: 'Kuala Lumpur, Malaysia; Petaling Jaya, Malaysia', expected: ['kuala-lumpur'] },
  { label: 'Manila, Philippines; Makati, Philippines; Taguig, Philippines', expected: ['manila'] },
  { label: 'Los Angeles, California; Santa Monica, California; Culver City, California', expected: ['los-angeles'] },
  { label: 'Portland, OR; Beaverton, OR; Hillsboro, OR; Tigard, OR', expected: ['portland'] },
  { label: 'London, United Kingdom · Dubai, United Arab Emirates', expected: ['dubai', 'london'] },
  { label: 'Wellington, United States and Auckland, New Zealand', expected: ['auckland'] },
  { label: 'Portland, United Kingdom and Atlanta, United States', expected: ['atlanta'] },
  { label: 'Taipei, New Zealand and Auckland, Taiwan', expected: [] },
]

/** Earlier public/saved record, authored directly with no coverage version. */
export type RegionalPublicJob = Job & { source: 'greenhouse'; fetchedAt: string }

export function regionalLegacyJob(id = 'dubai', changes: Partial<RegionalPublicJob> = {}): RegionalPublicJob {
  const title = changes.title ?? 'Backend Engineer — Dubai Ledger'
  return structuredClone({
    id: `greenhouse-regional-cedar-${id}`, companyId: 'regional-cedar', title,
    role: 'backend', cityIds: [], locationLabel: 'Dubai, United Arab Emirates',
    workMode: 'onsite', employment: 'fulltime', employmentVersion: 1,
    minExperience: null, skills: ['TypeScript'], salary: null, compensationVersion: COMPENSATION_VERSION,
    visa: 'unknown', eligibility: { version: 2, rules: [] },
    qualifications: {
      version: 1, experience: [],
      skills: [{ kind: 'required', skills: ['TypeScript'], match: 'all',
        evidence: { source: 'description', text: 'Requirements: experience with TypeScript.' } }],
    },
    languageRequirements: { version: 1, rules: [] }, workTimeRequirements: { version: 1, rules: [] },
    roleClassification: { version: 1, roles: ['backend'], evidence: [{ role: 'backend', source: 'title', text: title }] },
    occupation: { version: 6, category: 'engineering', departments: [],
      evidence: [{ source: 'title', text: title }] },
    remoteCountries: [], remoteWorldwide: false, remoteScopeUnknown: false, remoteScopeVersion: 2,
    description: REGIONAL_BODY, requirements: ['Experience with TypeScript.'],
    url: `https://example.test/regional/${id}`, source: 'greenhouse',
    updatedAt: '2026-09-26T18:30:00.000Z', fetchedAt: REGIONAL_TIME, stale: false,
    ...changes,
  })
}

export function regionalLegacyJobs(): RegionalPublicJob[] {
  return REGIONAL_NEW_POSTINGS.map(row => regionalLegacyJob(row.id, {
    title: row.title, locationLabel: row.label,
  }))
}

export function regionalCatalog(jobs: Job[], unmappedCount: number | null, cities = REGIONAL_NEW_CITIES): Catalog {
  return structuredClone({
    source: 'public', fetchedAt: REGIONAL_TIME, checkedAt: REGIONAL_TIME,
    refreshAfter: '2026-09-27T06:30:00.000Z', stale: false,
    companies: [REGIONAL_COMPANY], cities, jobs, unmappedCount,
    boards: [{
      companyId: 'regional-cedar', provider: 'greenhouse', board: 'RegionalCedar70',
      status: 'ok', dataStatus: 'fresh', checkedAt: REGIONAL_TIME, lastSuccessAt: REGIONAL_TIME,
      total: jobs.length, included: jobs.length,
    }],
  })
}

export function regionalThirtyFiveCatalog(): Catalog {
  // Existing topology stays the explicit historical22. New records start unmapped.
  const original = PUBLIC_TEST_CITIES.filter(city => REGIONAL_ORIGINAL_IDS.includes(city.id))
    .map(city => regionalLegacyJob(`original-${city.id}`, {
      title: `Backend Engineer — Original ${city.en}`, cityIds: [city.id], locationLabel: city.en,
    }))
  return regionalCatalog([...original, ...regionalLegacyJobs()], 13, REGIONAL_ALL_CITIES)
}

export function regionalSavedDubai(): SavedJob {
  return {
    job: regionalLegacyJob(), company: structuredClone(REGIONAL_COMPANY),
    savedAt: '2026-09-26T20:00:00.000Z', status: 'applied', note: REGIONAL_NOTE,
  }
}

export function regionalPartialCatalog(): Catalog {
  return regionalCatalog([
    regionalLegacyJob('partial-baltic', {
      title: 'Backend Engineer — Baltic Bridge',
      locationLabel: 'Tallinn, Estonia · Petaling Jaya, Malaysia',
      workplaceLocations: { version: 1, locations: [
        { label: 'Tallinn', country: 'EE' }, { label: 'Petaling Jaya', country: 'MY' },
      ] },
    }),
    regionalLegacyJob('partial-relay', {
      title: 'Backend Engineer — Continental Relay', cityIds: ['berlin'],
      locationLabel: 'Berlin, Germany · Taipei, Taiwan',
      workplaceLocations: { version: 1, locations: [
        { label: 'Berlin', country: 'DE' }, { label: 'Taipei', country: 'TW' },
      ] },
    }),
    regionalLegacyJob('partial-country', {
      title: 'Backend Engineer — Estonian Workshop', locationLabel: 'Estonia',
      workplaceLocations: { version: 1, locations: [{ label: 'Estonia', country: 'EE' }] },
    }),
    regionalLegacyJob('partial-remote', {
      title: 'Backend Engineer — European Remote', cityIds: [], workMode: 'remote',
      locationLabel: 'Remote · Europe', remoteScopeVersion: 3,
      remoteCountries: [], remoteRegions: ['europe'], remoteScopeUnknown: true,
    }),
  ], 2, REGIONAL_ALL_CITIES)
}

export function regionalResolutionJob(status: 'conflict' | 'relocation'): Job {
  const title = status === 'relocation' ? 'Backend Engineer — Relocation to Sydney' : 'Backend Engineer — Held Location'
  return regionalLegacyJob(`held-${status}`, {
    title, cityIds: status === 'conflict' ? [] : ['sydney'],
    locationLabel: status === 'conflict' ? 'London, United Kingdom · Dubai, United Arab Emirates' : 'Sydney',
    workplaceLocations: { version: 1, locations: [{ label: 'London, United Kingdom · Dubai, United Arab Emirates' }] },
    description: 'This role is based in Sydney.',
    locationResolution: {
      version: 1, status, listedCityIds: ['london'],
      listedLabel: 'London, United Kingdom · Dubai, United Arab Emirates',
      statedCityIds: ['sydney'], statedLabel: 'Sydney',
      evidence: [
        ...(status === 'relocation' ? [{ source: 'title' as const, text: 'Backend Engineer — Relocation to Sydney' }] : []),
        { source: 'description', text: 'This role is based in Sydney.' },
      ],
    },
  })
}
