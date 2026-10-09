import type { BoardStatus, Catalog } from '../../../shared/types'

/**
 * Frozen Stage82 acceptance predicate for "recent normal boards" (ARR82-1/MRS82-1):
 * a board qualifies when its status is ok, its dataStatus is not unavailable and
 * its lastSuccessAt is a finite instant whose age at the request start,
 * requestedAt − lastSuccessAt, lies in the inclusive range 0..24 hours. The
 * reference is the client's own clock when the request was sent, never a
 * timestamp inside the response and never the response arrival time, and no
 * clock tolerance is applied: a success stamped after the request started is
 * 'future' and does not qualify. dataStatus is optional on the wire (ARR82-6);
 * an absent value is reported as null and does not change acceptance. Pure and
 * local; the literal boundary witnesses live in board-freshness-local.spec.ts.
 */
export const RECENT_BOARD_MAX_AGE_MS = 24 * 60 * 60 * 1000
export type FreshnessReason = 'ok' | 'status:error' | 'status:pending' | 'unavailable' | 'missing-or-invalid-timestamp' | 'future' | 'older-than-24h'
export interface BoardFreshness {
  companyId: string
  status: BoardStatus['status']
  /** The board's optional wire value; null records that the field was absent (diagnostic only). */
  dataStatus: NonNullable<BoardStatus['dataStatus']> | null
  lastSuccessAt: string | null
  /** requestedAt − lastSuccessAt in milliseconds; null when the timestamp is missing or unparsable. */
  ageMs: number | null
  qualifies: boolean
  reason: FreshnessReason
}
export interface RecentBoards { reference: string; qualifying: number; boards: BoardFreshness[] }

export function boardFreshness(board: BoardStatus, requestedAtMs: number): BoardFreshness {
  const lastSuccessAt = board.lastSuccessAt ?? null
  const parsed = lastSuccessAt === null ? Number.NaN : Date.parse(lastSuccessAt)
  const ageMs = Number.isFinite(parsed) ? requestedAtMs - parsed : null
  const reason: FreshnessReason = board.status === 'error' ? 'status:error' : board.status === 'pending' ? 'status:pending'
    : board.dataStatus === 'unavailable' ? 'unavailable'
    : ageMs === null ? 'missing-or-invalid-timestamp'
    : ageMs < 0 ? 'future'
    : ageMs > RECENT_BOARD_MAX_AGE_MS ? 'older-than-24h'
    : 'ok'
  return { companyId: board.companyId, status: board.status, dataStatus: board.dataStatus ?? null, lastSuccessAt, ageMs, qualifies: reason === 'ok', reason }
}

/** Evaluate every board of a catalog against the actual request-start instant (the ISO-8601 UTC string recorded by the transport before sending). */
export function recentBoards(catalog: Pick<Catalog, 'boards'>, requestedAt: string): RecentBoards {
  const requestedAtMs = Date.parse(requestedAt)
  if (!Number.isFinite(requestedAtMs)) throw new Error(`The request-start reference must be a finite instant, got ${JSON.stringify(requestedAt)}`)
  const boards = catalog.boards.map(board => boardFreshness(board, requestedAtMs))
  return { reference: requestedAt, qualifying: boards.filter(board => board.qualifies).length, boards }
}
