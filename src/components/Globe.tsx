import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { mesh } from 'topojson-client'
import type { GeometryCollection, Topology } from 'topojson-specification'
import type { CityResult } from '../../shared/types'

export interface GlobeHandle {
  flyTo: (lat: number, lng: number, distance?: number) => void
  zoom: (direction: number) => void
  reset: () => void
}

interface Props {
  results: CityResult[]
  selectedId: string | null
  hoveredId: string | null
  onSelect: (id: string) => void
  onHover: (id: string | null) => void
  onFailure: () => void
  onReady: () => void
  light: boolean
}

interface Marker {
  id: string
  cityIds: string[]
  label: string
  count: number
  x: number
  y: number
  anchorX: number
  anchorY: number
  lat: number
  lng: number
}

export function geoVector(lat: number, lng: number, radius = 1): THREE.Vector3 {
  const phi = lat * Math.PI / 180
  const theta = lng * Math.PI / 180
  return new THREE.Vector3(Math.cos(phi) * Math.sin(theta), Math.sin(phi), Math.cos(phi) * Math.cos(theta)).multiplyScalar(radius)
}

function vectorGeo(vector: THREE.Vector3): { lat: number; lng: number } {
  const normalized = vector.clone().normalize()
  return { lat: Math.asin(normalized.y) * 180 / Math.PI, lng: Math.atan2(normalized.x, normalized.z) * 180 / Math.PI }
}

function makeLine(points: THREE.Vector3[], color: number, opacity: number): THREE.Line {
  const geometry = new THREE.BufferGeometry().setFromPoints(points)
  return new THREE.Line(geometry, new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthWrite: false }))
}

export const Globe = forwardRef<GlobeHandle, Props>(function Globe({ results, selectedId, hoveredId, onSelect, onHover, onFailure, onReady, light }, ref) {
  const containerRef = useRef<HTMLDivElement>(null)
  const apiRef = useRef<GlobeHandle | null>(null)
  const stateRef = useRef({ results, selectedId, hoveredId, onSelect, onHover, onReady, light })
  stateRef.current = { results, selectedId, hoveredId, onSelect, onHover, onReady, light }
  const markerElements = useRef(new Map<string, HTMLButtonElement>())
  const distanceRef = useRef(3.4)
  const [markers, setMarkers] = useState<Marker[]>([])
  const [loaded, setLoaded] = useState(false)

  useImperativeHandle(ref, () => ({
    flyTo: (...args) => apiRef.current?.flyTo(...args),
    zoom: direction => apiRef.current?.zoom(direction),
    reset: () => apiRef.current?.reset(),
  }), [])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    let disposed = false
    let renderer: THREE.WebGLRenderer
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'low-power' })
    } catch {
      onFailure()
      return
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75))
    renderer.setClearColor(0x000000, 0)
    renderer.outputColorSpace = THREE.SRGBColorSpace
    renderer.domElement.setAttribute('aria-hidden', 'true')
    renderer.domElement.addEventListener('webglcontextlost', onFailure)
    container.prepend(renderer.domElement)

    const scene = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 100)
    const controls = new OrbitControls(camera, renderer.domElement)
    controls.enablePan = false
    controls.enableDamping = true
    controls.dampingFactor = 0.085
    controls.rotateSpeed = 0.55
    controls.zoomSpeed = 0.7
    controls.minDistance = 1.42
    controls.maxDistance = 5.8
    controls.minPolarAngle = Math.PI * 0.04
    controls.maxPolarAngle = Math.PI * 0.96
    let width = 1
    let height = 1
    let dirty = true
    let baseDistance = 3.4
    let initial = true
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const resize = () => {
      width = container.clientWidth
      height = container.clientHeight
      if (!width || !height) return
      camera.aspect = width / height
      baseDistance = Math.max(3.4, (width < 600 ? 3.6 : 2.85) / camera.aspect)
      // A map with its own layout space needs no offset for overlaid headings.
      const centered = getComputedStyle(container).getPropertyValue('--map-centered-camera').trim() === '1'
      camera.setViewOffset(width, height, centered ? 0 : -width * (width < 600 ? 0 : 0.035), centered ? 0 : -height * (width < 600 ? 0.17 : 0.08), width, height)
      camera.updateProjectionMatrix()
      renderer.setSize(width, height)
      dirty = true
      if (initial) {
        camera.position.copy(geoVector(29, -39, Math.min(baseDistance, 5.6)))
        camera.lookAt(0, 0, 0)
        controls.update()
        initial = false
      }
    }
    const resizeObserver = new ResizeObserver(resize)
    resizeObserver.observe(container)
    resize()

    let tween: { fromLat: number; fromLng: number; fromDistance: number; lat: number; lng: number; distance: number; start: number; duration: number } | null = null
    const flyTo = (lat: number, lng: number, distance = 1.9) => {
      const from = vectorGeo(camera.position)
      let delta = lng - from.lng
      if (delta > 180) delta -= 360
      if (delta < -180) delta += 360
      tween = { fromLat: from.lat, fromLng: from.lng, fromDistance: camera.position.length(), lat, lng: from.lng + delta, distance: THREE.MathUtils.clamp(distance, controls.minDistance, controls.maxDistance), start: performance.now(), duration: reducedMotion ? 0 : 1150 }
    }
    apiRef.current = {
      flyTo,
      zoom: direction => {
        const location = vectorGeo(camera.position)
        flyTo(location.lat, location.lng, camera.position.length() * (direction > 0 ? 0.78 : 1.28))
      },
      reset: () => flyTo(29, -39, Math.min(baseDistance, 5.6)),
    }
    stateRef.current.onReady()
    controls.addEventListener('start', () => { tween = null })
    controls.addEventListener('change', () => { dirty = true })

    const textureLoader = new THREE.TextureLoader()
    const textures: THREE.Texture[] = []
    const uniforms = {
      nightMap: { value: null as THREE.Texture | null },
      dayMap: { value: null as THREE.Texture | null },
      lightMode: { value: light ? 1 : 0 },
      hasTexture: { value: 0 },
    }
    const sphereMaterial = new THREE.ShaderMaterial({
      uniforms,
      vertexShader: `
        varying vec2 vUv;
        varying vec3 vNormal;
        varying vec3 vPosition;
        void main() {
          vUv = uv;
          vNormal = normalize(normalMatrix * normal);
          vPosition = (modelViewMatrix * vec4(position, 1.0)).xyz;
          gl_Position = projectionMatrix * vec4(vPosition, 1.0);
        }
      `,
      fragmentShader: `
        uniform sampler2D nightMap;
        uniform sampler2D dayMap;
        uniform float lightMode;
        uniform float hasTexture;
        varying vec2 vUv;
        varying vec3 vNormal;
        varying vec3 vPosition;
        void main() {
          vec3 night = texture2D(nightMap, vUv).rgb;
          vec3 day = texture2D(dayMap, vUv).rgb;
          float facing = max(dot(normalize(vNormal), normalize(-vPosition)), 0.0);
          float luminance = dot(night, vec3(0.299, 0.587, 0.114));
          vec3 nightColor = night * vec3(0.58, 0.78, 0.83) + day * vec3(0.048, 0.10, 0.12);
          nightColor += vec3(0.006, 0.017, 0.022);
          nightColor += vec3(0.34, 0.26, 0.10) * pow(luminance, 1.4) * 0.6;
          vec3 dayColor = day * vec3(0.65, 0.8, 0.86);
          vec3 color = mix(nightColor, dayColor, lightMode);
          color *= 0.55 + 0.45 * pow(facing, 0.3);
          color += vec3(0.028, 0.082, 0.105) * pow(1.0 - facing, 3.2);
          gl_FragColor = vec4(mix(vec3(0.022, 0.056, 0.067), color, hasTexture), 1.0);
        }
      `,
    })
    const sphereGeometry = new THREE.SphereGeometry(1, 96, 64)
    sphereGeometry.rotateY(-Math.PI / 2)
    const earth = new THREE.Mesh(sphereGeometry, sphereMaterial)
    scene.add(earth)

    const setTexture = (url: string, key: 'nightMap' | 'dayMap') => {
      textureLoader.load(url, texture => {
        if (disposed) { texture.dispose(); return }
        texture.colorSpace = THREE.NoColorSpace
        texture.anisotropy = Math.min(renderer.capabilities.getMaxAnisotropy(), 8)
        textures.push(texture)
        uniforms[key].value = texture
        dirty = true
        if (uniforms.nightMap.value && uniforms.dayMap.value) {
          uniforms.hasTexture.value = 1
          setLoaded(true)
        }
      }, undefined, () => {
        if (!disposed) setLoaded(true)
      })
    }
    setTexture('/earth/night.jpg', 'nightMap')
    setTexture('/earth/day.jpg', 'dayMap')

    const atmosphere = new THREE.Mesh(
      new THREE.SphereGeometry(1.018, 64, 48),
      new THREE.ShaderMaterial({
        transparent: true, side: THREE.BackSide, depthWrite: false, blending: THREE.AdditiveBlending,
        vertexShader: `
          varying vec3 vNormal;
          varying vec3 vPosition;
          void main() {
            vNormal = normalize(normalMatrix * normal);
            vPosition = (modelViewMatrix * vec4(position, 1.0)).xyz;
            gl_Position = projectionMatrix * vec4(vPosition, 1.0);
          }
        `,
        fragmentShader: `
          varying vec3 vNormal;
          varying vec3 vPosition;
          void main() {
            float rim = pow(1.0 - abs(dot(normalize(vNormal), normalize(-vPosition))), 4.0);
            gl_FragColor = vec4(0.10, 0.30, 0.37, rim * 0.46);
          }
        `,
      }),
    )
    scene.add(atmosphere)

    const graticule = new THREE.Group()
    for (let lat = -60; lat <= 60; lat += 20) {
      const points = []
      for (let lng = -180; lng <= 180; lng += 2) points.push(geoVector(lat, lng, 1.002))
      graticule.add(makeLine(points, 0x7aa8ac, 0.072))
    }
    for (let lng = -180; lng < 180; lng += 20) {
      const points = []
      for (let lat = -90; lat <= 90; lat += 2) points.push(geoVector(lat, lng, 1.002))
      graticule.add(makeLine(points, 0x7aa8ac, 0.065))
    }
    scene.add(graticule)

    const boundaryController = new AbortController()
    fetch('/earth/countries-110m.json', { signal: boundaryController.signal }).then(response => response.json()).then((topology: Topology) => {
      if (disposed) return
      const borders = mesh(topology, topology.objects.countries as GeometryCollection)
      for (const coordinates of borders.coordinates) {
        const points = coordinates.map(([lng, lat]) => geoVector(lat, lng, 1.003))
        scene.add(makeLine(points, 0x7da3a2, 0.16))
      }
      dirty = true
    }).catch(() => { /* A texture-only globe remains usable offline if borders are absent. */ })

    const selection = new THREE.Mesh(
      new THREE.RingGeometry(0.018, 0.023, 48),
      new THREE.MeshBasicMaterial({ color: 0xc7f48b, transparent: true, opacity: 0.8, side: THREE.DoubleSide, depthWrite: false }),
    )
    selection.visible = false
    scene.add(selection)

    let frame = 0
    let markerSignature = ''
    let previousState = stateRef.current
    const project = () => {
      const current = stateRef.current
      distanceRef.current = camera.position.length()
      const cameraDirection = camera.position.clone().normalize()
      const visible = current.results.flatMap(result => {
        const point = geoVector(result.city.lat, result.city.lng, 1.014)
        if (point.clone().normalize().dot(cameraDirection) < 1 / camera.position.length() + 0.06) return []
        const projected = point.clone().project(camera)
        const x = (projected.x + 1) / 2 * width
        const y = (-projected.y + 1) / 2 * height
        if (x < 28 || x > width - 28 || y < 18 || y > height - 42) return []
        return [{ result, point, x, y }]
      }).sort((a, b) => Number(b.result.city.id === current.selectedId) - Number(a.result.city.id === current.selectedId) || b.result.companyCount - a.result.companyCount)

      const groups: typeof visible[] = []
      for (const point of visible) {
        const collision = camera.position.length() > 1.56 ? groups.find(group => Math.abs(group[0].x - point.x) < (width < 600 ? 110 : 130) && Math.abs(group[0].y - point.y) < 46) : undefined
        if (collision) collision.push(point)
        else groups.push([point])
      }
      const next: Marker[] = groups.map(group => {
        const center = group.reduce((sum, point) => sum.add(point.point), new THREE.Vector3()).normalize().multiplyScalar(1.014)
        const position = center.clone().project(camera)
        const cityIds = group.map(item => item.result.city.id).sort()
        const companies = new Set(group.flatMap(item => item.result.matches.map(match => match.company.id)))
        const representative = group[0].result.city
        return {
          id: cityIds.join('_'), cityIds,
          label: group.length > 1 ? `${representative.name} 외 ${group.length - 1}` : representative.name,
          count: companies.size,
          x: Math.max(75, Math.min(width - 80, (position.x + 1) / 2 * width)),
          y: (-position.y + 1) / 2 * height - 14,
          anchorX: (position.x + 1) / 2 * width,
          anchorY: (-position.y + 1) / 2 * height,
          ...vectorGeo(center),
        }
      })
      // At city scale, separate labels vertically while keeping their stems on the city.
      // This also resolves cluster-centroid collisions without hiding individual results.
      next.forEach((marker, index) => {
        for (let attempt = 0; attempt < 8; attempt++) {
          const overlaps = next.slice(0, index).some(previous => Math.abs(previous.x - marker.x) < 126 && Math.abs(previous.y - marker.y) < 36)
          if (!overlaps || marker.y < 55) break
          marker.y -= 38
        }
      })
      const signature = next.map(marker => `${marker.id}:${marker.count}:${marker.label}`).join('|')
      if (signature !== markerSignature) {
        markerSignature = signature
        setMarkers(next)
      }
      for (const marker of next) {
        const element = markerElements.current.get(marker.id)
        if (!element) continue
        element.style.transform = `translate3d(${marker.x}px, ${marker.y}px, 0) translate(-50%, -100%)`
        element.style.opacity = '1'
        element.style.setProperty('--stem-length', `${Math.hypot(marker.anchorX - marker.x, marker.anchorY - marker.y)}px`)
        element.style.setProperty('--stem-angle', `${-Math.atan2(marker.anchorX - marker.x, marker.anchorY - marker.y) * 180 / Math.PI}deg`)
      }
      for (const [id, element] of markerElements.current) {
        if (!next.some(marker => marker.id === id)) element.style.opacity = '0'
      }
    }

    const tick = (now: number) => {
      if (disposed) return
      frame = requestAnimationFrame(tick)
      if (document.hidden) return
      const currentState = stateRef.current
      if (currentState.results !== previousState.results || currentState.selectedId !== previousState.selectedId || currentState.hoveredId !== previousState.hoveredId || currentState.light !== previousState.light) dirty = true
      previousState = currentState
      if (tween) {
        dirty = true
        const progress = tween.duration === 0 ? 1 : Math.min((now - tween.start) / tween.duration, 1)
        const t = 1 - Math.pow(1 - progress, 3)
        camera.position.copy(geoVector(
          THREE.MathUtils.lerp(tween.fromLat, tween.lat, t),
          THREE.MathUtils.lerp(tween.fromLng, tween.lng, t),
          THREE.MathUtils.lerp(tween.fromDistance, tween.distance, t),
        ))
        camera.lookAt(0, 0, 0)
        if (progress === 1) tween = null
      }
      controls.update()
      if (!dirty) return
      uniforms.lightMode.value = stateRef.current.light ? 1 : 0
      const active = stateRef.current.results.find(result => result.city.id === (stateRef.current.hoveredId ?? stateRef.current.selectedId))
      selection.visible = !!active
      if (active) {
        const point = geoVector(active.city.lat, active.city.lng, 1.007)
        selection.position.copy(point)
        selection.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), point.clone().normalize())
      }
      renderer.render(scene, camera)
      project()
      dirty = false
    }
    frame = requestAnimationFrame(tick)

    const keyboard = (event: KeyboardEvent) => {
      if (event.target !== container) return
      const location = vectorGeo(camera.position)
      if (event.key === 'ArrowLeft') flyTo(location.lat, location.lng - 18, camera.position.length())
      else if (event.key === 'ArrowRight') flyTo(location.lat, location.lng + 18, camera.position.length())
      else if (event.key === 'ArrowUp') flyTo(Math.min(80, location.lat + 12), location.lng, camera.position.length())
      else if (event.key === 'ArrowDown') flyTo(Math.max(-80, location.lat - 12), location.lng, camera.position.length())
      else if (event.key === '+' || event.key === '=') apiRef.current?.zoom(1)
      else if (event.key === '-') apiRef.current?.zoom(-1)
      else if (event.key === 'Home') apiRef.current?.reset()
      else return
      event.preventDefault()
    }
    container.addEventListener('keydown', keyboard)

    return () => {
      disposed = true
      cancelAnimationFrame(frame)
      boundaryController.abort()
      resizeObserver.disconnect()
      container.removeEventListener('keydown', keyboard)
      controls.dispose()
      apiRef.current = null
      scene.traverse(object => {
        if (object instanceof THREE.Mesh || object instanceof THREE.Line) {
          object.geometry.dispose()
          const materials = Array.isArray(object.material) ? object.material : [object.material]
          materials.forEach(material => material.dispose())
        }
      })
      textures.forEach(texture => texture.dispose())
      renderer.domElement.removeEventListener('webglcontextlost', onFailure)
      renderer.dispose()
      renderer.domElement.remove()
    }
  // Imperative state is read through stateRef to retain the WebGL context.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onFailure])

  return (
    <div ref={containerRef} className={`earth-canvas ${loaded ? 'is-ready' : ''}`} tabIndex={0} role="region" aria-label="3D 기회 지도. 방향키로 회전하고 더하기, 빼기 키로 확대하거나 축소할 수 있습니다.">
      <div className="globe-markers" role="group" aria-label="지도에 표시된 도시">
        {markers.map(marker => {
          const active = marker.cityIds.includes(selectedId ?? '') || marker.cityIds.includes(hoveredId ?? '')
          return <button
            key={marker.id}
            ref={element => { if (element) markerElements.current.set(marker.id, element); else markerElements.current.delete(marker.id) }}
            className={`globe-pin ${active ? 'active' : ''} ${marker.cityIds.length > 1 ? 'is-cluster' : ''}`}
            style={{ transform: `translate3d(${marker.x}px,${marker.y}px,0) translate(-50%,-100%)`, '--stem-length': `${Math.hypot(marker.anchorX - marker.x, marker.anchorY - marker.y)}px`, '--stem-angle': `${-Math.atan2(marker.anchorX - marker.x, marker.anchorY - marker.y) * 180 / Math.PI}deg` } as CSSProperties}
            aria-label={`${marker.label}, 추천 회사 ${marker.count}곳${marker.cityIds.length > 1 ? ', 확대해서 도시별로 보기' : ', 회사 보기'}`}
            title={`${marker.label}${marker.cityIds.length > 1 ? '개 도시 묶음' : ''} · 추천 회사 ${marker.count}곳`}
            onPointerEnter={() => onHover(marker.cityIds[0])}
            onPointerLeave={() => onHover(null)}
            onFocus={() => onHover(marker.cityIds[0])}
            onBlur={() => onHover(null)}
            onClick={() => {
              if (marker.cityIds.length === 1) onSelect(marker.cityIds[0])
              else apiRef.current?.flyTo(marker.lat, marker.lng, Math.max(1.42, distanceRef.current * 0.65))
            }}
          >
            <span className="pin-label">{marker.label}</span>
            <span className="pin-count">{marker.count}</span>
            <span className="pin-anchor" />
          </button>
        })}
      </div>
    </div>
  )
})
