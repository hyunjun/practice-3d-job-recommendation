import { normalizeJob } from '../../server/normalize'
import type { Job } from '../../shared/types'
import { SEARCH_COMPANIES, SEARCH_TIME } from './search-catalog'
import { workplacePosting, WORKPLACE_TITLE } from './workplace'

export const INTERNSHIP_SPONSORSHIP = 'This internship is based in Paris or London for six months, with visa sponsorship and relocation support provided by the employer. After the internship, successful applicants may be offered a separate full-time role in Seoul. Applicants must be based in Korea.'
export const TRANSFER_SPONSORSHIP = 'We are only considering local candidates. Relocation support is not provided. For local candidates we are able to support transfer of visa sponsorship.'
export const NON_IMMIGRATION = 'Experience with BIN sponsorship models and the Visa and Mastercard card networks.'

export function sponsorshipJob(kind: 'internship' | 'transfer' | 'unknown'): Job {
  const input = kind === 'internship' ? workplacePosting(2501, WORKPLACE_TITLE, 'Seoul', INTERNSHIP_SPONSORSHIP)
    : kind === 'transfer' ? workplacePosting(2502, 'Backend Engineer, Local Team', 'London', TRANSFER_SPONSORSHIP)
      : workplacePosting(2503, 'Backend Engineer, Card Networks', 'London', NON_IMMIGRATION)
  return normalizeJob(input, SEARCH_COMPANIES[0].id, SEARCH_TIME)!
}

export function legacySponsorshipJob(kind: Parameters<typeof sponsorshipJob>[0]): Job {
  const job = sponsorshipJob(kind)
  const { visa: _visaEvidence, ...otherEvidence } = job.evidence ?? {}
  return {
    ...job, visa: 'unknown', evidence: otherEvidence,
    eligibility: { version: 1, rules: job.eligibility!.rules.filter(rule => rule.kind !== 'sponsorship-scope') },
  }
}
