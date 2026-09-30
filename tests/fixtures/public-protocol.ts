import type { Catalog, Company, Job, JobProvider, SavedJob } from '../../shared/types'
import { COMPENSATION_VERSION } from '../../shared/types'
import { PUBLIC_TEST_CITIES } from './public-geography'

// Test-only, authored public protocol data. No runtime demo, company registry,
// normalizer, collector or real vacancy is involved in constructing these inputs.
export const PUBLIC_PROTOCOL_TIME = '2026-09-26T08:00:00.000Z'
export const PUBLIC_PROTOCOL_COMPANIES: Company[] = [
  {
    id: 'fixture-aster-transit', name: 'Aster Transit', initials: 'AT', color: '#3974cc',
    industry: 'Synthetic railway employer', provider: 'greenhouse', board: 'fixture-aster-transit',
    careerUrl: 'https://example.test/aster-transit/careers',
  },
  {
    id: 'fixture-cedar-loom', name: 'Cedar Loom', initials: 'CL', color: '#487950',
    industry: 'Synthetic textile employer', provider: 'greenhouse', board: 'fixture-cedar-loom',
    careerUrl: 'https://example.test/cedar-loom/careers',
  },
  {
    id: 'fixture-mosaic-clinic', name: 'Mosaic Clinic', initials: 'MC', color: '#8750ab',
    industry: 'Synthetic healthcare employer', provider: 'greenhouse', board: 'fixture-mosaic-clinic',
    careerUrl: 'https://example.test/mosaic-clinic/careers',
  },
]

type PublicJob = Job & { source: JobProvider }
export function publicProtocolJob(id = 'london', overrides: Partial<PublicJob> = {}): PublicJob {
  const title = overrides.title ?? 'Backend Engineer — Aster Transit London'
  const role = overrides.role ?? 'backend'
  const skills = overrides.skills ?? ['Python', 'TypeScript', 'PostgreSQL', 'AWS']
  const years = overrides.minExperience === undefined ? 3 : overrides.minExperience
  // Current, explicit normalized fields keep transaction tests focused on record
  // identity. Legacy public read-upgrade tests use their own earlier snapshots.
  return structuredClone({
    id: `greenhouse-fixture-aster-transit-${id}`, companyId: 'fixture-aster-transit', title, role,
    cityIds: ['london'], cityCoverageVersion: 1, locationLabel: 'London, United Kingdom',
    workMode: 'onsite', employment: 'fulltime', employmentVersion: 1,
    minExperience: years, skills, salary: { min: 130000, max: 180000, currency: 'USD' },
    compensationVersion: COMPENSATION_VERSION, visa: 'yes', eligibility: { version: 2, rules: [] },
    qualifications: {
      version: 1,
      skills: skills.length ? [{
        kind: 'qualification', skills, match: 'all',
        evidence: { source: 'description', text: `Qualifications: experience with ${skills.join(' and ')}.` },
      }] : [],
      experience: years === null ? [] : [{
        kind: 'qualification', minYears: years, conditional: false,
        evidence: { source: 'description', text: `Qualifications: ${years} years of engineering experience.` },
      }],
    },
    languageRequirements: { version: 1, rules: [] },
    workTimeRequirements: { version: 1, rules: [] },
    roleClassification: {
      version: 1, roles: role === 'unknown' ? [] : [role],
      evidence: role === 'unknown' ? [] : [{ role, source: 'title', text: title }],
    },
    // Current occupation version. Many callers override the title with a protocol
    // label rather than an occupation; a current-version record keeps its authored
    // category without re-evaluation, so this pin moves with each version bump.
    occupation: {
      version: 7, category: 'engineering', departments: [],
      evidence: [{ source: 'title', text: title }],
    },
    remoteCountries: [], remoteWorldwide: false, remoteScopeUnknown: false, remoteScopeVersion: 3,
    description: 'Synthetic engineering protocol fixture. This is not a real vacancy.',
    requirements: ['Engineering experience.'],
    url: `https://example.test/jobs/${id}`, source: 'greenhouse',
    updatedAt: null, fetchedAt: PUBLIC_PROTOCOL_TIME, stale: false,
    ...overrides,
  })
}

export function publicSavedRecord(id = 'saved', note = 'Original public note'): SavedJob {
  return {
    job: publicProtocolJob(id), company: structuredClone(PUBLIC_PROTOCOL_COMPANIES[0]),
    savedAt: '2026-09-25T08:00:00.000Z', status: 'saved', note,
  }
}

const topologyRows: [string, string][] = [
  ['london', 'London'], ['berlin', 'Berlin'], ['san-francisco', 'San Francisco'],
  ['new-york', 'New York'], ['seattle', 'Seattle'], ['austin', 'Austin'], ['boston', 'Boston'],
  ['toronto', 'Toronto'], ['vancouver', 'Vancouver'], ['amsterdam', 'Amsterdam'],
  ['paris', 'Paris'], ['dublin', 'Dublin'], ['stockholm', 'Stockholm'], ['zurich', 'Zurich'],
  ['barcelona', 'Barcelona'], ['lisbon', 'Lisbon'], ['singapore', 'Singapore'], ['seoul', 'Seoul'],
  ['tokyo', 'Tokyo'], ['sydney', 'Sydney'], ['melbourne', 'Melbourne'], ['bengaluru', 'Bengaluru'],
]

export function publicProtocolCatalog(options: {
  jobs?: Job[]; companies?: Company[]; fetchedAt?: string
} = {}): Catalog {
  const fetchedAt = options.fetchedAt ?? PUBLIC_PROTOCOL_TIME
  const jobs = options.jobs ?? [
    ...topologyRows.map(([city, name]) => publicProtocolJob(city, {
      title: `Backend Engineer — Aster Transit ${name}`, cityIds: [city], locationLabel: name,
    })),
    publicProtocolJob('loom-london', {
      id: 'greenhouse-fixture-cedar-loom-london', companyId: 'fixture-cedar-loom',
      title: 'Frontend Engineer — Cedar Loom London', role: 'frontend', skills: ['TypeScript', 'React'],
    }),
    publicProtocolJob('loom-berlin', {
      id: 'greenhouse-fixture-cedar-loom-berlin', companyId: 'fixture-cedar-loom',
      title: 'Backend Engineer — Cedar Loom Berlin', cityIds: ['berlin'], locationLabel: 'Berlin',
    }),
    publicProtocolJob('clinic-london', {
      id: 'greenhouse-fixture-mosaic-clinic-london', companyId: 'fixture-mosaic-clinic',
      title: 'Backend Engineer — Mosaic Clinic London', skills: ['Rust'], minExperience: 8,
    }),
    publicProtocolJob('clinic-sf', {
      id: 'greenhouse-fixture-mosaic-clinic-sf', companyId: 'fixture-mosaic-clinic',
      title: 'Backend Engineer — Mosaic Clinic San Francisco', cityIds: ['san-francisco'], locationLabel: 'San Francisco',
    }),
    publicProtocolJob('remote-world', {
      title: 'Backend Engineer — Aster Transit Remote', cityIds: [], workMode: 'remote',
      locationLabel: 'Remote · Worldwide', remoteWorldwide: true,
    }),
    publicProtocolJob('remote-us', {
      id: 'greenhouse-fixture-cedar-loom-remote-us', companyId: 'fixture-cedar-loom',
      title: 'Backend Engineer — Cedar Loom Remote US', cityIds: [], workMode: 'remote',
      locationLabel: 'Remote · United States', remoteCountries: ['US'],
    }),
    publicProtocolJob('unmapped', {
      title: 'Backend Engineer — Aster Transit Oxford', cityIds: [], locationLabel: 'Oxford, United Kingdom',
    }),
  ]
  const companies = options.companies ?? PUBLIC_PROTOCOL_COMPANIES
  return structuredClone({
    source: 'public', fetchedAt, checkedAt: fetchedAt, stale: false,
    companies, cities: PUBLIC_TEST_CITIES, jobs: jobs.map(job => ({ ...job, fetchedAt })),
    unmappedCount: jobs.filter(job => !job.cityIds.length && job.workMode !== 'remote').length,
    boards: companies.map(company => ({
      companyId: company.id, provider: company.provider ?? 'greenhouse', board: company.board!,
      status: 'ok', dataStatus: 'fresh', checkedAt: fetchedAt, lastSuccessAt: fetchedAt,
      total: jobs.filter(job => job.companyId === company.id).length,
      included: jobs.filter(job => job.companyId === company.id).length,
    })),
  })
}
