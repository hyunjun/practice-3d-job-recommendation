import { CatalogRequestError } from '../lib/catalog-request'
import { CatalogWorkerModel } from '../lib/catalog-worker-model'
import type { CatalogWorkerRequest, CatalogWorkerResponse } from '../lib/catalog-worker-types'

const model = new CatalogWorkerModel()
// Body decoding is asynchronous. Serialize messages so a query cannot overtake its response.
let queue: Promise<void> = Promise.resolve()
self.addEventListener('message', (event: MessageEvent<CatalogWorkerRequest>) => {
  const { id, command } = event.data
  queue = queue.then(async () => {
    let response: CatalogWorkerResponse
    try {
      response = { id, result: await model.handle(command) }
    } catch (error) {
      response = { id, error: {
        message: error instanceof Error ? error.message : '공고를 처리하지 못했어요. 다시 조회해 주세요.',
        ...(error instanceof CatalogRequestError ? { code: error.code, retryAt: error.retryAt } : {}),
      } }
    }
    self.postMessage(response)
  })
})
