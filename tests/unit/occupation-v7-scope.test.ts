import { afterEach, describe, expect, it, vi } from 'vitest'
import { normalizeJob } from '../../server/normalize'
import { normalizeAshbyJob } from '../../server/providers/ashby'
import { fetchGreenhouseBoard } from '../../server/providers/greenhouse'
import { normalizeLeverJob } from '../../server/providers/lever'
import { createSmartRecruitersFetcher } from '../../server/providers/smartrecruiters'
import { CatalogUnavailableError, createCatalogService } from '../../server/catalog-service'
import type { CachedBoard } from '../../server/board-cache'
import { createObservationStore } from '../../server/catalog-observations'
import type { ObservationCache } from '../../server/catalog-observations'
import { observationComparison } from '../../shared/catalog-observations'
import { isTechnicalJob, needsOccupationDescription, occupationFacts } from '../../shared/job-occupation'
import { classifyJobRoles, jobRoles } from '../../shared/job-roles'
import { JobSchema } from '../../shared/schemas'
import type { Job } from '../../shared/types'
import { ashbyPosting, leverPosting, smartRecruitersPosting } from '../fixtures/public-postings'
import {
  ADDITIONAL_CONTROL_CASES, COMPUTING_CONTROLS, COMPUTING_CO_ROLE_CASES, DESIGN_ENGINEER_QUALIFICATION_CASE, E2E_ROWS,
  FAILURE_ANALYSIS_BODIES, FAILURE_ANALYSIS_TITLES, FAILURE_ATTRIBUTION_BODIES, FAILURE_COORDINATION_BODIES,
  FAILURE_CONTEXT_BODIES, FAILURE_DASH_SPECIALIST_TITLE, FAILURE_DASH_TITLE, FAILURE_GOVERNING_BODIES, FAILURE_HEADING_BODIES,
  FAILURE_INTRODUCTION_BODIES, FAILURE_LATER_ROLE_NOUN_BODIES, FAILURE_SUBJECT_BODIES, HARDWARE_MODIFIER_CASES, INTERNSHIP_CASES,
  INTERNSHIP_PROGRAM_ROLE_CASES, NAMED_ROLE_CO_ROLE_CASES, PRIMARY_ROLE_CASES, RESEARCH_PRIMARY_CASES, SDET_ACTIVITY_CONJUNCTION_CASES,
  SDET_MODIFIER_CASES, V7_BODIES, V7_COMPANY, V7_LEVER_COMPANY, V7_METHOD, V7_SMART_COMPANY, V7_TIME, V7_ASHBY_COMPANY,
  computingControlForms, htmlBody, v7Job,
} from '../fixtures/occupation-v7'
import type { V7Case } from '../fixtures/occupation-v7'

// Stage 71 contract docs/design/occupation-v7.md revision 4. Every expected value
// below is a literal from that contract; product functions only produce the actual
// value under test. Current assessments are version 7.
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers() })

function assess(fixture: V7Case) {
  const occupation = occupationFacts({ title: fixture.title, description: fixture.description, departments: fixture.departments })
  const roleClassification = classifyJobRoles(fixture.title, fixture.departments, occupation)
  const job = v7Job(fixture, { occupation, roleClassification, role: roleClassification.roles[0] ?? 'unknown' })
  return { version: occupation.version, category: occupation.category, explorable: isTechnicalJob(job), roles: jobRoles(job) }
}

function expected(fixture: V7Case) {
  return { version: 7, category: fixture.category, explorable: fixture.explorable, ...(fixture.roles ? { roles: fixture.roles } : {}) }
}

function greenhouseRow(id: number, fixture: Pick<V7Case, 'title' | 'departments' | 'description'>, content = true) {
  return {
    id, title: fixture.title, absolute_url: `https://example.org/quill-hardware/${id}`,
    location: { name: 'London, UK' }, departments: fixture.departments.map(name => ({ name })),
    ...(content ? { content: htmlBody(fixture.description) } : {}),
  }
}

const computingForms = COMPUTING_CONTROLS.flatMap(computingControlForms)

describe('primary position before audience, department or product qualifiers', () => {
  it.each(PRIMARY_ROLE_CASES)('$title is $category', fixture => {
    expect(assess(fixture)).toMatchObject(expected(fixture))
  })

  it.each(INTERNSHIP_CASES)('internship or neutral head $title is $category with literal specialties', fixture => {
    expect(assess(fixture)).toEqual(expected(fixture))
  })

  it.each(computingForms)('computing control $title stays engineering in the $key form', fixture => {
    expect(assess(fixture)).toEqual(expected(fixture))
  })

  it.each(ADDITIONAL_CONTROL_CASES)('$title in $departments keeps the contract outcome $category', fixture => {
    expect(assess(fixture)).toMatchObject(expected(fixture))
  })

  it('records the intentionally different Design Engineer qualification standard', () => {
    expect(assess(DESIGN_ENGINEER_QUALIFICATION_CASE)).toEqual(expected(DESIGN_ENGINEER_QUALIFICATION_CASE))
  })
})

describe('ambiguous Failure Analysis family decided by its own attributable duties', () => {
  const combinations = FAILURE_ANALYSIS_TITLES.flatMap(title => FAILURE_ANALYSIS_BODIES.map(body => ({ title, ...body })))

  it.each(combinations)('$title with $key is $category', ({ title, description, category }) => {
    const occupation = occupationFacts({ title, description, departments: ['Hardware'] })
    expect({ version: occupation.version, category: occupation.category }).toEqual({ version: 7, category })
    const job = v7Job({ key: 'failure-analysis', title, departments: ['Hardware'], description }, { occupation })
    expect(isTechnicalJob(job)).toBe(category === 'engineering')
  })

  it('keeps an explicit computing primary title engineering regardless of a Failure Analysis suffix or body', () => {
    for (const description of ['', V7_BODIES.failedBoards, V7_BODIES.crashSoftware]) {
      const occupation = occupationFacts({ title: 'Data Engineer - Failure Analysis', description, departments: ['Hardware'] })
      expect(occupation).toMatchObject({ version: 7, category: 'engineering' })
      expect(classifyJobRoles('Data Engineer - Failure Analysis', ['Hardware'], occupation).roles).toEqual(['data'])
    }
  })

  it('excludes a bodyless ambiguous Greenhouse row while a fresh physical body is other and a software body is engineering', () => {
    const bodyless = normalizeJob(greenhouseRow(701, { title: 'Failure Analysis Engineer', departments: ['Hardware'], description: '' }, false), V7_COMPANY.id, V7_TIME)
    expect(bodyless).toBeNull()
    expect(normalizeJob(greenhouseRow(702, { title: 'Senior Failure Analysis Engineer', departments: ['Hardware'], description: V7_BODIES.failedBoards }), V7_COMPANY.id, V7_TIME)).toBeNull()
    const software = normalizeJob(greenhouseRow(703, { title: 'Failure Analysis Engineer', departments: ['Hardware'], description: V7_BODIES.crashSoftware }), V7_COMPANY.id, V7_TIME)
    expect(software).toMatchObject({
      id: 'greenhouse-quill-hardware-703', title: 'Failure Analysis Engineer', fetchedAt: '2026-10-01T09:00:00.000Z',
      role: 'unknown', occupation: { version: 7, category: 'engineering', departments: ['Hardware'] },
    })
    expect(jobRoles(software!)).toEqual([])
    expect(JobSchema.safeParse(software).success).toBe(true)
  })
})

describe('fresh normalizers apply the same rules to every provider shape', () => {
  it.each([...PRIMARY_ROLE_CASES, ...INTERNSHIP_CASES])('Greenhouse row $title is included only when explorable', fixture => {
    const job = normalizeJob(greenhouseRow(800, fixture), V7_COMPANY.id, V7_TIME)
    if (!fixture.explorable) {
      expect(job).toBeNull()
      return
    }
    expect(job).toMatchObject({ title: fixture.title, fetchedAt: '2026-10-01T09:00:00.000Z', occupation: { version: 7, category: fixture.category } })
    if (fixture.roles) {
      expect(jobRoles(job!)).toEqual(fixture.roles)
      expect(job!.role).toBe(fixture.roles[0] ?? 'unknown')
    }
  })

  it('keeps the complete Greenhouse inventory while retaining only the literal computing positions', async () => {
    const rows = [
      ...E2E_ROWS.map(row => greenhouseRow(row.id, row)),
      greenhouseRow(114, { title: 'Failure Analysis Engineer', departments: ['Hardware'], description: '' }, false),
    ]
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ jobs: rows, meta: { total: rows.length } })))
    const result = await fetchGreenhouseBoard(V7_COMPANY, V7_TIME)
    expect(result.total).toBe(13)
    expect(result.unmappedCount).toBe(0)
    expect(result.publishedIds).toEqual(rows.map(row => `greenhouse-quill-hardware-${row.id}`))
    expect(result.jobs.map(job => job.title)).toEqual([
      'Senior Software Engineer - Production Test Systems', 'Senior Firmware Engineer', 'Failure Analysis Engineer',
      'Firmware Internship 2026/2027', 'Software Engineer, Talent Tools', 'Machine Learning Engineer, Failure Prediction',
      'Senior iOS Engineer', 'Cloud Engineer - Hardware',
    ])
    expect(result.jobs.map(job => job.role)).toEqual(['unknown', 'unknown', 'unknown', 'unknown', 'unknown', 'ml', 'mobile', 'devops'])
    for (const job of result.jobs) expect(job.occupation).toMatchObject({ version: 7 })
  })

  it.each([
    { id: 'a-talent', title: 'Senior Talent Specialist - Product and Engineering', department: 'General & Admin', team: 'Talent', body: V7_BODIES.recruiting, included: false },
    { id: 'a-supplier', title: 'Lead Supplier Quality Engineer', department: 'Hardware', team: 'Supply Chain', body: V7_BODIES.supplierInspection, included: false },
    { id: 'a-electronics', title: 'Experienced Electronics Engineer', department: 'Hardware', team: 'Hardware Design', body: V7_BODIES.circuitDesign, included: false },
    { id: 'a-failure-physical', title: 'Failure Analysis Engineer', department: 'Hardware', team: 'Reliability', body: V7_BODIES.failedBoards, included: false },
    { id: 'a-failure-software', title: 'Failure Analysis Engineer', department: 'Hardware', team: 'Reliability', body: V7_BODIES.crashSoftware, included: true, roles: [], role: 'unknown' },
    { id: 'a-ios', title: 'Senior iOS Engineer', department: 'Hardware', team: 'Companion App', body: V7_BODIES.softwareDuties, included: true, roles: ['mobile'], role: 'mobile' },
    { id: 'a-production-test', title: 'Senior Software Engineer - Production Test Systems', department: 'Hardware', team: 'Production', body: V7_BODIES.productionTestSoftware, included: true, roles: [], role: 'unknown' },
    { id: 'a-firmware-intern', title: 'Firmware Internship 2026/2027', department: 'Internships', team: 'Firmware', body: V7_BODIES.firmwareDuties, included: true, roles: [], role: 'unknown' },
  ])('Ashby department/team pair $department / $team with $title', ({ id, title, department, team, body, included, roles, role }) => {
    const job = normalizeAshbyJob(ashbyPosting({ id, title, department, team, descriptionPlain: body }), V7_ASHBY_COMPANY.id, V7_TIME)
    if (!included) {
      expect(job).toBeNull()
      return
    }
    expect(job).toMatchObject({
      id: `ashby-quill-ashby-${id}`, title, source: 'ashby', role,
      occupation: { version: 7, category: 'engineering', departments: [department, team] },
    })
    expect(jobRoles(job!)).toEqual(roles)
  })

  it.each([
    { id: 'l-talent-partner', text: 'Talent Partner, Engineering', department: 'People', team: 'Talent', body: V7_BODIES.recruiting, included: false },
    { id: 'l-computer-hardware', text: 'Computer Hardware Engineer', department: 'Hardware', team: 'Boards', body: '', included: false },
    { id: 'l-cloud', text: 'Cloud Engineer - Hardware', department: 'Hardware', team: 'Fleet Services', body: V7_BODIES.softwareDuties, included: true, roles: ['devops'], role: 'devops' },
    { id: 'l-backend-intern', text: 'Backend Internship', department: 'Internships', team: 'Platform', body: V7_BODIES.softwareDuties, included: true, roles: ['backend'], role: 'backend' },
  ])('Lever department/team $department / $team with $text', ({ id, text, department, team, body, included, roles, role }) => {
    const job = normalizeLeverJob(leverPosting({
      id, text, descriptionPlain: body, categories: { location: 'London', department, team },
    }), V7_LEVER_COMPANY.id, V7_TIME)
    if (!included) {
      expect(job).toBeNull()
      return
    }
    expect(job).toMatchObject({ id: `lever-quill-lever-${id}`, title: text, source: 'lever', role, occupation: { version: 7, category: 'engineering', departments: [department, team] } })
    expect(jobRoles(job!)).toEqual(roles)
  })
})

describe('detail retrieval eligibility for list-only providers', () => {
  it('fetches ambiguous Failure Analysis titles and computing internships but not a clear HR position', () => {
    for (const title of FAILURE_ANALYSIS_TITLES) expect(needsOccupationDescription(title), title).toBe(true)
    for (const title of ['Firmware Internship 2026/2027', 'Backend Internship', 'Software Development Intern', 'Intern - Firmware']) {
      expect(needsOccupationDescription(title), title).toBe(true)
    }
    expect(needsOccupationDescription('Senior Talent Specialist - Product and Engineering')).toBe(false)
  })
})

const smartId = (id: string) => `smartrecruiters-quill-smart-${id}`
const pageOf = (content: unknown[]) => ({ offset: 0, limit: 100, totalFound: content.length, content })
const smartFetcher = () => createSmartRecruitersFetcher({ concurrency: 1, interval: 0, timeout: 120_000 })

function smartPosting(id: string, name: string, functionLabel: string, jobDescription?: string, qualifications?: string) {
  return smartRecruitersPosting({
    id, name, company: { identifier: 'QuillSmart' }, function: { label: functionLabel },
    postingUrl: `https://example.org/quill-smart/${id}`,
    location: { city: 'London', country: 'gb', fullLocation: 'London, United Kingdom', remote: false, hybrid: false },
    jobAd: { sections: {
      ...(jobDescription ? { jobDescription: { title: 'Job Description', text: `<p>${jobDescription}</p>` } } : {}),
      ...(qualifications ? { qualifications: { title: 'Qualifications', text: `<p>${qualifications}</p>` } } : {}),
    } },
  })
}

function memoryObservationCache() {
  let value: unknown = { version: 1, series: [] }
  return {
    load: vi.fn(async () => structuredClone(value)),
    save: vi.fn<ObservationCache['save']>(async next => { value = structuredClone(next) }),
  }
}

describe('a real list-only provider flow: valid bodyless rows versus required detail failures', () => {
  const postings = [
    smartPosting('sr-talent', 'Senior Talent Specialist - Product and Engineering', 'General & Admin'),
    smartPosting('sr-fa-bodyless', 'Failure Analysis Engineer', 'Hardware'),
    smartPosting('sr-fa-software', 'Failure Analysis Engineer', 'Hardware',
      'Develop production crash-analysis software and maintain its application code and automated tests for a fictional device fleet.',
      'Experience with software development in Python.'),
    smartPosting('sr-firmware-intern', 'Firmware Internship 2026/2027', 'Internships',
      'Design and implement firmware features and maintain firmware tests for a fictional device controller.',
      'Experience with C and embedded software development.'),
    smartPosting('sr-hardware-intern', 'Hardware Internship', 'Hardware'),
    smartPosting('sr-inactive', 'Backend Internship', 'Internships', 'Build production software services for a fictional platform.'),
  ]
  /** Listing pages carry summaries only; the body, status and URL come from the detail. */
  const summaryOf = ({ jobAd: _jobAd, active: _active, postingUrl: _postingUrl, ...summary }: ReturnType<typeof smartPosting>) => summary
  const summaries = () => postings.map(summaryOf)

  it('retains every valid published ID, excludes the bodyless ambiguous row and keeps the authoritative inactive branch', async () => {
    const requested: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: string) => {
      const url = new URL(input)
      requested.push(url.pathname + url.search)
      if (url.search) return Response.json(pageOf(summaries()))
      const detail = postings.find(posting => url.pathname.endsWith(`/${posting.id}`))
      if (!detail) throw new Error(`Unexpected fictional detail request ${url.pathname}`)
      return Response.json(detail.id === 'sr-inactive' ? { ...detail, active: false } : detail)
    }))
    const result = await smartFetcher()(V7_SMART_COMPANY, V7_TIME)
    expect(requested).toEqual([
      '/v1/companies/QuillSmart/postings?limit=100&offset=0&destination=PUBLIC',
      '/v1/companies/QuillSmart/postings/sr-fa-bodyless',
      '/v1/companies/QuillSmart/postings/sr-fa-software',
      '/v1/companies/QuillSmart/postings/sr-firmware-intern',
      '/v1/companies/QuillSmart/postings/sr-inactive',
    ])
    expect(result.total).toBe(5)
    expect(result.publishedIds).toEqual(['sr-talent', 'sr-fa-bodyless', 'sr-fa-software', 'sr-firmware-intern', 'sr-hardware-intern'].map(smartId))
    expect(result.unpublishedIds).toEqual([smartId('sr-inactive')])
    expect(result.verifiedActiveIds).toEqual(['sr-fa-bodyless', 'sr-fa-software', 'sr-firmware-intern'].map(smartId))
    expect(result.jobs.map(job => [job.id, job.title, job.role, job.occupation?.version, job.occupation?.category])).toEqual([
      [smartId('sr-fa-software'), 'Failure Analysis Engineer', 'unknown', 7, 'engineering'],
      [smartId('sr-firmware-intern'), 'Firmware Internship 2026/2027', 'unknown', 7, 'engineering'],
    ])
    expect(result.jobs.map(job => jobRoles(job))).toEqual([[], []])
    expect(result.unmappedCount).toBe(0)
  })

  const T0 = '2026-10-01T22:00:00.000Z'
  const T1 = '2026-10-02T05:00:00.000Z'
  const firmware = smartPosting('sr-firmware', 'Senior Firmware Engineer', 'Hardware',
    'Design and implement firmware features and maintain firmware tests for a fictional device controller.',
    'Experience with C and embedded software development.')

  function service(now: () => number, boards: CachedBoard[], observations: ReturnType<typeof createObservationStore>) {
    const saves: CachedBoard[][] = []
    const catalog = createCatalogService({
      companies: [V7_SMART_COMPANY], fetchBoard: smartFetcher(), observations, now, random: () => 0,
      cache: { load: async () => structuredClone(boards), save: async next => { saves.push(structuredClone(next)) } },
    })
    return { catalog, saves }
  }

  it('fails the content attempt on a required detail schema failure and preserves the prior snapshot, clocks, method and IDs', async () => {
    let now = Date.parse(T0)
    const observationCache = memoryObservationCache()
    const store = createObservationStore({ companies: [V7_SMART_COMPANY], cache: observationCache, now: () => now, onError: vi.fn() })
    expect(store.method).toBe(V7_METHOD)
    const requests: string[] = []
    let failDetail = false
    vi.stubGlobal('fetch', vi.fn(async (input: string) => {
      const url = new URL(input)
      requests.push(url.pathname + url.search)
      if (url.search) return Response.json(pageOf((failDetail ? [postings[1], postings[2], firmware] : [firmware]).map(summaryOf)))
      if (url.pathname.endsWith('/sr-firmware')) return Response.json(firmware)
      // A response that fails the detail schema is a retrieval failure, not a bodyless posting.
      return Response.json({ id: url.pathname.split('/').at(-1), name: 'Failure Analysis Engineer' })
    }))
    const first = service(() => now, [], store)
    const initial = await first.catalog.get()
    expect(initial.jobs.map(job => [job.id, job.title, job.stale])).toEqual([[smartId('sr-firmware'), 'Senior Firmware Engineer', false]])
    expect(first.saves).toHaveLength(1)
    const priorEntry = first.saves[0][0]
    expect(priorEntry).toMatchObject({ companyId: 'quill-smart', failures: 0, retryAt: null, checkedAt: T0 })
    expect(priorEntry.snapshot).toMatchObject({
      fetchedAt: T0, total: 1, unmappedCount: 0, observationMethod: V7_METHOD,
      publishedIds: [smartId('sr-firmware')], verifiedActiveIds: [smartId('sr-firmware')],
    })
    expect(priorEntry.snapshot?.jobs.map(job => job.id)).toEqual([smartId('sr-firmware')])
    const dayOne = await store.read()
    expect(dayOne.days.map(day => day.day)).toEqual(['2026-10-01'])
    expect(dayOne.days[0].complete).toMatchObject({ origin: 'collection', comparable: true, stats: { published: 1, technical: 1, openings: 1, talentPools: 0 } })

    now = Date.parse(T1)
    failDetail = true
    const second = service(() => now, first.saves[0], store)
    const result = await second.catalog.get()
    expect(result.jobs.map(job => [job.id, job.stale])).toEqual([[smartId('sr-firmware'), true]])
    expect(result.boards[0]).toMatchObject({
      companyId: 'quill-smart', status: 'error', dataStatus: 'stale', total: 1, included: 1,
      lastSuccessAt: T0, checkedAt: T1, retryAt: '2026-10-02T05:01:00.000Z',
      message: 'SmartRecruiters 공고의 본문 형식을 확인하지 못했어요.',
    })
    expect(second.saves).toHaveLength(1)
    const failed = second.saves[0][0]
    expect(failed).toMatchObject({
      companyId: 'quill-smart', checkedAt: T1, failures: 1, retryAt: '2026-10-02T05:01:00.000Z',
      error: 'SmartRecruiters 공고의 본문 형식을 확인하지 못했어요.', errorPhase: 'content',
    })
    expect(failed.snapshot).toEqual(priorEntry.snapshot)
    const status = await second.catalog.getPostingStatus()
    expect(status.boards[0]).toMatchObject({ status: 'error', lastSuccessAt: T0, listing: { publishedIds: [smartId('sr-firmware')] } })
    const history = await store.read()
    expect(history.days.map(day => day.day)).toEqual(['2026-10-01', '2026-10-02'])
    expect(history.days[0].complete).toMatchObject({ comparable: true, stats: { published: 1, technical: 1 } })
    expect(history.days[1].latest.boards).toEqual([{ companyId: 'quill-smart', status: 'error', checkedAt: T1, lastSuccessAt: T0 }])
    expect(history.days[1].complete).toBeUndefined()
    expect(observationComparison(history.days)).toBeNull()
    expect(requests.filter(path => !path.includes('?'))).toEqual([
      '/v1/companies/QuillSmart/postings/sr-firmware', '/v1/companies/QuillSmart/postings/sr-fa-bodyless',
    ])
  })

  it('does not invent a snapshot, a job or a complete observation when the first collection fails', async () => {
    const now = Date.parse(T0)
    const observationCache = memoryObservationCache()
    const store = createObservationStore({ companies: [V7_SMART_COMPANY], cache: observationCache, now: () => now, onError: vi.fn() })
    vi.stubGlobal('fetch', vi.fn(async (input: string) => {
      const url = new URL(input)
      if (url.search) return Response.json(pageOf(summaries().slice(1, 2)))
      return Response.json({ id: 'sr-fa-bodyless', name: 'Failure Analysis Engineer' })
    }))
    const { catalog, saves } = service(() => now, [], store)
    await expect(catalog.get()).rejects.toMatchObject({ code: 'CATALOG_UNAVAILABLE' })
    await expect(catalog.get()).rejects.toBeInstanceOf(CatalogUnavailableError)
    expect(saves).toHaveLength(1)
    expect(saves[0]).toHaveLength(1)
    expect(saves[0][0]).toMatchObject({
      companyId: 'quill-smart', checkedAt: T0, failures: 1, retryAt: '2026-10-01T22:01:00.000Z',
      error: 'SmartRecruiters 공고의 본문 형식을 확인하지 못했어요.', errorPhase: 'content',
    })
    expect(saves[0][0]).not.toHaveProperty('snapshot')
    const history = await store.read()
    expect(history.days).toHaveLength(1)
    expect(history.days[0]).toMatchObject({ day: '2026-10-01', latest: { origin: 'collection', boards: [{ companyId: 'quill-smart', status: 'error', checkedAt: T0, lastSuccessAt: null }] } })
    expect(history.days[0].complete).toBeUndefined()
    expect(observationComparison(history.days)).toBeNull()
  })
})

describe('the bounded source body', () => {
  it('stores at most 26,000 body characters and does not need the discarded text to keep an explicit computing title', () => {
    const filler = 'Maintain the fictional firmware build pipeline. '.repeat(700)
    const job: Job = normalizeJob(greenhouseRow(901, {
      title: 'Senior Firmware Engineer', departments: ['Hardware'], description: `${V7_BODIES.firmwareDuties}\n${filler}`,
    }), V7_COMPANY.id, V7_TIME)!
    expect(job.description).toHaveLength(26000)
    expect(job.occupation).toMatchObject({ version: 7, category: 'engineering' })
  })
})

// Supplement after Astra's preliminary implementation review (implementation-01 findings 1–5)
// and main's real heading discovery. Expectations follow contract rules 2, 4, 6 and 7.
describe('implementation review regressions: research positions, hardware modifiers, duty attribution, headings, dashes', () => {
  it.each(RESEARCH_PRIMARY_CASES)('recognized research position $title is $category ahead of its engineering audience', fixture => {
    expect(assess(fixture)).toMatchObject(expected(fixture))
  })

  it.each(HARDWARE_MODIFIER_CASES)('$title is $category', fixture => {
    expect(assess(fixture)).toMatchObject(expected(fixture))
  })

  const attributionTitles = ['Failure Analysis Engineer', 'Failure Analysis Specialist']

  it.each(attributionTitles.flatMap(title => FAILURE_ATTRIBUTION_BODIES.map(body => ({ title, ...body }))))('$title with $key is $category', ({ title, description, category }) => {
    const occupation = occupationFacts({ title, description, departments: ['Hardware'] })
    expect({ version: occupation.version, category: occupation.category }).toEqual({ version: 7, category })
  })

  it.each(attributionTitles.flatMap(title => FAILURE_HEADING_BODIES.map(body => ({ title, ...body }))))('$title under a period-terminated own-duties heading with $key is $category', ({ title, description, category }) => {
    const occupation = occupationFacts({ title, description, departments: ['Hardware'] })
    expect({ version: occupation.version, category: occupation.category }).toEqual({ version: 7, category })
  })

  it('keeps the unsupported Key accountabilities heading unconfirmed while the own-duties heading is recognized', () => {
    const accountabilities = FAILURE_ANALYSIS_BODIES.find(body => body.key === 'unrecognized-heading')!
    expect(occupationFacts({ title: 'Failure Analysis Engineer', description: accountabilities.description, departments: ['Hardware'] }).category).toBe('unconfirmed')
    expect(occupationFacts({ title: 'Failure Analysis Engineer', description: FAILURE_HEADING_BODIES[1].description, departments: ['Hardware'] }).category).toBe('engineering')
  })

  it('canonicalizes an en-dash family title identically in the prefilter and classification while storing the published title', () => {
    expect(needsOccupationDescription(FAILURE_DASH_TITLE)).toBe(true)
    expect(needsOccupationDescription(FAILURE_DASH_SPECIALIST_TITLE)).toBe(true)
    const engineering = occupationFacts({ title: FAILURE_DASH_TITLE, description: V7_BODIES.crashSoftware, departments: ['Hardware'] })
    expect(engineering).toMatchObject({ version: 7, category: 'engineering' })
    expect(engineering.evidence[0]).toEqual({ source: 'title', text: 'Failure–Analysis Engineer' })
    expect(occupationFacts({ title: FAILURE_DASH_TITLE, description: V7_BODIES.failedBoards, departments: ['Hardware'] }).category).toBe('other')
    expect(occupationFacts({ title: FAILURE_DASH_TITLE, description: '', departments: ['Hardware'] }).category).toBe('unconfirmed')
    const job = normalizeJob(greenhouseRow(905, { title: FAILURE_DASH_TITLE, departments: ['Hardware'], description: V7_BODIES.crashSoftware }), V7_COMPANY.id, V7_TIME)
    expect(job).toMatchObject({ title: 'Failure–Analysis Engineer', occupation: { version: 7, category: 'engineering' } })
    expect(job?.occupation?.evidence[0]).toEqual({ source: 'title', text: 'Failure–Analysis Engineer' })
  })

  it('fetches en-dash family titles from a list-only provider and includes only the detail that establishes computing duties', async () => {
    const postings = [
      smartPosting('sr-dash-engineer', FAILURE_DASH_TITLE, 'Hardware',
        'Develop production crash-analysis software and maintain its application code and automated tests for a fictional device fleet.',
        'Experience with software development in Python.'),
      smartPosting('sr-dash-specialist', FAILURE_DASH_SPECIALIST_TITLE, 'Hardware'),
    ]
    const requested: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: string) => {
      const url = new URL(input)
      requested.push(url.pathname)
      if (url.search) return Response.json(pageOf(postings.map(({ jobAd: _jobAd, active: _active, postingUrl: _postingUrl, ...summary }) => summary)))
      const detail = postings.find(posting => url.pathname.endsWith(`/${posting.id}`))
      if (!detail) throw new Error(`Unexpected fictional detail request ${url.pathname}`)
      return Response.json(detail)
    }))
    const result = await smartFetcher()(V7_SMART_COMPANY, V7_TIME)
    expect(requested).toEqual([
      '/v1/companies/QuillSmart/postings',
      '/v1/companies/QuillSmart/postings/sr-dash-engineer',
      '/v1/companies/QuillSmart/postings/sr-dash-specialist',
    ])
    expect(result.total).toBe(2)
    expect(result.publishedIds).toEqual([smartId('sr-dash-engineer'), smartId('sr-dash-specialist')])
    expect(result.verifiedActiveIds).toEqual([smartId('sr-dash-engineer'), smartId('sr-dash-specialist')])
    expect(result.jobs.map(job => [job.id, job.title, job.occupation?.version, job.occupation?.category])).toEqual([
      [smartId('sr-dash-engineer'), 'Failure–Analysis Engineer', 7, 'engineering'],
    ])
  })
})

// Supplement after Astra's second preliminary implementation review (implementation-02
// findings 1–3). Expectations follow contract rules 2, 4 and 6.
describe('implementation review 02 regressions: computing co-roles, coordinated predicates, manual inspection after software purpose', () => {
  it.each(COMPUTING_CO_ROLE_CASES)('$title is $category', fixture => {
    expect(assess(fixture)).toMatchObject(expected(fixture))
  })

  const coordinationTitles = ['Failure Analysis Engineer', 'Failure Analysis Specialist']

  it.each(coordinationTitles.flatMap(title => FAILURE_COORDINATION_BODIES.map(body => ({ title, ...body }))))('$title with $key is $category', ({ title, description, category }) => {
    const occupation = occupationFacts({ title, description, departments: ['Hardware'] })
    expect({ version: occupation.version, category: occupation.category }).toEqual({ version: 7, category })
  })

  it('keeps software that analyzes boards engineering while a subsequent manual inspection makes the same role other', () => {
    const analyzes = FAILURE_ATTRIBUTION_BODIES.find(body => body.key === 'software-that-analyzes-boards')!
    const manual = FAILURE_COORDINATION_BODIES.find(body => body.key === 'software-purpose-then-manual-inspection')!
    for (const title of coordinationTitles) {
      expect(occupationFacts({ title, description: analyzes.description, departments: ['Hardware'] }).category, `${title}: ${analyzes.key}`).toBe('engineering')
      expect(occupationFacts({ title, description: manual.description, departments: ['Hardware'] }).category, `${title}: ${manual.key}`).toBe('other')
    }
  })
})

// Supplement after main's integration concern about the early writing/finance/assistant guard.
// Expectations follow contract rules 2 and 4; management priority is unchanged.
describe('named non-development roles with an explicit SDET co-role, audience or team suffix', () => {
  it.each(NAMED_ROLE_CO_ROLE_CASES)('$title is $category', fixture => {
    expect(assess(fixture)).toMatchObject(expected(fixture))
  })
})

// Supplement after Astra's consolidated review of implementation-03 (findings 1–3).
// Expectations follow contract rules 2, 5 and 6.
describe('implementation review 03 regressions: internship programme roles, own subjects, manual-marker polarity and actor', () => {
  it.each(INTERNSHIP_PROGRAM_ROLE_CASES)('$title is $category', fixture => {
    expect(assess(fixture)).toMatchObject(expected(fixture))
  })

  const subjectTitles = ['Failure Analysis Engineer', 'Failure Analysis Specialist']

  it.each(subjectTitles.flatMap(title => FAILURE_SUBJECT_BODIES.map(body => ({ title, ...body }))))('$title with $key is $category', ({ title, description, category }) => {
    const occupation = occupationFacts({ title, description, departments: ['Hardware'] })
    expect({ version: occupation.version, category: occupation.category }).toEqual({ version: 7, category })
  })

  it('keeps the paired coordinated other-team statement unconfirmed, an explicit own subject engineering and own manual work other', () => {
    const paired = FAILURE_COORDINATION_BODIES.find(body => body.key === 'coordinated-other-team')!
    const own = FAILURE_SUBJECT_BODIES.find(body => body.key === 'own-subject-software-other-team-firmware')!
    const manual = FAILURE_COORDINATION_BODIES.find(body => body.key === 'software-purpose-then-manual-inspection')!
    for (const title of subjectTitles) {
      expect(occupationFacts({ title, description: paired.description, departments: ['Hardware'] }).category, `${title}: ${paired.key}`).toBe('unconfirmed')
      expect(occupationFacts({ title, description: own.description, departments: ['Hardware'] }).category, `${title}: ${own.key}`).toBe('engineering')
      expect(occupationFacts({ title, description: manual.description, departments: ['Hardware'] }).category, `${title}: ${manual.key}`).toBe('other')
    }
  })
})

// Supplement after Astra's formal readiness review of the combined state (two product cases
// outside the existing literals, corrected in implementation-05). Contract rules 2, 4 and 6.
describe('readiness review regressions: SDET as a programme modifier, contextual role phrases', () => {
  it.each(SDET_MODIFIER_CASES)('$title is $category', fixture => {
    expect(assess(fixture)).toMatchObject(expected(fixture))
  })

  const contextTitles = ['Failure Analysis Engineer', 'Failure Analysis Specialist']

  it.each(contextTitles.flatMap(title => FAILURE_CONTEXT_BODIES.map(body => ({ title, ...body }))))('$title with $key is $category', ({ title, description, category }) => {
    const occupation = occupationFacts({ title, description, departments: ['Hardware'] })
    expect({ version: occupation.version, category: occupation.category }).toEqual({ version: 7, category })
  })

  it('keeps the explicit own-subject duty engineering and the coordinated other-team statement unconfirmed beside the contextual phrase', () => {
    const own = FAILURE_SUBJECT_BODIES.find(body => body.key === 'own-subject-software-other-team-firmware')!
    const coordinated = FAILURE_COORDINATION_BODIES.find(body => body.key === 'coordinated-other-team')!
    const contextual = FAILURE_CONTEXT_BODIES.find(body => body.key === 'contextual-role-other-team')!
    for (const title of contextTitles) {
      expect(occupationFacts({ title, description: own.description, departments: ['Hardware'] }).category, `${title}: ${own.key}`).toBe('engineering')
      expect(occupationFacts({ title, description: coordinated.description, departments: ['Hardware'] }).category, `${title}: ${coordinated.key}`).toBe('unconfirmed')
      expect(occupationFacts({ title, description: contextual.description, departments: ['Hardware'] }).category, `${title}: ${contextual.key}`).toBe('unconfirmed')
    }
  })
})

// Supplement after Astra's review of implementation-05 (two cases outside the literals).
// Contract rules 2, 4 and 6.
describe('implementation review 05 regressions: activity conjunctions, governing worker predicates', () => {
  it.each(SDET_ACTIVITY_CONJUNCTION_CASES)('$title is $category', fixture => {
    expect(assess(fixture)).toMatchObject(expected(fixture))
  })

  const governingTitles = ['Failure Analysis Engineer', 'Failure Analysis Specialist']

  it.each(governingTitles.flatMap(title => FAILURE_GOVERNING_BODIES.map(body => ({ title, ...body }))))('$title with $key is $category', ({ title, description, category }) => {
    const occupation = occupationFacts({ title, description, departments: ['Hardware'] })
    expect({ version: occupation.version, category: occupation.category }).toEqual({ version: 7, category })
  })

  it('distinguishes a governing "You focus on" duty from the contextual "For this role" statement in the same words', () => {
    const governing = FAILURE_GOVERNING_BODIES.find(body => body.key === 'you-focus-on-software-other-team-firmware')!
    const contextual = FAILURE_CONTEXT_BODIES.find(body => body.key === 'contextual-role-other-team')!
    for (const title of governingTitles) {
      expect(occupationFacts({ title, description: governing.description, departments: ['Hardware'] }).category, `${title}: ${governing.key}`).toBe('engineering')
      expect(occupationFacts({ title, description: contextual.description, departments: ['Hardware'] }).category, `${title}: ${contextual.key}`).toBe('unconfirmed')
    }
  })
})

// Supplement after Astra's readiness review 02 (one uncovered combination). Contract rule 6.
describe('readiness review 02 regression: a role introduction before a governing worker predicate', () => {
  const introductionTitles = ['Failure Analysis Engineer', 'Failure Analysis Specialist']

  it.each(introductionTitles.flatMap(title => FAILURE_INTRODUCTION_BODIES.map(body => ({ title, ...body }))))('$title with $key is $category', ({ title, description, category }) => {
    const occupation = occupationFacts({ title, description, departments: ['Hardware'] })
    expect({ version: occupation.version, category: occupation.category }).toEqual({ version: 7, category })
  })

  it('keeps the introduced, the unprefixed and the context-only forms of the same sentence apart', () => {
    const introduced = FAILURE_INTRODUCTION_BODIES.find(body => body.key === 'introduction-you-focus-on')!
    const unprefixed = FAILURE_GOVERNING_BODIES.find(body => body.key === 'you-focus-on-software-other-team-firmware')!
    const contextual = FAILURE_CONTEXT_BODIES.find(body => body.key === 'contextual-role-other-team')!
    const introductionOnly = FAILURE_INTRODUCTION_BODIES.find(body => body.key === 'introduction-only-other-team')!
    for (const title of introductionTitles) {
      expect(occupationFacts({ title, description: introduced.description, departments: ['Hardware'] }).category, `${title}: ${introduced.key}`).toBe('engineering')
      expect(occupationFacts({ title, description: unprefixed.description, departments: ['Hardware'] }).category, `${title}: ${unprefixed.key}`).toBe('engineering')
      expect(occupationFacts({ title, description: contextual.description, departments: ['Hardware'] }).category, `${title}: ${contextual.key}`).toBe('unconfirmed')
      expect(occupationFacts({ title, description: introductionOnly.description, departments: ['Hardware'] }).category, `${title}: ${introductionOnly.key}`).toBe('unconfirmed')
    }
  })
})

// Supplement after Astra's review of the source07 proposal (one extraction regression). Contract rule 6.
describe('source correction 07 regression: a later role noun inside the worker\'s own duty', () => {
  const laterNounTitles = ['Failure Analysis Engineer', 'Failure Analysis Specialist']

  it.each(laterNounTitles.flatMap(title => FAILURE_LATER_ROLE_NOUN_BODIES.map(body => ({ title, ...body }))))('$title with $key is $category', ({ title, description, category }) => {
    const occupation = occupationFacts({ title, description, departments: ['Hardware'] })
    expect({ version: occupation.version, category: occupation.category }).toEqual({ version: 7, category })
  })

  it('keeps the helping-another-engineer duty engineering beside the introduction-only and negated forms', () => {
    const helping = FAILURE_LATER_ROLE_NOUN_BODIES.find(body => body.key === 'introduction-comma-helping-another-engineer')!
    const introduced = FAILURE_INTRODUCTION_BODIES.find(body => body.key === 'introduction-you-focus-on')!
    const introductionOnly = FAILURE_LATER_ROLE_NOUN_BODIES.find(body => body.key === 'introduction-comma-only-other-team')!
    const negated = FAILURE_LATER_ROLE_NOUN_BODIES.find(body => body.key === 'introduction-comma-negated-focus')!
    for (const title of laterNounTitles) {
      expect(occupationFacts({ title, description: helping.description, departments: ['Hardware'] }).category, `${title}: ${helping.key}`).toBe('engineering')
      expect(occupationFacts({ title, description: introduced.description, departments: ['Hardware'] }).category, `${title}: ${introduced.key}`).toBe('engineering')
      expect(occupationFacts({ title, description: introductionOnly.description, departments: ['Hardware'] }).category, `${title}: ${introductionOnly.key}`).toBe('unconfirmed')
      expect(occupationFacts({ title, description: negated.description, departments: ['Hardware'] }).category, `${title}: ${negated.key}`).toBe('unconfirmed')
    }
  })
})
