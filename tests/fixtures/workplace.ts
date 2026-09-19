import { locateCities, normalizeJob } from '../../server/normalize'
import type { GreenhouseJob } from '../../server/normalize'
import type { Job } from '../../shared/types'
import { SEARCH_COMPANIES, SEARCH_TIME } from './search-catalog'

export const WORKPLACE_TITLE = 'Research Engineer (Internship in Paris or London)'
export const WORKPLACE_BODY = 'This internship is based in Paris or London for 6 months. On completion, successful interns may join our Seoul office in a separate full-time position. Applicants must reside in Korea and meet the later role’s work authorization requirements.'
export const RELOCATION_TITLE = 'Frontend Engineer (RELOCATE to Sydney)'
export const RELOCATION_BODY = 'This role is based in Sydney, and we offer a hybrid working schedule. Applicants must be willing to relocate before starting.'
export const CONFLICT_BODY = 'This role is based in Melbourne, and we offer a hybrid working schedule.'

export function workplacePosting(id = 2401, title = WORKPLACE_TITLE, location = 'Seoul', body = WORKPLACE_BODY): GreenhouseJob {
  return {
    id, title, absolute_url: `https://example.com/workplace/${id}`, updated_at: SEARCH_TIME,
    location: { name: location }, metadata: [{ name: 'workplaceType', value: 'OnSite' }],
    content: `<h2>Location</h2><p>${body}</p><h2>Requirements</h2><p>Experience with TypeScript.</p>`,
  }
}

/** A complete saved posting from before workplace reconciliation was introduced. */
export function legacyWorkplaceJob(raw = workplacePosting()): Job {
  const { locationResolution: _resolution, ...job } = normalizeJob(raw, SEARCH_COMPANIES[0].id, SEARCH_TIME)!
  return { ...job, cityIds: locateCities(raw.location!.name!), locationLabel: raw.location!.name! }
}
