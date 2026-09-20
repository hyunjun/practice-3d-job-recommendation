import { expect, test } from '@playwright/test'
import type { Page, TestInfo } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { DEFAULT_FILTERS, SAMPLE_PROFILE } from '../../shared/types'
import type { Catalog, SavedJob } from '../../shared/types'
import { BOARD_CONFIG_NOTE, BOARD_CONFIG_REGISTRATIONS, boardRegistration } from '../fixtures/board-config'
import { createBoardConfigServer } from '../fixtures/board-config-server'
import { readServerMode, watchApiRequests } from './helpers/api-requests'
import { readSaved, waitForSavedCommit } from './helpers/saved-store'

async function seed(page: Page, origin: string) {
  await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.fallback() : route.abort('blockedbyclient'))
  await page.addInitScript(({ profile, filters, origin }) => {
    if (location.origin !== origin) return
    if (sessionStorage.getItem('board-config-seeded')) return
    localStorage.setItem('orbit.v1.profile', JSON.stringify(profile))
    localStorage.setItem('orbit.v1.exploration', JSON.stringify({
      source: 'public', mapMode: 'flat', selectedId: 'london', panelTab: 'cities', filters,
    }))
    sessionStorage.setItem('board-config-seeded', 'true')
  }, {
    origin,
    profile: { ...SAMPLE_PROFILE, kind: 'personal', name: 'Synthetic configuration profile', desiredRole: 'backend', skills: ['TypeScript'], years: 5, residence: 'GB' },
    filters: { ...DEFAULT_FILTERS, role: 'backend', workMode: 'all', visa: 'all', employment: 'all', salaryMin: 0 },
  })
}
const coverage = (page: Page, label: string) => page.getByRole('dialog')
  .locator('.coverage-stats > div').filter({ has: page.getByText(label, { exact: true }) }).locator('strong')

async function catalog(page: Page, origin: string): Promise<Catalog> {
  const response = await page.request.get(`${origin}/api/catalog?source=public`)
  try {
    expect(response.status()).toBe(200)
    return await response.json()
  } finally { await response.dispose() }
}
async function audit(page: Page, info: TestInfo, screenshot?: string) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  for (const dialog of await page.getByRole('dialog').all()) {
    expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
  }
  expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze()).violations).toEqual([])
  if (screenshot) await page.screenshot({ path: info.outputPath(screenshot) })
}
async function save(page: Page, title: string, note: string, applied: boolean) {
  await page.getByRole('button', { name: title, exact: true }).click()
  await page.getByRole('button', { name: '기회 저장', exact: true }).click()
  await page.getByLabel('이 기회에 대한 나의 메모', { exact: true }).fill(note)
  if (applied) await page.getByRole('button', { name: '지원 완료로 표시', exact: true }).click()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await waitForSavedCommit(page)
}
function csvRows(text: string) {
  const headerEnd = text.indexOf('\r\n')
  const cells = (value: string) => [...value.matchAll(/"((?:[^"]|"")*)"(?:,|\r\n|$)/g)].map(match => match[1].replaceAll('""', '"'))
  const headers = cells(text.slice(0, headerEnd))
  const body = cells(text.slice(headerEnd + 2))
  expect(body).toHaveLength(headers.length * 2)
  return [0, 1].map(row => Object.fromEntries(headers.map((key, index) => [key, body[row * headers.length + index]])))
}
function expectPrivateRequests(traffic: ReturnType<typeof watchApiRequests>, origin: string) {
  for (const request of traffic.requests) {
    const url = new URL(request.url)
    expect(url.origin).toBe(origin)
    expect(request.method).toBe('GET')
    expect(request.body).toBeNull()
    expect(['/api/catalog', '/api/catalog/progress', '/api/posting-status']).toContain(url.pathname)
    expect(url.search).not.toContain('Synthetic')
    expect(url.search).not.toContain('TypeScript')
  }
}
function browserFailures(page: Page) {
  const errors: string[] = []
  const resources: { status: number; url: string }[] = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('response', response => {
    if (response.status() >= 400) resources.push({ status: response.status(), url: response.url() })
  })
  return { errors, resources }
}

for (const width of [1440, 320]) test.describe(`configured real public boards at ${width}px`, () => {
  test.use({ viewport: { width, height: 960 }, isMobile: width === 320, hasTouch: width === 320 })

  test('unknown coverage becomes the configured four-provider scope, while sample coverage stays separate', async ({ page, request, baseURL }, info) => {
    const mode = await readServerMode(request, `${baseURL}/api/health`)
    const server = await createBoardConfigServer(info.outputPath('configured-server'), mode, [...BOARD_CONFIG_REGISTRATIONS])
    const failures = browserFailures(page)
    const traffic = watchApiRequests(page)
    let release!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    let received = false
    try {
      await server.start()
      await server.verifyProductionBytes()
      await seed(page, server.origin)
      // Delay, then continue the real request. No synthetic /api/catalog body.
      await page.route('**/api/catalog?source=public', async route => {
        received = true
        await held
        await route.continue()
      })
      await page.goto(server.origin)
      await expect.poll(() => received).toBe(true)
      const opener = page.getByRole('button', { name: '데이터와 추천 방식', exact: true })
      await opener.click()
      await expect(coverage(page, '대상 회사')).toHaveText('—')
      await expect(coverage(page, '조회된 개발 공고')).toHaveText('—')
      await expect(page.getByRole('list', { name: '공개 공고 출처', exact: true })).toHaveCount(0)
      expect(await server.requests()).toEqual([])
      release()
      await expect(coverage(page, '대상 회사')).toHaveText('4')
      await expect(coverage(page, '조회된 개발 공고')).toHaveText('4')
      await expect(page.locator('.provider-coverage li strong')).toHaveText(['Greenhouse', 'Ashby', 'Lever', 'SmartRecruiters'])
      await expect(page.locator('.provider-coverage li span')).toHaveText(['1개 회사', '1개 회사', '1개 회사', '1개 회사'])
      const details = page.locator('.board-details')
      await details.locator('summary').click()
      await expect(details.locator('.board-name strong')).toHaveText(['Aurora Workshop', 'Birch Studio', 'Cedar Systems', 'Dune Software'])
      await expect(details.locator('.board-ok')).toHaveText(['1개 반영', '1개 반영', '1개 반영', '1개 반영'])
      await expect(details.getByRole('link', { name: 'Cedar Systems 채용 페이지', exact: true })).toHaveAttribute('href', 'https://example.com/careers/cedar')
      await audit(page, info, width === 320 ? 'configured-coverage-320.png' : undefined)
      await page.keyboard.press('Escape')
      await expect(page.getByRole('dialog')).toHaveCount(0)
      await expect(opener).toBeFocused()
      await expect(page.locator('.city-hero-caption h2')).toHaveText('런던51.51°N')
      await expect(page.locator('.city-detail-count strong')).toHaveText(['4', '4'])
      expect((await page.locator('.mini-job-title').allTextContents()).sort()).toEqual([
        'Backend Engineer Aurora', 'Backend Engineer Birch', 'Backend Engineer Cedar', 'Backend Engineer Dune',
      ])
      const actual = await catalog(page, server.origin)
      expect(actual.companies.map(company => [company.id, company.provider, company.board, company.boardRegion ?? null])).toEqual([
        ['aurora-config', 'greenhouse', 'Aurora Private42', null],
        ['birch-config', 'ashby', 'Birch.Private42', null],
        ['cedar-config', 'lever', 'Cedar-Private42', 'eu'],
        ['dune-config', 'smartrecruiters', 'DunePrivate42', null],
      ])
      expect(actual.jobs.map(job => job.id)).toEqual([
        'greenhouse-aurora-config-4201', 'ashby-birch-config-birch-4202',
        'lever-cedar-config-cedar-4203', 'smartrecruiters-dune-config-dune-4204',
      ])
      await opener.click()
      await page.getByRole('button', { name: '샘플로 탐색', exact: false }).click()
      await expect(coverage(page, '대상 회사')).toHaveText('32')
      await expect(page.locator('.provider-coverage')).toHaveCount(0)
      await expect(coverage(page, '샘플 공고')).not.toHaveText('—')
      const upstream = await server.requests()
      expect(upstream).toHaveLength(5)
      expect(upstream.every(item => item.synthetic && !item.networkSent && item.method === 'GET')).toBe(true)
      expect(upstream.map(item => item.url).sort()).toEqual([
        'https://api.ashbyhq.com/posting-api/job-board/Birch.Private42?includeCompensation=true',
        'https://api.eu.lever.co/v0/postings/Cedar-Private42?mode=json&limit=50&skip=0',
        'https://api.smartrecruiters.com/v1/companies/DunePrivate42/postings/dune-4204',
        'https://api.smartrecruiters.com/v1/companies/DunePrivate42/postings?limit=100&offset=0&destination=PUBLIC',
        'https://boards-api.greenhouse.io/v1/boards/Aurora%20Private42/jobs?content=true&pay_transparency=true',
      ].sort())
      expect(await readFile(server.defaultCache, 'utf8')).toBe(server.defaultBytes)
      expect(await server.cacheFiles()).toHaveLength(1)
      expectPrivateRequests(traffic, server.origin)
      expect(failures).toEqual({ errors: [], resources: [] })
      await writeFile(info.outputPath('observed-catalog.json'), JSON.stringify(actual, null, 2))
    } finally {
      release()
      await page.close()
      await server.stop()
    }
  })

  test('restart applies edited boards, reuses only matching cache and preserves changed or removed saved sources', async ({ page, request, baseURL }, info) => {
    const mode = await readServerMode(request, `${baseURL}/api/health`)
    const server = await createBoardConfigServer(info.outputPath('configured-server'), mode, [
      BOARD_CONFIG_REGISTRATIONS[0], BOARD_CONFIG_REGISTRATIONS[1], BOARD_CONFIG_REGISTRATIONS[2],
    ])
    const failures = browserFailures(page)
    const traffic = watchApiRequests(page)
    try {
      await server.start()
      await server.verifyProductionBytes()
      await seed(page, server.origin)
      await page.goto(server.origin)
      await expect(page.locator('.city-hero-caption h2')).toHaveText('런던51.51°N')
      await expect(page.locator('.city-detail-count strong')).toHaveText(['3', '3'])
      await save(page, 'Backend Engineer Aurora', BOARD_CONFIG_NOTE, true)
      await save(page, 'Backend Engineer Cedar', 'Keep the removed EU board snapshot.', false)
      const original = await readSaved(page)
      expect(original).toHaveLength(2)
      expect(original.find(item => item.job.id === 'greenhouse-aurora-config-4201')).toMatchObject({
        company: { id: 'aurora-config', board: 'Aurora Private42', provider: 'greenhouse' },
        job: { title: 'Backend Engineer Aurora', url: 'https://example.com/jobs/aurora-original' },
        note: BOARD_CONFIG_NOTE, status: 'applied',
      })
      expect(original.find(item => item.job.id === 'lever-cedar-config-cedar-4203')).toMatchObject({
        company: { id: 'cedar-config', board: 'Cedar-Private42', provider: 'lever', boardRegion: 'eu' },
        job: { title: 'Backend Engineer Cedar', url: 'https://example.com/jobs/cedar' },
        note: 'Keep the removed EU board snapshot.', status: 'saved',
      })
      const before = await catalog(page, server.origin)
      const cacheFiles = await server.cacheFiles()
      expect(cacheFiles).toHaveLength(1)
      const oldBirchTime = before.jobs.find(job => job.id === 'ashby-birch-config-birch-4202')!.fetchedAt
      await page.locator('.main-nav button').filter({ hasText: '저장한 기회' }).click()
      await expect(page.locator('.saved-card')).toHaveCount(2)
      await server.configure([
        boardRegistration({ board: 'Aurora.Next42' }),
        { ...BOARD_CONFIG_REGISTRATIONS[1], name: 'Birch Renamed' },
      ])
      // A file edit alone must not silently switch the running collector.
      const whileRunning = await catalog(page, server.origin)
      expect(whileRunning.companies.map(company => company.name)).toEqual(['Aurora Workshop', 'Birch Studio', 'Cedar Systems'])
      expect(whileRunning.jobs.map(job => job.title)).toEqual(['Backend Engineer Aurora', 'Backend Engineer Birch', 'Backend Engineer Cedar'])
      expect(await server.requests()).toHaveLength(3)
      const savedUrl = page.url()
      expect(new URL(savedUrl).hash).toBe('#saved')
      // Leave the old development client before its owned server is stopped;
      // reopen the exact saved URL after restart with the same browser storage.
      await page.goto('about:blank')
      await server.stop()
      await server.start()
      await server.verifyProductionBytes()
      await page.goto(savedUrl)
      await expect(page.locator('.saved-card')).toHaveCount(2)
      await expect(page.getByRole('heading', { name: '가능성을 모아두는 곳.', exact: true })).toBeVisible()
      expect(await readSaved(page)).toEqual(original)
      await page.getByRole('button', { name: '게시 상태 확인', exact: true }).click()
      await expect(page.locator('.posting-summary strong')).toHaveText(['0', '0', '0', '2'])
      await expect(page.locator('.posting-notice.unknown')).toHaveCount(2)
      await expect(page.locator('.posting-notice.listed, .posting-notice.missing, .posting-notice.changed')).toHaveCount(0)
      await expect(page.locator('.saved-card').filter({ hasText: 'Backend Engineer Aurora' }).locator('.saved-status')).toHaveText('지원 완료')
      await expect(page.locator('.saved-card').filter({ hasText: 'Backend Engineer Cedar' }).locator('.saved-status')).toHaveText('검토 중')
      await page.getByRole('button', { name: 'Backend Engineer Aurora', exact: true }).click()
      await expect(page.getByRole('heading', { name: 'Backend Engineer Aurora', exact: true })).toBeVisible()
      await expect(page.getByRole('link', { name: '원문에서 지원하기', exact: true })).toHaveAttribute('href', 'https://example.com/jobs/aurora-original')
      await expect(page.getByLabel('이 기회에 대한 나의 메모', { exact: true })).toHaveValue(BOARD_CONFIG_NOTE)
      await expect(page.getByRole('dialog').getByText('저장한 공고의 게시판이 현재 조회 범위와 달라요. 원문에서 확인해 주세요.', { exact: true })).toBeVisible()
      await audit(page, info, width === 320 ? 'configured-saved-source-320.png' : undefined)
      await page.keyboard.press('Escape')
      await expect(page.getByRole('dialog')).toHaveCount(0)
      await expect(page.getByRole('button', { name: 'Backend Engineer Aurora', exact: true })).toBeFocused()
      const csvDownload = page.waitForEvent('download')
      await page.getByRole('button', { name: 'CSV 내보내기', exact: true }).click()
      const exported = csvRows(await readFile((await (await csvDownload).path())!, 'utf8'))
      expect(exported.find(row => row['회사'] === 'Aurora Workshop')).toMatchObject({
        '포지션': 'Backend Engineer Aurora', '채용 링크': 'https://example.com/jobs/aurora-original',
        '메모': BOARD_CONFIG_NOTE, '상태': '지원 완료', '공개 게시 상태': '현재 상태 확인 필요', '내용 비교': '미확인',
      })
      expect(exported.find(row => row['회사'] === 'Cedar Systems')).toMatchObject({
        '포지션': 'Backend Engineer Cedar', '채용 링크': 'https://example.com/jobs/cedar',
        '메모': 'Keep the removed EU board snapshot.', '상태': '저장됨', '공개 게시 상태': '현재 상태 확인 필요', '내용 비교': '미확인',
      })
      await page.getByRole('button', { name: '기록 백업·복원', exact: true }).click()
      const backupDownload = page.waitForEvent('download')
      await page.getByRole('button', { name: 'JSON 백업', exact: true }).click()
      const backup = JSON.parse(await readFile((await (await backupDownload).path())!, 'utf8')) as { records: SavedJob[] }
      expect(backup.records).toEqual(original)
      await page.getByRole('button', { name: '완료', exact: true }).click()
      await page.locator('.main-nav button').filter({ hasText: '기회 탐색' }).click()
      await expect(page.locator('.city-hero-caption h2')).toHaveText('런던51.51°N')
      await expect(page.locator('.city-detail-count strong')).toHaveText(['2', '2'])
      expect((await page.locator('.mini-job-title').allTextContents()).sort()).toEqual(['Backend Engineer Aurora Next', 'Backend Engineer Birch'])
      await expect(page.getByRole('heading', { name: 'Birch Renamed', exact: true })).toBeVisible()
      await expect(page.getByRole('heading', { name: 'Cedar Systems', exact: true })).toHaveCount(0)
      const after = await catalog(page, server.origin)
      expect(after.companies.map(company => [company.id, company.name, company.board])).toEqual([
        ['aurora-config', 'Aurora Workshop', 'Aurora.Next42'], ['birch-config', 'Birch Renamed', 'Birch.Private42'],
      ])
      expect(after.jobs.map(job => [job.id, job.title, job.url])).toEqual([
        ['greenhouse-aurora-config-4201', 'Backend Engineer Aurora Next', 'https://example.com/jobs/aurora-next'],
        ['ashby-birch-config-birch-4202', 'Backend Engineer Birch', 'https://example.com/jobs/birch'],
      ])
      expect(after.jobs[1].fetchedAt).toBe(oldBirchTime)
      expect(await server.cacheFiles()).toEqual(cacheFiles)
      const persisted = JSON.parse(await readFile(path.join(server.cwd, '.local', cacheFiles[0]), 'utf8')) as { boards: { companyId: string }[] }
      expect(persisted.boards.map(board => board.companyId).sort()).toEqual(['aurora-config', 'birch-config'])
      const upstream = await server.requests()
      expect(upstream).toHaveLength(4)
      expect(upstream[3]).toEqual({
        url: 'https://boards-api.greenhouse.io/v1/boards/Aurora.Next42/jobs?content=true&pay_transparency=true',
        method: 'GET', synthetic: true, networkSent: false,
      })
      expect(upstream.every(item => item.synthetic && !item.networkSent)).toBe(true)
      expect(await readFile(server.defaultCache, 'utf8')).toBe(server.defaultBytes)
      expect(await readSaved(page)).toEqual(original)
      expectPrivateRequests(traffic, server.origin)
      expect(failures).toEqual({ errors: [], resources: [] })
      await writeFile(info.outputPath('catalog-and-saved.json'), JSON.stringify({ before, after, original, backup: backup.records }, null, 2))
    } finally {
      await page.close()
      await server.stop()
    }
  })
})
