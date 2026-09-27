import type { Job, JobOccupation, SavedJob } from '../../shared/types'
import { careersCachedJob, careersCompany } from './careers-contract'

// Invented duties and metadata. No employer's collected text is reproduced.
export const TEXTILE_DESIGN_BODY = 'Responsibilities\nDesign woven textile structures and select yarn materials for a fictional sofa. Inspect fabric durability using physical abrasion tests.\nRequirements\nExperience with textile manufacturing.'
export const SOFTWARE_DESIGN_BODY = 'Responsibilities\nBuild production frontend software and maintain application code for a fictional storefront. Implement automated software tests.\nRequirements\nExperience with software development and TypeScript.'

export interface IndustryCase {
  title: string
  description: string
  departments: string[]
  category: JobOccupation['category']
  included: boolean
}
export const INDUSTRY_CASES: IndustryCase[] = [
  { title: 'Design Engineer', description: TEXTILE_DESIGN_BODY, departments: ['Product Development'], category: 'other', included: false },
  { title: 'Design Engineer', description: SOFTWARE_DESIGN_BODY, departments: ['Digital Products'], category: 'engineering', included: true },
  { title: 'Design Engineer', description: '', departments: ['Product Development'], category: 'unconfirmed', included: false },
  { title: 'Business Developer', description: 'Responsibilities\nNegotiate wholesale agreements and manage commercial account revenue.', departments: ['Engineering'], category: 'other', included: false },
  { title: 'Business Developer, Software Partnerships', description: 'Responsibilities\nDevelop commercial relationships and negotiate sales contracts.', departments: ['Technology'], category: 'other', included: false },
  { title: 'Software Engineering - Mgr - G', description: 'Responsibilities\nManage a team of software engineers and conduct performance reviews.', departments: ['Engineering'], category: 'management', included: false },
  { title: 'Software Engineer, Resource Manager', description: SOFTWARE_DESIGN_BODY, departments: ['Engineering'], category: 'engineering', included: true },
  { title: 'Engineer, Interiors', description: 'Responsibilities\nDesign physical dashboard trim and select upholstery materials.', departments: ['Vehicle Engineering'], category: 'other', included: false },
  { title: 'Engineer, Charging Software Testing', description: 'Responsibilities\nImplement automated software tests and maintain charging simulator code.', departments: ['Vehicle Engineering'], category: 'engineering', included: true },
  { title: 'Process Engineer', description: 'Responsibilities\nQualify assembly processes and inspect stamping fixtures.', departments: ['Manufacturing'], category: 'other', included: false },
  { title: 'CAD Engineer', description: 'Responsibilities\nCreate physical body panel drawings and dimension mechanical fixtures.', departments: ['Body Structures'], category: 'other', included: false },
  { title: 'Supplier Industrialization Engineer', description: 'Responsibilities\nAudit physical component production and validate supplier assembly processes.', departments: ['Supplier Operations'], category: 'other', included: false },
  { title: 'NVH Test Engineer', description: 'Responsibilities\nMeasure vehicle acoustic noise and vibration using physical test rigs.', departments: ['Vehicle Engineering'], category: 'other', included: false },
  { title: 'Battery Test Engineer', description: 'Responsibilities\nCycle battery cells in a laboratory and measure physical degradation.', departments: ['Energy Storage'], category: 'other', included: false },
  { title: 'Engineer, Supplier Quality', description: 'Responsibilities\nInspect supplied castings and verify physical component tolerances.', departments: ['Supplier Quality'], category: 'other', included: false },
  { title: 'Systems Engineer', description: 'Responsibilities\nSpecify body wiring and validate battery assemblies.', departments: ['Vehicle Engineering'], category: 'other', included: false },
  { title: 'Test Engineer', description: 'Responsibilities\nPerform physical battery abuse tests and inspect cell damage.', departments: ['Battery Validation'], category: 'other', included: false },
  { title: 'Quality Engineer', description: 'Responsibilities\nAudit factory production and inspect finished materials.', departments: ['Corporate Quality'], category: 'other', included: false },
  { title: 'Firmware Engineer, Battery Controls', description: SOFTWARE_DESIGN_BODY, departments: ['Battery Validation'], category: 'engineering', included: true },
  { title: 'Embedded Engineer, Interiors Controller', description: SOFTWARE_DESIGN_BODY, departments: ['Vehicle Engineering'], category: 'engineering', included: true },
  { title: 'EDA Engineer', description: '', departments: ['RFIC Engineering'], category: 'engineering', included: true },
  { title: 'RTL Design Engineer', description: '', departments: ['Materials Engineering'], category: 'engineering', included: true },
  { title: 'MES Engineer', description: '', departments: ['Manufacturing'], category: 'engineering', included: true },
  { title: 'Engineer', description: '', departments: ['Marketing'], category: 'engineering', included: true },
  { title: 'Marketing Engineer', description: '', departments: ['Marketing'], category: 'engineering', included: true },
  { title: 'Developer Relations Engineer', description: '', departments: ['Marketing'], category: 'engineering', included: true },
  { title: 'Design Engineer', description: 'You will\nBuild backend APIs and frontend components for a fictional creator platform.\nYou have\nExperience implementing production applications.', departments: ['Product Engineering'], category: 'engineering', included: true },
  { title: 'Design Engineer', description: 'You have\nExperience building frontend applications with React and TypeScript.', departments: ['Product Engineering'], category: 'engineering', included: true },
  { title: 'Web Design Engineer', description: '', departments: ['Digital Products'], category: 'engineering', included: true },
  { title: 'Principal Systems Design Engineer', description: '', departments: ['Digital Technology'], category: 'engineering', included: true },
  { title: 'Staff Systems Test Engineer, Scenario Quality and Maintenance Systems', description: 'Responsibilities\nBuild simulation software and maintain automated scenario test APIs for a fictional vehicle simulator.', departments: ['Scenario Systems'], category: 'engineering', included: true },
  { title: 'Network Engineer, Battery Storage', description: 'Responsibilities\nImplement network protocols and maintain routing infrastructure for a fictional storage service.', departments: ['Battery Storage'], category: 'engineering', included: true },
  { title: 'Maintenance Engineer', description: 'Responsibilities\nInspect physical factory machinery and replace worn mechanical assemblies.', departments: ['Manufacturing'], category: 'other', included: false },
  { title: 'Design Engineer', description: 'About us\nWe build frontend components and backend APIs for international creators.', departments: ['Product Development'], category: 'unconfirmed', included: false },
  { title: 'Design Engineer', description: TEXTILE_DESIGN_BODY, departments: ['Digital Technology'], category: 'other', included: false },
  { title: 'Web Product Designer', description: 'Responsibilities\nDesign visual brand assets and conduct customer interviews.', departments: ['Digital Technology'], category: 'other', included: false },
  { title: 'Business Developer, Backend APIs', description: 'Responsibilities\nNegotiate commercial partnerships and manage annual sales revenue.', departments: ['Technology'], category: 'other', included: false },
  { title: 'Design Engineer', description: 'Your general responsibilities might include:\nBuild frontend applications and backend APIs for a fictional workflow platform.', departments: ['Product Development'], category: 'engineering', included: true },
  { title: 'Design Engineer', description: 'Your specific responsibilities might include:\nImplement production software and maintain application code for a fictional design platform.', departments: ['Product Development'], category: 'engineering', included: true },
  { title: 'Design Engineer', description: 'What you bring\nExperience building frontend interfaces with React and TypeScript.', departments: ['Product Development'], category: 'engineering', included: true },
  { title: 'Principal Market Developer Loyalty Program - Western Europe', description: 'Responsibilities:\nDevelop regional customer loyalty strategies, review competitor positioning, and present market expansion proposals to executives.\nQualifications:\nExperience in commercial strategy and business development.', departments: ['Business Development & Strategy', 'Loyalty Market Development'], category: 'other', included: false },
  { title: 'dir engineering – Global Technology Strategy & Enablement', description: 'Responsibilities:\nAs a director of engineering, lead engineering managers, set budgets, hire staff, and own the global technology strategy.\nQualifications:\nFive years of experience leading engineering managers and conducting performance reviews.', departments: ['Technology', 'Engineering'], category: 'management', included: false },
  { title: 'Software Engineer, Market Developer Platform', description: SOFTWARE_DESIGN_BODY, departments: ['Software Engineering'], category: 'engineering', included: true },
  { title: 'Directory Services Engineer', description: SOFTWARE_DESIGN_BODY, departments: ['Digital Technology'], category: 'engineering', included: true },
]

export const INDUSTRY_PUBLISHED_IDS = [
  'careers-zalando-642001', 'careers-zalando-642002', 'careers-zalando-642003', 'careers-zalando-642004',
]

/** Known v5 mistakes remain historical input; cache envelope version is also 5. */
export function industryV5Jobs(): Job[] {
  const fixtures = [
    { id: 'careers-zalando-642001', native: '642001', title: 'Design Engineer', description: TEXTILE_DESIGN_BODY, departments: ['Product Development'] },
    { id: 'careers-zalando-642002', native: '642002', title: 'Design Engineer', description: SOFTWARE_DESIGN_BODY, departments: ['Digital Products'] },
    { id: 'careers-zalando-642003', native: '642003', title: 'Business Developer', description: 'Responsibilities\nNegotiate commercial sales agreements for a fictional furniture supplier.', departments: ['Commerce'] },
    { id: 'careers-zalando-642004', native: '642004', title: 'Design Engineer', description: '', departments: ['Product Development'] },
  ]
  return fixtures.map(fixture => ({
    ...careersCachedJob(), id: fixture.id, companyId: 'zalando', title: fixture.title,
    description: fixture.description, cityIds: ['berlin'], locationLabel: 'Berlin, Germany',
    role: 'unknown', skills: [], minExperience: null, requirements: [],
    url: `https://jobs.zalando.com/en/jobs/${fixture.native}`,
    updatedAt: '2026-10-01T12:00:00.000Z',
    occupation: {
      version: 5, category: 'engineering',
      evidence: [{ source: 'title', text: fixture.title }], departments: fixture.departments,
    },
  }))
}

export function industryV5Saved(): SavedJob {
  return {
    job: industryV5Jobs()[0], company: careersCompany('zalando'),
    savedAt: '2026-10-02T10:05:00.000Z', status: 'applied',
    note: 'Synthetic textile application note64; keep my original source.',
  }
}
