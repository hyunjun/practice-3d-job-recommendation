import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CITIES } from '../../shared/cities'
import { COUNTRY_DATA } from '../../shared/country-data'
import { COUNTRY_BY_CODE, COUNTRY_OPTIONS } from '../../shared/countries'
import { upgradeJob } from '../../shared/job-upgrade'
import { locateCities, normalizeJob, postingCities } from '../../server/normalize'
import { normalizeAshbyJob } from '../../server/providers/ashby'
import { normalizeLeverJob } from '../../server/providers/lever'
import { normalizeSmartRecruitersJob } from '../../server/providers/smartrecruiters'
import {
  REGIONAL_ALIAS_CASES, REGIONAL_MIXED_CASES, REGIONAL_NEGATIVE_LABELS,
  REGIONAL_NEW_CITIES, REGIONAL_NEW_POSTINGS, REGIONAL_TIME,
} from '../fixtures/regional-coverage'

const noNetwork = vi.fn(async () => { throw new Error('Regional unit tests must not use an upstream or cache.') })
beforeEach(() => { noNetwork.mockClear(); vi.stubGlobal('fetch', noNetwork) })
afterEach(() => { expect(noNetwork).not.toHaveBeenCalled(); vi.unstubAllGlobals() })

describe('independent35-city registration and display-country contract', () => {
  it('keeps the original22 and adds exactly the approved13 cities', () => {
    expect(CITIES.map(city => city.id).sort()).toEqual([
      'amsterdam', 'atlanta', 'auckland', 'austin', 'bangkok', 'barcelona', 'bengaluru',
      'berlin', 'boston', 'christchurch', 'dubai', 'dublin', 'hong-kong', 'hsinchu',
      'kuala-lumpur', 'lisbon', 'london', 'los-angeles', 'manila', 'melbourne', 'new-york',
      'paris', 'portland', 'san-francisco', 'seattle', 'seoul', 'singapore', 'stockholm',
      'sydney', 'taipei', 'tokyo', 'toronto', 'vancouver', 'wellington', 'zurich',
    ])
    expect(CITIES).toHaveLength(35)
    expect(CITIES.filter(city => city.region === 'americas')).toHaveLength(10)
    expect(CITIES.filter(city => city.region === 'europe')).toHaveLength(9)
    expect(CITIES.filter(city => city.region === 'asia-pacific')).toHaveLength(15)
    expect(CITIES.filter(city => city.region === 'middle-east').map(city => city.id)).toEqual(['dubai'])
    for (const { id, name, en, countryCode, region, timezone } of REGIONAL_NEW_CITIES) {
      expect(CITIES.find(city => city.id === id), id).toMatchObject({ id, name, en, countryCode, region, timezone })
    }
  })

  it('overrides exactly the approved16 display countries while preserving the original reference table', () => {
    expect([...COUNTRY_BY_CODE.values()].filter(country => country.region === 'middle-east').map(country => country.code).sort())
      .toEqual(['AE', 'BH', 'EG', 'IL', 'IQ', 'IR', 'JO', 'KW', 'LB', 'OM', 'PS', 'QA', 'SA', 'SY', 'TR', 'YE'])
    expect(COUNTRY_BY_CODE.get('NZ')?.region).toBe('asia-pacific')
    expect(COUNTRY_BY_CODE.get('TW')?.region).toBe('asia-pacific')
    expect(COUNTRY_BY_CODE.get('CY')?.region).toBe('asia-pacific')
    expect(COUNTRY_BY_CODE.get('AF')?.region).toBe('asia-pacific')
    expect(COUNTRY_OPTIONS).toHaveLength(250)
    expect(COUNTRY_DATA.filter(row => ['AE', 'EG', 'IL', 'TR', 'NZ', 'TW'].includes(row[0]))).toEqual([
      ['AE', 'ARE', 'asia-pacific', 'United Arab Emirates'],
      ['EG', 'EGY', null, 'Egypt'],
      ['IL', 'ISR', 'asia-pacific', 'Israel'],
      ['NZ', 'NZL', 'asia-pacific', 'New Zealand'],
      ['TR', 'TUR', 'asia-pacific', 'Türkiye'],
      ['TW', 'TWN', 'asia-pacific', 'Taiwan'],
    ])
  })
})

describe('posting-local city names and approved metro aliases', () => {
  it.each([...REGIONAL_NEW_POSTINGS, ...REGIONAL_ALIAS_CASES])('$label maps only to its approved city', ({ label, expected }) => {
    expect(locateCities(label).sort(), label).toEqual(expected)
  })
  it.each(REGIONAL_NEGATIVE_LABELS)('%s is not an approved city interpretation', label => {
    expect(locateCities(label), label).toEqual([])
  })
  it.each(REGIONAL_MIXED_CASES)('preserves valid workplaces in $label', ({ label, expected }) => {
    expect(locateCities(label).sort(), label).toEqual(expected)
  })

  it.each([
    { label: 'Paris or London', expected: ['london', 'paris'] },
    { label: 'PARIS OR LONDON', expected: ['london', 'paris'] },
    { label: 'Taipei or Hsinchu', expected: ['hsinchu', 'taipei'] },
    { label: 'TAIPEI OR HSINCHU', expected: ['hsinchu', 'taipei'] },
    { label: 'Berlin, DE', expected: ['berlin'] },
    { label: 'Bengaluru, IN', expected: ['bengaluru'] },
    { label: 'Vancouver, CA', expected: ['vancouver'] },
  ])('keeps country abbreviations and city-list conjunctions distinct in $label', ({ label, expected }) => {
    expect(locateCities(label).sort()).toEqual(expected)
  })

  it('keeps independent structured locations separate, including reversed invalid/valid Portland sources', () => {
    const maine = { label: 'Portland, ME, United States', address: {
      addressLocality: 'Portland', addressRegion: 'ME', addressCountry: 'US',
    } }
    const oregon = { label: 'Portland, OR, United States', address: {
      addressLocality: 'Portland', addressRegion: 'OR', addressCountry: 'US',
    } }
    expect(postingCities([maine, oregon])).toEqual(['portland'])
    expect(postingCities([oregon, maine])).toEqual(['portland'])
    expect(postingCities([maine])).toEqual([])
  })

  it.each(['NZ', 'Unknown Republic'])('does not reinterpret Taipei with contradictory/unknown country %s', country => {
    expect(postingCities([{
      label: 'Taipei, Taiwan', address: { addressLocality: 'Taipei', addressCountry: country },
    }])).toEqual([])
    expect(postingCities([
      { label: 'Taipei, Taiwan', address: { addressLocality: 'Taipei', addressCountry: country } },
      { label: 'Dubai, United Arab Emirates', address: { addressLocality: 'Dubai', addressCountry: 'AE' } },
    ])).toEqual(['dubai'])
  })

  it.each(['Taiwan', 'New Zealand', 'UAE'])('a structured country-only %s field never supplies a city', country => {
    expect(postingCities([{ label: country, address: { addressCountry: country } }])).toEqual([])
  })
})

describe('raw provider normalization reaches the new geography without extra assumptions', () => {
  const base = {
    id: 7001, title: 'Backend Engineer — Synthetic Signal',
    absolute_url: 'https://example.test/regional/7001',
    content: '<p>Requirements: experience with TypeScript.</p>',
  }
  it.each(REGIONAL_NEW_POSTINGS)('Greenhouse retains the literal location for $id', ({ label, expected }) => {
    const job = normalizeJob({ ...base, location: { name: label } }, 'regional-cedar', REGIONAL_TIME)!
    expect(job.cityIds).toEqual(expected)
    expect(job.locationLabel).toBe(label)
    expect(job).toMatchObject({
      id: 'greenhouse-regional-cedar-7001', fetchedAt: '2026-09-27T06:00:00.000Z',
      url: 'https://example.test/regional/7001', source: 'greenhouse',
    })
  })

  it('does not use company headquarters, applicant residence or broader office tags as a supplied job location', () => {
    const job = normalizeJob({
      ...base, location: { name: 'Unassigned Workshop' },
      title: 'Backend Engineer — Taipei Client Integrations',
      offices: [{ name: 'Dubai' }, { name: 'Los Angeles' }],
      content: '<p>Our headquarters are in Taipei. Applicants may live in Auckland. Team retreats take place in Manila. Requirements: TypeScript.</p>',
    }, 'regional-cedar', REGIONAL_TIME)!
    expect(job.cityIds).toEqual([])
    expect(job.locationLabel).toBe('Unassigned Workshop')
  })

  it('respects vacancy metadata over a generic label while keeping remote pins empty', () => {
    const job = normalizeJob({
      ...base, location: { name: 'Hybrid' },
      metadata: [{ name: 'Job Posting Location', value: ['Dubai, UAE', 'Taipei, Taiwan'] }],
      offices: [{ name: 'Atlanta' }],
    }, 'regional-cedar', REGIONAL_TIME)!
    expect([...job.cityIds].sort()).toEqual(['dubai', 'taipei'])
    expect(job.workMode).toBe('hybrid')
    const remote = normalizeJob({ ...base, location: { name: 'Dubai · Remote' } }, 'regional-cedar', REGIONAL_TIME)!
    expect(remote).toMatchObject({ cityIds: [], workMode: 'remote', remoteCountries: ['AE'] })
  })

  it('Ashby retains new primary/secondary cities and rejects only the conflicting source', () => {
    const job = normalizeAshbyJob({
      id: '7002', title: 'Backend Engineer — Synthetic Signal', isListed: true,
      jobUrl: 'https://example.test/regional/ashby-7002', workplaceType: 'OnSite',
      location: 'Taipei, Taiwan', address: { postalAddress: { addressLocality: 'Taipei', addressCountry: 'NZ' } },
      secondaryLocations: [{ location: 'Dubai', address: { addressLocality: 'Dubai', addressCountry: 'ARE' } }],
      descriptionPlain: 'Requirements: TypeScript.',
    }, 'regional-ashby', REGIONAL_TIME)!
    expect(job.cityIds).toEqual(['dubai'])
    expect(job.workplaceLocations).toEqual({ version: 1, locations: [
      { label: 'Taipei, Taiwan', country: 'NZ' }, { label: 'Dubai', country: 'ARE' },
    ] })
  })

  it('Lever keeps Portland OR in a mixed primary/secondary listing', () => {
    const job = normalizeLeverJob({
      id: '7003', text: 'Backend Engineer — Synthetic Signal', hostedUrl: 'https://example.test/regional/lever-7003',
      country: 'US', workplaceType: 'onsite',
      categories: { location: 'Portland, ME', allLocations: ['Portland, ME', 'Portland, OR'] },
      descriptionPlain: 'Requirements: TypeScript.',
    }, 'regional-lever', REGIONAL_TIME)!
    expect(job.cityIds).toEqual(['portland'])
    expect(job.locationLabel).toBe('Portland, ME · Portland, OR')
  })

  it.each([
    { city: 'Wellington', region: 'Wellington', country: 'nz', expected: ['wellington'] },
    { city: 'Wellington', region: 'FL', country: 'us', expected: [] },
    { city: 'Portland', region: 'OR', country: 'us', expected: ['portland'] },
    { city: 'Portland', region: 'ME', country: 'us', expected: [] },
    { city: 'Taipei', region: '', country: '??', expected: [] },
  ])('SmartRecruiters uses its own structured $city/$region/$country', ({ city, region, country, expected }) => {
    const job = normalizeSmartRecruitersJob({
      id: '7004', name: 'Backend Engineer — Synthetic Signal',
      company: { identifier: 'RegionalSmart70' }, visibility: 'PUBLIC', active: true,
      releasedDate: REGIONAL_TIME, postingUrl: 'https://example.test/regional/smart-7004',
      location: { city, region, country, remote: false, hybrid: false },
      jobAd: { sections: { jobDescription: { text: '<p>Build backend services with TypeScript.</p>' } } },
    }, 'regional-smart', REGIONAL_TIME)!
    expect(job.cityIds).toEqual(expected)
    expect(job.workMode).toBe('onsite')
  })

  it('stamps fresh normalization so a later read cannot infer from a misleading display label', () => {
    const ashby = normalizeAshbyJob({
      id: '7005', title: 'Backend Engineer — Synthetic Address', isListed: true,
      jobUrl: 'https://example.test/regional/ashby-7005', workplaceType: 'OnSite',
      location: 'Taipei, Taiwan',
      address: { postalAddress: { addressLocality: 'Unassigned Workshop', addressCountry: 'TW' } },
      descriptionPlain: 'Requirements: TypeScript.',
    }, 'regional-ashby', REGIONAL_TIME)!
    const smart = normalizeSmartRecruitersJob({
      id: '7006', name: 'Backend Engineer — Synthetic Address',
      company: { identifier: 'RegionalSmart70' }, visibility: 'PUBLIC', active: true,
      releasedDate: REGIONAL_TIME, postingUrl: 'https://example.test/regional/smart-7006',
      location: { city: 'Portland', region: 'ME', country: 'US',
        fullLocation: 'Portland, OR, United States', remote: false, hybrid: false },
      jobAd: { sections: { jobDescription: { text: '<p>Build backend services with TypeScript.</p>' } } },
    }, 'regional-smart', REGIONAL_TIME)!
    expect(ashby).toMatchObject({ cityIds: [], cityCoverageVersion: 1, locationLabel: 'Taipei, Taiwan' })
    expect(smart).toMatchObject({ cityIds: [], cityCoverageVersion: 1, locationLabel: 'Portland, OR, United States' })
    expect(upgradeJob(ashby)).toMatchObject({ cityIds: [], cityCoverageVersion: 1 })
    expect(upgradeJob(smart)).toMatchObject({ cityIds: [], cityCoverageVersion: 1 })
  })
})
