import { JobProviderSchema } from '../../shared/schemas'
import type { Company, Job, JobProvider } from '../../shared/types'

// Approved source/routing facts, including the supplied Stage64 registry's
// literal display names and career-page URLs. All posting inputs remain fake.
export const CAREERS_SOURCE_LABEL = '공식 채용 사이트'
export const CAREERS_NOW = '2026-10-02T10:00:00.000Z'
export const CAREERS_NEXT_DAY = '2026-10-03T10:00:00.000Z'
export const CAREERS_REGISTRATIONS = [
  { id: 'booking', name: 'Booking.com / Booking Holdings', provider: 'careers', board: 'booking', careerUrl: 'https://jobs.booking.com/booking/jobs' },
  { id: 'zalando', name: 'Zalando', provider: 'careers', board: 'zalando', careerUrl: 'https://jobs.zalando.com/en/jobs' },
  { id: 'starbucks', name: 'Starbucks', provider: 'careers', board: 'starbucks-technology', careerUrl: 'https://careers.starbucks.com/discover-opportunities/technology/' },
] as const

export const BOOKING_LIST_URLS = [
  'https://jobs.booking.com/api/jobs?page=1&limit=100&sortBy=relevance&descending=false&internal=false',
  'https://jobs.booking.com/api/jobs?page=2&limit=100&sortBy=relevance&descending=false&internal=false',
] as const
export const STARBUCKS_LIST_URLS = [
  'https://apply.starbucks.com/api/pcsx/search?domain=starbucks.com&query=&location=&start=0&filter_job_category=technology',
  'https://apply.starbucks.com/api/pcsx/search?domain=starbucks.com&query=&location=&start=10&filter_job_category=technology',
] as const
export const ZALANDO_LIST_URLS = [
  'https://jobs.zalando.com/en/jobs?page=1',
  'https://jobs.zalando.com/en/jobs?page=2',
] as const

export function careersCompany(id: 'booking' | 'zalando' | 'starbucks'): Company {
  const registration = CAREERS_REGISTRATIONS.find(company => company.id === id)!
  return {
    ...registration, provider: JobProviderSchema.parse('careers'),
    initials: '64', color: '#83d1c7', industry: 'Synthetic official careers fixture',
  }
}

// Independent input to scheduling/cache tests, not an oracle constructed by a
// provider normalizer. Wire-to-job identities are tested separately.
export function careersCachedJob(fetchedAt = CAREERS_NOW, revised = false): Job & { source: JobProvider } {
  return {
    id: 'careers-booking-6400001', companyId: 'booking', source: JobProviderSchema.parse('careers'),
    title: revised ? 'Backend Engineer — Synthetic Canal API64 Revised' : 'Backend Engineer — Synthetic Canal API64',
    role: 'backend', cityIds: ['amsterdam'], locationLabel: 'Amsterdam, Netherlands',
    workMode: 'onsite', employment: 'fulltime', minExperience: 3,
    remoteCountries: [], remoteWorldwide: false, remoteScopeUnknown: false,
    skills: ['TypeScript', 'PostgreSQL'], salary: null, visa: 'unknown', requirements: [],
    url: 'https://jobs.booking.com/booking/jobs/6400001?lang=en-us',
    updatedAt: null, fetchedAt,
    description: revised
      ? 'Synthetic regression body. Build a fictional booking API with TypeScript and PostgreSQL. Project Canal Two.'
      : 'Synthetic regression body. Build a fictional booking API with TypeScript and PostgreSQL.',
  }
}
