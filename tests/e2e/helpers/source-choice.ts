import { expect } from '@playwright/test'
import type { Locator, Page } from '@playwright/test'

type Color = [number, number, number, number]
type Layer = {
  tag: string; color: string; background: string; opacity: number
  backgroundImage: string; filter: string; backdropFilter: string; mixBlendMode: string
}

function color(value: string): Color {
  if (value === 'transparent') return [0, 0, 0, 0]
  const match = /^rgba?\(([^)]+)\)$/.exec(value)
  if (!match) throw new Error(`Unsupported computed color: ${value}`)
  const parts = match[1].trim().split(/[,\s/]+/)
  if (parts.length !== 3 && parts.length !== 4) throw new Error(`Invalid color: ${value}`)
  const channels = parts.slice(0, 3).map(part => part.endsWith('%') ? Number.parseFloat(part) * 2.55 : Number(part))
  const alpha = parts[3] === undefined ? 1
    : parts[3].endsWith('%') ? Number.parseFloat(parts[3]) / 100 : Number(parts[3])
  if (channels.some(channel => !Number.isFinite(channel) || channel < 0 || channel > 255)
    || !Number.isFinite(alpha) || alpha < 0 || alpha > 1) throw new Error(`Invalid color: ${value}`)
  return [channels[0], channels[1], channels[2], alpha]
}

function over(front: Color, back: Color): Color {
  const alpha = front[3] + back[3] * (1 - front[3])
  if (alpha === 0) return [0, 0, 0, 0]
  return [
    (front[0] * front[3] + back[0] * back[3] * (1 - front[3])) / alpha,
    (front[1] * front[3] + back[1] * back[3] * (1 - front[3])) / alpha,
    (front[2] * front[3] + back[2] * back[3] * (1 - front[3])) / alpha,
    alpha,
  ]
}

function luminance(value: Color) {
  const linear = value.slice(0, 3).map(channel => {
    const srgb = channel / 255
    return srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2]
}

/**
 * Paint the text and the same point without text, from the leaf outward.
 * Opacity applies to each complete element group, not just its foreground.
 * This is an independent sRGB calculation; no application helper or CSS
 * selector/value is used as the contrast oracle.
 */
export function compositeTextContrast(foreground: string, layers: Layer[]) {
  let text = color(foreground)
  let background: Color = [0, 0, 0, 0]
  for (const layer of layers) {
    if (layer.backgroundImage !== 'none' || layer.filter !== 'none'
      || layer.backdropFilter !== 'none' || layer.mixBlendMode !== 'normal')
      throw new Error(`Unsupported painting effect in contrast evidence: ${JSON.stringify(layer)}`)
    if (!Number.isFinite(layer.opacity) || layer.opacity < 0 || layer.opacity > 1)
      throw new Error(`Invalid ancestor opacity: ${JSON.stringify(layer)}`)
    text = over(text, color(layer.background))
    background = over(background, color(layer.background))
    text[3] *= layer.opacity
    background[3] *= layer.opacity
  }
  // The real dialog/root provide an opaque background. Do not silently assume a
  // canvas color if a future transparent dialog exposes unmeasured content.
  if (text[3] !== 1 || background[3] !== 1) throw new Error('No opaque backdrop in measured ancestor chain')
  const first = luminance(text), second = luminance(background)
  return {
    foreground: text, background,
    ratio: (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05),
  }
}

export async function measureTextContrast(locator: Locator) {
  const measured = await locator.evaluate(element => {
    const own = getComputedStyle(element)
    const layers = []
    let node: Element | null = element
    while (node) {
      const style = getComputedStyle(node)
      layers.push({
        tag: node.tagName.toLowerCase(),
        color: style.color, background: style.backgroundColor, opacity: Number(style.opacity),
        backgroundImage: style.backgroundImage, filter: style.filter,
        backdropFilter: style.backdropFilter, mixBlendMode: style.mixBlendMode,
      })
      node = node.parentElement
    }
    const rect = element.getBoundingClientRect()
    return {
      text: element.textContent?.trim() ?? '', foreground: own.color,
      textFill: own.getPropertyValue('-webkit-text-fill-color'),
      textShadow: own.textShadow, fontSize: own.fontSize, layers,
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    }
  })
  if (measured.textShadow !== 'none') throw new Error('Text shadow needs an explicit contrast assessment')
  if (measured.textFill && measured.textFill !== measured.foreground)
    throw new Error('Text fill differs from the measured foreground')
  return { ...measured, effective: compositeTextContrast(measured.foreground, measured.layers) }
}

/** The source disclosure replaces the retired mode selector. */
export async function expectPublicSourceOverview(page: Page, phase = 'public source disclosure') {
  const dialog = page.getByRole('dialog')
  const overview = dialog.getByRole('region', { name: '공개 채용공고', exact: true })
  await expect(overview).toHaveCount(1)
  await expect(dialog.locator('.data-source-options, button[aria-pressed]')).toHaveCount(0)
  await expect(dialog.getByRole('button', { name: /샘플로 탐색|샘플 탐색/ })).toHaveCount(0)
  await expect(dialog.getByText('선택됨', { exact: true })).toHaveCount(0)
  const title = overview.getByRole('heading', { name: '공개 채용공고', exact: true })
  const description = overview.locator('p')
  const connectivity = overview.locator('small')
  await expect(description).toHaveText('회사 공식 게시판과 공개 잡 사이트에서 수집한 공고로 탐색해요. 각 공고의 출처·원문·조회 시각을 확인할 수 있어요.')
  await expect(connectivity).toHaveText('새 공고를 조회하려면 인터넷 연결이 필요해요.')
  const evidence = []
  for (const text of [title, description, connectivity]) {
    await text.scrollIntoViewIfNeeded()
    await expect(text).toBeVisible()
    await expect(text).toBeInViewport()
    const measured = await measureTextContrast(text)
    expect(measured.effective.ratio, `${phase}: ${measured.text}`).toBeGreaterThanOrEqual(4.5)
    expect(measured.rect.width).toBeGreaterThan(0)
    expect(measured.rect.height).toBeGreaterThan(0)
    evidence.push(measured)
  }
  expect(await overview.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
  return { phase, minimumContrast: 4.5, evidence }
}
