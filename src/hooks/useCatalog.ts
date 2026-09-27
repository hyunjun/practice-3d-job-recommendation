import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { CITIES } from '../../shared/cities'
import { catalogNeedsAttention, collectionHealth } from '../../shared/catalog-health'
import { catalogNeedsRevalidation, PUBLIC_CATALOG_RECHECK_COOLDOWN } from '../../shared/catalog-freshness'
import type { Filters, Profile } from '../../shared/types'
import type { SearchScope } from '../../shared/job-search'
import type { CatalogProgress } from '../../shared/catalog-progress'
import { CatalogRequestError, requestCatalogStream } from '../lib/catalog-request'
import { CatalogWorkerClient } from '../lib/catalog-worker-client'
import { CatalogPresentationQueue } from '../lib/catalog-presentation'
import type { CatalogProjection } from '../lib/catalog-worker-types'
import { useDeadlineClock } from './useDeadlineClock'

interface Input {
  profile: Profile
  filters: Filters
  scope: SearchScope
  recover: boolean
  extraDeadlines: number[]
}

function initialProjection(): CatalogProjection {
  return {
    revision: 0,
    catalog: {
      source: 'public', fetchedAt: '', stale: false, companies: [], cities: CITIES,
      jobs: [], boards: [], unmappedCount: 0,
    },
    matches: [], cities: [], remote: [], unmapped: [], globeCities: [],
    companyCount: 0, recovery: null, expired: false, deadlines: [],
  }
}

export function useCatalog(notify: (message: string, tone?: 'error') => void, automatic: boolean, input: Input) {
  const [published, setPublished] = useState(() => ({ value: initialProjection(), key: '' }))
  const publishedRef = useRef(published.value)
  const [loading, setLoading] = useState(automatic)
  const [progress, setProgress] = useState<CatalogProgress | null>(null)
  const [error, setError] = useState('')
  const [errorRetryAt, setErrorRetryAt] = useState<string>()
  const [deadlines, setDeadlines] = useState<number[]>([])
  const [presentation] = useState(() => new CatalogPresentationQueue())
  const times = useMemo(() => [...deadlines, ...input.extraDeadlines], [deadlines, input.extraDeadlines])
  const freshnessNow = useDeadlineClock(times)
  const boundary = deadlines.reduce((latest, time) => time <= freshnessNow ? Math.max(latest, time) : latest, 0)
  const intentKey = useMemo(() => JSON.stringify([input.profile, input.filters, input.scope, input.recover, boundary]),
    [input.profile, input.filters, input.scope, input.recover, boundary])
  const previousIntentRef = useRef(intentKey)
  const key = useMemo(() => JSON.stringify([intentKey, loading]), [intentKey, loading])
  const inputRef = useRef({ ...input, key })
  inputRef.current = { ...input, key }
  const mounted = useRef(true)
  const clientRef = useRef<CatalogWorkerClient | null>(null)
  const publishedClientRef = useRef<CatalogWorkerClient | null>(null)
  const publishedKeyRef = useRef('')
  const revisionRef = useRef(0)
  const streamRef = useRef(0)
  const collectingRef = useRef(automatic)
  const wantedRef = useRef(0)
  const projectTaskRef = useRef<Promise<void> | null>(null)
  const progressByRevision = useRef(new Map<number, { stream: number; progress: CatalogProgress | null }>())
  const requestRef = useRef<AbortController | null>(null)
  const lastAttemptRef = useRef<number | null>(null)
  const retryAtRef = useRef<string | undefined>(undefined)
  const failedRequestRef = useRef(false)
  const automaticRef = useRef(automatic)

  const reportWorkerFailure = useCallback((cause: CatalogRequestError) => {
    if (!mounted.current) return
    requestRef.current?.abort()
    requestRef.current = null
    presentation.cancel()
    collectingRef.current = false
    failedRequestRef.current = true
    setLoading(false)
    setError(cause.message)
    setErrorRetryAt(undefined)
    notify(cause.message, 'error')
  }, [notify, presentation])

  const ensureClient = useCallback(() => {
    if (!clientRef.current || clientRef.current.failed) {
      clientRef.current?.dispose()
      clientRef.current = new CatalogWorkerClient(reportWorkerFailure)
      revisionRef.current = 0
      progressByRevision.current.clear()
    }
    return clientRef.current
  }, [reportWorkerFailure])

  /** Coalesce input intents while one worker query is running; never publish an older intent. */
  const project = useCallback((): Promise<void> => {
    if (!projectTaskRef.current && publishedClientRef.current === clientRef.current
      && publishedRef.current.revision === revisionRef.current && publishedKeyRef.current === inputRef.current.key) {
      return Promise.resolve()
    }
    wantedRef.current++
    if (projectTaskRef.current) return projectTaskRef.current
    const task = (async () => {
      while (mounted.current && revisionRef.current && clientRef.current && !clientRef.current.failed) {
        const client = clientRef.current
        const revision = revisionRef.current
        const wanted = wantedRef.current
        const current = inputRef.current
        let value: CatalogProjection
        try {
          value = await client.project(revision, {
            profile: current.profile, filters: current.filters, scope: current.scope,
            recover: current.recover, collecting: collectingRef.current, now: Date.now(),
          })
        } catch (cause) {
          if (!mounted.current) return
          if (client !== clientRef.current || wanted !== wantedRef.current) continue
          // A newer decode may overtake a deferred presentation. Its receipt will
          // enqueue the replacement; the skipped intermediate snapshot is not an error.
          if (cause instanceof CatalogRequestError && cause.code === 'CATALOG_SUPERSEDED') return
          throw cause
        }
        if (!mounted.current) return
        if (client !== clientRef.current || revision !== revisionRef.current || wanted !== wantedRef.current
          || current.key !== inputRef.current.key) continue
        publishedRef.current = value
        publishedClientRef.current = client
        publishedKeyRef.current = current.key
        setPublished({ value, key: current.key })
        const collection = progressByRevision.current.get(revision)
        setProgress(collection?.stream === streamRef.current ? collection.progress : null)
        setDeadlines(previous => previous.length === value.deadlines.length
          && previous.every((time, index) => time === value.deadlines[index]) ? previous : value.deadlines)
        client.acknowledge(revision)
        for (const candidate of progressByRevision.current.keys()) {
          if (candidate !== revision) progressByRevision.current.delete(candidate)
        }
        return
      }
    })().finally(() => {
      if (projectTaskRef.current === task) projectTaskRef.current = null
    })
    projectTaskRef.current = task
    return task
  }, [])

  const reload = useCallback(async ({ refresh = false, announce = true }: { refresh?: boolean; announce?: boolean } = {}) => {
    requestRef.current?.abort()
    presentation.cancel()
    const controller = new AbortController()
    requestRef.current = controller
    const stream = ++streamRef.current
    retryAtRef.current = undefined
    failedRequestRef.current = false
    collectingRef.current = true
    lastAttemptRef.current = Date.now()
    setError('')
    setErrorRetryAt(undefined)
    setProgress(null)
    setLoading(true)
    let lastPresentation: Promise<void> = Promise.resolve()
    let presentationError: unknown
    try {
      let client: CatalogWorkerClient | undefined
      await requestCatalogStream({
        refresh, signal: controller.signal,
        read(response, initial) {
          controller.signal.throwIfAborted()
          // StrictMode and immediate navigation can cancel a fetch before any body arrives.
          client ??= ensureClient()
          return client.read(response, initial, stream, controller.signal)
        },
        onUpdate(receipt, latest) {
          if (controller.signal.aborted || client !== clientRef.current) return
          lastPresentation = presentation.enqueue(async () => {
            if (controller.signal.aborted || client !== clientRef.current || stream !== streamRef.current) return
            revisionRef.current = receipt.revision
            progressByRevision.current.set(receipt.revision, { stream, progress: latest })
            collectingRef.current = Boolean(latest && !latest.done)
            await project()
          }, !publishedRef.current.catalog.fetchedAt)
          void lastPresentation.catch(cause => {
            if (controller.signal.aborted || requestRef.current !== controller) return
            presentationError = cause
            controller.abort(cause)
          })
        },
      })
      // Network completion is not presentation completion; publish the final validated snapshot first.
      await lastPresentation
      if (!controller.signal.aborted && announce) {
        const catalog = publishedRef.current.catalog
        const health = collectionHealth(catalog)
        const attention = catalogNeedsAttention(catalog)
        notify(attention
          ? `${health.failed}개 게시판 연결 확인이 필요해요. 이전 조회 공고 ${health.retained}개를 유지했어요.`
          : `${catalog.jobs.length.toLocaleString()}개 개발·연구 공고를 가져왔어요.`, attention ? 'error' : undefined)
      }
    } catch (cause) {
      if ((!controller.signal.aborted || presentationError) && mounted.current && requestRef.current === controller) {
        // A connection failure cannot discard a valid arrival waiting for the current gesture.
        try { await lastPresentation } catch (failure) { presentationError ??= failure }
        if (controller.signal.aborted && !presentationError) return
        cause = presentationError ?? cause
        failedRequestRef.current = true
        if (cause instanceof CatalogRequestError) {
          retryAtRef.current = cause.retryAt
          setErrorRetryAt(cause.retryAt)
          if (cause.code === 'CATALOG_EXPIRED') {
            const expired = { ...initialProjection(), expired: true }
            revisionRef.current = 0
            wantedRef.current++
            publishedRef.current = expired
            setPublished({ value: expired, key: inputRef.current.key })
          }
        }
        const message = cause instanceof Error ? cause.message : '공고를 불러오지 못했어요.'
        setError(message)
        if (announce) notify(message, 'error')
      }
    } finally {
      if (requestRef.current === controller) {
        requestRef.current = null
        collectingRef.current = false
        setLoading(false)
      }
    }
  }, [ensureClient, notify, presentation, project])

  useEffect(() => {
    mounted.current = true
    if (automaticRef.current) void reload({ announce: false })
    return () => {
      mounted.current = false
      wantedRef.current++
      requestRef.current?.abort()
      requestRef.current = null
      presentation.cancel()
      clientRef.current?.dispose()
      clientRef.current = null
      revisionRef.current = 0
    }
  }, [presentation, reload])

  useEffect(() => {
    const changed = previousIntentRef.current !== intentKey
    previousIntentRef.current = intentKey
    // Starting an automatic refresh is not an input intent and must not release a
    // gesture's pending update. Explicit conditions and freshness expiry can.
    const pending = changed ? presentation.flush().then(project) : project()
    void pending.catch(cause => {
      if (!mounted.current || clientRef.current?.failed) return
      const message = cause instanceof Error ? cause.message : '검색 결과를 준비하지 못했어요. 다시 조회해 주세요.'
      setError(message)
      failedRequestRef.current = true
    })
  }, [intentKey, key, presentation, project])

  const revalidate = useCallback(() => {
    if (!automaticRef.current || document.visibilityState !== 'visible' || requestRef.current) return
    const now = Date.now()
    if (lastAttemptRef.current !== null && now - lastAttemptRef.current < PUBLIC_CATALOG_RECHECK_COOLDOWN) return
    const catalog = publishedRef.current.catalog
    const retryAt = Date.parse(retryAtRef.current ?? catalog.refreshAfter ?? '')
    if (Number.isFinite(retryAt) && now < retryAt) return
    if (!failedRequestRef.current && !catalogNeedsRevalidation(catalog, now)) return
    void reload({ announce: false })
  }, [reload])

  useEffect(() => {
    automaticRef.current = automatic
    if (automatic) {
      if (failedRequestRef.current && lastAttemptRef.current === null) void reload({ announce: false })
      else revalidate()
    } else if (requestRef.current) {
      requestRef.current.abort()
      requestRef.current = null
      presentation.cancel()
      lastAttemptRef.current = null
      failedRequestRef.current = true
      collectingRef.current = false
      // A reply being processed when exploration closes cannot replace the last displayed view.
      revisionRef.current = publishedRef.current.revision
      wantedRef.current++
      setLoading(false)
    }
  }, [automatic, presentation, revalidate, reload])

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

  const preview = useCallback(async (draft: Filters): Promise<number> => {
    const revision = published.value.revision
    if (!revision) return 0
    const client = clientRef.current
    if (!client || client.failed) throw new Error('공고 연결을 다시 확인한 뒤 조건을 적용해 주세요.')
    return client.preview(revision, input.profile, draft, Date.now())
  }, [published.value.catalog, error, input.profile, boundary])

  const setMapInteracting = useCallback((active: boolean) => presentation.setInteracting(active), [presentation])

  return {
    ...published.value, loading, progress, error, reload, preview, freshnessNow, setMapInteracting,
    searching: Boolean(published.value.catalog.fetchedAt) && published.key !== key,
    ready: Boolean(published.value.catalog.fetchedAt),
    retryAt: errorRetryAt ?? (error && progress && !progress.done ? undefined : published.value.catalog.refreshAfter),
  }
}
