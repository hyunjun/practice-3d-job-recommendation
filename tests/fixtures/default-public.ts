import type { createApiRouter } from '../../server/http'
import { publicProtocolCatalog } from './public-protocol'

/**
 * Already-installed synthetic PUBLIC inputs for the default E2E app server.
 * No collector, provider transport, local board configuration or disk cache.
 * A stable snapshot also keeps normal HTTP ETag/304 behavior meaningful.
 */
export function defaultPublicSources(fetchedAt: string): Parameters<typeof createApiRouter>[0] {
  const catalog = publicProtocolCatalog({ fetchedAt })
  const refreshAfter = new Date(Date.parse(fetchedAt) + 60_000).toISOString()
  const validUntil = new Date(Date.parse(fetchedAt) + 6 * 60 * 60_000).toISOString()
  return {
    getCatalog: async () => structuredClone(catalog),
    getProgressiveCatalog: async () => ({ catalog: structuredClone(catalog), progress: null }),
    getCatalogProgress: () => null,
    getPostingStatus: async () => ({
      version: 2, checkedAt: fetchedAt, refreshAfter, contentRefreshAfter: refreshAfter,
      boards: catalog.companies.map(company => ({
        companyId: company.id, provider: company.provider ?? 'greenhouse', board: company.board!,
        status: 'ok', checkedAt: fetchedAt, lastSuccessAt: fetchedAt, retryAt: null,
        listing: {
          validUntil,
          publishedIds: catalog.jobs.filter(job => job.companyId === company.id).map(job => job.id),
          jobs: [],
        },
      })),
    }),
    getObservations: async () => ({
      version: 1, retentionDays: 90, storage: 'ok', days: [], otherSeries: [],
      method: 'observations-1.occupation-6.roles-1.qualifications-1.remote-2.employment-1.purpose-1',
      scope: {
        key: '1'.repeat(64),
        boards: catalog.companies.map(company => ({
          companyId: company.id, name: company.name,
          provider: company.provider ?? 'greenhouse', board: company.board!,
        })),
      },
    }),
  }
}
