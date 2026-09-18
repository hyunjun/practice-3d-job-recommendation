import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import { geoNaturalEarth1, geoPath, geoGraticule10 } from 'd3-geo'
import { feature } from 'topojson-client'
import type { FeatureCollection, Geometry } from 'geojson'
import type { GeometryCollection, Topology } from 'topojson-specification'
import type { CityResult } from '../../shared/types'
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
  const svgRef = useRef<SVGSVGElement>(null)
  const drag = useRef<{ id: number; x: number; y: number; startX: number; startY: number } | null>(null)
  const projection = useMemo(() => geoNaturalEarth1().scale(176).translate([500, 340]), [])
  const path = useMemo(() => geoPath(projection), [projection])

  useEffect(() => {
    const controller = new AbortController()
    fetch('/earth/countries-110m.json', { signal: controller.signal }).then(response => response.json()).then((data: Topology) => {
      setLand(feature(data, data.objects.countries as GeometryCollection) as FeatureCollection<Geometry>)
    }).catch(() => {})
    return () => controller.abort()
  }, [])

  const zoom = (direction: number) => setView(previous => {
    const k = Math.max(1, Math.min(7, previous.k * (direction > 0 ? 1.5 : 1 / 1.5)))
    return { x: 500 - (500 - previous.x) * k / previous.k, y: 330 - (330 - previous.y) * k / previous.k, k }
  })

  useImperativeHandle(ref, () => ({
    flyTo: (lat, lng, distance) => {
      const point = projection([lng, lat])!
      const k = distance && distance > 2 ? 1.7 : 3.3
      setView({ x: 500 - point[0] * k, y: 345 - point[1] * k, k })
    },
    zoom,
    reset: () => setView({ x: 0, y: 0, k: 1 }),
  }), [projection])

  useEffect(() => { onReady() }, [onReady])

  const points = results.map(result => ({ result, point: projection([result.city.lng, result.city.lat])! }))
  const groups: typeof points[] = []
  for (const item of points) {
    const match = groups.find(group => Math.abs(group[0].point[0] - item.point[0]) * view.k < 43 && Math.abs(group[0].point[1] - item.point[1]) * view.k < 35)
    if (match) match.push(item)
    else groups.push([item])
  }

  return <div className="flat-map">
    <svg
      ref={svgRef}
      viewBox="0 0 1000 640"
      role="region"
      aria-label="2D 기회 지도. 도시의 숫자를 선택해 회사를 확인하세요."
      tabIndex={0}
      onKeyDown={event => {
        if (event.target !== svgRef.current) return
        if (event.key === '+' || event.key === '=') zoom(1)
        else if (event.key === '-') zoom(-1)
        else if (event.key === 'Home') setView({ x: 0, y: 0, k: 1 })
        else if (event.key.startsWith('Arrow')) setView(v => ({ ...v, x: v.x + (event.key === 'ArrowLeft' ? 50 : event.key === 'ArrowRight' ? -50 : 0), y: v.y + (event.key === 'ArrowUp' ? 50 : event.key === 'ArrowDown' ? -50 : 0) }))
        else return
        event.preventDefault()
      }}
      onPointerDown={event => {
        if ((event.target as Element).closest('[data-map-marker]')) return
        drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, startX: view.x, startY: view.y }
        event.currentTarget.setPointerCapture(event.pointerId)
      }}
      onPointerMove={event => {
        if (!drag.current) return
        const rect = event.currentTarget.getBoundingClientRect()
        const scale = 1000 / rect.width
        setView(v => ({ ...v, x: drag.current!.startX + (event.clientX - drag.current!.x) * scale, y: drag.current!.startY + (event.clientY - drag.current!.y) * scale }))
      }}
      onPointerUp={() => { drag.current = null }}
      onPointerCancel={() => { drag.current = null }}
    >
      <defs>
        <radialGradient id="ocean"><stop offset="0" stopColor="#15272b" /><stop offset="1" stopColor="#111917" /></radialGradient>
      </defs>
      <g transform={`translate(${view.x},${view.y}) scale(${view.k})`}>
        <path d={path({ type: 'Sphere' }) ?? ''} fill="url(#ocean)" stroke="#2b3733" strokeWidth={0.7 / view.k} />
        <path d={path(geoGraticule10()) ?? ''} fill="none" stroke="#35504c" strokeOpacity="0.28" strokeWidth={0.4 / view.k} />
        {land?.features.map((country, index) => <path key={index} d={path(country) ?? ''} fill="#24352f" stroke="#59715f" strokeOpacity="0.4" strokeWidth={0.7 / view.k} />)}
        {groups.map(group => {
          const item = group[0]
          const count = new Set(group.flatMap(entry => entry.result.matches.map(match => match.company.id))).size
          const active = group.some(entry => [selectedId, hoveredId].includes(entry.result.city.id))
          const activate = () => {
            if (group.length > 1) {
              const k = Math.min(view.k * 2.2, 7)
              setView({ k, x: 500 - item.point[0] * k, y: 350 - item.point[1] * k })
            } else onSelect(item.result.city.id)
          }
          return <g
            key={item.result.city.id}
            data-map-marker
            className={`flat-marker ${active ? 'active' : ''}`}
            transform={`translate(${item.point.join(',')}) scale(${1 / view.k})`}
            role="button"
            tabIndex={0}
            aria-label={`${item.result.city.name}${group.length > 1 ? ` 외 ${group.length - 1}개 도시` : ''}, 추천 회사 ${count}곳`}
            onClick={activate}
            onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); activate() } }}
            onPointerEnter={() => onHover(item.result.city.id)}
            onPointerLeave={() => onHover(null)}
          >
            <circle r={active ? 21 : 18} fill={active ? '#d9ffae' : '#c2ed8b'} stroke="#101812" strokeWidth="4" />
            <text textAnchor="middle" dominantBaseline="central" fill="#152013" fontSize="12" fontWeight="700">{count}</text>
            {(view.k >= 2 || active) && <text y="34" textAnchor="middle" fill="#e2e9df" stroke="#101812" strokeWidth="3" paintOrder="stroke" fontSize="12">{item.result.city.name}</text>}
          </g>
        })}
      </g>
    </svg>
  </div>
})
