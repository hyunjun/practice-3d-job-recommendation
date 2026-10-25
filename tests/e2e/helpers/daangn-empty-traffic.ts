import { expect } from '@playwright/test'
import { DAANGN_LIST_URL, DAANGN_ROBOTS_URL } from '../../fixtures/daangn-contract'
import { isDaangnRequest } from '../../fixtures/daangn-wire'
import type { CoverageRequest } from '../../fixtures/public-coverage-transport'

/** Account for the additional host without changing any historical request oracle. */
export function expectEmptyDaangnTraffic(requests: CoverageRequest[]) {
  const added = requests.filter(request => isDaangnRequest(request.url))
  expect(added.every(request => request.synthetic && request.networkSent === false
    && request.method === 'GET' && request.body === null)).toBe(true)
  expect(added.every(request => request.url === DAANGN_LIST_URL || request.url === DAANGN_ROBOTS_URL)).toBe(true)
  expect(added.filter(request => request.url === DAANGN_ROBOTS_URL).length)
    .toBe(added.filter(request => request.url === DAANGN_LIST_URL).length)
  return requests.filter(request => !isDaangnRequest(request.url))
}
