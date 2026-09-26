import type { Company, Job, SavedJob } from '../../shared/types'

// All employers, IDs, paragraphs and application records in this fixture are
// invented. List pages deliberately omit detail bodies.
export const PRESENCE_NOW = '2026-09-26T03:00:00.000Z'
export const PRESENCE_FETCHED_AT = '2026-09-26T02:00:00.000Z'
export const PRESENCE_SAVED_AT = '2026-09-26T02:05:00.000Z'
export const PRESENCE_RELEASED_AT = '2026-09-25T01:00:00.000Z'
export const PRESENCE_NOTE = '가상 지원 메모: Relay 본문을 따로 확인\n지원 기록 보존 🌱'
export const PRESENCE_ORIGINAL_BODY = 'Responsibilities\nBuild a fictional relay with TypeScript.\n\nMinimum requirements\n3 years of software engineering experience.'
export const PRESENCE_CHANGED_BODY = 'Responsibilities\nBuild a fictional relay with Python and PostgreSQL.\n\nMinimum requirements\n3 years of software engineering experience.'
export const PRESENCE_TITLES = {
  saved: 'Backend Engineer — Harbour Relay',
  changed: 'Staff Backend Engineer — Harbour Relay',
  second: 'Frontend Engineer — Harbour Console',
  outside: 'Account Executive — Harbour Final Page',
  missing: 'Backend Engineer — Harbour Previously Saved',
} as const

export const PRESENCE_REGISTRATION = {
  id: 'presence-harbour', name: 'Harbour Lantern', provider: 'smartrecruiters',
  board: 'HarbourPresence59', careerUrl: 'https://example.com/careers/presence-harbour',
  industry: '가상 수집 검증 도구',
} as const
export const PRESENCE_COMPANY: Company = { ...PRESENCE_REGISTRATION, initials: 'HL', color: '#a79aff' }
export const PRESENCE_BASE_URL = 'https://api.smartrecruiters.com/v1/companies/HarbourPresence59/postings'
export const PRESENCE_PAGE_URLS = [
  'https://api.smartrecruiters.com/v1/companies/HarbourPresence59/postings?limit=100&offset=0&destination=PUBLIC',
  'https://api.smartrecruiters.com/v1/companies/HarbourPresence59/postings?limit=100&offset=100&destination=PUBLIC',
  'https://api.smartrecruiters.com/v1/companies/HarbourPresence59/postings?limit=100&offset=200&destination=PUBLIC',
] as const
export const PRESENCE_DETAIL_URLS = [
  'https://api.smartrecruiters.com/v1/companies/HarbourPresence59/postings/59001',
  'https://api.smartrecruiters.com/v1/companies/HarbourPresence59/postings/59101',
] as const
export const PRESENCE_LEGACY_CSV_HEADERS = [
  '회사', '포지션', '근무지', '데이터', '상태', '저장일', '메모', '채용 링크',
  '연봉', '보상 조건', '보상 근거', '기술 조건', '경력 조건', '기술·경력 근거',
  '공개 게시 상태', '게시 목록 확인 시각', '내용 비교', '저장 내용과 다른 항목',
  '비자 지원', '취업 자격 조건', '취업 자격 근거', '직무 분류', '직무 분류 근거',
  '탐색 직군', '탐색 직군 근거', '저장 내용의 조회 시각', '내보낼 때의 조회 기록', '내보낸 시각',
  '근무지 판단', '원래 게시 위치', '본문의 근무지', '근무지 원문 근거',
  '명시된 원격근무 국가·지역', '원격근무 국가 코드', '원격근무 추가 확인',
  '고용 형태', '고용 형태 근거', '원격근무 지역 판단', '원격근무 지역 원문 근거',
  '모집 유형', '모집 유형 근거', '언어 조건', '언어 조건 근거',
  '시간대·협업 시간', '시간대·협업 시간 근거', '근무 국가', '근무 국가 근거',
] as const

export interface PresenceResponse {
  body?: unknown
  status?: number
  headers?: Record<string, string>
  delayMs?: number
  failure?: string
}
export type PresenceResponses = Record<string, PresenceResponse>
export type PresenceScenario = 'complete' | 'empty' | 'partial-final' | 'duplicate-page'
  | 'total-shift' | 'foreign-company' | 'internal-row' | 'last-page-503' | 'last-page-429' | 'last-page-network'

export function presenceResponses(options: {
  scenario?: PresenceScenario
  changed?: boolean
  firstPageDelayMs?: number
  detailFailure?: boolean
  unpublishedDetail?: 'inactive' | 'internal'
  outsidePrimary?: boolean
} = {}): PresenceResponses {
  const scenario = options.scenario ?? 'complete'
  const summaries = Array.from({ length: 201 }, (_, index) => ({
    id: String(59001 + index),
    name: index === 0 ? options.outsidePrimary ? 'Account Executive — Harbour Relay Outside Scope'
      : options.changed ? PRESENCE_TITLES.changed : PRESENCE_TITLES.saved
      : index === 100 ? PRESENCE_TITLES.second
        : index === 200 ? PRESENCE_TITLES.outside : `Account Executive — Harbour Fictional ${index + 1}`,
    company: { identifier: 'HarbourPresence59' }, visibility: 'PUBLIC',
    releasedDate: PRESENCE_RELEASED_AT,
    location: { city: 'London', country: 'gb', fullLocation: 'London, UK', remote: false, hybrid: false },
    typeOfEmployment: { label: 'Full-time' },
  }))
  const pages = [0, 100, 200].map(offset => ({
    offset, limit: 100, totalFound: 201, content: summaries.slice(offset, offset + 100),
  }))
  if (scenario === 'empty') {
    pages[0].totalFound = 0
    pages[0].content = []
  }
  if (scenario === 'partial-final') pages[2].content = []
  if (scenario === 'duplicate-page') pages[1].content[99] = summaries[0]
  if (scenario === 'total-shift') pages[2].totalFound = 202
  if (scenario === 'foreign-company') pages[2].content[0] = { ...summaries[200], company: { identifier: 'DifferentFictionalBoard' } }
  if (scenario === 'internal-row') pages[2].content[0] = { ...summaries[200], visibility: 'INTERNAL' }
  const responses: PresenceResponses = Object.fromEntries(PRESENCE_PAGE_URLS.map((url, index) => [
    url, { body: pages[index], ...(index === 0 && options.firstPageDelayMs ? { delayMs: options.firstPageDelayMs } : {}) },
  ]))
  if (scenario === 'last-page-503') responses[PRESENCE_PAGE_URLS[2]] = { status: 503, body: { error: 'Fictional board unavailable' } }
  if (scenario === 'last-page-429') responses[PRESENCE_PAGE_URLS[2]] = { status: 429, headers: { 'Retry-After': '600' }, body: { error: 'Fictional board rate limit' } }
  if (scenario === 'last-page-network') responses[PRESENCE_PAGE_URLS[2]] = { failure: 'Fictional final-page connection failure' }
  for (const index of [0, 100]) {
    const summary = summaries[index]
    responses[`${PRESENCE_BASE_URL}/${summary.id}`] = options.detailFailure
      ? { status: 503, body: { error: 'Fictional detail must not be fetched by presence checks' } }
      : { body: {
        ...summary,
        active: !(index === 0 && options.unpublishedDetail === 'inactive'),
        visibility: index === 0 && options.unpublishedDetail === 'internal' ? 'INTERNAL' : 'PUBLIC',
        postingUrl: `https://example.com/jobs/presence-harbour-${summary.id}`,
        jobAd: { sections: {
          jobDescription: {
            title: 'Responsibilities',
            text: `<p>${index === 0 && options.changed ? 'Build a fictional relay with Python and PostgreSQL.' : index === 0 ? 'Build a fictional relay with TypeScript.' : 'Build a fictional console with TypeScript and React.'}</p>`,
          },
          qualifications: { title: 'Minimum requirements', text: '<p>3 years of software engineering experience.</p>' },
        } },
      } }
  }
  return responses
}

/** Explicit old saved inputs; expected display values never use a normalizer. */
export function presenceSaved(): SavedJob[] {
  const job = (id: string, title: string, description: string, role: Job['role'] = 'backend'): Job => ({
    id: `smartrecruiters-presence-harbour-${id}`, companyId: 'presence-harbour',
    title, role, description, cityIds: ['london'], locationLabel: 'London, UK',
    workMode: 'onsite', employment: 'fulltime', minExperience: 3, skills: ['TypeScript'],
    salary: null, visa: 'unknown', remoteCountries: [], remoteWorldwide: false, remoteScopeUnknown: false,
    requirements: ['3 years of software engineering experience.'],
    url: `https://example.com/jobs/presence-harbour-${id}`, source: 'smartrecruiters',
    updatedAt: PRESENCE_RELEASED_AT, fetchedAt: PRESENCE_FETCHED_AT,
  })
  return [
    { job: job('59001', PRESENCE_TITLES.saved, PRESENCE_ORIGINAL_BODY), company: PRESENCE_COMPANY, savedAt: PRESENCE_SAVED_AT, status: 'saved', note: '초기 가상 메모' },
    {
      job: job('59201', PRESENCE_TITLES.outside, 'Responsibilities\nSupport fictional account renewals.', 'unknown'),
      company: PRESENCE_COMPANY, savedAt: PRESENCE_SAVED_AT, status: 'applied', note: '범위 밖 가상 메모',
    },
    {
      job: job('59999', PRESENCE_TITLES.missing, 'Responsibilities\nMaintain a previously saved fictional service.'),
      company: PRESENCE_COMPANY, savedAt: PRESENCE_SAVED_AT, status: 'saved', note: '목록 부재는 종료 확정 아님',
    },
  ]
}

export function presencePagedSaved(): SavedJob[] {
  const original = presenceSaved()[0]
  return Array.from({ length: 13 }, (_, index): SavedJob => index === 0 ? original : {
    ...original,
    job: {
      ...original.job, id: `smartrecruiters-presence-harbour-${59001 + index}`,
      title: `Account Executive — Harbour Fictional ${index + 1}`, role: 'unknown',
      description: 'Responsibilities\nSupport fictional account renewals.',
      url: `https://example.com/jobs/presence-harbour-${59001 + index}`,
    },
    note: `가상 페이지 메모 ${index + 1}`,
  })
}
