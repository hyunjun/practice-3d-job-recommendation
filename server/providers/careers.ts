import { isCareerBoard } from '../../shared/career-sources'
import { needsOccupationDescription } from '../../shared/job-occupation'
import type { Company } from '../../shared/types'
import { BoardFetchError } from '../catalog-service'
import type { BoardResult } from '../catalog-service'
import { bookingPosting, readBookingInventory } from './booking'
import { normalizeCareerPosting } from './careers-common'
import type { CareerPosting } from './careers-common'
import { includedJobs, readBoardInventory } from './http'
import { createBoardRequestQueue } from './request-queue'
import { readStarbucksInventory, readStarbucksPosting } from './starbucks'
import { readZalandoInventory, readZalandoPosting } from './zalando'

export const CAREERS_POLICY = { concurrency: 2, interval: 1000, bookingInterval: 5000, starbucksInterval: 10_000, timeout: 900_000 } as const

export function createCareersFetcher(policy: { concurrency: number; interval: number; bookingInterval: number; starbucksInterval?: number; timeout: number } = CAREERS_POLICY) {
  const booking = createBoardRequestQueue({ concurrency: 1, interval: policy.bookingInterval })
  const starbucks = createBoardRequestQueue({ concurrency: 1, interval: policy.starbucksInterval ?? policy.interval })
  const zalando = createBoardRequestQueue({ ...policy, response: 'text' })

  async function collect(company: Company, fetchedAt: string, content: boolean): Promise<BoardResult> {
    if (!company.board || !isCareerBoard(company.board)) throw new BoardFetchError('지원하지 않는 공식 채용 사이트예요.')
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new BoardFetchError('공식 채용 사이트의 수집 시간이 초과됐어요.')), policy.timeout)
    const signal = controller.signal
    try {
      let ids: (string | number)[]
      let postings: CareerPosting[] = []
      if (company.board === 'booking') {
        const listed = await readBoardInventory(() => readBookingInventory(booking, signal))
        ids = listed.map(job => job.req_id)
        if (content) postings = listed.map(bookingPosting)
      } else if (company.board === 'starbucks-technology') {
        const listed = await readBoardInventory(() => readStarbucksInventory(starbucks, signal))
        ids = listed.map(job => job.id)
        if (content) postings = await details(listed.filter(job => needsOccupationDescription(job.name)),
          job => readStarbucksPosting(job, (url, signal) => starbucks(url, signal, 'text'), signal))
      } else {
        const listed = await readBoardInventory(() => readZalandoInventory(zalando, signal))
        ids = listed.map(job => job.id)
        if (content) postings = await details(listed.filter(job => needsOccupationDescription(job.title)),
          job => readZalandoPosting(job, zalando, signal))
      }
      return includedJobs(postings.map(posting => normalizeCareerPosting(posting, company.id, fetchedAt)),
        ids.length, ids.map(id => `careers-${company.id}-${id}`))
    } finally {
      clearTimeout(timer)
      controller.abort()
    }
  }

  async function details<T>(items: T[], read: (item: T) => Promise<CareerPosting>): Promise<CareerPosting[]> {
    const result: CareerPosting[] = new Array(items.length)
    let cursor = 0
    await Promise.all(Array.from({ length: Math.min(policy.concurrency, items.length) }, async () => {
      while (cursor < items.length) {
        const index = cursor++
        result[index] = await read(items[index])
      }
    }))
    return result
  }

  return {
    fetchBoard: (company: Company, fetchedAt: string) => collect(company, fetchedAt, true),
    fetchPresence: async (company: Company) => {
      const result = await collect(company, '', false)
      return { total: result.total, publishedIds: result.publishedIds! }
    },
  }
}

const fetcher = createCareersFetcher()
export const fetchCareersBoard = fetcher.fetchBoard
export const fetchCareersPresence = fetcher.fetchPresence
