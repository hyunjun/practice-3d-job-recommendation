import type { Job } from '../../shared/types'
import {
  ADDED_PUBLIC_REGISTRATIONS, COVERAGE_EXPANSION_URLS, COVERAGE_QUALIFICATIONS,
  EXPANDED_PUBLIC_REGISTRATIONS, coverageGreenhouseRaw, coverageLegacyCache, publicCoverageResponses,
} from './public-coverage'

// Every posting and application URL is invented. The native and normalized IDs
// are separate literals; no production normalization supplies an expected value.
export const EXPANSION_JOBS = [
  { companyId: 'openai', source: 'ashby', nativeId: 'synthetic-57101', id: 'ashby-openai-synthetic-57101', title: 'Backend Engineer — Synthetic Cedar API', role: 'backend', url: 'https://example.com/synthetic/openai-57101' },
  { companyId: 'notion', source: 'ashby', nativeId: 'synthetic-57102', id: 'ashby-notion-synthetic-57102', title: 'Backend Engineer — Synthetic Maple Index', role: 'backend', url: 'https://example.com/synthetic/notion-57102' },
  { companyId: 'reddit', source: 'greenhouse', nativeId: 57103, id: 'greenhouse-reddit-57103', title: 'Frontend Engineer — Synthetic Birch Console', role: 'frontend', url: 'https://example.com/synthetic/reddit-57103' },
  { companyId: 'discord', source: 'greenhouse', nativeId: 57104, id: 'greenhouse-discord-57104', title: 'Backend Engineer — Synthetic Willow Queue', role: 'backend', url: 'https://example.com/synthetic/discord-57104' },
  { companyId: 'coinbase', source: 'greenhouse', nativeId: 57105, id: 'greenhouse-coinbase-57105', title: 'Backend Engineer — Synthetic Aspen Ledger', role: 'backend', url: 'https://example.com/synthetic/coinbase-57105' },
  { companyId: 'dropbox', source: 'greenhouse', nativeId: 57106, id: 'greenhouse-dropbox-57106', title: 'Backend Engineer — Synthetic Hazel Storage', role: 'backend', url: 'https://example.com/synthetic/dropbox-57106' },
  { companyId: 'duolingo', source: 'greenhouse', nativeId: 57107, id: 'greenhouse-duolingo-57107', title: 'Backend Engineer — Synthetic Elm Lessons', role: 'backend', url: 'https://example.com/synthetic/duolingo-57107' },
  { companyId: 'roblox', source: 'greenhouse', nativeId: 57108, id: 'greenhouse-roblox-57108', title: 'Backend Engineer — Synthetic Rowan Sessions', role: 'backend', url: 'https://example.com/synthetic/roblox-57108' },
  { companyId: 'spacex', source: 'greenhouse', nativeId: 57109, id: 'greenhouse-spacex-57109', title: 'Backend Engineer — Synthetic Fir Telemetry', role: 'backend', url: 'https://example.com/synthetic/spacex-57109' },
  { companyId: 'pinterest', source: 'greenhouse', nativeId: 57110, id: 'greenhouse-pinterest-57110', title: 'Backend Engineer — Synthetic Alder Search', role: 'backend', url: 'https://example.com/synthetic/pinterest-57110' },
  { companyId: 'databricks', source: 'greenhouse', nativeId: 57111, id: 'greenhouse-databricks-57111', title: 'Backend Engineer — Synthetic Linden Tables', role: 'backend', url: 'https://example.com/synthetic/databricks-57111' },
  { companyId: 'robinhood', source: 'greenhouse', nativeId: 57112, id: 'greenhouse-robinhood-57112', title: 'Backend Engineer — Synthetic Spruce Orders', role: 'backend', url: 'https://example.com/synthetic/robinhood-57112' },
] as const

export const EXPANSION_NOTE = '가상 확장 메모 — Notion / café\n서류 준비 🌿'

export function expansionResponses() {
  const responses = publicCoverageResponses()
  for (const [index, job] of EXPANSION_JOBS.entries()) {
    const paragraph = job.role === 'frontend'
      ? 'Synthetic test posting: develop frontend software interfaces with React and TypeScript in Seoul.'
      : 'Synthetic test posting: develop backend software services with TypeScript and PostgreSQL in Seoul.'
    responses[COVERAGE_EXPANSION_URLS[index]] = job.source === 'ashby' ? {
      apiVersion: '1',
      jobs: [{
        id: job.nativeId, title: job.title, jobUrl: job.url, isListed: true,
        department: 'Software Engineering', team: 'Backend', location: 'Seoul, South Korea',
        workplaceType: 'OnSite', isRemote: false, employmentType: 'FullTime',
        descriptionPlain: `${paragraph}\n\n${COVERAGE_QUALIFICATIONS}`,
      }],
    } : {
      jobs: [coverageGreenhouseRaw(job.nativeId, job.title, job.companyId, {
        absolute_url: job.url, content: `<p>${paragraph}</p><p>${COVERAGE_QUALIFICATIONS}</p>`,
        departments: [{ name: 'Software Engineering' }],
      })],
      meta: { total: 1 },
    }
  }
  return responses
}

/** A successful old24-board cache: one old source job and23 empty boards. */
export function expansionLegacyCache(fetchedAt: string) {
  const old = coverageLegacyCache(fetchedAt)
  return {
    ...old,
    boards: [
      ...old.boards,
      ...ADDED_PUBLIC_REGISTRATIONS.map(company => ({
        companyId: company.id, provider: 'greenhouse', board: company.board!,
        checkedAt: fetchedAt, failures: 0, retryAt: null,
        snapshot: { fetchedAt, jobs: [], total: 0, unmappedCount: 0, publishedIds: [] },
      })),
    ],
  }
}

/** Frozen pre-Stage61 cohort: Stripe and Notion survive; the other34 boards are empty. */
export function expansionLegacy36Cache(fetchedAt: string) {
  const old = expansionLegacyCache(fetchedAt)
  const notion: Job = {
    id: 'ashby-notion-synthetic-57102', companyId: 'notion', source: 'ashby',
    title: 'Backend Engineer — Synthetic Maple Index', role: 'backend',
    cityIds: ['seoul'], locationLabel: 'Seoul, South Korea', workMode: 'onsite',
    employment: 'fulltime', minExperience: 3, skills: ['TypeScript', 'PostgreSQL'],
    salary: null, visa: 'unknown', requirements: [],
    remoteCountries: [], remoteWorldwide: false, remoteScopeUnknown: false, remoteScopeVersion: 2,
    description: 'Synthetic test posting: develop backend software services with TypeScript and PostgreSQL in Seoul.\n\nQualifications: 3 years of software engineering experience with TypeScript and PostgreSQL.',
    url: 'https://example.com/synthetic/notion-57102', fetchedAt, updatedAt: fetchedAt,
  }
  return {
    ...old,
    boards: [
      ...old.boards,
      ...EXPANDED_PUBLIC_REGISTRATIONS.map(company => ({
        companyId: company.id, provider: company.provider!, board: company.board!,
        checkedAt: fetchedAt, failures: 0, retryAt: null,
        snapshot: {
          fetchedAt, jobs: company.id === 'notion' ? [notion] : [],
          total: company.id === 'notion' ? 1 : 0, unmappedCount: 0,
          publishedIds: company.id === 'notion' ? ['ashby-notion-synthetic-57102'] : [],
        },
      })),
    ],
  }
}
