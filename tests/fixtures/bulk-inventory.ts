import { DEFAULT_FILTERS, SAMPLE_PROFILE } from '../../shared/types'
import type { Company, Filters, Profile } from '../../shared/types'
import type { GreenhouseJob } from '../../server/normalize'
import type { AshbyJob } from '../../server/providers/ashby'
import type { LeverJob } from '../../server/providers/lever'

export type BulkProvider = 'greenhouse' | 'ashby'
export type BulkPhase = 'healthy' | 'duplicate' | 'cold-duplicate' | 'recovered' | 'empty'
export const BULK_TIME = '2026-09-26T09:00:00.000Z'
export const BULK_CHANGE_TIME = '2026-09-26T09:02:00.000Z'
export const BULK_RECOVERY_TIME = '2026-09-26T09:04:00.000Z'
export const BULK_EMPTY_TIME = '2026-09-26T09:06:00.000Z'
export const BULK_NOTE = 'PRIVATE_BULK_51_NOTE 지원 기록을 보존합니다 🌱'
export const BULK_TRACKED_TITLE = 'Tracked Backend Engineer 51'
export const BULK_RETAINED_TITLE = 'Retained Backend Engineer 51'
export const BULK_NEW_TITLE = 'New Backend Engineer 51'
export const BULK_COMPANIES: Record<BulkProvider | 'control', Company> = {
  greenhouse: {
    id: 'bulk-cedar', name: 'Cedar Bulk', initials: 'CB', color: '#b6d9a2',
    industry: 'Synthetic inventory', careerUrl: 'https://example.com/bulk/cedar',
    provider: 'greenhouse', board: 'CedarBulk51',
  },
  ashby: {
    id: 'bulk-maple', name: 'Maple Bulk', initials: 'MB', color: '#b6d9a2',
    industry: 'Synthetic inventory', careerUrl: 'https://example.com/bulk/maple',
    provider: 'ashby', board: 'MapleBulk51',
  },
  control: {
    id: 'bulk-birch', name: 'Birch Control', initials: 'BC', color: '#e8b283',
    industry: 'Synthetic inventory', careerUrl: 'https://example.com/bulk/birch',
    provider: 'lever', board: 'BirchBulk51', boardRegion: 'eu',
  },
}
export function bulkRegistrations(provider: BulkProvider, withControl = true) {
  return [BULK_COMPANIES[provider], ...(withControl ? [BULK_COMPANIES.control] : [])]
    .map(({ initials: _initials, color: _color, ...registration }) => registration)
}
export const BULK_PROFILE: Profile = {
  ...SAMPLE_PROFILE, kind: 'personal', name: 'PRIVATE_BULK_51', years: 5,
  desiredRole: 'backend', skills: ['TypeScript', 'Python'], residence: 'GB',
  linkedinUrl: 'https://example.com/private-bulk51',
}
export const BULK_FILTERS: Filters = {
  ...DEFAULT_FILTERS, query: 'Engineer', role: 'backend', region: 'europe',
  workMode: 'onsite', employment: 'fulltime', salaryMin: 100000, includeUnknownSalary: false,
}
export const BULK_EXPLORATION = {
  source: 'public' as const, filters: BULK_FILTERS, selectedId: 'london',
  panelTab: 'cities' as const, mapMode: 'flat' as const, citySort: 'salary' as const, light: false,
}
export const BULK_URLS = {
  greenhouse: 'https://boards-api.greenhouse.io/v1/boards/CedarBulk51/jobs?content=true&pay_transparency=true',
  ashby: 'https://api.ashbyhq.com/posting-api/job-board/MapleBulk51?includeCompensation=true',
  control: 'https://api.eu.lever.co/v0/postings/BirchBulk51?mode=json&limit=50&skip=0',
}
const engineeringText = 'Build backend services with TypeScript and Python.\n\nRequirements\n3 years of software engineering experience.\nTypeScript and Python.'

/** Fictional raw rows. Tests state expected publication IDs and counts independently. */
export function bulkGreenhouse(id: number, overrides: Partial<GreenhouseJob> = {}): GreenhouseJob {
  return {
    id, internal_job_id: id + 50000, title: `Backend Engineer ${id}`,
    absolute_url: `https://example.com/bulk/greenhouse/${id}`,
    updated_at: '2026-09-25T08:00:00.000Z', location: { name: 'London, United Kingdom' },
    content: `<p>${engineeringText.replaceAll('\n', '</p><p>')}</p>`,
    departments: [{ name: 'Engineering' }],
    metadata: [{ name: 'Employment Type', value: 'Full-time' }, { name: 'Workplace Type', value: 'Onsite' }],
    pay_input_ranges: [{ min_cents: 12000000, max_cents: 16000000, currency_type: 'USD', title: 'Annual base salary', blurb: 'USD per year' }],
    ...overrides,
  }
}
export function bulkGreenhouseSales(id: number): GreenhouseJob {
  return bulkGreenhouse(id, {
    title: 'Account Executive', departments: [{ name: 'Sales' }],
    content: '<p>Manage commercial accounts and negotiate sales agreements.</p>',
  })
}
export function bulkAshby(id: string, overrides: Partial<AshbyJob> = {}): AshbyJob {
  return {
    id, title: `Backend Engineer ${id}`, jobUrl: `https://example.com/bulk/ashby/${id}`,
    isListed: true, location: 'London, United Kingdom',
    address: { postalAddress: { addressLocality: 'London', addressCountry: 'GBR' } },
    secondaryLocations: [], workplaceType: 'OnSite', isRemote: false, employmentType: 'FullTime',
    department: 'Engineering', descriptionPlain: engineeringText, shouldDisplayCompensationOnJobPostings: true,
    compensation: { summaryComponents: [{ compensationType: 'Salary', interval: '1 YEAR', currencyCode: 'USD', minValue: 120000, maxValue: 160000 }] },
    ...overrides,
  }
}
export function bulkAshbySales(id: string): AshbyJob {
  return bulkAshby(id, {
    title: 'Account Executive', department: 'Sales',
    descriptionPlain: 'Manage commercial accounts and negotiate sales agreements.',
  })
}
function controlPosting(id: string, title: string): LeverJob {
  return {
    id, text: title, hostedUrl: `https://example.com/bulk/control/${id}`,
    categories: { location: 'Berlin, Germany', department: 'Engineering', commitment: 'Full-time' },
    country: 'DE', workplaceType: 'on-site', descriptionPlain: engineeringText,
    salaryRange: { currency: 'USD', interval: 'per-year-salary', min: 120000, max: 160000 },
  }
}
export function bulkResponses(provider: BulkProvider, phase: BulkPhase): Record<string, unknown> {
  const greenhouse = phase === 'empty' ? []
    : phase === 'cold-duplicate' ? [bulkGreenhouseSales(7191), bulkGreenhouseSales(7191), bulkGreenhouseSales(7192)]
      : phase === 'duplicate' ? [
        bulkGreenhouse(7102, { title: BULK_RETAINED_TITLE }),
        bulkGreenhouseSales(7103),
        bulkGreenhouse(7102, { title: 'Changed Retained Backend Engineer 51' }),
        bulkGreenhouse(7104, { title: BULK_NEW_TITLE }),
      ] : [
        bulkGreenhouse(7101, { title: BULK_TRACKED_TITLE }),
        bulkGreenhouse(7102, { title: BULK_RETAINED_TITLE }),
        bulkGreenhouseSales(7103),
        ...(phase === 'recovered' ? [bulkGreenhouse(7104, { title: BULK_NEW_TITLE })] : []),
      ]
  const ashby = phase === 'empty' ? []
    : phase === 'cold-duplicate' ? [
      bulkAshby('hidden-one', { isListed: false }), bulkAshby('hidden-one', { isListed: false }),
      bulkAshby('hidden-two', { isListed: false }),
    ] : phase === 'duplicate' ? [
      bulkAshby('retained', { title: BULK_RETAINED_TITLE }),
      bulkAshby('retained', { title: 'Unlisted Retained Backend Engineer 51', isListed: false }),
      bulkAshby('new-public', { title: BULK_NEW_TITLE }), bulkAshbySales('sales'),
      bulkAshby('direct-only', { isListed: false }),
    ] : [
      bulkAshby('tracked', { title: BULK_TRACKED_TITLE }),
      bulkAshby('retained', { title: BULK_RETAINED_TITLE }), bulkAshbySales('sales'),
      bulkAshby('direct-only', { isListed: false }),
      ...(phase === 'recovered' ? [bulkAshby('new-public', { title: BULK_NEW_TITLE })] : []),
    ]
  return {
    [BULK_URLS[provider]]: provider === 'greenhouse'
      ? { jobs: greenhouse, meta: { total: greenhouse.length } }
      : { apiVersion: '1', jobs: ashby },
    [BULK_URLS.control]: [
      controlPosting('control-one', 'Berlin Backend Engineer One 51'),
      ...(phase !== 'healthy' ? [controlPosting('control-two', 'Berlin Backend Engineer Two 51')] : []),
    ],
  }
}
