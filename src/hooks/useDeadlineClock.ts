import { createContext, useEffect, useState } from 'react'

export const FreshnessTimeContext = createContext<number | null>(null)

/** One timer for the next actual transition, plus a clock check when a page resumes. */
export function useDeadlineClock(deadlines: readonly number[]): number {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    let timer: number | undefined
    const update = () => {
      window.clearTimeout(timer)
      const current = Date.now()
      setNow(current)
      if (document.hidden) return
      const next = Math.min(...deadlines.filter(time => Number.isFinite(time) && time > current))
      if (Number.isFinite(next)) timer = window.setTimeout(update, Math.min(2_147_483_647, Math.max(1, next - current)))
    }
    update()
    window.addEventListener('focus', update)
    window.addEventListener('pageshow', update)
    document.addEventListener('visibilitychange', update)
    return () => {
      window.clearTimeout(timer)
      window.removeEventListener('focus', update)
      window.removeEventListener('pageshow', update)
      document.removeEventListener('visibilitychange', update)
    }
  }, [deadlines])
  return now
}
