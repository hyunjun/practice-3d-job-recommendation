import type { Company } from '../../shared/types'

// Approved stage70 metadata; every test posting remains fictional. This six
// source cohort is independent of the historical31 in source-expansion-contract.
export const REGIONAL_SOURCE_REGISTRATIONS = [
  { id: 'halter', name: 'Halter', provider: 'ashby', board: 'halter',
    careerUrl: 'https://www.halterhq.com/careers', industry: '농업 · IoT · 소프트웨어' },
  { id: 'partly', name: 'Partly', provider: 'ashby', board: 'partly.com',
    careerUrl: 'https://www.partly.com/us/careers/open-roles', industry: '자동차 · AI · 수리 소프트웨어' },
  { id: 'pushpay', name: 'Pushpay', provider: 'greenhouse', board: 'pushpay',
    careerUrl: 'https://pushpay.com/about-us/careers/', industry: '결제 · 커뮤니티 소프트웨어' },
  { id: 'lalamove', name: 'Lalamove', provider: 'lever', board: 'lalamove',
    careerUrl: 'https://www.lalamove.com/careers', industry: '물류 · 모빌리티' },
  { id: 'dat', name: 'DAT Freight & Analytics', provider: 'greenhouse', board: 'datsolutions',
    careerUrl: 'https://careers.dat.com/jobs/', industry: '물류 · 운송 데이터' },
  { id: 'pikpok', name: 'PikPok', provider: 'workable', board: 'pikpok',
    careerUrl: 'https://pikpok.com/careers/', industry: '게임 · 소프트웨어' },
] satisfies Pick<Company, 'id' | 'name' | 'provider' | 'board' | 'careerUrl' | 'industry'>[]

export const REGIONAL_SOURCE_IDS = ['halter', 'partly', 'pushpay', 'lalamove', 'dat', 'pikpok']
export const REGIONAL_SOURCE_FULL_URLS = [
  'https://api.ashbyhq.com/posting-api/job-board/halter?includeCompensation=true',
  'https://api.ashbyhq.com/posting-api/job-board/partly.com?includeCompensation=true',
  'https://boards-api.greenhouse.io/v1/boards/pushpay/jobs?content=true&pay_transparency=true',
  'https://api.lever.co/v0/postings/lalamove?mode=json&limit=50&skip=0',
  'https://boards-api.greenhouse.io/v1/boards/datsolutions/jobs?content=true&pay_transparency=true',
  'https://apply.workable.com/api/v1/widget/accounts/pikpok?details=true',
]
export const REGIONAL_SOURCE_PRESENCE_URLS = [
  'https://api.ashbyhq.com/posting-api/job-board/halter',
  'https://api.ashbyhq.com/posting-api/job-board/partly.com',
  'https://boards-api.greenhouse.io/v1/boards/pushpay/jobs?content=false',
  'https://api.lever.co/v0/postings/lalamove?mode=json&limit=50&skip=0',
  'https://boards-api.greenhouse.io/v1/boards/datsolutions/jobs?content=false',
  'https://apply.workable.com/api/v1/widget/accounts/pikpok',
]

const roots = REGIONAL_SOURCE_FULL_URLS.map(url => url.split('?')[0])
export const isRegionalSourceRequest = (url: string) => roots.some(root =>
  url === root || url.startsWith(`${root}?`) || url.startsWith(`${root}/`))

/** Preserve the historical job cohorts while admitting the six new defaults. */
export function withRegionalSourceEmptyBoards(responses: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    'https://api.ashbyhq.com/posting-api/job-board/halter?includeCompensation=true': { apiVersion: '1', jobs: [] },
    'https://api.ashbyhq.com/posting-api/job-board/halter': { apiVersion: '1', jobs: [] },
    'https://api.ashbyhq.com/posting-api/job-board/partly.com?includeCompensation=true': { apiVersion: '1', jobs: [] },
    'https://api.ashbyhq.com/posting-api/job-board/partly.com': { apiVersion: '1', jobs: [] },
    'https://boards-api.greenhouse.io/v1/boards/pushpay/jobs?content=true&pay_transparency=true': { jobs: [], meta: { total: 0 } },
    'https://boards-api.greenhouse.io/v1/boards/pushpay/jobs?content=false': { jobs: [], meta: { total: 0 } },
    'https://api.lever.co/v0/postings/lalamove?mode=json&limit=50&skip=0': [],
    'https://boards-api.greenhouse.io/v1/boards/datsolutions/jobs?content=true&pay_transparency=true': { jobs: [], meta: { total: 0 } },
    'https://boards-api.greenhouse.io/v1/boards/datsolutions/jobs?content=false': { jobs: [], meta: { total: 0 } },
    'https://apply.workable.com/api/v1/widget/accounts/pikpok?details=true': { name: 'PikPok', jobs: [] },
    'https://apply.workable.com/api/v1/widget/accounts/pikpok': { name: 'PikPok', jobs: [] },
    ...responses,
  }
}
