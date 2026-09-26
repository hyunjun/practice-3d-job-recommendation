import { useCallback, useEffect, useRef, useState } from 'react'
import { CITIES } from '../../shared/cities'
import { catalogNeedsAttention, collectionHealth } from '../../shared/catalog-health'
import { catalogNeedsRevalidation, PUBLIC_CATALOG_RECHECK_COOLDOWN } from '../../shared/catalog-freshness'
import { createSampleCatalog } from '../../shared/sample'
import { upgradeCatalog } from '../../shared/job-upgrade'
import type { Catalog, Source } from '../../shared/types'
import type { CatalogProgress } from '../../shared/catalog-progress'
import { CatalogRequestError, requestPublicCatalog } from '../lib/catalog-request'

function initialCatalog(source: Source): Catalog {
  // A blank timestamp marks a client-only placeholder, never a completed empty collection.
  return source === 'sample' ? createSampleCatalog() : {
    source, fetchedAt: '', stale: false, companies: [], cities: CITIES,
    jobs: [], boards: [], unmappedCount: 0,
  }
}

export function useCatalog(initialSource: Source, notify: (message: string, tone?: 'error') => void, automatic = true) {
  const [catalog, setCatalog] = useState<Catalog>(() => initialCatalog(initialSource))
  const [loading, setLoading] = useState(initialSource !== 'sample' && automatic)
  const [progress, setProgress] = useState<CatalogProgress | null>(null)
  const [error, setError] = useState('')
  const [errorRetryAt, setErrorRetryAt] = useState<string>()
  const requestRef = useRef<AbortController | null>(null)
  const catalogRef = useRef(catalog)
  const lastAttemptRef = useRef<number | null>(null)
  const retryAtRef = useRef<string | undefined>(undefined)
  const failedRequestRef = useRef(false)
  const automaticRef = useRef(automatic)

  const changeSource = useCallback(async (source: Source, { refresh = false, announce = true }: { refresh?: boolean; announce?: boolean } = {}) => {
    requestRef.current?.abort()
    requestRef.current = null
    retryAtRef.current = undefined
    failedRequestRef.current = false
    setError('')
    setErrorRetryAt(undefined)
    setProgress(null)
    if (source === 'sample') {
      const sample = createSampleCatalog()
      catalogRef.current = sample
      setCatalog(sample)
      setLoading(false)
      return
    }
    // The selected source takes effect even if its first request fails.
    if (catalogRef.current.source !== 'public') {
      const pending = initialCatalog('public')
      catalogRef.current = pending
      setCatalog(pending)
    }
    const controller = new AbortController()
    requestRef.current = controller
    lastAttemptRef.current = Date.now()
    setLoading(true)
    try {
      let current: Catalog | undefined
      await requestPublicCatalog({ refresh, signal: controller.signal, onUpdate(result, latest) {
        if (controller.signal.aborted) return
        current = upgradeCatalog(result)
        catalogRef.current = current
        setCatalog(current)
        setProgress(latest)
      } })
      if (!controller.signal.aborted && current) {
        const health = collectionHealth(current)
        const attention = catalogNeedsAttention(current)
        if (announce) notify(attention
          ? `${health.failed}개 게시판 연결 확인이 필요해요. 이전 조회 공고 ${health.retained}개를 유지했어요.`
          : `${current.jobs.length.toLocaleString()}개 개발·연구 공고를 가져왔어요.`, attention ? 'error' : undefined)
      }
    } catch (cause) {
      if (!controller.signal.aborted) {
        failedRequestRef.current = true
        if (cause instanceof CatalogRequestError) {
          retryAtRef.current = cause.retryAt
          setErrorRetryAt(cause.retryAt)
          if (cause.code === 'CATALOG_EXPIRED' && catalogRef.current.source === 'public') {
            const expired = initialCatalog('public')
            catalogRef.current = expired
            setCatalog(expired)
          }
        }
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
    if (automaticRef.current && initialSource !== 'sample') void changeSource(initialSource, { announce: false })
    return () => {
      requestRef.current?.abort()
      requestRef.current = null
    }
  }, [initialSource, changeSource])

  const revalidate = useCallback(() => {
    if (!automaticRef.current || document.visibilityState !== 'visible' || catalogRef.current.source !== 'public' || requestRef.current) return
    const now = Date.now()
    if (lastAttemptRef.current !== null && now - lastAttemptRef.current < PUBLIC_CATALOG_RECHECK_COOLDOWN) return
    const retryAt = Date.parse(retryAtRef.current ?? catalogRef.current.refreshAfter ?? '')
    if (Number.isFinite(retryAt) && now < retryAt) return
    if (!failedRequestRef.current && !catalogNeedsRevalidation(catalogRef.current, now)) return
    void changeSource('public', { announce: false })
  }, [changeSource])

  useEffect(() => {
    automaticRef.current = automatic
    if (automatic) revalidate()
  }, [automatic, revalidate])

  useEffect(() => {
    window.addEventListener('focus', revalidate)
    window.addEventListener('pageshow', revalidate)
    window.addEventListener('online', revalidate)
    document.addEventListener('visibilitychange', revalidate)
    return () => {
      window.removeEventListener('focus', revalidate)
      window.removeEventListener('pageshow', revalidate)
      window.removeEventListener('online', revalidate)
      document.removeEventListener('visibilitychange', revalidate)
    }
  }, [revalidate])

  return { catalog, loading, progress, error, changeSource, ready: Boolean(catalog.fetchedAt),
    retryAt: errorRetryAt ?? (error && progress && !progress.done ? undefined : catalog.refreshAfter) }
}
