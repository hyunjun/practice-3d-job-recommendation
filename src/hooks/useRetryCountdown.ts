import { useEffect, useState } from 'react'

export function useRetryCountdown(until?: string): number {
  const secondsLeft = () => until && Number.isFinite(Date.parse(until)) ? Math.max(0, Math.ceil((Date.parse(until) - Date.now()) / 1000)) : 0
  const [remaining, setRemaining] = useState(secondsLeft)
  useEffect(() => {
    setRemaining(secondsLeft())
    if (!secondsLeft()) return
    const timer = window.setInterval(() => {
      const next = secondsLeft()
      setRemaining(next)
      if (!next) window.clearInterval(timer)
    }, 1000)
    return () => window.clearInterval(timer)
  }, [until])
  return until ? remaining : 0
}
