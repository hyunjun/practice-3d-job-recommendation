import { parseTextCompensation } from '../../shared/pay-text'
import type { Job } from '../../shared/types'
import { BoardFetchError } from '../catalog-service'
import { employmentFact, workModeFact } from '../job-facts'
import { normalizePosting, plainText, postingCities, postingLocationLabel, postingRemoteScope } from '../normalize'
import type { PostingLocation } from '../normalize'

export type CareerRequest = (url: string, signal: AbortSignal) => Promise<unknown>

export interface CareerPosting {
  id: string
  title: string
  description: string
  url: string
  locations: PostingLocation[]
  departments: string[]
  employment?: string | null
  workMode?: string | string[] | null
  updatedAt?: string | null
}

export function careerTimestamp(value?: string | null): string | null {
  if (!value) return null
  const time = Date.parse(value)
  if (!Number.isFinite(time)) throw new BoardFetchError('공고의 수정 시각을 확인하지 못했어요.')
  return new Date(time).toISOString()
}

export function normalizeCareerPosting(raw: CareerPosting, companyId: string, fetchedAt: string): Job | null {
  const text = plainText(raw.description)
  const mode = workModeFact(raw.locations.map(location => location.label).join(' · '),
    [{ name: 'workplaceType', value: raw.workMode }], text)
  return normalizePosting({
    provider: 'careers', id: raw.id, companyId, title: raw.title, text, url: raw.url, fetchedAt,
    updatedAt: careerTimestamp(raw.updatedAt), departments: raw.departments, locations: raw.locations,
    cityIds: mode.value === 'remote' ? [] : postingCities(raw.locations),
    locationLabel: postingLocationLabel(raw.locations, mode.value), workMode: mode,
    employment: employmentFact(raw.title, [{ name: 'employmentType', value: raw.employment }], text),
    ...(mode.value === 'remote' ? { scope: postingRemoteScope(raw.locations) } : {}),
    ...parseTextCompensation(text),
  })
}
