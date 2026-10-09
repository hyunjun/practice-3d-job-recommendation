import type { CatalogPublicationCapture } from '../../../server/catalog-service'
import type { Company, Job } from '../../../shared/types'
import { PUBLIC_PROVIDERS } from '../../../shared/types'
import { publicationHarness } from '../../fixtures/publication'
import { PUBLIC_TEST_CITIES } from '../../fixtures/public-geography'
import { publicProtocolJob } from '../../fixtures/public-protocol'

/**
 * Realistically sized synthetic publication data: 130 fictional employers (the
 * production registry size) across every supported provider, 50 postings per
 * employer (6,500 served postings, about the historical 6,819 total) with
 * 3,500-character Korean/English descriptions of ordinary compressibility, and a
 * collector history of 90 UTC days (2026-07-06 through 2026-10-03) so the
 * manifest carries a full observation window. No employer, posting, city text
 * or history is real.
 *
 * The acceptance profile is literal (ACR82-1): no environment variable can
 * reduce the acceptance workload. `collectCapacity` refuses any other profile
 * unless the caller explicitly labels it exploratory, and exploratory results
 * are never the acceptance workload.
 */
export const CAPACITY_COMPANY_COUNT = 130
export const CAPACITY_DAY = '2026-10-03'
export const CAPACITY_FIRST_DAY = '2026-07-06'
export const CAPACITY_TIME = `${CAPACITY_DAY}T06:00:00.000Z`
export const CAPACITY_NOW = `${CAPACITY_DAY}T06:05:00.000Z`
export interface CapacityProfile { companies: number; jobsPerCompany: number; servedJobs: number; descriptionChars: number; days: number; firstDay: string; lastDay: string }
export const ACCEPTANCE_PROFILE: Readonly<CapacityProfile> = Object.freeze({
  companies: 130, jobsPerCompany: 50, servedJobs: 6500, descriptionChars: 3500, days: 90, firstDay: CAPACITY_FIRST_DAY, lastDay: CAPACITY_DAY,
})
const DAY_MS = 86_400_000
/** The 90 consecutive UTC days of the acceptance window, oldest first, derived from the literal endpoints. */
export function acceptanceDays(profile: Readonly<CapacityProfile> = ACCEPTANCE_PROFILE): string[] {
  const last = Date.parse(`${profile.lastDay}T00:00:00.000Z`)
  const days = Array.from({ length: profile.days }, (_, index) => new Date(last - (profile.days - 1 - index) * DAY_MS).toISOString().slice(0, 10))
  if (days[0] !== profile.firstDay || days.at(-1) !== profile.lastDay) throw new Error(`The acceptance window ${profile.firstDay}..${profile.lastDay} does not span ${profile.days} days`)
  return days
}
/** Validate a profile is exactly the acceptance profile before any expensive collection. */
export function validateAcceptanceProfile(profile: CapacityProfile): void {
  const problems: string[] = []
  for (const key of Object.keys(ACCEPTANCE_PROFILE) as (keyof CapacityProfile)[]) {
    if (profile[key] !== ACCEPTANCE_PROFILE[key]) problems.push(`${key}=${String(profile[key])} (acceptance ${String(ACCEPTANCE_PROFILE[key])})`)
  }
  if (profile.companies * profile.jobsPerCompany !== profile.servedJobs) problems.push('servedJobs must equal companies × jobsPerCompany')
  if (problems.length) throw new Error(`Not the acceptance workload: ${problems.join('; ')}`)
  acceptanceDays(profile)
}
/** Exploratory knobs for ad-hoc local runs; never used by the acceptance spec. */
export const exploratoryOptions = (): CapacityProfile => {
  const jobsPerCompany = Number(process.env.ORBIT_CAPACITY_JOBS_PER_COMPANY ?? 50)
  const days = Number(process.env.ORBIT_CAPACITY_DAYS ?? 90)
  const last = Date.parse(`${CAPACITY_DAY}T00:00:00.000Z`)
  return {
    companies: CAPACITY_COMPANY_COUNT, jobsPerCompany, servedJobs: CAPACITY_COMPANY_COUNT * jobsPerCompany,
    descriptionChars: Number(process.env.ORBIT_CAPACITY_DESCRIPTION_CHARS ?? 3500), days,
    firstDay: new Date(last - (days - 1) * DAY_MS).toISOString().slice(0, 10), lastDay: CAPACITY_DAY,
  }
}

const WORDS = [
  '백엔드', '프론트엔드', '데이터', '플랫폼', '인프라', '결제', '검색', '추천', '지도', '관측', '배포', '테스트', '설계', '운영', '보안',
  'TypeScript', 'Python', 'Go', 'Rust', 'Kotlin', 'React', 'Node.js', 'PostgreSQL', 'Kafka', 'Kubernetes', 'AWS', 'GCP', 'Terraform',
  'service', 'latency', 'reliability', 'observability', 'migration', 'schema', 'pipeline', 'streaming', 'cache', 'index', 'replica',
  '협업합니다', '설계합니다', '운영합니다', '개선합니다', '분석합니다', '검증합니다', '배포합니다', '측정합니다',
  'experience', 'years', 'team', 'product', 'customers', 'quality', 'ownership', 'mentoring', 'documentation', 'incident', 'review',
]
function xorshift(seed: number) {
  let state = (seed >>> 0) || 1
  return () => {
    state ^= state << 13; state >>>= 0
    state ^= state >>> 17
    state ^= state << 5; state >>>= 0
    return state
  }
}
/** Sentence-like deterministic text of ordinary compressibility (roughly 3:1 under gzip), not random bytes; exactly `length` characters. */
export function realisticDescription(seed: number, length: number): string {
  const next = xorshift(seed)
  const parts: string[] = []
  let size = 0
  while (size < length) {
    const words = Array.from({ length: 6 + (next() % 9) }, () => WORDS[next() % WORDS.length])
    const sentence = `${words.join(' ')}.`
    parts.push(sentence)
    size += sentence.length + 1
    if (next() % 7 === 0) { parts.push('\n'); size++ }
  }
  return parts.join(' ').slice(0, length)
}

export function capacityCompanies(count = CAPACITY_COMPANY_COUNT): Company[] {
  return Array.from({ length: count }, (_, index) => {
    const number = String(index + 1).padStart(3, '0')
    const provider = PUBLIC_PROVIDERS[index % PUBLIC_PROVIDERS.length]
    return {
      id: `synthetic-employer-${number}`, name: `Synthetic Employer ${number}`, initials: 'SE', color: '#3974cc',
      industry: '가상 용량 검증', provider, board: `synthetic-employer-${number}`,
      careerUrl: `https://example.test/synthetic-employer-${number}/careers`,
    }
  })
}

export function capacityJobs(company: Company, count: number, descriptionChars: number, fetchedAt: string): Job[] {
  const provider = company.provider ?? 'greenhouse'
  const seedBase = Number(company.id.slice(-3)) * 1000
  return Array.from({ length: count }, (_, index) => {
    const city = PUBLIC_TEST_CITIES[(seedBase + index) % PUBLIC_TEST_CITIES.length]
    const remote = index % 11 === 0
    return publicProtocolJob(`${index + 1}`, {
      id: `${provider}-${company.id}-${index + 1}`, companyId: company.id, source: provider, fetchedAt,
      title: `${['Backend', 'Frontend', 'Platform', 'Data', 'Security'][index % 5]} Engineer — ${company.name} ${index + 1}`,
      cityIds: remote ? [] : [city.id], locationLabel: remote ? 'Remote · Worldwide' : city.en,
      workMode: remote ? 'remote' : index % 3 === 0 ? 'hybrid' : 'onsite', remoteWorldwide: remote,
      description: realisticDescription(seedBase + index, descriptionChars),
      requirements: [`${3 + (index % 5)} years of engineering experience.`],
      minExperience: 3 + (index % 5),
      url: `https://example.test/synthetic-employer-${company.id.slice(-3)}/jobs/${index + 1}`,
    })
  })
}
/** The substantive fields a served posting must reproduce from the fictional input (the runtime adds `stale`; `fetchedAt` is the capture time). */
export const SERVED_JOB_FIELDS = ['id', 'companyId', 'source', 'title', 'description', 'url', 'cityIds', 'locationLabel', 'workMode', 'remoteWorldwide', 'requirements', 'minExperience', 'skills', 'role', 'employment', 'visa'] as const
export type ServedJobExpectation = Pick<Job, typeof SERVED_JOB_FIELDS[number]>
export const expectedServedJob = (job: Job): ServedJobExpectation => Object.fromEntries(SERVED_JOB_FIELDS.map(field => [field, job[field]])) as ServedJobExpectation

export interface CapacityCollection {
  profile: Readonly<CapacityProfile>
  capture: CatalogPublicationCapture
  companies: Company[]
  /** Every fictional posting by id, as handed to the collector. */
  jobsById: Map<string, Job>
  totalJobs: number
  days: string[]
  /** Wall time of each daily collection run in milliseconds. */
  runMs: number[]
}

/** Collect the daily runs of the acceptance window so the final capture carries a full observation window. */
export async function collectCapacity(profile: CapacityProfile = ACCEPTANCE_PROFILE, labelled?: { exploratory: true }): Promise<CapacityCollection> {
  if (!labelled?.exploratory) validateAcceptanceProfile(profile)
  if (profile.companies !== CAPACITY_COMPANY_COUNT) throw new Error('The fixture registry always has 130 employers')
  const days = acceptanceDays(profile)
  const companies = capacityCompanies()
  const harness = publicationHarness({ companies, at: CAPACITY_TIME })
  const jobsFor = new Map(companies.map(company => [company.id, capacityJobs(company, profile.jobsPerCompany, profile.descriptionChars, CAPACITY_TIME)]))
  const jobsById = new Map<string, Job>()
  for (const jobs of jobsFor.values()) for (const job of jobs) jobsById.set(job.id, job)
  if (jobsById.size !== profile.servedJobs) throw new Error(`The fixture produced ${jobsById.size} postings, not ${profile.servedJobs}`)
  harness.fetchBoard.mockImplementation(async (company, fetchedAt) => {
    const jobs = jobsFor.get(company.id)!.map(job => ({ ...job, fetchedAt }))
    return { jobs, total: jobs.length, unmappedCount: 0, publishedIds: jobs.map(job => job.id) }
  })
  harness.fetchPresence.mockImplementation(async company => {
    const jobs = jobsFor.get(company.id)!
    return { total: jobs.length, publishedIds: jobs.map(job => job.id) }
  })
  const runMs: number[] = []
  let capture: CatalogPublicationCapture | undefined
  for (const day of days) {
    harness.at(`${day}T06:00:00.000Z`)
    const started = performance.now()
    const checkpoint = capture ? {
      boards: structuredClone(capture.boards), presence: structuredClone(capture.presences),
      observations: structuredClone(capture.observationCheckpoint),
    } : undefined
    capture = (await harness.run(checkpoint)).capture
    runMs.push(Math.round(performance.now() - started))
  }
  return { profile, capture: capture!, companies, jobsById, totalJobs: jobsById.size, days, runMs }
}
