import { z } from 'zod'
import { BoardFetchError } from '../catalog-service'
import type { CareerPosting, CareerRequest } from './careers-common'

const Text = z.string().max(2000).nullish()
const Address = z.object({ city: Text, state: Text, country: Text, country_code: Text })
const Identity = z.object({
  req_id: z.string().regex(/^\d{1,30}$/),
  slug: z.string().regex(/^\d{1,30}$/),
  title: z.string().trim().min(1).max(1000),
  client_code: z.literal('workingatbooking'),
  internal: z.literal(false),
  hiring_organization: z.enum(['Booking.com', 'Booking Holdings']),
}).refine(job => job.req_id === job.slug).passthrough()
const Page = z.object({
  totalCount: z.number().int().nonnegative().max(5000),
  count: z.number().int().nonnegative().max(5000),
  jobs: z.array(z.object({ data: Identity })).max(100),
})
const Posting = Identity.safeExtend({
  description: z.string().trim().min(1).max(200_000),
  city: Text, state: Text, country: Text, country_code: Text,
  additional_locations: z.array(Address).max(100).optional(),
  categories: z.array(z.object({ name: z.string().max(1000) })).max(100).optional(),
  department: z.string().max(1000).nullish(),
  employment_type: z.string().max(200).nullish(),
  update_date: z.string().max(100).nullish(),
})
export type BookingSummary = z.infer<typeof Identity>

export async function readBookingInventory(request: CareerRequest, signal: AbortSignal): Promise<BookingSummary[]> {
  const postings = new Map<string, BookingSummary>()
  let total: number | undefined
  for (let page = 1; page <= 50; page++) {
    const parsed = Page.safeParse(await request(`https://jobs.booking.com/api/jobs?page=${page}&limit=100&sortBy=relevance&descending=false&internal=false`, signal))
    if (!parsed.success) throw new BoardFetchError('Booking.com 공개 목록의 형식을 확인하지 못했어요.')
    const result = parsed.data
    if (result.count !== result.totalCount || total !== undefined && total !== result.totalCount
      || result.jobs.length !== Math.min(100, result.totalCount - (page - 1) * 100)) {
      throw new BoardFetchError('Booking.com의 전체 공개 목록이 일치하지 않아요.')
    }
    total = result.totalCount
    for (const { data } of result.jobs) {
      if (postings.has(data.req_id)) throw new BoardFetchError('Booking.com 공개 목록에 중복 공고가 있어요.')
      postings.set(data.req_id, data)
    }
    if (postings.size === total) return [...postings.values()]
  }
  throw new BoardFetchError('Booking.com 공개 목록이 수집 한도를 넘었어요.')
}

export function bookingPosting(summary: BookingSummary): CareerPosting {
  const parsed = Posting.safeParse(summary)
  if (!parsed.success) throw new BoardFetchError('Booking.com 공고의 본문 형식을 확인하지 못했어요.')
  const raw = parsed.data
  return {
    id: raw.req_id, title: raw.title, description: raw.description,
    url: `https://jobs.booking.com/booking/jobs/${raw.slug}?lang=en-us`,
    locations: [raw, ...(raw.additional_locations ?? [])].map(location => ({
      label: [location.city, location.state, location.country].filter(Boolean).join(', '),
      address: { addressLocality: location.city, addressRegion: location.state, addressCountry: location.country_code || location.country },
    })),
    departments: [...(raw.categories ?? []).map(category => category.name), ...(raw.department ? [raw.department] : [])],
    employment: raw.employment_type?.replaceAll('_', ' '), updatedAt: raw.update_date,
  }
}
