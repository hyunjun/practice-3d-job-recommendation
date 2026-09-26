import type { Company, Filters, Job, Profile } from '../../shared/types'

// Registration facts are literal contract inputs. Every posting, paragraph and
// application URL below is invented; no employer description was copied.
export const ORIGINAL_PUBLIC_REGISTRATIONS: Company[] = [
  { id: 'stripe', name: 'Stripe', initials: 'S', color: '#a79aff', industry: '핀테크 · 결제 인프라', careerUrl: 'https://stripe.com/jobs', board: 'stripe', provider: 'greenhouse' },
  { id: 'figma', name: 'Figma', initials: 'F', color: '#ff9c78', industry: '디자인 · 협업 도구', careerUrl: 'https://www.figma.com/careers/', board: 'figma', provider: 'greenhouse' },
  { id: 'vercel', name: 'Vercel', initials: '▲', color: '#f4f4f4', industry: '클라우드 · 개발자 도구', careerUrl: 'https://vercel.com/careers', board: 'vercel', provider: 'greenhouse' },
  { id: 'cloudflare', name: 'Cloudflare', initials: 'C', color: '#ffa75a', industry: '인프라 · 보안', careerUrl: 'https://www.cloudflare.com/careers/', board: 'cloudflare', provider: 'greenhouse' },
  { id: 'datadog', name: 'Datadog', initials: 'D', color: '#bb9dfb', industry: '클라우드 · 모니터링', careerUrl: 'https://careers.datadoghq.com/', board: 'datadog', provider: 'greenhouse' },
  { id: 'mongodb', name: 'MongoDB', initials: 'M', color: '#84dba6', industry: '데이터베이스', careerUrl: 'https://www.mongodb.com/careers', board: 'mongodb', provider: 'greenhouse' },
  { id: 'airbnb', name: 'Airbnb', initials: 'A', color: '#ff929b', industry: '여행 · 마켓플레이스', careerUrl: 'https://careers.airbnb.com/', board: 'airbnb', provider: 'greenhouse' },
  { id: 'gitlab', name: 'GitLab', initials: 'G', color: '#fbb384', industry: '개발자 도구 · DevSecOps', careerUrl: 'https://about.gitlab.com/jobs/', board: 'gitlab', provider: 'greenhouse' },
  { id: 'anthropic', name: 'Anthropic', initials: 'A', color: '#d9b79f', industry: 'AI · 연구', careerUrl: 'https://www.anthropic.com/careers', board: 'anthropic', provider: 'greenhouse' },
  { id: 'intercom', name: 'Intercom', initials: 'I', color: '#91bafd', industry: 'AI · 고객 경험', careerUrl: 'https://www.intercom.com/careers', board: 'intercom', provider: 'greenhouse' },
  { id: 'asana', name: 'Asana', initials: 'A', color: '#f6a7aa', industry: '업무 관리 · 협업', careerUrl: 'https://asana.com/jobs', provider: 'greenhouse', board: 'asana' },
  { id: 'linear', name: 'Linear', initials: 'L', color: '#a4a3ff', industry: '개발자 도구', careerUrl: 'https://linear.app/careers', provider: 'ashby', board: 'Linear' },
  { id: 'deepl', name: 'DeepL', initials: 'D', color: '#a1c3e1', industry: 'AI · 언어 기술', careerUrl: 'https://www.deepl.com/en/careers', provider: 'ashby', board: 'DeepL' },
  { id: 'n8n', name: 'n8n', initials: 'n', color: '#f5a193', industry: '자동화 · 개발자 도구', careerUrl: 'https://n8n.io/careers/', provider: 'ashby', board: 'n8n' },
  { id: 'supabase', name: 'Supabase', initials: 'S', color: '#90deb8', industry: '데이터베이스 · 개발자 도구', careerUrl: 'https://supabase.com/careers', provider: 'ashby', board: 'supabase' },
  { id: 'mistral', name: 'Mistral AI', initials: 'M', color: '#f0ad7f', industry: 'AI · 언어 모델', careerUrl: 'https://mistral.ai/careers/', provider: 'ashby', board: 'mistral.ai' },
  { id: 'jane', name: 'Jane', initials: 'J', color: '#83d1c7', industry: '헬스케어 · 진료 관리', careerUrl: 'https://jane.app/careers', provider: 'ashby', board: 'jane' },
  { id: 'spotify', name: 'Spotify', initials: 'S', color: '#72df99', industry: '오디오 · 미디어', careerUrl: 'https://www.lifeatspotify.com/jobs', provider: 'lever', board: 'spotify' },
  { id: 'contentsquare', name: 'Contentsquare', initials: 'C', color: '#f5bd83', industry: '디지털 경험 · 제품 분석', careerUrl: 'https://contentsquare.com/careers/', provider: 'lever', board: 'contentsquare' },
  { id: 'canva', name: 'Canva', initials: 'C', color: '#7fdde1', industry: '디자인 · 크리에이티브', careerUrl: 'https://www.lifeatcanva.com/en/jobs/', provider: 'smartrecruiters', board: 'Canva' },
  { id: 'grab', name: 'Grab', initials: 'G', color: '#91dc9e', industry: '모빌리티 · 플랫폼', careerUrl: 'https://www.grab.careers/en/', provider: 'smartrecruiters', board: 'Grab' },
  { id: 'wise', name: 'Wise', initials: 'W', color: '#b3e582', industry: '핀테크 · 글로벌 송금', careerUrl: 'https://wise.jobs/', provider: 'smartrecruiters', board: 'Wise' },
]

export const ADDED_PUBLIC_REGISTRATIONS: Company[] = [
  { id: 'moloco', name: 'Moloco', initials: 'M', color: '#e8b283', industry: 'AI · 광고 기술', careerUrl: 'https://www.moloco.com/company/careers', provider: 'greenhouse', board: 'moloco' },
  { id: 'sendbird', name: 'Delight.ai (Sendbird)', initials: 'D', color: '#b6d9a2', industry: 'AI · 고객 경험', careerUrl: 'https://delight.ai/careers', provider: 'greenhouse', board: 'sendbird' },
]

// Independent registration facts, including the canonical career-page URLs.
// Display styling is not part of the added board-identity contract.
export const EXPANDED_PUBLIC_REGISTRATIONS: Pick<Company, 'id' | 'name' | 'careerUrl' | 'provider' | 'board'>[] = [
  { id: 'openai', name: 'OpenAI', careerUrl: 'https://openai.com/careers/', provider: 'ashby', board: 'openai' },
  { id: 'notion', name: 'Notion', careerUrl: 'https://www.notion.com/careers', provider: 'ashby', board: 'notion' },
  { id: 'reddit', name: 'Reddit', careerUrl: 'https://redditinc.com/careers', provider: 'greenhouse', board: 'reddit' },
  { id: 'discord', name: 'Discord', careerUrl: 'https://discord.com/careers', provider: 'greenhouse', board: 'discord' },
  { id: 'coinbase', name: 'Coinbase', careerUrl: 'https://www.coinbase.com/careers', provider: 'greenhouse', board: 'coinbase' },
  { id: 'dropbox', name: 'Dropbox', careerUrl: 'https://www.dropbox.jobs/', provider: 'greenhouse', board: 'dropbox' },
  { id: 'duolingo', name: 'Duolingo', careerUrl: 'https://careers.duolingo.com/', provider: 'greenhouse', board: 'duolingo' },
  { id: 'roblox', name: 'Roblox', careerUrl: 'https://careers.roblox.com/', provider: 'greenhouse', board: 'roblox' },
  { id: 'spacex', name: 'SpaceX', careerUrl: 'https://www.spacex.com/careers/', provider: 'greenhouse', board: 'spacex' },
  { id: 'pinterest', name: 'Pinterest', careerUrl: 'https://www.pinterestcareers.com/', provider: 'greenhouse', board: 'pinterest' },
  { id: 'databricks', name: 'Databricks', careerUrl: 'https://www.databricks.com/company/careers', provider: 'greenhouse', board: 'databricks' },
  { id: 'robinhood', name: 'Robinhood', careerUrl: 'https://careers.robinhood.com/', provider: 'greenhouse', board: 'robinhood' },
]

export const COVERAGE_UPDATED_AT = '2026-09-19T08:00:00.000Z'
export const COVERAGE_NOTE = '가상 지원 메모: 두 브랜드 이름과 원문 출처를 함께 확인\n서울 팀 질문 준비 🌱'
export const COVERAGE_TITLES = {
  stripe: 'Backend Engineer — 가상 기존 서울 서비스',
  moloco: 'Backend Engineer — 가상 서울 플랫폼',
  pool: 'Backend Engineer — 가상 미래 기회 등록',
  sendbird: 'Backend Engineer — 가상 서울 대화 API',
  frontend: 'Frontend Engineer — 가상 서울 지원 도구',
} as const
export const COVERAGE_POOL_PARAGRAPH = 'This synthetic posting collects profiles for future software engineering opportunities; it is not for a currently open position.'
export const COVERAGE_QUALIFICATIONS = 'Qualifications: 3 years of software engineering experience with TypeScript and PostgreSQL.'
export const COVERAGE_SENDBIRD_SOURCE_URL = 'https://sendbird.com/careers?gh_jid=44201'
export const COVERAGE_SENDBIRD_JOB_URL = 'https://delight.ai/job/44201'
const ordinaryParagraph = 'Synthetic regression fixture: build and maintain backend software services in Seoul.'

export function coverageGreenhouseRaw(id: number, title: string, company: string, overrides: Record<string, unknown> = {}) {
  return {
    id, internal_job_id: id + 100_000, title,
    absolute_url: `https://example.com/synthetic/${company}-${id}`,
    updated_at: COVERAGE_UPDATED_AT, location: { name: 'Seoul, South Korea' },
    content: `<p>${ordinaryParagraph}</p><p>${COVERAGE_QUALIFICATIONS}</p>`,
    departments: [{ name: 'Engineering' }],
    metadata: [{ name: 'Employment Type', value: 'Full-time' }, { name: 'Workplace Type', value: 'Onsite' }],
    ...overrides,
  }
}

export const COVERAGE_NEW_URLS = [
  'https://boards-api.greenhouse.io/v1/boards/moloco/jobs?content=true&pay_transparency=true',
  'https://boards-api.greenhouse.io/v1/boards/sendbird/jobs?content=true&pay_transparency=true',
] as const

export const COVERAGE_EXPANSION_URLS = [
  'https://api.ashbyhq.com/posting-api/job-board/openai?includeCompensation=true',
  'https://api.ashbyhq.com/posting-api/job-board/notion?includeCompensation=true',
  'https://boards-api.greenhouse.io/v1/boards/reddit/jobs?content=true&pay_transparency=true',
  'https://boards-api.greenhouse.io/v1/boards/discord/jobs?content=true&pay_transparency=true',
  'https://boards-api.greenhouse.io/v1/boards/coinbase/jobs?content=true&pay_transparency=true',
  'https://boards-api.greenhouse.io/v1/boards/dropbox/jobs?content=true&pay_transparency=true',
  'https://boards-api.greenhouse.io/v1/boards/duolingo/jobs?content=true&pay_transparency=true',
  'https://boards-api.greenhouse.io/v1/boards/roblox/jobs?content=true&pay_transparency=true',
  'https://boards-api.greenhouse.io/v1/boards/spacex/jobs?content=true&pay_transparency=true',
  'https://boards-api.greenhouse.io/v1/boards/pinterest/jobs?content=true&pay_transparency=true',
  'https://boards-api.greenhouse.io/v1/boards/databricks/jobs?content=true&pay_transparency=true',
  'https://boards-api.greenhouse.io/v1/boards/robinhood/jobs?content=true&pay_transparency=true',
] as const

/** Only exact upstream requests in this independent map can receive a response. */
export function publicCoverageResponses(): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const board of ['stripe', 'figma', 'vercel', 'cloudflare', 'datadog', 'mongodb', 'airbnb', 'gitlab', 'anthropic', 'intercom', 'asana',
    'reddit', 'discord', 'coinbase', 'dropbox', 'duolingo', 'roblox', 'spacex', 'pinterest', 'databricks', 'robinhood']) {
    result[`https://boards-api.greenhouse.io/v1/boards/${board}/jobs?content=true&pay_transparency=true`] = { jobs: [], meta: { total: 0 } }
  }
  for (const board of ['Linear', 'DeepL', 'n8n', 'supabase', 'mistral.ai', 'jane', 'openai', 'notion']) {
    result[`https://api.ashbyhq.com/posting-api/job-board/${board}?includeCompensation=true`] = { apiVersion: '1', jobs: [] }
  }
  for (const board of ['spotify', 'contentsquare']) {
    result[`https://api.lever.co/v0/postings/${board}?mode=json&limit=50&skip=0`] = []
  }
  for (const board of ['Canva', 'Grab', 'Wise']) {
    result[`https://api.smartrecruiters.com/v1/companies/${board}/postings?limit=100&offset=0&destination=PUBLIC`] = {
      offset: 0, limit: 100, totalFound: 0, content: [],
    }
  }
  result['https://boards-api.greenhouse.io/v1/boards/stripe/jobs?content=true&pay_transparency=true'] = {
    jobs: [coverageGreenhouseRaw(44001, COVERAGE_TITLES.stripe, 'stripe')], meta: { total: 1 },
  }
  result[COVERAGE_NEW_URLS[0]] = {
    jobs: [
      coverageGreenhouseRaw(44101, COVERAGE_TITLES.moloco, 'moloco'),
      coverageGreenhouseRaw(44102, COVERAGE_TITLES.pool, 'moloco', {
        internal_job_id: null,
        content: `<p>${COVERAGE_POOL_PARAGRAPH}</p><p>${COVERAGE_QUALIFICATIONS}</p>`,
      }),
      coverageGreenhouseRaw(44103, 'Account Executive — 가상 광고 영업', 'moloco', {
        departments: [{ name: 'Sales' }], content: '<p>Synthetic fixture: manage advertising accounts and customer contracts.</p>',
      }),
    ],
    meta: { total: 3 },
  }
  result[COVERAGE_NEW_URLS[1]] = {
    jobs: [
      coverageGreenhouseRaw(44201, COVERAGE_TITLES.sendbird, 'sendbird', {
        absolute_url: COVERAGE_SENDBIRD_SOURCE_URL,
      }),
      coverageGreenhouseRaw(44202, COVERAGE_TITLES.frontend, 'sendbird', {
        absolute_url: 'https://sendbird.com/careers?gh_jid=44202',
        content: '<p>Synthetic fixture: develop frontend interfaces in Seoul using React and TypeScript.</p><p>Qualifications: 3 years of software engineering experience.</p>',
      }),
      coverageGreenhouseRaw(44203, 'Office Administrator — 가상 사무 지원', 'sendbird', {
        departments: [{ name: 'Operations' }], content: '<p>Synthetic fixture: coordinate office supplies and meeting calendars.</p>',
      }),
    ],
    meta: { total: 3 },
  }
  return result
}

export const COVERAGE_PROFILE: Profile = {
  kind: 'personal', name: '가상 서울 지원자', headline: 'Backend Engineer', desiredRole: 'backend',
  years: 5, skills: ['TypeScript', 'PostgreSQL'], residence: 'KR', linkedinUrl: '',
}
export const COVERAGE_FILTERS: Filters = {
  query: '', region: 'all', role: 'all', workMode: 'all', visa: 'all', employment: 'all',
  postingType: 'opening', salaryMin: 0, includeUnknownSalary: true, remoteEligibleOnly: true,
}

/** Literal old default snapshot: source age and facts must survive expansion. */
export function coverageLegacyCache(fetchedAt: string) {
  const job: Job = {
    id: 'greenhouse-stripe-44001', companyId: 'stripe', title: COVERAGE_TITLES.stripe,
    role: 'backend', cityIds: ['seoul'], locationLabel: 'Seoul, South Korea', workMode: 'onsite',
    employment: 'fulltime', minExperience: 3, skills: ['TypeScript', 'PostgreSQL'], salary: null, visa: 'unknown',
    remoteCountries: [], remoteWorldwide: false, remoteScopeUnknown: false, remoteScopeVersion: 2,
    description: `${ordinaryParagraph}\n\n${COVERAGE_QUALIFICATIONS}`, requirements: [],
    url: 'https://example.com/synthetic/stripe-44001', source: 'greenhouse',
    fetchedAt, updatedAt: COVERAGE_UPDATED_AT,
  }
  return {
    version: 5,
    boards: ORIGINAL_PUBLIC_REGISTRATIONS.map(company => ({
      companyId: company.id, provider: company.provider!, board: company.board!,
      checkedAt: fetchedAt, failures: 0, retryAt: null,
      snapshot: {
        fetchedAt, jobs: company.id === 'stripe' ? [job] : [], total: company.id === 'stripe' ? 1 : 0,
        unmappedCount: 0, publishedIds: company.id === 'stripe' ? ['greenhouse-stripe-44001'] : [],
      },
    })),
  }
}
