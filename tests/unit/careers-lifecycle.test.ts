import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createFileBoardCache } from '../../server/board-cache'
import { BoardFetchError, createCatalogService } from '../../server/catalog-service'
import { createFilePresenceCache, presenceCacheFile } from '../../server/posting-presence'
import type { Company } from '../../shared/types'
import { CAREERS_NOW, careersCachedJob, careersCompany } from '../fixtures/careers-contract'

const privateRoot = fileURLToPath(new URL('../../.local/research/64-expansion/independent/lifecycle-scratch/', import.meta.url))
const directories: string[] = []
let now: number

beforeEach(() => {
  now = Date.parse(CAREERS_NOW)
  vi.spyOn(Date, 'now').mockImplementation(() => now)
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('Careers lifecycle tests must not contact any provider') }))
})
afterEach(async () => {
  try { expect(vi.mocked(fetch)).not.toHaveBeenCalled() }
  finally {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
  }
})

async function lifecycle() {
  await mkdir(privateRoot, { recursive: true })
  const directory = await mkdtemp(path.join(privateRoot, 'run-'))
  directories.push(directory)
  const companies: Company[] = [
    careersCompany('booking'),
    {
      id: 'synthetic-control64', name: 'Synthetic Control64', provider: 'greenhouse', board: 'synthetic-control64',
      careerUrl: 'https://example.com/synthetic/stage64/control', initials: '64', color: '#83d1c7',
      industry: 'Synthetic regression control',
    },
  ]
  const files = { full: path.join(directory, 'board-cache.json'), presence: '' }
  files.presence = presenceCacheFile(files.full)
  const fullCalls: { companyId: string; at: string }[] = []
  const listCalls: { companyId: string; at: string }[] = []
  const failures = new Map<'full' | 'list', BoardFetchError>()
  let revised = false
  function service() {
    return createCatalogService({
      companies,
      cache: createFileBoardCache(files.full, [], companies),
      fetchBoard: async (company, at) => {
        fullCalls.push({ companyId: company.id, at })
        if (company.id !== 'booking') return { jobs: [], total: 0, publishedIds: [], unmappedCount: 0 }
        if (failures.has('full')) throw failures.get('full')
        return {
          jobs: [careersCachedJob(at, revised)], total: 2, unmappedCount: 0,
          publishedIds: ['careers-booking-6400001', 'careers-booking-6400002'],
        }
      },
      presence: {
        cache: createFilePresenceCache(files.presence),
        fetchBoard: async (company, at) => {
          listCalls.push({ companyId: company.id, at })
          if (company.id !== 'booking') return { total: 0, publishedIds: [] }
          if (failures.has('list')) throw failures.get('list')
          return { total: 2, publishedIds: ['careers-booking-6400001', 'careers-booking-6400002'] }
        },
      },
      now: () => now, random: () => 0,
    })
  }
  return {
    service, files, failures, fullCalls, listCalls,
    revise: () => { revised = true },
    bodyReads: () => fullCalls.filter(call => call.companyId === 'booking'),
    listReads: () => listCalls.filter(call => call.companyId === 'booking'),
  }
}

describe('official careers snapshots across reads, failures and file-cache restart', () => {
  it('coalesces the initial read, seeds presence and waits exactly 24h even for forced successful refreshes', async () => {
    const state = await lifecycle()
    const service = state.service()
    const [catalog, , initialIndex] = await Promise.all([
      service.get(), service.get(), service.getPostingStatus(true, true),
    ])
    expect(catalog.jobs).toMatchObject([{
      id: 'careers-booking-6400001', title: 'Backend Engineer — Synthetic Canal API64',
      fetchedAt: '2026-10-02T10:00:00.000Z',
    }])
    expect(initialIndex.boards.find(board => board.companyId === 'booking')!.listing).toMatchObject({
      validUntil: '2026-10-03T10:00:00.000Z',
      content: { checkedAt: '2026-10-02T10:00:00.000Z', validUntil: '2026-10-03T10:00:00.000Z' },
    })
    expect(state.bodyReads()).toEqual([{ companyId: 'booking', at: '2026-10-02T10:00:00.000Z' }])
    expect(state.listReads()).toEqual([])

    for (const time of [
      '2026-10-02T10:01:00.000Z', '2026-10-02T10:30:00.000Z', '2026-10-03T09:59:59.999Z',
    ]) {
      now = Date.parse(time)
      const visible = await service.get(true)
      await service.getPostingStatus(true)
      await service.getPostingStatus(true, true)
      expect(visible.jobs[0].fetchedAt).toBe('2026-10-02T10:00:00.000Z')
      expect(visible.boards.find(board => board.companyId === 'booking')!.dataStatus).toBe('fresh')
      expect(state.bodyReads()).toEqual([{ companyId: 'booking', at: '2026-10-02T10:00:00.000Z' }])
      expect(state.listReads()).toEqual([])
    }

    now = Date.parse('2026-10-03T10:00:00.000Z')
    const [, next] = await Promise.all([service.get(true), service.getPostingStatus(true, true)])
    expect(state.bodyReads()).toEqual([
      { companyId: 'booking', at: '2026-10-02T10:00:00.000Z' },
      { companyId: 'booking', at: '2026-10-03T10:00:00.000Z' },
    ])
    expect(state.listReads()).toEqual([])
    expect(next.boards.find(board => board.companyId === 'booking')!.listing).toMatchObject({
      validUntil: '2026-10-04T10:00:00.000Z',
      content: { checkedAt: '2026-10-03T10:00:00.000Z', validUntil: '2026-10-04T10:00:00.000Z' },
    })
    const bytes = await readFile(state.files.full, 'utf8')
    const calls = structuredClone(state.fullCalls)
    expect((await state.service().getPostingStatus(true, true)).boards).toEqual(next.boards)
    expect(await readFile(state.files.full, 'utf8')).toBe(bytes)
    expect(state.fullCalls).toEqual(calls)
    expect(state.listReads()).toEqual([])
  })

  it('does not renew saved body evidence on a successful daily list or let that list delay a due body read', async () => {
    const state = await lifecycle()
    const service = state.service()
    await service.get()
    const originalBytes = await readFile(state.files.full, 'utf8')
    state.revise()
    now = Date.parse('2026-10-03T10:00:00.000Z')
    const listed = await service.getPostingStatus(true)
    expect(state.listReads()).toEqual([{ companyId: 'booking', at: '2026-10-03T10:00:00.000Z' }])
    expect(state.bodyReads()).toEqual([{ companyId: 'booking', at: '2026-10-02T10:00:00.000Z' }])
    expect(listed.boards.find(board => board.companyId === 'booking')!.listing).toMatchObject({
      validUntil: '2026-10-04T10:00:00.000Z',
      publishedIds: ['careers-booking-6400001', 'careers-booking-6400002'], jobs: [],
      content: { checkedAt: '2026-10-02T10:00:00.000Z', validUntil: '2026-10-03T10:00:00.000Z' },
    })
    expect(await readFile(state.files.full, 'utf8')).toBe(originalBytes)

    now = Date.parse('2026-10-03T10:00:00.001Z')
    const [first, second] = await Promise.all([
      service.getPostingStatus(true, true), service.getPostingStatus(true, true),
    ])
    expect(second).toEqual(first)
    expect(first.boards.find(board => board.companyId === 'booking')!.listing).toMatchObject({
      jobs: [{
        id: 'careers-booking-6400001', title: 'Backend Engineer — Synthetic Canal API64 Revised',
        url: 'https://jobs.booking.com/booking/jobs/6400001?lang=en-us',
      }],
      content: { checkedAt: '2026-10-03T10:00:00.001Z', validUntil: '2026-10-04T10:00:00.001Z' },
    })
    expect(state.bodyReads()).toEqual([
      { companyId: 'booking', at: '2026-10-02T10:00:00.000Z' },
      { companyId: 'booking', at: '2026-10-03T10:00:00.001Z' },
    ])
    expect(state.listReads()).toHaveLength(1)
    const bytes = await readFile(state.files.full, 'utf8')
    expect((await state.service().getPostingStatus(true, true)).boards).toEqual(first.boards)
    expect(await readFile(state.files.full, 'utf8')).toBe(bytes)
    expect(state.bodyReads()).toHaveLength(2)
    expect(state.listReads()).toHaveLength(1)
  })

  it('persists one-minute, exponential and Retry-After failures without imposing the success-only daily cooldown', async () => {
    const state = await lifecycle()
    state.failures.set('full', new BoardFetchError('Synthetic official API failure64'))
    let service = state.service()
    const first = await service.get()
    expect(first.jobs).toEqual([])
    expect(first.boards.find(board => board.companyId === 'booking')).toMatchObject({
      status: 'error', dataStatus: 'unavailable', lastSuccessAt: null, retryAt: '2026-10-02T10:01:00.000Z',
    })
    now = Date.parse('2026-10-02T10:00:59.999Z')
    await service.get(true)
    expect(state.bodyReads()).toHaveLength(1)
    now = Date.parse('2026-10-02T10:01:00.000Z')
    expect((await service.get()).boards.find(board => board.companyId === 'booking')!.retryAt)
      .toBe('2026-10-02T10:03:00.000Z')

    service = state.service()
    now = Date.parse('2026-10-02T10:02:59.999Z')
    await service.get()
    expect(state.bodyReads()).toHaveLength(2)
    state.failures.set('full', new BoardFetchError('Synthetic official Retry-After64', Date.parse('2026-10-02T10:10:00.000Z')))
    now = Date.parse('2026-10-02T10:03:00.000Z')
    expect((await service.get()).boards.find(board => board.companyId === 'booking')!.retryAt)
      .toBe('2026-10-02T10:10:00.000Z')
    const failedBytes = await readFile(state.files.full, 'utf8')
    now = Date.parse('2026-10-02T10:09:59.999Z')
    await state.service().get()
    expect(await readFile(state.files.full, 'utf8')).toBe(failedBytes)
    expect(state.bodyReads()).toHaveLength(3)
    state.failures.delete('full')
    now = Date.parse('2026-10-02T10:10:00.000Z')
    const recovered = await state.service().get()
    expect(recovered.jobs).toMatchObject([{
      id: 'careers-booking-6400001', fetchedAt: '2026-10-02T10:10:00.000Z',
    }])
    expect(state.bodyReads()).toEqual([
      { companyId: 'booking', at: '2026-10-02T10:00:00.000Z' },
      { companyId: 'booking', at: '2026-10-02T10:01:00.000Z' },
      { companyId: 'booking', at: '2026-10-02T10:03:00.000Z' },
      { companyId: 'booking', at: '2026-10-02T10:10:00.000Z' },
    ])
  })

  it('retains the last successful body at exactly 24h after failure and removes it 1ms later across restart', async () => {
    const state = await lifecycle()
    const service = state.service()
    await service.get()
    state.failures.set('full', new BoardFetchError('Synthetic daily detail failure64'))
    now = Date.parse('2026-10-03T10:00:00.000Z')
    const edge = await service.get()
    expect(edge.jobs).toMatchObject([{
      id: 'careers-booking-6400001', fetchedAt: '2026-10-02T10:00:00.000Z', stale: true,
    }])
    expect(edge.boards.find(board => board.companyId === 'booking')).toMatchObject({
      status: 'error', dataStatus: 'stale', total: 2, included: 1, lastSuccessAt: '2026-10-02T10:00:00.000Z',
    })
    now = Date.parse('2026-10-03T10:00:00.001Z')
    const expired = await state.service().get()
    expect(expired.jobs).toEqual([])
    expect(expired.boards.find(board => board.companyId === 'booking')).toMatchObject({
      status: 'error', dataStatus: 'unavailable', lastSuccessAt: '2026-10-02T10:00:00.000Z',
    })
    const persisted = JSON.parse(await readFile(state.files.full, 'utf8'))
    expect(persisted.boards.find((board: { companyId: string }) => board.companyId === 'booking').snapshot.fetchedAt)
      .toBe('2026-10-02T10:00:00.000Z')
    expect(state.bodyReads()).toEqual([
      { companyId: 'booking', at: '2026-10-02T10:00:00.000Z' },
      { companyId: 'booking', at: '2026-10-03T10:00:00.000Z' },
    ])
  })
})
