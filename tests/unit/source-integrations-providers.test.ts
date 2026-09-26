import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { asCoverageReply } from '../fixtures/public-coverage-transport'
import {
  INTEGRATION_JOBS, INTEGRATION_NOW, MICROSOFT_EXPIRED_ID,
  MICROSOFT_PUBLISHED_IDS, integrationCompany,
} from '../fixtures/source-integration-contract'
import { microsoftPages, microsoftRaw, newSourceResponses, workableRaw } from '../fixtures/source-integrations'
import type { HimalayasScenario } from '../fixtures/source-integrations'

// The real provider entry points are the subjects; all wire payloads are fake.
const attempts: { url: string; method: string; body: unknown }[] = []
const unexpected: string[] = []
beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date(INTEGRATION_NOW))
  vi.resetModules()
  attempts.length = 0
  unexpected.length = 0
})
afterEach(() => {
  expect(unexpected).toEqual([])
  expect(attempts.every(request => request.method === 'GET' && request.body === null)).toBe(true)
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function transport(responses: Record<string, unknown>) {
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input)
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET')
    attempts.push({ url, method, body: init?.body ?? null })
    if (!Object.hasOwn(responses, url) || method !== 'GET' || init?.body != null) {
      unexpected.push(url)
      throw new Error(`Blocked unscripted Stage63 request: ${method} ${url}`)
    }
    const reply = asCoverageReply(responses[url])
    if (reply.failure) throw new Error(reply.failure)
    return Response.json(reply.body, { status: reply.status ?? 200, headers: reply.headers })
  }))
}

async function settled<T>(promise: Promise<T>): Promise<T> {
  // Attach rejection handling before advancing the real queue's fake timers.
  const outcome = promise.then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error }))
  await vi.runAllTimersAsync()
  const result = await outcome
  if (!result.ok) throw result.error
  return result.value
}

describe('Himalayas public inventory and visible facts', () => {
  it('reads the expired final row before publishing one software job and two current IDs with canonical source credit', async () => {
    transport(microsoftPages())
    const { fetchHimalayasBoard } = await import('../../server/providers/himalayas')
    const result = await settled(fetchHimalayasBoard(integrationCompany('microsoft'), INTEGRATION_NOW))
    expect(attempts.map(request => request.url)).toEqual([
      'https://himalayas.app/jobs/api/search?company=microsoft&sort=recent&page=1',
      'https://himalayas.app/jobs/api/search?company=microsoft&sort=recent&page=2',
    ])
    expect(result).toMatchObject({ total: 2, unmappedCount: 0, publishedIds: MICROSOFT_PUBLISHED_IDS })
    expect(result.jobs).toHaveLength(1)
    expect(result.jobs[0]).toMatchObject({
      ...INTEGRATION_JOBS[0], fetchedAt: '2026-10-01T23:40:00.000Z', updatedAt: null,
      visa: 'unknown', salary: null,
      compensationRanges: [{ min: 150000, max: 180000, currency: 'USD', period: 'year', basis: 'unknown' }],
      occupation: { category: 'engineering', departments: [] },
    })
    expect(result.jobs[0].occupation?.management?.value).not.toBe('management')
    expect(result.jobs[0].evidence?.workMode?.text).toContain('locationRestrictions: ["South Korea"]')
    expect(result.jobs[0].evidence?.workMode?.text).toContain('timezoneRestrictions: [9]')
    expect(result.publishedIds).not.toContain(MICROSOFT_EXPIRED_ID)
    expect(JSON.stringify(result.jobs)).not.toContain('do-not-substitute-application-link')
  })

  it('ignores body fields on presence and does not interpret publication/feed timestamps as body revisions', async () => {
    transport(microsoftPages('presence-invalid-body'))
    const { fetchHimalayasBoard, fetchHimalayasPresence } = await import('../../server/providers/himalayas')
    const listed = await settled(fetchHimalayasPresence(integrationCompany('microsoft'), INTEGRATION_NOW))
    expect(listed).toEqual({ total: 2, publishedIds: MICROSOFT_PUBLISHED_IDS })
    expect(listed).not.toHaveProperty('jobs')
    await expect(settled(fetchHimalayasBoard(integrationCompany('microsoft'), INTEGRATION_NOW))).rejects.toThrow()
    expect(attempts).toHaveLength(4)
  })

  it.each([
    'short-first', 'empty-final', 'duplicate', 'wrong-slug', 'wrong-guid-company',
    'wrong-guid-origin', 'wrong-offset', 'changed-total', 'changed-limit',
    'malformed-required', 'expired-foreign-guid', 'expired-duplicate', 'final-503',
  ] satisfies HimalayasScenario[])('rejects %s instead of returning partial results or an empty success', async scenario => {
    transport(microsoftPages(scenario))
    const { fetchHimalayasBoard } = await import('../../server/providers/himalayas')
    await expect(settled(fetchHimalayasBoard(integrationCompany('microsoft'), INTEGRATION_NOW))).rejects.toThrow()
    expect(attempts.length).toBeGreaterThan(0)
    expect(attempts.length).toBeLessThanOrEqual(2)
  })

  it.each(['empty-final', 'duplicate', 'wrong-slug', 'expired-foreign-guid'] satisfies HimalayasScenario[])(
    'also rejects %s on the independent presence entry point', async scenario => {
      transport(microsoftPages(scenario))
      const { fetchHimalayasPresence } = await import('../../server/providers/himalayas')
      await expect(settled(fetchHimalayasPresence(integrationCompany('microsoft'), INTEGRATION_NOW))).rejects.toThrow()
    },
  )

  it('accepts a truly empty complete page, while an empty page promising one job remains a failure', async () => {
    const url = 'https://himalayas.app/jobs/api/search?company=microsoft&sort=recent&page=1'
    const responses: Record<string, unknown> = { [url]: { offset: 0, limit: 20, totalCount: 0, jobs: [] } }
    transport(responses)
    const { fetchHimalayasBoard } = await import('../../server/providers/himalayas')
    expect(await settled(fetchHimalayasBoard(integrationCompany('microsoft'), INTEGRATION_NOW))).toMatchObject({
      total: 0, jobs: [], publishedIds: [], unmappedCount: 0,
    })
    responses[url] = { offset: 0, limit: 20, totalCount: 1, jobs: [] }
    await expect(settled(fetchHimalayasBoard(integrationCompany('microsoft'), INTEGRATION_NOW))).rejects.toThrow()
  })

  it('shares a real Retry-After queue across Himalayas companies and phases without blocking Workable', async () => {
    const responses = { ...newSourceResponses(), ...microsoftPages('final-429') }
    transport(responses)
    const { fetchHimalayasBoard, fetchHimalayasPresence } = await import('../../server/providers/himalayas')
    const { fetchWorkableBoard } = await import('../../server/providers/workable')
    await expect(settled(fetchHimalayasPresence(integrationCompany('microsoft'), INTEGRATION_NOW))).rejects.toMatchObject({
      retryAfter: Date.parse('2026-10-01T23:42:01.000Z'),
    })
    await expect(settled(fetchHimalayasBoard(integrationCompany('adobe'), INTEGRATION_NOW))).rejects.toThrow()
    expect(attempts).toHaveLength(2)
    expect((await settled(fetchWorkableBoard(integrationCompany('smartnews'), INTEGRATION_NOW))).jobs).toHaveLength(1)
    expect(attempts).toHaveLength(3)
    Object.assign(responses, microsoftPages())
    vi.setSystemTime(new Date('2026-10-01T23:42:00.999Z'))
    await expect(settled(fetchHimalayasBoard(integrationCompany('microsoft'), INTEGRATION_NOW))).rejects.toThrow()
    expect(attempts).toHaveLength(3)
    vi.setSystemTime(new Date('2026-10-01T23:42:01.000Z'))
    expect((await settled(fetchHimalayasBoard(integrationCompany('microsoft'), '2026-10-01T23:42:01.000Z'))).jobs[0])
      .toMatchObject({ id: INTEGRATION_JOBS[0].id, url: INTEGRATION_JOBS[0].url })
    expect(attempts).toHaveLength(5)
  })

  it('supports both documented concrete date/country variants and never converts candidate countries into office cities', async () => {
    transport(newSourceResponses())
    const { fetchHimalayasBoard } = await import('../../server/providers/himalayas')
    for (const companyId of ['adobe', 'salesforce', 'cisco', 'qualcomm', 'broadcom', 'redhat']) {
      const result = await settled(fetchHimalayasBoard(integrationCompany(companyId), INTEGRATION_NOW))
      expect(result.jobs).toHaveLength(1)
      expect(result.jobs[0]).toMatchObject({
        ...INTEGRATION_JOBS.find(job => job.companyId === companyId),
        updatedAt: null, fetchedAt: INTEGRATION_NOW, visa: 'unknown',
      })
      expect(result.jobs[0].workplaceLocations?.locations ?? []).toEqual([])
    }
  })

  it.each([
    ['month', 5000, 6000, 'month'], ['hour', 40, 60, 'hour'], ['fortnight', 2000, 3000, 'unknown'],
  ] as const)('retains API-only %s pay without inventing comparable annual base pay', async (salaryPeriod, minSalary, maxSalary, period) => {
    const { HimalayasJobSchema, normalizeHimalayasJob } = await import('../../server/providers/himalayas')
    const job = normalizeHimalayasJob(HimalayasJobSchema.parse(microsoftRaw({ salaryPeriod, minSalary, maxSalary })), 'microsoft', INTEGRATION_NOW)!
    expect(job.salary).toBeNull()
    expect(job.compensationRanges).toEqual([expect.objectContaining({
      min: minSalary, max: maxSalary, currency: 'USD', period, basis: 'unknown',
    })])
  })

  it('prefers a literal annual base range in the description to differently sized API-only metadata', async () => {
    const { HimalayasJobSchema, normalizeHimalayasJob } = await import('../../server/providers/himalayas')
    const job = normalizeHimalayasJob(HimalayasJobSchema.parse(microsoftRaw({
      description: '<p>Build a fictional backend API with TypeScript.</p><p>The annual base salary for this role is USD $120,000 - $160,000.</p>',
    })), 'microsoft', INTEGRATION_NOW)!
    expect(job.salary).toEqual({ min: 120000, max: 160000, currency: 'USD' })
    expect(job.compensationRanges?.some(range => range.min === 150000)).toBe(false)
  })

  it('retains an explicit hybrid schedule with unknown workplace location and no invented office city', async () => {
    const { HimalayasJobSchema, normalizeHimalayasJob } = await import('../../server/providers/himalayas')
    const job = normalizeHimalayasJob(HimalayasJobSchema.parse(microsoftRaw({
      description: '<p>This role follows an office-centric hybrid schedule.</p><p>Build a fictional backend API with TypeScript.</p>',
    })), 'microsoft', INTEGRATION_NOW)!
    expect(job).toMatchObject({ cityIds: [], workMode: 'hybrid', locationLabel: '근무지 미확인' })
    expect(job.remoteWorldwide).toBe(false)
  })

  it.each([
    'This role follows an office-centric hybrid schedule. This role is fully remote.',
    'This role is not remote.',
    'This is a non-remote role.',
  ])('preserves uncertainty from explicit conflicting or negative vacancy prose: %s', async description => {
    const { HimalayasJobSchema, normalizeHimalayasJob } = await import('../../server/providers/himalayas')
    const job = normalizeHimalayasJob(HimalayasJobSchema.parse(microsoftRaw({
      description: `<p>${description}</p><p>Build a fictional backend API with TypeScript.</p>`,
    })), 'microsoft', INTEGRATION_NOW)!
    expect(job).toMatchObject({
      workMode: 'unknown', cityIds: [], locationLabel: '근무지 미확인',
      remoteCountries: [], remoteWorldwide: false,
      evidence: { workMode: { source: 'description' } },
    })
    expect(job.evidence?.workMode?.text.replace(/\s+/g, ' ')).toBe(description)
  })

  it.each([
    'Our company follows a hybrid schedule.',
    'This role follows hybrid cloud architecture standards.',
  ])('retains the remote feed for company policy or technical product prose: %s', async description => {
    const { HimalayasJobSchema, normalizeHimalayasJob } = await import('../../server/providers/himalayas')
    const job = normalizeHimalayasJob(HimalayasJobSchema.parse(microsoftRaw({
      description: `<p>${description}</p><p>Build a fictional backend API with TypeScript.</p>`,
    })), 'microsoft', INTEGRATION_NOW)!
    expect(job).toMatchObject({
      workMode: 'remote', cityIds: [], locationLabel: 'South Korea · Remote · 시간대 조건 확인',
      remoteCountries: ['KR'], remoteWorldwide: false,
      evidence: { workMode: { source: 'board' } },
    })
  })
})

describe('Workable official account, body and hidden locations', () => {
  it('collects all three official accounts with independent literal IDs, locations and canonical job URLs', async () => {
    transport(newSourceResponses())
    const { fetchWorkableBoard } = await import('../../server/providers/workable')
    for (const id of ['hugging-face', 'smartnews', 'mercari']) {
      const result = await settled(fetchWorkableBoard(integrationCompany(id), INTEGRATION_NOW))
      expect(result.total).toBe(1)
      expect(result.jobs).toHaveLength(1)
      expect(result.jobs[0]).toMatchObject({
        ...INTEGRATION_JOBS.find(job => job.companyId === id), updatedAt: null, fetchedAt: INTEGRATION_NOW,
      })
    }
    expect(attempts.map(request => request.url)).toEqual([
      'https://apply.workable.com/api/v1/widget/accounts/huggingface?details=true',
      'https://apply.workable.com/api/v1/widget/accounts/smartnews?details=true',
      'https://apply.workable.com/api/v1/widget/accounts/mercari?details=true',
    ])
  })

  it.each(['hidden', 'empty', 'mixed'] as const)('does not fall back to the private primary address for %s locations', async scenario => {
    const locations = scenario === 'hidden'
      ? [{ city: 'New York', country: 'United States', countryCode: 'US', hidden: true }]
      : scenario === 'empty' ? [] : [
        { city: 'New York', country: 'United States', countryCode: 'US', hidden: true },
        { city: 'Berlin', country: 'Germany', countryCode: 'DE', hidden: false },
      ]
    const { WorkableJobSchema, normalizeWorkableJob } = await import('../../server/providers/workable')
    const job = normalizeWorkableJob(WorkableJobSchema.parse(workableRaw({ locations })), 'smartnews', INTEGRATION_NOW)!
    expect(job).toMatchObject(scenario === 'mixed'
      ? { locationLabel: 'Berlin, Germany', cityIds: ['berlin'], workMode: 'unknown' }
      : { locationLabel: '근무지 미확인', cityIds: [], workMode: 'unknown' })
    expect(JSON.stringify(job)).not.toContain('New York')
    expect(JSON.stringify(job)).not.toContain('Tokyo')
    expect(job.remoteWorldwide).toBe(false)
  })

  it('accepts an absent locations field as public primary input, but never treats telecommuting:false as onsite', async () => {
    const { WorkableJobSchema, normalizeWorkableJob } = await import('../../server/providers/workable')
    const job = normalizeWorkableJob(WorkableJobSchema.parse(workableRaw({ locations: undefined })), 'smartnews', INTEGRATION_NOW)!
    expect(job).toMatchObject({ cityIds: ['tokyo'], workMode: 'unknown', updatedAt: null })
  })

  it('requires explicit onsite prose when telecommuting is false and retains a true ATS remote field over prose', async () => {
    const { WorkableJobSchema, normalizeWorkableJob } = await import('../../server/providers/workable')
    const description = '<p>This position follows an on-site work arrangement.</p><p>Build a fictional backend API with TypeScript.</p>'
    const onsite = normalizeWorkableJob(WorkableJobSchema.parse(workableRaw({
      telecommuting: false, description,
    })), 'smartnews', INTEGRATION_NOW)!
    expect(onsite).toMatchObject({ workMode: 'onsite', cityIds: [], locationLabel: '근무지 미확인' })
    const remote = normalizeWorkableJob(WorkableJobSchema.parse(workableRaw({
      telecommuting: true, description,
    })), 'smartnews', INTEGRATION_NOW)!
    expect(remote).toMatchObject({
      workMode: 'remote', cityIds: [],
      evidence: { workMode: { source: 'board', text: 'telecommuting: true' } },
    })
  })

  it('uses only the body-free endpoint for presence and rejects an unreadable full body independently', async () => {
    const responses = newSourceResponses()
    responses['https://apply.workable.com/api/v1/widget/accounts/smartnews?details=true'] = {
      name: 'SmartNews, Inc.', jobs: [workableRaw({ description: { invalid: true } })],
    }
    transport(responses)
    const { fetchWorkableBoard, fetchWorkablePresence } = await import('../../server/providers/workable')
    expect(await settled(fetchWorkablePresence(integrationCompany('smartnews')))).toEqual({
      total: 1, publishedIds: ['workable-smartnews-SN63HIDDEN'],
    })
    expect(attempts.map(request => request.url)).toEqual(['https://apply.workable.com/api/v1/widget/accounts/smartnews'])
    await expect(settled(fetchWorkableBoard(integrationCompany('smartnews'), INTEGRATION_NOW))).rejects.toThrow()
  })

  it.each(['foreign-name', 'foreign-shortcode', 'foreign-host', 'duplicate', 'empty-wrong-name'] as const)(
    'rejects %s without fabricating a zero board', async scenario => {
      const jobs = scenario === 'empty-wrong-name' ? [] : [workableRaw({
        ...(scenario === 'foreign-shortcode' ? { url: 'https://apply.workable.com/j/OTHER63/' } : {}),
        ...(scenario === 'foreign-host' ? { url: 'https://example.com/j/SN63HIDDEN/' } : {}),
      })]
      if (scenario === 'duplicate') jobs.push({ ...jobs[0] })
      const feed = { name: scenario === 'foreign-name' || scenario === 'empty-wrong-name' ? 'Foreign Company63' : 'SmartNews, Inc.', jobs }
      transport({
        'https://apply.workable.com/api/v1/widget/accounts/smartnews?details=true': feed,
        'https://apply.workable.com/api/v1/widget/accounts/smartnews': feed,
      })
      const { fetchWorkableBoard, fetchWorkablePresence } = await import('../../server/providers/workable')
      await expect(settled(fetchWorkableBoard(integrationCompany('smartnews'), INTEGRATION_NOW))).rejects.toThrow()
      await expect(settled(fetchWorkablePresence(integrationCompany('smartnews')))).rejects.toThrow()
    },
  )
})
