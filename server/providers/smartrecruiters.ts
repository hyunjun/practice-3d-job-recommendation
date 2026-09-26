import { z } from 'zod'
import { normalizeCompensation } from '../../shared/compensation'
import { needsOccupationDescription } from '../../shared/job-occupation'
import { qualificationSection } from '../../shared/job-qualifications'
import { parseTextCompensation } from '../../shared/pay-text'
import type { Company, Job, WorkMode } from '../../shared/types'
import { BoardFetchError } from '../catalog-service'
import { employmentFact, managementFact, workModeFact } from '../job-facts'
import type { Fact } from '../job-facts'
import { normalizePosting, plainText, postingCities, postingLocationLabel, postingRemoteScope } from '../normalize'
import type { PostingLocation } from '../normalize'
import { MAX_POSTINGS, includedJobs } from './http'
import { createBoardRequestQueue } from './request-queue'

const PAGE_SIZE = 100
export const SMARTRECRUITERS_POLICY = { concurrency: 4, interval: 200, timeout: 120_000 } as const
const Label = z.object({ label: z.string().nullish() })
const Location = z.object({
  city: z.string().nullish(), region: z.string().nullish(), country: z.string().nullish(),
  fullLocation: z.string().nullish(), remote: z.boolean().nullish(), hybrid: z.boolean().nullish(),
})
const PostingSummary = z.object({
  id: z.string().min(1).max(200), name: z.string().min(1).max(1000),
  company: z.object({ identifier: z.string().min(1) }),
  visibility: z.enum(['PUBLIC', 'INTERNAL']),
  releasedDate: z.iso.datetime({ offset: true }),
  uuid: z.string().optional(), jobAdId: z.string().optional(),
  location: Location.nullish(), department: Label.nullish(), function: Label.nullish(),
  typeOfEmployment: Label.nullish(),
  customField: z.array(z.object({
    fieldLabel: z.string().optional(), valueLabel: z.string().optional(),
  })).max(200).optional(),
})
const Section = z.object({ title: z.string().nullish(), text: z.string().nullish() })
export const SmartRecruitersJobSchema = PostingSummary.extend({
  active: z.boolean(),
  postingUrl: z.url().startsWith('https://').max(2000),
  jobAd: z.object({ sections: z.object({
    companyDescription: Section.nullish(), jobDescription: Section.nullish(),
    qualifications: Section.nullish(), additionalInformation: Section.nullish(),
  }) }),
  compensation: z.object({
    min: z.number().nullish(), max: z.number().nullish(), currency: z.string().nullish(), period: z.string().nullish(),
  }).nullish(),
})
export type SmartRecruitersJob = z.infer<typeof SmartRecruitersJobSchema>
const Page = z.object({
  offset: z.number().int().nonnegative(), limit: z.number().int().positive().max(PAGE_SIZE),
  totalFound: z.number().int().nonnegative().max(MAX_POSTINGS),
  content: z.array(PostingSummary).max(PAGE_SIZE),
})

function locationOf(raw: SmartRecruitersJob['location']): PostingLocation {
  return {
    label: raw?.fullLocation?.trim() || [raw?.city, raw?.region, raw?.country?.toUpperCase()].filter(Boolean).join(', '),
    address: { addressLocality: raw?.city, addressRegion: raw?.region, addressCountry: raw?.country },
  }
}

function workMode(raw: SmartRecruitersJob['location'], label: string, text: string): Fact<WorkMode> {
  const remote = raw?.remote
  const hybrid = raw?.hybrid
  const declared = [typeof remote === 'boolean' ? `location.remote: ${remote}` : '', typeof hybrid === 'boolean' ? `location.hybrid: ${hybrid}` : ''].filter(Boolean).join('\n')
  const evidence = { source: 'board' as const, text: declared }
  if (remote === true && hybrid === true) return { value: 'unknown', evidence }
  if (hybrid === true) return { value: 'hybrid', evidence }
  if (remote === true) return { value: 'remote', evidence }
  if (remote === false && hybrid === false) return { value: 'onsite', evidence }
  const inferred = workModeFact(label, [], text)
  if (remote === false && inferred.value === 'remote' || hybrid === false && inferred.value === 'hybrid') {
    return { value: 'unknown', evidence }
  }
  return inferred
}

export function normalizeSmartRecruitersJob(raw: SmartRecruitersJob, companyId: string, fetchedAt: string): Job | null {
  if (!raw.active || raw.visibility !== 'PUBLIC') return null
  const sections = raw.jobAd.sections
  const qualificationTitle = plainText(sections.qualifications?.title ?? '')
  const qualificationKind = qualificationSection(qualificationTitle)
  // API section keys separate the company introduction from actual duties.
  // Keep a publisher's explicit required/preferred qualifications heading.
  const text = ([
    ['About the company', sections.companyDescription],
    ['Responsibilities', sections.jobDescription],
    [qualificationKind && ['required', 'qualification', 'preferred'].includes(qualificationKind) ? qualificationTitle : 'Qualifications', sections.qualifications],
    ['Additional considerations', sections.additionalInformation],
  ] as const).flatMap(([heading, section]) => {
    const body = plainText(section?.text ?? '')
    return body ? [`${heading}\n${body}`] : []
  }).join('\n\n')
  const location = locationOf(raw.location)
  const mode = workMode(raw.location, location.label, text)
  const metadata = (raw.customField ?? []).map(field => ({ name: field.fieldLabel, value: field.valueLabel }))
  const departments = [
    raw.department?.label, raw.function?.label,
    ...(raw.customField ?? []).filter(field => /^(?:department(?:[\s_-]*name)?|team|job[\s_-]*family|specialty|subspecialty)$/i.test(field.fieldLabel ?? '')).map(field => field.valueLabel),
  ].filter((value): value is string => typeof value === 'string' && Boolean(value.trim()))
  const compensation = raw.compensation
  const salary = compensation && Object.values(compensation).some(value => value !== null && value !== undefined)
    ? normalizeCompensation([{
      ...compensation, interval: compensation.period, label: '게시판의 보상 범위', basis: 'unknown',
      evidence: { source: 'board', text: `compensation: ${JSON.stringify(compensation)}` },
    }])
    : parseTextCompensation(text)
  return normalizePosting({
    provider: 'smartrecruiters', id: raw.id, companyId, title: raw.name, text,
    url: raw.postingUrl, updatedAt: raw.releasedDate, fetchedAt,
    departments, management: managementFact(metadata),
    cityIds: mode.value === 'remote' ? [] : postingCities([location]),
    locationLabel: postingLocationLabel([location], mode.value), workMode: mode,
    locations: [location],
    // SmartRecruiters' internal id "permanent" can have the public label "Full-time".
    employment: employmentFact(raw.name, [{ name: 'employmentType', value: raw.typeOfEmployment?.label }], text),
    ...(mode.value === 'remote' ? { scope: postingRemoteScope([location]) } : {}), ...salary,
  })
}

export function createSmartRecruitersFetcher(policy: { concurrency: number; interval: number; timeout: number } = SMARTRECRUITERS_POLICY) {
  const request = createBoardRequestQueue(policy)
  return async (company: Company, fetchedAt: string) => {
    if (!company.board) throw new BoardFetchError('SmartRecruiters 게시판 이름을 확인하지 못했어요.')
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new BoardFetchError('게시판의 전체 공고를 확인하는 시간이 초과됐어요.')), policy.timeout)
    const base = `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(company.board)}/postings`
    const postings = new Map<string, z.infer<typeof PostingSummary>>()
    let total: number | undefined
    try {
      for (let offset = 0; offset <= MAX_POSTINGS; offset += PAGE_SIZE) {
        const parsed = Page.safeParse(await request(`${base}?limit=${PAGE_SIZE}&offset=${offset}&destination=PUBLIC`, controller.signal))
        if (!parsed.success) throw new BoardFetchError('SmartRecruiters 게시판의 목록 형식을 확인하지 못했어요.')
        const page = parsed.data
        if (page.offset !== offset || page.limit !== PAGE_SIZE || total !== undefined && page.totalFound !== total
          || page.content.length !== Math.min(PAGE_SIZE, page.totalFound - offset)) {
          throw new BoardFetchError('게시판의 전체 공고 목록이 일치하지 않아요. 잠시 후 다시 확인해 주세요.')
        }
        total = page.totalFound
        for (const posting of page.content) {
          if (posting.company.identifier !== company.board || posting.visibility !== 'PUBLIC' || postings.has(posting.id)) {
            throw new BoardFetchError('공개 공고의 회사·게시 상태 또는 목록이 일치하지 않아요.')
          }
          postings.set(posting.id, posting)
        }
        if (postings.size === total) break
      }
      if (postings.size !== total) throw new BoardFetchError('게시판의 전체 공고를 확인하지 못했어요.')
      const candidates = [...postings.values()].filter(posting => needsOccupationDescription(posting.name))
      const jobs: (Job | null)[] = new Array(candidates.length)
      let cursor = 0
      const workers = Array.from({ length: Math.min(policy.concurrency, candidates.length) }, async () => {
        while (cursor < candidates.length) {
          const index = cursor++
          const summary = candidates[index]
          // Never follow a response's ref/apply URL to fetch data.
          const parsed = SmartRecruitersJobSchema.safeParse(await request(`${base}/${encodeURIComponent(summary.id)}`, controller.signal))
          if (!parsed.success) throw new BoardFetchError('SmartRecruiters 공고의 본문 형식을 확인하지 못했어요.')
          const detail = parsed.data
          if (detail.id !== summary.id || detail.company.identifier !== company.board) {
            throw new BoardFetchError('공고의 회사·ID가 공개 목록과 일치하지 않아요.')
          }
          // A valid detail can explicitly unpublish an entry still in the list.
          // This is authoritative negative evidence, unlike a failed request.
          if (!detail.active || detail.visibility !== 'PUBLIC') {
            postings.delete(detail.id)
            jobs[index] = null
            continue
          }
          if (detail.name !== summary.name
            || Date.parse(detail.releasedDate) !== Date.parse(summary.releasedDate)
            || summary.uuid && detail.uuid !== summary.uuid || summary.jobAdId && detail.jobAdId !== summary.jobAdId) {
            throw new BoardFetchError('조회 중 공고의 내용이나 공개 게시 상태가 바뀌었어요. 다시 확인해 주세요.')
          }
          jobs[index] = normalizeSmartRecruitersJob(detail, company.id, fetchedAt)
        }
      })
      await Promise.all(workers)
      return includedJobs(jobs, postings.size, [...postings.keys()].map(id => `smartrecruiters-${company.id}-${id}`))
    } catch (cause) {
      controller.abort(cause)
      throw cause
    } finally {
      clearTimeout(timer)
    }
  }
}

export const fetchSmartRecruitersBoard = createSmartRecruitersFetcher()
