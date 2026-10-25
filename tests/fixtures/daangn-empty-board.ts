import type { Company } from '../../shared/types'
import type { BoardResult } from '../../server/catalog-service'

/**
 * Historical source tests inject board readers and pin Date.now independently
 * of timers. Their new boards are explicitly empty at that existing injection
 * seam. The real Daangn parser, session and 3-second pacing are exercised in
 * daangn-parser/integration/http and the default-collector browser suite.
 * No existing board is intercepted and no queue policy is weakened.
 */
export async function withEmptyDaangnBoard(
  company: Company, at: string,
  read: (company: Company, at: string) => Promise<BoardResult>,
): Promise<BoardResult> {
  if (company.provider === 'careers' && (company.board === 'daangn' || company.board === 'daangn-pay'))
    return { jobs: [], total: 0, unmappedCount: 0, publishedIds: [] }
  return read(company, at)
}
