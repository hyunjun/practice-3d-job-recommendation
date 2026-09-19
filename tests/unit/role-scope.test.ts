import { describe, expect, it } from 'vitest'
import { jobRoleEvidence, jobRoleLabel, jobRoles, matchesJobRole } from '../../shared/job-roles'
import { jobOccupationLabel, upgradeJobOccupation } from '../../shared/job-occupation'
import { matchJob } from '../../shared/matching'
import { createSavedBackup, parseSavedImport } from '../../shared/saved-backup'
import { decodeSavedJobs } from '../../shared/saved-jobs'
import { createSampleCatalog } from '../../shared/sample'
import { createJobRevision } from '../../shared/posting-status'
import { normalizeJob } from '../../server/normalize'
import { JOB_ROLES, SAMPLE_PROFILE } from '../../shared/types'
import type { SavedJob } from '../../shared/types'
import { OUTSIDE_ROLES, outsideRoleJob } from '../fixtures/outside-roles'
import { SEARCH_COMPANIES, SEARCH_TIME } from '../fixtures/search-catalog'

describe('applicable developer roles and preserved public snapshots', () => {
  it.each([1, 2, 3] as const)('does not apply stored specialties outside occupation scope, including version %s', version => {
    for (const [index, fixture] of OUTSIDE_ROLES.entries()) {
      const job = outsideRoleJob(index, version)
      const before = structuredClone(job)
      expect(upgradeJobOccupation(job).occupation?.category).toBe(fixture.category)
      expect(jobRoles(job), fixture.title).toEqual([])
      expect(jobRoleEvidence(job)).toEqual([])
      expect(jobRoleLabel(job)).toBe(jobOccupationLabel(job))
      for (const role of ['all', 'unknown', ...JOB_ROLES] as const) expect(matchesJobRole(job, role), `${fixture.title}: ${role}`).toBe(false)
      expect(job).toEqual(before)
    }
  })

  it('keeps factual skill comparisons but grants no preferred or all-developer role bonus outside scope', () => {
    for (const [index, fixture] of OUTSIDE_ROLES.entries()) {
      const job = outsideRoleJob(index)
      const profile = { ...SAMPLE_PROFILE, skills: ['TypeScript'] }
      const all = matchJob(job, { ...profile, desiredRole: 'all' })
      const preferred = matchJob(job, { ...profile, desiredRole: fixture.role })
      const unrelated = matchJob(job, { ...profile, desiredRole: 'mobile' })
      expect(preferred.score, fixture.title).toBe(all.score)
      expect(unrelated.score).toBe(all.score)
      expect(preferred.reasons).toEqual(all.reasons)
      expect(preferred.reasons.join(' ')).not.toContain('희망하는')
      expect(preferred.cautions.join(' ')).not.toContain('세부 직무를 확인하지 못했어요')
      expect(preferred.matchedSkills).toContain('TypeScript')
      expect(preferred.reasons.length).toBeGreaterThan(0)
    }
  })

  it('keeps unknown development specialties distinct from jobs outside scope and retains sample roles', () => {
    const generic = normalizeJob({
      id: 2901, title: 'Software Engineer', absolute_url: 'https://example.com/engineer',
      location: { name: 'London, UK' }, content: '<h2>Requirements</h2><p>Experience with TypeScript.</p>',
    }, SEARCH_COMPANIES[0].id, SEARCH_TIME)!
    expect(jobRoles(generic)).toEqual([])
    expect(jobRoleLabel(generic)).toBe('세부 직무 미확인')
    expect(matchesJobRole(generic, 'unknown')).toBe(true)
    expect(matchesJobRole(generic, 'all')).toBe(true)
    expect(matchJob(generic, SAMPLE_PROFILE).cautions.join(' ')).toContain('세부 직무를 확인하지 못했어요')
    for (const job of createSampleCatalog().jobs) {
      expect(jobRoles(job)).toEqual([job.role])
      expect(matchesJobRole(job, job.role)).toBe(true)
    }
  })

  it('retains the original specialty and evidence in saved snapshots and JSON without applying them to the current role', () => {
    const original: SavedJob = {
      job: outsideRoleJob(), company: SEARCH_COMPANIES[0], savedAt: SEARCH_TIME,
      status: 'applied', note: 'Private retained writing opportunity',
    }
    const restored = decodeSavedJobs(JSON.stringify([original])).records[0]
    const expected = { ...original, job: upgradeJobOccupation(original.job) }
    expect(restored).toEqual(expected)
    expect(jobRoles(restored.job)).toEqual([])
    expect(restored.job.role).toBe('devops')
    expect(restored.job.roleClassification).toEqual(original.job.roleClassification)
    const backup = createSavedBackup([restored])
    expect(JSON.parse(backup).records).toEqual([expected])
    expect(parseSavedImport(backup).groups[0].variants[0]).toEqual(expected)
  })

  it('ignores inapplicable stored specialties but compares displayed source departments', async () => {
    const original = outsideRoleJob()
    const anotherInference = {
      ...original, role: 'frontend' as const,
      roleClassification: {
        version: 1 as const, roles: ['frontend' as const],
        evidence: [{ role: 'frontend' as const, source: 'board' as const, text: 'Frontend Team' }],
      },
    }
    expect(await createJobRevision(original)).toEqual(await createJobRevision(anotherInference))
    const changedDepartment = {
      ...original, occupation: { ...original.occupation!, departments: ['New Editorial Team'] },
    }
    expect((await createJobRevision(changedDepartment)).title).not.toBe((await createJobRevision(original)).title)
    expect(original.roleClassification?.roles).toEqual(['devops'])
    expect(anotherInference.roleClassification.roles).toEqual(['frontend'])
  })
})
