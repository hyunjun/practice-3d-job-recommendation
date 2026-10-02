import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CatalogWorkerModel } from '../../src/lib/catalog-worker-model'
import { CatalogWorkerClient } from '../../src/lib/catalog-worker-client'
import { CATALOG_PROJECTION_PROTOCOL } from '../../src/lib/catalog-worker-types'
import type {
  CatalogProjectionPatch, CatalogViewInput, CatalogWorkerRequest, CatalogWorkerResponse,
} from '../../src/lib/catalog-worker-types'
import type { Filters } from '../../shared/types'
import {
  CATALOG_WORKER_FILTERS, CATALOG_WORKER_PROFILE, CATALOG_WORKER_TIME,
  catalogWorkerCatalog, catalogWorkerEmpty, catalogWorkerRevised, catalogWorkerSnapshot, catalogWorkerUpdate,
} from '../fixtures/catalog-worker'

const noNetwork = vi.fn(async () => { throw new Error('Worker unit verification must not contact a server.') })
beforeEach(() => { noNetwork.mockClear(); vi.stubGlobal('fetch', noNetwork) })
afterEach(() => { expect(noNetwork).not.toHaveBeenCalled(); vi.unstubAllGlobals(); vi.useRealTimers() })

const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).buffer
const input = (filters: Partial<Filters> = {}, changes: Partial<CatalogViewInput> = {}): CatalogViewInput => ({
  profile: CATALOG_WORKER_PROFILE, filters: { ...CATALOG_WORKER_FILTERS, ...filters },
  scope: { kind: 'cities' }, recover: true, collecting: false,
  now: Date.parse('2026-09-24T08:00:03.000Z'), ...changes,
})

async function decode(model: CatalogWorkerModel, value: unknown, initial = true, stream = 1, status = 200) {
  const result = await model.handle({ kind: 'decode', stream, initial, status, body: bytes(value) })
  if (result.kind !== 'decoded') throw new Error('Expected a decoded catalog receipt.')
  return result
}

async function project(model: CatalogWorkerModel, revision: number, value = input()): Promise<CatalogProjectionPatch> {
  // Stage79 protocol envelope only (docs/design/catalog-worker-aging.md); expectations are unchanged.
  const result = await model.handle({ kind: 'project', protocol: CATALOG_PROJECTION_PROTOCOL, revision, input: value })
  if (result.kind !== 'projected') throw new Error('Expected a catalog projection.')
  return result.value
}

describe('catalog worker protocol and user-visible projections', () => {
  it('decodes fictional binary JSON, preserves source timestamps/additive data, and agrees on raw, filtered and city counts', async () => {
    const model = new CatalogWorkerModel()
    const wire = catalogWorkerCatalog()
    Object.assign(wire.jobs[0], { fixtureMarker: 'public-wire-67' })
    const receipt = await decode(model, wire)
    expect(receipt).toEqual({
      kind: 'decoded', progress: null, value: {
        revision: 1,
        deadlines: [
          Date.parse('2026-09-24T08:30:00.000Z'), Date.parse('2026-09-24T08:30:01.000Z'),
          Date.parse('2026-09-24T08:30:02.000Z'), Date.parse('2026-09-25T08:00:00.001Z'),
          Date.parse('2026-09-25T08:00:01.001Z'), Date.parse('2026-09-25T08:00:02.001Z'),
        ],
      },
    })
    const result = await project(model, 1)
    expect(result.revision).toBe(1)
    expect(result.catalog).toMatchObject({
      source: 'public', fetchedAt: '2026-09-24T08:00:02.000Z', checkedAt: '2026-09-24T08:00:02.000Z',
      unmappedCount: 0,
      boards: [
        { companyId: 'catalog-worker-aster', included: 3, lastSuccessAt: '2026-09-24T08:00:00.000Z' },
        { companyId: 'catalog-worker-birch', included: 3, lastSuccessAt: '2026-09-24T08:00:01.000Z' },
        { companyId: 'catalog-worker-cedar', included: 3, lastSuccessAt: '2026-09-24T08:00:02.000Z' },
      ],
    })
    expect(result.jobs.map(job => job.title)).toEqual([
      'Backend Engineer — Atlas Alpha', 'Frontend Engineer — Beacon Berlin', 'Backend Engineer — Beacon Remote UK',
      'Backend Engineer — Beacon London', 'Backend Engineer — Beacon Berlin', 'Frontend Engineer — Atlas Canvas',
      'Backend Engineer — Beacon London Final', 'Frontend Engineer — Beacon Berlin Final', 'Backend Engineer — Beacon Remote US',
    ])
    expect(result.jobs[0]).toMatchObject({
      id: 'greenhouse-catalog-worker-aster-atlas', fixtureMarker: 'public-wire-67',
      fetchedAt: '2026-09-24T08:00:00.000Z', role: 'backend',
    })
    expect(result.jobIds).toEqual([
      'greenhouse-catalog-worker-aster-atlas', 'greenhouse-catalog-worker-aster-berlin',
      'greenhouse-catalog-worker-aster-remote-uk', 'greenhouse-catalog-worker-birch-london',
      'greenhouse-catalog-worker-birch-berlin', 'greenhouse-catalog-worker-birch-canvas',
      'greenhouse-catalog-worker-cedar-london', 'greenhouse-catalog-worker-cedar-berlin',
      'greenhouse-catalog-worker-cedar-remote-us',
    ])
    expect(result.matchIds).toHaveLength(8)
    expect(result.companyCount).toBe(3)
    expect(result.cities.map(city => ({ id: city.id, companies: city.companyCount, jobs: city.matchIds.length }))).toEqual([
      { id: 'london', companies: 3, jobs: 4 }, { id: 'berlin', companies: 3, jobs: 3 },
    ])
    expect(result.remoteIds).toEqual(['greenhouse-catalog-worker-aster-remote-uk'])
    expect(result.unmappedIds).toEqual([])
    expect(result.removed).toEqual([])
    expect(result.expired).toBe(false)
    expect(result.recovery).toBeNull()
    expect(result.facts.every(fact => !('job' in fact) && !('company' in fact) && !('description' in fact))).toBe(true)
  })

  it('sends only newly arrived normalized job bodies after each company delta', async () => {
    const model = new CatalogWorkerModel()
    await decode(model, catalogWorkerSnapshot(), true, 1, 202)
    const first = await project(model, 1, input({}, { collecting: true }))
    expect(first.jobs.map(job => job.id)).toEqual([
      'greenhouse-catalog-worker-aster-atlas', 'greenhouse-catalog-worker-aster-berlin', 'greenhouse-catalog-worker-aster-remote-uk',
    ])
    await model.handle({ kind: 'acknowledge', revision: 1 })
    await decode(model, catalogWorkerUpdate(2), false)
    const second = await project(model, 2, input({}, { collecting: true }))
    expect.soft(second.jobs.map(job => job.id), 'Previously accepted Aster jobs must not cross the boundary again.').toEqual([
      'greenhouse-catalog-worker-birch-london', 'greenhouse-catalog-worker-birch-berlin', 'greenhouse-catalog-worker-birch-canvas',
    ])
    expect(second.catalog.boards.map(board => board.included)).toEqual([3, 3, 0])
    await model.handle({ kind: 'acknowledge', revision: 2 })
    await decode(model, catalogWorkerUpdate(3), false)
    const final = await project(model, 3)
    expect.soft(final.jobs.map(job => job.id), 'Unchanged Aster and Birch bodies must remain reusable.').toEqual([
      'greenhouse-catalog-worker-cedar-london', 'greenhouse-catalog-worker-cedar-berlin', 'greenhouse-catalog-worker-cedar-remote-us',
    ])
    expect(final.catalog.boards.map(board => board.included)).toEqual([3, 3, 3])
    expect(final.jobIds).toHaveLength(9)
    expect(final.matchIds).toHaveLength(8)
    expect(final.removed).toEqual([])
  })

  it('upgrades an old qualification snapshot before search without turning company-stack text into an applicant skill', async () => {
    const model = new CatalogWorkerModel()
    const wire = catalogWorkerCatalog()
    Object.assign(wire.jobs[0], {
      qualifications: undefined, skills: ['React', 'TypeScript', 'Python', 'Go'], minExperience: 1,
      description: 'About us\nOur user interface uses React.\n\nRequirements\nExperience with TypeScript or Python.\nAt least 4 years of experience.\n\nNice to have\nExperience with Go.',
      requirements: ['Experience with TypeScript or Python.', 'At least 4 years of experience.'],
    })
    await decode(model, wire)
    const typed = await project(model, 1, input({ query: 'Atlas Alpha' }))
    expect(typed.matchIds).toEqual(['greenhouse-catalog-worker-aster-atlas'])
    expect(typed.jobs.find(job => job.id === 'greenhouse-catalog-worker-aster-atlas')).toMatchObject({
      title: 'Backend Engineer — Atlas Alpha', fetchedAt: '2026-09-24T08:00:00.000Z',
      minExperience: 4, skills: ['TypeScript', 'Python', 'Go'],
      qualifications: { skills: [
        { kind: 'required', skills: ['TypeScript', 'Python'], match: 'any' },
        { kind: 'preferred', skills: ['Go'] },
      ] },
    })
    const companyStackOnly = await project(model, 1, input({ query: 'Atlas Alpha' }, {
      profile: { ...CATALOG_WORKER_PROFILE, skills: ['React'] },
    }))
    expect(companyStackOnly.matchIds).toEqual([])
    expect(companyStackOnly.jobs).toEqual([])
    expect(wire.jobs[0]).toMatchObject({ qualifications: undefined, minExperience: 1, skills: ['React', 'TypeScript', 'Python', 'Go'] })
  })

  it('changes query results and exact recovery counts without cloning full job bodies again', async () => {
    const model = new CatalogWorkerModel()
    await decode(model, catalogWorkerCatalog())
    await project(model, 1)
    const london = await project(model, 1, input({ query: 'Beacon London', role: 'backend' }))
    expect(london.jobs).toEqual([])
    expect(london.facts).toEqual([])
    expect(london.matchIds).toEqual(['greenhouse-catalog-worker-cedar-london', 'greenhouse-catalog-worker-birch-london'])
    expect(london.cities).toMatchObject([{
      id: 'london', companyCount: 2,
      matchIds: ['greenhouse-catalog-worker-cedar-london', 'greenhouse-catalog-worker-birch-london'],
    }])
    const missing = await project(model, 1, input({ query: 'PRIVATE_CATALOG_WORKER_QUERY', role: 'backend' }, {
      scope: { kind: 'city', cityId: 'london' },
    }))
    expect(missing.jobs).toEqual([])
    expect(missing.matchIds).toEqual([])
    expect(missing.cities).toEqual([])
    expect(missing.recovery).toMatchObject({
      available: 4, profileExcluded: 0,
      suggestions: [{ changes: { query: '' }, count: { jobs: 3, companies: 3, cities: 1 } }],
      alternatives: [],
    })
    expect(missing.recovery?.suggestions).toHaveLength(1)
    const restored = await project(model, 1, input({ query: 'Beacon London', role: 'backend' }))
    expect(restored.matchIds).toEqual(['greenhouse-catalog-worker-cedar-london', 'greenhouse-catalog-worker-birch-london'])
    expect(restored.jobs).toEqual([])
  })

  it('new profile experience changes literal ranking and residence changes remote eligibility without replacing catalog jobs', async () => {
    const model = new CatalogWorkerModel()
    await decode(model, catalogWorkerCatalog())
    const original = await project(model, 1, input({ query: 'Beacon London', role: 'backend' }))
    expect(original.matchIds).toEqual(['greenhouse-catalog-worker-cedar-london', 'greenhouse-catalog-worker-birch-london'])
    const edited = await project(model, 1, input({ query: 'Beacon London', role: 'backend' }, {
      profile: { ...CATALOG_WORKER_PROFILE, years: 9 },
    }))
    expect(edited.jobs).toEqual([])
    expect(edited.matchIds).toEqual(['greenhouse-catalog-worker-birch-london', 'greenhouse-catalog-worker-cedar-london'])
    expect(edited.facts.find(fact => fact.id === 'greenhouse-catalog-worker-birch-london')?.reasons)
      .toContain('입력 경력 9년 · 공고에서 확인한 연수 하한 7년')
    const uk = await project(model, 1, input({ query: 'Beacon Remote', role: 'backend' }, { scope: { kind: 'remote' } }))
    expect(uk.remoteIds).toEqual(['greenhouse-catalog-worker-aster-remote-uk'])
    const us = await project(model, 1, input({ query: 'Beacon Remote', role: 'backend' }, {
      scope: { kind: 'remote' }, profile: { ...CATALOG_WORKER_PROFILE, residence: 'US' },
    }))
    expect(us.remoteIds).toEqual(['greenhouse-catalog-worker-cedar-remote-us'])
    expect(us.matchIds).toEqual(['greenhouse-catalog-worker-cedar-remote-us'])
    expect(us.jobs).toEqual([])
    expect(us.catalog.fetchedAt).toBe('2026-09-24T08:00:02.000Z')
  })

  it('previews the requested draft and catalog revision without consuming the next job patch', async () => {
    const model = new CatalogWorkerModel()
    await decode(model, catalogWorkerSnapshot(), true, 1, 202)
    const preview = (revision: number, filters: Partial<Filters>) => model.handle({
      kind: 'preview', revision, profile: CATALOG_WORKER_PROFILE,
      filters: { ...CATALOG_WORKER_FILTERS, query: 'Beacon', role: 'backend', ...filters },
      now: Date.parse(CATALOG_WORKER_TIME),
    })
    expect(await preview(1, { employment: 'fulltime' })).toEqual({ kind: 'previewed', count: 0 })
    expect((await project(model, 1, input({}, { collecting: true }))).jobs).toHaveLength(3)
    await model.handle({ kind: 'acknowledge', revision: 1 })
    await decode(model, catalogWorkerUpdate(2), false)
    expect(await preview(2, { employment: 'fulltime' })).toEqual({ kind: 'previewed', count: 2 })
    expect(await preview(2, { employment: 'fulltime', salaryMin: 200000, includeUnknownSalary: false }))
      .toEqual({ kind: 'previewed', count: 1 })
    await decode(model, catalogWorkerUpdate(3), false)
    expect(await preview(3, { employment: 'fulltime', salaryMin: 200000, includeUnknownSalary: false }))
      .toEqual({ kind: 'previewed', count: 2 })
    expect(await preview(3, { employment: 'fulltime', salaryMin: 250000, includeUnknownSalary: false }))
      .toEqual({ kind: 'previewed', count: 0 })
    expect(await preview(1, { employment: 'fulltime' })).toEqual({ kind: 'previewed', count: 0 })
  })

  it('uses explicit main time, including exactly 24h versus 24h+1ms, despite a different worker wall clock', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2030-01-01T00:00:00.000Z'))
    const model = new CatalogWorkerModel()
    await decode(model, catalogWorkerCatalog())
    const filters = { query: 'Beacon London', role: 'backend' as const }
    const fresh = await project(model, 1, input(filters))
    expect(fresh.matchIds).toEqual(['greenhouse-catalog-worker-cedar-london', 'greenhouse-catalog-worker-birch-london'])
    expect(fresh.expired).toBe(false)
    const boundary = await project(model, 1, input(filters, { now: Date.parse('2026-09-25T08:00:02.000Z') }))
    expect(boundary.matchIds).toEqual(['greenhouse-catalog-worker-cedar-london'])
    expect(boundary.catalog.boards.map(board => board.included)).toEqual([0, 0, 3])
    expect(boundary.expired).toBe(false)
    const expired = await project(model, 1, input(filters, { now: Date.parse('2026-09-25T08:00:02.001Z') }))
    expect(expired.expired).toBe(true)
    expect(expired.catalog.fetchedAt).toBe('')
    expect(expired.catalog.boards.map(board => ({ included: board.included, status: board.dataStatus }))).toEqual([
      { included: 0, status: 'unavailable' }, { included: 0, status: 'unavailable' }, { included: 0, status: 'unavailable' },
    ])
    expect(expired.catalog.boards.map(board => board.lastSuccessAt)).toEqual([
      '2026-09-24T08:00:00.000Z', '2026-09-24T08:00:01.000Z', '2026-09-24T08:00:02.000Z',
    ])
    expect(expired.jobIds).toEqual([])
    expect(expired.matchIds).toEqual([])
    expect(expired.cities).toEqual([])
    expect(expired.recovery).toBeNull()
  })

  it('pins the acknowledged catalog through abandoned newer loads and rejects obsolete collection streams', async () => {
    const model = new CatalogWorkerModel()
    await decode(model, catalogWorkerCatalog())
    await project(model, 1)
    await model.handle({ kind: 'acknowledge', revision: 1 })
    await decode(model, catalogWorkerRevised(), true, 2)
    await project(model, 2)
    await decode(model, catalogWorkerEmpty(), true, 3)
    await project(model, 3)
    await decode(model, catalogWorkerRevised(), true, 4)
    const retained = await project(model, 1, input({ query: 'Atlas Alpha' }))
    expect(retained.revision).toBe(1)
    expect(retained.catalog.fetchedAt).toBe('2026-09-24T08:00:02.000Z')
    expect(retained.matchIds).toEqual(['greenhouse-catalog-worker-aster-atlas'])
    expect(retained.jobs.find(job => job.id === 'greenhouse-catalog-worker-aster-atlas')).toMatchObject({
      title: 'Backend Engineer — Atlas Alpha', fetchedAt: '2026-09-24T08:00:00.000Z',
    })
    await expect(project(model, 2)).rejects.toMatchObject({ code: 'CATALOG_SUPERSEDED' })
    await expect(decode(model, catalogWorkerUpdate(3), false, 1)).rejects.toMatchObject({ code: 'CATALOG_SUPERSEDED' })
  })

  it('rejects an inconsistent delta without advancing or erasing the accepted catalog, then accepts a valid retry', async () => {
    const model = new CatalogWorkerModel()
    await decode(model, catalogWorkerSnapshot(), true, 1, 202)
    await project(model, 1)
    await model.handle({ kind: 'acknowledge', revision: 1 })
    const invalid = catalogWorkerUpdate(2)
    invalid.catalog.boards[1].included = 4
    invalid.catalog.boards[1].total = 4
    await expect(decode(model, invalid, false)).rejects.toThrow('공고 데이터 형식을 확인하지 못했어요. 다시 조회해 주세요.')
    const retained = await project(model, 1, input({ query: 'Atlas Alpha' }))
    expect(retained.catalog.boards.map(board => board.included)).toEqual([3, 0, 0])
    expect(retained.matchIds).toEqual(['greenhouse-catalog-worker-aster-atlas'])
    const retry = await decode(model, catalogWorkerUpdate(2), false)
    expect(retry.value.revision).toBe(2)
    expect((await project(model, 2)).catalog.boards.map(board => board.included)).toEqual([3, 3, 0])
  })

  it('distinguishes invalid JSON, server retry metadata, and a validated empty successful catalog', async () => {
    const model = new CatalogWorkerModel()
    await expect(model.handle({
      kind: 'decode', stream: 1, initial: true, status: 200,
      body: new TextEncoder().encode('{"source":"public","jobs":[').buffer,
    })).rejects.toThrow('공고 데이터 형식을 확인하지 못했어요. 다시 조회해 주세요.')
    await expect(decode(model, {
      error: 'Fictional catalog unavailable.', code: 'CATALOG_EXPIRED', retryAt: '2026-09-24T08:02:00.000Z',
    }, true, 2, 503)).rejects.toMatchObject({
      message: 'Fictional catalog unavailable.', code: 'CATALOG_EXPIRED', retryAt: '2026-09-24T08:02:00.000Z',
    })
    await decode(model, catalogWorkerEmpty(), true, 3)
    const empty = await project(model, 1, input({ query: 'Beacon' }))
    expect(empty.catalog.fetchedAt).toBe('2026-09-24T08:00:02.000Z')
    expect(empty.jobIds).toEqual([])
    expect(empty.matchIds).toEqual([])
    expect(empty.companyCount).toBe(0)
    expect(empty.expired).toBe(false)
    expect(empty.recovery).toEqual({ available: 0, profileExcluded: 0, suggestions: [], alternatives: [] })
  })
})

// The client double preserves structured-clone/transfer and FIFO delivery. It
// runs the real model; it neither derives expected counts nor fabricates results.
class WorkerDouble extends EventTarget {
  static instances: WorkerDouble[] = []
  readonly model = new CatalogWorkerModel()
  readonly commands: CatalogWorkerRequest[] = []
  readonly transfers: number[] = []
  readonly terminate = vi.fn()
  hold = false
  private queue = Promise.resolve()
  constructor(readonly url: URL, readonly options: WorkerOptions) { super(); WorkerDouble.instances.push(this) }
  postMessage(message: CatalogWorkerRequest, transfer: Transferable[] = []) {
    this.transfers.push(transfer.length)
    const copied = structuredClone(message, { transfer })
    this.commands.push(copied)
    if (this.hold) return
    this.queue = this.queue.then(async () => {
      let response: CatalogWorkerResponse
      try { response = { id: copied.id, result: await this.model.handle(copied.command) } }
      catch (error) {
        const cause = error as Error & { code?: string; retryAt?: string }
        response = { id: copied.id, error: { message: cause.message, code: cause.code, retryAt: cause.retryAt } }
      }
      this.dispatchEvent(new MessageEvent('message', { data: structuredClone(response) }))
    })
  }
}

describe('catalog worker client transfer, hydration and recovery boundary', () => {
  beforeEach(() => { WorkerDouble.instances = []; vi.stubGlobal('Worker', WorkerDouble) })

  it('transfers the binary response once and hydrates later ID-only queries with matching metadata and titles', async () => {
    const failed = vi.fn()
    const client = new CatalogWorkerClient(failed)
    try {
      const response = Response.json(catalogWorkerCatalog())
      const body = await response.arrayBuffer()
      vi.spyOn(response, 'arrayBuffer').mockResolvedValue(body)
      const receipt = await client.read(response, true, 1, new AbortController().signal)
      expect(body.byteLength).toBe(0)
      const worker = WorkerDouble.instances[0]
      expect(worker.options).toMatchObject({ type: 'module', name: 'orbit-catalog' })
      expect(worker.transfers).toEqual([1])
      expect(worker.commands[0].command).toMatchObject({ kind: 'decode', stream: 1, initial: true, status: 200 })
      const first = await client.project(receipt.value.revision, input())
      expect(first.catalog.jobs).toHaveLength(9)
      const latest = await client.project(receipt.value.revision, input({ query: 'Beacon London', role: 'backend' }))
      expect(latest.revision).toBe(1)
      expect(latest.catalog.jobs).toHaveLength(9)
      expect(latest.matches.map(match => ({ id: match.job.id, title: match.job.title, company: match.company.name }))).toEqual([
        { id: 'greenhouse-catalog-worker-cedar-london', title: 'Backend Engineer — Beacon London Final', company: 'Cedar QA Works' },
        { id: 'greenhouse-catalog-worker-birch-london', title: 'Backend Engineer — Beacon London', company: 'Birch QA Systems' },
      ])
      expect(latest.cities.map(city => ({ id: city.city.id, count: city.companyCount, jobs: city.matches.length })))
        .toEqual([{ id: 'london', count: 2, jobs: 2 }])
      expect(latest.catalog.fetchedAt).toBe('2026-09-24T08:00:02.000Z')
      expect(worker.transfers).toEqual([1, 0, 0])
      expect(failed).not.toHaveBeenCalled()
    } finally { client.dispose() }
  })

  for (const event of ['error', 'messageerror']) it(`${event} rejects every pending request, reports once, and permits a new client to recover`, async () => {
    const failed = vi.fn()
    const client = new CatalogWorkerClient(failed)
    const worker = WorkerDouble.instances[0]
    worker.hold = true
    const projecting = client.project(1, input())
    const previewing = client.preview(1, CATALOG_WORKER_PROFILE, CATALOG_WORKER_FILTERS, Date.parse(CATALOG_WORKER_TIME))
    const settled = Promise.allSettled([projecting, previewing])
    worker.dispatchEvent(new Event(event, { cancelable: true }))
    worker.dispatchEvent(new Event(event, { cancelable: true }))
    expect((await settled).map(result => result.status === 'rejected' ? result.reason.code : 'unexpected success'))
      .toEqual(['CATALOG_WORKER_FAILED', 'CATALOG_WORKER_FAILED'])
    expect(client.failed).toBe(true)
    expect(worker.terminate).toHaveBeenCalledOnce()
    expect(failed).toHaveBeenCalledOnce()
    await expect(client.preview(1, CATALOG_WORKER_PROFILE, CATALOG_WORKER_FILTERS, 0))
      .rejects.toMatchObject({ code: 'CATALOG_WORKER_FAILED' })
    const retry = new CatalogWorkerClient(failed)
    try {
      const receipt = await retry.read(Response.json(catalogWorkerCatalog()), true, 2, new AbortController().signal)
      const result = await retry.project(receipt.value.revision, input({ query: 'Atlas Alpha' }))
      expect(result.matches.map(match => match.job.title)).toEqual(['Backend Engineer — Atlas Alpha'])
      expect(result.catalog.jobs).toHaveLength(9)
      expect(WorkerDouble.instances).toHaveLength(2)
      expect(failed).toHaveBeenCalledOnce()
    } finally { retry.dispose() }
  })

  it('fails explicitly when workers are unavailable and never attempts synchronous model work or network fallback', () => {
    vi.stubGlobal('Worker', undefined)
    expect(() => new CatalogWorkerClient(vi.fn())).toThrow('공고 처리 연결이 끊겼어요.')
    expect(WorkerDouble.instances).toEqual([])
  })

  it('an already cancelled read transfers no data and disposal rejects pending work as cancelled', async () => {
    const failed = vi.fn()
    const client = new CatalogWorkerClient(failed)
    const controller = new AbortController()
    controller.abort()
    await expect(client.read(Response.json(catalogWorkerCatalog()), true, 1, controller.signal))
      .rejects.toMatchObject({ name: 'AbortError' })
    const worker = WorkerDouble.instances[0]
    expect(worker.commands).toEqual([])
    worker.hold = true
    const pending = client.project(1, input())
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    client.dispose()
    await rejected
    expect(worker.terminate).toHaveBeenCalledOnce()
    expect(failed).not.toHaveBeenCalled()
  })

  it('a stalled worker stops every pending operation at the explicit 150-second boundary', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const failed = vi.fn()
    const client = new CatalogWorkerClient(failed)
    const worker = WorkerDouble.instances[0]
    worker.hold = true
    const completed = Promise.allSettled([
      client.project(1, input()),
      client.preview(1, CATALOG_WORKER_PROFILE, CATALOG_WORKER_FILTERS, Date.parse(CATALOG_WORKER_TIME)),
    ])
    await vi.advanceTimersByTimeAsync(149999)
    expect(client.failed).toBe(false)
    expect(failed).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect((await completed).map(result => result.status === 'rejected' ? result.reason.code : 'unexpected success'))
      .toEqual(['CATALOG_WORKER_FAILED', 'CATALOG_WORKER_FAILED'])
    expect(client.failed).toBe(true)
    expect(worker.terminate).toHaveBeenCalledOnce()
    expect(failed).toHaveBeenCalledOnce()
  })

  it('an unreturned acknowledgement cannot fail an otherwise usable catalog after the page clock advances', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const failed = vi.fn()
    const client = new CatalogWorkerClient(failed)
    try {
      const receipt = await client.read(Response.json(catalogWorkerCatalog()), true, 1, new AbortController().signal)
      const ready = await client.project(receipt.value.revision, input({ query: 'Atlas Alpha' }))
      expect(ready.matches.map(match => match.job.title)).toEqual(['Backend Engineer — Atlas Alpha'])
      const worker = WorkerDouble.instances[0]
      worker.hold = true
      client.acknowledge(receipt.value.revision)
      await vi.advanceTimersByTimeAsync(300000)
      expect(client.failed).toBe(false)
      expect(failed).not.toHaveBeenCalled()
      expect(worker.terminate).not.toHaveBeenCalled()
      worker.hold = false
      expect(await client.preview(1, CATALOG_WORKER_PROFILE, {
        ...CATALOG_WORKER_FILTERS, query: 'Beacon London', role: 'backend',
      }, Date.parse('2026-09-24T08:00:03.000Z'))).toBe(2)
    } finally { client.dispose() }
  })
})
