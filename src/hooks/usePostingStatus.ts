import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createJobRevision, observeSavedPosting, PostingStatusIndexSchema } from '../../shared/posting-status'
import type { JobRevision, PostingStatusIndex } from '../../shared/posting-status'
import type { Job, SavedJob } from '../../shared/types'
import { useRetryCountdown } from './useRetryCountdown'
import { useDeadlineClock } from './useDeadlineClock'

export function usePostingStatus(saved: SavedJob[]) {
  const [index, setIndex] = useState<PostingStatusIndex | null>(null)
  const [loading, setLoading] = useState(false)
  const [loadingContent, setLoadingContent] = useState(false)
  const [error, setError] = useState('')
  const [contentError, setContentError] = useState('')
  const [retryAt, setRetryAt] = useState<string>()
  const [contentRetryAt, setContentRetryAt] = useState<string>()
  const deadlines = useMemo(() => index?.boards.flatMap(board => board.listing
    ? [Date.parse(board.listing.validUntil), ...(board.listing.content ? [Date.parse(board.listing.content.validUntil)] : [])] : []) ?? [], [index])
  const now = useDeadlineClock(deadlines)
  // null means the comparison finished without a usable revision. Absence
  // means it has not finished for this exact snapshot yet.
  const [localRevisions, setLocalRevisions] = useState(new Map<Job, JobRevision | null>())
  const revisionCache = useRef(new WeakMap<Job, Promise<JobRevision>>())
  const request = useRef<AbortController | null>(null)
  const remaining = useRetryCountdown(retryAt)
  const contentRemaining = useRetryCountdown(contentRetryAt)

  useEffect(() => () => { request.current?.abort(); request.current = null }, [])

  // Checking is explicit. Opening the collection or changing a note never makes a request.
  const check = useCallback(async (content = false) => {
    const deadline = content ? contentRetryAt : retryAt
    if (request.current || (deadline && Date.parse(deadline) > Date.now())) return
    const controller = new AbortController()
    request.current = controller
    setLoading(true)
    setLoadingContent(content)
    const setFailure = content ? setContentError : setError
    const setRetry = content ? setContentRetryAt : setRetryAt
    const timeout = window.setTimeout(() => controller.abort(), 150_000)
    try {
      const response = await fetch(`/api/posting-status?refresh=1${content ? '&content=1' : ''}`, { signal: controller.signal })
      const data: unknown = await response.json()
      if (request.current !== controller) return
      if (!response.ok) {
        const retry = data && typeof data === 'object' && 'retryAt' in data ? data.retryAt : null
        if (typeof retry === 'string' && Number.isFinite(Date.parse(retry))) {
          setRetry(new Date(Math.max(Date.now() + 60_000, Date.parse(retry))).toISOString())
        } else setRetry(new Date(Date.now() + 60_000).toISOString())
        setFailure(content ? '공고 내용을 불러오지 못했어요. 잠시 후 다시 확인해 주세요.' : '게시 상태를 불러오지 못했어요. 잠시 후 다시 확인해 주세요.')
        return
      }
      const next = PostingStatusIndexSchema.parse(data)
      setIndex(next)
      setRetryAt(next.refreshAfter)
      setContentRetryAt(next.contentRefreshAfter ?? next.refreshAfter)
      setError('')
      setContentError('')
    } catch {
      if (request.current !== controller) return
      setFailure(content ? '공고 내용을 불러오지 못했어요. 연결을 확인하고 다시 시도해 주세요.' : '게시 상태를 불러오지 못했어요. 연결을 확인하고 다시 시도해 주세요.')
      setRetry(new Date(Date.now() + 60_000).toISOString())
    } finally {
      window.clearTimeout(timeout)
      if (request.current === controller) {
        request.current = null
        setLoading(false)
        setLoadingContent(false)
      }
    }
  }, [retryAt, contentRetryAt])

  useEffect(() => {
    if (!index) return
    let cancelled = false
    const jobs = saved.filter(item => item.job.source !== 'sample').map(item => item.job)
    void Promise.allSettled(jobs.map(job => {
      let revision = revisionCache.current.get(job)
      if (!revision) {
        revision = createJobRevision(job)
        revisionCache.current.set(job, revision)
        void revision.catch(() => revisionCache.current.delete(job))
      }
      return revision.then(value => [job, value] as const)
    })).then(results => {
      if (!cancelled) setLocalRevisions(new Map(results.map((result, index) => [
        jobs[index], result.status === 'fulfilled' ? result.value[1] : null,
      ])))
    })
    return () => { cancelled = true }
  }, [saved, index])

  const observations = useMemo(() => new Map(saved.map(item => [
    item.job.id, observeSavedPosting(item, index, localRevisions.get(item.job) ?? undefined, now, error),
  ])), [saved, index, localRevisions, now, error])
  const comparing = Boolean(index) && saved.some(item => item.job.source !== 'sample' && !localRevisions.has(item.job))

  return {
    observations, check, loading, loadingContent, comparing,
    error: error || contentError, remaining, contentRemaining, checked: Boolean(index || error || contentError),
  }
}

export type PostingStatusController = ReturnType<typeof usePostingStatus>
