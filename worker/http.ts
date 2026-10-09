export const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'X-Frame-Options': 'DENY',
} as const
export const SUCCESS_CACHE = 'private, no-cache, must-revalidate'

export function jsonResponse(
  request: Request, value: unknown, status = 200, extra: Record<string, string> = {},
): Response {
  return new Response(request.method === 'HEAD' ? null : JSON.stringify(value), {
    status, headers: {
      ...SECURITY_HEADERS, 'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store', 'Vary': 'Accept-Encoding', ...extra,
    },
  })
}
export const apiNotFound = (request: Request) =>
  jsonResponse(request, { error: '존재하지 않는 API입니다.' }, 404)
export const privateNotFound = (request: Request) =>
  jsonResponse(request, { error: '존재하지 않는 발행 경로입니다.', code: 'PUBLISH_NOT_FOUND' }, 404)
export const atPath = (path: string, root: string) => path === root || path.startsWith(`${root}/`)

export function matchesValidator(header: string | null, etag: string): boolean {
  if (header === null) return false
  const value = header.replace(/^[ \t]+|[ \t]+$/g, '')
  if (value === '*') return true
  const normalized = etag.replace(/^W\//, '')
  let index = 0
  let matched = false
  while (index < value.length) {
    // Empty list elements are allowed by HTTP's list grammar. A wildcard is
    // allowed only as the whole field value, never inside a list or a tag.
    while (value[index] === ' ' || value[index] === '\t' || value[index] === ',') index++
    if (index === value.length) break
    if (value.startsWith('W/', index)) index += 2
    if (value[index] !== '"') return false
    const start = index++
    while (index < value.length && value[index] !== '"') {
      const code = value.charCodeAt(index++)
      if (code < 0x21 || code === 0x7f || code > 0xff) return false
    }
    if (index === value.length) return false
    index++
    matched ||= value.slice(start, index) === normalized
    while (value[index] === ' ' || value[index] === '\t') index++
    if (index < value.length && value[index] !== ',') return false
  }
  return matched
}

export function responseEncoding(header: string | null): 'br' | 'gzip' | 'identity' | null {
  if (!header?.trim()) return 'identity'
  const quality = new Map<string, number>()
  for (const item of header.split(',')) {
    const [token, ...parameters] = item.trim().toLowerCase().split(';')
    const supplied = parameters.map(value => value.trim()).find(value => value.startsWith('q='))
    const q = supplied === undefined ? 1 : /^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/.test(supplied.slice(2)) ? Number(supplied.slice(2)) : 0
    quality.set(token, Math.max(quality.get(token) ?? 0, q))
  }
  const score = (name: string) => quality.get(name)
    ?? (name === 'identity' ? quality.get('*') === 0 ? 0 : 1 : quality.get('*') ?? 0)
  return (['br', 'gzip', 'identity'] as const)
    .filter(name => score(name) > 0).sort((left, right) => score(right) - score(left))[0] ?? null
}
