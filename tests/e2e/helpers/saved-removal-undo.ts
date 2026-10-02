/**
 * Stage80 saved-removal recovery (D2) helpers shared by the recovery specs.
 * Every record here is literal fictional data authored in the test tree; no
 * product restore, schema or controller function computes an expectation.
 * Diagnostics (page errors, console errors, /api traffic) are collected from
 * case start and asserted in fixture teardown, so a failed case still records
 * and checks them. Nothing is exempted beyond the declared API policy.
 */
import { expect } from '@playwright/test'
import type { Locator, Page, TestInfo } from '@playwright/test'
import type { SavedJob } from '../../../shared/types'
import { publicProtocolCatalog } from '../../fixtures/public-protocol'
import { resourceCheckedTest } from './public-app'
import { readSaved, waitForSavedCommit } from './saved-store'
import { watchApiRequests } from './api-requests'
import { SAVED_DATABASE_NAME } from './saved-lifecycle'

/** Browser clock at case start; ordinary (non-fixed) time flows from here. */
export const UNDO_CLOCK = '2026-10-02T09:00:00.000Z'
/**
 * Explore and compare cases load the synthetic public catalog, which is dated
 * PUBLIC_PROTOCOL_TIME (2026-09-26T08:00:00Z). Their page clock starts ten
 * seconds later so the catalog is fresh (24 h fallback limit, 30 min
 * freshness) and no refresh deadline falls inside a case.
 */
export const EXPLORE_CLOCK = '2026-09-26T08:00:10.000Z'
/** The old toast kept its Undo for 7000 ms; 8000 ms is comfortably past it. */
export const PAST_OLD_TOAST_LIFETIME_MS = 8_000
export const RECOVERY_REGION = '제거한 기회 복구'
export const RECOVERY_SCOPE_NOTE = '복구 대기 1개와 최근 제거 1개를 이 탭을 열어 둔 동안 보관해요. 최근 제거는 다음 제거 시 바뀌어요.'
export const RESULTS_PANEL = '도시와 회사 탐색 결과'

export const EMBER_NOTE = 'PRIVATE-UNDO80 ask about the Ember runtime team before applying\n두 번째 줄: 포트폴리오 링크 준비, "따옴표" 포함 🌱'
export const EMBER: SavedJob = {
  job: {
    id: 'greenhouse-ember-forge-80', companyId: 'ember-forge', title: 'Ember 80 · Backend Engineer', role: 'backend', cityIds: ['london'],
    locationLabel: 'London, UK', workMode: 'hybrid', employment: 'fulltime',
    minExperience: 4, skills: ['TypeScript', 'PostgreSQL'], salary: null, visa: 'unknown',
    remoteCountries: [], remoteWorldwide: false, remoteScopeUnknown: false,
    description: 'Fictional backend engineering role for the stage80 undo regression. Required: 4 years of software engineering experience with TypeScript and PostgreSQL.',
    requirements: ['4 years of software engineering experience with TypeScript and PostgreSQL.'],
    url: 'https://example.org/undo80/greenhouse-ember-forge-80', source: 'greenhouse',
    updatedAt: null, fetchedAt: '2026-09-28T07:00:00.000Z',
  },
  company: {
    id: 'ember-forge', name: 'Ember Forge', initials: 'EF', color: '#d9a066',
    industry: 'Fictional software studio', careerUrl: 'https://example.org/ember-forge/careers',
    provider: 'greenhouse', board: 'ember-forge',
  },
  savedAt: '2026-09-28T07:30:00.000Z', status: 'applied', note: EMBER_NOTE,
}

export const CINDER_NOTE = 'PRIVATE-UNDO80 second record: compare the Cinder platform offer with Ember'
export const CINDER: SavedJob = {
  job: {
    id: 'greenhouse-cinder-works-81', companyId: 'cinder-works', title: 'Cinder 81 · Platform Engineer', role: 'devops', cityIds: ['london'],
    locationLabel: 'London, UK', workMode: 'onsite', employment: 'fulltime',
    minExperience: 6, skills: ['Kubernetes', 'Go'], salary: null, visa: 'unknown',
    remoteCountries: [], remoteWorldwide: false, remoteScopeUnknown: false,
    description: 'Fictional platform engineering role for the stage80 undo regression. Required: 6 years of infrastructure experience with Kubernetes and Go.',
    requirements: ['6 years of infrastructure experience with Kubernetes and Go.'],
    url: 'https://example.org/undo80/greenhouse-cinder-works-81', source: 'greenhouse',
    updatedAt: null, fetchedAt: '2026-09-29T07:00:00.000Z',
  },
  company: {
    id: 'cinder-works', name: 'Cinder Works', initials: 'CW', color: '#8fb0d9',
    industry: 'Fictional platform studio', careerUrl: 'https://example.org/cinder-works/careers',
    provider: 'greenhouse', board: 'cinder-works',
  },
  savedAt: '2026-09-29T08:15:00.000Z', status: 'saved', note: CINDER_NOTE,
}

/** A record another tab could add; distinct id and company. */
export const OTHER_TAB: SavedJob = {
  ...CINDER,
  job: { ...CINDER.job, id: 'greenhouse-cinder-works-83', title: 'Cinder 83 · Data Engineer', role: 'data', skills: ['Python', 'Spark'], url: 'https://example.org/undo80/greenhouse-cinder-works-83' },
  savedAt: '2026-10-01T06:00:00.000Z', status: 'saved', note: 'PRIVATE-UNDO80 written by another tab',
}

/** Same ID as EMBER but different private metadata, as another tab would re-save it. */
export const NEWER_EMBER: SavedJob = { ...EMBER, savedAt: '2026-10-01T12:00:00.000Z', status: 'saved', note: 'NEWER note written by another tab' }

export const LONG_NAMES: SavedJob = {
  ...EMBER,
  job: { ...EMBER.job, id: 'greenhouse-ember-forge-long-82', title: 'Senior Backend Engineer — Fictional Long Posting Title Verifying Wrapping At Narrow Viewports 82', url: 'https://example.org/undo80/greenhouse-ember-forge-long-82' },
  company: { ...EMBER.company, name: 'Ember Forge Cooperative Research Studio for Fictional Accessibility and Very Long Organisation Names' },
  note: 'PRIVATE-UNDO80 long record note line one\n두 번째 줄: 긴 회사명과 긴 공고명이 320px에서 줄바꿈되는지 확인하는 메모 🌱',
}

/**
 * A schema-valid record saved under an earlier board registration: its company id
 * differs from the job's companyId. Legacy and active decoding accept it, so a
 * restore must settle on it too (Astra A80-P01-1).
 */
export const LEGACY_MISMATCH: SavedJob = {
  ...EMBER,
  job: { ...EMBER.job, id: 'greenhouse-ember-forge-legacy-84', title: 'Ember 84 · Legacy Record Engineer', url: 'https://example.org/undo80/greenhouse-ember-forge-legacy-84' },
  company: { ...EMBER.company, id: 'ember-forge-eu', name: 'Ember Forge (EU board)', board: 'ember-forge-eu' },
  savedAt: '2026-09-20T07:30:00.000Z', status: 'applied',
  note: 'PRIVATE-UNDO80 legacy record saved under an earlier board registration\n둘째 줄: 회사 ID가 달라도 복구돼야 하는 메모 🌱',
}

/** Literal fields a correct recovery must bring back exactly; read migrations may add interpretation fields to a committed job. */
export function literalOf(record: SavedJob) {
  return {
    note: record.note, status: record.status, savedAt: record.savedAt, company: record.company,
    job: {
      id: record.job.id, companyId: record.job.companyId, title: record.job.title, url: record.job.url,
      source: record.job.source, fetchedAt: record.job.fetchedAt, updatedAt: record.job.updatedAt,
      description: record.job.description, locationLabel: record.job.locationLabel,
    },
  }
}
export const entryName = (record: SavedJob) => `${record.company.name} · ${record.job.title}`

export type ApiPolicy = 'none' | 'catalog-reads' | 'posting-status-reads'
interface RecoveryDiagnostics {
  traffic: ReturnType<typeof watchApiRequests>
  pageErrors: string[]
  consoleErrors: string[]
}

type ObservedRequest = ReturnType<typeof watchApiRequests>['requests'][number]
function isCatalogRead(request: ObservedRequest) {
  const url = new URL(request.url)
  return url.pathname === '/api/catalog' && url.search === '?source=public' && request.method === 'GET' && request.body === null
    && ((request.state === 'finished' && [200, 202, 304].includes(request.status ?? 0))
      || (request.state === 'failed' && request.error === 'net::ERR_ABORTED'))
}
function isPostingStatusRead(request: ObservedRequest) {
  const url = new URL(request.url)
  return url.pathname === '/api/posting-status' && request.method === 'GET' && request.body === null
    && request.state === 'finished' && request.status === 200
}

/**
 * Always-run diagnostics beside the existing resource audit, scoped to the
 * Page's own requests (APIRequestContext health reads are separate traffic).
 * `apiPolicy: 'none'` forbids every /api request; `'catalog-reads'` admits
 * GET /api/catalog?source=public with an allowed outcome, including the
 * development StrictMode abort; `'posting-status-reads'` admits GET
 * /api/posting-status with a 200. A policy restricts endpoint, method, body
 * and outcome only. It does not bound how many admitted requests occur, so a
 * case that must prove a local operation caused no request takes an explicit
 * attempt count (see expectInitialCatalogRequest) and compares it afterwards.
 * Attach first, then one combined assertion.
 */
export const test = resourceCheckedTest.extend<{ apiPolicy: ApiPolicy; recoveryDiagnostics: RecoveryDiagnostics }>({
  apiPolicy: ['none', { option: true }],
  recoveryDiagnostics: [async ({ page, apiPolicy }, use, testInfo) => {
    const pageErrors: string[] = []
    const consoleErrors: string[] = []
    page.on('pageerror', error => pageErrors.push(`${error.name}: ${error.message}`))
    page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()) })
    const traffic = watchApiRequests(page)
    try {
      await use({ traffic, pageErrors, consoleErrors })
    } finally {
      const unexpectedApi = apiPolicy === 'none' ? traffic.requests
        : apiPolicy === 'catalog-reads' ? traffic.requests.filter(request => !isCatalogRead(request))
          : traffic.requests.filter(request => !isPostingStatusRead(request))
      await testInfo.attach('recovery-diagnostics', {
        body: JSON.stringify({ apiPolicy, pageErrors, consoleErrors, apiRequests: traffic.requests, unexpectedApi }, null, 2),
        contentType: 'application/json',
      })
      expect({ pageErrors, consoleErrors, unexpectedApi }, 'Unexpected browser error or /api traffic during the case; see the recovery-diagnostics attachment')
        .toEqual({ pageErrors: [], consoleErrors: [], unexpectedApi: [] })
    }
  }, { auto: true }],
})

export async function seedSaved(page: Page, records: unknown[], options: { clock?: string } = {}) {
  await page.clock.install({ time: new Date(options.clock ?? UNDO_CLOCK) })
  await page.addInitScript(raw => {
    localStorage.setItem('orbit.v1.saved', raw)
    localStorage.setItem('orbit.v1.exploration', JSON.stringify({ source: 'public', mapMode: 'flat' }))
  }, JSON.stringify(records))
}

export async function openSavedView(page: Page, titles?: string[]) {
  await page.goto('/#saved')
  await waitForSavedCommit(page)
  await expect(page.getByRole('textbox', { name: '저장한 기회 검색', exact: true })).toBeVisible()
  if (titles) await expect(page.locator('.saved-title')).toHaveText(titles)
}

export const savedSearch = (page: Page) => page.getByRole('textbox', { name: '저장한 기회 검색', exact: true })
export const titleButton = (page: Page, record: SavedJob) => page.getByRole('button', { name: record.job.title, exact: true })
export const cardOf = (page: Page, record: SavedJob) => page.locator('.saved-card').filter({ has: page.getByRole('button', { name: record.job.title, exact: true }) })
export const cardRemoveButton = (page: Page, record: SavedJob) => cardOf(page, record).getByRole('button', { name: `${record.company.name} 저장 취소`, exact: true })
export const dialogOf = (page: Page, record: SavedJob) => page.getByRole('dialog', { name: record.company.name, exact: true })
export const closeButton = (dialog: Locator) => dialog.getByRole('button', { name: '닫기', exact: true })
export const noteField = (dialog: Locator) => dialog.getByLabel('이 기회에 대한 나의 메모', { exact: true })
export const appliedMarker = (dialog: Locator) => dialog.getByRole('button', { name: '지원 완료로 표시됨', exact: true })
/** The save/remove toggle is the first footer button; the original-posting link is an anchor. */
export const footerButtons = (dialog: Locator) => dialog.locator('.job-footer button')
export const footerToggle = (dialog: Locator) => footerButtons(dialog).first()
export const navCount = (page: Page) => page.locator('.main-nav .nav-count')

export const recoveryRegion = (scope: Page | Locator) => scope.getByRole('region', { name: RECOVERY_REGION, exact: true })
const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
/** Each candidate article is named by its kind plus company · title, so same-ID variants stay distinguishable. */
export const recoveryEntry = (scope: Page | Locator, record: SavedJob) =>
  recoveryRegion(scope).getByRole('article', { name: new RegExp(`^(복구 대기|최근 제거) ${escapeRegExp(entryName(record))}$`) })
export const pendingEntryOf = (scope: Page | Locator, record: SavedJob) => recoveryRegion(scope).getByRole('article', { name: `복구 대기 ${entryName(record)}`, exact: true })
export const latestEntryOf = (scope: Page | Locator, record: SavedJob) => recoveryRegion(scope).getByRole('article', { name: `최근 제거 ${entryName(record)}`, exact: true })
export const undoOf = (entry: Locator) => entry.getByRole('button', { name: '실행 취소', exact: true })
export const retryOf = (entry: Locator) => entry.getByRole('button', { name: '복구 다시 시도', exact: true })
export const dismissOf = (entry: Locator) => entry.getByRole('button', { name: '복구 안내 닫기', exact: true })
export const messageOf = (entry: Locator) => entry.getByRole('status')
export async function expectEntryKind(entry: Locator, kind: '복구 대기' | '최근 제거') {
  await expect(entry.getByText(kind, { exact: true })).toBeVisible()
}

export async function openDetailByKeyboard(page: Page, record: SavedJob) {
  await titleButton(page, record).focus()
  await page.keyboard.press('Enter')
  const dialog = dialogOf(page, record)
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole('heading', { name: record.job.title, exact: true })).toBeVisible()
  return dialog
}

export async function committedById(page: Page, id: string): Promise<SavedJob | undefined> {
  return (await readSaved(page)).find(record => record.job.id === id)
}

/** Literal private metadata first, then equality with the record the application itself had committed earlier. */
export async function expectCommittedExactly(page: Page, record: SavedJob, before: SavedJob) {
  const found = await committedById(page, record.job.id)
  expect(found).toMatchObject(literalOf(record))
  expect(found).toEqual(before)
}

export async function expectAbsentFromStorage(page: Page, id: string) {
  expect((await readSaved(page)).map(record => record.job.id)).not.toContain(id)
}

/**
 * Geometry of a control in its own rendering layer. A control inside the open
 * native modal paints in the top layer above the inert page, so the page's fixed
 * bottom navigation is not an occluder there; instead the control must lie
 * inside the viewport and inside its dialog scrollport. A page control must
 * also clear the fixed bottom navigation. Occlusion by anything that really
 * paints above the control (a sticky dialog footer over body content, a toast)
 * is caught by hit testing; a footer's own descendants hit themselves.
 */
function probeLayer(element: Element, points: 'center' | 'five') {
  const rect = element.getBoundingClientRect()
  const modal = element.closest<HTMLDialogElement>('dialog[open]')
  let scrollport: Element | null = null
  for (let node: Element | null = element.parentElement; node && modal && modal.contains(node); node = node.parentElement) {
    const style = getComputedStyle(node)
    if (/(auto|scroll)/.test(style.overflowY) && node.scrollHeight > node.clientHeight + 1) { scrollport = node; break }
    if (node === modal) break
  }
  const nav = document.querySelector('.main-nav')
  const navTop = !modal && nav && getComputedStyle(nav).position === 'fixed' ? nav.getBoundingClientRect().top : innerHeight
  const port = scrollport ? scrollport.getBoundingClientRect() : null
  const inset = Math.min(3, rect.width / 4, rect.height / 4)
  const samples: [number, number][] = points === 'center' ? [[rect.left + rect.width / 2, rect.top + rect.height / 2]] : [
    [rect.left + rect.width / 2, rect.top + rect.height / 2],
    [rect.left + inset, rect.top + inset], [rect.right - inset, rect.top + inset],
    [rect.left + inset, rect.bottom - inset], [rect.right - inset, rect.bottom - inset],
  ]
  const style = getComputedStyle(element)
  return {
    layer: modal ? 'modal' : 'page',
    box: { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right, width: rect.width, height: rect.height },
    viewport: { width: innerWidth, height: innerHeight },
    topLimit: port ? Math.max(0, port.top - 0.5) : 0,
    bottomLimit: Math.min(innerHeight, navTop, port ? port.bottom + 0.5 : Infinity),
    scrollport: port && scrollport ? { top: port.top, bottom: port.bottom, element: `${scrollport.tagName}.${scrollport.getAttribute('class') ?? ''}` } : null,
    covered: samples
      .filter(([x, y]) => { const hit = document.elementFromPoint(x, y); return !(hit === element || element.contains(hit)) })
      .map(([x, y]) => { const hit = document.elementFromPoint(x, y); return { x, y, hit: hit ? `${hit.tagName}.${hit.getAttribute('class') ?? ''}` : null } }),
    focusVisible: element.matches(':focus-visible'), outline: style.outlineStyle, outlineWidth: Number.parseFloat(style.outlineWidth),
    control: { tag: element.tagName, text: element.textContent?.slice(0, 80), className: element.getAttribute('class'), label: element.getAttribute('aria-label') },
  }
}

/** Focused control is fully inside its layer (viewport, dialog scrollport or above the fixed nav), uncovered at its centre and (for keyboard) visibly focused. */
export async function expectVisibleFocus(control: Locator, keyboard = true) {
  await expect(control).toBeFocused()
  await expect(control).toBeInViewport({ ratio: 1 })
  const state = await control.evaluate(probeLayer, 'center' as const)
  const detail = JSON.stringify(state)
  expect(state.box.top, detail).toBeGreaterThanOrEqual(state.topLimit)
  expect(state.box.bottom, detail).toBeLessThanOrEqual(state.bottomLimit)
  expect(state.box.left, detail).toBeGreaterThanOrEqual(0)
  expect(state.box.right, detail).toBeLessThanOrEqual(state.viewport.width)
  expect(state.covered, detail).toEqual([])
  if (keyboard) {
    expect(state.focusVisible, detail).toBe(true)
    expect(state.outline, detail).not.toBe('none')
    expect(state.outlineWidth, detail).toBeGreaterThanOrEqual(2)
  }
}

/** Scroll the element to the viewport centre through ordinary scrolling, then require it to be fully inside its layer and uncovered at five sample points. */
export async function expectReadable(target: Locator) {
  await target.evaluate(element => element.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' }))
  await expect(target).toBeInViewport({ ratio: 1 })
  const result = await target.evaluate(probeLayer, 'five' as const)
  const detail = JSON.stringify(result)
  expect(result.box.left, detail).toBeGreaterThanOrEqual(-0.5)
  expect(result.box.right, detail).toBeLessThanOrEqual(result.viewport.width + 0.5)
  expect(result.box.top, detail).toBeGreaterThanOrEqual(result.topLimit)
  expect(result.box.bottom, detail).toBeLessThanOrEqual(result.bottomLimit)
  expect(result.covered, detail).toEqual([])
}

/** Press Tab (or Shift+Tab) until the target owns focus; fail past `max` real presses. Returns the press count. */
export async function pressTabUntil(page: Page, target: Locator, options: { shift?: boolean; max: number }): Promise<number> {
  for (let presses = 1; presses <= options.max; presses++) {
    await page.keyboard.press(options.shift ? 'Shift+Tab' : 'Tab')
    if (await target.evaluate(element => element === document.activeElement)) return presses
  }
  const active = await page.evaluate(() => {
    const element = document.activeElement
    return element ? `${element.tagName.toLowerCase()} ${element.getAttribute('aria-label') ?? element.textContent?.slice(0, 80) ?? ''}` : null
  })
  throw new Error(`Target not reached with ${options.max} ${options.shift ? 'Shift+Tab' : 'Tab'} presses; active element: ${active}`)
}

/** Fail every IndexedDB `put` or `delete` on the records store until restored; count attempts. */
export async function installStoreFault(page: Page, method: 'put' | 'delete') {
  await page.evaluate(<K extends 'put' | 'delete'>(method: K) => {
    const original = IDBObjectStore.prototype[method]
    const probe = { attempts: 0 }
    const faults = (Reflect.get(window, '__undo80Faults') as Record<string, unknown> | undefined) ?? {}
    faults[method] = {
      attempts: probe,
      restore: () => { IDBObjectStore.prototype[method] = original },
    }
    Reflect.set(window, '__undo80Faults', faults)
    IDBObjectStore.prototype[method] = function (this: IDBObjectStore, ...args: unknown[]) {
      if (this.name === 'records') {
        probe.attempts++
        throw new DOMException(`Stage80 synthetic ${method} failure`, method === 'put' ? 'QuotaExceededError' : 'UnknownError')
      }
      return Reflect.apply(original, this, args)
    } as typeof original
  }, method)
  return {
    attempts: () => page.evaluate(method => (Reflect.get(window, '__undo80Faults') as Record<string, { attempts: { attempts: number } }>)[method].attempts.attempts, method),
    restore: () => page.evaluate(method => (Reflect.get(window, '__undo80Faults') as Record<string, { restore: () => void }>)[method].restore(), method),
  }
}

/** Another writer adds or replaces a committed record directly, like a tab whose notification was never delivered. */
export async function writeExternalEntry(page: Page, record: SavedJob, order: number) {
  await page.evaluate(({ name, entry }) => new Promise<void>((resolve, reject) => {
    const opening = indexedDB.open(name)
    opening.onupgradeneeded = () => { opening.transaction?.abort(); reject(new Error('Saved database has not been initialized')) }
    opening.onerror = () => reject(opening.error)
    opening.onsuccess = () => {
      const db = opening.result
      ;(Reflect.get(window, '__savedLifecycleProbe') as { owned: WeakSet<IDBDatabase> } | undefined)?.owned.add(db)
      const tx = db.transaction('records', 'readwrite')
      tx.objectStore('records').put(entry)
      tx.oncomplete = () => { db.close(); resolve() }
      tx.onabort = () => { db.close(); reject(tx.error) }
    }
  }), { name: SAVED_DATABASE_NAME, entry: { id: record.job.id, order, record } })
}

/** An unreadable wrapper for a job id, as a damaged write from an older tab. */
export async function writeDamagedEntry(page: Page, id: string, order: number) {
  await page.evaluate(({ name, entry }) => new Promise<void>((resolve, reject) => {
    const opening = indexedDB.open(name)
    opening.onupgradeneeded = () => { opening.transaction?.abort(); reject(new Error('Saved database has not been initialized')) }
    opening.onerror = () => reject(opening.error)
    opening.onsuccess = () => {
      const db = opening.result
      ;(Reflect.get(window, '__savedLifecycleProbe') as { owned: WeakSet<IDBDatabase> } | undefined)?.owned.add(db)
      const tx = db.transaction('records', 'readwrite')
      tx.objectStore('records').put(entry)
      tx.oncomplete = () => { db.close(); resolve() }
      tx.onabort = () => { db.close(); reject(tx.error) }
    }
  }), { name: SAVED_DATABASE_NAME, entry: { id, order, record: { damaged: 'stage80 unreadable wrapper' } } })
}

export async function deleteExternalEntry(page: Page, id: string) {
  await page.evaluate(({ name, id }) => new Promise<void>((resolve, reject) => {
    const opening = indexedDB.open(name)
    opening.onupgradeneeded = () => { opening.transaction?.abort(); reject(new Error('Saved database has not been initialized')) }
    opening.onerror = () => reject(opening.error)
    opening.onsuccess = () => {
      const db = opening.result
      ;(Reflect.get(window, '__savedLifecycleProbe') as { owned: WeakSet<IDBDatabase> } | undefined)?.owned.add(db)
      const tx = db.transaction('records', 'readwrite')
      tx.objectStore('records').delete(id)
      tx.oncomplete = () => { db.close(); resolve() }
      tx.onabort = () => { db.close(); reject(tx.error) }
    }
  }), { name: SAVED_DATABASE_NAME, id })
}

/** Exactly one recovery region, in the page (not a dialog), after the top saved pager when present and before the saved grid. */
export async function expectRegionBeforeSavedGrid(page: Page) {
  const result = await page.evaluate(name => {
    const regions = [...document.querySelectorAll(`section[aria-label="${name}"]`)]
    const region = regions[0]
    const grid = document.querySelector('.saved-grid')
    const pager = document.querySelector('.saved-pagination')
    const follows = (first: Element, second: Element) => Boolean(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING)
    return {
      count: regions.length,
      insideDialog: region ? region.closest('dialog') !== null : null,
      insideMain: region ? region.closest('main#main-content') !== null : null,
      beforeGrid: region && grid ? follows(region, grid) : null,
      afterTopPager: region && pager ? follows(pager, region) : null,
    }
  }, RECOVERY_REGION)
  expect(result, JSON.stringify(result)).toMatchObject({ count: 1, insideDialog: false, insideMain: true })
  if (result.beforeGrid !== null) expect(result.beforeGrid, 'recovery region must precede the saved grid').toBe(true)
  if (result.afterTopPager !== null) expect(result.afterTopPager, 'recovery region must follow the top pager').toBe(true)
}

/** Exactly one recovery region, inside the given open dialog, after its header close button. */
export async function expectRegionInsideDialog(page: Page, dialog: Locator) {
  const regions = recoveryRegion(page)
  await expect(regions).toHaveCount(1)
  const result = await dialog.evaluate((element, name) => {
    const region = document.querySelector(`section[aria-label="${name}"]`)
    const close = element.querySelector('button[aria-label="닫기"]')
    const body = element.querySelector('.dialog-body') ?? element.querySelector('form') ?? null
    const follows = (first: Element, second: Element) => Boolean(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING)
    return {
      inside: region ? element.contains(region) : false,
      closeBeforeRegion: region && close ? follows(close, region) : null,
      regionBeforeBody: region && body ? follows(region, body) : null,
    }
  }, RECOVERY_REGION)
  expect(result, JSON.stringify(result)).toMatchObject({ inside: true, closeBeforeRegion: true })
  if (result.regionBeforeBody !== null) expect(result.regionBeforeBody, 'recovery region must sit right after the header').toBe(true)
}

/** Exactly one recovery region, inside the explore results panel and not in a dialog. */
export async function expectRegionInsideResultsPanel(page: Page) {
  await expect(recoveryRegion(page)).toHaveCount(1)
  const result = await page.evaluate(({ name, panel }) => {
    const region = document.querySelector(`section[aria-label="${name}"]`)
    return { insidePanel: region ? region.closest(`aside[aria-label="${panel}"]`) !== null : false, insideDialog: region ? region.closest('dialog') !== null : null }
  }, { name: RECOVERY_REGION, panel: RESULTS_PANEL })
  expect(result, JSON.stringify(result)).toEqual({ insidePanel: true, insideDialog: false })
}

export async function attachShot(page: Page, testInfo: TestInfo, name: string) {
  await testInfo.attach(name, { body: await page.screenshot(), contentType: 'image/png' })
}

/** The same DOM node must still be connected and own focus after a passive update. */
export async function expectFocusedControlSurvives(control: Locator) {
  const handle = await control.elementHandle()
  expect(handle).not.toBeNull()
  return {
    async verify() {
      expect(await handle!.evaluate(element => ({ connected: element.isConnected, focused: element === document.activeElement, disabled: (element as HTMLButtonElement).disabled })))
        .toEqual({ connected: true, focused: true, disabled: false })
    },
  }
}

/**
 * Hold the explore view's public catalog read until released. The eventual reply
 * is the ordinary synthetic protocol catalog, so the request finishes normally;
 * only its timing is controlled by the test.
 */
export async function holdCatalog(page: Page) {
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  let served = 0
  await page.route('**/api/catalog?source=public*', async route => {
    await gate
    try { await route.fulfill({ json: publicProtocolCatalog() }); served++ } catch { /* The page abandoned this request while it was held. */ }
  })
  return { release: () => { release() }, served: () => served }
}

/**
 * Hold saved-content comparison: the revision digests awaited by the posting
 * status comparison do not resolve until released. Test-only; nothing touches
 * storage or the posting-status response itself.
 */
export async function holdRevisionDigest(page: Page) {
  await page.evaluate(() => {
    const original = SubtleCrypto.prototype.digest
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    Reflect.set(window, '__undo80DigestRelease', () => { release(); SubtleCrypto.prototype.digest = original })
    SubtleCrypto.prototype.digest = function (this: SubtleCrypto, ...args: Parameters<SubtleCrypto['digest']>) {
      return gate.then(() => Reflect.apply(original, this, args))
    } as SubtleCrypto['digest']
  })
  return { release: () => page.evaluate(() => (Reflect.get(window, '__undo80DigestRelease') as () => void)()) }
}

interface CompletionHoldState { completed: number; delivered: number; queued: number }
/**
 * Test-controlled barrier between a committed readwrite transaction on the
 * saved database and the application's `oncomplete` handler. The native commit
 * is untouched and `completed()` counts the real `complete` events the browser
 * has fired; only the call into the application's handler waits in a queue until
 * `release()`, which restores the native accessor and then drains the queue in
 * order. Readonly transactions, including test reads of committed data, are
 * never held, so a committed row can be observed while the application still
 * waits. Install after the preceding commit has been acknowledged and release
 * before any helper that waits for the saving state to end.
 */
export async function holdCompletionDelivery(page: Page) {
  await page.evaluate(name => {
    const descriptor = Object.getOwnPropertyDescriptor(IDBTransaction.prototype, 'oncomplete')!
    const state = { holding: true, completed: 0, delivered: 0, queue: [] as (() => void)[] }
    Object.defineProperty(IDBTransaction.prototype, 'oncomplete', {
      configurable: true,
      get(this: IDBTransaction) { return descriptor.get!.call(this) },
      set(this: IDBTransaction, handler: ((this: IDBTransaction, event: Event) => unknown) | null) {
        if (typeof handler !== 'function' || this.mode !== 'readwrite' || this.db.name !== name) { descriptor.set!.call(this, handler); return }
        descriptor.set!.call(this, function (this: IDBTransaction, event: Event) {
          state.completed++
          const deliver = () => { state.delivered++; handler.call(this, event) }
          if (state.holding) state.queue.push(deliver); else deliver()
        })
      },
    })
    Reflect.set(window, '__undo80CompletionHold', {
      snapshot: (): CompletionHoldState => ({ completed: state.completed, delivered: state.delivered, queued: state.queue.length }),
      release() {
        state.holding = false
        Object.defineProperty(IDBTransaction.prototype, 'oncomplete', descriptor)
        for (const deliver of state.queue.splice(0)) deliver()
      },
    })
  }, SAVED_DATABASE_NAME)
  const hold = () => page.evaluate(() => (Reflect.get(window, '__undo80CompletionHold') as { snapshot: () => CompletionHoldState }).snapshot())
  return {
    /** Native `complete` events fired for held-scope transactions so far. */
    completed: async () => (await hold()).completed,
    /** Application handlers still waiting. */
    queued: async () => (await hold()).queued,
    delivered: async () => (await hold()).delivered,
    /** Restore the native accessor and deliver every held handler in order. */
    release: () => page.evaluate(() => (Reflect.get(window, '__undo80CompletionHold') as { release: () => void }).release()),
  }
}

/** Wait until the browser has fired exactly `count` native completions for held-scope transactions. */
export async function expectNativeCompletions(hold: Awaited<ReturnType<typeof holdCompletionDelivery>>, count: number) {
  await expect.poll(() => hold.completed(), { message: 'native readwrite completion on the saved database' }).toBe(count)
  expect(await hold.queued()).toBe(count)
  expect(await hold.delivered()).toBe(0)
}

/**
 * Pauses the Playwright Clock that `seedSaved` installed before navigation. The
 * Clock operates throughout the BrowserContext, including all pages and iframes,
 * and controls Date, performance, timeouts, intervals, idle callbacks and
 * animation frames alike: while paused none of them advance, so work the product
 * defers to a later frame stays queued until an explicit `page.clock.runFor(ms)`,
 * and time flows again only after `page.clock.resume()` (call it in `finally`).
 * Callers must first let every pending write settle (saved-commit signal and the
 * committed storage state) and must not use helpers that wait on page timers or
 * frames while paused. The pause point is one second of page time ahead, the
 * repository's established pattern; timers already due inside that second fire
 * once before the pause takes effect. Playwright's own injected scripts are not
 * affected. This stages one controlled interleaving in a loaded, idle Saved
 * view away from any freshness boundary; it is not proof of every real event
 * ordering.
 */
export async function pauseContextClock(page: Page) {
  await page.clock.pauseAt(new Date(await page.evaluate(() => Date.now()) + 1000))
}

/**
 * Test-only frame probe: one plain requestAnimationFrame callback queued through
 * the Clock-controlled scheduler that flips a window flag when it runs. Nothing
 * is replaced, intercepted or given an id, and no product function is touched;
 * the flag only witnesses whether a controlled frame opportunity has occurred
 * since the probe was queued. Queue it after `pauseContextClock`: the flag then
 * stays false until `page.clock.runFor(32)` delivers the frame.
 */
export async function queueFrameProbe(page: Page) {
  await page.evaluate(() => {
    const probe = { fired: false }
    Reflect.set(window, '__undo80FrameProbe', probe)
    requestAnimationFrame(() => { probe.fired = true })
  })
  return {
    /** Whether the probe callback has run since it was queued. */
    fired: () => page.evaluate(() => (Reflect.get(window, '__undo80FrameProbe') as { fired: boolean }).fired),
  }
}

export const pageScroll = (page: Page) => page.evaluate(() => ({ x: window.scrollX, y: window.scrollY }))

/** Observable identity of the focused element, without exposing product internals. */
export const activeElementDescriptor = (page: Page) => page.evaluate(() => {
  const element = document.activeElement
  return {
    tag: element?.tagName ?? null,
    label: element?.getAttribute('aria-label') ?? null,
    text: element?.textContent?.slice(0, 60) ?? null,
    insideOpenDialog: Boolean(element?.closest('dialog[open]')),
    isBody: element === document.body,
  }
})

export async function removeCardByKeyboard(page: Page, record: SavedJob) {
  const remove = cardRemoveButton(page, record)
  await remove.focus()
  await expect(remove).toBeFocused()
  await page.keyboard.press('Enter')
  await waitForSavedCommit(page)
  await expectAbsentFromStorage(page, record.job.id)
}

/** Remove through the card control without waiting for a commit, for flows where a deliberate hold keeps the queue unacknowledged. */
export async function removeCardNoWait(page: Page, record: SavedJob) {
  const remove = cardRemoveButton(page, record)
  await remove.focus()
  await expect(remove).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(cardOf(page, record)).toHaveCount(0)
}
