import type { Company } from '../../shared/types'
import { BoardFetchError } from '../catalog-service'
import { normalizeJob } from '../normalize'
import type { GreenhouseJob } from '../normalize'
import { BOARD_TIMEOUT, MAX_POSTINGS, assertUniquePostingIds, fetchBoardJson, includedJobs, readBoardInventory } from './http'

async function readListings(company: Company, content: boolean) {
  return readBoardInventory(async () => {
    const query = content ? 'content=true&pay_transparency=true' : 'content=false'
    const payload = await fetchBoardJson(`https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(company.board!)}/jobs?${query}`, AbortSignal.timeout(BOARD_TIMEOUT)) as { jobs?: GreenhouseJob[]; meta?: { total?: number } }
    if (!payload || !Array.isArray(payload.jobs) || payload.jobs.length > MAX_POSTINGS) throw new BoardFetchError('예상하지 못한 게시판 응답')
    if (payload.meta?.total !== undefined && (!Number.isSafeInteger(payload.meta.total) || payload.meta.total !== payload.jobs.length)) {
      throw new BoardFetchError('게시판의 전체 공고를 확인하지 못했어요.')
    }
    if (payload.jobs.some(job => !job || !Number.isSafeInteger(job.id) || job.id <= 0
      || typeof job.title !== 'string' || !job.title.trim() || typeof job.absolute_url !== 'string' || !/^https:\/\//i.test(job.absolute_url))) {
      throw new BoardFetchError('공고의 필수 정보가 누락된 게시판 응답')
    }
    const jobs = payload.jobs
    assertUniquePostingIds(jobs)
    return jobs
  })
}

export async function fetchGreenhousePresence(company: Company) {
  const jobs = await readListings(company, false)
  return { total: jobs.length, publishedIds: jobs.map(job => `greenhouse-${company.id}-${job.id}`) }
}

export async function fetchGreenhouseBoard(company: Company, fetchedAt: string) {
  const jobs = await readListings(company, true)
  return includedJobs(jobs.map(job => normalizeJob(job, company.id, fetchedAt)), jobs.length, jobs.map(job => `greenhouse-${company.id}-${job.id}`))
}
