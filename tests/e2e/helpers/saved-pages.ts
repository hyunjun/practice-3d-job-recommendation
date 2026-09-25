import { expect } from '@playwright/test'
import type { Locator, Page } from '@playwright/test'
import type { Company, Job, Profile, SavedJob } from '../../../shared/types'
import type { PostingStatusIndex } from '../../../shared/posting-status'
import { waitForSavedCommit } from './saved-store'

export const SAVED_PAGES_TIME = '2026-09-26T08:00:10.000Z'
const SAVED_AT = '2026-09-25T08:00:00.000Z'

const fable: Company = {
  id: 'fable-labs', name: 'Fable Labs', initials: 'FL', color: '#84dba6',
  industry: 'Fictional software studio', careerUrl: 'https://example.org/fable/careers',
  provider: 'greenhouse', board: 'fable-labs',
}
const kite: Company = {
  id: 'paper-kite', name: 'Paper Kite', initials: 'PK', color: '#84dba6',
  industry: 'Fictional software studio', careerUrl: 'https://example.org/kite/careers',
  provider: 'greenhouse', board: 'paper-kite',
}
const privateProfile: Profile = {
  kind: 'personal', name: 'PRIVATE-PROFILE-SAVED53', headline: 'PRIVATE-RESUME-SAVED53',
  years: 4, skills: ['Python'], desiredRole: 'backend', residence: 'KR',
  linkedinUrl: 'https://example.org/PRIVATE-LINK-SAVED53',
}

// Deliberately fictional records. The first 13 are under review; the other 12
// are applied. Search notes, IDs, ordering, and expected pages are authored here,
// without using the application's matching, pagination, or normalization code.
const rows: [string, string, SavedJob['status'], string][] = [
  ['greenhouse-fable-labs-01', 'Fable 01 · Backend Engineer', 'saved', 'PRIVATE-SAVED53 CohortNorth note 01'],
  ['greenhouse-fable-labs-02', 'Fable 02 · Backend Engineer', 'saved', 'PRIVATE-SAVED53 CohortNorth note 02'],
  ['greenhouse-fable-labs-03', 'Fable 03 · Backend Engineer', 'saved', 'PRIVATE-SAVED53 CohortNorth note 03'],
  ['greenhouse-fable-labs-04', 'Fable 04 · Backend Engineer', 'saved', 'PRIVATE-SAVED53 CohortNorth note 04'],
  ['greenhouse-fable-labs-05', 'Fable 05 · Backend Engineer', 'saved', 'PRIVATE-SAVED53 CohortNorth note 05'],
  ['greenhouse-fable-labs-06', 'Fable 06 · Backend Engineer', 'saved', 'PRIVATE-SAVED53 CohortNorth note 06'],
  ['greenhouse-fable-labs-07', 'Fable 07 · Backend Engineer', 'saved', 'PRIVATE-SAVED53 CohortNorth note 07'],
  ['greenhouse-fable-labs-08', 'Fable 08 · Backend Engineer', 'saved', 'PRIVATE-SAVED53 CohortNorth note 08'],
  ['greenhouse-fable-labs-09', 'Fable 09 · Backend Engineer', 'saved', 'PRIVATE-SAVED53 CohortNorth note 09'],
  ['greenhouse-fable-labs-10', 'Fable 10 · Backend Engineer', 'saved', 'PRIVATE-SAVED53 CohortNorth note 10'],
  ['greenhouse-fable-labs-11', 'Fable 11 · Backend Engineer', 'saved', 'PRIVATE-SAVED53 CohortNorth note 11'],
  ['greenhouse-fable-labs-12', 'Fable 12 · Backend Engineer', 'saved', 'PRIVATE-SAVED53 CohortNorth note 12'],
  ['greenhouse-fable-labs-13', 'Fable 13 · Backend Engineer', 'saved', 'PRIVATE-SAVED53 CohortNorth note 13'],
  ['greenhouse-fable-labs-14', 'Fable 14 · Backend Engineer', 'applied', 'PRIVATE-SAVED53 CohortSouth note 14'],
  ['greenhouse-fable-labs-15', 'Fable 15 · Backend Engineer', 'applied', 'PRIVATE-SAVED53 CohortSouth note 15'],
  ['greenhouse-fable-labs-16', 'Fable 16 · Backend Engineer', 'applied', 'PRIVATE-SAVED53 CohortSouth note 16'],
  ['greenhouse-fable-labs-17', 'Fable 17 · Backend Engineer', 'applied', 'PRIVATE-SAVED53 CohortSouth note 17'],
  ['greenhouse-fable-labs-18', 'Fable 18 · Backend Engineer', 'applied', 'PRIVATE-SAVED53 CohortSouth note 18'],
  ['greenhouse-fable-labs-19', 'Fable 19 · Backend Engineer', 'applied', 'PRIVATE-SAVED53 CohortSouth note 19'],
  ['greenhouse-fable-labs-20', 'Fable 20 · Backend Engineer', 'applied', 'PRIVATE-SAVED53 CohortSouth note 20'],
  ['greenhouse-fable-labs-21', 'Fable 21 · Backend Engineer', 'applied', 'PRIVATE-SAVED53 CohortSouth note 21'],
  ['greenhouse-fable-labs-22', 'Fable 22 · Backend Engineer', 'applied', 'PRIVATE-SAVED53 CohortSouth note 22'],
  ['greenhouse-fable-labs-23', 'Fable 23 · Backend Engineer', 'applied', 'PRIVATE-SAVED53 CohortSouth note 23'],
  ['greenhouse-fable-labs-24', 'Fable 24 · Backend Engineer', 'applied', 'PRIVATE-SAVED53 CohortSouth note 24'],
  ['greenhouse-paper-kite-25', 'Kite 25 · Backend Engineer', 'applied', '=1+2\nPRIVATE-SAVED53 CohortSouth Needle25, "가상 메모" 🌕'],
]

type SavedPageCount = 0 | 1 | 12 | 13 | 25 | 500

export function savedPageRecords(count: SavedPageCount = 25): SavedJob[] {
  const selectedRows = count === 500 ? [
    ...rows,
    ...Array.from({ length: 475 }, (_, index): typeof rows[number] => [
      `greenhouse-fable-labs-${index + 26}`, `Fable ${index + 26} · Backend Engineer`,
      'saved', `PRIVATE-SAVED53 CohortNorth note ${index + 26}`,
    ]),
  ] : rows.slice(0, count)
  return selectedRows.map(([id, title, status, note]) => {
    const company = id === 'greenhouse-paper-kite-25' ? kite : fable
    const job: Job = {
      id, title, companyId: company.id, role: 'backend', cityIds: ['london'],
      locationLabel: 'London, UK', workMode: 'hybrid', employment: 'fulltime',
      minExperience: 3, skills: ['Python'], salary: null, visa: 'unknown',
      remoteCountries: [], remoteWorldwide: false, remoteScopeUnknown: false,
      description: 'Fictional backend software engineering role. Required: 3 years of software engineering experience with Python.',
      requirements: ['3 years of software engineering experience with Python.'],
      url: `https://example.org/saved-pages/${id}`, source: 'greenhouse',
      updatedAt: null, fetchedAt: '2026-09-26T07:00:00.000Z',
    }
    return { job, company: { ...company }, savedAt: SAVED_AT, status, note }
  })
}

// These are literal expectations, not slices of the fixture or app results.
export const FIRST_TITLES = [
  'Fable 01 · Backend Engineer', 'Fable 02 · Backend Engineer', 'Fable 03 · Backend Engineer',
  'Fable 04 · Backend Engineer', 'Fable 05 · Backend Engineer', 'Fable 06 · Backend Engineer',
  'Fable 07 · Backend Engineer', 'Fable 08 · Backend Engineer', 'Fable 09 · Backend Engineer',
  'Fable 10 · Backend Engineer', 'Fable 11 · Backend Engineer', 'Fable 12 · Backend Engineer',
]
export const SECOND_TITLES = [
  'Fable 13 · Backend Engineer', 'Fable 14 · Backend Engineer', 'Fable 15 · Backend Engineer',
  'Fable 16 · Backend Engineer', 'Fable 17 · Backend Engineer', 'Fable 18 · Backend Engineer',
  'Fable 19 · Backend Engineer', 'Fable 20 · Backend Engineer', 'Fable 21 · Backend Engineer',
  'Fable 22 · Backend Engineer', 'Fable 23 · Backend Engineer', 'Fable 24 · Backend Engineer',
]
export const APPLIED_TITLES = [
  'Fable 14 · Backend Engineer', 'Fable 15 · Backend Engineer', 'Fable 16 · Backend Engineer',
  'Fable 17 · Backend Engineer', 'Fable 18 · Backend Engineer', 'Fable 19 · Backend Engineer',
  'Fable 20 · Backend Engineer', 'Fable 21 · Backend Engineer', 'Fable 22 · Backend Engineer',
  'Fable 23 · Backend Engineer', 'Fable 24 · Backend Engineer', 'Kite 25 · Backend Engineer',
]
export const UNDO_SECOND_TITLES = [
  'Fable 12 · Backend Engineer', 'Fable 13 · Backend Engineer', 'Fable 14 · Backend Engineer',
  'Fable 15 · Backend Engineer', 'Fable 16 · Backend Engineer', 'Fable 17 · Backend Engineer',
  'Fable 18 · Backend Engineer', 'Fable 19 · Backend Engineer', 'Fable 20 · Backend Engineer',
  'Fable 21 · Backend Engineer', 'Fable 22 · Backend Engineer', 'Fable 23 · Backend Engineer',
]
export const ALL_IDS = [
  'greenhouse-fable-labs-01', 'greenhouse-fable-labs-02', 'greenhouse-fable-labs-03',
  'greenhouse-fable-labs-04', 'greenhouse-fable-labs-05', 'greenhouse-fable-labs-06',
  'greenhouse-fable-labs-07', 'greenhouse-fable-labs-08', 'greenhouse-fable-labs-09',
  'greenhouse-fable-labs-10', 'greenhouse-fable-labs-11', 'greenhouse-fable-labs-12',
  'greenhouse-fable-labs-13', 'greenhouse-fable-labs-14', 'greenhouse-fable-labs-15',
  'greenhouse-fable-labs-16', 'greenhouse-fable-labs-17', 'greenhouse-fable-labs-18',
  'greenhouse-fable-labs-19', 'greenhouse-fable-labs-20', 'greenhouse-fable-labs-21',
  'greenhouse-fable-labs-22', 'greenhouse-fable-labs-23', 'greenhouse-fable-labs-24',
  'greenhouse-paper-kite-25',
]

export const POSTING_INDEX: PostingStatusIndex = {
  version: 1, checkedAt: '2026-09-26T08:00:00.000Z', refreshAfter: '2026-09-26T08:01:00.000Z',
  boards: [
    {
      companyId: 'fable-labs', provider: 'greenhouse', board: 'fable-labs', status: 'ok',
      checkedAt: '2026-09-26T08:00:00.000Z', lastSuccessAt: '2026-09-26T08:00:00.000Z', retryAt: null,
      listing: {
        validUntil: '2026-09-26T08:30:00.000Z',
        publishedIds: [
          'greenhouse-fable-labs-01', 'greenhouse-fable-labs-02', 'greenhouse-fable-labs-03',
          'greenhouse-fable-labs-04', 'greenhouse-fable-labs-05', 'greenhouse-fable-labs-06',
          'greenhouse-fable-labs-07', 'greenhouse-fable-labs-08', 'greenhouse-fable-labs-09',
          'greenhouse-fable-labs-10', 'greenhouse-fable-labs-11', 'greenhouse-fable-labs-12',
          'greenhouse-fable-labs-13',
        ],
        jobs: [{
          id: 'greenhouse-fable-labs-13', title: 'Fable 13 · Revised fictional opening',
          url: 'https://example.org/saved-pages/revised-13',
          // A deliberately different published revision; no application digest
          // function is used to calculate this fixture or the expected count.
          revision: {
            title: '0000000000000000000000000000000000000000000000000000000000000000',
            location: '0000000000000000000000000000000000000000000000000000000000000000',
            conditions: '0000000000000000000000000000000000000000000000000000000000000000',
            compensation: '0000000000000000000000000000000000000000000000000000000000000000',
            qualifications: '0000000000000000000000000000000000000000000000000000000000000000',
            description: '0000000000000000000000000000000000000000000000000000000000000000',
            url: '0000000000000000000000000000000000000000000000000000000000000000',
          },
        }],
      },
    },
    {
      companyId: 'paper-kite', provider: 'greenhouse', board: 'paper-kite', status: 'error',
      checkedAt: '2026-09-26T08:00:00.000Z', lastSuccessAt: null,
      retryAt: '2026-09-26T08:05:00.000Z', message: 'Fictional board unavailable',
    },
  ],
}

export function thirteenChangedPostings(): PostingStatusIndex {
  const index = structuredClone(POSTING_INDEX)
  const differentRevision = index.boards[0].listing!.jobs[0].revision
  index.boards[0].listing!.jobs = savedPageRecords(13).map(({ job }) => ({
    id: job.id, title: `Revised fictional opening: ${job.title}`, url: job.url,
    revision: { ...differentRevision },
  }))
  return index
}

export async function openSavedPages(page: Page, count: SavedPageCount = 25) {
  await page.clock.setFixedTime(new Date(SAVED_PAGES_TIME))
  await page.addInitScript(({ records, profile }) => {
    // Reloads must read the committed collection, including deletions and edits.
    if (!sessionStorage.getItem('saved-pages-fixture-seeded')) {
      localStorage.setItem('orbit.v1.saved', JSON.stringify(records))
      localStorage.setItem('orbit.v1.profile', JSON.stringify(profile))
      localStorage.setItem('orbit.v1.exploration', JSON.stringify({ source: 'sample', mapMode: 'flat' }))
      sessionStorage.setItem('saved-pages-fixture-seeded', '1')
    }
  }, { records: savedPageRecords(count), profile: privateProfile })
  await page.goto('/#saved')
  await waitForSavedCommit(page)
  await expect(page.getByRole('textbox', { name: '저장한 기회 검색', exact: true })).toBeVisible()
}

export function savedPager(page: Page, position: '위' | '아래' = '위') {
  return page.getByRole('navigation', { name: `저장한 기회 페이지 이동 (${position})`, exact: true })
}

export function savedCard(page: Page, title: string) {
  return page.locator('.saved-card').filter({ has: page.getByRole('button', { name: title, exact: true }) })
}

export async function expectSavedPage(page: Page, titles: string[], summary: string) {
  await expect(page.locator('.saved-title')).toHaveText(titles)
  await expect(page.locator('.saved-card')).toHaveCount(titles.length)
  await expect(page.getByRole('status').filter({ hasText: /^\d+개 기회(?: 중 .+개 표시)?$/ })).toHaveText(summary)
}

export async function expectSavedTotals(page: Page, totals: [number, number, number]) {
  const [all, saved, applied] = totals
  await expect(page.locator('.collection-tabs button')).toHaveText([
    `전체${all}`, `검토 중${saved}`, `지원 완료${applied}`,
  ])
  await expect(page.locator('.main-nav .nav-count').first()).toHaveText(String(all))
}

export async function expectPagerState(page: Page, indicator: string, first: boolean, last: boolean) {
  for (const position of ['위', '아래'] as const) {
    const pager = savedPager(page, position)
    await expect(pager).toBeVisible()
    expect(await pager.ariaSnapshot()).toContain(indicator)
    for (const name of ['처음 저장 페이지', '이전 저장 페이지']) {
      if (first) await expect(pager.getByRole('button', { name, exact: true })).toBeDisabled()
      else await expect(pager.getByRole('button', { name, exact: true })).toBeEnabled()
    }
    for (const name of ['다음 저장 페이지', '마지막 저장 페이지']) {
      if (last) await expect(pager.getByRole('button', { name, exact: true })).toBeDisabled()
      else await expect(pager.getByRole('button', { name, exact: true })).toBeEnabled()
    }
  }
}

export async function expectRevealedTitle(page: Page, title: string) {
  const first = page.locator('.saved-title').first()
  await expect(first).toHaveText(title)
  await expect(first).toBeFocused()
  await expect(first).toBeInViewport({ ratio: 1 })
  const visible = await first.evaluate(element => {
    const rect = element.getBoundingClientRect()
    const bottomNav = document.querySelector('.main-nav')
    const limit = bottomNav && getComputedStyle(bottomNav).position === 'fixed'
      ? bottomNav.getBoundingClientRect().top : innerHeight
    return { top: rect.top, bottom: rect.bottom, limit }
  })
  expect(visible.top).toBeGreaterThanOrEqual(0)
  expect(visible.bottom).toBeLessThanOrEqual(visible.limit)
}

export async function expectPagerGeometry(pager: Locator) {
  const viewportWidth = await pager.page().evaluate(() => innerWidth)
  const rects = await pager.getByRole('button').evaluateAll(buttons => buttons.map(button => {
    const rect = button.getBoundingClientRect()
    return { name: button.getAttribute('aria-label'), x: rect.x, y: rect.y, width: rect.width, height: rect.height }
  }))
  expect(rects).toHaveLength(4)
  for (const rect of rects) {
    expect(rect.width, `${rect.name} touch width`).toBeGreaterThanOrEqual(44)
    expect(rect.height, `${rect.name} touch height`).toBeGreaterThanOrEqual(44)
    expect(rect.x, `${rect.name} left bound`).toBeGreaterThanOrEqual(0)
    expect(rect.x + rect.width, `${rect.name} right bound`).toBeLessThanOrEqual(viewportWidth)
  }
  for (let a = 0; a < rects.length; a++) for (let b = a + 1; b < rects.length; b++) {
    const first = rects[a]
    const second = rects[b]
    const width = Math.min(first.x + first.width, second.x + second.width) - Math.max(first.x, second.x)
    const height = Math.min(first.y + first.height, second.y + second.height) - Math.max(first.y, second.y)
    expect(width > 0 && height > 0, `${first.name} overlaps ${second.name}`).toBe(false)
  }
}

/** Read RFC 4180 quoted fields, including multiline notes, independently of the exporter. */
export function parseSavedCsv(text: string): string[][] {
  const result: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  const value = text.replace(/^\uFEFF/, '')
  for (let index = 0; index < value.length; index++) {
    const char = value[index]
    if (char === '"') {
      if (quoted && value[index + 1] === '"') { field += '"'; index++ }
      else quoted = !quoted
    } else if (!quoted && char === ',') { row.push(field); field = '' }
    else if (!quoted && (char === '\r' || char === '\n')) {
      if (char === '\r' && value[index + 1] === '\n') index++
      row.push(field); result.push(row); row = []; field = ''
    } else field += char
  }
  if (quoted) throw new Error('CSV contains an unterminated quoted field')
  if (row.length || field.length) { row.push(field); result.push(row) }
  return result
}
