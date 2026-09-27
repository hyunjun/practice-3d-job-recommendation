import { waitForSavedCommit } from './helpers/saved-store'
import { expect } from '@playwright/test'
import type { Locator } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import path from 'node:path'
import { readFile } from 'node:fs/promises'
import { PUBLIC_PROTOCOL_COMPANIES, PUBLIC_PROTOCOL_TIME, publicProtocolCatalog, publicProtocolJob } from '../fixtures/public-protocol'
import { publicAppTest as test, expectPublicOnlyDialog } from './helpers/public-app'

test.beforeEach(async ({ page }) => { await page.clock.setFixedTime(new Date(PUBLIC_PROTOCOL_TIME)) })

const profileText = `Alex Kim\nBackend Engineer\n5 years of software engineering experience.\nI build payment APIs with Python, TypeScript, React, Node.js, PostgreSQL and AWS.\nDO_NOT_PERSIST_RAW_RESUME alice-private@example.test`

test('3D map, region selection, city panel and 2D view stay connected', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto('/')
  await expect(page.locator('.earth-canvas')).toHaveClass(/is-ready/)
  await expect(page.locator('.globe-pin').first()).toBeVisible()
  await expect(page.locator('.city-row')).toHaveCount(22)
  await page.getByRole('button', { name: /^런던, 추천 회사 \d+곳 보기$/ }).click()
  await expect(page.locator('.city-hero-caption h2')).toContainText('런던')
  await expect(page.locator('.company-card').first()).toBeVisible()
  await page.getByRole('button', { name: '모든 도시', exact: true }).click()
  await page.getByRole('button', { name: '유럽', exact: true }).click()
  await expect(page.locator('.city-row')).toHaveCount(9)
  await page.getByRole('button', { name: '2D 지도', exact: true }).click()
  await expect(page.locator('.flat-map svg')).toBeVisible()
  await expect(page.locator('.flat-marker').first()).toBeVisible()
  await page.getByRole('button', { name: '지도 확대', exact: true }).click()
  await page.getByLabel('도시, 회사 또는 포지션 검색').fill('존재하지않는회사')
  await expect(page.getByRole('heading', { name: '조건에 맞는 도시가 아직 없어요' })).toBeVisible()
  await expect(page.locator('.flat-marker')).toHaveCount(0)
  await page.locator('.active-filter-summary').getByRole('button', { name: '초기화', exact: true }).click()
  await expect(page.locator('.city-row')).toHaveCount(22)
  expect(errors).toEqual([])
})

test('profile text is parsed locally, reviewed and persisted without the raw resume', async ({ page }) => {
  const uploads: string[] = []
  page.on('request', request => { if (['POST', 'PUT', 'PATCH'].includes(request.method())) uploads.push(request.url()) })
  await page.goto('/')
  await page.getByRole('button', { name: '내 프로필 편집', exact: true }).click()
  await page.getByRole('button', { name: '텍스트', exact: true }).click()
  await page.getByLabel('경력 요약', { exact: true }).fill(profileText)
  await page.getByRole('button', { name: '경력에서 가능성 찾기', exact: true }).click()
  await expect(page.getByLabel('개발 경력', { exact: true })).toHaveValue('5')
  await expect(page.getByLabel('이름 또는 별명')).toHaveValue('Alex Kim')
  await page.getByLabel('희망 직무', { exact: true }).selectOption('backend')
  await page.getByLabel('비자 지원', { exact: true }).selectOption('yes')
  await page.getByRole('button', { name: '내 기회 지도 만들기', exact: true }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.getByLabel('직무 필터')).toHaveValue('backend')
  await expect(page.getByLabel('비자 지원 필터')).toHaveValue('yes')
  const storage = await page.evaluate(() => Object.values(localStorage).join('\n'))
  expect(storage).not.toContain('DO_NOT_PERSIST_RAW_RESUME')
  expect(storage).not.toContain('alice-private@example.test')
  await waitForSavedCommit(page)
  await page.reload()
  await expect(page.getByLabel('직무 필터')).toHaveValue('backend')
  await expect(page.getByLabel('비자 지원 필터')).toHaveValue('yes')
  await page.getByRole('button', { name: '내 프로필 편집', exact: true }).click()
  await page.getByRole('button', { name: '저장된 프로필 삭제 · 샘플로 돌아가기' }).click()
  expect(await page.evaluate(() => localStorage.getItem('orbit.v1.profile'))).toBeNull()
  await expect(page.locator('.sample-profile-card')).toBeVisible()
  expect(uploads).toEqual([])
})

test('zooming separates city clusters, and context loss switches to a usable 2D map', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('.earth-canvas')).toHaveClass(/is-ready/)
  // This independent public topology ranks Berlin first; London belongs to
  // the seven-city European cluster instead of naming it.
  const cluster = page.getByRole('button', { name: '베를린 외 6, 추천 회사 2곳, 확대해서 도시별로 보기', exact: true })
  await expect(cluster).toHaveClass(/is-cluster/)
  await expect(page.locator('.globe-pin:not(.is-cluster)').filter({ hasText: '런던' })).toHaveCount(0)
  await cluster.click()
  await page.getByRole('button', { name: '지도 확대', exact: true }).click()
  await page.getByRole('button', { name: '지도 확대', exact: true }).click()
  const london = page.getByRole('button', { name: '런던, 추천 회사 2곳, 회사 보기', exact: true })
  await expect(london).toBeVisible()
  await expect(london).not.toHaveClass(/is-cluster/)
  await london.click()
  await expect(page.locator('.city-hero-caption h2')).toContainText('런던')
  await expect(page.locator('.mini-job-title')).toHaveText([
    'Backend Engineer — Aster Transit London', 'Frontend Engineer — Cedar Loom London',
  ])
  await page.locator('.earth-canvas canvas').dispatchEvent('webglcontextlost')
  await expect(page.locator('.flat-map svg')).toBeVisible()
  await expect(page.getByRole('button', { name: '2D 지도', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('.city-hero-caption h2')).toContainText('런던')
  await expect(page.locator('.company-card')).toHaveCount(2)
  await page.getByRole('button', { name: '모든 도시', exact: true }).click()
  await page.getByRole('button', { name: '암스테르담, 추천 회사 1곳 보기', exact: true }).click()
  await expect(page.locator('.city-hero-caption h2')).toContainText('암스테르담')
  await expect(page.locator('.mini-job-title')).toHaveText(['Backend Engineer — Aster Transit Amsterdam'])
})

async function badgeContrast(badge: Locator, brand: string, size: 'small' | 'normal') {
  await expect(badge).toBeVisible()
  await expect(badge).toHaveCSS('font-size', size === 'small' ? '10px' : '21px')
  const measured = await badge.evaluate(element => {
    const style = getComputedStyle(element)
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 1
    const context = canvas.getContext('2d', { willReadFrequently: true })!
    const rgba = (color: string) => {
      if (!CSS.supports('color', color)) throw new Error(`Unsupported badge color: ${color}`)
      context.clearRect(0, 0, 1, 1)
      context.fillStyle = color
      context.fillRect(0, 0, 1, 1)
      return [...context.getImageData(0, 0, 1, 1).data]
    }
    const effects: string[] = []
    for (let current: Element | null = element; current; current = current.parentElement) {
      const layer = getComputedStyle(current)
      if (Number(layer.opacity) !== 1 || layer.filter !== 'none' || layer.mixBlendMode !== 'normal')
        effects.push(`${current.tagName}: opacity=${layer.opacity}, filter=${layer.filter}, blend=${layer.mixBlendMode}`)
    }
    return {
      brand: style.getPropertyValue('--company-color').trim(),
      foreground: rgba(style.color), background: rgba(style.backgroundColor),
      backgroundImage: style.backgroundImage, textShadow: style.textShadow,
      textFill: style.webkitTextFillColor, color: style.color, effects,
    }
  })
  expect(measured.brand).toBe(brand)
  expect(measured.effects).toEqual([])
  expect(measured.backgroundImage).toBe('none')
  expect(measured.textShadow).toBe('none')
  expect(measured.textFill).toBe(measured.color)
  expect(measured.foreground[3]).toBe(255)
  expect(measured.background[3]).toBe(255)
  // WCAG 2 text contrast from actual rendered colors, independent of the
  // product's color-mix formula. Canvas also resolves CSS color(srgb ...) values.
  const luminance = (rgba: number[]) => rgba.slice(0, 3).map(channel => {
    const srgb = channel / 255
    return srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4
  }).reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index], 0)
  const foreground = luminance(measured.foreground), background = luminance(measured.background)
  const ratio = (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05)
  expect(ratio, `${brand} ${size} company badge text contrast`).toBeGreaterThanOrEqual(4.5)
  return { size, ratio, ...measured }
}

for (const width of [1440, 320]) {
  test(`dark and bright custom company badges meet 4.5 text contrast at small and normal sizes at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 })
    const companies = [
      { id: 'fixture-ink-rail', name: 'Ink Rail', initials: 'IR', color: '#08121f',
        industry: 'Synthetic railway employer', provider: 'greenhouse' as const, board: 'fixture-ink-rail',
        careerUrl: 'https://example.test/ink-rail/careers' },
      { id: 'fixture-sun-textile', name: 'Sun Textile', initials: 'ST', color: '#fff59d',
        industry: 'Synthetic textile employer', provider: 'greenhouse' as const, board: 'fixture-sun-textile',
        careerUrl: 'https://example.test/sun-textile/careers' },
    ]
    const data = publicProtocolCatalog({
      companies,
      jobs: companies.map(company => publicProtocolJob(company.id, {
        id: `greenhouse-${company.id}-london`, companyId: company.id,
        title: `Backend Engineer — ${company.name} London`,
      })),
    })
    await page.route('**/api/catalog?source=public*', route => route.fulfill({ json: data }))
    await page.goto('/')
    await expect(page.locator('.city-row')).toHaveCount(1)
    await expect(page.locator('.city-row .company-logo.small')).toHaveCount(2)
    await page.evaluate(async () => { await document.fonts.ready })
    const measurements = []
    for (const company of companies)
      measurements.push(await badgeContrast(page.locator(`.city-row .logo-${company.id}.small`), company.color, 'small'))
    expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([])
    await page.getByRole('button', { name: '런던, 추천 회사 2곳 보기', exact: true }).click()
    await expect(page.locator('.company-card')).toHaveCount(2)
    for (const company of companies)
      measurements.push(await badgeContrast(page.locator(`.company-card > header > .logo-${company.id}:not(.small)`), company.color, 'normal'))
    expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([])
    await testInfo.attach('company-badge-contrast', { body: JSON.stringify({ width, measurements }, null, 2), contentType: 'application/json' })
  })
}

for (const extension of ['pdf', 'docx'] as const) {
  test(`${extension.toUpperCase()} resume is read in the browser`, async ({ page }) => {
    await page.goto('/')
    await page.getByRole('button', { name: '내 프로필 편집', exact: true }).click()
    await page.getByLabel('이력서 파일 선택').setInputFiles(path.resolve(`tests/fixtures/resume.${extension}`))
    await expect(page.getByText(`resume.${extension}`, { exact: true })).toBeVisible()
    await expect(page.getByLabel('읽어온 경력 · 필요한 부분을 수정하세요')).toHaveValue(/Python/)
    await page.getByRole('button', { name: '경력에서 가능성 찾기', exact: true }).click()
    await expect(page.getByLabel('개발 경력', { exact: true })).toHaveValue('5')
    await expect(page.getByRole('button', { name: 'Python 삭제', exact: true })).toBeVisible()
    await expect(page.locator('.form-error')).toHaveCount(0)
  })
}

test('Korean PDF text and names survive extraction', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: '내 프로필 편집', exact: true }).click()
  await page.getByLabel('이력서 파일 선택').setInputFiles(path.resolve('tests/fixtures/resume-ko.pdf'))
  await expect(page.getByLabel('읽어온 경력 · 필요한 부분을 수정하세요')).toHaveValue(/김민준/)
  await page.getByRole('button', { name: '경력에서 가능성 찾기', exact: true }).click()
  await expect(page.getByLabel('이름 또는 별명')).toHaveValue('김민준')
  await expect(page.getByLabel('개발 경력', { exact: true })).toHaveValue('5')
})

test('saved opportunities preserve notes and status, export CSV and support undo', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: /^런던, 추천 회사 \d+곳 보기$/ }).click()
  await page.getByRole('button', { name: 'Backend Engineer — Aster Transit London', exact: true }).click()
  await page.getByRole('button', { name: '기회 저장', exact: true }).click()
  await page.getByLabel('이 기회에 대한 나의 메모').fill('다음 주 포트폴리오를 준비해서 지원하기')
  await page.getByRole('button', { name: '지원 완료로 표시', exact: true }).click()
  await page.getByRole('button', { name: '닫기', exact: true }).click()
  await page.getByRole('navigation', { name: '주요 메뉴' }).getByRole('button', { name: /저장한 기회/ }).click()
  await expect(page.locator('.saved-card')).toHaveCount(1)
  await expect(page.locator('.saved-note-preview')).toContainText('다음 주 포트폴리오')
  await waitForSavedCommit(page)
  await page.reload()
  await expect(page.locator('.saved-status')).toHaveText('지원 완료')
  const downloadPromise = page.waitForEvent('download')
  await page.getByRole('button', { name: 'CSV 내보내기', exact: true }).click()
  const download = await downloadPromise
  const csv = await readFile((await download.path())!, 'utf8')
  expect(csv).toContain('다음 주 포트폴리오를 준비해서 지원하기')
  expect(csv).toContain('지원 완료')
  expect(csv).toContain('Greenhouse')
  expect(csv).not.toContain('샘플')
  await page.getByRole('button', { name: 'Aster Transit 저장 취소', exact: true }).click()
  await expect(page.locator('.saved-card')).toHaveCount(0)
  await page.getByRole('button', { name: '실행 취소', exact: true }).click()
  await expect(page.locator('.saved-card')).toHaveCount(1)
  await expect(page.locator('.saved-status')).toHaveText('지원 완료')
})

test('city comparison is limited to three cities and survives navigation', async ({ page }) => {
  await page.goto('/')
  for (const city of ['런던', '베를린', '샌프란시스코']) {
    await page.getByRole('button', { name: `${city} 비교에 추가`, exact: true }).click()
  }
  await page.getByRole('button', { name: '뉴욕 비교에 추가', exact: true }).click()
  await expect(page.getByRole('status')).toContainText('최대 3개')
  await page.getByRole('navigation', { name: '주요 메뉴' }).getByRole('button', { name: /도시 비교/ }).click()
  await expect(page.locator('.comparison-city')).toHaveCount(3)
  await expect(page.locator('.comparison-city-name')).toContainText(['런던', '베를린', '샌프란시스코'])
  await waitForSavedCommit(page)
  await page.reload()
  await expect(page.locator('.comparison-city')).toHaveCount(3)
  await page.getByRole('button', { name: '런던 비교에서 제거', exact: true }).click()
  await page.getByLabel('다른 도시 추가', { exact: true }).selectOption('amsterdam')
  await expect(page.locator('.comparison-city-name')).toContainText(['베를린', '샌프란시스코', '암스테르담'])
  const accessibility = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()
  expect(accessibility.violations).toEqual([])
  await page.getByRole('button', { name: '비교 비우기', exact: true }).click()
  await expect(page.locator('.comparison-city')).toHaveCount(0)
})

test('a failed first public feed keeps unknown coverage and no fictional results', async ({ page }) => {
  await page.route('**/api/catalog?source=public*', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: '게시판 연결을 확인해 주세요.' }) }))
  await page.goto('/')
  await page.getByRole('button', { name: '공개 공고 연결 필요', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('게시판 연결을 확인해 주세요.')
  await expectPublicOnlyDialog(page)
  await expect(page.locator('.coverage-stats strong')).toHaveText(['35', '—', '—'])
  await page.getByRole('button', { name: '닫기', exact: true }).click()
  await expect(page.getByRole('button', { name: '공개 공고 연결 필요', exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: '공개 공고에 연결하지 못했어요', exact: true })).toBeVisible()
  await expect(page.locator('.city-row, .company-card, .flat-marker')).toHaveCount(0)
})

test('public conditions expose their evidence, preserve visa distinctions and survive saving', async ({ page }) => {
  const conditional = "We do sponsor visas! However, we aren't able to successfully sponsor visas for every role and every candidate."
  const policies = [
    ['conditional', conditional],
    ['yes', 'We provide visa sponsorship.'],
    ['no', 'We cannot sponsor visas for this role.'],
    ['unknown', 'Employment may depend on export authorization without sponsorship for an export license.'],
  ] as const
  const fetchedAt = '2026-09-19T03:00:00.000Z'
  await page.clock.setFixedTime(new Date(fetchedAt))
  const jobs = policies.map(([kind, policy], index) => publicProtocolJob(`policy-${index}`, {
    title: `Backend Engineer — ${kind} fixture`, fetchedAt, visa: kind,
    minExperience: 5, skills: ['Python', 'AWS'], salary: null,
    description: `5 years of software engineering experience. Python and AWS.\n${policy}`,
    evidence: {
      ...(kind === 'unknown' ? {} : { visa: { source: 'description' as const, text: policy } }),
      workMode: { source: 'board', text: 'Location Type: On-Site' },
      employment: { source: 'board', text: 'Time Type: Full time' },
    },
  }))
  const catalog = publicProtocolCatalog({ fetchedAt, jobs, companies: [PUBLIC_PROTOCOL_COMPANIES[0]] })
  await page.route('**/api/catalog?source=public*', route => route.fulfill({ json: catalog }))
  await page.goto('/')
  await page.getByRole('button', { name: '공개 채용', exact: true }).click()
  await expectPublicOnlyDialog(page)
  await expect(page.locator('.data-quality-list > div').filter({ hasText: '조건부 비자 지원' }).locator('dd')).toHaveText('1개')
  await page.getByRole('button', { name: '닫기', exact: true }).click()
  await page.getByLabel('비자 지원 필터').selectOption('supported')
  await page.getByRole('button', { name: /^런던, 추천 회사 1곳 보기$/ }).click()
  await page.getByRole('button', { name: '전체 2개 공고 보기', exact: true }).click()
  await expect(page.locator('.mini-job-title')).toHaveCount(2)
  await page.locator('.mini-job-title').filter({ hasText: 'conditional fixture' }).click()
  await expect(page.locator('.job-key-facts')).toContainText('조건부 지원 명시')
  await expect(page.locator('.job-meta-pills')).toContainText('풀타임')
  await page.locator('.job-evidence > summary').click()
  await expect(page.locator('.job-evidence blockquote').first()).toHaveText(conditional)
  await expect(page.locator('.job-evidence')).toContainText('Location Type: On-Site')
  const accessibility = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()
  expect(accessibility.violations).toEqual([])
  await page.getByRole('button', { name: '기회 저장', exact: true }).click()
  await page.getByRole('button', { name: '닫기', exact: true }).click()
  await page.getByLabel('비자 지원 필터').selectOption('yes')
  await expect(page.locator('.mini-job-title')).toHaveCount(1)
  await expect(page.locator('.mini-job-title')).toContainText('yes fixture')
  await page.getByLabel('비자 지원 필터').selectOption('possible')
  await expect(page.locator('.mini-job-title')).toHaveCount(3)
  await page.getByRole('navigation', { name: '주요 메뉴' }).getByRole('button', { name: /저장한 기회/ }).click()
  await waitForSavedCommit(page)
  await page.reload()
  await page.locator('.saved-title').click()
  await expect(page.locator('.job-key-facts')).toContainText('조건부 지원 명시')
  await page.locator('.job-evidence > summary').click()
  await expect(page.locator('.job-evidence blockquote').first()).toHaveText(conditional)
})

test('explore and profile forms pass WCAG A/AA checks and keyboard focus returns', async ({ page }) => {
  await page.goto('/')
  const explore = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()
  expect(explore.violations).toEqual([])
  const trigger = page.getByRole('button', { name: '내 프로필 편집', exact: true })
  await trigger.click()
  const profile = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()
  expect(profile.violations).toEqual([])
  await page.keyboard.press('Escape')
  await expect(trigger).toBeFocused()
  await page.keyboard.press('Meta+k')
  await expect(page.getByLabel('도시, 회사 또는 포지션 검색')).toBeFocused()
  await page.getByRole('button', { name: /^런던, 추천 회사 \d+곳 보기$/ }).click()
  await page.locator('.mini-job-title').first().click()
  const disclosure = page.locator('.original-description > summary')
  await disclosure.focus()
  await page.keyboard.press('Enter')
  const original = page.getByRole('region', { name: '채용공고 원문', exact: true })
  await expect(original).toBeVisible()
  await expect(original).toHaveAttribute('tabindex', '0')
  await page.keyboard.press('Tab')
  await expect(original).toBeFocused()
  await expect(original).toContainText('Synthetic engineering protocol fixture.')
  const job = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()
  expect(job.violations).toEqual([])
})

test.describe('mobile', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
  test('touch-sized layout connects the globe to the city list without horizontal overflow', async ({ page }) => {
    await page.goto('/')
    await expect(page.locator('.earth-canvas')).toHaveClass(/is-ready/)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.getByRole('button', { name: '도시 목록 보기', exact: true }).click()
    await expect(page.getByRole('button', { name: /^런던, 추천 회사 \d+곳 보기$/ })).toBeInViewport()
    await page.getByRole('button', { name: /^런던, 추천 회사 \d+곳 보기$/ }).click()
    await expect(page.locator('.city-hero-caption h2')).toBeInViewport()
    await page.locator('.mini-job-title').first().click()
    await expect(page.getByRole('dialog')).toBeVisible()
    const disclosure = page.locator('.original-description > summary')
    await disclosure.focus()
    await page.keyboard.press('Enter')
    await page.keyboard.press('Tab')
    await expect(page.getByRole('region', { name: '채용공고 원문', exact: true })).toBeFocused()
    const bounds = await page.getByRole('dialog').boundingBox()
    expect(bounds!.width).toBeLessThanOrEqual(390)
    await page.getByRole('button', { name: '기회 저장', exact: true }).click()
    await expect(page.getByRole('button', { name: '저장됨', exact: true })).toBeVisible()
  })
})
