import type { Job } from './types'

/**
 * Resolve a verified publisher route without rewriting collected or saved URLs.
 * Sendbird's legacy API link opens the careers list after its Delight migration;
 * the current official listing instead links to /job/{Greenhouse posting ID}.
 */
export function jobPostingUrl(job: Pick<Job, 'source' | 'id' | 'companyId' | 'url'>): string {
  if (job.source !== 'greenhouse') return job.url
  const prefix = `greenhouse-${job.companyId}-`
  if (!job.id.startsWith(prefix)) return job.url
  const id = job.id.slice(prefix.length)
  if (!/^[1-9]\d*$/.test(id)) return job.url
  try {
    const original = new URL(job.url)
    const parameters = [...original.searchParams]
    if (original.origin === 'https://sendbird.com' && original.pathname === '/careers'
      && !original.username && !original.password && !original.hash
      && parameters.length === 1 && parameters[0][0] === 'gh_jid' && parameters[0][1] === id) {
      return `https://delight.ai/job/${id}`
    }
  } catch { /* An unrecognized URL remains subject to the caller's normal URL validation. */ }
  return job.url
}
