import { z } from 'zod'
import { COMPENSATION_VERSION, PUBLIC_PROVIDERS, QUALIFICATIONS_VERSION } from './types'

export const JobProviderSchema = z.enum(PUBLIC_PROVIDERS)
const QualificationKindSchema = z.enum(['required', 'qualification', 'preferred', 'context'])

const EvidenceSchema = z.object({
  source: z.enum(['board', 'description', 'title']),
  text: z.string().max(3000),
})

// Shared by saved opportunities and the server's last successful board snapshots.
export const JobSchema = z.object({
  id: z.string().max(200), companyId: z.string().max(100), title: z.string().max(1000),
  role: z.enum(['backend', 'frontend', 'fullstack', 'ml', 'data', 'devops', 'mobile', 'security']),
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
  compensationVersion: z.literal(COMPENSATION_VERSION).optional(),
  visa: z.enum(['yes', 'conditional', 'no', 'unknown']), remoteCountries: z.array(z.string()).max(300),
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
