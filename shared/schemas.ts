import { z } from 'zod'

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
  employment: z.enum(['fulltime', 'parttime', 'contract', 'intern', 'temporary', 'unknown']),
  minExperience: z.number().min(0).max(50).nullable(), skills: z.array(z.string()).max(100),
  salary: z.object({
    min: z.number().nonnegative(), max: z.number().nonnegative(),
    currency: z.enum(['USD', 'EUR', 'GBP', 'CAD', 'SGD', 'AUD', 'KRW', 'JPY', 'CHF']),
  }).nullable(),
  visa: z.enum(['yes', 'conditional', 'no', 'unknown']), remoteCountries: z.array(z.string()).max(300),
  remoteWorldwide: z.boolean(), remoteScopeUnknown: z.boolean(),
  description: z.string().max(30000), requirements: z.array(z.string()).max(50),
  url: z.string().max(2000), source: z.enum(['sample', 'greenhouse']),
  updatedAt: z.string().nullable(), fetchedAt: z.string(),
  evidence: z.object({
    visa: EvidenceSchema.optional(), workMode: EvidenceSchema.optional(), employment: EvidenceSchema.optional(),
  }).optional(),
  stale: z.boolean().optional(),
})
