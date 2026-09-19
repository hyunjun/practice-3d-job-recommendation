import { normalizeJob } from '../../server/normalize'
import type { Job } from '../../shared/types'
import { SEARCH_COMPANIES, SEARCH_TIME } from './search-catalog'

export const UPGRADE_TITLE = 'Backend Engineer - Developer Tools'
export const UPGRADE_BODY = '<h2>About us</h2><p>Our user interface uses React.</p><h2>Requirements</h2><p>Experience with TypeScript or Python.</p><p>At least 4 years of experience.</p><h2>Nice to have</h2><p>Experience with Go.</p>'

export function currentUpgradeJob(): Job {
  return normalizeJob({
    id: 31001, title: UPGRADE_TITLE, absolute_url: 'https://example.com/jobs/31001',
    location: { name: 'London, UK' }, departments: [{ name: 'Engineering' }],
    metadata: [{ name: 'Employment Type', value: 'Full-time' }], content: UPGRADE_BODY,
  }, SEARCH_COMPANIES[0].id, SEARCH_TIME)!
}

export function legacyUpgradeJob(): Job {
  return {
    ...currentUpgradeJob(), qualifications: undefined,
    skills: ['React', 'TypeScript', 'Python', 'Go'], minExperience: 1,
  }
}
