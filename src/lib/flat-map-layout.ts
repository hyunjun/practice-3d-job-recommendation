export const FLAT_MAP_WIDTH = 1000
export const FLAT_MAP_HEIGHT = 640
export const FLAT_MARKER_SIZE = 44

export interface FlatMapView { x: number; y: number; k: number }
interface FlatMapBounds { left: number; top: number; right: number; bottom: number }

export function revealFlatMapMarker(target: FlatMapBounds, viewport: FlatMapBounds, overlays: readonly FlatMapBounds[] = []): { x: number; y: number } {
  const padding = 8
  const width = target.right - target.left
  const height = target.bottom - target.top
  const clampX = (x: number) => Math.max(viewport.left + padding, Math.min(viewport.right - padding - width, x))
  const clampY = (y: number) => Math.max(viewport.top + padding, Math.min(viewport.bottom - padding - height, y))
  const obstacles = overlays.filter(rect => rect.right > rect.left && rect.bottom > rect.top
    && rect.left < viewport.right && rect.right > viewport.left && rect.top < viewport.bottom && rect.bottom > viewport.top)
  // A closest free position lies at the current coordinate, a map edge, or an overlay edge.
  const xs = new Set([clampX(target.left), ...obstacles.flatMap(rect => [clampX(rect.left - padding - width), clampX(rect.right + padding)])])
  const ys = new Set([clampY(target.top), ...obstacles.flatMap(rect => [clampY(rect.top - padding - height), clampY(rect.bottom + padding)])])
  let best = { x: clampX(target.left) - target.left, y: clampY(target.top) - target.top }
  let distance = Infinity
  for (const left of xs) for (const top of ys) {
    if (obstacles.some(rect => left < rect.right + padding && left + width > rect.left - padding
      && top < rect.bottom + padding && top + height > rect.top - padding)) continue
    const x = left - target.left
    const y = top - target.top
    const nextDistance = x * x + y * y
    if (nextDistance < distance) { best = { x, y }; distance = nextDistance }
  }
  return best
}

export function flatMapScale(width: number, height: number): number {
  return Math.min(width / FLAT_MAP_WIDTH, height / FLAT_MAP_HEIGHT)
}

export function flatMapZoomLimit(scale: number): number {
  // Keep nearby registered cities separable even when the whole world fits a phone.
  return Math.max(7, 16 / scale)
}

export function zoomFlatMap(view: FlatMapView, k: number): FlatMapView {
  return { x: 500 - (500 - view.x) * k / view.k, y: 330 - (330 - view.y) * k / view.k, k }
}

export function groupFlatMapPoints<T extends { point: readonly [number, number] }>(points: readonly T[], pixelsPerUnit: number): T[][] {
  const groups: T[][] = []
  for (const point of points) {
    // Reserve space for the touch target and the city name beneath it.
    const group = groups.find(items =>
      Math.abs(items[0].point[0] - point.point[0]) * pixelsPerUnit < FLAT_MARKER_SIZE + 8
      && Math.abs(items[0].point[1] - point.point[1]) * pixelsPerUnit < FLAT_MARKER_SIZE + 28,
    )
    if (group) group.push(point)
    else groups.push([point])
  }
  return groups
}
