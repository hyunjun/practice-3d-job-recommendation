import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { readFile } from 'node:fs/promises'
import { normalizeJob } from '../../server/normalize'
import { createJobRevision } from '../../shared/posting-status'
import { DEFAULT_FILTERS } from '../../shared/types'
import type { Catalog, Job } from '../../shared/types'
import {
  OUTSIDE_SCOPE_CASES, TECHNICAL_SCOPE_CASES, CONFIRMED_EXTRA_SCOPE_CASES, SCOPE_COMPANY, SCOPE_TIME, SCOPE_NEXT_TIME,
  FLIGHT_SOFTWARE_INFRASTRUCTURE_CASE, legacyScopeJob, legacyScopeSaved, scopeJob,
} from '../fixtures/occupation-title-scope'
import type { ScopeCase } from '../fixtures/occupation-title-scope'
import { SEARCH_PROFILE, searchCatalog } from '../fixtures/search-catalog'
import { readSaved, waitForSavedCommit } from './helpers/saved-store'

// Confirmed format: new assessments use v4; legacy v1/v2/v3 remain readable.
const savedMenu = (page: Page) => page.getByRole('navigation', { name: '주요 메뉴' }).getByRole('button', { name: /저장한 기회/ })
const close = (page: Page) => page.getByRole('button', { name: '닫기', exact: true }).click()

function catalogWith(jobs: Job[], total: number, refreshed = false): Catalog {
  const time = refreshed ? SCOPE_NEXT_TIME : SCOPE_TIME
  return {
    ...searchCatalog([]), fetchedAt: time, checkedAt: time, stale: false,
    refreshAfter: refreshed ? '2026-09-26T07:03:00.000Z' : '2026-09-26T07:01:00.000Z',
    companies: [{ ...SCOPE_COMPANY, name: refreshed ? 'Fable Orbit Studio Revised' : 'Fable Orbit Studio' }],
    jobs, unmappedCount: 0,
    boards: [{
      companyId: 'fable-orbit', provider: 'greenhouse', board: 'fable-orbit',
      status: 'ok', dataStatus: 'fresh', total, included: jobs.length,
      checkedAt: time, lastSuccessAt: time, retryAt: null,
    }],
  }
}

function freshCatalog(refreshed = false): Catalog {
  const cases: [number, ScopeCase][] = [
    [101, OUTSIDE_SCOPE_CASES[1]], [102, OUTSIDE_SCOPE_CASES[0]],
    [103, OUTSIDE_SCOPE_CASES[3]], [104, OUTSIDE_SCOPE_CASES[4]],
    [105, TECHNICAL_SCOPE_CASES[0]],
    [106, refreshed ? {
      ...TECHNICAL_SCOPE_CASES[2], title: 'Frontend Engineer, Community Workspace',
      description: 'Responsibilities\nImplement frontend software for a fictional community workspace.\nRequirements\nExperience with TypeScript and frontend software development.',
    } : TECHNICAL_SCOPE_CASES[2]],
    [108, CONFIRMED_EXTRA_SCOPE_CASES[0]],
    [109, FLIGHT_SOFTWARE_INFRASTRUCTURE_CASE],
  ]
  if (refreshed) cases.push([107, {
    ...TECHNICAL_SCOPE_CASES[2], title: 'Frontend Engineer, Developer Access Tools',
    description: 'Responsibilities\nBuild frontend software for a fictional access-control dashboard.\nRequirements\nExperience with TypeScript and frontend software development.',
  }])
  // Production normalization is the subject of the test, not the expected value.
  // Visible titles and counts below remain independent literal expectations.
  const jobs = cases.map(([id, fixture]) => normalizeJob({
    id, title: fixture.title, location: { name: 'London, UK' },
    departments: fixture.departments.map(name => ({ name })),
    content: fixture.description.split('\n').map(line => `<p>${line}</p>`).join(''),
    absolute_url: `https://example.org/fable-orbit/${id}`,
  }, 'fable-orbit', refreshed ? SCOPE_NEXT_TIME : SCOPE_TIME)).filter((job): job is Job => job !== null)
  return catalogWith(jobs, refreshed ? 9 : 8, refreshed)
}

async function seedExploration(page: Page) {
  await page.addInitScript(({ profile, filters }) => {
    if (sessionStorage.getItem('occupation-title-scope-exploration-seeded')) return
    localStorage.setItem('orbit.v1.profile', JSON.stringify(profile))
    localStorage.setItem('orbit.v1.exploration', JSON.stringify({
      source: 'public', mapMode: 'flat', selectedId: 'london', panelTab: 'cities', filters,
    }))
    sessionStorage.setItem('occupation-title-scope-exploration-seeded', 'true')
  }, { profile: { ...SEARCH_PROFILE, desiredRole: 'all', skills: [] }, filters: DEFAULT_FILTERS })
}

async function expectVisibleTitles(page: Page, sortedLiteralTitles: string[]) {
  await expect.poll(async () => (await page.locator('.mini-job-title').allTextContents()).map(text => text.trim()).sort())
    .toEqual(sortedLiteralTitles)
}

function csvRecords(text: string): Record<string, string>[] {
  const cells = (value: string) => [...value.matchAll(/"((?:[^"]|"")*)"(?:,|\r\n|$)/g)].map(match => match[1].replaceAll('""', '"'))
  const headers = cells(text.slice(0, text.indexOf('\r\n')))
  const values = cells(text).slice(headers.length)
  expect(values.length % headers.length).toBe(0)
  return Array.from({ length: values.length / headers.length }, (_, index) =>
    Object.fromEntries(headers.map((header, column) => [header, values[index * headers.length + column]])))
}

for (const width of [1440, 320]) {
  test(`fresh title scope and a refreshed search keep literal results and the original saved source at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 960 })
    await page.clock.setFixedTime(new Date('2026-09-26T07:00:10.000Z'))
    await seedExploration(page)
    const first = freshCatalog()
    const next = freshCatalog(true)
    let refreshed = false
    const errors: string[] = []
    const requests: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await page.route('**/api/catalog?source=public*', route => {
      requests.push(new URL(route.request().url()).pathname + new URL(route.request().url()).search)
      return route.fulfill({ json: refreshed ? next : first })
    })
    await page.goto('/')
    await waitForSavedCommit(page)
    await expect(page.locator('.city-detail-count strong')).toHaveText(['1', '3'])
    await page.getByRole('button', { name: '전체 3개 공고 보기', exact: true }).click()
    await expectVisibleTitles(page, [
      'Flight Software Infrastructure Engineer',
      'Frontend Engineer, Developer Community', 'Software Engineer, Product Designer Tools',
    ])
    const search = page.getByLabel('도시, 회사 또는 포지션 검색')
    const role = page.getByLabel('직무 필터', { exact: true })
    await search.fill('Product Designer')
    await expectVisibleTitles(page, ['Software Engineer, Product Designer Tools'])
    await search.fill('Administrative')
    await expect(page.locator('.mini-job-title')).toHaveCount(0)
    await search.fill('Aerodynamics')
    await expect(page.locator('.mini-job-title')).toHaveCount(0)
    await search.fill('Coordinator')
    await expect(page.locator('.mini-job-title')).toHaveCount(0)
    await search.fill('Flight')
    await expectVisibleTitles(page, ['Flight Software Infrastructure Engineer'])
    await expect(page.locator('.mini-job-role')).toHaveText('인프라 · DevOps')
    await search.fill('Developer')
    await role.selectOption('frontend')
    await expectVisibleTitles(page, ['Frontend Engineer, Developer Community'])
    await page.getByRole('button', { name: 'Frontend Engineer, Developer Community', exact: true }).click()
    await expect(page.getByRole('region', { name: '직무 분류', exact: true })).toContainText('프론트엔드')
    await page.getByRole('button', { name: '기회 저장', exact: true }).click()
    await page.getByLabel('이 기회에 대한 나의 메모').fill('Fictional computing note before refresh.')
    await page.getByRole('button', { name: '지원 완료로 표시', exact: true }).click()
    await close(page)
    await waitForSavedCommit(page)
    const originalSaved = await readSaved(page)
    expect(originalSaved).toHaveLength(1)
    expect(originalSaved[0]).toMatchObject({
      savedAt: '2026-09-26T07:00:10.000Z', status: 'applied', note: 'Fictional computing note before refresh.',
      job: {
        id: 'greenhouse-fable-orbit-106', title: 'Frontend Engineer, Developer Community',
        description: TECHNICAL_SCOPE_CASES[2].description,
        fetchedAt: '2026-09-26T07:00:00.000Z', occupation: { version: 4, category: 'engineering' },
        url: 'https://example.org/fable-orbit/106',
      },
    })

    refreshed = true
    await page.clock.setFixedTime(new Date('2026-09-26T07:02:10.000Z'))
    await page.getByRole('button', { name: '공개 채용', exact: true }).click()
    await expect(page.getByRole('button', { name: '새로고침', exact: true })).toBeEnabled()
    await page.getByRole('button', { name: '새로고침', exact: true }).click()
    await expectVisibleTitles(page, ['Frontend Engineer, Developer Access Tools'])
    await close(page)
    await expect(search).toHaveValue('Developer')
    await expect(role).toHaveValue('frontend')
    await expect(page.locator('.city-detail-count strong')).toHaveText(['1', '1'])
    await expect(page.locator('.company-card h3')).toHaveText('Fable Orbit Studio Revised')
    expect(requests).toContain('/api/catalog?source=public&refresh=1')
    await search.fill('Revised')
    await expect(page.locator('.city-detail-count strong')).toHaveText(['1', '2'])
    await page.getByRole('button', { name: '전체 2개 공고 보기', exact: true }).click()
    await expectVisibleTitles(page, [
      'Frontend Engineer, Community Workspace', 'Frontend Engineer, Developer Access Tools',
    ])
    await role.selectOption('all')
    await expectVisibleTitles(page, [
      'Flight Software Infrastructure Engineer',
      'Frontend Engineer, Community Workspace', 'Frontend Engineer, Developer Access Tools',
      'Software Engineer, Product Designer Tools',
    ])
    await expect(page.locator('.city-detail-count strong')).toHaveText(['1', '4'])
    expect(await readSaved(page)).toEqual(originalSaved)
    await savedMenu(page).click()
    await expect(page.locator('.saved-title')).toHaveText('Frontend Engineer, Developer Community')
    await expect(page.locator('.saved-note-preview')).toHaveText('Fictional computing note before refresh.')
    await expect(page.locator('.saved-status')).toHaveText('지원 완료')
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    expect((await new AxeBuilder({ page }).include('.collection-page').analyze()).violations).toEqual([])
    await page.reload()
    expect(await readSaved(page)).toEqual(originalSaved)
    expect(errors).toEqual([])
  })

  test(`v3 scope changes preserve saved content, notes, application state and listed status at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 960 })
    await page.clock.setFixedTime(new Date('2026-09-26T07:00:10.000Z'))
    await seedExploration(page)
    await page.addInitScript(record => {
      if (sessionStorage.getItem('occupation-title-scope-saved-seeded')) return
      localStorage.setItem('orbit.v1.saved', JSON.stringify([record]))
      sessionStorage.setItem('occupation-title-scope-saved-seeded', 'true')
    }, legacyScopeSaved(3))
    const developer = scopeJob(TECHNICAL_SCOPE_CASES[0])
    const originalCatalog = catalogWith([legacyScopeJob(), developer], 2)
    await page.route('**/api/catalog?source=public*', route => route.fulfill({ json: originalCatalog }))
    const index = {
      version: 1, checkedAt: SCOPE_TIME, refreshAfter: '2026-09-26T07:01:00.000Z',
      boards: [{
        companyId: 'fable-orbit', provider: 'greenhouse', board: 'fable-orbit',
        status: 'ok', checkedAt: SCOPE_TIME, lastSuccessAt: SCOPE_TIME, retryAt: null,
        listing: {
          validUntil: '2026-09-26T07:30:00.000Z',
          publishedIds: ['greenhouse-fable-orbit-administrator', 'greenhouse-fable-orbit-designer-tools'],
          jobs: [{
            id: 'greenhouse-fable-orbit-designer-tools', title: 'Software Engineer, Product Designer Tools',
            url: 'https://example.org/fable-orbit/designer-tools', revision: await createJobRevision(developer),
          }],
        },
      }],
    }
    await page.route('**/api/posting-status*', route => route.fulfill({ json: index }))
    const errors: string[] = []
    const requests: { path: string; body: string | null; method: string }[] = []
    page.on('pageerror', error => errors.push(error.message))
    page.on('request', request => {
      const url = new URL(request.url())
      if (url.pathname.startsWith('/api/')) requests.push({
        path: url.pathname + url.search, body: request.postData(), method: request.method(),
      })
    })
    await page.goto('/')
    await expectVisibleTitles(page, ['Software Engineer, Product Designer Tools'])
    await expect(page.locator('.city-detail-count strong')).toHaveText(['1', '1'])
    await savedMenu(page).click()
    await expect(page.locator('.saved-card')).toHaveCount(1)
    await expect(page.locator('.saved-role')).toHaveText('기타 직군')
    await expect(page.locator('.occupation-notice')).toContainText('현재 탐색 범위 밖 · 기타 직군')
    await expect(page.locator('.saved-note-preview')).toHaveText('Fictional note: confirm the office schedule.')
    await expect(page.locator('.saved-status')).toHaveText('지원 완료')
    const savedSearch = page.getByRole('textbox', { name: '저장한 기회 검색', exact: true })
    await savedSearch.fill('인프라')
    await expect(page.locator('.saved-card')).toHaveCount(0)
    await savedSearch.fill('기타 직군')
    await expect(page.locator('.saved-title')).toHaveText('Administrative Business Partner - Engineering, Product and Design')
    await savedSearch.fill('')
    await page.getByRole('button', { name: '게시 상태 확인', exact: true }).click()
    await expect(page.locator('.posting-notice.listed')).toContainText('게시판에는 있지만 현재 탐색 범위 밖')
    await expect(page.locator('.posting-notice.changed, .posting-notice.missing')).toHaveCount(0)
    await page.locator('.saved-title').click()
    const detail = page.getByRole('region', { name: '직무 분류', exact: true })
    await expect(detail.locator(':scope > strong')).toHaveText('기타 직군')
    await expect(detail).toContainText('공개 부서·팀: Core Engineering')
    await expect(page.locator('.job-dialog .occupation-notice')).toContainText('채용 종료를 뜻하지 않으며')
    await page.getByText('탐색 직군을 판단한 원문', { exact: true }).click()
    await expect(detail.locator('.occupation-evidence')).toContainText('Administrative Business Partner')
    await page.locator('.original-description summary').click()
    await expect(page.locator('.original-description .job-description')).toHaveText(OUTSIDE_SCOPE_CASES[1].description)
    await expect(page.getByRole('link', { name: '원문에서 지원하기', exact: true })).toHaveAttribute('href', 'https://example.org/fable-orbit/administrator')
    await expect(page.getByLabel('이 기회에 대한 나의 메모')).toHaveValue('Fictional note: confirm the office schedule.')
    await expect(page.getByRole('button', { name: '지원 완료로 표시됨', exact: true })).toBeVisible()
    await page.getByLabel('이 기회에 대한 나의 메모').fill('Fictional revised note: keep the original opportunity.')
    await page.getByRole('button', { name: '지원 완료로 표시됨', exact: true }).click()
    await expect(page.getByRole('button', { name: '지원 완료로 표시', exact: true })).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    expect((await new AxeBuilder({ page }).include('.job-dialog').analyze()).violations).toEqual([])
    await close(page)
    await waitForSavedCommit(page)
    await page.reload()
    await savedMenu(page).click()
    const records = await readSaved(page)
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({
      savedAt: '2026-09-25T09:15:00.000Z', status: 'saved',
      note: 'Fictional revised note: keep the original opportunity.',
      job: {
        id: 'greenhouse-fable-orbit-administrator',
        title: 'Administrative Business Partner - Engineering, Product and Design',
        description: OUTSIDE_SCOPE_CASES[1].description, requirements: [],
        url: 'https://example.org/fable-orbit/administrator', fetchedAt: '2026-09-26T07:00:00.000Z',
        occupation: { version: 4, category: 'other', departments: ['Core Engineering'] },
      },
    })
    await expect(page.locator('.saved-role')).toHaveText('기타 직군')
    const csvDownload = page.waitForEvent('download')
    await page.getByRole('button', { name: 'CSV 내보내기', exact: true }).click()
    const exported = csvRecords(await readFile((await (await csvDownload).path())!, 'utf8'))
    expect(exported).toHaveLength(1)
    expect(exported[0]).toMatchObject({
      '포지션': 'Administrative Business Partner - Engineering, Product and Design',
      '직무 분류': '기타 직군', '직무 분류 근거': '', '탐색 직군': '기타 직군',
      '저장일': '2026-09-25T09:15:00.000Z', '저장 내용의 조회 시각': '2026-09-26T07:00:00.000Z',
      '메모': 'Fictional revised note: keep the original opportunity.',
    })
    await page.getByRole('button', { name: '기록 백업·복원', exact: true }).click()
    const jsonDownload = page.waitForEvent('download')
    await page.getByRole('button', { name: 'JSON 백업', exact: true }).click()
    expect(JSON.parse(await readFile((await (await jsonDownload).path())!, 'utf8'))).toMatchObject({
      format: 'orbit-saved-backup', version: 1, records,
    })
    for (const request of requests) {
      expect(['/api/catalog?source=public', '/api/posting-status?refresh=1']).toContain(request.path)
      expect(request.method).toBe('GET')
      expect(request.body).toBeNull()
    }
    expect(errors).toEqual([])
  })
}
