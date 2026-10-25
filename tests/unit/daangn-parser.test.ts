import { describe, expect, it, vi } from 'vitest'
import { BoardFetchError } from '../../server/catalog-service'
import { readDaangnInventory, readDaangnPosting } from '../../server/providers/daangn'
import type { DaangnSummary } from '../../server/providers/daangn'
import { normalizeCareerPosting } from '../../server/providers/careers-common'
import type { Employment } from '../../shared/types'
import {
  DAANGN_BODY, DAANGN_LIST_URL, DAANGN_MARKET_TITLE, DAANGN_MARKET_URL, DAANGN_NOW,
} from '../fixtures/daangn-contract'
import { DAANGN_CARDS, daangnCard, daangnDetail, daangnList, daangnPosting } from '../fixtures/daangn-wire'

const signal = () => new AbortController().signal
const summary: DaangnSummary = {
  id: '830001', title: DAANGN_MARKET_TITLE, corporate: 'karrot-market',
  employment: 'full-time', departments: ['tech', 'platform', 'developer experience'],
}
const inventory = (html: unknown) => readDaangnInventory(async () => html, signal())
const posting = (html: unknown) => readDaangnPosting(summary, async () => html, signal())

describe('complete Daangn inventory before employer selection', () => {
  it('reads only canonical cards, ignores duplicate banner aliases and hidden empty copy, and separates employers', async () => {
    const request = vi.fn(async () => daangnList())
    expect(await readDaangnInventory(request, signal())).toEqual([
      summary,
      { ...summary, id: '830002', title: 'Account Executive — Fictional Cedar Sales83' },
      { ...summary, id: '830101', title: 'Frontend Engineer — Fictional Birch Pay83', corporate: 'karrot-pay' },
    ])
    expect(request.mock.calls).toHaveLength(1)
    expect(request).toHaveBeenCalledWith(DAANGN_LIST_URL, expect.any(AbortSignal))
  })

  it('accepts an explicit zero only with the complete unfiltered structures and both employers', async () => {
    expect(await inventory(daangnList([]))).toEqual([])
  })

  it.each([
    ['missing list', daangnList([]).replace('data-job-list', 'data-missing-list')],
    ['missing count', daangnList([]).replace('data-job-count', 'data-missing-count')],
    ['missing controls', daangnList([]).replace('data-job-filter', 'data-missing-filter')],
    ['missing employer', daangnList([], { controls: ['karrot-market'] })],
    ['duplicate employer', daangnList([], { controls: ['karrot-market', 'karrot-pay', 'karrot-pay'] })],
    ['selected employer', daangnList([]).replace('type="checkbox"', 'type="checkbox" checked')],
    ['blank count', daangnList([], { count: '' })],
    ['zero while cards present', daangnList(DAANGN_CARDS, { count: 0 })],
    ['positive count without cards', daangnList([], { count: 1 })],
    ['duplicate count', daangnList([], { extra: '<span data-job-count>0</span>' })],
    ['duplicate list', daangnList([], { extra: '<ul data-job-list></ul>' })],
    ['pagination link', daangnList([], { extra: '<a rel="next" href="/jobs/?page=2">Next</a>' })],
    ['load more', daangnList([], { extra: '<button data-load-more>More</button>' })],
    ['has more', daangnList([], { extra: '<div data-has-more="true"></div>' })],
    ['unknown employer on the other company card', daangnList([
      DAANGN_CARDS[0], { ...DAANGN_CARDS[2], corporate: 'unknown-employer' },
    ])],
    ['duplicate ID across employers', daangnList([
      DAANGN_CARDS[0], { ...DAANGN_CARDS[2], id: '830001' },
    ])],
    ['hidden card', daangnList().replace('data-job-card', 'data-job-card hidden')],
    ['card outside the list', daangnList([], { extra: daangnCard(DAANGN_CARDS[0]) })],
    ['missing title', daangnList().replace(DAANGN_MARKET_TITLE, '')],
    ['missing division', daangnList().replace('data-division="tech"', '')],
    ['unknown employment', daangnList().replace('data-employment-type="full-time"', 'data-employment-type="mystery"')],
    ['external role URL', daangnList().replace('href="/jobs/role/830001/"', 'href="https://example.invalid/jobs/role/830001/"')],
    ['preview role URL', daangnList().replace('href="/jobs/role/830001/"', 'href="/preview/830001/"')],
    ['completed role URL', daangnList().replace('href="/jobs/role/830001/"', 'href="/jobs/completed/"')],
    ['query in role URL', daangnList().replace('href="/jobs/role/830001/"', 'href="/jobs/role/830001/?apply=1"')],
    ['filtered canonical', daangnList([], { canonical: `${DAANGN_LIST_URL}?corp=karrot-market` })],
    ['truncated document', daangnList().slice(0, -7)],
    ['non HTML reply', { jobs: [] }],
  ])('rejects %s instead of returning an empty or partial success', async (_name, html) => {
    await expect(inventory(html)).rejects.toBeInstanceOf(BoardFetchError)
  })

  it('enforces the 300-card boundary without silently truncating', async () => {
    const cards = Array.from({ length: 300 }, (_, i) => ({ ...DAANGN_CARDS[0], id: String(840000 + i) }))
    expect(await inventory(daangnList(cards))).toHaveLength(300)
    await expect(inventory(daangnList([...cards, { ...cards[0], id: '850001' }]))).rejects.toBeInstanceOf(BoardFetchError)
  })
})

describe('Daangn detail integrity and public facts', () => {
  it.each([
    { listed: 'full-time', detail: 'FULL_TIME', expected: 'fulltime' },
    { listed: 'contractor', detail: 'CONTRACTOR', expected: 'contract' },
    { listed: 'intern', detail: 'INTERN', expected: 'intern' },
  ] satisfies { listed: string; detail: string; expected: Employment }[])(
    'preserves matching $listed list/detail employment as Job.employment=$expected',
    async ({ listed, detail, expected }) => {
      const items = await inventory(daangnList([{ ...DAANGN_CARDS[0], employment: listed }]))
      expect(items).toEqual([{ ...summary, employment: listed }])
      const raw = await readDaangnPosting(items[0], async () =>
        daangnDetail(daangnPosting({ employmentType: detail })), signal())
      expect(raw.employment).toBe(detail)
      const job = normalizeCareerPosting(raw, 'daangn', DAANGN_NOW)
      expect(job).toMatchObject({
        id: 'careers-daangn-830001', companyId: 'daangn',
        url: DAANGN_MARKET_URL, employment: expected,
      })
    },
  )

  it.each([
    ['object', daangnPosting()],
    ['array with unrelated organization', [{ '@type': 'Organization', name: 'Fictional site publisher' }, daangnPosting()]],
    ['nested graph and array', { '@graph': [{ '@type': 'BreadcrumbList' }, { '@graph': [daangnPosting()] }] }],
    ['array type', daangnPosting({ '@type': ['Thing', 'JobPosting'] })],
  ])('reads one matching JobPosting from %s', async (_name, value) => {
    const request = vi.fn(async () => daangnDetail(value))
    const raw = await readDaangnPosting(summary, request, signal())
    expect(raw.description).toBe(DAANGN_BODY)
    expect(request).toHaveBeenCalledWith(DAANGN_MARKET_URL, expect.any(AbortSignal))
    expect(raw).toMatchObject({
      id: '830001', title: DAANGN_MARKET_TITLE, url: DAANGN_MARKET_URL,
      employment: 'FULL_TIME', updatedAt: null,
      locations: [{ address: { addressCountry: 'KR' } }],
    })
    const job = normalizeCareerPosting(raw, 'daangn', DAANGN_NOW)
    expect(job).toMatchObject({
      id: 'careers-daangn-830001', companyId: 'daangn', source: 'careers', role: 'backend',
      cityIds: [], workMode: 'unknown', employment: 'fulltime', minExperience: 3,
      skills: ['TypeScript', 'PostgreSQL'], salary: null, visa: 'unknown', updatedAt: null,
      fetchedAt: DAANGN_NOW, remoteCountries: [], remoteWorldwide: false,
    })
    expect(job!.description).toContain('café 한글 🌏')
    expect(job!.locationLabel).not.toContain('Seoul')
    expect(job!.skills).not.toEqual(expect.arrayContaining(['Python', 'Java']))
  })

  it('does not turn list search keywords or a corporate footer into job facts', async () => {
    const items = await inventory(daangnList())
    const raw = await readDaangnPosting(items[0], async () => daangnDetail(), signal())
    expect(raw.description).toBe(DAANGN_BODY)
    const job = normalizeCareerPosting(raw, 'daangn', DAANGN_NOW)!
    expect(job.cityIds).toEqual([])
    expect(job.workMode).toBe('unknown')
    expect(job.salary).toBeNull()
    expect(job.visa).toBe('unknown')
    expect(job.skills).toEqual(['TypeScript', 'PostgreSQL'])
    expect(job.updatedAt).toBeNull()
  })

  it.each([
    ['missing JobPosting', { '@type': 'Organization' }],
    ['duplicate matching JobPosting', [daangnPosting(), daangnPosting()]],
    ['two distinct JobPostings', [daangnPosting(), daangnPosting({ url: 'https://careers.daangn.com/jobs/role/830999/' })]],
    ['different role ID', daangnPosting({ url: 'https://careers.daangn.com/jobs/role/830999/' })],
    ['application URL', daangnPosting({ url: 'https://example.invalid/apply/830001' })],
    ['title mismatch', daangnPosting({ title: 'Unrelated fictional opening' })],
    ['other legal employer', daangnPosting({ hiringOrganization: { name: '당근페이', url: 'https://www.daangnpay.com' } })],
    ['untrusted employer website', daangnPosting({ hiringOrganization: { name: '당근', url: 'https://www.daangn.com.example.invalid' } })],
    ['blank body', daangnPosting({ description: '<p> </p>' })],
    ['non-text body', daangnPosting({ description: { text: 'Malformed' } })],
    ['missing location', daangnPosting({ jobLocation: undefined })],
    ['empty location', daangnPosting({ jobLocation: { address: {} } })],
    ['employment mismatch', daangnPosting({ employmentType: 'CONTRACTOR' })],
    ['ambiguous employment', daangnPosting({ employmentType: ['FULL_TIME', 'CONTRACTOR'] })],
    ['invalid date', daangnPosting({ datePosted: '2026-02-30' })],
  ])('rejects %s without fabricating a valid posting', async (_name, value) => {
    await expect(posting(daangnDetail(value))).rejects.toBeInstanceOf(BoardFetchError)
  })

  it.each([
    ['invalid JSON', daangnDetail(undefined, { rawJson: '{' })],
    ['different visible heading', daangnDetail(undefined, { heading: 'Fictional mismatched title' })],
    ['wrong canonical', daangnDetail(undefined, { canonical: 'https://careers.daangn.com/jobs/role/830999/' })],
    ['multiple canonical links', daangnDetail(undefined, { extra: `<link rel="canonical" href="${DAANGN_MARKET_URL}">` })],
  ])('rejects %s', async (_name, html) => {
    await expect(posting(html)).rejects.toBeInstanceOf(BoardFetchError)
  })
})
