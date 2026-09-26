import { z } from 'zod'
import type { Company, Job } from '../../shared/types'
import { BoardFetchError } from '../catalog-service'
import { normalizeCompensation } from '../../shared/compensation'
import { parseTextCompensation, payBasis } from '../../shared/pay-text'
import { employmentFact, workModeFact } from '../job-facts'
import { normalizePosting, plainText, postingCities, postingLocationLabel, postingRemoteScope } from '../normalize'
import type { PostingLocation } from '../normalize'
import { BOARD_TIMEOUT, MAX_POSTINGS, fetchBoardJson, includedJobs } from './http'

export const LeverJobSchema = z.object({
  id: z.string().min(1), text: z.string().min(1), hostedUrl: z.url().startsWith('https://'),
  categories: z.object({
    location: z.string().nullish(), allLocations: z.array(z.string()).nullish(), commitment: z.string().nullish(),
    department: z.string().nullish(), team: z.string().nullish(),
  }).nullish(),
  country: z.string().nullish(), workplaceType: z.string().nullish(),
  descriptionPlain: z.string().nullish(), description: z.string().nullish(),
  additionalPlain: z.string().nullish(), additional: z.string().nullish(),
  lists: z.array(z.object({ text: z.string().nullish(), content: z.string().nullish() })).nullish(),
  salaryDescriptionPlain: z.string().nullish(), salaryDescription: z.string().nullish(),
  salaryRange: z.object({
    currency: z.string().nullish(), interval: z.string().nullish(), min: z.number().nullish(), max: z.number().nullish(),
  }).nullish(),
})
export type LeverJob = z.infer<typeof LeverJobSchema>
const PAGE_SIZE = 50

export function normalizeLeverJob(raw: LeverJob, companyId: string, fetchedAt: string): Job | null {
  const text = [
    raw.descriptionPlain?.trim() || plainText(raw.description ?? ''),
    ...(raw.lists ?? []).map(item => [item.text, plainText(item.content ?? '')].filter(Boolean).join('\n')),
    raw.additionalPlain?.trim() || plainText(raw.additional ?? ''),
    raw.salaryDescriptionPlain?.trim() || plainText(raw.salaryDescription ?? ''),
  ].filter(Boolean).join('\n\n')
  const primary = raw.categories?.location?.trim() ?? ''
  const labels = [...new Set([primary, ...(raw.categories?.allLocations ?? [])].filter(Boolean))]
  const locations: PostingLocation[] = labels.length ? labels.map(label => ({
    label, ...(label === primary && raw.country ? { address: { addressCountry: raw.country } } : {}),
  })) : [{ label: '', address: { addressCountry: raw.country } }]
  const workMode = workModeFact(primary, [{ name: 'workplaceType', value: raw.workplaceType }], text)
  const employment = employmentFact(raw.text, [{ name: 'commitment', value: raw.categories?.commitment }], text)
  const cities = postingCities(locations)
  const salaryDescription = raw.salaryDescriptionPlain?.trim() || plainText(raw.salaryDescription ?? '')
  const salary = raw.salaryRange
    ? normalizeCompensation([{
      ...raw.salaryRange, label: '게시판의 급여 범위',
      basis: payBasis(salaryDescription) === 'total' ? 'total' : 'base',
      evidence: { source: 'board', text: [raw.salaryRange.currency, raw.salaryRange.interval, salaryDescription].filter(Boolean).join('\n') },
    }])
    : parseTextCompensation(text)
  return normalizePosting({
    provider: 'lever', id: raw.id, companyId, title: raw.text, text, url: raw.hostedUrl, fetchedAt,
    departments: [raw.categories?.department, raw.categories?.team].filter((value): value is string => typeof value === 'string'),
    cityIds: workMode.value === 'remote' ? [] : cities, locationLabel: postingLocationLabel(locations, workMode.value),
    locations: !primary && raw.country && labels.length
      ? [{ label: '', address: { addressCountry: raw.country } }, ...locations] : locations,
    workMode, employment, ...(workMode.value === 'remote' ? { scope: postingRemoteScope(locations) } : {}), ...salary,
  })
}

export async function fetchLeverBoard(company: Company, fetchedAt: string) {
  const signal = AbortSignal.timeout(BOARD_TIMEOUT)
  const host = company.boardRegion === 'eu' ? 'api.eu.lever.co' : 'api.lever.co'
  const jobs = new Map<string, LeverJob>()
  for (let skip = 0; skip <= MAX_POSTINGS; skip += PAGE_SIZE) {
    const url = `https://${host}/v0/postings/${encodeURIComponent(company.board!)}?mode=json&limit=${PAGE_SIZE}&skip=${skip}`
    const parsed = z.array(LeverJobSchema).max(PAGE_SIZE).safeParse(await fetchBoardJson(url, signal))
    if (!parsed.success) throw new BoardFetchError('Lever 게시판의 공고 형식을 확인하지 못했어요.')
    for (const job of parsed.data) {
      // An overlapping offset page can omit other postings; deduplication
      // cannot establish a complete inventory for cache or posting status.
      if (jobs.has(job.id)) throw new BoardFetchError('게시판의 공고 목록이 중복되어 전체 조회를 확인하지 못했어요.')
      jobs.set(job.id, job)
    }
    if (jobs.size > MAX_POSTINGS) throw new BoardFetchError('한 번에 확인할 수 있는 게시판 크기를 초과했어요.')
    if (parsed.data.length < PAGE_SIZE) return includedJobs([...jobs.values()].map(job => normalizeLeverJob(job, company.id, fetchedAt)), jobs.size, [...jobs.keys()].map(id => `lever-${company.id}-${id}`))
  }
  // Never replace a complete snapshot with a truncated feed.
  throw new BoardFetchError('게시판의 전체 공고를 확인하지 못했어요.')
}
