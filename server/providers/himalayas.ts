import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { Company, Job } from '../../shared/types'
import { normalizeCompensation } from '../../shared/compensation'
import { parseTextCompensation } from '../../shared/pay-text'
import { countryCode } from '../../shared/countries'
import { BoardFetchError } from '../catalog-service'
import { employmentFact, workModeFact } from '../job-facts'
import { normalizePosting, plainText } from '../normalize'
import { assertUniquePostingIds, includedJobs, readBoardInventory } from './http'
import { createBoardRequestQueue } from './request-queue'

const MAX_PAGES = 100
const MAX_SEARCH_POSTINGS = 2000
const SEARCH_TIMEOUT = 120_000
const request = createBoardRequestQueue({ concurrency: 2, interval: 1000 })
const HttpsUrl = z.url().max(2000).refine(value => {
  const url = new URL(value)
  return url.protocol === 'https:' && !url.username && !url.password
})
const timestamp = (value: number) => value < 1_000_000_000_000 ? value * 1000 : value
// Live responses use Unix seconds; the published OpenAPI also describes milliseconds.
const Timestamp = z.number().int().positive().refine(value => Number.isFinite(new Date(timestamp(value)).getTime()))
const Identity = z.object({
  guid: HttpsUrl, companySlug: z.string().min(1).max(200),
  title: z.string().trim().min(1).max(1000), expiryDate: Timestamp,
}).passthrough()
const Country = z.union([
  z.string().trim().min(1).max(1000),
  z.object({ alpha2: z.string().regex(/^[a-z]{2}$/i), name: z.string().trim().min(1).max(1000) }),
])
export const HimalayasJobSchema = Identity.extend({
  description: z.string().min(1).max(200_000),
  applicationLink: HttpsUrl.nullish(),
  employmentType: z.string().max(200).nullish(),
  locationRestrictions: z.array(Country).max(300),
  timezoneRestrictions: z.array(z.union([
    z.number().min(-12).max(14), z.string().trim().min(1).max(100),
  ])).max(300),
  minSalary: z.number().finite().nonnegative().nullish(),
  maxSalary: z.number().finite().nonnegative().nullish(),
  currency: z.string().max(100).nullish(),
  salaryPeriod: z.string().max(100).nullish(),
  pubDate: Timestamp,
})
export type HimalayasJob = z.infer<typeof HimalayasJobSchema>
const Page = z.object({
  offset: z.number().int().nonnegative(), limit: z.number().int().min(1).max(20),
  totalCount: z.number().int().nonnegative().max(MAX_SEARCH_POSTINGS),
  jobs: z.array(Identity).max(20),
})

function guidId(guid: string): string {
  return createHash('sha256').update(guid).digest('hex')
}

function belongsToCompany(guid: string, slug: string): boolean {
  const url = new URL(guid)
  const prefix = `/companies/${encodeURIComponent(slug)}/jobs/`
  return url.origin === 'https://himalayas.app' && url.pathname.startsWith(prefix)
    && url.pathname.length > prefix.length && !url.search && !url.hash
}

async function readInventory(company: Company) {
  if (!company.board || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(company.board)) {
    throw new BoardFetchError('Himalayas의 회사 슬러그를 확인해 주세요.')
  }
  const signal = AbortSignal.timeout(SEARCH_TIMEOUT)
  const jobs: z.infer<typeof Identity>[] = []
  let total: number | undefined
  let limit: number | undefined
  for (let page = 1; page <= MAX_PAGES; page++) {
    const url = `https://himalayas.app/jobs/api/search?company=${encodeURIComponent(company.board)}&sort=recent&page=${page}`
    const parsed = Page.safeParse(await request(url, signal))
    if (!parsed.success) throw new BoardFetchError('Himalayas의 전체 공고 목록 형식을 확인하지 못했어요.')
    const data = parsed.data
    total ??= data.totalCount
    limit ??= data.limit
    if (data.totalCount !== total || data.limit !== limit || data.offset !== (page - 1) * limit
      || total > limit * MAX_PAGES || data.jobs.length !== Math.min(limit, total - data.offset)) {
      throw new BoardFetchError('Himalayas의 전체 공고 목록을 확인하지 못했어요. 일부 응답의 건수나 페이지가 일치하지 않습니다.')
    }
    if (data.jobs.some(job => job.companySlug !== company.board || !belongsToCompany(job.guid, company.board!))) {
      throw new BoardFetchError('Himalayas 응답의 회사와 공고 주소가 요청한 회사와 달라요.')
    }
    jobs.push(...data.jobs)
    assertUniquePostingIds(jobs.map(job => ({ id: job.guid })))
    if (jobs.length === total) return jobs
  }
  throw new BoardFetchError('Himalayas의 전체 목록이 조회 상한을 넘어 일부만 표시하지 않았어요.')
}

function currentJobs<T extends { expiryDate: number }>(jobs: T[], fetchedAt: string): T[] {
  const checked = Date.parse(fetchedAt)
  if (!Number.isFinite(checked)) throw new BoardFetchError('Himalayas의 실제 조회 시각을 확인하지 못했어요.')
  return jobs.filter(job => timestamp(job.expiryDate) > checked)
}

export function normalizeHimalayasJob(raw: HimalayasJob, companyId: string, fetchedAt: string): Job | null {
  const text = plainText(raw.description)
  const countries = raw.locationRestrictions.map(item => typeof item === 'string'
    ? { label: item, code: countryCode(item) }
    : { label: item.name, code: countryCode(item.alpha2) })
  const remoteCountries = [...new Set(countries.flatMap(item => item.code ? [item.code] : []))]
  const remoteWorldwide = !countries.length && !raw.timezoneRestrictions.length
  const sourceEvidence = [
    'Himalayas remote jobs feed',
    `locationRestrictions: ${JSON.stringify(raw.locationRestrictions)}`,
    `timezoneRestrictions: ${JSON.stringify(raw.timezoneRestrictions)}`,
  ].join('\n').slice(0, 3000)
  const statedMode = workModeFact('', [], text)
  const mode = statedMode.value === 'onsite' || statedMode.value === 'hybrid'
    || statedMode.value === 'unknown' && statedMode.evidence ? statedMode
    : { value: 'remote' as const, evidence: { source: 'board' as const, text: sourceEvidence } }
  const countryLabel = countries.map(item => item.label).join(' · ')
  const locationLabel = mode.value === 'remote'
    ? [countryLabel || (remoteWorldwide ? 'Worldwide' : '거주 국가 미확인'), 'Remote',
      ...(raw.timezoneRestrictions.length ? ['시간대 조건 확인'] : [])].join(' · ').slice(0, 1800)
    : '근무지 미확인'
  const bodyPay = parseTextCompensation(text)
  const salary = bodyPay.compensationRanges?.length || bodyPay.compensationEvidence?.length || bodyPay.compensationNote
    ? bodyPay
    : raw.minSalary != null || raw.maxSalary != null ? normalizeCompensation([{
      label: 'Himalayas 급여 정보', min: raw.minSalary, max: raw.maxSalary,
      currency: raw.currency, interval: raw.salaryPeriod, basis: 'unknown',
      evidence: { source: 'board', text: [
        'Himalayas', raw.currency, `${raw.minSalary ?? '미확인'}–${raw.maxSalary ?? '미확인'}`,
        raw.salaryPeriod ?? '지급 기간 미확인', '기본급·총보상 구분 미확인',
      ].join(' · ') },
    }]) : bodyPay
  return normalizePosting({
    provider: 'himalayas', id: guidId(raw.guid), companyId, title: raw.title,
    // Keep the canonical source backlink even if applicationLink redirects elsewhere.
    text, url: raw.guid, fetchedAt,
    // pubDate is publication, not a content revision. updatedAt is a feed field.
    updatedAt: null,
    // API countries/timezones restrict candidates; they are never office locations.
    cityIds: [], locations: [], locationLabel, workMode: mode,
    employment: employmentFact(raw.title, [{ name: 'employmentType', value: raw.employmentType }], text),
    ...(mode.value === 'remote' ? { scope: {
      remoteCountries, remoteWorldwide,
      remoteScopeUnknown: countries.some(item => !item.code) || !remoteWorldwide && !remoteCountries.length,
    } } : {}),
    ...salary,
  })
}

export async function fetchHimalayasBoard(company: Company, fetchedAt: string) {
  const inventory = await readBoardInventory(() => readInventory(company))
  const parsed = z.array(HimalayasJobSchema).safeParse(currentJobs(inventory, fetchedAt))
  // A valid inventory with an unreadable description is a body failure.
  if (!parsed.success) throw new BoardFetchError('Himalayas 공고의 본문이나 조건 형식을 확인하지 못했어요.')
  return includedJobs(
    parsed.data.map(job => normalizeHimalayasJob(job, company.id, fetchedAt)), parsed.data.length,
    parsed.data.map(job => `himalayas-${company.id}-${guidId(job.guid)}`),
  )
}

export async function fetchHimalayasPresence(company: Company, fetchedAt: string) {
  // The public search response includes bodies, but this path only validates IDs.
  const listed = currentJobs(await readInventory(company), fetchedAt)
  return {
    total: listed.length,
    publishedIds: listed.map(job => `himalayas-${company.id}-${guidId(job.guid)}`),
  }
}
