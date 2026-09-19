import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { normalizeJob } from '../../server/normalize'
import { createSampleCatalog } from '../../shared/sample'
import { DEFAULT_FILTERS } from '../../shared/types'

const demo = createSampleCatalog()
const fetchedAt = '2026-09-19T06:00:00.000Z'
const publicCatalog = {
  ...demo, source: 'greenhouse', fetchedAt,
  companies: demo.companies.filter(company => company.id === 'stripe'),
  jobs: ['London, UK', 'Berlin, Germany'].map((location, index) => normalizeJob({
    id: 800 + index, title: `Backend Engineer — restore fixture ${index}`,
    absolute_url: `https://example.com/jobs/restore-${index}`, location: { name: location },
    content: '<p>3 years of software engineering experience. Python and AWS.</p><p>We provide visa sponsorship.</p>',
    metadata: [{ name: 'Location Type', value: 'Hybrid' }, { name: 'Time Type', value: 'Full time' }],
    pay_input_ranges: [{ min_cents: 15000000, max_cents: 18000000, currency_type: 'USD' }],
  }, 'stripe', fetchedAt)!),
  boards: [{ companyId: 'stripe', board: 'stripe', status: 'ok', total: 2, included: 2 }],
}

async function choosePublic(page: Page) {
  await page.getByRole('button', { name: '샘플 탐색', exact: true }).click()
  await page.getByRole('button', { name: /공개 채용공고/ }).click()
  await expect(page.getByRole('button', { name: '공개 채용', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '닫기', exact: true }).click()
}

test('public data, every search condition, city selection and map preferences survive reload and a new visit', async ({ page, context }) => {
  await context.route('**/api/catalog?source=greenhouse*', route => route.fulfill({ json: publicCatalog }))
  await page.goto('/')
  await choosePublic(page)
  await page.getByRole('button', { name: '주간 지구로 전환', exact: true }).click()
  await page.getByRole('button', { name: '2D 지도', exact: true }).click()
  await page.getByRole('button', { name: '유럽', exact: true }).click()
  await page.getByRole('combobox', { name: '도시 정렬', exact: true }).selectOption('salary')
  await page.getByRole('button', { name: /^모든 필터/ }).click()
  await page.getByLabel('직무', { exact: true }).selectOption('backend')
  await page.getByRole('button', { name: '하이브리드', exact: true }).click()
  await page.getByLabel('비자 지원', { exact: true }).selectOption('supported')
  await page.getByLabel('고용 형태', { exact: true }).selectOption('fulltime')
  await page.getByLabel('희망 연봉').press('Home')
  for (let step = 0; step < 12; step++) await page.getByLabel('희망 연봉').press('ArrowRight')
  await page.getByRole('checkbox', { name: /연봉 미공개 공고도 포함/ }).uncheck()
  await page.getByRole('checkbox', { name: /거주 국가에서 가능한 원격근무만/ }).uncheck()
  await page.getByRole('button', { name: /개 공고 보기$/ }).click()
  await page.getByLabel('도시, 회사 또는 포지션 검색').fill('런던 Stripe')
  await page.getByRole('button', { name: '런던, 추천 회사 1곳 보기', exact: true }).click()

  await page.reload()
  await expect(page.getByRole('button', { name: '공개 채용', exact: true })).toBeVisible()
  await expect(page.getByLabel('도시, 회사 또는 포지션 검색')).toHaveValue('런던 Stripe')
  await expect(page.getByLabel('직무 필터')).toHaveValue('backend')
  await expect(page.getByLabel('근무 형태 필터')).toHaveValue('hybrid')
  await expect(page.getByLabel('비자 지원 필터')).toHaveValue('supported')
  await expect(page.getByRole('button', { name: '유럽', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByRole('button', { name: '2D 지도', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('.flat-map svg')).toBeVisible()
  await expect(page.locator('.city-hero-caption h2')).toContainText('런던')
  await expect(page.locator('.mini-job-title')).toContainText('restore fixture 0')
  await page.getByRole('button', { name: /^모든 필터/ }).click()
  await expect(page.getByLabel('고용 형태', { exact: true })).toHaveValue('fulltime')
  await expect(page.getByLabel('희망 연봉')).toHaveValue('120000')
  await expect(page.getByRole('checkbox', { name: /연봉 미공개 공고도 포함/ })).not.toBeChecked()
  await expect(page.getByRole('checkbox', { name: /거주 국가에서 가능한 원격근무만/ })).not.toBeChecked()
  await page.getByRole('button', { name: '닫기', exact: true }).click()

  const revisit = await context.newPage()
  await revisit.goto('/')
  await expect(revisit.getByRole('button', { name: '공개 채용', exact: true })).toBeVisible()
  await expect(revisit.locator('.city-hero-caption h2')).toContainText('런던')
  await expect(revisit.getByLabel('도시, 회사 또는 포지션 검색')).toHaveValue('런던 Stripe')
  await revisit.getByRole('button', { name: '모든 도시', exact: true }).click()
  await expect(revisit.getByRole('combobox', { name: '도시 정렬', exact: true })).toHaveValue('salary')
  await revisit.getByRole('button', { name: '3D 지구', exact: true }).click()
  await expect(revisit.getByRole('button', { name: '야간 지구로 전환', exact: true })).toBeVisible()
  expect(new URL(revisit.url()).search).toBe('')
  await revisit.close()
})

test('a failed restored feed keeps public mode and search context, distinguishes missing data, and can retry', async ({ page }) => {
  let available = false
  let empty = false
  await page.route('**/api/catalog?source=greenhouse*', route => available
    ? route.fulfill({ json: { ...publicCatalog, jobs: empty ? [] : publicCatalog.jobs } })
    : route.fulfill({ status: 503, json: { error: '게시판 연결을 확인해 주세요.' } }))
  await page.addInitScript(() => localStorage.setItem('orbit.v1.exploration', JSON.stringify({
    source: 'greenhouse', filters: { query: '런던' }, selectedId: 'london', mapMode: 'flat',
  })))
  await page.goto('/')
  await expect(page.getByRole('heading', { name: '공개 공고에 연결하지 못했어요' })).toBeVisible()
  await expect(page.getByLabel('도시, 회사 또는 포지션 검색')).toHaveValue('런던')
  await expect(page.locator('.map-stats strong')).toContainText(['—', '—'])
  await expect(page.locator('.city-row, .company-card')).toHaveCount(0)
  await expect(page.getByRole('heading', { name: '조건에 맞는 도시가 아직 없어요' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: '샘플 탐색', exact: true })).toHaveCount(0)
  await expect(page.locator('.toast')).toHaveCount(0)
  expect(JSON.parse(await page.evaluate(() => localStorage.getItem('orbit.v1.exploration')) || '{}').source).toBe('greenhouse')
  const accessibility = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()
  expect(accessibility.violations).toEqual([])

  await page.getByRole('button', { name: '다시 조회', exact: true }).click()
  await expect(page.getByRole('heading', { name: '공개 공고에 연결하지 못했어요' })).toBeVisible()
  await expect(page.locator('.toast')).toHaveCount(0)
  available = true
  await page.getByRole('button', { name: '다시 조회', exact: true }).click()
  await expect(page.getByRole('button', { name: '공개 채용', exact: true })).toBeVisible()
  await expect(page.locator('.city-hero-caption h2')).toContainText('런던')
  await expect(page.locator('.mini-job-title')).toContainText('restore fixture 0')
  empty = true
  await page.getByRole('button', { name: '공개 채용', exact: true }).click()
  await page.getByRole('button', { name: '새로고침', exact: true }).click()
  await expect(page.locator('.coverage-stats strong').last()).toHaveText('0')
  await page.getByRole('button', { name: '닫기', exact: true }).click()
  await expect(page.getByRole('heading', { name: '이 도시에서 맞는 공고를 찾지 못했어요' })).toBeVisible()
  await expect(page.locator('.map-stats strong').first()).toContainText('0')
})

test('restored loading state shows no sample jobs and switching to sample cancels the pending response', async ({ page, context }) => {
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  await context.route('**/api/catalog?source=greenhouse*', async route => {
    await gate
    await route.fulfill({ json: publicCatalog })
  })
  await page.addInitScript(() => localStorage.setItem('orbit.v1.exploration', JSON.stringify({ source: 'greenhouse', mapMode: 'flat' })))
  try {
    await page.goto('/')
    await expect(page.getByRole('heading', { name: '공개 공고를 불러오고 있어요' })).toBeVisible()
    await expect(page.locator('.city-row, .company-card')).toHaveCount(0)
    await expect(page.locator('.map-stats strong')).toContainText(['—', '—'])
    await page.getByRole('button', { name: '공개 공고 조회 중', exact: true }).click()
    await expect(page.locator('.coverage-stats strong').last()).toHaveText('—')
    await expect(page.getByRole('dialog')).not.toContainText('Invalid Date')
    await page.getByRole('button', { name: /샘플로 탐색/ }).click()
    await expect(page.getByRole('button', { name: '샘플 탐색', exact: true })).toBeVisible()
    await page.getByRole('button', { name: '닫기', exact: true }).click()
    release()
    await page.waitForLoadState('networkidle')
    await expect(page.locator('.city-row')).toHaveCount(22)
    await expect(page.getByRole('button', { name: '샘플 탐색', exact: true })).toBeVisible()
    const revisit = await context.newPage()
    await revisit.goto('/')
    await expect(revisit.getByRole('button', { name: '샘플 탐색', exact: true })).toBeVisible()
    await revisit.close()
  } finally { release() }
})

test('opting out removes previously remembered conditions and keeps that choice when reopening the profile', async ({ page }) => {
  const profileText = 'Profile Fixture\\nBackend Engineer\\n5 years of software engineering with Python, TypeScript and AWS.\\nPRIVATE_RESUME_ORIGINAL'
  await page.goto('/')
  await page.getByRole('button', { name: '내 프로필 편집', exact: true }).click()
  await page.getByRole('button', { name: '텍스트', exact: true }).click()
  await page.getByLabel('경력 요약', { exact: true }).fill(profileText)
  await page.getByRole('button', { name: '경력에서 가능성 찾기', exact: true }).click()
  await page.getByLabel('희망 직무', { exact: true }).selectOption('backend')
  await page.getByLabel('비자 지원', { exact: true }).selectOption('supported')
  await page.getByRole('button', { name: '내 기회 지도 만들기', exact: true }).click()
  await page.getByLabel('도시, 회사 또는 포지션 검색').fill('remembered-query')
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('orbit.v1.exploration') || '{}').filters?.query)).toBe('remembered-query')

  await page.getByRole('button', { name: '내 프로필 편집', exact: true }).click()
  await page.getByLabel('이름 또는 별명').fill('Private Profile')
  await page.getByLabel('희망 직무', { exact: true }).selectOption('frontend')
  await page.getByRole('checkbox', { name: /이 브라우저에 프로필 기억하기/ }).uncheck()
  await page.getByRole('button', { name: '내 기회 지도 만들기', exact: true }).click()
  await page.getByLabel('도시, 회사 또는 포지션 검색').fill('private-query-do-not-remember')
  await page.getByRole('button', { name: '2D 지도', exact: true }).click()
  await page.getByRole('button', { name: '내 프로필 편집', exact: true }).click()
  await expect(page.getByRole('checkbox', { name: /이 브라우저에 프로필 기억하기/ })).not.toBeChecked()
  await page.getByRole('button', { name: '닫기', exact: true }).click()
  const state = await page.evaluate(() => ({
    profile: localStorage.getItem('orbit.v1.profile'),
    exploration: JSON.parse(localStorage.getItem('orbit.v1.exploration') || '{}'),
    serialized: Object.values(localStorage).join('\n') + Object.values(sessionStorage).join('\n'),
  }))
  expect(state.profile).toBeNull()
  expect(state.exploration.filters).toEqual(DEFAULT_FILTERS)
  for (const privateText of ['Private Profile', 'private-query-do-not-remember', 'remembered-query', 'PRIVATE_RESUME_ORIGINAL']) expect(state.serialized).not.toContain(privateText)
  await page.reload()
  await expect(page.locator('.sample-profile-card')).toBeVisible()
  await expect(page.getByLabel('도시, 회사 또는 포지션 검색')).toHaveValue('')
  await expect(page.getByLabel('직무 필터')).toHaveValue('all')
  await expect(page.getByLabel('비자 지원 필터')).toHaveValue('all')
  await expect(page.getByRole('button', { name: '2D 지도', exact: true })).toHaveAttribute('aria-pressed', 'true')
})

test('browsers that deny local storage can still filter and explore', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.addInitScript(() => Object.defineProperty(window, 'localStorage', {
    configurable: true,
    get() { throw new DOMException('Storage is blocked', 'SecurityError') },
  }))
  await page.goto('/')
  await page.getByRole('button', { name: '2D 지도', exact: true }).click()
  await page.getByLabel('도시, 회사 또는 포지션 검색').fill('런던')
  await expect(page.locator('.city-row')).toHaveCount(1)
  await page.getByRole('button', { name: /^런던, 추천 회사 \d+곳 보기$/ }).click()
  await expect(page.locator('.company-card').first()).toBeVisible()
  await expect(page.locator('.flat-map svg')).toBeVisible()
  expect(errors).toEqual([])
})
