import { afterEach, describe, expect, it, vi } from 'vitest'
import { managementFact } from '../../server/job-facts'
import { normalizeJob } from '../../server/normalize'
import { fetchGreenhouseBoard } from '../../server/providers/greenhouse'
import { fetchAshbyBoard } from '../../server/providers/ashby'
import { fetchLeverBoard } from '../../server/providers/lever'
import { parseCachedBoards } from '../../server/board-cache'
import { BoardFetchError, CATALOG_POLICY, createCatalogService } from '../../server/catalog-service'
import { filterTechnicalJobs, isTechnicalJob, occupationFacts, upgradeCatalogOccupations, upgradeJobOccupation } from '../../shared/job-occupation'
import { classifyJobRoles, jobRoles, upgradeJobRole } from '../../shared/job-roles'
import { JobSchema } from '../../shared/schemas'
import { createJobRevision, observeSavedPosting, REVISION_FIELDS } from '../../shared/posting-status'
import { filterJobs } from '../../shared/matching'
import { createSearchIndex } from '../../shared/job-search'
import { analyzeSearchRecovery } from '../../shared/search-recovery'
import { DEFAULT_FILTERS, SAMPLE_PROFILE } from '../../shared/types'
import type { Job, SavedJob } from '../../shared/types'
import { loadSaved, STORAGE_KEYS } from '../../src/lib/storage'
import { SEARCH_COMPANIES, SEARCH_TIME, searchCatalog, searchJob } from '../fixtures/search-catalog'

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })
const company = SEARCH_COMPANIES[0]
const researchText = 'About Example\nWe build AI software for many industries.\nResponsibilities\nDevelop and evaluate large language models.\nRequirements\nExperience with Python and software engineering.'
const assess = (title: string, description = '', departments: string[] = []) => occupationFacts({ title, description, departments })
const legacySupport = searchJob('support', {
  title: 'Technical Services Engineer', cityIds: [], locationLabel: 'Unmapped location',
  description: 'Responsibilities\nProvide technical support and troubleshoot customer database issues.\nBuild internal software tools to help the support queue.',
  roleClassification: undefined,
})

describe('occupation scope from published job evidence', () => {
  it('separates technical support from the engineers who build support products', () => {
    const support = assess(legacySupport.title, legacySupport.description, ['Technical Support AMER'])
    expect(support.category).toBe('support')
    expect(support.evidence).toContainEqual({ source: 'board', text: 'Technical Support AMER' })
    expect(assess('Full Stack Engineer, Support Experience', 'Responsibilities\nBuild software services.', ['Support Engineering']).category).toBe('engineering')
    expect(assess('Staff Engineer, Support Experiences', 'Responsibilities\nWrite production code and mentor other engineers.', ['Support Products - Eng']).category).toBe('engineering')
    expect(assess('Technical Escalations Engineer', 'Responsibilities\nInvestigate customer incidents.', ['Support Engineering']).category).toBe('support')
  })

  it('distinguishes customer-facing job titles from Salesforce and forward-deployed development', () => {
    for (const title of ['Solutions Architect, Developer Platform', 'Customer Success Engineer', 'Sales Engineer']) {
      expect(assess(title).category).toBe('support')
    }
    for (const title of ['Salesforce Developer', 'Salesforce CPQ Engineer', 'Recruiting Analytics Data Engineer']) {
      expect(assess(title).category).toBe('engineering')
    }
    expect(assess('Forward Deployed Engineer', 'Responsibilities\nBuild integrations and reusable custom nodes.', ['Sales', 'Customer Success']).category).toBe('engineering')
    expect(assess('Pre-Sales Program Lead, Forward Deployed Engineering').category).toBe('other')
  })

  it('recognizes manager titles without confusing the name of an engineering product', () => {
    for (const title of ['ARG Engineering Manager', 'ML Engineer Manager', 'Area Vice President, Sales Engineering', 'Staff Technical Program Manager, SRE', 'Strategic Sourcing, Manager - Engineering', 'VP, Developer Relations']) {
      expect(assess(title).category).toBe('management')
    }
    expect(assess('Software Engineer, Resource Manager').category).toBe('engineering')
    expect(assess('Lead Platform Engineer', 'Responsibilities\nMentor colleagues and partner with engineering management.').category).toBe('engineering')
  })

  it('uses only public job-level fields for management and keeps conflicting or missing evidence uncertain', () => {
    const management = managementFact([{ name: 'Job Level', value: 'People Manager' }, { name: 'JD Link', value: 'https://example.com/private-do-not-use' }])!
    expect(management).toEqual({ value: 'management', evidence: { source: 'board', text: 'Job Level: People Manager' } })
    expect(occupationFacts({ title: 'Lead Forward Deployed Engineer', description: '', management }).category).toBe('management')
    const individual = managementFact([{ name: 'Job Level', value: 'Professional - IC' }])
    expect(occupationFacts({ title: 'Lead Platform Engineer', description: 'Responsibilities\nManage a team of software engineers.', management: individual }).category).toBe('engineering')
    expect(managementFact([{ name: 'Job Level', value: ['People Manager', 'Professional - IC'] }])?.value).toBe('unknown')
    expect(managementFact([{ name: 'Department', value: 'People Manager' }, { name: 'Job Level', value: 'Senior' }])).toBeUndefined()
  })

  it('requires direct management duties, not mentoring, historical experience or negated responsibilities', () => {
    expect(assess('Lead Platform Engineer', 'Responsibilities\nDevelop your direct reports through regular performance reviews.').category).toBe('management')
    for (const description of [
      'Qualifications\nExperience conducting performance reviews for your direct reports.',
      'Responsibilities\nThis role has no direct reports. Mentor fellow engineers.',
      'Responsibilities\nWork with managers who develop their direct reports.',
      'Preferred qualifications\nYou will have managed a team of software engineers.',
    ]) expect(assess('Lead Platform Engineer', description).category).toBe('engineering')
  })

  it('excludes physical engineering without losing software, firmware or security work involving hardware', () => {
    for (const title of ['Data Center Engineer', 'Senior Mechanical and Industrial Design Engineer', 'Manufacturing Quality Engineer', 'Product Engineer - Manufacturing Operations']) {
      expect(assess(title).category).toBe('other')
    }
    for (const title of ['Firmware Engineer', 'Software Engineer, Network Automation - Data Center Fabrics', 'Offensive Hardware Security Engineer', 'Staff Engineer, Datacenter Server Lifecycle']) {
      expect(assess(title).category).toBe('engineering')
    }
  })

  it('includes explicitly named computing researchers and does not require a company-specific keyword', () => {
    for (const title of ['AI Applied Scientist', 'Researcher, Web Security', 'Senior Machine Learning Scientist', 'Computer Science Researcher']) {
      expect(assess(title).category).toBe('research')
    }
    expect(assess('Applied Scientist', researchText).category).toBe('research')
    expect(assess('Research Scientist, Life Sciences (Computational)', 'Responsibilities\nBuild analysis pipelines and computational infrastructure.').category).toBe('research')
    expect(assess('Staff Applied Scientist', 'Qualifications\nSignificant experience with evaluation of ML systems at scale.').category).toBe('research')
  })

  it('does not infer computing research from the company, a broad AI department or optional skills', () => {
    for (const description of [
      'About Example\nWe build AI software and train language models.',
      'About our team\nWe research algorithms and build software.',
      'Responsibilities\nInterview customers and study their needs.\nAbout Example\nWe build language models.',
      'Responsibilities\nStudy laboratory samples.\nPreferred qualifications\nAs a researcher, develop software and train language models.',
      'About Example\nYou will develop software skills through our optional learning benefit.',
    ]) expect(assess('Research Scientist', description, ['AI Research & Engineering']).category).toBe('unconfirmed')
    for (const title of ['UX Researcher', 'People Research Scientist, Recruiting', 'Research Scientist, Life Sciences (Chemistry)']) {
      expect(assess(title, researchText, ['AI Research & Engineering']).category).toBe('other')
    }
  })

  it('retains bounded, exact role-specific proof and respects the qualification heading', () => {
    const paragraph = 'Develop and evaluate large language models for retrieval.'
    const result = assess('Applied Scientist', `About Example\nWe build full stack software.\nResponsibilities\n${paragraph}\nPreferred qualifications\nExperience building mobile software.`)
    expect(result.evidence).toEqual([{ source: 'title', text: 'Applied Scientist' }, { source: 'description', text: `Responsibilities\n${paragraph}` }])
    expect(assess('Applied Scientist', 'Responsibilities\n' + 'Develop software. '.repeat(200)).category).toBe('unconfirmed')
  })

  it('uses validated research duties as an ML fallback while preserving title and department precedence', () => {
    const occupation = assess('Applied Scientist', researchText)
    const classification = classifyJobRoles('Applied Scientist', ['Science'], occupation)
    expect(classification.roles).toEqual(['ml'])
    expect(classification.evidence).toContainEqual({ role: 'ml', source: 'description', text: 'Responsibilities\nDevelop and evaluate large language models.' })
    expect(classifyJobRoles('Software Engineer', ['Engineering'], assess('Software Engineer', researchText)).roles).toEqual([])
    expect(classifyJobRoles('Security Researcher', [], occupation).roles).toEqual(['security'])
    expect(classifyJobRoles('Applied Scientist', ['Data Science'], occupation).roles).toEqual(['data'])
    expect(classifyJobRoles('Applied Scientist', [], assess('Applied Scientist', 'Responsibilities\nBuild computational infrastructure and analysis pipelines.')).roles).toEqual([])
  })

  it('validates scope evidence and carries only the whitelisted public job level into normalized jobs', () => {
    const job = normalizeJob({
      id: 1, title: 'Applied Scientist', absolute_url: 'https://example.com/jobs/1',
      content: '<h2>Responsibilities</h2><p>Develop language models.</p>', location: { name: 'London' },
      departments: [{ name: 'Science' }], metadata: [{ name: 'Job Level', value: 'Professional - IC' }, { name: 'Private field', value: 'do-not-copy' }],
    }, company.id, SEARCH_TIME)!
    expect(JobSchema.safeParse(job).success).toBe(true)
    expect(job.occupation).toMatchObject({ category: 'research', departments: ['Science'], management: { value: 'individual' } })
    expect(JSON.stringify(job)).not.toContain('do-not-copy')
    for (const occupation of [{ ...job.occupation, evidence: [] }, { ...job.occupation, category: 'guaranteed' }, { ...job.occupation, version: 999 }]) {
      expect(JobSchema.safeParse({ ...job, occupation }).success).toBe(false)
    }
  })
})

describe('collection, cached scope and saved records', () => {
  it.each(['greenhouse', 'ashby', 'lever'] as const)('keeps the complete %s published ID list before occupation selection', async provider => {
    const titles = ['Applied Scientist', 'Technical Support Engineer', 'Engineering Manager']
    const payload = provider === 'greenhouse' ? { jobs: titles.map((title, index) => ({
      id: index + 1, title, content: '<h2>Responsibilities</h2><p>Develop language models.</p>', absolute_url: `https://example.com/jobs/${index}`,
    })), meta: { total: 3 } } : provider === 'ashby' ? {
      apiVersion: '1', jobs: [...titles, 'AI Scientist'].map((title, index) => ({
        id: String(index + 1), title, jobUrl: `https://example.com/jobs/${index}`, isListed: index !== 3,
        department: 'Science', descriptionPlain: researchText,
      })),
    } : titles.map((text, index) => ({
      id: String(index + 1), text, hostedUrl: `https://example.com/jobs/${index}`,
      categories: { department: 'Science' }, lists: [{ text: 'Responsibilities', content: '<p>Develop language models.</p>' }],
    }))
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(payload)))
    const fetcher = provider === 'greenhouse' ? fetchGreenhouseBoard : provider === 'ashby' ? fetchAshbyBoard : fetchLeverBoard
    const result = await fetcher({ ...company, provider }, SEARCH_TIME)
    expect(result.total).toBe(3)
    expect(result.publishedIds).toEqual([1, 2, 3].map(id => `${provider}-${company.id}-${id}`))
    expect(result.jobs).toHaveLength(1)
    expect(result.jobs[0]).toMatchObject({ title: 'Applied Scientist', role: 'ml', occupation: { category: 'research' } })
    expect(result.unmappedCount).toBe(1)
  })

  const checkedAt = '2026-09-19T08:31:00.000Z'
  const retryAt = '2026-09-19T08:36:00.000Z'
  const engineering = searchJob('engineering')
  const cached = {
    companyId: company.id, provider: 'greenhouse', board: company.board,
    checkedAt, retryAt, failures: 3, error: 'HTTP 503',
    snapshot: { fetchedAt: SEARCH_TIME, total: 5, unmappedCount: 3, publishedIds: [engineering.id, legacySupport.id, 'greenhouse-search-fixture-a-3', 'greenhouse-search-fixture-a-4', 'greenhouse-search-fixture-a-5'], jobs: [engineering, legacySupport] },
  }

  it('removes only retained out-of-scope jobs from old cache counts and preserves missing legacy records and times', () => {
    const loaded = parseCachedBoards({ version: 5, boards: [cached] })[0]
    expect(loaded).toMatchObject({
      checkedAt, retryAt, failures: 3, error: 'HTTP 503',
      snapshot: { fetchedAt: SEARCH_TIME, total: 5, unmappedCount: 2, publishedIds: cached.snapshot.publishedIds, jobs: [{ id: engineering.id }] },
    })
    expect(loaded.snapshot!.jobs).toHaveLength(1)
    expect(filterTechnicalJobs([legacySupport], null)).toMatchObject({ jobs: [], unmappedCount: null })
    expect(parseCachedBoards({ version: 5, boards: [loaded] })).toEqual([loaded])
    expect(cached.snapshot.jobs).toHaveLength(2)
    expect(legacySupport.occupation).toBeUndefined()
  })

  it('checks malformed counts and board identity before filtering can hide a bad record', () => {
    const wrongCompany = { ...legacySupport, companyId: 'wrong-company' }
    expect(parseCachedBoards({ version: 5, boards: [{ ...cached, snapshot: { ...cached.snapshot, jobs: [wrongCompany] } }] })).toEqual([])
    expect(parseCachedBoards({ version: 5, boards: [{ ...cached, snapshot: { ...cached.snapshot, unmappedCount: 0 } }] })).toEqual([])
  })

  it('preserves an empty technical result and its original expiry when a cached board only contains support jobs', async () => {
    const base = Date.parse(SEARCH_TIME)
    let now = base + CATALOG_POLICY.freshFor
    const entries = parseCachedBoards({ version: 5, boards: [{
      ...cached, checkedAt: SEARCH_TIME, retryAt: null, failures: 0, error: undefined,
      snapshot: { fetchedAt: SEARCH_TIME, total: 1, unmappedCount: 1, jobs: [legacySupport], publishedIds: [legacySupport.id] },
    }] })
    const service = createCatalogService({
      companies: [company], cache: { load: async () => entries, save: async () => {} }, now: () => now, random: () => 0,
      fetchBoard: async () => { throw new BoardFetchError('HTTP 503') },
    })
    const result = await service.get()
    expect(result).toMatchObject({ jobs: [], fetchedAt: SEARCH_TIME, unmappedCount: 0, stale: true })
    expect(result.boards[0]).toMatchObject({ total: 1, included: 0, lastSuccessAt: SEARCH_TIME })
    now = base + CATALOG_POLICY.maxFallbackAge + 1
    await expect(service.get()).rejects.toMatchObject({ code: 'CATALOG_EXPIRED' })
  })

  it('applies the same technical scope to client counts, filters and recovery previews', () => {
    const researcher = searchJob('researcher', { title: 'Applied Scientist', role: 'unknown', description: researchText })
    const old = searchCatalog([researcher, legacySupport])
    const current = upgradeCatalogOccupations(old)
    expect(current.jobs.map(job => job.id)).toEqual([researcher.id])
    expect(current.boards[0]).toMatchObject({ total: 2, included: 1 })
    expect(current.unmappedCount).toBe(0)
    expect(current.fetchedAt).toBe(SEARCH_TIME)
    for (const filters of [DEFAULT_FILTERS, { ...DEFAULT_FILTERS, role: 'ml' as const }]) {
      expect(filterJobs(old, SAMPLE_PROFILE, filters).map(match => match.job.id)).toEqual([researcher.id])
    }
    const filters = { ...DEFAULT_FILTERS, role: 'frontend' as const }
    const recovery = analyzeSearchRecovery(createSearchIndex(old, SAMPLE_PROFILE), filters, { kind: 'cities' })!
    expect(recovery.suggestions[0]).toMatchObject({ changes: { role: 'all' }, count: { jobs: 1, companies: 1, cities: 1 } })
    expect(filterJobs(old, SAMPLE_PROFILE, { ...filters, ...recovery.suggestions[0].changes })).toHaveLength(1)
    expect(old.jobs).toHaveLength(2)
  })

  it('reclassifies saved jobs without deleting records, notes, application status or original dates', () => {
    const saved: SavedJob = { job: legacySupport, company, savedAt: '2026-09-19T08:01:00.000Z', status: 'applied', note: 'private-scope-note' }
    vi.stubGlobal('localStorage', { getItem: (key: string) => key === STORAGE_KEYS.saved ? JSON.stringify([saved]) : null })
    const restored = loadSaved()
    expect(restored).toHaveLength(1)
    expect(restored[0]).toMatchObject({
      savedAt: saved.savedAt, status: 'applied', note: saved.note, company,
      job: { id: legacySupport.id, fetchedAt: SEARCH_TIME, occupation: { category: 'support' } },
    })
    expect(isTechnicalJob(restored[0].job)).toBe(false)
    const observation = observeSavedPosting(restored[0], {
      version: 1, checkedAt: SEARCH_TIME, refreshAfter: retryAt,
      boards: [{
        companyId: company.id, provider: 'greenhouse', board: company.board!,
        status: 'ok', checkedAt: SEARCH_TIME, lastSuccessAt: SEARCH_TIME, retryAt: null,
        listing: { validUntil: '2026-09-19T08:30:00.000Z', publishedIds: [legacySupport.id], jobs: [] },
      }],
    }, undefined, Date.parse(SEARCH_TIME) + 1000)
    expect(observation).toMatchObject({ state: 'listed', message: expect.stringContaining('탐색 범위 밖') })
  })

  it('upgrades unknown research roles from preserved evidence and compares scope without parser versions or unused departments', async () => {
    const legacy = searchJob('research', { title: 'Applied Scientist', role: 'unknown', roleClassification: { version: 1, roles: [], evidence: [] }, description: researchText })
    const updated = upgradeJobRole(upgradeJobOccupation(legacy))
    expect(jobRoles(updated)).toEqual(['ml'])
    expect(updated.fetchedAt).toBe(legacy.fetchedAt)
    expect(await createJobRevision(legacy)).toEqual(await createJobRevision(updated))
    expect(await createJobRevision(updated)).toEqual(await createJobRevision({
      ...updated, occupation: { ...updated.occupation!, departments: ['Unrelated public department'] },
    }))
    const lead: Job = { ...engineering, title: 'Lead Platform Engineer', roleClassification: undefined }
    const changed: Job = { ...lead, occupation: occupationFacts({ title: lead.title, description: '', management: { value: 'management', evidence: { source: 'board', text: 'Job Level: People Manager' } } }) }
    const before = await createJobRevision(lead)
    const after = await createJobRevision(changed)
    expect(REVISION_FIELDS.filter(field => before[field] !== after[field])).toEqual(['title'])
    const sample = { ...legacySupport, source: 'sample' as const }
    expect(upgradeJobOccupation(sample)).toBe(sample)
    expect(isTechnicalJob(sample)).toBe(true)
  })
})
