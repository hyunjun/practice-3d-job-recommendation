import { readSavedJson, waitForSavedCommit } from './helpers/saved-store'
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { readFile } from 'node:fs/promises'
import { normalizeJob } from '../../server/normalize'
import { PUBLIC_COMPANIES } from '../../shared/companies'
import { CITIES } from '../../shared/cities'
import type { Catalog, SavedJob } from '../../shared/types'

const company = PUBLIC_COMPANIES.find(item => item.id === 'stripe')!
const figma = PUBLIC_COMPANIES.find(item => item.id === 'figma')!
const fetchedAt = '2026-09-19T07:00:00.000Z'
test.beforeEach(async ({ page }) => { await page.clock.setFixedTime(new Date(fetchedAt)) })
const text = [
  'Minimum requirements', '3 years of software engineering experience.', 'Experience with Python and AWS.',
  'Preferred qualifications', '8 years of software engineering experience.', 'Experience with Rust.',
  'Our tech', 'We use Kubernetes and Terraform.',
].join('\n')
const jobs = [
  { company: company.id, title: 'priority core fixture', body: text },
  { company: company.id, title: 'optional overlap fixture', body: 'Minimum requirements\n3 years of software engineering experience.\nExperience with Java and SQL.\nNice to have\nExperience with Python and AWS.' },
  { company: company.id, title: 'language choice fixture', body: 'Minimum requirements\n3 years of software engineering experience.\nExperience with Python or Rust.' },
  { company: figma.id, title: 'company intro fixture', body: 'About Figma\nFigma helps people design together. Our services are written in Python and AWS.\nWhat we offer\nFigma offers an annual bonus and learning benefits.' },
].map((fixture, index) => normalizeJob({
  id: 6600 + index, title: `Backend Engineer — ${fixture.title}`, location: { name: 'London, UK' },
  absolute_url: `https://example.com/jobs/qualifications-${index}`,
  metadata: [{ name: 'Workplace Type', value: 'Hybrid' }],
  content: fixture.body.split('\n').map(line => `<p>${line}</p>`).join(''),
}, fixture.company, fetchedAt)!)
const catalog: Catalog = {
  source: 'public', jobs, companies: [company, figma], cities: CITIES, fetchedAt, stale: false, unmappedCount: 0,
  boards: [company, figma].map(item => ({
    companyId: item.id, provider: 'greenhouse', board: item.board!, status: 'ok', dataStatus: 'fresh',
    included: jobs.filter(job => job.companyId === item.id).length, total: jobs.filter(job => job.companyId === item.id).length,
  })),
}

async function restore(page: Page, saved: SavedJob[] = []) {
  await page.route('**/api/catalog?source=public*', route => route.fulfill({ json: catalog }))
  await page.addInitScript(saved => {
    if (!localStorage.getItem('orbit.v1.exploration')) localStorage.setItem('orbit.v1.exploration', JSON.stringify({
      source: 'public', mapMode: 'flat', selectedId: 'london',
    }))
    if (!localStorage.getItem('orbit.v1.saved')) localStorage.setItem('orbit.v1.saved', JSON.stringify(saved))
  }, saved)
  await page.goto('/')
  await expect(page.getByRole('button', { name: '공개 채용', exact: true })).toBeVisible()
}

test('core qualifications rank ahead of optional overlaps and their evidence survives saving and CSV', async ({ page }) => {
  await restore(page)
  await expect(page.locator('.mini-job-title').first()).toContainText('priority core fixture')
  const intro = page.locator('.company-card').filter({ hasText: 'company intro fixture' })
  await expect(intro.locator('.mini-job-reason')).toHaveText('기술 자격 요건 확인 필요')
  await page.getByRole('button', { name: '공개 채용', exact: true }).click()
  await expect(page.locator('.data-quality-list > div').filter({ hasText: '자격 항목의 기술' }).locator('dd')).toHaveText('3 / 4개')
  await expect(page.locator('.data-quality-list > div').filter({ hasText: '경력 조건의 원문' }).locator('dd')).toHaveText('3 / 4개')
  await page.getByRole('button', { name: '닫기', exact: true }).click()
  await page.locator('.mini-job-title').first().click()
  await expect(page.locator('.job-meta-pills')).toContainText('3년 이상')
  await expect(page.locator('.job-meta-pills')).not.toContainText('8년')
  await expect(page.locator('.qualification-group.required .skill-tag')).toHaveText(['Python', 'AWS'])
  await expect(page.locator('.qualification-group.preferred .skill-tag')).toHaveText(['Rust'])
  await expect(page.locator('.qualification-group.context .skill-tag.matched')).toHaveCount(0)
  await expect(page.locator('.match-section.caution')).not.toContainText('Rust')
  await page.locator('.qualification-group.required .qualification-evidence > summary').click()
  await expect(page.locator('.qualification-group.required blockquote')).toHaveText('Minimum requirements\nExperience with Python and AWS.')
  await expect(page.locator('.experience-rule > summary')).toHaveText(['필수로 명시3년 이상', '우대 사항8년 이상'])
  await page.locator('.experience-rule > summary').first().click()
  await expect(page.locator('.experience-rule blockquote').first()).toHaveText('Minimum requirements\n3 years of software engineering experience.')
  await page.getByRole('button', { name: '기회 저장', exact: true }).click()
  await page.getByLabel('이 기회에 대한 나의 메모').fill('필수 경험 확인 · Rust는 우대')
  await page.getByRole('button', { name: '지원 완료로 표시', exact: true }).click()
  await page.getByRole('button', { name: '닫기', exact: true }).click()
  await page.getByRole('navigation', { name: '주요 메뉴' }).getByRole('button', { name: /저장한 기회/ }).click()
  await waitForSavedCommit(page)
  await page.reload()
  await expect(page.locator('.saved-card-match')).toHaveText('필수 항목 · Python · AWS')
  await expect(page.locator('.saved-note-preview')).toHaveText('필수 경험 확인 · Rust는 우대')
  await expect(page.locator('.saved-status')).toHaveText('지원 완료')
  await page.locator('.saved-title').click()
  await expect(page.locator('.qualification-group.preferred')).toContainText('Rust')
  await page.getByRole('button', { name: '닫기', exact: true }).click()
  const downloadPromise = page.waitForEvent('download')
  await page.getByRole('button', { name: 'CSV 내보내기', exact: true }).click()
  const csv = await readFile((await (await downloadPromise).path())!, 'utf8')
  for (const value of ['기술 조건', '경력 조건', '기술·경력 근거', '필수로 명시: Python, AWS', '우대 사항: Rust', '3 years of software engineering experience.', '필수 경험 확인 · Rust는 우대']) expect(csv).toContain(value)
})

test('a language alternative does not report the other language as a missing requirement', async ({ page }) => {
  await restore(page)
  await page.getByLabel('도시, 회사 또는 포지션 검색').fill('language choice fixture')
  await page.locator('.mini-job-title').click()
  await expect(page.locator('.match-section.caution')).not.toContainText('Rust')
  await page.locator('.qualification-group.required .qualification-evidence > summary').click()
  await expect(page.locator('.qualification-relation')).toHaveText('이 중 하나 · Python / Rust')
  await expect(page.locator('.qualification-group.required blockquote')).toHaveText('Minimum requirements\nExperience with Python or Rust.')
})

test('old saved qualification fields are rechecked while the application record is retained', async ({ page }) => {
  const { qualifications: _facts, ...previous } = jobs[0]
  const saved: SavedJob[] = [{
    job: { ...previous, skills: ['Python', 'AWS', 'Rust', 'Figma'], minExperience: 8 },
    company, savedAt: fetchedAt, status: 'applied', note: 'Keep this application record',
  }]
  await restore(page, saved)
  await page.getByRole('navigation', { name: '주요 메뉴' }).getByRole('button', { name: /저장한 기회/ }).click()
  await page.locator('.saved-title').click()
  await expect(page.locator('.job-meta-pills')).toContainText('3년 이상')
  await expect(page.locator('.job-qualifications .skill-tag')).not.toContainText(['Figma'])
  await expect(page.getByLabel('이 기회에 대한 나의 메모')).toHaveValue('Keep this application record')
  await expect(page.getByRole('button', { name: '지원 완료로 표시됨', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '닫기', exact: true }).click()
  await waitForSavedCommit(page)
  await page.reload()
  const stored = JSON.parse(await readSavedJson(page) || '[]')
  expect(stored[0]).toMatchObject({ savedAt: fetchedAt, status: 'applied', note: 'Keep this application record', job: { id: previous.id, fetchedAt, minExperience: 3, qualifications: { version: 1 } } })
})

test.describe('mobile qualifications', () => {
  test.use({ viewport: { width: 320, height: 780 }, isMobile: true, hasTouch: true })
  test('qualification groups and original experience evidence fit a narrow screen', async ({ page }) => {
    await restore(page)
    await page.getByLabel('도시, 회사 또는 포지션 검색').fill('priority core fixture')
    await page.locator('.mini-job-title').click()
    await page.locator('.job-qualifications').scrollIntoViewIfNeeded()
    await page.locator('.qualification-group.required .qualification-evidence > summary').click()
    await page.locator('.experience-rule > summary').last().click()
    await expect(page.locator('.experience-rule blockquote').last()).toBeVisible()
    expect(await page.locator('.dialog').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
    expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([])
  })
})
