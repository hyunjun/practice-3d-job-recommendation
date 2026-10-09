import { describe, expect, it } from 'vitest'
import type { BoardStatus } from '../../../shared/types'
import { boardFreshness, recentBoards } from './board-freshness'
import type { RecentBoards } from './board-freshness'

/**
 * Literal boundary witnesses for the frozen "recent normal boards" predicate
 * (ARR82-1/MRS82-1): every expected instant, millisecond count and reason below
 * is written as a literal; nothing is derived from the helper under test. Pure
 * data, no network, no production origin. Selected by vitest.remote.config.ts
 * only; the Playwright configurations do not match this file.
 */
const REQUESTED_AT = '2026-10-03T06:35:00.000Z'
const normal = (companyId: string, overrides: Partial<BoardStatus> = {}): BoardStatus => ({
  companyId, board: `${companyId}-board`, provider: 'greenhouse', status: 'ok', total: 3, included: 3,
  dataStatus: 'fresh', checkedAt: REQUESTED_AT, lastSuccessAt: '2026-10-03T06:00:00.000Z', retryAt: null, ...overrides,
})
const summary = (result: RecentBoards) => result.boards.map(board => [board.companyId, board.ageMs, board.reason, board.qualifies])

describe('recent normal boards: request-start reference with inclusive age 0..24h', () => {
  it('ages -1 ms, 0 ms, one day and one day + 1 ms resolve to future, ok, ok and older-than-24h', () => {
    const result = recentBoards({ boards: [
      normal('minus-1ms', { lastSuccessAt: '2026-10-03T06:35:00.001Z' }),
      normal('zero', { lastSuccessAt: '2026-10-03T06:35:00.000Z' }),
      normal('one-day', { lastSuccessAt: '2026-10-02T06:35:00.000Z' }),
      normal('one-day-plus-1ms', { lastSuccessAt: '2026-10-02T06:34:59.999Z' }),
    ] }, REQUESTED_AT)
    expect(result.reference).toBe('2026-10-03T06:35:00.000Z')
    expect(summary(result)).toEqual([
      ['minus-1ms', -1, 'future', false],
      ['zero', 0, 'ok', true],
      ['one-day', 86400000, 'ok', true],
      ['one-day-plus-1ms', 86400001, 'older-than-24h', false],
    ])
    expect(result.qualifying).toBe(2)
  })

  it('applies no future tolerance: successes one second and five minutes after the request start do not qualify', () => {
    expect(summary(recentBoards({ boards: [
      normal('plus-1s', { lastSuccessAt: '2026-10-03T06:35:01.000Z' }),
      normal('plus-5min', { lastSuccessAt: '2026-10-03T06:40:00.000Z' }),
    ] }, REQUESTED_AT))).toEqual([['plus-1s', -1000, 'future', false], ['plus-5min', -300000, 'future', false]])
  })

  it('uses the request start, not a later arrival instant: the same board flips from ok to future when only the reference moves', () => {
    const board = normal('edge', { lastSuccessAt: '2026-10-03T06:35:30.000Z' })
    expect(boardFreshness(board, Date.parse('2026-10-03T06:36:00.000Z'))).toMatchObject({ ageMs: 30000, reason: 'ok', qualifies: true })
    expect(boardFreshness(board, Date.parse('2026-10-03T06:35:00.000Z'))).toMatchObject({ ageMs: -30000, reason: 'future', qualifies: false })
  })

  it('disqualifies error and pending status, unavailable data and missing or invalid timestamps; an absent dataStatus is reported as null without changing acceptance', () => {
    const result = recentBoards({ boards: [
      normal('errored', { status: 'error', dataStatus: 'unavailable', lastSuccessAt: null, message: 'synthetic' }),
      normal('pending', { status: 'pending', dataStatus: undefined, lastSuccessAt: undefined }),
      normal('unavailable-with-recent-success', { dataStatus: 'unavailable' }),
      normal('no-timestamp', { lastSuccessAt: null }),
      normal('invalid-timestamp', { lastSuccessAt: 'not-a-date' }),
      normal('stale-but-recent', { dataStatus: 'stale' }),
      normal('no-datastatus', { dataStatus: undefined }),
    ] }, REQUESTED_AT)
    expect(summary(result)).toEqual([
      ['errored', null, 'status:error', false],
      ['pending', null, 'status:pending', false],
      ['unavailable-with-recent-success', 2100000, 'unavailable', false],
      ['no-timestamp', null, 'missing-or-invalid-timestamp', false],
      ['invalid-timestamp', null, 'missing-or-invalid-timestamp', false],
      ['stale-but-recent', 2100000, 'ok', true],
      ['no-datastatus', 2100000, 'ok', true],
    ])
    expect(result.boards.map(board => board.dataStatus)).toEqual(['unavailable', null, 'unavailable', 'fresh', 'fresh', 'stale', null])
    expect(result.qualifying).toBe(2)
  })

  it('115 of 130: 114 recent boards plus one stamped a minute after the request stay below the frozen threshold; a 115th recent board meets it', () => {
    const recent = Array.from({ length: 114 }, (_, index) => normal(`recent-${index + 1}`, { lastSuccessAt: '2026-10-03T00:00:00.000Z' }))
    const failed = Array.from({ length: 15 }, (_, index) => normal(`failed-${index + 1}`, { status: 'error', dataStatus: 'unavailable', lastSuccessAt: null }))
    const short = recentBoards({ boards: [...recent, normal('future-1min', { lastSuccessAt: '2026-10-03T06:36:00.000Z' }), ...failed] }, REQUESTED_AT)
    expect(short.boards).toHaveLength(130)
    expect(short.qualifying).toBe(114)
    expect(short.qualifying >= 115).toBe(false)
    const met = recentBoards({ boards: [...recent, normal('recent-115', { lastSuccessAt: '2026-10-02T06:35:00.000Z' }), ...failed] }, REQUESTED_AT)
    expect(met.boards).toHaveLength(130)
    expect(met.qualifying).toBe(115)
    expect(met.qualifying >= 115).toBe(true)
  })

  it('refuses a non-finite request-start reference instead of evaluating against NaN', () => {
    expect(() => recentBoards({ boards: [normal('any')] }, 'not-an-instant')).toThrow(/finite instant/)
  })
})
