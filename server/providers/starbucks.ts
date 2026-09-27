import { z } from 'zod'
import { BoardFetchError } from '../catalog-service'
import type { CareerPosting, CareerRequest } from './careers-common'

const Summary = z.object({
  id: z.number().int().positive().safe(),
  name: z.string().trim().min(1).max(1000),
  positionUrl: z.string().max(2000),
  department: z.string().max(1000).nullish(),
  workLocationOption: z.string().max(200).nullish(),
}).refine(job => job.positionUrl === `/careers/job/${job.id}`)
const Page = z.object({
  data: z.object({
    count: z.number().int().nonnegative().max(1000),
    positions: z.array(Summary).max(10),
    appliedFilters: z.object({ jobCategory: z.tuple([z.literal('technology')]) }),
  }),
})
const Text = z.string().max(2000).nullish()
const Place = z.object({
  address: z.object({
    addressLocality: Text, addressRegion: Text,
    addressCountry: z.union([z.string().max(1000), z.object({ name: z.string().max(1000) })]).nullish(),
  }),
})
const Detail = z.object({
  '@type': z.literal('JobPosting'),
  title: z.string().trim().min(1).max(1000),
  url: z.string().max(2000),
  description: z.string().trim().min(1).max(200_000),
  employmentType: z.union([z.string().max(200), z.array(z.string().max(200)).max(20)]).nullish(),
  hiringOrganization: z.object({ name: z.literal('Starbucks Coffee Company'), sameAs: z.literal('starbucks.com') }),
  jobLocation: z.union([Place, z.array(Place).min(1).max(100)]).optional(),
  jobLocationType: z.string().max(100).optional(),
})
export type StarbucksSummary = z.infer<typeof Summary>

export async function readStarbucksInventory(request: CareerRequest, signal: AbortSignal): Promise<StarbucksSummary[]> {
  const postings = new Map<number, StarbucksSummary>()
  let total: number | undefined
  for (let start = 0; start < 1000; start += 10) {
    const parsed = Page.safeParse(await request(`https://apply.starbucks.com/api/pcsx/search?domain=starbucks.com&query=&location=&start=${start}&filter_job_category=technology`, signal))
    if (!parsed.success) throw new BoardFetchError('Starbucks Technology 공개 목록의 형식을 확인하지 못했어요.')
    const result = parsed.data.data
    if (total !== undefined && total !== result.count || result.positions.length !== Math.min(10, result.count - start)) {
      throw new BoardFetchError('Starbucks Technology의 전체 공개 목록이 일치하지 않아요.')
    }
    total = result.count
    for (const posting of result.positions) {
      if (postings.has(posting.id)) throw new BoardFetchError('Starbucks Technology 공개 목록에 중복 공고가 있어요.')
      postings.set(posting.id, posting)
    }
    if (postings.size === total) return [...postings.values()]
  }
  throw new BoardFetchError('Starbucks Technology 공개 목록이 수집 한도를 넘었어요.')
}

export async function readStarbucksPosting(summary: StarbucksSummary, request: CareerRequest, signal: AbortSignal): Promise<CareerPosting> {
  const url = `https://apply.starbucks.com/careers/job/${summary.id}`
  const html = await request(url, signal)
  if (typeof html !== 'string' || Buffer.byteLength(html) > 8 * 1024 * 1024) {
    throw new BoardFetchError('Starbucks 공고의 공개 페이지를 확인하지 못했어요.')
  }
  const candidates: unknown[] = []
  for (const script of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    if (!/\btype\s*=\s*["']application\/ld\+json["']/i.test(script[1])) continue
    let value: unknown
    try { value = JSON.parse(script[2]) } catch { throw new BoardFetchError('Starbucks 공개 구조화 데이터의 형식을 확인하지 못했어요.') }
    const values = Array.isArray(value) ? value : [value]
    for (const item of values) {
      if (item && typeof item === 'object' && item['@type'] === 'JobPosting') candidates.push(item)
    }
  }
  if (candidates.length !== 1) throw new BoardFetchError('Starbucks 공고의 공개 본문을 확인하지 못했어요.')
  const response = Detail.safeParse(candidates[0])
  if (!response.success) throw new BoardFetchError('Starbucks 공고의 공개 본문 형식을 확인하지 못했어요.')
  const raw = response.data
  if (raw.url !== url || raw.title !== summary.name) {
    throw new BoardFetchError('Starbucks 공고의 ID·제목이 공개 목록과 일치하지 않아요.')
  }
  const places = raw.jobLocation ? Array.isArray(raw.jobLocation) ? raw.jobLocation : [raw.jobLocation] : []
  const mode = [summary.workLocationOption, raw.jobLocationType === 'TELECOMMUTE' ? 'remote' : '']
    .filter((value): value is string => Boolean(value))
  return {
    id: String(summary.id), title: raw.title, url, description: raw.description,
    locations: places.map(({ address }) => {
      const country = typeof address.addressCountry === 'string' ? address.addressCountry : address.addressCountry?.name
      return {
        label: [address.addressLocality, address.addressRegion, country].filter(Boolean).join(', '),
        address: { addressLocality: address.addressLocality, addressRegion: address.addressRegion, addressCountry: country },
      }
    }),
    departments: ['Technology', ...(summary.department ? [summary.department] : [])],
    employment: (Array.isArray(raw.employmentType) ? raw.employmentType.join(' · ') : raw.employmentType)?.replaceAll('_', ' '),
    workMode: mode,
    // SEO publication/expiry dates are not content revisions or authoritative closures.
    updatedAt: null,
  }
}
