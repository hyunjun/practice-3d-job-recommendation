import { upgradeJobCompensation } from './job-compensation'
import { upgradeJobQualifications } from './job-qualifications'
import { upgradeJobEligibility } from './job-eligibility'
import { upgradeJobEmployment } from './job-employment'
import { isUnmappedJob, upgradeJobLocation } from './job-location'
import { upgradeJobCityCoverage } from './job-city-coverage'
import { upgradeCatalogOccupations, upgradeJobOccupation } from './job-occupation'
import { upgradeJobRole } from './job-roles'
import { upgradeJobPostingPurpose } from './job-posting'
import { upgradeJobLanguages } from './job-languages'
import { upgradeJobWorkTime } from './job-work-time'
import type { Catalog, Job } from './types'

interface JobUpgradeOptions {
  /** Saved snapshots retain old pay without recoverable evidence, labelled as an earlier record. */
  preserveUnverifiablePay?: boolean
}

/** One ordered read migration for every normalized-job entry point. Source data stays intact. */
export function upgradeJob<T extends Job>(job: T, { preserveUnverifiablePay = false }: JobUpgradeOptions = {}): T {
  if (job.source === 'sample') return job
  let current = upgradeJobCompensation(job, preserveUnverifiablePay)
  current = upgradeJobQualifications(current)
  current = upgradeJobLanguages(current)
  current = upgradeJobWorkTime(current)
  current = upgradeJobEligibility(current)
  // Research-role interpretation can depend on the occupation's original evidence.
  current = upgradeJobOccupation(current)
  current = upgradeJobRole(current)
  current = upgradeJobCityCoverage(current)
  current = upgradeJobLocation(current)
  return upgradeJobPostingPurpose(upgradeJobEmployment(current))
}

/** Account for moved/conflicting locations without discarding legacy count-only omissions. */
function upgradeCollection<T extends Pick<Catalog, 'jobs' | 'unmappedCount'>>(collection: T, read: (job: Job) => Job): T {
  const jobs = collection.jobs.map(read)
  const delta = jobs.filter(isUnmappedJob).length - collection.jobs.filter(isUnmappedJob).length
  return { ...collection, jobs, unmappedCount: collection.unmappedCount === null ? null : collection.unmappedCount + delta }
}

export function upgradeJobCollection<T extends Pick<Catalog, 'jobs' | 'unmappedCount'>>(collection: T): T {
  return upgradeCollection(collection, job => upgradeJob(job))
}

/** Public exploration excludes other occupations; saved records are never filtered here. */
export function upgradeCatalog(catalog: Catalog): Catalog {
  return catalog.source === 'sample' ? catalog : upgradeCatalogOccupations(upgradeJobCollection(catalog))
}

/** Reuse migrations only for immutable records within one live catalog session. */
export function createCatalogUpgrader(): (catalog: Catalog) => Catalog {
  const converted = new WeakMap<Job, Job>()
  const read = (job: Job) => {
    let current = converted.get(job)
    if (!current) {
      current = upgradeJob(job)
      converted.set(job, current)
    }
    return current
  }
  return catalog => catalog.source === 'sample' ? catalog : upgradeCatalogOccupations(upgradeCollection(catalog, read))
}
