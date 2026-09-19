import { z } from 'zod'
import { COMPENSATION_VERSION, ELIGIBILITY_VERSION, JOB_ROLES, OCCUPATION_VERSION, PUBLIC_PROVIDERS, QUALIFICATIONS_VERSION, ROLE_CLASSIFICATION_VERSION } from './types'

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
    version: z.union([z.literal(1), z.literal(OCCUPATION_VERSION)]),
    category: z.enum(['engineering', 'research', 'support', 'management', 'other', 'unconfirmed']),
    evidence: z.array(EvidenceSchema).min(1).max(8),
    departments: z.array(z.string().min(1).max(1000)).max(20),
    management: z.object({
      value: z.enum(['individual', 'management', 'unknown']), evidence: EvidenceSchema.optional(),
    }).optional(),
  }).optional(),
  cityIds: z.array(z.string()).max(50), locationLabel: z.string().max(2000),
  workMode: z.enum(['remote', 'hybrid', 'onsite', 'unknown']),
  employment: z.enum(['fulltime', 'parttime', 'permanent', 'contract', 'intern', 'temporary', 'unknown']),
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
    version: z.literal(ELIGIBILITY_VERSION),
    rules: z.array(z.object({
      kind: z.enum(['sponsorship-scope', 'work-authorization', 'citizenship', 'residency', 'security-clearance', 'export-authorization']),
      level: z.enum(['required', 'conditional', 'preferred', 'unspecified']),
      evidence: EvidenceSchema,
    })).max(50),
    truncated: z.boolean().optional(),
  }).optional(),
  remoteWorldwide: z.boolean(), remoteScopeUnknown: z.boolean(),
  remoteRegions: z.array(z.enum(['americas', 'europe', 'asia-pacific'])).max(3).optional(),
  description: z.string().max(30000), requirements: z.array(z.string()).max(50),
  url: z.string().max(2000), source: z.enum(['sample', ...PUBLIC_PROVIDERS]),
  updatedAt: z.string().nullable(), fetchedAt: z.string(),
  evidence: z.object({
    visa: EvidenceSchema.optional(), workMode: EvidenceSchema.optional(), employment: EvidenceSchema.optional(),
  }).optional(),
  stale: z.boolean().optional(),
})
