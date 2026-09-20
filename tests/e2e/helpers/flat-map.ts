import { expect } from '@playwright/test'
import type { Page } from '@playwright/test'

async function measureTargets(page: Page) {
  return page.locator('.flat-marker').evaluateAll(elements => elements.map(element => {
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
  }))
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
