import type { CatalogCollectionSnapshot, CatalogCollectionUpdate } from '../../shared/catalog-progress'
import type { BoardStatus, Catalog, Company, Job, KnownJobRole } from '../../shared/types'
import { COMPENSATION_VERSION } from '../../shared/types'
import {
  CATALOG_WORKER_FINAL_TIME, CATALOG_WORKER_SECOND_TIME, CATALOG_WORKER_TIME, catalogWorkerCatalog,
} from './catalog-worker'

// Stage79 fixtures for docs/design/catalog-worker-aging.md (SHA-256 2fc0192c…).
//
// Fictional public regression data only. Every expected ID, order, time, flag, count and label used
// by the aging tests is authored here or in the tests as a literal derived from these fictional
// inputs. No upgrade, normalize, classifier or other product function is called to build a fixture
// or an expected value. The original tests/fixtures/catalog-worker.ts stays unchanged; this file
// derives read-only copies from its exported catalog and adds separately named variants.

export const AGING_COLLECTION = '00000000-0000-4000-8000-000000000079'
/** A fresh instant for every fixture job (snapshots at 08:00:00/01/02). */
export const AGING_FRESH_NOW = '2026-09-24T08:00:03.000Z'

/** Freshness transitions of the three staggered company snapshots. */
export const AGING_AT = {
  stillFresh: '2026-09-24T08:29:59.999Z',
  asterStale: '2026-09-24T08:30:00.000Z',
  birchStale: '2026-09-24T08:30:01.000Z',
  cedarStale: '2026-09-24T08:30:02.000Z',
  asterExactly24h: '2026-09-25T08:00:00.000Z',
  asterExpired: '2026-09-25T08:00:00.001Z',
  birchExpired: '2026-09-25T08:00:01.001Z',
  cedarExpired: '2026-09-25T08:00:02.001Z',
} as const

/** The complete deduplicated deadline list of the worker fixture: three stale, three expiry. */
export const AGING_DEADLINES = [
  AGING_AT.asterStale, AGING_AT.birchStale, AGING_AT.cedarStale,
  AGING_AT.asterExpired, AGING_AT.birchExpired, AGING_AT.cedarExpired,
].map(time => Date.parse(time))

export const ASTER_IDS = [
  'greenhouse-catalog-worker-aster-atlas', 'greenhouse-catalog-worker-aster-berlin', 'greenhouse-catalog-worker-aster-remote-uk',
]
export const BIRCH_IDS = [
  'greenhouse-catalog-worker-birch-london', 'greenhouse-catalog-worker-birch-berlin', 'greenhouse-catalog-worker-birch-canvas',
]
export const CEDAR_IDS = [
  'greenhouse-catalog-worker-cedar-london', 'greenhouse-catalog-worker-cedar-berlin', 'greenhouse-catalog-worker-cedar-remote-us',
]
/** Fixture job IDs in catalog (jobIds) order. */
export const AGING_JOB_IDS = [...ASTER_IDS, ...BIRCH_IDS, ...CEDAR_IDS]
/** The eight default-input matches: cedar-remote-us is a US-only remote job and the fixture profile lives in GB. */
export const AGING_MATCH_IDS = [...ASTER_IDS, ...BIRCH_IDS, 'greenhouse-catalog-worker-cedar-london', 'greenhouse-catalog-worker-cedar-berlin']
export const AGING_SURVIVOR_MATCHES_AFTER_ASTER = [...BIRCH_IDS, 'greenhouse-catalog-worker-cedar-london', 'greenhouse-catalog-worker-cedar-berlin']
export const AGING_SURVIVOR_MATCHES_AFTER_BIRCH = ['greenhouse-catalog-worker-cedar-london', 'greenhouse-catalog-worker-cedar-berlin']

/** Literal title/role facts per fixture job, used to author current migration results by hand. */
const CURRENT_FACTS: Record<string, { title: string; role: KnownJobRole; remote: boolean }> = {
  'greenhouse-catalog-worker-aster-atlas': { title: 'Backend Engineer — Atlas Alpha', role: 'backend', remote: false },
  'greenhouse-catalog-worker-aster-berlin': { title: 'Frontend Engineer — Beacon Berlin', role: 'frontend', remote: false },
  'greenhouse-catalog-worker-aster-remote-uk': { title: 'Backend Engineer — Beacon Remote UK', role: 'backend', remote: true },
  'greenhouse-catalog-worker-birch-london': { title: 'Backend Engineer — Beacon London', role: 'backend', remote: false },
  'greenhouse-catalog-worker-birch-berlin': { title: 'Backend Engineer — Beacon Berlin', role: 'backend', remote: false },
  'greenhouse-catalog-worker-birch-canvas': { title: 'Frontend Engineer — Atlas Canvas', role: 'frontend', remote: false },
  'greenhouse-catalog-worker-cedar-london': { title: 'Backend Engineer — Beacon London Final', role: 'backend', remote: false },
  'greenhouse-catalog-worker-cedar-berlin': { title: 'Frontend Engineer — Beacon Berlin Final', role: 'frontend', remote: false },
  'greenhouse-catalog-worker-cedar-remote-us': { title: 'Backend Engineer — Beacon Remote US', role: 'backend', remote: true },
}

/**
 * A fully current fictional record: every migration result that the legacy worker fixture omits is
 * authored literally (language/work-time v1 with no rules, occupation v7 engineering with the exact
 * title as evidence, role classification v1 consistent with the job role, city coverage v1, and
 * remote scope v3 on remote jobs). Version numbers are literals on purpose: a future migration bump
 * must make these tests fail loudly instead of silently re-labelling the fixture as current.
 */
export function agingCurrentJob(base: Job): Job {
  const facts = CURRENT_FACTS[base.id]
  if (!facts) throw new Error(`No authored current facts for ${base.id}`)
  if (base.title !== facts.title || base.role !== facts.role) throw new Error(`Fixture facts drifted for ${base.id}`)
  return {
    ...base,
    languageRequirements: { version: 1, rules: [] },
    workTimeRequirements: { version: 1, rules: [] },
    cityCoverageVersion: 1,
    occupation: { version: 7, category: 'engineering', departments: [], evidence: [{ source: 'title', text: facts.title }] },
    roleClassification: { version: 1, roles: [facts.role], evidence: [{ role: facts.role, source: 'title', text: facts.title }] },
    ...(facts.remote ? { remoteScopeVersion: 3 as const } : {}),
  }
}

/** Legacy-shaped fixture jobs exactly as the shared worker fixture ships them (deep copy). */
export function agingLegacyJobs(): Job[] {
  return structuredClone(catalogWorkerCatalog().jobs)
}

/** The same nine fictional jobs in fully current form. */
export function agingCurrentJobs(): Job[] {
  return agingLegacyJobs().map(agingCurrentJob)
}

/** Complete current-format catalog (3 companies, 9 jobs, status 200 shape). */
export function agingCurrentCatalog(): Catalog {
  const base = catalogWorkerCatalog()
  return { ...base, jobs: agingCurrentJobs() }
}

/** Remove the optional stale key from every job: the absent compact state. */
export function withoutStaleKeys(catalog: Catalog): Catalog {
  return {
    ...catalog,
    jobs: catalog.jobs.map(job => {
      const { stale: _stale, ...rest } = job
      return rest as Job
    }),
  }
}

/** Legacy top-level stale flag with jobs that carry no stale key at all. */
export function agingCatalogLevelStaleCatalog(): Catalog {
  return { ...withoutStaleKeys(agingCurrentCatalog()), stale: true }
}

/** Aster's board failed its refresh and keeps its earlier jobs as retained records. */
export function agingErrorBoardCatalog(): Catalog {
  const catalog = agingCurrentCatalog()
  return {
    ...catalog,
    stale: true,
    jobs: catalog.jobs.map(job => job.companyId === 'catalog-worker-aster' ? { ...job, stale: true } : job),
    boards: catalog.boards.map(board => board.companyId === 'catalog-worker-aster' ? {
      ...board, status: 'error' as const, dataStatus: 'stale' as const,
      checkedAt: '2026-09-24T08:00:30.000Z', retryAt: '2026-09-24T08:10:30.000Z', message: 'HTTP 429',
    } : board),
  }
}

/** A fourth fictional company whose board is still pending, keeping a progress operation open. */
export const AGING_PENDING_COMPANY: Company = {
  id: 'catalog-worker-dogwood', name: 'Dogwood QA Studio', initials: 'DQ', color: '#8a6d3b',
  industry: 'Fictional software laboratory', provider: 'greenhouse', board: 'catalog-worker-dogwood',
  careerUrl: 'https://example.org/catalog-worker/dogwood/careers',
}

export const AGING_PENDING_BOARD: BoardStatus = {
  companyId: AGING_PENDING_COMPANY.id, provider: 'greenhouse', board: AGING_PENDING_COMPANY.board!,
  status: 'pending', dataStatus: 'unavailable', total: 0, included: 0, lastSuccessAt: null,
}

function openBoards(cedar: 'fresh' | 'stale', checkedAt?: string): BoardStatus[] {
  const times = [CATALOG_WORKER_TIME, CATALOG_WORKER_SECOND_TIME, CATALOG_WORKER_FINAL_TIME]
  const ids = ['catalog-worker-aster', 'catalog-worker-birch', 'catalog-worker-cedar']
  return [
    ...ids.map((companyId, index): BoardStatus => ({
      companyId, provider: 'greenhouse', board: companyId, status: 'ok',
      dataStatus: companyId === 'catalog-worker-cedar' ? cedar : 'fresh',
      total: 3, included: 3, lastSuccessAt: times[index], checkedAt: checkedAt ?? times[index],
    })),
    { ...AGING_PENDING_BOARD },
  ]
}

/**
 * Open-progress catalog: Aster/Birch/Cedar complete, Dogwood still pending (total 4, completed 3),
 * so metadata-only deltas remain valid on the same stream.
 */
export function agingOpenCatalog(jobs: Job[], cedar: 'fresh' | 'stale' = 'fresh'): Catalog {
  const base = catalogWorkerCatalog()
  return {
    source: 'public', fetchedAt: CATALOG_WORKER_FINAL_TIME, checkedAt: CATALOG_WORKER_FINAL_TIME, stale: cedar === 'stale',
    companies: [...structuredClone(base.companies), structuredClone(AGING_PENDING_COMPANY)],
    cities: structuredClone(base.cities),
    jobs, boards: openBoards(cedar), unmappedCount: 0,
  }
}

const openProgress = (revision: number) => ({ id: AGING_COLLECTION, revision, total: 4, completed: 3, done: false as const })

/** Status-202 snapshot with current-format jobs and an open operation (revision 3). */
export function agingCurrentSnapshot(): CatalogCollectionSnapshot {
  return { catalog: agingOpenCatalog(agingCurrentJobs()), progress: openProgress(3) }
}

/** The same open operation with the legacy-shaped jobs of the shared fixture. */
export function agingLegacySnapshot(): CatalogCollectionSnapshot {
  return { catalog: agingOpenCatalog(agingLegacyJobs()), progress: openProgress(3) }
}

/** Metadata-only delta: no company replaced, no job bodies, only board state (Cedar fresh/stale). */
export function agingMetadataUpdate(revision: number, cedar: 'fresh' | 'stale', checkedAt = `2026-09-24T08:00:0${revision}.500Z`): CatalogCollectionUpdate {
  return {
    progress: openProgress(revision), companyIds: [], jobs: [],
    catalog: {
      source: 'public', fetchedAt: CATALOG_WORKER_FINAL_TIME, checkedAt, stale: cedar === 'stale',
      boards: openBoards(cedar, checkedAt), unmappedCount: 0,
    },
  }
}

export const AGING_REVISED_TITLE = 'Backend Engineer — Atlas Alpha Revised'

/** Same-ID replacement: Aster is delivered again at the same times with one changed title. */
export function agingReplacementUpdate(revision: number): CatalogCollectionUpdate {
  const jobs = agingCurrentJobs().filter(job => job.companyId === 'catalog-worker-aster').map(job =>
    job.id === 'greenhouse-catalog-worker-aster-atlas' ? {
      ...job, title: AGING_REVISED_TITLE,
      occupation: { version: 7 as const, category: 'engineering' as const, departments: [], evidence: [{ source: 'title' as const, text: AGING_REVISED_TITLE }] },
      roleClassification: { version: 1 as const, roles: ['backend' as const], evidence: [{ role: 'backend' as const, source: 'title' as const, text: AGING_REVISED_TITLE }] },
    } : job)
  return {
    progress: openProgress(revision), companyIds: ['catalog-worker-aster'], jobs,
    catalog: {
      source: 'public', fetchedAt: CATALOG_WORKER_FINAL_TIME, checkedAt: CATALOG_WORKER_FINAL_TIME, stale: false,
      boards: openBoards('fresh'), unmappedCount: 0,
    },
  }
}

export const AGING_DAILY_ID = 'himalayas-catalog-worker-himalaya-daily'
export const AGING_DAILY_AT = {
  asterStale: AGING_AT.asterStale,
  dailyExactly24h: '2026-09-25T08:00:00.000Z',
  bothExpired: '2026-09-25T08:00:00.001Z',
} as const

/** One ordinary company and one daily-feed company read at the same instant. */
export function agingDailyCatalog(): Catalog {
  const base = catalogWorkerCatalog()
  const [aster] = structuredClone(base.companies)
  const himalaya: Company = {
    id: 'catalog-worker-himalaya', name: 'Himalaya QA Listings', initials: 'HQ', color: '#b8860b',
    industry: 'Fictional daily job site', provider: 'himalayas', board: 'catalog-worker-himalaya',
    careerUrl: 'https://example.org/catalog-worker/himalaya/careers',
  }
  const atlas = agingCurrentJobs().find(job => job.id === 'greenhouse-catalog-worker-aster-atlas')!
  const daily: Job = {
    ...atlas, id: AGING_DAILY_ID, companyId: himalaya.id, source: 'himalayas',
    title: 'Backend Engineer — Himalaya Daily', url: 'https://example.org/catalog-worker/himalaya/daily',
    occupation: { version: 7, category: 'engineering', departments: [], evidence: [{ source: 'title', text: 'Backend Engineer — Himalaya Daily' }] },
    roleClassification: { version: 1, roles: ['backend'], evidence: [{ role: 'backend', source: 'title', text: 'Backend Engineer — Himalaya Daily' }] },
  }
  return {
    source: 'public', fetchedAt: CATALOG_WORKER_TIME, checkedAt: CATALOG_WORKER_TIME, stale: false,
    companies: [aster, himalaya], cities: structuredClone(base.cities), jobs: [atlas, daily],
    boards: [
      { companyId: aster.id, provider: 'greenhouse', board: aster.board!, status: 'ok', dataStatus: 'fresh', total: 1, included: 1, lastSuccessAt: CATALOG_WORKER_TIME, checkedAt: CATALOG_WORKER_TIME },
      { companyId: himalaya.id, provider: 'himalayas', board: himalaya.board!, status: 'ok', dataStatus: 'fresh', total: 1, included: 1, lastSuccessAt: CATALOG_WORKER_TIME, checkedAt: CATALOG_WORKER_TIME },
    ],
    unmappedCount: 0,
  }
}

/** Neutral filler: no location, language, working-hour, country or registration statements. */
const FILLER = 'Fictional body padding for transport observation only. '
export const SIZABLE_DESCRIPTION_LENGTH = 20_000

export function padDescription(prefix: string, length = SIZABLE_DESCRIPTION_LENGTH): string {
  let text = prefix
  while (text.length < length) text += FILLER
  return text.slice(0, length)
}

/** The nine current jobs with exactly 20,000-character fictional descriptions (9 x 20,000 = 180,000). */
export function agingSizableCatalog(): Catalog {
  const catalog = agingCurrentCatalog()
  return { ...catalog, jobs: catalog.jobs.map(job => ({ ...job, description: padDescription(job.description) })) }
}
export const SIZABLE_BODY_CHARS = 9 * SIZABLE_DESCRIPTION_LENGTH

// Synthetic workload: 30 fictional companies x 20 jobs, every description exactly 20,000 characters,
// company k read at base + (k - 1) seconds so that every stale and expiry deadline is distinct.
export const WORKLOAD_COMPANIES = 30
export const WORKLOAD_JOBS_PER_COMPANY = 20
export const WORKLOAD_BODIES = WORKLOAD_COMPANIES * WORKLOAD_JOBS_PER_COMPANY
export const WORKLOAD_DESCRIPTION_CHARS = WORKLOAD_BODIES * SIZABLE_DESCRIPTION_LENGTH
export const WORKLOAD_BASE = '2026-09-24T08:00:00.000Z'
const workloadBase = Date.parse(WORKLOAD_BASE)
const pad2 = (value: number) => String(value).padStart(2, '0')

export const workloadCompanyId = (company: number) => `aging-workload-c${pad2(company)}`
export const workloadJobId = (company: number, job: number) => `greenhouse-${workloadCompanyId(company)}-j${pad2(job)}`
export const workloadCompanyIds = (company: number) =>
  Array.from({ length: WORKLOAD_JOBS_PER_COMPANY }, (_, index) => workloadJobId(company, index + 1))
export const workloadTime = (company: number) => new Date(workloadBase + (company - 1) * 1000).toISOString()
/** Company k turns stale exactly 30 minutes after its read; it leaves exactly 24 h + 1 ms after it. */
export const workloadStaleAt = (company: number) => workloadBase + (company - 1) * 1000 + 30 * 60 * 1000
export const workloadExpiryAt = (company: number) => workloadBase + (company - 1) * 1000 + 24 * 60 * 60 * 1000 + 1
export const WORKLOAD_FRESH_NOW = workloadBase + 60 * 1000
export const WORKLOAD_EXACT_24H = workloadBase + 24 * 60 * 60 * 1000

function workloadJob(company: number, index: number): Job {
  const title = `Backend Engineer — Workload C${pad2(company)} J${pad2(index)}`
  return {
    id: workloadJobId(company, index), companyId: workloadCompanyId(company), title, role: 'backend',
    roleClassification: { version: 1, roles: ['backend'], evidence: [{ role: 'backend', source: 'title', text: title }] },
    occupation: { version: 7, category: 'engineering', departments: [], evidence: [{ source: 'title', text: title }] },
    cityIds: ['london'], cityCoverageVersion: 1, locationLabel: 'London, UK',
    workMode: 'onsite', employment: 'fulltime', employmentVersion: 1,
    minExperience: 3, skills: ['TypeScript'],
    qualifications: {
      version: 1,
      skills: [{ kind: 'qualification', skills: ['TypeScript'], match: 'all', evidence: { source: 'description', text: 'Qualifications: experience with TypeScript.' } }],
      experience: [{ kind: 'qualification', minYears: 3, conditional: false, evidence: { source: 'description', text: 'Qualifications: 3 years of software engineering experience.' } }],
    },
    languageRequirements: { version: 1, rules: [] },
    workTimeRequirements: { version: 1, rules: [] },
    salary: { min: 100000, max: 160000, currency: 'USD' }, compensationVersion: COMPENSATION_VERSION,
    visa: 'yes', eligibility: { version: 2, rules: [] },
    remoteCountries: [], remoteWorldwide: false, remoteScopeUnknown: false, remoteScopeVersion: 3,
    description: padDescription(`Fictional workload vacancy ${pad2(company)}-${pad2(index)}. Qualifications: 3 years of software engineering experience with TypeScript. `),
    requirements: ['3 years of software engineering experience with TypeScript.'],
    url: `https://example.org/aging-workload/${pad2(company)}/${pad2(index)}`,
    source: 'greenhouse', updatedAt: null, fetchedAt: workloadTime(company), stale: false,
  }
}

export function agingWorkloadCatalog(): Catalog {
  const base = catalogWorkerCatalog()
  const companies: Company[] = Array.from({ length: WORKLOAD_COMPANIES }, (_, index) => ({
    id: workloadCompanyId(index + 1), name: `Workload QA ${pad2(index + 1)}`, initials: 'WQ', color: '#3974cc',
    industry: 'Fictional software laboratory', provider: 'greenhouse', board: workloadCompanyId(index + 1),
    careerUrl: `https://example.org/aging-workload/${pad2(index + 1)}/careers`,
  }))
  const jobs = companies.flatMap((_, index) =>
    Array.from({ length: WORKLOAD_JOBS_PER_COMPANY }, (_, job) => workloadJob(index + 1, job + 1)))
  return {
    source: 'public', fetchedAt: workloadTime(WORKLOAD_COMPANIES), checkedAt: workloadTime(WORKLOAD_COMPANIES), stale: false,
    companies, cities: structuredClone(base.cities), jobs,
    boards: companies.map((company, index): BoardStatus => ({
      companyId: company.id, provider: 'greenhouse', board: company.board!, status: 'ok', dataStatus: 'fresh',
      total: WORKLOAD_JOBS_PER_COMPANY, included: WORKLOAD_JOBS_PER_COMPANY,
      lastSuccessAt: workloadTime(index + 1), checkedAt: workloadTime(index + 1),
    })),
    unmappedCount: 0,
  }
}
