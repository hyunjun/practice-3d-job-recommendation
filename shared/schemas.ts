import { z } from 'zod'
import { COMPENSATION_VERSION, ELIGIBILITY_VERSION, EMPLOYMENT_VERSION, JOB_ROLES, LANGUAGE_REQUIREMENTS_VERSION, OCCUPATION_VERSION, POSTING_PURPOSE_VERSION, PUBLIC_PROVIDERS, QUALIFICATIONS_VERSION, REMOTE_SCOPE_VERSION, ROLE_CLASSIFICATION_VERSION, SPOKEN_LANGUAGE_CODES, WORK_TIME_REQUIREMENTS_VERSION, WORK_TIME_REQUIREMENT_KINDS } from './types'

export const JobProviderSchema = z.enum(PUBLIC_PROVIDERS)
const QualificationKindSchema = z.enum(['required', 'qualification', 'preferred', 'context'])

const EvidenceSchema = z.object({
  source: z.enum(['board', 'description', 'title']),
  text: z.string().max(3000),
})

// Shared by saved opportunities and the server's last successful board snapshots.
export const JobSchema = z.object({
  id: z.string().max(200), companyId: z.string().max(100), title: z.string().max(1000),
  role: z.enum([...JOB_ROLES, 'unknown']),
  postingPurpose: z.object({
    version: z.literal(POSTING_PURPOSE_VERSION), kind: z.literal('talent-pool'),
    basis: z.enum(['greenhouse-prospect', 'description']),
    evidence: z.array(EvidenceSchema.extend({ text: z.string().min(1).max(3000) })).min(1).max(4),
  }).refine(value => value.evidence.every(item => item.text.trim().length > 0
    && item.source === (value.basis === 'greenhouse-prospect' ? 'board' : 'description'))).optional(),
  roleClassification: z.object({
    version: z.literal(ROLE_CLASSIFICATION_VERSION),
    roles: z.array(z.enum(JOB_ROLES)).max(JOB_ROLES.length),
    evidence: z.array(z.object({
      role: z.enum(JOB_ROLES), source: z.enum(['title', 'board', 'description']), text: z.string().min(1).max(3000),
    })).max(20 * JOB_ROLES.length),
  }).refine(value => new Set(value.roles).size === value.roles.length
    && value.roles.every(role => value.evidence.some(item => item.role === role))
    && value.evidence.every(item => value.roles.includes(item.role))).optional(),
  occupation: z.object({
    version: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(OCCUPATION_VERSION)]),
    category: z.enum(['engineering', 'research', 'support', 'management', 'other', 'unconfirmed']),
    evidence: z.array(EvidenceSchema).min(1).max(8),
    departments: z.array(z.string().min(1).max(1000)).max(20),
    management: z.object({
      value: z.enum(['individual', 'management', 'unknown']), evidence: EvidenceSchema.optional(),
    }).optional(),
  }).optional(),
  cityIds: z.array(z.string()).max(50), locationLabel: z.string().max(2000),
  workplaceLocations: z.object({
    version: z.literal(1),
    locations: z.array(z.object({
      label: z.string().max(2000), country: z.string().min(1).max(1000).optional(),
    })).min(1).max(300),
    truncated: z.boolean().optional(),
  }).optional(),
  locationResolution: z.object({
    version: z.literal(1), status: z.enum(['relocation', 'conflict']),
    listedCityIds: z.array(z.string()).min(1).max(50), listedLabel: z.string().max(2000),
    statedCityIds: z.array(z.string()).min(1).max(50), statedLabel: z.string().min(1).max(2000),
    evidence: z.array(EvidenceSchema).min(1).max(9),
  }).refine(value => value.evidence.some(item => item.source === 'description')
    && (value.status !== 'relocation' || value.evidence.some(item => item.source === 'title'))
    && new Set(value.listedCityIds).size === value.listedCityIds.length
    && new Set(value.statedCityIds).size === value.statedCityIds.length).optional(),
  workMode: z.enum(['remote', 'hybrid', 'onsite', 'unknown']),
  employment: z.enum(['fulltime', 'parttime', 'permanent', 'contract', 'intern', 'temporary', 'unknown']),
  employmentVersion: z.literal(EMPLOYMENT_VERSION).optional(),
  minExperience: z.number().min(0).max(50).nullable(), skills: z.array(z.string()).max(100),
  qualifications: z.object({
    version: z.literal(QUALIFICATIONS_VERSION),
    skills: z.array(z.object({
      kind: QualificationKindSchema, skills: z.array(z.string().max(100)).min(1).max(100),
      match: z.enum(['all', 'any', 'unspecified']), evidence: EvidenceSchema,
    })).max(100),
    experience: z.array(z.object({
      kind: QualificationKindSchema, minYears: z.number().min(0).max(50),
      maxYears: z.number().min(0).max(50).optional(), conditional: z.boolean(), evidence: EvidenceSchema,
    }).refine(rule => rule.maxYears === undefined || rule.maxYears >= rule.minYears)).max(100),
    experienceNote: z.string().max(1000).optional(), truncated: z.boolean().optional(),
  }).optional(),
  languageRequirements: z.object({
    version: z.literal(LANGUAGE_REQUIREMENTS_VERSION),
    rules: z.array(z.object({
      languages: z.array(z.enum(SPOKEN_LANGUAGE_CODES)).min(1).max(SPOKEN_LANGUAGE_CODES.length),
      kind: z.enum(['required', 'qualification', 'preferred']),
      match: z.enum(['all', 'any', 'unspecified']),
      scope: z.string().min(1).max(200).optional(),
      evidence: EvidenceSchema.extend({ source: z.literal('description'), text: z.string().min(1).max(3000) }),
    }).refine(rule => new Set(rule.languages).size === rule.languages.length && rule.evidence.text.trim().length > 0
      && (!rule.scope || rule.scope.trim().length > 0 && rule.evidence.text.includes(rule.scope)))).max(50),
    truncated: z.boolean().optional(),
  }).optional(),
  workTimeRequirements: z.object({
    version: z.literal(WORK_TIME_REQUIREMENTS_VERSION),
    rules: z.array(z.object({
      kind: z.enum(WORK_TIME_REQUIREMENT_KINDS),
      level: z.enum(['required', 'preferred', 'stated']),
      statement: z.string().min(1).max(1000),
      scope: z.string().min(1).max(200).optional(),
      evidence: EvidenceSchema.extend({ source: z.literal('description'), text: z.string().min(1).max(3000) }),
    }).refine(rule => rule.statement.trim().length > 0 && rule.evidence.text.includes(rule.statement)
      && (!rule.scope || rule.scope.trim().length > 0 && rule.evidence.text.includes(rule.scope)))).max(50),
    truncated: z.boolean().optional(),
  }).optional(),
  salary: z.object({
    min: z.number().nonnegative(), max: z.number().nonnegative(),
    currency: z.enum(['USD', 'EUR', 'GBP', 'CAD', 'SGD', 'AUD', 'KRW', 'JPY', 'CHF']),
  }).nullable(),
  compensationRanges: z.array(z.object({
    label: z.string().max(500),
    min: z.number().nonnegative(), max: z.number().nonnegative(),
    currency: z.string().regex(/^[A-Z]{3}$/).nullable(),
    period: z.enum(['year', 'month', 'week', 'day', 'hour', 'unknown']),
    basis: z.enum(['base', 'total', 'unknown']).optional(),
    scope: z.string().max(500).optional(),
    evidence: EvidenceSchema.optional(),
  }).refine(range => range.max >= range.min)).max(100).optional(),
  compensationNote: z.string().max(1000).optional(),
  compensationEvidence: z.array(EvidenceSchema).max(20).optional(),
  compensationVersion: z.union([z.literal(1), z.literal(COMPENSATION_VERSION)]).optional(),
  visa: z.enum(['yes', 'conditional', 'no', 'unknown']), remoteCountries: z.array(z.string()).max(300),
  eligibility: z.object({
    version: z.union([z.literal(1), z.literal(ELIGIBILITY_VERSION)]),
    rules: z.array(z.object({
      kind: z.enum(['sponsorship-scope', 'work-authorization', 'citizenship', 'residency', 'security-clearance', 'export-authorization']),
      level: z.enum(['required', 'conditional', 'preferred', 'unspecified']),
      evidence: EvidenceSchema,
    })).max(50),
    truncated: z.boolean().optional(),
  }).optional(),
  remoteWorldwide: z.boolean(), remoteScopeUnknown: z.boolean(),
  remoteRegions: z.array(z.enum(['americas', 'europe', 'asia-pacific'])).max(3).optional(),
  remoteScopeVersion: z.union([z.literal(1), z.literal(REMOTE_SCOPE_VERSION)]).optional(),
  remoteScopeResolution: z.object({
    version: z.literal(1), status: z.enum(['description', 'unconfirmed']),
    listedCountries: z.array(z.string()).max(300), listedWorldwide: z.boolean(),
    evidence: z.array(EvidenceSchema.extend({ source: z.literal('description'), text: z.string().min(1).max(3000) })).min(1).max(8),
    truncated: z.boolean().optional(),
  }).refine(value => new Set(value.listedCountries).size === value.listedCountries.length).optional(),
  description: z.string().max(30000), requirements: z.array(z.string()).max(50),
  url: z.string().max(2000), source: z.enum(['sample', ...PUBLIC_PROVIDERS]),
  updatedAt: z.string().nullable(), fetchedAt: z.string(),
  evidence: z.object({
    visa: EvidenceSchema.optional(), workMode: EvidenceSchema.optional(), employment: EvidenceSchema.optional(),
  }).optional(),
  stale: z.boolean().optional(),
}).refine(job => job.postingPurpose?.basis !== 'greenhouse-prospect' || job.source === 'greenhouse', {
  path: ['postingPurpose'], message: 'Greenhouse prospect evidence requires a Greenhouse posting',
})
