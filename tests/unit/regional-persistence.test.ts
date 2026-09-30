import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createFileBoardCache } from '../../server/board-cache'
import { createCatalogService } from '../../server/catalog-service'
import { openSavedStore } from '../../src/lib/saved-store'
import type { SavedStore } from '../../src/lib/saved-store'
import {
  REGIONAL_COMPANY, regionalLegacyJob, regionalResolutionJob, regionalSavedDubai,
} from '../fixtures/regional-coverage'

const noNetwork = vi.fn(async () => { throw new Error('Only synthetic regional cache/saved reads are permitted.') })
beforeEach(() => { noNetwork.mockClear(); vi.stubGlobal('fetch', noNetwork) })
afterEach(() => { expect(noNetwork).not.toHaveBeenCalled(); vi.unstubAllGlobals() })

describe('regional migration through real persistence entry points', () => {
  it.each([4, 5])('reads a fictional v%s disk cache without collecting or changing source bytes, then saves an idempotent migration', async version => {
    const directory = await mkdtemp(path.join(tmpdir(), 'orbit-regional70-fictional-'))
    try {
      const jobs = [
        regionalLegacyJob('taipei', { locationLabel: 'Taipei, Taiwan' }),
        regionalLegacyJob('taiwan', { locationLabel: 'Taiwan' }),
        regionalLegacyJob('multi', { cityIds: ['london'], locationLabel: 'London, United Kingdom · Dubai, UAE' }),
      ]
      const original = {
        version, boards: [{
          companyId: 'regional-cedar', board: 'RegionalCedar70',
          ...(version === 5 ? { provider: 'greenhouse' } : {}),
          checkedAt: '2026-09-27T06:00:00.000Z', failures: 0, retryAt: null,
          snapshot: {
            fetchedAt: '2026-09-27T06:00:00.000Z', jobs, total: 6, unmappedCount: 5,
            publishedIds: [
              'greenhouse-regional-cedar-taipei', 'greenhouse-regional-cedar-taiwan',
              'greenhouse-regional-cedar-multi', 'greenhouse-regional-cedar-omitted-one',
              'greenhouse-regional-cedar-omitted-two', 'greenhouse-regional-cedar-omitted-three',
            ],
            observationMethod: 'observations-1.occupation-6.roles-1.qualifications-1.remote-2.employment-1.purpose-1',
          },
        }],
      }
      const currentFile = path.join(directory, 'fictional-current.json')
      const inputFile = version === 5 ? currentFile : path.join(directory, 'fictional-earlier.json')
      const bytes = JSON.stringify(original)
      await writeFile(inputFile, bytes)
      const cache = createFileBoardCache(currentFile, version === 4 ? [inputFile] : [], [REGIONAL_COMPANY])
      const fetchBoard = vi.fn(async () => { throw new Error('A fresh fictional cache must not recollect.') })
      const service = () => createCatalogService({
        companies: [REGIONAL_COMPANY], cache, fetchBoard,
        now: () => Date.parse('2026-09-27T06:00:10.000Z'), random: () => 0,
      })
      const catalog = await service().get()
      expect(catalog.jobs.map(job => job.cityIds)).toEqual([['taipei'], [], ['london', 'dubai']])
      expect(catalog.unmappedCount).toBe(4)
      expect(catalog.fetchedAt).toBe('2026-09-27T06:00:00.000Z')
      expect(catalog.jobs.map(job => [job.id, job.description, job.url, job.updatedAt, job.fetchedAt]))
        .toEqual(jobs.map(job => [job.id, job.description, job.url, job.updatedAt, job.fetchedAt]))
      expect(await readFile(inputFile, 'utf8')).toBe(bytes)
      expect(fetchBoard).not.toHaveBeenCalled()
      const upgraded = await cache.load()
      expect(upgraded[0].snapshot).toMatchObject({
        total: 6, unmappedCount: 4, fetchedAt: '2026-09-27T06:00:00.000Z',
        observationMethod: 'observations-1.occupation-6.roles-1.qualifications-1.remote-2.employment-1.purpose-1',
        publishedIds: [
          'greenhouse-regional-cedar-taipei', 'greenhouse-regional-cedar-taiwan',
          'greenhouse-regional-cedar-multi', 'greenhouse-regional-cedar-omitted-one',
          'greenhouse-regional-cedar-omitted-two', 'greenhouse-regional-cedar-omitted-three',
        ],
      })
      await cache.save(upgraded)
      const savedBytes = await readFile(currentFile, 'utf8')
      const restarted = await service().get()
      expect(restarted.jobs).toEqual(catalog.jobs)
      expect(restarted.unmappedCount).toBe(4)
      expect(await readFile(currentFile, 'utf8')).toBe(savedBytes)
      if (version === 4) expect(await readFile(inputFile, 'utf8')).toBe(bytes)
      expect(fetchBoard).not.toHaveBeenCalled()
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it.each(['legacy-key', 'indexeddb'] as const)('migrates older %s saved records, preserves a held conflict and keeps later notes through reopen', async source => {
    const factory = new IDBFactory()
    const name = 'regional70-fictional-saved'
    const original = [
      regionalSavedDubai(),
      { ...regionalSavedDubai(), job: regionalResolutionJob('conflict'), note: 'PRIVATE_REGIONAL70_HELD_CONFLICT' },
    ]
    const bytes = JSON.stringify(original)
    let legacyValue: string | null = source === 'legacy-key' ? bytes : null
    const legacy = {
      getItem: (key: string) => key === 'orbit.v1.saved' ? legacyValue : null,
      removeItem: (key: string) => { if (key === 'orbit.v1.saved') legacyValue = null },
    }
    if (source === 'indexeddb') {
      await new Promise<void>((resolve, reject) => {
        const opening = factory.open(name, 1)
        opening.onupgradeneeded = () => {
          const db = opening.result
          db.createObjectStore('records', { keyPath: 'id' })
          db.createObjectStore('meta', { keyPath: 'key' })
        }
        opening.onerror = () => reject(opening.error)
        opening.onsuccess = () => {
          const db = opening.result
          const tx = db.transaction(['records', 'meta'], 'readwrite')
          tx.objectStore('records').put({ id: original[0].job.id, order: 1, record: original[0] })
          tx.objectStore('records').put({ id: original[1].job.id, order: 2, record: original[1] })
          tx.objectStore('meta').put({ key: 'state', nextOrder: 3, legacyDigest: null })
          tx.oncomplete = () => { db.close(); resolve() }
          tx.onabort = () => { db.close(); reject(tx.error) }
        }
      })
    }
    const stores: SavedStore[] = []
    try {
      const store = await openSavedStore({ factory, name, legacy })
      stores.push(store)
      const first = await store.read()
      expect(first.recovery).toEqual([])
      expect(first.unreadableIds).toEqual([])
      expect(first.records).toHaveLength(2)
      const dubai = first.records.find(record => record.job.id === 'greenhouse-regional-cedar-dubai')!
      // The stored v6 assessment is re-read as v7 with the same title-only evidence and empty departments.
      expect(dubai).toEqual({
        ...original[0],
        job: { ...original[0].job, cityIds: ['dubai'], cityCoverageVersion: 1, occupation: { ...original[0].job.occupation, version: 7 } },
      })
      const held = first.records.find(record => record.job.id === 'greenhouse-regional-cedar-held-conflict')!
      expect(held.job.cityIds).toEqual([])
      expect(held.job.locationResolution).toEqual(original[1].job.locationResolution)
      expect(held.note).toBe('PRIVATE_REGIONAL70_HELD_CONFLICT')
      expect(legacyValue).toBeNull()
      expect(JSON.stringify(original)).toBe(bytes)
      await store.apply({
        kind: 'update', id: 'greenhouse-regional-cedar-dubai',
        patch: { note: 'PRIVATE_REGIONAL70_EDITED — 다음 면접 확인 🌿' },
      })
      store.close()
      const reopened = await openSavedStore({ factory, name, legacy })
      stores.push(reopened)
      const after = (await reopened.read()).records.find(record => record.job.id === 'greenhouse-regional-cedar-dubai')!
      expect(after).toEqual({ ...dubai, note: 'PRIVATE_REGIONAL70_EDITED — 다음 면접 확인 🌿' })
      expect(after).toMatchObject({
        status: 'applied', savedAt: '2026-09-26T20:00:00.000Z',
        job: {
          fetchedAt: '2026-09-27T06:00:00.000Z', updatedAt: '2026-09-26T18:30:00.000Z',
          url: 'https://example.test/regional/dubai', cityIds: ['dubai'], cityCoverageVersion: 1,
        },
      })
    } finally { stores.forEach(store => store.close()) }
  })
})
