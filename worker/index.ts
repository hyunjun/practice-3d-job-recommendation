import { apiNotFound, atPath, jsonResponse, responseEncoding, SECURITY_HEADERS } from './http'
import type { CatalogEnvironment } from './store'

export { CatalogStore } from './store'
export interface Environment extends CatalogEnvironment {
  ASSETS: Fetcher
  CATALOG_STORE: DurableObjectNamespace
}

export default {
  async fetch(request: Request, env: Environment): Promise<Response> {
    const url = new URL(request.url)
    const isApi = atPath(url.pathname, '/api')
    const isPrivate = atPath(url.pathname, '/__orbit/publish')
    if (!isApi && !isPrivate) return env.ASSETS.fetch(request)
    const known = ['/api/catalog', '/api/posting-status', '/api/observations', '/api/health', '/api/catalog/progress']
    let response: Response
    if (isApi && (!['GET', 'HEAD'].includes(request.method) || !known.includes(url.pathname))) {
      response = apiNotFound(request)
    } else {
      const object = env.CATALOG_STORE.get(env.CATALOG_STORE.idFromName('catalog-v1'))
      try { response = await object.fetch(request) }
      catch {
        response = jsonResponse(request, {
          error: '저장된 공고 자료를 읽지 못했어요. 잠시 후 다시 확인해 주세요.',
          code: isPrivate ? 'PUBLISH_STORAGE_ERROR' : 'CATALOG_STORAGE_ERROR',
        }, 503)
      }
    }
    const originalEncoding = request.cf?.clientAcceptEncoding
    const encoding = responseEncoding(typeof originalEncoding === 'string' ? originalEncoding : request.headers.get('Accept-Encoding'))
    if (encoding === null && response.status < 400) {
      await response.body?.cancel()
      response = jsonResponse(request, { error: '지원하는 응답 인코딩을 선택해 주세요.' }, 406)
    }
    const headers = new Headers(response.headers)
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) headers.set(name, value)
    headers.set('Vary', 'Accept-Encoding')
    headers.delete('Content-Length')
    if (encoding === 'gzip' || encoding === 'br') headers.set('Content-Encoding', encoding)
    else headers.delete('Content-Encoding')
    // Only the outer Worker encodes the identity stream delivered by the DO.
    return new Response(response.body, { status: response.status, headers, encodeBody: 'automatic' })
  },
} satisfies ExportedHandler<Environment>
