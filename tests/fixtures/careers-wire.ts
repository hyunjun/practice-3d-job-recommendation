import { BOOKING_LIST_URLS, STARBUCKS_LIST_URLS, ZALANDO_LIST_URLS } from './careers-contract'
import { coverageReply } from './public-coverage-transport'

// Every posting, paragraph, number and application path below is invented.
// Native ID 640001 deliberately occurs at all three companies.
export const CAREERS_WIRE_JOBS = [
  {
    id: 'careers-booking-640001', companyId: 'booking', source: 'careers',
    title: 'Backend Engineer — Synthetic Canal API64', role: 'backend',
    url: 'https://jobs.booking.com/booking/jobs/640001?lang=en-us',
    cityIds: ['amsterdam', 'berlin', 'london'],
    locationLabel: 'Amsterdam, Netherlands · Berlin, Germany · London, United Kingdom',
  },
  {
    id: 'careers-booking-640101', companyId: 'booking', source: 'careers',
    title: 'Frontend Engineer — Synthetic Holdings Ledger64', role: 'frontend',
    url: 'https://jobs.booking.com/booking/jobs/640101?lang=en-us',
    cityIds: ['new-york'], locationLabel: 'New York, New York, United States',
  },
  {
    id: 'careers-starbucks-640001', companyId: 'starbucks', source: 'careers',
    title: 'Backend Engineer — Synthetic Maple Orders64', role: 'backend',
    url: 'https://apply.starbucks.com/careers/job/640001',
    cityIds: ['seattle', 'new-york'], locationLabel: 'Seattle, Washington, United States · New York, New York, United States',
  },
  {
    id: 'careers-starbucks-640011', companyId: 'starbucks', source: 'careers',
    title: 'Frontend Engineer — Synthetic Birch Cafe64', role: 'frontend',
    url: 'https://apply.starbucks.com/careers/job/640011',
    cityIds: ['seattle'], locationLabel: 'Seattle, Washington, United States',
  },
  {
    id: 'careers-zalando-640001', companyId: 'zalando', source: 'careers',
    title: 'Backend Engineer — Synthetic Cedar Fashion64', role: 'backend',
    url: 'https://jobs.zalando.com/en/jobs/640001',
    cityIds: ['berlin', 'amsterdam'], locationLabel: 'Berlin, Germany · Amsterdam, Netherlands',
  },
  {
    id: 'careers-zalando-640016', companyId: 'zalando', source: 'careers',
    title: 'Frontend Engineer — Synthetic Iris Fashion64', role: 'frontend',
    url: 'https://jobs.zalando.com/en/jobs/640016',
    cityIds: ['berlin'], locationLabel: 'Berlin, Germany',
  },
] as const

export const CAREERS_BODY = 'Responsibilities\nBuild a fictional API with TypeScript and PostgreSQL. café 한글 🌏\n\nQualifications\n3 years of software engineering experience required.'
export const CAREERS_FRONTEND_BODY = 'Responsibilities\nBuild a fictional interface with React and TypeScript.\n\nQualifications\n3 years of frontend software engineering experience required.'
export const STARBUCKS_DETAIL_URLS = [
  'https://apply.starbucks.com/careers/job/640001',
  'https://apply.starbucks.com/careers/job/640002',
  'https://apply.starbucks.com/careers/job/640011',
] as const
export const ZALANDO_DETAIL_URLS = [
  'https://jobs.zalando.com/en/jobs/640001',
  'https://jobs.zalando.com/en/jobs/640016',
] as const

export function bookingRaw(id: string, title = 'Account Executive — Synthetic Travel Sales64', extra: Record<string, unknown> = {}) {
  return { data: {
    req_id: id, slug: id, title, client_code: 'workingatbooking',
    internal: false, external: false, hiring_organization: 'Booking.com',
    description: 'Synthetic fixture. Manage hotel partner accounts, sales quotas and commercial contracts.',
    city: 'Amsterdam', state: null, country: 'Netherlands', country_code: 'NL',
    additional_locations: [], categories: [{ name: 'Sales' }], department: null,
    employment_type: 'FULL_TIME', posted_date: '2026-09-20T12:00:00.000Z', update_date: '2026-10-01T12:00:00.000Z',
    apply_url: 'https://example.com/synthetic/do-not-use-application-url64',
    ...extra,
  } as Record<string, unknown> }
}

export type BookingScenario = 'complete' | 'short-first' | 'empty-final' | 'changed-total' | 'count-is-page-size'
  | 'duplicate' | 'mismatched-slug' | 'wrong-client' | 'internal' | 'wrong-employer'
  | 'missing-body' | 'invalid-date' | 'final-503' | 'final-429'

export function bookingResponses(scenario: BookingScenario = 'complete'): Record<string, unknown> {
  const first = { totalCount: 101, count: 101, jobs: Array.from({ length: 100 }, (_, index) => bookingRaw(String(640001 + index))) }
  first.jobs[0] = bookingRaw('640001', 'Backend Engineer — Synthetic Canal API64', {
    description: CAREERS_BODY, categories: undefined,
    additional_locations: [
      { city: 'Berlin', state: null, country: 'Germany', country_code: 'DE' },
      { city: 'London', state: null, country: 'United Kingdom', country_code: 'GB' },
    ],
  })
  const second = { totalCount: 101, count: 101, jobs: [
    bookingRaw('640101', 'Frontend Engineer — Synthetic Holdings Ledger64', {
      hiring_organization: 'Booking Holdings', description: CAREERS_FRONTEND_BODY, categories: [{ name: 'Engineering' }],
      city: 'New York', state: 'New York', country: 'United States', country_code: 'US',
    }),
  ] }
  if (scenario === 'short-first') first.jobs.pop()
  if (scenario === 'empty-final') second.jobs = []
  if (scenario === 'changed-total') second.totalCount = second.count = 102
  if (scenario === 'count-is-page-size') first.count = 100
  if (scenario === 'duplicate') second.jobs = [structuredClone(first.jobs[0])]
  if (scenario === 'mismatched-slug') first.jobs[0].data.slug = '640999'
  if (scenario === 'wrong-client') first.jobs[0].data.client_code = 'synthetic-other-company'
  if (scenario === 'internal') first.jobs[0].data.internal = true
  if (scenario === 'wrong-employer') first.jobs[0].data.hiring_organization = 'Synthetic Other Travel Company'
  if (scenario === 'missing-body') delete first.jobs[0].data.description
  if (scenario === 'invalid-date') first.jobs[0].data.update_date = 'not a timestamp'
  return {
    [BOOKING_LIST_URLS[0]]: first,
    [BOOKING_LIST_URLS[1]]: scenario === 'final-503' ? coverageReply({}, { status: 503 })
      : scenario === 'final-429' ? coverageReply({}, { status: 429, headers: { 'Retry-After': '120' } }) : second,
  }
}

export function starbucksSummary(id: number, name = 'Account Executive — Synthetic Technology Sales64') {
  return { id, name, positionUrl: `/careers/job/${id}` }
}
export function starbucksDetail(id: number, name: string, extra: Record<string, unknown> = {}) {
  return {
    '@context': 'https://schema.org', '@type': 'JobPosting', title: name,
    url: `https://apply.starbucks.com/careers/job/${id}`,
    description: CAREERS_BODY, employmentType: 'FULL_TIME',
    hiringOrganization: { name: 'Starbucks Coffee Company', sameAs: 'starbucks.com' },
    jobLocation: { address: {
      addressLocality: 'Seattle', addressRegion: 'Washington', addressCountry: { name: 'United States' },
    } },
    // Neither date is an update or authoritative closure observation.
    datePosted: '2001-01-01', validThrough: '2002-01-01', ...extra,
  } as Record<string, unknown>
}
export function starbucksDetailHtml(value: unknown) {
  return '<!doctype html><html><body><script type="application/ld+json">'
    + JSON.stringify(value).replaceAll('<', '\\u003c') + '</script></body></html>'
}
export type StarbucksScenario = 'complete' | 'short-first' | 'empty-final' | 'changed-total' | 'duplicate'
  | 'missing-filter' | 'wrong-filter' | 'extra-filter' | 'wrong-list-url' | 'wrong-detail-id'
  | 'wrong-detail-title' | 'wrong-detail-url' | 'wrong-employer' | 'wrong-employer-domain'
  | 'ambiguous-detail' | 'missing-jsonld' | 'invalid-jsonld' | 'missing-body' | 'final-503' | 'detail-503'

export function starbucksResponses(scenario: StarbucksScenario = 'complete'): Record<string, unknown> {
  const first = { data: {
    count: 11, positions: Array.from({ length: 10 }, (_, index) => starbucksSummary(640001 + index)),
    appliedFilters: { jobCategory: ['technology'] },
  } }
  first.data.positions[0] = starbucksSummary(640001, 'Backend Engineer — Synthetic Maple Orders64')
  first.data.positions[1] = starbucksSummary(640002, 'Research Scientist — Synthetic Cafe Study64')
  const second = { data: {
    count: 11, positions: [starbucksSummary(640011, 'Frontend Engineer — Synthetic Birch Cafe64')],
    appliedFilters: { jobCategory: ['technology'] },
  } }
  const backend = starbucksDetail(640001, 'Backend Engineer — Synthetic Maple Orders64', {
    jobLocation: [
      { address: { addressLocality: 'Seattle', addressRegion: 'Washington', addressCountry: 'United States' } },
      { address: { addressLocality: 'New York', addressRegion: 'New York', addressCountry: { name: 'United States' } } },
    ],
  })
  const research = starbucksDetail(640002, 'Research Scientist — Synthetic Cafe Study64', {
    description: 'Responsibilities\nStudy human behavior through qualitative interviews and surveys. Publish sociological reports on fictional cafe culture.',
  })
  const frontend = starbucksDetail(640011, 'Frontend Engineer — Synthetic Birch Cafe64', { description: CAREERS_FRONTEND_BODY })
  if (scenario === 'short-first') first.data.positions.pop()
  if (scenario === 'empty-final') second.data.positions = []
  if (scenario === 'changed-total') second.data.count = 12
  if (scenario === 'duplicate') second.data.positions = [structuredClone(first.data.positions[0])]
  if (scenario === 'missing-filter') first.data.appliedFilters = {} as typeof first.data.appliedFilters
  if (scenario === 'wrong-filter') first.data.appliedFilters.jobCategory = ['retail']
  if (scenario === 'extra-filter') first.data.appliedFilters.jobCategory = ['technology', 'retail']
  if (scenario === 'wrong-list-url') first.data.positions[0].positionUrl = '/careers/job/640999'
  if (scenario === 'wrong-detail-id') backend.url = 'https://apply.starbucks.com/careers/job/640999'
  if (scenario === 'wrong-detail-title') backend.title = 'Backend Engineer — Synthetic Different Title64'
  if (scenario === 'wrong-detail-url') backend.url = 'https://example.com/synthetic/stage64/other-company'
  if (scenario === 'wrong-employer') backend.hiringOrganization = { name: 'Synthetic Other Cafe64', sameAs: 'starbucks.com' }
  if (scenario === 'wrong-employer-domain') backend.hiringOrganization = { name: 'Starbucks Coffee Company', sameAs: 'example.com' }
  if (scenario === 'missing-body') delete backend.description
  const backendHtml = scenario === 'ambiguous-detail' ? starbucksDetailHtml([backend, backend])
    : scenario === 'missing-jsonld' ? '<html><body>Synthetic page without a job.</body></html>'
      : scenario === 'invalid-jsonld' ? '<script type="application/ld+json">{invalid-json}</script>'
        : starbucksDetailHtml(backend)
  return {
    [STARBUCKS_LIST_URLS[0]]: first,
    [STARBUCKS_LIST_URLS[1]]: scenario === 'final-503' ? coverageReply({}, { status: 503 }) : second,
    [STARBUCKS_DETAIL_URLS[0]]: coverageReply(backendHtml, { format: 'text', status: scenario === 'detail-503' ? 503 : 200 }),
    [STARBUCKS_DETAIL_URLS[1]]: coverageReply(starbucksDetailHtml(research), { format: 'text' }),
    [STARBUCKS_DETAIL_URLS[2]]: coverageReply(starbucksDetailHtml(frontend), { format: 'text' }),
  }
}

/** Fixture serialization only; the reader under test is never used to write inputs. */
export function flightHtml(...chunks: string[]) {
  return '<!doctype html><html><body>' + chunks.map(chunk =>
    `<script>self.__next_f.push(${JSON.stringify([1, chunk]).replaceAll('<', '\\u003c')})</script>`).join('') + '</body></html>'
}
export function flightObjectHtml(value: unknown) {
  return flightHtml(`1:${JSON.stringify(value)}\n`)
}
export function zalandoSummary(id: string, title = 'Account Executive — Synthetic Fashion Sales64', extra: Record<string, unknown> = {}) {
  return {
    id, title, entity: 'Synthetic Zalando Entity64', job_categories: ['Sales'],
    offices: ['Berlin'], updated_at: '2026-10-01T12:00:00.000Z', ...extra,
  } as Record<string, unknown>
}
export function zalandoDetail(id: string, title: string, extra: Record<string, unknown> = {}) {
  return {
    Job_Req_Id: id, Posting_Title: title, Company: 'Synthetic Zalando Entity64',
    Job_Description: '$a', Last_Update: '2026-10-01T12:00:00.000Z', Time_Type: 'Full time',
    Department: 'Engineering', Job_Category: 'Software Engineering',
    Locations_search_object: [{ main: 'Berlin', parent: 'Germany' }], ...extra,
  } as Record<string, unknown>
}
export function zalandoDetailHtml(detail: Record<string, unknown>, body = CAREERS_BODY) {
  const text = `a:T${Buffer.byteLength(body, 'utf8').toString(16)},${body}`
  return flightHtml(`1:${JSON.stringify(detail)}\n`, text)
}
export type ZalandoScenario = 'complete' | 'short-first' | 'empty-final' | 'changed-total' | 'duplicate'
  | 'missing-next' | 'foreign-next' | 'wrong-offset' | 'wrong-limit' | 'extra-final-next'
  | 'missing-positive-entity' | 'wrong-detail-id' | 'wrong-detail-title' | 'wrong-detail-company'
  | 'missing-detail-company' | 'wrong-detail-date' | 'missing-body' | 'missing-text-reference'
  | 'ambiguous-list' | 'ambiguous-detail' | 'final-503' | 'detail-503'

export function zalandoResponses(scenario: ZalandoScenario = 'complete'): Record<string, unknown> {
  const first = {
    data: Array.from({ length: 15 }, (_, index) => zalandoSummary(String(640001 + index))),
    total: 16, next: '/search?offset=15&limit=15' as string | null,
  }
  first.data[0] = zalandoSummary('640001', 'Backend Engineer — Synthetic Cedar Fashion64', { job_categories: ['Engineering'] })
  delete first.data[1].entity
  const second = {
    data: [zalandoSummary('640016', 'Frontend Engineer — Synthetic Iris Fashion64', { job_categories: ['Engineering'] })],
    total: 16, next: null as string | null,
  }
  const backend = zalandoDetail('640001', 'Backend Engineer — Synthetic Cedar Fashion64', {
    Locations_search_object: [{ main: 'Berlin', parent: 'Germany' }, { main: 'Amsterdam', parent: 'Netherlands' }],
  })
  const frontend = zalandoDetail('640016', 'Frontend Engineer — Synthetic Iris Fashion64')
  if (scenario === 'short-first') first.data.pop()
  if (scenario === 'empty-final') second.data = []
  if (scenario === 'changed-total') second.total = 17
  if (scenario === 'duplicate') second.data = [structuredClone(first.data[0])]
  if (scenario === 'missing-next') first.next = null
  if (scenario === 'foreign-next') first.next = 'https://example.com/search?offset=15&limit=15'
  if (scenario === 'wrong-offset') first.next = '/search?offset=30&limit=15'
  if (scenario === 'wrong-limit') first.next = '/search?offset=15&limit=30'
  if (scenario === 'extra-final-next') second.next = '/search?offset=30&limit=15'
  if (scenario === 'missing-positive-entity') delete first.data[0].entity
  if (scenario === 'wrong-detail-id') backend.Job_Req_Id = '640999'
  if (scenario === 'wrong-detail-title') backend.Posting_Title = 'Backend Engineer — Synthetic Different Title64'
  if (scenario === 'wrong-detail-company') backend.Company = 'Synthetic Other Employer64'
  if (scenario === 'missing-detail-company') delete backend.Company
  if (scenario === 'wrong-detail-date') backend.Last_Update = '2026-10-01T12:00:01.000Z'
  if (scenario === 'missing-body') delete backend.Job_Description
  if (scenario === 'missing-text-reference') backend.Job_Description = '$ff'
  return {
    [ZALANDO_LIST_URLS[0]]: coverageReply(scenario === 'ambiguous-list' ? flightObjectHtml([first, first]) : flightObjectHtml(first), { format: 'text' }),
    [ZALANDO_LIST_URLS[1]]: coverageReply(flightObjectHtml(second), { format: 'text', status: scenario === 'final-503' ? 503 : 200 }),
    [ZALANDO_DETAIL_URLS[0]]: coverageReply(scenario === 'ambiguous-detail' ? flightObjectHtml([backend, backend]) : zalandoDetailHtml(backend),
      { format: 'text', status: scenario === 'detail-503' ? 503 : 200 }),
    [ZALANDO_DETAIL_URLS[1]]: coverageReply(zalandoDetailHtml(frontend, CAREERS_FRONTEND_BODY), { format: 'text' }),
  }
}
