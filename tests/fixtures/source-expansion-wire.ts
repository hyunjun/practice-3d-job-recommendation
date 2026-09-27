import { BOOKING_LIST_URLS, STARBUCKS_LIST_URLS, ZALANDO_LIST_URLS } from './careers-contract'
import { bookingResponses, starbucksResponses, zalandoResponses, STARBUCKS_DETAIL_URLS, ZALANDO_DETAIL_URLS } from './careers-wire'
import { SOFTWARE_DESIGN_BODY, TEXTILE_DESIGN_BODY } from './industry-occupation'
import { coveragePresenceResponses, publicCoverageResponses } from './public-coverage'
import { withSurveyEmptyBoards } from './public-company-survey'
import { smartRecruitersPosting } from './public-postings'
import { INTEGRATION_REGISTRATIONS } from './source-integration-contract'
import { integrationOld83Cache, withIntegrationEmptyBoards } from './source-integrations'
import { SOURCE_EXPANSION_ATS_FULL_URLS, SOURCE_EXPANSION_ATS_PRESENCE_URLS, SOURCE_EXPANSION_REGISTRATIONS } from './source-expansion-contract'
import { SOURCE_EXPANSION_ATS_JOBS } from './source-expansion-postings'

export const SOURCE_EXPANSION_NOW = '2026-10-01T23:40:00.000Z'
export const SOURCE_EXPANSION_NOTE = 'Synthetic Stage64 note — Starbucks / café\nKeep the original application 🌿'
export const SOURCE_EXPANSION_DETAIL_URLS = [
  'https://api.smartrecruiters.com/v1/companies/Freshworks/postings/synthetic-650005',
  'https://api.smartrecruiters.com/v1/companies/McDonaldsCorporation/postings/synthetic-650015',
  'https://api.smartrecruiters.com/v1/companies/InterIKEAGroup/postings/synthetic-650016',
  'https://api.smartrecruiters.com/v1/companies/InterIKEAGroup/postings/synthetic-659016',
  'https://api.smartrecruiters.com/v1/companies/ScalableGmbH/postings/synthetic-650023',
  'https://api.smartrecruiters.com/v1/companies/Auto1/postings/synthetic-650028',
] as const
export const SOURCE_EXPANSION_ALL_FULL_URLS = [
  ...Object.values(SOURCE_EXPANSION_ATS_FULL_URLS), ...SOURCE_EXPANSION_DETAIL_URLS,
  ...BOOKING_LIST_URLS, ...ZALANDO_LIST_URLS, ...ZALANDO_DETAIL_URLS, ...STARBUCKS_LIST_URLS, ...STARBUCKS_DETAIL_URLS,
]
export const SOURCE_EXPANSION_EXCLUDED_IDS = [
  'greenhouse-doctolib-659002',
  'greenhouse-lucid-659018', 'greenhouse-lucid-659118', 'greenhouse-lucid-659218',
  'smartrecruiters-ikea-synthetic-659016', 'smartrecruiters-ikea-synthetic-659116',
  'careers-booking-640002', 'careers-zalando-640002', 'careers-starbucks-640002',
] as const
const apiBody = 'Responsibilities\nBuild backend software and maintain a fictional API with TypeScript and PostgreSQL.\nQualifications\n3 years of software engineering experience required.'
const html = (text: string) => text.split('\n').map(line => `<p>${line}</p>`).join('')

/** All source text is synthetic, including the v6 physical/commercial negatives. */
export function sourceExpansionResponses(): Record<string, unknown> {
  const old = withSurveyEmptyBoards(publicCoverageResponses())
  // The old93 snapshot contains only Stripe and Notion. Its next lightweight
  // inventory must keep both IDs and the other91 empty boards unchanged.
  old['https://boards-api.greenhouse.io/v1/boards/moloco/jobs?content=true&pay_transparency=true'] = { jobs: [], meta: { total: 0 } }
  old['https://boards-api.greenhouse.io/v1/boards/sendbird/jobs?content=true&pay_transparency=true'] = { jobs: [], meta: { total: 0 } }
  old['https://api.ashbyhq.com/posting-api/job-board/notion?includeCompensation=true'] = { apiVersion: '1', jobs: [{
    id: 'synthetic-57102', title: 'Backend Engineer — Synthetic Maple Index',
    jobUrl: 'https://example.com/synthetic/notion-57102', isListed: true,
    descriptionPlain: apiBody, department: 'Software Engineering', location: 'Seoul, South Korea',
  }] }
  const responses = withIntegrationEmptyBoards(coveragePresenceResponses(old))
  for (const job of SOURCE_EXPANSION_ATS_JOBS) {
    const company = SOURCE_EXPANSION_REGISTRATIONS.find(company => company.id === job.companyId)!
    const description = job.companyId === 'ikea' ? SOFTWARE_DESIGN_BODY : apiBody
    const department = job.companyId === 'ikea' ? 'Digital Products' : 'Software Engineering'
    const fullUrl = SOURCE_EXPANSION_ATS_FULL_URLS[job.companyId]
    const presenceUrl = SOURCE_EXPANSION_ATS_PRESENCE_URLS[job.companyId]
    if (job.source === 'greenhouse') {
      const row = (id: number, title: string, body: string, departments = [department]) => ({
        id, title, content: html(body), location: { name: job.locationLabel },
        absolute_url: id === job.nativeId ? job.url : `https://example.com/synthetic/stage64/excluded-${id}`,
        departments: departments.map(name => ({ name })), updated_at: '2026-10-01T12:00:00.000Z',
      })
      const jobs = [row(job.nativeId, job.title, description)]
      if (job.companyId === 'doctolib') jobs.push(row(659002, 'Business Developer', 'Responsibilities\nNegotiate fictional sales agreements and manage account revenue.'))
      if (job.companyId === 'lucid') {
        jobs.push(
          row(659018, 'Engineer, Interiors', 'Responsibilities\nDesign physical interior trim and choose upholstery.', ['Vehicle Engineering']),
          row(659118, 'CAD Engineer', 'Responsibilities\nDimension physical body structures and draft assembly fixtures.', ['Body Structures']),
          row(659218, 'Battery Test Engineer', 'Responsibilities\nCycle battery cells in physical test chambers.', ['Battery Validation']),
        )
      }
      responses[fullUrl] = { jobs, meta: { total: jobs.length } }
      responses[presenceUrl] = { jobs: jobs.map(({ content: _content, ...summary }) => summary), meta: { total: jobs.length } }
    } else if (job.source === 'ashby') {
      const jobs = [{
        id: job.nativeId, title: job.title, jobUrl: job.url, isListed: true, department,
        location: job.locationLabel, descriptionPlain: description,
        address: { postalAddress: { addressCountry: job.country } }, employmentType: 'FullTime', workplaceType: 'OnSite',
      }]
      responses[fullUrl] = { apiVersion: '1', jobs }
      responses[presenceUrl] = { apiVersion: '1', jobs: jobs.map(({ descriptionPlain: _body, ...summary }) => summary) }
    } else if (job.source === 'lever') {
      responses[fullUrl] = [{
        id: job.nativeId, text: job.title, hostedUrl: job.url, descriptionPlain: description,
        categories: { location: job.locationLabel, department, commitment: 'Full-time' }, country: job.country, workplaceType: 'on-site',
      }]
    } else {
      const row = (id: string, name: string, body: string) => smartRecruitersPosting({
        id, name, company: { identifier: company.board! },
        postingUrl: id === job.nativeId ? job.url : `https://example.com/synthetic/stage64/excluded-${id}`,
        releasedDate: '2026-10-01T12:00:00.000Z',
        location: { city: job.locationLabel.split(',')[0], country: job.country.toLowerCase(), fullLocation: job.locationLabel, remote: false, hybrid: false },
        function: { label: department },
        jobAd: { sections: { jobDescription: { title: 'Responsibilities', text: html(body) } } },
      })
      const jobs = [row(String(job.nativeId), job.title, description)]
      if (job.companyId === 'ikea') {
        jobs.push(row('synthetic-659016', 'Design Engineer', TEXTILE_DESIGN_BODY))
        jobs.push(row('synthetic-659116', 'Business Developer', 'Responsibilities\nNegotiate fictional textile supply contracts.'))
      }
      responses[fullUrl] = { offset: 0, limit: 100, totalFound: jobs.length, content: jobs.map(({ jobAd: _body, ...summary }) => summary) }
      for (const posting of jobs) responses[`https://api.smartrecruiters.com/v1/companies/${company.board}/postings/${posting.id}`] = posting
    }
  }
  return { ...responses, ...bookingResponses(), ...zalandoResponses(), ...starbucksResponses() }
}

/** Exactly93 old sources, before this expansion. Only two historical jobs are retained. */
export function sourceExpansionOld93Cache() {
  const old = integrationOld83Cache()
  return {
    ...old,
    boards: [...old.boards, ...INTEGRATION_REGISTRATIONS.map(company => ({
      companyId: company.id, provider: company.provider, board: company.board,
      checkedAt: '2026-10-01T23:39:55.000Z', failures: 0, retryAt: null,
      snapshot: { fetchedAt: '2026-10-01T23:39:55.000Z', jobs: [], total: 0, unmappedCount: 0, publishedIds: [] },
    }))],
  }
}
