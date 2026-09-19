export type Region = 'all' | 'americas' | 'europe' | 'asia-pacific'
export type Role = 'all' | 'backend' | 'frontend' | 'fullstack' | 'ml' | 'data' | 'devops' | 'mobile' | 'security'
export type WorkMode = 'remote' | 'hybrid' | 'onsite' | 'unknown'
export type Visa = 'yes' | 'conditional' | 'no' | 'unknown'
export type Source = 'sample' | 'greenhouse'
export type Employment = 'fulltime' | 'parttime' | 'contract' | 'intern' | 'temporary' | 'unknown'

export interface FactEvidence {
  source: 'board' | 'description' | 'title'
  text: string
}

export type JobEvidence = Partial<Record<'visa' | 'workMode' | 'employment', FactEvidence>>

export interface City {
  id: string
  name: string
  en: string
  country: string
  countryCode: string
  region: Exclude<Region, 'all'>
  lat: number
  lng: number
  timezone: string
  description: string
  image?: string
}

export interface Company {
  id: string
  name: string
  color: string
  initials: string
  industry: string
  careerUrl: string
  board?: string
}

export interface Salary {
  min: number
  max: number
  currency: 'USD' | 'EUR' | 'GBP' | 'CAD' | 'SGD' | 'AUD' | 'KRW' | 'JPY' | 'CHF'
}

export interface Job {
  id: string
  companyId: string
  title: string
  role: Exclude<Role, 'all'>
  cityIds: string[]
  locationLabel: string
  workMode: WorkMode
  employment: Employment
  minExperience: number | null
  skills: string[]
  salary: Salary | null
  visa: Visa
  remoteCountries: string[]
  remoteWorldwide: boolean
  remoteScopeUnknown: boolean
  description: string
  requirements: string[]
  url: string
  source: Source
  updatedAt: string | null
  fetchedAt: string
  evidence?: JobEvidence
  stale?: boolean
}

export interface BoardStatus {
  companyId: string
  board: string
  status: 'ok' | 'error'
  total: number
  included: number
  message?: string
  dataStatus?: 'fresh' | 'stale' | 'unavailable'
  checkedAt?: string
  lastSuccessAt?: string | null
  retryAt?: string | null
}

export interface Catalog {
  source: Source
  fetchedAt: string
  stale: boolean
  companies: Company[]
  cities: City[]
  jobs: Job[]
  boards: BoardStatus[]
  unmappedCount: number | null
  checkedAt?: string
  refreshAfter?: string
}

export interface Profile {
  kind: 'sample' | 'personal'
  name: string
  headline: string
  years: number
  skills: string[]
  desiredRole: Role
  residence: string
  linkedinUrl: string
  preferences?: Pick<Filters, 'workMode' | 'visa' | 'salaryMin'>
}

export interface Filters {
  query: string
  region: Region
  role: Role
  workMode: 'all' | WorkMode
  visa: 'all' | 'yes' | 'supported' | 'possible'
  employment: 'all' | Employment
  salaryMin: number
  includeUnknownSalary: boolean
  remoteEligibleOnly: boolean
}

export interface MatchedJob {
  job: Job
  company: Company
  score: number
  matchedSkills: string[]
  missingSkills: string[]
  reasons: string[]
  cautions: string[]
}

export interface CityResult {
  city: City
  matches: MatchedJob[]
  companyCount: number
  averageScore: number
}

export interface SavedJob {
  job: Job
  company: Company
  savedAt: string
  status: 'saved' | 'applied'
  note: string
}

export const ROLE_LABELS: Record<Role, string> = {
  all: '모든 개발 직무',
  backend: '백엔드',
  frontend: '프론트엔드',
  fullstack: '풀스택',
  ml: 'AI · 머신러닝',
  data: '데이터 엔지니어링',
  devops: '인프라 · DevOps',
  mobile: '모바일',
  security: '보안',
}

export const MODE_LABELS: Record<WorkMode | 'all', string> = {
  all: '모든 근무 형태',
  remote: '원격근무',
  hybrid: '하이브리드',
  onsite: '오피스 근무',
  unknown: '근무 형태 미확인',
}

export const REGION_LABELS: Record<Region, string> = {
  all: '전 세계',
  americas: '북미',
  europe: '유럽',
  'asia-pacific': '아시아 · 태평양',
}

export const EMPLOYMENT_LABELS: Record<Employment | 'all', string> = {
  all: '모든 고용 형태',
  fulltime: '풀타임',
  parttime: '파트타임',
  contract: '계약직',
  intern: '인턴',
  temporary: '임시직',
  unknown: '고용 형태 미확인',
}

export const VISA_LABELS: Record<Visa, string> = {
  yes: '지원 명시',
  conditional: '조건부 지원 명시',
  no: '지원 없음',
  unknown: '확인 필요',
}

export const VISA_FILTER_LABELS: Record<Filters['visa'], string> = {
  all: '비자 지원 무관',
  supported: '지원 명시 · 조건부 포함',
  yes: '지원 명시 · 조건부 제외',
  possible: '미확인 공고도 포함',
}

export const FACT_LABELS: Record<keyof JobEvidence, string> = {
  visa: '비자 지원',
  workMode: '근무 형태',
  employment: '고용 형태',
}

export const COUNTRIES = [
  ['KR', '대한민국'], ['US', '미국'], ['CA', '캐나다'], ['GB', '영국'],
  ['DE', '독일'], ['NL', '네덜란드'], ['FR', '프랑스'], ['IE', '아일랜드'],
  ['SE', '스웨덴'], ['CH', '스위스'], ['ES', '스페인'], ['PT', '포르투갈'],
  ['SG', '싱가포르'], ['JP', '일본'], ['AU', '호주'], ['IN', '인도'],
] as const

// Indicative, fixed conversion factors. Never represented as live FX quotes.
export const USD_RATES: Record<Salary['currency'], number> = {
  USD: 1, EUR: 1.1, GBP: 1.3, CAD: 0.73, SGD: 0.77,
  AUD: 0.67, KRW: 0.00073, JPY: 0.0068, CHF: 1.16,
}

export const DEFAULT_FILTERS: Filters = {
  query: '', region: 'all', role: 'all', workMode: 'all', visa: 'all',
  employment: 'all', salaryMin: 0, includeUnknownSalary: true, remoteEligibleOnly: true,
}

export const SAMPLE_PROFILE: Profile = {
  kind: 'sample',
  name: 'Alex Kim',
  headline: 'Software Engineer',
  years: 5,
  skills: ['TypeScript', 'React', 'Node.js', 'Python', 'AWS', 'PostgreSQL'],
  desiredRole: 'all',
  residence: 'KR',
  linkedinUrl: '',
}
