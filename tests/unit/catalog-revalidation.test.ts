import { describe, expect, it } from 'vitest'
import { ageCatalog, catalogNeedsRevalidation, PUBLIC_CATALOG_RECHECK_COOLDOWN } from '../../shared/catalog-freshness'
import type { BoardStatus, Catalog } from '../../shared/types'
import { REVALIDATION_TIME, revalidationCatalog, revalidationJob } from '../fixtures/catalog-revalidation'

const start = Date.parse(REVALIDATION_TIME)
const at = (offset: number) => new Date(start + offset).toISOString()

function oneBoard(overrides: Partial<BoardStatus> = {}, catalogOverrides: Partial<Catalog> = {}): Catalog {
  const catalog = revalidationCatalog()
  return { ...catalog, boards: [{ ...catalog.boards[0], ...overrides }], ...catalogOverrides }
}

function eligible(catalog: Catalog, now: number, expected: boolean) {
  const before = structuredClone(catalog)
  expect(catalogNeedsRevalidation(catalog, now)).toBe(expected)
  expect(catalog).toEqual(before)
}

describe('public catalog eligibility on an explicit foreground hint', () => {
  it('publishes a literal one-minute minimum between client attempts', () => {
    expect(PUBLIC_CATALOG_RECHECK_COOLDOWN).toBe(60000)
  })

  it.each([
    { label: 'fresh at29m59.999s', elapsed: 1_799_999, expected: false },
    { label: 'stale at exactly30m', elapsed: 1_800_000, expected: true },
    { label: 'retained at exactly24h', elapsed: 86_400_000, expected: true },
    { label: 'expired one millisecond after24h', elapsed: 86_400_001, expected: true },
    { label: 'a future successful timestamp is not immediately due', elapsed: -1, expected: false },
  ])('$label', ({ elapsed, expected }) => {
    eligible(oneBoard(), start + elapsed, expected)
  })

  it('uses the old board snapshot even when another board made the aggregate timestamp fresh', () => {
    const catalog = revalidationCatalog([
      revalidationJob('Old48'),
      revalidationJob('New48', { companyId: 'search-fixture-b', fetchedAt: at(1_800_000) }),
    ], at(1_800_000))
    catalog.boards[0].lastSuccessAt = REVALIDATION_TIME
    eligible(catalog, start + 1_800_000, true)
  })

  it('does not recheck newly successful boards because the aggregate timestamp is older', () => {
    const catalog = oneBoard({ lastSuccessAt: at(1_800_000) })
    eligible(catalog, start + 1_800_001, false)
  })

  it.each([
    { label: 'explicit unknown successful snapshot', board: { lastSuccessAt: null }, expected: true },
    { label: 'unavailable data despite a recent success', board: { dataStatus: 'unavailable' as const }, expected: true },
    { label: 'retained stale data despite a recent date', board: { dataStatus: 'stale' as const }, expected: true },
    { label: 'pending company after a lost progress monitor', board: { status: 'pending' as const, dataStatus: 'unavailable' as const, lastSuccessAt: null }, expected: true },
  ])('$label', ({ board, expected }) => {
    eligible(oneBoard(board), start + 1, expected)
  })

  it('leaves sample mode ineligible even when its dates and board history would otherwise be due', () => {
    eligible({ ...oneBoard({ status: 'error', dataStatus: 'unavailable', lastSuccessAt: null }), source: 'sample' }, start + 86_400_001, false)
  })

  it('treats the blank public placeholder as recoverable', () => {
    eligible({ ...revalidationCatalog([]), fetchedAt: '', jobs: [], boards: [] }, start, true)
  })

  it('does not mistake a successful fresh zero-job result for an unloaded placeholder', () => {
    eligible(revalidationCatalog([]), start + 1_799_999, false)
  })

  it('can recheck a successful zero-job result once its board snapshot is stale', () => {
    eligible(revalidationCatalog([]), start + 1_800_000, true)
  })

  it.each([
    { label: 'fresh boardless legacy result', time: REVALIDATION_TIME, stale: false, now: start, expected: false },
    { label: 'old boardless legacy result', time: REVALIDATION_TIME, stale: false, now: start + 1_800_000, expected: true },
    { label: 'unknown boardless legacy date', time: 'not-a-date', stale: false, now: start, expected: true },
    { label: 'explicitly stale boardless legacy result', time: REVALIDATION_TIME, stale: true, now: start, expected: true },
  ])('$label', ({ time, stale, now, expected }) => {
    eligible({ ...revalidationCatalog([]), boards: [], fetchedAt: time, stale }, now, expected)
  })

  it('reports due board data independently of the hook’s global refreshAfter gate', () => {
    eligible(oneBoard({ lastSuccessAt: at(-1_800_000) }, { refreshAfter: at(120000) }), start, true)
  })
})

describe('per-board failure and retry boundaries', () => {
  it.each([
    { label: '59.999 seconds after failure', checkedAt: REVALIDATION_TIME, retryAt: undefined, now: start + 59999, expected: false },
    { label: 'exactly60 seconds after failure', checkedAt: REVALIDATION_TIME, retryAt: undefined, now: start + 60000, expected: true },
    { label: 'future retry remains closed after the minimum', checkedAt: REVALIDATION_TIME, retryAt: at(120000), now: start + 119999, expected: false },
    { label: 'exact retry deadline is allowed', checkedAt: REVALIDATION_TIME, retryAt: at(120000), now: start + 120000, expected: true },
    { label: 'past retry does not shorten the one-minute failure window', checkedAt: REVALIDATION_TIME, retryAt: at(10000), now: start + 59999, expected: false },
    { label: 'future failure time cannot be retried early', checkedAt: at(60000), retryAt: at(-1), now: start + 119999, expected: false },
    { label: 'unknown failure time still obeys a valid future retry', checkedAt: undefined, retryAt: at(120000), now: start, expected: false },
    { label: 'invalid failure time does not invent an extra delay', checkedAt: 'invalid', retryAt: undefined, now: start, expected: true },
    { label: 'invalid retry still obeys the valid failure minimum', checkedAt: REVALIDATION_TIME, retryAt: 'invalid', now: start + 59999, expected: false },
    { label: 'an invalid retry cannot make a failed board permanently stuck', checkedAt: REVALIDATION_TIME, retryAt: 'invalid', now: start + 60000, expected: true },
  ])('$label', ({ checkedAt, retryAt, now, expected }) => {
    eligible(oneBoard({ status: 'error', checkedAt, retryAt, lastSuccessAt: REVALIDATION_TIME }), now, expected)
  })

  it('does not bypass future board retry merely because the snapshot and catalog are stale', () => {
    const catalog = oneBoard({
      status: 'error', dataStatus: 'stale', lastSuccessAt: at(-86_400_001),
      checkedAt: at(-60000), retryAt: at(60000), message: 'Fictional429',
    }, { stale: true })
    eligible(catalog, start, false)
  })

  it('allows a different due board without treating the retry-gated company as eligible', () => {
    const catalog = revalidationCatalog()
    catalog.boards[0] = {
      ...catalog.boards[0], status: 'error', dataStatus: 'stale', checkedAt: at(-60000),
      lastSuccessAt: at(-86_400_001), retryAt: at(60000),
    }
    catalog.boards[1].lastSuccessAt = at(-1_800_000)
    eligible(catalog, start, true)
    eligible({ ...catalog, boards: [catalog.boards[0]] }, start, false)
  })
})

describe('legacy snapshot authority and preserved age-only semantics', () => {
  it('finds the oldest valid matching job even when it appears last, ignoring invalid dates', () => {
    const catalog = oneBoard({ lastSuccessAt: undefined }, {
      fetchedAt: at(1_800_000),
      jobs: [
        revalidationJob('Invalid48', { fetchedAt: 'invalid' }),
        revalidationJob('New48', { fetchedAt: at(1_800_000) }),
        revalidationJob('Old48'),
      ],
    })
    eligible(catalog, start + 1_800_000, true)
  })

  it('does not borrow an older job timestamp from a different company', () => {
    const catalog = oneBoard({ lastSuccessAt: undefined }, {
      fetchedAt: at(1_800_000),
      jobs: [
        revalidationJob('Other48', { companyId: 'search-fixture-b' }),
        revalidationJob('Current48', { fetchedAt: at(1_800_000) }),
      ],
    })
    eligible(catalog, start + 1_800_001, false)
  })

  it('uses a valid explicit successful timestamp before an older matching job', () => {
    eligible(oneBoard({ lastSuccessAt: at(1_800_000) }), start + 1_800_001, false)
  })

  it('falls back from an invalid explicit timestamp to the oldest valid job', () => {
    eligible(oneBoard({ lastSuccessAt: 'invalid' }, { fetchedAt: at(1_800_000) }), start + 1_800_000, true)
  })

  it('preserves explicit null as unknown even when a matching job and aggregate date are fresh', () => {
    eligible(oneBoard({ lastSuccessAt: null }), start, true)
  })

  it('uses the successful legacy catalog timestamp only when no matching valid job exists', () => {
    const catalog = oneBoard({ lastSuccessAt: undefined }, {
      fetchedAt: at(1_800_000), jobs: [revalidationJob('Invalid48', { fetchedAt: 'invalid' })],
    })
    eligible(catalog, start + 1_800_001, false)
    eligible(catalog, start + 3_600_000, true)
  })

  it('marks retained legacy records and removes expired ones without rewriting snapshot history', () => {
    const catalog = oneBoard({ lastSuccessAt: undefined }, {
      fetchedAt: at(1_800_000),
      jobs: [revalidationJob('Newer48', { fetchedAt: at(1000) }), revalidationJob('Oldest48')],
    })
    const before = structuredClone(catalog)
    const stale = ageCatalog(catalog, start + 1_800_000).catalog
    expect(stale.jobs.map(job => [job.id, job.stale])).toEqual([
      ['greenhouse-search-fixture-a-Newer48', true], ['greenhouse-search-fixture-a-Oldest48', true],
    ])
    expect(stale.boards[0]).toMatchObject({ lastSuccessAt: REVALIDATION_TIME, status: 'ok', dataStatus: 'stale', checkedAt: REVALIDATION_TIME })
    const expired = ageCatalog(catalog, start + 86_400_001)
    expect(expired.expired).toBe(true)
    expect(expired.catalog.jobs).toEqual([])
    expect(expired.catalog.boards[0]).toMatchObject({ lastSuccessAt: REVALIDATION_TIME, status: 'ok', dataStatus: 'unavailable', total: 0, included: 0 })
    expect(catalog).toEqual(before)
  })
})
