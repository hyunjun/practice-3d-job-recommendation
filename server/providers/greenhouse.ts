import type { Company } from '../../shared/types'
import { BoardFetchError } from '../catalog-service'
import { normalizeJob } from '../normalize'
import type { GreenhouseJob } from '../normalize'
import { BOARD_TIMEOUT, MAX_POSTINGS, fetchBoardJson, includedJobs } from './http'

export async function fetchGreenhouseBoard(company: Company, fetchedAt: string) {
  const payload = await fetchBoardJson(`https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(company.board!)}/jobs?content=true&pay_transparency=true`, AbortSignal.timeout(BOARD_TIMEOUT)) as { jobs?: GreenhouseJob[] }
  if (!payload || !Array.isArray(payload.jobs) || payload.jobs.length > MAX_POSTINGS) throw new BoardFetchError('예상하지 못한 게시판 응답')
  if (payload.jobs.some(job => !job || !Number.isSafeInteger(job.id) || job.id <= 0
    || typeof job.title !== 'string' || !job.title.trim() || typeof job.absolute_url !== 'string' || !/^https:\/\//i.test(job.absolute_url))) {
    throw new BoardFetchError('공고의 필수 정보가 누락된 게시판 응답')
  }
  return includedJobs(payload.jobs.map(job => normalizeJob(job, company.id, fetchedAt)), payload.jobs.length)
}
