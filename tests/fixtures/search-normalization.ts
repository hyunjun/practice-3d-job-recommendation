import { CITIES } from '../../shared/cities'
import { COMPENSATION_VERSION, ELIGIBILITY_VERSION, QUALIFICATIONS_VERSION } from '../../shared/types'
import type { Catalog, Company, Filters, Job, Profile, SavedJob } from '../../shared/types'

export const NORMALIZATION_TIME = '2026-09-26T08:00:00.000Z'
export const NORMALIZATION_PROFILE: Profile = {
  kind: 'personal', name: 'Fictional Search Reader', headline: 'Software Engineer',
  years: null, skills: [], desiredRole: 'backend', residence: 'CA', linkedinUrl: '',
}
export const NORMALIZATION_FILTERS: Filters = {
  query: '', region: 'all', role: 'backend', workMode: 'all', visa: 'all',
  employment: 'all', postingType: 'opening', salaryMin: 0,
  includeUnknownSalary: true, remoteEligibleOnly: false,
}
export const NORMALIZATION_COMPANIES: Company[] = [
  {
    id: 'cedar56', name: 'Café Atlas', initials: 'CA', color: '#84dba6',
    industry: 'Fictional software studio', provider: 'greenhouse', board: 'cedar56',
    careerUrl: 'https://example.org/cedar56',
  },
  {
    id: 'lumen56', name: 'Lumen Labs', initials: 'LL', color: '#84dba6',
    industry: 'Fictional software studio', provider: 'greenhouse', board: 'lumen56',
    careerUrl: 'https://example.org/lumen56',
  },
]

export function normalizationJob(id: string, overrides: Partial<Job> = {}): Job {
  return {
    id, companyId: 'lumen56', title: 'Backend Engineer — Fictional Opening', role: 'backend',
    cityIds: [], locationLabel: 'Unspecified workshop', workMode: 'onsite', employment: 'fulltime',
    minExperience: null, skills: ['TypeScript'], salary: { min: 100000, max: 160000, currency: 'USD' },
    compensationVersion: COMPENSATION_VERSION, visa: 'unknown',
    qualifications: {
      version: QUALIFICATIONS_VERSION,
      skills: [{
        kind: 'qualification', skills: ['TypeScript'], match: 'all',
        evidence: { source: 'description', text: 'Qualifications: experience with TypeScript.' },
      }],
      experience: [],
    },
    eligibility: { version: ELIGIBILITY_VERSION, rules: [] },
    remoteCountries: [], remoteWorldwide: false, remoteScopeUnknown: false,
    description: 'A fictional backend software engineering position. Qualifications: experience with TypeScript.',
    requirements: ['Experience with TypeScript.'],
    url: `https://example.org/openings/${id}`, source: 'greenhouse',
    updatedAt: null, fetchedAt: NORMALIZATION_TIME,
    ...overrides,
  }
}

// Fictional source strings deliberately retain their original Unicode forms.
// IDs, expected result sets and counts are authored independently in the tests.
export function normalizationJobs(): Job[] {
  return [
    normalizationJob('greenhouse-cedar56-01', {
      companyId: 'cedar56', title: 'Backend Engineer — C++ Atlas',
      locationLabel: 'Montréal, Canada', skills: ['TypeScript', 'C++'],
      workplaceLocations: { version: 1, locations: [{ label: 'Montréal, Canada', country: 'CA' }] },
    }),
    normalizationJob('greenhouse-cedar56-02', {
      companyId: 'cedar56', title: 'Backend Engineer — C# Beacon',
      locationLabel: 'Montre\u0301al, Canada', skills: ['TypeScript', 'C#'], employment: 'contract',
      workplaceLocations: { version: 1, locations: [{ label: 'Montre\u0301al, Canada', country: 'CA' }] },
    }),
    normalizationJob('greenhouse-lumen56-03', {
      title: 'Backend Engineer — .NET Compass', locationLabel: 'Montreal, Canada',
      skills: ['TypeScript', '.NET'], salary: null,
      workplaceLocations: { version: 1, locations: [{ label: 'Montreal, Canada', country: 'CA' }] },
    }),
    normalizationJob('greenhouse-cedar56-04', {
      companyId: 'cedar56', title: 'Backend Engineer — São Paulo Ledger', locationLabel: 'São Paulo, Brazil',
      workplaceLocations: { version: 1, locations: [{ label: 'São Paulo, Brazil', country: 'BR' }] },
    }),
    normalizationJob('greenhouse-lumen56-05', {
      title: 'Backend Engineer — Sao Paulo Harbor', locationLabel: 'Sao Paulo, Brazil',
      workplaceLocations: { version: 1, locations: [{ label: 'Sao Paulo, Brazil', country: 'BR' }] },
    }),
    normalizationJob('greenhouse-cedar56-06', {
      companyId: 'cedar56', title: 'Backend Engineer — 서울 Bridge',
      cityIds: ['seoul'], locationLabel: '서울',
    }),
    normalizationJob('greenhouse-lumen56-07', {
      title: 'Backend Engineer — 서울 Beacon',
      cityIds: ['seoul'], locationLabel: '서울',
    }),
    normalizationJob('greenhouse-lumen56-08', {
      title: 'Backend Engineer — Ｏｆｆｉｃｅ Grid', cityIds: ['london'], locationLabel: 'London',
    }),
    normalizationJob('greenhouse-cedar56-09', {
      companyId: 'cedar56', title: 'Backend Engineer — Café Relay',
      workMode: 'remote', locationLabel: 'Remote, Canada', remoteCountries: ['CA'],
    }),
    normalizationJob('greenhouse-lumen56-10', {
      title: 'Backend Engineer — Cafe\u0301 Relay Restricted',
      workMode: 'remote', locationLabel: 'Remote, Brazil', remoteCountries: ['BR'],
    }),
    normalizationJob('greenhouse-lumen56-11', {
      title: 'Backend Engineer — Reykjavík Signal', locationLabel: 'Reykjavík, Iceland',
      workplaceLocations: { version: 1, locations: [{ label: 'Reykjavík, Iceland', country: 'IS' }] },
    }),
  ]
}

export function normalizationCatalog(jobs = normalizationJobs(), unmappedCount = 6): Catalog {
  return {
    source: 'public', fetchedAt: NORMALIZATION_TIME, stale: false, cities: CITIES,
    companies: NORMALIZATION_COMPANIES.map(company => ({ ...company })),
    jobs, unmappedCount,
    // These transport totals describe the fictional input, before any search.
    // The real client validates one board receipt for each catalog company.
    boards: NORMALIZATION_COMPANIES.map(company => ({
      companyId: company.id, provider: 'greenhouse', board: company.board!,
      status: 'ok', dataStatus: 'fresh', checkedAt: NORMALIZATION_TIME,
      total: jobs.filter(job => job.companyId === company.id).length,
      included: jobs.filter(job => job.companyId === company.id).length,
    })),
  }
}

export function markedScriptCatalog(): Catalog {
  return normalizationCatalog([
    normalizationJob('greenhouse-lumen56-kana-voiced', { title: 'Backend Engineer — ガ' }),
    normalizationJob('greenhouse-lumen56-kana-plain', { title: 'Backend Engineer — カ' }),
    normalizationJob('greenhouse-lumen56-indic-marked', { title: 'Backend Engineer — कि' }),
    normalizationJob('greenhouse-lumen56-indic-plain', { title: 'Backend Engineer — क' }),
    normalizationJob('greenhouse-lumen56-arabic-marked', { title: 'Backend Engineer — عَلَم' }),
    normalizationJob('greenhouse-lumen56-arabic-plain', { title: 'Backend Engineer — علم' }),
  ], 6)
}

export function normalizationSaved(): SavedJob[] {
  const jobs = normalizationJobs()
  const rows: [number, SavedJob['status'], string][] = [
    [0, 'saved', 'Révision originale — naïve façade'],
    [1, 'saved', 'Cafe\u0301 follow-up'],
    [2, 'applied', 'crème brûlée; PRIVATE56'],
    [3, 'applied', 'São Paulo — résumé'],
    [4, 'saved', 'plain harbor note'],
    [7, 'saved', '=1+2\nPRIVATE-NOTE56 résumé, "原文" ガ कि عَلَم'],
  ]
  return rows.map(([index, status, note]) => ({
    job: jobs[index], company: { ...NORMALIZATION_COMPANIES.find(company => company.id === jobs[index].companyId)! },
    savedAt: '2026-09-25T08:00:00.000Z', status, note,
  }))
}
