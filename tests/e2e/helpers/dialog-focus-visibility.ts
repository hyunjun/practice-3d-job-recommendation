/**
 * Stage81 D1 helpers: native keyboard focus visibility inside the native modal
 * dialogs (docs/design/dialog-focus-visibility.md, SHA256 0120a532…).
 *
 * Everything here observes. Nothing focuses, scrolls, frames or otherwise
 * repairs the page before an observation: the probe reads real DOM rectangles,
 * the clipping ancestors, the sticky footer's painted rectangle, read-only text
 * line rectangles and hit tests at several points of the focused control. It
 * never reads product clearance variables and never calls product reveal code,
 * so a product change cannot move the oracle. Fixtures are literal fictional
 * records authored in this file.
 *
 * Indicator rules follow the contract: buttons, links, summaries and focusable
 * regions show a 2px outline with a 4px offset; the saved note and other fields
 * show a #acd778 border with a 2px spread box-shadow and no outline; a toggle is
 * judged by its rendered track. Indicator geometry is checked against the
 * viewport, every clipping ancestor and the footer, with side-specific labels so
 * top-edge clipping is never reported as footer coverage.
 *
 * Only an explicitly identified reading region (role="region", focusable through
 * tabindex, a vertical scroll container whose content actually overflows, and
 * not an action control) may be judged as "oversized-region" when it is taller
 * than the usable area. It then needs a visible entry edge and at least
 * OVERSIZED_CONTEXT_LINES fully visible observed text lines, measured from
 * read-only Range line rectangles inside the region's padding box after its
 * current inner scroll. Every other control, including action controls whose
 * indicator does not fit, is judged for full visibility and reports insufficient
 * usable area explicitly. No editable-region or caret support is claimed.
 *
 * Every native entry (initial Close, each Tab/Shift+Tab arrival, wraps) and
 * every same-element observation in K1 and K2 is judged. Only the K3
 * observations of the still-focused button while the footer changes state and
 * the K4 observations of the still-focused note right after a viewport resize
 * are record-only; their focus/value/selection facts stay asserted by the spec
 * and any visibility failure they record is surfaced as a test annotation.
 */
import { expect } from '@playwright/test'
import type { Page, TestInfo } from '@playwright/test'
import type { SavedJob } from '../../../shared/types'
import { waitForSavedCommit } from './saved-store'

export const GEOMETRY_TOLERANCE_PX = 0.5
/**
 * Proposed criterion for all3 baseline review, not a D1 constant: an oversized
 * reading region must show at least this many fully visible text lines. A line
 * is a merged read-only Range client rectangle of the region's text, and it is
 * fully visible when it lies inside the region's padding box, the viewport,
 * every clipping ancestor and the body area above the footer, at the region's
 * current inner scroll. Nothing is derived from font-size heuristics; when no
 * line rectangle can be measured the stop fails with an explicit
 * metric-unavailable label instead of an invented value.
 */
export const OVERSIZED_CONTEXT_LINES = 2
/** The field indicator declared in src/styles.css:426 (#acd778 border, 2px spread shadow); asserted as rendered colour and spread, never as an outline. */
export const FIELD_INDICATOR = { borderColor: 'rgb(172, 215, 120)', minimumShadowSpreadPx: 2 } as const
/** The generic keyboard indicator declared in src/styles.css:35. */
export const OUTLINE_INDICATOR = { minimumWidthPx: 2 } as const

/** User-visible labels of the stops this baseline names. Each is the rendered text or aria-label, read independently of product code. */
export const LABEL = {
  close: '닫기',
  descriptionSummary: '채용공고 원문 읽기',
  descriptionRegion: '채용공고 원문',
  appliedToggle: '지원 완료로 표시',
  note: '이 기회에 대한 나의 메모',
  footerRemove: '저장 목록에서 제거',
  footerLink: '원문에서 지원하기',
  retry: '저장 다시 시도',
  csv: '현재 내용 CSV로 보관',
  jsonBackup: 'JSON 백업·복원',
  backupOpener: '기록 백업·복원',
  backupDialog: '기록 백업과 복원',
  backupExport: 'JSON 백업',
  backupFile: '백업 또는 복구 파일',
  downloadOriginal: '이 원본 내려받기',
  deleteArchive: '보관본 삭제',
  done: '완료',
  cancelDelete: '삭제 취소',
  confirmDelete: '선택한 보관본 삭제',
  deleteConfirmGroup: '보관본 삭제 확인',
  legacyArchive: '이전 목록의 보관 원본',
} as const

export const ALERT_TEXT = {
  pending: '아직 저장하지 못한 변경이 있어요.',
  quota: '브라우저 저장 공간이 부족해요. CSV로 기록을 보관하고 불필요한 기록을 정리한 뒤 다시 시도해 주세요.',
  keep: '마지막 입력은 이 탭에 남아 있어요. 저장 완료 전에는 탭을 닫지 마세요.',
} as const

export const BACKUP_FOOTER_TEXT = {
  idle: '파일과 메모를 서버에 보내지 않아요.',
  confirmDelete: '선택한 보관본의 삭제 범위를 확인해 주세요.',
} as const

/* --------------------------------------------------------------------------
 * Fictional fixtures. No real company, posting or person is referenced.
 * -------------------------------------------------------------------------- */

const LANTERN_DESCRIPTION = [
  'Fictional posting authored for the stage81 keyboard focus-visibility baseline. It is not a real vacancy.',
  '',
  'About the team',
  'The Lantern Orbit platform group maintains the ingestion, matching and notification services behind a fictional job atlas.',
  'We work in small pairs, review every change and keep the on-call rotation humane. Nothing in this text describes a real employer.',
  '',
  'What you would do',
  '- Design TypeScript services that ingest fictional postings from several boards and reconcile duplicates.',
  '- Evolve PostgreSQL schemas with online migrations and measurable rollback plans.',
  '- Operate Kubernetes workloads with clear ownership and documented runbooks.',
  '- Improve GraphQL contracts used by the web client and the notification pipeline.',
  '- Mentor engineers through pairing, design reviews and written proposals.',
  '- Keep Redis caching honest: measured hit rates, explicit invalidation and no silent staleness.',
  '',
  'What we look for',
  '- Production experience with TypeScript services and PostgreSQL schema design.',
  '- At least five years of backend engineering experience.',
  '- Comfort reading unfamiliar code and leaving it clearer than you found it.',
  '- Writing that helps a reader decide, not writing that performs.',
  '',
  'Nice to have',
  '- Kubernetes operations or Go tooling experience.',
  '- Familiarity with accessibility requirements for keyboard-driven interfaces.',
  '- Experience with fixture-driven end-to-end testing.',
  '',
  'How we work',
  'Hybrid: three days per week in the fictional London office, two days remote within the United Kingdom.',
  'Core collaboration hours are 10:00 to 15:00 London time; the rest of the day is flexible.',
  'Every incident gets a blameless review. Every review produces at most three follow-ups.',
  '',
  'Compensation',
  'Base salary £95,000–£120,000 per year for London-based staff engineers (fictional figure).',
  'Equity, bonus and relocation support are described separately and are not included in the range above.',
  '',
  'Right to work',
  'Candidates must already hold or be eligible to obtain the right to work in the United Kingdom (fictional condition).',
  'Visa sponsorship is assessed case by case (fictional statement).',
  '',
  'Interview process',
  '1. A 30 minute conversation about your experience and what you want next.',
  '2. A take-home exercise reviewed together, never in isolation.',
  '3. A systems conversation about a service you know well.',
  '4. A conversation with the people you would work with most.',
  '',
  'Reading note',
  '이 문단은 긴 원문 영역이 키보드로 스크롤되는지 확인하기 위한 가상의 한국어 문장입니다.',
  '원문 영역은 최대 420px 높이에서 내부 스크롤되며, 바깥 대화상자는 함께 움직이지 않아야 합니다.',
  'Thank you for reading a fictional posting to its end.',
].join('\n')

/** A long fictional saved posting with several disclosure sections, so the detail overflows and offers intermediate Tab stops. */
export const LANTERN: SavedJob = {
  job: {
    id: 'greenhouse-lantern-orbit-81', companyId: 'lantern-orbit',
    title: 'Staff Backend Engineer · Fictional Long Detail For Keyboard Focus Visibility 81',
    role: 'backend', cityIds: ['london'], locationLabel: 'London, United Kingdom',
    workMode: 'hybrid', employment: 'fulltime', minExperience: 5,
    skills: ['TypeScript', 'PostgreSQL', 'Kubernetes', 'Go', 'GraphQL', 'Redis'],
    salary: null,
    compensationNote: 'Fictional compensation note: the base range below is quoted for the London office and excludes equity, bonus and relocation support.',
    compensationRanges: [{
      label: 'London base salary (fictional)', min: 95000, max: 120000, currency: 'GBP', period: 'year', basis: 'base',
      scope: 'Hybrid staff engineers based in the London office',
      evidence: { source: 'description', text: 'Base salary £95,000–£120,000 per year for London-based staff engineers (fictional figure).' },
    }],
    visa: 'unknown',
    eligibility: {
      version: 2,
      rules: [{ kind: 'work-authorization', level: 'conditional', evidence: { source: 'description', text: 'Candidates must already hold or be eligible to obtain the right to work in the United Kingdom (fictional condition).' } }],
    },
    qualifications: {
      version: 1,
      skills: [
        { kind: 'required', skills: ['TypeScript', 'PostgreSQL'], match: 'all', evidence: { source: 'description', text: 'Production experience with TypeScript services and PostgreSQL schema design.' } },
        { kind: 'preferred', skills: ['Kubernetes', 'Go'], match: 'any', evidence: { source: 'description', text: 'Kubernetes operations or Go tooling experience.' } },
      ],
      experience: [{ kind: 'required', minYears: 5, conditional: false, evidence: { source: 'description', text: 'At least five years of backend engineering experience.' } }],
    },
    evidence: {
      visa: { source: 'description', text: 'Visa sponsorship is assessed case by case (fictional statement).' },
      workMode: { source: 'description', text: 'Hybrid: three days per week in the fictional London office, two days remote within the United Kingdom.' },
      employment: { source: 'board', text: 'Full-time (fictional board metadata).' },
    },
    remoteCountries: [], remoteWorldwide: false, remoteScopeUnknown: false,
    description: LANTERN_DESCRIPTION,
    requirements: [
      'Production experience with TypeScript services and PostgreSQL schema design.',
      'At least five years of backend engineering experience.',
      'Comfort reading unfamiliar code and leaving it clearer than you found it.',
      'Kubernetes operations or Go tooling experience (nice to have).',
    ],
    url: 'https://example.org/focus81/greenhouse-lantern-orbit-81', source: 'greenhouse',
    updatedAt: null, fetchedAt: '2026-09-30T07:00:00.000Z',
  },
  company: {
    id: 'lantern-orbit', name: 'Lantern Orbit Fictional Research Studio', initials: 'LO', color: '#9cc2e5',
    industry: 'Fictional research software studio', careerUrl: 'https://example.org/lantern-orbit/careers',
    provider: 'greenhouse', board: 'lantern-orbit',
  },
  savedAt: '2026-09-27T09:00:00.000Z', status: 'saved', note: '',
}

/** A short fictional record for the backup dialog case; its detail is never opened there. */
export const BEACON: SavedJob = {
  job: {
    id: 'greenhouse-beacon-harbor-81', companyId: 'beacon-harbor', title: 'Beacon 81 · Data Platform Engineer', role: 'data', cityIds: ['london'],
    locationLabel: 'London, UK', workMode: 'onsite', employment: 'fulltime',
    minExperience: 3, skills: ['Python', 'Spark'], salary: null, visa: 'unknown',
    remoteCountries: [], remoteWorldwide: false, remoteScopeUnknown: false,
    description: 'Fictional data platform role for the stage81 backup-footer baseline. Required: 3 years of data engineering experience with Python and Spark.',
    requirements: ['3 years of data engineering experience with Python and Spark.'],
    url: 'https://example.org/focus81/greenhouse-beacon-harbor-81', source: 'greenhouse',
    updatedAt: null, fetchedAt: '2026-09-29T07:00:00.000Z',
  },
  company: {
    id: 'beacon-harbor', name: 'Beacon Harbor', initials: 'BH', color: '#d9c066',
    industry: 'Fictional data studio', careerUrl: 'https://example.org/beacon-harbor/careers',
    provider: 'greenhouse', board: 'beacon-harbor',
  },
  savedAt: '2026-09-29T08:00:00.000Z', status: 'saved', note: 'FICTIONAL81 beacon note kept while the backup footer changes',
}

/** An unreadable legacy entry: migration keeps it as a "legacy" recovery source, which the backup dialog lists with download and delete actions. */
export const LEGACY_UNREADABLE_ENTRY = { invalid: 'FICTIONAL81 unreadable legacy original kept as a recovery source' }

/** Literal draft typed with real key events. The first character is typed alone so the first failed-save notice can be observed before the rest. */
export const K2_FIRST_CHARACTER = 'K'
export const K2_REMAINDER = 'eyboard draft 81 via Tab entry'
export const K2_DRAFT = `${K2_FIRST_CHARACTER}${K2_REMAINDER}`
export const K4_DRAFT = 'resize 81'

/* --------------------------------------------------------------------------
 * Preparation (clearly outside the measured keyboard sequence).
 * -------------------------------------------------------------------------- */

/** Seed the legacy localStorage key exactly as other suites do. No Playwright Clock is installed: page timers and frames run on real time. */
export async function seedSavedWithoutClock(page: Page, records: unknown[]) {
  await page.addInitScript(raw => {
    localStorage.setItem('orbit.v1.saved', raw)
    localStorage.setItem('orbit.v1.exploration', JSON.stringify({ source: 'public', mapMode: 'flat' }))
  }, JSON.stringify(records))
}

export async function openSavedViewPlain(page: Page, titles: string[]) {
  await page.goto('/#saved')
  await waitForSavedCommit(page)
  await expect(page.locator('.saved-title')).toHaveText(titles)
}

/** Fonts loaded and two animation frames rendered after a preparation step; a bounded readiness wait, never an arbitrary sleep. */
export async function expectLayoutReady(page: Page, label: string) {
  const readiness = await page.evaluate(async () => {
    await document.fonts.ready
    const frames = await Promise.race<string>([
      new Promise<string>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve('two-animation-frames')))),
      new Promise<string>(resolve => setTimeout(() => resolve('animation-frame-timeout'), 1000)),
    ])
    return { fontsStatus: document.fonts.status, frames }
  })
  expect(readiness, `${label}: fonts must be loaded and two frames rendered before measuring`).toEqual({ fontsStatus: 'loaded', frames: 'two-animation-frames' })
  return readiness
}

/** Press one key with real key events, then wait for two animation frames so the painted state is measured. */
export async function pressKey(page: Page, key: string) {
  await page.keyboard.press(key)
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
}

/* --------------------------------------------------------------------------
 * The passive geometry probe of the focused control.
 * -------------------------------------------------------------------------- */

export interface Rect { left: number; top: number; right: number; bottom: number; width: number; height: number }
export interface Box { left: number; top: number; right: number; bottom: number }
/** One rendered text line: merged read-only Range client rectangles whose vertical spans overlap. */
export interface LineBox { left: number; top: number; right: number; bottom: number; height: number }
export interface ClippingAncestor { description: string; clientBox: Rect; clipsX: boolean; clipsY: boolean }
export interface HitSample { label: string; x: number; y: number; hit: string | null; ok: boolean }
export type IndicatorKind = 'outline' | 'border-shadow' | 'toggle-track' | 'none'

export interface FooterChild { descriptor: string; rect: Rect; textLines: LineBox[]; textLineCount: number }
export interface FooterGeometry {
  rect: Rect
  position: string
  text: string
  children: FooterChild[]
  /** Rows of vertically separated, non-overlapping child rectangles (children overlapping vertically share a row). */
  childRows: number
  /** Largest number of rendered text lines inside one child. */
  maxTextLinesInChild: number
  /** True when children occupy two or more rows or a child's text wraps onto two or more lines. */
  wrapped: boolean
}

export interface ReadingRegion {
  /** role="region", focusable through tabindex, vertical scroll container with actual inner overflow, not an action control. */
  identified: boolean
  reasons: string[]
  role: string | null
  tabIndex: string | null
  overflowY: string
  scrollable: boolean
  /** Padding box of the region: the area where its own content is painted after inner clipping. */
  clientBox: Rect
  padding: { top: number; right: number; bottom: number; left: number }
  /** Merged text line rectangles of the region's content at its current inner scroll (bounded list). */
  lineBoxes: LineBox[]
  lineCount: number
  observedLineHeightPx: { min: number; median: number; max: number } | null
}

export interface ActiveProbe {
  fontsStatus: string
  viewport: { width: number; height: number }
  windowScroll: { x: number; y: number }
  /** The open native dialog: its scrollport (client box), scroll metrics and whether its content overflows. */
  dialog: { name: string | null; clientBox: Rect; scrollTop: number; scrollHeight: number; clientHeight: number; overflowing: boolean } | null
  /** The dialog's own footer as painted right now. */
  footer: FooterGeometry | null
  /** Scrollport minus the footer's painted rectangle; the vertical band where body content is actually visible. */
  availableArea: { top: number; bottom: number; height: number } | null
  noteAlert: Rect | null
  recoveryConfirm: Rect | null
  active: {
    descriptor: string
    name: string
    tag: string
    isBody: boolean
    isDialog: boolean
    insideDialog: boolean
    footerOwned: boolean
    disabled: boolean
    rect: Rect
    clippingAncestors: ClippingAncestor[]
    focusVisible: boolean
    visibility: string
    opacity: number
    /** Computed style metadata only; never the context criterion. */
    textMetrics: { fontSizePx: number; lineHeight: string }
    readingRegion: ReadingRegion | null
    indicator: {
      kind: IndicatorKind
      rect: Rect | null
      proxy: string | null
      outlineStyle: string
      outlineWidth: number
      outlineOffset: number
      outlineColor: string | null
      borderColor: string | null
      boxShadow: string | null
      shadowSpread: number | null
    }
    hits: HitSample[]
    entryHits: HitSample[]
    value: string | null
    selection: { start: number; end: number; direction: string } | null
    innerScroll: { scrollTop: number; scrollHeight: number; clientHeight: number; scrollable: boolean } | null
    detailsOpen: boolean | null
    href: string | null
  }
}

/** Runs inside the page. Self-contained on purpose: it is serialized by Playwright and must not reference module scope. */
function probeInPage(): ActiveProbe {
  const actionTags = ['button', 'a', 'input', 'select', 'summary', 'textarea']
  const actionRoles = ['button', 'link', 'checkbox', 'radio', 'switch', 'tab', 'menuitem', 'option', 'textbox', 'combobox', 'slider', 'spinbutton']
  const round = (value: number) => Math.round(value * 100) / 100
  const toRect = (box: DOMRect): Rect => ({ left: round(box.left), top: round(box.top), right: round(box.right), bottom: round(box.bottom), width: round(box.width), height: round(box.height) })
  const clientBox = (element: Element): Rect => {
    const box = element.getBoundingClientRect()
    const left = box.left + element.clientLeft
    const top = box.top + element.clientTop
    return { left: round(left), top: round(top), right: round(left + element.clientWidth), bottom: round(top + element.clientHeight), width: round(element.clientWidth), height: round(element.clientHeight) }
  }
  const expand = (rect: Rect, by: number): Rect => ({
    left: round(rect.left - by), top: round(rect.top - by), right: round(rect.right + by), bottom: round(rect.bottom + by),
    width: round(rect.width + 2 * by), height: round(rect.height + 2 * by),
  })
  const describe = (element: Element | null): string | null => {
    if (!element) return null
    const classes = Array.from(element.classList).slice(0, 4).map(name => `.${name}`).join('')
    const label = element.getAttribute('aria-label')
    return `${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : ''}${classes}${label ? `[aria-label=${label}]` : ''}`
  }
  const normalize = (value: string | null | undefined) => (value ?? '').replace(/\s+/g, ' ').trim().slice(0, 80)
  const nameOf = (element: Element): string => {
    const aria = element.getAttribute('aria-label')
    if (aria) return normalize(aria)
    if (element.id) {
      const label = document.querySelector(`label[for="${CSS.escape(element.id)}"]`)
      if (label) return normalize(label.textContent)
    }
    return normalize(element.textContent)
  }
  /** Read-only text line rectangles: Range client rects of every non-blank text node, merged when their vertical spans overlap by more than half of the smaller height. */
  const lineBoxesOf = (root: Element, limit: number): LineBox[] => {
    const rects: DOMRect[] = []
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    let node: Node | null = walker.nextNode()
    while (node && rects.length < limit) {
      if ((node.textContent ?? '').trim()) {
        const range = document.createRange()
        range.selectNodeContents(node)
        for (const rect of Array.from(range.getClientRects())) {
          if (rect.width > 0 && rect.height > 0) rects.push(rect)
          if (rects.length >= limit) break
        }
        range.detach()
      }
      node = walker.nextNode()
    }
    rects.sort((a, b) => a.top - b.top || a.left - b.left)
    const lines: LineBox[] = []
    for (const rect of rects) {
      const last = lines[lines.length - 1]
      if (last) {
        const overlap = Math.min(last.bottom, rect.bottom) - Math.max(last.top, rect.top)
        const smaller = Math.min(last.bottom - last.top, rect.height)
        if (overlap > smaller / 2) {
          last.top = Math.min(last.top, rect.top); last.bottom = Math.max(last.bottom, rect.bottom)
          last.left = Math.min(last.left, rect.left); last.right = Math.max(last.right, rect.right)
          last.height = last.bottom - last.top
          continue
        }
      }
      lines.push({ left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, height: rect.height })
    }
    return lines.map(line => ({ left: round(line.left), top: round(line.top), right: round(line.right), bottom: round(line.bottom), height: round(line.height) }))
  }
  /** Rows of vertically separated, non-overlapping child rectangles: a child starting below the current row's bottom opens a new row. */
  const childRowsOf = (rects: Rect[]): number => {
    const sorted = rects.slice().sort((a, b) => a.top - b.top)
    let rows = 0
    let rowBottom = Number.NEGATIVE_INFINITY
    for (const rect of sorted) {
      if (rect.top >= rowBottom - 0.5) { rows++; rowBottom = rect.bottom } else rowBottom = Math.max(rowBottom, rect.bottom)
    }
    return rows
  }

  const dialog = document.querySelector<HTMLDialogElement>('dialog[open]')
  const footer = dialog ? dialog.querySelector<HTMLElement>(':scope > .dialog-footer') : null
  const footerRect = footer ? toRect(footer.getBoundingClientRect()) : null
  let footerGeometry: FooterGeometry | null = null
  if (footer && footerRect) {
    const children: FooterChild[] = Array.from(footer.children).filter(child => child.getClientRects().length > 0).map(child => {
      const textLines = lineBoxesOf(child, 40)
      return { descriptor: describe(child) ?? child.tagName.toLowerCase(), rect: toRect(child.getBoundingClientRect()), textLines, textLineCount: textLines.length }
    })
    const childRows = childRowsOf(children.map(child => child.rect))
    const maxTextLinesInChild = children.reduce((most, child) => Math.max(most, child.textLineCount), 0)
    footerGeometry = {
      rect: footerRect, position: getComputedStyle(footer).position, text: normalize(footer.textContent),
      children, childRows, maxTextLinesInChild, wrapped: childRows >= 2 || maxTextLinesInChild >= 2,
    }
  }
  const port = dialog ? clientBox(dialog) : null
  let availableArea: ActiveProbe['availableArea'] = null
  if (port) {
    const bottom = footerRect ? Math.min(port.bottom, footerRect.top) : port.bottom
    availableArea = { top: port.top, bottom: round(bottom), height: round(Math.max(0, bottom - port.top)) }
  }
  const titleId = dialog?.getAttribute('aria-labelledby')
  const dialogName = titleId ? normalize(document.getElementById(titleId)?.textContent) : null
  const alert = dialog?.querySelector('.saved-note-section [role="alert"]') ?? null
  const confirm = dialog?.querySelector('.saved-recovery-confirm') ?? null

  const activeElement = document.activeElement
  const target = activeElement && activeElement !== document.body ? activeElement : null
  const empty: Rect = { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }
  const base: ActiveProbe = {
    fontsStatus: document.fonts.status,
    viewport: { width: document.documentElement.clientWidth, height: document.documentElement.clientHeight },
    windowScroll: { x: round(window.scrollX), y: round(window.scrollY) },
    dialog: dialog && port ? {
      name: dialogName, clientBox: port, scrollTop: round(dialog.scrollTop), scrollHeight: dialog.scrollHeight, clientHeight: dialog.clientHeight,
      overflowing: dialog.scrollHeight > dialog.clientHeight + 1,
    } : null,
    footer: footerGeometry,
    availableArea,
    noteAlert: alert ? toRect(alert.getBoundingClientRect()) : null,
    recoveryConfirm: confirm ? toRect(confirm.getBoundingClientRect()) : null,
    active: {
      descriptor: describe(activeElement) ?? 'none', name: '', tag: activeElement?.tagName.toLowerCase() ?? 'none',
      isBody: activeElement === document.body || activeElement === null, isDialog: activeElement === dialog, insideDialog: false, footerOwned: false, disabled: false,
      rect: empty, clippingAncestors: [], focusVisible: false, visibility: 'none', opacity: 0,
      textMetrics: { fontSizePx: 0, lineHeight: 'none' }, readingRegion: null,
      indicator: { kind: 'none', rect: null, proxy: null, outlineStyle: 'none', outlineWidth: 0, outlineOffset: 0, outlineColor: null, borderColor: null, boxShadow: null, shadowSpread: null },
      hits: [], entryHits: [], value: null, selection: null, innerScroll: null, detailsOpen: null, href: null,
    },
  }
  if (!target) return base

  // A toggle's real control is its rendered track; the 1px transparent input only carries focus.
  const toggleParent = target instanceof HTMLInputElement && target.type === 'checkbox' ? target.parentElement : null
  const toggleTrack = toggleParent?.classList.contains('toggle-row') ? toggleParent.querySelector<HTMLElement>('.toggle-track') : null
  const measured: Element = toggleTrack ?? target
  const rect = toRect(measured.getBoundingClientRect())
  const style = getComputedStyle(measured)
  const outlineWidth = Number.parseFloat(style.outlineWidth) || 0
  const outlineOffset = Number.parseFloat(style.outlineOffset) || 0
  const outlineOn = style.outlineStyle !== 'none' && outlineWidth > 0
  const isField = measured instanceof HTMLTextAreaElement || measured instanceof HTMLInputElement || measured instanceof HTMLSelectElement
  const shadowMatch = /(-?[\d.]+)px\s+(-?[\d.]+)px\s+(-?[\d.]+)px\s+(-?[\d.]+)px/.exec(style.boxShadow)
  const shadowSpread = shadowMatch ? Number.parseFloat(shadowMatch[4]) : null
  const indicator: ActiveProbe['active']['indicator'] = {
    kind: 'none', rect: null, proxy: toggleTrack ? describe(toggleTrack) : null,
    outlineStyle: style.outlineStyle, outlineWidth, outlineOffset, outlineColor: outlineOn ? style.outlineColor : null,
    borderColor: isField ? style.borderTopColor : null, boxShadow: style.boxShadow === 'none' ? null : style.boxShadow, shadowSpread,
  }
  if (toggleTrack && outlineOn) { indicator.kind = 'toggle-track'; indicator.rect = expand(rect, outlineOffset + outlineWidth) }
  else if (outlineOn) { indicator.kind = 'outline'; indicator.rect = expand(rect, outlineOffset + outlineWidth) }
  else if (isField && shadowSpread !== null && shadowSpread > 0) { indicator.kind = 'border-shadow'; indicator.rect = expand(rect, shadowSpread) }

  const belongs = (hit: Element | null) => hit !== null && (hit === measured || measured.contains(hit) || hit === target || target.contains(hit))
  const sample = (label: string, x: number, y: number): HitSample => {
    const hit = document.elementFromPoint(x, y)
    return { label, x: round(x), y: round(y), hit: describe(hit), ok: belongs(hit) }
  }
  const inset = Math.min(3, rect.width / 4, rect.height / 4)
  const centreX = rect.left + rect.width / 2
  const hits = [
    sample('center', centreX, rect.top + rect.height / 2),
    sample('top-left', rect.left + inset, rect.top + inset), sample('top-right', rect.right - inset, rect.top + inset),
    sample('bottom-left', rect.left + inset, rect.bottom - inset), sample('bottom-right', rect.right - inset, rect.bottom - inset),
  ]
  const entryHits = [
    sample('entry-left', rect.left + inset, rect.top + inset), sample('entry-center', centreX, rect.top + inset),
    sample('entry-right', rect.right - inset, rect.top + inset), sample('entry-second-line', centreX, rect.top + Math.min(24, rect.height / 2)),
  ]
  const clippingAncestors: ClippingAncestor[] = []
  for (let ancestor = measured.parentElement; ancestor && ancestor !== document.body && ancestor !== document.documentElement; ancestor = ancestor.parentElement) {
    const ancestorStyle = getComputedStyle(ancestor)
    const overflowX = ancestorStyle.overflowX
    const overflowY = ancestorStyle.overflowY
    if (overflowX === 'visible' && overflowY === 'visible') continue
    clippingAncestors.push({
      description: describe(ancestor) ?? ancestor.tagName.toLowerCase(), clientBox: clientBox(ancestor),
      clipsX: overflowX !== 'visible' || overflowY !== 'clip', clipsY: overflowY !== 'visible' || overflowX !== 'clip',
    })
  }
  let value: string | null = null
  let selection: ActiveProbe['active']['selection'] = null
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement) {
    value = target.value
    try {
      if (typeof target.selectionStart === 'number' && typeof target.selectionEnd === 'number') {
        selection = { start: target.selectionStart, end: target.selectionEnd, direction: target.selectionDirection ?? 'none' }
      }
    } catch { selection = null }
  } else if (target instanceof HTMLSelectElement) value = target.value
  const targetStyle = getComputedStyle(target)
  const tag = target.tagName.toLowerCase()
  const innerScroll = /(auto|scroll)/.test(targetStyle.overflowY)
    ? { scrollTop: round(target.scrollTop), scrollHeight: target.scrollHeight, clientHeight: target.clientHeight, scrollable: target.scrollHeight > target.clientHeight + 1 }
    : null

  // Explicit reading-region identity: role="region", focusable through tabindex, a vertical scroll container whose content
  // actually overflows, and neither an action tag nor an interactive role. Only such an element can be oversized-region.
  const role = target.getAttribute('role')
  const tabIndex = target.getAttribute('tabindex')
  const regionReasons: string[] = []
  if (role !== 'region') regionReasons.push(`role=${role ?? 'none'}`)
  if (tabIndex === null) regionReasons.push('no-tabindex')
  if (!innerScroll) regionReasons.push(`overflow-y=${targetStyle.overflowY}`)
  else if (!innerScroll.scrollable) regionReasons.push('content-does-not-overflow')
  if (actionTags.includes(tag)) regionReasons.push(`action-tag=${tag}`)
  if (role && actionRoles.includes(role)) regionReasons.push(`action-role=${role}`)
  let readingRegion: ReadingRegion | null = null
  if (innerScroll || role === 'region') {
    const lineBoxes = lineBoxesOf(target, 400).slice(0, 200)
    const heights = lineBoxes.map(line => line.height).sort((a, b) => a - b)
    readingRegion = {
      identified: regionReasons.length === 0, reasons: regionReasons, role, tabIndex, overflowY: targetStyle.overflowY, scrollable: innerScroll?.scrollable ?? false,
      clientBox: clientBox(target),
      padding: {
        top: Number.parseFloat(targetStyle.paddingTop) || 0, right: Number.parseFloat(targetStyle.paddingRight) || 0,
        bottom: Number.parseFloat(targetStyle.paddingBottom) || 0, left: Number.parseFloat(targetStyle.paddingLeft) || 0,
      },
      lineBoxes, lineCount: lineBoxes.length,
      observedLineHeightPx: heights.length ? { min: heights[0], median: heights[Math.floor(heights.length / 2)], max: heights[heights.length - 1] } : null,
    }
  }
  base.active = {
    descriptor: describe(target) ?? tag, name: nameOf(target), tag,
    isBody: false, isDialog: target === dialog, insideDialog: Boolean(dialog && dialog.contains(target)),
    footerOwned: Boolean(footer && footer.contains(target)),
    disabled: 'disabled' in target && (target as HTMLButtonElement).disabled === true,
    rect, clippingAncestors, focusVisible: target.matches(':focus-visible'),
    visibility: targetStyle.visibility, opacity: Number.parseFloat(targetStyle.opacity),
    textMetrics: { fontSizePx: round(Number.parseFloat(targetStyle.fontSize) || 0), lineHeight: targetStyle.lineHeight },
    readingRegion, indicator, hits, entryHits, value, selection, innerScroll,
    detailsOpen: tag === 'summary' && target.parentElement instanceof HTMLDetailsElement ? target.parentElement.open : null,
    href: target instanceof HTMLAnchorElement ? target.href : null,
  }
  return base
}

export async function probeActive(page: Page): Promise<ActiveProbe> {
  return page.evaluate(probeInPage)
}

/* --------------------------------------------------------------------------
 * Assessment against the contract (node side, from recorded geometry only).
 * -------------------------------------------------------------------------- */

export type StopKind = 'ordinary' | 'footer-owned' | 'oversized-region' | 'invalid'
export interface StopAssessment {
  kind: StopKind
  failures: string[]
  /** Footer rectangle for footer-owned controls, otherwise the body band (scrollport width × usable height). */
  applicableArea: Box | null
  /** Nonnegative intersection of the control rectangle with the viewport, every clipping ancestor and the applicable area. */
  visibleBox: Rect | null
  visibleHeight: number | null
  indicatorHeight: number | null
  availableHeight: number | null
  /** Oversized regions only: fully visible text lines inside the region's clip, the required count and the observed median line height. */
  readingContext: { fullyVisibleLines: number; requiredLines: number; observedMedianLineHeightPx: number | null; visibleClip: Rect } | null
}

const round2 = (value: number) => Math.round(value * 100) / 100
type Sides = { left: boolean; right: boolean; top: boolean; bottom: boolean }
const ALL_SIDES: Sides = { left: true, right: true, top: true, bottom: true }
const sidesOutside = (inner: Box, outer: Box, sides: Sides, tol: number): string[] => {
  const out: string[] = []
  if (sides.left && inner.left < outer.left - tol) out.push('left')
  if (sides.right && inner.right > outer.right + tol) out.push('right')
  if (sides.top && inner.top < outer.top - tol) out.push('top')
  if (sides.bottom && inner.bottom > outer.bottom + tol) out.push('bottom')
  return out
}
const axesOf = (ancestor: ClippingAncestor, vertical: boolean): Sides => ({ left: ancestor.clipsX, right: ancestor.clipsX, top: ancestor.clipsY, bottom: ancestor.clipsY && vertical })
const intersect = (inner: Box, outer: Box, axes: { x: boolean; y: boolean }): Box => ({
  left: axes.x ? Math.max(inner.left, outer.left) : inner.left, right: axes.x ? Math.min(inner.right, outer.right) : inner.right,
  top: axes.y ? Math.max(inner.top, outer.top) : inner.top, bottom: axes.y ? Math.min(inner.bottom, outer.bottom) : inner.bottom,
})
const toVisibleRect = (box: Box): Rect => {
  const width = Math.max(0, box.right - box.left)
  const height = Math.max(0, box.bottom - box.top)
  return { left: round2(box.left), top: round2(box.top), right: round2(width ? box.right : box.left), bottom: round2(height ? box.bottom : box.top), width: round2(width), height: round2(height) }
}
const within = (inner: Box, outer: Box, tol: number) => sidesOutside(inner, outer, ALL_SIDES, tol).length === 0
const coveredText = (samples: HitSample[]) => samples.filter(sample => !sample.ok).map(sample => `${sample.label}=${sample.hit ?? 'null'}`).join(',')

/**
 * D1 requirements 1, 2 and 10.
 * - ordinary (default for every control, including action controls whose indicator does not fit): the control and
 *   its indicator lie inside the viewport, inside every clipping ancestor on the axes it clips, and above the
 *   footer; the five control samples hit the control; insufficient usable area is reported explicitly.
 * - footer-owned: inside its footer; control and indicator inside the viewport and clipping ancestors; samples hit.
 * - oversized-region: only an explicitly identified, genuinely overflowing reading region whose indicator is taller
 *   than the usable area. Its entry edge must be inside the usable area, at least OVERSIZED_CONTEXT_LINES text lines
 *   must be fully visible inside the region's padding box ∩ viewport ∩ clipping ancestors ∩ body area at the current
 *   inner scroll, horizontal clipping and indicator top/side clipping are still failures, and the entry samples must
 *   hit the region. Access to all of its content is not proven here (D2 obligation).
 */
export function assessStop(probe: ActiveProbe): StopAssessment {
  const tol = GEOMETRY_TOLERANCE_PX
  const failures: string[] = []
  const { active, availableArea, footer, viewport, dialog } = probe
  if (!dialog) failures.push('no-open-dialog')
  if (active.isBody) failures.push('focus-on-body')
  else if (active.isDialog) failures.push('focus-on-dialog-element')
  else if (!active.insideDialog) failures.push(`focus-outside-dialog:${active.descriptor}`)
  if (!dialog || !availableArea || active.isBody || active.isDialog || !active.insideDialog) {
    return { kind: 'invalid', failures, applicableArea: null, visibleBox: null, visibleHeight: null, indicatorHeight: null, availableHeight: availableArea?.height ?? null, readingContext: null }
  }
  const rect = active.rect
  const indicatorRect = active.indicator.rect ?? rect
  const viewportBox: Box = { left: 0, top: 0, right: viewport.width, bottom: viewport.height }
  const bodyArea: Box = { left: dialog.clientBox.left, right: dialog.clientBox.right, top: availableArea.top, bottom: availableArea.bottom }
  const applicableArea: Box = active.footerOwned && footer ? footer.rect : bodyArea
  const fits = indicatorRect.height <= availableArea.height + tol
  const region = active.readingRegion
  const kind: StopKind = active.footerOwned ? 'footer-owned' : region?.identified && !fits ? 'oversized-region' : 'ordinary'

  let visible: Box = { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom }
  visible = intersect(visible, viewportBox, { x: true, y: true })
  for (const ancestor of active.clippingAncestors) visible = intersect(visible, ancestor.clientBox, { x: ancestor.clipsX, y: ancestor.clipsY })
  visible = intersect(visible, applicableArea, { x: true, y: true })
  const visibleBox = toVisibleRect(visible)

  if (!active.focusVisible) failures.push('focus-visible-false')
  if (active.visibility !== 'visible') failures.push(`control-visibility:${active.visibility}`)
  switch (active.indicator.kind) {
    case 'none':
      failures.push('no-focus-indicator')
      break
    case 'border-shadow':
      if (active.indicator.borderColor !== FIELD_INDICATOR.borderColor) failures.push(`field-border-colour:${active.indicator.borderColor}`)
      if ((active.indicator.shadowSpread ?? 0) < FIELD_INDICATOR.minimumShadowSpreadPx) failures.push(`field-shadow-spread:${active.indicator.shadowSpread}`)
      break
    default:
      if (active.indicator.outlineWidth < OUTLINE_INDICATOR.minimumWidthPx) failures.push(`outline-width:${active.indicator.outlineWidth}`)
  }

  // Control and indicator against the viewport and every clipping ancestor (BT2). For an oversized region the
  // bottom edge is expected to be clipped; its top and sides are not.
  const vertical = kind !== 'oversized-region'
  const controlSides: Sides = { ...ALL_SIDES, bottom: vertical }
  const outsideViewport = sidesOutside(rect, viewportBox, controlSides, tol)
  if (outsideViewport.length) failures.push(`control-outside-viewport:${outsideViewport.join('+')}`)
  const indicatorOutsideViewport = sidesOutside(indicatorRect, viewportBox, controlSides, tol)
  if (indicatorOutsideViewport.length) failures.push(`indicator-outside-viewport:${indicatorOutsideViewport.join('+')}`)
  for (const ancestor of active.clippingAncestors) {
    const clipped = sidesOutside(rect, ancestor.clientBox, axesOf(ancestor, vertical), tol)
    if (clipped.length) failures.push(`clipped-by:${ancestor.description}:${clipped.join('+')}`)
    const indicatorClipped = sidesOutside(indicatorRect, ancestor.clientBox, axesOf(ancestor, vertical), tol)
    if (indicatorClipped.length) failures.push(`indicator-clipped-by:${ancestor.description}:${indicatorClipped.join('+')}`)
  }

  let readingContext: StopAssessment['readingContext'] = null
  if (kind === 'footer-owned') {
    const outsideFooter = footer ? sidesOutside(rect, footer.rect, ALL_SIDES, tol) : ['no-footer']
    if (outsideFooter.length) failures.push(`footer-control-outside-footer:${outsideFooter.join('+')}`)
    const covered = coveredText(active.hits)
    if (covered) failures.push(`covered-at:${covered}`)
  } else if (kind === 'ordinary') {
    if (!fits) failures.push(`insufficient-available-area:${indicatorRect.height}>${availableArea.height}`)
    if (rect.bottom > bodyArea.bottom + tol) failures.push(`control-behind-footer:${rect.bottom}>${bodyArea.bottom}`)
    if (indicatorRect.bottom > bodyArea.bottom + tol) failures.push(`indicator-behind-footer:${indicatorRect.bottom}>${bodyArea.bottom}`)
    const covered = coveredText(active.hits)
    if (covered) failures.push(`covered-at:${covered}`)
  } else if (region) {
    if (rect.top < bodyArea.top - tol) failures.push(`oversized-entry-edge-hidden:${rect.top}<${bodyArea.top}`)
    // Reading context: text lines fully inside the region's padding box ∩ viewport ∩ clipping ancestors ∩ body area.
    let clip: Box = { left: region.clientBox.left, top: region.clientBox.top, right: region.clientBox.right, bottom: region.clientBox.bottom }
    clip = intersect(clip, viewportBox, { x: true, y: true })
    for (const ancestor of active.clippingAncestors) clip = intersect(clip, ancestor.clientBox, { x: ancestor.clipsX, y: ancestor.clipsY })
    clip = intersect(clip, bodyArea, { x: true, y: true })
    const visibleClip = toVisibleRect(clip)
    const fullyVisibleLines = region.lineBoxes.filter(line => within(line, visibleClip, tol)).length
    readingContext = { fullyVisibleLines, requiredLines: OVERSIZED_CONTEXT_LINES, observedMedianLineHeightPx: region.observedLineHeightPx?.median ?? null, visibleClip }
    if (region.lineCount === 0) failures.push('oversized-context-metric-unavailable:no-text-line-rectangles')
    else if (fullyVisibleLines < OVERSIZED_CONTEXT_LINES) failures.push(`oversized-visible-text-lines:${fullyVisibleLines}<${OVERSIZED_CONTEXT_LINES}`)
    const covered = coveredText(active.entryHits)
    if (covered) failures.push(`oversized-entry-covered-at:${covered}`)
  }
  return {
    kind, failures, applicableArea, visibleBox, visibleHeight: visibleBox.height,
    indicatorHeight: indicatorRect.height, availableHeight: availableArea.height, readingContext,
  }
}

/** Two observations with no intervening user action: same focus, value, selection, control rectangle, dialog scroll and window scroll (0.5px tolerance). */
export function stabilityFailures(reference: ActiveProbe, current: ActiveProbe): string[] {
  const tol = GEOMETRY_TOLERANCE_PX
  const failures: string[] = []
  if (current.active.descriptor !== reference.active.descriptor) failures.push(`active element changed from ${reference.active.descriptor} to ${current.active.descriptor}`)
  if (current.active.value !== reference.active.value) failures.push(`value changed from ${JSON.stringify(reference.active.value)} to ${JSON.stringify(current.active.value)}`)
  if (JSON.stringify(current.active.selection) !== JSON.stringify(reference.active.selection)) failures.push(`selection changed from ${JSON.stringify(reference.active.selection)} to ${JSON.stringify(current.active.selection)}`)
  const edges: (keyof Rect)[] = ['left', 'top', 'right', 'bottom']
  if (edges.some(edge => Math.abs(current.active.rect[edge] - reference.active.rect[edge]) > tol)) failures.push(`control rectangle moved from ${JSON.stringify(reference.active.rect)} to ${JSON.stringify(current.active.rect)}`)
  if (Math.abs((current.dialog?.scrollTop ?? 0) - (reference.dialog?.scrollTop ?? 0)) > tol) failures.push(`dialog scrollTop moved from ${reference.dialog?.scrollTop} to ${current.dialog?.scrollTop}`)
  if (current.windowScroll.x !== reference.windowScroll.x || current.windowScroll.y !== reference.windowScroll.y) failures.push(`window scroll moved from ${JSON.stringify(reference.windowScroll)} to ${JSON.stringify(current.windowScroll)}`)
  return failures
}

/** Expected names must appear in this order (strictly increasing indices); other stops may sit between them. */
export function sequenceCheck(names: string[], expected: readonly string[]): { missing: string[]; outOfOrder: string[] } {
  const missing: string[] = []
  const outOfOrder: string[] = []
  let cursor = -1
  for (const name of expected) {
    const index = names.findIndex((candidate, position) => position > cursor && candidate === name)
    if (index === -1) (names.includes(name) ? outOfOrder : missing).push(name)
    else cursor = index
  }
  return { missing, outOfOrder }
}

/* --------------------------------------------------------------------------
 * Keyboard walk: ordered observations with evidence attached before any assertion.
 * -------------------------------------------------------------------------- */

export type Judgement = 'asserted' | 'record-only'
export interface WalkStop {
  index: number
  phase: string
  key: string | null
  name: string
  descriptor: string
  kind: StopKind
  /** 'asserted' for every native entry and every K1/K2 same-element observation; 'record-only' only for the K3 footer-change and K4 post-resize observations of a still-focused element, with the reason. */
  judgement: Judgement
  recordOnlyReason: string | null
  failures: string[]
  /** Name of the attached screenshot; null until the attachment actually succeeded. */
  screenshot: string | null
  /** The attempted screenshot name and, when capture or attachment failed, the error; the measured stop is kept either way. */
  screenshotAttempt: { name: string; error: string | null } | null
  probe: ActiveProbe
  assessment: StopAssessment
}

export interface ObserveOptions {
  /** Attach an unframed viewport screenshot of this stop (always attempted when the stop records a failure). */
  screenshot?: boolean | ((probe: ActiveProbe) => boolean)
  /** Mark the observation record-only for visibility, with the layout event that justifies it; focus/value/selection remain the spec's job. */
  recordOnly?: string
}

const slug = (value: string) => value.normalize('NFC').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'stop'

/**
 * Records every observed stop of a keyboard sequence. The measured stop is
 * appended before any screenshot capture or attachment is awaited, so a capture
 * failure never loses geometry that was already measured (AB1); the failure is
 * recorded on the stop and rethrown unchanged. The full ordered record is
 * attached by `attach()` from the caller's `finally`, so evidence survives an
 * aborted sequence. Record-only stops that carry visibility failures are
 * surfaced as test annotations by `attach()`, so a passing case never hides them.
 */
export class KeyboardWalk {
  readonly stops: WalkStop[] = []
  constructor(private readonly page: Page, private readonly testInfo: TestInfo, readonly name: string, private readonly notes: Record<string, unknown> = {}) {}

  async observe(phase: string, key: string | null = null, options: ObserveOptions = {}): Promise<WalkStop> {
    const probe = await probeActive(this.page)
    const assessment = assessStop(probe)
    const stop: WalkStop = {
      index: this.stops.length, phase, key, name: probe.active.name, descriptor: probe.active.descriptor,
      kind: assessment.kind, judgement: options.recordOnly ? 'record-only' : 'asserted', recordOnlyReason: options.recordOnly ?? null,
      failures: assessment.failures, screenshot: null, screenshotAttempt: null, probe, assessment,
    }
    // AB1: persist the measured stop before any capture await.
    this.stops.push(stop)
    const wanted = typeof options.screenshot === 'function' ? options.screenshot(probe) : Boolean(options.screenshot)
    if (wanted || assessment.failures.length > 0) {
      const name = `${this.name}-${String(stop.index).padStart(2, '0')}-${slug(probe.active.name || probe.active.descriptor)}`
      stop.screenshotAttempt = { name, error: null }
      try {
        const body = await this.page.screenshot()
        await this.testInfo.attach(name, { body, contentType: 'image/png' })
        stop.screenshot = name
      } catch (error) {
        stop.screenshotAttempt.error = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
        throw error
      }
    }
    return stop
  }

  async press(key: string, phase: string, options: ObserveOptions = {}): Promise<WalkStop> {
    await pressKey(this.page, key)
    return this.observe(phase, key, options)
  }

  /** Attach the ordered record plus extras; surface record-only visibility findings as annotations so they appear in results even when the case passes. */
  async attach(extra: Record<string, unknown> = {}) {
    const recordOnlyFindings = this.recordOnlyFindings()
    for (const finding of recordOnlyFindings) this.testInfo.annotations.push({ type: 'record-only-visibility', description: finding })
    await this.testInfo.attach(`${this.name}-stops`, {
      body: JSON.stringify({
        name: this.name, notes: this.notes, ...extra,
        judgementRule: 'asserted = every native entry (initial Close, each Tab/Shift+Tab arrival, wraps) and every K1/K2 same-element observation; record-only = only the K3 observations of the still-focused button while the footer changes state and the K4 observations of the still-focused note right after a viewport resize, surfaced here and as annotations, with focus/value/selection asserted by the case.',
        assertedFailures: this.failures(), recordOnlyFindings, stops: this.stops,
      }, null, 2),
      contentType: 'application/json',
    })
  }

  names(): string[] { return this.stops.map(stop => stop.name) }

  find(name: string, phase?: string): WalkStop | undefined {
    return this.stops.find(stop => stop.name === name && (phase === undefined || stop.phase === phase))
  }

  /** One line per visibility failure of an asserted stop, with its index, phase, kind and name, so an assertion message points at the attachment entry. */
  failures(filter: (stop: WalkStop) => boolean = stop => stop.judgement === 'asserted'): string[] {
    return this.stops.filter(filter).flatMap(stop => stop.failures.map(failure => `#${stop.index} ${stop.phase} [${stop.kind}] ${stop.name || stop.descriptor}: ${failure}`))
  }

  /** Visibility failures recorded on record-only stops; never asserted here, always surfaced. */
  recordOnlyFindings(): string[] {
    return this.stops.filter(stop => stop.judgement === 'record-only').flatMap(stop => stop.failures.map(failure => `#${stop.index} ${stop.phase} [${stop.kind}] ${stop.name || stop.descriptor} (record-only: ${stop.recordOnlyReason}): ${failure}`))
  }
}

/** Press `key` until `done(stop)` holds; every intermediate stop is recorded and judged. Throws past `max` presses with the names seen so far. */
export async function walkUntil(walk: KeyboardWalk, key: 'Tab' | 'Shift+Tab', phase: string, done: (stop: WalkStop) => boolean, max: number, options: ObserveOptions = {}): Promise<WalkStop> {
  for (let presses = 1; presses <= max; presses++) {
    const stop = await walk.press(key, phase, options)
    if (done(stop)) return stop
  }
  throw new Error(`${walk.name}: ${key} did not reach the target within ${max} presses; stops: ${walk.names().join(' → ')}`)
}

/** Compact view of a stop for timelines and matrices attached beside the full record. */
export function summarize(stop: WalkStop) {
  return {
    index: stop.index, phase: stop.phase, key: stop.key, name: stop.name, descriptor: stop.descriptor, kind: stop.kind,
    judgement: stop.judgement, recordOnlyReason: stop.recordOnlyReason, failures: stop.failures,
    value: stop.probe.active.value, selection: stop.probe.active.selection, rect: stop.probe.active.rect, indicator: stop.probe.active.indicator.kind,
    indicatorRect: stop.probe.active.indicator.rect, outlineColor: stop.probe.active.indicator.outlineColor, borderColor: stop.probe.active.indicator.borderColor,
    dialogScrollTop: stop.probe.dialog?.scrollTop ?? null, footer: stop.probe.footer, availableArea: stop.probe.availableArea,
    applicableArea: stop.assessment.applicableArea, visibleBox: stop.assessment.visibleBox, visibleHeight: stop.assessment.visibleHeight,
    readingContext: stop.assessment.readingContext, readingRegion: stop.probe.active.readingRegion ? { identified: stop.probe.active.readingRegion.identified, reasons: stop.probe.active.readingRegion.reasons, lineCount: stop.probe.active.readingRegion.lineCount, observedLineHeightPx: stop.probe.active.readingRegion.observedLineHeightPx } : null,
    noteAlert: stop.probe.noteAlert, screenshot: stop.screenshot, screenshotAttempt: stop.screenshotAttempt,
  }
}

export async function attachJson(testInfo: TestInfo, name: string, body: unknown) {
  await testInfo.attach(name, { body: JSON.stringify(body, null, 2), contentType: 'application/json' })
}
