import type { Company } from '../../shared/types'

// Invented public-board registrations and upstream responses. No catalog or
// matcher output is supplied: the real provider pipeline must build the jobs.
export const BOARD_CONFIG_REGISTRATIONS = [
  {
    id: 'aurora-config', name: 'Aurora Workshop', provider: 'greenhouse',
    board: 'Aurora Private42', careerUrl: 'https://example.com/careers/aurora', industry: 'Synthetic software',
  },
  {
    id: 'birch-config', name: 'Birch Studio', provider: 'ashby',
    board: 'Birch.Private42', careerUrl: 'https://example.com/careers/birch', industry: 'Synthetic software',
  },
  {
    id: 'cedar-config', name: 'Cedar Systems', provider: 'lever', boardRegion: 'eu',
    board: 'Cedar-Private42', careerUrl: 'https://example.com/careers/cedar', industry: 'Synthetic software',
  },
  {
    id: 'dune-config', name: 'Dune Software', provider: 'smartrecruiters',
    board: 'DunePrivate42', careerUrl: 'https://example.com/careers/dune', industry: 'Synthetic software',
  },
] as const

export function boardRegistration(overrides: Partial<Company> = {}) {
  return { ...BOARD_CONFIG_REGISTRATIONS[0], ...overrides }
}

export const BOARD_CONFIG_NOTE = 'Synthetic private note: prepare a TypeScript example.'
export const BOARD_CONFIG_UPDATED_AT = '2026-09-19T06:00:00.000Z'
const description = 'Responsibilities\nBuild backend software in London.\n\nQualifications\n3 years of software engineering experience with TypeScript.'

const greenhouse = (next: boolean) => ({
  id: 4201, title: next ? 'Backend Engineer Aurora Next' : 'Backend Engineer Aurora',
  absolute_url: next ? 'https://example.com/jobs/aurora-next' : 'https://example.com/jobs/aurora-original',
  location: { name: 'London, United Kingdom' },
  updated_at: BOARD_CONFIG_UPDATED_AT,
  content: '<h2>Responsibilities</h2><p>Build backend software in London.</p><h2>Qualifications</h2><p>3 years of software engineering experience with TypeScript.</p>',
  departments: [{ name: 'Engineering' }],
  metadata: [{ name: 'Employment Type', value: 'Full-time' }, { name: 'Workplace Type', value: 'Onsite' }],
})
const ashby = {
  id: 'birch-4202', title: 'Backend Engineer Birch', jobUrl: 'https://example.com/jobs/birch',
  isListed: true, location: 'London', address: { addressLocality: 'London', addressCountry: 'GB' },
  workplaceType: 'OnSite', isRemote: false, employmentType: 'FullTime',
  department: 'Engineering', descriptionPlain: description,
}
const lever = {
  id: 'cedar-4203', text: 'Backend Engineer Cedar', hostedUrl: 'https://example.com/jobs/cedar',
  categories: { location: 'London', commitment: 'Full-time', department: 'Engineering' },
  country: 'GB', workplaceType: 'on-site', descriptionPlain: description,
}
const smartRecruiters = {
  id: 'dune-4204', name: 'Backend Engineer Dune',
  company: { identifier: 'DunePrivate42' }, visibility: 'PUBLIC', active: true,
  releasedDate: BOARD_CONFIG_UPDATED_AT, postingUrl: 'https://example.com/jobs/dune',
  location: { city: 'London', country: 'gb', fullLocation: 'London, United Kingdom', remote: false, hybrid: false },
  typeOfEmployment: { label: 'Full-time' }, function: { label: 'Engineering' },
  jobAd: { sections: {
    jobDescription: { title: 'Responsibilities', text: '<p>Build backend software in London.</p>' },
    qualifications: { title: 'Qualifications', text: '<p>3 years of software engineering experience with TypeScript.</p>' },
  } },
}

/** Exact, upstream-only transport. Unexpected URLs never fall through to the network. */
export function boardFixtureResponse(input: string | URL): unknown {
  const url = new URL(input)
  if (url.protocol !== 'https:') throw new Error(`Unexpected fixture protocol: ${url.protocol}`)
  const pathname = decodeURIComponent(url.pathname)
  if (url.hostname === 'boards-api.greenhouse.io'
    && ['/v1/boards/Aurora Private42/jobs', '/v1/boards/Aurora.Next42/jobs'].includes(pathname)
    && url.search === '?content=true&pay_transparency=true') {
    return { jobs: [greenhouse(pathname.includes('Aurora.Next42'))], meta: { total: 1 } }
  }
  if (url.hostname === 'boards-api.greenhouse.io'
    && ['/v1/boards/Aurora Private42/jobs', '/v1/boards/Aurora.Next42/jobs'].includes(pathname)
    && url.search === '?content=false') {
    const { id, title, absolute_url } = greenhouse(pathname.includes('Aurora.Next42'))
    return { jobs: [{ id, title, absolute_url }], meta: { total: 1 } }
  }
  if (url.hostname === 'api.ashbyhq.com' && pathname === '/posting-api/job-board/Birch.Private42'
    && url.search === '?includeCompensation=true') return { apiVersion: '1', jobs: [ashby] }
  if (url.hostname === 'api.ashbyhq.com' && pathname === '/posting-api/job-board/Birch.Private42'
    && !url.search) return { apiVersion: '1', jobs: [{
    id: 'birch-4202', title: 'Backend Engineer Birch', jobUrl: 'https://example.com/jobs/birch', isListed: true,
  }] }
  if (url.hostname === 'api.eu.lever.co' && pathname === '/v0/postings/Cedar-Private42'
    && url.search === '?mode=json&limit=50&skip=0') return [lever]
  if (url.hostname === 'api.smartrecruiters.com' && pathname === '/v1/companies/DunePrivate42/postings'
    && url.search === '?limit=100&offset=0&destination=PUBLIC') {
    return { offset: 0, limit: 100, totalFound: 1, content: [smartRecruiters] }
  }
  if (url.hostname === 'api.smartrecruiters.com'
    && pathname === '/v1/companies/DunePrivate42/postings/dune-4204' && !url.search) return smartRecruiters
  throw new Error(`Unexpected upstream fixture URL: ${url.href}`)
}
