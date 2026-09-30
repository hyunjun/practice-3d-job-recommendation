import { vi } from 'vitest'
import { BoardFetchError, createCatalogService } from '../../../server/catalog-service'
import type { BoardResult } from '../../../server/catalog-service'
import type { CachedBoard } from '../../../server/board-cache'
import { createObservationStore } from '../../../server/catalog-observations'
import type { ObservationCache } from '../../../server/catalog-observations'
import type { CachedPresence, PresenceResult } from '../../../server/posting-presence'
import type { Company } from '../../../shared/types'
import { contentResult, presenceResult, PROVENANCE_BASE, PROVENANCE_COMPANIES } from '../../fixtures/board-status-provenance'

/**
 * The real catalog service over memory caches with an injected clock. Provider
 * calls are recorded per company so tests can assert exact request counts.
 */
export function memoryRecords<T>(initial: T[] = []) {
  let records = structuredClone(initial)
  return {
    load: vi.fn(async () => structuredClone(records)),
    save: vi.fn(async (next: T[]) => { records = structuredClone(next) }),
    value: () => structuredClone(records),
  }
}

export function observationMemory(): ObservationCache & { saves: () => number } {
  let value: unknown = { version: 1, series: [] }
  let saves = 0
  return {
    load: async () => structuredClone(value),
    save: async next => { value = structuredClone(next); saves++ },
    saves: () => saves,
  }
}

export function gate() {
  let release!: () => void
  const promise = new Promise<void>(resolve => { release = resolve })
  return { promise, release }
}

export function provenanceHarness(options: {
  bodies?: CachedBoard[]
  presences?: CachedPresence[]
  at?: string
  companies?: Company[]
} = {}) {
  let time = Date.parse(options.at ?? PROVENANCE_BASE)
  const companies = options.companies ?? PROVENANCE_COMPANIES
  const cache = memoryRecords<CachedBoard>(options.bodies)
  const presenceCache = memoryRecords<CachedPresence>(options.presences)
  const observationCache = observationMemory()
  const fetchBoard = vi.fn(async (company: Company, fetchedAt: string): Promise<BoardResult> => contentResult(company, fetchedAt))
  const fetchPresence = vi.fn(async (company: Company): Promise<PresenceResult> => presenceResult(company))
  const now = () => time
  return {
    companies, cache, presenceCache, observationCache, fetchBoard, fetchPresence, now,
    /** A fresh service instance over the same persisted records, like a process restart. */
    start: () => createCatalogService({
      companies, cache, fetchBoard, presence: { cache: presenceCache, fetchBoard: fetchPresence },
      observations: createObservationStore({ companies, cache: observationCache, now }), now, random: () => 0,
    }),
    at: (value: string) => { time = Date.parse(value) },
    bodyCalls: () => fetchBoard.mock.calls.map(([company]) => company.id),
    listCalls: () => fetchPresence.mock.calls.map(([company]) => company.id),
    /** Make one company's public-list check fail, optionally with a provider Retry-After deadline. */
    failList(companyId: string, message: string, retryAfter?: string) {
      fetchPresence.mockImplementation(async company => {
        if (company.id !== companyId) return presenceResult(company)
        throw retryAfter ? new BoardFetchError(message, Date.parse(retryAfter)) : new Error(message)
      })
    },
    failEveryList(message: string) {
      fetchPresence.mockImplementation(async () => { throw new Error(message) })
    },
    /**
     * Hold the named companies' body collections until released. Every company
     * keeps the currently mocked result, so held and unheld bodies stay literal.
     * Hold every company in a run before asserting its pending snapshot: an
     * unheld company's collection continuation runs before the snapshot composes.
     */
    holdBody(...companyIds: string[]) {
      const held = gate()
      const current = fetchBoard.getMockImplementation()
        ?? (async (company: Company, fetchedAt: string) => contentResult(company, fetchedAt))
      fetchBoard.mockImplementation(async (company, fetchedAt) => {
        if (companyIds.includes(company.id)) await held.promise
        return current(company, fetchedAt)
      })
      return held
    },
  }
}

export type ProvenanceHarness = ReturnType<typeof provenanceHarness>
