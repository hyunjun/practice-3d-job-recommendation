import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { mkdir } from 'node:fs/promises'
import { createCatalogService, BoardFetchError, BoardInventoryError } from '../../server/catalog-service'
import type { BoardResult } from '../../server/catalog-service'
import type { CachedBoard } from '../../server/board-cache'
import { createFilePresenceCache, parseCachedPresence, presenceCacheFile } from '../../server/posting-presence'
import type { CachedPresence, PresenceResult } from '../../server/posting-presence'
import { observeSavedPosting, PostingStatusIndexSchema } from '../../shared/posting-status'
import type { Company } from '../../shared/types'
import { PRESENCE_COMPANY, PRESENCE_ORIGINAL_BODY, presenceSaved } from '../fixtures/posting-presence'

const BASE = Date.parse('2026-09-26T03:00:00.000Z')
const ids = ['smartrecruiters-presence-harbour-59001', 'smartrecruiters-presence-harbour-59201']
const privateRoot = path.resolve('.local/research/59/independent/unit-cache')
afterEach(() => { vi.restoreAllMocks() })

function memory<T>(initial: T[] = []) {
  let records = structuredClone(initial)
  return {
    load: vi.fn(async () => structuredClone(records)),
    save: vi.fn(async (next: T[]) => { records = structuredClone(next) }),
    value: () => structuredClone(records),
  }
}
function options() {
  let time = BASE
  const cache = memory<CachedBoard>()
  const presenceCache = memory<CachedPresence>()
  const fetchBoard = vi.fn(async (_company: Company, fetchedAt: string): Promise<BoardResult> => ({
    total: 2, publishedIds: [...ids], unmappedCount: 0,
    verifiedActiveIds: [ids[0]],
    jobs: [{ ...presenceSaved()[0].job, fetchedAt }],
  }))
  const fetchPresence = vi.fn(async (): Promise<PresenceResult> => ({ total: 2, publishedIds: [...ids] }))
  return {
    companies: [PRESENCE_COMPANY], cache, fetchBoard,
    presence: { cache: presenceCache, fetchBoard: fetchPresence }, now: () => time, random: () => 0,
    at: (next: string) => { time = Date.parse(next) },
  }
}
function gate() {
  let release!: () => void
  const promise = new Promise<void>(resolve => { release = resolve })
  return { promise, release }
}
function cachedPresence(): CachedPresence {
  return {
    companyId: 'presence-harbour', provider: 'smartrecruiters', board: 'HarbourPresence59',
    checkedAt: '2026-09-26T03:00:00.000Z', failures: 0, retryAt: null,
    snapshot: { fetchedAt: '2026-09-26T03:00:00.000Z', total: 2, publishedIds: [...ids] },
  }
}

describe('independent cache scope and compatibility', () => {
  it('keeps the complete inventory in a separate derived file without rewriting any full-cache bytes', async () => {
    await mkdir(privateRoot, { recursive: true })
    const directory = await mkdtemp(path.join(privateRoot, 'scoped-'))
    const full = path.join(directory, 'configured-board-cache-v5-fictional.json')
    const original = '{"version":5,"boards":[],"fictionalSentinel":"keep full body cache bytes"}\n'
    await writeFile(full, original)
    const presence = presenceCacheFile(full)
    expect(presence).toBe(path.join(directory, 'configured-board-cache-v5-fictional.presence-v1.json'))
    await createFilePresenceCache(presence).save([cachedPresence()])
    expect(await readFile(full, 'utf8')).toBe(original)
    const raw = JSON.parse(await readFile(presence, 'utf8'))
    expect(raw).toMatchObject({ version: 1, boards: [{ snapshot: { total: 2, publishedIds: [
      'smartrecruiters-presence-harbour-59001', 'smartrecruiters-presence-harbour-59201',
    ] } }] })
    expect(raw.boards[0].snapshot).not.toHaveProperty('jobs')
    expect(await createFilePresenceCache(presence).load()).toEqual([cachedPresence()])
    await writeFile(presence, '{"version":1,"boards":[')
    expect(await createFilePresenceCache(presence).load()).toEqual([])
    expect(await readFile(full, 'utf8')).toBe(original)
  })

  it('does not interpret older full caches or corrupt presence data as a confirmed empty inventory', () => {
    expect(parseCachedPresence({ version: 5, boards: [cachedPresence()] })).toEqual([])
    expect(parseCachedPresence({ version: 2, boards: [cachedPresence()] })).toEqual([])
    expect(parseCachedPresence({ version: 1, boards: [{
      ...cachedPresence(), snapshot: { fetchedAt: '2026-09-26T03:00:00.000Z', total: 1 },
    }] })).toEqual([])
    for (const snapshot of [
      { fetchedAt: '2026-09-26T03:00:00.000Z', total: 3, publishedIds: [...ids] },
      { fetchedAt: '2026-09-26T03:00:00.000Z', total: 2, publishedIds: [ids[0], ids[0]] },
      { fetchedAt: '2026-09-26T03:00:00.000Z', total: 1, publishedIds: ['smartrecruiters-another-board-59001'] },
      { fetchedAt: '2026-09-26T03:00:00.001Z', total: 2, publishedIds: [...ids] },
    ]) {
      expect(parseCachedPresence({ version: 1, boards: [{ ...cachedPresence(), snapshot }] })).toEqual([])
    }
  })

  it('preserves valid negative evidence while rejecting unsupported regions and invented unconfirmed IDs', () => {
    const valid = {
      ...cachedPresence(), unpublishedIds: [ids[0]],
      snapshot: { ...cachedPresence().snapshot!, unconfirmedIds: [ids[0]] },
    }
    expect(parseCachedPresence({ version: 1, boards: [valid] })).toEqual([valid])
    for (const invalid of [
      { ...valid, boardRegion: 'eu' },
      { ...valid, unpublishedIds: [] },
      { ...valid, unpublishedIds: [ids[0], ids[0]] },
      { ...valid, snapshot: { ...valid.snapshot, unconfirmedIds: [ids[0], ids[0]] } },
      { ...valid, snapshot: { ...valid.snapshot, unconfirmedIds: ['smartrecruiters-presence-harbour-59999'] } },
    ]) expect(parseCachedPresence({ version: 1, boards: [invalid] })).toEqual([])
  })
})

describe('independent service presence/content sequencing', () => {
  it('serves cold presence without body work or full-cache writes and shares simultaneous clients', async () => {
    const setup = options()
    const entered = gate()
    const held = gate()
    setup.presence.fetchBoard.mockImplementation(async () => {
      entered.release()
      await held.promise
      return { total: 2, publishedIds: [...ids] }
    })
    const service = createCatalogService(setup)
    const clients = Array.from({ length: 12 }, () => service.getPostingStatus(true))
    await entered.promise
    expect(setup.presence.fetchBoard).toHaveBeenCalledTimes(1)
    expect(setup.fetchBoard).not.toHaveBeenCalled()
    held.release()
    const results = await Promise.all(clients)
    for (const result of results) {
      expect(result).toMatchObject({
        version: 2, checkedAt: '2026-09-26T03:00:00.000Z',
        refreshAfter: '2026-09-26T03:01:00.000Z', contentRefreshAfter: '2026-09-26T03:00:00.000Z',
        boards: [{ status: 'ok', listing: { validUntil: '2026-09-26T03:30:00.000Z', publishedIds: [
          'smartrecruiters-presence-harbour-59001', 'smartrecruiters-presence-harbour-59201',
        ], jobs: [] } }],
      })
      expect(result.boards[0].listing?.content).toBeUndefined()
      expect(PostingStatusIndexSchema.safeParse(result).success).toBe(true)
    }
    expect(setup.cache.save).not.toHaveBeenCalled()
    expect(setup.presence.cache.save).toHaveBeenCalledTimes(1)
    expect(setup.fetchBoard).not.toHaveBeenCalled()
    setup.at('2026-09-26T03:00:59.999Z')
    await service.getPostingStatus(true)
    expect(setup.presence.fetchBoard).toHaveBeenCalledTimes(1)
    setup.at('2026-09-26T03:01:00.000Z')
    await service.getPostingStatus(true)
    expect(setup.presence.fetchBoard).toHaveBeenCalledTimes(2)
    expect(setup.cache.save).not.toHaveBeenCalled()
  })

  it('content can run immediately after presence and a later presence scan leaves body data and its clock intact', async () => {
    const setup = options()
    const service = createCatalogService(setup)
    await service.getPostingStatus(true)
    const full = await service.getPostingStatus(true, true)
    expect(setup.fetchBoard).toHaveBeenCalledTimes(1)
    expect(setup.presence.fetchBoard).toHaveBeenCalledTimes(1)
    expect(full.boards[0].listing).toMatchObject({
      jobs: [{ id: 'smartrecruiters-presence-harbour-59001', title: 'Backend Engineer — Harbour Relay' }],
      content: { checkedAt: '2026-09-26T03:00:00.000Z', validUntil: '2026-09-26T03:30:00.000Z', status: 'ok' },
    })
    expect(full.contentRefreshAfter).toBe('2026-09-26T03:01:00.000Z')
    const fullRecords = setup.cache.value()
    setup.at('2026-09-26T03:20:00.000Z')
    const presence = await service.getPostingStatus(true)
    expect(presence.boards[0]).toMatchObject({
      lastSuccessAt: '2026-09-26T03:20:00.000Z',
      listing: { validUntil: '2026-09-26T03:50:00.000Z', content: { checkedAt: '2026-09-26T03:00:00.000Z' } },
    })
    expect(setup.cache.value()).toEqual(fullRecords)
    expect(setup.cache.save).toHaveBeenCalledTimes(1)
    expect(setup.cache.value()[0].snapshot?.jobs[0].description).toBe(PRESENCE_ORIGINAL_BODY)
    setup.at('2026-09-26T03:30:00.000Z')
    const restarted = await createCatalogService(setup).getPostingStatus()
    expect(restarted.boards[0].listing).toMatchObject({
      jobs: [], validUntil: '2026-09-26T03:50:00.000Z',
      content: { checkedAt: '2026-09-26T03:00:00.000Z', validUntil: '2026-09-26T03:30:00.000Z', status: 'ok' },
    })
    expect(setup.fetchBoard).toHaveBeenCalledTimes(1)
    expect(setup.presence.fetchBoard).toHaveBeenCalledTimes(2)
    expect(setup.cache.value()).toEqual(fullRecords)
  })

  it('a full collection already in progress supplies presence clients without starting a second inventory', async () => {
    const setup = options()
    const entered = gate()
    const held = gate()
    const implementation = setup.fetchBoard.getMockImplementation()!
    setup.fetchBoard.mockImplementation(async (company, time) => {
      entered.release()
      await held.promise
      return implementation(company, time)
    })
    const service = createCatalogService(setup)
    const full = service.get(true)
    await entered.promise
    const presence = service.getPostingStatus(true)
    held.release()
    const [catalog, index] = await Promise.all([full, presence])
    expect(setup.fetchBoard).toHaveBeenCalledTimes(1)
    expect(setup.presence.fetchBoard).not.toHaveBeenCalled()
    expect(catalog.jobs.map(job => job.title)).toEqual(['Backend Engineer — Harbour Relay'])
    expect(index.boards[0].lastSuccessAt).toBe('2026-09-26T03:00:00.000Z')
    expect(index.boards[0].listing?.content?.checkedAt).toBe('2026-09-26T03:00:00.000Z')
  })

  it('a full action queued behind presence still fetches bodies once without overlapping provider work', async () => {
    const setup = options()
    const entered = gate()
    const held = gate()
    const events: string[] = []
    setup.presence.fetchBoard.mockImplementation(async () => {
      events.push('presence started')
      entered.release()
      await held.promise
      events.push('presence finished')
      return { total: 2, publishedIds: [...ids] }
    })
    const implementation = setup.fetchBoard.getMockImplementation()!
    setup.fetchBoard.mockImplementation(async (company, time) => {
      events.push('body started')
      const result = await implementation(company, time)
      events.push('body finished')
      return result
    })
    const service = createCatalogService(setup)
    const presence = service.getPostingStatus(true)
    await entered.promise
    const bodies = [service.getPostingStatus(true, true), service.get(true)]
    expect(events).toEqual(['presence started'])
    held.release()
    await Promise.all([presence, ...bodies])
    expect(events).toEqual(['presence started', 'presence finished', 'body started', 'body finished'])
    expect(setup.fetchBoard).toHaveBeenCalledTimes(1)
    expect(setup.presence.fetchBoard).toHaveBeenCalledTimes(1)
  })

  it('invalid or partial new IDs retain the last complete evidence as unknown without mutating the body cache', async () => {
    for (const invalid of [
      { total: 3, publishedIds: [...ids] },
      { total: 2, publishedIds: [ids[0], ids[0]] },
      { total: 1, publishedIds: ['smartrecruiters-foreign-59001'] },
    ]) {
      const setup = options()
      const service = createCatalogService(setup)
      await service.getPostingStatus(true)
      setup.at('2026-09-26T03:01:00.000Z')
      setup.presence.fetchBoard.mockResolvedValueOnce(invalid)
      const result = await service.getPostingStatus(true)
      expect(result.boards[0]).toMatchObject({
        status: 'error', checkedAt: '2026-09-26T03:01:00.000Z', lastSuccessAt: '2026-09-26T03:00:00.000Z',
        listing: { publishedIds: ['smartrecruiters-presence-harbour-59001', 'smartrecruiters-presence-harbour-59201'] },
      })
      expect(observeSavedPosting(presenceSaved()[2], result, undefined, setup.now()).state).toBe('unknown')
      expect(setup.fetchBoard).not.toHaveBeenCalled()
      expect(setup.cache.save).not.toHaveBeenCalled()
    }
  })

  it('a failed full inventory makes prior presence unknown, preserves complete IDs and body time, and stays unknown across restart and shared Retry-After', async () => {
    const setup = options()
    const service = createCatalogService(setup)
    await service.getPostingStatus(true, true)
    const bodySnapshot = setup.cache.value()[0].snapshot
    setup.at('2026-09-26T03:01:00.000Z')
    const sharedCause = new BoardFetchError('Fictional incomplete public inventory', Date.parse('2026-09-26T03:11:00.000Z'))
    setup.fetchBoard.mockRejectedValueOnce(new BoardInventoryError(sharedCause))
    const failed = await service.getPostingStatus(true, true)
    expect(failed.boards[0]).toMatchObject({
      status: 'error', checkedAt: '2026-09-26T03:01:00.000Z', lastSuccessAt: '2026-09-26T03:00:00.000Z',
      retryAt: '2026-09-26T03:11:00.000Z',
      listing: {
        publishedIds: ['smartrecruiters-presence-harbour-59001', 'smartrecruiters-presence-harbour-59201'], jobs: [],
        content: { checkedAt: '2026-09-26T03:00:00.000Z', status: 'error', jobIds: ['smartrecruiters-presence-harbour-59001'] },
      },
    })
    expect(failed.refreshAfter).toBe('2026-09-26T03:11:00.000Z')
    expect(failed.contentRefreshAfter).toBe('2026-09-26T03:11:00.000Z')
    expect(presenceSaved().map(saved => observeSavedPosting(saved, failed, undefined, setup.now()).state)).toEqual(['unknown', 'unknown', 'unknown'])
    expect(setup.cache.value()[0]).toMatchObject({ errorPhase: 'inventory', snapshot: bodySnapshot })
    expect(setup.presence.cache.value()[0]).toMatchObject({
      error: 'Fictional incomplete public inventory', checkedAt: '2026-09-26T03:01:00.000Z',
      snapshot: { fetchedAt: '2026-09-26T03:00:00.000Z', total: 2, publishedIds: [...ids] },
    })
    expect(sharedCause).not.toBeInstanceOf(BoardInventoryError)
    const restarted = createCatalogService(setup)
    expect(await restarted.getPostingStatus(true)).toEqual(failed)
    expect(await restarted.getPostingStatus(true, true)).toEqual(failed)
    expect(setup.fetchBoard).toHaveBeenCalledTimes(2)
    expect(setup.presence.fetchBoard).not.toHaveBeenCalled()
  })

  it('a full detail-body failure retains valid presence but no unchanged comparison, including after restart', async () => {
    const setup = options()
    const service = createCatalogService(setup)
    await service.getPostingStatus(true, true)
    const bodySnapshot = setup.cache.value()[0].snapshot
    setup.at('2026-09-26T03:01:00.000Z')
    setup.fetchBoard.mockRejectedValueOnce(new BoardFetchError('Fictional posting detail unavailable'))
    const failed = await service.getPostingStatus(true, true)
    expect(failed.boards[0]).toMatchObject({
      status: 'ok', checkedAt: '2026-09-26T03:00:00.000Z', lastSuccessAt: '2026-09-26T03:00:00.000Z',
      listing: {
        publishedIds: ['smartrecruiters-presence-harbour-59001', 'smartrecruiters-presence-harbour-59201'], jobs: [],
        content: { checkedAt: '2026-09-26T03:00:00.000Z', status: 'error', jobIds: ['smartrecruiters-presence-harbour-59001'] },
      },
    })
    const saved = observeSavedPosting(presenceSaved()[0], failed, undefined, setup.now())
    expect(saved).toMatchObject({
      state: 'listed', contentState: 'unavailable', contentCheckedAt: '2026-09-26T03:00:00.000Z',
      message: '게시 여부는 확인했어요. 비교할 수 있는 최신 본문이 없어 내용의 차이는 미확인입니다. 공고 내용 확인이나 원문을 이용해 주세요.',
    })
    expect(saved.changedFields).toBeUndefined()
    expect(saved.currentTitle).toBeUndefined()
    expect(observeSavedPosting(presenceSaved()[1], failed, undefined, setup.now()).contentCheckedAt).toBeUndefined()
    expect(observeSavedPosting(presenceSaved()[2], failed, undefined, setup.now()).state).toBe('missing')
    expect(setup.cache.value()[0]).toMatchObject({ errorPhase: 'content', snapshot: bodySnapshot })
    expect(setup.presence.cache.value()[0].error).toBeUndefined()
    const restarted = createCatalogService(setup)
    expect(await restarted.getPostingStatus(true)).toEqual(failed)
    expect(await restarted.getPostingStatus(true, true)).toEqual(failed)
    expect(setup.fetchBoard).toHaveBeenCalledTimes(2)
    expect(setup.presence.fetchBoard).not.toHaveBeenCalled()
  })

  it('a legacy full-cache failure with no phase remains conservatively unknown on restart', async () => {
    const setup = options()
    const service = createCatalogService(setup)
    await service.getPostingStatus(true, true)
    setup.at('2026-09-26T03:01:00.000Z')
    setup.fetchBoard.mockRejectedValueOnce(new BoardFetchError('Legacy failure with unknown phase'))
    await service.getPostingStatus(true, true)
    const legacy = setup.cache.value()
    delete legacy[0].errorPhase
    await setup.cache.save(legacy)
    const failed = await createCatalogService(setup).getPostingStatus(true)
    expect(failed.boards[0]).toMatchObject({
      status: 'error', message: 'Legacy failure with unknown phase',
      lastSuccessAt: '2026-09-26T03:00:00.000Z',
      listing: { publishedIds: ['smartrecruiters-presence-harbour-59001', 'smartrecruiters-presence-harbour-59201'] },
    })
    expect(presenceSaved().map(saved => observeSavedPosting(saved, failed, undefined, setup.now()).state)).toEqual(['unknown', 'unknown', 'unknown'])
    expect(setup.fetchBoard).toHaveBeenCalledTimes(2)
    expect(setup.presence.fetchBoard).not.toHaveBeenCalled()
  })

  it.each([
    { name: 'missing', publishedIds: undefined, total: 2 },
    { name: 'partial', publishedIds: [ids[0]], total: 2 },
    { name: 'duplicate', publishedIds: [ids[0], ids[0]], total: 2 },
  ])('a full result with $name published IDs cannot create successful v2 presence', async ({ publishedIds, total }) => {
    const setup = options()
    setup.fetchBoard.mockResolvedValueOnce({ total, publishedIds, unmappedCount: 0, jobs: [] })
    const failed = await createCatalogService(setup).getPostingStatus(true, true)
    expect(failed.boards[0]).toMatchObject({
      status: 'error', lastSuccessAt: null, message: '게시판의 전체 공개 목록을 확인하지 못했어요.',
    })
    expect(failed.boards[0].listing).toBeUndefined()
    expect(presenceSaved().map(saved => observeSavedPosting(saved, failed, undefined, setup.now()).state)).toEqual(['unknown', 'unknown', 'unknown'])
    expect(setup.cache.value()[0].errorPhase).toBe('inventory')
  })

  it('shares Retry-After between actions and across restarts, recovering only at the actual deadline', async () => {
    const setup = options()
    const service = createCatalogService(setup)
    await service.getPostingStatus(true)
    setup.at('2026-09-26T03:01:00.000Z')
    setup.presence.fetchBoard.mockRejectedValueOnce(new BoardFetchError('HTTP 429', Date.parse('2026-09-26T03:11:00.000Z')))
    const failed = await service.getPostingStatus(true)
    expect(failed.boards[0]).toMatchObject({
      status: 'error', retryAt: '2026-09-26T03:11:00.000Z', lastSuccessAt: '2026-09-26T03:00:00.000Z',
      listing: { publishedIds: ['smartrecruiters-presence-harbour-59001', 'smartrecruiters-presence-harbour-59201'] },
    })
    expect(failed.refreshAfter).toBe('2026-09-26T03:11:00.000Z')
    expect(failed.contentRefreshAfter).toBe('2026-09-26T03:11:00.000Z')
    await service.getPostingStatus(true, true)
    setup.at('2026-09-26T03:10:59.999Z')
    const restarted = createCatalogService(setup)
    await restarted.getPostingStatus(true)
    await restarted.getPostingStatus(true, true)
    expect(setup.presence.fetchBoard).toHaveBeenCalledTimes(2)
    expect(setup.fetchBoard).not.toHaveBeenCalled()
    setup.at('2026-09-26T03:11:00.000Z')
    setup.presence.fetchBoard.mockResolvedValueOnce({ total: 0, publishedIds: [] })
    const empty = await restarted.getPostingStatus(true)
    expect(empty.boards[0]).toMatchObject({
      status: 'ok', lastSuccessAt: '2026-09-26T03:11:00.000Z', listing: { publishedIds: [], jobs: [] },
    })
    expect(observeSavedPosting(presenceSaved()[0], empty, undefined, setup.now()).state).toBe('missing')
    expect(setup.presence.fetchBoard).toHaveBeenCalledTimes(3)
    expect(setup.cache.save).not.toHaveBeenCalled()
  })

  it('seeds a complete legacy full inventory but never infers missing IDs from legacy filtered jobs alone', async () => {
    const full: CachedBoard = {
      companyId: 'presence-harbour', provider: 'smartrecruiters', board: 'HarbourPresence59',
      checkedAt: '2026-09-26T03:00:00.000Z', failures: 0, retryAt: null,
      snapshot: {
        fetchedAt: '2026-09-26T03:00:00.000Z', total: 2, unmappedCount: 0, publishedIds: [...ids],
        jobs: [{ ...presenceSaved()[0].job, source: 'smartrecruiters', fetchedAt: '2026-09-26T03:00:00.000Z' }],
      },
    }
    const setup = options()
    setup.cache = memory([full])
    const result = await createCatalogService(setup).getPostingStatus(true)
    expect(result.boards[0].listing?.publishedIds).toEqual(['smartrecruiters-presence-harbour-59001', 'smartrecruiters-presence-harbour-59201'])
    expect(setup.presence.fetchBoard).not.toHaveBeenCalled()
    expect(setup.fetchBoard).not.toHaveBeenCalled()
    const withoutInventory = structuredClone(full)
    delete withoutInventory.snapshot!.publishedIds
    const legacy = options()
    legacy.cache = memory([withoutInventory])
    legacy.presence.fetchBoard.mockRejectedValueOnce(new Error('Fictional inventory unavailable'))
    const unknown = await createCatalogService(legacy).getPostingStatus(true)
    expect(unknown.boards[0].listing).toBeUndefined()
    expect(observeSavedPosting(presenceSaved()[2], unknown, undefined, BASE).state).toBe('unknown')
    expect(legacy.fetchBoard).not.toHaveBeenCalled()
    expect(legacy.cache.save).not.toHaveBeenCalled()
  })

  it('does not resurrect explicitly unpublished detail evidence during presence scans or a restart', async () => {
    const setup = options()
    setup.fetchBoard.mockResolvedValueOnce({
      total: 1, publishedIds: [ids[1]], unpublishedIds: [ids[0]], jobs: [], unmappedCount: 0,
    })
    const service = createCatalogService(setup)
    await service.getPostingStatus(true, true)
    setup.at('2026-09-26T03:01:00.000Z')
    const contradictory = await service.getPostingStatus(true)
    expect(contradictory.boards[0].listing).toMatchObject({
      publishedIds: ['smartrecruiters-presence-harbour-59001', 'smartrecruiters-presence-harbour-59201'],
      unconfirmedIds: ['smartrecruiters-presence-harbour-59001'], jobs: [],
    })
    expect(observeSavedPosting(presenceSaved()[0], contradictory, undefined, setup.now()).state).toBe('unknown')
    const restarted = createCatalogService(setup)
    const stillUnknown = await restarted.getPostingStatus(true)
    expect(stillUnknown.boards[0].listing?.unconfirmedIds).toEqual(['smartrecruiters-presence-harbour-59001'])
    setup.at('2026-09-26T03:02:00.000Z')
    setup.fetchBoard.mockResolvedValueOnce({
      total: 2, publishedIds: [...ids], jobs: [], unmappedCount: 0, verifiedActiveIds: [],
    })
    const outside = await restarted.getPostingStatus(true, true)
    expect(outside.boards[0].listing?.unconfirmedIds).toEqual(['smartrecruiters-presence-harbour-59001'])
    expect(observeSavedPosting(presenceSaved()[0], outside, undefined, setup.now()).state).toBe('unknown')
    const outsideRestart = createCatalogService(setup)
    expect((await outsideRestart.getPostingStatus(true)).boards[0].listing?.unconfirmedIds).toEqual(['smartrecruiters-presence-harbour-59001'])
    setup.at('2026-09-26T03:03:00.000Z')
    const reactivated = await outsideRestart.getPostingStatus(true, true)
    expect(reactivated.boards[0].listing?.unconfirmedIds).toBeUndefined()
    expect(observeSavedPosting(presenceSaved()[0], reactivated, undefined, setup.now()).state).toBe('listed')
    expect(setup.presence.cache.value()[0].unpublishedIds ?? []).toEqual([])
  })
})
