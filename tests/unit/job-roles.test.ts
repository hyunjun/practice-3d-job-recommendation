import { afterEach, describe, expect, it, vi } from 'vitest'
import { classifyJobRoles, jobRoleLabel, jobRoles, matchesJobRole, upgradeJobRole } from '../../shared/job-roles'
import { JobSchema } from '../../shared/schemas'
import { createSampleCatalog } from '../../shared/sample'
import { filterJobs, groupCities, matchJob } from '../../shared/matching'
import { createSearchIndex } from '../../shared/job-search'
import { analyzeSearchRecovery } from '../../shared/search-recovery'
import { createJobRevision, REVISION_FIELDS } from '../../shared/posting-status'
import { DEFAULT_FILTERS, SAMPLE_PROFILE } from '../../shared/types'
import { parseCachedBoards } from '../../server/board-cache'
import { normalizeJob } from '../../server/normalize'
import { AshbyJobSchema, normalizeAshbyJob } from '../../server/providers/ashby'
import { LeverJobSchema, normalizeLeverJob } from '../../server/providers/lever'
import { loadExploration, loadProfile, loadSaved, STORAGE_KEYS } from '../../src/lib/storage'
import { SEARCH_COMPANIES, SEARCH_TIME, searchCatalog } from '../fixtures/search-catalog'

const company = SEARCH_COMPANIES[0]
function posting(title: string, departments: string[] = [], id = 1) {
  return normalizeJob({
    id, title, departments: departments.map(name => ({ name })),
    absolute_url: `https://example.com/jobs/${id}`, location: { name: 'London, UK' },
    content: '<h2>Requirements</h2><p>Experience with TypeScript.</p>',
  }, company.id, SEARCH_TIME)!
}
afterEach(() => vi.unstubAllGlobals())

describe('role classification from published labels', () => {
  it('keeps a generic engineer unclassified instead of inventing full-stack duties from languages or company context', () => {
    const generic = posting('Software Engineer', ['Engineering', 'Product'])
    expect(generic.role).toBe('unknown')
    expect(generic.roleClassification).toEqual({ version: 1, roles: [], evidence: [] })
    expect(jobRoleLabel(generic)).toBe('세부 직무 미확인')
    expect(matchesJobRole({ ...generic, description: 'Python, React and Node.js. We are an AI company.' }, 'fullstack')).toBe(false)
    expect(jobRoles({ ...generic, description: 'Frontend and backend teams use our tools.' })).toEqual([])
  })

  it('requires explicit full-stack wording and preserves other explicitly named roles', () => {
    expect(jobRoles(posting('Full Stack Engineer'))).toEqual(['fullstack'])
    expect(jobRoles(posting('Full‑Stack Software Engineer'))).toEqual(['fullstack'])
    expect(jobRoles(posting('Applied AI, Fullstack Software Engineer'))).toEqual(['fullstack', 'ml'])
    expect(jobRoles(posting('Backend / Frontend Engineer'))).toEqual(['backend', 'frontend'])
    expect(jobRoles(posting('Backend / Frontend Engineer'))).not.toContain('fullstack')
  })

  it('handles inverted platform titles, spaces and language boundaries without matching iOS inside other words', () => {
    expect(jobRoles(posting('Software Engineer, Platform'))).toEqual(['devops'])
    expect(jobRoles(posting('Software Engineer - Application Platform'))).toEqual(['devops'])
    expect(jobRoles(posting('Senior iOS Engineer'))).toEqual(['mobile'])
    expect(jobRoles(posting('Software Engineer, Studios'))).toEqual([])
    expect(jobRoles(posting('Biosystems Software Engineer'))).toEqual([])
    expect(classifyJobRoles('백엔드 개발자').roles).toEqual(['backend'])
    expect(classifyJobRoles('프론트엔드 개발자').roles).toEqual(['frontend'])
  })

  it('retains cybersecurity compound words and explicit reinforcement or deep-learning specialties', () => {
    expect(jobRoles(posting('Software Engineer, CyberSecurity', ['Infrastructure']))).toEqual(['security'])
    expect(jobRoles(posting('Cyber-Security Engineer'))).toEqual(['security'])
    expect(jobRoles(posting('Research Engineer, Cybersecurity RL (Reinforcement Learning)'))).toEqual(['ml', 'security'])
    expect(jobRoles(posting('Full-Stack Software Engineer, Reinforcement Learning'))).toEqual(['fullstack', 'ml'])
    expect(jobRoles(posting('Software Engineer, Deep Learning'))).toEqual(['ml'])
  })

  it('uses specific departments only when a title does not identify a role', () => {
    expect(posting('Software Engineer', ['Engineering', 'Data Engineering']).roleClassification).toEqual({
      version: 1, roles: ['data'], evidence: [{ role: 'data', source: 'board', text: 'Data Engineering' }],
    })
    expect(jobRoles(posting('Frontend Engineer', ['Security', 'AI Research & Engineering']))).toEqual(['frontend'])
    expect(jobRoles(posting('Software Engineer', ['Platform']))).toEqual(['devops'])
    expect(jobRoles(posting('Design Engineer', ['Design']))).toEqual([])
    expect(jobRoles(posting('Marketing Engineer', ['Marketing']))).toEqual([])
  })

  it('preserves published department and team fields through both Ashby and Lever validation', () => {
    const ashby = AshbyJobSchema.parse({
      id: 'ashby-one', title: 'Software Engineer', jobUrl: 'https://example.com/ashby-one', isListed: true,
      department: 'Engineering', team: 'Data Engineering',
    })
    const lever = LeverJobSchema.parse({
      id: 'lever-one', text: 'Software Engineer', hostedUrl: 'https://example.com/lever-one',
      categories: { department: 'Engineering', team: 'Site Reliability Engineering' },
    })
    expect(normalizeAshbyJob(ashby, company.id, SEARCH_TIME)?.roleClassification).toMatchObject({
      roles: ['data'], evidence: [{ source: 'board', text: 'Data Engineering' }],
    })
    expect(normalizeLeverJob(lever, company.id, SEARCH_TIME)?.roleClassification).toMatchObject({
      roles: ['devops'], evidence: [{ source: 'board', text: 'Site Reliability Engineering' }],
    })
    expect(normalizeAshbyJob({ ...ashby, isListed: false }, company.id, SEARCH_TIME)).toBeNull()
  })

  it('bounds and deduplicates evidence and rejects unsupported or contradictory stored classifications', () => {
    const classified = posting('Software Engineer', ['Data Engineering', 'Data Engineering', 'Engineering'])
    expect(classified.roleClassification?.evidence).toHaveLength(1)
    expect(JobSchema.safeParse(classified).success).toBe(true)
    expect(classifyJobRoles('Software Engineer', Array.from({ length: 50 }, (_, index) => `Data Engineering ${index}${'x'.repeat(2000)}`)).evidence).toHaveLength(20)
    for (const roleClassification of [
      { version: 2, roles: ['data'], evidence: [] },
      { version: 1, roles: ['data'], evidence: [] },
      { version: 1, roles: [], evidence: [{ role: 'data', source: 'board', text: 'Data Engineering' }] },
      { version: 1, roles: ['data', 'data'], evidence: [{ role: 'data', source: 'board', text: 'Data Engineering' }] },
    ]) expect(JobSchema.safeParse({ ...classified, roleClassification }).success).toBe(false)
  })
})

describe('role filtering, matching and recovery', () => {
  const generic = posting('Software Engineer', [], 1)
  const fullstack = posting('Full Stack Engineer', [], 2)
  const combined = posting('Backend / Frontend Engineer', [], 3)
  const catalog = searchCatalog([generic, fullstack, combined])

  it('retains unknown jobs in all roles and keeps unique job and company counts for multiple role labels', () => {
    const all = filterJobs(catalog, SAMPLE_PROFILE, DEFAULT_FILTERS)
    expect(all).toHaveLength(3)
    expect(groupCities(catalog, all, DEFAULT_FILTERS)[0].companyCount).toBe(1)
    expect(filterJobs(catalog, SAMPLE_PROFILE, { ...DEFAULT_FILTERS, role: 'fullstack' }).map(item => item.job.id)).toEqual([fullstack.id])
    expect(filterJobs(catalog, SAMPLE_PROFILE, { ...DEFAULT_FILTERS, role: 'unknown' }).map(item => item.job.id)).toEqual([generic.id])
    for (const role of ['backend', 'frontend'] as const) {
      expect(filterJobs(catalog, SAMPLE_PROFILE, { ...DEFAULT_FILTERS, role }).map(item => item.job.id)).toEqual([combined.id])
      expect(matchJob(combined, { ...SAMPLE_PROFILE, desiredRole: role }).score).toBe(matchJob(combined, { ...SAMPLE_PROFILE, desiredRole: 'all' }).score + 10)
    }
    expect(filterJobs(catalog, SAMPLE_PROFILE, { ...DEFAULT_FILTERS, query: '풀스택' }).map(item => item.job.id)).toEqual([fullstack.id])
    expect(filterJobs(catalog, SAMPLE_PROFILE, { ...DEFAULT_FILTERS, query: '프론트엔드' }).map(item => item.job.id)).toEqual([combined.id])
  })

  it('never grants a preferred-role bonus to an unknown role or bypasses the profile rule with the unknown filter', () => {
    const all = matchJob(generic, SAMPLE_PROFILE)
    const preferred = matchJob(generic, { ...SAMPLE_PROFILE, desiredRole: 'fullstack' })
    expect(preferred.score).toBe(all.score - 15)
    expect(preferred.reasons.join(' ')).not.toContain('풀스택')
    expect(preferred.cautions.join(' ')).toContain('세부 직무를 확인하지 못했어요')
    const unrelatedProfile = { ...SAMPLE_PROFILE, skills: ['Rust'] }
    expect(filterJobs(catalog, unrelatedProfile, { ...DEFAULT_FILTERS, role: 'unknown' })).toHaveLength(0)
    expect(filterJobs(catalog, unrelatedProfile, { ...DEFAULT_FILTERS, role: 'fullstack' })).toHaveLength(1)
  })

  it('previews the exact count recovered from a role change without changing any filters', () => {
    const filters = { ...DEFAULT_FILTERS, role: 'fullstack' as const }
    const onlyGeneric = searchCatalog([generic])
    const analysis = analyzeSearchRecovery(createSearchIndex(onlyGeneric, SAMPLE_PROFILE), filters, { kind: 'cities' })!
    expect(analysis.suggestions).toMatchObject([{ changes: { role: 'all' }, count: { jobs: 1, companies: 1, cities: 1 } }])
    expect(filterJobs(onlyGeneric, SAMPLE_PROFILE, { ...filters, ...analysis.suggestions[0].changes })).toHaveLength(1)
    expect(filters.role).toBe('fullstack')
    const unknown = analyzeSearchRecovery(createSearchIndex(searchCatalog([fullstack]), SAMPLE_PROFILE), { ...filters, role: 'unknown' }, { kind: 'cities' })!
    expect(unknown.suggestions[0].changes).toEqual({ role: 'all' })
  })

  it('leaves the explicitly designed sample scenarios unchanged', () => {
    const sample = createSampleCatalog()
    for (const job of sample.jobs) {
      expect(upgradeJobRole(job)).toBe(job)
      expect(jobRoles(job)).toEqual([job.role])
    }
  })
})

describe('role upgrades and saved content comparisons', () => {
  const legacy = { ...posting('Software Engineer'), role: 'fullstack' as const, roleClassification: undefined }

  it('corrects legacy public cache roles without renewing any snapshot, failure or retry timestamp', () => {
    const checkedAt = '2026-09-19T08:31:00.000Z'
    const retryAt = '2026-09-19T08:36:00.000Z'
    const previous = {
      companyId: company.id, provider: 'greenhouse', board: company.board,
      checkedAt, retryAt, failures: 3, error: 'HTTP 503',
      snapshot: { fetchedAt: SEARCH_TIME, total: 1, unmappedCount: 0, publishedIds: [legacy.id], jobs: [legacy] },
    }
    const loaded = parseCachedBoards({ version: 5, boards: [previous] })[0]
    expect(loaded).toMatchObject({
      checkedAt, retryAt, failures: 3, error: 'HTTP 503',
      snapshot: { fetchedAt: SEARCH_TIME, total: 1, unmappedCount: 0, publishedIds: [legacy.id], jobs: [{ id: legacy.id, role: 'unknown', fetchedAt: SEARCH_TIME }] },
    })
    expect(loaded.snapshot!.jobs[0].roleClassification).toEqual({ version: 1, roles: [], evidence: [] })
    expect(legacy.role).toBe('fullstack')
    expect(legacy.roleClassification).toBeUndefined()
  })

  it('restores unknown exploration separately from a preferred role and preserves saved notes, dates and application status', () => {
    const savedAt = '2026-09-19T08:10:00.000Z'
    const values = new Map<string, string>([
      [STORAGE_KEYS.profile, JSON.stringify({ ...SAMPLE_PROFILE, kind: 'personal', desiredRole: 'backend' })],
      [STORAGE_KEYS.exploration, JSON.stringify({ source: 'public', filters: { ...DEFAULT_FILTERS, role: 'unknown', query: 'Software' }, panelTab: 'cities' })],
      [STORAGE_KEYS.saved, JSON.stringify([{ job: legacy, company, savedAt, status: 'applied', note: 'private role verification note' }])],
    ])
    vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null })
    const restored = loadSaved()
    expect(restored).toHaveLength(1)
    expect(restored[0]).toMatchObject({ savedAt, status: 'applied', note: 'private role verification note', job: { id: legacy.id, role: 'unknown', fetchedAt: SEARCH_TIME } })
    expect(loadExploration(loadProfile()).filters).toMatchObject({ role: 'unknown', query: 'Software' })
    expect(loadProfile().desiredRole).toBe('backend')
    expect(JSON.parse(values.get(STORAGE_KEYS.saved)!)[0].job.role).toBe('fullstack')
  })

  it('compares role meaning and its evidence while ignoring migration, metadata ordering and unrelated department labels', async () => {
    const revised = upgradeJobRole(legacy)
    expect(await createJobRevision(revised)).toEqual(await createJobRevision(legacy))
    const backend = posting('Software Engineer', ['Backend Engineering'])
    const newEvidence = posting('Software Engineer', ['Engineering', 'Backend Engineering'])
    expect(await createJobRevision(backend)).toEqual(await createJobRevision(newEvidence))
    const before = await createJobRevision(legacy)
    const after = await createJobRevision(backend)
    expect(REVISION_FIELDS.filter(field => before[field] !== after[field])).toEqual(['title'])
    const multiple = posting('Software Engineer', ['Backend Engineering', 'Security'])
    expect(await createJobRevision(multiple)).toEqual(await createJobRevision(posting('Software Engineer', ['Security', 'Backend Engineering'])))
  })
})
