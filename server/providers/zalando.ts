import { z } from 'zod'
import { BoardFetchError } from '../catalog-service'
import type { CareerPosting, CareerRequest } from './careers-common'
import { flightObjects, flightText, readNextFlight } from './next-flight'

const Id = z.string().regex(/^\d{1,30}$/)
const Title = z.string().trim().min(1).max(1000)
const Summary = z.object({
  id: Id, title: Title, entity: z.string().min(1).max(1000).optional(),
  job_categories: z.array(z.string().max(1000)).max(100),
  offices: z.array(z.string().max(1000)).max(100),
  updated_at: z.string().min(1).max(100),
})
const Page = z.object({
  data: z.array(Summary).max(15),
  total: z.number().int().nonnegative().max(1500),
  next: z.string().nullable().optional(),
})
const Detail = z.object({
  Job_Req_Id: Id, Posting_Title: Title, Company: z.string().min(1).max(1000),
  Job_Description: z.string().min(1).max(200_000),
  Last_Update: z.string().min(1).max(100),
  Time_Type: z.string().max(200).nullish(),
  Department: z.string().max(1000).nullish(),
  Job_Category: z.string().max(1000).nullish(),
  Locations_search_object: z.array(z.object({ main: z.string().max(1000), parent: z.string().max(1000).nullable() })).max(100),
})
export type ZalandoSummary = z.infer<typeof Summary>

export async function readZalandoInventory(request: CareerRequest, signal: AbortSignal): Promise<ZalandoSummary[]> {
  const postings = new Map<string, ZalandoSummary>()
  let total: number | undefined
  for (let page = 1; page <= 100; page++) {
    const records = readNextFlight(await request(`https://jobs.zalando.com/en/jobs?page=${page}`, signal))
    const candidates = flightObjects(records, 'total').filter(value => Array.isArray(value.data))
    if (candidates.length !== 1) throw new BoardFetchError('Zalando 공개 공고 목록을 확인하지 못했어요.')
    const parsed = Page.safeParse(candidates[0])
    if (!parsed.success) throw new BoardFetchError('Zalando 공개 목록의 형식을 확인하지 못했어요.')
    const result = parsed.data
    if (total !== undefined && total !== result.total || result.data.length !== Math.min(15, result.total - (page - 1) * 15)) {
      throw new BoardFetchError('Zalando의 전체 공개 목록이 일치하지 않아요.')
    }
    total = result.total
    for (const posting of result.data) {
      if (postings.has(posting.id)) throw new BoardFetchError('Zalando 공개 목록에 중복 공고가 있어요.')
      postings.set(posting.id, posting)
    }
    if (postings.size === total) {
      if (result.next) throw new BoardFetchError('Zalando 공개 목록의 마지막 페이지를 확인하지 못했어요.')
      return [...postings.values()]
    }
    if (!result.next) throw new BoardFetchError('Zalando 공개 목록의 다음 페이지가 누락됐어요.')
    const next = new URL(result.next, 'https://jobs.zalando.com')
    if (next.origin !== 'https://jobs.zalando.com' || next.pathname !== '/search'
      || next.searchParams.get('offset') !== String(page * 15) || next.searchParams.get('limit') !== '15') {
      throw new BoardFetchError('Zalando 공개 목록의 페이지 순서를 확인하지 못했어요.')
    }
    // Follow the public page number, never a URL supplied by a response.
  }
  throw new BoardFetchError('Zalando 공개 목록이 수집 한도를 넘었어요.')
}

export async function readZalandoPosting(summary: ZalandoSummary, request: CareerRequest, signal: AbortSignal): Promise<CareerPosting> {
  const url = `https://jobs.zalando.com/en/jobs/${summary.id}`
  const records = readNextFlight(await request(url, signal))
  const candidates = flightObjects(records, 'Job_Description')
  if (candidates.length !== 1) throw new BoardFetchError('Zalando 공고의 본문을 확인하지 못했어요.')
  const parsed = Detail.safeParse(candidates[0])
  if (!parsed.success) throw new BoardFetchError('Zalando 공고의 본문 형식을 확인하지 못했어요.')
  const raw = parsed.data
  if (raw.Job_Req_Id !== summary.id || raw.Posting_Title !== summary.title || summary.entity !== undefined && raw.Company !== summary.entity
    || !Number.isFinite(Date.parse(raw.Last_Update)) || Date.parse(raw.Last_Update) !== Date.parse(summary.updated_at)) {
    throw new BoardFetchError('Zalando 공고의 회사·ID·내용이 공개 목록과 일치하지 않아요.')
  }
  const description = flightText(records, raw.Job_Description)
  if (!description.trim() || description.length > 200_000) throw new BoardFetchError('Zalando 공고의 본문을 확인하지 못했어요.')
  return {
    id: summary.id, title: raw.Posting_Title, url, description,
    locations: raw.Locations_search_object.map(location => ({
      label: [location.main, location.parent].filter(Boolean).join(', '),
      address: { addressLocality: location.main, addressCountry: location.parent },
    })),
    departments: [...summary.job_categories, raw.Job_Category, raw.Department].filter((value): value is string => Boolean(value)),
    employment: raw.Time_Type, updatedAt: raw.Last_Update,
  }
}
