import { z } from 'zod'
import { PUBLIC_PROVIDERS } from './types'
import type { Job, JobProvider, SavedJob } from './types'

export const REVISION_FIELDS = ['title', 'location', 'conditions', 'compensation', 'qualifications', 'description', 'url'] as const
export type RevisionField = typeof REVISION_FIELDS[number]
export type JobRevision = Record<RevisionField, string>
export const REVISION_LABELS: Record<RevisionField, string> = {
  title: '포지션', location: '근무지', conditions: '근무·고용·비자', compensation: '보상',
  qualifications: '기술·경력', description: '본문', url: '지원 링크',
}

export interface PostingBoard {
  companyId: string
  provider: JobProvider
  board: string
  boardRegion?: 'eu'
  status: 'ok' | 'error'
  checkedAt: string
  lastSuccessAt: string | null
  retryAt: string | null
  message?: string
  listing?: {
    validUntil: string
    publishedIds: string[]
    jobs: { id: string; title: string; url: string; revision: JobRevision }[]
  }
}

export interface PostingStatusIndex {
  version: 1
  checkedAt: string
  refreshAfter: string
  boards: PostingBoard[]
}

const Timestamp = z.iso.datetime({ offset: true })
const Id = z.string().min(1).max(500)
const RevisionSchema = z.object(Object.fromEntries(REVISION_FIELDS.map(field => [field, z.string().regex(/^[a-f0-9]{64}$/)])) as Record<RevisionField, z.ZodString>)
export const PostingStatusIndexSchema = z.object({
  version: z.literal(1), checkedAt: Timestamp, refreshAfter: Timestamp,
  boards: z.array(z.object({
    companyId: z.string().min(1).max(100), provider: z.enum(PUBLIC_PROVIDERS),
    board: z.string().min(1).max(200), boardRegion: z.literal('eu').optional(),
    status: z.enum(['ok', 'error']), checkedAt: Timestamp, lastSuccessAt: Timestamp.nullable(),
    retryAt: Timestamp.nullable(), message: z.string().max(500).optional(),
    listing: z.object({
      validUntil: Timestamp,
      publishedIds: z.array(Id).max(20000),
      jobs: z.array(z.object({ id: Id, title: z.string().max(1000), url: z.string().max(2000), revision: RevisionSchema })).max(20000),
    }).optional(),
  })).max(1000),
}).superRefine((data, context) => {
  const companies = new Set<string>()
  for (const board of data.boards) {
    if (companies.has(board.companyId)) context.addIssue({ code: 'custom', message: 'Duplicate company' })
    companies.add(board.companyId)
    if ((board.boardRegion && board.provider !== 'lever')
      || (board.lastSuccessAt && Date.parse(board.lastSuccessAt) > Date.parse(board.checkedAt))) {
      context.addIssue({ code: 'custom', message: 'Invalid board scope or collection time' })
    }
    if (!board.listing) continue
    const ids = new Set(board.listing.publishedIds)
    const prefix = `${board.provider}-${board.companyId}-`
    if (!board.lastSuccessAt || ids.size !== board.listing.publishedIds.length
      || [...ids].some(id => !id.startsWith(prefix))
      || board.listing.jobs.some(job => !ids.has(job.id))
      || new Set(board.listing.jobs.map(job => job.id)).size !== board.listing.jobs.length
      || Date.parse(board.listing.validUntil) <= Date.parse(board.lastSuccessAt)
      || Date.parse(board.listing.validUntil) - Date.parse(board.lastSuccessAt) > 30 * 60 * 1000) {
      context.addIssue({ code: 'custom', message: 'Invalid published listing' })
    }
  }
})

/** Canonicalize display data, never timestamps, save notes, matching scores or parser versions. */
const compareText = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0
function stable(value: unknown): unknown {
  if (typeof value === 'string') return value.replace(/\s+/g, ' ').trim()
  if (Array.isArray(value)) return value.map(stable).sort((a, b) => compareText(JSON.stringify(a), JSON.stringify(b)))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .filter(([key, entry]) => entry !== undefined && key !== 'version').sort(([a], [b]) => compareText(a, b))
    .map(([key, entry]) => [key, stable(entry)]))
  return value
}

export async function createJobRevision(job: Job): Promise<JobRevision> {
  const sections: Record<RevisionField, unknown> = {
    title: job.title,
    location: { cities: job.cityIds, label: job.locationLabel },
    conditions: {
      workMode: job.workMode, employment: job.employment, visa: job.visa,
      remoteCountries: job.remoteCountries, remoteWorldwide: job.remoteWorldwide,
      remoteScopeUnknown: job.remoteScopeUnknown, remoteRegions: job.remoteRegions ?? [],
    },
    compensation: {
      salary: job.salary, ranges: job.compensationRanges ?? [],
      note: job.compensationNote ?? '', evidence: job.compensationEvidence ?? [],
    },
    qualifications: { skills: job.skills, years: job.minExperience, details: job.qualifications ?? null },
    description: job.description,
    url: job.url,
  }
  const pairs = await Promise.all(REVISION_FIELDS.map(async field => {
    const bytes = new TextEncoder().encode(JSON.stringify(stable(sections[field])))
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
    return [field, [...digest].map(byte => byte.toString(16).padStart(2, '0')).join('')]
  }))
  return Object.fromEntries(pairs) as JobRevision
}

export type PostingState = 'sample' | 'unchecked' | 'listed' | 'missing' | 'unknown'
export const POSTING_STATE_LABELS: Record<PostingState, string> = {
  sample: '샘플 공고', unchecked: '아직 확인하지 않음', listed: '게시 확인',
  missing: '공개 목록에서 미확인', unknown: '현재 상태 확인 필요',
}
export interface PostingObservation {
  state: PostingState
  checkedAt?: string
  message?: string
  changedFields?: RevisionField[]
  currentTitle?: string
  currentUrl?: string
}

export function observeSavedPosting(saved: SavedJob, index: PostingStatusIndex | null, revision: JobRevision | undefined, now: number, requestError = ''): PostingObservation {
  const job = saved.job
  if (job.source === 'sample') return { state: 'sample' }
  if (requestError) return { state: 'unknown', message: '게시 상태 조회에 연결하지 못했어요. 저장한 기록은 그대로 보관합니다.' }
  if (!index) return { state: 'unchecked' }
  const board = index.boards.find(item => item.companyId === job.companyId && item.provider === job.source)
  if (!board || (saved.company.board && (saved.company.board !== board.board || saved.company.boardRegion !== board.boardRegion))) {
    return { state: 'unknown', message: '저장한 공고의 게시판이 현재 조회 범위와 달라요. 원문에서 확인해 주세요.' }
  }
  const checkedAt = board.lastSuccessAt ?? undefined
  const listing = board.listing
  if (board.status !== 'ok') return { state: 'unknown', checkedAt, message: '회사 게시판 조회에 실패했어요. 이전 목록으로 게시 종료를 판단하지 않습니다.' }
  if (!listing || !checkedAt) return { state: 'unknown', checkedAt, message: '전체 공개 목록을 확인할 수 있는 조회 기록이 아직 없어요.' }
  if (Date.parse(checkedAt) > now + 5 * 60 * 1000) return { state: 'unknown', message: '조회 시각을 확인할 수 없어요. 기기의 시각과 연결을 확인해 주세요.' }
  if (now >= Date.parse(listing.validUntil)) return { state: 'unknown', checkedAt, message: '마지막 확인 이후 시간이 지났어요. 게시 상태를 다시 확인해 주세요.' }
  if (!Number.isFinite(Date.parse(job.fetchedAt)) || Date.parse(checkedAt) < Date.parse(job.fetchedAt)) {
    return { state: 'unknown', checkedAt, message: '조회한 목록이 저장된 공고의 확인 시각보다 이전이에요.' }
  }
  if (!listing.publishedIds.includes(job.id)) {
    if (!saved.company.board) return { state: 'unknown', checkedAt, message: '이전 기록의 게시판을 확인할 수 없어 목록에서 사라졌는지 판단하지 않습니다.' }
    return { state: 'missing', checkedAt, message: '최근 공개 목록에서 찾지 못했어요. 채용 종료 여부는 원문에서 확인해 주세요.' }
  }
  const current = listing.jobs.find(item => item.id === job.id)
  return {
    state: 'listed', checkedAt,
    ...(current ? { currentTitle: current.title, currentUrl: current.url } : {}),
    ...(current && revision ? { changedFields: REVISION_FIELDS.filter(field => revision[field] !== current.revision[field]) }
      : { message: current ? '게시 여부를 확인했어요. 이 기록의 내용 비교는 확인하지 못했습니다.' : '게시판에는 있지만 현재 탐색 범위 밖의 공고라 내용은 원문에서 확인해야 합니다.' }),
  }
}
