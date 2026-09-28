(() => {
  const qa = window.__arrivalQA = {
    active: false, frames: [], longTasks: [], inputs: [], pending: [],
    visibility: [], marks: [], trustedDragMoves: 0, catalogInteractiveAt: null,
  }
  new PerformanceObserver(list => {
    for (const entry of list.getEntries())
      if (qa.active && entry.startTime >= qa.startedAt)
        qa.longTasks.push({ at: entry.startTime, duration: entry.duration, name: entry.name })
  }).observe({ type: 'longtask', buffered: true })
  let last = 0
  const frame = at => {
    requestAnimationFrame(frame)
    if (!qa.active) { last = 0; return }
    if (last) qa.frames.push({ at, interval: at - last })
    last = at
    if (qa.eofArmed && qa.catalogInteractiveAt === null) {
      const loading = document.querySelector('.data-status-button')?.textContent?.includes('조회 중')
      const actualVisible = qa.scenario === 'cold'
        ? document.querySelectorAll('.city-row').length > 2
        : [...document.querySelectorAll('.company-card h3')].some(node => node.textContent === 'Databricks')
      if (!loading && actualVisible) qa.catalogInteractiveAt = at
    }
    for (const input of [...qa.pending]) {
      const heading = document.querySelector('.city-hero-caption h2')
      if (!heading?.textContent?.startsWith(input.city) || !heading.getBoundingClientRect().width) continue
      qa.pending.splice(qa.pending.indexOf(input), 1)
      requestAnimationFrame(paint => qa.inputs.push({
        ...input, domObservedAt: at, paintOpportunityAt: paint, latency: paint - input.at,
      }))
    }
  }
  requestAnimationFrame(frame)
  const selection = event => {
    if (!qa.active || (event.type === 'keydown' && event.key !== 'Enter')) return
    const target = event.target.closest?.('.city-row-main,.globe-pin:not(.is-cluster)')
    if (!target) return
    const city = target.getAttribute('aria-label')?.split(',')[0]
    if (city) qa.pending.push({
      city, at: event.timeStamp, deliveredAt: performance.now(), trusted: event.isTrusted,
      event: event.type, source: target.classList.contains('city-row-main') ? 'city-list' : 'globe-pin',
    })
  }
  document.addEventListener('pointerdown', selection, true)
  document.addEventListener('keydown', selection, true)
  document.addEventListener('pointermove', event => {
    if (qa.active && event.isTrusted && event.buttons === 1 && event.target.matches('.earth-canvas > canvas'))
      qa.trustedDragMoves++
  }, true)
  document.addEventListener('visibilitychange', () => qa.visibility.push({ at: performance.now(), hidden: document.hidden }))
})()
