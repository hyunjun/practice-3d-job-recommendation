import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CatalogRequestError } from '../../src/lib/catalog-request'
import { CatalogWorkerClient } from '../../src/lib/catalog-worker-client'
import { CATALOG_PROJECTION_PROTOCOL } from '../../src/lib/catalog-worker-types'
import type { CatalogProjection, CatalogViewInput, CatalogWorkerResponse } from '../../src/lib/catalog-worker-types'
import { CATALOG_WORKER_FILTERS, CATALOG_WORKER_PROFILE, catalogWorkerCatalog, catalogWorkerEmpty, catalogWorkerRevised } from '../fixtures/catalog-worker'
import { AGING_AT, AGING_FRESH_NOW, AGING_JOB_IDS, ASTER_IDS, BIRCH_IDS, agingCurrentCatalog, withoutStaleKeys } from '../fixtures/catalog-worker-aging'
import { CatalogWorkerDouble, installCatalogWorkerDouble, projectedReplies } from './helpers/catalog-worker-double'
import type { ReplyMutation } from './helpers/catalog-worker-double'

// Stage79 contract docs/design/catalog-worker-aging.md (SHA-256 2fc0192c…) lines 33-60 and item 8:
// the private projection protocol, client preflight, tri-state hydration and terminal failure.
//
// The double runs the real model in-process and structured-clones genuine replies. Every invalid
// reply below is an explicitly labelled SYNTHETIC CORRUPTION of a structured clone of a genuine
// reply; nothing is fabricated from scratch. Each corruption violates exactly one preflight rule
// (unique cached live IDs for value checks, a listed-but-bodiless ghost for the absent base, a
// primed cache for the body/flag overlap, a cached live ID absent from bodies and flags for the
// removal), so a rejection cannot be explained by another rule. A terminal CATALOG_WORKER_FAILED
// plus an unchanged published view still does not by itself prove which guard fired or that no
// private cache write happened; preflight-before-write is source evidence in the client's hydrate.
// Redundant supported updates are valid-protocol receiver inputs that the sender's classifier never
// emits; they test target Job identity only, not projection, facts or MatchedJob identity. This is a
// unit double, not a browser Worker thread.

const WORKER_FAILURE_MESSAGE = '공고 처리 연결이 끊겼어요. 도착한 공고와 저장 기록은 유지됩니다. 다시 조회해 주세요.'
const noNetwork = vi.fn(async () => { throw new Error('Worker unit verification must not contact a server.') })
beforeEach(() => { noNetwork.mockClear(); vi.stubGlobal('fetch', noNetwork); installCatalogWorkerDouble() })
afterEach(() => { expect(noNetwork).not.toHaveBeenCalled(); vi.unstubAllGlobals(); vi.useRealTimers() })

const at = (time: string) => Date.parse(time)
const input = (time: string, changes: Partial<CatalogViewInput> = {}): CatalogViewInput => ({
  profile: CATALOG_WORKER_PROFILE, filters: CATALOG_WORKER_FILTERS, scope: { kind: 'cities' },
  recover: true, collecting: false, now: at(time), ...changes,
})
const signal = () => new AbortController().signal

async function start(catalog: unknown = catalogWorkerCatalog(), onFailure = vi.fn(), stream = 1) {
  const client = new CatalogWorkerClient(onFailure)
  const double = CatalogWorkerDouble.instances.at(-1)!
  const receipt = await client.read(Response.json(catalog), true, stream, signal())
  return { client, double, onFailure, revision: receipt.value.revision }
}

/** Settlement record: the existing error class and code, not an invented Error.name. */
const settled = (promise: Promise<unknown>) => promise.then(
  value => ({ status: 'fulfilled' as const, value }),
  (reason: unknown) => ({
    status: 'rejected' as const, code: (reason as { code?: string }).code, catalogRequestError: reason instanceof CatalogRequestError,
  }))

/** Birch's London job: delivered by the initial projection, live, and in neither the bodies nor the flags of the Aster-boundary reply. */
const LIVE_CACHED_ID = BIRCH_IDS[0]
const GHOST_ID = 'greenhouse-catalog-worker-ghost'
const ASTER_FLAGS = ASTER_IDS.map(id => ({ id, stale: true }))
const SAME_BOUNDARY_FRESH = '2026-09-24T08:00:04.000Z'
const SAME_BOUNDARY_ASTER = '2026-09-24T08:30:00.700Z'

/**
 * Labelled synthetic corruptions applied to a structured clone of a genuine projected reply. Unless
 * noted, the genuine reply is the Aster-boundary flag-only reply (jobs [], removed [], staleUpdates =
 * the three Aster flags) delivered after an initial full projection primed the receiver cache.
 */
const corrupt = {
  // Value checks on a unique cached live ID: no duplicate, body, removal or membership conflict.
  missingStaleValue: (reply: CatalogWorkerResponse) => { (patch(reply).staleUpdates as unknown[]).push({ id: LIVE_CACHED_ID }); return reply },
  undefinedStaleValue: (reply: CatalogWorkerResponse) => { (patch(reply).staleUpdates as unknown[]).push({ id: LIVE_CACHED_ID, stale: undefined }); return reply },
  stringStaleValue: (reply: CatalogWorkerResponse) => { (patch(reply).staleUpdates as unknown[]).push({ id: LIVE_CACHED_ID, stale: 'true' }); return reply },
  // Absent receiver base: the ghost is listed live with a well-typed flag, but no body was ever delivered for it.
  absentCacheBase: (reply: CatalogWorkerResponse) => {
    const value = patch(reply)
    value.jobIds = [...value.jobIds, GHOST_ID]
    value.staleUpdates.push({ id: GHOST_ID, stale: true })
    return reply
  },
  // One more copy of a flag the genuine reply already carries.
  duplicateStaleIds: (reply: CatalogWorkerResponse) => { patch(reply).staleUpdates.push({ id: ASTER_IDS[0], stale: true }); return reply },
  // Live membership: a cached ID disappears from jobIds while its genuine flag remains.
  staleOutsideJobIds: (reply: CatalogWorkerResponse) => { const value = patch(reply); value.jobIds = value.jobIds.filter(id => id !== ASTER_IDS[0]); return reply },
  // Removal of a cached live ID that stays in jobIds and appears in neither bodies nor flags of this reply.
  removedLiveId: (reply: CatalogWorkerResponse) => { patch(reply).removed.push(LIVE_CACHED_ID); return reply },
  // Body/flag overlap on an already cached live ID; applied to a genuine full-body delivery (see the primed-cache test).
  staleOverlapsFullBody: (reply: CatalogWorkerResponse) => { patch(reply).staleUpdates.push({ id: ASTER_IDS[0], stale: true }); return reply },
  missingStaleArray: (reply: CatalogWorkerResponse) => { delete (patch(reply) as Partial<ReturnType<typeof patch>>).staleUpdates; return reply },
  missingProtocol: (reply: CatalogWorkerResponse) => { delete (patch(reply) as Partial<ReturnType<typeof patch>>).protocol; return reply },
  unsupportedProtocol: (reply: CatalogWorkerResponse) => { (patch(reply) as { protocol: unknown }).protocol = 2; return reply },
  wrongResultKind: (reply: CatalogWorkerResponse) => { if ('result' in reply) (reply.result as { kind: string }).kind = 'previewed'; return reply },
  remoteWorkerFailed: (reply: CatalogWorkerResponse) => ({ id: reply.id, error: { message: 'Fictional stage79 remote worker failure.', code: 'CATALOG_WORKER_FAILED' } }),
} satisfies Record<string, ReplyMutation>

function patch(reply: CatalogWorkerResponse) {
  if (!('result' in reply) || reply.result.kind !== 'projected') throw new Error('Expected a genuine projected reply to corrupt.')
  return reply.result.value
}

/** Valid-protocol receiver input: one supported stale update appended to a structured clone of a genuine reply. */
const withUpdate = (update: { id: string; stale: boolean | null }): ReplyMutation => reply => { patch(reply).staleUpdates.push(update); return reply }

describe('protocol envelope and tri-state hydration', () => {
  it('every project request carries the protocol constant and flag changes hydrate as immutable shallow views', async () => {
    const { client, double, onFailure } = await start()
    try {
      const initial = await client.project(1, input(AGING_FRESH_NOW))
      const initialJobs = initial.catalog.jobs
      expect(double.commands.filter(request => request.command.kind === 'project').map(request => (request.command as { protocol?: unknown }).protocol)).toEqual([CATALOG_PROJECTION_PROTOCOL])
      expect(initial.catalog.jobs.map(job => job.id)).toEqual(AGING_JOB_IDS)
      expect(initial.catalog.jobs.map(job => job.stale)).toEqual(Array(9).fill(false))

      const stale = await client.project(1, input(AGING_AT.asterStale))
      expect(projectedReplies(double).at(-1)).toMatchObject({ jobs: [], staleUpdates: ASTER_FLAGS })
      expect(stale.catalog.jobs.map(job => job.stale)).toEqual([true, true, true, false, false, false, false, false, false])
      // The earlier published view is untouched; unaffected jobs keep their object identity.
      expect(initialJobs.map(job => job.stale)).toEqual(Array(9).fill(false))
      expect(stale.catalog.jobs.slice(3)).toEqual(initialJobs.slice(3))
      for (let index = 3; index < 9; index++) expect(stale.catalog.jobs[index]).toBe(initialJobs[index])
      for (let index = 0; index < 3; index++) {
        expect(stale.catalog.jobs[index]).not.toBe(initialJobs[index])
        expect({ ...stale.catalog.jobs[index], stale: false }).toEqual(initialJobs[index])
      }
      // Matches bind to the current displayed job object.
      for (const match of stale.matches) expect(match.job).toBe(stale.catalog.jobs.find(job => job.id === match.job.id))
      expect(stale.matches.filter(match => ASTER_IDS.includes(match.job.id)).map(match => match.job.stale)).toEqual([true, true, true])

      const fresh = await client.project(1, input(AGING_FRESH_NOW))
      expect(projectedReplies(double).at(-1)).toMatchObject({ jobs: [], staleUpdates: ASTER_IDS.map(id => ({ id, stale: false })) })
      expect(fresh.catalog.jobs.map(job => job.stale)).toEqual(Array(9).fill(false))
      expect(onFailure).not.toHaveBeenCalled()
    } finally { client.dispose() }
  })

  it('a null update deletes the own stale property instead of storing null or undefined', async () => {
    const { client } = await start(withoutStaleKeys(agingCurrentCatalog()))
    try {
      const initial = await client.project(1, input(AGING_FRESH_NOW))
      expect(initial.catalog.jobs.every(job => !Object.hasOwn(job, 'stale'))).toBe(true)
      const stale = await client.project(1, input(AGING_AT.asterStale))
      expect(stale.catalog.jobs.slice(0, 3).map(job => job.stale)).toEqual([true, true, true])
      const back = await client.project(1, input(AGING_FRESH_NOW))
      for (let index = 0; index < 3; index++) {
        expect(Object.hasOwn(back.catalog.jobs[index], 'stale')).toBe(false)
        expect(back.catalog.jobs[index]).toEqual(initial.catalog.jobs[index])
        expect(back.catalog.jobs[index]).not.toBe(stale.catalog.jobs[index])
      }
      expect(back.catalog.jobs.slice(3)).toEqual(initial.catalog.jobs.slice(3))
    } finally { client.dispose() }
  })

  it('preview and acknowledge leave the delivery baseline alone', async () => {
    const { client, double } = await start()
    try {
      await client.project(1, input(AGING_FRESH_NOW))
      client.acknowledge(1)
      expect(await client.preview(1, CATALOG_WORKER_PROFILE, { ...CATALOG_WORKER_FILTERS, query: 'Atlas Alpha' }, at(AGING_AT.asterStale))).toBe(1)
      await client.project(1, input(AGING_AT.asterStale))
      expect(projectedReplies(double).at(-1)).toMatchObject({ jobs: [], staleUpdates: ASTER_FLAGS })
    } finally { client.dispose() }
  })
})

describe('supported redundant stale updates are valid receiver inputs (test-only; the sender omits them)', () => {
  const BIRCH_LONDON = AGING_JOB_IDS.indexOf(BIRCH_IDS[0])
  const ASTER_ATLAS = AGING_JOB_IDS.indexOf(ASTER_IDS[0])

  /** Hold the next same-boundary projection, confirm its genuine reply changes nothing, then deliver it with one labelled valid update. */
  async function deliver(client: CatalogWorkerClient, double: CatalogWorkerDouble, time: string, mutate: ReplyMutation) {
    double.holding.add('project')
    const pending = client.project(1, input(time))
    await double.settle()
    const [held] = double.heldOf('project')
    expect(patch(held.reply)).toMatchObject({ jobs: [], staleUpdates: [], removed: [] })
    double.releaseOne('project', mutate)
    double.holding.delete('project')
    return pending
  }

  function expectOthersUnchanged(after: CatalogProjection, before: CatalogProjection, except: number) {
    for (const [index, job] of after.catalog.jobs.entries()) if (index !== except) expect(job).toBe(before.catalog.jobs[index])
  }

  it('a redundant own-false update reuses the target Job object, keeps own false and leaves the prior view and client intact', async () => {
    const { client, double, onFailure } = await start()
    try {
      const before = await client.project(1, input(AGING_FRESH_NOW))
      const snapshot = structuredClone(before)
      const after = await deliver(client, double, SAME_BOUNDARY_FRESH, withUpdate({ id: LIVE_CACHED_ID, stale: false }))
      expect(after.catalog.jobs[BIRCH_LONDON]).toBe(before.catalog.jobs[BIRCH_LONDON])
      expect(Object.hasOwn(after.catalog.jobs[BIRCH_LONDON], 'stale')).toBe(true)
      expect(after.catalog.jobs[BIRCH_LONDON].stale).toBe(false)
      expectOthersUnchanged(after, before, BIRCH_LONDON)
      expect(before).toEqual(snapshot)
      expect(client.failed).toBe(false)
      expect(onFailure).not.toHaveBeenCalled()
      await client.project(1, input(AGING_AT.asterStale))
      expect(projectedReplies(double).at(-1)).toMatchObject({ jobs: [], staleUpdates: ASTER_FLAGS })
    } finally { client.dispose() }
  })

  it('a redundant own-true update after a boundary reuses the flagged Job object', async () => {
    const { client, double, onFailure } = await start()
    try {
      await client.project(1, input(AGING_FRESH_NOW))
      const flagged = await client.project(1, input(AGING_AT.asterStale))
      const snapshot = structuredClone(flagged)
      const after = await deliver(client, double, SAME_BOUNDARY_ASTER, withUpdate({ id: ASTER_IDS[0], stale: true }))
      expect(after.catalog.jobs[ASTER_ATLAS]).toBe(flagged.catalog.jobs[ASTER_ATLAS])
      expect(Object.hasOwn(after.catalog.jobs[ASTER_ATLAS], 'stale')).toBe(true)
      expect(after.catalog.jobs[ASTER_ATLAS].stale).toBe(true)
      expectOthersUnchanged(after, flagged, ASTER_ATLAS)
      expect(flagged).toEqual(snapshot)
      expect(client.failed).toBe(false)
      expect(onFailure).not.toHaveBeenCalled()
    } finally { client.dispose() }
  })

  it('a redundant null update on a job without the stale key reuses the object and adds no own property', async () => {
    const { client, double, onFailure } = await start(withoutStaleKeys(agingCurrentCatalog()))
    try {
      const before = await client.project(1, input(AGING_FRESH_NOW))
      expect(Object.hasOwn(before.catalog.jobs[BIRCH_LONDON], 'stale')).toBe(false)
      const snapshot = structuredClone(before)
      const after = await deliver(client, double, SAME_BOUNDARY_FRESH, withUpdate({ id: LIVE_CACHED_ID, stale: null }))
      expect(after.catalog.jobs[BIRCH_LONDON]).toBe(before.catalog.jobs[BIRCH_LONDON])
      expect(Object.hasOwn(after.catalog.jobs[BIRCH_LONDON], 'stale')).toBe(false)
      expectOthersUnchanged(after, before, BIRCH_LONDON)
      expect(before).toEqual(snapshot)
      expect(client.failed).toBe(false)
      expect(onFailure).not.toHaveBeenCalled()
    } finally { client.dispose() }
  })

  it('absent to own false creates a new target Job with the own property set and every non-stale value and reference preserved', async () => {
    const { client, double, onFailure } = await start(withoutStaleKeys(agingCurrentCatalog()))
    try {
      const before = await client.project(1, input(AGING_FRESH_NOW))
      const previous = before.catalog.jobs[BIRCH_LONDON]
      expect(Object.hasOwn(previous, 'stale')).toBe(false)
      const after = await deliver(client, double, SAME_BOUNDARY_FRESH, withUpdate({ id: LIVE_CACHED_ID, stale: false }))
      const current = after.catalog.jobs[BIRCH_LONDON]
      expect(current).not.toBe(previous)
      expect(Object.hasOwn(current, 'stale')).toBe(true)
      expect(current.stale).toBe(false)
      const { stale: _stale, ...rest } = current
      expect(rest).toEqual(previous)
      expect(current.skills).toBe(previous.skills)
      expect(current.qualifications).toBe(previous.qualifications)
      expect(current.salary).toBe(previous.salary)
      expect(current.occupation).toBe(previous.occupation)
      expect(current.roleClassification).toBe(previous.roleClassification)
      // The earlier Job and view are untouched.
      expect(Object.hasOwn(previous, 'stale')).toBe(false)
      expect(before.catalog.jobs[BIRCH_LONDON]).toBe(previous)
      expectOthersUnchanged(after, before, BIRCH_LONDON)
      expect(client.failed).toBe(false)
      expect(onFailure).not.toHaveBeenCalled()
    } finally { client.dispose() }
  })

  it('own false to absent creates a new target Job without the own property and preserves every non-stale value and reference', async () => {
    const { client, double, onFailure } = await start()
    try {
      const before = await client.project(1, input(AGING_FRESH_NOW))
      const previous = before.catalog.jobs[BIRCH_LONDON]
      expect(previous.stale).toBe(false)
      const after = await deliver(client, double, SAME_BOUNDARY_FRESH, withUpdate({ id: LIVE_CACHED_ID, stale: null }))
      const current = after.catalog.jobs[BIRCH_LONDON]
      expect(current).not.toBe(previous)
      expect(Object.hasOwn(current, 'stale')).toBe(false)
      expect({ ...current, stale: false }).toEqual(previous)
      expect(current.skills).toBe(previous.skills)
      expect(current.qualifications).toBe(previous.qualifications)
      expect(current.salary).toBe(previous.salary)
      // The earlier Job and view are untouched.
      expect(Object.hasOwn(previous, 'stale')).toBe(true)
      expect(previous.stale).toBe(false)
      expect(before.catalog.jobs[BIRCH_LONDON]).toBe(previous)
      expectOthersUnchanged(after, before, BIRCH_LONDON)
      expect(client.failed).toBe(false)
      expect(onFailure).not.toHaveBeenCalled()
    } finally { client.dispose() }
  })
})

describe('remote errors: superseded stays a query result, worker failure ends the connection once', () => {
  it('a genuine CATALOG_SUPERSEDED for a pruned revision is not terminal', async () => {
    const onFailure = vi.fn()
    const client = new CatalogWorkerClient(onFailure)
    const double = CatalogWorkerDouble.instances.at(-1)!
    try {
      await client.read(Response.json(catalogWorkerCatalog()), true, 1, signal())
      await client.project(1, input(AGING_FRESH_NOW))
      client.acknowledge(1)
      await client.read(Response.json(catalogWorkerRevised()), true, 2, signal())
      await client.project(2, input(AGING_FRESH_NOW))
      await client.read(Response.json(catalogWorkerEmpty()), true, 3, signal())
      const latest = await client.project(3, input(AGING_FRESH_NOW))
      expect(latest.catalog.jobs).toEqual([])
      await expect(client.project(2, input(AGING_FRESH_NOW))).rejects.toMatchObject({ code: 'CATALOG_SUPERSEDED' })
      expect(client.failed).toBe(false)
      expect(onFailure).not.toHaveBeenCalled()
      expect(double.terminate).not.toHaveBeenCalled()
      const acknowledged = await client.project(1, input(AGING_FRESH_NOW))
      expect(acknowledged.catalog.jobs.map(job => job.title)[0]).toBe('Backend Engineer — Atlas Alpha')
    } finally { client.dispose() }
  })

  it('a remote CATALOG_WORKER_FAILED reply (synthetic) terminates once and refuses later work', async () => {
    const { client, double, onFailure } = await start()
    const before = await client.project(1, input(AGING_FRESH_NOW))
    const snapshot = structuredClone(before)
    double.holding.add('project')
    const failing = client.project(1, input(AGING_AT.asterStale))
    await double.settle()
    expect(double.heldOf('project')).toHaveLength(1)
    double.releaseOne('project', corrupt.remoteWorkerFailed)
    await expect(failing).rejects.toMatchObject({ code: 'CATALOG_WORKER_FAILED' })
    expect(client.failed).toBe(true)
    expect(onFailure).toHaveBeenCalledTimes(1)
    expect(onFailure.mock.calls[0][0]).toMatchObject({ code: 'CATALOG_WORKER_FAILED' })
    expect(double.terminate).toHaveBeenCalledTimes(1)
    const posted = double.commands.length
    await expect(client.project(1, input(AGING_FRESH_NOW))).rejects.toMatchObject({ code: 'CATALOG_WORKER_FAILED', message: WORKER_FAILURE_MESSAGE })
    await expect(client.preview(1, CATALOG_WORKER_PROFILE, CATALOG_WORKER_FILTERS, at(AGING_FRESH_NOW))).rejects.toMatchObject({ code: 'CATALOG_WORKER_FAILED' })
    expect(double.commands).toHaveLength(posted)
    expect(before).toEqual(snapshot)
  })
})

describe('malformed projected replies (synthetic corruption of genuine replies) are terminal exactly once', () => {
  // Each case corrupts the genuine Aster-boundary reply after the initial projection primed the receiver
  // cache. The genuine reply is asserted first, so the isolation of every corruption is visible: it has no
  // bodies, no removals and exactly the three Aster flags.
  const boundaryCases: [string, ReplyMutation][] = [
    ['stale update without a stale value for a cached live ID', corrupt.missingStaleValue],
    ['stale update with an undefined stale value for a cached live ID', corrupt.undefinedStaleValue],
    ['stale update with a string stale value for a cached live ID', corrupt.stringStaleValue],
    ['well-typed stale update for a listed live ID that has no cached body', corrupt.absentCacheBase],
    ['duplicate stale update id', corrupt.duplicateStaleIds],
    ['stale update whose id is missing from jobIds', corrupt.staleOutsideJobIds],
    ['removed id that is cached, live and in neither bodies nor flags', corrupt.removedLiveId],
    ['missing staleUpdates array', corrupt.missingStaleArray],
    ['missing reply protocol', corrupt.missingProtocol],
    ['unsupported reply protocol', corrupt.unsupportedProtocol],
    ['wrong projected result kind', corrupt.wrongResultKind],
  ]
  for (const [title, mutate] of boundaryCases) {
    it(`${title}: rejects, notifies once, terminates once, keeps the last published view and ignores later work`, async () => {
      const { client, double, onFailure } = await start()
      const published = await client.project(1, input(AGING_FRESH_NOW))
      const snapshot = structuredClone(published)
      double.holding.add('project')
      const pending = client.project(1, input(AGING_AT.asterStale))
      await double.settle()
      const [held] = double.heldOf('project')
      expect(patch(held.reply)).toMatchObject({ jobs: [], removed: [], staleUpdates: ASTER_FLAGS })
      expect(patch(held.reply).jobIds).toEqual(AGING_JOB_IDS)
      double.releaseOne('project', mutate)
      await expect(pending).rejects.toMatchObject({ code: 'CATALOG_WORKER_FAILED' })
      expect(client.failed).toBe(true)
      expect(onFailure).toHaveBeenCalledTimes(1)
      expect(double.terminate).toHaveBeenCalledTimes(1)
      expect(published).toEqual(snapshot)
      const posted = double.commands.length
      await expect(client.project(1, input(AGING_FRESH_NOW))).rejects.toMatchObject({ code: 'CATALOG_WORKER_FAILED' })
      expect(double.commands).toHaveLength(posted)
    })
  }

  it('a stale update that overlaps a full body in a revised delivery to a primed cache is terminal', async () => {
    const { client, double, onFailure } = await start()
    const published = await client.project(1, input(AGING_FRESH_NOW))
    const snapshot = structuredClone(published)
    // The revised catalog changes every record, so its genuine first projection carries nine full bodies for cached live IDs.
    await client.read(Response.json(catalogWorkerRevised()), true, 2, signal())
    double.holding.add('project')
    const pending = client.project(2, input(AGING_FRESH_NOW))
    await double.settle()
    const [held] = double.heldOf('project')
    expect(patch(held.reply).jobs.map(job => job.id)).toEqual(AGING_JOB_IDS)
    expect(patch(held.reply)).toMatchObject({ removed: [], staleUpdates: [] })
    double.releaseOne('project', corrupt.staleOverlapsFullBody)
    await expect(pending).rejects.toMatchObject({ code: 'CATALOG_WORKER_FAILED' })
    expect(client.failed).toBe(true)
    expect(onFailure).toHaveBeenCalledTimes(1)
    expect(double.terminate).toHaveBeenCalledTimes(1)
    expect(published).toEqual(snapshot)
    const posted = double.commands.length
    await expect(client.project(2, input(AGING_FRESH_NOW))).rejects.toMatchObject({ code: 'CATALOG_WORKER_FAILED' })
    expect(double.commands).toHaveLength(posted)
  })

  it('an unsupported reply protocol on the first delivery is rejected without any hydration', async () => {
    const { client, double, onFailure } = await start()
    double.holding.add('project')
    const pending = client.project(1, input(AGING_FRESH_NOW))
    await double.settle()
    double.releaseOne('project', corrupt.unsupportedProtocol)
    await expect(pending).rejects.toMatchObject({ code: 'CATALOG_WORKER_FAILED' })
    expect(onFailure).toHaveBeenCalledTimes(1)
    expect(double.terminate).toHaveBeenCalledTimes(1)
    expect(client.failed).toBe(true)
  })

  it('a still-pending concurrent result is rejected and an already-resolved one is ignored after the failure', async () => {
    const { client, double, onFailure } = await start()
    await client.project(1, input(AGING_FRESH_NOW))
    double.holding.add('project')
    const first = client.project(1, input(AGING_AT.asterStale))
    const second = client.project(1, input(AGING_AT.birchStale))
    await double.settle()
    expect(double.heldOf('project')).toHaveLength(2)
    // Deliver the corrupted first reply and the genuine second reply in the same synchronous turn:
    // the second Promise resolves before the first continuation runs, exercising the post-await guard.
    double.releaseOne('project', corrupt.missingProtocol)
    double.releaseOne('project')
    const [a, b] = await Promise.all([settled(first), settled(second)])
    expect(a).toEqual({ status: 'rejected', code: 'CATALOG_WORKER_FAILED', catalogRequestError: true })
    expect(b).toEqual({ status: 'rejected', code: 'CATALOG_WORKER_FAILED', catalogRequestError: true })
    expect(onFailure).toHaveBeenCalledTimes(1)
    expect(double.terminate).toHaveBeenCalledTimes(1)

    // A still-pending request at failure time is rejected by stop(); its later genuine reply is ignored.
    installCatalogWorkerDouble()
    const again = await start()
    await again.client.project(1, input(AGING_FRESH_NOW))
    again.double.holding.add('project')
    const corrupted = again.client.project(1, input(AGING_AT.asterStale))
    const waiting = again.client.project(1, input(AGING_AT.birchStale))
    await again.double.settle()
    again.double.releaseOne('project', corrupt.absentCacheBase)
    expect(await settled(corrupted)).toMatchObject({ status: 'rejected', code: 'CATALOG_WORKER_FAILED', catalogRequestError: true })
    expect(await settled(waiting)).toMatchObject({ status: 'rejected', code: 'CATALOG_WORKER_FAILED', catalogRequestError: true })
    expect(again.double.heldOf('project')).toHaveLength(1)
    again.double.releaseOne('project')
    expect(again.onFailure).toHaveBeenCalledTimes(1)
    expect(again.double.terminate).toHaveBeenCalledTimes(1)
    expect(again.client.failed).toBe(true)
  })

  it('a failure callback that disposes the client, followed by a crash event, still notifies and terminates once', async () => {
    const onFailure = vi.fn()
    const client = new CatalogWorkerClient(error => { onFailure(error); client.dispose() })
    const double = CatalogWorkerDouble.instances.at(-1)!
    await client.read(Response.json(catalogWorkerCatalog()), true, 1, signal())
    await client.project(1, input(AGING_FRESH_NOW))
    double.holding.add('project')
    const pending = client.project(1, input(AGING_AT.asterStale))
    await double.settle()
    double.releaseOne('project', corrupt.missingStaleArray)
    await expect(pending).rejects.toMatchObject({ code: 'CATALOG_WORKER_FAILED' })
    double.dispatchEvent(new Event('error', { cancelable: true }))
    double.dispatchEvent(new Event('messageerror', { cancelable: true }))
    expect(onFailure).toHaveBeenCalledTimes(1)
    expect(double.terminate).toHaveBeenCalledTimes(1)
    expect(client.failed).toBe(true)
  })

  it('a fresh client after a failure receives a complete initial delivery and then only flags', async () => {
    const broken = await start()
    await broken.client.project(1, input(AGING_FRESH_NOW))
    broken.double.holding.add('project')
    const pending = broken.client.project(1, input(AGING_AT.asterStale))
    await broken.double.settle()
    broken.double.releaseOne('project', corrupt.absentCacheBase)
    await expect(pending).rejects.toMatchObject({ code: 'CATALOG_WORKER_FAILED' })

    const replacement = new CatalogWorkerClient(vi.fn())
    const double = CatalogWorkerDouble.instances.at(-1)!
    expect(double).not.toBe(broken.double)
    try {
      await replacement.read(Response.json(catalogWorkerCatalog()), true, 2, signal())
      const initial: CatalogProjection = await replacement.project(1, input(AGING_AT.asterStale))
      expect(projectedReplies(double)[0].jobs.map(job => job.id)).toEqual(AGING_JOB_IDS)
      expect(projectedReplies(double)[0].staleUpdates).toEqual([])
      expect(initial.catalog.jobs.map(job => job.stale)).toEqual([true, true, true, false, false, false, false, false, false])
      await replacement.project(1, input(AGING_AT.birchStale))
      expect(projectedReplies(double).at(-1)).toMatchObject({ jobs: [], staleUpdates: BIRCH_IDS.map(id => ({ id, stale: true })) })
      expect(CatalogWorkerDouble.instances).toHaveLength(2)
    } finally { replacement.dispose() }
  })
})
