import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { createFileBoardCache, MAX_BOARD_CACHE_BYTES } from '../../server/board-cache'
import type { CachedBoard } from '../../server/board-cache'
import { CAREERS_NOW, careersCachedJob, careersCompany } from '../fixtures/careers-contract'

// Never allocate a large file or read an actual cache. Capacity tests intercept
// the filesystem boundary; serialization and UTF-8 accounting remain real.
vi.mock('node:fs/promises', () => ({
  mkdir: vi.fn(async () => undefined), readFile: vi.fn(), rename: vi.fn(async () => undefined),
  rm: vi.fn(async () => undefined), stat: vi.fn(), writeFile: vi.fn(async () => undefined),
}))
afterEach(() => vi.clearAllMocks())
const file = '.local/research/64-expansion/independent/cache-capacity-synthetic/cache.json'
const cache = () => createFileBoardCache(file, ['synthetic-legacy-cache.json'], [careersCompany('booking')])

describe('128 MiB full-cache budget with no partial writes or legacy resurrection', () => {
  it('uses the literal 128 MiB limit and accepts an at-limit stat before parsing a valid body', async () => {
    expect(MAX_BOARD_CACHE_BYTES).toBe(134_217_728)
    vi.mocked(stat).mockResolvedValue({ size: 134_217_728 } as Awaited<ReturnType<typeof stat>>)
    vi.mocked(readFile).mockResolvedValue('{"version":5,"boards":[]}')
    expect(await cache().load()).toEqual([])
    expect(readFile).toHaveBeenCalledExactlyOnceWith(file, 'utf8')
    expect(stat).toHaveBeenCalledExactlyOnceWith(file)
  })

  it('rejects an oversized stat before reading bytes and does not fall back to an older cache', async () => {
    vi.mocked(stat).mockResolvedValue({ size: 134_217_729 } as Awaited<ReturnType<typeof stat>>)
    expect(await cache().load()).toEqual([])
    expect(readFile).not.toHaveBeenCalled()
    expect(stat).toHaveBeenCalledExactlyOnceWith(file)
  })

  it('checks actual UTF-8 bytes again if the file grows after stat', async () => {
    vi.mocked(stat).mockResolvedValue({ size: 100 } as Awaited<ReturnType<typeof stat>>)
    vi.mocked(readFile).mockResolvedValue('é'.repeat(67_108_865))
    expect(await cache().load()).toEqual([])
    expect(readFile).toHaveBeenCalledExactlyOnceWith(file, 'utf8')
    expect(stat).toHaveBeenCalledExactlyOnceWith(file)
  })

  it('rejects a multibyte save over 128 MiB before mkdir, temp writes, rename or cleanup', async () => {
    // 2,700 valid-length descriptions share one source string in memory.
    // They serialize to >135 MB UTF-8 while the JSON character count is <128 Mi.
    const body = 'é'.repeat(25_000)
    const template = careersCachedJob()
    const jobs = Array.from({ length: 2700 }, (_, index) => ({
      ...template, id: `careers-booking-${643000 + index}`, description: body,
    }))
    const boards: CachedBoard[] = [{
      companyId: 'booking', provider: 'careers', board: 'booking',
      checkedAt: CAREERS_NOW, failures: 0, retryAt: null,
      snapshot: { fetchedAt: CAREERS_NOW, total: 2700, unmappedCount: 0, jobs, publishedIds: jobs.map(job => job.id) },
    }]
    await expect(cache().save(boards)).rejects.toThrow('Board cache exceeds the size limit')
    expect(mkdir).not.toHaveBeenCalled()
    expect(writeFile).not.toHaveBeenCalled()
    expect(rename).not.toHaveBeenCalled()
    expect(rm).not.toHaveBeenCalled()
    expect(readFile).not.toHaveBeenCalled()
  })
})
