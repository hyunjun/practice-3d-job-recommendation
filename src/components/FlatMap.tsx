import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { geoNaturalEarth1, geoPath, geoGraticule10 } from 'd3-geo'
import { feature } from 'topojson-client'
import type { FeatureCollection, Geometry } from 'geojson'
import type { GeometryCollection, Topology } from 'topojson-specification'
import type { CityResult } from '../../shared/types'
import { FLAT_MAP_HEIGHT, FLAT_MAP_WIDTH, FLAT_MARKER_SIZE, flatMapScale, flatMapZoomLimit, groupFlatMapPoints, revealFlatMapMarker, zoomFlatMap } from '../lib/flat-map-layout'
import type { GlobeHandle } from './Globe'

interface Props {
  results: CityResult[]
  selectedId: string | null
  hoveredId: string | null
  onSelect: (id: string) => void
  onHover: (id: string | null) => void
  onReady: () => void
}

export const FlatMap = forwardRef<GlobeHandle, Props>(function FlatMap({ results, selectedId, hoveredId, onSelect, onHover, onReady }, ref) {
  const [land, setLand] = useState<FeatureCollection<Geometry> | null>(null)
  const [view, setView] = useState({ x: 0, y: 0, k: 1 })
  const [viewport, setViewport] = useState({ width: FLAT_MAP_WIDTH, height: FLAT_MAP_HEIGHT })
  const [focusTarget, setFocusTarget] = useState<{ element: SVGGElement; cityId: string } | null>(null)
  const viewportScale = flatMapScale(viewport.width, viewport.height)
  const svgRef = useRef<SVGSVGElement>(null)
  const markerElements = useRef(new Map<string, SVGGElement>())
  const removingFocusedMarker = useRef<SVGGElement | null>(null)
  const rememberMarker = useCallback((element: SVGGElement | null) => {
    if (!element) return
    const cityId = element.getAttribute('data-map-marker')!
    markerElements.current.set(cityId, element)
    return () => {
      // Capture focus before DOM removal can fire blur and move it to the document body.
      if (document.activeElement === element && element.matches(':focus-visible')) removingFocusedMarker.current = element
      markerElements.current.delete(cityId)
    }
  }, [])
  const drag = useRef<{ id: number; x: number; y: number; startX: number; startY: number } | null>(null)
  const projection = useMemo(() => geoNaturalEarth1().scale(176).translate([500, 340]), [])
  const path = useMemo(() => geoPath(projection), [projection])
  const geography = useMemo(() => ({
    ocean: path({ type: 'Sphere' }) ?? '',
    grid: path(geoGraticule10()) ?? '',
    countries: land?.features.map(country => path(country) ?? '') ?? [],
  }), [land, path])
  const maxZoom = flatMapZoomLimit(viewportScale)

  useLayoutEffect(() => {
    const container = svgRef.current?.parentElement
    if (!container) return
    const measure = () => {
      const { width, height } = container.getBoundingClientRect()
      if (width > 0 && height > 0) setViewport(previous => previous.width === width && previous.height === height ? previous : { width, height })
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(container)
    return () => observer.disconnect()
  }, [])

  useLayoutEffect(() => {
    drag.current = null
    setView(previous => previous.k > maxZoom ? zoomFlatMap(previous, maxZoom) : previous)
  }, [maxZoom])

  useEffect(() => {
    const controller = new AbortController()
    fetch('/earth/countries-110m.json', { signal: controller.signal }).then(response => response.json()).then((data: Topology) => {
      setLand(feature(data, data.objects.countries as GeometryCollection) as FeatureCollection<Geometry>)
    }).catch(() => {})
    return () => controller.abort()
  }, [])

  const zoom = useCallback((direction: number) => setView(previous => zoomFlatMap(previous,
    Math.max(1, Math.min(maxZoom, previous.k * (direction > 0 ? 1.5 : 1 / 1.5))),
  )), [maxZoom])

  useImperativeHandle(ref, () => ({
    flyTo: (lat, lng, distance) => {
      const point = projection([lng, lat])!
      const k = distance && distance > 2 ? 1.7 : 3.3
      setView({ x: 500 - point[0] * k, y: 345 - point[1] * k, k })
    },
    zoom,
    reset: () => setView({ x: 0, y: 0, k: 1 }),
  }), [projection, zoom])

  useEffect(() => { onReady() }, [onReady])

  const points = useMemo(() => results.map(result => ({ result, point: projection([result.city.lng, result.city.lat])! })), [results, projection])
  const markers = useMemo(() => groupFlatMapPoints(points, view.k * viewportScale).map(group => ({
    item: group[0],
    cityIds: group.map(entry => entry.result.city.id),
    count: new Set(group.flatMap(entry => entry.result.matches.map(match => match.company.id))).size,
  })), [points, view.k, viewportScale])

  useLayoutEffect(() => {
    const svg = svgRef.current
    const removedFocus = removingFocusedMarker.current
    removingFocusedMarker.current = null
    if (!svg || !focusTarget) return
    const active = document.activeElement
    if (active !== focusTarget.element && (removedFocus !== focusTarget.element || active !== document.body)) {
      setFocusTarget(null)
      return
    }
    const group = markers.find(marker => marker.cityIds.includes(focusTarget.cityId))
    const element = group && markerElements.current.get(group.item.result.city.id)
    if (!group || !element) {
      setFocusTarget(null)
      onHover(null)
      svg.focus({ preventScroll: true })
      svg.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' })
      return
    }
    if (element !== focusTarget.element) {
      element.focus({ preventScroll: true })
      // Keep the original city through a merged group, so splitting returns focus to it.
      if (document.activeElement === element) {
        setFocusTarget({ element, cityId: focusTarget.cityId })
        onHover(focusTarget.cityId)
      } else setFocusTarget(null)
      return
    }
    const point = group.item.point
    // Native Tab navigation may have scrolled the page toward the city's old, off-map position.
    svg.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' })
    // Measure after the focused city name is rendered, and include room for its outline.
    const frame = svg.getBoundingClientRect()
    const visibleFrame = { left: Math.max(0, frame.left), top: Math.max(0, frame.top), right: Math.min(window.innerWidth, frame.right), bottom: Math.min(window.innerHeight, frame.bottom) }
    const overlays = Array.from(svg.closest('.map-stage')?.querySelectorAll('[data-map-overlay]') ?? [], element => element.getBoundingClientRect())
    const local = focusTarget.element.getBBox()
    const matrix = svg.getScreenCTM()
    if (!matrix) return
    const inverse = matrix.inverse()
    const origin = new DOMPoint(0, 0).matrixTransform(inverse)
    setView(previous => {
      // Calculate from the current view, including when zoom and focus change together.
      const corners = [local.x, local.x + local.width].flatMap(x =>
        [local.y, local.y + local.height].map(y => new DOMPoint(
          previous.x + point[0] * previous.k + x / viewportScale,
          previous.y + point[1] * previous.k + y / viewportScale,
        ).matrixTransform(matrix)),
      )
      const left = Math.min(...corners.map(corner => corner.x))
      const right = Math.max(...corners.map(corner => corner.x))
      const top = Math.min(...corners.map(corner => corner.y))
      const bottom = Math.max(...corners.map(corner => corner.y))
      const { x: dx, y: dy } = revealFlatMapMarker({ left, right, top, bottom }, visibleFrame, overlays)
      if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return previous
      const moved = new DOMPoint(dx, dy).matrixTransform(inverse)
      return { ...previous, x: previous.x + moved.x - origin.x, y: previous.y + moved.y - origin.y }
    })
  }, [focusTarget, markers, onHover, viewport, viewportScale])

  const endDrag = (pointerId: number) => { if (drag.current?.id === pointerId) drag.current = null }

  return <div className="flat-map">
    <svg
      ref={svgRef}
      viewBox={`0 0 ${FLAT_MAP_WIDTH} ${FLAT_MAP_HEIGHT}`}
      role="region"
      aria-label="2D 기회 지도. 도시의 숫자를 선택해 회사를 확인하세요. 방향키로 이동하고 더하기, 빼기 키로 확대하거나 축소할 수 있습니다. Home 키로 전체 지도를 봅니다."
      tabIndex={0}
      onKeyDown={event => {
        if (event.target !== svgRef.current) return
        if (event.key === '+' || event.key === '=') zoom(1)
        else if (event.key === '-') zoom(-1)
        else if (event.key === 'Home') setView({ x: 0, y: 0, k: 1 })
        else if (event.key.startsWith('Arrow')) setView(v => ({ ...v, x: v.x + (event.key === 'ArrowLeft' ? 50 : event.key === 'ArrowRight' ? -50 : 0) / viewportScale, y: v.y + (event.key === 'ArrowUp' ? 50 : event.key === 'ArrowDown' ? -50 : 0) / viewportScale }))
        else return
        event.preventDefault()
      }}
      onPointerDown={event => {
        if (!event.isPrimary || event.button !== 0 || drag.current || (event.target as Element).closest('[data-map-marker]')) return
        drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, startX: view.x, startY: view.y }
        event.currentTarget.setPointerCapture(event.pointerId)
      }}
      onPointerMove={event => {
        const current = drag.current
        if (!current || current.id !== event.pointerId) return
        const matrix = event.currentTarget.getScreenCTM()
        if (!matrix) return
        const inverse = matrix.inverse()
        const start = new DOMPoint(current.x, current.y).matrixTransform(inverse)
        const next = new DOMPoint(event.clientX, event.clientY).matrixTransform(inverse)
        setView(v => ({ ...v, x: current.startX + next.x - start.x, y: current.startY + next.y - start.y }))
      }}
      onPointerUp={event => endDrag(event.pointerId)}
      onPointerCancel={event => endDrag(event.pointerId)}
      onLostPointerCapture={event => endDrag(event.pointerId)}
    >
      <defs>
        <radialGradient id="ocean"><stop offset="0" stopColor="#15272b" /><stop offset="1" stopColor="#111917" /></radialGradient>
      </defs>
      <g transform={`translate(${view.x},${view.y}) scale(${view.k})`}>
        <path d={geography.ocean} fill="url(#ocean)" stroke="#2b3733" strokeWidth={0.7 / view.k} />
        <path d={geography.grid} fill="none" stroke="#35504c" strokeOpacity="0.28" strokeWidth={0.4 / view.k} />
        {geography.countries.map((shape, index) => <path key={index} d={shape} fill="#24352f" stroke="#59715f" strokeOpacity="0.4" strokeWidth={0.7 / view.k} />)}
        {markers.map(({ item, cityIds, count }) => {
          const active = cityIds.includes(selectedId ?? '') || cityIds.includes(hoveredId ?? '')
          const activate = () => {
            if (cityIds.length > 1) {
              const k = Math.min(view.k * 2.2, maxZoom)
              setView({ k, x: 500 - item.point[0] * k, y: 350 - item.point[1] * k })
            } else onSelect(item.result.city.id)
          }
          return <g
            key={item.result.city.id}
            ref={rememberMarker}
            data-map-marker={item.result.city.id}
            className={`flat-marker ${active ? 'active' : ''}`}
            transform={`translate(${item.point.join(',')}) scale(${1 / (view.k * viewportScale)})`}
            role="button"
            tabIndex={0}
            aria-label={`${item.result.city.name}${cityIds.length > 1 ? ` 외 ${cityIds.length - 1}개 도시` : ''}, 추천 회사 ${count}곳${cityIds.length > 1 ? ', 확대해서 도시별로 보기' : ', 회사 보기'}`}
            onClick={activate}
            onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); activate() } }}
            onPointerEnter={() => onHover(item.result.city.id)}
            onPointerLeave={() => onHover(null)}
            onFocus={event => {
              onHover(item.result.city.id)
              if (event.currentTarget.matches(':focus-visible')) setFocusTarget({ element: event.currentTarget, cityId: item.result.city.id })
            }}
            onBlur={event => {
              if (removingFocusedMarker.current === event.currentTarget) return
              setFocusTarget(null)
              onHover(null)
            }}
          >
            <rect className="flat-marker-hit" x={-FLAT_MARKER_SIZE / 2} y={-FLAT_MARKER_SIZE / 2} width={FLAT_MARKER_SIZE} height={FLAT_MARKER_SIZE} rx="6" fill="transparent" />
            <circle r={active ? 21 : 18} fill={active ? '#d9ffae' : '#c2ed8b'} stroke="#101812" strokeWidth="4" />
            <text textAnchor="middle" dominantBaseline="central" fill="#152013" fontSize="12" fontWeight="700" pointerEvents="none">{count}</text>
            {(view.k >= 2 || active) && <text y="34" textAnchor="middle" fill="#e2e9df" stroke="#101812" strokeWidth="3" paintOrder="stroke" fontSize="12" pointerEvents="none">{item.result.city.name}</text>}
          </g>
        })}
      </g>
    </svg>
  </div>
})
