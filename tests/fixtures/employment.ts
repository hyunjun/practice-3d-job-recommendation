import { normalizeJob } from '../../server/normalize'
import type { GreenhouseJob } from '../../server/normalize'
import type { Job } from '../../shared/types'
import { SEARCH_COMPANIES, SEARCH_TIME } from './search-catalog'

export const CONTRACT_TECHNOLOGY_TITLE = 'Software Engineer - Smart Contract Platform'
export const MENTORING_BODY = 'This is a full-time position building TypeScript tools and mentoring an intern on our team.'

export function employmentPosting(id = 30001, title = CONTRACT_TECHNOLOGY_TITLE, body = 'Build software with TypeScript and smart contract technology.'): GreenhouseJob {
  return {
    id, title, absolute_url: `https://example.com/employment/${id}`,
    location: { name: 'London, UK' }, content: `<p>${body}</p>`,
    departments: [{ name: 'Engineering' }],
  }
}

export function legacyEmploymentJob(kind: 'title' | 'description' = 'title'): Job {
  const raw = kind === 'title' ? employmentPosting()
    : employmentPosting(30002, 'Software Engineer - Developer Tools', MENTORING_BODY)
  const job = normalizeJob(raw, SEARCH_COMPANIES[0].id, SEARCH_TIME)!
  return {
    ...job, employment: kind === 'title' ? 'contract' : 'intern', employmentVersion: undefined,
    evidence: { ...job.evidence, employment: { source: kind, text: kind === 'title' ? job.title : MENTORING_BODY } },
  }
}
