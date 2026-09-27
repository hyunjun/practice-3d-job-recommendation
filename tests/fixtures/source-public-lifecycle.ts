import { BOOKING_LIST_URLS } from './careers-contract'
import { bookingResponses } from './careers-wire'
import { coverageReply } from './public-coverage-transport'
import { surveyOldSaved } from './public-company-survey'
import { SOURCE_EXPANSION_REGISTRATIONS } from './source-expansion-contract'
import { SOURCE_EXPANSION_NOW, sourceExpansionOld93Cache } from './source-expansion-wire'
import { REGIONAL_SOURCE_REGISTRATIONS } from './regional-sources'

/** Only Booking is uncached; the other129 sources are explicitly frozen. */
export function sourcePublicLifecycleCache() {
  const old = sourceExpansionOld93Cache()
  return {
    ...old,
    boards: [
      ...old.boards,
      ...[...SOURCE_EXPANSION_REGISTRATIONS, ...REGIONAL_SOURCE_REGISTRATIONS].filter(company => company.id !== 'booking').map(company => ({
        companyId: company.id, provider: company.provider, board: company.board,
        checkedAt: SOURCE_EXPANSION_NOW, failures: 0, retryAt: null,
        snapshot: { fetchedAt: SOURCE_EXPANSION_NOW, jobs: [], total: 0, unmappedCount: 0, publishedIds: [] },
      })),
    ],
  }
}

export function sourcePublicLifecycleResponses() {
  const responses = bookingResponses()
  // The real collector keeps working while the saved view cancels its monitor.
  responses[BOOKING_LIST_URLS[0]] = coverageReply(responses[BOOKING_LIST_URLS[0]], { delayMs: 8_000 })
  return responses
}

export const sourcePublicLifecycleSaved = () => surveyOldSaved('2026-10-01T23:39:55.000Z')
