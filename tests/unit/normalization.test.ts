import { describe, expect, it } from 'vitest'
import { analyzeResume, extractSkills, extractYears } from '../../shared/profile'
import { detectVisa, locateCities, normalizeJob, parseSalary, plainText, remoteScope } from '../../server/normalize'
import type { GreenhouseJob } from '../../server/normalize'

const NOW = '2026-09-19T00:00:00.000Z'
const rawJob = (values: Partial<GreenhouseJob> = {}): GreenhouseJob => ({
  id: 123, title: 'Senior Software Engineer, Backend',
  absolute_url: 'https://example.com/jobs/123',
  location: { name: 'London, UK' }, content: '<p>5+ years of software engineering experience. Python, AWS and PostgreSQL.</p>',
  ...values,
})

describe('public board normalization', () => {
  it('uses a vacancy location and keeps unknown conditions unknown', () => {
    const result = normalizeJob(rawJob(), 'stripe', NOW)!
    expect(result.cityIds).toEqual(['london'])
    expect(result.workMode).toBe('unknown')
    expect(result.visa).toBe('unknown')
    expect(result.employment).toBe('unknown')
    expect(result.salary).toBeNull()
    expect(result.skills).toEqual(expect.arrayContaining(['Python', 'AWS', 'PostgreSQL']))
    expect(result.source).toBe('greenhouse')
    expect(result.fetchedAt).toBe(NOW)
  })

  it('reads job-specific locations when the location field only says Hybrid', () => {
    const result = normalizeJob(rawJob({
      location: { name: 'Hybrid' },
      metadata: [{ name: 'Job Posting Location', value: ['London, UK', 'Austin, US'] }],
      offices: [{ name: 'San Francisco, CA' }],
    }), 'cloudflare', NOW)!
    expect(result.cityIds).toEqual(['austin', 'london'])
    expect(result.workMode).toBe('hybrid')
    expect(result.cityIds).not.toContain('san-francisco')
  })

  it('uses attached office data only when no specific workplace was supplied', () => {
    expect(normalizeJob(rawJob({ location: { name: 'In-Office' }, offices: [{ location: 'London, UK' }] }), 'cloudflare', NOW)?.cityIds).toEqual(['london'])
    expect(normalizeJob(rawJob({ location: { name: 'Warsaw, Poland' }, offices: [{ location: 'London, UK' }] }), 'cloudflare', NOW)?.cityIds).toEqual([])
  })

  it('reads remote metadata without using office tags to imply eligibility', () => {
    const result = normalizeJob(rawJob({
      location: { name: 'United States' },
      metadata: [{ name: 'Workplace Type', value: 'Remote' }],
      offices: [{ name: 'London, UK' }],
    }), 'airbnb', NOW)!
    expect(result.workMode).toBe('remote')
    expect(result.cityIds).toEqual([])
    expect(result.remoteCountries).toEqual(['US'])
    expect(result.locationLabel).not.toContain('London')
    expect(result.locationLabel).toContain('United States')
  })

  it('keeps remote countries separate and does not expand vague geographic labels', () => {
    expect(remoteScope('Remote - Germany, Netherlands').remoteCountries).toEqual(['DE', 'NL'])
    expect(remoteScope('Remote - EMEA').remoteScopeUnknown).toBe(true)
    expect(remoteScope('Remote - Worldwide').remoteWorldwide).toBe(true)
    expect(normalizeJob(rawJob({ location: { name: 'San Francisco, CA (Remote)' } }), 'stripe', NOW)?.cityIds).toEqual([])
  })

  it('handles aliases without conflating identically named cities', () => {
    expect(locateCities('San Francisco, CA; New York, NY; Zürich, Switzerland')).toEqual(['san-francisco', 'new-york', 'zurich'])
    expect(locateCities('Bangalore, India')).toEqual(['bengaluru'])
    expect(locateCities('London, Ontario, Canada')).toEqual([])
    expect(locateCities('Vancouver, WA, United States')).toEqual([])
    expect(locateCities('Dublin, Ohio')).toEqual([])
  })

  it('requires explicit sponsorship evidence and respects negation', () => {
    expect(detectVisa('We offer visa sponsorship.')).toBe('yes')
    expect(detectVisa('Visa sponsorship is available.')).toBe('yes')
    expect(detectVisa('We cannot sponsor visas for this role.')).toBe('no')
    expect(detectVisa('Visa sponsorship is not available.')).toBe('no')
    expect(detectVisa('Visa sponsorship may be available.')).toBe('unknown')
    expect(detectVisa('Relocation support and an international team.')).toBe('unknown')
  })

  it('only includes engineering roles and valid application URLs', () => {
    expect(normalizeJob(rawJob({ title: 'Account Executive' }), 'stripe', NOW)).toBeNull()
    expect(normalizeJob(rawJob({ title: 'Engineering Manager' }), 'stripe', NOW)).toBeNull()
    expect(normalizeJob(rawJob({ title: 'Customer Engineer, Korea' }), 'cloudflare', NOW)).toBeNull()
    expect(normalizeJob(rawJob({ absolute_url: 'javascript:alert(1)' }), 'stripe', NOW)).toBeNull()
  })

  it('decodes board HTML into inert text, including encoded markup', () => {
    expect(plainText('&lt;p&gt;Python &amp;amp; React&lt;/p&gt;&lt;script&gt;bad()&lt;/script&gt;')).toBe('Python & React')
  })
})

describe('salary disclosure', () => {
  it('extracts annual ranges and an explicitly named currency', () => {
    expect(parseSalary('Base pay range: $145,000 — $195,000 USD per year.', [])).toEqual({ min: 145000, max: 195000, currency: 'USD' })
    expect(parseSalary('Annual salary: £85k - £120k', ['london'])).toEqual({ min: 85000, max: 120000, currency: 'GBP' })
    expect(parseSalary('Annual base salary €90,000–€130,000', ['berlin'])).toEqual({ min: 90000, max: 130000, currency: 'EUR' })
  })

  it('does not assume an unknown dollar currency or annualize an hourly rate', () => {
    expect(parseSalary('Salary range: $100,000–$150,000', ['singapore'])).toBeNull()
    expect(parseSalary('Hourly base pay: $90 - $120 per hour', ['san-francisco'])).toBeNull()
    expect(parseSalary('Equity grant: $10,000 - $50,000', ['san-francisco'])).toBeNull()
  })
})

describe('local resume parsing', () => {
  it('extracts reviewable experience without fabricating years from dates', () => {
    const result = analyzeResume('Alex Kim\nBackend Engineer\n5년 경력. Python, PostgreSQL, AWS로 결제 서비스를 개발했습니다.')
    expect(result.profile.name).toBe('Alex Kim')
    expect(result.profile.years).toBe(5)
    expect(result.profile.skills).toEqual(expect.arrayContaining(['Python', 'PostgreSQL', 'AWS']))
    expect(extractYears('Graduated in 2020. Developed product in 2024.')).toBeNull()
    expect(analyzeResume('Software Engineer\nPython, AWS and React developer.').warnings.length).toBeGreaterThan(0)
  })

  it('respects technology word boundaries and preserves zero years', () => {
    expect(extractSkills('JavaScript and PostgreSQL')).not.toContain('Java')
    expect(extractSkills('React Native, TypeScript, Node.js')).toEqual(expect.arrayContaining(['React Native', 'React', 'TypeScript', 'Node.js']))
    expect(extractYears('0 years of experience')).toBe(0)
  })
})
