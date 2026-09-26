import type { CachedBoard } from '../../server/board-cache'
import type { Company, Job, JobProvider, Profile, SavedJob, SkillRequirement } from '../../shared/types'

// Every employer, posting, paragraph and personal record in this file is fictional.
// The HTTP fixture feeds raw provider payloads to the real collectors. The
// normalized fixtures below separately exercise the aggregate/store boundary.
export const OBSERVATION_DAY_ONE = '2026-09-24T10:00:00.000Z'
export const OBSERVATION_DAY_TWO = '2026-09-26T10:00:00.000Z'
export const OBSERVATION_SOURCE_UPDATED_AT = '2026-09-23T08:00:00.000Z'
export const OBSERVATION_PRIVATE_NOTE = '가상 비공개 지원 메모 — observation-private-60'
export const OBSERVATION_PRIVATE_QUERY = 'local-only-observation-query-60'

export const OBSERVATION_REGISTRATIONS = [
  {
    id: 'observation-orchard', name: 'Cobalt Orchard', provider: 'greenhouse',
    board: 'CobaltObservations60', industry: '가상 관측 소프트웨어',
    careerUrl: 'https://example.com/careers/observation-orchard',
  },
  {
    id: 'observation-relay', name: 'Juniper Relay', provider: 'lever', boardRegion: 'eu',
    board: 'JuniperObservations60', industry: '가상 관측 소프트웨어',
    careerUrl: 'https://example.com/careers/observation-relay',
  },
] as const

export const OBSERVATION_COMPANIES: Company[] = [
  { ...OBSERVATION_REGISTRATIONS[0], initials: 'CO', color: '#a79aff' },
  { ...OBSERVATION_REGISTRATIONS[1], initials: 'JR', color: '#84dba6' },
]

export const OBSERVATION_PROFILE: Profile = {
  kind: 'personal', name: '가상 관측 지원자 observation-private-60',
  headline: 'Local-only fictional profile', years: 6, skills: ['TypeScript'],
  desiredRole: 'backend', residence: 'KR', linkedinUrl: '',
}

const requirement = (
  kind: SkillRequirement['kind'], skills: string[],
  match: SkillRequirement['match'] = 'all',
): SkillRequirement => ({
  kind, skills, match, evidence: {
    source: 'description',
    text: `${kind}: ${skills.join(match === 'any' ? ' or ' : ' and ')}.`,
  },
})

type PublicObservationJob = Job & { source: JobProvider }

export function observationJob(nativeId = '6001', overrides: Partial<PublicObservationJob> = {}): PublicObservationJob {
  const companyId = overrides.companyId ?? 'observation-orchard'
  const source = overrides.source ?? 'greenhouse'
  return {
    id: `${source}-${companyId}-${nativeId}`, companyId,
    title: 'Backend Engineer — Orchard Ledger', role: 'backend',
    roleClassification: {
      version: 1, roles: ['backend'],
      evidence: [{ role: 'backend', source: 'title', text: 'Backend Engineer — Orchard Ledger' }],
    },
    occupation: {
      version: 4, category: 'engineering', departments: ['Engineering'],
      evidence: [{ source: 'title', text: overrides.title ?? 'Backend Engineer — Orchard Ledger' }],
    },
    cityIds: ['london'], locationLabel: 'London, United Kingdom',
    workplaceLocations: { version: 1, locations: [{ label: 'London, United Kingdom', country: 'GB' }] },
    workMode: 'onsite', employment: 'fulltime', employmentVersion: 1,
    minExperience: null, skills: ['TypeScript', 'Python', 'Go', 'AWS'],
    qualifications: {
      version: 1, experience: [], skills: [
        requirement('required', ['TypeScript', 'Python'], 'any'),
        requirement('preferred', ['Go']),
        requirement('context', ['AWS']),
      ],
    },
    salary: null, visa: 'unknown',
    remoteCountries: [], remoteWorldwide: false, remoteScopeUnknown: false,
    remoteScopeVersion: 2, requirements: [],
    description: 'Build fictional services.\nRequired: TypeScript or Python.\nPreferred: Go.\nOur tools include AWS.',
    url: `https://example.com/jobs/${companyId}-${nativeId}`, source,
    updatedAt: OBSERVATION_SOURCE_UPDATED_AT, fetchedAt: OBSERVATION_DAY_ONE,
    ...overrides,
  }
}

/** Seven technical candidates: six ordinary openings and one talent registration. */
export function observationJobs(fetchedAt = OBSERVATION_DAY_ONE, nextDay = false): PublicObservationJob[] {
  const jobs = [
    observationJob('6001'),
    observationJob('6002', {
      title: 'Backend / Frontend Engineer — Shared Mesh',
      roleClassification: {
        version: 1, roles: ['backend', 'frontend'],
        evidence: [
          { role: 'backend', source: 'title', text: 'Backend / Frontend Engineer' },
          { role: 'frontend', source: 'title', text: 'Backend / Frontend Engineer' },
        ],
      },
      cityIds: ['london', 'toronto', 'london'],
      locationLabel: 'London, United Kingdom; Toronto, Canada; London, United Kingdom',
      workplaceLocations: { version: 1, locations: [
        { label: 'London, United Kingdom', country: 'GB' },
        { label: 'Toronto, Canada', country: 'CA' },
        { label: 'London, United Kingdom', country: 'GB' },
      ] },
      workMode: 'hybrid', skills: ['TypeScript', 'React'],
      qualifications: { version: 1, experience: [], skills: [requirement('qualification', ['TypeScript', 'React'])] },
      description: 'Build fictional interfaces.\nQualifications: TypeScript and React.',
    }),
    observationJob('6003', {
      title: 'Frontend Engineer — Remote Canopy', role: 'frontend',
      roleClassification: {
        version: 1, roles: ['frontend'],
        evidence: [{ role: 'frontend', source: 'title', text: 'Frontend Engineer' }],
      },
      cityIds: [], locationLabel: 'Remote — United States, Canada',
      workplaceLocations: { version: 1, locations: [{ label: 'United States, Canada' }] },
      workMode: 'remote', remoteCountries: ['US', 'CA'],
      skills: ['TypeScript', 'React'],
      qualifications: { version: 1, experience: [], skills: [
        requirement('required', ['React']), requirement('context', ['TypeScript']),
      ] },
      description: 'Build fictional interfaces with TypeScript.\nRequired: React.',
    }),
    observationJob('6011', {
      companyId: 'observation-relay', source: 'lever',
      title: 'Machine Learning / Data Engineer — Relay Signal', role: 'ml',
      roleClassification: {
        version: 1, roles: ['ml', 'data'],
        evidence: [
          { role: 'ml', source: 'title', text: 'Machine Learning / Data Engineer' },
          { role: 'data', source: 'title', text: 'Machine Learning / Data Engineer' },
        ],
      },
      cityIds: ['seoul'], locationLabel: 'Seoul, South Korea',
      workplaceLocations: { version: 1, locations: [{ label: 'Seoul, South Korea', country: 'KR' }] },
      workMode: 'hybrid', skills: ['Python', 'SQL'],
      qualifications: { version: 1, experience: [], skills: [
        requirement('required', ['Python']), requirement('qualification', ['SQL']),
      ] },
      description: 'Build fictional data software.\nRequired: Python.\nQualifications: SQL.',
    }),
    observationJob('6012', {
      companyId: 'observation-relay', source: 'lever',
      title: 'Software Engineer — Unassigned Station', role: 'unknown',
      roleClassification: { version: 1, roles: [], evidence: [] },
      cityIds: [], locationLabel: 'Station Sixty',
      workplaceLocations: { version: 1, locations: [{ label: 'Station Sixty' }] },
      workMode: 'unknown', skills: [],
      qualifications: { version: 1, experience: [], skills: [] },
      description: 'Build fictional software for the unassigned station.',
    }),
    observationJob('6013', {
      companyId: 'observation-relay', source: 'lever',
      title: 'Backend Engineer — Southern Relay',
      cityIds: [], locationLabel: 'Cape Town, South Africa',
      workplaceLocations: { version: 1, locations: [{ label: 'Cape Town, South Africa', country: 'ZA' }] },
      skills: ['Go'],
      qualifications: { version: 1, experience: [], skills: [requirement('preferred', ['Go'])] },
      description: 'Build fictional services.\nPreferred: Go.',
    }),
    observationJob('6004', {
      title: 'Backend Engineer — Future Orchard',
      skills: ['Rust'],
      qualifications: { version: 1, experience: [], skills: [requirement('required', ['Rust'])] },
      postingPurpose: {
        version: 1, kind: 'talent-pool', basis: 'greenhouse-prospect',
        evidence: [{ source: 'board', text: 'internal_job_id: null' }],
      },
      description: 'Register for future software engineering opportunities. This is not a currently open position. Required: Rust.',
    }),
  ]
  if (nextDay) jobs.push(observationJob('6005', {
    title: 'Backend Engineer — New Orchard Branch',
    skills: ['TypeScript'],
    qualifications: { version: 1, experience: [], skills: [requirement('required', ['TypeScript'])] },
    description: 'Build fictional services.\nRequired: TypeScript.',
  }))
  return jobs.map(job => ({ ...job, fetchedAt }))
}

/** Published inventories include one excluded sales posting at Juniper Relay. */
export function observationBoards(options: {
  at?: string
  nextDay?: boolean
  method?: string
  companies?: Company[]
} = {}): CachedBoard[] {
  const at = options.at ?? OBSERVATION_DAY_ONE
  const jobs = observationJobs(at, options.nextDay)
  return (options.companies ?? OBSERVATION_COMPANIES).map(company => {
    const own = jobs.filter(job => job.companyId === company.id)
    const publishedIds = own.map(job => job.id)
    if (company.id === 'observation-relay') publishedIds.push('lever-observation-relay-6014')
    return {
      companyId: company.id, provider: company.provider!, board: company.board!,
      ...(company.boardRegion ? { boardRegion: company.boardRegion } : {}),
      checkedAt: at, failures: 0, retryAt: null,
      snapshot: {
        fetchedAt: at, jobs: own, total: publishedIds.length, publishedIds,
        unmappedCount: company.id === 'observation-relay' ? 2 : 0,
        ...(options.method ? { observationMethod: options.method } : {}),
      },
    }
  })
}

// Literal expected counts, worked out from the six individual openings above.
// They are never calculated with a classifier, aggregator or normalization helper.
export const OBSERVATION_EXPECTED = {
  published: 8,
  technical: 7,
  openings: 6,
  talentPools: 1,
  companies: { 'observation-orchard': 3, 'observation-relay': 3 },
  regions: { americas: 1, europe: 2, 'asia-pacific': 1, remote: 1, other: 1, unknown: 1 },
  roles: { backend: 3, frontend: 2, fullstack: 0, ml: 1, data: 1, devops: 0, mobile: 0, security: 0, unknown: 1 },
  workModes: { onsite: 2, hybrid: 2, remote: 1, unknown: 1 },
  skills: {
    TypeScript: { mentions: 3, required: 1, preferred: 0, qualification: 1 },
    Python: { mentions: 2, required: 2, preferred: 0, qualification: 0 },
    Go: { mentions: 2, required: 0, preferred: 2, qualification: 0 },
    React: { mentions: 2, required: 1, preferred: 0, qualification: 1 },
    AWS: { mentions: 1, required: 0, preferred: 0, qualification: 0 },
    SQL: { mentions: 1, required: 0, preferred: 0, qualification: 1 },
  },
  skillsUnknown: 1,
  largestCompanyOpenings: 3,
  largestCompanyPercent: 50,
} as const

const rawGreenhouse = (id: number, title: string, location: string, content: string, workplace = 'Onsite') => ({
  id, internal_job_id: id + 10000, title,
  absolute_url: `https://example.com/jobs/observation-orchard-${id}`,
  updated_at: OBSERVATION_SOURCE_UPDATED_AT, location: { name: location }, content,
  departments: [{ name: 'Engineering' }],
  metadata: [{ name: 'Employment Type', value: 'Full-time' }, { name: 'Workplace Type', value: workplace }],
})

const rawLever = (id: string, text: string, location: string, descriptionPlain: string, workplaceType?: string, country?: string) => ({
  id, text, hostedUrl: `https://example.com/jobs/observation-relay-${id}`,
  categories: { location, commitment: 'Full-time', department: 'Engineering' },
  descriptionPlain, ...(workplaceType ? { workplaceType } : {}), ...(country ? { country } : {}),
})

export function observationRawPostings(nextDay = false) {
  const greenhouse = [
    rawGreenhouse(6001, 'Backend Engineer — Orchard Ledger', 'London, United Kingdom',
      '<h2>Responsibilities</h2><p>Build fictional services. Our tools include AWS.</p><h2>Minimum requirements</h2><p>Experience with TypeScript or Python is required.</p><h2>Preferred qualifications</h2><p>Go experience is preferred.</p>'),
    rawGreenhouse(6002, 'Backend / Frontend Engineer — Shared Mesh', 'London, United Kingdom; Toronto, Canada; London, United Kingdom',
      '<h2>Responsibilities</h2><p>Build fictional interfaces.</p><h2>Qualifications</h2><p>Experience with TypeScript and React.</p>', 'Hybrid'),
    rawGreenhouse(6003, 'Frontend Engineer — Remote Canopy', 'Remote — United States, Canada',
      '<h2>Responsibilities</h2><p>Build fictional interfaces with TypeScript.</p><h2>Minimum requirements</h2><p>React experience is required.</p>', 'Remote'),
    {
      ...rawGreenhouse(6004, 'Backend Engineer — Future Orchard', 'London, United Kingdom',
        '<p>Register for future software engineering opportunities. This is not a currently open position.</p><h2>Minimum requirements</h2><p>Rust experience is required.</p>'),
      internal_job_id: null,
    },
  ]
  if (nextDay) greenhouse.push(rawGreenhouse(6005, 'Backend Engineer — New Orchard Branch', 'London, United Kingdom',
    '<h2>Responsibilities</h2><p>Build fictional services.</p><h2>Minimum requirements</h2><p>TypeScript experience is required.</p>'))
  const lever = [
    rawLever('6011', 'Machine Learning / Data Engineer — Relay Signal', 'Seoul, South Korea',
      'Responsibilities\nBuild fictional data software.\n\nMinimum requirements\nPython experience is required.\n\nQualifications\nExperience with SQL.', 'hybrid', 'KR'),
    rawLever('6012', 'Software Engineer — Unassigned Station', 'Station Sixty',
      'Responsibilities\nBuild fictional software for the unassigned station.'),
    rawLever('6013', 'Backend Engineer — Southern Relay', 'Cape Town, South Africa',
      'Responsibilities\nBuild fictional services.\n\nPreferred qualifications\nGo experience is preferred.', 'onsite', 'ZA'),
    {
      ...rawLever('6014', 'Account Executive — Relay Accounts', 'London, United Kingdom',
        'Responsibilities\nManage fictional account renewals.', 'onsite', 'GB'),
      categories: { location: 'London, United Kingdom', commitment: 'Full-time', department: 'Sales' },
    },
  ]
  return { greenhouse, lever }
}

export interface ObservationResponse {
  body?: unknown
  status?: number
  failure?: string
  delayMs?: number
  headers?: Record<string, string>
}
export type ObservationResponses = Record<string, ObservationResponse>
export const OBSERVATION_URLS = {
  greenhouseFull: 'https://boards-api.greenhouse.io/v1/boards/CobaltObservations60/jobs?content=true&pay_transparency=true',
  greenhousePresence: 'https://boards-api.greenhouse.io/v1/boards/CobaltObservations60/jobs?content=false',
  lever: 'https://api.eu.lever.co/v0/postings/JuniperObservations60?mode=json&limit=50&skip=0',
} as const

export function observationResponses(options: {
  nextDay?: boolean
  scenario?: 'complete' | 'failed' | 'incomplete' | 'empty'
} = {}): ObservationResponses {
  const raw = observationRawPostings(options.nextDay)
  const greenhouse = options.scenario === 'empty' ? [] : raw.greenhouse
  const lever = options.scenario === 'empty' ? [] : raw.lever
  const result: ObservationResponses = {
    [OBSERVATION_URLS.greenhouseFull]: { body: { jobs: greenhouse, meta: { total: greenhouse.length } } },
    [OBSERVATION_URLS.greenhousePresence]: { body: {
      jobs: greenhouse.map(({ id, title, absolute_url }) => ({ id, title, absolute_url })),
      meta: { total: greenhouse.length },
    } },
    [OBSERVATION_URLS.lever]: { body: lever },
  }
  if (options.scenario === 'failed') result[OBSERVATION_URLS.lever] = { status: 503, body: { error: 'Fictional board unavailable' } }
  if (options.scenario === 'incomplete') result[OBSERVATION_URLS.greenhouseFull] = {
    body: { jobs: greenhouse.slice(0, 1), meta: { total: greenhouse.length } },
  }
  return result
}

export function observationSaved(): SavedJob[] {
  return [{
    job: observationJob(), company: { ...OBSERVATION_COMPANIES[0] },
    savedAt: '2026-09-24T10:05:00.000Z', status: 'applied', note: OBSERVATION_PRIVATE_NOTE,
  }]
}
