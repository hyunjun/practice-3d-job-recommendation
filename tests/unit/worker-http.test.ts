import { describe, expect, it } from 'vitest'
import {
  apiNotFound, atPath, jsonResponse, matchesValidator, privateNotFound, responseEncoding, SECURITY_HEADERS, SUCCESS_CACHE,
} from '../../worker/http'

/**
 * Stage82 common design v2 (lines 81, 96-98): weak validators shared across
 * encodings, If-None-Match list/weak/wildcard grammar with wildcard only as the
 * whole field, br/gzip/identity negotiation, exact JSON error envelopes and the
 * original security headers. Expectations are written literally.
 */
const ETAG = 'W/"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"'

describe('If-None-Match validator matching', () => {
  it('matches exact weak and strong forms of the same opaque tag and a bare wildcard', () => {
    expect(matchesValidator(ETAG, ETAG)).toBe(true)
    expect(matchesValidator('"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"', ETAG)).toBe(true)
    expect(matchesValidator(ETAG, '"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"')).toBe(true)
    expect(matchesValidator('*', ETAG)).toBe(true)
    expect(matchesValidator(' \t*\t ', ETAG)).toBe(true)
    expect(matchesValidator(null, ETAG)).toBe(false)
    expect(matchesValidator('', ETAG)).toBe(false)
    expect(matchesValidator('W/"other"', ETAG)).toBe(false)
  })

  it('accepts HTTP list syntax with empty elements and matches any member', () => {
    expect(matchesValidator(`"first", ${ETAG}`, ETAG)).toBe(true)
    expect(matchesValidator(`${ETAG},"second"`, ETAG)).toBe(true)
    expect(matchesValidator(`, "first",, ${ETAG} ,`, ETAG)).toBe(true)
    expect(matchesValidator('"first", "second"', ETAG)).toBe(false)
    expect(matchesValidator('W/"first", W/"second"', ETAG)).toBe(false)
  })

  it('keeps commas inside a quoted tag and never turns them into a wildcard (WI82-2)', () => {
    expect(matchesValidator('"x,*,y"', ETAG)).toBe(false)
    expect(matchesValidator('"x,*,y"', 'W/"x,*,y"')).toBe(true)
    expect(matchesValidator('"a,b", "c"', 'W/"a,b"')).toBe(true)
    expect(matchesValidator('"a,b", "c"', 'W/"c"')).toBe(true)
    expect(matchesValidator('"a,b", "c"', 'W/"a"')).toBe(false)
    expect(matchesValidator('"*"', ETAG)).toBe(false)
    expect(matchesValidator('"*"', 'W/"*"')).toBe(true)
  })

  it('rejects a wildcard inside a list and every malformed field even after an earlier member matched', () => {
    expect(matchesValidator(`${ETAG}, *`, ETAG)).toBe(false)
    expect(matchesValidator(`*, ${ETAG}`, ETAG)).toBe(false)
    expect(matchesValidator(`${ETAG} W/"second"`, ETAG)).toBe(false)
    expect(matchesValidator(`${ETAG}"second"`, ETAG)).toBe(false)
    expect(matchesValidator('"unterminated', ETAG)).toBe(false)
    expect(matchesValidator(`${ETAG}, "unterminated`, ETAG)).toBe(false)
    expect(matchesValidator('W/', ETAG)).toBe(false)
    expect(matchesValidator('W/*', ETAG)).toBe(false)
    expect(matchesValidator('abc', ETAG)).toBe(false)
    expect(matchesValidator('w/"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"', ETAG)).toBe(false)
  })

  it('rejects tags containing whitespace, control or non-Latin-1 characters', () => {
    expect(matchesValidator('"a b"', 'W/"a b"')).toBe(false)
    expect(matchesValidator('"a\tb"', 'W/"a\tb"')).toBe(false)
    expect(matchesValidator('"a\u007fb"', 'W/"a\u007fb"')).toBe(false)
    expect(matchesValidator('"공고"', 'W/"공고"')).toBe(false)
    expect(matchesValidator('"aéb"', 'W/"aéb"')).toBe(true)
  })
})

/**
 * RFC 9110 §12.5.3 (research/rfc9110-accept-encoding.txt): with no header any
 * coding is acceptable; identity is acceptable by default unless excluded by
 * `identity;q=0` or `*;q=0`; a listed coding is acceptable unless its q is 0;
 * among acceptable codings the highest non-zero q is preferred. The RFC does not
 * dictate the tie-break or the implicit identity weight, so the ordering cases
 * below exclude identity explicitly (MWT82-3/AWT82-4) and no case expects a
 * coding the client never advertised.
 */
describe('Accept-Encoding negotiation', () => {
  it('prefers br over gzip over identity at equal quality and honors explicit quality values', () => {
    expect(responseEncoding(null)).toBe('identity')
    expect(responseEncoding('')).toBe('identity')
    expect(responseEncoding('   ')).toBe('identity')
    expect(responseEncoding('gzip')).toBe('gzip')
    expect(responseEncoding('br')).toBe('br')
    expect(responseEncoding('gzip, br')).toBe('br')
    expect(responseEncoding('br, gzip')).toBe('br')
    expect(responseEncoding('*')).toBe('br')
    expect(responseEncoding('gzip;q=1, br;q=0')).toBe('gzip')
    // Relative compression preference, with identity explicitly excluded or weighted below both codings.
    expect(responseEncoding('identity;q=0, gzip;q=0.5, br;q=0.4')).toBe('gzip')
    expect(responseEncoding('identity;q=0, gzip;q=0.4, br;q=0.5')).toBe('br')
    expect(responseEncoding('gzip;q=0.5, br;q=0.4, identity;q=0.1')).toBe('gzip')
    expect(responseEncoding('gzip; q=0.9, identity;q=0.5')).toBe('gzip')
    expect(responseEncoding('GZIP, BR;q=0')).toBe('gzip')
    expect(responseEncoding('deflate')).toBe('identity')
    expect(responseEncoding('deflate, identity')).toBe('identity')
    expect(responseEncoding('br;q=0.001, identity;q=0')).toBe('br')
    expect(responseEncoding('gzip;q=0, gzip')).toBe('gzip')
  })

  it('treats malformed quality values as zero and returns null only when no advertised or default coding remains acceptable', () => {
    expect(responseEncoding('gzip;q=abc')).toBe('identity')
    expect(responseEncoding('gzip;q=1.5')).toBe('identity')
    expect(responseEncoding('br;q=0.0001')).toBe('identity')
    // identity excluded and neither br nor gzip nor a wildcard advertised: no acceptable representation (RFC rules 2/3).
    expect(responseEncoding('identity;q=0')).toBeNull()
    expect(responseEncoding('identity;q=0, gzip;q=0')).toBeNull()
    expect(responseEncoding('identity;q=0, gzip;q=0, br;q=0')).toBeNull()
    expect(responseEncoding('*;q=0')).toBeNull()
    expect(responseEncoding('*;q=0, gzip')).toBe('gzip')
    expect(responseEncoding('*;q=0, identity')).toBe('identity')
    expect(responseEncoding('identity;q=0, *')).toBe('br')
  })
})

describe('JSON envelopes and path roots', () => {
  it('returns exact error bodies with no-store, Vary and the original security headers, and empty HEAD bodies', async () => {
    const get = new Request('https://job.test/api/unknown')
    const notFound = apiNotFound(get)
    expect(notFound.status).toBe(404)
    expect(await notFound.json()).toEqual({ error: '존재하지 않는 API입니다.' })
    expect(notFound.headers.get('Cache-Control')).toBe('no-store')
    expect(notFound.headers.get('Vary')).toBe('Accept-Encoding')
    expect(notFound.headers.get('Content-Type')).toBe('application/json; charset=utf-8')
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) expect(notFound.headers.get(name)).toBe(value)
    expect(SECURITY_HEADERS).toEqual({
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
      'X-Frame-Options': 'DENY',
    })
    expect(SUCCESS_CACHE).toBe('private, no-cache, must-revalidate')
    const privateMissing = privateNotFound(get)
    expect(privateMissing.status).toBe(404)
    expect(await privateMissing.json()).toEqual({ error: '존재하지 않는 발행 경로입니다.', code: 'PUBLISH_NOT_FOUND' })
    const head = jsonResponse(new Request('https://job.test/api/health', { method: 'HEAD' }), { status: 'ok' }, 200, { 'Retry-After': '60' })
    expect(head.status).toBe(200)
    expect(head.body).toBeNull()
    expect(head.headers.get('Retry-After')).toBe('60')
    const custom = jsonResponse(get, { error: 'x' }, 503, { 'Cache-Control': 'private, no-cache, must-revalidate' })
    expect(custom.headers.get('Cache-Control')).toBe('private, no-cache, must-revalidate')
  })

  it('matches exact roots or slash-delimited descendants only', () => {
    expect(atPath('/api', '/api')).toBe(true)
    expect(atPath('/api/', '/api')).toBe(true)
    expect(atPath('/api/catalog', '/api')).toBe(true)
    expect(atPath('/apix', '/api')).toBe(false)
    expect(atPath('/api-docs/x', '/api')).toBe(false)
    expect(atPath('/__orbit/publish', '/__orbit/publish')).toBe(true)
    expect(atPath('/__orbit/publishing', '/__orbit/publish')).toBe(false)
    expect(atPath('/', '/api')).toBe(false)
  })
})
