import { describe, expect, it } from 'vitest'
import { geoNaturalEarth1 } from 'd3-geo'
import { CITIES } from '../../shared/cities'
import { flatMapScale, flatMapZoomLimit, groupFlatMapPoints } from '../../src/lib/flat-map-layout'

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
