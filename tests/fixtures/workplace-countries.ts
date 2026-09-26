import type { Filters, Profile } from '../../shared/types'

// Invented employers, roles and source paragraphs. The real provider collector
// receives these raw fields; no country metadata is supplied by a test oracle.
export const WORKPLACE_COUNTRY_REGISTRATIONS = [
  {
    id: 'country-fern', name: 'Fern Beacon Labs', provider: 'greenhouse', board: 'FernCountries55',
    careerUrl: 'https://example.com/careers/country-fern', industry: '가상 관측 도구',
  },
  {
    id: 'country-moss', name: 'Moss Circuit Studio', provider: 'ashby', board: 'MossCountries55',
    careerUrl: 'https://example.com/careers/country-moss', industry: '가상 관측 도구',
  },
  {
    id: 'country-wren', name: 'Wren Signal Works', provider: 'lever', board: 'WrenCountries55', boardRegion: 'eu',
    careerUrl: 'https://example.com/careers/country-wren', industry: '가상 관측 도구',
  },
  {
    id: 'country-cove', name: 'Cove Lantern Systems', provider: 'smartrecruiters', board: 'CoveCountries55',
    careerUrl: 'https://example.com/careers/country-cove', industry: '가상 관측 도구',
  },
] as const

export const WORKPLACE_COUNTRY_PROFILE: Profile = {
  kind: 'personal', name: '가상 국가 탐색 지원자', headline: 'Backend Engineer', years: 5,
  skills: ['TypeScript'], desiredRole: 'backend', residence: 'KR', linkedinUrl: '',
}

export const WORKPLACE_COUNTRY_FILTERS: Filters = {
  query: '', region: 'all', role: 'backend', workMode: 'all', visa: 'all', employment: 'all',
  postingType: 'opening', salaryMin: 0, includeUnknownSalary: true, remoteEligibleOnly: false,
}

export const WORKPLACE_COUNTRY_FETCHED_AT = '2026-09-25T09:00:00.000Z'
export const WORKPLACE_COUNTRY_SAVED_AT = '2026-09-25T09:05:00.000Z'
export const WORKPLACE_COUNTRY_NOTE = '가상 지원 메모: 공개 근무 국가의 원문을 다시 확인\n국가 검색어와 개인 기록은 기기에만 보관 🌿'
export const WORKPLACE_COUNTRY_BODY = 'Build observability services with TypeScript.\nMinimum requirements: 3 years of software engineering experience.'
export const COUNTRY_CONTEXT_BODY = 'Our company headquarters are in Estonia. Team retreats take place in Malaysia. Applicants may reside in Canada before relocation. Build observability services with TypeScript.'
export const SAME_COUNTRY_CONFLICT_BODY = 'This role is based in our Melbourne office.'
export const CROSS_COUNTRY_CONFLICT_BODY = 'This role is based in our London office.'

export function workplaceCountryGreenhouseRaw(overrides: Record<string, unknown> = {}) {
  return {
    id: 5501, internal_job_id: 95501, title: 'Backend Engineer — Lantern Ledger',
    absolute_url: 'https://example.com/jobs/country-fern-5501',
    updated_at: '2026-09-24T08:30:00.000Z', location: { name: 'Tallinn, Estonia' },
    content: '<p>Build observability services with TypeScript.</p><p>Minimum requirements: 3 years of software engineering experience.</p>',
    departments: [{ name: 'Engineering' }],
    metadata: [{ name: 'Employment Type', value: 'Full-time' }, { name: 'Workplace Type', value: 'Onsite' }],
    ...overrides,
  }
}

export function workplaceCountryBaselineResponses(): Record<string, unknown> {
  return {
    'https://boards-api.greenhouse.io/v1/boards/FernCountries55/jobs?content=true&pay_transparency=true': {
      jobs: [workplaceCountryGreenhouseRaw()], meta: { total: 1 },
    },
  }
}

export function workplaceCountryAshbyRaw(overrides: Record<string, unknown> = {}) {
  return {
    id: '5511', title: 'Backend Engineer — Reed Compass',
    jobUrl: 'https://example.com/jobs/country-moss-5511', isListed: true,
    location: 'Petaling Jaya',
    address: { postalAddress: { addressLocality: 'Petaling Jaya', addressCountry: 'MY' } },
    workplaceType: 'OnSite', isRemote: false, employmentType: 'FullTime', department: 'Engineering',
    descriptionPlain: WORKPLACE_COUNTRY_BODY,
    ...overrides,
  }
}

export function workplaceCountryLeverRaw(overrides: Record<string, unknown> = {}) {
  return {
    id: '5521', text: 'Backend Engineer — Rain Router',
    hostedUrl: 'https://example.com/jobs/country-wren-5521',
    categories: { location: 'Quito, Ecuador', commitment: 'Full-time', department: 'Engineering' },
    workplaceType: 'onsite', descriptionPlain: WORKPLACE_COUNTRY_BODY,
    ...overrides,
  }
}

export function workplaceCountrySmartRecruitersRaw(overrides: Record<string, unknown> = {}) {
  return {
    id: '5531', name: 'Backend Engineer — Tide Channel',
    company: { identifier: 'CoveCountries55' }, visibility: 'PUBLIC' as const, active: true,
    releasedDate: '2026-09-24T08:30:00.000Z', postingUrl: 'https://example.com/jobs/country-cove-5531',
    location: { city: 'Petaling Jaya', country: 'my', fullLocation: 'Petaling Jaya', remote: false, hybrid: false },
    typeOfEmployment: { label: 'Full-time' }, function: { label: 'Engineering' },
    jobAd: { sections: { jobDescription: { title: 'Responsibilities', text: '<p>Build observability services with TypeScript.</p>' } } },
    ...overrides,
  }
}

export function workplaceCountryGreenhousePostings() {
  return [
    workplaceCountryGreenhouseRaw(),
    workplaceCountryGreenhouseRaw({
      id: 5502, internal_job_id: 95502, title: 'Backend Engineer — Fog Signal',
      absolute_url: 'https://example.com/jobs/country-fern-5502', location: { name: 'N/A' },
      content: `<p>${COUNTRY_CONTEXT_BODY}</p>`,
    }),
    workplaceCountryGreenhouseRaw({
      id: 5503, internal_job_id: 95503, title: 'Backend Engineer — Cedar Dial',
      absolute_url: 'https://example.com/jobs/country-fern-5503', location: { name: 'CA' },
    }),
    workplaceCountryGreenhouseRaw({
      id: 5504, internal_job_id: 95504, title: 'Backend Engineer — Quartz Relay',
      absolute_url: 'https://example.com/jobs/country-fern-5504', location: { name: 'Georgia' },
    }),
    workplaceCountryGreenhouseRaw({
      id: 5505, internal_job_id: 95505, title: 'Backend Engineer — Harbor Post',
      absolute_url: 'https://example.com/jobs/country-fern-5505', location: { name: 'Lebanon, NH, United States' },
    }),
    workplaceCountryGreenhouseRaw({
      id: 5506, internal_job_id: 95506, title: 'Backend Engineer — Atlas Bridge',
      absolute_url: 'https://example.com/jobs/country-fern-5506', location: { name: 'Tallinn, Estonia; Petaling Jaya, Malaysia' },
    }),
    workplaceCountryGreenhouseRaw({
      id: 5507, internal_job_id: 95507, title: 'Backend Engineer — Civic Engine',
      absolute_url: 'https://example.com/jobs/country-fern-5507', location: { name: 'Berlin, Germany; Petaling Jaya, Malaysia' },
    }),
    workplaceCountryGreenhouseRaw({
      id: 5508, internal_job_id: 95508, title: 'Backend Engineer — Cloud Current',
      absolute_url: 'https://example.com/jobs/country-fern-5508', location: { name: 'Remote, Malaysia' },
      metadata: [{ name: 'Employment Type', value: 'Full-time' }, { name: 'Workplace Type', value: 'Remote' }],
    }),
    workplaceCountryGreenhouseRaw({
      id: 5509, internal_job_id: 95509, title: 'Backend Engineer — Coast Gauge',
      absolute_url: 'https://example.com/jobs/country-fern-5509', location: { name: 'Sydney' },
      content: `<p>${SAME_COUNTRY_CONFLICT_BODY}</p>`,
    }),
    workplaceCountryGreenhouseRaw({
      id: 5510, internal_job_id: 95510, title: 'Backend Engineer — Split Gauge',
      absolute_url: 'https://example.com/jobs/country-fern-5510', location: { name: 'Seoul' },
      content: `<p>${CROSS_COUNTRY_CONFLICT_BODY}</p>`,
    }),
  ]
}

export function workplaceCountryAshbyPostings() {
  return [
    workplaceCountryAshbyRaw(),
    workplaceCountryAshbyRaw({
      id: '5512', title: 'Backend Engineer — Fern Compass', jobUrl: 'https://example.com/jobs/country-moss-5512',
      location: 'Tallinn', address: { addressLocality: 'Tallinn', addressCountry: 'EE' },
      secondaryLocations: [{ location: 'Petaling Jaya', address: { postalAddress: { addressLocality: 'Petaling Jaya', addressCountry: 'MYS' } } }],
    }),
    workplaceCountryAshbyRaw({
      id: '5513', title: 'Backend Engineer — Maple Compass', jobUrl: 'https://example.com/jobs/country-moss-5513',
      location: 'CA', address: { postalAddress: { addressCountry: 'CA' } },
    }),
    workplaceCountryAshbyRaw({
      id: '5514', title: 'Backend Engineer — Paper Compass', jobUrl: 'https://example.com/jobs/country-moss-5514',
      location: 'Tallinn, Estonia', address: { addressCountry: 'N/A' },
    }),
    workplaceCountryAshbyRaw({
      id: '5515', title: 'Backend Engineer — Glass Compass', jobUrl: 'https://example.com/jobs/country-moss-5515',
      location: 'Tallinn, Estonia', address: { addressCountry: 'MY' },
    }),
    workplaceCountryAshbyRaw({
      id: '5516', title: 'Backend Engineer — Half Compass', jobUrl: 'https://example.com/jobs/country-moss-5516',
      location: 'Tallinn', address: { addressCountry: 'EE' },
      secondaryLocations: [{ location: 'Awaiting Assignment' }],
    }),
  ]
}

export function workplaceCountryLeverPostings() {
  return [
    workplaceCountryLeverRaw(),
    workplaceCountryLeverRaw({
      id: '5522', text: 'Backend Engineer — Twin Router', hostedUrl: 'https://example.com/jobs/country-wren-5522',
      country: 'EE',
      categories: { location: 'Wren Annex', allLocations: ['Wren Annex', 'Petaling Jaya, Malaysia'], commitment: 'Full-time', department: 'Engineering' },
    }),
    workplaceCountryLeverRaw({
      id: '5523', text: 'Backend Engineer — Hollow Router', hostedUrl: 'https://example.com/jobs/country-wren-5523',
      country: 'XX',
      categories: { location: 'Wren Annex', allLocations: ['Canada'], commitment: 'Full-time', department: 'Engineering' },
    }),
  ]
}

export function workplaceCountrySmartRecruitersPostings() {
  return [
    workplaceCountrySmartRecruitersRaw(),
    workplaceCountrySmartRecruitersRaw({
      id: '5532', name: 'Backend Engineer — Stone Channel', postingUrl: 'https://example.com/jobs/country-cove-5532',
      location: { city: 'Lakeside Workshop', country: 'CA', fullLocation: 'Lakeside Workshop', remote: false, hybrid: false },
    }),
    workplaceCountrySmartRecruitersRaw({
      id: '5533', name: 'Backend Engineer — Quiet Channel', postingUrl: 'https://example.com/jobs/country-cove-5533',
      location: { city: 'Petaling Jaya', country: '??', fullLocation: 'Petaling Jaya, Malaysia', remote: false, hybrid: false },
    }),
  ]
}

/** Exact fictional provider URLs; no normalized country output is prefilled. */
export function workplaceCountryResponses(): Record<string, unknown> {
  const smart = workplaceCountrySmartRecruitersPostings()
  return {
    'https://boards-api.greenhouse.io/v1/boards/FernCountries55/jobs?content=true&pay_transparency=true': {
      jobs: workplaceCountryGreenhousePostings(), meta: { total: 10 },
    },
    'https://api.ashbyhq.com/posting-api/job-board/MossCountries55?includeCompensation=true':
      { apiVersion: '1', jobs: workplaceCountryAshbyPostings() },
    'https://api.eu.lever.co/v0/postings/WrenCountries55?mode=json&limit=50&skip=0': workplaceCountryLeverPostings(),
    'https://api.smartrecruiters.com/v1/companies/CoveCountries55/postings?limit=100&offset=0&destination=PUBLIC':
      { offset: 0, limit: 100, totalFound: 3, content: smart },
    'https://api.smartrecruiters.com/v1/companies/CoveCountries55/postings/5531': smart[0],
    'https://api.smartrecruiters.com/v1/companies/CoveCountries55/postings/5532': smart[1],
    'https://api.smartrecruiters.com/v1/companies/CoveCountries55/postings/5533': smart[2],
  }
}

/** A bounded raw-location grammar cohort, separate from the original 22 jobs. */
export function workplaceCountryCommaResponses(): Record<string, unknown> {
  return {
    'https://boards-api.greenhouse.io/v1/boards/FernCountries55/jobs?content=true&pay_transparency=true': {
      meta: { total: 8 },
      jobs: [
        workplaceCountryGreenhouseRaw({
          id: 5581, internal_job_id: 95581, title: 'Backend Engineer — Birch Span',
          absolute_url: 'https://example.com/jobs/country-fern-5581', location: { name: 'US, Canada' },
        }),
        workplaceCountryGreenhouseRaw({
          id: 5582, internal_job_id: 95582, title: 'Backend Engineer — Willow Span',
          absolute_url: 'https://example.com/jobs/country-fern-5582', location: { name: 'United States, Canada' },
        }),
        workplaceCountryGreenhouseRaw({
          id: 5583, internal_job_id: 95583, title: 'Backend Engineer — Alder Span',
          absolute_url: 'https://example.com/jobs/country-fern-5583', location: { name: 'USA, Canada' },
        }),
        workplaceCountryGreenhouseRaw({
          id: 5584, internal_job_id: 95584, title: 'Backend Engineer — Harbor Receipt',
          absolute_url: 'https://example.com/jobs/country-fern-5584', location: { name: 'Lebanon, NH, United States' },
        }),
        workplaceCountryGreenhouseRaw({
          id: 5585, internal_job_id: 95585, title: 'Backend Engineer — Cedar Receipt',
          absolute_url: 'https://example.com/jobs/country-fern-5585', location: { name: 'Lebanon, Canada' },
        }),
        workplaceCountryGreenhouseRaw({
          id: 5586, internal_job_id: 95586, title: 'Backend Engineer — Quartz Receipt',
          absolute_url: 'https://example.com/jobs/country-fern-5586', location: { name: 'Mexico, United States' },
        }),
        workplaceCountryGreenhouseRaw({
          id: 5587, internal_job_id: 95587, title: 'Backend Engineer — Amber Dial',
          absolute_url: 'https://example.com/jobs/country-fern-5587', location: { name: 'CA' },
        }),
        workplaceCountryGreenhouseRaw({
          id: 5588, internal_job_id: 95588, title: 'Backend Engineer — Onyx Dial',
          absolute_url: 'https://example.com/jobs/country-fern-5588', location: { name: 'Georgia' },
        }),
      ],
    },
  }
}
