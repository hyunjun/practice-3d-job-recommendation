import { JOB_ROLES, ROLE_CLASSIFICATION_VERSION, ROLE_FILTER_LABELS } from './types'
import type { Filters, Job, JobOccupation, JobRoleClassification, KnownJobRole } from './types'
import { isTechnicalJob, jobOccupationLabel } from './job-occupation'

// Titles take precedence over department/team labels. Only research vacancies may
// also use the job-specific evidence already checked by the occupation classifier.
// Languages, company descriptions and industry names do not establish a role.
const PATTERNS: Record<KnownJobRole, RegExp> = {
  backend: /\b(?:back[\s-]?end|server[\s-]side)\b|백엔드/i,
  frontend: /\b(?:front[\s-]?end|client[\s-]side)\b|프론트엔드/i,
  fullstack: /\bfull[\s-]?stack\b|풀스택/i,
  ml: /\b(?:(?:machine|deep|reinforcement)[\s-]+learning|artificial intelligence|ai|ml)\b|머신러닝|딥러닝|강화학습|인공지능/i,
  data: /\b(?:data(?:[\s-]+(?:platform|infrastructure|analytics))?[\s-]+(?:engineer(?:ing)?|scientist)|analytics[\s-]+engineer(?:ing)?|data[\s-]+science)\b|데이터\s*(?:엔지니어|과학|분석)/i,
  devops: /\b(?:dev[\s-]?ops|infra(?:structure)?|site[\s-]+reliability|sre|platforms?[\s-]+engineer(?:ing)?|engineer(?:ing)?[,\s:/()–—-]+(?:application[\s-]+)?platforms?|cloud[\s-]+engineer(?:ing)?)\b|인프라/i,
  mobile: /\b(?:mobile|android|ios)\b|모바일/i,
  security: /\b(?:cyber[\s-]?)?security\b|보안/i,
}

function rolesIn(text: string): KnownJobRole[] {
  const normalized = text.normalize('NFKC').replace(/[‐‑–—]/g, '-')
  return JOB_ROLES.filter(role => PATTERNS[role].test(normalized))
}

export function classifyJobRoles(title: string, departments: string[] = [], occupation?: JobOccupation): JobRoleClassification {
  const titleEvidence = title.trim().slice(0, 1000)
  const titleRoles = rolesIn(titleEvidence)
  if (titleRoles.length) return {
    version: ROLE_CLASSIFICATION_VERSION, roles: titleRoles,
    evidence: titleRoles.map(role => ({ role, source: 'title', text: titleEvidence })),
  }
  // A precise title takes precedence over a broader team. For generic titles, a
  // declared specialty such as "Data Engineering" is useful; plain "Engineering" is not.
  let evidence: JobRoleClassification['evidence'] = [...new Set(departments.map(value => value.trim().slice(0, 1000)).filter(Boolean))]
    .slice(0, 20).flatMap(text => {
      const roles = rolesIn(text)
      if (/^platforms?$/i.test(text) && !roles.includes('devops')) roles.push('devops')
      return roles.map(role => ({ role, source: 'board' as const, text }))
    })
  if (!evidence.length && occupation?.category === 'research') {
    evidence = occupation.evidence.filter(item => item.source === 'description').flatMap(item => {
      const roles: KnownJobRole[] = []
      if (PATTERNS.ml.test(item.text)
        || /\b(?:llms?|(?:large )?language models?|neural networks?|model training|(?:pre|post)[- ]training)\b/i.test(item.text)) roles.push('ml')
      return roles.map(role => ({ role, ...item }))
    })
  }
  const roles = JOB_ROLES.filter(role => evidence.some(item => item.role === role))
  return { version: ROLE_CLASSIFICATION_VERSION, roles, evidence }
}

/** Reclassify legacy public records without changing their collection or save time. */
export function upgradeJobRole<T extends Job>(job: T): T {
  if (job.source === 'sample') return job
  const roleClassification = job.roleClassification?.roles.length ? job.roleClassification
    : classifyJobRoles(job.title, job.occupation?.departments, job.occupation)
  const role = roleClassification.roles[0] ?? 'unknown'
  return job.roleClassification && job.role === role
    && (job.roleClassification.roles.length > 0 || !roleClassification.roles.length)
    ? job : { ...job, role, roleClassification }
}

export function jobRoles(job: Job): KnownJobRole[] {
  if (!isTechnicalJob(job)) return []
  const current = upgradeJobRole(job)
  return current.roleClassification?.roles ?? (current.role === 'unknown' ? [] : [current.role])
}

/** Preserve earlier inferences in the snapshot; only expose applicable specialties. */
export function jobRoleEvidence(job: Job): JobRoleClassification['evidence'] {
  return isTechnicalJob(job) ? upgradeJobRole(job).roleClassification?.evidence ?? [] : []
}

export function matchesJobRole(job: Job, role: Filters['role']): boolean {
  if (!isTechnicalJob(job)) return false
  if (role === 'all') return true
  const roles = jobRoles(job)
  return role === 'unknown' ? roles.length === 0 : roles.includes(role)
}

export function jobRoleLabel(job: Job): string {
  if (!isTechnicalJob(job)) return jobOccupationLabel(job)
  const roles = jobRoles(job)
  return roles.length ? roles.map(role => ROLE_FILTER_LABELS[role]).join(' · ') : ROLE_FILTER_LABELS.unknown
}
