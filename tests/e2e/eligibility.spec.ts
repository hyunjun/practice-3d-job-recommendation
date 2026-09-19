import { readSavedJson, waitForSavedCommit } from './helpers/saved-store'
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { readFile } from 'node:fs/promises'
import { CITIES } from '../../shared/cities'
import { PUBLIC_COMPANIES } from '../../shared/companies'
import { DEFAULT_FILTERS, SAMPLE_PROFILE } from '../../shared/types'
import type { Catalog, SavedJob } from '../../shared/types'
import { normalizeJob } from '../../server/normalize'
import { normalizeAshbyJob } from '../../server/providers/ashby'
import { ashbyPosting } from '../fixtures/public-postings'

const n8n = PUBLIC_COMPANIES.find(company => company.id === 'n8n')!
const supabase = PUBLIC_COMPANIES.find(company => company.id === 'supabase')!
const anthropic = PUBLIC_COMPANIES.find(company => company.id === 'anthropic')!
const fetchedAt = '2026-09-19T08:00:00.000Z'
test.beforeEach(async ({ page }) => { await page.clock.setFixedTime(new Date(fetchedAt)) })
const countryPolicy = 'We can sponsor visas to Germany; for any other country, you need to have existing right to work.'
const citizenPolicy = 'This position requires verification of U.S. citizenship due to citizenship-based legal restrictions. This position supports a government customer and is subject to citizenship-based restrictions where required or permitted by applicable law. Citizenship will be verified via a valid passport, other approved documents, or verified US government clearance.'
const intro = 'Minimum requirements\n3 years of engineering experience.\nExperience with Python and AWS.'
const countryJob = normalizeAshbyJob(ashbyPosting({
  id: 'country-scope-fixture', title: 'Backend Engineer — country scope fixture',
  workplaceType: 'Remote', isRemote: true, location: 'Remote, Germany, United Kingdom', address: null,
  secondaryLocations: [], descriptionPlain: `${intro}\n${countryPolicy}`,
}), n8n.id, fetchedAt)!
const unrestricted = normalizeAshbyJob(ashbyPosting({
  id: 'unrestricted-fixture', title: 'Backend Engineer — unrestricted fixture',
  workplaceType: 'Remote', isRemote: true, location: 'Remote, Global', address: null,
  secondaryLocations: [], descriptionPlain: `${intro}\nWe provide visa sponsorship.\nWe do not discriminate based on nationality or citizenship.`,
}), supabase.id, fetchedAt)!
const citizenJob = normalizeJob({
  id: 8803, title: 'Backend Engineer — citizenship fixture', absolute_url: 'https://example.com/eligibility/8803',
  location: { name: 'Remote, United States' }, metadata: [{ name: 'Workplace Type', value: 'Remote' }],
  content: `${intro}\nPreferred qualifications\nActive federal security clearance (Secret or above)\n${citizenPolicy}\nVisa sponsorship: We do sponsor visas! However, we cannot sponsor visas for every role and every candidate.`.split('\n').map(line => `<p>${line}</p>`).join(''),
}, anthropic.id, fetchedAt)!
const companies = [n8n, supabase, anthropic]
const jobs = [countryJob, unrestricted, citizenJob]
const catalog: Catalog = {
  source: 'public', fetchedAt, stale: false, jobs, companies, cities: CITIES, unmappedCount: 0,
  boards: companies.map(company => ({ companyId: company.id, provider: company.provider!, board: company.board!, status: 'ok', dataStatus: 'fresh', total: 1, included: 1 })),
}

async function restore(page: Page, residence = 'GB', saved: SavedJob[] = []) {
  await page.route('**/api/catalog?source=public*', route => route.fulfill({ json: catalog }))
  await page.addInitScript(({ residence, saved, profile, filters }) => {
    if (!localStorage.getItem('orbit.v1.profile')) localStorage.setItem('orbit.v1.profile', JSON.stringify({ ...profile, kind: 'personal', name: 'Eligibility fixture', residence }))
    if (!localStorage.getItem('orbit.v1.exploration')) localStorage.setItem('orbit.v1.exploration', JSON.stringify({
      source: 'public', mapMode: 'flat', panelTab: 'remote', filters,
    }))
    if (!localStorage.getItem('orbit.v1.saved')) localStorage.setItem('orbit.v1.saved', JSON.stringify(saved))
  }, { residence, saved, profile: SAMPLE_PROFILE, filters: DEFAULT_FILTERS })
  await page.goto(saved.length ? '/#saved' : '/')
  await expect(page.getByRole('button', { name: '공개 채용', exact: true })).toBeVisible()
}

test('country-specific sponsorship stays conditional through filtering, evidence, saving and CSV', async ({ page }) => {
  await restore(page)
  await page.getByLabel('도시, 회사 또는 포지션 검색').fill('country scope fixture')
  await expect(page.locator('.visa-tag')).toHaveText('비자 조건부 지원 명시')
  await expect(page.locator('.company-card .eligibility-notice')).toContainText('취업 허가')
  await page.getByLabel('비자 지원 필터').selectOption('yes')
  await expect(page.locator('.company-card')).toHaveCount(0)
  await page.getByLabel('비자 지원 필터').selectOption('supported')
  await expect(page.locator('.company-card')).toHaveCount(1)
  await page.locator('.mini-job-title').click()
  await expect(page.locator('.job-key-facts')).toContainText('조건부 지원 명시')
  await expect(page.locator('.job-eligibility .eligibility-rule')).toHaveCount(1)
  await page.locator('.job-eligibility summary').click()
  await expect(page.locator('.job-eligibility blockquote')).toHaveText(countryPolicy)
  await expect(page.locator('.job-eligibility summary')).toContainText('비자 지원 적용 범위 · 취업 허가')
  await page.getByRole('button', { name: '기회 저장', exact: true }).click()
  await page.getByLabel('이 기회에 대한 나의 메모').fill('독일과 다른 국가의 취업 허가 조건 확인')
  await page.getByRole('button', { name: '지원 완료로 표시', exact: true }).click()
  await page.getByRole('button', { name: '닫기', exact: true }).click()
  await page.getByRole('navigation', { name: '주요 메뉴' }).getByRole('button', { name: /저장한 기회/ }).click()
  await expect(page.locator('.saved-card .eligibility-notice')).toContainText('취업 허가 조건 확인')
  const downloading = page.waitForEvent('download')
  await page.getByRole('button', { name: 'CSV 내보내기', exact: true }).click()
  const csv = await readFile((await (await downloading).path())!, 'utf8')
  for (const value of ['취업 자격 조건', '취업 자격 근거', '조건부 지원 명시', countryPolicy, '독일과 다른 국가의 취업 허가 조건 확인']) expect(csv).toContain(value)
  await waitForSavedCommit(page)
  await page.reload()
  const stored = JSON.parse(await readSavedJson(page) || '[]')
  expect(stored[0]).toMatchObject({ status: 'applied', note: '독일과 다른 국가의 취업 허가 조건 확인', job: { id: countryJob.id, fetchedAt, visa: 'conditional', eligibility: { version: 1 } } })
})

test('matching a remote country does not hide mandatory citizenship or turn preferred clearance into a requirement', async ({ page }) => {
  await restore(page, 'US')
  const company = page.locator('.company-card').filter({ hasText: 'citizenship fixture' })
  await expect(company.locator('.eligibility-notice')).toHaveText('국적·시민권 조건 확인')
  await expect(page.locator('.company-card').filter({ hasText: 'unrestricted fixture' }).locator('.eligibility-notice')).toHaveCount(0)
  await company.locator('.mini-job-title').click()
  await expect(page.locator('.match-section').first()).toContainText('선택한 거주 국가가 공고의 원격근무 지역에 포함돼요')
  await expect(page.locator('.match-section').first()).not.toContainText('원격 지원이 가능')
  const required = page.locator('.eligibility-rule.required')
  const preferred = page.locator('.eligibility-rule.preferred')
  await expect(required.locator('summary')).toHaveText('국적·시민권필수로 명시')
  await expect(preferred.locator('summary')).toHaveText('보안 인가우대 사항')
  await required.locator('summary').click()
  await preferred.locator('summary').click()
  await expect(required.locator('blockquote')).toHaveText(citizenPolicy)
  await expect(preferred.locator('blockquote')).toHaveText('Preferred qualifications\nActive federal security clearance (Secret or above)')
  await expect(page.locator('.remote-scope')).toContainText('취업 허가·국적·주별 제한')
  await page.getByRole('button', { name: '닫기', exact: true }).click()
  await page.getByRole('button', { name: '공개 채용', exact: true }).click()
  await expect(page.locator('.data-quality-list > div').filter({ hasText: '취업 자격 조건의 원문' }).locator('dd')).toHaveText('2 / 3개')
})

test('legacy saved support is rechecked while the original timestamp, note and application record survive', async ({ page }) => {
  const { eligibility: _eligibility, ...previous } = countryJob
  const saved: SavedJob = {
    job: { ...previous, visa: 'yes', fetchedAt: '2026-09-17T08:00:00.000Z' },
    company: n8n, savedAt: '2026-09-18T09:00:00.000Z', status: 'applied', note: 'Keep the original application record',
  }
  await restore(page, 'GB', [saved])
  await expect(page.locator('.saved-card .eligibility-notice')).toContainText('취업 허가')
  await page.locator('.saved-title').click()
  await expect(page.locator('.job-key-facts')).toContainText('조건부 지원 명시')
  await expect(page.getByRole('button', { name: '지원 완료로 표시됨', exact: true })).toBeVisible()
  await expect(page.getByLabel('이 기회에 대한 나의 메모')).toHaveValue(saved.note)
  await page.getByRole('button', { name: '닫기', exact: true }).click()
  await waitForSavedCommit(page)
  await page.reload()
  const restored = JSON.parse(await readSavedJson(page) || '[]')[0]
  expect(restored).toMatchObject({ savedAt: saved.savedAt, status: saved.status, note: saved.note, job: { id: saved.job.id, fetchedAt: saved.job.fetchedAt, visa: 'conditional', eligibility: { version: 1 } } })
})

test.describe('eligibility evidence on narrow screens', () => {
  test.use({ viewport: { width: 320, height: 780 }, isMobile: true, hasTouch: true })
  test('mandatory and preferred conditions remain readable and accessible beside the saved record', async ({ page }) => {
    const saved: SavedJob[] = [{ job: citizenJob, company: anthropic, savedAt: fetchedAt, status: 'saved', note: '' }]
    await restore(page, 'US', saved)
    await page.locator('.saved-title').click()
    await page.locator('.job-eligibility').scrollIntoViewIfNeeded()
    await page.locator('.eligibility-rule.required > summary').click()
    await page.locator('.eligibility-rule.preferred > summary').click()
    await expect(page.locator('.eligibility-rule.required blockquote')).toBeVisible()
    expect(await page.locator('.dialog').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
    expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([])
  })
})
