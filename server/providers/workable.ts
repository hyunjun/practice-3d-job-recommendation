import { z } from 'zod'
import type { Company, Job } from '../../shared/types'
import { parseTextCompensation } from '../../shared/pay-text'
import { BoardFetchError } from '../catalog-service'
import { employmentFact, workModeFact } from '../job-facts'
import { normalizePosting, plainText, postingCities, postingLocationLabel, postingRemoteScope } from '../normalize'
import type { PostingLocation } from '../normalize'
import { BOARD_TIMEOUT, MAX_POSTINGS, assertUniquePostingIds, includedJobs, readBoardInventory } from './http'
import { createBoardRequestQueue } from './request-queue'

const request = createBoardRequestQueue({ concurrency: 2, interval: 500 })
const Identity = z.object({
  shortcode: z.string().regex(/^[a-z0-9_-]{1,80}$/i),
  title: z.string().trim().min(1).max(1000),
  url: z.url().max(2000).startsWith('https://'),
}).refine(job => {
  const url = new URL(job.url)
  return url.origin === 'https://apply.workable.com' && !url.username && !url.password
    && !url.search && !url.hash && url.pathname.replace(/\/$/, '') === `/j/${job.shortcode}`
}, 'Workable shortcode and public job URL must agree').passthrough()
const Location = z.object({
  country: z.string().max(1000).nullish(), countryCode: z.string().max(100).nullish(),
  city: z.string().max(1000).nullish(), region: z.string().max(1000).nullish(),
  hidden: z.boolean(),
})
export const WorkableJobSchema = Identity.safeExtend({
  description: z.string().min(1).max(200_000),
  telecommuting: z.boolean(),
  employment_type: z.string().max(200).nullish(),
  department: z.string().max(1000).nullish(), function: z.string().max(1000).nullish(),
  locations: z.array(Location).max(300).nullish(),
  country: z.string().max(1000).nullish(), city: z.string().max(1000).nullish(), state: z.string().max(1000).nullish(),
})
export type WorkableJob = z.infer<typeof WorkableJobSchema>
const Feed = z.object({
  name: z.string().trim().min(1).max(1000),
  jobs: z.array(Identity).max(MAX_POSTINGS),
})

function companyName(value: string): string {
  return value.normalize('NFKC').toLowerCase()
    .replace(/(?:,\s*|\s+)(?:inc\.?|incorporated|ltd\.?|limited|llc|corp\.?|corporation)[\s.]*$/, '')
    .replace(/[\s.,&-]/g, '')
}

async function readInventory(company: Company, details: boolean) {
  if (!company.board || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(company.board)) {
    throw new BoardFetchError('Workable의 회사 계정 이름을 확인해 주세요.')
  }
  // The documented /api/accounts/<account> endpoint redirects to this public widget API.
  const url = `https://apply.workable.com/api/v1/widget/accounts/${encodeURIComponent(company.board)}${details ? '?details=true' : ''}`
  const parsed = Feed.safeParse(await request(url, AbortSignal.timeout(BOARD_TIMEOUT)))
  if (!parsed.success) throw new BoardFetchError('Workable의 전체 공개 공고 목록 형식을 확인하지 못했어요.')
  if (companyName(parsed.data.name) !== companyName(company.name)) {
    throw new BoardFetchError('Workable 응답의 회사 이름이 등록한 회사와 달라요.')
  }
  assertUniquePostingIds(parsed.data.jobs.map(job => ({ id: job.shortcode })))
  return parsed.data.jobs
}

function visibleLocations(raw: WorkableJob): PostingLocation[] {
  // A present empty/all-hidden array must not fall back to the private primary address.
  if (raw.locations != null) return raw.locations.filter(location => !location.hidden).map(location => ({
    label: [location.city, location.region, location.country].filter(Boolean).join(', '),
    address: {
      addressLocality: location.city, addressRegion: location.region,
      addressCountry: location.countryCode || location.country,
    },
  }))
  return [{
    label: [raw.city, raw.state, raw.country].filter(Boolean).join(', '),
    address: { addressLocality: raw.city, addressRegion: raw.state, addressCountry: raw.country },
  }]
}

export function normalizeWorkableJob(raw: WorkableJob, companyId: string, fetchedAt: string): Job | null {
  const text = plainText(raw.description)
  const locations = visibleLocations(raw)
  const stated = workModeFact(locations.map(location => location.label).join(' · '), [], text)
  const mode = raw.telecommuting
    ? { value: 'remote' as const, evidence: { source: 'board' as const, text: 'telecommuting: true' } }
    : stated.value === 'remote'
      ? { value: 'unknown' as const, evidence: { source: 'board' as const, text: `telecommuting: false\n${stated.evidence?.text ?? ''}`.slice(0, 3000) } }
      : stated
  return normalizePosting({
    provider: 'workable', id: raw.shortcode, companyId, title: raw.title,
    text, url: raw.url, fetchedAt,
    // created_at and published_on are not content revision timestamps.
    updatedAt: null,
    cityIds: mode.value === 'remote' ? [] : postingCities(locations),
    locationLabel: postingLocationLabel(locations, mode.value), locations, workMode: mode,
    employment: employmentFact(raw.title, [{ name: 'employmentType', value: raw.employment_type }], text),
    departments: [raw.department, raw.function].filter((value): value is string => Boolean(value?.trim())),
    ...(mode.value === 'remote' ? { scope: postingRemoteScope(locations) } : {}),
    ...parseTextCompensation(text),
  })
}

export async function fetchWorkableBoard(company: Company, fetchedAt: string) {
  const inventory = await readBoardInventory(() => readInventory(company, true))
  const parsed = z.array(WorkableJobSchema).safeParse(inventory)
  if (!parsed.success) throw new BoardFetchError('Workable 공고의 본문이나 근무 조건 형식을 확인하지 못했어요.')
  return includedJobs(
    parsed.data.map(job => normalizeWorkableJob(job, company.id, fetchedAt)), parsed.data.length,
    parsed.data.map(job => `workable-${company.id}-${job.shortcode}`),
  )
}

export async function fetchWorkablePresence(company: Company) {
  const listed = await readInventory(company, false)
  return {
    total: listed.length,
    publishedIds: listed.map(job => `workable-${company.id}-${job.shortcode}`),
  }
}
