import type { Job } from './types'

/** Site-specific public collectors. These identifiers never become arbitrary hosts. */
export const CAREER_BOARDS = ['booking', 'zalando', 'starbucks-technology'] as const
export type CareerBoard = typeof CAREER_BOARDS[number]

export function isCareerBoard(board: string): board is CareerBoard {
  return (CAREER_BOARDS as readonly string[]).includes(board)
}

export function isStarbucksTechnologyJob(job: Pick<Job, 'source' | 'url'>): boolean {
  if (job.source !== 'careers') return false
  try {
    const url = new URL(job.url)
    return url.origin === 'https://apply.starbucks.com' && /^\/careers\/job\/\d+$/.test(url.pathname)
  } catch { return false }
}
