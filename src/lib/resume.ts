export async function readResume(file: File): Promise<string> {
  if (file.size > 5 * 1024 * 1024) throw new Error('5MB 이하의 파일을 선택해 주세요.')
  const extension = file.name.split('.').pop()?.toLowerCase()
  if (extension === 'txt' || extension === 'md') return file.text()
  if (extension === 'pdf') {
    const pdfjs = await import('pdfjs-dist')
    pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).href
    const task = pdfjs.getDocument({
      data: new Uint8Array(await file.arrayBuffer()),
      cMapUrl: '/pdf/cmaps/', cMapPacked: true,
      standardFontDataUrl: '/pdf/standard_fonts/', wasmUrl: '/pdf/wasm/',
    })
    try {
      const pdf = await task.promise
      if (pdf.numPages > 30) throw new Error('30페이지 이하의 이력서를 사용해 주세요.')
      const pages: string[] = []
      for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
        const page = await pdf.getPage(pageNumber)
        const content = await page.getTextContent()
        // PDF.js emits actual spaces as text items. Adding a space after every
        // font run splits Hangul words and mixed-font technology names.
        pages.push(content.items.map(item => 'str' in item ? `${item.str}${item.hasEOL ? '\n' : ''}` : '').join(''))
      }
      const text = pages.join('\n\n').trim()
      if (text.replace(/\s/g, '').length < 30) throw new Error('텍스트를 찾지 못했어요. 스캔된 PDF라면 경력 내용을 직접 붙여넣어 주세요.')
      return text
    } catch (error) {
      if (error instanceof Error && /password/i.test(error.name)) throw new Error('암호가 설정된 PDF예요. 암호를 해제한 파일을 사용해 주세요.')
      throw error
    } finally {
      await task.destroy()
    }
  }
  if (extension === 'docx') {
    const mammoth = await import('mammoth')
    const result = await mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() })
    if (!result.value.trim()) throw new Error('문서에서 텍스트를 찾지 못했어요. 경력을 직접 붙여넣어 주세요.')
    return result.value
  }
  throw new Error('PDF, DOCX, TXT, MD 파일을 사용할 수 있어요.')
}
