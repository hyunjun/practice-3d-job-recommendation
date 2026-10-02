import type { Job } from '../../shared/types'

export type CatalogJobChange =
  | { readonly kind: 'body' }
  | { readonly kind: 'unchanged' }
  | { readonly kind: 'stale'; readonly stale: boolean | null }

const BODY: CatalogJobChange = Object.freeze({ kind: 'body' })
const UNCHANGED: CatalogJobChange = Object.freeze({ kind: 'unchanged' })

/** null means no own property; undefined means a state the compact protocol cannot represent. */
function staleState(job: Job): boolean | null | undefined {
  if (!Object.hasOwn(job, 'stale')) return null
  return typeof job.stale === 'boolean' ? job.stale : undefined
}

/** Compare immutable, plain Job records without serializing or retaining their bodies. */
export function classifyCatalogJobChange(previous: Job | undefined, current: Job): CatalogJobChange {
  if (previous === current) return UNCHANGED
  if (!previous) return BODY

  const before = previous as unknown as Record<string, unknown>
  const after = current as unknown as Record<string, unknown>
  const beforeKeys = Object.keys(before).filter(key => key !== 'stale')
  const afterKeys = Object.keys(after).filter(key => key !== 'stale')
  if (beforeKeys.length !== afterKeys.length) return BODY
  for (const key of beforeKeys) {
    if (!Object.prototype.propertyIsEnumerable.call(after, key) || !Object.is(before[key], after[key])) return BODY
  }

  const previousStale = staleState(previous)
  const currentStale = staleState(current)
  if (previousStale === undefined || currentStale === undefined) return BODY
  return previousStale === currentStale ? UNCHANGED : { kind: 'stale', stale: currentStale }
}
