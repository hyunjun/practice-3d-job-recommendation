import { describe, expect, it } from 'vitest'
import { classifyCatalogJobChange } from '../../src/lib/catalog-job-change'
import type { Job } from '../../shared/types'
import { agingCurrentJobs } from '../fixtures/catalog-worker-aging'

// Stage79 contract docs/design/catalog-worker-aging.md (SHA-256 2fc0192c…) lines 20-31: the private
// change classifier. Expected results are literals; the function under test never derives them.
// Inputs are plain fictional Job records built from the current-format fixture.

const BODY = { kind: 'body' }
const UNCHANGED = { kind: 'unchanged' }
const STALE = (stale: boolean | null) => ({ kind: 'stale', stale })
type Loose = Record<string, unknown>
const loose = (value: Loose) => value as unknown as Job

function base(): Job {
  const [atlas] = agingCurrentJobs()
  return atlas
}
function withoutStale(job: Job): Job {
  const { stale: _stale, ...rest } = job
  return rest as Job
}

describe('classifyCatalogJobChange: references and delivery baseline', () => {
  it('treats the same reference as unchanged, even with an unsupported own stale value', () => {
    const job = base()
    expect(classifyCatalogJobChange(job, job)).toEqual(UNCHANGED)
    const odd = loose({ ...job, stale: undefined })
    expect(classifyCatalogJobChange(odd, odd)).toEqual(UNCHANGED)
  })

  it('requires a full body when nothing was delivered before', () => {
    expect(classifyCatalogJobChange(undefined, base())).toEqual(BODY)
    expect(classifyCatalogJobChange(undefined, withoutStale(base()))).toEqual(BODY)
  })
})

describe('classifyCatalogJobChange: compact stale states on otherwise identical wrappers', () => {
  const fresh = withoutStale(base())
  const cases: [string, Job, Job, unknown][] = [
    ['absent -> true', fresh, { ...fresh, stale: true }, STALE(true)],
    ['absent -> false', fresh, { ...fresh, stale: false }, STALE(false)],
    ['false -> true', { ...fresh, stale: false }, { ...fresh, stale: true }, STALE(true)],
    ['true -> false', { ...fresh, stale: true }, { ...fresh, stale: false }, STALE(false)],
    ['true -> absent', { ...fresh, stale: true }, { ...fresh }, STALE(null)],
    ['false -> absent', { ...fresh, stale: false }, { ...fresh }, STALE(null)],
    ['false -> false (new wrapper)', { ...fresh, stale: false }, { ...fresh, stale: false }, UNCHANGED],
    ['true -> true (new wrapper)', { ...fresh, stale: true }, { ...fresh, stale: true }, UNCHANGED],
    ['absent -> absent (new wrapper)', { ...fresh }, { ...fresh }, UNCHANGED],
  ]
  for (const [title, previous, current, expected] of cases) {
    it(title, () => {
      expect(previous).not.toBe(current)
      expect(classifyCatalogJobChange(previous, current)).toEqual(expected)
    })
  }

  it('absent and own false are different states both ways, and the result names the current state', () => {
    expect(classifyCatalogJobChange(fresh, { ...fresh, stale: false })).toEqual(STALE(false))
    expect(classifyCatalogJobChange({ ...fresh, stale: false }, { ...fresh })).toEqual(STALE(null))
  })
})

describe('classifyCatalogJobChange: unsupported own stale states are conservative full bodies', () => {
  const fresh = withoutStale(base())
  it('own undefined on the current record', () => {
    expect(classifyCatalogJobChange({ ...fresh, stale: true }, loose({ ...fresh, stale: undefined }))).toEqual(BODY)
    expect(classifyCatalogJobChange({ ...fresh }, loose({ ...fresh, stale: undefined }))).toEqual(BODY)
  })
  it('own undefined on the previous record, even when the target state is representable', () => {
    expect(classifyCatalogJobChange(loose({ ...fresh, stale: undefined }), { ...fresh, stale: true })).toEqual(BODY)
    expect(classifyCatalogJobChange(loose({ ...fresh, stale: undefined }), { ...fresh })).toEqual(BODY)
  })
  it('own undefined on both distinct wrappers is not an equal supported state', () => {
    expect(classifyCatalogJobChange(loose({ ...fresh, stale: undefined }), loose({ ...fresh, stale: undefined }))).toEqual(BODY)
  })
  it('non-boolean stale values are not compact states', () => {
    expect(classifyCatalogJobChange({ ...fresh, stale: false }, loose({ ...fresh, stale: 'true' }))).toEqual(BODY)
    expect(classifyCatalogJobChange({ ...fresh, stale: false }, loose({ ...fresh, stale: 1 }))).toEqual(BODY)
    expect(classifyCatalogJobChange({ ...fresh, stale: false }, loose({ ...fresh, stale: null }))).toEqual(BODY)
  })
})

describe('classifyCatalogJobChange: complete own-key membership and Object.is values', () => {
  const job = base()
  it('a changed primitive is a full body', () => {
    expect(classifyCatalogJobChange(job, { ...job, title: 'Backend Engineer — Atlas Alpha Revised' })).toEqual(BODY)
    expect(classifyCatalogJobChange(job, { ...job, fetchedAt: '2026-09-24T08:05:00.000Z' })).toEqual(BODY)
    expect(classifyCatalogJobChange(job, { ...job, companyId: 'catalog-worker-birch' })).toEqual(BODY)
    expect(classifyCatalogJobChange(job, { ...job, source: 'lever' })).toEqual(BODY)
    expect(classifyCatalogJobChange(job, { ...job, description: `${job.description} ` })).toEqual(BODY)
  })

  it('an added unknown key is a full body even when its value is undefined', () => {
    expect(classifyCatalogJobChange(job, loose({ ...job, fixtureMarker: undefined }))).toEqual(BODY)
    expect(classifyCatalogJobChange(job, loose({ ...job, fixtureMarker: 'public-wire-79' }))).toEqual(BODY)
  })

  it('a removed optional key is a full body, so the receiver never keeps a deleted value', () => {
    const { compensationVersion: _version, ...withoutVersion } = job
    expect(classifyCatalogJobChange(job, withoutVersion as Job)).toEqual(BODY)
    const { eligibility: _eligibility, ...withoutEligibility } = job
    expect(classifyCatalogJobChange(job, withoutEligibility as Job)).toEqual(BODY)
  })

  it('a same-count rename of undefined-valued keys is a full body', () => {
    const previous = loose({ ...job, extraA: undefined })
    const current = loose({ ...job, extraB: undefined })
    expect(Object.keys(previous).length).toBe(Object.keys(current).length)
    expect(classifyCatalogJobChange(previous, current)).toEqual(BODY)
  })

  it('explicit undefined presence on another field differs from absence', () => {
    expect(classifyCatalogJobChange(job, loose({ ...job, compensationNote: undefined }))).toEqual(BODY)
  })

  it('a nested value with a new reference is a conservative full body; the same reference is not a change', () => {
    expect(classifyCatalogJobChange(job, { ...job, skills: [...job.skills] })).toEqual(BODY)
    expect(classifyCatalogJobChange(job, { ...job, salary: { ...job.salary! } })).toEqual(BODY)
    expect(classifyCatalogJobChange(job, { ...job, qualifications: structuredClone(job.qualifications) })).toEqual(BODY)
    expect(classifyCatalogJobChange(job, { ...job })).toEqual(UNCHANGED)
    expect(classifyCatalogJobChange(job, { ...job, skills: job.skills, stale: true })).toEqual(STALE(true))
  })

  it('uses Object.is: -0 differs from 0 and NaN equals NaN', () => {
    const zero = { ...job, minExperience: 0 }
    expect(classifyCatalogJobChange(zero, { ...zero, minExperience: -0 })).toEqual(BODY)
    const nan = { ...job, minExperience: Number.NaN }
    expect(classifyCatalogJobChange(nan, { ...nan })).toEqual(UNCHANGED)
  })

  it('shadowing key names are ordinary data keys', () => {
    const shadowed = loose({ ...job, hasOwnProperty: 'data', constructor: 'data' })
    expect(classifyCatalogJobChange(shadowed, { ...shadowed })).toEqual(UNCHANGED)
    expect(classifyCatalogJobChange(shadowed, { ...shadowed, stale: true })).toEqual(STALE(true))
    expect(classifyCatalogJobChange(job, shadowed)).toEqual(BODY)
    expect(classifyCatalogJobChange(shadowed, loose({ ...job }))).toEqual(BODY)
  })

  it('a fictional migration-shaped wrapper with equal keys but new nested allocations is a full body', () => {
    const migrated = {
      ...job, stale: true,
      languageRequirements: { version: 1 as const, rules: [] },
      workTimeRequirements: { version: 1 as const, rules: [] },
    }
    expect(classifyCatalogJobChange(job, migrated)).toEqual(BODY)
  })
})
