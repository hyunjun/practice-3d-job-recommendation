export type Region = 'all' | 'americas' | 'europe' | 'asia-pacific'
export const JOB_ROLES = ['backend', 'frontend', 'fullstack', 'ml', 'data', 'devops', 'mobile', 'security'] as const
export type KnownJobRole = typeof JOB_ROLES[number]
export type Role = 'all' | KnownJobRole
export type JobRole = KnownJobRole | 'unknown'
export type WorkMode = 'remote' | 'hybrid' | 'onsite' | 'unknown'
export type Visa = 'yes' | 'conditional' | 'no' | 'unknown'
export const PUBLIC_PROVIDERS = ['greenhouse', 'ashby', 'lever', 'smartrecruiters', 'workable', 'himalayas'] as const
export type JobProvider = typeof PUBLIC_PROVIDERS[number]
export type JobSource = 'sample' | JobProvider
export type Source = 'sample' | 'public'
export type Employment = 'fulltime' | 'parttime' | 'permanent' | 'contract' | 'intern' | 'temporary' | 'unknown'
export const COMPENSATION_VERSION = 2 as const
export const QUALIFICATIONS_VERSION = 1 as const
export const ELIGIBILITY_VERSION = 2 as const
export const ROLE_CLASSIFICATION_VERSION = 1 as const
export const OCCUPATION_VERSION = 5 as const
export const REMOTE_SCOPE_VERSION = 2 as const
export const EMPLOYMENT_VERSION = 1 as const
export const POSTING_PURPOSE_VERSION = 1 as const
export const LANGUAGE_REQUIREMENTS_VERSION = 1 as const
export const WORK_TIME_REQUIREMENTS_VERSION = 1 as const
export const WORK_TIME_REQUIREMENT_KINDS = ['location', 'collaboration', 'core-hours', 'working-hours', 'overlap'] as const
export type WorkTimeRequirementKind = typeof WORK_TIME_REQUIREMENT_KINDS[number]
export const SPOKEN_LANGUAGE_CODES = ['en', 'ko', 'ja', 'de', 'fr', 'es', 'pt', 'zh', 'cmn', 'yue', 'it', 'nl', 'sv', 'pl', 'ar', 'hi', 'vi', 'id', 'th', 'ms', 'ru', 'da', 'no', 'fi', 'tr', 'he', 'cs', 'ro', 'uk', 'el', 'hu'] as const
export type SpokenLanguageCode = typeof SPOKEN_LANGUAGE_CODES[number]

export const JOB_SOURCE_LABELS: Record<JobSource, string> = {
  sample: '샘플', greenhouse: 'Greenhouse', ashby: 'Ashby', lever: 'Lever', smartrecruiters: 'SmartRecruiters',
  workable: 'Workable', himalayas: 'Himalayas',
}

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
  provider?: JobProvider
  boardRegion?: 'eu'
}

export interface Salary {
  min: number
  max: number
  currency: 'USD' | 'EUR' | 'GBP' | 'CAD' | 'SGD' | 'AUD' | 'KRW' | 'JPY' | 'CHF'
}

export interface CompensationRange {
  label: string
  min: number
  max: number
  currency: string | null
  period: 'year' | 'month' | 'week' | 'day' | 'hour' | 'unknown'
  basis?: 'base' | 'total' | 'unknown'
  scope?: string
  evidence?: FactEvidence
}

export type QualificationKind = 'required' | 'qualification' | 'preferred' | 'context'

export interface SkillRequirement {
  kind: QualificationKind
  skills: string[]
  match: 'all' | 'any' | 'unspecified'
  evidence: FactEvidence
}

export interface ExperienceRequirement {
  kind: QualificationKind
  minYears: number
  maxYears?: number
  conditional: boolean
  evidence: FactEvidence
}

export interface JobQualifications {
  version: typeof QUALIFICATIONS_VERSION
  skills: SkillRequirement[]
  experience: ExperienceRequirement[]
  experienceNote?: string
  truncated?: boolean
}

export interface LanguageRequirement {
  languages: SpokenLanguageCode[]
  kind: Exclude<QualificationKind, 'context'>
  match: 'all' | 'any' | 'unspecified'
  scope?: string
  evidence: FactEvidence & { source: 'description' }
}

export interface JobLanguageRequirements {
  version: typeof LANGUAGE_REQUIREMENTS_VERSION
  rules: LanguageRequirement[]
  truncated?: boolean
}

export interface WorkTimeRequirement {
  kind: WorkTimeRequirementKind
  level: 'required' | 'preferred' | 'stated'
  /** The employer's literal declaration, with no time-zone or DST conversion. */
  statement: string
  scope?: string
  evidence: FactEvidence & { source: 'description' }
}

export interface JobWorkTimeRequirements {
  version: typeof WORK_TIME_REQUIREMENTS_VERSION
  rules: WorkTimeRequirement[]
  truncated?: boolean
}

export type EligibilityKind = 'sponsorship-scope' | 'work-authorization' | 'citizenship' | 'residency' | 'security-clearance' | 'export-authorization'
export type EligibilityLevel = 'required' | 'conditional' | 'preferred' | 'unspecified'

export interface JobEligibility {
  version: 1 | typeof ELIGIBILITY_VERSION
  rules: { kind: EligibilityKind; level: EligibilityLevel; evidence: FactEvidence }[]
  truncated?: boolean
}

export interface JobRoleClassification {
  version: typeof ROLE_CLASSIFICATION_VERSION
  roles: KnownJobRole[]
  evidence: { role: KnownJobRole; source: FactEvidence['source']; text: string }[]
}

export interface JobManagement {
  value: 'individual' | 'management' | 'unknown'
  evidence?: FactEvidence
}

export interface JobOccupation {
  /** Versions 1–4 remain readable in saved records and cached snapshots. */
  version: 1 | 2 | 3 | 4 | typeof OCCUPATION_VERSION
  category: 'engineering' | 'research' | 'support' | 'management' | 'other' | 'unconfirmed'
  evidence: FactEvidence[]
  departments: string[]
  management?: JobManagement
}

export interface JobLocationResolution {
  version: 1
  status: 'relocation' | 'conflict'
  listedCityIds: string[]
  listedLabel: string
  statedCityIds: string[]
  statedLabel: string
  evidence: FactEvidence[]
}

export interface JobRemoteScopeResolution {
  version: 1
  status: 'description' | 'unconfirmed'
  /** Keep the original posting facts separate from countries interpreted from its body. */
  listedCountries: string[]
  listedWorldwide: boolean
  evidence: (FactEvidence & { source: 'description' })[]
  truncated?: boolean
}

export interface JobPostingPurpose {
  version: typeof POSTING_PURPOSE_VERSION
  kind: 'talent-pool'
  basis: 'greenhouse-prospect' | 'description'
  evidence: FactEvidence[]
}

export interface Job {
  id: string
  companyId: string
  title: string
  role: JobRole
  roleClassification?: JobRoleClassification
  occupation?: JobOccupation
  postingPurpose?: JobPostingPurpose
  cityIds: string[]
  locationLabel: string
  workplaceLocations?: {
    version: 1
    locations: { label: string; country?: string }[]
    truncated?: boolean
  }
  locationResolution?: JobLocationResolution
  workMode: WorkMode
  employment: Employment
  employmentVersion?: typeof EMPLOYMENT_VERSION
  minExperience: number | null
  skills: string[]
  qualifications?: JobQualifications
  languageRequirements?: JobLanguageRequirements
  workTimeRequirements?: JobWorkTimeRequirements
  salary: Salary | null
  compensationRanges?: CompensationRange[]
  compensationNote?: string
  compensationEvidence?: FactEvidence[]
  compensationVersion?: 1 | typeof COMPENSATION_VERSION
  visa: Visa
  eligibility?: JobEligibility
  remoteCountries: string[]
  remoteWorldwide: boolean
  remoteScopeUnknown: boolean
  remoteRegions?: Exclude<Region, 'all'>[]
  remoteScopeVersion?: 1 | typeof REMOTE_SCOPE_VERSION
  remoteScopeResolution?: JobRemoteScopeResolution
  description: string
  requirements: string[]
  url: string
  source: JobSource
  updatedAt: string | null
  fetchedAt: string
  evidence?: JobEvidence
  stale?: boolean
}

export interface BoardStatus {
  companyId: string
  board: string
  provider?: JobProvider
  status: 'ok' | 'error' | 'pending'
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
  /** Non-remote jobs without mapped cities, including records omitted by legacy snapshots. */
  unmappedCount: number | null
  checkedAt?: string
  refreshAfter?: string
}

export interface Profile {
  kind: 'sample' | 'personal'
  name: string
  headline: string
  years: number | null
  skills: string[]
  desiredRole: Role
  residence: string
  linkedinUrl: string
  preferences?: Pick<Filters, 'workMode' | 'visa' | 'salaryMin'>
}

export interface Filters {
  query: string
  region: Region
  role: Role | 'unknown'
  workMode: 'all' | WorkMode
  visa: 'all' | 'yes' | 'supported' | 'possible'
  employment: 'all' | Employment
  postingType: 'opening' | 'talent-pool' | 'all'
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
  skillSummary: string
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

export const ROLE_FILTER_LABELS: Record<Filters['role'], string> = {
  ...ROLE_LABELS, unknown: '세부 직무 미확인',
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
  americas: '미주',
  europe: '유럽',
  'asia-pacific': '아시아 · 태평양',
}

export const EMPLOYMENT_LABELS: Record<Employment | 'all', string> = {
  all: '모든 고용 형태',
  fulltime: '풀타임',
  parttime: '파트타임',
  permanent: '기간 제한 없음',
  contract: '계약직',
  intern: '인턴',
  temporary: '임시직',
  unknown: '고용 형태 미확인',
}

export const POSTING_TYPE_LABELS: Record<Filters['postingType'], string> = {
  opening: '일반 채용 공고',
  'talent-pool': '인재풀·관심 등록',
  all: '일반 공고·인재풀 모두',
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

export const QUALIFICATION_LABELS: Record<QualificationKind, string> = {
  required: '필수로 명시',
  qualification: '자격 항목',
  preferred: '우대 사항',
  context: '업무·본문 언급',
}

export const ELIGIBILITY_LABELS: Record<EligibilityKind, string> = {
  'sponsorship-scope': '비자 지원 적용 범위', 'work-authorization': '취업 허가',
  citizenship: '국적·시민권', residency: '거주 요건',
  'security-clearance': '보안 인가', 'export-authorization': '수출 통제 자격',
}

export const ELIGIBILITY_LEVEL_LABELS: Record<EligibilityLevel, string> = {
  required: '필수로 명시', conditional: '적용 조건 확인', preferred: '우대 사항', unspecified: '원문 확인',
}

export { COUNTRY_OPTIONS as COUNTRIES } from './countries'

// Indicative, fixed conversion factors. Never represented as live FX quotes.
export const USD_RATES: Record<Salary['currency'], number> = {
  USD: 1, EUR: 1.1, GBP: 1.3, CAD: 0.73, SGD: 0.77,
  AUD: 0.67, KRW: 0.00073, JPY: 0.0068, CHF: 1.16,
}

export const DEFAULT_FILTERS: Filters = {
  query: '', region: 'all', role: 'all', workMode: 'all', visa: 'all',
  employment: 'all', postingType: 'opening', salaryMin: 0, includeUnknownSalary: true, remoteEligibleOnly: true,
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
