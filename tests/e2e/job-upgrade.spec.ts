import { expect, test } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { readFile } from 'node:fs/promises'
import { createJobRevision } from '../../shared/posting-status'
import { DEFAULT_FILTERS } from '../../shared/types'
import { currentUpgradeJob, legacyUpgradeJob, UPGRADE_TITLE } from '../fixtures/job-upgrade'
import { SEARCH_COMPANIES, SEARCH_PROFILE, SEARCH_TIME, searchCatalog } from '../fixtures/search-catalog'
import { expectInitialCatalogRequest, watchApiRequests } from './helpers/api-requests'
import { readSaved, waitForSavedCommit } from './helpers/saved-store'

function csvRecord(text: string): Record<string, string> {
  const cells = (value: string) => [...value.matchAll(/"((?:[^"]|"")*)"(?:,|\r\n|$)/g)].map(match => match[1].replaceAll('""', '"'))
  const headers = cells(text.slice(0, text.indexOf('\r\n')))
  const values = cells(text).slice(headers.length)
  expect(values).toHaveLength(headers.length)
  return Object.fromEntries(headers.map((header, column) => [header, values[column]]))
}

for (const width of [1440, 320]) {
  test(`an older public response keeps the same qualifications before and after saving at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 960 })
    const now = new Date(Date.parse(SEARCH_TIME) + 10_000)
    await page.clock.setFixedTime(now)
    const previous = legacyUpgradeJob()
    const current = currentUpgradeJob()
    const company = SEARCH_COMPANIES[0]
    await page.addInitScript(({ profile, filters }) => {
      if (sessionStorage.getItem('job-upgrade-seeded')) return
      localStorage.setItem('orbit.v1.profile', JSON.stringify(profile))
      localStorage.setItem('orbit.v1.exploration', JSON.stringify({
        source: 'public', mapMode: 'flat', selectedId: 'london', panelTab: 'cities', filters,
      }))
      sessionStorage.setItem('job-upgrade-seeded', 'true')
    }, { profile: { ...SEARCH_PROFILE, desiredRole: 'all', skills: ['TypeScript'], years: 2 }, filters: DEFAULT_FILTERS })
    await page.route('**/api/catalog?source=public*', route => route.fulfill({ json: searchCatalog([previous]) }))
    const statusIndex = {
      version: 1, checkedAt: SEARCH_TIME, refreshAfter: new Date(now.getTime() + 60_000).toISOString(),
      boards: [{
        companyId: company.id, provider: company.provider, board: company.board,
        status: 'ok', checkedAt: SEARCH_TIME, lastSuccessAt: SEARCH_TIME, retryAt: null,
        listing: {
          validUntil: new Date(Date.parse(SEARCH_TIME) + 30 * 60_000).toISOString(),
          publishedIds: [current.id],
          jobs: [{ id: current.id, title: current.title, url: current.url, revision: await createJobRevision(current) }],
        },
      }],
    }
    await page.route('**/api/posting-status*', route => route.fulfill({ json: statusIndex }))
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    const traffic = watchApiRequests(page)
    await page.goto('/')
    const initial = await expectInitialCatalogRequest(page, traffic)
    await waitForSavedCommit(page)
    await expect(page.locator('.mini-job-title')).toHaveText(UPGRADE_TITLE)
    await page.locator('.mini-job-title').click()
    const readConditions = async () => {
      await expect(page.locator('.job-meta-pills > span').last()).toHaveText('4년 이상')
      await expect(page.locator('.job-qualifications .skill-tag')).toHaveText(['TypeScript', 'Python', 'Go'])
      await expect(page.getByRole('dialog')).toContainText('요구 경력 4년 · 현재 입력한 경력보다 2년 많아요')
      return {
        qualifications: await page.locator('.job-qualifications').innerText(),
        comparison: await page.locator('.match-section').allInnerTexts(),
      }
    }
    const beforeSave = await readConditions()
    expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze()).violations).toEqual([])
    await page.getByRole('button', { name: '기회 저장', exact: true }).click()
    const note = 'Private qualification note: confirm the four-year requirement'
    await page.getByLabel('이 기회에 대한 나의 메모').fill(note)
    await page.getByRole('button', { name: '지원 완료로 표시', exact: true }).click()
    await page.getByRole('button', { name: '닫기', exact: true }).click()
    expect(traffic.requests).toHaveLength(initial.attempts)

    await page.getByRole('navigation', { name: '주요 메뉴' }).getByRole('button', { name: /저장한 기회/ }).click()
    await page.getByRole('button', { name: UPGRADE_TITLE, exact: true }).click()
    expect(await readConditions()).toEqual(beforeSave)
    await expect(page.getByLabel('이 기회에 대한 나의 메모')).toHaveValue(note)
    expect(await page.locator('.dialog').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
    await page.getByRole('button', { name: '닫기', exact: true }).click()
    await waitForSavedCommit(page)
    await page.reload()
    await expect(page.locator('.saved-card')).toHaveCount(1)
    const expected = [{ job: current, company, savedAt: now.toISOString(), status: 'applied', note }]
    expect(await readSaved(page)).toEqual(expected)
    await page.getByRole('button', { name: '게시 상태 확인', exact: true }).click()
    await expect(page.locator('.posting-notice.listed')).toHaveCount(1)
    await expect(page.locator('.posting-notice.changed, .posting-notice.missing')).toHaveCount(0)
    expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze()).violations).toEqual([])
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)

    const csvDownload = page.waitForEvent('download')
    await page.getByRole('button', { name: 'CSV 내보내기', exact: true }).click()
    const exported = csvRecord(await readFile((await (await csvDownload).path())!, 'utf8'))
    expect(exported).toMatchObject({
      '포지션': UPGRADE_TITLE, '저장일': now.toISOString(), '저장 내용의 조회 시각': SEARCH_TIME,
      '상태': '지원 완료', '메모': note, '내용 비교': '표시 내용 일치',
    })
    expect(exported['기술 조건']).toContain('TypeScript 또는 Python')
    expect(exported['기술 조건']).not.toContain('React')
    expect(exported['경력 조건']).toContain('4년 이상')
    await page.getByRole('button', { name: '기록 백업·복원', exact: true }).click()
    const backupDownload = page.waitForEvent('download')
    await page.getByRole('button', { name: 'JSON 백업', exact: true }).click()
    expect(JSON.parse(await readFile((await (await backupDownload).path())!, 'utf8')).records).toEqual(expected)
    await page.getByRole('button', { name: '완료', exact: true }).click()
    for (const request of traffic.requests) {
      const url = new URL(request.url)
      expect(['/api/catalog?source=public', '/api/posting-status?refresh=1']).toContain(`${url.pathname}${url.search}`)
      expect(request.method).toBe('GET')
      expect(request.body).toBeNull()
    }
    expect(errors).toEqual([])
  })
}
