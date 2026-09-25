import { expect } from '@playwright/test'
import type { Locator, Page } from '@playwright/test'

export const SOURCE_CHOICE_NAMES = {
  sample: '샘플로 탐색 설정 없이 전체 경험을 체험해요 가상의 공고 · 실제 회사 채용 페이지',
  public: '공개 채용공고 회사의 공개 게시판을 함께 조회해요 API 키 없이 · 인터넷 연결 필요',
} as const

export function sourceChoice(page: Page, source: 'sample' | 'public') {
  return page.getByRole('dialog').getByRole('button', { name: SOURCE_CHOICE_NAMES[source], exact: true })
}

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

export async function expectSourceChoice(page: Page, phase: string, selected: 'sample' | 'public', publicDisabled: boolean) {
  const dialog = page.getByRole('dialog')
  const sample = sourceChoice(page, 'sample'), publicButton = sourceChoice(page, 'public')
  await expect(dialog.locator('button[aria-pressed]')).toHaveCount(2)
  await expect(dialog.locator('button[aria-pressed="true"]')).toHaveCount(1)
  await expect(sample).toHaveAccessibleName(SOURCE_CHOICE_NAMES.sample)
  await expect(publicButton).toHaveAccessibleName(SOURCE_CHOICE_NAMES.public)
  await expect(sample).toHaveAttribute('aria-pressed', selected === 'sample' ? 'true' : 'false')
  await expect(publicButton).toHaveAttribute('aria-pressed', selected === 'public' ? 'true' : 'false')
  await expect(sample).toBeEnabled()
  if (publicDisabled) await expect(publicButton).toBeDisabled()
  else await expect(publicButton).toBeEnabled()

  const chosen = selected === 'sample' ? sample : publicButton
  const other = selected === 'sample' ? publicButton : sample
  await chosen.scrollIntoViewIfNeeded()
  const badge = chosen.getByText('선택됨', { exact: true })
  const title = chosen.getByText(selected === 'sample' ? '샘플로 탐색' : '공개 채용공고', { exact: true })
  await expect(dialog.getByText('선택됨', { exact: true })).toHaveCount(1)
  await expect(other.getByText('선택됨', { exact: true })).toHaveCount(0)
  await expect(badge).toBeVisible()
  await expect(badge).toBeInViewport()
  await expect(badge).toHaveAttribute('aria-hidden', 'true')
  await expect(title).toBeVisible()
  await expect(title).toBeInViewport()
  const titleEvidence = await measureTextContrast(title)
  const badgeEvidence = await measureTextContrast(badge)
  // Inactive controls are exempt from WCAG1.4.3. This fixed4.5 threshold is the
  // application's explicit readability policy for its current-source state.
  expect(titleEvidence.effective.ratio, `${phase}: current-source title contrast`).toBeGreaterThanOrEqual(4.5)
  expect(badgeEvidence.effective.ratio, `${phase}: current-source badge contrast`).toBeGreaterThanOrEqual(4.5)
  const box = await chosen.boundingBox()
  expect(box).not.toBeNull()
  for (const { rect } of [titleEvidence, badgeEvidence]) {
    expect(rect.width).toBeGreaterThan(0)
    expect(rect.height).toBeGreaterThan(0)
    expect(rect.x).toBeGreaterThanOrEqual(box!.x)
    expect(rect.y).toBeGreaterThanOrEqual(box!.y)
    expect(rect.x + rect.width).toBeLessThanOrEqual(box!.x + box!.width)
    expect(rect.y + rect.height).toBeLessThanOrEqual(box!.y + box!.height)
  }
  const first = titleEvidence.rect, second = badgeEvidence.rect
  expect(first.x + first.width <= second.x || second.x + second.width <= first.x
    || first.y + first.height <= second.y || second.y + second.height <= first.y,
  `${phase}: current title and selected badge must not overlap`).toBe(true)
  return {
    phase, selected, publicDisabled, minimumContrast: 4.5,
    policy: 'App readability requirement; inactive-control WCAG contrast exemption retained',
    title: titleEvidence, badge: badgeEvidence,
  }
}
