import compression from 'compression'
import { Router } from 'express'
import type { RequestHandler } from 'express'
import { constants } from 'node:zlib'
import { createSampleCatalog } from '../shared/sample'
import type { Catalog } from '../shared/types'
import type { PostingStatusIndex } from '../shared/posting-status'
import { CatalogUnavailableError } from './catalog-service'

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
  getPostingStatus: (refresh: boolean) => Promise<PostingStatusIndex>
}

export function createApiRouter({ getCatalog, getPostingStatus }: PublicSources): Router {
  const router = Router()
  router.use(compressResponses)
  router.use((_request, response, next) => {
    response.setHeader('Cache-Control', 'no-store')
    next()
  })

  router.get('/catalog', async (request, response) => {
    const source = request.query.source ?? 'sample'
    if (source !== 'sample' && source !== 'public' && source !== 'greenhouse') {
      response.status(400).json({ error: '지원하지 않는 데이터 소스입니다.' })
      return
    }
    try {
      // Always run the collector's refresh/failure/expiry policy before Express
      // compares ETags. A conditional request is never a shortcut around it.
      const catalog = source === 'sample' ? createSampleCatalog() : await getCatalog(request.query.refresh === '1')
      if (source !== 'sample') response.setHeader('Cache-Control', 'private, no-cache, must-revalidate')
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

  // This fixed public-board index never receives saved job IDs or profile data.
  router.get('/posting-status', async (request, response) => {
    try {
      const index = await getPostingStatus(request.query.refresh === '1')
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
