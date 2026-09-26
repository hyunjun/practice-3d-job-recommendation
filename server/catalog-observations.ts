import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import {
  buildObservationStats, OBSERVATION_METHOD, OBSERVATION_RETENTION_DAYS,
  ObservationDaySchema, ObservationHistorySchema, ObservationScopeSchema, ObservationSeriesSchema,
} from '../shared/catalog-observations'
import type {
  ObservationAttempt, ObservationDay, ObservationHistory, ObservationPoint, ObservationSeries,
} from '../shared/catalog-observations'
import { CATALOG_LIFETIME } from '../shared/catalog-freshness'
import { isUnmappedJob } from '../shared/job-location'
import type { Company } from '../shared/types'
import { belongsToBoard } from './board-cache'
import type { CachedBoard } from './board-cache'

const MAX_FILE_BYTES = 16 * 1024 * 1024
const DAY_MS = 86_400_000
const HistoryFileSchema = z.object({
  version: z.literal(1), series: z.array(ObservationSeriesSchema).max(4),
}).refine(value => new Set(value.series.map(series => `${series.scope.key}:${series.method}`)).size === value.series.length)
type HistoryFile = z.infer<typeof HistoryFileSchema>
export interface ObservationCache {
  load(): Promise<unknown>
  save(history: HistoryFile): Promise<void>
}
export interface ObservationStore {
  readonly method: string
  record(boards: CachedBoard[], origin: 'cache' | 'collection'): Promise<void>
  read(): Promise<ObservationHistory>
}

export function observationCacheFile(fullCacheFile: string): string {
  return path.join(path.dirname(fullCacheFile), 'observations-v1', path.basename(fullCacheFile))
}

export function createFileObservationCache(file: string): ObservationCache {
  return {
    async load() {
      try {
        if ((await stat(file)).size > MAX_FILE_BYTES) throw new Error('Observation history exceeds the size limit')
        const text = await readFile(file, 'utf8')
        if (Buffer.byteLength(text) > MAX_FILE_BYTES) throw new Error('Observation history exceeds the size limit')
        return JSON.parse(text) as unknown
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, series: [] }
        throw error
      }
    },
    async save(history) {
      const text = JSON.stringify(HistoryFileSchema.parse(history))
      if (Buffer.byteLength(text) > MAX_FILE_BYTES) throw new Error('Observation history exceeds the size limit')
      await mkdir(path.dirname(file), { recursive: true })
      const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`
      try {
        await writeFile(temporary, text, 'utf8')
        await rename(temporary, file)
      } finally {
        await rm(temporary, { force: true })
      }
    },
  }
}

function scopeKey(boards: ObservationSeries['scope']['boards']): string {
  const identities = boards.map(board => [board.companyId, board.provider, board.board, board.boardRegion ?? ''])
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right), 'en'))
  return createHash('sha256').update(JSON.stringify(identities)).digest('hex')
}

export function createObservationStore({
  companies, cache, now = Date.now, method = OBSERVATION_METHOD, onError = console.warn,
}: {
  companies: Company[]; cache: ObservationCache; now?: () => number; method?: string; onError?: (error: unknown) => void
}): ObservationStore {
  const sources = companies.map(company => ({
    companyId: company.id, name: company.name, provider: company.provider ?? 'greenhouse',
    board: company.board!, ...(company.boardRegion ? { boardRegion: company.boardRegion } : {}),
  })).sort((left, right) => left.companyId.localeCompare(right.companyId, 'en'))
  const scope = ObservationScopeSchema.parse({ key: scopeKey(sources), boards: sources })
  if (!method || method.length > 200) throw new Error('Invalid observation method')
  let file: HistoryFile = { version: 1, series: [] }
  let initialization: Promise<void> | undefined
  let pending = Promise.resolve()
  let blockedWrites = false
  let error: string | undefined
  const utcDay = (time: number) => new Date(time).toISOString().slice(0, 10)
  const matches = (series: ObservationSeries) => series.scope.key === scope.key && series.method === method
  const cutoff = () => utcDay(now() - (OBSERVATION_RETENTION_DAYS - 1) * DAY_MS)

  async function initialize() {
    try {
      const loaded = HistoryFileSchema.parse(await cache.load())
      if (loaded.series.some(series => scopeKey(series.scope.boards) !== series.scope.key
        || series.days.some(day => Date.parse(day.latest.observedAt) > now()
          || Date.parse(day.latest.recordedAt) > now()))) throw new Error('Invalid observation identity or time')
      file = loaded
    } catch (cause) {
      blockedWrites = true
      error = '관측 기록을 읽지 못했어요. 기존 파일을 보존하며 새로운 기록의 저장을 중단했어요.'
      onError(cause)
    }
  }

  function retained(input: ObservationSeries[]): ObservationSeries[] {
    const firstDay = cutoff()
    return input.map(series => ({
      ...series, days: series.days.filter(day => day.day >= firstDay).sort((left, right) => left.day.localeCompare(right.day)),
    }))
      .filter(series => series.days.length)
      .sort((left, right) => Number(matches(right)) - Number(matches(left))
        || (right.days.at(-1)?.day ?? '').localeCompare(left.days.at(-1)?.day ?? '')
        || left.scope.key.localeCompare(right.scope.key))
      .slice(0, 4)
  }

  function createAttempt(entries: CachedBoard[], origin: ObservationAttempt['origin']): ObservationDay | null {
    const selected = companies.map(company => entries.find(entry => entry.companyId === company.id
      && entry.provider === (company.provider ?? 'greenhouse') && entry.board === company.board
      && entry.boardRegion === company.boardRegion))
    const times = selected.flatMap(entry => entry ? [Date.parse(entry.checkedAt)] : [])
    // No collection has happened. Reading history must not invent a first day.
    if (!times.length || times.some(time => !Number.isFinite(time) || time > now())) return null
    const observed = Math.max(...times)
    const observedAt = new Date(observed).toISOString()
    const day = utcDay(observed)
    if (day < cutoff()) return null
    const boards: ObservationAttempt['boards'] = companies.map((company, index) => {
      const entry = selected[index]
      const snapshot = entry?.snapshot
      const published = new Set(snapshot?.publishedIds)
      let status: ObservationAttempt['boards'][number]['status'] = 'complete'
      if (!entry) status = 'missing'
      else if (entry.error || entry.failures > 0) status = 'error'
      else if (!snapshot || !snapshot.publishedIds
        || snapshot.publishedIds.length !== snapshot.total || published.size !== snapshot.total
        || !belongsToBoard(snapshot, company) || snapshot.unmappedCount === null
        || snapshot.unmappedCount !== snapshot.jobs.filter(isUnmappedJob).length
        || new Set(snapshot.jobs.map(job => job.id)).size !== snapshot.jobs.length
        || snapshot.jobs.some(job => !published.has(job.id))) status = 'incomplete'
      else if (!Number.isFinite(Date.parse(snapshot.fetchedAt)) || Date.parse(snapshot.fetchedAt) > Date.parse(entry.checkedAt)
        || observed - Date.parse(snapshot.fetchedAt) >= CATALOG_LIFETIME.freshFor) status = 'stale'
      return {
        companyId: company.id, status, checkedAt: entry?.checkedAt ?? null,
        lastSuccessAt: snapshot?.fetchedAt ?? null,
      }
    })
    const latest: ObservationAttempt = {
      observedAt, recordedAt: new Date(now()).toISOString(), origin, boards,
    }
    let complete: ObservationPoint | undefined
    if (boards.every(board => board.status === 'complete')) {
      const snapshots = selected.map(entry => entry!.snapshot!)
      complete = {
        ...latest,
        comparable: snapshots.every(snapshot => snapshot.observationMethod === method),
        stats: buildObservationStats(snapshots.flatMap(snapshot => snapshot.jobs), companies,
          snapshots.reduce((total, snapshot) => total + snapshot.total, 0)),
      }
    }
    return ObservationDaySchema.parse({ day, latest, ...(complete ? { complete } : {}) })
  }

  async function record(entries: CachedBoard[], origin: ObservationAttempt['origin']) {
    await (initialization ??= initialize())
    if (blockedWrites) return
    try {
      const next = createAttempt(entries, origin)
      if (!next) return
      const existing = file.series.find(matches)
      const previous = existing?.days.find(day => day.day === next.day)
      if (previous && Date.parse(previous.latest.observedAt) > Date.parse(next.latest.observedAt)) return
      // The source fingerprint does not include the time this process happened
      // to read it. Reopening a cache cannot create or renew an observation.
      if (previous && previous.latest.observedAt === next.latest.observedAt
        && JSON.stringify(previous.latest.boards) === JSON.stringify(next.latest.boards)
        && (!next.complete || previous.complete?.observedAt === next.complete.observedAt
          && JSON.stringify(previous.complete?.stats) === JSON.stringify(next.complete.stats)
          && previous.complete?.comparable === next.complete.comparable)) return
      const merged: ObservationDay = { ...next, complete: next.complete ?? previous?.complete }
      const current: ObservationSeries = {
        scope, method,
        days: [...(existing?.days.filter(day => day.day !== next.day) ?? []), merged]
          .filter(day => day.day >= cutoff()).sort((left, right) => left.day.localeCompare(right.day)),
      }
      const candidate = HistoryFileSchema.parse({
        version: 1, series: retained([...file.series.filter(series => !matches(series)), current]),
      })
      await cache.save(candidate)
      file = candidate
      error = undefined
    } catch (cause) {
      error = '관측 기록을 저장하지 못했어요. 마지막으로 저장된 기록만 표시해요.'
      onError(cause)
    }
  }

  return {
    method,
    record(entries, origin) {
      const operation = pending.then(() => record(entries, origin))
      pending = operation.catch(onError)
      return operation
    },
    async read() {
      await (initialization ??= initialize())
      await pending
      const series = retained(file.series)
      return ObservationHistorySchema.parse({
        version: 1, retentionDays: OBSERVATION_RETENTION_DAYS,
        scope, method, days: series.find(matches)?.days ?? [],
        otherSeries: series.filter(item => !matches(item)).map(item => ({
          scopeKey: item.scope.key, method: item.method, firstDay: item.days[0].day,
          lastDay: item.days.at(-1)!.day, companyCount: item.scope.boards.length,
        })),
        storage: error ? 'error' : 'ok', ...(error ? { error } : {}),
      })
    },
  }
}
