import { readSavedJson, waitForSavedCommit } from './helpers/saved-store'
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { readFile } from 'node:fs/promises'
import { normalizeJob } from '../../server/normalize'
import { normalizeAshbyJob } from '../../server/providers/ashby'
import { CITIES } from '../../shared/cities'
import { COMPENSATION_VERSION } from '../../shared/types'
import type { Catalog, Job, SavedJob } from '../../shared/types'
import { ashbyPosting } from '../fixtures/public-postings'
import {
  NUMBER_FORMAT_ASHBY_COMPANY, NUMBER_FORMAT_COMPANY, NUMBER_FORMAT_INTRO, NUMBER_FORMAT_LEGACY_PAY,
  NUMBER_FORMAT_LABEL_POSTINGS, NUMBER_FORMAT_LABEL_QUOTES,
  NUMBER_FORMAT_NOTES, NUMBER_FORMAT_POSTINGS, NUMBER_FORMAT_QUOTES, NUMBER_FORMAT_TIME,
} from '../fixtures/compensation-number-format'
import type { NumberFormatPostingKey } from '../fixtures/compensation-number-format'

// Stage 76 · localized numeric separators in posting text. Fictional company,
// postings and amounts only. Expected strings are the literal UI outputs agreed in
// docs/design/compensation-number-format.md; the product parser only builds inputs.
const fetchedAt = NUMBER_FORMAT_TIME
const company = NUMBER_FORMAT_COMPANY
const keys = Object.keys(NUMBER_FORMAT_POSTINGS) as NumberFormatPostingKey[]
const jobs = keys.map(key => {
  const posting = NUMBER_FORMAT_POSTINGS[key]
  return normalizeJob({
    id: posting.id, title: posting.title, absolute_url: `https://example.test/quill-ledger/jobs/${posting.id}`,
    location: { name: 'London, UK' }, metadata: [{ name: 'Workplace Type', value: 'Hybrid' }],
    content: [NUMBER_FORMAT_INTRO, ...posting.paragraphs].map(paragraph => `<p>${paragraph}</p>`).join(''),
  }, company.id, fetchedAt)!
})
const job = (key: NumberFormatPostingKey) => jobs[keys.indexOf(key)]
const withoutPay = (item: Job) => {
  const { compensationRanges: _ranges, compensationNote: _note, compensationEvidence: _evidence, ...rest } = item
  return rest
}
const catalog: Catalog = {
  source: 'public', jobs, companies: [company], cities: CITIES, fetchedAt, stale: false, unmappedCount: 0,
  boards: [{ companyId: company.id, provider: 'greenhouse', board: company.board!, status: 'ok', dataStatus: 'fresh', included: jobs.length, total: jobs.length }],
}
test.beforeEach(async ({ page }) => { await page.clock.setFixedTime(new Date(fetchedAt)) })

async function restore(page: Page, saved: SavedJob[] = [], data = catalog) {
  await page.route('**/api/catalog?source=public*', route => route.fulfill({ json: data }))
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

async function openPosting(page: Page, key: NumberFormatPostingKey) {
  await page.getByLabel('도시, 회사 또는 포지션 검색').fill(NUMBER_FORMAT_POSTINGS[key].search)
  // The previously published result stays clickable while the worker computes the
  // new query, so only the button carrying the literal requested title is clicked.
  await page.locator('.mini-job-title', { hasText: NUMBER_FORMAT_POSTINGS[key].title }).click()
  await expect(page.getByRole('dialog')).toContainText(NUMBER_FORMAT_POSTINGS[key].title)
}
const closeDialog = (page: Page) => page.getByRole('button', { name: '닫기', exact: true }).click()
const compensationNote = (page: Page) => page.locator('.compensation-body > p').first()

test('localized separators are read as whole amounts, and only complete annual ranges enter statistics and the known-salary filter', async ({ page }, testInfo) => {
  await restore(page)
  await page.getByRole('button', { name: '공개 채용', exact: true }).click()
  await expect(page.locator('.data-quality-list > div').filter({ hasText: '비교 가능한 연봉' }).locator('dd')).toHaveText('2 / 5개')
  await expect(page.locator('.data-quality-list > div').filter({ hasText: '보상 조건 확인 필요' }).locator('dd')).toHaveText('3개')
  await closeDialog(page)

  await openPosting(page, 'spaceGrouped')
  await expect(page.locator('.job-key-facts')).toContainText('세전 연봉')
  await expect(page.locator('.job-key-facts')).toContainText('€88–124k')
  await expect(page.locator('.job-key-facts')).toContainText('약 $97–136k USD / 년')
  await expect(page.locator('.job-key-facts')).not.toContainText('이전 기록')
  await page.locator('.job-compensation > summary').click()
  await expect(page.locator('.job-compensation dd > span')).toHaveText(['EUR 88,000–124,000 / 년'])
  await page.locator('.compensation-evidence > summary').click()
  await expect(page.locator('.compensation-evidence blockquote')).toHaveText(NUMBER_FORMAT_QUOTES.spaceGrouped)
  // Temporary visual-review artifact under the per-run output tree; not a baseline.
  await page.locator('.compensation-evidence blockquote').scrollIntoViewIfNeeded()
  await page.screenshot({ path: testInfo.outputPath('desktop-corrected-range.png') })
  await testInfo.attach('desktop-corrected-range', { path: testInfo.outputPath('desktop-corrected-range.png'), contentType: 'image/png' })
  await expect(page.locator('.job-compensation')).not.toContainText('88–88')
  await expect(page.locator('.job-compensation')).not.toContainText(NUMBER_FORMAT_NOTES.partial)
  await closeDialog(page)

  await openPosting(page, 'dotted')
  await expect(page.locator('.job-key-facts')).toContainText('보상 확인 필요')
  await expect(compensationNote(page)).toHaveText(NUMBER_FORMAT_NOTES.none)
  await expect(page.locator('.job-compensation dd > span')).toHaveCount(0)
  await page.locator('.compensation-evidence > summary').click()
  await expect(page.locator('.compensation-evidence blockquote')).toContainText(NUMBER_FORMAT_QUOTES.dotted)
  await expect(page.locator('.job-compensation')).not.toContainText('EUR 62')
  await closeDialog(page)

  await openPosting(page, 'annotated')
  await expect(page.locator('.job-key-facts')).toContainText('보상 확인 필요')
  await expect(compensationNote(page)).toHaveText(NUMBER_FORMAT_NOTES.none)
  await expect(page.locator('.job-compensation dd > span')).toHaveCount(0)
  await page.locator('.compensation-evidence > summary').click()
  await expect(page.locator('.compensation-evidence blockquote')).toContainText('USD 84,00/year to USD 126,000/year')
  await expect(page.locator('.job-compensation')).not.toContainText('126,000–126,000')
  await closeDialog(page)

  await openPosting(page, 'mixed')
  await expect(page.locator('.job-key-facts')).toContainText('별도 보상 조건')
  await expect(compensationNote(page)).toHaveText(NUMBER_FORMAT_NOTES.partial)
  await expect(page.locator('.job-compensation dd > span')).toHaveText(['USD 136,000–187,000 / 년'])
  await expect(page.locator('.compensation-scope')).toContainText('Colorado')
  await expect(page.locator('.compensation-evidence > summary')).toHaveCount(2)
  await page.locator('.compensation-evidence > summary').last().click()
  await expect(page.locator('.compensation-evidence blockquote').last()).toContainText(NUMBER_FORMAT_QUOTES.portugal)
  // The preserved Portugal quote legitimately contains "EUR 54"; only the numeric amount rows must not.
  await expect(page.locator('.job-compensation dd > span')).not.toContainText('EUR 54')
  await closeDialog(page)

  await openPosting(page, 'bullets')
  await expect(page.locator('.job-key-facts')).toContainText('세전 연봉')
  await expect(page.locator('.job-key-facts')).toContainText('$150–150k')
  await page.locator('.job-compensation > summary').click()
  await expect(page.locator('.job-compensation dd > span')).toHaveText(['USD 150,000–150,000 / 년'])
  await expect(page.locator('.job-compensation')).not.toContainText('확인할 수 없어요')
  await expect(page.locator('.job-compensation')).not.toContainText('확인하지 못했어요')
  await closeDialog(page)

  await page.getByLabel('도시, 회사 또는 포지션 검색').fill('')
  await expect(page.locator('.company-job-toolbar')).toContainText('/ 5개 공고')
  await page.getByRole('button', { name: /모든 필터/ }).click()
  const filters = page.getByRole('dialog')
  await filters.getByLabel('연봉 미공개·별도 보상 공고도 포함').uncheck()
  const apply = filters.getByRole('button', { name: /개 공고 보기/ })
  await expect(apply).toHaveText(/2개 공고 보기/)
  await apply.click()
  await expect(page.locator('.company-job-toolbar')).toContainText('/ 2개 공고')
  await page.getByRole('button', { name: /전체 2개 공고 보기/ }).click()
  await expect(page.locator('.mini-job-title')).toHaveCount(2)
  await expect(page.locator('.company-jobs')).toContainText(NUMBER_FORMAT_POSTINGS.spaceGrouped.title)
  await expect(page.locator('.company-jobs')).toContainText(NUMBER_FORMAT_POSTINGS.bullets.title)
  await expect(page.locator('.company-jobs')).not.toContainText(NUMBER_FORMAT_POSTINGS.dotted.title)

  await page.getByRole('navigation', { name: '주요 메뉴' }).getByRole('button', { name: /도시 비교/ }).click()
  const median = page.getByRole('row').filter({ hasText: '공개 연봉의 중앙값' })
  await expect(median).toContainText('$133k')
  await expect(median).toContainText('연봉 공개 2개 공고 기준')
})

test('saved version 2 records are rechecked: corrected amounts, ambiguous quotes, earlier records and structured board pay keep status, notes and dates', async ({ page }) => {
  const spaceGrouped: Job = { ...withoutPay(job('spaceGrouped')), ...NUMBER_FORMAT_LEGACY_PAY.spaceGrouped, compensationVersion: 2 }
  const dotted: Job = { ...withoutPay(job('dotted')), ...NUMBER_FORMAT_LEGACY_PAY.dotted, compensationVersion: 2 }
  const earlier: Job = {
    ...withoutPay(job('spaceGrouped')), id: `greenhouse-${company.id}-7699`, title: 'Backend Engineer — version-two earlier record fixture',
    compensationVersion: 2, salary: { min: 88000, max: 124000, currency: 'EUR' }, description: 'This older excerpt has no compensation information.',
  }
  const structured = normalizeAshbyJob(ashbyPosting({
    id: 'number-format-structured', title: 'Backend Engineer — structured board pay fixture',
    descriptionPlain: `${NUMBER_FORMAT_INTRO}\nAnnual base salary: €50 000 – €60 000.`,
  }), NUMBER_FORMAT_ASHBY_COMPANY.id, fetchedAt)!
  const board: Job = { ...structured, compensationVersion: 2 }
  const saved: SavedJob[] = [
    { job: spaceGrouped, company, savedAt: fetchedAt, status: 'applied', note: 'Keep the corrected space-grouped range' },
    { job: dotted, company, savedAt: fetchedAt, status: 'saved', note: 'Keep the ambiguous quote' },
    { job: earlier, company, savedAt: fetchedAt, status: 'saved', note: 'Keep the earlier record' },
    { job: board, company: NUMBER_FORMAT_ASHBY_COMPANY, savedAt: fetchedAt, status: 'applied', note: 'Keep the structured board range' },
  ]
  await restore(page, saved)
  await page.getByRole('navigation', { name: '주요 메뉴' }).getByRole('button', { name: /저장한 기회/ }).click()
  await expect(page.locator('.saved-card')).toHaveCount(4)

  await page.locator('.saved-title').filter({ hasText: 'space grouped pay fixture' }).click()
  await expect(page.locator('.job-key-facts')).toContainText('세전 연봉')
  await expect(page.locator('.job-key-facts')).toContainText('€88–124k')
  await expect(page.locator('.job-key-facts')).not.toContainText('이전 기록')
  await page.locator('.job-compensation > summary').click()
  await expect(page.locator('.job-compensation dd > span')).toHaveText(['EUR 88,000–124,000 / 년'])
  await expect(page.locator('.job-compensation')).not.toContainText(NUMBER_FORMAT_NOTES.partial)
  await expect(page.getByLabel('이 기회에 대한 나의 메모')).toHaveValue('Keep the corrected space-grouped range')
  await expect(page.getByRole('button', { name: '지원 완료로 표시됨', exact: true })).toBeVisible()
  await closeDialog(page)

  await page.locator('.saved-title').filter({ hasText: 'dotted ambiguity fixture' }).click()
  await expect(page.locator('.job-key-facts')).toContainText('보상 확인 필요')
  await expect(compensationNote(page)).toHaveText(NUMBER_FORMAT_NOTES.none)
  await expect(page.locator('.job-compensation dd > span')).toHaveCount(0)
  await page.locator('.compensation-evidence > summary').click()
  await expect(page.locator('.compensation-evidence blockquote')).toContainText(NUMBER_FORMAT_QUOTES.dotted)
  await expect(page.locator('.job-compensation')).not.toContainText('EUR 62')
  await expect(page.getByLabel('이 기회에 대한 나의 메모')).toHaveValue('Keep the ambiguous quote')
  await closeDialog(page)

  await page.locator('.saved-title').filter({ hasText: 'earlier record fixture' }).click()
  await expect(page.locator('.job-key-facts')).toContainText('€88–124k · 이전 기록')
  await expect(page.locator('.job-compensation')).toContainText(NUMBER_FORMAT_NOTES.legacy)
  await closeDialog(page)

  await page.locator('.saved-title').filter({ hasText: 'structured board pay fixture' }).click()
  await expect(page.locator('.job-key-facts')).toContainText('£100–140k')
  await expect(page.locator('.job-key-facts')).not.toContainText('이전 기록')
  await page.locator('.job-compensation > summary').click()
  await expect(page.locator('.job-compensation dd > span')).toHaveText(['GBP 100,000–140,000 / 년'])
  await expect(page.locator('.compensation-evidence > summary')).toHaveText(/게시판의 보상 설명/)
  await expect(page.locator('.job-compensation')).not.toContainText('EUR 50')
  await closeDialog(page)

  await waitForSavedCommit(page)
  await page.reload()
  const persisted: SavedJob[] = JSON.parse(await readSavedJson(page) || '[]')
  const find = (id: string) => persisted.find(item => item.job.id === id)!
  expect(persisted).toHaveLength(4)
  expect(find(spaceGrouped.id)).toMatchObject({
    savedAt: fetchedAt, status: 'applied', note: 'Keep the corrected space-grouped range',
    job: { compensationVersion: COMPENSATION_VERSION, fetchedAt, description: spaceGrouped.description, salary: { min: 88000, max: 124000, currency: 'EUR' } },
  })
  expect(find(spaceGrouped.id).job.compensationRanges).toEqual([expect.objectContaining({ min: 88000, max: 124000, currency: 'EUR', period: 'year' })])
  expect(find(spaceGrouped.id).job.compensationEvidence).toBeUndefined()
  expect(find(dotted.id)).toMatchObject({
    savedAt: fetchedAt, status: 'saved', note: 'Keep the ambiguous quote',
    job: { compensationVersion: COMPENSATION_VERSION, fetchedAt, salary: null, compensationNote: NUMBER_FORMAT_NOTES.none },
  })
  expect(find(dotted.id).job.compensationRanges).toBeUndefined()
  expect(find(dotted.id).job.compensationEvidence).toHaveLength(1)
  expect(find(earlier.id)).toMatchObject({ savedAt: fetchedAt, note: 'Keep the earlier record', job: { compensationVersion: 2, salary: { min: 88000, max: 124000, currency: 'EUR' } } })
  expect(find(board.id)).toMatchObject({
    company: { id: NUMBER_FORMAT_ASHBY_COMPANY.id, provider: 'ashby' }, status: 'applied', note: 'Keep the structured board range',
    job: { compensationVersion: COMPENSATION_VERSION, fetchedAt, salary: { min: 100000, max: 140000, currency: 'GBP' } },
  })
  expect(find(board.id).job.compensationRanges).toEqual(structured.compensationRanges)

  const download = page.waitForEvent('download')
  await page.getByRole('button', { name: 'CSV 내보내기', exact: true }).click()
  const csv = await readFile((await (await download).path())!, 'utf8')
  for (const value of ['EUR 88,000–124,000 / 년', NUMBER_FORMAT_QUOTES.dotted, NUMBER_FORMAT_NOTES.none, 'GBP 100,000–140,000 / 년', '€88–124k · 이전 기록', 'Keep the ambiguous quote']) expect(csv).toContain(value)
  for (const value of ['EUR 88–88', 'EUR 62–118', 'EUR 50,000']) expect(csv).not.toContain(value)
})

test('a city label dash and a trailing-currency monthly range are read as whole ranges without inventing scope or period', async ({ page }) => {
  const labelJobs = Object.values(NUMBER_FORMAT_LABEL_POSTINGS).map(posting => normalizeJob({
    id: posting.id, title: posting.title, absolute_url: `https://example.test/quill-ledger/jobs/${posting.id}`,
    location: { name: 'London, UK' }, metadata: [{ name: 'Workplace Type', value: 'Hybrid' }],
    content: [NUMBER_FORMAT_INTRO, ...posting.paragraphs].map(paragraph => `<p>${paragraph}</p>`).join(''),
  }, company.id, fetchedAt)!)
  const data: Catalog = { ...catalog, jobs: labelJobs, boards: [{ ...catalog.boards[0], included: labelJobs.length, total: labelJobs.length }] }
  await restore(page, [], data)
  await page.getByRole('button', { name: '공개 채용', exact: true }).click()
  await expect(page.locator('.data-quality-list > div').filter({ hasText: '비교 가능한 연봉' }).locator('dd')).toHaveText('1 / 2개')
  await expect(page.locator('.data-quality-list > div').filter({ hasText: '보상 조건 확인 필요' }).locator('dd')).toHaveText('1개')
  await closeDialog(page)

  await page.getByLabel('도시, 회사 또는 포지션 검색').fill(NUMBER_FORMAT_LABEL_POSTINGS.cityLabel.search)
  await page.locator('.mini-job-title', { hasText: NUMBER_FORMAT_LABEL_POSTINGS.cityLabel.title }).click()
  await expect(page.getByRole('dialog')).toContainText(NUMBER_FORMAT_LABEL_POSTINGS.cityLabel.title)
  await expect(page.locator('.job-key-facts')).toContainText('세전 연봉')
  await expect(page.locator('.job-key-facts')).toContainText('€51–76k')
  await expect(page.locator('.job-key-facts')).toContainText('약 $56–84k USD / 년')
  await page.locator('.job-compensation > summary').click()
  await expect(page.locator('.job-compensation dd > span')).toHaveText(['EUR 51,000–76,000 / 년'])
  await expect(page.locator('.compensation-scope')).toHaveCount(0)
  await page.locator('.compensation-evidence > summary').click()
  await expect(page.locator('.compensation-evidence blockquote')).toHaveText(NUMBER_FORMAT_LABEL_QUOTES.cityLabel)
  await closeDialog(page)

  await page.getByLabel('도시, 회사 또는 포지션 검색').fill(NUMBER_FORMAT_LABEL_POSTINGS.trailingCurrency.search)
  await page.locator('.mini-job-title', { hasText: NUMBER_FORMAT_LABEL_POSTINGS.trailingCurrency.title }).click()
  await expect(page.getByRole('dialog')).toContainText(NUMBER_FORMAT_LABEL_POSTINGS.trailingCurrency.title)
  await expect(page.locator('.job-key-facts')).toContainText('별도 보상 조건')
  await expect(compensationNote(page)).toHaveText(NUMBER_FORMAT_NOTES.notAnnual)
  await expect(page.locator('.job-compensation dd > span')).toHaveText(['PLN 29,000–32,900 / 월'])
  await expect(page.locator('.job-compensation')).not.toContainText('29,000–29,000')
  await expect(page.locator('.job-compensation')).not.toContainText('32,900–32,900')
  await page.locator('.compensation-evidence > summary').click()
  await expect(page.locator('.compensation-evidence blockquote')).toHaveText(NUMBER_FORMAT_LABEL_QUOTES.trailingCurrency)
  await closeDialog(page)

  await page.getByLabel('도시, 회사 또는 포지션 검색').fill('')
  await page.getByRole('navigation', { name: '주요 메뉴' }).getByRole('button', { name: /도시 비교/ }).click()
  const median = page.getByRole('row').filter({ hasText: '공개 연봉의 중앙값' })
  await expect(median).toContainText('$70k')
  await expect(median).toContainText('연봉 공개 1개 공고 기준')
})

test.describe('mobile pay disclosure with localized separators', () => {
  test.use({ viewport: { width: 320, height: 780 }, isMobile: true, hasTouch: true })
  test('ambiguous quotes and corrected ranges stay readable and accessible at 320px', async ({ page }, testInfo) => {
    await restore(page)
    await openPosting(page, 'dotted')
    await expect(page.locator('.job-key-facts')).toContainText('보상 확인 필요')
    await expect(compensationNote(page)).toHaveText(NUMBER_FORMAT_NOTES.none)
    await page.locator('.compensation-evidence > summary').click()
    await expect(page.locator('.compensation-evidence blockquote')).toContainText(NUMBER_FORMAT_QUOTES.dotted)
    expect(await page.locator('.dialog').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
    expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([])
    // Temporary visual-review artifacts under the per-run output tree; not baselines.
    await page.locator('.compensation-evidence blockquote').scrollIntoViewIfNeeded()
    await page.screenshot({ path: testInfo.outputPath('mobile-ambiguous-evidence.png') })
    await testInfo.attach('mobile-ambiguous-evidence', { path: testInfo.outputPath('mobile-ambiguous-evidence.png'), contentType: 'image/png' })
    await closeDialog(page)
    await openPosting(page, 'spaceGrouped')
    await expect(page.locator('.job-key-facts')).toContainText('€88–124k')
    await page.locator('.job-compensation > summary').click()
    await expect(page.locator('.job-compensation dd > span')).toHaveText(['EUR 88,000–124,000 / 년'])
    expect(await page.locator('.dialog').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
    expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([])
    await page.locator('.job-compensation dd > span').scrollIntoViewIfNeeded()
    await page.screenshot({ path: testInfo.outputPath('mobile-corrected-range.png') })
    await testInfo.attach('mobile-corrected-range', { path: testInfo.outputPath('mobile-corrected-range.png'), contentType: 'image/png' })
  })
})
