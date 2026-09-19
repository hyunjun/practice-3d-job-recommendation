export const FLAT_MAP_WIDTH = 1000
export const FLAT_MAP_HEIGHT = 640
export const FLAT_MARKER_SIZE = 44

export interface FlatMapView { x: number; y: number; k: number }

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
