import { normalizeJob } from '../../server/normalize'
import { occupationFacts } from '../../shared/job-occupation'
import type { Job, JobOccupation, KnownJobRole } from '../../shared/types'
import { SEARCH_COMPANIES, SEARCH_TIME } from './search-catalog'

export const OUTSIDE_ROLES: { title: string; department: string; role: KnownJobRole; category: JobOccupation['category'] }[] = [
  { title: 'Senior Technical Writer / Developer Educator', department: 'Engineering & Infra', role: 'devops', category: 'other' },
  { title: 'Support Engineer, Backend', department: 'Backend Engineering', role: 'backend', category: 'support' },
  { title: 'Engineering Manager, Machine Learning', department: 'AI Research', role: 'ml', category: 'management' },
  { title: 'Mechanical Engineer, Infrastructure', department: 'Infrastructure', role: 'devops', category: 'other' },
  { title: 'Applied Scientist', department: 'Platform', role: 'devops', category: 'unconfirmed' },
]

/** A preserved earlier specialty is not proof that the job is a developer role. */
export function outsideRoleJob(index = 0, version: JobOccupation['version'] = 2, body = '<h2>Requirements</h2><p>Experience with TypeScript.</p>'): Job {
  const fixture = OUTSIDE_ROLES[index]
  const base = normalizeJob({
    id: 2801 + index, title: 'Software Engineer', location: { name: 'London, UK' },
    absolute_url: `https://example.com/saved-scope/${index}`,
    content: body,
  }, SEARCH_COMPANIES[0].id, SEARCH_TIME)!
  const occupation = occupationFacts({
    title: fixture.title, description: base.description, departments: [fixture.department],
  })
  return JSON.parse(JSON.stringify({
    ...base, title: fixture.title, role: fixture.role,
    roleClassification: {
      version: 1, roles: [fixture.role],
      evidence: [{ role: fixture.role, source: 'board', text: fixture.department }],
    },
    occupation: {
      ...occupation, version,
      category: index === 0 && version < 3 ? 'engineering' : occupation.category,
    },
  }))
}
