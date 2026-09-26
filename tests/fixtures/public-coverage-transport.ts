export interface CoverageResponseOptions {
  status?: number
  headers?: Record<string, string>
  delayMs?: number
  failure?: string
}

export interface CoverageReply extends CoverageResponseOptions {
  fixtureResponse: 'orbit-public-coverage-v1'
  body: unknown
}

/** Raw provider payloads remain the default; controls need an explicit envelope. */
export function coverageReply(body: unknown, options: CoverageResponseOptions = {}): CoverageReply {
  return { ...options, fixtureResponse: 'orbit-public-coverage-v1', body }
}

export function asCoverageReply(value: unknown): CoverageReply {
  if (value && typeof value === 'object' && 'fixtureResponse' in value
    && value.fixtureResponse === 'orbit-public-coverage-v1') return value as CoverageReply
  return coverageReply(value)
}

export interface CoverageRequest {
  event: 'request'
  sequence: number
  at: string
  url: string
  method: string
  body: string | null
  synthetic: boolean
  networkSent: false
}

export interface CoverageWireResponse {
  event: 'http-response'
  path: string
  method: string | undefined
  status: number
  ifNoneMatch: string | null
  etag: string | null
  cacheControl: string | null
}

export type CoverageEvent = CoverageRequest | CoverageWireResponse
  | { event: 'response'; sequence: number; status: number; bytes: number; at: string }
  | { event: 'failure'; sequence: number; error: string; at: string }
