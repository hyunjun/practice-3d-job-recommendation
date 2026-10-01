import { readSavedJson, waitForSavedCommit } from './helpers/saved-store'
import { expect, test } from '@playwright/test'
import type { Locator, Page, TestInfo } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { readFile } from 'node:fs/promises'
import { normalizeJob } from '../../server/normalize'
import { normalizeAshbyJob } from '../../server/providers/ashby'
import { CITIES } from '../../shared/cities'
import { COMPENSATION_VERSION } from '../../shared/types'
import type { Catalog, Job, Salary, SavedJob } from '../../shared/types'
import { ashbyPosting } from '../fixtures/public-postings'
import {
  CONTEXT_ASHBY_COMPANY, CONTEXT_BOARD_COMPLETE_ROW, CONTEXT_COMPANY, CONTEXT_DEFAULT_NOTE, CONTEXT_INCOMPLETE_RANGES, CONTEXT_INTRO,
  CONTEXT_LEGACY_PAY, CONTEXT_LEGACY_ROWS, CONTEXT_NOTES, CONTEXT_POSTINGS, CONTEXT_SENTENCES, CONTEXT_TIME, OTHER_SUFFIX,
  contextBoardRaw, contextPostingRaw,
} from '../fixtures/compensation-context'
import type { ContextPostingKey } from '../fixtures/compensation-context'

// Stage 77 · amount ownership and period context in the browser. Fictional company,
// postings and amounts only. Expected strings are the literal UI outputs agreed in
// docs/design/compensation-context.md (draft02); the product normalizer only builds inputs.
const fetchedAt = CONTEXT_TIME
const company = CONTEXT_COMPANY
const keys = Object.keys(CONTEXT_POSTINGS) as ContextPostingKey[]
const jobs = keys.map(key => normalizeJob(contextPostingRaw(key), company.id, fetchedAt)!)
const job = (key: ContextPostingKey) => jobs[keys.indexOf(key)]
const withoutPay = (item: Job) => {
  const { compensationRanges: _ranges, compensationNote: _note, compensationEvidence: _evidence, ...rest } = item
  return rest
}
const catalog: Catalog = {
  source: 'public', jobs, companies: [company], cities: CITIES, fetchedAt, stale: false, unmappedCount: 0,
  boards: [{ companyId: company.id, provider: 'greenhouse', board: company.board!, status: 'ok', dataStatus: 'fresh', included: jobs.length, total: jobs.length }],
}
const usd: Salary = { min: 100000, max: 120000, currency: 'USD' }
const baseRow = 'USD 100,000–120,000 / 년'
const otherRow = `USD 25,000–25,000 / 기간 미확인${OTHER_SUFFIX}`
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

async function openPosting(page: Page, key: ContextPostingKey) {
  await page.getByLabel('도시, 회사 또는 포지션 검색').fill(CONTEXT_POSTINGS[key].search)
  // The previously published result stays clickable while the worker computes the
  // new query, so only the button carrying the literal requested title is clicked.
  await page.locator('.mini-job-title', { hasText: CONTEXT_POSTINGS[key].title }).click()
  await expect(page.getByRole('dialog')).toContainText(CONTEXT_POSTINGS[key].title)
}
const closeDialog = (page: Page) => page.getByRole('button', { name: '닫기', exact: true }).click()
const compensationNote = (page: Page) => page.locator('.compensation-body > p').first()
const payRows = (page: Page) => page.locator('.job-compensation dd > span')

/**
 * Required review capture: a stable file name in this run's output tree plus a report
 * attachment. The anchor is scrolled into view and every listed element must be inside the
 * viewport, so the amount or other label and its source quote are both exposed in the image.
 */
async function capture(page: Page, testInfo: TestInfo, name: string, anchor: Locator, visible: Locator[]) {
  await anchor.scrollIntoViewIfNeeded()
  for (const element of visible) await expect(element).toBeInViewport()
  const path = testInfo.outputPath(name)
  await page.screenshot({ path })
  await testInfo.attach(name, { path, contentType: 'image/png' })
}

test('bonus, review and currency ownership decide comparability, the known-salary filter and the city median', async ({ page }, testInfo) => {
  await restore(page)
  await page.getByRole('button', { name: '공개 채용', exact: true }).click()
  await expect(page.locator('.data-quality-list > div').filter({ hasText: '비교 가능한 연봉' }).locator('dd')).toHaveText('4 / 7개')
  await expect(page.locator('.data-quality-list > div').filter({ hasText: '보상 조건 확인 필요' }).locator('dd')).toHaveText('3개')
  await closeDialog(page)

  await openPosting(page, 'bonusAfterBase')
  await expect(page.locator('.job-key-facts')).toContainText('세전 연봉')
  await expect(page.locator('.job-key-facts')).toContainText('$100–120k')
  await page.locator('.job-compensation > summary').click()
  await expect(compensationNote(page)).toHaveText(CONTEXT_DEFAULT_NOTE)
  // The preserved quote legitimately contains the bonus amount; only the numeric rows must not.
  await expect(payRows(page)).toHaveText([baseRow])
  await page.locator('.compensation-evidence > summary').click()
  await expect(page.locator('.compensation-evidence blockquote')).toContainText(CONTEXT_SENTENCES.bonusAfterBase)
  await closeDialog(page)

  await openPosting(page, 'bonusOnly')
  await expect(page.locator('.job-key-facts')).toContainText('보상 확인 필요')
  await expect(page.locator('.job-key-facts')).not.toContainText('$25–25k')
  await expect(compensationNote(page)).toHaveText(CONTEXT_NOTES.none)
  await expect(payRows(page)).toHaveCount(0)
  await page.locator('.compensation-evidence > summary').click()
  await expect(page.locator('.compensation-evidence blockquote')).toContainText(CONTEXT_SENTENCES.bonusOnly)
  await closeDialog(page)

  await openPosting(page, 'bonusFirst')
  await expect(page.locator('.job-key-facts')).toContainText('세전 연봉')
  await expect(page.locator('.job-key-facts')).toContainText('$100–120k')
  await page.locator('.job-compensation > summary').click()
  await expect(payRows(page)).toHaveText([baseRow])
  await closeDialog(page)

  await openPosting(page, 'reviewedAnnually')
  await expect(page.locator('.job-key-facts')).toContainText('별도 보상 조건')
  await expect(compensationNote(page)).toHaveText(CONTEXT_NOTES.periodUnknown)
  await expect(payRows(page)).toHaveText(['USD 130,000–170,000 / 기간 미확인'])
  await expect(page.locator('.job-compensation')).not.toContainText('/ 년')
  await closeDialog(page)

  await openPosting(page, 'reviewedMonthly')
  await expect(page.locator('.job-key-facts')).toContainText('세전 연봉')
  await expect(page.locator('.job-key-facts')).toContainText('€90–110k')
  await expect(page.locator('.job-key-facts')).toContainText('약 $99–121k USD / 년')
  await page.locator('.job-compensation > summary').click()
  await expect(payRows(page)).toHaveText(['EUR 90,000–110,000 / 년'])
  await expect(page.locator('.job-compensation')).not.toContainText('기간 미확인')
  await closeDialog(page)

  await openPosting(page, 'currencyLeak')
  await expect(page.locator('.job-key-facts')).toContainText('별도 보상 조건')
  await expect(compensationNote(page)).toHaveText(CONTEXT_NOTES.currency)
  await expect(payRows(page)).toHaveText(['통화 미확인 120,000–180,000 / 년'])
  await expect(page.locator('.job-compensation')).not.toContainText('CAD 120,000')
  await closeDialog(page)

  await openPosting(page, 'structured')
  await expect(page.locator('.job-key-facts')).toContainText('세전 연봉')
  await expect(page.locator('.job-key-facts')).toContainText('$100–120k')
  await page.locator('.job-compensation > summary').click()
  await expect(compensationNote(page)).toHaveText(CONTEXT_DEFAULT_NOTE)
  await expect(payRows(page)).toHaveText([baseRow, otherRow])
  await expect(page.locator('.compensation-evidence > summary')).toHaveText([/게시판의 보상 설명/, /게시판의 보상 설명/])
  await expect(page.locator('.job-compensation')).not.toContainText('25,000–25,000 / 년')
  await page.locator('.compensation-evidence > summary').nth(0).click()
  await page.locator('.compensation-evidence > summary').nth(1).click()
  await expect(page.locator('.compensation-evidence blockquote')).toHaveText([
    'Annual base salary\nPaid in twelve monthly installments.', 'Signing bonus\nWe also offer a competitive annual base salary.',
  ])
  // Required visual review capture at 1440x960: both numeric rows, the other label and both board quotes.
  await capture(page, testInfo, 'desktop-structured-base-and-other.png', page.locator('.job-compensation'), [
    payRows(page).first(), payRows(page).last(), page.locator('.compensation-evidence blockquote').first(), page.locator('.compensation-evidence blockquote').last(),
  ])
  await closeDialog(page)

  await page.getByLabel('도시, 회사 또는 포지션 검색').fill('')
  await expect(page.locator('.company-job-toolbar')).toContainText('/ 7개 공고')
  await page.getByRole('button', { name: /모든 필터/ }).click()
  const filters = page.getByRole('dialog')
  await filters.getByLabel('연봉 미공개·별도 보상 공고도 포함').uncheck()
  const apply = filters.getByRole('button', { name: /개 공고 보기/ })
  await expect(apply).toHaveText(/4개 공고 보기/)
  await apply.click()
  await expect(page.locator('.company-job-toolbar')).toContainText('/ 4개 공고')
  await page.getByRole('button', { name: /전체 4개 공고 보기/ }).click()
  await expect(page.locator('.mini-job-title')).toHaveCount(4)
  for (const key of ['bonusAfterBase', 'bonusFirst', 'reviewedMonthly', 'structured'] as ContextPostingKey[]) {
    await expect(page.locator('.company-jobs')).toContainText(CONTEXT_POSTINGS[key].title)
  }
  for (const key of ['bonusOnly', 'reviewedAnnually', 'currencyLeak'] as ContextPostingKey[]) {
    await expect(page.locator('.company-jobs')).not.toContainText(CONTEXT_POSTINGS[key].title)
  }

  await page.getByRole('navigation', { name: '주요 메뉴' }).getByRole('button', { name: /도시 비교/ }).click()
  const median = page.getByRole('row').filter({ hasText: '공개 연봉의 중앙값' })
  await expect(median).toContainText('$110k')
  await expect(median).toContainText('연봉 공개 4개 공고 기준')
})

test('saved version 3 records are corrected from their own evidence while status, notes, dates and structured sources are kept', async ({ page }) => {
  const bonusOnly: Job = { ...withoutPay(job('bonusOnly')), ...CONTEXT_LEGACY_PAY.bonusOnly, compensationVersion: 3 }
  const twoRows: Job = {
    ...withoutPay(job('bonusAfterBase')), ...CONTEXT_LEGACY_PAY.twoRows, compensationVersion: 3,
    description: `${CONTEXT_INTRO}\n${CONTEXT_SENTENCES.postfixBonus}`,
  }
  const reviewed: Job = { ...withoutPay(job('reviewedAnnually')), ...CONTEXT_LEGACY_PAY.reviewedAnnually, compensationVersion: 3 }
  const boardReview: Job = {
    ...withoutPay(job('structured')), id: `greenhouse-${company.id}-7791`, title: 'Backend Engineer — board review fixture',
    ...CONTEXT_LEGACY_PAY.greenhouseReview, compensationVersion: 3,
  }
  const structuredControl = normalizeAshbyJob(ashbyPosting({
    id: 'context-structured-control', title: 'Backend Engineer — structured board control fixture',
    descriptionPlain: `${CONTEXT_INTRO}\n${CONTEXT_SENTENCES.bonusOnly}`,
  }), CONTEXT_ASHBY_COMPANY.id, fetchedAt)!
  const control: Job = { ...structuredControl, compensationVersion: 3 }
  const earlier: Job = {
    ...withoutPay(job('bonusOnly')), id: `greenhouse-${company.id}-7792`, title: 'Backend Engineer — earlier record fixture',
    compensationVersion: 3, salary: { min: 88000, max: 124000, currency: 'EUR' }, description: 'This older excerpt has no compensation information.',
  }
  const unrelated: Job = {
    ...withoutPay(job('bonusOnly')), id: `greenhouse-${company.id}-7793`, title: 'Backend Engineer — unrelated bonus scalar fixture',
    compensationVersion: 3, salary: { min: 25000, max: 25000, currency: 'USD' }, description: `${CONTEXT_INTRO}\n${CONTEXT_SENTENCES.benefitsBonus}`,
  }
  const structured = job('structured')
  // Native version 4 shape of a base row plus an unquoted invalid board item, re-stamped as version 3.
  const incompleteBoard: Job = {
    ...normalizeJob(contextBoardRaw(7712, 'Backend Engineer — incomplete board item fixture', CONTEXT_INCOMPLETE_RANGES), company.id, fetchedAt)!,
    compensationVersion: 3,
  }
  const malformedMixed: Job = {
    ...withoutPay(job('structured')), id: `greenhouse-${company.id}-7794`, title: 'Backend Engineer — malformed salary and equal bonus fixture',
    compensationVersion: 2, salary: null, compensationNote: CONTEXT_NOTES.variants,
    description: `${CONTEXT_INTRO}\n${CONTEXT_SENTENCES.malformedWithEqualBonus}`,
    compensationRanges: [CONTEXT_BOARD_COMPLETE_ROW, CONTEXT_LEGACY_ROWS.malformedEqualBonus],
  }
  // H1: an old text-derived record whose complete body carries a pay heading and a seniority-abbreviated role line.
  const senior: Job = {
    ...withoutPay(job('bonusOnly')), id: `greenhouse-${company.id}-7795`, title: 'Sr. Backend Engineer — senior pay line fixture',
    compensationVersion: 3, salary: null, description: `${CONTEXT_INTRO}\n${CONTEXT_SENTENCES.seniorHeading}`,
  }
  const saved: SavedJob[] = [
    { job: bonusOnly, company, savedAt: fetchedAt, status: 'applied', note: 'Keep the corrected bonus record' },
    { job: twoRows, company, savedAt: fetchedAt, status: 'saved', note: 'Keep the single base range' },
    { job: reviewed, company, savedAt: fetchedAt, status: 'saved', note: 'Keep the unknown period' },
    { job: boardReview, company, savedAt: fetchedAt, status: 'applied', note: 'Keep the board amounts' },
    { job: control, company: CONTEXT_ASHBY_COMPANY, savedAt: fetchedAt, status: 'applied', note: 'Keep the structured control' },
    { job: earlier, company, savedAt: fetchedAt, status: 'saved', note: 'Keep the earlier record' },
    { job: unrelated, company, savedAt: fetchedAt, status: 'saved', note: 'Keep the unrelated scalar' },
    { job: structured, company, savedAt: fetchedAt, status: 'saved', note: 'Keep the structured base and bonus' },
    { job: incompleteBoard, company, savedAt: fetchedAt, status: 'applied', note: 'Keep the incomplete board disclosure' },
    { job: malformedMixed, company, savedAt: fetchedAt, status: 'saved', note: 'Keep the malformed salary evidence' },
    { job: senior, company, savedAt: fetchedAt, status: 'applied', note: 'Keep the senior qualifier' },
  ]
  await restore(page, saved)
  await page.getByRole('navigation', { name: '주요 메뉴' }).getByRole('button', { name: /저장한 기회/ }).click()
  await expect(page.locator('.saved-card')).toHaveCount(11)

  await page.locator('.saved-title').filter({ hasText: 'bonus only fixture' }).click()
  await expect(page.locator('.job-key-facts')).toContainText('보상 확인 필요')
  await expect(page.locator('.job-key-facts')).not.toContainText('이전 기록')
  await expect(compensationNote(page)).toHaveText(CONTEXT_NOTES.none)
  await expect(payRows(page)).toHaveCount(0)
  await page.locator('.compensation-evidence > summary').click()
  await expect(page.locator('.compensation-evidence blockquote')).toContainText(CONTEXT_SENTENCES.bonusOnly)
  await expect(page.getByLabel('이 기회에 대한 나의 메모')).toHaveValue('Keep the corrected bonus record')
  await expect(page.getByRole('button', { name: '지원 완료로 표시됨', exact: true })).toBeVisible()
  await closeDialog(page)

  await page.locator('.saved-title').filter({ hasText: 'bonus after base fixture' }).click()
  await expect(page.locator('.job-key-facts')).toContainText('세전 연봉')
  await expect(page.locator('.job-key-facts')).toContainText('$100–120k')
  await expect(page.locator('.job-key-facts')).not.toContainText('이전 기록')
  await page.locator('.job-compensation > summary').click()
  await expect(payRows(page)).toHaveText([baseRow])
  await expect(page.locator('.job-compensation')).not.toContainText(CONTEXT_NOTES.variants)
  await expect(page.getByLabel('이 기회에 대한 나의 메모')).toHaveValue('Keep the single base range')
  await closeDialog(page)

  await page.locator('.saved-title').filter({ hasText: 'reviewed annually fixture' }).click()
  await expect(page.locator('.job-key-facts')).toContainText('별도 보상 조건')
  await expect(compensationNote(page)).toHaveText(CONTEXT_NOTES.periodUnknown)
  await expect(payRows(page)).toHaveText(['USD 130,000–170,000 / 기간 미확인'])
  await closeDialog(page)

  await page.locator('.saved-title').filter({ hasText: 'board review fixture' }).click()
  await expect(page.locator('.job-key-facts')).toContainText('별도 보상 조건')
  await expect(compensationNote(page)).toHaveText(CONTEXT_NOTES.periodUnknown)
  await expect(payRows(page)).toHaveText(['USD 100,000–120,000 / 기간 미확인'])
  await expect(page.locator('.compensation-evidence > summary')).toHaveText(/게시판의 보상 설명/)
  await expect(page.getByRole('button', { name: '지원 완료로 표시됨', exact: true })).toBeVisible()
  await closeDialog(page)

  await page.locator('.saved-title').filter({ hasText: 'structured board control fixture' }).click()
  await expect(page.locator('.job-key-facts')).toContainText('£100–140k')
  await expect(page.locator('.job-key-facts')).not.toContainText('이전 기록')
  await page.locator('.job-compensation > summary').click()
  await expect(payRows(page)).toHaveText(['GBP 100,000–140,000 / 년'])
  await expect(page.locator('.job-compensation')).not.toContainText('25,000')
  await closeDialog(page)

  await page.locator('.saved-title').filter({ hasText: 'earlier record fixture' }).click()
  await expect(page.locator('.job-key-facts')).toContainText('€88–124k · 이전 기록')
  await expect(page.locator('.job-compensation')).toContainText(CONTEXT_NOTES.legacy)
  await closeDialog(page)

  await page.locator('.saved-title').filter({ hasText: 'unrelated bonus scalar fixture' }).click()
  await expect(page.locator('.job-key-facts')).toContainText('$25–25k · 이전 기록')
  await expect(page.locator('.job-compensation')).toContainText(CONTEXT_NOTES.legacy)
  await closeDialog(page)

  await page.locator('.saved-title').filter({ hasText: 'structured base and other fixture' }).click()
  await expect(page.locator('.job-key-facts')).toContainText('$100–120k')
  await page.locator('.job-compensation > summary').click()
  await expect(payRows(page)).toHaveText([baseRow, otherRow])
  await closeDialog(page)

  await page.locator('.saved-title').filter({ hasText: 'incomplete board item fixture' }).click()
  await expect(page.locator('.job-key-facts')).toContainText('별도 보상 조건')
  await expect(page.locator('.job-key-facts')).not.toContainText('$100–120k')
  await expect(compensationNote(page)).toContainText(CONTEXT_NOTES.partial)
  await expect(payRows(page)).toHaveText([baseRow])
  await expect(page.getByRole('button', { name: '지원 완료로 표시됨', exact: true })).toBeVisible()
  await closeDialog(page)

  await page.locator('.saved-title').filter({ hasText: 'malformed salary and equal bonus fixture' }).click()
  await expect(page.locator('.job-key-facts')).toContainText('별도 보상 조건')
  await expect(page.locator('.job-key-facts')).not.toContainText('$100–120k')
  await expect(compensationNote(page)).toHaveText(CONTEXT_NOTES.partial)
  await expect(payRows(page)).toHaveText([baseRow])
  await expect(page.locator('.job-compensation')).not.toContainText('EUR 20,000')
  await page.locator('.compensation-evidence > summary').filter({ hasText: '금액의 원문 근거' }).first().click()
  await expect(page.locator('.compensation-evidence blockquote').filter({ hasText: 'EUR 20.000' })).toHaveCount(1)
  await expect(page.getByLabel('이 기회에 대한 나의 메모')).toHaveValue('Keep the malformed salary evidence')
  await closeDialog(page)

  await page.locator('.saved-title').filter({ hasText: 'senior pay line fixture' }).click()
  await expect(page.locator('.job-key-facts')).toContainText('별도 보상 조건')
  await expect(compensationNote(page)).toHaveText(CONTEXT_NOTES.basis)
  // H1: the visible role label and the owned source quote keep the "Sr." qualifier; bare dollars stay an unknown currency.
  await expect(page.locator('.job-compensation dt')).toHaveText(['Sr. Orbit Systems Engineer'])
  await expect(payRows(page)).toHaveText(['통화 미확인 140,000–190,000 / 년 · 구성 미확인'])
  await page.locator('.compensation-evidence > summary').click()
  await expect(page.locator('.compensation-evidence blockquote')).toContainText('Pay range:')
  await expect(page.locator('.compensation-evidence blockquote')).toContainText('Sr. Orbit Systems Engineer: $140,000.00 - $190,000.00/per year')
  await expect(page.getByLabel('이 기회에 대한 나의 메모')).toHaveValue('Keep the senior qualifier')
  await expect(page.getByRole('button', { name: '지원 완료로 표시됨', exact: true })).toBeVisible()
  await closeDialog(page)

  await waitForSavedCommit(page)
  await page.reload()
  const persisted: SavedJob[] = JSON.parse(await readSavedJson(page) || '[]')
  const find = (id: string) => persisted.find(item => item.job.id === id)!
  expect(persisted).toHaveLength(11)
  expect(find(bonusOnly.id)).toMatchObject({
    savedAt: fetchedAt, status: 'applied', note: 'Keep the corrected bonus record',
    job: { compensationVersion: COMPENSATION_VERSION, fetchedAt, description: bonusOnly.description, salary: null, compensationNote: CONTEXT_NOTES.none },
  })
  expect(find(bonusOnly.id).job.compensationRanges).toBeUndefined()
  expect(find(bonusOnly.id).job.compensationEvidence).toHaveLength(1)
  expect(find(twoRows.id)).toMatchObject({ status: 'saved', note: 'Keep the single base range', job: { compensationVersion: COMPENSATION_VERSION, fetchedAt, salary: usd } })
  expect(find(twoRows.id).job.compensationRanges).toHaveLength(1)
  expect(find(reviewed.id).job).toMatchObject({ compensationVersion: COMPENSATION_VERSION, salary: null })
  expect(find(reviewed.id).job.compensationRanges).toEqual([expect.objectContaining({ min: 130000, max: 170000, currency: 'USD', period: 'unknown' })])
  expect(find(boardReview.id)).toMatchObject({ status: 'applied', note: 'Keep the board amounts', job: { compensationVersion: COMPENSATION_VERSION, fetchedAt, salary: null } })
  expect(find(boardReview.id).job.compensationRanges).toEqual([expect.objectContaining({ label: 'Salary Range', ...usd, period: 'unknown', basis: 'base' })])
  expect(find(control.id)).toMatchObject({
    company: { id: CONTEXT_ASHBY_COMPANY.id, provider: 'ashby' }, status: 'applied', note: 'Keep the structured control',
    job: { compensationVersion: COMPENSATION_VERSION, fetchedAt, salary: { min: 100000, max: 140000, currency: 'GBP' } },
  })
  expect(find(control.id).job.compensationRanges).toEqual([expect.objectContaining({ min: 100000, max: 140000, currency: 'GBP', period: 'year', basis: 'base' })])
  expect(find(control.id).job.compensationRanges).toEqual(structuredControl.compensationRanges)
  expect(find(incompleteBoard.id)).toMatchObject({ status: 'applied', note: 'Keep the incomplete board disclosure', job: { compensationVersion: COMPENSATION_VERSION, fetchedAt, salary: null } })
  expect(find(incompleteBoard.id).job.compensationRanges).toEqual([expect.objectContaining({ label: 'Annual base salary', ...usd, period: 'year', basis: 'base' })])
  expect(find(incompleteBoard.id).job.compensationNote).toContain(CONTEXT_NOTES.partial)
  expect(find(malformedMixed.id)).toMatchObject({ status: 'saved', note: 'Keep the malformed salary evidence', job: { compensationVersion: COMPENSATION_VERSION, fetchedAt, salary: null, compensationNote: CONTEXT_NOTES.partial } })
  expect(find(malformedMixed.id).job.compensationRanges).toEqual([CONTEXT_BOARD_COMPLETE_ROW])
  expect(find(malformedMixed.id).job.compensationEvidence?.some(evidence => evidence.source === 'description' && evidence.text.includes('EUR 20.000'))).toBe(true)
  expect(find(earlier.id)).toMatchObject({ note: 'Keep the earlier record', job: { compensationVersion: 3, salary: { min: 88000, max: 124000, currency: 'EUR' } } })
  expect(find(unrelated.id)).toMatchObject({ note: 'Keep the unrelated scalar', job: { compensationVersion: 3, salary: { min: 25000, max: 25000, currency: 'USD' } } })
  expect(find(structured.id).job).toMatchObject({ compensationVersion: COMPENSATION_VERSION, salary: usd })
  expect(find(structured.id).job.compensationRanges![1]).toMatchObject({ label: 'Signing bonus', min: 25000, max: 25000, currency: 'USD', period: 'unknown', basis: 'other' })
  expect(find(senior.id)).toMatchObject({
    savedAt: fetchedAt, status: 'applied', note: 'Keep the senior qualifier',
    job: { compensationVersion: COMPENSATION_VERSION, fetchedAt, title: senior.title, description: senior.description, salary: null, compensationNote: CONTEXT_NOTES.basis },
  })
  expect(find(senior.id).job.compensationRanges).toEqual([{
    label: 'Sr. Orbit Systems Engineer', min: 140000, max: 190000, currency: null, period: 'year', basis: 'unknown',
    evidence: { source: 'description', text: 'Pay range:\nSr. Orbit Systems Engineer: $140,000.00 - $190,000.00/per year' },
  }])
  expect(find(senior.id).job.compensationEvidence).toBeUndefined()

  const download = page.waitForEvent('download')
  await page.getByRole('button', { name: 'CSV 내보내기', exact: true }).click()
  const csv = await readFile((await (await download).path())!, 'utf8')
  // The exporter writes range and compensation evidence, never the description. The mixed
  // record retains only its malformed salary clause as evidence; the following bonus sentence is
  // a rejected finding without a salary subject and must not be concatenated into the export.
  for (const value of [
    baseRow, 'USD 130,000–170,000 / 기간 미확인', 'USD 100,000–120,000 / 기간 미확인', CONTEXT_NOTES.none, CONTEXT_SENTENCES.bonusOnly,
    'GBP 100,000–140,000 / 년', '"€88–124k · 이전 기록"', '"$25–25k · 이전 기록"', otherRow, 'Keep the corrected bonus record',
    CONTEXT_NOTES.partial, 'Annual base salary: EUR 20.000.',
    // H1: the exporter writes each label with its row and again above its owned source quote.
    'Sr. Orbit Systems Engineer: 통화 미확인 140,000–190,000 / 년 · 구성 미확인',
    'Sr. Orbit Systems Engineer: $140,000.00 - $190,000.00/per year', 'Keep the senior qualifier',
  ]) expect(csv).toContain(value)
  for (const value of ['USD 25,000–25,000 / 년', '"$25–25k"', CONTEXT_NOTES.variants, 'Signing bonus: USD 20,000.']) expect(csv).not.toContain(value)
})

test.describe('mobile pay disclosure with rejected and corrected context', () => {
  test.use({ viewport: { width: 320, height: 780 }, isMobile: true, hasTouch: true })
  test('a rejected bonus quote and a recovered annual base stay readable and accessible at 320px', async ({ page }, testInfo) => {
    await restore(page)
    await openPosting(page, 'bonusOnly')
    await expect(page.locator('.job-key-facts')).toContainText('보상 확인 필요')
    await expect(compensationNote(page)).toHaveText(CONTEXT_NOTES.none)
    await expect(payRows(page)).toHaveCount(0)
    await page.locator('.compensation-evidence > summary').click()
    await expect(page.locator('.compensation-evidence blockquote')).toContainText(CONTEXT_SENTENCES.bonusOnly)
    expect(await page.locator('.dialog').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
    expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([])
    // Required visual review capture at 320x780: the no-comparable-range note and the rejected quote.
    await capture(page, testInfo, 'mobile-rejected-compensation.png', page.locator('.compensation-body'), [
      compensationNote(page), page.locator('.compensation-evidence blockquote'),
    ])
    await closeDialog(page)

    await openPosting(page, 'reviewedMonthly')
    await expect(page.locator('.job-key-facts')).toContainText('세전 연봉')
    await expect(page.locator('.job-key-facts')).toContainText('€90–110k')
    await page.locator('.job-compensation > summary').click()
    await expect(payRows(page)).toHaveText(['EUR 90,000–110,000 / 년'])
    await page.locator('.compensation-evidence > summary').click()
    await expect(page.locator('.compensation-evidence blockquote')).toContainText(CONTEXT_SENTENCES.reviewedMonthly)
    expect(await page.locator('.dialog').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
    expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([])
    // Required visual review capture at 320x780: the recovered annual row and its source quote.
    await capture(page, testInfo, 'mobile-corrected-base.png', page.locator('.job-compensation dl'), [
      payRows(page).first(), page.locator('.compensation-evidence blockquote'),
    ])
  })
})
