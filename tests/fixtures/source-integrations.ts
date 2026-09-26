import { expansionLegacy36Cache } from './public-company-expansion'
import { SURVEY_REGISTRATIONS, surveyOldSaved, surveyResponses } from './public-company-survey'
import { coverageReply } from './public-coverage-transport'
import {
  HIMALAYAS_BODY, HIMALAYAS_CHANGED_BODY, HIMALAYAS_CHANGED_TITLE,
  INTEGRATION_OLD_AT,
} from './source-integration-contract'

// Raw input builders contain fictional paragraphs and provider-shaped records.
// Expected IDs, normalized locations and counts live in a separate literal
// contract; no expectation is produced by these builders or product functions.
export function microsoftRaw(overrides: Record<string, unknown> = {}) {
  return {
    guid: 'https://himalayas.app/companies/microsoft/jobs/synthetic-cedar-api63',
    companySlug: 'microsoft', companyName: 'Microsoft',
    title: 'Backend Engineer — Synthetic Cedar API63',
    description: `<p>${HIMALAYAS_BODY}</p>`,
    applicationLink: 'https://example.com/synthetic/stage63/do-not-substitute-application-link',
    employmentType: 'Full Time',
    locationRestrictions: ['South Korea'], timezoneRestrictions: [9],
    minSalary: 150000, maxSalary: 180000, currency: 'USD', salaryPeriod: 'year',
    seniority: ['Director'], categories: ['Sales', 'Engineering'],
    pubDate: 1790726400, expiryDate: 1796083200,
    updatedAt: 1790897999,
    ...overrides,
  }
}

export function workableRaw(overrides: Record<string, unknown> = {}) {
  return {
    shortcode: 'SN63HIDDEN',
    title: 'Backend Engineer — Synthetic Birch News63',
    url: 'https://apply.workable.com/j/SN63HIDDEN/',
    description: '<p>Responsibilities: develop a fictional news API with TypeScript.</p><p>Qualifications: 3 years of software engineering experience with PostgreSQL.</p>',
    telecommuting: false, employment_type: 'Full-time', department: 'Engineering',
    locations: [{ country: 'United States', countryCode: 'US', city: 'New York', hidden: true }],
    country: 'Japan', city: 'Tokyo', state: 'Tokyo',
    created_at: '2026-09-30T00:00:00.000Z', published_on: '2026-10-01',
    ...overrides,
  }
}

export type HimalayasScenario =
  | 'valid' | 'short-first' | 'empty-final' | 'duplicate' | 'wrong-slug'
  | 'wrong-guid-company' | 'wrong-guid-origin' | 'wrong-offset'
  | 'changed-total' | 'changed-limit' | 'malformed-required'
  | 'expired-foreign-guid' | 'expired-duplicate' | 'final-503' | 'final-429'
  | 'presence-invalid-body' | 'changed-body'

export function microsoftPages(scenario: HimalayasScenario = 'valid'): Record<string, unknown> {
  const first = 'https://himalayas.app/jobs/api/search?company=microsoft&sort=recent&page=1'
  const last = 'https://himalayas.app/jobs/api/search?company=microsoft&sort=recent&page=2'
  const primary: Record<string, unknown> = microsoftRaw(scenario === 'changed-body' ? {
    title: HIMALAYAS_CHANGED_TITLE, description: `<p>${HIMALAYAS_CHANGED_BODY}</p>`,
  } : {})
  const sales: Record<string, unknown> = microsoftRaw({
    guid: 'https://himalayas.app/companies/microsoft/jobs/synthetic-sales63',
    title: 'Account Executive — Synthetic Cedar Sales63',
    description: '<p>Sell fictional customer subscriptions and negotiate renewals.</p>',
    seniority: ['Entry Level'], categories: ['Sales'],
  })
  const expired: Record<string, unknown> = microsoftRaw({
    guid: 'https://himalayas.app/companies/microsoft/jobs/synthetic-expired63',
    title: 'Backend Engineer — Synthetic Expired Cedar63',
    expiryDate: 1790812800,
  })
  const page1 = { offset: 0, limit: 2, totalCount: 3, updatedAt: 1790897999, jobs: [primary, sales] }
  const page2 = { offset: 2, limit: 2, totalCount: 3, updatedAt: 1790898000, jobs: [expired] }
  if (scenario === 'short-first') page1.jobs = [primary]
  if (scenario === 'empty-final') page2.jobs = []
  if (scenario === 'duplicate') page2.jobs = [{ ...primary }]
  if (scenario === 'wrong-slug') sales.companySlug = 'adobe'
  if (scenario === 'wrong-guid-company') sales.guid = 'https://himalayas.app/companies/adobe/jobs/synthetic-sales63'
  if (scenario === 'wrong-guid-origin') sales.guid = 'https://example.com/companies/microsoft/jobs/synthetic-sales63'
  if (scenario === 'wrong-offset') page2.offset = 1
  if (scenario === 'changed-total') page2.totalCount = 4
  if (scenario === 'changed-limit') page2.limit = 1
  if (scenario === 'malformed-required') sales.title = ''
  if (scenario === 'expired-foreign-guid') expired.guid = 'https://himalayas.app/companies/adobe/jobs/synthetic-expired63'
  if (scenario === 'expired-duplicate') expired.guid = primary.guid
  if (scenario === 'presence-invalid-body') {
    primary.description = { deliberatelyNotAString: true }
    sales.description = { deliberatelyNotAString: true }
  }
  return {
    [first]: page1,
    [last]: scenario === 'final-503'
      ? coverageReply({ error: 'Synthetic unavailable final page63' }, { status: 503 })
      : scenario === 'final-429'
        ? coverageReply({ error: 'Synthetic daily provider retry63' }, { status: 429, headers: { 'Retry-After': '120' } })
        : page2,
  }
}

export function newSourceResponses(options: {
  microsoft?: HimalayasScenario
  smartNewsFailure?: boolean
} = {}): Record<string, unknown> {
  const one = (job: Record<string, unknown>) => ({ offset: 0, limit: 20, totalCount: 1, jobs: [job] })
  const adobe = microsoftRaw({
    guid: 'https://himalayas.app/companies/adobe/jobs/synthetic-iris-editor63',
    companySlug: 'adobe', companyName: 'Adobe',
    title: 'Frontend Engineer — Synthetic Iris Editor63',
    description: '<p>Develop a fictional editor interface with TypeScript and React.</p><p>Qualifications: 3 years of frontend software engineering experience.</p>',
    locationRestrictions: [], timezoneRestrictions: ['UTC+08:00', 'UTC+09:00'],
    minSalary: null, maxSalary: null,
    pubDate: 1790726400000, expiryDate: 1796083200000,
  })
  const salesforce = microsoftRaw({
    guid: 'https://himalayas.app/companies/salesforce/jobs/synthetic-maple-cloud63',
    companySlug: 'salesforce', companyName: 'Salesforce',
    title: 'Backend Engineer — Synthetic Maple Cloud63',
    locationRestrictions: [], timezoneRestrictions: [], minSalary: null, maxSalary: null,
  })
  const cisco = microsoftRaw({
    guid: 'https://himalayas.app/companies/cisco/jobs/synthetic-harbor-network63',
    companySlug: 'cisco', companyName: 'Cisco',
    title: 'Backend Engineer — Synthetic Harbor Network63',
    locationRestrictions: [{ alpha2: 'US', name: 'United States' }, { alpha2: 'CA', name: 'Canada' }],
    timezoneRestrictions: [], minSalary: null, maxSalary: null,
  })
  const qualcomm = microsoftRaw({
    guid: 'https://himalayas.app/companies/qualcomm/jobs/synthetic-orchid-runtime63',
    companySlug: 'qualcomm', companyName: 'Qualcomm',
    title: 'Backend Engineer — Synthetic Orchid Runtime63',
    locationRestrictions: ['India'], timezoneRestrictions: [], minSalary: null, maxSalary: null,
  })
  const broadcom = microsoftRaw({
    guid: 'https://himalayas.app/companies/broadcom/jobs/synthetic-slate-storage63',
    companySlug: 'broadcom', companyName: 'Broadcom',
    title: 'Backend Engineer — Synthetic Slate Storage63',
    locationRestrictions: ['Germany'], timezoneRestrictions: [], minSalary: null, maxSalary: null,
  })
  const redhat = microsoftRaw({
    guid: 'https://himalayas.app/companies/red-hat/jobs/synthetic-willow-linux63',
    companySlug: 'red-hat', companyName: 'Red Hat',
    title: 'Backend Engineer — Synthetic Willow Linux63',
    locationRestrictions: [], timezoneRestrictions: [], minSalary: null, maxSalary: null,
  })
  const huggingFace = {
    name: 'Hugging Face, Inc.',
    jobs: [workableRaw({
      shortcode: 'HF63REMOTE', title: 'Backend Engineer — Synthetic Fern Model63',
      url: 'https://apply.workable.com/j/HF63REMOTE/', telecommuting: true,
      locations: [{ country: 'France', countryCode: 'FR', hidden: false }],
    })],
  }
  const smartNews = { name: 'SmartNews, Inc.', jobs: [workableRaw()] }
  const mercari = {
    name: 'Mercari, Inc.',
    jobs: [workableRaw({
      shortcode: 'MC63TOKYO', title: 'Backend Engineer — Synthetic Elm Market63',
      url: 'https://apply.workable.com/j/MC63TOKYO/',
      locations: [{ country: 'Japan', countryCode: 'JP', city: 'Tokyo', hidden: false }],
    })],
  }
  // Presence gets identities only, with a deliberately invalid body sentinel.
  const presence = (feed: typeof smartNews) => ({
    name: feed.name, jobs: feed.jobs.map(({ shortcode, title, url }) => ({
      shortcode, title, url, description: { mustNotNormalizeBody: true },
    })),
  })
  return {
    ...microsoftPages(options.microsoft),
    'https://himalayas.app/jobs/api/search?company=adobe&sort=recent&page=1': one(adobe),
    'https://himalayas.app/jobs/api/search?company=salesforce&sort=recent&page=1': one(salesforce),
    'https://himalayas.app/jobs/api/search?company=cisco&sort=recent&page=1': one(cisco),
    'https://himalayas.app/jobs/api/search?company=qualcomm&sort=recent&page=1': one(qualcomm),
    'https://himalayas.app/jobs/api/search?company=broadcom&sort=recent&page=1': one(broadcom),
    'https://himalayas.app/jobs/api/search?company=red-hat&sort=recent&page=1': one(redhat),
    'https://apply.workable.com/api/v1/widget/accounts/huggingface?details=true': huggingFace,
    'https://apply.workable.com/api/v1/widget/accounts/huggingface': presence(huggingFace),
    'https://apply.workable.com/api/v1/widget/accounts/smartnews?details=true': options.smartNewsFailure
      ? coverageReply({ error: 'Synthetic Workable outage63' }, { status: 503 }) : smartNews,
    'https://apply.workable.com/api/v1/widget/accounts/smartnews': presence(smartNews),
    'https://apply.workable.com/api/v1/widget/accounts/mercari?details=true': mercari,
    'https://apply.workable.com/api/v1/widget/accounts/mercari': presence(mercari),
  }
}

export function integrationResponses(options: Parameters<typeof newSourceResponses>[0] = {}): Record<string, unknown> {
  return { ...surveyResponses(), ...newSourceResponses(options) }
}

/** Extend a historical response map without changing any old36/47 posting. */
export function withIntegrationEmptyBoards(responses: Record<string, unknown>): Record<string, unknown> {
  return {
    'https://himalayas.app/jobs/api/search?company=microsoft&sort=recent&page=1': { offset: 0, limit: 20, totalCount: 0, jobs: [] },
    'https://himalayas.app/jobs/api/search?company=adobe&sort=recent&page=1': { offset: 0, limit: 20, totalCount: 0, jobs: [] },
    'https://himalayas.app/jobs/api/search?company=salesforce&sort=recent&page=1': { offset: 0, limit: 20, totalCount: 0, jobs: [] },
    'https://himalayas.app/jobs/api/search?company=cisco&sort=recent&page=1': { offset: 0, limit: 20, totalCount: 0, jobs: [] },
    'https://himalayas.app/jobs/api/search?company=qualcomm&sort=recent&page=1': { offset: 0, limit: 20, totalCount: 0, jobs: [] },
    'https://himalayas.app/jobs/api/search?company=broadcom&sort=recent&page=1': { offset: 0, limit: 20, totalCount: 0, jobs: [] },
    'https://himalayas.app/jobs/api/search?company=red-hat&sort=recent&page=1': { offset: 0, limit: 20, totalCount: 0, jobs: [] },
    'https://apply.workable.com/api/v1/widget/accounts/huggingface?details=true': { name: 'Hugging Face', jobs: [] },
    'https://apply.workable.com/api/v1/widget/accounts/huggingface': { name: 'Hugging Face', jobs: [] },
    'https://apply.workable.com/api/v1/widget/accounts/smartnews?details=true': { name: 'SmartNews', jobs: [] },
    'https://apply.workable.com/api/v1/widget/accounts/smartnews': { name: 'SmartNews', jobs: [] },
    'https://apply.workable.com/api/v1/widget/accounts/mercari?details=true': { name: 'Mercari', jobs: [] },
    'https://apply.workable.com/api/v1/widget/accounts/mercari': { name: 'Mercari', jobs: [] },
    ...responses,
  }
}

export function integrationOld83Cache() {
  const old36 = expansionLegacy36Cache(INTEGRATION_OLD_AT)
  return {
    ...old36,
    boards: [
      ...old36.boards,
      ...SURVEY_REGISTRATIONS.map(company => ({
        companyId: company.id, provider: company.provider, board: company.board,
        checkedAt: INTEGRATION_OLD_AT, failures: 0, retryAt: null,
        snapshot: {
          fetchedAt: INTEGRATION_OLD_AT, jobs: [], total: 0,
          unmappedCount: 0, publishedIds: [],
        },
      })),
    ],
  }
}

export const integrationOldSaved = () => surveyOldSaved(INTEGRATION_OLD_AT)
