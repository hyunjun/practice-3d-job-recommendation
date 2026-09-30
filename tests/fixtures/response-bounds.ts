import type { GreenhouseJob } from '../../server/normalize'
import type { AshbyJob } from '../../server/providers/ashby'
import type { LeverJob } from '../../server/providers/lever'
import { DEFAULT_FILTERS, SAMPLE_PROFILE } from '../../shared/types'
import type { Company, Filters, Profile } from '../../shared/types'
import { bulkAshby, bulkAshbySales, bulkGreenhouse, bulkGreenhouseSales } from './bulk-inventory'
import { DEFAULT_CHUNK_BYTES, streamDirective } from './response-bounds-stream'
import type { StreamDirective } from './response-bounds-stream'

/** Literal caps from the approved stage 72 contract; tests compare the product constants to these. */
export const JSON_CAP_BYTES = 67_108_864
export const HTML_CAP_BYTES = 8_388_608
/**
 * Bodies well past a cap. The reader observes the excess while the source still
 * holds unread chunks, so cancellation and an early stop are observable. A
 * finite body that ends on its excess byte has already closed its source when
 * the reader looks, and nothing remains to cancel. Exact-cap and cap-plus-one
 * boundaries are pinned separately at the reader level.
 */
export const JSON_OVER_CAP_BYTES = JSON_CAP_BYTES + 8 * DEFAULT_CHUNK_BYTES
export const HTML_OVER_CAP_BYTES = HTML_CAP_BYTES + 8 * DEFAULT_CHUNK_BYTES

/** Literal user-facing messages from the approved contract. */
export const JSON_SIZE_MESSAGE = '게시판 응답이 수집 크기 제한을 넘었어요.'
export const JSON_INTERRUPTED_MESSAGE = '게시판 응답을 끝까지 읽지 못했어요.'
export const JSON_TIMEOUT_MESSAGE = '게시판 조회 시간이 초과되었어요.'
export const JSON_CANCELLED_MESSAGE = '게시판 조회가 취소되었어요.'
export const JSON_FORMAT_MESSAGE = '게시판 응답 형식을 확인하지 못했어요.'
export const HTML_SIZE_MESSAGE = '공식 채용 페이지가 수집 크기 제한을 넘었어요.'
export const HTML_NO_BODY_MESSAGE = '공식 채용 페이지의 본문이 없어요.'
export const HTML_REDIRECT_MESSAGE = '공식 채용 페이지가 다른 사이트로 이동했어요.'
export const UNKNOWN_SAVED_MESSAGE = '회사 게시판 조회에 실패했어요. 이전 목록으로 게시 종료를 판단하지 않습니다.'

export type BoundsProvider = 'greenhouse' | 'ashby'
export type BoundsPhase = 'healthy' | 'oversize' | 'recovered' | 'recovered-exact'
export const BOUNDS_TIME = '2026-09-30T09:00:00.000Z'
export const BOUNDS_CHANGE_TIME = '2026-09-30T09:02:00.000Z'
export const BOUNDS_RECOVERY_TIME = '2026-09-30T09:04:00.000Z'
export const BOUNDS_NOTE = 'PRIVATE_BOUNDS_72_NOTE 지원 기록을 보존합니다 🌱'
export const BOUNDS_TRACKED_TITLE = 'Tracked Backend Engineer 72'
export const BOUNDS_RETAINED_TITLE = 'Retained Backend Engineer 72'
export const BOUNDS_NEW_TITLE = 'New Backend Engineer 72'

export const BOUNDS_COMPANIES: Record<BoundsProvider | 'control', Company> = {
  greenhouse: {
    id: 'bounds-cedar', name: 'Cedar Bounds', initials: 'CB', color: '#b6d9a2',
    industry: 'Synthetic response bounds', careerUrl: 'https://example.com/bounds/cedar',
    provider: 'greenhouse', board: 'CedarBounds72',
  },
  ashby: {
    id: 'bounds-maple', name: 'Maple Bounds', initials: 'MB', color: '#b6d9a2',
    industry: 'Synthetic response bounds', careerUrl: 'https://example.com/bounds/maple',
    provider: 'ashby', board: 'MapleBounds72',
  },
  control: {
    id: 'bounds-birch', name: 'Birch Bounds', initials: 'BB', color: '#e8b283',
    industry: 'Synthetic response bounds', careerUrl: 'https://example.com/bounds/birch',
    provider: 'lever', board: 'BirchBounds72', boardRegion: 'eu',
  },
}
export function boundsRegistrations(provider: BoundsProvider, withControl = true) {
  return [BOUNDS_COMPANIES[provider], ...(withControl ? [BOUNDS_COMPANIES.control] : [])]
    .map(({ initials: _initials, color: _color, ...registration }) => registration)
}
export const BOUNDS_PROFILE: Profile = {
  ...SAMPLE_PROFILE, kind: 'personal', name: 'PRIVATE_BOUNDS_72', years: 5,
  desiredRole: 'backend', skills: ['TypeScript', 'Python'], residence: 'GB',
  linkedinUrl: 'https://example.com/private-bounds72',
}
export const BOUNDS_FILTERS: Filters = {
  ...DEFAULT_FILTERS, query: 'Engineer', role: 'backend', region: 'europe',
  workMode: 'onsite', employment: 'fulltime', salaryMin: 100000, includeUnknownSalary: false,
}
export const BOUNDS_EXPLORATION = {
  source: 'public' as const, filters: BOUNDS_FILTERS, selectedId: 'london',
  panelTab: 'cities' as const, mapMode: 'flat' as const, citySort: 'salary' as const, light: false,
}
export const BOUNDS_URLS = {
  greenhouse: 'https://boards-api.greenhouse.io/v1/boards/CedarBounds72/jobs?content=true&pay_transparency=true',
  ashby: 'https://api.ashbyhq.com/posting-api/job-board/MapleBounds72?includeCompensation=true',
  control: 'https://api.eu.lever.co/v0/postings/BirchBounds72?mode=json&limit=50&skip=0',
}
/** Literal expected identities; never derived from a normalizer at test time. */
export const BOUNDS_IDS = {
  greenhouse: {
    technical: ['greenhouse-bounds-cedar-7201', 'greenhouse-bounds-cedar-7202'],
    published: ['greenhouse-bounds-cedar-7201', 'greenhouse-bounds-cedar-7202', 'greenhouse-bounds-cedar-7203'],
    newId: 'greenhouse-bounds-cedar-7204',
    trackedUrl: 'https://example.com/bounds/greenhouse/7201',
  },
  ashby: {
    technical: ['ashby-bounds-maple-tracked', 'ashby-bounds-maple-retained'],
    published: ['ashby-bounds-maple-tracked', 'ashby-bounds-maple-retained', 'ashby-bounds-maple-sales'],
    newId: 'ashby-bounds-maple-new-public',
    trackedUrl: 'https://example.com/bounds/ashby/tracked',
  },
  control: { one: 'lever-bounds-birch-control-one', two: 'lever-bounds-birch-control-two' },
}

/** Fictional raw rows sharing the bulk-inventory shapes, with this stage's own IDs and links. */
export function boundsGreenhouse(id: number, title: string): GreenhouseJob {
  return bulkGreenhouse(id, { title, absolute_url: `https://example.com/bounds/greenhouse/${id}` })
}
export function boundsGreenhouseSales(id: number): GreenhouseJob {
  return { ...bulkGreenhouseSales(id), absolute_url: `https://example.com/bounds/greenhouse/${id}` }
}
export function boundsAshby(id: string, title: string, overrides: Partial<AshbyJob> = {}): AshbyJob {
  return bulkAshby(id, { title, jobUrl: `https://example.com/bounds/ashby/${id}`, ...overrides })
}
export function boundsAshbySales(id: string): AshbyJob {
  return { ...bulkAshbySales(id), jobUrl: `https://example.com/bounds/ashby/${id}` }
}
export function controlPosting(id: string, title: string): LeverJob {
  return {
    id, text: title, hostedUrl: `https://example.com/bounds/control/${id}`,
    categories: { location: 'Berlin, Germany', department: 'Engineering', commitment: 'Full-time' },
    country: 'DE', workplaceType: 'on-site',
    descriptionPlain: 'Build backend services with TypeScript and Python.\n\nRequirements\n3 years of software engineering experience.\nTypeScript and Python.',
    salaryRange: { currency: 'USD', interval: 'per-year-salary', min: 120000, max: 160000 },
  }
}

export function boundsGreenhouseFeed(phase: BoundsPhase) {
  const jobs = [
    boundsGreenhouse(7201, BOUNDS_TRACKED_TITLE), boundsGreenhouse(7202, BOUNDS_RETAINED_TITLE), boundsGreenhouseSales(7203),
    ...(phase === 'healthy' ? [] : [boundsGreenhouse(7204, BOUNDS_NEW_TITLE)]),
  ]
  return { jobs, meta: { total: jobs.length } }
}
export function boundsAshbyFeed(phase: BoundsPhase) {
  return { apiVersion: '1', jobs: [
    boundsAshby('tracked', BOUNDS_TRACKED_TITLE), boundsAshby('retained', BOUNDS_RETAINED_TITLE), boundsAshbySales('sales'),
    ...(phase === 'healthy' ? [] : [boundsAshby('new-public', BOUNDS_NEW_TITLE)]),
  ] }
}
export function controlJobs(phase: BoundsPhase): LeverJob[] {
  return [
    controlPosting('control-one', 'Berlin Backend Engineer One 72'),
    ...(phase === 'healthy' ? [] : [controlPosting('control-two', 'Berlin Backend Engineer Two 72')]),
  ]
}

/**
 * A JSON object serialized to exactly totalBytes by adding an ignored string
 * field "pad". Provider parsers accept unknown keys, so a reader without a
 * byte cap would parse and accept these bodies.
 */
export function paddedJsonObject(value: object, totalBytes: number, options: { chunkBytes?: number } = {}): StreamDirective {
  const body = JSON.stringify(value)
  if (!body.endsWith('}')) throw new Error('paddedJsonObject needs a JSON object')
  return streamDirective(`${body.slice(0, -1)}${body === '{}' ? '' : ','}"pad":"`, '"}', totalBytes, options)
}
/** A JSON array of objects serialized to exactly totalBytes; the last object carries the ignored "pad" key. */
export function paddedJsonArray(items: object[], totalBytes: number, options: { chunkBytes?: number } = {}): StreamDirective {
  if (!items.length) throw new Error('paddedJsonArray needs at least one object')
  const body = JSON.stringify(items)
  if (!body.endsWith('}]')) throw new Error('paddedJsonArray needs an array of objects')
  return streamDirective(`${body.slice(0, -2)},"pad":"`, '"}]', totalBytes, options)
}
/** An HTML page serialized to exactly totalBytes by inserting a comment before </body>. */
export function paddedHtml(html: string, totalBytes: number, options: { chunkBytes?: number } = {}): StreamDirective {
  const at = html.lastIndexOf('</body>')
  const cut = at === -1 ? html.length : at
  return streamDirective(`${html.slice(0, cut)}<!--`, `-->${html.slice(cut)}`, totalBytes, {
    ...options, contentType: 'text/html; charset=utf-8',
  })
}

export function boundsResponses(provider: BoundsProvider, phase: BoundsPhase): Record<string, unknown> {
  const feed = provider === 'greenhouse' ? boundsGreenhouseFeed(phase) : boundsAshbyFeed(phase)
  const target = phase === 'oversize' ? paddedJsonObject(feed, JSON_OVER_CAP_BYTES)
    : phase === 'recovered-exact' ? paddedJsonObject(feed, JSON_CAP_BYTES) : feed
  return { [BOUNDS_URLS[provider]]: target, [BOUNDS_URLS.control]: controlJobs(phase) }
}
