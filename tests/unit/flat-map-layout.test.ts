import { describe, expect, it } from 'vitest'
import { geoNaturalEarth1 } from 'd3-geo'
import { CITIES } from '../../shared/cities'
import { flatMapScale, flatMapZoomLimit, groupFlatMapPoints, revealFlatMapMarker } from '../../src/lib/flat-map-layout'

const project = geoNaturalEarth1().scale(176).translate([500, 340])
const points = CITIES.map(city => ({ id: city.id, point: project([city.lng, city.lat])! }))

describe('flat map controls in screen coordinates', () => {
  it('groups nearby controls in CSS pixels in both portrait and wide viewports', () => {
    const pair = [{ point: [0, 0] as const }, { point: [100, 0] as const }]
    expect(groupFlatMapPoints(pair, flatMapScale(320, 590))).toHaveLength(1)
    expect(groupFlatMapPoints(pair, flatMapScale(1440, 960))).toHaveLength(2)
    // A wide, short map is fitted by its height.
    expect(groupFlatMapPoints(pair, flatMapScale(2560, 240))).toHaveLength(1)
  })

  it('retains every city exactly once and leaves room between visible controls and their labels', () => {
    for (const scale of [0.32, 0.39, 0.9, 1.08, 1.5]) for (const zoom of [1, 2.2, 4.84]) {
      const groups = groupFlatMapPoints(points, scale * zoom)
      expect(groups.flat().map(point => point.id).sort()).toEqual(points.map(point => point.id).sort())
      for (let i = 0; i < groups.length; i++) for (let j = i + 1; j < groups.length; j++) {
        const a = groups[i][0].point
        const b = groups[j][0].point
        const xGap = Math.abs(a[0] - b[0]) * scale * zoom
        const yGap = Math.abs(a[1] - b[1]) * scale * zoom
        expect(xGap >= 52 || yGap >= 72).toBe(true)
      }
    }
  })

  it('can separate all registered cities, including Seattle and Vancouver, at every supported viewport scale', () => {
    for (const scale of [0.32, 0.39, 0.9, 1.08, 1.5, 2.5]) {
      const zoom = flatMapZoomLimit(scale)
      const groups = groupFlatMapPoints(points, scale * zoom)
      expect(groups).toHaveLength(CITIES.length)
      expect(groups.every(group => group.length === 1)).toBe(true)
    }
  })
})

describe('revealing keyboard focus on the flat map', () => {
  const viewport = { left: 0, top: 0, right: 320, bottom: 260 }

  it('leaves an exposed marker in place and ignores controls outside the map', () => {
    expect(revealFlatMapMarker({ left: 100, top: 90, right: 144, bottom: 150 }, viewport, [
      { left: 0, top: -60, right: 320, bottom: 0 },
      { left: 0, top: 280, right: 320, bottom: 324 },
      { left: 0, top: 0, right: 0, bottom: 0 },
    ])).toEqual({ x: 0, y: 0 })
  })

  it('brings the whole city caption inside the map with room for the focus indicator', () => {
    expect(revealFlatMapMarker({ left: 100, top: -40, right: 144, bottom: 20 }, viewport)).toEqual({ x: 0, y: 48 })
    expect(revealFlatMapMarker({ left: -20, top: 240, right: 60, bottom: 300 }, viewport)).toEqual({ x: 28, y: -48 })
    expect(revealFlatMapMarker({ left: 400, top: 90, right: 444, bottom: 150 }, viewport)).toEqual({ x: -132, y: 0 })
  })

  it('finds the nearest free position when avoiding one control would move the city under another', () => {
    expect(revealFlatMapMarker({ left: 100, top: 8, right: 144, bottom: 68 }, viewport, [
      { left: 0, top: 20, right: 320, bottom: 64 },
      { left: 90, top: 70, right: 200, bottom: 150 },
    ])).toEqual({ x: -62, y: 64 })
  })

  it('keeps the target inside the map when no position can avoid an overlay covering the whole viewport', () => {
    expect(revealFlatMapMarker({ left: -100, top: -100, right: -56, bottom: -40 }, viewport, [viewport]))
      .toEqual({ x: 108, y: 108 })
  })
})
