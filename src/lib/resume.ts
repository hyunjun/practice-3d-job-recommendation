function abortable<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener('abort', onAbort)
      reject(signal.reason)
    }
    signal.addEventListener('abort', onAbort, { once: true })
    // Observe both outcomes even after cancellation: native Blob reads and
    // dynamic imports may finish later and cannot themselves be interrupted.
    work.then(value => {
      signal.removeEventListener('abort', onAbort)
      if (signal.aborted) reject(signal.reason)
      else resolve(value)
    }, error => {
      signal.removeEventListener('abort', onAbort)
      reject(signal.aborted ? signal.reason : error)
    })
    if (signal.aborted) onAbort()
  })
}

export async function readResume(file: File, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted()
  if (file.size > 5 * 1024 * 1024) throw new Error('5MB 이하의 파일을 선택해 주세요.')
  const extension = file.name.split('.').pop()?.toLowerCase()
  if (extension === 'txt' || extension === 'md') return abortable(file.text(), signal)
  if (extension === 'pdf') {
    const pdfjs = await abortable(import('pdfjs-dist'), signal)
    signal?.throwIfAborted()
    pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).href
    const data = await abortable(file.arrayBuffer(), signal)
    signal?.throwIfAborted()
    const task = pdfjs.getDocument({
      data: new Uint8Array(data),
      cMapUrl: '/pdf/cmaps/', cMapPacked: true,
      standardFontDataUrl: '/pdf/standard_fonts/', wasmUrl: '/pdf/wasm/',
    })
    let destruction: Promise<void> | undefined
    const destroyTask = () => destruction ??= Promise.resolve().then(() => task.destroy())
    const onAbort = () => { void destroyTask().catch(() => {}) }
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) onAbort()
    try {
      const pdf = await abortable(task.promise, signal)
      signal?.throwIfAborted()
      if (pdf.numPages > 30) throw new Error('30페이지 이하의 이력서를 사용해 주세요.')
      const pages: string[] = []
      for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
        signal?.throwIfAborted()
        const page = await abortable(pdf.getPage(pageNumber), signal)
        signal?.throwIfAborted()
        const content = await abortable(page.getTextContent(), signal)
        signal?.throwIfAborted()
        // PDF.js emits actual spaces as text items. Adding a space after every
        // font run splits Hangul words and mixed-font technology names.
        pages.push(content.items.map(item => 'str' in item ? `${item.str}${item.hasEOL ? '\n' : ''}` : '').join(''))
      }
      const text = pages.join('\n\n').trim()
      if (text.replace(/\s/g, '').length < 30) throw new Error('텍스트를 찾지 못했어요. 스캔된 PDF라면 경력 내용을 직접 붙여넣어 주세요.')
      return text
    } catch (error) {
      signal?.throwIfAborted()
      if (error instanceof Error && /password/i.test(error.name)) throw new Error('암호가 설정된 PDF예요. 암호를 해제한 파일을 사용해 주세요.')
      throw error
    } finally {
      signal?.removeEventListener('abort', onAbort)
      await abortable(destroyTask(), signal)
    }
  }
  if (extension === 'docx') {
    const mammoth = await abortable(import('mammoth'), signal)
    signal?.throwIfAborted()
    const arrayBuffer = await abortable(file.arrayBuffer(), signal)
    signal?.throwIfAborted()
    const result = await abortable(mammoth.extractRawText({ arrayBuffer }), signal)
    signal?.throwIfAborted()
    if (!result.value.trim()) throw new Error('문서에서 텍스트를 찾지 못했어요. 경력을 직접 붙여넣어 주세요.')
    return result.value
  }
  throw new Error('PDF, DOCX, TXT, MD 파일을 사용할 수 있어요.')
}
