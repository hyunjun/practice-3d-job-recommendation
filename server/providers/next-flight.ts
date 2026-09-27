import { BoardFetchError } from '../catalog-service'

const invalid = () => new BoardFetchError('공식 채용 페이지의 공개 데이터 형식을 확인하지 못했어요.')

/** Read JSON/text records already rendered in HTML. No script evaluation or React runtime. */
export function readNextFlight(html: unknown): Map<string, unknown> {
  if (typeof html !== 'string' || Buffer.byteLength(html) > 8 * 1024 * 1024) throw invalid()
  const strings: string[] = []
  for (const match of html.matchAll(/<script\b[^>]*>\s*self\.__next_f\.push\(([\s\S]*?)\)\s*<\/script>/g)) {
    let chunk: unknown
    try { chunk = JSON.parse(match[1]) } catch { throw invalid() }
    if (!Array.isArray(chunk)) throw invalid()
    if (chunk[0] === 1) {
      if (typeof chunk[1] !== 'string') throw invalid()
      strings.push(chunk[1])
    }
  }
  if (!strings.length) throw invalid()
  const bytes = Buffer.from(strings.join(''))
  const records = new Map<string, unknown>()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let offset = 0
  while (offset < bytes.length) {
    if (bytes[offset] === 10) { offset++; continue }
    const colon = bytes.indexOf(58, offset)
    if (colon < offset || colon - offset > 16) throw invalid()
    const id = bytes.subarray(offset, colon).toString()
    if (!/^[a-f0-9]*$/.test(id) || id && records.has(id)) throw invalid()
    let start = colon + 1
    if (bytes[start] === 84) {
      const comma = bytes.indexOf(44, start)
      if (!id || comma < start || comma - start > 12) throw invalid()
      const hex = bytes.subarray(start + 1, comma).toString()
      if (!/^[a-f0-9]+$/.test(hex)) throw invalid()
      const length = parseInt(hex, 16)
      start = comma + 1
      if (!Number.isSafeInteger(length) || start + length > bytes.length) throw invalid()
      try { records.set(id, decoder.decode(bytes.subarray(start, start + length))) } catch { throw invalid() }
      offset = start + length
    } else {
      let end = bytes.indexOf(10, start)
      if (end === -1) end = bytes.length
      const line = bytes.subarray(start, end).toString()
      // Module references, resource hints and framework diagnostics are not job data.
      if (id && /^[{["\d\-ntf]/.test(line)) {
        try { records.set(id, JSON.parse(line)) } catch { throw invalid() }
      }
      offset = end + 1
    }
    if (records.size > 10_000) throw invalid()
  }
  return records
}

export function flightObjects(records: Map<string, unknown>, key: string): Record<string, unknown>[] {
  const found: Record<string, unknown>[] = []
  let visited = 0
  function visit(value: unknown, depth: number) {
    if (++visited > 100_000 || depth > 60) throw invalid()
    if (!value || typeof value !== 'object') return
    if (!Array.isArray(value) && Object.hasOwn(value, key)) found.push(value as Record<string, unknown>)
    for (const child of Object.values(value)) visit(child, depth + 1)
  }
  for (const value of records.values()) visit(value, 0)
  return found
}

export function flightText(records: Map<string, unknown>, value: string): string {
  if (!value.startsWith('$')) return value
  if (!/^\$[a-f0-9]+$/.test(value)) throw invalid()
  const text = records.get(value.slice(1))
  if (typeof text !== 'string' || text.startsWith('$')) throw invalid()
  return text
}
