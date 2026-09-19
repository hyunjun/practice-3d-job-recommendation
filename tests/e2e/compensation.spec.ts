import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { readFile } from 'node:fs/promises'
import { normalizeJob } from '../../server/normalize'
import { PUBLIC_COMPANIES } from '../../shared/companies'
import { CITIES } from '../../shared/cities'
import type { Catalog, Job, SavedJob } from '../../shared/types'

const company = PUBLIC_COMPANIES.find(item => item.id === 'stripe')!
const fetchedAt = '2026-09-19T07:00:00.000Z'
const regionalText = 'For United Kingdom based hires: Annual base salary GBP 90,000–120,000.\nFor United States based hires: Annual base salary USD 140,000–180,000.'
const jobs = [
  { title: 'regional pay fixture', content: regionalText },
  { title: 'comparable annual fixture', content: 'Annual base salary: USD 180,000–220,000.' },
  { title: 'hourly pay fixture', content: 'Hourly base pay: USD 55–65.' },
].map((fixture, index) => normalizeJob({
  id: 5600 + index, title: `Backend Engineer — ${fixture.title}`,
  absolute_url: `https://example.com/jobs/compensation-${index}`, location: { name: 'London, UK' },
  content: `<p>5 years of software engineering with Python and AWS.</p><p>${fixture.content}</p>`,
  metadata: [{ name: 'Workplace Type', value: 'Hybrid' }],
}, company.id, fetchedAt)!)
const catalog: Catalog = {
  source: 'public', jobs, companies: [company], cities: CITIES, fetchedAt, stale: false, unmappedCount: 0,
  boards: [{ companyId: company.id, provider: 'greenhouse', board: company.board!, status: 'ok', dataStatus: 'fresh', included: 3, total: 3 }],
}

async function restore(page: Page, saved: SavedJob[] = []) {
  await page.route('**/api/catalog?source=public*', route => route.fulfill({ json: catalog }))
  await page.addInitScript(saved => {
    if (!localStorage.getItem('orbit.v1.exploration')) localStorage.setItem('orbit.v1.exploration', JSON.stringify({
      source: 'public', mapMode: 'flat', selectedId: 'london',
    }))
    if (!localStorage.getItem('orbit.v1.compare')) localStorage.setItem('orbit.v1.compare', JSON.stringify(['london']))
    if (!localStorage.getItem('orbit.v1.saved')) localStorage.setItem('orbit.v1.saved', JSON.stringify(saved))
  }, saved)
  await page.goto('/')
  await expect(page.getByRole('button', { name: '공개 채용', exact: true })).toBeVisible()
}

test('regional pay, original evidence and notes survive saving and CSV while only comparable salary enters statistics', async ({ page }) => {
  await restore(page)
  await page.getByRole('button', { name: '공개 채용', exact: true }).click()
  await expect(page.locator('.data-quality-list > div').filter({ hasText: '비교 가능한 연봉' }).locator('dd')).toHaveText('1 / 3개')
  await expect(page.locator('.data-quality-list > div').filter({ hasText: '보상 조건 확인 필요' }).locator('dd')).toHaveText('2개')
  await page.getByRole('button', { name: '닫기', exact: true }).click()
  await page.getByLabel('도시, 회사 또는 포지션 검색').fill('regional pay fixture')
  await page.locator('.mini-job-title').click()
  await expect(page.locator('.job-key-facts')).toContainText('별도 보상 조건')
  await expect(page.locator('.job-compensation dd > span')).toHaveText(['GBP 90,000–120,000 / 년', 'USD 140,000–180,000 / 년'])
  await page.locator('.compensation-evidence > summary').first().click()
  await expect(page.locator('.compensation-evidence blockquote').first()).toHaveText(regionalText.split('\n')[0])
  await page.getByRole('button', { name: '기회 저장', exact: true }).click()
  await page.getByLabel('이 기회에 대한 나의 메모').fill('내 지원 지역의 보상 구간 확인')
  await page.getByRole('button', { name: '지원 완료로 표시', exact: true }).click()
  await page.getByRole('button', { name: '닫기', exact: true }).click()
  await page.getByLabel('도시, 회사 또는 포지션 검색').fill('')
  await page.getByRole('navigation', { name: '주요 메뉴' }).getByRole('button', { name: /도시 비교/ }).click()
  const salary = page.getByRole('row').filter({ hasText: '공개 연봉의 중앙값' })
  await expect(salary).toContainText('$200k')
  await expect(salary).toContainText('연봉 공개 1개 공고 기준')
  await page.getByRole('navigation', { name: '주요 메뉴' }).getByRole('button', { name: /저장한 기회/ }).click()
  await page.reload()
  await expect(page.locator('.saved-note-preview')).toHaveText('내 지원 지역의 보상 구간 확인')
  await expect(page.locator('.saved-status')).toHaveText('지원 완료')
  await page.locator('.saved-title').click()
  await page.locator('.compensation-evidence > summary').last().click()
  await expect(page.locator('.compensation-evidence blockquote').last()).toHaveText(regionalText.split('\n')[1])
  await page.getByRole('button', { name: '닫기', exact: true }).click()
  const downloadPromise = page.waitForEvent('download')
  await page.getByRole('button', { name: 'CSV 내보내기', exact: true }).click()
  const csv = await readFile((await (await downloadPromise).path())!, 'utf8')
  for (const value of ['보상 근거', 'Greenhouse', 'GBP 90,000–120,000 / 년', regionalText.split('\n')[1], '내 지원 지역의 보상 구간 확인']) expect(csv).toContain(value)
})

test('existing saved regional pay is rechecked without losing status or notes, and unsupported old amounts remain labeled records', async ({ page }) => {
  const { compensationRanges: _ranges, compensationNote: _note, compensationVersion: _version, ...original } = jobs[0]
  const legacyJob: Job = { ...original, salary: { min: 90000, max: 120000, currency: 'GBP' } }
  const saved: SavedJob[] = [
    { job: legacyJob, company, savedAt: fetchedAt, status: 'applied', note: 'Keep this application note' },
    { job: { ...legacyJob, id: 'greenhouse-stripe-legacy-unknown', title: 'Old saved amount fixture', description: 'This old excerpt has no compensation information.' }, company, savedAt: fetchedAt, status: 'saved', note: 'Keep the original saved amount' },
  ]
  await restore(page, saved)
  await page.getByRole('navigation', { name: '주요 메뉴' }).getByRole('button', { name: /저장한 기회/ }).click()
  await expect(page.locator('.saved-card')).toHaveCount(2)
  await page.locator('.saved-title').filter({ hasText: 'regional pay fixture' }).click()
  await expect(page.locator('.job-key-facts')).toContainText('별도 보상 조건')
  await expect(page.locator('.job-compensation dd > span')).toHaveCount(2)
  await expect(page.getByLabel('이 기회에 대한 나의 메모')).toHaveValue('Keep this application note')
  await expect(page.getByRole('button', { name: '지원 완료로 표시됨', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '닫기', exact: true }).click()
  await page.locator('.saved-title').filter({ hasText: 'Old saved amount fixture' }).click()
  await expect(page.locator('.job-key-facts')).toContainText('£90–120k · 이전 기록')
  await expect(page.locator('.job-compensation')).toContainText('이전 형식으로 저장된 금액')
  await expect(page.locator('.job-key-facts')).not.toContainText('USD / 년')
  await page.getByRole('button', { name: '닫기', exact: true }).click()
  await page.reload()
  const persisted = JSON.parse(await page.evaluate(() => localStorage.getItem('orbit.v1.saved')) || '[]')
  expect(persisted[0]).toMatchObject({ savedAt: fetchedAt, status: 'applied', note: 'Keep this application note', job: { salary: null, compensationVersion: 1, fetchedAt } })
  expect(persisted[1].job.salary).toEqual(legacyJob.salary)
})

test.describe('mobile pay disclosure', () => {
  test.use({ viewport: { width: 320, height: 780 }, isMobile: true, hasTouch: true })
  test('hourly amounts and expanded original evidence remain readable and accessible', async ({ page }) => {
    await restore(page)
    await page.getByLabel('도시, 회사 또는 포지션 검색').fill('hourly pay fixture')
    await page.locator('.mini-job-title').click()
    await expect(page.locator('.job-compensation dd > span')).toHaveText('USD 55–65 / 시간')
    await expect(page.locator('.job-key-facts')).toContainText('보상 정보')
    await page.locator('.compensation-evidence > summary').click()
    await expect(page.locator('.compensation-evidence blockquote')).toHaveText('Hourly base pay: USD 55–65.')
    expect(await page.locator('.dialog').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
    expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([])
  })
})
