import { expect } from '@playwright/test'
import type { Locator, Page } from '@playwright/test'

export async function expectFlatMapFocus(marker: Locator) {
  await expect(marker).toBeFocused()
  await expect.poll(() => marker.evaluate(element => {
    const viewport = element.closest('svg')!.getBoundingClientRect()
    const full = element.getBoundingClientRect()
    const target = element.querySelector('.flat-marker-hit')!.getBoundingClientRect()
    const overlays = Array.from(element.closest('.map-stage')!.querySelectorAll('[data-map-overlay]'), overlay => overlay.getBoundingClientRect())
    return element.matches(':focus-visible')
      && full.left >= Math.max(0, viewport.left) && full.right <= Math.min(innerWidth, viewport.right)
      && full.top >= Math.max(0, viewport.top) && full.bottom <= Math.min(innerHeight, viewport.bottom)
      && overlays.every(overlay => overlay.width === 0 || overlay.height === 0
        || full.right <= overlay.left || full.left >= overlay.right || full.bottom <= overlay.top || full.top >= overlay.bottom)
      && [0.15, 0.5, 0.85].every(x => [0.15, 0.5, 0.85].every(y => {
        const hit = document.elementFromPoint(target.left + target.width * x, target.top + target.height * y)
        return hit !== null && element.contains(hit)
      }))
  }), { message: 'The focused city, its name and its pointer target must be visible inside the map' }).toBe(true)
}

async function measureTargets(page: Page) {
  return page.locator('.flat-marker').evaluateAll(elements => {
    // Resizing can remove nodes between resolving the locator and measuring them.
    if (elements.some(element => !element.isConnected || !(element as SVGGElement).ownerSVGElement)) return []
    return elements.map(element => {
      const marker = element as SVGGElement
      const svg = marker.ownerSVGElement!
      let matrix = svg.getScreenCTM()
      // Read the declared transforms without modifying the SVG transform lists.
      if (matrix) for (const group of [marker.parentElement as unknown as SVGGElement, marker]) {
        const transforms = group.transform.baseVal
        for (let index = 0; index < transforms.numberOfItems; index++) matrix = matrix.multiply(transforms.getItem(index).matrix)
      }
      const expected = matrix ? new DOMPoint(0, 0).matrixTransform(matrix) : null
      const target = marker.querySelector('.flat-marker-hit')!.getBoundingClientRect()
      const text = marker.querySelector('text')!
      const textMatrix = text.getScreenCTM()
      return {
        target: target.toJSON(), frame: svg.getBoundingClientRect().toJSON(),
        font: textMatrix ? parseFloat(getComputedStyle(text).fontSize) * Math.hypot(textMatrix.a, textMatrix.b) : NaN,
        positionError: expected ? Math.hypot(target.x + target.width / 2 - expected.x, target.y + target.height / 2 - expected.y) : Infinity,
      }
    })
  })
}

export async function expectFlatMapTargets(page: Page) {
  let targets: Awaited<ReturnType<typeof measureTargets>> = []
  // SVG screen bounds can lag behind updated attributes, even after two frames.
  // Check one complete measurement so a second read cannot observe an intermediate layout.
  await expect.poll(async () => {
    targets = await measureTargets(page)
    return targets.length > 0 && targets.every(({ target, font, positionError }) =>
      Math.abs(target.width - 44) < 0.005 && Math.abs(target.height - 44) < 0.005
      && Math.abs(font - 12) < 0.005 && positionError < 0.05,
    )
  }, { message: 'The rendered map must have 44px targets and 12px text at the current SVG positions' }).toBe(true)
  return targets
}
