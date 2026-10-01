/** Return signals are hints to read local storage, never retries of failed input. */
export function installSavedLifecycle(onHint: () => void): () => void {
  let timer: number | undefined
  let disposed = false
  const schedule = () => {
    if (disposed || document.visibilityState !== 'visible' || timer !== undefined) return
    timer = window.setTimeout(() => {
      timer = undefined
      if (!disposed && document.visibilityState === 'visible') onHint()
    }, 0)
  }
  const focus = (event: FocusEvent) => { if (event.target === window) schedule() }
  const pageshow = (event: PageTransitionEvent) => { if (event.persisted) schedule() }
  document.addEventListener('visibilitychange', schedule)
  window.addEventListener('focus', focus)
  window.addEventListener('pageshow', pageshow)
  return () => {
    disposed = true
    if (timer !== undefined) window.clearTimeout(timer)
    document.removeEventListener('visibilitychange', schedule)
    window.removeEventListener('focus', focus)
    window.removeEventListener('pageshow', pageshow)
  }
}
