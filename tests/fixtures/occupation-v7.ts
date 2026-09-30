import type { Company, FactEvidence, Job, JobOccupation, JobProvider, KnownJobRole, SavedJob } from '../../shared/types'

// Stage 71 · docs/design/occupation-v7.md revision 4
// (SHA-256 87f1ef6eb60f4ddcfe97c20b6862708915f4e54de6d26e8a0de847e036f98376).
//
// Every employer, title, body, department, note and clock in this file is fictional.
// No collected posting text is reproduced. Expected categories, inclusion, labels
// and role specialties are literal oracles copied from the approved contract.
// Never replace them with occupationFacts, isTechnicalJob, jobRoles,
// upgradeJobOccupation or a label function. Historical v6 records below are
// hand-coded assessments; they are not outputs of the current classifier.

/** Public-provider records: cache snapshots and saved backups never carry the sample source. */
export type PublicJob = Job & { source: JobProvider }

export const V7_TIME = '2026-10-01T09:00:00.000Z'
export const V7_NEXT_TIME = '2026-10-01T09:02:00.000Z'
export const V7_UPDATED_AT = '2026-09-30T12:00:00.000Z'
export const V7_SAVED_AT = '2026-09-30T18:30:00.000Z'
/** Literal current method after occupation v7; the observation store must report exactly this. */
export const V7_METHOD = 'observations-2.cities-1.occupation-7.roles-1.qualifications-1.remote-3.employment-1.purpose-1'
/** Literal marker written by v6 collections. It stays on old snapshots and is never rewritten. */
export const V6_METHOD = 'observations-2.cities-1.occupation-6.roles-1.qualifications-1.remote-3.employment-1.purpose-1'
export const OTHER_LABEL = '기타 직군'
export const UNCONFIRMED_LABEL = '개발·컴퓨터 연구 여부 미확인'
export const UNKNOWN_ROLE_LABEL = '세부 직무 미확인'

export const V7_COMPANY: Company = {
  id: 'quill-hardware', name: 'Quill Hardware Studio', initials: 'QH', color: '#c9a1ff',
  industry: 'Fictional devices and tooling', provider: 'greenhouse', board: 'quill-hardware',
  careerUrl: 'https://example.org/quill-hardware/careers',
}
export const V7_ASHBY_COMPANY: Company = {
  ...V7_COMPANY, id: 'quill-ashby', name: 'Quill Ashby Studio', initials: 'QA', provider: 'ashby', board: 'quill-ashby',
  careerUrl: 'https://example.org/quill-ashby/careers',
}
export const V7_LEVER_COMPANY: Company = {
  ...V7_COMPANY, id: 'quill-lever', name: 'Quill Lever Studio', initials: 'QL', provider: 'lever', board: 'quill-lever',
  careerUrl: 'https://example.org/quill-lever/careers',
}
export const V7_SMART_COMPANY: Company = {
  ...V7_COMPANY, id: 'quill-smart', name: 'Quill Smart Studio', initials: 'QS', provider: 'smartrecruiters', board: 'QuillSmart',
  careerUrl: 'https://example.org/quill-smart/careers',
}

export type OccupationCategory = JobOccupation['category']

/** Fictional bodies. Headings match the publisher formats the classifier already reads. */
export const V7_BODIES = {
  recruiting: 'Responsibilities\nSource and screen candidates for fictional engineering teams, schedule interviews and coordinate offers.\nRequirements\nExperience with recruiting and applicant tracking systems.',
  supplierInspection: 'Responsibilities\nInspect supplied castings and connectors, audit fictional supplier factories and verify component tolerances.\nRequirements\nExperience with supplier quality audits.',
  circuitDesign: 'Responsibilities\nDesign amplifier circuits, select passive components and validate fictional boards on the bench.\nRequirements\nExperience with analog circuit design.',
  failedBoards: 'Responsibilities\nInspect failed boards, cross-section solder joints and identify failed components for a fictional sensor module.\nRequirements\nExperience with failure analysis laboratory equipment.',
  failedBoardsWithPipelines: 'Responsibilities\nInspect failed boards, cross-section solder joints and identify failed components. Write Python analysis pipelines that summarize the laboratory findings.\nRequirements\nExperience with failure analysis laboratory equipment.',
  crashSoftware: 'Responsibilities\nDevelop production crash-analysis software and maintain its application code and automated tests for a fictional device fleet.\nRequirements\nExperience with software development in Python.',
  firmwareDuties: 'Responsibilities\nDesign and implement firmware features and maintain firmware tests for a fictional device controller.\nRequirements\nExperience with C and embedded software development.',
  productionTestSoftware: 'Responsibilities\nDevelop production test software and maintain automated software tests for a fictional device line.\nRequirements\nExperience with Python and software development.',
  softwareDuties: 'Responsibilities\nBuild production software services and automated tests for a fictional platform.\nRequirements\nExperience with TypeScript and software development.',
  aiResearch: 'Responsibilities\nResearch machine learning algorithms and evaluate neural networks for a fictional layout benchmark.\nRequirements\nExperience with machine learning research.',
  userInterviews: 'Responsibilities\nInterview users of fictional developer tools and synthesize the findings into research reports.\nRequirements\nExperience with user research.',
} as const

export interface V7Case {
  key: string
  title: string
  departments: string[]
  description: string
  category: OccupationCategory
  explorable: boolean
  /** Asserted only when the contract states a literal specialty list. */
  roles?: KnownJobRole[]
  /** Contract rows that an earlier suite also pins; retained so the approved matrix stays complete here. */
  alsoCoveredBy?: string
}

const row = (key: string, title: string, departments: string[], description: string, category: OccupationCategory,
  extra: Pick<V7Case, 'roles' | 'alsoCoveredBy'> = {}): V7Case => ({
  key, title, departments, description, category, explorable: category === 'engineering' || category === 'research', ...extra,
})

/** Contract table "Primary positions and physical roles". */
export const PRIMARY_ROLE_CASES: V7Case[] = [
  row('talent-specialist', 'Senior Talent Specialist - Product and Engineering', ['General & Admin', 'Talent'], V7_BODIES.recruiting, 'other'),
  row('talent-partner', 'Talent Partner, Engineering', ['People'], V7_BODIES.recruiting, 'other'),
  row('technical-sourcer', 'Senior Technical Sourcer, Applications Engineering', ['General & Admin', 'Talent'], '', 'other'),
  row('people-operations', 'People Operations, Engineering', ['People Operations'], '', 'other'),
  row('engineering-prefix-talent', 'Engineering - Talent Acquisition Specialist', ['Engineering'], '', 'other'),
  row('talent-internship', 'Talent Internship for Software Engineering', ['Internships'], V7_BODIES.recruiting, 'other'),
  row('lead-supplier-quality', 'Lead Supplier Quality Engineer', ['Hardware', 'Supply Chain'], V7_BODIES.supplierInspection, 'other'),
  row('principal-supplier-quality', 'Principal Supplier Quality Engineer', ['Hardware', 'Supply Chain'], V7_BODIES.supplierInspection, 'other'),
  row('engineer-supplier-quality', 'Engineer, Supplier Quality', ['Supplier Quality'], V7_BODIES.supplierInspection, 'other', { alsoCoveredBy: 'tests/fixtures/industry-occupation.ts' }),
  row('electronics-engineer', 'Experienced Electronics Engineer', ['Hardware', 'Hardware Design'], V7_BODIES.circuitDesign, 'other'),
  row('electronic-development', 'Lead Electronic Development Engineer', ['Hardware', 'Hardware Design'], V7_BODIES.circuitDesign, 'other'),
  row('electronics-failure-analysis', 'Electronics Engineer - Failure Analysis', ['Hardware'], V7_BODIES.failedBoards, 'other'),
  row('hardware-test', 'Hardware Test Engineer', ['Hardware'], '', 'other'),
  row('hardware-internship', 'Hardware Internship', ['Internships'], '', 'other'),
  row('data-center', 'Data Center Engineer', ['Infrastructure'], '', 'other', { alsoCoveredBy: 'tests/unit/job-occupation.test.ts' }),
  row('data-center-infrastructure', 'Data Center Infrastructure Engineer', ['Infrastructure'], '', 'other'),
  row('datacenter-operations', 'Datacenter Operations Engineer', ['Infrastructure'], '', 'other'),
  row('computer-hardware', 'Computer Hardware Engineer', ['Hardware'], '', 'other'),
  row('embedded-hardware', 'Embedded Hardware Engineer', ['Hardware'], '', 'other'),
  row('engineering-prefix-backend', 'Engineering - Backend Developer', ['Engineering'], '', 'engineering', { roles: ['backend'] }),
  row('software-talent-platform', 'Software Engineer - Talent Platform', ['General & Admin', 'Talent'], '', 'engineering', { roles: [] }),
  row('talent-platform-engineer', 'Talent Platform Engineer', ['General & Admin', 'Talent'], '', 'engineering', { roles: ['devops'] }),
  row('recruiting-analytics-data', 'Recruiting Analytics Data Engineer', ['General & Admin', 'Talent'], '', 'engineering', { roles: ['data'], alsoCoveredBy: 'tests/unit/job-occupation.test.ts' }),
  row('applied-emerging-talent', 'Software Engineer, Applied Emerging Talent (2027)', ['Engineering'], '', 'engineering', { roles: [] }),
  row('backend-electronics-store', 'Backend Engineer, Electronics Store', ['Commerce'], '', 'engineering', { roles: ['backend'] }),
  row('electronic-trading-developer', 'Electronic Trading Developer', ['Trading Technology'], '', 'engineering', { roles: [] }),
  row('network-automation-data-center', 'Software Engineer, Network Automation - Data Center Fabrics', ['Platform'], '', 'engineering', { alsoCoveredBy: 'tests/unit/job-occupation.test.ts' }),
  row('datacenter-server-lifecycle', 'Staff Engineer, Datacenter Server Lifecycle', ['Platform'], '', 'engineering', { alsoCoveredBy: 'tests/unit/job-occupation.test.ts' }),
  row('offensive-hardware-security', 'Offensive Hardware Security Engineer', ['Hardware'], '', 'engineering', { roles: ['security'], alsoCoveredBy: 'tests/fixtures/occupation-title-scope.ts' }),
  row('data-supply-chain', 'Data Engineer, Supply Chain Analytics', ['Supply Chain'], '', 'engineering', { roles: ['data'] }),
  row('ml-failure-prediction', 'Machine Learning Engineer, Failure Prediction', ['Hardware'], '', 'engineering', { roles: ['ml'] }),
  row('ai-research-electronics', 'AI Research Scientist - Electronics Design', ['Hardware', 'Hardware Design'], V7_BODIES.aiResearch, 'research', { roles: ['ml'] }),
  row('ux-researcher', 'UX Researcher for Engineering', ['Design'], V7_BODIES.userInterviews, 'other'),
  row('executive-assistant', 'Executive Assistant, Software Engineering', ['Software Engineering'], '', 'other', { alsoCoveredBy: 'tests/fixtures/occupation-title-scope.ts' }),
  row('sourcing-engineer', 'Sourcing Engineer', ['Supply Chain'], '', 'engineering', { roles: [] }),
  row('tech-lead-software', 'Tech Lead - Software Engineering', ['Engineering'], '', 'engineering', { roles: [] }),
  row('team-lead-backend', 'Team Lead, Backend Engineering', ['Engineering'], '', 'engineering', { roles: ['backend'] }),
]

/** Contract table "Internships and neutral heads". Every row states its literal specialties. */
export const INTERNSHIP_CASES: V7Case[] = [
  row('software-internship', 'Software Internship', ['Internships'], '', 'engineering', { roles: [] }),
  row('firmware-intern', 'Firmware Intern', ['Internships'], '', 'engineering', { roles: [] }),
  row('firmware-internship-years', 'Firmware Internship 2026/2027', ['Internships'], '', 'engineering', { roles: [] }),
  row('embedded-software-internship', 'Embedded Software Internship', ['Internships'], '', 'engineering', { roles: [] }),
  row('backend-internship', 'Backend Internship', ['Internships'], '', 'engineering', { roles: ['backend'] }),
  row('frontend-internship', 'Frontend Internship', ['Internships'], '', 'engineering', { roles: ['frontend'] }),
  row('full-stack-intern', 'Full Stack Intern', ['Internships'], '', 'engineering', { roles: ['fullstack'] }),
  row('mobile-intern', 'Mobile Intern', ['Internships'], '', 'engineering', { roles: ['mobile'] }),
  row('ios-intern', 'iOS Intern', ['Internships'], '', 'engineering', { roles: ['mobile'] }),
  row('android-internship', 'Android Internship', ['Internships'], '', 'engineering', { roles: ['mobile'] }),
  row('machine-learning-intern', 'Machine Learning Intern', ['Internships'], '', 'engineering', { roles: ['ml'] }),
  row('ai-internship', 'AI Internship', ['Internships'], '', 'engineering', { roles: ['ml'] }),
  row('ml-intern', 'ML Intern', ['Internships'], '', 'engineering', { roles: ['ml'] }),
  row('software-engineering-intern', 'Software Engineering Intern', ['Internships'], '', 'engineering', { roles: [] }),
  row('software-development-intern', 'Software Development Intern', ['Internships'], '', 'engineering', { roles: [] }),
  row('intern-software-engineering', 'Intern, Software Engineering', ['Internships'], '', 'engineering', { roles: [] }),
  row('working-student-software', 'Working Student - Software Engineering', ['Internships'], '', 'engineering', { roles: [] }),
  row('intern-firmware', 'Intern - Firmware', ['Internships'], '', 'engineering', { roles: [] }),
  row('intern-talent-acquisition', 'Intern, Talent Acquisition', ['Internships'], '', 'other', { roles: [] }),
  row('intern-hardware', 'Intern, Hardware', ['Internships'], '', 'other', { roles: [] }),
  row('software-sales-internship', 'Software Sales Internship', ['Internships'], '', 'unconfirmed', { roles: [] }),
  row('software-marketing-intern', 'Software Marketing Intern', ['Internships'], '', 'unconfirmed', { roles: [] }),
]

/** Contract table "Computing controls": engineering in a Hardware department AND with a " - Hardware" suffix. */
export const COMPUTING_CONTROLS: { title: string; roles: KnownJobRole[] }[] = [
  { title: 'Senior Software Engineer', roles: [] },
  { title: 'Senior Firmware Engineer', roles: [] },
  { title: 'Embedded Software Engineer', roles: [] },
  { title: 'Backend Engineer', roles: ['backend'] },
  { title: 'Frontend Engineer', roles: ['frontend'] },
  { title: 'Full Stack Engineer', roles: ['fullstack'] },
  { title: 'Cloud Engineer', roles: ['devops'] },
  { title: 'Mobile Engineer', roles: ['mobile'] },
  { title: 'Senior iOS Engineer', roles: ['mobile'] },
  { title: 'Android Engineer', roles: ['mobile'] },
  { title: 'Platform Engineer', roles: ['devops'] },
  { title: 'Infrastructure Engineer', roles: ['devops'] },
  { title: 'Software Infrastructure Engineer', roles: ['devops'] },
  { title: 'EDA Engineer', roles: [] },
  { title: 'RTL Design Engineer', roles: [] },
  { title: 'MES Engineer', roles: [] },
  { title: 'Network Engineer', roles: [] },
  { title: 'Software QA Engineer', roles: [] },
  { title: 'Software Test Automation Engineer', roles: [] },
  { title: 'SDET', roles: [] },
  { title: 'Software Development Engineer in Test', roles: [] },
]

export function computingControlForms(control: { title: string; roles: KnownJobRole[] }): V7Case[] {
  return [
    row(`${control.title}|department`, control.title, ['Hardware'], '', 'engineering', { roles: control.roles }),
    row(`${control.title}|suffix`, `${control.title} - Hardware`, [], '', 'engineering', { roles: control.roles }),
  ]
}

/** Contract "Additional engineering controls" plus the recorded generic-automation asymmetry. */
export const ADDITIONAL_CONTROL_CASES: V7Case[] = [
  row('production-test-systems', 'Senior Software Engineer - Production Test Systems', ['Hardware', 'Production'], V7_BODIES.productionTestSoftware, 'engineering', { roles: [] }),
  row('firmware-hardware-platform', 'Senior Firmware Engineer', ['Hardware', 'Hardware Platform'], V7_BODIES.firmwareDuties, 'engineering', { roles: [] }),
  row('engineer-marketing', 'Engineer', ['Marketing'], '', 'engineering', { roles: [], alsoCoveredBy: 'tests/unit/occupation-title-scope.test.ts' }),
  row('marketing-engineer', 'Marketing Engineer', ['Marketing'], '', 'engineering', { roles: [], alsoCoveredBy: 'tests/unit/occupation-title-scope.test.ts' }),
  row('developer-relations-engineer', 'Developer Relations Engineer', ['Marketing'], '', 'engineering', { roles: [], alsoCoveredBy: 'tests/unit/occupation-title-scope.test.ts' }),
  // Accepted limitation: generic engineers in a Hardware department keep the inherited broad policy.
  row('systems-engineer-hardware', 'Systems Engineer', ['Hardware'], '', 'engineering'),
  row('test-engineer-hardware', 'Test Engineer', ['Hardware'], '', 'engineering'),
  row('quality-engineer-hardware', 'Quality Engineer', ['Hardware'], '', 'engineering'),
  row('test-automation-hardware-department', 'Test Automation Engineer', ['Hardware'], '', 'engineering'),
  row('bare-engineering', 'Engineering', [], '', 'engineering'),
  // Accepted limitation: the same generic automation title with a Hardware suffix is other.
  row('test-automation-hardware-suffix', 'Test Automation Engineer - Hardware', [], '', 'other'),
]

/** Contract section "Ambiguous Failure Analysis": Engineer and Specialist forms, including EEE. */
export const FAILURE_ANALYSIS_TITLES = [
  'Failure Analysis Engineer', 'Senior Failure Analysis Engineer', 'Lead Failure Analysis Engineer', 'Junior Failure Analysis Engineer',
  'Failure Analysis Specialist', 'EEE Failure Analysis Specialist (Satellite PCB Engineering)',
] as const

export const FAILURE_ANALYSIS_BODIES: { key: string; description: string; category: OccupationCategory }[] = [
  { key: 'physical-investigation', description: V7_BODIES.failedBoards, category: 'other' },
  { key: 'physical-plus-pipelines', description: V7_BODIES.failedBoardsWithPipelines, category: 'other' },
  { key: 'crash-analysis-software', description: V7_BODIES.crashSoftware, category: 'engineering' },
  { key: 'firmware-features', description: V7_BODIES.firmwareDuties, category: 'engineering' },
  { key: 'empty-body', description: '', category: 'unconfirmed' },
  { key: 'qualification-only', description: 'Qualifications\nExperience developing production software.', category: 'unconfirmed' },
  { key: 'preferred-only', description: 'Preferred qualifications\nExperience developing production software.', category: 'unconfirmed' },
  { key: 'incidental-tools', description: 'Responsibilities\nUse Python and SQL to summarize measurements from the fictional test lab.', category: 'unconfirmed' },
  { key: 'company-introduction', description: 'About us\nOur company develops AI software for fictional device fleets.', category: 'unconfirmed' },
  { key: 'other-team', description: 'Responsibilities\nThe software team develops production software; this role provides their measurements.', category: 'unconfirmed' },
  { key: 'negated-duty', description: 'Responsibilities\nThis role does not develop or maintain software.', category: 'unconfirmed' },
  { key: 'unrecognized-heading', description: 'Key accountabilities\nDevelop production software for the fictional analysis platform.', category: 'unconfirmed' },
]

/** Recorded, intentionally different standard: Design Engineer still accepts a qualification-only body. */
export const DESIGN_ENGINEER_QUALIFICATION_CASE: V7Case = row('design-engineer-qualification-only', 'Design Engineer', ['Product Engineering'],
  'You have\nExperience building frontend applications with React and TypeScript.', 'engineering', { roles: [] })

export const htmlBody = (text: string) => text.split('\n').filter(Boolean).map(line => `<p>${line}</p>`).join('')

/** Input construction only; deliberately does not call production classifiers. The source is always the company's public provider. */
export function v7Job(fixture: Pick<V7Case, 'key' | 'title' | 'departments' | 'description'>, overrides: Partial<Omit<Job, 'source'>> = {}, company: Company = V7_COMPANY): PublicJob {
  const provider: JobProvider = company.provider ?? 'greenhouse'
  return {
    id: `${provider}-${company.id}-${fixture.key}`, companyId: company.id,
    title: fixture.title, description: fixture.description, role: 'unknown',
    cityIds: ['london'], locationLabel: 'London, United Kingdom', workMode: 'onsite', employment: 'fulltime',
    minExperience: null, skills: [], salary: null, visa: 'unknown',
    remoteCountries: [], remoteWorldwide: false, remoteScopeUnknown: false,
    source: provider, requirements: [], updatedAt: V7_UPDATED_AT, fetchedAt: V7_TIME,
    url: `https://example.org/${company.id}/${fixture.key}`, ...overrides,
  }
}

export interface LegacyV6Case {
  key: string
  title: string
  departments: string[]
  description: string
  /** The v6 assessment as it was stored, hand-coded. */
  evidence: FactEvidence[]
  /** Literal v7 outcome from the contract. */
  category: OccupationCategory
  explorable: boolean
  label: string
  /** Why this record exists; the mechanism control is marked explicitly. */
  provenance: 'observed-v6-title-only-branch' | 'hand-authored-migration-mechanism-control'
}

const titleEvidence = (text: string): FactEvidence => ({ source: 'title', text })

/**
 * Historical v6 records with hard-coded prior assessments (all `engineering`, as the
 * v6 title-only branch produced). The preserved-duties record is a hand-authored
 * migration mechanism control for evidence beyond the stored body; v6 never
 * emitted description evidence for this title family.
 */
export const LEGACY_V6_CASES: LegacyV6Case[] = [
  {
    key: 'supplier-quality', title: 'Lead Supplier Quality Engineer', departments: ['Hardware', 'Supply Chain'],
    description: V7_BODIES.supplierInspection, evidence: [titleEvidence('Lead Supplier Quality Engineer')],
    category: 'other', explorable: false, label: OTHER_LABEL, provenance: 'observed-v6-title-only-branch',
  },
  {
    key: 'talent-specialist', title: 'Senior Talent Specialist - Product and Engineering', departments: ['General & Admin', 'Talent'],
    description: V7_BODIES.recruiting, evidence: [titleEvidence('Senior Talent Specialist - Product and Engineering')],
    category: 'other', explorable: false, label: OTHER_LABEL, provenance: 'observed-v6-title-only-branch',
  },
  {
    key: 'electronics', title: 'Experienced Electronics Engineer', departments: ['Hardware', 'Hardware Design'],
    description: V7_BODIES.circuitDesign, evidence: [titleEvidence('Experienced Electronics Engineer')],
    category: 'other', explorable: false, label: OTHER_LABEL, provenance: 'observed-v6-title-only-branch',
  },
  {
    key: 'failure-analysis-empty', title: 'Failure Analysis Engineer', departments: ['Hardware'],
    description: '', evidence: [titleEvidence('Failure Analysis Engineer')],
    category: 'unconfirmed', explorable: false, label: UNCONFIRMED_LABEL, provenance: 'observed-v6-title-only-branch',
  },
  {
    key: 'failure-analysis-preserved-duties', title: 'Failure Analysis Engineer', departments: ['Hardware'],
    description: '', evidence: [
      titleEvidence('Failure Analysis Engineer'),
      { source: 'description', text: 'Responsibilities\nInspect failed boards, cross-section solder joints and identify failed components for a fictional sensor module.' },
    ],
    category: 'other', explorable: false, label: OTHER_LABEL, provenance: 'hand-authored-migration-mechanism-control',
  },
  {
    key: 'firmware-retained', title: 'Senior Firmware Engineer', departments: ['Hardware', 'Hardware Platform'],
    description: V7_BODIES.firmwareDuties, evidence: [titleEvidence('Senior Firmware Engineer')],
    category: 'engineering', explorable: true, label: UNKNOWN_ROLE_LABEL, provenance: 'observed-v6-title-only-branch',
  },
  {
    key: 'production-test-retained', title: 'Senior Software Engineer - Production Test Systems', departments: ['Hardware', 'Production'],
    description: V7_BODIES.productionTestSoftware, evidence: [titleEvidence('Senior Software Engineer - Production Test Systems')],
    category: 'engineering', explorable: true, label: UNKNOWN_ROLE_LABEL, provenance: 'observed-v6-title-only-branch',
  },
]

export function legacyV6Case(key: LegacyV6Case['key']): LegacyV6Case {
  const found = LEGACY_V6_CASES.find(item => item.key === key)
  if (!found) throw new Error(`Unknown legacy v6 fixture ${key}`)
  return found
}

/** A stored v6 public record, authored literally rather than generated by a parser. */
export function legacyV6Job(key: LegacyV6Case['key'], overrides: Partial<Omit<Job, 'source'>> = {}, company: Company = V7_COMPANY): PublicJob {
  const fixture = legacyV6Case(key)
  return v7Job(fixture, {
    roleClassification: { version: 1, roles: [], evidence: [] },
    occupation: { version: 6, category: 'engineering', evidence: fixture.evidence, departments: fixture.departments },
    ...overrides,
  }, company)
}

export function legacyV6Saved(key: LegacyV6Case['key'], note: string, status: SavedJob['status'] = 'applied'): SavedJob {
  return { job: legacyV6Job(key), company: V7_COMPANY, savedAt: V7_SAVED_AT, status, note }
}

/** Fresh v7 collection records for observation tests, hand-coded at the current version. */
export function currentV7Job(key: string, title: string, departments: string[], description: string, company: Company = V7_COMPANY, fetchedAt = V7_TIME): PublicJob {
  return v7Job({ key, title, departments, description }, {
    fetchedAt,
    roleClassification: { version: 1, roles: [], evidence: [] },
    occupation: { version: 7, category: 'engineering', evidence: [titleEvidence(title)], departments },
  }, company)
}

/** Stateful E2E catalog: literal inclusion per row, before and after the refresh. */
export interface E2ERow { id: number; title: string; departments: string[]; description: string; visible: boolean }
export const E2E_ROWS: E2ERow[] = [
  { id: 101, title: 'Senior Talent Specialist - Product and Engineering', departments: ['General & Admin', 'Talent'], description: V7_BODIES.recruiting, visible: false },
  { id: 102, title: 'Lead Supplier Quality Engineer', departments: ['Hardware', 'Supply Chain'], description: V7_BODIES.supplierInspection, visible: false },
  { id: 103, title: 'Experienced Electronics Engineer', departments: ['Hardware', 'Hardware Design'], description: V7_BODIES.circuitDesign, visible: false },
  { id: 104, title: 'Senior Failure Analysis Engineer', departments: ['Hardware'], description: V7_BODIES.failedBoards, visible: false },
  { id: 105, title: 'Senior Software Engineer - Production Test Systems', departments: ['Hardware', 'Production'], description: V7_BODIES.productionTestSoftware, visible: true },
  { id: 106, title: 'Senior Firmware Engineer', departments: ['Hardware', 'Hardware Platform'], description: V7_BODIES.firmwareDuties, visible: true },
  { id: 107, title: 'Failure Analysis Engineer', departments: ['Hardware'], description: V7_BODIES.crashSoftware, visible: true },
  { id: 108, title: 'Firmware Internship 2026/2027', departments: ['Internships'], description: V7_BODIES.firmwareDuties, visible: true },
  { id: 109, title: 'Software Engineer, Talent Tools', departments: ['General & Admin', 'Talent'], description: V7_BODIES.softwareDuties, visible: true },
  { id: 110, title: 'Machine Learning Engineer, Failure Prediction', departments: ['Hardware'], description: V7_BODIES.softwareDuties, visible: true },
  { id: 111, title: 'Senior iOS Engineer', departments: ['Hardware', 'Companion App'], description: V7_BODIES.softwareDuties, visible: true },
  { id: 112, title: 'Cloud Engineer - Hardware', departments: ['Hardware'], description: V7_BODIES.softwareDuties, visible: true },
]
/** Same ID 107, different published body: the refresh reclassifies it out of exploration. */
export const E2E_REFRESH_RECLASSIFIED: E2ERow = { ...E2E_ROWS[6], description: V7_BODIES.failedBoards, visible: false }
export const E2E_REFRESH_ADDED: E2ERow = { id: 113, title: 'Android Engineer - Hardware', departments: ['Hardware'], description: V7_BODIES.softwareDuties, visible: true }

// Literal visible titles in JavaScript default sort order (uppercase before lowercase).
export const E2E_FRESH_TITLES = [
  'Cloud Engineer - Hardware', 'Failure Analysis Engineer', 'Firmware Internship 2026/2027',
  'Machine Learning Engineer, Failure Prediction', 'Senior Firmware Engineer',
  'Senior Software Engineer - Production Test Systems', 'Senior iOS Engineer', 'Software Engineer, Talent Tools',
]
export const E2E_REFRESHED_TITLES = [
  'Android Engineer - Hardware', 'Cloud Engineer - Hardware', 'Firmware Internship 2026/2027',
  'Machine Learning Engineer, Failure Prediction', 'Senior Firmware Engineer',
  'Senior Software Engineer - Production Test Systems', 'Senior iOS Engineer', 'Software Engineer, Talent Tools',
]

// ---------------------------------------------------------------------------
// Supplement after Astra's preliminary implementation review and main's heading
// finding (implementation-02). Expectations follow rules 2, 4, 6 and 7 of the
// approved contract; none is read from the revised classifier.

/** Rule 2: a recognized non-computing research position stays other ahead of any engineering audience; computing co-roles stay eligible. */
export const RESEARCH_PRIMARY_CASES: V7Case[] = [
  row('ux-researcher-for-engineering', 'UX Researcher for Engineering', ['Design'], V7_BODIES.userInterviews, 'other'),
  row('user-researcher-developer-platform', 'User Researcher, Developer Platform', ['Design'], V7_BODIES.userInterviews, 'other'),
  row('market-researcher-engineering-products', 'Market Researcher - Engineering Products', ['Marketing'],
    'Responsibilities\nStudy fictional market segments and present competitor positioning to product leadership.\nRequirements\nExperience with market research.', 'other'),
  row('people-research-scientist-engineering-talent', 'People Research Scientist, Engineering Talent', ['People'],
    'Responsibilities\nAnalyze fictional employee survey results and present findings to leadership.\nRequirements\nExperience with organizational research.', 'other'),
  row('software-engineer-ux-research-tools', 'Software Engineer, UX Research Tools', ['Design'], V7_BODIES.softwareDuties, 'engineering', { roles: [] }),
  row('ml-engineer-user-research-insights', 'Machine Learning Engineer, User Research Insights', ['Design'], V7_BODIES.softwareDuties, 'engineering', { roles: ['ml'] }),
  row('research-engineer-developer-experience', 'Research Engineer, Developer Experience', ['Engineering'], V7_BODIES.softwareDuties, 'engineering', { roles: [] }),
]

/** Rule 4: an ordinary modifier between a hardware compound and Engineer keeps the position physical; explicit computing positions stay eligible. */
export const HARDWARE_MODIFIER_CASES: V7Case[] = [
  row('embedded-hardware-reliability', 'Embedded Hardware Reliability Engineer', ['Hardware'], '', 'other'),
  row('computer-hardware-quality', 'Computer Hardware Quality Engineer', ['Hardware'], '', 'other'),
  row('embedded-hardware-test', 'Embedded Hardware Test Engineer', ['Hardware'], '', 'other'),
  row('computer-hardware-reliability', 'Computer Hardware Reliability Engineer', ['Hardware'], '', 'other'),
  row('embedded-hardware-reliability-suffix', 'Embedded Hardware Reliability Engineer - Hardware', [], '', 'other'),
  row('offensive-hardware-security-control', 'Offensive Hardware Security Engineer', ['Hardware'], '', 'engineering', { roles: ['security'] }),
  row('hardware-security', 'Hardware Security Engineer', ['Hardware'], '', 'engineering', { roles: ['security'] }),
  row('embedded-software-reliability', 'Embedded Software Reliability Engineer', ['Hardware'], '', 'engineering', { roles: [] }),
  row('embedded-systems', 'Embedded Systems Engineer', ['Hardware'], '', 'engineering', { roles: [] }),
  row('computer-vision', 'Computer Vision Engineer', ['Hardware'], '', 'engineering', { roles: [] }),
  row('site-reliability-hardware-suffix', 'Site Reliability Engineer - Hardware', [], '', 'engineering', { roles: ['devops'] }),
]

/**
 * Rules 6 and 7, attribution inside one duty paragraph: a negated or another team's
 * software statement establishes nothing, a separately stated own duty still counts,
 * software that operates on boards is software work, and an independent physical
 * duty keeps physical-first precedence.
 */
export const FAILURE_ATTRIBUTION_BODIES: { key: string; description: string; category: OccupationCategory }[] = [
  { key: 'negated-following-predicate', description: 'Responsibilities\nDeveloping production software is not part of this role.', category: 'unconfirmed' },
  { key: 'other-team-following-predicate', description: 'Responsibilities\nDeveloping production software is handled by another team.', category: 'unconfirmed' },
  { key: 'negated-then-own-firmware', description: 'Responsibilities\nDeveloping production software is not part of this role; you maintain firmware.', category: 'engineering' },
  { key: 'other-team-then-own-firmware', description: 'Responsibilities\nDeveloping production software is handled by another team; you maintain firmware.', category: 'engineering' },
  { key: 'software-that-analyzes-boards', description: 'Responsibilities\nDevelop production software that analyzes failed boards and identifies faulty components.', category: 'engineering' },
  { key: 'software-and-software-components', description: 'Responsibilities\nDevelop production software and test software components.', category: 'engineering' },
  { key: 'independent-physical-then-software', description: 'Responsibilities\nInspect failed boards and develop production software.', category: 'other' },
  { key: 'software-relative-then-separate-physical', description: 'Responsibilities\nDevelop production software that analyzes failed boards; you also cross-section solder joints in the fictional lab.', category: 'other' },
]

/** Main's real heading discovery in fictional form: a curly-quote, period-terminated own-duties heading and a period-terminated qualifications heading. */
export const OWN_DUTIES_HEADING = 'WHAT YOU’LL OWN.'
export const WHO_YOU_ARE_HEADING = 'WHO YOU ARE.'
export const FAILURE_HEADING_BODIES: { key: string; description: string; category: OccupationCategory }[] = [
  {
    key: 'own-physical-duties-under-heading',
    description: `${OWN_DUTIES_HEADING}\nInspect failed boards, cross-section solder joints and identify failed components for a fictional sensor module.\n${WHO_YOU_ARE_HEADING}\nYou have experience developing production software.`,
    category: 'other',
  },
  {
    key: 'own-software-duties-under-heading',
    description: `${OWN_DUTIES_HEADING}\nDevelop production crash-analysis software and maintain its application code and automated tests for a fictional device fleet.\n${WHO_YOU_ARE_HEADING}\nYou have experience with Python and C.`,
    category: 'engineering',
  },
  {
    key: 'non-technical-duties-with-software-qualification',
    description: `${OWN_DUTIES_HEADING}\nCoordinate the fictional laboratory schedule and order consumables.\n${WHO_YOU_ARE_HEADING}\nYou have experience developing production software.`,
    category: 'unconfirmed',
  },
]

/** Astra finding 5: an en dash (U+2013) inside the family name. The published title must be stored exactly as received. */
export const FAILURE_DASH_TITLE = 'Failure–Analysis Engineer'
export const FAILURE_DASH_SPECIALIST_TITLE = 'Failure–Analysis Specialist'

// ---------------------------------------------------------------------------
// Supplement after Astra's second preliminary implementation review
// (implementation-02 findings 1–3, corrected in implementation-03).

/** Rules 2 and 4: a computing co-role inside the primary title counts; an audience or team suffix does not become a role. */
export const COMPUTING_CO_ROLE_CASES: V7Case[] = [
  row('embedded-hardware-and-firmware-developer', 'Embedded Hardware Engineer and Firmware Developer', ['Hardware'], '', 'engineering', { roles: [] }),
  row('firmware-developer-and-embedded-hardware', 'Firmware Developer and Embedded Hardware Engineer', ['Hardware'], '', 'engineering', { roles: [] }),
  row('computer-hardware-and-embedded-software-developer', 'Computer Hardware Engineer and Embedded Software Developer', ['Hardware'], '', 'engineering', { roles: [] }),
  row('embedded-hardware-for-firmware-developers', 'Embedded Hardware Engineer for Firmware Developers', ['Hardware'], '', 'other'),
  row('embedded-hardware-serving-firmware-developers', 'Embedded Hardware Engineer serving Firmware Developers', ['Hardware'], '', 'other'),
  row('embedded-hardware-firmware-team-suffix', 'Embedded Hardware Engineer, Firmware Team', ['Hardware'], '', 'other'),
]

/**
 * Rule 6: a following ownership or negation predicate covers every coordinated action
 * before it, a new subject after a semicolon or "then" is the worker's own duty, and a
 * manual qualifier after a physical object is the worker's own investigation even when
 * an earlier software-purpose clause shares the sentence.
 */
export const FAILURE_COORDINATION_BODIES: { key: string; description: string; category: OccupationCategory }[] = [
  { key: 'coordinated-other-team', description: 'Responsibilities\nDeveloping production software and maintaining firmware are handled by another team.', category: 'unconfirmed' },
  { key: 'coordinated-negated', description: 'Responsibilities\nDeveloping production software and maintaining firmware are not part of this role.', category: 'unconfirmed' },
  { key: 'coordinated-other-team-then-own-software', description: 'Responsibilities\nDeveloping production software and maintaining firmware are handled by another team; you maintain production software.', category: 'engineering' },
  { key: 'coordinated-negated-then-own-software', description: 'Responsibilities\nDeveloping production software and maintaining firmware are not part of this role; you maintain production software.', category: 'engineering' },
  { key: 'mixed-coordinated-other-team', description: 'Responsibilities\nDeveloping production software and inspecting failed boards are handled by another team.', category: 'unconfirmed' },
  { key: 'mixed-coordinated-other-team-then-own-physical', description: 'Responsibilities\nDeveloping production software and inspecting failed boards are handled by another team; you cross-section solder joints in the fictional lab.', category: 'other' },
  { key: 'software-purpose-then-manual-inspection', description: 'Responsibilities\nDevelop production software to analyze board measurements, then inspect failed components by hand at the bench.', category: 'other' },
  { key: 'software-purpose-then-you-inspect', description: 'Responsibilities\nDevelop production software to analyze board measurements, then you inspect failed components at the bench.', category: 'other' },
  { key: 'software-purpose-only', description: 'Responsibilities\nDevelop production software to analyze board measurements from the fictional automated tester.', category: 'engineering' },
]

// ---------------------------------------------------------------------------
// Supplement after main's integration concern about the early writing, finance and
// assistant guard: SDET is a computing position (rule 4), a coordinated SDET co-role is
// genuine (rule 2), an SDET audience or team suffix is not, and a named Assistant keeps
// its precedence over a neutral intern discipline (rule 2). Management priority unchanged.

export const NAMED_ROLE_CO_ROLE_CASES: V7Case[] = [
  row('technical-writer-and-sdet', 'Technical Writer and SDET', ['Documentation'], '', 'engineering', { roles: [] }),
  row('sdet-and-technical-writer', 'SDET and Technical Writer', ['Quality'], '', 'engineering', { roles: [] }),
  row('technical-writer-and-sdet-long-form', 'Technical Writer and Software Development Engineer in Test', ['Documentation'], '', 'engineering', { roles: [] }),
  row('finance-analyst-and-sdet', 'Finance Analyst and SDET', ['Finance'], '', 'engineering', { roles: [] }),
  row('technical-writer-for-sdets', 'Technical Writer for SDETs', ['Documentation'], '', 'other'),
  row('technical-writer-sdet-team-suffix', 'Technical Writer, SDET Team', ['Documentation'], '', 'other'),
  row('finance-analyst-sdet-tooling-suffix', 'Finance Analyst, SDET Tooling', ['Finance'], '', 'other'),
  row('technical-writer-and-sdet-manager', 'Technical Writer and SDET Manager', ['Documentation'], '', 'management'),
  row('executive-assistant-to-software-engineering-intern', 'Executive Assistant to the Software Engineering Intern', ['Software Engineering'],
    'Responsibilities\nArrange calendars, book travel and process expense forms for the fictional software engineering interns.\nRequirements\nExperience supporting executive schedules.', 'other'),
  row('executive-assistant-software-engineering-retained', 'Executive Assistant, Software Engineering', ['Software Engineering'], '', 'other', { alsoCoveredBy: 'PRIMARY_ROLE_CASES' }),
]

// ---------------------------------------------------------------------------
// Supplement after Astra's consolidated review of implementation-03 (findings 1–3,
// corrected in implementation-04).

/** Rules 2 and 5: the coordinator or assistant of an internship programme is a named administrative position; the programme name is not a computing internship. */
export const INTERNSHIP_PROGRAM_ROLE_CASES: V7Case[] = [
  row('software-internship-coordinator', 'Software Internship Coordinator', ['Early Careers'], '', 'other'),
  row('software-internship-assistant', 'Software Internship Assistant', ['Early Careers'], '', 'other'),
  row('software-internship-retained', 'Software Internship', ['Early Careers'], '', 'engineering', { roles: [], alsoCoveredBy: 'INTERNSHIP_CASES' }),
]

/**
 * Rule 6: an explicit own subject keeps its affirmative software duty even when a
 * coordinated clause assigns other work to another team; a negated own duty establishes
 * nothing; a manual marker that is negated or belongs to another actor is not the
 * worker's own investigation, while the worker's own manual work still takes precedence.
 */
export const FAILURE_SUBJECT_BODIES: { key: string; description: string; category: OccupationCategory }[] = [
  { key: 'own-subject-software-other-team-firmware', description: 'Responsibilities\nYou will develop production software, and maintaining firmware is handled by another team.', category: 'engineering' },
  { key: 'own-subject-progressive-software', description: 'Responsibilities\nYou will be developing production software, and maintaining firmware is handled by another team.', category: 'engineering' },
  { key: 'role-subject-progressive-software', description: 'Responsibilities\nThe role will be developing production software, while maintaining firmware is handled by another team.', category: 'engineering' },
  { key: 'own-subject-negated-software-other-team-firmware', description: 'Responsibilities\nYou will not develop production software; maintaining firmware is handled by another team.', category: 'unconfirmed' },
  { key: 'software-to-inspect-without-by-hand', description: 'Responsibilities\nDevelop production software to inspect failed boards without doing so by hand.', category: 'engineering' },
  { key: 'software-to-inspect-other-team-by-hand', description: 'Responsibilities\nDevelop production software to inspect failed boards that another team examines by hand.', category: 'engineering' },
  { key: 'software-to-inspect-other-team-separate-clause', description: 'Responsibilities\nDevelop production software to inspect failed boards; the reliability team examines components by hand.', category: 'engineering' },
  { key: 'software-to-inspect-and-own-manual', description: 'Responsibilities\nDevelop production software to inspect failed boards, and examine components by hand yourself.', category: 'other' },
]

// ---------------------------------------------------------------------------
// Supplement after Astra's formal readiness review of the combined state (two product
// cases outside the existing literals, corrected in implementation-05).

/** Rules 2 and 4: SDET as a training-programme modifier does not turn a coordinator, assistant or recruiter into a computing position; a coordinated SDET co-role does. */
export const SDET_MODIFIER_CASES: V7Case[] = [
  row('sdet-training-coordinator', 'SDET Training Coordinator', ['Quality Enablement'],
    'Responsibilities\nSchedule fictional SDET training sessions and track attendance.\nRequirements\nExperience coordinating training calendars.', 'other'),
  row('sdet-training-assistant', 'SDET Training Assistant', ['Quality Enablement'],
    'Responsibilities\nBook rooms for fictional SDET training sessions and keep the attendance register.\nRequirements\nExperience with administrative scheduling.', 'other'),
  row('training-coordinator-for-sdets', 'Training Coordinator for SDETs', ['Quality Enablement'],
    'Responsibilities\nSchedule fictional training sessions and track attendance.', 'other'),
  row('sdet-recruiter', 'SDET Recruiter', ['Talent'], '', 'other'),
  row('sdet-and-training-coordinator', 'SDET and Training Coordinator', ['Quality Enablement'], '', 'engineering', { roles: [] }),
  row('sdet-retained', 'SDET', ['Quality'], '', 'engineering', { roles: [], alsoCoveredBy: 'COMPUTING_CONTROLS' }),
  row('technical-writer-and-sdet-retained', 'Technical Writer and SDET', ['Documentation'], '', 'engineering', { roles: [], alsoCoveredBy: 'NAMED_ROLE_CO_ROLE_CASES' }),
  row('technical-writer-for-sdets-retained', 'Technical Writer for SDETs', ['Documentation'], '', 'other', { alsoCoveredBy: 'NAMED_ROLE_CO_ROLE_CASES' }),
]

/** Rule 6: a contextual role phrase is not an affirmative subject; a separately asserted own duty still counts. */
export const FAILURE_CONTEXT_BODIES: { key: string; description: string; category: OccupationCategory }[] = [
  { key: 'contextual-role-other-team', description: 'Responsibilities\nFor this role developing production software and maintaining firmware are handled by another team.', category: 'unconfirmed' },
  { key: 'contextual-position-other-team', description: 'Responsibilities\nIn this position, developing production software and maintaining firmware are handled by another team.', category: 'unconfirmed' },
  { key: 'contextual-role-negated', description: 'Responsibilities\nFor this role developing production software and maintaining firmware are not part of the job.', category: 'unconfirmed' },
  { key: 'contextual-role-other-team-then-own-software', description: 'Responsibilities\nFor this role developing production software and maintaining firmware are handled by another team; you maintain production software.', category: 'engineering' },
  { key: 'contextual-prefix-explicit-own-subject', description: 'Responsibilities\nFor this role, you will develop production software while maintaining firmware is handled by another team.', category: 'engineering' },
]

// ---------------------------------------------------------------------------
// Supplement after Astra's review of implementation-05 (two cases outside the literals).

/** Rules 2 and 4: a conjunction between programme activities is not a second position; an independently stated SDET clause is. */
export const SDET_ACTIVITY_CONJUNCTION_CASES: V7Case[] = [
  row('sdet-training-and-development-coordinator', 'SDET Training and Development Coordinator', ['Quality Enablement'],
    'Responsibilities\nSchedule fictional SDET training sessions and track attendance.\nRequirements\nExperience coordinating training calendars.', 'other'),
  row('sdet-onboarding-and-enablement-assistant', 'SDET Onboarding and Enablement Assistant', ['Quality Enablement'],
    'Responsibilities\nBook rooms for fictional SDET onboarding sessions and keep the attendance register.', 'other'),
  row('sdet-and-training-and-development-coordinator', 'SDET and Training and Development Coordinator', ['Quality Enablement'], '', 'engineering', { roles: [] }),
  row('sdet-and-training-coordinator-retained', 'SDET and Training Coordinator', ['Quality Enablement'], '', 'engineering', { roles: [], alsoCoveredBy: 'SDET_MODIFIER_CASES' }),
]

/** Rule 6: a governing worker predicate makes the following software duty the role's own; a contextual preposition does not. */
export const FAILURE_GOVERNING_BODIES: { key: string; description: string; category: OccupationCategory }[] = [
  { key: 'you-focus-on-software-other-team-firmware', description: 'Responsibilities\nYou focus on developing production software, and maintaining firmware is handled by another team.', category: 'engineering' },
  { key: 'you-are-responsible-for-software-other-team-firmware', description: 'Responsibilities\nYou are responsible for developing production software, and maintaining firmware is handled by another team.', category: 'engineering' },
  { key: 'this-role-owns-software-other-team-firmware', description: 'Responsibilities\nThis role owns developing production software, while maintaining firmware is handled by another team.', category: 'engineering' },
  { key: 'you-are-not-responsible-for-software', description: 'Responsibilities\nYou are not responsible for developing production software; maintaining firmware is handled by another team.', category: 'unconfirmed' },
  { key: 'contextual-role-comma-other-team', description: 'Responsibilities\nFor this role, developing production software and maintaining firmware are handled by another team.', category: 'unconfirmed' },
]

// ---------------------------------------------------------------------------
// Supplement after Astra's readiness review 02 (one uncovered combination).

/**
 * Rule 6: a role introduction the paragraph parser already supports ("In this role",
 * "In this position", "As an engineer …") may precede a governing worker predicate
 * without erasing it; the introduction alone assigns no duty to the worker.
 */
export const FAILURE_INTRODUCTION_BODIES: { key: string; description: string; category: OccupationCategory }[] = [
  { key: 'introduction-you-focus-on', description: 'Responsibilities\nIn this role you focus on developing production software, and maintaining firmware is handled by another team.', category: 'engineering' },
  { key: 'introduction-position-you-are-responsible', description: 'Responsibilities\nIn this position you are responsible for developing production software, and maintaining firmware is handled by another team.', category: 'engineering' },
  { key: 'introduction-as-an-engineer-you-will', description: 'Responsibilities\nAs an engineer on this team you will develop production software, and maintaining firmware is handled by another team.', category: 'engineering' },
  { key: 'introduction-only-other-team', description: 'Responsibilities\nIn this role developing production software and maintaining firmware are handled by another team.', category: 'unconfirmed' },
  { key: 'introduction-you-are-not-responsible', description: 'Responsibilities\nIn this role you are not responsible for developing production software; maintaining firmware is handled by another team.', category: 'unconfirmed' },
  { key: 'headingless-introduction-you-focus-on', description: 'In this role you focus on developing production software, and maintaining firmware is handled by another team.', category: 'engineering' },
  { key: 'headingless-introduction-only-other-team', description: 'In this role developing production software and maintaining firmware are handled by another team.', category: 'unconfirmed' },
]

// ---------------------------------------------------------------------------
// Supplement after Astra's review of the source07 proposal (one extraction regression).

/**
 * Rule 6: an introduction ends at its first role noun. A later "engineer" inside the
 * worker's own duty is a beneficiary or collaborator, not a new subject, and the
 * worker who develops the software keeps that duty; the introduction alone assigns nothing.
 */
export const FAILURE_LATER_ROLE_NOUN_BODIES: { key: string; description: string; category: OccupationCategory }[] = [
  { key: 'introduction-comma-helping-another-engineer', description: 'Responsibilities\nAs an engineer, you focus on helping another engineer by developing production software, and maintaining firmware is handled by another team.', category: 'engineering' },
  { key: 'introduction-no-comma-helping-another-engineer', description: 'Responsibilities\nAs an engineer you focus on helping another engineer by developing production software, and maintaining firmware is handled by another team.', category: 'engineering' },
  { key: 'introduction-software-that-helps-another-engineer', description: 'Responsibilities\nAs an engineer, you develop production software that helps another engineer, and maintaining firmware is handled by another team.', category: 'engineering' },
  { key: 'introduction-with-another-engineer', description: 'Responsibilities\nAs an engineer, you focus on developing production software with another engineer, and maintaining firmware is handled by another team.', category: 'engineering' },
  { key: 'introduction-comma-only-other-team', description: 'Responsibilities\nAs an engineer, developing production software and maintaining firmware are handled by another team.', category: 'unconfirmed' },
  { key: 'introduction-comma-negated-focus', description: 'Responsibilities\nAs an engineer, you are not focused on developing production software; maintaining firmware is handled by another team.', category: 'unconfirmed' },
]
