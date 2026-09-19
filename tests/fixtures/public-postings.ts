import type { AshbyJob } from '../../server/providers/ashby'
import type { LeverJob } from '../../server/providers/lever'
import type { SmartRecruitersJob } from '../../server/providers/smartrecruiters'

export const POSTING_TIME = '2026-09-19T06:00:00.000Z'

export function ashbyPosting(overrides: Partial<AshbyJob> = {}): AshbyJob {
  const id = overrides.id ?? 'shared-fixture-id'
  return {
    id, title: 'Backend Engineer — Ashby fixture', jobUrl: `https://example.com/ashby/${id}`,
    isListed: true, location: 'London', address: { postalAddress: { addressLocality: 'London', addressCountry: 'GBR' } },
    secondaryLocations: [], workplaceType: 'Hybrid', isRemote: false, employmentType: 'FullTime',
    descriptionPlain: '5 years of software engineering experience with Python, TypeScript and AWS.\nWe provide visa sponsorship.',
    shouldDisplayCompensationOnJobPostings: true,
    compensation: {
      compensationTiers: [{
        title: 'London', components: [
          { compensationType: 'Salary', interval: '1 YEAR', currencyCode: 'GBP', minValue: 100000, maxValue: 140000 },
          { compensationType: 'EquityCashValue', interval: '1 YEAR', currencyCode: 'GBP', minValue: 20000, maxValue: 50000 },
        ],
      }],
      summaryComponents: [{ compensationType: 'Salary', interval: '1 YEAR', currencyCode: 'USD', minValue: 999999, maxValue: 999999 }],
    },
    ...overrides,
  }
}

export function leverPosting(overrides: Partial<LeverJob> = {}): LeverJob {
  const id = overrides.id ?? 'shared-fixture-id'
  return {
    id, text: 'Backend Engineer — Lever fixture', hostedUrl: `https://example.com/lever/${id}`,
    categories: { location: 'London', allLocations: ['London', 'Berlin'], commitment: 'Permanent' },
    country: 'GB', workplaceType: 'hybrid',
    descriptionPlain: '5 years of software engineering experience. We provide visa sponsorship.',
    lists: [{ text: 'What you will do', content: '<ul><li>Build with Python, TypeScript and AWS.</li></ul>' }],
    salaryRange: { currency: 'EUR', interval: 'per-year', min: 90000, max: 130000 },
    ...overrides,
  }
}

export function smartRecruitersPosting(overrides: Partial<SmartRecruitersJob> = {}): SmartRecruitersJob {
  const id = overrides.id ?? 'shared-fixture-id'
  return {
    id, name: 'Backend Engineer — SmartRecruiters fixture',
    company: { identifier: 'ExampleBoard' }, visibility: 'PUBLIC', active: true, releasedDate: POSTING_TIME,
    postingUrl: `https://example.com/smartrecruiters/${id}`,
    location: { city: 'Melbourne', region: 'VIC', country: 'au', fullLocation: 'Melbourne, VIC, Australia', remote: false, hybrid: true },
    typeOfEmployment: { label: 'Full-time' }, function: { label: 'Engineering' },
    jobAd: { sections: {
      companyDescription: { title: 'Company Description', text: '<p>We build software for creative teams.</p>' },
      jobDescription: { title: 'Job Description', text: '<p>Develop distributed systems with Python, TypeScript and AWS.</p>' },
      qualifications: { title: 'Qualifications', text: '<p>5 years of software engineering experience.</p>' },
      additionalInformation: { title: 'Additional Information', text: '<p>We provide visa sponsorship.</p>' },
    } },
    ...overrides,
  }
}
