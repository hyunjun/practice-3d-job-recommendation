import { z } from 'zod'
import type { Company, Job } from '../../shared/types'
import { BoardFetchError } from '../catalog-service'
import { normalizeCompensation } from '../compensation'
import { employmentFact, workModeFact } from '../job-facts'
import type { Fact } from '../job-facts'
import type { WorkMode } from '../../shared/types'
import { normalizePosting, parseSalary, plainText, postingCities, postingLocationLabel, postingRemoteScope } from '../normalize'
import type { PostingLocation } from '../normalize'
import { BOARD_TIMEOUT, MAX_POSTINGS, fetchBoardJson, includedJobs } from './http'

const PostalAddress = z.object({
  addressLocality: z.string().nullish(), addressRegion: z.string().nullish(), addressCountry: z.string().nullish(),
})
// The documented secondary-location example is flat; actual boards also return postalAddress.
const Address = z.union([z.object({ postalAddress: PostalAddress.nullable() }), PostalAddress])
const Component = z.object({
  compensationType: z.string().nullish(), currencyCode: z.string().nullish(), interval: z.string().nullish(),
  minValue: z.number().nullish(), maxValue: z.number().nullish(),
})
export const AshbyJobSchema = z.object({
  id: z.string().min(1), title: z.string().min(1), jobUrl: z.url().startsWith('https://'), isListed: z.boolean(),
  location: z.string().nullish(), address: Address.nullish(),
  secondaryLocations: z.array(z.object({ location: z.string().nullish(), address: Address.nullish() })).nullish(),
  workplaceType: z.string().nullish(), isRemote: z.boolean().nullish(), employmentType: z.string().nullish(),
  descriptionPlain: z.string().nullish(), descriptionHtml: z.string().nullish(),
  shouldDisplayCompensationOnJobPostings: z.boolean().nullish(),
  compensation: z.object({
    compensationTiers: z.array(z.object({ title: z.string().nullish(), components: z.array(Component) })).nullish(),
    summaryComponents: z.array(Component).nullish(),
  }).nullish(),
})
export type AshbyJob = z.infer<typeof AshbyJobSchema>
const Feed = z.object({ apiVersion: z.literal('1'), jobs: z.array(AshbyJobSchema).max(MAX_POSTINGS) })

function locationOf(label?: string | null, address?: z.infer<typeof Address> | null): PostingLocation {
  return { label: label?.trim() ?? '', address: address && 'postalAddress' in address ? address.postalAddress : address as PostingLocation['address'] }
}

export function normalizeAshbyJob(raw: AshbyJob, companyId: string, fetchedAt: string): Job | null {
  if (!raw.isListed) return null
  const text = raw.descriptionPlain?.trim() || plainText(raw.descriptionHtml ?? '')
  const locations = [locationOf(raw.location, raw.address), ...(raw.secondaryLocations ?? []).map(item => locationOf(item.location, item.address))]
  const declaredMode = workModeFact('', [{ name: 'workplaceType', value: raw.workplaceType }], '')
  let mode: Fact<WorkMode> = declaredMode.value !== 'unknown' ? declaredMode : raw.isRemote === true
    ? { value: 'remote', evidence: { source: 'board', text: 'isRemote: true' } }
    : workModeFact(raw.location ?? '', [], text)
  if (declaredMode.value === 'unknown' && raw.isRemote === false && mode.value === 'remote') {
    mode = { value: 'unknown', evidence: { source: 'board', text: `isRemote: false\nlocation: ${raw.location ?? ''}` } }
  }
  const cities = postingCities(locations)
  const employment = employmentFact(raw.title, [{ name: 'employmentType', value: raw.employmentType }], text)
  const compensation = raw.shouldDisplayCompensationOnJobPostings === false ? undefined : raw.compensation
  const tiers = compensation?.compensationTiers ?? []
  const components = tiers.length
    ? tiers.flatMap((tier, index) => tier.components.filter(item => item.compensationType === 'Salary').map(item => ({ ...item, label: tier.title || (tiers.length > 1 ? `보상 구간 ${index + 1}` : '기본 급여') })))
    : (compensation?.summaryComponents ?? []).filter(item => item.compensationType === 'Salary').map(item => ({ ...item, label: '기본 급여' }))
  const salary = components.length ? normalizeCompensation(components.map(item => ({
    label: item.label, min: item.minValue, max: item.maxValue, currency: item.currencyCode, interval: item.interval,
  }))) : { salary: parseSalary(text, cities) }
  return normalizePosting({
    provider: 'ashby', id: raw.id, companyId, title: raw.title, text, url: raw.jobUrl, fetchedAt,
    cityIds: mode.value === 'remote' ? [] : cities, locationLabel: postingLocationLabel(locations, mode.value),
    workMode: mode, employment, ...(mode.value === 'remote' ? { scope: postingRemoteScope(locations) } : {}), ...salary,
  })
}

export async function fetchAshbyBoard(company: Company, fetchedAt: string) {
  const data = Feed.safeParse(await fetchBoardJson(`https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(company.board!)}?includeCompensation=true`, AbortSignal.timeout(BOARD_TIMEOUT)))
  if (!data.success) throw new BoardFetchError('Ashby 게시판의 공고 형식을 확인하지 못했어요.')
  const listed = data.data.jobs.filter(job => job.isListed)
  return includedJobs(listed.map(job => normalizeAshbyJob(job, company.id, fetchedAt)), listed.length)
}
