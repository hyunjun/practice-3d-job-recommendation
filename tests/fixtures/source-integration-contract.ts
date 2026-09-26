import type { Company } from '../../shared/types'

// Literal approved identity facts. Career-page display URLs are deliberately
// not invented; the three verified Workable overrides are asserted separately.
export const INTEGRATION_REGISTRATIONS = [
  { id: 'microsoft', name: 'Microsoft', provider: 'himalayas', board: 'microsoft' },
  { id: 'adobe', name: 'Adobe', provider: 'himalayas', board: 'adobe' },
  { id: 'salesforce', name: 'Salesforce', provider: 'himalayas', board: 'salesforce' },
  { id: 'cisco', name: 'Cisco', provider: 'himalayas', board: 'cisco' },
  { id: 'qualcomm', name: 'Qualcomm', provider: 'himalayas', board: 'qualcomm' },
  { id: 'broadcom', name: 'Broadcom', provider: 'himalayas', board: 'broadcom' },
  { id: 'redhat', name: 'Red Hat', provider: 'himalayas', board: 'red-hat' },
  { id: 'hugging-face', name: 'Hugging Face', provider: 'workable', board: 'huggingface' },
  { id: 'smartnews', name: 'SmartNews', provider: 'workable', board: 'smartnews' },
  { id: 'mercari', name: 'Mercari', provider: 'workable', board: 'mercari' },
] satisfies Pick<Company, 'id' | 'name' | 'provider' | 'board'>[]

export const INTEGRATION_DEFAULT_IDS = [
  'hugging-face', 'smartnews', 'mercari',
  'microsoft', 'adobe', 'salesforce', 'cisco', 'qualcomm', 'broadcom', 'redhat',
]

export const INTEGRATION_NOW = '2026-10-01T23:40:00.000Z'
export const INTEGRATION_OLD_AT = '2026-10-01T23:39:55.000Z'
export const INTEGRATION_NOTE = 'Stage63 원문 출처와 거주 조건 확인\ncafé · 메모 보존 🌏'
export const HIMALAYAS_CREDIT_URL = 'https://himalayas.app'
export const WORKABLE_CAREER_URLS = {
  'hugging-face': 'https://huggingface.co/JOIN-US',
  smartnews: 'https://careers.smartnews.com/en/',
  mercari: 'https://careers.mercari.com/jobs/',
} as const
export const HIMALAYAS_BODY = 'Responsibilities\nBuild a fictional API with TypeScript.\n\nQualifications\n3 years of software engineering experience with PostgreSQL.'
export const HIMALAYAS_CHANGED_BODY = 'Responsibilities\nBuild a fictional API with TypeScript.\n\nQualifications\n3 years of software engineering experience with PostgreSQL.\n\nAdditional information\nThe fictional project is called Cedar Two.'
export const HIMALAYAS_CHANGED_TITLE = 'Backend Engineer — Synthetic Cedar API63 Revised'

// These GUID hashes were independently calculated once with standard SHA256,
// then frozen. No product normalizer, identity helper or URL function is used
// to calculate an expected value while a test runs.
export const INTEGRATION_JOBS = [
  {
    companyId: 'microsoft', source: 'himalayas',
    id: 'himalayas-microsoft-70eecd3ec601cdc5f4ecb1750bf585e529f95296f170a59abec71bc88be82cdf',
    title: 'Backend Engineer — Synthetic Cedar API63', role: 'backend',
    url: 'https://himalayas.app/companies/microsoft/jobs/synthetic-cedar-api63',
    locationLabel: 'South Korea · Remote · 시간대 조건 확인',
    cityIds: [], workMode: 'remote', remoteCountries: ['KR'], remoteWorldwide: false, remoteScopeUnknown: false,
  },
  {
    companyId: 'adobe', source: 'himalayas',
    id: 'himalayas-adobe-632803a5fd5cef2ab80ac44140cae076225c6fe7a3ab3c851e7656ab824bf6b3',
    title: 'Frontend Engineer — Synthetic Iris Editor63', role: 'frontend',
    url: 'https://himalayas.app/companies/adobe/jobs/synthetic-iris-editor63',
    locationLabel: '거주 국가 미확인 · Remote · 시간대 조건 확인',
    cityIds: [], workMode: 'remote', remoteCountries: [], remoteWorldwide: false, remoteScopeUnknown: true,
  },
  {
    companyId: 'salesforce', source: 'himalayas',
    id: 'himalayas-salesforce-0e962f389a9945fe1d0ea45feb03600bed70c9322e066d59034b473d1b194869',
    title: 'Backend Engineer — Synthetic Maple Cloud63', role: 'backend',
    url: 'https://himalayas.app/companies/salesforce/jobs/synthetic-maple-cloud63',
    locationLabel: 'Worldwide · Remote',
    cityIds: [], workMode: 'remote', remoteCountries: [], remoteWorldwide: true, remoteScopeUnknown: false,
  },
  {
    companyId: 'cisco', source: 'himalayas',
    id: 'himalayas-cisco-72066c0c7da409468d969c156bd80a890a35f2d966affc86a321e62f755f784f',
    title: 'Backend Engineer — Synthetic Harbor Network63', role: 'backend',
    url: 'https://himalayas.app/companies/cisco/jobs/synthetic-harbor-network63',
    locationLabel: 'United States · Canada · Remote',
    cityIds: [], workMode: 'remote', remoteCountries: ['US', 'CA'], remoteWorldwide: false, remoteScopeUnknown: false,
  },
  {
    companyId: 'qualcomm', source: 'himalayas',
    id: 'himalayas-qualcomm-05e1d0c5a85f34d15f83d806ec3ae7aee28b521f156cebb0709380a2bef99cb8',
    title: 'Backend Engineer — Synthetic Orchid Runtime63', role: 'backend',
    url: 'https://himalayas.app/companies/qualcomm/jobs/synthetic-orchid-runtime63',
    locationLabel: 'India · Remote',
    cityIds: [], workMode: 'remote', remoteCountries: ['IN'], remoteWorldwide: false, remoteScopeUnknown: false,
  },
  {
    companyId: 'broadcom', source: 'himalayas',
    id: 'himalayas-broadcom-91a121a5b2c01e8bc4b24da9796b06b82750596aa0d238738c0ecab1c13d40bc',
    title: 'Backend Engineer — Synthetic Slate Storage63', role: 'backend',
    url: 'https://himalayas.app/companies/broadcom/jobs/synthetic-slate-storage63',
    locationLabel: 'Germany · Remote',
    cityIds: [], workMode: 'remote', remoteCountries: ['DE'], remoteWorldwide: false, remoteScopeUnknown: false,
  },
  {
    companyId: 'redhat', source: 'himalayas',
    id: 'himalayas-redhat-e1ae48b0b1ae0af580cfd888b8e68c63906472cb93fed5922aa110ec17834acb',
    title: 'Backend Engineer — Synthetic Willow Linux63', role: 'backend',
    url: 'https://himalayas.app/companies/red-hat/jobs/synthetic-willow-linux63',
    locationLabel: 'Worldwide · Remote',
    cityIds: [], workMode: 'remote', remoteCountries: [], remoteWorldwide: true, remoteScopeUnknown: false,
  },
  {
    companyId: 'hugging-face', source: 'workable', id: 'workable-hugging-face-HF63REMOTE',
    title: 'Backend Engineer — Synthetic Fern Model63', role: 'backend',
    url: 'https://apply.workable.com/j/HF63REMOTE/',
    locationLabel: 'France · Remote',
    cityIds: [], workMode: 'remote', remoteCountries: ['FR'], remoteWorldwide: false, remoteScopeUnknown: false,
  },
  {
    companyId: 'smartnews', source: 'workable', id: 'workable-smartnews-SN63HIDDEN',
    title: 'Backend Engineer — Synthetic Birch News63', role: 'backend',
    url: 'https://apply.workable.com/j/SN63HIDDEN/',
    locationLabel: '근무지 미확인',
    cityIds: [], workMode: 'unknown',
  },
  {
    companyId: 'mercari', source: 'workable', id: 'workable-mercari-MC63TOKYO',
    title: 'Backend Engineer — Synthetic Elm Market63', role: 'backend',
    url: 'https://apply.workable.com/j/MC63TOKYO/',
    locationLabel: 'Tokyo, Japan',
    cityIds: ['tokyo'], workMode: 'unknown',
  },
] as const

export const MICROSOFT_PUBLISHED_IDS = [
  'himalayas-microsoft-70eecd3ec601cdc5f4ecb1750bf585e529f95296f170a59abec71bc88be82cdf',
  'himalayas-microsoft-a0bd6c8e39d48864e241117d96d10bb1b5b2c27cdfdff2625d138859dcf3bbc7',
]
export const MICROSOFT_EXPIRED_ID = 'himalayas-microsoft-a41088ccae44b2080dd18fae667931a18377628a73bdc64178647ee4444e52ea'

export const INTEGRATION_FULL_URLS = [
  'https://himalayas.app/jobs/api/search?company=microsoft&sort=recent&page=1',
  'https://himalayas.app/jobs/api/search?company=microsoft&sort=recent&page=2',
  'https://himalayas.app/jobs/api/search?company=adobe&sort=recent&page=1',
  'https://himalayas.app/jobs/api/search?company=salesforce&sort=recent&page=1',
  'https://himalayas.app/jobs/api/search?company=cisco&sort=recent&page=1',
  'https://himalayas.app/jobs/api/search?company=qualcomm&sort=recent&page=1',
  'https://himalayas.app/jobs/api/search?company=broadcom&sort=recent&page=1',
  'https://himalayas.app/jobs/api/search?company=red-hat&sort=recent&page=1',
  'https://apply.workable.com/api/v1/widget/accounts/huggingface?details=true',
  'https://apply.workable.com/api/v1/widget/accounts/smartnews?details=true',
  'https://apply.workable.com/api/v1/widget/accounts/mercari?details=true',
] as const

export const WORKABLE_PRESENCE_URLS = [
  'https://apply.workable.com/api/v1/widget/accounts/huggingface',
  'https://apply.workable.com/api/v1/widget/accounts/smartnews',
  'https://apply.workable.com/api/v1/widget/accounts/mercari',
] as const

export const INTEGRATION_EMPTY_FULL_URLS = [
  'https://himalayas.app/jobs/api/search?company=microsoft&sort=recent&page=1',
  'https://himalayas.app/jobs/api/search?company=adobe&sort=recent&page=1',
  'https://himalayas.app/jobs/api/search?company=salesforce&sort=recent&page=1',
  'https://himalayas.app/jobs/api/search?company=cisco&sort=recent&page=1',
  'https://himalayas.app/jobs/api/search?company=qualcomm&sort=recent&page=1',
  'https://himalayas.app/jobs/api/search?company=broadcom&sort=recent&page=1',
  'https://himalayas.app/jobs/api/search?company=red-hat&sort=recent&page=1',
  'https://apply.workable.com/api/v1/widget/accounts/huggingface?details=true',
  'https://apply.workable.com/api/v1/widget/accounts/smartnews?details=true',
  'https://apply.workable.com/api/v1/widget/accounts/mercari?details=true',
]

export const isIntegrationRequest = (url: string) =>
  url.startsWith('https://himalayas.app/jobs/api/search?')
  || url.startsWith('https://apply.workable.com/api/v1/widget/accounts/')

// Test input display metadata, not expected final default career URLs/styles.
export function integrationCompany(id: string): Company {
  const registration = INTEGRATION_REGISTRATIONS.find(company => company.id === id)
  if (!registration) throw new Error(`Unknown synthetic Stage63 company: ${id}`)
  return {
    ...registration, color: '#83d1c7', initials: '63',
    industry: 'Synthetic source integration fixture',
    careerUrl: 'https://example.com/synthetic/stage63/careers',
  }
}
