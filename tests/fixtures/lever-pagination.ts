import { DEFAULT_FILTERS, SAMPLE_PROFILE } from '../../shared/types'
import type { Company, Filters, Profile } from '../../shared/types'
import type { LeverJob } from '../../server/providers/lever'

export const PAGINATION_TIME = '2026-09-20T12:00:00.000Z'
export const PAGINATION_CHANGE_TIME = '2026-09-20T12:02:00.000Z'
export const PAGINATION_RECOVERY_TIME = '2026-09-20T12:04:00.000Z'
export const PAGINATION_EMPTY_TIME = '2026-09-20T12:06:00.000Z'
export const PAGINATION_NOTE = 'PRIVATE_PAGINATION_50_NOTE 지원 기록을 보존합니다 🌱'
export const PAGINATION_TRACKED_TITLE = 'Tracked Backend Engineer 50'
export const PAGINATION_BOUNDARY_TITLE = 'Boundary Backend Engineer 50'
export const PAGINATION_NEW_TITLE = 'New Backend Engineer 50'
export const PAGINATION_COMPANIES: Company[] = [
  {
    id: 'pagination-alder', name: 'Alder Pagination', initials: 'AP', color: '#b6d9a2',
    industry: 'Synthetic pagination', careerUrl: 'https://example.com/pagination/alder',
    provider: 'lever', board: 'AlderPagination50',
  },
  {
    id: 'pagination-birch', name: 'Birch Pagination', initials: 'BP', color: '#e8b283',
    industry: 'Synthetic pagination', careerUrl: 'https://example.com/pagination/birch',
    provider: 'lever', board: 'BirchPagination50', boardRegion: 'eu',
  },
]
export const PAGINATION_REGISTRATIONS = PAGINATION_COMPANIES.map(({ initials: _initials, color: _color, ...registration }) => registration)
export const PAGINATION_PROFILE: Profile = {
  ...SAMPLE_PROFILE, kind: 'personal', name: 'PRIVATE_PAGINATION_50', years: 5,
  desiredRole: 'backend', skills: ['TypeScript', 'Python'], residence: 'GB',
  linkedinUrl: 'https://example.com/private-pagination50',
}
export const PAGINATION_FILTERS: Filters = {
  ...DEFAULT_FILTERS, query: 'Engineer', role: 'backend', region: 'europe',
  workMode: 'onsite', employment: 'fulltime', salaryMin: 100000, includeUnknownSalary: false,
}
export const PAGINATION_EXPLORATION = {
  source: 'public' as const, filters: PAGINATION_FILTERS, selectedId: 'london',
  panelTab: 'cities' as const, mapMode: 'flat' as const, citySort: 'salary' as const, light: false,
}

export const PAGINATION_URLS = {
  first: 'https://api.lever.co/v0/postings/AlderPagination50?mode=json&limit=50&skip=0',
  next: 'https://api.lever.co/v0/postings/AlderPagination50?mode=json&limit=50&skip=50',
  birch: 'https://api.eu.lever.co/v0/postings/BirchPagination50?mode=json&limit=50&skip=0',
}

/** Invented raw provider input only. Expected IDs/counts stay literal in tests. */
export function paginationPosting(id: string, overrides: Partial<LeverJob> = {}): LeverJob {
  return {
    id, text: `Backend Engineer ${id}`, hostedUrl: `https://example.com/pagination/jobs/${id}`,
    categories: { location: 'London, United Kingdom', commitment: 'Full-time', department: 'Engineering' },
    country: 'GB', workplaceType: 'on-site',
    descriptionPlain: 'Build backend services with TypeScript and Python.\n\nRequirements\n3 years of software engineering experience.\nTypeScript and Python.',
    salaryRange: { currency: 'USD', interval: 'per-year-salary', min: 120000, max: 160000 },
    ...overrides,
  }
}
export function paginationAdministrative(id: string): LeverJob {
  return paginationPosting(id, {
    text: 'Account Executive', categories: { location: 'London, United Kingdom', department: 'Sales', commitment: 'Full-time' },
    descriptionPlain: 'Manage commercial accounts and negotiate sales agreements.',
  })
}
export function paginationHealthyPage(): LeverJob[] {
  return [
    paginationPosting('tracked', { text: PAGINATION_TRACKED_TITLE }),
    ...Array.from({ length: 48 }, (_, index) => paginationAdministrative(`administrative-${index + 1}`)),
    paginationPosting('boundary', { text: PAGINATION_BOUNDARY_TITLE }),
  ]
}
export function paginationOverlapPages(): LeverJob[][] {
  return [
    [
      paginationPosting('boundary', { text: PAGINATION_BOUNDARY_TITLE }),
      ...Array.from({ length: 49 }, (_, index) => paginationAdministrative(`administrative-${index + 1}`)),
    ],
    [
      paginationPosting('boundary', { text: 'Changed Boundary Backend Engineer 50' }),
      paginationPosting('new-public', { text: PAGINATION_NEW_TITLE }),
    ],
  ]
}
export type PaginationPhase = 'healthy' | 'overlap' | 'within-page' | 'recovered' | 'out-of-scope' | 'empty'
export function paginationResponses(phase: PaginationPhase): Record<string, unknown> {
  const overlap = paginationOverlapPages()
  const first = phase === 'overlap' ? overlap[0]
    : phase === 'within-page' ? [paginationAdministrative('duplicate-sales'), paginationAdministrative('duplicate-sales'), paginationAdministrative('new-sales')]
      : phase === 'empty' ? []
        : phase === 'out-of-scope' ? paginationHealthyPage().map(job => paginationAdministrative(job.id))
          : paginationHealthyPage()
  const next = phase === 'overlap' ? overlap[1]
    : phase === 'recovered' ? [paginationPosting('new-public', { text: PAGINATION_NEW_TITLE })] : []
  const birch = [
    paginationPosting('birch-one', {
      text: 'Berlin Backend Engineer One 50', country: 'DE',
      categories: { location: 'Berlin, Germany', commitment: 'Full-time', department: 'Engineering' },
    }),
    ...(phase !== 'healthy' ? [paginationPosting('birch-two', {
      text: 'Berlin Backend Engineer Two 50', country: 'DE',
      categories: { location: 'Berlin, Germany', commitment: 'Full-time', department: 'Engineering' },
    })] : []),
  ]
  return { [PAGINATION_URLS.first]: first, [PAGINATION_URLS.next]: next, [PAGINATION_URLS.birch]: birch }
}
