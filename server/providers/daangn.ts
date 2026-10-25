import { defaultTreeAdapter, parse, parseFragment, type DefaultTreeAdapterMap } from 'parse5'
import { z } from 'zod'
import { countryCode, countryName } from '../../shared/countries'
import { BoardFetchError } from '../catalog-service'
import { plainText } from '../normalize'
import type { PostingLocation } from '../normalize'
import type { CareerPosting, CareerRequest } from './careers-common'

export const DAANGN_ORIGIN = 'https://careers.daangn.com'
export const DAANGN_EMPLOYERS = {
  daangn: { corporate: 'karrot-market', name: '당근', website: 'https://www.daangn.com' },
  'daangn-pay': { corporate: 'karrot-pay', name: '당근페이', website: 'https://www.daangnpay.com' },
} as const
export type DaangnBoard = keyof typeof DAANGN_EMPLOYERS
export interface DaangnSummary {
  id: string
  title: string
  corporate: string
  employment: string
  departments: string[]
}

type Node = DefaultTreeAdapterMap['node']
type Element = DefaultTreeAdapterMap['element']
const isElement = (node: Node): node is Element => 'tagName' in node
const attribute = (element: Element, name: string) => element.attrs.find(attr => attr.name === name)?.value
const hasAttribute = (element: Element, name: string) => attribute(element, name) !== undefined
const cleanText = (text: string) => text.replace(/\s+/gu, ' ').trim()
const failure = (message: string): never => { throw new BoardFetchError(`당근 ${message}`) }
const EMPLOYMENT: Readonly<Record<string, string>> = { 'full-time': 'FULL_TIME', contractor: 'CONTRACTOR', intern: 'INTERN' }

function elements(root: Node, predicate: (element: Element) => boolean): Element[] {
  const result: Element[] = []
  const pending: Node[] = [root]
  let inspected = 0
  while (pending.length) {
    if (++inspected > 50_000) return failure('공개 페이지의 구조가 수집 한도를 넘었어요.')
    const node = pending.pop()!
    if (isElement(node) && predicate(node)) result.push(node)
    if ('childNodes' in node) for (let index = node.childNodes.length - 1; index >= 0; index--) pending.push(node.childNodes[index])
  }
  return result
}

function textContent(root: Node): string {
  const parts: string[] = []
  const pending: Node[] = [root]
  let inspected = 0
  while (pending.length) {
    if (++inspected > 50_000) return failure('공개 페이지의 본문이 수집 한도를 넘었어요.')
    const node = pending.pop()!
    if (node.nodeName === '#text' && 'value' in node) parts.push(node.value)
    if (isElement(node) && ['script', 'style', 'template'].includes(node.tagName)) continue
    if ('childNodes' in node) for (let index = node.childNodes.length - 1; index >= 0; index--) pending.push(node.childNodes[index])
  }
  return cleanText(parts.join(''))
}

function exactlyOne<T>(items: T[], message: string): T {
  if (items.length !== 1) return failure(message)
  return items[0]
}

function canonicalUrl(value: string, expected?: string): string {
  let url: URL
  try { url = new URL(value, DAANGN_ORIGIN) } catch { return failure('공고 URL 형식을 확인하지 못했어요.') }
  if (url.origin !== DAANGN_ORIGIN || url.username || url.password || url.search || url.hash
    || (expected ? url.pathname !== expected : !/^\/jobs\/role\/[1-9]\d{0,29}\/$/.test(url.pathname))) {
    return failure('공고 URL이 공식 목록과 일치하지 않아요.')
  }
  return url.href
}

/** Astro may place complete external module scripts after the HTML end tag. */
function validatePostlude(suffix: string): void {
  const whitespace = (value: string) => /^[\t\n\f\r ]*$/.test(value)
  if (whitespace(suffix)) return
  let malformed = false
  const fragment = parseFragment(suffix, {
    sourceCodeLocationInfo: true,
    onParseError() { malformed = true },
  })
  if (malformed) return failure('공개 페이지의 끝부분을 확인하지 못했어요.')
  // Apply the same node bound even to a suffix composed only of comments.
  elements(fragment, () => false)
  let cursor = 0
  for (const node of fragment.childNodes) {
    const location = node.sourceCodeLocation
    if (!location || location.startOffset < cursor
      || !whitespace(suffix.slice(cursor, location.startOffset))) {
      return failure('공개 페이지의 끝부분을 확인하지 못했어요.')
    }
    const raw = suffix.slice(location.startOffset, location.endOffset)
    if (node.nodeName === '#text' && 'value' in node) {
      if (!whitespace(raw)) return failure('공개 페이지의 끝부분을 확인하지 못했어요.')
    } else if (node.nodeName === '#comment') {
      if (!raw.startsWith('<!--') || !raw.endsWith('-->')) {
        return failure('공개 페이지의 끝부분을 확인하지 못했어요.')
      }
    } else if (isElement(node) && node.tagName === 'script') {
      const start = node.sourceCodeLocation?.startTag
      const end = node.sourceCodeLocation?.endTag
      if (!start || !end || start.endOffset !== end.startOffset || node.childNodes.length !== 0
        || attribute(node, 'type')?.toLowerCase() !== 'module' || !attribute(node, 'src')?.trim()) {
        return failure('공개 페이지의 끝부분을 확인하지 못했어요.')
      }
    } else {
      return failure('공개 페이지의 끝부분을 확인하지 못했어요.')
    }
    cursor = location.endOffset
  }
  // A recovering fragment parser can omit stray closing tags. Check their bytes too.
  if (!whitespace(suffix.slice(cursor))) return failure('공개 페이지의 끝부분을 확인하지 못했어요.')
}

function documentFor(html: unknown, expectedPath: string): DefaultTreeAdapterMap['document'] {
  if (typeof html !== 'string' || Buffer.byteLength(html, 'utf8') > 4 * 1024 * 1024
    || !/<!doctype\s+html\s*>/i.test(html)) {
    return failure('공개 페이지를 끝까지 확인하지 못했어요.')
  }
  let malformed = false
  let htmlEnd: number | undefined
  const document = parse(html, {
    sourceCodeLocationInfo: true,
    treeAdapter: {
      ...defaultTreeAdapter,
      updateNodeSourceCodeLocation(node, location) {
        // Recovery after a second HTML end tag must not hide rejected suffix bytes.
        if (htmlEnd === undefined && isElement(node) && node.tagName === 'html'
          && node.parentNode?.nodeName === '#document' && location.endTag) {
          htmlEnd = location.endTag.endOffset
        }
        defaultTreeAdapter.updateNodeSourceCodeLocation(node, location)
      },
    },
    onParseError(error) {
      if (error.code === 'duplicate-attribute' || error.code.startsWith('eof-')) malformed = true
    },
  })
  if (malformed) return failure('공개 페이지의 구조가 올바르지 않아요.')
  const root = exactlyOne(document.childNodes.filter((node): node is Element => isElement(node) && node.tagName === 'html'),
    '공개 페이지의 문서 구조를 확인하지 못했어요.')
  if (!root.sourceCodeLocation?.endTag || htmlEnd === undefined) return failure('공개 페이지를 끝까지 확인하지 못했어요.')
  validatePostlude(html.slice(htmlEnd))
  const canonical = exactlyOne(elements(document, element => element.tagName === 'link'
    && attribute(element, 'rel')?.toLowerCase().split(/\s+/).includes('canonical') === true),
  '공개 페이지의 정규 주소를 확인하지 못했어요.')
  canonicalUrl(attribute(canonical, 'href') ?? '', expectedPath)
  return document
}

/** Read the complete unfiltered source before selecting a legal employer. */
export async function readDaangnInventory(request: CareerRequest, signal: AbortSignal): Promise<DaangnSummary[]> {
  const document = documentFor(await request(`${DAANGN_ORIGIN}/jobs/`, signal), '/jobs/')
  const list = exactlyOne(elements(document, element => hasAttribute(element, 'data-job-list')),
    '전체 공고 목록을 확인하지 못했어요.')
  const count = exactlyOne(elements(document, element => hasAttribute(element, 'data-job-count')),
    '전체 공고 수를 확인하지 못했어요.')
  const filters = exactlyOne(elements(document, element => hasAttribute(element, 'data-job-filter')),
    '회사별 공고 범위를 확인하지 못했어요.')
  const countText = textContent(count)
  if (!/^(?:0|[1-9]\d{0,5})$/.test(countText) || Number(countText) > 300) {
    return failure('전체 공고 수가 수집 범위를 벗어났어요.')
  }
  // A source change to pagination must not turn an unvisited page into closures.
  if (elements(document, element => attribute(element, 'rel')?.toLowerCase().split(/\s+/).includes('next') === true
    || ['data-pagination', 'data-next-page', 'data-load-more', 'data-has-more'].some(name => hasAttribute(element, name))).length) {
    return failure('전체 공고 목록의 마지막 페이지를 확인하지 못했어요.')
  }
  const controls = elements(filters, element => element.tagName === 'input' && attribute(element, 'name') === 'corp')
  const corporations = controls.map(element => attribute(element, 'value') ?? '')
  if (corporations.some(value => !value || value.length > 100) || new Set(corporations).size !== corporations.length
    || controls.some(element => hasAttribute(element, 'checked'))
    || Object.values(DAANGN_EMPLOYERS).some(employer => !corporations.includes(employer.corporate))) {
    return failure('필터가 없는 회사별 전체 목록을 확인하지 못했어요.')
  }
  const cards = elements(list, element => hasAttribute(element, 'data-job-card'))
  if (cards.length !== Number(countText)
    || elements(document, element => hasAttribute(element, 'data-job-card')).length !== cards.length) {
    return failure('공개 공고 수와 전체 목록이 일치하지 않아요.')
  }
  const ids = new Set<string>()
  return cards.map(card => {
    if (card.tagName !== 'li' || hasAttribute(card, 'hidden')
      || elements(card, element => element !== card && hasAttribute(element, 'data-job-card')).length) {
      return failure('공개 공고 카드의 구조를 확인하지 못했어요.')
    }
    const link = exactlyOne(elements(card, element => element.tagName === 'a'),
      '공고 카드의 원문 주소를 확인하지 못했어요.')
    const url = canonicalUrl(attribute(link, 'href') ?? '')
    const id = new URL(url).pathname.split('/')[3]
    if (ids.has(id)) return failure('공개 목록에 중복 공고가 있어요.')
    ids.add(id)
    const heading = exactlyOne(elements(link, element => element.tagName === 'h3'),
      '공고 제목을 확인하지 못했어요.')
    // The first span is the actual title; a following span can be a 추천 badge.
    const titleNode = heading.childNodes.find(isElement)
    if (!titleNode || titleNode.tagName !== 'span') return failure('공고 제목의 구조를 확인하지 못했어요.')
    const title = textContent(titleNode)
    const corporate = attribute(card, 'data-corporate') ?? ''
    const employment = attribute(card, 'data-employment-type') ?? ''
    const division = attribute(card, 'data-division') ?? ''
    const departmentSlugs = attribute(card, 'data-department-slugs')
    if (!title || title.length > 1000 || !corporations.includes(corporate)
      || !['full-time', 'contractor', 'intern'].includes(employment)
      || !division || division.length > 100 || departmentSlugs === undefined || departmentSlugs.length > 2000) {
      return failure('공고의 회사·직군·고용 형태를 확인하지 못했어요.')
    }
    const departments = [division, ...departmentSlugs.split(',').filter(Boolean)]
      .map(value => value.replace(/-/g, ' '))
    return { id, title, corporate, employment, departments }
  })
}

const Nonempty = z.string().trim().min(1)
const Address = z.object({
  '@type': z.literal('PostalAddress').optional(),
  addressLocality: Nonempty.max(300).optional(),
  addressRegion: Nonempty.max(300).optional(),
  addressCountry: z.union([Nonempty.max(100), z.object({ '@type': z.literal('Country').optional(), name: Nonempty.max(100) })]).optional(),
})
const Location = z.object({ '@type': z.literal('Place').optional(), address: Address })
const Posting = z.object({
  url: Nonempty.max(2000),
  title: Nonempty.max(1000),
  description: Nonempty.max(200_000),
  hiringOrganization: z.object({ name: Nonempty.max(200), url: Nonempty.max(2000) }),
  employmentType: z.union([Nonempty.max(100), z.array(Nonempty.max(100)).min(1).max(10)]),
  jobLocation: z.union([Location, z.array(Location).min(1).max(100)]),
  datePosted: Nonempty.max(100).optional(),
})

function postingNodes(document: Node): unknown[] {
  const postings: unknown[] = []
  for (const script of elements(document, element => element.tagName === 'script'
    && attribute(element, 'type')?.toLowerCase() === 'application/ld+json')) {
    const raw = script.childNodes.filter(node => node.nodeName === '#text' && 'value' in node)
      .map(node => 'value' in node ? node.value : '').join('')
    let parsed: unknown
    try { parsed = JSON.parse(raw) } catch { return failure('구조화된 공고 본문을 읽지 못했어요.') }
    const pending: unknown[] = [parsed]
    let inspected = 0
    while (pending.length) {
      if (++inspected > 10_000) return failure('구조화된 공고의 수집 한도를 넘었어요.')
      const value = pending.pop()
      if (Array.isArray(value)) {
        if (value.length > 10_000) return failure('구조화된 공고의 수집 한도를 넘었어요.')
        for (const item of value) pending.push(item)
        continue
      }
      if (!value || typeof value !== 'object') continue
      const object = value as Record<string, unknown>
      const types = Array.isArray(object['@type']) ? object['@type'] : [object['@type']]
      if (types.some(type => type === 'JobPosting' || type === 'https://schema.org/JobPosting')) postings.push(value)
      if (object['@graph'] !== undefined) pending.push(object['@graph'])
    }
  }
  return postings
}

export async function readDaangnPosting(summary: DaangnSummary, request: CareerRequest, signal: AbortSignal): Promise<CareerPosting> {
  const employer = Object.values(DAANGN_EMPLOYERS).find(item => item.corporate === summary.corporate)
  if (!employer || !/^[1-9]\d{0,29}$/.test(summary.id)) return failure('공고의 회사를 확인하지 못했어요.')
  const pathname = `/jobs/role/${summary.id}/`
  const url = `${DAANGN_ORIGIN}${pathname}`
  const document = documentFor(await request(url, signal), pathname)
  const candidate = exactlyOne(postingNodes(document), '개별 공고의 본문을 하나로 확인하지 못했어요.')
  const parsed = Posting.safeParse(candidate)
  if (!parsed.success) return failure('개별 공고 본문의 형식을 확인하지 못했어요.')
  const raw = parsed.data
  const heading = exactlyOne(elements(document, element => element.tagName === 'h1'), '개별 공고 제목을 확인하지 못했어요.')
  if (canonicalUrl(raw.url) !== url || cleanText(raw.title) !== summary.title || textContent(heading) !== summary.title
    || raw.hiringOrganization.name !== employer.name || !plainText(raw.description).trim()) {
    return failure('공고의 회사·ID·제목·본문이 목록과 일치하지 않아요.')
  }
  let organization: URL
  try { organization = new URL(raw.hiringOrganization.url) } catch { return failure('고용주의 공식 주소를 확인하지 못했어요.') }
  if (organization.origin !== employer.website || organization.pathname !== '/' || organization.search
    || organization.hash || organization.username || organization.password) return failure('고용주의 공식 주소가 일치하지 않아요.')
  const employment = Array.isArray(raw.employmentType) ? raw.employmentType : [raw.employmentType]
  const expectedEmployment = EMPLOYMENT[summary.employment]
  if (employment.length !== 1 || employment[0] !== expectedEmployment) return failure('공고의 고용 형태가 목록과 일치하지 않아요.')
  if (raw.datePosted && (!/^\d{4}-\d\d-\d\d(?:T.*)?$/.test(raw.datePosted)
    || !Number.isFinite(Date.parse(raw.datePosted))
    || new Date(`${raw.datePosted.slice(0, 10)}T00:00:00Z`).toISOString().slice(0, 10) !== raw.datePosted.slice(0, 10))) {
    return failure('공고의 게시 날짜를 확인하지 못했어요.')
  }
  const places = Array.isArray(raw.jobLocation) ? raw.jobLocation : [raw.jobLocation]
  const locations: PostingLocation[] = places.map(place => {
    const address = place.address
    const sourceCountry = typeof address.addressCountry === 'string' ? address.addressCountry : address.addressCountry?.name
    const code = sourceCountry ? countryCode(sourceCountry) : undefined
    const country = code ?? sourceCountry
    const label = [address.addressLocality, address.addressRegion, code ? countryName(code) : sourceCountry]
      .filter(Boolean).join(', ')
    if (!label) return failure('공고 근무지의 원문을 확인하지 못했어요.')
    return { label, address: { addressLocality: address.addressLocality, addressRegion: address.addressRegion, addressCountry: country } }
  })
  return {
    id: summary.id, title: raw.title, url, description: raw.description,
    locations, departments: summary.departments, employment: employment[0],
    // datePosted is not dateModified. Do not invent an update timestamp.
    updatedAt: null,
  }
}
