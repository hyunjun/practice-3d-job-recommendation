import type { ObservationHistory, ObservationSeries, ObservationStats } from '../../shared/catalog-observations'
import type { CachedBoard } from '../../server/board-cache'
import { regionalLegacyJob, type RegionalPublicJob } from './regional-coverage'

export const REGIONAL_CURRENT_METHOD = 'observations-2.cities-1.occupation-7.roles-1.qualifications-1.remote-3.employment-1.purpose-1'
export const REGIONAL_LEGACY_METHOD = 'observations-1.occupation-6.roles-1.qualifications-1.remote-2.employment-1.purpose-1'
// SHA256 of the literal synthetic board identity, authored without product helpers.
export const REGIONAL_SCOPE = {
  key: 'e2be66faaa67fa2b57de13ee84ab9896ff1e6db2e455fb625bc7c276e2840fc6',
  boards: [{ companyId: 'regional-cedar', name: 'Cedar Route Laboratory', provider: 'greenhouse' as const, board: 'RegionalCedar70' }],
}

export function regionalObservationJobs(): RegionalPublicJob[] {
  return [
    regionalLegacyJob('obs-dubai', {
      cityIds: ['dubai'], cityCoverageVersion: 1,
      workplaceLocations: { version: 1, locations: [{ label: 'Dubai, UAE', country: 'AE' }] },
    }),
    regionalLegacyJob('obs-taipei', {
      title: 'Backend Engineer — Taiwan Observatory', cityIds: ['taipei'], cityCoverageVersion: 1,
      locationLabel: 'Taipei, Taiwan', workplaceLocations: { version: 1, locations: [{ label: 'Taipei, Taiwan', country: 'TW' }] },
    }),
    regionalLegacyJob('obs-auckland', {
      title: 'Backend Engineer — Auckland Observatory', cityIds: ['auckland'], cityCoverageVersion: 1,
      locationLabel: 'Auckland, New Zealand', workplaceLocations: { version: 1, locations: [{ label: 'Auckland, New Zealand', country: 'NZ' }] },
    }),
    regionalLegacyJob('obs-multi', {
      title: 'Backend Engineer — Combined Observatory', cityIds: ['dubai', 'taipei'], cityCoverageVersion: 1,
      locationLabel: 'Dubai, UAE · Taipei, Taiwan', workplaceLocations: { version: 1, locations: [
        { label: 'Dubai, UAE', country: 'AE' }, { label: 'Taipei, Taiwan', country: 'TW' },
        { label: 'Dubai, UAE', country: 'AE' },
      ] },
    }),
    regionalLegacyJob('obs-remote', {
      title: 'Backend Engineer — Remote Observatory', cityIds: [], workMode: 'remote',
      locationLabel: 'Remote · United Arab Emirates', remoteScopeVersion: 3, remoteCountries: ['AE'],
    }),
    regionalLegacyJob('obs-unknown', {
      title: 'Backend Engineer — Unassigned Observatory', cityIds: [], cityCoverageVersion: 1,
      locationLabel: 'Unassigned Workshop',
      workplaceLocations: { version: 1, locations: [{ label: 'Unassigned Workshop', country: 'Unknown Republic' }] },
    }),
    regionalLegacyJob('obs-other', {
      title: 'Backend Engineer — Cape Observatory', cityIds: [], cityCoverageVersion: 1,
      locationLabel: 'Cape Town, South Africa', workplaceLocations: { version: 1, locations: [{ label: 'Cape Town, South Africa', country: 'ZA' }] },
    }),
  ]
}

export const REGIONAL_CURRENT_STATS: ObservationStats = {
  published: 7, technical: 7, openings: 7, talentPools: 0,
  companies: [{ companyId: 'regional-cedar', name: 'Cedar Route Laboratory', count: 7 }],
  regions: [
    { key: 'americas', count: 0 }, { key: 'europe', count: 0 },
    { key: 'asia-pacific', count: 3 }, { key: 'middle-east', count: 2 },
    { key: 'remote', count: 1 }, { key: 'other', count: 1 }, { key: 'unknown', count: 1 },
  ],
  roles: [
    { key: 'backend', count: 7 }, { key: 'frontend', count: 0 }, { key: 'fullstack', count: 0 },
    { key: 'ml', count: 0 }, { key: 'data', count: 0 }, { key: 'devops', count: 0 },
    { key: 'mobile', count: 0 }, { key: 'security', count: 0 }, { key: 'unknown', count: 0 },
  ],
  workModes: [
    { key: 'remote', count: 1 }, { key: 'hybrid', count: 0 },
    { key: 'onsite', count: 6 }, { key: 'unknown', count: 0 },
  ],
  skills: [{ name: 'TypeScript', mentioned: 7, required: 7, qualification: 0, preferred: 0 }],
  skillCount: 1,
}

// The older APAC3 aggregate cannot be redistributed without the original sources.
// It contains exactly six keys, and must not gain a fabricated Middle East0.
export const REGIONAL_LEGACY_STATS: ObservationStats = {
  published: 3, technical: 3, openings: 3, talentPools: 0,
  companies: [{ companyId: 'regional-cedar', name: 'Cedar Route Laboratory', count: 3 }],
  regions: [
    { key: 'americas', count: 0 }, { key: 'europe', count: 0 }, { key: 'asia-pacific', count: 3 },
    { key: 'remote', count: 0 }, { key: 'other', count: 0 }, { key: 'unknown', count: 0 },
  ],
  roles: [
    { key: 'backend', count: 3 }, { key: 'frontend', count: 0 }, { key: 'fullstack', count: 0 },
    { key: 'ml', count: 0 }, { key: 'data', count: 0 }, { key: 'devops', count: 0 },
    { key: 'mobile', count: 0 }, { key: 'security', count: 0 }, { key: 'unknown', count: 0 },
  ],
  workModes: [
    { key: 'remote', count: 0 }, { key: 'hybrid', count: 0 },
    { key: 'onsite', count: 3 }, { key: 'unknown', count: 0 },
  ],
  skills: [{ name: 'TypeScript', mentioned: 3, required: 3, qualification: 0, preferred: 0 }],
  skillCount: 1,
}

export function regionalObservationSeries(legacy = false): ObservationSeries {
  const time = legacy ? '2026-09-26T06:00:00.000Z' : '2026-09-27T06:00:00.000Z'
  const attempt = {
    observedAt: time, recordedAt: time, origin: 'collection' as const,
    boards: [{ companyId: 'regional-cedar', status: 'complete' as const, checkedAt: time, lastSuccessAt: time }],
  }
  return structuredClone({
    scope: REGIONAL_SCOPE, method: legacy ? REGIONAL_LEGACY_METHOD : REGIONAL_CURRENT_METHOD,
    days: [{
      day: legacy ? '2026-09-26' : '2026-09-27', latest: attempt,
      complete: { ...attempt, comparable: true, stats: legacy ? REGIONAL_LEGACY_STATS : REGIONAL_CURRENT_STATS },
    }],
  })
}

export function regionalObservationHistory(legacy = false): ObservationHistory {
  return {
    ...regionalObservationSeries(legacy), version: 1, retentionDays: 90, storage: 'ok',
    otherSeries: legacy ? [] : [{
      scopeKey: 'e2be66faaa67fa2b57de13ee84ab9896ff1e6db2e455fb625bc7c276e2840fc6',
      method: REGIONAL_LEGACY_METHOD, firstDay: '2026-09-26', lastDay: '2026-09-26', companyCount: 1,
    }],
  }
}

export function regionalObservationBoard(method = REGIONAL_CURRENT_METHOD): CachedBoard {
  return {
    companyId: 'regional-cedar', provider: 'greenhouse', board: 'RegionalCedar70',
    checkedAt: '2026-09-27T06:00:00.000Z', failures: 0, retryAt: null,
    snapshot: {
      fetchedAt: '2026-09-27T06:00:00.000Z', observationMethod: method,
      jobs: regionalObservationJobs(), total: 7, unmappedCount: 2,
      publishedIds: [
        'greenhouse-regional-cedar-obs-dubai', 'greenhouse-regional-cedar-obs-taipei',
        'greenhouse-regional-cedar-obs-auckland', 'greenhouse-regional-cedar-obs-multi',
        'greenhouse-regional-cedar-obs-remote', 'greenhouse-regional-cedar-obs-unknown',
        'greenhouse-regional-cedar-obs-other',
      ],
    },
  }
}
