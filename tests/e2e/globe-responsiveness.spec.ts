import { expect } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { resourceCheckedTest as test } from './helpers/public-app'
import { readSaved, readSavedJson } from './helpers/saved-store'
import {
  expectGlobeTraffic, globeCity, globeFrames, globeHeading, globePins, globeRegion,
  installGlobeStream, openGlobe,
} from './helpers/globe-responsiveness'
import { GLOBE_PAIR_QUERY } from '../fixtures/globe-responsiveness'

test.use({ viewport: { width: 1440, height: 960 }, reducedMotion: 'reduce', serviceWorkers: 'block' })
test.setTimeout(60_000)

test('cluster unions update from three to four to five while the final two city counts both stay four', async ({ page, baseURL }, info) => {
  const state = await installGlobeStream(page, new URL(baseURL!).origin)
  try {
    await openGlobe(page, { query: GLOBE_PAIR_QUERY })
    await expect(page.locator('.collection-progress')).toContainText('6,600개 공고')
    await expect.poll(() => page.locator('.city-row-main').evaluateAll(elements => elements.map(element => element.getAttribute('aria-label')))).toEqual([
      '암스테르담, 추천 회사 3곳 보기', '런던, 추천 회사 3곳 보기',
    ])
    const cluster = page.locator('.globe-pin')
    await expect(cluster).toHaveCount(1)
    await expect(cluster).toHaveAttribute('aria-label', '암스테르담 외 1, 추천 회사 3곳, 확대해서 도시별로 보기')
    await expect(page.locator('.active-filter-summary')).toContainText('600개 공고')

    state.release(1)
    await expect(cluster).toHaveAttribute('aria-label', '암스테르담 외 1, 추천 회사 4곳, 확대해서 도시별로 보기')
    await expect(page.locator('.collection-progress')).toContainText('6,780개 공고')
    await expect.poll(() => page.locator('.city-row-main').evaluateAll(elements => elements.map(element => element.getAttribute('aria-label')))).toEqual([
      '암스테르담, 추천 회사 4곳 보기', '런던, 추천 회사 4곳 보기',
    ])
    await expect(page.locator('.active-filter-summary')).toContainText('640개 공고')
    await cluster.focus()
    await expect(cluster).toBeFocused()
    await globeFrames(page)
    const position = (await globePins(page))[0].transform

    // Copper leaves London, Grove arrives there. Neither city's count changes.
    state.release(2)
    await expect(cluster).toHaveAttribute('aria-label', '암스테르담 외 1, 추천 회사 5곳, 확대해서 도시별로 보기')
    await expect(cluster).toBeFocused()
    await expect.poll(() => page.locator('.city-row-main').evaluateAll(elements => elements.map(element => element.getAttribute('aria-label')))).toEqual([
      '암스테르담, 추천 회사 4곳 보기', '런던, 추천 회사 4곳 보기',
    ])
    await expect(page.locator('.active-filter-summary')).toContainText('640개 공고')
    await expect(page.locator('.collection-progress')).toHaveCount(0)
    await expect(page.locator('.city-detail-hero')).toHaveCount(0)
    expect((await globePins(page))[0].transform).toBe(position)
    await page.screenshot({ path: info.outputPath('five-unique-companies-two-four-company-cities.png') })

    // Native keyboard activation zooms the cluster, then exposes both cities.
    await cluster.press('Enter')
    await globeFrames(page)
    for (let step = 0; step < 2; step++) {
      await page.getByRole('button', { name: '지도 확대', exact: true }).click()
      await globeFrames(page)
    }
    await expect(page.locator('.globe-pin.is-cluster')).toHaveCount(0)
    await expect(globeCity(page, '암스테르담', 4)).toBeVisible()
    await expect(globeCity(page, '런던', 4)).toBeVisible()
    await globeRegion(page).focus()
    await page.keyboard.press('Tab')
    await expect(globeCity(page, '암스테르담', 4)).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(globeHeading(page)).toContainText('암스테르담')
    await expect(page.locator('.city-coordinate')).toHaveText('52.37°N')
    await expect(page.locator('.company-card h3')).toHaveText([
      'Globe Aster', 'Globe Beacon', 'Globe Copper', 'Globe Fresnel',
    ])
    // City selection uses the normal fly-to distance, which can merge the
    // nearby pair again. Zoom once to switch directly from Amsterdam to London.
    await globeFrames(page)
    await globeRegion(page).focus()
    await page.keyboard.press('+')
    await globeFrames(page)
    await expect(globeCity(page, '런던', 4)).toBeVisible()
    await globeCity(page, '런던', 4).focus()
    await page.keyboard.press('Enter')
    await expect(globeHeading(page)).toContainText('런던')
    await expect(page.locator('.city-coordinate')).toHaveText('51.51°N')
    await expect(page.locator('.company-card h3')).toHaveText([
      'Globe Aster', 'Globe Beacon', 'Globe Fresnel', 'Globe Grove',
    ])
    await expect(page.getByRole('button', {
      name: '런던 외 1, 추천 회사 5곳, 확대해서 도시별로 보기', exact: true,
    })).toHaveClass(/\bactive\b/)
    expectGlobeTraffic(state)
  } finally { state.dispose() }
})

test('selected city, saved opportunity and search focus survive streamed membership changes and reload', async ({ page, baseURL }, info) => {
  const state = await installGlobeStream(page, new URL(baseURL!).origin)
  try {
    await openGlobe(page, { selectedId: 'london', query: GLOBE_PAIR_QUERY })
    await expect(globeHeading(page)).toContainText('런던')
    await expect(page.locator('.company-card h3')).toHaveText(['Globe Aster', 'Globe Beacon', 'Globe Copper'])
    const canvas = await page.locator('.earth-canvas > canvas').elementHandle()
    const title = 'Backend Engineer — Globe Aster London CanalPair 001'
    await page.getByRole('button', { name: title, exact: true }).click()
    await page.getByRole('button', { name: '기회 저장', exact: true }).click()
    const note = page.getByLabel('이 기회에 대한 나의 메모')
    await note.fill('Stage 66: retain this private synthetic note')
    await page.getByRole('button', { name: '지원 완료로 표시', exact: true }).click()
    await note.focus()
    const saved = await readSavedJson(page)
    expect((await readSaved(page)).map(record => ({
      id: record.job.id, title: record.job.title, company: record.company.name, note: record.note, status: record.status,
    }))).toEqual([{
      id: 'greenhouse-globe-fixture-aster-london-001', title, company: 'Globe Aster',
      note: 'Stage 66: retain this private synthetic note', status: 'applied',
    }])

    state.release(1)
    await expect(page.locator('.company-card h3')).toHaveText([
      'Globe Aster', 'Globe Beacon', 'Globe Copper', 'Globe Fresnel',
    ])
    await expect(note).toBeFocused()
    await expect(note).toHaveValue('Stage 66: retain this private synthetic note')
    await expect(globeHeading(page)).toContainText('런던')
    expect(await readSavedJson(page)).toBe(saved)
    await page.getByRole('button', { name: '닫기', exact: true }).click()

    const search = page.getByLabel('도시, 회사 또는 포지션 검색')
    await search.fill('Globe Aster')
    await expect(page.locator('.company-card h3')).toHaveText(['Globe Aster'])
    await expect(search).toBeFocused()
    state.release(2)
    await expect(page.locator('.collection-progress')).toHaveCount(0)
    await expect(search).toBeFocused()
    await expect(search).toHaveValue('Globe Aster')
    await expect(globeHeading(page)).toContainText('런던')
    await expect(page.locator('.company-card h3')).toHaveText(['Globe Aster'])
    expect(await canvas!.evaluate(element => element === document.querySelector('.earth-canvas > canvas'))).toBe(true)
    expect(await readSavedJson(page)).toBe(saved)

    await page.getByRole('button', { name: '검색어 지우기', exact: true }).click()
    await expect(page.locator('.company-card h3')).toHaveText([
      'Globe Aster', 'Globe Beacon', 'Globe Fresnel', 'Globe Grove',
    ])
    await expect(page.locator('.city-coordinate')).toHaveText('51.51°N')
    await page.screenshot({ path: info.outputPath('selected-city-after-stream.png') })
    await page.reload()
    await expect(page.locator('.earth-canvas')).toHaveClass(/is-ready/)
    await expect(globeHeading(page)).toContainText('런던')
    await expect(page.locator('.company-card h3')).toHaveText([
      'Globe Aster', 'Globe Beacon', 'Globe Fresnel', 'Globe Grove',
    ])
    await page.getByRole('button', { name: title, exact: true }).click()
    await expect(note).toHaveValue('Stage 66: retain this private synthetic note')
    expect(await readSavedJson(page)).toBe(saved)
    expectGlobeTraffic(state)
  } finally { state.dispose() }
})

test('real WebGL drag and keyboard rotation retain usable focus, exact counts and selected coordinates across views', async ({ page, baseURL }, info) => {
  const state = await installGlobeStream(page, new URL(baseURL!).origin)
  try {
    await openGlobe(page)
    await expect(page.locator('.city-row')).toHaveCount(22)
    await expect(page.locator('.map-stats strong')).toHaveText(['5곳', '22곳'])
    expect(await page.locator('.earth-canvas > canvas').evaluate((element: HTMLCanvasElement) =>
      element.getContext('webgl2')?.getParameter(WebGL2RenderingContext.VERSION))).toMatch(/WebGL 2/)
    const before = await globePins(page)
    const box = (await page.locator('.earth-canvas > canvas').boundingBox())!
    await page.mouse.move(box.x + box.width * 0.45, box.y + box.height * 0.65)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width * 0.70, box.y + box.height * 0.58, { steps: 24 })
    await page.mouse.up()
    await globeFrames(page, 40)
    const dragged = await globePins(page)
    expect(dragged.some(pin => {
      const prior = before.find(item => item.label === pin.label)
      return !prior || Math.hypot(pin.x - prior.x, pin.y - prior.y) > 20
    })).toBe(true)
    await expect(page.locator('.city-detail-hero')).toHaveCount(0)
    await expect(page.locator('.city-row')).toHaveCount(22)

    const region = globeRegion(page)
    await region.focus()
    await page.keyboard.press('ArrowRight')
    await globeFrames(page, 4)
    await expect(region).toBeFocused()
    expect(await globePins(page)).not.toEqual(dragged)
    await page.keyboard.press('Home')
    await globeFrames(page, 4)
    await expect(page.getByRole('button', {
      name: '암스테르담 외 5, 추천 회사 3곳, 확대해서 도시별로 보기', exact: true,
    })).toBeVisible()
    await expect(region).toBeFocused()

    state.release(1)
    await expect(page.locator('.map-stats strong')).toHaveText(['6곳', '22곳'])
    state.release(2)
    await expect(page.locator('.map-stats strong')).toHaveText(['7곳', '22곳'])
    await expect(page.locator('.collection-progress')).toHaveCount(0)
    await expect(region).toBeFocused()
    await page.getByRole('button', { name: '런던, 추천 회사 4곳 보기', exact: true }).click()
    await expect(globeHeading(page)).toContainText('런던')
    await expect(page.locator('.city-coordinate')).toHaveText('51.51°N')
    await expect(page.locator('.company-card')).toHaveCount(4)
    await page.getByRole('button', { name: '2D 지도', exact: true }).click()
    await expect(page.locator('.flat-map svg')).toBeVisible()
    await expect(globeHeading(page)).toContainText('런던')
    await page.getByRole('button', { name: '3D 지구', exact: true }).click()
    await expect(page.locator('.earth-canvas')).toHaveClass(/is-ready/)
    await expect(page.locator('.earth-canvas > canvas')).toHaveCount(1)
    await expect(globeHeading(page)).toContainText('런던')
    await expect(page.locator('.company-card h3')).toHaveText([
      'Globe Aster', 'Globe Beacon', 'Globe Fresnel', 'Globe Grove',
    ])
    const accessibility = await new AxeBuilder({ page }).include('.map-stage')
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()
    expect(accessibility.violations).toEqual([])
    await info.attach('globe-accessibility', {
      body: Buffer.from(JSON.stringify(accessibility)), contentType: 'application/json',
    })
    await page.screenshot({ path: info.outputPath('globe-after-drag-keyboard-stream-view-change.png') })
    expectGlobeTraffic(state)
  } finally { state.dispose() }
})
