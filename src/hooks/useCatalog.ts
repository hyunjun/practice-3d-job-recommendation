import { useCallback, useEffect, useRef, useState } from 'react'
import { CITIES } from '../../shared/cities'
import { PUBLIC_COMPANIES } from '../../shared/companies'
import { catalogNeedsAttention, collectionHealth } from '../../shared/catalog-health'
import { createSampleCatalog } from '../../shared/sample'
import type { Catalog, Source } from '../../shared/types'

function initialCatalog(source: Source): Catalog {
  // A blank timestamp marks a client-only placeholder, never a completed empty collection.
  return source === 'sample' ? createSampleCatalog() : {
    source, fetchedAt: '', stale: false, companies: PUBLIC_COMPANIES, cities: CITIES,
    jobs: [], boards: [], unmappedCount: 0,
  }
}

export function useCatalog(initialSource: Source, notify: (message: string, tone?: 'error') => void) {
  const [catalog, setCatalog] = useState<Catalog>(() => initialCatalog(initialSource))
  const [loading, setLoading] = useState(initialSource !== 'sample')
  const [error, setError] = useState('')
  const [errorRetryAt, setErrorRetryAt] = useState<string>()
  const requestRef = useRef<AbortController | null>(null)

  const changeSource = useCallback(async (source: Source, { refresh = false, announce = true }: { refresh?: boolean; announce?: boolean } = {}) => {
    requestRef.current?.abort()
    requestRef.current = null
    setError('')
    setErrorRetryAt(undefined)
    if (source === 'sample') {
      setCatalog(createSampleCatalog())
      setLoading(false)
      return
    }
    const controller = new AbortController()
    requestRef.current = controller
    setLoading(true)
    try {
      const response = await fetch(`/api/catalog?source=greenhouse${refresh ? '&refresh=1' : ''}`, { signal: controller.signal })
      const result = await response.json()
      if (!response.ok) {
        if (!controller.signal.aborted) {
          if (typeof result?.retryAt === 'string' && Number.isFinite(Date.parse(result.retryAt))) setErrorRetryAt(result.retryAt)
          if (response.status === 503 && result?.code === 'CATALOG_EXPIRED') {
            setCatalog(previous => previous.source === 'greenhouse' ? initialCatalog('greenhouse') : previous)
          }
        }
        throw new Error(result?.error ?? '공개 공고를 불러오지 못했어요.')
      }
      if (!result || result.source !== 'greenhouse'
        || !['jobs', 'companies', 'cities', 'boards'].every(key => Array.isArray(result[key]))
        || typeof result.fetchedAt !== 'string' || !Number.isFinite(Date.parse(result.fetchedAt))) {
        throw new Error('공고 데이터 형식을 확인하지 못했어요.')
      }
      if (!controller.signal.aborted) {
        setCatalog(result as Catalog)
        const health = collectionHealth(result as Catalog)
        const attention = catalogNeedsAttention(result as Catalog)
        if (announce) notify(attention
          ? `${health.failed}개 게시판 연결 확인이 필요해요. 이전 조회 공고 ${health.retained}개를 유지했어요.`
          : `${result.jobs.length.toLocaleString()}개 개발 공고를 가져왔어요.`, attention ? 'error' : undefined)
      }
    } catch (cause) {
      if (!controller.signal.aborted) {
        const message = cause instanceof Error ? cause.message : '공고를 불러오지 못했어요.'
        setError(message)
        if (announce) notify(message, 'error')
      }
    } finally {
      if (requestRef.current === controller) {
        requestRef.current = null
        setLoading(false)
      }
    }
  }, [notify])

  useEffect(() => {
    if (initialSource !== 'sample') void changeSource(initialSource, { announce: false })
    return () => requestRef.current?.abort()
  }, [initialSource, changeSource])

  return { catalog, loading, error, changeSource, ready: Boolean(catalog.fetchedAt), retryAt: errorRetryAt ?? catalog.refreshAfter }
}
