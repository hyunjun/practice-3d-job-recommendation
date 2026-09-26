import type { Company, Job, SavedJob } from '../../shared/types'
import { WORKPLACE_COUNTRY_FETCHED_AT, WORKPLACE_COUNTRY_NOTE, WORKPLACE_COUNTRY_SAVED_AT } from './workplace-countries'

export const LEGACY_COUNTRY_COMPANY: Company = {
  id: 'country-fern', name: 'Fern Beacon Labs', industry: '가상 관측 도구',
  provider: 'greenhouse', board: 'FernCountries55', careerUrl: 'https://example.com/careers/country-fern',
  initials: 'FB', color: '#a79aff',
}

// Literal pre-country snapshot, including the older public facts. The parent
// baseline's fictional source established this shape; no new normalizer is used
// and no current field is deleted to manufacture a legacy input.
export function legacyCountryJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 'greenhouse-country-fern-5501', companyId: 'country-fern',
    title: 'Backend Engineer — Lantern Ledger', role: 'backend',
    roleClassification: {
      version: 1, roles: ['backend'],
      evidence: [{ role: 'backend', source: 'title', text: 'Backend Engineer — Lantern Ledger' }],
    },
    occupation: {
      version: 3, category: 'engineering', departments: ['Engineering'],
      evidence: [{ source: 'title', text: 'Backend Engineer — Lantern Ledger' }],
    },
    cityIds: [], locationLabel: 'Tallinn, Estonia', workMode: 'onsite',
    employment: 'fulltime', employmentVersion: 1, minExperience: 3, skills: [],
    qualifications: {
      version: 1, skills: [], experience: [{
        kind: 'required', minYears: 3, conditional: false,
        evidence: { source: 'description', text: 'Minimum requirements\n3 years of software engineering experience.' },
      }],
    },
    languageRequirements: { version: 1, rules: [] }, workTimeRequirements: { version: 1, rules: [] },
    salary: null, compensationVersion: 2, visa: 'unknown', eligibility: { version: 2, rules: [] },
    remoteCountries: [], remoteWorldwide: false, remoteScopeUnknown: false,
    description: 'Build observability services with TypeScript.\nMinimum requirements: 3 years of software engineering experience.',
    requirements: [], url: 'https://example.com/jobs/country-fern-5501', source: 'greenhouse',
    updatedAt: '2026-09-24T08:30:00.000Z', fetchedAt: WORKPLACE_COUNTRY_FETCHED_AT, stale: false,
    evidence: {
      workMode: { source: 'board', text: 'Workplace Type: Onsite' },
      employment: { source: 'board', text: 'Employment Type: Full-time' },
    },
    ...overrides,
  }
}

export function legacyCountrySaved(): SavedJob {
  return {
    job: legacyCountryJob(), company: LEGACY_COUNTRY_COMPANY,
    savedAt: WORKPLACE_COUNTRY_SAVED_AT, status: 'applied', note: WORKPLACE_COUNTRY_NOTE,
  }
}
