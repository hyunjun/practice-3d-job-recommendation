/**
 * Stage81 D2 helpers: full-content reading, modeled caret geometry with a
 * measured no-wrap precondition, deterministic authored font growth with real
 * 100% references and actual readback, measured footer shortage, a read-only
 * frame probe for occlusion timing, caller openers and delayed-intent fixtures
 * for the final focus-visibility suites (docs/design/dialog-focus-visibility.md,
 * D2 candidate 01, SHA256 4f9f5cb4…).
 *
 * Everything here observes. No function reads a product clearance variable, a
 * product threshold or a product utility; expectations come from real DOM
 * rectangles, read-only Range rectangles of literal fixture sentences, computed
 * styles, hit tests and public control state. Page functions are serialized by
 * Playwright and are therefore self-contained.
 *
 * Preparation helpers (openers, synthetic files, synthetic faults, the font
 * fixture, mouse wheel and drag) are clearly separated from observation and are
 * labeled as preparation by the specs that use them. The 200% fixture is an
 * explicit authored-font stress test: every element's computed size is recorded
 * at 100% and set to exactly twice that value; dynamically rendered content gets
 * the same treatment from its own 100% references captured by rendering it once
 * at 100%. It is not native zoom, OS text scaling or a WCAG certification.
 */
import { expect } from '@playwright/test'
import type { Locator, Page } from '@playwright/test'
import type { SavedJob } from '../../../shared/types'
import { createSavedBackup } from '../../../shared/saved-backup'
import { publicProtocolCatalog, publicProtocolJob } from '../../fixtures/public-protocol'
import { BEACON, LABEL, LANTERN, expectLayoutReady, openSavedViewPlain, pressKey, seedSavedWithoutClock } from './dialog-focus-visibility'
import type { Rect } from './dialog-focus-visibility'
import { dialogOf, titleButton } from './saved-removal-undo'

export const D2_CONTRACT = {
  path: 'docs/design/dialog-focus-visibility.md',
  version: 'D2 — 제품 설계 후보 01',
  sha256: '4f9f5cb4d5146840989114053d32f8683beb65101dbff4df11d1e625b6e6fd81',
} as const

/** User-visible labels of the additional callers and controls. Read from rendered text or aria-labels, never from product code. */
export const D2_LABEL = {
  filtersOpener: /^모든 필터/,
  filtersDialog: '내게 중요한 조건으로.',
  toggleSalaryUnknown: /^연봉 미공개·별도 보상 공고도 포함/,
  toggleRemoteOnly: /^거주 국가가 포함된 원격근무만/,
  filtersReset: '조건 초기화',
  recalc: '다시 계산',
  countButton: /^(\d+)개 공고 보기$/,
  counting: '공고 수 계산 중',
  profileOpener: '내 프로필 편집',
  profileDialogStep1: '커리어의 다음 좌표를 찾아보세요.',
  profileDialogStep2: '당신의 경험을 이렇게 이해했어요.',
  profileTabFile: '이력서',
  profileTabText: '텍스트',
  profileTabLinkedIn: 'LinkedIn',
  uploadZone: /이력서를 이곳에 놓아주세요|클릭해서 다른 파일 선택/,
  hiddenFileInput: '이력서 파일 선택',
  analyze: '경력에서 가능성 찾기',
  years: '개발 경력',
  submitProfile: '내 기회 지도 만들기',
  yearsError: '개발 경력은 0~50년 사이의 숫자로 입력해 주세요. 소수도 입력할 수 있어요.',
  dataOpener: '데이터와 추천 방식',
  dataDialog: '기회의 지도, 그 안의 데이터.',
  importSummaryDifferent: /^바뀌는 내용 확인/,
  importSummaryNew: '파일의 메모와 공고 확인',
  recordDescriptionSummary: '공고 본문 확인',
  recordJsonSummary: '전체 저장 내용 보기',
  recoverySummary: '따로 보관한 원본이 있어요',
  manageOriginals: '원본 가져오기·정리',
  importButton: /^선택한 (\d+)개 가져오기$/,
  deleteMessage: '선택한 보관본을 삭제했어요.',
  exportMessage: /^현재 공고 \d+개의 백업 파일을 만들었어요\./,
  downloadError: '원본 파일을 만들지 못했어요. 보관본은 그대로 남아 있어요.',
  busyFooter: '기록을 반영하고 있어요…',
  undo: '실행 취소',
} as const

/* --------------------------------------------------------------------------
 * Literal fictional fixtures for full-content reading and editing.
 * -------------------------------------------------------------------------- */

/** Sentences of the LANTERN description used as reading sentinels; a spec asserts they exist in the fixture before relying on them. */
export const LANTERN_SENTENCES = {
  first: 'Fictional posting authored for the stage81 keyboard focus-visibility baseline. It is not a real vacancy.',
  middle: 'Every incident gets a blameless review. Every review produces at most three follow-ups.',
  last: 'Thank you for reading a fictional posting to its end.',
} as const
export const LANTERN_DESCRIPTION_TEXT = LANTERN.job.description

const numbered = (prefix: string, count: number, sentinels: { first: string; middle: string; last: string }) =>
  Array.from({ length: count }, (_, index) => index === 0 ? sentinels.first : index === Math.floor(count / 2) - 1 ? sentinels.middle : index === count - 1 ? sentinels.last : `${prefix} line ${String(index + 1).padStart(2, '0')} FICTIONAL81`).join('\n')

export const READER_NOTE = {
  first: 'FICTIONAL81 reader note begins here on line one.',
  middle: 'FICTIONAL81 reader note interior marker on line thirty.',
  last: 'FICTIONAL81 reader note ends here on line sixty.',
} as const
export const READER_NOTE_TEXT = numbered('reader note', 60, READER_NOTE)

export const READER_DESCRIPTION = {
  first: 'FICTIONAL81 harbor description opens on line one.',
  middle: 'FICTIONAL81 harbor description interior marker on line thirty.',
  last: 'FICTIONAL81 harbor description closes on line sixty.',
} as const
export const READER_DESCRIPTION_TEXT = numbered('harbor description', 60, READER_DESCRIPTION)

/** A saved record whose current note and description are long enough to make the backup record readers scroll. */
export const HARBOR: SavedJob = {
  ...BEACON,
  job: {
    ...BEACON.job, id: 'greenhouse-harbor-light-81', companyId: 'harbor-light', title: 'Harbor 81 · Reader Engineer',
    description: READER_DESCRIPTION_TEXT, requirements: ['FICTIONAL81 reading requirement for the backup record readers.'],
    url: 'https://example.org/focus81/greenhouse-harbor-light-81',
  },
  company: {
    ...BEACON.company, id: 'harbor-light', name: 'Harbor Light Fictional Studio', initials: 'HL', color: '#9ad0c4',
    industry: 'Fictional reading studio', careerUrl: 'https://example.org/harbor-light/careers', board: 'harbor-light',
  },
  savedAt: '2026-09-28T08:00:00.000Z', status: 'saved', note: READER_NOTE_TEXT,
}
/** The same posting in a backup file with a different note and status, so the import review shows a "different" row with both record panes. */
export const HARBOR_INCOMING: SavedJob = { ...HARBOR, status: 'applied', note: 'FICTIONAL81 incoming file note differs from the current note.' }
/** Literal markers of the whole-record JSON pane: its first character, an interior key line that appears once, and its last character. */
export const HARBOR_JSON_MARKERS = { first: '{', middle: `"savedAt": "${HARBOR.savedAt}"`, last: '}' } as const

const importRow = (suffix: 'a' | 'b' | 'c'): SavedJob => ({
  ...BEACON,
  job: { ...BEACON.job, id: `greenhouse-import-row-81-${suffix}`, title: `Import Row ${suffix.toUpperCase()} 81 · Platform Engineer`, url: `https://example.org/focus81/import-row-${suffix}` },
  savedAt: '2026-09-25T08:00:00.000Z', status: 'saved', note: `FICTIONAL81 import row ${suffix}`,
})
/** Three new records for a backup file: they render as import rows with checkboxes and disclosure summaries. */
export const IMPORT_ROWS: SavedJob[] = [importRow('a'), importRow('b'), importRow('c')]

/** Forty short lines for real caret geometry; the caret line is the count of newlines before the focus endpoint once the measured no-wrap precondition holds. */
export const CARET_LINES = Array.from({ length: 40 }, (_, index) => `caret ${String(index + 1).padStart(2, '0')} FICTIONAL81`)
export const CARET_BODY = CARET_LINES.join('\n')
export const CARET_INTERIOR_LINE = 20
export const CARET_INTERIOR_EDIT = ' EDIT81'
export const CARET_BODY_EDITED = CARET_LINES.map((line, index) => index === CARET_INTERIOR_LINE ? `${line}${CARET_INTERIOR_EDIT}` : line).join('\n')

export const RESUME_TEXT = 'FICTIONAL81 resume: six years building TypeScript services, PostgreSQL schemas and Kubernetes runbooks for a fictional studio. Nothing here describes a real person.'

/**
 * Explicit synthetic catalog for the filters count: three onsite greenhouse
 * engineering postings that differ only in disclosed salary. The selection rule
 * the test relies on is public behaviour, stated here as the expectation, not
 * derived through product matching code: with the default draft every posting
 * counts; the "include undisclosed salary" toggle switched off excludes the one
 * posting without a disclosed salary, so the literal counts are 3 and 2.
 */
export const COUNT_CATALOG_JOBS = [
  publicProtocolJob('count-a', { id: 'greenhouse-fixture-count-a', title: 'Backend Engineer — Count Fixture A (disclosed)', salary: { min: 130000, max: 180000, currency: 'USD' } }),
  publicProtocolJob('count-b', { id: 'greenhouse-fixture-count-b', title: 'Backend Engineer — Count Fixture B (disclosed)', salary: { min: 90000, max: 120000, currency: 'USD' } }),
  publicProtocolJob('count-c', { id: 'greenhouse-fixture-count-c', title: 'Backend Engineer — Count Fixture C (undisclosed)', salary: null }),
]
export const COUNT_EXPECTED = { all: '3개 공고 보기', disclosedOnly: '2개 공고 보기' } as const

/** A synthetic backup file in the format the product itself exports. */
export function backupFile(records: SavedJob[], name = 'focus81-backup.json') {
  return { name, mimeType: 'application/json', buffer: Buffer.from(createSavedBackup(records)) }
}

/* --------------------------------------------------------------------------
 * Read-only page probes (serialized; self-contained).
 * -------------------------------------------------------------------------- */

interface Box { left: number; top: number; right: number; bottom: number }

export interface SentenceVisibility {
  found: boolean
  rects: Rect[]
  /** Padding box of the focused element ∩ viewport ∩ clipping ancestors ∩ dialog port above a sticky footer. */
  clip: Rect | null
  fullyVisible: boolean
  hiddenRectCount: number
  targetDescriptor: string
}

/** Whether every rendered rectangle of a literal sentence inside the focused element is inside the element's clip. */
function sentenceVisibilityInPage(args: { sentence: string; which: 'first' | 'last' }): SentenceVisibility {
  const tol = 0.5
  const round = (value: number) => Math.round(value * 100) / 100
  const toRect = (box: Box): Rect => ({ left: round(box.left), top: round(box.top), right: round(box.right), bottom: round(box.bottom), width: round(box.right - box.left), height: round(box.bottom - box.top) })
  const clientBox = (element: Element): Box => {
    const box = element.getBoundingClientRect()
    const left = box.left + element.clientLeft
    const top = box.top + element.clientTop
    return { left, top, right: left + element.clientWidth, bottom: top + element.clientHeight }
  }
  const describe = (element: Element | null) => element ? `${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : ''}${Array.from(element.classList).slice(0, 4).map(name => `.${name}`).join('')}` : 'none'
  const target = document.activeElement
  const empty: SentenceVisibility = { found: false, rects: [], clip: null, fullyVisible: false, hiddenRectCount: 0, targetDescriptor: describe(target) }
  if (!(target instanceof HTMLElement) || target === document.body) return empty
  const walker = document.createTreeWalker(target, NodeFilter.SHOW_TEXT)
  let hit: { node: Text; index: number } | null = null
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.textContent ?? ''
    const index = args.which === 'last' ? text.lastIndexOf(args.sentence) : text.indexOf(args.sentence)
    if (index < 0) continue
    hit = { node: node as Text, index }
    if (args.which === 'first') break
  }
  if (!hit) return empty
  const range = document.createRange()
  range.setStart(hit.node, hit.index)
  range.setEnd(hit.node, hit.index + args.sentence.length)
  const rects = Array.from(range.getClientRects()).filter(rect => rect.width > 0 && rect.height > 0).map(rect => toRect({ left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom }))
  range.detach()
  let clip: Box = clientBox(target)
  const viewport: Box = { left: 0, top: 0, right: document.documentElement.clientWidth, bottom: document.documentElement.clientHeight }
  clip = { left: Math.max(clip.left, viewport.left), top: Math.max(clip.top, viewport.top), right: Math.min(clip.right, viewport.right), bottom: Math.min(clip.bottom, viewport.bottom) }
  for (let ancestor = target.parentElement; ancestor && ancestor !== document.body && ancestor !== document.documentElement; ancestor = ancestor.parentElement) {
    const style = getComputedStyle(ancestor)
    if (style.overflowX === 'visible' && style.overflowY === 'visible') continue
    const box = clientBox(ancestor)
    if (style.overflowX !== 'visible') { clip.left = Math.max(clip.left, box.left); clip.right = Math.min(clip.right, box.right) }
    if (style.overflowY !== 'visible') { clip.top = Math.max(clip.top, box.top); clip.bottom = Math.min(clip.bottom, box.bottom) }
  }
  const dialog = document.querySelector<HTMLDialogElement>('dialog[open]')
  if (dialog) {
    const port = clientBox(dialog)
    const footer = dialog.querySelector<HTMLElement>(':scope > .dialog-footer')
    let bottom = port.bottom
    if (footer && getComputedStyle(footer).position === 'sticky' && !footer.contains(target)) bottom = Math.min(bottom, footer.getBoundingClientRect().top)
    clip = { left: Math.max(clip.left, port.left), top: Math.max(clip.top, port.top), right: Math.min(clip.right, port.right), bottom: Math.min(clip.bottom, bottom) }
  }
  const inside = (rect: Rect) => rect.left >= clip.left - tol && rect.right <= clip.right + tol && rect.top >= clip.top - tol && rect.bottom <= clip.bottom + tol
  const hiddenRectCount = rects.filter(rect => !inside(rect)).length
  return { found: true, rects, clip: toRect(clip), fullyVisible: rects.length > 0 && hiddenRectCount === 0, hiddenRectCount, targetDescriptor: describe(target) }
}

export interface CaretGeometry {
  isTextarea: boolean
  valueLength: number
  selectionStart: number
  selectionEnd: number
  /** The textarea's own selectionDirection ('forward' | 'backward' | 'none'). */
  direction: string
  /** The focus endpoint of the selection: selectionStart for a backward selection, selectionEnd otherwise. */
  focusOffset: number
  /** Newlines before the focus endpoint; the rendered line only once noSoftWrap holds. */
  lineIndex: number
  /** Newline-delimited lines of the whole value. */
  logicalLineCount: number
  /** Rendered content height divided by the line height, measured from the textarea's own scrollHeight and paddings; equals the logical count only when nothing wraps and the content overflows the box. */
  renderedLineCount: number
  /** Widest logical line measured with the textarea's computed font (canvas text metrics) against the content width available for text. */
  maxLineWidthPx: number
  availableWidthPx: number
  /** Measured precondition: every logical line fits the content width (and, when the content overflows the box, the rendered line count equals the logical count), so the modeled caret line is the rendered line. */
  noSoftWrap: boolean
  lineHeightPx: number
  paddingTopPx: number
  paddingBottomPx: number
  borderTopPx: number
  scrollTop: number
  clientHeight: number
  box: Rect
  /** Modeled from value, selection, computed line height, padding, border and inner scroll; not a pixel read of the caret itself. */
  modeledCaretTop: number
  modeledCaretBottom: number
  /** The modeled caret line lies inside the textarea's own visible box (its inner scroll already applied). */
  caretInsideBox: boolean
  /** The modeled caret line lies inside the dialog port above a sticky footer and inside the viewport. */
  caretInsideBodyArea: boolean
  bodyArea: { top: number; bottom: number } | null
  inlineHeight: string
  renderedHeight: number
}

function caretGeometryInPage(): CaretGeometry {
  const tol = 0.5
  const round = (value: number) => Math.round(value * 100) / 100
  const empty: CaretGeometry = {
    isTextarea: false, valueLength: 0, selectionStart: -1, selectionEnd: -1, direction: 'none', focusOffset: -1, lineIndex: -1, logicalLineCount: 0, renderedLineCount: 0, maxLineWidthPx: 0, availableWidthPx: 0, noSoftWrap: false,
    lineHeightPx: 0, paddingTopPx: 0, paddingBottomPx: 0, borderTopPx: 0, scrollTop: 0, clientHeight: 0,
    box: { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }, modeledCaretTop: 0, modeledCaretBottom: 0, caretInsideBox: false, caretInsideBodyArea: false, bodyArea: null, inlineHeight: '', renderedHeight: 0,
  }
  const target = document.activeElement
  if (!(target instanceof HTMLTextAreaElement)) return empty
  const style = getComputedStyle(target)
  const fontSize = Number.parseFloat(style.fontSize) || 0
  const lineHeight = style.lineHeight === 'normal' ? fontSize * 1.2 : Number.parseFloat(style.lineHeight) || fontSize * 1.2
  const paddingTop = Number.parseFloat(style.paddingTop) || 0
  const paddingBottom = Number.parseFloat(style.paddingBottom) || 0
  const borderTop = Number.parseFloat(style.borderTopWidth) || 0
  const box = target.getBoundingClientRect()
  const start = target.selectionStart ?? 0
  const end = target.selectionEnd ?? 0
  const direction = target.selectionDirection ?? 'none'
  const focusOffset = direction === 'backward' ? start : end
  const lineIndex = target.value.slice(0, focusOffset).split('\n').length - 1
  const lines = target.value.split('\n')
  const logicalLineCount = lines.length
  const renderedLineCount = lineHeight > 0 ? (target.scrollHeight - paddingTop - paddingBottom) / lineHeight : 0
  const overflowing = target.scrollHeight > target.clientHeight + 0.5
  const availableWidth = target.clientWidth - (Number.parseFloat(style.paddingLeft) || 0) - (Number.parseFloat(style.paddingRight) || 0)
  const context = document.createElement('canvas').getContext('2d')
  let maxLineWidth = 0
  if (context) {
    context.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`
    for (const line of lines) maxLineWidth = Math.max(maxLineWidth, context.measureText(line).width)
  }
  const noSoftWrap = context !== null && maxLineWidth <= availableWidth - 0.5 && (!overflowing || Math.abs(renderedLineCount - logicalLineCount) <= 0.1)
  const modeledCaretTop = box.top + borderTop + paddingTop + lineIndex * lineHeight - target.scrollTop
  const modeledCaretBottom = modeledCaretTop + lineHeight
  const innerTop = box.top + borderTop
  const innerBottom = innerTop + target.clientHeight
  const dialog = document.querySelector<HTMLDialogElement>('dialog[open]')
  let bodyArea: CaretGeometry['bodyArea'] = null
  if (dialog) {
    const top = dialog.getBoundingClientRect().top + dialog.clientTop
    let bottom = top + dialog.clientHeight
    const footer = dialog.querySelector<HTMLElement>(':scope > .dialog-footer')
    if (footer && getComputedStyle(footer).position === 'sticky') bottom = Math.min(bottom, footer.getBoundingClientRect().top)
    bodyArea = { top: round(top), bottom: round(bottom) }
  }
  const viewportHeight = document.documentElement.clientHeight
  return {
    isTextarea: true, valueLength: target.value.length, selectionStart: start, selectionEnd: end, direction, focusOffset, lineIndex, logicalLineCount,
    renderedLineCount: round(renderedLineCount), maxLineWidthPx: round(maxLineWidth), availableWidthPx: round(availableWidth), noSoftWrap,
    lineHeightPx: round(lineHeight), paddingTopPx: round(paddingTop), paddingBottomPx: round(paddingBottom), borderTopPx: round(borderTop), scrollTop: round(target.scrollTop), clientHeight: target.clientHeight,
    box: { left: round(box.left), top: round(box.top), right: round(box.right), bottom: round(box.bottom), width: round(box.width), height: round(box.height) },
    modeledCaretTop: round(modeledCaretTop), modeledCaretBottom: round(modeledCaretBottom),
    caretInsideBox: modeledCaretTop >= innerTop - tol && modeledCaretBottom <= innerBottom + tol,
    caretInsideBodyArea: bodyArea !== null && modeledCaretTop >= bodyArea.top - tol && modeledCaretBottom <= bodyArea.bottom + tol && modeledCaretTop >= -tol && modeledCaretBottom <= viewportHeight + tol,
    bodyArea, inlineHeight: target.style.height, renderedHeight: round(box.height),
  }
}

/* Authored-font fixture: deterministic 2× from recorded 100% sizes; dynamic content from its own 100% references. */

export interface FontDoubling { recorded: number; doubled: number; zero: number }
export interface FontVerification { checked: number; mismatches: { descriptor: string; before: number; now: number }[]; detached: number }
export interface FontReference { selector: string; sizes: number[] }
export interface FontReferenceApplication { applied: number; countMismatches: { selector: string; expected: number; found: number }[] }
export interface FontReadback { selector: string; sizes: number[] }
interface FontRegistry { elements: Element[]; before: number[]; inline: string[]; dynamic: { element: Element; inline: string }[] }

/** Record the computed font size and the original inline declaration of the open dialog and every descendant at 100%, before any write. */
function snapshotFontsInPage(): number {
  const dialog = document.querySelector('dialog[open]')
  if (!dialog) return 0
  const elements = [dialog, ...Array.from(dialog.querySelectorAll('*'))]
  const registry: FontRegistry = {
    elements,
    before: elements.map(element => Number.parseFloat(getComputedStyle(element).fontSize) || 0),
    inline: elements.map(element => (element instanceof HTMLElement || element instanceof SVGElement) ? element.style.fontSize : ''),
    dynamic: [],
  }
  Reflect.set(window, '__focus81Fonts', registry)
  return elements.length
}

/** Set every recorded element to exactly twice its recorded 100% size by inline style. Inheritance and relative units cannot compound because each value comes from the 100% record. */
function doubleFontsInPage(): FontDoubling {
  const registry = Reflect.get(window, '__focus81Fonts') as FontRegistry | undefined
  const result: FontDoubling = { recorded: 0, doubled: 0, zero: 0 }
  if (!registry || !registry.elements.length) return result
  result.recorded = registry.elements.length
  registry.elements.forEach((element, index) => {
    const before = registry.before[index]
    const style = element instanceof HTMLElement || element instanceof SVGElement ? element.style : null
    if (!style) return
    if (before <= 0) { result.zero++; return }
    style.fontSize = `${2 * before}px`
    result.doubled++
  })
  return result
}

/** Read back the actual computed size of every recorded, still connected element and compare it with twice its 100% record. */
function verifyFontsInPage(): FontVerification {
  const registry = Reflect.get(window, '__focus81Fonts') as FontRegistry | undefined
  const result: FontVerification = { checked: 0, mismatches: [], detached: 0 }
  if (!registry) return result
  const describe = (element: Element) => `${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : ''}${Array.from(element.classList).slice(0, 4).map(name => `.${name}`).join('')}`
  registry.elements.forEach((element, index) => {
    if (!element.isConnected) { result.detached++; return }
    const before = registry.before[index]
    if (before <= 0) return
    result.checked++
    const now = Number.parseFloat(getComputedStyle(element).fontSize) || 0
    if (Math.abs(now - 2 * before) > 0.1) result.mismatches.push({ descriptor: describe(element), before, now })
  })
  return result
}

/** Restore the original inline declarations (recorded and dynamic) exactly; nothing else is touched. */
function restoreFontsInPage(): number {
  const registry = Reflect.get(window, '__focus81Fonts') as FontRegistry | undefined
  if (!registry) return 0
  let restored = 0
  const restore = (element: Element, inline: string) => {
    const style = element instanceof HTMLElement || element instanceof SVGElement ? element.style : null
    if (!style) return
    if (inline) style.fontSize = inline
    else style.removeProperty('font-size')
    restored++
  }
  registry.elements.forEach((element, index) => restore(element, registry.inline[index]))
  for (const entry of registry.dynamic) restore(entry.element, entry.inline)
  Reflect.deleteProperty(window, '__focus81Fonts')
  return restored
}

/** Actual computed sizes of the elements matching each selector inside the open dialog, in document order (a 100% reference when read at 100%). */
function fontReferencesInPage(selectors: string[]): FontReference[] {
  const dialog = document.querySelector('dialog[open]')
  return selectors.map(selector => ({ selector, sizes: dialog ? Array.from(dialog.querySelectorAll(selector)).map(element => Math.round((Number.parseFloat(getComputedStyle(element).fontSize) || 0) * 100) / 100) : [] }))
}

/** Apply exactly twice each 100% reference to the elements matching the same selectors in the same order; original inline declarations are recorded for restore. */
function applyFontReferencesInPage(references: FontReference[]): FontReferenceApplication {
  const dialog = document.querySelector('dialog[open]')
  const registry = Reflect.get(window, '__focus81Fonts') as FontRegistry | undefined
  const result: FontReferenceApplication = { applied: 0, countMismatches: [] }
  if (!dialog) return result
  for (const reference of references) {
    const elements = Array.from(dialog.querySelectorAll(reference.selector))
    if (elements.length !== reference.sizes.length) result.countMismatches.push({ selector: reference.selector, expected: reference.sizes.length, found: elements.length })
    elements.forEach((element, index) => {
      const size = reference.sizes[index]
      const style = element instanceof HTMLElement || element instanceof SVGElement ? element.style : null
      if (!style || size === undefined || size <= 0) return
      if (registry && !registry.elements.includes(element) && !registry.dynamic.some(entry => entry.element === element)) registry.dynamic.push({ element, inline: style.fontSize })
      style.fontSize = `${2 * size}px`
      result.applied++
    })
  }
  return result
}

export interface FooterState {
  present: boolean
  position: string | null
  rect: Rect | null
  dialogClient: Rect | null
  /** The footer's bottom edge coincides with the dialog port bottom (sticky behaviour while content continues below). */
  pinnedToClientBottom: boolean | null
  /** Distance from the footer's bottom to the end of the scrolled content; about zero when the footer sits at the content end. */
  contentEndGap: number | null
  dialogScrollTop: number
  dialogScrollHeight: number
  dialogClientHeight: number
  overflowing: boolean
}

function footerStateInPage(): FooterState {
  const round = (value: number) => Math.round(value * 100) / 100
  const dialog = document.querySelector<HTMLDialogElement>('dialog[open]')
  const empty: FooterState = { present: false, position: null, rect: null, dialogClient: null, pinnedToClientBottom: null, contentEndGap: null, dialogScrollTop: 0, dialogScrollHeight: 0, dialogClientHeight: 0, overflowing: false }
  if (!dialog) return empty
  const dialogBox = dialog.getBoundingClientRect()
  const client: Rect = {
    left: round(dialogBox.left + dialog.clientLeft), top: round(dialogBox.top + dialog.clientTop), right: round(dialogBox.left + dialog.clientLeft + dialog.clientWidth), bottom: round(dialogBox.top + dialog.clientTop + dialog.clientHeight),
    width: dialog.clientWidth, height: dialog.clientHeight,
  }
  const footer = dialog.querySelector<HTMLElement>(':scope > .dialog-footer')
  const base = { ...empty, dialogClient: client, dialogScrollTop: round(dialog.scrollTop), dialogScrollHeight: dialog.scrollHeight, dialogClientHeight: dialog.clientHeight, overflowing: dialog.scrollHeight > dialog.clientHeight + 1 }
  if (!footer) return base
  const box = footer.getBoundingClientRect()
  const rect: Rect = { left: round(box.left), top: round(box.top), right: round(box.right), bottom: round(box.bottom), width: round(box.width), height: round(box.height) }
  const contentEndGap = round(dialog.scrollHeight - (box.bottom - (dialogBox.top + dialog.clientTop) + dialog.scrollTop))
  return { ...base, present: true, position: getComputedStyle(footer).position, rect, pinnedToClientBottom: Math.abs(box.bottom - (dialogBox.top + dialog.clientTop + dialog.clientHeight)) <= 0.5, contentEndGap }
}

export interface ShortageMeasurement {
  measured: boolean
  portHeight: number
  footerHeight: number
  /** Port height minus the footer's rendered height: the body band a sticky footer would leave. */
  bandIfSticky: number
  /** Vertical span of the reader's first two rendered text lines (read-only Range rectangles). */
  twoLineSpan: number
  paddingBlock: number
  borderBlock: number
  /** The focused reader's own painted outline allowance on both block edges (computed outline width plus offset, doubled). */
  indicatorAllowance: number
  /** Two rendered lines plus the reader's own padding, borders and indicator allowance. */
  requiredForTwoLines: number
  holds: boolean
}

/** Independent shortage measurement from rendered geometry of the focused reader and the footer; no product constant is used. */
function shortageIfStickyInPage(): ShortageMeasurement {
  const round = (value: number) => Math.round(value * 100) / 100
  const empty: ShortageMeasurement = { measured: false, portHeight: 0, footerHeight: 0, bandIfSticky: 0, twoLineSpan: 0, paddingBlock: 0, borderBlock: 0, indicatorAllowance: 0, requiredForTwoLines: 0, holds: false }
  const dialog = document.querySelector<HTMLDialogElement>('dialog[open]')
  const footer = dialog?.querySelector<HTMLElement>(':scope > .dialog-footer') ?? null
  const target = document.activeElement
  if (!dialog || !footer || !(target instanceof HTMLElement)) return empty
  const rects: DOMRect[] = []
  const walker = document.createTreeWalker(target, NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode(); node && rects.length < 400; node = walker.nextNode()) {
    if (!(node.textContent ?? '').trim()) continue
    const range = document.createRange()
    range.selectNodeContents(node)
    for (const rect of Array.from(range.getClientRects())) if (rect.width > 0 && rect.height > 0) rects.push(rect)
    range.detach()
  }
  rects.sort((a, b) => a.top - b.top || a.left - b.left)
  const lines: { top: number; bottom: number }[] = []
  for (const rect of rects) {
    const last = lines[lines.length - 1]
    if (last && Math.min(last.bottom, rect.bottom) - Math.max(last.top, rect.top) > Math.min(last.bottom - last.top, rect.height) / 2) { last.top = Math.min(last.top, rect.top); last.bottom = Math.max(last.bottom, rect.bottom); continue }
    lines.push({ top: rect.top, bottom: rect.bottom })
  }
  if (lines.length < 2) return empty
  const style = getComputedStyle(target)
  const paddingBlock = (Number.parseFloat(style.paddingTop) || 0) + (Number.parseFloat(style.paddingBottom) || 0)
  const borderBlock = (Number.parseFloat(style.borderTopWidth) || 0) + (Number.parseFloat(style.borderBottomWidth) || 0)
  const indicatorAllowance = style.outlineStyle === 'none' ? 0 : 2 * ((Number.parseFloat(style.outlineWidth) || 0) + (Number.parseFloat(style.outlineOffset) || 0))
  const twoLineSpan = lines[1].bottom - lines[0].top
  const requiredForTwoLines = twoLineSpan + paddingBlock + borderBlock + indicatorAllowance
  const portHeight = dialog.clientHeight
  const footerHeight = footer.getBoundingClientRect().height
  const bandIfSticky = portHeight - footerHeight
  return {
    measured: true, portHeight: round(portHeight), footerHeight: round(footerHeight), bandIfSticky: round(bandIfSticky), twoLineSpan: round(twoLineSpan),
    paddingBlock: round(paddingBlock), borderBlock: round(borderBlock), indicatorAllowance: round(indicatorAllowance), requiredForTwoLines: round(requiredForTwoLines), holds: bandIfSticky < requiredForTwoLines,
  }
}

export interface OverflowAudit {
  dialog: { scrollWidth: number; clientWidth: number; overflow: boolean }
  footer: { scrollWidth: number; clientWidth: number; overflow: boolean; height: number } | null
  controls: { descriptor: string; text: string; scrollWidth: number; clientWidth: number; overflow: boolean; lineBoxes: number; linesOutside: number }[]
}

/** Horizontal overflow and text-line containment of the dialog, its footer and every footer control. */
function overflowAuditInPage(): OverflowAudit {
  const tol = 0.5
  const describe = (element: Element) => `${element.tagName.toLowerCase()}${Array.from(element.classList).slice(0, 4).map(name => `.${name}`).join('')}`
  const dialog = document.querySelector<HTMLDialogElement>('dialog[open]')
  if (!dialog) return { dialog: { scrollWidth: 0, clientWidth: 0, overflow: false }, footer: null, controls: [] }
  const footer = dialog.querySelector<HTMLElement>(':scope > .dialog-footer')
  const controls: OverflowAudit['controls'] = []
  if (footer) {
    for (const control of Array.from(footer.querySelectorAll<HTMLElement>('button, a, span, div'))) {
      if (!control.getClientRects().length) continue
      const box = control.getBoundingClientRect()
      const style = getComputedStyle(control)
      const inner = {
        left: box.left + (Number.parseFloat(style.borderLeftWidth) || 0), right: box.right - (Number.parseFloat(style.borderRightWidth) || 0),
        top: box.top + (Number.parseFloat(style.borderTopWidth) || 0), bottom: box.bottom - (Number.parseFloat(style.borderBottomWidth) || 0),
      }
      let lineBoxes = 0
      let linesOutside = 0
      const walker = document.createTreeWalker(control, NodeFilter.SHOW_TEXT)
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (!(node.textContent ?? '').trim()) continue
        const range = document.createRange()
        range.selectNodeContents(node)
        for (const rect of Array.from(range.getClientRects())) {
          if (rect.width <= 0 || rect.height <= 0) continue
          lineBoxes++
          if (rect.left < inner.left - tol || rect.right > inner.right + tol || rect.top < inner.top - tol || rect.bottom > inner.bottom + tol) linesOutside++
        }
        range.detach()
      }
      controls.push({ descriptor: describe(control), text: (control.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 60), scrollWidth: control.scrollWidth, clientWidth: control.clientWidth, overflow: control.scrollWidth > control.clientWidth + 1, lineBoxes, linesOutside })
    }
  }
  return {
    dialog: { scrollWidth: dialog.scrollWidth, clientWidth: dialog.clientWidth, overflow: dialog.scrollWidth > dialog.clientWidth + 1 },
    footer: footer ? { scrollWidth: footer.scrollWidth, clientWidth: footer.clientWidth, overflow: footer.scrollWidth > footer.clientWidth + 1, height: Math.round(footer.getBoundingClientRect().height * 100) / 100 } : null,
    controls,
  }
}

export interface SpacerAudit {
  hasFooter: boolean
  paddingBottom: string
  afterContent: string
  lastChild: string | null
  lastChildMarginBottom: number
  /** Bottom of the last rendered direct child's margin box in the dialog's scrolled content coordinates. */
  lastChildContentBottom: number | null
  scrollHeight: number
  /** scrollHeight minus the last child's content bottom: about zero means no spacer after the content. */
  gap: number | null
}

function spacerAuditInPage(): SpacerAudit {
  const round = (value: number) => Math.round(value * 100) / 100
  const dialog = document.querySelector<HTMLDialogElement>('dialog[open]')
  if (!dialog) return { hasFooter: false, paddingBottom: '', afterContent: '', lastChild: null, lastChildMarginBottom: 0, lastChildContentBottom: null, scrollHeight: 0, gap: null }
  const rendered = Array.from(dialog.children).filter(child => child.getClientRects().length > 0)
  const last = rendered[rendered.length - 1] ?? null
  const style = getComputedStyle(dialog)
  const dialogTop = dialog.getBoundingClientRect().top + dialog.clientTop
  let lastChildContentBottom: number | null = null
  let marginBottom = 0
  if (last) {
    marginBottom = Number.parseFloat(getComputedStyle(last).marginBottom) || 0
    lastChildContentBottom = round(last.getBoundingClientRect().bottom + marginBottom - dialogTop + dialog.scrollTop)
  }
  return {
    hasFooter: dialog.querySelector(':scope > .dialog-footer') !== null,
    paddingBottom: style.paddingBottom, afterContent: getComputedStyle(dialog, '::after').content,
    lastChild: last ? `${last.tagName.toLowerCase()}${Array.from(last.classList).slice(0, 3).map(name => `.${name}`).join('')}` : null,
    lastChildMarginBottom: round(marginBottom), lastChildContentBottom, scrollHeight: dialog.scrollHeight,
    gap: lastChildContentBottom === null ? null : round(dialog.scrollHeight - lastChildContentBottom),
  }
}

export interface ElementPlacement { found: boolean; rect: Rect | null; dialogClient: Rect | null; insideClient: boolean; aboveClient: boolean; belowClient: boolean; text: string }

/** Where a dialog element currently sits relative to the dialog port, without scrolling anything. */
function placementInPage(selector: string): ElementPlacement {
  const round = (value: number) => Math.round(value * 100) / 100
  const dialog = document.querySelector<HTMLDialogElement>('dialog[open]')
  const element = dialog?.querySelector(selector) ?? null
  if (!dialog || !element || !element.getClientRects().length) return { found: false, rect: null, dialogClient: null, insideClient: false, aboveClient: false, belowClient: false, text: '' }
  const dialogBox = dialog.getBoundingClientRect()
  const client: Rect = { left: round(dialogBox.left + dialog.clientLeft), top: round(dialogBox.top + dialog.clientTop), right: round(dialogBox.left + dialog.clientLeft + dialog.clientWidth), bottom: round(dialogBox.top + dialog.clientTop + dialog.clientHeight), width: dialog.clientWidth, height: dialog.clientHeight }
  const box = element.getBoundingClientRect()
  const rect: Rect = { left: round(box.left), top: round(box.top), right: round(box.right), bottom: round(box.bottom), width: round(box.width), height: round(box.height) }
  return {
    found: true, rect, dialogClient: client,
    insideClient: rect.top >= client.top - 0.5 && rect.bottom <= client.bottom + 0.5,
    aboveClient: rect.bottom <= client.top + 0.5, belowClient: rect.top >= client.bottom - 0.5,
    text: (element.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 80),
  }
}

/* Read-only frame probe: one requestAnimationFrame loop that records where the engaged control sits relative to the port and a sticky footer, frame by frame. */

export interface FrameSample { frame: number; time: number; activeDescriptor: string; sameElement: boolean; top: number; bottom: number; portTop: number; portBottom: number; footerTop: number | null; dialogScrollTop: number; occluded: boolean; overlapPx: number }
export interface FrameProbeResult { samples: FrameSample[]; stopped: boolean }
interface FrameProbeState { element: Element; samples: FrameSample[]; stopped: boolean; remaining: number }

function installFrameProbeInPage(frames: number): boolean {
  const round = (value: number) => Math.round(value * 100) / 100
  const element = document.activeElement
  if (!(element instanceof HTMLElement) || element === document.body) return false
  const state: FrameProbeState = { element, samples: [], stopped: false, remaining: frames }
  const describe = (node: Element | null) => node ? `${node.tagName.toLowerCase()}${Array.from(node.classList).slice(0, 3).map(name => `.${name}`).join('')}` : 'none'
  const sample = (frame: number) => {
    const dialog = document.querySelector<HTMLDialogElement>('dialog[open]')
    if (!dialog) return
    const dialogBox = dialog.getBoundingClientRect()
    const portTop = dialogBox.top + dialog.clientTop
    const portBottom = portTop + dialog.clientHeight
    const footer = dialog.querySelector<HTMLElement>(':scope > .dialog-footer')
    const footerTop = footer && getComputedStyle(footer).position === 'sticky' && !footer.contains(state.element) ? footer.getBoundingClientRect().top : null
    const box = state.element.getBoundingClientRect()
    const limit = footerTop === null ? portBottom : Math.min(portBottom, footerTop)
    const overlap = Math.max(0, box.bottom - limit, portTop - box.top)
    state.samples.push({
      frame, time: round(performance.now()), activeDescriptor: describe(document.activeElement), sameElement: document.activeElement === state.element,
      top: round(box.top), bottom: round(box.bottom), portTop: round(portTop), portBottom: round(portBottom), footerTop: footerTop === null ? null : round(footerTop),
      dialogScrollTop: round(dialog.scrollTop), occluded: overlap > 0.5 || !state.element.isConnected, overlapPx: round(overlap),
    })
  }
  const tick = (frame: number) => {
    if (state.stopped) return
    sample(frame)
    state.remaining--
    if (state.remaining <= 0) { state.stopped = true; return }
    requestAnimationFrame(() => tick(frame + 1))
  }
  Reflect.set(window, '__focus81FrameProbe', state)
  requestAnimationFrame(() => tick(1))
  return true
}

function readFrameProbeInPage(): FrameProbeResult {
  const state = Reflect.get(window, '__focus81FrameProbe') as FrameProbeState | undefined
  if (!state) return { samples: [], stopped: true }
  state.stopped = true
  return { samples: state.samples.slice(), stopped: state.stopped }
}

export const sentenceVisibility = (page: Page, sentence: string, which: 'first' | 'last' = 'first') => page.evaluate(sentenceVisibilityInPage, { sentence, which })
export const caretGeometry = (page: Page) => page.evaluate(caretGeometryInPage)
export const snapshotFonts = (page: Page) => page.evaluate(snapshotFontsInPage)
export const doubleFonts = (page: Page) => page.evaluate(doubleFontsInPage)
export const verifyFonts = (page: Page) => page.evaluate(verifyFontsInPage)
export const restoreFonts = (page: Page) => page.evaluate(restoreFontsInPage)
export const fontReferences = (page: Page, selectors: string[]) => page.evaluate(fontReferencesInPage, selectors)
export const applyFontReferences = (page: Page, references: FontReference[]) => page.evaluate(applyFontReferencesInPage, references)
export const footerState = (page: Page) => page.evaluate(footerStateInPage)
export const shortageIfSticky = (page: Page) => page.evaluate(shortageIfStickyInPage)
export const overflowAudit = (page: Page) => page.evaluate(overflowAuditInPage)
export const spacerAudit = (page: Page) => page.evaluate(spacerAuditInPage)
export const placement = (page: Page, selector: string) => page.evaluate(placementInPage, selector)
/** Start sampling the currently focused control every frame for `frames` frames; read with `readFrameProbe`. */
export const installFrameProbe = (page: Page, frames = 60) => page.evaluate(installFrameProbeInPage, frames)
export const readFrameProbe = (page: Page) => page.evaluate(readFrameProbeInPage)
export const scrollTopOf = (dialog: Locator) => dialog.evaluate(element => Math.round(element.scrollTop * 100) / 100)
export const textareaMetrics = (field: Locator) => field.evaluate(element => ({
  inlineHeight: (element as HTMLTextAreaElement).style.height, renderedHeight: Math.round(element.getBoundingClientRect().height * 100) / 100,
  scrollTop: Math.round(element.scrollTop * 100) / 100, scrollHeight: element.scrollHeight, clientHeight: element.clientHeight,
}))

/** Compare a 200% readback with its 100% references: every size must be exactly twice its reference (0.2px tolerance) and counts must match. */
export function fontReferenceMismatches(references: FontReference[], readback: FontReadback[]): string[] {
  const problems: string[] = []
  for (const reference of references) {
    const current = readback.find(entry => entry.selector === reference.selector)
    if (!current) { problems.push(`${reference.selector}: not read back`); continue }
    if (current.sizes.length !== reference.sizes.length) problems.push(`${reference.selector}: ${reference.sizes.length} elements at 100% but ${current.sizes.length} at 200%`)
    reference.sizes.forEach((size, index) => {
      const now = current.sizes[index]
      if (now === undefined) return
      if (Math.abs(now - 2 * size) > 0.2) problems.push(`${reference.selector}[${index}]: ${size}px at 100% but ${now}px after doubling`)
    })
  }
  return problems
}

/* --------------------------------------------------------------------------
 * Waiting and real input gestures (preparation or the user action under test; labeled by the specs).
 * -------------------------------------------------------------------------- */

export async function awaitFrames(page: Page, frames: number) {
  await page.evaluate(count => new Promise<void>(resolve => {
    const step = (remaining: number) => { if (remaining <= 0) resolve(); else requestAnimationFrame(() => step(remaining - 1)) }
    step(count)
  }), frames)
}

/** Four animation frames, then the usual readiness check: enough for a coalesced layout job and its follow-up frame to run. */
export async function settleLayout(page: Page, label: string) {
  await awaitFrames(page, 4)
  await expectLayoutReady(page, label)
}

export interface WheelResult { before: number; after: number; moved: number }

/**
 * A real mouse wheel gesture over the upper part of a target (the dialog body,
 * not its footer). Returns the target's scrollTop before and after so the spec
 * can prove the intended outer scroller actually moved. With `settle: false`
 * the function returns right after the gesture, for cases that must act within
 * the gesture's own frames.
 */
export async function wheelOver(page: Page, target: Locator, deltaY: number, options: { settle?: boolean } = {}): Promise<WheelResult> {
  const box = await target.boundingBox()
  expect(box, 'the wheel target must have a box').not.toBeNull()
  const before = await target.evaluate(element => element.scrollTop)
  await page.mouse.move(box!.x + box!.width / 2, box!.y + Math.min(box!.height / 3, 120))
  await page.mouse.wheel(0, deltaY)
  if (options.settle !== false) await awaitFrames(page, 4)
  const after = await target.evaluate(element => element.scrollTop)
  return { before: Math.round(before * 100) / 100, after: Math.round(after * 100) / 100, moved: Math.round((after - before) * 100) / 100 }
}

/** Move the textarea caret to its start or end with real key chords; the platform binding differs, so the first chord that works is reported. */
export async function moveCaret(page: Page, edge: 'start' | 'end'): Promise<string> {
  const chords = edge === 'start' ? ['Control+Home', 'Meta+ArrowUp'] : ['Control+End', 'Meta+ArrowDown']
  for (const chord of chords) {
    await pressKey(page, chord)
    const selection = await page.evaluate(() => {
      const element = document.activeElement
      return element instanceof HTMLTextAreaElement ? { start: element.selectionStart, end: element.selectionEnd, length: element.value.length } : null
    })
    if (!selection) throw new Error('moveCaret: the active element is not a textarea')
    if (edge === 'start' ? selection.start === 0 && selection.end === 0 : selection.start === selection.length && selection.end === selection.length) return chord
  }
  throw new Error(`moveCaret: none of ${chords.join(', ')} moved the caret to the ${edge}`)
}

/** Drag the textarea's resize grip with the mouse (a user resize, not a programmatic size change). */
export async function dragResize(page: Page, field: Locator, deltaY: number) {
  const box = await field.boundingBox()
  expect(box, 'the textarea must have a box before resizing').not.toBeNull()
  const x = box!.x + box!.width - 6
  const y = box!.y + box!.height - 6
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x, y + deltaY / 2, { steps: 6 })
  await page.mouse.move(x, y + deltaY, { steps: 6 })
  await page.mouse.up()
  await awaitFrames(page, 3)
}

/* --------------------------------------------------------------------------
 * Synthetic faults (preparation; every spec labels them).
 * -------------------------------------------------------------------------- */

/**
 * Make the catalog worker answer every count preview with a transient error
 * carrying the given literal message, by replying to the preview message with an
 * error envelope instead of forwarding it. Other worker traffic is untouched,
 * nothing marks the worker connection failed, and `restore()` returns the
 * native method so the next recalculation succeeds.
 */
export async function installPreviewFault(page: Page, message: string) {
  await page.evaluate(text => {
    const original = Worker.prototype.postMessage
    const state = { count: 0, restore: () => { Worker.prototype.postMessage = original } }
    Reflect.set(window, '__focus81PreviewFault', state)
    Worker.prototype.postMessage = function (this: Worker, ...args: unknown[]) {
      const payload = args[0] as { id?: unknown; command?: { kind?: unknown } } | undefined
      if (payload && typeof payload.id === 'number' && payload.command && payload.command.kind === 'preview') {
        state.count++
        const id = payload.id
        setTimeout(() => this.dispatchEvent(new MessageEvent('message', { data: { id, error: { message: text, code: 'FICTIONAL81_PREVIEW_UNAVAILABLE', retryAt: null } } })), 0)
        return
      }
      return Reflect.apply(original, this, args)
    } as typeof original
  }, message)
  return {
    count: () => page.evaluate(() => (Reflect.get(window, '__focus81PreviewFault') as { count: number }).count),
    restore: () => page.evaluate(() => (Reflect.get(window, '__focus81PreviewFault') as { restore: () => void }).restore()),
  }
}

/** Make file creation fail synchronously so the backup dialog's download actions take their error path. */
export async function installDownloadFault(page: Page) {
  await page.evaluate(() => {
    const original = URL.createObjectURL
    Reflect.set(window, '__focus81DownloadFault', { restore: () => { URL.createObjectURL = original } })
    URL.createObjectURL = () => { throw new DOMException('FICTIONAL81 synthetic object URL failure', 'InvalidStateError') }
  })
  return { restore: () => page.evaluate(() => (Reflect.get(window, '__focus81DownloadFault') as { restore: () => void }).restore()) }
}

/** Dispatch explicit composition events on the focused textarea. This is not an OS IME; it exercises the composition listeners only. */
export async function dispatchComposition(page: Page, phase: 'start' | 'update' | 'end', data = '') {
  await page.evaluate(({ phase, data }) => {
    const element = document.activeElement
    if (!(element instanceof HTMLTextAreaElement)) throw new Error('composition target is not a textarea')
    element.dispatchEvent(new CompositionEvent(`composition${phase}`, { bubbles: true, cancelable: phase !== 'end', data }))
  }, { phase, data })
}

/* --------------------------------------------------------------------------
 * Openers (preparation: locator focus plus Enter; the measured sequence starts at Close).
 * -------------------------------------------------------------------------- */

/** The explore view with a fresh synthetic public catalog served by a page route, so no Playwright Clock is needed for freshness. */
export async function openExploreFresh(page: Page, options: { jobs?: ReturnType<typeof publicProtocolJob>[] } = {}) {
  await page.route('**/api/catalog?source=public*', route => route.fulfill({ json: publicProtocolCatalog({ fetchedAt: new Date(Date.now() - 60_000).toISOString(), jobs: options.jobs }) }))
  await page.goto('/')
  await expect(page.getByRole('button', { name: '공개 채용', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: D2_LABEL.filtersOpener })).toBeVisible()
  await expectLayoutReady(page, 'SETUP explore view with a fresh synthetic catalog')
}

async function openByKeyboard(page: Page, opener: Locator, dialogName: string, label: string) {
  await opener.focus()
  await page.keyboard.press('Enter')
  const dialog = page.getByRole('dialog', { name: dialogName, exact: true })
  await expect(dialog).toBeVisible()
  await expectLayoutReady(page, `SETUP after opening ${label}`)
  return { dialog, opener }
}

export const openFiltersByKeyboard = (page: Page) => openByKeyboard(page, page.getByRole('button', { name: D2_LABEL.filtersOpener }), D2_LABEL.filtersDialog, 'the filters dialog')
export const openProfileByKeyboard = (page: Page) => openByKeyboard(page, page.getByRole('button', { name: D2_LABEL.profileOpener, exact: true }), D2_LABEL.profileDialogStep1, 'the profile dialog')
export const openDataByKeyboard = (page: Page) => openByKeyboard(page, page.getByRole('button', { name: D2_LABEL.dataOpener, exact: true }), D2_LABEL.dataDialog, 'the data dialog')
export const openBackupByKeyboard = (page: Page) => openByKeyboard(page, page.getByRole('button', { name: LABEL.backupOpener, exact: true }), LABEL.backupDialog, 'the backup dialog')

/** Preparation: seed LANTERN (plus optional raw extra entries), load the saved view, focus the opener and press Enter. The measured sequence starts at Close. */
export async function openLanternDetail(page: Page, extraEntries: unknown[] = []) {
  await seedSavedWithoutClock(page, [LANTERN, ...extraEntries])
  await openSavedViewPlain(page, [LANTERN.job.title])
  await titleButton(page, LANTERN).focus()
  await page.keyboard.press('Enter')
  const dialog = dialogOf(page, LANTERN)
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole('heading', { name: LANTERN.job.title, exact: true })).toBeVisible()
  await expectLayoutReady(page, 'SETUP after opening the detail')
  return dialog
}

/** Preparation: choose a synthetic backup file through the real file input and wait for the review rows. */
export async function loadBackupFile(page: Page, dialog: Locator, records: SavedJob[], rows: number) {
  await dialog.getByLabel(LABEL.backupFile, { exact: true }).setInputFiles(backupFile(records))
  await expect(dialog.locator('.saved-import-row')).toHaveCount(rows)
  await expectLayoutReady(page, 'SETUP after loading the synthetic backup file')
}
