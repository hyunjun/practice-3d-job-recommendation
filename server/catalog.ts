import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { CITIES } from '../shared/cities'
import { PUBLIC_COMPANIES } from '../shared/companies'
import type { BoardStatus, Catalog, Company } from '../shared/types'
import { normalizeJob } from './normalize'
import type { GreenhouseJob } from './normalize'

const CACHE_FILE = path.resolve('.local/greenhouse-cache-v3.json')
const CACHE_TTL = 30 * 60 * 1000
let cache: Catalog | null = null
let pending: Promise<Catalog> | null = null
let lastAttempt = 0

async function loadCache(): Promise<void> {
  if (cache) return
  try {
    const candidate = JSON.parse(await readFile(CACHE_FILE, 'utf8')) as Catalog
    if (candidate.source === 'greenhouse' && Array.isArray(candidate.jobs) && Array.isArray(candidate.boards) && Array.isArray(candidate.companies) && Array.isArray(candidate.cities)) cache = candidate
  } catch { /* The cache is optional; a network fetch will populate it. */ }
}

async function fetchBoard(company: Company, fetchedAt: string): Promise<{ jobs: Catalog['jobs']; board: BoardStatus; unmapped: number }> {
  const board = company.board!
  try {
    const response = await fetch(`https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(board)}/jobs?content=true`, {
      signal: AbortSignal.timeout(18000),
      headers: { Accept: 'application/json', 'User-Agent': 'OrbitCareerAtlas/1.0 (local career explorer)' },
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const payload = await response.json() as { jobs?: GreenhouseJob[] }
    if (!Array.isArray(payload.jobs)) throw new Error('예상하지 못한 게시판 응답')
    const normalized = payload.jobs.map(job => normalizeJob(job, company.id, fetchedAt)).filter(job => job !== null)
    const unmapped = normalized.filter(job => job.workMode !== 'remote' && !job.cityIds.length).length
    // Unknown or out-of-coverage physical locations are counted explicitly, never pinned to HQ.
    const jobs = normalized.filter(job => job.workMode === 'remote' || job.cityIds.length > 0)
    return { jobs, unmapped, board: { companyId: company.id, board, status: 'ok', total: payload.jobs.length, included: jobs.length } }
  } catch (error) {
    return { jobs: [], unmapped: 0, board: { companyId: company.id, board, status: 'error', total: 0, included: 0, message: error instanceof Error ? error.message : '조회 실패' } }
  }
}

async function refreshCatalog(): Promise<Catalog> {
  lastAttempt = Date.now()
  const fetchedAt = new Date().toISOString()
  const results: Awaited<ReturnType<typeof fetchBoard>>[] = []
  // Limit request concurrency and keep each public board's status visible.
  for (let index = 0; index < PUBLIC_COMPANIES.length; index += 4) {
    results.push(...await Promise.all(PUBLIC_COMPANIES.slice(index, index + 4).map(company => fetchBoard(company, fetchedAt))))
  }
  if (results.every(result => result.board.status === 'error')) {
    if (cache) return { ...cache, stale: true, boards: results.map(result => result.board) }
    throw new Error('공개 채용 게시판에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요.')
  }
  const jobs = [...new Map(results.flatMap(result => result.jobs).map(job => [job.id, job])).values()]
  const result: Catalog = {
    source: 'greenhouse', fetchedAt, stale: false, companies: PUBLIC_COMPANIES, cities: CITIES,
    jobs, boards: results.map(result => result.board),
    unmappedCount: results.reduce((total, item) => total + item.unmapped, 0),
  }
  cache = result
  try {
    await mkdir(path.dirname(CACHE_FILE), { recursive: true })
    const temporary = `${CACHE_FILE}.tmp`
    await writeFile(temporary, JSON.stringify(result), 'utf8')
    await rename(temporary, CACHE_FILE)
  } catch (error) {
    console.warn('Public job cache could not be written:', error instanceof Error ? error.message : error)
  }
  return result
}

export async function getPublicCatalog(refresh = false): Promise<Catalog> {
  await loadCache()
  if (pending) return pending
  if (cache && !refresh && Date.now() - Date.parse(cache.fetchedAt) < CACHE_TTL) return cache
  if (cache && Date.now() - lastAttempt < 60000) {
    return { ...cache, stale: Date.now() - Date.parse(cache.fetchedAt) >= CACHE_TTL }
  }
  pending = refreshCatalog()
  try { return await pending } finally { pending = null }
}
