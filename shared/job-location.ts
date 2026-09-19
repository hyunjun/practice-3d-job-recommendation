import type { Catalog, Job } from './types'

/** A missing map location does not establish remote work or a different work site. */
export function isUnmappedJob(job: Pick<Job, 'workMode' | 'cityIds'>): boolean {
  return job.workMode !== 'remote' && job.cityIds.length === 0
}

export function unmappedCoverage(catalog: Pick<Catalog, 'jobs' | 'unmappedCount'>) {
  const available = catalog.jobs.filter(isUnmappedJob).length
  return {
    available,
    // Older snapshots counted these jobs but did not retain their contents.
    unavailable: catalog.unmappedCount === null ? null : Math.max(0, catalog.unmappedCount - available),
  }
}
