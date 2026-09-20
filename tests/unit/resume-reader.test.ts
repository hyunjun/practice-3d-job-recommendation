import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getEventListeners } from 'node:events'
import { setImmediate as nextTurn } from 'node:timers/promises'

type Reader = typeof import('../../src/lib/resume')['readResume']
type TextItem = { str: string; hasEOL?: boolean } | { type: string }
const TEXT = '김민준\nBackend Engineer\nTypeScript와 React로 접근 가능한 서비스를 설계하고 운영했습니다.'
const PDF_ITEMS: TextItem[] = [
  { str: '김' }, { str: '민준', hasEOL: true }, { type: 'beginMarkedContent' },
  { str: 'Backend' }, { str: ' ' }, { str: 'Engineer', hasEOL: true },
  { str: 'Type' }, { str: 'Script와 React로 접근 가능한 서비스를 설계하고 운영했습니다.' },
]
const MAX_BYTES = 5 * 1024 * 1024

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function file(extension: string, text = TEXT) {
  return new File([text], `fictional-resume.${extension}`, { type: 'application/octet-stream' })
}

function capture<T>(promise: Promise<T>) {
  return promise.then(
    value => ({ kind: 'value' as const, value }),
    error => ({ kind: 'error' as const, error: error as unknown }),
  )
}

async function expectPromptAbort(result: ReturnType<typeof capture<string>>, controller: AbortController) {
  // An event-loop turn is a settlement barrier, not a sleep/deadline extension.
  // The underlying read/extractor remains deliberately unresolved here.
  const outcome = await Promise.race([result, nextTurn().then(() => ({ kind: 'pending' as const }))])
  expect(outcome).toEqual({ kind: 'error', error: controller.signal.reason })
  expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
}

function holdNativeRead(input: File, method: 'text' | 'arrayBuffer') {
  const started = deferred<void>()
  const delivery = deferred<void>()
  const native = method === 'text'
    ? File.prototype.text.call(input)
    : File.prototype.arrayBuffer.call(input)
  if (method === 'text') {
    vi.spyOn(input, 'text').mockImplementation(async () => {
      const value = await native
      started.resolve()
      await delivery.promise
      return value as string
    })
  } else {
    vi.spyOn(input, 'arrayBuffer').mockImplementation(async () => {
      const value = await native
      started.resolve()
      await delivery.promise
      return value as ArrayBuffer
    })
  }
  return { started: started.promise, release: () => delivery.resolve(), reject: delivery.reject }
}

let readResume: Reader
let getTextContent: ReturnType<typeof vi.fn<() => Promise<{ items: TextItem[] }>>>
let getPage: ReturnType<typeof vi.fn<(page: number) => Promise<{ getTextContent: typeof getTextContent }>>>
let destroy: ReturnType<typeof vi.fn<() => Promise<void>>>
let extractRawText: ReturnType<typeof vi.fn<(input: { arrayBuffer: ArrayBuffer }) => Promise<{ value: string }>>>
let getDocument: ReturnType<typeof vi.fn>
let document: { numPages: number; getPage: typeof getPage }
let task: { promise: Promise<typeof document>; destroy: typeof destroy }
let pdfModule: { GlobalWorkerOptions: { workerSrc: string }; getDocument: typeof getDocument }
let wordModule: { extractRawText: typeof extractRawText }

beforeEach(async () => {
  vi.resetModules()
  getTextContent = vi.fn(async () => ({ items: PDF_ITEMS }))
  getPage = vi.fn(async () => ({ getTextContent }))
  destroy = vi.fn(async () => {})
  document = { numPages: 1, getPage }
  task = { promise: Promise.resolve(document), destroy }
  getDocument = vi.fn(() => task)
  extractRawText = vi.fn(async () => ({ value: TEXT }))
  pdfModule = { GlobalWorkerOptions: { workerSrc: '' }, getDocument }
  wordModule = { extractRawText }
  vi.doMock('pdfjs-dist', () => pdfModule)
  vi.doMock('mammoth', () => wordModule)
  ;({ readResume } = await import('../../src/lib/resume'))
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.doUnmock('pdfjs-dist')
  vi.doUnmock('mammoth')
})

describe('resume reader compatibility and native-read cancellation', () => {
  it.each(['txt', 'MD'])('keeps the one-argument %s reader and native text unchanged', async extension => {
    await expect(readResume(file(extension))).resolves.toBe(TEXT)
  })

  it('accepts exactly5MiB and rejects one extra byte without reading it', async () => {
    const accepted = new File(['x'.repeat(MAX_BYTES)], 'boundary.txt')
    await expect(readResume(accepted)).resolves.toHaveLength(5_242_880)
    const rejected = new File([new Uint8Array(MAX_BYTES + 1)], 'too-large.pdf')
    const read = vi.spyOn(rejected, 'arrayBuffer')
    await expect(readResume(rejected)).rejects.toThrow('5MB 이하의 파일을 선택해 주세요.')
    expect(read).not.toHaveBeenCalled()
    expect(getDocument).not.toHaveBeenCalled()
  })

  it('keeps the supported-format error for a noncancelled unsupported file', async () => {
    await expect(readResume(file('rtf'))).rejects.toThrow('PDF, DOCX, TXT, MD 파일을 사용할 수 있어요.')
  })

  it.each(['txt', 'md', 'pdf', 'docx'])('does no %s file work for an already-aborted signal', async extension => {
    const controller = new AbortController()
    controller.abort()
    const input = file(extension)
    const text = vi.spyOn(input, 'text')
    const bytes = vi.spyOn(input, 'arrayBuffer')
    await expect(readResume(input, controller.signal)).rejects.toBe(controller.signal.reason)
    expect(text).not.toHaveBeenCalled()
    expect(bytes).not.toHaveBeenCalled()
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
  })

  it('preserves a caller-provided abort reason instead of reporting a format/size error', async () => {
    const controller = new AbortController()
    const reason = new Error('The user selected another input method')
    controller.abort(reason)
    await expect(readResume(new File([new Uint8Array(MAX_BYTES + 1)], 'old.rtf'), controller.signal)).rejects.toBe(reason)
  })

  it.each(['txt', 'md', 'pdf', 'docx'])('cancels a pending native %s read before its real content is released', async extension => {
    const controller = new AbortController()
    const input = file(extension)
    const gate = holdNativeRead(input, extension === 'txt' || extension === 'md' ? 'text' : 'arrayBuffer')
    const result = capture(readResume(input, controller.signal))
    await gate.started
    controller.abort()
    await expectPromptAbort(result, controller)
    expect(getDocument).not.toHaveBeenCalled()
    expect(extractRawText).not.toHaveBeenCalled()
    gate.release()
    await nextTurn()
    expect(await result).toEqual({ kind: 'error', error: controller.signal.reason })
  })

  it('observes a cancelled native read that rejects later without leaking an error or listener', async () => {
    const controller = new AbortController()
    const input = file('md')
    const actualGate = holdNativeRead(input, 'text')
    const result = capture(readResume(input, controller.signal))
    await actualGate.started
    controller.abort()
    await expectPromptAbort(result, controller)
    actualGate.reject(new Error('Late native read failure'))
    await nextTurn()
    expect(await result).toEqual({ kind: 'error', error: controller.signal.reason })
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
  })

  it.each(['pdfjs-dist', 'mammoth'] as const)('cancels while the %s module is still loading', async moduleName => {
    const entered = deferred<void>()
    const moduleReady = deferred<void>()
    vi.resetModules()
    vi.doMock(moduleName, async () => {
      entered.resolve()
      await moduleReady.promise
      return moduleName === 'pdfjs-dist' ? pdfModule : wordModule
    })
    const reader = (await import('../../src/lib/resume')).readResume
    const controller = new AbortController()
    const input = file(moduleName === 'pdfjs-dist' ? 'pdf' : 'docx')
    const bytes = vi.spyOn(input, 'arrayBuffer')
    const result = capture(reader(input, controller.signal))
    await entered.promise
    controller.abort()
    await expectPromptAbort(result, controller)
    moduleReady.resolve()
    await nextTurn()
    expect(bytes).not.toHaveBeenCalled()
    expect(getDocument).not.toHaveBeenCalled()
    expect(extractRawText).not.toHaveBeenCalled()
  })
})

describe('PDF extraction and task lifetime', () => {
  it('preserves Hangul, actual spaces, font runs and page boundaries, then destroys exactly once', async () => {
    document.numPages = 2
    const controller = new AbortController()
    await expect(readResume(file('pdf'), controller.signal)).resolves.toBe(`${TEXT}\n\n${TEXT}`)
    expect(getPage.mock.calls).toEqual([[1], [2]])
    expect(destroy).toHaveBeenCalledTimes(1)
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
    controller.abort()
    expect(destroy).toHaveBeenCalledTimes(1)
  })

  it('accepts30 pages without dropping the last page', async () => {
    document.numPages = 30
    const result = await readResume(file('pdf'))
    expect(result).toBe(Array.from({ length: 30 }, () => TEXT).join('\n\n'))
    expect(getPage.mock.calls.at(-1)).toEqual([30])
    expect(destroy).toHaveBeenCalledTimes(1)
  })

  it('rejects31 pages before page extraction and still destroys once', async () => {
    document.numPages = 31
    const controller = new AbortController()
    await expect(readResume(file('pdf'), controller.signal)).rejects.toThrow('30페이지 이하의 이력서를 사용해 주세요.')
    expect(getPage).not.toHaveBeenCalled()
    expect(destroy).toHaveBeenCalledTimes(1)
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
  })

  it('keeps the scanned-PDF message and releases the task', async () => {
    getTextContent.mockResolvedValue({ items: [{ str: 'short   \n' }] })
    await expect(readResume(file('pdf'))).rejects.toThrow('텍스트를 찾지 못했어요. 스캔된 PDF라면 경력 내용을 직접 붙여넣어 주세요.')
    expect(destroy).toHaveBeenCalledTimes(1)
  })

  it('keeps the password message and releases the failed loading task', async () => {
    const locked = new Error('need password')
    locked.name = 'PasswordException'
    getDocument.mockImplementation(() => ({ promise: Promise.reject(locked), destroy }))
    const controller = new AbortController()
    await expect(readResume(file('pdf'), controller.signal)).rejects.toThrow('암호가 설정된 PDF예요. 암호를 해제한 파일을 사용해 주세요.')
    expect(destroy).toHaveBeenCalledTimes(1)
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
  })

  it.each(['loading', 'page', 'text'] as const)('preserves a real %s error and destroys the PDF once', async phase => {
    const problem = new Error(`Fictional PDF ${phase} failure`)
    if (phase === 'loading') getDocument.mockImplementation(() => ({ promise: Promise.reject(problem), destroy }))
    if (phase === 'page') getPage.mockRejectedValue(problem)
    if (phase === 'text') getTextContent.mockRejectedValue(problem)
    const controller = new AbortController()
    await expect(readResume(file('pdf'), controller.signal)).rejects.toBe(problem)
    expect(destroy).toHaveBeenCalledTimes(1)
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
  })

  it.each(['loading', 'page', 'text'] as const)('cancels an unresolved PDF %s operation and destroys once before it completes', async phase => {
    const entered = deferred<void>()
    const gate = deferred<void>()
    if (phase === 'loading') {
      getDocument.mockImplementation(() => { entered.resolve(); return task })
      task.promise = gate.promise.then(() => document)
    } else if (phase === 'page') {
      getPage.mockImplementation(async () => { entered.resolve(); await gate.promise; return { getTextContent } })
    } else {
      getTextContent.mockImplementation(async () => { entered.resolve(); await gate.promise; return { items: PDF_ITEMS } })
    }
    const controller = new AbortController()
    const result = capture(readResume(file('pdf'), controller.signal))
    await entered.promise
    controller.abort()
    await expectPromptAbort(result, controller)
    expect(destroy).toHaveBeenCalledTimes(1)
    gate.resolve()
    await nextTurn()
    expect(await result).toEqual({ kind: 'error', error: controller.signal.reason })
    expect(destroy).toHaveBeenCalledTimes(1)
  })

  it('cancels promptly even when cleanup is already pending and later rejects', async () => {
    const cleanupStarted = deferred<void>()
    const cleanup = deferred<void>()
    destroy.mockImplementation(() => { cleanupStarted.resolve(); return cleanup.promise })
    const controller = new AbortController()
    const result = capture(readResume(file('pdf'), controller.signal))
    await cleanupStarted.promise
    controller.abort()
    await expectPromptAbort(result, controller)
    cleanup.reject(new Error('Late worker cleanup failure'))
    await nextTurn()
    expect(destroy).toHaveBeenCalledTimes(1)
    expect(await result).toEqual({ kind: 'error', error: controller.signal.reason })
  })

  it('does not relabel cancellation as a late password failure', async () => {
    const entered = deferred<void>()
    const loading = deferred<typeof document>()
    task.promise = loading.promise
    getDocument.mockImplementation(() => { entered.resolve(); return task })
    const controller = new AbortController()
    const result = capture(readResume(file('pdf'), controller.signal))
    await entered.promise
    controller.abort()
    await expectPromptAbort(result, controller)
    const late = new Error('late password request')
    late.name = 'PasswordException'
    loading.reject(late)
    await nextTurn()
    expect(await result).toEqual({ kind: 'error', error: controller.signal.reason })
    expect(destroy).toHaveBeenCalledTimes(1)
  })
})

describe('DOCX extraction', () => {
  it('preserves normal text and removes cancellation listeners on success', async () => {
    const text = ` \n${TEXT}\n `
    extractRawText.mockResolvedValue({ value: text })
    const controller = new AbortController()
    await expect(readResume(file('docx'), controller.signal)).resolves.toBe(text)
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
  })

  it('keeps the empty-document message', async () => {
    extractRawText.mockResolvedValue({ value: ' \n\t' })
    await expect(readResume(file('docx'))).rejects.toThrow('문서에서 텍스트를 찾지 못했어요. 경력을 직접 붙여넣어 주세요.')
  })

  it('retains an extraction failure while removing its signal listener', async () => {
    const error = new Error('Fictional damaged DOCX package')
    extractRawText.mockRejectedValue(error)
    const controller = new AbortController()
    await expect(readResume(file('docx'), controller.signal)).rejects.toBe(error)
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
  })

  it('cancels Mammoth extraction without waiting for its late text', async () => {
    const entered = deferred<void>()
    const extraction = deferred<{ value: string }>()
    extractRawText.mockImplementation(() => { entered.resolve(); return extraction.promise })
    const controller = new AbortController()
    const result = capture(readResume(file('docx'), controller.signal))
    await entered.promise
    controller.abort()
    await expectPromptAbort(result, controller)
    extraction.resolve({ value: 'Late text must never become a successful cancelled read.' })
    await nextTurn()
    expect(await result).toEqual({ kind: 'error', error: controller.signal.reason })
  })
})
