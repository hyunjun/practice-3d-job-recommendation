import {
  DAANGN_BODY, DAANGN_LIST_URL, DAANGN_MARKET_TITLE, DAANGN_MARKET_URL,
  DAANGN_PAY_BODY, DAANGN_PAY_TITLE, DAANGN_PAY_URL, DAANGN_ROBOTS_URL,
} from './daangn-contract'
import { coverageReply } from './public-coverage-transport'

export interface FictionalDaangnCard {
  id: string
  title: string
  corporate: string
  employment?: string
  keywords?: string
}
export const DAANGN_CARDS: FictionalDaangnCard[] = [
  { id: '830001', title: DAANGN_MARKET_TITLE, corporate: 'karrot-market' },
  { id: '830002', title: 'Account Executive — Fictional Cedar Sales83', corporate: 'karrot-market' },
  { id: '830101', title: DAANGN_PAY_TITLE, corporate: 'karrot-pay' },
]
export const DAANGN_ROBOTS = 'User-agent: *\nAllow: /jobs/\nDisallow: /preview\nDisallow: /jobs/completed\n'
const escapeHtml = (value: string) => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;')
  .replaceAll('<', '&lt;').replaceAll('>', '&gt;')

export function daangnCard(card: FictionalDaangnCard): string {
  return `<li data-job-card data-corporate="${escapeHtml(card.corporate)}" data-division="tech"
    data-department-slugs="platform,developer-experience" data-employment-type="${card.employment ?? 'full-time'}"
    data-keywords="${escapeHtml(card.keywords ?? 'Seoul remote Python Java salary 999999 visa sponsorship director')}">
    <a href="/jobs/role/${card.id}/"><h3><span>${escapeHtml(card.title)}</span><span>추천</span></h3>
    <ul><li>${card.corporate === 'karrot-pay' ? '당근페이' : '당근'}</li><li>${
      card.employment === 'contractor' ? '계약직' : card.employment === 'intern' ? '인턴' : '정규직'
    }</li></ul></a></li>`
}

export function daangnList(cards = DAANGN_CARDS, options: {
  count?: string | number
  controls?: string[]
  extra?: string
  canonical?: string
} = {}): string {
  return `<!doctype html><html><head><title>Fictional careers</title>
    <link rel="canonical" href="${options.canonical ?? DAANGN_LIST_URL}"></head><body>
    <nav><a href="${DAANGN_MARKET_URL}">Duplicate featured banner alias</a></nav>
    <form data-job-filter>${(options.controls ?? ['karrot-market', 'karrot-pay']).map(value =>
      `<label><input type="checkbox" name="corp" value="${value}">${value}</label>`).join('')}</form>
    <span data-job-count>${options.count ?? cards.length}</span>개의 공고가 열려있어요
    <ul data-job-list>${cards.map(daangnCard).join('')}</ul>
    <p hidden data-job-empty>현재 열린 공고가 없어요</p>${options.extra ?? ''}
    <footer>Fictional corporate office: Seoul, South Korea</footer></body></html>`
}

export function daangnPosting(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    '@context': 'https://schema.org', '@type': 'JobPosting',
    url: DAANGN_MARKET_URL, title: DAANGN_MARKET_TITLE, description: DAANGN_BODY,
    hiringOrganization: { '@type': 'Organization', name: '당근', url: 'https://www.daangn.com' },
    employmentType: 'FULL_TIME',
    jobLocation: { '@type': 'Place', address: { '@type': 'PostalAddress', addressCountry: 'KR' } },
    // Deliberately old: a still-listed opening must not acquire a fourteen-day expiry.
    datePosted: '2025-01-01',
    ...overrides,
  }
}

export function daangnDetail(value: unknown = daangnPosting(), options: {
  canonical?: string
  heading?: string
  rawJson?: string
  extra?: string
} = {}): string {
  return `<!doctype html><html><head><link rel="canonical" href="${options.canonical ?? DAANGN_MARKET_URL}">
    <script type="application/ld+json">${options.rawJson ?? JSON.stringify(value)}</script></head><body>
    <h1>${options.heading ?? DAANGN_MARKET_TITLE}</h1>${options.extra ?? ''}
    <footer>Fictional corporate office: Seoul, South Korea</footer></body></html>`
}

export function daangnResponses(): Record<string, unknown> {
  return {
    [DAANGN_ROBOTS_URL]: coverageReply(DAANGN_ROBOTS, { format: 'text', headers: { 'Content-Type': 'text/plain; charset=utf-8' } }),
    [DAANGN_LIST_URL]: coverageReply(daangnList(), { format: 'text' }),
    [DAANGN_MARKET_URL]: coverageReply(daangnDetail(), { format: 'text' }),
    [DAANGN_PAY_URL]: coverageReply(daangnDetail(daangnPosting({
      url: DAANGN_PAY_URL, title: DAANGN_PAY_TITLE, description: DAANGN_PAY_BODY,
      hiringOrganization: { '@type': 'Organization', name: '당근페이', url: 'https://www.daangnpay.com' },
    }), { canonical: DAANGN_PAY_URL, heading: DAANGN_PAY_TITLE }), { format: 'text' }),
    'https://careers.daangn.com/jobs/role/830002/': coverageReply(daangnDetail(daangnPosting({
      url: 'https://careers.daangn.com/jobs/role/830002/',
      title: 'Account Executive — Fictional Cedar Sales83',
      description: '<p>Sell fictional advertising subscriptions and negotiate sales contracts.</p>',
    }), { canonical: 'https://careers.daangn.com/jobs/role/830002/', heading: 'Account Executive — Fictional Cedar Sales83' }), { format: 'text' }),
  }
}

export const isDaangnRequest = (url: string) => url.startsWith('https://careers.daangn.com/')
export function withDaangnEmptyBoards(responses: Record<string, unknown>): Record<string, unknown> {
  return {
    [DAANGN_ROBOTS_URL]: coverageReply(DAANGN_ROBOTS, { format: 'text', headers: { 'Content-Type': 'text/plain; charset=utf-8' } }),
    [DAANGN_LIST_URL]: coverageReply(daangnList([]), { format: 'text', headers: { 'Content-Type': 'text/html; charset=utf-8' } }),
    ...responses,
  }
}
