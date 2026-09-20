import { expect, test } from '@playwright/test'
import type { Page, TestInfo } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  EARLIER_RESUME, LATEST_RESUME, THIRD_RESUME, CANCEL_MESSAGE,
  installResumeReadGates, armResumeRead, releaseResumeRead, rejectResumeRead,
  resumeReadEvents, afterResumeReadDelivery,
} from '../fixtures/resume-import'
import { readSaved, waitForSavedCommit } from './helpers/saved-store'

const CURRENT_FILENAME = 'current-resume-with-a-deliberately-long-filename-for-narrow-screens47.md'
const SAVED_NOTE = '취소된 파일로 이 지원 기록을 바꾸지 않기 🌱'
const STORED_PROFILE = {
  kind: 'personal', name: 'Nora Stored', headline: 'Frontend Engineer', years: 2,
  skills: ['TypeScript', 'React'], desiredRole: 'frontend', residence: 'KR', linkedinUrl: '',
}
const EXPLORATION = {
  source: 'sample', selectedId: 'london', panelTab: 'cities', mapMode: 'flat', citySort: 'salary', light: false,
  filters: {
    query: 'React', region: 'europe', role: 'all', workMode: 'all', visa: 'all', employment: 'all',
    postingType: 'opening', salaryMin: 0, includeUnknownSalary: true, remoteEligibleOnly: true,
  },
}
const picker = (page: Page) => page.getByLabel('이력서 파일 선택', { exact: true })
const upload = (page: Page) => page.locator('.upload-zone')
const text = (page: Page) => page.locator('#resume-text')
const pending = (page: Page) => page.getByRole('status', { name: '파일 읽기 상태', exact: true })
const analyze = (page: Page) => page.getByRole('button', { name: '경력에서 가능성 찾기', exact: true })
const profileButton = (page: Page) => page.getByRole('button', { name: '내 프로필 편집', exact: true })
const cancel = (page: Page) => page.getByRole('button', { name: '파일 읽기 취소', exact: true })
const payload = (name: string, contents: string) => ({ name, mimeType: 'text/plain', buffer: Buffer.from(contents) })

async function setup(page: Page, personal = false) {
  const failures = { pageErrors: [] as string[], failedResources: [] as string[], blockedRequests: [] as string[] }
  const requests: {
    url: string; method: string; body: string | null; resourceType: string; mainDocument: boolean
  }[] = []
  page.on('pageerror', error => failures.pageErrors.push(error.message))
  page.on('response', response => {
    if (response.status() >= 400) failures.failedResources.push(`${response.status()} ${response.url()}`)
  })
  page.on('requestfailed', request => {
    const error = request.failure()?.errorText
    if (error !== 'net::ERR_ABORTED') failures.failedResources.push(`${error} ${request.url()}`)
  })
  page.on('request', request => {
    const protocol = new URL(request.url()).protocol
    if (protocol === 'http:' || protocol === 'https:') requests.push({
      url: request.url(), method: request.method(), body: request.postData(), resourceType: request.resourceType(),
      mainDocument: request.isNavigationRequest() && request.frame() === page.mainFrame(),
    })
  })
  await installResumeReadGates(page)
  await page.addInitScript(({ exploration, profile }) => {
    if (sessionStorage.getItem('resume-import47-seeded')) return
    localStorage.setItem('orbit.v1.exploration', JSON.stringify(exploration))
    if (profile) localStorage.setItem('orbit.v1.profile', JSON.stringify(profile))
    sessionStorage.setItem('resume-import47-seeded', 'true')
  }, { exploration: EXPLORATION, profile: personal ? STORED_PROFILE : null })
  const allowedOrigin = new URL(test.info().project.use.baseURL!).origin
  await page.route('**/*', route => {
    const target = new URL(route.request().url())
    if (target.origin === allowedOrigin) return route.fallback()
    failures.blockedRequests.push(target.href)
    return route.abort('blockedbyclient')
  })
  await page.goto('/')
  await expect(profileButton(page)).toBeVisible()
  return { failures, requests }
}

async function nativeStarted(page: Page, id: string) {
  await expect.poll(async () => (await resumeReadEvents(page)).find(event => event.id === id)?.nativeCompleted).toBe(true)
}

async function deliver(page: Page, id: string, failure?: string) {
  if (failure) await rejectResumeRead(page, id, failure)
  else await releaseResumeRead(page, id)
  await expect.poll(async () => (await resumeReadEvents(page)).find(event => event.id === id)?.delivered).toBe(true)
  await afterResumeReadDelivery(page)
}

async function dropFile(page: Page, name: string, contents: string) {
  const transfer = await page.evaluateHandle(({ name, contents }) => {
    const data = new DataTransfer()
    data.items.add(new File([contents], name, { type: 'text/plain' }))
    return data
  }, { name, contents })
  try { await upload(page).dispatchEvent('drop', { dataTransfer: transfer }) }
  finally { await transfer.dispose() }
}

async function expectReview(page: Page, name: string, years: string) {
  await analyze(page).click()
  await expect(page.getByLabel('이름 또는 별명', { exact: true })).toHaveValue(name)
  await expect(page.getByLabel('개발 경력', { exact: true })).toHaveValue(years)
}

async function audit(page: Page, info: TestInfo, screenshot?: string) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  for (const locator of await page.locator('[role="dialog"], .resume-read-progress, .resume-read-notice').all())
    expect(await locator.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
  expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze()).violations).toEqual([])
  if (screenshot) await page.screenshot({ path: info.outputPath(screenshot) })
}

async function privacy(page: Page, state: Awaited<ReturnType<typeof setup>>, info: TestInfo) {
  expect(state.failures).toEqual({ pageErrors: [], failedResources: [], blockedRequests: [] })
  expect(state.requests.length).toBeGreaterThan(0)
  expect(state.requests.every(request => request.method === 'GET' && request.body === null)).toBe(true)
  expect(state.requests).toContainEqual({
    url: new URL('/', info.project.use.baseURL!).href, method: 'GET', body: null,
    resourceType: 'document', mainDocument: true,
  })
  const storage = await page.evaluate(() => Object.fromEntries(Object.entries(localStorage)))
  const saved = await readSaved(page)
  for (const marker of [
    'PRIVATE_RESUME_47_', 'old-private@example.test', 'new-private@example.test', 'current-private@example.test',
  ]) {
    expect(JSON.stringify(state.requests)).not.toContain(marker)
    expect(JSON.stringify(storage)).not.toContain(marker)
    expect(JSON.stringify(saved)).not.toContain(marker)
  }
  await writeFile(info.outputPath('resume-import-observation.json'), JSON.stringify({
    requests: state.requests, failures: state.failures, gates: await resumeReadEvents(page), storage, saved,
  }, null, 2))
}

for (const width of [1440, 320]) test.describe(`latest resume input at ${width}px`, () => {
  test.use({ viewport: { width, height: 960 }, isMobile: width === 320, hasTouch: width === 320 })

  test('sample and typed text survive late native file successes and only explicit review applies the latest profile', async ({ page }, info) => {
    const state = await setup(page)
    await profileButton(page).click()
    await armResumeRead(page, 'before-sample', 'earlier.txt')
    await picker(page).setInputFiles(payload('earlier.txt', EARLIER_RESUME))
    await nativeStarted(page, 'before-sample')
    await expect(pending(page).locator('strong')).toHaveText('earlier.txt')
    await page.getByRole('button', { name: '먼저 샘플 경력으로 체험하기', exact: true }).click()
    await expect(text(page)).toHaveValue(/^Alex Kim\nSoftware Engineer · 5 years/)
    await expect(pending(page)).toHaveCount(0)
    await expect(analyze(page)).toBeEnabled()
    await deliver(page, 'before-sample')
    await expect(text(page)).toHaveValue(/^Alex Kim\nSoftware Engineer · 5 years/)
    await expect(page.locator('.form-error')).toHaveCount(0)
    await expectReview(page, 'Alex Kim', '5')
    expect(await page.evaluate(() => localStorage.getItem('orbit.v1.profile'))).toBeNull()

    await page.getByRole('button', { name: '다시 입력', exact: true }).click()
    await page.getByRole('button', { name: '이력서', exact: true }).click()
    await armResumeRead(page, 'before-typing', 'earlier-again.txt')
    await picker(page).setInputFiles(payload('earlier-again.txt', EARLIER_RESUME))
    await nativeStarted(page, 'before-typing')
    await page.getByRole('button', { name: '텍스트', exact: true }).click()
    await page.getByLabel('경력 요약', { exact: true }).fill(LATEST_RESUME)
    await page.getByRole('button', { name: 'LinkedIn', exact: true }).click()
    await page.getByLabel('LinkedIn 프로필 주소', { exact: false }).fill('https://www.linkedin.com/in/nora-example-47')
    await deliver(page, 'before-typing')
    await expect(text(page)).toHaveValue(LATEST_RESUME)
    await expect(page.getByRole('button', { name: 'LinkedIn', exact: true })).toHaveAttribute('aria-pressed', 'true')
    await expect(pending(page)).toHaveCount(0)
    await expect(page.locator('.form-error')).toHaveCount(0)
    await expectReview(page, 'Nora Latest', '2')
    await expect(page.getByRole('button', { name: 'TypeScript 삭제', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'React 삭제', exact: true })).toBeVisible()
    await expect(page.getByLabel('희망 직무', { exact: true })).toHaveValue('all')
    await page.getByLabel('희망 직무', { exact: true }).selectOption('frontend')
    await expect(page.getByLabel('희망 직무', { exact: true })).toHaveValue('frontend')
    expect(await page.evaluate(() => localStorage.getItem('orbit.v1.profile'))).toBeNull()
    await audit(page, info)
    await page.getByRole('button', { name: '내 기회 지도 만들기', exact: true }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('orbit.v1.profile') ?? '{}'))).toMatchObject({
      kind: 'personal', name: 'Nora Latest', years: 2, skills: ['TypeScript', 'React'], desiredRole: 'frontend',
      linkedinUrl: 'https://www.linkedin.com/in/nora-example-47',
    })
    await expect(page.getByRole('textbox', { name: '도시, 회사 또는 포지션 검색', exact: true })).toHaveValue('React')
    await privacy(page, state, info)
  })

  test('a dropped replacement owns busy state despite an older failure, while same-tab and empty selection preserve accepted text', async ({ page }, info) => {
    const state = await setup(page)
    await profileButton(page).click()
    await picker(page).setInputFiles(payload('accepted.txt', LATEST_RESUME))
    await expect(text(page)).toHaveValue(LATEST_RESUME)
    await armResumeRead(page, 'older-pending', 'older-pending.txt')
    await picker(page).setInputFiles(payload('older-pending.txt', EARLIER_RESUME))
    await nativeStarted(page, 'older-pending')
    await expect(text(page)).toHaveValue(LATEST_RESUME)
    await expect(upload(page)).toBeEnabled()
    await page.getByRole('button', { name: '이력서', exact: true }).click()
    // A no-file change event represents a picker dismissal without replacing a File.
    await picker(page).setInputFiles([])
    await expect(pending(page).locator('strong')).toHaveText('older-pending.txt')
    await expect(analyze(page)).toBeDisabled()
    await armResumeRead(page, 'current-pending', CURRENT_FILENAME)
    await dropFile(page, CURRENT_FILENAME, THIRD_RESUME)
    await nativeStarted(page, 'current-pending')
    await deliver(page, 'older-pending', 'The older fictional file failed after replacement')
    await expect(pending(page).locator('strong')).toHaveText(CURRENT_FILENAME)
    await expect(upload(page)).toHaveAttribute('aria-busy', 'true')
    await expect(upload(page)).toBeEnabled()
    await expect(analyze(page)).toBeDisabled()
    await expect(text(page)).toHaveValue(LATEST_RESUME)
    await expect(page.locator('.form-error')).toHaveCount(0)
    await page.locator('.resume-read-progress').scrollIntoViewIfNeeded()
    await audit(page, info, width === 320 ? 'replacement-pending-320.png' : undefined)
    await deliver(page, 'current-pending')
    await expect(pending(page)).toHaveCount(0)
    await expect(text(page)).toHaveValue(THIRD_RESUME)
    await expect(upload(page).locator('strong')).toHaveText(CURRENT_FILENAME)
    await armResumeRead(page, 'before-manual-edit', 'before-manual-edit.txt')
    await picker(page).setInputFiles(payload('before-manual-edit.txt', EARLIER_RESUME))
    await nativeStarted(page, 'before-manual-edit')
    const edited = `${THIRD_RESUME}\nPRIVATE_RESUME_47_MANUAL_EDIT`
    await text(page).fill(edited)
    await expect(pending(page)).toHaveCount(0)
    await expect(analyze(page)).toBeEnabled()
    await deliver(page, 'before-manual-edit')
    await expect(text(page)).toHaveValue(edited)
    await expect(upload(page).locator('strong')).toHaveText(CURRENT_FILENAME)
    await dropFile(page, 'unsupported.rtf', 'A fictional unsupported resume')
    await expect(page.getByRole('alert')).toHaveText('PDF, DOCX, TXT, MD 파일을 사용할 수 있어요.')
    await expect(text(page)).toHaveValue(edited)
    await expect(upload(page).locator('strong')).toHaveText(CURRENT_FILENAME)
    await expect(analyze(page)).toBeEnabled()
    await expectReview(page, 'Theo Current', '4')
    await privacy(page, state, info)
  })

  test('explicit cancel keeps accepted text, restores keyboard focus and allows the exact same Korean PDF to be selected again', async ({ page }, info) => {
    const state = await setup(page)
    await profileButton(page).click()
    await picker(page).setInputFiles(payload('accepted.txt', LATEST_RESUME))
    await expect(text(page)).toHaveValue(LATEST_RESUME)
    const pdf = path.resolve('tests/fixtures/resume-ko.pdf')
    await armResumeRead(page, 'cancelled-pdf', 'resume-ko.pdf', 'arrayBuffer')
    await picker(page).setInputFiles(pdf)
    await nativeStarted(page, 'cancelled-pdf')
    await expect(pending(page).locator('strong')).toHaveText('resume-ko.pdf')
    await expect(text(page)).toHaveValue(LATEST_RESUME)
    await cancel(page).focus()
    await page.keyboard.press('Enter')
    await expect(upload(page)).toBeFocused()
    await expect(page.getByText(CANCEL_MESSAGE, { exact: true })).toBeVisible()
    await expect(pending(page)).toHaveCount(0)
    await expect(cancel(page)).toHaveCount(0)
    await expect(text(page)).toHaveValue(LATEST_RESUME)
    await expect(upload(page).locator('strong')).toHaveText('accepted.txt')
    await expect(picker(page)).toHaveValue('')
    await deliver(page, 'cancelled-pdf', 'A cancelled native PDF read completed with an error')
    await expect(page.getByText(CANCEL_MESSAGE, { exact: true })).toBeVisible()
    await expect(text(page)).toHaveValue(LATEST_RESUME)
    await expect(page.locator('.form-error')).toHaveCount(0)
    await upload(page).scrollIntoViewIfNeeded()
    await audit(page, info, width === 320 ? 'cancelled-import-focus-320.png' : undefined)
    await armResumeRead(page, 'same-pdf-retry', 'resume-ko.pdf', 'arrayBuffer')
    const selection = page.waitForEvent('filechooser')
    await upload(page).focus()
    await page.keyboard.press('Enter')
    await (await selection).setFiles(pdf)
    await nativeStarted(page, 'same-pdf-retry')
    await expect(pending(page).locator('strong')).toHaveText('resume-ko.pdf')
    await expect(page.getByText(CANCEL_MESSAGE, { exact: true })).toHaveCount(0)
    await expect(picker(page)).toHaveValue('')
    await deliver(page, 'same-pdf-retry')
    await expect(pending(page)).toHaveCount(0)
    await expect(upload(page).locator('strong')).toHaveText('resume-ko.pdf')
    await expect(text(page)).toHaveValue(/김민준/)
    await expectReview(page, '김민준', '5')
    await expect(page.locator('.form-error')).toHaveCount(0)
    await privacy(page, state, info)
  })

  test('closing a pending import preserves the stored profile, saved note and exploration while a reopened dialog owns its new read', async ({ page }, info) => {
    const state = await setup(page, true)
    await page.locator('.mini-job-title').first().click()
    await page.getByRole('button', { name: '기회 저장', exact: true }).click()
    await page.getByLabel('이 기회에 대한 나의 메모', { exact: true }).fill(SAVED_NOTE)
    await page.getByRole('button', { name: '지원 완료로 표시', exact: true }).click()
    await page.getByRole('button', { name: '닫기', exact: true }).click()
    await waitForSavedCommit(page)
    const saved = await readSaved(page)
    expect(saved).toHaveLength(1)
    expect(saved[0]).toMatchObject({ note: SAVED_NOTE, status: 'applied' })
    const exploration = await page.evaluate(() => JSON.parse(localStorage.getItem('orbit.v1.exploration') ?? '{}'))
    expect(exploration).toMatchObject(EXPLORATION)
    const navigation = page.getByRole('navigation', { name: '주요 메뉴' })
    await navigation.getByRole('button', { name: /^저장한 기회/ }).click()
    await expect(page.locator('.saved-card')).toHaveCount(1)
    await profileButton(page).click()
    await expect(page.getByLabel('이름 또는 별명', { exact: true })).toHaveValue('Nora Stored')
    await page.getByRole('button', { name: '다시 입력', exact: true }).click()
    await armResumeRead(page, 'closed-pdf', 'resume-ko.pdf', 'arrayBuffer')
    await picker(page).setInputFiles(path.resolve('tests/fixtures/resume-ko.pdf'))
    await nativeStarted(page, 'closed-pdf')
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(profileButton(page)).toBeFocused()
    await expect(navigation.getByRole('button', { name: /^저장한 기회/ })).toHaveAttribute('aria-current', 'page')
    await expect(page.locator('.saved-status')).toHaveText('지원 완료')
    await expect(page.locator('.saved-note-preview')).toHaveText(SAVED_NOTE)
    await profileButton(page).click()
    await expect(page.getByLabel('이름 또는 별명', { exact: true })).toHaveValue('Nora Stored')
    await expect(page.getByLabel('개발 경력', { exact: true })).toHaveValue('2')
    await page.getByRole('button', { name: '다시 입력', exact: true }).click()
    await armResumeRead(page, 'reopened-current', 'reopened-current.txt')
    await picker(page).setInputFiles(payload('reopened-current.txt', THIRD_RESUME))
    await nativeStarted(page, 'reopened-current')
    await deliver(page, 'closed-pdf', 'Old closed-dialog PDF read failed')
    await expect(pending(page).locator('strong')).toHaveText('reopened-current.txt')
    await expect(analyze(page)).toBeDisabled()
    await expect(page.locator('.form-error')).toHaveCount(0)
    await deliver(page, 'reopened-current')
    await expect(text(page)).toHaveValue(THIRD_RESUME)
    await expectReview(page, 'Theo Current', '4')
    await page.keyboard.press('Escape')
    await expect(profileButton(page)).toBeFocused()
    await expect(navigation.getByRole('button', { name: /^저장한 기회/ })).toHaveAttribute('aria-current', 'page')
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('orbit.v1.profile') ?? '{}'))).toEqual(STORED_PROFILE)
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('orbit.v1.exploration') ?? '{}'))).toEqual(exploration)
    expect(await readSaved(page)).toEqual(saved)
    await audit(page, info)
    await privacy(page, state, info)
    await page.reload()
    await expect(page.locator('.saved-card')).toHaveCount(1)
    await expect(page.locator('.saved-status')).toHaveText('지원 완료')
    await expect(page.locator('.saved-note-preview')).toHaveText(SAVED_NOTE)
    expect(await readSaved(page)).toEqual(saved)
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('orbit.v1.profile') ?? '{}'))).toEqual(STORED_PROFILE)
    expect(state.failures).toEqual({ pageErrors: [], failedResources: [], blockedRequests: [] })
  })
})
