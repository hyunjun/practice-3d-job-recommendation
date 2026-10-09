import { CATALOG_LIFETIME } from '../shared/catalog-freshness'
import { PUBLICATION_LIMITS } from '../shared/publication'
import type { PublicationHead, PublicationManifest } from '../shared/publication'

export type BodyPart = { text: string } | { fragment: string }
export interface Projection {
  parts: BodyPart[]
  bytes: number
}
export class PublicationResponseError extends Error {
  constructor(readonly status: number, readonly body: Record<string, unknown>) {
    super(String(body.error))
  }
}
const iso = (at: number) => new Date(at).toISOString()
const encoder = new TextEncoder()
const deadline = (values: (string | null)[], at: number) =>
  iso(Math.min(...values.map(value => value === null ? at : Date.parse(value))))
const objectStart = (value: object) => JSON.stringify(value).slice(0, -1)

function plan(parts: BodyPart[], manifest: PublicationManifest, limit: number): Projection {
  const bytes = parts.reduce((sum, part) =>
    sum + ('text' in part ? encoder.encode(part.text).length : manifest.fragments[part.fragment].decodedBytes), 0)
  if (bytes > limit) throw new Error('Stored response exceeds its decoded size limit')
  return { parts, bytes }
}
function arrayParts(names: string[], manifest: PublicationManifest): BodyPart[] {
  return names.filter(name => manifest.fragments[name].decodedBytes > 0)
    .flatMap((fragment, index): BodyPart[] => [...(index ? [{ text: ',' }] : []), { fragment }])
}

export function usableBoardCount(manifest: PublicationManifest, at: number): number {
  return manifest.catalog.boards.filter(board => board.eligible && board.fetchedAt
    && at - Date.parse(board.fetchedAt) <= CATALOG_LIFETIME.maxFallbackAge).length
}

export function projectCatalog(manifest: PublicationManifest, head: PublicationHead, at: number): Projection {
  const fragments: string[] = []
  const dates: number[] = []
  let unmappedCount: number | null = 0
  const boards = manifest.catalog.boards.map(board => {
    const usable = board.eligible && board.fetchedAt !== null
      && at - Date.parse(board.fetchedAt) <= CATALOG_LIFETIME.maxFallbackAge
    const stale = usable && (board.initiallyStale || at >= Date.parse(board.freshUntil!))
    if (usable) {
      dates.push(Date.parse(board.fetchedAt!))
      fragments.push((stale ? board.stale : board.fresh)!)
      unmappedCount = unmappedCount === null || board.unmappedCount === null ? null : unmappedCount + board.unmappedCount
    }
    return {
      ...board.base, dataStatus: !usable ? 'unavailable' : stale ? 'stale' : 'fresh',
      total: usable ? board.total : 0, included: usable ? board.included : 0,
    }
  })
  const refreshAfter = deadline(manifest.catalog.boards.map(board => board.contentDeadline), at)
  if (!dates.length) {
    const expired = manifest.catalog.boards.some(board => board.fetchedAt !== null)
    throw new PublicationResponseError(503, {
      error: expired
        ? '게시판에 연결하지 못했어요. 마지막 정상 조회가 24시간을 지나 이전 공고를 표시하지 않습니다.'
        : '공개 채용 게시판에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요.',
      code: expired ? 'CATALOG_EXPIRED' : 'CATALOG_UNAVAILABLE', retryAt: refreshAfter,
    })
  }
  const metadata = {
    source: 'public', fetchedAt: iso(Math.max(...dates)),
    ...(manifest.catalog.checkedAt ? { checkedAt: manifest.catalog.checkedAt } : {}),
    refreshAfter, stale: boards.some(board => board.dataStatus === 'stale'),
    companies: manifest.capture.companies, cities: manifest.catalog.cities, boards, unmappedCount,
    publication: { mode: 'scheduled', generation: head.generation, publishedAt: head.publishedAt, intervalMinutes: 30 },
  }
  return plan([
    { text: `${objectStart(metadata)},"jobs":[` }, ...arrayParts(fragments, manifest), { text: ']}' },
  ], manifest, PUBLICATION_LIMITS.catalog)
}

export function projectPostingStatus(manifest: PublicationManifest, at: number): Projection {
  const parts: BodyPart[] = []
  const source = manifest.posting.boards
  const metadata = {
    version: 2,
    checkedAt: iso(Math.max(...source.map(board => board.checkedAt === null ? at : Date.parse(board.checkedAt)))),
    refreshAfter: deadline(source.map(board => board.inventoryDeadline), at),
    contentRefreshAfter: deadline(source.map(board => board.contentDeadline), at),
  }
  parts.push({ text: `${objectStart(metadata)},"boards":[` })
  for (const [index, board] of source.entries()) {
    if (index) parts.push({ text: ',' })
    const base = { ...board.base, checkedAt: board.checkedAt ?? iso(at) }
    const listed = board.listing !== null && board.listingAt !== null
      && at - Date.parse(board.listingAt) <= CATALOG_LIFETIME.maxFallbackAge
    if (listed) {
      const bodyFresh = board.bodyFreshUntil !== null && at < Date.parse(board.bodyFreshUntil)
      parts.push(
        { text: `${objectStart(base)},"listing":` },
        { fragment: (bodyFresh ? board.listing : board.oldBody)! }, { text: '}' },
      )
    } else {
      parts.push({ text: JSON.stringify(base) })
    }
  }
  parts.push({ text: ']}' })
  return plan(parts, manifest, PUBLICATION_LIMITS.posting)
}

export function projectObservations(manifest: PublicationManifest, at: number): Projection {
  const firstDay = iso(at - 89 * 86_400_000).slice(0, 10)
  const source = manifest.observations
  const metadata = {
    version: 1, retentionDays: 90, scope: source.scope, method: source.method,
    otherSeries: source.otherSeries.flatMap(series => {
      const days = series.days.filter(day => day >= firstDay)
      return days.length ? [{
        scopeKey: series.scopeKey, method: series.method, companyCount: series.companyCount,
        firstDay: days[0], lastDay: days.at(-1)!,
      }] : []
    }),
    storage: 'ok',
  }
  return plan([
    { text: `${objectStart(metadata)},"days":[` },
    ...arrayParts(source.days.filter(day => day.day >= firstDay).map(day => day.fragment), manifest),
    { text: ']}' },
  ], manifest, PUBLICATION_LIMITS.observations)
}

/** Weak validators are shared across identity/gzip/br representations. */
export function projectionValidatorInput(manifest: PublicationManifest, projection: Projection): string {
  return JSON.stringify({
    generation: manifest.generation,
    parts: projection.parts.map(part => 'text' in part ? part.text : {
      fragment: part.fragment, hash: manifest.fragments[part.fragment].decodedHash,
    }),
  })
}
