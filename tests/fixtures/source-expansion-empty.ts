import { BOOKING_LIST_URLS, STARBUCKS_LIST_URLS, ZALANDO_LIST_URLS } from './careers-contract'
import { flightObjectHtml } from './careers-wire'
import { coverageReply } from './public-coverage-transport'
import { withRegionalSourceEmptyBoards } from './regional-sources'
import { SOURCE_EXPANSION_ATS_FULL_URLS, SOURCE_EXPANSION_ATS_PRESENCE_URLS, SOURCE_EXPANSION_REGISTRATIONS } from './source-expansion-contract'

export const SOURCE_EXPANSION_EMPTY_FULL_URLS = [
  ...Object.values(SOURCE_EXPANSION_ATS_FULL_URLS),
  BOOKING_LIST_URLS[0], ZALANDO_LIST_URLS[0], STARBUCKS_LIST_URLS[0],
]
export const SOURCE_EXPANSION_EMPTY_PRESENCE_URLS = [
  ...Object.values(SOURCE_EXPANSION_ATS_PRESENCE_URLS),
  BOOKING_LIST_URLS[0], ZALANDO_LIST_URLS[0], STARBUCKS_LIST_URLS[0],
]

const roots = [
  ...SOURCE_EXPANSION_EMPTY_FULL_URLS.map(url => url.split('?')[0]),
  'https://jobs.booking.com', 'https://jobs.zalando.com', 'https://apply.starbucks.com',
]
export const isSourceExpansionRequest = (url: string) => roots.some(root =>
  url === root || url.startsWith(`${root}?`) || url.startsWith(`${root}/`))

/** Historical regression postings stay unchanged; the thirty-one new sources are explicitly empty. */
export function withSourceExpansionEmptyBoards(responses: Record<string, unknown> = {}): Record<string, unknown> {
  const empty: Record<string, unknown> = {}
  for (const company of SOURCE_EXPANSION_REGISTRATIONS) {
    if (company.provider === 'careers') continue
    const value = company.provider === 'greenhouse' ? { jobs: [], meta: { total: 0 } }
      : company.provider === 'ashby' ? { apiVersion: '1', jobs: [] }
        : company.provider === 'lever' ? []
          : { offset: 0, limit: 100, totalFound: 0, content: [] }
    empty[SOURCE_EXPANSION_ATS_FULL_URLS[company.id]] = value
    empty[SOURCE_EXPANSION_ATS_PRESENCE_URLS[company.id]] = value
  }
  return withRegionalSourceEmptyBoards({
    ...empty,
    [BOOKING_LIST_URLS[0]]: { totalCount: 0, count: 0, jobs: [] },
    [ZALANDO_LIST_URLS[0]]: coverageReply(flightObjectHtml({ total: 0, data: [], next: null }), { format: 'text' }),
    [STARBUCKS_LIST_URLS[0]]: { data: { count: 0, positions: [], appliedFilters: { jobCategory: ['technology'] } } },
    ...responses,
  })
}
