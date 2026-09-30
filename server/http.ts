import compression from 'compression'
import { Router } from 'express'
import type { RequestHandler } from 'express'
import { constants } from 'node:zlib'
import type { Catalog } from '../shared/types'
import type { CatalogCollectionUpdate, CatalogProgress } from '../shared/catalog-progress'
import type { PostingStatusIndex } from '../shared/posting-status'
import type { ObservationHistory } from '../shared/catalog-observations'
import { CatalogProgressGoneError, CatalogUnavailableError } from './catalog-service'

const compress = compression({
  threshold: 1024,
  level: 6,
  brotli: { params: { [constants.BROTLI_PARAM_QUALITY]: 4 } },
})

export const compressResponses: RequestHandler = (request, response, next) => {
  // Express removes Content-Type for 304, before compression's content filter
  // runs. Keep the same Vary on compressed, identity, HEAD and 304 responses.
  response.vary('Accept-Encoding')
  compress(request, response, next)
}

interface PublicSources {
  getCatalog: (refresh: boolean) => Promise<Catalog>
  getPostingStatus: (refresh: boolean, content?: boolean) => Promise<PostingStatusIndex>
  getProgressiveCatalog?: (refresh: boolean, queued?: boolean) => Promise<{ catalog: Catalog; progress: CatalogProgress | null }>
  getCatalogProgress?: (id: string, after: number) => CatalogCollectionUpdate | null
  getObservations?: () => Promise<ObservationHistory>
}

/** Split list/parameter delimiters without treating quoted content as preferences. */
function splitQuoted(value: string, delimiter: string): string[] | null {
  const parts: string[] = []
  let start = 0
  let quoted = false
  let escaped = false
  for (let index = 0; index < value.length; index++) {
    const character = value[index]
    if (escaped) escaped = false
    else if (quoted && character === '\\') escaped = true
    else if (character === '"') quoted = !quoted
    else if (!quoted && character === delimiter) {
      parts.push(value.slice(start, index))
      start = index + 1
    }
  }
  if (quoted || escaped) return null
  parts.push(value.slice(start))
  return parts
}

const preferenceToken = /^[!#$%&'*+\-.^_`|~0-9a-z]+$/i
const preferenceHead = /^([!#$%&'*+\-.^_`|~0-9a-z]+)(?:[ \t]*=[ \t]*(.*))?$/i
const quotedPreference = /^"(?:[\t\x20-\x21\x23-\x5b\x5d-\x7e\x80-\xff]|\\[\t\x20-\x7e\x80-\xff])*"$/

function preferences(header?: string): Map<string, string | null | undefined> {
  const values = new Map<string, string | null | undefined>()
  for (const item of splitQuoted(header ?? '', ',') ?? []) {
    const head = splitQuoted(item, ';')?.[0].trim().match(preferenceHead)
    if (!head) continue
    const name = head[1].toLowerCase()
    if (values.has(name)) continue
    // Even an unknown/invalid first value cannot be replaced by a later duplicate.
    values.set(name, undefined)
    const raw = head[2]?.trim()
    if (raw === undefined || raw === '') values.set(name, null)
    else if (preferenceToken.test(raw)) values.set(name, raw)
    else if (quotedPreference.test(raw)) values.set(name, raw.slice(1, -1).replace(/\\(.)/g, '$1') || null)
  }
  return values
}

export function createApiRouter({ getCatalog, getPostingStatus, getProgressiveCatalog, getCatalogProgress, getObservations }: PublicSources): Router {
  const router = Router()
  router.use(compressResponses)
  router.use((_request, response, next) => {
    response.setHeader('Cache-Control', 'no-store')
    next()
  })

  router.get('/catalog', async (request, response) => {
    if (getProgressiveCatalog) response.vary('Prefer')
    const source = request.query.source ?? 'public'
    if (source !== 'sample' && source !== 'public' && source !== 'greenhouse') {
      response.status(400).json({ error: '지원하지 않는 데이터 소스입니다.' })
      return
    }
    try {
      // Existing clients retain the blocking JSON/ETag contract. The browser
      // opts into an immediate snapshot and a read-only progress resource.
      // Legacy source names use the same public collector; no fictional
      // postings are generated, including for clients using the old URL.
      const requested = preferences(request.get('Prefer'))
      if (getProgressiveCatalog && getCatalogProgress && requested.get('respond-async') === null) {
        const queued = requested.get('orbit-progress') === 'queued'
        const refresh = request.query.refresh === '1'
        const result = queued ? await getProgressiveCatalog(refresh, true) : await getProgressiveCatalog(refresh)
        if (result.progress) {
          response.setHeader('Preference-Applied', queued ? 'respond-async, orbit-progress=queued' : 'respond-async')
          response.setHeader('Location', `/api/catalog/progress?id=${encodeURIComponent(result.progress.id)}&after=${result.progress.revision}`)
          response.setHeader('Retry-After', '1')
          response.status(202).json(result)
          return
        }
        response.setHeader('Cache-Control', 'private, no-cache, must-revalidate')
        response.json(result.catalog)
        return
      }
      // Always run the collector's refresh/failure/expiry policy before Express
      // compares ETags. A conditional request is never a shortcut around it.
      const catalog = await getCatalog(request.query.refresh === '1')
      response.setHeader('Cache-Control', 'private, no-cache, must-revalidate')
      response.json(catalog)
    } catch (error) {
      response.setHeader('Cache-Control', 'no-store')
      const retryAt = error instanceof CatalogUnavailableError ? error.retryAt : undefined
      if (retryAt) response.setHeader('Retry-After', Math.max(0, Math.ceil((Date.parse(retryAt) - Date.now()) / 1000)))
      response.status(503).json({
        error: error instanceof Error ? error.message : '공고를 불러오지 못했습니다.',
        ...(error instanceof CatalogUnavailableError ? { retryAt, code: error.code } : {}),
      })
    }
  })

  router.get('/catalog/progress', (request, response) => {
    if (!getCatalogProgress) {
      response.status(404).json({ error: '수집 진행 정보를 지원하지 않는 서버입니다.' })
      return
    }
    const { id, after } = request.query
    if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/i.test(id)
      || typeof after !== 'string' || !/^\d{1,10}$/.test(after)) {
      response.status(400).json({ error: '잘못된 수집 진행 요청입니다.' })
      return
    }
    try {
      const update = getCatalogProgress(id, Number(after))
      if (!update) {
        response.setHeader('Retry-After', '1')
        response.status(204).end()
        return
      }
      if (!update.progress.done) response.setHeader('Retry-After', '1')
      response.json(update)
    } catch (error) {
      if (error instanceof CatalogProgressGoneError) {
        response.status(410).json({ code: 'CATALOG_PROGRESS_GONE', error: error.message })
      } else if (error instanceof RangeError) {
        response.status(400).json({ error: error.message })
      } else {
        const retryAt = error instanceof CatalogUnavailableError ? error.retryAt : undefined
        if (retryAt) response.setHeader('Retry-After', Math.max(0, Math.ceil((Date.parse(retryAt) - Date.now()) / 1000)))
        response.status(503).json({
          error: error instanceof Error ? error.message : '수집 진행 정보를 불러오지 못했습니다.',
          ...(error instanceof CatalogUnavailableError ? { code: error.code, retryAt } : {}),
        })
      }
    }
  })

  // Reading aggregate history never schedules upstream collection.
  router.get('/observations', async (_request, response) => {
    if (!getObservations) {
      response.status(404).json({ error: '관측 기록을 지원하지 않는 서버입니다.' })
      return
    }
    try {
      const history = await getObservations()
      response.setHeader('Cache-Control', 'private, no-cache, must-revalidate')
      response.json(history)
    } catch {
      response.setHeader('Cache-Control', 'no-store')
      response.status(503).json({ error: '관측 기록을 불러오지 못했어요. 잠시 후 다시 확인해 주세요.' })
    }
  })

  // This fixed public-board index never receives saved job IDs or profile data.
  router.get('/posting-status', async (request, response) => {
    try {
      const index = request.query.content === '1'
        ? await getPostingStatus(request.query.refresh === '1', true)
        : await getPostingStatus(request.query.refresh === '1')
      response.setHeader('Cache-Control', 'private, no-cache, must-revalidate')
      response.json(index)
    } catch {
      response.setHeader('Cache-Control', 'no-store')
      response.setHeader('Retry-After', '60')
      response.status(503).json({
        error: '게시 상태를 불러오지 못했어요. 잠시 후 다시 확인해 주세요.',
        retryAt: new Date(Date.now() + 60_000).toISOString(),
      })
    }
  })

  router.use((_request, response) => {
    response.status(404).json({ error: '존재하지 않는 API입니다.' })
  })
  return router
}
