import { useCallback, useEffect, useRef, useState } from 'react'
import { CITIES } from '../../shared/cities'
import { PUBLIC_COMPANIES } from '../../shared/companies'
import { catalogNeedsAttention, collectionHealth } from '../../shared/catalog-health'
import { createSampleCatalog } from '../../shared/sample'
import { upgradeJobRole } from '../../shared/job-roles'
import { upgradeCatalogOccupations } from '../../shared/job-occupation'
import { upgradeJobLocations } from '../../shared/job-location'
import { upgradeJobCompensation } from '../../shared/job-compensation'
import { upgradeJobEligibility } from '../../shared/job-eligibility'
import type { Catalog, Source } from '../../shared/types'
import type { CatalogProgress } from '../../shared/catalog-progress'
import { CatalogRequestError, requestPublicCatalog } from '../lib/catalog-request'

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
  const [progress, setProgress] = useState<CatalogProgress | null>(null)
  const [error, setError] = useState('')
  const [errorRetryAt, setErrorRetryAt] = useState<string>()
  const requestRef = useRef<AbortController | null>(null)

  const changeSource = useCallback(async (source: Source, { refresh = false, announce = true }: { refresh?: boolean; announce?: boolean } = {}) => {
    requestRef.current?.abort()
    requestRef.current = null
    setError('')
    setErrorRetryAt(undefined)
    setProgress(null)
    if (source === 'sample') {
      setCatalog(createSampleCatalog())
      setLoading(false)
      return
    }
    const controller = new AbortController()
    requestRef.current = controller
    setLoading(true)
    try {
      let current: Catalog | undefined
      await requestPublicCatalog({ refresh, signal: controller.signal, onUpdate(result, latest) {
        if (controller.signal.aborted) return
        current = upgradeJobLocations(upgradeCatalogOccupations(result))
        current.jobs = current.jobs.map(job => upgradeJobRole(upgradeJobEligibility(upgradeJobCompensation(job))))
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
        if (cause instanceof CatalogRequestError) {
          setErrorRetryAt(cause.retryAt)
          if (cause.code === 'CATALOG_EXPIRED') setCatalog(previous => previous.source === 'public' ? initialCatalog('public') : previous)
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
    if (initialSource !== 'sample') void changeSource(initialSource, { announce: false })
    return () => requestRef.current?.abort()
  }, [initialSource, changeSource])

  return { catalog, loading, progress, error, changeSource, ready: Boolean(catalog.fetchedAt),
    retryAt: errorRetryAt ?? (error && progress && !progress.done ? undefined : catalog.refreshAfter) }
}
