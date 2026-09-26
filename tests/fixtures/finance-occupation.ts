import { CITIES } from '../../shared/cities'
import type { Catalog, Company, Job, JobOccupation, KnownJobRole, Profile, SavedJob } from '../../shared/types'
import type { PostingStatusIndex } from '../../shared/posting-status'

// All companies, postings, descriptions, notes and source identifiers here are
// invented. This fixture must never load collected material or a public API.
export const FINANCE_TIME = '2026-09-27T02:00:00.000Z'
export const FINANCE_NEXT_TIME = '2026-09-27T02:02:00.000Z'
export const FINANCE_DESCRIPTION = 'Responsibilities\nPrepare quarterly spending forecasts for a fictional lantern catalogue. Compare planned and actual costs and recommend budget allocations. Use a small Python worksheet to reconcile totals; the engineering team is the budget customer.\nRequirements\nExperience with FP&A and accounting.'
export const FINANCE_SOFTWARE_DESCRIPTION = 'Responsibilities\nImplement production software and maintain automated tests for a fictional ledger service.\nRequirements\nExperience with TypeScript and software development.'
export const FINANCE_RESEARCH_DESCRIPTION = 'Responsibilities\nResearch computer algorithms and develop distributed systems for a fictional ledger benchmark.\nRequirements\nExperience with computer science research.'
export const FINANCE_COMPANY: Company = {
  id: 'fable-ledger', name: 'Fable Ledger Lab', initials: 'FL', color: '#84dba6',
  industry: 'Fictional financial software', provider: 'ashby', board: 'fable-ledger',
  careerUrl: 'https://example.org/fable-ledger/careers',
}
export const FINANCE_PROFILE: Profile = {
  kind: 'personal', name: 'Fictional Finance Scope Tester', headline: 'Software Engineer',
  desiredRole: 'all', skills: [], years: 5, residence: 'GB', linkedinUrl: '',
}

// Independent role expectations; no production classifier constructs an oracle.
export const FINANCE_PRIMARY_TITLES = [
  'Strategic Finance Lead, Platform & Engineering',
  'Senior Financial Analyst - Engineering',
  'FP&A Lead | Engineering',
  'Finance Associate supporting Engineering',
  'Finance Partner for Software Engineering',
  'Financial Controller (Engineering)',
  'Accounting Lead — Engineering',
  'Senior Accountant, Product Engineering',
  'FP&A Analyst serving Engineering',
  'Engineering Finance Analyst',
  'Financial Planning & Analysis Analyst; Engineering',
  'Finance Lead',
  'Accountant',
]
export const FINANCE_COMPUTING_CASES: {
  title: string; description: string; category: JobOccupation['category']; roles: KnownJobRole[]
}[] = [
  { title: 'Backend Software Engineer, Finance', description: FINANCE_SOFTWARE_DESCRIPTION, category: 'engineering', roles: ['backend'] },
  { title: 'Software Engineer, Financial Controller Tools', description: FINANCE_SOFTWARE_DESCRIPTION, category: 'engineering', roles: [] },
  { title: 'Financial Engineer', description: FINANCE_SOFTWARE_DESCRIPTION, category: 'engineering', roles: [] },
  { title: 'Data Scientist, Finance', description: FINANCE_SOFTWARE_DESCRIPTION, category: 'engineering', roles: ['data'] },
  { title: 'Computer Science Researcher, Finance', description: FINANCE_RESEARCH_DESCRIPTION, category: 'research', roles: [] },
  { title: 'Finance Lead & Software Engineer', description: FINANCE_SOFTWARE_DESCRIPTION, category: 'engineering', roles: [] },
  { title: 'Finance Analyst & Data Scientist', description: FINANCE_SOFTWARE_DESCRIPTION, category: 'engineering', roles: ['data'] },
  { title: 'Financial Analyst / Computer Science Researcher', description: FINANCE_RESEARCH_DESCRIPTION, category: 'research', roles: [] },
  { title: 'FP&A Lead & Financial Engineer', description: FINANCE_SOFTWARE_DESCRIPTION, category: 'engineering', roles: [] },
  { title: 'Lead Software Engineer, Finance', description: FINANCE_SOFTWARE_DESCRIPTION, category: 'engineering', roles: [] },
  { title: 'Engineer', description: '', category: 'engineering', roles: [] },
]

export function financePosting(id: string, title: string, description = FINANCE_DESCRIPTION, location = 'London, UK') {
  return {
    id, title, descriptionPlain: description, location, department: 'All Departments', team: 'Finance',
    jobUrl: `https://example.org/fable-ledger/${id}`, isListed: true,
    workplaceType: 'OnSite', employmentType: 'FullTime',
  }
}

export function financeFeed(refreshed = false) {
  const jobs = [
    financePosting('101', 'Strategic Finance Lead, Platform & Engineering'),
    financePosting('102', 'Finance Associate supporting Engineering'),
    financePosting('103', 'Accountant, Engineering'),
    financePosting('201', refreshed ? 'Backend Software Engineer, Ledger Core' : 'Backend Software Engineer, Finance Ledger', FINANCE_SOFTWARE_DESCRIPTION),
    financePosting('202', 'Backend Software Engineer, Finance Forecasts', FINANCE_SOFTWARE_DESCRIPTION, 'New York, NY, United States'),
    financePosting('203', 'Financial Engineer, Finance Simulator', FINANCE_SOFTWARE_DESCRIPTION),
    financePosting('204', 'Data Scientist, Finance Projections', FINANCE_SOFTWARE_DESCRIPTION),
    financePosting('205', 'Computer Science Researcher, Finance Algorithms', FINANCE_RESEARCH_DESCRIPTION),
  ]
  if (refreshed) jobs.push(financePosting('206', 'Backend Software Engineer, Finance Planning', FINANCE_SOFTWARE_DESCRIPTION))
  return { apiVersion: '1' as const, jobs }
}

/** Literal historical v4 input, including the mistaken engineering category. */
export function legacyFinanceJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 'ashby-fable-ledger-101', companyId: 'fable-ledger',
    title: 'Strategic Finance Lead, Platform & Engineering', description: FINANCE_DESCRIPTION,
    role: 'unknown', roleClassification: { version: 1, roles: [], evidence: [] },
    occupation: {
      version: 4, category: 'engineering', departments: ['All Departments', 'Finance'],
      evidence: [{ source: 'title', text: 'Strategic Finance Lead, Platform & Engineering' }],
    },
    cityIds: ['london'], locationLabel: 'London, UK', workMode: 'onsite', employment: 'fulltime',
    minExperience: null, skills: [], salary: null, visa: 'unknown', requirements: [],
    remoteCountries: [], remoteWorldwide: false, remoteScopeUnknown: false,
    source: 'ashby', updatedAt: '2026-09-25T06:07:08.000Z', fetchedAt: FINANCE_TIME,
    url: 'https://example.org/fable-ledger/101', ...overrides,
  }
}

export function legacyFinanceDeveloper(): Job {
  return legacyFinanceJob({
    id: 'ashby-fable-ledger-201', title: 'Backend Software Engineer, Finance Ledger',
    description: FINANCE_SOFTWARE_DESCRIPTION, role: 'backend',
    roleClassification: {
      version: 1, roles: ['backend'],
      evidence: [{ role: 'backend', source: 'title', text: 'Backend Software Engineer, Finance Ledger' }],
    },
    occupation: {
      version: 4, category: 'engineering', departments: ['All Departments', 'Finance'],
      evidence: [{ source: 'title', text: 'Backend Software Engineer, Finance Ledger' }],
    },
    url: 'https://example.org/fable-ledger/201',
  })
}

export function legacyFinanceSaved(): SavedJob {
  return {
    job: legacyFinanceJob(), company: { ...FINANCE_COMPANY },
    savedAt: '2026-09-26T03:04:05.000Z', status: 'applied',
    note: 'Fictional finance memo: keep the original forecast role.',
  }
}

export function financeCatalog(jobs: Job[], total: number, refreshed = false): Catalog {
  const at = refreshed ? FINANCE_NEXT_TIME : FINANCE_TIME
  return {
    source: 'public', fetchedAt: at, checkedAt: at, stale: false,
    refreshAfter: refreshed ? '2026-09-27T02:03:00.000Z' : '2026-09-27T02:01:00.000Z',
    cities: CITIES.filter(city => city.id === 'london' || city.id === 'new-york'),
    companies: [{ ...FINANCE_COMPANY, name: refreshed ? 'Fable Ledger Lab Revised' : 'Fable Ledger Lab' }],
    jobs, unmappedCount: 0,
    boards: [{
      companyId: 'fable-ledger', provider: 'ashby', board: 'fable-ledger',
      status: 'ok', dataStatus: 'fresh', total, included: jobs.length,
      checkedAt: at, lastSuccessAt: at, retryAt: null,
    }],
  }
}

export const FINANCE_V4_METHOD = 'observations-1.occupation-4.roles-1.qualifications-1.remote-2.employment-1.purpose-1'
export function legacyFinanceBoard() {
  return {
    companyId: 'fable-ledger', provider: 'ashby' as const, board: 'fable-ledger',
    checkedAt: FINANCE_TIME, failures: 0, retryAt: null,
    snapshot: {
      fetchedAt: FINANCE_TIME, total: 3, unmappedCount: 0,
      jobs: [legacyFinanceJob(), legacyFinanceDeveloper()],
      publishedIds: ['ashby-fable-ledger-101', 'ashby-fable-ledger-201', 'ashby-fable-ledger-999'],
      observationMethod: FINANCE_V4_METHOD,
    },
  }
}

// Presence v2 deliberately has no comparable body for the excluded finance ID.
export function financePostingIndex(): PostingStatusIndex {
  return {
    version: 2, checkedAt: FINANCE_TIME, refreshAfter: '2026-09-27T02:01:00.000Z',
    contentRefreshAfter: '2026-09-27T02:01:00.000Z',
    boards: [{
      companyId: 'fable-ledger', provider: 'ashby', board: 'fable-ledger',
      status: 'ok', checkedAt: FINANCE_TIME, lastSuccessAt: FINANCE_TIME, retryAt: null,
      listing: {
        validUntil: '2026-09-27T02:30:00.000Z',
        publishedIds: ['ashby-fable-ledger-101', 'ashby-fable-ledger-201', 'ashby-fable-ledger-999'],
        jobs: [],
      },
    }],
  }
}
