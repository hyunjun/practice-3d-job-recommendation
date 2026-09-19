import { normalizeCompensation } from './compensation'
import type { SalaryData } from './compensation'
import { parseTextCompensation } from './pay-text'
import { COMPENSATION_VERSION } from './types'
import type { Job } from './types'

/** Recheck derived pay against the original snapshot; never claim a new collection time. */
export function upgradeJobCompensation<T extends Job>(job: T, preserveUnverifiable = false): T {
  if (job.source === 'sample' || job.compensationVersion === COMPENSATION_VERSION) return job
  let pay: SalaryData
  if (job.source !== 'greenhouse' && job.compensationRanges?.length) {
    // v4 provider adapters already kept structured Salary components and their explicit periods.
    pay = normalizeCompensation(job.compensationRanges.map(range => ({ ...range, interval: range.period })))
    if (!job.salary) {
      pay.salary = null
      pay.compensationNote = job.compensationNote || pay.compensationNote
    }
  } else {
    pay = parseTextCompensation(job.description)
    if (!pay.compensationRanges?.length && !pay.compensationEvidence?.length) {
      if (preserveUnverifiable && job.salary) return job
      if (job.compensationNote) pay.compensationNote = job.compensationNote
      else if (job.salary) pay.compensationNote = '이전 조회 본문에서 보상 근거를 다시 확인하지 못했어요. 원문을 확인해 주세요.'
    }
  }
  const { salary: _salary, compensationRanges: _ranges, compensationNote: _note, compensationEvidence: _evidence, ...original } = job
  return { ...original, ...pay, compensationVersion: COMPENSATION_VERSION } as T
}
