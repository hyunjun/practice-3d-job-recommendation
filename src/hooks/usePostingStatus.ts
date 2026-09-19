import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createJobRevision, observeSavedPosting, PostingStatusIndexSchema } from '../../shared/posting-status'
import type { JobRevision, PostingStatusIndex } from '../../shared/posting-status'
import type { Job, SavedJob } from '../../shared/types'
import { useRetryCountdown } from './useRetryCountdown'
import { useDeadlineClock } from './useDeadlineClock'

export function usePostingStatus(saved: SavedJob[]) {
  const [index, setIndex] = useState<PostingStatusIndex | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [retryAt, setRetryAt] = useState<string>()
  const deadlines = useMemo(() => index?.boards.flatMap(board => board.listing ? [Date.parse(board.listing.validUntil)] : []) ?? [], [index])
  const now = useDeadlineClock(deadlines)
  const [localRevisions, setLocalRevisions] = useState(new Map<Job, JobRevision>())
  const revisionCache = useRef(new WeakMap<Job, Promise<JobRevision>>())
  const request = useRef<AbortController | null>(null)
  const remaining = useRetryCountdown(retryAt)

  useEffect(() => () => { request.current?.abort(); request.current = null }, [])

  // Checking is explicit. Opening the collection or changing a note never makes a request.
  const check = useCallback(async () => {
    if (request.current || (retryAt && Date.parse(retryAt) > Date.now())) return
    const controller = new AbortController()
    request.current = controller
    setLoading(true)
    const timeout = window.setTimeout(() => controller.abort(), 150_000)
    try {
      const response = await fetch('/api/posting-status?refresh=1', { signal: controller.signal })
      const data: unknown = await response.json()
      if (request.current !== controller) return
      if (!response.ok) {
        const retry = data && typeof data === 'object' && 'retryAt' in data ? data.retryAt : null
        if (typeof retry === 'string' && Number.isFinite(Date.parse(retry))) {
          setRetryAt(new Date(Math.max(Date.now() + 60_000, Date.parse(retry))).toISOString())
        } else setRetryAt(new Date(Date.now() + 60_000).toISOString())
        setError('게시 상태를 불러오지 못했어요. 잠시 후 다시 확인해 주세요.')
        return
      }
      const next = PostingStatusIndexSchema.parse(data)
      setIndex(next)
      setRetryAt(next.refreshAfter)
      setError('')
    } catch {
      if (request.current !== controller) return
      setError('게시 상태를 불러오지 못했어요. 연결을 확인하고 다시 시도해 주세요.')
      setRetryAt(new Date(Date.now() + 60_000).toISOString())
    } finally {
      window.clearTimeout(timeout)
      if (request.current === controller) {
        request.current = null
        setLoading(false)
      }
    }
  }, [retryAt])

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
      if (!cancelled) setLocalRevisions(new Map(results.flatMap(result => result.status === 'fulfilled' ? [result.value] : [])))
    })
    return () => { cancelled = true }
  }, [saved, index])

  const observations = useMemo(() => new Map(saved.map(item => [
    item.job.id, observeSavedPosting(item, index, localRevisions.get(item.job), now, error),
  ])), [saved, index, localRevisions, now, error])

  return { observations, check, loading, error, remaining, checked: Boolean(index || error) }
}

export type PostingStatusController = ReturnType<typeof usePostingStatus>
