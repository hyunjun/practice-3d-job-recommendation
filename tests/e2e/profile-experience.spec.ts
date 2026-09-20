import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { DEFAULT_FILTERS } from '../../shared/types'
import { normalizeJob } from '../../server/normalize'
import { searchCatalog, SEARCH_TIME } from '../fixtures/search-catalog'
import { readSaved, waitForSavedCommit } from './helpers/saved-store'

const resume = 'Alex Example\nSoftware Engineer\nTypeScript로 결제 서비스와 개발 도구를 만들었습니다.\nPRIVATE_EXPERIENCE_RESUME_28'
const jobs = [2, 5].map(years => normalizeJob({
  id: 2800 + years, title: `Backend Software Engineer — ${years} years`,
  absolute_url: `https://example.com/jobs/experience-${years}`, location: { name: 'London, UK' },
  content: `<h2>Qualifications</h2><p>${years} years of software engineering experience.</p><p>Experience using TypeScript.</p>`,
}, 'search-fixture-a', SEARCH_TIME)!)
const catalog = searchCatalog(jobs)

async function setup(page: Page) {
  await page.clock.setFixedTime(new Date(SEARCH_TIME))
  await page.route('**/api/catalog?source=public*', route => route.fulfill({ json: catalog }))
  await page.addInitScript(filters => {
    if (!localStorage.getItem('orbit.v1.exploration')) localStorage.setItem('orbit.v1.exploration', JSON.stringify({
      source: 'public', mapMode: 'flat', selectedId: 'london', panelTab: 'cities', filters,
    }))
  }, DEFAULT_FILTERS)
  await page.goto('/')
  await expect(page.getByRole('button', { name: '공개 채용', exact: true })).toBeVisible()
}

async function importResume(page: Page, text: string) {
  await page.getByLabel('이력서 파일 선택').setInputFiles({
    name: 'experience.txt', mimeType: 'text/plain', buffer: Buffer.from(text),
  })
  await expect(page.getByLabel('읽어온 경력 · 필요한 부분을 수정하세요')).toHaveValue(text)
  await page.getByRole('button', { name: '경력에서 가능성 찾기', exact: true }).click()
}

async function storedYears(page: Page) {
  return page.evaluate(() => JSON.parse(localStorage.getItem('orbit.v1.profile') || '{}').years)
}

async function changeYears(page: Page, years: string) {
  await page.getByRole('button', { name: '내 프로필 편집', exact: true }).click()
  const field = page.getByLabel('개발 경력', { exact: true })
  await field.fill(years)
  await expect(field).toHaveValue(years)
  await page.getByRole('button', { name: '변경 사항 적용', exact: true }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
}

for (const width of [1440, 320]) {
  test.describe(`personal experience at ${width}px`, () => {
    test.use({ viewport: { width, height: 960 } })
    test('missing, fractional and zero years remain distinct through matching, saved notes and a new visit', async ({ page }) => {
      const errors: string[] = []
      const requests: { url: string; method: string; body: string | null }[] = []
      page.on('pageerror', error => errors.push(error.message))
      page.on('request', request => {
        if (new URL(request.url()).pathname.startsWith('/api/')) requests.push({ url: request.url(), method: request.method(), body: request.postData() })
      })
      await setup(page)
      await page.getByRole('button', { name: '내 프로필 편집', exact: true }).click()
      await importResume(page, resume)
      const field = page.getByLabel('개발 경력', { exact: true })
      await expect(field).toHaveValue('')
      await expect(page.locator('#profile-years-help')).toContainText('비워 두면 경력 조건은 비교하지 않아요')
      expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze()).violations).toEqual([])
      await page.getByRole('button', { name: '내 기회 지도 만들기', exact: true }).click()
      await expect.poll(() => storedYears(page)).toBeNull()
      await page.getByRole('button', { name: /^런던, 추천 회사 \d+곳 보기$/ }).click()
      await page.getByRole('button', { name: '전체 2개 공고 보기', exact: true }).click()
      await expect(page.locator('.mini-job-title')).toHaveCount(2)
      await expect(page.locator('.map-stats strong')).toHaveText(['1곳', '1곳'])
      await page.getByRole('button', { name: jobs[1].title, exact: true }).click()
      await expect(page.getByRole('dialog')).toContainText('내 경력 연수가 미입력이라 공고의 경력 조건과 비교하지 않았어요')
      await expect(page.getByRole('dialog')).not.toContainText('현재 입력한 경력보다')
      await expect(page.getByRole('dialog')).not.toContainText('입력 경력 3년')
      await page.getByRole('button', { name: '기회 저장', exact: true }).click()
      await page.getByLabel('이 기회에 대한 나의 메모').fill('Private experience note')
      await page.getByRole('button', { name: '지원 완료로 표시', exact: true }).click()
      await page.getByRole('button', { name: '닫기', exact: true }).click()
      await waitForSavedCommit(page)
      const saved = await readSaved(page)
      const beforeEditing = requests.length
      await changeYears(page, '3.5')
      await expect.poll(() => storedYears(page)).toBe(3.5)
      expect(requests).toHaveLength(beforeEditing)
      await page.reload()
      await expect(page.getByRole('button', { name: '공개 채용', exact: true })).toBeVisible()
      await page.getByRole('button', { name: '내 프로필 편집', exact: true }).click()
      await expect(field).toHaveValue('3.5')
      await page.getByRole('button', { name: '닫기', exact: true }).click()
      await page.getByRole('navigation', { name: '주요 메뉴' }).getByRole('button', { name: /저장한 기회/ }).click()
      await page.getByRole('button', { name: jobs[1].title, exact: true }).click()
      await expect(page.getByRole('dialog')).toContainText('요구 경력 5년 · 현재 입력한 경력보다 18개월 많아요')
      await expect(page.getByLabel('이 기회에 대한 나의 메모')).toHaveValue('Private experience note')
      await expect(page.getByRole('button', { name: '지원 완료로 표시됨', exact: true })).toBeVisible()
      await page.getByRole('button', { name: '닫기', exact: true }).click()
      await changeYears(page, '')
      await expect.poll(() => storedYears(page)).toBeNull()
      await expect(page.getByRole('navigation', { name: '주요 메뉴' }).getByRole('button', { name: /저장한 기회/ })).toHaveAttribute('aria-current', 'page')
      await page.reload()
      await expect(page.locator('.saved-card')).toHaveCount(1)
      await page.getByRole('button', { name: '내 프로필 편집', exact: true }).click()
      await expect(field).toHaveValue('')
      await page.getByRole('button', { name: '닫기', exact: true }).click()
      await page.getByRole('button', { name: jobs[1].title, exact: true }).click()
      await expect(page.getByRole('dialog')).toContainText('내 경력 연수가 미입력')
      await page.getByRole('button', { name: '닫기', exact: true }).click()
      await changeYears(page, '0')
      await expect.poll(() => storedYears(page)).toBe(0)
      await expect(page.getByRole('navigation', { name: '주요 메뉴' }).getByRole('button', { name: /저장한 기회/ })).toHaveAttribute('aria-current', 'page')
      await page.getByRole('button', { name: jobs[1].title, exact: true }).click()
      await expect(page.getByRole('dialog')).toContainText('요구 경력 5년 · 현재 입력한 경력보다 5년 많아요')
      await expect(page.getByRole('dialog')).not.toContainText('내 경력 연수가 미입력')
      await expect(page.getByLabel('이 기회에 대한 나의 메모')).toHaveValue('Private experience note')
      expect(await readSaved(page)).toEqual(saved)
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze()).violations).toEqual([])
      expect(await page.evaluate(() => Object.values(localStorage).join(' '))).not.toContain('PRIVATE_EXPERIENCE_RESUME_28')
      for (const request of requests) {
        expect(new URL(request.url).pathname).toBe('/api/catalog')
        expect([...new URL(request.url).searchParams]).toEqual([['source', 'public']])
        expect(request.method).toBe('GET')
        expect(request.body).toBeNull()
      }
      expect(errors).toEqual([])
    })
  })
}

test('fractional imports stay editable and invalid years are explained without silently rounding or clamping', async ({ page }) => {
  await setup(page)
  await page.getByRole('button', { name: '내 프로필 편집', exact: true }).click()
  const field = page.getByLabel('개발 경력', { exact: true })
  for (const [text, years] of [
    ['0.5 years of experience', '0.5'], ['총 경력 2년 6개월', '2.5'],
    ['Total experience: 7 years; Python: 3 years of experience', '7'],
    ['Total experience: 3–5 years; Python: 2 years of experience', ''],
    ['3.5 years of experience', '3.5'],
  ]) {
    await importResume(page, `${resume}\n${text}`)
    await expect(field).toHaveValue(years)
    if (years !== '3.5') await page.getByRole('button', { name: '다시 입력', exact: true }).click()
  }
  for (const invalid of ['-1', '51']) {
    await field.fill(invalid)
    await page.getByRole('button', { name: '내 기회 지도 만들기', exact: true }).click()
    await expect(field).toHaveValue(invalid)
    await expect(field).toBeFocused()
    await expect(field).toHaveAttribute('aria-invalid', 'true')
    await expect(page.getByRole('alert')).toContainText('0~50년 사이의 숫자')
    expect(await page.evaluate(() => localStorage.getItem('orbit.v1.profile'))).toBeNull()
  }
  expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze()).violations).toEqual([])
  await field.fill('3.5')
  await expect(page.locator('#profile-years-error')).toHaveCount(0)
  await page.getByRole('button', { name: '내 기회 지도 만들기', exact: true }).click()
  await expect.poll(() => storedYears(page)).toBe(3.5)
})
