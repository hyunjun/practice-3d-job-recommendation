import { expect } from '@playwright/test'
import type { Locator, Page, TestInfo } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import type { Catalog } from '../../../shared/types'
import type { PostingStatusIndex } from '../../../shared/posting-status'
import { createPublicCoverageServer } from '../../fixtures/public-coverage-server'
import { INTEGRATION_JOBS, INTEGRATION_NOW } from '../../fixtures/source-integration-contract'
import { integrationResponses } from '../../fixtures/source-integrations'
import { readServerMode } from './api-requests'
import { surveyJson } from './public-company-survey'
import { waitForSavedCommit } from './saved-store'

export async function integrationServer(page: Page, info: TestInfo, baseURL: string | undefined,
  options: Parameters<typeof createPublicCoverageServer>[2] = {}) {
  if (baseURL && new URL(baseURL).port === '8787') throw new Error('Stage63 never uses port8787')
  const configured = process.env.ORBIT_SOURCE_INTEGRATION_MODE
  if (configured && configured !== 'development' && configured !== 'production') throw new Error('Unknown source integration mode')
  const mode = configured === 'development' || configured === 'production'
    ? configured : await readServerMode(page.request, `${baseURL}/api/health`)
  return createPublicCoverageServer(info.outputPath('source63-server'), mode, {
    clock: INTEGRATION_NOW, responses: integrationResponses(), ...options,
  })
}

export async function catalog93(page: Page, origin: string, count: number) {
  const catalog = await surveyJson<Catalog>(page, origin, '/api/catalog?source=public')
  expect(catalog.companies).toHaveLength(93)
  expect(catalog.boards).toHaveLength(93)
  expect(catalog.jobs).toHaveLength(count)
  for (const expected of INTEGRATION_JOBS) expect(catalog.jobs.find(job => job.id === expected.id)).toMatchObject(expected)
  return catalog
}

export async function sourceCredit(scope: Locator, canonical: string) {
  const credit = scope.locator('.job-source-credit').first()
  await expect(credit).toBeVisible()
  await expect(credit.getByRole('link', { name: 'Himalayas', exact: true })).toHaveAttribute('href', 'https://himalayas.app')
  await expect(credit.getByRole('link', { name: 'Himalayas 원문', exact: true })).toHaveAttribute('href', canonical)
}

export async function statusAction(page: Page, content: boolean) {
  const pending = page.waitForResponse(response => {
    const url = new URL(response.url())
    return url.pathname === '/api/posting-status' && url.search === (content ? '?refresh=1&content=1' : '?refresh=1')
  })
  await page.getByRole('button', { name: content ? '공고 내용 확인' : '게시 상태 확인', exact: true }).click()
  const response = await pending
  expect(response.status()).toBe(200)
  return await response.json() as PostingStatusIndex
}

export async function saveWithNote(page: Page, note: string, applied = false) {
  await page.getByRole('button', { name: '기회 저장', exact: true }).click()
  await page.getByLabel('이 기회에 대한 나의 메모', { exact: true }).fill(note)
  if (applied) await page.getByRole('button', { name: '지원 완료로 표시', exact: true }).click()
  await waitForSavedCommit(page)
}

export async function downloadText(page: Page, button: string) {
  const download = page.waitForEvent('download')
  await page.getByRole('button', { name: button, exact: true }).click()
  return readFile((await (await download).path())!, 'utf8')
}

// Independent RFC4180 reader: preserves quoted commas/newlines in notes and
// checks actual CSV cells instead of accepting an unrelated substring.
export function csvRows(text: string) {
  const rows: string[][] = []
  let row: string[] = [], cell = '', quoted = false
  const input = text.replace(/^\uFEFF/, '')
  for (let index = 0; index < input.length; index++) {
    const character = input[index]
    if (quoted && character === '"' && input[index + 1] === '"') { cell += '"'; index++; continue }
    if (character === '"') { quoted = !quoted; continue }
    if (!quoted && character === ',') { row.push(cell); cell = ''; continue }
    if (!quoted && character === '\r' && input[index + 1] === '\n') { index++; row.push(cell); rows.push(row); row = []; cell = ''; continue }
    if (!quoted && character === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; continue }
    cell += character
  }
  if (quoted) throw new Error('Unterminated quoted CSV field')
  if (row.length || cell) { row.push(cell); rows.push(row) }
  return rows
}

export async function assertSynthetic(server: Awaited<ReturnType<typeof createPublicCoverageServer>>, count: number) {
  const requests = await server.requests()
  expect(requests).toHaveLength(count)
  expect(requests.every(request => request.synthetic && !request.networkSent && request.method === 'GET' && request.body === null)).toBe(true)
  await server.assertDefaultConfiguration()
  return requests
}
