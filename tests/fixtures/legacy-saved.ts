import type { SavedJob } from '../../shared/types'

// Dedicated retired input. It is never served by a public catalog fixture and
// is not made by changing the source field of the old authored demonstration.
export const LEGACY_POSTING_BOOKMARK: SavedJob = {
  company: {
    id: 'retired-bookmark-fixture', name: 'Retired Bookmark Fixture', initials: 'RB', color: '#3974cc',
    industry: 'Historical test input', careerUrl: 'https://example.test/retired-bookmark',
  },
  job: {
    id: 'sample-retired-bookmark-fixture', companyId: 'retired-bookmark-fixture',
    title: 'Historical fictional bookmark', role: 'backend', cityIds: ['london'],
    locationLabel: 'London', workMode: 'hybrid', employment: 'fulltime',
    skills: ['Python'], minExperience: 3, salary: null, visa: 'unknown',
    remoteCountries: [], remoteWorldwide: false, remoteScopeUnknown: false,
    description: 'Retired synthetic sample saved by an older app.',
    requirements: [], url: 'https://example.test/retired-bookmark', source: 'sample',
    updatedAt: null, fetchedAt: '2026-09-18T00:00:00.000Z',
  },
  savedAt: '2026-09-19T07:59:00.000Z', status: 'saved', note: 'Sample bookmark',
}
